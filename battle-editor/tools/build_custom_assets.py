#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""build_custom_assets.py — 掃描 assets/custom/ 的自訂 PNG 與音訊，產出 assets/custom.index.json。

用途：不碰官方解包素材，也能替戰鬥加上自己的子彈圖、敵人圖、背景圖、BGM 與音效。
輸出格式 `dr-battle-assets/1`，由 `tools/build_assets.py` 的 `merge_custom_index()` 併進
`assets/index.json`（冪等：重跑不會累積孤兒條目，刪掉檔案後重跑也會清掉）。

管線（見 docs/CUSTOM-ASSETS.md）：
  1. 放 PNG（sprite）：
     * 單張圖：assets/custom/foo.png          → sprite 名稱 foo
     * 動畫：  assets/custom/foo/0.png, 1.png… → sprite 名稱 foo，依檔名數字排序
  2. 放音訊（檔名不含副檔名 = 索引名稱；資料夾決定 kind）：
     * assets/custom/music/*.ogg|.mp3|.wav  → kind "music"（預設整首循環）
     * assets/custom/sfx/*.ogg|.mp3|.wav    → kind "sfx"（預設不循環）
  3. 選用 metadata（都可省略）：
     * assets/custom/sprites.json → sprite 的 frames/ox/oy/tags/desc…
     * assets/custom/audio.json   → 音訊的 loopStart/loopEnd（秒）/volume/tags/desc/loop/kind/file
  4. python tools/build_custom_assets.py      → assets/custom.index.json（sprites + audio）
  5. python tools/build_assets.py             → 重建 assets/index.json 時自動併入

原點（origin）規則：引擎 `engine/render.js` 的 `drawSprite` 在 ox/oy 皆 0 時使用圖片中心。
本腳本預設把 ox/oy 寫成圖片中心（w//2, h//2）；尺寸是奇數、或想讓原點偏移時，可在
`assets/custom/sprites.json` 指定（路徑相對於 assets/custom/）：

  {
    "format": "dr-battle-assets/1",
    "sprites": {
      "my_bullet":  { "files": ["my_bullet.png"], "ox": 10, "oy": 10, "desc": "自製子彈" },
      "my_anim":    { "frames": ["my_anim/0.png", "my_anim/1.png"], "ox": 8, "oy": 8,
                      "frameMs": [100, 100], "tags": ["bullet"] },
      "my_enemy":   { "files": ["my_enemy.png"], "tags": ["enemy"] }
    }
  }

  * `frames`（別名 `files`）：覆寫這個 sprite 的幀清單與順序；沒列在 sprites.json 的 PNG
    仍會自動編入。
  * `ox` / `oy`：原點（整數，可負；預設圖片中心）。
  * `tags`：sprite 預設 `["bullet"]`；已知 tag：soul / bullet / battlebg / enemy / ui / party。
    未知 tag 只會提醒，仍照樣寫入索引（素材搜尋可用）。
  * 其他會原樣帶進索引：`desc`、`frameMs`、`originVerified`；`chapter` 預設 "custom"。

音訊 metadata（`assets/custom/audio.json`，可省略）：

  {
    "format": "dr-battle-assets/1",
    "audio": {
      "persistent_motif": {
        "loopStart": 12.054, "loopEnd": 144.054, "volume": 0.8,
        "tags": ["battle", "custom"], "desc": "前奏一次，之後 12.054–144.054 秒循環"
      },
      "hit": { "volume": 0.7, "tags": ["impact"] }
    }
  }

  * 索引名稱 = 音檔檔名（不含副檔名）。
  * `loopStart` / `loopEnd`：秒，只對 BGM 有效（engine/audio.js 的 playBgm()）；前奏播一次，
    之後在 [loopStart, loopEnd) 循環。省略 = 整首循環。loopEnd 不可大於音檔長度，否則
    引擎會退回整首循環。
  * `loop`：布林，music 預設 true、sfx 預設 false。
  * `volume`：0..1（引擎會 clamp），省略 = 1。
  * `tags`：自由填；music 預設 ["music"]、sfx 預設 ["sfx"]。未知 tag 只提醒，仍寫入索引。
  * `kind`：可覆寫 "music" / "sfx"；`file`：可用不同名稱引用既有音檔（路徑相對於
    assets/custom/，例如 "music/boss.ogg"），但 auto-scan 到的同名檔案不可再用 file。
  * `desc`：原樣帶進索引。

輸出條目與 assets/index.json 既有 audio 條目一致：

  "persistent_motif": {
    "file": "custom/music/persistent_motif.ogg", "kind": "music", "loop": true,
    "loopStart": 12.054, "loopEnd": 144.054, "volume": 0.8,
    "tags": ["music"], "desc": "…", "bytes": 1234567, "custom": true
  }

用法：
  python tools/build_custom_assets.py                  # assets/custom → assets/custom.index.json
  python tools/build_custom_assets.py --dry-run        # 只印統計，不寫檔
  python tools/build_custom_assets.py --root <assets>  # 換 assets 根目錄（測試用，不碰 repo）
  python tools/build_custom_assets.py --audio <path>   # 換 audio.json 路徑
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import os
import sys
from pathlib import Path

BATTLE_EDITOR = Path(__file__).resolve().parent.parent
DEFAULT_ROOT = Path(os.environ["DR_ASSETS"]).resolve() if os.environ.get("DR_ASSETS") else BATTLE_EDITOR / "assets"
FORMAT = "dr-battle-assets/1"
DEFAULT_CHAPTER = "custom"
DEFAULT_TAGS = ["bullet"]
KNOWN_TAGS = {"soul", "bullet", "battlebg", "enemy", "ui", "party"}

# ---------------------------------------------------------------- 音訊
# 掃描 <source>/music/ 與 <source>/sfx/ 底下的音檔（遞迴）。副檔名一律轉小寫比對。
AUDIO_EXTS = {".ogg", ".mp3", ".wav"}
AUDIO_KINDS = ("music", "sfx")
DEFAULT_AUDIO_TAGS = {"music": ["music"], "sfx": ["sfx"]}
# 「已知」音訊 tag 只是提示用：未知 tag 仍會寫進索引（素材搜尋可用），不算錯誤。
KNOWN_AUDIO_TAGS = {
    "music",
    "sfx",
    "audio",
    "battle",
    "boss",
    "tense",
    "defeat",
    "alt",
    "voice",
    "ui",
    "ambient",
    "custom",
}
# audio.json 裡每個條目允許的欄位（其他欄位只提醒、忽略）。
AUDIO_ENTRY_KEYS = {"file", "kind", "loop", "loopStart", "loopEnd", "volume", "tags", "desc"}
# 扁平寫法（audio.json 最外層直接就是音訊表）時要排除的保留鍵。
AUDIO_RESERVED_KEYS = {"format", "sprites", "audio"}


def fail(message: str, code: int = 1) -> None:
    print(f"[錯誤] {message}", file=sys.stderr)
    raise SystemExit(code)


def png_size(path: Path) -> tuple[int, int]:
    """只讀 PNG 檔頭（IHDR）拿尺寸，不需要 Pillow。"""
    try:
        with open(path, "rb") as fh:
            head = fh.read(24)
    except OSError as exc:
        raise ValueError(f"讀取失敗（{exc}）")
    if len(head) < 24 or head[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("不是有效的 PNG 檔")
    if head[12:16] != b"IHDR":
        raise ValueError("PNG 缺少 IHDR")
    width, height = struct.unpack(">II", head[16:24])
    if width <= 0 or height <= 0:
        raise ValueError(f"尺寸不合法（{width}x{height}）")
    return width, height


def natural_key(text: str):
    """讓 2.png 排在 10.png 前面。"""
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", text)]


def display(path: Path) -> str:
    try:
        return path.resolve().relative_to(BATTLE_EDITOR.resolve()).as_posix()
    except ValueError:
        return str(path)


def is_number(value) -> bool:
    """bool 在 Python 是 int 的子類，這裡要排除。"""
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def index_rel(path: Path, root: Path) -> str | None:
    """回傳相對 assets/ 的 posix 路徑；不在 root 之下回 None。"""
    try:
        return path.resolve().relative_to(root.resolve()).as_posix()
    except ValueError:
        return None


# ---------------------------------------------------------------- sprites


def load_overrides(path: Path, warnings: list[str]) -> dict:
    """讀 assets/custom/sprites.json（可省略）。回傳 {sprite 名稱: 覆寫物件}。"""
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"讀取 {display(path)} 失敗：{exc}")
    if not isinstance(data, dict):
        fail(f"{display(path)} 的最外層必須是物件")
    table = data.get("sprites")
    if isinstance(table, dict):
        fmt = data.get("format")
        if fmt is not None and fmt != FORMAT:
            warnings.append(f"{display(path)} 的 format={fmt!r}（預期 {FORMAT}），仍嘗試讀取")
    else:
        # 也接受「最外層直接就是 sprite 表」的寫法（排除 format 這類保留鍵）
        table = {key: value for key, value in data.items() if key not in ("format", "audio", "sprites")}
    for name, value in table.items():
        if not isinstance(value, dict):
            fail(f"{display(path)} 的 {name!r} 必須是物件（frames/files/ox/oy/tags…）")
        if not name or "/" in name or "\\" in name:
            fail(f"{display(path)} 的 sprite 名稱 {name!r} 不合法（不可含斜線）")
    return table


def scan_pngs(source: Path) -> list[tuple[str, Path]]:
    found: list[tuple[str, Path]] = []
    for path in sorted(source.rglob("*.png"), key=lambda p: natural_key(p.relative_to(source).as_posix())):
        if path.is_file():
            found.append((path.relative_to(source).as_posix(), path))
    return found


def build_entries(
    found: list[tuple[str, Path]],
    overrides: dict,
    root: Path,
    source: Path,
    warnings: list[str],
) -> tuple[dict, list[str], int, int]:
    """回傳 (sprites, errors, 中心原點數, sprites.json 指定原點數)。"""
    errors: list[str] = []
    root_resolved = root.resolve()

    # 自動分組：頂層資料夾 = 動畫 sprite；頂層單張 PNG = 單幀 sprite
    groups: dict[str, list[Path]] = {}
    mixed: set[str] = set()
    for rel, path in found:
        parts = rel.split("/")
        name = parts[0] if len(parts) > 1 else Path(rel).stem
        if name in groups and (len(parts) == 1) != (len(groups[name][0].relative_to(source).as_posix().split("/")) == 1):
            mixed.add(name)
        groups.setdefault(name, []).append(path)
    for name in sorted(mixed):
        warnings.append(f"{name}: 同時有單張 PNG 與同名資料夾，幀會混在一起（建議只用一種）")

    names = sorted(set(groups) | set(overrides), key=natural_key)
    sprites: dict = {}
    used_frames: dict[str, str] = {}
    center_count = 0
    explicit_count = 0

    for name in names:
        override = overrides.get(name) or {}
        rels = override.get("frames", override.get("files"))
        if rels is None:
            rels = [path.relative_to(source).as_posix() for path in groups.get(name, [])]
        if isinstance(rels, str):
            rels = [rels]
        if not isinstance(rels, list) or not rels:
            errors.append(f"{name}: 沒有任何幀（找不到 PNG 或 sprites.json 的 frames 為空）")
            continue

        frame_paths: list[Path] = []
        frame_rels: list[str] = []
        for raw in rels:
            if not isinstance(raw, str) or not raw.strip():
                errors.append(f"{name}: 幀路徑必須是非空字串（收到 {raw!r}）")
                continue
            rel = raw.replace("\\", "/")
            path = (source / rel).resolve()
            if not path.is_file():
                errors.append(f"{name}: 找不到 PNG「{rel}」（相對於 {display(source)}）")
                continue
            if path.suffix.lower() != ".png":
                errors.append(f"{name}: 「{rel}」不是 .png")
                continue
            rel_index = index_rel(path, root)
            if rel_index is None:
                errors.append(f"{name}: 「{rel}」不在 {display(root)} 之下；索引裡的幀路徑必須能相對於 assets/")
                continue
            if rel_index in used_frames and used_frames[rel_index] != name:
                warnings.append(f"{name}: 幀「{rel_index}」也用在 {used_frames[rel_index]}")
            used_frames[rel_index] = name
            frame_paths.append(path)
            frame_rels.append(rel_index)

        if not frame_paths or len(frame_paths) != len(frame_rels):
            continue

        sizes: list[tuple[int, int]] = []
        for path in frame_paths:
            try:
                sizes.append(png_size(path))
            except ValueError as exc:
                errors.append(f"{name}: {path.name} {exc}")
        if len(sizes) != len(frame_paths):
            continue
        if len(set(sizes)) > 1:
            detail = ", ".join(f"{path.name} {w}x{h}" for path, (w, h) in zip(frame_paths, sizes))
            errors.append(f"{name}: 各幀尺寸不一致（{detail}）；動畫每幀必須同尺寸")
            continue

        width, height = sizes[0]
        ox_default, oy_default = width // 2, height // 2
        ox = override.get("ox", ox_default)
        oy = override.get("oy", oy_default)
        if isinstance(ox, bool) or isinstance(oy, bool) or not isinstance(ox, int) or not isinstance(oy, int):
            errors.append(f"{name}: ox/oy 必須是整數")
            continue
        if ox == ox_default and oy == oy_default and "ox" not in override and "oy" not in override:
            center_count += 1
        else:
            explicit_count += 1

        tags = override.get("tags", list(DEFAULT_TAGS))
        if isinstance(tags, str):
            tags = [tags]
        if not isinstance(tags, list) or not all(isinstance(tag, str) for tag in tags):
            errors.append(f"{name}: tags 必須是字串或字串陣列")
            continue
        unknown = sorted(tag for tag in tags if tag not in KNOWN_TAGS)
        if unknown:
            warnings.append(
                f"{name}: 未知 tag {unknown}（仍會照樣寫入索引；已知 tag：{sorted(KNOWN_TAGS)}）"
            )

        entry = {
            "frames": frame_rels,
            "w": width,
            "h": height,
            "ox": ox,
            "oy": oy,
            "chapter": str(override.get("chapter") or DEFAULT_CHAPTER),
            "tags": tags,
            "custom": True,
        }
        for key in ("desc", "frameMs", "originVerified"):
            if key in override:
                entry[key] = override[key]
        sprites[name] = entry

    return sprites, errors, center_count, explicit_count


# ---------------------------------------------------------------- audio


def load_audio_overrides(path: Path, warnings: list[str]) -> dict:
    """讀 assets/custom/audio.json（可省略）。回傳 {音訊索引名: 覆寫物件}。"""
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        fail(f"讀取 {display(path)} 失敗：{exc}")
    if not isinstance(data, dict):
        fail(f"{display(path)} 的最外層必須是物件")
    table = data.get("audio")
    if "audio" in data and not isinstance(table, dict):
        fail(f"{display(path)} 的 audio 必須是物件（{{音訊名: {{loopStart…}}}}）")
    if isinstance(table, dict):
        fmt = data.get("format")
        if fmt is not None and fmt != FORMAT:
            warnings.append(f"{display(path)} 的 format={fmt!r}（預期 {FORMAT}），仍嘗試讀取")
    else:
        # 也接受「最外層直接就是音訊表」的寫法（排除 format 這類保留鍵）
        table = {key: value for key, value in data.items() if key not in AUDIO_RESERVED_KEYS}
    for name, value in table.items():
        if not isinstance(value, dict):
            fail(f"{display(path)} 的 {name!r} 必須是物件（loopStart/loopEnd/volume/tags/desc…）")
        if not name or "/" in name or "\\" in name:
            fail(f"{display(path)} 的音訊名稱 {name!r} 不合法（不可含斜線）")
    return table


def scan_audio(source: Path, root: Path, warnings: list[str]) -> tuple[dict, list[str]]:
    """掃描 <source>/music、<source>/sfx。回傳 ({名稱: [候選…]}, errors)。"""
    errors: list[str] = []
    found: dict[str, list[dict]] = {}
    for kind in AUDIO_KINDS:
        folder = source / kind
        if not folder.is_dir():
            continue
        files = sorted(folder.rglob("*"), key=lambda p: natural_key(p.relative_to(folder).as_posix()))
        for path in files:
            if not path.is_file() or path.name.startswith("."):
                continue
            if path.suffix.lower() not in AUDIO_EXTS:
                warnings.append(
                    f"{display(path)}：不支援的音訊格式「{path.suffix}」"
                    f"（只支援 .ogg/.mp3/.wav），已忽略"
                )
                continue
            rel = index_rel(path, root)
            if rel is None:
                errors.append(f"{display(path)}：不在 {display(root)} 之下；索引路徑必須能相對於 assets/")
                continue
            name = path.stem
            if not name:
                errors.append(f"{display(path)}：檔名不合法")
                continue
            found.setdefault(name, []).append({"path": path, "rel": rel, "kind": kind})
    return found, errors


def resolve_audio_path(raw, source: Path, root: Path) -> tuple[Path, str] | str:
    """audio.json 的 file → (實際路徑, 相對 assets/ 的索引路徑)。失敗回錯誤字串。"""
    if not isinstance(raw, str) or not raw.strip():
        return "file 必須是非空字串"
    text = raw.replace("\\", "/").strip()
    while text.startswith("./"):
        text = text[2:]
    candidates = []
    if text.startswith("custom/"):
        candidates.append(root / text)
    candidates.append(source / text)
    if not text.startswith("custom/"):
        candidates.append(root / text)
    for cand in candidates:
        if cand.is_file():
            rel = index_rel(cand, root)
            if rel is None:
                return f"「{raw}」不在 {display(root)} 之下；索引路徑必須能相對於 assets/"
            return cand.resolve(), rel
    return f"找不到音檔「{raw}」（相對於 {display(source)}；索引路徑要相對於 assets/）"


def _audio_kind_from_rel(rel: str) -> str | None:
    """從索引路徑猜 kind：custom/music/… → music、custom/sfx/… → sfx。"""
    parts = rel.split("/")
    if "music" in parts:
        return "music"
    if "sfx" in parts:
        return "sfx"
    return None


def build_audio_entries(
    found: dict,
    overrides: dict,
    root: Path,
    source: Path,
    warnings: list[str],
) -> tuple[dict, list[str], dict]:
    """回傳 (audio, errors, stats)。stats: music/sfx 數量、loop 點數、總 bytes。"""
    errors: list[str] = []
    audio: dict = {}
    stats = {"music": 0, "sfx": 0, "loop": 0, "bytes": 0}
    names = sorted(set(found) | set(overrides), key=natural_key)

    for name in names:
        override = overrides.get(name) or {}
        unknown_keys = sorted(set(override) - AUDIO_ENTRY_KEYS)
        if unknown_keys:
            warnings.append(f"{name}: audio.json 有未知欄位 {unknown_keys}（已忽略）")

        candidates = found.get(name) or []
        raw_file = override.get("file")
        path: Path | None = None
        rel: str | None = None
        kind: str | None = None

        if raw_file is not None:
            if candidates:
                errors.append(
                    f"{name}: 同名音檔已自動掃到（{candidates[0]['rel']}），audio.json 不要再指定 file；"
                    f"要改名請用一個新的索引名稱"
                )
                continue
            resolved = resolve_audio_path(raw_file, source, root)
            if isinstance(resolved, str):
                errors.append(f"{name}: {resolved}")
                continue
            path, rel = resolved
            if path.suffix.lower() not in AUDIO_EXTS:
                errors.append(f"{name}: 「{raw_file}」不是支援的音訊格式（只支援 .ogg/.mp3/.wav）")
                continue
            kind = override.get("kind")
            if kind is None:
                kind = _audio_kind_from_rel(rel)
            if kind not in AUDIO_KINDS:
                errors.append(
                    f"{name}: 無法從路徑「{rel}」判定 kind；請在 audio.json 指定 "
                    f'"kind": "music" 或 "sfx"'
                )
                continue
        else:
            if not candidates:
                errors.append(
                    f"{name}: 找不到音檔——請把檔案放進 {display(source)}/music 或 sfx，"
                    f"或在 audio.json 用 file 指定"
                )
                continue
            if len(candidates) > 1:
                where = ", ".join(item["rel"] for item in candidates)
                errors.append(f"{name}: 名稱重複（{where}）；同一索引名稱只能有一個音檔，請改名")
                continue
            item = candidates[0]
            path, rel, kind = item["path"], item["rel"], item["kind"]

        kind_override = override.get("kind")
        if kind_override is not None:
            if kind_override not in AUDIO_KINDS:
                errors.append(f"{name}: kind 必須是 \"music\" 或 \"sfx\"（收到 {kind_override!r}）")
                continue
            kind = kind_override

        tags = override.get("tags", list(DEFAULT_AUDIO_TAGS[kind]))
        if isinstance(tags, str):
            tags = [tags]
        if not isinstance(tags, list) or not all(isinstance(tag, str) and tag for tag in tags):
            errors.append(f"{name}: tags 必須是非空字串或字串陣列")
            continue
        unknown_tags = sorted(tag for tag in tags if tag not in KNOWN_AUDIO_TAGS)
        if unknown_tags:
            warnings.append(
                f"{name}: 未知音訊 tag {unknown_tags}（仍會照樣寫入索引；"
                f"已知 tag：{sorted(KNOWN_AUDIO_TAGS)}）"
            )

        loop = override.get("loop", kind == "music")
        if not isinstance(loop, bool):
            errors.append(f"{name}: loop 必須是 true 或 false")
            continue

        loop_start = override.get("loopStart")
        loop_end = override.get("loopEnd")
        if loop_start is not None and (not is_number(loop_start) or loop_start < 0):
            errors.append(f"{name}: loopStart 必須是 >= 0 的秒數")
            continue
        if loop_end is not None and (not is_number(loop_end) or loop_end <= 0):
            errors.append(f"{name}: loopEnd 必須是 > 0 的秒數")
            continue
        if loop_start is not None and loop_end is not None and loop_end <= loop_start:
            errors.append(f"{name}: loopEnd（{loop_end}）必須大於 loopStart（{loop_start}）")
            continue
        if kind != "music" and (loop_start is not None or loop_end is not None):
            warnings.append(f"{name}: loopStart/loopEnd 只對 BGM（kind=music）有效；單次音效會忽略")
        if not loop and (loop_start is not None or loop_end is not None):
            warnings.append(f"{name}: loop=false 時 loopStart/loopEnd 不會有作用")

        volume = override.get("volume")
        if volume is not None and (not is_number(volume) or not 0 <= volume <= 1):
            errors.append(f"{name}: volume 必須是 0..1 的數字")
            continue

        desc = override.get("desc")
        if desc is not None and not isinstance(desc, str):
            errors.append(f"{name}: desc 必須是字串")
            continue

        try:
            size = path.stat().st_size
        except OSError as exc:
            errors.append(f"{name}: 讀取檔案失敗（{exc}）")
            continue

        entry: dict = {"file": rel, "kind": kind, "loop": loop}
        if loop_start is not None:
            entry["loopStart"] = float(loop_start)
        if loop_end is not None:
            entry["loopEnd"] = float(loop_end)
        if volume is not None:
            entry["volume"] = float(volume)
        entry["tags"] = tags
        if desc is not None:
            entry["desc"] = desc
        entry["bytes"] = size
        entry["custom"] = True
        audio[name] = entry
        stats[kind] += 1
        stats["bytes"] += size
        if loop_start is not None or loop_end is not None:
            stats["loop"] += 1

    return audio, errors, stats


# ---------------------------------------------------------------- 主流程


def force_utf8_stdio() -> None:
    """Windows 主控台預設 cp950/cp1252，輸出中文會炸；有 reconfigure 就轉 UTF-8。"""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if reconfigure is None:
            continue
        try:
            reconfigure(encoding="utf-8", errors="replace")
        except (OSError, ValueError):
            pass


def main(argv: list[str] | None = None) -> int:
    force_utf8_stdio()
    parser = argparse.ArgumentParser(
        description="掃描 assets/custom/ 的 PNG 與音訊，產出 assets/custom.index.json（dr-battle-assets/1）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="詳細流程見 docs/CUSTOM-ASSETS.md",
    )
    parser.add_argument("--root", type=Path, default=DEFAULT_ROOT, help="assets/ 根目錄（索引路徑相對於它；預設 repo 的 assets/）")
    parser.add_argument("--source", type=Path, default=None, help="自訂素材目錄（預設 <root>/custom）")
    parser.add_argument("--out", type=Path, default=None, help="輸出索引（預設 <root>/custom.index.json）")
    parser.add_argument("--sprites", type=Path, default=None, help="sprites.json（預設 <source>/sprites.json）")
    parser.add_argument("--audio", type=Path, default=None, help="audio.json（預設 <source>/audio.json）")
    parser.add_argument("--dry-run", action="store_true", help="只印統計，不寫入任何檔案")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    source = (args.source or root / "custom").resolve()
    out = (args.out or root / "custom.index.json").resolve()
    sprites_json = (args.sprites or source / "sprites.json").resolve()
    audio_json = (args.audio or source / "audio.json").resolve()
    warnings: list[str] = []

    print(f"自訂素材根目錄：{display(root)}")
    print(f"掃描目錄      ：{display(source)}")
    if not source.is_dir():
        fail(
            f"找不到 {display(source)}；請先建立資料夾並放入 PNG／音訊（做法見 docs/CUSTOM-ASSETS.md）",
            2,
        )

    sprite_overrides = load_overrides(sprites_json, warnings)
    print(
        f"sprites.json  ：{display(sprites_json)}（{len(sprite_overrides)} 筆覆寫）"
        if sprite_overrides
        else "sprites.json  ：無（全部使用圖片中心當原點）"
    )

    audio_overrides = load_audio_overrides(audio_json, warnings)
    print(
        f"audio.json    ：{display(audio_json)}（{len(audio_overrides)} 筆覆寫）"
        if audio_overrides
        else "audio.json    ：無（music 預設整首循環、sfx 預設不循環）"
    )

    pngs = scan_pngs(source)
    print(f"[1/3] 掃描 PNG ：{len(pngs)} 張")

    audio_found, audio_scan_errors = scan_audio(source, root, warnings)
    music_files = sum(1 for items in audio_found.values() for item in items if item["kind"] == "music")
    sfx_files = sum(1 for items in audio_found.values() for item in items if item["kind"] == "sfx")
    print(f"[2/3] 掃描音訊：{music_files + sfx_files} 個（music {music_files} / sfx {sfx_files}）")

    if not pngs and not sprite_overrides and not audio_found and not audio_overrides:
        fail(
            f"{display(source)} 底下沒有 PNG 與音訊，也沒有 sprites.json／audio.json 條目；沒有東西可以編",
            2,
        )

    sprites, errors, center_count, explicit_count = build_entries(
        pngs, sprite_overrides, root, source, warnings
    )
    audio, audio_errors, audio_stats = build_audio_entries(
        audio_found, audio_overrides, root, source, warnings
    )
    errors = audio_scan_errors + errors + audio_errors
    if errors:
        print(f"\n[錯誤] {len(errors)} 則：", file=sys.stderr)
        for message in errors:
            print(f"  x {message}", file=sys.stderr)
        raise SystemExit(1)
    if not sprites and not audio:
        fail("沒有任何可用的 sprite 或音訊（檢查上面的警告與檔案）", 2)

    payload = {"format": FORMAT, "sprites": sprites, "audio": audio}
    frames = sum(len(entry["frames"]) for entry in sprites.values())
    print(f"[3/3] 輸出：{display(out)}")
    print(f"      sprite：{len(sprites)} 個、{frames} 幀")
    print(
        f"      音訊  ：{len(audio)} 個（music {audio_stats['music']} / sfx {audio_stats['sfx']}，"
        f"loop 點 {audio_stats['loop']} 個，{audio_stats['bytes']:,} bytes）"
    )
    print(f"      原點  ：圖片中心 {center_count} 個、sprites.json 指定 {explicit_count} 個")
    if warnings:
        print(f"\n警告 {len(warnings)} 則：")
        for message in warnings:
            print(f"  ! {message}")

    if args.dry_run:
        print("\n（dry-run，未寫入檔案）")
        return 0

    out.parent.mkdir(parents=True, exist_ok=True)
    tmp = out.with_name(out.name + ".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    tmp.replace(out)
    print(f"\n完成：{display(out)}")
    print("下一步：python tools/build_assets.py（重建 assets/index.json 時會自動併入 sprites 與 audio）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
