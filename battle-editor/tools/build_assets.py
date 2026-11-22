#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_assets.py — 從已解包的官方素材建立 `battle-editor/assets/index.json` 與 PNG 複本。

輸出格式見 `docs/SPEC.md` §2（`dr-battle-assets/1`）：
    assets/index.json
    assets/sprites/<sprite 名>/<幀序號>.png

素材來源（皆為唯讀，不會修改）：
    1. <source-root>/sprites/<ch>/all_sprites/<name>.png     每個 sprite 的第 1 幀（同名多章取最新章）
    2. <source-root>/animations/<角色>/<動作>/<name>/frame_NNN.png   多幀動畫（優先使用）
    3. <source-root>/enemy-animations/enemies/<name>/frame_NNN.png  敵人動畫（最優先使用）
    4. <origins-json>（v0.4 director-sprites/1）取 origin_x/origin_y 作為 ox/oy

設計原則：
    * 只挑戰鬥相關 sprite，規則集中在 SELECT_RULES（可配置清單）。
    * 同名多章取最新章（ch1 → ch5 依序覆蓋）；但原點優先取「已驗證」的紀錄。
    * 可重複執行、冪等：內容相同的檔案不重寫，第二次執行應為 0 變更。
    * 僅用 Python 標準庫（PNG 尺寸直接解析 IHDR；不需要 Pillow）。

用法：
    python tools/build_assets.py                 # 擷取並寫入 battle-editor/assets/
    python tools/build_assets.py --dry-run       # 只印統計，不寫任何檔案
    python tools/build_assets.py --list-rules    # 印出選取規則
    python tools/build_assets.py --source <dir> --out <dir> --origins <sprites.json>

companion 索引：assets/sprites-full.index.json、assets/audio-fonts.index.json、
assets/custom.index.json。`--out` 指向別的目錄時，若新目錄缺這些檔，會自動回退讀
預設 assets/（sprites-full 兩邊都沒有則中止，除非加 --allow-missing-sprites-full）。
custom.index.json 的 sprite 與 audio 都會合併；自訂 BGM 的 loopStart/loopEnd/volume/tags
原樣保留（重建 index.json 不會弄丟自訂音樂或 loop 點）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import struct
import sys
from pathlib import Path

# ---------------------------------------------------------------------------
# 預設路徑（可用命令列覆寫）
# ---------------------------------------------------------------------------

BATTLE_EDITOR_DIR = Path(__file__).resolve().parent.parent
WORKSPACE_DIR = BATTLE_EDITOR_DIR.parent

DEFAULT_SOURCE_ROOT = WORKSPACE_DIR / "assets-official" / "01-official"
DEFAULT_ORIGINS_JSON = (
    WORKSPACE_DIR
    / "src"
    / "deltarune-director-v0.4"
    / "management"
    / "agents"
    / "A-assets"
    / "exports"
    / "v8"
    / "sprites.json"
)
DEFAULT_OUT_DIR = Path(os.environ["DR_ASSETS"]).resolve() if os.environ.get("DR_ASSETS") else BATTLE_EDITOR_DIR / "assets"

CHAPTERS = ["ch1", "ch2", "ch3", "ch4", "ch5"]

# A3（SPEC-P2 §7）補拆的全幀 + 真實原點素材：assets/sprites-full/<name>/<i>.png
# 與 assets/sprites-full.index.json（同 SPEC §2 格式，另帶 originVerified: true）。
# 存在時：同名 sprite 以它的 frames/ox/oy 覆蓋，它獨有的 sprite 直接加入索引。
SPRITES_FULL_INDEX = "sprites-full.index.json"
SPRITES_FULL_DIR = "sprites-full"

# A2 / A3 / 自訂素材的 companion 索引：--out 指向別的目錄時，缺檔要回退預設 assets/，
# 否則 --out 到空目錄會靜默丟掉 sprites-full 的 2476 筆（REALTEST §4-14）。
COMPANION_AUDIO_FONTS = "audio-fonts.index.json"
COMPANION_CUSTOM = "custom.index.json"

# 全部規則共用的排除樣式（正則，對 sprite 名稱做 search）
# ftex_*：房間貼圖切塊；IMAGE_*：雜項；mask/hitbox：輔助遮罩；_old/_whitebg：舊版與白底版；
# 結尾 4 位以上數字：匯出器產生的重複項（如 spr_battleblcon_book_enemy_highlight5391）
GLOBAL_EXCLUDE = [
    r"^ftex_",
    r"^IMAGE_",
    r"mask",
    r"hitbox",
    r"_old\d*$",
    r"_whitebg$",
    r"\d{4,}$",
    r"^spr_overworld_",
    r"^spr_plat_",
    r"^spr_board_",
]

