# 自動演示（Autoplay）規格

目標：攻擊與遭遇可以**自動遊玩**，用於演示、錄影、截圖與 Agent 自我驗證。可隨時開關；腳本寫在作品 JSON 裡，人與 Agent 都能編輯。

## 1. 原則

1. **只透過輸入驅動**：自動駕駛每幀產生與鍵盤相同的輸入 `{ press: [...], hold: { left, right, up, down, slow } }`，交給引擎的 `step(n, input)`。不直接改引擎狀態 → 碰撞、受傷、選單游標移動都是「真的」，畫面看起來就像有人在玩。
2. **決定性**：同一份作品 + 同一份腳本 + 同一 seed = 同一結果（錄製重播逐幀一致）。
3. **可開關**：關閉時引擎行為與現在完全相同；`demo` 欄位不存在時一切照舊。
4. **三種躲避模式**：`path`（固定路徑點）、`inputs`（錄製的逐幀輸入）、`bot`（自動閃避 AI）。遭遇另有**固定選擇**（每回合每位隊員選什麼）。

## 2. 資料格式

### 2.1 攻擊檔 `demo`（選填）

```json
"demo": {
  "mode": "path",
  "path": [
    { "t": 0,   "x": 320, "y": 190 },
    { "t": 1.2, "x": 280, "y": 240 },
    { "t": 2.0, "x": 360, "y": 240, "slow": true },
    { "t": 3.5, "x": 320, "y": 160, "hold": 0.4 }
  ],
  "inputs": "0:;12:R;30:RD;45:D;60:DS;90:",
  "fallback": "bot"
}
```

- `mode`：`"path" | "inputs" | "bot"`，自動演示開啟時的預設模式（省略 = 有 path 用 path、否則有 inputs 用 inputs、否則 bot）。
- `path[]`：路徑點，`t` 秒（遞增）、`x/y` 邏輯座標（超出框時會被夾在框內）、`slow` 該段用低速、`hold` 抵達後停留秒數（選填）。
  - 跟隨方式（`engine/autoplay/follow.js`）：每幀朝「依時間在相鄰兩點間線性插值的目標點」**再往前一幀**的點按方向鍵，**不瞬移**；落後時會全速追趕，接近目標（≤ `slowSpeed × 1.5`px）時改用 slow 微調，並逐軸防止過衝。框在移動／縮放／旋轉時用框速度外推下一幀的框、落點先夾進預測框；靈魂被 `soul` 事件瞬移時丟掉舊預測，一律以 `getState().soul` 的**實際座標**為準。
  - 安全微調：若某一步在 0.2 秒內會與子彈重疊，改選別的方向——既有 `demo` 路徑本身可能穿過彈幕（純精確跟隨會中彈），這一項讓「已發佈的路徑」在精度提高後仍 0 受傷，正常情況造成的偏差 < 2px。
  - `slow` 段的語意是「接近目標後用低速微調」；若落後太多會先全速追上再放慢，避免慢速段愈拖愈遠。
  - 需要重新產生路徑時用 `tools/agent/demo-path.mjs`（見 §3.1），不要手動把 AI 閃避軌跡直接貼成 `path`——AI 軌跡轉成路徑點後照走仍會中彈。
- `inputs`：錄製的輸入，**行程長度編碼字串**：`幀:鍵` 以 `;` 分隔，代表從該幀起持續按住的鍵，直到下一個條目；鍵字母 `L R U D S`（S = slow）；單次按下用 `!z`（confirm）`!x`（cancel）`!c`（menu）附加於鍵後，例：`120:R!z`。空鍵 = 放開。
- `fallback`：腳本用完後的行為（預設 `"stay"`）：
  - `"stay"`：改用中性輸入（不按任何鍵），靈魂停在原地、不再被操控；不會自動找安全點。
  - `"bot"`：改用內建閃避 AI（`engine/autoplay/bot.js`）繼續玩到回合結束；切換後不會再回到腳本。
  - 「用完」的判定以 `engine/autoplay/soul.js` 為準：`path` 在 `t >= end` 之後才用 fallback，`end = 最後一點實際開始時間 + 該點的 hold`；中間點的時間會被前一點的 `hold` 往後推（`starts[i] = max(t[i], starts[i-1] + hold[i-1])`），最後一點的 `hold` 期間仍停在該點。`inputs` 在 `frame > 最後一段的幀` 之後用 fallback（最後一段本身仍會重播；`!z` 這類單次按下只在該段所在的幀送出）。`bot` 模式沒有 fallback 概念。

