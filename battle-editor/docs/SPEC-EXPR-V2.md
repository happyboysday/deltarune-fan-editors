# SPEC-EXPR-V2 — 拍點單位與子彈運算式擴充（V2-03）

> 2026-11-09。對應 `docs/ROADMAP-V2.md` §1「拍點單位」「子彈運算式」兩條決策與 §2 V2-03。
> 本文件是 `docs/SPEC.md` §4/§5 的**覆蓋層**：原有規則仍有效，這裡只新增「拍點時間單位」與「子彈運算式的額外唯讀變數」。
> 引擎已實作（`engine/expr.js`、`engine/attack.js`、`engine/sim.js`），測試在 `tests/engine/t-expr-v2.mjs`。

---

## 0. 相容性承諾

1. **沒用到新功能 = 行為不變。** 沒寫 `settings.bpm`、時間欄位全是數字時，模擬結果與舊版逐幀相同（4 個 `samples/*.json` 的模擬簽章在改動前後完全一致）。
2. **`i` / `n` / `k` 語意不變**：這三個變數原本就有，本版只是把它們和兩個新變數一起在文件裡講清楚。
3. **原始 JSON 不改寫。** 拍點字串的換算只發生在 `normalizeAttack()` 產生的執行用物件裡；攻擊檔存檔仍保留 `"2b"` 這種寫法（編輯器讀寫原始 JSON）。
4. **表達式沙箱不變。** 新變數只是白名單新增名稱；詞法驗證、賦值禁止、原型鏈防線都照舊。

---

## 1. 拍點單位（BPM）

### 1.1 `settings` 新欄位

| 欄位 | 型別 | 預設 | 說明 |
|---|---|---|---|
| `bpm` | 正數 或 `null` | `null` | 每分鐘拍數。設定後時間欄位才可以用拍點字串。 |
| `beatOffset` | 數字（秒） | `0` | 拍點位移。**只加在「時間點」欄位**（`at`、`demo.path[].t`），長度類欄位不加。可為負數（換算後夾到 ≥ 0）。 |

```json
"settings": { "bpm": 120, "beatOffset": 0.25, "duration": 8, "seed": 1 }
```

### 1.2 拍點字串語法

```
^[+-]?(?:\d+(?:\.\d*)?|\.\d+)b$     （大小寫不敏感、前後空白可容忍）
```

| 寫法 | 結果 |
|---|---|
| `"2b"` | 2 拍 |
| `"1.5b"`、`".5b"` | 1.5 拍、0.5 拍 |
| `"-0.5b"` | −0.5 拍（語法可解析；用在時間點或長度會被驗證器擋下） |
| `"2B"` | 2 拍（`b` 大小寫不敏感） |
| `"2"` | **不是**拍點字串（長度類會被當成 2 秒的數字字串，`at` 會當成秒） |
| `"2 b"`、`"b"`、`"2bb"` | 不是拍點字串；`at` 會報「必須是秒數或拍點字串」 |
| `"beat*4"` | 不是拍點字串；這是**運算式**，只適用於生成欄位（見 §1.6 的 `beat` 常數） |

### 1.3 換算規則

`beatSec = 60 / bpm`

| 欄位種類 | 換算 | 加 `beatOffset`？ | 非法/無 bpm 時正規化結果 |
|---|---|---|---|
| **時間點**：`timeline[].at`、`demo.path[].t` | `beats × beatSec + beatOffset` | ✅ 加 | 0（驗證器另外報錯，不偷偷改節奏） |
| **長度**：`settings.duration`、`emitter.duration`、`emitter.interval`、`box.duration`、`shake.duration`、`clear.fade` | `beats × beatSec` | ❌ 不加 | 各欄位自己的舊預設值：`settings.duration` 由時間軸推算；`emitter.duration` 0；`emitter.interval` 0.25；`box.duration` 0.5；`clear.fade` 0.3；`shake.duration` 0.4 |
| **子彈生命**：`spawn.life`、`emitter.spawn.life` | `beats × beatSec` | ❌ 不加 | `null`（不限） |

