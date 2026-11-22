# 離線逐幀錄影（V2-11）

`tools/record.mjs` — 把一場戰鬥／遭遇錄成**逐幀精確**的影片或圖片序列。

- 不用螢幕錄影、不吃實際時間 → **不掉幀、不重複**，同參數可重現。
- 音訊不是「順便收音」，而是**引擎自己記的事件表**在 Node 端重新混音 → 音畫對得上。
- 輸出固定 **30 fps**（引擎步進就是 1/30 秒）。

```bash
cd battle-editor

# 攻擊 → MP4（2× 最近鄰放大 1280×960）
node tools/record.mjs samples/spade-rain.json --autoplay demo --scale 2 --out out/spade-rain-2x.mp4

# 遭遇 → MP4（1× 640×480）
node tools/record.mjs samples/encounters/rudinn.json --autoplay demo --scale 1 --out out/rudinn-1x.mp4

# 只給剪輯軟體：PNG 序列 + WAV（不產生 MP4）
node tools/record.mjs samples/encounters/rudinn.json --autoplay demo --png-dir out/rudinn-frames --wav out/rudinn.wav
```

MCP 版（參數一一對應，見 `tools/agent/README.md` §5.4.1）：

```
dr_record { name:"spade-rain", autoplay:"demo", scale:2 }
```

---

## 1. 需求

| 需求 | 說明 |
|---|---|
| Node.js ≥ 20 | 與其他 `tools/` 相同，零 npm 依賴 |
| Microsoft Edge | headless + `--mute-audio` 跑頁面；找不到時明確報錯（可用 `MSEDGE_PATH` 指定） |
| ffmpeg / ffprobe | 合成 MP4／WAV、驗證輸出。**找不到 ffmpeg 時只影響 MP4／WAV，`--png-dir` 仍可用**（PNG 序列本身就是完整素材） |
| Python | 自動起 `serve.py` 當靜態伺服器（只綁 127.0.0.1，隨機埠） |

ffmpeg 安裝（Windows）：

```bash
winget install Gyan.FFmpeg
# 或自行下載後設 FFMPEG_PATH / FFPROBE_PATH
```

---

## 2. 用法

```
node tools/record.mjs <攻擊檔|遭遇檔> [選項]
```

| 選項 | 說明 |
|---|---|
| `--autoplay demo\|bot` | 自動演示：`demo`＝作品自己的示範腳本（**可重現**，錄影請用這個）；`bot`＝AI 全場閃避。不給就只有第 0 幀沒有操控輸入 |
| `--scale 1\|2\|3` | 輸出倍率，最近鄰整數放大（1×＝640×480、2×＝1280×960、3×＝1920×1440）。預設 2 |
| `--out x.mp4` | 輸出 MP4（H.264 yuv420p + AAC） |
| `--png-dir dir` | 輸出 PNG 序列 `f0000.png`、`f0001.png`…（給剪輯軟體；也可單獨使用） |
| `--wav x.wav` | 混音後的 WAV |
| `--lang zh\|en` | 介面語言（影響遊戲內文字；預設 `zh`） |
| `--seed n` | 覆寫作品 `settings.seed`，只寫**暫存複本**，原檔不動 |
| `--max-frames n` | 最多幾幀（預設攻擊 900＝30 秒、遭遇 3600＝120 秒；到結果畫面會提早停） |
| `--kind attack\|encounter` | 只用來**確認**類型（與 `pack.mjs` / `export-game.mjs` 的習慣一致）；錄影一律依檔案內容自動判定，不符時給警告 |
| `--capture screenshot\|canvas` | 擷取方式，見 §4 |
| `--keep-frames` | 保留暫存 PNG（預設沒給 `--png-dir` 時，錄完會逐檔刪掉自己的暫存序列） |
| `--hud` | 錄進頁面 HUD／自動演示提示列（預設 `?chrome=0` 只錄乾淨畫布，適合二創剪輯） |
| `--no-audio` | 不混音、不掛音軌 |
| `--verify` | 相容舊命令；MP4 一律先用 ffprobe 驗證，驗證通過才發佈到指定位置 |
| `--json` | 以 JSON 印出結果（給腳本／MCP 用） |
| `--preset` / `--crf` | libx264 參數（預設 `medium` / `18`；CRF 越小越清晰、檔案越大） |
| `--root` / `--works` | 程式根 / 作品根（與其他 `tools/agent/*` 同一套 `lib.mjs` 解析，也可用 `DR_ROOT` / `DR_WORKS`） |
| `--ffmpeg` / `--ffprobe` | 指定執行檔路徑（也可用 `FFMPEG_PATH` / `FFPROBE_PATH`） |
| `--port` | 自訂伺服器埠（預設自動挑；**不會碰 18900**） |

三種輸出至少要給一種（`--out`、`--png-dir`、`--wav` 可同時給）。`--fps` 只接受 30：
其他值會直接報錯，因為引擎步進是 1/30 秒，改 fps 只會讓時間軸說謊。

### 2.1 執行流程（為什麼能逐幀精確）

