/**
 * tests/autoplay/encounter.mjs — 遭遇自動演示（AP2）整合測試
 *
 * 執行：node tests/autoplay/encounter.mjs
 *
 * 本檔**獨立可執行**：不依賴 tests/autoplay/run.mjs（AP1 擁有），也不依賴
 * tests/engine/harness.mjs；只 import 引擎與 AP2 負責的模組：
 *   engine/encounter/index.js            （無頭遭遇）
 *   engine/encounter/schema.js           （驗證接線）
 *   engine/autoplay/encounter.js         （createEncounterPilot）
 *   engine/autoplay/validate-encounter.js（validateEncounterDemo）
 *
 * 覆蓋（SPEC-AUTOPLAY §2.2 / §3 / §5）：
 *   A. API 契約：createEncounterPilot → { input, reset, warnings, describe }
 *   B. demo 驗證：validateEncounterDemo 與 schema 接線（路徑如 demo.turns[0].choices[1].option）
 *   C. 文字自動前進：打字中不按、打完 delay 後按、text.auto=false 不按、泡泡同樣處理
 *   D. FIGHT 打擊條：perfect / good / miss / 數值 的按鍵時機（每位隊員各自）
 *   E. 選單導航（合成 menu 快照）：按鈕層、清單層、多步移動、三層 magic、
 *      選項不存在 → warning + 退回 default、卡住脫困
 *   F. 躲避轉交：dodgePilotFor 參數、輸出正規化、例外處理
 *   G. 整合：samples/encounters/{rudinn,showcase}.json 的 demo 實際跑完
 *      —— menuDelay 0 與 6、warnings 空、demo 的 ACT/法術/道具/FIGHT 真的執行、
 *         走到終局、決定性（跑兩次逐項相同）
 */

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createEncounter } from '../../engine/encounter/index.js';
import { createAutopilot } from '../../engine/autoplay/index.js';
import { createEncounterPilot } from '../../engine/autoplay/encounter.js';
import { validateEncounterDemo } from '../../engine/autoplay/validate-encounter.js';
import * as schema from '../../engine/encounter/schema.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/* ------------------------------------------------------------- 迷你框架 */

const results = { pass: 0, fail: 0, notes: 0 };
const failures = [];
let currentGroup = '（未分組）';
const startTime = Date.now();

function group(name) {
  currentGroup = name;
  console.log(`\n=== ${name} ===`);
}

function ok(value, message) {
  if (!value) throw new Error(message || `預期為真，實際 ${format(value)}`);
}

function eq(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message ? `${message}：` : ''}預期 ${format(expected)}，實際 ${format(actual)}`);
  }
}

function okEq(actual, expected, message) {
  eq(actual, expected, message);
}

function deepEq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${message ? `${message}：` : ''}預期 ${clip(b)}，實際 ${clip(a)}`);
}

/** 由上而下依序 await 執行（含 async） */
async function test(name, fn) {
  try {
    await fn();
    results.pass += 1;
    console.log(`✔ ${name}`);
  } catch (err) {
    results.fail += 1;
    const message = err && err.message ? err.message : String(err);
    failures.push({ group: currentGroup, name, message });
    console.log(`✘ ${name}`);
    console.log(`    ${message}`);
  }
}

function note(text) {
  results.notes += 1;
  console.log(`  · 備註：${text}`);
}