### 2.2 遭遇檔 `demo`（選填）

```json
"demo": {
  "text": { "auto": true, "delay": 0.5 },
  "menuDelay": 6,
  "turns": [
    {
      "turn": 1,
      "choices": [
        { "member": "kris",   "command": "act",   "target": "rudinn", "option": "Check" },
        { "member": "susie",  "command": "fight", "target": "rudinn" },
        { "member": "ralsei", "command": "magic", "option": "Pacify", "target": "rudinn" }
      ],
      "fight": "perfect",
      "dodge": "path"
    },
    { "turn": 2, "choices": [ { "member": "kris", "command": "spare", "target": "rudinn" } ] }
  ],
  "default": { "choices": "fight", "fight": "good", "dodge": "bot" }
}
```

- `text.auto`：文字/泡泡打完後 `delay` 秒自動按確認（預設 true / 0.5）。
- `menuDelay`：選單中每次游標移動或確認之間的幀數（預設 6，讓觀眾看得到游標移動；0 = 最快）。
- `turns[]`：依實際進行的回合號（1 起算）指定。重複使用同一個回合定義時仍會繼續計數，例如只有 1 個回合定義的 `loop-last` 遭遇也能指定 `turn: 4`。
  - `choices[]`：每位隊員（`member` = party id）的選擇。`command`：`fight | act | magic | item | spare | defend`；`target`：敵人 id 或隊員 id（item/magic 的對象）；未列出的隊員用 `default`。
  - `option`：ACT／法術／道具的參照，**可填 `id` 也可填名稱**（比對邏輯在 `engine/autoplay/encounter.js`）。比對時先從 `id`、`name` 與名稱物件的 `zh` / `en` 收集所有文字，正規化（trim + 轉小寫）做精確比對；全部落空才做包含式（substring）比對。因此 `"Compliment"`、`"compliment"`、`"X-Action"`、`"check"` 都通；名稱是 `{"zh": …}` 或 `{"en": …}` 物件時兩種語言都能拿來填。`option` 省略時：ACT 選該敵人的第一個 ACT，法術／道具選第一個可用項。`target` 省略時（ACT）會跨全部敵人找「擁有這個 ACT 的敵人」，先選敵人再選選項。
  - `fight`：FIGHT 打擊條時機 `"perfect" | "good" | "miss"` 或 0..1 的數值（0 = 判定點正中、1 = 最邊緣）。
  - `dodge`：此回合攻擊的躲避方式：`"path" | "inputs" | "bot" | "none"`；`path`/`inputs` 讀**該回合攻擊檔的 `demo`**；省略 = 攻擊檔 `demo.mode`，再省略 = `bot`。
- `default`：沒在 `turns` 列出的回合（或隊員）用它；`choices: "fight"` = 全員 FIGHT 第一個存活敵人。
- 找不到指定的選項（ACT 名打錯、敵人已死）→ 退回 `default`，並在 autopilot 的 `warnings` 記一筆（不丟例外）。

## 3. 執行期 API（`engine/autoplay/`）

```js
import { createAutopilot, createRecorder, encodeInputs, decodeInputs } from './engine/autoplay/index.js';

const pilot = createAutopilot({ kind: 'attack' | 'encounter', doc, mode: 'demo' | 'bot', resolveAttackDoc });
await pilot.ready           // ← 遭遇的 encounter 模組是非同步載入；先 await 再開始跑
pilot.input(state, frame)   // → { press: [], hold: {} }；state = 引擎 getState()
pilot.reset()
pilot.warnings              // string[]
pilot.describe()            // { mode, dodge, turn, step, ready } 給 UI 顯示

const rec = createRecorder();
rec.push(frame, input);     // 每幀
rec.toString();             // → inputs 字串（§2.1）
```

- **必須 `await pilot.ready`**：`kind: 'encounter'` 的 pilot 需要動態載入 `encounter.js`，`ready` 之前 `describe().ready === false`、`input()` 一律回中性輸入（不按任何鍵），並在 `warnings` 記**一筆**「尚未就緒」的警告（只記一次，不會洗版）。等 `await pilot.ready` 之後再逐幀餵輸入；`kind: 'attack'` 立即 ready（等同 `await` 已完成）。
- `mode: 'demo'` = 用作品的 `demo` 腳本；`'bot'` = 忽略腳本，全程 AI（遭遇用 `default` 規則）。
- `resolveAttackDoc(name)`：遭遇用來取每回合攻擊檔的 `demo`（同步回傳已載入的 JSON 或 null）。
- 模組必須**瀏覽器與 Node 都能用**（無 Node 專屬 import）。`tools/agent/bot.mjs` 的閃避 AI 搬進 `engine/autoplay/bot.js`，`tools/agent/bot.mjs` 改成薄包裝（CLI 參數照舊）。

