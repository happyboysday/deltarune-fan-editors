/**
 * tests/engine/t-expr.mjs — 表達式系統測試（SPEC §5）
 *
 * 涵蓋：
 *   - 可用變數與函式（含 sin/cos 以度為單位、aim、lerp、rand 決定性）
 *   - 沙箱：window / document / globalThis / fetch / process 等一律 undefined
 *   - 編譯錯誤與執行錯誤 → 取 0 並回報，不中斷模擬
 *   - 編譯快取
 */
import { group, test, eq, ok, approx, within } from './harness.mjs';
import {
  compile,
  evalNumber,
  createHelpers,
  makeContext,
  clearExprCache,
  exprCacheSize,
  validateExprSyntax,
  SANDBOX_NAMES,
  VAR_NAMES,
  HELPER_NAMES,
} from '../../engine/expr.js';
import { createRng } from '../../engine/rng.js';

function ctx(over) {
  return makeContext({
    t: 1.5,
    T: 10,
    i: 2,
    n: 4,
    k: 3,
    age: 0.5,
    box: { x: 320, y: 200, w: 100, h: 60 },
    soul: { x: 300, y: 180 },
    ...(over || {}),
  });
}

function helpers() {
  const rng = createRng(12345);
  return createHelpers(rng, () => ({ x: 300, y: 180 }));
}

function val(src, over) {
  const r = evalNumber(src, ctx(over), helpers());
  return r.value;
}

/* ------------------------------------------------------------------ */

group('表達式：變數');

test('SPEC §5 的變數都能取用', () => {
  const c = ctx();
  eq(val('t'), 1.5, 't');
  eq(val('T'), 10, 'T');
  eq(val('i'), 2, 'i');
  eq(val('n'), 4, 'n');
  eq(val('k'), 3, 'k');
  eq(val('age'), 0.5, 'age');
  eq(val('box.x'), 320, 'box.x');
  eq(val('box.y'), 200, 'box.y');
  eq(val('box.w'), 100, 'box.w');
  eq(val('box.h'), 60, 'box.h');
  eq(val('box.left'), 270, 'box.left = x - w/2');
  eq(val('box.right'), 370, 'box.right');
  eq(val('box.top'), 170, 'box.top');
  eq(val('box.bottom'), 230, 'box.bottom');
  eq(val('soul.x'), 300, 'soul.x');
  eq(val('soul.y'), 180, 'soul.y');
  ok(c.box.left < c.box.right, 'left < right');
});

test('變數名稱清單涵蓋 SPEC §5 全部變數', () => {
  for (const name of ['t', 'T', 'i', 'n', 'k', 'age', 'box', 'soul']) {
    ok(VAR_NAMES.includes(name), `VAR_NAMES 應包含 SPEC 變數 ${name}`);
  }
  for (const name of ['sin', 'cos', 'tan', 'atan2', 'sqrt', 'abs', 'min', 'max', 'floor', 'ceil', 'round', 'PI', 'rand', 'pick', 'aim', 'lerp']) {
    ok(HELPER_NAMES.includes(name), `HELPER_NAMES 應包含 ${name}`);
  }
});

test('擴充變數 x / y 代表本次生成位置', () => {
  // 未提供時退回戰鬥框中心
  eq(val('x'), 320, 'x 預設為 box.x');
  eq(val('y'), 200, 'y 預設為 box.y');
  // 提供時使用該值（sim 會回填 spawn 已求出的位置）
  eq(val('x', { x: 111, y: 222 }), 111, '自訂 x');
  eq(val('aim(x, y)', { x: 300, y: 280 }), -90, 'aim(x, y) 可用生成點（正上方 = -90）');
});

/* ------------------------------------------------------------------ */

group('表達式：數值輸入');

test('數字直接回傳、不經編譯', () => {
  eq(evalNumber(42, ctx(), helpers()).value, 42, '整數');
  eq(evalNumber(-3.5, ctx(), helpers()).value, -3.5, '負小數');
  eq(evalNumber(0, ctx(), helpers()).value, 0, '零');
  eq(evalNumber(null, ctx(), helpers()).value, 0, 'null → 0（無錯誤）');
  eq(evalNumber(null, ctx(), helpers()).error, null, 'null 不算錯誤');
  eq(evalNumber(undefined, ctx(), helpers()).value, 0, 'undefined → 0');
  eq(evalNumber('', ctx(), helpers()).value, 0, '空字串 → 0（無錯誤）');
  eq(evalNumber('', ctx(), helpers()).error, null, '空字串不算錯誤');
});

