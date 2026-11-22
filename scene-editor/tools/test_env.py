"""Data paths and isolated scratch space for scene-editor tests."""
import argparse
import atexit
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
SCRATCH = ROOT / ".codex-tmp"
CONFIG = ROOT / "tools/test-env.local.json"


def workbench_official(data):
    assets = data["base"] / "management/assets/official"
    return assets if assets.exists() else ROOT.parents[1] / "assets-official/01-official"


SETTINGS = {
    "assets": ("--assets", "SCENE_ASSETS", lambda d: ROOT),
    "battleRoot": ("--battle-root", "DR_BATTLE_ROOT", lambda d: ROOT.parents[1] / "battle-editor"),
    "base": ("--base", "DR_V04_BASE", lambda d: ROOT.parent / "deltarune-director-v0.4"),
    "aExport": ("--a-export", "DR_A_EXPORT", lambda d: d["assets"] / "a-export" if (d["assets"] / "a-export").is_dir()
                else d["base"] / "management/agents/A-assets/exports/v8"),
    "battleAssets": ("--battle-assets", "DR_ASSETS", lambda d: d["battleRoot"] / "assets"),
    "officialRoot": ("--official-root", "DR_OFFICIAL_ROOT", workbench_official),
    "ch6Assets": ("--ch6-assets", "DR_CH6_ASSETS", lambda d: ROOT.parents[1] / "ch6-assets"),
    "projects": ("--projects", "DR_PROJECTS", lambda d: ROOT / "projects"),
    "trailerRoot": ("--trailer-root", "DR_TRAILER_ROOT", lambda d: ROOT.parents[1] / "ch6-trailer-project"),
    "chapters": ("--chapters", "DR_CHAPTERS", lambda d: d["assets"] / "chapters"),
}


def resolve_test_env(argv=None, env=None):
    parser = argparse.ArgumentParser(add_help=False, allow_abbrev=False)
    for name, (flag, _, _) in SETTINGS.items():
        parser.add_argument(flag, dest=name)
    cli, args = parser.parse_known_args(argv)
    local = json.loads(CONFIG.read_text("utf-8-sig")) if CONFIG.is_file() else {}
    env = os.environ if env is None else env
    data = {}
    for name, (_, variable, fallback) in SETTINGS.items():
        value = getattr(cli, name)
        if value is not None and (not value or value.startswith("--")):
            parser.error(f"{SETTINGS[name][0]} 需要目录路径")
        value = value or env.get(variable)
        data[name] = Path(os.path.abspath(value)) if value else (
            Path(os.path.abspath(ROOT / local[name])) if local.get(name) else fallback(data))
    return data, args


DATA, ARGS = resolve_test_env()


class Skip(Exception):
    pass


def require_data(*names):
    files, missing = [], []
    for spec in names:
        name, _, relative = spec.partition("/")
        file = DATA[name] / relative
        files.append(file)
        if not (file.exists() if relative else file.is_dir()):
            missing.append(f"{spec}（{file}）")
    if missing:
        raise Skip("缺少测试数据 " + "、".join(missing))
    return files


def require_path(file, label):
    if not file.exists():
        raise Skip(f"缺少测试数据 {label}（{file}）")
    return file


def run_test(main):
    try:
        return main()
    except Skip as error:
        print(f"SKIP: {error}")
        raise SystemExit(77) from None


def work_dir(prefix):
    SCRATCH.mkdir(parents=True, exist_ok=True)
    return Path(tempfile.mkdtemp(prefix=prefix + "-", dir=SCRATCH))


def copy_projects():
    source, = require_data("projects")
    return shutil.copytree(source, work_dir("studio-test") / "projects")


def test_process_env():
    SCRATCH.mkdir(parents=True, exist_ok=True)
    env = dict(os.environ, TMP=str(SCRATCH), TEMP=str(SCRATCH), TMPDIR=str(SCRATCH))
    env.update({variable: str(DATA[name]) for name, (_, variable, _) in SETTINGS.items()})
    official = DATA["officialRoot"].parent.parent
    for name, relative in (("DIRECTOR_GAME", "game/DELTARUNE"),
                           ("DIRECTOR_UTMT", "tools-external/utmt/UndertaleModCli.exe")):
        candidate = official / relative
        if not env.get(name) and candidate.exists():
            env[name] = str(candidate)
    return env


def server_options(projects, chapters=None):
    return {**{flag[2:].replace("-", "_"): DATA[name] for name, (flag, _, _) in SETTINGS.items()},
            "base": DATA["base"] if (DATA["base"] / "management/agents/C-editor/server.py").is_file() else None,
            "projects": projects, "chapters": chapters or DATA["chapters"]}


def start_studio_server(*, command=None, chapters=None):
    projects = copy_projects()
    options = server_options(projects, chapters)
    flags = [part for name, value in options.items() if value is not None for part in ("--" + name.replace("_", "-"), str(value))]
    log = projects.parent / "studio-server.log"
    with log.open("wb") as output:
        proc = subprocess.Popen([sys.executable, "-B", "-X", "utf8",
                                 *(command or [str(ROOT / "studio_server.py")]), "--port", "0", *flags],
                                cwd=ROOT, env=test_process_env(), stdout=output, stderr=subprocess.STDOUT,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))

    def close():
        if proc.poll() is None:
            if os.name == "nt":
                subprocess.run(["taskkill", "/PID", str(proc.pid), "/T", "/F"],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                               creationflags=subprocess.CREATE_NO_WINDOW, timeout=5, check=False)
            if proc.poll() is None:
                proc.terminate()
            proc.wait(5)
        atexit.unregister(close)

    atexit.register(close)
    try:
        until = time.monotonic() + 30
        while time.monotonic() < until:
            stream = log.read_text("utf-8", errors="replace")
            match = re.search(r"DELTARUNE Scene Studio .*? · (http://127\.0\.0\.1:\d+)/", stream)
            if match:
                return match[1], close
            if proc.poll() is not None:
                raise RuntimeError(f"测试服务器退出（{proc.returncode}）\n{stream.strip()}")
            time.sleep(.1)
        raise TimeoutError(f"测试服务器启动超时（{log}）")
    except BaseException:
        close()
        raise
