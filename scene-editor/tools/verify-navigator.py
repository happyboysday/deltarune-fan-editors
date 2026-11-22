"""Run real chapter navigation in a separate rehearsal and save namespace."""
import argparse, json, os, shutil, sys, time, uuid
from errno import EXDEV
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.dont_write_bytecode=True
sys.path.insert(0,str(ROOT))
from test_env import ARGS, DATA, require_data, require_path, run_test, test_process_env, work_dir
os.environ.update(test_process_env())
from chapter_host import Chapter, CLI, GAME
from chapter_navigation import companion

def link_or_copy(source, target):
    try:
        os.link(source, target)
    except OSError as error:
        if error.errno != EXDEV and getattr(error, "winerror", None) != 17:
            raise
        return shutil.copy2(source, target)
    return target

def verify(n,start,end,plot,timeout,report,party=False,choice=False,mode="target",expect=None,entry=0,video=None):
    source=require_data(f"chapters/ch{n}",f"chapters/ch{n}/build.json")[0]
    require_path(CLI,"DIRECTOR_UTMT")
    require_path(GAME/"DELTARUNE.exe","DIRECTOR_GAME/DELTARUNE.exe")
    require_path(source/f"play/chapter{n}_windows/data.win",f"chapters/ch{n}/play 的构建")
    # Generated files must be replaced, never overwritten through a source hard link.
    home=shutil.copytree(source,work_dir("nav-check")/source.name,copy_function=link_or_copy,
                         ignore=shutil.ignore_patterns("director-preview.win","nav-check-*"))
    ch=Chapter(n,home);companion(ch)
    ch.prefix="DirectorNavTest_"+uuid.uuid4().hex
    ch.previews=lambda:{start:dict(room=start,plot=plot,dark=party,second=2 if party else 0,third=0,entry=entry,platform=(start=="room_dw_cliff_dash_runner" and entry>0),flags={})}
    save=Path(os.environ["LOCALAPPDATA"])/(ch.prefix+"_preview")
    clip=None
    try:
        if video:
            from nav_demo_clip import Clip
            ffmpeg=shutil.which("ffmpeg") or require_path(DATA["battleRoot"]/"runtime/ffmpeg/ffmpeg.exe","FFmpeg")
            clip=Clip(video,ffmpeg,n)
        pid=ch.launch(True,start)
        with ch.lock:
            ch.navigator.start(dict(mode=mode,goals=end.split(","),firstChoice=choice))
        until=time.monotonic()+timeout;msg="";last=None
        while time.monotonic()<until:
            with ch.lock:
                nav=ch.navigator.view();state=ch.navigator.read("state")
                if state:last=state
            if nav["note"]!=msg:
                msg=nav["note"];print(n,nav["room"],msg,flush=True)
            if clip and state:clip.capture(ch,nav,state)
            if not nav["active"]:break
            time.sleep(.03 if clip else .15)
        with ch.lock:
            if ch.navigator.running:ch.navigator.stop("验收时限","timeout")
            record=ch.run_record()
            record["lastObserved"]=last
            if record["navigation"]["state"] not in ("arrived","explored"):
                record["lastGrid"]=ch.navigator.read("grid")
        print(n,json.dumps(record["navigation"],ensure_ascii=False),flush=True)
        if report:
            Path(report).write_text(json.dumps(record,ensure_ascii=False,indent=1),"utf8")
        assert record["navigation"]["state"]==(expect or "arrived")
        if not expect:
            targets=end.split(",");assert record["rooms"][-1][1]==targets[-1]
            visited=iter(record["navigation"]["visited"])
            assert all(any(room==target for room in visited) for target in targets)
        assert record["keys"] and set(record["inputSources"])=={"ai"}
    finally:
        with ch.lock:
            if ch.navigator.running:ch.navigator.stop()
            if ch.running:
                try:ch.window.close()
                except ValueError:pass
        if clip:clip.close()
        if ch.process:
            try:ch.process.wait(6)
            except __import__("subprocess").TimeoutExpired:ch.process.terminate();ch.process.wait(4)
        with ch.lock:ch.navigator.cleanup()
        # Only this generated uniquely named, originally nonexistent QA profile.
        if save.exists():
            assert save.parent==Path(os.environ["LOCALAPPDATA"]) and save.name.startswith("DirectorNavTest_")
            for f in save.iterdir():
                if f.is_file():f.unlink()
            save.rmdir()

def main():
    a=argparse.ArgumentParser()
    a.add_argument("chapter",type=int);a.add_argument("start");a.add_argument("end")
    a.add_argument("--plot",type=float,default=10);a.add_argument("--timeout",type=int,default=100)
    a.add_argument("--report");a.add_argument("--dark",action="store_true");a.add_argument("--choice",action="store_true")
    a.add_argument("--mode",default="target");a.add_argument("--expect")
    a.add_argument("--entry",type=int,default=0)
    a.add_argument("--video")
    v=a.parse_args(ARGS);verify(v.chapter,v.start,v.end,v.plot,v.timeout,v.report,v.dark,v.choice,v.mode,v.expect,v.entry,v.video)


if __name__=="__main__":
    run_test(main)

