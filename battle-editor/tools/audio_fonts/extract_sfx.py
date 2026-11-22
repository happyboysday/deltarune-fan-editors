#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""extract_sfx.py — 從 data.win / audiogroup*.dat 匯出戰鬥用音效到
battle-editor/assets/audio/snd/。

規則來源：tools/audio_fonts/config/sfx_rules.json
  groups            { 群組名: {desc, names:[snd_*]} }
  patterns          正則（不區分大小寫），比對「名稱」後納入
  exclude           正則，最後套用
  purposeOverrides  { 名稱: 用途說明 }（寫進 index 的 desc）

策略：章節由新到舊（5→1）逐一跑 UTMT dump_sounds.csx，UTMT_SKIP_EXISTING=1，
因此同一名稱只保留「最新章節有資料」的版本；後面的舊章節只補洞。

冪等：已存在的輸出檔不會被覆寫（除非 --force）。
單獨執行：python tools/audio_fonts/extract_sfx.py [--force] [--chapters 5,4,3]
"""
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from common import (  # noqa: E402
    CATALOG_DIR, CHAPTERS, CONFIG_DIR, SND_DIR, chapter_data_win,
    ensure_dirs, load_json, log, rel_to_root, run_utmt, write_json, read_lines,
    human_size,
)

RULES_PATH = CONFIG_DIR / "sfx_rules.json"
DUMP_CSX = HERE / "utmt" / "dump_sounds.csx"
AVAIL_PATH = CATALOG_DIR / "snd_availability.json"
ALL_NAMES_PATH = CATALOG_DIR / "ALL_SND_NAMES.txt"

MANIFEST = HERE / "manifest_sfx.json"


def collect_targets(rules: dict) -> tuple[dict[str, dict], list[str]]:
    """回傳 ({name: {groups:[], desc:""}}, 依序的名稱清單)。"""
    groups: dict[str, dict] = {}
    ordered: list[str] = []
    seen: set[str] = set()

    def add(name: str, group: str | None):
        if name in seen:
            if group and group not in groups[name]["groups"]:
                groups[name]["groups"].append(group)
            return
        seen.add(name)
        groups[name] = {"groups": [group] if group else [], "desc": ""}
        ordered.append(name)

    for gname, g in (rules.get("groups") or {}).items():
        for n in g.get("names") or []:
            add(n, gname)

    patterns = [re.compile(p, re.IGNORECASE) for p in (rules.get("patterns") or [])]
    excludes = [re.compile(p, re.IGNORECASE) for p in (rules.get("exclude") or [])]
    if ALL_NAMES_PATH.exists():
        for n in read_lines(ALL_NAMES_PATH):
            if any(rx.search(n) for rx in patterns):
                add(n, "pattern")
    for n in list(ordered):
        if any(rx.search(n) for rx in excludes):
            groups.pop(n, None)
            ordered.remove(n)

    overrides = rules.get("purposeOverrides") or {}
    for n in ordered:
        groups[n]["desc"] = overrides.get(n, "")
    return groups, ordered


def main(argv: list[str]) -> int:
    force = "--force" in argv
    only = None
    for i, a in enumerate(argv):
        if a == "--chapters" and i + 1 < len(argv):
            only = [int(x) for x in argv[i + 1].split(",") if x.strip()]

    ensure_dirs()
    rules = load_json(RULES_PATH)
    if rules is None:
        raise SystemExit(f"找不到規則檔：{RULES_PATH}")
    avail = load_json(AVAIL_PATH, {}) or {}
    targets, ordered = collect_targets(rules)

    unknown = [n for n in ordered if avail and n not in avail]
    if unknown:
        log(f"[sfx] 警告：{len(unknown)} 個名稱在所有章節都不存在，會自動跳過："
            f"{', '.join(unknown[:10])}{' …' if len(unknown) > 10 else ''}")
        for n in unknown:
            targets.pop(n, None)
        ordered = [n for n in ordered if n in targets]

    log(f"[sfx] 目標音效 {len(ordered)} 個（{len(rules.get('groups') or {})} 個群組）")

    chapters = list(reversed(CHAPTERS))          # 5 → 1（新章優先）
    if only:
        chapters = [c for c in chapters if c in only]

    results: dict[str, dict] = {}

    # 增量重跑時 UTMT 會跳過已存在的檔案（manifest 因此是空的），
    # 所以先用「磁碟上既有的檔案 + 上一輪 manifest」重建基礎。
    prev = load_json(MANIFEST) or {}
    prev_sounds = prev.get("sounds") or {}
    if not force:
        for name, tinfo in targets.items():
            rec = prev_sounds.get(name) or {}
            fp = None
            for ext in (".wav", ".ogg"):
                cand = SND_DIR / (name + ext)
                if cand.exists():
                    fp = cand
                    break
            if fp is None:
                continue
            chapter = rec.get("chapter")
            if not chapter:
                # 從可用性表推出「最新有資料」的章節
                chap_list = (avail.get(name) or {}).get("chapters") or []
                chapter = f"ch{chap_list[0]}" if chap_list else "?"
            src = rec.get("src")
            if not src:
                # 用可用性表還原來源（data.win / audiogroupN / external）
                ch_key = str(chapter).replace("ch", "")
                variant = ((avail.get(name) or {}).get("variants") or {}).get(ch_key) or {}
                src = variant.get("loc") or "?"
            results[name] = {
                "file": f"audio/snd/{fp.name}",
                "kind": "sfx",
                "chapter": chapter,
                "src": src,
                "ext": fp.suffix,
                "bytes": fp.stat().st_size,
                "groups": tinfo.get("groups", []),
                "desc": tinfo.get("desc", ""),
            }
    if results:
        log(f"[sfx] 沿用既有 {len(results)} 個（增量模式）")

    tmp_lists = HERE / "catalog" / "sfx_lists"
    tmp_lists.mkdir(parents=True, exist_ok=True)

    for ch in chapters:
        data_win = chapter_data_win(ch)
        if not data_win.exists():
            log(f"[sfx] ch{ch} data.win 不存在，跳過")
            continue
        # 只把「本章存在且還沒抓到」的名稱交給 UTMT，減少工作量
        want = []
        for n in ordered:
            if n in results:
                continue
            rec = avail.get(n) or {}
            if rec and ch not in (rec.get("chapters") or []):
                continue
            want.append(n)
        if not want:
            log(f"[sfx] ch{ch} 沒有待抓的名稱，跳過")
            continue
        list_path = tmp_lists / f"ch{ch}.txt"
        list_path.write_text("\n".join(want) + "\n", encoding="utf-8")

        env = {
            "UTMT_SND_OUT": str(SND_DIR),
            "UTMT_SND_LIST": str(list_path),
            "UTMT_CHAPTER": f"ch{ch}",
            "UTMT_SKIP_EXISTING": "0" if force else "1",
        }
        log_path = tmp_lists / f"ch{ch}.log"
        rc = run_utmt(data_win, [DUMP_CSX], env=env, log_path=log_path)
        if rc != 0:
            continue
        mpath = SND_DIR / f"_manifest_ch{ch}.json"
        if not mpath.exists():
            log(f"[sfx] ch{ch} 未產生 manifest：{mpath}")
            continue
        for ent in json.loads(mpath.read_text(encoding="utf-8")):
            if ent["name"] in results:
                continue   # 新章節已抓到
            results[ent["name"]] = {
                "file": f"audio/snd/{ent['file']}",
                "kind": "sfx",
                "chapter": ent["chapter"],
                "src": ent["src"],
                "ext": ent["ext"],
                "bytes": ent["bytes"],
                "groups": targets.get(ent["name"], {}).get("groups", []),
                "desc": targets.get(ent["name"], {}).get("desc", ""),
            }
        log(f"[sfx] 累計 {len(results)}/{len(ordered)}")

    missing = [n for n in ordered if n not in results]
    if missing:
        log(f"[sfx] 未取得（可能該章資料不可用）：{len(missing)} 個")
        for n in missing:
            log(f"       - {n}")

    # 清掉章節 manifest（屬中間產物，index 才是正式輸出）
    for ch in CHAPTERS:
        p = SND_DIR / f"_manifest_ch{ch}.json"
        if p.exists():
            p.unlink()

    total = sum(v["bytes"] for v in results.values())
    ogg = sum(1 for v in results.values() if v["ext"] == ".ogg")
    wav = sum(1 for v in results.values() if v["ext"] == ".wav")
    by_chapter: dict[str, int] = {}
    for v in results.values():
        by_chapter[v["chapter"]] = by_chapter.get(v["chapter"], 0) + 1

    manifest = {
        "format": "dr-battle-sfx-manifest/1",
        "count": len(results),
        "byChapter": by_chapter,
        "byExt": {".ogg": ogg, ".wav": wav},
        "bytes": total,
        "sounds": results,
    }
    # 增量模式下若這一輪什麼都沒抓到（檔案都已在），不要用空結果蓋掉舊 manifest
    if len(results) == 0 and (prev.get("count") or 0) > 0:
        log(f"[sfx] 本輪無新檔案，保留既有 manifest（{prev.get('count')} 個）")
    else:
        write_json(MANIFEST, manifest)
    log(f"[sfx] 完成：{len(results)} 個音效（{ogg} ogg / {wav} wav），"
        f"合計 {human_size(total)}；章節分佈 {by_chapter}")
    log(f"[sfx] manifest -> {rel_to_root(MANIFEST)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
