# 作品根（works/）

這個目錄放**受版控的作品根**。每個子目錄就是一個作品（一個 boss、一關、一段劇情…），
把「要保留、要分享、要進 git」的資料集中在一起；開發時的草稿仍然放在
`battle-editor/attacks/`、`battle-editor/encounters/`（那兩區已被 `.gitignore` 忽略，不會進版控）。

- 作品根規格與決策：`docs/ROADMAP-V2.md` §1「作品目錄」
- 伺服器：`serve.py`、作品包工具：`tools/pack.mjs`

---

## 1. 建立一個受版控的作品根

```
battle-editor/
  works/
    my-boss/                 ← 作品根（commit 進 git）
      attacks/               ← 這個作品用到的攻擊檔 *.json
      encounters/            ← 這個作品的遭遇檔 *.json
      assets/
        custom/              ← 自訂素材原檔（PNG / ogg / mp3 / wav），commit
        custom.index.json    ← 自訂素材索引，commit
      history/               ← 審計紀錄（自動產生，不要 commit）
      trash/                 ← 刪除回收筒（自動產生，不要 commit）
```

最快的方式是讓伺服器自己建目錄：

```
cd battle-editor
python serve.py --works works\my-boss --port 18901
```

第一次啟動（或呼叫任何寫入 API）時會自動建立
`works/my-boss/attacks/`、`encounters/`、`assets/custom/`、`history/`、`trash/`。
接著用編輯器（`http://127.0.0.1:18901/index.html`、`encounter.html`）或 API 寫入的作品檔，
就會全部落在作品根底下，不會和預設草稿區或其他作品混在一起。

從工具列匯出作品包或可遊玩 HTML 前，先儲存目前的文件；匯出用的是作品根的檔案。
兩個編輯頁可共用同一個作品根。彈幕儲存後，遭遇預覽會重新載入引用，已算過的時間軸會提示重新模擬。
如果某個 ACT 已用指令安排開場動作，在 ACT 面板關閉「自動播放預設 ACT 動作」。

也可以手動 `mkdir`：

```
cd battle-editor
mkdir works\my-boss\attacks works\my-boss\encounters works\my-boss\assets\custom
```

> 路徑規則：`--works` 的相對路徑以**啟動 serve.py 時的工作目錄**解析（`launch.cmd` 會先
> `cd /d "%~dp0"`，所以從雙擊或 `launch.cmd` 啟動時是相對 `battle-editor/`）。

## 2. 用作品根啟動

三種寫法，效果相同（`--works` 優先於環境變數）：

```
launch.cmd --works works\my-boss
launch.cmd --port 18901 --works works\my-boss
set DR_WORKS=works\my-boss
launch.cmd
```

`launch.cmd` 會把參數**原樣轉傳**給 `serve.py`，並自動補 `--open`：

```
launch.cmd --works works\my-boss --port 18901 --quiet
```

等價於：

```
python serve.py --open --works works\my-boss --port 18901 --quiet
```

`works\my-boss` 是相對於 `battle-editor/`（因為 `launch.cmd` 會先切到腳本所在目錄）。
直接跑 `python serve.py` 時，相對路徑則相對於你當時所在的目錄。

啟動訊息會顯示實際的作品根與資料目錄，也可以用 `GET /api/info` 確認：

```
curl http://127.0.0.1:18901/api/info
# {"ok":true,"root":"...\\battle-editor","works":"...\\battle-editor\\works\\my-boss",
#  "port":18901,"version":"1.2","dataRoot":"...\\works\\my-boss", ...}
```

`works` 為 `null` 代表沒有用作品根（＝預設草稿區，行為與舊版完全相同）。

## 3. 哪些檔案要 commit

要 commit（作品本身）：

| 路徑 | 說明 |
| --- | --- |
| `works/<作品>/attacks/*.json` | 攻擊檔（`dr-battle-attack/1`） |
| `works/<作品>/encounters/*.json` | 遭遇檔（`dr-battle-encounter/1`） |
| `works/<作品>/assets/custom/**` | 自訂素材**原檔**（PNG 動畫資料夾、音訊檔） |
| `works/<作品>/assets/custom.index.json` | 自訂素材索引（`build_custom_assets.py` 產生） |
| `works/<作品>/*.drpack.json`（可選） | 要分享給別人的作品包 |