1. 起一個臨時靜態伺服器（`serve.py`，隨機埠、只綁 127.0.0.1），用 headless Edge 開
   `play.html?attack=…` 或 `encounter-play.html?encounter=…`。
   （自己開遭遇頁時：`?encounter=` 可以填**作品名稱**（`?encounter=bellwright`，依序找 `api/encounters/<名稱>.json` → `encounters/` → `samples/encounters/`）或**頁面可 fetch 的相對路徑**（`?encounter=api/encounters/bellwright.json`、`?encounter=samples/encounters/rudinn.json`）。載入失敗會**停在錯誤畫面**並列出試過的網址（不會偷偷換成內建範例或假資料）；只給 `?file=`（編輯器的參數）會被當成 `?encounter=` 並提示；兩者都沒給才載入內建範例 `rudinn`（banner 會寫明）。）
2. **頁面載入前**注入腳本：凍結 `requestAnimationFrame`（不讓頁面自己跑），並建立
   `window.__drAudioLog` 音訊事件記錄器。
3. 逐幀迴圈：用頁面把手 `window.__drPlay` / `window.__drEncounterPlay` 呼叫
   `tick(1)` → 等素材 `assets.whenIdle()` → `draw()` → 擷取 canvas。
   一幀一次 CDP 往返，**順序完全確定**（不會有非同步的重畫插進來）。
4. 音訊事件（BGM 開始／停止／切換／音量、SFX 播放）在頁面裡帶**遊戲幀號**記下來，
   錄完一次取回。
5. 關掉 Edge 與伺服器 → 在 Node 端用 ffmpeg 依事件表把 `assets/` 的音檔混成 WAV
   （BGM 依 `loopStart`/`loopEnd` 循環，SFX 疊到對應時間）→ 與 PNG 序列合成 MP4。
6. 用 ffprobe 檢查暫存 MP4 的幀數／fps／尺寸／音軌。通過後才置換指定位置的檔案。

錄影結束會關掉自己啟動的 Edge（只關自己的 PID）與伺服器；Edge 的 profile 留在
`%TEMP%\V2-11\edge-profile-record`（刻意不刪，避免任何遞歸刪除）。

---

## 3. 輸出規格

### 3.1 MP4（`--out`）

| 項目 | 值 |
|---|---|
| 影像 | H.264（libx264）、`yuv420p`、`-preset medium`、`-crf 18`、`-r 30`、`+faststart` |
| 音訊 | AAC 192 kbps、44.1 kHz、立體聲 |
| 尺寸 | 640×480 × scale（1×／2×／3×，最近鄰放大，不模糊） |
| 幀數 | 等於遊戲實際跑的幀數（到結果畫面就停；`--max-frames` 上限內） |
| 長度 | `幀數 / 30` 秒；音軌長度與影像一致（驗證容差 0.5 秒） |

### 3.2 PNG 序列（`--png-dir`）

`f0000.png`、`f0001.png`…（從 0 起流水號，四位補零），尺寸同上面的「尺寸」。
同一個目錄會一起寫 `audio-events.json` —— 那是這一場的音訊事件表（見 §3.4），
給剪輯軟體或自己重混音用。

### 3.3 WAV（`--wav`）

44.1 kHz、16-bit PCM、立體聲；長度＝影片長度。內容是「把事件表重新混音」的結果
（不是瀏覽器收音），所以 BGM 循環點乾淨、音效位置與畫面同幀。

### 3.4 音訊事件表（`audio-events.json`）

```jsonc
{
  "format": "dr-record-audio-events/1",
  "kind": "encounter",
  "name": "rudinn",
  "fps": 30,
  "frames": 1017,
  "seconds": 33.9,
  "log": {
    "version": 1, "fps": 30, "frames": 1016, "dropped": 0,
    "events": [
      { "type": "bgm", "action": "play", "name": "battle", "file": "audio/mus/battle.ogg",
        "volume": 1, "loop": true, "loopStart": null, "loopEnd": null, "fade": 0.35,
        "previous": null, "frame": 0, "t": 0, "src": 2 },
      { "type": "sfx", "name": "snd_hurt1", "file": "audio/snd/snd_hurt1.wav",
        "volume": 1, "loop": false, "frame": 412, "t": 13.7333, "src": 2 }
    ]
  }
}
```

- `frame` 是**遊戲幀號**（第 N 幀＝`N/30` 秒），`t` 是換算好的秒數。
- `file` 是相對 `assets/` 的路徑（混音時靠它找檔案）。
- `src` 是同頁第幾個 `createAudio()` 實例（頁面自己一個、引擎內部可能還有）；
  混音時不分來源，一律照時間排 —— 但同檔同時間的重複會去重（頁面與引擎各播一次的情況）。
- 沒有 `loopEnd` 或 `loopEnd` 超過音檔長度 → 整首循環；有 `loopStart`/`loopEnd` →
  前奏播一次後在 `[loopStart, loopEnd)` 之間循環。

---

長片混音將 FFmpeg 濾鏡寫入暫存檔。重複的音效共用同一個輸入檔，仍各自保留觸發時間與音量。

