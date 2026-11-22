#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tools/test_serve.py — serve.py 的整合測試（僅標準庫 unittest、無外部依賴）。

每個測試類別都會在**暫存目錄**起一個真的 ThreadingHTTPServer（隨機埠），
用 urllib / http.client 打 HTTP，不 mock 任何東西，因此連 SSE、檔案監看、
原子寫入、目錄穿越防護都是真跑。

執行：
    python tools/test_serve.py            # 全部
    python tools/test_serve.py -v         # 逐項
    python tools/test_serve.py TestEtags  # 只跑某一類

涵蓋（SPEC-AGENT §2）：
    * 既有 Phase 1/2 API 不退步（靜態檔、MIME、attacks/encounters 的 GET/PUT 清單）
    * ETag + If-Match 樂觀鎖、409 回傳現版本
    * PATCH 六種 op、JSON Pointer 轉義、test 失敗、非法 op/path
    * DELETE → trash → /api/restore、DELETE → /api/history/<id>/restore
    * SSE 收到外部直接改檔（繞過 API 寫檔）的 changed 事件、心跳、斷線清理
    * history 查詢與 blob 保存
    * /api/assets/search 的 q / tag / kind / limit
    * /api/schema/<name> 404 提示與存在時回傳
    * /api/editor/state 多 clientId、focus 推 SSE、DELETE 移除
    * 目錄穿越（靜態與 API）
