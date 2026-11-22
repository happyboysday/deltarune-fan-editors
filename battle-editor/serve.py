#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""serve.py — DR Battle Editor 開發伺服器（僅 Python 3.11 標準庫）。

Phase 1／2（既有能力，不得退步）
    * 靜態檔服務：根目錄 battle-editor/、正確 MIME（.js 為 text/javascript）、禁止目錄穿越。
    * 攻擊檔 API：`GET /api/attacks`、`GET|PUT /api/attacks/<name>.json`（存 attacks/）。
    * 遭遇檔 API：`GET /api/encounters`、`GET|PUT /api/encounters/<name>.json`（存 encounters/）。

Phase 3（SPEC-AGENT §2：人與 Agent 同等權限）
    * ETag（內容 sha256，指存放後的正規化位元組）＋ `If-Match` 樂觀鎖；不符回 409 並附現版本。
    * PATCH（RFC 6902：add/remove/replace/move/copy/test；JSON Pointer 支援 ~0 ~1），同樣支援 If-Match。
    * DELETE → 移到 `trash/<kind>/<name>.<時間戳>.json`（軟刪除）；`GET /api/trash`、`POST /api/restore`。
    * `GET /api/events`（SSE）：changed／deleted／focus；輪詢 mtime+s哈（預設 0.4 秒）偵測外部改檔，
      心跳註解每 15 秒；多客戶端同時連線、斷線自動清理。
    * 審計：`history/YYYY-MM-DD.jsonl`（時間、client、method、kind、name、前後 etag、patch 摘要、大小）；
      `GET /api/history`、`GET /api/history/<id>`、`POST /api/history/<id>/restore`；
      寫入前把舊版內容另存 `history/blobs/<etag>.json`（可還原）。
    * `GET /api/assets/search?q=&tag=&kind=sprite|audio|font|preset&limit=`。
    * `GET /api/schema/<attack|encounter|cues>`（讀 `generated/schema/<name>.json`）。
    * `GET|PUT|DELETE /api/editor/state`：多個編輯器分頁以 clientId 區分；PUT 帶 `focus` 時推 SSE 事件。

Phase V2-05（作品根與作品包）
    * `--works <dir>`（或環境變數 `DR_WORKS`）：作品根。其下 `attacks/`、`encounters/`、
      `assets/custom/` 取代預設位置；`history/`、`trash/` 也放在作品根下（不同作品不混在一起）。
      SSE 監看、樂觀鎖、審計全部跟著作品根走。相對路徑以**啟動時的工作目錄**解析。
      作品根不存在時自動建立這五個子目錄。不給 `--works`（也沒設 `DR_WORKS`）時行為與舊版完全相同。
    * `GET /assets/custom/...`：`--works` 時優先從作品根的 `assets/custom/` 提供。
    * `GET /assets/index.json`：作品根有自己的 `assets/custom.index.json` 時，回應時**動態合併**
      （只合併到回應，不寫回主索引），不同作品根的自訂素材互不污染。
    * `GET /api/info`：`{root, works, port, version}`（works 為 null 代表預設草稿區）。
    * `POST /api/pack/export`：body `{kind?, name}` → 回傳 `*.drpack.json`（作品包下載）。
    * `POST /api/pack/import`：body = 作品包本體；query `mode=abort|rename|overwrite`。
      兩者都以子程序呼叫 `tools/pack.mjs`（作品包格式只有一份 Node 實作，避免兩邊漂移）。

安全性
    * 只綁 127.0.0.1（沒有身分驗證，不是對外服務）。
    * 寫入只限作品目錄（attacks/、encounters/、trash/、history/；`--works` 時都在作品根下），
      檔名白名單 `[A-Za-z0-9_\\-\\u4e00-\\u9fa5]+`。
    * 靜態檔禁止目錄穿越（percent-decode 後 realpath 必須落在根目錄內）。

用法
    python serve.py                  # 127.0.0.1:18900（預設草稿區：battle-editor/ 下的 attacks/、encounters/）
    python serve.py --open           # 啟動後自動開瀏覽器
    python serve.py --port 18901     # 換 port
    python serve.py --works works/my-boss      # 用作品根（相對路徑以目前工作目錄解析）
    python serve.py --works D:/DeltaruneWorks/works/doppeldoll
    set DR_WORKS=works/my-boss && python serve.py     # 環境變數寫法（--works 優先）
    python serve.py --poll-interval 0.25
    python serve.py --quiet

按 Ctrl+C 結束。
"""

from __future__ import annotations

import argparse
import copy
import hashlib
import json
import mimetypes
import os
import queue
import re
import select
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.parse
import uuid
import webbrowser
from contextlib import contextmanager
from datetime import datetime
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# ---------------------------------------------------------------------------
# 常數
# ---------------------------------------------------------------------------

ROOT_DIR = Path(__file__).resolve().parent
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 18900
SERVER_ID = "dr-battle-editor/1.1"
VERSION = "1.2"
PACK_SCRIPT = ROOT_DIR / "tools" / "pack.mjs"
EXPORT_GAME_SCRIPT = ROOT_DIR / "tools" / "export-game.mjs"
NODE_BIN = shutil.which("node")
MAX_PACK_BYTES = 256 * 1024 * 1024  # 作品包（含 base64 素材）上限
PACK_TIMEOUT_SECONDS = 180.0
EXPORT_GAME_TIMEOUT_SECONDS = 300.0  # 單檔可遊玩 HTML 匯出較久（要內嵌素材）

# 檔案名白名單（SPEC：A-Za-z0-9_- 與中文）。攻擊檔、遭遇檔、trash 共用。
NAME_RE = re.compile(r"^[A-Za-z0-9_\-\u4e00-\u9fa5]+$")
WINDOWS_DEVICE = re.compile(r"con|prn|aux|nul|com[1-9]|lpt[1-9]", re.IGNORECASE)
IMPORT_LOCK = ".drpack-import.lock"  # tools/pack.mjs

# 每種資源的路徑前綴與合法 format（目錄由 AppState 依 root 決定）。
RESOURCE_SPECS = {
    "attack": {
        "prefix": "/api/attacks",
        "format": "dr-battle-attack/1",
        "label": "攻擊",
        "collection": "attacks",
    },
    "encounter": {
        "prefix": "/api/encounters",
        "format": "dr-battle-encounter/1",
        "label": "遭遇",
        "collection": "encounters",
    },
}

# 明確指定 MIME（避免 Windows 登錄檔把 .js 設成 text/plain，ES modules 會載入失敗）
MIME_OVERRIDES = {
    ".html": "text/html; charset=utf-8",
    ".htm": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".jsonl": "application/x-ndjson; charset=utf-8",
    ".map": "application/json; charset=utf-8",
    ".txt": "text/plain; charset=utf-8",
    ".md": "text/plain; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".wav": "audio/wav",
    ".mp3": "audio/mpeg",
    ".ogg": "audio/ogg",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".otf": "font/otf",
}

MAX_PUT_BYTES = 8 * 1024 * 1024  # 單一作品檔上限 8 MiB
MAX_PATCH_OPS = 512             # 單次 PATCH 的 op 數上限
SSE_HEARTBEAT_SECONDS = 15.0
WATCH_POLL_SECONDS = 0.4        # SPEC-AGENT：輪詢間隔 ≤ 500ms
EDITOR_STATE_TTL_MS = 5 * 60 * 1000
HISTORY_SUMMARY_MAX = 32
HISTORY_DEFAULT_LIMIT = 50
HISTORY_MAX_LIMIT = 500
ASSETS_SEARCH_DEFAULT_LIMIT = 30
ASSETS_SEARCH_MAX_LIMIT = 200

CUE_SCHEMA_NAMES = ("attack", "encounter", "cues")

# HTTP 方法 → 是否允許（用來回應 405 的 Allow 標頭）
ALLOWED_METHODS = "GET, HEAD, PUT, PATCH, DELETE, POST, OPTIONS"


# ---------------------------------------------------------------------------
# 通用小工具
# ---------------------------------------------------------------------------


def force_utf8_stdio():
    """Windows 主控台預設 cp1252，印中文會 UnicodeEncodeError。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def now_ms() -> int:
    return int(time.time() * 1000)


def iso_now() -> str:
    return datetime.now().astimezone().isoformat(timespec="milliseconds")


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def canonical_bytes(document) -> bytes:
    """作品檔的磁碟格式：縮排 2、不轉義中文、結尾換行。ETag 以此位元組計算。"""
    text = json.dumps(document, ensure_ascii=False, indent=2, allow_nan=False)
    return text.encode("utf-8") + b"\n"


def valid_resource_name(name: str) -> bool:
    return NAME_RE.fullmatch(name) is not None and WINDOWS_DEVICE.fullmatch(name) is None


def write_atomic(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".dr-write-")
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
        os.replace(tmp, path)
    finally:
        Path(tmp).unlink(missing_ok=True)


def guess_mime(path: Path) -> str:
    suffix = path.suffix.lower()
    if suffix in MIME_OVERRIDES:
        return MIME_OVERRIDES[suffix]
    guess, _ = mimetypes.guess_type(str(path))
    return guess or "application/octet-stream"


def default_assets_dir(root: Path) -> Path:
    """素材目錄：--assets／環境變數 DR_ASSETS 優先，否則用程式根的 assets/。"""
    env = os.environ.get("DR_ASSETS")
    return Path(env).expanduser().resolve() if env else Path(root).resolve() / "assets"


def safe_join(root: Path, url_path: str) -> Path | None:
    """把 URL 路徑解析成根目錄內的真實檔案路徑；任何逃逸或非法輸入回傳 None。"""
    try:
        decoded = urllib.parse.unquote(url_path, errors="strict")
    except (UnicodeDecodeError, ValueError):
        return None
    if "\x00" in decoded:
        return None
    # Windows 的反斜線也視為分隔符；URL 中的 .. 一律拒絕（靜態檔不需要）
    decoded = decoded.replace("\\", "/")
    parts = [p for p in decoded.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        return None
    # 拒絕磁碟機代號（C:）與 NTFS 資料流（file.txt:stream）這類 Windows 特殊路徑
    if ":" in decoded:
        return None
    candidate = root.joinpath(*parts) if parts else root
    try:
        resolved = candidate.resolve(strict=False)
        resolved.relative_to(root.resolve())
    except (OSError, ValueError):
        return None
    return resolved


def parse_resource_path(raw_path: str, resources: dict) -> tuple[str | None, str | None, dict | None]:
    """從 /api/attacks[/<name>.json]、/api/encounters[/<name>.json] 取出資源名。

    回傳 (name, error, spec)：
        * ("", None, spec)      → 列表端點
        * ("foo", None, spec)   → 單檔端點
        * (None, "訊息", spec)  → 400 錯誤
        * (None, None, None)    → 不是資源 API 路徑
    """
    path = urllib.parse.urlsplit(raw_path).path
    best: tuple[str, dict] | None = None
    for kind, spec in resources.items():
        prefix = spec["prefix"]
        if path == prefix or path.startswith(prefix + "/"):
            if best is None or len(prefix) > len(best[1]["prefix"]):
                best = (kind, spec)
    if best is None:
        return None, None, None
    kind, spec = best
    rest = path[len(spec["prefix"]):]
    if rest in ("", "/"):
        return "", None, spec
    rest = rest.lstrip("/")
    if not rest.endswith(".json"):
        return None, f"{spec['label']}檔路徑必須以 .json 結尾：{rest!r}", spec
    try:
        name = urllib.parse.unquote(rest[: -len(".json")], errors="strict")
    except (UnicodeDecodeError, ValueError):
        return None, f"{spec['label']}檔名編碼錯誤", spec
    if not valid_resource_name(name):
        return None, f"非法{spec['label']}檔名（僅允許 A-Za-z0-9_ 與中文）：{name!r}", spec
    return name, None, spec


def etag_header_value(etag: str) -> str:
    """HTTP ETag 必須是加引號的字串。"""
    return '"' + etag + '"'


def parse_if_match_header(value: str | None) -> list[str] | None:
    """解析 If-Match；回傳候選 etag 清單（可能含 '*'），標頭不存在回 None。"""
    if value is None:
        return None
    candidates: list[str] = []
    for part in value.split(","):
        part = part.strip()
        if not part:
            continue
        if part.upper().startswith("W/"):
            part = part[2:].strip()
        if len(part) >= 2 and part.startswith('"') and part.endswith('"'):
            part = part[1:-1]
        candidates.append(part)
    return candidates or None


def etag_matches(current: str | None, candidates: list[str]) -> bool:
    if "*" in candidates:
        return current is not None
    return current is not None and current in candidates


def clamp_int(raw, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(raw)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, value))


def token_from_path(path: str, prefix: str) -> str | None:
    """取 prefix 之後的單一區段（不含 '/'）；不是該前綴回 None。"""
    if path == prefix or path == prefix + "/":
        return ""
    if not path.startswith(prefix + "/"):
        return None
    return urllib.parse.unquote(path[len(prefix) + 1:], errors="strict")


# ---------------------------------------------------------------------------
# JSON Pointer 與 RFC 6902 JSON Patch
# ---------------------------------------------------------------------------

ALLOWED_PATCH_OPS = ("add", "remove", "replace", "move", "copy", "test")

_POINTER_BAD_ESCAPE = re.compile(r"~(?![01])")
_POINTER_INDEX_RE = re.compile(r"0|[1-9][0-9]*")


