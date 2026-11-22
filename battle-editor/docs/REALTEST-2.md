# V2-12 第二次實操測試：BPM 拍點 × 自動路徑 × 形態 × 可遊玩輸出

- 日期：2026-11-09
- 角色：V2-12（實操測試員，以「二創 DELTARUNE 風格 Boss 戰」創作者身分操作，**不修改任何程式碼**）
- 環境：Windows 11 / Node v26.13.0 / Python 3.11.9 + Pillow 13.0.0 / ffmpeg & ffprobe 9.0.2 / Edge `Edg/157.0.4341.42`（headless，`--mute-audio`）
- 伺服器：使用者既有的 `http://127.0.0.1:18900/`（**測試期間未啟動、未關閉**）；自建兩個臨時伺服器：`python serve.py --works %TEMP%\V2-12\works --port 18931`（主要）與 `--works %TEMP%\V2-12\clean --port 18932`（匯入還原驗證），結束時已關閉
- 作品根：`%TEMP%\V2-12\works\`（= `C:\Users\ForClaude\AppData\Local\Temp\V2-12\works\`）；乾淨作品根 `%TEMP%\V2-12\clean\`
- 測試方式：CLI（`tools/agent/{sim,difficulty,render,demo-path}.mjs`、`tools/{pack,export-game,record}.mjs`、`tests/export/edge-acceptance.mjs`）＋ MCP（16 個 `dr_*`，經自寫 stdio 客戶端）＋ headless Edge CDP 操作 `index.html`、`encounter.html`、`encounter-play.html`、匯出的單一 HTML（`file://`）
- 暫存與回收：全部寫在 `%TEMP%\V2-12\`，未遞歸刪除、未動使用者檔案、未 commit

---

## 0. 結論摘要

| 項目 | 結果 |
|---|---|
| 作品是否做成 | **是**：1 隻原創敵人（英文名 `Bellwright`）＋ 2 形態（`normal` / `belfry`，第 2 回合用 `form` cue 變身）＋ 3 支攻擊 ＋ 3 回合遭遇（zh/en、3 個 ACT、mercy 100 可饒恕、可擊倒）|
| BPM 拍點 | 三支都吃 `settings.bpm`；`bell-rain` 120 BPM、`at:"2b"`、`duration:"12b"`、`life:"4.5b"`（拍點雨）|
| 子彈運算式新變數 | `tolling-mirrors` 用 `spawnX/spawnY/spawnT/mem.*`（生成時凍結追蹤目標、`age` 逼近曲線）；`vesper-chorus` 用 `age`＋`mem` 正弦擺盪 |
| 擦彈手感 | 官方 25×25 心形遮罩（`engine/graze-mask.js`）可清楚辨識：擦過時靈魂外出現八角形黃框脈動，與 hitbox 之間留白足夠，不會誤判成命中 |
| 自動路徑 | `tools/agent/demo-path.mjs --write` 三支全成功（`bell-rain` 18 點 / hits 0 / minClearance 1.65；`tolling-mirrors` minClearance 1.01；`vesper-chorus` 1.20）|
| 難度 | `bell-rain` easy/passable（中位數受傷 0、峰值 27 彈）、`vesper-chorus` easy/passable（0、32）、`tolling-mirrors` normal/**passable false**（中位數 1、10 局 clearRate 0.1）；遭遇級 `normal` / passable false（見 §3 V3，這是工具誤報）|
| 遭遇 demo | `spared`、1380 幀、hits 0、grazes 25、TP +100、峰值 32 彈；三支攻擊都在 demo 播完（attackStart/End 幀 267/507、704/974、1038/1275）|
| 時間軸總覽 | 編輯器新面板可用，但**回合內 `attack` cue 的攻擊沒被預載 → 沒播、錯誤被吞**：T3 只算 3.5s（實際 11.5s，漏掉 237 幀的攻擊）、總長 34.9s（實際 44.3s 到 turnEnd／46.0s 到收尾）→ §3 V2 |
| 作品包 | `bellwright.drpack.json` 53,996 bytes（encounters 1 / attacks 3），匯入乾淨作品根後 encounter 檔 byte 完全相同、攻擊 JSON 語意相同但排版被重寫 |
| 可遊玩 HTML | zh 10,933,333 bytes、en 8,106,542 bytes；`edge-acceptance.mjs` 兩份都 `pass:true`（file:// 玩到 `spared`、console error 0、意外網路 0）|
| 錄影 | `bellwright.mp4` 4,079,757 bytes、46.03s、h264 640×480 30fps 1381 幀 ＋ aac 44.1k 立體聲；`--verify` 與獨立 ffprobe 都通過 |
| 發現問題 | **16 條**（高 3 / 中 7 / 低 6）＋ 文件問題 7 條 ＋ 工具缺口 6 條 |

---

## 1. 作品概要

### 1.1 檔案清單（全部在 `%TEMP%\V2-12\works\`）

| 檔案 | 大小 | 行數 | 內容 |
|---|---|---|---|
| `works\attacks\bell-rain.json` | 5,670 B | 252 | "Peal Rain"：120 BPM 拍點鐘雨（第 1 回合）|
| `works\attacks\tolling-mirrors.json` | 7,035 B | 301 | "Tolling Mirrors"：90 BPM 鏡像鐘 + 內縮鐘環 + 碎片爆散（第 2 回合）|
| `works\attacks\vesper-chorus.json` | 7,114 B | 317 | "Vesper Chorus"：150 BPM 瞄準齊射 + 擺盪鐘幕 + 全向鐘舌（第 3 回合）|
| `works\encounters\bellwright.json` | 20,226 B | 883 | 遭遇：3 名隊員 + 1 敵人 + 2 形態 + 3 ACT + 3 回合 + demo + hooks |

輸出（`%TEMP%\V2-12\out\`）：

| 檔案 | 大小 | 說明 |
|---|---|---|
| `bellwright.drpack.json` | 53,996 B | 作品包 `format: dr-battle-pack/1` |
| `bellwright-roundtrip.drpack.json` | 53,996 B | 從乾淨作品根再匯出的作品包（內容 hash 與原包相同）|
| `bellwright-zh.html` | 10,933,333 B | 可遊玩單一 HTML（繁中/簡中字型 3 套）|
| `bellwright-en.html` | 8,106,542 B | 可遊玩單一 HTML（英文）|
| `bellwright.mp4` / `bellwright.wav` | 4,079,757 B / 8,120,358 B | demo 錄影 46.03s ＋ 獨立音軌 |
| `frames\` | 1,382 PNG | 逐幀擷取（供剪輯）|

截圖（`%TEMP%\V2-12\shots\`，共 22 張）：`01-encounter-editor.png`、`02-tabs.png`、`03-timeline.png`、`04-timeline-top.png`、`05-timeline-net.png`、`06-timeline-bottom.png`、`07-attack-editor.png`、`08-generate-path-dialog.png`、`09-demo-tab.png`、`10-demo-section.png`、`11-demo-expanded.png`、`12-generate-running.png`、`13-clean-root-encounter.png`、`14-export-html-click.png`、`15-play-title.png`、`16-play-after-z.png`、`17-play-correct-param.png`、`18-final-timeline.png`、`19-play-correct-url.png`、`20-demo-section-initial.png`、`21-actor-forms-panel.png`、`22-actor-forms-panel.png`；驗收 `shots\acceptance\`（zh 的 title/battle/end + report.json）、`shots\acceptance-en\`（en 的 3 張）；錄影取幀 `shots\video\{frame-20s,frame-44s,enemy-zoom,graze-zoom}.png`。合計 22 張編輯器／遊玩截圖 ＋ 6 張驗收截圖 ＋ 4 張錄影取幀。

截圖與報告之間的路徑對照：`shots\18-final-timeline.png` 對應 §3 V2 的時間軸總覽；`shots\video\graze-zoom.png` 是擦彈心形遮罩的 4× 放大（靈魂被 8 顆子彈包夾、外框亮黃）。

### 1.2 敵人與形態（`actor.forms`）

- 敵人 `bellwright`（kind `enemy`），基礎 `anims`：`idle` = `spr_bell_enemy`（7 幀, fps 6）、`hurt` = `spr_bell_enemy_spin`、`spared`/`defeat` = `spr_bell_enemy_spin_pose`、`happy` = `spr_bell_enemy_spin`。
- `form: "normal"`；`forms.belfry` = `{ scale: 0.82, offset: {x:0, y:-18}, anims: { idle: spr_bell_enemy_tuning_fork fps 3, happy: 同 } }`，其餘狀態沿用基礎（SPEC-P2 §62–78 的退回規則實測正確）。
- 變身時機：`turns[1].start` 的 cue 鏈 `set belfry=1` → `flash #c0e8ff` → `sfx snd_glassbreak` → **`form bellwright → belfry`** → `anim idle` → `shake` → `say`。
- 第 3 回合 `turns[2].start` 用 `if cond "vars.belfry"` 切回 `normal`（並 `set belfry=0`），`onSpare`/`onDefeat` 也各自切回 `normal` 再播 `spared`/`defeat`。
- **踩到的坑**：`forms-demo.json` 範例的 `cond` 寫 `vars.baked`（不是文件其他地方的 `var.baked`）。兩者都能編譯（`engine/expr.js` 會把 `var.` 改寫成 `vars.`），所以照抄不會壞，但文件沒說明哪一個是正解。
- 編輯器 UI 實測（不是只寫 JSON）：左樹 `☺Actor bellwright` 點選後，Inspector 有獨立 **`Forms`** 區塊，文案 `A form is a switchable animation set (e.g. a transformation). Switch with the form cue; animations missing from a form fall back to the base anims below.`，`Initial form` 下拉有 `(no form — base anims only)/normal/belfry` 且正確顯示 `normal`；下方兩列 `normal｜initial` 與 `belfry` 各帶 `⚡`（預覽該形態）`⧉`（複製）`✎`（改名）`✕`（刪除），最底 `Add form`。
- 更下面 **`Animation states`** 區塊有 `Base anims / normal / belfry` 三個分頁（實測可切），可直接編輯該形態的動畫狀態表並即時預覽——**「形態內未覆寫的狀態沿用基礎」在 UI 上就是「分頁裡留空」**，比讀 SPEC 文字更直覺。
- 截圖：`shots\21-actor-forms-panel.png`（Forms ＋ Animation states 同框）、`shots\22-actor-forms-panel.png`（樹與 Initial position／Forms 開頭）。**這一區沒有文件截圖或欄位說明**，但文案自帶解釋；唯一的摩擦是它位在 Inspector 很下方（要先捲過 Initial position／Apply preset，見 V13）。

