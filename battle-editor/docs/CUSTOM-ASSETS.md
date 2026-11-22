# 自訂素材（Custom Assets）

給「想自己畫子彈／敵人／背景貼圖，或加上自己的 BGM／音效」的人。官方解包素材（`assets/sprites/…`、`assets/audio/…`）不要動；自訂素材放 `assets/custom/`，用兩支腳本併進 `assets/index.json`，之後重跑建置也不會弄丟（含自訂音樂的 loop 點），刪掉檔案重跑也會清掉。

## 1. 畫圖與放置

1. 畫一張 PNG（透明背景）。子彈建議 8–40 px，圖邊留 1–2 px 透明，縮放時比較不會鋸齒。
2. 放到 `assets/custom/`：
   - **單張**：`assets/custom/ember.png` → sprite 名稱 `ember`（單幀）。
   - **動畫**：`assets/custom/ember/0.png`、`1.png`、`2.png`… → sprite 名稱 `ember`，依檔名自然序播放（`2.png` 排在 `10.png` 前）；**每幀必須同尺寸**。
3. sprite 名稱就是之後在 JSON 裡引用的名字。建議只用小寫英數、`_`、`-`，不要用空白或斜線。

> 索引裡的幀路徑是「相對 `assets/`」的 posix 路徑，所以 PNG 一定得放在 `assets/` 底下（正常情況就是 `assets/custom/`）。

## 2. 原點（origin）

- **預設**：圖片中心（`ox = w//2`、`oy = h//2`）。一般子彈用預設就好。
- 引擎 `engine/render.js` 的 `drawSprite()` 在索索引原點是 `(0, 0)`（未驗證）時，會自動改用圖片中心 `(w/2, h/2)`；畫的時候也可以用 `originMode: 'topLeft' | 'center'` 覆寫。
- 想讓原點偏移（例如光束的根部、拖尾的起點不在圖片中心）→ 在 `assets/custom/sprites.json` 指定。這個檔可省略；省略＝全部用圖片中心：

```json
{
  "format": "dr-battle-assets/1",
  "sprites": {
    "ember_trail": { "files": ["ember_glow.png"], "ox": 12, "oy": 12, "desc": "拖尾光暈" },
    "ember_anim": { "frames": ["ember/0.png", "ember/1.png"], "ox": 10, "oy": 10, "tags": ["bullet"] }
  }
}
```

- `frames`（別名 `files`）：覆寫該 sprite 的幀清單與順序；沒列在 `sprites.json` 的 PNG 仍會自動編入。
- `ox` / `oy`：整數（可負）。
- `tags`：預設 `["bullet"]`；已知 tag 是 `soul` / `bullet` / `battlebg` / `enemy` / `ui` / `party`（給素材搜尋與編輯器分類用）。**其他 tag 可以自由填**——只會在建置時提醒，仍照樣寫入索引、可用於素材搜尋。
- `desc`、`frameMs`、`originVerified`、`chapter` 會原樣帶進索引（`chapter` 預設 `"custom"`）；動畫播放速度是在攻擊檔的 `frameRate` 決定，不是這裡。

## 3. 音樂與音效

1. 把音檔放進 `assets/custom/`（只收 `.ogg` / `.mp3` / `.wav`，副檔名大小寫不拘）：
   - **BGM**：`assets/custom/music/my_bgm.ogg` → 音訊索引名稱 `my_bgm`，`kind: "music"`。
   - **音效**：`assets/custom/sfx/my_hit.wav` → 音訊索引名稱 `my_hit`，`kind: "sfx"`。
2. 名稱 = 檔名去掉副檔名。`music/` 與 `sfx/` 底下（含子資料夾）不能有同名檔案，重名會直接報錯，請改名。
3. 沒寫任何 metadata 時的預設：
   - music：`loop: true`（整首循環）、`tags: ["music"]`、`volume: 1`。
   - sfx：`loop: false`（播一次）、`tags: ["sfx"]`、`volume: 1`。
