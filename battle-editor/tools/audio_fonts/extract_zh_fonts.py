#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""extract_zh_fonts.py — 把簡體中文補丁 V260809 的點陣字庫轉成 dr-battle-font/1。

來源 zip：DELTARUNE_V260809_中文字体.zip
  解壓到：assets-official/03-zh-fonts/（不進 git）
  結構：Deltarune_V260809_中文字体/
          DTM.otf
          游戏字体索引.csv
          使用说明.txt
          游戏内位图字体/{main,chapter1..5}/fnt_*.png + glyphs_fnt_*.csv

流程：
  1. 若 assets-official/03-zh-fonts/ 缺少必要檔案就從 zip 解壓（冪等）。
  2. 每個 fnt 取「最新章」版本（chapter5 > chapter4 > chapter3 > chapter2 > chapter1 > main）。
  3. CSV → glyphs.json（dr-battle-font/1，與 assets/fonts/fnt_main 等英文字體同格式），
     PNG → glyphs.png（RGB 統一改成白色 + 保留原 alpha；裁掉空白邊界但不動座標）。
  4. 複製 DTM.otf → assets/fonts/DTM.otf。
  5. 寫 tools/audio_fonts/manifest_zh_fonts.json（含繁/簡覆蓋率統計）。

座標規則：遊戲內位圖字形的 X/Y 就是「相對 PNG 左上角」的像素座標，直接使用，
          不做任何縮放或原點加減（來源圖集 scale=1）。

