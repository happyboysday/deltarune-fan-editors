/**
 * tools/record.mjs — 離線逐幀錄影（V2-11）
 *
 * 為什麼要離線錄：頁內 MediaRecorder（V2-10）錄的是「真實時間」的 WebM —— 掉幀、
 * 幀時間不均、headless 還會被節流。這支工具改成：
 *   1. headless Edge 開 play.html / encounter-play.html（--mute-audio，rAF 凍結）
 *   2. 每帧呼叫一次頁面把手（tick(1) + 等素材 whenIdle + 重畫 + canvas.toDataURL）
 *      → 保證「第 N 張 PNG 就是引擎第 N 幀」，不掉幀也不重複
 *   3. 錄影期間開啟 engine/audio.js 的事件記錄（window.__drAudioLog），
 *      把 BGM／音效事件（含遊戲幀號）帶回來
 *   4. Node 端用 ffmpeg 依事件表把 assets 內音檔混成 WAV（BGM 依 loopStart/loopEnd
 *      循環、音效疊到對應時間），再與 PNG 序列合成 H.264 yuv420p + AAC 的 MP4
 *
 * 只用 Node 標準庫（零 npm 依賴），Edge / ffmpeg 都是外部程式：
 *   - 找不到 Edge → 明確報錯（可用 MSEDGE_PATH 指定）
 *   - 找不到 ffmpeg → 明確報錯，並說明 --png-dir（PNG 序列 + 音訊事件表）仍可用
 *
 * 相關檔案：
 *   tools/record/cli.js     參數解析 / 用法（純函式，測試用）
 *   tools/record/audio.js   事件表 → 混音計畫（純函式，測試用）
 *   tools/record/media.js   ffmpeg / ffprobe / 音檔抓取（測試用）
 *   docs/RECORD.md          使用說明與輸出規格
 */

import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { stageOutput } from './file-output.mjs';

import {
  BATTLE_EDITOR,
  WORKS_DIR,
  applyCliPaths,
  cliEntry,
  isFile,
  numArg,
  parseArgs,
  readJSON,
  resolveInputFile,
  toPosix,
} from './agent/lib.mjs';
import { detectKind } from './agent/sim.mjs';
import { buildPageUrl, launchEdge, startServer } from './agent/render.mjs';
import {
  AUDIO_DEFAULTS,
  buildMixPlan,
  buildMp4Command,
  buildWavCommand,
  collectAudioFiles,
  dedupeSfx,
  planBgmSegments,
  planDuration,
  planSfxEvents,
  pngName,
  pngPatternFor,
  outputSize,
} from './record/audio.js';
import {
  NO_FFMPEG,
  NO_FFPROBE,
  checkVideoProbe,
  probeMedia,
  requireFfmpeg,
  runFfmpeg,
} from './record/media.js';
import { BOOLEAN_FLAGS, RECORD_FPS, USAGE, VALUE_FLAGS, parseRecordArgs, validateRecordOptions } from './record/cli.js';

/* ---------------------------------------------------------------- 常數 */

/** 暫存根目錄（依派工規則：暫存一律放 %TEMP%\V2-11\）。 */
export function tempRoot() {
  return join(tmpdir(), 'V2-11');
}

/** 連線頁面用的 preload 腳本：凍結 rAF + 建立音訊事件記錄器。 */
const PRELOAD_SCRIPT = `(() => {
  // 1) 凍結 rAF：頁面的即時迴圈永不執行，唯一的步進來源是 __drPlay.tick / __drEncounterPlay.tick
  window.__drRafQueue = [];
  window.requestAnimationFrame = (cb) => { window.__drRafQueue.push(cb); return window.__drRafQueue.length; };
  window.cancelAnimationFrame = () => {};

  // 2) 音訊事件記錄器（engine/audio.js 的 eventLogSink 會沿用這個物件，只補方法）
  //    錄影工具在每一幀推進前呼叫 setFrame()，事件就帶得到正確的遊戲幀號。
  const sink = {
    version: 1,
    active: true,
    fps: 30,
    frame: 0,
    dropped: 0,
    maxEvents: 400000,
    startedAt: Date.now(),
    stoppedAt: 0,
    events: [],
    start(options) {
      const o = options && typeof options === 'object' ? options : {};
      const fps = Number(o.fps);
      this.fps = Number.isFinite(fps) && fps > 0 ? fps : this.fps || 30;
      this.events.length = 0;
      this.frame = 0;
      this.dropped = 0;
      this.startedAt = Date.now();
      this.stoppedAt = 0;
      this.active = true;
      return { fps: this.fps, active: true };
    },
    stop() {
      this.active = false;
      this.stoppedAt = Date.now();
      return this.get();
    },
    clear() {
      this.events.length = 0;
      this.dropped = 0;
      this.frame = 0;
      return true;
    },
    setFrame(frame) {
      const n = Number(frame);
      if (Number.isFinite(n) && n >= 0) this.frame = Math.round(n);
      return this.frame;
    },
    get() {
      return {
        version: 1,
        fps: this.fps,
        frames: this.frame,
        active: this.active,
        dropped: this.dropped,
        startedAt: this.startedAt,
        stoppedAt: this.stoppedAt,
        events: this.events.slice(),
      };
    },
  };
  window.__drAudioLog = sink;
  window.__drRecordReady = true;
})();`;

