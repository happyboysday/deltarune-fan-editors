"""Exercise the browser controls and native game using private project copies."""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time
import uuid

ROOT=pathlib.Path(__file__).resolve().parents[1]
sys.dont_write_bytecode=True
sys.path.insert(0,str(ROOT))
from test_env import ARGS, DATA, Skip, require_data, require_path, run_test, server_options, start_studio_server, test_process_env, work_dir


def serve():
    import studio_server as studio
    from chapter_host import Chapter as Base
    parser=argparse.ArgumentParser()
    parser.add_argument("mode")
    parser.add_argument("namespace")
    parser.add_argument("--port",type=int,required=True)
    parsed=parser.parse_args(ARGS)

    class LocalChapter(Base):
        def __init__(self,n,home,**kwargs):
            super().__init__(n,home,**kwargs);self.prefix=parsed.namespace+"_ch"+str(n)

    studio.Chapter=LocalChapter
    projects=DATA["projects"]
    studio.start(argparse.Namespace(**server_options(projects),port=parsed.port,node=shutil.which("node"),
        battle_works=projects.parent/"battles",open=False,chapter_ui=False))


def main():
    if ARGS and ARGS[0]=="serve":
        return serve()
    node=shutil.which("node")
    if node is None:
        raise Skip("缺少 Node.js")
    source=require_data("chapters/ch5","chapters/ch5/build.json","battleRoot/tools/agent/render.mjs")[0]
    env=test_process_env()
    os.environ.update(env)
    from chapter_host import Chapter, CLI, GAME
    from chapter_navigation import companion
    require_path(GAME/"DELTARUNE.exe","DIRECTOR_GAME/DELTARUNE.exe")
    require_path(CLI,"DIRECTOR_UTMT")
    ns="DirectorNavUITest_"+uuid.uuid4().hex
    work=work_dir("nav-ui")
    dst=shutil.copytree(source,work/"chapters/ch5",ignore=shutil.ignore_patterns("director-preview.win","nav-check-*"))
    companion(Chapter(5,dst))
    (dst/"previews.json").write_text(json.dumps({"room_krisroom":dict(name="自动导航验收",room="room_krisroom",
        plot=10,entry=0,dark=False,second=0,third=0,flags={})}),"utf8")
    origin,close=start_studio_server(command=[__file__,"serve",ns],chapters=dst.parent)
    try:
        subprocess.run([node,str(ROOT/"tools/verify-navigator-ui.mjs"),origin,str(work),str(DATA["battleRoot"]),
                        str(work/"自动跑图_工作台.png")],env=env,check=True,timeout=160)
    finally:
        time.sleep(1)
        close()
        profile=pathlib.Path(env["LOCALAPPDATA"])/(ns+"_ch5_preview")
        if profile.exists():
            assert profile.name.startswith("DirectorNavUITest_")
            for f in profile.iterdir():
                if f.is_file():f.unlink()
            profile.rmdir()


if __name__=="__main__":
    run_test(main)

