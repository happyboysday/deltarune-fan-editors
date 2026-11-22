"""Explicitly pinned source-import background placement overlay."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .a_assets import AAssetIndex, AExportError
from .origin_overlay import (
    CHAPTERS,
    OverlayError,
    _json,
    _safe_child,
    file_sha256,
    png_dimensions,
)


PLACEMENT_OVERLAY_SCHEMA = "director-placement-overlay/1"
CURRENT_PLACEMENT_CANDIDATE_SHA256 = (
    "814166d6d7ede26a3a12f7d206189d4b60936c026bc03413e322c11e27e9b9c9"
)
OMITTED_BACKGROUNDS_SCHEMA = "a-assets-omitted-native-backgrounds/1"


def _same_number(actual: Any, expected: Any) -> bool:
    return (
        isinstance(actual, (int, float))
        and not isinstance(actual, bool)
        and isinstance(expected, (int, float))
        and not isinstance(expected, bool)
        and abs(float(actual) - float(expected)) <= 1e-5
    )


class PlacementOverlay:
    """Candidate-only background placement correction for first source import."""

    def __init__(
        self,
        manifest_path: Path,
        a_index: AAssetIndex,
        *,
        pin_sha256: str,
        review006_overlay_path: Path,
        review007_visibility_path: Path,
    ):
        self.manifest_path = manifest_path.resolve()
        self.root = self.manifest_path.parent
        self.a_root = a_index.module_root
        self.a_index = a_index
        self.pin_sha256 = str(pin_sha256 or "").lower()
        self.review006_overlay_path = review006_overlay_path.resolve()
        self.review007_visibility_path = review007_visibility_path.resolve()
        self.manifest_sha256: str | None = None
        self.error: str | None = None
        self.records: dict[str, dict[str, Any]] = {}
        self.records_by_room: dict[str, list[dict[str, Any]]] = {}
        self.totals: dict[str, Any] = {}
        self.coordinate_contract: dict[str, Any] = {}
        self.blocked_group: dict[str, Any] = {}
        self.omitted_records: list[dict[str, Any]] = []
        try:
            if self.pin_sha256 != CURRENT_PLACEMENT_CANDIDATE_SHA256:
                raise OverlayError("placement overlay candidate pin is not the approved explicit pin")
            if not self.manifest_path.is_file():
                raise OverlayError(f"placement overlay file missing: {manifest_path}")
            self.manifest_sha256 = file_sha256(self.manifest_path)
            if self.manifest_sha256 != self.pin_sha256:
                raise OverlayError("placement overlay SHA-256 does not match external pin")
            self._load()
        except (OverlayError, OSError, AExportError) as error:
            self.error = str(error)
            self.records = {}
            self.records_by_room = {}

    def _load(self) -> None:
        document = _json(self.manifest_path)
        if document.get("format") != PLACEMENT_OVERLAY_SCHEMA:
            raise OverlayError("unsupported placement overlay schema")
        if document.get("status") != "prototype-review-required":
            raise OverlayError("placement overlay candidate status mismatch")
        locked = document.get("locked_inputs")
        if not isinstance(locked, dict):
            raise OverlayError("placement locked_inputs missing")
        export_files = {
            "a_manifest_sha256": "manifest.json",
            "a_sprites_sha256": "sprites.json",
            "a_rooms_sha256": "rooms.json",
            "a_chapters_sha256": "chapters.json",
        }
        for field, name in export_files.items():
            path = self.a_index.export_root / name
            if not path.is_file() or locked.get(field) != file_sha256(path):
                raise OverlayError(f"placement lock mismatch: {field}")
        if (
            not self.review006_overlay_path.is_file()
            or locked.get("review006_overlay_sha256")
            != file_sha256(self.review006_overlay_path)
        ):
            raise OverlayError("placement Review006 overlay lock mismatch")
        if (
            not self.review007_visibility_path.is_file()
            or locked.get("review007_visibility_sha256")
            != file_sha256(self.review007_visibility_path)
        ):
            raise OverlayError("placement Review007 visibility lock mismatch")
        source_hashes = locked.get("source_data_win_sha256")
        if not isinstance(source_hashes, dict):
            raise OverlayError("placement source data locks missing")
        for chapter in CHAPTERS:
            expected = self.a_index.chapter_records.get(chapter, {}).get(
                "data_win", {}
            ).get("sha256")
            if not expected or source_hashes.get(chapter) != expected:
                raise OverlayError(f"placement source data mismatch: {chapter}")
        room_render_hashes = locked.get("official_rooms_render_sha256")
        if not isinstance(room_render_hashes, dict):
            raise OverlayError("placement rooms_render locks missing")
        for chapter in CHAPTERS:
            path = self.a_index.resolve_file(
                "official", f"maps/{chapter}/rooms_render.json"
            )
            if not path.is_file() or room_render_hashes.get(chapter) != file_sha256(
                path
            ):
                raise OverlayError(f"placement rooms_render mismatch: {chapter}")
        native_files = locked.get("native_background_files")
        if not isinstance(native_files, dict):
            raise OverlayError("placement native background locks missing")
        for relative, expected in native_files.items():
            path = _safe_child(self.a_root, str(relative))
            if not path.is_file() or file_sha256(path) != expected:
                raise OverlayError(f"placement native background mismatch: {relative}")

        self.totals = document.get("totals")
        contract = document.get("coordinate_contract")
        if not isinstance(self.totals, dict) or not isinstance(contract, dict):
            raise OverlayError("placement totals/coordinate contract missing")
        expected_totals = {
            "corrected_elements": 109,
            "review006_full_canvas_correction_elements": 10,
            "native_full_canvas_correction_elements": 99,
            "raw_target_crop_correction_elements": 0,
            "excluded_instance_elements": 45337,
        }
        for key, expected in expected_totals.items():
            if self.totals.get(key) != expected:
                raise OverlayError(f"placement total mismatch: {key}")
        expected_contract = {
            "element_kind": "background_only",
            "instance_elements_modified": False,
            "tile_elements_modified": False,
            "map_scale_rotation_changed": False,
            "native_origin_preserved": True,
        }
        for key, expected in expected_contract.items():
            if contract.get(key) != expected:
                raise OverlayError(f"placement coordinate contract mismatch: {key}")

        rendered = document.get("elements")
        if not isinstance(rendered, list) or len(rendered) != 109:
            raise OverlayError("placement rendered record count mismatch")
        for index, source in enumerate(rendered):
            record = self._validate_record(source, index)
            key = self._key(record)
            if key in self.records:
                raise OverlayError(f"duplicate placement record: {key}")
            room_key = f"{record['chapter']}:{record['map_id']}"
            self.records[key] = record
            self.records_by_room.setdefault(room_key, []).append(record)

        audit_path = self.root / "background-audit.json"
        audit = _json(audit_path)
        exceptions = audit.get("exceptions")
        if not isinstance(exceptions, list) or len(exceptions) != 1:
            raise OverlayError("placement blocked audit must contain one exception")
        self.blocked_group = dict(exceptions[0])
        if (
            self.blocked_group.get("chapter") != "ch1"
            or self.blocked_group.get("map_id") != "room_beach"
            or self.blocked_group.get("source_ref")
            != "rooms_render.json#room_beach/layers/0"
            or self.blocked_group.get("asset_id") != "ch1:spr_leaves_shaking"
        ):
            raise OverlayError("placement room_beach blocked diagnostic mismatch")

        omitted_path = self.root / "omitted-native-backgrounds.json"
        omitted = _json(omitted_path)
        if (
            omitted.get("format") != OMITTED_BACKGROUNDS_SCHEMA
            or omitted.get("omitted_count") != 11
        ):
            raise OverlayError("placement omitted-native background inventory mismatch")
        records = omitted.get("records")
        if not isinstance(records, list) or len(records) != 11:
            raise OverlayError("placement omitted-native record count mismatch")
        if any(
            not isinstance(item, dict) or item.get("correction_available") is not False
            for item in records
        ):
            raise OverlayError("placement omitted-native record is not blocked")
        self.omitted_records = [dict(item) for item in records]

    def _validate_record(self, source: Any, index: int) -> dict[str, Any]:
        if not isinstance(source, dict):
            raise OverlayError(f"placement record {index} must be an object")
        chapter = source.get("chapter")
        map_id = source.get("map_id")
        element_id = source.get("element_id")
        source_ref = source.get("source_ref")
        asset_id = source.get("asset_id")
        if (
            chapter not in CHAPTERS
            or not isinstance(map_id, str)
            or not map_id
            or not isinstance(element_id, str)
            or not element_id.startswith("bg:")
            or not isinstance(source_ref, str)
            or not source_ref.startswith(f"rooms_render.json#{map_id}/")
            or not isinstance(asset_id, str)
            or not asset_id.startswith(f"{chapter}:")
        ):
            raise OverlayError(f"placement record {index} identity invalid")
        if source.get("available") is not True or source.get("unsupported") != []:
            raise OverlayError(f"placement record unavailable: {element_id}")
        original = source.get("original")
        suggested = source.get("suggested")
        if not isinstance(original, dict) or not isinstance(suggested, dict):
            raise OverlayError(f"placement original/suggested missing: {element_id}")
        for field in ("x", "y", "scale_x", "scale_y", "rotation"):
            if not isinstance(original.get(field), (int, float)) or isinstance(
                original.get(field), bool
            ):
                raise OverlayError(f"placement original {field} invalid")
            if not isinstance(suggested.get(field), (int, float)) or isinstance(
                suggested.get(field), bool
            ):
                raise OverlayError(f"placement suggested {field} invalid")
        for field in ("scale_x", "scale_y", "rotation"):
            if not _same_number(original.get(field), suggested.get(field)):
                raise OverlayError(
                    f"placement changes non-position background field: {element_id}/{field}"
                )
        semantics = source.get("placement_semantics")
        if not isinstance(semantics, dict):
            raise OverlayError(f"placement semantics missing: {element_id}")
        render_png = semantics.get("render_png")
        if not isinstance(render_png, dict):
            raise OverlayError(f"placement render_png missing: {element_id}")
        path_base = render_png.get("path_base")
        relative = render_png.get("path")
        if not isinstance(relative, str) or not relative:
            raise OverlayError(f"placement render_png path invalid: {element_id}")
        if path_base == "overlay":
            png_path = _safe_child(
                self.a_root / "metadata-overlays" / "review-006-v1", relative
            )
        elif path_base == "official":
            png_path = self.a_index.resolve_file("official", relative)
        else:
            raise OverlayError(f"placement render_png path_base invalid: {element_id}")
        if not png_path.is_file() or file_sha256(png_path) != render_png.get("sha256"):
            raise OverlayError(f"placement render PNG hash mismatch: {element_id}")
        if png_dimensions(png_path) != (
            render_png.get("width"),
            render_png.get("height"),
        ):
            raise OverlayError(f"placement render PNG dimensions mismatch: {element_id}")
        record = dict(source)
        record["render_png_absolute"] = str(png_path)
        return record

    @staticmethod
    def _key(record: dict[str, Any]) -> str:
        return f"{record['chapter']}:{record['map_id']}:{record['element_id']}"

    @property
    def available(self) -> bool:
        return self.error is None


    def apply_source_import(self, scene_map: dict[str, Any]) -> dict[str, Any]:
        if not self.available:
            for element in scene_map.get("elements", []):
                if (
                    isinstance(element, dict)
                    and str(element.get("id", "")).startswith("bg:")
                ):
                    element["placement_blocked"] = True
                    element["placement_blocked_reason"] = (
                        self.error or "placement overlay unavailable"
                    )
            return {
                "applied": False,
                "status": "blocked",
                "changed_elements": [],
                "blocked_elements": [
                    element.get("id")
                    for element in scene_map.get("elements", [])
                    if isinstance(element, dict)
                    and element.get("placement_blocked") is True
                ],
                "error": self.error,
            }
        chapter = scene_map.get("chapter")
        map_id = scene_map.get("id")
        room_key = f"{chapter}:{map_id}"
        changed: list[str] = []
        blocked: list[str] = []
        skipped: list[str] = []
        elements = {
            element.get("id"): element
            for element in scene_map.get("elements", [])
            if isinstance(element, dict)
        }
        for record in self.records_by_room.get(room_key, []):
            element = elements.get(record["element_id"])
            if (
                element is None
                or element.get("asset") != record["asset_id"]
                or element.get("source_ref") != record["source_ref"]
                or not str(element.get("id", "")).startswith("bg:")
            ):
                if element is not None:
                    element["placement_blocked"] = True
                    element["placement_blocked_reason"] = (
                        "placement_source_identity_mismatch"
                    )
                    blocked.append(element.get("id"))
                continue
            if element.get("placement_default_applied") is True:
                skipped.append(element.get("id"))
                continue
            original = record["original"]
            if not all(
                _same_number(element.get(field), original.get(field))
                for field in ("x", "y", "scale_x", "scale_y", "rotation")
            ):
                element["placement_blocked"] = True
                element["placement_blocked_reason"] = (
                    "placement_original_coordinate_mismatch"
                )
                blocked.append(element.get("id"))
                continue
            suggested = record["suggested"]
            element["x"] = suggested["x"]
            element["y"] = suggested["y"]
            element["placement_default_applied"] = True
            element["placement_source"] = "a-review-008-v4"
            element["placement_source_ref"] = record["source_ref"]
            element["placement_overlay_sha256"] = self.manifest_sha256
            element.pop("placement_blocked", None)
            element.pop("placement_blocked_reason", None)
            if (
                record["placement_semantics"].get("placement_mode")
                == "review006_full_canvas"
            ):
                element["frame0_overlay"] = "review-candidate"
                element.pop("origin_quarantine", None)
                element.pop("origin_quarantine_reason", None)
                element.pop("frame0_overlay_blocked", None)
                element.pop("frame0_overlay_blocked_reason", None)
            changed.append(element.get("id"))

        if chapter == "ch1" and map_id == "room_beach":
            for element in elements.values():
                if (
                    element.get("asset") == self.blocked_group.get("asset_id")
                    and element.get("source_ref") == self.blocked_group.get("source_ref")
                ):
                    element["placement_blocked"] = True
                    element["placement_blocked_reason"] = (
                        "native_repeat_grid_blocked_room_beach"
                    )
                    blocked.append(element.get("id"))
        applied = len(blocked) == 0
        return {
            "applied": applied,
            "status": "review-candidate" if applied else "blocked",
            "changed_elements": changed,
            "blocked_elements": list(dict.fromkeys(blocked)),
            "preserved_elements": skipped,
            "omitted_count": len(self.omitted_records),
            "beach_blocked": chapter == "ch1" and map_id == "room_beach",
            "error": None if applied else "placement has blocked source elements",
        }
