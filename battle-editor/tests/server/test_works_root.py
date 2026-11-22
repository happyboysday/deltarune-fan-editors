"""V2-05 作品根與作品包測試（真正啟動 serve.py 子程序，用另一個埠）。

執行：
    cd battle-editor
    python tests/server/test_works_root.py            # 全部
    python tests/server/test_works_root.py -v         # 逐項
    python -m unittest discover -s tests/server -v    # 同上

設計
----
* 每個 TestCase 用 **臨時作品根**（`%TEMP%\\\\V2-05\\\\<名字>\\\\`，可用環境變數
  `V2_05_TEMP` 覆寫）與**非 18900 的埠**（預設 18931 起；被佔用就往上找下一個），
  以 `subprocess` 真的啟動 `python serve.py`，全部請求走 HTTP，不用 in-process 的 AppState。
* 測完在 `tearDown` 關閉自己啟動的伺服器（`--quiet` + SIGTERM/terminate + 等程序結束）。
* **絕不啟停 18900**：若測試要用的埠是 18900 直接跳過，避免撞到協調者的伺服器。
* 清理不遞歸刪除：只逐檔 unlink，資料夾留給系統清理（`%TEMP%`）。

名詞
----
* 作品根（works root）：`serve.py --works <dir>`，其下 attacks/、encounters/、
  assets/custom/、history/、trash/。
* 預設模式：不給 `--works`，資料在 battle-editor/ 底下（用 `--root` 指向臨時目錄
  就能在不碰真資料的情況下驗證）。
"""

from __future__ import annotations

import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BATTLE_EDITOR = Path(__file__).resolve().parents[2]
SERVE_PY = BATTLE_EDITOR / "serve.py"
PACK_MJS = BATTLE_EDITOR / "tools" / "pack.mjs"
TEMP_BASE = Path(os.environ.get("V2_05_TEMP") or (Path(tempfile.gettempdir()) / "V2-05"))
FORBIDDEN_PORT = 18900
DEFAULT_TEST_PORT = 18931
STARTUP_TIMEOUT = 25.0


# ---------------------------------------------------------------------------
# 工具
# ---------------------------------------------------------------------------


_USED_PORTS: set[int] = set()


def port_is_listening(port: int) -> bool:
    """Windows 的 SO_REUSEADDR 允許兩個 socket 綁同一個埠，光靠 bind 判斷不夠。"""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.2)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def free_port(start: int = DEFAULT_TEST_PORT) -> int:
    """從 start 往上找一個「真的沒人用」的埠（避開 18900 與已配發的埠）。"""
    for port in range(start, start + 200):
        if port == FORBIDDEN_PORT or port in _USED_PORTS:
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
        if port_is_listening(port):
            continue
        _USED_PORTS.add(port)
        return port
    raise RuntimeError(f"找不到可用埠（從 {start} 起）")


def rmtree_safe(root: Path) -> None:
    """逐一刪檔的「安全清理」：不用 shutil.rmtree、不用 rm -r（派工規則禁止遞歸刪除）。

    %TEMP% 下的測試資料夾留著也無害，所以失敗就放棄（只盡力清掉檔案）。
    """
    if not root.exists():
        return
    for path in sorted(root.rglob("*"), key=lambda p: len(p.parts), reverse=True):
        try:
            if path.is_file() or path.is_symlink():
                path.unlink()
            else:
                path.rmdir()
        except OSError:
            pass
    try:
        root.rmdir()
    except OSError:
        pass


class ServerProcess:
    """以 subprocess 啟動 service.py，等到 /api 可以回應。"""

    def __init__(self, *, works: Path | None = None, root: Path | None = None, port: int | None = None,
                 env_extra: dict | None = None, poll_interval: float = 0.15, label: str = "server"):
        self.label = label
        self.works = Path(works) if works else None
        self.root = Path(root) if root else None
        self.port = port if port is not None else free_port()
        if self.port == FORBIDDEN_PORT:  # pragma: no cover - 防呆
            raise RuntimeError("測試不得使用 18900（協調者的伺服器）")
        self.env_extra = env_extra
        self.poll_interval = poll_interval
        self.proc: subprocess.Popen | None = None
        self.log_path = TEMP_BASE / f"{label}-{self.port}.log"

    @property
    def base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def command(self) -> list[str]:
        command = [
            sys.executable,
            str(SERVE_PY),
            "--host",
            "127.0.0.1",
            "--port",
            str(self.port),
            "--quiet",
            "--poll-interval",
            str(self.poll_interval),
        ]
        if self.root is not None:
            command += ["--root", str(self.root)]
        if self.works is not None:
            command += ["--works", str(self.works)]
        return command

    def start(self) -> "ServerProcess":
        env = dict(os.environ)
        env.pop("DR_WORKS", None)  # 測試環境不要被外部 DR_WORKS 汙染
        env["PYTHONIOENCODING"] = "utf-8"
        env["PYTHONUTF8"] = "1"
        if self.env_extra:
            env.update(self.env_extra)
        self.log_path.parent.mkdir(parents=True, exist_ok=True)
        self.log = open(self.log_path, "wb")
        self.proc = subprocess.Popen(  # noqa: S603 - 參數固定
            self.command(),
            cwd=str(BATTLE_EDITOR),
            stdout=self.log,
            stderr=subprocess.STDOUT,
            env=env,
        )
        deadline = time.monotonic() + STARTUP_TIMEOUT
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(
                    f"{self.label} 啟動失敗（exit {self.proc.returncode}）：\n{self.read_log()}"
                )
            try:
                status, _, _ = self.request("GET", "/api")
                if status == 200:
                    return self
            except (urllib.error.URLError, ConnectionError, OSError):
                time.sleep(0.05)
        raise RuntimeError(f"{self.label} 啟動逾時（{STARTUP_TIMEOUT}s）：\n{self.read_log()}")

    def read_log(self) -> str:
        try:
            self.log.flush()
        except (AttributeError, ValueError):
            pass
        try:
            return self.log_path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            return "(無 log)"

    def stop(self) -> None:
        """關閉自己啟動的伺服器（terminate → 等 → kill；不碰 18900）。"""
        proc = self.proc
        if proc is None:
            return
        try:
            if proc.poll() is None:
                proc.send_signal(signal.SIGTERM)
                try:
                    proc.wait(timeout=12)
                except subprocess.TimeoutExpired:
                    proc.kill()
                    proc.wait(timeout=12)
        finally:
            self.proc = None
            try:
                self.log.close()
            except (AttributeError, ValueError):
                pass

    # ------------------------------------------------------------------ HTTP
    def request(self, method: str, path: str, *, body=None, raw_body=None, headers=None,
                timeout: float = 30.0):
        url = self.base + path
        hdrs = dict(headers or {})
        data = raw_body
        if data is None and body is not None:
            data = json.dumps(body, ensure_ascii=False).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        try:
            with urllib.request.urlopen(req, timeout=timeout) as response:
                return response.status, dict(response.headers), response.read()
        except urllib.error.HTTPError as exc:
            return exc.code, dict(exc.headers), exc.read()

    def json_request(self, method: str, path: str, **kwargs):
        status, headers, data = self.request(method, path, **kwargs)
        try:
            parsed = json.loads(data.decode("utf-8")) if data else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            parsed = None
        return status, headers, parsed

    # 常用包裝
    def put_attack(self, name: str, payload: dict | None = None, *, client: str = "human"):
        return self.json_request(
            "PUT",
            f"/api/attacks/{urllib.parse.quote(name)}.json",
            body=payload or attack_doc(name),
            headers={"X-Client": client},
        )

    def get_attack(self, name: str):
        return self.json_request("GET", f"/api/attacks/{urllib.parse.quote(name)}.json")

    def put_encounter(self, name: str, payload: dict | None = None, *, client: str = "human"):
        return self.json_request(
            "PUT",
            f"/api/encounters/{urllib.parse.quote(name)}.json",
            body=payload or encounter_doc(name),
            headers={"X-Client": client},
        )


