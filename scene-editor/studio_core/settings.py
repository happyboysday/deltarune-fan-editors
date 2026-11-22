"""Resolve startup options and persist local Studio settings."""
import json
import os
import re
import tempfile
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

from .http import Response
from .registry_io import registry_write

VERSION = 1
PATHS = {
    "assets": "assets", "battleAssets": "battle_assets", "officialRoot": "official_root",
    "base": "base", "aExport": "a_export", "ch6Assets": "ch6_assets", "battleRoot": "battle_root",
    "projects": "projects", "plugins": "plugins", "trailerRoot": "trailer_root",
}
STARTUP = (*PATHS, "port")
FIELDS = (*STARTUP, "pluginEnabled", "firstRunDone", "version")
ASSET_DIRS = ("chapters", "chapter5", "official", "ui-sprites", "art", "examples", "a-export")
PLUGIN_ID = re.compile(r"[a-z][a-z0-9-]{0,63}")


def timestamp():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")


def shape_error(key, value):
    if key in PATHS:
        if value is not None and (not isinstance(value, str) or not value.strip() or "\0" in value):
            return "请输入目录路径，或留空恢复默认值"
    elif key == "port":
        if value is not None and (type(value) is not int or not 0 <= value <= 65535):
            return "端口须为 0 至 65535 的整数，0 表示自动选择，空值恢复默认值"
    elif key == "firstRunDone":
        if type(value) is not bool:
            return "首次引导状态须为布尔值"
    elif key == "pluginEnabled":
        if not isinstance(value, dict) or any(not PLUGIN_ID.fullmatch(k) or type(v) is not bool
                                              for k, v in value.items()):
            return "插件启用状态须为插件 ID 到布尔值的映射"
    elif key == "version":
        if type(value) is not int or value != VERSION:
            return f"设置格式版本须为 {VERSION}"
    else:
        return "未知设置项"
    return None


def missing_parts(path, *, dirs=(), files=()):
    return [name for name in dirs if not (path / name).is_dir()] + [
        name for name in files if not (path / name).is_file()]


def path_status(key, path):
    if path is None:
        return False, "未设置目录"
    if not path.is_dir():
        return False, "目录不存在"
    if key == "assets":
        missing = missing_parts(path, dirs=ASSET_DIRS)
        if len(missing) == len(ASSET_DIRS):
            return False, "至少应包含 " + "、".join(ASSET_DIRS) + " 中的一个目录"
        return True, "可用，含 " + "、".join(name for name in ASSET_DIRS if name not in missing)
    if key == "officialRoot":
        return ((True, "可用") if any(p.is_dir() for p in (path / "sprites").glob("ch*/all_sprites"))
                else (False, "缺少 sprites/ch*/all_sprites 目录"))
    if key == "ch6Assets":
        return ((True, "可用") if any((path / name).is_dir() for name in
                ("final", "reference", "ch6-maker-tiles")) or any(path.glob("*.png"))
                else (False, "缺少 final、reference、ch6-maker-tiles 或根目录 PNG"))
    dirs, files = {
        "battleAssets": ((), ("index.json",)),
        "base": ((), ("management/agents/C-editor/server.py", "management/agents/C-editor/app/index.html",
                      "management/agents/C-editor/app/js/editor.js", "release/release.json")),
        "aExport": (("chapters",), ("manifest.json", "sprites.json", "chapters.json", "rooms.json")),
        "battleRoot": (("engine",), ("serve.py", "tools/export-game.mjs")),
        "trailerRoot": (("assets", "scenes"), ()),
    }.get(key, ((), ()))
    missing = missing_parts(path, dirs=dirs, files=files)
    if missing:
        return False, "缺少 " + "、".join(missing)
    try:
        if key == "aExport":
            manifest = json.loads((path / "manifest.json").read_text("utf-8-sig"))
            if (manifest.get("format"), manifest.get("contract"), manifest.get("roots", {}).get("exports")) != (
                    "director-assets/1", "director-map/1", "exports/v8"):
                return False, "需要 A-export v8 清单"
            if not any((path / "chapters").glob("ch*/rooms.json")):
                return False, "缺少章节下的 rooms.json"
        if key == "battleAssets" and not isinstance(json.loads((path / "index.json").read_text("utf-8-sig")), dict):
            return False, "index.json 须为 JSON 对象"
        if key == "base":
            release = json.loads((path / "release/release.json").read_text("utf-8-sig"))
            if not isinstance(release["argv"]["c_editor"], list):
                return False, "release.json 缺少有效的布景工作台配置"
    except (OSError, ValueError, TypeError, AttributeError, KeyError):
        return False, "目录中的配置文件无法读取或格式无效"
    return True, "可用"


