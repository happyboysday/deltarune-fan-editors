# 网页试玩原作 UI 规格

本规格以第 5 章 Windows 版和 V260809 简体中文补丁为基准。第 1、4 章用于核对早期存档、失败画面和小游戏的例外。

## 来源与坐标

- GML 引用省略文件名前的 `gml_Object_` 或 `gml_GlobalScript_`，数字为 UndertaleModTool CLI 反编译所得行号。第 5 章中文 GML 在 `.research/ch5-zh/CodeEntries/`。从补丁包内层 `patch_chs_windowslinux_260809.7z` 取出 `chapter5.xdelta`，以游戏目录 `chapter5_windows/data.win` 为源用 `xdelta3 -d -s <源> <差分> <目标>` 还原到工作副本，再用 `UndertaleModCli dump <目标> -o <工作副本内目录> --code UMT_DUMP_ALL --strings`。使用内层归档中的差分可通过源与目标校验。现场安装的第 5 章 `data.win` 保留了英文字库，`lang/lang_en.json` 已有简体译文。
- 以下是相机左上角为 `(0,0)` 的 **640×480** 逻辑像素。常规暗世界视野为 640×480，光世界以 320×240 为原生视野，坐标和最终字号各乘 2。失败菜单 `PLACE_FAILURE` 也用 320×240 视野，独立于进入失败前所在的世界。例见 ROOM 资源 `room_dw_garden_intro`、`room_krisroom`、`PLACE_FAILURE`。
- `(x,y,w,h)` 表示左上角和尺寸，`[x1,y1]–[x2,y2]` 表示 GML 传入的两个角点。精灵锚点和文字锚点另列。普通画面按 30 帧/秒计，1 帧约 33.3 ms。计时基准可核对 `scr_timedisp:3–8`。

## 对话

### 位置、边框与头像

| 项目 | 暗世界 | 光世界（已乘 2） |
| --- | --- | --- |
| 放在上方的条件 | 主角相对相机的 y **大于 250** | 主角相对相机的 y **大于 260**（原坐标 130） |
| 上方盒子 | `(24,2,593,167)` | `(32,10,578,152)` |
| 下方盒子 | `(24,312,593,167)` | `(32,320,578,152)` |
| 正文基点，上／下 | `(58,30)`／`(58,340)` | 同左 |
| 有头像的正文 x | **174**，向右加 116 | 同左 |
| 头像实例锚点，上／下 | `(74,40)`／`(74,350)` | 同左 |
| 常规三行的 y，上／下 | `30,66,102`／`340,376,412` | 同左 |

默认下置，等于阈值时也下置。创建时选边，随后跟踪相机。脚本能覆盖 `side`、`xoff`、`yoff`、`boxheight` 和 `boxwidth`。默认 `boxheight=3`，加 1 行令盒底延长 36 px。文字距盒子左／上在暗世界是 34／28 px，在光世界是 26／20 px。出处 `obj_dialoguer_Create_0:9–51`，`obj_dialoguer_Draw_0:35–72`，`obj_dialoguer_Other_10:1–24`，`obj_dialoguer_Step_2:1–17`。

