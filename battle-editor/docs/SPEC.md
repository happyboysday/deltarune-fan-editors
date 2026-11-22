# DR Battle Editor — Phase 1 Spec（合約文件）

獨立網頁應用：自製「看起來像 DELTARUNE」的彈幕躲避戰鬥引擎 + 編輯器。**不**依賴官方 GameMaker 運行時。
本文件是 Engine（W1）與 Editor（W2）之間的唯一合約。改動合約前必須先通知協調者。

## 0. 技術約束

- 純原生 JS（ES2022 modules），**無建置步驟、無 npm 依賴**。瀏覽器：Chromium 最新版。
- 透過 `battle-editor/serve.py`（Python 3.11 標準庫）在 `http://127.0.0.1:18900/` 提供靜態檔；`launch.cmd` 雙擊啟動並開瀏覽器。
- 遊戲畫面固定 **640×480** 邏輯像素，整數倍縮放顯示，`imageSmoothingEnabled = false`。
- 模擬固定 **30 FPS**（DELTARUNE 原生幀率）；渲染可用 rAF，但模擬以固定步長累加器推進。
- 所有 UI 文字使用繁體中文。
- 官方素材僅本機使用；`battle-editor/assets/sprites|audio|fonts/` 不進 git。

## 1. 目錄與檔案所有權

```
battle-editor/
  index.html            W2  編輯器入口
  play.html             W1  獨立試玩頁（?attack=samples/xxx.json）
  serve.py, launch.cmd  W2
  engine/               W1  引擎（必須可在 Node 無頭執行模擬，渲染器分離）
  editor/               W2  編輯器 UI
  tools/                W2  素材索引/擷取腳本（Python）
  assets/index.json     W2  產生；assets/sprites/ 下為 PNG（gitignore）
  samples/              W2  範例攻擊 JSON（≥3 個）
  tests/engine/         W1  `node tests/engine/run.mjs` 可跑的引擎測試
  docs/SPEC.md          協調者
```

不得修改不屬於自己的檔案。需要對方改動時，在自己的回報中列出。
**細分後的檔案歸屬以 §9（引擎）與 §10（編輯器）為準，優先於上表。**

## 2. 素材索引 `assets/index.json`

```json
{
  "format": "dr-battle-assets/1",
  "sprites": {
    "spr_heart": { "frames": ["sprites/spr_heart/0.png"], "w": 16, "h": 16, "ox": 0, "oy": 0, "chapter": "ch1", "tags": ["soul"] }
  },
  "audio": {},
  "fonts": {}
}
```
- 路徑相對於 `assets/`。`ox/oy` 為原點（來自 v0.4 `sprites.json` 的 `origin_x/origin_y`，未驗證者取 0）。
- `tags`：`soul` `bullet` `battlebg` `enemy` `ui` `party` 之一或多個，供素材瀏覽器篩選。
- 缺失素材時引擎畫洋紅色佔位方塊，不得崩潰。音效缺失時靜默。

## 3. 攻擊檔格式 `dr-battle-attack/1`

```json
{
  "format": "dr-battle-attack/1",
  "meta": { "name": "黑桃雨", "author": "" },
  "settings": {
    "duration": 8.0,          // 秒；到點結束回合
    "seed": 1,                // 決定性亂數種子
    "damage": 10,             // 預設每發傷害
    "invincibleFrames": 30,   // 受傷後無敵幀
    "grazeTP": 1.0,           // 每幀擦彈獲得 TP%（擦彈持續時累加）
    "background": "spr_battlebg_0", // 或 null（純黑 + 官方式格線背景由引擎程序化繪製）
    "bgm": null
  },
  "box":  { "x": 320, "y": 171, "w": 150, "h": 150, "rotation": 0, "border": 5, "color": "#00c000" },
  "soul": { "x": null, "y": null, "speed": 4, "slowSpeed": 2, "mode": "red", "color": "#ff0000" },
  "party": [ { "name": "Kris", "hp": 90, "maxHp": 90, "color": "#00ffff", "icon": null } ],
  "enemies": [ { "sprite": "spr_x", "x": 520, "y": 200, "scale": 2, "frameRate": 4 } ],
  "bulletTypes": {
    "spade": {
      "sprite": "spr_spadebullet", "frameRate": 0, "scale": 1, "color": null,
      "hitbox": { "shape": "circle", "r": 6 },   // 或 { "shape":"rect","w":8,"h":8 }，以子彈中心為原點、隨 rotation 旋轉
      "damage": null, "grazeable": true, "decor": false, "destroyOnHit": true,
      "faceVelocity": true,      // rotation 跟隨速度方向
      "offscreen": "destroy",    // destroy | keep
      "maskToBox": false         // true = 只在戰鬥框內可見（DELTARUNE 常見裁切）
    }
  },
  "timeline": [ /* 事件，見 §4 */ ]
}
```
`box.x/y` 是戰鬥框**中心點**（旋轉也以中心為軸），`w/h` 為內部尺寸。`soul.x/y` 為 null 表示框中心。顏色 `#rrggbb`。所有欄位都有預設值，引擎讀檔時補齊（`normalizeAttack()`）。