### 1.3 三支攻擊

**① `bell-rain`（第 1 回合）— BPM 拍點主驗證**

- `settings.bpm: 120`、`beatOffset: 0.15`、`duration: 8`、`seed: 12`、`damage: 6`、`invincibleFrames: 30`、`grazeTP: 1.0`、box 150×165（中心 320,190）。
- 時間軸全部用拍點：`ev_peal at "2b"`（emitter `duration "12b"`、`interval "1b"`、`count 3`、`speed "1.9 + i*0.6"`、`life "4.5b"`）、`ev_offbeat at "1.5b"`、`ev_wave_l at "5b"`（每 0.75b）、`ev_wave_r at "6b"`、`clear "14.5b"`、`end "15.8b"`。
- 240 幀；`dr_validate` 0 錯 0 警告；`demo-path.mjs --write --seed 12 --budget 45s` → 7.9 秒得 18 點、hits 0、minClearance 1.65。
- **錯誤原文 1**（我第一版把 `clear`/`end` 寫成秒數）：沒有報錯，只是攻擊在 123 幀就結束（應為 240）。原因是「時間類欄位可吃秒或拍點」的通則只寫在 SPEC-EXPR-V2 §1，我漏讀；之後改 `"14.5b"`/`"15.8b"` 即正常。

**② `tolling-mirrors`（第 2 回合）— 子彈運算式新變數主驗證**

- `settings.bpm: 90`、`duration: 9`、`seed: 21`、`damage: 5`、`invincibleFrames: 45`。
- `ev_mirror_top at "2b"`（emitter `duration "8b"`、`interval "2.4b"`、`count 2`）的 spawn：
  `memory: { side: "i * 2 - 1", phase: "rand(0, 360)", tx: "soul.x", ty: "soul.y" }`
  `pathX: "(mem.tx - spawnX) * min(age, 1.2) * 0.45 + sin(age * 150 + mem.phase) * 12 * mem.side"`
  `pathY: "min(age, 1.2) * (box.bottom - spawnY - 34) + cos(age * 150 + mem.phase) * 8"`
- `ev_mirror_bottom at "5b"` 對稱版；`ev_chime_ring at "3b"`（半徑 64/68 往內 13 顆）、`ev_chime_ring2 at "9b"`（往外 10 顆）、`ev_shard_burst at "12b"`（`memory: { late: "spawnT", sp: "rand(1.5,2.6)" }`、`angle: "90 + rand(-30,30) + mem.late * 6"` — 直接用 `spawnT` 驅動角度）、`ev_box_shrink at "13b"` 收束到 122×138。
- **關鍵學習（本任務最大收穫）**：`pathX` 一開始我直接寫 `(soul.x - spawnX) * min(age,1.2) * 0.7`，結果子彈整段時間持續追著靈魂 → 難度報告 `noHitRate 0`、danger 集中在第 3 回合。改成「生成時用 `mem.tx/mem.ty` 凍結當時的靈魂位置」＋逼近係數 0.7→0.45 後才有可解路線。這條「`soul.*` 是每幀即時值、要凍結請用 `memory`」文件只寫了 `memory` 的求值時機，沒有寫這個設計陷阱。
- **錯誤原文 2**（負向測試，確認驗證器訊息正確）：把 `settings.bpm` 拿掉但保留 `at: "2b"` → `{"path":"timeline[0].at","message":"\"2b\" 是拍點單位，但 settings.bpm 未設定；請在 settings 加上正數 bpm（例如 \"bpm\": 120），或把 at 改成秒數"}`。訊息很好，照著改就好。

**③ `vesper-chorus`（第 3 回合）**

- `settings.bpm: 150`、`beatOffset: 0.1`、`duration: 10`、`seed: 33`。
- box 左擺 `"2b"`（x 250）→ 右擺 `"8b"`（x 392）→ 回中 `"14b"`；`ev_aim_volley at "3b"`（`angle: "aim(x, y) + rand(-4,4)"`）、`ev_clapper at "10b"` 全向 8 顆、`ev_veil_l/r` 用 `pathY: "sin(age * 340 + mem.ph) * mem.amp"` 擺盪鐘幕；`clear "18b"`、`end "19.5b"`。

### 1.4 遭遇（3 回合、zh/en、ACT、mercy）