- **暗世界盒**使用 `scr_darkbox_black`。上方的 GML 角点为 `[24,2]–[616,168]`，下沿和右沿的精灵以 `末端+1` 镜像。黑色中心在四边各缩 20 px 的区域。四角用 16×16 的 `spr_textbox_topleft` 放大 2 倍，每 10 次 Draw 换一帧，共 8 帧。简化特效时取第 0 帧。边条用 `spr_textbox_top`（1×16）和 `spr_textbox_left`（16×1）。边条采样从名义外沿向内依次为 8 px 透明、4 px 白、2 px `#9DA2C4`、18 px 黑。出处 `scr_darkbox:7–41`、`scr_darkbox_black:1–6`、这三个 SPRT 资源的第 0 帧。
- **光世界盒**用 `spr_pxwhite` 铺白色矩形，再铺黑色内矩形。四侧白边 6 px，原生 3 px。正文没有独立姓名栏。出处 `obj_dialoguer_Create_0:45–51`，`obj_dialoguer_Draw_0:48–60`，`obj_dialoguer_Other_10:2–13`。
- **头像**是角色表情精灵，以实例锚点和精灵自身原点定位。实例相对未偏移的正文是 `(+16,+10)`。暗世界精灵 2 倍，光世界原生精灵 1 倍。角色可以再加偏移，例如暗世界 Susie 常规 `spr_face_susie_alt` 绘制锚点为 `(69,40+310×side)`。使用 `global.fc` 选角色、`global.fe` 选表情。出处 `scr_facechoice:1–4`，`obj_face_Create_0:9–15`，`obj_face_Draw_0:1–107`，`obj_writer_Other_15:28–185`。
- **平台模式**另走 `obj_dialoguer_plat`。默认上置，`obj_plat_text_at_bottom_zone` 可要求下置。暗世界正常横条为 `(0,0,640,100)` 或 `(0,380,640,100)`，黑色 alpha 0.7。下置时 `small` 和菜单 `charcon` 能调整 y 和高度，头像处还有黑色延伸与渐变。常用平台 writer 使用 28 px 行距。出处 `obj_dialoguer_plat_Create_0:104–111`，`obj_dialoguer_plat_Draw_0:129–188`，`obj_dialoguer_plat_Other_10:2–32`，`scr_speaker:84–124`、`scr_texttype:108–117,153–155`。

### 位图字体与换行

| 用途 | 游戏字体资源 | 原生 em | 640 坐标下的绘制方式 |
| --- | --- | --- | --- |
| 暗世界常规对白、暗世界选项／存档 | `fnt_mainbig`（8bitoperator JVE） | 24 | 1 倍，普通对白行距 36 |
| 光世界对白、光世界选项／存档、失败菜单 | `fnt_main`（8bitoperator JVE） | 12 | 2 倍，普通光世界对白行距 36 |
| 特殊黑字配置 | `fnt_dotumche`（DotumChe） | 12 | GML 原生 1 倍，writer 配置 9×20。按所在视野换算 |
| Sans、悄声小字、街机体 | `fnt_comicsans`、`fnt_tinynoelle`、`fnt_8bit` | 10、7、12 | 按对应 writer 与视野配置，街机字体在第 5 章标为 Press Start |

中文补丁替换同名 FONT 资源的点阵内容。GML 仍通过 `scr_84_get_font("mainbig")` 等名字获取资源，`lang_en.json` 提供译文。英文字体对照是相同 ID 的原版资源。对照第 5 章的 `fnt_main` 和 `fnt_mainbig`，英文原版各 96 个字形，补丁版各 3,580 个字形，其中 3,272 个汉字。同一 FONT 的 ScaleX／ScaleY 都是 1。战斗编辑器的 `fnt_main@zh` 等是对补丁图集的命名，`DTM.otf` 是补丁安装器内的可安装字体。出处 `scr_84_init_localization` 的 `font_map`、`scr_84_get_font:1–12`、`scr_texttype:8–49,124–125,292–293`、补丁 FONT 表和 `assets-official/03-zh-fonts/游戏字体索引.csv`。

- **菜单排字**使用 `draw_text` 的字形步进 `Shift`。例如补丁 `fnt_mainbig` 的 `A` 进 14 px、`中` 进 26 px，`fnt_main` 分别是原生 7、14 px。`Offset` 是横向偏移，字形图内已经包含纵向留白。出处 FONT 的 glyph 表及 `obj_choicer_neo_Draw_0:37–68`。
- **对白 writer**逐字设坐标，和菜单排字用不同步进。常规光世界原生 8×18、暗世界 16×36，统一后英文字距 16、行距 36。补丁在 `ord(ch)>505 || ord(ch)==183` 时将格宽改成 `(hspace*7) div 4`，故普通暗世界的汉字、中文标点和中点 `·` 步进 28 px，光世界原生 14 px。出处 `scr_texttype:20–43,78–85`，`obj_writer_Draw_0:991–1001,1062–1109`。
- **换行阈值**无头像 33 格、有头像 26 格。普通 ASCII 每字 1 格，符合上述码点判定的字符每字 1.75 格。到阈值后在前一个合适的 ASCII 空格处断行，否则按字符断。第 5 章补丁保护紧跟在 `*` 后的空格。纯汉字、无手工断行时约每行 19 字／15 字（无头像／有头像，边界因检测发生在加入下一字之前可多占不足一格）。`* ` 起头常见约 18 字／14 字。三行是普通盒子的预设高度，页长仍由作者控制。出处 `obj_writer_Draw_0:67–109`，`obj_writer_Other_15:192–277`。
- **星号与续行**。`*` 与其后的空格写在台词里。英文和中文的带星号段落在后续行遇到无星号行首时插入 `||`，每个 `|` 前进一个基础格，相当于续行缩进 32 px。显式换行用 `&` 或实际换行。遇到每行都有 `*` 的台词保留每行的星号，`\m` 可禁绘星号。出处 `obj_writer_Other_15:192–266`、`scr_asterskip:1–13`、`obj_writer_Draw_0:155–188,883–885,918–923`。

