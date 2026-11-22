from __future__ import annotations
import argparse, hashlib, json, mimetypes, os, re, shutil, subprocess, sys, tempfile, threading, urllib.parse, webbrowser
from pathlib import Path
# This also covers direct invocations without python -B.
sys.dont_write_bytecode = True

from studio_core.http import MIME, RequestError, Response, StudioHandler, StudioHTTPServer, safe_child
from studio_core.registry_io import registry_write
from studio_core.settings import Settings
from studio_core.capabilities import capabilities
from studio_core.official import OfficialAssets
from studio_core.user_assets import AssetRoutes
from battle_host import BattleHost, BattlePackageError
from chapter_host import Chapter, RevisionConflict, GAME, CLI
from ui_assets import UiAssets
from plugins_host import BUILTIN_IDS, PluginManager, UPLOAD_LIMIT, plugin_routes

ROOT=Path(__file__).resolve().parent
TRAILER_PREFIXES=("/ch6-trailer-assets/","/ch6-trailer-scenes/")
MAX_BYTES=24*1024*1024
ID=r"[A-Za-z0-9_-]{1,64}"
def read_json(file):
    return json.loads(file.read_text(encoding="utf-8-sig"))

def dungeon_animations(official_root):
    """Index chapter 5 side-view frames without copying source assets."""
    folders = sorted((official_root / "animations" / "Kris").glob("*/spr_kris_plat_*"))
    enemies = official_root / "enemy-animations" / "enemies"
    sprites = official_root / "sprites" / "ch5" / "all_sprites"
    if enemies.is_dir():
        folders.extend(folder for folder in sorted(enemies.iterdir())
                       if (sprites / (folder.name + ".png")).is_file())
    rows = []
    for folder in folders:
        frames = sorted(folder.glob("frame_*.png"))
        if frames:
            rows.append({"id": folder.name, "frames": [
                "/a-files/official/" + urllib.parse.quote(f.relative_to(official_root).as_posix())
                for f in frames]})
    return rows

def request_restart(chapters, restarting):
    for ch in chapters.values():
        if ch.running:
            return Response.json(409, {"ok":False,"error":f"第 {ch.number} 章正在试玩，请先关闭试玩窗口再重启。"})
    restarting.set()
    return Response.json(202, {"ok":True,"exitCode":3})

