"""Local, allowlisted sources for the browser player's shared UI assets."""

import hashlib
import json
import os
import subprocess
import tempfile


class UiAssets:
    def __init__(self, root, battle_root, official_root, sprites_root=None, battle_assets=None, *, data_root=None):
        manifest = root / "studio" / "ui-assets.json"
        spec = json.loads(manifest.read_text("utf8"))
        self.files = {"manifest.json": (manifest, "application/json; charset=utf-8")}
        extracted = self._sounds(root, manifest, data_root or root.parent / "scene-studio-data")
        battle_assets = battle_assets or battle_root / "assets"
        sprites_root = sprites_root or root / "ui-sprites"

        for name in spec["fonts"]:
            for font in (name, name + "@zh"):
                for file, kind in (("glyphs.json", "application/json"), ("glyphs.png", "image/png")):
                    rel = f"fonts/{font}/{file}"
                    self._add(rel, kind, battle_assets, rel)

        for name, count in spec["sprites"].items():
            for i in range(count):
                rel = f"sprites/{name}/{i}.png"
                self._add(rel, "image/png", sprites_root, f"{name}/{i}.png")
                if rel not in self.files:
                    self._add(rel, "image/png", battle_assets, f"sprites-full/{name}/{i}.png")
                if i == 0 and rel not in self.files:
                    self._add(rel, "image/png", official_root, f"sprites/ch5/all_sprites/{name}.png")

        for name in spec["sounds"]:
            rel = f"sounds/{name}"
            for folder in (extracted, battle_assets / "audio" / "snd"):
                for ext, kind in ((".wav", "audio/wav"), (".ogg", "audio/ogg")):
                    if folder and rel not in self.files:
                        self._add(rel, kind, folder, name + ext)

    def _add(self, route, kind, folder, rel):
        folder = folder.resolve()
        try:
            path = (folder / rel).resolve()
            if path.is_relative_to(folder) and path.is_file():
                with path.open("rb"):
                    pass
                self.files[route] = (path, kind)
        except OSError:
            # Unreadable cache entries (e.g. left by another account) fall through to the next source.
            pass

    @staticmethod
    def _sounds(root, manifest, data_root):
        # The editor normally sits in DeltaruneWorks/src/<editor>; clones may sit deeper.
        works = next((p for p in root.parents if (p / "game" / "DELTARUNE").is_dir()), root.parent.parent)
        game = works / "game" / "DELTARUNE" / "chapter5_windows"
        data = game / "data.win"
        cli = works / "tools-external" / "utmt" / "UndertaleModCli.exe"
        script = root / "tools" / "export-ui-sounds.csx"
        if not data.is_file() or not cli.is_file():
            return None
        cache = (data_root / ".ui-cache" / "ui-sounds").resolve()
        if not cache.is_relative_to(data_root.resolve()):
            return None
        stamp = hashlib.sha256(manifest.read_bytes() + script.read_bytes())
        for path in (data, game / "audiogroup1.dat", game / "snd_dtrans_lw.ogg"):
            if path.is_file():
                info = path.stat()
                stamp.update(f"{path.name}:{info.st_size}:{info.st_mtime_ns}\n".encode())
        dest = cache / stamp.hexdigest()[:20]
        if dest.is_dir():
            return dest if dest.resolve() == dest else None
        try:
            cache.mkdir(parents=True, exist_ok=True)
            with tempfile.TemporaryDirectory(dir=cache) as temp:
                pending = cache / os.path.basename(temp) / "sounds"
                pending.mkdir()
                env = dict(os.environ, DIRECTOR_UI_MANIFEST=str(manifest), DIRECTOR_UI_SOUND_OUTPUT=str(pending))
                subprocess.run([str(cli), "load", str(data), "-s", str(script)], cwd=temp, env=env,
                               check=True, timeout=60, capture_output=True, stdin=subprocess.DEVNULL)
                try:
                    pending.rename(dest)
                except FileExistsError:
                    # Another server completed the same local export first.
                    pass
        except (OSError, subprocess.SubprocessError) as error:
            print(f"试玩 UI 音效提取失败，使用已有音效：{error}", flush=True)
            return None
        return dest if dest.resolve() == dest else None