### 打字、翻页和角色音色

- 普通配置 `rate=1`，每个游戏帧处理一个字符，约 30 字/秒。特殊语气有 `rate=2`、`3` 等。控制码 `^1…^9` 增加 5、10、15、20、30、40、60、90、150 帧停顿。按住 X 在 `skippable` 许可时显示当前页全文并停止其打字 alarm。出处 `obj_writer_Create_0:1–10,38–97`，`obj_writer_Alarm_0:1–112`，`obj_writer_Draw_0:9–16,134–159`，`scr_texttype:24–28,96–105,127–133`。
- `/` 等待 Z 翻页，`/%` 等待 Z 关闭，`%` 可直接接下一页，`%%` 销毁 writer。普通等候的对白框**没有翻页箭头**。片段内嵌按键图标和脚本自定结束音是可选效果。出处 `obj_writer_Draw_0:189–215,383–407,1113–1159`、`scr_nextmsg:1–29`、`obj_dialoguer_Draw_0:35–103`。
- 默认文字声跳过空格、星号、ASCII 的 `! . ? , :` 和列出的控制符。中文标点没有纳入这组 ASCII 判定。快档靠 `sound_timer` 节流，慢档借 Alarm 1，首声有 Alarm 2。X 跳字时默认静音。出处 `scr_textsound:3–91`，`obj_writer_Alarm_0:1–22,112–122`，`obj_writer_Alarm_1/2`。

| 角色 | 常用 voice | GML 出处 |
| --- | --- | --- |
| 旁白、系统叙述 | `snd_text` | `scr_texttype:24–28` |
| Susie、Ralsei、Lancer | `snd_txtsus`、`snd_txtral`、`snd_txtlan` | `scr_speaker:84–107,161–169`，`scr_texttype:36–40,78–85` |
| Noelle、Toriel、Asgore、Berdly | `snd_txtnoe`、`snd_txttor`、`snd_txtasg`、`snd_txtber` | `scr_texttype:30–46,60–61,144–148,236–238`。Noelle 在 Kris 房间的回声用 `snd_txtnoe_echo`，见 `scr_textsound:183–223` |
| Sans、Queen、Spamton、King | `snd_txtsans`、实际播放 `snd_txtq_2`、`snd_txtspam2`、`snd_dadtxt` | `scr_texttype:48–49,87–88,150–151,175–179`，`scr_textsound:93–112`。Queen 随机 pitch 0.90–1.05，Spamton 为音量 0.8、pitch 1.2 |
| 第 5 章 Flowery | `snd_flowery_voicenoise_1/2/3`、`snd_flowery_voicenoise_loop`，部分句子带角色语音片段 | `scr_texttype:227–235`，`scr_textsound:113–156`，`obj_writer_Draw_0:830–856` |

## 对话选项

普通大地图选择用 `obj_choicer_neo` 的 `neostyle=1`。由 `scr_readychoicer` 经 writer 的 `\C2` 或 `\C4` 打开，承接对白框所在的边。单独触发且没有对白框时，以角色相对相机的 y=260 为界，等于阈值时仍下置。文本以水平和垂直中心对齐。

| 输入 | 上置文字中心 | 下置文字中心 |
| --- | --- | --- |
| 左 | `(155,83)` | `(155,393)` |
| 右 | `(487,83)` | `(487,393)` |
| 上（四选一） | `(321,43)` | `(321,353)` |
| 下（四选一） | `(327,122)` | `(327,432)` |