class PatchError(Exception):
    """JSON Patch 套用失敗。conflict=True 代表 test 條件不符（語意上屬 409）。"""

    def __init__(self, message, *, op_index=None, op_name=None, path=None, conflict=False):
        super().__init__(message)
        self.message = message
        self.op_index = op_index
        self.op_name = op_name
        self.path = path
        self.conflict = conflict

    def as_dict(self) -> dict:
        payload = {"ok": False, "error": self.message}
        if self.op_index is not None:
            payload["opIndex"] = self.op_index
        if self.op_name is not None:
            payload["op"] = self.op_name
        if self.path is not None:
            payload["path"] = self.path
        return payload


def parse_pointer(pointer) -> list[str]:
    """RFC 6901 JSON Pointer → token 清單（'~1' → '/'、'~0' → '~'）。"""
    if pointer is None:
        raise PatchError("缺少 path")
    if not isinstance(pointer, str):
        raise PatchError("path 必須是字串")
    if pointer == "":
        return []
    if not pointer.startswith("/"):
        raise PatchError("JSON Pointer 必須以 '/' 開頭：" + repr(pointer))
    tokens: list[str] = []
    for raw in pointer[1:].split("/"):
        if "~" in raw:
            if _POINTER_BAD_ESCAPE.search(raw):
                raise PatchError("JSON Pointer 有非法轉義（只允許 ~0 與 ~1）：" + repr(pointer))
            raw = raw.replace("~1", "/").replace("~0", "~")
        tokens.append(raw)
    return tokens


def _array_index(token: str, length: int, *, inserting: bool) -> int:
    if token == "-":
        if inserting:
            return length
        raise PatchError("'-' 只能用在 add 的陣列尾端")
    if not _POINTER_INDEX_RE.fullmatch(token):
        raise PatchError("不是合法的陣列索引：" + repr(token))
    index = int(token)
    if inserting:
        if index > length:
            raise PatchError(f"陣列索引超出範圍：{index} > {length}")
    elif index >= length:
        raise PatchError(f"陣列索引超出範圍：{index} >= {length}")
    return index


def deep_equal(left, right) -> bool:
    """JSON 語意的相等（true 與 1 不相等）。"""
    if isinstance(left, bool) or isinstance(right, bool):
        return isinstance(left, bool) and isinstance(right, bool) and left == right
    if left is None or right is None:
        return left is None and right is None
    if isinstance(left, dict) and isinstance(right, dict):
        if left.keys() != right.keys():
            return False
        return all(deep_equal(left[key], right[key]) for key in left)
    if isinstance(left, list) and isinstance(right, list):
        if len(left) != len(right):
            return False
        return all(deep_equal(a, b) for a, b in zip(left, right))
    if isinstance(left, (int, float)) and isinstance(right, (int, float)):
        return left == right
    if isinstance(left, str) and isinstance(right, str):
        return left == right
    return False


def get_at(document, tokens: list[str], pointer: str):
    current = document
    for token in tokens:
        if isinstance(current, dict):
            if token not in current:
                raise PatchError("路徑不存在：" + pointer)
            current = current[token]
        elif isinstance(current, list):
            current = current[_array_index(token, len(current), inserting=False)]
        else:
            raise PatchError("無法深入純量值：" + pointer)
    return current


def _parent_at(document, tokens: list[str], pointer: str):
    if not tokens:
        raise PatchError("此操作不允許指向文件根節點：''")
    parent = get_at(document, tokens[:-1], pointer)
    if not isinstance(parent, (dict, list)):
        raise PatchError("父節點不是物件或陣列：" + pointer)
    return parent, tokens[-1]


def add_at(document, tokens: list[str], pointer: str, value):
    if not tokens:
        return value
    parent, token = _parent_at(document, tokens, pointer)
    if isinstance(parent, dict):
        parent[token] = value
        return document
    parent.insert(_array_index(token, len(parent), inserting=True), value)
    return document


def replace_at(document, tokens: list[str], pointer: str, value):
    if not tokens:
        return value
    parent, token = _parent_at(document, tokens, pointer)
    if isinstance(parent, dict):
        if token not in parent:
            raise PatchError("replace 的目標不存在：" + pointer)
        parent[token] = value
        return document
    parent[_array_index(token, len(parent), inserting=False)] = value
    return document


def remove_at(document, tokens: list[str], pointer: str):
    parent, token = _parent_at(document, tokens, pointer)
    if isinstance(parent, dict):
        if token not in parent:
            raise PatchError("remove 的目標不存在：" + pointer)
        return parent.pop(token)
    return parent.pop(_array_index(token, len(parent), inserting=False))


def apply_json_patch(document, ops):
    """套用 RFC 6902 patch；回傳 (新文件, 摘要清單)。文件不會被就地修改。"""
    if not isinstance(ops, list):
        raise PatchError("PATCH 內容必須是 JSON 陣列（RFC 6902）")
    if len(ops) > MAX_PATCH_OPS:
        raise PatchError(f"PATCH op 數 {len(ops)} 超過上限 {MAX_PATCH_OPS}")
    doc = copy.deepcopy(document)
    summary: list[dict] = []
    for index, op in enumerate(ops):
        if not isinstance(op, dict):
            raise PatchError("每個 patch op 必須是 JSON 物件", op_index=index)
        name = op.get("op")
        path_raw = op.get("path")
        if name not in ALLOWED_PATCH_OPS:
            raise PatchError(
                "不支援的 op：" + repr(name) + "（允許 add/remove/replace/move/copy/test）",
                op_index=index,
                op_name=name if isinstance(name, str) else None,
                path=path_raw if isinstance(path_raw, str) else None,
            )
        try:
            tokens = parse_pointer(path_raw)
            if name == "add":
                doc = add_at(doc, tokens, path_raw, copy.deepcopy(op.get("value")))
            elif name == "remove":
                remove_at(doc, tokens, path_raw)
            elif name == "replace":
                doc = replace_at(doc, tokens, path_raw, copy.deepcopy(op.get("value")))
            elif name == "move":
                from_raw = op.get("from")
                from_tokens = parse_pointer(from_raw)
                if from_raw == path_raw:
                    pass  # 同位置搬移＝無操作
                else:
                    if from_tokens and len(tokens) > len(from_tokens) and tokens[: len(from_tokens)] == from_tokens:
                        raise PatchError("move 不可以把節點搬進自己的子節點：" + str(from_raw))
                    value = remove_at(doc, from_tokens, from_raw)
                    doc = add_at(doc, tokens, path_raw, value)
            elif name == "copy":
                from_raw = op.get("from")
                from_tokens = parse_pointer(from_raw)
                if from_tokens and tokens[: len(from_tokens)] == from_tokens and from_tokens:
                    # copy 到自己子節點在 RFC 上是允許的（深拷貝後插入），照做
                    pass
                value = copy.deepcopy(get_at(doc, from_tokens, from_raw))
                doc = add_at(doc, tokens, path_raw, value)
            elif name == "test":
                actual = get_at(doc, tokens, path_raw)
                if not deep_equal(actual, op.get("value")):
                    raise PatchError("test 失敗：路徑上的值與預期不同", conflict=True)
        except PatchError as exc:
            if exc.op_index is None:
                exc.op_index = index
            if exc.op_name is None:
                exc.op_name = name
            if exc.path is None and isinstance(path_raw, str):
                exc.path = path_raw
            raise
        entry = {"op": name, "path": path_raw}
        if "from" in op:
            entry["from"] = op.get("from")
        summary.append(entry)
    return doc, summary


def condense_patch_summary(summary: list[dict]) -> list[dict]:
    if len(summary) <= HISTORY_SUMMARY_MAX:
        return summary
    return summary[:HISTORY_SUMMARY_MAX] + [{"omitted": len(summary) - HISTORY_SUMMARY_MAX}]
# ---------------------------------------------------------------------------
# SSE 廣播中心
# ---------------------------------------------------------------------------


class SseHub:
    """極簡發佈／訂閱：每個 SSE 連線一條佇列，滿了就丟（事件可重讀磁碟，非關鍵資料）。"""

    QUEUE_SIZE = 256

    def __init__(self):
        self._lock = threading.Lock()
        self._subscribers: list[queue.Queue] = []
        self._closed = False
        self._seq = 0

    def subscribe(self) -> queue.Queue:
        channel: queue.Queue = queue.Queue(maxsize=self.QUEUE_SIZE)
        with self._lock:
            if self._closed:
                channel.put_nowait(None)
                return channel
            self._subscribers.append(channel)
        return channel

    def unsubscribe(self, channel: queue.Queue):
        with self._lock:
            try:
                self._subscribers.remove(channel)
            except ValueError:
                pass

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)

    def next_seq(self) -> int:
        with self._lock:
            self._seq += 1
            return self._seq

    def publish(self, event: dict):
        with self._lock:
            targets = list(self._subscribers)
        for channel in targets:
            try:
                channel.put_nowait(event)
            except queue.Full:
                pass

    def close(self):
        with self._lock:
            self._closed = True
            targets = list(self._subscribers)
            self._subscribers.clear()
        for channel in targets:
            try:
                channel.put_nowait(None)
            except queue.Full:
                pass


# ---------------------------------------------------------------------------
# 檔案監看（外部直接改檔也要推事件）
# ---------------------------------------------------------------------------


class FileWatcher(threading.Thread):
    """輪詢 attacks/ 與 encounters/ 的 mtime+size，內容真的變了才推事件。"""

    def __init__(self, app: "AppState"):
        super().__init__(name="dr-file-watcher", daemon=True)
        self.app = app
        self._stop = threading.Event()
        self.snapshot: dict[tuple[str, str], tuple[int, int, str]] = {}
        self.started_event = threading.Event()

    # ---------------------------------------------------------------- 生命週期
    def start_watching(self):
        self._scan(initial=True)
        self.started_event.set()
        self.start()

    def stop_watching(self):
        self._stop.set()
        self.started_event.set()

    def run(self):
        while not self._stop.wait(self.app.poll_interval):
            try:
                self.poll_once()
            except Exception:  # noqa: BLE001 - 監看螺絲鬆掉不該拖垮伺服器
                traceback.print_exc()

    # ---------------------------------------------------------------- 掃描
    def _scan(self, initial: bool):
        app = self.app
        with app.io_lock:
            for kind, spec in app.resources.items():
                folder: Path = spec["dir"]
                seen: set[tuple[str, str]] = set()
                try:
                    paths = sorted(folder.glob("*.json"))
                except OSError:
                    continue
                for path in paths:
                    name = path.stem
                    if not valid_resource_name(name):
                        continue
                    key = (kind, name)
                    seen.add(key)
                    try:
                        stat = path.stat()
                    except OSError:
                        continue
                    previous = self.snapshot.get(key)
                    if previous and previous[0] == stat.st_mtime_ns and previous[1] == stat.st_size:
                        continue
                    try:
                        raw = path.read_bytes()
                    except OSError:
                        continue
                    etag = sha256_hex(raw)
                    self.snapshot[key] = (stat.st_mtime_ns, stat.st_size, etag)
                    if initial or previous is None or previous[2] == etag:
                        continue
                    app.emit_event(
                        "changed",
                        kind,
                        name,
                        etag=etag,
                        by="external",
                        size=len(raw),
                    )
                for key in [k for k in self.snapshot if k[0] == kind and k not in seen]:
                    del self.snapshot[key]
                    if not initial:
                        app.emit_event("deleted", kind, key[1], etag=None, by="external")

    def poll_once(self):
        self._scan(initial=False)

    # ------------------------------------------------ 由 API 寫入端回報（避免重複事件）
    def note_change(self, kind: str, name: str, path: Path, etag: str):
        try:
            stat = path.stat()
            mtime_ns, size = stat.st_mtime_ns, stat.st_size
        except OSError:
            mtime_ns, size = 0, 0
        with self.app.io_lock:
            self.snapshot[(kind, name)] = (mtime_ns, size, etag)

    def note_delete(self, kind: str, name: str):
        with self.app.io_lock:
            self.snapshot.pop((kind, name), None)


# ---------------------------------------------------------------------------
# 歷史紀錄（審計 + 版本 blob）
# ---------------------------------------------------------------------------


