/**
 * engine/autoplay/pathgen.js — 自動產生 demo 路徑（SPEC-AUTOPLAY §2.1 / §3）
 *
 * 為什麼需要：把「AI 的閃避軌跡直接當路徑照走」還是會中彈（DD4 回饋）——
 * 路徑點必須**用引擎實跑驗證**過才算數。這支的流程：
 *
 *   1. 收集初始候選路徑：攻擊檔現有的 demo、引擎閃避 bot 的實跑軌跡、
 *      原地不動、橢圓繞行、種子隨機遊走。
 *   2. 用引擎逐條實跑評分（命中數 → 首命中時間 → 最小淨空 → 移動量）。
 *   3. 取最好的一條，逐節點做「座標下降」：每個節點試 8 方向 × 多種步長
 *      （含 slow 慢速段）＋嚮導方向＋種子微擾，每次都用引擎實跑評分，
 *      只接受嚴格變好的修改。反覆掃描到沒有改善或時間用完。
 *   4. 壓縮成時間軸等價的路徑（只刪「連續同點區段」的中間項，不改變任何一幀的
 *      插值目標；`hold` 只用來延長最後一點之後的覆蓋時間），最後跑一次完整
 *      回合驗證，回傳 ok / hits。
 *
 * 對外：
 *   generateDemoPath(attackDoc, options) → {
 *     ok, demo, path, hits, hitFrames, validation, best, attempts, elapsedMs,
 *     aborted, reason, options,
 *   }
 *   createReplayEngine(attackDoc, options) → { run(path, opts), destroy(), battle, durationFrames }
 *       ← 「重跑」的接縫：V2-08 的 snapshot 加速只要替換這一層
 *   replayPath(attackDoc, path, options)      → 一次性的實跑驗證
 *   validateDemoPath(attackDoc, path, options) → 同上（語意化別名）
 *   botTrajectory(attackDoc, options) → 引擎閃避 bot 的逐幀軌跡（初始候選）
 *   compactPath(path, endT) / expandPath(path, step) → 路徑點的壓縮／展開
 *
 * generateDemoPath 的 options：
 *   seed          亂數種子（同 seed + 同攻擊檔 → 同一條路徑，預設 1）
 *   step          節點間隔秒數（預設 0.3）
 *   maxNodes      節點上限（預設依 duration 計算，最多 120）
 *   maxSweeps     最多幾輪座標下降（預設 8）
 *   timeBudgetMs  時間預算（預設 60000；到時回傳目前最佳結果）
 *   onProgress    ({ phase, sweep, index, nodes, hits, firstHit, bestCost, elapsedMs }) => void
 *   signal        AbortSignal（取消時回傳目前最佳結果，aborted = true）
 *   replay        自訂重跑函式（簽名 (path, opts) → run 結果；V2-08 換掉這個）
 *   followOptions 跟隨器參數
 *   useExistingDemo 是否把攻擊檔現有的 demo 當初始候選（預設 true）
 *
 * 純 ES module、零 Node 專屬 import → 瀏覽器與 Node 都能跑。
 * 引擎速度（無 canvas）：建立+載入約 3.5 ms、重設+跑 300 幀約 9 ms。
 */

import { createBattle } from '../index.js';
import { beatTimingOf, timeToSeconds } from '../attack.js';
import { createSoulPilot, buildPathTimeline, pathTargetAt } from './soul.js';
import { assertLegacySoulAutomation, createBot, projectDodgePoint } from './bot.js';
import { normalizeFrameInput } from '../input.js';
import { compileArena, movementBox } from '../arena.js';
import { createRng } from '../rng.js';

/** 與 engine/sim.js 一致的靈魂碰撞半徑。 */
const SOUL_RADIUS = 4;
const FPS = 30;

/** 產生路徑的預設參數。 */
export const PATHGEN_DEFAULTS = Object.freeze({
  seed: 1,
  step: 0.3,
  maxNodes: 0, // 0 = 依 duration 自動
  maxSweeps: 8,
  timeBudgetMs: 60000,
  /** 安全淨空舒適值（px）：搜尋到「0 命中且最小淨空 ≥ comfort」就提早收工。 */
  comfort: 4,
  fallback: 'bot',
  /** 移動量扣分權重（偏好短移動、平滑路徑）。 */
  moveWeight: 0.05,
  /** 距框中心扣分權重（偏好待在框中央附近）。 */
  centerWeight: 0.02,
  /** 最多回報的命中幀數。 */
  maxReportedHits: 200,
  useExistingDemo: true,
});

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

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * 時間欄位 → 秒（V2-FIX1）：接受數字（秒）與拍點字串（`"2b"`，SPEC-EXPR-V2 §1）。
 *
 * `timing` 是 `beatTimingOf(settings)`。沒有 bpm 時拍點字串無法換算 → 回傳
 * `fallback`（維持舊行為：duration 用預設值、路徑點視為不合法丟掉）。
 * 時間點欄位（`demo.path[].t`）傳 `addOffset = true` 才會加 `settings.beatOffset`；
 * 長度欄位（`settings.duration`）不加（與 engine/attack.js 的規則一致）。
 *
 * @param {any} raw
 * @param {{bpm?:number|null, beatOffset?:number}|null} timing
 * @param {number|null} fallback
 * @param {boolean} [addOffset]
 * @returns {number|null}
 */
function secondsOf(raw, timing, fallback = null, addOffset = false) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : fallback;
  if (raw === null || raw === undefined) return fallback;
  if (typeof raw !== 'string') return fallback;
  const trimmed = raw.trim();
  if (trimmed === '') return fallback;
  const direct = Number(trimmed);
  if (Number.isFinite(direct)) return direct; // 向後相容：舊檔把秒數寫成字串
  const result = timeToSeconds(trimmed, {
    bpm: timing ? timing.bpm : null,
    beatOffset: timing ? timing.beatOffset : 0,
    addOffset,
  });
  if (result.error || result.expression || !Number.isFinite(result.value)) return fallback;
  return result.value;
}