# ---------------------------------------------------------------------------
# 選取規則（可配置清單）
#   id       規則識別名（僅供統計/除錯）
#   tags     命中的 sprite 會得到的 tags（多條規則的 tags 取聯集）
#   include  名稱正則清單（任一命中即可；省略 = 全命中）
#   exclude  名稱正則清單（任一命中即排除本規則）
#   sources  限制來源類型（{"all_sprites","animations","enemy-animations"}；省略 = 不限）
# 合法 tags：soul bullet battlebg enemy ui party（SPEC §2）
# ---------------------------------------------------------------------------
SELECT_RULES = [
    {
        "id": "soul",
        "tags": ["soul"],
        "include": [
            r"^spr_heart(?!enemy)",  # spr_heart / spr_heartsmall / spr_heartbullet / spr_heart_white …
            r"^spr_soul",            # spr_soulshining / spr_soul_titan_vfx
            r"^spr_spinheart",       # 旋轉愛心（spr_spinheartmask 由 GLOBAL_EXCLUDE 排除）
            r"^spr_dodgeheart",      # 閃避用愛心（含變體）
            r"^spr_btheart",         # 戰鬥 UI 愛心（spr_btheart_success1/2）
        ],
        "exclude": [r"^spr_heartenemy_", r"^spr_heartbreak$"],
    },
    {
        "id": "bullet",
        "tags": ["bullet"],
        "include": [r"bullet"],  # 幾乎所有子彈都叫 *bullet*
        "exclude": [r"_guideline$"],
    },
    {
        "id": "battlebg",
        "tags": ["battlebg"],
        "include": [r"^spr_battlebg", r"^spr_dojo_battlebg", r"^bg_battleback"],
    },
    {
        "id": "battle-ui",
        "tags": ["ui"],
        "include": [
            r"^spr_bt(?:fight|act|spare|defend|item)",  # 戰鬥按鈕（含 ja_ 以外的英文版）
            r"^spr_ja_bt",                              # 日文版戰鬥按鈕
            r"^spr_battleblcon",                        # 底線裝飾（battle bottom line connection）
            r"^spr_battlemsg",                          # 戰鬥訊息框
            r"^spr_battletarget",                       # 目標箭頭
            r"^spr_tplogo",                             # TP 標誌
            r"^spr_sparestar",                          # SPARE 星
            r"^spr_partytarget",
        ],
    },
    {
        "id": "portrait",
        # 對話頭像（SPEC-LAYOUT §7：say 的 portrait）。官方把角色大頭圖放在 spr_face_*：
        #   spr_face_s0..sD → Susie、spr_face_r_* → Ralsei、spr_face_n* → Noelle、
        #   spr_face_b* → Berdly；spr_head* 三張為隊伍狀態列小頭像。
        "tags": ["ui"],
        "include": [r"^spr_face_", r"^spr_head(?:kris|susie|ralsei)$"],
    },
    {
        "id": "party",
        "tags": ["party"],
        "include": [r"^spr_(?:kris|susie|ralsei|noelle)b_"],  # 戰鬥中角色圖（*b_ = battle）
    },
    {
        "id": "enemy",
        "tags": ["enemy"],
        "sources": ["enemy-animations"],
        "include": [r"."],
    },
]

# ---------------------------------------------------------------------------
# 小工具
# ---------------------------------------------------------------------------


