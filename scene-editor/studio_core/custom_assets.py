"""User-owned static PNG assets. Official assets and caller files stay read-only."""
from __future__ import annotations
import base64
import binascii
import hashlib
import io
import json
import re
import threading
import unicodedata
import uuid
import warnings
from pathlib import Path
from PIL import Image

from .registry_io import publish, registry_write

MAX_PNG_BYTES = 8 * 1024 * 1024
SHA = re.compile(r"^[0-9a-f]{64}$")
CHAPTER = re.compile(r"^ch[1-5]$")
ASSET = re.compile(r"^custom:(ch[1-5]):([0-9a-f]{64})$")


class CustomAssetError(ValueError):
    pass


def valid_name(name):
    return (isinstance(name, str) and 1 <= len(name) <= 160 and bool(name.strip())
            and all(unicodedata.category(c) not in {"Cc", "Cs"} for c in name))


def safe_path(root: Path, *parts: str) -> Path:
    """Reject reparse components before resolve, including a replaced root."""
    root = Path(root).absolute()
    target = root.joinpath(*parts)
    for p in [target, *target.parents]:
        if p.exists() and (p.is_symlink() or getattr(p.lstat(), "st_file_attributes", 0) & 0x400):
            raise CustomAssetError("素材路径不能经过链接或重解析目录")
    resolved = target.resolve()
    if resolved != root.resolve() and root.resolve() not in resolved.parents:
        raise CustomAssetError("素材路径超出独立目录")
    return target


def inspect_png(raw: bytes) -> tuple[int, int]:
    if not 1 <= len(raw) <= MAX_PNG_BYTES or raw[:8] != b"\x89PNG\r\n\x1a\n":
        raise CustomAssetError("请选择不超过 8 MiB 的 PNG 文件")
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(io.BytesIO(raw)) as im:
                if im.format != "PNG" or getattr(im, "n_frames", 1) != 1:
                    raise CustomAssetError("目前仅支持静态 PNG，不支持 APNG 动画")
                w, h = im.size
                if not (1 <= w <= 4096 and 1 <= h <= 4096 and w * h <= 16_777_216):
                    raise CustomAssetError("PNG 尺寸需在 1～4096 像素内")
                im.verify()
            with Image.open(io.BytesIO(raw)) as im:
                im.load()
        return w, h
    except CustomAssetError:
        raise
    except Exception as exc:
        raise CustomAssetError("PNG 文件无法完整解码") from exc