4. 要指定循環點、音量、標籤、說明 → 在 `assets/custom/audio.json`（可省略；省略＝全部用預設）：

```json
{
  "format": "dr-battle-assets/1",
  "audio": {
    "my_bgm": {
      "loopStart": 12.054,
      "loopEnd": 144.054,
      "volume": 0.8,
      "tags": ["battle", "custom"],
      "desc": "前奏播一次，之後 12.054–144.054 秒循環"
    },
    "my_hit": { "volume": 0.7, "tags": ["impact"] }
  }
}
```

- `loopStart` / `loopEnd`：**秒**。前奏播一次後，在 `[loopStart, loopEnd)` 之間循環。省略＝整首循環；只寫 `loopEnd` 時 `loopStart` 視為 0。
- `loop`：布林；music 預設 `true`、sfx 預設 `false`。sfx 寫 loop 點只會被提醒（單次音效不看 loop 點）。
- `volume`：`0`–`1`（超過 1 引擎會 clamp 回 1）；省略＝1。
- `tags`：可自由填。已知詞是 `music` / `sfx` / `audio` / `battle` / `boss` / `tense` / `defeat` / `alt` / `voice` / `ui` / `ambient` / `custom`；未知 tag 只會提醒，仍寫入索引。
- `desc`：字串，原樣帶進索引（搜尋結果會顯示）。
- `kind`：可寫 `"music"` / `"sfx"` 覆寫資料夾判定。
- `file`：進階用法——用另一個索引名稱引用既有音檔，路徑相對於 `assets/custom/`（例 `"music/my_bgm.ogg"`）。自動掃到的同名檔案不可以再指定 `file`（要改名請用新的索引名稱）。
- 也接受扁平寫法（`audio.json` 最外層直接是 `{ "名稱": { … } }`，不需要 `format` / `audio`）。

### loop 點怎麼量

1. 用 Audacity 之類的編輯器打開音檔，找出「尾端接回開頭會無縫」的區間。
2. 記下區間的**開始秒數**與**結束秒數**（例：12.054 / 144.054）。
3. 寫進 `audio.json` 的 `loopStart` / `loopEnd`。`loopEnd` 必須大於 `loopStart`、且**不可超過音檔總長度**；超過的話 `engine/audio.js` 的 `playBgm()` 會忽略 loop 點、退回整首循環。想整首循環就不要寫這兩個欄位。
4. 存檔後重跑下面的兩支腳本（見 §4），再在瀏覽器聽一次確認接點。

> 引擎讀的是索引條目上的 `loop`、`loopStart`、`loopEnd`（`engine/audio.js` 的 `audioMeta()`／`playBgm()`，單位秒）；音效播放（`play()`）只讀 `volume`，不看 loop 點。

索引裡的音訊條目長這樣（由腳本產生，僅供理解）：

```json
"my_bgm": {
  "file": "custom/music/my_bgm.ogg",
  "kind": "music", "loop": true,
  "loopStart": 12.054, "loopEnd": 144.054, "volume": 0.8,
  "tags": ["battle", "custom"], "desc": "前奏播一次，之後循環",
  "bytes": 1234567, "custom": true
}
```

自訂音訊進 `assets/index.json` 之後，遭遇編輯器的音效／BGM 下拉（資料來自音訊索引）與攻擊的 `settings.bgm` 就能直接引用。

## 4. 建置（兩個指令）

在 `battle-editor/` 目錄下：

```bash
# 1) 掃描 assets/custom/（PNG + 音訊），產出 assets/custom.index.json
python tools/build_custom_assets.py

# 2) 重建 assets/index.json（會自動併入 custom 的 sprite 與 audio）
python tools/build_assets.py
```