def start(args, extra_routes=()):
    settings=Settings(args,ROOT,BUILTIN_IDS)
    data=settings.data
    assets=settings.path("assets")
    battle_root=settings.path("battleRoot")
    battle_assets=settings.path("battleAssets")
    os.environ["DR_ASSETS"]=str(battle_assets)
    ch6_root=settings.path("ch6Assets")
    base=settings.path("base")
    projects=settings.path("projects")
    plugins=settings.path("plugins")
    export=settings.path("aExport")
    official_root=settings.path("officialRoot")
    port=settings.active["port"]["value"]
    data.mkdir(parents=True,exist_ok=True)
    try:
        projects.mkdir(parents=True,exist_ok=True)
    except OSError:
        settings.failures["projects"]="工程目录无法创建或读取"
    local_node=battle_root/"runtime"/"node"/"node.exe"
    node=args.node or (str(local_node.resolve()) if local_node.is_file() else shutil.which("node"))
    plugin_manager=PluginManager(plugins,node,settings)
    plugin_route=plugin_routes(plugins,node,plugin_manager)
    def plugin_provider(method,path,query,body,head_only):
        found=plugin_route(method,path,query,body,head_only)
        return None if found is None else Response(*found)
    extra_routes=(plugin_provider,*extra_routes)
    battles=BattleHost(battle_root,args.battle_works or data/"battle-workspace",node,ROOT,getattr(args,"battle_library",None))
    if args.battle_works is None:battles.seed_example()
    ui_assets=UiAssets(ROOT,battle_root,official_root,sprites_root=assets/"ui-sprites",
                       battle_assets=battle_assets,data_root=data)

    server=None
    layout_handler=object
    layout_html='<!doctype html><meta charset="utf-8"><title>布景工作台</title><p>布景工作台需要 V0.4。请在设置中配置目录，或用 --base 指定目录后重新启动。</p><a href="/">返回场景编辑器</a>'.encode()
    layout_js=None
    if base:
        from studio_core.layout import open_workbench
        try:
            server,layout_handler,layout_html,layout_js=open_workbench(base,port,data,official_root)
        except (SystemExit, ImportError, OSError, ValueError, RuntimeError, KeyError, TypeError) as ex:
            settings.failures["base"]=f"无法打开 V0.4 布景工作台：{ex}"
            base=None
    official=OfficialAssets(export,official_root,data,server)
    old_base=base
    if not old_base and export.parts[-5:]==("management","agents","A-assets","exports","v8"):
        old_base=export.parents[4]
    registries=AssetRoutes(data,[data,projects.parent,ROOT],old_base,official)
    ch6_mounted=settings.status("ch6Assets")[0]
    art_mounted=settings.status("assets")[0]
    # Room hints are official data; without the asset folder the hint panel is simply empty.
    hints={}
    for i in range(1,6):
        try:
            rows=read_json(assets/"official"/f"ch{i}.json")
            hints[f"ch{i}"]=rows if isinstance(rows,dict) else {}
        except (OSError, ValueError):
            hints[f"ch{i}"]={}
    def digest(data):return hashlib.sha256(data).hexdigest()
    chapters = {n: Chapter(n,(args.chapters or assets/"chapters").resolve()/f"ch{n}", workspace=data/"chapter-workspace"/f"ch{n}") for n in (5, 4)}
    trailer_root=settings.path("trailerRoot")
    trailer_routes=dict(zip(TRAILER_PREFIXES, (trailer_root/"assets",trailer_root/"scenes"))) if settings.status("trailerRoot")[0] else {}
    restarting=threading.Event()
    lifecycle=threading.Lock()
    class Handler(StudioHandler,layout_handler):
        def handle_read(self,parsed,head_only):
            path=parsed.path
            query=urllib.parse.parse_qs(parsed.query)
            if path=="/api/studio/settings":
                return self.send_json(200,{**settings.report(),"boundPort":self.server.server_port},head_only)
            if path=="/api/studio/settings/detect":
                return self.send_json(200,settings.detect(),head_only)
            if path=="/api/studio/capabilities":
                return self.send_json(200,capabilities(settings,official,chapters,GAME,CLI,node,hints),head_only)
            for read in (official.read,registries.read):
                response=read(path,query)
                if response is not None:return self.send_result(response,head_only)
            try:
                if path in {"/layout","/layout/"}:return self.send_bytes(layout_html,MIME[".html"],head_only)
                if path=="/js/editor.js" and layout_js:return self.send_bytes(layout_js,MIME[".js"],head_only)
                if path in {"/","/studio/index.html"}:
                    page=(ROOT/"studio"/"index.html").read_bytes()
                    if base:page=page.replace(b'id="layoutLink" hidden',b'id="layoutLink"')
                    return self.send_bytes(page,MIME[".html"],head_only)
                if path.startswith("/ui-assets/"):
                    entry=ui_assets.files.get(urllib.parse.unquote(path[len("/ui-assets/"):]))
                    if entry is not None:
                        file,kind=entry
                        return self.send_bytes(file.read_bytes(),kind,head_only)
                for prefix,directory in trailer_routes.items():
                    if not path.startswith(prefix):continue
                    file=safe_child(directory,path[len(prefix):])
                    if file is None or not file.is_file():break
                    if prefix=="/ch6-trailer-scenes/":
                        if file.name.lower().endswith(".scene.json"):
                            return self.send_bytes(file.read_bytes(),"application/json; charset=utf-8",head_only)
                    else:
                        return self.send_result(Response.asset(file),head_only)
                    break
                if path.startswith("/ch6-assets/"):
                    file=safe_child(ch6_root,path[len("/ch6-assets/"):]) if ch6_mounted else None
                    return self.send_result(Response.asset(file),head_only)
                if path.startswith("/studio/"):
                    file=safe_child(ROOT/"studio",path[len("/studio/"):])
                    if (file is None or not file.is_file()) and path.startswith("/studio/art/"):
                        file=safe_child(assets/"art",path[len("/studio/art/"):]) if art_mounted else None
                        return self.send_result(Response.asset(file),head_only)
                    if file is not None and file.is_file() and (file.suffix.lower() in {".mjs",".js",".css",".html",".png",".webp",".svg"} or file.name=="plugin.json"):
                        return self.send_bytes(file.read_bytes(),MIME.get(file.suffix,mimetypes.guess_type(file.name)[0]),head_only)
                if path.startswith("/battle-engine/"):
                    file=battles.static(urllib.parse.unquote(path[len("/battle-engine/"):]))
                    if file:return self.send_bytes(file.read_bytes(),MIME[".js"],head_only)
                chapter_route = re.fullmatch(r"/api/studio/chapters/([45])/(index|script|edits|route|record|frame|navigator)",path)
                if chapter_route:
                    ch=chapters[int(chapter_route[1])]
                    action=chapter_route[2]
                    if action=="navigator":
                        with ch.lock:return self.send_json(200,ch.navigator.view(),head_only)
                    if action=="record":return self.send_json(200,ch.run_record(),head_only)
                    if action=="frame":
                        if not ch.running or not ch.window:return self.send_json(409,{"error":"本次试玩尚未启动或已结束"},head_only)
                        try:return self.send_bytes(ch.window.frame(),"image/png",head_only)
                        except ValueError as ex:return self.send_json(409,{"error":str(ex)},head_only)
                    if action=="index":return self.send_json(200,{**ch.index,"previews":ch.previews()},head_only)
                    if action=="edits":return self.send_json(200,ch.edit_snapshot(),head_only)
                    if action=="route":
                        route=Path(os.environ["LOCALAPPDATA"])/ch.route_prefix/"director-route.tsv"
                        return self.send_json(200,{"running":ch.running,"pid":ch.process.pid if ch.running else None,"preview":ch.preview_room,"nextChapter":ch.next_chapter,"log":route.read_text("utf8")[-48000:] if route.is_file() else ""},head_only)
                    key=urllib.parse.parse_qs(parsed.query).get("id",[""])[0]
                    if key not in ch.index["scripts"]:return self.send_json(404,{"error":"未找到脚本"},head_only)
                    return self.send_json(200,{"source":ch.source(key)},head_only)
                if path=="/api/studio/example-dungeon":
                    return self.send_bytes((ROOT/"examples"/"dungeon-demo.scene.json").read_bytes(),"application/json; charset=utf-8",head_only)
                if path=="/api/studio/example-chapter5":
                    file=assets/"chapter5"/"chapter5.scene.json"
                    if file.is_file():return self.send_bytes(file.read_bytes(),"application/json; charset=utf-8",head_only)
                layout=re.fullmatch(r"/api/studio/layout/("+ID+r")",path)
                if layout:
                    file=assets/"chapter5"/"layouts"/(layout[1]+".json")
                    if file.is_file():return self.send_bytes(file.read_bytes(),"application/json; charset=utf-8",head_only)
                if path=="/api/studio/battles":
                    return self.send_json(200,battles.catalogue(),head_only)
                if path=="/api/studio/example-campaign":
                    return self.send_bytes((ROOT/"examples"/"ember-relay.scene.json").read_bytes(),"application/json; charset=utf-8",head_only)
                if path=="/api/studio/example-battle":
                    return self.send_bytes((ROOT/"examples"/"paper-gate.scene.json").read_bytes(),"application/json; charset=utf-8",head_only)
                if path=="/api/studio/dungeon-animations":
                    return self.send_json(200,dungeon_animations(official.root) if official.root else [],head_only)
                if path=="/api/studio/official":
                    query=urllib.parse.parse_qs(parsed.query)
                    chapter=query.get("chapter",[""])[0];room=query.get("room",[""])[0]
                    if chapter not in hints:return self.send_json(400,{"error":"章 ID 应为 ch1–ch5"},head_only)
                    if room:return self.send_json(200,{"candidates":hints[chapter].get(room,[])},head_only)
                    return self.send_json(200,{"rooms":[{"id":k,"count":len(v)} for k,v in hints[chapter].items()]},head_only)
                if path=="/api/studio/projects":
                    return self.send_json(200,{"projects":sorted(p.name[:-11] for p in projects.glob("*.scene.json") if re.fullmatch(ID,p.name[:-11]))},head_only)
                if path=="/api/studio/example":
                    return self.send_bytes((ROOT/"examples"/"echo-workshop.scene.json").read_bytes(),"application/json; charset=utf-8",head_only)
                match=re.fullmatch(r"/api/studio/projects/("+ID+r")",path)
                if match:
                    file=projects/(match[1]+".scene.json")
                    if file.is_file():
                        data=file.read_bytes()
                        return self.send_json(200,{"project":json.loads(data),"revision":digest(data)},head_only)
            except RevisionConflict as ex:
                return self.send_json(409,{"error":str(ex)},head_only)
            except (OSError,ValueError) as ex:
                return self.send_json(400,{"error":str(ex)},head_only)
            if base and (path in {"/styles.css","/api/assets","/api/a/status","/api/scenes","/api/health",
                                  "/api/runtime/status","/api/runtime/chapters","/api/runtime/state"}
                         or path.startswith(("/js/","/app/","/mock/","/api/scenes/","/frame0-preview/","/review012-bg-preview/"))):
                return self.workbench_read(head_only)
            if path=="/favicon.ico":return self.send_result(Response(204,"image/x-icon",b""),head_only)
            return self.extra_route(parsed,head_only)

        def require_action_body(self):
            if not isinstance(self.json_body(4096),dict):
                raise RequestError(400,"请求体必须是 JSON 对象")

        def handle_write(self,parsed):
            path=parsed.path
            if restarting.is_set():
                return self.send_json(503,{"error":"服务正在重启"})
            if path=="/api/studio/settings":
                return self.send_result(settings.update(self.json_body(1024*1024)))
            if path=="/api/studio/restart":
                self.require_action_body()
                with settings.lock, lifecycle:
                    result=request_restart(chapters,restarting)
                self.send_result(result)
                if result.status==202:self.server.shutdown()
                return
            if path=="/api/studio/plugins/install":
                return self.send_result(plugin_manager.install(self.json_body(UPLOAD_LIMIT)))
            if path=="/api/studio/plugin-projects":
                return self.send_result(plugin_manager.track(self.json_body(64*1024)))
            manage=re.fullmatch(r"/api/studio/plugins/([a-z][a-z0-9-]{0,63})/(enable|disable|uninstall)",path)
            if manage:
                self.require_action_body()
                return self.send_result(plugin_manager.manage(*manage.groups()))
            if path.startswith("/api/runtime/"):
                return self.send_json(403,{"error":"GameMaker 同步请使用原 V0.4 专用实例"})
            if path in {"/api/assets/resolve","/api/custom-assets","/api/animations/import"}:
                limit=(48 if path=="/api/animations/import" else 16)*1024*1024
                return self.send_result(registries.write(path,self.json_body(limit)))
            if base and path=="/api/scenes/save":return self.workbench_write()
            chapter_route=re.fullmatch(r"/api/studio/chapters/([45])/(save|build|play|keys|close|navigator)",path)
            if chapter_route:
                change=self.json_body(4*1024*1024)
                try:
                    ch=chapters[int(chapter_route[1])]
                    action=chapter_route[2]
                    if action=="save":result={"revision":ch.save(change)}
                    elif action=="build":result=ch.build()
                    elif action=="play":
                        with lifecycle:
                            if restarting.is_set():return self.send_json(503,{"error":"服务正在重启"})
                            result={"pid":ch.launch(embed=change.get("embed") is True,preview=change.get("preview"))}
                    else:
                        with ch.lock:
                            if not ch.running or not ch.window or change.get("pid")!=ch.process.pid:
                                raise ValueError("试玩窗口已变更")
                            if action=="navigator":
                                if change.get("command")=="start":result=ch.navigator.start(change)
                                elif change.get("command")=="stop":result=ch.navigator.stop()
                                elif change.get("command")=="resume":result=ch.navigator.resume(change)
                                else:raise ValueError("未知跑图操作")
                            else:
                                if action=="keys":ch.accept_keys(change["serial"],change["keys"])
                                else:
                                    if ch.navigator.running:ch.navigator.stop("试玩已关闭。")
                                    ch.window.close()
                                result={"ok":True}
                    return self.send_json(200,result)
                except RevisionConflict as ex:
                    return self.send_json(409,{"error":str(ex)})
                except (KeyError,TypeError,ValueError,OSError,subprocess.TimeoutExpired) as ex:
                    return self.send_json(422,{"error":str(ex)})
            if path in {"/api/studio/battles/bundle","/api/studio/battles/edit"}:
                if self.headers.get_content_type()!="application/json":return self.send_json(415,{"error":"需要 application/json"})
                try:
                    length=int(self.headers.get("Content-Length","0"))
                    if not 0<length<=256*1024:return self.send_json(413,{"error":"战斗引用请求过大"})
                    data=self.rfile.read(length)
                    if path.endswith("/bundle"):
                        return self.send_bytes(battles.bundle(data),"application/json; charset=utf-8")
                    ref=json.loads(data).get("ref")
                    return self.send_json(200,{"url":battles.open_editor(ref)})
                except BattlePackageError as ex:
                    return self.send_json(422,{"error":str(ex),"issues":ex.issues})
                except (AttributeError,ValueError,OSError,subprocess.TimeoutExpired) as ex:
                    return self.send_json(400,{"error":str(ex)})
            match=re.fullmatch(r"/api/studio/projects/("+ID+r")",path)
            if not match:return self.extra_route(parsed)
            if self.headers.get_content_type()!="application/json":return self.send_json(415,{"error":"需要 application/json"})
            try:
                length=int(self.headers.get("Content-Length","0"))
                if not 0<length<=MAX_BYTES:return self.send_json(413,{"error":"工程大小必须在 1 B–24 MiB 之间"})
                if not node:return self.send_json(503,{"error":"保存需要 Node.js；可先导出 JSON，或启动时传入 --node"})
                body=json.loads(self.rfile.read(length))
                p=body["project"];rev=body.get("revision")
                data=(json.dumps(p,ensure_ascii=False,indent=2,allow_nan=False)+"\n").encode()
                with settings.lock:
                    checked=subprocess.run([node,str(ROOT/"tools"/"scene.mjs"),"validate","-","--plugins",str(plugins)],
                        input=data,capture_output=True,timeout=15,creationflags=getattr(subprocess,"CREATE_NO_WINDOW",0),
                        env={**os.environ,"SCENE_STUDIO_DISABLED_PLUGINS":",".join(settings.disabled_plugins())})
                if checked.returncode:
                    try:issues=json.loads(checked.stdout)["errors"]
                    except (KeyError,ValueError):issues=[]
                    if not issues and checked.stderr:
                        issues=[{"path":"plugins","message":checked.stderr.decode("utf-8",errors="replace").strip()}]
                    return self.send_json(422,{"error":"工程校验未通过","issues":issues})
                file=projects/(match[1]+".scene.json")
                with registry_write(projects/".locks"/(match[1]+".lock")):
                    current=digest(file.read_bytes()) if file.is_file() else None
                    if current!=rev:return self.send_json(409,{"error":"该名称已有新版本。先打开已有工程，或另存为其他 ID。"})
                    with tempfile.NamedTemporaryFile(dir=projects,delete=False) as t:
                        tmp=Path(t.name);t.write(data)
                    try:os.replace(tmp,file)
                    finally:tmp.unlink(missing_ok=True)
                return self.send_json(200,{"revision":digest(data)})
            except (TypeError,KeyError,ValueError,OSError,subprocess.TimeoutExpired) as ex:
                return self.send_json(400,{"error":str(ex)})
    if server is None:server=StudioHTTPServer(("127.0.0.1",port),Handler)
    else:server.RequestHandlerClass=Handler
    server.extra_routes=list(extra_routes)
    url=f"http://127.0.0.1:{server.server_port}/"
    print("data =",data,flush=True)
    for name,row in settings.report()["settings"].items():
        value=server.server_port if name=="port" else row["value"]
        print(f'{name} = {json.dumps(value,ensure_ascii=False)} ({row["source"]})',flush=True)
    if settings.warning:print(settings.warning,flush=True)
    print("DELTARUNE Scene Studio V1.0 · "+url,flush=True)
    if args.open:threading.Timer(.25,lambda:webbrowser.open(url+("studio/chapters.html" if args.chapter_ui else ""))).start()
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:
        server.server_close()
        battles.close()
    if restarting.is_set():raise SystemExit(3)