`bulletTypes.*.decor: true` 讓子彈保留位置、動畫與生命週期，並略過命中、擦彈、AI 威脅與難度密度。可省略 `hitbox`，顯示仍由 `maskToBox` 控制。

### 3.1 活動區、框的外觀、彈幕裁剪

- `arena.kind` 省略或為 `box` 時，靈魂沿用可移動、縮放及旋轉的矩形戰鬥框。選 `stage` 則用舞台全幅（x 0–640、y 0–362，不含下方 HUD）；選 `polygon` 則用 `arena.points`。
- 多邊形以 3–64 個 `{x,y}` 舞台座標按邊界順序排列，末點自動接回首點。允許凹形，不支援自交、洞或分離區域。靈魂用原本的 4 px 判定半徑連續檢查移動路徑。非法的活動區退回原框，檢查器顯示錯誤。
- `box.appearance` 可為 `classic`（預設、黑底及框線）、`outline`（只有框線）、`hidden`（不繪製）。`arena.outline: true` 可另外畫活動區邊界。兩者都不改變碰撞幾何。
- 每種子彈的 `clipTo` 可為 `none`、`box`、`arena` 或 `custom`。獨立裁剪區用 `clipRegion.points`；未設定或無效時 `custom` 退回原框。省略 `clipTo` 時保留舊 `maskToBox` 的效果。繪製沿輪廓裁剪；只有子彈中心與靈魂中心都在裁剪區內時才進行命中、擦彈判定。
- 場地以單段攻擊為單位設定；遭遇可透過多段攻擊切換場地。攻擊編輯器的編輯預覽用青色虛線標出活動區、橙色虛線標出獨立裁剪區。虛線不會錄進试玩或離線輸出。

## 4. 時間軸事件

每個事件：`{ "id": "唯一字串", "at": 秒, "type": ..., "label": "可選顯示名" }`。

| type | 欄位 | 說明 |
|---|---|---|
| `spawn` | `bullet`, `count`(預設1), 以及 §5 的生成欄位 | 在 `at` 一次性生成 `count` 發 |
| `emitter` | `duration`, `interval`, `count`, `spawn`:{§5 欄位, `bullet`} | 在 [at, at+duration) 每 `interval` 秒生成一次，每次 `count` 發 |
| `box` | `duration`, `ease`, `to`:{x,y,w,h,rotation 任選} | 戰鬥框補間 |
| `soul` | `mode`?, `x`?, `y`?, `color`? | 設定靈魂（Phase 1 僅 `red` 模式；其他值保留） |
| `clear` | `fade`(秒) | 清除場上所有子彈 |
| `shake` | `duration`, `amount` | 畫面震動 |
| `sfx` | `sound` | 播放音效（缺素材時靜默） |
| `anim` | `actor`, `anim` | 在遭遇戰中切換演員目前形態的動畫；獨立彈幕試玩時無演員 |
| `end` | — | 立即結束回合 |

`ease`：`linear` `quadIn` `quadOut` `quadInOut` `sineInOut` `backOut`。

## 5. 生成欄位與表達式

