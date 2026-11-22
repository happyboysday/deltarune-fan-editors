#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""extract_music.py — 把 DELTARUNE 的 mus/*.ogg 中「戰鬥相關/常用」的曲子複製到
battle-editor/assets/audio/mus/。

規則來源：tools/audio_fonts/config/music_rules.json
  files     明確曲目（不含 .ogg）
  patterns  正則（不區分大小寫），符合 BaseName 者納入
  exclude   正則，最後套用
  tags      曲目 → 標籤（寫進 index）
  loopDefault  預設 loop 值

冪等：來源與目的大小相同則跳過；不刪除任何既有檔案。
單獨執行：python tools/audio_fonts/extract_music.py [--force]
"""
from __future__ import annotations

import re
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import (  # noqa: E402
    MUS_SRC, MUS_DIR, CONFIG_DIR, CATALOG_DIR, load_json, write_json,
    ensure_dirs, log, human_size,
)

RULES_PATH = CONFIG_DIR / "music_rules.json"
RULES_REL = "music_rules.json"


def select_tracks(rules: dict) -> list[str]:
    explicit = list(rules.get("files") or [])
    patterns = [re.compile(p, re.IGNORECASE) for p in (rules.get("patterns") or [])]
    excludes = [re.compile(p, re.IGNORECASE) for p in (rules.get("exclude") or [])]

    chosen: list[str] = []
    seen = set()

    def add(name: str):
        if name in seen:
            return
        if any(rx.search(name) for rx in excludes):
            return
        seen.add(name)
        chosen.append(name)

    available = {p.stem: p for p in MUS_SRC.glob("*.ogg")}
    for name in explicit:
        if name in available:
            add(name)
        else:
            log(f"[music] 規則中的 {name} 在 mus/ 中不存在，跳過")
    for stem in sorted(available):
        if any(rx.search(stem) for rx in patterns):
            add(stem)
    return chosen


def main(argv: list[str]) -> int:
    force = "--force" in argv
    ensure_dirs()
    if not MUS_SRC.exists():
        raise SystemExit(f"找不到音樂來源：{MUS_SRC}")

    rules = load_json(RULES_PATH)
    if rules is None:
        raise SystemExit(f"找不到規則檔：{RULES_PATH}")

    tracks = select_tracks(rules)
    tags_map: dict[str, list[str]] = {}
    for tag, names in (rules.get("tags") or {}).items():
        for n in names:
            tags_map.setdefault(n, [])
            if tag not in tags_map[n]:
                tags_map[n].append(tag)
    loop_default = bool(rules.get("loopDefault", True))
    loop_false = set(rules.get("loopFalse") or [])

    copied = skipped = 0
    total = 0
    entries: dict[str, dict] = {}

    for name in tracks:
        src = MUS_SRC / f"{name}.ogg"
        dst = MUS_DIR / f"{name}.ogg"
        if dst.exists() and dst.stat().st_size == src.stat().st_size and not force:
            skipped += 1
        else:
            shutil.copy2(src, dst)
            copied += 1
        size = dst.stat().st_size
        total += size
        entries[name] = {
            "file": f"audio/mus/{name}.ogg",
            "kind": "music",
            "loop": (name not in loop_false) if loop_default else (name in loop_false),
            "tags": tags_map.get(name, []),
            "bytes": size,
        }

    # 未登記在 rules.tags 但有檔案的，補上 fallback 標籤
    for name in entries:
        if not entries[name]["tags"]:
            entries[name]["tags"] = ["battle"] if "battle" in name else []

    manifest = {
        "format": "dr-battle-music-manifest/1",
        "source": "DELTARUNE/mus",
        "rules": RULES_REL,
        "count": len(entries),
        "tracks": entries,
    }
    write_json(HERE / "manifest_music.json", manifest)
    log(f"[music] 選入 {len(entries)} 首（複製 {copied}、跳過 {skipped}），"
        f"合計 {human_size(total)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
