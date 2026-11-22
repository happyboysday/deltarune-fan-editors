// editor/encounter/timeline.js  (V2-07)
//
// 遭遇時間軸總覽：每個回合列（台詞估算長度、彈幕實際長度、cue 標記、bpm 拍線）。
//
// 資料來源：
//   1. 優先用 engine/encounter 的 headless 模擬（demo / bot autopilot）取得
//      turnStart / turnEnd / say / attackStart / attackEnd 的實際影格，
//      換算成毫秒後畫成比例條。
//   2. 模擬不可用（缺 demo、缺攻擊、載入失敗）時退回估算：
//      台詞 = 字數 ÷ 打字速度；彈幕 = 攻擊 settings.duration。
//
// 純資料函式集中在檔案前段，可直接在 node 測試（不碰 DOM）。

import { collectAttackRefs as collectTimelineAttackNames } from '../../engine/encounter/attack-refs.js';
import { TURN_CUE_KEYS } from '../../engine/encounter/schema.js';
import { t, registerStrings, onLocaleChange } from '../i18n.js';
import { el, clear, button, selectEl } from '../fields.js';
import { KIND } from './tree.js';
import STRINGS from '../locales/encounter-timeline.js';

registerStrings('encTimeline', STRINGS);

const T = (key, params) => t(`encTimeline.${key}`, params);

/** 遭遇固定 30 FPS（SPEC-P2）。 */
export const TIMELINE_FPS = 30;

/** cue 標記只列「演出／分支」類，略過逐句台詞以免總覽過長。 */
export const CHIP_COMMANDS = [
  'form',
  'bgm',
  'if',
  'set',
  'attack',
  'anim',
  'mercy',
  'heal',
  'damage',
  'shake',
  'flash',
  'sfx',
];

const CHIP_KIND = {
  form: 'form',
  bgm: 'bgm',
  if: 'other',
  set: 'other',
  attack: 'other',
  anim: 'other',
  mercy: 'act',
  heal: 'act',
  damage: 'other',
  shake: 'other',
  flash: 'other',
  sfx: 'other',
};

/* =========================================================================
 * 1. 純資料
 * ========================================================================= */

/** 文字欄位（雙語物件 / 字串）→ 字串。 */
export function textOf(value) {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  for (const key of ['zh', 'zh-Hant', 'zh-Hans', 'en']) {
    if (typeof value[key] === 'string') return value[key];
  }
  return '';
}

/** 回合台詞字串清單。 */
export function turnTalkTexts(turn) {
  const talk = turn && Array.isArray(turn.talk) ? turn.talk : [];
  const out = [];
  for (const entry of talk) {
    const text = textOf(entry && entry.text);
    if (text) out.push(text);
  }
  return out;
}

/** 台詞估算毫秒：字數 ÷（fps × 字/幀）。 */
export function estimateTypingMs(turn, opts = {}) {
  const fps = Number(opts.fps) > 0 ? Number(opts.fps) : TIMELINE_FPS;
  const charsPerFrame = Number(opts.charsPerFrame) > 0 ? Number(opts.charsPerFrame) : 1;
  let chars = 0;
  for (const text of turnTalkTexts(turn)) chars += text.length;
  // 每句結尾的停頓（自動/手動推進的粗略估計）
  const holdMs = Number(opts.holdMs) >= 0 ? Number(opts.holdMs) : 250;
  const lines = turnTalkTexts(turn).length;
  return (chars / (fps * charsPerFrame)) * 1000 + lines * holdMs;
}

/** 回合引用的攻擊名（字串 / {name} / {ref}）。 */
export function attackNameOf(turn) {
  if (!turn) return null;
  const ref = turn.attack;
  if (typeof ref === 'string' && ref.trim()) return ref.trim();
  if (ref && typeof ref === 'object') {
    for (const key of ['name', 'ref', 'id', 'file', 'attack']) {
      if (typeof ref[key] === 'string' && ref[key].trim()) return ref[key].trim();
    }
  }
  return null;
}

export { collectTimelineAttackNames };

/** 攻擊長度毫秒（settings.duration 秒；缺值 2 秒）。 */
export function attackDurationMs(attacks, name) {
  const doc = attacks && typeof attacks.get === 'function' ? attacks.get(name) : attacks ? attacks[name] : null;
  const settings = doc && doc.settings && typeof doc.settings === 'object' ? doc.settings : {};
  const seconds = Number(settings.duration);
  if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  return 2000;
}

/** 取得攻擊文件（Map 或一般物件）。 */
function attackDocOf(attacks, name) {
  if (!name || !attacks) return null;
  if (typeof attacks.get === 'function') return attacks.get(name) || null;
  return attacks[name] || null;
}

