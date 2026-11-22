# 交接：百變木偶遭遇製作期間的編輯器修正（2026-11-08）

分支：`claude/admiring-lovelace-f6ca0c`（基於 main `8e1c229`）。製作 Doppeldoll 遭遇時發現並修正的問題，給維護編輯器的會話參考。都是小範圍修改，測試全過（`tests/engine`、`tests/encounter`、`tests/encounter-flow`）。

## 已修正（main 已移植：`1cde648`、`66e5206`）

| # | 檔案 | 問題 | 修正 |
|---|---|---|---|
| 1 | `encounter-play.html` | 試玩頁的 `resolveAttack` 只查 `samples/`，使用者存在 `attacks/` 的攻擊檔一律「找不到攻擊檔」，回合沒有彈幕。編輯器預覽（`editor/encounter/preview.js`）已經會先查 `/api/attacks`，兩邊不一致。 | 候選順序改成 `api/attacks/<n>.json` → `attacks/<n>.json` → `samples/…`，和編輯器預覽一致。 |
| 2 | `tools/agent/sim.mjs` | 遭遇自動操作用 `state.textbox.visible` 判斷文字框，但引擎的 textbox 快照沒有 `visible` 欄位（SPEC-P2 §5 是 `null \| {...}`），所以 turnEnd 等階段的 `say` 永遠沒人按 Z，模擬卡死到幀數上限。 | 改成 `textbox` 非 null 且 `visible !== false` 就算顯示中。 |
| 3 | `tools/agent/render.mjs` | 攻擊模式截圖時，sprite 在第一次繪製才懶載入，tick 完立刻截圖會截到洋紅佔位方塊。 | 每次截圖前等 250ms + 120ms 各重畫一次。 |
| 4 | `engine/encounter/actors.js`、`schema.js`（`normalizeAnim`） | 演員的 `scale` / `flip` 只能整個演員一起設，無法讓同一演員的不同形態用不同像素倍率或朝向（本體 3 倍、偽裝 2 倍；偽裝朝左、特效不翻）。 | 動畫狀態可選填 `scale`（乘上演員 scale）與 `flip`（省略則沿用演員 flip）。向下相容。**編輯器的動畫狀態表（ED3 `actor-editor.js`）尚未加這兩個欄位的 UI**，目前只能直接寫 JSON。 |
| 5 | `engine/audio.js` | BGM 只能整首循環。 | 音訊索引條目可加 `loopStart` / `loopEnd`（秒），WebAudio 依此只循環該段（前奏只播一次）。未標記時行為不變。 |

## 新增（不屬於修正，但會影響建置）

> 2026-11-08 更新：main 的 `build_custom_assets.py` 改成通用掃描器，木偶專用匯入改名為 `tools/content/doppeldoll/import_assets.py`（寫 PNG＋`sprites.json`，再呼叫官方腳本）。下面第一點是舊版說明。

- `tools/build_custom_assets.py`：把 `動畫素材/`、自繪子彈、自訂 BGM 併入 `assets/index.json`（條目帶 `custom: true`，冪等）。**`build_assets.py` 重建索引後要再跑一次**，否則自訂素材會消失。建議之後讓 `build_assets.py` 結尾自動合併 `assets/custom.index.json`。
- `.gitignore` 加了 `assets/custom/`、`assets/custom.index.json`。

## 觀察到、未修正（交給編輯器會話判斷）

> 1–3 已在 main 修正（`66e5206`）；自動演出版本另見文末「第二輪」。

1. **`onHurt` 的 `wait` 之後的指令可能跑不到**：fight 結算對每次命中呼叫 `runner.run(onHurt)`，接下來的流程指令會打斷它；`wait` 之後的 cue 沒執行。我在內容端改成不用 `wait` 避開了。如果這不是刻意設計，建議讓掛鉤指令清單跑完再進下一階段，或在文件註明。
2. **敵人沒有 `hurt` 動畫時退回 `idle`**：對會變形的敵人來說，受擊會閃回 idle 造型。我是在 `onHurt` 裡依變數立刻把動畫設回來。可以考慮受擊時「沿用目前動畫」當作預設。
3. **dodge bot 在遭遇裡明顯比單獨跑攻擊時弱**：同一段攻擊單獨跑 `difficulty` 是 0 傷害，放進遭遇大約每回合吃 3–4 下。可能是遭遇的 `state.battle` 快照缺 `attack`（bot 拿到的是 `{ soul: {...} }` 預設），或缺 bulletTypes／hitbox 資訊。這會讓遭遇的難度評估偏難。
4. **無頭遭遇截圖的前幾秒**：隊伍 sprite 偶爾還是洋紅佔位方塊（遭遇模式靠真實時間前進，沒有攻擊模式那種等待）。後面的幀都正常。
5. **瀏覽器窗格隱藏時遊戲只剩約 5 FPS**（頁面被瀏覽器節流），手動試玩要把窗格顯示出來。

## 第二輪：改用自動演出版編輯器（main `0176b4d`）時的觀察（皆未修改編輯器）

