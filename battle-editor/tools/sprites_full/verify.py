#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A3 產出驗證：assets/sprites-full.index.json + assets/sprites-full/** + assets/actor-presets.json。

檢查項目：
  1. index 每個 sprite：frames 非空、PNG 存在、尺寸 == index 的 w/h、ox/oy 在合理範圍、
     chapter/source/originVerified 欄位合法、幀檔名從 0 連續編號
  2. assets/sprites-full/ 下有沒有孤兒資料夾/檔案（index 未引用）
  3. actor-presets.json：每個 actor 的 kind/x/y/anims、每個 anim 的 sprite 必須存在於 index、
     fps>0、loop 是 bool、then 必須是同 actor 的狀態（或 idle）、隊員/敵人必要狀態是否齊
  4. 抽樣對 assets/index.json（Phase 1）比較同名項：幀數是否變多、原點是否變更（只報告）
  5. 統計：sprite 數/幀數/容量、各章、各 tag

用法：
  python tools/sprites_full/verify.py
  python tools/sprites_full/verify.py --strict      # 警告也當失敗
  python tools/sprites_full/verify.py --json        # 印機器可讀摘要
"""

import argparse
import json
import struct
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BE = HERE.parent.parent
ASSETS = Path(os.environ["DR_ASSETS"]).resolve() if os.environ.get("DR_ASSETS") else BE / "assets"
INDEX_PATH = ASSETS / "sprites-full.index.json"
SPRITES_DIR = ASSETS / "sprites-full"
PRESETS_PATH = ASSETS / "actor-presets.json"
PHASE1_INDEX = ASSETS / "index.json"

CHAPTERS = {"ch1", "ch2", "ch3", "ch4", "ch5"}
TAG_SET = {"party", "enemy", "soul", "ui", "battlebg", "bullet"}
PARTY_REQUIRED = ["idle", "attack", "act", "magic", "item", "spare", "defend", "hurt", "down", "victory"]
ENEMY_REQUIRED = ["idle"]

errors = []
warnings = []


def err(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


def png_size(path):
    """回傳 (w, h)；讀不到 / 不是 PNG 回傳 None。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(24)
    except OSError:
        return None
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    w, h = struct.unpack(">II", head[16:24])
    return w, h


def load(path):
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        err("找不到檔案：%s（先跑 tools/sprites_full/extract.py）" % path)
    except json.JSONDecodeError as exc:
        err("JSON 解析失敗：%s（%s）" % (path, exc))
    return None


