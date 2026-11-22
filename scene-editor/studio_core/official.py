"""Read A v8 catalogs, optional import profiles, and lazily cropped tiles."""
import hashlib
import re
import tempfile
from pathlib import Path
from urllib.parse import unquote

from PIL import Image

from .a_assets import AAssetIndex, AExportError
from .http import Response, safe_child
from .settings import path_status
from .origin_overlay import OriginAdmission, Frame0Overlay
from .placement_overlay import PlacementOverlay, CURRENT_PLACEMENT_CANDIDATE_SHA256
from .visibility_overlay import VisibilityOverlay


class ImportProfiles:
    def __init__(self, index):
        root = index.module_root
        overlays = root / "metadata-overlays"
        admission = root / "integration-admissions/review010-origin.json"
        if not admission.is_file() and index.export_root.parent.name == "exports":
            admission = root.parent.parent / "integration-admissions/review010-origin.json"
        self.origin = OriginAdmission(admission, index) if admission.is_file() else None
        frame = overlays / "review-006-v1/overlay.json"
        visibility = overlays / "review-007-v2/visibility-overlay.json"
        placement = overlays / "review-008-v4/placement-overlay.json"
        # Release profiles were admitted against the export's own official tree,
        # before V0.6 switched delivery to the separately configured library.
        delivery_root = index.roots["official"]
        index.roots["official"] = (root.parent.parent / "assets/official" if index.export_root.parent.name == "exports"
                                   else root / "profile-official")
        try:
            self.frame = Frame0Overlay(frame, index) if frame.is_file() else None
            self.visibility = VisibilityOverlay(visibility, index) if visibility.is_file() else None
            self.placement = PlacementOverlay(placement, index, pin_sha256=CURRENT_PLACEMENT_CANDIDATE_SHA256,
                review006_overlay_path=frame, review007_visibility_path=visibility) if placement.is_file() else None
        finally:
            index.roots["official"] = delivery_root

    def decorate_asset(self, asset):
        for profile in (self.origin, self.frame):
            if profile is not None:
                asset = profile.decorate_asset(asset)
        return asset

    def decorate_room_result(self, result):
        scene = result["map"]
        integration = result["integration"]
        for key, profile in (("origin_admission", self.origin), ("frame0_overlay", self.frame)):
            if profile is not None:
                integration[key] = profile.decorate_map(scene)
        placement = self.placement.apply_source_import(scene) if self.placement else {
            "applied": True, "status": "not-configured", "changed_elements": [], "blocked_elements": [], "error": None}
        visibility = (self.visibility.apply_initial_visibility(scene) if self.visibility else
                      VisibilityOverlay.mark_unavailable(scene, "visibility profile not configured"))
        integration.update(placement_overlay=placement, visibility_overlay=visibility)
        errors = [item["error"] for item in (visibility, placement) if not item["applied"]]
        scene["source_import_profile"] = {
            "format": "c-editor-source-import-profile/1", "status": "blocked" if errors else "applied",
            "error": "; ".join(errors) if errors else None,
            "visibility": {"applied": visibility["applied"], "status": visibility["status"],
                           "sha256": self.visibility.manifest_sha256 if self.visibility else None},
            "placement": {"applied": placement["applied"], "status": placement["status"],
                          "beach_blocked": placement.get("beach_blocked") is True,
                          "blocked_elements": list(placement.get("blocked_elements", [])),
                          "sha256": self.placement.manifest_sha256 if self.placement else None},
            "additions": {"configured": False, "applied": False, "status": "not-configured"},
        }
        if errors:
            scene["unsupported"] = list(dict.fromkeys([*scene.get("unsupported", []), "source_import_profile_blocked"]))
        scene["initial_import_profile_complete"] = True
        return result