class CustomAssets:
    def __init__(self, root: Path):
        self.root = root.absolute()
        self.lock = threading.RLock()

    def chapter(self, chapter: str) -> str:
        if not isinstance(chapter, str) or not CHAPTER.fullmatch(chapter):
            raise CustomAssetError("请选择 ch1 到 ch5 的素材章节")
        return chapter

    def public(self, record: dict) -> dict:
        chapter, digest = record["chapter"], record["sha256"]
        return dict(asset=f"custom:{chapter}:{digest}", name=record["name"],
                    chapter=chapter, kind="custom_png", custom=True,
                    width=record["width"], height=record["height"], frames=1,
                    origin_x=0, origin_y=0, origin_known=True,
                    file=f"rooms_rendered/custom/{digest}.png",
                    url=f"/custom-assets/{chapter}/{digest}.png",
                    sha256=digest)

    def _record(self, chapter: str, digest: str) -> dict:
        self.chapter(chapter)
        if not isinstance(digest, str) or not SHA.fullmatch(digest):
            raise CustomAssetError("自制素材标识无效")
        try:
            p = safe_path(self.root, chapter, digest + ".json")
            record = json.loads(p.read_text(encoding="utf8"))
            if (record["chapter"] != chapter or record["sha256"] != digest
                    or record["format"] != "director-custom-png/1" or not valid_name(record["name"])
                    or any(type(record[key]) is not int or not 1 <= record[key] <= 4096 for key in ("width", "height"))):
                raise ValueError()
            self._bytes(record)
            return record
        except CustomAssetError:
            raise
        except (OSError, ValueError, KeyError, TypeError, RecursionError) as exc:
            raise CustomAssetError("自制素材登记缺失或损坏，请重新导入原 PNG") from exc

    def _bytes(self, record: dict) -> bytes:
        p = safe_path(self.root, record["chapter"], record["sha256"] + ".png")
        try:
            if p.stat().st_size > MAX_PNG_BYTES:
                raise CustomAssetError("自制素材文件过大")
            raw = p.read_bytes()
            if hashlib.sha256(raw).hexdigest() != record["sha256"]:
                raise CustomAssetError("自制素材文件校验不符，请重新导入原 PNG")
            if inspect_png(raw) != (record["width"], record["height"]):
                raise CustomAssetError("自制素材尺寸登记不符")
            return raw
        except OSError as exc:
            raise CustomAssetError("找不到自制素材 PNG，请重新导入原文件") from exc

    def upload(self, document: dict, old_record=None) -> dict:
        if not isinstance(document, dict):
            raise CustomAssetError("PNG 上传请求必须是对象")
        chapter = self.chapter(document.get("chapter"))
        name = document.get("name")
        if not valid_name(name):
            raise CustomAssetError("素材名称需为 1～160 个可见字符")
        encoded = document.get("png_base64")
        if not isinstance(encoded, str) or len(encoded) > ((MAX_PNG_BYTES + 2) // 3) * 4:
            raise CustomAssetError("PNG 文件超过 8 MiB")
        try:
            raw = base64.b64decode(encoded, validate=True)
        except (ValueError, binascii.Error) as exc:
            raise CustomAssetError("PNG 上传数据无效") from exc
        w, h = inspect_png(raw)
        digest = hashlib.sha256(raw).hexdigest()
        record = dict(format="director-custom-png/1", chapter=chapter, sha256=digest,
                      name=name, width=w, height=h)
        with self.lock, registry_write(safe_path(self.root, chapter, ".registry-lock")):
            p = safe_path(self.root, chapter, digest + ".png")
            if p.exists():
                if p.read_bytes() != raw:
                    raise CustomAssetError("同标识的素材已损坏；未覆盖现有文件")
            else:
                publish(p, raw)
            meta = safe_path(self.root, chapter, digest + ".json")
            if meta.exists():
                try:
                    return self.public(self._record(chapter, digest))
                except CustomAssetError:
                    publish(meta.with_suffix(".json.corrupt-" + uuid.uuid4().hex), meta.read_bytes())
            elif old_record:
                record = old_record(chapter, digest) or record
            publish(meta, json.dumps(record, ensure_ascii=False, indent=2))
            return self.public(self._record(chapter, digest))

    def listing(self, chapter: str, query: str = "", *, issues=None) -> list[dict]:
        self.chapter(chapter)
        folder = safe_path(self.root, chapter)
        if not folder.exists():
            return []
        with self.lock:
            rows = []
            for p in sorted(folder.glob("*.json")):
                try:
                    rows.append(self.public(self._record(chapter, p.stem)))
                except CustomAssetError as error:
                    if issues is not None:
                        issues.append({"file": str(p), "error": str(error)})
        needle = query.casefold()
        return [x for x in rows if not needle or needle in x["name"].casefold() or needle in x["asset"]]

    def resolve(self, chapter: str, ids: list) -> list[dict]:
        self.chapter(chapter)
        result = []
        for key in ids:
            if not isinstance(key, str) or not key.startswith("custom:"):
                continue
            match = ASSET.fullmatch(key)
            if not match or match[1] != chapter:
                raise CustomAssetError("自制素材与当前章节不符")
            result.append(self.public(self._record(chapter, match[2])))
        return result

    def image(self, chapter: str, digest: str) -> bytes:
        with self.lock:
            return self._bytes(self._record(chapter, digest))