/**
 * 每幀一次的頁面腳本：設事件幀號 → 推進 1 幀 → 等素材 → 重畫 → 取 PNG。
 * 一次 CDP evaluate 做完（awaitPromise），比「先 tick 再截圖再問狀態」少兩趟往返，
 * 而且順序完全確定（不會有非同步的畫面插進來）。
 */
function frameScript(steps, frameIndex, withPng = true, lang = 'zh') {
  return `(async () => {
    const steps = ${Math.round(steps)};
    const frameIndex = ${Math.round(frameIndex)};
    const lang = ${JSON.stringify(lang === 'en' ? 'en' : 'zh')};
    const H = window.__drPlay || window.__drEncounterPlay;
    if (!H) return { error: '頁面把手不存在（__drPlay / __drEncounterPlay）' };
    const kind = window.__drPlay ? 'attack' : 'encounter';

    // 事件記錄器的幀號 = 這次要產生的那一幀（推進時播的聲音屬於新幀）
    const log = window.__drAudioLog;
    if (log) {
      if (typeof log.setFrame === 'function') log.setFrame(frameIndex);
      else log.frame = frameIndex;
    }

    if (steps > 0 && typeof H.tick === 'function') {
      for (let i = 0; i < steps; i += 1) H.tick(1);
    }

    // 精靈圖是第一次繪製才懶載入 → 反覆「重畫 + 等素材」直到沒有待載入項目，
    // 再重畫一次把剛載完的圖畫上去（只等一次會把洋紅佔位錄進影片）。
    let idle = null;
    let pending = 0;
    try {
      const assets = typeof H.assets === 'function' ? H.assets() : null;
      const canWait = assets && typeof assets.whenIdle === 'function';
      /**
       * 重畫目前這一幀。
       * 遭遇頁的引擎 FCC 自己持有 rAF 並主動呼叫 renderer.draw()，但在 rAF 被凍結後
       * 引擎不會再自己畫 → 這裡要照 tools/agent/render.mjs 的做法：先 H.draw()
       * （HUD／狀態列），再明確呼叫 renderer.draw(state, {...})，否則會錄到
       * 「上一個場景」的殘影（換場景／換回合時特別明顯）。
       */
      const redraw = () => {
        try {
          if (typeof H.draw === 'function') H.draw();
        } catch (_err) {
          /* 頁面自己的 draw 失敗不影響（引擎通常已畫好） */
        }
        if (kind !== 'encounter') return;
        try {
          const state = typeof H.getState === 'function' ? H.getState() : null;
          const renderer = typeof H.renderer === 'function' ? H.renderer() : null;
          const scale = typeof H.scale === 'function' ? H.scale() : 1;
          const background = typeof H.background === 'function' ? H.background() : null;
          if (state && renderer && typeof renderer.draw === 'function') {
            renderer.draw(state, { showHitboxes: false, scale, lang, background });
          }
        } catch (_err) {
          /* 重畫失敗就照引擎最後畫的畫面 */
        }
      };
      if (canWait) {
        const pendingCount = () => {
          try {
            return typeof assets.pendingCount === 'function' ? Math.max(0, Number(assets.pendingCount()) || 0) : 0;
          } catch (_err) {
            return 0;
          }
        };
        let imagesLoaded = false;
        for (let pass = 0; pass < 4; pass += 1) {
          redraw();
          imagesLoaded = false;
          if (pendingCount() === 0) break;
          let r = null;
          try {
            r = await assets.whenIdle({ timeoutMs: 4000 });
            imagesLoaded = true;
          } catch (_err) {
            r = null;
          }
          pending = pendingCount();
          idle = { idle: !(r && r.timedOut), timedOut: !!(r && r.timedOut), pending, passes: pass + 1 };
          if (r && r.timedOut) break;
          if (pending === 0) break;
        }
        // 最後一次重畫：把這輪才載完的圖實際畫上去
        if (imagesLoaded) redraw();
        const after = pendingCount();
        if (after > 0) {
          // 重畫又觸發了新一輪載入（少見：換場景才會）→ 再等一次
          try {
            await assets.whenIdle({ timeoutMs: 3000 });
          } catch (_err) {
            /* 逾時就照目前的畫面錄 */
          }
          redraw();
          idle = { idle: false, timedOut: true, pending: Math.max(0, pendingCount()) };
        } else {
          idle = { idle: true, timedOut: false, pending: 0 };
        }
      } else {
        redraw();
        idle = { idle: true, timedOut: false, pending: null, unsupported: true };
      }
    } catch (err) {
      idle = { idle: true, timedOut: false, pending: null, error: String(err && err.message ? err.message : err) };
    }

    const state = typeof H.getState === 'function' ? H.getState() : null;
    const canvas = document.querySelector('canvas');
    if (!canvas) return { error: '找不到 canvas' };
    const rect = canvas.getBoundingClientRect();
    return {
      kind,
      png: ${withPng ? "canvas.toDataURL('image/png')" : 'null'},
      clip: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
      width: canvas.width,
      height: canvas.height,
      frame: state && typeof state.frame === 'number' ? state.frame : null,
      ended: !!(state && state.ended),
      result: state && typeof state.result === 'string' ? state.result : null,
      phase: state && state.phase ? String(state.phase) : null,
      bullets: state && Array.isArray(state.bullets) ? state.bullets.length : state && state.battle && Array.isArray(state.battle.bullets) ? state.battle.bullets.length : null,
      idle,
    };
  })()`;
}

