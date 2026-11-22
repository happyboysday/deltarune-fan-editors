# ROADMAP v2：創作效率、作品版控、可遊玩輸出、錄影輸出

> 2026-11-09 建立。來源：Doppeldoll 會話的實作回饋（下稱 DD#n）＋ RT 實操報告（`REALTEST-2026-11-08.md`）＋使用者新需求（可遊玩程序輸出、錄製畫面輸出）。
> **協調者（Claude）每次上下文壓縮後必須重讀本檔**，再看 §5 狀態表決定下一步。

---

## 0. 目標

1. 做新敵人更快：自訂音樂走官方流程、BPM 拍點、演示路徑自動產生、運算式更強、遭遇可觀測。
2. 作品可版控、可在任何目錄（worktree）工作。
3. **輸出可遊玩程序**：一個遭遇（或攻擊）→ 單一 HTML（離線雙擊可玩，也能丟 itch.io）。
4. **錄製畫面並輸出**：頁內即時錄影（WebM，含音訊）＋ 離線逐幀精確輸出（MP4，給二創剪輯用）。

## 1. 已定決策

| 主題 | 決策 |
|---|---|
| 作品目錄 | 保留 `attacks/`、`encounters/` 為預設草稿區（gitignore）。新增「作品根」`--works <dir>`（serve.py、所有 CLI、MCP 都支援，環境變數 `DR_WORKS`），其下 `attacks/ encounters/ assets/custom/`。作品根可放在 repo 內被追蹤的目錄（例：`works/doppeldoll/`）。另有 **作品包** `*.drpack.json`（遭遇＋引用的攻擊＋自訂素材 base64）可匯出／匯入。 |
| 程式根 | CLI/MCP 另支援 `--root <battle-editor 目錄>`，預設為工具自身所在處；worktree 內執行時自動用該 worktree。 |
| 拍點單位 | 攻擊 `settings.bpm`（可選）、`settings.beatOffset`（秒）。所有時間欄位（`at`、`duration`、`interval`、`life`、demo `t`）接受數字（秒）或字串 `"2b"`、`"1.5b"`（拍）。載入時正規化，存檔保留原寫法。 |
| 子彈運算式 | 新增唯讀：`spawnX`、`spawnY`、`spawnT`、`i`（本次發射序號）、`k`（emitter 第幾輪）、`n`（本輪數量）、`mem.<name>`（生成時以 `memory:{name:expr}` 求值後固定的每顆變數）。 |
| 演示路徑 | 自動產生 = 以引擎實跑驗證的搜尋（參考 worktree `tools/content/doppeldoll/make_demo_paths.mjs`）；編輯器顯示「預定路線」與「跟隨器實際軌跡」兩條線。 |
| 可遊玩輸出 | `tools/export-game.mjs`：引擎 ES modules 以 import map + data: URL 內嵌，素材只打包用到的（data URL）→ **單一 HTML**，`file://` 雙擊可玩。選項：`--lang zh|en`、`--title`、`--no-autoplay-toggle`。之後再評估 exe 包裝（Phase 3，待使用者決定）。 |
| 錄影 | 頁內：`MediaRecorder(canvas.captureStream(30) + 音訊 MediaStreamDestination)` → WebM。離線：`tools/record.mjs` 用 headless Edge 固定步進逐幀擷取＋引擎音訊事件記錄 → ffmpeg 合成 MP4（本機已有 ffmpeg；找不到時明確報錯）。輸出可選 1×/2×/3× 最近鄰放大。 |
| 文件 | 工人只改自己範圍內的文件；`AGENT-GUIDE.md` 與 `COORDINATION.md` 由協調者整合。 |
| 換行 | `.gitattributes`：全部 LF（`.cmd/.bat` CRLF）。已完成 76b1a1b。 |

## 2. 工作項（ID → 內容 → 檔案所有權）

### Phase 1（並行，檔案不重疊）