class HistoryStore:
    """`history/YYYY-MM-DD.jsonl` 一行一筆；`history/blobs/<etag>.json` 存完整版本內容。"""

    def __init__(self, folder: Path):
        self.folder = folder
        self.blobs_dir = folder / "blobs"
        self._lock = threading.Lock()

    def ensure_dirs(self):
        self.blobs_dir.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------ 寫入
    def store_blob(self, etag: str, raw: bytes) -> bool:
        """內容定址：同一版本只存一份。回傳是否新寫入。"""
        if not etag:
            return False
        self.ensure_dirs()
        path = self.blobs_dir / f"{etag}.json"
        if path.is_file():
            return False
        write_atomic(path, raw)
        return True

    def read_blob(self, etag: str) -> bytes | None:
        if not etag or not NAME_RE.match(etag):
            return None
        path = self.blobs_dir / f"{etag}.json"
        try:
            return path.read_bytes()
        except OSError:
            return None

    def append(self, entry: dict) -> dict:
        entry = dict(entry)
        entry.setdefault("id", uuid.uuid4().hex[:16])
        entry.setdefault("ts", iso_now())
        entry.setdefault("tsMs", now_ms())
        line = json.dumps(entry, ensure_ascii=False)
        day = time.strftime("%Y-%m-%d", time.localtime(entry["tsMs"] / 1000))
        path = self.folder / f"{day}.jsonl"
        with self._lock:
            self.ensure_dirs()
            with open(path, "a", encoding="utf-8", newline="\n") as handle:
                handle.write(line + "\n")
        return entry

    # ------------------------------------------------------------------ 讀取
    def _day_files(self) -> list[Path]:
        try:
            files = [p for p in self.folder.glob("*.jsonl") if p.is_file()]
        except OSError:
            return []
        return sorted(files, key=lambda p: p.name, reverse=True)

    def query(
        self,
        *,
        kind: str | None = None,
        name: str | None = None,
        client: str | None = None,
        limit: int = HISTORY_DEFAULT_LIMIT,
        day: str | None = None,
    ) -> list[dict]:
        limit = max(1, min(HISTORY_MAX_LIMIT, limit))
        results: list[dict] = []
        files = self._day_files()
        if day:
            files = [p for p in files if p.stem == day]
        for path in files:
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for line in reversed(lines):
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if kind and entry.get("kind") != kind:
                    continue
                if name and entry.get("name") != name:
                    continue
                if client and entry.get("client") != client:
                    continue
                results.append(entry)
                if len(results) >= limit:
                    return results
        return results

    def find(self, entry_id: str) -> dict | None:
        for path in self._day_files():
            try:
                lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
            except OSError:
                continue
            for line in lines:
                line = line.strip()
                if not line:
                    continue
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if entry.get("id") == entry_id:
                    return entry
        return None


# ---------------------------------------------------------------------------
# 垃圾桶（DELETE 不真刪）
# ---------------------------------------------------------------------------


def _trash_stamp() -> str:
    now = datetime.now()
    return f"{now:%Y%m%d-%H%M%S}-{now.microsecond // 1000:03d}"


class TrashStore:
    """`trash/<collection>/<name>.<YYYYMMDD-HHMMSS-mmm>.json`"""

    def __init__(self, folder: Path):
        self.folder = folder

    def _kind_dir(self, kind: str) -> Path:
        return self.folder / kind

    def move_to_trash(self, kind: str, name: str, raw: bytes) -> dict:
        folder = self._kind_dir(kind)
        folder.mkdir(parents=True, exist_ok=True)
        stamp = _trash_stamp()
        path = folder / f"{name}.{stamp}.json"
        counter = 1
        while path.exists():
            path = folder / f"{name}.{stamp}-{counter}.json"
            counter += 1
        write_atomic(path, raw)
        return {
            "id": path.stem,
            "kind": kind,
            "name": name,
            "path": str(path.relative_to(self.folder.parent)).replace("\\", "/"),
            "deletedAt": iso_now(),
            "size": len(raw),
        }

    def entries(self, kind: str | None = None) -> list[dict]:
        kinds = [kind] if kind else list(RESOURCE_SPECS.keys())
        items: list[dict] = []
        for current in kinds:
            folder = self._kind_dir(current)
            try:
                paths = [p for p in folder.glob("*.json") if p.is_file()]
            except OSError:
                continue
            for path in paths:
                stem = path.stem
                original = stem.split(".")[0]
                try:
                    stat = path.stat()
                except OSError:
                    continue
                items.append(
                    {
                        "id": stem,
                        "kind": current,
                        "name": original,
                        "path": str(path.relative_to(self.folder.parent)).replace("\\", "/"),
                        "size": stat.st_size,
                        "modified": int(stat.st_mtime * 1000),
                    }
                )
        items.sort(key=lambda item: item["modified"], reverse=True)
        return items

    def find(self, entry_id: str, kind: str | None = None) -> tuple[dict, Path] | None:
        if not entry_id or not re.fullmatch(r"[A-Za-z0-9_\-\u4e00-\u9fa5.]+", entry_id):
            return None
        for item in self.entries(kind):
            if item["id"] == entry_id:
                return item, self.folder.parent / item["path"]
        return None


# ---------------------------------------------------------------------------
# 素材索引（帶 mtime 快取）
# ---------------------------------------------------------------------------


class PackSubprocessError(Exception):
    """作品包子程序（tools/pack.mjs）失敗；status 是建議的 HTTP 狀態碼。"""

    def __init__(self, message: str, status: int = 500, *, details: dict | None = None):
        super().__init__(message)
        self.message = message
        self.status = status
        self.details = details or {}


