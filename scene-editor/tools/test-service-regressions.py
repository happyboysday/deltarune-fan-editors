"""Exercise chapter, persistence and HTTP regressions using isolated local fixtures."""
import base64
import concurrent.futures
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time
import unittest
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import chapter_host as chapters
import studio_server as studio
from studio_core.registry_io import registry_write
from test_env import ARGS, work_dir


def put(path, contents):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(contents if isinstance(contents, bytes) else json.dumps(contents).encode())


def chapter(home, name="one"):
    put(home/"chapter.json", {"sourceSHA256": name})
    put(home/"edits.json", {"instances": {}, "scripts": {}})
    put(home/"index.json", {"rooms": [{"id": "r", "instances": [{"x": 0, "y": 0}]}], "scripts": []})


def until(predicate):
    end = time.monotonic() + 12
    while not predicate():
        if time.monotonic() > end:
            raise TimeoutError("等待测试同步点超时")
        time.sleep(.025)


def serve(folder, name, official):
    # Stop the first publisher at the actual atomic replace, after its revision check.
    replace = os.replace
    def gated_replace(src, dst):
        signal = folder/"pause"
        if name == "a" and signal.exists() and Path(dst).name == signal.read_text():
            (folder/"waiting").touch()
            until((folder/"release").exists)
        return replace(src, dst)

    read_bytes = Path.read_bytes
    def switched_read(path):
        raw = read_bytes(path)
        switch = folder/"switch"
        if switch.is_file() and path.name == "edits.json":
            replace(switch, path)
        return raw

    args = ["--port","0","--data",str(folder/"state"),"--official-root",str(official),
            "--assets",str(folder/"assets"),"--chapters",str(folder/"chapters"),"--node",shutil.which("node")]
    with patch.object(sys, "argv", ["studio_server.py", *args]), patch.object(os, "replace", gated_replace), \
         patch.object(Path, "read_bytes", switched_read), patch.object(studio.UiAssets, "_sounds", return_value=None), \
         patch.object(chapters.Chapter, "running", property(lambda ch: (folder/"playing").exists())):
        (folder/(name+".starting")).touch()
        studio.start(studio.arguments())