def check_index(index):
    if not isinstance(index, dict):
        return
    if index.get("format") != "dr-battle-assets/1":
        err("index format 應為 'dr-battle-assets/1'，實際 %r" % index.get("format"))
    sprites = index.get("sprites")
    if not isinstance(sprites, dict) or not sprites:
        err("index.sprites 為空或型別錯誤")
        return

    seen_frames = {}
    per_chapter = {}
    per_tag = {}
    total_bytes = 0
    total_frames = 0

    referenced = set()
    for name, s in sprites.items():
        if not isinstance(s, dict):
            err("%s：index 項不是物件" % name)
            continue
        frames = s.get("frames")
        if not isinstance(frames, list) or not frames:
            err("%s：frames 空或型別錯誤" % name)
            continue
        w, h = s.get("w"), s.get("h")
        if not isinstance(w, int) or not isinstance(h, int) or w <= 0 or h <= 0:
            err("%s：w/h 不合法（%r/%r）" % (name, w, h))
            continue
        ox, oy = s.get("ox"), s.get("oy")
        if not isinstance(ox, int) or not isinstance(oy, int):
            err("%s：ox/oy 型別錯誤（%r/%r）" % (name, ox, oy))
        else:
            # 原作允許負原點（對齊用）；只擋真正離譜的值
            lim_w = max(w, h) * 4 + 64
            lim_h = max(w, h) * 4 + 64
            if not (-lim_w <= ox <= lim_w) or not (-lim_h <= oy <= lim_h):
                err("%s：原點 (%d,%d) 超出合理範圍（sprite %dx%d）" % (name, ox, oy, w, h))
        if s.get("originVerified") is not True:
            err("%s：originVerified 應為 true" % name)
        chapter = s.get("chapter")
        if chapter not in CHAPTERS:
            err("%s：chapter 不合法（%r）" % (name, chapter))
        else:
            per_chapter[chapter] = per_chapter.get(chapter, 0) + 1
        src = s.get("source")
        if not isinstance(src, str) or not src.startswith("utmt:ch"):
            err("%s：source 應為 'utmt:chN'（實際 %r）" % (name, src))
        elif src.split(":", 1)[1] != chapter:
            warn("%s：source %r 與 chapter %r 不一致" % (name, src, chapter))
        tags = s.get("tags")
        if not isinstance(tags, list) or not tags:
            err("%s：tags 空或型別錯誤" % name)
        else:
            for t in tags:
                if t not in TAG_SET:
                    err("%s：tag %r 不在允許清單 %s 內" % (name, t, sorted(TAG_SET)))
                else:
                    per_tag[t] = per_tag.get(t, 0) + 1
            if len(set(tags)) != len(tags):
                warn("%s：tags 有重複" % name)
        fps = s.get("fps")
        if fps is not None and (not isinstance(fps, (int, float)) or fps <= 0):
            err("%s：fps 不合法（%r）" % (name, fps))
        if fps is not None and len(frames) < 2:
            warn("%s：只有 1 幀卻有 fps（%r），index 慣例是不寫" % (name, fps))

        # 幀檔名連續性 + 檔案存在 + 尺寸
        for i, rel in enumerate(frames):
            if not isinstance(rel, str) or not rel.startswith("sprites-full/%s/" % name):
                err("%s：frames[%d] 路徑不合法（%r）" % (name, i, rel))
                continue
            if Path(rel).name != "%d.png" % i:
                err("%s：frames[%d] 檔名應為 %d.png（%r）" % (name, i, i, Path(rel).name))
            if rel in seen_frames:
                err("重複引用的幀：%s 同時屬於 %s 與 %s" % (rel, seen_frames[rel], name))
            seen_frames[rel] = name
            p = ASSETS / rel
            referenced.add(p)
            if not p.is_file():
                err("%s：缺圖 %s" % (name, rel))
                continue
            sz = p.stat().st_size
            total_bytes += sz
            if sz == 0:
                err("%s：空檔 %s" % (name, rel))
            got = png_size(p)
            if got is None:
                err("%s：不是有效 PNG %s" % (name, rel))
            elif got != (w, h):
                err("%s：尺寸不符 %s（PNG %dx%d / index %dx%d）" % (name, rel, got[0], got[1], w, h))
        total_frames += len(frames)
        # 多餘但不在 frames 的同名 png
        d = SPRITES_DIR / name
        if d.is_dir():
            on_disk = sorted(p.name for p in d.glob("*.png"))
            want = ["%d.png" % i for i in range(len(frames))]
            if on_disk != want:
                extra = [n for n in on_disk if n not in want]
                miss = [n for n in want if n not in on_disk]
                if extra:
                    warn("%s：資料夾有多餘 PNG（%s）" % (name, ", ".join(extra[:6])))
                if miss:
                    err("%s：資料夾缺 PNG（%s）" % (name, ", ".join(miss[:6])))
        else:
            err("%s：資料夾不存在 %s" % (name, d))

    # 孤兒
    if SPRITES_DIR.is_dir():
        for p in sorted(SPRITES_DIR.iterdir()):
            if p.is_dir():
                names = set(x.name for x in p.glob("*.png"))
                ref = set(Path(r).name for r in seen_frames if r.startswith("sprites-full/%s/" % p.name))
                if p.name not in sprites:
                    warn("孤兒資料夾（index 未引用）：%s" % p)
                elif names - ref:
                    pass  # 已在上面逐項檢查
            elif p.name != "exported.json":
                warn("孤兒檔案：%s" % p)
    else:
        err("找不到 %s" % SPRITES_DIR)

    return {
        "sprites": len(sprites),
        "frames": total_frames,
        "bytes": total_bytes,
        "per_chapter": per_chapter,
        "per_tag": per_tag,
        "referenced": len(referenced),
    }