規則來源：tools/audio_fonts/config/zh_fonts_rules.json
單獨執行：python tools/audio_fonts/extract_zh_fonts.py [--force]
"""
from __future__ import annotations

import csv
import shutil
import sys
import zipfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import (  # noqa: E402
    BATTLE_EDITOR, CONFIG_DIR, FONT_DIR, ROOT, ensure_dirs, load_json, log,
    rel_to_root, sfnt_cmap_codepoints, write_json, write_text,
)

RULES_PATH = CONFIG_DIR / "zh_fonts_rules.json"
MANIFEST = HERE / "manifest_zh_fonts.json"
ZIP_PATH = ROOT / "DELTARUNE_V260809_中文字体.zip"
ZH_ROOT = ROOT / "assets-official" / "03-zh-fonts"
SPEC_MD = BATTLE_EDITOR / "docs" / "SPEC.md"

FORMAT = "dr-battle-font/1"
WHITE = (255, 255, 255)


# ── 字集取樣（用標準庫解碼，不依賴外部字表） ────────────────────────────────
def gb2312_level1() -> list[str]:
    """GB2312 一級漢字：區位 16–55 區，位元組 0xB0A1–0xD7F9（3,755 字）。"""
    out: list[str] = []
    for hi in range(0xB0, 0xD8):
        for lo in range(0xA1, 0xFF):
            try:
                ch = bytes((hi, lo)).decode("gb2312")
            except UnicodeDecodeError:
                continue
            if len(ch) == 1 and "\u4e00" <= ch <= "\u9fff":
                out.append(ch)
    return out


def big5_level1() -> list[str]:
    """Big5 常用字：0xA440–0xC67E（5,401 字）。"""
    out: list[str] = []
    for hi in range(0xA4, 0xC7):
        for lo in list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)):
            try:
                ch = bytes((hi, lo)).decode("big5")
            except UnicodeDecodeError:
                continue
            if len(ch) == 1 and "\u4e00" <= ch <= "\u9fff":
                out.append(ch)
    # 去掉重複（部分碼位對應同字）
    seen: set[str] = set()
    uniq = []
    for c in out:
        if c not in seen:
            seen.add(c)
            uniq.append(c)
    return uniq


def spec_chars() -> list[str]:
    """SPEC.md 內所有非 ASCII 字元（實際文件用字，偏繁體）。"""
    if not SPEC_MD.exists():
        return []
    text = SPEC_MD.read_text(encoding="utf-8")
    return sorted({c for c in text if ord(c) > 0x7F and not c.isspace()})


# ── 解壓 ────────────────────────────────────────────────────────────────────
def extract_zip(force: bool = False) -> Path:
    """把字體包解壓到 assets-official/03-zh-fonts/（去掉最上層資料夾）。"""
    if not ZIP_PATH.exists():
        raise SystemExit(f"找不到中文字體包：{ZIP_PATH}")
    need = ZH_ROOT / "游戏内位图字体"
    if need.is_dir() and not force:
        # 已解壓且至少有一個章節目錄就視為完成
        if any(need.iterdir()):
            log(f"[zh] 已解壓：{rel_to_root(ZH_ROOT)}")
            return ZH_ROOT
    log(f"[zh] 解壓 {ZIP_PATH.name} -> {rel_to_root(ZH_ROOT)}")
    ZH_ROOT.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(ZIP_PATH) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            name = info.filename
            # 去掉最上層資料夾（Deltarune_V260809_中文字体/）
            if "/" in name:
                name = name.split("/", 1)[1]
            if not name:
                continue
            target = ZH_ROOT / name
            target.parent.mkdir(parents=True, exist_ok=True)
            with zf.open(info) as src, open(target, "wb") as dst:
                shutil.copyfileobj(src, dst)
    log(f"[zh] 解壓完成：{sum(1 for p in ZH_ROOT.rglob('*') if p.is_file())} 個檔案")
    return ZH_ROOT


# ── 讀 CSV ──────────────────────────────────────────────────────────────────
def parse_csv(path: Path) -> tuple[dict, dict[int, dict]]:
    """回傳 (字體屬性, {碼位: {x,y,w,h,shift,off}})。

    首行：名稱;em;粗體;斜體;charset;antiAliasing;scaleX;scaleY
    其後：碼位;X;Y;寬;高;步進;橫向偏移
    """
    text = path.read_text(encoding="utf-8-sig")
    lines = [ln for ln in text.splitlines() if ln.strip()]
    if not lines:
        raise ValueError(f"{path} 是空的")
    head = lines[0].split(";")
    attrs = {
        "displayName": head[0].strip() if head else "",
        "emSize": float(head[1]) if len(head) > 1 and head[1].strip() else 12.0,
        "bold": (head[2].strip().lower() == "true") if len(head) > 2 else False,
        "italic": (head[3].strip().lower() == "true") if len(head) > 3 else False,
        "charset": int(head[4]) if len(head) > 4 and head[4].strip() else 0,
        "antiAliasing": int(head[5]) if len(head) > 5 and head[5].strip() else 0,
        "scaleX": float(head[6]) if len(head) > 6 and head[6].strip() else 1.0,
        "scaleY": float(head[7]) if len(head) > 7 and head[7].strip() else 1.0,
    }
    glyphs: dict[int, dict] = {}
    for ln in lines[1:]:
        parts = ln.split(";")
        if len(parts) < 7:
            continue
        try:
            cp = int(parts[0])
            glyphs[cp] = {
                "x": int(parts[1]),
                "y": int(parts[2]),
                "w": int(parts[3]),
                "h": int(parts[4]),
                "shift": int(parts[5]),
                "off": int(parts[6]),
            }
        except ValueError:
            continue
    return attrs, glyphs


# ── PNG 正規化 ──────────────────────────────────────────────────────────────
def normalize_png(src: Path, dst: Path, crop_w: int, crop_h: int) -> tuple[int, int]:
    """把字形貼圖統一成「RGB 全白 + 原 alpha」，並裁到 crop_w×crop_h。

    來源 PNG 的 RGB 在字形處是白色、透明處是黑色；若不統一，之後若有人
    用 rgb 直接把圖貼到黑底會得到方塊。裁切只從右下角裁掉空白區，
    左上角原點不動，所以字形座標不需要任何調整。

    回傳實際輸出的 (w, h)。
    """
    try:
        from PIL import Image
    except ImportError:  # 沒有 Pillow 就原樣複製（座標仍然有效，只是不裁切）
        shutil.copyfile(src, dst)
        with open(dst, "rb") as f:
            head = f.read(24)
        w, h = int.from_bytes(head[16:20], "big"), int.from_bytes(head[20:24], "big")
        return w, h
    with Image.open(src) as im:
        im = im.convert("RGBA")
        w, h = im.size
        out_w = max(1, min(crop_w, w))
        out_h = max(1, min(crop_h, h))
        px = im.load()
        # 只掃到 out_w×out_h 內以省時間
        for y in range(out_h):
            for x in range(out_w):
                r, g, b, a = px[x, y]
                if a:
                    px[x, y] = (WHITE[0], WHITE[1], WHITE[2], a)
                else:
                    px[x, y] = (WHITE[0], WHITE[1], WHITE[2], 0)
        if (out_w, out_h) != (w, h):
            im = im.crop((0, 0, out_w, out_h))
        dst.parent.mkdir(parents=True, exist_ok=True)
        im.save(dst, format="PNG", optimize=True)
    return out_w, out_h


# ── 主流程 ──────────────────────────────────────────────────────────────────
def pick_atlas(bitmap_root: Path, name: str, chapter_order: list[str]) -> tuple[str, Path, Path] | None:
    """在 chapter_order 中找第一個同時有 PNG 與 CSV 的章節。"""
    for chapter in chapter_order:
        d = bitmap_root / chapter
        png = d / f"{name}.png"
        csv_path = d / f"glyphs_{name}.csv"
        if png.is_file() and csv_path.is_file():
            return chapter, png, csv_path
    return None


def coverage(glyphs: dict[int, dict], chars: list[str]) -> dict:
    have = {cp for cp, g in glyphs.items() if g["w"] > 0}
    hit = sum(1 for c in chars if ord(c) in have)
    total = len(chars)
    return {
        "sample": total,
        "hit": hit,
        "pct": round(100.0 * hit / total, 1) if total else 0.0,
        "missSample": "".join(c for c in chars if ord(c) not in have)[:40],
    }


def english_line_height(out: str) -> int | None:
    """若能找到對應的英文字體，沿用它的 lineHeight 當參考。"""
    base = out.split("@")[0]
    p = FONT_DIR / base / "glyphs.json"
    if not p.is_file():
        return None
    try:
        import json
        data = json.loads(p.read_text(encoding="utf-8"))
    except Exception:
        return None
    lh = data.get("lineHeight")
    return int(lh) if isinstance(lh, (int, float)) and lh else None


def main(argv: list[str]) -> int:
    force = "--force" in argv
    ensure_dirs()
    rules = load_json(RULES_PATH)
    if not rules:
        raise SystemExit(f"找不到規則檔：{RULES_PATH}")
    specs = rules.get("fonts") or []
    if not specs:
        raise SystemExit(f"{RULES_PATH} 沒有 fonts 清單")

    root = None
    bitmap_root_probe = ZH_ROOT / (rules.get("bitmapRoot") or "游戏内位图字体")
    if not ZIP_PATH.exists() and not bitmap_root_probe.is_dir():
        # 沒 zip 也沒解壓結果 → 溫和跳過（不讓 extract_all 整體失敗），
        # 既有 assets/fonts/*@zh 與 manifest 保持不動，index 會沿用上一輪結果。
        log(f"[zh] ⚠ 找不到中文字體包（{ZIP_PATH.name}）也沒有已解壓的 {rel_to_root(ZH_ROOT)}")
        log("[zh]    跳過中文字體階段（其餘音樂/音效/字體不受影響）")
        return 0
    root = extract_zip(force=force)
    bitmap_root = root / rules.get("bitmapRoot", "游戏内位图字体")
    if not bitmap_root.is_dir():
        raise SystemExit(f"找不到點陣字體目錄：{bitmap_root}")
    chapter_order = rules.get("chapterOrder") or [
        "chapter5", "chapter4", "chapter3", "chapter2", "chapter1", "main"]

    log("[zh] 建立覆蓋率樣本")
    sets = {
        "simp": gb2312_level1(),          # GB2312 一級 3,755 字
        "trad": big5_level1(),            # Big5 常用 5,401 字
        "spec": spec_chars(),
    }
    for k, v in sets.items():
        log(f"[zh]   {k:5s} {len(v):5d} 字")

    results: dict[str, dict] = {}
    for spec in specs:
        name = spec["name"]
        out = spec.get("out") or f"{name}@zh"
        picked = pick_atlas(bitmap_root, name, chapter_order)
        if picked is None:
            log(f"[zh] × {name}: 所有章節都沒有圖集，跳過")
            continue
        chapter, png_src, csv_src = picked

        out_dir = FONT_DIR / out
        png_dst = out_dir / "glyphs.png"
        json_dst = out_dir / "glyphs.json"
        if png_dst.exists() and json_dst.exists() and not force:
            log(f"[zh] 已存在，跳過：{out}")
        else:
            attrs, glyphs = parse_csv(csv_src)
            if not glyphs:
                log(f"[zh] × {name}: CSV 沒有字形，跳過")
                continue
            max_x = max(g["x"] + g["w"] for g in glyphs.values())
            max_y = max(g["y"] + g["h"] for g in glyphs.values())
            img_w, img_h = normalize_png(png_src, png_dst, max_x, max_y)
            attrs["glyphs"] = glyphs
            attrs["imgW"] = img_w
            attrs["imgH"] = img_h
            base_lh = english_line_height(out)
            write_text(out_dir / "meta.txt", _meta_text(out, name, chapter, csv_src, attrs, glyphs))
            # json 由下方統一路徑寫，避免重複邏輯
            write_json(json_dst, _build_json(out, spec, chapter, attrs, glyphs,
                                             img_w, img_h, base_lh))
            log(f"[zh] {out:18s} <- {chapter}/{name}  {len(glyphs):4d} glyph  {img_w}x{img_h}")
        # 讀回（跳過時也要有資料）
        data = load_json(json_dst)
        if not data:
            log(f"[zh] × {out}: glyphs.json 讀取失敗")
            continue
        glyphs2 = {
            int(k): {"x": v["x"], "y": v["y"], "w": v["w"], "h": v["h"],
                     "shift": v["shift"], "off": v["offset"]}
            for k, v in (data.get("glyphs") or {}).items()
        }
        han = sum(1 for cp in glyphs2 if 0x4E00 <= cp <= 0x9FFF)
        cov = {k: coverage(glyphs2, v) for k, v in sets.items()}
        results[out] = {
            "lang": "zh",
            "base": spec.get("base") or name,
            "sourceFont": name,
            "sourceChapter": chapter,
            "patch": "DELTARUNE V260809 简体中文补丁",
            "role": spec.get("role", ""),
            "note": spec.get("note", ""),
            "image": f"fonts/{out}/glyphs.png",
            "glyphs": f"fonts/{out}/glyphs.json",
            "size": int(round(data.get("emSize") or 12)),
            "emSize": data.get("emSize"),
            "lineHeight": data.get("lineHeight"),
            "lineHeightBase": english_line_height(out),
            "glyphCount": data.get("glyphCount"),
            "hanCount": han,
            "imageW": data.get("image", {}).get("w"),
            "imageH": data.get("image", {}).get("h"),
            "bold": data.get("bold", False),
            "italic": data.get("italic", False),
            "coverage": cov,
        }

    # ── DTM.otf ──
    otf = rules.get("otf") or {}
    otf_src = root / (otf.get("src") or "DTM.otf")
    otf_dst = FONT_DIR / "DTM.otf"
    otf_rec = None
    if otf_src.is_file():
        need_copy = force or not otf_dst.exists() or otf_dst.stat().st_size != otf_src.stat().st_size
        if need_copy:
            shutil.copyfile(otf_src, otf_dst)
            log(f"[zh] DTM.otf -> {rel_to_root(otf_dst)}（{otf_dst.stat().st_size / 1024:.0f}KB）")
        else:
            log(f"[zh] DTM.otf 已存在，略過複製")
        with open(otf_dst, "rb") as f:
            magic = f.read(4)
        # 從 cmap 實測漢字映射數（zip 說明宣稱 27,484；實測 CJK Unified 20,902 + 擴充 A）
        otf_cps = sfnt_cmap_codepoints(otf_dst)
        otf_han = {c for c in otf_cps if 0x4E00 <= c <= 0x9FFF}
        otf_cov = {k: coverage({cp: {"w": 1} for cp in otf_cps}, v) for k, v in sets.items()}
        otf_rec = {
            "kind": "otf",
            "file": otf.get("file") or "fonts/DTM.otf",
            "lang": "zh",
            "family": otf.get("family") or "Determination Sans SimSun Regular",
            "hanCount": otf.get("hanCount"),
            "bytes": otf_dst.stat().st_size,
            "sfnt": magic.hex(),
            "cmapCodepoints": len(otf_cps),
            "cmapHan": len(otf_han),
            "coverage": otf_cov,
            "note": otf.get("note", ""),
        }
        if magic not in (b"OTTO", b"\x00\x01\x00\x00", b"true"):
            log(f"[zh] ⚠ DTM.otf 檔頭異常：{magic!r}")
        if otf_cps:
            log(f"[zh] DTM.otf cmap：{len(otf_cps)} 個碼位、漢字 {len(otf_han)}；"
                f"簡 {otf_cov['simp']['pct']}% 繁 {otf_cov['trad']['pct']}%")
    else:
        log(f"[zh] ⚠ 找不到 DTM.otf：{otf_src}")

    total_bytes = 0
    for out in results:
        for fn in ("glyphs.png", "glyphs.json"):
            p = FONT_DIR / out / fn
            if p.exists():
                total_bytes += p.stat().st_size
    if otf_rec:
        total_bytes += otf_rec["bytes"]

    manifest = {
        "format": "dr-battle-zh-font-manifest/1",
        "patch": "DELTARUNE V260809 简体中文补丁",
        "count": len(results),
        "bytes": total_bytes,
        "sourceZip": ZIP_PATH.name,
        "sourceDir": rel_to_root(root),
        "fonts": results,
        "otf": otf_rec,
        "coverageSets": {
            "simp": {"id": "gb2312_level1", "label": "GB2312 一級漢字", "sample": len(sets["simp"])},
            "trad": {"id": "big5_level1", "label": "Big5 常用字", "sample": len(sets["trad"])},
            "spec": {"id": "spec_md", "label": "SPEC.md 非 ASCII 字元", "sample": len(sets["spec"])},
        },
    }
    write_json(MANIFEST, manifest)

    log(f"[zh] 完成 {len(results)} 個中文字體 + DTM.otf，合計 {total_bytes / 1024:.1f}KB")
    log(f"[zh] manifest -> {rel_to_root(MANIFEST)}")
    for out, rec in results.items():
        cov = rec["coverage"]
        log(f"        {out:18s} {rec['glyphCount']:4d} glyph  漢字 {rec['hanCount']:4d}  "
            f"{rec['imageW']}x{rec['imageH']}  em={rec['emSize']} lh={rec['lineHeight']}"
            f"  簡{cov['simp']['pct']:>5}% 繁{cov['trad']['pct']:>5}% SPEC{cov['spec']['pct']:>5}%")
    return 0


def _build_json(out: str, spec: dict, chapter: str, attrs: dict,
                glyphs: dict[int, dict], img_w: int, img_h: int,
                base_line_height: int | None) -> dict:
    max_bottom = max((g["off"] + g["h"]) for g in glyphs.values() if g["w"] > 0)
    bottoms = sorted(g["off"] + g["h"] for g in glyphs.values() if g["w"] > 0)
    p99 = bottoms[min(len(bottoms) - 1, int(round(0.99 * (len(bottoms) - 1))))] if bottoms else 0
    p95 = bottoms[min(len(bottoms) - 1, int(round(0.95 * (len(bottoms) - 1))))] if bottoms else 0
    derived = p99 if p99 > 0 else int(round(attrs["emSize"]))
    # 行距沿用對應英文點陣字體的 lineHeight —— 這是遊戲原本的排版參數，
    # 中文補丁只換字形不換字體資源，所以中文也該用同一個值，語言切換時行距不會跳動。
    # 註：部分字體的漢字會略超出 lineHeight（例如 fnt_8bit 漢字下緣到 29、lineHeight 只有 16），
    # 但英文版 fnt_8bit 也一樣（英文下緣 22、lineHeight 16），是該字體的原始設計；
    # 這些值記在 lineHeightP95 / lineHeightP99 / lineHeightMax 供引擎需要時自行加大行距。
    if base_line_height:
        line_height = int(base_line_height)
        lh_source = (f"base:{spec.get('base') or spec['name']}"
                     f"（沿用英文點陣的 lineHeight，語言切換時行距一致）")
    else:
        line_height = derived
        lh_source = "derived-p99（找不到對應英文字體，CSV 無 lineHeight 欄位）"
    payload: dict = {
        "format": FORMAT,
        "name": out,
        "sourceFont": spec["name"],
        "displayName": attrs["displayName"],
        "lang": "zh",
        "base": spec.get("base") or spec["name"],
        "patch": "DELTARUNE V260809 简体中文补丁",
        "chapter": chapter,
        "size": int(round(attrs["emSize"])),
        "emSize": attrs["emSize"],
        "lineHeight": line_height,
        "lineHeightDerived": derived,
        "lineHeightP95": p95,
        "lineHeightP99": p99,
        "lineHeightMax": max_bottom,
        "lineHeightRaw": None,
        "lineHeightSource": lh_source,
        "ascender": 0,
        "ascenderOffset": 0,
        "scaleX": attrs["scaleX"],
        "scaleY": attrs["scaleY"],
        "bold": attrs["bold"],
        "italic": attrs["italic"],
        "antiAliasing": attrs["antiAliasing"],
        "charset": attrs["charset"],
        "rangeStart": min(glyphs),
        "rangeEnd": max(glyphs),
        "maxGlyphWidth": max(g["w"] for g in glyphs.values()),
        "maxGlyphHeight": max(g["h"] for g in glyphs.values()),
        "image": {"file": "glyphs.png", "w": img_w, "h": img_h,
                  "scaleX": 1.0, "scaleY": 1.0},
        "glyphCount": len(glyphs),
        "alphaOnly": True,
        "coordinateNote": "x/y/w/h 為 PNG 內左上角像素座標，直接使用；來源圖集 scale=1。",
        "glyphs": {},
    }
    for cp in sorted(glyphs):
        g = glyphs[cp]
        payload["glyphs"][str(cp)] = {
            "char": _char(cp),
            "x": g["x"], "y": g["y"], "w": g["w"], "h": g["h"],
            "shift": g["shift"], "offset": g["off"],
        }
    return payload


def _meta_text(out: str, name: str, chapter: str, csv_src: Path,
               attrs: dict, glyphs: dict[int, dict]) -> str:
    lines = [
        f"name={out}",
        f"source_font={name}",
        f"source_chapter={chapter}",
        f"source_csv={csv_src.name}",
        f"display_name={attrs['displayName']}",
        f"em_size={attrs['emSize']}",
        f"bold={attrs['bold']}",
        f"italic={attrs['italic']}",
        f"png_w={attrs['imgW']}",
        f"png_h={attrs['imgH']}",
        f"glyphs={len(glyphs)}",
        "format=dr-battle-font/1",
        "note=字形只存在於 alpha 通道；RGB 已統一為白色。座標為 PNG 左上角像素，scale=1。",
    ]
    return "\n".join(lines) + "\n"


def _char(cp: int) -> str:
    try:
        return chr(cp)
    except (ValueError, OverflowError):
        return ""


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