def atomic_write(path, contents):
    temp = None
    try:
        with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as stream:
            temp = Path(stream.name)
            stream.write(contents)
            stream.flush()
            os.fsync(stream.fileno())
        for attempt in range(9):
            try:
                os.replace(temp, path)
                break
            except PermissionError as ex:
                if getattr(ex, "winerror", None) not in (5, 32, 33) or attempt == 8:
                    raise
                time.sleep(.008 * (attempt + 1))
    finally:
        if temp:
            temp.unlink(missing_ok=True)


class Settings:
    def __init__(self, args, root, builtin_ids):
        self.root = root
        self.builtin_ids = builtin_ids
        cli_projects = getattr(args, "projects", None)
        self.data = (getattr(args, "data", None) or
                     (cli_projects.resolve().parent if cli_projects else root.parent / "scene-studio-data")).resolve()
        self.file = self.data / "settings.json"
        self.lock_file = self.data / "settings.json.lock"
        self.lock = threading.RLock()
        self.warning = None
        self.saved = {}
        self.cli = {}
        self.failures = {}
        self.battle_assets_env = Path(os.environ["DR_ASSETS"]).resolve() if os.environ.get("DR_ASSETS") else None
        self.sync()
        for key in STARTUP:
            value = getattr(args, PATHS.get(key, key), None)
            if value is not None:
                self.cli[key] = str(value.resolve()) if key in PATHS else value
        self.active = self.resolve(self.saved)

    def _sync_locked(self):
        try:
            raw = self.file.read_bytes()
            saved = self._parse(raw)
        except FileNotFoundError:
            return None
        except ValueError:
            backup = self.file.with_name(f"settings.json.corrupt-{timestamp()}")
            self.file.rename(backup)
            self.warning = f"设置文件损坏，已备份为 {backup}"
            return None
        self.saved = saved
        return raw

    @staticmethod
    def _parse(raw):
        saved = json.loads(raw.decode("utf-8-sig"))
        if (not isinstance(saved, dict) or saved.get("version") != VERSION or
                any(shape_error(k, v) for k, v in saved.items() if k in FIELDS)):
            raise ValueError("invalid settings schema")
        return saved

    def sync(self):
        with self.lock:
            try:
                with registry_write(self.lock_file):
                    self._sync_locked()
            except OSError as error:
                self.warning = f"无法读取或隔离设置文件：{error}"

    def resolve(self, saved):
        root = self.root
        rows = {}
        def use(key, fallback):
            if key in self.cli:
                value, source = self.cli[key], "cli"
            elif saved.get(key) is not None:
                value, source = saved[key], "settings"
            else:
                value, source = fallback, "default"
            if key in PATHS and value is not None:
                try:
                    value = str((self.data / Path(value).expanduser()).resolve())
                except (OSError, ValueError, RuntimeError):
                    value = str(self.data / value)
            rows[key] = {"value": value, "source": source}
            return Path(value) if key in PATHS and value is not None else value
        assets = use("assets", root)
        battle_root = use("battleRoot", root.parent.parent / "battle-editor")
        use("battleAssets", self.battle_assets_env or battle_root / "assets")
        base = use("base", None)
        candidates = ([base / "management/assets/official"] if base else []) + [
            root.parent.parent / "assets-official/01-official",
            root.parent.parent / "素材/官方原始资料/assets-official/01-official"]
        use("officialRoot", next((p for p in candidates if p.is_dir()), candidates[0]))
        use("aExport", base / "management/agents/A-assets/exports/v8" if base else assets / "a-export")
        use("ch6Assets", root.parent.parent / "ch6-assets")
        use("projects", self.data / "projects")
        use("plugins", self.data / "plugins")
        use("trailerRoot", root.parent.parent / "ch6-trailer-project")
        use("port", 18946)
        return rows

    def path(self, key):
        value = self.active[key]["value"]
        return Path(value) if value is not None else None

    def status(self, key):
        if key in self.failures:
            return False, self.failures[key]
        path = self.path(key)
        if (key == "plugins" and self.active[key]["source"] == "default" and
                not path.exists() and path.parent.is_dir()):
            return True, "首次安装时创建目录"
        try:
            return path_status(key, path)
        except (OSError, RuntimeError):
            return False, "无法读取目录"

    def plugin_enabled(self, plugin_id):
        return plugin_id in self.builtin_ids or self.saved.get("pluginEnabled", {}).get(plugin_id, True)

    def disabled_plugins(self):
        self.sync()
        return [key for key in self.saved.get("pluginEnabled", {}) if not self.plugin_enabled(key)]

    def _write_locked(self, saved, previous):
        saved = {**dict.fromkeys(STARTUP), "pluginEnabled": {}, "firstRunDone": False, **saved, "version": VERSION}
        self.data.mkdir(parents=True, exist_ok=True)
        payload = (json.dumps(saved, ensure_ascii=False, indent=2, allow_nan=False) + "\n").encode()
        if previous is not None:
            atomic_write(self.file.with_suffix(".json.bak"), previous)
        atomic_write(self.file, payload)
        self.saved = saved

    def set_plugin(self, plugin_id, enabled):
        with self.lock, registry_write(self.lock_file):
            previous = self._sync_locked()
            states = {**self.saved.get("pluginEnabled", {}), plugin_id: enabled}
            self._write_locked({**self.saved, "pluginEnabled": states}, previous)

    def report(self):
        with self.lock:
            self.sync()
            pending = self.resolve(self.saved)
            rows = {}
            for key, row in self.active.items():
                valid, reason = self.status(key) if key in PATHS else (True, "可用")
                rows[key] = {**row, "valid": valid, "reason": reason}
                if pending[key] != row:
                    rows[key]["pending"] = pending[key]
            first_run = self.saved.get("firstRunDone", False)
            for key, value in [("pluginEnabled", self.saved.get("pluginEnabled", {})),
                               ("firstRunDone", first_run), ("version", VERSION)]:
                rows[key] = {"value": value, "source": "settings" if key in self.saved else "default",
                             "valid": True, "reason": "可用"}
            return {"settings": rows, "data": str(self.data), "firstRunDone": first_run,
                    "version": VERSION, "warning": self.warning}

    def update(self, body):
        if not isinstance(body, dict) or not isinstance(body.get("settings"), dict):
            return Response.json(400, {"ok": False, "error": "需要 settings 对象"})
        with self.lock, registry_write(self.lock_file):
            previous = self._sync_locked()
            saved = dict(self.saved)
            results = {}
            for key, value in body["settings"].items():
                reason = shape_error(key, value)
                if key in self.cli:
                    reason = "由命令行指定，不能在设置中覆盖"
                if key == "version":
                    reason = "设置格式版本由服务器管理"
                if not reason and key == "pluginEnabled" and any(value.get(id) is False for id in self.builtin_ids):
                    reason = "内置插件不可停用"
                if not reason and key == "pluginEnabled":
                    value = {**saved.get("pluginEnabled", {}), **value}
                if not reason and key in PATHS and value is not None:
                    try:
                        path = (self.data / Path(value).expanduser()).resolve()
                        valid, note = path_status(key, path)
                        if key in {"projects", "plugins"} and valid and path.exists() and not os.access(path, os.W_OK):
                            valid, note = False, "目录不可写"
                    except (OSError, ValueError, RuntimeError):
                        valid, note = False, "无法读取目录路径"
                    if valid:
                        value = str(path)
                    else:
                        reason = note
                if not reason:
                    saved[key] = value
                results[key] = {"ok": not reason, "reason": reason or "已保存"}
            if body["settings"].get("firstRunDone") is True and any(not row["ok"] for row in results.values()):
                results["firstRunDone"] = {"ok": False, "reason": "请先修正设置错误"}
                if "firstRunDone" in self.saved:
                    saved["firstRunDone"] = self.saved["firstRunDone"]
                else:
                    saved.pop("firstRunDone", None)
            if any(result["ok"] for result in results.values()):
                self._write_locked(saved, previous)
            ok = all(result["ok"] for result in results.values())
        return Response.json(200, {"ok": ok, "results": results, **self.report()})

    def detect(self):
        layouts = {
            "assets": ("素材/场景编辑器素材", "场景编辑器素材"),
            "battleAssets": ("素材/战斗编辑器素材", "战斗编辑器素材"),
            "officialRoot": ("素材/官方原始资料/assets-official/01-official", "assets-official/01-official"),
            "base": ("素材/deltarune-director-v0.4", "deltarune-director-v0.4"),
            "aExport": ("素材/场景编辑器素材/a-export", "素材/deltarune-director-v0.4/management/agents/A-assets/exports/v8",
                        "deltarune-director-v0.4/management/agents/A-assets/exports/v8", "a-export"),
            "ch6Assets": ("素材/ch6-assets", "ch6-assets"),
            "battleRoot": ("编辑器/战斗编辑器", "战斗编辑器", "battle-editor"),
            "projects": ("作品/场景工程/projects", "scene-studio-data/projects"),
            "plugins": ("scene-studio-data/plugins",),
            "trailerRoot": ("作品/宣传片", "ch6-trailer-project"),
        }
        # Check the adjacent project layouts, including a checkout below .v1-work.
        roots = (self.root.parent, self.root.parent.parent)
        results = {}
        for key, suffixes in layouts.items():
            paths = [root / suffix for root in roots for suffix in suffixes]
            active = self.path(key)
            if active is not None:
                if self.active[key]["source"] == "default":
                    paths.append(active)
                else:
                    paths.insert(0, active)
            match = next((p for p in paths if p.is_dir() and path_status(key, p)[0]), None)
            results[key] = {"value": str(match) if match else None, "valid": match is not None,
                            "reason": "已检测到" if match else "未找到符合结构的目录"}
        return {"results": results}