以上是单行、零自定偏移的位置。多行标签用 `#` 断行，取最长行宽 `W`。上选项多行时，其中心 y 再加 4 px。心形取资源 **`spr_heartsmall_white`**（第 5 章补丁 SPRT 索引 3113，原生 9×9，原点 0,0），染红 `#FF0000` 并放大 2 倍。选中目标的精灵左上角在 `(文字中心x − round(W/2) − 22, 文字中心y − 8)`，按每帧 0.8 插值靠近。初始没有选中项，心形在 `(312,76+310×side)`，多行标签有微调。选中文字为 `#FFFF00`，其余为 `#FFFFFF`。默认分支没有通用换项或确认音，`Other_4` 可显式放 `snd_error`。

出处 `scr_readychoicer:1–21`，`obj_writer_Draw_0:769–787`，`obj_choicer_neo_Create_0:1–96`，`obj_choicer_neo_Step_0:1–27,86–172`，`obj_choicer_neo_Draw_0:37–68`，`obj_choicer_neo_Other_10`。

平台／战斗使用 `neostyle=0`，左项心 x=60、字 x=92，右项心 x=`552−W`、字 x=`584−W`。y 和其余两项的位置见 `obj_choicer_neo_Step_0:33–84`，平台的背景是 640×100、alpha 0.7 黑条。更旧的 `obj_choicer_old` 只有左右选择，用红色 `spr_heartsmall`，心 x=178／370，y=110／420（上／下）。出处 `obj_choicer_neo_Draw_0:1–25`，`obj_choicer_old_Create_0:1–25`、`Step_0:1–44` 与对象 SPRT 引用。

## 存档菜单

触碰并互动于存档点时，按房间播放叙述，可省略。互动当下播放 `snd_power` 并把低于上限的队员 HP 补满，叙述结束后出现菜单。这两步与写盘确认分开。出处 `obj_savepoint_Other_10:1–35,168–181`、`obj_savepoint_Step_0:1–8`。

### 第 5 章普通存档

1. **首层（`menuno=0`）**。暗世界盒角点 `[92,98]–[546,315]`，type=0 时底边 y=270。黑色内区从 `(112,118)` 到 `(526,295)`，type=0 时到 y=250。光世界外框 `(100,98,440,218)`、黑内框 `(106,104,428,206)`。左对齐名字 `(120,120)`，右对齐 `LV 5` 在 `(400,120)`、时间在 `(522,120)`，房间名居中 `(320,170)`。代码里这里的 LV 数字取 `global.chapter`，时间格式为 `H:MM:SS`。保存／返回的文字 x=170／350、y=220，红心 x=142／322、y=228。第二行 y=260，心 y=270。暗世界第二行为「库存／伙伴」，不可用的伙伴为灰色。光世界第二行为「回到标题页面」。暗世界的红心是 `spr_heart`（16×16 原生），光世界为 `spr_heartsmall`（9×9，换算后 18×18）。此层换项靠红心，文字白色。出处 `obj_savemenu_Create_0:19–46,61–89`，`obj_savemenu_Draw_0:13–123`，`scr_timedisp:1–19`。
2. **选槽（`menuno=1`）**。背景覆黑 alpha 0.8，顶部显示本次进度，下方有 3 个槽和返回。设 `N(a)=2×round(a/2)`，用 GML 的 round。暗世界顶部盒 `(60,12,521,N(105)+1)`，列表盒 `(60,124,521,N(321)+1)`，两盒含端点。光世界顶部的黑内区从 y=24 开始，边框向外 6 px。槽高 84 px，第 `i` 项（从 0 开始）的 LV／名字／时间锚点 x=124／320／`60+N(483)`，y=`144+84i`。地点居中 x=320、y=`176+84i`。空槽为「新存档」居中 `(320,160+84i)`。暗世界分隔精灵 y=208、292、376，返回居中 `(320,394)`，光世界返回 y=400。选中项黄字，已用槽的心在 `(92,152+84i)`，空槽按文字宽度左移。出处 `obj_savemenu_Draw_0:125–258`。
3. **覆盖确认**。尝试写入另一个已有进度的槽时，列旧记录（首行 y=165、地点 y=195，再经 `N` 取整）和当前记录（再向下 70 px，黄色）。弹框角点 `[10,100]–[630,380]`，标题居中 `(320,N(123))`，保存／返回 `(170,324)`／`(350,324)`，黄字加红心。出处 `obj_savemenu_Draw_0:274–286,324–454`。
4. **完成（`menuno=2`）**。仍覆黑 alpha 0.8。暗世界上框同选槽，下框名义 521×`(N(273)+1)`，只画前两道分隔。当前进度黄字，已存槽在 `(320,160+84i)` 显示黄色「已保存」，其余槽 `#444444`，没有游标。输入缓冲过后 Z 或 X 关闭。首层另有句点版本「已保存。」的渲染分支。出处 `obj_savemenu_Draw_0:53–55,120–123,456–568`。