| ID | 內容 | 來源 | 檔案所有權 |
|---|---|---|---|
| V2-01 | 自訂音訊進素材流程：掃 `assets/custom/music/`、`sfx/`（ogg/mp3/wav），`sprites.json` 旁 `audio.json` 指定 `loopStart/loopEnd/volume`；`build_assets.py` 合併後不再遺失。tag 改為自由（未知 tag 只提醒）。文件。 | DD1, DD13 | `tools/build_custom_assets.py`、`tools/build_assets.py`、`docs/CUSTOM-ASSETS.md` |
| V2-02 | 自動駕駛：未就緒時 `input()` 記警告＋`describe().ready=false`；SPEC §3 範例補 `await pilot.ready`。路徑跟隨器精度（縮小死區、預判減速、框旋轉/瞬移補償）；新增 `engine/autoplay/pathgen.js`（以實跑驗證的搜尋產生無傷路徑）與 `traceDemo()`（回傳跟隨器實際軌跡）；CLI `tools/agent/demo-path.mjs`。 | DD4, DD5 | `engine/autoplay/**`、`tests/autoplay/**`、`tools/agent/demo-path.mjs`（新）、`docs/SPEC-AUTOPLAY.md` |
| V2-03 | 引擎：拍點單位（`"2b"`、`settings.bpm/beatOffset`）；子彈運算式新變數（`spawnX/spawnY/spawnT/i/k/n/mem.*`）。schema、驗證、測試。 | DD6(引擎), DD7 | `engine/expr.js`、`engine/attack.js`、`engine/sim.js`、`engine/rng.js`、`tests/engine/**`、`docs/SPEC-EXPR-V2.md`（新） |
| V2-04 | Agent 工具：`--root`/`--works`/`DR_WORKS`（sim/difficulty/render/mcp/export-schema/check-encounters 共用 lib）；遭遇模擬輸出事件（指令、ACT、mercy、TP、台詞、回合起訖）；**整場難度報告**（多種子跑整個遭遇，逐回合受傷分佈）；`render.mjs` 幀號精確（輸出 要求幀/實際幀）＋等待「素材全部載入」訊號（`engine/assets.js` 新增 `whenIdle()`/`pending` 計數）。 | DD3, DD8, DD11, DD14, 想要#1 | `tools/agent/**`（除 demo-path.mjs）、`tools/check-encounters.mjs`、`engine/assets.js`、`engine/encounter/**`（只加事件發射，不改行為） |
| V2-05 | 作品根與作品包：`serve.py --works <dir>`（含 SSE/歷史/垃圾桶都跟著走）、`GET /api/info` 回報作品根；`tools/pack.mjs`（匯出/匯入 `.drpack.json`）＋`POST /api/pack/export`、`/api/pack/import`；repo 新增 `works/README.md` 說明如何建立受版控作品根；`launch.cmd` 支援參數。 | DD2 | `serve.py`、`launch.cmd`、`tools/pack.mjs`（新）、`works/README.md`（新）、`.gitignore` |

### Phase 2（Phase 1 合併後）

| ID | 內容 | 來源 | 檔案所有權 |
|---|---|---|---|
| V2-06 | 攻擊編輯器：BPM 設定、拍線顯示與吸附（Shift 切換）、時間欄位可輸入 `2b`；演示面板「自動產生路徑」按鈕（呼叫 pathgen，進度＋可取消）＋實際軌跡疊圖；作品包匯出/匯入按鈕。 | DD6(UI), DD4(UI), DD2(UI) | `editor/*.js|css`、`editor/locales/*`（非 encounter-*）、`index.html` |
| V2-07 | 遭遇：演員「動畫組／形態」（`actor.forms`，一個變數切整組 idle/hurt/talk/act…，cue `form`）引擎＋actor-editor UI；**遭遇時間軸總覽**面板（每回合台詞長度、彈幕長度、BGM 段落／拍點對照）；作品包按鈕。 | DD10, 想要#2 | `engine/encounter/actors.js`、`engine/encounter/schema.js`、`editor/encounter/**`、`editor/locales/encounter-*`、`encounter.html` |
| V2-08 | 引擎 `snapshot()/restore()`（攻擊與遭遇；含 RNG、子彈、事件游標、cue 執行狀態），決定性測試（snapshot→restore→續跑 == 直跑）；pathgen 與難度報告改用 snapshot 加速。 | DD9 | `engine/sim.js`、`engine/encounter/world.js`、`engine/encounter/index.js`、`engine/rng.js`、`tests/snapshot/**`（新） |
| V2-09 | **可遊玩輸出**：`tools/export-game.mjs`（單一 HTML，內嵌引擎＋用到的素材＋遭遇/攻擊；標題畫面＋按 Z 開始＋結束後重來）；`POST /api/export/game` 下載；`tools/web/export-button.js`（給頁面掛的獨立模組）。 | 新需求 | `tools/export-game.mjs`（新）、`tools/web/**`（新）、`serve.py` 只加一個端點（與 V2-05 錯開執行） |
| V2-10 | **頁內錄影**：`tools/web/recorder.js`（canvas＋音訊 → WebM，開始/停止/下載，顯示時間與檔案大小）；掛到 `play.html`、`encounter-play.html`（⏺ 按鈕與 `V` 鍵；`?record=1&autoplay=demo` 自動錄完一場）；頁面被節流時顯示提示（DD12）。 | 新需求, DD12 | `tools/web/recorder.js`（新）、`play.html`、`encounter-play.html`、`engine/audio.js`（只加錄音輸出節點） |

