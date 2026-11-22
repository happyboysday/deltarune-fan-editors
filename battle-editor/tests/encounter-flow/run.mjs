#!/usr/bin/env node
/**
 * tests/encounter-flow/run.mjs — FL（遭遇戰回合流程）測試
 *
 * 用**自己寫的 fake world / fake runner**（只實作 SPEC-P2 §4 列出的介面）驅動
 * engine/encounter/flow.js，驗證：
 *   - 完整一輪 menu → resolve(FIGHT) → enemyTalk → attack → turnEnd → 下一回合
 *   - X 回上一層 / 上一位
 *   - ACT 佔用隊員（跳過、mercy、act.text/cues、actCount）
 *   - SPARE 成功（onSpare / 移除 / 全饒恕 spared）與失敗旁白
 *   - FIGHT perfect / miss 傷害、onHurt、damageNumber、setAnim
 *   - ITEM 回復 HP、count 減 1、用完消失
 *   - DEFEND（TP +16、本回合受傷減半旗標）
 *   - 全滅 defeat、擊倒勝利 victory、逃跑 flee
 *   - turnOrder：sequential / loop-last / random
 *   - 決定性：同 seed 同輸入 → 同結果
 *
 * 執行：node tests/encounter-flow/run.mjs
 */

import { createFlow, FLOW_MESSAGES } from '../../engine/encounter/flow.js';
import { MENU_MESSAGES } from '../../engine/encounter/menu.js';
import { createRng } from '../../engine/rng.js';

/* ================================================================ 斷言 */

