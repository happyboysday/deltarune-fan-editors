
"""Connect the studio to one existing battle editor installation and an authoring workspace."""
from __future__ import annotations

import importlib.util, json, os, re, subprocess, sys, threading
from pathlib import Path

WORK_NAME=re.compile(r"[\w-][\w .-]{0,79}\Z")

def valid_work_name(name):
    return (isinstance(name,str) and WORK_NAME.fullmatch(name) and not name.endswith((" ", "."))
            and not Path(name).is_reserved())

NAME=re.compile(r"[A-Za-z0-9_\-\u4e00-\u9fa5]{1,80}\Z")
class BattlePackageError(ValueError):
    def __init__(self, issues):
        self.issues=issues
        super().__init__(issues[0]["message"] if issues else "无法生成战斗资源")

class BattleHost:
    def __init__(self, root, works, node, studio_root, library=None):
        self.root=root.resolve()
        self.works=works.resolve()
        self.node=node
        self.studio_root=studio_root
        self.lock=threading.Lock()
        self.library=(library or self.root/"works").resolve()
        self.editors={}
        self.available=(self.root/"serve.py").is_file() and (self.root/"tools"/"export-game.mjs").is_file()

    def seed_example(self):
        sample=self.studio_root/"examples"/"battle"
        for folder in ("encounters","attacks"):
            target=self.works/folder
            target.mkdir(parents=True,exist_ok=True)
            for file in (sample/folder).glob("*.json"):
                try:
                    with (target/file.name).open("xb") as out:
                        out.write(file.read_bytes())
                except FileExistsError:
                    pass

    def project_dir(self, name):
        if not valid_work_name(name):
            raise ValueError("作品目录名无效")
        folder=(self.library/name).resolve()
        if not folder.is_relative_to(self.library) or not (folder/"encounters").is_dir():
            raise ValueError("找不到战斗作品目录："+name)
        return folder

    def catalogue(self):
        if not self.available:
            return {"available":False,"entries":[],"reason":"找不到战斗编辑器；请用 --battle-root 指定目录。"}
        rows=[]
        sources=[("workspace",self.works/"encounters",None),("sample",self.root/"samples"/"encounters",None)]
        if self.library.is_dir():
            for entry in sorted(self.library.iterdir()):
                if valid_work_name(entry.name) and (entry/"encounters").is_dir():
                    try:
                        work=self.project_dir(entry.name)
                    except (OSError,ValueError):
                        continue
                    sources.append(("project",work/"encounters",entry.name))
        for source,folder,work_name in sources:
            for file in sorted(folder.glob("*.json")):
                if file.name=="index.json" or not NAME.fullmatch(file.stem) or not file.is_file():
                    continue
                title=file.stem
                try:
                    doc=json.loads(file.read_text(encoding="utf-8-sig"))
                    name=doc.get("meta",{}).get("name",title)
                    if isinstance(name,dict):name=name.get("zh") or name.get("en")
                    if isinstance(name,str) and name.strip():title=name
                except (OSError,ValueError,TypeError,AttributeError):
                    pass
                row={"encounter":file.stem,"source":source,"title":title}
                if work_name is not None:row["work"]=work_name
                rows.append(row)
        return {"available":True,"entries":rows}

    def open_editor(self, ref):
        if not self.available:raise ValueError("未找到战斗编辑器")
        from urllib.parse import urlencode
        work=self.works
        if ref is None:query=""
        else:
            source=ref.get("source","workspace")
            encounter=ref.get("encounter","")
            if source=="project":work=self.project_dir(ref.get("work"))
            if source not in ("workspace","sample","project") or not isinstance(encounter,str) or not NAME.fullmatch(encounter):
                raise ValueError("战斗引用无效")
            query="?"+urlencode({"sample" if source=="sample" else "file":encounter})
        with self.lock:
            if work not in self.editors:
                path=self.root/"serve.py"
                spec=importlib.util.spec_from_file_location("_studio_battle_editor",path)
                module=importlib.util.module_from_spec(spec)
                sys.modules[spec.name]=module
                spec.loader.exec_module(module)
                module.NODE_BIN=self.node
                ffmpeg=self.root/"runtime"/"ffmpeg"
                if ffmpeg.is_dir() and str(ffmpeg) not in os.environ.get("PATH","").split(os.pathsep):os.environ["PATH"]=str(ffmpeg)+os.pathsep+os.environ.get("PATH","")
                app=module.AppState(self.root,works=work)
                class LoopbackBattleHandler(module.BattleEditorHandler):
                    def parse_request(self):
                        if not super().parse_request():
                            return False
                        origin=f"http://127.0.0.1:{self.server.server_port}"
                        if self.headers.get("Host")!=origin.removeprefix("http://") or self.headers.get("Origin",origin)!=origin:
                            self.send_error(403,"Loopback only")
                            return False
                        return True
                server=module.BattleEditorServer(("127.0.0.1",0),LoopbackBattleHandler,quiet=True,app=app)
                app.start()
                thread=threading.Thread(target=server.serve_forever,daemon=True)
                thread.start()
                self.editors[work]=(server,thread)
            port=self.editors[work][0].server_port
        return f"http://127.0.0.1:{port}/encounter.html"+query

    def bundle(self, data):
        if not self.available or not self.node:
            raise ValueError("战斗打包需要新版战斗编辑器和 Node.js")
        with self.lock:
            proc=subprocess.run([self.node,str(self.studio_root/"tools"/"battle-bundle.mjs"),str(self.root),str(self.works),str(self.library)],
                input=data,capture_output=True,timeout=180,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0))
        if proc.returncode:
            try:issues=json.loads(proc.stdout)["issues"]
            except (ValueError,KeyError):issues=[{"path":"battles","message":"战斗打包工具异常退出"}]
            raise BattlePackageError(issues)
        return proc.stdout

    def static(self, relative):
        target=(self.root/"engine"/relative).resolve()
        if not target.is_relative_to(self.root/"engine") or target.suffix!=".js" or not target.is_file():
            return None
        return target

    def close(self):
        with self.lock:
            for server,thread in self.editors.values():
                server.shutdown()
                server.server_close()
                thread.join()
            self.editors.clear()
