# 第六章宣传片场景接口

宣传片切片沿用 `deltarune-scene/1`。工程的 `start`、房间的 `entries`、`entities`、`events` 和素材 ID 照常使用。可以在编辑器选「动作地下城」或「伪 3D 赛车」，再在工程 JSON 中配置场景参数。

## 启动与素材路径

| URL | 默认目录 |
| --- | --- |
| `/ch6-trailer-assets/` | `DeltaruneWorks/ch6-trailer-project/assets/` |
| `/ch6-trailer-scenes/` | `DeltaruneWorks/ch6-trailer-project/scenes/` |

服务端接受 `--trailer-root PATH` 来指定含 `assets/` 和 `scenes/` 的目录。素材路由支持 PNG、WebP、GIF、JPEG、SVG、JSON。场景路由读 `*.scene.json`，可直接 GET 或通过编辑器打开。推荐使用透明 PNG 做精灵，包括打包成离线试玩时使用的精灵。也可以配置现有 `/official/sprites/ch1/…` 路径。

```text
http://127.0.0.1:18946/?project=/ch6-trailer-scenes/sunlit-highway.scene.json
http://127.0.0.1:18946/?project=/ch6-trailer-scenes/sunlit-highway.scene.json&autoplay=1
http://127.0.0.1:18946/?project=/ch6-trailer-scenes/sunlit-highway.scene.json&autoplay=1&manual=1
```

第一条进入编辑，第二条直接按时间线试玩，第三条在第 0 tick 等待录制器推进。已保存的工程也可以用 `?project=ch6-deep-shelter` 打开。素材字段使用以上述路由开头的根相对 URL。含空格或中文的文件名可以由 `URLSearchParams` 编码。建议渲染尺寸用 320×180 或 640×360，放大成片时用 nearest-neighbor。

## 动作地下城

`room.mode = "dungeon"` 复用 `room.platform` 的 `speed`、`acceleration`、`gravity`、`jump`、`fallSpeed`、`hoverTicks` 和 `retryEntry`。墙使用现有的 `kind: "wall"`，平台加 `oneWay: true`。默认水平速度 4.6、起跳速度 10.7、每 tick 重力 0.86。Kris 的动作 HP 属于本房间，倒下后按 `retryEntry` 或入场点重开遭遇。

| 键 | 脚本输入 | 效果 |
| --- | --- | --- |
| ← / → / ↑ | `left` / `right` / `up` | 移动，地面按 ↑ 起跳 |
| Z | `act` | 横斩、反手挑斩、重斩。下一次按键可提前缓冲。有可用互动时优先互动 |
| Shift / V | `dash` | 高速短闪避，满速阶段形成 5 张青色残影。闪避无敌按 30 Hz 向上取整为 9 tick |
| C | `tool` | 穿透月牙波，默认冷却 1.2 秒 |
| X / F | `skill2` | 灵魂弹反，反射附近子弹并眩晕近敌，默认冷却 2 秒 |
| Esc | `cancel` | 返回已有检查点。X 在对白等交互锁定期间也保留取消键行为 |

剑击命中冻结动作物理 3 tick，导演时间线继续。HP、技能充能和命中数连击显示在画布左下。以下字段都可选。

```json
{
  "maxHp": 100,
  "dashSpeed": 9.2,
  "waveCooldown": 1.2,
  "parryCooldown": 2,
  "slashSprites": [
    "/ch6-trailer-assets/dungeon/slash_arc_1.png",
    "/ch6-trailer-assets/dungeon/slash_arc_2.png",
    "/ch6-trailer-assets/dungeon/slash_arc_3.png"
  ],
  "waveSprite": "/ch6-trailer-assets/dungeon/crescent_wave.png",
  "parrySprite": "/ch6-trailer-assets/dungeon/soul_parry_ring.png"
}
```

将该对象放在 `room.dungeonConfig`。还可加 `slashArt: ["kris_swing_1","kris_swing_2","kris_swing_3"]`，引用 `project.assets` 内三段角色动作，用该素材的 `anchor` 定位。两个数组都允许用 `null` 跳过某一段。斩击和剑气贴图默认面向右，运行时镜像。斩击原点约在画布宽 35%、高 50%，剑气原点在中心。缺省时渲染程序化斩弧和红心环。

### 动作敌人

```json
{
  "id": "prism-wisp",
  "type": "actionEnemy",
  "x": 256, "y": 112, "w": 24, "h": 24,
  "sprite": "wisp", "hp": 6, "damage": 12,
  "patrol": [220, 304], "patrolSpeed": 0.65,
  "shotDelay": 0.6, "shotInterval": 1.45, "bulletSpeed": 3.4,
  "fireRange": 220, "shots": 3, "bulletColor": "#ff72a7",
  "onDefeat": "wisp-down"
}
```