- `build_custom_assets.py` 可以重複跑：改了 PNG 或音檔就再跑一次；`--dry-run` 只印統計不寫檔（sprite／幀數／原點來源、music／sfx 數量、loop 點數、音訊 bytes）。找不到音檔、重名、loop 點不合法等會直接報錯（exit 1）。
- `build_assets.py` 重建 `index.json` 時會依序併入官方 `audio-fonts.index.json`（audio／fonts）與 `assets/custom.index.json`（sprite + audio）；**自訂音樂的 `loopStart` / `loopEnd` / `volume` / `tags` 會原樣保留**，重跑不會弄丟 BGM 或 loop 點；自訂條目以 `custom: true` 標記，刪掉素材重跑會清掉孤兒。
- 官方素材來源（預設 `../assets-official/01-official`）與 `assets/sprites-full.index.json`、`assets/audio-fonts.index.json`：即使 `--out` 指到別的目錄，這兩個輔助索引也會**回退從預設 `assets/` 讀取**；兩邊都缺時會中止並說明（不會靜默漏掉 sprites-full 的幾千筆），要硬跑可加 `--allow-missing-sprites-full`。想先看統計：`python tools/build_assets.py --dry-run`。
- 驗證：`node tools/agent/test.mjs`、`node tests/engine/run.mjs`；遭遇相關可跑 `node tools/check-encounters.mjs --no-engine`（看素材索引的 sprites／audio 數量有沒有增加）。自訂素材腳本自己的測試：`python tools/test_custom_assets.py`（只在 `%TEMP%` 暫存目錄產生測試素材，不會寫入 `assets/`）。

空目錄、沒有 PNG 也沒有音訊會直接報錯（exit 2）並提示先建立 `assets/custom/`；`assets/custom.index.json` 是產生物，**不要手改**。

## 5. 在攻擊／遭遇裡引用

### 攻擊（attack.json）

- BGM：`settings.bgm` 填音訊索引名稱（純文字欄位），例如 `"bgm": "my_bgm"`；`null` 或省略＝不播 BGM。
- 音效：在 `timeline` 加 `sfx` 事件，`sound` 填音訊索引名稱：

```json
{
  "id": "ev_hit",
  "at": 0.8,
  "type": "sfx",
  "label": "命中音",
  "sound": "my_hit"
}
```

- 子彈／敵人／背景照 §1–§2 的自訂 sprite 名稱填 `bulletTypes.<名稱>.sprite`、`enemies[].sprite`、`settings.background` 等。

### 遭遇（encounter.json）

- `settings.bgm` 填音訊索引名稱，例如 `"bgm": "my_bgm"`。
- 或用 cue 在流程中切歌／播音效（`at` 是 cue 時間；`track: null` 會停 BGM，`fade` 單位秒）：

```json
{ "at": 0.0, "cmd": "bgm", "track": "my_bgm", "fade": 0.5 },
{ "at": 1.2, "cmd": "sfx", "sound": "my_hit" }
```

- 名稱要與 `assets/index.json` 的 `audio` 索引一致，打錯就是找不到音訊（無聲）。編輯器下拉會列出索引裡所有音訊（含自訂）。

## 6. 怎麼移除

1. 刪掉 PNG／音檔（或整個 `assets/custom/<名稱>/` 資料夾）；想保留檔案請移到 `assets/` **以外**（掃描是遞迴的，放在 `assets/custom/` 底下任何位置都會被編進去）。
2. 若 `assets/custom/sprites.json`／`assets/custom/audio.json` 有對應條目，一併刪掉。
3. 重跑上面兩個指令。`custom.index.json` 會少掉該條目，`merge_custom_index()` 是「重建」而非「累加」，不會留下孤兒條目（sprite 與音訊都一樣）。
4. 先把還引用它的攻擊／遭遇改掉（或刪掉），否則會找不到素材。
5. 檢查：`python tools/build_custom_assets.py --dry-run`、`python tools/build_assets.py --dry-run`、`node tools/agent/test.mjs`、`python tools/test_custom_assets.py`。

> 官方素材另有 `assets/index.json` 這個產生物；自訂素材的真相來源永遠是 `assets/custom/` 底下的 PNG／音檔與 `sprites.json`／`audio.json`，重建時以它們為準。
