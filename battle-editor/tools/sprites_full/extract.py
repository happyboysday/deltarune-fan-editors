#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A3：戰鬥 sprite 全幀補拆（UTMT data.win → assets/sprites-full + index + actor presets）。

流程（冪等）：
  1. 讀 tools/sprites_full/config/select.json
  2. 對每章 data.win 跑 utmt/probe_sprites.csx（catalog/probe_<ch>/sprites.json；已是最新則跳過）
  3. 依 select.json 規則選 sprite（名稱正則 + tags；敵人＝家族展開）
     每個名字取「最新章」為來源章（chapterPriority）
  4. 對來源章跑 utmt/export_sprites.csx 匯出全部幀到 assets/sprites-full/<name>/<i>.png
     （每幀固定 sprite 寬高畫布，原點 (OriginX, OriginY) 才有意義；已存在且幀數正確則跳過）
  5. 寫 assets/sprites-full.index.json（SPEC §2 格式 + originVerified/fps/source）
  6. 由 config/actor_presets.json 產生 assets/actor-presets.json（SPEC-P2 §1 actors.<id>.anims）
  7. 印統計與對 Phase 1 單幀索引（assets/index.json）的差異

用法：
  python tools/sprites_full/extract.py                 # 全流程（已快取處自動跳過）
  python tools/sprites_full/extract.py --dry-run       # 只印選取統計，不碰檔案
  python tools/sprites_full/extract.py --force-export  # 重新匯出所有選取 sprite
  python tools/sprites_full/extract.py --force-probe   # 重跑 data.win probe
  python tools/sprites_full/extract.py --chapters ch1,ch2
  python tools/sprites_full/extract.py --no-probe --no-export   # 只用現有 catalog/PNG 重建 index/presets