生成欄位（spawn / emitter.spawn）：
`x, y, speed, angle, accel, angularVel, scale, rotation, life, alpha, pathX, pathY`

- 角度單位為**度**，0 = 向右，90 = **向下**（螢幕座標）。速度單位 px/幀。
- `life`：秒，null = 不限（依 offscreen 規則回收）。
- 每個欄位可為數字或**表達式字串**，在生成時求值一次。
- `pathX`/`pathY`（可選）為**每幀**求值的表達式，結果為相對生成點的位移；設定後覆蓋該軸的速度運動。
- 表達式可用變數：
  - `t`：目前事件已經過秒數；`T`：回合總秒數
  - `i`：本次生成中的序號（0..count-1）；`n`：count；`k`：emitter 第幾次觸發（spawn 為 0）
  - `age`：子彈存活秒數（僅 pathX/pathY）
  - `x`、`y`：本次生成已求值的 x/y（供 angle 等欄位用，如 `aim(x, y)`）；未提供時為 box.x/box.y
  - `box.x box.y box.w box.h box.left box.right box.top box.bottom`
  - `soul.x soul.y`
  - 函式：`sin cos tan atan2 sqrt abs min max floor ceil round PI`（sin/cos 以**度**為單位）、`rand(a,b)`（決定性）、`pick(...)`、`aim(x,y)` = 從 (x,y) 指向靈魂的角度（度）、`lerp(a,b,u)`
- 表達式編譯前先做**詞法白名單驗證**（只允許數字、運算子、括號、逗號、白名單識別字與白名單屬性；禁止字串、方括號、賦值、`constructor` 等），不合法即視為編譯錯誤。通過後以 `new Function` 編譯並快取，只暴露上述名稱（用參數遮蔽全域：`window`, `document`, `globalThis`, `fetch` 等設為 undefined）。編譯/執行錯誤 → 該值取 0 並發出 `error` 事件（含事件 id 與欄位名），不中斷模擬。

## 6. 引擎 API（`engine/index.js`）

```js
import { createBattle, normalizeAttack, validateAttack } from './engine/index.js';

const battle = createBattle({
  canvas,            // HTMLCanvasElement；無頭模式可省略
  assets,            // await loadAssets('assets/index.json')，或 null
  mode: 'play',      // 'play' = 鍵盤控制；'preview' = 靈魂不受輸入（決定性，可 seek）
});
battle.load(attackJson);       // 內部呼叫 normalizeAttack
battle.play(); battle.pause(); battle.reset();
battle.step(n = 1);            // 前進 n 個模擬幀
battle.seek(frame);            // 從 0 重新模擬至 frame（preview 模式下必須決定性）
battle.getState();             // { frame, time, running, ended, soul:{x,y,hp?}, box:{...}, bullets:[{id,type,x,y,rotation}], tp, party }
battle.setOptions({ showHitboxes, showGrid, muted, scale });
battle.on(evt, cb);            // 'hit' 'graze' 'end' 'error' 'frame'
battle.destroy();
export async function loadAssets(indexUrl) {}
```
- 無頭：`createBattle({ canvas: null, assets: null, mode: 'preview' })` 必須能在 Node 執行 load/step/seek/getState（測試用）。
- `validateAttack(json)` 回傳 `[{ path, message }]`，編輯器用來顯示錯誤。

### 6.1 快照 / 還原（`snapshot()` / `restore()`，V2-08）

模擬核心提供「完整執行期狀態」的快照與還原，用來存檔、決定性測試與重跑加速；
快照是純資料（`structuredClone` / `JSON.stringify` 都成立），不含函式或 Proxy。

```js
const sim = battle.engine;             // createSimulation 實例（createBattle 的內部引擎）
const snap = sim.snapshot();           // 完整狀態（純資料）
sim.restore(snap);                     // 還原；回 boolean（壞資料回 false，且不改動現有狀態）
```

快照包含：

