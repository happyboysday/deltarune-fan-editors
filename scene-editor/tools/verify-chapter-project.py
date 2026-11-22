"""Compare the exported chapter with a reopened build and exercise both edit paths."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
sys.path.insert(0,str(ROOT))
from test_env import ARGS, require_data, require_path, run_test, test_process_env, work_dir
os.environ.update(test_process_env())
from chapter_host import Chapter, CLI, GAME, TOOLS, atomic_json, read, utmt


def code_table(file, dest):
    env={**os.environ,"DIRECTOR_AUDIT":str(dest)}
    subprocess.run([str(CLI),"load",str(file),"-s",str(TOOLS/"chapter-audit.csx")],env=env,check=True,
                   capture_output=True,timeout=600)
    return read(dest)


def audit(ch):
    work=work_dir("chapter-audit")
    pristine=work/"original.win"
    ch.rebuild_input(pristine)
    runtime=ch.stage/"data.win"
    before=code_table(pristine,work/"before.json")
    after=code_table(runtime,work/"after.json")
    edits=ch.edits()
    reference_hash=None
    if not edits["instances"]:
        if edits["scripts"]:atomic_json(work/"reference-overrides.json",edits["scripts"])
        ref=work/"source-reference.win"
        utmt(ch.stock/"data.win","chapter-reference.csx",work,ref,ch.prefix)
        with ref.open("rb") as stream:
            reference_hash=hashlib.file_digest(stream,"sha256").hexdigest()
        with runtime.open("rb") as stream:
            assert hashlib.file_digest(stream,"sha256").hexdigest()==reference_hash,"complete image differs from the independently adapted game"
    dependencies=[(p,ch.stage/p.relative_to(ch.stock)) for p in ch.stock.rglob("*") if p.is_file() and p!=ch.stock/"data.win"]
    dependencies.extend((p,ch.stage.parent/"mus"/p.name) for p in (ch.stock.parent/"mus").iterdir() if p.is_file())
    dependencies.append((ch.stock.parent/"DELTARUNE.exe",ch.stage/"DELTARUNE.exe"))
    for left,right in dependencies:
        with left.open("rb") as a,right.open("rb") as b:
            assert hashlib.file_digest(a,"sha256").digest()==hashlib.file_digest(b,"sha256").digest(),right

    changed=set(edits["scripts"])
    boundary="gml_GlobalScript_scr_chapterswitch"
    changed.add(boundary)
    for k,checksum in before["scripts"].items():
        if k not in changed:assert after["scripts"][k]==checksum,k
    added=set(after["scripts"])-set(before["scripts"])
    assert added=={"gml_Object_obj_time_Step_2"},added
    assert before["initializers"]==after["initializers"]
    assert before["bindings"].keys()==after["bindings"].keys()
    for k,events in after["bindings"].items():
        if k=="obj_time":
            events=[e for e in events if e["code"] not in added]
        assert before["bindings"][k]==events,k
    out=work/"readback"
    out.mkdir()
    utmt(runtime,"chapter-read.csx",out)
    actual=read(out/"index.json")
    expected=ch.index
    for room in actual["rooms"]:
        for slot,i in enumerate(room["instances"]):
            key=room["id"]+"/"+str(slot)
            if key in edits["instances"]:
                pos=edits["instances"][key]
                assert all(i[k]==v for k,v in pos.items())
                src=next(r for r in expected["rooms"] if r["id"]==room["id"])["instances"][slot]
                i.update(x=src["x"],y=src["y"])
    assert actual["rooms"]==expected["rooms"]
    assert not actual["failed"],list(actual["failed"])[:3]
    clone=Chapter(ch.number,work/"edit-case")
    clone.home.mkdir()
    for name in ("index.json","edits.json","scripts.zip"):
        shutil.copy2(ch.home/name,clone.home/name)
    room_id,controller,old_gate,new_gate={
        5:("room_schooldoor","obj_room_schooldoor","global.plot < 590","global.plot < 589"),
        4:("room_town_krisyard_dark","obj_ch4_LWF04A","global.plot >= 310","global.plot >= 311"),
    }[ch.number]
    room=next(r for r in expected["rooms"] if r["id"]==room_id)
    target=room["instances"][0]
    clone.save({"revision":clone.revision(),"type":"instance","room":room["id"],"slot":0,"x":target["x"]+3,"y":target["y"]+2})
    key="gml_Object_"+controller+"_Create_0"
    initial=clone.source(key)
    assert initial.count(old_gate)==1,key
    clone.save({"revision":clone.revision(),"type":"script","id":key,"text":initial.replace(old_gate,new_gate)})
    atomic_json(clone.home/"build-edits.json",clone.edits())
    edited=work/"edited.win"
    utmt(pristine,"chapter-build.csx",clone.home,edited,ch.prefix+"_test")
    changed_dir=work/"edited-index"
    changed_dir.mkdir()
    utmt(edited,"chapter-read.csx",changed_dir)
    result=read(changed_dir/"index.json")
    position=next(r for r in result["rooms"] if r["id"]==room["id"])["instances"][0]
    assert position["x"]==target["x"]+3 and position["y"]==target["y"]+2
    with zipfile.ZipFile(changed_dir/"scripts.zip") as z:
        source=z.read(key+".gml").decode()
        assert new_gate in source and old_gate not in source,key
    report={"chapter":ch.number,"sourceSHA256":read(ch.home/"chapter.json")["sourceSHA256"],
            "buildSHA256":read(ch.home/"build.json")["buildSHA256"],
            "independentCompleteImageSHA256":reference_hash,"externalResourcesAndRunnerMatched":len(dependencies),
            "roomsReopened":len(actual["rooms"]),"placedInstances":sum(len(r["instances"]) for r in actual["rooms"]),
            "originalBytecodeProgramsChecked":len(before["scripts"])-len(changed),
            "globalInitializersInSameOrder":len(after["initializers"]),"objectEventTablesChecked":len(after["bindings"]),
            "addedObserver":sorted(added),"chapterMenuHandoff":boundary,"deliberateScriptOverrides":sorted(edits["scripts"]),
            "isolatedEditReadback":{"room":room["id"],"instance":target["id"],"x":position["x"],"y":position["y"],"script":key,"before":old_gate,"after":new_gate}}
    atomic_json(ch.home/"verification.json",report)
    return report


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument("chapter",type=int,choices=[5,4])
    n=parser.parse_args(ARGS).chapter
    source=require_data(f"chapters/ch{n}",f"chapters/ch{n}/index.json")[0]
    require_path(GAME/f"chapter{n}_windows/data.win","DIRECTOR_GAME/data.win")
    require_path(CLI,"DIRECTOR_UTMT")
    home=shutil.copytree(source,work_dir("verify-chapter-project")/source.name)
    print(audit(Chapter(n,home)))


if __name__=="__main__":
    run_test(main)