test('NaN / Infinity 會回報錯誤而不是靜默通過', () => {
  ok(evalNumber(NaN, ctx(), helpers()).error, 'NaN 應回報');
  ok(evalNumber(Infinity, ctx(), helpers()).error, 'Infinity 應回報');
  ok(evalNumber('1/0', ctx(), helpers()).error, '除以 0 應回報');
});

/* ------------------------------------------------------------------ */

group('表達式：函式（sin/cos 以度為單位）');

test('三角函式以度為單位', () => {
  approx(val('sin(0)'), 0, 1e-9, 'sin(0)');
  approx(val('sin(90)'), 1, 1e-9, 'sin(90) = 1');
  approx(val('sin(180)'), 0, 1e-9, 'sin(180) = 0');
  approx(val('cos(0)'), 1, 1e-9, 'cos(0) = 1');
  approx(val('cos(180)'), -1, 1e-9, 'cos(180) = -1');
  approx(val('cos(90)'), 0, 1e-9, 'cos(90) = 0');
  approx(val('tan(45)'), 1, 1e-9, 'tan(45) = 1');
});

test('atan2 回傳度數', () => {
  approx(val('atan2(1, 0)'), 90, 1e-9, 'atan2(1,0) = 90 度（向下為正）');
  approx(val('atan2(0, 1)'), 0, 1e-9, 'atan2(0,1) = 0 度');
  approx(val('atan2(-1, 0)'), -90, 1e-9, 'atan2(-1,0) = -90 度');
});

test('基礎數學函式', () => {
  eq(val('sqrt(16)'), 4, 'sqrt');
  eq(val('abs(-7)'), 7, 'abs');
  eq(val('min(3, 1, 2)'), 1, 'min');
  eq(val('max(3, 1, 2)'), 3, 'max');
  eq(val('floor(2.9)'), 2, 'floor');
  eq(val('ceil(2.1)'), 3, 'ceil');
  eq(val('round(2.5)'), 3, 'round');
  approx(val('PI'), Math.PI, 1e-12, 'PI');
  approx(val('lerp(0, 10, 0.25)'), 2.5, 1e-12, 'lerp');
  approx(val('lerp(box.left, box.right, 0.5)'), 320, 1e-12, 'lerp 可用 box 變數');
});

test('aim(x, y) 回傳從該點指向靈魂的角度（度）', () => {
  // 靈魂在 (300,180)，從 (300,280) 看過去是正上方 → -90 度
  approx(val('aim(300, 280)'), -90, 1e-9, '正上方 = -90');
  // 從 (200,180) 看 → 正右方 = 0 度
  approx(val('aim(200, 180)'), 0, 1e-9, '正右方 = 0');
  // 從 (400,180) 看 → 正左方 = 180 度
  approx(val('aim(400, 180)'), 180, 1e-9, '正左方 = 180');
});

test('rand(a,b) 落在範圍內且具決定性', () => {
  const makeSeq = () => {
    const h = helpers();
    const r = evalNumber('rand(10, 20)', ctx(), h).value;
    return r;
  };
  const a = makeSeq();
  const b = makeSeq();
  eq(a, b, '相同 seed 的 rand 結果相同');
  within(a, 10, 20, 'rand 落在範圍');
  // 同一個 helpers 連續呼叫會前進亂數流
  const h = helpers();
  const s1 = evalNumber('rand(0, 100)', ctx(), h).value;
  const s2 = evalNumber('rand(0, 100)', ctx(), h).value;
  ok(s1 !== s2, '連續呼叫會得到不同值');
  within(s1, 0, 100, 's1 範圍');
  within(s2, 0, 100, 's2 範圍');
});

test('rand() 無參數回傳 [0,1)', () => {
  const h = helpers();
  const r = evalNumber('rand()', ctx(), h).value;
  ok(r >= 0 && r < 1, `rand() 應在 [0,1)，實際 ${r}`);
});

test('pick 可從多個參數選一個', () => {
  const h = helpers();
  const r = evalNumber('pick(1, 2, 3)', ctx(), h).value;
  ok([1, 2, 3].includes(r), `pick 回傳清單內的值（實際 ${r}）`);
});

test('pick 不支援陣列字面量（方括號一律拒絕）', () => {
  const r = evalNumber('pick([5, 6, 7])', ctx(), helpers());
  eq(r.value, 0, '陣列字面量被詞法白名單擋下');
  ok(r.error, '應回報錯誤');
});