/** 攻擊 bpm → 拍線（相對攻擊段起點的毫秒）。沒有 bpm 回 null。 */
export function computeBeats(attackDoc, attackMs, opts = {}) {
  const settings = attackDoc && attackDoc.settings && typeof attackDoc.settings === 'object' ? attackDoc.settings : {};
  const bpm = Number(settings.bpm);
  if (!Number.isFinite(bpm) || bpm <= 0) return null;
  const maxBeats = Number(opts.maxBeats) > 0 ? Number(opts.maxBeats) : 400;
  const beatMs = 60000 / bpm;
  // beatOffset 的單位是「拍」（SPEC-EXPR-V2 §bpm / ROADMAP §1）
  const offsetBeats = Number(settings.beatOffset);
  const firstMs = Number.isFinite(offsetBeats) ? offsetBeats * beatMs : 0;
  const beats = [];
  if (attackMs <= 0) return { bpm, beatMs, offsetMs: firstMs, beats };
  for (let index = 0; index < maxBeats; index += 1) {
    const ms = firstMs + index * beatMs;
    if (ms > attackMs + 0.5) break;
    if (ms < -0.5) continue;
    beats.push({ ms: Math.max(0, ms), index, bar: index % 4 === 0 });
  }
  return { bpm, beatMs, offsetMs: firstMs, beats };
}

/** 蒐集一個回合的 cue 標記（turn.start / turn.end，含 if/parallel 內層）。 */
export function collectTurnCueChips(turn) {
  const chips = [];
  const walk = (list, depth, branch) => {
    if (!Array.isArray(list) || depth > 8) return;
    for (const cue of list) {
      if (!cue || typeof cue !== 'object' || typeof cue.cmd !== 'string') continue;
      const cmd = cue.cmd;
      if (CHIP_COMMANDS.includes(cmd)) {
        const label = cueChipLabel(cmd, cue, branch);
        if (label) chips.push({ cmd, kind: CHIP_KIND[cmd] || 'other', label });
      }
      if (cmd === 'if') {
        walk(cue.then, depth + 1, 'then');
        walk(cue.else, depth + 1, 'else');
      } else if (cmd === 'parallel') {
        walk(cue.cues, depth + 1, branch);
      }
    }
  };
  for (const key of TURN_CUE_KEYS) walk(turn?.[key], 0, null);
  return chips;
}

/** cue → 總覽用小標籤。 */
export function cueChipLabel(cmd, cue, branch) {
  switch (cmd) {
    case 'form':
      return `form: ${cue.actor || '?'}→${cue.name || '?'}`;
    case 'bgm':
      return `bgm: ${cue.track === null || cue.track === undefined ? '∅' : cue.track}`;
    case 'set':
      return `set: ${cue.var || cue.name || '?'}=${cue.value === undefined ? '?' : cue.value}`;
    case 'if': {
      const cond = String(cue.cond === undefined ? '?' : cue.cond);
      return `if${branch ? `(${branch})` : ''}: ${cond.length > 22 ? `${cond.slice(0, 21)}…` : cond}`;
    }
    case 'attack':
      return `attack: ${cue.name || cue.ref || cue.attack || '?'}`;
    case 'anim':
      return `anim: ${cue.actor || '?'}.${cue.anim || '?'}`;
    case 'mercy':
      return `mercy: ${cue.enemy || cue.target || '?'}+${cue.amount === undefined ? '?' : cue.amount}`;
    case 'heal':
      return `heal: ${cue.target || cue.actor || '?'}+${cue.amount === undefined ? '?' : cue.amount}`;
    case 'damage':
      return `damage: ${cue.target || cue.actor || '?'}-${cue.amount === undefined ? '?' : cue.amount}`;
    case 'sfx':
      return `sfx: ${cue.sound || '?'}`;
    default:
      return cmd;
  }
}

/** 模擬事件 → 依回合同群組（turnStart/turnEnd 邊界）。 */
export function groupSimEvents(sim) {
  const events = sim && Array.isArray(sim.events) ? sim.events : [];
  const groups = [];
  let current = null;
  for (const event of events) {
    if (!event || typeof event.type !== 'string') continue;
    const turn = event.payload && typeof event.payload.turn === 'number' ? event.payload.turn : event.turn;
    if (event.type === 'turnStart') {
      current = {
        turn: typeof turn === 'number' ? turn : groups.length,
        startFrame: event.frame,
        endFrame: null,
        says: [],
        attacks: [],
        forms: [],
        other: [],
      };
      groups.push(current);
      continue;
    }
    if (!current) continue;
    if (event.type === 'turnEnd') {
      current.endFrame = event.frame;
      continue;
    }
    const payload = event.payload || {};
    if (event.type === 'say' || event.type === 'bubble') {
      current.says.push({
        kind: event.type,
        frame: event.frame,
        speaker: payload.speaker || payload.actor || '',
        text: textOf(payload.text),
      });
    } else if (event.type === 'attackStart') {
      current.attacks.push({
        // 引擎的 attackStart payload 是 { ref, duration }；ref 是檔名字串或內嵌攻擊物件
        name:
          (typeof payload.ref === 'string' && payload.ref) ||
          (payload.ref && typeof payload.ref === 'object' && typeof payload.ref.name === 'string' && payload.ref.name) ||
          payload.name ||
          (typeof payload.attack === 'string' ? payload.attack : '') ||
          payload.id ||
          '',
        startFrame: event.frame,
        endFrame: null,
      });
    } else if (event.type === 'attackEnd') {
      const open = current.attacks.find((a) => a.endFrame === null);
      if (open) open.endFrame = event.frame;
    } else if (event.type === 'form') {
      current.forms.push({ actor: payload.actor, form: payload.form, frame: event.frame });
    } else {
      current.other.push({ type: event.type, frame: event.frame });
    }
  }
  // 結局可能從行動結算直接進入，不會再送出 turnEnd。
  if (current && sim.finished) current.endFrame = sim.frames;
  return groups;
}

