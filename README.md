# DELTARUNE 同人编辑器（场景编辑器 V1.0 ＋ 战斗编辑器）

> 这是**同人制作工具**，与 Toby Fox 及 DELTARUNE 官方无关。仓库只包含编辑器程序代码与一套字体，**不含任何官方图片、音效、音乐、地图或游戏文件**。

| 目录 | 内容 |
| --- | --- |
| `scene-editor/` | 场景编辑器 V1.0：场景、逐格编辑、横版地下城、伪 3D 赛车、战斗接线、章节主线、自动跑图、离线导出、插件系统 |
| `battle-editor/` | 战斗编辑器：弹幕攻击、遭遇战、试玩、录像、作品包 |
| `fonts-assets/` | 两个编辑器共用的字体（`fonts/`）与只登记字体的素材索引 |
| `Start-SceneEditor.cmd` / `Start-BattleEditor.cmd` | Windows 下双击启动 |

## 运行需要

- Python 3.11 以上、Node.js 20 以上
- 录像另需 Microsoft Edge 与 ffmpeg

## 快速开始

1. 双击 `Start-SceneEditor.cmd`。第一次启动会进入首次引导，可以「自动检测」素材位置，没有的素材留空即可，相关功能会停用并说明原因。
2. 双击 `Start-BattleEditor.cmd` 打开战斗编辑器。只有字体时，没有官方图的精灵以洋红色方块占位。

## 接上自己的素材

两个编辑器都从程序目录外读取素材：

- 场景编辑器：在「设置」页填写或自动检测；也可以用启动参数 `--assets`、`--battle-assets`、`--official-root`、`--a-export` 等。
- 战斗编辑器：`--assets <素材库>`（或环境变量 `DR_ASSETS`）。素材库可以用 `battle-editor/tools/build_assets.py` 从你自己解包的游戏文件生成。

完整说明见 [scene-editor/docs/使用手册.md](scene-editor/docs/使用手册.md)，开发与插件 API 见 [scene-editor/docs/开发者文档.md](scene-editor/docs/开发者文档.md) 和 [scene-editor/docs/插件开发.md](scene-editor/docs/插件开发.md)。

## 测试

```
cd scene-editor
node tools/test-all.mjs            # 快速层
node tools/test-all.mjs --browser  # 加上 Edge 浏览器层
```

测试需要的素材位置写在 `scene-editor/tools/test-env.local.json`（不提交），格式见 `scene-editor/README.md`。

## 版权

DELTARUNE 及其角色、图像、音乐、字体字形归 Toby Fox 所有。`fonts-assets/` 中的字形来自游戏，仅供同人创作使用。请只使用你合法拥有的游戏文件。