檔案歸屬：
| 檔案 | 內容 |
|---|---|
| `engine/autoplay/index.js` | `createAutopilot`（組合）、`createRecorder`、`encodeInputs/decodeInputs` |
| `engine/autoplay/bot.js` | 閃避 AI、`clampToBox` |
| `engine/autoplay/follow.js` | 路徑跟隨器（精度層）：`createPathFollower(options)`、`FOLLOW_DEFAULTS`、`normalizeFollowOptions` |
| `engine/autoplay/soul.js` | path/inputs/bot 模式解析、路徑時間軸（`buildPathTimeline` / `pathTargetAt`）、fallback |
| `engine/autoplay/encounter.js` | `createEncounterPilot({ demo, menuDelay, dodgePilotFor(turn, attackDoc) })`：選單導航、文字自動前進、FIGHT 時機 |
| `engine/autoplay/validate.js` | `validateAttackDemo(demo)` / `validateEncounterDemo(demo, encounter)` → `[{ path, message }]`，由 attack.js / encounter schema 驗證呼叫 |
| `engine/autoplay/trace.js` | `traceDemo(attackDoc, opts)` → 逐幀「預定 vs 實際」＋命中摘要；`deviationStats(frames)` |
| `engine/autoplay/pathgen.js` | `generateDemoPath(attackDoc, opts)` → 以引擎實跑搜尋 0 命中的 `demo`；另有 `createReplayEngine` / `replayPath` / `validateDemoPath` / `compactPath` / `expandPath` / `botTrajectory` |

### 3.1 驗證與產生（`engine/autoplay/trace.js`、`pathgen.js`、CLI）

```js
import { traceDemo, deviationStats } from './engine/autoplay/trace.js';
import { generateDemoPath } from './engine/autoplay/pathgen.js';

// 畫「預定 vs 實際」兩條線：每幀 { frame, target:{x,y}, actual:{x,y}, hit, slow, pathActive, ended }
const trace = traceDemo(attackDoc);                       // 用 attackDoc.demo
traceDemo(attackDoc, { path: [{ t: 0, x: 320, y: 190 }] }); // 或任意路徑
trace.hits            // [{ frame, x, y, type, damage }]
trace.summary         // { frames, hits, firstHitFrame, endFrame, ended, origin, mode, warnings }
deviationStats(trace.frames) // { frames, avg, max, maxFrame }（只算 path 生效幀）
// opts：demo / path / mode / maxFrames / stopAfterHits / keepGoing=false（一受傷就停）/ createBattle

// 產生 0 命中的 demo（純 ES module、可用 AbortSignal 取消、可報進度）
const result = generateDemoPath(attackDoc, {
  seed: 1, step: 0.3, timeBudgetMs: 60000,
  onProgress: ({ phase, hits, clearance, elapsedMs }) => {},
  signal,                     // AbortSignal
});
result.ok        // true = 0 命中且驗證通過
result.demo      // { mode: 'path', fallback: 'stay', path: [...] }（path 裡有 slow 標記）
result.hits      // 失敗時的最佳結果命中數
result.hitFrames, result.best, result.attempts, result.elapsedMs, result.reason  // 'ok' | 'hits' | 'aborted' | 'time-budget'
```

- 路徑產生器預設以 4 px 為淨空目標，先求零命中。達不到目標時回報實際淨空。CLI 用 `--min-clearance N` 設定目標，預設 `fallback: "bot"`，可用 `--fallback stay` 改成停留。
- 產生流程：現有 demo / bot 軌跡 / 原地 / 繞行 / 隨機遊走當初始候選 → 每條都用引擎實跑評分（命中數 → 首命中時間 → 最小淨空 → 移動量）→ 逐節點座標下降（每次修改都實跑）→ 最後完整回合驗證。失敗或時間用完時回傳**目前最佳**路徑與命中數，不會丟例外。
- 純 ES module，瀏覽器與 Node 都能載入；`createReplayEngine(attackDoc)` 是「重跑」的接縫，之後換成 snapshot 加速（V2-08）只要替換這一層。
- CLI（產生並驗證，`--write` 才寫回檔案）：

  ```bash
  node tools/agent/demo-path.mjs samples/spade-rain.json                     # 只印結果 JSON
  node tools/agent/demo-path.mjs samples/spade-rain.json --write             # 把 demo 寫回（保留其他欄位與排序）
  node tools/agent/demo-path.mjs attacks/x.json --seed 7 --budget 30s --sweeps 3
  ```

  `--write` 只替換檔案裡 `"demo"` 那一段文字，其他欄位、順序與排版原樣保留；demo 驗證失敗時不寫。離開碼 0 = 0 命中且驗證通過、1 = 沒成功、2 = 參數／讀檔錯誤。