- `settings`：`seed 12`、`bgm "kingboss"`、`background "spr_battlebg_2"`、`canFlee false`、`introText` zh/en。
- enemy：`hp/maxHp 160`、`atk 6`、`spareAt 100`；ACT：`Check`（無 mercy）、`Listen`（kris，mercy 40，`say`+`anim happy`+`set listened +1`）、`Resonate`（susie，mercy 35，`if vars.listened >= 1` 時再加 15 mercy + `shake` + `sfx`）。
- party：kris / susie / ralsei 標準動畫；ralsei 有 `pacify`（TP 32、mercy 22）。items：`chime_tea`。
- 回合：t1 `bell-rain`；t2 `tolling-mirrors`（含變身 cue 鏈）；t3 **`attack: null`**，`start` 內含 `if vars.belfry`（切回 normal / 或切 belfry）→ `bubble`「第三响……不等你准备好。」`wait 1.6` → **`attack` cue 內嵌 `vesper-chorus`**。
- demo：`menuDelay 6`、`text.auto true`、三回合分別 Listen+Resonate→防禦 / Listen→防禦 / 饒恕。
- **為什麼 t3 的攻擊要放 cue**：`demo.turns[].turn` 驗證器硬性擋「超過回合數」（見 §3 V4），而 demo 只會照 `demo.turns` 的回合數走。把第 3 支攻擊放進 t3 的 `attack` 欄位會讓 demo 走不到它（t3 只會被 demo 覆蓋一次），放在 `start` 的 `attack` cue 則一定播到。代價是時間軸總覽與難度報告都不認得它（§3 V2/V3）。

### 1.5 擦彈手感（官方心形遮罩）

`dr_render` 抓 `bell-rain` 的第 116/118/123/125/128/141/143/145/152/185/191/220 幀（scale 2、`hitboxes:true`）：擦過時靈魂外出現**八角形／心形輪廓的黃色外框**（亮黃與暗橄欖兩色交替脈動），與子彈 hitbox 之間留白明顯；同一段 12 次 graze、0 hit。`settings.grazeTP: 1` 的 +1%/幀在 demo 中累積到 TP 100。

- 手感判讀：外框只在「貼邊」時出現，玩家能清楚知道自己在擦彈；斜向（45°）判定最寬鬆、正下方最緊（遮罩 25×25 的形狀決定，斜上約 19.1px、斜下約 15.6px）。這與原作的「心形擦彈」一致。
- 放大圖：`%TEMP%\V2-12\shots\video\graze-zoom.png`（800×600，4× 最近鄰）。

---

## 2. 做了什麼、每步花多久

| 階段 | 內容 | 工具／頁面 | 大約耗時 |
|---|---|---|---|
| 1. 讀規格與環境偵察 | 讀 ROADMAP-V2 §2/§3、上一次 REALTEST、AGENT-GUIDE、`tools/agent/README.md`、RECORD、EXPORT-GAME、SPEC-EXPR-V2、SPEC-P2；盤點 `assets/index.json`（2784 sprites / 266 audio / 22 fonts）、samples；記錄 git 與程序基線 | 檔案系統、`/api/info`、`mcp-server.mjs --http` 自檢 | 10 分 |
| 2. 素材挑選 | 篩「鐘／音叉」母題；做雪碧聯絡表親眼看過（鈴 7 幀、音叉、鐘舌、心形碎片）；決定不自繪素材 | Python + Pillow | 5 分 |
| 3. 攻擊 1（BPM 拍點） | 寫 `bell-rain.json`、`dr_validate`、`dr_render` 看畫面、`demo-path --write`、`dr_difficulty` 調到 easy | MCP + CLI | 4 分（含 pathgen 7.9s）|
| 4. 攻擊 2（新變數） | 寫 `tolling-mirrors.json`；第一次路徑「追著靈魂跑」→ 改 `mem.tx/ty` 凍結；`dr_difficulty` 三輪調整（mirror 幅度、shard count、invincibleFrames）| MCP + CLI | 13 分 |
| 5. 攻擊 3 | `vesper-chorus.json`：拍點移框 + 瞄準齊射 + 正弦鐘幕 | MCP + CLI | 4 分 |
| 6. 遭遇 | 建 actor/party/enemy/forms/3 ACT/3 回合/hooks/vars/items/demo；寫變身 cue 鏈；解 demo 回合上限問題 | `dr_write` + `dr_validate` + `dr_simulate` | 13 分（與 4/5 交錯）|
| 7. 難度調整 | `dr_difficulty`（bot=dodge，runs 8–10）逐支與整場；三次調參 | CLI | 10 分 |
| 8. 編輯器實測 | headless Edge 開 `encounter.html?file=bellwright`、`index.html?file=bell-rain`；找 Timeline 分頁看總覽；捲到 Demo 區塊按 Generate path（1.8s 完成 18 點）；選 actor 看 Forms 區塊；截圖 | Edge CDP | 15 分（三輪）|
| 9. 匯出 | `pack.mjs export`、`export-game.mjs --lang zh/en` | CLI | 1 分 |
| 10. file:// 驗收 | `tests/export/edge-acceptance.mjs` zh（48.2s）＋ en（55.7s），三張截圖與 report.json | CLI | 6 分（含等待）|
| 11. 錄影 | `tools/record.mjs --autoplay demo --capture canvas --verify`（22.4s）＋ ffprobe 複驗 | CLI | 1 分 |
| 12. 匯入還原 | `pack.mjs import --mode abort` 到乾淨作品根；byte 比對；在 clean root 重跑 `dr_validate`/`dr_simulate`/再匯出 | CLI + MCP | 3 分 |
| 13. 收尾與取證 | play 頁正確參數／錯誤參數對照、404 來源追查、Demo 區塊點擊行為、時間軸錯誤根因（Node 直接 import `simulateTimeline` 重跑 7 個探針）、難度數據重跑、git/assets 基線比對 | Edge CDP + CLI + Node | 34 分（12:29–13:03，多為報告取證）|
| 14. 撰寫報告 | 本文件（繁中）＋編碼/LF 驗證＋數字與檔案路徑逐項回查 | 文字編輯 | 41 分（12:29–13:10，與 13 交錯）|
| **合計** | 作品與驗收 11:38–12:29 約 51 分；取證＋報告 12:29–13:10 約 41 分 | | **牆鐘時間約 92 分（11:38–13:10）** |

**整體印象**：這次真正卡住創作者的不是「寫 JSON」（schema、驗證訊息、難度報告都很好用），而是**「頁面參數怎麼填」與「新功能之間的語意不一致」**：`encounter-play.html` 的 `?encounter=` 要填完整可 fetch 路徑、回合內插攻擊在三種工具（時間軸總覽／難度報告／demo 回合上限）各有不同盲點。這三個都是 V2-07/V2-02 新功能接縫處的整合問題，不是單一工具的 bug。

---

## 3. 卡關點／問題清單（依嚴重度）

> 編號 V1…V16 為本次編號，與上一次報告的 B1…B20 區隔。

### [高] V1. `encounter-play.html?encounter=` 需要「完整可 fetch 路徑」，且錯誤時**靜默載入內建範例**（最花時間、最易誤導）

- 文件（`SPEC-AUTOPLAY.md:155`、`RECORD.md:81`、`tools/agent/README.md:459`）都只寫 `encounter-play.html?encounter=…`，**沒有說 `…` 要填什麼**。
- 實測三種寫法：
  - `?encounter=bellwright` → `GET /bellwright 404` → **錯誤訊息被自己蓋掉**：程式先 `setBanner('遭遇檔載入失敗：…已切換到假資料模式。')` 再 `await startMock()`，而 `startMock()` 第一件事就是 `setBanner('假資料模式（?mock=1）…')`（`encounter-play.html:1537-1547` 呼叫 `:1507`），所以使用者**只看得到「假資料模式（?mock=1）…」，看不到到底 404 了什麼**。畫面看起來像真的遊戲（`MOCK_SCENES` 共 17 個場景，`encounter-play.html:338-356`）。
  - `?file=bellwright`（猜錯參數名）→ `encounterParam` 為 null → **完全沒有任何錯誤訊息**（banner 只顯示按鍵提示），載入預設 `samples/encounters/rudinn.json`；我一度以為載入成功，直到用 `getState()` 看到 `actors: kris/susie/ralsei/rudinn/hathy`（`rudinn: spr_bakesale_rudinn`）才發現。
  - `?encounter=doesnotexist` → 同第一種，落回假資料模式且錯誤訊息被蓋。
  - **只有 `?encounter=api/encounters/bellwright.json`（含 `/api/` 與 `.json`）才真的載入我的作品**（`actors: bellwright/kris/ralsei/susie`，截圖 `shots\19-play-correct-url.png`）。
