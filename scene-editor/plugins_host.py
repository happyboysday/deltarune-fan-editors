"""Local trusted plugins. The provider can also be registered by the native host."""
import json
import mimetypes
import base64
import binascii
import io
import os
from pathlib import Path
import re
import stat
import struct
import subprocess
import tempfile
import threading
import time
from urllib.parse import unquote
import zipfile
import zlib

from studio_core.http import Response, RequestError
from studio_core.settings import timestamp

ROOT = Path(__file__).resolve().parent
BUILTIN = ROOT / "studio" / "plugins" / "builtin"
ID = re.compile(r"[a-z][a-z0-9-]{0,63}")
MEDIA = {".mjs", ".json", ".png", ".gif", ".jpg", ".jpeg", ".webp"}
ZIP_LIMIT = 20 * 1024 * 1024
UPLOAD_LIMIT = 4 * ((ZIP_LIMIT + 2) // 3) + 4096
INSTALL_LIMIT = 64 * 1024 * 1024
MAX_ENTRIES = 4096
CENTRAL_LIMIT = 4 * 1024 * 1024
TRASH = ".plugins-trash"
TAB_TTL = 120
BUILTIN_IDS = frozenset(p.name for p in BUILTIN.iterdir() if (p / "plugin.json").is_file())


def inventory(node, *args):
    try:
        result = subprocess.run([node, str(ROOT / "tools/plugin-files.mjs"), *map(str, args)],
                                capture_output=True, check=True, timeout=15,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        return json.loads(result.stdout)
    except (OSError, TypeError, ValueError, subprocess.SubprocessError) as ex:
        raise RequestError(503, "读取或校验插件需要可用的 Node.js") from ex


def plugin_routes(directory, node, manager=None):
    directory = Path(directory).resolve()

    def plugin_route(method, path, query, body, head_only):
        if path != "/api/studio/plugins" and not path.startswith("/plugins/"):
            return None
        def answer(status, value, mime="application/json; charset=utf-8"):
            data = value if isinstance(value, bytes) else json.dumps(value, ensure_ascii=False).encode()
            return status, mime, data
        if method not in ("GET", "HEAD"):
            return answer(405, {"error": "插件路由只支持读取"})
        if path == "/api/studio/plugins":
            try:
                return answer(200, manager.list_plugins() if manager else inventory(node, directory))
            except RequestError as error:
                return answer(error.status, {"error": str(error)})
        parts = unquote(path[len("/plugins/"):]).split("/")
        if (len(parts) >= 2 and ID.fullmatch(parts[0]) and
            all(p and p not in (".", "..") and not any(c in p for c in "\\:\x00") for p in parts)):
            try:
                parent = BUILTIN if (BUILTIN / parts[0]).is_dir() else directory
                root = (parent / parts[0]).resolve()
                file = root.joinpath(*parts[1:]).resolve()
                if parent == directory and manager and (root / "plugin.json").is_file():
                    manager.settings.sync()
                    if not manager.settings.plugin_enabled(parts[0]):
                        return answer(403, {"error": f"插件 {parts[0]} 已停用。请在插件管理中启用后重新打开工程。"})
                if (root.parent == parent and file.is_relative_to(root) and file.is_file() and
                    (root / "plugin.json").is_file() and file.suffix.lower() in MEDIA):
                    mime = "text/javascript" if file.suffix == ".mjs" else mimetypes.guess_type(file.name)[0]
                    return answer(200, file.read_bytes(), mime or "application/octet-stream")
            except (OSError, ValueError, RuntimeError):
                pass
        return answer(404, {"error": "插件文件不存在"})

    return plugin_route


def linked(info):
    return stat.S_ISLNK(info.st_mode) or bool(getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT)


def file_identity(info):
    return info.st_dev, info.st_ino


def check_zip_directory(data):
    # Use the same EOCD search as ZipFile. Validate the physical entry count as well as the declared count.
    signature = b"PK\x05\x06"
    end = len(data) - 22
    if not (end >= 0 and data.startswith(signature, end) and data.endswith(b"\x00\x00")):
        end = data.rfind(signature, max(0, len(data) - 65536 - 22))
    if end < 0 or end + 22 > len(data):
        raise ValueError("ZIP 缺少有效的中央目录结尾记录")
    disk, first_disk, disk_entries, entries, size, offset, comment = struct.unpack_from("<4H2IH", data, end + 4)
    if end + 22 + comment != len(data):
        raise ValueError("ZIP 注释长度无效")
    locator = end - 20
    if locator >= 0 and data.startswith(b"PK\x06\x07", locator):
        zip_disk, zip_end, disks = struct.unpack_from("<IQI", data, locator + 4)
        # Accept the fixed ZIP64 end record used by ordinary single-volume archives.
        end = locator - 56
        if (zip_disk or disks != 1 or end < 0 or zip_end != end or
                not data.startswith(b"PK\x06\x06", end) or struct.unpack_from("<Q", data, end + 4)[0] != 44):
            raise ValueError("ZIP64 中央目录结尾记录无效")
        disk, first_disk, disk_entries, entries, size, offset = struct.unpack_from("<2I4Q", data, end + 16)
    if disk or first_disk or disk_entries != entries:
        raise ValueError("不支持分卷 ZIP")
    if entries > MAX_ENTRIES or size > CENTRAL_LIMIT:
        raise ValueError("ZIP 中央目录超出文件数或大小限制")
    pos = end - size
    if pos < offset:
        raise ValueError("ZIP 中央目录位置无效")
    count = 0
    while pos < end:
        count += 1
        if count > MAX_ENTRIES:
            raise ValueError("ZIP 中央目录超出文件数限制")
        if pos + 46 > end or not data.startswith(b"PK\x01\x02", pos):
            raise ValueError("ZIP 中央目录条目无效")
        pos += 46 + sum(struct.unpack_from("<3H", data, pos + 28))
    if pos != end or count != entries:
        raise ValueError("ZIP 中央目录的条目数或大小不符")


def safe_part(part):
    if (not part or part in (".", "..") or part.endswith((".", " ")) or len(part) > 128 or
            re.search(r'[\\:"<>|?*\x00-\x1f]', part) or
            re.fullmatch(r"(?i:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])", part.split(".")[0].rstrip())):
        raise ValueError("插件内含不安全的路径：" + part)


class StagedPlugin:
    def __init__(self, parent):
        self.root = Path(tempfile.mkdtemp(prefix=".studio-install-", dir=parent))
        self.created = [self.root]
        self.names = {}
        self.files = set()
        self.count = self.total = 0

    def add(self, parts, size=None):
        self.count += 1
        self.total += size or 0
        if len(parts) > 20 or self.count > MAX_ENTRIES or self.total > INSTALL_LIMIT:
            raise ValueError("插件超出解包大小、文件数或目录深度限制")
        for part in parts:
            safe_part(part)
        current = self.root
        for i, part in enumerate(parts):
            current /= part
            spelling = parts[:i+1]
            folded = tuple(p.casefold() for p in spelling)
            if self.names.setdefault(folded, spelling) != spelling or current in self.files:
                raise ValueError("插件内含冲突路径：" + "/".join(parts))
            if i == len(parts)-1 and size is not None:
                if current.exists() or current.suffix.lower() not in MEDIA:
                    raise ValueError("插件内含重复路径或非法文件类型：" + "/".join(parts))
                self.files.add(current)
                self.created.append(current)
            elif not current.is_dir():
                current.mkdir()
                self.created.append(current)
        return current

    def copy_folder(self, source, prefix=()):
        for item in source.iterdir():
            info = item.lstat()
            parts = (*prefix, item.name)
            if linked(info):
                raise ValueError("插件内不可包含符号链接或目录联接：" + item.name)
            if stat.S_ISDIR(info.st_mode):
                self.add(parts)
                self.copy_folder(item, parts)
            elif stat.S_ISREG(info.st_mode):
                if info.st_nlink > 1:
                    raise ValueError("插件内不可包含硬链接：" + item.name)
                target = self.add(parts, info.st_size)
                with item.open("rb") as stream:
                    opened = os.fstat(stream.fileno())
                    if opened.st_nlink > 1:
                        raise ValueError("插件内不可包含硬链接：" + item.name)
                    if not stat.S_ISREG(opened.st_mode) or file_identity(opened) != file_identity(info):
                        raise ValueError("插件文件在复制前发生变化：" + item.name)
                    self.copy(stream, target, info.st_size)
            else:
                raise ValueError("插件内只允许普通文件与目录：" + item.name)

    @staticmethod
    def copy(stream, target, size):
        with target.open("xb") as out:
            remaining = size
            while chunk := stream.read(min(remaining + 1, 1024 * 1024)):
                remaining -= len(chunk)
                if remaining < 0:
                    raise ValueError("插件文件实际大小超过声明值")
                out.write(chunk)
            if remaining:
                raise ValueError("插件文件实际大小小于声明值")

    def unpack(self, payload):
        if not isinstance(payload, str) or len(payload) > UPLOAD_LIMIT:
            raise ValueError("ZIP 上传上限为 20 MiB")
        try:
            data = base64.b64decode(payload, validate=True)
        except (ValueError, binascii.Error) as ex:
            raise ValueError("ZIP 内容不是有效的 Base64") from ex
        if len(data) > ZIP_LIMIT:
            raise ValueError("ZIP 上传上限为 20 MiB")
        check_zip_directory(data)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for item in archive.infolist():
                kind = stat.S_IFMT(item.external_attr >> 16)
                directory = item.is_dir()
                expected = stat.S_IFDIR if directory else stat.S_IFREG
                if (kind not in (0, expected) or item.external_attr & stat.FILE_ATTRIBUTE_REPARSE_POINT):
                    raise ValueError("ZIP 内不可包含符号链接或特殊文件")
                parts = tuple((item.orig_filename[:-1] if directory else item.orig_filename).split("/"))
                target = self.add(parts, None if directory else item.file_size)
                if not directory:
                    with archive.open(item) as stream:
                        self.copy(stream, target, item.file_size)

    def clean(self):
        # Remove only entries this installation created, in reverse creation order.
        for path in reversed(self.created):
            try:
                if path in self.files:
                    path.unlink(missing_ok=True)
                elif path.is_dir():
                    path.rmdir()
            except OSError:
                pass


class PluginManager:
    def __init__(self, directory, node, settings):
        self.directory = directory
        self.node = node
        self.settings = settings
        self.directory_lock = threading.Lock()
        self.tabs = {}

    def live_tabs(self):
        cutoff = time.monotonic() - TAB_TTL
        self.tabs = {tab: row for tab, row in self.tabs.items() if row[0] >= cutoff}
        return self.tabs.values()

    def track(self, body):
        if not isinstance(body, dict) or not isinstance(body.get("tab"), str) or not re.fullmatch(
                r"[a-zA-Z0-9_-]{1,64}", body["tab"]):
            raise RequestError(400, "缺少有效的工程标签页 ID")
        with self.settings.lock:
            tab, project = body["tab"], body.get("project")
            self.live_tabs()
            if project is None:
                self.tabs.pop(tab, None)
            else:
                if (not isinstance(project, dict) or not isinstance(project.get("title"), str) or
                    not isinstance(project.get("id"), str) or not isinstance(project.get("plugins"), list) or
                    len(project["plugins"]) > 256 or not all(isinstance(id, str) and ID.fullmatch(id)
                                                             for id in project["plugins"])):
                    raise RequestError(400, "工程依赖数据无效")
                self.tabs[tab] = (time.monotonic(), {
                    key: project[key][:160] for key in ("title", "id") } | {"plugins": project["plugins"]})
        return Response.json(200, {"ok": True})

    def list_plugins(self):
        with self.directory_lock:
            data = inventory(self.node, self.directory)
        with self.settings.lock:
            self.settings.sync()
            manifests = {}
            for entry in data["plugins"]:
                manifest = entry.get("manifest")
                if isinstance(manifest, dict) and entry["directory"] == manifest.get("id"):
                    manifests.setdefault(entry["directory"], manifest)
                entry.update(enabled=self.settings.plugin_enabled(entry["directory"]) if not entry["builtin"] else True,
                             source="builtin" if entry["builtin"] else "user", projects=[])
            for _, project in self.live_tabs():
                seen, pending = set(), list(project["plugins"])
                while pending:
                    id = pending.pop()
                    if id in seen:
                        continue
                    seen.add(id)
                    dependencies = manifests.get(id, {}).get("dependencies")
                    if isinstance(dependencies, list):
                        pending.extend(d["id"] for d in dependencies if isinstance(d, dict) and
                                       isinstance(d.get("id"), str) and ID.fullmatch(d["id"]))
                for entry in data["plugins"]:
                    if entry["directory"] in seen:
                        record = {k: project[k] for k in ("id", "title")}
                        if record not in entry["projects"]:
                            entry["projects"].append(record)
            return data

    def install(self, body):
        if not isinstance(body, dict) or ("folder" in body) == ("zip" in body):
            raise RequestError(400, "请提供一个本机文件夹路径或一个 Base64 ZIP")
        stage = None
        try:
            source = None
            if "folder" in body:
                if not isinstance(body["folder"], str) or "\0" in body["folder"]:
                    raise ValueError("需要本机文件夹的绝对路径")
                source = Path(body["folder"]).expanduser()
                if not source.is_absolute() or not source.is_dir() or any(linked(p.lstat()) for p in (source, *source.parents)):
                    raise ValueError("需要现有的本机绝对目录，且不能使用链接")
                if (not (source / "plugin.json").is_file() or
                        self.directory.is_relative_to(source.resolve())):
                    raise ValueError("请选择含 plugin.json 的插件目录")
            self.directory.mkdir(parents=True, exist_ok=True)
            stage = StagedPlugin(self.directory)
            if source:
                stage.copy_folder(source)
            else:
                stage.unpack(body["zip"])
            plugin = stage.root
            if not (plugin / "plugin.json").is_file():
                children = list(plugin.iterdir())
                if len(children) == 1 and children[0].is_dir():
                    plugin = children[0]
            if not (plugin / "plugin.json").is_file():
                raise ValueError("安装包缺少 plugin.json")
            inspected = inventory(self.node, "--inspect", plugin)
            if inspected["errors"]:
                return Response.json(422, {"ok": False, "error": "插件清单校验失败", "errors": inspected["errors"]})
            id = inspected["manifest"]["id"]
            target = self.directory / id
            with self.directory_lock:
                if id in BUILTIN_IDS or any(p.name.casefold() == id for p in self.directory.iterdir()):
                    raise RequestError(409, f"插件 ID 已存在：{id}")
                plugin.rename(target)
                self.settings.sync()
                return Response.json(201, {"ok": True, "id": id, "enabled": self.settings.plugin_enabled(id)})
        except RequestError:
            raise
        except (OSError, ValueError, RuntimeError, EOFError, zipfile.BadZipFile, zipfile.LargeZipFile, zlib.error) as ex:
            raise RequestError(422, f"无法安装插件：{ex}") from ex
        finally:
            if stage:
                stage.clean()

    def manage(self, id, action):
        with self.directory_lock:
            if id in BUILTIN_IDS:
                raise RequestError(403, "内置插件始终启用，不能停用或卸载")
            folder = self.directory / id
            if not folder.is_dir():
                raise RequestError(404, f"未找到用户插件 {id}")
            info = folder.lstat()
            if linked(info) or folder.resolve().name != id:
                raise RequestError(404, f"未找到用户插件 {id}")
            entry = inventory(self.node, "--inspect-installed", folder)
            if not entry["manageable"]:
                raise RequestError(422, entry["managementReason"])
            current = folder.lstat()
            if linked(current) or file_identity(current) != file_identity(info):
                raise RequestError(409, "插件目录已变化，请刷新插件列表")
            if action == "uninstall":
                trash = self.directory / TRASH
                trash.mkdir(exist_ok=True)
                if linked(trash.lstat()):
                    raise RequestError(422, "插件回收目录不能是链接")
                target = trash / f"{id}-{timestamp()}"
                try:
                    folder.rename(target)
                except OSError as ex:
                    raise RequestError(422, f"无法将插件移入回收区：{ex}") from ex
                return Response.json(200, {"ok": True, "id": id, "trash": str(target)})
            enabled = action == "enable"
            self.settings.set_plugin(id, enabled)
            return Response.json(200, {"ok": True, "id": id, "enabled": enabled})