从首层进入选槽、从选槽返回首层用 `snd_select`，实际写入用 `snd_save`。检查该存档 Step／Draw 的移动分支，换槽只更新坐标。光世界退出确认是独立的是／否分支。中文键见 `lang_en.json` 的 `obj_savemenu_slash_Draw_0_gml_34_0`、`47_0`、`48_0`、`52_0`、`52_0_b`、`54_0`、`115_0`、`215_0`、`371_0`、`518_0–520_0`。流程出处 `obj_savemenu_Step_0:2–149`、`obj_savemenu_Draw_0:260–321,407–455,570–583`。

第 1 章有直接存当前槽的界面。通常外框以 `[108,98]–[530,270]` 为角点，保存／返回在 `(170,220)`／`(350,220)`，心 y=226。确认即存，原框用黄色「已保存。」替换选项。前段还有居中姓名的加高版。出处第 1 章补丁 `obj_savemenu_Draw_0:13–130`、`obj_savemenu_Step_0:1–64`。同人试玩若沿用单槽数据，可参考直接存档流程。

## Game Over

通用入口按失败类型和剧情状态分流，没有按 `global.darkzone` 在光／暗世界分别选一套失败菜单。两者走通用战败时先进入 `room_gameover`，再到 `PLACE_FAILURE`。脚本指定的重置、教学、小游戏和剧情转场走自己的分支。出处 `scr_gameover:1–55`，ROOM 的对象引用与视野信息。

1. **灵魂时序**。常规入口截取战斗画面，调用 `snd_hurt1`（可由参数禁止）。第 30 帧撤掉画面，显示 `spr_heart` 在失败时记录的 `(global.heartx,global.hearty)`。50 帧播放 `snd_break1`，换 `spr_heartbreak`，x 左移 2 px。90 帧播放 `snd_break2`，心隐藏并散出 6 个 `spr_heartshards`，初速 7、向下重力 0.2。140 帧起黑淡出，150 帧进入失败房间。第 80–149 帧连按 Z 四次可走白闪快速读档，白淡出 30 帧，伴 `snd_dtrans_lw`。重复战败还有加速分支。第 5 章庭园医院和 Flowery 特定战斗能绕过常规菜单。出处 `scr_gameover:15–25`、`obj_gameover_init_Create_0:1–7`、`obj_gameover_init_Step_0:1–149`。
2. **第 2–5 章通用画面**。黑底。上方 `spr_gameoverbg_neo` 在归一化后 `(0,40)`，显示区域 640×180，透明度每帧加 0.02，到 1 停。约 30 帧等待后循环 `AUDIO_DEFEAT.ogg`，在 `(100,300)` 逐字显示 Susie 或 Ralsei 的两页短句，具体角色看队伍。失败短句使用 `fnt_main`，原生格宽 12、行距 20、rate 2。两人都不在时直接等选项。出处 `DEVICE_FAILURE_Create_0:14–25`、`DEVICE_FAILURE_Step_0:21–65,86–114`、`obj_gameoverbg_Create_0/Step_0`、`scr_texttype:157–162`。
3. **继续／放弃**。两词锚点 `(160,360)`、`(380,360)`，光标是模糊红心 `IMAGE_SOUL_BLUR`（20×20 原生），淡入 10 帧，最高 alpha 0.6。未选中时心锚点 `(300,360)`，选中后目标 x=`文字锚点x+文字宽/2−20`，0.3 插值。普通白色，选中黄色。继续停音乐，白淡出每帧加 0.01，以 120 帧闹钟接 `scr_tempload`，第一次放 `snd_dtrans_lw`。重复失败时可用 0.03 和 45 帧。放弃播放沉入黑暗的对白，接 `AUDIO_DARKNESS.ogg`，曲终或等待上限时结束原作进程。出处 `DEVICE_CHOICE_Draw_0:1–26`、`DEVICE_CHOICE_Step_0:146–210,303–319`、`DEVICE_FAILURE_Step_0:86–236`、译文键 `103_0_b`、`104_0`、`103_0`。
4. **第 1 章**。失败房间先用 `AUDIO_DRONE.ogg` 配无框文字，再问是否重试。文字用原生 `fnt_main`、格宽 12、行距 20、rate 2，带低透明度光晕。默认选项原生位置 `(110,180)`、`(190,180)`，对应 640 坐标 `(220,360)`、`(380,360)`。出处第 1 章补丁 `DEVICE_FAILURE_Step_0:1–109`、`DEVICE_CHOICE_Create_0:19–32`，第 5 章共同分支 `scr_texttype:283–287`、`obj_writer_Draw_0:1018–1033`。