/** 建立時間軸列資料（模擬 + 估算合併）。 */
export function buildTimelineRows(input = {}) {
  const doc = input.doc && typeof input.doc === 'object' ? input.doc : {};
  const turns = Array.isArray(doc.turns) ? doc.turns : [];
  const fps = Number(input.fps) > 0 ? Number(input.fps) : TIMELINE_FPS;
  const attacks = input.attacks || new Map();
  const sim = input.sim || null;
  const groups = groupSimEvents(sim);
  const warnings = [];
  if (sim && sim.pilotError) warnings.push({ kind: 'pilot', text: sim.pilotError });
  if (sim && Array.isArray(sim.loadErrors) && sim.loadErrors.length) {
    for (const err of sim.loadErrors.slice(0, 3)) warnings.push({ kind: 'load', text: `${err.path || ''}: ${err.message || ''}` });
  }
  // 引擎在模擬中發出的 error 事件（例如找不到 attack cue 的攻擊檔）——以前被吞掉（REALTEST-2 V2）
  if (sim && Array.isArray(sim.errors) && sim.errors.length) {
    const seen = new Set();
    for (const err of sim.errors) {
      const text = err && typeof err === 'object' ? String(err.message || err.path || '') : String(err || '');
      if (!text || seen.has(text)) continue;
      seen.add(text);
      warnings.push({ kind: 'engine', text });
    }
  }

  const rows = turns.map((turn, index) => {
    const group =
      groups.find((g) => g.turn === index && g.startFrame !== null) ||
      (groups[index] && groups[index].turn === undefined ? groups[index] : null) ||
      null;
    const name = attackNameOf(turn);
    const attackDoc = attackDocOf(attacks, name);
    const cueChips = collectTurnCueChips(turn);
    let row;
    if (group && typeof group.startFrame === 'number') {
      row = simulatedRow({ group, turn, index, fps, name, attackDoc, attacks, cueChips, totalTurns: turns.length });
    } else {
      row = estimatedRow({ turn, index, fps, name, attackDoc, cueChips });
    }
    row.id = turn && turn.id !== undefined ? turn.id : `t${index + 1}`;
    row.turn = index + 1;
    // 回合內用 attack cue 播的攻擊（turn.attack 為 null）也算這一列的攻擊
    const segNames = (row.segments || []).filter((seg) => seg.kind === 'attack' && seg.attackName).map((seg) => seg.attackName);
    row.attackNames = [...new Set(name ? [name, ...segNames] : segNames)];
    row.attackName = name || row.attackNames[0] || null;
    row.missingAttack = Boolean(name) && !attackDoc;
    if (row.missingAttack) warnings.push({ kind: 'attack', text: name, turn: index + 1 });
    return row;
  });

  // 若模擬有回合但 doc 的回合數更多，標記模擬不足
  if (sim && groups.length > 0 && rows.some((r) => !r.simulated)) {
    warnings.push({ kind: 'partial', text: `${groups.length}/${turns.length}` });
  }

  const totals = {
    frames: rows.reduce((sum, row) => sum + (Number(row.frames) || 0), 0),
    ms: rows.reduce((sum, row) => sum + (Number(row.durationMs) || 0), 0),
    turns: rows.length,
  };
  return {
    rows,
    totals,
    warnings,
    simulated: Boolean(sim && groups.length > 0 && !sim.pilotError),
    simResult: sim && sim.result ? sim.result : null,
    // 整場模擬的幀數（含回合外的開場／收尾，與 dr_simulate 對齊）；totals.frames 只是各回合相加
    simFrames: sim && Number(sim.frames) > 0 ? Number(sim.frames) : null,
  };
}