class SseClient:
    """最小 SSE 讀取器（背景執行緒解析 event/data 區塊）。"""

    def __init__(self, port: int):
        import queue as queue_module
        import threading

        self.port = port
        self.queue = queue_module.Queue()
        self.events: list[dict] = []
        self.raw_lines: list[str] = []
        self.error: str | None = None
        self._stop = threading.Event()
        self.conn = None
        self.conn = self._open()
        self.response = self.conn.getresponse()
        self.status = self.response.status
        self.headers = dict(self.response.getheaders())
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

    def _open(self):
        import http.client

        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=20)
        conn.request("GET", "/api/events", headers={"Accept": "text/event-stream"})
        return conn

    def _pump(self):
        buffer = b""
        data_lines: list[str] = []
        try:
            while not self._stop.is_set():
                chunk = self.response.read(1)
                if not chunk:
                    break
                buffer += chunk
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    text = line.decode("utf-8", errors="replace").rstrip("\r")
                    self.raw_lines.append(text)
                    if text == "":
                        if data_lines:
                            payload = "\n".join(data_lines)
                            data_lines = []
                            try:
                                self.events.append(json.loads(payload))
                            except json.JSONDecodeError:
                                continue
                        continue
                    if text.startswith("data: "):
                        data_lines.append(text[len("data: "):])
                    elif text.startswith("data:"):
                        data_lines.append(text[len("data:"):])
        except Exception as exc:  # noqa: BLE001 - 斷線是測試正常結束路徑
            self.error = f"{type(exc).__name__}: {exc}"

    def wait_for(self, predicate, timeout: float = 8.0):
        deadline = time.monotonic() + timeout
        seen = 0
        while time.monotonic() < deadline:
            while seen < len(self.events):
                event = self.events[seen]
                seen += 1
                if predicate(event):
                    return event
            time.sleep(0.02)
        return None

    def drain(self) -> list[dict]:
        return list(self.events)

    def close(self):
        self._stop.set()
        try:
            if self.conn is not None:
                self.conn.close()
        except Exception:  # noqa: BLE001
            pass
        try:
            self.thread.join(timeout=3)
        except Exception:  # noqa: BLE001
            pass


# ---------------------------------------------------------------------------
# 測試資料
# ---------------------------------------------------------------------------


def attack_doc(name: str, *, sprite: str = "spr_spadebullet") -> dict:
    return {
        "format": "dr-battle-attack/1",
        "meta": {"name": name, "author": "v2-05-test"},
        "settings": {"duration": 6, "seed": 1, "damage": 5, "invincibleFrames": 30, "grazeTP": 1},
        "box": {"x": 320, "y": 300, "w": 200, "h": 140, "rotation": 0, "border": 4, "color": "#00c000"},
        "soul": {"x": 320, "y": 300, "speed": 4, "slowSpeed": 2, "mode": "red", "color": "#ff0000"},
        "party": [],
        "enemies": [],
        "bulletTypes": {
            "spade": {
                "sprite": sprite,
                "frameRate": 0,
                "scale": 1,
                "hitbox": {"shape": "circle", "r": 5},
                "damage": 5,
                "grazeable": True,
            }
        },
        "timeline": [
            {"id": "ev_spawn", "at": 0.5, "type": "spawn", "bullet": "spade", "count": 3, "x": 320, "y": 100},
            {"id": "ev_end", "at": 5, "type": "end"},
        ],
    }


def encounter_doc(name: str, *, attacks: list[str] | None = None) -> dict:
    attacks = attacks or []
    turns = []
    for index, attack in enumerate(attacks):
        turns.append(
            {
                "id": f"t{index + 1}",
                "flavor": f"* attack {attack}",
                "talk": [],
                "attack": attack,
                "start": [],
                "end": [],
            }
        )
    turns.append({"id": f"t{len(turns) + 1}", "flavor": "* done", "talk": [], "attack": None, "start": [], "end": []})
    return {
        "format": "dr-battle-encounter/1",
        "meta": {"name": name, "author": "v2-05-test"},
        "settings": {"seed": 1, "bgm": None, "background": None},
        "actors": {
            "kris": {
                "kind": "party",
                "x": 100,
                "y": 300,
                "anims": {"idle": {"sprite": "spr_krisb_idle", "fps": 5, "loop": True}},
            }
        },
        "party": [
            {
                "id": "kris",
                "actor": "kris",
                "name": "Kris",
                "hp": 90,
                "maxHp": 90,
                "atk": 10,
                "def": 2,
                "color": "#00ffff",
                "commands": ["fight", "act", "item", "spare", "defend"],
            }
        ],
        "enemies": [],
        "items": [],
        "turns": turns,
        "turnOrder": "loop-last",
        "hooks": {},
        "vars": {},
    }


