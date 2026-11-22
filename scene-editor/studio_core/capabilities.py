"""Local data availability for the editor and chapter workbench."""
import json
import os
import shutil

from .settings import missing_parts


def capabilities(settings, official, chapters, game, utmt, node, hints):
    rows = {}
    def feature(key, label, checks, **extra):
        missing = [(setting, reason) for setting, available, reason in checks if not available]
        rows[key] = {"label": label, "available": not missing, "reason": "可用" if not missing else
                     "；".join(dict.fromkeys(reason for _, reason in missing)),
                     "settings": list(dict.fromkeys(setting for setting, _, _ in checks)),
                     "missingSettings": list(dict.fromkeys(setting for setting, _ in missing)), **extra}

    def setting(key):
        valid, reason = settings.status(key)
        return key, valid, reason

    def parts(key, dirs=(), files=(), *, root=None):
        missing = missing_parts(root if root is not None else settings.path(key), dirs=dirs, files=files)
        return key, not missing, "缺少 " + "、".join(missing)

    room_chapters = {f"ch{n}": bool(official.index and f"ch{n}" in official.index.chapter_records and
                     (settings.path("aExport") / "chapters" / f"ch{n}" / "rooms.json").is_file())
                     for n in range(1, 6)}
    feature("roomImport", "官方房间导入", [setting("aExport"), ("aExport", official.index is not None, official.error),
            ("aExport", any(room_chapters.values()), "缺少可用的章节房间索引")], chapters=room_chapters)
    feature("officialAssets", "官方素材", [setting("officialRoot")])
    feature("chapter5", "第 5 章地图示例", [parts("assets", ("chapter5/layouts", "art/chapter5"),
            ("chapter5/chapter5.scene.json",)), setting("officialRoot")])
    feature("chapter5Layouts", "第 5 章分层布景", [parts("assets", ("chapter5/layouts",))])
    feature("dungeonExample", "横版地下城示例", [parts("assets", ("art/dungeon-ch5",)),
            setting("officialRoot"), parts("officialRoot", ("animations/Kris",))])
    feature("officialHints", "官方房间物件候选", [("assets", any(hints.values()), "缺少 official 下的物件候选")])
    def chapter_files(ch, *names):
        return parts("assets", files=names, root=ch.home)

    def build_dependencies(ch):
        manifest = ch.home / "dependencies.json"
        if not manifest.is_file():
            return []
        try:
            dependencies = json.loads(manifest.read_bytes())
        except (OSError, ValueError):
            dependencies = None
        if not isinstance(dependencies, dict):
            return [("assets", False, "无法读取章节的 dependencies.json")]
        for name in dict.fromkeys(("DELTARUNE.exe", *dependencies)):
            # Build verifies the hashes before reusing staged files or copying game files.
            staged = ch.stage / name if name == "DELTARUNE.exe" else ch.stage.parent / name
            if not (game / name).is_file() and not staged.is_file():
                return [("DIRECTOR_GAME", False, f"缺少第 {ch.number} 章的游戏依赖 {name}")]
        return [("DIRECTOR_GAME", True, "")]

    game_found = (game / "DELTARUNE.exe").is_file()
    games = {str(n): game_found and (ch.stock / "data.win").is_file() for n, ch in chapters.items()}
    compiler = ("DIRECTOR_UTMT", utmt.is_file(), "缺少 UndertaleModCli.exe")
    editable = {}
    for n, ch in chapters.items():
        edits = ("assets", ch.edits_path.is_file(), "缺少 edits.json")
        edit_key = f"chapterEdit{n}"
        feature(edit_key, f"第 {n} 章编辑", [edits, chapter_files(ch, "index.json", "scripts.zip")])
        editable[str(n)] = rows[edit_key]["available"]
        build = [edits, chapter_files(ch, "index.json", "chapter.json", "resources.zip", "dependencies.json"),
                 *build_dependencies(ch), compiler]
        feature(f"chapterBuild{n}", f"第 {n} 章生成试玩", build)
        # A verified prebuilt copy skips generation, but the executable and libraries always come from the
        # trusted game install (F1), so playing it still needs DIRECTOR_GAME.
        try:
            cached = bool(ch.prebuilt())
        except (OSError, ValueError, AttributeError):
            cached = False
        trusted = ("DIRECTOR_GAME", game_found, f"第 {n} 章试玩需要受信任的游戏安装（DELTARUNE.exe）")
        play = [trusted] if cached else build
        feature(f"chapterPlay{n}", f"第 {n} 章试玩", play)
        feature(f"chapterPreview{n}", f"第 {n} 章段落预演", [*play, chapter_files(ch, "previews.json"), compiler])
    feature("chapters", "章节工作台", [("assets", any(editable.values()), "缺少 chapters 下的可编辑章节工程")],
            chapters=editable, realGame=any(games.values()), gameChapters=games)
    feature("uiSprites", "UI 精灵素材", [parts("assets", ("ui-sprites",))])
    feature("uiFonts", "UI 字体", [parts("battleAssets", ("fonts",))])
    feature("uiAssets", "UI 素材与字体", [parts("battleAssets", ("fonts",)), parts("assets", ("ui-sprites",))])
    feature("officialArt", "官方美术", [parts("assets", ("art",))])
    available_node = bool(node and shutil.which(node))
    feature("battle", "战斗", [setting("battleRoot"), ("node", available_node, "找不到 Node.js")])
    feature("battleAssets", "战斗素材", [setting("battleAssets"), parts("battleAssets", ("sprites", "audio"))])
    feature("layout", "布景工作台", [setting("base")])
    feature("trailer", "宣传片素材", [setting("trailerRoot")])
    feature("ch6Assets", "第 6 章素材", [setting("ch6Assets")])
    feature("projects", "打开本机工程", [setting("projects")])
    feature("projectSave", "保存本机工程", [setting("projects"), ("node", available_node, "找不到 Node.js")])
    plugin_dir = settings.path("plugins")
    writable = plugin_dir if plugin_dir.is_dir() else plugin_dir.parent
    plugin_checks = [setting("plugins"), ("plugins", os.access(writable, os.W_OK), "插件目录不可写")]
    feature("plugins", "用户插件目录", plugin_checks)
    feature("pluginInstall", "安装用户插件", [*plugin_checks, ("node", available_node, "找不到 Node.js")])
    return {"capabilities": rows, "warning": settings.warning}
