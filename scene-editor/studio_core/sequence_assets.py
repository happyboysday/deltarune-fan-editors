"""Validated PNG sequence assets for the DELTARUNE Director animation layer.

The module owns only caller-provided animation files and metadata. Official
assets, game roots, and all source images are treated as read-only inputs.
"""
from __future__ import annotations

import base64
import binascii
import copy
import hashlib
import io
import json
import math
import re
import threading
import warnings
from pathlib import Path
from typing import Any

from PIL import Image

from .registry_io import publish, registry_write


MAX_FRAME_BYTES = 8 * 1024 * 1024
MAX_TOTAL_INPUT_BYTES = 32 * 1024 * 1024
MAX_STRIP_BYTES = 64 * 1024 * 1024
MAX_FRAME_SIDE = 4096
MAX_STRIP_WIDTH = 8192
MAX_STRIP_PIXELS = 16_777_216
MAX_FRAMES = 128
MAX_SAFE_INTEGER = (1 << 53) - 1
MIN_FPS = 1.0
MAX_FPS = 60.0

IMPORT_FORMAT = "director-animation-import/1"
REGISTRY_FORMAT = "director-animation-registry/1"
CONTENT_FORMAT = "director-animation-content/1"
PUBLIC_FORMAT = "director-animation-asset/1"
ANIMATION_FORMAT = "director-animation/1"