/* ------------------------------------------------------------------ */

group('表達式：沙箱（不得存取全域）');

test('window / document / globalThis / fetch 一律被詞法白名單拒絕', () => {
  for (const name of ['window', 'document', 'globalThis', 'self', 'top', 'parent', 'fetch', 'XMLHttpRequest']) {
    const r = evalNumber(name, ctx(), helpers());
    eq(r.value, 0, `${name} 取 0`);
    ok(r.error, `${name} 必須被拒絕（不得進入編譯）`);
    // typeof 也不再有意義：名稱根本不存在於白名單
    const t = evalNumber(`typeof ${name}`, ctx(), helpers());
    eq(t.value, 0, `typeof ${name} 取 0`);
    ok(t.error, `typeof ${name} 也應被拒絕`);
  }
});

test('沙箱清單涵蓋常見危險全域', () => {
  for (const name of ['window', 'document', 'globalThis', 'fetch', 'XMLHttpRequest', 'process', 'require', 'localStorage', 'navigator', 'location', 'Function', 'Math', 'console']) {
    ok(SANDBOX_NAMES.includes(name), `SANDBOX_NAMES 應包含 ${name}`);
  }
});

test('竊取全域的常見寫法會失敗（取 0 + 錯誤）', () => {
  const attacks = [
    'globalThis.process',
    'window.location',
    'document.cookie',
    'fetch("http://x")',
    'this',
    'globalThis',
    'Function("return 1")()',
    'localStorage',
    'require("fs")',
    'process.exit(1)',
    'console.log(1)',
  ];
  for (const src of attacks) {
    const r = evalNumber(src, ctx(), helpers());
    ok(r.error !== null || r.value === 0, `"${src}" 應被擋下（value=${r.value}, error=${r.error}）`);
  }
});

test('賦值到未宣告變數在 strict mode 會拋錯（不是靜默成功）', () => {
  const r = evalNumber('leaked = 5', ctx(), helpers());
  ok(r.error, '應回報錯誤');
  eq(typeof globalThis.leaked, 'undefined', '不得污染全域');
});

test('沙箱不會讓 this 指向全域', () => {
  const r = evalNumber('this', ctx(), helpers());
  ok(r.error !== null || r.value === 0, 'this 不可用');
});

test('表達式無法取得 Math 物件（只提供列出的函式）', () => {
  const r = evalNumber('Math.random()', ctx(), helpers());
  ok(r.error, 'Math 應被遮蔽');
  const t = evalNumber('typeof Math', ctx(), helpers());
  eq(t.value, 0, 'typeof Math 不是數字 → 0');
});

/* ------------------------------------------------------------------ */

group('表達式：沙箱第二層 — 原型鏈 / Function 建構子逃逸');

/** 斷言：字串確實被拒（不建立函式），且全域未被污染 */
function expectBlocked(src) {
  const r = evalNumber(src, ctx(), helpers());
  eq(r.value, 0, `"${src}" 取 0`);
  ok(typeof r.error === 'string' && r.error.length > 0, `"${src}" 必須有錯誤訊息`);
  const compiled = compile(src);
  eq(compiled.fn, null, `"${src}" 不得建立函式`);
}

test('(0).constructor.constructor(...)() 逃逸被拒絕', () => {
  expectBlocked(`(0).constructor.constructor('globalThis.PWNED_1=1; return 7')()`);
  eq(typeof globalThis.PWNED_1, 'undefined', 'globalThis.PWNED_1 不得被設定');
});

test('rand.constructor(...)() 逃逸被拒絕', () => {
  expectBlocked(`rand.constructor('globalThis.PWNED_2=1; return 5')()`);
  eq(typeof globalThis.PWNED_2, 'undefined', 'globalThis.PWNED_2 不得被設定');
});

test('[].constructor / [1,2].constructor 被拒絕', () => {
  expectBlocked('[].constructor');
  expectBlocked('[1,2].constructor');
  expectBlocked('[].constructor.constructor("globalThis.PWNED_3=1")()');
  eq(typeof globalThis.PWNED_3, 'undefined', 'globalThis.PWNED_3 不得被設定');
});

test('sin.constructor / pick.constructor 等函式屬性存取被拒絕', () => {
  for (const name of ['sin', 'cos', 'rand', 'pick', 'aim', 'lerp', 'PI', 't', 'box', 'soul', 'x', 'y']) {
    expectBlocked(`${name}.constructor('return 1')()`);
  }
});