補充：

- 數字欄位永遠是「秒」，與有無 `bpm` 無關。
- 時間點換算後夾到 `≥ 0`（`beatOffset` 為負可能把前面的 `at` 推到 0）。
- `at` 也接受**純數字字串**（`"1.5"`、`"0.4"` 這種，向後相容舊檔的寫法），視同秒數。長度類的數字字串同理（`"2"` → 2 秒）。它們都不是拍點字串。
- 哪些欄位**不**接受拍點字串：`box.to.x/y/w/h/rotation`、`soul.x/y`、`demo` 的 `x/y` 等座標欄位，以及 `at` 以外的運算式欄位。它們維持原本的「數字」規則。

### 1.4 驗證錯誤（路徑照舊指向原欄位）

> **提示（info，不是錯誤）**：秒與拍可以混用，但「`settings.bpm` 已設定、其他事件多數用拍點，而 `clear` / `end` 的 `at` 是純秒數」
> 通常是忘了換算（回合會提早清場／結束）。`engine/attack.js` 的 `attackHints(doc)` 會回報這種情況，
> `dr_validate` 把它放在 `hints[]`（附換算後的拍數；不影響 `ok`）。

| 情況 | 路徑 | 訊息 |
|---|---|---|
| 沒 bpm 卻用拍點字串 | `timeline[0].at`、`timeline[0].life`、`timeline[1].duration`、`settings.duration`、`demo.path[2].t` … | `"2b" 是拍點單位，但 settings.bpm 未設定；請在 settings 加上正數 bpm（例如 "bpm": 120），或把 at 改成秒數` |
| `at` 既不是數字也不是拍點字串 | `timeline[0].at` | `at 必須是秒數或拍點字串（例如 1.5 或 "2b"）` |
| `at` / 長度為負 | 該欄位 | `at 不可為負數`、`life 不可為負數` |
| `bpm` 不是正數 | `settings.bpm` | `bpm 必須是大於 0 的數字（例如 120）` |
| `beatOffset` 不是數字 | `settings.beatOffset` | `beatOffset 必須是數字（秒）` |
| `emitter` 的拍點 `duration`/`interval` 換算後 ≤ 0 | `timeline[i].duration` / `.interval` | `emitter 需要大於 0 的 duration` / `interval` |

### 1.5 正規化與存檔

```js
import { normalizeAttack } from './engine/attack.js';

const raw = { /* 攻擊檔，時間欄位可能是 "2b" */ };
const runnable = normalizeAttack(raw);   // 所有時間欄位都是秒；demo.path[].t 也是秒
raw.timeline[0].at;                       // 仍是 "2b"（原始 JSON 沒被改）
runnable.settings.bpm;                    // 120（或 null）
runnable.settings.beatOffset;             // 數字
```

- 引擎（`createSimulation` / `createBattle`）內部只看到秒。
- `deriveDuration()` 也會用拍點換算推算回合長度（`at` 加 offset、長度不加）。
- 沒 bpm 而時間欄位是拍點字串時，正規化給安全值（時間點 0、長度用預設），**錯誤交給 `validateAttack()` 回報**；模擬不會因此中斷。

### 1.6 運算式常數 `bpm` / `beat`

| 名稱 | 值 | 沒設定 `bpm` 時 |
|---|---|---|
| `bpm` | `settings.bpm` | `0` |
| `beat` | `60 / bpm`（秒） | `0` |

兩者都是唯讀數字，可在**生成欄位**（`x`、`angle`、`speed`、`life`…）與**每幀的 `pathX`/`pathY`** 使用：

```json
"spawn": { "bullet": "drop", "angle": "beat*90", "speed": "bpm/60", "life": "beat*4" }
```

`at`、`duration`、`interval` 這類「排程欄位」**不吃運算式**（只吃數字或 `"Nb"`）；要 BPM 對齊請用 `"2b"` 或固定拍數的 `interval`。想在排程上用運算式（例如 `at: "beat*4"`）目前不支援，`validateAttack` 會回報「at 必須是秒數或拍點字串」。

