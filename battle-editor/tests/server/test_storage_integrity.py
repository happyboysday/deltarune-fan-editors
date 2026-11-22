"""Storage boundary regressions; only write to disposable works and output roots."""

import base64
import json
import os
from pathlib import Path
import subprocess
import unittest
from uuid import uuid4

from test_works_root import BATTLE_EDITOR, PACK_MJS, ServerProcess, TempWorks, attack_doc


def pack(*names, sprites=None, files=None):
    return {
        "format": "dr-battle-pack/1",
        "attacks": {name: attack_doc(name) for name in names},
        "assets": {"sprites": sprites or {}},
        "files": {key: base64.b64encode(value).decode() for key, value in (files or {}).items()},
    }


class StorageIntegrity(unittest.TestCase):
    def setUp(self):
        self.temp = TempWorks(f"storage-{uuid4().hex}")
        self.addCleanup(self.temp.close)
        self.works = self.temp.root / "project"
        self.custom = self.works / "assets" / "custom"
        self.custom.mkdir(parents=True)
        self.index = self.custom.parent / "custom.index.json"

    def cli(self, script, *args, body=None, preload=None):
        node = ["node", "--require", str(preload)] if preload else ["node"]
        return subprocess.run(
            [*node, str(script), *map(str, args)],
            input=json.dumps(body).encode() if body is not None else None,
            cwd=BATTLE_EDITOR, capture_output=True, timeout=20,
        )

    def import_pack(self, body, mode="abort", *, preload=None):
        result = self.cli(PACK_MJS, "import", "-", "--works", self.works, "--mode", mode, "--json",
                          body=body, preload=preload)
        return result.returncode, json.loads(result.stdout)

    def test_unrelated_asset_path_is_not_overwritten_in_any_mode(self):
        key = "custom/shared.png"
        original = self.custom / "shared.png"
        original.write_bytes(b"original art")
        index = {"sprites": {"unrelated": {"frames": [key]}}}
        self.index.write_text(json.dumps(index), encoding="utf-8")
        incoming = pack("new", sprites={"new": {"frames": [key]}}, files={key: b"new art"})
        for mode in ("abort", "overwrite"):
            with self.subTest(mode=mode):
                status, result = self.import_pack(incoming, mode)
                self.assertNotEqual(status, 0, result)
                self.assertEqual(original.read_bytes(), b"original art")
                self.assertEqual(json.loads(self.index.read_text()), index)
                self.assertFalse((self.works / "attacks" / "new.json").exists())
        status, result = self.import_pack(incoming, "rename")
        self.assertEqual(status, 0, result)
        merged = json.loads(self.index.read_text())
        new_key = merged["sprites"]["new"]["frames"][0]
        self.assertNotEqual(new_key, key)
        self.assertEqual((self.custom.parent / new_key).read_bytes(), b"new art")
        self.assertEqual(original.read_bytes(), b"original art")

    def test_malformed_pack_does_not_touch_files(self):
        sentinel = self.custom.parent / "index.json"
        sentinel.write_bytes(b"official index")
        for key in ("./index.json", "/custom/foo.png", "custom/./foo.png", "custom/foo.png:stream",
                    "custom/NUL.png", "custom/foo.png ", "custom\\foo.png"):
            with self.subTest(key=key):
                status, result = self.import_pack(pack("new", sprites={"art": {"frames": [key]}}, files={key: b"x"}))
                self.assertNotEqual(status, 0, result)
                self.assertEqual(result["code"], "bad_pack")
                self.assertEqual(sentinel.read_bytes(), b"official index")
                self.assertEqual(list(self.custom.iterdir()), [])
        key = "custom/foo.png"
        for body in (
            pack("new", sprites={"art": {"frames": [key]}}),
            pack("new", files={key: b"unreferenced"}),
            pack("new", sprites={"art": {"frames": [key]}}, files={key: b"x", "custom/FOO.png": b"y"}),
        ):
            status, result = self.import_pack(body)
            self.assertNotEqual(status, 0, result)
            self.assertEqual(result["code"], "bad_pack")
        bad_base64 = pack("new", sprites={"art": {"frames": [key]}}, files={key: b"x"})
        bad_base64["files"][key] = "eA==junk"
        status, result = self.import_pack(bad_base64)
        self.assertNotEqual(status, 0, result)
        self.assertEqual(result["code"], "bad_pack")
        self.assertFalse((self.works / "attacks" / "new.json").exists())

    def test_rename_reserves_all_incoming_names_and_shared_frames(self):
        attacks = self.works / "attacks"
        attacks.mkdir()
        (attacks / "shot.json").write_bytes(b"original")
        key = "custom/shared.png"
        self.index.write_text(json.dumps({"sprites": {
            "a": {"frames": ["custom/a.png"]}, "b": {"frames": ["custom/b.png"]},
        }}), encoding="utf-8")
        body = pack("shot", "shot_2", sprites={"a": {"frames": [key]}, "b": {"frames": [key]}},
                    files={key: b"both sprites use this"})
        status, result = self.import_pack(body, "rename")
        self.assertEqual(status, 0, result)
        self.assertEqual(result["renamed"]["attacks"], {"shot": "shot_3"})
        self.assertEqual((attacks / "shot.json").read_bytes(), b"original")
        self.assertEqual(json.loads((attacks / "shot_2.json").read_text())["meta"]["name"], "shot_2")
        merged = json.loads(self.index.read_text())
        for name in result["renamed"]["sprites"].values():
            path = self.custom.parent / merged["sprites"][name]["frames"][0]
            self.assertEqual(path.read_bytes(), b"both sprites use this")

    def test_out_of_range_number_in_raw_source_text_is_not_restored(self):
        body = pack("shot")
        doc = body["attacks"]["shot"]
        doc["value"] = None
        body["attacks"]["shot"] = {
            "document": doc,
            "text": json.dumps(doc).replace('"value": null', '"value": 1e999'),
        }
        status, result = self.import_pack(body)
        self.assertEqual(status, 0, result)
        path = self.works / "attacks" / "shot.json"
        self.assertIsNone(json.loads(path.read_text(encoding="utf-8"))["value"])

    def test_corrupt_custom_index_cannot_be_replaced_silently(self):
        self.index.write_bytes(b'{"sprites":')
        key = "custom/art.png"
        status, result = self.import_pack(pack("new", sprites={"a": {"frames": [key]}}, files={key: b"x"}))
        self.assertNotEqual(status, 0, result)
        self.assertEqual(self.index.read_bytes(), b'{"sprites":')
        self.assertFalse((self.custom / "art.png").exists())

    def test_preflight_rejects_directory_target_before_writing_first_attack(self):
        attacks = self.works / "attacks"
        (attacks / "z.json").mkdir(parents=True)
        status, result = self.import_pack(pack("a", "z"), "overwrite")
        self.assertNotEqual(status, 0, result)
        self.assertFalse((attacks / "a.json").exists())

    def test_import_cannot_write_through_custom_directory_link(self):
        outside = self.temp.root / "outside"
        outside.mkdir()
        link = self.custom / "redirect"
        if os.name == "nt":
            subprocess.run(["cmd.exe", "/c", "mklink", "/J", str(link), str(outside)],
                           check=True, capture_output=True)
            self.addCleanup(link.rmdir)
        else:
            link.symlink_to(outside, target_is_directory=True)
            self.addCleanup(link.unlink)
        key = "custom/redirect/art.png"
        body = pack("new", sprites={"art": {"frames": [key]}}, files={key: b"art"})
        status, result = self.import_pack(body, "overwrite")
        self.assertNotEqual(status, 0, result)
        self.assertEqual(result["code"], "bad_target")
        self.assertEqual(list(outside.iterdir()), [])
        self.assertFalse(self.index.exists())

    def test_shared_lock_blocks_cli_import_and_http_save(self):
        server = ServerProcess(works=self.works, label="storage-lock").start()
        self.addCleanup(server.stop)
        path = "/api/attacks/shot.json"
        source = self.works / "attacks" / "shot.json"
        self.assertEqual(server.json_request("PUT", path, body=attack_doc("shot"))[0], 200)
        original = source.read_bytes()
        lock = self.works / ".drpack-import.lock"
        lock.mkdir()
        try:
            status, result = self.import_pack(pack("shot"), "overwrite")
            self.assertNotEqual(status, 0, result)
            self.assertEqual(result["code"], "import_busy")
            status, _, result = server.json_request("PUT", path, body=attack_doc("updated"))
            self.assertEqual(status, 409, result)
            self.assertEqual(result["code"], "import_busy")
            self.assertEqual(source.read_bytes(), original)
        finally:
            lock.rmdir()
        self.assertEqual(server.json_request("PUT", path, body=attack_doc("updated"))[0], 200)
        self.assertNotEqual(source.read_bytes(), original)
        self.assertFalse(lock.exists())

    def test_failed_backup_leaves_original_and_no_temporary_file(self):
        server = ServerProcess(works=self.works, label="storage-backup").start()
        self.addCleanup(server.stop)
        path = "/api/attacks/shot.json"
        status, _, first = server.json_request("PUT", path, body=attack_doc("shot"))
        self.assertEqual(status, 200, first)
        source = self.works / "attacks" / "shot.json"
        original = source.read_bytes()
        blobs = self.works / "history" / "blobs"
        blocker = blobs / (first["etag"] + ".json")
        blocker.mkdir()
        status, _, result = server.json_request("PUT", path, body=attack_doc("updated"))
        self.assertEqual(status, 500, result)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(list(blobs.iterdir()), [blocker])
        self.assertFalse((self.works / ".drpack-import.lock").exists())

    def test_http_import_uses_configured_root_without_works(self):
        server = ServerProcess(root=self.works, label="storage-root").start()
        self.addCleanup(server.stop)
        name = "root-" + uuid4().hex
        status, _, result = server.json_request("POST", "/api/pack/import", body=pack(name))
        self.assertEqual(status, 200, result)
        self.assertTrue((self.works / "attacks" / (name + ".json")).is_file())
        self.assertFalse((BATTLE_EDITOR / "attacks" / (name + ".json")).exists())

    def inject_second_publish_failure(self, fail_rollback=False):
        preload = self.temp.root / "fail-publish.cjs"
        preload.write_text(
            """
const fs = require('node:fs');
const { basename, dirname } = require('node:path');
const { syncBuiltinESMExports } = require('node:module');
const rename = fs.renameSync;
let publishes = 0;
fs.renameSync = (from, to) => {
  if (basename(dirname(from)).startsWith('.dr-write-')) {
    if (basename(from) === 'original') {
      if (FAIL_ROLLBACK) throw Object.assign(new Error('injected restore failure'), { code: 'EPERM' });
    } else if (++publishes === 2) {
      throw Object.assign(new Error('injected second publish failure'), { code: 'EPERM' });
    }
  }
  return rename(from, to);
};
syncBuiltinESMExports();
""".replace("FAIL_ROLLBACK", json.dumps(fail_rollback)),
            encoding="utf-8",
        )
        return preload

    def test_second_publish_failure_restores_existing_file(self):
        attacks = self.works / "attacks"
        attacks.mkdir()
        (attacks / "a.json").write_bytes(b"original a\r\n")
        (attacks / "z.json").write_bytes(b"original z\n")
        before = {file.relative_to(self.works): file.read_bytes()
                  for file in self.works.rglob("*") if file.is_file()}
        status, result = self.import_pack(pack("a", "z"), "overwrite",
                                          preload=self.inject_second_publish_failure())
        self.assertNotEqual(status, 0, result)
        self.assertIn("injected second publish failure", result["error"])
        after = {file.relative_to(self.works): file.read_bytes()
                 for file in self.works.rglob("*") if file.is_file()}
        self.assertEqual(after, before)
        self.assertEqual(sorted(file.name for file in attacks.iterdir()), ["a.json", "z.json"])
        self.assertEqual(result["code"], "publish_failed")
        self.assertFalse((self.works / ".drpack-import.lock").exists())

    def test_second_publish_failure_removes_only_new_file(self):
        attacks = self.works / "attacks"
        attacks.mkdir()
        (attacks / "z.json").write_bytes(b"original z")
        (attacks / "keep.txt").write_bytes(b"unrelated")
        status, result = self.import_pack(pack("a", "z"), "overwrite",
                                          preload=self.inject_second_publish_failure())
        self.assertNotEqual(status, 0, result)
        self.assertIn("injected second publish failure", result["error"])
        self.assertEqual({file.name: file.read_bytes() for file in attacks.iterdir()},
                         {"z.json": b"original z", "keep.txt": b"unrelated"})
        self.assertEqual(result["code"], "publish_failed")

    def test_rollback_failure_retains_original_and_reports_recovery_path(self):
        attacks = self.works / "attacks"
        attacks.mkdir()
        first = attacks / "a.json"
        first.write_bytes(b"recover these exact bytes\r\n")
        (attacks / "z.json").write_bytes(b"original z")
        status, result = self.import_pack(pack("a", "z"), "overwrite",
                                          preload=self.inject_second_publish_failure(fail_rollback=True))
        self.assertNotEqual(status, 0, result)
        self.assertEqual(result["code"], "rollback_failed", result)
        self.assertIn("injected second publish failure", result["error"])
        failure, = result["rollbackFailures"]
        self.assertEqual(Path(failure["path"]), first)
        self.assertIn("injected restore failure", failure["error"])
        recovery = Path(failure["backup"])
        self.assertIn(str(recovery), result["error"])
        self.assertEqual(recovery.read_bytes(), b"recover these exact bytes\r\n")
        self.assertEqual((attacks / "z.json").read_bytes(), b"original z")
        self.assertFalse((self.works / ".drpack-import.lock").exists())
        self.assertEqual([file for file in attacks.rglob("original")], [recovery])

    def test_http_save_rejects_json_that_cannot_roundtrip(self):
        server = ServerProcess(works=self.works, label="storage-json").start()
        self.addCleanup(server.stop)
        path = "/api/attacks/shot.json"
        self.assertEqual(server.json_request("PUT", path, body=attack_doc("shot"))[0], 200)
        old = (self.works / "attacks" / "shot.json").read_bytes()
        for method, body in (
            ("PUT", b'{"number": NaN}'),
            ("PUT", b'{"number": 1e999}'),
            ("PATCH", br'[{"op":"add","path":"/bad","value":"\ud800"}]'),
        ):
            with self.subTest(method=method, body=body):
                status, _, _ = server.json_request(method, path, raw_body=body)
                self.assertEqual(status, 400)
                self.assertEqual((self.works / "attacks" / "shot.json").read_bytes(), old)

    def test_http_pack_accepts_wrapped_body(self):
        server = ServerProcess(works=self.works, label="storage-pack").start()
        self.addCleanup(server.stop)
        status, _, result = server.json_request("POST", "/api/pack/import", body={"pack": pack("shot")})
        self.assertEqual(status, 200, result)
        self.assertTrue((self.works / "attacks" / "shot.json").is_file())

    def test_export_clis_cannot_replace_their_source(self):
        attacks = self.works / "attacks"
        attacks.mkdir()
        source = attacks / "shot.json"
        source.write_text(json.dumps(attack_doc("shot")), encoding="utf-8")
        old = source.read_bytes()
        for script, args in (
            (PACK_MJS, ("export", "shot")),
            (BATTLE_EDITOR / "tools" / "export-game.mjs", ("shot",)),
        ):
            with self.subTest(script=script):
                result = self.cli(script, *args, "--works", self.works, "--out", source, "--json")
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertEqual(json.loads(result.stdout)["code"], "bad_request")
                self.assertEqual(source.read_bytes(), old)

    def test_record_rejects_existing_frame_sequence_before_capture(self):
        first = self.temp.root / "f0000.png"
        first.write_bytes(b"older recording")
        result = self.cli(BATTLE_EDITOR / "tools" / "record.mjs", "spade-rain", "--png-dir", self.temp.root,
                          "--max-frames", "1", "--no-audio", "--quiet")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn(b"f0000.png", result.stderr)
        self.assertEqual(first.read_bytes(), b"older recording")
