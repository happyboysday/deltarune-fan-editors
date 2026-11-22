# AG — Agent 工具（`battle-editor/tools/agent/`）

讓 **Agent**（Claude Code、DSH 或任何會講 MCP / 會跑 Node 的程式）與**人**用同一套權限創作
彈幕攻擊與遭遇：查素材 → 寫 JSON → 驗證 → 無頭試跑 → **真的看畫面** → 依數據調整 → 存檔，
而且人的編輯器會即時看到 Agent 的修改。

> 規格：`docs/SPEC-AGENT.md`（§3 無頭工具、§4 MCP 工具、§7 歸屬）。
> 本目錄歸 AG 所有；`serve.py`、`engine/`、`editor/` 由其他人擁有，本工具只**使用**它們。

---

## 1. 需求

| 元件 | 需要？ | 說明 |
|---|---|---|
| Node.js **≥ 22** | 必要 | 用到全域 `fetch`、`WebSocket`、ESM。開發時用 v26.13.0，**零 npm 依賴**（沒有 `package.json`，不要 `npm install`） |
| `serve.py` | 建議 | 有伺服器 = 完整功能（樂觀鎖、審計、SSE 同步、垃圾桶）。沒開也能用（降級直接讀寫磁碟） |
| Python 3 | 選用 | 只有 `render.mjs` 需要自動起伺服器時才找它（`python`/`python3`/`py`，可用 `DR_PYTHON` 指定） |
| Microsoft Edge | 選用 | 只有 `dr_render` / `render.mjs` 需要（headless）。找不到 Edge 時 render 會明確報錯，其他工具照常 |

工具用**自身檔案位置**推算程式根：在 worktree 裡執行會自動用該 worktree 的引擎（`--root` 預設＝工具所在處，見 §4.5）。

---

## 2. 30 秒上手

以下命令的工作目錄都是 **`battle-editor/`**（工具用自身檔案位置推算「程式根」，從專案根跑也可以；
在 worktree 裡跑會自動用該 worktree 的引擎——`--root` 預設＝工具所在處，見 §4.5）。

```bash
# 0) 起伺服器（另一個終端；不開也行，但開著有樂觀鎖與即時同步）
python serve.py                               # → http://127.0.0.1:18900

# 1) 檢查環境 + 看有哪些工具
node tools/agent/mcp-server.mjs --http         # 伺服器 / Edge / schema 狀態
node tools/agent/mcp-server.mjs --print-tools  # 15 個工具與參數

# 2) 讀格式（Agent 建議走 MCP；人用 CLI 也可以）
node tools/agent/export-schema.mjs             # 產生/更新 generated/schema/*.json（引擎改了就重跑）

# 3) 試跑官方範例，確認工具正常
node tools/agent/sim.mjs samples/spade-rain.json --frames 300 --bot dodge
node tools/agent/render.mjs samples/spade-rain.json --frames 0,60,150 --sheet
```

---

## 3. 檔案

| 檔案 | 用途 |
|---|---|
| `mcp-server.mjs` | **MCP 伺服器**（stdio JSON-RPC 2.0，零依賴）：16 個 `dr_*` 工具 + resources |
| `export-schema.mjs` | 由引擎常數產生 JSON Schema（`generated/schema/attack.json`、`encounter.json`、`cues.json`） |
| `sim.mjs` | 無頭模擬：攻擊 / 遭遇，回傳統計與**遭遇事件流**（回合/指令/ACT/mercy/TP/HP/台詞/攻擊/結果） |
| `bot.mjs` | 自動閃避 bot（只用公開 `getState()`；`dodge` / `idle` / `random`） |
| `difficulty.mjs` | 多種子試跑 → 受傷分佈、危險時段、可否通過、建議；**遭遇另有整場報告**（逐回合/結局比例/總時長） |
| `render.mjs` | headless Edge（CDP）**逐幀精準**截 PNG、`--sheet` 聯絡表；遭遇與攻擊都凍結 rAF、固定步進 |
| `test.mjs` | 76 項自我測試（schema / 驗證 / 模擬 / bot / 難度 / 路徑 / 素材訊號 / SPEC-EXPR-V2 同步 / MCP / 離線降級 / 渲染） |
| `lib.mjs` | 共用工具（`--root`/`--works` 路徑解析、讀寫 JSON 冪等、參數解析、統計） |
| `.mcp.json.example` | 給 Claude Code 用的掛載範例（複製到專案根改名 `.mcp.json`） |
| `.tmp/` | 暫存（截圖、降級刪除備份、外部檔案複本）；已列入 `.gitignore` |

產物 `battle-editor/generated/schema/*.json` 是**產生物**（`.gitignore` 已忽略 `/battle-editor/generated/`），
每次引擎常數變動就重跑 `export-schema.mjs`（`--check` 可驗證是否最新）。

---

## 4. 掛載 MCP 伺服器

伺服器走 **stdio**：由客戶端啟動 `node tools/agent/mcp-server.mjs`，用 stdin/stdout 講 JSON-RPC。
不需要任何 npm 套件。

### 4.1 Claude Code

在**專案根**建立 `.mcp.json`（可直接複製 `tools/agent/.mcp.json.example`）：

```json
{
  "mcpServers": {
    "dr-battle": {
      "command": "node",
      "args": ["battle-editor/tools/agent/mcp-server.mjs"],
      "env": { "DR_MCP_QUIET": "1" }
    }
  }
}
```

Windows 上若 `node` 不在 PATH，`command` 請填絕對路徑（`where node` 可查）。
重啟 Claude Code 後用 `/mcp` 確認 `dr-battle` 已連線；工具會以 `dr_*` 出現在工具清單。

### 4.2 DSH / 其他 MCP 客戶端

DSH 的 session 請求接受 `mcpServers`（stdio：`command` + `args` + `env`），把同樣的設定填進
DSH 的 MCP 伺服器設定即可：

```json
{
  "command": "node",
  "args": ["<战斗编辑器目录>/tools/agent/mcp-server.mjs"],
  "env": { "DR_MCP_QUIET": "1" }
}
```

任何支援 stdio MCP 的客戶端都一樣：**command = node，args = [mcp-server.mjs 絕對或相對路徑]**。

### 4.3 連線自檢

```bash
node tools/agent/mcp-server.mjs --print-tools   # 列出 15 個工具與參數 schema
node tools/agent/mcp-server.mjs --http          # 印：伺服器是否可用、Edge 路徑、schema 是否最新
```

