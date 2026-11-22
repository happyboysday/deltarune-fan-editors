#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""common.py — A2 音效/音樂/字體擷取腳本的共用設定與工具。

所有路徑都相對「專案根」(DeltaruneWorks)，可用環境變數 DR_ROOT 覆寫。
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

# ── 路徑 ────────────────────────────────────────────────────────────────
HERE = Path(__file__).resolve().parent           # battle-editor/tools/audio_fonts
BATTLE_EDITOR = HERE.parent.parent              # battle-editor/
ROOT = Path(os.environ.get("DR_ROOT", BATTLE_EDITOR.parent)).resolve()

UTMT_DIR = ROOT / "tools-external" / "utmt" / "UTMT-CLI"
if not (UTMT_DIR / "UndertaleModCli.exe").exists():
    # 解壓時若直接把 UTMT-CLI 內容放到 tools-external/utmt/ 也接受
    alt = ROOT / "tools-external" / "utmt"
    if (alt / "UndertaleModCli.exe").exists():
        UTMT_DIR = alt
UTMT_CLI = UTMT_DIR / "UndertaleModCli.exe"

OFFICIAL = ROOT / "assets-official"
OFFICIAL_AUDIO = OFFICIAL / "02-audio"
OFFICIAL_DELTARUNE = OFFICIAL_AUDIO / "DELTARUNE"

ASSETS = Path(os.environ["DR_ASSETS"]).resolve() if os.environ.get("DR_ASSETS") else BATTLE_EDITOR / "assets"
MUS_DIR = ASSETS / "audio" / "mus"
SND_DIR = ASSETS / "audio" / "snd"
FONT_DIR = ASSETS / "fonts"
AUDIO_FONTS_INDEX = ASSETS / "audio-fonts.index.json"

CATALOG_DIR = HERE / "catalog"
CONFIG_DIR = HERE / "config"
UTMT_SCRIPTS = HERE / "utmt"

CHAPTERS = [1, 2, 3, 4, 5]

# 官方 zip 內章節資料夾命名
def chapter_folder(ch: int) -> Path:
    return OFFICIAL_DELTARUNE / f"chapter{ch}_windows"


def chapter_data_win(ch: int) -> Path:
    return chapter_folder(ch) / "data.win"


MUS_SRC = OFFICIAL_DELTARUNE / "mus"


# ── 小工具 ──────────────────────────────────────────────────────────────
try:  # Windows console 可能是 cp950/cp1252，強制 UTF-8 以免中文訊息炸掉
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")
except Exception:
    pass


def log(msg: str) -> None:
    print(msg, flush=True)


def rel_to_root(p: Path) -> str:
    try:
        return str(Path(p).resolve().relative_to(ROOT))
    except Exception:
        return str(p)


def load_json(path: Path, default=None):
    if not Path(path).exists():
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path: Path, obj) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(obj, f, ensure_ascii=False, indent=1)
        f.write("\n")
    os.replace(tmp, path)


def write_text(path: Path, text: str) -> None:
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    os.replace(tmp, path)


def run_utmt(data_win: Path, scripts: list[Path], env: dict | None = None,
             log_path: Path | None = None, timeout: int = 1800) -> int:
    """呼叫 UTMT CLI：load <data_win> -s <scripts...>。回傳 exit code。"""
    if not UTMT_CLI.exists():
        raise SystemExit(f"UTMT CLI 不存在：{UTMT_CLI}\n"
                         f"請先把 DELTARUNE_解包工具_UTMT-CLI_0.9.2.0.zip 解壓到 tools-external/utmt/")
    args = [str(UTMT_CLI), "load", str(data_win), "-s"] + [str(s) for s in scripts]
    child_env = os.environ.copy()
    child_env.update({k: str(v) for k, v in (env or {}).items()})
    started = time.time()
    proc = subprocess.run(
        args,
        cwd=str(UTMT_DIR),          # CLI 需要同目錄的 .dll
        env=child_env,
        capture_output=True,
        text=True,
        errors="replace",
        timeout=timeout,
    )
    out = (proc.stdout or "") + (proc.stderr or "")
    if log_path is not None:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.write_text(out, encoding="utf-8")
    elapsed = time.time() - started
    log(f"[utmt] {' '.join(Path(s).name for s in scripts)} on {data_win.parent.name} "
        f"-> exit={proc.returncode} ({elapsed:.1f}s)")
    if proc.returncode != 0:
        tail = "\n".join(out.strip().splitlines()[-25:])
        log(f"[utmt] 失敗輸出末 25 行：\n{tail}")
    return proc.returncode


def read_lines(path: Path) -> list[str]:
    """讀文字清單檔（# 註解、空行忽略）。"""
    out = []
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out


def ensure_dirs() -> None:
    for d in (MUS_DIR, SND_DIR, FONT_DIR, CATALOG_DIR, CONFIG_DIR):
        d.mkdir(parents=True, exist_ok=True)


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024:
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024.0
    return f"{n:.1f}TB"


# ── OTF/TTF 字元映射（只解析 sfnt 的 cmap，不需外部套件） ──────────────────
def sfnt_cmap_codepoints(path: Path) -> set[int]:
    """讀 OpenType/TrueType 的 cmap，回傳有映射的碼位集合。

    只支援 format 4（BMP）與 format 12（UCS-4），足以涵蓋中文補丁字體。
    解析失敗時回空集合（呼叫端視為「無法檢查」而非「沒有字」）。
    """
    import struct

    try:
        data = Path(path).read_bytes()
    except OSError:
        return set()
    if len(data) < 12 or data[:4] not in (b"OTTO", b"\x00\x01\x00\x00", b"true"):
        return set()
    try:
        num_tables = struct.unpack(">H", data[4:6])[0]
        cmap_off = None
        for i in range(num_tables):
            base = 12 + i * 16
            if base + 16 > len(data):
                return set()
            tag, _cs, off, _len = struct.unpack(">4sIII", data[base:base + 16])
            if tag == b"cmap":
                cmap_off = off
                break
        if cmap_off is None:
            return set()
        n_sub = struct.unpack(">H", data[cmap_off + 2:cmap_off + 4])[0]
        best12 = best4 = None
        for i in range(n_sub):
            rec = cmap_off + 4 + i * 8
            _pid, _eid, sub_off = struct.unpack(">HHI", data[rec:rec + 8])
            abs_off = cmap_off + sub_off
            fmt = struct.unpack(">H", data[abs_off:abs_off + 2])[0]
            if fmt == 12:
                best12 = abs_off
            elif fmt == 4 and best4 is None:
                best4 = abs_off
        cps: set[int] = set()
        if best12 is not None:
            n_groups = struct.unpack(">I", data[best12 + 12:best12 + 16])[0]
            for i in range(n_groups):
                o = best12 + 16 + i * 12
                if o + 12 > len(data):
                    break
                s, e, _g = struct.unpack(">III", data[o:o + 12])
                if e < s or e - s > 70000:
                    continue
                cps.update(range(s, e + 1))
        elif best4 is not None:
            seg_x2 = struct.unpack(">H", data[best4 + 6:best4 + 8])[0]
            seg = seg_x2 // 2
            ends = best4 + 14
            starts = ends + seg_x2 + 2
            for i in range(seg):
                e = struct.unpack(">H", data[ends + i * 2:ends + i * 2 + 2])[0]
                s = struct.unpack(">H", data[starts + i * 2:starts + i * 2 + 2])[0]
                if s != 0xFFFF and s <= e:
                    cps.update(range(s, e + 1))
        return cps
    except Exception:
        return set()