---

## 2. 子彈運算式的額外變數

`docs/SPEC.md` §5 的變數之外，本版新增（全部唯讀）：

| 名稱 | 型別 | 生命週期 | 說明 |
|---|---|---|---|
| `spawnX` | 數字 | 生成時固定 | 本發子彈的生成 `x`（`spawn.x` 求值後；省略時為戰鬥框中心 `box.x`）。生成欄位與每幀 `pathX`/`pathY` 都讀得到。 |
| `spawnY` | 數字 | 生成時固定 | 同上，生成 `y`。 |
| `spawnT` | 數字（秒） | 生成時固定 | 本發子彈的生成時間，＝生成該幀的**回合時間** `frame / 30`。與 `t`（事件開始後的相對秒數）不同；有 `beatOffset` 或其他事件位移時，`spawnT` 反映實際時間軸位置。 |
| `bpm` | 數字 | 全場 | 見 §1.6。 |
| `beat` | 數字（秒） | 全場 | 見 §1.6。 |
| `mem` | 唯讀查表物件 | 生成時固定 | `mem.<name>`：每顆子彈的記憶，由 spawn 的 `memory` 在生成時求值一次（見 §2.2）。沒定義的名字讀到 `0`。 |

既有且語意不變的變數（一併列出避免混淆）：

| 名稱 | 說明 |
|---|---|
| `t` | **事件**開始後經過的秒數（spawn 事件為 0；emitter 為該輪觸發時間 − 事件 `at`）。 |
| `T` | 回合總秒數（`settings.duration`）。 |
| `i` | 本次生成批次的序號（`0 … n-1`）。 |
| `n` | 本次生成批次的數量。 |
| `k` | emitter 第幾輪觸發（`0` 起算；`spawn` 事件固定 0）。 |
| `age` | 子彈存活秒數（僅 `pathX`/`pathY` 每幀求值時有意義）。 |
| `x` / `y` | 生成流程中「已求值」的座標（供 `aim(x, y)` 與後續欄位使用；求值順序：`x` → `y` → `spawnX/spawnY/spawnT` → `memory` → 其他生成欄位）。 |

### 2.1 使用時機

| 上下文 | `spawnX/Y` | `spawnT` | `i`/`n`/`k` | `bpm`/`beat` | `mem.*` |
|---|---|---|---|---|---|
| 生成時（`x`、`y`、`speed`、`angle`、`life`、`memory`…） | ✅（`x`/`y` 求值後） | ✅ | ✅ | ✅ | ✅（`memory` 先求值，之後欄位可讀） |
| 每幀 `pathX` / `pathY` | ✅ 固定值 | ✅ 固定值 | ✅ | ✅ | ✅ 固定值 |

`pathX`/`pathY` 的結果仍是「相對生成點的位移」：`x = spawnX + pathX`。因此 `pathX: "(soul.x - spawnX) * age"` 代表「從生成點往靈魂當前位置收束」，不需要 `box.x - soul.x` 這類繞路。

### 2.2 `memory`：每顆子彈的記憶

spawn 定義（`spawn` 事件本身或 `emitter.spawn`）可以多一個 `memory` 欄位：

```json
"spawn": {
  "bullet": "orb",
  "x": "box.x", "y": "box.y",
  "memory": { "a0": "i*90 + k*20", "dir": "rand(0, 360)" },
  "angle": "mem.a0",
  "speed": 1.2,
  "life": "3b",
  "pathX": "sin(age*200 + mem.a0) * 46"
}
```

規則：