"""

import argparse
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent          # battle-editor/tools/sprites_full
BE = HERE.parent.parent                          # battle-editor
REPO = BE.parent                                 # DeltaruneWorks
UTMT_DIR = REPO / "tools-external" / "utmt"
UTMT_EXE = UTMT_DIR / "UndertaleModCli.exe"
PROBE_CSX = HERE / "utmt" / "probe_sprites.csx"
EXPORT_CSX = HERE / "utmt" / "export_sprites.csx"
CATALOG = HERE / "catalog"
CONFIG = HERE / "config" / "select.json"
PRESET_SRC = HERE / "config" / "actor_presets.json"
ASSETS = Path(os.environ["DR_ASSETS"]).resolve() if os.environ.get("DR_ASSETS") else BE / "assets"
OUT_DIR = ASSETS / "sprites-full"
INDEX_PATH = ASSETS / "sprites-full.index.json"
PRESETS_PATH = ASSETS / "actor-presets.json"
PHASE1_INDEX = ASSETS / "index.json"
TMP = Path(os.environ.get("TEMP") or "/tmp") / "sprites_full_a3"

TAG_ORDER = ["party", "enemy", "soul", "ui", "battlebg", "bullet"]


# ---------------------------------------------------------------- helpers

def log(msg=""):
    print(msg, flush=True)


def die(msg):
    print("ERROR: " + msg, file=sys.stderr, flush=True)
    sys.exit(1)


def load_json(path):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def dump_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=1)
        fh.write("\n")
    os.replace(tmp, path)


def data_win(chapter, cfg):
    num = chapter[2:]
    for tpl in cfg.get("dataWinTemplates", []):
        rel = tpl.format(chapter=chapter, chapterNum=num)
        p = REPO / rel
        if p.is_file():
            return p
    return None


def run_utmt(script, dw, env_extra, timeout=1800):
    if not UTMT_EXE.is_file():
        die("找不到 UTMT CLI：%s（UTMT 0.9.2.0 應在 tools-external/utmt/）" % UTMT_EXE)
    env = os.environ.copy()
    env.update({k: str(v) for k, v in env_extra.items()})
    t0 = time.time()
    try:
        p = subprocess.run(
            [str(UTMT_EXE), "load", str(dw), "-s", str(script)],
            cwd=str(UTMT_DIR), env=env, capture_output=True, timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        die("UTMT 逾時（%s, %s）" % (script.name, dw))
    dt = time.time() - t0
    out = (p.stdout or b"").decode("utf-8", "replace")
    err = (p.stderr or b"").decode("utf-8", "replace")
    return p.returncode, out, err, dt


def utmt_tail(out, err, n=1600):
    s = (out or "").strip()
    if len(s) > n:
        s = "…" + s[-n:]
    e = (err or "").strip()
    if len(e) > n:
        e = "…" + e[-n:]
    return (s + ("\n[stderr]\n" + e if e else "")).strip()


# ---------------------------------------------------------------- probe

def ensure_probe(cfg, chapters, force):
    for ch in chapters:
        dw = data_win(ch, cfg)
        if dw is None:
            die("找不到 %s 的 data.win（看 select.json dataWinTemplates 或 assets-official/04-game/）" % ch)
        pdir = CATALOG / ("probe_" + ch)
        pfile = pdir / "sprites.json"
        if pfile.is_file() and not force and pfile.stat().st_mtime >= dw.stat().st_mtime:
            log("[probe] %s 已有最新 catalog，跳過" % ch)
            continue
        pdir.mkdir(parents=True, exist_ok=True)
        log("[probe] %s ← %s …" % (ch, dw.relative_to(REPO)))
        rc, out, err, dt = run_utmt(PROBE_CSX, dw, {"UTMT_OUT": str(pdir), "UTMT_CHAPTER": ch})
        if rc != 0 or not pfile.is_file():
            die("probe %s 失敗（rc=%s, %.1fs）\n%s" % (ch, rc, dt, utmt_tail(out, err)))
        try:
            d = load_json(pfile)
        except Exception as exc:  # noqa: BLE001
            die("probe %s 產出的 JSON 無法解析：%s" % (ch, exc))
        log("[probe] %s ok：sprites=%d objects=%d frames=%d（%.1fs）" % (
            ch, len(d.get("sprites", [])), len(d.get("objects", [])),
            sum(s.get("frameCount", 0) for s in d.get("sprites", [])), dt))


def load_catalogs(chapters):
    cats = {}
    for ch in chapters:
        pfile = CATALOG / ("probe_" + ch) / "sprites.json"
        if not pfile.is_file():
            die("缺少 catalog：%s（先讓 extract.py 跑 probe，或給 --force-probe）" % pfile)
        d = load_json(pfile)
        cats[ch] = {
            "chapter": ch,
            "sprites": {s["name"]: s for s in d.get("sprites", [])},
            "objects": d.get("objects", []),
        }
    return cats


# ---------------------------------------------------------------- selection

def compile_patterns(patterns):
    out = []
    for p in patterns:
        try:
            out.append(re.compile(p))
        except re.error as exc:  # noqa: BLE001
            die("select.json 的正則壞了：%r（%s）" % (p, exc))
    return out


def select_sprites(cfg, cats, chapters):
    rules = []
    for r in cfg.get("rules", []):
        rules.append({
            "id": r["id"],
            "tags": list(r.get("tags", [])),
            "include": compile_patterns(r.get("include", [])),
            "exclude": compile_patterns(r.get("exclude", [])),
        })
    gx = compile_patterns(cfg.get("globalExclude", []))
    enemy = cfg.get("enemy", {})
    ex_fam = compile_patterns(enemy.get("exclude", []))
    bullet_re = None
    if enemy.get("bulletTagPattern"):
        bullet_re = re.compile(enemy["bulletTagPattern"], re.I)

    all_names = set()
    for ch in chapters:
        all_names.update(cats[ch]["sprites"].keys())

    selected = {}   # name -> {"tags": [...], "rule": ...}
    per_rule = {}
    for name in sorted(all_names):
        if any(rx.search(name) for rx in gx):
            continue
        for rule in rules:
            if not any(rx.search(name) for rx in rule["include"]):
                continue
            if any(rx.search(name) for rx in rule["exclude"]):
                continue
            selected[name] = {"tags": list(rule["tags"]), "rule": rule["id"]}
            per_rule[rule["id"]] = per_rule.get(rule["id"], 0) + 1
            break

    # 敵人：家族展開 + 個別指定（不覆蓋上面規則已選到的）
    fam_hits = {}
    fam_missing = []
    for fam in enemy.get("families", []):
        hit = [n for n in all_names if n == fam or n.startswith(fam + "_")]
        if not hit:
            fam_missing.append(fam)
            continue
        fam_hits[fam] = 0
        for name in sorted(hit):
            if name in selected:
                continue
            if any(rx.search(name) for rx in gx):
                continue
            if any(rx.search(name) for rx in ex_fam):
                continue
            tags = ["enemy"]
            if bullet_re is not None and bullet_re.search(name):
                tags.append("bullet")
            selected[name] = {"tags": tags, "rule": "enemy:" + fam}
            per_rule["enemy"] = per_rule.get("enemy", 0) + 1
            fam_hits[fam] += 1
    for name in enemy.get("sprites", []):
        if name in selected:
            continue
        if not any(name in cats[ch]["sprites"] for ch in chapters):
            die("select.json enemy.sprites 指定的 %r 不存在於任何章 data.win" % name)
        selected[name] = {"tags": ["enemy"], "rule": "enemy:sprite"}
        per_rule["enemy"] = per_rule.get("enemy", 0) + 1

    # 決定來源章（最新章優先）與 meta
    priority = [ch for ch in cfg.get("chapterPriority", []) if ch in chapters]
    entries = {}
    dropped = []
    for name, sel in selected.items():
        src = None
        for ch in priority:
            if name in cats[ch]["sprites"]:
                src = ch
                break
        if src is None:  # 理論上不會發生
            dropped.append((name, "no-source"))
            continue
        meta = cats[src]["sprites"][name]
        fc = int(meta.get("frameCount") or 0)
        if fc < 1:
            dropped.append((name, "0-frame"))
            continue
        entries[name] = {
            "tags": sel["tags"],
            "rule": sel["rule"],
            "src": src,
            "meta": meta,
            "frames": fc,
        }

    stats = {
        "per_rule": per_rule,
        "families": len(fam_hits),
        "family_missing": fam_missing,
        "dropped": dropped,
        "sprites": len(entries),
        "frames": sum(e["frames"] for e in entries.values()),
        "by_chapter": {},
        "by_tag": {},
    }
    for e in entries.values():
        stats["by_chapter"][e["src"]] = stats["by_chapter"].get(e["src"], 0) + 1
        for t in e["tags"]:
            stats["by_tag"][t] = stats["by_tag"].get(t, 0) + 1
    return entries, stats


# ---------------------------------------------------------------- export

def dir_ok(path, frames):
    if not path.is_dir():
        return False
    names = set(p.name for p in path.iterdir() if p.suffix.lower() == ".png")
    want = set("%d.png" % i for i in range(frames))
    if names != want:
        return False
    return all((path / f).stat().st_size > 0 for f in want)


def export_chapter(ch, entries, cfg, force, dry):
    dw = data_win(ch, cfg)
    if dw is None:
        die("找不到 %s 的 data.win" % ch)
    names = sorted(entries)
    if dry:
        log("[export] %s 會匯出 %d sprites / %d frames（dry-run）" % (ch, len(names), sum(e["frames"] for e in entries.values())))
        return {"sprites": 0, "frames": 0, "cached": 0}
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if not force and all(dir_ok(OUT_DIR / n, entries[n]["frames"]) for n in names):
        log("[export] %s 快取完整，跳過（%d sprites / %d frames）" % (ch, len(names), sum(e["frames"] for e in entries.values())))
        return {"sprites": 0, "frames": 0, "cached": len(names)}
    TMP.mkdir(parents=True, exist_ok=True)
    listfile = TMP / ("export_%s.txt" % ch)
    listfile.write_text("\n".join(names) + "\n", encoding="utf-8")
    for n in names:   # 先清掉舊幀，避免新舊幀數不同留下殘檔
        shutil.rmtree(OUT_DIR / n, ignore_errors=True)
    log("[export] %s ← %s（%d sprites / %d frames）…" % (ch, dw.relative_to(REPO), len(names),
                                                        sum(e["frames"] for e in entries.values())))
    rc, out, err, dt = run_utmt(EXPORT_CSX, dw, {
        "UTMT_OUT": str(OUT_DIR), "UTMT_LIST": str(listfile), "UTMT_CHAPTER": ch,
    })
    exp_path = OUT_DIR / "exported.json"
    if rc != 0 or not exp_path.is_file():
        die("export %s 失敗（rc=%s, %.1fs）\n%s" % (ch, rc, dt, utmt_tail(out, err)))
    exp = load_json(exp_path)
    bad = [e for e in exp.get("exported", []) if len(e.get("files", [])) != e.get("frameCount")]
    if exp.get("missingSprites") or exp.get("failedFrames") or bad:
        die("export %s 有問題：missing=%s failedFrames=%s 幀數不符=%s\n%s" % (
            ch, exp.get("missingSprites"), exp.get("failedFrames"),
            [(e["name"], len(e.get("files", [])), e.get("frameCount")) for e in bad][:10],
            utmt_tail(out, err)))
    # 逐項驗證實際檔案
    for n in names:
        want = entries[n]["frames"]
        if not dir_ok(OUT_DIR / n, want):
            got = sorted(p.name for p in (OUT_DIR / n).glob("*.png")) if (OUT_DIR / n).is_dir() else []
            die("export %s：%s 幀數不符（期望 %d，實際 %d）" % (ch, n, want, len(got)))
    log("[export] %s ok：%d sprites / %d frames（%.1fs）" % (ch, len(names), exp.get("frames", 0), dt))
    return {"sprites": len(names), "frames": exp.get("frames", 0), "cached": 0}


def prune_stale(selected_names):
    if not OUT_DIR.is_dir():
        return 0
    n = 0
    for p in sorted(OUT_DIR.iterdir()):
        if p.name == "exported.json":
            p.unlink()
            continue
        if p.is_dir() and p.name not in selected_names:
            shutil.rmtree(p, ignore_errors=True)
            n += 1
        elif p.is_file():
            p.unlink()
    return n


# ---------------------------------------------------------------- index

def fps_for(meta, game_fps):
    fc = int(meta.get("frameCount") or 0)
    if fc < 2:
        return None
    try:
        speed = float(meta.get("playbackSpeed"))
    except (TypeError, ValueError):
        return None
    ptype = meta.get("playbackType")
    if ptype == 0:
        fps = speed
    elif ptype == 1:
        if abs(speed - 1.0) < 1e-9:
            return None          # 預設值：GMS 每個 game frame 前進 1 幀，不代表真實演出速度
        fps = speed * game_fps
    else:
        return None
    if fps <= 0:
        return None
    fps = round(fps, 2)
    return int(fps) if float(fps).is_integer() else fps


def png_dims(path):
    """回傳 PNG 的 (w, h)；讀不到就回傳 None（只讀 IHDR，不依賴 Pillow）。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(24)
    except OSError:
        return None
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return struct.unpack(">II", head[16:24])


