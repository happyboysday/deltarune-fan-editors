# sprites_full — 戰鬥 sprite 全幀 + 真實原點（A3）

用 UTMT CLI（`tools-external/utmt/UndertaleModCli.exe`，0.9.2.0）直接讀 `data.win`，
把戰鬥相關 sprite 的**每一幀**匯出成 PNG，並附上 `data.win` 內的真實 `OriginX/OriginY`。
Phase 1 的 `assets/index.json` 每隻 sprite 只有第 1 幀、原點多數是 0；本工具補齊這兩件事。

產出：

| 路徑 | 內容 |
|---|---|
| `assets/sprites-full/<name>/<i>.png` | 每幀一張，固定 sprite `Width×Height` 畫布（padded，原點才有意義） |
| `assets/sprites-full.index.json` | 同 Phase 1 `assets/index.json` 的 `dr-battle-assets/1` 格式，另加 `originVerified: true`、`source: "utmt:chN"`、可選 `fps` |
| `assets/actor-presets.json` | 四位主角＋常見敵人的建議 `anims`（SPEC-P2 §1 `actors.<id>` 可直接貼） |

`tools/build_assets.py`（W2 擁有）合併時會以 `sprites-full` 覆蓋同名項的 `frames/ox/oy`；
`chapter` 語意也改成「**來源章**」（見下）。

## 快速用法

```bash
# 全流程（probe → 選取 → 匯出 → index → presets → 對 Phase 1 比對）
python tools/sprites_full/extract.py

# 只印選取統計，不寫檔、不跑 UTMT
python tools/sprites_full/extract.py --dry-run

# 驗證產出（PNG/尺寸/原點/presets 引用）
python tools/sprites_full/verify.py

# 只重建 index/presets，不重跑 data.win probe / 匯出（已有 catalog、PNG 時很快）
python tools/sprites_full/extract.py --no-probe --no-export

# 改過 select.json 後重匯出（--force-export），或重跑 probe（--force-probe）
python tools/sprites_full/extract.py --force-export
python tools/sprites_full/extract.py --chapters ch1 --force-probe
```

冪等：`catalog/probe_<ch>/sprites.json` 比 `data.win` 新就跳過 probe；某章所有選取 sprite
的 PNG 幀數都正確就跳過該章匯出；不再被選取的資料夾會自動清掉。
全量（2476 sprites / 8471 frames）在 5 章上約數分鐘（主要時間是 UTMT 載入 5 個 data.win）。

## data.win 從哪來

`select.json` 的 `dataWinTemplates` 依序找：

1. `assets-official/04-game/<chapter>/data.win`（若有人把遊戲 zip 解在這）
2. `assets-official/04-game/chapter<N>/data.win`
3. `assets-official/02-audio/DELTARUNE/chapter<N>_windows/data.win` ← **目前實際使用**（音效包附的 data.win，與五章遊戲 zip 內完全相同）

不需要把 `DELTARUNE_v0.4_五章专用演出游戏副本.zip` 解壓（zip 內也只有同樣的 data.win）。

## 選取規則（`config/select.json`）

格式：`dr-sprites-full-select/1`。決策順序：**globalExclude → rules（第一條符合者勝出）→ enemy families/sprites**，
之後每個名字取「最新章」（`chapterPriority`: ch5 → ch1）為來源章。

- **globalExclude**：`^ftex_`、`^IMAGE_`、`mask`、`hitbox`、`^bg_`、`_whitebg$`、`\d{4,}$`、
  `^spr_overworld_`、`^spr_plat_`、`_old\d*$` 等雜物/平台段/舊版。