`--http` 實際輸出（伺服器沒開時會標示 offline，工具仍可用）：

```
MCP：dr-battle-agent 1.0.0（stdio，15 個工具，Node v26.13.0）
伺服器：http://127.0.0.1:18900 ✓（/api 自我發現 OK，21 個端點）
Edge：C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe ✓
schema：attack 58.0KB ✓ / encounter 50.1KB ✓ / cues 28.6KB ✓
```

### 4.4 環境變數

| 變數 | 作用 |
|---|---|
| `DR_SERVER_URL` / `DR_BASE_URL` | 指定伺服器（預設 `http://127.0.0.1:18900`；換埠時用） |
| `DR_ROOT` | 程式根（battle-editor/）——等價於 `--root`。預設＝工具所在處，所以在 worktree 裡執行會自動用該 worktree 的引擎 |
| `DR_WORKS` | 作品根（含 `attacks/`、`encounters/`、`assets/custom/`）——等價於 `--works`。預設＝程式根 |
| `DR_SERVER_OFFLINE=1` | 強制**離線降級**：完全不碰 HTTP，直接讀寫磁碟（測試/演練用） |
| `DR_MCP_QUIET=1` | 不在 stderr 印啟動訊息（某些客戶端會把它當錯誤） |
| `MSEDGE_PATH` / `EDGE_PATH` | 指定 Edge 執行檔（`render.mjs`） |
| `DR_PYTHON` | 指定 Python（`render.mjs` 自動起伺服器時） |

### 4.5 程式根與作品根（`--root` / `--works`）

所有 CLI（`sim` / `difficulty` / `render` / `export-schema` / `mcp-server`）與
`tools/check-encounters.mjs` 都吃同一組參數（`tools/agent/lib.mjs` 統一解析）：

| 參數 | 意義 | 預設 |
|---|---|---|
| `--root <dir>` | **程式根**：有 `engine/`、`serve.py`、`play.html`、`samples/` 的 battle-editor 目錄 | 工具自身所在處（`tools/agent/../..`）→ **在 worktree 裡跑就用 worktree 的引擎** |
| `--works <dir>` | **作品根**：有 `attacks/`、`encounters/`、`assets/custom/` 的目錄 | ＝程式根 |

作品名解析順序：**作品根 → 程式根的 `attacks/`、`encounters/` → `samples/`**（可省 `.json`）。
環境變數 `DR_ROOT` / `DR_WORKS` 與參數等價，命令列優先。

```bash
node tools/agent/sim.mjs rudinn --works D:/my-works          # 用 D:/my-works/encounters/rudinn.json
node tools/agent/sim.mjs rudinn --root ../worktree-x/battle-editor   # 用 worktree 的引擎
DR_WORKS=D:/my-works node tools/agent/difficulty.mjs my-enc --runs 16
```

`--root` 不是程式根（找不到 `engine/assets.js`、`serve.py`、`play.html`）或 `--works` 不存在時
會**直接報錯**（exit 2）並說明缺什麼，不會靜默用錯引擎。
`render.mjs` 自動起伺服器時會把 `--works` 傳給 `serve.py`；若 serve.py 太舊不認得這個參數，
會回「serve.py 不支援 --works（作品根 …）」而不是含糊的「伺服器行程已結束」。

---

## 5. MCP 工具參考

所有工具回傳 MCP `content`（JSON 文字；`dr_render` 另外附 `image` base64 PNG）。
錯誤一律 `isError: true` 並附中文原因與修正建議（多數錯誤會直接寫「下一步該做什麼」）。
寫入類工具都會帶 `X-Client: agent` 標記，人在 `history/` 看得到是 Agent 改的。

### 5.1 自我說明

| 工具 | 參數 | 說明與範例 |
|---|---|---|
| `dr_docs` | `doc?` `section?` `schema?` `list?` | 讀規格與 Schema。`doc` = `agent`/`spec`/`p2`/`guide`/`coordination`；`section` 可只取某章（如 `4` 或 `§3`）；`schema` = `attack`/`encounter`/`cues`；`list:true` 列出可讀文件 |

```
dr_docs {}                                   → 列出所有可讀文件與 Schema
dr_docs {doc:"agent"}                        → SPEC-AGENT.md 全文
dr_docs {doc:"agent", section:"4"}           → 只取 §4（MCP 工具章）
dr_docs {schema:"cues"}                      → 19 條 cue 指令、表達式變數、配方
```

> `docs/AGENT-GUIDE.md` 由協調者撰寫；還沒建立時 `dr_docs {doc:"guide"}` 會回一份內建的
> 臨時工作流程（不是錯誤）。

### 5.2 素材

| 工具 | 參數 | 說明 |
|---|---|---|
| `dr_assets_search` | `q?` `tag?` `kind?` `limit?` | 找 sprite / sfx / music / font。`kind` = `sprite`/`sfx`/`music`/`font`/`audio`/`preset`；`limit` 預設 30、上限 200 |

```
dr_assets_search {q:"heart"}                  → spr_heart（16×16、ox/oy、tag soul）
dr_assets_search {kind:"sfx", q:"graze"}      → snd_graze
dr_assets_search {kind:"music", tag:"battle"} → battle 等戰鬥 BGM（含 loop 旗標）
dr_assets_search {kind:"sprite", tag:"enemy", limit:50}
```

回傳每筆含 `name`、`file`/`frames`、尺寸、`ox`/`oy`、`tags` 等（與 `assets/index.json` 相同欄位）。

### 5.3 作品 CRUD（帶樂觀鎖）

| 工具 | 必要參數 | 選用 | 說明 |
|---|---|---|---|
| `dr_list` | — | `kind` | 列出作品 + `samples/` 唯讀範例（`source:"sample"`）。`kind`=`attack`/`encounter` |
| `dr_read` | `name` 或 `path` | `kind` | 讀整份 JSON 與 `etag` |
| `dr_write` | `name`、`doc` | `kind`、`ifMatch` | 整檔寫入（自動補 `format`）；`ifMatch` 不符 → 409 + 現版本內容 |
| `dr_patch` | `name`、`patch` | `kind`、`ifMatch` | RFC 6902 JSON Patch，小幅調整用 |
| `dr_delete` | `name` | `kind`、`ifMatch` | 刪除 → `trash/`（可 `dr_restore` 復原）；`samples/` 不可刪 |

