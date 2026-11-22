# 可遊玩 HTML 匯出（V2-09）

把一個攻擊（attack）或遭遇（encounter）連同「實際用到的」引擎模組與素材，打包成**單一 HTML 檔**。
檔案用瀏覽器直接雙擊（`file://`）就能玩：沒有伺服器、沒有任何對外請求、不需要 Node.js。

- CLI：`tools/export-game.mjs`
- 伺服器 API：`POST /api/export/game`（serve.py）
- 頁面按鈕模組：`tools/web/export-button.js`

---

## 1. CLI 用法

```bash
cd battle-editor

# 遭遇（預設語言 zh、預設輸出 <名字>.html）
node tools/export-game.mjs rudinn --kind encounter --out r/mini-rudinn.html

# 攻擊（省略 --kind 時會先找遭遇、再找攻擊）
node tools/export-game.mjs spade-rain --lang en --title "Spade Rain" --out out/spade.html

# 不提供自動演示切換；作品根優先（與 serve.py --works 相同語意）
node tools/export-game.mjs my-boss --kind encounter --works ../works/my-game \
  --no-autoplay-toggle --out my-boss.html
```

選項：

| 選項 | 說明 |
| --- | --- |
| `--kind encounter\|attack` | 指定種類；省略時先找遭遇、再找攻擊 |
| `--out <檔案>` | 輸出路徑（預設 `<名字>.html`，相對目前工作目錄） |
| `--lang zh\|en` | 介面語言與字型（預設 `zh`；`en` 不內嵌 `@zh` 字型，檔案小很多） |
| `--title "..."` | 標題畫面的標題（預設作品的 `meta.name`） |
| `--no-autoplay-toggle` | 不提供自動演示切換（作品有 demo 時預設會提供） |
| `--root <battle-editor>` | 引擎與素材根目錄（預設就是這個 repo） |
| `--works <作品根>` | 作品根：優先讀 `<works>/attacks`、`<works>/encounters`；省略時讀 `DR_WORKS` 環境變數 |
| `--json` | 以 JSON 印出結果（給程式呼叫；`serve.py` 就是這樣用） |
| `--help` | 用法說明 |

成功時印出：

```
已匯出可遊玩 HTML：C:\...\out\spade-rain.html
  大小：3958413 bytes（3.78 MB）
  內嵌：19 個引擎模組、18 張 sprite（63 幀）、2 個音訊、10 個字型
  作品：spade-rain（attack）／語言 zh／自動演示 開
```

JSON payload 形狀：

```json
{
  "ok": true, "tool": "dr-battle-editor/export-game.mjs", "format": "dr-battle-export/1",
  "kind": "attack", "name": "spade-rain", "title": "黑桃雨", "lang": "zh",
  "autoplay": true, "hasDemo": true, "out": "...", "bytes": 3958413,
  "modules": 19, "moduleBytes": 123456,
  "assets": {"sprites": 18, "frames": 63, "audio": 2, "fonts": 10, "bytes": 3200000},
  "warnings": [],
  "source": {"kind": "attack", "name": "spade-rain", "attacks": []}
}
```

錯誤時：

```json
{"ok": false, "tool": "dr-battle-editor/export-game.mjs", "code": "not_found", "error": "找不到遭遇或攻擊：no-such", "name": "no-such"}
```

| `code` | HTTP 對應 | 意思 |
| --- | --- | --- |
| `not_found` | 404 | 作品不存在 |
| `invalid_name` | 400 | 檔名不合法（只接受英數、`_`、`-`、中文） |
| `bad_request` | 400 | 參數錯（未知 kind、`--lang` 不是 zh/en…） |
| `bad_file` | 409 | JSON 壞掉，或 `format` 不是 `dr-battle-attack/1` / `dr-battle-encounter/1` |
| `missing_attacks` | 409 | 遭遇引用了不存在的攻擊檔 |
| `missing_assets` | 409 | 素材索引或素材檔不存在 |

### 檔案讀取順序

與 `serve.py` 一致：**作品根優先，其次 repo**。

1. `<works>/encounters/<name>.json`、`<works>/attacks/<name>.json`（有 `--works` 時）
2. `<battle-editor>/encounters/<name>.json`、`<battle-editor>/attacks/<name>.json`
3. `<battle-editor>/samples/encounters/<name>.json`、`<battle-editor>/samples/attacks/<name>.json`

遭遇引用的攻擊也用同一順序找；所以「作品根只有遭遇、攻擊放在 repo samples」也能匯出。

---

## 2. 產出的 HTML 是什麼

- **單一檔案**：HTML + CSS + 一個 `<canvas>` + 內嵌的引擎模組 + 內嵌素材，全部在同一個檔案裡。
- **沒有對外請求**：引擎以 `<script type="importmap">` 把每個模組的合成 URL
  指向 `data:text/javascript;base64,…`；素材索引以 JSON 放在 `<script id="dr-asset-index">`，
  啟動時用 `Blob` URL 交給既有的 `engine/assets.js`（**assets.js 完全沒改**）。
  Sprite 幀、字型圖與 glyph JSON、音訊檔都是 `data:` URL。
