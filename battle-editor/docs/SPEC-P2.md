# DR Battle Editor — Phase 2 Spec（遭遇戰：演出指令 + 完整回合）

Phase 1 的 `docs/SPEC.md` 仍然有效（攻擊檔、引擎、字體、語言、編輯器 i18n）。本文件新增「遭遇戰」層：
一場遭遇 = 隊伍與敵人「演員」+ 回合流程（選單 → 行動結算 → 敵人台詞 → 彈幕回合）+ 掛在各種時機上的**演出指令**。
彈幕回合直接沿用 Phase 1 的攻擊檔與 `sim.js`。改動合約前先通知協調者。

## 0. 原則

- 外觀與節奏「像 DELTARUNE」，不復刻官方程式。實機畫面之後由使用者提供，再微調；先求結構對、可擴充。
- **一切行為由資料驅動**：選單、ACT 結果、敵人台詞、走位、動畫都寫在遭遇檔裡，引擎只提供指令。
- 引擎遭遇層與 Phase 1 一樣：模擬不碰 DOM，可 Node 無頭執行，可用「輸入腳本」決定性重播。
- 30 FPS 固定步長。座標同 640×480。
- 文字欄位（名字、台詞、說明）可為字串，或 `{ "zh": "...", "en": "..." }` 依戰鬥語言取用；`zh` 為簡體。

## 1. 遭遇檔 `dr-battle-encounter/1`

```jsonc
{
  "format": "dr-battle-encounter/1",
  "meta": { "name": "鲁丁遭遇", "author": "" },
  "settings": {
    "seed": 1,
    "bgm": "battle",                 // 音效索引名或 null
    "background": null,              // 同攻擊檔：sprite 名或 null（程序化格線）
    "introText": "* 鲁丁挡住了去路！",  // 第一回合選單的旁白（flavor text）
    "canFlee": false
  },
  "actors": {                        // 演員定義：位置 + 動畫狀態表
    "kris":   { "kind": "party", "x": 92, "y": 160, "anims": { "idle": { "sprite": "spr_krisb_idle", "fps": 5, "loop": true }, "attack": { "sprite": "spr_krisb_attack", "fps": 15, "loop": false, "then": "idle" } } },
    "rudinn": { "kind": "enemy", "x": 520, "y": 200, "anims": { "idle": { "sprite": "spr_rudinn_idle", "fps": 5, "loop": true }, "hurt": { "sprite": "spr_rudinn_hurt", "fps": 1, "loop": false, "then": "idle" } } }
  },
  "party": [
    { "id": "kris", "actor": "kris", "name": "Kris", "hp": 90, "maxHp": 90, "atk": 10, "def": 2, "magic": 0,
      "color": "#00ffff", "icon": null, "commands": ["fight", "act", "item", "spare", "defend"] }
    // Ralsei/Noelle 類角色用 "magic" 取代 "act"；"spells": [{ id, name, tp, target: "enemy"|"party"|"all", cues }]
  ],
  "enemies": [
    { "id": "rudinn", "actor": "rudinn", "name": "Rudinn", "hp": 120, "maxHp": 120, "atk": 5, "def": 0,
      "mercy": 0, "spareAt": 100, "tired": false,
      "acts": [
        { "id": "check", "name": "Check", "text": "* RUDINN - 攻击 5 防御 0\n* 菱形的家伙。", "cues": [] },
        { "id": "compliment", "name": "Compliment", "party": ["kris"], "mercy": 50,
          "cues": [ { "cmd": "say", "text": "* 你称赞了鲁丁的光泽。" }, { "cmd": "anim", "actor": "rudinn", "anim": "happy" } ] }
      ],
      "onHurt": [], "onSpare": [], "onDefeat": []
    }
  ],
  "items": [ { "id": "darkburger", "name": "Dark Burger", "count": 2, "heal": 70, "revive": false, "target": "party", "text": "* Kris 吃了黑暗汉堡。" } ],
  "turns": [
    { "id": "t1",
      "flavor": "* 鲁丁在闪闪发光。",           // 該回合選單旁白（覆蓋 introText 之後的預設）
      "talk": [ { "actor": "rudinn", "text": "要来点\n闪光吗？" } ],   // 敵人台詞泡泡（行動結算後、彈幕前）
      "attack": "spade-rain",                   // 攻擊檔名（/api/attacks 或 samples/），或內嵌攻擊物件，或 null（無彈幕）
      "start": [], "beforeAttack": [], "end": [] } // 選單前 / 敵人台詞後、彈幕前 / 彈幕結束後
  ],
  "turnOrder": "loop-last",                     // sequential（用完即循環）| loop-last（停在最後一個）| random（以 seed）
  "hooks": { "intro": [], "victory": [], "spared": [], "defeat": [], "flee": [] },
  "vars": { "complimented": 0 }                 // 自訂變數初值（指令 set / 條件 if 使用）
}
```