- **rules（9 條，帶 tags）**：
  - `party-battle`（tags: party）：`^spr_(krisb|susieb|ralseib|noelleb)_` — 四位主角所有戰鬥動作。
  - `soul`：`^spr_heart(?!enemy)`、`^spr_dodgeheart`、`^spr_soul`、`^spr_spinheart`、`^spr_greenheart`、`^spr_gigaheart`、`^spr_heartblcon_` — 靈魂/心/閃避心/靈魂彈幕。
  - `menu-buttons`（ui）：`^spr_bt(?!b01_)|^spr_ja_bt` — FIGHT/ACT/ITEM/SPARE/DEFEND/TECH 等按鈕，**含高亮幀**（同一 sprite 的第 2/3 幀就是高亮/按下），以及日文版與 ch3 變體。
  - `dialogue-box`（ui）：`^spr_textbox_(left|top|topleft)`、`^spr_bubl$`、`^spr_battlemsg$` — 文字框/泡泡/戰鬥訊息框。
  - `attack-bar`（ui）：`^spr_attack_`（cut/hit/mash/slap/shard/knife）、`^spr_attackspot`、`^spr_press(front|spot)`、`^spr_battletarget_triangle`、`^spr_chartarget`、`dashbar` — 攻擊條/按鍵提示/目標三角。
  - `damage-numbers`（ui）：`^spr_numbersfont`（big/small/gold/pink/gold_x）— 傷害數字字型。
  - `hp-tp-bars`（ui）：`^spr_hpname$`、`^spr_hpslash$`、`^spr_hero_hp$`、`^spr_queen_hp$`、`^spr_tension`、`^spr_tplogo$`、`^spr_tiredmark$` — HP/TP/緊張度條。
  - `battle-box`（ui）：`^spr_battleblcon`、`^spr_battleui`、`^spr_spare`、`^spr_defendbar` — 戰鬥框/選單底/SPARE 星/防禦條。
  - `battle-background`（battlebg）：`^spr_battlebg`、`^spr_dojo_battlebg` — 戰鬥背景底圖。
- **enemy**：白名單 `families`（88 個家族）＋ `sprites`（個別指定）＋ `exclude`（子變體排除）。
  規則很簡單：家族前綴展開（`<family>` 本身或 `<family>_*`），再排除 `cutscene/_overworld/_battle_overworld/_ow_/_date\d/_example/_placeholder/_debug/_test\b/_background/_marker/_highlight/_hitbox/_mask$/_sample/_(walk|run)_(down|left|right|up)`。
  家族名是人工整理（不是自動推斷）：以「名稱結尾 `_idle/_hurt/_spared/_defeated/_wounded/_clobbered`」＋
  「object 名稱含 enemy/boss/battle/monster 的引用」兩條規則產出候選，再人工剔除
  非戰鬥家族（`spr_seam/spr_rurus/spr_hatguy/spr_starwalker` 的 overworld 版、`spr_dw_*/spr_npc_*/spr_plat_*/spr_board_*`、
  `spr_queen_*` 的 overworld/chair 混合版、`spr_gigaqueen/spr_solidenemy` 等）。
  → 想加/減敵人：直接編輯 `enemy.families`；改完 `--force-export`。
- tags 只允許 SPEC 的六種：`party enemy soul ui battlebg bullet`；名稱含 `bullet|shard|projectile|missile` 的敵人子 sprite 額外加 `bullet`。

### 檔名/章節注意

- 同一 sprite 名若多章都有，**只匯出最新章版本**（原作通常一模一樣；少數舊章專屬品會保留 ch1/ch3/ch4）。
  所以 index 的 `chapter` 是「**來源章**」，不是「首次出現章」。
- 選擇結果同時驗證過：ch1 的 `spr_hathyx_*/spr_diamondm_*/spr_ponman_*` 等與 ch2+ 同名，
  會被標成 ch5；`spr_checkers_*`、`spr_king_battlepose`、`spr_joker_dance` 等只在舊章的會標 ch1 → 要看「這敵人在哪章」請查名稱。
- 已知同名但不同造型的情況（如 `spr_noelleb_*` vs `_sideb`、`spr_bqueen_*` vs `spr_queen_*`）都有保留，
  因為 family 展開不看造型。

## 原點與 fps 語意

