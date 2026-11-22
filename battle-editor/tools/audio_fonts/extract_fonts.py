#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""extract_fonts.py — 匯出 DELTARUNE 點陣字體（字形貼圖 PNG + 字形表 JSON）到
battle-editor/assets/fonts/<out>/。

規則來源：tools/audio_fonts/config/fonts_rules.json
  fonts: [{ name, chapter, out, role, note }]

同一字體名稱在不同章節的字集大小差很多（ch1 的 fnt_main 有 2532 glyph，
ch5 只有 96），所以規則是「(字體名, 章節) → 輸出目錄」的明確對應。

冪等：輸出目錄已存在且含 glyphs.png/glyphs.json 則跳過（--force 覆寫）。
單獨執行：python tools/audio_fonts/extract_fonts.py [--force]
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import (  # noqa: E402
    CHAPTERS, CONFIG_DIR, FONT_DIR, chapter_data_win, ensure_dirs, load_json,
    log, rel_to_root, run_utmt, write_json,
)

RULES_PATH = CONFIG_DIR / "fonts_rules.json"
EXPORT_CSX = HERE / "utmt" / "export_fonts.csx"
MANIFEST = HERE / "manifest_fonts.json"


def main(argv: list[str]) -> int:
    force = "--force" in argv
    ensure_dirs()
    rules = load_json(RULES_PATH)
    if rules is None:
        raise SystemExit(f"找不到規則檔：{RULES_PATH}")
    font_specs = rules.get("fonts") or []
    if not font_specs:
        raise SystemExit(f"{RULES_PATH} 沒有 fonts 清單")

    # 依章節分組（同一章節一次 UTMT 呼叫最省時間）
    by_chapter: dict[int, list[dict]] = {}
    for spec in font_specs:
        by_chapter.setdefault(int(spec["chapter"]), []).append(spec)

    tmp_dir = HERE / "catalog" / "font_lists"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    results: dict[str, dict] = {}
    for ch in sorted(by_chapter, reverse=True):
        data_win = chapter_data_win(ch)
        if not data_win.exists():
            log(f"[fonts] ch{ch} data.win 不存在，跳過")
            continue
        specs = by_chapter[ch]
        list_path = tmp_dir / f"ch{ch}.txt"
        list_path.write_text(
            "\n".join(f"{s['name']}|{s.get('out') or s['name']}" for s in specs) + "\n",
            encoding="utf-8")
        env = {
            "UTMT_FONT_OUT": str(FONT_DIR),
            "UTMT_FONT_LIST": str(list_path),
            "UTMT_CHAPTER": f"ch{ch}",
            "UTMT_SKIP_EXISTING": "0" if force else "1",
        }
        log_path = tmp_dir / f"ch{ch}.log"
        rc = run_utmt(data_win, [EXPORT_CSX], env=env, log_path=log_path)
        if rc != 0:
            log(f"[fonts] ch{ch} 匯出失敗，見 {log_path}")
            continue

        for spec in specs:
            out = spec.get("out") or spec["name"]
            json_path = FONT_DIR / out / "glyphs.json"
            png_path = FONT_DIR / out / "glyphs.png"
            if not (json_path.exists() and png_path.exists()):
                log(f"[fonts] 缺少輸出：{out}")
                continue
            info = json.loads(json_path.read_text(encoding="utf-8"))
            results[out] = {
                "sourceFont": spec["name"],
                "chapter": f"ch{ch}",
                "role": spec.get("role", ""),
                "note": spec.get("note", ""),
                "image": f"fonts/{out}/glyphs.png",
                "glyphs": f"fonts/{out}/glyphs.json",
                "size": info.get("size"),
                "emSize": info.get("emSize"),
                "lineHeight": info.get("lineHeight"),
                "glyphCount": info.get("glyphCount"),
                "imageW": info.get("image", {}).get("w"),
                "imageH": info.get("image", {}).get("h"),
                "bold": info.get("bold"),
                "italic": info.get("italic"),
            }

    total_bytes = 0
    for out in results:
        for fn in ("glyphs.png", "glyphs.json"):
            p = FONT_DIR / out / fn
            if p.exists():
                total_bytes += p.stat().st_size

    manifest = {
        "format": "dr-battle-font-manifest/1",
        "count": len(results),
        "bytes": total_bytes,
        "fonts": results,
    }
    write_json(MANIFEST, manifest)
    log(f"[fonts] 完成 {len(results)} 個字體，合計 {total_bytes / 1024:.1f}KB")
    log(f"[fonts] manifest -> {rel_to_root(MANIFEST)}")
    for out, rec in results.items():
        log(f"        {out:22s} <- {rec['sourceFont']} ({rec['chapter']}) "
            f"{rec['glyphCount']:4d} glyph  {rec['imageW']}x{rec['imageH']}  "
            f"em={rec['emSize']} lh={rec['lineHeight']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
