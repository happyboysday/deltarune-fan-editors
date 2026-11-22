/**
 * tools/agent/sim.mjs — 無頭模擬器（SPEC-AGENT §3）。
 *
 * 為什麼要有這支：
 *   Agent 改完作品後不能只「看起來像對的」——要能證明它在引擎裡跑得起來、會造成
 *   多少傷害、有沒有卡死。這裡完全用引擎的公開 API（createBattle / createEncounter）
 *   在 Node 裡跑，不需要瀏覽器、不需要 canvas、不需要音訊。
 *
 * 兩種輸入：
 *   攻擊檔（dr-battle-attack/1）   → engine/index.js createBattle
 *   遭遇檔（dr-battle-encounter/1）→ engine/encounter/index.js createEncounter
 *                                    （回合的 attack 參照會自動從 samples/、attacks/ 解析）
 *
 * 四種玩家（新→舊）：
 *   --autoplay demo|bot      用 engine/autoplay 的 createAutopilot（SPEC-AUTOPLAY §2/§3）。
 *                            攻擊：讀作品 demo.path / demo.inputs 或全程 AI。
 *                            遭遇：讀遭遇 demo（選單/文字/FIGHT/躲避），bot = 全 AI。
 *                            --autoplay 不帶值 = bot；沒有 --bot/--inputs 時預設就是 --autoplay bot。
 *   --bot idle|random|dodge  舊參數，保留相容（不再是預設）。
 *   --inputs script.json     輸入腳本：[{ "frame": 0, "press": ["confirm"], "hold": {"right": true} }]
 *                            攻擊用的方向輸入：[{ "frame": 0, "dx": 1, "dy": 0, "slow": false }]
 *                            --inputs 優先於 --autoplay / --bot。
 *
 * 用法：
 *   node tools/agent/sim.mjs samples/spade-rain.json --autoplay demo --json
 *   node tools/agent/sim.mjs samples/encounters/rudinn.json --autoplay demo --frames 1800 --json
 *   node tools/agent/sim.mjs samples/spade-rain.json --bot dodge --json
 *   node tools/agent/sim.mjs attacks/my-attack.json --inputs script.json
 *
 * 輸出（--json）：
 *   { kind, file, frames, ended, result, damageTaken, hits, grazes, tpGained,
 *     maxBullets, avgBullets, errors[], events[], perTurn[], sfx[],
 *     autoplay: { mode, warnings[], describe } }
 */

import { existsSync } from 'node:fs';

import {
  ATTACKS_DIR,
  BATTLE_EDITOR,
  ENCOUNTERS_DIR,
  SAMPLES_DIR,
  applyCliPaths,
  cliEntry,
  isFile,
  mean,
  numArg,
  parseArgs,
  readJSON,
  resolveInputFile,
  round,
} from './lib.mjs';
import { createBot, createBotFromArgs } from './bot.mjs';
import { createAutopilot } from '../../engine/autoplay/index.js';
import { normalizeFrameInput } from '../../engine/input.js';

const ENCOUNTER_FORMAT = 'dr-battle-encounter/1';
const ATTACK_FORMAT = 'dr-battle-attack/1';
/** 事件清單最多保留幾筆（避免 --json 爆量）。 */
const MAX_EVENTS = 2000;
/** 遭遇戰預設最多跑幾幀（約 2 分鐘遊戲時間），避免無限循環。 */
const DEFAULT_ENCOUNTER_FRAMES = 3600;
/** 每幾幀記錄一次時間序列（difficulty 的曲線用）。 */
const TRACE_EVERY = 30;
/** 自動演示模式（對應 SPEC-AUTOPLAY §2）。 */
const AUTOPLAY_MODES = ['demo', 'bot'];
/**
 * 遭遇層的事件種類（--json 的 events[] 會帶 type 標記）。
 * 這些都是 engine/encounter 只加「發射」而來的觀察事件，不影響任何行為。
 */
const ENCOUNTER_EVENT_TYPES = [
  'turnStart',
  'turnEnd',
  'actions',
  'act',
  'actDone',
  'defend',
  'spare',
  'magic',
  'item',
  'mercy',
  'tp',
  'hp',
  'hurt',
  'say',
  'bubble',
  'attackStart',
  'attackEnd',
  'enemyRemoved',
  'end',
];

/* ------------------------------------------------------------ 檔案解析 */

/** 檔名 → 攻擊 JSON（遭遇的 attack 參照用）。 */
export function makeAttackResolver() {
  return async function resolveAttack(name) {
    if (typeof name !== 'string' || !name) return null;
    const candidates = [
      `${name}.json`,
      name,
    ].map((file) => file);
    const bases = [ATTACKS_DIR, SAMPLES_DIR, `${SAMPLES_DIR}/attacks`, BATTLE_EDITOR];
    for (const base of bases) {
      for (const file of candidates) {
        const full = `${base}/${file}`;
        if (isFile(full)) {
          try {
            return readJSON(full);
          } catch (_err) {
            return null;
          }
        }
      }
    }
    // 直接內嵌物件的情形
    return null;
  };
}