class AssetsIndex:
    TEXT_FIELDS = ("name", "chapter", "source", "src", "role", "cjk")

    def __init__(self, assets_dir: Path, custom_index_path: Path | None = None):
        self.assets_dir = assets_dir
        # 作品根的自訂素材索引（可為 None：預設模式，自訂條目已由 build_assets.py 併進 index.json）
        self.custom_index_path = Path(custom_index_path) if custom_index_path else None
        self._lock = threading.Lock()
        self._stamp: tuple | None = None
        self._data = self._empty()

    @staticmethod
    def _empty() -> dict:
        return {"sprites": {}, "audio": {}, "fonts": {}, "presets": {}}

    def _stat_stamp(self) -> tuple:
        stamps = []
        for path in (self.assets_dir / "index.json", self.assets_dir / "actor-presets.json"):
            try:
                stat = path.stat()
                stamps.append((stat.st_mtime_ns, stat.st_size))
            except OSError:
                stamps.append((0, 0))
        if self.custom_index_path is not None:
            try:
                stat = self.custom_index_path.stat()
                stamps.append((stat.st_mtime_ns, stat.st_size))
            except OSError:
                stamps.append((0, 0))
        return tuple(stamps)

    def _load(self):
        stamp = self._stat_stamp()
        if self._stamp == stamp:
            return
        data = self._empty()
        index_path = self.assets_dir / "index.json"
        try:
            raw = json.loads(index_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                for section in ("sprites", "audio", "fonts"):
                    value = raw.get(section)
                    if isinstance(value, dict):
                        data[section] = value
        except (OSError, json.JSONDecodeError):
            pass
        if self.custom_index_path is not None:
            self._merge_custom(data)
        presets_path = self.assets_dir / "actor-presets.json"
        try:
            raw_presets = json.loads(presets_path.read_text(encoding="utf-8"))
            data["presets"] = self._normalize_presets(raw_presets)
        except (OSError, json.JSONDecodeError):
            pass
        self._data = data
        self._stamp = stamp

    def _merge_custom(self, data: dict) -> int:
        """把作品根的 custom.index.json 併進記憶體索引（不寫回主索引）。回傳併入條目數。

        主索引若本來就有 `custom:true` 條目（repo 層級的自訂素材，由 build_assets.py 併進去）
        予以保留；作品根的同名條目會覆蓋掉它們（作品根優先），但不會刪掉其他主索引條目，
        因此不會因為換作品根而讓本機原有的自訂素材消失。
        """
        try:
            raw = json.loads(self.custom_index_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return 0
        if not isinstance(raw, dict):
            return 0
        merged = 0
        for section in ("sprites", "audio"):
            table = data.get(section)
            if not isinstance(table, dict):
                table = {}
                data[section] = table
            entries = raw.get(section)
            if not isinstance(entries, dict):
                continue
            for name, entry in entries.items():
                if isinstance(entry, dict):
                    item = dict(entry)
                    item["custom"] = True
                    table[name] = item
                    merged += 1
        return merged

    @staticmethod
    def _normalize_presets(raw) -> dict:
        if isinstance(raw, dict):
            for key in ("presets", "actors", "items"):
                value = raw.get(key)
                if isinstance(value, dict):
                    return value
                if isinstance(value, list):
                    return {
                        str(item.get("id") or item.get("name") or f"preset{i}"): item
                        for i, item in enumerate(value)
                        if isinstance(item, dict)
                    }
            return {
                key: value
                for key, value in raw.items()
                if isinstance(value, dict) and key not in ("format", "meta", "generatedBy")
            }
        if isinstance(raw, list):
            return {
                str(item.get("id") or item.get("name") or f"preset{i}"): item
                for i, item in enumerate(raw)
                if isinstance(item, dict)
            }
        return {}

    # ------------------------------------------------------------------ 查詢
    def search(self, *, text: str, tag: str, kind: str, limit: int) -> list[dict]:
        with self._lock:
            self._load()
            data = self._data
        needle = (text or "").strip().lower()
        wanted_tag = (tag or "").strip().lower()
        results: list[dict] = []
        if kind in ("", "sprite"):
            results.extend(self._search_sprites(data["sprites"], needle, wanted_tag))
        if kind in ("", "audio", "sfx", "music"):
            results.extend(self._search_audio(data["audio"], needle, wanted_tag, kind))
        if kind in ("", "font"):
            results.extend(self._search_fonts(data["fonts"], needle, wanted_tag))
        if kind in ("", "preset"):
            results.extend(self._search_presets(data["presets"], needle, wanted_tag))

        def sort_key(item: dict):
            name = item["name"].lower()
            if needle and name == needle:
                rank = 0
            elif needle and name.startswith(needle):
                rank = 1
            elif needle and needle in name:
                rank = 2
            else:
                rank = 3
            return (rank, len(name), name)

        results.sort(key=sort_key)
        return results[: max(1, min(ASSETS_SEARCH_MAX_LIMIT, limit))]

    @staticmethod
    def _tag_list(entry: dict, extra: str | None = None) -> list[str]:
        tags = entry.get("tags")
        out = [str(tag) for tag in tags] if isinstance(tags, list) else []
        if extra:
            out.append(extra)
        return out

    def _search_sprites(self, sprites: dict, needle: str, tag: str) -> list[dict]:
        out = []
        for name, entry in sprites.items():
            if not isinstance(entry, dict):
                continue
            tags = self._tag_list(entry)
            if needle and needle not in name.lower():
                continue
            if tag and tag not in [t.lower() for t in tags]:
                continue
            frames = entry.get("frames") if isinstance(entry.get("frames"), list) else []
            out.append(
                {
                    "kind": "sprite",
                    "name": name,
                    "w": entry.get("w"),
                    "h": entry.get("h"),
                    "frames": len(frames),
                    "ox": entry.get("ox"),
                    "oy": entry.get("oy"),
                    "chapter": entry.get("chapter"),
                    "tags": tags,
                    "preview": f"assets/{frames[0]}" if frames else None,
                }
            )
        return out

    def _search_audio(self, audio: dict, needle: str, tag: str, kind: str) -> list[dict]:
        out = []
        for name, entry in audio.items():
            if not isinstance(entry, dict):
                continue
            entry_kind = str(entry.get("kind") or "sfx")
            if kind in ("sfx", "music") and entry_kind != kind:
                continue
            # 音訊的 tag 來源有三處：條目自己的自由 tag（自訂音訊例如 ["boss","calm"]）、
            # 條目的 kind（sfx / music），以及代表整個分類的 "audio"。
            tags: list[str] = []
            for candidate in self._tag_list(entry, entry_kind):
                if candidate.lower() not in {seen.lower() for seen in tags}:
                    tags.append(candidate)
            if tag and tag not in {item.lower() for item in tags} and tag != "audio":
                continue
            if needle and needle not in name.lower():
                continue
            out.append(
                {
                    "kind": "audio",
                    "audioKind": entry_kind,
                    "name": name,
                    "file": f"assets/{entry.get('file')}" if entry.get("file") else None,
                    "chapter": entry.get("chapter"),
                    "bytes": entry.get("bytes"),
                    "loop": entry.get("loop"),
                    "tags": tags,
                }
            )
        return out

    def _search_fonts(self, fonts: dict, needle: str, tag: str) -> list[dict]:
        out = []
        for name, entry in fonts.items():
            if not isinstance(entry, dict):
                continue
            if tag and tag not in ("font",):
                continue
            if needle and needle not in name.lower():
                continue
            out.append(
                {
                    "kind": "font",
                    "name": name,
                    "image": f"assets/{entry.get('image')}" if entry.get("image") else None,
                    "glyphs": entry.get("glyphs"),
                    "size": entry.get("size"),
                    "cjk": entry.get("cjk"),
                    "tags": ["font"],
                }
            )
        return out

    def _search_presets(self, presets: dict, needle: str, tag: str) -> list[dict]:
        out = []
        for name, entry in presets.items():
            if not isinstance(entry, dict):
                continue
            if tag and tag not in ("preset", "actor"):
                continue
            if needle and needle not in name.lower():
                continue
            anims = entry.get("anims") or entry.get("animations") or {}
            states = sorted(anims.keys()) if isinstance(anims, dict) else []
            out.append(
                {
                    "kind": "preset",
                    "name": name,
                    "actorKind": entry.get("kind"),
                    "states": states,
                    "sprite": entry.get("sprite"),
                    "tags": ["preset"],
                }
            )
        return out
# ---------------------------------------------------------------------------
# 應用狀態（目錄、鎖、快取、SSE、監看、編輯器狀態）
# ---------------------------------------------------------------------------


class AppState:
    """一個伺服器實例的共用狀態。測試會用臨時目錄建立自己的 AppState。

    `root`：battle-editor 目錄（靜態檔、引擎、主素材索引都從這裡來）。
    `works`：作品根（`--works`／`DR_WORKS`）；None 代表預設草稿區（= root）。
    作品根模式下 attacks/、encounters/、trash/、history/、assets/custom/ 全部改到作品根下，
    主素材索引（assets/index.json）仍讀 battle-editor 的，自訂素材以 custom.index.json 動態合併。
    """

    def __init__(
        self,
        root: Path,
        *,
        poll_interval: float = WATCH_POLL_SECONDS,
        history_dir=None,
        works: Path | None = None,
        assets: Path | None = None,
    ):
        self.root = Path(root).resolve()
        # 官方素材庫（index.json、sprites/、audio/、fonts/…）可以放在程式目錄外
        self.assets_dir = Path(assets).resolve() if assets else default_assets_dir(self.root)
        self.works = Path(works).resolve() if works else None
        self.data_root = self.works or self.root
        self.poll_interval = max(0.05, min(0.5, float(poll_interval)))
        self.io_lock = threading.RLock()
        self.resources: dict[str, dict] = {}
        for kind, spec in RESOURCE_SPECS.items():
            entry = dict(spec)
            entry["dir"] = self.data_root / spec["collection"]
            self.resources[kind] = entry
        self.trash = TrashStore(self.data_root / "trash")
        self.history = HistoryStore(Path(history_dir) if history_dir else self.data_root / "history")
        self.assets = AssetsIndex(self.assets_dir, custom_index_path=self._custom_index_path())
        self.sse = SseHub()
        self.watcher = FileWatcher(self)
        self.editor_state_lock = threading.Lock()
        self.editor_states: dict[str, dict] = {}
        self.started_at_ms = now_ms()
        self._merged_index_stamp: tuple | None = None
        self._merged_index_bytes: bytes | None = None

    # ------------------------------------------------------------------ 目錄
    def _custom_index_path(self) -> Path | None:
        """作品根的自訂素材索引；預設模式回 None（維持舊行為：不另外合併）。"""
        if not self.works:
            return None
        return self.works / "assets" / "custom.index.json"

    @property
    def custom_assets_dir(self) -> Path:
        return self.data_root / "assets" / "custom"

    def ensure_dirs(self):
        for spec in self.resources.values():
            spec["dir"].mkdir(parents=True, exist_ok=True)
        (self.data_root / "trash").mkdir(parents=True, exist_ok=True)
        self.history.ensure_dirs()
        if self.works:
            self.custom_assets_dir.mkdir(parents=True, exist_ok=True)

    def resource_path(self, kind: str, name: str) -> Path:
        return self.resources[kind]["dir"] / f"{name}.json"

    def spec(self, kind: str) -> dict:
        return self.resources[kind]

    # ------------------------------------------------------------------ 讀寫
    def read_resource(self, kind: str, name: str) -> tuple[bytes, str] | None:
        path = self.resource_path(kind, name)
        try:
            raw = path.read_bytes()
        except OSError:
            return None
        return raw, sha256_hex(raw)

    def write_resource(self, kind: str, name: str, data: bytes, etag: str):
        path = self.resource_path(kind, name)
        write_atomic(path, data)
        self.watcher.note_change(kind, name, path, etag)

    # ------------------------------------------------------------------ 事件
    def emit_event(self, event_type: str, kind: str | None, name: str | None, **fields):
        payload = {"type": event_type, "seq": self.sse.next_seq()}
        if kind is not None:
            payload["kind"] = kind
        if name is not None:
            payload["name"] = name
        payload.update(fields)
        self.sse.publish(payload)
        return payload

    def start(self):
        self.ensure_dirs()
        self.watcher.start_watching()

    def stop(self):
        self.watcher.stop_watching()
        self.sse.close()

    # ------------------------------------------------------------------ 素材索引合併
    def merged_index_bytes(self) -> tuple[bytes, str] | None:
        """`GET /assets/index.json` 要回應的位元組。

        預設模式（沒有作品根）回 None → 交給靜態檔服務直接送主索引，行為與舊版完全相同。
        作品根模式：主索引（battle-editor/assets/index.json）＋作品根 custom.index.json 動態合併，
        只影響回應、不寫回主索引，因此不同作品根的自訂素材互不污染。
        """
        custom_path = self._custom_index_path()
        if custom_path is None:
            return None
        main_path = self.assets_dir / "index.json"
        stamps = []
        for path in (main_path, custom_path):
            try:
                stat = path.stat()
                stamps.append((stat.st_mtime_ns, stat.st_size))
            except OSError:
                stamps.append((0, 0))
        stamp = tuple(stamps)
        with self.io_lock:
            if stamp == self._merged_index_stamp and self._merged_index_bytes is not None:
                return self._merged_index_bytes, sha256_hex(self._merged_index_bytes)
        index = None
        try:
            raw = json.loads(main_path.read_text(encoding="utf-8"))
            if isinstance(raw, dict):
                index = raw
        except (OSError, json.JSONDecodeError):
            index = None
        if index is None:
            return None
        merged = self.assets._empty()
        for section in ("sprites", "audio", "fonts"):
            value = index.get(section)
            if isinstance(value, dict):
                merged[section] = dict(value)
        # 主索引裡的既有條目（含 repo 層級的自訂素材）保留；作品根同名條目由 _merge_custom 覆蓋
        self.assets._merge_custom(merged)
        payload = {"format": index.get("format") or "dr-battle-assets/1"}
        payload["sprites"] = merged["sprites"]
        payload["audio"] = merged["audio"]
        payload["fonts"] = merged["fonts"]
        for key, value in index.items():
            if key not in payload:
                payload[key] = value
        data = canonical_bytes(payload)
        with self.io_lock:
            self._merged_index_stamp = stamp
            self._merged_index_bytes = data
        return data, sha256_hex(data)

    # ------------------------------------------------------------------ 作品包
    def pack_env(self) -> dict:
        env = dict(os.environ)
        env["DR_WORKS"] = str(self.works) if self.works else ""
        if not env["DR_WORKS"]:
            env.pop("DR_WORKS", None)
        return env

    def run_pack(self, args: list[str], *, stdin_bytes: bytes | None = None) -> dict:
        """以子程序呼叫 tools/pack.mjs（作品包格式的唯一實作），回傳解析後的 JSON。"""
        if NODE_BIN is None:
            raise PackSubprocessError("找不到 node（PATH 上沒有 Node.js），無法使用作品包功能", 500)
        if not PACK_SCRIPT.is_file():
            raise PackSubprocessError(f"找不到 {PACK_SCRIPT}", 500)
        command = [NODE_BIN, str(PACK_SCRIPT), *args, "--json"]
        if self.data_root != ROOT_DIR or self.works is not None:
            command += ["--works", str(self.data_root)]
        try:
            completed = subprocess.run(  # noqa: S603 - 參數固定，只有檔名/模式來自 API
                command,
                cwd=str(ROOT_DIR),
                env=self.pack_env(),
                input=stdin_bytes,
                capture_output=True,
                timeout=PACK_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise PackSubprocessError(f"作品包操作逾時（{PACK_TIMEOUT_SECONDS:.0f} 秒）", 504) from exc
        except OSError as exc:
            raise PackSubprocessError(f"無法執行 tools/pack.mjs：{exc}", 500) from exc
        stdout = completed.stdout.decode("utf-8", errors="replace").strip()
        stderr = completed.stderr.decode("utf-8", errors="replace").strip()
        if not stdout:
            detail = stderr or f"pack.mjs 沒有輸出（exit {completed.returncode}）"
            raise PackSubprocessError(detail, 500)
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError as exc:
            detail = stdout[:2000] + (("\n" + stderr) if stderr else "")
            raise PackSubprocessError(f"pack.mjs 輸出不是合法 JSON：{exc.msg}\n{detail}", 500) from exc
        if not isinstance(payload, dict):
            raise PackSubprocessError("pack.mjs 輸出不是 JSON 物件", 500)
        return payload

    def run_export_game(self, args: list[str]) -> dict:
        """以子程序呼叫 tools/export-game.mjs，回傳解析後的 JSON。"""
        if NODE_BIN is None:
            raise PackSubprocessError("找不到 node（PATH 上沒有 Node.js），無法匯出可遊玩 HTML", 500)
        if not EXPORT_GAME_SCRIPT.is_file():
            raise PackSubprocessError(f"找不到 {EXPORT_GAME_SCRIPT}", 500)
        command = [NODE_BIN, str(EXPORT_GAME_SCRIPT), *args, "--json"]
        try:
            completed = subprocess.run(  # noqa: S603 - 參數固定，只有名稱/語言/標題來自 API
                command,
                cwd=str(ROOT_DIR),
                env=self.pack_env(),
                capture_output=True,
                timeout=EXPORT_GAME_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as exc:
            raise PackSubprocessError(
                f"可遊玩 HTML 匯出逾時（{EXPORT_GAME_TIMEOUT_SECONDS:.0f} 秒）", 504
            ) from exc
        except OSError as exc:
            raise PackSubprocessError(f"無法執行 tools/export-game.mjs：{exc}", 500) from exc
        stdout = completed.stdout.decode("utf-8", errors="replace").strip()
        stderr = completed.stderr.decode("utf-8", errors="replace").strip()
        if not stdout:
            detail = stderr or f"export-game.mjs 沒有輸出（exit {completed.returncode}）"
            raise PackSubprocessError(detail, 500)
        try:
            payload = json.loads(stdout)
        except json.JSONDecodeError as exc:
            detail = stdout[:2000] + (("\n" + stderr) if stderr else "")
            raise PackSubprocessError(f"export-game.mjs 輸出不是合法 JSON：{exc.msg}\n{detail}", 500) from exc
        if not isinstance(payload, dict):
            raise PackSubprocessError("export-game.mjs 輸出不是 JSON 物件", 500)
        return payload

    # ------------------------------------------------------------------ 審計
    def audit(
        self,
        *,
        client: str,
        method: str,
        kind: str | None,
        name: str | None,
        before_etag: str | None,
        after_etag: str | None,
        action: str,
        patch: list[dict] | None = None,
        size: int | None = None,
        extra: dict | None = None,
    ) -> None:
        entry = {
            "client": client,
            "method": method,
            "action": action,
            "kind": kind,
            "name": name,
            "beforeEtag": before_etag,
            "afterEtag": after_etag,
        }
        if patch is not None:
            entry["patch"] = condense_patch_summary(patch)
            entry["patchOps"] = len(patch)
        if size is not None:
            entry["size"] = size
        if extra:
            entry.update(extra)
        try:
            self.history.append(entry)
        except OSError as exc:
            print(f"無法寫入作品歷史記錄：{exc}", file=sys.stderr)

    def store_previous_version(self, raw: bytes | None, etag: str | None):
        if raw is not None and etag:
            self.history.store_blob(etag, raw)

    # ------------------------------------------------------------------ 編輯器狀態
    def editor_report(self, client_id: str | None, payload: dict) -> dict:
        # body 的 clientId 優先（同一瀏覽器可開多個分頁各自回報），其次 X-Client 標頭
        body_client = payload.get("clientId")
        if isinstance(body_client, str) and body_client.strip():
            cid = body_client.strip()
        else:
            cid = client_id or "anonymous"
        cid = re.sub(r"[^\w\-.@:]", "_", str(cid))[:120] or "anonymous"
        state = {k: v for k, v in payload.items() if k not in ("clientId", "focus")}
        record = {
            "clientId": cid,
            "state": state,
            "updatedMs": now_ms(),
            "updatedAt": iso_now(),
        }
        with self.editor_state_lock:
            self.editor_states[cid] = record
        return record

    def editor_list(self, *, prune: bool = True) -> list[dict]:
        cutoff = now_ms() - EDITOR_STATE_TTL_MS
        with self.editor_state_lock:
            if prune:
                for cid, record in list(self.editor_states.items()):
                    if record["updatedMs"] < cutoff:
                        del self.editor_states[cid]
            return [dict(record) for record in self.editor_states.values()]

    def editor_remove(self, client_id: str) -> bool:
        with self.editor_state_lock:
            return self.editor_states.pop(client_id, None) is not None
# ---------------------------------------------------------------------------
# 請求處理
# ---------------------------------------------------------------------------

CLIENT_ID_RE = re.compile(r"[^A-Za-z0-9_\-.|@: ]+")


def normalize_client(value: str | None) -> str:
    if not value:
        return "human"
    cleaned = CLIENT_ID_RE.sub("", str(value).strip())[:64].strip()
    return cleaned or "human"


def client_is_agent(client: str) -> bool:
    lowered = client.lower()
    return lowered.startswith("agent") or lowered.startswith("mcp")


class BattleEditorHandler(BaseHTTPRequestHandler):
    server_version = "DRBattleEditor/1.1"
    protocol_version = "HTTP/1.1"

    # ------------------------------------------------------------ 基礎工具
    def log_message(self, fmt: str, *args):  # noqa: A003 - BaseHTTPRequestHandler API
        if getattr(self.server, "quiet", False):
            return
        sys.stderr.write("[%s] %s\n" % (time.strftime("%H:%M:%S"), fmt % args))

    @property
    def app(self) -> "AppState":
        return self.server.app  # type: ignore[attr-defined]

    def _send_bytes(self, status: int, body: bytes, content_type: str, extra: dict | None = None):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        for key, val in (extra or {}).items():
            self.send_header(key, val)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def _send_json(self, status: int, payload, extra: dict | None = None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self._send_bytes(status, body, "application/json; charset=utf-8", extra)

    def _send_error_json(self, status: int, message: str, extra: dict | None = None, **fields):
        payload = {"ok": False, "error": message}
        payload.update(fields)
        self._send_json(status, payload, extra)

    # ------------------------------------------------------------ 請求主體
    def _read_body(self, limit: int = MAX_PUT_BYTES) -> tuple[bytes | None, str | None, int]:
        """讀 Content-Length 指定的內容；回傳 (bytes, error, status)。"""
        raw_len = self.headers.get("Content-Length")
        if raw_len is None:
            return None, "請求需要 Content-Length", HTTPStatus.LENGTH_REQUIRED
        try:
            length = int(raw_len)
        except ValueError:
            return None, "Content-Length 不是整數", HTTPStatus.BAD_REQUEST
        if length < 0 or length > limit:
            return None, f"內容大小 {length} 超出上限 {limit}", HTTPStatus.REQUEST_ENTITY_TOO_LARGE
        body = self.rfile.read(length) if length else b""
        if len(body) != length:
            return None, "請求內容短於 Content-Length", HTTPStatus.BAD_REQUEST
        return body, None, HTTPStatus.OK

    def _parse_json_body(self) -> tuple[object | None, str | None, int]:
        body, err, status = self._read_body()
        if err:
            return None, err, status
        try:
            text = body.decode("utf-8-sig")
        except UnicodeDecodeError:
            return None, "內容必須是 UTF-8 編碼", HTTPStatus.BAD_REQUEST
        if not text.strip():
            return None, "內容是空的", HTTPStatus.BAD_REQUEST
        try:
            return json.loads(text), None, HTTPStatus.OK
        except (ValueError, RecursionError) as exc:
            return None, f"JSON 解析失敗：{exc}", HTTPStatus.BAD_REQUEST

    # ------------------------------------------------------------ 識別
    @property
    def client(self) -> str:
        return normalize_client(self.headers.get("X-Client"))

    def _if_match_candidates(self):
        return parse_if_match_header(self.headers.get("If-Match"))

    # ------------------------------------------------------------ 路由
    def do_GET(self):  # noqa: N802
        self._handle_read(head=False)

    def do_HEAD(self):  # noqa: N802
        self._handle_read(head=True)

    def _handle_read(self, head: bool):
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)

        if path in ("/api/events", "/api/events/"):
            if head:
                self._send_error_json(HTTPStatus.METHOD_NOT_ALLOWED, "SSE 端點不支援 HEAD")
            else:
                self._sse_stream()
            return
        if path in ("/api", "/api/"):
            self._api_index()
            return
        if path in ("/api/info", "/api/info/"):
            self._api_info()
            return
        if path == "/api/assets/search" or path == "/api/assets/search/":
            self._api_assets_search(query)
            return
        if path in ("/assets/index.json", "/assets/index.json/"):
            self._serve_assets_index(head)
            return
        if path.startswith("/api/schema"):
            self._api_schema(path)
            return
        if path.startswith("/api/editor/state"):
            self._api_editor_state_get(path, query)
            return
        if path.startswith("/api/history"):
            self._api_history_get(path, query)
            return
        if path.startswith("/api/trash"):
            self._api_trash(query)
            return

        try:
            name, err, spec = parse_resource_path(self.path, self.app.resources)
        except (UnicodeDecodeError, ValueError):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "路徑編碼錯誤")
            return
        if err:
            self._send_error_json(HTTPStatus.BAD_REQUEST, err)
            return
        if spec is not None:
            kind = self._kind_of(spec)
            if name == "":
                self._api_list(kind)
            else:
                self._api_get(kind, name)
            return
        self._serve_static(self.path)

    def _kind_of(self, spec: dict) -> str:
        for kind, entry in self.app.resources.items():
            if entry is spec:
                return kind
        # 以 prefix 反查（測試可能複製 dict）
        prefix = spec.get("prefix")
        for kind, entry in self.app.resources.items():
            if entry["prefix"] == prefix:
                return kind
        raise KeyError("未知資源")

    def do_PUT(self):  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path.startswith("/api/editor/state"):
            self._api_editor_state_put(parsed)
            return
        name, err, spec = parse_resource_path(self.path, self.app.resources)
        if err:
            self._send_error_json(HTTPStatus.BAD_REQUEST, err)
            return
        if spec is not None:
            kind = self._kind_of(spec)
            if name == "":
                self._send_error_json(HTTPStatus.BAD_REQUEST, f"PUT 需要指定{spec['label']}檔名")
            else:
                self._api_put(kind, name)
            return
        self._send_error_json(HTTPStatus.NOT_FOUND, "此路徑不支援 PUT")

    def do_PATCH(self):  # noqa: N802
        name, err, spec = parse_resource_path(self.path, self.app.resources)
        if err:
            self._send_error_json(HTTPStatus.BAD_REQUEST, err)
            return
        if spec is None:
            self._send_error_json(HTTPStatus.NOT_FOUND, "此路徑不支援 PATCH")
            return
        if name == "":
            self._send_error_json(HTTPStatus.BAD_REQUEST, "PATCH 需要指定檔名")
            return
        self._api_patch(self._kind_of(spec), name)

    def do_DELETE(self):  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        if parsed.path.startswith("/api/editor/state"):
            self._api_editor_state_delete(parsed)
            return
        name, err, spec = parse_resource_path(self.path, self.app.resources)
        if err:
            self._send_error_json(HTTPStatus.BAD_REQUEST, err)
            return
        if spec is None:
            self._send_error_json(HTTPStatus.NOT_FOUND, "此路徑不支援 DELETE")
            return
        if name == "":
            self._send_error_json(HTTPStatus.BAD_REQUEST, "DELETE 需要指定檔名")
            return
        self._api_delete(self._kind_of(spec), name)

    def do_POST(self):  # noqa: N802
        parsed = urllib.parse.urlsplit(self.path)
        path = parsed.path
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        if path in ("/api/restore", "/api/restore/"):
            self._api_restore()
            return
        if path in ("/api/export/game", "/api/export/game/"):
            self._api_export_game()
            return
        if path in ("/api/pack/export", "/api/pack/export/"):
            self._api_pack_export()
            return
        if path in ("/api/pack/import", "/api/pack/import/"):
            self._api_pack_import(query)
            return
        if path.startswith("/api/history/") and path.rstrip("/").endswith("/restore"):
            entry_id = path[len("/api/history/"):].rstrip("/")[: -len("/restore")].strip("/")
            self._api_history_restore(urllib.parse.unquote(entry_id))
            return
        self._send_error_json(HTTPStatus.NOT_FOUND, "此路徑不支援 POST")

    def do_OPTIONS(self):  # noqa: N802
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Allow", ALLOWED_METHODS)
        self.send_header("Content-Length", "0")
        self.end_headers()

    # ------------------------------------------------------------ 資源 API
    def _api_list(self, kind: str):
        spec = self.app.spec(kind)
        folder: Path = spec["dir"]
        folder.mkdir(parents=True, exist_ok=True)
        items = []
        for path in sorted(folder.glob("*.json")):
            if not path.is_file() or not NAME_RE.match(path.stem):
                continue
            try:
                stat = path.stat()
                raw = path.read_bytes()
            except OSError:
                continue
            etag = sha256_hex(raw)
            meta_name = None
            duration = None
            extra: dict = {}
            try:
                data = json.loads(raw.decode("utf-8-sig"))
                if isinstance(data, dict):
                    meta = data.get("meta")
                    if isinstance(meta, dict):
                        meta_name = meta.get("name")
                    settings = data.get("settings")
                    if isinstance(settings, dict):
                        duration = settings.get("duration")
                    if isinstance(data.get("turns"), list):
                        extra["turns"] = len(data["turns"])
                    if isinstance(data.get("enemies"), list):
                        extra["enemies"] = len(data["enemies"])
            except (UnicodeDecodeError, json.JSONDecodeError):
                pass
            item = {
                "name": path.stem,
                "metaName": meta_name,
                "size": stat.st_size,
                "modified": int(stat.st_mtime * 1000),
                "duration": duration,
                "etag": etag,
            }
            item.update(extra)
            items.append(item)
        payload = {"ok": True, "items": items, "kind": kind, "count": len(items)}
        if spec["collection"] == "attacks":
            payload["attacks"] = items  # Phase 1 相容
        self._send_json(HTTPStatus.OK, payload)

    def _api_get(self, kind: str, name: str):
        spec = self.app.spec(kind)
        found = self.app.read_resource(kind, name)
        if found is None:
            self._send_error_json(
                HTTPStatus.NOT_FOUND,
                f"找不到{spec['label']}檔：{name}",
                kind=kind,
                name=name,
            )
            return
        raw, etag = found
        ascii_name = name.encode("ascii", "replace").decode("ascii").replace('"', "_")
        disposition = 'inline; filename="%s.json"' % ascii_name
        if ascii_name != name:
            disposition += "; filename*=UTF-8''%s.json" % urllib.parse.quote(name, safe="")
        self._send_bytes(
            HTTPStatus.OK,
            raw,
            "application/json; charset=utf-8",
            extra={
                "Content-Disposition": disposition,
                "ETag": etag_header_value(etag),
                "X-Etag": etag,
                "X-Kind": kind,
            },
        )

    def _check_if_match(self, current_etag: str | None) -> tuple[bool, str | None]:
        """回 (是否通過, 錯誤訊息)。沒有 If-Match 一律放行（相容 Phase 1/2）。"""
        candidates = self._if_match_candidates()
        if candidates is None:
            return True, None
        if etag_matches(current_etag, candidates):
            return True, None
        return False, "If-Match 與目前版本不符（資源已被修改）"

    def _respond_conflict(self, kind: str, name: str, current: bytes | None, current_etag: str | None, message: str):
        payload = {
            "ok": False,
            "error": message,
            "conflict": True,
            "kind": kind,
            "name": name,
            "etag": current_etag,
        }
        if current is not None:
            try:
                payload["current"] = json.loads(current.decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                payload["currentRaw"] = current.decode("utf-8", errors="replace")
        else:
            payload["current"] = None
        extra = {"ETag": etag_header_value(current_etag)} if current_etag else None
        self._send_json(HTTPStatus.CONFLICT, payload, extra)

    def _validate_document(self, payload, kind: str, name: str) -> tuple[dict | None, str | None]:
        spec = self.app.spec(kind)
        if not isinstance(payload, dict):
            return None, f"{spec['label']}檔根節點必須是 JSON 物件"
        fmt = payload.get("format")
        if fmt is not None and fmt != spec["format"]:
            return None, f"format 必須是 {spec['format']}（收到 {fmt!r}）"
        result = dict(payload)
        result.setdefault("format", spec["format"])
        if not isinstance(result.get("meta"), dict):
            result["meta"] = {"name": name, "author": ""}
        return result, None

    @contextmanager
    def _resource_mutation(self, kind: str, name: str):
        with self.app.io_lock:
            path = self.app.resource_path(kind, name)
            lock = self.app.data_root / IMPORT_LOCK
            try:
                if path.parent.resolve() != path.parent or path.is_symlink():
                    self._send_error_json(HTTPStatus.CONFLICT, "作品路徑不能是連結")
                    yield False
                    return
                lock.mkdir()
            except FileExistsError:
                self._send_error_json(HTTPStatus.CONFLICT, "作品正在被另一個程序寫入", code="import_busy")
                yield False
                return
            except (OSError, RuntimeError) as exc:
                self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"無法開啟作品寫入：{exc}")
                yield False
                return
            try:
                yield True
            finally:
                lock.rmdir()

    def _encode_save(self, document) -> bytes | None:
        try:
            return canonical_bytes(document)
        except (ValueError, RecursionError) as exc:
            self._send_error_json(HTTPStatus.BAD_REQUEST, f"作品無法存成 UTF-8 JSON：{exc}")
            return None

    def _api_put(self, kind: str, name: str):
        payload, err, status = self._parse_json_body()
        if err:
            self._send_error_json(status, err)
            return
        document, err = self._validate_document(payload, kind, name)
        if err:
            self._send_error_json(HTTPStatus.BAD_REQUEST, err)
            return

        with self._resource_mutation(kind, name) as ready:
            if not ready:
                return
            existing = self.app.read_resource(kind, name)
            current_etag = existing[1] if existing else None
            if existing and self.headers.get("If-None-Match", "").strip() == "*":
                self._respond_conflict(kind, name, existing[0], current_etag, "同名作品已存在")
                return
            ok, conflict = self._check_if_match(current_etag)
            if not ok:
                self._respond_conflict(
                    kind, name, existing[0] if existing else None, current_etag, conflict or "版本衝突"
                )
                return
            data = self._encode_save(document)
            if data is None:
                return
            new_etag = sha256_hex(data)
            if existing and current_etag == new_etag:
                # 內容沒變：不寫檔、不記歷史，直接回 200（冪等 PUT）
                self._send_json(
                    HTTPStatus.OK,
                    {
                        "ok": True,
                        "name": name,
                        "size": len(data),
                        "path": f"{self.app.spec(kind)['collection']}/{name}.json",
                        "etag": new_etag,
                        "previousEtag": current_etag,
                        "unchanged": True,
                    },
                    {"ETag": etag_header_value(new_etag)},
                )
                return
            try:
                self.app.store_previous_version(existing[0] if existing else None, current_etag)
                self.app.write_resource(kind, name, data, new_etag)
            except OSError as exc:
                self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"寫入失敗：{exc}")
                return
            self.app.audit(
                client=self.client,
                method="PUT",
                kind=kind,
                name=name,
                before_etag=current_etag,
                after_etag=new_etag,
                action="create" if existing is None else "update",
                size=len(data),
            )
            self.app.emit_event(
                "changed",
                kind,
                name,
                etag=new_etag,
                previousEtag=current_etag,
                by=self.client,
                size=len(data),
                action="create" if existing is None else "update",
            )
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "name": name,
                    "size": len(data),
                    "path": f"{self.app.spec(kind)['collection']}/{name}.json",
                    "etag": new_etag,
                    "previousEtag": current_etag,
                },
                {"ETag": etag_header_value(new_etag)},
            )

    def _api_patch(self, kind: str, name: str):
        body, err, status = self._parse_json_body()
        if err:
            self._send_error_json(status, err)
            return
        if isinstance(body, list):
            ops = body
        elif isinstance(body, dict):
            candidate = body.get("ops")
            if candidate is None:
                candidate = body.get("patch")
            if candidate is None:
                self._send_error_json(
                    HTTPStatus.BAD_REQUEST, "PATCH 內容必須是 JSON Patch 陣列，或 {'ops': [...]}"
                )
                return
            ops = candidate
        else:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "PATCH 內容必須是 JSON Patch 陣列")
            return

        with self._resource_mutation(kind, name) as ready:
            if not ready:
                return
            existing = self.app.read_resource(kind, name)
            if existing is None:
                self._send_error_json(
                    HTTPStatus.NOT_FOUND,
                    f"找不到{self.app.spec(kind)['label']}檔：{name}",
                    kind=kind,
                    name=name,
                )
                return
            raw, current_etag = existing
            ok, conflict = self._check_if_match(current_etag)
            if not ok:
                self._respond_conflict(kind, name, raw, current_etag, conflict or "版本衝突")
                return
            try:
                document = json.loads(raw.decode("utf-8-sig"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                self._send_error_json(
                    HTTPStatus.INTERNAL_SERVER_ERROR, f"磁碟上的檔案不是合法 JSON：{exc}"
                )
                return
            try:
                patched, summary = apply_json_patch(document, ops)
            except PatchError as exc:
                # test 條件不符在語意上是「版本衝突」（SPEC：409），其餘是請求格式錯誤（400）
                if exc.conflict:
                    self._respond_conflict(kind, name, raw, current_etag, exc.message)
                    return
                self._send_json(
                    HTTPStatus.BAD_REQUEST,
                    {
                        "ok": False,
                        "error": f"JSON Patch 失敗：{exc.message}",
                        "opIndex": exc.op_index,
                        "op": exc.op_name,
                        "path": exc.path,
                    },
                )
                return
            validated, verr = self._validate_document(patched, kind, name)
            if verr:
                self._send_error_json(HTTPStatus.BAD_REQUEST, "套用後的檔案不合法：" + verr)
                return
            data = self._encode_save(validated)
            if data is None:
                return
            new_etag = sha256_hex(data)
            try:
                self.app.store_previous_version(raw, current_etag)
                self.app.write_resource(kind, name, data, new_etag)
            except OSError as exc:
                self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"寫入失敗：{exc}")
                return
            self.app.audit(
                client=self.client,
                method="PATCH",
                kind=kind,
                name=name,
                before_etag=current_etag,
                after_etag=new_etag,
                action="patch",
                patch=summary,
                size=len(data),
            )
            self.app.emit_event(
                "changed",
                kind,
                name,
                etag=new_etag,
                previousEtag=current_etag,
                by=self.client,
                size=len(data),
                action="patch",
            )
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "name": name,
                    "etag": new_etag,
                    "previousEtag": current_etag,
                    "size": len(data),
                    "ops": len(summary),
                    "patch": summary,
                },
                {"ETag": etag_header_value(new_etag)},
            )

    def _api_delete(self, kind: str, name: str):
        with self._resource_mutation(kind, name) as ready:
            if not ready:
                return
            existing = self.app.read_resource(kind, name)
            if existing is None:
                self._send_error_json(
                    HTTPStatus.NOT_FOUND,
                    f"找不到{self.app.spec(kind)['label']}檔：{name}",
                    kind=kind,
                    name=name,
                )
                return
            raw, current_etag = existing
            ok, conflict = self._check_if_match(current_etag)
            if not ok:
                self._respond_conflict(kind, name, raw, current_etag, conflict or "版本衝突")
                return
            try:
                self.app.store_previous_version(raw, current_etag)
                entry = self.app.trash.move_to_trash(kind, name, raw)
                self.app.resource_path(kind, name).unlink()
            except OSError as exc:
                self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"移到垃圾桶失敗：{exc}")
                return
            self.app.watcher.note_delete(kind, name)
            self.app.audit(
                client=self.client,
                method="DELETE",
                kind=kind,
                name=name,
                before_etag=current_etag,
                after_etag=None,
                action="delete",
                size=len(raw),
                extra={"trashId": entry["id"], "trashPath": entry["path"]},
            )
            self.app.emit_event(
                "deleted",
                kind,
                name,
                etag=None,
                previousEtag=current_etag,
                by=self.client,
                trashId=entry["id"],
            )
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "name": name,
                    "kind": kind,
                    "etag": current_etag,
                    "trash": entry,
                    "restore": {
                        "method": "POST",
                        "path": "/api/restore",
                        "body": {"trashId": entry["id"]},
                    },
                },
            )

    # ------------------------------------------------------------ 還原
    def _restore_payload(self, target_kind: str, name: str, raw: bytes, etag: str | None, *, overwrite: bool) -> None:
        with self._resource_mutation(target_kind, name) as ready:
            if not ready:
                return
            existing = self.app.read_resource(target_kind, name)
            if existing is not None and not overwrite:
                ok, _ = self._check_if_match(existing[1])
                if ok and self._if_match_candidates() is None:
                    self._respond_conflict(
                        target_kind,
                        name,
                        existing[0],
                        existing[1],
                        "還原目標已存在；請帶 overwrite=true 或 If-Match",
                    )
                    return
                if not ok:
                    self._respond_conflict(
                        target_kind, name, existing[0], existing[1], "If-Match 與目前版本不符"
                    )
                    return
            new_etag = sha256_hex(raw)
            try:
                self.app.store_previous_version(existing[0] if existing else None, existing[1] if existing else None)
                self.app.write_resource(target_kind, name, raw, new_etag)
            except OSError as exc:
                self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"還原寫入失敗：{exc}")
                return
            self.app.audit(
                client=self.client,
                method="POST",
                kind=target_kind,
                name=name,
                before_etag=existing[1] if existing else None,
                after_etag=new_etag,
                action="restore",
                size=len(raw),
            )
            self.app.emit_event(
                "changed",
                target_kind,
                name,
                etag=new_etag,
                previousEtag=existing[1] if existing else None,
                by=self.client,
                action="restore",
            )
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "kind": target_kind,
                    "name": name,
                    "etag": new_etag,
                    "previousEtag": existing[1] if existing else None,
                    "size": len(raw),
                    "path": f"{self.app.spec(target_kind)['collection']}/{name}.json",
                },
                {"ETag": etag_header_value(new_etag)},
            )

    def _api_restore(self):
        payload, err, status = self._parse_json_body()
        if err:
            self._send_error_json(status, err)
            return
        if not isinstance(payload, dict):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "內容必須是 JSON 物件")
            return
        overwrite = bool(payload.get("overwrite"))
        trash_id = payload.get("trashId") or payload.get("trash") or payload.get("id")
        if trash_id:
            found = self.app.trash.find(str(trash_id), payload.get("kind"))
            if found is None:
                self._send_error_json(HTTPStatus.NOT_FOUND, f"垃圾桶沒有這一筆：{trash_id}")
                return
            item, path = found
            try:
                raw = path.read_bytes()
            except OSError as exc:
                self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"讀取垃圾桶檔案失敗：{exc}")
                return
            self._restore_payload(str(item["kind"]), str(item["name"]), raw, None, overwrite=overwrite)
            return
        # 從歷史 blob 還原：{kind, name, etag}
        kind = payload.get("kind")
        name = payload.get("name")
        etag = payload.get("etag") or payload.get("beforeEtag")
        if kind not in self.app.resources or not isinstance(name, str) or not valid_resource_name(name):
            self._send_error_json(
                HTTPStatus.BAD_REQUEST,
                "需要 trashId，或 {kind: attack|encounter, name, etag} 以從歷史版本還原",
            )
            return
        if not isinstance(etag, str):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "缺少 etag（要還原的版本）")
            return
        raw = self.app.history.read_blob(etag)
        if raw is None:
            self._send_error_json(
                HTTPStatus.NOT_FOUND, f"歷史版本不存在：{etag}（history/blobs/{etag}.json）"
            )
            return
        # 指定「還原到某個歷史版本」本身就是明確的覆寫意圖，預設覆寫（仍會記錄 beforeEtag 供再還原）
        self._restore_payload(kind, name, raw, etag, overwrite=bool(payload.get("overwrite", True)))

    def _api_history_restore(self, entry_id: str):
        if not entry_id:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "缺少歷史紀錄 id")
            return
        entry = self.app.history.find(entry_id)
        if entry is None:
            self._send_error_json(HTTPStatus.NOT_FOUND, f"找不到歷史紀錄：{entry_id}")
            return
        kind = entry.get("kind")
        name = entry.get("name")
        if kind not in self.app.resources or not isinstance(name, str):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "此歷史紀錄沒有對應的作品檔")
            return
        target_etag = entry.get("beforeEtag")
        raw = self.app.history.read_blob(target_etag) if isinstance(target_etag, str) else None
        if raw is None:
            target_etag = entry.get("afterEtag")
            raw = self.app.history.read_blob(target_etag) if isinstance(target_etag, str) else None
            fallback = "afterEtag"
        else:
            fallback = "beforeEtag"
        if raw is None:
            self._send_error_json(
                HTTPStatus.NOT_FOUND,
                f"歷史紀錄 {entry_id} 沒有可用的版本內容（history/blobs 缺檔）",
                entry=entry,
            )
            return
        self._restore_payload(kind, name, raw, target_etag, overwrite=True)

    # ------------------------------------------------------------ 歷史查詢
    def _api_history_get(self, path: str, query: dict):
        rest = path[len("/api/history"):].strip("/")
        if rest:
            entry_id = urllib.parse.unquote(rest)
            entry = self.app.history.find(entry_id)
            if entry is None:
                self._send_error_json(HTTPStatus.NOT_FOUND, f"找不到歷史紀錄：{entry_id}")
                return
            payload = {
                "ok": True,
                "entry": entry,
                "blobs": {
                    "before": self.app.history.read_blob(entry.get("beforeEtag")) is not None,
                    "after": self.app.history.read_blob(entry.get("afterEtag")) is not None,
                },
            }
            self._send_json(HTTPStatus.OK, payload)
            return
        kind = (query.get("kind") or [""])[0] or None
        name = (query.get("name") or [""])[0] or None
        client = (query.get("client") or [""])[0] or None
        day = (query.get("day") or [""])[0] or None
        limit = clamp_int((query.get("limit") or ["50"])[0], HISTORY_DEFAULT_LIMIT, 1, HISTORY_MAX_LIMIT)
        if kind is not None and kind not in self.app.resources:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "kind 必須是 attack 或 encounter")
            return
        items = self.app.history.query(kind=kind, name=name, client=client, limit=limit, day=day)
        self._send_json(
            HTTPStatus.OK,
            {"ok": True, "items": items, "count": len(items), "limit": limit},
        )

    # ------------------------------------------------------------ 垃圾桶
    def _api_trash(self, query: dict):
        kind = (query.get("kind") or [""])[0] or None
        if kind is not None and kind not in self.app.resources:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "kind 必須是 attack 或 encounter")
            return
        items = self.app.trash.entries(kind)
        for item in items:
            item["restore"] = {"method": "POST", "path": "/api/restore", "body": {"trashId": item["id"]}}
        self._send_json(HTTPStatus.OK, {"ok": True, "items": items, "count": len(items), "kind": kind})

    # ------------------------------------------------------------ 素材搜尋
    def _api_assets_search(self, query: dict):
        text = (query.get("q") or [""])[0]
        tag = (query.get("tag") or [""])[0]
        kind = ((query.get("kind") or [""])[0] or "").strip().lower()
        limit = clamp_int(
            (query.get("limit") or [str(ASSETS_SEARCH_DEFAULT_LIMIT)])[0],
            ASSETS_SEARCH_DEFAULT_LIMIT,
            1,
            ASSETS_SEARCH_MAX_LIMIT,
        )
        allowed = {"", "sprite", "audio", "font", "preset", "sfx", "music"}
        if kind not in allowed:
            self._send_error_json(
                HTTPStatus.BAD_REQUEST,
                "kind 必須是 sprite、audio、font 或 preset（audio 可再細分 sfx / music）",
            )
            return
        items = self.app.assets.search(text=text, tag=tag, kind=kind, limit=limit)
        self._send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "query": {"q": text, "tag": tag, "kind": kind, "limit": limit},
                "count": len(items),
                "items": items,
            },
        )

    # ------------------------------------------------------------ Schema
    def _api_schema(self, path: str):
        rest = path[len("/api/schema"):].strip("/")
        schema_dir = self.app.root / "generated" / "schema"
        if not rest:
            available = []
            try:
                available = sorted(p.stem for p in schema_dir.glob("*.json") if p.is_file())
            except OSError:
                pass
            self._send_json(
                HTTPStatus.OK,
                {
                    "ok": True,
                    "available": available,
                    "expected": list(CUE_SCHEMA_NAMES),
                    "directory": "generated/schema",
                },
            )
            return
        name = urllib.parse.unquote(rest)
        if name not in CUE_SCHEMA_NAMES:
            self._send_error_json(
                HTTPStatus.NOT_FOUND, f"沒有這個 schema：{name}（可用：{'、'.join(CUE_SCHEMA_NAMES)}）"
            )
            return
        target = schema_dir / f"{name}.json"
        try:
            raw = target.read_bytes()
        except OSError:
            self._send_error_json(
                HTTPStatus.NOT_FOUND,
                f"schema 尚未產生：generated/schema/{name}.json",
                hint=(
                    "由 Node 端產生：在 battle-editor/ 下執行 node tools/agent/export-schema.mjs "
                    "（或 engine/schema-export.js 的對應入口），輸出到 battle-editor/generated/schema/"
                ),
                expected=["generated/schema/attack.json", "generated/schema/encounter.json", "generated/schema/cues.json"],
            )
            return
        extra = {"ETag": etag_header_value(sha256_hex(raw))}
        self._send_bytes(HTTPStatus.OK, raw, "application/json; charset=utf-8", extra)

    # ------------------------------------------------------------ 編輯器狀態
    def _api_editor_state_get(self, path: str, query: dict):
        rest = path[len("/api/editor/state"):].strip("/")
        if rest:
            cid = urllib.parse.unquote(rest)
            for record in self.app.editor_list():
                if record["clientId"] == cid:
                    self._send_json(HTTPStatus.OK, {"ok": True, "item": record})
                    return
            self._send_error_json(HTTPStatus.NOT_FOUND, f"沒有這個編輯器：{cid}")
            return
        wanted = (query.get("clientId") or [""])[0]
        items = self.app.editor_list()
        if wanted:
            items = [item for item in items if item["clientId"] == wanted]
        self._send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "items": items,
                "count": len(items),
                "ttlMs": EDITOR_STATE_TTL_MS,
                "now": now_ms(),
            },
        )

    def _api_editor_state_put(self, parsed):
        payload, err, status = self._parse_json_body()
        if err:
            self._send_error_json(status, err)
            return
        if not isinstance(payload, dict):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "內容必須是 JSON 物件")
            return
        client_id = self.headers.get("X-Client") if self.headers.get("X-Client") else None
        record = self.app.editor_report(client_id, payload)
        emitted = False
        focus = payload.get("focus")
        if isinstance(focus, dict) and focus:
            self.app.emit_event(
                "focus",
                None,
                None,
                clientId=record["clientId"],
                by=record["clientId"],
                focus=focus,
            )
            emitted = True
        self._send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "clientId": record["clientId"],
                "updatedMs": record["updatedMs"],
                "updatedAt": record["updatedAt"],
                "focusEmitted": emitted,
                "subscribers": self.app.sse.subscriber_count,
            },
        )

    def _api_editor_state_delete(self, parsed):
        path = parsed.path
        rest = path[len("/api/editor/state"):].strip("/")
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)
        cid = urllib.parse.unquote(rest) if rest else (query.get("clientId") or [""])[0]
        if not cid:
            self._send_error_json(HTTPStatus.BAD_REQUEST, "需要 clientId（路徑或查詢字串）")
            return
        removed = self.app.editor_remove(cid)
        self._send_json(
            HTTPStatus.OK if removed else HTTPStatus.NOT_FOUND,
            {"ok": removed, "clientId": cid, **({} if removed else {"error": f"沒有這個編輯器：{cid}"})},
        )

    # ------------------------------------------------------------ API 目錄
    def _api_index(self):
        endpoints = [
            {"method": "GET", "path": "/api/attacks", "desc": "列出攻擊檔（含 etag）"},
            {"method": "GET", "path": "/api/attacks/<name>.json", "desc": "讀攻擊檔（回應帶 ETag）"},
            {"method": "PUT", "path": "/api/attacks/<name>.json", "desc": "整檔寫入（If-Match 樂觀鎖）"},
            {"method": "PATCH", "path": "/api/attacks/<name>.json", "desc": "RFC 6902 JSON Patch（If-Match）"},
            {"method": "DELETE", "path": "/api/attacks/<name>.json", "desc": "移到 trash/（可還原）"},
            {"method": "GET", "path": "/api/encounters", "desc": "列出遭遇檔（含 etag）"},
            {"method": "GET", "path": "/api/encounters/<name>.json", "desc": "讀遭遇檔（回應帶 ETag）"},
            {"method": "PUT", "path": "/api/encounters/<name>.json", "desc": "整檔寫入（If-Match 樂觀鎖）"},
            {"method": "PATCH", "path": "/api/encounters/<name>.json", "desc": "RFC 6902 JSON Patch（If-Match）"},
            {"method": "DELETE", "path": "/api/encounters/<name>.json", "desc": "移到 trash/（可還原）"},
            {
                "method": "GET",
                "path": "/api/events",
                "desc": "SSE：具名事件 event: changed|deleted|focus（另有 hello；心跳註解每 15 秒）",
            },
            {"method": "GET", "path": "/api/history?kind=&name=&client=&limit=", "desc": "審計紀錄"},
            {"method": "GET", "path": "/api/history/<id>", "desc": "單筆審計紀錄"},
            {"method": "POST", "path": "/api/history/<id>/restore", "desc": "還原到該筆之前的版本"},
            {"method": "GET", "path": "/api/trash?kind=", "desc": "垃圾桶清單"},
            {"method": "POST", "path": "/api/restore", "desc": "{trashId} 或 {kind,name,etag}"},
            {"method": "GET", "path": "/api/assets/search?q=&tag=&kind=&limit=", "desc": "素材搜尋"},
            {"method": "GET", "path": "/api/schema/<attack|encounter|cues>", "desc": "JSON Schema"},
            {"method": "GET", "path": "/api/editor/state", "desc": "開著的編輯器狀態"},
            {"method": "PUT", "path": "/api/editor/state", "desc": "回報狀態；帶 focus 會推 SSE"},
            {"method": "DELETE", "path": "/api/editor/state/<clientId>", "desc": "移除回報"},
            {"method": "GET", "path": "/api/info", "desc": "{root, works, port, version}（works 為作品根，null = 預設草稿區）"},
            {"method": "POST", "path": "/api/pack/export", "desc": "{kind?, name} → .drpack.json（作品包下載）"},
            {"method": "POST", "path": "/api/pack/import?mode=abort|rename|overwrite", "desc": "body = 作品包 → 匯入作品中"},
        ]
        self._send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "server": SERVER_ID,
                "startedAt": iso_now(),
                "resources": list(self.app.resources.keys()),
                "root": str(self.app.root),
                "works": str(self.app.works) if self.app.works else None,
                "endpoints": endpoints,
                "clients": "所有寫入請帶 X-Client: human|agent|<id>",
            },
        )

    # ------------------------------------------------------------ 伺服器資訊
    def _api_info(self):
        self._send_json(
            HTTPStatus.OK,
            {
                "ok": True,
                "root": str(self.app.root),
                "works": str(self.app.works) if self.app.works else None,
                "port": self.server.server_address[1],
                "version": VERSION,
                "serverId": SERVER_ID,
                "dataRoot": str(self.app.data_root),
                "collections": {
                    kind: str(spec["dir"]) for kind, spec in self.app.resources.items()
                },
                "history": str(self.app.history.folder),
                "trash": str(self.app.trash.folder),
                "customAssets": str(self.app.custom_assets_dir),
                "node": NODE_BIN,
            },
        )

    # ------------------------------------------------------------ 作品包
    def _api_pack_export(self):
        body, err, status = self._parse_json_body()
        if err:
            self._send_error_json(status, err)
            return
        if not isinstance(body, dict):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "內容必須是 JSON 物件：{kind?, name}")
            return
        name = body.get("name")
        if not isinstance(name, str) or not name.strip():
            self._send_error_json(HTTPStatus.BAD_REQUEST, "缺少 name（遭遇或攻擊名稱）")
            return
        kind = body.get("kind")
        if kind is not None and kind not in ("attack", "encounter"):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "kind 必須是 attack 或 encounter")
            return
        args = ["export", name.strip()]
        if isinstance(kind, str):
            args += ["--kind", kind]
        # 作品包輸出到單一暫存檔（不建暫存目錄、不做遞歸刪除；用完就 unlink 該檔）
        fd, tmp_name = tempfile.mkstemp(prefix="drpack-export-", suffix=".drpack.json")
        os.close(fd)
        out_path = Path(tmp_name)
        args += ["--out", str(out_path)]
        try:
            with self.app.io_lock:
                payload = self.app.run_pack(args)
            if not payload.get("ok"):
                code = payload.get("code")
                status_code = {
                    "not_found": HTTPStatus.NOT_FOUND,
                    "invalid_name": HTTPStatus.BAD_REQUEST,
                    "bad_request": HTTPStatus.BAD_REQUEST,
                    "bad_file": HTTPStatus.CONFLICT,
                    "missing_attacks": HTTPStatus.CONFLICT,
                    "missing_assets": HTTPStatus.CONFLICT,
                }.get(code, HTTPStatus.INTERNAL_SERVER_ERROR)
                self._send_error_json(status_code, payload.get("error") or "作品包匯出失敗", **{
                    key: value for key, value in payload.items() if key not in ("ok", "error")
                })
                return
            try:
                data = out_path.read_bytes()
            except OSError as exc:
                self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"讀取匯出的作品包失敗：{exc}")
                return
        except PackSubprocessError as exc:
            self._send_error_json(exc.status, exc.message, code="pack_failed", **exc.details)
            return
        finally:
            try:
                out_path.unlink()
            except OSError:
                pass
        ascii_name = name.strip().encode("ascii", "replace").decode("ascii").replace('"', "_")
        filename = f"{ascii_name}.drpack.json"
        disposition = 'attachment; filename="%s"' % filename
        if ascii_name != name.strip():
            disposition += "; filename*=UTF-8''%s" % urllib.parse.quote(
                f"{name.strip()}.drpack.json", safe=""
            )
        extra = {
            "Content-Disposition": disposition,
            "ETag": etag_header_value(sha256_hex(data)),
            "X-Pack-Counts": json.dumps(payload.get("counts") or {}, ensure_ascii=False),
        }
        self._send_bytes(HTTPStatus.OK, data, "application/json; charset=utf-8", extra)

    # ------------------------------------------------------------ 可遊玩 HTML
    def _api_export_game(self):
        body, err, status = self._parse_json_body()
        if err:
            self._send_error_json(status, err)
            return
        if not isinstance(body, dict):
            self._send_error_json(
                HTTPStatus.BAD_REQUEST,
                "內容必須是 JSON 物件：{name, kind?, lang?, title?, autoplayToggle?}",
            )
            return
        name = body.get("name")
        if not isinstance(name, str) or not name.strip():
            self._send_error_json(HTTPStatus.BAD_REQUEST, "缺少 name（遭遇或攻擊名稱）")
            return
        kind = body.get("kind")
        if kind is not None and kind not in ("attack", "encounter"):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "kind 必須是 attack 或 encounter")
            return
        lang = body.get("lang")
        if lang is not None and lang not in ("zh", "en"):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "lang 必須是 zh 或 en")
            return
        title = body.get("title")
        if title is not None and not isinstance(title, str):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "title 必須是字串")
            return
        autoplay_toggle = body.get("autoplayToggle")
        if autoplay_toggle is not None and not isinstance(autoplay_toggle, bool):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "autoplayToggle 必須是布林值")
            return
        # 單一暫存檔；不建暫存目錄、不做遞歸刪除，用完就 unlink 該檔
        fd, tmp_name = tempfile.mkstemp(prefix="drgame-export-", suffix=".html")
        os.close(fd)
        out_path = Path(tmp_name)
        args = [name.strip(), "--out", str(out_path), "--root", str(ROOT_DIR)]
        if isinstance(kind, str):
            args += ["--kind", kind]
        if isinstance(lang, str):
            args += ["--lang", lang]
        if isinstance(title, str) and title.strip():
            args += ["--title", title.strip()[:200]]
        if autoplay_toggle is False:
            args += ["--no-autoplay-toggle"]
        if self.app.works is not None:
            args += ["--works", str(self.app.works)]
        try:
            with self.app.io_lock:
                payload = self.app.run_export_game(args)
            if not payload.get("ok"):
                code = payload.get("code")
                status_code = {
                    "not_found": HTTPStatus.NOT_FOUND,
                    "invalid_name": HTTPStatus.BAD_REQUEST,
                    "bad_request": HTTPStatus.BAD_REQUEST,
                    "bad_file": HTTPStatus.CONFLICT,
                    "missing_attacks": HTTPStatus.CONFLICT,
                    "missing_assets": HTTPStatus.CONFLICT,
                }.get(code, HTTPStatus.INTERNAL_SERVER_ERROR)
                self._send_error_json(
                    status_code,
                    payload.get("error") or "可遊玩 HTML 匯出失敗",
                    **{key: value for key, value in payload.items() if key not in ("ok", "error")},
                )
                return
            try:
                data = out_path.read_bytes()
            except OSError as exc:
                self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"讀取匯出的 HTML 失敗：{exc}")
                return
        except PackSubprocessError as exc:
            self._send_error_json(exc.status, exc.message, code="export_game_failed", **exc.details)
            return
        finally:
            try:
                out_path.unlink()
            except OSError:
                pass
        ascii_name = name.strip().encode("ascii", "replace").decode("ascii").replace('"', "_")
        filename = f"{ascii_name}.html"
        disposition = 'attachment; filename="%s"' % filename
        if ascii_name != name.strip():
            disposition += "; filename*=UTF-8''%s" % urllib.parse.quote(
                f"{name.strip()}.html", safe=""
            )
        extra = {
            "Content-Disposition": disposition,
            "ETag": etag_header_value(sha256_hex(data)),
            "X-Export-Bytes": str(len(data)),
        }
        self._send_bytes(HTTPStatus.OK, data, "text/html; charset=utf-8", extra)

    def _api_pack_import(self, query: dict):
        mode = ((query.get("mode") or ["abort"])[0] or "abort").strip().lower()
        if mode not in ("abort", "rename", "overwrite"):
            self._send_error_json(HTTPStatus.BAD_REQUEST, "mode 必須是 abort、rename 或 overwrite")
            return
        body, err, status = self._read_body(limit=MAX_PACK_BYTES)
        if err:
            self._send_error_json(status, err)
            return
        with self.app.io_lock:
            try:
                payload = self.app.run_pack(["import", "-", "--mode", mode], stdin_bytes=body)
            except PackSubprocessError as exc:
                self._send_error_json(exc.status, exc.message, code="pack_failed", **exc.details)
                return
            if payload.get("ok"):
                for kind, spec in RESOURCE_SPECS.items():
                    for item in payload["imported"][spec["collection"]]:
                        name = item["name"]
                        found = self.app.read_resource(kind, name)
                        if found is None:
                            continue
                        path = self.app.resource_path(kind, name)
                        self.app.watcher.note_change(kind, name, path, found[1])
                        self.app.emit_event("changed", kind, name, etag=found[1], by=self.client, action="import")
                self._send_json(HTTPStatus.OK, payload)
                return
        if payload.get("code") in ("conflicts", "bad_target", "import_busy"):
            self._send_json(HTTPStatus.CONFLICT, payload)
            return
        code = payload.get("code")
        status_code = {
            "bad_request": HTTPStatus.BAD_REQUEST,
            "bad_pack": HTTPStatus.BAD_REQUEST,
            "bad_file": HTTPStatus.BAD_REQUEST,
        }.get(code, HTTPStatus.INTERNAL_SERVER_ERROR)
        self._send_json(status_code, payload)

    # ------------------------------------------------------------ SSE
    def _peer_gone(self) -> bool:
        """非阻塞檢查 SSE 對端是否已關閉（EOF）。客戶端不會送資料，可安全丟棄讀到的位元組。"""
        try:
            ready, _, _ = select.select([self.connection], [], [], 0)
            if not ready:
                return False
            chunk = self.connection.recv(1, socket.MSG_PEEK)
            if not chunk:
                return True
            self.connection.recv(1)  # 丟掉意外的單一位元組，避免 busy loop
            return False
        except (OSError, ValueError):
            return True

    def _sse_stream(self):
        app = self.app
        channel = app.sse.subscribe()
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "text/event-stream; charset=utf-8")
            self.send_header("Cache-Control", "no-cache, no-transform")
            self.send_header("Connection", "keep-alive")
            self.send_header("X-Accel-Buffering", "no")
            self.send_header("Transfer-Encoding", "chunked")
            self.end_headers()

            def write_chunk(payload: bytes):
                self.wfile.write(b"%X\r\n" % len(payload) + payload + b"\r\n")
                self.wfile.flush()

            def send_event(payload: dict, event_name: str | None = None):
                lines = []
                if event_name:
                    lines.append(f"event: {event_name}")
                lines.append("data: " + json.dumps(payload, ensure_ascii=False))
                write_chunk(("\n".join(lines) + "\n\n").encode("utf-8"))

            write_chunk(b"retry: 2000\n\n")
            send_event(
                {
                    "type": "hello",
                    "seq": app.sse.next_seq(),
                    "server": SERVER_ID,
                    "pollIntervalMs": int(app.poll_interval * 1000),
                    "subscribers": app.sse.subscriber_count,
                }
            )
            last_heartbeat = time.monotonic()
            while True:
                # 客戶端斷線時 TCP 只會給 EOF；主動 peek 才能在沒有事件時立刻清掉訂閱
                if self._peer_gone():
                    break
                try:
                    event = channel.get(timeout=1.0)
                except queue.Empty:
                    event = "__idle__"
                if event is None:
                    break
                if event != "__idle__":
                    send_event(event, event_name=event.get("type"))
                    last_heartbeat = time.monotonic()
                    continue
                if time.monotonic() - last_heartbeat >= SSE_HEARTBEAT_SECONDS:
                    write_chunk(b": heartbeat\n\n")
                    last_heartbeat = time.monotonic()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, OSError):
            pass
        finally:
            app.sse.unsubscribe(channel)
            self.close_connection = True
            try:
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError, OSError):
                pass

    # ------------------------------------------------------------ 靜態檔
    def _serve_static(self, raw_path: str):
        parsed = urllib.parse.urlsplit(raw_path)
        url_path = parsed.path
        # 作品根模式：/assets/custom/... 優先從作品根的 assets/custom/ 提供
        custom_root = self.app.custom_assets_dir
        if self.app.works and (url_path == "/assets/custom" or url_path.startswith("/assets/custom/")):
            target = safe_join(custom_root, url_path[len("/assets/custom"):])
            if target is None:
                self._send_error_json(HTTPStatus.FORBIDDEN, "禁止存取此路徑")
                return
            if target.is_dir():
                self._send_error_json(HTTPStatus.NOT_FOUND, "不提供目錄列表")
                return
            if target.is_file():
                try:
                    data = target.read_bytes()
                except OSError as exc:
                    self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"讀取檔案失敗：{exc}")
                    return
                self._send_bytes(HTTPStatus.OK, data, guess_mime(target))
                return
            # 作品根沒有這個檔 → 落回主 repo 的 assets/custom/（例如共用的內建自訂素材）
        if url_path == "/assets" or url_path.startswith("/assets/"):
            target = safe_join(self.app.assets_dir, url_path[len("/assets"):])
        else:
            target = safe_join(self.app.root, url_path)
        if target is None:
            self._send_error_json(HTTPStatus.FORBIDDEN, "禁止存取此路徑")
            return
        if target.is_dir():
            if target == self.app.root.resolve() or url_path in ("", "/"):
                target = self.app.root / "index.html"
            else:
                self._send_error_json(HTTPStatus.NOT_FOUND, "不提供目錄列表")
                return
        if not target.is_file() and url_path == "/favicon.ico":
            # 瀏覽器不管 <link rel="icon"> 怎麼寫都會另外要 /favicon.ico；沒有 .ico 檔就回 favicon.svg，
            # 免得每一頁都在 console／伺服器日誌留一條 404（REALTEST-2 V12）。
            svg = self.app.root / "favicon.svg"
            if svg.is_file():
                target = svg
        if not target.is_file():
            self._send_error_json(HTTPStatus.NOT_FOUND, f"找不到檔案：{url_path}")
            return
        try:
            data = target.read_bytes()
        except OSError as exc:
            self._send_error_json(HTTPStatus.INTERNAL_SERVER_ERROR, f"讀取檔案失敗：{exc}")
            return
        self._send_bytes(HTTPStatus.OK, data, guess_mime(target))

    # ------------------------------------------------------------ 合併素材索引
    def _serve_assets_index(self, head: bool):
        """`GET /assets/index.json`：作品根模式動態合併 custom.index.json（不寫回主索引）。"""
        merged = self.app.merged_index_bytes()
        if merged is None:
            self._serve_static("/assets/index.json")
            return
        data, etag = merged
        self._send_bytes(
            HTTPStatus.OK,
            data,
            "application/json; charset=utf-8",
            extra={"ETag": etag_header_value(etag), "X-Custom-Merged": "1", "X-Works": "1"},
        )


class BattleEditorServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address, handler_cls, quiet: bool = False, app: "AppState" | None = None):
        self.app = app if app is not None else AppState(ROOT_DIR)
        self.quiet = quiet
        super().__init__(server_address, handler_cls)

    def server_close(self):
        try:
            self.app.stop()
        finally:
            super().server_close()


def port_in_use(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.4)
        return sock.connect_ex((host, port)) == 0


def main(argv: list[str] | None = None) -> int:
    force_utf8_stdio()
    parser = argparse.ArgumentParser(
        description="DR Battle Editor 開發伺服器（127.0.0.1，僅本機；人與 Agent 同等權限）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"綁定位址（預設 {DEFAULT_HOST}）")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"連接埠（預設 {DEFAULT_PORT}）")
    parser.add_argument("--open", action="store_true", help="啟動後自動開啟瀏覽器")
    parser.add_argument("--quiet", action="store_true", help="不印每個請求的 log")
    parser.add_argument(
        "--poll-interval",
        type=float,
        default=WATCH_POLL_SECONDS,
        help=f"檔案監看輪詢間隔秒（預設 {WATCH_POLL_SECONDS}，上限 0.5）",
    )
    parser.add_argument("--root", default=None, help="專案根目錄（預設本檔所在目錄，測試用）")
    parser.add_argument(
        "--works",
        default=None,
        help=(
            "作品根：其下 attacks/、encounters/、assets/custom/、history/、trash/ 取代預設位置"
            "（也可用環境變數 DR_WORKS；相對路徑以目前工作目錄解析）"
        ),
    )
    parser.add_argument(
        "--assets",
        default=None,
        help="官方素材庫目錄（含 index.json、sprites/、audio/、fonts/；也可用環境變數 DR_ASSETS；預設為程式根的 assets/）",
    )
    args = parser.parse_args(argv)

    if args.host not in ("127.0.0.1", "localhost"):
        print(
            f"[警告] 建議只綁 127.0.0.1（目前 {args.host}）；本伺服器沒有身分驗證。",
            file=sys.stderr,
        )
    if port_in_use(args.host, args.port):
        print(
            f"[錯誤] {args.host}:{args.port} 已被佔用。\n"
            f"        可能是 serve.py 已在執行；或改用 --port 18901。",
            file=sys.stderr,
        )
        return 1

    root = Path(args.root).resolve() if args.root else ROOT_DIR
    works_raw = args.works if args.works else os.environ.get("DR_WORKS") or None
    works = None
    if works_raw:
        works = Path(works_raw).expanduser().resolve()
        if works.exists() and not works.is_dir():
            print(f"[錯誤] --works 指定的不是目錄：{works}", file=sys.stderr)
            return 1
    assets_raw = args.assets or os.environ.get("DR_ASSETS") or None
    assets = None
    if assets_raw:
        assets = Path(assets_raw).expanduser().resolve()
        if not assets.is_dir():
            print(f"[錯誤] --assets 指定的目錄不存在：{assets}", file=sys.stderr)
            return 1
        os.environ["DR_ASSETS"] = str(assets)  # 子程序（作品包、錄影工具）跟著用同一個素材庫
    index_html = root / "index.html"
    encounter_html = root / "encounter.html"
    url = f"http://{args.host}:{args.port}/"

    app = AppState(root, poll_interval=args.poll_interval, works=works, assets=assets)
    try:
        httpd = BattleEditorServer(
            (args.host, args.port), BattleEditorHandler, quiet=args.quiet, app=app
        )
    except OSError as exc:
        print(f"[錯誤] 無法監聽 {args.host}:{args.port}：{exc}", file=sys.stderr)
        return 1
    app.start()

    print("=" * 62)
    print("  DR Battle Editor — 開發伺服器（人與 Agent 同等權限）")
    print("=" * 62)
    print(f"  根目錄   : {root}")
    print(f"  素材目錄 : {app.assets_dir}")
    if works:
        print(f"  作品根   : {works}")
        print(f"  作品資料 : {app.data_root}（attacks/ encounters/ assets/custom/ history/ trash/）")
    print(f"  網址     : {url}")
    print(f"  攻擊編輯 : {url}index.html")
    print(f"  遭遇編輯 : {url}encounter.html")
    print(f"  遭遇試玩 : {url}encounter-play.html")
    print(f"  素材索引 : {url}assets/index.json" + ("（含作品根自訂素材動態合併）" if works else ""))
    print(f"  攻擊 API : {url}api/attacks")
    print(f"  遭遇 API : {url}api/encounters")
    print(f"  事件串流 : {url}api/events（SSE）")
    print(f"  審計紀錄 : {url}api/history")
    print(f"  垃圾桶   : {url}api/trash")
    print(f"  素材搜尋 : {url}api/assets/search?q=heart")
    print(f"  Schema   : {url}api/schema/attack")
    print(f"  編輯器   : {url}api/editor/state")
    print(f"  伺服資訊 : {url}api/info")
    print(f"  作品包   : POST {url}api/pack/export ｜ POST {url}api/pack/import?mode=abort|rename|overwrite")
    print(f"  API 目錄 : {url}api")
    if not index_html.is_file():
        print("  [提醒] 目前還沒有 index.html（由 ED1 負責產生）")
    if not encounter_html.is_file():
        print("  [提醒] 目前還沒有 encounter.html（由 ED1 負責產生）")
    print(f"  檔案監看 : 每 {app.poll_interval:.2f} 秒（資料目錄：{app.data_root}）")
    print("  按 Ctrl+C 結束")
    print("=" * 62)
    sys.stdout.flush()

    if args.open:
        index_url = url + "index.html"
        threading.Timer(0.6, lambda: webbrowser.open(index_url)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[資訊] 收到中斷，正在關閉伺服器…")
    finally:
        httpd.shutdown()
        httpd.server_close()
        print("[資訊] 伺服器已停止")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