- **原點**：`data.win` 的 `UndertaleSprite.OriginX/OriginY`，就是繪製時對齊的像素點。
  PNG 用 `TextureWorker.ExportAsPNG(..., padded: true)` 匯出成固定 `Width×Height` 畫布，
  所以 `index.w/h` 與每張 PNG 尺寸完全一致，`ox/oy` 可直接用。
  Phase 1 大量 `ox=oy=0` 是「未驗證預設值」；本索引全部 `originVerified: true`。
  原點**允許負值**（原作大量用它做對齊，例如 `spr_roaringknight_down_*`、`spr_ribbick_small`），
  `verify.py` 只擋真正離譜的值。
  **例外（4 隻）**：少數 sprite 的 `Width/Height` 與 texture page item 實際尺寸不一致
  （`spr_battleblcon_ghost_bottom_anim2` 12×15→12×5、`spr_pink_spotlight_kris` 36×42→36×30、
  `spr_pink_spotlight_susie` 53×46→53×26、`spr_swatchling_head` 31×24→68×70），
  實際畫面用的是 texture 尺寸，所以 index 改以 PNG 尺寸為準、`ox/oy` 按比例換算
  （官方 `assets-official/01-official` 的匯出也是 texture 尺寸，可交叉驗證）。
- **fps**：`UndertaleSprite.GMS2PlaybackSpeed` + `GMS2PlaybackSpeedType`
  - `type=1, speed=1`（絕大多數）：GMS 預設「每個 game frame 前進 1 幀」→ 沒有真實演出速度語意，**不寫 fps**（由 presets 提供建議值）。
  - `type=0`（FramesPerSecond）：寫 speed（多為 15，也有 10/30/5/3/1）。
  - `type=1, speed≠1`（如 0.2/0.5/3/10）：寫 `speed × 30`。
  - 只有 1 幀的 sprite 不寫 fps。
- 遊戲本身 `sequences=0`（所有章），所以沒有 GMS2 sequence 的播放曲線可用。

## actor-presets

`config/actor_presets.json` 是來源（有中文註解、可加 `name`/額外狀態），
`extract.py` 轉成 `assets/actor-presets.json`：
`{ format: "dr-battle-actor-presets/1", actors: { <id>: { kind, x, y, anims: { <state>: {sprite,fps,loop,then?} } } }, layouts, displayNames }`。
家屬：kris/susie/ralsei/noelle（party，含 idle attack act magic item spare defend hurt down victory）
＋ rudinn/rudinn_ranger/hathy/ponman/k_round/bloxer/jigsawry/clubs/rabbick/smallchecker/heartenemy/
chain_king/lancer/lancer_bike/king/jevil/susie_enemy/dummy/bqueen（enemy）。
`then` 表示非循環動畫播完接的狀態；未定義的狀態引擎退回 `idle`。

**站位（layouts）**：依 `docs/SPEC-LAYOUT.md` §3/§4 實機量測；座標是 640×480 邏輯畫布的「腳底」，
renderer 依 scale（2×）放大。隊伍在畫面左側 x≈100（各人 ±8 前後錯開：Kris 96、Susie 104、Ralsei 100、Noelle 108）；
`layouts.party1..4` 依隊伍人數給腳底 y：1 人 [240]、2 人 [190,298]、3 人 [140,230,322]、4 人 [120,190,260,330]。
`layouts.enemy1/2/3` 是右側 1–3 隻敵人的站位陣列（依 encounter `enemies` 順序套用：
單隻 500,270；兩隻 480,200 / 530,290；三隻 470,170 / 520,240 / 500,310）。
`actors.<id>.x/y` 預設值＝該角色在 party3（Noelle 用 party4）／enemy1 的位置，直接貼 actor 預設就會縱向錯開。

已知近似（原作沒有對應 sprite，用最接近的狀態代替）：
- Kris 沒有 `magic`（原作不會魔法）→ 省略該狀態。
- Ralsei 沒有 `hurt` sprite（只有 `defeat`）→ presets 用 `spr_ralseib_shock_enemy`（被擊中反應）代替。
- 四位主角都沒有 `spare` 專用動畫 → presets 用 `idle`。
- Ponman 沒有 `spared` → 用 `touched`；K.Round 沒有 `hurt/spared` → 用 `crouch`/`bow`；Bloxer 的「身體」是拆件（`part*`），hurt 用 `part_hurt`。
- 敵人 family 會把 Boss 戰內用到的 cutscene/道具變體一起收進來（例如 `spr_flowery_diner_*`、`spr_tenna_minigame_*`），因為那些也是戰鬥演出的一部分；要精簡就改 `enemy.exclude`。

## 本次產出統計（v0.4 五章 data.win）