/**
 * 遭遇用的同步攻擊解析器：先 async 預載每回合 attack 參照，之後 createAutopilot 的
 * resolveAttackDoc 就是純查表（SPEC §3 要求同步回傳）。
 */
export async function buildSyncAttackResolver(encounterJson) {
  const resolveAttack = makeAttackResolver();
  const cache = new Map();
  const refs = new Set();
  for (const turn of Array.isArray(encounterJson && encounterJson.turns) ? encounterJson.turns : []) {
    if (turn && typeof turn.attack === 'string' && turn.attack) refs.add(turn.attack);
  }
  for (const ref of refs) {
    const doc = await resolveAttack(ref);
    if (doc) {
      cache.set(ref, doc);
      cache.set(`${ref}.json`, doc);
    }
  }
  return function resolveAttackDoc(ref) {
    if (ref && typeof ref === 'object') return ref;
    if (typeof ref !== 'string' || !ref) return null;
    return cache.get(ref) || cache.get(`${ref}.json`) || null;
  };
}

/** 判斷載入的 JSON 是攻擊還是遭遇。 */
export function detectKind(json) {
  if (!json || typeof json !== 'object') return 'unknown';
  if (json.format === ENCOUNTER_FORMAT) return 'encounter';
  if (json.format === ATTACK_FORMAT) return 'attack';
  if (Array.isArray(json.turns) || Array.isArray(json.enemies)) return 'encounter';
  if (Array.isArray(json.timeline) || json.settings && json.bulletTypes) return 'attack';
  return 'attack';
}

/* ---------------------------------------------------------------- 輸入 */

/**
 * 輸入腳本 → 每幀輸入。
 * 支援兩種形狀：
 *   1) [{frame, dx, dy, slow}]                    直接給靈魂方向（攻擊）
 *   2) [{frame, press:[...], hold:{...}}]         按鍵式（遭遇）
 * 腳本中「未定義 frame」的項目視為 f=0。
 */
function buildScriptInputs(entries) {
  const byFrame = new Map();
  for (const entry of Array.isArray(entries) ? entries : []) {
    if (!entry || typeof entry !== 'object') continue;
    const frame = Math.max(0, Math.round(numArg(entry.frame, 0)));
    const list = byFrame.get(frame) || [];
    list.push(entry);
    byFrame.set(frame, list);
  }
  const sortedFrames = [...byFrame.keys()].sort((a, b) => a - b);
  return function inputAt(frame) {
    // 沿用「最後一個 <= frame 的指令」
    let active = null;
    for (const f of sortedFrames) {
      if (f > frame) break;
      active = byFrame.get(f);
    }
    if (!active) return null;
    const entry = active[active.length - 1];
    if (entry.dx !== undefined || entry.dy !== undefined || entry.slow !== undefined) {
      return {
        dx: Math.sign(numArg(entry.dx, 0)),
        dy: Math.sign(numArg(entry.dy, 0)),
        slow: Boolean(entry.slow),
      };
    }
    return { press: Array.isArray(entry.press) ? entry.press.slice() : [], hold: entry.hold || {} };
  };
}

/* ------------------------------------------------------------- 自動演示 */

/** 正規化 --autoplay 參數；undefined / null / false = 不啟用。 */
export function normalizeAutoplayMode(value) {
  if (value === undefined || value === null || value === false || value === '') return null;
  if (value === true) return 'bot';
  const mode = String(value).toLowerCase();
  if (!AUTOPLAY_MODES.includes(mode)) {
    throw new Error(`autoplay 必須是 ${AUTOPLAY_MODES.join(' 或 ')}（收到 ${JSON.stringify(value)}）`);
  }
  return mode;
}

/** 將 autopilot 的完整逐幀輸入傳給單跑攻擊。 */
export function pilotInputToSimulation(input) {
  return normalizeFrameInput(input);
}

/** 建立 autopilot；encounter 需要 await pilot.ready（動態載入 encounter.js）。 */
export async function createSimulationPilot(kind, doc, options, resolveAttackDoc) {
  const mode = normalizeAutoplayMode(options.autoplay);
  if (!mode) return null;
  const { seed, horizon, grazeBias, variation } = options;
  const pilot = createAutopilot({ kind, doc, mode, resolveAttackDoc, botOptions: { seed, horizon, grazeBias, variation } });
  if (pilot && pilot.ready && typeof pilot.ready.then === 'function') await pilot.ready;
  return pilot;
}

/** 輸出用的自動演示摘要（SPEC §3：mode / warnings / describe）。 */
export function autoplaySummary(options, pilot) {
  return {
    mode: (options && options.autoplay) || null,
    warnings: pilot && Array.isArray(pilot.warnings) ? pilot.warnings.slice() : [],
    describe: pilot && typeof pilot.describe === 'function' ? pilot.describe() : null,
  };
}