```
dr_list {kind:"attack"}                       → 4 個範例 + 磁碟上的作品（各帶 etag）
dr_read {name:"spade-rain"}                   → {source, etag, document}
dr_write {name:"my-rain", doc:{...}}          → {ok, etag, source:"api"}
dr_patch {name:"my-rain", patch:[{op:"replace",path:"/settings/duration",value:9}], ifMatch:"<etag>"}
```

**衝突處理**：409 時回傳 `{conflict:true, etag, current:{...現版本...}}`。
做法：把 `current` 重新讀進來 → 以它為基底重做你的修改 → 用回傳的新 `etag` 當 `ifMatch` 再寫一次。
**不要**用舊 etag 硬寫（伺服器不會讓你覆蓋，會一直 409）。

### 5.4 驗證 / 試跑 / 看畫面

| 工具 | 參數 | 說明 |
|---|---|---|
| `dr_validate` | `name` 或 `doc`；`kind?` | 不寫檔。回 `{ok, errors:[{path,message,id?,field?}], warnings:[...], hints:[{path,message}]}`；素材/攻擊參照缺失算 warning；`hints` 是 info 級提示（例如 bpm 已設定但 `clear`/`end` 用秒數），不影響 `ok` |
| `dr_simulate` | `name` 或 `doc`；`frames?` `autoplay?` `bot?` `seed?` `inputs?` | 無頭跑：受傷/擦彈/TP/子彈峰值/每回合/事件；`autoplay`=`demo`（作品 demo 腳本）`bot`（全 AI）；舊 `bot`=`idle`（基準線）`dodge`（測可否通過）`random` 仍相容 |
| `dr_render` | `name` 或 `doc`；`frames?` `lang?` `scale?` `sheet?` `hitboxes?` `autoplay?` | headless Edge 截 PNG，以 MCP `image` content 回傳（Agent 真的看得見畫面）；攻擊頁可加 `autoplay` 讓畫面照 demo 腳本跑 |
| `dr_record` | `name` 或 `doc`；`kind?` `autoplay?` `scale?` `out?` `pngDir?` `wav?` `lang?` `seed?` `maxFrames?` `noAudio?` `preset?` `crf?` | **逐幀錄影**：整段跑完輸出 MP4／PNG 序列／WAV（音訊由引擎事件表在 Node 端混音）。需要 Edge + ffmpeg；沒有 ffmpeg 時仍可用 `pngDir`/`wav` |
| `dr_difficulty` | `name` 或 `doc`；`runs?` `bot?` | 多種子 bot 試跑：受傷分佈、0 傷機率、每秒危險曲線、可否通過、建議 |

```
dr_validate {name:"spade-rain"}                       → ok:true, errors:[]
dr_simulate {name:"spade-rain", autoplay:"demo"}
   → {frames:297, ended:true, hits:0, autoplay:{mode:"demo", warnings:[], describe:{mode:"demo", dodge:"path", ...}}}
dr_simulate {name:"spade-rain", frames:300, bot:"dodge"}
   → {frames:297, ended:true, hits:1, grazes:57, tpGained:57, maxBullets:58, events:[...]}
dr_difficulty {name:"spade-rain", runs:20}            → {level:"easy", median:0, passable:true, danger:[...], suggestions:[...]}
dr_render {name:"spade-rain", frames:[0,60,150], autoplay:"demo", sheet:true, scale:2}
   → content: [ {type:"text",...}, {type:"image", data:"<base64 PNG>"}, ... ]   ← 畫面是 demo 腳本跑出來的
dr_record {name:"spade-rain", autoplay:"demo", scale:2}
   → 已錄影 298 幀（#0–#297，9.933s @ 30fps，1280×960，攻擊）／MP4：generated/record/spade-rain-2x.mp4
```

`dr_render` 回傳幾張圖取決於 `frames` 數量（上限 4 張；更多請給 `sheet:true` 或分批）。
圖片的實際檔案路徑也會寫在文字 content 裡（`outDir`），人可以直接開。

#### 5.4.1 `dr_record`（逐幀錄影，V2-11）

`dr_record` 是 `node tools/record.mjs` 的 MCP 包裝：同樣的引擎步進、同樣的輸出，
差別只在參數用 JSON 傳，而且沒給輸出路徑時預設寫到 `generated/record/<name>-<scale>x.mp4`。

| 參數 | 說明 |
|---|---|
| `name` 或 `doc` | 作品名（讀磁碟）或直接給 JSON |
| `autoplay` | `demo`（作品腳本，可重現）或 `bot`（全 AI）。建議一定給，不然只有第 0 幀不被操控 |
| `scale` | 1–3，最近鄰整數放大（預設 2） |
| `out` / `pngDir` / `wav` | 三種輸出（可同時給）；都不給 → `generated/record/<name>-<scale>x.mp4` |
| `maxFrames` | 上限（預設攻擊 900＝30 秒、遭遇 3600＝120 秒；到結果畫面會提早結束） |
| `seed` | 覆寫作品 `settings.seed`（寫暫存複本，**原檔不動**） |
| `noAudio` | 只出影像，不混音 |
| `preset` / `crf` | libx264 參數（預設 `medium` / `18`） |

回傳文字包含：幀數與時間軸、擷取速度（幀/秒）、輸出路徑、音訊事件統計、
`ffprobe` 驗證結果；出錯一律 `isError` 並說明下一步（例如沒有 ffmpeg 時改傳 `pngDir`）。

> 逐幀語意：頁面先凍結 `requestAnimationFrame`，再用 `tick(1)`＋`draw()` 固定步進，
> 每幀等素材 `whenIdle()` 後擷取，**不掉幀、不重複**（幀號連續、`--max-frames` 到就停）。
> 輸出固定 30 fps；`--fps` 其他值會被拒絕（引擎步進就是 1/30 秒）。
> 詳細輸出規格與限制見 [`docs/RECORD.md`](../../docs/RECORD.md)。

### 5.5 與人協作

| 工具 | 參數 | 說明 |
|---|---|---|
| `dr_editor_state` | `clientId?` | 讀「人正在編輯器裡看什麼」：開著的檔案、選取事件、時間游標、語言、最近動作 |
| `dr_editor_focus` | `kind` `name`；`frame?` `eventId?` `turn?` `lang?` `note?` | **指給人看**：讓開著的編輯器切到某檔 / 選取某事件 / 跳到某幀（走 SSE `focus`） |
| `dr_history` | `kind?` `name?` `client?` `limit?` | 修改紀錄（誰、何時、哪個檔、前後 etag） |
| `dr_restore` | `historyId?` 或 `trashId?` 或 `kind`+`name`+`etag` | 還原到某次修改前，或復原被刪的作品 |