def arguments():
    parser=argparse.ArgumentParser(description="DELTARUNE scene studio on loopback.")
    parser.add_argument("--base",type=Path,help="可选的 V0.4 布景工作台目录")
    parser.add_argument("--a-export",type=Path,help="只读 A-export v8 目录")
    parser.add_argument("--data",type=Path,help="可写数据目录，默认取 projects 的上一级")
    parser.add_argument("--port",type=int,help="回环端口，默认 18946")
    parser.add_argument("--official-root",type=Path,help="官方素材库（含 sprites/chN/all_sprites）；默认用 V0.4 的，没有时用 ../../assets-official/01-official")
    parser.add_argument("--plugins",type=Path,help="用户插件目录，默认为 --data 下的 plugins")
    parser.add_argument("--projects",type=Path,help="场景工程目录，默认位于程序目录外")
    parser.add_argument("--trailer-root",type=Path,help="宣传片项目目录，包含 assets 和 scenes")
    parser.add_argument("--node")
    parser.add_argument("--battle-root",type=Path)
    parser.add_argument("--battle-works",type=Path)
    parser.add_argument("--battle-library",type=Path,help="包含各个战斗作品目录的文件夹，默认为战斗编辑器的 works")
    parser.add_argument("--open",action="store_true")
    parser.add_argument("--chapters",type=Path,help="章节工程目录（含 ch4、ch5），默认为 --assets 下的 chapters")
    parser.add_argument("--assets",type=Path,help="场景编辑器素材目录（chapters、chapter5、official、ui-sprites、art），默认为程序目录")
    parser.add_argument("--battle-assets",type=Path,help="战斗编辑器素材库（index.json、sprites、audio、fonts），默认用 DR_ASSETS 或战斗编辑器的 assets")
    parser.add_argument("--ch6-assets",type=Path,help="第 6 章制作素材目录（/ch6-assets/），默认为 ../../ch6-assets")
    parser.add_argument("--chapter-ui",action="store_true")
    return parser.parse_args()


if __name__=="__main__":
    start(arguments())