## 4. `--capture`：兩種擷取方式

| 值 | 做法 | 速度（640×480） | 與 `tools/agent/render.mjs` 同幀 |
|---|---|---|---|
| `screenshot`（預設） | CDP `Page.captureScreenshot` 對 canvas 區域截圖 | ≈ 17–20 幀/秒 | **逐像素相同** |
| `canvas` | 頁面內 `canvas.toDataURL('image/png')` | ≈ 100–130 幀/秒 | 差在 HUD／banner 疊層（那是 HTML，不在 canvas 裡） |

`screenshot` 慢，但它走的是 `render.mjs` **完全相同的擷取路徑**，所以「同一幀號的畫面」
可以逐像素比對（驗收條件就是這樣驗的：抽 f0000／f0060／f0120… 比對，差異 0 像素）。
長片想快就換 `canvas`，代價是畫面不含 HUD 疊層。

---

## 5. 限制

- **固定 30 fps**：引擎是 1/30 秒步進，`--fps` 其他值會被拒絕（不是偷改，是明確報錯）。
- **只能錄「攻擊頁 / 遭遇頁」的作品**：`play.html`、`encounter-play.html` 以外的畫面
  （編輯器 UI、選單）沒有逐幀把手。
- **遭遇頁的換場景／換回合**：頁面在 rAF 凍結後不會自己重畫，錄影工具每幀明確呼叫
  `renderer.draw(state, …)`。這是靠頁面既有的公開把手做的，**不需要改頁面**。
- **`screenshot` 模式較慢**：1× 約 17–20 幀/秒、2× 約 17 幀/秒、3× 更慢；30 秒的
  遭遇戰大約 1 分鐘。長片請用 `--capture canvas`。
- **音訊是「重建」不是「收音」**：BGM 循環、淡化、音量都由事件表推算。
  Web Audio 的即時細節（例如極短的 fade 曲線、AudioContext 排程抖動）不會被重現；
  聽感與遊戲內一致，但不是 bit-exact。
- **沒有 Web Audio 的環境**（`window.AudioContext` 不存在）：頁面本身不會出聲，
  但事件記錄仍會寫（silent API 也能記），Node 端照樣混得出音軌。
- **要用到 `assets/audio/`**：音檔不在原始碼倉庫裡，便攜版內附。沒有可用音訊事件時使用靜音軌；
  混音或驗證失敗則保留原有輸出檔並報錯。也可指定 `--no-audio` 錄製純影像。
- **MCP `dr_record` 沒有 `capture` 參數**：固定用 `screenshot`（要與 `dr_render` 的畫面一致）。
- **不支援「只錄某幾幀」**：逐幀錄影的意義就是每一幀，跳幀請用 `render.mjs` 的
  `--frames 0,60,120`。
- 錄影中的 Edge profile 留在 `%TEMP%\V2-11\edge-profile-record`，不自動清（派工規則
  禁止遞歸刪除）。要清請自己把整個資料夾移到資源回收筒。

---

## 6. 疑難排解

| 症狀 | 原因與處理 |
|---|---|
| `找不到 ffmpeg`（exit 3） | 裝 ffmpeg 或設 `FFMPEG_PATH`／`FFPROBE_PATH`。**只要 PNG：改用 `--png-dir`**，不需要 ffmpeg |
| `找不到 Edge` | 裝 Edge 或設 `MSEDGE_PATH` |
| 影片前幾幀是洋紅佔位 | 素材還沒載完。工具每幀都等 `whenIdle()`，若仍出現代表某素材載入失敗 → 檢查瀏覽器 console 與 `assets/index.json` |
| 音軌是靜音 | `audio-events.json` 沒有事件（作品沒設 bgm／沒音效）或音檔不在磁碟；看 warnings |
| 幀數比預期少 | 到結果畫面就停（正常）；或 `--max-frames` 太小 |
| `--fps 60` 被拒 | 逐幀錄影固定 30 fps，見 §5 |
| 影片結尾少了幾幀 | 錄影在結果畫面那一幀就停（與 `render.mjs` 的 `framePrecisionWarning` 一致）；要更長請加 `--max-frames` |

---

## 7. 測試

```bash
node tests/record/run.mjs          # 77 項：事件表→混音時間、BGM 循環、參數解析、無 ffmpeg 錯誤訊息、引擎事件記錄
node tools/agent/test.mjs          # 含 dr_record 在 tools/list（16 個工具）
```

`node tools/record.mjs --help` 印出完整用法。

## 附註（REALTEST-2 後補）

- **不認得的旗標會警告**：`--xxx` 不在支援清單時，stderr 會印 `警告：不認得的旗標 --xxx（…）`，錄影照常進行。
- **`tools/record/.tmp/`**：作品檔不在程式根內（`--works` 模式）或用了 `--seed` 時，會把作品 JSON 複製一份到這裡讓頁面載入；
  這是暫存檔，**錄影結束後自動刪除**，目錄本身已 gitignore，不會污染專案。
