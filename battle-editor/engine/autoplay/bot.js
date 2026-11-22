/**
 * engine/autoplay/bot.js — 自動閃避 AI（SPEC-AUTOPLAY §3）
 *
 * 由 tools/agent/bot.mjs 搬過來（行為完全相同），但**不再 import Node 模組**，
 * 因此瀏覽器與 Node 都能用。設計原則不變（SPEC-AGENT §3）：只讀公開
 * getState()，不偷看引擎內部狀態；決定性（同 seed + 同攻擊 → 同輸入序列）。
 *
 * 對外：
 *   createBot(options?)            → { kind, steps, direction, decide(state), input(state), reset() }
 *   createBotFromArgs(args?)       → 依命令列參數風格建立 bot
 *   bestClearance(state, options?) → 最佳那一步的淨空距離（難度分析用）
 *   BOT_NAMES                      → ['dodge', 'idle', 'random']
 *   directionToInput(dir)          → 方向 → 引擎輸入格式 { press, hold }
 *   inputToDirection(input)        → 引擎輸入格式 → 方向 { dx, dy, slow }
 *   clampToBox(x, y, box, margin?) → 把點夾回（可旋轉的）戰鬥框
 *
 * decide(state) 回傳 `{ dx, dy, slow }`（engine/sim.js stepFrame 的輸入）；
 * input(state) 回傳引擎輸入格式 `{ press: [], hold: { left, right, up, down, slow } }`
 * （engine/autoplay/index.js 的 pilot.input() 介面）。
 */

import { maskOverlapCircle } from '../graze-mask.js';
import { bulletClip, clipShape, moveInArena, movementBox, placeInArena, pointInClip } from '../arena.js';

export const BOT_NAMES = ['dodge', 'idle', 'random'];

export const SOUL_AUTOMATION_UNSUPPORTED = '自訂靈魂配置不支援路徑跟隨或自動躲避；請手動操作或重播錄製的輸入。';

export function usesSoulProfiles(attack) {
  return Boolean(attack?.soul?.profile
    || (attack?.soulProfiles && Object.keys(attack.soulProfiles).length)
    || (Array.isArray(attack?.timeline) && attack.timeline.some((event) => event?.type === 'soulProfile')));
}

export function assertLegacySoulAutomation(attack, soul) {
  if (soul?.profile || usesSoulProfiles(attack)) throw new Error(SOUL_AUTOMATION_UNSUPPORTED);
}

/** 靈魂碰撞半徑（與 engine/sim.js 的 SOUL_RADIUS 一致）。 */
const SOUL_RADIUS = 4;
/** 預測用的子彈最遠距離（超過就不用管了）。 */
const THREAT_RANGE = 200;

const DIRS = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/* ------------------------------------------------------------ 小工具 */

