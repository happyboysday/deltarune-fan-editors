/**
 * editor/preview.js — 預覽 / 試玩（ED1 擁有）
 *
 * 職責：
 *   - 建立 preview 模式的 battle（畫在 #preview-canvas 上）
 *   - 提供 SPEC §10 的 preview 介面：seek / getFrame / fps / onFrame / duration
 *   - 播放、暫停、單幀前進後退、回開頭、時間碼
 *   - store 變更時重新 battle.load(store.attack) 並 seek 回目前幀
 *   - 「試玩」切 play 模式（鍵盤控制），Esc 回編輯模式
 *   - hitbox / 格線開關；用量測畫面像素自動校正戰鬥框覆蓋層
 *   - 收集 validateAttack 結果與引擎 'error' 事件 → store.errors
 *
 * 本模組以靜態 import 依賴 engine/index.js；引擎尚未完成時，
 * main.js 會用 dynamic import 包住它並顯示「引擎尚未完成」提示。
 */

import { createBattle, loadAssets, validateAttack } from '../engine/index.js';
import { createInput } from '../engine/input.js';
import { compileSoulProfiles } from '../engine/soul-mechanics.js';
import { t, onLocaleChange, getLocale, battleLangFor } from './i18n.js';
import './locales/app.js'; // 註冊 app/toolbar/preview/fileops 字串（副作用）
import './locales/demo.js'; // 註冊 demo / autoplay 字串（副作用）
import {
  createAutopilot,
  createRecorder,
  deviationStats,
  traceDemo,
} from '../engine/autoplay/index.js';
import { createDemoOverlay } from './demo-overlay.js';
import { compileArena, compilePolygon, STAGE_BOX } from '../engine/arena.js';
import { demoInputToSimulation, normalizeDemoPath } from './demo-path.js';
// 拍點（SPEC-EXPR-V2 §2）：settings.duration / timeline[].at|duration / demo t 可為拍點字串。
import {
  normalizeTiming,
  timeLengthSeconds,
  timePointSeconds,
} from './beat.js';
// 戰鬥框預設值一律取自引擎（SPEC-LAYOUT §5 實機量測），不在編輯器複製數字。
import { BOX_DEFAULTS } from '../engine/attack.js';

export const FPS = 30;
export const VIEW_W = 640;
export const VIEW_H = 480;

/** AP4 演示字串（locales/demo.js）的取字串捷徑。 */
const demoT = (key, params) => t(`demo.${key}`, params);
const autoplayT = (key, params) => t(`autoplay.${key}`, params);

const MIN_BOX = 16;
const DEFAULT_BOX_COLOR = BOX_DEFAULTS.color;
const MAX_ENGINE_ERRORS = 60;

/* ------------------------------------------------------------------ 小工具 */

function num(v, fallback = 0) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function r1(v) {
  return Math.round(v * 10) / 10;
}

function safeCall(obj, method, ...args) {
  if (!obj || typeof obj[method] !== 'function') return undefined;
  try {
    return obj[method](...(args || []));
  } catch (err) {
    console.warn(`[preview] 呼叫 battle.${method} 失敗：`, err);
    return undefined;
  }
}

/** 時間碼：秒:幀（30fps），例如 03:14 */
export function formatTimecode(frame, fps = FPS) {
  const f = Math.max(0, Math.round(num(frame, 0)));
  const sec = Math.floor(f / fps);
  const ff = f - sec * fps;
  return `${String(sec).padStart(2, '0')}:${String(ff).padStart(2, '0')}`;
}

/**
 * 戰鬥框幾何：SPEC §3 明訂 box.x / box.y 是戰鬥框「中心點」（引擎 sim.js 也以
 * w/2、h/2 計算），因此一律用固定中心點換算，不再從畫布像素反推 x/y 語意。
 */
export const BOX_ANCHOR = { ax: 0.5, ay: 0.5 };

function computeBoxRect(box) {
  const w = Math.max(0, num(box.w, BOX_DEFAULTS.w));
  const h = Math.max(0, num(box.h, BOX_DEFAULTS.h));
  const left = num(box.x, BOX_DEFAULTS.x) - w / 2;
  const top = num(box.y, BOX_DEFAULTS.y) - h / 2;
  return { left, top, w, h, right: left + w, bottom: top + h };
}

/* ---------------------------------------------------------------------- */

/**
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   viewport: HTMLElement,
 *   stage: HTMLElement,
 *   overlay: HTMLElement,
 *   boxShape: HTMLElement,
 *   banner: HTMLElement,
 *   store: any,
 *   assets: any,
 *   onStatus?: (status:any)=>void,
 *   onError?: (err:any)=>void,
 * }} opts
 */
