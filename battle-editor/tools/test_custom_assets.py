#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""tools/test_custom_assets.py — V2-01 自訂音訊與自由 tag 的測試。

範圍：
  * build_custom_assets.py：掃描 music/sfx、audio.json 的 loopStart/loopEnd（秒）/
    volume/tags/desc、music 預設整首循環、自由 tag（未知 tag 只提醒、仍寫入索引）、
    冪等與孤兒清理、dry-run、各種錯誤、--audio 自訂 metadata 路徑
  * build_assets.py：merge_custom_index 把自訂 audio 併進主索引、loop 點原樣保留、
    官方 audio 不被覆蓋、重跑冪等、刪掉自訂條目後清孤兒
  * 端到端：用臨時目錄跑 build_assets.py 重建 index.json，驗證自訂 BGM 與 loop 點
    在建置後沒有遺失（重建後 index.json 仍看得到 loopStart/loopEnd）

所有輸出都在 %TEMP%\\V2-01\\（或系統暫存目錄）底下，不寫入 repo 的 assets/；
只用標準庫（音訊用 wave 現產生 1 秒靜音 WAV，PNG 用內嵌的 1x1 位元組）。

執行：
    python tools/test_custom_assets.py
    python tools/test_custom_assets.py -v
    python tools/test_custom_assets.py EndToEndRebuildTests
