"""Hash-pinned initial visibility overlay for first-time A room imports."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from .a_assets import AAssetIndex
from .origin_overlay import (
    CHAPTERS,
    OverlayError,
    _external_artifact_admission,
    _json,
    file_sha256,
)


VISIBILITY_OVERLAY_SCHEMA = "director-visibility-overlay/1"
VISIBILITY_OVERLAY_ADMISSION_SCHEMA = "dqa-c-visibility-overlay-admission/1"
CURRENT_VISIBILITY_OVERLAY_SHA256 = (
    "49178b8ad5a3a2251e295188a86da7279827fcba4a7c075965c5dc7522ae559b"
)
TRUSTED_VISIBILITY_OVERLAY_PINS = {
    CURRENT_VISIBILITY_OVERLAY_SHA256: "review008-frozen-a-review007-v2-candidate"
}


def _same_number(actual: Any, expected: Any) -> bool:
    return (
        isinstance(actual, (int, float))
        and not isinstance(actual, bool)
        and isinstance(expected, (int, float))
        and not isinstance(expected, bool)
        and abs(float(actual) - float(expected)) <= 1e-5
    )


class VisibilityOverlay:
    """Apply native initial visibility only when an A room is first imported."""

    def __init__(
        self,
        manifest_path: Path,
        a_index: AAssetIndex,
        *,
        admission_path: Path | None = None,
    ):
        self.manifest_path = manifest_path.resolve()
        self.root = self.manifest_path.parent
        self.a_index = a_index
        self.admission_path = admission_path.resolve() if admission_path else None
        self.manifest_sha256: str | None = None
        self.admission_sha256: str | None = None
        self.pin_source: str | None = None
        self.source_status: str | None = None
        self.error: str | None = None
        self.records: dict[str, dict[str, Any]] = {}
        self.summary: dict[str, Any] = {}
        self.coordinate_contract: dict[str, Any] = {}
        self.visibility_policy: dict[str, Any] = {}
        self.admission_expected_counts: dict[str, Any] = {}
        self.effective_visible_count = 0
        self.effective_hidden_count = 0
        self.layer_suppressed_count = 0
        try:
            if not self.manifest_path.is_file():
                raise OverlayError(f"visibility overlay file missing: {manifest_path}")
            self.manifest_sha256 = file_sha256(self.manifest_path)
            admission = _external_artifact_admission(
                self.admission_path,
                self.manifest_path,
                self.manifest_sha256,
                admission_schema=VISIBILITY_OVERLAY_ADMISSION_SCHEMA,
                artifact_schema=VISIBILITY_OVERLAY_SCHEMA,
                trusted_pins=TRUSTED_VISIBILITY_OVERLAY_PINS,
            )
            self.pin_source = admission["pin_source"]
            self.admission_sha256 = admission["admission_sha256"]
            self.admission_expected_counts = dict(admission["expected_counts"])
            self._load()
        except (OverlayError, OSError) as error:
            self.error = str(error)
            self.records = {}

    def _load(self) -> None:
        document = _json(self.manifest_path)
        if document.get("format") != VISIBILITY_OVERLAY_SCHEMA:
            raise OverlayError("unsupported visibility overlay schema")
        self.source_status = document.get("status")
        if not isinstance(self.source_status, str) or not self.source_status:
            raise OverlayError("visibility overlay status is missing")
        locked = document.get("locked_inputs")
        if not isinstance(locked, dict):
            raise OverlayError("visibility overlay locked_inputs must be an object")
        if str(locked.get("a_export", "")).replace("\\", "/").rstrip("/") != (
            f"exports/{self.a_index.version}"
        ):
            raise OverlayError("visibility overlay A export path mismatch")
        expected_export_hashes = {
            "a_manifest_sha256": self.a_index.export_root / "manifest.json",
            "a_sprites_sha256": self.a_index.export_root / "sprites.json",
            "a_chapters_sha256": self.a_index.export_root / "chapters.json",
            "a_rooms_sha256": self.a_index.export_root / "rooms.json",
        }
        for field, path in expected_export_hashes.items():
            if not path.is_file() or locked.get(field) != file_sha256(path):
                raise OverlayError(f"visibility overlay lock mismatch: {field}")
        source_hashes = locked.get("source_data_win_sha256")
        native_hashes = locked.get("native_visibility_files")
        if not isinstance(source_hashes, dict) or not isinstance(native_hashes, dict):
            raise OverlayError("visibility overlay chapter locks are missing")
        for chapter in CHAPTERS:
            chapter_record = self.a_index.chapter_records.get(chapter, {})
            source_hash = chapter_record.get("data_win", {}).get("sha256")
            if not source_hash or source_hashes.get(chapter) != source_hash:
                raise OverlayError(f"visibility source lock mismatch: {chapter}")
            native_path = self.root / "native" / f"native-visibility-{chapter}.json"
            if (
                not native_path.is_file()
                or native_hashes.get(chapter) != file_sha256(native_path)
            ):
                raise OverlayError(f"native visibility lock mismatch: {chapter}")

        self.coordinate_contract = document.get("coordinate_contract")
        expected_coordinate_contract = {
            "map_element_id_is_join_key": True,
            "source_ref_preserved": True,
            "map_x_y_rotation_scale_changed": False,
            "source_elements_retained": True,
            "hidden_elements_remain_editable": True,
            "full_gml_reconstruction_attempted": False,
        }
        if not isinstance(self.coordinate_contract, dict):
            raise OverlayError("visibility coordinate contract must be an object")
        for key, expected in expected_coordinate_contract.items():
            if self.coordinate_contract.get(key) != expected:
                raise OverlayError(f"visibility coordinate contract mismatch: {key}")

        self.visibility_policy = document.get("visibility_policy")
        if (
            not isinstance(self.visibility_policy, dict)
            or self.visibility_policy.get("source")
            != "UndertaleGameObject.Visible"
            or self.visibility_policy.get("visible_true_with_custom_draw")
            != "record unsupported, keep visible"
        ):
            raise OverlayError("visibility policy is invalid")

        self.summary = document.get("summary")
        if not isinstance(self.summary, dict):
            raise OverlayError("visibility summary must be an object")
        expected_summary = {
            "instance_elements": 45337,
            "available": 45337,
            "unsupported": 0,
            "suggested_visible_false": 25945,
            "suggested_visible_true": 19392,
        }
        if self.manifest_sha256 == CURRENT_VISIBILITY_OVERLAY_SHA256:
            for key, expected in expected_summary.items():
                if self.summary.get(key) != expected:
                    raise OverlayError(f"pinned visibility summary mismatch: {key}")

        elements = document.get("elements")
        if not isinstance(elements, list):
            raise OverlayError("visibility elements must be an array")
        if len(elements) != self.summary.get("available"):
            raise OverlayError("visibility available count mismatch")
        for index, item in enumerate(elements):
            if not isinstance(item, dict):
                raise OverlayError(f"visibility element {index} must be an object")
            chapter = item.get("chapter")
            map_id = item.get("map_id")
            element_id = item.get("element_id")
            source_ref = item.get("source_ref")
            asset_id = item.get("asset_id")
            if (
                chapter not in CHAPTERS
                or not isinstance(map_id, str)
                or not map_id
                or not isinstance(element_id, str)
                or not element_id
                or not isinstance(source_ref, str)
                or not source_ref.startswith(
                    f"rooms_instances.json#{map_id}/inst/"
                )
                or not isinstance(asset_id, str)
                or not asset_id.startswith(f"{chapter}:")
            ):
                raise OverlayError(f"visibility element {index} identity is invalid")
            key = f"{chapter}:{map_id}:{element_id}"
            if key in self.records:
                raise OverlayError(f"duplicate visibility element: {key}")
            if (
                item.get("available") is not True
                or item.get("editable") is not True
                or not isinstance(item.get("unsupported"), list)
            ):
                raise OverlayError(f"visibility element unavailable: {key}")
            visible = item.get("suggested_initial_visible")
            native = item.get("native_instance")
            object_data = item.get("object")
            if (
                not isinstance(visible, bool)
                or not isinstance(native, dict)
                or not isinstance(object_data, dict)
                or object_data.get("initial_visible") is not visible
                or item.get("original_source_visible") is not visible
            ):
                raise OverlayError(f"visibility semantics invalid: {key}")
            for field in ("x", "y", "scale_x", "scale_y", "rotation", "layer_depth"):
                if not isinstance(native.get(field), (int, float)) or isinstance(
                    native.get(field), bool
                ):
                    raise OverlayError(f"visibility native field invalid: {key}/{field}")
            self.records[key] = dict(item)

        if self.manifest_sha256 == CURRENT_VISIBILITY_OVERLAY_SHA256:
            hidden = sum(
                1
                for item in self.records.values()
                if item["suggested_initial_visible"] is False
            )
            visible = sum(
                1
                for item in self.records.values()
                if item["suggested_initial_visible"] is True
            )
            if hidden != 25945 or visible != 19392:
                raise OverlayError("pinned visibility decisions mismatch")
        self.effective_visible_count = sum(
            1
            for item in self.records.values()
            if item["suggested_initial_visible"] is True
            and item["native_instance"].get("layer_visible") is True
        )
        self.layer_suppressed_count = sum(
            1
            for item in self.records.values()
            if item["suggested_initial_visible"] is True
            and item["native_instance"].get("layer_visible") is False
        )
        self.effective_hidden_count = (
            len(self.records) - self.effective_visible_count
        )
        if self.manifest_sha256 == CURRENT_VISIBILITY_OVERLAY_SHA256 and (
            self.effective_visible_count != 18506
            or self.effective_hidden_count != 26831
            or self.layer_suppressed_count != 886
        ):
            raise OverlayError("pinned effective visibility counts mismatch")
        for key, expected in self.admission_expected_counts.items():
            actual = {
                "record_count": len(self.records),
                "hidden_count": self.effective_hidden_count,
                "visible_count": self.effective_visible_count,
                "layer_suppressed_count": self.layer_suppressed_count,
            }.get(key)
            if actual != expected:
                raise OverlayError(
                    f"external visibility admission count mismatch: {key}"
                )

    @property
    def available(self) -> bool:
        return self.error is None


    @staticmethod
    def mark_unavailable(scene_map: dict[str, Any], reason: str) -> dict[str, Any]:
        unknown: list[str] = []
        for element in scene_map.get("elements", []):
            if not isinstance(element, dict):
                continue
            source_ref = element.get("source_ref")
            if not isinstance(source_ref, str) or not source_ref.startswith(
                "rooms_instances.json#"
            ):
                continue
            element["visibility_unknown"] = True
            element["visibility_unknown_reason"] = reason
            unknown.append(element.get("id"))
        scene_map["c_editor_visibility_overlay"] = {
            "schema": VISIBILITY_OVERLAY_SCHEMA,
            "status": "blocked",
            "application": "first-a-room-import-only",
            "hidden_elements": [],
            "visible_elements": [],
            "unknown_elements": unknown,
            "preserved_elements": [],
            "error": reason,
        }
        return {
            "applied": False,
            "status": "blocked",
            "hidden_elements": [],
            "visible_elements": [],
            "unknown_elements": unknown,
            "preserved_elements": [],
            "error": reason,
        }

    def apply_initial_visibility(self, scene_map: dict[str, Any]) -> dict[str, Any]:
        if not self.available:
            return self.mark_unavailable(
                scene_map, self.error or "visibility overlay unavailable"
            )
        chapter = scene_map.get("chapter")
        map_id = scene_map.get("id")
        layers = {
            layer.get("id"): layer
            for layer in scene_map.get("layers", [])
            if isinstance(layer, dict)
        }
        hidden: list[str] = []
        visible: list[str] = []
        unknown: list[str] = []
        preserved: list[str] = []
        for element in scene_map.get("elements", []):
            if not isinstance(element, dict):
                continue
            source_ref = element.get("source_ref")
            if not isinstance(source_ref, str) or not source_ref.startswith(
                "rooms_instances.json#"
            ):
                continue
            element_id = element.get("id")
            if element.get("visibility_default_applied") is True:
                preserved.append(element_id)
                continue
            key = f"{chapter}:{map_id}:{element_id}"
            record = self.records.get(key)
            reason = None
            if record is None:
                reason = "missing_from_visibility_overlay"
            elif (
                record.get("source_ref") != source_ref
                or record.get("asset_id") != element.get("asset")
            ):
                reason = "source_ref_or_asset_mismatch"
            else:
                native = record["native_instance"]
                layer_record = layers.get(element.get("layer"), {})
                layer_depth = element.get(
                    "source_depth",
                    layer_record.get("source_depth", layer_record.get("depth")),
                )
                for field, native_field in (
                    ("x", "x"),
                    ("y", "y"),
                    ("scale_x", "scale_x"),
                    ("scale_y", "scale_y"),
                    ("rotation", "rotation"),
                ):
                    if not _same_number(element.get(field), native.get(native_field)):
                        reason = f"native_{field}_mismatch"
                        break
                if reason is None and not _same_number(
                    layer_depth, native.get("layer_depth")
                ):
                    reason = "native_layer_depth_mismatch"
            if reason is not None:
                element["visibility_unknown"] = True
                element["visibility_unknown_reason"] = reason
                unknown.append(element_id)
                continue
            suggested_visible = bool(record["suggested_initial_visible"])
            layer_visible = bool(record["native_instance"].get("layer_visible"))
            initial_visible = suggested_visible and layer_visible
            element["visible"] = initial_visible
            element["visibility_default_applied"] = True
            element["visibility_source"] = "a-review-007-v2"
            element["visibility_source_ref"] = record["source_ref"]
            element["visibility_suggested_initial_visible"] = suggested_visible
            element["visibility_native_layer_visible"] = layer_visible
            element["visibility_effective_initial_visible"] = initial_visible
            element["visibility_reason"] = (
                record["reason"]
                if suggested_visible == initial_visible
                else "native_layer_hidden"
            )
            element["visibility_unsupported"] = list(record["unsupported"])
            element["visibility_unknown"] = False
            element.pop("visibility_unknown_reason", None)
            (visible if initial_visible else hidden).append(element_id)
        applied = len(unknown) == 0
        scene_map["c_editor_visibility_overlay"] = {
            "schema": VISIBILITY_OVERLAY_SCHEMA,
            "status": "review-candidate" if applied else "blocked",
            "application": "first-a-room-import-only",
            "hidden_elements": hidden,
            "visible_elements": visible,
            "unknown_elements": unknown,
            "preserved_elements": preserved,
        }
        return {
            "applied": applied,
            "status": "review-candidate" if applied else "blocked",
            "hidden_elements": hidden,
            "visible_elements": visible,
            "unknown_elements": unknown,
            "preserved_elements": preserved,
            "error": None if applied else "visibility overlay has unknown elements",
        }