1. **自訂 BGM 進不了官方管線**：`build_custom_assets.py` 輸出 `"audio": {}`，`build_assets.py` 的 `merge_custom_index()` 雖然會併 `audio`，但沒有東西可併。所以自訂音樂（含 `loopStart/loopEnd`）只能靠 `import_assets.py` 事後補寫。建議：掃描 `assets/custom/music/*.ogg`，或讓 `sprites.json` 旁邊多一個 `audio` 區段。
2. **`build_custom_assets.py` 的 tag 白名單**會對 `puppet`、`susie` 這類自訂 tag 發警告（不影響使用），已改成只用白名單內的 tag。
3. **路徑跟隨器追不上 bot 軌跡**：直接把閃避 AI 的逐幀軌跡當 `demo.path`（甚至每幀一點）仍會中彈，偏差最多約 16–20px（死區 + 8 方向移動 + 框旋轉/靈魂瞬移）。這不是 bug，但代表「錄 AI 軌跡轉路徑」不可行；改用在迴圈裡實跑跟隨器的束搜尋（`make_demo_paths.mjs`）。若編輯器想提供「自動產生路徑」按鈕，可參考這個做法。
4. **`render.mjs` 遭遇模式的幀號會漂移**：要求 `--frames 60` 實際截到 f=86、`2780` 截到 3046（結局後）。截圖時以輸出列出的實際幀號為準。
5. `demo_trace.mjs` 用 `createAutopilot` 時必須先 `await pilot.ready`（遭遇 pilot 動態載入），否則 `input()` 一直回中性輸入、遊戲停在第一個文字框，且**不會有任何警告**。SPEC-AUTOPLAY §3 的範例沒提這點，建議補在文件裡或讓 `input()` 在未就緒時記一筆 warning。

## 第三輪：用 v2 編輯器重製（ENCORE，main `c3903b7`）時的觀察（皆未修改編輯器）

用到的 v2 功能都能正常工作：作品根 `--works`、自訂音訊 `audio.json`、拍點 `"2b"`、`spawnX/spawnY`、`memory`、`actor.forms` + `form` 指令、`attack` 指令串接、`demo-path.mjs`、遭遇事件流、`difficulty.mjs`、`export-game.mjs`、`record.mjs`。

1. **`tools/check-encounters.mjs` 不認得 `form` 指令**：合法指令清單是寫死的，連官方範例 `samples/encounters/forms-demo.json` 都會報「未知的指令 "form"」。引擎與 `sim.mjs` 沒問題，只有這支檢查工具落後。
2. **`demo-path.mjs` 產生的路線淨空很小**（`minClearance` 約 1px）：0 受傷沒錯，但畫面上像是擦著子彈走。建議加 `--min-clearance N`（或在評分裡加淨空權重），演示會好看很多；另外寫回的 `fallback` 是 `"stay"`，建議預設 `"bot"`。
3. **`difficulty.mjs` 的 bot 是決定性的**：20 個種子在 `dd-marionette` 上受傷位置完全相同（20 次都剛好 1 hit），所以「零傷率 0% → 不可通過」其實只代表「這一條 bot 路線過不了」，而 `demo-path` 同時找得到 0 受傷路線。建議讓種子真的影響 bot（例如決策加微小擾動），或在報告裡註明。
4. **遭遇 demo 的回合數上限**：`demo.turns[].turn` 不能超過 `turns` 長度，`loop-last` 重複的回合只能靠 `default`。這次用多加一個「安可」回合解決；若能寫 `turn: "loop"` 或允許超過會更直覺。
5. **`turn.start` 在選單之前執行**：想做「選單 → 換裝 → 彈幕」只能把換裝放在 `end` 的 `attack` 指令串裡，或像這次讓木偶在選單前就換好。若回合能有一個「攻擊前」指令清單（talk 之後、attack 之前）會更好排演出。
6. 0 傷害的裝飾子彈（提線、剪刀）目前靠「放在框外＋`damage: 0`＋`grazeable: false`」實現；建議 bulletType 加 `decor: true`（不判定、不擦彈、不計入 bot 威脅與子彈密度統計）。
7. **`tools/record.mjs` 長片混音失敗**：錄整場遭遇（4452 幀、約 148 秒）時 `混音失敗：無法執行 ffmpeg：spawn ENAMETOOLONG`（`tools/record/media.js:122`）。音訊事件太多（打字音、選單音…），ffmpeg 命令列超過 Windows 長度上限。畫面部分沒問題（`--no-audio` 可錄完，ffprobe 驗證 OK）。這次的 MP4 是無聲版再手動用 ffmpeg 疊上 BGM（依 loop 點接合），**沒有音效**。建議把 filter graph 寫進檔案改用 `-filter_complex_script`（或 `-/filter_complex`），或分批混音。
8. `export-game.mjs` 匯出的遭遇 HTML 是 12.7 MB（文件寫 5–8 MB）：自訂 BGM 3.5 MB 加上 84 個木偶 sprite。可接受，僅記錄。

> 2026-11-10 更新：第三輪 1–7 已在 main 處理（RT3-FIX `57506aa`、`3c9ee71`）。作品已改用 `decor: true`、`beforeAttack`、`--min-clearance 6`，並依新慣例把隊員的 spare / defend / down / victory 動畫改成不循環。
