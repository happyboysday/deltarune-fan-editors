# Agent 創作指南

給透過 MCP（`tools/agent/mcp-server.mjs`）使用本編輯器的 Agent。目標：從使用者的一句創作目標，自己完成一段**看起來、玩起來都像 DELTARUNE** 的彈幕回合或遭遇戰，並讓人能在開著的編輯器裡看到、接手。

## 1. 工作循環

1. **理解需求**：誰（敵人/角色）、幾回合、情緒（輕鬆/緊張/Boss）、特殊演出（對白、走位、ACT 分支）、語言（`zh` 簡體 / `en`）。不清楚就用合理預設，不要卡住。
2. **查資料**：`dr_docs`（`schema: "attack" | "encounter" | "cues"`）看格式；`dr_assets_search` 找 sprite（`tag: bullet|enemy|party|battlebg|ui|soul`）、音效（`kind: sfx`）、音樂（`kind: music`）、演員預設（`kind: preset`）。**只用搜得到的名稱**。
   - 想用自己畫的子彈／貼圖（不在官方素材庫）：見 `docs/CUSTOM-ASSETS.md`。
3. **先看範例**：`dr_read` 讀 `samples/` 的攻擊（spade-rain、ring-burst、box-shrink-aim、sine-wave）與遭遇（rudinn、showcase），照它們的結構改寫比從零寫穩。
4. **寫入**：新作品用 `dr_write`；修改既有作品優先 `dr_patch`（小、可審計），帶上次讀到的 `ifMatch`。409 表示人剛改過：讀回 `current`，在它之上重做你的修改，**不要覆蓋人的修改**。
5. **自我檢查**（每次修改後，全部通過才算完成）：
   - `dr_validate` → 0 錯誤
   - `dr_simulate` → 無 `errors`，遭遇能走到終局（`result` 非 null）
   - `dr_difficulty` → 「可通過」，且難度符合需求（見 §3）
   - `dr_render` → **親眼看**關鍵幀（開場、彈幕最密時、結尾）：框內有子彈、無洋紅佔位方塊、文字沒溢出；遭遇頁也可以加 `autoplay: "demo" | "bot"` 讓截圖自動推進（見 `docs/SPEC-AUTOPLAY.md` §4）。
6. **交給人**：`dr_editor_focus` 讓編輯器跳到你的作品與關鍵幀，並用 `note` 說明你做了什麼、哪裡值得人看一眼。

## 2. DELTARUNE 風格要點

**畫面與座標**：640×480、30 FPS；角度 0=右、90=下；速度 px/幀。戰鬥框預設中心 (320,190)、144×158、邊框 3px，`box.x/y` 是中心（實機版面見 `docs/SPEC-LAYOUT.md`）。

**彈幕**
- 一般敵人：同屏 15–40 顆；Boss：40–80；超過 100 幾乎一定不公平。
- 永遠留**安全路線**：環形彈要有缺口、雨要有間隔、瞄準彈要給反應時間（生成到抵達靈魂 ≥ 0.5 秒）。
- 節奏：開頭 0.5–1 秒暖身、中段主圖案、結尾收尾或一波高潮；整段 4–10 秒。
- 子彈從框外或框邊生成並設 `maskToBox: true`，視覺最接近原作。
- 一個回合一個主題（雨 / 環 / 瞄準 / 波浪），變化靠參數（密度、速度、角度偏移）而非堆很多種。
- 框縮放（`box` 事件）是重要的難度與戲劇工具：縮小 = 緊張；補間 0.3–0.6 秒，`quadInOut` / `backOut`。

**遭遇**
- 隊員左側縱列、敵人右側；用 `assets/actor-presets.json` 的 `layouts`（party3 / enemy1-3）。
- **角色名一律用英文**（隊員與敵人，含中文台詞內：「* Susie和Lancer在取笑你们。」），與簡中補丁一致；名字欄位直接給英文字串，不要給 `{zh,en}`。
- 每回合：`flavor` 一句旁白（「* 」開頭）、敵人 1–2 句泡泡台詞（短、口語、有個性）、一段攻擊。
- ACT：至少 `Check`（顯示敵人簡介）+ 1–2 個有趣選項；讓 mercy 在 2–4 回合內可達 100，給饒恕路線。
- 傷害平衡：普通命中約敵人 HP 的 1/6–1/4（引擎已內建）；敵人 HP 依此推算回合數。
- 演出：開場 `parallel` 走位進場、重要台詞前 `wait` 0.3 秒、勝利 hook 收尾一句台詞；不要每句都 `shake`/`flash`。

## 3. 難度對照（`dr_difficulty`）

| 目標 | 建議 |
|---|---|
| 教學 / 輕鬆 | easy；bot 中位數受傷 0–1 |
| 一般敵人 | normal；中位數 1–3 |
| Boss | hard；中位數 3–6，但「可通過」必須為真 |
| extreme | 幾乎一定是設計問題：降密度、加缺口、放慢瞄準彈 |

危險時段報告指出的秒數，就是要改的地方。