```
dr_editor_state {}                                          → items:[{clientId:"human", name:"my-rain", selection:..., frame:42}]
dr_editor_focus {kind:"attack", name:"my-rain", frame:150, note:"看一下這裡的彈幕密度"}
dr_history {kind:"attack", name:"my-rain", limit:10}
dr_restore {trashId:"20261107-…"}                            → 從垃圾桶復原
```

這一組在**伺服器有開**時才有意義；離線時 `dr_editor_state`/`dr_history` 會明確說「沒有伺服器」。

### 5.6 MCP resources

除工具外也提供唯讀資源（給支援 resources 的客戶端）：

- `dr://docs/agent`、`dr://docs/spec`、`dr://docs/p2`、`dr://docs/guide`、`dr://docs/coordination`
- `dr://schema/attack`、`dr://schema/encounter`、`dr://schema/cues`

---

## 6. CLI 工具（不經 MCP 也能用；MCP 只是包裝）

所有 CLI 都吃**作品檔路徑**（相對於 cwd、作品根、`attacks/`、`encounters/`、`samples/` 都能解析，可省 `.json`），
也都吃 `--root` / `--works`（見 §4.5）。

### 6.1 `export-schema.mjs`

```bash
node tools/agent/export-schema.mjs              # 重產 generated/schema/*.json（內容沒變就不寫檔）
node tools/agent/export-schema.mjs --check      # 只檢查是否最新（不是就 exit 1，CI/測試用）
node tools/agent/export-schema.mjs --out /tmp/s # 輸出到別處（除錯用）
```

產物：`attack.json`（含 8 種事件）、`encounter.json`（19 條 cue）、`cues.json`（含指令字典、表達式參考、4 組配方）。
全部是 JSON Schema draft 2020-12，每個欄位都有**中文 `description`**，另有 `x-expressions` / `x-defaults` / `x-easingNames` / `x-eventTypes` / `x-cueCommands` 等擴充欄位可被程式讀取。

**SPEC-EXPR-V2 同步**（`docs/SPEC-EXPR-V2.md`）：

- `settings.bpm`（`number | null`、`exclusiveMinimum: 0`、預設 `null`）與 `settings.beatOffset`（秒、預設 0）。
- 時間欄位都接受**拍點字串** `"2b"` / `"0.5b"` / `".5b"`（pattern 與引擎 `BEAT_RE` 一致）：
  `settings.duration`、事件 `at`/`duration`/`interval`/`fade`、`spawn.at`、`spawnFields.life`、`demo.path[].t`。
  時間點欄位（`at`、`demo.path[].t`）會再加 `beatOffset`，長度類欄位不加——換算由引擎負責，schema 只描述型別。
- 生成欄位多 `memory`（物件：名稱 `[A-Za-z_$][A-Za-z0-9_$]*`、值是數字或表達式字串；`spawn` 與 `emitter.spawn` 共用）。
- `x-expressions.variables` 多了 `spawnX`/`spawnY`/`spawnT`/`bpm`/`beat`/`mem`（全部有中文說明），
  `x-defaults.settings` 帶 `bpm`/`beatOffset` 預設值。

`tools/check-samples.mjs`（離線結構驗證器）同步吃同一套規則：拍點字串與 `memory` 的換算、保留名、
白名單編譯**直接向引擎借** `parseBeatString` / `timeToSeconds` / `beatTimingOf` / `isValidMemoryName` / `compile`，
不在驗證器裡另寫一份，所以 `node tools/check-samples.mjs` 對含 `"2b"`、`memory` 的作品不會再誤報；
沒 `settings.bpm` 卻用拍點字串、`memory` 名稱非法時會給明確錯誤。

### 6.2 `sim.mjs`

```bash
node tools/agent/sim.mjs <攻擊|遭遇檔> [--autoplay demo|bot] [--frames N] [--bot dodge|idle|random] [--inputs script.json]
                        [--seed N] [--horizon N] [--graze-bias X] [--max-events N] [--events] [--trace] [--json]
                        [--root DIR] [--works DIR]
```

- **自動演示（新，預設）**：沒有 `--bot` / `--inputs` 時走 `--autoplay bot`（可給 `--autoplay demo`）。
  - `demo`：攻擊讀作品的 `demo.path` / `demo.inputs`，遭遇讀遭遇檔的 `demo`（選單、文字、FIGHT、每回合躲避）；`bot`：全程 AI（遭遇用 `default` 規則）。
  - 兩者都經 `engine/autoplay` 的 `createAutopilot`；遭遇的 `resolveAttackDoc` 會預先載入每回合攻擊檔（同步查表）。
  - 輸出多了 `autoplay: { mode, warnings, describe }`，可直接看到 pilot 選了 path/inputs/bot、走到第幾回合與腳本警告。
- 舊參數仍相容：`--bot idle|random|dodge`（明確給 `--bot` 就不啟用 autoplay）、`--inputs`（優先於 autoplay）。
- 攻擊：用 `createBattle` + `battle.engine.stepFrame(input)` 逐幀（**注意**：`battle.step()` 在無頭環境不吃輸入，`sim.mjs` 已處理）；pilot 的 `{press,hold}` 會轉成引擎要的 `{dx,dy,slow}`。
- 遭遇：用 `createEncounter`，以 `resolveAttack` 從 `samples/`、`attacks/` 解析攻擊參照；文字框/選單由 autopilot 推進，所以無人操作也能跑完整場。沒有 autoplay / 舊 bot 時才退回原本每 6 幀 `confirm` 的啟發式。
- `--inputs script.json`：輸入腳本格式
  ```json
  [
    { "frame": 0,  "hold": { "left": true } },
    { "frame": 30, "press": ["confirm"] },
    { "frame": 60, "dx": 1, "dy": -1, "slow": false }
  ]
  ```
  兩種寫法都接受：`{frame, dx, dy, slow}`（引擎 `stepFrame` 風格）或 `{frame, press, hold}`（遭遇風格）。
  每條指令從 `frame` 起沿用，直到下一條。
- 輸出（`--json` 時就是 SPEC-AGENT §3 的欄位）：