## 4. 試玩頁與編輯器

- **開關**：`P` 鍵或工具列「自動」按鈕；模式選單「腳本 / AI / 關」，下拉與 `P` 鍵同步。`P` 鍵是**三態循環**：關 → 腳本 → AI → 關；作品沒有 `demo` 時跳過腳本，只有 關 → AI → 關（`#auto-mode` 的「腳本」選項會 disabled）。開啟時人類方向鍵與 Z/X 被忽略（`P` 關閉、`R` 重來、`Esc` 仍有效）。URL `?autoplay=demo|bot` 開頁即啟動；`&chrome=0` 隱藏頁面 UI 方便錄影，但右上角會保留一個極小狀態字（`AUTO·腳本` / `AUTO·AI` / `AUTO·關`），不會整個消失。
- **狀態顯示**：在**畫布外**（頁面工具列）顯示「AUTO · 腳本 / AI · 幀 N · 受傷 N」，不畫進遊戲畫面；`chrome=0` 時縮成右上角狀態字（見上）。
- **錄製**：「錄製」按鈕 → 照常手動遊玩 → 結束後把 inputs 字串寫入目前作品的 `demo.inputs`（編輯器：一筆可復原的修改；試玩頁：透過 `/api` PATCH，或下載 JSON）。
- **攻擊編輯器**：檢查器新增「演示」區：模式、路徑點清單（t / x / y / slow / hold，可增刪排序）、fallback、錄製/清除；預覽疊加層畫出路徑（點 + 連線 + 時間標籤），編輯模式可拖曳路徑點；時間軸游標處的目標點高亮。
- **遭遇編輯器**：「演示」面板（清單式，與指令編輯器同風格）：文字自動、menuDelay、每回合卡片（隊員 × 指令/目標/選項下拉，選項來自該敵人 ACT/隊員法術/道具）、fight、dodge；預覽工具列「自動」開關。
- **Agent**：`dr_simulate` 加 `autoplay: "demo" | "bot"`（預設 bot，與現在相同）；`dr_validate` 驗證 demo；schema 匯出包含 demo；`AGENT-GUIDE.md` 加「演示腳本」一節。
- **遭遇頁截圖**：`dr_render` 的 `autoplay` 對**攻擊頁與遭遇頁都支援**。攻擊頁走 `__drPlay.tick`、遭遇頁走 `__drEncounterPlay.tick` 逐幀餵 autopilot 輸入再截圖；`encounter-play.html` 的 `?autoplay=demo|bot` 從一開始就支援，不要再假設「遭遇頁不能自動演示」。
- **遭遇頁參數**：`?encounter=` 可以填**作品名稱**（`?encounter=bellwright`，依序找 `api/encounters/<名稱>.json` → `encounters/` → `samples/encounters/`）或**頁面可 fetch 的相對路徑**（`?encounter=api/encounters/bellwright.json`、`?encounter=samples/encounters/rudinn.json`）。載入失敗會**停在錯誤畫面**並列出試過的網址（不會偷偷換成內建範例或假資料）；只給 `?file=`（編輯器的參數）會被當成 `?encounter=` 並提示；兩者都沒給才載入內建範例 `rudinn`（banner 會寫明）。

## 5. 驗收

- 4 個攻擊範例與 2 個遭遇範例都附 `demo`；`?autoplay=demo` 無人操作能一路打到終局（遭遇走饒恕或勝利），且整場零 console 錯誤。
- 4 個攻擊範例的 `demo` 都經 `traceDemo` 驗證 0 命中；跟隨器平均偏差 ≤ 2px（實際位置 vs 插值目標）。`generateDemoPath` 對 4 個範例都能在 60 秒內產生 0 命中、通過 `validateAttackDemo` 的 `demo`。
- 錄製 → 重播：同一攻擊錄一段手動遊玩，重播後每幀靈魂座標與受傷次數完全相同。
- 自動演示關閉時，既有全部測試結果不變。