"""
from __future__ import annotations

import base64
import copy
import json
import os
import subprocess
import sys
import tempfile
import unittest
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
PROJECT = HERE.parent
sys.path.insert(0, str(HERE))

import build_assets  # noqa: E402  (測試 build_assets.merge_custom_index 等函式)

BUILDER = HERE / "build_custom_assets.py"
ASSETS_DIR = PROJECT / "assets"

# 1x1 透明 PNG（IHDR 尺寸 1x1；build_custom_assets.py 直接解析檔頭，不需要 Pillow）
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)

# 1 秒 8kHz 單聲道 16-bit 靜音 WAV 的位元組數：8000 * 2 + 44 = 16044
SILENT_WAV_BYTES = 16044

REQUIRED_SPRITES = ["spr_heart", "spr_spadebullet", "spr_battlebg_0", "spr_btheart", "spr_btfight"]


def make_workdir(prefix: str) -> Path:
    """在 %TEMP%/V2-01/ 底下開一個新的工作目錄（不刪除，測試結束後留在暫存區）。"""
    base = Path(os.environ.get("TEMP") or tempfile.gettempdir()) / "V2-01"
    base.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=prefix, dir=str(base)))


def write_silent_wav(path: Path, seconds: float = 1.0, rate: int = 8000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as fh:
        fh.setnchannels(1)
        fh.setsampwidth(2)
        fh.setframerate(rate)
        fh.writeframes(bytes(int(rate * seconds) * 2))


def load_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def custom_audio_payload(**overrides) -> dict:
    """端到端測試用：一份「有 loop 點 + 自由 tag」的自訂音訊索引。"""
    entry = {
        "file": "custom/music/calm.wav",
        "kind": "music",
        "loop": True,
        "loopStart": 0.25,
        "loopEnd": 0.75,
        "volume": 0.6,
        "tags": ["boss", "weirdtag"],
        "desc": "測試用 BGM",
        "bytes": SILENT_WAV_BYTES,
        "custom": True,
    }
    entry.update(overrides)
    return {"format": "dr-battle-assets/1", "sprites": {}, "audio": {"calm": entry}}


class BuilderTests(unittest.TestCase):
    """build_custom_assets.py 的端到端測試（只寫暫存目錄）。"""

    def setUp(self):
        self.root = make_workdir("builder-")
        self.source = self.root / "custom"
        (self.source / "music").mkdir(parents=True)
        (self.source / "sfx").mkdir(parents=True)
        write_silent_wav(self.source / "music" / "calm.wav")
        write_silent_wav(self.source / "sfx" / "hit.wav")
        (self.source / "dot.png").write_bytes(PNG_1X1)
        self.out = self.root / "custom.index.json"

    # ------------------------------------------------------------------ 工具
    def build(self, *extra) -> subprocess.CompletedProcess:
        cmd = [sys.executable, str(BUILDER), "--root", str(self.root)]
        cmd.extend(str(item) for item in extra)
        return subprocess.run(cmd, cwd=str(PROJECT), capture_output=True, text=True, encoding="utf-8")

    def build_ok(self, *extra) -> dict:
        result = self.build(*extra)
        self.assertEqual(result.returncode, 0, msg=result.stdout + "\n" + result.stderr)
        self.assertTrue(self.out.is_file(), msg="建置成功但沒有輸出 custom.index.json")
        return load_json(self.out)

    def build_fails(self, expected: str, *extra) -> subprocess.CompletedProcess:
        result = self.build(*extra)
        self.assertEqual(result.returncode, 1, msg=result.stdout + "\n" + result.stderr)
        self.assertIn(expected, result.stdout + result.stderr)
        return result

    def write_audio(self, payload) -> Path:
        path = self.source / "audio.json"
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    def write_sprites(self, payload) -> Path:
        path = self.source / "sprites.json"
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    # ------------------------------------------------------------------ 基本
    def test_audio_auto_scan_and_defaults(self):
        index = self.build_ok()
        self.assertEqual(index["format"], "dr-battle-assets/1")
        self.assertEqual(sorted(index["audio"]), ["calm", "hit"])

        calm = index["audio"]["calm"]
        self.assertEqual(calm["file"], "custom/music/calm.wav")
        self.assertEqual(calm["kind"], "music")
        self.assertTrue(calm["loop"], msg="music 預設應整首循環")
        self.assertNotIn("loopStart", calm)
        self.assertNotIn("loopEnd", calm)
        self.assertEqual(calm["tags"], ["music"])
        self.assertEqual(calm["bytes"], SILENT_WAV_BYTES)
        self.assertIs(calm["custom"], True)

        hit = index["audio"]["hit"]
        self.assertEqual(hit["file"], "custom/sfx/hit.wav")
        self.assertEqual(hit["kind"], "sfx")
        self.assertFalse(hit["loop"], msg="sfx 預設不循環")
        self.assertEqual(hit["tags"], ["sfx"])

        # sprite 仍然照舊產出
        self.assertIn("dot", index["sprites"])
        self.assertEqual(index["sprites"]["dot"]["frames"], ["custom/dot.png"])

    def test_audio_json_loop_volume_tags_desc(self):
        self.write_audio(
            {
                "format": "dr-battle-assets/1",
                "audio": {
                    "calm": {
                        "loopStart": 0.25,
                        "loopEnd": 0.75,
                        "volume": 0.6,
                        "tags": ["boss", "weirdtag"],
                        "desc": "先播前奏再循環",
                    },
                    "hit": {"volume": 0.8, "tags": ["impact"]},
                },
            }
        )
        index = self.build_ok()
        calm = index["audio"]["calm"]
        self.assertEqual(calm["loopStart"], 0.25)
        self.assertEqual(calm["loopEnd"], 0.75)
        self.assertIsInstance(calm["loopStart"], float)
        self.assertIsInstance(calm["loopEnd"], float)
        self.assertEqual(calm["volume"], 0.6)
        self.assertEqual(calm["tags"], ["boss", "weirdtag"])
        self.assertEqual(calm["desc"], "先播前奏再循環")
        self.assertTrue(calm["loop"])
        self.assertEqual(index["audio"]["hit"]["volume"], 0.8)
        self.assertEqual(index["audio"]["hit"]["tags"], ["impact"])

    def test_unknown_audio_tag_warned_but_written(self):
        self.write_audio({"audio": {"calm": {"tags": ["futuretag"]}}})
        result = self.build()
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("未知音訊 tag", result.stdout)
        self.assertIn("futuretag", result.stdout)
        self.assertIn("仍會照樣寫入索引", result.stdout)
        index = load_json(self.out)
        self.assertIn("futuretag", index["audio"]["calm"]["tags"], msg="未知 tag 仍應寫入索引")

    def test_known_audio_tag_not_warned(self):
        self.write_audio({"audio": {"calm": {"tags": ["battle", "boss"]}}})
        result = self.build()
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertNotIn("未知音訊 tag", result.stdout)

    def test_free_sprite_tag_warned_but_written(self):
        self.write_sprites(
            {"sprites": {"dot": {"tags": ["enemy", "weirdtag"], "desc": "自訂 tag 的圖"}}}
        )
        result = self.build()
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("未知 tag", result.stdout)
        self.assertIn("weirdtag", result.stdout)
        sprite = load_json(self.out)["sprites"]["dot"]
        self.assertEqual(sprite["tags"], ["enemy", "weirdtag"])
        self.assertEqual(sprite["desc"], "自訂 tag 的圖")

    def test_audio_json_flat_form_and_unknown_field_warning(self):
        self.write_audio({"calm": {"volume": 0.7, "desc": "扁平寫法", "unknownField": 1}})
        result = self.build()
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("未知欄位", result.stdout)
        calm = load_json(self.out)["audio"]["calm"]
        self.assertEqual(calm["volume"], 0.7)
        self.assertEqual(calm["desc"], "扁平寫法")
        self.assertTrue(calm["loop"], msg="music 沒指定 loop 時仍應預設循環")

    def test_audio_json_file_reference_rename(self):
        self.write_audio({"audio": {"calm2": {"file": "music/calm.wav", "kind": "music", "volume": 0.5}}})
        index = self.build_ok()
        calm2 = index["audio"]["calm2"]
        self.assertEqual(calm2["file"], "custom/music/calm.wav")
        self.assertEqual(calm2["kind"], "music")
        self.assertEqual(calm2["volume"], 0.5)
        self.assertEqual(calm2["bytes"], SILENT_WAV_BYTES)
        self.assertIn("calm", index["audio"], msg="原本自動掃到的 calm 仍應保留")

    def test_audio_json_file_for_scanned_name_errors(self):
        self.write_audio({"audio": {"calm": {"file": "music/calm.wav"}}})
        self.build_fails("同名音檔已自動掃到")

    def test_duplicate_name_across_folders_errors(self):
        write_silent_wav(self.source / "sfx" / "calm.wav")
        self.build_fails("名稱重複")

    def test_loop_validation_errors(self):
        cases = [
            ({"calm": {"loopStart": 0.6, "loopEnd": 0.4}}, "loopEnd"),
            ({"calm": {"loopStart": -0.1}}, "loopStart"),
            ({"calm": {"loopEnd": 0}}, "loopEnd"),
            ({"calm": {"volume": 1.5}}, "volume"),
            ({"calm": {"loop": "yes"}}, "loop"),
        ]
        for audio, expected in cases:
            with self.subTest(audio=audio):
                self.write_audio({"audio": audio})
                self.build_fails(expected)
        self.assertFalse(self.out.exists(), msg="參數錯誤時不應留下索引")

    def test_non_music_loop_points_only_warn(self):
        self.write_audio({"audio": {"hit": {"loopStart": 0.1, "loopEnd": 0.5}}})
        result = self.build()
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("只對 BGM", result.stdout)
        hit = load_json(self.out)["audio"]["hit"]
        self.assertEqual(hit["loopStart"], 0.1)
        self.assertEqual(hit["loopEnd"], 0.5)
        self.assertFalse(hit["loop"])

    def test_unsupported_extension_warned_and_ignored(self):
        (self.source / "music" / "notes.txt").write_text("not audio", encoding="utf-8")
        result = self.build()
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertIn("不支援的音訊格式", result.stdout)
        index = load_json(self.out)
        self.assertEqual(sorted(index["audio"]), ["calm", "hit"])

    def test_remove_audio_file_rerun_drops_entry(self):
        index = self.build_ok()
        self.assertIn("calm", index["audio"])
        (self.source / "music" / "calm.wav").unlink()
        index = self.build_ok()
        self.assertNotIn("calm", index["audio"])
        self.assertIn("hit", index["audio"])

    def test_dry_run_writes_nothing(self):
        result = self.build("--dry-run")
        self.assertEqual(result.returncode, 0, msg=result.stdout + result.stderr)
        self.assertFalse(self.out.exists(), msg="--dry-run 不應寫入索引")
        self.assertIn("dry-run", result.stdout)

    def test_audio_metadata_path_option(self):
        alt = self.root / "alt-audio.json"
        alt.write_text(json.dumps({"audio": {"calm": {"volume": 0.3}}}), encoding="utf-8")
        index = self.build_ok("--audio", str(alt))
        self.assertEqual(index["audio"]["calm"]["volume"], 0.3)

    def test_empty_source_exits_2(self):
        empty_root = make_workdir("empty-")
        (empty_root / "custom").mkdir()
        cmd = [sys.executable, str(BUILDER), "--root", str(empty_root)]
        result = subprocess.run(cmd, cwd=str(PROJECT), capture_output=True, text=True, encoding="utf-8")
        self.assertEqual(result.returncode, 2, msg=result.stdout + result.stderr)


class MergeTests(unittest.TestCase):
    """build_assets.py 的 merge_custom_index / merge_audio_fonts（不跑完整建置）。"""

    def setUp(self):
        self.out = make_workdir("merge-")

    def write_custom(self, payload) -> Path:
        path = self.out / "custom.index.json"
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    @staticmethod
    def official_index() -> dict:
        return {
            "format": "dr-battle-assets/1",
            "sprites": {},
            "fonts": {},
            "audio": {
                "battle": {
                    "file": "audio/mus/battle.ogg",
                    "kind": "music",
                    "loop": True,
                    "tags": ["battle"],
                    "bytes": 1835051,
                }
            },
        }

    def test_merge_custom_audio_preserves_loop_points_and_official(self):
        self.write_custom(custom_audio_payload())
        index = self.official_index()
        official_before = copy.deepcopy(index["audio"]["battle"])
        stats: dict = {}
        merged = build_assets.merge_custom_index(self.out, index, stats, source_dir=self.out)
        self.assertTrue(merged)
        self.assertEqual(index["audio"]["battle"], official_before, msg="官方 audio 不應被改動")
        calm = index["audio"]["calm"]
        self.assertTrue(calm["custom"])
        self.assertEqual(calm["kind"], "music")
        self.assertEqual(calm["loopStart"], 0.25)
        self.assertEqual(calm["loopEnd"], 0.75)
        self.assertEqual(calm["volume"], 0.6)
        self.assertEqual(calm["tags"], ["boss", "weirdtag"])
        self.assertEqual(stats["custom_audio"], 1)
        self.assertEqual(stats["custom_audio_music"], 1)
        self.assertEqual(stats["custom_audio_sfx"], 0)
        self.assertEqual(stats["custom_audio_loops"], 1)

    def test_merge_is_idempotent_and_drops_orphans(self):
        self.write_custom(custom_audio_payload())
        index = self.official_index()
        build_assets.merge_custom_index(self.out, index, {}, source_dir=self.out)
        build_assets.merge_custom_index(self.out, index, {}, source_dir=self.out)
        self.assertEqual(sorted(index["audio"]), ["battle", "calm"])
        self.assertEqual(index["audio"]["calm"]["loopStart"], 0.25)

        # 使用者把音訊刪掉了：custom.index.json 只剩空 audio，重建後不應留下孤兒
        self.write_custom({"format": "dr-battle-assets/1", "sprites": {}, "audio": {}})
        stats: dict = {}
        build_assets.merge_custom_index(self.out, index, stats, source_dir=self.out)
        self.assertNotIn("calm", index["audio"])
        self.assertIn("battle", index["audio"])
        self.assertEqual(stats["custom_audio"], 0)
        self.assertEqual(stats["custom_audio_loops"], 0)

    def test_merge_custom_sprites_still_work(self):
        self.write_custom(
            {
                "format": "dr-battle-assets/1",
                "sprites": {
                    "dot": {
                        "frames": ["custom/dot.png"],
                        "w": 1,
                        "h": 1,
                        "ox": 0,
                        "oy": 0,
                        "chapter": "custom",
                        "tags": ["bullet", "weirdtag"],
                    }
                },
                "audio": {},
            }
        )
        index = self.official_index()
        stats: dict = {}
        build_assets.merge_custom_index(self.out, index, stats, source_dir=self.out)
        self.assertIn("dot", index["sprites"])
        self.assertTrue(index["sprites"]["dot"]["custom"])
        self.assertEqual(stats["custom_sprites"], 1)
        self.assertEqual(stats["custom_frames"], 1)
        self.assertEqual(stats["custom_audio"], 0)

    def test_merge_without_custom_index_returns_false(self):
        index = self.official_index()
        before = copy.deepcopy(index)
        merged = build_assets.merge_custom_index(self.out, index, {}, source_dir=self.out)
        self.assertFalse(merged)
        self.assertEqual(index, before)

    def test_bad_format_skipped(self):
        self.write_custom({"format": "nope", "sprites": {}, "audio": {"calm": {"kind": "music"}}})
        index = self.official_index()
        merged = build_assets.merge_custom_index(self.out, index, {}, source_dir=self.out)
        self.assertFalse(merged)
        self.assertNotIn("calm", index["audio"])

    def test_audio_fonts_then_custom_keeps_both(self):
        (self.out / "audio-fonts.index.json").write_text(
            json.dumps(
                {
                    "format": "dr-battle-assets-audio/1",
                    "audio": {
                        "official_x": {
                            "file": "audio/mus/original.ogg",
                            "kind": "music",
                            "loop": True,
                            "tags": ["battle"],
                            "bytes": 1,
                        }
                    },
                    "fonts": {"font_0": {"file": "fonts/font_0.ttf"}},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        self.write_custom(custom_audio_payload())
        index = {"format": "dr-battle-assets/1", "sprites": {}, "audio": {}, "fonts": {}}
        self.assertTrue(build_assets.merge_audio_fonts(self.out, index))
        self.assertIn("official_x", index["audio"])
        build_assets.merge_custom_index(self.out, index, {}, source_dir=self.out)
        # merge_audio_fonts 會整個換掉 audio；merge_custom_index 在其後執行，兩者都要在
        self.assertEqual(sorted(index["audio"]), ["calm", "official_x"])
        self.assertIn("font_0", index["fonts"])
        self.assertEqual(index["audio"]["calm"]["loopStart"], 0.25)


class EndToEndRebuildTests(unittest.TestCase):
    """真的跑一次 build_assets.py（暫存 source/out），確認重建後自訂 BGM 與 loop 點還在。"""

    def _build_once(self, work: Path, out: Path, source: Path, custom: dict) -> subprocess.CompletedProcess:
        (out / "custom.index.json").write_text(
            json.dumps(custom, ensure_ascii=False), encoding="utf-8"
        )
        cmd = [
            sys.executable,
            str(HERE / "build_assets.py"),
            "--source",
            str(source),
            "--origins",
            str(work / "missing-origins.json"),
            "--out",
            str(out),
            "--allow-missing-sprites-full",
        ]
        return subprocess.run(cmd, cwd=str(PROJECT), capture_output=True, text=True, encoding="utf-8", timeout=180)

    def test_cli_rebuild_keeps_custom_bgm_loop(self):
        work = make_workdir("e2e-")
        source = work / "official"
        sprite_dir = source / "sprites" / "ch1" / "all_sprites"
        sprite_dir.mkdir(parents=True)
        for name in REQUIRED_SPRITES:
            (sprite_dir / f"{name}.png").write_bytes(PNG_1X1)
        out = work / "out"
        out.mkdir()

        result = self._build_once(work, out, source, custom_audio_payload())
        self.assertEqual(result.returncode, 0, msg=result.stdout + "\n" + result.stderr)
        self.assertIn("自訂素材", result.stdout)
        self.assertIn("loop 點 1 個", result.stdout)

        index = load_json(out / "index.json")
        calm = index["audio"]["calm"]
        self.assertTrue(calm["custom"])
        self.assertEqual(calm["file"], "custom/music/calm.wav")
        self.assertEqual(calm["loopStart"], 0.25)
        self.assertEqual(calm["loopEnd"], 0.75)
        self.assertEqual(calm["volume"], 0.6)
        self.assertEqual(calm["tags"], ["boss", "weirdtag"])
        for name in REQUIRED_SPRITES:
            self.assertIn(name, index["sprites"])

        if (ASSETS_DIR / "audio-fonts.index.json").is_file():
            self.assertIn("battle", index["audio"], msg="官方 audio 應該還在")

        # 重跑：自訂音訊被移除後，主索引不應留下孤兒；官方音訊照舊
        result = self._build_once(work, out, source, {"format": "dr-battle-assets/1", "sprites": {}, "audio": {}})
        self.assertEqual(result.returncode, 0, msg=result.stdout + "\n" + result.stderr)
        index = load_json(out / "index.json")
        self.assertNotIn("calm", index["audio"])
        if (ASSETS_DIR / "audio-fonts.index.json").is_file():
            self.assertIn("battle", index["audio"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