**隊員頭像（`party[].icon`，選用）**：填寫頭像 sprite 名稱。省略或設為 `null` 時，使用角色專用頭像或待機動畫第一幀的頭部。指令圖示不會代替頭像。

**演員形態（`actor.forms`，選用）**：同一個演員可宣告多組動畫，用來做變身／換裝。

```jsonc
"rudinn": {
  "kind": "enemy", "x": 520, "y": 200,
  "anims": { "idle": { "sprite": "spr_rudinn_idle", "fps": 5 } },   // 基礎動畫
  "form": "normal",                                                  // 初始形態；省略＝不使用 forms
  "forms": {
    "normal": { "anims": {} },                                       // 空 = 全部沿用基礎動畫
    "baked":  { "scale": 1, "offset": { "x": 0, "y": -21 },          // 選用：縮放／繪製位移
                "anims": { "idle": { "sprite": "spr_bakesale_rudinn", "fps": 6 } } }
  }
}
```

- 形態內每個 `anims` 條目與基礎動畫同格式（`sprite/fps/loop/then/frames?/duration?/scale?/flip?`）；**形態內沒定義的動畫退回 `actor.anims` 的同名動畫**。
- `form` 是初始形態，必須是 `forms` 的鍵；沒有 `forms` 時 `form` 會被正規化為 `null`。`validateEncounter()` 會回報未知形態名。
- `scale` 會乘上演員本身 scale；`offset` 只影響繪製位置（`getState()` 的 `x/y` 已含位移，世界內部座標不變）。
- 切換形態用 cue `form`（見 §3）；也可用 `if` + `set` 依變數決定切哪個形態（沿用既有指令與表達式，不需要新運算式系統）。
- `getState().actors[]` 會帶目前形態名 `form`（基礎動畫為 `null`）。

所有欄位皆有預設，`normalizeEncounter()` 補齊；`validateEncounter()` 回傳 `[{ path, message }]`（路徑格式同 Phase 1，如 `enemies[0].acts[1].cues[0].actor`）。

## 2. 回合流程（flow 狀態機）

```
intro(hooks.intro) → turnStart(turn.start) → menu → resolve → enemyTalk → beforeAttack(turn.beforeAttack) → attack → turnEnd(turn.end) → 判定 → turnStart …
                                                                                     ↘ victory / spared / defeat / flee
```

- **menu**：依序為每位存活隊員選指令（DELTARUNE 式：底部該隊員面板升起顯示按鈕列；X 取消回上一位）。
  - `fight` → 選敵人；`act` → 選敵人 → 選 ACT（需要的隊員 `party` 會一起被佔用）；`magic` → 選法術 → 選目標（耗 TP）；
    `item` → 選道具 → 選隊員；`spare` → 選敵人；`defend` → 直接（回復 TP 16%，本回合受傷減半）。
  - 選單時畫面下方顯示旁白文字（turn.flavor，否則 settings.introText）。