def check_presets(presets, sprite_names):
    if presets is None:
        return None
    if presets.get("format") != "dr-battle-actor-presets/1":
        err("actor-presets format 應為 'dr-battle-actor-presets/1'，實際 %r" % presets.get("format"))
    actors = presets.get("actors")
    if not isinstance(actors, dict) or not actors:
        err("actor-presets.actors 為空或型別錯誤")
        return None
    counts = {"party": 0, "enemy": 0}
    for aid, a in actors.items():
        if not isinstance(a, dict):
            err("actor %s：不是物件" % aid)
            continue
        kind = a.get("kind")
        if kind not in ("party", "enemy"):
            err("actor %s：kind 應為 party/enemy（%r）" % (aid, kind))
            continue
        counts[kind] += 1
        if not isinstance(a.get("x"), (int, float)) or not isinstance(a.get("y"), (int, float)):
            err("actor %s：x/y 不合法" % aid)
        anims = a.get("anims")
        if not isinstance(anims, dict) or not anims:
            err("actor %s：anims 空" % aid)
            continue
        required = PARTY_REQUIRED if kind == "party" else ENEMY_REQUIRED
        for st in required:
            if st not in anims:
                if aid == "kris" and st == "magic":
                    warn("actor kris：沒有 magic 狀態（原作 Kris 不會魔法，可接受）")
                else:
                    err("actor %s：缺必要狀態 %r" % (aid, st))
        for st, spec in anims.items():
            if not isinstance(spec, dict):
                err("actor %s.%s：不是物件" % (aid, st))
                continue
            spr = spec.get("sprite")
            if not isinstance(spr, str) or not spr:
                err("actor %s.%s：缺 sprite" % (aid, st))
            elif spr not in sprite_names:
                err("actor %s.%s：sprite %r 不在 sprites-full.index.json" % (aid, st, spr))
            fps = spec.get("fps")
            if not isinstance(fps, (int, float)) or fps <= 0:
                err("actor %s.%s：fps 不合法（%r）" % (aid, st, fps))
            if not isinstance(spec.get("loop"), bool):
                err("actor %s.%s：loop 應為 bool" % (aid, st))
            then = spec.get("then")
            if then is not None:
                if not isinstance(then, str):
                    err("actor %s.%s：then 應為字串" % (aid, st))
                elif then not in anims and then != "idle":
                    err("actor %s.%s：then %r 不是同 actor 的狀態" % (aid, st, then))
    # layouts：party3/party4（帶 id 的隊員站位）、enemy1..3（純 x/y 的敵人站位）
    layouts = presets.get("layouts")
    if layouts is None:
        warn("actor-presets 沒有 layouts 欄位（隊員/敵人站位建議缺）")
    elif not isinstance(layouts, dict):
        err("actor-presets.layouts 應為物件")
    else:
        for lname, slots in layouts.items():
            if lname.startswith("_"):
                continue
            if not isinstance(slots, list) or not slots:
                err("layouts.%s：應為非空陣列" % lname)
                continue
            for i, slot in enumerate(slots):
                if not isinstance(slot, dict):
                    err("layouts.%s[%d]：不是物件" % (lname, i))
                    continue
                if not isinstance(slot.get("x"), (int, float)) or not isinstance(slot.get("y"), (int, float)):
                    err("layouts.%s[%d]：x/y 不合法" % (lname, i))
                sid = slot.get("id")
                if lname.startswith("party"):
                    if sid not in actors:
                        err("layouts.%s[%d]：id %r 不在 actors" % (lname, i, sid))
                    elif actors[sid].get("kind") != "party":
                        err("layouts.%s[%d]：id %r 不是 party" % (lname, i, sid))
                elif isinstance(sid, str) and sid:
                    err("layouts.%s[%d]：敵人站位不應帶 id" % (lname, i))
            try:
                n = int(lname[-1])
            except ValueError:
                n = None
            if n is not None and n != len(slots):
                err("layouts.%s：站位數 %d 與名稱結尾 %d 不符" % (lname, len(slots), n))
    for k, need in (("party", 1), ("enemy", 1)):
        if counts[k] < need:
            err("actor-presets 缺 %s actors" % k)
    return counts


