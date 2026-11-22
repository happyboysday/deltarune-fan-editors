/**
 * editor/demo-path.js — 攻擊「演示 demo」的純邏輯（AP4）
 *
 * 這裡只放不碰 DOM 的計算，讓檢查器（demo 區）、預覽疊加層與 Node 測試共用：
 *   - 路徑點正規化 / 排序 / 增刪 / 上下移
 *   - 時間軸（t + hold）與插值目標點：語意必須與 engine/autoplay/soul.js 一致
 *     （SPEC-AUTOPLAY §2.1：每幀朝相鄰點間依時間線性插值的目標移動）
 *   - 邏輯座標夾回戰鬥框（旋轉感知，margin = 靈魂半徑）
 *   - demo.inputs 的狀態摘要（段數 / 幀數 / 解析錯誤）
 *
 * 引擎（engine/**）不改；本檔只讀 engine/autoplay 的公開匯出。
 */

import { projectDodgePoint } from '../engine/autoplay/bot.js';
import { compileArena } from '../engine/arena.js';
import { parseEncodedInputs } from '../engine/autoplay/soul.js';
import { BOX_DEFAULTS } from '../engine/attack.js';
import { normalizeFrameInput } from '../engine/input.js';
// 拍點（SPEC-EXPR-V2 §2）：demo.path[].t 是時間「點」，可寫 `"2b"`（會加 beatOffset）。
import { formatLike, normalizeTiming, parseTime } from './beat.js';

/** 與自動演示相同的幀率（SPEC-AUTOPLAY §2.1）。 */
export const DEMO_FPS = 30;
/** 靈魂半徑：拖曳/新增路徑點時至少離框邊這麼多（與 soul pilot 的 clamp 一致）。 */
export const DEMO_MARGIN = 4;
/** 路徑點數量上限（避免 UI/驗證被壞資料拖垮）。 */
export const MAX_PATH_POINTS = 200;
export const DEMO_MODES = ['path', 'inputs', 'bot'];
export const DEMO_FALLBACK_MODES = ['bot', 'stay'];

