"""Lossless chapter projects, with editable room instances and GameMaker events."""
from __future__ import annotations
import argparse
import time
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import struct
import subprocess
import tempfile
import threading
import zipfile
import uuid
from chapter_navigation import Navigator, companion
from studio_core.registry_io import publish, registry_write

ROOT = Path(__file__).resolve().parent
def _game_folder():
    # DIRECTOR_GAME wins; otherwise the original author's Steam path, then the copy unpacked next to this project.
    if os.environ.get("DIRECTOR_GAME"):
        return Path(os.environ["DIRECTOR_GAME"])
    for candidate in (Path("D:/SteamLibrary/steamapps/common/DELTARUNE"), Path(__file__).resolve().parents[2]/"game"/"DELTARUNE"):
        if (candidate/"DELTARUNE.exe").is_file():
            return candidate
    return Path("D:/SteamLibrary/steamapps/common/DELTARUNE")
GAME = _game_folder()
CLI = Path(os.environ.get("DIRECTOR_UTMT", str(Path(__file__).resolve().parents[2]/"tools-external"/"utmt"/"UndertaleModCli.exe")))
TOOLS = ROOT / "tools"
NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream,"sha256").hexdigest()


def read(path):
    return json.loads(path.read_bytes())


def atomic_json(path, value):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
        temp = Path(stream.name)
        stream.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8"))
    try:
        # Windows readers (including an open inspector) may temporarily deny rename.
        for attempt in range(9):
            try:
                temp.replace(path)
                break
            except PermissionError as ex:
                if getattr(ex,"winerror",None) not in (5,32,33) or attempt==8:raise
                time.sleep(.008*(attempt+1))
    finally:
        temp.unlink(missing_ok=True)


def utmt(data, script, work, output=None, prefix=""):
    args = [str(CLI), "load", str(data), "-s", str(TOOLS / script)]
    if output:
        args.extend(["-o", str(output)])
    env = {**os.environ, "DIRECTOR_CHAPTER_WORK": str(work), "DIRECTOR_CHAPTER_TOOLS": str(TOOLS),
           "DIRECTOR_CHAPTER_SAVE": prefix}
    run = subprocess.run(args, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         encoding="utf-8", errors="replace", creationflags=NO_WINDOW, timeout=900)
    if run.returncode or (output and not output.is_file()):
        raise ValueError(run.stdout[-5000:])


class RevisionConflict(ValueError):
    pass