class OfficialAssets:
    def __init__(self, export, official_root, data_root, workbench=None):
        self.root = official_root if path_status("officialRoot", official_root)[0] else None
        self.cache = data_root / ".v04-cache"
        self.index = self.profiles = None
        self.tiles = {}
        self.error = "未找到 A-export v8，请用 --a-export 指定目录"
        try:
            # Reuse the already loaded release profiles (including optional background additions).
            workbench_index = getattr(workbench, "a_export", None)
            if path_status("aExport", export)[0]:
                index = AAssetIndex(export, official_root)
                self.profiles = (workbench if workbench_index and workbench_index.export_root == export
                                 else ImportProfiles(index))
                self.index = index
            if self.index:
                self.tiles = {s["path"]: s for s in self.index.sprite_by_id.values()
                              if s.get("kind") == "tile_crop" and s.get("source_path_base") == "official"}
        except (OSError, ValueError, AExportError, KeyError, TypeError, AttributeError) as error:
            self.index = None
            self.error = f"A-export v8 读取失败：{error}"

    def tile(self, rel):
        record = self.tiles.get(rel)
        if not self.root or not record or not re.fullmatch(r"derived/tiles/ch[1-5]/[A-Za-z0-9_-]+/tile_\d{4}\.png", rel):
            return None
        source = safe_child(self.root, record["source_path"])
        if not source or not source.is_file():
            return None
        x, y, w, h = (int(record["source_rect"][k]) for k in ("x", "y", "width", "height"))
        stat = source.stat()
        key = hashlib.sha256(f"{source}:{stat.st_size}:{stat.st_mtime_ns}:{x},{y},{w},{h}".encode()).hexdigest()
        dest = self.cache / key / rel
        if not dest.is_file():
            dest.parent.mkdir(parents=True, exist_ok=True)
            with Image.open(source, formats=("PNG", "GIF", "JPEG", "WEBP")) as image:
                crop = image.convert("RGBA").crop((x, y, x+w, y+h))
            with tempfile.NamedTemporaryFile(dir=dest.parent, delete=False) as temp:
                pending = Path(temp.name)
            try:
                crop.save(pending, "PNG")
                pending.replace(dest)
            finally:
                pending.unlink(missing_ok=True)
        return dest

    def read(self, path, query):
        for prefix in ("/official/", "/a-files/official/"):
            if path.startswith(prefix):
                return Response.asset(safe_child(self.root, path[len(prefix):]) if self.root else None)
        if path.startswith("/frame0-preview/") and isinstance(self.profiles, ImportProfiles):
            overlay = self.profiles.frame
            return Response.asset(overlay.resolve_url_path(path[len("/frame0-preview/"):]) if overlay else None)
        if not (path == "/api/a/rooms" or path.startswith(("/api/a/rooms/", "/a-files/"))):
            return None
        if self.index is None:
            return Response.json(503, {"ok": False, "error": self.error})
        chapter = query.get("chapter", ["ch1"])[0]
        try:
            if path.startswith("/a-files/"):
                base, _, rel = unquote(path[len("/a-files/"):]).partition("/")
                if base != "exports" or not rel:
                    raise AExportError("A 文件不存在")
                file = self.index.resolve_file(base, rel)
                if base == "exports" and not file.is_file():
                    try:
                        file = self.tile(rel) or file
                    except (OSError, ValueError, KeyError, Image.DecompressionBombError):
                        pass  # The release reports a missing file when a tile cannot be cropped.
                return Response.asset(file)
            if path == "/api/a/rooms":
                rooms = []
                for row in self.index.room_catalog(chapter)["rooms"]:
                    room = {key: row.get(key) for key in ("id", "chapter", "name", "width", "height")}
                    room.update(map_available=isinstance(row.get("map"), str), sample=bool(row.get("sample")),
                                counts=row.get("counts", {}), unsupported=row.get("unsupported", []))
                    rooms.append(room)
                return Response.json(200, {"ok": True, "format": "editor-a-rooms/1", "export": self.index.version,
                    "chapter": chapter, "total": len(rooms), "mapped": sum(r["map_available"] for r in rooms), "rooms": rooms})
            room = self.index.load_room(chapter, unquote(path[len("/api/a/rooms/"):]))
            return Response.json(200, {**self.profiles.decorate_room_result(room), "ok": True})
        except AExportError as error:
            return Response.json(503 if path == "/api/a/rooms" else 404,
                {"ok": False, "error": "A 文件不存在" if path.startswith("/a-files/") else str(error)})
