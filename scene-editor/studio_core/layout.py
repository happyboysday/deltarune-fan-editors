"""Optional V0.4 workbench and its page-specific routes."""
import hashlib
import json
import os
import sys
import tempfile
from pathlib import Path

from .http import StudioHTTPServer
from . import sequence_assets

DEFAULT_BASE=Path(r"D:\CodexWorks\2026-10-23\deltarune-director-v0.4")


def open_workbench(base, port, data, official_root):
    c_dir = base / "management/agents/C-editor"
    if not (c_dir / "server.py").is_file():
        raise SystemExit("--base 没有受支持的 V0.4 布景工作台")
    editor_html=(c_dir/"app"/"index.html").read_text(encoding="utf-8")
    editor_js=(c_dir/"app"/"js"/"editor.js").read_text(encoding="utf-8")
    marker="  function exportScene() {"
    if editor_js.count(marker)!=1 or "</body>" not in editor_html:
        raise SystemExit("此 V0.4 版本缺少布景交接位置，请检查 --base")
    sys.path.insert(0, str(c_dir))
    import server as director
    values = json.loads((base / "release/release.json").read_text("utf-8-sig"))["argv"]["c_editor"][2:]
    options=dict(zip(values[::2],values[1::2]))
    def asset_path(option):
        path=Path(options[option])
        return path if path.is_relative_to(base) else base/path.relative_to(DEFAULT_BASE)
    # V0.4 release files record the absolute folder they were built in (DEFAULT_BASE). When V0.4 lives somewhere
    # else, write copies with that folder rewritten to this machine's and pass V0.4 the copies' hashes.
    # V0.4 itself is never modified.
    relocated_dir=data/".relocated"
    def relocate(option,pin=None):
        src=asset_path(option);data=src.read_bytes();out=data
        old,new=str(DEFAULT_BASE),str(base)
        if old!=new:
            for a,b in ((old.replace("\\","\\\\"),new.replace("\\","\\\\")),(old.replace("\\","/"),new.replace("\\","/")),(old,new)):
                out=out.replace(a.encode(),b.encode())
        if out==data:return src,(options[pin] if pin else None)
        relocated_dir.mkdir(parents=True,exist_ok=True)
        dest=relocated_dir/src.name
        with tempfile.NamedTemporaryFile(dir=relocated_dir,delete=False) as temp:
            temp.write(out)
        try:os.replace(temp.name,dest)
        finally:Path(temp.name).unlink(missing_ok=True)
        return dest,hashlib.sha256(out).hexdigest()
    origin_admission,_=relocate("--origin-admission")
    additions_admission,additions_admission_pin=relocate("--background-additions-admission","--background-additions-admission-pin-sha256")
    # Background additions need V0.4's generated review-009 images; a source-only V0.4 copy does not have them.
    # They are optional, so skip them (V0.4 then shows the plain official backgrounds) instead of refusing to start.
    additions_overlay=asset_path("--background-additions-overlay")
    additions={"background_additions_module_path":asset_path("--background-additions-module"),
        "background_additions_module_sha256":options["--background-additions-module-sha256"],
        "background_additions_overlay_path":additions_overlay,
        "background_additions_pin_sha256":options["--background-additions-pin-sha256"],
        "background_additions_admission_path":additions_admission,
        "background_additions_admission_pin_sha256":additions_admission_pin}
    if not (additions_overlay.parent/"frame0-canvas").is_dir():
        print("V0.4 background additions skipped: generated review-009 images are not in",additions_overlay.parent,flush=True)
        additions={}
    # Reuse only the workbench context/handlers. Both modes bind through StudioHTTPServer.
    class WorkbenchServer(director.DirectorServer, StudioHTTPServer):
        def sequence_status(self):
            module=Path(sequence_assets.__file__)
            return {"configured":True,"available":True,"module":str(module),
                    "module_sha256":hashlib.sha256(module.read_bytes()).hexdigest(),
                    "root":str(data/"user-assets/animations"),"implicit_fallback":False,
                    "required_methods":["import_sequence","listing","resolve","image"],
                    "runtime_acceptance":False,"error":None}

    server=WorkbenchServer(("127.0.0.1",port), official_root=official_root,
        scenes_root=data/"legacy-scenes", a_export=base/"management"/"agents"/"A-assets"/"exports"/"v8",
        origin_admission_path=origin_admission,
        frame0_overlay_path=asset_path("--frame0-overlay"),
        visibility_overlay_path=asset_path("--visibility-overlay"),
        placement_overlay_path=asset_path("--placement-overlay"),
        placement_pin_sha256=options["--placement-pin-sha256"],
        **additions)
    if server.a_export and not server.a_export.roots["official"].is_dir():
        server.a_export.roots["official"] = official_root
    editor_html=editor_html.replace("<head>",'<head><base href="/">',1).replace("</body>",'<script src="/studio/layout-link.js"></script></body>',1)
    editor_js=editor_js.replace(marker,
        "  window.DirectorV05Layout = () => core.normalizeMap(currentMap());\n"+marker,1)
    class LayoutHandler(director.DirectorHandler):
        def workbench_read(self, head_only):
            return director.DirectorHandler.handle_read(self, head_only)

        def workbench_write(self):
            return director.DirectorHandler.do_POST(self)

    return server, LayoutHandler, editor_html.encode(), editor_js.encode()