def build_index(entries, cfg):
    sprites = {}
    scaled = []
    mixed = []
    for name in sorted(entries):
        e = entries[name]
        meta = e["meta"]
        w = int(meta.get("w") or 0)
        h = int(meta.get("h") or 0)
        ox = int(meta.get("ox") or 0)
        oy = int(meta.get("oy") or 0)
        frames = ["sprites-full/%s/%d.png" % (name, i) for i in range(e["frames"])]
        # 少數 sprite 的 Width/Height 與實際 texture page item 尺寸不一致（如
        # spr_swatchling_head、spr_pink_spotlight_*、spr_battleblcon_ghost_bottom_anim2）。
        # 實際顯示用的是 texture 尺寸，故 index 以 PNG 尺寸為準，原點按比例換算。
        dims = [png_dims(ASSETS / f) for f in frames]
        dims = [d for d in dims if d]
        if dims:
            aw, ah = dims[0]
            if (aw, ah) != (w, h) and w > 0 and h > 0 and aw > 0 and ah > 0:
                ox = int(round(ox * aw / float(w)))
                oy = int(round(oy * ah / float(h)))
                w, h = aw, ah
                scaled.append("%s %dx%d→%dx%d" % (name, int(meta.get("w") or 0), int(meta.get("h") or 0), w, h))
            if any(d != (w, h) for d in dims):
                mixed.append(name)
        item = {
            "frames": frames,
            "w": w,
            "h": h,
            "ox": ox,
            "oy": oy,
            "chapter": e["src"],
            "tags": sorted(set(e["tags"]), key=lambda t: (TAG_ORDER.index(t) if t in TAG_ORDER else 99, t)),
            "originVerified": True,
            "source": "utmt:" + e["src"],
        }
        fps = fps_for(meta, int(cfg.get("gameFps", 30)))
        if fps is not None:
            item["fps"] = fps
        sprites[name] = item
    if scaled:
        log("[index] 注意：%d 隻 sprite 的 Width/Height 與 texture 尺寸不同，已改用 PNG 尺寸並按比例換算原點：" % len(scaled))
        log("        " + "; ".join(scaled))
    if mixed:
        log("[index] 警告：%d 隻 sprite 的幀尺寸不一致（請檢查 export）：%s" % (len(mixed), ", ".join(mixed[:8])))
    return {"format": "dr-battle-assets/1", "sprites": sprites, "audio": {}, "fonts": {}}


