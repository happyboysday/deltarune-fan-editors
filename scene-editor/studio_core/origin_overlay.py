"""Hash-pinned origin admission and frame0 overlay readers."""

from __future__ import annotations

import hashlib
import json
import re
import struct
import urllib.parse
from pathlib import Path
from typing import Any

from .a_assets import AAssetIndex, AExportError


CHAPTERS = ("ch1", "ch2", "ch3", "ch4", "ch5")
ADMISSION_SCHEMA = "dqa-c-overlay-admission/1"
FORMAL_OVERLAY_SCHEMA = "director-frame0-overlay/1"
FRAME0_OVERLAY_ADMISSION_SCHEMA = "dqa-c-frame0-overlay-admission/1"
CURRENT_FRAME0_OVERLAY_SHA256 = (
    "d29a51d19bc703f5e6b1d5f464948ee972507e516dafc283cc2c380c3f981d00"
)
TRUSTED_FRAME0_OVERLAY_PINS = {
    CURRENT_FRAME0_OVERLAY_SHA256: "gpt-review007-external-pin"
}


class OverlayError(RuntimeError):
    """Overlay data cannot be admitted without guessing."""


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def png_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as handle:
        header = handle.read(24)
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
        raise OverlayError(f"invalid PNG: {path.name}")
    return struct.unpack(">II", header[16:24])


def _json(path: Path) -> Any:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise OverlayError(f"cannot read {path.name}: {error}") from error