可用 `kind: "actionEnemy"` 代替 `type`。坐标是碰撞框左上角，巡逻范围也是左边缘的 X。敌人沿设置好的水平路线巡逻，速度和弹速单位为像素/tick。发射间隔和初次发射延迟以秒为单位。设置 `patrolSpeed: 0` 可站定，`shotInterval: 0` 可停火。普通接触和弹幕共用 `damage`。动作敌人可被穿越，也可以使用通用 `hidden`、`activeWhen`、`sprite` 和 `color` 字段。`sprite` 是素材 ID，`onDefeat` 是事件 ID。重进房间重置遭遇，可在击败事件中设置旗标并用 `activeWhen` 记录永久击败。

### 视差背景

```json
{
  "skyGradient": {"top": "#6494df", "bottom": "#f6fbbd"},
  "parallax": [
    {"src": "/ch6-trailer-assets/env/parallax_clouds.png", "speedX": 0.18, "speedY": 0, "y": 0, "height": 90, "repeatX": true, "alpha": 0.9},
    {"src": "/ch6-trailer-assets/env/parallax_dreamtown.png", "speedX": 0.45, "y": 42, "height": 90}
  ],
  "sunbeams": [
    {"x": 28, "y": -14, "width": 22, "length": 190, "angle": -28, "alpha": 0.2, "color": "#fff2ba", "speedX": 0.34}
  ]
}
```

背景数组按远到近绘制。`speedX` 和 `speedY` 是镜头滚动乘数，默认分别 0.45 和 0，0 表示固定在视窗。绘图坐标按房间逻辑像素，`height` 按比例缩放，省略则使用原图高度。默认水平平铺、透明度 1。阳光束可用 `true` 启用默认三条，或用数组指定 `x, y, width` 和可选字段，负角度向右倾。布景 `scenery` 和地图照常画在视差层上方，有视差的场景可把不透明天空图放在第一个视差层。

## 伪 3D 赛车

`room.mode = "kart"` 启用单程比赛。方向键左右转向，↓ 刹车，默认自动给油。关闭自动给油后按住 ↑。按住 Shift 或 V 同时转向开始漂移，约 0.30 秒后松开可以触发小喷，蓄得越久火花从青色变为橙色。过加速板会触发拉远和速度线。碰到道具箱会转轮盘，获得 Lancer 后用 Z 或 C 投掷。投掷会锁前方最近的对手，落点随对手移动。建议将抛投拍点设在轮盘停转之后、目标仍在前方时。

`room.kartConfig` 可省略。默认 650 米路线、自带两辆对手、道具箱、加速板和路边景物。

| 字段 | 格式或默认值 |
| --- | --- |
| `trackSegments` | 按路线顺序排列的 `{length, curve?, slope?}`。长度为米，`curve` 为 −1 至 1，正值右拐，`slope` 为 −0.28 至 0.28，渐变到该段目标坡度。 |
| `maxSpeed`, `acceleration`, `steering` | 208 km/h、118 km/h 每秒、1 倍转向。 |
| `autoAccelerate`, `startLane` | 默认 `true` 和 `0`。全场横向以半路宽为 1，−1 左路缘、0 中线、1 右路缘。 |
| `opponents` | 最多 3 个 `{id?, lane?, start?, speed?, color?, sprite?}`。起跑距离为米，速度为 km/h，贴图是 PNG 路径。 |
| `itemBoxes`, `boostPads` | `[{at, lane}]` 和 `[{at, lane, width?}]`，`at` 为起点累计米数，加速板宽度以半路宽为 1，默认 0.8。 |
| `forceItem`, `items`, `seed` | 用 `forceItem: "lancer"` 固定结果。省略时按箱序号与种子从 `items` 抽取。默认 `["lancer"]`，同时支持 `"boost"`。 |
| `scenery`, `generateScenery` | `[{at, lane, kind?, src?}]`。种类为 `flower`、`tree`、`sign`。配置 `src` 时用透明 PNG。默认额外生成路边景物，设为 `false` 可关。 |
| `playerSprites` | `{straight, left1, left2, right1, right2, boost}` 各为 PNG 路径。可只填部分姿态，优先回退到 `straight`，其次用内置像素赛车。 |
| `rivalSprites` | 按对手 ID 映射到 PNG，也可按 `opponents` 顺序填 PNG 数组。对手自己的 `sprite` 优先。 |
| `lancerSprite`, `lancerIcon`, `lancerDrop` | `lancerSprite` 可同时用于道具与天降。可用 `lancerIcon`、`lancerDrop` 分别指定。例如 `/ch6-trailer-assets/kart/item_lancer_icon.png` 和 `/ch6-trailer-assets/kart/lancer_drop.png`。 |
| `skySprite`, `sunSprite`, `bulbSprite` | 地平线上方的整层天空，以及太阳和揭示阶段的独立透明图。留空使用程序画面。天空渐变色也可通过 `room.skyGradient` 设置。 |
| `itemBoxSprite`, `impactSprite` | 道具箱以及砸击星爆透明图。漫画字由引擎叠加，星爆底图用无字版。 |
| `onFinish` | 第一次过终点执行已有事件 ID。可用 `flash`、`wait`、`goto` 或 `battle` 切到 SOLUX 段。 |

