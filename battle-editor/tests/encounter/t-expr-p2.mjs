/**
 * tests/encounter/t-expr-p2.mjs — 表達式白名單擴充（SPEC-P2 §3）
 *
 * 驗證：
 *   1. `turn`、`tp` 變數可用。
 *   2. `var mercy hp maxHp alive actCount` 可接任意識別字屬性，求值時查表。
 *   3. 查不到 → 0（不崩潰、不報錯）。
 *   4. 其餘白名單規則不變（字串、方括號、賦值、原型鏈仍然全拒）。
 *   5. 原本 Phase 1 的攻擊表達式完全不受影響。
 */

import { group, test, eq, ok, notOk, approx, deepEq } from '../engine/harness.mjs';
import {
  evalNumber,
  makeContext,
  createHelpers,
  createLookup,
  lookupFrom,
  EMPTY_LOOKUPS,
  LOOKUP_NAMES,
  VAR_NAMES,
  validateExprSyntax,
} from '../../engine/expr.js';
import { createRng } from '../../engine/rng.js';

const rng = createRng(1);
const helpers = createHelpers(rng, () => ({ x: 320, y: 240 }));

/** 建立帶查表的 context */
function ctxWith(lookups, extra = {}) {
  return makeContext({ box: { x: 320, y: 240, w: 100, h: 100 }, soul: { x: 320, y: 240 }, lookups, ...extra });
}

/** 用一組固定查表值求值 */
function val(src, extra = {}) {
  const lookups = {
    mercy: lookupFrom({ rudinn: 50 }),
    hp: lookupFrom({ kris: 60 }),
    maxHp: lookupFrom({ kris: 90 }),
    alive: lookupFrom({ kris: 1, rudinn: 0 }),
    actCount: lookupFrom({ rudinn_compliment: 2 }),
    vars: lookupFrom({ complimented: 3 }),
  };
  const r = evalNumber(src, ctxWith(lookups, extra), helpers, lookups);
  return r.value;
}

/** 求值並回傳完整結果（檢查 error） */
function raw(src, lookups) {
  optsLookups = lookups;
  return evalNumber(src, ctxWith(lookups), helpers, lookups);
}

let optsLookups = EMPTY_LOOKUPS;

group('表達式 P2：turn / tp');

test('turn 為目前回合索引', () => {
  eq(val('turn'), 0, '預設 0');
  eq(val('turn', { turn: 3 }), 3, '可指定');
  eq(val('turn * 2 + 1', { turn: 2 }), 5, '可參與運算');
});

test('tp 為目前 TP', () => {
  eq(val('tp'), 0, '預設 0');
  eq(val('tp', { tp: 42 }), 42, '可指定');
  eq(val('tp / 100', { tp: 50 }), 0.5, '可參與運算');
});

test('turn / tp 在 VAR_NAMES 中（驗證器與求值共享同一份清單）', () => {
  ok(VAR_NAMES.includes('turn'), 'VAR_NAMES 含 turn');
  ok(VAR_NAMES.includes('tp'), 'VAR_NAMES 含 tp');
});

group('表達式 P2：查表物件');

test('mercy / hp / maxHp / alive / actCount 可查表', () => {
  eq(val('mercy.rudinn'), 50, 'mercy.rudinn');
  eq(val('hp.kris'), 60, 'hp.kris');
  eq(val('maxHp.kris'), 90, 'maxHp.kris');
  eq(val('alive.kris'), 1, 'alive.kris');
  eq(val('alive.rudinn'), 0, 'alive.rudinn');
  eq(val('actCount.rudinn_compliment'), 2, 'actCount 複合 key');
});

test('查不到的名字回 0，不報錯', () => {
  for (const src of ['mercy.nobody', 'hp.nobody', 'maxHp.ghost', 'alive.ghost', 'actCount.never']) {
    const r = raw(src, {
      mercy: lookupFrom({ rudinn: 50 }),
      hp: lookupFrom({ kris: 60 }),
      maxHp: lookupFrom({}),
      alive: lookupFrom({}),
      actCount: lookupFrom({}),
      vars: lookupFrom({}),
    });
    eq(r.value, 0, `${src} → 0`);
    eq(r.error, null, `${src} 不該報錯`);
  }
});

test('var.xxx 可用（編譯前改寫成 vars，因為 var 是保留字）', () => {
  eq(val('var.complimented'), 3, 'var.complimented');
  eq(val('var.complimented + 1'), 4, '可參與運算');
  eq(val('var.unknown'), 0, '未知變數 → 0');
  eq(validateExprSyntax('var.complimented > 0'), null, '詞法層接受 var.xxx');
});

test('查表值可組合比較與算術', () => {
  eq(val('mercy.rudinn >= 50 ? 1 : 0'), 1, '三元 + 比較');
  eq(val('maxHp.kris - hp.kris'), 30, '相減');
  eq(val('alive.rudinn && hp.kris > 0 ? 1 : 0'), 0, '邏輯運算');
  eq(val('floor(mercy.rudinn / 10)'), 5, '函式搭配');
});

