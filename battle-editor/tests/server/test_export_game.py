"""tests/server/test_export_game.py — POST /api/export/game 整合測試（V2-09）

範圍：
  * 以子程序啟動 serve.py（自己的埠 18950 起、絕不用 18900，結束一定關閉）
  * 合法攻擊／遭遇：200、text/html、Content-Disposition 附件、單檔 HTML 內容
  * --works 優先：作品根目錄的遭遇優先於 repo samples
  * 參數錯誤：缺 name／空 name／非法 kind／非法 lang／autoplayToggle 非布林 → 400
  * 找不到作品 → 404；非法 JSON → 400；GET 不支援 → 404
  * 回應標頭：Cache-Control: no-store、X-Content-Type-Options: nosniff、ETag

清理：暫存檔一律放 %TEMP%\\V2-09\\；只 unlink 檔案與非遞歸 os.rmdir，不做遞歸刪除。
"""

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

BASE = Path(__file__).resolve().parents[2]  # battle-editor/
SERVER = BASE / "serve.py"
TEMP_BASE = Path(tempfile.gettempdir()) / "V2-09" / "server-export"
FORBIDDEN_PORT = 18900
STARTUP_TIMEOUT = 30.0
REQUEST_TIMEOUT = 300.0
PORT_CANDIDATES = range(18950, 18990)


def free_port() -> int:
    for port in PORT_CANDIDATES:
        if port == FORBIDDEN_PORT:
            continue
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            try:
                sock.bind(("127.0.0.1", port))
            except OSError:
                continue
        return port
    raise RuntimeError("找不到可用埠（18950-18989）")


def port_is_listening(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(0.25)
        return sock.connect_ex(("127.0.0.1", port)) == 0


def wait_until_ready(port: int) -> bool:
    deadline = time.time() + STARTUP_TIMEOUT
    while time.time() < deadline:
        if port_is_listening(port):
            try:
                with urllib.request.urlopen(
                    f"http://127.0.0.1:{port}/api/info", timeout=2
                ) as response:
                    if response.status == 200:
                        return True
            except (urllib.error.URLError, OSError, ValueError):
                pass
        time.sleep(0.2)
    return False


def post_json(port: int, payload, *, path: str = "/api/export/game", timeout: float = REQUEST_TIMEOUT):
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


def post_raw(port: int, body: bytes, *, timeout: float = REQUEST_TIMEOUT):
    request = urllib.request.Request(
        f"http://127.0.0.1:{port}/api/export/game",
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers), response.read()
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers), error.read()