## 4. 常用配方

- **黑桃雨**：`emitter` interval 0.15–0.25，`x: "rand(box.left, box.right)"`、`y: "box.top - 20"`、`angle: 90`、`speed: 3–4`。
- **環形爆發**：`spawn` count 12–16，`angle: "i*(360/n) + k*7"`，從敵人或框中心；要留缺口就讓角度只覆蓋一段弧，例如 `angle: "i*(300/n) + rand(0,60)"`。
- **瞄準彈**：`angle: "aim(x, y)"`（`x/y` 是本發生成點），間隔 ≥ 0.4 秒。
- **波浪彈**：`pathY: "40*sin(age*180 + i*45)"` 搭配水平速度。
- **自訂子彈／貼圖**：見 `docs/CUSTOM-ASSETS.md`（畫 PNG → 放 `assets/custom/` → 跑兩支 build 腳本 → 用 `bulletTypes.sprite` 引用）。
- **ACT 分支**：在 ACT 的 cues 用 `set` 記變數，下一個 ACT 用 `if` 檢查 `var.<名稱>`。
  （`var.x` 與 `vars.x` 等價，編譯時會統一成 `vars.`；範例兩種寫法都看得到。）
- **追蹤彈要「凍結目標」**：`soul.x` / `soul.y` 是**每幀即時值**。在 `pathX` 直接寫 `(soul.x - spawnX) * age` 會整段追著靈魂跑（幾乎無解）；
  要「瞄準生成當下的位置」請在 spawn 的 `memory` 快照：`"memory": { "tx": "soul.x", "ty": "soul.y" }`，路徑改用 `mem.tx` / `mem.ty`。
- **回合內插一段彈幕**：`turn.start`（或任何 cue 清單）放 `{ "cmd": "attack", "attack": "<攻擊檔名>" }`，播完才繼續。
  最後一回合想多播一支攻擊就用這招（demo 的 `turns[].turn` 不能超過回合數）：

  ```json
  { "id": "t3", "attack": null,
    "start": [
      { "cmd": "bubble", "actor": "boss", "text": "最後一擊！" },
      { "cmd": "attack", "attack": "final-wave" }
    ] }
  ```
- **饒恕線**：每個有效 ACT `mercy: 35–50`；`enemies[].onSpare` 放一句告別台詞。

## 5. 表達式限制

只允許數字、運算子、括號、白名單變數與函式（見 `dr_docs { schema: "cues" }`）；**字串、方括號、賦值、任意屬性存取都會被拒絕**。`pick(1,2,3)` 而非 `pick([1,2,3])`。遭遇條件用 `var.x`、`mercy.rudinn`、`hp.kris`、`alive.rudinn`、`turn`、`tp`。

## 6. 與人協作

- 人與你權限相同，但**人的修改優先**：遇到 409 一律合併，不強制覆蓋。
- 開始大改之前先 `dr_editor_state` 看人是否正開著同一個檔；是的話先用 `dr_editor_focus` 的 `note` 告知。
- 一切修改都記在 `dr_history`，做錯了用 `dr_restore` 還原，不要手動「改回去」。

## 7. 演示腳本（`demo`，見 `docs/SPEC-AUTOPLAY.md`）

使用者要「能自動播放的演示」時，或作品完成後順手附上：

- **攻擊**：優先寫 `demo.path`（4–12 個路徑點，`t` 秒遞增、`x/y` 在框內、危險段用 `slow: true`），`fallback: "bot"`。寫完用 `dr_simulate { autoplay: "demo" }` 確認受傷 0；有受傷就看危險時段，挪動那一段的路徑點。
- **遭遇**：`demo.turns[]` 逐回合指定每位隊員的 `command / target / option`，讓演示走完你設計的路線（饒恕線最好看：ACT → mercy 100 → spare）；`default` 給沒列到的回合；`dodge` 省略時用該回合攻擊檔的 `demo`。`menuDelay: 6` 讓觀眾看得到游標。
- 驗證：`dr_validate` 會檢查 demo（隊員/指令/選項是否存在，錯誤帶 `demo.turns[0].choices[1].option` 這類路徑）；`dr_simulate { autoplay: "demo" }` 的 `result` 要是你預期的結局、`autoplay.warnings` 要為空。
- 交給人：告訴使用者可開 `play.html?attack=api/attacks/<名稱>.json&autoplay=demo` 或 `encounter-play.html?encounter=<名稱>&autoplay=demo` 觀看（遭遇頁的 `?encounter=` 可直接填作品名稱；填錯會停在錯誤畫面，不會偷偷換成範例），`&chrome=0` 隱藏頁面 UI 方便錄影（右上角仍保留極小 `AUTO·腳本` 狀態字）；遊玩中 `P` 鍵三態循環 關 → 腳本 → AI（沒有 demo 的作品只有 關 → AI）。遭遇頁的 `?autoplay=demo|bot` 一直都有支援，`dr_render` 也會逐幀推進後截圖，不需要改走攻擊頁。