def main():
    ap = argparse.ArgumentParser(description="驗證 assets/sprites-full 產出")
    ap.add_argument("--strict", action="store_true", help="警告也當失敗")
    ap.add_argument("--json", action="store_true", help="印機器可讀摘要")
    args = ap.parse_args()

    index = load(INDEX_PATH)
    stats = check_index(index) if index else None
    sprite_names = set((index or {}).get("sprites", {}).keys())

    presets = load(PRESETS_PATH) if PRESETS_PATH.is_file() else None
    if presets is None and not PRESETS_PATH.is_file():
        err("找不到 %s" % PRESETS_PATH)
    actor_counts = check_presets(presets, sprite_names) if presets else None

    # 與 Phase 1 比對（只報告）
    p1 = None
    if PHASE1_INDEX.is_file() and index:
        try:
            p1 = load(PHASE1_INDEX).get("sprites") or {}
        except Exception:  # noqa: BLE001
            p1 = None
    compare = None
    if p1 and index:
        mine = index["sprites"]
        both = [n for n in p1 if n in mine]
        up = [n for n in both if len(mine[n]["frames"]) > len(p1[n].get("frames") or [])]
        down = [n for n in both if len(mine[n]["frames"]) < len(p1[n].get("frames") or [])]
        org = [n for n in both if (mine[n]["ox"], mine[n]["oy"]) != (p1[n].get("ox"), p1[n].get("oy"))]
        compare = {
            "phase1Sprites": len(p1),
            "sameName": len(both),
            "framesIncreased": len(up),
            "framesDecreased": len(down),
            "originChanged": len(org),
            "newInFull": len([n for n in mine if n not in p1]),
            "onlyPhase1": len([n for n in p1 if n not in mine]),
        }

    ok = not errors and (not args.strict or not warnings)
    summary = {
        "ok": ok,
        "errors": len(errors),
        "warnings": len(warnings),
        "stats": stats,
        "actors": actor_counts,
        "comparePhase1": compare,
    }
    if args.json:
        print(json.dumps(summary, ensure_ascii=False, indent=1))
    else:
        print("== verify sprites-full ==")
        if stats:
            print("sprites=%d frames=%d size=%.2f MB" % (stats["sprites"], stats["frames"],
                                                          stats["bytes"] / 1048576.0))
            print("chapter：" + ", ".join("%s=%d" % (k, stats["per_chapter"][k])
                                          for k in sorted(stats["per_chapter"])))
            print("tags：" + ", ".join("%s=%d" % (k, stats["per_tag"][k]) for k in sorted(stats["per_tag"])))
        if actor_counts:
            print("actors：party=%d enemy=%d" % (actor_counts["party"], actor_counts["enemy"]))
        if compare:
            print("vs Phase1：同名 %d，幀數增加 %d、減少 %d、原點變更 %d；本次新增 %d、Phase1 獨有 %d" % (
                compare["sameName"], compare["framesIncreased"], compare["framesDecreased"],
                compare["originChanged"], compare["newInFull"], compare["onlyPhase1"]))
        print("errors=%d warnings=%d -> %s" % (len(errors), len(warnings), "OK" if ok else "FAIL"))
        for e in errors[:40]:
            print("  [ERROR] " + e)
        if len(errors) > 40:
            print("  … 其餘 %d 個錯誤省略" % (len(errors) - 40))
        for w in warnings[:20]:
            print("  [WARN] " + w)
        if len(warnings) > 20:
            print("  … 其餘 %d 個警告省略" % (len(warnings) - 20))
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
