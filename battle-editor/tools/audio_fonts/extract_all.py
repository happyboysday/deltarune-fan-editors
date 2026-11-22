#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""extract_all.py — A2 音效/音樂/字體擷取的單一入口（冪等、可重跑）。

流程：
  0. 檢查前置（UTMT CLI、官方音效資料）
  1. catalog.py       掃描各章 data.win 的 Sound/Font 清單 → catalog/
  2. extract_music.py 複製 mus/*.ogg 中的戰鬥曲 → assets/audio/mus/
  3. extract_sfx.py   匯出 snd_* 音效 → assets/audio/snd/
  4. extract_fonts.py 匯出字體 PNG + JSON → assets/fonts/
  5. extract_zh_fonts.py 中文字體補丁的點陣字庫 + DTM.otf → assets/fonts/*@zh/
  6. build_index.py   產生 assets/audio-fonts.index.json

用法：
  python battle-editor/tools/audio_fonts/extract_all.py             # 增量（預設）
  python battle-editor/tools/audio_fonts/extract_all.py --force     # 全部重做
  python battle-editor/tools/audio_fonts/extract_all.py --only sfx  # 只跑某階段
        可選階段：catalog music sfx fonts zh index

環境變數：
  DR_ROOT   專案根（預設自動由腳本位置推得）

冪等性：所有階段都會跳過已存在且大小相同/內容完整的輸出，重跑安全。
"""
from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import (  # noqa: E402
    AUDIO_FONTS_INDEX, BATTLE_EDITOR, MUS_DIR, OFFICIAL_AUDIO, SND_DIR, FONT_DIR,
    UTMT_CLI, ensure_dirs, log, rel_to_root,
)

STAGES = ["catalog", "music", "sfx", "fonts", "zh", "index"]
SCRIPTS = {
    "catalog": "catalog.py",
    "music": "extract_music.py",
    "sfx": "extract_sfx.py",
    "fonts": "extract_fonts.py",
    "zh": "extract_zh_fonts.py",
    "index": "build_index.py",
}


def run_stage(stage: str, extra: list[str]) -> bool:
    script = HERE / SCRIPTS[stage]
    cmd = [sys.executable, str(script)] + extra
    log(f"\n=== [{stage}] {' '.join(Path(c).name if c.endswith('.py') else c for c in cmd)} ===")
    started = time.time()
    proc = subprocess.run(cmd, cwd=str(BATTLE_EDITOR.parent))
    elapsed = time.time() - started
    ok = proc.returncode == 0
    log(f"=== [{stage}] {'OK' if ok else 'FAILED'} ({elapsed:.1f}s) ===")
    return ok


def main(argv: list[str]) -> int:
    force = "--force" in argv
    only: list[str] = []
    for i, a in enumerate(argv):
        if a == "--only" and i + 1 < len(argv):
            only = [s.strip() for s in argv[i + 1].split(",") if s.strip()]
    if only:
        bad = [s for s in only if s not in STAGES]
        if bad:
            raise SystemExit(f"未知階段：{bad}；可用：{STAGES}")

    ensure_dirs()

    stages = only or STAGES
    # index 一定最後跑
    if "index" in stages:
        stages = [s for s in stages if s != "index"] + ["index"]

    # ── 前置檢查（只檢查實際會用到的）──
    needs_utmt = any(s in stages for s in ("catalog", "sfx", "fonts"))
    problems: list[str] = []
    if needs_utmt and not UTMT_CLI.exists():
        problems.append(
            f"UTMT CLI 不存在：{UTMT_CLI}\n"
            f"  請把 DELTARUNE_解包工具_UTMT-CLI_0.9.2.0.zip 解壓到 "
            f"tools-external/utmt/（內容直接是 UndertaleModCli.exe）")
    if needs_utmt and not OFFICIAL_AUDIO.exists():
        problems.append(
            f"官方音效資料不存在：{OFFICIAL_AUDIO}\n"
            f"  請把 DELTARUNE_官方音效音乐与对白文本.zip 解壓到 assets-official/02-audio/")
    if problems:
        log("[extract_all] 前置條件不滿足：")
        for p in problems:
            log("  - " + p)
        return 1

    log(f"[extract_all] 專案根：{rel_to_root(BATTLE_EDITOR.parent)}")
    log(f"[extract_all] 階段：{stages}{'（force）' if force else ''}")

    extra = ["--force"] if force else []
    for stage in stages:
        if not run_stage(stage, extra):
            log(f"[extract_all] 階段 {stage} 失敗，中止")
            return 1

    # ── 結果摘要 ──
    def count(d: Path, patterns: tuple[str, ...]) -> int:
        return sum(1 for _ in d.glob("*")) if d.exists() else 0

    def total_size(d: Path) -> int:
        if not d.exists():
            return 0
        return sum(p.stat().st_size for p in d.rglob("*") if p.is_file())

    zh_dirs = sorted(p for p in FONT_DIR.glob("*@zh") if p.is_dir()) if FONT_DIR.exists() else []
    otf = FONT_DIR / "DTM.otf"

    log("\n[extract_all] 完成。摘要：")
    log(f"  assets/audio/mus   {count(MUS_DIR, ()):4d} 檔  {total_size(MUS_DIR) / 1048576:7.1f}MB")
    log(f"  assets/audio/snd   {len([p for p in SND_DIR.glob('*') if p.is_file()]):4d} 檔  "
        f"{total_size(SND_DIR) / 1048576:7.1f}MB")
    log(f"  assets/fonts       {len([p for p in FONT_DIR.glob('*') if p.is_dir()]):4d} 個字體  "
        f"{total_size(FONT_DIR) / 1024:7.1f}KB")
    log(f"    - 英文/官方點陣 {len([p for p in FONT_DIR.glob('*') if p.is_dir() and not p.name.endswith('@zh')]):4d} 個")
    log(f"    - 中文點陣 @zh   {len(zh_dirs):4d} 個"
        + ("（" + ", ".join(p.name for p in zh_dirs) + "）" if zh_dirs else "（缺少！請放中文字體 zip）"))
    log(f"    - DTM.otf        {'有' if otf.exists() else '缺少'} "
        + (f"{otf.stat().st_size / 1024:.0f}KB" if otf.exists() else ""))
    log(f"  index              {rel_to_root(AUDIO_FONTS_INDEX)}"
        + ("" if AUDIO_FONTS_INDEX.exists() else "（缺少！）"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