- **resolve**（依 DELTARUNE 順序）：spare/act/magic/item 依隊伍順序演出，再處理所有 `fight`：
  - **FIGHT 攻擊條**：每位選 fight 的隊員一條從右向左移動的標記。按 Z 時隊員出手，同幀顯示判定與傷害；逾時顯示 MISS，不出手也不扣血。與目標線距離決定倍率（完美=150%、差=最低 ~30%）。傷害 = `round(atk * 倍率 * 某常數 - enemy.def*3)`，下限 1。命中時敵人播 `hurt` 動畫、跳傷害數字、`onHurt` 指令；HP≤0 → `onDefeat`，演員淡出，該敵人移除。
  - **ACT**：顯示 `act.text`（若有），執行 `act.cues`，`mercy` 加到敵人 mercy（上限 100）。`autoAnim: false` 時由 cues 安排動作，不播放隊員的通用 ACT 動作。
  - **SPARE**：操作者在結算時播 `spare`（未定義時保留原動畫）。mercy ≥ spareAt（或 tired 且用法術安撫，Phase 2 不做）→ 敵人 `onSpare` 並移除；否則顯示「* 你试图饶恕……但没有成功。」類旁白。
  - **ITEM**：回復 HP，顯示 `item.text`，`count` 減 1（0 時從清單消失）。HP 從 0 恢復時，隊員解除倒下狀態並恢復循環待機。
- **enemyTalk**：`turn.talk` 的泡泡依序（或同時：`"parallel": true`）顯示，Z 推進或自動逾時。
- **attack**：戰鬥框從隊伍處展開（約 10 幀補間）→ 以 `turn.attack` 執行 Phase 1 彈幕回合（同一份 `sim.js`）；受傷扣**目標隊員**（Phase 2：隨機存活者，以 seed；defend 者減半），TP 擦彈累積到遭遇的 TP。結束後框收回。
- **turnEnd**：`turn.end` 可續接彈幕（含巢狀指令）。防禦持續到最後一段完成，仍在防禦姿勢的存活隊員恢復待機，再執行後續台詞或動畫。
- **判定**：所有敵人被移除 → 若曾擊倒任一敵人 `victory` 否則 `spared`；所有隊員 HP≤0 → `defeat`（倒下的隊員不會隨回合自動恢復 HP）。`victory`／`spared` 各跑對應的終局掛鉤，再於底部文字框顯示「* 你赢了！」；玩家確認後送出 `end` 事件。演出指令 `end` 仍可立即結束。
- 隊伍 HP / TP 在整場遭遇中持續，不因回合重置。

## 3. 演出指令（cue）

指令清單 = 陣列；每條 `{ "cmd": "...", ...參數, "async": false }`。預設**依序執行，阻塞到完成**；`async: true` 則啟動後立刻接下一條。

| cmd | 參數 | 完成條件 |
|---|---|---|
| `say` | `text`, `speaker?`, `portrait?`（sprite 名）, `speed?`（字/幀，預設 1）, `voice?`（音效名，每字播） | 打完字且玩家按 Z（打字中按 Z = 立即顯示全部） |
| `bubble` | `actor`, `text`, `side?`（left/right/auto）, `speed?`, `wait?`（"input" 預設 \| 秒數） | 同上，或逾時 |
| `move` | `actor`, `x?`, `y?`, `relative?`(bool), `duration`(秒), `ease?` | 補間結束 |
| `anim` | `actor`, `anim`（狀態名）或 `sprite`, `fps?`, `loop?`, `waitEnd?`(bool) | 立即；`waitEnd` 時等非循環動畫播完 |
| `form` | `actor`, `name`（形態名）, `anim?`（切換後要播的動畫，預設沿用目前動畫名） | 立即；切換整組動畫，找不到同名動畫時退回 `idle`；未知形態回報 `error` 事件不出錯中斷 |
| `flip` | `actor`, `value` | 立即 |
| `fade` | `actor`, `alpha`, `duration` | 補間結束 |
| `wait` | `seconds` | 時間到 |
| `sfx` | `sound` | 立即 |
| `bgm` | `track`（null = 停）, `fade?` | 立即 |
| `shake` | `amount`, `duration` | 時間到 |
| `flash` | `color`, `duration` | 時間到 |
| `set` | `var`, `value`（數字或表達式）, `op?`（set/add） | 立即 |
| `mercy` | `enemy`, `amount` | 立即（夾在 0..100） |
| `heal` / `damage` | `target`（隊員或敵人 id，或 "party"）, `amount` | 立即（跳數字） |
| `if` | `cond`（表達式）, `then`[], `else`[] | 子清單完成 |
| `parallel` | `cues`[] | 全部子指令完成 |
| `attack` | `attack`（同 turn.attack） | 該段彈幕結束（腳本內插入一段彈幕） |
| `end` | `result`（victory/spared/defeat/flee） | 立即結束遭遇 |

