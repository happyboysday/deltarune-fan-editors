#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""catalog.py — 掃描 assets-official/02-audio 下各章 data.win 的 Sound/Font 資源清單。

產出（冪等，寫在 tools/audio_fonts/catalog/）：
  probe_ch<N>.json    UTMT probe.csx 的原始輸出（每章一份）
  snd_availability.json  { name: { firstChapter, chapters: [...], embeddedIn: [...] } }
  fonts_availability.json { name: { chapters: [...] } }
  ALL_SND_NAMES.txt     所有章節 snd 名稱聯集（排序）
  ALL_FONT_NAMES.txt    所有章節字體名稱聯集（排序）

單獨執行：
  python tools/audio_fonts/catalog.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import (  # noqa: E402
    CHAPTERS, ROOT, UTMT_CLI, UTMT_DIR, UTMT_SCRIPTS, OFFICIAL_AUDIO, CATALOG_DIR,
    run_utmt, rel_to_root, chapter_data_win, log,
)

PROBE_CSX = UTMT_SCRIPTS / "probe.csx"


def probe_chapter(ch: int, force: bool = False) -> dict:
    """對單一 ch 跑 probe.csx，回傳 probe.json 內容。"""
    out_dir = CATALOG_DIR / f"probe_ch{ch}"
    out_json = out_dir / "probe.json"
    if out_json.exists() and not force:
        try:
            return json.loads(out_json.read_text(encoding="utf-8"))
        except Exception:
            pass
    data_win = chapter_data_win(ch)
    if not data_win.exists():
        log(f"[catalog] ch{ch} data.win 不存在，跳過：{data_win}")
        return {"sounds": [], "fonts": []}
    out_dir.mkdir(parents=True, exist_ok=True)
    env = {"UTMT_OUT": str(out_dir)}
    log_path = out_dir / "log.txt"
    run_utmt(data_win, [PROBE_CSX], env=env, log_path=log_path)
    if not out_json.exists():
        log(f"[catalog] ch{ch} probe 未產生 probe.json，見 {log_path}")
        return {"sounds": [], "fonts": []}
    return json.loads(out_json.read_text(encoding="utf-8"))


def main(argv: list[str]) -> int:
    force = "--force" in argv
    CATALOG_DIR.mkdir(parents=True, exist_ok=True)

    probes: dict[int, dict] = {}
    for ch in CHAPTERS:
        probes[ch] = probe_chapter(ch, force=force)
        log(f"[catalog] ch{ch}: sounds={len(probes[ch].get('sounds', []))} "
            f"fonts={len(probes[ch].get('fonts', []))}")

    # ── 音效可用性（章節由新到舊）──
    snd_avail: dict[str, dict] = {}
    for ch in reversed(CHAPTERS):  # 5 → 1，先寫入者為較新章節
        for s in probes[ch].get("sounds", []):
            name = s["name"]
            rec = snd_avail.setdefault(name, {"firstChapter": ch, "chapters": [], "variants": {}})
            rec["chapters"].append(ch)
            # 資料所在位置：inDataWin（內嵌 data.win）或 audiogroupN
            if s.get("inDataWin"):
                loc = "data.win"
            elif s.get("group", 0) > 0:
                loc = f"audiogroup{s.get('group')}"
            else:
                loc = "external"
            rec["variants"][str(ch)] = {
                "loc": loc,
                "group": s.get("group"),
                "audioId": s.get("audioId"),
                "file": s.get("file", ""),
                "compressed": bool(s.get("compressed")),
                "embedded": bool(s.get("embedded")),
            }
    # chapters 排序回舊→新
    for rec in snd_avail.values():
        rec["chapters"] = sorted(rec["chapters"], reverse=True)  # 新→舊

    # ── 字體可用性 ──
    font_avail: dict[str, dict] = {}
    for ch in reversed(CHAPTERS):
        for f in probes[ch].get("fonts", []):
            rec = font_avail.setdefault(f["name"], {"firstChapter": ch, "chapters": [], "meta": {}})
            rec["chapters"].append(ch)
            rec["meta"].setdefault(str(ch), {
                "emSize": f.get("emSize"),
                "lineHeight": f.get("lineHeight"),
                "glyphCount": f.get("glyphCount"),
            })
    for rec in font_avail.values():
        rec["chapters"] = sorted(rec["chapters"], reverse=True)

    (CATALOG_DIR / "snd_availability.json").write_text(
        json.dumps(snd_avail, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")
    (CATALOG_DIR / "fonts_availability.json").write_text(
        json.dumps(font_avail, ensure_ascii=False, indent=1, sort_keys=True), encoding="utf-8")

    (CATALOG_DIR / "ALL_SND_NAMES.txt").write_text(
        "\n".join(sorted(snd_avail)) + "\n", encoding="utf-8")
    (CATALOG_DIR / "ALL_FONT_NAMES.txt").write_text(
        "\n".join(sorted(font_avail)) + "\n", encoding="utf-8")

    log(f"[catalog] 音效名稱聯集 {len(snd_avail)}，字體名稱聯集 {len(font_avail)}")
    log(f"[catalog] 輸出目錄：{rel_to_root(CATALOG_DIR)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