test('createLookup 的物件拿不到原型鏈上的東西', () => {
  const lk = createLookup(() => 0);
  eq(lk.constructor, 0, 'constructor → 0（不是 function）');
  eq(lk.__proto__, 0, '__proto__ → 0');
  eq(lk.toString, 0, 'toString → 0');
  eq(lk.hasOwnProperty, 0, 'hasOwnProperty → 0');
});

test('createLookup 寫入無效（唯讀）', () => {
  const lk = createLookup(() => 5);
  lk.anything = 99;
  eq(lk.anything, 5, '寫入不生效');
});

group('表達式 P2：沙箱規則不變');

test('字串 / 方括號 / 大括號 / 賦值仍然全拒', () => {
  const bad = [
    '"hello"',
    "'x'",
    'mercy["rudinn"]',
    '{a:1}',
    'x = 1',
    'var.complimented = 5',
    'a; b',
    '() => 1',
  ];
  for (const src of bad) {
    const r = raw(src, EMPTY_LOOKUPS);
    eq(r.value, 0, `"${src}" → 0`);
    ok(r.error, `"${src}" 應報錯`);
  }
});

test('原型鏈逃逸仍然全拒（第二層防線不受影響）', () => {
  const attacks = [
    '(0).constructor.constructor("globalThis.PWNED=1; return 7")()',
    'mercy.constructor.constructor("return 1")()',
    'var.constructor',
    'hp.__proto__',
    'maxHp.constructor',
    'alive.prototype',
    'actCount.toString',
    '[].constructor',
    'this',
    'globalThis',
    'window',
    'Function("return 1")()',
  ];
  for (const src of attacks) {
    const r = raw(src, EMPTY_LOOKUPS);
    eq(r.value, 0, `"${src}" → 0`);
    ok(r.error, `"${src}" 應被拒絕`);
  }
  eq(typeof globalThis.PWNED, 'undefined', '全域未被污染');
});

test('查表前綴後面必須接屬性名', () => {
  for (const src of ['mercy', 'hp', 'alive', 'actCount', 'var']) {
    const err = validateExprSyntax(src);
    ok(typeof err === 'string', `單獨使用 ${src} 應被拒絕`);
  }
});

test('查表屬性禁止多層串接', () => {
  ok(typeof validateExprSyntax('mercy.rudinn.x') === 'string', 'mercy.x.y 拒絕');
  ok(typeof validateExprSyntax('var.a.b') === 'string', 'var.a.b 拒絕');
});

test('原有白名單識別字仍然禁止屬性存取', () => {
  for (const src of ['rand.constructor', 'sin.length', 'PI.toString', 't.x', 'box.x.y']) {
    ok(typeof validateExprSyntax(src) === 'string', `${src} 應被拒絕`);
  }
});

group('表達式 P2：Phase 1 攻擊表達式不受影響');

test('樣式攻擊表達式仍可編譯並求值', () => {
  const box = { x: 320, y: 240, w: 150, h: 150 };
  const ctx = makeContext({ box, soul: { x: 300, y: 220 }, i: 3, n: 8, k: 1, t: 0.5, age: 1 / 3 });
  const cases = [
    ['i * (360 / n)', 3 * (360 / 8)],
    ['rand(10, 20)', null],
    ['aim(300, 400)', (Math.atan2((240 - 400) / 1, (320 - 300) / 1) * 180) / Math.PI],
    ['sin(age * 360)', Math.sin((1 / 3) * 360 * (Math.PI / 180))],
    ['box.left + 10', box.x - box.w / 2 + 10],
    ['pick(1, 2, 3)', null],
  ];
  for (const [src, expected] of cases) {
    const r = evalNumber(src, ctx, helpers, EMPTY_LOOKUPS);
    eq(r.error, null, `${src} 不該報錯`);
    if (expected !== null) approx(r.value, expected, 1e-9, src);
  }
});

test('EMPTY_LOOKUPS 讓攻擊表達式查表時一律 0', () => {
  const ctx = makeContext({ box: { x: 320, y: 240, w: 100, h: 100 } });
  for (const name of LOOKUP_NAMES) {
    const r = evalNumber(`${name}.anything`, ctx, helpers, EMPTY_LOOKUPS);
    eq(r.value, 0, `${name}.anything → 0`);
    eq(r.error, null, `${name}.anything 不報錯`);
  }
});

test('未提供 lookups 參數時退回 EMPTY_LOOKUPS（不會爆）', () => {
  const ctx = makeContext({ box: { x: 320, y: 240, w: 100, h: 100 } });
  const r = evalNumber('mercy.rudinn + 1', ctx, helpers);
  eq(r.value, 1, 'mercy 為 0');
  eq(r.error, null, '不報錯');
});

test('編譯快取對查表表達式同樣有效', () => {
  const ctx = makeContext({ box: { x: 320, y: 240, w: 100, h: 100 } });
  const lookups = { mercy: lookupFrom({ r: 10 }) };
  const a = evalNumber('mercy.r', ctx, helpers, lookups);
  const b = evalNumber('mercy.r', ctx, helpers, lookups);
  eq(a.value, 10, '第一次');
  eq(b.value, 10, '第二次（同一編譯結果）');
});