/* ----------------------------------------------------------- 統計容器 */

function createStats() {
  return {
    hits: 0,
    grazes: 0,
    damageTaken: 0,
    tpGained: 0,
    maxBullets: 0,
    bulletSamples: [],
    events: [],
    sfx: new Set(),
    trace: [],
  };
}

function pushEvent(stats, event) {
  if (stats.events.length < MAX_EVENTS) stats.events.push(event);
  else if (stats.events.length === MAX_EVENTS) stats.events.push({ note: '事件過多，之後省略' });
}

/* --------------------------------------------------------------- 攻擊 */

async function simulateAttack(attackJson, options) {
  const { createBattle } = await import('../../engine/index.js');
  const { validateAttack } = await import('../../engine/attack.js');

  const validationErrors = validateAttack(attackJson).map((e) => `${e.path || ''}: ${e.message}`);
  const battle = createBattle({ canvas: null, assets: null, mode: 'play' });
  const stats = createStats();
  const errors = validationErrors.slice();
  const bot = options.bot ? createBotFromArgs(options) : null;
  const scriptAt = options.inputs ? buildScriptInputs(options.inputs) : null;
  const pilot = !scriptAt ? await createSimulationPilot('attack', attackJson, options, null) : null;

  battle.on('error', (payload) => {
    errors.push(payload && payload.message ? payload.message : JSON.stringify(payload));
  });
  battle.on('hit', (payload) => {
    stats.hits += 1;
    const damage = numArg(payload && payload.damage, 0);
    stats.damageTaken += damage;
    pushEvent(stats, {
      frame: payload && payload.frame,
      type: 'hit',
      bullet: payload && payload.type,
      damage,
    });
  });
  battle.on('graze', (payload) => {
    stats.grazes += 1;
    pushEvent(stats, { frame: payload && payload.frame, type: 'graze', bullet: payload && payload.type });
  });
  battle.on('end', (payload) => {
    pushEvent(stats, { frame: payload && payload.frame, type: 'end' });
  });

  battle.load(attackJson);
  const sim = battle.engine;
  const initialState = battle.getState();
  const startTp = numArg(initialState.tp, 0);
  const startHp = (initialState.party || []).reduce((sum, p) => sum + numArg(p.hp, 0), 0);
  const maxFrames = options.frames || numArg(battle.durationFrames, 300);

  let frame = 0;
  let ended = false;
  for (; frame < maxFrames; frame += 1) {
    const state = battle.getState();
    const bullets = (state.bullets || []).filter((bullet) => !bullet.decor).length;
    if (bullets > stats.maxBullets) stats.maxBullets = bullets;
    stats.bulletSamples.push(bullets);
    if (frame % TRACE_EVERY === 0) {
      stats.trace.push({
        frame,
        time: round(frame / 30, 2),
        bullets,
        tp: round(numArg(state.tp, 0), 1),
        hits: stats.hits,
        grazes: stats.grazes,
        hp: (state.party || []).reduce((sum, p) => sum + numArg(p.hp, 0), 0),
      });
    }
    for (const name of state.sfxQueue || []) stats.sfx.add(name);
    // 清掉 sfx 佇列，避免逐幀累積
    if (typeof sim.drainSfx === 'function') sim.drainSfx();

    let input = null;
    if (scriptAt) input = scriptAt(frame);
    if (!input && pilot) input = pilotInputToSimulation(pilot.input(state, frame));
    if (!input && bot) input = bot.decide(state);
    if (!input && !scriptAt) input = { dx: 0, dy: 0, slow: false };

    const moved = sim.stepFrame(input);
    if (!moved) {
      ended = true;
      break;
    }
  }
  const finalState = battle.getState();
  const finalHp = (finalState.party || []).reduce((sum, p) => sum + numArg(p.hp, 0), 0);
  const frames = Number.isFinite(numArg(finalState.frame, NaN)) ? numArg(finalState.frame, frame) : frame;
  const tpGained = Math.max(0, numArg(finalState.tp, 0) - startTp);

  battle.destroy();

  return {
    kind: 'attack',
    name: (attackJson.meta && attackJson.meta.name) || null,
    frames,
    totalFrames: maxFrames,
    ended: Boolean(ended || finalState.ended),
    result: finalState.ended ? 'ended' : 'timeout',
    hits: stats.hits,
    grazes: stats.grazes,
    damageTaken: stats.damageTaken,
    hpLost: Math.max(0, startHp - finalHp),
    tpGained: round(tpGained, 2),
    peakTp: round(numArg(finalState.tp, 0), 1),
    maxBullets: stats.maxBullets,
    avgBullets: round(mean(stats.bulletSamples), 2),
    party: (finalState.party || []).map((p) => ({ name: p.name, hp: p.hp, maxHp: p.maxHp })),
    errors,
    events: stats.events,
    sfx: [...stats.sfx].sort(),
    perTurn: [
      {
        turn: 1,
        frames,
        hits: stats.hits,
        grazes: stats.grazes,
        damageTaken: Math.max(0, startHp - finalHp),
        maxBullets: stats.maxBullets,
      },
    ],
    autoplay: autoplaySummary(options, pilot),
    trace: stats.trace,
  };
}