```json
{
  "kind": "attack", "name": "spade-rain",
  "frames": 297, "totalFrames": 300, "ended": true, "result": "ended",
  "hits": 0, "grazes": 57, "damageTaken": 0, "hpLost": 0, "tpGained": 57, "peakTp": 57,
  "maxBullets": 58, "avgBullets": 21.4,
  "party": [{ "name": "Kris", "hp": 90, "maxHp": 90 }],
  "autoplay": { "mode": "demo", "warnings": [], "describe": { "mode": "demo", "dodge": "path", "turn": null, "step": 0 } },
  "errors": [], "events": [], "sfx": [], "perTurn": [], "trace": []
}
```

#### 遭遇事件流（`events` / `eventCounts` / `perTurn`）

跑**遭遇**時 `events` 不再是空的：`engine/encounter/**` 只加「事件發射」（`world.emit` / `flow.note` /
`text` 的 `onEvent`），模擬器把它們全收進來，每筆都補上 `frame`（引擎當下幀）與 `turn`（0 起算）。
順序與模擬時間軸一致（幀單調不減）。`eventCounts` 是 `{type: 次數}` 的快速摘要。

| `type` | 時機 | 主要欄位 |
|---|---|---|
| `turnStart` / `turnEnd` | 回合開始 / 結束 | `turn`、`phase` |
| `actions` | 選單結算（玩家這一回合的指令） | `actions[]`：`member` / `memberId` / `command`（`fight`/`act`/`magic`/`item`/`spare`/`defend`）/ `occupied` / `target` / `actId` / `spellId` / `itemIndex` / `itemId` / `targetMember` |
| `defend` | 某位隊員選擇防禦（含 +16 TP） | `member`、`memberId` |
| `act` / `actDone` | ACT 開始執行 / 效果結算 | `enemy`、`actId`、`text`（ACT 文字）、`mercy`（這次 ACT 會給的饒恕值） |
| `spare` | 饒恕嘗試 | `enemy`、`ok`、`mercy`、`spareAt` |
| `magic` / `item` | 施法 / 用道具 | `spellId` + `cost` / `itemId` + `heal` + `countLeft` + `targetMember` |
| `mercy` | 敵人饒恕值變化 | `id`、**`before` / `after` / `amount`** |
| `tp` | TP 變化（防禦、施法、擦彈…） | **`before` / `after` / `amount`**、`cause`（`defend`/`magic`/`graze`/…） |
| `hp` / `hurt` | HP 變化 / 被子彈打中 | `id`、`kind`（`party`/`enemy`）、**`from` / `to` / `amount`**、`cause`（`damage`/`heal`）、`source`；`hurt` 另有 `member`、`damage`、`hp`、`bulletType` |
| `say` / `bubble` | 台詞（含旁白） | `speaker`（可為 `null`＝旁白）、`text`；`bubble` 另有 `actor`、`side`、`x`、`y` |
| `attackStart` / `attackEnd` | 彈幕開始 / 結束 | `ref`（攻擊名）、`duration`；`attackEnd` 另有 **`hits` / `grazes`**、`frame` |
| `enemyRemoved` | 敵人被移除 | `id` |
| `end` | 戰鬥結束（僅一筆） | `result`：`victory` / `spared` / `defeat` / `flee` |

沒有變化的 HP / mercy（`from === to`）不發事件，避免雜訊。`perTurn[]` 每回合另有
`startedFrame` / `endedFrame` / `commands`（例：`["act","act","defend"]`），可直接對照時間軸。
`perTurn[].attacks`：該回合**實際播出**的攻擊 `[{ name, startFrame, endFrame, frames }]`（含 `turn.start`/`turn.end` 裡 `attack` cue 播的；
內嵌攻擊沒有名字時為 `"(inline)"`）。`perTurn[].attack` 在 `turn.attack` 為空時取 `attacks[0].name`。

`--json` 的 `events` 上限 2000 筆（`--max-events` 可調）；CLI 沒給 `--events` 時只印一行每種事件的次數。

### 6.3 `bot.mjs`

```bash
node tools/agent/bot.mjs <攻擊檔> [--frames N] [--bot dodge|idle|random] [--horizon 14] [--seed 1] [--grazeBias 0]
```

同一份攻擊跑三種 bot 印對照表（這就是「這份攻擊能不能過」的實證）。
bot 只用公開 `getState()`：對每顆子彈線性外推 `horizon` 幀、算 9 個方向的最小淨空（`dist - (r + 靈魂半徑)`）、貼牆扣分、擦彈加分，平手時維持原方向（避免抖動）。

`--grazeBias` > 0 會故意靠近子彈去擦彈（TP 流玩法），除錯時很有用。

### 6.4 `difficulty.mjs`

```bash
node tools/agent/difficulty.mjs <攻擊|遭遇檔> [--runs 20] [--bot dodge] [--autoplay demo|bot] [--frames N]
                               [--seed N] [--horizon N] [--graze-bias X] [--compare] [--json]
                               [--root DIR] [--works DIR]
```

- 每次跑換一個 `settings.seed`（子彈亂數）與 bot 種子，得到受傷次數分佈（count/min/p25/median/mean/p75/p90/max）、0 傷機率。
- **遭遇戰預設走 `--autoplay bot`**（人工智慧打完整場：選單、文字、FIGHT、每回合躲避）；
  想跑作品錄好的 demo 路線就給 `--autoplay demo`，想用舊的 `--bot` 啟發式則明確給 `--bot`。
- `--compare`：另外跑 `idle` 當基準線（給「不動會死幾個」的對照）。
- 危險時段：每 30 幀一桶，`hits`（該秒受傷）、`bullets`（子彈數）、`graze`、`tp`；另外標出 `dangerWindows`（每秒 ≥2 傷）與 `denseWindows`（畫面最擁擠）。
- 分級：`easy`（中位數受傷 ≤ 1 且零傷率 ≥ 50%）、`normal`（≤ 3）、`hard`（≤ 6）、`extreme`。
- **零傷率 vs 通關率（兩件不同的事）**：
  - `zeroHitRate` / `zeroHitRuns`：整段（整場）**完全沒受傷**的種子比例／數量。舊名 `clearRate` / `clearRuns` 仍保留（同值），但它**不是**「通關率」。
  - `completionRate`（只有遭遇有，攻擊為 `null`）：bot 把整場打完（`victory` ＋ `spared`）的比例；等於 `encounter.completionRate`。