- **只打包實際用到的素材**：文件裡引用的 sprite/音訊（含引擎原始碼寫死的 `spr_*` / `snd_*`）、
  渲染器一定會用到的 UI sprite、介面需要的字型；不認識的名字會列在 `warnings`，不會讓匯出失敗。
- **640×480、整數倍最近鄰放大**：依視窗大小選 `1×/2×/3×…`，維持像素風。
- **沒有 `File`/`fetch` 對外行為**：整份檔案可離線、可寄給別人、可放在隨身碟。

### 操作

| 鍵 | 功能 |
| --- | --- |
| 方向鍵 / WASD | 移動（戰鬥中）／選單 |
| Z / Enter / Space | 確認、開始、重來 |
| X / Shift | 慢速／取消 |
| C | 顯示判定框與格線（除錯） |
| F | 全螢幕 |
| M | 靜音 |
| P | 切換自動演示（off → demo → bot；只有作品有 demo 且沒關掉切換時） |

標題畫面按 Z 開始。勝利或饒恕時，在戰鬥底部文字框確認勝利旁白後，工具列會提示按 Z 重來。
失敗、逃走和單段攻擊仍有結果畫面，可按 Z 重來。工具列也有「自動演示」按鈕（3 態）與操作提示。

### 自動演示

- 作品有 `demo` 就會預設提供切換（`--no-autoplay-toggle` 可關掉）。
- `demo` 模式：播放作品內建腳本（遭遇：`demo.turns`；攻擊：`demo.path`），從第 0 幀開始。
- `bot` 模式：由 autopilot 的機器人操作（遭遇的 demo 沒有涵蓋的回合會 fallback）。
- 自動演示是「頁面自己踩幀」：暫停引擎 rAF，用固定 30 FPS 累加器呼叫既有的
  `sim.stepFrame()` / `encounter.step()`；不影響正常手動操作的程式路徑。

---

## 3. 伺服器 API

`POST /api/export/game`（serve.py 只多了這一個端點，其他行為不變）

請求：

```json
{"name": "rudinn", "kind": "encounter", "lang": "zh", "title": "Rudinn", "autoplayToggle": true}
```

- `name`：必填，作品名稱（不含 `.json`）。
- `kind`：`attack` / `encounter`，省略時自動判斷。
- `lang`：`zh` / `en`，省略時用 CLI 預設（`zh`）。
- `title`：字串，可省略。
- `autoplayToggle`：`false` 時加 `--no-autoplay-toggle`（預設 `true`）。

回應：`200`、`text/html; charset=utf-8`、`Content-Disposition: attachment; filename="<name>.html"`，
body 就是單檔 HTML。`ETag`、`Cache-Control: no-store`、`X-Export-Bytes` 也會帶。
錯誤：`400` 參數錯、`404` 找不到、`409` 檔案壞或素材缺、`500` 子程序失敗（JSON body `{"ok": false, "error": ...}`）。
伺服器會把 `--root` 與 `--works` 傳成跟自己啟動時一致，因此工作目錄/作品根不同的伺服器也匯出正確的內容。

```bash
curl -s -X POST http://127.0.0.1:18900/api/export/game \
  -H 'Content-Type: application/json' \
  -d '{"name":"spade-rain","kind":"attack","lang":"en"}' \
  -o spade-rain.html
```

---

## 4. 頁面按鈕模組

`tools/web/export-button.js` 不依賴任何頁面框架，也不直接認識作品資料；由呼叫端提供取得目標的函式：

```js
import { mountExportButton } from './tools/web/export-button.js';

const exportButton = mountExportButton({
  container: document.getElementById('toolbar'),
  getTarget: () => ({ name: currentName, kind: currentKind }), // kind 可省略 null
  lang: 'zh',
  // endpoint: '/api/export/game', fetchImpl: window.fetch（測試可注入）
});

// 不再需要時
exportButton.destroy();
```

- 按下 → `POST /api/export/game` → 以 `<a download>` 下載 `<名稱>.html`；按鈕旁顯示「匯出中…」「已下載」或伺服器錯誤文字。
- 沒有選作品時不發請求，直接顯示錯誤。
- 純函式（`buildExportRequest`、`filenameFromDisposition`、`errorMessageFromPayload`、`downloadBlob`）
  與 DOM 黏著層都能在 Node 測試；`node tools/web/export-button.test.mjs` 用假 DOM/fetch 驗證完整流程。
- **本次沒有把它掛到任何頁面**（編輯器頁由其他任務處理）。

---

## 5. 檔案大小參考

下表是預設範例的歷史實測。自訂音樂和大量動畫幀會讓檔案更大，例如 Doppeldoll ENCORE 內嵌 3.5 MB 音樂與 84 個 sprite，輸出約 12.7 MB。
CLI 摘要和 JSON 的 `sizeBreakdown` 會分別顯示 BGM、音效、sprite、字型與引擎的內嵌位元組數，已計入 Base64 編碼。HTML 外殼與作品 JSON 也佔用少量空間。