/* --------------------------------------------------------------- 遭遇 */

/** 舊 --bot 的啟發式自動操作（僅在沒有 autopilot 的相容路徑使用）。 */
function encounterAutoInput(state, bot, frame, options) {
  const battleSnapshot = state.battle;
  if (battleSnapshot && Array.isArray(battleSnapshot.bullets)) {
    // 遭遇的 battle 快照現在與單獨攻擊 getState() 同形（含 attack.soul.speed / slowSpeed），
    // 直接交給 bot 即可；保留防禦性退回：舊快照 / 外部注入的快照缺 attack 時仍給預設速度。
    const battleState = battleSnapshot.attack
      ? battleSnapshot
      : { ...battleSnapshot, attack: { soul: { speed: 4, slowSpeed: 2 } } };
    return bot.decide(battleState);
  }
  const press = [];
  // 文字框 / 泡泡：每 6 幀按一次確認（打字中按 Z 會立刻顯示全文，第二下才關閉）
  // 引擎的 textbox 快照沒有 visible 欄位（SPEC-P2 §5：null | {...}），非 null 即代表顯示中
  const textBusy = Boolean(state.textbox && state.textbox.visible !== false) || (Array.isArray(state.bubbles) && state.bubbles.length > 0);
  if (textBusy && frame % 6 === 0) press.push('confirm');
  // 選單階段：每 20 幀按一次確認，讓它選中第一個指令（FIGHT）
  if (state.phase === 'menu' && frame % 20 === 0) press.push('confirm');
  // FIGHT 打擊條：每 8 幀按一次確認（打到就結算）
  if (state.phase === 'resolve' && state.fight && frame % 8 === 0) press.push('confirm');
  // intro / turnStart / enemyTalk 等卡住時也給確認
  if (press.length === 0 && (state.phase === 'intro' || state.phase === 'turnStart') && frame % 15 === 0) {
    press.push('confirm');
  }
  if (options.scriptPress) {
    const scripted = options.scriptPress(frame);
    if (scripted) return scripted;
  }
  return { press, hold: {} };
}