/** 數字參數解析（等同 tools/agent/lib.mjs 的 numArg，但零依賴）。 */
function numArg(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function round(value, digits = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const p = 10 ** digits;
  return Math.round(n * p) / p;
}

function hitRadius(given) {
  const hb = (given && given.hitbox) || { shape: 'circle', r: 6 };
  if (hb.shape === 'rect') return Math.max(hb.w || 0, hb.h || 0) / 2 || 4;
  return Number.isFinite(hb.r) ? hb.r : 6;
}

/** 把點 clamp 回（可旋轉的）戰鬥框內。 */
export function clampToBox(x, y, box, margin = 2) {
  const rotation = box.rotation || 0;
  const cos = Math.cos((-rotation * Math.PI) / 180);
  const sin = Math.sin((-rotation * Math.PI) / 180);
  const dx = x - box.x;
  const dy = y - box.y;
  let lx = dx * cos - dy * sin;
  let ly = dx * sin + dy * cos;
  const halfW = Math.max(0, box.w / 2 - margin);
  const halfH = Math.max(0, box.h / 2 - margin);
  lx = Math.min(halfW, Math.max(-halfW, lx));
  ly = Math.min(halfH, Math.max(-halfH, ly));
  const c2 = Math.cos((rotation * Math.PI) / 180);
  const s2 = Math.sin((rotation * Math.PI) / 180);
  return { x: box.x + lx * c2 - ly * s2, y: box.y + lx * s2 + ly * c2 };
}

export function projectDodgePoint(arena, box, x, y, margin) {
  return arena && arena.kind !== 'box'
    ? placeInArena(arena, box, { x, y }, margin)
    : clampToBox(x, y, box, margin);
}

export function predictDodgeMove(arena, box, from, x, y, margin) {
  return arena && arena.kind !== 'box'
    ? moveInArena(arena, box, from, { x, y }, SOUL_RADIUS)
    : clampToBox(x, y, box, margin);
}

export function dodgeClip(state, bullet) {
  // Keep legacy bot scoring for existing attacks; new layouts must also
  // account for projectiles clipped independently of the player boundary.
  if (!state.arena && !state.clipRegion && bullet.clipTo === undefined) return null;
  return clipShape(bulletClip(bullet), state.box, state.arena, state.clipRegion);
}

/* ------------------------------------------------------ 引擎輸入轉換 */

/** 空的引擎輸入（每次回傳新物件，避免呼叫端改到共用常數）。 */
export function neutralInput() {
  return { press: [], hold: {} };
}

/**
 * 方向 → 引擎輸入格式（SPEC-AUTOPLAY §1）。
 * @param {{dx:number, dy:number, slow?:boolean}} dir
 * @returns {{press: string[], hold: {left:boolean,right:boolean,up:boolean,down:boolean,slow:boolean}}}
 */
export function directionToInput(dir) {
  const dx = Math.sign(numArg(dir && dir.dx, 0));
  const dy = Math.sign(numArg(dir && dir.dy, 0));
  const hold = {};
  if (dx < 0) hold.left = true;
  else if (dx > 0) hold.right = true;
  if (dy < 0) hold.up = true;
  else if (dy > 0) hold.down = true;
  if (dir && dir.slow) hold.slow = true;
  return { press: [], hold };
}

/**
 * 引擎輸入格式 → 方向（與 engine/encounter/world.js 的 normalizeInput 一致：
 * 左右同時按 = 0，上下同時按 = 0）。
 * @param {{press?:string[], hold?:object}|null} input
 * @returns {{dx:number, dy:number, slow:boolean}}
 */
export function inputToDirection(input) {
  const hold = (input && input.hold) || {};
  const dx = (hold.right ? 1 : 0) - (hold.left ? 1 : 0);
  const dy = (hold.down ? 1 : 0) - (hold.up ? 1 : 0);
  return { dx: Math.sign(dx), dy: Math.sign(dy), slow: Boolean(hold.slow) };
}

/* --------------------------------------------------------------- bot */

/**
 * 建立一個 bot。
 *
 * @param {object} options
 * @param {'dodge'|'idle'|'random'} [options.bot='dodge'] 種類
 * @param {number} [options.horizon=14]     預測幀數（14 幀 ≈ 0.47 秒）
 * @param {number} [options.grazeBias=0]    0 = 純安全；>0 會為了擦彈靠近子彈
 * @param {number} [options.randomEvery=9]  random 種類多久換一次方向
 * @param {number} [options.seed=1]         亂數種子（決定性）
 */
export function createBot(options = {}) {
  const kind = BOT_NAMES.includes(options.bot) ? options.bot : 'dodge';
  const baseHorizon = Math.max(1, Math.round(numArg(options.horizon, 14)));
  const variation = Math.max(0, numArg(options.variation, 0));
  const initialSeed = (Math.round(numArg(options.seed, 1)) >>> 0) || 1;
  let horizon = baseHorizon;
  const grazeBias = Math.max(0, numArg(options.grazeBias, 0));
  const randomEvery = Math.max(1, Math.round(numArg(options.randomEvery, 9)));
  let rngState = initialSeed;

  let lastDir = [0, 0];
  let randomDir = [0, 0];
  let randomAge = 0;
  let decisions = 0;

  const rand = () => {
    // xorshift32：決定性、零依賴
    rngState ^= rngState << 13;
    rngState ^= rngState >>> 17;
    rngState ^= rngState << 5;
    rngState >>>= 0;
    return rngState / 4294967296;
  };

  function resetRng() {
    rngState = variation > 0 ? (Math.imul(initialSeed, 0x9e3779b9) >>> 0) || 1 : initialSeed;
    horizon = variation > 0 ? Math.max(1, baseHorizon + Math.floor(rand() * 5) - 2) : baseHorizon;
  }
  resetRng();

  /** 子彈在 f 幀後的位置（只用公開欄位線性外推）。 */
  function bulletAt(bullet, f) {
    const speed = (bullet.speed || 0) + (bullet.accel || 0) * f;
    const angle = ((bullet.angle || 0) + (bullet.angularVel || 0) * f) * (Math.PI / 180);
    if (bullet.pathX !== null && bullet.pathX !== undefined) {
      // path 型子彈無法外推表達式 → 用當前速度保守估計（通常為 0，等於「停在那」）
      return {
        x: bullet.x + Math.cos(angle) * speed * f * 0.5,
        y: bullet.y + Math.sin(angle) * speed * f * 0.5,
      };
    }
    // 等加速度位移：sum_{k=0..f-1} (speed + accel*k)
    const sum = speed * f + (bullet.accel || 0) * ((f * (f - 1)) / 2);
    return { x: bullet.x + Math.cos(angle) * sum, y: bullet.y + Math.sin(angle) * sum };
  }

  function evaluate(state, dir) {
    const attack = state.attack || {};
    const soulCfg = attack.soul || {};
    const speed = Math.max(0.1, numArg(soulCfg.speed, 4));
    const slowSpeed = Math.max(0.1, numArg(soulCfg.slowSpeed, 2));
    const useSlow = Boolean(dir.slow);
    const step = (useSlow ? slowSpeed : speed) / (dir.dx && dir.dy ? Math.SQRT2 : 1);
    const box = state.box;
    const bounds = movementBox(state.arena, box);
    const soul = state.soul;

    const bullets = [];
    for (const b of state.bullets || []) {
      if (b.decor) continue;
      const dx = b.x - soul.x;
      const dy = b.y - soul.y;
      if (dx * dx + dy * dy <= (THREAT_RANGE + (b.speed || 0) * horizon) ** 2) {
        bullets.push({ b, r: hitRadius(b), clip: dodgeClip(state, b) });
      }
    }

    let minClear = 999;
    let grazeScore = 0;
    let edgePenalty = 0;

    let px = soul.x;
    let py = soul.y;
    for (let f = 1; f <= horizon; f += 1) {
      const next = predictDodgeMove(state.arena, box, { x: px, y: py }, px + dir.dx * step, py + dir.dy * step, 2);
      px = next.x;
      py = next.y;
      for (const item of bullets) {
        const pos = bulletAt(item.b, f);
        if (item.clip && (!pointInClip(pos, item.clip) || !pointInClip(next, item.clip))) continue;
        const dx = pos.x - px;
        const dy = pos.y - py;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const clear = dist - (item.r + SOUL_RADIUS);
        if (clear < minClear) minClear = clear;
        if (grazeBias > 0) {
          // 擦彈＝子彈與官方心形遮罩重疊（與 engine/sim.js grazeMaskTest 一致）；
          // 仍要求離命中範圍 1px 以上，避免為了擦彈貼到命中邊緣
          if (clear > 1 && maskOverlapCircle(dx, dy, item.r)) grazeScore += 1;
        }
      }
      // 貼牆會壓縮後續的閃避空間 → 輕微扣分
      const dLeft = px - (bounds.x - bounds.w / 2);
      const dRight = bounds.x + bounds.w / 2 - px;
      const dTop = py - (bounds.y - bounds.h / 2);
      const dBottom = bounds.y + bounds.h / 2 - py;
      const near = Math.min(dLeft, dRight, dTop, dBottom);
      if (near < 14) edgePenalty += (14 - near) * 0.05;
    }

    let score = minClear - edgePenalty;
    if (minClear < 2.5) score -= 200; // 幾乎確定會受傷 → 強烈避開
    if (grazeBias > 0) score += Math.min(12, grazeScore / horizon) * grazeBias * 3;
    // 平手時偏好「繼續往同方向」與「不動」，讓動作穩定不抖
    if (dir.dx === lastDir[0] && dir.dy === lastDir[1]) score += 0.6;
    if (dir.dx === 0 && dir.dy === 0) score += 0.5;
    // 分數擾動僅用於多種子分析，不會跨過避開命中的主要門檻。
    return variation > 0 && bullets.length > 0 ? score + (rand() - 0.5) * variation : score;
  }

  const bot = {
    kind,

    /** 目前決策次數（測試用）。 */
    get steps() {
      return decisions;
    },

    /** 目前方向（測試/除錯用）。 */
    get direction() {
      return { dx: lastDir[0], dy: lastDir[1] };
    },

    /**
     * 依當前 getState() 決定這一幀的方向。
     * @returns {{dx:number,dy:number,slow:boolean}}
     */
    decide(state) {
      assertLegacySoulAutomation(state?.attack, state?.soul);
      decisions += 1;
      if (kind === 'idle') {
        lastDir = [0, 0];
        return { dx: 0, dy: 0, slow: false };
      }
      if (kind === 'random') {
        randomAge += 1;
        if (randomAge >= randomEvery) {
          randomAge = 0;
          const dir = DIRS[Math.floor(rand() * DIRS.length)] || [0, 0];
          randomDir = dir;
        }
        lastDir = randomDir;
        return { dx: randomDir[0], dy: randomDir[1], slow: false };
      }

      if (!state || !state.box || !state.soul) {
        lastDir = [0, 0];
        return { dx: 0, dy: 0, slow: false };
      }

      let best = { score: -Infinity, dir: { dx: 0, dy: 0, slow: false } };
      for (const [dx, dy] of DIRS) {
        const candidate = { dx, dy, slow: false };
        const score = evaluate(state, candidate);
        if (score > best.score) best = { score, dir: candidate };
      }
      // 真的躲不掉時，往前衝往往比停在原地好；慢速只在「有明確安全空隙」時才有價值
      for (const [dx, dy] of DIRS) {
        if (!dx && !dy) continue;
        const candidate = { dx, dy, slow: true };
        const score = evaluate(state, candidate) - 1.5; // 慢速的輕微成本（多耗時間）
        if (score > best.score) best = { score, dir: candidate };
      }

      lastDir = [best.dir.dx, best.dir.dy];
      return best.dir;
    },

    /**
     * 依當前 getState() 決定這一幀的引擎輸入格式（SPEC-AUTOPLAY §1）。
     * @returns {{press: string[], hold: object}}
     */
    input(state) {
      return directionToInput(bot.decide(state));
    },

    reset() {
      lastDir = [0, 0];
      randomDir = [0, 0];
      randomAge = 0;
      decisions = 0;
      resetRng();
    },
  };

  return bot;
}

/** 依 `--bot` 字串建立 bot（sim/difficulty 共用）。 */
export function createBotFromArgs(args = {}) {
  return createBot({
    bot: args.bot === true || args.bot === undefined ? 'dodge' : String(args.bot),
    horizon: numArg(args.horizon, 14),
    grazeBias: numArg(args.grazeBias, 0),
    randomEvery: numArg(args.randomEvery, 9),
    seed: numArg(args.seed, 1),
    variation: numArg(args.variation, 0),
  });
}

/* ------------------------------------------------------ bestClearance */

/** 「最佳那一步的淨空距離」——difficulty 用來估計玩家容錯空間。 */
export function bestClearance(state, botOptions = {}) {
  assertLegacySoulAutomation(state?.attack, state?.soul);
  if (!state || !state.box || !state.soul) return 0;
  let best = -Infinity;
  for (const [dx, dy] of DIRS) {
    for (const slow of [false, true]) {
      if (slow && !dx && !dy) continue;
      const score = evaluateStandalone(state, { dx, dy, slow }, botOptions.horizon || 14);
      if (score > best) best = score;
    }
  }
  return best === -Infinity ? 0 : round(best, 2);
}

/** 供 bestClearance 使用的無狀態評估（複製 createBot 內部的計算方式）。 */
function evaluateStandalone(state, dir, horizon) {
  const attack = state.attack || {};
  const soulCfg = attack.soul || {};
  const speed = Math.max(0.1, numArg(soulCfg.speed, 4));
  const slowSpeed = Math.max(0.1, numArg(soulCfg.slowSpeed, 2));
  const step = (dir.slow ? slowSpeed : speed) / (dir.dx && dir.dy ? Math.SQRT2 : 1);
  const box = state.box;
  const soul = state.soul;
  let minClear = 999;
  let px = soul.x;
  let py = soul.y;
  for (let f = 1; f <= horizon; f += 1) {
    const next = predictDodgeMove(state.arena, box, { x: px, y: py }, px + dir.dx * step, py + dir.dy * step, 2);
    px = next.x;
    py = next.y;
    for (const b of state.bullets || []) {
      if (b.decor) continue;
      const dx = b.x - soul.x;
      const dy = b.y - soul.y;
      if (dx * dx + dy * dy > (THREAT_RANGE + (b.speed || 0) * horizon) ** 2) continue;
      const speedB = (b.speed || 0) + (b.accel || 0) * f;
      const angle = ((b.angle || 0) + (b.angularVel || 0) * f) * (Math.PI / 180);
      const sum = speedB * f + (b.accel || 0) * ((f * (f - 1)) / 2);
      const bx = b.x + Math.cos(angle) * sum;
      const by = b.y + Math.sin(angle) * sum;
      const clip = dodgeClip(state, b);
      if (clip && (!pointInClip({ x: bx, y: by }, clip) || !pointInClip(next, clip))) continue;
      const ddx = bx - px;
      const ddy = by - py;
      const clear = Math.sqrt(ddx * ddx + ddy * ddy) - (hitRadius(b) + SOUL_RADIUS);
      if (clear < minClear) minClear = clear;
    }
  }
  return minClear;
}

export default createBot;