function format(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.length} 項]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).join(',')}}`;
  return String(value);
}

function clip(text, max = 320) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* --------------------------------------------------------------- 載入器 */

const sampleCache = new Map();

async function readSample(rel) {
  if (sampleCache.has(rel)) return sampleCache.get(rel);
  const json = JSON.parse(await readFile(join(ROOT, rel), 'utf8'));
  sampleCache.set(rel, json);
  return json;
}

/** 深拷貝遭遇檔（測試會改 demo，不能污染快取） */
function cloneDoc(doc) {
  return JSON.parse(JSON.stringify(doc));
}

/** 建立「會從 samples/ 解析攻擊檔」的無頭遭遇 */
function makeEncounter() {
  return createEncounter({
    canvas: null,
    assets: null,
    resolveAttack: async (name) => readSample(`samples/${name}.json`),
  });
}

/** 測試用假躲避駕駛：決定性繞行（不依賴 AP1 的 createSoulPilot） */
function makeFakeDodgeFactory() {
  const calls = [];
  const factory = (turn, attackDoc, dodge) => {
    // SPEC §3：第 2 個參數是攻擊檔（物件），不是名字
    const isDoc = attackDoc !== null && typeof attackDoc === 'object';
    const name = isDoc
      ? attackDoc.meta && attackDoc.meta.name
        ? attackDoc.meta.name
        : null
      : typeof attackDoc === 'string'
        ? attackDoc
        : null;
    calls.push({ turn, attackName: name, attackDoc: isDoc ? attackDoc : null, dodge });
    return {
      resets: 0,
      reset() {
        this.resets += 1;
      },
      decide(battle) {
        const f = Number.isFinite(battle && battle.frame) ? battle.frame : 0;
        return { dx: Math.sin(f / 9) >= 0 ? 1 : -1, dy: Math.cos(f / 13) >= 0 ? 1 : -1, slow: false };
      },
    };
  };
  factory.calls = calls;
  return factory;
}

/**
 * 把遭遇跑到終局並記錄觀察值。
 * @param {{doc:object, menuDelay?:number, maxFrames?:number, dodgePilotFor?:Function}} options
 */
async function playEncounter(options) {
  const doc = options.doc;
  const menuDelay = options.menuDelay === undefined ? 0 : options.menuDelay;
  const maxFrames = options.maxFrames === undefined ? 8000 : options.maxFrames;
  // 可選：模擬包裝層 / 引擎對輸入的再處理（預設原樣傳）
  const transformInput = typeof options.transformInput === 'function' ? options.transformInput : (out) => out;
  const enc = makeEncounter();
  const loadResult = await enc.load(doc);

  const runtimeErrors = [];
  enc.on('error', (payload) => runtimeErrors.push(payload));

  const dodgeFactory = options.dodgePilotFor ? options.dodgePilotFor() : makeFakeDodgeFactory();
  const pilot = createEncounterPilot({
    demo: doc.demo,
    encounter: doc,
    menuDelay,
    dodgePilotFor: dodgeFactory,
  });

  const seen = {
    phases: [],
    menuSteps: [],
    battleFrames: 0,
    fightResults: [],
    maxTp: 0,
    maxMercy: [],
    textFrames: 0,
    varsSeen: {},
  };
  let lastPhaseKey = null;

  enc.play();
  for (let frame = 0; frame < maxFrames && !enc.result; frame += 1) {
    const state = enc.getState();
    const phaseKey = `${state.phase}@${state.turn}`;
    if (phaseKey !== lastPhaseKey) {
      seen.phases.push(phaseKey);
      lastPhaseKey = phaseKey;
    }
    if (state.phase === 'menu' && state.menu) {
      seen.menuSteps.push({
        turn: state.turn + 1,
        member: state.menu.member,
        cursor: state.menu.cursor,
        listKind: state.menu.list ? state.menu.list.kind : null,
      });
    }
    if (state.battle) seen.battleFrames += 1;
    if (state.tp > seen.maxTp) seen.maxTp = state.tp;
    if (state.phase === 'menu') {
      const mercy = state.enemies.map((e) => e.mercy).join(',');
      if (!seen.maxMercy.includes(mercy)) seen.maxMercy.push(mercy);
    }
    if (state.fight && Array.isArray(state.fight.bars)) {
      for (const bar of state.fight.bars) {
        if (!bar || !bar.result) continue;
        const key = `${state.turn}:${bar.memberId}:${bar.result}`;
        if (!seen.fightResults.includes(key)) seen.fightResults.push(key);
      }
    }
    if (state.textbox || (Array.isArray(state.bubbles) && state.bubbles.length > 0)) seen.textFrames += 1;
    for (const key of Object.keys(state.vars || {})) {
      const value = state.vars[key];
      if (typeof value === 'number' && (seen.varsSeen[key] === undefined || value > seen.varsSeen[key])) {
        seen.varsSeen[key] = value;
      }
    }
    enc.step(1, transformInput(pilot.input(state, frame)));
  }

  const state = enc.getState();
  // getState（SPEC §5）不含道具；道具從 debug.world 取（銷毀前）
  const worldItems = (() => {
    try {
      const world = enc.debug && enc.debug.world;
      return world && Array.isArray(world.items) ? world.items : [];
    } catch (_e) {
      return [];
    }
  })();
  const record = {
    result: enc.result,
    frames: enc.frame,
    loadErrors: (loadResult.errors || []).map((e) => `${e.path}: ${e.message}`),
    runtimeErrors: runtimeErrors.map((e) => `${(e && e.path) || '?'}: ${(e && e.message) || ''}`),
    warnings: pilot.warnings.slice(),
    describe: pilot.describe(),
    dodgeCalls: Array.isArray(dodgeFactory.calls) ? dodgeFactory.calls.slice() : [],
    seen,
    party: state.party.map((p) => ({ id: p.id, hp: p.hp, maxHp: p.maxHp })),
    enemies: state.enemies.map((e) => ({ id: e.id, hp: e.hp, mercy: e.mercy, removed: e.removed, spareable: e.spareable })),
    vars: { ...state.vars },
    tp: state.tp,
    items: worldItems.map((it) => ({ id: it.id, count: it.count })),
  };
  enc.destroy();
  return record;
}

/* =============================================================== A. API */

group('A) API 契約（SPEC-AUTOPLAY §3）');

await test('loop-last：第 4 輪使用自己的 demo 選項，仍使用第 1 個回合定義', async () => {
  const doc = cloneDoc(await readSample('samples/encounters/rudinn.json'));
  doc.hooks.intro = [];
  doc.turnOrder = 'loop-last';
  doc.turns = [{ id: 'repeat', talk: [], start: [], end: [] }];
  doc.demo = {
    menuDelay: 0,
    default: { choices: 'defend' },
    turns: [{ turn: 4, choices: [{ member: 'kris', command: 'fight', target: doc.enemies[0].id }] }],
  };
  deepEq(validateEncounterDemo(doc.demo, doc), []);
  const enc = makeEncounter();
  await enc.load(doc);
  const pilot = createAutopilot({ kind: 'encounter', doc, mode: 'demo' });
  await pilot.ready;
  const actions = [];
  enc.on('actions', ({ actions: picked }) => {
    const state = enc.getState();
    actions.push([state.turnNumber, state.turn, picked[0].command]);
  });
  for (let i = 0; i < 800 && actions.length < 4; i += 1) enc.step(1, pilot.input(enc.getState(), i));
  deepEq(actions, [[1, 0, 'defend'], [2, 0, 'defend'], [3, 0, 'defend'], [4, 0, 'fight']]);
});

await test('createEncounterPilot 回傳 input / reset / warnings / describe', () => {
  const pilot = createEncounterPilot({ demo: {}, menuDelay: 0 });
  eq(typeof pilot.input, 'function', 'input');
  eq(typeof pilot.reset, 'function', 'reset');
  ok(Array.isArray(pilot.warnings), 'warnings 必須是陣列');
  eq(typeof pilot.describe, 'function', 'describe');
  const output = pilot.input({ phase: 'intro', turn: 0, textbox: null, bubbles: [] }, 0);
  ok(Array.isArray(output.press), 'input().press 必須是陣列');
  ok(output.hold !== null && typeof output.hold === 'object', 'input().hold 必須是物件');
  pilot.reset();
  eq(pilot.warnings.length, 0, 'reset() 後 warnings 清空');
});

await test('describe() 回傳 { mode, dodge, turn, step }（外加 menuDelay）', () => {
  const demo = {
    menuDelay: 3,
    turns: [{ turn: 1, dodge: 'path', choices: [{ member: 'kris', command: 'fight', target: 'jigsaw' }] }],
    default: { choices: 'defend', fight: 'good', dodge: 'bot' },
  };
  const pilot = createEncounterPilot({ demo });
  pilot.input({ phase: 'menu', turn: 0, menu: null, enemies: [] }, 0);
  const d = pilot.describe();
  eq(d.mode, 'demo', 'mode');
  eq(d.dodge, 'path', 'dodge');
  eq(d.turn, 1, 'turn');
  eq(d.menuDelay, 3, 'menuDelay');
  ok(typeof d.step === 'string', 'step');
});

await test('menuDelay 預設：demo.menuDelay → 6；明確傳入優先', () => {
  eq(createEncounterPilot({ demo: {} }).menuDelay, 6, '預設 6');
  eq(createEncounterPilot({ demo: { menuDelay: 11 } }).menuDelay, 11, '讀 demo.menuDelay');
  eq(createEncounterPilot({ demo: { menuDelay: 11 }, menuDelay: 0 }).menuDelay, 0, '參數優先');
});

await test('沒有 demo / 沒有 dodgePilotFor 也不丟例外', () => {
  const pilot = createEncounterPilot({});
  const out = pilot.input({ phase: 'menu', turn: 0, menu: null }, 0);
  ok(Array.isArray(out.press), 'press');
  const pilot2 = createEncounterPilot({ dodgePilotFor: () => null });
  const out2 = pilot2.input({ phase: 'attack', turn: 0, battle: { frame: 3 }, attack: null }, 1);
  deepEq(out2.press, [], '沒有駕駛時不按鍵');
});

/* ============================================================== B. 驗證 */

group('B) demo 驗證（validateEncounterDemo 與 schema 接線）');

const rudinnDoc = await readSample('samples/encounters/rudinn.json');
const showcaseDoc = await readSample('samples/encounters/showcase.json');

const ERROR_CASES = [
  {
    name: 'member 不存在',
    mutate: (d) => {
      d.demo.turns[0].choices[0].member = 'nobody';
    },
    path: 'demo.turns[0].choices[0].member',
  },
  {
    // susie 沒有 magic 指令
    name: 'command 不在該隊員的 commands',
    mutate: (d) => {
      d.demo.turns[0].choices[1].command = 'magic';
    },
    path: 'demo.turns[0].choices[1].command',
  },
  {
    name: 'ACT option 不存在',
    mutate: (d) => {
      d.demo.turns[0].choices[0].option = 'NoSuchAct';
    },
    path: 'demo.turns[0].choices[0].option',
  },
  {
    name: 'fight 值不合法',
    mutate: (d) => {
      d.demo.turns[0].fight = 'ultra';
    },
    path: 'demo.turns[0].fight',
  },
  {
    name: 'dodge 值不合法',
    mutate: (d) => {
      d.demo.turns[0].dodge = 'warp';
    },
    path: 'demo.turns[0].dodge',
  },
  {
    name: 'turn 重複',
    mutate: (d) => {
      d.demo.turns[1].turn = 1;
    },
    path: 'demo.turns[1].turn',
  },
  {
    name: 'turn 必須由 1 起算',
    mutate: (d) => {
      d.demo.turns[0].turn = 0;
    },
    path: 'demo.turns[0].turn',
  },
  {
    name: 'menuDelay 為負',
    mutate: (d) => {
      d.demo.menuDelay = -3;
    },
    path: 'demo.menuDelay',
  },
  {
    name: 'text.auto 不是布林',
    mutate: (d) => {
      d.demo.text.auto = 'yes';
    },
    path: 'demo.text.auto',
  },
];

await test('validateEncounterDemo(undefined/null) 合法（沒有腳本）', () => {
  deepEq(validateEncounterDemo(undefined, {}), [], 'undefined');
  deepEq(validateEncounterDemo(null, {}), [], 'null');
});

await test('兩個範例的 demo 都通過驗證（0 錯誤）', () => {
  for (const [name, doc] of [
    ['rudinn', rudinnDoc],
    ['showcase', showcaseDoc],
  ]) {
    const errors = validateEncounterDemo(doc.demo, doc);
    deepEq(errors.map((e) => `${e.path}: ${e.message}`), [], `${name} 不該有錯誤`);
  }
});

await test('壞掉的 demo 回傳帶完整路徑的錯誤（不丟例外）', () => {
  for (const c of ERROR_CASES) {
    const doc = cloneDoc(rudinnDoc);
    c.mutate(doc);
    const errors = validateEncounterDemo(doc.demo, doc);
    ok(errors.length > 0, `${c.name}：應該要有錯誤`);
    ok(
      errors.some((e) => e.path === c.path || e.path.startsWith(`${c.path}.`)),
      `${c.name}：找不到路徑 ${c.path}（實際：${errors.map((e) => e.path).join(', ')}）`,
    );
  }
});

await test('schema.validateEncounter 把 demo 錯誤接進同一份 errors', () => {
  const doc = cloneDoc(rudinnDoc);
  doc.demo.turns[0].choices[1].option = 'NoSuchAct';
  const errors = schema.validateEncounter(doc);
  const demoErrors = errors.filter((e) => e.path.startsWith('demo.turns[0].choices[1]'));
  ok(
    demoErrors.length > 0,
    `應該要有 demo.turns[0].choices[1] 的錯誤（實際：${errors.map((e) => e.path).join(', ')}）`,
  );
  ok(demoErrors[0].message.includes('NoSuchAct'), `訊息應提到 NoSuchAct（實際：${demoErrors[0].message}）`);
  const others = errors.filter((e) => !e.path.startsWith('demo.'));
  eq(others.length, 0, `不該有非 demo 的錯誤（${others.map((e) => `${e.path}: ${e.message}`).join(' / ')}`);
});

await test('schema.validateEncounter 對 demo 型別錯誤也不丟例外', () => {
  const doc = cloneDoc(rudinnDoc);
  doc.demo = '打錯的型別';
  const errors = schema.validateEncounter(doc);
  ok(errors.some((e) => e.path === 'demo'), 'demo 型別錯誤要回報在 "demo"');
});

await test('demo 不在遭遇檔時，schema 驗證不受影響', () => {
  const doc = cloneDoc(rudinnDoc);
  delete doc.demo;
  deepEq(schema.validateEncounter(doc), [], '沒有 demo 的範例不該有錯誤');
});

/* ================================================== C. 文字自動前進 */

group('C) 文字自動前進（打字中不按、打完 delay 後按）');

function textState(done) {
  return {
    phase: 'intro',
    turn: 0,
    textbox: { lines: ['* 測試文字'], visibleChars: done ? 9 : 3, totalChars: 9, done, speaker: null },
    bubbles: [],
  };
}

await test('打字中（done=false）完全不按 confirm', () => {
  const pilot = createEncounterPilot({ demo: { text: { auto: true, delay: 0 } } });
  for (let frame = 0; frame < 150; frame += 1) {
    deepEq(pilot.input(textState(false), frame).press, [], `第 ${frame} 幀不該按鍵（打字中）`);
  }
});

await test('打完後 delay 秒才按 confirm（0.5 秒 = 15 幀）', () => {
  const pilot = createEncounterPilot({ demo: { text: { auto: true, delay: 0.5 } } });
  let firstPress = -1;
  for (let frame = 0; frame < 90; frame += 1) {
    if (pilot.input(textState(true), frame).press.includes('confirm')) {
      firstPress = frame;
      break;
    }
  }
  ok(firstPress >= 15 && firstPress <= 20, `應在 15~20 幀內第一次按（實際 ${firstPress}）`);
});

await test('text.auto=false 時永不自動按', () => {
  const pilot = createEncounterPilot({ demo: { text: { auto: false, delay: 0 } } });
  for (let frame = 0; frame < 400; frame += 1) {
    deepEq(pilot.input(textState(true), frame).press, [], `第 ${frame} 幀不該按鍵（auto=false）`);
  }
});

await test('泡泡（bubbles）也走同一套自動前進', () => {
  const pilot = createEncounterPilot({ demo: { text: { auto: true, delay: 0 } } });
  const state = {
    phase: 'enemyTalk',
    turn: 0,
    textbox: null,
    bubbles: [
      {
        actor: 'rudinn',
        x: 100,
        y: 100,
        w: 80,
        side: 'left',
        lines: ['嘿嘿'],
        visibleChars: 2,
        totalChars: 2,
        done: true,
      },
    ],
  };
  let pressed = false;
  for (let frame = 0; frame < 30; frame += 1) {
    if (pilot.input(state, frame).press.includes('confirm')) {
      pressed = true;
      break;
    }
  }
  ok(pressed, '泡泡打完後應按 confirm');
});

await test('泡泡打字中不按', () => {
  const pilot = createEncounterPilot({ demo: { text: { auto: true, delay: 0 } } });
  const state = {
    phase: 'enemyTalk',
    turn: 0,
    textbox: null,
    bubbles: [
      { actor: 'rudinn', x: 100, y: 100, w: 80, side: 'left', lines: ['嘿嘿'], visibleChars: 1, totalChars: 2, done: false },
    ],
  };
  for (let frame = 0; frame < 60; frame += 1) {
    deepEq(pilot.input(state, frame).press, [], `第 ${frame} 幀不該按鍵（泡泡打字中）`);
  }
});

/* ==================================================== D. FIGHT 時機 */

group('D) FIGHT 打擊條時機（與 fight.js 判定窗一致）');

function fightState(x, targetX) {
  return {
    phase: 'resolve',
    turn: 0,
    enemies: [{ id: 'jigsaw', hp: 90, maxHp: 90, mercy: 0, removed: false, name: 'Jigsawry' }],
    party: [{ id: 'kris', hp: 90, maxHp: 90, commands: ['fight', 'act', 'item', 'spare', 'defend'] }],
    fight: { bars: [{ member: 0, memberId: 'kris', color: '#fff', x, targetX, result: null }] },
    textbox: null,
    bubbles: [],
  };
}

function fightDemo(mode) {
  return {
    turns: [{ turn: 1, choices: [{ member: 'kris', command: 'fight', target: 'jigsaw' }], fight: mode }],
    default: { choices: 'fight', fight: 'good' },
  };
}

await test('fight:"perfect" 只在 |x-targetX| <= 9 時按 confirm', () => {
  const pilot = createEncounterPilot({ demo: fightDemo('perfect') });
  const xs = [300, 290, 280, 270, 260, 255];
  const pressed = xs.map((x, i) => pilot.input(fightState(x, 250), i).press.includes('confirm'));
  deepEq(pressed, [false, false, false, false, false, true], `按鍵時機（${pressed.join(',')}）`);
});

await test('fight:"good" 只在 10 < |x-targetX| <= 26 時按 confirm', () => {
  const pilot = createEncounterPilot({ demo: fightDemo('good') });
  const xs = [300, 285, 275, 270, 265, 260];
  const pressed = xs.map((x, i) => pilot.input(fightState(x, 250), i).press.includes('confirm'));
  deepEq(pressed, [false, false, true, true, true, false], `按鍵時機（${pressed.join(',')}）`);
});

await test('fight:"miss" 一律不按（讓標記跑到 0 = MISS）', () => {
  const pilot = createEncounterPilot({ demo: fightDemo('miss') });
  for (let i = 0; i < 40; i += 1) {
    const x = 300 - i * 6.5;
    deepEq(pilot.input(fightState(x, x), i).press, [], `第 ${i} 幀不該按（miss）`);
  }
});

await test('fight: 數值 0.2 = 距離 <= 20 才按', () => {
  const pilot = createEncounterPilot({ demo: fightDemo(0.2) });
  const xs = [300, 280, 275, 270, 269];
  const pressed = xs.map((x, i) => pilot.input(fightState(x, 250), i).press.includes('confirm'));
  deepEq(pressed, [false, false, false, true, true], `按鍵時機（${pressed.join(',')}）`);
});

await test('每位出手隊員各自用自己的 fight 設定', () => {
  const demo = {
    turns: [
      {
        turn: 1,
        choices: [
          { member: 'kris', command: 'fight', target: 'jigsaw', fight: 'perfect' },
          { member: 'susie', command: 'fight', target: 'jigsaw', fight: 'miss' },
        ],
      },
    ],
    default: { choices: 'fight', fight: 'perfect' },
  };
  const pilot = createEncounterPilot({ demo });
  const kris = fightState(300, 300);
  deepEq(pilot.input(kris, 0).press, ['confirm'], 'kris 正中 → perfect 按');
  const susie = fightState(300, 300);
  susie.fight.bars[0].member = 1;
  susie.fight.bars[0].memberId = 'susie';
  susie.party.push({ id: 'susie', hp: 110, maxHp: 110, commands: ['fight', 'act'] });
  deepEq(pilot.input(susie, 1).press, [], 'susie 指定 miss → 不按');
});

await test('沒有 fight 快照時不亂按（文字優先）', () => {
  const pilot = createEncounterPilot({ demo: fightDemo('perfect') });
  const state = { phase: 'resolve', turn: 0, fight: null, textbox: null, bubbles: [] };
  for (let frame = 0; frame < 10; frame += 1) {
    deepEq(pilot.input(state, frame).press, [], `第 ${frame} 幀不該按鍵`);
  }
});

/* ===================================================== E. 選單導航 */

group('E) 選單導航（合成 menu 快照）');

const MENU_BUTTONS = ['fight', 'act', 'magic', 'item', 'spare', 'defend'];

function menuState(overrides = {}) {
  return {
    phase: 'menu',
    turn: 0,
    party: [
      { id: 'kris', hp: 90, maxHp: 90, commands: ['fight', 'act', 'item', 'spare', 'defend'], spells: [] },
      { id: 'susie', hp: 110, maxHp: 110, commands: ['fight', 'act'], spells: [] },
      {
        id: 'ralsei',
        hp: 70,
        maxHp: 70,
        commands: ['fight', 'magic', 'item', 'spare', 'defend'],
        spells: [{ id: 'pacify', name: 'Pacify', tp: 32, target: 'enemy' }],
      },
    ],
    enemies: [
      { id: 'rudinn', hp: 120, maxHp: 120, mercy: 0, removed: false, name: 'Rudinn' },
      { id: 'hathy', hp: 80, maxHp: 80, mercy: 0, removed: false, name: 'Hathy' },
    ],
    tp: 100,
    textbox: null,
    bubbles: [],
    menu: {
      member: 0,
      buttons: MENU_BUTTONS.map((id) => ({ id, enabled: id !== 'magic' })),
      cursor: 0,
      list: null,
    },
    ...overrides,
  };
}

function docForMenu() {
  return {
    party: [
      { id: 'kris', commands: ['fight', 'act', 'item', 'spare', 'defend'] },
      { id: 'susie', commands: ['fight', 'act'] },
      {
        id: 'ralsei',
        commands: ['fight', 'magic', 'item', 'spare', 'defend'],
        spells: [{ id: 'pacify', name: 'Pacify', tp: 32, target: 'enemy' }],
      },
    ],
    enemies: [
      {
        id: 'rudinn',
        name: 'Rudinn',
        acts: [
          { id: 'check', name: 'Check' },
          { id: 'compliment', name: 'Compliment', mercy: 40 },
          { id: 'xaction', name: 'X-Action', mercy: 35 },
        ],
      },
      { id: 'hathy', name: 'Hathy', acts: [{ id: 'flatter', name: 'Flatter', mercy: 50 }] },
    ],
    items: [{ id: 'darkburger', name: 'Darkburger', count: 2, heal: 70, target: 'party' }],
    turns: [{ id: 't1', attack: 'spade-rain' }, { id: 't2', attack: 'ring-burst' }, { id: 't3', attack: null }],
  };
}

function demoWith(choice, extra = {}) {
  return {
    text: { auto: true, delay: 0 },
    menuDelay: 0,
    turns: [{ turn: 1, choices: [choice] }],
    default: { choices: 'defend', fight: 'good' },
    ...extra,
  };
}

await test('按鈕層：游標在 fight，目標 act → right 再 confirm', () => {
  const state = menuState();
  const pilot = createEncounterPilot({
    demo: demoWith({ member: 'kris', command: 'act', target: 'rudinn', option: 'Check' }),
    encounter: docForMenu(),
    menuDelay: 0,
  });
  deepEq(pilot.input(state, 0).press, ['right'], '第一步往右');
  state.menu.cursor = 1;
  deepEq(pilot.input(state, 1).press, ['confirm'], '第二步確認');
});

await test('按鈕層：defend 直接 confirm（不需清單）', () => {
  const state = menuState();
  state.menu.buttons = MENU_BUTTONS.map((id) => ({ id, enabled: id !== 'magic' && id !== 'item' }));
  state.menu.cursor = MENU_BUTTONS.indexOf('defend');
  const pilot = createEncounterPilot({
    demo: demoWith({ member: 'kris', command: 'defend' }),
    encounter: docForMenu(),
    menuDelay: 0,
  });
  deepEq(pilot.input(state, 0).press, ['confirm'], 'defend 直接確認');
});

await test('按鈕層：多步右移（fight → item 需 3 步）', () => {
  const state = menuState();
  const pilot = createEncounterPilot({
    demo: demoWith({ member: 'kris', command: 'item', target: 'kris', option: 'darkburger' }),
    encounter: docForMenu(),
    menuDelay: 0,
  });
  let moves = 0;
  for (let frame = 0; frame < 10 && moves < 3; frame += 1) {
    const out = pilot.input(state, frame);
    if (out.press.includes('confirm')) break;
    eq(out.press[0], 'right', `第 ${frame} 步應往右（實際 ${out.press.join(',')}）`);
    moves += 1;
    state.menu.cursor += 1;
  }
  eq(moves, 3, `fight → item 應為 3 步（實際 ${moves}）`);
});

await test('清單層：敵人清單移動到目標再確認', () => {
  const state = menuState();
  state.menu.cursor = 1;
  state.menu.buttons[1] = { id: 'act', enabled: true };
  state.menu.list = {
    kind: 'enemy',
    title: '敌人',
    items: [
      { label: 'Rudinn', sub: '120/120', enabled: true, enemyId: 'rudinn' },
      { label: 'Hathy', sub: '80/80', enabled: true, enemyId: 'hathy' },
    ],
    cursor: 0,
    page: 0,
  };
  const pilot = createEncounterPilot({
    demo: demoWith({ member: 'kris', command: 'act', target: 'hathy', option: 'flatter' }),
    encounter: docForMenu(),
    menuDelay: 0,
  });
  deepEq(pilot.input(state, 0).press, ['down'], '往下移到 Hathy');
  state.menu.list.cursor = 1;
  deepEq(pilot.input(state, 1).press, ['confirm'], '選 Hathy');
});

await test('清單層：ACT 清單多步（7 個 ACT 選最後一個）', () => {
  const acts = [];
  for (let i = 0; i < 7; i += 1) acts.push({ id: `act${i}`, name: `Act ${i}`, mercy: 5 });
  const doc = { ...docForMenu(), enemies: [{ id: 'rudinn', name: 'Rudinn', acts }] };
  const state = menuState();
  state.menu.cursor = 1;
  state.menu.list = {
    kind: 'act',
    title: 'ACT',
    items: acts.map((a) => ({ label: a.name, sub: '', enabled: true })),
    cursor: 0,
    page: 0,
  };
  const pilot = createEncounterPilot({
    demo: demoWith({ member: 'kris', command: 'act', target: 'rudinn', option: 'act6' }),
    encounter: doc,
    menuDelay: 0,
  });
  let cursor = 0;
  let pressedConfirm = false;
  let steps = 0;
  for (let frame = 0; frame < 20 && !pressedConfirm; frame += 1) {
    state.menu.list.cursor = cursor;
    const out = pilot.input(state, frame);
    if (out.press.includes('confirm')) {
      pressedConfirm = true;
      break;
    }
    const dir = out.press[0];
    ok(dir === 'down' || dir === 'up', `應為垂直移動（實際 ${out.press.join(',')}）`);
    // 清單可以環繞：走比較短的一邊，最後一樣會到目標
    cursor = dir === 'down' ? (cursor + 1) % acts.length : (cursor - 1 + acts.length) % acts.length;
    steps += 1;
  }
  ok(pressedConfirm, '最後應按 confirm');
  eq(cursor, 6, `應停在最後一項（實際 ${cursor}）`);
  ok(steps >= 1 && steps <= 3, `環繞下只需少量步數（實際 ${steps}）`);
});

await test('magic 清單 → 法術 → 敵人目標（三層）', () => {
  const state = menuState();
  state.menu.member = 2;
  state.menu.buttons = MENU_BUTTONS.map((id) => ({ id, enabled: true }));
  state.menu.cursor = 0;
  const pilot = createEncounterPilot({
    demo: demoWith({ member: 'ralsei', command: 'magic', option: 'pacify', target: 'hathy' }),
    encounter: docForMenu(),
    menuDelay: 0,
  });
  deepEq(pilot.input(state, 0).press, ['right'], '按鈕層往右');
  state.menu.cursor = 2;
  state.menu.list = {
    kind: 'magic',
    title: '法术',
    items: [{ label: 'Pacify', sub: 'TP 32', enabled: true, spellId: 'pacify' }],
    cursor: 0,
    page: 0,
  };
  deepEq(pilot.input(state, 1).press, ['confirm'], '選法術');
  state.menu.list = {
    kind: 'enemy',
    title: '敌人',
    items: [
      { label: 'Rudinn', sub: '120/120', enabled: true, enemyId: 'rudinn' },
      { label: 'Hathy', sub: '80/80', enabled: true, enemyId: 'hathy' },
    ],
    cursor: 0,
    page: 0,
  };
  deepEq(pilot.input(state, 2).press, ['down'], '選敵方目標往下到 Hathy');
  state.menu.list.cursor = 1;
  deepEq(pilot.input(state, 3).press, ['confirm'], '確認 Hathy');
});

await test('item 清單 → 隊員目標（多層 + 多步）', () => {
  const state = menuState();
  state.menu.buttons = MENU_BUTTONS.map((id) => ({ id, enabled: true }));
  const pilot = createEncounterPilot({
    demo: demoWith({ member: 'kris', command: 'item', option: 'darkburger', target: 'ralsei' }),
    encounter: docForMenu(),
    menuDelay: 0,
  });
  deepEq(pilot.input(state, 0).press, ['right'], '往右到 act');
  state.menu.cursor = 1;
  deepEq(pilot.input(state, 1).press, ['right'], '再往右到 magic');
  state.menu.cursor = 2;
  deepEq(pilot.input(state, 2).press, ['right'], '再往右到 item');
  state.menu.cursor = 3;
  state.menu.list = {
    kind: 'item',
    title: '道具',
    items: [{ label: 'Darkburger', sub: 'x2', enabled: true, itemIndex: 0, itemId: 'darkburger' }],
    cursor: 0,
    page: 0,
  };
  deepEq(pilot.input(state, 3).press, ['confirm'], '選道具');
  const partyItems = [
    { label: 'Kris', sub: '90/90', enabled: true, member: 0 },
    { label: 'Susie', sub: '110/110', enabled: true, member: 1 },
    { label: 'Ralsei', sub: '70/70', enabled: true, member: 2 },
  ];
  state.menu.list = { kind: 'party', title: '队伍', items: partyItems, cursor: 0, page: 0 };
  // 清單可環繞：往哪邊走都合法，只要最後停在 Ralsei（index 2）
  let listCursor = 0;
  let selected = false;
  for (let frame = 4; frame < 12 && !selected; frame += 1) {
    state.menu.list.cursor = listCursor;
    const out = pilot.input(state, frame);
    if (out.press.includes('confirm')) {
      selected = true;
      break;
    }
    const dir = out.press[0];
    ok(dir === 'down' || dir === 'up', `應為垂直移動（實際 ${out.press.join(',')}）`);
    listCursor = dir === 'down'
      ? (listCursor + 1) % partyItems.length
      : (listCursor - 1 + partyItems.length) % partyItems.length;
  }
  ok(selected, '最後應按 confirm');
  eq(listCursor, 2, `應停在 Ralsei（實際 ${listCursor}）`);
});

await test('選項不存在 → 記 warning 並退回（不丟例外，同一則只記一次）', () => {
  const state = menuState();
  state.menu.cursor = 1;
  state.menu.list = {
    kind: 'act',
    title: 'ACT',
    items: [
      { label: 'Check', sub: '', enabled: true },
      { label: 'Compliment', sub: '', enabled: true },
    ],
    cursor: 0,
    page: 0,
  };
  const pilot = createEncounterPilot({
    demo: demoWith({ member: 'kris', command: 'act', target: 'rudinn', option: 'NoSuchAct' }),
    encounter: docForMenu(),
    menuDelay: 0,
  });
  const out = pilot.input(state, 0);
  ok(pilot.warnings.length > 0, '應該要有 warning');
  ok(pilot.warnings[0].includes('NoSuchAct'), `warning 應提到選項（實際：${pilot.warnings[0]}）`);
  ok(Array.isArray(out.press), '應回傳合法輸入');
  state.menu.list = null;
  state.menu.cursor = 0;
  pilot.input(state, 1);
  eq(pilot.warnings.length, 1, `同一則 warning 只記一次（實際 ${pilot.warnings.length}：${pilot.warnings.join(' / ')}）`);
});

await test('目標敵人不存在 → 記 warning 並退回 default（不丟例外）', () => {
  const state = menuState();
  state.enemies = [{ id: 'rudinn', hp: 120, maxHp: 120, mercy: 0, removed: false, name: 'Rudinn' }];
  state.menu.cursor = 0;
  state.menu.list = {
    kind: 'enemy',
    title: '敌人',
    items: [{ label: 'Rudinn', sub: '120/120', enabled: true, enemyId: 'rudinn' }],
    cursor: 0,
    page: 0,
  };
  const pilot = createEncounterPilot({
    demo: demoWith({ member: 'kris', command: 'fight', target: 'hathy' }),
    encounter: docForMenu(),
    menuDelay: 0,
  });
  pilot.input(state, 0);
  ok(pilot.warnings.length > 0, `應該要有 warning（實際：${pilot.warnings.join(' / ')}）`);
  ok(
    pilot.warnings.some((w) => w.includes('hathy') || w.includes('Hathy')),
    `warning 應提到目標（實際：${pilot.warnings.join(' / ')}）`,
  );
});

await test('menuDelay=6：每一步之間間隔 6 幀（同一幀不連按）', () => {
  const state = menuState();
  const pilot = createEncounterPilot({
    demo: demoWith({ member: 'kris', command: 'item', target: 'kris', option: 'darkburger' }),
    encounter: docForMenu(),
    menuDelay: 6,
  });
  const presses = [];
  for (let frame = 0; frame < 40; frame += 1) {
    const out = pilot.input(state, frame);
    if (out.press.length > 0) presses.push(frame);
    if (out.press.includes('right') || out.press.includes('confirm')) {
      // 模擬引擎的反應：按 right 就把游標往右移（最多到 item 索引 3）
      if (out.press.includes('right')) state.menu.cursor = Math.min(3, state.menu.cursor + 1);
    }
    if (presses.length >= 4) break;
  }
  ok(presses.length >= 2, `應該有多步按鍵（實際 ${presses.join(',')}）`);
  for (let i = 1; i < presses.length; i += 1) {
    const gap = presses[i] - presses[i - 1];
    ok(gap >= 6, `第 ${i} 次按鍵間隔應 >= 6 幀（實際 ${gap}）`);
  }
});

await test('卡住脫困：同一狀態超過上限 → 按 confirm/cancel + warning', () => {
  const pilot = createEncounterPilot({ demo: {}, menuDelay: 0, stallSeconds: 2 });
  const state = { phase: 'resolve', turn: 0, party: [], enemies: [], textbox: null, bubbles: [], menu: null, fight: null };
  let pressed = null;
  let pressedAt = -1;
  for (let frame = 0; frame < 200; frame += 1) {
    const out = pilot.input(state, frame);
    if (out.press.length > 0) {
      pressed = out.press;
      pressedAt = frame;
      break;
    }
  }
  ok(pressed !== null, '卡住時應該要按鍵脫困');
  ok(['confirm', 'cancel'].includes(pressed[0]), `脫困鍵應為 confirm / cancel（實際 ${pressed.join(',')}）`);
  eq(pressedAt, 60, `2 秒 = 60 幀後觸發（實際 ${pressedAt}）`);
  ok(pilot.warnings.length > 0, '應記一筆 warning');
});

await test('reset() 讓 pilot 可以重跑（同一實例）', () => {
  const state = menuState();
  const pilot = createEncounterPilot({
    demo: demoWith({ member: 'kris', command: 'act', target: 'rudinn', option: 'Nope' }),
    encounter: docForMenu(),
    menuDelay: 0,
  });
  state.menu.list = { kind: 'act', title: 'ACT', items: [{ label: 'Check', sub: '', enabled: true }], cursor: 0, page: 0 };
  state.menu.cursor = 1;
  pilot.input(state, 0);
  ok(pilot.warnings.length > 0, '第一次產生了 warning');
  pilot.reset();
  eq(pilot.warnings.length, 0, 'reset() 後清空');
  const out = pilot.input(menuState(), 0);
  deepEq(out.press, ['right'], '重設後從頭開始導航');
});

/* ======================================================== F. 躲避 */

group('F) 躲避轉交（dodgePilotFor）');

await test('進入彈幕回合時呼叫 dodgePilotFor(turn, attackDoc, dodge)，轉交 {dx,dy,slow}', () => {
  const calls = [];
  const attackDoc = { meta: { name: '黑桃雨' }, demo: { mode: 'path', path: [{ t: 0, x: 0, y: 0 }] } };
  const pilot = createEncounterPilot({
    demo: {
      turns: [{ turn: 1, dodge: 'path' }],
      default: { choices: 'defend', dodge: 'bot' },
    },
    encounter: docForMenu(),
    menuDelay: 0,
    dodgePilotFor: (turn, doc, dodge) => {
      calls.push({ turn, doc, dodge });
      return { decide: () => ({ dx: 1, dy: -1, slow: true }) };
    },
  });
  const state = {
    phase: 'attack',
    turn: 0,
    battle: { frame: 5, box: {}, soul: { x: 0, y: 0 }, bullets: [] },
    attack: attackDoc,
    party: [],
    enemies: [],
    textbox: null,
    bubbles: [],
  };
  const out = pilot.input(state, 0);
  eq(calls.length, 1, '應呼叫一次 dodgePilotFor');
  eq(calls[0].turn, 1, 'turn 應為 1 起算');
  eq(calls[0].doc, attackDoc, 'attackDoc 應為目前跑著的攻擊檔物件（SPEC §3）');
  eq(calls[0].dodge, 'path', 'dodge 應取自該回合設定');
  eq(pilot.describe().attack, '黑桃雨', 'describe().attack 為攻擊顯示名');
  eq(out.hold.right, true, 'dx=1 → hold.right');
  eq(out.hold.up, true, 'dy=-1 → hold.up');
  eq(out.hold.slow, true, 'slow 轉交');
  pilot.input({ ...state, battle: { ...state.battle, frame: 6 } }, 1);
  eq(calls.length, 1, '同一回合只建立一次');
  pilot.input({ ...state, turn: 1, battle: { ...state.battle, frame: 7 } }, 2);
  eq(calls.length, 2, '換回合重建駕駛');
});

await test('沒有 state.attack 時用遭遇檔的回合 attack（resolveAttackDoc 解析成檔案）', () => {
  const calls = [];
  const resolved = { meta: { name: '環形彈幕' }, demo: { mode: 'path', path: [] } };
  const pilot = createEncounterPilot({
    demo: { turns: [{ turn: 2, dodge: 'path' }] },
    encounter: docForMenu(),
    menuDelay: 0,
    resolveAttackDoc: (name) => (name === 'ring-burst' ? resolved : null),
    dodgePilotFor: (turn, doc, dodge) => {
      calls.push({ turn, doc, dodge });
      return { decide: () => ({ dx: 0, dy: 0 }) };
    },
  });
  pilot.input({ phase: 'attack', turn: 1, battle: { frame: 1 }, attack: null, party: [], enemies: [] }, 0);
  eq(calls.length, 1, '應建立駕駛');
  eq(calls[0].doc, resolved, '應用 resolveAttackDoc 解析回合攻擊檔');
});

await test('內嵌攻擊（沒有檔案）也交給躲避駕駛，attackDoc 帶 meta.name', () => {
  const calls = [];
  const attackDoc = { meta: { name: '内嵌小弹幕' }, settings: { duration: 2.5 } };
  const pilot = createEncounterPilot({
    demo: { turns: [{ turn: 2, dodge: 'bot' }] },
    encounter: docForMenu(),
    menuDelay: 0,
    resolveAttackDoc: () => null,
    dodgePilotFor: (turn, doc, dodge) => {
      calls.push({ turn, doc, dodge });
      return { decide: () => ({ dx: 0, dy: 1 }) };
    },
  });
  const out = pilot.input(
    {
      phase: 'attack',
      turn: 1,
      battle: { frame: 3 },
      attack: attackDoc,
      party: [],
      enemies: [],
      textbox: null,
      bubbles: [],
    },
    0,
  );
  eq(calls[0].doc, attackDoc, '內嵌攻擊直接給物件');
  eq(calls[0].doc.meta.name, '内嵌小弹幕', '內嵌攻擊用 meta.name');
  eq(out.hold.down, true, 'dy=1 → hold.down');
});

await test('躲避駕駛丟例外 → 記 warning，不丟出 pilot', () => {
  const pilot = createEncounterPilot({
    demo: { default: { dodge: 'bot' } },
    menuDelay: 0,
    dodgePilotFor: () => {
      throw new Error('boom');
    },
  });
  const out = pilot.input({ phase: 'attack', turn: 0, battle: { frame: 1 }, attack: null, party: [], enemies: [] }, 0);
  deepEq(out.press, [], '失敗時不按鍵');
  ok(pilot.warnings.some((w) => w.includes('boom')), `應記 warning（實際 ${pilot.warnings.join(' / ')}）`);
});

await test('躲避駕駛回傳 {press,hold} 也接受（input(state, frame) 形式）', () => {
  const pilot = createEncounterPilot({
    demo: { default: { dodge: 'bot' } },
    menuDelay: 0,
    dodgePilotFor: () => ({ input: () => ({ press: ['slow'], hold: { left: true } }) }),
  });
  const out = pilot.input({ phase: 'attack', turn: 0, battle: { frame: 2 }, attack: null, party: [], enemies: [] }, 0);
  eq(out.hold.left, true, 'hold.left 轉交');
  deepEq(out.press, ['slow'], 'press 轉交');
});

await test('restart 同一回合（重生 / 重試）不會無限重建駕駛', () => {
  let builds = 0;
  const pilot = createEncounterPilot({
    demo: { default: { dodge: 'bot' } },
    menuDelay: 0,
    dodgePilotFor: () => {
      builds += 1;
      return { decide: () => ({ dx: 0, dy: 0 }) };
    },
  });
  const base = { phase: 'attack', turn: 0, attack: null, party: [], enemies: [] };
  for (let frame = 0; frame < 30; frame += 1) {
    pilot.input({ ...base, battle: { frame } }, frame);
  }
  eq(builds, 1, `同一回合只建立一次駕駛（實際 ${builds}）`);
});

/* ==================================================== G. 範例整合 */

group('G) 範例 demo 端到端（SPEC §5）');

/** 讀 demo 的某回合某隊員的選擇 */
function choiceOf(demo, turn, member) {
  const entry = (demo.turns || []).find((t) => Number(t.turn) === Number(turn));
  if (!entry) return null;
  return (entry.choices || []).find((c) => c && c.member === member) || null;
}

await test('rudinn.json：demo 走 ACT → spare 饒恕路線，跑到 spared（menuDelay 0）', async () => {
  const doc = cloneDoc(rudinnDoc);
  const record = await playEncounter({ doc, menuDelay: 0 });

  deepEq(record.loadErrors, [], '載入不該有錯誤');
  deepEq(record.runtimeErrors, [], '執行期不該有錯誤');
  deepEq(record.warnings, [], 'warnings 應為空');
  eq(record.result, 'spared', `應走饒恕結局（實際 ${record.result}，frame ${record.frames}）`);
  ok(record.frames < 2500, `應在合理幀數內結束（實際 ${record.frames}）`);

  // demo 指定的 ACT 真的被執行：Compliment 會 set var.praised，X-Action 依 praised 追加 mercy
  eq(record.vars.praised, 2, `Compliment 應該執行兩次（var.praised，實際 ${record.vars.praised}）`);
  const rudinn = record.enemies.find((e) => e.id === 'rudinn');
  ok(rudinn, '應有 rudinn');
  eq(rudinn.removed, true, 'rudinn 應被移除（饒恕成功）');
  eq(rudinn.mercy, 100, `mercy 應滿（實際 ${rudinn.mercy}）`);
  ok(record.seen.maxMercy.includes('100'), `選單時應看到 mercy 100（實際 ${record.seen.maxMercy.join(' | ')}）`);

  // 有經過彈幕回合（躲避駕駛被呼叫；第 2 個參數是攻擊檔物件，名稱在 meta.name）
  ok(record.dodgeCalls.length > 0, '應有呼叫躲避駕駛');
  eq(record.dodgeCalls[0].attackName, '黑桃雨', `第 1 回合攻擊（實際 ${record.dodgeCalls[0].attackName}）`);
  ok(record.dodgeCalls[0].attackDoc, '應傳入解析後的攻擊檔物件（供 AP1 讀 demo 設定）');
  ok(record.seen.battleFrames > 0, '應有彈幕幀');
  note(`rudinn：${record.frames} 幀，結局 ${record.result}，躲避呼叫 ${record.dodgeCalls.map((c) => c.attackName).join(' / ')}`);
});

await test('rudinn.json：menuDelay=6 也能走到 spared（只是比較慢）', async () => {
  const doc = cloneDoc(rudinnDoc);
  const slow = await playEncounter({ doc, menuDelay: 6 });
  eq(slow.result, 'spared', `應走饒恕結局（實際 ${slow.result}，frame ${slow.frames}）`);
  deepEq(slow.warnings, [], 'warnings 應為空');
  deepEq(slow.runtimeErrors, [], '執行期不該有錯誤');
  const fast = await playEncounter({ doc: cloneDoc(rudinnDoc), menuDelay: 0 });
  ok(slow.frames > fast.frames, `menuDelay=6 應比 0 慢（${slow.frames} vs ${fast.frames}）`);
  note(`rudinn：menuDelay 0 = ${fast.frames} 幀、6 = ${slow.frames} 幀`);
});

await test('rudinn.json：demo 每一項選擇都真的被執行（var/mercy 對照）', async () => {
  const doc = cloneDoc(rudinnDoc);
  const record = await playEncounter({ doc, menuDelay: 0 });
  // turn 1：kris Compliment（+40 mercy）、susie X-Action（+35，且 praised>=1 再加 10）
  // turn 2：kris Compliment（+40，上限 100）
  // → 沒有一項沒生效（有的話 warnings 會非空）
  deepEq(record.warnings, [], '所有 demo 選擇都應成功');
  const mercySteps = record.seen.maxMercy;
  ok(mercySteps.length >= 2, `選單階段應看到 mercy 變化（${mercySteps.join(' | ')}）`);
  ok(mercySteps[mercySteps.length - 1].includes('100'), `最後應看到 mercy 100（${mercySteps.join(' | ')}）`);
});

await test('showcase.json：demo 混用 ACT / FIGHT / ITEM / MAGIC，跑到 victory', async () => {
  const doc = cloneDoc(showcaseDoc);
  const record = await playEncounter({ doc, menuDelay: 0 });

  deepEq(record.loadErrors, [], '載入不該有錯誤');
  deepEq(record.runtimeErrors, [], '執行期不該有錯誤');
  deepEq(record.warnings, [], `warnings 應為空（實際：${record.warnings.join(' / ')}）`);
  eq(record.result, 'victory', `應走勝利結局（實際 ${record.result}，frame ${record.frames}）`);
  ok(record.frames < 3000, `應在合理幀數內結束（實際 ${record.frames}）`);

  // demo 內容：turn1 kris ACT(flatter) / susie FIGHT / ralsei defend
  //           turn2 kris FIGHT / susie FIGHT / ralsei ITEM(darkburger→kris)
  //           turn3 kris FIGHT / susie FIGHT / ralsei MAGIC(pacify)
  const demo = doc.demo;
  eq(choiceOf(demo, 1, 'kris').command, 'act', 'turn1 kris = act');
  eq(choiceOf(demo, 2, 'ralsei').command, 'item', 'turn2 ralsei = item');
  eq(choiceOf(demo, 3, 'ralsei').command, 'magic', 'turn3 ralsei = magic');

  // FIGHT 打擊條真的被按到（perfect / good）
  ok(record.seen.fightResults.length > 0, '應有 FIGHT 判定結果');
  const perfects = record.seen.fightResults.filter((r) => r.endsWith(':perfect'));
  ok(perfects.length >= 3, `應有多個 perfect（實際 ${record.seen.fightResults.join(' / ')}）`);

  // ACT flatter（mercy +50）與 Pacify（mercy +25）真的生效 → hathy mercy >= 75
  const hathy = record.enemies.find((e) => e.id === 'hathy');
  ok(hathy, '應有 hathy');
  ok(hathy.mercy >= 75, `hathy mercy 應 >= 75（ACT 50 + 法術 25，實際 ${hathy.mercy}）`);

  // ITEM 造成 HP 回復（Ralsei 用 darkburger 治癒 Kris）→ 道具消耗
  const burger = record.items.find((it) => it.id === 'darkburger');
  ok(burger, '應有 darkburger');
  eq(burger.count, 2, `darkburger 應從 3 用到 2（實際 ${burger.count}）`);

  // 走過彈幕回合（sine-wave、內嵌攻擊、ring-burst；名稱取攻擊檔 meta.name）
  const names = record.dodgeCalls.map((c) => c.attackName);
  ok(names.includes('正弦波彈'), `應打過 sine-wave（實際 ${names.join(' / ')}）`);
  ok(names.includes('内嵌小弹幕'), `應打過內嵌攻擊（實際 ${names.join(' / ')}）`);
  const inlineCall = record.dodgeCalls.find((c) => c.attackName === '内嵌小弹幕');
  ok(inlineCall && inlineCall.attackDoc, '內嵌攻擊也應把攻擊物件交給躲避駕駛');
  note(`showcase：${record.frames} 幀，結局 ${record.result}，躲避 ${names.join(' / ')}`);
});

await test('showcase.json：menuDelay=6 也能走到 victory', async () => {
  const doc = cloneDoc(showcaseDoc);
  const slow = await playEncounter({ doc, menuDelay: 6 });
  eq(slow.result, 'victory', `應走勝利結局（實際 ${slow.result}，frame ${slow.frames}）`);
  deepEq(slow.warnings, [], 'warnings 應為空');
  deepEq(slow.runtimeErrors, [], '執行期不該有錯誤');
});

await test('決定性：同一份 demo 跑兩次，結果 / 幀數 / 隊伍 HP / vars 完全相同', async () => {
  for (const [name, base] of [
    ['rudinn', rudinnDoc],
    ['showcase', showcaseDoc],
  ]) {
    for (const menuDelay of [0, 6]) {
      const a = await playEncounter({ doc: cloneDoc(base), menuDelay });
      const b = await playEncounter({ doc: cloneDoc(base), menuDelay });
      eq(a.result, b.result, `${name} menuDelay=${menuDelay}：result`);
      eq(a.frames, b.frames, `${name} menuDelay=${menuDelay}：frames`);
      deepEq(a.party, b.party, `${name} menuDelay=${menuDelay}：party`);
      deepEq(a.vars, b.vars, `${name} menuDelay=${menuDelay}：vars`);
      deepEq(a.enemies, b.enemies, `${name} menuDelay=${menuDelay}：enemies`);
      deepEq(a.warnings, b.warnings, `${name} menuDelay=${menuDelay}：warnings`);
    }
  }
});

await test('demo 對引擎 inert：拿掉 demo 後引擎行為照舊（不影響載入與驗證）', async () => {
  const doc = cloneDoc(rudinnDoc);
  delete doc.demo;
  const errors = schema.validateEncounter(doc);
  deepEq(errors, [], '沒有 demo 也應通過驗證');
  const enc = makeEncounter();
  const loadResult = await enc.load(doc);
  deepEq(loadResult.errors, [], '沒有 demo 也應載入成功');
  enc.destroy();
});

await test('找不到選項時永不卡死：強制壞 demo 也能走到終局（有 warning）', async () => {
  const doc = cloneDoc(rudinnDoc);
  doc.demo = {
    text: { auto: true, delay: 0 },
    menuDelay: 0,
    turns: [
      {
        turn: 1,
        choices: [
          { member: 'kris', command: 'act', target: 'rudinn', option: 'NoSuchAct' },
          { member: 'susie', command: 'magic', target: 'rudinn', option: 'nope' },
          { member: 'ralsei', command: 'item', option: 'nope', target: 'kris' },
        ],
        fight: 'perfect',
        dodge: 'path',
      },
    ],
    default: { choices: 'fight', fight: 'good', dodge: 'path' },
  };
  const record = await playEncounter({ doc, menuDelay: 0, maxFrames: 12000 });
  ok(record.result !== null, '即使 demo 全壞也要走到終局（不能卡死）');
  ok(record.warnings.length > 0, '應有 warnings 記錄 fallback');
  deepEq(record.runtimeErrors, [], '執行期不該丟錯');
  note(`壞 demo 仍完成：${record.result} @ ${record.frames} 幀，warnings ${record.warnings.length} 則`);
});

await test('輸出契約：只用引擎認得的按鍵名（包裝層原樣轉交就能用）', () => {
  // AP1 的 createAutopilot 會把 pilot 輸出丟給 toEngineInput / canonicalInput 正規化；
  // 這裡確認 pilot 只產生那兩層認得的東西，包裝層只要原樣轉交（不可只留 confirm/cancel）
  // 就能操作選單。
  const PRESS = ['confirm', 'cancel', 'menu', 'left', 'right', 'up', 'down'];
  const HOLD = ['left', 'right', 'up', 'down', 'slow'];
  const states = [
    menuState(),
    {
      ...menuState(),
      menu: {
        ...menuState().menu,
        cursor: 1,
        list: { kind: 'act', title: 'ACT', items: [{ label: 'Check', enabled: true }], cursor: 0, page: 0 },
      },
    },
    { phase: 'resolve', turn: 0, party: [], enemies: [], textbox: { lines: [''], visibleChars: 3, totalChars: 3, done: true }, bubbles: [] },
    { phase: 'attack', turn: 0, fight: { bars: [{ member: 0, x: 40, targetX: 40, result: null }] }, party: [], enemies: [], textbox: null, bubbles: [] },
    { phase: 'attack', turn: 0, battle: { frame: 1 }, attack: { meta: { name: 'x' } }, party: [], enemies: [], textbox: null, bubbles: [] },
  ];
  const pilot = createEncounterPilot({
    demo: demoWith({ member: 'kris', command: 'act', target: 'rudinn', option: 'Check' }),
    encounter: docForMenu(),
    menuDelay: 0,
    dodgePilotFor: () => ({ decide: () => ({ dx: 1, dy: -1, slow: true }) }),
  });
  for (const state of states) {
    for (let frame = 0; frame < 4; frame += 1) {
      const out = pilot.input(state, frame);
      ok(Array.isArray(out.press), 'press 必須是陣列');
      for (const key of out.press) ok(PRESS.includes(key), `未認得的按鍵 "${key}"`);
      for (const key of Object.keys(out.hold)) {
        ok(HOLD.includes(key), `未認得的 hold 鍵 "${key}"（值 ${out.hold[key]}）`);
      }
    }
  }
});

await test('包裝層原樣轉交（含方向鍵 press）時能一路玩到終局', async () => {
  // 模擬 AP1 createAutopilot().input 的轉交：只做 canonical 化，但保留方向鍵 press。
  const passThrough = (out) => ({
    press: (out.press || []).filter((k) => ['confirm', 'cancel', 'menu', 'left', 'right', 'up', 'down'].includes(k)),
    hold: { ...out.hold },
  });
  const doc = cloneDoc(rudinnDoc);
  const record = await playEncounter({ doc, menuDelay: 0, transformInput: passThrough });
  eq(record.result, 'spared', `包裝後仍應走到 spared（實際 ${record.result} @ ${record.frames}）`);
  deepEq(record.warnings, [], 'warnings 應為空');
  deepEq(record.runtimeErrors, [], '執行期不該有錯誤');
});

await test('清了 12 項的多頁清單：右鍵跨頁（不會走 12 步）', () => {
  const acts = [];
  for (let i = 0; i < 12; i += 1) acts.push({ id: `act${i}`, name: `Act ${i}`, mercy: 2 });
  const doc = { ...docForMenu(), enemies: [{ id: 'rudinn', name: 'Rudinn', acts }] };
  const state = menuState();
  state.menu.cursor = 1;
  state.menu.list = {
    kind: 'act',
    title: 'ACT',
    items: acts.map((a) => ({ label: a.name, sub: '', enabled: true })),
    cursor: 0,
    page: 0,
  };
  const pilot = createEncounterPilot({
    demo: demoWith({ member: 'kris', command: 'act', target: 'rudinn', option: 'act11' }),
    encounter: doc,
    menuDelay: 0,
  });
  let cursor = 0;
  let confirmAt = -1;
  for (let frame = 0; frame < 12 && confirmAt < 0; frame += 1) {
    state.menu.list.cursor = cursor;
    state.menu.list.page = Math.floor(cursor / 5);
    const out = pilot.input(state, frame);
    if (out.press.includes('confirm')) {
      confirmAt = frame;
      break;
    }
    // menu.js：left/right = ±PAGE_SIZE（夾在 0..n-1）
    if (out.press.includes('right')) cursor = Math.min(11, cursor + 5);
    else if (out.press.includes('left')) cursor = Math.max(0, cursor - 5);
    else if (out.press.includes('down')) cursor = (cursor + 1) % 12;
    else if (out.press.includes('up')) cursor = (cursor - 1 + 12) % 12;
    else throw new Error(`第 ${frame} 幀沒有可用的移動鍵`);
  }
  eq(cursor, 11, `應停在最後一項（實際 ${cursor}）`);
  ok(confirmAt >= 0, '最後應按 confirm');
  ok(confirmAt <= 4, `跨頁應在少數幾步內完成（實際 ${confirmAt} 步）`);
});

/* ============================================================== 統計 */

const elapsed = Date.now() - startTime;
console.log('');
console.log('────────────────────────────────────────────');
console.log(`通過 ${results.pass}・失敗 ${results.fail}・備註 ${results.notes}（${elapsed} ms）`);
if (results.fail > 0) {
  console.log('\n失敗清單：');
  for (const failure of failures) {
    console.log(`  ✘ [${failure.group}] ${failure.name}`);
    console.log(`    ${failure.message}`);
  }
  process.exitCode = 1;
  console.log('\n結果：失敗');
} else {
  console.log('結果：全部通過');
  process.exitCode = 0;
}
void okEq;