/** 由模擬群組建立一列（實際時間）。 */
function simulatedRow({ group, turn, index, fps, name, attackDoc, attacks, cueChips, totalTurns }) {
  void turn;
  void totalTurns;
  const startFrame = group.startFrame;
  const endFrame = typeof group.endFrame === 'number' ? group.endFrame : startFrame;
  const durationMs = Math.max(1, ((endFrame - startFrame) / fps) * 1000);
  const toMs = (frame) => ((frame - startFrame) / fps) * 1000;

  // 攻擊區間（配對 attackStart / attackEnd）
  const attackSegs = [];
  for (const atk of group.attacks) {
    const startMs = Math.max(0, toMs(atk.startFrame));
    const endMs = typeof atk.endFrame === 'number' ? Math.max(startMs + 100, toMs(atk.endFrame)) : durationMs;
    // 以事件裡的實際攻擊名為準（attack cue 的攻擊與 turn.attack 可以不同）
    const attackName = atk.name || name || '';
    const doc = attackDocOf(attacks, attackName) || (attackName === name ? attackDoc : null) || null;
    const beatsInfo = computeBeats(doc, endMs - startMs);
    attackSegs.push({
      kind: 'attack',
      label: attackName,
      attackName,
      startMs,
      endMs: Math.min(durationMs, endMs),
      beats: beatsInfo ? beatsInfo.beats.map((b) => ({ ...b, ms: startMs + b.ms })) : null,
      bpm: beatsInfo ? beatsInfo.bpm : null,
      beatMs: beatsInfo ? beatsInfo.beatMs : null,
    });
  }

  // 台詞區間：從 say 事件到下一個標記（下一個 say / 攻擊開始 / 回合結束）
  const markers = [];
  for (const say of group.says) {
    markers.push({ kind: 'say', frame: say.frame, speaker: say.speaker, text: say.text });
  }
  for (const atk of attackSegs) markers.push({ kind: 'attack-start', ms: atk.startMs });
  const saySegs = [];
  const says = group.says.slice();
  for (let i = 0; i < says.length; i += 1) {
    const startMs = Math.max(0, toMs(says[i].frame));
    const nextSay = says[i + 1] ? toMs(says[i + 1].frame) : null;
    const nextAttack = attackSegs.find((a) => a.startMs > startMs);
    const candidate = [nextSay, nextAttack ? nextAttack.startMs : null, durationMs].filter((v) => typeof v === 'number' && v > startMs);
    const endMs = candidate.length ? Math.min(...candidate) : durationMs;
    saySegs.push({
      kind: 'say',
      label: says[i].speaker || '',
      speaker: says[i].speaker || '',
      chars: says[i].text ? says[i].text.length : 0,
      startMs,
      endMs: Math.max(startMs + 80, endMs),
    });
  }
  void markers;

  const segments = orderSegments([...saySegs, ...attackSegs], durationMs);
  // 模擬有看到攻擊事件但沒有文件 → 拍線未知
  const bpmInfo = attackSegs.find((a) => a.bpm);
  return {
    simulated: true,
    startFrame,
    endFrame,
    frames: Math.max(0, endFrame - startFrame),
    durationMs,
    segments,
    cueChips,
    forms: group.forms.slice(),
    bpm: bpmInfo ? bpmInfo.bpm : null,
    beatMs: bpmInfo ? bpmInfo.beatMs : null,
    sample: group.says.length
      ? group.says.map((s) => s.text).filter(Boolean).slice(0, 2)
      : [],
    notes: group.attacks.length ? [] : name ? [{ kind: 'noAttackMarker', text: name }] : [],
  };
}

/** 估算列（模擬不可用時）。 */
function estimatedRow({ turn, index, fps, name, attackDoc, cueChips }) {
  void index;
  const typingMs = estimateTypingMs(turn, { fps });
  const beatsInfo = attackDoc ? computeBeats(attackDoc, attackDurationMs(new Map([[name, attackDoc]]), name)) : null;
  const attackMs = name ? attackDurationMs(new Map([[name, attackDoc]]), name) : 0;
  const segments = [];
  let cursor = 0;
  const sayTexts = turnTalkTexts(turn);
  if (sayTexts.length || typingMs > 0) {
    segments.push({
      kind: 'say',
      label: '',
      speaker: '',
      chars: sayTexts.join('').length,
      startMs: 0,
      endMs: typingMs,
    });
    cursor = typingMs;
  }
  if (name) {
    segments.push({
      kind: 'attack',
      label: name,
      attackName: name,
      startMs: cursor,
      endMs: cursor + attackMs,
      beats: beatsInfo ? beatsInfo.beats.map((b) => ({ ...b, ms: cursor + b.ms })) : null,
      bpm: beatsInfo ? beatsInfo.bpm : null,
      beatMs: beatsInfo ? beatsInfo.beatMs : null,
    });
    cursor += attackMs;
  }
  const durationMs = Math.max(400, cursor);
  return {
    simulated: false,
    startFrame: null,
    endFrame: null,
    frames: Math.round((durationMs / 1000) * fps),
    durationMs,
    segments: orderSegments(segments, durationMs),
    cueChips,
    forms: [],
    bpm: beatsInfo ? beatsInfo.bpm : null,
    beatMs: beatsInfo ? beatsInfo.beatMs : null,
    sample: sayTexts.slice(0, 2),
    notes: [],
  };
}

/** 排序並避免重疊（重疊時把後面的起點推到前一段結束）。 */
export function orderSegments(segments, durationMs) {
  const list = (segments || []).slice().sort((a, b) => a.startMs - b.startMs || (a.kind === 'say' ? -1 : 1));
  let cursor = 0;
  const out = [];
  for (const seg of list) {
    const startMs = Math.max(seg.startMs, cursor);
    const endMs = Math.max(startMs + 60, Math.min(seg.endMs, durationMs || seg.endMs));
    const beats = seg.beats
      ? seg.beats.filter((b) => b.ms >= startMs && b.ms <= endMs).map((b) => ({ ...b, ms: b.ms }))
      : null;
    out.push({ ...seg, startMs, endMs, beats });
    cursor = endMs;
  }
  return out;
}

/** 毫秒 → 秒字串。 */
export function formatSeconds(ms, digits = 1) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '0.0s';
  return `${(n / 1000).toFixed(digits)}s`;
}

