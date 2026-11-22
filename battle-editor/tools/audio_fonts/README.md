# A2 — 音效 / 音樂 / 字體擷取

從官方 DELTARUNE 資料擷取戰鬥編輯器所需的音樂、音效與點陣字體。
全部腳本可重跑（冪等），入口是 `extract_all.py`。

## 快速開始

```powershell
# 專案根：DeltaruneWorks
python battle-editor\tools\audio_fonts\extract_all.py            # 增量（安全重跑）
python battle-editor\tools\audio_fonts\extract_all.py --force    # 全部重做
python battle-editor\tools\audio_fonts\extract_all.py --only sfx,index
```

前置條件（缺一會直接報錯並說明怎麼補）：

| 路徑 | 內容 | 來源 zip |
| --- | --- | --- |
| `assets-official/02-audio/DELTARUNE/` | `mus/*.ogg`、`chapterN_windows/data.win`、`chapterN_windows/audiogroup1.dat` | `DELTARUNE_官方音效音乐与对白文本.zip` |
| `tools-external/utmt/` | `UndertaleModCli.exe`（self-contained，附 .NET runtime） | `DELTARUNE_解包工具_UTMT-CLI_0.9.2.0.zip` |
| `assets-official/03-zh-fonts/` | `DTM.otf`、`游戏内位图字体/{main,chapter1..5}/*.png+csv` | `DELTARUNE_V260809_中文字体.zip` |

三個目錄都不進 git（根 `.gitignore` 已忽略）。中文字體包若不存在，`extract_zh_fonts.py`
會自動從專案根的 zip 解壓；連 zip 都沒有時只跳過 `zh` 階段（其餘照常）。

## 產出

```
battle-editor/assets/
  audio/mus/<曲名>.ogg          60 首戰鬥曲（67.0MB）
  audio/snd/<snd_名>.wav|.ogg  206 個音效（25.5MB，5 個 ogg + 201 個 wav）
  fonts/<字體名>/glyphs.png     字形貼圖（英文/官方點陣，14 組）
  fonts/<字體名>/glyphs.json    字形表
  fonts/<字體名>/meta.txt       摘要
  fonts/<字體名>@zh/glyphs.png  中文字形貼圖（簡體補丁點陣字庫，7 組）
  fonts/<字體名>@zh/glyphs.json 中文字形表（3,580 glyph／3,272 漢字）
  fonts/DTM.otf                 中文 OTF 退回字體（4.2MB，27,484 漢字映射）
  audio-fonts.index.json        索引（W2 併入 assets/index.json 用）
```

`audio-fonts.index.json` 格式 `dr-battle-assets-audio/1`，路徑一律相對 `assets/`：

```jsonc
{
  "format": "dr-battle-assets-audio/1",
  "audio": {
    "snd_hurt1":  { "file": "audio/snd/snd_hurt1.wav", "kind": "sfx",
                    "chapter": "ch5", "src": "audiogroup1",
                    "groups": ["hurt"], "desc": "遊玩者受傷", "bytes": 52412 },
    "battle":     { "file": "audio/mus/battle.ogg", "kind": "music",
                    "loop": true, "tags": ["battle"], "bytes": 1835051 }
  },
  "fonts": {
    "fnt_main":   { "image": "fonts/fnt_main/glyphs.png",
                    "glyphs": "fonts/fnt_main/glyphs.json",
                    "size": 12, "lineHeight": 16, "emSize": 12,
                    "glyphCount": 96, "imageW": 128, "imageH": 128,
                    "sourceFont": "fnt_main", "chapter": "ch5",
                    "bold": false, "italic": false,
                    "cjk": { "sample": 450, "hit": 0, "pct": 0.0 } }
  },
  "groups": { "hurt": ["snd_hurt1", "..."], "graze": ["snd_graze", "..."] },
  "meta": { "...": "統計與注意事項" }
}
```

音效分組（`groups`，方便引擎按用途挑選）：