## 大地图菜单、转场与小游戏参考

**正常自由移动时没有常驻房间名、道具列表或全队 HP 角标。** 默认 C（`button3`）在允许开菜单时将 `global.interact` 设为 5。房间名称出现在存档菜单和存档槽，普通道具／关键道具及队伍状态进入菜单查看。特殊房间的指引、战斗 HUD、平台状态条和剧情标题属于对应模式。

- **暗世界 C 菜单**用上下黑条 `#010000` 滑入。普通地面菜单打开后 `tp=80`、`bp=60`，区域约在顶部 y<80 与底部 y≥419。上条用 `spr_darkitembt`、`spr_darkequipbt`、`spr_darktechbt`、`spr_darkconfigbt` 等状态帧。下条的队员头像、姓名与 HP 由 `scr_charbox` 绘制，三人时起始 x=0／213／426，每人的 HP 条宽 75 px、位于队员块 x+128。显示物品列表时普通道具和关键道具用各自数据。移动／选中／取消用 `snd_menumove`／`snd_select`／`snd_smallswing`。出处 `obj_mainchara_Step_0:70–98`，`obj_darkcontroller_Step_0:14–16,1643–1761`，`obj_darkcontroller_Draw_0:15–115,1456–1606`，`scr_charbox:39–62,184–281`。
- **光世界 C 菜单**在 `interact==5` 时画左侧姓名、LV、单人 HP 和菜单。「物品／状态／电话」的起点为 `(84,168)`，条目行距为 36 px。HP 小字锚点为 `(46,98)` 加菜单滑入偏移，状态页另有详细 HP 和装备。心是 `spr_heartsmall`。出处 `obj_overworldc_Draw_0:1–91,246–279`、`obj_overworldc_Step_0:9–32,300–338`。
- **房间转场**一般用黑色 `#000000` 的 `spr_pixel_white` 叠层。普通门的 fade-out alpha 初始为 0，在 Draw 中每帧加 0.08，门的 Alarm 2 在 8 帧切房并生成持续 fade-in，后者从 alpha 1 每帧减 0.08。剧情可用 `scr_fadeout(n)` 或 `scr_fadein(n)` 将一步设为 `±1/n`，也能指定染色。典型门本身没有统一音效，事件可另加。出处 `obj_doorAny_Other_19:1–10`、`obj_doorAny_Alarm_2:1–4`、`obj_fadeout_Create_0/Draw_0`、`obj_persistentfadein_Create_0/Draw_0`、`scr_fadein/scr_fadeout:1–7`。
- **节奏**可参考第 3 章节奏模式及第 5 章同系实现。`scr_rhythmgame_draw` 分别画底板、连击、谱面。轨道本地范围以判定线 `bottomy` 为基准，x 为轨道中心 ±40，y 为 `bottomy−200…bottomy+50`。Susie 的两个 `spr_rhythmgame_button` 在中心 x±20、y=`bottomy`，Ralsei 是横向判定条。谱面和演出各自决定配色及镜头。出处 `scr_rhythmgame_draw:1–79,108–129`、`obj_rhythmgame_chart_Draw_0`。
- **按键谜题**可参考第 4 章钢琴界面。交互时在钢琴上方约 80 px 画半透明黑圆，半径在 44 px 附近微动。四方向距中心 28 px，箭头／圆缩放 2 倍，染 `#698DE6`，基础 alpha 0.35，方向高亮加 0.6。这里的映射是方向与确认。第 6 章的 3×4 数字密码盘属于同人工程机制，钢琴界面只提供风格参考。出处第 4 章 `obj_church_piano_playable_Draw_0:1–57`、`obj_dw_church_remotepianomove_ui_Draw_0:1–75`。

