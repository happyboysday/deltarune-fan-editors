"""Regression for qualified works with identical encounter, attack, and sprite names."""
import base64
import json
import os
import shutil
import sys
from pathlib import Path
from urllib.request import urlopen

STUDIO = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0, str(STUDIO))
from test_env import ARGS, DATA, require_data, require_path, run_test, test_process_env, work_dir
from battle_host import BattleHost, BattlePackageError


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False), encoding="utf-8")


def make_work(folder, name, seed, image):
    shutil.copytree(STUDIO / "examples/battle", folder)
    encounter = folder / "encounters/paper-guard.json"
    doc = json.loads(encounter.read_text("utf-8"))
    doc["meta"]["name"] = name
    doc["settings"]["partyLayout"] = {"x": 120 + seed, "feet": [206]}
    write(encounter, doc)
    attack = folder / "attacks/paper-guard-rain.json"
    doc = json.loads(attack.read_text("utf-8"))
    doc["settings"]["seed"] = seed
    doc["bulletTypes"]["fold"].update(sprite="shared-pixel", platform=True)
    doc["timeline"][0]["spawn"]["pathZ"] = str(seed)
    doc["timeline"].append({"id": "wind", "at": 0, "type": "soulDrift", "dx": 1, "dy": 0})
    write(attack, doc)
    dest = folder / "assets/custom/pixel.png"
    dest.parent.mkdir(parents=True)
    shutil.copyfile(image, dest)
    write(folder / "assets/custom.index.json", {"sprites": {"shared-pixel": {"frames": ["custom/pixel.png"]}}})


def main():
    engine = Path(ARGS[0]).resolve() if ARGS else DATA["battleRoot"]
    for relative in ("serve.py", "tools/export-game.mjs"):
        require_path(engine / relative, "battleRoot/" + relative)
    require_data("battleAssets/index.json")
    os.environ.update(test_process_env())
    exe = engine / "runtime/node/node.exe"
    node = str(exe) if exe.is_file() else shutil.which("node")
    temp = work_dir("dr-scene-library")
    work = Path(temp) / "workspace"
    library = Path(temp) / "library"
    host = BattleHost(engine, work, node, STUDIO, library)
    try:
        host.seed_example()
        refs = {}
        images = []
        for index, (name, face) in enumerate([("幕 A", "up"), ("幕-B", "down")], 1):
            image = STUDIO / ("studio/art/walker-" + face + "-0.png")
            make_work(library / name, name, index, image)
            images.append(image.read_bytes())
            refs[str(index)] = {"source": "project", "work": name, "encounter": "paper-guard"}
        assert images[0] != images[1], "Fixture sprites must be distinct"
        entries = host.catalogue()["entries"]
        assert all(any(row.items() >= ref.items() for row in entries) for ref in refs.values())
        urls = [host.open_editor(ref).split("/encounter.html")[0] for ref in refs.values()]
        assert urls[0] != urls[1]
        for i, url in enumerate(urls):
            with urlopen(url + "/assets/custom/pixel.png", timeout=5) as response:
                assert response.read() == images[i]
        refs.update(alias=refs["1"], original={"encounter": "paper-guard"})
        def bundle(**options):
            return json.loads(host.bundle(json.dumps(dict(battles=refs, **options)).encode()))
        pack = bundle(offline=True)
        by_id = pack["byId"]
        assert by_id["1"] == by_id["alias"] and len(set(by_id.values())) == 3
        assert pack["imports"]
        for i in (1, 2):
            entry = pack["entries"][by_id[str(i)]]
            attack = entry["attacks"]["paper-guard-rain"]
            assert attack["settings"]["seed"] == i
            assert attack["timeline"][0]["spawn"]["pathZ"] == str(i)
            assert attack["timeline"][-1]["type"] == "soulDrift"
            assert attack["settings"]["bossHud"]["widgets"] and entry["doc"]["settings"]["partyLayout"]["x"] == 120 + i
            embedded = entry["assets"]["sprites"]["shared-pixel"]["frames"][0].split(",")[1]
            assert base64.b64decode(embedded) == images[i-1]
        file = library / "幕-B/attacks/paper-guard-rain.json"
        attack = json.loads(file.read_text("utf-8"))
        attack["bulletTypes"]["fold"]["platform"] = "bad"
        write(file, attack)
        try:
            bundle(checkOnly=True)
        except BattlePackageError as error:
            assert any(i["path"] == "battles.2.encounter" and "fold.platform" in i["message"] for i in error.issues)
        else:
            raise AssertionError("The invalid attack was accepted")
    finally:
        host.close()
    print("Passed: separate work editors, same-name files, custom art, alias deduplication, offline bundle and attack diagnostics.")


if __name__ == "__main__":
    run_test(main)