let pass = 0;
let fail = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    fail += 1;
    failures.push({ name, err });
    console.log(`  ✗ ${name}`);
    const detail = err && err.stack ? err.stack.split('\n').slice(0, 6).join('\n    ') : String(err);
    console.log(`    ${detail}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

function eq(actual, expected, msg) {
  if (actual !== expected) {
    throw new Error(`${msg || ''}：expected ${JSON.stringify(expected)}，實際 ${JSON.stringify(actual)}`);
  }
}

function assertPhaseOrder(trace, expected) {
  const phases = trace.phases;
  let from = -1;
  for (const want of expected) {
    const found = phases.indexOf(want, from + 1);
    if (found < 0) throw new Error(`階段順序缺少「${want}」；實際：${phases.join(' > ')}`);
    from = found;
  }
}

/* ============================================================ 測試資料 */

const DEFAULT_COMMANDS = ['fight', 'act', 'item', 'spare', 'defend'];

function makeMember(id, extra = {}) {
  return {
    id,
    actor: id,
    name: { zh: id, en: id },
    hp: 40,
    maxHp: 40,
    atk: 10,
    def: 0,
    magic: 0,
    color: '#ffffff',
    commands: DEFAULT_COMMANDS.slice(),
    spells: [],
    ...extra,
  };
}

function makeEnemy(id, extra = {}) {
  return {
    id,
    actor: id,
    name: { zh: id, en: id },
    hp: 120,
    maxHp: 120,
    atk: 5,
    def: 0,
    mercy: 0,
    spareAt: 100,
    tired: false,
    acts: [],
    onHurt: [],
    onSpare: [],
    onDefeat: [],
    ...extra,
  };
}

function makeTurn(extra = {}) {
  return { id: 't', flavor: '', talk: [], attack: null, start: [], end: [], ...extra };
}

function makeEncounter(options = {}) {
  const party = options.party || [makeMember('kris')];
  const enemies = options.enemies || [makeEnemy('rudinn')];
  return {
    settings: { seed: 1, bgm: null, background: null, introText: '', canFlee: false, ...(options.settings || {}) },
    party,
    enemies,
    items: options.items || [],
    turns: options.turns || [makeTurn()],
    turnOrder: options.turnOrder || 'loop-last',
    hooks: options.hooks || {},
    vars: options.vars || {},
  };
}

/* ======================================================= fake world §4 */

function cloneData(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function createFakeWorld(encounter, options = {}) {
  const log = {
    anims: [],
    numbers: [],
    attacks: [],
    texts: [],
    bubbles: [],
    clears: 0,
    alphas: [],
  };

  const party = (cloneData(encounter.party) || []).map((p, i) => ({
    ...p,
    index: i,
    x: 120 + i * 70,
    y: 230,
    defending: false,
    action: null,
    down: false,
  }));
  const enemies = (cloneData(encounter.enemies) || []).map((e, i) => ({
    ...e,
    x: 520,
    y: 150 + i * 70,
    removed: false,
    downed: false,
  }));
  const items = cloneData(encounter.items) || [];

  const actors = {
    get(id) {
      return (
        party.find((p) => (p.actor || p.id) === id) ||
        enemies.find((e) => (e.actor || e.id) === id) ||
        null
      );
    },
    setAnim(id, name) {
      log.anims.push([id, name]);
    },
    list() {
      return [...party.map((p) => p.actor || p.id), ...enemies.map((e) => e.actor || e.id)];
    },
  };

  function textHandle() {
    return { done: true, closed: false, confirm() {}, cancel() {}, revealAll() {} };
  }

  const text = {
    say(value) {
      log.texts.push(typeof value === 'string' ? value : (value && value.text) || '');
      return textHandle();
    },
    bubble(value) {
      log.bubbles.push({ ...(value || {}) });
      log.texts.push((value && value.text) || '');
      return textHandle();
    },
    clear() {
      log.clears += 1;
    },
    busy() {
      return false;
    },
    confirm() {
      return false;
    },
  };

  let attack = null;

  const world = {
    lang: options.lang || 'zh',
    party,
    enemies,
    items,
    vars: {},
    tp: options.tp !== undefined ? options.tp : 0,
    actors,
    text,
    log,
    /** §4：開始 Phase 1 彈幕攻擊 */
    startAttack(ref) {
      log.attacks.push(ref);
      attack = { done: false, elapsed: 0, frames: options.attackFrames || 6, ref };
      return attack;
    },
    damageNumber(x, y, value, color) {
      log.numbers.push({ x, y, text: String(value), color: color || null });
    },
    update() {
      if (!attack || attack.done) return;
      attack.elapsed += 1;
      if (attack.elapsed >= attack.frames) {
        attack.done = true;
        if (typeof options.onAttack === 'function') options.onAttack(world, attack.ref);
      }
    },
    snapshot() {
      return { party, enemies, items, tp: world.tp, vars: world.vars };
    },
  };

  return world;
}

/* ====================================================== fake runner §4 */

function createFakeRunner() {
  const log = { texts: [], bubbles: [], labels: [], cues: [], ends: 0 };
  const active = [];

  function flatten(cues, out) {
    for (const cue of cues) {
      if (!cue) continue;
      if (cue.cmd === 'parallel' && Array.isArray(cue.cues)) flatten(cue.cues, out);
      else out.push(cue);
    }
  }

  function run(cues, runOptions = {}) {
    const list = [];
    flatten(Array.isArray(cues) ? cues : [], list);
    const handle = { done: false, label: (runOptions && runOptions.label) || '', cues: list, idx: 0 };
    log.labels.push(handle.label);
    if (list.length === 0) {
      handle.done = true;
      return handle;
    }
    active.push(handle);
    return handle;
  }

  function update() {
    for (const handle of active) {
      if (handle.done) continue;
      const cue = handle.cues[handle.idx];
      handle.idx += 1;
      log.cues.push(cue);
      if (cue) {
        if (cue.cmd === 'say') log.texts.push(cue.text);
        else if (cue.cmd === 'bubble') {
          log.texts.push(cue.text);
          log.bubbles.push({ ...cue });
        } else if (cue.cmd === 'end') log.ends += 1;
      }
      if (handle.idx >= handle.cues.length) handle.done = true;
    }
  }

  return {
    run,
    update,
    busy() {
      return active.some((h) => !h.done);
    },
    clear() {
      active.length = 0;
    },
    log,
  };
}

/**
 * 與 createFakeRunner 相同介面，但 wait cue 會依 seconds × fps 幀延遲。
 * 用來驗證 onHurt 清單中 wait 之後的指令不會被下一階段打斷。
 */
function createTimedRunner(fps = 30) {
  const log = { texts: [], bubbles: [], labels: [], cues: [], ends: 0 };
  const active = [];

  function flatten(cues, out) {
    for (const cue of cues) {
      if (!cue) continue;
      if (cue.cmd === 'parallel' && Array.isArray(cue.cues)) flatten(cue.cues, out);
      else out.push(cue);
    }
  }

  function run(cues, runOptions = {}) {
    const list = [];
    flatten(Array.isArray(cues) ? cues : [], list);
    const handle = {
      done: false,
      label: (runOptions && runOptions.label) || '',
      cues: list,
      idx: 0,
      timer: 0,
    };
    log.labels.push(handle.label);
    if (list.length === 0) {
      handle.done = true;
      return handle;
    }
    active.push(handle);
    return handle;
  }

  function update() {
    for (const handle of active) {
      if (handle.done) continue;
      if (handle.timer > 0) {
        handle.timer -= 1;
        if (handle.timer === 0) {
          handle.idx += 1;
          if (handle.idx >= handle.cues.length) handle.done = true;
        }
        continue;
      }
      const cue = handle.cues[handle.idx];
      if (!cue) {
        handle.done = true;
        continue;
      }
      log.cues.push(cue);
      if (cue.cmd === 'say') log.texts.push(cue.text);
      else if (cue.cmd === 'bubble') {
        log.texts.push(cue.text);
        log.bubbles.push({ ...cue });
      } else if (cue.cmd === 'end') log.ends += 1;
      handle.timer = cue.cmd === 'wait' ? Math.max(1, Math.round((Number(cue.seconds) || 0) * fps)) : 1;
    }
  }

  return {
    run,
    update,
    busy() {
      return active.some((h) => !h.done);
    },
    clear() {
      active.length = 0;
    },
    log,
  };
}

/* ============================================================ 測試輔助 */

function makeInput(press = []) {
  const keys = Array.isArray(press) ? press.slice() : [press];
  return {
    press: keys,
    has(key) {
      return keys.includes(key);
    },
  };
}

function makeController(flow, world, runner) {
  const trace = { phases: [], ends: [] };
  flow.on('phase', (payload) => {
    trace.phases.push(payload && payload.phase !== undefined ? payload.phase : payload);
  });
  flow.on('end', (payload) => trace.ends.push(payload));

  function tick(press = []) {
    const input = makeInput(press);
    // 與 index.js 相同順序：world → runner → flow
    world.update(input);
    runner.update(input);
    flow.update(input);
    return flow.phase;
  }

  function runUntil(predicate, options = {}) {
    const max = options.max || 4000;
    for (let i = 0; i < max; i += 1) {
      if (predicate()) return i;
      tick(options.press ? options.press(flow, i) : []);
    }
    throw new Error(
      `等待逾時（phase=${flow.phase}, turn=${flow.turn}, result=${flow.result}）`,
    );
  }

  return { tick, runUntil, trace };
}

const MENU_PATHS = {
  fight: [{ kind: 'enemy', index: 0 }],
  spare: [{ kind: 'enemy', index: 0 }],
  act: [
    { kind: 'enemy', index: 0 },
    { kind: 'act', index: 0 },
  ],
  magic: [
    { kind: 'magic', index: 0 },
    { kind: 'enemy', index: 0 },
  ],
  item: [
    { kind: 'item', index: 0 },
    { kind: 'party', index: 0 },
  ],
  defend: [],
};

/**
 * 依計畫把整個選單選完。
 * plan：memberIndex → 指令字串，或 { command, lists:[{kind,index}, …] }
 */
function chooseMenus(ctrl, flow, plan, maxSteps = 600) {
  const listStep = new Map();
  for (let guard = 0; guard < maxSteps; guard += 1) {
    if (flow.phase !== 'menu') return;
    const snap = flow.snapshot();
    const mn = snap.menu;
    if (!mn) {
      ctrl.tick();
      continue;
    }
    const want = plan[mn.member];
    if (!want) throw new Error(`隊員 ${mn.member} 沒有選單計畫`);
    const command = typeof want === 'string' ? want : want.command;
    const lists = typeof want === 'string' ? MENU_PATHS[want] : want.lists || MENU_PATHS[want.command];
    const step = listStep.get(mn.member) || 0;

    if (!mn.list) {
      const idx = mn.buttons.findIndex((b) => b.id === command);
      if (idx < 0) throw new Error(`找不到按鈕 ${command}（${mn.buttons.map((b) => b.id).join(',')}）`);
      if (!mn.buttons[idx].enabled) throw new Error(`按鈕 ${command} 不可用`);
      if (mn.cursor < idx) {
        ctrl.tick('right');
        continue;
      }
      if (mn.cursor > idx) {
        ctrl.tick('left');
        continue;
      }
      ctrl.tick('confirm');
      continue;
    }

    const target = lists[step];
    if (!target) throw new Error(`清單 ${mn.list.kind} 超出計畫（member=${mn.member}）`);
    if (mn.list.kind !== target.kind) {
      throw new Error(`清單種類不符：${mn.list.kind} vs ${target.kind}`);
    }
    if (mn.list.cursor < target.index) {
      ctrl.tick('down');
      continue;
    }
    if (mn.list.cursor > target.index) {
      ctrl.tick('up');
      continue;
    }
    ctrl.tick('confirm');
    listStep.set(mn.member, step + 1);
  }
  throw new Error('選單驅動逾時');
}

/**
 * 打完 FIGHT 攻擊條。modeForBar(barIndex) → 'perfect' | 'miss'。
 */
function resolveFight(ctrl, flow, modeForBar = () => 'perfect', maxFrames = 3000) {
  for (let i = 0; i < maxFrames; i += 1) {
    if (flow.phase !== 'resolve') return;
    const snap = flow.snapshot();
    const fight = snap.fight;
    if (!fight) {
      ctrl.tick();
      continue;
    }
    const activeIdx = fight.bars.findIndex((b) => b.result === null);
    if (activeIdx < 0) {
      ctrl.tick();
      continue;
    }
    const bar = fight.bars[activeIdx];
    if (modeForBar(activeIdx) === 'perfect' && Math.abs(bar.x - bar.targetX) <= 10) {
      ctrl.tick('confirm');
      continue;
    }
    ctrl.tick();
  }
  throw new Error('FIGHT 攻擊條逾時');
}

/* ================================================================ 測試 */

console.log('FL 遭遇戰回合流程測試（fake world / fake runner）\n');

/* ---------------------------------------------------- 1. 完整一輪流程 */

test('完整一輪：menu → resolve(FIGHT) → enemyTalk → attack → turnEnd → 下一回合', () => {
  const enc = makeEncounter({
    party: [makeMember('kris')],
    enemies: [makeEnemy('e1', { hp: 999, maxHp: 999 })],
    turns: [
      makeTurn({
        id: 't0',
        flavor: '* 敵人擋住了去路。',
        talk: [{ actor: 'e1', text: '* 站住！' }],
        attack: 'spade-rain',
      }),
      makeTurn({ id: 't1' }),
    ],
    turnOrder: 'sequential',
    settings: { seed: 11 },
  });
  const world = createFakeWorld(enc);
  const runner = createFakeRunner();
  const flow = createFlow(world, runner, enc);
  const ctrl = makeController(flow, world, runner);

  flow.start();
  eq(flow.phase, 'menu', 'start 後應在 menu');
  eq(flow.turn, 0, '第一回合');
  assert(world.log.texts.includes('* 敵人擋住了去路。'), '選單應顯示 turn.flavor');

  // §5 menu 形狀
  const mn = flow.snapshot().menu;
  assert(mn && Array.isArray(mn.buttons) && typeof mn.cursor === 'number', 'menu 形狀');
  eq(mn.buttons[0].id, 'fight', '第一個按鈕 fight');
  eq(mn.list, null, '尚未開清單');

  chooseMenus(ctrl, flow, { 0: 'fight' });
  eq(flow.phase, 'resolve', '選完後進 resolve');

  resolveFight(ctrl, flow, () => 'perfect');
  ctrl.runUntil(() => flow.phase === 'enemyTalk', { max: 300 });
  ctrl.runUntil(() => flow.phase === 'attack', { max: 300 });
  eq(world.log.attacks.length, 1, 'startAttack 呼叫一次');
  eq(world.log.attacks[0], 'spade-rain', '攻擊檔 ref');

  ctrl.runUntil(() => flow.phase === 'menu' && flow.turn === 1, { max: 600 });
  eq(flow.turn, 1, '進入第二回合');
  const phases = ctrl.trace.phases;
  assertPhaseOrder(ctrl.trace, ['turnStart', 'menu', 'resolve', 'enemyTalk', 'attack', 'turnEnd', 'turnStart', 'menu']);
  assert(phases.filter((p) => p === 'menu').length >= 2, 'menu 出現兩次');
  // 傷害數字（fallback：fight.js 直接改 hp 並呼叫 damageNumber）
  assert(world.log.numbers.some((n) => n.text === '-30'), 'perfect 傷害 30');
  eq(world.enemies[0].hp, 969, '敵人 HP 扣 30');
  assert(world.log.anims.some((a) => a[0] === 'e1' && a[1] === 'hurt'), '敵人播 hurt');
});

/* ------------------------------------------------------ 2. X 回上一層 */

test('X 回上一層 / 上一位（清單取消、隊員取消重選）', () => {
  const enc = makeEncounter({
    party: [makeMember('kris'), makeMember('susie')],
    enemies: [makeEnemy('e1', { hp: 999, maxHp: 999 })],
    turnOrder: 'loop-last',
  });
  const world = createFakeWorld(enc);
  const runner = createFakeRunner();
  const flow = createFlow(world, runner, enc);
  const ctrl = makeController(flow, world, runner);
  flow.start();
  eq(flow.phase, 'menu');

  // 開清單後按 X → 回按鈕列（同一位隊員）
  ctrl.tick('confirm');
  eq(flow.snapshot().menu.list.kind, 'enemy', '開啟敵人清單');
  ctrl.tick('cancel');
  eq(flow.snapshot().menu.list, null, '取消清單');
  eq(flow.snapshot().menu.member, 0, '仍是第 0 位');

  // 選完第 0 位（fight）→ 到第 1 位
  ctrl.tick('confirm');
  ctrl.tick('confirm');
  eq(flow.snapshot().menu.member, 1, '輪到第 1 位');

  // 第 1 位按 X → 回第 0 位（清掉第 0 位的選擇）
  ctrl.tick('cancel');
  eq(flow.snapshot().menu.member, 0, '回到第 0 位');
  eq(flow.snapshot().menu.list, null, '清單已關');

  // 重新選第 0 位 → 第 1 位，完成選單
  ctrl.tick('confirm');
  ctrl.tick('confirm');
  eq(flow.snapshot().menu.member, 1, '再次輪到第 1 位');
  ctrl.tick('confirm');
  ctrl.tick('confirm');

  assert(flow.phase !== 'menu', '選單完成');
  eq(world.party[0].action, 'fight', '第 0 位 fight');
  eq(world.party[1].action, 'fight', '第 1 位 fight');
});

/* --------------------------------------------------- 3. ACT 佔用隊員 */

test('ACT：文字 + cues + mercy + 隊員佔用（跳過被佔用者）', () => {
  const act = {
    id: 'check',
    name: { zh: '檢查', en: 'Check' },
    text: '* 你檢查了敵人。',
    mercy: 40,
    party: ['kris', 'susie'],
    cues: [{ cmd: 'say', text: '* 敵人看起來很累。' }],
  };
  const enc = makeEncounter({
    party: [makeMember('kris', { commands: ['act', 'fight'] }), makeMember('susie', { commands: ['act', 'fight'] }), makeMember('ralsei', { commands: ['act', 'fight'] })],
    enemies: [makeEnemy('e1', { hp: 999, maxHp: 999, acts: [act, { id: 'solo', name: 'Solo', party: ['kris'] }] })],
    turns: [makeTurn({ attack: 'atk1' })],
    turnOrder: 'loop-last',
  });
  const world = createFakeWorld(enc);
  const runner = createFakeRunner();
  const flow = createFlow(world, runner, enc);
  const ctrl = makeController(flow, world, runner);
  flow.start();

  // 第 0 位：ACT → 敵人 → ACT 選擇
  ctrl.tick('confirm');
  ctrl.tick('confirm');
  const [team, solo] = flow.snapshot().menu.list.items;
  eq(team.label, '檢查', 'ACT 名稱不變');
  eq(team.member, 1, '頭像標記協作者 Susie，不是選單操作者 Kris');
  eq(solo.member, undefined, '只有操作者的 ACT 沒有協作者頭像');
  ctrl.tick('confirm');
  chooseMenus(ctrl, flow, { 2: 'fight' });
  eq(flow.phase, 'resolve', 'ACT 選完進 resolve');
  // 第 1 位被 ACT 佔用 → 選單應直接跳到第 2 位（上面的 plan 已驗證：沒有 member 1 的計畫也不會卡住）
  assert(runner.log.labels.includes('act:e1.check'), 'ACT 指令有執行');
  ctrl.runUntil(() => world.enemies[0].mercy === 40, { max: 100 });
  assert(runner.log.texts.includes('* 你檢查了敵人。'), 'ACT text 顯示');
  assert(runner.log.texts.includes('* 敵人看起來很累。'), 'ACT cues 執行');
  eq(world.vars.__act_e1_check, 1, 'actCount 記錄');

  // 打 FIGHT（第 2 位）
  resolveFight(ctrl, flow, () => 'perfect');
  ctrl.runUntil(() => flow.phase === 'attack', { max: 400 });
  // 此時回合尚未開始（action/defending 尚未被清）
  eq(world.party[0].action, 'act', '第 0 位 action=act');
  eq(world.party[1].action, 'act', '被佔用者 action=act');
  eq(world.party[2].action, 'fight', '第 2 位 action=fight');
  assert(
    world.log.anims.some((a) => a[0] === 'susie' && a[1] === 'act'),
    '被佔用隊員播 act 動畫',
  );
});

/* -------------------------------------------------- 4. SPARE 成功 / 失敗 */

test('SPARE 成功：onSpare/移除，全饒恕 → result=spared', () => {
  const enc = makeEncounter({
    party: [makeMember('kris')],
    enemies: [makeEnemy('e1', { hp: 120, mercy: 100, spareAt: 100 })],
    hooks: { spared: [{ cmd: 'say', text: '* 你饒恕了所有敵人。' }] },
    turnOrder: 'loop-last',
  });
  const world = createFakeWorld(enc);
  const runner = createFakeRunner();
  const flow = createFlow(world, runner, enc);
  const ctrl = makeController(flow, world, runner);
  flow.start();

  chooseMenus(ctrl, flow, { 0: 'spare' });
  ctrl.runUntil(() => flow.result !== null, { max: 400 });

  eq(flow.result, 'spared', '結果 spared');
  eq(flow.phase, 'spared', '終局 phase');
  eq(world.enemies[0].removed, true, '敵人被移除');
  assert(
    runner.log.texts.includes(FLOW_MESSAGES.zh.spareSuccess('e1')),
    '預設饒恕成功旁白',
  );
  assert(runner.log.texts.includes('* 你饒恕了所有敵人。'), 'hooks.spared 執行');
  assert(ctrl.trace.ends.length >= 1 && ctrl.trace.ends[0].result === 'spared', 'end 事件');
});

test('SPARE 失敗：mercy 不足 → 失敗旁白、敵人保留、下一回合', () => {
  const enc = makeEncounter({
    party: [makeMember('kris'), makeMember('susie')],
    enemies: [makeEnemy('e1', { hp: 120, mercy: 0, spareAt: 100 })],
    turnOrder: 'loop-last',
  });
  const world = createFakeWorld(enc);
  const runner = createFakeRunner();
  const flow = createFlow(world, runner, enc);
  const ctrl = makeController(flow, world, runner);
  flow.start();

  chooseMenus(ctrl, flow, { 0: 'defend', 1: 'spare' });
  eq(world.log.anims.filter(([, anim]) => anim === 'spare').map(([id]) => id).join(), 'susie',
    '失敗的饒恕也只讓操作者播 spare');
  ctrl.runUntil(() => runner.log.texts.includes(MENU_MESSAGES.zh.spareFail), { max: 200 });
  eq(world.enemies[0].removed, false, '敵人未被移除');
  ctrl.runUntil(() => flow.phase === 'menu', { max: 600 });
  eq(flow.turn, 0, 'loop-last 留在同一回合');
  eq(flow.result, null, '尚未結束');
});

/* ------------------------------------------- 5. FIGHT perfect / miss */

test('FIGHT：確認時同幀出手、判定與扣血；逾時不出手', () => {
  const enc = makeEncounter({
    party: [makeMember('susie'), makeMember('kris')],
    enemies: [makeEnemy('e1', { hp: 120, maxHp: 120, onHurt: [{ cmd: 'say', text: '* 可惡……' }] })],
    turnOrder: 'loop-last',
  });
  const world = createFakeWorld(enc);
  const runner = createFakeRunner();
  const flow = createFlow(world, runner, enc);
  const ctrl = makeController(flow, world, runner);
  flow.start();

  chooseMenus(ctrl, flow, { 0: 'fight', 1: 'fight' });
  const bar = (i) => flow.snapshot().fight.bars[i];
  ctrl.runUntil(() => bar(0).x <= 10);
  eq(bar(0).targetX, 1, '判定點固定在左緣');
  eq(bar(0).result, null, '移動中尚未判定');
  eq(world.enemies[0].hp, 120, '移動中未扣血');
  eq(world.log.anims.length, 0, '標記移動時未出手');

  ctrl.tick('confirm');
  eq(bar(0).result, 'perfect', '按下確認的同幀顯示判定');
  eq(world.enemies[0].hp, 90, '按下確認的同幀扣血');
  eq(world.log.numbers[0]?.text, '-30', '按下確認的同幀跳傷害數字');
  assert(world.log.anims.some(([id, anim]) => id === 'susie' && anim === 'attack'), '同幀 Susie 出手');

  ctrl.runUntil(() => bar(1).result !== null);
  eq(bar(1).result, 'miss', '第二條完全沒按 = miss');
  ctrl.runUntil(() => flow.phase !== 'resolve');
  eq(world.enemies[0].hp, 90, 'perfect 30 傷害、miss 0');
  eq(world.log.numbers.length, 1, '逾時不跳傷害數字');
  eq(world.log.anims.filter(([, anim]) => anim === 'attack').length, 1, '只在確認時出手一次');
  assert(runner.log.labels.includes('onHurt:e1'), '觸發 onHurt');
  assert(runner.log.texts.includes('* 可惡……'), 'onHurt 指令內容');
  assert(world.log.anims.some((a) => a[0] === 'e1' && a[1] === 'hurt'), 'hurt 動畫');
});

/* ----------------------------------- 5b. onHurt 掛鉤排隊（wait 不被打斷） */

test('FIGHT 命中：onHurt 的 wait 之後指令會跑完才進下一階段（多次命中依序排隊）', () => {
  const onHurt = [
    { cmd: 'say', text: '* 受傷一' },
    { cmd: 'wait', seconds: 1 },
    { cmd: 'say', text: '* 受傷二' },
  ];
  const enc = makeEncounter({
    party: [makeMember('kris'), makeMember('susie')],
    enemies: [makeEnemy('e1', { hp: 500, maxHp: 500, onHurt })],
    turnOrder: 'loop-last',
  });
  const world = createFakeWorld(enc);
  const runner = createTimedRunner();
  const flow = createFlow(world, runner, enc);
  const ctrl = makeController(flow, world, runner);
  flow.start();

  chooseMenus(ctrl, flow, { 0: 'fight', 1: 'fight' });
  eq(flow.phase, 'resolve', '選完 fight 後進 resolve');

  const countB = () => runner.log.texts.filter((t) => t === '* 受傷二').length;
  const phaseChanges = [];
  let previous = flow.phase;
  for (let i = 0; i < 3000; i += 1) {
    if (flow.phase !== previous) {
      phaseChanges.push({ from: previous, to: flow.phase, b: countB() });
      previous = flow.phase;
    }
    if (flow.phase !== 'resolve' && countB() >= 2) break;
    const fight = flow.snapshot().fight;
    const idx = fight ? fight.bars.findIndex((b) => b.result === null) : -1;
    if (idx >= 0 && Math.abs(fight.bars[idx].x - fight.bars[idx].targetX) <= 10) {
      ctrl.tick('confirm');
    } else {
      ctrl.tick();
    }
  }

  eq(countB(), 2, '兩次命中的 onHurt 都跑到 wait 之後的 say');
  eq(
    runner.log.texts.filter((t) => t === '* 受傷一' || t === '* 受傷二').join(','),
    '* 受傷一,* 受傷二,* 受傷一,* 受傷二',
    '多次命中依序排隊，wait 之後的指令不被跳過',
  );
  eq(
    runner.log.labels.filter((l) => l === 'onHurt:e1').length,
    2,
    '每次命中各排一條 onHurt',
  );
  const firstLeave = phaseChanges.find((c) => c.from === 'resolve');
  assert(firstLeave, '最後應離開 resolve');
  eq(firstLeave.b, 2, '離開 resolve 前 onHurt 清單已全部跑完');
});

/* ------------------------------------------------------------ 6. ITEM */

test('ITEM：回復 HP、顯示 text、count 減 1、用完消失', () => {
  const enc = makeEncounter({
    party: [makeMember('kris', { hp: 20, maxHp: 40, commands: ['item', 'fight'] })],
    enemies: [makeEnemy('e1', { hp: 999, maxHp: 999 })],
    items: [{ id: 'candy', name: { zh: '糖果', en: 'Candy' }, count: 1, heal: 20, target: 'party', text: '* 你吃了糖果。' }],
    turnOrder: 'loop-last',
  });
  const world = createFakeWorld(enc);
  const runner = createFakeRunner();
  const flow = createFlow(world, runner, enc);
  const ctrl = makeController(flow, world, runner);
  flow.start();

  chooseMenus(ctrl, flow, { 0: 'item' });
  ctrl.runUntil(() => world.party[0].hp === 40, { max: 200 });
  eq(world.party[0].hp, 40, '回復 20 HP');
  eq(world.items[0].count, 0, 'count 用完');
  ctrl.runUntil(() => runner.log.texts.includes('* 你吃了糖果。'), { max: 100 });
  assert(runner.log.texts.includes('* 你吃了糖果。'), 'item.text 顯示');
  assert(world.log.numbers.some((n) => n.text === '+20'), '回復數字 +20');

  ctrl.runUntil(() => flow.phase === 'menu', { max: 600 });
  const mn = flow.snapshot().menu;
  const itemButton = mn.buttons.find((b) => b.id === 'item');
  eq(itemButton.enabled, false, '道具用完後按鈕 disabled');
  assert(mn.list === null, '沒有殘留清單');
});

/* ------------------------------------------------------------- 7. MAGIC */

test('MAGIC：耗 TP、執行 spell.cues', () => {
  const enc = makeEncounter({
    party: [
      makeMember('ralsei', {
        commands: ['magic', 'fight'],
        spells: [{ id: 'pacify', name: { zh: '安撫', en: 'Pacify' }, tp: 32, target: 'enemy', cues: [{ cmd: 'say', text: '* 敵人冷靜下來。' }] }],
      }),
    ],
    enemies: [makeEnemy('e1', { hp: 999, maxHp: 999 })],
    turnOrder: 'loop-last',
  });
  const world = createFakeWorld(enc, { tp: 50 });
  const runner = createFakeRunner();
  const flow = createFlow(world, runner, enc);
  const ctrl = makeController(flow, world, runner);
  flow.start();

  chooseMenus(ctrl, flow, { 0: 'magic' });
  eq(flow.phase, 'resolve', '法術選完進 resolve');
  eq(world.tp, 18, 'TP 50 - 32 = 18');
  ctrl.runUntil(() => runner.log.texts.includes('* 敵人冷靜下來。'), { max: 200 });
  assert(runner.log.labels.includes('spell:pacify'), '執行 spell cues');
});

/* ------------------------------------------------------------ 8. DEFEND */

test('DEFEND：TP +16、本回合 defending、下一回合清除', () => {
  const enc = makeEncounter({
    party: [makeMember('kris', { commands: ['defend'] })],
    enemies: [makeEnemy('e1', { hp: 999, maxHp: 999 })],
    turns: [makeTurn({ talk: [{ actor: 'e1', text: '* 低吼。' }] })],
    turnOrder: 'loop-last',
  });
  const world = createFakeWorld(enc);
  const runner = createFakeRunner();
  const flow = createFlow(world, runner, enc);
  const ctrl = makeController(flow, world, runner);
  flow.start();

  chooseMenus(ctrl, flow, { 0: 'defend' });
  eq(flow.phase, 'enemyTalk', '防禦後進 enemyTalk（talk 尚未播完）');
  eq(world.party[0].defending, true, 'defending 旗標');
  eq(world.tp, 16, 'TP +16');

  ctrl.runUntil(() => flow.phase === 'menu', { max: 400 });
  eq(world.party[0].defending, false, '下一回合清除 defending');
  eq(world.tp, 16, 'TP 不會被重設');
});

/* ------------------------------------------------------- 9. 全滅 defeat */

test('全滅：全隊 HP ≤ 0 → result=defeat（含 hooks.defeat）', () => {
  const enc = makeEncounter({
    party: [makeMember('kris', { hp: 10, maxHp: 10 })],
    enemies: [makeEnemy('e1', { hp: 999, maxHp: 999 })],
    turns: [makeTurn({ attack: 'kill-all' })],
    hooks: { defeat: [{ cmd: 'say', text: '* 你倒下了……' }] },
    turnOrder: 'loop-last',
  });
  const world = createFakeWorld(enc, {
    attackFrames: 4,
    onAttack(w) {
      for (const p of w.party) p.hp = 0;
    },
  });
  const runner = createFakeRunner();
  const flow = createFlow(world, runner, enc);
  const ctrl = makeController(flow, world, runner);
  flow.start();

  chooseMenus(ctrl, flow, { 0: 'fight' });
  resolveFight(ctrl, flow, () => 'miss');
  ctrl.runUntil(() => flow.result !== null, { max: 800 });

  eq(flow.result, 'defeat', '結果 defeat');
  eq(flow.phase, 'defeat', '終局 phase defeat');
  assert(runner.log.texts.includes('* 你倒下了……'), 'hooks.defeat 執行');
});

/* ------------------------------------------------ 10. 擊倒 → victory */

test('擊倒敵人 → result=victory（onDefeat + 移除 + 淡出動畫）', () => {
  const enc = makeEncounter({
    party: [makeMember('kris')],
    enemies: [makeEnemy('e1', { hp: 30, maxHp: 30, onDefeat: [{ cmd: 'say', text: '* 敵人被打倒了。' }] })],
    hooks: { victory: [{ cmd: 'say', text: '* 你贏了！' }] },
    turnOrder: 'loop-last',
  });
  const world = createFakeWorld(enc);
  const runner = createFakeRunner();
  const flow = createFlow(world, runner, enc);
  const ctrl = makeController(flow, world, runner);
  flow.start();

  chooseMenus(ctrl, flow, { 0: 'fight' });
  resolveFight(ctrl, flow, () => 'perfect');
  ctrl.runUntil(() => flow.result !== null, { max: 800 });

  eq(flow.result, 'victory', '結果 victory');
  eq(world.enemies[0].removed, true, '敵人 removed');
  assert(runner.log.texts.includes('* 敵人被打倒了。'), 'onDefeat 執行');
  assert(world.log.anims.some((a) => a[0] === 'e1' && a[1] === 'defeat'), 'defeat 動畫');
  assert(runner.log.texts.includes('* 你贏了！'), 'hooks.victory 執行');
  eq(runner.log.texts.at(-1).en, '* YOU WON!', '擊倒也以底部勝利旁白收尾');
});

/* --------------------------------------------------------- 11. 逃跑 */

test('FLEE：canFlee 時第一位按 X → result=flee；canFlee=false 時不逃', () => {
  const mk = (canFlee) => {
    const enc = makeEncounter({
      party: [makeMember('kris')],
      enemies: [makeEnemy('e1', { hp: 999, maxHp: 999 })],
      settings: { canFlee },
      hooks: canFlee ? { flee: [{ cmd: 'say', text: '* 你逃跑了。' }] } : {},
      turnOrder: 'loop-last',
    });
    const world = createFakeWorld(enc);
    const runner = createFakeRunner();
    const flow = createFlow(world, runner, enc);
    const ctrl = makeController(flow, world, runner);
    flow.start();
    return { flow, ctrl, runner };
  };

  const no = mk(false);
  no.ctrl.tick('cancel');
  eq(no.flow.phase, 'menu', 'canFlee=false 時取消無效');
  eq(no.flow.result, null, '沒有逃跑');

  const yes = mk(true);
  yes.ctrl.tick('cancel');
  eq(yes.flow.phase, 'flee', 'phase flee');
  yes.ctrl.runUntil(() => yes.flow.result !== null, { max: 100 });
  eq(yes.flow.result, 'flee', 'canFlee=true 逃跑');
  assert(yes.runner.log.texts.includes('* 你逃跑了。'), 'hooks.flee 執行');
});

/* ------------------------------------------------- 12. turnOrder 三模式 */

function runTurnOrder(mode, seed, rounds = 6) {
  const enc = makeEncounter({
    party: [makeMember('kris', { commands: ['defend'] })],
    enemies: [makeEnemy('e1', { hp: 999, maxHp: 999 })],
    turns: [makeTurn({ id: 't0' }), makeTurn({ id: 't1' }), makeTurn({ id: 't2' })],
    turnOrder: mode,
    settings: { seed },
  });
  const world = createFakeWorld(enc);
  const runner = createFakeRunner();
  const flow = createFlow(world, runner, enc);
  const ctrl = makeController(flow, world, runner);
  flow.start();
  const turns = [flow.turn];
  for (let i = 0; i < rounds; i += 1) {
    eq(flow.phase, 'menu', `第 ${i} 輪應在 menu`);
    ctrl.tick('confirm'); // 只有 defend 一顆按鈕
    turns.push(flow.turn);
  }
  return turns;
}

function expectedRandomTurns(seed, rounds) {
  const rng = createRng(seed);
  const turns = [0];
  let current = 0;
  for (let i = 0; i < rounds; i += 1) {
    current = rng.int(0, 2);
    turns.push(current);
  }
  return turns;
}

test('turnOrder=sequential：0→1→2→0→1→2', () => {
  eq(JSON.stringify(runTurnOrder('sequential', 5)), JSON.stringify([0, 1, 2, 0, 1, 2, 0]));
});

test('turnOrder=loop-last：0→1→2→2→2→2', () => {
  eq(JSON.stringify(runTurnOrder('loop-last', 5)), JSON.stringify([0, 1, 2, 2, 2, 2, 2]));
});

test('turnOrder=random：與同 seed 的亂數流一致（決定性）', () => {
  eq(JSON.stringify(runTurnOrder('random', 12345)), JSON.stringify(expectedRandomTurns(12345, 6)));
});

/* ------------------------------------------------------------ 13. 決定性 */

function runDeterministic() {
  const enc = makeEncounter({
    party: [makeMember('kris'), makeMember('susie')],
    enemies: [makeEnemy('e1', { hp: 300, maxHp: 300 })],
    turns: [
      makeTurn({ id: 't0', talk: [{ actor: 'e1', text: '* 來吧！' }], attack: 'atk1' }),
      makeTurn({ id: 't1', talk: [], attack: 'atk2' }),
    ],
    turnOrder: 'random',
    settings: { seed: 424242 },
  });
  const world = createFakeWorld(enc, { attackFrames: 4 });
  const runner = createFakeRunner();
  const flow = createFlow(world, runner, enc);
  const ctrl = makeController(flow, world, runner);
  flow.start();

  const checkpoints = [];
  for (let frame = 0; frame < 6000 && flow.result === null; frame += 1) {
    let press = [];
    if (flow.phase === 'menu') {
      const mn = flow.snapshot().menu;
      if (mn) press = ['confirm'];
    } else if (flow.phase === 'resolve') {
      const f = flow.snapshot().fight;
      if (f) {
        const bar = f.bars.find((b) => b.result === null);
        if (bar && Math.abs(bar.x - bar.targetX) <= 10) press = ['confirm'];
      }
    }
    ctrl.tick(press);
    if (frame % 37 === 0 || flow.result !== null) {
      checkpoints.push({
        frame,
        phase: flow.phase,
        turn: flow.turn,
        enemyHp: world.enemies[0].hp,
        tp: world.tp,
        partyHp: world.party.map((p) => p.hp),
      });
    }
  }

  return {
    result: flow.result,
    phase: flow.phase,
    phases: ctrl.trace.phases,
    ends: ctrl.trace.ends,
    numbers: world.log.numbers,
    anims: world.log.anims,
    attacks: world.log.attacks,
    texts: runner.log.texts,
    checkpoints,
    enemyHp: world.enemies[0].hp,
    tp: world.tp,
  };
}

test('決定性：同 seed 同輸入 → 完全相同（含 phase/傷害/HP/回合）', () => {
  const a = runDeterministic();
  const b = runDeterministic();
  eq(a.result, b.result, 'result 一致');
  eq(JSON.stringify(a), JSON.stringify(b), '完整執行軌跡一致');
  assert(a.result !== null, '有跑到終局');
});

/* ================================================================ 結果 */

console.log(`\n${pass}/${pass + fail} 通過`);
if (fail > 0) {
  console.log('\n失敗明細：');
  for (const f of failures) console.log(` - ${f.name}`);
  process.exit(1);
}
console.log('全部通過 ✅');
