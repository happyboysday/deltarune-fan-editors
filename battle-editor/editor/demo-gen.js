/**
 * editor/demo-gen.js — 「自動產生演示路徑」的編輯器端協調層（V2-06）
 *
 * 引擎的 `generateDemoPath`（engine/autoplay/pathgen.js）是**同步長跑**：
 * 一次呼叫可能跑幾百毫秒到數十秒，直接在主執行緒跑會鎖住 UI（連進度條都畫不出來）。
 * 這一層負責：
 *   - 把工作丟進 Web Worker（`editor/demo-worker.js`），主執行緒只收 progress 訊息；
 *   - 瀏覽器沒有 Worker（或建立失敗）時退化為「讓出一幀再同步跑」的分段等待；
 *   - 取消（terminate worker / abort signal）；
 *   - 把結果正規化成可直接寫進 `demo` 的形狀（純函式，方便測試）。
 *
 * 本檔不碰 DOM；Worker 由注入的 `workerFactory` 建立，Node 測試可傳入假物件。
 */

import { generateDemoPath, PATHGEN_DEFAULTS } from '../engine/autoplay/index.js';
import { MAX_PATH_POINTS, roundDemoValue } from './demo-path.js';

/** 產生路徑的預設參數（時間預算刻意比 CLI 短：編輯器要能等）。 */
export const GEN_DEFAULTS = Object.freeze({
  seed: 1,
  step: 0.3,
  timeBudgetMs: 8000,
});

/** 進度回報的最小間隔（毫秒）：Worker 可能每節點回報一次，UI 不必跟著抖）。 */
export const PROGRESS_THROTTLE_MS = 120;

/** 把使用者／呼叫端給的選項收斂成引擎吃得下的形狀。 */
export function normalizeGenOptions(options) {
  const src = options && typeof options === 'object' ? options : {};
  const seed = Number.isFinite(src.seed) ? Math.trunc(src.seed) : GEN_DEFAULTS.seed;
  const step = Number.isFinite(src.step) && src.step > 0 ? src.step : GEN_DEFAULTS.step;
  const timeBudgetMs = Number.isFinite(src.timeBudgetMs) && src.timeBudgetMs > 0
    ? Math.min(120000, Math.max(200, Math.round(src.timeBudgetMs)))
    : GEN_DEFAULTS.timeBudgetMs;
  return { seed, step, timeBudgetMs };
}

/** 進度訊息正規化：引擎的 progress payload → UI 需要的欄位（缺的都給安全預設）。 */
export function normalizeProgress(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const n = (v, d = 0) => (Number.isFinite(v) ? v : d);
  return {
    phase: typeof p.phase === 'string' ? p.phase : '',
    sweep: n(p.sweep),
    index: n(p.index),
    nodes: n(p.nodes),
    hits: n(p.hits),
    firstHit: Number.isFinite(p.firstHit) ? p.firstHit : null,
    bestCost: Number.isFinite(p.bestCost) ? p.bestCost : null,
    elapsedMs: n(p.elapsedMs),
  };
}

/**
 * 產生結果 → 可直接寫進存檔的 demo 物件（純函式）。
 *
 * 引擎回傳的路徑點已經是秒數（pathgen 只吃秒），這裡只做：
 *   - 座標 / 時間四捨五入（與表格編輯一致的精度）
 *   - 丟掉壞點、超過 MAX_PATH_POINTS 截斷
 *   - mode 固定 'path'，fallback 缺省 'bot'（沿用產生器的建議）
 */
export function buildDemoFromResult(result) {
  const src = result && typeof result === 'object' ? result : {};
  const demo = src.demo && typeof src.demo === 'object' ? src.demo : {};
  const path = Array.isArray(src.path) ? src.path : Array.isArray(demo.path) ? demo.path : [];
  const points = [];
  for (const raw of path) {
    if (points.length >= MAX_PATH_POINTS) break;
    if (!raw || typeof raw !== 'object') continue;
    const t = Number(raw.t);
    const x = Number(raw.x);
    const y = Number(raw.y);
    if (!Number.isFinite(t) || !Number.isFinite(x) || !Number.isFinite(y)) continue;
    const point = { t: roundDemoValue(Math.max(0, t), 3), x: roundDemoValue(x), y: roundDemoValue(y) };
    if (raw.slow === true) point.slow = true;
    const hold = Number(raw.hold);
    if (Number.isFinite(hold) && hold > 0) point.hold = roundDemoValue(hold, 3);
    points.push(point);
  }
  const out = { mode: 'path', fallback: typeof demo.fallback === 'string' ? demo.fallback : 'bot', path: points };
  if (typeof demo.inputs === 'string' && demo.inputs.trim() !== '') out.inputs = demo.inputs;
  return out;
}

/** 產生結果摘要（給面板顯示用；純函式）。 */
export function summarizeGenResult(result) {
  const src = result && typeof result === 'object' ? result : {};
  const hits = Array.isArray(src.hits) ? src.hits.length : Number.isFinite(src.hits) ? src.hits : 0;
  const hitFrames = Array.isArray(src.hitFrames) ? src.hitFrames.slice() : [];
  const demo = buildDemoFromResult(src);
  return {
    ok: src.ok !== false && demo.path.length > 0,
    hits,
    hitFrames,
    points: demo.path.length,
    clearance: Number.isFinite(src.best?.minClearance) ? src.best.minClearance : null,
    clearanceTarget: src.clearanceTarget,
    clearanceMet: src.clearanceMet !== false,
    attempts: Number.isFinite(src.attempts) ? src.attempts : 0,
    elapsedMs: Number.isFinite(src.elapsedMs) ? src.elapsedMs : 0,
    reason: typeof src.reason === 'string' ? src.reason : src.aborted ? 'aborted' : 'ok',
    aborted: src.aborted === true || src.reason === 'aborted',
  };
}