- **2476 sprites / 8471 frames / 8.65 MB PNG**（+ index 935 KB）。
- 多幀 sprite：1310（Phase 1 只有 92）；單幀 1166。
- 來源章（最新章優先）：ch5 1359、ch4 749、ch3 283、ch1 57、ch2 28。
- tags：party 109、enemy 2195（其中 35 個子 sprite 另標 bullet）、ui 121、soul 39、battlebg 12。
- 有 `fps` 欄位的 282 隻（GMS2 明確播放速度；其餘是預設值，fps 交由 presets 決定）。
- 幀數最多：`spr_tenna_dance_cabbage*` 93、`spr_tenna_freakout` 81、`spr_tenna_dance_cane` 59、
  `spr_tenna_kick` 40、`spr_bqueen*` 30、`spr_werewire_idle` 28。
- 修改 `select.json` 後 `--dry-run` 可先看數量；`--force-export` 重匯出、`verify.py` 驗證。

## 驗證

- `python tools/sprites_full/verify.py` → `errors=0 warnings=1`（唯一警告是 Kris 沒有 magic，屬原作設定）。
  檢查：PNG 存在/尺寸==index w/h/原點範圍/tags 合法/chapter/source/幀檔名連續；
  無孤兒資料夾；presets 的每個 sprite 都存在、then 指向同 actor 狀態。
- 交叉驗證：與 `assets-official/01-official` 比對
  - 同章 `all_sprites` 第 1 幀：ch1 57/57、ch2 28/28 **像素完全相同**；ch3/ch4/ch5 部分不同是因為
    官方那批匯出**沒有 padded**（例：`spr_btact_ex` 官方 31×26、我們 31×32；`spr_heart` 官方動畫 9×9、我們 16×16），
    我們用 padded 畫布才能讓 `ox/oy` 對齊。
  - 同尺寸但像素不同者，差異**全部落在 alpha=0 的透明像素 RGB**（UTMT 保留 texture page 底色、官方填 0），
    視覺輸出一致。
- 冪等：重跑 `extract.py` 會全部命中快取（probe/export 都跳過），index sha256 不變。

## UTMT 坑（實測）

1. **不要直接從 PowerShell/console 呼叫 `UndertaleModCli.exe`**：它需要 console handle，會直接炸。
   `extract.py` 用 `subprocess.run(..., capture_output=True)` 就正常。
2. `-s` 的 `.csx` **必須是絕對路徑**；`load <data.win>` 之後不需要 `-o`（只讀不存檔）。
   cwd 建議設 `tools-external/utmt`。
3. UTMT CLI 載入大 `data.win` 需 5–40 秒（ch5 165MB 最慢）；5 章 probe 各自要載入一次。
   所以 probe 結果快取在 `catalog/probe_<ch>/sprites.json`，不要把 UTMT 塞進每次 index 重建。
4. 內建 `Scripts/Resource Exporters/ExportSpecificSprites.csx` 可參考但不能直接用（它按資料夾結構輸出、
   且需要 `UndertaleModLib.Util`）。本工具的兩個 `.csx` 用純 C# 手寫 JSON 轉義（csx 內沒有 System.Text.Json）。
5. 匯出用 `padded: true`；`false` 會裁到 bounding box，原點就對不上。
6. 素材總容量不是問題：PNG 幾何壓縮率很高（320×900 的 15 幀 Boss 動畫只有 0.07MB），
   即使 8000+ 幀也只有數十 MB。
7. 執行器（本機 ops_bash）偶爾在前置階段失敗（`EXECUTOR_UNAVAILABLE ... link count mismatch`），
   重試同一命令即可，不是本工具的問題。

## 檔案

```
tools/sprites_full/
├── config/select.json        選取規則（名稱正則 + tags + 敵人白名單）
├── config/actor_presets.json presets 來源
├── utmt/probe_sprites.csx    data.win → catalog/probe_<ch>/sprites.json（含每幀 texture page 座標、origin、objects）
├── utmt/export_sprites.csx   data.win → assets/sprites-full/<name>/<i>.png + exported.json
├── extract.py                入口（probe → select → export → index → presets → 比對）
├── verify.py                 驗證（PNG/尺寸/原點/presets 引用/孤兒檔）
├── catalog/probe_<ch>/       快取（可重跑 --force-probe）
└── README.md                 本檔
```