class Chapter:
    def __init__(self, number, directory=None, *, workspace=None):
        if number not in (4, 5):
            raise ValueError("支持第 4、5 章")
        self.number = number
        self.home = directory or ROOT / "chapters" / f"ch{number}"
        self.stock = GAME / f"chapter{number}_windows"
        self.workspace_warning = ""
        self.source_status = "current"
        self.source_id = None
        self.workspace = self.source_workspace(workspace) if workspace and workspace.resolve()!=self.home.resolve() else self.home
        self._session_stage = None
        self.play_report = None
        self.prefix = f"DirectorStory07_ch{number}"
        self.lock = threading.RLock()
        self.process = None
        self.next_chapter = None
        self.window = None
        self.preview_room = None
        self.route_prefix = self.prefix
        self.route_offset = 0
        self.run_started = None
        self.play_image_hash=None
        self.key_events = []
        self.input_sources = []
        self.manual_serial=-1
        self.navigator=Navigator(self)

    def source_identity(self):
        manifest_path = self.home/"chapter.json"
        if not manifest_path.is_file():
            manifest_path = self.home/"index.json"
        manifest = manifest_path.read_bytes() if manifest_path.is_file() else b""
        baseline = (self.home/"edits.json").read_bytes() if (self.home/"edits.json").is_file() else b""
        source_id = digest(os.path.normcase(str(self.home.resolve())).encode() + b"\0" + manifest + b"\0" + baseline)
        return source_id, baseline

    def source_workspace(self, root):
        source_id, baseline = self.source_identity()
        self.source_id = source_id
        folder = root / source_id
        with registry_write(root/".sources.lock"):
            if (folder/"edits.json").is_file():
                return folder
            legacy = root/"edits.json"
            if legacy.is_file():
                raw = legacy.read_bytes()
                report = self.build_report(root)
                matching_build = (self.home/"chapter.json").is_file() and report.get("buildKey") in (
                    self.key_for(raw), self.key_for(baseline))
                # Old workspaces also kept an exact copy of a reused source build report.
                copied_build = report.get("buildKey") and report.get("buildSHA256") and report == self.build_report(self.home)
                if matching_build or copied_build:
                    folder.mkdir(exist_ok=True)
                    publish(folder/"edits.json", raw)
                    legacy.rename(root/("edits.migrated-" + source_id + ".json"))
                    self.source_status = "migrated"
                elif raw != baseline:
                    self.source_status = "legacy-unverified"
                    self.workspace_warning = (f"旧编辑缺少可核实的来源，已保存在 {legacy}。"
                        f"如确认属于当前工程，请关闭服务后将旧编辑复制到 {folder / 'edits.json'}。")
                    folder.mkdir(exist_ok=True)
            elif any(root.glob("*/edits.json")):
                self.source_status = "source-changed"
                self.workspace_warning = "当前章节素材源已变更。本次使用该来源的工程，其他来源的编辑保留在原工作区。"
        return folder

    def dependency_files(self):
        sources=[p for p in self.stock.rglob("*") if p.is_file() and p!=self.stock/"data.win"]
        sources.extend(p for p in (GAME/"mus").iterdir() if p.is_file())
        sources.append(GAME/"DELTARUNE.exe")
        return sorted(sources)

    def dependencies(self):
        return {p.relative_to(GAME).as_posix():file_hash(p) for p in self.dependency_files()}

    def import_project(self):
        self.home.mkdir(parents=True, exist_ok=True)
        path = self.stock / "data.win"
        with tempfile.TemporaryDirectory(dir=self.home) as temp:
            work = Path(temp)
            with path.open("rb") as src, zipfile.ZipFile(work / "resources.zip", "w", zipfile.ZIP_DEFLATED, compresslevel=3) as z:
                form = src.read(8)
                if form[:4] != b"FORM" or struct.unpack("<I", form[4:])[0] != path.stat().st_size - 8:
                    raise ValueError("不是完整的 GameMaker FORM 资源")
                chunks = []
                checksum = hashlib.sha256(form)
                while header := src.read(8):
                    tag, length = struct.unpack("<4sI", header)
                    payload = src.read(length)
                    if len(payload) != length:
                        raise ValueError("资源块不完整")
                    key = f"{len(chunks):03}_{tag.decode('ascii')}"
                    z.writestr(key, payload)
                    chunks.append({"key": key, "tag": tag.decode("ascii"), "length": length})
                    checksum.update(header + payload)
            old=self.home/"chapter.json"
            if old.is_file() and read(old)["sourceSHA256"]!=checksum.hexdigest() and any(self.edits().values()):
                raise ValueError("这个工程已有编辑，请把新版游戏导入新的工程目录")
            utmt(path, "chapter-read.csx", work)
            manifest = {"format": "director-chapter/1", "chapter": self.number, "sourceSHA256": checksum.hexdigest(),
                        "length": path.stat().st_size, "chunks": chunks}
            for name in ("resources.zip", "scripts.zip", "index.json"):
                (work / name).replace(self.home / name)
            atomic_json(self.home / "dependencies.json", self.dependencies())
            atomic_json(self.home / "chapter.json", manifest)
            if not (self.home / "edits.json").is_file():
                atomic_json(self.home / "edits.json", {"instances": {}, "scripts": {}})
        self.__dict__.pop("_index", None)

    @property
    def index(self):
        if "_index" not in self.__dict__:
            self._index = read(self.home / "index.json")
        return self._index

    def source(self, key):
        with zipfile.ZipFile(self.home / "scripts.zip") as z:
            return z.read(key + ".gml").decode("utf-8")

    @property
    def edits_path(self):
        local = self.workspace / "edits.json"
        return local if local.is_file() else self.home / "edits.json"

    def edit_bytes(self):
        path = self.edits_path
        if self.source_id:
            source_id, baseline = self.source_identity()
            if source_id != self.source_id:
                raise RevisionConflict("章节素材来源已在运行期间变更，请重新启动服务以打开对应工作区。原编辑已保留。")
            if path == self.home/"edits.json" and baseline:
                return baseline
        return path.read_bytes()

    def edits(self):
        return json.loads(self.edit_bytes())

    def edit_snapshot(self):
        raw = self.edit_bytes()
        return {"edits": json.loads(raw), "revision": self.edit_revision(raw), "sourceStatus":self.source_status,
                **({"warning": self.workspace_warning} if self.workspace_warning else {})}

    def edit_revision(self, raw):
        # An old tab must not save into another source that happens to have identical edits.
        return (self.source_id + ":" if self.source_id else "") + digest(raw)

    def revision(self):
        return self.edit_revision(self.edit_bytes())

    def save(self, change):
        with self.lock, registry_write(self.workspace/".edits.lock"):
            snapshot = self.edit_snapshot()
            if change["revision"] != snapshot["revision"]:
                raise RevisionConflict("工程已有新修改，请重新载入")
            edits = snapshot["edits"]
            if change["type"] == "script":
                key, value = change["id"], change["text"]
                if key not in self.index["scripts"] or not isinstance(value, str):
                    raise ValueError("事件无效")
                if value.replace("\r\n", "\n") == self.source(key).replace("\r\n", "\n"):
                    edits["scripts"].pop(key, None)
                else:
                    edits["scripts"][key] = value
            elif change["type"] == "instance":
                room = next((r for r in self.index["rooms"] if r["id"] == change["room"]), None)
                slot = change["slot"]
                obj = room["instances"][slot] if room and type(slot) is int and 0 <= slot < len(room["instances"]) else None
                xy = {k: change[k] for k in ("x", "y")}
                if obj is None or any(type(v) is not int or abs(v) > 1000000 for v in xy.values()):
                    raise ValueError("物件或坐标无效")
                key = room["id"] + "/" + str(slot)
                if all(obj[k] == v for k, v in xy.items()):
                    edits["instances"].pop(key, None)
                else:
                    edits["instances"][key] = xy
            else:
                raise ValueError("未知编辑操作")
            self.workspace.mkdir(parents=True, exist_ok=True)
            atomic_json(self.workspace / "edits.json", edits)
            return self.revision()

    def build_key(self):
        return self.key_for(self.edit_bytes())

    def key_for(self, edits):
        builder=(TOOLS/"chapter-build.csx").read_bytes()+(TOOLS/"chapter-observe.gml").read_bytes()
        return digest(builder+(self.home/"chapter.json").read_bytes()+edits)

    @staticmethod
    def build_report(root):
        try:
            report = read(root/"build.json")
            return report if isinstance(report, dict) else {}
        except (OSError, ValueError):
            return {}

    def build_stage(self, root, report):
        play = root/"play"
        if "playGeneration" in report:
            generation = report["playGeneration"]
            if not isinstance(generation, str) or not re.fullmatch("[0-9a-f]{32}", generation):
                raise ValueError("章节构建目录标识无效")
            play = play/generation
        return play/self.stock.name

    @property
    def stage(self):
        return self._session_stage or self.build_stage(self.workspace, self.build_report(self.workspace))

    def rebuild_input(self, path):
        manifest = read(self.home / "chapter.json")
        checksum = hashlib.sha256()
        with path.open("wb") as out, zipfile.ZipFile(self.home / "resources.zip") as z:
            def part(data):
                checksum.update(data)
                out.write(data)
            part(b"FORM" + struct.pack("<I", manifest["length"] - 8))
            for c in manifest["chunks"]:
                part(c["tag"].encode("ascii") + struct.pack("<I", c["length"]))
                with z.open(c["key"]) as chunk:
                    while block := chunk.read(1024 * 1024):
                        part(block)
        if checksum.hexdigest() != manifest["sourceSHA256"]:
            raise ValueError("工程资源重建校验失败")

    def build(self):
        with self.lock:
            if self.running:
                raise ValueError("请先关闭本工程的试玩窗口，再重新生成")
            self.workspace.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=self.workspace) as temp:
                work = Path(temp)
                original = work / "base.win"
                self.rebuild_input(original)
                shutil.copy2(self.home / "index.json", work / "index.json")
                edits = self.edit_bytes()
                atomic_json(work / "build-edits.json", json.loads(edits))
                output = work / "data.win"
                utmt(original, "chapter-build.csx", work, output, self.prefix)
                report = read(work / "compiled.json")
                report.update({"revision": digest(edits), "buildKey":self.key_for(edits), "buildSHA256": file_hash(output),
                               "sourceSHA256": read(self.home / "chapter.json")["sourceSHA256"]})
                # Readers switch to the complete generation when the report is replaced.
                report["playGeneration"] = uuid.uuid4().hex
                stage = self.build_stage(self.workspace, report)
                self.assemble(work/"play", output, report)
                stage.parent.parent.mkdir(exist_ok=True)
                (work/"play").rename(stage.parent)
                atomic_json(self.workspace / "build.json", report)
            return report

    @staticmethod
    def copy_dependency(src, dest, checksum):
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src,dest)
        if file_hash(dest)!=checksum:
            raise ValueError(f"{src.name} 校验失败，请检查构建清单和游戏版本")

    @property
    def running(self):
        return self.process is not None and self.process.poll() is None

    def previews(self):
        return read(self.home / "previews.json") if (self.home / "previews.json").is_file() else {}

    def route_file(self):
        return Path(os.environ["LOCALAPPDATA"]) / self.route_prefix / "director-route.tsv"

    def run_record(self):
        with self.lock:
            f = self.route_file()
            rows = []
            if self.run_started is not None and f.is_file():
                with f.open("rb") as stream:
                    stream.seek(self.route_offset)
                    lines = stream.read().decode("utf8",errors="replace").splitlines()
                for line in lines:
                    fields=line.split("\t")
                    if len(fields)==3: rows.append(fields)
            return {"chapter":self.number,"started":self.run_started,"preview":self.preview_room,
                    "pid":self.process.pid if self.process else None,"rooms":rows,"keys":list(self.key_events),
                    "playImageSHA256":self.play_image_hash,"inputSources":list(self.input_sources),"navigation":self.navigator.report(),
                    "buildSHA256":self.play_report["buildSHA256"] if self.run_started else None}

    def send_controls(self, keys, source):
        if not isinstance(keys,list) or any(not isinstance(k,str) or k not in self.window_keys() for k in keys):
            raise ValueError("无效的试玩输入")
        if set(keys)==self.window.held:return
        self.window.input(self.window.serial+1,keys)
        self.key_events.append([round((time.monotonic()-self.run_clock)*1000),sorted(self.window.held)])
        self.input_sources.append(source)

    @staticmethod
    def window_keys():
        from chapter_window import KEYS
        return KEYS

    def accept_keys(self, serial, keys):
        if type(serial) is not int or not isinstance(keys,list):raise ValueError("无效的试玩输入")
        if serial<=self.manual_serial:return
        self.manual_serial=serial
        if self.navigator.running:
            if not keys:return
            self.navigator.stop("已手动接管。")
        self.send_controls(keys,"manual")

    def assemble(self, play, image, report):
        if not (GAME/"DELTARUNE.exe").is_file():
            raise ValueError("试玩需要受信任的游戏安装，请配置 DIRECTOR_GAME")
        play.mkdir()
        stage = play/self.stock.name
        stage.mkdir()
        self.copy_dependency(image, stage/"data.win", report.get("buildSHA256"))
        expected = read(self.home/"dependencies.json")
        sources = self.dependency_files()
        if {p.relative_to(GAME).as_posix() for p in sources} != set(expected):
            raise ValueError("本机游戏运行库与章节清单不匹配")
        for src in sources:
            if not src.resolve().is_relative_to(GAME.resolve()):
                raise ValueError("运行库路径超出游戏安装目录")
            rel = src.relative_to(GAME)
            dest = stage/"DELTARUNE.exe" if rel.as_posix()=="DELTARUNE.exe" else play/rel
            self.copy_dependency(src, dest, expected[rel.as_posix()])
        return stage

    def prebuilt(self):
        key = self.build_key()
        for root in dict.fromkeys((self.workspace, self.home)):
            report = self.build_report(root)
            if report.get("buildKey") == key:
                image = self.build_stage(root, report)/"data.win"
                if not image.resolve().is_relative_to(root.resolve()):
                    raise ValueError("试玩数据超出工程目录")
                if image.is_file():
                    if not re.fullmatch("[0-9a-f]{64}", str(report.get("buildSHA256", ""))):
                        raise ValueError("预构建缺少有效的 data.win 校验值，请重新生成")
                    return image, report
        return None

    def prepare_play(self, play):
        cached = self.prebuilt()
        if cached:
            image, report = cached
        else:
            report = self.build()
            image = self.build_stage(self.workspace, report)/"data.win"
        return self.assemble(play, image, report), report

    def launch(self, embed=False, preview=None):
        with self.lock:
            if self.running:
                if self.preview_room != preview:
                    raise ValueError("请先结束当前试玩，再更换起点")
                return self.process.pid
            self.workspace.mkdir(parents=True, exist_ok=True)
            session_dir = tempfile.TemporaryDirectory(prefix=".session-", dir=self.workspace)
            try:
                self._session_stage, self.play_report = self.prepare_play(Path(session_dir.name)/"play")
                return self._launch_prepared(session_dir, embed, preview)
            except BaseException:
                self._session_stage = None
                session_dir.cleanup()
                raise

    def _launch_prepared(self, session_dir, embed, preview):
        nav_error=None
        try:instrumented=companion(self)
        except (OSError,ValueError,subprocess.TimeoutExpired) as ex:
            instrumented=self.stage/"data.win"
            nav_error="跑图组件未能生成，仍可手动试玩："+str(ex)
        binary=instrumented.name
        self.route_prefix=self.prefix
        if preview is not None:
            preset=self.previews().get(preview)
            if preset is None:
                raise ValueError("没有这个剧情预演起点")
            self.route_prefix=self.prefix+"_preview"
            binary="director-preview.win"
            with tempfile.TemporaryDirectory(dir=self.workspace) as temp:
                work=Path(temp)
                atomic_json(work/"preview.json",preset)
                utmt(instrumented,"chapter-preview.csx",work,work/binary,self.route_prefix)
                (work/binary).replace(self.stage/binary)
        self.preview_room=preview
        self.next_chapter = None
        notice = Path(os.environ["LOCALAPPDATA"]) / self.route_prefix / "director-next.txt"
        if notice.is_file():
            notice.unlink()
        from chapter_window import ChapterWindow
        startup = None
        if embed:
            startup = subprocess.STARTUPINFO()
            startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startup.wShowWindow = 4
        f=self.route_file()
        self.route_offset=f.stat().st_size if f.is_file() else 0
        self.run_started=time.time()
        self.run_clock=time.monotonic()
        self.key_events=[];self.input_sources=[];self.manual_serial=-1
        self.navigator.cleanup()
        session="director_nav_"+uuid.uuid4().hex
        self.navigator.bind(session if not nav_error else "")
        if nav_error:self.navigator.state="unavailable";self.navigator.note=nav_error
        self.play_image_hash=file_hash(self.stage/binary)
        self.process = subprocess.Popen([str(self.stage / "DELTARUNE.exe"), "-game", binary,
                                         "launcher",session], cwd=self.stage, startupinfo=startup)
        try:
            self.window = ChapterWindow(self.process)
        except Exception:
            self.process.terminate()
            self.process.wait()
            raise
        proc = self.process
        def watch():
            proc.wait()
            with self.lock:
                if self.process is proc:self.navigator.cleanup()
                if self.process is proc:self._session_stage = None
                if self.process is proc and notice.is_file():
                    value = notice.read_text("utf-8").strip()
                    self.next_chapter = int(value) if value.isdigit() else None
            session_dir.cleanup()
        threading.Thread(target=watch, daemon=__name__ != "__main__").start()
        return proc.pid


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("action", choices=["import", "build", "play"])
    parser.add_argument("chapter", type=int, choices=(5, 4))
    parser.add_argument("--folder",type=Path,help="章节工程目录")
    opts = parser.parse_args()
    chapter = Chapter(opts.chapter,opts.folder.resolve() if opts.folder else None)
    print({"import": chapter.import_project, "build": chapter.build, "play": chapter.launch}[opts.action]())