# ---------------------------------------------------------------- presets

def build_presets(index, preset_cfg):
    if not PRESET_SRC.is_file():
        return None
    idx_sprites = index["sprites"]
    actors = {}
    display_names = {}
    missing = []
    for section, kind in (("party", "party"), ("enemies", "enemy")):
        for aid, a in (preset_cfg.get(section) or {}).items():
            anims = {}
            for state, spec in (a.get("anims") or {}).items():
                sprite = spec.get("sprite")
                if not sprite:
                    continue
                if sprite not in idx_sprites:
                    missing.append("%s.%s -> %s" % (aid, state, sprite))
                entry = {"sprite": sprite}
                entry["fps"] = spec.get("fps", 5)
                entry["loop"] = bool(spec.get("loop", state in ("idle", "victory", "spared")))
                if spec.get("then"):
                    entry["then"] = spec["then"]
                anims[state] = entry
            actor = {
                "kind": kind,
                "x": int(a.get("x", 500 if kind == "enemy" else 96)),
                "y": int(a.get("y", 270 if kind == "enemy" else 140)),
                "anims": anims,
            }
            actors[aid] = actor
            if a.get("name"):
                display_names[aid] = a["name"]
    # 站位建議（layouts.party3/party4/enemy1..3）：原樣轉出，partyN 的 slot 帶 id、
    # enemyN 的 slot 只有 x/y（依 enemies 順序套用）。底線開頭是註解欄位，跳過。
    layouts = {}
    for lname, slots in (preset_cfg.get("layouts") or {}).items():
        if lname.startswith("_"):
            continue
        norm = []
        for slot in slots or []:
            item = {"x": int(slot.get("x", 0)), "y": int(slot.get("y", 0))}
            if slot.get("id"):
                item = {"id": str(slot["id"]), "x": item["x"], "y": item["y"]}
            norm.append(item)
        layouts[lname] = norm
    out = {
        "format": "dr-battle-actor-presets/1",
        "source": "tools/sprites_full（UTMT data.win 匯出；sprite 名對應 assets/sprites-full.index.json）",
        "actors": actors,
    }
    if layouts:
        out["layouts"] = layouts
    if display_names:
        out["displayNames"] = display_names
    return out, missing


