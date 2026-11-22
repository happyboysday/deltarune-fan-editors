#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_index.py — 產生 battle-editor/assets/audio-fonts.index.json。

輸入：
  tools/audio_fonts/manifest_music.json   由 extract_music.py 產生
  tools/audio_fonts/manifest_sfx.json     由 extract_sfx.py 產生
  tools/audio_fonts/manifest_fonts.json   由 extract_fonts.py 產生
  tools/audio_fonts/manifest_zh_fonts.json 由 extract_zh_fonts.py 產生（可缺）

輸出格式（路徑一律相對於 battle-editor/assets/）：
{
  "format": "dr-battle-assets-audio/1",
  "generated": "<UTC ISO8601>",
  "audio": {
     "snd_hurt1": { "file": "audio/snd/snd_hurt1.wav", "kind": "sfx",
                    "chapter": "ch5", "src": "audiogroup1",
                    "groups": ["hurt"], "desc": "遊玩者受傷…", "bytes": 52412 },
     "battle":    { "file": "audio/mus/battle.ogg", "kind": "music",
                    "loop": true, "tags": ["battle"], "bytes": 1835008 }
  },
  "fonts": {
     "fnt_main": { "image": "fonts/fnt_main/glyphs.png",
                   "glyphs": "fonts/fnt_main/glyphs.json",
                   "size": 12, "lineHeight": 16, "emSize": 12,
                   "glyphCount": 96, "imageW": 128, "imageH": 128,
                   "sourceFont": "fnt_main", "chapter": "ch5",
                   "bold": false, "italic": false,
                   "cjk": { "sample": 450, "hit": 0, "pct": 0.0 } },
     "fnt_main@zh": { ...同上 dr-battle-font/1..., "lang": "zh",
                      "base": "fnt_main", "glyphCount": 3580, "hanCount": 3272,
                      "coverage": { "simp": {...}, "trad": {...} } },
     "DTM": { "kind": "otf", "file": "fonts/DTM.otf", "lang": "zh" }
  },
  "meta": { ... 統計與注意事項 ... }
}