/** 瀏覽器 / Node 都可用的單調時鐘。 */
function nowMs() {
  if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** 子彈的有效碰撞半徑（矩形取外接圓；引擎的 hitTest 不乘 scale）。 */
function hitRadiusOf(bullet) {
  const hb = (bullet && bullet.hitbox) || { shape: 'circle', r: 6 };
  if (hb.shape === 'rect') {
    const w = Math.max(0, num(hb.w, 8));
    const h = Math.max(0, num(hb.h, 8));
    const r = Math.hypot(w, h) / 2;
    return r > 0 ? r : 4;
  }
  return Math.max(0, num(hb.r, 6));
}

/** 靈魂中心到子彈表面的淨空（px；負 = 已重疊）。判定與 engine/sim.js 的 hitTest 一致。 */
function clearanceOf(soul, bullet) {
  const hb = (bullet && bullet.hitbox) || { shape: 'circle', r: 6 };
  const dx = soul.x - bullet.x;
  const dy = soul.y - bullet.y;
  if (hb.shape === 'rect') {
    const rot = (num(bullet.rotation, 0) * Math.PI) / 180;
    const cos = Math.cos(rot);
    const sin = Math.sin(rot);
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    const hw = Math.max(0, num(hb.w, 8)) / 2;
    const hh = Math.max(0, num(hb.h, 8)) / 2;
    const qx = Math.max(Math.abs(lx) - hw, 0);
    const qy = Math.max(Math.abs(ly) - hh, 0);
    return Math.hypot(qx, qy) - SOUL_RADIUS;
  }
  return Math.hypot(dx, dy) - hitRadiusOf(bullet) - SOUL_RADIUS;
}

/**
 * 把 demo 路徑點正規化成引擎吃的形狀。
 *
 * `t` 接受秒數或拍點字串（`"2b"`；V2-FIX1）——拍點字串會依 `timing`
 * （`beatTimingOf(settings)`）換算成秒並加上 `settings.beatOffset`；
 * 沒有 bpm 時與舊版一樣把該點視為不合法丟掉。
 *
 * @param {Array} path
 * @param {{bpm?:number|null, beatOffset?:number}|null} [timing]
 */
function normalizePoints(path, timing = null) {
  return (Array.isArray(path) ? path : [])
    .map((p) => {
      if (!isObj(p)) return null;
      const t = secondsOf(p.t, timing, null, true);
      if (t === null || !Number.isFinite(Number(p.x)) || !Number.isFinite(Number(p.y))) return null;
      const out = { t: Math.max(0, t), x: num(p.x, 0), y: num(p.y, 0) };
      if (p.slow) out.slow = true;
      return out;
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
}

/** 攻擊的靈魂初始位置（與 engine/sim.js 的 reset 相同規則）。 */
function initialSoul(doc) {
  const box = isObj(doc.box) ? doc.box : {};
  const soul = isObj(doc.soul) ? doc.soul : {};
  const bx = num(box.x, 320);
  const by = num(box.y, 190);
  const x = soul.x === null || soul.x === undefined ? bx : num(soul.x, bx);
  const y = soul.y === null || soul.y === undefined ? by : num(soul.y, by);
  return { x, y };
}

/** 攻擊的 box 初始值。 */
function initialBox(doc) {
  const box = isObj(doc.box) ? doc.box : {};
  return {
    x: num(box.x, 320),
    y: num(box.y, 190),
    w: Math.max(1, num(box.w, 150)),
    h: Math.max(1, num(box.h, 165)),
    rotation: num(box.rotation, 0),
  };
}

/* ------------------------------------------------------------ 路徑工具 */

/**
 * 壓縮路徑：連續同一個點的區段合併成一個點 + `hold`（秒）。
 *
 * `hold` 由相鄰節點的 `t` 差算出（不是累加 step），所以時間軸 `starts[i]`
 * 與原路徑完全相同；`slow` 是「這一點 → 下一點」的移動方式，合併時取
 * 區段中任一段有 slow 就算 slow。
 *
 * @param {Array<{t:number,x:number,y:number,slow?:boolean}>} path
 * @param {number} [endT] 路徑最後一點要 hold 到何時（預設不含額外 hold）
 * @param {object} [timing] `beatTimingOf(settings)`；給定時 `t` 可用拍點字串（V2-FIX1）
 */
export function compactPath(path, endT, timing = null) {
  const list = normalizePoints(path, timing);
  if (list.length === 0) return [];

  // 只做「時間軸等價」的壓縮，不改變任何一幀的插值目標：
  //
  //   * 一段連續同點（index a..b）在 [starts[a], starts[b]) 期間目標恆為該點
  //     （pathTargetAt 對 a→a 插值等於不動）。所以只留 a 與 b 兩點就等價，
  //     中間的都可以刪。
  //   * 不能把中間重複點併成 `hold`：`hold` 的語意是把**下一點的抵達時間往後
  //     推**（starts[i+1] = max(t[i+1], starts[i] + hold[i])），而 pathTargetAt
  //     是在整段 [starts[i], starts[i+1]] 線性插值——也就是說 hold 會把移動
  //     「攤平」變慢，而不是先停再走。實測 ring-burst 把 4.1 秒的停留併成 hold
  //     就從 0 命中變 2 命中。要「停留」只能靠重複點。
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const node = list[i];
    const same = (a, b) => Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01;
    if (i > 0 && i < list.length - 1 && same(node, list[i - 1]) && same(node, list[i + 1])) {
      // 連續同點的中間項：略過
      continue;
    }
    out.push({
      t: node.t,
      x: node.x,
      y: node.y,
      ...(node.slow ? { slow: true } : {}),
    });
  }

  // 補上結尾的 hold，讓路徑覆蓋到 endT（只延長「最後一點之後」的停留時間，
  // 不影響任何既有區段的插值）。
  const end = Number.isFinite(endT) ? Math.max(endT, out[out.length - 1].t) : null;
  const hold = end === null ? 0 : Math.max(0, end - out[out.length - 1].t);
  if (hold > 1e-9) out[out.length - 1].hold = round3(hold);
  return out;
}

/** compactPath 的逆運算：把 `hold` 展開成逐點（測試 / 除錯用）。 */
export function expandPath(path, step = 0.3, timing = null) {
  const list = normalizePoints(path, timing);
  const out = [];
  for (let i = 0; i < list.length; i += 1) {
    const node = list[i];
    out.push({ t: node.t, x: node.x, y: node.y, ...(node.slow ? { slow: true } : {}) });
    const hold = num(path[i] && path[i].hold, 0);
    let k = 1;
    while (k * step <= hold + 1e-9) {
      out.push({ t: round3(node.t + k * step), x: node.x, y: node.y, ...(node.slow ? { slow: true } : {}) });
      k += 1;
    }
  }
  return out;
}

/* ------------------------------------------------------- 重跑（接縫） */

/**
 * 重跑用的輕量 state（V2-08）：只組出跟隨器 / 淨空量測真正會讀的欄位。
 *
 * 為什麼不用 battle.getState()：那會把整份攻擊檔（含 timeline / bulletTypes）
 * 與每發子彈的呈現欄位深拷貝一次，每幀兩次時占掉大半的生成時間。
 * 這裡讀的是同一個 sim 的即時值（唯讀），欄位語意與 getState() 相同：
 *   frame / time / ended / attack / box / soul / bullets[{id,type,x,y,rotation,hitbox,angle,speed}]
 *
 * @param {object} sim createSimulation() 的結果
 */
function stateOf(sim) {
  const raw = sim._state();
  const list = raw.bullets;
  const bullets = new Array(list.length);
  for (let i = 0; i < list.length; i += 1) {
    const b = list[i];
    bullets[i] = {
      decor: b.decor,
      clipTo: b.clipTo,
      maskToBox: b.maskToBox,
      id: b.id,
      type: b.type,
      x: b.x,
      y: b.y,
      rotation: b.rotation,
      hitbox: b.hitbox,
      angle: b.angle,
      speed: b.speed,
    };
  }
  const soul = sim.soul;
  return {
    frame: sim.frame,
    time: sim.time,
    ended: sim.ended,
    attack: sim.attack,
    box: sim.box,
    arena: sim.arena,
    clipRegion: sim.clipRegion,
    soul: { x: soul.x, y: soul.y, invFrames: soul.invFrames, grazing: soul.grazing },
    bullets,
  };
}

/**
 * 建立「重跑器」：建立一次 battle、載入一次，之後每次 run() 只回原點
 * （比每次重建快約 3.5 ms；產生路徑會呼叫上千次）。
 *
 * V2-08：回原點改用 sim.snapshot() / sim.restore()——第一次 run 時建立
 * 「載入後的原點快照」，之後每次直接還原（不重建 RNG / helpers、不重跑
 * 第 0 幀事件）。還原結果與 reset() 完全相同（tests/snapshot 逐幀驗證）。
 *
 * @param {object} attackDoc 攻擊檔
 * @param {object} [options]
 * @param {Function} [options.createBattle] 自訂引擎建立（預設 engine/index.js 的 createBattle）
 * @returns {{run:Function, destroy:Function, battle:object, durationFrames:Function}}
 */
export function createReplayEngine(attackDoc, options = {}) {
  const opts = isObj(options) ? options : {};
  const doc = isObj(attackDoc) ? attackDoc : {};
  assertLegacySoulAutomation(doc);
  // 拍點（V2-FIX1）：路徑點的 t 可能是 "2b"，換算需要攻擊檔的 settings.bpm / beatOffset
  const timing = beatTimingOf(isObj(doc.settings) ? doc.settings : {});
  const makeBattle = typeof opts.createBattle === 'function' ? opts.createBattle : createBattle;
  const battle = makeBattle({ canvas: null, assets: null, mode: 'play' });
  battle.load(doc);
  const sim = battle.engine;
  let hitFrames = [];
  /** V2-08：載入後的原點快照（每次 run 用 restore 回原點，取代 reset） */
  let baseSnapshot = null;
  battle.on('hit', (payload) => {
    const p = isObj(payload) ? payload : {};
    hitFrames.push(Number.isFinite(p.frame) ? p.frame : sim.frame);
  });

  function durationFrames() {
    return sim.durationFrames();
  }

  /**
   * 跑一條路徑。
   *
   * 預設跑完整個回合。可用 `fallback` 指定路徑結束後的輸入，裸路徑預設 stay。
   * 搜尋時可以給 `maxFrames` 縮成短視野、或 `stopOnHit` 在第一次命中就停。
   *
   * @param {Array} path demo.path（{t,x,y,slow?,hold?}）
   * @param {object} [runOptions]
   * @param {number} [runOptions.maxFrames] 最多跑幾幀（預設 = 回合長度）
   * @param {object} [runOptions.followOptions] 跟隨器參數
   * @param {boolean}[runOptions.collectFrames] 是否收集逐幀軌跡
   * @param {boolean}[runOptions.stopOnHit] 第一次命中就停（搜尋評分用，快很多）
   * @param {boolean}[runOptions.measureClearance] 是否量測最小淨空（預設 true）
   * @param {number} [runOptions.clearFromFrame] 只從這一幀起量淨空（局部評估用）
   * @param {number} [runOptions.ignoreHitsBefore] 忽略這一幀之前的命中（局部評估用：
   *        被改動的節點只影響之後的軌跡，之前的命中一定與現任相同）
   */
  function run(path, runOptions = {}) {
    const ro = isObj(runOptions) ? runOptions : {};
    // 允許直接傳 demo 物件（{mode, fallback, path}）——CLI / 測試常這樣傳。
    const list = normalizePoints(isObj(path) && Array.isArray(path.path) ? path.path : path, timing);
    const collectFrames = ro.collectFrames === true;
    const stopOnHit = ro.stopOnHit === true;
    const measureClearance = ro.measureClearance !== false;
    const clearFromFrame = Number.isFinite(ro.clearFromFrame) ? Math.max(0, Math.round(ro.clearFromFrame)) : 0;
    const ignoreHitsBefore = Number.isFinite(ro.ignoreHitsBefore)
      ? Math.max(0, Math.round(ro.ignoreHitsBefore))
      : 0;
    const followOptions = isObj(ro.followOptions) ? ro.followOptions : {};
    const fallback = (isObj(path) ? path.fallback : ro.fallback) ?? 'stay';
    const demo = { mode: 'path', fallback, path: list };
    const timeline = buildPathTimeline(demo.path);

    // V2-08：第一次跑建立「原點快照」，之後每次都用 restore 回原點。
    // 與 battle.reset() 的差別：不重建 RNG / helpers，也不重跑第 0 幀事件；
    // 還原後的模擬狀態與 reset() 後完全相同（tests/snapshot 逐幀驗證）。
    if (!baseSnapshot) {
      battle.reset();
      baseSnapshot = typeof sim.snapshot === 'function' ? sim.snapshot() : null;
    }
    if (!baseSnapshot || typeof sim.restore !== 'function' || !sim.restore(baseSnapshot)) {
      battle.reset();
    }
    hitFrames = [];
    const frames = [];
    let framesRun = 0;
    let minClearance = 999;
    let clearanceFrame = null;
    let minTailClearance = 999;
    let tailFrames = 0;
    const pilot = createSoulPilot({ demo, mode: 'path', followerOptions: followOptions });
    const wanted = Number.isFinite(ro.maxFrames) ? Math.max(1, Math.round(ro.maxFrames)) : durationFrames();

    for (let frame = 0; frame < wanted; frame += 1) {
      const state = stateOf(sim);
      framesRun += 1;
      if (measureClearance && state.frame >= clearFromFrame) {
        const bullets = Array.isArray(state.bullets) ? state.bullets : [];
        let frameClear = 999;
        for (const b of bullets) {
          if (b.decor) continue;
          const clear = clearanceOf(state.soul, b);
          if (clear < frameClear) frameClear = clear;
        }
        if (frameClear < minClearance) {
          minClearance = frameClear;
          clearanceFrame = state.frame;
        }
        const inTail = !timeline || state.time >= timeline.end - 1e-9;
        if (inTail) {
          tailFrames += 1;
          if (frameClear < minTailClearance) minTailClearance = frameClear;
        }
      }
      if (collectFrames) {
        const raw = timeline ? pathTargetAt(timeline, state.time) : null;
        frames.push({
          frame: state.frame,
          target: raw ? { x: raw.x, y: raw.y } : null,
          actual: { x: state.soul.x, y: state.soul.y },
          hit: false,
        });
      }
      if (state.ended) break;

      sim.stepFrame(normalizeFrameInput(pilot.input(state, state.frame)));
      if (stopOnHit && hitFrames.some((f) => f >= ignoreHitsBefore)) break;
    }

    if (collectFrames && hitFrames.length > 0) {
      const hits = new Set(hitFrames);
      for (const frame of frames) if (hits.has(frame.frame)) frame.hit = true;
    }

    const hitsAfter = ignoreHitsBefore > 0 ? hitFrames.filter((f) => f >= ignoreHitsBefore) : hitFrames.slice();
    const result = {
      framesRun,
      hits: hitFrames.length,
      hitFrames: hitFrames.slice(),
      /** 忽略 `ignoreHitsBefore` 之前的命中後剩下的命中（局部評估用）。 */
      hitsAfter: hitsAfter.length,
      hitFramesAfter: hitsAfter,
      ignoredHits: hitFrames.length - hitsAfter.length,
      minClearance,
      clearanceFrame,
      minTailClearance,
      tailFrames,
      endSoul: { x: sim.soul.x, y: sim.soul.y },
      endBox: { ...movementBox(sim.arena, sim.box) },
    };
    if (collectFrames) result.frames = frames;
    return result;
  }

  function destroy() {
    if (battle && typeof battle.destroy === 'function') battle.destroy();
  }

  return { run, destroy, battle, durationFrames };
}

/**
 * 一次性重跑（內部建立一個重跑器、跑完就丟）。
 * @returns {object} 與 createReplayEngine().run() 相同
 */
export function replayPath(attackDoc, path, options = {}) {
  const opts = isObj(options) ? options : {};
  const engine = createReplayEngine(attackDoc, { createBattle: opts.createBattle });
  try {
    return engine.run(path, {
      maxFrames: Number.isFinite(opts.maxFrames) ? opts.maxFrames : undefined,
      followOptions: opts.followOptions,
      fallback: opts.fallback,
      collectFrames: opts.collectFrames === true,
      stopOnHit: opts.stopOnHit === true,
      measureClearance: opts.measureClearance,
    });
  } finally {
    engine.destroy();
  }
}

/** 驗證一條路徑（replayPath 的語意化別名，給 CLI / 測試用）。 */
export function validateDemoPath(attackDoc, path, options = {}) {
  return replayPath(attackDoc, path, options);
}

/* -------------------------------------------------- bot 軌跡（候選） */

/**
 * 用引擎的閃避 bot 跑一次，回傳逐幀靈魂軌跡。
 * bot 軌跡不一定 0 命中，但它是「像人在躲」的合理骨架，當初始候選很有用。
 *
 * @param {object} attackDoc
 * @param {object} [options]
 * @param {number} [options.seed] bot 種子（預設 1）
 * @param {number} [options.maxFrames] 最多跑幾幀
 * @param {Function} [options.createBattle]
 * @returns {{positions:Array<{x:number,y:number}>, slow:boolean[], hits:number, framesRun:number}}
 */
export function botTrajectory(attackDoc, options = {}) {
  const opts = isObj(options) ? options : {};
  const doc = isObj(attackDoc) ? attackDoc : {};
  assertLegacySoulAutomation(doc);
  const makeBattle = typeof opts.createBattle === 'function' ? opts.createBattle : createBattle;
  const battle = makeBattle({ canvas: null, assets: null, mode: 'play' });
  const positions = [];
  const slow = [];
  let hits = 0;
  let framesRun = 0;
  try {
    battle.load(doc);
    const sim = battle.engine;
    const bot = createBot({ bot: 'dodge', seed: num(opts.seed, 1) });
    battle.on('hit', () => {
      hits += 1;
    });
    const total = Number.isFinite(opts.maxFrames) ? Math.max(1, Math.round(opts.maxFrames)) : sim.durationFrames();
    for (let frame = 0; frame < total; frame += 1) {
      const state = battle.getState();
      positions.push({ x: state.soul.x, y: state.soul.y });
      slow.push(false);
      if (state.ended) break;
      const dir = bot.decide(state) || {};
      slow[slow.length - 1] = Boolean(dir.slow);
      sim.stepFrame({ dx: num(dir.dx, 0), dy: num(dir.dy, 0), slow: Boolean(dir.slow) });
      framesRun += 1;
      if (battle.getState().ended) break;
    }
  } finally {
    if (battle && typeof battle.destroy === 'function') battle.destroy();
  }
  return { positions, slow, hits, framesRun };
}

/* ------------------------------------------------------------ 路徑產生 */

/** 8 方向（單位向量）。 */
const UNIT_DIRS = [
  [1, 0],
  [Math.SQRT1_2, Math.SQRT1_2],
  [0, 1],
  [-Math.SQRT1_2, Math.SQRT1_2],
  [-1, 0],
  [-Math.SQRT1_2, -Math.SQRT1_2],
  [0, -1],
  [Math.SQRT1_2, -Math.SQRT1_2],
];

function normalizeOptions(input) {
  const src = isObj(input) ? input : {};
  const out = { ...PATHGEN_DEFAULTS };
  for (const key of [
    'seed',
    'step',
    'maxNodes',
    'maxSweeps',
    'timeBudgetMs',
    'comfort',
    'moveWeight',
    'centerWeight',
    'maxReportedHits',
  ]) {
    const value = num(src[key], NaN);
    if (Number.isFinite(value)) out[key] = value;
  }
  out.comfort = Math.max(0, num(src.minClearance, out.comfort));
  out.fallback = src.fallback === 'stay' ? 'stay' : PATHGEN_DEFAULTS.fallback;
  out.step = Math.max(1 / FPS, out.step);
  out.maxNodes = Math.max(0, Math.round(out.maxNodes));
  out.maxSweeps = Math.max(1, Math.round(out.maxSweeps));
  out.timeBudgetMs = Math.max(50, out.timeBudgetMs);
  out.onProgress = typeof src.onProgress === 'function' ? src.onProgress : null;
  out.signal = src.signal && typeof src.signal === 'object' ? src.signal : null;
  out.replay = typeof src.replay === 'function' ? src.replay : null;
  out.createBattle = typeof src.createBattle === 'function' ? src.createBattle : null;
  out.followOptions = isObj(src.followOptions) ? src.followOptions : {};
  out.botSeed = num(src.botSeed, out.seed);
  out.useExistingDemo = src.useExistingDemo !== false;
  return out;
}

/**
 * 由攻擊檔自動產生一條 0 命中的 demo 路徑（初始候選 + 逐節點座標下降）。
 *
 * @param {object} attackDoc 攻擊檔（dr-battle-attack/1）
 * @param {object} [options] 見檔案開頭
 */
export function generateDemoPath(attackDoc, options = {}) {
  const startedAt = nowMs();
  const opts = normalizeOptions(options);
  const doc = isObj(attackDoc) ? attackDoc : {};
  assertLegacySoulAutomation(doc);
  const settings = isObj(doc.settings) ? doc.settings : {};
  // 拍點（V2-FIX1）：duration 可能是 "16b"；沒有 bpm 時回退到舊的 num() 行為（預設 10 秒）
  const timing = beatTimingOf(settings);
  const duration = Math.max(1 / FPS, secondsOf(settings.duration, timing, 10));
  const step = opts.step;
  const stepFrames = Math.max(1, Math.round(step * FPS));
  const durationFrames = Math.max(1, Math.round(duration * FPS));
  const autoNodes = Math.floor(duration / step) + 1;
  const nodeCount = Math.max(2, Math.min(opts.maxNodes > 0 ? opts.maxNodes : 120, autoNodes));
  /** 最後一個節點的 t（讓 path 覆蓋整個回合）。 */
  const endT = round3(Math.max(step, duration - 1 / FPS));

  const soulCfg = isObj(doc.soul) ? doc.soul : {};
  const speed = Math.max(0.1, num(soulCfg.speed, 4));
  const slowSpeed = Math.max(0.05, num(soulCfg.slowSpeed, Math.max(0.5, speed / 2)));
  const stepPx = speed * stepFrames;
  const slowStepPx = slowSpeed * stepFrames;

  const rng = createRng(opts.seed);
  const arena = compileArena(doc.arena);
  const startBox = movementBox(arena, initialBox(doc));
  const authoredSoul = initialSoul(doc);
  const startSoul = arena.kind === 'box' ? authoredSoul : projectDodgePoint(arena, startBox, authoredSoul.x, authoredSoul.y, SOUL_RADIUS);
  const comfort = opts.comfort;
  const clampAt = (x, y) => projectDodgePoint(arena, startBox, x, y, SOUL_RADIUS);

  const progress = (payload) => {
    if (!opts.onProgress) return;
    try {
      opts.onProgress(payload);
    } catch (_err) {
      /* 進度回呼的錯不影響產生 */
    }
  };

  let aborted = false;
  let reason = '';
  const elapsed = () => nowMs() - startedAt;
  const checkAbort = () => {
    if (aborted) return true;
    if (opts.signal && opts.signal.aborted) {
      aborted = true;
      reason = 'aborted';
      return true;
    }
    if (elapsed() >= opts.timeBudgetMs) {
      aborted = true;
      reason = 'time-budget';
      return true;
    }
    return false;
  };

  /* --- 重跑器（V2-08 換掉這一層） --- */
  const ownEngine = opts.replay ? null : createReplayEngine(doc, { createBattle: opts.createBattle });
  const replayFn = opts.replay
    ? (path, runOpts) => opts.replay(path, runOpts)
    : (path, runOpts) => ownEngine.run(path, runOpts);

  let attempts = 0;
  const runPath = (path, { stopOnHit = false } = {}) => {
    attempts += 1;
    return replayFn(path, {
      followOptions: opts.followOptions,
      fallback: opts.fallback,
      stopOnHit,
      measureClearance: true,
    });
  };

  /* ---------------- 評分 ----------------
   * 字典序（越前面越重要）：
   *   1. 命中數（0 最好）
   *   2. 首命中時間（越晚越好；各種比較都先看它才能「逐步把命中往後推」）
   *   3. 最小淨空（越大越好，最高只算 comfort）
   *   4. 移動量 + 遠離中心（越小越好）
   */
  const metricsOf = (path, run) => {
    let move = 0;
    for (let i = 1; i < path.length; i += 1) {
      const d = Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y);
      const allowed = path[i - 1].slow ? slowStepPx : stepPx;
      move += d + (d > allowed * 1.06 ? (d - allowed * 1.06) * 6 : 0);
    }
    const box = run.endBox || startBox;
    const centerDist = Math.hypot(run.endSoul.x - box.x, run.endSoul.y - box.y);
    const clear = Number.isFinite(run.minClearance) ? Math.min(comfort, run.minClearance) : comfort;
    // 0 命中時淨空已經足夠（≥ comfort）就不必再計淨空虧損，避免為了
    // 「多 0.1px 淨空」把預算燒光。
    const clearPenalty = run.hits === 0 ? 0 : (comfort - Math.max(-40, clear)) * 0.5;
    return {
      hits: run.hits,
      firstHit: run.hits > 0 ? run.hitFrames[0] : Infinity,
      clearance: clear,
      cost: move * opts.moveWeight + centerDist * opts.centerWeight + clearPenalty,
    };
  };

  /** 嚴格更好 → 回傳 true（字典序，最後才比 cost）。 */
  const isBetter = (a, b) => {
    if (!b) return true;
    if (a.hits !== b.hits) return a.hits < b.hits;
    if (a.firstHit !== b.firstHit) return a.firstHit > b.firstHit;
    if (Math.abs(a.clearance - b.clearance) > 0.01) return a.clearance > b.clearance;
    return a.cost < b.cost - 1e-9;
  };

  /* ---------------- 初始候選 ---------------- */
  /** 把任意「{t,x,y,slow?} 點列」重新取樣成剛好 nodeCount 個節點（時間等距、線性插值）。 */
  const resampleNodes = (points) => {
    const list = normalizePoints(points, timing);
    const nodes = [];
    if (list.length === 0) return fromTrack([{ x: startSoul.x, y: startSoul.y }], null);
    const timeline = buildPathTimeline(list);
    const end = timeline ? timeline.end : list[list.length - 1].t;
    for (let i = 0; i < nodeCount; i += 1) {
      const t = Math.min(i * step, end);
      const raw = timeline ? pathTargetAt(timeline, t) : null;
      const source = raw || list[Math.min(list.length - 1, i)];
      // 故意不夾框：原路徑點可能為了預判而略微超出框，夾進來會改變軌跡
      // （實測 sine-wave 只夾這 3px 就從 0 命中變 1 命中）。跟隨器自己會夾。
      const node = { t: round3(i * step), x: round3(num(source.x, 0)), y: round3(num(source.y, 0)) };
      if (raw && raw.slow) node.slow = true;
      nodes.push(node);
    }
    return nodes;
  };

  /** 把任意逐幀軌跡取樣成 nodeCount 個節點。 */
  const fromTrack = (positions, slowFlags) => {
    const nodes = [];
    for (let i = 0; i < nodeCount; i += 1) {
      const frame = Math.min(positions.length - 1, Math.round(i * step));
      const src = positions[frame] || positions[positions.length - 1];
      const p = clampAt(src.x, src.y);
      const node = { t: round3(i * step), x: round3(p.x), y: round3(p.y) };
      if (i > 0 && slowFlags && slowFlags[frame]) nodes[i - 1].slow = true;
      nodes.push(node);
    }
    return nodes;
  };

  const seeds = [];
  if (opts.useExistingDemo && isObj(doc.demo) && Array.isArray(doc.demo.path) && doc.demo.path.length > 0) {
    const path = normalizePoints(doc.demo.path, timing);
    const nodes = resampleNodes(doc.demo.path);
    if (path.length > 0) seeds.push({ label: 'authored', nodes, path });
    seeds.push({ label: 'demo', nodes });
  }
  try {
    const bot = botTrajectory(doc, { seed: opts.botSeed, createBattle: opts.createBattle });
    if (bot && bot.positions.length > 0) seeds.push({ label: 'bot', nodes: fromTrack(bot.positions, bot.slow) });
    progress({ phase: 'seeds', hits: bot ? bot.hits : null, elapsedMs: Math.round(elapsed()) });
  } catch (_err) {
    /* bot 失敗就用其他候選 */
  }
  {
    const nodes = [];
    for (let i = 0; i < nodeCount; i += 1) {
      const p = clampAt(startSoul.x, startSoul.y);
      nodes.push({ t: round3(i * step), x: round3(p.x), y: round3(p.y) });
    }
    seeds.push({ label: 'stay', nodes });
  }
  for (let k = 0; k < 2; k += 1) {
    // 橢圓繞行（不同起始相位），讓搜尋有「本來就在動」的起點
    const radiusX = Math.max(4, Math.min(startBox.w * 0.3, startBox.w / 2 - SOUL_RADIUS - 6));
    const radiusY = Math.max(4, Math.min(startBox.h * 0.3, startBox.h / 2 - SOUL_RADIUS - 6));
    const phase = rng.next() * Math.PI * 2;
    const dir = rng.next() < 0.5 ? 1 : -1;
    const nodes = [];
    for (let i = 0; i < nodeCount; i += 1) {
      const angle = phase + dir * (i / Math.max(1, nodeCount - 1)) * Math.PI * 2 * (k === 0 ? 1 : 1.5);
      const p = clampAt(startBox.x + Math.cos(angle) * radiusX, startBox.y + Math.sin(angle) * radiusY);
      nodes.push({ t: round3(i * step), x: round3(p.x), y: round3(p.y) });
    }
    seeds.push({ label: `orbit${k}`, nodes });
  }
  {
    // 種子隨機遊走
    const nodes = [];
    let current = clampAt(startSoul.x, startSoul.y);
    for (let i = 0; i < nodeCount; i += 1) {
      nodes.push({ t: round3(i * step), x: round3(current.x), y: round3(current.y) });
      const angle = rng.next() * Math.PI * 2;
      const distance = stepPx * (0.5 + rng.next() * 0.5);
      current = clampAt(current.x + Math.cos(angle) * distance, current.y + Math.sin(angle) * distance);
    }
    seeds.push({ label: 'walk', nodes });
  }

  try {
    let best = null;
    for (const seed of seeds) {
      if (checkAbort()) break;
      const path = seed.path || compactPath(seed.nodes, endT);
      const run = runPath(path, { stopOnHit: true });
      const metrics = metricsOf(seed.nodes, run);
      metrics.label = seed.label;
      progress({
        phase: 'seed',
        label: seed.label,
        hits: run.hits,
        firstHit: run.hits > 0 ? run.hitFrames[0] : null,
        clearance: Math.round(metrics.clearance * 10) / 10,
        elapsedMs: Math.round(elapsed()),
      });
      if (isBetter(metrics, best)) best = { nodes: seed.nodes, path, run, metrics };
      if (best.metrics.hits === 0 && best.metrics.clearance >= comfort) break;
    }
    if (!best) {
      const nodes = seeds[0].nodes;
      const path = compactPath(nodes, endT);
      const run = runPath(path, { stopOnHit: true });
      best = { nodes, path, run, metrics: metricsOf(nodes, run) };
    }

    let current = best;
    progress({
      phase: 'init',
      hits: current.metrics.hits,
      firstHit: current.metrics.firstHit === Infinity ? null : current.metrics.firstHit,
      bestCost: Math.round(current.metrics.cost * 100) / 100,
      elapsedMs: Math.round(elapsed()),
    });

    /**
     * 節點 index 的候選位置：8 方向 × 三種步長（全速 / 0.7 / slow），
     * 加上原地、以及「沿目前方向再走 / 往框中心走」。
     * `slowSegment` = 前一個點 → 這一點是慢速（標在前一個點上）。
     */
    const candidatePositions = (nodes, index, jitterCount) => {
      const prev = nodes[index - 1];
      const out = [];
      const current = nodes[index];
      // 微調已有路徑，在保留閃避節奏下優先拉開距離。
      for (const distance of [2, 4]) {
        for (const [ux, uy] of UNIT_DIRS) {
          const p = clampAt(current.x + ux * distance, current.y + uy * distance);
          out.push({ x: round3(p.x), y: round3(p.y), slowSegment: prev.slow === true });
        }
      }
      // 沿目前這段的方向（延續原本的移動，避免每步都重新選方向）
      const dx0 = current.x - prev.x;
      const dy0 = current.y - prev.y;
      const d0 = Math.hypot(dx0, dy0);
      if (d0 > 0.5) {
        for (const scale of [1, 1.2, 0.6]) {
          const take = Math.min(stepPx * scale, d0 * (1 + 0.5 * (scale - 1)) + stepPx * 0.4);
          const p = clampAt(prev.x + (dx0 / d0) * Math.max(1, take), prev.y + (dy0 / d0) * Math.max(1, take));
          out.push({ x: round3(p.x), y: round3(p.y), slowSegment: Math.max(1, take) <= slowStepPx * 1.1 });
        }
      }
      for (const [ux, uy] of UNIT_DIRS) {
        for (const scale of [1, 0.7, 0.4]) {
          const distance = Math.max(1, stepPx * scale);
          const p = clampAt(prev.x + ux * distance, prev.y + uy * distance);
          out.push({ x: round3(p.x), y: round3(p.y), slowSegment: distance <= slowStepPx * 1.1 });
        }
      }
      // 往框中心（保守）與遠離框中心（爭取空間）
      const bx = startBox.x;
      const by = startBox.y;
      const cd = Math.hypot(prev.x - bx, prev.y - by);
      if (cd > 0.5) {
        for (const sign of [1, -1]) {
          const p = clampAt(prev.x + sign * ((bx - prev.x) / cd) * stepPx, prev.y + sign * ((by - prev.y) / cd) * stepPx);
          out.push({ x: round3(p.x), y: round3(p.y), slowSegment: false });
        }
      }
      // 種子微擾
      for (let k = 0; k < jitterCount; k += 1) {
        const angle = rng.next() * Math.PI * 2;
        const distance = stepPx * (0.3 + rng.next() * 0.8);
        const p = clampAt(prev.x + Math.cos(angle) * distance, prev.y + Math.sin(angle) * distance);
        out.push({ x: round3(p.x), y: round3(p.y), slowSegment: distance <= slowStepPx * 1.1 });
      }
      // 原地（保守選項）
      out.push({ x: round3(prev.x), y: round3(prev.y), slowSegment: false });
      return out;
    };

    /* ---------------- 逐節點座標下降 ---------------- */
    let fullValidated = runPath(current.path, { stopOnHit: false });
    current.run = fullValidated;
    current.metrics = metricsOf(current.nodes, fullValidated);

    for (let sweep = 0; sweep < opts.maxSweeps; sweep += 1) {
      if (checkAbort()) break;
      let improvedInSweep = false;
      const criticalFrame = current.run.hitFrames[0] ?? current.run.clearanceFrame;
      const criticalNode = criticalFrame == null ? 1 : Math.ceil(criticalFrame / FPS / step);
      const indices = Array.from({ length: nodeCount - 1 }, (_, i) => i + 1);
      indices.sort((a, b) => Math.abs(a - criticalNode) - Math.abs(b - criticalNode));
      for (const index of indices) {
        if (checkAbort()) break;
        const incumbent = current.metrics;
        const jitterCount = index % 3 === 0 ? 3 : 1;
        let localBest = null;
        for (const position of candidatePositions(current.nodes, index, jitterCount)) {
          // 每個候選都複製節點（不可共用物件：改 slow 會污染其他候選）
          const nodes = current.nodes.map((node, i) => {
            const copy = { t: node.t, x: node.x, y: node.y };
            if (node.slow) copy.slow = true;
            if (i === index) {
              copy.x = position.x;
              copy.y = position.y;
            }
            return copy;
          });
          // slow 標在前一個點：代表「前一個點 → 這一點」慢速移動
          if (index - 1 >= 0) {
            if (position.slowSegment) nodes[index - 1].slow = true;
            else delete nodes[index - 1].slow;
          }
          const path = compactPath(nodes, endT);
          const run = runPath(path, { stopOnHit: true });
          const metrics = metricsOf(nodes, run);
          if (isBetter(metrics, localBest ? localBest.metrics : incumbent)) localBest = { nodes, path, run, metrics };
          if (localBest && localBest.metrics.hits === 0 && localBest.metrics.clearance >= comfort) break;
          if (checkAbort()) break;
        }
        if (localBest && isBetter(localBest.metrics, current.metrics)) {
          // 用完整回合驗證一次，確定不是短視野假象
          const runFull = runPath(localBest.path, { stopOnHit: false });
          const metricsFull = metricsOf(localBest.nodes, runFull);
          if (isBetter(metricsFull, current.metrics)) {
            current = { nodes: localBest.nodes, path: localBest.path, run: runFull, metrics: metricsFull };
            improvedInSweep = true;
          }
        }
        progress({
          phase: 'optimize',
          sweep: sweep + 1,
          index,
          nodes: nodeCount,
          hits: current.metrics.hits,
          firstHit: current.metrics.firstHit === Infinity ? null : current.metrics.firstHit,
          clearance: Math.round(current.metrics.clearance * 10) / 10,
          bestCost: Math.round(current.metrics.cost * 100) / 100,
          elapsedMs: Math.round(elapsed()),
        });
      }
      if (!improvedInSweep) break;
      if (current.metrics.hits === 0 && current.metrics.clearance >= comfort) break;
    }

    /* ---------------- 最終整理與驗證 ---------------- */
    const cleanPath = current.path;
    const okRun = runPath(cleanPath, { stopOnHit: false });
    const ok = okRun.hits === 0;
    const demo = { mode: 'path', fallback: opts.fallback, path: cleanPath };
    const finalMetrics = metricsOf(current.nodes, okRun);

    progress({
      phase: 'validate',
      hits: okRun.hits,
      ok,
      minClearance: okRun.minClearance,
      elapsedMs: Math.round(elapsed()),
    });

    return {
      ok,
      demo,
      path: cleanPath,
      hits: okRun.hits,
      hitFrames: okRun.hitFrames.slice(0, opts.maxReportedHits),
      clearanceTarget: comfort,
      clearanceMet: okRun.minClearance >= comfort,
      validation: okRun,
      best: {
        label: current.metrics.label || (seeds[0] && seeds[0].label) || null,
        hits: okRun.hits,
        framesRun: okRun.framesRun,
        minClearance: okRun.minClearance,
        cost: Math.round(finalMetrics.cost * 100) / 100,
      },
      attempts,
      elapsedMs: Math.round(elapsed()),
      aborted,
      reason: aborted ? reason || 'aborted' : ok ? 'ok' : 'hits',
      options: {
        seed: opts.seed,
        step: opts.step,
        maxNodes: nodeCount,
        maxSweeps: opts.maxSweeps,
        timeBudgetMs: opts.timeBudgetMs,
      },
    };
  } finally {
    if (ownEngine) ownEngine.destroy();
  }
}

export default generateDemoPath;