| 作品 | 語言 | 大小 | 內容 |
| --- | --- | --- | --- |
| `spade-rain`（攻擊） | `zh` | 3.78 MB（3,959,508 B） | 19 模組、18 sprites/63 幀、2 音訊、10 字型 |
| `spade-rain`（攻擊） | `en` | 1.08 MB（1,132,738 B） | 同上，但不含 `@zh` 字型 |
| `rudinn`（遭遇，含 3 個攻擊） | `zh` | 7.68 MB（8,056,579 B） | 29 模組、50 sprites/303 幀、9 音訊、10 字型 |
| `rudinn`（遭遇） | `en` | 4.99 MB（5,229,809 B） | 同上，但不含 `@zh` 字型 |

重量級素材：`battle.ogg` 1.84 MB（base64 後約 2.45 MB）、`fnt_main_wide` 約 276 KB、
每個 `fnt_*@zh` 約 530–560 KB（圖片＋glyph JSON）。因此：

- 語言選 `en` 可省下約 2.6 MB 的 `@zh` 字型。
- `DTM.otf`（4.34 MB）**故意不內嵌**；缺它時渲染器會退回系統字型，不影響遊玩。
- 要縮小攻擊檔，可移除作品 `settings.bgm`（音樂檔最貴）；`--no-autoplay-toggle` 對大小影響很小。

---

## 6. 已知限制

- **沒有 `filesystem`/存檔**：遊戲狀態只在這個頁面的記憶體裡，關掉就沒了。
- **音訊要使用者手勢**：瀏覽器自動播放政策下，行動版/部分設定要等第一次按鍵（Z）才聽得到 BGM；
  標題畫面按 Z 開始的流程天然滿足這個條件。headless 驗收用 `--autoplay-policy=no-user-gesture-required`。
- **DTM 字型不內嵌**（4.34 MB，CP 值低）；需要它的作品請在 `warnings` 看到提示或另外處理。
- **引擎內建素材不算缺素材**：`spr_grazemask*` / `spr_grazeappear*`（擦彈遮罩與外框由 `engine/graze-mask.js` 內建資料繪製）與
  `snd_cancel` / `snd_move` / `snd_nosound`（選單 UI 音效，缺檔靜默）主索引沒有時**不再列入 `warnings`**，只在回傳值的 `info[]`
  （CLI 的「備註」）提一行；`warnings` 只留真正的缺素材（作品或引擎引用、索引沒有、也不在內建名單）。
- **只有「單場」**：一次匯出一個攻擊或一個遭遇；遭遇內含的攻擊會一起打包，但不會打包編輯器的其他頁面。
- **不要改 assets.js 的假設**：本工具靠 import map + `data:` URL + Blob index 運作，不需要 assets.js 提供
  「記憶體 index」鉤子；若之後 assets.js 有破壞性改動（例如 `loadAssets` 不再接受 blob/data URL），
  匯出檔的 asset 載入會壞，需要在 `tools/export-game.mjs` 的啟動 shim 調整。
- **自動演示依賴作品 demo**：沒有 `demo` 的作品只能手動玩（或自行用 `setAutoplay('bot')`，但 UI 預設不顯示切換）。
- 匯出檔很大（數 MB）時，`file://` 首次載入需要解 base64，較舊機器可能有一小段延遲。

---

## 7. 測試與驗收

```bash
cd battle-editor

# 單元＋整合（寫到 %TEMP%\V2-09，不寫 repo）
node tests/export/run.mjs

# 頁面按鈕模組
node tools/web/export-button.test.mjs

# 伺服器端點（自己的埠 18950+，啟動 serve.py 子程序，結束關閉）
python -m unittest tests.server.test_export_game -v

# 真正的瀏覽器驗收（headless Edge、file://、CDP 收集 console/network/截圖）
node tools/export-game.mjs spade-rain --kind attack --lang zh --out %TEMP%\V2-09\out\spade-rain.html
node tests/export/edge-acceptance.mjs \
  --html %TEMP%\V2-09\out\spade-rain.html \
  --out-dir %TEMP%\V2-09\shots-spade --label spade-rain --expect-result survived

node tools/export-game.mjs rudinn --kind encounter --lang zh --out %TEMP%\V2-09\out\rudinn-zh.html
node tests/export/edge-acceptance.mjs \
  --html %TEMP%\V2-09\out\rudinn-zh.html \
  --out-dir %TEMP%\V2-09\shots-rudinn --label rudinn-zh --expect-result spared
```

驗收腳本會檢查：console error / page exception / log error 皆 0；除了主文件 `file:` 之外
沒有任何 `http(s)` 請求（只允許 `data:`、`blob:`、`about:`、`devtools:`、`chrome-extension:`）；
標題／戰鬥中／結束三張截圖；demo 跑到結束的結果與幀數（不符合 `--expect-result` 會 fail）。

參考結果：`spade-rain` → `survived`（297 幀）；`rudinn` demo → `spared`（1016 幀）。