test('box / soul 的原型屬性被拒絕', () => {
  for (const src of [
    'box.constructor',
    'box.__proto__',
    'box.prototype',
    'soul.constructor',
    'soul.__proto__',
    'box.constructor.constructor',
    'soul.constructor.constructor("globalThis.PWNED_4=1")()',
  ]) {
    expectBlocked(src);
  }
  eq(typeof globalThis.PWNED_4, 'undefined', 'globalThis.PWNED_4 不得被設定');
});

test('this / new / Function / eval 等關鍵字被拒絕', () => {
  for (const src of [
    'this',
    'this.constructor',
    'new Function("return 1")()',
    'new (0).constructor("return 1")()',
    'Function("return 1")()',
    'eval("1+1")',
    'globalThis.Function("return 1")()',
  ]) {
    expectBlocked(src);
  }
});

test('字串字面量（單引號 / 雙引號 / 反引號）被拒絕', () => {
  for (const src of ['"hello"', "'hello'", '`tpl`', 'sin("1")', "rand('a','b')"]) {
    expectBlocked(src);
  }
});

test('方括號 / 大括號 / 分號 / 反斜線被拒絕', () => {
  for (const src of ['[1,2]', 'box["x"]', '1[0]', '{a:1}', 'x; y', '1 \\u0032', '(() => 1)()']) {
    expectBlocked(src);
  }
});

test('賦值運算子被拒絕，但比較運算子仍可用', () => {
  for (const src of ['a = 1', 'leaked = 5', 'x += 1', 'box.x = 10', 'i = 0']) {
    expectBlocked(src);
  }
  eq(typeof globalThis.a, 'undefined', 'globalThis.a 不得被設定');
  eq(typeof globalThis.leaked, 'undefined', 'globalThis.leaked 不得被設定');
  // 比較運算子仍要能編譯
  eq(val('1 == 1'), 1, "'==' 可用");
  eq(val('1 === 1'), 1, "'===' 可用");
  eq(val('1 != 2'), 1, "'!=' 可用");
  eq(val('1 !== 2'), 1, "'!==' 可用");
  eq(val('1 < 2'), 1, "'<' 可用");
  eq(val('2 <= 2'), 1, "'<=' 可用");
  eq(val('2 > 1'), 1, "'>' 可用");
  eq(val('2 >= 3'), 0, "'>=' 可用");
  eq(val('!0'), 1, "'!' 可用");
});

test('註解語法被拒絕（避免藏東西）', () => {
  expectBlocked('1 /* comment */ + 1');
  expectBlocked('1 // comment');
});

test('blacklist 名稱即使組合寫法也被拒絕', () => {
  for (const src of [
    'globalThis',
    'window',
    'document',
    'process',
    'require',
    'module',
    'exports',
    'console',
    'localStorage',
    'navigator',
    'location',
    'constructor',
    '__proto__',
    'prototype',
    'Function',
    'Math',
  ]) {
    expectBlocked(src);
  }
});

test('合法表達式不受白名單影響（33 種常見寫法可編譯）', () => {
  const goods = [
    '1 + 2 * 3 - 4 / 2 % 3',
    '2 ** 3',
    'box.left + box.w * (0.25 + i * 0.5)',
    'sin(age * 220 + i * 90 + k * 18) * (box.w * 0.32) + (box.w * 0.36)',
    'i * (360 / n) + t * 45',
    'aim(545, 200) + (i - 2) * 9',
    'rand(box.left + 8, box.right - 8)',
    '90 + rand(-12, 12)',
    'rand(0, 360)',
    'age * 60',
    '-age * rand(70, 100)',
    'box.top + rand(0, box.h)',
    'lerp(box.left, box.right, 0.5)',
    '(box.left + box.right) / 2',
    'sqrt(abs(-16))',
    'pick(1, 2, 3)',
    'min(3, max(1, 2))',
    'PI * 2',
    'floor(round(ceil(1.5)))',
    'atan2(soul.y - y, soul.x - x)',
    '1 > 0 ? 2 : 3',
    '!0 && 1 || 0',
    '1.5e2 + .5',
    'true ? 1 : 2',
    'x + y',
    'soul.x - box.x',
    'sin(-90)',
    '1 != 2',
    '1 !== 2',
    '1 == 1',
    '1 === 1',
    '1 <= 2',
    '1 >= 2',
  ];
  for (const src of goods) {
    const compiled = compile(src);
    eq(compiled.error, null, `"${src}" 應可編譯（錯誤：${compiled.error}）`);
    ok(typeof compiled.fn === 'function', `"${src}" 應建立函式`);
  }
});

