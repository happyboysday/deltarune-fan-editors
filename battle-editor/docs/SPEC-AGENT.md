# DR Battle Editor — Agent 介面 Spec（副目標）

目標：編輯器同時給**人**與 **Agent** 使用，兩者擁有**同等的最高編輯權限**；Agent 能在沒有人操作的情況下，從使用者的一句創作目標出發，自行完成「查素材 → 寫攻擊/遭遇 → 驗證 → 試跑 → 看畫面 → 依數據調整 → 存檔」整個循環，並且人隨時能在開著的編輯器裡看到、接手、修改。

## 1. 原則

1. **單一真實來源**：作品就是磁碟上的 JSON（`attacks/`、`encounters/`）。人與 Agent 都透過同一個本機伺服器讀寫；沒有「只有 UI 能做」的操作。
2. **能力對等**：編輯器 UI 能做的每件事都有對應的 API / MCP 工具；反之 Agent 的修改即時出現在人開著的編輯器裡（可復原）。
3. **Agent 看得見結果**：除了驗證錯誤，Agent 能拿到模擬統計、事件紀錄與**實際渲染畫面（PNG）**，不必靠猜。
4. **自我說明**：格式、指令、表達式變數、素材清單都能以機器可讀形式取得（JSON Schema + 說明），Agent 不需要讀原始碼。
5. **安全邊界**：只綁 127.0.0.1；寫入只限作品目錄；表達式沿用詞法白名單；不提供任意檔案或任意程式執行。

## 2. 伺服器 API（serve.py 擴充，W2）

除 Phase 1/2 的 `/api/attacks`、`/api/encounters` 外：

| 方法 | 路徑 | 說明 |
|---|---|---|
| PUT | `/api/attacks/<n>.json`、`/api/encounters/<n>.json` | 加 **樂觀鎖**：回應帶 `ETag`（內容 sha256）；請求帶 `If-Match` 不符時 409 並回傳現版本 |
| PATCH | 同上 | RFC 6902 JSON Patch（add/remove/replace/move/copy/test），同樣支援 If-Match |
| DELETE | 同上 | 移到 `trash/`（可還原），不真刪 |
| GET | `/api/events` | **SSE**：`{ type: 'changed'|'deleted', kind: 'attack'|'encounter', name, etag, by: 'human'|'agent'|'<client id>' }`；編輯器據此即時重載 |
| GET | `/api/schema/attack`、`/api/schema/encounter`、`/api/schema/cues` | JSON Schema + 每個欄位/指令的說明（由引擎 `schema.js` / `attack.js` 匯出產生，避免兩份定義） |
| GET | `/api/assets/search?q=&tag=&kind=sprite|audio|font|preset&limit=` | 素材搜尋（名稱、tag、尺寸、幀數、原點、說明） |
| GET/PUT | `/api/editor/state` | 開著的編輯器回報目前檔案、選取、時間游標、語言；Agent 可讀，或 PUT 要求編輯器切換到某檔/選取某事件/跳到某幀（「指給人看」） |

所有寫入請求帶 `X-Client: human|agent|<id>`，寫入 `history/` 審計紀錄（時間、client、檔名、前後 etag、patch 摘要），可依此還原。

## 3. 無頭工具（Node，`tools/agent/`，AG）

```
node tools/agent/sim.mjs  <attack|encounter 檔> [--frames N] [--inputs script.json] [--bot dodge|idle|random] --json
  → { frames, ended, result, damageTaken, hits, grazes, tpGained, maxBullets, avgBullets, errors[], events[] (精簡), perTurn[] }
node tools/agent/render.mjs <檔> --frames 0,30,90 [--lang zh] [--out dir] [--sheet]
  → 以 headless Edge（CDP，Node 內建 WebSocket）開 play.html / encounter-play.html，逐幀截圖 PNG；--sheet 拼成一張聯絡表
node tools/agent/difficulty.mjs <attack> [--runs 20]
  → 用自動閃避 bot（貪婪避彈、多種隨機種子）跑多次，輸出受傷分佈、最危險時段、子彈密度曲線、「是否可通過」
```

- 輸入腳本格式：`[{ frame, press: [...], hold: {...} }]`，與引擎 `step(n, input)` 一致。
- bot 只用公開 `getState()`，不得讀引擎內部。

## 4. MCP 伺服器（`tools/agent/mcp-server.mjs`，AG）

stdio JSON-RPC，**零依賴**手寫 MCP 協定（initialize / tools/list / tools/call / resources），透過 HTTP 呼叫第 2 節 API 與第 3 節工具。可被 Claude Code、DSH 等任何 MCP 客戶端掛載。

工具（名稱 / 用途）：
- `dr_docs`：取得規格摘要、JSON Schema、指令說明、表達式變數、創作指南（`docs/AGENT-GUIDE.md`）
- `dr_assets_search`：搜尋 sprite / 音效 / 音樂 / 字體 / 演員預設
- `dr_list` / `dr_read` / `dr_write` / `dr_patch` / `dr_delete`：作品 CRUD（帶 etag，衝突時回傳現版本讓 Agent 合併）
- `dr_validate`：驗證並回傳帶路徑的錯誤與修正建議
- `dr_simulate`：跑 sim.mjs，回統計與事件
- `dr_render`：跑 render.mjs，回傳 PNG（MCP image content）或聯絡表
- `dr_difficulty`：跑 difficulty.mjs
- `dr_editor_state` / `dr_editor_focus`：讀取人正在看什麼；讓編輯器跳到指定檔案/事件/幀給人看
- `dr_history` / `dr_restore`：查看與還原修改紀錄

## 5. 編輯器端（ED1 後續任務）

- 訂閱 `/api/events`：目前開著的檔案被他人（Agent）改動 → 自動載入新版，**作為一筆可復原的變更**加入復原堆疊（label「Agent 修改」），並在工具列短暫提示；若本地有未存修改 → 顯示合併提示（保留我的 / 採用對方 / 檢視差異）。
- 存檔改用 ETag/If-Match；409 時同上流程。
- 週期回報 `/api/editor/state`；收到 focus 請求時切換檔案/選取/跳幀。
- 工具列顯示「Agent 已連線」指示與最近一次 Agent 動作。

## 6. 給 Agent 的創作指南 `docs/AGENT-GUIDE.md`（協調者撰寫）

建議工作流程、DELTARUNE 風格要點（彈幕密度、節奏、框尺寸、留安全路線）、常見指令配方（走位進場、ACT 分支、饒恕路線）、自我檢查清單（validate 0 錯誤 → simulate 無 error → difficulty 可通過 → render 看畫面）。

## 7. 歸屬

| 代號 | 擁有 |
|---|---|
| AG（Agent 工具） | `tools/agent/**`（sim/render/difficulty/mcp-server/測試） |
| W2（後續） | `serve.py` 第 2 節 API、`history/`、`trash/` |
| ED1（後續） | 編輯器端第 5 節 |
| E1（後續） | 引擎匯出 JSON Schema 產生函式（`engine/schema-export.js`） |
| 協調者 | 本文件、`docs/AGENT-GUIDE.md` |

時程：Phase 2 主線不中斷。W2、ED1、E1 完成 Phase 2 任務後接續本文件的部分；AG 為新會話，於有會話空出時開工（第 3、4 節不依賴 Phase 2 編輯器）。