- 幀號 / `ended` / `endEmitted`、遊戲模式、攻擊檔種子
- **RNG 狀態**（`rng.getState()`：`{ state, seed }`），因此還原後 `rand()` / `pick()` 續接同一序列
- 子彈池中所有「活著」的子彈（含 `id` / 位置 / 速度 / 角度 / `age` / `life` / 淡出進度 / `wasInside` /
  `justSpawned` / **FX-GRAZE 的「已擦過」旗標 `grazed`** / **`memory` 的攤平數值**）
- 事件游標（`scheduleCursor`）、進行中的 emitter 進度、box 補間、shake 清單與目前震動偏移
- 戰鬥框與靈魂（位置 / 模式 / 顏色 / 無敵幀 / grazing / 可見度）、隊伍 HP、TP
- `sfxQueue`、`grazeFlash` / `hurtFlash`、已回報錯誤集合

**限制**：不含子彈回收池（`pool`，只影響效能，不影響行為）；`emitters` 依 timeline 索引找回
事件，所以快照只能在「同一份攻擊檔」的實例上還原（版本不符或缺少必要欄位時 `restore()` 回
`false`，呼叫端應退回 `reset()` / `load()`）。`createBattle` 本身沒有加這兩個方法，需要時取
`battle.engine`。實作見 `engine/sim.js`、`engine/rng.js`；決定性測試見 `tests/snapshot/`。

## 7. 外觀（像 DELTARUNE，非復刻）

- 背景：黑底 + 程序化繪製的暗紫色移動格線（類官方戰鬥背景），或 `settings.background` 指定 sprite 平鋪。
- 戰鬥框：黑色填充 + `border` 寬的 `color` 描邊（預設綠 #00c000）。
- 靈魂：紅心 `spr_heart`（16×16，以中心為碰撞點，碰撞半徑約 4px）。受傷時閃爍；擦彈時靈魂外圍出現**官方心形外框**（`spr_grazeappear` 形狀，亮黃 ↔ 暗橄欖脈動）並播 graze 音效。
- 擦彈判定（**2026-11-09 FX-GRAZE 更新，改為官方做法**）：不是「子彈 hitbox 外擴 16px 與靈魂圓形距離」，而是「子彈 hitbox 與**以靈魂為中心的心形遮罩**像素級重疊」。遮罩來自官方 `spr_grazemask.png`（50×50，四章位元相同）的**半尺寸 25×25**（= ch4 `spr_grazemask_small`），原點 (12,12)，面積 511 格；資料內嵌在 `engine/graze-mask.js`（由 `tools/gen-graze-mask.mjs` 從 PNG 重產，執行期不讀 PNG）。判定只需子彈自身 hitbox：圓形 → `maskOverlapCircle(b.x-soul.x, b.y-soul.y, r)`；旋轉矩形 → `maskOverlapRect(..., w/2, h/2, cos, sin)`；遮罩像素中心落在 hitbox 內即算擦到。命中判定（pad=0 的圓 / 旋轉矩形 vs `SOUL_RADIUS`）**完全不變**，所以「命中範圍」與「擦彈範圍」是兩套幾何：擦彈範圍是心形（斜上最遠約 19.1、斜下最近約 15.6，以 dot r=5 量測），命中範圍仍是圓。`GRAZE_PAD = 16` 僅為相容而保留匯出，引擎不再用它做擦彈（等效範圍見 `MASK_HALF_W` / `MASK_RADIUS`）。
- 底部隊伍面板：y ≥ 362 區域，每位隊員一格（名字、HP 數字與 HP 條、角色色）；左側直立 TP 條（橙色，含百分比）。
- 敵人：右側顯示 `enemies` 的 sprite，閒置時輕微上下浮動。
- 字體（2026-11-07 更新）：**遊戲畫面內文字一律英文**，用官方點陣字體（`assets.index.fonts`，格式 `dr-battle-font/1`：`glyphs.png` 字形只在 alpha 通道，需當遮罩染色；繪製：來源矩形 x,y,w,h → 畫在 (cx, cy+offset)，游標前進 shift，換行 lineHeight）。一般文字 `fnt_main`，大字 `fnt_mainbig`，小字/數字 `fnt_small`。字體未載入或缺字時退回 `"Courier New", monospace`。中文字體日後由使用者提供漢化組字體再接入。**編輯器 HTML 介面仍為繁體中文。**
- **語言切換（2026-11-07 更新，取代上一條的「一律英文」）**：遊戲畫面支援 `zh` / `en`，**預設 `zh`**。語言是檢視偏好而非攻擊資料：`render` 的 `options.lang`、`battle.setOptions({ lang })`；play.html 按 L 切換，編輯器預覽工具列有切換鈕。介面固定字串（HP、TP、MAX、DOWN、MISS 等）在 render.js 內建 `{ zh, en }` 字串表；隊伍名、敵人名等使用者資料原樣顯示。
- **戰鬥畫面的 `zh` 一律使用簡體中文**（字串表、範例攻擊中的文字、預設隊伍/敵人名等），以配合簡體補丁點陣字庫（使用者決定，2026-11-07）。
- 中文字體來源：簡體中文補丁 V260809 的點陣字庫（遊戲內 fnt_* 加漢字版，3,272 漢字）與 `DTM.otf`（Determination Sans SimSun，27,484 漢字）。素材索引中：`fonts["fnt_main@zh"] = { ...dr-battle-font/1 同格式, lang: "zh", base: "fnt_main" }`；`fonts["DTM"] = { kind: "otf", file: "fonts/DTM.otf", lang: "zh" }`。
- 字元退回鏈：`lang=zh` → `<名>@zh` 點陣 → `<名>` 英文點陣 → DTM.otf（`FontFace` 載入後 `fillText`）→ 系統字體。`lang=en` → `<名>` → 系統字體。
- 編輯器 HTML 介面字體：`font-family: "DTM", "Microsoft JhengHei", system-ui, sans-serif`（以 `@font-face` 載入 `assets/fonts/DTM.otf`，缺檔自動退回）。