**`turn.attack` 與 `attack` cue 的差別／什麼時候用哪個**

- `turn.attack`：這個回合「選單結算後」固定播的那一支彈幕（標準流程的 `attack` 階段）。一般回合用它就好。
- `attack` cue：在 cue 腳本的**任意位置**插一段彈幕（`turn.start`、`turn.end`、hook、ACT 的 `cues`…），播完才繼續下一個 cue。
  用在：開場演出後馬上來一波、同一回合要播兩支以上、**最後一回合想在選單前先播一支**（demo 的回合數不能超過 `turns.length`，
  所以「3 回合遭遇要展示第 4 支攻擊」請把它放進某個回合 `start` 的 `attack` cue，或直接新增一個回合）。
- 兩者可以並用（`turn.attack` 為 `null` 也合法）。工具都認得 cue 裡的攻擊：編輯器時間軸總覽會預載並畫出攻擊段，
  `dr_simulate` 的 `perTurn[].attacks` 與 `dr_difficulty` 的逐回合報告會列出實際播出的攻擊名，作品包／可遊玩 HTML 匯出也會一併打包。
- `if` 的 `cond` 寫 `var.x` 或 `vars.x` 都可以（編譯時 `var.` 會改寫成 `vars.`，兩者等價）。

- 條件/數值表達式沿用 Phase 1 的詞法白名單（`engine/expr.js`），額外可用：`turn`、`var(name)`、`mercy(id)`、`hp(id)`、`maxHp(id)`、`alive(id)`、`tp`、`actCount(enemyId, actId)`（本場已用次數）、`rand(a,b)`。名稱以字串字面量傳入會被白名單拒絕 → **改用識別字形式**：`var.complimented`、`mercy.rudinn`、`hp.kris`、`alive.rudinn`、`actCount.rudinn_compliment`（白名單擴充：`var mercy hp maxHp alive actCount` 允許接任意 `[A-Za-z_][A-Za-z0-9_]*` 屬性，屬性名在求值時查表，查不到為 0）。
- 文字標記：`\n` 換行；`{w:N}` 停 N 幀；`{s:N}` 之後速度 N 字/幀（可小數）；`{c:yellow}`…`{/c}` 顏色（名稱或 #hex）；`{i}` 立即顯示到下一個 `{w}`。
- 演員動畫狀態：`anims` 內每個狀態 `{ sprite, fps, loop, then? }`；未定義的狀態退回 `idle`。有 `forms` 的演員，目前形態內未定義的狀態先退回基礎 `anims` 的同名狀態，再退回 `idle`。隊員內建狀態名：`idle attack act magic item spare defend hurt down victory`，敵人：`idle hurt spared defeat` + 自訂。流程會自動切換這些狀態（例如 fight 結算時隊員播 `attack`，受傷播 `hurt`）。
- 內建動作在流程觸發時播一次，待機仍可循環。具名 `anim` cue 可覆寫 `fps` 和 `loop`；內建動作和直接指定的 `sprite` 預設播一次，cue 上明確設定 `loop: true` 可要求循環。
- 動畫 `loop` / `then` / `frames` 語意：`loop: true`＝幀號循環播放；`loop: false`＝**播一次**：有 `then` 就播完自動切到該狀態（例如 `attack → idle`），沒有 `then` 就停在最後一幀直到被別的 `anim` 指令／流程切走（防禦、勝利、DOWN 等）。`frames` 是動畫總幀數；**省略時由遭遇世界向素材索引查該 sprite 的實際幀數**（`spriteFrames(name)`，由 `assets` 自動提供），只有查不到時才退回 `duration`，再退回 1 秒。非循環動畫的顯示幀永遠夾在最後一幀、**不取模**；`waitEnd`（cue 的 `anim`）等的是非循環動畫播完（有 `then` 時到切換為止）；循環動畫的 `waitEnd` 立即完成。

## 4. 引擎模組與 API（擁有者見 §7）