- 對照組：攻擊頁 `play.html` 的同一件事**做得正確**——`?attack=bell-rain` 會顯示 `攻擊檔載入失敗：HTTP 404（bell-rain）` 並留在錯誤狀態，`?file=` 會顯示 `未指定 ?attack=，使用 play.html 內建示範攻擊（E1 整合測試用）。`。也就是說「遭遇頁」是兩頁之間唯一沒有提示的，修起來有現成樣板。
- `tools/agent/render.mjs:702-716` 內部是這樣組的（`ensureServable()` 產生的相對路徑），所以 CLI 的 `dr_render`/`dr_record` 都正常；只有「人要自己開頁面」時踩到。
- **繞過**：改用 `api/encounters/<name>.json`；或一律走 `tools/record.mjs`／`dr_render`。
- 涉及檔案：`encounter-play.html:219,1550`、`tools/agent/render.mjs:702`、`docs/SPEC-AUTOPLAY.md`、`docs/RECORD.md`、`tools/agent/README.md`。

### [高] V2. 遭遇時間軸總覽有兩層問題：**回合內 `attack` cue 的攻擊根本沒被預載**（所以沒播），錯誤又被吞掉；長度因此算不出來

編輯器 Timeline 分頁實測輸出：`Simulated 1046 frames · result —`；每回合 `T1 15.8s / T2 15.6s / **T3 3.5s**`；底部 `Total: 3 turns · 1046 frames · **34.9s**`。同一份遭遇用 `dr_simulate`（demo）是 **1380 幀 / 46.0s**，且 sim 事件明確有第三次 `attackStart/attackEnd`（幀 1038/1275，共 237 幀 ≈ 7.9s）。我在 DOM 量到 T3 的三個 `enctl-seg` 全是 `say`（寬 144/64/208px），**沒有任何 attack 段**。

我在 Node 直接把編輯器的 `simulateTimeline()` 拉出來重跑（模擬編輯器只預載 `turn.attack` 的行為），拿到確切原因鏈：

1. **預載清單只掃 `turn.attack`**（`editor/encounter/timeline.js:477-489`，用 `attackNameOf(turn)`）。t3 的 `attack` 是 `null`，所以 `vesper-chorus` 從頭到尾沒有被 `resolveAttack` 過 → `attacks` Map 沒有它。
2. **引擎因此報錯，但錯誤被吞掉**：`engine/encounter/world.js:693-698` 找不到攻擊檔時 `emit('error', {path:'attack', message:'找不到攻擊檔 "vesper-chorus"'})`；`simulateTimeline` 把它收進 `sim.errors`（我實跑印出：`[{path:"attack", message:"找不到攻擊檔 \"vesper-chorus\""}]`），但 `buildTimelineRows()` **完全不讀 `sim.errors`**（只讀 `pilotError` 與 `loadErrors`，`timeline.js:260-263`）→ UI 上一條警告都沒有。
3. **總覽因此少跑 290 幀**（`sim.frames` 1090 vs `dr_simulate` 的 1380）並提早結束：T3 只剩選單＋台詞 3.5s；`enc.result` 也停在 `null`（顯示 `—`），因為迴圈在「三個回合都 turnEnd」的第 1090 幀就 break，而 `spare` 判定要跑到第 1380 幀（見 V14）。
4. 就算攻擊被正確預載，`attackSegs` 的名稱仍取自 `name = attackNameOf(turn)`（`timeline.js:270,320`）而不是事件裡的 `atk.name`；t3 名稱是 `null`，段長度仍會被算成 0，除非同時修名稱來源。我把三支攻擊都塞進 `resolveAttack` 重跑，`rows` 的 T3 依然只有三個 `say` 段——證實這一層是獨立的第二個 bug。

**影響**：本任務第 5 步「用遭遇時間軸總覽檢查節奏」的核心需求直接失效——T3 應該是 **11.5s**（985→1329 幀），總覽只給 3.5s；整場應該是 **44.3s**（到 turnEnd）／46.0s（到收尾），總覽給 34.9s（少 21–24%），而且沒有任何提示告訴你「第三回合的攻擊沒被算進來」。

**繞過**：自己用 `dr_simulate` 的 events 數 `attackStart/attackEnd`，或看 demo 的總幀數。

**涉及檔案**：`editor/encounter/timeline.js:260-263,270,316-340,477-489`、`engine/encounter/world.js:693-698`。

### [高] V3. `dr_difficulty` 對「回合內插攻擊」的遭遇誤報：`mostDangerous` 標成「第 3 回合（無攻擊）」、`passable:false` 但 bot 全勝

- 同一份遭遇、`--runs 8 --bot dodge` 的輸出：
  - `difficulty: normal`、`passable: false`、`clearRate: 0`、`hits.median: 3`、`damage.median: 17`
  - `encounter.outcome.rates: { victory: 1 }`（8/8 全勝）、`duration 76.23s`
  - `mostDangerous: { turn: 3, attack: null, hits.median 2, damage.median 12, noHitRate 0, commands: 9×fight }`
  - `suggestions` 原文（節錄）：`最危險回合：第 3 回合（無攻擊）——平均受傷 2 次、最多 2 次、無傷率 0%。`、`完全沒有無傷紀錄的回合：第 2 回合、第 3 回合 → 這幾回的彈幕可能太密。`
- 兩個問題：
  1. **`attack: null`**：`tools/agent/difficulty.mjs:103` 只用 `perTurn[].attack`（引擎的回合欄位）補名稱，回合內用 cue 播的攻擊沒有名字，於是「最危險回合」被標成「無攻擊」——文字上自相矛盾（有 12 點傷害卻說無攻擊）。
  2. **`passable:false` 與 8/8 victory 並列**：`passable` 的定義是「中位數受傷 ≤ 6 且至少 15% 種子 0 受傷」（`difficulty.mjs:46-47,314`），也就是**零傷率**；它與「能不能通關」不是同一件事。報告同時給 `outcome victory 100%`，創作者很難判斷作品到底能不能玩。
- 我最後手動把每回合的 hits 攤開判讀（t1 noHitRate 1.0、t2/t3 0）才確定「Boss 難度合理、只是沒有無傷路線」。
- 繞過：改看 `encounter.outcome` 與 `dangerTurns[].hits`；單支攻擊分開跑 `dr_difficulty`（三支都有正確的 attack 名）。
- 涉及檔案：`tools/agent/difficulty.mjs:103,314`、`tools/agent/README.md`（passable 定義未寫）。

### [中] V4. `demo.turns[].turn` 不能超過回合數 → 「3 回合遭遇要展示 3 支攻擊」是工作流死角