/** 跑一次 headless 模擬，取得實際事件時間。 */
export async function simulateTimeline(doc, opts = {}) {
  const fps = Number(opts.fps) > 0 ? Number(opts.fps) : TIMELINE_FPS;
  const maxFrames = Number(opts.maxFrames) > 0 ? Number(opts.maxFrames) : fps * 600;
  const mode = opts.mode === 'bot' ? 'bot' : 'demo';
  const resolveAttack = typeof opts.resolveAttack === 'function' ? opts.resolveAttack : async () => null;
  const warnings = [];
  const attacks = new Map();

  // 先抓齊所有回合會用到的攻擊檔（模擬與估算都要用）
  // （含回合內 attack cue 的攻擊——只掃 turn.attack 會讓引擎找不到攻擊檔，REALTEST-2 V2）
  await Promise.all([...collectTimelineAttackNames(doc)].map(async (name) => {
    try {
      attacks.set(name, await resolveAttack(name));
    } catch (err) {
      warnings.push({ kind: 'resolve', text: `${name}: ${err.message || err}` });
      attacks.set(name, null);
    }
  }));

  const simulate = opts.runInWorker || runTimelineSimulation;
  const sim = await simulate(doc, { attacks, mode, maxFrames, spriteFrames: opts.spriteFrames });
  return { sim, attacks, warnings, mode, fps, maxFrames };
}

export async function runTimelineSimulation(doc, { attacks, mode, maxFrames, spriteFrames }) {
  try {
    const [{ createEncounter }, autoplayMod] = await Promise.all([
      import(new URL('../../engine/encounter/index.js', import.meta.url).href),
      import(new URL('../../engine/autoplay/index.js', import.meta.url).href),
    ]);
    const enc = createEncounter({
      canvas: null,
      assets: null,
      spriteFrames: spriteFrames && ((name) => spriteFrames.get(name) || 0),
      resolveAttack: (name) => attacks.get(name) || null,
    });
    const events = [];
    const loadErrors = [];
    const loadResult = await enc.load(doc);
    if (loadResult && Array.isArray(loadResult.errors)) loadErrors.push(...loadResult.errors);
    const stamp = (type) => (payload) => {
      const p = payload && typeof payload === 'object' ? payload : {};
      events.push({
        type,
        frame: enc.frame,
        turn: typeof p.turn === 'number' ? p.turn : enc.turn,
        payload: p,
      });
    };
    const WATCH = [
      'turnStart',
      'turnEnd',
      'say',
      'bubble',
      'attackStart',
      'attackEnd',
      'form',
      'bgm',
      'act',
      'actDone',
      'actions',
      'mercy',
      'spare',
      'magic',
      'item',
      'defend',
      'enemyRemoved',
    ];
    for (const type of WATCH) enc.on(type, stamp(type));
    const errors = [];
    enc.on('error', (payload) => errors.push(payload));

    let pilot = null;
    let pilotError = '';
    let describe = '';
    try {
      pilot = autoplayMod.createAutopilot({
        kind: 'encounter',
        doc,
        mode,
        resolveAttackDoc: (name) => attacks.get(name) || null,
      });
      await pilot.ready;
      describe = typeof pilot.describe === 'function' ? pilot.describe() : '';
    } catch (err) {
      pilotError = err && err.message ? err.message : String(err);
    }

    for (let i = 0; i < maxFrames && !enc.result && !pilotError; i += 1) {
      try {
        enc.step(1, pilot.input(enc.getState(), enc.frame));
      } catch (err) {
        pilotError = err.message || String(err);
      }
    }
    const sim = {
      events,
      errors,
      loadErrors,
      pilotError,
      pilotDescribe: describe,
      result: enc.result,
      frames: enc.frame,
      finished: Boolean(enc.result),
    };
    enc.destroy();
    return sim;
  } catch (err) {
    return { events: [], errors: [], loadErrors: [], pilotError: err.message || String(err), result: null, frames: 0 };
  }
}

function simulateOffThread(doc, options, signal) {
  signal.throwIfAborted();
  const worker = new Worker(new URL('./timeline-worker.js', import.meta.url), { type: 'module' });
  return new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    worker.onmessage = ({ data }) => resolve(data);
    worker.onerror = (event) => reject(new Error(event.message));
    worker.postMessage({ doc, options });
  }).finally(() => worker.terminate());
}

function actorSpriteFrames(doc, assets) {
  if (!assets) return undefined;
  const frames = new Map();
  const add = (anims) => {
    for (const anim of Object.values(anims || {})) {
      const name = anim?.sprite;
      if (!name || frames.has(name)) continue;
      const entry = assets.sprite(name);
      if (entry) frames.set(name, entry.frames?.length || 1);
    }
  };
  for (const actor of Object.values(doc.actors || {})) {
    add(actor?.anims);
    for (const form of Object.values(actor?.forms || {})) add(form?.anims);
  }
  return frames;
}

/* =========================================================================
 * 2. 掛載層（時間軸分頁）
 * ========================================================================= */

/** 取面板容器內的子元素（容忍未掛載）。 */
function pick(root, selector) {
  if (!root || typeof root.querySelector !== 'function') return null;
  return root.querySelector(selector);
}