/** 等待頁面就緒（頁面把手出現 + 引擎有狀態）。 */
const READY_EXPR_BY_KIND = {
  attack: '!!(window.__drPlay && typeof window.__drPlay.getState === "function" && window.__drPlay.getState())',
  encounter:
    '!!(window.__drEncounterPlay && typeof window.__drEncounterPlay.getState === "function" && window.__drEncounterPlay.getState())',
};

const AUTOPLAY_READY_BY_KIND = {
  attack: '!!(window.__drPlay && window.__drPlay.autoplay && window.__drPlay.autoplay.get() !== "off")',
  encounter:
    '!!(window.__drEncounterPlay && window.__drEncounterPlay.autoplay && window.__drEncounterPlay.autoplay.get() !== "off")',
};

/* ------------------------------------------------------------ 小工具 */

function sleep(ms) {
  return new Promise((done) => setTimeout(done, ms));
}

async function waitFor(check, { timeoutMs = 30000, intervalMs = 100, label = '條件' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`等待${label}逾時（${Math.round(timeoutMs / 1000)} 秒）${lastError ? `：${lastError.message}` : ''}`);
}

/** 從作品 JSON 取名（meta.name 可能是字串或 {zh,en}）。 */
function targetName(json) {
  const meta = json && json.meta;
  if (meta && typeof meta === 'object') {
    if (typeof meta.name === 'string' && meta.name) return meta.name;
    if (meta.name && typeof meta.name === 'object') return meta.name.zh || meta.name.en || 'record';
    if (typeof meta.title === 'string' && meta.title) return meta.title;
  }
  return 'record';
}