| 群組 | 數量 | 用途 |
| --- | --- | --- |
| `hurt` | 26 | 受傷 / 敵人受傷 / 死亡 / 擊破 |
| `graze` | 2 | 擦彈 |
| `menu` | 21 | 選單移動 / 選擇 / 取消 / 錯誤 / 回合流程 |
| `heal` | 14 | 回復 / 復活 / 治療法術 / 安撫 |
| `tp` | 8 | TP / 張力 |
| `bullet` | 43 | 子彈發射 / 爆炸 / 衝擊波 |
| `clear` | 7 | 清除子彈 / 抹除 / 清場 |
| `soul` | 6 | 靈魂破碎 / 遊戲結束 |
| `swing` | 35 | 揮擊 / 近戰 |
| `move` | 17 | 移動 / 跳躍 / 閃避 / 防禦 |
| `impact` | 19 | 撞擊 / 震動 / 環境雜訊 |
| `flow` | 8 | 戰鬥流程 / 登場退場 / 逃走 |

## 字體格式（給 W1 / W2 的重要提醒）

`glyphs.png` 是 **RGBA，RGB 全白、字形只存在於 alpha 通道**。直接開圖會是空白，
必須把 alpha 當遮罩（例：先畫黑底再 `globalCompositeOperation = 'source-over'`
疊上白字，或用 `alpha: true` 的 sprite 只取 alpha）。這是 GMS 字體貼圖的原生格式。

`glyphs.json` 格式 `dr-battle-font/1`：

```jsonc
{
  "format": "dr-battle-font/1",
  "name": "fnt_main", "sourceFont": "fnt_main", "chapter": "ch5",
  "size": 12, "emSize": 12, "lineHeight": 16, "lineHeightRaw": 0,
  "ascender": 0, "ascenderOffset": 0, "scaleX": 1, "scaleY": 1,
  "bold": false, "italic": false, "antiAliasing": 0,
  "rangeStart": 32, "rangeEnd": 127,
  "maxGlyphWidth": 8, "maxGlyphHeight": 16,
  "image": { "file": "glyphs.png", "w": 128, "h": 128, "scaleX": 1, "scaleY": 1 },
  "glyphCount": 96,
  "glyphs": {
    "65": { "char": "A", "x": 2, "y": 36, "w": 6, "h": 13,
            "shift": 7, "offset": 0 }
  }
}
```

繪製規則（與 GMS 的 `draw_text` 一致）：

- 以碼位為 key（字串化的整數）取 glyph。
- 貼圖來源矩形 = `(x, y, w, h)`，目標位置 = 游標的 `(cx, cy + offset)`。
- 游標前進 `shift` 像素；換行用 `lineHeight`。
- `kerning` 若存在（少數字體）是 `[下一字元碼位, 位移修正]` 的陣列，套用在下一個字元前。
- `x/y/w/h` 已經是**相對於 `glyphs.png` 左上角**的像素座標，直接用，不要再加減任何原點。

字體清單：

| 輸出目錄 | 來源 | 章節 | glyph | em | lineHeight | 繁中覆蓋 |
| --- | --- | --- | --- | --- | --- | --- |
| `fnt_main` | fnt_main | ch5 | 96 | 12 | 16 | 0% |
| `fnt_mainbig` | fnt_mainbig | ch5 | 96 | 24 | 32 | 0% |
| `fnt_small` | fnt_small | ch5 | 96 | 6 | 7 | 0% |
| `fnt_tinynoelle` | fnt_tinynoelle | ch5 | 96 | 7 | 9 | 0% |
| `fnt_8bit` | fnt_8bit | ch5 | 96 | 12 | 16 | 0% |
| `fnt_dotumche` | fnt_dotumche | ch5 | 96 | 12 | 16 | 0% |
| `fnt_comicsans` | fnt_comicsans | ch5 | 96 | 10 | 20 | 0% |
| `fnt_ja_8bit` | fnt_ja_8bit | ch5 | 1819 | 16 | 15 | **64.4%** |
| `fnt_legend` | fnt_legend | ch4 | 96 | 12 | 16 | 0% |
| `fnt_main_wide` | fnt_main | ch1 | 2532 | 12 | 17 | 57.3% |
| `fnt_mainbig_wide` | fnt_mainbig | ch1 | 2532 | 24 | 32 | 57.3% |
| `fnt_comicsans_wide` | fnt_comicsans | ch1 | 2532 | 10 | 20 | 57.3% |
| `fnt_tinynoelle_wide` | fnt_tinynoelle | ch1 | 2518 | 7 | 11 | 57.3% |
| `fnt_dotumche_wide` | fnt_dotumche | ch1 | 2533 | 12 | 16 | 57.3% |