不要 commit（`works/.gitignore` 已忽略）：

| 路徑 | 原因 |
| --- | --- |
| `works/<作品>/history/` | 審計紀錄與版本 blob，機器產生、每台機器不同 |
| `works/<作品>/trash/` | 刪除回收筒，機器產生 |

作品包（`.drpack.json`）是可選的：它把「遭遇＋引用的攻擊＋用到的自訂素材（base64）」打包成一個
檔案，方便丟給別人或備份；要不要放進作品根、要不要 commit，看你的分享習慣。

## 4. 自訂素材

作品根有自己的 `assets/custom/` 與 `assets/custom.index.json`，和 `battle-editor/assets/custom/`
互不干擾：

- `/assets/custom/...` 靜態請求會優先從作品根的 `assets/custom/` 提供。
- `GET /assets/index.json` 會把主索引（`battle-editor/assets/index.json`，官方素材）與作品根的
  `custom.index.json` **在回應時動態合併**，不會寫回主索引；換一個作品根，看到的自訂素材就跟著換。
- 產生索引（掃 PNG、算原點）：

  ```
  python tools/build_custom_assets.py --root works\my-boss\assets
  ```

  沒有作品根時就是舊用法：`python tools/build_custom_assets.py`（掃 `battle-editor/assets/custom/`）。

## 5. 作品包（.drpack.json）

```
# 匯出（遭遇＋它引用的所有攻擊＋用到的自訂素材）
python tools/pack.mjs export my-boss --works works\my-boss --out my-boss.drpack.json

# 只看內容摘要
python tools/pack.mjs inspect my-boss.drpack.json

# 匯入到另一個作品根（預設遇衝突就中止並列出）
python tools/pack.mjs import my-boss.drpack.json --works works\other-boss

# 衝突時改名（attack 引用自動跟著改）或直接覆蓋
python tools/pack.mjs import my-boss.drpack.json --works works\other-boss --rename-on-conflict
python tools/pack.mjs import my-boss.drpack.json --works works\other-boss --overwrite
```

也可以用伺服器 API（編輯器／Agent 不需要碰檔案系統）：

```
POST /api/pack/export        body {"kind":"encounter","name":"my-boss"}  → 下載 .drpack.json
POST /api/pack/import?mode=abort|rename|overwrite   body = .drpack.json 內容
```

作品包格式 `dr-battle-pack/1`、以及「為什麼只有 Node 一份實作」見
`tools/pack.mjs` 檔頭註解。

匯入後若有自訂素材，重跑一次索引產生器（本工具已先寫好一份可用索引，重跑只是重新掃描）：

```
python tools/build_custom_assets.py --root works\other-boss\assets
```

## 6. 建議的 .gitignore 狀態

`works/.gitignore`（已被版控）內容只有：

```gitignore
# 作品根裡機器產生的資料，不要 commit
*/history/
*/trash/
```

所以 `works/<作品>/attacks/`、`encounters/`、`assets/custom/` 預設都會被追蹤。
如果你有「只想本機試玩、不想進版控」的作品，可以在 `works/.gitignore` 加一行
`private-*/`，把該作品資料夾命名成 `private-xxx`。

## 7. 常見問題

**Q：不放 `--works` 會怎樣？**
A：完全等同舊版：`attacks/`、`encounters/`、`history/`、`trash/` 都在 `battle-editor/` 底下，
`assets/index.json` 直接送出主索引（不合併任何東西）。既有工具與測試不受影響。

**Q：兩個作品可以同時開嗎？**
A：可以，各用一個 `--port`（例如 18901、18902）。作品根彼此隔離，SSE、樂觀鎖、審計、
垃圾桶都跟著各自的伺服器。

**Q：作品根的 `assets/index.json` 會被讀嗎？**
A：不會。作品根只需要 `assets/custom/` 與 `assets/custom.index.json`；
官方素材索引一律用 `battle-editor/assets/index.json`，避免每個作品複製 1.2 MB 的索引。

**Q：`history/` 裡有別台機器的紀錄會怎樣？**
A：不會同步，也不需要同步；`history/` 只是本機審計與還原來源，所以不進版控。