- 錯誤原文（`dr_write`/`dr_validate` 都擋）：`回合 4 超出遭遇的回合數（共 3 回合）`（`engine/autoplay/validate-encounter.js:423`）。
- 這是正確的驗證，但沒有指引：3 回合遭遇＋3 支攻擊（每回合一支）在 demo 裡走不到第 3 支，因為 demo 的回合數等於 `turns.length`，而 t3 的 `attack` 欄位只會被播放一次。
- 我花了約 15 分鐘試錯（先試 demo turn 4 → 被擋；再試 `turnOrder: loop-last` → demo 仍不循環；最後把 t3 的攻擊搬進 `start` 的 `attack` cue）。
- 建議（文件層面即可）：`AGENT-GUIDE.md` 示範「最後一回合把攻擊放 `attack` cue」；或驗證器訊息附一句「若要在最終回合多播一支攻擊，請用 turn.start 的 attack cue」。
- 涉及檔案：`engine/autoplay/validate-encounter.js:423`、`docs/AGENT-GUIDE.md`、`docs/SPEC-P2.md`（cue 清單沒有 `attack` 的使用時機說明）。

### [中] V5. `export-game.mjs` 把引擎內建素材報成「文件引用但索引沒有的 sprite/音訊」

- 匯出 zh/en 兩份 HTML 都出現 8 條 warning，原文：
  - `文件引用但索引沒有的 sprite：spr_grazeappear、spr_grazeappear_small、spr_grazeappear_yellow、spr_grazemask、spr_grazemask_small`
  - `文件引用但索引沒有的音訊：snd_cancel、snd_move、snd_nosound`
- 這些其實是引擎自己畫的（`engine/graze-mask.js` 內建 25×25 遮罩）與引擎內建 UI 音效，**不是我的作品缺素材**；匯出結果也確實可玩（`pass:true`）。但 warning 會讓創作者以為素材索引壞了，浪費時間去查。
- 繞過：確認匯出後的 HTML 可玩即可忽略。
- 涉及檔案：`tools/export-game.mjs`。

### [中] V6. `pack.mjs import` 會重排攻擊 JSON（作品根若受版控會整檔 diff）

- 乾淨作品根匯入後：`encounters/bellwright.json` **byte 完全相同**（20,226 B、LF、無 BOM、sha256 相同）；三支攻擊**語意相同但排版不同**（陣列/物件被重新 stringify 成多行），byte hash 全部不同。
- 對「作品根放進 git 版控」的用法（ROADMAP-V2 §1 明說可以）是實際困擾：匯出→匯入一輪就多一個整檔 diff。
- 繞過：以「再匯出的作品包內容 hash」驗證（去掉 `meta` 後與原包相同 `b0d35d49ab4a49e9`）。
- 涉及檔案：`tools/pack.mjs`。

### [中] V7. `tools/record.mjs` 對未知旗標靜默接受（`--kind` 不存在但吃了參數）

- 我照慣例給 `node tools/record.mjs bellwright --kind encounter ...`（`pack.mjs`/`export-game.mjs` 都有 `--kind`）；record 的 `VALUE_FLAGS`（`tools/record/cli.js:13-34`）**沒有 `kind`**，於是 `--kind` 被當成布林 `true`、後面的 `encounter` 變成多餘的位置參數，**沒有任何警告**，程式照樣自動偵測類型並完成錄影。
- 影響：使用者無法從輸出判斷「參數到底有沒有生效」；我在錄影成功後仍不確定 kind 是被推斷還是被指定。
- 建議：`parseArgs`（`tools/agent/lib.mjs:290`）對「未列入 VALUE_FLAGS/BOOLEAN_FLAGS 的長旗標」印一行警告。
- 涉及檔案：`tools/record/cli.js`、`tools/agent/lib.mjs:290-317`。

### [中] V8. `--works` 模式下開 `encounter.html` 會有 6 個 404（範例選單的攻擊引用解析不到）

- 每次開 `encounter.html?file=bellwright` 的伺服器日誌都有：
  `GET /api/attacks/spade-rain.json 404`、`GET /attacks/spade-rain.json 404`（`ring-burst`、`box-shrink-aim` 各兩次，共 6 條），頁面 console 也留 6 條 `Failed to load resource: 404`。
- 來源是 `samples/index.json` 內建範例（showcase 遭引用三支範例攻擊）在作品根模式下解析不到（作品根只有我的三支）。功能上不影響，但「開編輯器就一堆紅字」容易誤判成作品有問題。
- 涉及檔案：`encounter.html`／`editor/encounter/fileops.js`（範例載入）、`samples/index.json`。

### [中] V9. 時間軸總覽的垂直空間仍然不夠（上次 B3 的同類問題在新面板重現）

- `.enctl-scroll` 的 `clientHeight` 實測 174px（面板 254px），一次只露得出 2–3 列；3 回合就要滾動。`body.style.zoom='0.75'` 才勉強塞下三列（`shots\05-timeline-net.png`）。
- 上次的 B3 是靠拖 `#split-timeline` 解決；新面板沒有對應的把手，也沒有「可捲動」提示。
- 涉及檔案：`editor/encounter/timeline.js:668`、`editor/encounter/v2.css`（`.enctl-scroll` 高度）。

### [中] V10. 編輯器「Export playable HTML」按鈕在 headless/自動化下找不到下載檔

- 按鈕按下去顯示 `Downloaded`，但檔案落在該次 Edge 的 user-data-dir（`V2-12/logs/edge-profile-*`）裡，使用者拿不到。人用一般瀏覽器不會遇到，但「用 CDP 驗收」的路徑不可用。
- 繞過：一律用 CLI `tools/export-game.mjs`。
- 涉及檔案：`tools/web/export-button.js`、`encounter.html`／`index.html`（按鈕掛載）。

### [低] V11. `dr_render` 超過攻擊結束幀只給 warning

- 原文：`要求第 N 幀，但攻擊已結束於第 123 幀`。行為正確（不該捏造幀），但 `frames` 陣列裡的缺幀與 warning 要自己對照才看得出少哪張；建議在回傳值加 `actualFrames` 陣列。
- 涉及檔案：`tools/agent/render.mjs`。

### [低] V12. `/favicon.ico` 404（四頁都有）

- 頁面引用 `favicon.svg`（存在、200），但瀏覽器仍請求 `/favicon.ico` → 404。伺服器日誌與 console 各一條。上次 B11 是 `favicon.ico` 404，這次看起來頁面已改引用 `.svg`，但少了 `<link rel="icon" href="favicon.ico">` 或伺服器端 fallback。
- 涉及檔案：`index.html`、`encounter.html`、`play.html`、`encounter-play.html`、`serve.py`。

### [低] V13. 編輯器 Inspector 太長：`Generate path` 按鈕在文件 y≈2020px

- `Demo` 區塊**預設是展開的**（`.pan-section-body` 沒有 `collapsed`、箭頭 ▾），但 Inspector 整欄往下堆，捲到底才看得到；實測 `Generate path` 按鈕 `getBoundingClientRect().top = 2020`，視窗高度 868，得捲約 1150px。同一區還有 `Recompute trace`、`● Record demo`。
- 附帶的小混淆：我第一次只看到「點標題會切換箭頭」就以為要點兩次才會展開——實際上第一下是**收起來**（▾→▸）。這個方向性沒有任何提示文字。
- 建議：Demo 區塊預設收合並記住狀態，或把「產生路徑」提到工具列；另外把收合狀態在 hover 時用 title 說明。
- 涉及檔案：`editor/inspector.js`（`pan-section`）、`editor/panels.css`。

### [低] V14. 時間軸總覽的 `result` 永遠顯示 `—`（同一份遭遇 `dr_simulate` 是 `spared`）

