"""User-owned PNGs and sequences with read-only legacy registries."""
import re

from .a_assets import AExportError, CHAPTERS
from .custom_assets import CustomAssets, CustomAssetError
from .http import Response
from .sequence_assets import SequenceAssets, SequenceAssetError, validate_animation_import_document


class Registries:
    def __init__(self, store, primary, fallbacks):
        self.primary = store(primary)
        roots = dict.fromkeys([primary, *(p for p in fallbacks if p.is_dir())])
        self.stores = [self.primary, *(store(p) for p in roots if p != primary)]

    def old_record(self, chapter, digest):
        # On a first local write, retain the original name and sequence aliases.
        for store in self.stores[1:]:
            try:
                return store._record(chapter, digest)
            except (CustomAssetError, SequenceAssetError):
                continue
        return None

    def listing(self, chapter, query, **options):
        return list({item["asset"]: item for store in reversed(self.stores)
                     for item in store.listing(chapter, query, **options)}.values())

    def lookup(self, method, *args):
        for store in self.stores:
            try:
                return getattr(store, method)(*args)
            except (CustomAssetError, SequenceAssetError) as error:
                last = error
        raise last


class AssetRoutes:
    def __init__(self, data, old_data, old_base, official):
        user = data / "user-assets"
        custom = [root / "legacy-user-assets" for root in old_data]
        animations = [root / "legacy-animations" for root in old_data]
        if old_base:
            custom.append(old_base / "user-assets")
            animations.append(old_base / "user-assets/animations")
        self.custom = Registries(CustomAssets, user, custom)
        self.animations = Registries(SequenceAssets, user / "animations", animations)
        self.official = official

    def read(self, path, query):
        chapter = query.get("chapter", ["ch1"])[0]
        needle = query.get("q", [""])[0]
        try:
            if path == "/api/custom-assets":
                issues = []
                rows = self.custom.listing(chapter, needle, issues=issues)
                return Response.json(200, {"ok": True, "assets": rows, "count": len(rows), "total": len(rows),
                                           **({"issues": issues} if issues else {})})
            if path == "/api/animations":
                try:
                    limit = max(1, min(500, int(query.get("limit", ["160"])[0])))
                except ValueError:
                    limit = 160
                rows = self.animations.listing(chapter, needle.strip())[:limit]
                return Response.json(200, {"ok": True, "format": "editor-animations/1", "chapter": chapter,
                    "assets": rows, "count": len(rows), "total": len(rows), "source": "pinned-sequence-module",
                    "editor_preview_only": True})
            if path.startswith(("/custom-assets/", "/animation-assets/")):
                custom = path.startswith("/custom-assets/")
                match = re.fullmatch(r"/(?:custom|animation)-assets/(ch[1-5])/([0-9a-f]{64})\.png", path)
                if not match:
                    return Response.json(404, {"ok": False, "error": "找不到自制素材" if custom else "找不到动画序列素材"})
                store = self.custom if custom else self.animations
                return Response(200, "image/png", store.lookup("image", *match.groups()))
        except CustomAssetError as error:
            return Response.json(400, {"ok": False, "error": str(error)})
        except SequenceAssetError as error:
            return Response.json(400, {"ok": False, "error": str(error), "code": "sequence_asset_invalid"})

    def write(self, path, body):
        try:
            if path == "/api/custom-assets":
                return Response.json(200, {"ok": True, "asset": self.custom.primary.upload(body, self.custom.old_record)})
            if path == "/api/animations/import":
                validate_animation_import_document(body)
                asset = self.animations.primary.import_sequence(body, self.animations.old_record)
                return Response.json(200, {"ok": True, "format": "director-animation-import-response/1",
                    "asset": asset, "automatic_launch": False, "automatic_send": False, "real_game_acceptance_verified": False})
            return self.resolve(body)
        except (CustomAssetError, SequenceAssetError) as error:
            code = "custom_asset_invalid" if isinstance(error, CustomAssetError) else "sequence_asset_invalid"
            return Response.json(400, {"ok": False, "error": str(error), "code": code, "request_may_have_been_submitted": False})
        except (AExportError, ValueError) as error:
            return Response.json(400, {"ok": False, "error": str(error)})

    def resolve(self, body):
        if not isinstance(body, dict) or not isinstance(body.get("ids"), list):
            raise ValueError("素材解析请求需要 ids 数组")
        ids = body["ids"]
        if len(ids) > 5000 or any(not isinstance(key, str) for key in ids):
            raise ValueError("ids 必须是最多 5000 个字符串")
        chapter = body.get("chapter")
        if chapter not in CHAPTERS:
            raise ValueError("素材解析请求需要 ch1 到 ch5 章节")
        index = self.official.index
        names = [key for key in ids if not key.startswith(("custom:", "animation:"))]
        if names and index is None:
            return Response.json(503, {"ok": False, "error": self.official.error})
        assets = index.assets_by_ids(chapter, names) if index else []
        for prefix, store in (("custom:", self.custom), ("animation:", self.animations)):
            for key in ids:
                if key.startswith(prefix):
                    assets.extend(store.lookup("resolve", chapter, [key]))
        profiles = self.official.profiles
        if profiles:
            additions = getattr(profiles, "background_additions", None)
            if additions:
                seen = {row["asset"] for row in assets}
                for key in ids:
                    if key not in seen and (item := additions.preview_asset(key, chapter=chapter)):
                        assets.append(item)
            assets = [profiles.decorate_asset(row) for row in assets]
        return Response.json(200, {"ok": True, "format": "editor-assets/1", "source": "A-assets/v1.2",
            "export": index.version if index else None, "chapter": chapter, "assets": assets})