/**
 * 把 attack 的 demo 換成產生結果（回傳新 demo 物件；不動原物件）。
 * 產生結果為空時回傳 null，呼叫端應該維持原狀。
 */
export function nextDemoForResult(result) {
  const demo = buildDemoFromResult(result);
  if (demo.path.length === 0) return null;
  return demo;
}

/**
 * 真正的 Worker 工廠（瀏覽器才有 Worker；Node / 舊瀏覽器回 null）。
 * @param {any} [workerCtor] 測試可注入假建構子
 * @param {string} [url]  worker module URL（預設 ./demo-worker.js）
 */
export function createWorkerFactory(workerCtor, url) {
  const Ctor = workerCtor || (typeof Worker !== 'undefined' ? Worker : null);
  if (!Ctor) return null;
  return () => new Ctor(url || new URL('./demo-worker.js', import.meta.url), { type: 'module' });
}

/** 讓出一個 macrotask，讓瀏覽器有機會重繪（分段等待用）。 */
function yieldToUi() {
  return new Promise((resolve) => {
    if (typeof setTimeout === 'function') setTimeout(resolve, 0);
    else resolve();
  });
}

/**
 * 非同步產生演示路徑。
 *
 * @param {object} attackDoc 目前攻擊檔（會被 structured clone 進 Worker）
 * @param {object} [options]
 * @param {(p:object)=>void} [options.onProgress] 進度回呼（已節流）
 * @param {AbortSignal} [options.signal] 取消
 * @param {() => Worker|null} [options.workerFactory] 建立 Worker；回 null 則退化為同步分段跑
 * @param {number} [options.seed] / [options.step] / [options.timeBudgetMs]
 * @returns {Promise<{result:object|null, cancelled:boolean, error:string|null}>}
 */
export async function generatePathAsync(attackDoc, options = {}) {
  const opts = normalizeGenOptions(options);
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const signal = options.signal || null;
  const workerFactory = typeof options.workerFactory === 'function' ? options.workerFactory : null;

  let lastEmit = 0;
  const emit = (payload) => {
    if (!onProgress) return;
    const p = normalizeProgress(payload);
    const now = Date.now();
    if (now - lastEmit < PROGRESS_THROTTLE_MS) return;
    lastEmit = now;
    try {
      onProgress(p);
    } catch (_err) {
      /* 進度回呼出錯不影響產生 */
    }
  };

  if (signal && signal.aborted) {
    return { result: null, cancelled: true, error: null };
  }

  const worker = workerFactory ? safeWorker(workerFactory) : null;
  if (worker) {
    return runInWorker(worker, attackDoc, opts, { emit, signal });
  }
  return runInline(attackDoc, opts, { emit, signal });
}

function safeWorker(factory) {
  try {
    const w = factory();
    if (!w || typeof w.postMessage !== 'function') return null;
    return w;
  } catch (err) {
    console.warn('[demo-gen] 建立 Worker 失敗，改在主執行緒分段執行：', err);
    return null;
  }
}

function runInWorker(worker, attackDoc, opts, { emit, signal }) {
  return new Promise((resolve) => {
    let settled = false;
    let abortListener = null;

    const cleanup = () => {
      if (abortListener && signal && typeof signal.removeEventListener === 'function') {
        signal.removeEventListener('abort', abortListener);
      }
      abortListener = null;
      try {
        worker.terminate();
      } catch (_err) {
        /* 忽略 */
      }
    };
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(payload);
    };
    const onAbort = () => finish({ result: null, cancelled: true, error: null });
    if (signal && typeof signal.addEventListener === 'function') {
      abortListener = onAbort;
      signal.addEventListener('abort', onAbort);
    }

    worker.onmessage = (ev) => {
      const msg = ev && ev.data && typeof ev.data === 'object' ? ev.data : {};
      if (msg.type === 'progress') {
        emit(msg.payload);
        return;
      }
      if (msg.type === 'done') {
        finish({ result: msg.result || null, cancelled: false, error: null });
        return;
      }
      if (msg.type === 'error') {
        finish({ result: null, cancelled: false, error: String(msg.message || 'generate failed') });
      }
    };
    worker.onerror = (err) => {
      const message = err && err.message ? err.message : 'worker error';
      finish({ result: null, cancelled: false, error: String(message) });
    };

    try {
      worker.postMessage({ type: 'generate', attack: attackDoc, options: opts });
    } catch (err) {
      finish({ result: null, cancelled: false, error: String((err && err.message) || err) });
    }
  });
}

async function runInline(attackDoc, opts, { emit, signal }) {
  // 先讓出一幀：UI 才畫得出「產生中…」的狀態
  await yieldToUi();
  if (signal && signal.aborted) return { result: null, cancelled: true, error: null };
  try {
    const result = generateDemoPath(attackDoc, {
      seed: opts.seed,
      step: opts.step,
      timeBudgetMs: opts.timeBudgetMs,
      onProgress: (payload) => emit(payload),
    });
    if (signal && signal.aborted) return { result: null, cancelled: true, error: null };
    return { result, cancelled: false, error: null };
  } catch (err) {
    return { result: null, cancelled: false, error: String((err && err.message) || err) };
  } finally {
    await yieldToUi();
  }
}

export { PATHGEN_DEFAULTS };