# ---------------------------------------------------------------- compare

def compare_phase1(index):
    if not PHASE1_INDEX.is_file():
        log("[compare] 沒有 assets/index.json，跳過 Phase 1 對照")
        return
    try:
        p1 = load_json(PHASE1_INDEX).get("sprites") or {}
    except Exception as exc:  # noqa: BLE001
        log("[compare] 讀不了 Phase 1 索引：%s" % exc)
        return
    mine = index["sprites"]
    both = [n for n in p1 if n in mine]
    frames_up = [n for n in both if len(mine[n]["frames"]) > len(p1[n].get("frames") or [])]
    frames_down = [n for n in both if len(mine[n]["frames"]) < len(p1[n].get("frames") or [])]
    origin_changed = [n for n in both
                      if (mine[n]["ox"], mine[n]["oy"]) != (p1[n].get("ox"), p1[n].get("oy"))]
    added = [n for n in mine if n not in p1]
    only_p1 = [n for n in p1 if n not in mine]
    log("")
    log("[compare] Phase 1 (assets/index.json) = %d sprites；本次 = %d sprites" % (len(p1), len(mine)))
    log("[compare] 同名 %d：新增幀 %d、幀數變少 %d、原點變更 %d" % (
        len(both), len(frames_up), len(frames_down), len(origin_changed)))
    log("[compare] 本次新增（Phase 1 沒有）%d；Phase 1 獨有 %d" % (len(added), len(only_p1)))
    if frames_up:
        ex = sorted(frames_up, key=lambda n: len(mine[n]["frames"]) - len(p1[n].get("frames") or []), reverse=True)[:8]
        log("[compare] 幀數增加最多：" + ", ".join(
            "%s %d→%d" % (n, len(p1[n].get("frames") or []), len(mine[n]["frames"])) for n in ex))
    if origin_changed:
        log("[compare] 原點變更（前 8）：" + ", ".join(
            "%s %s,%s→%d,%d" % (n, p1[n].get("ox"), p1[n].get("oy"), mine[n]["ox"], mine[n]["oy"])
            for n in sorted(origin_changed)[:8]))
    if only_p1:
        log("[compare] Phase 1 獨有（本次未選）前 12：" + ", ".join(sorted(only_p1)[:12]))


