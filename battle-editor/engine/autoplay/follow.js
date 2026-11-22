/**
 * engine/autoplay/follow.js — 路徑跟隨器（精度層）
 *
 * 背景（DD4/D5 回饋）：舊版跟隨器只按 8 方向、死區大（速度一半），
 * 加上框旋轉與靈魂瞬移，實際位置可能偏離路徑點 16–20px。
 *
 * 本模組只做一件事：給定「這一幀的插值目標」與「下一幀的插值目標」，
 * 產生這一幀的引擎輸入 `{ press: [], hold: { left,right,up,down,slow } }`。
 *
 * 設計：
 *   1. 無大死區（0.4px）；只有真的到達目標附近才停，避免來回抖動。
 *   2. 以「下一幀的插值目標」為瞄準點（`leadFrames` 預設 1）→ 減少過衝。
 *   3. 逐軸過衝防止：某軸剩餘距離小於本步位移時不放該軸。
 *   4. 近距離改用 slow（Shift）微調：剩餘距離 ≤ slowSpeed × 1.5 時只用慢速。
 *   5. 框旋轉 / 縮放 / 移動：用「框速度」外推下一幀的框，落點先夾進預測框；
 *      目標點也夾進預測框 → 框在動時不會一直追不到而過衝。
 *   6. 靈魂被瞬移（`soul` 事件）：偵測單幀位移超過合理步長就重設內部預測，
 *      一律以 `state.soul` 的**實際座標**為準（不累積自己的位置估計）。
 *   7. 安全微調：若某方向在 0.2 秒內會撞上子彈（用追蹤到的子彈速度外推），
 *      改選安全方向。這是為了讓「已發佈的 demo 路徑」在更精確的跟隨器下仍 0 受傷；
 *      偏差通常 < 2px。純函式、零外部依賴 → 瀏覽器與 Node 皆可載入。
 *
 * 模組不 import 任何 Node 專屬模組。
 */

import { assertLegacySoulAutomation, dodgeClip, predictDodgeMove, projectDodgePoint } from './bot.js';
import { pointInClip } from '../arena.js';

/** 與 engine/sim.js 相同的靈魂碰撞半徑。 */
export const SOUL_RADIUS = 4;

/** 跟隨器預設參數（可在 createPathFollower({...}) 覆寫）。 */
export const FOLLOW_DEFAULTS = Object.freeze({
  /** 到目標多近就完全放開方向鍵（px）。 */
  deadzone: 0.4,
  /** 一步至少要縮短這麼多距離才值得按（px）。 */
  minGain: 0.12,
  /** 剩餘距離 ≤ slowSpeed × slowFactor 時只用慢速（Shift）微調。 */
  slowFactor: 1.5,
  /**
   * 目標標了 `slow`（該段要低速）時，只有「剩餘距離 ≤ slowSpeed × slowReach」
   * 才真的放慢；落後太多時先用全速追上，接近了才放慢。
   * 這樣 slow 段仍然慢（規格要的），但不會因為一開始就用慢速而愈拖愈遠。
   * 設成 Infinity = 整段一律慢速（舊行為）。
   */
  slowReach: 6,
  /** 瞄準「幾幀後的插值目標」（1 = 下一幀）。 */
  leadFrames: 1,
  /** 安全預測視野（幀）；0 = 關閉安全微調。 */
  safeHorizon: 6,
  /** 安全距離（px）：預測淨空小於此值才介入。 */
  safeMargin: 10,
  /** 安全項權重（越大越保守）。 */
  safeWeight: 4,
  /** 只考慮這個距離內（px）的子彈。 */
  safeRange: 220,
});

/** 8 方向 + 原地（原地只作為「沒有更好的一步」時的退路）。 */
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

function isObj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value, def = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return def;
}

/** 子彈的有效碰撞半徑（矩形取外接圓，偏保守；與 engine/sim.js 的判定不衝突）。 */
function hitRadius(bullet) {
  const hb = (bullet && bullet.hitbox) || { shape: 'circle', r: 6 };
  if (hb.shape === 'rect') {
    const w = Math.max(0, num(hb.w, 8));
    const h = Math.max(0, num(hb.h, 8));
    const r = Math.hypot(w, h) / 2;
    return r > 0 ? r : 4;
  }
  return Math.max(0, num(hb.r, 6));
}