def write_custom_assets(works: Path, *, sprite_name: str = "spr_v205_custom", png: bytes = b"\x89PNG\r\n\x1a\nV205") -> None:
    """在作品根寫一個自訂 sprite（PNG + custom.index.json）。"""
    assets = works / "assets"
    (assets / "custom").mkdir(parents=True, exist_ok=True)
    (assets / "custom" / f"{sprite_name}.png").write_bytes(png)
    index = {
        "format": "dr-battle-assets/1",
        "sprites": {
            sprite_name: {
                "frames": [f"custom/{sprite_name}.png"],
                "w": 8,
                "h": 8,
                "ox": 4,
                "oy": 4,
                "chapter": "ch1",
                "tags": ["custom"],
                "custom": True,
            }
        },
        "audio": {},
    }
    (assets / "custom.index.json").write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def write_custom_audio(works: Path, *, audio_name: str = "boss_theme_draft", tags=("boss", "calm")) -> None:
    """在作品根的 custom.index.json 加一個帶自由 tag 的自訂音訊條目（保留既有条目）。"""
    assets = works / "assets"
    (assets / "custom").mkdir(parents=True, exist_ok=True)
    index_path = assets / "custom.index.json"
    index = {"format": "dr-battle-assets/1", "sprites": {}, "audio": {}}
    if index_path.is_file():
        index = json.loads(index_path.read_text(encoding="utf-8"))
        index.setdefault("sprites", {})
        index.setdefault("audio", {})
    (assets / "custom" / "music").mkdir(parents=True, exist_ok=True)
    (assets / "custom" / "music" / f"{audio_name}.ogg").write_bytes(b"OggS-v205")
    index["audio"][audio_name] = {
        "file": f"custom/music/{audio_name}.ogg",
        "kind": "music",
        "loop": True,
        "tags": list(tags),
        "custom": True,
    }
    index_path.write_text(json.dumps(index, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")



class TempWorks:
    """建立／清理一個臨時作品根（不遞歸刪除）。"""

    def __init__(self, label: str):
        self.root = TEMP_BASE / label
        self.root.mkdir(parents=True, exist_ok=True)

    def close(self):
        rmtree_safe(self.root)


# ---------------------------------------------------------------------------
# 1. 作品根：目錄、/api/info、CRUD、history、trash
# ---------------------------------------------------------------------------


class TestWorksRootBasics(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TempWorks("works-basics")
        cls.works = cls.temp.root / "my-boss"
        cls.server = ServerProcess(works=cls.works, label="works-basics").start()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        cls.temp.close()

    def test_01_auto_creates_subdirs(self):
        for name in ("attacks", "encounters", "assets/custom", "history", "trash"):
            self.assertTrue((self.works / name).is_dir(), f"作品根缺少 {name}/")

    def test_02_api_info(self):
        status, _, payload = self.server.json_request("GET", "/api/info")
        self.assertEqual(status, 200)
        self.assertEqual(payload["port"], self.server.port)
        self.assertEqual(Path(payload["works"]).resolve(), self.works.resolve())
        self.assertEqual(Path(payload["root"]).resolve(), BATTLE_EDITOR.resolve())
        self.assertTrue(payload["version"])
        for key in ("root", "works", "port", "version"):
            self.assertIn(key, payload)

    def test_03_attack_crud_lands_in_works(self):
        status, _, payload = self.server.put_attack("boss-alpha")
        self.assertEqual(status, 200, payload)
        on_disk = self.works / "attacks" / "boss-alpha.json"
        self.assertTrue(on_disk.is_file())
        # 預設草稿區不能被寫入
        self.assertFalse((BATTLE_EDITOR / "attacks" / "boss-alpha.json").exists())
        status, headers, fetched = self.server.get_attack("boss-alpha")
        self.assertEqual(status, 200)
        # HTTP ETag 標頭照規格加引號；JSON 裡的 etag 不帶引號
        self.assertEqual(headers.get("ETag"), f'"{payload["etag"]}"')
        self.assertEqual(fetched["meta"]["name"], "boss-alpha")
        status, _, listing = self.server.json_request("GET", "/api/encounters")
        self.assertEqual(status, 200)

    def test_04_encounter_crud_lands_in_works(self):
        status, _, payload = self.server.put_encounter("boss-fight")
        self.assertEqual(status, 200, payload)
        self.assertTrue((self.works / "encounters" / "boss-fight.json").is_file())
        self.assertFalse((BATTLE_EDITOR / "encounters" / "boss-fight.json").exists())
        status, _, listing = self.server.json_request("GET", "/api/encounters")
        self.assertEqual(status, 200)
        names = {item["name"] for item in listing["items"]}
        self.assertIn("boss-fight", names)

    def test_05_history_records_in_works(self):
        self.server.put_attack("hist-target", client="agent-v205")
        history_dir = self.works / "history"
        self.assertTrue(any(history_dir.glob("*.jsonl")), "作品根下沒有 history/*.jsonl")
        self.assertTrue((history_dir / "blobs").is_dir())
        self.assertFalse((BATTLE_EDITOR / "history" / "blobs" / "x.json").exists())
        status, _, payload = self.server.json_request("GET", "/api/history?name=hist-target")
        self.assertEqual(status, 200)
        entries = payload["items"]
        self.assertTrue(entries)
        self.assertEqual(entries[0]["client"], "agent-v205")
        self.assertEqual(entries[0]["kind"], "attack")

    def test_06_delete_moves_to_works_trash_and_restores(self):
        self.server.put_attack("trash-target")
        status, _, payload = self.server.json_request(
            "DELETE", "/api/attacks/trash-target.json", headers={"X-Client": "human"}
        )
        self.assertEqual(status, 200, payload)
        trash_id = payload["trash"]["id"]
        self.assertTrue((self.works / "trash" / "attack").is_dir())
        self.assertTrue(any((self.works / "trash" / "attack").glob("*.json")))
        self.assertFalse((self.works / "attacks" / "trash-target.json").exists())
        # 垃圾桶清單看得到
        status, _, listing = self.server.json_request("GET", "/api/trash?kind=attack")
        self.assertEqual(status, 200)
        self.assertIn(trash_id, {item["id"] for item in listing["items"]})
        # 還原回作品根
        status, _, restored = self.server.json_request("POST", "/api/restore", body={"trashId": trash_id})
        self.assertEqual(status, 200, restored)
        self.assertTrue((self.works / "attacks" / "trash-target.json").is_file())

    def test_07_optimistic_lock(self):
        status, _, first = self.server.put_attack("locked")
        self.assertEqual(status, 200)
        stale = {"etag": "0" * 64}
        status, _, conflict = self.server.json_request(
            "PUT",
            "/api/attacks/locked.json",
            body=attack_doc("locked"),
            headers={"X-Client": "human", "If-Match": stale["etag"]},
        )
        self.assertEqual(status, 409, conflict)
        self.assertEqual(conflict["etag"], first["etag"])
        self.assertTrue(conflict["conflict"])
        status, _, ok = self.server.json_request(
            "PUT",
            "/api/attacks/locked.json",
            body=attack_doc("locked"),
            headers={"X-Client": "human", "If-Match": first["etag"]},
        )
        self.assertEqual(status, 200, ok)

    def test_08_assets_custom_static_and_merge(self):
        write_custom_assets(self.works)
        status, headers, body = self.server.request("GET", "/assets/index.json")
        self.assertEqual(status, 200)
        index = json.loads(body)
        self.assertIn("spr_v205_custom", index["sprites"], "作品根自訂 sprite 沒有被合併進 /assets/index.json")
        self.assertIn("bg_battleback1", index["sprites"], "主索引的官方 sprite 不見了")
        # 不寫回主索引
        main_index = json.loads((BATTLE_EDITOR / "assets" / "index.json").read_text(encoding="utf-8"))
        self.assertNotIn("spr_v205_custom", main_index["sprites"])
        self.assertFalse((BATTLE_EDITOR / "assets" / "custom.index.json").exists())
        # /assets/custom/... 從作品根提供
        status, headers, body = self.server.request("GET", "/assets/custom/spr_v205_custom.png")
        self.assertEqual(status, 200)
        self.assertEqual(body, b"\x89PNG\r\n\x1a\nV205")
        self.assertEqual(headers.get("Content-Type"), "image/png")
        # 引擎拿得到的素材搜尋也看得到（AssetsIndex 走同一個合併後索引）
        status, _, payload = self.server.json_request("GET", "/api/assets/search?q=v205_custom")
        self.assertEqual(status, 200)
        self.assertTrue(payload["items"], payload)

    def test_09_sse_watches_works_root(self):
        client = SseClient(self.server.port)
        try:
            hello = client.wait_for(lambda event: event.get("type") == "hello")
            self.assertIsNotNone(hello, client.raw_lines[-10:])
            # 外部（繞過 API）直接改作品根的檔案 → 監看器要推事件
            self.server.put_attack("ext-watch")
            target = self.works / "attacks" / "ext-watch.json"
            document = json.loads(target.read_text(encoding="utf-8"))
            document["meta"]["author"] = "external-v205"
            body = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
            time.sleep(0.05)
            target.write_text(body, encoding="utf-8", newline="")
            event = client.wait_for(
                lambda e: e.get("type") == "changed" and e.get("name") == "ext-watch" and e.get("by") == "external",
                timeout=10.0,
            )
            self.assertIsNotNone(event, client.drain())
            self.assertEqual(event["kind"], "attack")
            # 預設草稿區的檔案不該被這個 server 監看
            draft = BATTLE_EDITOR / "attacks" / "not-mine.json"
            self.assertFalse(draft.exists())
        finally:
            client.close()

    def test_10_api_index_lists_new_endpoints(self):
        status, _, payload = self.server.json_request("GET", "/api")
        self.assertEqual(status, 200)
        paths = {item["path"] for item in payload["endpoints"]}
        self.assertIn("/api/info", paths)
        self.assertIn("/api/pack/export", paths)
        self.assertIn("/api/pack/import?mode=abort|rename|overwrite", paths)
        self.assertEqual(Path(payload["works"]).resolve(), self.works.resolve())

    def test_11_audio_search_uses_free_tags(self):
        """自訂音訊的自由 tag（例如 ["boss","calm"]）要能被 tag= 篩到，且原樣回傳。"""
        write_custom_audio(self.works)
        status, _, payload = self.server.json_request(
            "GET", "/api/assets/search?kind=audio&tag=boss"
        )
        self.assertEqual(status, 200, payload)
        names = [item["name"] for item in payload["items"]]
        self.assertIn("boss_theme_draft", names, f"自由 tag 沒有參與篩選：{names[:10]}")
        item = next(it for it in payload["items"] if it["name"] == "boss_theme_draft")
        self.assertEqual(item["kind"], "audio")
        self.assertEqual(item["audioKind"], "music")
        # tags 同時包含自訂自由 tag 與 kind，且去重、不吞掉原本的 tag
        self.assertIn("boss", item["tags"])
        self.assertIn("calm", item["tags"])
        self.assertIn("music", item["tags"])
        self.assertEqual(len(item["tags"]), len(set(item["tags"])), item["tags"])

        # 大小寫不敏感
        status, _, payload = self.server.json_request(
            "GET", "/api/assets/search?tag=CALM&kind=audio"
        )
        self.assertEqual(status, 200)
        self.assertIn("boss_theme_draft", [item["name"] for item in payload["items"]])

        # 官方音訊條目的自由 tag 也吃得到（主索引裡有 tags 的條目）
        status, _, payload = self.server.json_request(
            "GET", "/api/assets/search?tag=alt&kind=audio&limit=50"
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["items"], "主索引裡標了 tag=alt 的官方音訊應該搜得到")
        self.assertTrue(
            all("alt" in [t.lower() for t in item["tags"]] for item in payload["items"]),
            payload,
        )

        # kind 與分類 tag 仍然可用（不能因為新增自由 tag 而弄壞既有行為）
        status, _, payload = self.server.json_request(
            "GET", "/api/assets/search?tag=music&kind=audio&limit=50"
        )
        self.assertEqual(status, 200)
        self.assertTrue(payload["items"], "tag=music 至少要有自訂 BGM")
        self.assertTrue(all(item["audioKind"] == "music" for item in payload["items"]))
        status, _, payload = self.server.json_request(
            "GET", "/api/assets/search?tag=audio&q=boss_theme_draft"
        )
        self.assertEqual(status, 200)
        self.assertEqual([item["name"] for item in payload["items"]], ["boss_theme_draft"])
        # 不存在的 tag 什麼都不回
        status, _, payload = self.server.json_request(
            "GET", "/api/assets/search?tag=nope-not-a-tag&kind=audio"
        )
        self.assertEqual(status, 200)
        self.assertEqual(payload["count"], 0)


# ---------------------------------------------------------------------------
# 2. 預設模式（不給 --works）行為不變
# ---------------------------------------------------------------------------


class TestDefaultModeUnchanged(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TempWorks("default-mode")
        cls.root = cls.temp.root / "battle-editor-copy"
        cls.works = cls.root / "works"
        # 複製一份「主索引」到臨時 root，模擬真實的預設模式佈局（assets/index.json + attacks/…）
        (cls.works / "assets").mkdir(parents=True, exist_ok=True)
        shutil.copyfile(BATTLE_EDITOR / "assets" / "index.json", cls.works / "assets" / "index.json")
        cls.server = ServerProcess(root=cls.works, label="default-mode").start()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        cls.temp.close()

    def test_01_api_info_works_null(self):
        status, _, payload = self.server.json_request("GET", "/api/info")
        self.assertEqual(status, 200)
        self.assertIsNone(payload["works"], "--works 模式外 works 必須是 null")
        self.assertEqual(Path(payload["root"]).resolve(), self.works.resolve())
        self.assertEqual(Path(payload["dataRoot"]).resolve(), self.works.resolve())

    def test_02_data_lives_under_root(self):
        status, _, _ = self.server.put_attack("plain")
        self.assertEqual(status, 200)
        self.assertTrue((self.works / "attacks" / "plain.json").is_file())
        self.assertTrue((self.works / "history").is_dir())
        self.assertTrue((self.works / "trash").is_dir())
        self.assertFalse((self.works / "assets" / "custom.index.json").exists())

    def test_03_assets_index_is_served_verbatim(self):
        status, headers, body = self.server.request("GET", "/assets/index.json")
        self.assertEqual(status, 200)
        self.assertNotIn("X-Works", headers, "預設模式不該合併作品根索引")
        # 即使作品根模式會合併，預設模式必須原封不動送主索引（位元組完全相同）
        expected = (self.works / "assets" / "index.json").read_bytes()
        self.assertEqual(body, expected, "預設模式的 /assets/index.json 被動態改寫了")
        self.assertNotIn("spr_v205_custom", json.loads(body)["sprites"])


# ---------------------------------------------------------------------------
# 3. 作品根隔離（兩個作品根不互相汙染）
# ---------------------------------------------------------------------------


class TestWorksIsolation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = TempWorks("isolation")
        cls.works_a = cls.temp.root / "work-a"
        cls.works_b = cls.temp.root / "work-b"
        cls.server_a = ServerProcess(works=cls.works_a, label="iso-a").start()
        cls.server_b = ServerProcess(works=cls.works_b, label="iso-b").start()

    @classmethod
    def tearDownClass(cls):
        cls.server_a.stop()
        cls.server_b.stop()
        cls.temp.close()

    def test_01_separate_collections(self):
        self.server_a.put_attack("only-a")
        self.server_b.put_attack("only-b")
        self.assertTrue((self.works_a / "attacks" / "only-a.json").is_file())
        self.assertFalse((self.works_b / "attacks" / "only-a.json").exists())
        self.assertTrue((self.works_b / "attacks" / "only-b.json").is_file())
        self.assertFalse((self.works_a / "attacks" / "only-b.json").exists())

    def test_02_custom_assets_do_not_leak(self):
        write_custom_assets(self.works_a, sprite_name="spr_only_in_a", png=b"\x89PNG\r\n\x1a\nA")
        _, _, body_a = self.server_a.request("GET", "/assets/index.json")
        _, _, body_b = self.server_b.request("GET", "/assets/index.json")
        index_a = json.loads(body_a)
        index_b = json.loads(body_b)
        self.assertIn("spr_only_in_a", index_a["sprites"])
        self.assertNotIn("spr_only_in_a", index_b["sprites"], "作品 B 不該看到作品 A 的自訂素材")
        status_a, _, _ = self.server_a.request("GET", "/assets/custom/spr_only_in_a.png")
        status_b, _, _ = self.server_b.request("GET", "/assets/custom/spr_only_in_a.png")
        self.assertEqual(status_a, 200)
        self.assertEqual(status_b, 404)

    def test_03_history_and_trash_separate(self):
        self.server_a.put_attack("hist-a", client="agent-a")
        self.server_b.put_attack("hist-b", client="agent-b")
        _, _, history_a = self.server_a.json_request("GET", "/api/history")
        _, _, history_b = self.server_b.json_request("GET", "/api/history")
        names_a = {item["name"] for item in history_a["items"]}
        names_b = {item["name"] for item in history_b["items"]}
        self.assertIn("hist-a", names_a)
        self.assertNotIn("hist-b", names_a)
        self.assertIn("hist-b", names_b)
        self.assertNotIn("hist-a", names_b)


# ---------------------------------------------------------------------------
# 4. 作品包：CLI 與伺服器端點
# ---------------------------------------------------------------------------


class TestPackCli(unittest.TestCase):
    """直接跑 `node tools/pack.mjs`（不啟伺服器）。"""

    @classmethod
    def setUpClass(cls):
        cls.temp = TempWorks("pack-cli")
        cls.works = cls.temp.root / "pack-work"
        (cls.works / "attacks").mkdir(parents=True, exist_ok=True)
        (cls.works / "encounters").mkdir(parents=True, exist_ok=True)
        (cls.works / "assets" / "custom").mkdir(parents=True, exist_ok=True)
        # 作品根：一個遭遇引用兩個攻擊（一個在作品根、一個只在 samples/）
        (cls.works / "attacks" / "local-shot.json").write_text(
            json.dumps(attack_doc("local-shot", sprite="spr_pack_custom"), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        encounter = encounter_doc("cli-boss", attacks=["local-shot", "spade-rain"])
        (cls.works / "encounters" / "cli-boss.json").write_text(
            json.dumps(encounter, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        write_custom_assets(cls.works, sprite_name="spr_pack_custom", png=b"\x89PNG\r\n\x1a\nPACK")

    @classmethod
    def tearDownClass(cls):
        cls.temp.close()

    def run_pack(self, *args: str):
        env = dict(os.environ)
        env.pop("DR_WORKS", None)
        return subprocess.run(  # noqa: S603
            ["node", str(PACK_MJS), *args],
            cwd=str(BATTLE_EDITOR),
            capture_output=True,
            env=env,
            check=False,
            timeout=120,
        )

    def test_01_export_shape_and_contents(self):
        out = self.temp.root / "export.drpack.json"
        completed = self.run_pack("export", "cli-boss", "--works", str(self.works), "--out", str(out), "--json")
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace"))
        summary = json.loads(completed.stdout.decode("utf-8"))
        self.assertTrue(summary["ok"], summary)
        self.assertEqual(summary["kind"], "encounter")
        pack = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(pack["format"], "dr-battle-pack/1")
        for key in ("meta", "encounters", "attacks", "assets", "files"):
            self.assertIn(key, pack)
        self.assertEqual(pack["meta"]["name"], "cli-boss")
        self.assertEqual(pack["meta"]["tool"], "dr-battle-editor/pack.mjs")
        self.assertIn("createdAt", pack["meta"])
        # 遭遇 + 兩個攻擊
        self.assertIn("cli-boss", pack["encounters"])
        self.assertEqual(pack["encounters"]["cli-boss"]["source"], "works")
        self.assertIn("local-shot", pack["attacks"])
        self.assertEqual(pack["attacks"]["local-shot"]["source"], "works")
        self.assertIn("spade-rain", pack["attacks"])
        self.assertEqual(pack["attacks"]["spade-rain"]["source"], "sample")
        # 自訂素材（索引條目 + base64）
        self.assertIn("spr_pack_custom", pack["assets"]["sprites"])
        self.assertTrue(pack["assets"]["sprites"]["spr_pack_custom"]["custom"])
        self.assertIn("custom/spr_pack_custom.png", pack["files"])
        import base64

        self.assertEqual(base64.b64decode(pack["files"]["custom/spr_pack_custom.png"]), b"\x89PNG\r\n\x1a\nPACK")
        # 官方素材不進作品包（體積）
        self.assertNotIn("spr_spadebullet", pack["assets"]["sprites"])

    def test_02_export_attack_only(self):
        out = self.temp.root / "one.drpack.json"
        completed = self.run_pack("export", "local-shot", "--kind", "attack", "--works", str(self.works), "--out", str(out), "--json")
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace"))
        pack = json.loads(out.read_text(encoding="utf-8"))
        self.assertEqual(pack["meta"]["kind"], "attack")
        self.assertEqual(list(pack["attacks"]), ["local-shot"])
        self.assertEqual(pack["encounters"], {})

    def test_03_export_unknown_name_fails(self):
        completed = self.run_pack("export", "no-such-thing", "--works", str(self.works), "--json")
        self.assertNotEqual(completed.returncode, 0)
        payload = json.loads(completed.stdout.decode("utf-8"))
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "not_found")

    def test_04_import_roundtrip(self):
        out = self.temp.root / "rt.drpack.json"
        self.run_pack("export", "cli-boss", "--works", str(self.works), "--out", str(out), "--json")
        target = self.temp.root / "target-work"
        (target / "attacks").mkdir(parents=True, exist_ok=True)
        (target / "encounters").mkdir(parents=True, exist_ok=True)
        (target / "assets" / "custom").mkdir(parents=True, exist_ok=True)
        completed = self.run_pack("import", str(out), "--works", str(target), "--mode", "abort", "--json")
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace"))
        result = json.loads(completed.stdout.decode("utf-8"))
        self.assertTrue(result["ok"], result)
        self.assertEqual({item["name"] for item in result["imported"]["encounters"]}, {"cli-boss"})
        self.assertEqual({item["name"] for item in result["imported"]["attacks"]}, {"local-shot", "spade-rain"})
        self.assertTrue(result["needsCustomBuild"])
        self.assertIn("build_custom_assets.py", result["hint"] or "")
        # 檔案內容一致（canonical 格式）
        self.assertTrue((target / "encounters" / "cli-boss.json").is_file())
        self.assertTrue((target / "attacks" / "local-shot.json").is_file())
        self.assertTrue((target / "attacks" / "spade-rain.json").is_file())
        self.assertTrue((target / "assets" / "custom" / "spr_pack_custom.png").is_file())
        # REALTEST-2 V6：匯入寫回原始文字（手排版的 JSON 不會被重新 stringify 成整檔 diff）
        pack = json.loads(out.read_text(encoding="utf-8"))
        sample_text = (BATTLE_EDITOR / "samples" / "spade-rain.json").read_bytes().decode("utf-8").replace("\r\n", "\n")
        self.assertEqual(pack["attacks"]["spade-rain"]["text"], sample_text)
        self.assertEqual((target / "attacks" / "spade-rain.json").read_bytes().decode("utf-8"), sample_text)
        self.assertNotEqual(
            sample_text,
            json.dumps(json.loads(sample_text), ensure_ascii=False, indent=2) + "\n",
            "範例攻擊應是手排版（否則這個測試沒有鑑別力）",
        )
        self.assertEqual(
            (target / "encounters" / "cli-boss.json").read_bytes(),
            (self.works / "encounters" / "cli-boss.json").read_bytes().replace(b"\r\n", b"\n"),
        )
        # text 與 document 不一致（被改壞）→ 退回 canonical 排版，以 document 為準
        pack["attacks"]["spade-rain"]["text"] = '{"format":"dr-battle-attack/1","tampered":true}'
        bad = self.temp.root / "tampered.drpack.json"
        bad.write_text(json.dumps(pack, ensure_ascii=False), encoding="utf-8")
        target2 = self.temp.root / "target-work-2"
        completed = self.run_pack("import", str(bad), "--works", str(target2), "--mode", "abort", "--json")
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace"))
        written = (target2 / "attacks" / "spade-rain.json").read_text(encoding="utf-8")
        self.assertNotIn("tampered", written)
        self.assertEqual(json.loads(written), json.loads(sample_text))
        self.assertTrue((target / "assets" / "custom.index.json").is_file())
        roundtrip = json.loads((target / "encounters" / "cli-boss.json").read_text(encoding="utf-8"))
        original = json.loads((self.works / "encounters" / "cli-boss.json").read_text(encoding="utf-8"))
        self.assertEqual(roundtrip, original, "export→import 後的遭遇檔內容不一致")
        roundtrip_attack = json.loads((target / "attacks" / "local-shot.json").read_text(encoding="utf-8"))
        self.assertEqual(roundtrip_attack, attack_doc("local-shot", sprite="spr_pack_custom"))
        # 再匯出一次，兩邊的 pack 除了 createdAt 之外要一致
        out2 = self.temp.root / "rt2.drpack.json"
        self.run_pack("export", "cli-boss", "--works", str(target), "--out", str(out2), "--json")
        pack1 = json.loads(out.read_text(encoding="utf-8"))
        pack2 = json.loads(out2.read_text(encoding="utf-8"))
        for pack in (pack1, pack2):
            pack["meta"].pop("createdAt", None)
            for entry in list(pack["encounters"].values()) + list(pack["attacks"].values()):
                entry.pop("source", None)
        self.assertEqual(pack1, pack2, "往返後作品包內容不一致")

    def test_05_import_conflicts_abort_by_default(self):
        out = self.temp.root / "conflict.drpack.json"
        self.run_pack("export", "local-shot", "--kind", "attack", "--works", str(self.works), "--out", str(out), "--json")
        # 匯入到「已有同名攻擊與同名自訂素材」的作品根才會有衝突；先做一份一樣的目標
        target = self.temp.root / "conflict-target"
        (target / "attacks").mkdir(parents=True, exist_ok=True)
        (target / "encounters").mkdir(parents=True, exist_ok=True)
        (target / "assets" / "custom").mkdir(parents=True, exist_ok=True)
        self.run_pack("import", str(out), "--works", str(target), "--json")
        completed = self.run_pack("import", str(out), "--works", str(target), "--json")
        self.assertEqual(completed.returncode, 2, completed.stdout.decode("utf-8", "replace"))
        payload = json.loads(completed.stdout.decode("utf-8"))
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["code"], "conflicts")
        kinds = {(item["kind"], item["name"]) for item in payload["conflicts"]}
        self.assertIn(("attack", "local-shot"), kinds)
        self.assertIn(("sprite", "spr_pack_custom"), kinds)
        # 沒有寫任何檔（修改時間不變、檔案數不變）
        self.assertEqual(len(list((target / "attacks").glob("*.json"))), 1)

    def test_06_import_rename_on_conflict(self):
        out = self.temp.root / "rename.drpack.json"
        self.run_pack("export", "cli-boss", "--works", str(self.works), "--out", str(out), "--json")
        target = self.temp.root / "rename-target"
        (target / "attacks").mkdir(parents=True, exist_ok=True)
        (target / "encounters").mkdir(parents=True, exist_ok=True)
        (target / "assets" / "custom").mkdir(parents=True, exist_ok=True)
        self.run_pack("import", str(out), "--works", str(target), "--mode", "abort", "--json")
        completed = self.run_pack("import", str(out), "--works", str(target), "--rename-on-conflict", "--json")
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace"))
        result = json.loads(completed.stdout.decode("utf-8"))
        self.assertTrue(result["ok"], result)
        self.assertEqual(result["renamed"]["encounters"], {"cli-boss": "cli-boss_2"})
        self.assertEqual(result["renamed"]["attacks"].get("local-shot"), "local-shot_2")
        renamed = json.loads((target / "encounters" / "cli-boss_2.json").read_text(encoding="utf-8"))
        attacks = [turn["attack"] for turn in renamed["turns"] if turn.get("attack")]
        self.assertEqual(attacks, ["local-shot_2", "spade-rain_2"], "改名後遭遇裡的攻擊引用沒有同步改寫")
        self.assertTrue((target / "attacks" / "local-shot_2.json").is_file())
        self.assertTrue((target / "attacks" / "spade-rain_2.json").is_file())

    def test_07_import_overwrite(self):
        out = self.temp.root / "overwrite.drpack.json"
        self.run_pack("export", "local-shot", "--kind", "attack", "--works", str(self.works), "--out", str(out), "--json")
        payload = json.loads(out.read_text(encoding="utf-8"))
        payload["attacks"]["local-shot"]["document"]["meta"]["author"] = "overwritten"
        out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        completed = self.run_pack("import", str(out), "--works", str(self.works), "--overwrite", "--json")
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace"))
        result = json.loads(completed.stdout.decode("utf-8"))
        self.assertTrue(result["ok"])
        updated = json.loads((self.works / "attacks" / "local-shot.json").read_text(encoding="utf-8"))
        self.assertEqual(updated["meta"]["author"], "overwritten")

    def test_08_inspect(self):
        out = self.temp.root / "inspect.drpack.json"
        self.run_pack("export", "cli-boss", "--works", str(self.works), "--out", str(out), "--json")
        completed = self.run_pack("inspect", str(out), "--json")
        self.assertEqual(completed.returncode, 0, completed.stderr.decode("utf-8", "replace"))
        summary = json.loads(completed.stdout.decode("utf-8"))
        self.assertEqual(summary["counts"]["encounters"], 1)
        self.assertEqual(summary["counts"]["attacks"], 2)
        self.assertEqual(summary["counts"]["files"], 1)
        self.assertIn("sha256", summary)


class TestPackApi(unittest.TestCase):
    """伺服器端點 POST /api/pack/export、/api/pack/import。"""

    @classmethod
    def setUpClass(cls):
        cls.temp = TempWorks("pack-api")
        cls.works = cls.temp.root / "api-source"
        cls.server = ServerProcess(works=cls.works, label="pack-api").start()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        cls.temp.close()

    def test_01_export_endpoint(self):
        write_custom_assets(self.works, sprite_name="spr_api_custom", png=b"\x89PNG\r\n\x1a\nAPI")
        self.server.put_attack("api-shot", payload=attack_doc("api-shot", sprite="spr_api_custom"))
        self.server.put_encounter("api-boss", payload=encounter_doc("api-boss", attacks=["api-shot", "sine-wave"]))
        status, headers, body = self.server.request(
            "POST", "/api/pack/export", body={"kind": "encounter", "name": "api-boss"}
        )
        self.assertEqual(status, 200, body[:500])
        self.assertIn("drpack.json", headers.get("Content-Disposition", ""))
        self.assertIn("application/json", headers.get("Content-Type", ""))
        pack = json.loads(body)
        self.assertEqual(pack["format"], "dr-battle-pack/1")
        self.assertIn("api-boss", pack["encounters"])
        self.assertEqual(set(pack["attacks"]), {"api-shot", "sine-wave"})
        self.assertEqual(pack["attacks"]["sine-wave"]["source"], "sample")
        self.assertIn("spr_api_custom", pack["assets"]["sprites"])
        self.assertIn("custom/spr_api_custom.png", pack["files"])

        # 匯入到另一個作品根
        target = self.temp.root / "api-target"
        server_b = ServerProcess(works=target, label="pack-api-b").start()
        try:
            status, _, payload = server_b.json_request("POST", "/api/pack/import?mode=abort", raw_body=body)
            self.assertEqual(status, 200, payload)
            self.assertTrue(payload["ok"])
            self.assertEqual({item["name"] for item in payload["imported"]["attacks"]}, {"api-shot", "sine-wave"})
            self.assertTrue((target / "encounters" / "api-boss.json").is_file())
            self.assertTrue((target / "assets" / "custom" / "spr_api_custom.png").is_file())
            # 匯入後的遭遇內容與來源一致
            _, _, imported = server_b.json_request("GET", "/api/encounters/api-boss.json")
            self.assertEqual(imported["turns"][0]["attack"], "api-shot")
            # 自訂素材可用（伺服器 B 的合併索引）
            _, _, index_body = server_b.request("GET", "/assets/index.json")
            self.assertIn("spr_api_custom", json.loads(index_body)["sprites"])
            # 再匯入一次 → 409 列出衝突
            status, _, conflict = server_b.json_request("POST", "/api/pack/import?mode=abort", raw_body=body)
            self.assertEqual(status, 409, conflict)
            self.assertEqual(conflict["code"], "conflicts")
            self.assertTrue(conflict["conflicts"])
            # rename 模式成功，且遭遇裡的引用同步改名
            status, _, renamed = server_b.json_request("POST", "/api/pack/import?mode=rename", raw_body=body)
            self.assertEqual(status, 200, renamed)
            self.assertEqual(renamed["renamed"]["encounters"], {"api-boss": "api-boss_2"})
            _, _, second = server_b.json_request("GET", "/api/encounters/api-boss_2.json")
            self.assertEqual(second["turns"][0]["attack"], "api-shot_2")
        finally:
            server_b.stop()

    def test_02_export_errors(self):
        status, _, payload = self.server.json_request("POST", "/api/pack/export", body={"kind": "encounter", "name": "nope"})
        self.assertEqual(status, 404, payload)
        status, _, payload = self.server.json_request("POST", "/api/pack/export", body={"name": "nope"})
        self.assertEqual(status, 404, payload)
        status, _, payload = self.server.json_request("POST", "/api/pack/export", body={"kind": "widget", "name": "x"})
        self.assertEqual(status, 400, payload)
        status, _, payload = self.server.json_request("POST", "/api/pack/export", body={})
        self.assertEqual(status, 400, payload)
        status, _, payload = self.server.json_request("POST", "/api/pack/export", body={"name": "../evil"})
        self.assertEqual(status, 400, payload)

    def test_03_import_errors(self):
        status, _, payload = self.server.json_request("POST", "/api/pack/import?mode=bogus", raw_body=b"{}")
        self.assertEqual(status, 400, payload)
        status, _, payload = self.server.json_request("POST", "/api/pack/import", raw_body=b"not json")
        self.assertEqual(status, 400, payload)
        status, _, payload = self.server.json_request("POST", "/api/pack/import", raw_body=b"")
        self.assertEqual(status, 400, payload)
        status, _, payload = self.server.json_request(
            "POST", "/api/pack/import", body={"format": "something-else/9", "encounters": {}, "attacks": {}}
        )
        self.assertEqual(status, 400, payload)
        self.assertIn("format", payload["error"])


# ---------------------------------------------------------------------------
# 5. 環境變數 DR_WORKS 與相對路徑
# ---------------------------------------------------------------------------


class TestWorksEnv(unittest.TestCase):
    def test_dr_works_env_var(self):
        temp = TempWorks("env-works")
        try:
            works = temp.root / "env-work"
            server = ServerProcess(works=None, env_extra={"DR_WORKS": str(works)}, label="env-works").start()
            try:
                status, _, payload = server.json_request("GET", "/api/info")
                self.assertEqual(status, 200)
                self.assertEqual(Path(payload["works"]).resolve(), works.resolve())
                status, _, _ = server.put_attack("env-attack")
                self.assertEqual(status, 200)
                self.assertTrue((works / "attacks" / "env-attack.json").is_file())
            finally:
                server.stop()
        finally:
            temp.close()

    def test_relative_works_path_resolves_from_cwd(self):
        """--works 相對路徑以啟動時的工作目錄解析（這裡 cwd = battle-editor）。"""
        temp = TempWorks("rel-works")
        try:
            rel = os.path.relpath(temp.root / "rel-work", BATTLE_EDITOR)
            self.assertFalse(os.path.isabs(rel))
            server = ServerProcess(works=None, label="rel-works")
            server.works = Path(rel)  # 直接給相對路徑
            server.start()
            try:
                status, _, payload = server.json_request("GET", "/api/info")
                self.assertEqual(status, 200)
                self.assertEqual(Path(payload["works"]).resolve(), (BATTLE_EDITOR / rel).resolve())
                self.assertTrue((temp.root / "rel-work" / "attacks").is_dir())
            finally:
                server.stop()
        finally:
            temp.close()


# ---------------------------------------------------------------------------
# 6. 併發寫入與樂觀鎖（作品根模式下），以及對 18900 的保護
# ---------------------------------------------------------------------------


class TestWorksConcurrency(unittest.TestCase):
    def test_create_only_put_cannot_overwrite_an_existing_project(self):
        temp = TempWorks(f"save-as-{time.time_ns()}")
        self.addCleanup(temp.close)
        server = ServerProcess(works=temp.root, label="save-as").start()
        self.addCleanup(server.stop)
        path = "/api/attacks/copy.json"
        original = {"format": "dr-battle-attack/1", "meta": {"name": "first"}}
        edited = {**original, "meta": {"name": "second"}}
        headers = {"If-None-Match": "*"}
        status, _, first = server.json_request("PUT", path, body=original, headers=headers)
        self.assertEqual(status, 200, first)
        status, _, conflict = server.json_request("PUT", path, body=edited, headers=headers)
        self.assertEqual(status, 409, conflict)
        self.assertEqual(conflict["current"]["meta"]["name"], "first")
        status, _, _ = server.json_request("PUT", path, body=edited, headers={"If-Match": first["etag"]})
        self.assertEqual(status, 200)

    @classmethod
    def setUpClass(cls):
        cls.temp = TempWorks("concurrency")
        cls.works = cls.temp.root / "concurrent-work"
        cls.server = ServerProcess(works=cls.works, poll_interval=0.1, label="concurrency").start()

    @classmethod
    def tearDownClass(cls):
        cls.server.stop()
        cls.temp.close()

    def test_parallel_puts_are_serialised(self):
        import threading as threading_module

        results: list[int] = []
        lock = threading_module.Lock()

        def worker(index: int):
            status, _, _ = self.server.put_attack(f"par-{index}")
            with lock:
                results.append(status)

        threads = [threading_module.Thread(target=worker, args=(index,)) for index in range(6)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        self.assertEqual(results, [200] * 6)
        self.assertEqual(len(list((self.works / "attacks").glob("par-*.json"))), 6)

    def test_other_port_than_18900(self):
        self.assertNotEqual(self.server.port, FORBIDDEN_PORT)
        self.assertGreaterEqual(self.server.port, DEFAULT_TEST_PORT)


def main() -> int:
    loader = unittest.TestLoader()
    suite = unittest.TestSuite()
    for case in (
        TestWorksRootBasics,
        TestDefaultModeUnchanged,
        TestWorksIsolation,
        TestPackCli,
        TestPackApi,
        TestWorksEnv,
        TestWorksConcurrency,
    ):
        suite.addTests(loader.loadTestsFromTestCase(case))
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    return 0 if result.wasSuccessful() else 1


if __name__ == "__main__":
    raise SystemExit(main())