- 面板文字：`Simulated 1046 frames · result —`；但同一份遭遇 `sim.mjs --autoplay demo` 是 `result: spared`、1380 幀。我用引擎直接跑兩次（同一份 doc、同一支 demo pilot）量到：
  - **編輯器實況**（第三支攻擊沒載到）：第 1090 幀 break、`result` 仍是 `null`（但 `phase` **已經是 `spared`**），`result` 要到第 1141 幀才成形 → **只差 51 幀**。
  - **三支攻擊都載入**：第 1329 幀 break、`result` 仍是 `null`，第 1380 幀才變 `spared`（饒恕後的收尾）→ 同樣差 51 幀。
- 成因：`editor/encounter/timeline.js:574` 的 `if (endedTurns.size >= wanted && i > fps) break;` 一看到「三回合都 turnEnd」就跳出，剛好永遠早 `result` 51 幀，於是 `sim.result` 永遠是 `null`，UI 顯示 `—`（`timeline.js:816`）。另外面板顯示的 `1046 frames` 是 `rows` 各回合幀數相加（`timeline.js:293`，不含回合外的段落），不是 `sim.frames`。
- 影響：創作者用總覽檢查節奏時，看不出這個 demo 到底會 spare 還是 victory（本任務第 5 步的另一半需求），仍得回頭跑 `dr_simulate`。
- 建議：把 break 條件改成 `i > fps && (enc.result || endedTurns.size >= wanted && enc.getState().phase === 'spared')`，或直接多跑 60 幀再取 `result`；上面兩次量測都證明 `phase` 在 break 當下就已經正確，資訊就在手上。
- 涉及檔案：`editor/encounter/timeline.js:293,574,816`。

### [低] V15. `record.mjs` 會在專案樹內建 `tools/record/.tmp/`

- 作品檔不在程式根時，錄影會複製一份到 `battle-editor/tools/record/.tmp/`（有 `.gitignore` 的 `.tmp/`，所以不會進 git），warning 原文：`作品檔不在程式根內（...\works\encounters\bellwright.json）→ 已複製到 tools/record/.tmp 供頁面載入`。
- 實測收工時該目錄已空（`ls -A` 無輸出），但 warning 沒有說「會自動清掉」，第一次看到會擔心污染專案。
- 涉及檔案：`tools/record.mjs:394,409`。

### [低] V16. 有 `bpm` 但 `clear`/`end` 寫成秒數時沒有任何提示

- 我第一版 `bell-rain` 的 `clear: 11.0`、`end: 12.0`（秒）與其他拍點欄位混用，行為上「合法」，只是整段提早結束（123 幀 vs 240 幀）。驗證器不該禁止混用（SPEC 允許混用），但可以在「同一檔案其他時間欄位都用拍點、bpm 已設定、這兩個是整數秒」時給 info 級提示。
- 涉及檔案：`engine/attack.js`（驗證）、`docs/SPEC-EXPR-V2.md`。

---

## 4. 文件不清楚之處

1. **`encounter-play.html?encounter=` 要填什麼**（V1）：三份文件都只寫 `?encounter=…`。實際要填「頁面可 fetch 的相對路徑」，作品根模式是 `api/encounters/<name>.json`；`--works` 與程式根兩種模式的路徑不同。也沒有文件說明「`?file=` 會被忽略且不會報錯」。
2. **`attack` cue 的定位**：SPEC-P2 的 cue 列表有 `attack`，但沒有說「它和 `turn.attack` 的差別／什麼時候該用」；時間軸總覽與難度報告也都只認 `turn.attack`。這正是 V2/V3/V4 的共同根源。
3. **`passable` / `clearRate` 的定義**（V3）：README §6.4 只列欄位名，沒說 `passable` 門檻是「中位數受傷 ≤ 6 且 ≥15% 零傷」的零傷率概念，讀者會直接理解成「能不能通關」。
4. **`demo.turns[].turn` 的上限**（V4）：驗證器有清楚錯誤訊息，但文件沒有「demo 只能覆蓋已存在的回合」這條規則，也沒有「最後回合要加攻擊」的建議寫法。
5. **`forms` 的 `cond` 用 `var.` 還是 `vars.`**：`samples/encounters/forms-demo.json` 用 `vars.baked`，AGENT-GUIDE 的其他範例用 `var.baked`；兩者都能跑（編譯期改寫），但沒有文件說明這是等價語法。
6. **`memory` 的設計陷阱**（§1.3 ②）：文件寫了「生成時求值一次並固定」，但沒有舉「要追蹤靈魂請在 memory 裡快照 `soul.x`，不要在 `pathX` 直接讀 `soul.x`」這個實際用法，我為此多繞了 13 分鐘。
7. **`tools/record.mjs` 的旗標清單**：`docs/RECORD.md` 有列表，但 `tools/agent/README.md`（MCP 使用者最常讀的）只有 `dr_record` 參數表；且 `dr_record` 沒有 `kind`，CLI 也不吃 `--kind`（V7）。如果使用者從 `pack.mjs`/`export-game.mjs` 的習慣帶過來就會誤給。

---

## 5. 工具缺什麼

1. **沒有「一次驗證整個作品」的指令**：4 個檔要分別 `dr_validate`／`dr_simulate`，再接 `dr_difficulty`；一個 `dr_check_all --works` 會省很多輪。目前最接近的是 `check-encounters.mjs`（但只檢查遭遇，且上次報告已指出它與編輯器的攻擊解析不一致）。
2. **沒有「作品用到哪些素材」的清單**：只有匯出時從 warning 反推缺什麼（而且還混了引擎內建素材，V5）。
3. **`dr_simulate` 的 `perTurn[]` 沒有回合內攻擊的名稱／長度**：這是 V2/V3 誤報的資料源；加上 `attacks: [{name,startFrame,endFrame}]` 就能一次修好三個工具。
4. **沒有 CLI 能截「編輯器畫面」**：我只能用 CDP 自己點 Timeline 分頁與展開區塊；`dr_render` 只截遊戲畫面。對「用時間軸總覽檢查節奏」這種需求，若能 `dr_render --ui timeline` 會很省事。
5. **`pack.mjs` 沒有 `diff`／`inspect --files`**：驗證「匯入還原」時只能自己寫 Python 比對 sha256 與重新 stringify 後比較（V6）。
6. **`demo-path.mjs` 只處理單支攻擊**：遭遇層要「每支攻擊各自有 path」得一支支跑；沒有 `--encounter` 一次補完所有回合（含回合內 cue 攻擊）。

---

## 6. 與上一次 REALTEST（2026-11-08）比較

### 6.1 改善（本次新增、且實測可用）

| 項目 | 上次 | 這次 |
|---|---|---|
| BPM 拍點 | 不存在（全部用秒） | `settings.bpm` + `"2b"`/`"12b"`/`"4.5b"` 全鏈可用；三支攻擊都用；驗證錯誤訊息精準（§1.3 錯誤原文 2）|
| 子彈運算式 | 只有舊變數 | `spawnX/spawnY/spawnT/i/k/n/mem.*` 全部實測；`mem` 凍結目標點是做出「可解追逐彈」的關鍵 |
| `actor.forms` 形態 | 不存在 | 兩形態＋`form` cue 切換＋未覆寫狀態退回基礎，全部正確；編輯器 actor 面板有形態區塊（截圖 `01` 左樹可見）|
| 作品根 `--works` | 不存在 | 三個 CLI＋MCP＋serve.py 全部尊重；`/api/info` 回報正確；乾淨作品根驗證流程順暢 |
| 作品包 | 不存在 | export/import 一輪 OK，內容可完整還原 |
| 可遊玩 HTML | 不存在 | 兩份 HTML `file://` 玩到 `spared`，console error 0、意外網路 0 |
| MP4 錄影 | 不存在 | 46.03s、30fps、有音訊；`--capture canvas` 約 62 幀/秒擷取（22.4s 完成 1381 幀）|
| 遭遇時間軸總覽 | 不存在 | 有模擬幀數、每回合長度、拍點、cue chips；是本次最有價值的新面板（只是有 V2 的缺口）|
| 編輯器 URL 開檔 | 上次 B19「不支援用 URL 開指定檔案」 | `index.html?file=bell-rain`、`encounter.html?file=bellwright` 都可直接開，**B19 已改善** |
| `render.mjs` 遭遇頁警告 | 上次 B20「遭遇頁不支援自動演示」 | 本次 `record.mjs --autoplay demo` 錄完整場 1381 幀，無此警告，**B20 已改善** |
| 自動路徑產生 | 上次手拉 6 點 demo | `demo-path.mjs --write` 三支一次成功（7.9s/支以內），編輯器 Generate path 1.8s 完成 18 點 |