以上是**官方遊戲原生字體**，只有拉丁字集（`fnt_ja_*` 是日文）。中文請用下一節的 `@zh`。

## 中文字體（`@zh` 與 DTM.otf，簡體補丁 V260809）

來源是簡體中文補丁的點陣字庫：每個字體有 3,580 個字形（含 3,272 個漢字），
尺寸與官方版本相同，但字集從 96 個 ASCII 擴充到漢字。

| 輸出目錄 | 對應英文 | 章節 | glyph | 漢字 | em | lineHeight |
| --- | --- | --- | --- | --- | --- | --- |
| `fnt_main@zh` | fnt_main | chapter5 | 3580 | 3272 | 12 | 16 |
| `fnt_mainbig@zh` | fnt_mainbig | chapter5 | 3580 | 3272 | 24 | 32 |
| `fnt_comicsans@zh` | fnt_comicsans | chapter5 | 3580 | 3272 | 10 | 20 |
| `fnt_dotumche@zh` | fnt_dotumche | chapter5 | 3580 | 3272 | 12 | 16 |
| `fnt_tinynoelle@zh` | fnt_tinynoelle | chapter5 | 3580 | 3272 | 7 | 9 |
| `fnt_8bit@zh` | fnt_8bit | chapter5 | 3580 | 3272 | 12 | 16 |
| `fnt_legend@zh` | fnt_legend | chapter4 | 3580 | 3272 | 12 | 16 |

`lineHeight` 一律沿用對應英文點陣字體的值（中文補丁只換字形不換字體資源），
所以 `lang` 切換時行距完全一致。少數字體的漢字會略超出 lineHeight
（英文版也一樣，例如 `fnt_8bit` 英文下緣 22／lineHeight 16），
另外提供 `lineHeightP95` / `lineHeightP99` / `lineHeightMax` 三個欄位，
引擎若發現擁擠可自行改用較大值。

另外 `fonts/DTM.otf`（Determination Sans SimSun Regular，4.2MB）是退回用的 OTF：
點陣字庫缺字時用 `FontFace` 載入後 `fillText`。cmap 實測 28,652 個碼位、
CJK 漢字 20,902 個，GB2312 一級（3,755）與 Big5 常用（5,401）**都是 100% 覆蓋**，
所以 @zh 點陣缺字一定有 OTF 可接。

格式與英文字體完全相同（`dr-battle-font/1`），只多了 `lang:"zh"`、`base:"fnt_main"`、
`patch`、`coordinateNote` 等描述欄位。**座標同樣是 PNG 內左上角像素、scale=1，直接用。**
PNG 也一樣是 alpha-only，但來源圖的 RGB 是「字形白 / 透明黑」，腳本已統一改成 RGB 全白。

### 覆蓋率（實測，`verify.py` 會印）

以 `fnt_main@zh` 為代表（七個 @zh 字體字集完全相同）：

| 字集 | 樣本 | 命中 | 覆蓋率 |
| --- | --- | --- | --- |
| GB2312 一級漢字（簡體常用） | 3,755 | 2,921 | **77.8%** |
| Big5 常用字（繁體） | 5,401 | 2,091 | 38.7% |
| SPEC.md 非 ASCII 字元 | 514 | 325 | 63.2% |
| 戰鬥 UI 實用字（戰鬥/擦弹/暂停/继续/最大/倒下/未命中/被击中…） | 26 | 26 | **100%** |
| DTM.otf（同兩組字集） | 3,755 / 5,401 | 全中 | **100% / 100%** |

**戰鬥畫面用字全部命中**（實測 `render.js` 的 `LANG_STRINGS.zh` 26 個 CJK 字元：0 缺）。
缺的是較偏的 GB2312 一級字尾段（癌、蔼、隘、鞍、氨、胺、敖、懊、澳、捌、笆、跋、耙、坝…）
與多數繁體字——這類字會退回 DTM.otf（覆蓋 100%）或系統字體。


## 目錄結構