/** 方向 → hold 物件（固定鍵序）。 */
function holdOf(dx, dy) {
  const hold = {};
  if (dx < 0) hold.left = true;
  else if (dx > 0) hold.right = true;
  if (dy < 0) hold.up = true;
  else if (dy > 0) hold.down = true;
  return hold;
}

/** 把使用者給的參數正規化（夾在合理範圍；壞值直接忽略）。 */
export function normalizeFollowOptions(input) {
  const src = isObj(input) ? input : {};
  const out = { ...FOLLOW_DEFAULTS };
  for (const key of Object.keys(FOLLOW_DEFAULTS)) {
    const value = num(src[key], NaN);
    if (Number.isFinite(value)) out[key] = value;
  }
  out.deadzone = Math.max(0, out.deadzone);
  out.minGain = Math.max(0, out.minGain);
  out.slowFactor = Math.max(0, out.slowFactor);
  // slowReach 允許 Infinity（= 整段強制慢速）；Infinity 不是 finite，特判。
  if (src.slowReach === Infinity) out.slowReach = Infinity;
  else out.slowReach = Math.max(0, out.slowReach);
  out.leadFrames = Math.max(0, Math.round(out.leadFrames));
  out.safeHorizon = Math.max(0, Math.round(out.safeHorizon));
  out.safeMargin = Math.max(0, out.safeMargin);
  out.safeWeight = Math.max(0, out.safeWeight);
  out.safeRange = Math.max(1, out.safeRange);
  return out;
}

/**
 * 建立一個有狀態的跟隨器（每個 pilot 一個）。
 *
 * 內部狀態只有「上一幀的框 / 靈魂 / 子彈位置」→ 用來估速度與偵測瞬移，
 * 不影響決定性：同一串 state 一定得到同一串輸入。
 *
 * @param {object} [options] FOLLOW_DEFAULTS 的覆寫
 */