1. **生成時求值一次**，結果固定在該顆子彈上；之後 `pathX`/`pathY` 每幀讀到的都是同一個值（不會隨 `age`、`t` 改變）。
2. 名稱必須是合法識別字 `[A-Za-z_$][A-Za-z0-9_$]*`，且不可用 `constructor`、`__proto__`、`prototype`、`toString`、`valueOf`、`apply`、`call`、`bind` 等保留名（表達式沙箱的原型鏈防線）。
3. 值可以是數字或表達式字串。求值順序依 JSON 物件鍵順序；**先算出的名字可以被後面的名字引用**：`{ "a": "3", "b": "mem.a*4" }` → `b = 12`。
4. `memory` 比 `speed`/`angle`/`life`/`pathX` 等欄位先求值，所以生成欄位可以直接用 `mem.*`。
5. `emitter` 的 `memory` 對**每次觸發、每顆子彈各自求值**：`k` 是輪次、`i` 是該輪序號，所以每顆可以不同。
6. 沒有 `memory` 的子彈共用一個「全部為 0」的唯讀物件：讀任何 `mem.<name>` 都得 0，不需要先判斷存在。
7. 某個名稱的運算式錯誤 → 發出 `error` 事件（`field: "memory"`），該名稱取 0，不中斷模擬。`memory` 不是物件、名稱非法、值型別錯誤則在 `validateAttack` 回報。

> **設計陷阱：`soul.x` / `soul.y` 是每幀即時值。** 在 `pathX` / `pathY` 直接讀 `soul.*` 會讓子彈整段時間追著靈魂；
> 要「瞄準生成當下的靈魂位置」請用 `memory` 快照：`"memory": { "tx": "soul.x", "ty": "soul.y" }`，路徑改用 `mem.tx` / `mem.ty`。

### 2.3 唯讀性與沙箱

- 所有新變數都只能讀，表達式不能賦值（沙箱本來就禁止 `=`）。
- `mem` 是唯一允許「任意識別字屬性」的物件；名稱在詞法層過濾，`mem.constructor`、`mem.__proto__` 會被拒（訊息例如 `不允許的屬性名稱 "constructor"`）。
- 不支援多層屬性串接（`mem.a.b` 會被拒），`mem` 的值一律是數字。
- 新變數沒有增加任何可呼叫的函式或建構子；`(0).constructor` 之類的原型鏈攻擊仍被封鎖。

### 2.4 決定性

`bpm`、`beat`、`spawnX/Y/T`、`i/n/k`、`mem` 都**不消耗亂數**；只有 `rand()`/`pick()` 會。所以「同 seed + 同輸入 = 同結果」不變，`seek()` 與逐步 `step()` 結果一致。

---

## 3. 範例

以下三個範例都是完整的攻擊檔，已用引擎實跑驗證：`validateAttack` 0 錯誤、模擬 0 錯誤事件、原始 JSON 未被改寫。

### 3.1 BPM 對齊的雨

`bpm: 120` → 一拍 0.5 秒。主雨每拍 2 發、持續 16 拍；弱拍（半拍位移）再補 1 發，形成「強拍下雨、弱拍點綴」的節奏。

```json
{
  "format": "dr-battle-attack/1",
  "settings": { "bpm": 120, "beatOffset": 0, "duration": 8, "seed": 1, "damage": 8 },
  "box": { "x": 320, "y": 190, "w": 150, "h": 165 },
  "soul": { "x": null, "y": null, "speed": 4, "slowSpeed": 2 },
  "bulletTypes": {
    "drop": { "sprite": null, "frameRate": 0, "scale": 1, "hitbox": { "shape": "circle", "r": 5 } }
  },
  "timeline": [
    {
      "id": "ev_rain", "at": "0b", "type": "emitter",
      "duration": "16b", "interval": "1b", "count": 2,
      "spawn": {
        "bullet": "drop",
        "x": "rand(box.left + 8, box.right - 8)",
        "y": "box.top - 12",
        "angle": 90,
        "speed": "2.2 + i*0.5",
        "life": "4b"
      }
    },
    {
      "id": "ev_offbeat", "at": "0.5b", "type": "emitter",
      "duration": "15b", "interval": "1b", "count": 1,
      "spawn": {
        "bullet": "drop",
        "x": "rand(box.left + 8, box.right - 8)",
        "y": "box.top - 12",
        "angle": 90,
        "speed": 3,
        "life": "3b"
      }
    }
  ]
}
```

重點：