## 9. 引擎內部模組合約（E1 / E2 分工）

E1 擁有：`engine/index.js`、`sim.js`、`expr.js`、`rng.js`、`easing.js`、`attack.js`（normalize/validate）、`tests/engine/**`。
E2 擁有：`engine/render.js`、`engine/input.js`、`engine/audio.js`、`engine/assets.js`（loadAssets 實作，index.js 重新導出）、`play.html`。

```js
// engine/render.js  (E2)
export function createRenderer(canvas, assets) // → { draw(state, options), resize(scale), destroy() }
// state = battle.getState() 的完整形狀（見下），options = { showHitboxes, showGrid, scale }

// engine/input.js  (E2)
export function createInput(target = window)   // → { read(): { dx, dy, slow }, destroy() }  dx/dy ∈ {-1,0,1}

// engine/audio.js  (E2)
export function createAudio(assets)            // → { play(name), setMuted(b), destroy() }  缺素材靜默

// engine/assets.js  (E2)
export async function loadAssets(indexUrl)     // → { index, getImage(spriteName, frameIndex) → HTMLImageElement|null, sprite(name) → 索引項|null }
```

`getState()` 完整形狀（E1 產出、E2 消費；渲染所需全部資料都在這裡，渲染器不得讀 sim 內部）：
```js
{
  frame, time, running, ended,
  attack,                       // normalize 後的攻擊（只讀）
  shake: { x, y },              // 本幀震動位移
  box:  { x, y, w, h, rotation, border, color },
  soul: { x, y, mode, color, invFrames, grazing /*bool*/, visible },
  bullets: [ { id, type, sprite, frame /*動畫幀索引*/, x, y, rotation, scale, alpha, color,
               maskToBox, hitbox: { shape, r?, w?, h? } } ],
  party: [ { name, hp, maxHp, color } ],
  tp,                           // 0..100
  enemies: [ { sprite, x, y, scale, frame } ],   // y 已含浮動位移
  sfxQueue: [ 'name', ... ],    // 本幀觸發的音效（index.js 交給 audio.play 後清空）
  grazeFlash, hurtFlash         // 0..1 視覺強度
}
```

## 10. 編輯器內部模組合約（ED1 / ED2 / ED3 / W2 分工）