## 当前试玩与原作的差异清单

| 当前实现 | 原作依据 |
| --- | --- |
| `view.mjs` 的 `dialogue()` 始终贴底，话者名另排紫字，头像居中缩放，字体为微软雅黑 | 按角色相机位置选上／下，头像按精灵锚点，正文逐格排版 |
| `dialogue()` 每世界 tick 揭示 2 个字符，宽度动态换行，末尾为 `▾` | 常用 rate=1，分角色音色、修饰和控制码，普通分页没有箭头 |
| `choice` 画纵排列表，以 `▸` 标当前项 | 大地图正常二／四选一用十字布局，红心加黄字 |
| `saveRequest` 用紫黑底与金色装饰，`play-save.mjs` 显示读档、导入导出及 DOM 失败弹层 | 存档点叙述后进存档框，战败有灵魂与独立失败流程。网页工程的导入导出按钮属于工作台能力 |
| 房间名、持有物与队伍 HP 角标，另有 `prompt/note` 和抓力条 | 自由移动的通用画面没有这组常驻角标。背包与状态由菜单承载，交互提示和抓力等按具体机制出现 |
| `rhythmHud` 用横轨、粉线和正误提示，`keypadHud` 用紫色数字键 | 原作有独立的谱面轨道与钢琴方向控制界面 |
| 普通 `fade` 的颜色为 `#06060e`，入战转场由 `transition.mjs` 自定 | 普通门默认纯黑，剧情白闪等由事件指定。入战是另一个转场类型 |

## ui-kit 接口说明

模块 [studio/ui-kit.mjs](../studio/ui-kit.mjs) 处理素材、测量、绘制和一次性音效。第二期继续由世界状态或页面控制器管理选边、自动换行、分段、菜单输入、读写存档和转场。

| 接口 | 用法 |
| --- | --- |
| `await art.loadUiKit()` | `preparePlayArt()` 或 `prepareArt()` 返回的 art 对象提供懒加载，在线和离线同一调用。同一 art 复用结果。独立页面可 `await loadUiKit()`。直接传 `loadUiKit(pack.ui)` 读取内嵌资源，旧离线包可传 `{}` 使用回退 |
| `uiViewport(width,height)` / `withUiViewport(ctx,draw,rect?)` | 默认按画布像素 `min(w/640,h/480)` 等比居中并裁到 640×480。可传 `{x,y,width,height}` 以房间有效区域为基准。回调内用逻辑像素，结束恢复变换和裁剪 |
| `kit.measureText(text,opts)` / `kit.drawText(ctx,text,x,y,opts)` | 测量返回 `{width,height,lineHeight,lineWidths}`，绘制返回最大行宽。支持换行符，默认 `font:'fnt_mainbig'`、`lang:'zh'`、`scale:1`、白色、左上对齐。可设 `align:'left'/'center'/'right'`、`baseline:'top'/'middle'/'bottom'`、`alpha`、`color` 和 `lineHeight`。两接口共用布局。行高与步进选项在应用 `scale` 前填写 |
| `advance:'font'` / `advance:'writer'` | 菜单默认用字库的步进。对白显式用 writer，可设 `cellWidth`。常用默认是 main=8、mainbig=16。`uiWriterAdvance(ch,cellWidth,lang)` 可用于数值排版。光世界用 `fnt_main`、`scale:2`、`lineHeight:18`。常规暗世界用 `fnt_mainbig`、`lineHeight:36` |
| `drawPanel(ctx,x,y,w,h,opts)` | 实线黑底白边，默认 `border:6`，可设 `fill`、`borderColor` |
| `kit.drawDarkBox(ctx,x,y,w,h,{frame})` | 拼原作暗世界箱框。没有所需素材时画实线盒并返回 `false`。传整数 `frame` 0–7，固定第 0 帧或以 `floor(drawTicks/10)%8` 推进 |
| `kit.drawHeart(ctx,x,y,opts)` / `kit.drawSprite(ctx,name,x,y,opts)` | 按精灵左上角绘制，选项 `frame,scale,color,alpha`。心默认 `spr_heart` 第 0 帧，也可选 `spr_heartsmall`、`spr_heartsmall_white`、`IMAGE_SOUL_BLUR`。白心经 `drawHeart` 默认染红。返回是否成功绘制 |
| `createTypewriter(text,{ticksPerGlyph,voice,onVoice,shouldVoice})` | 传入已排版的纯文本，每次模拟帧调用 `advance(ticks=1)`，读取 `visible` 和 `done`。每次显示新字时可给 `onVoice({name,glyph,index})`。默认按原作常规静音字符过滤，`shouldVoice` 可覆盖。`skip()` 静默显示全文。每页创建一个实例 |
| `kit.createAudio({getContext,isMuted})` | 可把试玩的 `AudioContext` 和静音状态传入，省略时由实例懒创建。用户手势内 `await audio.unlock()`，`await audio.preload([资源名])` 解码后，`audio.play(name,{volume,rate,restart})` 返回是否立即播放。缺失或尚未解码返回 `false`。支持 `stop(name?)`、`setMuted(bool)`、`dispose()`。`restart:true` 先停止同名音效 |