async function simulateEncounter(encounterJson, options) {
  const { createEncounter } = await import('../../engine/encounter/index.js');
  const enc = createEncounter({
    canvas: null,
    assets: null,
    mode: 'play',
    resolveAttack: makeAttackResolver(),
  });
  const stats = createStats();
  const errors = [];
  const scriptAt = options.inputs ? buildScriptInputs(options.inputs) : null;
  // 新路徑：createAutopilot（demo 讀遭遇 demo；bot 全 AI）。舊 --bot 只在沒有 autoplay 時使用。
  const pilot = !scriptAt
    ? await createSimulationPilot('encounter', encounterJson, options, await buildSyncAttackResolver(encounterJson))
    : null;
  const bot = !scriptAt && !pilot && options.bot ? createBot({ ...options, bot: options.bot || 'dodge' }) : null;

  enc.on('error', (payload) => {
    const msg = payload && payload.message ? `${payload.path || ''}: ${payload.message}` : JSON.stringify(payload);
    if (errors.length < 50) errors.push(msg);
    pushEvent(stats, { frame: payload && payload.frame, type: 'error', path: payload && payload.path, message: msg });
  });
  enc.on('hurt', (payload) => {
    stats.hits += 1;
    const damage = numArg(payload && payload.damage, 0);
    stats.damageTaken += damage;
    if (currentRecord) {
      currentRecord.hits += 1;
      currentRecord.damageTaken += damage;
    }
    pushEvent(stats, {
      frame: payload && payload.frame,
      type: 'hit',
      member: payload && payload.member,
      damage,
      hp: payload && payload.hp,
    });
  });
  enc.on('graze', () => {
    stats.grazes += 1;
    if (currentRecord) currentRecord.grazes += 1;
  });

  /* -------------------------------------------------- 遭遇層觀察事件 */
  // engine/encounter 只加「發射」（world.emit / flow.note），這裡把它們收進 events[]。
  // 每個事件都補上 frame / turn，讓 Agent 能對回時間軸。
  /** 每回合統計（key = 回合索引；事件回呼會提前用到，所以在這裡先宣告） */
  const perTurn = new Map();
  /** 目前模擬幀（事件回呼不一定帶 frame 時用它） */
  let simFrame = 0;
  /** 目前回合（事件本身的 payload 沒帶 turn 時用它） */
  let currentTurn = 0;
  /** 終局事件 payload（`enc.on('end')`） */
  let resultEvent = null;
  /** 目前回合的統計紀錄（hurt / 事件發生時才知道該記在哪一回合）。 */
  let currentRecord = null;

  const recordEvent = (type) => (payload) => {
    const p = payload && typeof payload === 'object' ? payload : {};
    const turn = numArg(p.turn, currentTurn);
    // 事件發生在「引擎目前這一幀」：世界自己的事件帶 frame，flow/text 的沒有 →
    // 用引擎當下的 frame（enc.frame）補，才不會出現 107 之後又跳回 106 的亂序。
    const eventFrame = numArg(p.frame, numArg(typeof enc.frame === 'number' ? enc.frame : null, simFrame));
    // actions 事件：把本回合每位隊員的指令選擇記進該回合的 perTurn 紀錄
    if (type === 'actions' && Array.isArray(p.actions)) {
      const target = perTurn.get(turn) || perTurn.get(currentTurn);
      if (target) {
        for (const action of p.actions) {
          if (action && action.command) target.commands.push(action.command);
        }
      }
    }
    // 攻擊開始 / 結束：記下這一回合「實際播了哪些攻擊」（含回合內 attack cue 播的；REALTEST-2 V3）
    if (type === 'attackStart' || type === 'attackEnd') {
      let target = perTurn.get(turn) || perTurn.get(currentTurn);
      if (!target) {
        target = { turn, frames: 0, hits: 0, grazes: 0, damageTaken: 0, maxBullets: 0, phases: [], commands: [], attacks: []  };
        perTurn.set(turn, target);
      }
      if (type === 'attackStart') {
        const ref = p.ref;
        const name =
          typeof ref === 'string' && ref
            ? ref
            : ref && typeof ref === 'object'
              ? (typeof ref.name === 'string' && ref.name) || (ref.meta && typeof ref.meta.name === 'string' && ref.meta.name) || '(inline)'
              : '(inline)';
        target.attacks.push({ name, startFrame: eventFrame, endFrame: null, frames: null });
      } else {
        const open = target.attacks.find((a) => a.endFrame === null);
        if (open) {
          open.endFrame = eventFrame;
          open.frames = Math.max(0, eventFrame - open.startFrame);
        }
      }
    }
    // 回合開始 / 結束事件：記在對應回合
    if (type === 'turnStart' || type === 'turnEnd') {
      let target = perTurn.get(turn);
      if (!target) {
        target = { turn, frames: 0, hits: 0, grazes: 0, damageTaken: 0, maxBullets: 0, phases: [], commands: [], attacks: [] };
        perTurn.set(turn, target);
      }
      if (type === 'turnStart') target.startedFrame = eventFrame;
      else target.endedFrame = eventFrame;
    }
    pushEvent(stats, { ...p, frame: eventFrame, turn, type });
  };
  // 'hurt' 與 'end' 另外處理（hurt 併進 hits 統計、end 記 resultEvent），其餘用同一份清單掛載。
  for (const type of ENCOUNTER_EVENT_TYPES) {
    if (type === 'hurt' || type === 'end') continue;
    enc.on(type, recordEvent(type));
  }
  enc.on('end', (payload) => {
    resultEvent = payload && typeof payload === 'object' ? payload : {};
    pushEvent(stats, {
      type: 'end',
      frame: numArg(resultEvent.frame, simFrame),
      turn: numArg(resultEvent.turn, currentTurn),
      result: resultEvent.result || null,
    });
  });
  // 每幀更新目前回合（事件本身的 turn 可能還沒帶）
  const syncCurrentTurn = (state) => {
    const t = numArg(state && state.turn, currentTurn);
    if (t !== currentTurn) currentTurn = t;
  };

  const loadResult = await enc.load(encounterJson);
  if (loadResult && Array.isArray(loadResult.errors)) {
    for (const e of loadResult.errors) errors.push(`${e.path || ''}: ${e.message}`);
  }
  if (enc.missingAttacks && enc.missingAttacks.length > 0) {
    errors.push(`找不到攻擊：${enc.missingAttacks.join(', ')}`);
  }
  enc.play();

  const initial = enc.getState();
  const startTp = numArg(initial.tp, 0);
  const startHp = (initial.party || []).reduce((sum, p) => sum + numArg(p.hp, 0), 0);
  const maxFrames = options.frames || DEFAULT_ENCOUNTER_FRAMES;

  let frame = 0;
  let result = null;

  for (; frame < maxFrames; frame += 1) {
    simFrame = frame;
    const state = enc.getState();
    syncCurrentTurn(state);
    const snapshot = state.battle;
    const bullets = snapshot && Array.isArray(snapshot.bullets) ? snapshot.bullets.filter((bullet) => !bullet.decor).length : 0;
    if (bullets > stats.maxBullets) stats.maxBullets = bullets;
    stats.bulletSamples.push(bullets);

    const turnKey = numArg(state.turn, 0);
    let turnRecord = perTurn.get(turnKey);
    if (!turnRecord) {
      turnRecord = { turn: turnKey, frames: 0, hits: 0, grazes: 0, damageTaken: 0, maxBullets: 0, phases: [], commands: [], attacks: [] };
      perTurn.set(turnKey, turnRecord);
    }
    turnRecord.frames += 1;
    turnRecord.maxBullets = Math.max(turnRecord.maxBullets, bullets);
    if (turnRecord.phases[turnRecord.phases.length - 1] !== state.phase) turnRecord.phases.push(state.phase);
    currentRecord = turnRecord;

    if (frame % TRACE_EVERY === 0) {
      stats.trace.push({
        frame,
        time: round(frame / 30, 2),
        turn: turnKey,
        phase: state.phase,
        bullets,
        tp: round(numArg(state.tp, 0), 1),
        hits: stats.hits,
        grazes: stats.grazes,
        hp: (state.party || []).reduce((sum, p) => sum + numArg(p.hp, 0), 0),
      });
    }

    for (const name of (snapshot && snapshot.sfxQueue) || []) stats.sfx.add(name);

    let input = scriptAt ? scriptAt(frame) : null;
    if (!input && pilot) input = pilot.input(state, frame);
    if (!input && bot) input = encounterAutoInput(state, bot, frame, options);
    if (!input) input = { press: [], hold: {} };
    enc.step(1, input);

    const after = enc.getState();
    if (after.result) {
      result = after.result;
      if (result) break;
    }
    if (after.ended || (after.phase === 'victory' || after.phase === 'spared' || after.phase === 'defeat' || after.phase === 'flee') && after.frame > frame + 2) {
      // 已經進入終局階段 → 再跑一小段讓演出收尾
      if (after.frame > frame + 60) break;
    }
  }

  const finalState = enc.getState();
  const finalHp = (finalState.party || []).reduce((sum, p) => sum + numArg(p.hp, 0), 0);
  // 把每回合的命中/受傷攤回去（統計時已經在 hurt 事件累加）
  for (const record of perTurn.values()) {
    record.damageTaken = Math.max(0, record.damageTaken);
  }

  const loadedEncounter = enc.encounter || null;
  const turns = (loadedEncounter && loadedEncounter.turns) || [];
  const perTurnList = [...perTurn.values()].map((record) => {
    const turnDef = turns[record.turn];
    return {
      turn: record.turn + 1,
      // turn.attack 優先；回合內只用 attack cue 播攻擊時，用實際播出的第一支補上名字
      attack: turnDef && turnDef.attack ? turnDef.attack : record.attacks.length > 0 ? record.attacks[0].name : null,
      /** 這一回合實際播出的攻擊（含 attack cue）：[{ name, startFrame, endFrame, frames }] */
      attacks: record.attacks.map((a) => ({ ...a })),
      frames: record.frames,
      startedFrame: record.startedFrame === undefined ? null : record.startedFrame,
      endedFrame: record.endedFrame === undefined ? null : record.endedFrame,
      hits: record.hits,
      grazes: record.grazes,
      damageTaken: record.damageTaken,
      maxBullets: record.maxBullets,
      phases: record.phases,
      commands: record.commands,
    };
  });

  enc.destroy();

  return {
    kind: 'encounter',
    name: (encounterJson.meta && encounterJson.meta.name) || null,
    frames: numArg(finalState.frame, frame),
    totalFrames: maxFrames,
    ended: Boolean(result),
    phase: finalState.phase,
    result: result || finalState.phase || 'timeout',
    hits: stats.hits,
    grazes: stats.grazes,
    damageTaken: Math.max(0, startHp - finalHp),
    tpGained: round(Math.max(0, numArg(finalState.tp, 0) - startTp), 2),
    peakTp: round(numArg(finalState.tp, 0), 1),
    maxBullets: stats.maxBullets,
    avgBullets: round(mean(stats.bulletSamples), 2),
    party: (finalState.party || []).map((p) => ({ name: p.name, hp: p.hp, maxHp: p.maxHp })),
    enemies: (finalState.enemies || []).map((e) => ({ name: e.name, hp: e.hp, maxHp: e.maxHp })),
    errors,
    events: stats.events,
    /** 事件種類統計（讓 Agent 一眼看出這局做了什麼） */
    eventCounts: countEvents(stats.events),
    sfx: [...stats.sfx].sort(),
    perTurn: perTurnList,
    autoplay: autoplaySummary(options, pilot),
    trace: stats.trace,
  };
}