- 多種子難度分析會改變 Dodge Bot 的前瞻幀數（最多 ±2）與近似選項評分（最多 ±1），同一組種子可重現結果。JSON 的 `botVariation` 會標出這些參數。一般演示維持原本的 Bot 設定。
- **`passable`（可通過）的定義依種類不同**，判定依據寫在 `passableReason`（一句話，含實際數字與門檻）：
  - 攻擊：中位數受傷 ≤ 6 **且** 零傷率 ≥ 15%（以本次抽樣的 bot 表現判定）。
  - 遭遇：通關率 ≥ 50%（＝bot 能不能把整場打完）。零傷率 0% 的 Boss 戰只要打得完就是 `passable: true`。
- 輸出結尾有**具體建議**（例如「3.2 秒的彈幕密度 61 發過高，建議降到 40 以下或給出 20px 以上的安全通道」）。

#### 整場難度報告（遭遇專屬）

`--json` 的 `encounter` 欄位（攻擊沒有）：

```json
{
  "turns": [
    { "turn": 1, "attack": "spade-rain", "runs": 16,
      "hits":   { "count": 16, "mean": 0.0, "max": 0, "median": 0 },
      "damage": { "count": 16, "mean": 0.0, "max": 0 },
      "noHitRate": 1, "frames": 543.8, "commands": ["act", "act", "defend"] }
  ],
  "dangerTurns": [ /* 受傷最多的前 3 回合 */ ],
  "mostDangerous": { "turn": 2, "attack": "ring-burst", "hits": { "mean": 1.2, "max": 3 }, "noHitRate": 0.25 },
  "outcome": { "counts": { "victory": 15, "spared": 1, "defeat": 0, "flee": 0, "timeout": 0 },
               "rates":  { "victory": 0.938, "spared": 0.062 } },
  "duration": { "frames": { "mean": 752, "max": 786 },
                "seconds": { "mean": 25.08, "max": 26.17 }, "timeoutRuns": 0 }
}
```

- `turns[]`：**逐回合**受傷分佈（平均/最大）、傷害、**無傷率**（`noHitRate` 0..1）、平均幀數、該回合的指令。
  `attack` 是 `turn.attack`；回合內只用 `attack` cue 播攻擊（`turn.attack: null`）時，會用實際播出的第一支補上名字，
  `attacks[]` 則列出該回合實際播出的所有攻擊名。有受傷卻查不到名字時文字輸出寫「攻擊名稱不明」，不會寫「無攻擊」。
- `completionRate`：通關率（`victory` ＋ `spared`）／runs。
- `mostDangerous`：只在真的有受傷時才指名（全 0 傷時為 `null`，不會亂報第 1 回合）。
- `outcome`：勝 / 饒恕 / 敗 / 逃跑 / 逾時的比例；`duration`：整場幀數與秒數（30 FPS）、逾時次數。
- CLI 文字輸出會印「結局比例、總時長平均/最長、最危險回合」＋逐回合表格（受傷平均/最大、傷害平均/最大、無傷率、平均幀數）。
- MCP `dr_difficulty` 同步支援（`kind:"encounter"` + `autoplay`），回傳同一個 `encounter` 欄位。

### 6.5 `render.mjs`

```bash
node tools/agent/render.mjs <攻擊|遭遇檔> [--frames 0,60,150 | --frames 0-120] [--autoplay demo|bot]
                           [--lang zh|en] [--scale 1-6] [--out DIR] [--sheet] [--hitboxes] [--phase ...]
                           [--port N] [--root DIR] [--works DIR]
```

- 自動：找 Edge → 起 `serve.py`（隨機埠，`--port` 可指定；作品根不是程式根時會把 `--works` 傳給它）→ headless Edge + CDP → 截圖 → 關掉 Edge 與伺服器。
- **幀精確**：兩種頁面都先凍結 `requestAnimationFrame`（`Page.addScriptToEvaluateOnNewDocument`），
  之後只靠頁面的 `tick(n)` 推進 → **要求第 N 幀，畫面就是第 N 幀**（不看實際經過時間；同參數可重現）。
  - 攻擊頁：`play.html?attack=…&frames=0&owner=page`，`__drPlay.tick(n)`，每張附 `getState()`（frame/子彈數/TP/隊伍 HP）。
  - 遭遇頁：`encounter-play.html?encounter=…&frames=<首幀>`，`__drEncounterPlay.tick(n)`；
    （自己開頁面時 `?encounter=` 可填作品名稱或可 fetch 的相對路徑，例如 `?encounter=bellwright` 或
    `?encounter=api/encounters/bellwright.json`；載入失敗會停在錯誤畫面並列出試過的網址，`dr_render` 也會直接回報「遭遇頁載入失敗」。）
    `--autoplay demo|bot` 時頁面在每次 tick 前用 pilot 餵輸入（與 `sim.mjs` 同一套 autopilot），截到的就是 demo/AI 實際跑的畫面。
- **截圖前等素材**：每次截圖前等「所有已請求的圖片/音訊載入完成」——
  頁面有 `window.__drAssetsIdle` 或 `assets().whenIdle()` 就用它，否則退回輪詢 `stats().pending + fonts.pending`，
  最多等 20 秒；逾時只記 warning（`第 N 幀截圖前素材仍未全部載入（畫面可能含洋紅佔位）`）不中斷。
  載入完會重畫一次才截圖 → 不會再截到洋紅佔位方塊。
- **每張結果都標 requested / actual**：`{ frame, requested, actual, actualFrame, file, size, state }`。
  回傳值頂層另有幀摘要：`requestedFrames`、`actualFrames`（逐項對應）、`frameMismatches: [{requested, actual}]`（只列不一致的，
  例如要求第 200 幀但攻擊已結束於第 123 幀）、`duplicateFrames`（多張其實是同一幀）。MCP `dr_render` 的文字輸出也會印 `actualFrames`。
  兩者不一致時在 `warnings` 說明原因：
  - `要求第 1400 幀，但戰鬥已結束於第 1016 幀（spared）`（結局後頁面停在結算幀，這是正確行為）
  - `要求第 300 幀，遭遇戰在第 200 幀前停止前進（實際 200）`（真的卡住）
  - `要求第 30 幀，實際截到第 45 幀`（超出）