- `at: "0b"` 與 `at: "0.5b"` 分別落在第 0 拍、半拍；`beatOffset` 若改成 `0.25`，兩者一起後移 0.25 秒。
- `duration: "16b"`、`interval: "1b"` 是長度類，**不**加 `beatOffset`。
- `life: "4b"` 讓子彈活 2 秒（4 拍 × 0.5 秒），與速度無關。
- `speed: "2.2 + i*0.5"` 讓同批兩發一快一慢；`i` 語意沿用舊版。

### 3.2 鏡像彈（用 `spawnX` 收束到靈魂）

左右兩發從對稱點出發，各自用 `pathX` 在 1 秒內把 x 收束到靈魂的 x；因為 `pathX` 的基準點是 `spawnX`，不需要 `box.x - soul.x` 的補償。

```json
{
  "format": "dr-battle-attack/1",
  "settings": { "bpm": 100, "beatOffset": 0.1, "duration": 6, "seed": 2 },
  "box": { "x": 320, "y": 190, "w": 150, "h": 165 },
  "soul": { "x": null, "y": null, "speed": 4, "slowSpeed": 2 },
  "bulletTypes": {
    "bomb": {
      "sprite": null, "frameRate": 0, "scale": 1.2,
      "hitbox": { "shape": "circle", "r": 6 },
      "faceVelocity": false
    }
  },
  "timeline": [
    {
      "id": "ev_mirror", "at": "2b", "type": "spawn",
      "count": 2, "bullet": "bomb",
      "x": "box.x + (i*2 - 1)*70",
      "y": "box.top + 24",
      "speed": 0,
      "life": "6b",
      "pathX": "(soul.x - spawnX) * min(age, 1)"
    },
    {
      "id": "ev_mirror2", "at": "4b", "type": "spawn",
      "count": 2, "bullet": "bomb",
      "x": "box.x + (i*2 - 1)*40",
      "y": "box.bottom - 24",
      "speed": 0,
      "life": "4b",
      "pathX": "(soul.x - spawnX) * min(age, 1)"
    }
  ]
}
```

重點：

- `x: "box.x + (i*2 - 1)*70"` → `i=0` 在左（250）、`i=1` 在右（390）。
- `pathX` 的位移是相對 `spawnX`：`x = spawnX + (soul.x − spawnX) × min(age, 1)`，`age = 0` 在生成點、`age ≥ 1` 秒時精準落到 `soul.x`。
- `at: "2b"`、`"4b"` 在 `bpm: 100` + `beatOffset: 0.1` 下是 1.3 秒、2.5 秒。
- 舊寫法需要 `pathX: "(box.x - soul.x) + ..."` 補償生成點偏移；有了 `spawnX` 後直接寫意圖。

### 3.3 記憶初始角度的回旋彈

`memory` 在生成時算一次初始角度 `a0`；之後每幀的螺旋位移都用同一個相位，不會因為每幀重算而抖動。

```json
{
  "format": "dr-battle-attack/1",
  "settings": { "bpm": 140, "duration": 8, "seed": 3, "damage": 9 },
  "box": { "x": 320, "y": 190, "w": 150, "h": 165 },
  "soul": { "x": null, "y": null, "speed": 4, "slowSpeed": 2 },
  "bulletTypes": {
    "orb": { "sprite": null, "frameRate": 0, "scale": 1, "hitbox": { "shape": "circle", "r": 4 } }
  },
  "timeline": [
    {
      "id": "ev_spin", "at": "1b", "type": "emitter",
      "duration": "12b", "interval": "3b", "count": 4,
      "spawn": {
        "bullet": "orb",
        "x": "box.x",
        "y": "box.y",
        "memory": { "a0": "i*90 + k*20" },
        "speed": 1.2,
        "angle": "mem.a0",
        "angularVel": 6,
        "life": "6b",
        "pathX": "sin(age*200 + mem.a0) * 46",
        "pathY": "cos(age*200 + mem.a0) * 46"
      }
    }
  ]
}
```

重點：