```js
import {createTypewriter, UI_SOUNDS, UI_VOICES, withUiViewport} from './ui-kit.mjs';

const kit = await art.loadUiKit();
const audio = kit.createAudio({getContext: () => sound, isMuted: () => muted});
// 宿主在用户手势里解锁试玩的 AudioContext，再预载本页需要的音效。
await audio.preload([UI_VOICES.susie, UI_SOUNDS.select]);
const page = createTypewriter('* 示例台词。', {
  voice: UI_VOICES.susie,
  onVoice: ({name}) => audio.play(name, {restart:true})
});
// 每个游戏 tick 调用 page.advance()。画面帧只读 page.visible。
withUiViewport(canvas.getContext('2d'), ctx => {
  kit.drawDarkBox(ctx, 24, 312, 593, 167);
  kit.drawText(ctx, page.visible, 58, 340, {advance:'writer', lineHeight:36});
});
```

中文字形依次尝试对应 `@zh` 图集、同资源英文图集、系统宋体／微软雅黑／等宽字体。fallback 用固定合理的步进，缺字绘制由系统字体负责。白字直接采样，其他颜色以字形 alpha 染色。每个图集使用 battle-editor 的 `glyphs.json` 与 `glyphs.png`。套件有点阵绘制和量字，GML 的控制码、特殊抖动、逐句配音和逐字渐变留给页面调用方。

现有 `player.mjs` 在键盘或指针手势里创建／恢复 `sound`，节奏提示通过同一个 Web Audio context 发声。系统界面可借用该 context，随试玩调用 `dispose()` 清掉 UI 音效节点。`battle-player.mjs` 的战斗音频由战斗引擎的 `createAudio(assets)` 管理。

在线资源见 [studio/ui-assets.json](../studio/ui-assets.json)。`/ui-assets/` 仅读取清单内的字体、精灵和音效。服务器启动时用本机 UTMT 从第 5 章容器和 `audiogroup1.dat` 导出清单内的短音效，输出仅在 `.ui-cache/ui-sounds/`，缺失音效会尝试战斗编辑器已有的音频。游戏和素材目录只读。`packArt()` 把该清单与资源数据放进 `pack.ui`，`GAME_MODULES` 包含本模块。离线不查询在线路由。图片缺失可查 `kit.missing`，音效是否成功解码看 `preload()`。游戏音乐文件与角色头像由各自的调用方选择。

开发演示在 [studio/ui-kit-demo.html](../studio/ui-kit-demo.html)，服务器运行时访问 `http://127.0.0.1:18951/studio/ui-kit-demo.html`。演示独立于工作台和默认试玩入口。