冪等：內容相同時不重寫檔案（避免 git 變動噪音）。
單獨執行：python tools/audio_fonts/build_index.py
"""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import (  # noqa: E402
    AUDIO_FONTS_INDEX, BATTLE_EDITOR, FONT_DIR, load_json, log, rel_to_root,
    write_json,
)

FORMAT = "dr-battle-assets-audio/1"
MANIFEST_MUSIC = HERE / "manifest_music.json"
MANIFEST_SFX = HERE / "manifest_sfx.json"
MANIFEST_FONTS = HERE / "manifest_fonts.json"
MANIFEST_ZH_FONTS = HERE / "manifest_zh_fonts.json"
SPEC_MD = BATTLE_EDITOR / "docs" / "SPEC.md"


def spec_chars() -> str:
    """從 SPEC.md 抽出非 ASCII 字元，作為 CJK 覆蓋率樣本。"""
    if not SPEC_MD.exists():
        return ""
    text = SPEC_MD.read_text(encoding="utf-8")
    return "".join(sorted({c for c in text if ord(c) > 0x7F and not c.isspace()}))


def cjk_stats(font_json: Path, chars: str) -> dict | None:
    if not chars or not font_json.exists():
        return None
    try:
        data = json.loads(font_json.read_text(encoding="utf-8"))
    except Exception:
        return None
    have = {int(k) for k, g in data.get("glyphs", {}).items() if g.get("w", 0) > 0}
    hit = sum(1 for c in chars if ord(c) in have)
    return {
        "sample": len(chars),
        "hit": hit,
        "pct": round(100.0 * hit / len(chars), 1) if chars else 0.0,
    }


def main() -> int:
    music = load_json(MANIFEST_MUSIC)
    sfx = load_json(MANIFEST_SFX)
    fonts = load_json(MANIFEST_FONTS)
    zh_fonts = load_json(MANIFEST_ZH_FONTS)
    missing = [name for name, obj in
               (("manifest_music.json", music), ("manifest_sfx.json", sfx),
                ("manifest_fonts.json", fonts)) if not obj]
    if missing:
        log(f"[index] 缺少輸入：{', '.join(missing)}；請先跑對應的 extract_*.py")
        if not (music or sfx or fonts):
            return 1
    if not zh_fonts:
        log("[index] 提示：沒有 manifest_zh_fonts.json（中文字體未擷取），index 不含 @zh 字體")

    chars = spec_chars()

    audio: dict[str, dict] = {}
    for name, rec in (music or {}).get("tracks", {}).items():
        audio[name] = {
            "file": rec["file"],
            "kind": "music",
            "loop": bool(rec.get("loop", True)),
            "tags": rec.get("tags") or [],
            "bytes": rec.get("bytes", 0),
        }
    for name, rec in (sfx or {}).get("sounds", {}).items():
        audio[name] = {
            "file": rec["file"],
            "kind": "sfx",
            "chapter": rec.get("chapter"),
            "src": rec.get("src"),
            "groups": rec.get("groups") or [],
            "desc": rec.get("desc", ""),
            "bytes": rec.get("bytes", 0),
        }

    font_entries: dict[str, dict] = {}
    for out, rec in (fonts or {}).get("fonts", {}).items():
        entry = {
            "image": rec["image"],
            "glyphs": rec["glyphs"],
            "size": rec.get("size"),
            "lineHeight": rec.get("lineHeight"),
            "emSize": rec.get("emSize"),
            "glyphCount": rec.get("glyphCount"),
            "imageW": rec.get("imageW"),
            "imageH": rec.get("imageH"),
            "sourceFont": rec.get("sourceFont"),
            "chapter": rec.get("chapter"),
            "bold": rec.get("bold", False),
            "italic": rec.get("italic", False),
            "role": rec.get("role", ""),
        }
        stats = cjk_stats(FONT_DIR / out / "glyphs.json", chars)
        if stats:
            entry["cjk"] = stats
        font_entries[out] = entry

    # ── 中文字體（@zh）＋ DTM.otf ──
    zh_entries: dict[str, dict] = {}
    otf_entry: dict | None = None
    if zh_fonts:
        for out, rec in (zh_fonts.get("fonts") or {}).items():
            entry = {
                "image": rec["image"],
                "glyphs": rec["glyphs"],
                "size": rec.get("size"),
                "lineHeight": rec.get("lineHeight"),
                "emSize": rec.get("emSize"),
                "glyphCount": rec.get("glyphCount"),
                "hanCount": rec.get("hanCount"),
                "imageW": rec.get("imageW"),
                "imageH": rec.get("imageH"),
                "sourceFont": rec.get("sourceFont"),
                "sourceChapter": rec.get("sourceChapter"),
                "chapter": rec.get("sourceChapter"),
                "lang": "zh",
                "base": rec.get("base"),
                "bold": rec.get("bold", False),
                "italic": rec.get("italic", False),
                "role": rec.get("role", ""),
                "coverage": rec.get("coverage") or {},
            }
            zh_entries[out] = entry
        font_entries.update(zh_entries)
        if zh_fonts.get("otf"):
            otf_entry = dict(zh_fonts["otf"])
            otf_entry["name"] = "DTM"
            otf_entry["role"] = "中文 OTF 退回字體（點陣缺字時 fillText）"
            font_entries["DTM"] = otf_entry

    # 音效群組 → 名稱索引，方便引擎依用途挑選
    groups: dict[str, list[str]] = {}
    for name, rec in audio.items():
        if rec["kind"] != "sfx":
            continue
        for g in rec.get("groups") or []:
            groups.setdefault(g, []).append(name)
    for g in groups:
        groups[g].sort()

    # 建議核心音效（config/sfx_rules.json 的 core 清單，只保留實際擷取到的）
    core: list[str] = []
    rules_path = HERE / "config" / "sfx_rules.json"
    try:
        rules = json.loads(rules_path.read_text(encoding="utf-8"))
        core = [n for n in (rules.get("core") or []) if n in audio]
    except Exception:
        core = []

    music_count = sum(1 for v in audio.values() if v["kind"] == "music")
    sfx_count = sum(1 for v in audio.values() if v["kind"] == "sfx")
    audio_bytes = sum(v.get("bytes", 0) for v in audio.values())
    font_bytes = 0
    for out in font_entries:
        for fn in ("glyphs.png", "glyphs.json"):
            p = FONT_DIR / out / fn
            if p.exists():
                font_bytes += p.stat().st_size
    if otf_entry:
        font_bytes += int(otf_entry.get("bytes") or 0)
    bitmap_fonts = [k for k in font_entries if not k.endswith("@zh") and k != "DTM"]
    zh_font_count = len(zh_entries)
    # 繁體/簡體覆蓋率摘要（取 fnt_main@zh 為代表）
    cov_simp = cov_trad = None
    rep = zh_entries.get("fnt_main@zh") or (next(iter(zh_entries.values())) if zh_entries else None)
    if rep:
        cov = rep.get("coverage") or {}
        cov_simp = cov.get("simp")
        cov_trad = cov.get("trad")

    index = {
        "format": FORMAT,
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "audio": audio,
        "fonts": font_entries,
        "groups": groups,
        "core": core,
        "meta": {
            "source": "DELTARUNE (official game data, local use only)",
            "musicCount": music_count,
            "sfxCount": sfx_count,
            "fontCount": len(bitmap_fonts),
            "zhFontCount": zh_font_count,
            "audioBytes": audio_bytes,
            "fontBytes": font_bytes,
            "fontImageAlphaOnly": True,
            "fontImageNote": (
                "glyphs.png 為 RGBA，RGB 全白、字形只存在於 alpha 通道。"
                "繪製時請用 alpha 當遮罩（例如 ctx.globalCompositeOperation 或用 "
                "OffscreenCanvas 把 alpha 轉成白色後 drawImage），直接看圖會是空白。"
            ),
            "fontCjkNote": (
                "英文字體（fnt_main 等）不含漢字；中文請用 <名>@zh 點陣字庫"
                "（3,272 漢字，簡體為主，GB2312 一級覆蓋 77.8%）。"
                "缺字（含多數繁體字）由 DTM.otf 接手，它的 cmap 覆蓋 GB2312 一級與 "
                "Big5 常用字 100%。"
            ),
            "fontFallbackChain": [
                "<名>@zh（lang=zh 點陣）",
                "<名>（英文點陣）",
                "DTM.otf（fillText）",
                "系統字體",
            ],
            "fontCoverage": {
                "simp": cov_simp,
                "trad": cov_trad,
                "otf": (otf_entry or {}).get("coverage"),
                "note": ("simp = GB2312 一級漢字 3,755 字；trad = Big5 常用字 5,401 字。"
                         "simp/trad 取自代表字體 fnt_main@zh（@zh 字庫共用同一字集）；"
                         "otf 為 DTM.otf 的 cmap 實測值。"),
            },
            "pathBase": "assets/",
            "generator": "battle-editor/tools/audio_fonts/build_index.py",
            "coreCount": len(core),
        },
    }

    # 內容未變就不重寫（避免無意義的檔案時間/git 變動）
    old = load_json(AUDIO_FONTS_INDEX)
    if old:
        old_cmp = dict(old)
        new_cmp = dict(index)
        old_cmp.pop("generated", None)
        new_cmp.pop("generated", None)
        if old_cmp == new_cmp:
            log(f"[index] 內容未變，保持原檔：{rel_to_root(AUDIO_FONTS_INDEX)}")
            return 0

    write_json(AUDIO_FONTS_INDEX, index)
    log(f"[index] 寫入 {rel_to_root(AUDIO_FONTS_INDEX)}")
    log(f"        audio: {music_count} music + {sfx_count} sfx = {len(audio)}（{audio_bytes / 1048576:.1f}MB）")
    log(f"        fonts: {len(bitmap_fonts)} 英文/官方點陣 + {zh_font_count} 中文點陣 @zh"
        f"{' + DTM.otf' if otf_entry else ''}（{font_bytes / 1024:.1f}KB）")
    for out, rec in sorted(font_entries.items()):
        if out == "DTM" or rec.get("kind") == "otf":
            log(f"          {'DTM':22s} {'(otf)':>9s}  "
                f"{rec.get('family', '')}  漢字 {rec.get('hanCount')}  "
                f"{int(rec.get('bytes') or 0) / 1024:.0f}KB")
            continue
        cjk = rec.get("cjk") or {}
        cov = rec.get("coverage") or {}
        if rec.get("lang") == "zh":
            extra = (f"簡 {cov.get('simp', {}).get('pct', 0):>5}%  "
                     f"繁 {cov.get('trad', {}).get('pct', 0):>5}%")
        else:
            extra = f"CJK {cjk.get('pct', 0):>5}%"
        log(f"          {out:22s} {rec.get('glyphCount'):4d} glyph  "
            f"em={rec.get('emSize')!s:<5} lh={rec.get('lineHeight')!s:<3} {extra}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