### 6.2 退步／新問題

1. **`encounter-play.html` 的參數語意變得更危險**（V1）：上次的 B20 只是 warning 誤報；這次「參數錯就靜默載入別的遭遇」是**看起來正常、其實不是你的作品**，比報錯更難發現。
2. **`--works` 模式下編輯器 console 有 6 條 404**（V8）：上次在程式根模式沒有這個問題（範例攻擊就在 `samples/`）。
3. **`pack.mjs import` 重排 JSON**（V6）：新功能帶來的版控摩擦，上次沒有作品包所以不存在。
4. **時間軸高度問題從舊面板轉移到新面板**（V9）：上次 B3 是舊時間軸 8 軌被裁；新面板只剩 174px 可視高，本質相同。
5. **`--kind` 靜默忽略**（V7）：`pack.mjs`/`export-game.mjs` 都吃 `--kind`，`record.mjs` 不吃也不警告，跨工具一致性退步。

### 6.3 上次 20 條問題的現況（本次有碰到的部分）

| 上次編號 | 現況 |
|---|---|
| B3 時間軸 8 軌放不下 | **未修**，且在新面板重現（V9）；但這次我不需要 8 軌，只受 3 列限制 |
| B4 `check-encounters.mjs` 與編輯器攻擊解析不一致 | 未測（本次全部走 `dr_validate`/`dr_simulate`），無資料 |
| B11 favicon 404 | 部分改善（頁面改引用 `favicon.svg`），但 `/favicon.ico` 仍 404（V12）|
| B12 `#boot-status` 卡在 Loading | 未觀察到（`面板載入結果：4/4 成功`）|
| B18 encounter-play 手動 Z 卡 menu | 未測（全程 `autoplay=demo`）|
| B19 編輯器不支援 URL 開檔 | **已改善** |
| B20 render 遭遇頁 autoplay 誤報 | **已改善** |
| B1/B2/B5/B6/B7/B8/B9/B10/B13–B17 | 本次未走那些 UI 路徑（存檔對話框、事件新增選單、結構樹操作），無資料可判 |

---

## 7. 改善建議清單（依嚴重度排序）

| # | 嚴重度 | 建議 | 涉及檔案 |
|---|---|---|---|
| 1 | 高 | **`encounter-play.html` 載入失敗不要靜默 fallback**：(a) `startMock()` 不要無條件覆寫 banner，或把原本的錯誤訊息保留在第二行（現在 `遭遇檔載入失敗：…` 被 `假資料模式（?mock=1）…` 蓋掉）；(b) `?file=` 存在但 `?encounter=` 不存在時提示「你是不是想用 `?encounter=api/encounters/<name>.json`」（照 `play.html` 的 `未指定 ?attack=` 樣板）；(c) `?encounter=` 404 時停在錯誤畫面（顯示請求的 URL 與正確格式）；(d) 成功載入時在 console 印一次實際 URL 與作品名 | `encounter-play.html:219,1507-1547,1550` |
| 2 | 高 | **時間軸總覽修兩層**：(a) 預載清單改成掃「`turn.attack`＋遞迴掃 `turn.start/end` 裡所有 `attack` cue」，並用同一份清單餵 `simulateTimeline`；(b) `buildTimelineRows` 讀 `sim.errors` 並轉成 `warnings`（現在 `找不到攻擊檔 "…"` 被完全吞掉）；(c) `attackSegs[].attackName` 改用 `turn.attack ?? atk.name`（讓 `attack` cue 也有名字與拍點）；(d) 提前 break 時用 `phase`／`spare` 事件補 `result` | `editor/encounter/timeline.js:260-263,270,316-340,477-489,574` |
| 3 | 高 | **`perTurn[]` 補回合內攻擊資訊**（`attacks: [{name,startFrame,endFrame,frames}]`），讓 `difficulty.mjs` 的 `bucket.attack` 能顯示真名；`mostDangerous` 與 `suggestions` 不要輸出「（無攻擊）」這種自相矛盾的文案 | `engine/encounter/index.js`（事件/統計）、`tools/agent/difficulty.mjs:103,215-230` |
| 4 | 高 | **難度報告把「通關率」與「零傷率」分開命名**：`outcome.rates` 之外加 `clearRate`→`zeroHitRate` 的別名或直接改名，`passable` 的判定寫進報告文字（例：`passable:false（中位數受傷 3 > 0，且 0% 種子零傷；通關率 100%）`）| `tools/agent/difficulty.mjs:46-47,314,371`、`tools/agent/README.md §6.4` |
| 5 | 中 | **驗證器／文件補「最後回合加攻擊」的建議路徑**：`demo.turns[].turn` 超界訊息附一句「要讓最終回合多播攻擊，請用 turn.start 的 attack cue」；AGENT-GUIDE 加一段範例 | `engine/autoplay/validate-encounter.js:423`、`docs/AGENT-GUIDE.md`、`docs/SPEC-P2.md` |
| 6 | 中 | **匯出警告區分「作品缺素材」與「引擎內建素材」**：`spr_graze*`、`snd_cancel/snd_move/snd_nosound` 等列入內建白名單，或降級成 info 一行 | `tools/export-game.mjs`、`engine/graze-mask.js`（白名單來源）|
| 7 | 中 | **`pack.mjs import` 保留原始文字**：pack 內既有 `source` 原文，寫檔時優先寫原文（與 encounter 檔一致），避免攻擊 JSON 被重新排版造成整檔 diff | `tools/pack.mjs` |
| 8 | 中 | **`parseArgs` 對未知長旗標警告**；`record.mjs` 增列 `kind`（或明確忽略時印「--kind 不適用」）| `tools/agent/lib.mjs:290-317`、`tools/record/cli.js:13-34` |
| 9 | 中 | **範例選單在 `--works` 模式下失敗要靜音或提示**：`samples/index.json` 的 showcase 攻擊解析不到時不要讓每頁產生 6 個 404；改成「範例不在這個作品根」的單一提示 | `editor/encounter/fileops.js`、`samples/index.json`、`encounter.html` |
| 10 | 中 | **時間軸面板可視高度**：`.enctl-scroll` 至少 240–280px（或 3.5 列），加「可捲動」視覺提示；面板高度記住 | `editor/encounter/v2.css`、`editor/encounter/timeline.js:668` |
| 11 | 中 | **頁內 Export playable HTML 走 Blob 下載**（`URL.createObjectURL` + `a[download]`）並在 headless 下回報實際檔名；或至少 console 印檔名 | `tools/web/export-button.js` |
| 12 | 低 | **`dr_render` 回傳 `actualFrames`**，讓缺幀一眼可見 | `tools/agent/render.mjs` |
| 13 | 低 | **補 `/favicon.ico`**（複製一份 svg→ico 或伺服器 fallback 到 `favicon.svg`）| `serve.py`、`index.html`、`encounter.html`、`play.html`、`encounter-play.html` |
| 14 | 低 | **Demo 區塊預設收合＋記住狀態**；把「產生路徑」放工具列或固定在 Demo 區塊頂端（現在 `Generate path` 在文件 y≈2020，要捲很久；且第一下點標題是「收起來」不是「展開」）| `editor/inspector.js`、`editor/panels.css` |
| 15 | 低 | **時間軸總覽在提前 break 時也回報結果**：`simResult` 不要只依賴 `enc.result`，可用 `enc.phase`／最後一個 `spare`/`enemyRemoved` 事件推導，讓 `result —` 變成 `spared`（並考慮不要提早 break，讓幀數與 `dr_simulate` 對齊）| `editor/encounter/timeline.js:574,816` |
| 16 | 低 | **`tools/record/.tmp` 的 warning 補「（暫存，結束後自動刪除）」** | `tools/record.mjs:409` |
| 17 | 低 | **`bpm` 已設定但 `clear`/`end` 為純秒數時給 info 提示**（不擋）| `engine/attack.js`、`docs/SPEC-EXPR-V2.md` |

