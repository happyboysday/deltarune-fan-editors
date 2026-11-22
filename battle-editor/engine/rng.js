/**
 * engine/rng.js — 決定性偽亂數產生器
 *
 * 全引擎只使用這個模組產生亂數，確保：
 *   1. 同一個 seed → 同一串亂數（preview 模式可 seek 重播）。
 *   2. 不依賴 Math.random（否則 seek 不可能決定性）。
 *
 * 演算法：Mulberry32（32-bit 狀態、品質足夠、極快、無外部依賴）。
 * 不使用 BigInt，避免拖慢每幀路徑。
 */

/** 32-bit 整數混洗（供震動等「無狀態」視覺亂數使用） */
export function hash32(x) {
  let t = (Number.isFinite(x) ? Math.floor(x) : 0) >>> 0;
  t = Math.imul(t ^ (t >>> 16), 0x21f0aaad) >>> 0;
  t = Math.imul(t ^ (t >>> 15), 0x735a2d97) >>> 0;
  return (t ^ (t >>> 15)) >>> 0;
}

/**
 * 由整數座標取得 [-1, 1] 的決定性數值；用於畫面震動等視覺效果，
 * 不必消耗主要亂數流，也不會影響子彈生成序列。
 */
export function noiseSigned(...keys) {
  let h = 0x811c9dc5;
  for (const k of keys) {
    h ^= hash32(k);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (hash32(h) / 4294967296) * 2 - 1;
}

const STATE_MIX = 0x6d2b79f5;

/**
 * 建立一個決定性亂數產生器。
 * @param {number} seed 種子（任意數，內部轉成 32-bit）
 * @returns {{next:()=>number, range:(a:number,b:number)=>number, int:(a:number,b:number)=>number,
 *            pick:(...args:any[])=>any, reseed:(seed:number)=>void,
 *            getState:()=>({state:number, seed:number}), setState:(snap:any)=>boolean,
 *            readonly seed:number}}
 */
export function createRng(seed = 1) {
  let state = 0;
  let seedValue = 1;

  function reseed(nextSeed) {
    let s = Number(nextSeed);
    if (!Number.isFinite(s)) s = 1;
    // 取整並避免 0（0 會讓 Mulberry32 前幾個值偏低）
    seedValue = (Math.floor(Math.abs(s)) % 4294967296) >>> 0;
    state = (seedValue ^ 0x9e3779b9) >>> 0;
    if (state === 0) state = 0x1a2b3c4d;
    // 先空轉幾次，讓相近 seed 的開頭序列有足夠差異
    for (let i = 0; i < 2; i += 1) next();
  }

  /** @returns {number} [0, 1) */
  function next() {
    state = (state + STATE_MIX) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * rand() → [0,1)；rand(a) → [0,a)；rand(a,b) → [a,b)
   * 參數順序顛倒或非數字時自行修正，確保表達式不會因爛參數崩潰。
   */
  function range(a, b) {
    const hasA = Number.isFinite(a);
    const hasB = Number.isFinite(b);
    if (!hasA && !hasB) return next();
    if (hasA && !hasB) return next() * a;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    return lo + next() * (hi - lo);
  }

  /** 整數亂數 [a, b]（含頭尾） */
  function int(a, b) {
    if (!Number.isFinite(a)) return Math.floor(next() * (Number.isFinite(b) ? b + 1 : 2));
    if (!Number.isFinite(b)) return Math.floor(next() * (a + 1));
    const lo = Math.ceil(Math.min(a, b));
    const hi = Math.floor(Math.max(a, b));
    if (hi < lo) return lo;
    return lo + Math.floor(next() * (hi - lo + 1));
  }

  /** pick(array) 或 pick(a, b, c...) → 隨機取一個 */
  function pick(...args) {
    let list = args;
    if (args.length === 1 && Array.isArray(args[0])) list = args[0];
    if (list.length === 0) return undefined;
    return list[int(0, list.length - 1)];
  }

  reseed(seed);

  return {
    next,
    range,
    int,
    pick,
    reseed,
    /**
     * 匯出亂數狀態（V2-08 snapshot / restore 用）。
     *
     * 只包含「內部 32-bit 狀態」與 seed；兩者都是純數字，可直接 JSON 序列化。
     * 把 getState() 的結果交給同一個 rng 的 setState() 後，後續 next() 序列
     * 與匯出時完全相同（決定性重播 / 中途續跑）。
     *
     * @returns {{state:number, seed:number}}
     */
    getState() {
      return { state: state >>> 0, seed: seedValue };
    },
    /**
     * 還原亂數狀態（getState() 的逆運算）。
     *
     * `state` 不合理（非有限數 / 0）時退回以 `seed` 重建，避免整條亂數流
     * 卡在 Mulberry32 的不良起點。
     *
     * @param {{state?:number, seed?:number}|number} snap getState() 的結果或直接給 state
     * @returns {boolean} 是否採用 snapshot 內的 state
     */
    setState(snap) {
      const src = snap !== null && typeof snap === 'object' ? snap : { state: snap };
      const raw = Number(src.state);
      if (Number.isFinite(src.seed)) {
        const s = Number(src.seed);
        seedValue = (Math.floor(Math.abs(s)) % 4294967296) >>> 0;
      }
      if (Number.isFinite(raw)) {
        const next = raw >>> 0;
        if (next !== 0) {
          state = next;
          return true;
        }
      }
      // state 缺失 / 0：用 seed 重建（含 2 次空轉，與 reseed 一致）
      state = (seedValue ^ 0x9e3779b9) >>> 0;
      if (state === 0) state = 0x1a2b3c4d;
      for (let i = 0; i < 2; i += 1) next();
      return false;
    },
    get seed() {
      return seedValue;
    },
  };
}

export default createRng;