export function createPreview(opts) {
  const {
    canvas,
    viewport,
    stage,
    overlay,
    boxShape,
    banner,
    store,
    assets = null,
    onStatus = null,
    onError = null,
  } = opts || {};

  if (!canvas || !viewport || !store) {
    throw new Error(t('preview.previewNotReady'));
  }
  if (typeof createBattle !== 'function') {
    throw new Error(t('app.engine.moduleMissing'));
  }

  /* ------------------------------------------------------------ 內部狀態 */

  let battle = null;
  let ready = false;
  let engineFailed = false;
  let mode = 'preview'; // 'preview' | 'play'
  let playing = false;
  let currentFrame = 0;
  let durationSec = 0;
  let scale = 1;
  let dragging = false;
  let destroyed = false;

  /* 自動演示（SPEC-AUTOPLAY §4）：只把 pilot 的輸入餵給引擎，不直接改狀態。 */
  let autoplayMode = 'off'; // 'off' | 'demo' | 'bot'
  let pilot = null;
  let demoOverlay = null;
  let demoOverlayVisible = true;
  let demoDragging = false;
  // 錄製：在預覽手動遊玩一次，結束寫入 demo.inputs（一筆可復原編輯）。
  let recording = false;
  let recorder = null;
  let recordInput = null;
  // 自動演示 / 錄製的手動逐幀驅動迴圈（play 模式 battle，但不呼叫 battle.play()）
  let demoLoopTimer = 0;
  let demoLoopAcc = 0;
  let demoLoopLast = 0;
  let demoIndex = 0;
  let demoControls = null;

  const options = { showHitboxes: false, showGrid: true, muted: false };

  // 戰鬥畫面語言：使用者沒手動按過切換鈕時跟隨編輯器語系（battleLangFor）。
  const BATTLE_LANG_KEY = 'drbe.battleLang';
  let manualBattleLang = readManualBattleLang(); // 'zh' | 'en' | null（null＝跟隨介面）

  function readManualBattleLang() {
    try {
      const v = globalThis.localStorage?.getItem(BATTLE_LANG_KEY);
      return v === 'zh' || v === 'en' ? v : null;
    } catch (_err) {
      return null;
    }
  }

  function writeManualBattleLang(value) {
    try {
      if (value === 'zh' || value === 'en') globalThis.localStorage?.setItem(BATTLE_LANG_KEY, value);
      else globalThis.localStorage?.removeItem(BATTLE_LANG_KEY);
    } catch (_err) {
      /* 忽略 */
    }
  }

  /** 目前實際套用到引擎的戰鬥語言 */
  function effectiveBattleLang() {
    return manualBattleLang || battleLangFor(getLocale());
  }

  /** @type {Set<(frame:number)=>void>} */
  const frameSubs = new Set();
  /** @type {Set<(status:any)=>void>} */
  const statusSubs = new Set();

  // 錯誤：驗證 + 引擎執行期，合併後寫入 store.errors
  let validationErrors = new Map();
  const engineErrors = new Map();

  // 戰鬥框覆蓋層（box.x / box.y 是中心點，幾何一律用固定中心換算）

  let rafId = 0;
  let lastNotifiedFrame = -1;
  let lastStatusKey = '';
  let refreshScheduled = false;
  let suppressReload = false;
  let pendingReload = false;
  let pendingReloadReset = false;

  /* -------------------------------------------------------------- 目前攻擊 */

  function currentAttack() {
    return (store && store.attack) || {};
  }

  let geometryDoc;
  let geometry;
  function currentGeometry() {
    const doc = currentAttack();
    if (doc !== geometryDoc) {
      geometryDoc = doc;
      geometry = { arena: compileArena(doc.arena), clip: compilePolygon(doc.clipRegion?.points) };
    }
    return geometry;
  }

  function currentBox() {
    const attack = currentAttack();
    const box = attack.box || {};
    return {
      x: num(box.x, BOX_DEFAULTS.x),
      y: num(box.y, BOX_DEFAULTS.y),
      w: num(box.w, BOX_DEFAULTS.w),
      h: num(box.h, BOX_DEFAULTS.h),
      rotation: num(box.rotation, BOX_DEFAULTS.rotation),
      border: num(box.border, BOX_DEFAULTS.border),
      color: typeof box.color === 'string' ? box.color : DEFAULT_BOX_COLOR,
    };
  }

  function currentTiming() {
    const attack = currentAttack();
    return normalizeTiming(attack.settings || null);
  }

  function computeDuration() {
    const attack = currentAttack();
    const settings = attack.settings || {};
    const timing = normalizeTiming(settings);
    // settings.duration 可以是秒數或拍點字串（SPEC-EXPR-V2 §2）
    let d = timeLengthSeconds(settings.duration, timing, 0);
    if (!(d > 0)) {
      let maxEnd = 0;
      const timeline = Array.isArray(attack.timeline) ? attack.timeline : [];
      for (const ev of timeline) {
        if (!ev || typeof ev !== 'object') continue;
        const at = timePointSeconds(ev.at, timing, 0);
        const dur = timeLengthSeconds(ev.duration, timing, 0);
        maxEnd = Math.max(maxEnd, at + Math.max(0, dur));
      }
      d = maxEnd > 0 ? maxEnd : 8;
    }
    // demo 路徑（含拍點字串 t）也可能比時間軸長
    return d;
  }

  function durationFrames() {
    return Math.max(1, Math.round(durationSec * FPS));
  }

  /* ---------------------------------------------------------------- 狀態 */

  function statusPayload() {
    return {
      playing,
      mode,
      tryMode: mode === 'play',
      ready,
      engineFailed,
      frame: currentFrame,
      duration: durationSec,
      frameCount: durationFrames(),
      scale,
      options: { ...options },
    };
  }

  function emitStatus(force = false) {
    const s = statusPayload();
    const key = `${s.playing}|${s.mode}|${s.ready}|${s.engineFailed}|${s.frame}|${s.duration}|${s.scale}`;
    if (!force && key === lastStatusKey) return;
    lastStatusKey = key;
    if (onStatus) {
      try {
        onStatus(s);
      } catch (err) {
        console.warn('[preview] onStatus 回呼錯誤：', err);
      }
    }
    for (const fn of [...statusSubs]) {
      try {
        fn(s);
      } catch (err) {
        console.warn('[preview] 狀態訂閱回呼錯誤：', err);
      }
    }
  }

  function notifyFrame(frame, force = false) {
    const f = Math.max(0, Math.round(num(frame, 0)));
    currentFrame = f;
    updateTimecodeUI();
    updateOverlayGeometry();
    if (!force && f === lastNotifiedFrame) {
      emitStatus();
      return;
    }
    lastNotifiedFrame = f;
    for (const fn of [...frameSubs]) {
      try {
        fn(f);
      } catch (err) {
        console.warn('[preview] onFrame 回呼錯誤：', err);
      }
    }
    emitStatus();
  }

  /* -------------------------------------------------------------- 錯誤 */

  // 錯誤重建可能來自多個非同步來源（store 變更後的驗證、引擎 'error' 事件、
  // 開檔後的重新驗證…）。store.setErrors 支援世代序號：取號 → 計算 → 提交，
  // 比目前已套用序號舊的結果會被丟棄，避免舊結果覆蓋新結果。
  // 沒有 store.nextErrorSeq（舊版 store）時退化為 undefined，行為等同原本。

  function takeErrorSeq() {
    return store && typeof store.nextErrorSeq === 'function' ? store.nextErrorSeq() : undefined;
  }

  /** 立即套用目前累積的錯誤（呼叫端已持有最新狀態時使用） */
  function rebuildErrors() {
    if (!store || typeof store.setErrors !== 'function') return false;
    const merged = new Map(validationErrors);
    for (const [key, value] of engineErrors) merged.set(key, value);
    suppressReload = true;
    try {
      return store.setErrors(merged, takeErrorSeq());
    } finally {
      suppressReload = false;
    }
  }

  function runValidation() {
    // 先取號：之後才計算，算完提交時若已有更新的一次重建，這次結果會被丟棄
    const seq = takeErrorSeq();
    const attack = currentAttack();
    const map = new Map();
    if (typeof validateAttack === 'function') {
      try {
        const list = validateAttack(attack);
        if (Array.isArray(list)) {
          for (const item of list) {
            if (item && typeof item === 'object') {
              const key = item.path ?? item.key ?? '$';
              if (item.message) map.set(String(key), String(item.message));
            } else if (typeof item === 'string') {
              map.set('$', item);
            }
          }
        }
      } catch (err) {
        map.set('$', t('preview.validatorError', { msg: err && err.message ? err.message : err }));
      }
    }
    validationErrors = map;
    if (!store || typeof store.setErrors !== 'function') return;
    const merged = new Map(validationErrors);
    for (const [key, value] of engineErrors) merged.set(key, value);
    suppressReload = true;
    try {
      store.setErrors(merged, seq);
    } finally {
      suppressReload = false;
    }
  }

  /** 把引擎 'error' 事件轉成 store.errors 的項目（key 盡量用 JSON 路徑） */
  function engineErrorToKey(payload) {
    if (!payload || typeof payload !== 'object') return '$';
    if (typeof payload.path === 'string' && payload.path) return payload.path;
    const attack = currentAttack();
    const timeline = Array.isArray(attack.timeline) ? attack.timeline : [];
    const id = payload.id ?? payload.eventId ?? payload.event;
    if (id !== undefined && id !== null) {
      const idx = timeline.findIndex((ev) => ev && String(ev.id) === String(id));
      const field = payload.field ?? payload.prop ?? payload.name;
      if (idx >= 0) return field ? `timeline[${idx}].${field}` : `timeline[${idx}]`;
      return field ? `timeline[${id}].${field}` : `timeline[${id}]`;
    }
    return '$';
  }

  function onEngineError(payload) {
    const key = engineErrorToKey(payload);
    const message =
      (payload && (payload.message || payload.msg)) ||
      (typeof payload === 'string' ? payload : '') ||
      t('preview.unknownEngineError');
    if (engineErrors.size >= MAX_ENGINE_ERRORS && !engineErrors.has(key)) return;
    engineErrors.set(key, String(message).slice(0, 400));
    rebuildErrors();
    if (onError) {
      try {
        onError({ key, message });
      } catch (_err) {
        /* 忽略 */
      }
    }
  }

  function clearEngineErrors() {
    if (engineErrors.size === 0) return;
    engineErrors.clear();
    rebuildErrors();
  }

  /* ------------------------------------------------------------ 引擎建立 */

  function showBanner(html) {
    if (!banner) return;
    banner.innerHTML = html;
    banner.hidden = false;
  }

  function hideBanner() {
    if (!banner) return;
    banner.hidden = true;
    banner.innerHTML = '';
  }

  function engineFailure(err) {
    engineFailed = true;
    ready = false;
    playing = false;
    const message = err && err.message ? err.message : String(err || t('app.fallback.unknownError'));
    showBanner(
      `<h3>${escapeHtml(t('preview.banner.engineTitle'))}</h3>` +
        `<p>${escapeHtml(t('preview.banner.engineLine1'))}</p>` +
        `<p>${escapeHtml(t('app.engine.errorDetail', { msg: message }))}</p>` +
        `<p>${t('preview.banner.engineFix')}</p>`,
    );
    emitStatus(true);
  }

  function bindBattle(instance) {
    if (!instance || typeof instance.on !== 'function') return;
    try {
      instance.on('frame', (payload) => {
        if (suppressReload) return;
        const frame =
          typeof payload === 'number'
            ? payload
            : payload && typeof payload.frame === 'number'
              ? payload.frame
              : (instance.getState ? instance.getState().frame : currentFrame);
        if (typeof frame === 'number' && Number.isFinite(frame)) {
          if (frame !== currentFrame) notifyFrame(frame);
        }
      });
    } catch (err) {
      console.warn('[preview] 無法綁定 frame 事件：', err);
    }
    try {
      instance.on('error', onEngineError);
    } catch (err) {
      console.warn('[preview] 無法綁定 error 事件：', err);
    }
    try {
      instance.on('end', () => {
        playing = false;
        updateTransportUI();
        emitStatus(true);
      });
    } catch (_err) {
      /* 引擎尚未實作 'end' */
    }
  }

  function applyOptions() {
    if (!battle) return;
    const payload = {
      showHitboxes: options.showHitboxes,
      showGrid: options.showGrid,
      muted: options.muted,
      scale,
      lang: effectiveBattleLang(),
    };
    safeCall(battle, 'setOptions', payload);
  }

  function createBattleInstance(nextMode) {
    const instance = createBattle({ canvas, assets: assets || null, mode: nextMode });
    if (!instance || typeof instance !== 'object') {
      throw new Error(t('app.engine.noCreateBattle'));
    }
    return instance;
  }

  function init() {
    engineErrors.clear();
    try {
      battle = createBattleInstance('preview');
      bindBattle(battle);
      ready = true;
      hideBanner();
      applyOptions();
      loadCurrent(true);
      startLoop();
      armAssetRepaint();
      scheduleAssetRepaint(200);
    } catch (err) {
      console.error('[preview] 建立 battle 失敗：', err);
      engineFailure(err);
    }
    runValidation();
  }

  function destroyBattle() {
    if (!battle) return;
    safeCall(battle, 'pause');
    safeCall(battle, 'destroy');
    battle = null;
  }

  /* ---------------------------------------------------------- 自動演示 */

  function isDemoActive() {
    return autoplayMode !== 'off' || recording;
  }

  function demoEngine() {
    return battle && battle.engine ? battle.engine : null;
  }

  function demoState() {
    const engine = demoEngine();
    if (!engine || typeof engine.getState !== 'function') return null;
    try {
      return engine.getState();
    } catch (_err) {
      return null;
    }
  }

  /**
   * 自動演示 / 錄製用的 battle：play 模式（引擎才會套用輸入），
   * 但不呼叫 battle.play()——由編輯器逐幀 engine.stepFrame(input) 驅動，
   * 這樣 seek 重模擬與播放走同一條輸入序列（SPEC-AUTOPLAY §1 決定性）。
   */
  function ensurePlayBattle() {
    if (!ready) return false;
    if (battle && battle.mode === 'play') return true;
    destroyBattle();
    try {
      battle = createBattleInstance('play');
      bindBattle(battle);
      applyOptions();
      battle.load(currentAttack());
      safeCall(battle, 'pause');
      return true;
    } catch (err) {
      console.error('[preview] 建立自動演示 battle 失敗：', err);
      onEngineError({ message: err && err.message ? err.message : String(err) });
      return false;
    }
  }

  /** 關閉自動演示 / 錄製後，還原一般預覽用的 preview 模式 battle。 */
  function ensurePreviewBattle() {
    if (!ready) return;
    if (battle && battle.mode === 'preview') return;
    const keep = currentFrame;
    destroyBattle();
    try {
      battle = createBattleInstance('preview');
      bindBattle(battle);
      applyOptions();
      battle.load(currentAttack());
      safeCall(battle, 'pause');
      seekInternal(clamp(keep, 0, durationFrames()), true);
    } catch (err) {
      console.error('[preview] 還原預覽 battle 失敗：', err);
      engineFailure(err);
    }
  }

  function rebuildPilot() {
    pilot = null;
    if (autoplayMode === 'off') return null;
    try {
      pilot = createAutopilot({ kind: 'attack', doc: currentAttack(), mode: autoplayMode });
    } catch (err) {
      console.warn('[preview] createAutopilot 失敗：', err);
      onEngineError({ message: err && err.message ? err.message : String(err) });
      pilot = null;
    }
    return pilot;
  }

  function pilotInput(state, frame) {
    if (!pilot || typeof pilot.input !== 'function') return { dx: 0, dy: 0, slow: false };
    try {
      const input = pilot.input(state, frame);
      // SPEC-AUTOPLAY 的 pilot 回傳 {press,hold}；攻擊模擬吃 {dx,dy,slow}
      return demoInputToSimulation(input && typeof input === 'object' ? input : null);
    } catch (err) {
      console.warn('[preview] pilot.input 失敗：', err);
      return { dx: 0, dy: 0, slow: false };
    }
  }

  function stepDemoFrame(input) {
    const engine = demoEngine();
    if (!engine || typeof engine.stepFrame !== 'function') return false;
    let moved = false;
    try {
      moved = engine.stepFrame(input);
    } catch (err) {
      console.warn('[preview] 自動演示 stepFrame 失敗：', err);
      return false;
    }
    try {
      // 自動演示不播音效；清掉佇列避免累積
      if (typeof engine.drainSfx === 'function') engine.drainSfx();
    } catch (_err) {
      /* 忽略 */
    }
    return moved;
  }

  /** 以同一個 pilot 從第 0 幀重算到 frame（決定性；seek 重模擬，SPEC-AUTOPLAY §4）。 */
  function demoSeek(frame) {
    const target = clamp(Math.round(num(frame, 0)), 0, durationFrames());
    if (!isDemoActive()) {
      seekInternal(target, true);
      return;
    }
    if (!ensurePlayBattle()) {
      notifyFrame(target, true);
      return;
    }
    const engine = demoEngine();
    if (!engine || typeof engine.reset !== 'function' || typeof engine.stepFrame !== 'function') {
      notifyFrame(target, true);
      return;
    }
    if (pilot && typeof pilot.reset === 'function') {
      try {
        pilot.reset();
      } catch (_err) {
        /* 忽略 */
      }
    }
    try {
      engine.reset();
    } catch (_err) {
      /* 忽略 */
    }
    if (recording) {
      // 錄製中的手動輸入無法重建；seek 只會重置到開頭。
      demoIndex = 0;
      try {
        safeCall(battle, 'step', 0);
      } catch (_err) {
        /* 忽略 */
      }
      notifyFrame(0, true);
      return;
    }
    for (let i = 0; i < target; i += 1) {
      if (!stepDemoFrame(pilotInput(demoState(), i))) break;
    }
    try {
      safeCall(battle, 'step', 0);
    } catch (_err) {
      /* 忽略 */
    }
    demoIndex = target;
    notifyFrame(target, true);
  }

  function startDemoLoop() {
    stopDemoLoop();
    demoLoopLast = typeof performance !== 'undefined' ? performance.now() : Date.now();
    demoLoopAcc = 0;
    const interval = Math.max(8, Math.round(1000 / FPS));
    demoLoopTimer = setInterval(() => {
      if (destroyed || !playing) {
        stopDemoLoop();
        return;
      }
      const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
      const dt = Math.min(0.25, (now - demoLoopLast) / 1000);
      demoLoopLast = now;
      demoLoopAcc += dt * FPS;
      let guard = 0;
      while (demoLoopAcc >= 1 && guard < 8 && playing) {
        demoLoopAcc -= 1;
        guard += 1;
        if (!advanceDemoFrame()) break;
      }
      updateTransportUI();
      emitStatus(true);
      const state = demoState();
      if (recording) {
        if ((state && state.ended) || demoIndex >= durationFrames()) stopRecording();
      } else if (playing && state && state.ended) {
        finishDemoPlayback();
      }
    }, interval);
  }

  function stopDemoLoop() {
    if (demoLoopTimer) {
      clearInterval(demoLoopTimer);
      demoLoopTimer = 0;
    }
  }

  function advanceDemoFrame() {
    const engine = demoEngine();
    if (!engine) return false;
    const state = demoState();
    if (state && state.ended) return false;
    const frame = state && Number.isFinite(state.frame) ? state.frame : demoIndex;
    if (frame >= durationFrames()) return false;
    let input;
    if (recording) {
      input = recordInput.readFrame();
      recorder.push(frame, { press: input.press, hold: input.hold });
    } else {
      input = pilotInput(state, frame);
    }
    if (!stepDemoFrame(input)) return false;
    const next = demoState();
    demoIndex = next && Number.isFinite(next.frame) ? next.frame : demoIndex + 1;
    notifyFrame(demoIndex);
    return true;
  }

  function finishDemoPlayback() {
    playing = false;
    stopDemoLoop();
    const state = demoState();
    if (state && Number.isFinite(state.frame)) notifyFrame(state.frame, true);
    updateTransportUI();
    emitStatus(true);
  }

  function onRecordEscape(ev) {
    if (ev.code !== 'Escape') return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    stopRecording();
  }

  function bindRecordKeys() {
    recordInput = createInput(window, { capture: true });
    window.addEventListener('keydown', onRecordEscape, true);
  }

  function unbindRecordKeys() {
    if (!recordInput) return;
    recordInput.destroy();
    recordInput = null;
    window.removeEventListener('keydown', onRecordEscape, true);
  }

  function commitRecordedInputs(text) {
    if (!store || typeof store.update !== 'function' || !text) return;
    store.update(
      (draft) => {
        if (!draft.demo || typeof draft.demo !== 'object') draft.demo = {};
        draft.demo.mode = 'inputs';
        draft.demo.inputs = text;
      },
      { label: demoT('undo.record') },
    );
  }

  function startRecording() {
    if (!ready || recording) return false;
    if (autoplayMode !== 'off') {
      autoplayMode = 'off';
      pilot = null;
      updateAutoplayUI();
    }
    if (playing) pause();
    recording = true;
    recorder = createRecorder();
    if (!ensurePlayBattle()) {
      recording = false;
      recorder = null;
      return false;
    }
    demoSeek(0);
    bindRecordKeys();
    playing = true;
    startDemoLoop();
    updateTransportUI();
    emitStatus(true);
    return true;
  }

  function stopRecording() {
    if (!recording) return false;
    recording = false;
    unbindRecordKeys();
    playing = false;
    stopDemoLoop();
    const rec = recorder;
    recorder = null;
    const frame = getFrame();
    let text = '';
    try {
      text = rec && typeof rec.toString === 'function' ? rec.toString() : '';
    } catch (err) {
      console.warn('[preview] 錄製結果編碼失敗：', err);
    }
    if (text) commitRecordedInputs(text);
    currentFrame = clamp(frame, 0, durationFrames());
    if (autoplayMode === 'off') {
      ensurePreviewBattle();
      seekInternal(currentFrame, true);
    }
    updateTransportUI();
    emitStatus(true);
    return true;
  }

  function setAutoplayMode(next) {
    const target = next === 'demo' || next === 'bot' ? next : 'off';
    if (target === autoplayMode) {
      updateAutoplayUI();
      return autoplayMode;
    }
    if (recording) stopRecording();
    if (playing) pause();
    autoplayMode = target;
    updateAutoplayUI();
    if (!ready) return autoplayMode;
    if (autoplayMode === 'off') {
      pilot = null;
      ensurePreviewBattle();
      seekInternal(clamp(currentFrame, 0, durationFrames()), true);
    } else {
      ensurePlayBattle();
      rebuildPilot();
      demoSeek(clamp(currentFrame, 0, durationFrames()));
    }
    updateTransportUI();
    emitStatus(true);
    return autoplayMode;
  }

  function getAutoplayWarnings() {
    if (!pilot || !Array.isArray(pilot.warnings)) return [];
    return pilot.warnings.slice();
  }

  /* ------------------------------------------- V2-06 實際軌跡疊圖 */

  let trace = null;
  let traceVisible = true;
  let traceTimer = 0;

  /** 目前自動演示 pilot 的狀態；沒有 pilot 時臨時建一個只為了 describe()。 */
  function describeAutopilot() {
    let target = pilot;
    if (!target) {
      try {
        target = createAutopilot({ kind: 'attack', doc: currentAttack(), mode: 'demo' });
      } catch (_err) {
        target = null;
      }
    }
    if (!target || typeof target.describe !== 'function') return { ready: false, missing: true };
    try {
      const d = target.describe();
      return d && typeof d === 'object' ? { ...d, missing: false } : { ready: false };
    } catch (_err) {
      return { ready: false, missing: false };
    }
  }

  /** demo.path 的正規化副本（引擎的 trace 只吃秒數，字串 t 要先換算）。 */
  function normalizedDemoPoints(demo) {
    const d = demo && typeof demo === 'object' ? demo : null;
    if (!d || !Array.isArray(d.path)) return [];
    try {
      return normalizeDemoPath(d.path, { timing: currentTiming() });
    } catch (_err) {
      return [];
    }
  }

  function traceSignature(demo, points) {
    const settings = currentAttack().settings || {};
    return JSON.stringify({
      path: points.map((p) => [p.t, p.x, p.y, p.slow === true, p.hold || 0]),
      duration: settings.duration == null ? null : String(settings.duration),
      bpm: settings.bpm == null ? null : settings.bpm,
      box: currentBox(),
      arena: currentAttack().arena,
      clipRegion: currentAttack().clipRegion,
      mode: d0(demo),
    });
    function d0(v) {
      return v && typeof v === 'object' && typeof v.fallback === 'string' ? v.fallback : null;
    }
  }

  /**
   * 用引擎實跑一次目前 demo.path，取得跟隨器的實際軌跡並畫到疊加層上。
   * 回傳 {ok, frames, hits, deviation, reason}。
   */
  function traceDemoPath() {
    const attack = currentAttack();
    const demo = attack && typeof attack.demo === 'object' && attack.demo ? attack.demo : null;
    const points = normalizedDemoPoints(demo);
    if (points.length === 0) {
      trace = null;
      if (demoOverlay && typeof demoOverlay.setTrace === 'function') demoOverlay.setTrace(null);
      return { ok: false, frames: [], hits: [], deviation: null, reason: 'no-path' };
    }
    if (!ready) {
      return { ok: false, frames: [], hits: [], deviation: null, reason: 'engine-not-ready' };
    }
    let result = null;
    try {
      result = traceDemo(attack, {
        demo: { ...demo, mode: 'path', path: points },
        mode: 'path',
        keepGoing: true,
      });
    } catch (err) {
      console.warn('[preview] traceDemo 失敗：', err);
      return { ok: false, frames: [], hits: [], deviation: null, reason: 'error' };
    }
    const frames = Array.isArray(result && result.frames) ? result.frames : [];
    const hits = Array.isArray(result && result.hits) ? result.hits : [];
    let deviation = null;
    try {
      deviation = deviationStats(frames);
    } catch (_err) {
      deviation = null;
    }
    trace = {
      frames,
      hits,
      deviation,
      summary: result && result.summary ? result.summary : null,
      sig: traceSignature(demo, points),
      visible: traceVisible,
    };
    if (demoOverlay && typeof demoOverlay.setTrace === 'function') {
      demoOverlay.setTrace({ frames, hits, deviation, sig: trace.sig });
      demoOverlay.setTraceVisible(traceVisible);
    }
    emitStatus();
    return {
      ok: true,
      frames,
      hits,
      deviation,
      summary: trace.summary,
      reason: 'ok',
    };
  }

  /** 文件改了但「實際軌跡」還開著 → 延遲重算（避免連續編輯時一直跑引擎）。 */
  function scheduleTraceRefresh() {
    if (!traceVisible) return;
    const attack = currentAttack();
    const demo = attack && attack.demo ? attack.demo : null;
    if (!demo || !Array.isArray(demo.path) || demo.path.length === 0) {
      trace = null;
      if (demoOverlay && typeof demoOverlay.setTrace === 'function') demoOverlay.setTrace(null);
      return;
    }
    if (traceTimer) clearTimeout(traceTimer);
    traceTimer = setTimeout(() => {
      traceTimer = 0;
      if (destroyed) return;
      const demoNow = currentAttack().demo;
      const points = normalizedDemoPoints(demoNow);
      const sig = traceSignature(demoNow, points);
      if (trace && trace.sig === sig) return;
      traceDemoPath();
    }, 220);
  }

  function setTraceVisible(nextOn) {
    traceVisible = Boolean(nextOn);
    if (demoOverlay && typeof demoOverlay.setTraceVisible === 'function') {
      demoOverlay.setTraceVisible(traceVisible);
    }
    if (traceVisible) {
      if (!trace) traceDemoPath();
      else if (demoOverlay && typeof demoOverlay.setTrace === 'function') {
        demoOverlay.setTrace({ frames: trace.frames, hits: trace.hits, deviation: trace.deviation, sig: trace.sig });
        demoOverlay.setTraceVisible(true);
      }
    }
    emitStatus(true);
    return traceVisible;
  }

  function clearTrace() {
    trace = null;
    if (traceTimer) {
      clearTimeout(traceTimer);
      traceTimer = 0;
    }
    if (demoOverlay && typeof demoOverlay.setTrace === 'function') demoOverlay.setTrace(null);
  }

  /* ---------- 疊加層與傳輸列控制項 ---------- */

  function initDemoOverlay() {
    if (demoOverlay || destroyed) return;
    try {
      demoOverlay = createDemoOverlay({
        overlay,
        viewport,
        store,
        getFrame,
        getAttack: currentAttack,
        getBox: () => ({ ...currentBox(), arena: currentGeometry().arena }),
        isEditable: () => overlayEnabled() && !recording,
        onDragChange: (draggingNow) => {
          demoDragging = Boolean(draggingNow);
          if (!draggingNow) {
            updateOverlayGeometry();
            if (isDemoActive()) {
              // 放開後以最新的路徑重建 pilot，並重算目前時間游標的狀態
              rebuildPilot();
              demoSeek(clamp(currentFrame, 0, durationFrames()));
            }
            // V2-06：拖完路徑點 → 實際軌跡要跟著重算
            scheduleTraceRefresh();
          }
          emitStatus(true);
        },
      });
    } catch (err) {
      console.warn('[preview] 建立 demo 疊加層失敗：', err);
      demoOverlay = null;
    }
  }

  function ensureDemoControls() {
    if (demoControls || typeof document === 'undefined') return demoControls;
    const transport = document.getElementById('transport');
    if (!transport) return null;
    if (!document.getElementById('dr-autoplay-style')) {
      const style = document.createElement('style');
      style.id = 'dr-autoplay-style';
      style.textContent = [
        '.dr-autoplay{display:inline-flex;align-items:center;gap:4px;font-size:11.5px;color:var(--text-faint);}',
        '.dr-autoplay select{font-size:11.5px;background:var(--btn-bg,#1b1b22);color:inherit;border:1px solid var(--line,#333);border-radius:4px;padding:1px 3px;}',
        '.dr-autoplay.is-recording select{color:#ffd166;border-color:#ffd166;}',
        '.dr-autoplay-status{font-family:var(--font-mono,monospace);font-size:11px;color:#ffd166;white-space:nowrap;}',
        '.dr-autoplay-status[hidden]{display:none;}',
      ].join('');
      (document.head || document.documentElement).appendChild(style);
    }
    const wrap = document.createElement('label');
    wrap.className = 'dr-autoplay';
    const select = document.createElement('select');
    select.id = 'opt-autoplay';
    for (const value of ['off', 'demo', 'bot']) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = t(`autoplay.${value}`);
      select.appendChild(option);
    }
    select.title = autoplayT('title');
    select.addEventListener('change', () => setAutoplayMode(select.value));
    const status = document.createElement('span');
    status.className = 'dr-autoplay-status';
    status.hidden = true;
    wrap.appendChild(select);
    wrap.appendChild(status);
    const overlayLabel = document.createElement('label');
    overlayLabel.className = 'chk';
    overlayLabel.title = autoplayT('overlayTitle');
    const overlayInput = document.createElement('input');
    overlayInput.type = 'checkbox';
    overlayInput.id = 'opt-demo-overlay';
    overlayInput.checked = demoOverlayVisible;
    overlayInput.addEventListener('change', () => {
      demoOverlayVisible = Boolean(overlayInput.checked);
      if (demoOverlay) demoOverlay.setVisible(demoOverlayVisible);
      updateOverlayGeometry();
    });
    const overlaySpan = document.createElement('span');
    overlaySpan.textContent = autoplayT('overlay');
    overlayLabel.appendChild(overlayInput);
    overlayLabel.appendChild(overlaySpan);

    const anchor = document.getElementById('preview-mode');
    if (anchor && anchor.parentNode === transport) {
      transport.insertBefore(wrap, anchor);
      transport.insertBefore(overlayLabel, anchor);
    } else {
      transport.appendChild(wrap);
      transport.appendChild(overlayLabel);
    }

    demoControls = { wrap, select, status, overlayLabel, overlayInput, overlaySpan };
    updateAutoplayUI();
    return demoControls;
  }

  function updateAutoplayUI() {
    if (!demoControls) return;
    const { select, status, overlayInput, overlaySpan, wrap } = demoControls;
    if (select) {
      select.value = autoplayMode;
      select.title = autoplayT('title');
      for (const option of select.options) {
        option.textContent = t(`autoplay.${option.value}`);
      }
    }
    if (overlayInput) {
      overlayInput.checked = demoOverlayVisible;
      overlayInput.title = autoplayT('overlayTitle');
    }
    if (overlaySpan) overlaySpan.textContent = autoplayT('overlay');
    if (wrap) wrap.classList.toggle('is-recording', recording);
    if (status) {
      let text = '';
      if (recording) text = autoplayT('recording');
      else if (autoplayMode !== 'off') text = autoplayT('status', { mode: t(`autoplay.${autoplayMode}`) });
      status.textContent = text;
      status.hidden = !text;
    }
  }

  /* ---------------------------------------------------------- 載入攻擊 */

  function loadCurrent(resetFrame) {
    if (!battle || typeof battle.load !== 'function') return;
    playing = false;
    stopDemoLoop();
    updateTransportUI();
    clearEngineErrors();
    if (isDemoActive()) {
      // 自動演示 / 錄製：維持 play 模式 battle，重新載入後用同一個 pilot 重算。
      if (!ensurePlayBattle()) return;
      try {
        battle.load(currentAttack());
      } catch (err) {
        console.error('[preview] battle.load 失敗：', err);
        showBanner(
          `<h3>${escapeHtml(t('preview.banner.loadTitle'))}</h3><p>${escapeHtml(t('preview.banner.loadLine1'))}</p>` +
            `<p><code>${escapeHtml(err && err.message ? err.message : String(err))}</code></p>`,
        );
        return;
      }
      safeCall(battle, 'pause');
      durationSec = computeDuration();
      if (autoplayMode !== 'off') rebuildPilot();
      const target = resetFrame ? 0 : clamp(currentFrame, 0, durationFrames());
      demoSeek(target);
      scheduleAssetRepaint(0);
      return;
    }
    if (battle.mode !== 'preview') {
      // 保險：上一個 demo battle 沒被還原（例如中途關閉自動演示失敗）
      ensurePreviewBattle();
      if (!battle || battle.mode !== 'preview') return;
    }
    try {
      battle.load(currentAttack());
    } catch (err) {
      console.error('[preview] battle.load 失敗：', err);
      showBanner(
        `<h3>${escapeHtml(t('preview.banner.loadTitle'))}</h3><p>${escapeHtml(t('preview.banner.loadLine1'))}</p>` +
          `<p><code>${escapeHtml(err && err.message ? err.message : String(err))}</code></p>`,
      );
      return;
    }
    if (typeof battle.play === 'function' && mode === 'preview') {
      // preview 模式預設不自動播放；保持暫停
    }
    safeCall(battle, 'pause');
    durationSec = computeDuration();
    const target = resetFrame ? 0 : clamp(currentFrame, 0, durationFrames());
    seekInternal(target, true);
    scheduleAssetRepaint(0);
  }

  /* ------------------------------------------------------------- 時間軸 */

  function seekInternal(frame, force) {
    const f = clamp(Math.round(num(frame, 0)), 0, durationFrames());
    if (battle && typeof battle.seek === 'function') {
      try {
        battle.seek(f);
      } catch (err) {
        console.warn('[preview] battle.seek 失敗：', err);
        // 退回：reset + step
        try {
          safeCall(battle, 'reset');
          if (typeof battle.step === 'function') battle.step(f);
        } catch (err2) {
          console.warn('[preview] 退回 step 也失敗：', err2);
        }
      }
    } else if (battle && typeof battle.step === 'function') {
      try {
        safeCall(battle, 'reset');
        battle.step(f);
      } catch (err) {
        console.warn('[preview] battle.step 失敗：', err);
      }
    }
    notifyFrame(f, Boolean(force));
  }

  /** 公開 seek：preview.seek(frame) */
  function seek(frame) {
    if (!ready) {
      notifyFrame(clamp(Math.round(num(frame, 0)), 0, durationFrames()), true);
      return;
    }
    if (recording) return;
    const wasPlaying = playing;
    if (wasPlaying) pause();
    if (autoplayMode !== 'off') {
      // 自動演示：以同一個 pilot 從第 0 幀重算（決定性）
      demoSeek(frame);
      return;
    }
    seekInternal(frame, true);
  }

  function getFrame() {
    if (battle && typeof battle.getState === 'function') {
      try {
        const st = battle.getState();
        if (st && typeof st.frame === 'number' && Number.isFinite(st.frame)) {
          return st.frame;
        }
      } catch (_err) {
        /* 忽略 */
      }
    }
    return currentFrame;
  }

  function duration() {
    return durationSec || computeDuration();
  }

  function onFrame(fn) {
    if (typeof fn !== 'function') return () => {};
    frameSubs.add(fn);
    return () => {
      frameSubs.delete(fn);
    };
  }

  function onStatusChange(fn) {
    if (typeof fn !== 'function') return () => {};
    statusSubs.add(fn);
    return () => {
      statusSubs.delete(fn);
    };
  }

  /* ------------------------------------------------------------- 播放 */

  function play() {
    if (!ready) return false;
    if (playing) return true;
    if (isDemoActive()) {
      // 自動演示 / 錄製：手動逐幀驅動 play 模式 battle（不用引擎自己的播放迴圈）
      if (currentFrame >= durationFrames()) demoSeek(0);
      engineErrors.clear();
      if (!ensurePlayBattle()) return false;
      if (currentFrame > 0 && getFrame() !== currentFrame) demoSeek(currentFrame);
      playing = true;
      startDemoLoop();
      updateTransportUI();
      emitStatus(true);
      return playing;
    }
    if (currentFrame >= durationFrames()) seekInternal(0, true);
    engineErrors.clear();
    playing = true;
    const startFrame = currentFrame;
    if (battle && typeof battle.play === 'function') {
      try {
        battle.play();
      } catch (err) {
        console.warn('[preview] battle.play 失敗：', err);
        playing = false;
      }
      // 保險：若引擎的播放迴圈沒有推進（或實作尚未完成），改用編輯器自己步進
      if (playing) {
        armManualFallback(startFrame);
      }
    } else if (battle && typeof battle.step === 'function') {
      startManualPlayback();
    }
    updateTransportUI();
    emitStatus(true);
    return playing;
  }

  let fallbackTimer = 0;
  let fallbackLastFrame = 0;
  let fallbackIdle = 0;

  /**
   * 播放看門狗：引擎若沒有「持續」推進 frame（例如 rAF 被瀏覽器暫停、
   * 或引擎只 tick 了一次就停），改用編輯器自己的 step() 驅動播放。
   * 每 120ms 檢查一次；連續 3 次（約 0.5 秒）frame 沒變就接管。
   */
  function armManualFallback(startFrame) {
    stopFallbackTimer();
    fallbackLastFrame = startFrame;
    fallbackIdle = 0;
    fallbackTimer = setTimeout(checkFallback, 180);
  }

  function checkFallback() {
    fallbackTimer = 0;
    if (destroyed || !playing) {
      stopFallbackTimer();
      return;
    }
    if (!battle || typeof battle.step !== 'function') {
      stopFallbackTimer();
      return;
    }
    const nowFrame = getFrame();
    if (nowFrame !== fallbackLastFrame) {
      fallbackLastFrame = nowFrame;
      fallbackIdle = 0;
    } else {
      fallbackIdle += 1;
    }
    if (fallbackIdle >= 3) {
      console.info('[preview] 引擎未持續推進播放，改用編輯器步進');
      safeCall(battle, 'pause');
      startManualPlayback();
      return;
    }
    fallbackTimer = setTimeout(checkFallback, 120);
  }

  function stopFallbackTimer() {
    if (fallbackTimer) {
      clearTimeout(fallbackTimer);
      fallbackTimer = 0;
    }
  }

  function pause() {
    if (recording) {
      stopRecording();
      return true;
    }
    if (!playing) {
      updateTransportUI();
      return false;
    }
    playing = false;
    stopFallbackTimer();
    stopManualPlayback();
    stopDemoLoop();
    if (battle && typeof battle.pause === 'function') {
      try {
        battle.pause();
      } catch (err) {
        console.warn('[preview] battle.pause 失敗：', err);
      }
    }
    // 以引擎實際狀態同步一次
    const f = isDemoActive() && demoState() ? demoState().frame : getFrame();
    if (f !== currentFrame) notifyFrame(f, true);
    updateTransportUI();
    emitStatus(true);
    return true;
  }

  function togglePlay() {
    return playing ? (pause(), false) : play();
  }

  function step(delta = 1) {
    if (!ready) return;
    if (recording) return;
    const wasPlaying = playing;
    if (wasPlaying) pause();
    const base = getFrame();
    const target = clamp(base + Math.round(num(delta, 1)), 0, durationFrames());
    if (autoplayMode !== 'off') {
      demoSeek(target);
      return;
    }
    seekInternal(target, true);
    if (wasPlaying) {
      // 若原本在播放，單幀後仍保持暫停（編輯器慣例）
    }
  }

  function gotoStart() {
    seek(0);
  }

  /**
   * B13：預覽重來（`R` 鍵 / 工具列）。
   * 把游標拉回第 0 幀並重置 pilot，讓自動演示（腳本 / AI）重新從頭跑；
   * 原本在播放就繼續播放，暫停中就停在開頭。回傳是否真的做了事。
   */
  function restart() {
    if (recording) return false;
    const wasPlaying = playing;
    if (wasPlaying) pause();
    demoIndex = 0;
    if (autoplayMode !== 'off') {
      // 重建 pilot：腳本模式會重讀 demo.path / inputs，AI 模式重設亂數狀態
      rebuildPilot();
      demoSeek(0);
    } else {
      seek(0);
    }
    if (wasPlaying) play();
    updateTransportUI();
    emitStatus(true);
    return true;
  }

  /* 播放迴圈（編輯器自驅動）：引擎若不自帶播放迴圈時使用 */
  let manualTimer = 0;
  let manualLast = 0;
  let manualAcc = 0;

  function startManualPlayback() {
    stopManualPlayback();
    manualLast = performance.now();
    manualAcc = 0;
    const interval = Math.max(8, Math.round(1000 / FPS));
    manualTimer = setInterval(() => {
      if (destroyed || !playing) {
        stopManualPlayback();
        return;
      }
      const now = performance.now();
      const dt = Math.min(0.25, (now - manualLast) / 1000);
      manualLast = now;
      manualAcc += dt * FPS;
      let guard = 0;
      while (manualAcc >= 1 && guard < 8) {
        manualAcc -= 1;
        guard += 1;
        try {
          battle.step(1);
        } catch (err) {
          console.warn('[preview] 手動播放 step 失敗：', err);
          playing = false;
        }
      }
      const f = getFrame();
      if (f !== currentFrame) notifyFrame(f);
      if (currentFrame >= durationFrames() || !playing) {
        playing = false;
        stopManualPlayback();
        updateTransportUI();
        emitStatus(true);
      }
    }, interval);
  }

  function stopManualPlayback() {
    if (manualTimer) {
      clearInterval(manualTimer);
      manualTimer = 0;
    }
  }

  /* 編輯器自己的同步迴圈：同步 frame、量測覆蓋層位置。
     刻意不用 rAF——背景分頁與無頭環境下 rAF 會停擺，而這裡只做低頻文字/幾何同步。 */
  let loopTimer = 0;

  function startLoop() {
    if (loopTimer) return;
    loopTimer = setInterval(() => {
      if (destroyed) {
        stopLoop();
        return;
      }
      syncFromBattle();
      updateOverlayGeometry();
    }, 33);
  }

  function stopLoop() {
    if (loopTimer) {
      clearInterval(loopTimer);
      loopTimer = 0;
    }
  }

  function syncFromBattle() {
    if (!ready) return;
    if (playing) {
      const f = getFrame();
      if (f !== currentFrame) notifyFrame(f);
      if (f >= durationFrames()) {
        // 沒有 'end' 事件時自行收斂
        playing = false;
        updateTransportUI();
        emitStatus(true);
      }
    } else if (battle && typeof battle.getState === 'function') {
      try {
        const st = battle.getState();
        if (st && st.ended && playing) {
          playing = false;
          updateTransportUI();
          emitStatus(true);
        }
      } catch (_err) {
        /* 忽略 */
      }
    }
  }

  /* ------------------------------------------------------------ 模式切換 */

  function setMode(nextMode) {
    const target = nextMode === 'play' ? 'play' : 'preview';
    if (target === mode) return;
    const issue = target === 'play' && compileSoulProfiles(currentAttack()).errors[0];
    if (issue) {
      showBanner('<p>' + escapeHtml(issue.path + ': ' + issue.message) + '</p>');
      return;
    }
    if (isDemoActive()) {
      // 自動演示 / 錄製只在預覽編輯狀態；進入試玩前先關閉並還原 preview battle。
      if (recording) stopRecording();
      setAutoplayMode('off');
    }
    const keepFrame = currentFrame;
    if (playing) pause();
    destroyBattle();
    mode = target;
    try {
      battle = createBattleInstance(mode);
      bindBattle(battle);
      ready = true;
      hideBanner();
      applyOptions();
      durationSec = computeDuration();
      try {
        battle.load(currentAttack());
      } catch (err) {
        onEngineError({ message: t('preview.banner.playFailed', { msg: err && err.message ? err.message : err }) });
        throw err;
      }
      if (mode === 'play') {
        playing = true;
        if (typeof battle.play === 'function') battle.play();
        currentFrame = 0;
        notifyFrame(0, true);
      } else {
        seekInternal(keepFrame, true);
      }
    } catch (err) {
      console.error('[preview] 切換模式失敗：', err);
      engineFailure(err);
    }
    updateTransportUI();
    emitStatus(true);
  }

  function enterTry() {
    if (!ready) return false;
    setMode('play');
    return mode === 'play' && ready;
  }

  function exitTry() {
    if (mode !== 'play') return false;
    const frame = currentFrame;
    setMode('preview');
    if (ready) seekInternal(frame, true);
    return true;
  }

  function isTrying() {
    return mode === 'play';
  }

  /* ---------------------------------------------------------- 選項開關 */

  function setOption(name, value) {
    if (!(name in options)) return;
    options[name] = Boolean(value);
    applyOptions();
    redraw();
    emitStatus(true);
  }

  /**
   * 切換戰鬥畫面語言（中／EN）。
   * 使用者手動按過之後就不再跟隨編輯器語系（記在 localStorage）。
   * @param {'zh'|'en'} [next] 省略＝在中／EN 之間切換
   * @returns {'zh'|'en'} 切換後的語言
   */
  function setBattleLang(next) {
    const target = next === 'zh' || next === 'en' ? next : effectiveBattleLang() === 'en' ? 'zh' : 'en';
    manualBattleLang = target;
    writeManualBattleLang(target);
    applyOptions();
    redraw();
    updateBattleLangButton();
    emitStatus(true);
    return target;
  }

  /** 回到「跟隨編輯器語系」（清除手動設定） */
  function followLocaleBattleLang() {
    manualBattleLang = null;
    writeManualBattleLang(null);
    applyOptions();
    redraw();
    updateBattleLangButton();
    emitStatus(true);
    return effectiveBattleLang();
  }

  function getBattleLang() {
    return effectiveBattleLang();
  }

  function redraw() {
    if (!battle) return;
    if (isDemoActive() && battle.mode === 'play') {
      // 自動演示中不能用 battle.seek（會重模擬而沒有 pilot 輸入），只重畫目前狀態
      try {
        battle.step(0);
      } catch (_err) {
        /* 忽略 */
      }
      return;
    }
    const f = currentFrame;
    if (typeof battle.seek === 'function') {
      try {
        battle.seek(f);
      } catch (err) {
        console.warn('[preview] 重繪失敗：', err);
      }
    } else if (typeof battle.step === 'function') {
      try {
        battle.step(0);
      } catch (_err) {
        /* 忽略 */
      }
    }
  }

  /* -------------------------------------------------- 素材載入後重畫 */
  /**
   * 引擎圖片是 lazy load：draw 時沒載完就畫洋紅佔位，圖片到位後
   * 引擎不會自己重畫（暫停時尤其明顯）。這裡監聽 assets.onProgress，
   * 載入中節流重畫（最多每 120ms 一次），全部完成再畫一次。
   */
  const ASSET_REPAINT_INTERVAL = 120;
  let assetsUnsub = null;
  let assetRepaintTimer = 0;
  let lastAssetRepaintAt = 0;

  function repaintNow() {
    assetRepaintTimer = 0;
    lastAssetRepaintAt = Date.now();
    redraw();
  }

  function scheduleAssetRepaint(wait = 0) {
    if (destroyed || assetRepaintTimer) return;
    assetRepaintTimer = setTimeout(repaintNow, Math.max(0, Number(wait) || 0));
  }

  function scheduleThrottledRepaint() {
    if (destroyed) return;
    scheduleAssetRepaint(Math.max(0, ASSET_REPAINT_INTERVAL - (Date.now() - lastAssetRepaintAt)));
  }

  function armAssetRepaint() {
    if (assetsUnsub || destroyed) return;
    if (!assets || typeof assets.onProgress !== 'function') return;
    try {
      assetsUnsub = assets.onProgress((snap) => {
        if (destroyed) return;
        const pending = snap && Number.isFinite(Number(snap.pending)) ? Number(snap.pending) : 0;
        if (pending > 0) scheduleThrottledRepaint();
        else scheduleAssetRepaint(0);
      });
    } catch (err) {
      console.warn('[preview] assets.onProgress 掛載失敗：', err);
      assetsUnsub = null;
    }
  }

  /* ------------------------------------------------------------ 縮放/版面 */

  function computeScale() {
    const host = stage || (viewport.parentElement || viewport);
    const pad = 20;
    const availW = Math.max(120, (host ? host.clientWidth : 640) - pad);
    const availH = Math.max(120, (host ? host.clientHeight : 480) - pad);
    let s = Math.min(availW / VIEW_W, availH / VIEW_H);
    if (s >= 1) {
      s = Math.floor(s);
      // 若整數倍浪費太多空間，允許 0.5 級距以維持可讀性
      if (s >= 2 && availW / VIEW_W - s >= 0.9 && availH / VIEW_H - s >= 0.5) s += 0.5;
    } else {
      // 縮小時「向下取整」到 0.05 級距：寧可留一點黑邊，也不要讓 640×480 的畫面被舞台裁掉
      s = Math.max(0.25, (Math.floor(s * 20 + 1e-9) / 20));
    }
    return s;
  }

  function applyScale() {
    scale = computeScale();
    viewport.style.width = `${Math.round(VIEW_W * scale)}px`;
    viewport.style.height = `${Math.round(VIEW_H * scale)}px`;
    if (battle) {
      const payload = { showHitboxes: options.showHitboxes, showGrid: options.showGrid, muted: options.muted, scale };
      safeCall(battle, 'setOptions', payload);
    }
    updateOverlayGeometry();
    emitStatus(true);
  }

  function resize() {
    if (destroyed) return;
    applyScale();
    redraw();
  }

  /* -------------------------------------------------------------- 覆蓋層 */

  function overlayEnabled() {
    return mode === 'preview' && !playing && ready;
  }

  function currentBoxRect() {
    const box = currentBox();
    return { ...computeBoxRect(box), rotation: box.rotation };
  }

  let boundaryOverlay;
  function updateBoundaryOverlay() {
    const { arena, clip } = currentGeometry();
    const points = arena.kind === 'polygon' ? arena.points : arena.kind === 'stage' ? [
      { x: 1, y: 1 }, { x: VIEW_W - 1, y: 1 },
      { x: VIEW_W - 1, y: STAGE_BOX.h }, { x: 1, y: STAGE_BOX.h },
    ] : null;
    if (!points && !clip && !boundaryOverlay) return;
    if (!boundaryOverlay) {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('viewBox', `0 0 ${VIEW_W} ${VIEW_H}`);
      svg.setAttribute('class', 'arena-boundary-overlay');
      svg.setAttribute('aria-hidden', 'true');
      svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none';
      const polygon = (color, dash) => {
        const shape = document.createElementNS(svg.namespaceURI, 'polygon');
        shape.setAttribute('fill', 'none');
        shape.setAttribute('stroke', color);
        shape.setAttribute('stroke-width', '2');
        shape.setAttribute('stroke-dasharray', dash);
        svg.appendChild(shape);
        return shape;
      };
      boundaryOverlay = { arena: polygon('#54e4ff', '8 4'), clip: polygon('#ffb24d', '3 4') };
      overlay.prepend(svg);
    }
    boundaryOverlay.arena.setAttribute('points', (points || []).map((p) => `${p.x},${p.y}`).join(' '));
    boundaryOverlay.clip.setAttribute('points', (clip?.points || []).map((p) => `${p.x},${p.y}`).join(' '));
  }

  function updateOverlayGeometry() {
    if (!overlay || !boxShape) return;
    const visible = overlayEnabled();
    overlay.hidden = !visible;
    if (demoOverlay) {
      const showDemo = visible && demoOverlayVisible;
      demoOverlay.setVisible(showDemo);
      if (showDemo) demoOverlay.refresh();
    }
    if (!visible) return;
    updateBoundaryOverlay();
    const rect = currentBoxRect();
    const leftPct = (rect.left / VIEW_W) * 100;
    const topPct = (rect.top / VIEW_H) * 100;
    const wPct = (rect.w / VIEW_W) * 100;
    const hPct = (rect.h / VIEW_H) * 100;
    boxShape.style.left = `${leftPct}%`;
    boxShape.style.top = `${topPct}%`;
    boxShape.style.width = `${wPct}%`;
    boxShape.style.height = `${hPct}%`;
    const rot = num(currentBox().rotation, 0);
    boxShape.style.transform = rot ? `rotate(${rot}deg)` : '';
    boxShape.style.transformOrigin = 'center center';
  }

  /* ----------------------------------------------------------- 戰鬥框拖曳 */

  let dragState = null;

  function pointerToLogical(ev) {
    const rect = stageViewportRect();
    const x = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * VIEW_W;
    const y = ((ev.clientY - rect.top) / Math.max(1, rect.height)) * VIEW_H;
    return { x, y };
  }

  function stageViewportRect() {
    return viewport.getBoundingClientRect();
  }

  function commitBox(patch, label, coalesceKey) {
    if (!store || typeof store.update !== 'function') return;
    store.update(
      (draft) => {
        if (!draft.box || typeof draft.box !== 'object') draft.box = {};
        for (const key of Object.keys(patch)) {
          if (patch[key] === null) delete draft.box[key];
          else draft.box[key] = patch[key];
        }
      },
      { label, coalesceKey },
    );
  }

  function beginDrag(ev, handle) {
    if (!overlayEnabled()) return;
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const box = currentBox();
    const rect = currentBoxRect();
    dragState = {
      handle: handle || 'move',
      pointerId: ev.pointerId,
      startClient: { x: ev.clientX, y: ev.clientY },
      startBox: { ...box },
      startRect: { left: rect.left, top: rect.top, w: rect.w, h: rect.h },
      moved: false,
    };
    dragging = true;
    try {
      boxShape.setPointerCapture(ev.pointerId);
    } catch (_err) {
      /* 忽略 */
    }
    boxShape.classList.add('is-dragging');
    document.body.classList.add('is-box-dragging');
  }

  function moveDrag(ev) {
    if (!dragState) return;
    const rect = stageViewportRect();
    const sx = VIEW_W / Math.max(1, rect.width);
    const sy = VIEW_H / Math.max(1, rect.height);
    const dx = (ev.clientX - dragState.startClient.x) * sx;
    const dy = (ev.clientY - dragState.startClient.y) * sy;
    if (Math.abs(dx) < 0.3 && Math.abs(dy) < 0.3) return;
    dragState.moved = true;

    const handle = dragState.handle;
    const start = dragState.startBox;

    // 中心點：旋轉不影響位移，螢幕位移直接加到 x/y
    if (handle === 'move') {
      const nx = Math.round(start.x + dx);
      const ny = Math.round(start.y + dy);
      commitBox({ x: nx, y: ny }, t('preview.box.move'), 'box:move');
      return;
    }

    // 拖角／拖邊：以中心對稱縮放（x/y 不變），rotation 時把螢幕位移投影回框的局部軸
    const rot = (num(start.rotation, 0) * Math.PI) / 180;
    let lx = dx;
    let ly = dy;
    if (rot) {
      const cos = Math.cos(rot);
      const sin = Math.sin(rot);
      lx = dx * cos + dy * sin;
      ly = -dx * sin + dy * cos;
    }
    let w = Math.max(MIN_BOX, num(start.w, BOX_DEFAULTS.w));
    let h = Math.max(MIN_BOX, num(start.h, BOX_DEFAULTS.h));
    if (handle.includes('e')) w += lx * 2;
    if (handle.includes('w')) w -= lx * 2;
    if (handle.includes('s')) h += ly * 2;
    if (handle.includes('n')) h -= ly * 2;
    w = Math.max(MIN_BOX, w);
    h = Math.max(MIN_BOX, h);
    commitBox(
      { x: Math.round(start.x), y: Math.round(start.y), w: Math.round(w), h: Math.round(h) },
      t('preview.box.resize'),
      `box:resize:${handle}`,
    );
  }

  function endDrag(ev) {
    if (!dragState) return;
    const state = dragState;
    dragState = null;
    dragging = false;
    boxShape.classList.remove('is-dragging');
    document.body.classList.remove('is-box-dragging');
    try {
      if (ev && ev.pointerId !== undefined) boxShape.releasePointerCapture(ev.pointerId);
    } catch (_err) {
      /* 忽略 */
    }
    if (store && typeof store.endCoalesce === 'function') store.endCoalesce();
    if (pendingReload) {
      pendingReload = false;
      const wasReset = pendingReloadReset;
      pendingReloadReset = false;
      const wasPlaying = playing;
      runValidation();
      loadCurrent(wasReset);
      if (wasPlaying) play();
      emitStatus(true);
    }
  }

  function attachBoxHandlers() {
    if (!boxShape) return;
    const onDown = (ev) => {
      const target = ev.target;
      const handleEl = target && target.closest ? target.closest('[data-handle]') : null;
      const handle = handleEl ? handleEl.getAttribute('data-handle') : 'move';
      beginDrag(ev, handle);
    };
    boxShape.addEventListener('pointerdown', onDown);
    boxShape.addEventListener('pointermove', moveDrag);
    boxShape.addEventListener('pointerup', endDrag);
    boxShape.addEventListener('pointercancel', endDrag);
    boxShape.addEventListener('lostpointercapture', endDrag);
  }

  /* ------------------------------------------------------------ store 連動 */

  let unsubscribeStore = null;

  function scheduleRefresh(change) {
    if (refreshScheduled) return;
    // 拖曳 demo 路徑點時每一像素都會觸發 store 變更；拖曳中不需要重載戰鬥
    if (demoDragging) return;
    // 拖曳戰鬥框時每一像素都會觸發 store 變更；先記下來，放開滑鼠再重載
    if (dragging) {
      pendingReload = true;
      pendingReloadReset = pendingReloadReset || Boolean(change && change.reset);
      return;
    }
    refreshScheduled = true;
    const run = () => {
      refreshScheduled = false;
      if (destroyed) return;
      if (!ready) {
        runValidation();
        emitStatus(true);
        return;
      }
      runValidation();
      const resetFrame = Boolean(change && change.reset);
      const wasPlaying = playing;
      loadCurrent(resetFrame || currentFrame >= durationFrames());
      if (wasPlaying) play();
      emitStatus(true);
      // V2-06：路徑／戰鬥框／bpm 改了 → 實際軌跡要重算（延遲，避免連續編輯跑不停）
      scheduleTraceRefresh();
    };
    // 用 setTimeout 而非 rAF：背景分頁或無 rAF 的環境也要能更新
    setTimeout(run, 0);
  }

  function subscribeStore() {
    if (!store || typeof store.subscribe !== 'function') return;
    unsubscribeStore = store.subscribe((_s, change) => {
      if (!change) return;
      if (change.errors || change.selectionOnly) return;
      if (suppressReload) return;
      if (change.saved) return;
      scheduleRefresh(change);
    });
  }

  /* ---------------------------------------------------------- 傳輸列 UI */

  function updateTimecodeUI() {
    const el = typeof document !== 'undefined' ? document.getElementById('timecode') : null;
    if (!el) return;
    const total = Math.round(durationSec * FPS);
    el.innerHTML =
      `<span class="tc-now">${formatTimecode(currentFrame)}</span>` +
      `<span class="tc-sep">/</span>` +
      `<span class="tc-dim">${formatTimecode(total)}</span>`;
    el.title = t('preview.timecode.full', {
      now: (currentFrame / FPS).toFixed(2),
      total: durationSec.toFixed(2),
    });
  }

  function updateTransportUI() {
    const playBtn = typeof document !== 'undefined' ? document.getElementById('btn-play-pause') : null;
    const toolbarPlay = typeof document !== 'undefined' ? document.getElementById('btn-play') : null;
    const stageViewport = viewport;
    if (playBtn) {
      playBtn.textContent = playing ? '❙❙' : '▶';
      playBtn.classList.toggle('is-playing', playing);
      playBtn.title = playing ? t('preview.pause') : t('preview.play');
    }
    if (toolbarPlay) {
      // 工具列按鈕的文字由 HTML 的 data-i18n 提供；只切換播放中的字串
      toolbarPlay.textContent = playing ? t('preview.pause') : t('toolbar.play');
      toolbarPlay.classList.toggle('is-active', playing);
    }
    if (stageViewport) stageViewport.classList.toggle('is-playing', playing);
    updateTimecodeUI();
    updateBattleLangButton();
    const modeChip = typeof document !== 'undefined' ? document.getElementById('preview-mode') : null;
    if (modeChip) {
      const tryMode = mode === 'play';
      modeChip.textContent = tryMode ? t('preview.mode.try') : playing ? t('preview.mode.playing') : t('preview.mode.edit');
      modeChip.classList.toggle('is-try', tryMode);
    }
    updateAutoplayUI();
  }

  /** 「中 / EN」按鈕：文字顯示目前戰鬥語言，title 說明 */
  function updateBattleLangButton() {
    if (typeof document === 'undefined') return;
    const btn = document.getElementById('btn-battle-lang');
    if (!btn) return;
    const lang = effectiveBattleLang();
    btn.textContent = lang === 'en' ? 'EN' : '中';
    btn.classList.toggle('is-en', lang === 'en');
    btn.setAttribute('aria-pressed', lang === 'en' ? 'true' : 'false');
    btn.title = t('preview.battleLang.tip', { lang: lang === 'en' ? t('preview.battleLang.en') : t('preview.battleLang.zh') });
    btn.dataset.lang = lang;
  }

  /* -------------------------------------------------------------- 內容工具 */

  function escapeHtml(text) {
    return String(text == null ? '' : text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* ---------------------------------------------------------------- 啟動 */

  attachBoxHandlers();
  subscribeStore();
  durationSec = computeDuration();
  applyScale();
  init();
  initDemoOverlay();
  ensureDemoControls();
  updateTransportUI();
  updateTimecodeUI();
  updateBattleLangButton();
  startLoop();
  emitStatus(true);

  // 介面語系變更：重繪傳輸列文字；若使用者沒手動切換戰鬥語言，戰鬥語言跟隨
  const unsubscribeLocale = onLocaleChange(() => {
    if (destroyed) return;
    applyOptions();
    redraw();
    updateAutoplayUI();
    updateTransportUI();
    emitStatus(true);
  });

  // 視窗尺寸變動
  let resizeObserver = null;
  if (typeof ResizeObserver === 'function') {
    const host = stage || viewport.parentElement;
    if (host) {
      let resizeTimer = 0;
      resizeObserver = new ResizeObserver(() => {
        if (resizeTimer) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
          if (!destroyed) {
            applyScale();
            redraw();
          }
        }, 90);
      });
      resizeObserver.observe(host);
    }
  }

  /* -------------------------------------------------------------- 公開介面 */

  const preview = {
    // SPEC §10
    get fps() {
      return FPS;
    },
    seek,
    getFrame,
    onFrame,
    duration,

    // 播放控制
    play,
    pause,
    togglePlay,
    step,
    gotoStart,
    restart,
    isPlaying: () => playing,
    isReady: () => ready,

    // 模式
    enterTry,
    exitTry,
    isTrying,
    getMode: () => mode,

    // 自動演示（SPEC-AUTOPLAY §4）
    setAutoplayMode,
    getAutoplayMode: () => autoplayMode,
    isAutoplayOn: () => autoplayMode !== 'off',
    getAutoplayWarnings,
    startRecording,
    stopRecording,
    isRecording: () => recording,
    setDemoOverlayVisible: (v) => {
      demoOverlayVisible = Boolean(v);
      if (demoOverlay) demoOverlay.setVisible(demoOverlayVisible);
      updateOverlayGeometry();
      updateAutoplayUI();
    },
    isDemoOverlayVisible: () => demoOverlayVisible,
    getDemoOverlay: () => demoOverlay,

    // V2-06：實際軌跡疊圖（traceDemo 的跟隨器軌跡 vs 預定路線）
    traceDemoPath,
    clearTrace,
    setTraceVisible,
    isTraceVisible: () => traceVisible,
    getTrace: () => (trace ? { frames: trace.frames, hits: trace.hits, deviation: trace.deviation, summary: trace.summary } : null),
    describeAutopilot,

    // 選項
    setShowGrid: (v) => setOption('showGrid', v),
    setShowHitboxes: (v) => setOption('showHitboxes', v),
    setMuted: (v) => setOption('muted', v),
    getOptions: () => ({ ...options }),
    getScale: () => scale,

    // 狀態 / 事件
    getState: () => {
      if (!battle || typeof battle.getState !== 'function') return null;
      try {
        return battle.getState();
      } catch (_err) {
        return null;
      }
    },
    getBattle: () => battle,
    onStatus: onStatusChange,
    getStatus: () => statusPayload(),
    getErrors: () => {
      const merged = new Map(validationErrors);
      for (const [key, value] of engineErrors) merged.set(key, value);
      return merged;
    },
    hasEngineError: () => engineErrors.size > 0,

    // 戰鬥畫面語言（中／EN）
    setBattleLang,
    getBattleLang,
    followLocaleBattleLang,
    isBattleLangManual: () => manualBattleLang !== null,

    // 維護
    reload: () => {
      if (!ready) return;
      loadCurrent(false);
      emitStatus(true);
    },
    refresh: () => {
      runValidation();
      if (ready) loadCurrent(false);
      emitStatus(true);
      scheduleTraceRefresh();
    },
    resize,
    getBoxRect: () => currentBoxRect(),
    getBoxAnchor: () => ({ ...BOX_ANCHOR }),
    focusStage: () => {
      try {
        viewport.focus();
      } catch (_err) {
        /* 忽略 */
      }
    },
    destroy() {
      destroyed = true;
      stopLoop();
      stopManualPlayback();
      stopDemoLoop();
      unbindRecordKeys();
      recording = false;
      recorder = null;
      if (demoOverlay) {
        try {
          demoOverlay.destroy();
        } catch (_err) {
          /* 忽略 */
        }
        demoOverlay = null;
      }
      if (demoControls) {
        try {
          if (demoControls.wrap && demoControls.wrap.parentNode) demoControls.wrap.parentNode.removeChild(demoControls.wrap);
          if (demoControls.overlayLabel && demoControls.overlayLabel.parentNode) {
            demoControls.overlayLabel.parentNode.removeChild(demoControls.overlayLabel);
          }
        } catch (_err) {
          /* 忽略 */
        }
        demoControls = null;
      }
      try {
        unsubscribeLocale();
      } catch (_err) {
        /* 忽略 */
      }
      if (unsubscribeStore) {
        try {
          unsubscribeStore();
        } catch (_err) {
          /* 忽略 */
        }
        unsubscribeStore = null;
      }
      if (resizeObserver) {
        try {
          resizeObserver.disconnect();
        } catch (_err) {
          /* 忽略 */
        }
        resizeObserver = null;
      }
      if (traceTimer) {
        clearTimeout(traceTimer);
        traceTimer = 0;
      }
      frameSubs.clear();
      statusSubs.clear();
      if (assetRepaintTimer) {
        clearTimeout(assetRepaintTimer);
        assetRepaintTimer = 0;
      }
      if (assetsUnsub) {
        try {
          assetsUnsub();
        } catch (_err) {
          /* 忽略 */
        }
        assetsUnsub = null;
      }
      destroyBattle();
    },
  };

  return preview;
}

export default createPreview;






