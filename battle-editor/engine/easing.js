/**
 * engine/easing.js — 補間曲線
 *
 * SPEC §4：ease 可為 linear / quadIn / quadOut / quadInOut / sineInOut / backOut。
 * 所有函式都接受 u（0..1，超出範圍會夾住）並回傳 0..1（backOut 會略微超過 1，
 * 這是刻意的回彈效果，呼叫端需自行容許）。
 */

/** 夾在 [0, 1] */
export function clamp01(u) {
  const n = Number(u);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** 線性 */
export function linear(u) {
  return clamp01(u);
}

/** u² — 慢起快終 */
export function quadIn(u) {
  const t = clamp01(u);
  return t * t;
}

/** 1-(1-u)² — 快起慢終 */
export function quadOut(u) {
  const t = clamp01(u);
  return 1 - (1 - t) * (1 - t);
}

/** 前半加速、後半減速 */
export function quadInOut(u) {
  const t = clamp01(u);
  if (t < 0.5) return 2 * t * t;
  const p = -2 * t + 2;
  return 1 - (p * p) / 2;
}

/** sin 版本的平滑兩端 */
export function sineInOut(u) {
  const t = clamp01(u);
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

/** 終點回彈；輸出可超過 1（最大約 1.1），刻意不夾住 */
export function backOut(u) {
  const t = clamp01(u);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  const p = t - 1;
  return 1 + c3 * p * p * p + c1 * p * p;
}

/** 反對稱：先退後進（保留給未來事件使用） */
export function backIn(u) {
  const t = clamp01(u);
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return c3 * t * t * t - c1 * t * t;
}

export const EASING_NAMES = ['linear', 'quadIn', 'quadOut', 'quadInOut', 'sineInOut', 'backOut'];

const TABLE = {
  linear,
  quadIn,
  quadOut,
  quadInOut,
  sineInOut,
  backOut,
  backIn,
};

/**
 * 依名稱取得 easing 函式；未知名稱回退 linear（不丟錯，模擬不得中斷）。
 * @param {string} name
 * @returns {(u:number)=>number}
 */
export function getEasing(name) {
  if (typeof name === 'string' && Object.prototype.hasOwnProperty.call(TABLE, name)) {
    return TABLE[name];
  }
  return linear;
}

/**
 * 一般化補間：value = a + (b - a) * ease(u)
 */
export function lerpEase(a, b, u, easeName) {
  const fn = getEasing(easeName);
  const uu = clamp01(u);
  return a + (b - a) * fn(uu);
}

export default getEasing;
