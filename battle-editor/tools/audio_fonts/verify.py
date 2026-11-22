#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""verify.py — 驗證 A2 的產出是否自洽、可用（給 W1/W2 或 CI 用）。

檢查項目：
  1. audio-fonts.index.json 格式與必要欄位
  2. index 裡每個音效/音樂檔案真的存在、大小與 bytes 相符
  3. index 裡每個字體的 PNG/JSON 存在，PNG 尺寸與 JSON 宣告一致
  4. 每個字形的 x/y/w/h 都落在 PNG 範圍內
  5. 音效檔可解析（wav 用 wave 模組；ogg 檢查 magic）
  6. 關鍵音效/音樂名稱存在（受傷/擦彈/選單/回復/TP/發射/清除/靈魂破碎/戰鬥曲）
  7. 中文字體（@zh）：PNG/JSON 一致、alpha-only、字形在圖內，
     並印出常用簡體字（GB2312 一級 3,755）與常用繁體字（Big5 常用 5,401）的覆蓋率
  8. DTM.otf 存在且為合法 sfnt（OTTO/0x00010000）

用法：python battle-editor/tools/audio_fonts/verify.py
退出碼：0 = 全部通過；1 = 有錯誤
"""
from __future__ import annotations

import json
import sys
import wave
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import (  # noqa: E402
    ASSETS, AUDIO_FONTS_INDEX, FONT_DIR, log, rel_to_root,
    sfnt_cmap_codepoints,
)

REQUIRED_AUDIO = {
    # (名稱, 用途)
    "snd_hurt1": "受傷",
    "snd_graze": "擦彈",
    "snd_menumove": "選單移動",
    "snd_select": "選單選擇",
    "snd_break1": "靈魂破碎（裂開）",
    "snd_break2": "靈魂破碎（碎裂）",
    "snd_revival": "回復/復活",
    "snd_tensionhorn": "TP/張力",
    "snd_spearappear": "子彈發射（長矛生成）",
    "snd_explosion": "爆炸",
    "snd_gerlaugh_clear": "清除子彈",
}
REQUIRED_MUSIC = ["battle"]
REQUIRED_FONTS = ["fnt_main", "fnt_mainbig", "fnt_small"]
REQUIRED_ZH_FONTS = ["fnt_main@zh"]
REQUIRED_OTF = "DTM"
# 中文字體至少要有的漢字數（補丁宣稱 3,272 漢字）
MIN_HAN_GLYPHS = 3000
# 簡體覆蓋率下限（GB2312 一級）。低於此視為字庫異常。
MIN_SIMP_PCT = 50.0


# ── 字集樣本（優先用標準庫編碼表解碼，結果穩定且不需要外部字表） ──────────
def _gb2312_level1() -> list[str]:
    """GB2312 一級漢字 3,755 字（區位 16–55）。"""
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


def _big5_level1() -> list[str]:
    """Big5 常用字 5,401 字（0xA440–0xC67E）。"""
    seen: set[str] = set()
    out: list[str] = []
    for hi in range(0xA4, 0xC7):
        for lo in list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)):
            try:
                ch = bytes((hi, lo)).decode("big5")
            except UnicodeDecodeError:
                continue
            if len(ch) == 1 and "\u4e00" <= ch <= "\u9fff" and ch not in seen:
                seen.add(ch)
                out.append(ch)
    return out


_SETS: dict[str, list[str]] = {}


def char_sets() -> dict[str, list[str]]:
    global _SETS
    if not _SETS:
        _SETS = {"simp": _gb2312_level1(), "trad": _big5_level1()}
    return _SETS


def coverage_report(name: str, have: set[int], warnings: list[str]) -> dict:
    """算簡體（GB2312 一級）與繁體（Big5 常用）覆蓋率。"""
    sets = char_sets()
    out: dict[str, dict] = {}
    for key, label in (("simp", "GB2312 一級"), ("trad", "Big5 常用")):
        chars = sets[key]
        hit = [c for c in chars if ord(c) in have]
        miss = [c for c in chars if ord(c) not in have]
        pct = round(100.0 * len(hit) / len(chars), 1) if chars else 0.0
        out[key] = {"label": label, "sample": len(chars), "hit": len(hit),
                    "pct": pct, "missSample": "".join(miss[:40])}
    if out["simp"]["pct"] < MIN_SIMP_PCT:
        warnings.append(f"中文字體 {name}: 簡體覆蓋率僅 {out['simp']['pct']}%"
                        f"（< {MIN_SIMP_PCT}%，字庫可能不完整）")
    return out


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []

    if not AUDIO_FONTS_INDEX.exists():
        log(f"[verify] 找不到 {rel_to_root(AUDIO_FONTS_INDEX)}")
        return 1
    try:
        idx = json.loads(AUDIO_FONTS_INDEX.read_text(encoding="utf-8"))
    except Exception as e:
        log(f"[verify] index 不是合法 JSON：{e}")
        return 1

    if idx.get("format") != "dr-battle-assets-audio/1":
        errors.append(f"index.format 應為 dr-battle-assets-audio/1，實際 {idx.get('format')!r}")
    audio = idx.get("audio") or {}
    fonts = idx.get("fonts") or {}
    if not audio:
        errors.append("index.audio 為空")
    if not fonts:
        errors.append("index.fonts 為空")

    # ── 音效/音樂檔案 ──
    n_music = n_sfx = 0
    for name, rec in audio.items():
        kind = rec.get("kind")
        if kind not in ("music", "sfx"):
            errors.append(f"{name}: kind={kind!r} 不合法")
            continue
        f = rec.get("file")
        if not f:
            errors.append(f"{name}: 缺 file")
            continue
        if f.startswith("/") or ":" in f or ".." in f:
            errors.append(f"{name}: file 必須是相對 assets/ 的安全路徑，實際 {f!r}")
            continue
        p = ASSETS / f
        if not p.exists():
            errors.append(f"{name}: 檔案不存在 {f}")
            continue
        if rec.get("bytes") and p.stat().st_size != rec["bytes"]:
            warnings.append(f"{name}: bytes 宣告 {rec['bytes']} 與實際 {p.stat().st_size} 不符")
        # 檔案可解析
        try:
            if p.suffix == ".wav":
                with wave.open(str(p), "rb") as w:
                    if w.getnframes() <= 0:
                        errors.append(f"{name}: wav 無音框 {f}")
            elif p.suffix == ".ogg":
                head = p.open("rb").read(4)
                if head != b"OggS":
                    errors.append(f"{name}: 不是 OGG 檔（magic={head!r}）")
            else:
                errors.append(f"{name}: 未知副檔名 {p.suffix}")
        except Exception as e:
            errors.append(f"{name}: 無法解析 {f}（{e}）")
        if kind == "music":
            n_music += 1
            if "loop" not in rec:
                warnings.append(f"{name}: music 缺 loop 欄位")
        else:
            n_sfx += 1

    # ── 關鍵素材 ──
    for name, why in REQUIRED_AUDIO.items():
        if name not in audio:
            errors.append(f"缺少關鍵音效 {name}（{why}）")
    for name in REQUIRED_MUSIC:
        if name not in audio:
            errors.append(f"缺少關鍵音樂 {name}")
    for name in REQUIRED_FONTS:
        if name not in fonts:
            errors.append(f"缺少關鍵字體 {name}")

    # ── core 清單 ──
    core = idx.get("core") or []
    if not core:
        warnings.append("index 沒有 core 清單（建議核心音效）")
    else:
        bad_core = [n for n in core if n not in audio]
        if bad_core:
            errors.append(f"core 清單有 {len(bad_core)} 個名稱不在 audio 中：{bad_core[:5]}")
    # groups 內的名稱都必須存在
    for gname, members in (idx.get("groups") or {}).items():
        bad = [n for n in members if n not in audio]
        if bad:
            errors.append(f"groups.{gname} 有 {len(bad)} 個名稱不在 audio 中：{bad[:5]}")

    # ── 字體 ──
    zh_reports: list[dict] = []
    for out, rec in fonts.items():
        if rec.get("kind") == "otf":
            continue  # DTM.otf 另外驗
        img = rec.get("image")
        gl = rec.get("glyphs")
        if not img or not gl:
            errors.append(f"字體 {out}: 缺 image 或 glyphs")
            continue
        ip, gp = ASSETS / img, ASSETS / gl
        if not ip.exists():
            errors.append(f"字體 {out}: PNG 不存在 {img}")
            continue
        if not gp.exists():
            errors.append(f"字體 {out}: glyphs.json 不存在 {gl}")
            continue
        try:
            data = json.loads(gp.read_text(encoding="utf-8"))
        except Exception as e:
            errors.append(f"字體 {out}: glyphs.json 不是合法 JSON（{e}）")
            continue
        if data.get("format") != "dr-battle-font/1":
            errors.append(f"字體 {out}: glyphs.json format={data.get('format')!r}")
        iw, ih = data.get("image", {}).get("w"), data.get("image", {}).get("h")
        if (iw, ih) != (rec.get("imageW"), rec.get("imageH")):
            warnings.append(f"字體 {out}: index 宣告 {rec.get('imageW')}x{rec.get('imageH')} "
                            f"與 glyphs.json {iw}x{ih} 不符")
        # 用 Pillow 檢查 PNG 真實尺寸（沒有 Pillow 就跳過）
        try:
            from PIL import Image
            with Image.open(ip) as im:
                if im.size != (iw, ih):
                    errors.append(f"字體 {out}: PNG 實際 {im.size} 與宣告 {(iw, ih)} 不符")
                if im.mode != "RGBA":
                    warnings.append(f"字體 {out}: PNG mode={im.mode}（預期 RGBA，字形在 alpha）")
        except ImportError:
            warnings.append(f"字體 {out}: 無 Pillow，跳過 PNG 尺寸檢查")
        # 字形邊界
        oob = 0
        for k, g in (data.get("glyphs") or {}).items():
            if g.get("w", 0) <= 0 or g.get("h", 0) <= 0:
                continue
            if g["x"] < 0 or g["y"] < 0 or g["x"] + g["w"] > iw or g["y"] + g["h"] > ih:
                oob += 1
        if oob:
            errors.append(f"字體 {out}: {oob} 個字形超出貼圖範圍")
        if not data.get("glyphs"):
            errors.append(f"字體 {out}: glyphs 為空")
        # ASCII 可印字元齊全度
        have = {int(k) for k in (data.get("glyphs") or {})}
        miss = [c for c in range(0x20, 0x7F) if c not in have]
        if miss:
            warnings.append(f"字體 {out}: 缺 {len(miss)} 個 ASCII 字元")

        # ── 中文字體（@zh）額外檢查 ──
        if out.endswith("@zh") or rec.get("lang") == "zh":
            han = {cp for cp in have if 0x4E00 <= cp <= 0x9FFF}
            if len(han) < MIN_HAN_GLYPHS:
                errors.append(f"中文字體 {out}: 漢字只有 {len(han)} 個"
                              f"（預期 ≥ {MIN_HAN_GLYPHS}）")
            if rec.get("lang") != "zh":
                errors.append(f"中文字體 {out}: 缺 lang=\"zh\"")
            if not rec.get("base"):
                warnings.append(f"中文字體 {out}: 缺 base（對應的英文字體名）")
            # 覆蓋率
            var = coverage_report(out, have, warnings)
            zh_reports.append({"name": out, "han": len(han),
                               "glyphCount": data.get("glyphCount"), **var})
            # 與宣告的覆蓋率交叉比對
            decl = (rec.get("coverage") or {}).get("simp") or {}
            if decl.get("pct") is not None and abs(decl["pct"] - var["simp"]["pct"]) > 1.0:
                warnings.append(f"中文字體 {out}: index 宣告 simp {decl['pct']}% "
                                f"與實測 {var['simp']['pct']}% 不符")
            # alpha-only 檢查（Pillow 可用時）
            try:
                from PIL import Image
                with Image.open(ip) as im:
                    rgba = im.convert("RGBA")
                    r_ext = rgba.split()[0].getextrema()
                    if r_ext != (255, 255):
                        warnings.append(f"中文字體 {out}: RGB 不是全白 {r_ext}"
                                        f"（字形應只存在於 alpha 通道）")
            except ImportError:
                pass
            except Exception as e:
                warnings.append(f"中文字體 {out}: alpha 檢查失敗（{e}）")

    # ── DTM.otf ──
    otf_report: dict = {}
    otf_rec = fonts.get(REQUIRED_OTF)
    if not otf_rec:
        errors.append(f"缺少中文字體 {REQUIRED_OTF}（DTM.otf）")
    else:
        if otf_rec.get("kind") != "otf":
            errors.append(f"{REQUIRED_OTF}: kind={otf_rec.get('kind')!r}（預期 otf）")
        f = otf_rec.get("file") or "fonts/DTM.otf"
        p = ASSETS / f
        if not p.exists():
            errors.append(f"{REQUIRED_OTF}: 檔案不存在 {f}")
        else:
            with open(p, "rb") as fh:
                magic = fh.read(4)
            if magic not in (b"OTTO", b"\x00\x01\x00\x00", b"true"):
                errors.append(f"{REQUIRED_OTF}: 不是合法 sfnt（magic={magic!r}）")
            if p.stat().st_size < 100_000:
                errors.append(f"{REQUIRED_OTF}: 檔案過小（{p.stat().st_size} bytes）")
            cps = sfnt_cmap_codepoints(p)
            if not cps:
                warnings.append(f"{REQUIRED_OTF}: 無法解析 cmap（退回字可能無效）")
            else:
                otf_report = {k: sum(1 for c in v if ord(c) in cps)
                              for k, v in char_sets().items()}
                sets = char_sets()
                for k, hit in otf_report.items():
                    total = len(sets[k])
                    pct = round(100.0 * hit / total, 1) if total else 0.0
                    if pct < 99.0:
                        warnings.append(f"{REQUIRED_OTF}: {k} 覆蓋僅 {pct}%（{hit}/{total}）")
                log(f"[verify] DTM.otf cmap：{len(cps)} 碼位，漢字 "
                    f"{sum(1 for c in cps if 0x4E00 <= c <= 0x9FFF)}；簡體 "
                    f"{otf_report['simp']}/{len(sets['simp'])}、繁體 "
                    f"{otf_report['trad']}/{len(sets['trad'])}")
    for name in REQUIRED_ZH_FONTS:
        if name not in fonts:
            errors.append(f"缺少中文字體 {name}")

    # ── 摘要 ──
    n_zh = sum(1 for k, v in fonts.items()
               if v.get("kind") != "otf" and (k.endswith("@zh") or v.get("lang") == "zh"))
    log(f"[verify] index: {n_music} 首音樂、{n_sfx} 個音效、{len(fonts)} 個字體"
        f"（含 {n_zh} 個中文點陣{'、DTM.otf' if otf_rec else ''}）")
    if zh_reports:
        log("[verify] 中文字體覆蓋率（點陣字庫，簡體補丁）：")
        log(f"  {'字體':<22} {'漢字':>5}  {'簡體(GB2312一級 3755)':>22}  {'繁體(Big5常用 5401)':>20}")
        for r in zh_reports:
            s, t = r["simp"], r["trad"]
            log(f"  {r['name']:<22} {r['han']:>5}  "
                f"{s['hit']:>5}/{s['sample']:<5} {s['pct']:>5}%   "
                f"{t['hit']:>5}/{t['sample']:<5} {t['pct']:>5}%")
        # 只印一次缺字樣本（各字體字庫相同）
        s0 = zh_reports[0]["simp"]
        if s0["missSample"]:
            log(f"  簡體缺字樣本：{s0['missSample']}")
    if warnings:
        log(f"[verify] {len(warnings)} 個警告：")
        for w in warnings[:20]:
            log(f"  ⚠ {w}")
        if len(warnings) > 20:
            log(f"  … 另有 {len(warnings) - 20} 個")
    if errors:
        log(f"[verify] {len(errors)} 個錯誤：")
        for e in errors:
            log(f"  ✗ {e}")
        return 1
    log("[verify] 全部通過 ✓")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