车辆贴图用统一中心和底边，保持同一尺寸的透明画布，姿态间才不会跳轴。游戏按透视尺寸缩放。路径示例为 `/ch6-trailer-assets/kart/kris_kart_straight.png` 和 `/ch6-trailer-assets/solux/solux_bulb.png`。太阳缩放可在调试接口读取，完赛时 `raceProgress` 为 1。

## Director FX

在 `project.events` 的标准指令数组写入以下操作，用 `room.onEnter` 或实体事件字段引用事件 ID。也可将同样的操作放在定时 `navScript` / `kartScript` 行。命令立即启动，继续执行后续指令。要等演出再推进剧情，在事件数组加 `{"op":"wait","ticks":30}`。

| 操作 | 示例参数 | 计时 |
| --- | --- | --- |
| `flash` | `{"op":"flash","color":"#fff5d4","duration":0.6,"hold":0.15}` | `duration` 含全亮的 `hold`，其余时间退掉。 |
| `shake` | `{"op":"shake","intensity":8,"duration":0.35}` | `intensity` 是逻辑像素。HUD 固定，画面偏移按固定序列衰减。 |
| `titlecard` | `{"op":"titlecard","title":"不屬於暗世界的光彩","subtitle":"SOLUX","duration":2,"bg":"transparent","fadeIn":0.25,"fadeOut":0.4}` | 总时长包含淡入淡出。背景默认黑，也可用 `#RRGGBB`。 |
| `fade` | `{"op":"fade","to":"black","duration":0.6}` | `to` 可用 `black`、`white`、`clear`。黑/白幕会持续到下一次 `fade`。可用 `duration: 0` 立即设幕。 |

所有演出持续时间以秒为单位。闪光、抖动、字幕和幕色各有一层，同类型的新指令取代前一次。普通门的转场仍走原本的 `goto.fade`，以 tick 计时。

## 时间线与录制

`room.navScript`、`room.kartScript`、`project.kartScript` 接受定时行。 `project.navScript` 也接受这些行，原有的 `{room, action, target, …}` 寻路条目继续在互动跑测模式使用。

```json
[
  {"tick": 0, "hold": []},
  {"at": 2.47, "hold": ["right", "dash"]},
  {"tick": 87, "hold": []},
  {"at": 4.7, "press": ["act"]},
  {"at": 9, "op": "flash", "color": "#fff1b1", "duration": 0.45, "hold": 0.1}
]
```

- 一行只用 `at`（从入场起算的秒）或 `tick`（整数游戏步）之一。秒按最接近的 30 Hz tick 对齐。第 0 行在入房后的第一次 `step` 执行，同 tick 按数组顺序处理。
- `hold` 是从此刻起完整的持续按键表，`[]` 松开所有键。`press` 是单次按下。跳跃、剑击、技能、投道具都用 `press`，转向和漂移用 `hold`。
- 顶层时间线可在行内带 `room`。省略 `room` 的定时行适用于各房间，适合单房工程。赛车依序选择 `room.kartScript`、匹配房间的 `project.kartScript`、`room.navScript`、匹配房间的 `project.navScript`。
- 入场事件中的对白、移动、等待会按原逻辑封锁操作，但该房间的时间线照常走。等封锁结束后再安排一次性按键。遭遇战期间场景时钟暂停。脚本可由 URL、试玩面板的「宣传片时间线」或调试接口启动。

打开 `autoplay=1&manual=1` 后，等待 `document.body.dataset.ready === "true"` 且 `window.__ch6Trailer` 就绪。通过以下方法控制画布。

| 接口 | 用途 |
| --- | --- |
| `hz`、`canvas` | 模拟频率 30 Hz、场景 Canvas。可导出 `canvas.toDataURL("image/png")`，画面不含编辑器边栏。 |
| `advance(ticks = 1, input?)` | 停止实时推进，推进指定 tick 并立即绘制，返回状态。手动输入用 `{hold, press}`，先 `stop()` 来接管时间线。 |
| `status()` | 读取全局 tick、房间、模式、`script`、`fx` 和当前玩法状态。赛车含 `raceProgress`、`sunScale`、`lancerPhase`、`lancerHits`，地下城含三段阶段、残影数、命中、击杀和弹反数。 |
| `reset()`、`start()`、`stop()` | 回到工程起点。亦可从当前房间当前时刻重启预设时间线，或把输入交还键盘。 |
| `pause()`、`resume()` | 暂停、恢复实时播放。带 `manual=1` 时用 `advance` 逐帧推进。 |

30 fps 采集时每次推进一个 tick 并取一张 PNG。60 fps 交付时每个游戏画面占两帧，可在编码时将 30 fps 帧流转换为 60 fps。这样时间线、三次顿帧和弹幕命中的相对时刻一致。

```powershell
node tools/test-ch6-trailer-modes.mjs
```

测试可接收 Deep Shelter 文件路径，便于独立副本引用本地工程。第二个参数可写出三个浏览器试拍场景到指定目录，目录应位于 `--trailer-root` 的 `scenes/` 下。
