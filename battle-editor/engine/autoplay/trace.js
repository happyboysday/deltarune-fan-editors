/**
 * engine/autoplay/trace.js — 實跑 demo 並記錄「預定 vs 實際」軌跡（SPEC-AUTOPLAY §3）
 *
 * 給編輯器畫兩條線用：一條是 `demo.path` 依時間插值出來的**預定**位置，
 * 一條是引擎實跑後靈魂的**實際**位置；同時記下每一幀是否受傷。
 *
 * 對外：
 *   traceDemo(attackDoc, opts) → {
 *     frames: [{ frame, target: {x,y}, actual: {x,y}, hit: boolean, slow, pathActive }],
 *     hits:   [{ frame, x, y, type, damage }],
 *     summary: { frames, hits, firstHitFrame, endFrame, ended, mode, warnings },
 *   }
 *
 * 也可只追蹤任意路徑（不寫進攻擊檔）：
 *   traceDemo(attackDoc, { path: [{t:0,x:320,y:190}, …] })
 *
 * 模組不 import 任何 Node 專屬模組 → 瀏覽器與 Node 皆可載入。
 */

import { createBattle } from '../index.js';
import { beatTimingOf, timeToSeconds } from '../attack.js';
import { createSoulPilot, buildPathTimeline, pathTargetAt } from './soul.js';
import { projectDodgePoint, SOUL_AUTOMATION_UNSUPPORTED, usesSoulProfiles } from './bot.js';
import { normalizeFrameInput } from '../input.js';

/** 靈魂碰撞半徑（與 engine/sim.js 一致）。 */
const SOUL_RADIUS = 4;

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

/**
 * 時間欄位 → 秒（V2-FIX1）：數字（秒）或拍點字串（`"2b"`，SPEC-EXPR-V2 §1）。
 * 沒有 bpm 時拍點字串無法換算 → 回傳 fallback（維持舊行為）。
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

/**
 * demo.path 的 `t` 正規化成秒（V2-FIX1）：拍點字串依 settings.bpm 換算，
 * 時間點欄位加上 settings.beatOffset（與 engine/attack.js 的 demo 正規化同一規則）。
 */
function pathSeconds(path, timing) {
  return (Array.isArray(path) ? path : [])
    .map((point) => {
      if (!isObj(point)) return null;
      const t = secondsOf(point.t, timing, null, true);
      if (t === null || !Number.isFinite(Number(point.x)) || !Number.isFinite(Number(point.y))) return null;
      return { ...point, t: Math.max(0, t) };
    })
    .filter(Boolean)
    .sort((a, b) => a.t - b.t);
}

/**
 * 把追蹤結果壓成摘要（給 CLI / UI 顯示）。
 * @param {object[]} frames
 * @param {object[]} hits
 */
export function summarizeTrace(frames, hits) {
  const list = Array.isArray(frames) ? frames : [];
  const hitList = Array.isArray(hits) ? hits : [];
  const firstHit = hitList.length > 0 ? hitList[0].frame : null;
  return {
    frames: list.length,
    hits: hitList.length,
    firstHitFrame: firstHit,
    endFrame: list.length > 0 ? list[list.length - 1].frame : 0,
    ended: list.length > 0 ? Boolean(list[list.length - 1].ended) : false,
    origin: hitList.length > 0 ? { frame: firstHit, x: hitList[0].x, y: hitList[0].y } : null,
  };
}

/**
 * 實跑一次 demo / 路徑並記錄逐幀軌跡。
 *
 * @param {object} attackDoc 攻擊檔（需要 settings.duration、box、soul…）
 * @param {object} [options]
 * @param {object} [options.demo]    demo 物件（預設 attackDoc.demo）
 * @param {Array}  [options.path]    覆寫 demo.path（只追這條路徑）
 * @param {string} [options.mode]    'demo'（預設）| 'path' | 'inputs' | 'bot' | 'stay' | 'none'
 * @param {number} [options.maxFrames] 最多跑幾幀（預設回合長度）
 * @param {number} [options.stopAfterHits] 受傷達此次數就提早停（預設 Infinity = 跑完）
 * @param {boolean}[options.keepGoing] 受傷後仍繼續（預設 true；false = 一受傷就停）
 * @param {(doc:object)=>object} [options.createBattle] 客製引擎建立（V2-08 snapshot 用）
 */