function safeName(text) {
  return String(text).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 48) || 'record';
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 把 JSON 落成「伺服器取用得到的相對路徑」（tools/record/.tmp/ 在程式根內）。 */
function materializeJson(json, tmpDir) {
  mkdirSync(tmpDir, { recursive: true });
  const name = `record-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;
  const file = join(tmpDir, name);
  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  return file;
}

/** 檔案相對程式根的 POSIX 路徑（serve.py 的靜態根就是程式根）。 */
function relToRoot(file) {
  return toPosix(relative(BATTLE_EDITOR, resolve(file)));
}

/** 只在「單一檔案」上刪除（不遞歸；派工規則禁止遞歸刪除）。 */
function removeFile(file) {
  try {
    if (file && existsSync(file) && statSync(file).isFile()) rmSync(file, { force: true });
  } catch (_err) {
    /* 刪不掉就留著（在 TEMP） */
  }
}

/** 刪掉自己建立的 PNG（逐檔 unlink；不用任何遞歸刪除）。 */
function removeFrameFiles(files) {
  for (const file of Array.isArray(files) ? files : []) removeFile(file);
}

/* -------------------------------------------------------- 錄影主流程 */

/**
 * 錄一個作品。這是 CLI 與 MCP `dr_record` 共用的入口。
 *
 * @param {string|object} target 檔案路徑／作品名，或直接給 JSON 物件
 * @param {object} [options] 見 parseRecordArgs 的回傳
 * @returns {Promise<object>} 錄影結果摘要（frames、輸出檔、ffprobe 驗證、速度…）
 */
export async function recordTarget(target, options = {}) {
  const warnings = [];
  const startedAt = Date.now();

  /* ---------------------------- 1) 目標檔 / 類型 ---------------------------- */
  let json = null;
  let sourceFile = null;
  if (target && typeof target === 'object') {
    json = target;
  } else if (typeof target === 'string' && target) {
    sourceFile = resolveInputFile(target);
    if (!sourceFile) throw new Error(`找不到作品檔：${target}`);
    json = readJSON(sourceFile);
  } else {
    throw new Error('需要作品檔路徑或 JSON 物件');
  }
  const kind = detectKind(json);
  if (options.kind && options.kind !== kind) {
    warnings.push(`--kind ${options.kind} 與作品實際類型不符：這個檔案是 ${kind}（錄影一律依檔案內容自動判定，已忽略 --kind）`);
  }
  if (kind !== 'attack' && kind !== 'encounter') {
    throw new Error(`無法判斷作品類型（attack / encounter）：${sourceFile || '(doc)'}`);
  }

  const scale = Math.max(1, Math.min(3, Math.round(numArg(options.scale, 2))));
  const lang = options.lang === 'en' ? 'en' : 'zh';
  const autoplay = options.autoplay === 'demo' || options.autoplay === 'bot' ? options.autoplay : null;
  const maxFrames = Math.max(1, Math.round(numArg(options.maxFrames, kind === 'encounter' ? 3600 : 900)));
  const preset = typeof options.preset === 'string' && options.preset ? options.preset : 'medium';
  const crf = Math.max(0, Math.min(51, Math.round(numArg(options.crf, 18))));
  const outFile = options.out ? resolve(process.cwd(), String(options.out)) : null;
  const pngDir = options.pngDir ? resolve(process.cwd(), String(options.pngDir)) : null;
  const wavFile = options.wav ? resolve(process.cwd(), String(options.wav)) : null;
  if (wavFile && options.noAudio === true) throw new Error('--wav 不能與 --no-audio 同時使用');
  if (pngDir && existsSync(pngDir)) {
    const occupied = readdirSync(pngDir).find((name) => /^(f\d{4,}\.png|audio-events\.json)$/i.test(name));
    if (occupied) throw new Error('--png-dir 已有錄影輸出：' + join(pngDir, occupied));
  }
  const ffmpegTools = outFile || wavFile
    ? requireFfmpeg({ ffmpeg: options.ffmpeg, ffprobe: options.ffprobe })
    : null;
  const wantAudio = options.noAudio !== true && Boolean(outFile || wavFile);
  const name = safeName(targetName(json));

  // --seed：覆寫作品 settings.seed（寫暫存複本，原檔不動）
  const seed = options.seed === null || options.seed === undefined ? null : Math.round(numArg(options.seed, 0));
  const recordsDir = join(tempRoot(), 'records');
  mkdirSync(recordsDir, { recursive: true });
  const workRoot = mkdtempSync(join(recordsDir, `${name}-${scale}x-${timestamp()}-`));
  const framesDir = pngDir || join(workRoot, 'frames');
  mkdirSync(framesDir, { recursive: true });

  const tmpJsonDir = join(BATTLE_EDITOR, 'tools', 'record', '.tmp');
  let servableFile = sourceFile;
  if (seed !== null) {
    const copy = JSON.parse(JSON.stringify(json));
    copy.settings = copy.settings && typeof copy.settings === 'object' ? copy.settings : {};
    copy.settings.seed = seed;
    json = copy;
    servableFile = materializeJson(copy, tmpJsonDir);
    warnings.push(`--seed ${seed}：使用暫存複本（${relToRoot(servableFile)}），原檔未修改`);
  } else if (!sourceFile) {
    servableFile = materializeJson(json, tmpJsonDir);
  } else {
    const rel = relToRoot(sourceFile);
    if (rel.startsWith('..')) {
      servableFile = materializeJson(json, tmpJsonDir);
      warnings.push(`作品檔不在程式根內（${sourceFile}）→ 已複製到 tools/record/.tmp 供頁面載入（暫存，錄影結束後自動刪除；該目錄已 gitignore）`);
    }
  }

  /* ------------------------------- 2) 開頁錄影 ------------------------------- */
  const works = options.works === undefined ? (WORKS_DIR !== BATTLE_EDITOR ? WORKS_DIR : null) : options.works;
  let server = null;
  let edge = null;
  const captures = [];
  let audioLog = null;
  let captureMs = 0;
  // 這兩個值在 try 內更新、在 finally 之後的回傳用到 → 宣告在 try 外
  let lastFrame = null;
  let ended = false;
  try {
    server = await startServer({ port: options.port || 0, works });
    edge = await launchEdge({
      keepProfile: true, // 不讓 launchEdge 內建的遞歸刪除跑起來（派工規則）
      profileDir: join(workRoot, 'edge-profile'),
    });
    const cdp = edge.cdp;
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1500,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false,
    }).catch(() => {});
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: PRELOAD_SCRIPT }).catch(() => {});

    const targetRel = relToRoot(servableFile);
    const url = buildPageUrl({
      root: server.url,
      kind,
      targetRel,
      scale,
      lang,
      preFrames: 0,
      autoplay,
      bgm: options.bgm || null,
      // 預設乾淨畫面（不錄 HUD／自動演示提示列）；--hud 才保留
      chrome: options.hud === true,
    });

    const loaded = cdp.waitForEvent('Page.loadEventFired', 30000).catch(() => null);
    await cdp.send('Page.navigate', { url });
    await loaded;
    await waitFor(() => cdp.evaluate(READY_EXPR_BY_KIND[kind]), { timeoutMs: 45000, intervalMs: 120, label: '頁面就緒' });
    if (autoplay) {
      await waitFor(() => cdp.evaluate(AUTOPLAY_READY_BY_KIND[kind]), { timeoutMs: 20000, intervalMs: 120, label: '自動演示就緒' });
      try {
        const describe = await cdp.evaluate(
          kind === 'attack' ? 'window.__drPlay.autoplay.describe && window.__drPlay.autoplay.describe()' : 'window.__drEncounterPlay.autoplay.describe && window.__drEncounterPlay.autoplay.describe()',
        );
        const warnText = String(
          (await cdp.evaluate(
            kind === 'attack' ? 'window.__drPlay.autoplay.warnings ? window.__drPlay.autoplay.warnings() : ""' : 'window.__drEncounterPlay.autoplay.warnings ? window.__drEncounterPlay.autoplay.warnings() : ""',
          )) || '',
        );
        if (describe && typeof describe === 'object' && describe.mode) warnings.push(`自動演示：${describe.mode}`);
        if (warnText) warnings.push(`自動演示警告：${warnText}`);
      } catch (_err) {
        /* describe 缺席不影響錄影 */
      }
    }
    // 事件記錄器就緒檢查（preload 已建立；audio.js 會補齊方法）
    const logging = await cdp.evaluate('!!(window.__drAudioLog && Array.isArray(window.__drAudioLog.events))');
    if (!logging) warnings.push('音訊事件記錄器沒有建立（錄出來的 MP4 會沒有音軌來源）');

    /* ---------------------- 逐幀擷取（每幀一趟 CDP evaluate） ---------------------- */
    const captureStart = Date.now();
    // 預設 screenshot（與 render.mjs 同路徑，逐像素可比對）；--capture canvas 快 5 倍但只有遊戲畫面
    const captureMode = options.capture === 'canvas' ? 'canvas' : 'screenshot';

    const step = async (steps, index) => {
      const raw = await cdp.evaluate(frameScript(steps, index, captureMode === 'canvas', lang), {
        awaitPromise: true,
        timeoutMs: 120000,
      });
      if (!raw || raw.error) throw new Error(`第 ${index} 幀擷取失敗：${raw && raw.error ? raw.error : '未知'}`);
      let buffer = null;
      if (captureMode === 'canvas') {
        if (!raw.png || !raw.png.startsWith('data:image/png;base64,')) throw new Error(`第 ${index} 幀不是 PNG`);
        buffer = Buffer.from(raw.png.slice('data:image/png;base64,'.length), 'base64');
      } else {
        // 與 tools/agent/render.mjs 完全相同的擷取路徑（CDP 截圖 + canvas clip）；
        // 需要「與 render.mjs 逐像素一致」的驗收比對時用這個模式。
        const clip = raw.clip;
        if (!clip || !clip.width || !clip.height) throw new Error(`第 ${index} 幀取不到 canvas 位置`);
        const shot = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
        });
        buffer = Buffer.from(shot.data, 'base64');
      }
      const file = join(framesDir, pngName(index));
      return { ...raw, png: undefined, file, index, buffer };
    };
    const keep = ({ buffer, ...shot }) => {
      writeFileSync(shot.file, buffer, { flag: 'wx' });
      captures.push(shot);
    };

    // 第 0 幀：不推進，直接畫目前的初始狀態
    const first = await step(0, 0);
    keep(first);
    lastFrame = first.frame;
    ended = first.ended || Boolean(first.result);
    if (first.idle && first.idle.timedOut) warnings.push('第 0 幀擷取前素材仍未全部載入（畫面可能含洋紅佔位）');

    for (let index = 1; index < maxFrames && !ended; index += 1) {
      const shot = await step(1, index);
      if (shot.idle && shot.idle.timedOut && warnings.length < 40) {
        warnings.push(`第 ${index} 幀擷取前素材仍未全部載入（畫面可能含洋紅佔位）`);
      }
      if (shot.frame === null) {
        warnings.push(`第 ${index} 幀讀不到狀態幀號，停止錄影`);
        break;
      }
      if (lastFrame !== null && shot.frame <= lastFrame) {
        // 引擎不再前進（戰鬥已結束）→ 不重複收同一幀
        break;
      }
      if (lastFrame !== null && shot.frame > lastFrame + 1) {
        warnings.push(`第 ${index} 次推進跳了 ${shot.frame - lastFrame} 幀（引擎非單步？）`);
      }
      keep(shot);
      lastFrame = shot.frame;
      ended = shot.ended || Boolean(shot.result);
    }
    captureMs = Date.now() - captureStart;
    if (captures.length >= maxFrames) warnings.push(`已達 --max-frames ${maxFrames}，錄影在結果畫面之前停止`);

    // 取回音訊事件表（含 BGM／音效與遊戲幀號）
    try {
      audioLog = await cdp.evaluate('window.__drAudioLog && typeof window.__drAudioLog.get === "function" ? window.__drAudioLog.get() : null');
    } catch (err) {
      warnings.push(`取回音訊事件表失敗：${err && err.message ? err.message : err}`);
    }
  } finally {
    if (edge) await edge.close();
    if (server && server.close) await server.close();
    if (servableFile && servableFile !== sourceFile) removeFile(servableFile);
  }

  const frames = captures.length;
  const totalSeconds = planDuration(frames, { fps: RECORD_FPS, tail: 0 });
  const size = outputSize(scale);

  // 事件表落地（無論有沒有 ffmpeg：剪輯軟體／測試都能用）
  const eventsFile = join(framesDir, 'audio-events.json');
  const eventsPayload = {
    format: 'dr-record-audio-events/1',
    kind,
    name,
    fps: RECORD_FPS,
    frames,
    seconds: Number(totalSeconds.toFixed(3)),
    log: audioLog,
  };
  writeFileSync(eventsFile, JSON.stringify(eventsPayload, null, 2) + '\n', { flag: 'wx' });

  /* --------------------------------- 3) 音訊 --------------------------------- */
  let wav = null;
  let audioReport = null;
  const events = audioLog && Array.isArray(audioLog.events) ? audioLog.events : [];
  if (wantAudio) {
    try {
      audioReport = await mixAudio({
        events,
        totalSeconds,
        sampleRate: AUDIO_DEFAULTS.sampleRate,
        channels: AUDIO_DEFAULTS.channels,
        ffmpeg: ffmpegTools.ffmpeg,
        ffprobe: ffmpegTools.ffprobe,
        serverUrl: null, // 伺服器已關 → 音檔已抓到 workRoot/audio
        workRoot,
        wavPath: join(workRoot, 'audio.wav'),
        warnings,
      });
      wav = audioReport.wav;
    } catch (err) {
      err.message = `混音失敗：${err.message}`;
      throw err;
    }
  }

  /* --------------------------------- 4) MP4 ---------------------------------- */
  let verify = null;
  if (outFile) {
    const output = stageOutput(outFile);
    try {
      const command = buildMp4Command({
        pngPattern: pngPatternFor(framesDir),
        wav,
        output: output.temp,
        fps: RECORD_FPS,
        preset,
        crf,
      });
      await runFfmpeg(ffmpegTools.ffmpeg, command.args, { timeoutMs: 20 * 60 * 1000 });
      const probe = await probeMedia(ffmpegTools.ffprobe, output.temp);
      verify = checkVideoProbe(probe, {
        width: size.width,
        height: size.height,
        frames,
        fps: RECORD_FPS,
        audioSeconds: audioReport ? totalSeconds : null,
        requireAudio: Boolean(audioReport),
      });
      if (!verify.ok) throw new Error('ffprobe 驗證失敗：' + verify.errors.join('；'));
      output.publish();
    } finally {
      output.close();
    }
  }
  if (wavFile) {
    const output = stageOutput(wavFile);
    try {
      copyFileSync(wav, output.temp);
      output.publish();
    } finally {
      output.close();
    }
    wav = audioReport.wav = wavFile;
  }

  if (!pngDir && !options.keepFrames) removeFrameFiles(captures.map((shot) => shot.file));

  const elapsedMs = Date.now() - startedAt;

  return {
    kind,
    name,
    scale,
    size,
    lang,
    autoplay,
    seed,
    frames,
    lastFrame: lastFrame === null ? null : lastFrame + 1,
    ended,
    fps: RECORD_FPS,
    seconds: Number(totalSeconds.toFixed(3)),
    captureMs,
    elapsedMs,
    framesPerSecond: captureMs > 0 ? Math.round((frames / (captureMs / 1000)) * 10) / 10 : null,
    outputs: {
      mp4: outFile,
      wav: wav || null,
      pngDir: pngDir || null,
      events: eventsFile,
      workRoot,
    },
    audio: audioReport
      ? {
          events: events.length,
          bgmSegments: audioReport.bgmSegments,
          sfxEvents: audioReport.sfxEvents,
          files: audioReport.files,
          bytes: audioReport.bytes,
          duration: audioReport.duration,
          silent: Boolean(audioReport.silent),
          wav: audioReport.wav,
        }
      : null,
    verify,
    warnings,
    edge: edge ? { browser: edge.browser } : null,
  };
}

/* ---------------------------------------------------------- 音訊混音 */

/**
 * 事件表 → WAV。
 *
 * 步驟：抓音檔（HTTP）→ ffprobe 量長度 → BGM 分段落／SFX 去重 → 組 filter graph → ffmpeg。
 * 沒有任何事件時輸出靜音軌（MP4 仍要有音軌，剪輯軟體才不會有缺軌警告）。
 */
async function mixAudio({ events, totalSeconds, sampleRate, channels, ffmpeg, ffprobe, workRoot, wavPath, warnings }) {
  const fileDurations = {};
  let files = [];
  let bytes = 0;
  let downloaded = false;

  return (async () => {
    const bgmRaw = (Array.isArray(events) ? events : []).filter((event) => event && event.type === 'bgm');
    const sfxRaw = (Array.isArray(events) ? events : []).filter((event) => event && event.type === 'sfx');
    const wanted = collectAudioFiles(planBgmSegments(bgmRaw, { totalSeconds }), planSfxEvents(sfxRaw, { totalSeconds }));
    let available = new Set();
    if (wanted.length > 0) {
      const audioDir = join(workRoot, 'audio');
      // 伺服器已關 → 用 BATTLE_EDITOR/assets 直接讀（工作根的自訂音檔要先抓過）
      const results = [];
      for (const rel of wanted) {
        const candidates = [
          join(process.env.DR_ASSETS || join(BATTLE_EDITOR, 'assets'), ...String(rel).replace(/\\/g, '/').split('/')),
          join(WORKS_DIR, 'assets', ...String(rel).replace(/\\/g, '/').split('/')),
        ];
        const found = candidates.find((candidate) => existsSync(candidate));
        if (!found) {
          warnings.push(`找不到音檔：${rel}（該事件不混音）`);
          continue;
        }
        const target = join(audioDir, ...String(rel).replace(/\\/g, '/').split('/'));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, readFileSync(found));
        results.push({ rel, target, size: statSync(target).size });
      }
      downloaded = results.length > 0;
      files = results.map((item) => item.rel);
      bytes = results.reduce((sum, item) => sum + item.size, 0);
      available = new Set(files);
      if (ffprobe) {
        for (const item of results) {
          const probe = await probeMedia(ffprobe, item.target);
          if (probe && probe.duration) fileDurations[item.rel] = probe.duration;
        }
      }
    }

    const bgmSegments = planBgmSegments(bgmRaw, { totalSeconds, fileDurations }).filter((segment) => available.has(segment.file));
    const sfxEvents = dedupeSfx(planSfxEvents(sfxRaw, { totalSeconds }).filter((event) => available.has(event.file)));

    if (bgmSegments.length === 0 && sfxEvents.length === 0) {
      // 沒有可用事件 → 產生靜音 WAV（保持 MP4 有音軌）
      warnings.push('沒有任何可混音的音訊事件 → 輸出靜音音軌');
      await runFfmpeg(
        ffmpeg,
        ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=${sampleRate}`, '-t', String(totalSeconds), '-c:a', 'pcm_s16le', wavPath],
        { timeoutMs: 5 * 60 * 1000 },
      );
      return { wav: wavPath, duration: totalSeconds, bgmSegments: 0, sfxEvents: 0, files: [], bytes: 0, silent: true };
    }

    const plan = buildMixPlan({
      bgmSegments,
      sfxEvents,
      bgmDir: join(workRoot, 'audio'),
      sfxDir: join(workRoot, 'audio'),
      totalSeconds,
      sampleRate,
      channels,
      resolve: (kind) => (file) => {
        void kind;
        return join(workRoot, 'audio', ...String(file).replace(/\\/g, '/').split('/'));
      },
    });
    const filterFile = join(workRoot, 'mix.ffgraph');
    writeFileSync(filterFile, plan.filter, 'utf8');
    try {
      const command = buildWavCommand(plan, wavPath, { sampleRate, channels, filterFile });
      await runFfmpeg(ffmpeg, command.args, { timeoutMs: 15 * 60 * 1000 });
    } catch (err) {
      if (!/(?:unrecognized option|option not found)[^\n]*\/filter_complex/i.test(err.message)) throw err;
      const legacy = buildWavCommand(plan, wavPath, { sampleRate, channels, filterFile, legacyFilterOption: true });
      await runFfmpeg(ffmpeg, legacy.args, { timeoutMs: 15 * 60 * 1000 });
    } finally {
      removeFile(filterFile);
    }
    void downloaded;
    return {
      wav: wavPath,
      duration: plan.duration,
      bgmSegments: bgmSegments.length,
      sfxEvents: sfxEvents.length,
      files,
      bytes,
      silent: false,
    };
  })();
}