### Phase 3

| ID | 內容 | 檔案所有權 |
|---|---|---|
| V2-11 | **離線逐幀錄影**：`tools/record.mjs <作品> --autoplay demo --scale 2 --out x.mp4`：headless 固定步進逐幀擷取、引擎音訊事件記錄（bgm/sfx 帶幀號）→ ffmpeg 混音合成；可輸出 PNG 序列＋WAV 給剪輯軟體；MCP `dr_record`。 | `tools/record.mjs`（新）、`tools/agent/mcp-server.mjs`（只加工具）、`engine/audio.js`（事件記錄） |
| V2-12 | 第二次實操測試：DeepSeek 用 BPM、自動路徑、forms、作品根、輸出可遊玩 HTML 與 MP4，寫報告（同 RT 規則：暫存→回收筒，不遞歸刪除）。 | 只寫 `docs/REALTEST-2.md` |
| V2-13 | （待使用者決定）可遊玩輸出包成 exe（例如 WebView2 小殼）。 | — |

## 3. 派工規則（每個工人都要寫進指令）

- 從 RT3-FIX 起由 GPT 接手開發。前兩輪的 DeepSeek 會話保留為歷史紀錄。
- 不 commit、不建子代理（除非明說）、**每則回覆只發一個工具呼叫**、暫存檔放 `%TEMP%\<任務ID>\`、LF + UTF-8。
- 伺服器 18900 由協調者管理，不啟停；若需要另一個伺服器測 `--works`，用別的埠並在結束時關閉。
- Edge 一律 headless + `--mute-audio`；自己啟動的程序全部關閉；不碰使用者已開的 Edge。
- **禁止遞歸刪除**（`rm -r`、`Remove-Item -Recurse`、`rmdir /s`、`shutil.rmtree`…）；要清就 Move-Item 到 %TEMP% 或送回收筒。
- 不碰 `Persistent Motif Crescendo Cover.mp3`、`DeltaruneBossFightSpeedRun.mp4`、`動畫素材/`（使用者另有用途）。
- 只改自己「檔案所有權」欄位內的檔；需要別人的檔改動時，寫在回報裡由協調者處理。
- 回報：改了哪些檔、測試數字、截圖/輸出路徑、未完成或已知限制。

## 4. 協調者檢查清單（每個任務）

1. 讀回報 → 跑該區測試＋全套（engine 217+、encounter 270+、flow 17、autoplay 33/50+、agent 47+、editor `node --test editor/*.test.mjs editor/encounter/*.test.mjs`）。
2. 看截圖／實際輸出；必要時自己在瀏覽器窗格驗。
3. 查殘留程序、`attacks/`/`encounters/` 是否乾淨。
4. 單獨 commit（只 add 該任務的檔），COORDINATION.md 記一行，更新本檔 §5。

## 5. 狀態

| ID | 狀態 | 會話 / commit | 備註 |
|---|---|---|---|
| V2-01 | ✅ 完成 | 2aa6c59 | serve.py 音訊 tag 搜尋轉交 V2-05；編輯器 bgm 欄位是純文字（V2-06 可改下拉） |
| V2-02 | ✅ 完成 | (見 COORDINATION) | follow.js 跟隨器（平均偏差 2.52→0.94px）、trace.js、pathgen.js（4 samples 1–12 s 無傷）、demo-path.mjs CLI、ready 警告 |
| V2-03 | ✅ 完成 | (見 COORDINATION) | 拍點 `"2b"`＋`settings.bpm/beatOffset`；`spawnX/Y/T`、`bpm`、`beat`、`mem.*`（`memory:{}`）；`i/k/n` 原本就有。排程欄位不吃運算式。待辦轉交 V2-04：export-schema VAR_DESC＋settings.bpm/beatOffset、check-samples 放行拍點與 memory；協調者：AGENT-GUIDE 補一段 |
| V2-04 | ✅ 完成 | (見 COORDINATION) | --root/--works、遭遇事件流、整場難度報告、render 幀精確＋whenIdle；追加：schema/check-samples 同步 SPEC-EXPR-V2（agent 74 綠） |
| V2-05 | ✅ 完成 | (見 COORDINATION) | serve.py `--works`、`/api/info`、索引記憶體合併、pack.mjs（serve.py 以子程序呼叫）、音訊自由 tag 搜尋；works_root 32 + test_serve 56 綠 |
| V2-06 | ✅ 完成 | (見 COORDINATION) | BPM 拍線＋拖曳吸附（Shift 切換）、時間欄位吃 `2b`、BGM 可搜尋下拉、自動產生路徑（Worker，可取消、可 Undo）＋實際軌跡疊圖、作品包匯出/匯入、可遊玩 HTML 按鈕。待辦：autoplay/index.js re-export pathgen/trace、pathgen 讀 duration 用 timeLengthSeconds、export-button 加 setLang |
| V2-07 | ✅ 完成 | (見 COORDINATION) | actor.forms＋`form` cue＋actor-editor 形態區；遭遇時間軸總覽（含拍線）；Pack／可遊玩輸出工具列；forms-demo 範例。待辦：export-schema actor 補 forms/form（tools 擁有者） |
| V2-08 | ✅ 完成 | (見 COORDINATION) | sim/encounter snapshot()/restore()（可 JSON；含 RNG、子彈 mem/grazed、cue 鏈、flow、打字進度、form）；tests/snapshot 50 項；pathgen 用原點快照＋輕量 state（−7.5%）；difficulty 無前綴重跑故未改 |
| V2-09 | ✅ 完成 | (見 COORDINATION) | export-game.mjs 單一 HTML（攻擊 1–4 MB、範例遭遇約 5–8 MB，自訂 BGM 與動畫可更大；zh 字型較大，DTM.otf 不內嵌）；`/api/export/game`；`tools/web/export-button.js` 尚未掛頁面（V2-06/V2-07 掛） |
| V2-10 | ✅ 完成 | (見 COORDINATION) | tools/web/recorder.js + recorder-ui.js；audio.js `getRecordStream()`；V 鍵／⏺、1-3×、?record=1、?chrome=0、節流提示；41 單元測試＋6 headless 場景 ffprobe 驗證 |
| V2-11 | ✅ 完成 | (見 COORDINATION) | tools/record.mjs（headless 逐幀、screenshot 17–20 幀/秒或 canvas ~120 幀/秒；事件表重建混音 → MP4/PNG+WAV）、audio.js 事件記錄、MCP dr_record；協調者：預設 ?chrome=0 乾淨畫面（--hud 保留）、遭遇 max-frames 預設修正 |
| V2-12 | ✅ 完成 | (見 COORDINATION) | REALTEST-2.md：7 項需求全通；問題 V1–V16（高：encounter-play 靜默 fallback、時間軸總覽漏 cue 攻擊、dr_difficulty 誤報）；建議 17 條待使用者選 |
| V2-13 | 待使用者決定 | | |
| FX-GRAZE | ✅ 完成 | (見 COORDINATION) | 擦彈＝子彈 vs 官方 spr_grazemask 心形（25×25，原 50×50 半尺寸，同 ch4 _small）；命中不變；黃色心形外框亮暗脈動（對照影片 t≈1074s）；bot.js 已同步（協調者）。擦彈數較圓形少（spade-rain 46→28） |
| FX-ANIM | ✅ 完成 | (見 COORDINATION) | 使用者回報：演員動作動畫重複循環 → 非循環用素材實際幀數、無 then 停最後一幀；samples defend/victory 修正 |
| V2-FIX1 | ✅ 完成 | (見 COORDINATION) | V2-06/07 待辦：autoplay re-export、pathgen 拍點 duration、export-button setLang、export-schema actor forms；匯出 HTML 因 re-export 多 3 模組（約 52 KB） |
| RT2-FIX | ✅ 完成 | 53c9f62、0a3dc2c、61e5b81 | REALTEST-2 的 V1–V16 與建議 1–17 全部處理：遭遇頁載入錯誤不再靜默、時間軸總覽認得 attack cue 攻擊並回報結果、dr_difficulty 分開零傷率與通關率（遭遇的 passable 改看通關率）、作品包匯入保留原文、未知旗標警告、匯出內建素材白名單、Demo 區塊收合＋產生路徑捷徑等；細節見 COORDINATION |
| RT3-FIX | ✅ 完成 | 見 COORDINATION | 第三輪 8 項：形態檢查、演示路徑與回合、難度種子、攻擊前指令、裝飾彈幕、長片混音與匯出統計；角色動作播一次。 |