"""

from __future__ import annotations

import contextlib
import http.client
import json
import os
import shutil
import socket
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
sys.path.insert(0, str(PROJECT))

import serve  # noqa: E402  (測試物件，先確保 import 路徑正確)


# ---------------------------------------------------------------------------
# 測試用伺服器
# ---------------------------------------------------------------------------


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class TempServer:
    """在暫存目錄起一個真的 serve.py 伺服器（隨機埠）。"""

    def __init__(self, *, with_assets: bool = True):
        self.root = Path(tempfile.mkdtemp(prefix="w2-serve-test-"))
        for folder in ("attacks", "encounters", "assets", "generated/schema", "samples", "editor"):
            (self.root / folder).mkdir(parents=True, exist_ok=True)
        (self.root / "index.html").write_text("<!doctype html><title>t</title>", encoding="utf-8")
        (self.root / "editor" / "main.js").write_text("export const x = 1;\n", encoding="utf-8")
        (self.root / "editor" / "styles.css").write_text("body{}\n", encoding="utf-8")
        (self.root / "samples" / "index.json").write_text(
            json.dumps({"format": "dr-battle-samples/1", "samples": []}), encoding="utf-8"
        )
        if with_assets:
            self._write_assets()
        self.app = serve.AppState(self.root, poll_interval=0.1)
        self.port = free_port()
        self.httpd = serve.BattleEditorServer(
            ("127.0.0.1", self.port), serve.BattleEditorHandler, quiet=True, app=self.app
        )
        self.app.start()
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05})
        self.thread.daemon = True
        self.thread.start()

    # ------------------------------------------------------------------ 資產
    def _write_assets(self):
        index = {
            "format": "dr-battle-assets/1",
            "sprites": {
                "spr_heart": {
                    "frames": ["sprites/spr_heart/0.png"],
                    "w": 16,
                    "h": 16,
                    "ox": 8,
                    "oy": 8,
                    "chapter": "ch1",
                    "tags": ["soul"],
                },
                "spr_spadebullet": {
                    "frames": ["sprites/spr_spadebullet/0.png"],
                    "w": 36,
                    "h": 34,
                    "ox": 18,
                    "oy": 17,
                    "chapter": "ch5",
                    "tags": ["bullet"],
                },
                "spr_battlebg_0": {
                    "frames": ["sprites/spr_battlebg_0/0.png", "sprites/spr_battlebg_0/1.png"],
                    "w": 75,
                    "h": 75,
                    "ox": 0,
                    "oy": 0,
                    "chapter": "ch5",
                    "tags": ["battlebg"],
                },
            },
            "audio": {
                "snd_hurt1": {"file": "audio/snd_hurt1.ogg", "kind": "sfx", "chapter": "ch1", "bytes": 100},
                "bgm_battle": {"file": "audio/bgm_battle.ogg", "kind": "music", "chapter": "ch1", "bytes": 200},
            },
            "fonts": {
                "main": {"image": "fonts/main.png", "glyphs": 96, "size": 16, "cjk": True},
            },
        }
        (self.root / "assets" / "index.json").write_text(
            json.dumps(index, ensure_ascii=False), encoding="utf-8"
        )
        (self.root / "assets" / "actor-presets.json").write_text(
            json.dumps(
                {
                    "format": "dr-battle-actor-presets/1",
                    "presets": {
                        "kris": {
                            "kind": "party",
                            "anims": {"idle": {"sprite": "spr_krisb_idle", "fps": 5, "loop": True}},
                        }
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

    # ------------------------------------------------------------------ HTTP
    def request(self, method: str, path: str, *, body=None, headers=None, raw_body=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=10)
        hdrs = dict(headers or {})
        payload = raw_body
        if payload is None and body is not None:
            payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        try:
            conn.request(method, path, body=payload, headers=hdrs)
            response = conn.getresponse()
            data = response.read()
            return response.status, dict(response.getheaders()), data
        finally:
            conn.close()

    def json(self, method: str, path: str, **kwargs):
        status, headers, data = self.request(method, path, **kwargs)
        try:
            parsed = json.loads(data.decode("utf-8")) if data else None
        except (UnicodeDecodeError, json.JSONDecodeError):
            parsed = None
        return status, headers, parsed

    def write_attack(self, name: str, payload=None, client: str = "human"):
        payload = payload or attack_doc(name)
        return self.request(
            "PUT",
            f"/api/attacks/{urllib.parse.quote(name)}.json",
            body=payload,
            headers={"X-Client": client},
        )

    def write_encounter(self, name: str, payload=None, client: str = "human"):
        payload = payload or encounter_doc(name)
        return self.request(
            "PUT",
            f"/api/encounters/{urllib.parse.quote(name)}.json",
            body=payload,
            headers={"X-Client": client},
        )

    # ------------------------------------------------------------------ 生命週期
    def close(self):
        with contextlib.suppress(Exception):
            self.httpd.shutdown()
        with contextlib.suppress(Exception):
            self.httpd.server_close()
        with contextlib.suppress(Exception):
            self.thread.join(timeout=5)
        with contextlib.suppress(Exception):
            self.app.stop()
        with contextlib.suppress(Exception):
            shutil.rmtree(self.root, ignore_errors=True)


def attack_doc(name: str, *, extra_event: bool = False) -> dict:
    timeline = [
        {"id": "ev_spawn", "at": 0.5, "type": "spawn", "bullet": "spade", "count": 3, "x": 320, "y": 100},
        {"id": "ev_end", "at": 5, "type": "end"},
    ]
    if extra_event:
        timeline.insert(1, {"id": "ev_shake", "at": 1, "type": "shake", "duration": 0.3, "amount": 2})
    return {
        "format": "dr-battle-attack/1",
        "meta": {"name": name, "author": "test"},
        "settings": {"duration": 6, "seed": 1, "damage": 5, "invincibleFrames": 30, "grazeTP": 1},
        "box": {"x": 320, "y": 300, "w": 200, "h": 140, "rotation": 0, "border": 4, "color": "#00c000"},
        "soul": {"x": 320, "y": 300, "speed": 4, "slowSpeed": 2, "mode": "red", "color": "#ff0000"},
        "party": [],
        "enemies": [],
        "bulletTypes": {
            "spade": {
                "sprite": "spr_spadebullet",
                "frameRate": 0,
                "scale": 1,
                "hitbox": {"shape": "circle", "r": 5},
                "hitbox_": None,
                "damage": 5,
                "grazeable": True,
            }
        },
        "timeline": timeline,
    }


def encounter_doc(name: str) -> dict:
    return {
        "format": "dr-battle-encounter/1",
        "meta": {"name": name, "author": "test"},
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
        "turns": [{"id": "t1", "flavor": "* hi", "talk": [], "attack": None, "start": [], "end": []}],
        "turnOrder": "loop-last",
        "hooks": {},
        "vars": {},
    }


# ---------------------------------------------------------------------------
# SSE 客戶端（讀 http.client 的原始 chunked 流）
# ---------------------------------------------------------------------------


class SseClient:
    """最小 SSE 讀取器：背景執行緒把解析到的事件推進佇列。"""

    def __init__(self, port: int):
        import queue as queue_module

        self.port = port
        self.queue = queue_module.Queue()
        self.events: list[dict] = []
        self.raw_lines: list[str] = []
        self.error: str | None = None
        self._stop = threading.Event()
        self.conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
        self.conn.request("GET", "/api/events", headers={"Accept": "text/event-stream"})
        self.response = self.conn.getresponse()
        self.status = self.response.status
        self.headers = dict(self.response.getheaders())
        self.thread = threading.Thread(target=self._pump, daemon=True)
        self.thread.start()

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
                                event = json.loads(payload)
                            except json.JSONDecodeError:
                                continue
                            self.events.append(event)
                            self.queue.put(event)
                        continue
                    if text.startswith("data: "):
                        data_lines.append(text[len("data: "):])
                    elif text.startswith("data:"):
                        data_lines.append(text[len("data:"):])
        except Exception as exc:  # noqa: BLE001 - 斷線是測試的正常結束路徑
            self.error = f"{type(exc).__name__}: {exc}"

    def wait_for(self, predicate, timeout=6.0) -> dict | None:
        """等第一個符合 predicate 的事件（已收到過的不重複匹配）。"""
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
        with contextlib.suppress(Exception):
            self.conn.close()
        with contextlib.suppress(Exception):
            self.thread.join(timeout=3)


# ---------------------------------------------------------------------------
# 測試基類
# ---------------------------------------------------------------------------


class ServerTestCase(unittest.TestCase):
    with_assets = True

    @classmethod
    def setUpClass(cls):
        cls.server = TempServer(with_assets=cls.with_assets)

    @classmethod
    def tearDownClass(cls):
        cls.server.close()

    def setUp(self):
        # 每個測試從乾淨的作品目錄開始（但共用同一個伺服器實例）
        for kind in ("attack", "encounter"):
            folder = self.server.root / serve.RESOURCE_SPECS[kind]["collection"]
            for path in folder.glob("*.json"):
                path.unlink()
        # 審計與垃圾桶也要清，否則前一個測試的紀錄會干擾查詢斷言
        history_dir = self.server.root / "history"
        for path in history_dir.glob("*.jsonl"):
            path.unlink()
        blobs = history_dir / "blobs"
        if blobs.is_dir():
            for path in blobs.glob("*.json"):
                path.unlink()
        for kind in ("attack", "encounter"):
            trash_dir = self.server.root / "trash" / kind
            if trash_dir.is_dir():
                for path in trash_dir.glob("*.json"):
                    path.unlink()
        # 編輯器狀態是記憶體的，也要清（跨測試共用同一個伺服器）
        with self.server.app.editor_state_lock:
            self.server.app.editor_states.clear()
        self.server.app.watcher.poll_once()

    # ---------------------------------------------------------------- 小工具
    def put_attack(self, name="alpha", payload=None, client="human", if_match=None):
        headers = {"X-Client": client}
        if if_match:
            headers["If-Match"] = if_match
        return self.server.json(
            "PUT",
            f"/api/attacks/{urllib.parse.quote(name)}.json",
            body=payload or attack_doc(name),
            headers=headers,
        )

    def get_attack(self, name="alpha"):
        return self.server.json("GET", f"/api/attacks/{urllib.parse.quote(name)}.json")

    def patch_attack(self, ops, name="alpha", if_match=None, client="human"):
        headers = {"X-Client": client}
        if if_match:
            headers["If-Match"] = if_match
        return self.server.json(
            "PATCH", f"/api/attacks/{urllib.parse.quote(name)}.json", body=ops, headers=headers
        )


# ---------------------------------------------------------------------------
# 1. Phase 1/2 不回歸
# ---------------------------------------------------------------------------


class TestLegacyBehaviour(ServerTestCase):
    def test_static_index_and_mime(self):
        status, headers, data = self.server.request("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn("text/html", headers.get("Content-Type", ""))
        status, headers, _ = self.server.request("GET", "/editor/main.js")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("Content-Type"), "text/javascript; charset=utf-8")
        status, headers, _ = self.server.request("GET", "/editor/styles.css")
        self.assertEqual(headers.get("Content-Type"), "text/css; charset=utf-8")

    def test_attacks_list_and_put_roundtrip(self):
        status, _, _ = self.server.write_attack("phase1")
        self.assertEqual(status, 200)
        status, _, payload = self.server.json("GET", "/api/attacks")
        self.assertEqual(status, 200)
        self.assertTrue(payload["ok"])
        # Phase 1 相容鍵
        self.assertIn("attacks", payload)
        self.assertEqual([item["name"] for item in payload["attacks"]], ["phase1"])
        self.assertIn("etag", payload["attacks"][0])

    def test_encounters_list_and_put_roundtrip(self):
        status, _, _ = self.server.write_encounter("enc1")
        self.assertEqual(status, 200)
        status, _, payload = self.server.json("GET", "/api/encounters")
        self.assertEqual(status, 200)
        self.assertNotIn("attacks", payload)  # 只有 attacks 集合才有相容鍵
        self.assertEqual(payload["items"][0]["name"], "enc1")
        self.assertEqual(payload["items"][0]["turns"], 1)

    def test_format_check_still_rejects(self):
        status, _, payload = self.server.json(
            "PUT",
            "/api/encounters/bad.json",
            body={"format": "dr-battle-attack/1"},
            headers={"X-Client": "test"},
        )
        self.assertEqual(status, 400)
        self.assertIn("dr-battle-encounter/1", payload["error"])

    def test_invalid_name_and_traversal(self):
        status, _, _ = self.server.request("PUT", "/api/attacks/bad%20name.json", raw_body=b"{}")
        self.assertEqual(status, 400)
        status, _, _ = self.server.request("GET", "/..%2f..%2fserve.py")
        self.assertEqual(status, 403)
        status, _, _ = self.server.request("GET", "/%2e%2e/serve.py")
        self.assertEqual(status, 403)
        status, _, _ = self.server.request("GET", "/editor/")
        self.assertEqual(status, 404)
        status, _, _ = self.server.request("GET", "/api/attacks/..%2fsecrets.json")
        self.assertEqual(status, 400)

    def test_unsupported_method_and_404(self):
        status, headers, _ = self.server.request("POST", "/api/attacks")
        self.assertEqual(status, 404)
        status, _, _ = self.server.request("GET", "/no-such-file.json")
        self.assertEqual(status, 404)
        status, headers, _ = self.server.request("OPTIONS", "/api/attacks")
        self.assertEqual(status, 204)
        self.assertIn("PUT", headers.get("Allow", ""))


# ---------------------------------------------------------------------------
# 2. ETag / If-Match
# ---------------------------------------------------------------------------


class TestEtags(ServerTestCase):
    def test_put_returns_etag_and_get_echoes_it(self):
        status, headers, payload = self.put_attack()
        self.assertEqual(status, 200)
        etag = payload["etag"]
        self.assertEqual(len(etag), 64)
        self.assertEqual(headers.get("ETag"), f'"{etag}"')
        status, headers, data = self.server.request("GET", "/api/attacks/alpha.json")
        self.assertEqual(status, 200)
        self.assertEqual(headers.get("ETag"), f'"{etag}"')
        self.assertEqual(headers.get("X-Etag"), etag)
        self.assertEqual(serve.sha256_hex(data), etag)

    def test_put_is_idempotent_when_content_unchanged(self):
        _, _, first = self.put_attack()
        status, _, second = self.put_attack()
        self.assertEqual(status, 200)
        self.assertTrue(second.get("unchanged"))
        self.assertEqual(first["etag"], second["etag"])
        # 沒有多寫一筆歷史
        status, _, history = self.server.json("GET", "/api/history?name=alpha")
        self.assertEqual(status, 200)
        self.assertEqual(len(history["items"]), 1)

    def test_if_match_ok_then_conflict_409_with_current_version(self):
        _, _, created = self.put_attack()
        etag_v1 = created["etag"]

        # 正確的 If-Match 通過
        payload = attack_doc("alpha")
        payload["meta"]["name"] = "v2"
        status, headers, updated = self.put_attack(payload=payload, if_match=f'"{etag_v1}"')
        self.assertEqual(status, 200, updated)
        etag_v2 = updated["etag"]
        self.assertNotEqual(etag_v1, etag_v2)

        # 用舊 etag 再寫 → 409，且回傳現版本
        payload["meta"]["name"] = "v3"
        status, headers, conflict = self.put_attack(payload=payload, if_match=f'"{etag_v1}"')
        self.assertEqual(status, 409)
        self.assertFalse(conflict["ok"])
        self.assertTrue(conflict["conflict"])
        self.assertEqual(conflict["etag"], etag_v2)
        self.assertEqual(conflict["current"]["meta"]["name"], "v2")
        self.assertEqual(headers.get("ETag"), f'"{etag_v2}"')

        # 磁碟上的內容仍是 v2
        _, _, current = self.get_attack()
        self.assertEqual(current["meta"]["name"], "v2")

    def test_if_match_star_and_missing_resource(self):
        status, _, _ = self.server.json(
            "PUT",
            "/api/attacks/ghost.json",
            body=attack_doc("ghost"),
            headers={"If-Match": "*", "X-Client": "agent"},
        )
        self.assertEqual(status, 409)  # 資源不存在 → 樂觀鎖失敗
        status, _, _ = self.put_attack("ghost")
        self.assertEqual(status, 200)
        status, _, _ = self.server.json(
            "PUT",
            "/api/attacks/ghost.json",
            body=attack_doc("ghost2"),
            headers={"If-Match": "*", "X-Client": "agent"},
        )
        self.assertEqual(status, 200)

    def test_patch_if_match_conflict(self):
        _, _, created = self.put_attack()
        etag_v1 = created["etag"]
        self.patch_attack([{"op": "replace", "path": "/meta/name", "value": "x"}], if_match=f'"{etag_v1}"')
        status, _, payload = self.patch_attack(
            [{"op": "replace", "path": "/meta/name", "value": "y"}], if_match=f'"{etag_v1}"'
        )
        self.assertEqual(status, 409)
        self.assertEqual(payload["current"]["meta"]["name"], "x")


# ---------------------------------------------------------------------------
# 3. PATCH（RFC 6902）
# ---------------------------------------------------------------------------


class TestPatch(ServerTestCase):
    def test_add_remove_replace(self):
        self.put_attack()
        status, _, payload = self.patch_attack(
            [
                {"op": "add", "path": "/box/rotation", "value": 12},
                {"op": "replace", "path": "/settings/duration", "value": 9},
                {"op": "remove", "path": "/settings/seed"},
            ]
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["ops"], 3)
        self.assertEqual([item["op"] for item in payload["patch"]], ["add", "replace", "remove"])
        _, _, doc = self.get_attack()
        self.assertEqual(doc["box"]["rotation"], 12)
        self.assertEqual(doc["settings"]["duration"], 9)
        self.assertNotIn("seed", doc["settings"])
        # PATCH 也要回新 ETag
        self.assertEqual(payload["etag"], serve.sha256_hex(self.server.request("GET", "/api/attacks/alpha.json")[2]))

    def test_add_array_insert_and_append_dash(self):
        self.put_attack()
        status, _, _ = self.patch_attack(
            [
                {"op": "add", "path": "/timeline/1", "value": {"id": "ev_new", "at": 1, "type": "shake"}},
                {"op": "add", "path": "/timeline/-", "value": {"id": "ev_tail", "at": 9, "type": "end"}},
            ]
        )
        self.assertEqual(status, 200)
        _, _, doc = self.get_attack()
        self.assertEqual([ev["id"] for ev in doc["timeline"]], ["ev_spawn", "ev_new", "ev_end", "ev_tail"])

    def test_move_and_copy(self):
        self.put_attack()
        status, _, _ = self.patch_attack(
            [
                {"op": "copy", "from": "/box", "path": "/boxCopy"},
                {"op": "move", "from": "/settings/seed", "path": "/settings/usedSeed"},
            ]
        )
        self.assertEqual(status, 200)
        _, _, doc = self.get_attack()
        self.assertEqual(doc["boxCopy"], doc["box"])
        self.assertEqual(doc["settings"]["usedSeed"], 1)
        self.assertNotIn("seed", doc["settings"])
        # 深拷貝：改副本不影響原物件
        status, _, _ = self.patch_attack([{"op": "replace", "path": "/boxCopy/w", "value": 1}])
        self.assertEqual(status, 200)
        _, _, doc = self.get_attack()
        self.assertEqual(doc["box"]["w"], 200)

    def test_move_into_own_child_rejected(self):
        self.put_attack()
        status, _, payload = self.patch_attack([{"op": "move", "from": "/box", "path": "/box/inner"}])
        self.assertEqual(status, 400)
        self.assertIn("子節點", payload["error"])
        _, _, doc = self.get_attack()
        self.assertEqual(doc["box"]["w"], 200)  # 未被破壞

    def test_pointer_escaping(self):
        self.put_attack()
        status, _, _ = self.patch_attack(
            [
                {"op": "add", "path": "/vars", "value": {}},
                {"op": "add", "path": "/vars/a~1b", "value": 1},
                {"op": "add", "path": "/vars/a~0b", "value": 2},
            ]
        )
        self.assertEqual(status, 200)
        _, _, doc = self.get_attack()
        self.assertEqual(doc["vars"]["a/b"], 1)
        self.assertEqual(doc["vars"]["a~b"], 2)

    def test_pointer_invalid_forms(self):
        self.put_attack()
        for ops, needle in (
            ([{"op": "add", "path": "no-slash", "value": 1}], "必須以 '/' 開頭"),
            ([{"op": "add", "path": "/a~2", "value": 1}], "非法轉義"),
            ([{"op": "bogus", "path": "/a", "value": 1}], "不支援的 op"),
            ([{"op": "remove", "path": "/nope/nope"}], "不存在"),
            ([{"op": "replace", "path": "/nope", "value": 1}], "不存在"),
            ([{"op": "add", "path": "/timeline/99", "value": 1}], "索引超出範圍"),
        ):
            status, _, payload = self.patch_attack(ops)
            self.assertEqual(status, 400, f"{ops} → {payload}")
            self.assertIn(needle, payload["error"], f"{ops} → {payload}")

    def test_non_array_payload_rejected(self):
        self.put_attack()
        status, _, payload = self.server.json(
            "PATCH", "/api/attacks/alpha.json", body={"bogus": True}, headers={"X-Client": "t"}
        )
        self.assertEqual(status, 400)
        status, _, payload = self.server.json(
            "PATCH", "/api/attacks/alpha.json", body={"ops": [{"op": "replace", "path": "/meta/author", "value": "w"}]},
            headers={"X-Client": "t"},
        )
        self.assertEqual(status, 200, payload)  # 也接受 {"ops": [...]} 包裝
        _, _, doc = self.get_attack()
        self.assertEqual(doc["meta"]["author"], "w")

    def test_test_op_success_and_failure(self):
        self.put_attack()
        status, _, _ = self.patch_attack(
            [
                {"op": "test", "path": "/settings/duration", "value": 6},
                {"op": "replace", "path": "/settings/duration", "value": 7},
            ]
        )
        self.assertEqual(status, 200)
        # 值不符 → 409（語意上的版本衝突）
        status, _, payload = self.patch_attack([{"op": "test", "path": "/settings/duration", "value": 6}])
        self.assertEqual(status, 409)
        self.assertIn("test", payload["error"])
        # true 與 1 不相等（JSON 語意）
        status, _, _ = self.patch_attack([{"op": "test", "path": "/settings/duration", "value": True}])
        self.assertEqual(status, 409)
        # 失敗的 patch 不會部分套用
        _, _, doc = self.get_attack()
        self.assertEqual(doc["settings"]["duration"], 7)

    def test_patch_rejects_invalid_after_state(self):
        self.put_attack()
        status, _, payload = self.patch_attack([{"op": "replace", "path": "/format", "value": "nope/9"}])
        self.assertEqual(status, 400)
        self.assertIn("不合法", payload["error"])
        _, _, doc = self.get_attack()
        self.assertEqual(doc["format"], "dr-battle-attack/1")

    def test_patch_missing_file_404(self):
        status, _, payload = self.patch_attack([{"op": "add", "path": "/x", "value": 1}], name="nofile")
        self.assertEqual(status, 404)


# ---------------------------------------------------------------------------
# 4. DELETE → trash → 還原
# ---------------------------------------------------------------------------


class TestDeleteTrashRestore(ServerTestCase):
    def test_delete_moves_to_trash_and_restores_by_trash_id(self):
        self.put_attack("trashme")
        status, _, payload = self.server.json("DELETE", "/api/attacks/trashme.json", headers={"X-Client": "agent"})
        self.assertEqual(status, 200, payload)
        trash_id = payload["trash"]["id"]
        self.assertEqual(payload["trash"]["name"], "trashme")
        self.assertEqual(payload["trash"]["kind"], "attack")
        # 原檔不在，垃圾桶有
        self.assertEqual(self.server.request("GET", "/api/attacks/trashme.json")[0], 404)
        trash_files = list((self.server.root / "trash" / "attack").glob("trashme.*.json"))
        self.assertEqual(len(trash_files), 1, trash_files)
        status, _, listing = self.server.json("GET", "/api/trash?kind=attack")
        self.assertEqual(status, 200)
        self.assertEqual([item["id"] for item in listing["items"]], [trash_id])

        status, _, restored = self.server.json(
            "POST", "/api/restore", body={"trashId": trash_id}, headers={"X-Client": "agent"}
        )
        self.assertEqual(status, 200, restored)
        self.assertEqual(restored["name"], "trashme")
        status, _, doc = self.server.json("GET", "/api/attacks/trashme.json")
        self.assertEqual(status, 200)
        self.assertEqual(doc["meta"]["name"], "trashme")

    def test_delete_with_if_match_conflict(self):
        _, _, created = self.put_attack("keepme")
        self.server.write_attack("keepme", payload=None)  # 內容相同 → etag 不變
        status, _, payload = self.server.json(
            "DELETE", "/api/attacks/keepme.json", headers={"If-Match": '"deadbeef"', "X-Client": "t"}
        )
        self.assertEqual(status, 409)
        self.assertEqual(payload["etag"], created["etag"])
        self.assertEqual(self.server.request("GET", "/api/attacks/keepme.json")[0], 200)

    def test_restore_from_history_before_etag(self):
        _, _, v1 = self.put_attack("histme")
        payload = attack_doc("histme")
        payload["settings"]["duration"] = 99
        self.put_attack("histme", payload=payload)
        status, _, payload = self.server.json(
            "POST",
            "/api/restore",
            body={"kind": "attack", "name": "histme", "etag": v1["etag"]},
            headers={"X-Client": "agent"},
        )
        self.assertEqual(status, 200, payload)
        _, _, doc = self.server.json("GET", "/api/attacks/histme.json")
        self.assertEqual(doc["settings"]["duration"], 6)

    def test_restore_history_by_entry_id(self):
        _, _, v1 = self.put_attack("byentry")
        payload = attack_doc("byentry")
        payload["settings"]["duration"] = 42
        self.put_attack("byentry", payload=payload)
        status, _, listing = self.server.json("GET", "/api/history?name=byentry&limit=10")
        self.assertEqual(status, 200)
        update_entry = next(item for item in listing["items"] if item.get("action") == "update")
        status, _, restored = self.server.json(
            "POST", f"/api/history/{update_entry['id']}/restore", headers={"X-Client": "agent"}
        )
        self.assertEqual(status, 200, restored)
        _, _, doc = self.server.json("GET", "/api/attacks/byentry.json")
        self.assertEqual(doc["settings"]["duration"], 6)

    def test_restore_conflict_when_target_exists(self):
        self.put_attack("dupe")
        status, _, payload = self.server.json("DELETE", "/api/attacks/dupe.json", headers={"X-Client": "t"})
        trash_id = payload["trash"]["id"]
        self.put_attack("dupe")  # 重新建立同名檔
        status, _, conflict = self.server.json(
            "POST", "/api/restore", body={"trashId": trash_id}, headers={"X-Client": "t"}
        )
        self.assertEqual(status, 409, conflict)
        status, _, ok = self.server.json(
            "POST", "/api/restore", body={"trashId": trash_id, "overwrite": True}, headers={"X-Client": "t"}
        )
        self.assertEqual(status, 200, ok)

    def test_restore_unknown_ids(self):
        status, _, _ = self.server.json("POST", "/api/restore", body={"trashId": "nope"})
        self.assertEqual(status, 404)
        status, _, _ = self.server.json(
            "POST", "/api/restore", body={"kind": "attack", "name": "x", "etag": "0" * 64}
        )
        self.assertEqual(status, 404)
        status, _, _ = self.server.json("POST", "/api/restore", body={"kind": "bogus", "name": "x"})
        self.assertEqual(status, 400)

    def test_delete_encounter_uses_its_own_trash_folder(self):
        self.server.write_encounter("delenemy")
        status, _, payload = self.server.json("DELETE", "/api/encounters/delenemy.json", headers={"X-Client": "t"})
        self.assertEqual(status, 200)
        self.assertTrue((self.server.root / "trash" / "encounter").is_dir())
        self.assertEqual(self.server.request("GET", "/api/encounters/delenemy.json")[0], 404)


# ---------------------------------------------------------------------------
# 5. 審計歷史
# ---------------------------------------------------------------------------


class TestHistory(ServerTestCase):
    def test_history_records_put_patch_delete(self):
        self.put_attack("h1", client="agent-alpha")
        etag_for_patch = self.get_attack("h1")[1]["ETag"]
        self.patch_attack(
            [{"op": "replace", "path": "/settings/duration", "value": 8}],
            name="h1",
            client="agent-alpha",
            if_match=etag_for_patch,
        )
        self.server.json("DELETE", "/api/attacks/h1.json", headers={"X-Client": "agent-alpha"})

        status, _, payload = self.server.json("GET", "/api/history?name=h1")
        self.assertEqual(status, 200)
        actions = [item["action"] for item in payload["items"]]
        self.assertEqual(actions, ["delete", "patch", "create"])
        patch_entry = next(item for item in payload["items"] if item["action"] == "patch")
        self.assertEqual(patch_entry["client"], "agent-alpha")
        self.assertEqual(patch_entry["method"], "PATCH")
        self.assertEqual(patch_entry["kind"], "attack")
        self.assertEqual(patch_entry["patch"][0]["op"], "replace")
        self.assertEqual(len(patch_entry["beforeEtag"]), 64)
        self.assertEqual(len(patch_entry["afterEtag"]), 64)
        for item in payload["items"]:
            self.assertIn("ts", item)
            self.assertIn("tsMs", item)
            self.assertIn("id", item)

    def test_history_day_file_and_filters(self):
        self.put_attack("h2", client="human")
        day = time.strftime("%Y-%m-%d")
        path = self.server.root / "history" / f"{day}.jsonl"
        self.assertTrue(path.is_file(), path)
        lines = path.read_text(encoding="utf-8").splitlines()
        self.assertTrue(lines)
        first = json.loads(lines[0])
        self.assertIn("id", first)
        status, _, payload = self.server.json("GET", f"/api/history?day={day}&limit=5")
        self.assertEqual(status, 200)
        self.assertGreaterEqual(payload["count"], 1)
        status, _, filtered = self.server.json("GET", "/api/history?client=nobody")
        self.assertEqual(filtered["count"], 0)
        status, _, by_id = self.server.json("GET", f"/api/history/{first['id']}")
        self.assertEqual(status, 200)
        self.assertEqual(by_id["entry"]["id"], first["id"])
        status, _, missing = self.server.json("GET", "/api/history/ffffffffffffffff")
        self.assertEqual(status, 404)

    def test_blob_stored_per_version(self):
        _, _, v1 = self.put_attack("blobbed")
        payload = attack_doc("blobbed")
        payload["settings"]["duration"] = 3
        _, _, v2 = self.put_attack("blobbed", payload=payload)
        blob_dir = self.server.root / "history" / "blobs"
        self.assertTrue((blob_dir / f"{v1['etag']}.json").is_file())
        self.assertFalse((blob_dir / f"{v2['etag']}.json").is_file())  # 最新版不再是舊版
        data = json.loads((blob_dir / f"{v1['etag']}.json").read_text(encoding="utf-8"))
        self.assertEqual(data["settings"]["duration"], 6)


# ---------------------------------------------------------------------------
# 6. SSE
# ---------------------------------------------------------------------------


class TestSse(ServerTestCase):
    def test_sse_hello_and_headers(self):
        client = SseClient(self.server.port)
        try:
            self.assertEqual(client.status, 200)
            self.assertIn("text/event-stream", client.headers.get("Content-Type", ""))
            hello = client.wait_for(lambda e: e.get("type") == "hello")
            self.assertIsNotNone(hello, client.raw_lines)
            self.assertIn("pollIntervalMs", hello)
            self.assertLessEqual(hello["pollIntervalMs"], 500)
        finally:
            client.close()

    def test_sse_receives_api_write(self):
        client = SseClient(self.server.port)
        try:
            self.assertIsNotNone(client.wait_for(lambda e: e.get("type") == "hello"))
            status, _, payload = self.put_attack("sse1", client="agent-007")
            self.assertEqual(status, 200)
            event = client.wait_for(lambda e: e.get("type") == "changed" and e.get("name") == "sse1")
            self.assertIsNotNone(event, client.drain())
            self.assertEqual(event["kind"], "attack")
            self.assertEqual(event["etag"], payload["etag"])
            self.assertEqual(event["by"], "agent-007")
        finally:
            client.close()

    def test_sse_receives_external_disk_change(self):
        """繞過 API 直接寫檔（模擬外部工具），監看器要偵測到並推送。"""
        self.put_attack("ext1")
        client = SseClient(self.server.port)
        try:
            self.assertIsNotNone(client.wait_for(lambda e: e.get("type") == "hello"))
            target = self.server.root / "attacks" / "ext1.json"
            document = json.loads(target.read_text(encoding="utf-8"))
            document["meta"]["author"] = "external-tool"
            body = json.dumps(document, ensure_ascii=False, indent=2) + "\n"
            # 用不同 mtime 保證偵測（輪詢用 mtime_ns + size）；newline="\n" 避免 Windows 轉成 CRLF
            time.sleep(0.02)
            target.write_text(body, encoding="utf-8", newline="\n")
            event = client.wait_for(
                lambda e: e.get("type") == "changed" and e.get("name") == "ext1" and e.get("by") == "external",
                timeout=6.0,
            )
            self.assertIsNotNone(event, client.drain())
            self.assertEqual(event["etag"], serve.sha256_hex(body.encode("utf-8")))
        finally:
            client.close()

    def test_sse_receives_external_delete(self):
        self.put_attack("ext2")
        client = SseClient(self.server.port)
        try:
            self.assertIsNotNone(client.wait_for(lambda e: e.get("type") == "hello"))
            (self.server.root / "attacks" / "ext2.json").unlink()
            event = client.wait_for(
                lambda e: e.get("type") == "deleted" and e.get("name") == "ext2", timeout=6.0
            )
            self.assertIsNotNone(event, client.drain())
            self.assertEqual(event["by"], "external")
        finally:
            client.close()

    def test_sse_multiple_clients_and_cleanup(self):
        first = SseClient(self.server.port)
        second = SseClient(self.server.port)
        try:
            self.assertIsNotNone(first.wait_for(lambda e: e.get("type") == "hello"))
            self.assertIsNotNone(second.wait_for(lambda e: e.get("type") == "hello"))
            self.put_attack("multi")
            for client in (first, second):
                event = client.wait_for(lambda e: e.get("type") == "changed" and e.get("name") == "multi")
                self.assertIsNotNone(event, client.drain())
        finally:
            first.close()
            second.close()
        # 斷線後訂閱者要清掉（最多等 3 秒）
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and self.server.app.sse.subscriber_count > 0:
            time.sleep(0.05)
        self.assertEqual(self.server.app.sse.subscriber_count, 0)

    def test_sse_heartbeat_comment(self):
        """心跳是 15 秒一次；這裡用縮短的常數間接驗證格式，不真的等 15 秒。"""
        original = serve.SSE_HEARTBEAT_SECONDS
        serve.SSE_HEARTBEAT_SECONDS = 0.2
        client = SseClient(self.server.port)
        try:
            self.assertIsNotNone(client.wait_for(lambda e: e.get("type") == "hello"))
            deadline = time.monotonic() + 4.0
            found = False
            while time.monotonic() < deadline and not found:
                found = any(line.startswith(": heartbeat") for line in client.raw_lines)
                time.sleep(0.05)
            self.assertTrue(found, client.raw_lines[-12:])
        finally:
            serve.SSE_HEARTBEAT_SECONDS = original
            client.close()


# ---------------------------------------------------------------------------
# 7. 素材搜尋
# ---------------------------------------------------------------------------


class TestAssetsSearch(ServerTestCase):
    def test_search_all_kinds(self):
        status, _, payload = self.server.json("GET", "/api/assets/search?q=heart")
        self.assertEqual(status, 200, payload)
        names = [item["name"] for item in payload["items"]]
        self.assertIn("spr_heart", names)
        self.assertEqual(payload["items"][0]["name"], "spr_heart")
        item = payload["items"][0]
        self.assertEqual(item["kind"], "sprite")
        self.assertEqual(item["w"], 16)
        self.assertEqual(item["ox"], 8)
        self.assertEqual(item["frames"], 1)
        self.assertEqual(item["tags"], ["soul"])
        self.assertTrue(item["preview"].startswith("assets/"))

    def test_search_by_tag_and_kind(self):
        status, _, payload = self.server.json("GET", "/api/assets/search?tag=bullet")
        self.assertEqual(status, 200)
        self.assertEqual([item["name"] for item in payload["items"]], ["spr_spadebullet"])

        status, _, payload = self.server.json("GET", "/api/assets/search?kind=audio")
        self.assertEqual(status, 200)
        kinds = {item["name"]: item["audioKind"] for item in payload["items"]}
        self.assertEqual(kinds.get("snd_hurt1"), "sfx")
        self.assertEqual(kinds.get("bgm_battle"), "music")

        status, _, payload = self.server.json("GET", "/api/assets/search?kind=font")
        self.assertEqual(status, 200)
        self.assertEqual(payload["items"][0]["name"], "main")
        self.assertTrue(payload["items"][0]["cjk"])

        status, _, payload = self.server.json("GET", "/api/assets/search?kind=preset")
        self.assertEqual(status, 200)
        self.assertEqual(payload["items"][0]["name"], "kris")
        self.assertEqual(payload["items"][0]["states"], ["idle"])

    def test_search_limit_and_bad_kind(self):
        status, _, payload = self.server.json("GET", "/api/assets/search?limit=1")
        self.assertEqual(status, 200)
        self.assertEqual(len(payload["items"]), 1)
        status, _, payload = self.server.json("GET", "/api/assets/search?limit=999")
        self.assertEqual(status, 200)
        self.assertEqual(payload["query"]["limit"], 200)
        status, _, payload = self.server.json("GET", "/api/assets/search?kind=banana")
        self.assertEqual(status, 400)
        status, _, payload = self.server.json("GET", "/api/assets/search?q=zzzzz")
        self.assertEqual(status, 200)
        self.assertEqual(payload["count"], 0)


# ---------------------------------------------------------------------------
# 8. Schema 端點
# ---------------------------------------------------------------------------


class TestSchema(ServerTestCase):
    def test_missing_schema_gives_404_with_hint(self):
        status, _, payload = self.server.json("GET", "/api/schema/attack")
        self.assertEqual(status, 404)
        self.assertIn("hint", payload)
        self.assertIn("generated/schema/attack.json", json.dumps(payload, ensure_ascii=False))
        # 提示要指向實際存在的產生器（AG 的 tools/agent/export-schema.mjs）
        self.assertIn("tools/agent/export-schema.mjs", payload["hint"])
        status, _, payload = self.server.json("GET", "/api/schema/bogus")
        self.assertEqual(status, 404)

    def test_schema_listing_and_existing_schema(self):
        status, _, payload = self.server.json("GET", "/api/schema")
        self.assertEqual(status, 200)
        self.assertEqual(payload["available"], [])
        self.assertEqual(payload["expected"], ["attack", "encounter", "cues"])

        schema_dir = self.server.root / "generated" / "schema"
        (schema_dir / "attack.json").write_text(
            json.dumps({"$schema": "https://json-schema.org/draft/2020-12/schema", "title": "attack"}),
            encoding="utf-8",
        )
        status, headers, payload = self.server.json("GET", "/api/schema/attack")
        self.assertEqual(status, 200)
        self.assertEqual(payload["title"], "attack")
        self.assertIn("ETag", headers)
        status, _, payload = self.server.json("GET", "/api/schema")
        self.assertEqual(payload["available"], ["attack"])


# ---------------------------------------------------------------------------
# 9. 編輯器狀態 + focus 推播
# ---------------------------------------------------------------------------


class TestEditorState(ServerTestCase):
    def test_put_get_multiple_clients(self):
        status, _, payload = self.server.json(
            "PUT",
            "/api/editor/state",
            body={"file": "alpha", "selection": {"kind": "event", "id": "ev_spawn"}, "cursor": 30, "lang": "zh"},
            headers={"X-Client": "editor-tab-1"},
        )
        self.assertEqual(status, 200, payload)
        self.assertEqual(payload["clientId"], "editor-tab-1")

        self.server.json(
            "PUT",
            "/api/editor/state",
            body={"file": "beta", "cursor": 0, "lang": "en", "clientId": "tab-2"},
            headers={"X-Client": "human"},
        )
        status, _, listing = self.server.json("GET", "/api/editor/state")
        self.assertEqual(status, 200)
        ids = sorted(item["clientId"] for item in listing["items"])
        self.assertEqual(ids, ["editor-tab-1", "tab-2"])
        for item in listing["items"]:
            self.assertIn("updatedMs", item)
            self.assertIn("updatedAt", item)

        status, _, single = self.server.json("GET", "/api/editor/state/editor-tab-1")
        self.assertEqual(status, 200)
        self.assertEqual(single["item"]["state"]["file"], "alpha")

        status, _, deleted = self.server.json(
            "DELETE", "/api/editor/state/tab-2", headers={"X-Client": "human"}
        )
        self.assertEqual(status, 200)
        status, _, listing = self.server.json("GET", "/api/editor/state")
        self.assertEqual([item["clientId"] for item in listing["items"]], ["editor-tab-1"])

    def test_focus_pushes_sse_event(self):
        client = SseClient(self.server.port)
        try:
            self.assertIsNotNone(client.wait_for(lambda e: e.get("type") == "hello"))
            status, _, payload = self.server.json(
                "PUT",
                "/api/editor/state",
                body={"file": "alpha", "focus": {"file": "alpha", "eventId": "ev_spawn", "frame": 42}},
                headers={"X-Client": "agent-9"},
            )
            self.assertEqual(status, 200)
            self.assertTrue(payload["focusEmitted"])
            event = client.wait_for(lambda e: e.get("type") == "focus")
            self.assertIsNotNone(event, client.drain())
            self.assertEqual(event["focus"]["eventId"], "ev_spawn")
            self.assertEqual(event["focus"]["frame"], 42)
            self.assertEqual(event["by"], "agent-9")
        finally:
            client.close()

    def test_no_focus_no_event(self):
        client = SseClient(self.server.port)
        try:
            self.assertIsNotNone(client.wait_for(lambda e: e.get("type") == "hello"))
            status, _, payload = self.server.json(
                "PUT", "/api/editor/state", body={"file": "alpha"}, headers={"X-Client": "human"}
            )
            self.assertEqual(status, 200)
            self.assertFalse(payload["focusEmitted"])
            self.assertIsNone(client.wait_for(lambda e: e.get("type") == "focus", timeout=1.0))
        finally:
            client.close()


# ---------------------------------------------------------------------------
# 10. 其他：API 目錄、client 標頭、寫入壞 JSON
# ---------------------------------------------------------------------------


class TestMisc(ServerTestCase):
    def test_favicon_ico_falls_back_to_svg(self):
        # REALTEST-2 V12：/favicon.ico 沒有檔案時回 favicon.svg（不要 404）
        svg = self.server.root / "favicon.svg"
        ico = self.server.root / "favicon.ico"
        self.assertFalse(ico.exists())
        if svg.exists():
            svg.unlink()
        status, _, _ = self.server.request("GET", "/favicon.ico")
        self.assertEqual(status, 404, "兩個檔都沒有時仍是 404")
        svg.write_text('<svg xmlns="http://www.w3.org/2000/svg"/>', encoding="utf-8")
        try:
            status, headers, data = self.server.request("GET", "/favicon.ico")
            self.assertEqual(status, 200)
            self.assertIn("image/svg+xml", headers.get("Content-Type", ""))
            self.assertIn(b"<svg", data)
        finally:
            svg.unlink()

    def test_api_index_lists_endpoints(self):
        status, _, payload = self.server.json("GET", "/api")
        self.assertEqual(status, 200)
        paths = {item["path"] for item in payload["endpoints"]}
        self.assertIn("/api/events", paths)
        self.assertIn("/api/assets/search?q=&tag=&kind=&limit=", paths)
        self.assertIn("attack", payload["resources"])
        events = next(item for item in payload["endpoints"] if item["path"] == "/api/events")
        for name in ("changed", "deleted", "focus"):
            self.assertIn(name, events["desc"])

    def test_client_header_defaults_and_sanitised(self):
        self.put_attack("c1")  # 沒帶 X-Client → human
        status, _, payload = self.server.json("GET", "/api/history?name=c1")
        self.assertEqual(payload["items"][0]["client"], "human")
        self.put_attack("c2", client="agent/../../evil\x00")
        status, _, payload = self.server.json("GET", "/api/history?name=c2")
        recorded = payload["items"][0]["client"]
        # 會過濾危險字元（路徑分隔、NUL、控制字元），而不是原樣寫進審計
        self.assertNotIn("/", recorded)
        self.assertNotIn("\\", recorded)
        self.assertNotIn("\x00", recorded)
        self.assertLessEqual(len(recorded), 64)
        self.assertTrue(recorded.startswith("agent"), recorded)

    def test_bad_json_and_oversize(self):
        status, _, payload = self.server.json(
            "PUT", "/api/attacks/bad.json", raw_body=b"{not json", headers={"X-Client": "t"}
        )
        self.assertEqual(status, 400)
        self.assertIn("JSON 解析失敗", payload["error"])
        status, _, _ = self.server.request(
            "PUT",
            "/api/attacks/big.json",
            raw_body=b"{}",
            headers={"Content-Length": str(serve.MAX_PUT_BYTES + 1), "X-Client": "t"},
        )
        self.assertEqual(status, 413)

    def test_unknown_api_paths(self):
        status, _, _ = self.server.request("GET", "/api/nope")
        self.assertEqual(status, 404)
        status, _, _ = self.server.request("PATCH", "/api/nope")
        self.assertEqual(status, 404)
        status, _, _ = self.server.request("DELETE", "/api/editor/state")
        self.assertEqual(status, 400)
        status, _, _ = self.server.request("POST", "/api/nope")
        self.assertEqual(status, 404)

    def test_unicode_name_roundtrip(self):
        self.put_attack("中文攻擊")
        status, headers, data = self.server.request("GET", "/api/attacks/" + urllib.parse.quote("中文攻擊") + ".json")
        self.assertEqual(status, 200)
        self.assertIn("filename*=UTF-8''", headers.get("Content-Disposition", ""))
        self.assertIn("ETag", headers)


# ---------------------------------------------------------------------------
# 11. JSON Patch 單元測試（不經 HTTP，覆蓋邊界）
# ---------------------------------------------------------------------------


class TestJsonPatchUnit(unittest.TestCase):
    def test_apply_does_not_mutate_input(self):
        original = {"a": {"b": 1}, "list": [1, 2]}
        patched, summary = serve.apply_json_patch(original, [{"op": "replace", "path": "/a/b", "value": 2}])
        self.assertEqual(original["a"]["b"], 1)
        self.assertEqual(patched["a"]["b"], 2)
        self.assertEqual(len(summary), 1)

    def test_root_replacement(self):
        patched, _ = serve.apply_json_patch({"a": 1}, [{"op": "replace", "path": "", "value": {"b": 2}}])
        self.assertEqual(patched, {"b": 2})
        with self.assertRaises(serve.PatchError):
            serve.apply_json_patch({"a": 1}, [{"op": "remove", "path": ""}])

    def test_array_root(self):
        patched, _ = serve.apply_json_patch([1, 2, 3], [{"op": "add", "path": "/0", "value": 0}])
        self.assertEqual(patched, [0, 1, 2, 3])
        patched, _ = serve.apply_json_patch([1, 2, 3], [{"op": "remove", "path": "/2"}])
        self.assertEqual(patched, [1, 2])
        # RFC 6901 沒有負索引；'-' 只允許用於 add 的尾端
        with self.assertRaises(serve.PatchError):
            serve.apply_json_patch([1, 2, 3], [{"op": "remove", "path": "/-1"}])
        with self.assertRaises(serve.PatchError):
            serve.apply_json_patch([1, 2, 3], [{"op": "remove", "path": "/-"}])

    def test_pointer_escapes_unit(self):
        self.assertEqual(serve.parse_pointer("/a~1b/~0c"), ["a/b", "~c"])
        self.assertEqual(serve.parse_pointer(""), [])
        for bad in ("a", "/~2", 5):
            with self.assertRaises(serve.PatchError):
                serve.parse_pointer(bad)

    def test_deep_equal_types(self):
        self.assertTrue(serve.deep_equal(1, 1.0))
        self.assertFalse(serve.deep_equal(True, 1))
        self.assertFalse(serve.deep_equal({"a": 1}, {"a": 1, "b": 2}))
        self.assertTrue(serve.deep_equal([1, {"x": None}], [1.0, {"x": None}]))

    def test_non_object_op_rejected(self):
        with self.assertRaises(serve.PatchError):
            serve.apply_json_patch({}, ["nope"])
        with self.assertRaises(serve.PatchError):
            serve.apply_json_patch({}, [{"op": "add", "path": "/x", "value": 1}] * (serve.MAX_PATCH_OPS + 1))


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


def main(argv=None) -> int:
    serve.force_utf8_stdio()
    argv = list(sys.argv if argv is None else argv)
    unittest.main(module=__name__, argv=argv, verbosity=2, exit=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