/**
 * 在「指令清單／演示」分頁列加上第三個分頁「時間軸」。
 * 需在 demo-panel 掛載後呼叫（共用 .panel-tabs.encdemo-tabs）。
 *
 * @param {{panelEl: HTMLElement, ctx: object}} opts
 */
export function mountTimelineTab({ panelEl, ctx } = {}) {
  if (!panelEl) return { destroy() {} };
  const tabs = pick(panelEl, '.panel-tabs.encdemo-tabs');
  const cuesBody = pick(panelEl, '#enc-cues-body');
  const demoBody = pick(panelEl, '#enc-demo-body');
  const cuePathEl = pick(panelEl, '#enc-cue-path');
  if (!tabs || !cuesBody) return { destroy() {} };

  const tab = el('button', { class: 'panel-tab', text: T('tab') });
  tab.type = 'button';
  tab.id = 'enc-tab-timeline';
  tabs.appendChild(tab);

  const body = el('div', { class: 'panel-body enctl-body', id: 'enc-timeline-body' });
  body.hidden = true;
  panelEl.appendChild(body);

  const root = el('div', { class: 'enctl-root' });
  body.appendChild(root);

  const toolbar = el('div', { class: 'enctl-toolbar' });
  const modeSel = selectEl(
    [
      { value: 'demo', label: T('modeDemo') },
      { value: 'bot', label: T('modeBot') },
    ],
    'demo',
    () => {
      if (!active) return;
      run();
    },
  );
  modeSel.title = T('modeHint');
  const refreshBtn = button(T('refresh'), { small: true, variant: 'primary', onClick: () => run() });
  const status = el('span', { class: 'enctl-status', text: '' });
  toolbar.appendChild(el('span', { class: 'enctl-legend-label', text: T('mode') }));
  toolbar.appendChild(modeSel);
  toolbar.appendChild(refreshBtn);
  toolbar.appendChild(status);
  root.appendChild(toolbar);

  const legend = el('div', { class: 'enctl-legend' });
  const legendParts = [
    ['say', T('legendSay')],
    ['attack', T('legendAttack')],
    ['cue', T('legendCue')],
  ];
  for (const [kind, label] of legendParts) {
    const item = el('span', {});
    item.appendChild(el('span', { class: `enctl-swatch ${kind}` }));
    item.appendChild(el('span', { text: label }));
    legend.appendChild(item);
  }
  const bpmLabel = el('span', { class: 'enctl-bpmlabel', text: '' });
  legend.appendChild(bpmLabel);
  root.appendChild(legend);

  const scroll = el('div', { class: 'enctl-scroll' });
  const listEl = el('div', { class: 'enctl-list' });
  const warningsEl = el('div', { class: 'enctl-totals enctl-warnings' });
  const totalsEl = el('div', { class: 'enctl-totals', text: '' });
  scroll.appendChild(listEl);
  scroll.appendChild(warningsEl);
  scroll.appendChild(totalsEl);
  root.appendChild(scroll);
  // 「還有內容可捲」提示（REALTEST-2 V9）：內容超出可視高度且還沒捲到底時顯示
  const scrollHint = el('div', { class: 'enctl-scrollhint', text: T('scrollHint') });
  scrollHint.hidden = true;
  root.appendChild(scrollHint);
  function updateScrollHint() {
    const more = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop > 4;
    scrollHint.hidden = !more;
  }
  scroll.addEventListener('scroll', updateScrollHint, { passive: true });
  const rootEl = typeof document !== 'undefined' ? document.documentElement : null;

  let active = false;
  let loading = false;
  let data = null;
  let lastDoc = null;
  let simulation = null;
  let stale = false;
  let runToken = 0;
  let jumpTurn = 0;
  let unsub = null;
  let unsubLocale = null;

  function setStatus(text, isError) {
    status.textContent = text || '';
    status.classList.toggle('is-error', Boolean(isError));
  }

  function paintTabs() {
    for (const other of tabs.querySelectorAll('.panel-tab')) {
      if (other !== tab) other.classList.remove('is-active');
    }
    tab.classList.toggle('is-active', active);
    if (active && cuePathEl) {
      const totals = data && data.totals ? data.totals : null;
      const parts = [`${T('tab')} · ${T('turnsShort', { n: totals ? totals.turns : (ctx.store && Array.isArray(ctx.store.doc && ctx.store.doc.turns) ? ctx.store.doc.turns.length : 0) })}`];
      if (totals) parts.push(formatSeconds(totals.ms));
      if (data && data.simulated) parts.push(T('badgeSim'));
      cuePathEl.textContent = parts.join(' · ');
    }
  }

  function hide() {
    active = false;
    panelEl.classList.remove('is-timeline');
    if (rootEl) rootEl.classList.remove('enctl-open');
    body.hidden = true;
    const cueTab = pick(tabs, '.panel-tab:not(#enc-tab-timeline)');
    void cueTab;
  }

  function show() {
    active = true;
    panelEl.classList.add('is-timeline');
    // 時間軸開著時下方面板至少約 3.5 列高（layout.css 的 :root.enctl-open）
    if (rootEl) rootEl.classList.add('enctl-open');
    body.hidden = false;
    updateScrollHint();
    for (const other of tabs.querySelectorAll('.panel-tab')) {
      if (other !== tab) other.classList.remove('is-active');
    }
    paintTabs();
    if (!data && !loading) run();
    else if (stale) setStatus(T('stale'), false);
  }

  tab.addEventListener('click', () => {
    show();
  });
  const otherTabs = [...tabs.querySelectorAll('.panel-tab')].filter((node) => node !== tab);
  const onOtherTab = () => hide();
  for (const node of otherTabs) node.addEventListener('click', onOtherTab);

  function resolveDoc() {
    if (ctx && ctx.store && ctx.store.doc) return ctx.store.doc;
    if (ctx && typeof ctx.getDoc === 'function') return ctx.getDoc();
    return null;
  }

  async function run() {
    const doc = resolveDoc();
    if (!doc) {
      setStatus(T('noDoc'), true);
      return;
    }
    const token = (runToken += 1);
    simulation?.abort();
    simulation = new AbortController();
    const { signal } = simulation;
    loading = true;
    stale = false;
    lastDoc = doc;
    refreshBtn.disabled = true;
    setStatus(T('loading'), false);
    listEl.textContent = '';
    listEl.appendChild(el('div', { class: 'enctl-empty', text: T('loading') }));
    const mode = modeSel.value === 'bot' ? 'bot' : 'demo';
    const api = (ctx && ctx.api) || {};
    const resolveAttack =
      typeof api.resolveAttackRef === 'function'
        ? api.resolveAttackRef
        : async (name) => {
            const preview = await import(new URL('./preview.js', import.meta.url).href);
            return preview.resolveAttackRef(name);
          };
    let result = null;
    try {
      const simOut = await simulateTimeline(doc, {
        resolveAttack,
        mode,
        spriteFrames: actorSpriteFrames(doc, ctx.assets),
        runInWorker: (input, options) => simulateOffThread(input, options, signal),
      });
      if (token !== runToken || destroyed) return;
      result = buildTimelineRows({ doc, sim: simOut.sim, attacks: simOut.attacks });
      result.warnings = [...(simOut.warnings || []), ...(result.warnings || [])];
    } catch (err) {
      if (token !== runToken || destroyed) return;
      result = buildTimelineRows({ doc, sim: null, attacks: new Map() });
      result.simulated = false;
      result.warnings = [{ kind: 'sim', text: err && err.message ? err.message : String(err) }];
    }
    if (token !== runToken || destroyed) return;
    loading = false;
    simulation = null;
    refreshBtn.disabled = false;
    data = result;
    renderRows();
  }

  function renderRows() {
    clear(listEl);
    const rows = data && Array.isArray(data.rows) ? data.rows : [];
    if (!rows.length) {
      listEl.appendChild(el('div', { class: 'enctl-empty', text: T('empty') }));
      totalsEl.textContent = '';
      setStatus(T('noTurns'), false);
      paintTabs();
      return;
    }
    const maxMs = Math.max(...rows.map((row) => row.durationMs || 1));
    for (const row of rows) {
      listEl.appendChild(renderRow(row, maxMs));
    }
    const warnings = data.warnings || [];
    warningsEl.textContent = '';
    if (warnings.length) {
      const texts = [];
      for (const warning of warnings.slice(0, 3)) {
        if (warning.kind === 'pilot') texts.push(T('warnPilot', { reason: warning.text }));
        else if (warning.kind === 'attack') texts.push(T('warnAttack', { name: warning.text, turn: warning.turn }));
        else if (warning.kind === 'partial') texts.push(T('warnPartial', { have: warning.text.split('/')[0], want: warning.text.split('/')[1] }));
        else if (warning.kind === 'load') texts.push(T('warnLoad', { reason: warning.text }));
        else if (warning.kind === 'engine') texts.push(T('warnEngine', { reason: warning.text }));
        else texts.push(warning.text);
      }
      warningsEl.textContent = texts.join(' · ');
    }
    totalsEl.textContent = T('totals', {
      turns: data.totals.turns,
      frames: data.totals.frames,
      time: formatSeconds(data.totals.ms),
    });
    const simulated = Boolean(data.simulated);
    const frames = data.simFrames || data.totals.frames;
    const result = data.simResult;
    let message = T('statusEst', { turns: data.totals.turns });
    if (simulated) message = result ? T('statusSim', { frames, result }) : T('statusIncomplete', { frames });
    setStatus(stale ? T('stale') : message, false);
    paintTabs();
    updateScrollHint();
  }

  function renderRow(row, maxMs) {
    const rowEl = el('div', { class: 'enctl-row' + (row.turn === jumpTurn ? ' is-active' : '') });
    rowEl.tabIndex = 0;
    rowEl.setAttribute('role', 'button');
    rowEl.title = T('jumpHint', { turn: row.turn });
    rowEl.addEventListener('click', () => jumpTo(row));
    rowEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        jumpTo(row);
      }
    });
    const label = el('div', { class: 'enctl-label' });
    label.appendChild(el('b', { text: `T${row.turn}` }));
    label.appendChild(el('span', { text: ` ${formatSeconds(row.durationMs)}` }));
    if (!row.simulated) label.appendChild(el('span', { class: 'warn', text: ' est' }));
    rowEl.appendChild(label);

    const main = el('div', { class: 'enctl-rowmain' });
    const track = el('div', { class: 'enctl-track' });
    const denom = Math.max(row.durationMs || 1, maxMs ? maxMs * 0.6 : 1);
    for (const segment of row.segments || []) {
      const pct = Math.max(0.4, ((segment.endMs - segment.startMs) / denom) * 100);
      const segEl = el('div', { class: `enctl-seg ${segment.kind === 'attack' ? 'attack' : 'say'}` });
      segEl.style.width = `${pct}%`;
      const labelText = segment.kind === 'attack' ? segment.label || T('attack') : segment.speaker || T('say');
      segEl.textContent = pct >= 9 ? labelText : '';
      segEl.title =
        segment.kind === 'attack'
          ? `${segment.label || T('attack')} · ${formatSeconds(segment.endMs - segment.startMs)}${segment.bpm ? ` · ${T('bpm', { bpm: segment.bpm })}` : ''}`
          : `${T('say')}${segment.speaker ? `: ${segment.speaker}` : ''} · ${formatSeconds(segment.endMs - segment.startMs)}`;
      // 拍線（攻擊段內）
      for (const beat of segment.beats || []) {
        const rel = (beat.ms - segment.startMs) / Math.max(1, segment.endMs - segment.startMs);
        if (rel < 0 || rel > 1) continue;
        const tick = el('div', { class: `enctl-beat${beat.bar ? ' is-bar' : ''}` });
        tick.style.left = `${rel * 100}%`;
        segEl.appendChild(tick);
      }
      track.appendChild(segEl);
    }
    if (!(row.segments || []).length) {
      track.appendChild(el('div', { class: 'enctl-seg empty', text: '' }));
    }
    main.appendChild(track);

    const chips = el('div', { class: 'enctl-chips' });
    const cueChips = (row.cueChips || []).slice(0, 12);
    for (const chip of cueChips) {
      chips.appendChild(el('span', { class: `enctl-chip ${chip.kind || 'other'}`, text: chip.label }));
    }
    if (!cueChips.length) {
      chips.appendChild(el('span', { class: 'enctl-chip other', text: T('noCues') }));
    }
    main.appendChild(chips);

    const meta = el('div', { class: 'enctl-meta' });
    if (row.attackName) meta.appendChild(el('span', { text: `${T('attack')}: ${row.attackName}` }));
    if (row.bpm) meta.appendChild(el('span', { text: T('bpm', { bpm: row.bpm }) }));
    if (row.missingAttack) meta.appendChild(el('span', { class: 'warn', text: T('missingAttack') }));
    if (row.sample && row.sample.length) {
      const sample = row.sample.join(' / ');
      meta.appendChild(el('span', { text: sample.length > 40 ? `${sample.slice(0, 39)}…` : sample }));
    }
    main.appendChild(meta);
    rowEl.appendChild(main);
    return rowEl;
  }

  function jumpTo(row) {
    jumpTurn = row.turn;
    for (const node of listEl.querySelectorAll('.enctl-row')) node.classList.remove('is-active');
    // 重新 paint 以標記目前回合（低成本：只重畫列表）
    renderRows();
    if (ctx && ctx.preview && typeof ctx.preview.jumpToTurn === 'function') {
      ctx.preview.jumpToTurn(row.turn);
    }
    try {
      if (ctx && ctx.store && typeof ctx.store.select === 'function' && row.id !== undefined) {
        ctx.store.select(KIND.turn, row.id);
      }
    } catch (_err) {
      /* 選取失敗不影響跳轉 */
    }
    if (ctx && typeof ctx.toast === 'function') ctx.toast(T('jumped', { turn: row.turn }));
  }

  function markStale() {
    if (!lastDoc) return;
    stale = true;
    if (active && !loading) setStatus(T('stale'), false);
  }

  // Store 更新會替換文件物件；選取、狀態和驗證通知不會。
  if (ctx && ctx.store && typeof ctx.store.subscribe === 'function') {
    unsub = ctx.store.subscribe(() => {
      if (resolveDoc() !== lastDoc) markStale();
    });
  }
  const unsubAttacks = ctx.preview?.onAttackChange?.(markStale);
  unsubLocale = onLocaleChange(() => {
    if (!active) return;
    // 重建整個分頁內容（字串）
    if (data) renderRows();
    paintTabs();
  });

  let destroyed = false;
  const api = {
    tab,
    body,
    isActive: () => active,
    show,
    refresh: () => run(),
    getData: () => data,
    setMode(mode) {
      modeSel.value = mode === 'bot' ? 'bot' : 'demo';
    },
    destroy() {
      destroyed = true;
      active = false;
      simulation?.abort();
      unsubAttacks?.();
      if (typeof unsub === 'function') unsub();
      if (typeof unsubLocale === 'function') unsubLocale();
      for (const node of otherTabs) node.removeEventListener('click', onOtherTab);
      tab.remove();
      body.remove();
      panelEl.classList.remove('is-timeline');
      if (rootEl) rootEl.classList.remove('enctl-open');
    },
  };
  return api;
}
