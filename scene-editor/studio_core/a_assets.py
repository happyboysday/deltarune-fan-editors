"""Strict read-only consumer for A-assets director-map exports."""

from __future__ import annotations

import copy
import json
import re
import urllib.parse
from pathlib import Path
from typing import Any


from .http import safe_child


CHAPTERS = ("ch1", "ch2", "ch3", "ch4", "ch5")
SPRITE_KINDS = {"official_sprite", "tile_crop", "rendered_reference"}


class AExportError(RuntimeError):
    """The A export cannot be consumed without guessing or mutating it."""


def _json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise AExportError(f"cannot read A export file {path.name}: {error}") from error


def _safe_child(root: Path, relative: str) -> Path:
    candidate = safe_child(root, relative)
    if candidate is None:
        raise AExportError("A path resolves outside its root")
    return candidate


def _file_url(path_base: str, relative: str) -> str:
    encoded = "/".join(
        urllib.parse.quote(part, safe="") for part in relative.split("/") if part
    )
    return f"/a-files/{path_base}/{encoded}"


class AAssetIndex:
    """Read and normalize A v1.2 exports without writing to the source."""

    def __init__(self, export_root: Path, official_root: Path):
        self.export_root = export_root.resolve()
        self.manifest = _json(self.export_root / "manifest.json")
        if self.manifest.get("format") != "director-assets/1":
            raise AExportError("unsupported A manifest format")
        if self.manifest.get("contract") != "director-map/1":
            raise AExportError("A export contract must be director-map/1")

        # A detached v8 folder can be named a-export. The wire version belongs to the manifest.
        roots = self.manifest.get("roots")
        if not isinstance(roots, dict) or roots.get("exports") != "exports/v8":
            raise AExportError("需要 A-export v8 清单")
        self.roots = {"exports": self.export_root, "official": official_root.resolve()}
        self.module_root = (self.export_root.parent.parent if self.export_root.parent.name == "exports"
                            else self.export_root.parent)

        if self.export_root.parent.name == "exports":
            bundled = self.module_root.parent.parent / "assets/official"
            if bundled.is_dir():
                self.roots["official"] = bundled.resolve()

        self.sprites_document = _json(self.export_root / "sprites.json")
        if self.sprites_document.get("format") != "director-sprites/1":
            raise AExportError("unsupported A sprites format")
        self.sprite_by_id: dict[str, dict[str, Any]] = {}
        for record in self.sprites_document.get("sprites", []):
            if not isinstance(record, dict):
                continue
            asset_id = record.get("id")
            if not isinstance(asset_id, str) or asset_id in self.sprite_by_id:
                continue
            if record.get("kind") not in SPRITE_KINDS:
                continue
            self.sprite_by_id[asset_id] = record

        self.chapters_document = _json(self.export_root / "chapters.json")
        if self.chapters_document.get("format") != "director-chapters/1":
            raise AExportError("unsupported A chapters format")
        self.chapter_records = {
            item.get("id"): item
            for item in self.chapters_document.get("chapters", [])
            if isinstance(item, dict) and item.get("id") in CHAPTERS
        }
        self.room_cache: dict[str, dict[str, Any]] = {}

    @property
    def version(self) -> str:
        return "v8"

    def assets_by_ids(self, chapter: str, asset_ids: list[str]) -> list[dict[str, Any]]:
        self._require_chapter(chapter)
        result: list[dict[str, Any]] = []
        for asset_id in asset_ids:
            record = self.sprite_by_id.get(asset_id)
            if not isinstance(record, dict) or record.get("chapter") != chapter:
                continue
            payload = self._asset_payload(record)
            if payload is not None:
                result.append(payload)
        return result

    def _asset_payload(self, record: dict[str, Any]) -> dict[str, Any] | None:
        asset_id = record.get("id")
        path_base = record.get("path_base")
        relative = record.get("path")
        if (
            not isinstance(asset_id, str)
            or path_base not in ("official", "exports")
            or not isinstance(relative, str)
        ):
            return None
        origin_verified = record.get("origin_verified")
        return {
            "asset": asset_id,
            "name": str(record.get("name", "")),
            "chapter": record.get("chapter"),
            "kind": record.get("kind"),
            "width": record.get("width", 0),
            "height": record.get("height", 0),
            "origin_x": record.get("origin_x", 0),
            "origin_y": record.get("origin_y", 0),
            "origin_verified": origin_verified,
            "origin_known": origin_verified is True,
            "frame_count": record.get("frame_count", 1),
            "frame_count_verified": record.get("frame_count_verified", False),
            "path_base": path_base,
            "path": relative,
            "url": _file_url(path_base, relative),
            "source_evidence": record.get("source_evidence"),
        }

    def room_catalog(self, chapter: str) -> dict[str, Any]:
        self._require_chapter(chapter)
        if chapter not in self.room_cache:
            catalog_path = self.export_root / "chapters" / chapter / "rooms.json"
            document = _json(catalog_path)
            if document.get("format") != "director-rooms/1":
                raise AExportError(f"unsupported room catalog for {chapter}")
            if document.get("chapter") != chapter:
                raise AExportError(f"room catalog chapter mismatch for {chapter}")
            self.room_cache[chapter] = document
        return copy.deepcopy(self.room_cache[chapter])

    def load_room(self, chapter: str, room_name: str) -> dict[str, Any]:
        catalog = self.room_catalog(chapter)
        record = next(
            (
                item
                for item in catalog.get("rooms", [])
                if item.get("name") == room_name or item.get("id") == room_name
            ),
            None,
        )
        if not isinstance(record, dict):
            raise AExportError(f"unknown A room: {chapter}/{room_name}")
        map_relative = record.get("map")
        if not isinstance(map_relative, str) or not map_relative:
            raise AExportError(f"A room has no map: {chapter}/{room_name}")
        map_path = _safe_child(self.roots["exports"], map_relative)
        if not map_path.is_file():
            raise AExportError(f"A room map is missing: {map_relative}")
        raw_map = _json(map_path)
        adapted, integration = self.adapt_map(raw_map)
        return {
            "format": "a-editor-room/1",
            "export": self.version,
            "room": {
                key: copy.deepcopy(record.get(key))
                for key in ("id", "chapter", "name", "width", "height", "sample", "counts", "unsupported")
            },
            "integration": integration,
            "map": adapted,
        }

    def adapt_map(self, raw_map: Any) -> tuple[dict[str, Any], dict[str, Any]]:
        if not isinstance(raw_map, dict) or raw_map.get("format") != "director-map/1":
            raise AExportError("A room map must use director-map/1")
        adapted = copy.deepcopy(raw_map)
        layers = adapted.get("layers")
        elements = adapted.get("elements")
        if not isinstance(layers, list) or not isinstance(elements, list):
            raise AExportError("A room map layers/elements must be arrays")

        depth_adjusted: list[str] = []
        zero_scale_excluded: list[str] = []
        excluded_elements: list[dict[str, Any]] = []
        for index, layer in enumerate(layers):
            if not isinstance(layer, dict):
                raise AExportError(f"A layer {index} must be an object")
            source_depth = layer.get("source_depth")
            if source_depth is None:
                layer.pop("source_depth", None)
            elif isinstance(source_depth, int) and not isinstance(source_depth, bool):
                if layer.get("depth") != source_depth:
                    depth_adjusted.append(str(layer.get("id", index)))
                layer["depth"] = source_depth
            else:
                raise AExportError(
                    f"A layer {index} source_depth must be integer or null"
                )

        drawable: list[Any] = []
        for index, element in enumerate(elements):
            if not isinstance(element, dict):
                raise AExportError(f"A element {index} must be an object")
            scale_x = element.get("scale_x", 1)
            scale_y = element.get("scale_y", 1)
            if scale_x == 0 or scale_y == 0:
                element_id = str(element.get("id", index))
                zero_scale_excluded.append(element_id)
                excluded_elements.append(copy.deepcopy(element))
                continue
            drawable.append(element)
        adapted["elements"] = drawable

        unsupported = adapted.get("unsupported")
        if not isinstance(unsupported, list):
            unsupported = []
        if depth_adjusted:
            unsupported.append("a_v7_depth_normalized_to_source_depth")
        if zero_scale_excluded:
            unsupported.append("zero_source_scale_instances_excluded")
        adapted["unsupported"] = list(dict.fromkeys(str(item) for item in unsupported))
        adapted["c_editor_a_adapter"] = {
            "export": self.version,
            "source_depth_normalized_layers": depth_adjusted,
            "excluded_zero_scale_element_ids": zero_scale_excluded,
        }
        if excluded_elements:
            adapted["excluded_source_elements"] = excluded_elements
        integration = {
            "export": self.version,
            "source_depth_normalized_layers": len(depth_adjusted),
            "zero_scale_excluded": len(zero_scale_excluded),
            "source_depth_values_restored": bool(depth_adjusted),
            "original_metadata_retained": True,
        }
        return adapted, integration


    def resolve_file(self, path_base: str, relative: str) -> Path:
        if path_base not in ("official", "exports"):
            raise AExportError("only official and exports A roots are readable")
        return _safe_child(self.roots[path_base], relative)

    def _require_chapter(self, chapter: str) -> None:
        if chapter not in CHAPTERS or chapter not in self.chapter_records:
            raise AExportError(f"A export does not contain {chapter}")