- `--sheet`：把每幀拼成一張聯絡表（頁面內 canvas 排版後截圖，不引入影像函式庫），標籤用**實際**幀號。
- 輸出目錄（預設）：`%TEMP%/dr-agent-render/<作品名>-<時戳>/`，內含 `*.png`、`*-sheet.png`；檔名與路徑會印在結果與 MCP 文字 content。

```bash
node tools/agent/render.mjs samples/spade-rain.json --frames 0,60,150 --scale 2 --sheet
# 輸出：三張 1280×960 + 聯絡表 3880×1032，畫面含黑底紫格線、綠框、紅心、彈幕、TP 條、隊伍 HP

node tools/agent/render.mjs samples/encounters/rudinn.json --frames 0,300,900,1400 --autoplay demo --json
# requested/actual = 0/0、300/300、900/900、1400/1016
# warning: 要求第 1400 幀，但戰鬥已結束於第 1016 幀（spared）

node tools/agent/render.mjs my-enc --works D:/my-works --frames 0,300 --autoplay bot
# 作品根不是程式根：檔案複製到 tools/agent/.tmp 由頁面載入，伺服器收到 --works
```

---

## 7. 建議的 Agent 創作循環

```
1. dr_docs {doc:"guide"} / {schema:"attack"}      ← 先讀格式（不要猜欄位名）
2. dr_assets_search {kind:"sprite",tag:"bullet"}  ← 找現成素材名（spr_ 前綴）
   dr_assets_search {kind:"sfx"}                  ← 音效名（snd_ 前綴）
3. dr_read {name:"spade-rain"}                    ← 讀官方範例當骨架（samples/ 唯讀）
4. dr_write {name:"my-attack", doc:{...}}         ← 寫入（format 可省略，會自動補）
5. dr_validate {name:"my-attack"}                 ← 0 錯誤再往下
6. dr_simulate {name:"my-attack", autoplay:"demo"} ← 作品自己的 demo 腳本能不能過（hits 應為 0）
7. dr_simulate {name:"my-attack", bot:"idle"}     ← 基準線（不動會被打幾下）
8. dr_simulate {name:"my-attack", autoplay:"bot"} ← AI 能不能過
9. dr_difficulty {name:"my-attack", runs:20}      ← 分佈與危險時段，依建議調整
10. dr_render {name:"my-attack", frames:[0,90,180,240], autoplay:"demo", sheet:true}  ← 真的看一眼（畫面是 demo 跑的）
11. 依畫面/數據微調 → dr_patch（小改）或 dr_write（大改，記得帶 ifMatch）
12. dr_editor_focus {kind:"attack", name:"my-attack"}  ← 讓人的編輯器跳過來看成果
```

**品質底線**（建議寫進自己的檢查清單）：`validate` 0 錯誤 → `simulate` 無 `errors` →
`dodge` 的 hits < `idle` 的 hits → `difficulty.passable` 為 true → 截圖畫面元素對齊（框在畫面中央、
靈魂在框內、隊伍面板在下方、字沒溢出）。

**風格提醒**（詳見 `docs/AGENT-GUIDE.md` 與 `docs/SPEC.md` §7）：640×480 邏輯像素、30 FPS、
戰鬥框預設 144×158、中心 (320,190)、靈魂碰撞半徑 4px、擦彈判定 16px、DELTARUNE 彈幕講究「有節奏的危險 +
看得見的安全路線」，不是無腦鋪滿。

---

## 8. 與編輯器同步 / 衝突

- 人開著的編輯器訂閱 `GET /api/events` (SSE)；Agent 的 `dr_write`/`dr_patch`/`dr_delete` 會讓它
  自動重載（作為一筆可復原的變更），工具列會提示「Agent 修改」。
- 反向：Agent 先用 `dr_editor_state` 看人在看什麼；必要時 `dr_editor_focus` 把畫面指過去。
- `dr_write` 沒帶 `ifMatch` 是「盲寫」——會覆蓋。**接手別人的檔案前先 `dr_read` 拿 etag**。
- 所有寫入都記在 `history/YYYY-MM-DD.jsonl`（`dr_history` 查、`dr_restore` 還原）。

---

## 9. 降級模式（伺服器沒開）

`serve.py` 沒啟動時，MCP 伺服器會自動降級（也會在 `dr_docs`/`dr_list` 的 `source` 標 `"disk"`）：

| 能力 | 有伺服器 | 降級（直接磁碟） |
|---|---|---|
| 讀 / 列 / 驗證 / 模擬 / 難度 / 截圖 | ✓ | ✓ 完全可用 |
| 寫 / patch | ✓ 樂觀鎖 + 審計 + SSE 同步 | ✓ 直接寫檔（`ifMatch` 仍會比對，不符回 409 錯誤） |
| 刪除 | 移到 `trash/` | 移到 `tools/agent/.tmp/deleted/` |
| `dr_editor_state` / `dr_editor_focus` / `dr_history` / `dr_restore` | ✓ | 明確告知需要伺服器 |

`DR_SERVER_OFFLINE=1` 可強制走降級（`test.mjs` 用它驗證這條路徑）。

---

## 10. 測試

```bash
node tools/agent/test.mjs                 # 全部（約 5 秒）
node tools/agent/test.mjs --skip-render   # 沒有 Edge / 不想開瀏覽器時
node tools/agent/mcp-server.mjs --print-tools
```

目前：**76 項**（開發機全跑：76 通過 / 0 失敗；沒有 Edge 時會自動跳過實截圖那幾項）。涵蓋 11 組：