/** events[] → { type: 次數 }（debug 用）。 */
function countEvents(events) {
  const counts = {};
  for (const event of Array.isArray(events) ? events : []) {
    const type = event && event.type ? event.type : 'unknown';
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

/* ----------------------------------------------------------- 對外 API */

/**
 * 跑一次模擬。
 *
 * @param {string|object} target 檔案路徑或已解析的 JSON
 * @param {object} [options] {frames, bot, inputs, autoplay, seed, horizon, grazeBias}
 */
export async function simulate(target, options = {}) {
  let json = target;
  let file = null;
  if (typeof target === 'string') {
    file = resolveInputFile(target);
    if (!file) throw new Error(`找不到檔案：${target}`);
    json = readJSON(file);
  }
  const kind = detectKind(json);
  const result = kind === 'encounter' ? await simulateEncounter(json, options) : await simulateAttack(json, options);
  return { ...result, file };
}

/* --------------------------------------------------------------- CLI */

async function main() {
  let paths = null;
  try {
    paths = applyCliPaths(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  const args = parseArgs(process.argv.slice(2), [
    'frames',
    'bot',
    'inputs',
    'autoplay',
    'seed',
    'horizon',
    'graze-bias',
    'max-events',
    'root',
    'works',
  ], { booleanFlags: ['events', 'trace'] });
  const input = args._[0];
  if (!input) {
    console.error(
      '用法：node tools/agent/sim.mjs <攻擊檔|遭遇檔> [--autoplay demo|bot] [--frames N] [--inputs script.json] [--bot dodge|idle|random] [--root DIR] [--works DIR] [--json]',
    );
    process.exitCode = 2;
    return;
  }
  if (args.root || args.works) {
    // --root / --works 已在 applyCliPaths() 生效；這裡只留給 --json 除錯用。
    void paths;
  }
  let autoplay = null;
  try {
    if (!args.inputs && args.bot === undefined) {
      // 新預設：沒有 --bot / --inputs 時走自動演示；--autoplay 不帶值 = bot。
      autoplay = normalizeAutoplayMode(args.autoplay === undefined ? 'bot' : args.autoplay);
    } else if (args.autoplay !== undefined) {
      autoplay = normalizeAutoplayMode(args.autoplay);
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  const options = {
    frames: args.frames !== undefined ? Math.max(1, Math.round(numArg(args.frames, 0))) : 0,
    autoplay,
    // 舊參數相容：只在明確給 --bot（或沒有啟用 autoplay / inputs 時才有意義）時使用。
    bot: args.bot === true ? 'dodge' : args.bot || null,
    inputs: null,
    seed: numArg(args.seed, 1),
    horizon: numArg(args.horizon, 14),
    grazeBias: numArg(args['graze-bias'], 0),
  };
  if (typeof args.inputs === 'string') {
    const scriptFile = resolveInputFile(args.inputs);
    if (!scriptFile) {
      console.error(`找不到輸入腳本：${args.inputs}`);
      process.exitCode = 2;
      return;
    }
    try {
      const script = readJSON(scriptFile);
      options.inputs = Array.isArray(script) ? script : script.inputs || script.script || [];
    } catch (err) {
      console.error(`輸入腳本解析失敗：${err.message}`);
      process.exitCode = 2;
      return;
    }
  }

  const result = await simulate(input, options);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const filename = result.file ? result.file.split(/[\\/]/).pop() : input;
  console.log(`檔案：${filename}（${result.kind === 'encounter' ? '遭遇' : '攻擊'}）`);
  if (result.name) console.log(`名稱：${result.name}`);
  if (result.autoplay && result.autoplay.mode) {
    const info = result.autoplay.describe || {};
    const detail = info.dodge ? `（${info.dodge}${info.turn !== undefined && info.turn !== null ? `，第 ${info.turn} 回合` : ''}）` : '';
    console.log(`自動演示：${result.autoplay.mode}${detail}`);
    if (result.autoplay.warnings.length > 0) {
      console.log(`  警告 ${result.autoplay.warnings.length} 筆：${result.autoplay.warnings.slice(0, 5).join('；')}`);
    }
  } else if (options.bot) {
    console.log(`玩家模型：bot ${options.bot}`);
  } else if (scriptAtInfo(options)) {
    console.log('玩家模型：輸入腳本');
  }
  console.log(
    `幀數：${result.frames}/${result.totalFrames}　結束：${result.ended ? '是' : '否（逾時）'}　結果：${result.result}`,
  );
  console.log(
    `受傷 ${result.hits} 次（-${result.damageTaken} HP）　擦彈 ${result.grazes} 次　TP +${result.tpGained}（峰值 ${result.peakTp}）`,
  );
  console.log(`子彈：峰值 ${result.maxBullets}、平均 ${result.avgBullets}`);
  if (result.party && result.party.length > 0) {
    console.log(`隊伍：${result.party.map((p) => `${p.name} ${p.hp}/${p.maxHp}`).join('　')}`);
  }
  if (result.enemies && result.enemies.length > 0) {
    console.log(`敵人：${result.enemies.map((e) => `${e.name} ${e.hp}/${e.maxHp}`).join('　')}`);
  }
  if (result.perTurn.length > 1) {
    console.log('');
    console.log('回合  攻擊              指令                    幀數  受傷  擦彈  峰值彈數');
    for (const t of result.perTurn) {
      const commands = Array.isArray(t.commands) && t.commands.length > 0 ? t.commands.join('/') : '-';
      console.log(
        `${String(t.turn).padStart(4)}  ${String(t.attack || '-').padEnd(16)}  ${commands.padEnd(22)}  ${String(t.frames).padStart(4)}  ` +
          `${String(t.hits).padStart(4)}  ${String(t.grazes).padStart(4)}  ${String(t.maxBullets).padStart(8)}`,
      );
    }
  }
  if (args.events && result.events.length > 0) {
    console.log('');
    console.log(`事件 ${result.events.length} 筆（frame  type  turn  摘要）：`);
    for (const e of result.events) {
      console.log(`  ${String(e.frame).padStart(5)}  ${String(e.type).padEnd(12)}  ${String(e.turn === undefined ? '-' : e.turn).padStart(3)}  ${describeEvent(e)}`);
    }
  } else if (result.events.length > 0) {
    const counts = Object.entries(result.eventCounts || {})
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type}×${count}`)
      .join('、');
    console.log(`事件：${result.events.length} 筆${counts ? `（${counts}）` : ''}，--events 可列出明細。`);
  }
  if (result.sfx.length > 0) console.log(`音效：${result.sfx.join(', ')}`);
  if (result.errors.length > 0) {
    console.log('');
    console.log(`錯誤 ${result.errors.length} 筆：`);
    for (const e of result.errors.slice(0, 20)) console.log(`  - ${e}`);
  } else {
    console.log('\n沒有錯誤。');
  }
  if (args.trace) {
    console.log('');
    console.log('逐秒：');
    for (const row of result.trace) {
      console.log(
        `  t=${String(row.time).padStart(5)}s  frame=${String(row.frame).padStart(4)}  彈=${String(row.bullets).padStart(3)}  ` +
          `TP=${String(row.tp).padStart(5)}  累計受傷=${row.hits} 擦彈=${row.grazes}`,
      );
    }
  }
}

/** 小工具：文字輸出用。 */
function scriptAtInfo(options) {
  return Boolean(options && options.inputs);
}

/** 小工具：--events 文字輸出用，把事件摘要成一行人看得懂的字。 */
function eventMember(event) {
  const e = event || {};
  if (e.memberId) return e.memberId;
  if (typeof e.member === 'string' && e.member) return e.member;
  return e.member === undefined || e.member === null ? '' : String(e.member);
}

function describeEvent(event) {
  const e = event || {};
  switch (e.type) {
    case 'turnStart':
      return '回合開始';
    case 'turnEnd':
      return '回合結束';
    case 'actions':
      // 每個隊員的指令（fight/act/magic/item/spare/defend）＋目標/選項
      return `${(e.actions || [])
        .map((a) => {
          const command = a.occupied ? 'act' : a.command || '?';
          const option = a.actId || a.spellId || a.itemId || '';
          const target = a.target || a.targetMember || '';
          return `${a.member || a.memberId || '?'}:${command}${option ? `(${option})` : ''}${target ? `→${target}` : ''}`;
        })
        .join(' ')}`;
    case 'act':
      return `${eventMember(e)} ACT ${e.actId || ''} → ${e.enemy || ''}`;
    case 'actDone':
      return `${e.actId || ''} 完成`;
    case 'defend':
      return `${eventMember(e)} 防禦`;
    case 'spare':
      return `${eventMember(e)} 饒恕 ${e.enemy || ''}${e.ok ? '（成功）' : ''}`;
    case 'magic':
      return `${eventMember(e)} 魔法 ${e.spellId || ''}（TP-${numArg(e.cost, 0)}）`;
    case 'item':
      return `${eventMember(e)} 道具 ${e.itemId || ''}（+${numArg(e.heal, 0)} HP）`;
    case 'mercy':
      return `${e.id || ''} 仁慈 ${e.before}→${e.after}`;
    case 'tp':
      return `TP ${e.before}→${e.after}（${e.cause || ''}）`;
    case 'hp':
      return `${e.id || ''} HP ${e.from}→${e.to}（${e.cause || ''}）`;
    case 'say':
      return `${e.speaker || ''}：「${truncateText(e.text, 30)}」`;
    case 'bubble':
      return `${e.actor || ''}：「${truncateText(e.text, 30)}」`;
    case 'attackStart':
      return `攻擊開始 ${e.ref || ''}（${numArg(e.duration, 0)} 幀）`;
    case 'attackEnd':
      return `攻擊結束 ${e.ref || ''}（hits ${numArg(e.hits, 0)}）`;
    case 'enemyRemoved':
      return `敵人移除 ${e.id || ''}`;
    case 'end':
      return `戰鬥結束：${e.result || ''}`;
    default:
      return '';
  }
}

/** 小工具：把長台詞截短。 */
function truncateText(text, max) {
  const value = String(text === undefined || text === null ? '' : text);
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

if (cliEntry(import.meta.url)) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}

export default simulate;