```js
// engine/encounter/index.js
import { createEncounter, normalizeEncounter, validateEncounter, CUE_COMMANDS } from './engine/encounter/index.js';
const enc = createEncounter({ canvas, assets, resolveAttack: async (name) => json });   // canvas: null = 無頭
await enc.load(encounterJson);      // 會預先 resolve 所有 attack 參照
enc.play(); enc.pause(); enc.reset();
enc.step(n = 1, input?);            // 無頭/測試：input = { press: ['confirm'|'cancel'|'up'|'down'|'left'|'right'], hold: {...} }
enc.getState();                     // 見 §5
enc.setOptions({ lang, showHitboxes, muted, scale });
enc.on('phase'|'end'|'error'|'frame', cb);
enc.debug.jumpToTurn(i); enc.debug.runCues(cues); enc.debug.setVar(name, v);   // 編輯器預覽用
enc.destroy();
```

內部（E1 ↔ FL 之間的接縫，兩邊平行開發）：

```js
// engine/encounter/world.js（E1）— 遭遇世界：演員、文字框、泡泡、變數、隊伍/敵人狀態、子彈回合
export function createWorld(encounter, { rng, fps, resolvedAttacks, spriteFrames, onEvent }) → world
world.actors.get(id) / world.actors.setAnim(id, name) / world.actors.list()
world.text.say(opts) → handle      world.text.bubble(opts) → handle   world.text.clear()
world.party / world.enemies / world.items / world.vars / world.tp
world.startAttack(ref) → handle    // 內部建立 Phase 1 createSimulation，同步隊伍 HP/TP；handle.done
world.damageNumber(x, y, text, color)
world.update(input)                // 每幀：演員補間、動畫、打字機、子彈回合
world.snapshot()                   // 產生 §5 的大部分欄位
// handle = { done: boolean, cancel() }

// engine/encounter/cues.js（E1）
export function createCueRunner(world, { evalExpr }) → runner
runner.run(cues, { label }) → handle;  runner.update(input);  runner.busy()

// engine/encounter/flow.js（FL）
export function createFlow(world, runner, encounter) → flow
flow.update(input)                 // 每幀推進狀態機
flow.snapshot()                    // { phase, turn, menu, fight, result }
flow.on(evt, cb)                   // 'phase' 'end'
```

`createEncounter`（E1 寫 index.js）每幀：`world.update(input)` → `runner.update(input)` → `flow.update(input)`；`getState()` = `world.snapshot()` + `flow.snapshot()` + 彈幕回合進行中時合併 Phase 1 `getState()` 的 `box/soul/bullets/shake/sfxQueue`。

### 4.1 快照 / 還原（`snapshot()` / `restore()`，V2-08）

遭遇戰也有完整狀態快照，內容是三層的總和，全部是純資料（`structuredClone` / JSON 可序列化）：

```js
const snap = enc.snapshot();   // 未 load 時回 null
enc.restore(snap);             // 回 boolean；前提是已 await load() 同一份遭遇檔
```

- **世界層**（`world.snapshotState()`）：幀號、語言、回合、TP、變數、`actCounts`、隊員 / 敵人的
  執行期欄位（HP / mercy / defending / action / down / removed …）、道具數量、傷害數字、
  flash / fade / shake / boxAnim、音效佇列、BGM、RNG 狀態、**演員狀態**（位置 / 補間 / 動畫進度 /
  形態 form / 透明度 / 可見度 / hurtShake）、**文字系統**（文字框與泡泡的內容、講者、位置、
  打字機的 `pos` / 揭示進度 / 等待計數）、以及**內嵌的彈幕回合快照**（含 RNG 與 queue 狀態）
- **cue 執行器**（`runner.snapshotState()`）：進行中的指令鏈（含 `wait` / `shake` / `flash` 的
  計時器、`if` 分支、`parallel` 子序列、`say` / `bubble` 的 handle 對應、`attack` 的完成旗標），
  以及 async 指令清單
- **流程層**（`flow.snapshotState()`）：階段、回合、結果、計時器、選單（游標 / 清單堆疊 / 已選行動）、
  FIGHT 攻擊條（每條 x / targetX / 結果 / 掛鉤佇列）、resolve 排程（含「完成後才執行」的延後動作
  ——加 mercy、記錄 ACT、移除敵人），以及 flow 自己的 RNG