1. **schema**：三個檔存在、draft 2020-12、事件與 `EVENT_TYPES` 一致、cue 與 `CUE_COMMANDS` 一致、冪等、預設值與引擎常數同步
2. **驗證**：4 個 sample 攻擊 + 2 個 sample 遭遇 0 錯誤；壞資料（負向）會被抓到
3. **模擬**：4 攻擊 + 2 遭遇跑得完、統計合理、`--frames` 上限、同 seed 決定性；**遭遇事件流**（回合/指令/ACT/mercy/TP/HP/台詞/攻擊/結果齊全、`before`/`after` 有值、`from===to` 不發、`perTurn` 指令與起訖幀正確、可序列化且幀單調）
4. **bot**：只用 `getState()`、三種 bot 合法、spade-rain 上 `dodge`(1) 明顯優於 `idle`(6)
5. **難度**：多種子分佈/危險曲線/建議；**遭遇整場報告**（逐回合受傷分佈/無傷率/最危險回合/結局比例/總時長/`--autoplay demo`）
6. **MCP**：initialize、tools/list（16，含 V2-11 的 `dr_record`）、ping、`dr_docs`/`dr_validate`/`dr_read`/`dr_assets_search`/`dr_list`、`dr_record` 缺參數/找不到作品的錯誤訊息、未知工具/方法錯誤碼
7. **離線降級**：`DR_SERVER_OFFLINE=1` 下 list/read/search/write/patch/409/delete 往返
8. **渲染**：真的開 Edge 截 2 幀 + 聯絡表、PNG 非全黑、**未存檔的 `doc` 也渲染成正確作品**；另外純函式測 `parseFrameList` 與 `framePrecisionWarning`（requested/actual 一致不警告、結束/卡住/超出的 4 種文案）（無 Edge 自動跳過實截圖）
9. **路徑**：`--root`/`--works`/`DR_ROOT`/`DR_WORKS` 解析、作品名優先順序、錯誤的 root 與不存在的 works 會明確報錯（不改到全域狀態）
10. **素材訊號**：`pendingCount()`/`whenIdle()`（索引失敗立即可用、preload 後歸零、仍有載入中會等、timeout 回 `{timedOut:true}` 不 reject、可重複呼叫）
11. **SPEC-EXPR-V2 同步**：schema 的 `bpm`/`beatOffset`/10 個時間欄位的拍點 pattern（與引擎 `parseBeatString` 對照）、`memory` 物件與三處 `$defs`、6 個新變數的中文說明（`x-expressions` 與 `cues.json` 都檢查）、SPEC §3 三個範例（`check-samples` 0 錯誤 0 警告、`validateAttack` 0 錯誤、`normalizeAttack` 換算秒數、原始 JSON 不被改寫）、負向（沒 bpm 用 `"2b"`、`memory.constructor`）與 samples 回歸

---

## 11. 疑難排解

| 症狀 | 原因與解法 |
|---|---|
| `找不到 Edge` / render 直接失敗 | 裝 Edge，或設 `MSEDGE_PATH`。其他工具不受影響 |
| render 畫面一直不動、`frame` 都是 0 | 攻擊頁需要 `owner=page` 才能 `tick`（`render.mjs` 已帶）；自己寫腳本時別漏 |
| 截圖全黑 | 通常是 `scale` 太小或 canvas 還沒畫第一幀；先用 `--frames 0` 確認，或加 `--scale 2` |
| `requested` 與 `actual` 不一致 | 看 `warnings`：`已結束於第 M 幀`＝戰鬥比要求幀先結束（正常，改截更前面的幀）；`停止前進`＝頁面 tick 沒推進（看 `--frames 0` 是否正常、有沒有 console 錯誤）；`實際截到第 M 幀`＝超出 |
| 畫面還有洋紅方塊 | 素材還在載入：`render.mjs` 會等 `whenIdle`（20 秒）並重畫才截圖；若仍出現，看同一筆 warning 的「素材仍未全部載入」 |
| `dr_write` 一直 409 | 別人（人或其他 Agent）改過檔案：拿回應的 `current` + 新 `etag` 重做一次 |
| schema 是舊的 | 重跑 `node tools/agent/export-schema.mjs`；`--check` 可判斷 |
| MCP 客戶端看不到工具 | 確認 `node` 在 PATH（或用絕對路徑）、`mcp-server.mjs` 路徑正確、客戶端有重啟 |
| DSH/Claude Code 顯示伺服器啟動失敗 | 先用 `node tools/agent/mcp-server.mjs --print-tools` 確認能跑；stderr 有錯會印原因 |
| 埠被佔用 | 伺服器換埠：`serve.py --port 19001`，工具設 `DR_SERVER_URL=http://127.0.0.1:19001`；`render.mjs` 自己起伺服器時用 `--port` |

---

## 12. 已知限制 / 與 SPEC 的偏差

- **`dr_simulate` 預設走 `autoplay bot`（全 AI），`autoplay demo` 才照作品腳本**；兩者都不是人類最佳操作，要精準重現請用 `--inputs`。舊 `--bot` 路徑的遭遇啟發式（每 6 幀 `confirm`）只在沒有 autoplay 時使用。
- **`dr_render` 對攻擊頁與遭遇頁都是決定性逐幀**：兩頁都先凍結 `requestAnimationFrame`，再用頁面的 `tick(n)` 推進；不看實際時間，同參數可重現。少數情況會出現 `actual != requested`（戰鬥提前結束、頁面停止前進），一律在 `warnings` 說明並在每張結果標 `requested`/`actual`。
- **bot 是貪婪法**（外推 + 最小淨空），不是最優解：`dodge` 的受傷數是「合理玩家」上界，不是「一定能過」的證明。極端彈幕（>200 發/秒）外推成本上升，`--horizon` 可調小。
- **`generate/schema` 是產生物**，不進 git（`/battle-editor/generated/` 已忽略）；新環境要先跑 `export-schema.mjs`。
- **MCP 工具數量固定 15 個**（對應 SPEC-AGENT §4）；沒有額外的任意檔案讀寫或程式執行工具（安全邊界）。
- **`serve.py` 的 `/api/schema/*` 缺檔提示**寫的是舊檔名 `gen-schema.mjs`（實際為 `export-schema.mjs`）——屬 W2 範圍，AG 未改；照 README 的指令跑即可。
- Azure/雲端 MCP 傳輸（HTTP/SSE）未實作：本地 stdio 足夠，且 SPEC 要求只綁 127.0.0.1。

---

## 13. 授權與素材

作品與工具只在本機使用；`assets/` 內的 DELTARUNE 官方素材版權屬 Toby Fox，
僅供本機實驗，**不隨 git 提交**（見專案根 `.gitignore`）。工具本身零依賴、可自由改。

### 附註：不認得的旗標（REALTEST-2 後補）

`sim.mjs` / `difficulty.mjs` / `render.mjs` / `demo-path.mjs` / `bot.mjs` / `tools/record.mjs` 遇到不支援的 `--xxx` 會在 stderr 印
`警告：不認得的旗標 --xxx（這支工具不支援，已忽略；它後面的值會被當成位置參數）`，並在拼字相近時提示正確旗標；工具照常執行。
`tools/record.mjs` 另外接受 `--kind attack|encounter`（只做確認，類型一律依檔案內容判定）。