function isObj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function numOr(value, fallback) {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 四捨五入到小數第二位（時間/座標都用這個精度寫回 store）。 */
export function roundDemoValue(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const p = 10 ** digits;
  const rounded = Math.round(n * p) / p;
  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * 把單一路徑點正規化成 {t,x,y,slow,hold}；壞資料回傳 null。
 *
 * t 可為秒數或拍點字串（`"2b"`，SPEC-EXPR-V2 §2）；傳入 opts.timing（settings）
 * 時會把拍點字串換算成秒再寫入（疊加層、預覽、引擎都只吃秒數）。
 */
export function normalizeDemoPoint(raw, opts = {}) {
  if (!isObj(raw)) return null;
  let t = raw.t;
  if (typeof t === 'string') {
    const timing = opts.timing ? normalizeTiming(opts.timing) : null;
    if (!timing || !timing.hasBpm) return null;
    const parsed = parseTime(t, timing, { addOffset: true, allowNegative: false });
    if (!parsed.ok || parsed.empty) return null;
    t = parsed.seconds;
  }
  if (!isNum(t) || t < 0) return null;
  if (!isNum(raw.x) || !isNum(raw.y)) return null;
  const point = {
    t: roundDemoValue(t, 3),
    x: roundDemoValue(raw.x),
    y: roundDemoValue(raw.y),
  };
  if (raw.slow === true) point.slow = true;
  const hold = numOr(raw.hold, 0);
  if (hold > 0) point.hold = roundDemoValue(hold, 3);
  return point;
}

/** 把 path 陣列正規化（丟掉壞點；保留 t 排序）。opts.timing 用於解析拍點字串 t。 */
export function normalizeDemoPath(points, opts = {}) {
  if (!Array.isArray(points)) return [];
  return sortDemoPath(points.map((p) => normalizeDemoPoint(p, opts)).filter(Boolean));
}

/** 依 t 排序（穩定；t 非有限值的點排到最後，保留原順序）。 */
export function sortDemoPath(points, opts = {}) {
  if (!Array.isArray(points)) return [];
  const timing = opts.timing ? normalizeTiming(opts.timing) : null;
  const keyOf = (point) => {
    if (!isObj(point)) return Infinity;
    if (isNum(point.t)) return point.t;
    if (timing && typeof point.t === 'string') {
      const parsed = parseTime(point.t, timing, { addOffset: true });
      if (parsed.ok && !parsed.empty) return parsed.seconds;
    }
    return Infinity;
  };
  return points
    .map((point, index) => ({ point, index, key: keyOf(point) }))
    .sort((a, b) => (a.key === b.key ? a.index - b.index : a.key - b.key))
    .map((entry) => entry.point);
}

/**
 * 建立時間軸：與 engine/autoplay/soul.js 的私有 buildPathTimeline 相同語意。
 * starts[i] = max(t_i, starts[i-1] + hold_{i-1})；end = 最後一段的 start + hold。
 * opts.timing 讓 `t: "2b"` 也能參與計算（引擎端永遠只看到秒數）。
 * @returns {{points:any[], starts:number[], end:number}|null}
 */
export function buildDemoTimeline(points, opts = {}) {
  const list = normalizeDemoPath(points, opts);
  if (list.length === 0) return null;
  const starts = [];
  for (let i = 0; i < list.length; i += 1) {
    const t = list[i].t;
    if (i === 0) starts.push(t);
    else {
      const previous = list[i - 1];
      starts.push(Math.max(t, starts[i - 1] + numOr(previous.hold, 0)));
    }
  }
  const last = list[list.length - 1];
  return { points: list, starts, end: starts[starts.length - 1] + numOr(last.hold, 0) };
}

/**
 * 時間 t（秒）的插值目標點：與 engine/autoplay/soul.js 的 pathTargetAt 相同語意。
 * - t >= end → null（腳本用完，交給 fallback）
 * - 只有一點 → 該點
 * - 段內 → 線性插值 x/y；slow 取前一點；hold 已計入 starts
 * @returns {{x:number,y:number,slow:boolean,t:number}|null}
 */
export function demoPathTargetAt(timeline, time) {
  if (!timeline || !Number.isFinite(time)) return null;
  if (time >= timeline.end) return null;
  const { points, starts } = timeline;
  if (points.length === 1) {
    const p = points[0];
    return { x: p.x, y: p.y, slow: p.slow === true, t: starts[0] };
  }
  let i = 0;
  for (; i < points.length - 1; i += 1) {
    if (time < starts[i + 1]) break;
  }
  if (i >= points.length - 1) i = points.length - 2;
  const a = points[i];
  const b = points[i + 1];
  if (time <= starts[i]) return { x: a.x, y: a.y, slow: a.slow === true, t: starts[i] };
  const span = starts[i + 1] - starts[i];
  const u = span > 0 ? (time - starts[i]) / span : 1;
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    slow: a.slow === true,
    t: time,
  };
}

/** 幀 → 秒（30fps）。 */
export function demoFrameToTime(frame) {
  return numOr(frame, 0) / DEMO_FPS;
}

/** 秒 → 幀（四捨五入）。 */
export function demoTimeToFrame(time) {
  return Math.round(numOr(time, 0) * DEMO_FPS);
}

/** 路徑總長（秒）；空路徑回 0。opts.timing 讓拍點字串 t 也能算。 */
export function demoPathDuration(points, opts = {}) {
  const timeline = buildDemoTimeline(points, opts);
  return timeline ? timeline.end : 0;
}

/** 取得攻擊檔的戰鬥框（缺欄位時用引擎預設值），供夾點使用。 */
export function demoBoxFor(attack) {
  const box = attack && isObj(attack.box) ? attack.box : {};
  return {
    x: numOr(box.x, BOX_DEFAULTS.x),
    y: numOr(box.y, BOX_DEFAULTS.y),
    w: Math.max(0, numOr(box.w, BOX_DEFAULTS.w)),
    h: Math.max(0, numOr(box.h, BOX_DEFAULTS.h)),
    rotation: numOr(box.rotation, BOX_DEFAULTS.rotation || 0),
    ...(attack?.arena ? { arena: compileArena(attack.arena) } : {}),
  };
}

/** 把邏輯座標夾回（可旋轉的）戰鬥框內，並四捨五入。 */
export function clampDemoPoint(x, y, box, margin = DEMO_MARGIN) {
  if (!box) return { x: roundDemoValue(x), y: roundDemoValue(y) };
  const clamped = projectDodgePoint(box.arena, box, numOr(x, box.x), numOr(y, box.y), margin);
  return { x: roundDemoValue(clamped.x), y: roundDemoValue(clamped.y) };
}

/**
 * 新增路徑點（回傳新陣列，不改原陣列）。
 * 超過 MAX_PATH_POINTS 時回傳原陣列（呼叫端應提示）。
 */
export function addDemoPoint(points, point) {
  const list = Array.isArray(points) ? points.slice() : [];
  if (list.length >= MAX_PATH_POINTS) return list;
  const normalized = normalizeDemoPoint(point);
  if (!normalized) return list;
  list.push(normalized);
  return sortDemoPath(list);
}

/** 刪除路徑點（回傳新陣列）。 */
export function removeDemoPoint(points, index) {
  const list = Array.isArray(points) ? points.slice() : [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return list;
  list.splice(index, 1);
  return list;
}

/**
 * 上下移：與相鄰點交換 t（時間先後互換），再依 t 重新排序。
 * 這樣「上移」＝把點移到更前面的時間，「下移」＝移到更後面；
 * 座標 / slow / hold 留在原本那一個點上。
 */
export function moveDemoPoint(points, index, delta) {
  const list = Array.isArray(points) ? points.map((point) => (isObj(point) ? { ...point } : point)) : [];
  const i = index;
  const j = index + (delta > 0 ? 1 : -1);
  if (!Number.isInteger(i) || i < 0 || i >= list.length) return list;
  if (j < 0 || j >= list.length) return list;
  const a = list[i];
  const b = list[j];
  if (!isObj(a) || !isObj(b) || !isNum(a.t) || !isNum(b.t)) return list;
  if (a.t === b.t) return list;
  const t = a.t;
  a.t = b.t;
  b.t = t;
  return sortDemoPath(list);
}

/** 時間標籤（疊加層用），例如 1.2s。 */
export function formatDemoTime(time, digits = 1) {
  const n = numOr(time, 0);
  return `${n.toFixed(digits)}s`;
}

/* ------------------------------------------------------------------ *
 * §4-7 數值表格：單一儲存格的寫入邏輯（純函式）
 *
 * 表格每列 = 一個路徑點，欄位 t / x / y / slow / hold。
 * 直接編輯時**不重排索引**（拖曳疊加層以 index 定址），改成把 t 夾在
 * 前後鄰點之間；這樣表格列與預覽上的圓點永遠是同一個點。
 * ------------------------------------------------------------------ */

/** demo 路徑點可編輯的欄位（順序即表格欄位順序）。 */
export const DEMO_POINT_FIELDS = Object.freeze(['t', 'x', 'y', 'slow', 'hold']);

/* ------------------------------------------------------------------ *
 * B13：預覽自動演示的鍵盤循環（純邏輯）
 * ------------------------------------------------------------------ */

/** 預覽自動演示可以切換的模式順序：關 → 腳本 → AI → 關。 */
export const AUTOPLAY_CYCLE = Object.freeze(['off', 'demo', 'bot']);

/**
 * 這份攻擊是否含有可用的 demo 內容（有路徑點、有錄製輸入，或模式指定 bot）。
 * 沒有 demo 時 P 鍵只在「關 ⇄ AI」之間切，避免切到一個什麼都不會動的「腳本」。
 */
export function attackHasDemo(attack) {
  const demo = isObj(attack) && isObj(attack.demo) ? attack.demo : null;
  if (!demo) return false;
  if (demo.mode === 'bot') return true;
  if (Array.isArray(demo.path) && demo.path.some((point) => isObj(point))) return true;
  if (typeof demo.inputs === 'string' && demo.inputs.trim() !== '') return true;
  return false;
}

/**
 * P 鍵的下一態。
 *   - 有 demo：off → demo → bot → off（三態循環）
 *   - 沒 demo：off → bot → off（因為 demo 模式沒有腳本可跑）
 * @param {'off'|'demo'|'bot'|string} current
 * @param {boolean} hasDemo
 * @returns {'off'|'demo'|'bot'}
 */
export function nextAutoplayMode(current, hasDemo) {
  const mode = AUTOPLAY_CYCLE.includes(current) ? current : 'off';
  const order = hasDemo ? AUTOPLAY_CYCLE : ['off', 'bot'];
  const i = order.indexOf(mode);
  // 沒有 demo 卻停在「腳本」模式（例如 demo 剛被刪掉）→ 直接關掉，不要卡在空模式
  if (i < 0) return 'off';
  return order[(i + 1) % order.length];
}

/**
 * 把「表格輸入的 t」夾進前後鄰點之間（避免使用者打出遞減時間讓驗證爆掉）。
 * 回傳四捨五入到毫秒、且 ≥ 0 的數字。
 *
 * opts.timing：鄰點的 t 可能是拍點字串（SPEC-EXPR-V2 §2），一併換算成秒再比較。
 */
export function clampDemoTime(points, index, time, opts = {}) {
  const list = Array.isArray(points) ? points : [];
  const timing = opts.timing ? normalizeTiming(opts.timing) : null;
  const n = numOr(time, 0);
  const timeOf = (p) => {
    if (!isObj(p)) return null;
    if (isNum(p.t)) return p.t;
    if (timing && typeof p.t === 'string') {
      const parsed = parseTime(p.t, timing, { addOffset: true });
      if (parsed.ok && !parsed.empty) return parsed.seconds;
    }
    return null;
  };
  let lo = 0;
  let hi = Infinity;
  for (let i = 0; i < list.length; i += 1) {
    const pTime = timeOf(list[i]);
    if (pTime === null) continue;
    if (i < index) lo = Math.max(lo, pTime);
    else if (i > index) hi = Math.min(hi, pTime);
  }
  const clamped = Math.min(Math.max(n, lo), hi);
  return roundDemoValue(clamped, 3);
}

/**
 * 設定某一路徑點的單一欄位，回傳新陣列（不改原陣列）。
 *
 * 規則（與 validateAttackDemo 相容）：
 *   - t：夾在鄰點之間、≥ 0、四捨五入到毫秒
 *   - x / y：有限數字才寫入，四捨五入到小數第二位
 *   - slow：布林；false 時刪掉欄位（保持 JSON 乾淨）
 *   - hold：≥ 0 的秒數；0 / null 時刪掉欄位
 *   - 空字串（value === null 或 ''）→ t/x/y 忽略（回傳原陣列），hold/slow 視為清除
 *   - t 可給拍點字串（`"2b"`）：會依 opts.timing 換算成秒後夾進鄰點之間
 * @param {any[]} points
 * @param {number} index
 * @param {'t'|'x'|'y'|'slow'|'hold'} key
 * @param {any} value
 * @param {{timing?:any}} [opts]
 * @returns {any[]}
 */
export function setDemoPointField(points, index, key, value, opts = {}) {
  const list = Array.isArray(points) ? points.map((p) => (isObj(p) ? { ...p } : p)) : [];
  if (!Number.isInteger(index) || index < 0 || index >= list.length) return list;
  const point = list[index];
  if (!isObj(point)) return list;
  switch (key) {
    case 't': {
      if (value === null || value === '' || value === undefined) return list;
      let n;
      if (typeof value === 'string' && !/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(value.trim())) {
        // 非純數字字串 → 只可能是拍點字串（`"2b"`）
        const timing = opts.timing ? normalizeTiming(opts.timing) : null;
        if (!timing || !timing.hasBpm) return list;
        const parsed = parseTime(value, timing, { addOffset: true, allowNegative: false });
        if (!parsed.ok || parsed.empty) return list;
        n = parsed.seconds;
      } else {
        n = typeof value === 'number' ? value : Number(value);
      }
      if (!Number.isFinite(n)) return list;
      const clamped = clampDemoTime(list, index, n, opts);
      // 存檔保留使用者寫法：原本是拍點字串就繼續寫拍點字串
      const timing = opts.timing ? normalizeTiming(opts.timing) : null;
      point.t = timing && timing.hasBpm
        ? formatLike(clamped, point.t, timing, true)
        : clamped;
      return list;
    }
    case 'x':
    case 'y': {
      if (value === null || value === '' || value === undefined) return list;
      const n = typeof value === 'number' ? value : Number(value);
      if (!Number.isFinite(n)) return list;
      point[key] = roundDemoValue(n);
      return list;
    }
    case 'slow': {
      if (value === true) point.slow = true;
      else delete point.slow;
      return list;
    }
    case 'hold': {
      const n = value === null || value === '' || value === undefined ? 0 : Number(value);
      if (!Number.isFinite(n) || n <= 0) delete point.hold;
      else point.hold = roundDemoValue(n, 3);
      return list;
    }
    default:
      return list;
  }
}

/**
 * demo.inputs 摘要：段數 / 約幾幀 / 解析錯誤。
 * 空字串或非字串 → ok:false、segments:0、frames:0（尚未錄製）。
 */
export function decodeDemoInputs(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    return { ok: false, entries: [], errors: [], segments: 0, frames: 0 };
  }
  const parsed = parseEncodedInputs(text);
  const entries = Array.isArray(parsed && parsed.entries) ? parsed.entries : [];
  const errors = (Array.isArray(parsed && parsed.errors) ? parsed.errors : []).map((err) =>
    err && err.message ? String(err.message) : String(err),
  );
  let frames = 0;
  for (const entry of entries) {
    if (entry && Number.isFinite(entry.frame)) frames = Math.max(frames, entry.frame + 1);
  }
  return { ok: errors.length === 0, entries, errors, segments: entries.length, frames };
}

/** 檢查器 shapeKey 用的 demo 結構簽章（只包含「會改變 DOM 結構」的欄位）。 */
export function demoShapeSignature(demo) {
  const d = isObj(demo) ? demo : {};
  const path = Array.isArray(d.path) ? d.path : [];
  const inputs = typeof d.inputs === 'string' ? d.inputs : '';
  return `${d.mode || ''}|${d.fallback || ''}|${path.length}|${inputs.length}`;
}

/** 方便檢查器/測試取用：demo.path 一定是陣列。 */
export function demoPathOf(demo) {
  return isObj(demo) && Array.isArray(demo.path) ? demo.path : [];
}

/**
 * 轉交自動演示的 {press,hold}；沒有額外動作時保留舊的方向簡寫。
 */
export function demoInputToSimulation(input) {
  const hold = isObj(input?.hold) ? input.hold : null;
  const frame = normalizeFrameInput(hold ? input : { press: input?.press });
  const { dx, dy, slow, press } = frame;
  const hasExtraHold = hold && Object.keys(hold).some((key) => !['left', 'right', 'up', 'down', 'slow'].includes(key));
  return press.length || hasExtraHold ? frame : { dx, dy, slow };
}