**限制**：快照與遭遇檔綁定（演員定義 / 回合 / 指令清單要一致），換一份遭遇檔不能還原；
還原順序固定為 world → runner → flow，呼叫端不需要自己排；`restore()` 不會重播已發生的事件
（`say` / `bubble` / `phase` / 音效都不會多發一次）；內部不含渲染器 / 輸入 / 音效裝置狀態
（那些由呼叫端重設）。實作見 `engine/encounter/{world,cues,flow,text,actors,menu,fight}.js`；
決定性測試見 `tests/snapshot/`。

## 5. `getState()` 遭遇形狀（渲染唯一資料來源）

```js
{
  frame, lang,
  phase,                       // 'intro'|'turnStart'|'menu'|'resolve'|'enemyTalk'|'attack'|'turnEnd'|'victory'|'spared'|'defeat'|'flee'
  turn,                        // 0 起算
  actors: [ { id, kind, sprite, idleSprite, frame, anim, animLoop, animFrames, x, y, flip, alpha, scale, layer, visible, hurtShake, form } ],
  // form = 目前形態名（actor.forms）；沒有 forms 或基礎動畫時為 null。x/y 已含形態 offset、scale 已含形態 scale。
  // animLoop:false = 非循環動畫；繪製端把 frame 夾在素材最後一幀（animFrames = 0 表示幀數未知）
  party:  [ { id, actor, name, hp, maxHp, color, icon, down, defending, action /*本回合選的指令 或 null*/ } ],
  enemies:[ { id, name, hp, maxHp, mercy, spareable, removed } ],
  tp,
  textbox: null | { lines: [ { text, color } ], visibleChars, done, speaker, portrait },   // 底部對話/旁白
  bubbles: [ { actor, x, y, side, lines, visibleChars, done } ],
  menu: null | {
    member,                    // 正在選擇的隊員索引
    buttons: [ { id: 'fight'|'act'|'magic'|'item'|'spare'|'defend', enabled } ], cursor,
    list: null | { kind: 'enemy'|'act'|'magic'|'item'|'party', title, items: [ { label, sub, enabled, mercy?, hpPct?, member? } ], cursor, page }
  },
  fight: null | { bars: [ { member, color, x /*標記位置*/, targetX, result: null|'perfect'|'good'|'ok'|'miss' } ] },
  numbers: [ { x, y, text, color, age } ],          // 傷害/回復數字
  battle: null | { box, soul, bullets, shake, sfxQueue },   // 彈幕回合進行中時 = Phase 1 形狀
  boxAnim: 0..1,                                      // 戰鬥框展開進度
  fade: { color, alpha }, flash: { color, alpha },
  result: null | 'victory'|'spared'|'defeat'|'flee'
}
```

## 6. 編輯器（遭遇編輯器）

- 新頁 `encounter.html`（與 `index.html` 攻擊編輯器並列，兩頁頂部互相連結）。沿用 Phase 1 的深色版面、i18n（`editor/i18n.js`，三語）、store 模式。
- 版面：左＝遭遇結構樹（設定 / 演員 / 隊伍 / 敵人→ACT / 道具 / 回合 / 時機掛鉤）；中＝預覽（`createEncounter` 實際可玩；工具列：重來、跳到第 N 回合、執行所選指令清單、顯示變數/狀態除錯面板、語言切換）；右＝檢查器；下＝**指令清單編輯器**（編輯目前選中的 cues 陣列）。
- **指令清單編輯器**：每條指令一張卡片（圖示+摘要），可拖曳排序、複製/貼上、刪除、`async` 開關；`if`/`parallel` 卡片可展開巢狀子清單；新增選單依類別分組（文字、演員、音效、流程、數值）；欄位表單依 §3 表格產生；`actor` 欄位下拉列出演員，`attack` 欄位列出 /api/attacks 與 samples；文字欄位可切換「單一 / 中英分開」。
- 演員編輯：動畫狀態表（新增/刪除狀態、選 sprite、fps、loop、then），即時小預覽；可直接在預覽畫面拖曳演員初始位置。有 `forms` 的演員另有**形態**區塊：新增/改名/複製/刪除形態、設定初始形態、切換目前編輯的形態（基礎動畫＋各形態分頁）、預覽切換、形態 `scale`/`offset` 欄位；形態內未覆寫的動畫列會標示「沿用基礎」。
- 遭遇時間軸總覽：底部分頁「時間軸」以 headless 模擬（demo／bot）跑一次遭遇，每回合一列顯示台詞（依打字速度估算）與彈幕（實際模擬時間，讀 `settings.duration`）長條、該回合的 cue 標記（ACT／形態切換／BGM 變更等）；攻擊有 `settings.bpm` 時畫拍線（`beatOffset` 以拍為單位）。點一列可跳到該回合編輯。
- 工具列：作品包匯出／匯入（`/api/pack/*`，匯入衝突可選 abort／rename／overwrite）與可遊玩單檔 HTML 匯出（`/api/export/game`，按鈕由 `tools/web/export-button.js` 掛載）。
- 存檔：`/api/encounters`（與 attacks 相同的 GET 清單 / GET / PUT，存於 `battle-editor/encounters/`），匯入/匯出 JSON，自動暫存。
- 驗證：`validateEncounter` 與遭遇 `error` 事件 → `store.errors`，結構樹與卡片標紅。