/* ------------------------------------------------------------- CLI */

async function main() {
  const argv = process.argv.slice(2);
  try {
    applyCliPaths(argv);
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  // 只把「值型別」旗標交給 parseArgs：布林旗標若也列進去，它會吃掉下一個參數
  // （--verify --json 會讓 verify 變成字串 '--json'，--keep-frames --scale 2 會吃掉 --scale）。
  const args = parseArgs(argv, VALUE_FLAGS, { booleanFlags: BOOLEAN_FLAGS });
  if (args.help) {
    console.log(USAGE);
    return;
  }
  const options = parseRecordArgs(args, {});
  const usageError = validateRecordOptions(options);
  if (!options.input) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  if (usageError) {
    console.error(usageError);
    process.exitCode = 2;
    return;
  }
  if (!options.quiet && !options.json) {
    console.log(`逐幀錄影：${options.input}`);
  }
  const result = await recordTarget(options.input, {
    ...options,
    works: WORKS_DIR !== BATTLE_EDITOR ? WORKS_DIR : null,
  });
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  const kindLabel = result.kind === 'encounter' ? '遭遇' : '攻擊';
  console.log(`作品：${result.name}（${kindLabel}）  自動演示：${result.autoplay || 'off'}`);
  console.log(`幀數：${result.frames}（最後一幀 #${result.lastFrame === null ? '?' : result.lastFrame - 1}${result.ended ? '，已到結果畫面' : ''}）`);
  console.log(`時長：${result.seconds}s @ ${result.fps}fps　尺寸：${result.size.width}×${result.size.height}`);
  console.log(`擷取：${result.captureMs}ms（${result.framesPerSecond} 幀/秒）　總計：${(result.elapsedMs / 1000).toFixed(1)}s`);
  if (result.outputs.mp4) console.log(`MP4：${result.outputs.mp4}`);
  if (result.outputs.wav) console.log(`WAV：${result.outputs.wav}`);
  if (result.outputs.pngDir) console.log(`PNG 序列：${result.outputs.pngDir}（${pngName(0)}…${pngName(result.frames - 1)}）`);
  console.log(`音訊事件表：${result.outputs.events}`);
  if (result.audio) {
    console.log(
      `混音：BGM ${result.audio.bgmSegments} 段、音效 ${result.audio.sfxEvents} 筆` +
        `（事件 ${result.audio.events} 筆，音檔 ${result.audio.files.length} 個 ${Math.round(result.audio.bytes / 1024)} KB）`,
    );
  }
  if (result.verify) {
    if (result.verify.ok) {
      const v = result.verify.probe
        ? `${result.verify.probe.video.width}×${result.verify.probe.video.height} ${result.verify.probe.video.fps}fps ` +
          `${result.verify.probe.video.frames} 幀 ${result.verify.probe.audio ? result.verify.probe.audio.codec : '無音軌'}`
        : '通過';
      console.log(`ffprobe 驗證：OK（${v}）`);
    } else {
      console.log(`ffprobe 驗證：失敗（${result.verify.errors.join('；')}）`);
    }
  }
  if (result.warnings.length > 0) {
    console.log('');
    console.log('警告：');
    for (const warning of result.warnings) console.log(`  - ${warning}`);
  }
}

if (cliEntry(import.meta.url)) {
  main().catch((err) => {
    if (err && (err.code === NO_FFMPEG || err.code === NO_FFPROBE)) {
      console.error(err.message);
      process.exitCode = 3;
      return;
    }
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}

export default recordTarget;