export function createPathFollower(options = {}) {
  const opts = normalizeFollowOptions(options);

  /** 框速度（px/幀）。 */
  let boxVel = { x: 0, y: 0, w: 0, h: 0, rotation: 0 };
  let prevBox = null;
  let prevSoul = null;
  /** id → { x, y, vx, vy, samples }：子彈速度追蹤（EMA）。 */
  const tracked = new Map();

  function reset() {
    boxVel = { x: 0, y: 0, w: 0, h: 0, rotation: 0 };
    prevBox = null;
    prevSoul = null;
    tracked.clear();
  }

  /** 這一幀的框速度（px/幀）與靈魂步長上限。 */
  function observe(state) {
    const soul = state.soul;
    const box = state.box;
    const cfg = isObj(state.attack) && isObj(state.attack.soul) ? state.attack.soul : {};
    const speed = Math.max(0.1, num(cfg.speed, 4));

    if (prevBox) {
      const pb = prevBox;
      boxVel = {
        x: box.x - pb.x,
        y: box.y - pb.y,
        w: box.w - pb.w,
        h: box.h - pb.h,
        rotation: num(box.rotation, 0) - num(pb.rotation, 0),
      };
    }

    if (prevSoul) {
      const jump = Math.hypot(soul.x - prevSoul.x, soul.y - prevSoul.y);
      const shift = prevBox
        ? Math.hypot(box.x - prevBox.x, box.y - prevBox.y) +
          Math.abs(box.w - prevBox.w) / 2 +
          Math.abs(box.h - prevBox.h) / 2
        : 0;
      if (jump > speed * 2 + shift + 1) {
        // 靈魂被瞬移（soul 事件）：丟掉所有舊預測，但這一幀仍要重建子彈追蹤。
        prevSoul = { x: soul.x, y: soul.y };
        prevBox = null;
        boxVel = { x: 0, y: 0, w: 0, h: 0, rotation: 0 };
        tracked.clear();
      }
    }

    /* --- 子彈速度追蹤 --- */
    const bullets = Array.isArray(state.bullets) ? state.bullets : [];
    const alive = new Set();
    for (const b of bullets) {
      const id = b.id !== undefined ? b.id : `${b.type}:${b.x}:${b.y}`;
      alive.add(id);
      const prev = tracked.get(id);
      if (!prev) {
        // 首次看到：用 angle/speed 當初始速度估計（path 型子彈多半是 0，下一幀就會被實測值取代）
        const rad = (num(b.angle, 0) * Math.PI) / 180;
        const v = num(b.speed, 0);
        tracked.set(id, { x: b.x, y: b.y, vx: Math.cos(rad) * v, vy: Math.sin(rad) * v, samples: 0 });
        continue;
      }
      const vx = b.x - prev.x;
      const vy = b.y - prev.y;
      if (prev.samples === 0) {
        prev.vx = vx;
        prev.vy = vy;
      } else {
        // EMA：路徑型子彈（pathX/pathY）也適用於「以實測位移外推」
        prev.vx = prev.vx * 0.6 + vx * 0.4;
        prev.vy = prev.vy * 0.6 + vy * 0.4;
      }
      prev.samples += 1;
      prev.x = b.x;
      prev.y = b.y;
    }
    for (const id of [...tracked.keys()]) if (!alive.has(id)) tracked.delete(id);

    prevSoul = { x: soul.x, y: soul.y };
    prevBox = { x: box.x, y: box.y, w: box.w, h: box.h, rotation: num(box.rotation, 0) };
  }

  /** 外推下一幀的框（線性；框動畫本身是線性補間，夠準）。 */
  function predictedBox(box) {
    if (!prevBox) return box;
    return {
      x: box.x + boxVel.x,
      y: box.y + boxVel.y,
      w: Math.max(1, box.w + boxVel.w),
      h: Math.max(1, box.h + boxVel.h),
      rotation: num(box.rotation, 0) + boxVel.rotation,
    };
  }

  /** 落點在 horizon 幀內與所有子彈的最小淨空（px；負 = 已重疊）。 */
  function clearanceAt(state, px, py) {
    if (opts.safeHorizon <= 0 || opts.safeWeight <= 0) return 999;
    const bullets = Array.isArray(state.bullets) ? state.bullets : [];
    let worst = 999;
    for (const b of bullets) {
      if (b.decor && state.arena) continue;
      const clip = dodgeClip(state, b);
      if (clip && !pointInClip({ x: px, y: py }, clip)) continue;
      const id = b.id !== undefined ? b.id : `${b.type}:${b.x}:${b.y}`;
      const t = tracked.get(id);
      // 粗篩：子彈目前距離 - 它在 horizon 內可能走多遠 > safeRange → 不可能靠近
      const speed = t ? Math.hypot(t.vx, t.vy) : Math.max(0, num(b.speed, 0));
      const dx = b.x - px;
      const dy = b.y - py;
      const reach = opts.safeRange + speed * opts.safeHorizon;
      if (dx * dx + dy * dy > reach * reach) continue;
      const r = hitRadius(b) + SOUL_RADIUS;
      let bx = b.x;
      let by = b.y;
      for (let f = 1; f <= opts.safeHorizon; f += 1) {
        bx += t ? t.vx : 0;
        by += t ? t.vy : 0;
        if (clip && !pointInClip({ x: bx, y: by }, clip)) continue;
        const clear = Math.hypot(bx - px, by - py) - r;
        if (clear < worst) worst = clear;
      }
    }
    return worst;
  }

  /** 距目標點最近、且不會在近期撞彈的一步。 */
  function choose(state, aim, targetSlow, dist) {
    const soul = state.soul;
    const box = state.box;
    const cfg = isObj(state.attack) && isObj(state.attack.soul) ? state.attack.soul : {};
    const speed = Math.max(0.1, num(cfg.speed, 4));
    const slowSpeed = Math.max(0.1, num(cfg.slowSpeed, 2));
    const pbox = predictedBox(box);
    // 目標點標了 slow（該段用低速）→ 接近後才放慢；已經很近就直接慢速微調。
    const wantSlow =
      dist <= slowSpeed * opts.slowFactor ||
      (Boolean(targetSlow) && dist <= slowSpeed * Math.max(opts.slowFactor, opts.slowReach));
    const speeds = wantSlow ? [true] : [false, true];

    let best = null;
    for (const slow of speeds) {
      const stepSpeed = slow ? slowSpeed : speed;
      for (const [baseX, baseY] of DIRS) {
        let dirX = baseX;
        let dirY = baseY;
        if (dirX === 0 && dirY === 0) {
          if (!best) {
            const clear = clearanceAt(state, soul.x, soul.y);
            const danger = clear < opts.safeMargin ? (opts.safeMargin - Math.max(clear, -30)) ** 2 * 0.01 : 0;
            best = { score: dist + opts.safeWeight * danger, dirX: 0, dirY: 0, slow: false, stop: true };
          }
          continue;
        }
        const axisStep = dirX !== 0 && dirY !== 0 ? stepSpeed / Math.SQRT2 : stepSpeed;
        // 逐軸過衝防止：該軸剩餘距離不足一步時，不再往該軸推。
        if (dirX !== 0 && Math.abs(aim.x - soul.x) < axisStep && Math.abs(aim.y - soul.y) <= opts.deadzone) dirX = 0;
        if (dirY !== 0 && Math.abs(aim.y - soul.y) < axisStep && Math.abs(aim.x - soul.x) <= opts.deadzone) dirY = 0;
        if (dirX === 0 && dirY === 0) continue;
        const moved = predictDodgeMove(state.arena, pbox, soul, soul.x + dirX * axisStep, soul.y + dirY * axisStep, SOUL_RADIUS);
        const nextDist = Math.hypot(aim.x - moved.x, aim.y - moved.y);
        if (dist - nextDist < opts.minGain) continue;
        const clear = clearanceAt(state, moved.x, moved.y);
        const danger =
          clear < opts.safeMargin ? (opts.safeMargin - Math.max(clear, -30)) ** 2 * 0.01 : 0;
        const score = nextDist + (slow ? 0.001 : 0) + opts.safeWeight * danger;
        if (!best || score < best.score) best = { score, dirX, dirY, slow, stop: false };
      }
    }
    if (!best) return { press: [], hold: wantSlow ? { slow: true } : {} };
    if (best.stop) return { press: [], hold: wantSlow ? { slow: true } : {} };
    return {
      press: [],
      hold: { ...(best.slow ? { slow: true } : {}), ...holdOf(best.dirX, best.dirY) },
    };
  }

  /**
   * 決定這一幀的輸入。
   *
   * @param {object} state  引擎 getState()（需要 soul / box / bullets / attack.soul）
   * @param {{x:number,y:number,slow?:boolean}|null} target 這一幀的插值目標（已含 slow）
   * @param {{x:number,y:number,slow?:boolean}|null} [nextTarget] 下一幀的插值目標
   * @returns {{press: string[], hold: object}}
   */
  function input(state, target, nextTarget) {
    assertLegacySoulAutomation(state?.attack, state?.soul);
    if (!isObj(state) || !isObj(state.soul) || !isObj(state.box) || !isObj(target)) {
      return { press: [], hold: {} };
    }
    observe(state);
    const box = state.box;
    const pbox = predictedBox(box);
    const aimNow = projectDodgePoint(state.arena, box, num(target.x, box.x), num(target.y, box.y), SOUL_RADIUS);
    // 瞄準點：沿「這一幀 → 下一幀」的目標位移外推 leadFrames 幀（預設 1 = 下一幀）。
    // 外推比直接追當下目標少一幀的落後，過衝則由逐軸防護處理。
    const aheadX = isObj(nextTarget) && Number.isFinite(Number(nextTarget.x)) ? Number(nextTarget.x) : num(target.x, box.x);
    const aheadY = isObj(nextTarget) && Number.isFinite(Number(nextTarget.y)) ? Number(nextTarget.y) : num(target.y, box.y);
    const lead = opts.leadFrames;
    const aim = projectDodgePoint(
      state.arena,
      pbox,
      num(target.x, box.x) + (aheadX - num(target.x, box.x)) * lead,
      num(target.y, box.y) + (aheadY - num(target.y, box.y)) * lead,
      SOUL_RADIUS,
    );
    const dist = Math.hypot(aim.x - state.soul.x, aim.y - state.soul.y);
    // slow 標記是「這一刻的這段」用慢速 → 以這一幀的目標為準（下一幀可能已經
    // 換到非 slow 的段，用下一幀的 slow 會慢一幀才放開）。
    const targetSlow = Boolean(target && target.slow) || Boolean(aimNow && aimNow.slow);
    if (dist <= opts.deadzone) {
      // 已到達（或剩餘誤差在死區內）→ 放開方向鍵；slow 段仍按住 Shift
      return { press: [], hold: targetSlow ? { slow: true } : {} };
    }
    return choose(state, aim, targetSlow, dist);
  }

  return {
    input,
    reset,
    options: opts,
    /** 給測試 / 除錯：目前的框速度與追蹤到的子彈數。 */
    debug() {
      return { boxVel: { ...boxVel }, tracked: tracked.size };
    },
  };
}

export default createPathFollower;
