"""Loopback HTTP and extension route contract."""
import json
import mimetypes
import urllib.parse
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


def safe_child(root, relative):
    decoded = urllib.parse.unquote(relative).replace("\\", "/")
    parts = decoded.split("/")
    if "\0" in decoded or decoded.startswith("/") or ".." in parts or ":" in decoded:
        return None
    root = root.resolve()
    candidate = root.joinpath(*parts).resolve()
    return candidate if candidate.is_relative_to(root) else None


MIME = {ext: kind + "; charset=utf-8" for ext, kind in {
    ".css": "text/css", ".html": "text/html", ".js": "text/javascript",
    ".mjs": "text/javascript", ".json": "application/json", ".md": "text/markdown",
    ".txt": "text/plain",
}.items()}
MIME.update({".svg": "image/svg+xml", ".png": "image/png", ".gif": "image/gif",
             ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp",
             ".ogg": "audio/ogg", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".flac": "audio/flac", ".m4a": "audio/mp4"})
ASSET_TYPES = {".png", ".gif", ".jpg", ".jpeg", ".webp", ".json", ".ogg", ".wav", ".mp3", ".flac", ".m4a"}
ASSET_PREFIXES = ("/official/", "/a-files/", "/frame0-preview/", "/review012-bg-preview/", "/ui-assets/",
                  "/studio/art/", "/ch6-assets/", "/ch6-trailer-assets/", "/ch6-trailer-scenes/",
                  "/custom-assets/", "/animation-assets/")


@dataclass
class Response:
    status: int
    kind: str
    data: bytes

    @classmethod
    def json(cls, status, value):
        return cls(status, MIME[".json"], json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode())

    @classmethod
    def file(cls, file):
        if file is None or not file.is_file():
            return cls.json(404, {"ok": False, "error": "文件不存在"})
        kind = MIME.get(file.suffix.lower()) or mimetypes.guess_type(file.name)[0] or "application/octet-stream"
        return cls(200, kind, file.read_bytes())

    @classmethod
    def asset(cls, file):
        return cls.file(file if file and file.suffix.lower() in ASSET_TYPES else None)


class RequestError(ValueError):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status


class StudioHTTPServer(ThreadingHTTPServer):
    request_queue_size = 64  # The player requests its ES module graph in parallel.

    def __init__(self, address, handler):
        if address[0] != "127.0.0.1":
            raise ValueError("服务仅支持本机回环地址")
        super().__init__(address, handler)


class StudioHandler(BaseHTTPRequestHandler):
    server_version = "DeltaruneSceneStudio/1.0"
    sys_version = ""

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        policy = "frame-ancestors 'none'"
        if getattr(self, "_asset_request", False) or getattr(self, "_media_response", False):
            policy += "; sandbox"
            self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Content-Security-Policy", policy)
        self.send_header("X-Frame-Options", "DENY")
        super().end_headers()

    def send_result(self, response, head=False):
        try:
            self._media_response = response.kind.startswith(("image/", "audio/", "font/", "application/json"))
            self.send_response(response.status)
            self.send_header("Content-Type", response.kind)
            self.send_header("Content-Length", str(len(response.data)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Referrer-Policy", "no-referrer")
            self.end_headers()
            if not head and self.command != "HEAD":
                self.wfile.write(response.data)
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
            pass

    def send_bytes(self, data, kind, head=False):
        self.send_result(Response(200, kind, data), head)

    def send_json(self, status, value, head_only=False):
        self.send_result(Response.json(status, value), head_only)

    def host_ok(self, allow_cross_site_read=False):
        port = self.server.server_port
        hosts = {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}
        host = self.headers.get_all("Host", [])
        if len(host) != 1 or host[0] not in hosts:
            self.send_json(403, {"ok": False, "error": "仅允许本机回环访问"})
            return False
        if not allow_cross_site_read:
            origins = self.headers.get_all("Origin", [])
            allowed_origins = {"http://" + host for host in hosts}
            if ((origins and (len(origins) != 1 or origins[0] not in allowed_origins))
                    or "cross-site" in self.headers.get_all("Sec-Fetch-Site", [])):
                self.send_json(403, {"ok": False, "error": "拒绝跨站请求"})
                return False
        return True

    def json_body(self, limit):
        if self.headers.get_content_type() != "application/json":
            raise RequestError(415, "需要 application/json")
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if not 0 < size <= limit:
            raise RequestError(413, f"请求体必须在 1 到 {limit} 字节之间")
        try:
            return json.loads(self.rfile.read(size).decode("utf-8"))
        except (ValueError, UnicodeError) as error:
            raise RequestError(400, "请求体不是有效 UTF-8 JSON") from error

    def dispatch(self):
        try:
            parsed = urllib.parse.urlsplit(self.path)
            self._asset_request = parsed.path.startswith(ASSET_PREFIXES)
            public = self.command in ("HEAD", "GET") and not self._asset_request and (
                parsed.path in {"/", "/layout", "/layout/", "/styles.css", "/favicon.ico"} or
                parsed.path.startswith(("/studio/", "/battle-engine/", "/js/", "/app/", "/mock/")))
            if not self.host_ok(allow_cross_site_read=public):
                return
            if self.command == "POST":
                self.handle_write(parsed)
            else:
                self.handle_read(parsed, self.command == "HEAD")
        except RequestError as error:
            self.send_json(error.status, {"ok": False, "error": str(error)})
        except (OSError, ValueError) as error:
            self.send_json(400, {"ok": False, "error": str(error)})

    do_HEAD = do_GET = do_POST = dispatch

    def do_OPTIONS(self):
        self.send_json(405, {"ok": False, "error": "不支持的方法"})

    def extra_route(self, parsed, head_only=False):
        """Providers receive a parse_qs dict and a decoded JSON body (None for reads)."""
        providers = self.server.extra_routes
        body = self.json_body(16 * 1024 * 1024) if providers and self.command == "POST" else None
        query = urllib.parse.parse_qs(parsed.query)
        for provider in providers:
            response = provider(self.command, parsed.path, query, body, head_only)
            if response is not None:
                return self.send_result(response, head_only)
        self.send_json(404, {"ok": False, "error": "不存在的资源"}, head_only)