## 7. 素材（UTMT 補拆）

- 戰鬥相關 sprite **全幀 + 真實原點**：四位主角戰鬥動作（`spr_krisb_* spr_susieb_* spr_ralseib_* spr_noelleb_*`）、各章敵人戰鬥 sprite、選單按鈕（`spr_btfight spr_btact spr_btitem spr_btspare spr_btdefend spr_bttech` 及其高亮幀）、對話框/泡泡、攻擊條（target/attack press 相關）、傷害數字字型、HP/mercy 條、靈魂與其他戰鬥 UI。
- 輸出到 `assets/sprites-full/<name>/<i>.png` + `assets/sprites-full.index.json`（同 Phase 1 §2 格式，`originVerified: true`）。W2 的 `build_assets.py` 合併時**以 sprites-full 覆蓋**同名項的 frames/ox/oy。
- 另產 `assets/actor-presets.json`：四位主角與常見敵人的建議 `anims` 狀態表（直接可貼進遭遇檔 `actors`）。

## 8. 檔案歸屬（Phase 2）

| 代號 | 提供者 | 擁有檔案 |
|---|---|---|
| E1 遭遇核心 | opendesign1 | `engine/encounter/index.js world.js cues.js actors.js text.js schema.js`、`engine/expr.js`（擴充白名單）、`tests/encounter/**` |
| FL 回合流程 | opencode-go | `engine/encounter/flow.js menu.js fight.js`、`tests/encounter-flow/**` |
| E2 遭遇渲染 | opendesign2 | `engine/render-encounter.js`、`engine/render.js`（只加呼叫掛鉤）、`engine/audio.js`（bgm）、`encounter-play.html` |
| ED1 遭遇編輯器骨架 | opendesign1 | `encounter.html`、`editor/encounter/main.js preview.js fileops.js layout.css`、`editor/locales/encounter-app.js`、`editor/store.js`（如需泛化，保持 Phase 1 相容）、`index.html`（只加跳轉連結） |
| ED2 指令清單編輯器 | opendesign2 | `editor/encounter/cue-editor.js cue-schema.js cue-editor.css`、`editor/locales/cues.js`、測試 |
| ED3 遭遇資料面板 | opendesign1 | `editor/encounter/tree.js inspector.js actor-editor.js panels.css`、`editor/locales/encounter-panels.js`、測試 |
| W2 伺服器/範例/合併 | opendesign2 | `serve.py`、`samples/**`（含新 `samples/encounters/`）、`tools/build_assets.py` |
| A3 素材補拆 | opencode-go | `tools/sprites_full/**`、`assets/sprites-full/**`、`assets/sprites-full.index.json`、`assets/actor-presets.json` |

- `engine/encounter/` 不得 import DOM；渲染只讀 §5 的 state。
- ED2 的 `cue-schema.js` 指令清單必須與引擎 `CUE_COMMANDS` 一致（ED2 寫測試比對）。
- 共同規則：不 commit；不改不屬於自己的檔案；臨時檔放系統 TEMP；不 spawn 子代理。