| 擁有者 | 檔案 |
|---|---|
| ED1 | `index.html`、`editor/main.js`、`editor/store.js`、`editor/preview.js`、`editor/fileops.js`、`editor/styles.css`（全域樣式、版面） |
| ED2 | `editor/timeline.js`、`editor/timeline.css` |
| ED3 | `editor/inspector.js`、`editor/assets-panel.js`、`editor/bullet-types.js`、`editor/panels.css` |
| W2  | `tools/**`、`assets/**`、`samples/**`、`serve.py`、`launch.cmd` |

版面容器（ED1 在 index.html 提供）：`#toolbar` `#assets-panel` `#preview` `#inspector` `#timeline`。

```js
// editor/store.js  (ED1)
export function createStore(initialAttack) // → store
store.attack            // 目前攻擊 JSON（只讀，勿直接改）
store.selection         // { kind: 'event'|'bulletType'|'settings'|null, id: string|null }
store.subscribe(fn)     // fn(store, change) ；回傳取消函式。change = { label, paths? }
store.update(fn, { label, coalesceKey }) // fn(draftClone) 修改草稿後提交；同 coalesceKey 連續更新合併為一步復原（拖曳用）
store.select(kind, id)
store.undo(); store.redo(); store.canUndo(); store.canRedo()
store.replace(attack, label)            // 開檔/新建；清空復原堆疊
store.errors            // Map<string, string>：key = 事件 id 或 JSON 路徑（如 "timeline[3].spawn.angle"、"bulletTypes.spade.sprite"），value = 訊息
store.newId(prefix)     // 產生唯一事件 id

// 每個面板模組（ED2/ED3）導出：
export function mount(rootEl, ctx) // ctx = { store, assets /*loadAssets 的結果或 null*/, preview }
// preview（ED1 提供）：
preview.seek(frame); preview.getFrame(); preview.fps /*30*/;
preview.onFrame(fn)     // 播放中每幀回呼 fn(frame)；回傳取消函式
preview.duration()      // 秒
```
- 時間軸游標拖動 → `preview.seek(Math.round(sec*30))`；播放時用 `preview.onFrame` 更新游標。
- 檢查器以 `store.errors` 標紅欄位；ED1 負責在每次 store 變更後跑 `validateAttack` 並蒐集引擎 `error` 事件填入 `store.errors`。
- 拖曳類互動一律帶 `coalesceKey`，避免每像素一步復原。

### 10.1 編輯器介面多語系（2026-11-07）

介面可切換 **繁中 `zh-Hant` / 簡中 `zh-Hans` / English `en`**，由 `editor/i18n.js`（協調者擁有）提供 `t / registerStrings / setLocale / getLocale / onLocaleChange / applyDom / battleLangFor`。
- 每個模組把自己的介面字串放在**自己擁有的** `editor/locales/<模組>.js`，匯出 `export default { 'zh-Hant': {...}, 'zh-Hans': {...}, en: {...} }`，並在模組頂部 `registerStrings('<命名空間>', table)`。三語必須鍵集合一致（各模組測試要檢查）。
  - ED1：`locales/app.js`（命名空間 `app`、`toolbar`、`preview`、`fileops`）＋ index.html 靜態文字改用 `data-i18n*` 屬性。
  - ED2：`locales/timeline.js`（`timeline`）。ED3：`locales/panels.js`（`inspector`、`assets`、`bulletTypes`）。
- 所有可見字串（按鈕、標籤、tooltip、placeholder、確認/錯誤訊息、選單、空狀態說明）都走 `t()`；**不翻譯**：JSON 欄位名、表達式變數/函式名、sprite/音效名。
- `onLocaleChange` 時各面板重繪自身（不得重建 store、不得丟失選取與捲動位置）。
- 工具列提供語系下拉（`LOCALES`）。切換語系時，若使用者沒有手動改過戰鬥語言，預覽的戰鬥語言跟隨 `battleLangFor(locale)`。
- 引擎錯誤訊息（validateAttack、表達式錯誤）維持引擎產生的文字，不在此範圍。

## 8. 操作

方向鍵 / WASD 移動；按住 X 或 Shift 低速（`slowSpeed`）。Esc 暫停（play.html）。