# ---------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description="A3 戰鬥 sprite 全幀補拆（UTMT → assets/sprites-full）")
    ap.add_argument("--chapters", default="", help="只處理這些章，如 ch1,ch2（預設全部）")
    ap.add_argument("--dry-run", action="store_true", help="只印選取統計，不寫檔、不呼叫 UTMT")
    ap.add_argument("--force-probe", action="store_true", help="重跑 data.win probe")
    ap.add_argument("--no-probe", action="store_true", help="不跑 probe（用現有 catalog）")
    ap.add_argument("--force-export", action="store_true", help="重新匯出所有選取 sprite")
    ap.add_argument("--no-export", action="store_true", help="不匯出（用現有 PNG 重建 index/presets）")
    args = ap.parse_args()

    if not CONFIG.is_file():
        die("缺少 %s" % CONFIG)
    cfg = load_json(CONFIG)
    chapters = list(cfg.get("chapters") or ["ch1", "ch2", "ch3", "ch4", "ch5"])
    if args.chapters:
        want = [c.strip() for c in args.chapters.split(",") if c.strip()]
        bad = [c for c in want if c not in chapters]
        if bad:
            die("--chapters 有不存在的章：%s" % ",".join(bad))
        chapters = want

    log("== A3 sprites-full ==")
    log("repo=%s" % REPO)
    log("chapters=%s" % ",".join(chapters))

    if not args.no_probe:
        ensure_probe(cfg, chapters, args.force_probe)

    cats = load_catalogs(chapters)
    for ch in chapters:
        log("[catalog] %s sprites=%d objects=%d" % (
            ch, len(cats[ch]["sprites"]), len(cats[ch]["objects"])))

    entries, stats = select_sprites(cfg, cats, chapters)
    log("")
    log("[select] %d sprites / %d frames" % (stats["sprites"], stats["frames"]))
    for rid in list(stats["per_rule"]):
        log("    %-18s %d" % (rid, stats["per_rule"][rid]))
    log("[select] 敵人：%d families（缺 %d：%s）" % (
        stats["families"], len(stats["family_missing"]), ",".join(stats["family_missing"][:8]) or "-"))
    log("[select] 來源章：" + ", ".join("%s=%d" % (k, stats["by_chapter"][k]) for k in sorted(stats["by_chapter"])))
    log("[select] tags：" + ", ".join("%s=%d" % (k, stats["by_tag"][k]) for k in TAG_ORDER if k in stats["by_tag"]))
    if stats["dropped"]:
        log("[select] 丟棄 %d 個（%s）" % (len(stats["dropped"]), stats["dropped"][:6]))
    if args.dry_run:
        log("[dry-run] 不寫檔")
        return

    # 匯出
    grouped = {}
    for name, e in entries.items():
        grouped.setdefault(e["src"], {})[name] = e
    export_stats = {}
    for ch in chapters:
        if ch not in grouped:
            continue
        if args.no_export:
            log("[export] %s 跳過（--no-export）" % ch)
            continue
        export_stats[ch] = export_chapter(ch, grouped[ch], cfg, args.force_export, False)
    removed = prune_stale(set(entries))
    if removed:
        log("[export] 清掉 %d 個不再選取的舊資料夾" % removed)

    # index
    index = build_index(entries, cfg)
    dump_json(INDEX_PATH, index)
    total_frames = sum(len(v["frames"]) for v in index["sprites"].values())
    log("")
    log("[index] %s：%d sprites / %d frames（%.1f KB）" % (
        INDEX_PATH.relative_to(REPO), len(index["sprites"]), total_frames,
        INDEX_PATH.stat().st_size / 1024.0))

    # presets
    if PRESET_SRC.is_file():
        preset_cfg = load_json(PRESET_SRC)
        built = build_presets(index, preset_cfg)
        if built is None:
            log("[presets] 沒有 config/actor_presets.json，跳過")
        else:
            presets, missing = built
            dump_json(PRESETS_PATH, presets)
            log("[presets] %s：%d actors（party %d / enemy %d）" % (
                PRESETS_PATH.relative_to(REPO), len(presets["actors"]),
                sum(1 for a in presets["actors"].values() if a["kind"] == "party"),
                sum(1 for a in presets["actors"].values() if a["kind"] == "enemy")))
            if missing:
                log("[presets] 警告：%d 個 anims 引用了不存在的 sprite（會 fallback）：%s" % (
                    len(missing), ", ".join(missing[:8])))
    else:
        log("[presets] 缺少 %s，跳過" % PRESET_SRC)

    compare_phase1(index)
    log("")
    log("[done] 可用 python tools/sprites_full/verify.py 驗證產出")


if __name__ == "__main__":
    main()