def _safe_child(root: Path, relative: str) -> Path:
    decoded = urllib.parse.unquote(str(relative)).replace("\\", "/")
    if "\x00" in decoded or decoded.startswith("/"):
        raise OverlayError("overlay path must be relative")
    parts = [part for part in decoded.split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        raise OverlayError("overlay path cannot escape its root")
    root_resolved = root.resolve()
    candidate = root_resolved.joinpath(*parts).resolve()
    try:
        candidate.relative_to(root_resolved)
    except ValueError as error:
        raise OverlayError("overlay path resolves outside its root") from error
    return candidate


def _external_artifact_admission(
    admission_path: Path | None,
    manifest_path: Path,
    manifest_sha256: str,
    *,
    admission_schema: str,
    artifact_schema: str,
    trusted_pins: dict[str, str],
) -> dict[str, Any]:
    trusted_source = trusted_pins.get(manifest_sha256)
    if trusted_source is not None:
        return {
            "pin_source": trusted_source,
            "admission_path": None,
            "admission_sha256": None,
            "expected_counts": {},
        }
    if admission_path is None:
        raise OverlayError(
            f"artifact SHA-256 is not externally pinned: {manifest_sha256}"
        )
    resolved_admission = admission_path.resolve()
    if not resolved_admission.is_file():
        raise OverlayError(f"external artifact admission missing: {admission_path}")
    document = _json(resolved_admission)
    if document.get("schema") != admission_schema:
        raise OverlayError("external artifact admission schema mismatch")
    if document.get("status") != "conditionally_admitted":
        raise OverlayError("external artifact admission status is not conditional")
    if document.get("project_acceptance") is not False:
        raise OverlayError("external artifact admission cannot claim project acceptance")
    review = document.get("external_review")
    if (
        not isinstance(review, dict)
        or not isinstance(review.get("review_id"), str)
        or not review["review_id"]
        or not isinstance(review.get("reviewed_by"), str)
        or not review["reviewed_by"]
    ):
        raise OverlayError("external artifact admission review identity is missing")
    artifact = document.get("artifact")
    if not isinstance(artifact, dict) or artifact.get("schema") != artifact_schema:
        raise OverlayError("external artifact admission artifact schema mismatch")
    if artifact.get("sha256") != manifest_sha256:
        raise OverlayError("external artifact admission SHA-256 mismatch")
    declared_path = artifact.get("path")
    if not isinstance(declared_path, str) or not declared_path:
        raise OverlayError("external artifact admission path is missing")
    candidate = Path(declared_path)
    if not candidate.is_absolute():
        candidate = resolved_admission.parent / candidate
    if candidate.resolve() != manifest_path.resolve():
        raise OverlayError("external artifact admission path mismatch")
    expected_counts = artifact.get("counts")
    if expected_counts is not None and not isinstance(expected_counts, dict):
        raise OverlayError("external artifact admission counts must be an object")
    return {
        "pin_source": "external-admission",
        "admission_path": resolved_admission,
        "admission_sha256": file_sha256(resolved_admission),
        "expected_counts": expected_counts or {},
    }


class OriginAdmission:
    """The D-qa-approved additive origin allowlist."""

    def __init__(self, admission_path: Path, a_index: AAssetIndex):
        self.path = admission_path.resolve()
        self.a_index = a_index
        self.error: str | None = None
        self.records: dict[str, dict[str, Any]] = {}
        self.quarantine: dict[str, dict[str, Any]] = {}
        self.validated: dict[str, dict[str, Any]] = {}
        self.admission_sha256 = file_sha256(self.path)
        try:
            self._load()
        except OverlayError as error:
            self.error = str(error)
            self.records = {}
            self.quarantine = {}

    def _load(self) -> None:
        document = _json(self.path)
        if document.get("schema") != ADMISSION_SCHEMA:
            raise OverlayError("unsupported origin admission schema")
        if document.get("status") != "conditionally_admitted_add_only":
            raise OverlayError("origin admission is not add-only admitted")
        if document.get("project_acceptance") is not False:
            raise OverlayError("origin admission acceptance boundary is invalid")
        base = document.get("base_export", {})
        if file_sha256(self.a_index.export_root / "manifest.json") != base.get(
            "manifest_sha256"
        ):
            raise OverlayError("A v8 manifest hash mismatch")
        if file_sha256(self.a_index.export_root / "sprites.json") != base.get(
            "sprites_sha256"
        ):
            raise OverlayError("A v8 sprites hash mismatch")

        overlay = document.get("overlay", {})
        overlay_path = self.a_index.module_root / "metadata-prototypes/review-004-v1/verified-origin-supplement.json"
        if not overlay_path.is_file() or file_sha256(overlay_path) != overlay.get("sha256"):
            raise OverlayError("origin supplement hash mismatch")
        if overlay.get("format") != "director-sprite-metadata-supplement/1":
            raise OverlayError("origin supplement format mismatch")
        supplement = _json(overlay_path)
        if supplement.get("format") != overlay.get("format"):
            raise OverlayError("origin supplement internal format mismatch")
        records = supplement.get("records")
        if not isinstance(records, list) or len(records) != overlay.get("record_count"):
            raise OverlayError("origin supplement record count mismatch")
        source_locks = document.get("source_locks", {})
        expected_chapters = overlay.get("records_by_chapter", {})
        counts = {chapter: 0 for chapter in CHAPTERS}
        for index, record in enumerate(records):
            if not isinstance(record, dict):
                raise OverlayError(f"origin record {index} must be an object")
            chapter = record.get("chapter")
            name = record.get("name")
            if chapter not in CHAPTERS or not isinstance(name, str) or not name:
                raise OverlayError(f"origin record {index} chapter/name invalid")
            key = f"{chapter}:{name}"
            if key in self.records:
                raise OverlayError(f"duplicate origin key: {key}")
            if record.get("origin_verified") is not True:
                raise OverlayError(f"origin not verified: {key}")
            if record.get("png_dimensions_match") is not True:
                raise OverlayError(f"PNG dimensions not verified: {key}")
            if record.get("rejection_reason") is not None:
                raise OverlayError(f"origin record rejected: {key}")
            if record.get("a_exported_frame_count") != 1:
                raise OverlayError(f"exported frame count changed: {key}")
            for field, lock_group in (
                ("source_data_sha256", "source_data_sha256"),
                ("source_assets_json_sha256", "assets_json_sha256"),
                ("source_backgrounds_json_sha256", "backgrounds_json_sha256"),
            ):
                if record.get(field) != source_locks.get(lock_group, {}).get(chapter):
                    raise OverlayError(f"source lock mismatch for {key}: {field}")
            sprite = self.a_index.sprite_by_id.get(key)
            if not isinstance(sprite, dict) or sprite.get("kind") != "official_sprite":
                raise OverlayError(f"A sprite missing for origin key: {key}")
            counts[chapter] += 1
            self.records[key] = record
        if counts != expected_chapters:
            raise OverlayError("origin chapter record counts mismatch")

        quarantine = document.get("existing_verified_quarantine", {})
        diagnostics_path = self.a_index.module_root / "metadata-prototypes/review-004-v1/diagnostics.json"
        if (
            not diagnostics_path.is_file()
            or file_sha256(diagnostics_path) != quarantine.get("diagnostics_sha256")
        ):
            raise OverlayError("origin diagnostics hash mismatch")
        diagnostics = _json(diagnostics_path)
        mismatches = diagnostics.get("details", {}).get(
            "existing_verified_png_dimension_mismatches", []
        )
        if len(mismatches) != quarantine.get("dimension_conflict_count"):
            raise OverlayError("origin quarantine count mismatch")
        for item in mismatches:
            if not isinstance(item, dict):
                raise OverlayError("origin quarantine entry must be an object")
            key = f"{item.get('chapter')}:{item.get('name')}"
            if item.get("chapter") not in CHAPTERS or not item.get("name"):
                raise OverlayError("origin quarantine chapter/name invalid")
            if key in self.quarantine:
                raise OverlayError(f"duplicate origin quarantine: {key}")
            self.quarantine[key] = item

    @property
    def available(self) -> bool:
        return self.error is None


    def record_for(self, asset_id: str) -> dict[str, Any] | None:
        if not self.available or asset_id not in self.records:
            return None
        if asset_id in self.validated:
            return self.validated[asset_id]
        record = self.records[asset_id]
        sprite = self.a_index.sprite_by_id.get(asset_id)
        if not isinstance(sprite, dict):
            return None
        path_base = sprite.get("path_base")
        relative = sprite.get("path")
        if path_base not in ("official", "exports") or not isinstance(relative, str):
            return None
        path = self.a_index.resolve_file(path_base, relative)
        if not path.is_file():
            return None
        try:
            width, height = png_dimensions(path)
            sha = file_sha256(path)
        except (OSError, OverlayError):
            return None
        if (
            width != record.get("png_width")
            or height != record.get("png_height")
            or sha != record.get("png_sha256")
            or width != record.get("width")
            or height != record.get("height")
        ):
            return None
        verified = {
            "asset": asset_id,
            "origin_x": int(record["origin_x"]),
            "origin_y": int(record["origin_y"]),
            "width": int(record["width"]),
            "height": int(record["height"]),
            "png_sha256": sha,
            "native_frame_count": int(record["native_frame_count"]),
            "origin_source": "dqa-origin-admission-005",
        }
        self.validated[asset_id] = verified
        return verified

    def decorate_asset(self, payload: dict[str, Any]) -> dict[str, Any]:
        asset_id = payload.get("asset")
        if not isinstance(asset_id, str) or payload.get("kind") != "official_sprite":
            return payload
        if asset_id in self.quarantine:
            payload = dict(payload)
            payload.update(
                {
                    "origin_verified": False,
                    "origin_known": False,
                    "dimension_unverified": True,
                    "quarantine": True,
                    "quarantine_reason": (
                        "a_v8_png_native_dimension_conflict_without_frame0_overlay"
                    ),
                }
            )
            return payload
        verified = self.record_for(asset_id)
        if verified:
            payload = dict(payload)
            payload.update(
                {
                    "origin_x": verified["origin_x"],
                    "origin_y": verified["origin_y"],
                    "width": verified["width"],
                    "height": verified["height"],
                    "origin_verified": True,
                    "origin_known": True,
                    "origin_source": verified["origin_source"],
                    "native_frame_count": verified["native_frame_count"],
                    # A's single exported frame remains the only usable frame.
                    "frame_count": 1,
                    "frame_count_verified": False,
                }
            )
        return payload

    def decorate_map(self, scene_map: dict[str, Any]) -> dict[str, Any]:
        quarantine_elements = []
        promoted_elements = []
        for element in scene_map.get("elements", []):
            asset_id = element.get("asset")
            if not isinstance(asset_id, str):
                continue
            if asset_id in self.quarantine:
                element["origin_quarantine"] = True
                element["origin_quarantine_reason"] = (
                    "a_v8_png_native_dimension_conflict_without_frame0_overlay"
                )
                quarantine_elements.append(element.get("id"))
            elif self.record_for(asset_id):
                element["origin_admission"] = "dqa-origin-admission-005"
                promoted_elements.append(element.get("id"))
        if quarantine_elements:
            unsupported = scene_map.setdefault("unsupported", [])
            unsupported.append("origin_dimension_quarantine_without_admitted_frame0_overlay")
            scene_map["unsupported"] = list(dict.fromkeys(unsupported))
        scene_map["c_editor_origin_admission"] = {
            "admission": "dqa-origin-admission-005",
            "promoted_elements": promoted_elements,
            "quarantine_elements": quarantine_elements,
        }
        return {
            "promoted_elements": len(promoted_elements),
            "quarantined_elements": len(quarantine_elements),
        }


class Frame0Overlay:
    """Formal or review-only full-canvas frame0 overlay."""

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
        self.records: dict[str, dict[str, Any]] = {}
        self.validated: dict[str, dict[str, Any]] = {}
        self.skipped_records: list[dict[str, str]] = []
        self.error: str | None = None
        self.manifest_sha256: str | None = None
        self.interface_path: Path | None = None
        self.interface_sha256: str | None = None
        self.source_status: str | None = None
        self.totals: dict[str, Any] = {}
        self.frame_semantics: dict[str, Any] = {}
        self.coordinate_contract: dict[str, Any] = {}
        self.pin_source: str | None = None
        self.admission_sha256: str | None = None
        self.admission_expected_counts: dict[str, Any] = {}
        self.layout_impact_path: Path | None = None
        self.layout_impact_sha256: str | None = None
        self.reference_modes: dict[str, str] = {}
        self.reference_records: dict[str, dict[str, Any]] = {}
        self.blocked_background_assets: set[str] = set()
        self.allowed_instance_reference_count = 0
        self.blocked_background_reference_count = 0
        try:
            if not self.manifest_path.is_file():
                raise OverlayError(f"frame0 overlay file missing: {manifest_path}")
            self.manifest_sha256 = file_sha256(self.manifest_path)
            self._load_formal()
        except (OverlayError, OSError) as error:
            self.error = str(error)
            self.records = {}

    def _load_formal(self) -> None:
        interfaces = (
            self.root / "interface-review006.md",
            self.root.parent / "interface-review006.md",
            self.root.parent.parent / "interface-review006.md",
        )
        self.interface_path = next((path for path in interfaces if path.is_file()), None)
        if self.interface_path is None:
            raise OverlayError("interface-review006.md is required beside formal overlay")
        self.interface_sha256 = file_sha256(self.interface_path)
        admission = _external_artifact_admission(
            self.admission_path,
            self.manifest_path,
            self.manifest_sha256 or "",
            admission_schema=FRAME0_OVERLAY_ADMISSION_SCHEMA,
            artifact_schema=FORMAL_OVERLAY_SCHEMA,
            trusted_pins=TRUSTED_FRAME0_OVERLAY_PINS,
        )
        self.pin_source = admission["pin_source"]
        self.admission_sha256 = admission["admission_sha256"]
        self.admission_expected_counts = dict(admission["expected_counts"])
        document = _json(self.manifest_path)
        if document.get("format") != FORMAL_OVERLAY_SCHEMA:
            raise OverlayError("unsupported frame0 overlay schema")
        self.source_status = document.get("status")
        if not isinstance(self.source_status, str) or not self.source_status:
            raise OverlayError("frame0 overlay status is missing")

        locked = document.get("locked_inputs")
        if not isinstance(locked, dict):
            raise OverlayError("frame0 overlay locked_inputs must be an object")
        expected_export = f"exports/{self.a_index.version}"
        if str(locked.get("a_export", "")).replace("\\", "/").rstrip("/") != expected_export:
            raise OverlayError("frame0 overlay A export path mismatch")
        if (
            locked.get("a_manifest_sha256")
            != file_sha256(self.a_index.export_root / "manifest.json")
            or locked.get("a_sprites_sha256")
            != file_sha256(self.a_index.export_root / "sprites.json")
        ):
            raise OverlayError("frame0 overlay A v8 lock mismatch")

        self.frame_semantics = document.get("frame_semantics")
        if not isinstance(self.frame_semantics, dict):
            raise OverlayError("frame0 overlay frame_semantics must be an object")
        if (
            self.frame_semantics.get("source_frame") != 0
            or self.frame_semantics.get("a_exported_frame_count") != 1
            or self.frame_semantics.get("native_frame_count_preserved_separately")
            is not True
            or self.frame_semantics.get("frame_images_generated_by_ai") is not False
        ):
            raise OverlayError("frame0 overlay frame semantics violate frame0-only contract")

        self.coordinate_contract = document.get("coordinate_contract")
        if not isinstance(self.coordinate_contract, dict):
            raise OverlayError("frame0 overlay coordinate_contract must be an object")
        expected_coordinate_contract = {
            "native_origin_preserved": True,
            "map_x_y_rotation_scale_changed": False,
            "overlay_width_height": "native bounding / sprite logical dimensions",
            "cropped_origin_target_patch_used": False,
            "unverified_records_accepted": False,
        }
        for key, expected in expected_coordinate_contract.items():
            if self.coordinate_contract.get(key) != expected:
                raise OverlayError(
                    f"frame0 overlay coordinate contract mismatch: {key}"
                )

        self._load_locked_layout_impact(locked)

        totals = document.get("totals")
        if not isinstance(totals, dict):
            raise OverlayError("frame0 overlay totals must be an object")
        self.totals = dict(totals)
        assets = document.get("assets")
        if not isinstance(assets, list):
            raise OverlayError("frame0 overlay assets must be an array")
        if totals.get("requested") != len(assets):
            raise OverlayError("frame0 overlay requested total mismatch")
        if totals.get("available") != len(assets):
            raise OverlayError("frame0 overlay available total mismatch")
        if totals.get("unsupported") != 0:
            raise OverlayError("frame0 overlay reports unsupported assets")

        reference_count = 0
        for index, asset in enumerate(assets):
            reference_count += self._add_formal_record(asset, index)
        if totals.get("element_references_covered") != reference_count:
            raise OverlayError("frame0 overlay element reference total mismatch")
        room_count = totals.get("room_references_covered")
        if isinstance(room_count, bool) or not isinstance(room_count, int) or room_count <= 0:
            raise OverlayError("frame0 overlay room reference total invalid")
        for key, expected in self.admission_expected_counts.items():
            actual = {
                "record_count": len(self.records),
                "element_references_covered": totals.get("element_references_covered"),
                "room_references_covered": totals.get("room_references_covered"),
                "allowed_instance_references": self.allowed_instance_reference_count,
                "blocked_background_references": self.blocked_background_reference_count,
            }.get(key)
            if actual != expected:
                raise OverlayError(
                    f"external artifact admission count mismatch: {key}"
                )

    def _load_locked_layout_impact(self, locked: dict[str, Any]) -> None:
        a_root = self.a_index.module_root
        impact_path = (
            a_root
            / "metadata-prototypes"
            / "review-005-v4"
            / "verified-mismatch-map-impact.json"
        )
        if not impact_path.is_file():
            raise OverlayError("locked frame0 layout impact is missing")
        expected_sha256 = locked.get("review005_map_impact_sha256")
        actual_sha256 = file_sha256(impact_path)
        if not isinstance(expected_sha256, str) or actual_sha256 != expected_sha256:
            raise OverlayError("frame0 layout impact SHA-256 mismatch")
        document = _json(impact_path)
        references = document.get("references")
        if not isinstance(references, list):
            raise OverlayError("frame0 layout impact references must be an array")
        modes: dict[str, str] = {}
        records: dict[str, dict[str, Any]] = {}
        background_assets: set[str] = set()
        allowed_instances = 0
        blocked_backgrounds = 0
        for index, reference in enumerate(references):
            if not isinstance(reference, dict):
                raise OverlayError(f"frame0 layout reference {index} must be an object")
            room = reference.get("room")
            element_id = reference.get("element_id")
            layer = reference.get("layer")
            asset_id = reference.get("asset")
            if (
                not isinstance(room, str)
                or ":" not in room
                or not isinstance(element_id, str)
                or not element_id
                or not isinstance(layer, str)
                or not isinstance(asset_id, str)
            ):
                raise OverlayError(f"frame0 layout reference {index} is invalid")
            chapter, map_id = room.split(":", 1)
            if chapter not in CHAPTERS or not map_id:
                raise OverlayError(f"frame0 layout reference {index} room is invalid")
            key = f"{chapter}:{map_id}:{element_id}"
            if key in modes:
                raise OverlayError(f"duplicate frame0 layout reference: {key}")
            if layer.startswith("instances:"):
                mode = "instance"
                allowed_instances += 1
            elif layer.startswith("bg:"):
                mode = "background"
                blocked_backgrounds += 1
                background_assets.add(asset_id)
            else:
                raise OverlayError(f"unknown frame0 layout layer mode: {key}")
            modes[key] = mode
            records[key] = dict(reference)
        if self.manifest_sha256 == CURRENT_FRAME0_OVERLAY_SHA256 and (
            allowed_instances != 3626 or blocked_backgrounds != 10
        ):
            raise OverlayError("pinned frame0 layout split is not 3626 instances / 10 backgrounds")
        self.layout_impact_path = impact_path.resolve()
        self.layout_impact_sha256 = actual_sha256
        self.reference_modes = modes
        self.reference_records = records
        self.blocked_background_assets = background_assets
        self.allowed_instance_reference_count = allowed_instances
        self.blocked_background_reference_count = blocked_backgrounds



    def _add_formal_record(self, record: Any, index: int) -> int:
        if not isinstance(record, dict):
            raise OverlayError(f"overlay asset {index} must be an object")
        chapter = record.get("chapter")
        name = record.get("name")
        asset_id = record.get("asset_id")
        if chapter not in CHAPTERS or not isinstance(name, str) or not name:
            raise OverlayError(f"overlay asset {index} chapter/name invalid")
        if asset_id != f"{chapter}:{name}":
            raise OverlayError(f"cross-chapter overlay record: {asset_id}")
        if asset_id in self.records:
            raise OverlayError(f"duplicate overlay record: {asset_id}")
        if record.get("usable") is not True or record.get("unsupported") != []:
            raise OverlayError(f"overlay asset unavailable: {asset_id}")
        if record.get("a_export_frame_count") != 1:
            raise OverlayError(f"overlay export frame count changed: {asset_id}")

        source_sprite = self.a_index.sprite_by_id.get(asset_id)
        if (
            not isinstance(source_sprite, dict)
            or source_sprite.get("kind") != "official_sprite"
            or source_sprite.get("chapter") != chapter
            or source_sprite.get("name") != name
        ):
            raise OverlayError(f"overlay A sprite missing: {asset_id}")

        original = record.get("original_png")
        if not isinstance(original, dict) or original.get("path_base") != "official":
            raise OverlayError(f"overlay original_png invalid: {asset_id}")
        original_relative = original.get("path")
        if not isinstance(original_relative, str) or not original_relative:
            raise OverlayError(f"overlay original_png path invalid: {asset_id}")
        if (
            source_sprite.get("path_base") != original.get("path_base")
            or source_sprite.get("path") != original_relative
            or source_sprite.get("sha256") != original.get("sha256")
        ):
            raise OverlayError(f"overlay original PNG lock mismatch: {asset_id}")
        try:
            original_path = self.a_index.resolve_file("official", original_relative)
        except AExportError as error:
            raise OverlayError(f"overlay original PNG path invalid: {asset_id}") from error
        if not original_path.is_file():
            raise OverlayError(f"overlay original PNG missing: {asset_id}")
        if file_sha256(original_path) != original.get("sha256"):
            raise OverlayError(f"overlay original PNG hash mismatch: {asset_id}")
        original_dimensions = png_dimensions(original_path)
        if original_dimensions != (original.get("width"), original.get("height")):
            raise OverlayError(f"overlay original PNG dimensions mismatch: {asset_id}")

        source_data_sha256 = record.get("source_data_sha256")
        chapter_record = self.a_index.chapter_records.get(chapter, {})
        expected_source_data = chapter_record.get("data_win", {}).get("sha256")
        if not expected_source_data or source_data_sha256 != expected_source_data:
            raise OverlayError(f"overlay source data hash mismatch: {asset_id}")

        native = record.get("native")
        if not isinstance(native, dict):
            raise OverlayError(f"overlay native metadata missing: {asset_id}")
        for field in ("origin_x", "origin_y", "width", "height", "native_frame_count"):
            value = native.get(field)
            if isinstance(value, bool) or not isinstance(value, int):
                raise OverlayError(f"overlay native {field} invalid: {asset_id}")
        if native["width"] <= 0 or native["height"] <= 0:
            raise OverlayError(f"overlay native dimensions invalid: {asset_id}")
        if native["native_frame_count"] < 1:
            raise OverlayError(f"overlay native frame count invalid: {asset_id}")

        texture = record.get("texture_page_item")
        if not isinstance(texture, dict):
            raise OverlayError(f"overlay texture_page_item missing: {asset_id}")
        for field in (
            "source_x",
            "source_y",
            "source_width",
            "source_height",
            "target_x",
            "target_y",
            "target_width",
            "target_height",
            "bounding_width",
            "bounding_height",
        ):
            value = texture.get(field)
            if isinstance(value, bool) or not isinstance(value, int):
                raise OverlayError(f"overlay texture_page_item.{field} invalid: {asset_id}")
        if (
            texture["bounding_width"] != native["width"]
            or texture["bounding_height"] != native["height"]
        ):
            raise OverlayError(f"overlay bounding dimensions mismatch: {asset_id}")

        pixel_evidence = record.get("pixel_evidence")
        if not isinstance(pixel_evidence, dict):
            raise OverlayError(f"overlay pixel evidence missing: {asset_id}")
        for field in (
            "source_crop_equals_current_a_png",
            "canvas_target_region_equals_source_crop",
            "canvas_outside_target_transparent",
        ):
            if pixel_evidence.get(field) is not True:
                raise OverlayError(f"overlay pixel evidence failed: {asset_id}/{field}")

        crop_evidence = record.get("source_crop_evidence")
        if not isinstance(crop_evidence, dict) or crop_evidence.get("path_base") != "overlay":
            raise OverlayError(f"overlay source crop evidence invalid: {asset_id}")
        crop_path = _safe_child(self.root, str(crop_evidence.get("path", "")))
        if not crop_path.is_file():
            raise OverlayError(f"overlay source crop evidence missing: {asset_id}")

        overlay_png = record.get("overlay_png")
        if not isinstance(overlay_png, dict) or overlay_png.get("path_base") != "overlay":
            raise OverlayError(f"overlay_png invalid: {asset_id}")
        overlay_relative = overlay_png.get("path")
        if not isinstance(overlay_relative, str) or not overlay_relative:
            raise OverlayError(f"overlay_png path invalid: {asset_id}")
        overlay_path = _safe_child(self.root, overlay_relative)
        if not overlay_path.is_file():
            raise OverlayError(f"overlay PNG missing: {asset_id}")
        if file_sha256(overlay_path) != overlay_png.get("sha256"):
            raise OverlayError(f"overlay PNG hash mismatch: {asset_id}")
        overlay_dimensions = png_dimensions(overlay_path)
        if overlay_dimensions != (overlay_png.get("width"), overlay_png.get("height")):
            raise OverlayError(f"overlay PNG dimensions mismatch: {asset_id}")
        if overlay_dimensions != (native["width"], native["height"]):
            raise OverlayError(f"overlay PNG is not native full-canvas size: {asset_id}")
        if overlay_dimensions != (
            texture["bounding_width"],
            texture["bounding_height"],
        ):
            raise OverlayError(f"overlay PNG is not native bounding size: {asset_id}")

        map_usage = record.get("map_usage")
        if not isinstance(map_usage, dict):
            raise OverlayError(f"overlay map usage missing: {asset_id}")
        element_references = map_usage.get("element_reference_count")
        if (
            isinstance(element_references, bool)
            or not isinstance(element_references, int)
            or element_references < 0
        ):
            raise OverlayError(f"overlay element reference count invalid: {asset_id}")

        stored = {
            "chapter": chapter,
            "name": name,
            "asset_id": asset_id,
            "source_data_sha256": source_data_sha256,
            "native_origin_x": native["origin_x"],
            "native_origin_y": native["origin_y"],
            "native_width": native["width"],
            "native_height": native["height"],
            "native_frame_count": native["native_frame_count"],
            "coordinate_mode": "native_origin",
            "target_rect": {
                "x": texture["target_x"],
                "y": texture["target_y"],
                "width": texture["target_width"],
                "height": texture["target_height"],
            },
            "source_png_sha256": original["sha256"],
            "source_png_width": original["width"],
            "source_png_height": original["height"],
            "png_path": overlay_relative,
            "png_sha256": overlay_png["sha256"],
            "png_width": overlay_png["width"],
            "png_height": overlay_png["height"],
            "png_absolute": str(overlay_path),
            "map_usage": dict(map_usage),
            "pixel_evidence": dict(pixel_evidence),
            "availability": "available",
            "unsupported": [],
        }
        self.records[asset_id] = stored
        return element_references

    @property
    def available(self) -> bool:
        return self.error is None


    def decorate_asset(self, payload: dict[str, Any]) -> dict[str, Any]:
        asset_id = payload.get("asset")
        if not isinstance(asset_id, str) or asset_id not in self.records:
            return payload
        record = self.records[asset_id]
        payload = dict(payload)
        effective_origin_x = record["native_origin_x"]
        effective_origin_y = record["native_origin_y"]
        if record["coordinate_mode"] == "background_target_offset":
            effective_origin_x += record["target_rect"]["x"]
            effective_origin_y += record["target_rect"]["y"]
        payload.update(
            {
                "origin_x": effective_origin_x,
                "origin_y": effective_origin_y,
                "native_origin_x": record["native_origin_x"],
                "native_origin_y": record["native_origin_y"],
                "overlay_coordinate_mode": record["coordinate_mode"],
                "width": record["native_width"],
                "height": record["native_height"],
                "origin_verified": True,
                "origin_known": True,
                "origin_source": "a-review-006-frame0-overlay",
                "frame0_overlay": "review-candidate",
                "native_frame_count": record.get("native_frame_count"),
                "frame_count": 1,
                "frame_count_verified": False,
                "url": (
                    "/frame0-preview/"
                    + urllib.parse.quote(record["png_path"], safe="/")
                ),
            }
        )
        payload.pop("quarantine", None)
        payload.pop("quarantine_reason", None)
        payload.pop("dimension_unverified", None)
        return payload

    @staticmethod
    def _layout_reference_matches(
        element: dict[str, Any], reference: dict[str, Any]
    ) -> bool:
        if element.get("asset") != reference.get("asset"):
            return False
        if element.get("layer") != reference.get("layer"):
            return False
        for field in ("x", "y", "scale_x", "scale_y", "rotation"):
            actual = element.get(field)
            expected = reference.get(field)
            if (
                isinstance(actual, bool)
                or not isinstance(actual, (int, float))
                or isinstance(expected, bool)
                or not isinstance(expected, (int, float))
                or abs(float(actual) - float(expected)) > 1e-5
            ):
                return False
        return True

    def decorate_map(self, scene_map: dict[str, Any]) -> dict[str, Any]:
        fixed: list[str] = []
        blocked: list[str] = []
        chapter = scene_map.get("chapter")
        map_id = scene_map.get("id")
        for element in scene_map.get("elements", []):
            asset_id = element.get("asset")
            if not isinstance(asset_id, str) or asset_id not in self.records:
                continue
            element_id = element.get("id")
            key = f"{chapter}:{map_id}:{element_id}"
            mode = self.reference_modes.get(key)
            reference = self.reference_records.get(key)
            matched = (
                reference is not None
                and self._layout_reference_matches(element, reference)
            )
            if mode == "instance" and matched:
                element["frame0_overlay"] = "review-candidate"
                element["frame0_overlay_reference_mode"] = "instance"
                element.pop("origin_quarantine", None)
                element.pop("origin_quarantine_reason", None)
                element.pop("frame0_overlay_blocked", None)
                element.pop("frame0_overlay_blocked_reason", None)
                fixed.append(element_id)
                continue
            reason = (
                "background_layout_origin_unverified_review008"
                if mode == "background"
                else "overlay_reference_missing_or_mismatched_in_locked_layout_impact"
            )
            element["origin_quarantine"] = True
            element["origin_quarantine_reason"] = reason
            element["frame0_overlay_blocked"] = True
            element["frame0_overlay_blocked_reason"] = reason
            blocked.append(element_id)
        if not any(element.get("origin_quarantine") for element in scene_map.get("elements", [])):
            scene_map["unsupported"] = [
                item
                for item in scene_map.get("unsupported", [])
                if item != "origin_dimension_quarantine_without_admitted_frame0_overlay"
            ]
        elif blocked:
            scene_map["unsupported"] = list(
                dict.fromkeys(
                    list(scene_map.get("unsupported", []))
                    + ["frame0_background_layout_origin_unverified_review008"]
                )
            )
        scene_map["c_editor_frame0_overlay"] = {
            "schema": FORMAL_OVERLAY_SCHEMA,
            "status": "review-candidate",
            "fixed_elements": fixed,
            "blocked_elements": blocked,
        }
        return {
            "fixed_elements": len(fixed),
            "blocked_elements": len(blocked),
        }

    def resolve_url_path(self, relative: str) -> Path | None:
        decoded = urllib.parse.unquote(str(relative)).replace("\\", "/")
        for record in self.records.values():
            if record.get("png_path") == decoded:
                return Path(record["png_absolute"])
        return None