---

## 8. 驗證數據（供對照）

### 8.1 驗證與模擬

| 目標 | 指令 | 結果 |
|---|---|---|
| `bell-rain` | `dr_validate` | ok，0 錯 0 警告；240 幀 |
| `tolling-mirrors` | `dr_validate` | ok，0 錯 0 警告；270 幀 |
| `vesper-chorus` | `dr_validate` | ok，0 錯 0 警告；237 幀 |
| `bellwright`（遭遇） | `dr_validate` | ok，0 錯 0 警告 |
| 遭遇 demo | `sim.mjs bellwright --kind encounter --autoplay demo --seed 12` | `spared`、1380 幀、hits 0、grazes 25、TP +100、峰值 32 彈、`perTurn` 518/467/395 幀 |
| demo 事件 | 同上 `events` | turnStart 44 / 518 / 985；attackStart/End 267/507、704/974、1038/1275；mercy 162、241、675；spare 1320 |
| `bell-rain` 難度 | `difficulty.mjs --runs 8 --bot dodge` | easy / passable true / clearRate 0.75 / 中位數受傷 0 / 峰值 27 彈 / 240 幀 |
| `tolling-mirrors` 難度 | `--runs 10 --bot dodge` | normal / passable false / clearRate 0.1 / 中位數受傷 1 / 峰值 21 彈 / 270 幀 |
| `vesper-chorus` 難度 | `--runs 8 --bot dodge` | easy / passable true / clearRate 0.75 / 中位數受傷 0 / 峰值 32 彈 / 237 幀 |
| `bellwright` 整場 | `--runs 8 --bot dodge` | normal / passable false（V3）/ outcome victory 8/8 / 中位數受傷 3 / 傷害固定 17 / 2287 幀 / 76.23s |

### 8.2 匯出

| 目標 | 指令 | 結果 |
|---|---|---|
| 作品包 | `pack.mjs export bellwright --kind encounter` | ok、bytes 53,996、counts encounters 1 / attacks 3、結構 `dr-battle-pack/1` |
| zh HTML | `export-game.mjs bellwright --kind encounter --lang zh --title "Bellwright 鐘匠"` | bytes 10,933,333、modules 32、sprites 49 / frames 298 / audio 14 / fonts 10、0.225s |
| en HTML | 同上 `--lang en` | bytes 8,106,542 |
| zh 驗收 | `edge-acceptance.mjs --expect-result spared --timeout 180000` | pass true、result spared、frame 1380、consoleErrors 0、pageExceptions 0、logErrors 0、networkRequests 343、unexpectedNetwork []、48.2s |
| en 驗收 | 同上 | pass true、frame 1608、consoleErrors 0、55.7s |

### 8.3 錄影

| 項目 | 值 |
|---|---|
| 指令 | `record.mjs bellwright --kind encounter --autoplay demo --lang zh --scale 1 --capture canvas --max-frames 1400 --verify --json` |
| 執行時間 | 22.4s（約 62 幀/秒擷取）|
| mp4 | 4,079,757 B、ffprobe `duration 46.033333`、`h264 640×480 30/1`、`nb_frames 1381`、`bit_rate 709009` |
| 音訊 | `aac 44100 Hz 2ch`；獨立 wav `pcm_s16le 44100 Hz 2ch`、8,120,358 B |
| 驗證 | `--verify` ok（errors/warnings 空）；獨立 `ffprobe -show_entries` 亦通過 |

### 8.4 作品包還原

| 檢查 | 結果 |
|---|---|
| `import --mode abort` 到 `%TEMP%\V2-12\clean` | ok、encounters 1 / attacks 3 |
| encounter 檔 byte 比對 | **完全相同**（20,226 B、LF、無 BOM、sha256 相同）|
| 攻擊檔語意比對 | 相同（parse 後 JSON deep equal），**但排版不同** → byte hash 不同（V6）|
| 從 clean root 再匯出 pack | 去掉 `meta` 後 content hash `b0d35d49ab4a49e9` 與原包相同 |
| clean root 上重跑驗證 | `dr_validate` 4 檔全 ok；`dr_simulate` 結果與原作品根一致（spared、1380 幀、hits 0、TP 100）|
| clean root 編輯器 | `encounter.html?file=bellwright` 正常載入（`shots\13-clean-root-encounter.png`）|

### 8.5 環境衛生（收工檢查）

- `git status --porcelain`：` M battle-editor/docs/ROADMAP-V2.md`（開工前就有的既有修改）、`?? battle-editor/docs/REALTEST-2.md`（本次唯一新增／修改的專案檔）、`?? DeltaruneBossFightSpeedRun.mp4`、`?? Persistent Motif Crescendo Cover.mp3`、`?? 動畫素材/`（使用者原有檔案）。沒有其他變動，未 commit。
- `battle-editor/attacks/`、`battle-editor/encounters/`：皆空（維持原狀）。
- `assets/index.json` sha256 `f0095ffd…39693a`、`assets/.build-assets.manifest.json` sha256 `331d7542…a862d2`：與開工基準相同。
- `tools/record/.tmp/`：存在但已空（gitignored）。
- 自己啟動的 Edge 全部結束（tasklist 無 msedge.exe）；自建的 18931/18932 伺服器已關閉；使用者既有的 18900 未動。
- 未 commit、未遞歸刪除；暫存全部留在 `%TEMP%\V2-12\`。

---

## 9. 測試環境備註

- 自製輔助（不屬於專案，放在 `%TEMP%\V2-12\`，僅為操作便利）：`mcp.mjs`（stdio MCP 客戶端，`node mcp.mjs <tool> '<json>'`）、`edge-drive.mjs`（headless Edge＋CDP 的步驟腳本執行器，只 taskkill 自己啟動的 PID）、`sheet_sprites.py`（雪碧聯絡表）。
- 這三個工具是因為「MCP over stdio 需要客戶端」與「CDP 操作需要按鍵/點擊/截圖」而寫的；如果專案之後想要「agent 友善」，可以考慮把 `edge-drive` 這類能力包成 `tools/agent/ui-drive.mjs`（但本次依規則未改專案檔）。
- 時間軸總覽的截圖用 `body.style.zoom = 0.75` 才塞得下三列（`shots\05-timeline-net.png`、`shots\18-final-timeline.png`）；正常縮放只能看到 T1/T2（`shots\03-timeline.png`、`06-timeline-bottom.png`）。