```
tools/audio_fonts/
  extract_all.py        入口（冪等）
  common.py             共用路徑與 UTMT 呼叫
  catalog.py            掃各章 data.win 的 Sound/Font → catalog/
  extract_music.py      mus/*.ogg → assets/audio/mus/
  extract_sfx.py        snd_* → assets/audio/snd/
  extract_fonts.py      官方字體 → assets/fonts/
  extract_zh_fonts.py   中文字體包 → assets/fonts/*@zh/ + DTM.otf
  build_index.py        → assets/audio-fonts.index.json
  verify.py             驗證 index 與實體檔案是否自洽（含繁/簡覆蓋率）
  config/
    music_rules.json    曲目規則（files/patterns/exclude/tags/loopFalse）
    sfx_rules.json      音效規則（groups/core/purposeOverrides）
    fonts_rules.json    字體規則（name+chapter → 輸出目錄）
    zh_fonts_rules.json 中文字體規則（zip 名、章節優先序、輸出目錄、OTF、覆蓋率字集）
  utmt/
    probe.csx           列資源（唯讀）
    dump_sounds.csx     匯出音效
    export_fonts.csx    匯出字體
    _cjk_coverage.csx   繁中覆蓋率分析（開發用）
  catalog/              中繼產物：各章 probe、可用性表、名稱聯集、清理清單
  SFX_TABLE.md          206 個音效的「名稱 → 用途 → 章節 → 來源部位」對照表
  manifest_music.json   音樂 manifest（build_index 的輸入）
  manifest_sfx.json     音效 manifest
  manifest_fonts.json   官方字體 manifest
  manifest_zh_fonts.json 中文字體 manifest（含繁/簡/SPEC 覆蓋率）
```

## 驗證

```powershell
python battle-editor\tools\audio_fonts\verify.py    # 退出碼 0 = 全部通過
```

檢查：index 格式、每個檔案存在且大小相符、wav/ogg 可解析、PNG 尺寸與宣告一致、
所有字形落在貼圖範圍內、SPEC 要求的關鍵音效類別齊全、`core`/`groups` 名稱都存在。
中文字體另外檢查：`lang:"zh"`、漢字數 ≥ 3000、PNG 與 JSON 尺寸一致、RGB 全白（alpha-only）、
字形在圖內、index 宣告的覆蓋率與實測一致，並印出 GB2312 一級（簡體常用）與
Big5 常用（繁體）兩組覆蓋率。

## 修改擷取範圍

改 `config/*.json` 後重跑 `extract_all.py --force`（或對應階段）。
`config/sfx_rules.json` 的 `purposeOverrides` 會直接寫進 index 的 `desc` 欄位。

中文字體：`config/zh_fonts_rules.json` 的 `chapterOrder` 決定「同名字體取哪一章」
（預設 `chapter5 > chapter4 > chapter3 > chapter2 > chapter1 > main`，實測 chapter5 與
chapter1/main 的圖集與 CSV 內容完全相同，所以取哪一章結果一樣）。
`fonts` 陣列決定輸出哪些 `@zh` 目錄；`otf` 段決定 DTM.otf 的來源與描述。

## UTMT 已知雷點（改腳本前先讀）

1. exe 直接從 PowerShell 呼叫會炸 `System.IO.IOException: The handle is invalid`
   （無 console handle）。本專案改用 `subprocess.run(capture_output=True)` 就正常；
   手動測試時要 `cmd /c "... > log 2>&1"` 重導向。
2. `-s` 的 `.csx` 路徑**必須是絕對路徑**，相對路徑會 `FileNotFoundException`。
3. `font.LineHeight` / `font.Ascender` 是 `UInt32`，`Glyph.Shift/Offset` 是 `Int16`，
   直接賦給 `int` 會編譯失敗（CS0266）。
4. DELTARUNE 的 `font.LineHeight` 幾乎都是 0，`lineHeight` 是腳本用字形下緣
   （`SourceHeight - Offset`）推算的；`lineHeightRaw` 保留原值供比對。
5. 音效可能在三個地方：data.win 內嵌（`sound.AudioFile`）、`audiogroupN.dat`
   （用 `sound.GroupID` + `sound.AudioID` 索引）、或外部 `.ogg`（`sound.File`）。
   `dump_sounds.csx` 依序嘗試，並依檔頭魔數決定 `.wav` / `.ogg` 副檔名。