class ServiceTests(unittest.TestCase):
    def setUp(self):
        self.folder = work_dir("service-regression")
        self.official = self.folder/"official"
        (self.official/"sprites/ch1/all_sprites").mkdir(parents=True)
        self.home = self.folder/"chapters/ch5"
        chapter(self.home)

    def server(self, name="a", official=None):
        log = self.folder/(name+".log")
        with log.open("wb") as stream:
            proc = subprocess.Popen([sys.executable, "-B", "-X", "utf8", __file__, "--serve", str(self.folder),
                                     name, str(official or self.official)], stdout=stream, stderr=stream)
        def close():
            if proc.poll() is None:
                proc.terminate()
            proc.wait(5)
        self.addCleanup(close)
        import re
        def ready():
            output = log.read_text("utf8", errors="replace")
            if proc.poll() is not None:
                raise AssertionError(output)
            return re.search(r"http://127\.0\.0\.1:\d+/", output)
        until(ready)
        return ready()[0].rstrip("/")

    @staticmethod
    def request(origin, route, body=None, **headers):
        req = Request(origin+route, data=json.dumps(body).encode() if body is not None else None,
                      headers={"Content-Type":"application/json", **headers})
        try:
            response = urlopen(req, timeout=15)
        except HTTPError as error:
            response = error
        with response:
            data = response.read()
            if response.headers.get_content_type() == "application/json":
                data = json.loads(data)
            return response.status, data, response.headers

    def test_01_play_uses_only_verified_data_and_installed_runtime(self):
        game = self.folder/"game"
        put(game/"DELTARUNE.exe", b"installed runner")
        put(game/"chapter5_windows/library.dll", b"installed library")
        put(game/"mus/song.ogg", b"music")
        with patch.object(chapters,"GAME",game), patch.dict(os.environ,LOCALAPPDATA=str(self.folder)):
            ch = chapters.Chapter(5,self.home,workspace=self.folder/"work")
            put(self.home/"dependencies.json", ch.dependencies())
            packaged = self.home/"play/chapter5_windows"
            put(packaged/"data.win", b"sample image")
            put(packaged/"DELTARUNE.exe", b"package marker")
            put(packaged/"library.dll", b"package marker")
            put(ch.workspace/"play/chapter5_windows/obsolete", b"old marker")
            put(self.home/"build.json", {"buildKey":ch.build_key(),"buildSHA256":chapters.file_hash(packaged/"data.win")})
            def check_launch(argv, *, cwd, **kwargs):
                self.assertEqual(Path(argv[0]).read_bytes(), b"installed runner")
                self.assertEqual((cwd/"library.dll").read_bytes(), b"installed library")
                self.assertFalse((cwd/"obsolete").exists())
                self.assertEqual((cwd/"data.win").read_bytes(), b"sample image")
                raise InterruptedError("checked launch boundary")
            with patch.object(chapters,"companion",side_effect=lambda c:c.stage/"data.win"), \
                 patch.object(subprocess,"Popen",side_effect=check_launch) as launch:
                with self.assertRaisesRegex(InterruptedError, "checked launch"):
                    ch.launch()
                put(packaged/"data.win", b"changed")
                with self.assertRaisesRegex(ValueError, "校验|版本"):
                    ch.launch()
                self.assertEqual(launch.call_count, 1)

    def test_01_failed_rebuild_keeps_previous_generation(self):
        game = self.folder/"game"
        put(game/"DELTARUNE.exe",b"first runner")
        put(game/"mus/song.ogg",b"song")
        with patch.object(chapters,"GAME",game):
            ch = chapters.Chapter(5,self.home,workspace=self.folder/"work")
            put(self.home/"dependencies.json",ch.dependencies())
            def compile_image(original, script, work, output, prefix):
                put(output,b"compiled")
                put(work/"compiled.json",{})
            with patch.object(ch,"rebuild_input"), patch.object(chapters,"utmt",side_effect=compile_image):
                ch.build()
                stage = ch.stage
                report = (ch.workspace/"build.json").read_bytes()
                self.assertEqual((stage/"data.win").read_bytes(),b"compiled")
                put(game/"DELTARUNE.exe",b"second runner")
                put(self.home/"dependencies.json",{**ch.dependencies(),"mus/song.ogg":"0"*64})
                with self.assertRaises(ValueError):
                    ch.build()
                self.assertEqual(ch.stage,stage)
                self.assertEqual((stage/"DELTARUNE.exe").read_bytes(),b"first runner")
                self.assertEqual((ch.workspace/"build.json").read_bytes(),report)

    def test_02_assets_and_frames(self):
        export = self.folder/"assets/a-export"
        put(export/"manifest.json",{"format":"director-assets/1","contract":"director-map/1","roots":{"exports":"exports/v8"}})
        put(export/"chapters.json",{"format":"director-chapters/1","chapters":[]})
        put(export/"sprites.json",{"format":"director-sprites/1","sprites":[]})
        put(export/"rooms.json",{})
        put(export/"chapters/ch1/rooms.json",{})
        origin = self.server()
        for ext in ("html","svg","js","txt","png","json"):
            put(self.official/("sample."+ext), b"{}")
            put(export/("sample."+ext), b"{}")
        for prefix in ("/official/", "/a-files/official/", "/a-files/exports/"):
            for ext in ("html","svg","js","txt"):
                self.assertEqual(self.request(origin,prefix+"sample."+ext)[0],404)
            for ext in ("png","json"):
                status,_,headers = self.request(origin,prefix+"sample."+ext)
                self.assertEqual(status,200)
                self.assertIn("sandbox",headers["Content-Security-Policy"])
                self.assertEqual(headers["X-Content-Type-Options"],"nosniff")
            self.assertEqual(self.request(origin,prefix+"sample.png", Origin="https://example.invalid")[0],403)
        for route in ("/","/layout/","/studio/chapters.html","/studio/settings.html"):
            _,_,headers = self.request(origin,route)
            self.assertEqual(headers["X-Frame-Options"],"DENY")
            self.assertIn("frame-ancestors 'none'",headers["Content-Security-Policy"])
        invalid = self.folder/"invalid"
        put(invalid/"sample.png", b"marker")
        (export/"rooms.json").unlink()
        peer = self.server("b",invalid)
        (invalid/"sprites/ch1/all_sprites").mkdir(parents=True)
        self.assertEqual(self.request(peer,"/official/sample.png")[0],404)
        self.assertEqual(self.request(peer,"/a-files/exports/sample.png")[0],503)

    def race(self, route, name, first, second):
        a,b = self.server(),self.server("b")
        (self.folder/"pause").write_text(name)
        with concurrent.futures.ThreadPoolExecutor(2) as pool:
            left = pool.submit(self.request,a,route,first)
            try:
                until((self.folder/"waiting").exists)
                right = pool.submit(self.request,b,route,second)
                concurrent.futures.wait([right],timeout=1)
            finally:
                (self.folder/"release").touch()
        self.assertEqual([left.result()[0],right.result()[0]],[200,409])
        return a

    def test_05_scene_writers(self):
        p = json.loads((ROOT/"examples/echo-workshop.scene.json").read_bytes())
        route = "/api/studio/projects/race"
        a = self.race(route,"race.scene.json",{"project":p,"revision":None},
                      {"project":{**p,"title":"second"},"revision":None})
        self.assertEqual(self.request(a,route)[1]["project"],p)

    def test_05_chapter_writers(self):
        ch = chapters.Chapter(5,self.home,workspace=self.folder/"state/chapter-workspace/ch5")
        change = {"type":"instance","room":"r","slot":0,"x":1,"y":2,
                  "revision":ch.revision()}
        self.race("/api/studio/chapters/5/save","edits.json",change,{**change,"x":3})

    def test_05_chapter_read_snapshot(self):
        origin = self.server()
        raw = (self.home/"edits.json").read_bytes()
        put(self.folder/"switch", {"instances":{},"scripts":{"changed":"yes"}})
        result = self.request(origin,"/api/studio/chapters/5/edits")[1]
        self.assertEqual(result["edits"],json.loads(raw))
        self.assertEqual(result["revision"].split(":")[-1],hashlib.sha256(raw).hexdigest())

    def test_06_source_switch_and_legacy_migration(self):
        root = self.folder/"work"
        ch = chapters.Chapter(5,self.home,workspace=root)
        change = {"revision":ch.revision(),"type":"instance","room":"r","slot":0,"x":1,"y":2}
        ch.save(change)
        other = self.folder/"other"
        chapter(other,"two")
        switched = chapters.Chapter(5,other,workspace=root)
        self.assertFalse(switched.edits()["instances"])
        self.assertIn("来源",switched.edit_snapshot()["warning"])
        with self.assertRaisesRegex(ValueError,"重新载入"):
            switched.save(change)
        self.assertEqual(chapters.Chapter(5,self.home,workspace=root).edits(),ch.edits())
        legacy = self.folder/"legacy"
        put(legacy/"edits.json", ch.edits_path.read_bytes())
        unproven = chapters.Chapter(5,other,workspace=legacy)
        self.assertEqual(unproven.edits(),switched.edits())
        self.assertTrue((legacy/"edits.json").exists())
        self.assertIn("旧编辑",unproven.edit_snapshot()["warning"])
        put(legacy/"build.json",{"buildKey":chapters.Chapter(5,self.home).build_key()})
        migrated = chapters.Chapter(5,self.home,workspace=legacy)
        self.assertEqual(migrated.edits(),ch.edits())
        put(self.home/"chapter.json",{"sourceSHA256":"replacement"})
        with self.assertRaisesRegex(ValueError,"来源已在运行期间变更"):
            ch.edits()

    def test_07_settings_quarantine(self):
        origin = self.server()
        route = "/api/studio/settings"
        for value in (True,False):
            self.request(origin,route,{"settings":{"firstRunDone":value}})
        settings = self.folder/"state/settings.json"
        backup = settings.with_suffix(".json.bak").read_bytes()
        put(settings,b"{broken")
        result = self.request(origin,route,{"settings":{"firstRunDone":True}})[1]
        self.assertEqual(settings.with_suffix(".json.bak").read_bytes(),backup)
        self.assertIn("损坏",result["warning"] or "")
        self.assertEqual(next(settings.parent.glob("settings.json.corrupt-*")).read_bytes(),b"{broken")
        self.assertTrue(json.loads(settings.read_bytes())["firstRunDone"])

    def test_07_startup_honours_settings_lock(self):
        settings = self.folder/"state/settings.json"
        with concurrent.futures.ThreadPoolExecutor(1) as pool:
            with registry_write(settings.with_suffix(".json.lock")):
                put(settings,b"{incomplete")
                startup = pool.submit(self.server,"peer")
                until((self.folder/"peer.starting").exists)
                concurrent.futures.wait([startup],timeout=.5)
                self.assertTrue(settings.exists())
                put(settings,{"version":1,"firstRunDone":True})
            result = self.request(startup.result(),"/api/studio/settings")[1]
            self.assertIsNone(result["warning"])
            self.assertTrue(result["firstRunDone"])

    def test_12_official_only_animation(self):
        put(self.official/"animations/Kris/idle/spr_kris_plat_idle/frame_0.png", b"frame")
        origin = self.server()
        url = self.request(origin,"/api/studio/dungeon-animations")[1][0]["frames"][0]
        self.assertEqual(self.request(origin,url)[:2],(200,b"frame"))

    def test_15_registry_repair(self):
        origin = self.server()
        route = "/api/custom-assets"
        def upload(color):
            data = io.BytesIO()
            Image.new("RGB",(1,1),color).save(data,"PNG")
            return {"chapter":"ch1","name":color,"png_base64":base64.b64encode(data.getvalue()).decode()}
        good,bad = [self.request(origin,route,upload(c))[1]["asset"] for c in ("red","blue")]
        meta = self.folder/"state/user-assets/ch1"/(bad["sha256"]+".json")
        record = json.loads(meta.read_bytes())
        for field,value in (("name",None),("name",chr(0xd800)),("width",True),("height","1")):
            with self.subTest(field=field):
                put(meta,{**record,field:value})
                raw = meta.read_bytes()
                status,listing,_ = self.request(origin,route+"?chapter=ch1")
                self.assertEqual(status,200)
                self.assertEqual(listing["assets"],[good])
                self.assertIn(meta.name,listing["issues"][0]["file"])
                self.assertEqual(self.request(origin,route,upload("blue"))[1]["asset"],bad)
                self.assertIn(raw,[p.read_bytes() for p in meta.parent.glob(meta.name+".corrupt-*")])

    def test_19_restart_while_playing(self):
        origin = self.server()
        (self.folder/"playing").touch()
        status,body,_ = self.request(origin,"/api/studio/restart",{})
        self.assertEqual(status,409)
        self.assertIn("试玩",body["error"])
        self.assertEqual(self.request(origin,"/api/studio/settings")[0],200)
        (self.folder/"playing").unlink()
        self.assertEqual(self.request(origin,"/api/studio/restart",{})[0],202)


if __name__ == "__main__":
    if ARGS[:1] == ["--serve"]:
        serve(Path(ARGS[1]),ARGS[2],Path(ARGS[3]))
    else:
        unittest.main(argv=[sys.argv[0],*ARGS],verbosity=2)