- `memory: { "a0": "i*90 + k*20" }`：同一輪 4 發以 90° 均分，每輪再整體轉 20°。
- `angle: "mem.a0"` 是**生成欄位讀 memory**（`memory` 先求值）；`pathX`/`pathY` 每幀運算式也讀同一個 `mem.a0`。
- `pathX`/`pathY` 都是相對 `spawnX`/`spawnY` 的位移，畫出以生成點為中心、半徑 46px 的圓；`age` 讓它持續繞行。
- 若沒有 `memory`，就得在 `pathX`/`pathY` 各自重寫 `i*90 + k*20`（而且 `speed`/`angle` 欄位會因為求值順序不同而對不上）；`memory` 讓「一次算好、多處共用」變成資料而非重複運算式。
- `bpm: 140` 下 `"1b"` = 0.4286 秒、`"3b"` = 1.286 秒、`"6b"` = 2.571 秒；`beat`/`bpm` 沒有直接用到，但 `life`/`duration` 都走拍點，之後改 BPM 即整體縮放。

---

## 4. 實作對照（給維護者）

| 檔案 | 內容 |
|---|---|
| `engine/attack.js` | `parseBeatString()`、`timeToSeconds()`、`beatTimingOf()`（新匯出）；`BEAT_RE`；`normalizeTimeValue()`/`normalizeSpawnLife()`/`normalizeDemo()`/`normalizeMemory()`/`validateTimeField()`（私有）；`SETTINGS_DEFAULTS.bpm/beatOffset`；`normalizeAttack`/`normalizeEvent`/`deriveDuration`/`validateAttack`/`validateEvent` 全面吃 `timing`。 |
| `engine/expr.js` | `VAR_NAMES` 追加 `spawnX/spawnY/spawnT/bpm/beat/mem`；`ALLOWED_PROPERTIES.mem = '*'`（仍過濾 `FORBIDDEN_PROP_NAMES`）；`isValidMemoryName()`、`EMPTY_MEM` 新匯出；`evalNumber()` 的參數順序與 `makeContext()` 同步擴充。 |
| `engine/sim.js` | `exprContext()`/`pathContext()` 帶入新變數；`spawnOne()` 在 `x`/`y` 求值後固定 `spawnX/spawnY/spawnT`，`evalMemory()` 求值 memory 並存到 `b.mem`；`makeBullet()`/`releaseBullet()` 重設 `spawnT`/`mem`。 |
| `tests/engine/t-expr-v2.mjs` | 拍點解析/換算/驗證/實際播放、每個新變數行為、`mem` 只求值一次、鏡像彈、決定性、沙箱，共 42 個測試。 |

`normalizeAttack()` 後 `attack.timeline[].at`、`duration`、`interval`、`spawn.life`、`demo.path[].t` 全部是秒；`attack.settings.bpm` 是正數或 `null`。

## 5. 工具／文件待補（需協調者處理，非本任務檔案範圍）

- `tools/agent/export-schema.mjs`：`VAR_DESC` 是硬編碼字典，要補 `spawnX`、`spawnY`、`spawnT`、`bpm`、`beat`、`mem` 的 `desc`（`x-expressions.variables` 目前這 6 個 `desc` 是空字串）。`settings` 的 JSON Schema properties 也要手動補 `bpm`（`number|null`，`exclusiveMinimum: 0`）與 `beatOffset`（`number`，預設 0）；`x-defaults.settings` 已自動包含兩者。
- `tools/check-samples.mjs`：`checkSpawnFields()` 會把 `memory` 當「不是 SPEC §5 生成欄位」警告，需加例外並驗證其值；`isNumberOrExpr()` 目前不認 `"2b"`，各事件的 `at`/`duration`/`interval`/`life`/`fade` 檢查要放行拍點字串。
- `generated/schema/*.json`：重跑 `node tools/agent/export-schema.mjs` 更新產物。
- `docs/AGENT-GUIDE.md` §4/§5：可各補一句「時間欄位可寫 `"2b"`（需 `settings.bpm`）」與新變數／`memory` 的用法。