def force_utf8_stdio():
    """Windows 主控台預設可能是 cp1252，本腳本輸出大量中文，統一改成 UTF-8。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass


def die(msg: str, code: int = 2):
    print(f"[錯誤] {msg}", file=sys.stderr)
    raise SystemExit(code)


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def png_size(path: Path) -> tuple[int, int]:
    """以標準庫解析 PNG 的 IHDR 取得寬高（不需 Pillow）。"""
    with open(path, "rb") as f:
        head = f.read(33)
    if len(head) < 33 or head[:8] != b"\x89PNG\r\n\x1a\n":
        die(f"不是合法 PNG：{path}")
    if head[12:16] != b"IHDR":
        die(f"PNG 缺少 IHDR：{path}")
    w, h = struct.unpack(">II", head[16:24])
    return int(w), int(h)


def rel(path: Path, base: Path) -> str:
    return path.resolve().relative_to(base.resolve()).as_posix()


def frame_sort_key(p: Path):
    m = re.search(r"(\d+)", p.stem)
    return (int(m.group(1)) if m else 0, p.name)


def collect_frames(dir_path: Path) -> list[Path]:
    if not dir_path.is_dir():
        return []
    return sorted(dir_path.glob("frame_*.png"), key=frame_sort_key)


# ---------------------------------------------------------------------------
# 掃描素材來源
# ---------------------------------------------------------------------------


def scan_candidates(source_root: Path) -> dict[str, dict]:
    """回傳 {sprite 名: {"sources": {kind: info}}}。

    info 依 kind 不同：
        all_sprites        {"chapter": "ch5", "path": Path}
        animations         {"frames": [Path, ...], "role": ..., "action": ...}
        enemy-animations   {"frames": [Path, ...]}
    """
    candidates: dict[str, dict] = {}

    # 1) sprites/<ch>/all_sprites — 每個 sprite 只有第 1 幀；後面的章節覆蓋前面的
    for chapter in CHAPTERS:
        d = source_root / "sprites" / chapter / "all_sprites"
        if not d.is_dir():
            continue
        for png in sorted(d.glob("*.png")):
            candidates.setdefault(png.stem, {"sources": {}})["sources"]["all_sprites"] = {
                "chapter": chapter,
                "path": png,
            }

    # 2) animations/<角色>/<動作>/<sprite>/frame_NNN.png — 多幀，優先於 all_sprites
    anim_root = source_root / "animations"
    if anim_root.is_dir():
        for role_dir in sorted(p for p in anim_root.iterdir() if p.is_dir()):
            for action_dir in sorted(p for p in role_dir.iterdir() if p.is_dir()):
                for sprite_dir in sorted(p for p in action_dir.iterdir() if p.is_dir()):
                    frames = collect_frames(sprite_dir)
                    if not frames:
                        continue
                    candidates.setdefault(sprite_dir.name, {"sources": {}})["sources"][
                        "animations"
                    ] = {
                        "frames": frames,
                        "role": role_dir.name,
                        "action": action_dir.name,
                    }

    # 3) enemy-animations/enemies/<sprite>/frame_NNN.png — 最優先
    enemy_root = source_root / "enemy-animations" / "enemies"
    if enemy_root.is_dir():
        for sprite_dir in sorted(p for p in enemy_root.iterdir() if p.is_dir()):
            frames = collect_frames(sprite_dir)
            if not frames:
                continue
            candidates.setdefault(sprite_dir.name, {"sources": {}})["sources"][
                "enemy-animations"
            ] = {"frames": frames}

    return candidates


# ---------------------------------------------------------------------------
# 原點（ox/oy）與章節
# ---------------------------------------------------------------------------


def load_origin_records(origins_json: Path) -> dict[str, list[dict]]:
    if not origins_json.is_file():
        print(f"[警告] 找不到原點資料 {origins_json}，所有 ox/oy 取 0", file=sys.stderr)
        return {}
    with open(origins_json, "r", encoding="utf-8") as f:
        data = json.load(f)
    if data.get("format") != "director-sprites/1":
        print(f"[警告] {origins_json} format={data.get('format')!r}，仍嘗試讀取", file=sys.stderr)
    by_name: dict[str, list[dict]] = {}
    for rec in data.get("sprites") or []:
        name = rec.get("name")
        if name:
            by_name.setdefault(name, []).append(rec)
    return by_name


def chapter_rank(chapter: str | None) -> int:
    try:
        return CHAPTERS.index(chapter or "")
    except ValueError:
        return -1


def pick_origin(recs: list[dict]) -> tuple[int, int, str | None]:
    """挑最新且已驗證的原點；否則最新章；皆無則 (0, 0, None)。"""
    if not recs:
        return 0, 0, None
    best = max(recs, key=lambda r: (1 if r.get("origin_verified") else 0, chapter_rank(r.get("chapter"))))
    return int(best.get("origin_x") or 0), int(best.get("origin_y") or 0), best.get("chapter")


def latest_matching_chapter(recs: list[dict], dims: tuple[int, int]) -> str | None:
    """回傳尺寸相符的紀錄中最新的章節（動畫來源無法得知實際章節時使用）。"""
    matched = [r for r in recs if (int(r.get("width") or 0), int(r.get("height") or 0)) == dims]
    if not matched:
        return None
    return max(matched, key=lambda r: chapter_rank(r.get("chapter"))).get("chapter")


# ---------------------------------------------------------------------------
# 選取
# ---------------------------------------------------------------------------


def match_rule(rule: dict, name: str, source_kinds: set[str]) -> bool:
    allowed_sources = rule.get("sources")
    if allowed_sources and not (set(allowed_sources) & source_kinds):
        return False
    includes = rule.get("include") or [r"."]
    if not any(re.search(pat, name) for pat in includes):
        return False
    for pat in rule.get("exclude") or []:
        if re.search(pat, name):
            return False
    return True


def select_sprites(candidates: dict[str, dict]) -> dict[str, dict]:
    """套用 SELECT_RULES，回傳 {name: {"tags": [...], "sources": {...}}}。"""
    selected: dict[str, dict] = {}
    for name in sorted(candidates):
        info = candidates[name]
        source_kinds = set(info["sources"])
        if any(re.search(pat, name) for pat in GLOBAL_EXCLUDE):
            continue
        tags: set[str] = set()
        matched = False
        for rule in SELECT_RULES:
            if match_rule(rule, name, source_kinds):
                tags.update(rule["tags"])
                matched = True
        if matched:
            selected[name] = {"tags": sorted(tags), "sources": info["sources"]}
    return selected


def choose_frame_source(sources: dict, records: list[dict]) -> tuple[str, list[Path], str]:
    """決定用哪個來源的幀。

    優先序：enemy-animations > animations > all_sprites，但**只採用尺寸與 v0.4 紀錄相符的來源**。
    原因：`animations/` 的部分資料夾是裁切版或另一版渲染（例：spr_heart 的動畫幀是 9×9，
    而 SPEC §7 要求 16×16；spr_battleblcon_guei 的動畫幀是 320×160，實際 sprite 只有 150×86）。
    `all_sprites` 的尺寸與 v0.4 `sprites.json` 全部相符，作為保底。

    回傳 (來源類型, 幀路徑清單, 備註)。
    """
    canonical_dims = {(int(r.get("width") or 0), int(r.get("height") or 0)) for r in records}
    canonical_dims.discard((0, 0))

    ordered: list[tuple[str, list[Path]]] = []
    if "enemy-animations" in sources:
        ordered.append(("enemy-animations", sources["enemy-animations"]["frames"]))
    if "animations" in sources:
        ordered.append(("animations", sources["animations"]["frames"]))
    if "all_sprites" in sources:
        ordered.append(("all_sprites", [sources["all_sprites"]["path"]]))

    if not ordered:
        return "none", [], "no-source"

    # 先找尺寸與 v0.4 紀錄相符者
    for kind, frames in ordered:
        if not frames:
            continue
        if not canonical_dims or png_size(frames[0]) in canonical_dims:
            note = "" if kind != "all_sprites" or len(ordered) == 1 else "fallback-dims"
            return kind, frames, note

    # 都不符：用第一順位（多幀優先），並在統計中標記
    kind, frames = ordered[0]
    return kind, frames, "dims-mismatch"


# ---------------------------------------------------------------------------
# 寫入（含冪等處理）
# ---------------------------------------------------------------------------


def read_manifest(out_dir: Path) -> dict:
    p = out_dir / ".build-assets.manifest.json"
    if not p.is_file():
        return {}
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def write_json_atomic(path: Path, data, indent: int = 2):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=indent) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def resolve_companion_dir(out_dir: Path, filename: str) -> Path:
    """回傳哪個目錄含有 companion 索引：先找 --out，缺了才回退預設 assets/。

    REALTEST §4-14：--out 指向空目錄時，若直接略過 companion 索引，
    sprites-full 的 2476 筆會靜默消失、264 筆 origin 變 0。
    """
    if (out_dir / filename).is_file():
        return out_dir
    if out_dir.resolve() != DEFAULT_OUT_DIR.resolve() and (DEFAULT_OUT_DIR / filename).is_file():
        return DEFAULT_OUT_DIR
    return out_dir


def merge_audio_fonts(out_dir: Path, index: dict, source_dir: Path | None = None) -> bool:
    """若 A2 已產出 audio-fonts.index.json，合併其 audio/fonts 進主索引。"""
    af = (source_dir or out_dir) / COMPANION_AUDIO_FONTS
    if not af.is_file():
        return False
    try:
        with open(af, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[警告] 讀取 {af} 失敗（{exc}），略過合併", file=sys.stderr)
        return False
    merged = False
    for key in ("audio", "fonts"):
        val = data.get(key)
        if isinstance(val, dict):
            index[key] = val
            merged = True
    return merged


def merge_custom_index(
    out_dir: Path, index: dict, stats: dict | None = None, source_dir: Path | None = None
) -> bool:
    """若 build_custom_assets.py 已產出 assets/custom.index.json，把自訂素材併進主索引。

    - 檔案不存在 → 回 False（完成後索引內容與原本完全相同）
    - 冪等：先移除主索引中所有 custom:true 的舊條目，再併入自訂索引的內容
    - 併入的每個條目都標記 custom:true，下次重建才認得出來並清掉
    - audio 區段同樣合併；loopStart/loopEnd/volume/tags 原樣保留，重建不會弄丟自訂 BGM 或 loop 點
    """
    path = (source_dir or out_dir) / COMPANION_CUSTOM
    if not path.is_file():
        return False
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[警告] 讀取 {path} 失敗（{exc}），略過合併", file=sys.stderr)
        return False
    if not isinstance(data, dict):
        print(f"[警告] {path} 格式不是物件，略過合併", file=sys.stderr)
        return False
    fmt = data.get("format")
    if fmt is not None and fmt != "dr-battle-assets/1":
        print(f"[警告] {path} 的 format 不是 dr-battle-assets/1（{fmt}），略過合併", file=sys.stderr)
        return False
    for section in ("sprites", "audio"):
        table = index.setdefault(section, {})
        if not isinstance(table, dict):
            continue
        # 冪等：先清掉上次合併留下的自訂條目（只刪 custom:true，不動 base 素材）。
        # 這次的分類是空的（例如自訂音效被刪光）也要清掉舊的。
        for key in [k for k, v in table.items() if isinstance(v, dict) and v.get("custom")]:
            del table[key]
        entries = data.get(section)
        if not isinstance(entries, dict):
            continue
        count = 0
        frames = 0
        loops = 0
        music = 0
        sfx = 0
        for name, entry in entries.items():
            if not isinstance(entry, dict):
                continue
            item = dict(entry)
            item["custom"] = True
            table[name] = item
            count += 1
            if section == "sprites" and isinstance(item.get("frames"), list):
                frames += len(item["frames"])
            elif section == "audio":
                if item.get("kind") == "music":
                    music += 1
                elif item.get("kind") == "sfx":
                    sfx += 1
                if any(
                    isinstance(item.get(key), (int, float)) and not isinstance(item.get(key), bool)
                    for key in ("loopStart", "loopEnd")
                ):
                    loops += 1
        if stats is not None:
            stats[f"custom_{section}"] = count
            if section == "sprites":
                stats["custom_frames"] = frames
            elif section == "audio":
                stats["custom_audio_music"] = music
                stats["custom_audio_sfx"] = sfx
                stats["custom_audio_loops"] = loops
    return True


def display_path(path: Path) -> str:
    """manifest 內只記相對路徑，避免把本機絕對路徑寫進版本庫。"""
    try:
        return path.resolve().relative_to(WORKSPACE_DIR.resolve()).as_posix()
    except ValueError:
        return path.name


def normalize_full_frame_path(raw: str) -> str | None:
    """把 sprites-full 索引裡的幀路徑正規化成「相對 assets/」的形式。

    容錯三種寫法：
        sprites-full/<name>/<i>.png    （SPEC-P2 §7 的正式寫法）
        assets/sprites-full/<name>/<i>.png
        <name>/<i>.png                 （相對 sprites-full/，A3 可能這樣寫）
    """
    if not isinstance(raw, str) or not raw.strip():
        return None
    p = raw.replace("\\", "/").strip()
    while p.startswith("./"):
        p = p[2:]
    if p.startswith("assets/"):
        p = p[len("assets/"):]
    if p.startswith(SPRITES_FULL_DIR + "/"):
        return p
    if p.startswith("/") or ".." in p.split("/") or ":" in p:
        return None
    return f"{SPRITES_FULL_DIR}/{p}"


def load_sprites_full(out_dir: Path) -> dict | None:
    """讀 A3 的 assets/sprites-full.index.json（若存在）。格式不符就回傳 None。"""
    p = out_dir / SPRITES_FULL_INDEX
    if not p.is_file():
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"[警告] 讀取 {p.name} 失敗（{exc}），略過合併", file=sys.stderr)
        return None
    if not isinstance(data, dict) or not isinstance(data.get("sprites"), dict):
        print(f"[警告] {p.name} 缺少 sprites 物件，略過合併", file=sys.stderr)
        return None
    fmt = data.get("format")
    if fmt is not None and fmt != "dr-battle-assets/1":
        print(f"[警告] {p.name} format={fmt!r}（預期 dr-battle-assets/1），仍嘗試合併", file=sys.stderr)
    return data


def merge_sprites_full(
    out_dir: Path,
    index: dict,
    manifest_sprites: dict,
    stats: dict,
    dry_run: bool,
    index_dir: Path | None = None,
    frame_root: Path | None = None,
) -> bool:
    """把 A3 的 sprites-full 合併進主索引（SPEC-P2 §7）。

    規則：
      * 同名 sprite：以 sprites-full 的 frames / ox / oy（必要時 w/h/chapter）覆蓋；
        tags 取聯集，`originVerified` 一併帶入。
      * sprites-full 獨有的 sprite：直接加入索引，幀路徑指向 sprites-full/…。
      * 任何一幀檔案不存在 → 該 sprite 整筆略過（索引只收真的載得到的檔），並計入警告。
      * 覆蓋後原本 assets/sprites/<name>/ 的複本會被移除（可由來源重新產生）。

    回傳是否真的做過合併。
    """
    index_dir = index_dir or out_dir
    frame_root = frame_root or out_dir
    data = load_sprites_full(index_dir)
    if data is None:
        return False

    src_sprites: dict = data["sprites"]
    allowed_tags = {"soul", "bullet", "battlebg", "enemy", "ui", "party"}
    overridden: list[str] = []
    added: list[str] = []
    skipped: list[str] = []
    frames_total = 0

    for name in sorted(src_sprites):
        entry = src_sprites[name]
        if not name or not isinstance(entry, dict):
            skipped.append(str(name))
            continue
        raw_frames = entry.get("frames")
        if not isinstance(raw_frames, list) or not raw_frames:
            skipped.append(name)
            continue
        frame_rels: list[str] = []
        ok = True
        for raw in raw_frames:
            norm = normalize_full_frame_path(raw)
            if norm is None or not (frame_root / norm).is_file():
                ok = False
                break
            frame_rels.append(norm)
        if not ok:
            skipped.append(name)
            continue

        w = entry.get("w")
        h = entry.get("h")
        ox = entry.get("ox")
        oy = entry.get("oy")
        if not isinstance(w, int) or not isinstance(h, int) or w <= 0 or h <= 0:
            # 索引沒給尺寸就從第一幀讀
            try:
                w, h = png_size(frame_root / frame_rels[0])
            except SystemExit:
                skipped.append(name)
                continue
        if not isinstance(ox, int):
            ox = 0
        if not isinstance(oy, int):
            oy = 0

        prev = index["sprites"].get(name)
        entry_out: dict = {
            "frames": frame_rels,
            "w": w,
            "h": h,
            "ox": ox,
            "oy": oy,
            "chapter": entry.get("chapter") or (prev or {}).get("chapter") or "unknown",
            "tags": [],
        }
        tags: set[str] = set()
        for src_tags in ((prev or {}).get("tags") or [], entry.get("tags") or []):
            if isinstance(src_tags, list):
                tags.update(t for t in src_tags if t in allowed_tags)
        entry_out["tags"] = sorted(tags)
        if entry.get("originVerified") is True:
            entry_out["originVerified"] = True

        if prev is None:
            added.append(name)
            stats["full_added"] = stats.get("full_added", 0) + 1
        else:
            overridden.append(name)
            stats["full_override"] = stats.get("full_override", 0) + 1
        index["sprites"][name] = entry_out
        manifest_sprites[name] = {"frames": len(frame_rels), "source": "sprites-full"}
        frames_total += len(frame_rels)
        stats["full_frames"] = stats.get("full_frames", 0) + len(frame_rels)
        if ox != 0 or oy != 0:
            stats["full_origin"] = stats.get("full_origin", 0) + 1

    # 被覆蓋的 sprite：刪掉 assets/sprites/<name>/ 的舊複本（避免兩份不同步）
    shadowed_removed = 0
    for name in overridden:
        stale_dir = out_dir / "sprites" / name
        if stale_dir.is_dir():
            shadowed_removed += 1
            if not dry_run:
                shutil.rmtree(stale_dir, ignore_errors=True)

    stats["full_skipped"] = skipped
    stats["full_shadowed_removed"] = shadowed_removed
    stats["sources"]["sprites-full"] = len(overridden) + len(added)

    # 合併後重新計算總數／tag 分布／位元組（覆蓋會換掉幀與 tag，新增會改變 sprite 數）
    stats["sprite"] = len(index["sprites"])
    stats["frames"] = sum(len(e.get("frames") or []) for e in index["sprites"].values())
    tag_counts: dict[str, int] = {}
    origin_verified_total = 0
    total_bytes = 0
    full_bytes = 0
    full_names = set(overridden) | set(added)
    for name, entry in index["sprites"].items():
        for tag in entry.get("tags") or []:
            tag_counts[tag] = tag_counts.get(tag, 0) + 1
        if entry.get("originVerified"):
            origin_verified_total += 1
        for rel_path in entry.get("frames") or []:
            frame_path = out_dir / rel_path
            if not frame_path.is_file() and frame_root != out_dir:
                frame_path = frame_root / rel_path
            try:
                size = frame_path.stat().st_size
            except OSError:
                size = 0
            total_bytes += size
            if name in full_names:
                full_bytes += size
    stats["tags"] = tag_counts
    stats["bytes"] = total_bytes
    stats["full_bytes"] = full_bytes
    stats["origin_verified_total"] = origin_verified_total

    print(
        f"      sprites-full：覆蓋 {len(overridden)} 個、新增 {len(added)} 個"
        f"（{frames_total} 幀，原點非零 {stats.get('full_origin', 0)} 個）"
    )
    if shadowed_removed:
        print(f"      移除被覆蓋的 sprites/ 舊複本：{shadowed_removed} 個目錄")
    if skipped:
        preview = ", ".join(skipped[:6])
        more = "…" if len(skipped) > 6 else ""
        print(f"      [警告] sprites-full 有 {len(skipped)} 個項目跳過（缺幀檔或格式不符）：{preview}{more}")
    return True


def build(
    source_root: Path,
    origins_json: Path,
    out_dir: Path,
    dry_run: bool,
    allow_missing_sprites_full: bool = False,
) -> dict:
    if not source_root.is_dir():
        die(f"找不到素材來源目錄：{source_root}")

    print(f"[1/6] 掃描素材：{source_root}")
    candidates = scan_candidates(source_root)
    print(f"      候選 sprite：{len(candidates)}")

    print("[2/6] 套用選取規則")
    selected = select_sprites(candidates)
    print(f"      選中 sprite：{len(selected)}")

    print("[3/6] 讀取原點資料")
    origin_records = load_origin_records(origins_json)
    print(f"      v0.4 sprite 紀錄：{sum(len(v) for v in origin_records.values())}")

    # companion 索引（A2/A3/custom）：--out 不是預設 assets/ 時，缺檔回退預設 assets/（§4-14）
    full_dir = resolve_companion_dir(out_dir, SPRITES_FULL_INDEX)
    audio_dir = resolve_companion_dir(out_dir, COMPANION_AUDIO_FONTS)
    custom_dir = resolve_companion_dir(out_dir, COMPANION_CUSTOM)
    for label, src_dir in (
        (SPRITES_FULL_INDEX, full_dir),
        (COMPANION_AUDIO_FONTS, audio_dir),
        (COMPANION_CUSTOM, custom_dir),
    ):
        if src_dir != out_dir:
            print(f"      companion {label} 從 {display_path(src_dir)} 讀取（--out 目錄沒有這個檔）")
    if not (full_dir / SPRITES_FULL_INDEX).is_file():
        if allow_missing_sprites_full:
            print("[警告] 找不到 sprites-full.index.json，依 --allow-missing-sprites-full 略過", file=sys.stderr)
        else:
            print("[錯誤] 找不到 sprites-full.index.json（--out 與預設 assets/ 都沒有）。", file=sys.stderr)
            print("        sprites-full 是 originVerified 與 2476 筆 sprite 幀的來源；缺少時索引會大幅縮水。", file=sys.stderr)
            print("        先產出 A3 的 sprites-full.index.json，或把 --out 指到已含該檔的 assets/；", file=sys.stderr)
            print("        確定要略過請加 --allow-missing-sprites-full。", file=sys.stderr)
            raise SystemExit(1)

    sprites_dir = out_dir / "sprites"
    previous = read_manifest(out_dir)
    prev_sprites: dict = previous.get("sprites") or {}

    index: dict = {"format": "dr-battle-assets/1", "sprites": {}, "audio": {}, "fonts": {}}
    manifest_sprites: dict = {}
    stats = {
        "sprite": 0,
        "frames": 0,
        "bytes": 0,
        "added": 0,
        "updated": 0,
        "unchanged": 0,
        "removed": 0,
        "sources": {},
        "tags": {},
        "origin_verified": 0,
        "origin_zero": 0,
        "dims_fallback": [],   # 動畫尺寸不符、退回 all_sprites 的名單
        "dims_problem": [],    # 找不到任何符合 v0.4 尺寸的來源（罕見）
        "skipped": [],         # 沒有任何來源可用
        "full_override": 0,    # sprites-full 覆蓋的同名 sprite 數
        "full_frames": 0,      # sprites-full 覆蓋後的幀數
        "full_origin": 0,      # sprites-full 覆蓋且原點非零
        "full_skipped": [],    # sprites-full 缺幀／格式不符而略過
        "full_shadowed_removed": 0,  # 被覆蓋而刪除的 sprites/ 舊目錄數
    }

    print("[4/6] 複製素材並建立索引")
    for name in sorted(selected):
        info = selected[name]
        recs = origin_records.get(name, [])
        kind, frames, source_note = choose_frame_source(info["sources"], recs)
        if not frames:
            stats["skipped"].append(name)
            continue
        width, height = png_size(frames[0])
        ox, oy, origin_chapter = pick_origin(recs)
        if (ox, oy) != (0, 0):
            stats["origin_verified"] += 1
        else:
            stats["origin_zero"] += 1
        if source_note == "fallback-dims":
            stats["dims_fallback"].append(name)
        elif source_note == "dims-mismatch":
            stats["dims_problem"].append(name)

        # 章節：all_sprites 用實際章節；動畫來源用「該尺寸」最新出現的章節（找不到則 unknown）
        if kind == "all_sprites":
            chapter = info["sources"]["all_sprites"]["chapter"]
        else:
            chapter = latest_matching_chapter(recs, (width, height)) or "unknown"

        frame_rels: list[str] = []
        sprite_bytes = 0

        target_dir = sprites_dir / name
        if not dry_run:
            target_dir.mkdir(parents=True, exist_ok=True)
            # 清掉本目錄中不再需要的舊幀
            expected_names = {f"{i}.png" for i in range(len(frames))}
            for existing in target_dir.glob("*.png"):
                if existing.name not in expected_names:
                    existing.unlink()

        for i, src in enumerate(frames):
            data = src.read_bytes()
            digest = sha256_bytes(data)
            sprite_bytes += len(data)
            rel_path = f"sprites/{name}/{i}.png"
            frame_rels.append(rel_path)
            if not dry_run:
                dst = out_dir / rel_path
                if dst.is_file() and dst.stat().st_size == len(data) and sha256_file(dst) == digest:
                    stats["unchanged"] += 1
                else:
                    if dst.is_file():
                        stats["updated"] += 1
                    else:
                        stats["added"] += 1
                    dst.write_bytes(data)
            else:
                stats["added"] += 1

        index["sprites"][name] = {
            "frames": frame_rels,
            "w": width,
            "h": height,
            "ox": ox,
            "oy": oy,
            "chapter": chapter,
            "tags": info["tags"],
        }
        manifest_sprites[name] = {"frames": len(frames), "source": kind}
        stats["sprite"] += 1
        stats["frames"] += len(frames)
        stats["bytes"] += sprite_bytes
        stats["sources"][kind] = stats["sources"].get(kind, 0) + 1
        for tag in info["tags"]:
            stats["tags"][tag] = stats["tags"].get(tag, 0) + 1

    # 移除舊版殘留的 sprite 目錄（只動自己 manifest 記錄過的）
    for stale in sorted(set(prev_sprites) - set(manifest_sprites)):
        stale_dir = sprites_dir / stale
        if stale_dir.is_dir():
            if dry_run:
                print(f"      [dry-run] 將移除 {rel(stale_dir, out_dir)}")
            else:
                shutil.rmtree(stale_dir)
                stats["removed"] += 1

    print("[5/6] 合併 A3 sprites-full（若存在）")
    merged_full = merge_sprites_full(
        out_dir, index, manifest_sprites, stats, dry_run, index_dir=full_dir, frame_root=full_dir
    )
    if not merged_full:
        print("      （無 sprites-full.index.json，維持原狀——已由 --allow-missing-sprites-full 明確允許）")

    # dry-run 也要做合併統計（只是不寫檔），否則 --dry-run 的數字會少掉這些條目。
    merged_audio = merge_audio_fonts(out_dir, index, source_dir=audio_dir)

    # 自訂素材（assets/custom/）：build_custom_assets.py 產出 custom.index.json
    # 後，重建 assets/index.json 時自動併回來（冪等）。
    merged_custom = merge_custom_index(out_dir, index, stats, source_dir=custom_dir)

    print("[6/6] 寫入 assets/index.json")
    if not dry_run:
        out_dir.mkdir(parents=True, exist_ok=True)
        write_json_atomic(out_dir / "index.json", index)
        write_json_atomic(
            out_dir / ".build-assets.manifest.json",
            {
                "format": "dr-battle-assets-manifest/1",
                "generatedBy": "tools/build_assets.py",
                "sourceRoot": display_path(source_root),
                "sprites": manifest_sprites,
            },
        )

    # ---------------------------------------------------------------- 統計
    print()
    print("=" * 68)
    print("素材統計")
    print("=" * 68)
    print(f"  sprite 數      : {stats['sprite']}")
    print(f"  PNG 幀數       : {stats['frames']}")
    print(f"  素材總位元組   : {stats['bytes']:,} ({stats['bytes'] / 1048576:.2f} MB)")
    print(f"  寫入 新增/更新/不變 : {stats['added']} / {stats['updated']} / {stats['unchanged']}")
    print(f"  移除過期 sprite 目錄: {stats['removed']}")
    print("  來源分布       : " + ", ".join(f"{k}={v}" for k, v in sorted(stats["sources"].items())))
    print("  tag 分布       : " + ", ".join(f"{k}={v}" for k, v in sorted(stats["tags"].items())))
    print(f"  ox/oy 非零 sprite: {stats['origin_verified']}（其餘 {stats['origin_zero']} 筆未驗證取 0）")
    if merged_full:
        print(
            f"  sprites-full 帶 originVerified 標記: {stats.get('origin_verified_total', 0)} 個"
            f"（{stats.get('full_bytes', 0):,} bytes）"
        )
    if stats["dims_fallback"]:
        preview = ", ".join(stats["dims_fallback"][:6])
        more = "…" if len(stats["dims_fallback"]) > 6 else ""
        print(f"  動畫尺寸不符、退回 all_sprites: {len(stats['dims_fallback'])} 個（{preview}{more}）")
    if stats["dims_problem"]:
        print(f"  [警告] 無任何來源符合 v0.4 尺寸: {len(stats['dims_problem'])} 個 → {', '.join(stats['dims_problem'][:8])}")
    if stats["skipped"]:
        print(f"  [警告] 無可用來源而略過: {len(stats['skipped'])} 個 → {', '.join(stats['skipped'][:8])}")

    if merged_audio:
        print(f"  已合併 {display_path(audio_dir / COMPANION_AUDIO_FONTS)} 的 audio/fonts")
    else:
        print(f"  （無 {COMPANION_AUDIO_FONTS}，audio/fonts 保持空物件）")

    if merged_custom:
        audio_note = ""
        if stats.get("custom_audio", 0):
            audio_note = (
                f"（music {stats.get('custom_audio_music', 0)} / sfx {stats.get('custom_audio_sfx', 0)}，"
                f"loop 點 {stats.get('custom_audio_loops', 0)} 個）"
            )
        print(
            f"  已合併 {display_path(custom_dir / COMPANION_CUSTOM)} 的自訂素材："
            f"sprite {stats.get('custom_sprites', 0)} 個（{stats.get('custom_frames', 0)} 幀） / "
            f"音訊 {stats.get('custom_audio', 0)} 個{audio_note}"
        )

    if merged_full:
        print(
            f"  sprites-full 合併: 覆蓋 {stats.get('full_override', 0)} 個 / "
            f"新增 {stats.get('full_added', 0)} 個（{stats.get('full_frames', 0)} 幀；"
            f"原點非零 {stats.get('full_origin', 0)} 個），移除舊複本 {stats.get('full_shadowed_removed', 0)} 個目錄"
        )
        if stats.get("full_skipped"):
            print(f"  [警告] sprites-full 略過: {len(stats['full_skipped'])} 個")
    elif not (full_dir / SPRITES_FULL_INDEX).is_file():
        print("  sprites-full: 未提供（--allow-missing-sprites-full；索引可能缺少 originVerified 素材）")

    required = ["spr_heart", "spr_spadebullet", "spr_battlebg_0", "spr_btheart", "spr_btfight"]
    print()
    print("關鍵素材檢查：")
    ok = True
    for name in required:
        entry = index["sprites"].get(name)
        if entry is None:
            print(f"  [缺失] {name}")
            ok = False
        else:
            print(
                f"  [OK] {name}: {len(entry['frames'])} 幀, {entry['w']}x{entry['h']}, "
                f"ox={entry['ox']} oy={entry['oy']}, chapter={entry['chapter']}, tags={entry['tags']}"
            )
    if not ok:
        print("\n[錯誤] 關鍵素材缺失！", file=sys.stderr)
        raise SystemExit(1)
    print()
    print(f"完成：{out_dir / 'index.json'}" + ("（dry-run，未寫入）" if dry_run else ""))
    return stats


# ---------------------------------------------------------------------------
# 命令列
# ---------------------------------------------------------------------------


def main(argv: list[str] | None = None) -> int:
    force_utf8_stdio()
    parser = argparse.ArgumentParser(
        description="從官方解包素材建立 battle-editor/assets/index.json（SPEC §2）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("--source", type=Path, default=DEFAULT_SOURCE_ROOT, help="官方素材根目錄")
    parser.add_argument("--origins", type=Path, default=DEFAULT_ORIGINS_JSON, help="v0.4 sprites.json")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT_DIR, help="輸出 assets/ 目錄")
    parser.add_argument("--dry-run", action="store_true", help="只統計（含 companion 索引合併），不寫入任何檔案")
    parser.add_argument(
        "--allow-missing-sprites-full",
        action="store_true",
        help="找不到 sprites-full.index.json 時仍繼續（預設中止，避免靜默遺失素材）",
    )
    parser.add_argument("--list-rules", action="store_true", help="印出選取規則後結束")
    args = parser.parse_args(argv)

    if args.list_rules:
        print("全域排除樣式：")
        for pat in GLOBAL_EXCLUDE:
            print(f"  - {pat}")
        print("\n選取規則：")
        for rule in SELECT_RULES:
            print(f"  [{rule['id']}] tags={rule['tags']} sources={rule.get('sources') or '全部'}")
            for pat in rule.get("include") or ["."]:
                print(f"      include: {pat}")
            for pat in rule.get("exclude") or []:
                print(f"      exclude: {pat}")
        return 0

    build(args.source, args.origins, args.out, args.dry_run, args.allow_missing_sprites_full)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