class ExportGameEndpointTest(unittest.TestCase):
    """單一伺服器、單一作品根；所有請求共用。"""

    @classmethod
    def setUpClass(cls):
        TEMP_BASE.mkdir(parents=True, exist_ok=True)
        cls.works = TEMP_BASE / "works"
        (cls.works / "encounters").mkdir(parents=True, exist_ok=True)
        # --works 優先：把 sample 遭遇複製到作品根，用新檔名驗證「作品根優先於 repo samples」。
        shutil.copy2(
            BASE / "samples" / "encounters" / "rudinn.json",
            cls.works / "encounters" / "works-test.json",
        )
        cls.port = free_port()
        cls.proc = subprocess.Popen(
            [
                sys.executable,
                str(SERVER),
                "--quiet",
                "--port",
                str(cls.port),
                "--works",
                str(cls.works),
            ],
            cwd=str(BASE),
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        if not wait_until_ready(cls.port):
            cls.tearDownClass()
            raise RuntimeError(f"serve.py 未在 {STARTUP_TIMEOUT:.0f} 秒內啟動（port {cls.port}）")
        with urllib.request.urlopen(
            f"http://127.0.0.1:{cls.port}/api/info", timeout=5
        ) as response:
            cls.info = json.loads(response.read().decode("utf-8"))

    @classmethod
    def tearDownClass(cls):
        proc = getattr(cls, "proc", None)
        if proc is not None and proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                try:
                    proc.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    pass
        # 只移除自己建立的檔案（不遞歸刪除）；非遞歸 rmdir 清空目錄。
        works = getattr(cls, "works", None)
        if works is not None:
            for path in [works / "encounters" / "works-test.json"]:
                try:
                    path.unlink()
                except OSError:
                    pass
            for folder in [works / "encounters", works]:
                try:
                    os.rmdir(folder)
                except OSError:
                    pass
        try:
            os.rmdir(TEMP_BASE)
        except OSError:
            pass

    # ------------------------------------------------------------ 基本

    def test_server_uses_own_port_and_works(self):
        self.assertNotEqual(self.port, FORBIDDEN_PORT)
        self.assertEqual(self.info["ok"], True)
        self.assertEqual(Path(self.info["works"]), self.works.resolve())

    # ------------------------------------------------------------ 成功

    def test_export_attack_returns_single_html_attachment(self):
        status, headers, body = post_json(
            self.port,
            {"name": "spade-rain", "kind": "attack", "lang": "en", "autoplayToggle": False},
        )
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("Content-Type", "").startswith("text/html"))
        self.assertIn("charset=utf-8", headers.get("Content-Type", ""))
        self.assertIn('attachment; filename="spade-rain.html"', headers.get("Content-Disposition", ""))
        self.assertEqual(headers.get("Cache-Control"), "no-store")
        self.assertEqual(headers.get("X-Content-Type-Options"), "nosniff")
        self.assertTrue(headers.get("ETag"))
        self.assertEqual(int(headers.get("X-Export-Bytes", "0")), len(body))
        self.assertGreater(len(body), 500_000)
        text = body.decode("utf-8")
        self.assertTrue(text.startswith("<!doctype html>"))
        self.assertIn('id="game"', text)
        self.assertIn('id="dr-asset-index"', text)
        self.assertIn('"lang":"en"', text)
        self.assertIn('"auto":false', text)

    def test_export_encounter_bundles_attacks(self):
        status, headers, body = post_json(
            self.port,
            {"name": "rudinn", "kind": "encounter", "lang": "en"},
        )
        self.assertEqual(status, 200)
        self.assertIn('filename="rudinn.html"', headers.get("Content-Disposition", ""))
        text = body.decode("utf-8")
        self.assertIn('"kind":"encounter"', text)
        self.assertIn('"spade-rain"', text)
        self.assertIn('"ring-burst"', text)
        self.assertIn('"box-shrink-aim"', text)
        self.assertIn('"auto":true', text)
        self.assertIn('id="auto-btn"', text)

    def test_works_root_takes_priority(self):
        status, headers, body = post_json(self.port, {"name": "works-test", "lang": "en"})
        self.assertEqual(status, 200, body[:200])
        self.assertIn('filename="works-test.html"', headers.get("Content-Disposition", ""))
        self.assertIn('"name":"works-test"', body.decode("utf-8"))

    def test_kind_auto_detection(self):
        status, _headers, body = post_json(self.port, {"name": "spade-rain", "lang": "en"})
        self.assertEqual(status, 200)
        self.assertIn('"kind":"attack"', body.decode("utf-8"))

    # ------------------------------------------------------------ 參數錯誤

    def test_bad_requests_return_400(self):
        cases = [
            {},
            {"name": ""},
            {"name": "   "},
            {"name": "spade-rain", "kind": "battle"},
            {"name": "spade-rain", "lang": "fr"},
            {"name": "spade-rain", "title": 123},
            {"name": "spade-rain", "autoplayToggle": "yes"},
            [],
        ]
        for payload in cases:
            status, headers, body = post_json(self.port, payload, timeout=30)
            self.assertEqual(status, 400, f"payload={payload!r} -> {status} {body[:200]}")
            data = json.loads(body.decode("utf-8"))
            self.assertEqual(data["ok"], False)
            self.assertIn("error", data)

    def test_invalid_json_returns_400(self):
        status, _headers, body = post_json(self.port, None, timeout=30)
        self.assertEqual(status, 400)
        self.assertEqual(json.loads(body.decode("utf-8"))["ok"], False)

    def test_not_found_returns_404(self):
        status, _headers, body = post_json(self.port, {"name": "no-such-work-xyz"}, timeout=60)
        self.assertEqual(status, 404)
        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data["ok"], False)
        self.assertEqual(data.get("code"), "not_found")

    def test_get_not_supported(self):
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/export/game", method="GET"
        )
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(request, timeout=10)
        self.assertEqual(caught.exception.code, 404)


if __name__ == "__main__":
    unittest.main()