export function traceDemo(attackDoc, options = {}) {
  const opts = isObj(options) ? options : {};
  const doc = isObj(attackDoc) ? attackDoc : {};
  const demo = isObj(opts.demo) ? opts.demo : isObj(doc.demo) ? doc.demo : null;
  const path = Array.isArray(opts.path) ? opts.path : null;
  // 拍點（V2-FIX1）：demo.path[].t 可能是 "2b" → 先換成秒，後面的時間軸 / pilot 只吃秒
  const timing = beatTimingOf(isObj(doc.settings) ? doc.settings : {});
  const rawPath = path || (isObj(demo) && Array.isArray(demo.path) ? demo.path : null);
  const convertedPath = rawPath ? pathSeconds(rawPath, timing) : null;
  const effectiveDemo = path
    ? { ...(demo || {}), mode: 'path', path: convertedPath || [] }
    : convertedPath
      ? { ...demo, path: convertedPath }
      : demo;
  const mode = typeof opts.mode === 'string' ? opts.mode : 'demo';
  const makeBattle = typeof opts.createBattle === 'function' ? opts.createBattle : createBattle;
  const stopAfterHits = Number.isFinite(opts.stopAfterHits) ? Math.max(1, opts.stopAfterHits) : Infinity;
  const keepGoing = opts.keepGoing !== false;

  let timeline = effectiveDemo && !usesSoulProfiles(doc) ? buildPathTimeline(effectiveDemo.path) : null;
  if (timeline && timeline.end <= 1e-9) {
    // 單點路徑（t=0、沒有 hold）：引擎的 `end` 會是 0，等於「路徑立刻用完」。
    // 對「畫預定 vs 實際兩條線」來說這沒有意義，所以視為整回合都停在該點。
    const duration = secondsOf(isObj(doc.settings) ? doc.settings.duration : null, timing, 10);
    const pts = timeline.pts.map((point) => ({ ...point }));
    pts[pts.length - 1].hold = Math.max(1, duration);
    timeline = buildPathTimeline(pts);
  }
  const fps = Math.max(1, num(opts.fps, 30));
  const frames = [];
  const hits = [];
  const pilot = createSoulPilot({ attack: doc, demo: effectiveDemo, mode, fps });
  const warnings = pilot.warnings;
  if (pilot.mode === 'stay' && warnings.includes(SOUL_AUTOMATION_UNSUPPORTED)) {
    return { frames, hits, warnings, summary: { ...summarizeTrace(frames, hits), mode: pilot.mode, warnings } };
  }

  const battle = makeBattle({ canvas: null, assets: null, mode: 'play' });
  let sim = null;
  try {
    battle.load(doc);
    sim = battle.engine;
    battle.on('hit', (payload) => {
      const p = isObj(payload) ? payload : {};
      hits.push({
        frame: Number.isFinite(p.frame) ? p.frame : sim.frame,
        x: isObj(p.soul) ? num(p.soul.x, 0) : sim.soul.x,
        y: isObj(p.soul) ? num(p.soul.y, 0) : sim.soul.y,
        type: typeof p.type === 'string' ? p.type : null,
        damage: Number.isFinite(p.damage) ? p.damage : null,
      });
    });

    const total = Number.isFinite(opts.maxFrames)
      ? Math.max(0, Math.round(opts.maxFrames))
      : sim.durationFrames();

    /** 路徑結束後沿用最後一個目標（編輯器畫線才不會突然斷掉）。 */
    let lastTarget = { x: sim.soul.x, y: sim.soul.y };

    for (let frame = 0; frame < total; frame += 1) {
      const state = battle.getState();
      const hitThisFrame = hits.length > 0 && hits[hits.length - 1].frame === state.frame;
      const raw = timeline ? pathTargetAt(timeline, state.frame / fps) : null;
      const pathActive = Boolean(raw);
      let target;
      if (raw) {
        target = projectDodgePoint(state.arena, state.box, raw.x, raw.y, SOUL_RADIUS);
        lastTarget = target;
      } else {
        target = lastTarget;
      }
      frames.push({
        frame: state.frame,
        target: { x: target.x, y: target.y },
        actual: { x: state.soul.x, y: state.soul.y },
        hit: Boolean(hitThisFrame),
        slow: raw ? Boolean(raw.slow) : false,
        pathActive,
        ended: Boolean(state.ended),
      });

      if (state.ended) break;
      if (hits.length >= stopAfterHits && hits.length > 0) break;

      sim.stepFrame(normalizeFrameInput(pilot.input(state, state.frame)));
      if (!keepGoing && hits.length > 0) break;
    }

    // 提早停（一受傷就停 / 命中數到上限）時，最後一幀還沒被記錄：
    // 補上「命中那一幀」的狀態，編輯器才畫得出打到的位置。
    if (frames.length > 0 && hits.length > 0) {
      const recorded = new Set(frames.map((frame) => frame.frame));
      const post = battle.getState();
      for (const hit of hits) {
        if (recorded.has(hit.frame)) continue;
        frames.push({
          frame: hit.frame,
          target: { x: lastTarget.x, y: lastTarget.y },
          actual: { x: post.soul.x, y: post.soul.y },
          hit: true,
          slow: false,
          pathActive: Boolean(timeline),
          ended: Boolean(post.ended),
        });
      }
      frames.sort((a, b) => a.frame - b.frame);
    }
  } finally {
    if (battle && typeof battle.destroy === 'function') battle.destroy();
  }

  const summary = { ...summarizeTrace(frames, hits), mode, warnings };
  return { frames, hits, summary, warnings };
}

/**
 * 逐幀的最大偏差與平均偏差（給報告 / 測試用）。
 * @param {object[]} frames traceDemo 的 frames
 */
export function deviationStats(frames) {
  const list = (Array.isArray(frames) ? frames : []).filter((f) => f && f.pathActive && isObj(f.target) && isObj(f.actual));
  if (list.length === 0) return { frames: 0, avg: 0, max: 0, maxFrame: null, values: [] };
  const values = list.map((f) => Math.hypot(f.actual.x - f.target.x, f.actual.y - f.target.y));
  let max = 0;
  let maxFrame = null;
  for (let i = 0; i < values.length; i += 1) {
    if (values[i] > max) {
      max = values[i];
      maxFrame = list[i].frame;
    }
  }
  const sum = values.reduce((acc, v) => acc + v, 0);
  return { frames: list.length, avg: sum / values.length, max, maxFrame, values };
}

export default traceDemo;