CHAPTER_RE = re.compile(r"^ch[1-5]$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
ASSET_RE = re.compile(r"^animation:(ch[1-5]):([0-9a-f]{64})$")
FILE_REPARSE = 0x400


class SequenceAssetError(ValueError):
    """A sequence import, registry, scene, or filesystem check failed."""


def _reject_reparse(path: Path) -> None:
    if path.exists() and (
        path.is_symlink()
        or getattr(path.lstat(), "st_file_attributes", 0) & FILE_REPARSE
    ):
        raise SequenceAssetError(
            "animation paths may not contain symlinks or reparse points"
        )
    if path.is_file() and getattr(path.stat(), "st_nlink", 1) > 1:
        raise SequenceAssetError("animation paths may not be hard links")


def safe_path(root: Path, *parts: str) -> Path:
    """Return a path under root after rejecting links and traversal."""

    root = Path(root).absolute()
    _reject_reparse(root)
    target = root.joinpath(*parts)
    for path in (target, *target.parents):
        _reject_reparse(path)
    resolved_root = root.resolve()
    resolved = target.resolve()
    if resolved != resolved_root and resolved_root not in resolved.parents:
        raise SequenceAssetError("animation path escapes its private root")
    return target


def _png_header(
    raw: bytes,
    *,
    max_bytes: int = MAX_FRAME_BYTES,
    max_width: int = MAX_FRAME_SIDE,
    max_height: int = MAX_FRAME_SIDE,
    max_pixels: int = MAX_STRIP_PIXELS,
) -> dict[str, Any]:
    """Read PNG structure and dimensions without decoding pixel data."""

    if not isinstance(raw, bytes) or not 1 <= len(raw) <= max_bytes:
        raise SequenceAssetError("PNG exceeds its byte limit")
    if raw[:8] != b"\x89PNG\r\n\x1a\n" or len(raw) < 33:
        raise SequenceAssetError("input is not a PNG file")
    offset = 8
    first = True
    saw_iend = False
    saw_actl = False
    header = None
    while offset + 12 <= len(raw):
        length = int.from_bytes(raw[offset : offset + 4], "big")
        end = offset + 12 + length
        if end > len(raw):
            raise SequenceAssetError("PNG chunk is truncated")
        chunk_type = raw[offset + 4 : offset + 8]
        chunk_data = raw[offset + 8 : offset + 8 + length]
        if first:
            if chunk_type != b"IHDR" or len(chunk_data) != 13:
                raise SequenceAssetError("PNG IHDR is invalid")
            first = False
            width = int.from_bytes(chunk_data[0:4], "big")
            height = int.from_bytes(chunk_data[4:8], "big")
            bit_depth = chunk_data[8]
            color_type = chunk_data[9]
            compression = chunk_data[10]
            filter_method = chunk_data[11]
            interlace = chunk_data[12]
            header = {
                "width": width,
                "height": height,
                "bit_depth": bit_depth,
                "color_type": color_type,
                "interlace": interlace,
            }
            if (
                not width
                or not height
                or width > max_width
                or height > max_height
                or width * height > max_pixels
            ):
                raise SequenceAssetError("PNG dimensions exceed the sequence limits")
            if bit_depth not in (1, 2, 4, 8, 16) or color_type not in (0, 2, 3, 4, 6):
                raise SequenceAssetError("PNG header has an unsupported color type")
            if compression != 0 or filter_method != 0 or interlace not in (0, 1):
                raise SequenceAssetError("PNG header has an unsupported encoding")
        elif chunk_type == b"acTL":
            saw_actl = True
        offset = end
        if chunk_type == b"IEND":
            saw_iend = True
            break
    if not header or not saw_iend or offset != len(raw):
        raise SequenceAssetError("PNG is missing a complete header or IEND chunk")
    if saw_actl:
        raise SequenceAssetError("APNG animation controls are not supported")
    return header


def _decode_with_pillow(
    raw: bytes,
    expected_width: int,
    expected_height: int,
) -> tuple[Image.Image, dict[str, Any]]:
    """Verify and load one already-bounded static PNG as RGBA."""

    try:
        warning_type = getattr(Image, "DecompressionBombWarning", Warning)
        with warnings.catch_warnings():
            warnings.simplefilter("error", warning_type)
            with Image.open(io.BytesIO(raw)) as image:
                if image.format != "PNG":
                    raise SequenceAssetError("input is not a PNG file")
                if getattr(image, "n_frames", 1) != 1:
                    raise SequenceAssetError("animated PNG is not supported")
                if image.size != (expected_width, expected_height):
                    raise SequenceAssetError("PNG header dimensions changed during decode")
                image.verify()
            with Image.open(io.BytesIO(raw)) as image:
                if getattr(image, "n_frames", 1) != 1:
                    raise SequenceAssetError("animated PNG is not supported")
                if image.size != (expected_width, expected_height):
                    raise SequenceAssetError("PNG header dimensions changed during decode")
                image.load()
                converted = image.convert("RGBA")
                converted.load()
                return converted.copy(), {
                    "pillow_mode": image.mode,
                    "bit_depth": image.info.get("bit_depth"),
                    "interlace": image.info.get("interlace"),
                }
    except SequenceAssetError:
        raise
    except Exception as exc:
        warning_type = getattr(Image, "DecompressionBombWarning", Warning)
        if isinstance(exc, warning_type):
            raise SequenceAssetError("PNG triggered a Pillow decompression-bomb warning") from exc
        raise SequenceAssetError("PNG cannot be fully decoded") from exc


def inspect_png(
    raw: bytes,
    *,
    max_bytes: int = MAX_FRAME_BYTES,
    max_width: int = MAX_FRAME_SIDE,
    max_height: int = MAX_FRAME_SIDE,
    max_pixels: int = MAX_STRIP_PIXELS,
) -> tuple[int, int]:
    """Validate the PNG header, then verify and load the pixel data."""

    header = _png_header(
        raw,
        max_bytes=max_bytes,
        max_width=max_width,
        max_height=max_height,
        max_pixels=max_pixels,
    )
    _decode_with_pillow(raw, header["width"], header["height"])
    return header["width"], header["height"]


def _chapter(value: Any) -> str:
    if not isinstance(value, str) or CHAPTER_RE.fullmatch(value) is None:
        raise SequenceAssetError("chapter must be ch1 through ch5")
    return value


def _sha(value: Any, label: str) -> str:
    if not isinstance(value, str) or SHA_RE.fullmatch(value) is None:
        raise SequenceAssetError(f"{label} must be a lowercase SHA-256")
    return value


def _display_text(value: Any, label: str, limit: int) -> str:
    if (
        not isinstance(value, str)
        or not value
        or len(value) > limit
        or any(ord(character) < 32 for character in value)
    ):
        raise SequenceAssetError(
            f"{label} must be a non-empty visible string of at most {limit} characters"
        )
    return value


def _integer(
    value: Any,
    label: str,
    *,
    minimum: int = -MAX_SAFE_INTEGER,
    maximum: int = MAX_SAFE_INTEGER,
) -> int:
    if isinstance(value, bool):
        raise SequenceAssetError(f"{label} must be a finite integer JSON number")
    if isinstance(value, int):
        result = value
    elif isinstance(value, float) and math.isfinite(value) and value.is_integer():
        result = int(value)
    else:
        raise SequenceAssetError(f"{label} must be a finite integer JSON number")
    if not minimum <= result <= maximum:
        raise SequenceAssetError(f"{label} is outside its safe integer range")
    return result


def _fps(value: Any) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise SequenceAssetError("fps must be a finite number from 1 to 60")
    number = float(value)
    if not math.isfinite(number) or not MIN_FPS <= number <= MAX_FPS:
        raise SequenceAssetError("fps must be a finite number from 1 to 60")
    return number


def _natural_key(value: str) -> tuple[tuple[int, Any], ...]:
    return tuple(
        (0, int(part)) if part.isdigit() else (1, part.casefold())
        for part in re.split(r"(\d+)", value)
    )


def _content_digest(
    frame_hashes: list[str],
    width: int,
    height: int,
    origin_x: int,
    origin_y: int,
) -> str:
    document = {
        "format": CONTENT_FORMAT,
        "frames": frame_hashes,
        "width": width,
        "height": height,
        "origin": {"x": origin_x, "y": origin_y},
    }
    encoded = json.dumps(
        document,
        ensure_ascii=True,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    ).encode("utf-8")
    return hashlib.sha256(encoded).hexdigest()


def _defaults(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict) or set(value) != {"fps", "loop"}:
        raise SequenceAssetError("defaults must contain exactly fps and loop")
    loop = value["loop"]
    if not isinstance(loop, bool):
        raise SequenceAssetError("defaults.loop must be boolean")
    return {"fps": _fps(value["fps"]), "loop": loop}


def _alias(
    document: dict[str, Any],
    defaults: dict[str, Any],
) -> dict[str, Any]:
    character = _display_text(document.get("character"), "character", 160)
    action = _display_text(document.get("action"), "action", 160)
    supplied_name = document.get("name")
    name = (
        _display_text(supplied_name, "name", 200)
        if supplied_name is not None
        else _display_text(f"{character}/{action}", "name", 200)
    )
    return {
        "character": character,
        "action": action,
        "name": name,
        "defaults": defaults,
    }


def _alias_key(alias: dict[str, Any]) -> tuple[str, str, str]:
    return (
        str(alias["character"]),
        str(alias["action"]),
        str(alias["name"]),
    )


def _axis(value: Any, label: str) -> int:
    return _integer(value, label)


def _validate_alias(alias: Any) -> dict[str, Any]:
    if not isinstance(alias, dict):
        raise SequenceAssetError("registry alias must be an object")
    character = _display_text(alias.get("character"), "alias.character", 160)
    action = _display_text(alias.get("action"), "alias.action", 160)
    name = _display_text(alias.get("name"), "alias.name", 200)
    defaults = _defaults(alias.get("defaults"))
    return {
        "character": character,
        "action": action,
        "name": name,
        "defaults": defaults,
    }


def _write_json(path: Path, value: dict[str, Any]) -> None:
    publish(path, json.dumps(value, ensure_ascii=False, indent=2) + "\n")


class SequenceAssets:
    """Chapter-isolated registry for validated PNG animation sequences."""

    def __init__(self, root: Path):
        self.root = Path(root).absolute()
        self.lock = threading.RLock()

    def _record_path(self, chapter: str, digest: str) -> Path:
        return safe_path(self.root, chapter, digest + ".json")

    def _strip_path(self, chapter: str, digest: str) -> Path:
        return safe_path(self.root, chapter, digest + ".png")

    def _content_path(self, chapter: str, digest: str) -> str:
        return f"animations/{digest}.png"

    def _strip_bytes(self, record: dict[str, Any]) -> bytes:
        chapter = _chapter(record.get("chapter"))
        digest = _sha(record.get("content_sha256"), "content_sha256")
        path = self._strip_path(chapter, digest)
        try:
            if path.stat().st_size > MAX_STRIP_BYTES:
                raise SequenceAssetError("animation strip exceeds its byte limit")
            raw = path.read_bytes()
        except OSError as exc:
            raise SequenceAssetError("animation strip is missing") from exc
        if hashlib.sha256(raw).hexdigest() != record.get("strip_sha256"):
            raise SequenceAssetError("animation strip SHA-256 does not match registry")
        frame_count = _integer(record.get("frame_count"), "frame_count", minimum=1, maximum=MAX_FRAMES)
        width = _integer(record.get("width"), "width", minimum=1, maximum=MAX_FRAME_SIDE)
        height = _integer(record.get("height"), "height", minimum=1, maximum=MAX_FRAME_SIDE)
        try:
            actual_width, actual_height = inspect_png(
                raw,
                max_bytes=MAX_STRIP_BYTES,
                max_width=MAX_STRIP_WIDTH,
                max_height=MAX_FRAME_SIDE,
                max_pixels=MAX_STRIP_PIXELS,
            )
        except SequenceAssetError as exc:
            raise SequenceAssetError("animation strip is not a valid static PNG") from exc
        if actual_width != width * frame_count or actual_height != height:
            raise SequenceAssetError("animation strip dimensions do not match metadata")
        if width * frame_count > MAX_STRIP_WIDTH:
            raise SequenceAssetError("animation strip width exceeds the atlas limit")
        if width * frame_count * height > MAX_STRIP_PIXELS:
            raise SequenceAssetError("animation strip exceeds the decoded pixel limit")
        return raw

    def _validate_record(
        self,
        record: Any,
        chapter: str,
        digest: str,
    ) -> dict[str, Any]:
        if not isinstance(record, dict):
            raise SequenceAssetError("animation registry must be an object")
        if record.get("format") != REGISTRY_FORMAT:
            raise SequenceAssetError("animation registry format is unsupported")
        if _chapter(record.get("chapter")) != chapter:
            raise SequenceAssetError("animation registry chapter mismatch")
        if _sha(record.get("content_sha256"), "content_sha256") != digest:
            raise SequenceAssetError("animation registry digest mismatch")
        if _sha(record.get("strip_sha256"), "strip_sha256") == "":
            raise SequenceAssetError("animation strip hash is missing")
        frame_count = _integer(
            record.get("frame_count"), "frame_count", minimum=1, maximum=MAX_FRAMES
        )
        width = _integer(record.get("width"), "width", minimum=1, maximum=MAX_FRAME_SIDE)
        height = _integer(record.get("height"), "height", minimum=1, maximum=MAX_FRAME_SIDE)
        origin_x = _axis(record.get("origin_x"), "origin_x")
        origin_y = _axis(record.get("origin_y"), "origin_y")
        if record.get("file") != self._content_path(chapter, digest):
            raise SequenceAssetError("animation registry file path is invalid")
        frames = record.get("frames")
        if not isinstance(frames, list) or len(frames) != frame_count:
            raise SequenceAssetError("animation registry frame list count is invalid")
        frame_hashes: list[str] = []
        for index, frame in enumerate(frames):
            if not isinstance(frame, dict) or frame.get("index") != index:
                raise SequenceAssetError("animation frame indices are invalid")
            name = _display_text(frame.get("name"), "frame.name", 256)
            source_hash = _sha(frame.get("source_sha256"), "frame.source_sha256")
            source_width = _integer(
                frame.get("source_width"), "frame.source_width", minimum=1, maximum=width
            )
            source_height = _integer(
                frame.get("source_height"), "frame.source_height", minimum=1, maximum=height
            )
            source_bytes = _integer(
                frame.get("source_bytes"),
                "frame.source_bytes",
                minimum=1,
                maximum=MAX_FRAME_BYTES,
            )
            source_bit_depth = _integer(
                frame.get("source_bit_depth"),
                "frame.source_bit_depth",
                minimum=1,
                maximum=16,
            )
            source_color_type = _integer(
                frame.get("source_color_type"),
                "frame.source_color_type",
                minimum=0,
                maximum=6,
            )
            source_interlace = _integer(
                frame.get("source_interlace"),
                "frame.source_interlace",
                minimum=0,
                maximum=1,
            )
            pillow_mode = _display_text(
                frame.get("pillow_mode"),
                "frame.pillow_mode",
                64,
            )
            if source_bit_depth not in (1, 2, 4, 8, 16):
                raise SequenceAssetError("animation frame source bit depth is invalid")
            if source_color_type not in (0, 2, 3, 4, 6):
                raise SequenceAssetError("animation frame source color type is invalid")
            padded_x = _integer(
                frame.get("padded_x"), "frame.padded_x", minimum=0, maximum=0
            )
            padded_y = _integer(
                frame.get("padded_y"), "frame.padded_y", minimum=0, maximum=0
            )
            padding_right = _integer(
                frame.get("padding_right"),
                "frame.padding_right",
                minimum=0,
                maximum=width - 1,
            )
            padding_bottom = _integer(
                frame.get("padding_bottom"),
                "frame.padding_bottom",
                minimum=0,
                maximum=height - 1,
            )
            if padded_x != 0 or padded_y != 0:
                raise SequenceAssetError("animation frames must use top-left padding")
            if padding_right != width - source_width:
                raise SequenceAssetError("animation frame right padding is invalid")
            if padding_bottom != height - source_height:
                raise SequenceAssetError("animation frame bottom padding is invalid")
            frame_hashes.append(source_hash)
            if not name or not source_width or not source_height or not source_bytes:
                raise SequenceAssetError("animation frame metadata is incomplete")
        source_total_bytes = _integer(
            record.get("source_total_bytes"),
            "source_total_bytes",
            minimum=1,
            maximum=MAX_TOTAL_INPUT_BYTES,
        )
        if source_total_bytes != sum(
            _integer(
                frame.get("source_bytes"),
                "frame.source_bytes",
                minimum=1,
                maximum=MAX_FRAME_BYTES,
            )
            for frame in frames
        ):
            raise SequenceAssetError("animation source byte total is invalid")
        if _content_digest(frame_hashes, width, height, origin_x, origin_y) != digest:
            raise SequenceAssetError("animation content metadata digest mismatch")
        aliases = record.get("aliases")
        if not isinstance(aliases, list) or not aliases:
            raise SequenceAssetError("animation registry has no aliases")
        normalized_aliases = []
        seen_aliases = set()
        for alias_value in aliases:
            alias_value = _validate_alias(alias_value)
            key = _alias_key(alias_value)
            if key in seen_aliases:
                raise SequenceAssetError("animation registry has a duplicate alias")
            seen_aliases.add(key)
            normalized_aliases.append(alias_value)
        self._strip_bytes(record)
        result = copy.deepcopy(record)
        result["chapter"] = chapter
        result["content_sha256"] = digest
        result["frame_count"] = frame_count
        result["width"] = width
        result["height"] = height
        result["origin_x"] = origin_x
        result["origin_y"] = origin_y
        result["aliases"] = normalized_aliases
        result["frames"] = copy.deepcopy(frames)
        return result

    def _record(self, chapter: str, digest: str) -> dict[str, Any]:
        chapter = _chapter(chapter)
        digest = _sha(digest, "digest")
        path = self._record_path(chapter, digest)
        try:
            value = json.loads(path.read_text(encoding="utf8"))
        except (OSError, json.JSONDecodeError, UnicodeError) as exc:
            raise SequenceAssetError("animation registry is missing or unreadable") from exc
        with self.lock:
            return self._validate_record(value, chapter, digest)

    def _public(self, record: dict[str, Any]) -> dict[str, Any]:
        chapter = record["chapter"]
        digest = record["content_sha256"]
        aliases = copy.deepcopy(record["aliases"])
        primary = aliases[0]
        animation = {
            "format": ANIMATION_FORMAT,
            "frame_count": record["frame_count"],
            "frame_width": record["width"],
            "frame_height": record["height"],
            "origin_x": record["origin_x"],
            "origin_y": record["origin_y"],
            "file_sha256": record["strip_sha256"],
            "fps": primary["defaults"]["fps"],
            "loop": primary["defaults"]["loop"],
            "playing": True,
            "restart_id": 0,
        }
        return {
            "format": PUBLIC_FORMAT,
            "asset": f"animation:{chapter}:{digest}",
            "chapter": chapter,
            "kind": "animation",
            "custom": True,
            "animated": True,
            "name": primary["name"],
            "character": primary["character"],
            "action": primary["action"],
            "aliases": aliases,
            "width": record["width"],
            "height": record["height"],
            "frames": record["frame_count"],
            "frame_count": record["frame_count"],
            "frame_width": record["width"],
            "frame_height": record["height"],
            "origin_x": record["origin_x"],
            "origin_y": record["origin_y"],
            "origin_known": True,
            "file": record["file"],
            "url": f"/animation-assets/{chapter}/{digest}.png",
            "preview_url": f"/animation-assets/{chapter}/{digest}.png",
            "sha256": record["strip_sha256"],
            "content_sha256": digest,
            "strip_sha256": record["strip_sha256"],
            "file_sha256": record["strip_sha256"],
            "animation": animation,
            "source_frames": copy.deepcopy(record["frames"]),
        }

    def _merge_alias(
        self,
        existing: dict[str, Any],
        proposed: dict[str, Any],
    ) -> dict[str, Any]:
        for field in (
            "chapter",
            "content_sha256",
            "strip_sha256",
            "frame_count",
            "width",
            "height",
            "origin_x",
            "origin_y",
            "file",
        ):
            if existing[field] != proposed[field]:
                raise SequenceAssetError("same content digest has conflicting metadata")
        new_alias = proposed["aliases"][0]
        new_key = _alias_key(new_alias)
        for alias_value in existing["aliases"]:
            if _alias_key(alias_value) == new_key:
                if alias_value["defaults"] != new_alias["defaults"]:
                    raise SequenceAssetError(
                        "same alias cannot silently use different defaults"
                    )
                return existing
        merged = copy.deepcopy(existing)
        merged["aliases"].append(copy.deepcopy(new_alias))
        return merged

    def import_sequence(self, document: dict[str, Any], old_record=None) -> dict[str, Any]:
        if not isinstance(document, dict):
            raise SequenceAssetError("animation import must be an object")
        if document.get("format") != IMPORT_FORMAT:
            raise SequenceAssetError("animation import format is unsupported")
        chapter = _chapter(document.get("chapter"))
        order = document.get("order")
        if order not in ("natural", "explicit"):
            raise SequenceAssetError("order must be natural or explicit")
        default_settings = _defaults(document.get("defaults"))
        alias_value = _alias(document, default_settings)
        origin = document.get("origin", {"x": 0, "y": 0})
        if not isinstance(origin, dict) or set(origin) != {"x", "y"}:
            raise SequenceAssetError("origin must contain exactly x and y")
        origin_x = _axis(origin["x"], "origin.x")
        origin_y = _axis(origin["y"], "origin.y")
        input_frames = document.get("frames")
        if not isinstance(input_frames, list) or not 1 <= len(input_frames) <= MAX_FRAMES:
            raise SequenceAssetError("frames must contain 1 through 128 items")
        decoded: list[dict[str, Any]] = []
        total_bytes = 0
        for index, frame in enumerate(input_frames):
            if not isinstance(frame, dict):
                raise SequenceAssetError("each frame must be an object")
            name = _display_text(frame.get("name"), "frame.name", 256)
            encoded = frame.get("png_base64")
            if not isinstance(encoded, str):
                raise SequenceAssetError("frame.png_base64 must be a string")
            if len(encoded) > ((MAX_FRAME_BYTES + 2) // 3) * 4:
                raise SequenceAssetError("one frame PNG exceeds 8 MiB")
            try:
                raw = base64.b64decode(encoded, validate=True)
            except (ValueError, binascii.Error) as exc:
                raise SequenceAssetError("frame contains invalid base64") from exc
            total_bytes += len(raw)
            if len(raw) > MAX_FRAME_BYTES:
                raise SequenceAssetError("one frame PNG exceeds 8 MiB")
            if total_bytes > MAX_TOTAL_INPUT_BYTES:
                raise SequenceAssetError("total input PNG bytes exceed 32 MiB")
            header = _png_header(raw)
            decoded.append(
                {
                    "name": name,
                    "raw": raw,
                    "sha256": hashlib.sha256(raw).hexdigest(),
                    "source_width": header["width"],
                    "source_height": header["height"],
                    "header": header,
                }
            )
        if order == "natural":
            decoded = sorted(decoded, key=lambda item: _natural_key(item["name"]))
        width = max(item["source_width"] for item in decoded)
        height = max(item["source_height"] for item in decoded)
        frame_count = len(decoded)
        if (
            width * frame_count > MAX_STRIP_WIDTH
            or height > MAX_FRAME_SIDE
            or width * frame_count * height > MAX_STRIP_PIXELS
        ):
            raise SequenceAssetError("the requested strip exceeds atlas or pixel limits")
        frame_hashes = [item["sha256"] for item in decoded]
        digest = _content_digest(frame_hashes, width, height, origin_x, origin_y)
        strip = Image.new("RGBA", (width * frame_count, height), (0, 0, 0, 0))
        frames_metadata = []
        for index, item in enumerate(decoded):
            rgba, pillow_metadata = _decode_with_pillow(
                item["raw"],
                item["source_width"],
                item["source_height"],
            )
            if rgba.size != (item["source_width"], item["source_height"]):
                raise SequenceAssetError("decoded PNG dimensions do not match its header")
            strip.alpha_composite(rgba, (index * width, 0))
            frames_metadata.append(
                {
                    "index": index,
                    "name": item["name"],
                    "source_sha256": item["sha256"],
                    "source_bytes": len(item["raw"]),
                    "source_width": item["source_width"],
                    "source_height": item["source_height"],
                    "source_bit_depth": item["header"]["bit_depth"],
                    "source_color_type": item["header"]["color_type"],
                    "source_interlace": item["header"]["interlace"],
                    "pillow_mode": pillow_metadata["pillow_mode"],
                    "padded_x": 0,
                    "padded_y": 0,
                    "padding_right": width - item["source_width"],
                    "padding_bottom": height - item["source_height"],
                }
            )
        output = io.BytesIO()
        strip.save(output, format="PNG")
        strip_raw = output.getvalue()
        if len(strip_raw) > MAX_STRIP_BYTES:
            raise SequenceAssetError("generated animation strip exceeds 64 MiB")
        _png_header(
            strip_raw,
            max_bytes=MAX_STRIP_BYTES,
            max_width=MAX_STRIP_WIDTH,
            max_height=MAX_FRAME_SIDE,
            max_pixels=MAX_STRIP_PIXELS,
        )
        strip_sha = hashlib.sha256(strip_raw).hexdigest()
        record = {
            "format": REGISTRY_FORMAT,
            "chapter": chapter,
            "content_sha256": digest,
            "strip_sha256": strip_sha,
            "file": self._content_path(chapter, digest),
            "frame_count": frame_count,
            "width": width,
            "height": height,
            "origin_x": origin_x,
            "origin_y": origin_y,
            "frames": frames_metadata,
            "source_total_bytes": total_bytes,
            "aliases": [alias_value],
        }
        with self.lock, registry_write(safe_path(self.root, chapter, ".registry-lock")):
            strip_path = self._strip_path(chapter, digest)
            record_path = self._record_path(chapter, digest)
            if strip_path.exists():
                current = strip_path.read_bytes()
                if current != strip_raw:
                    raise SequenceAssetError("existing strip does not match content")
            else:
                publish(strip_path, strip_raw)
            if record_path.exists():
                existing = self._record(chapter, digest)
                merged = self._merge_alias(existing, record)
                if merged != existing:
                    _write_json(record_path, merged)
                return self._public(self._record(chapter, digest))
            if old_record and (prior := old_record(chapter, digest)):
                record = self._merge_alias(prior, record)
            _write_json(record_path, record)
            return self._public(self._record(chapter, digest))

    def listing(self, chapter: str, query: str = "") -> list[dict[str, Any]]:
        chapter = _chapter(chapter)
        if not isinstance(query, str):
            raise SequenceAssetError("query must be a string")
        folder = safe_path(self.root, chapter)
        if not folder.exists():
            return []
        with self.lock:
            rows = [
                self._public(self._record(chapter, path.stem))
                for path in sorted(folder.glob("*.json"))
            ]
        needle = query.casefold()
        if not needle:
            return rows
        return [
            row
            for row in rows
            if any(
                needle in row[field].casefold()
                for field in ("name", "character", "action", "asset")
            )
            or any(
                needle in alias["name"].casefold()
                or needle in alias["character"].casefold()
                or needle in alias["action"].casefold()
                for alias in row["aliases"]
            )
        ]

    def resolve(self, chapter: str, ids: list[Any]) -> list[dict[str, Any]]:
        chapter = _chapter(chapter)
        if not isinstance(ids, list):
            raise SequenceAssetError("ids must be a list")
        result = []
        for value in ids:
            if not isinstance(value, str) or not value.startswith("animation:"):
                continue
            match = ASSET_RE.fullmatch(value)
            if match is None or match.group(1) != chapter:
                raise SequenceAssetError("animation asset chapter mismatch")
            result.append(self._public(self._record(chapter, match.group(2))))
        return result

    def image(self, chapter: str, digest: str) -> bytes:
        chapter = _chapter(chapter)
        digest = _sha(digest, "digest")
        with self.lock:
            return self._strip_bytes(self._record(chapter, digest))



def validate_animation_import_document(document: Any) -> None:
    if not isinstance(document, dict):
        raise ValueError("动画序列导入请求必须是 JSON 对象")
    if document.get("format") != "director-animation-import/1":
        raise ValueError("动画序列导入 format 必须是 director-animation-import/1")
    chapter = document.get("chapter")
    if not isinstance(chapter, str) or chapter not in {f"ch{i}" for i in range(1, 6)}:
        raise ValueError("动画序列必须使用当前 ch1 到 ch5 章节")
    for field in ("character", "action"):
        value = document.get(field)
        if (
            not isinstance(value, str)
            or not 1 <= len(value) <= 80
            or any(ord(character) < 32 for character in value)
        ):
            raise ValueError(f"{field} 必须是 1～80 个可见字符")
    name = document.get("name")
    if name is not None and (
        not isinstance(name, str)
        or not 1 <= len(name) <= 160
        or any(ord(character) < 32 for character in name)
    ):
        raise ValueError("name 必须是 1～160 个可见字符")
    if document.get("order") not in ("natural", "explicit"):
        raise ValueError("order 必须是 natural 或 explicit")
    frames = document.get("frames")
    if not isinstance(frames, list) or not 1 <= len(frames) <= 128:
        raise ValueError("frames 必须包含 1～128 帧")
    total_bytes = 0
    for index, frame in enumerate(frames):
        if not isinstance(frame, dict):
            raise ValueError(f"第 {index + 1} 帧必须是对象")
        frame_name = frame.get("name")
        if (
            not isinstance(frame_name, str)
            or not 1 <= len(frame_name) <= 255
            or any(ord(character) < 32 for character in frame_name)
        ):
            raise ValueError(f"第 {index + 1} 帧名称无效")
        encoded = frame.get("png_base64")
        if not isinstance(encoded, str) or not encoded:
            raise ValueError(f"第 {index + 1} 帧缺少 png_base64")
        if len(encoded) > ((8 * 1024 * 1024 + 2) // 3) * 4:
            raise ValueError(f"第 {index + 1} 帧 PNG 超过 8 MiB")
        padding = 2 if encoded.endswith("==") else 1 if encoded.endswith("=") else 0
        decoded_size = max(0, (len(encoded) * 3) // 4 - padding)
        if decoded_size > 8 * 1024 * 1024:
            raise ValueError(f"第 {index + 1} 帧 PNG 超过 8 MiB")
        total_bytes += decoded_size
        if total_bytes > 32 * 1024 * 1024:
            raise ValueError("动画序列 PNG 总大小超过 32 MiB")
        if index == 0 or index == len(frames) - 1 or len(frames) <= 4:
            try:
                header = base64.b64decode(encoded, validate=True)[:8]
            except (ValueError, binascii.Error) as error:
                raise ValueError(f"第 {index + 1} 帧 PNG base64 无效") from error
            if header != b"\x89PNG\r\n\x1a\n":
                raise ValueError(f"第 {index + 1} 帧不是 PNG")
    origin = document.get("origin")
    if not isinstance(origin, dict) or any(
        not isinstance(origin.get(axis), int) or isinstance(origin.get(axis), bool)
        for axis in ("x", "y")
    ):
        raise ValueError("origin 必须包含整数 x/y")
    defaults = document.get("defaults")
    if not isinstance(defaults, dict):
        raise ValueError("defaults 必须包含 fps/loop")
    fps = defaults.get("fps")
    if (
        isinstance(fps, bool)
        or not isinstance(fps, (int, float))
        or not math.isfinite(float(fps))
        or not 1 <= float(fps) <= 60
    ):
        raise ValueError("fps 必须是 1～60 的有限数值")
    if not isinstance(defaults.get("loop"), bool):
        raise ValueError("loop 必须是布尔值")