test('validateExprSyntax 可直接呼叫並回傳錯誤字串 / null', () => {
  eq(validateExprSyntax('1 + 1'), null, '合法 → null');
  ok(typeof validateExprSyntax('(0).constructor') === 'string', '非法 → 字串訊息');
  ok(typeof validateExprSyntax(null) === 'string', '非字串 → 字串訊息');
});

/* ------------------------------------------------------------------ */

group('表達式：錯誤不中斷');

test('語法錯誤 → value 0 + error 訊息', () => {
  for (const bad of ['1 +', 'sin(', ')', 'a b c', '{', 'return 1', 'var x = 1']) {
    const r = evalNumber(bad, ctx(), helpers());
    eq(r.value, 0, `"${bad}" 取 0`);
    ok(typeof r.error === 'string' && r.error.length > 0, `"${bad}" 有錯誤訊息`);
  }
});

test('執行期錯誤 → value 0 + error 訊息', () => {
  for (const bad of ['undefinedThing + 1', 'null.x', 'box.nope.deep', 'sin()()']) {
    const r = evalNumber(bad, ctx(), helpers());
    eq(r.value, 0, `"${bad}" 取 0`);
    ok(typeof r.error === 'string' && r.error.length > 0, `"${bad}" 有錯誤訊息`);
  }
});

test('回傳非數字 → value 0 + error', () => {
  const r = evalNumber('"hello"', ctx(), helpers());
  eq(r.value, 0, '字串結果取 0');
  ok(r.error, '應回報非數字');
  const r2 = evalNumber('[1,2]', ctx(), helpers());
  eq(r2.value, 0, '陣列結果取 0');
  ok(r2.error, '陣列也應回報');
});

test('布林結果會轉成 1/0', () => {
  eq(evalNumber('1 > 0', ctx(), helpers()).value, 1, 'true → 1');
  eq(evalNumber('1 < 0', ctx(), helpers()).value, 0, 'false → 0');
});

/* ------------------------------------------------------------------ */

group('表達式：編譯快取');

test('相同字串只編譯一次（快取命中）', () => {
  clearExprCache();
  eq(exprCacheSize(), 0, '清空後為 0');
  compile('1 + 1');
  eq(exprCacheSize(), 1, '編譯後有 1 筆');
  compile('1 + 1');
  compile('1 + 1');
  eq(exprCacheSize(), 1, '重複編譯不新增');
  compile('2 + 2');
  eq(exprCacheSize(), 2, '不同字串各自快取');
});

test('編譯失敗也會快取（避免每幀重試）', () => {
  clearExprCache();
  const a = compile('1 +');
  const b = compile('1 +');
  ok(a.error, '第一次有錯誤');
  ok(b.error, '第二次仍有錯誤');
  eq(exprCacheSize(), 1, '失敗結果同樣快取');
  eq(a.fn, b.fn, '回傳同一個快取條目內容');
});

test('同一段表達式可重複編譯與求值', () => {
  const h = helpers();
  for (let i = 0; i < 100; i += 1) {
    const r = evalNumber('i * n + t', ctx({ i, n: 3, t: 0.5 }), h);
    eq(r.value, i * 3 + 0.5, `第 ${i} 次求值`);
  }
});

test('非字串輸入 compile 不會丟例外', () => {
  for (const bad of [null, undefined, 5, {}, []]) {
    const r = compile(bad);
    ok(r.error, `${String(bad)} 應回報錯誤`);
    eq(r.fn, null, 'fn 為 null');
  }
});

/* ------------------------------------------------------------------ */

group('makeContext：context 建立');

test('缺值時補 0 / 由 box 推導邊界', () => {
  const c = makeContext({});
  eq(c.t, 0, 't 預設 0');
  eq(c.n, 1, 'n 預設 1');
  eq(c.box.x, 0, 'box.x 預設 0');
  eq(c.box.left, 0, 'box.left 推導');
  const c2 = makeContext({ box: { x: 100, y: 50, w: 40, h: 20 } });
  eq(c2.box.left, 80, 'left = x - w/2');
  eq(c2.box.top, 40, 'top = y - h/2');
  eq(c2.box.right, 120, 'right');
  eq(c2.box.bottom, 60, 'bottom');
  eq(c2.soul.x, 100, 'soul 預設跟 box.x 相同');
});
