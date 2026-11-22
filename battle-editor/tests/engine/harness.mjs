/**
 * tests/engine/harness.mjs — 極簡測試框架（無外部依賴、支援 async 測試）
 *
 * 用法：
 *   import { test, group, eq, ok, run, summary } from './harness.mjs';
 *   group('分組名稱');
 *   test('名稱', () => { eq(1, 1, '一等於一'); });      // 同步
 *   test('名稱', async () => { ... });                  // 非同步
 *   await run();      // 依註冊順序執行（含 await）
 *   summary();        // 印出統計並設定 process.exitCode
 *
 * 測試檔只要在 import 時呼叫 test() 完成註冊即可；run.mjs 負責執行。
 */

const queue = [];
const results = { pass: 0, fail: 0, notes: 0, skipped: 0 };
const failures = [];
const startTime = Date.now();
let hasRun = false;

function log(line) {
  process.stdout.write(`${line}\n`);
}

/** 開始一個測試分組（立即印出標題，使輸出順序符合閱讀習慣） */
export function group(name) {
  queue.push({ kind: 'group', name });
}

/** 註冊一個測試 */
export function test(name, fn) {
  if (typeof fn !== 'function') {
    throw new Error(`測試「${name}」沒有提供函式`);
  }
  queue.push({ kind: 'test', name, fn, group: currentGroupName() });
}

/** 跳過一個測試 */
export function skip(name, reason = '') {
  queue.push({ kind: 'skip', name, reason });
}

/** 非致命提醒 */
export function note(text) {
  queue.push({ kind: 'note', text });
}

function currentGroupName() {
  for (let i = queue.length - 1; i >= 0; i -= 1) {
    if (queue[i].kind === 'group') return queue[i].name;
  }
  return '（未分組）';
}

/** 執行所有已註冊的測試（依註冊順序；async 測試會被 await） */
export async function run() {
  if (hasRun) return results;
  hasRun = true;
  let currentGroup = '（未分組）';
  for (const item of queue) {
    if (item.kind === 'group') {
      currentGroup = item.name;
      log(`\n=== ${item.name} ===`);
      continue;
    }
    if (item.kind === 'note') {
      results.notes += 1;
      log(`  · 備註：${item.text}`);
      continue;
    }
    if (item.kind === 'skip') {
      results.skipped += 1;
      log(`○ ${item.name}${item.reason ? ` — ${item.reason}` : ''}`);
      continue;
    }
    try {
      // eslint-disable-next-line no-await-in-loop
      await item.fn();
      results.pass += 1;
      log(`✔ ${item.name}`);
    } catch (err) {
      results.fail += 1;
      const message = err && err.message ? err.message : String(err);
      failures.push({ group: currentGroup, name: item.name, message, stack: err && err.stack });
      log(`✘ ${item.name} — ${message}`);
    }
  }
  return { ...results, failures };
}

/* ------------------------------------------------------------ 斷言 */

export function ok(cond, message = '條件不成立') {
  if (!cond) throw new Error(message);
}

export function notOk(cond, message = '條件應為假') {
  ok(!cond, message);
}

export function eq(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message || '值不相等'}（實際 ${format(actual)}，預期 ${format(expected)}）`);
  }
}

export function notEq(actual, unexpected, message = '') {
  if (actual === unexpected) {
    throw new Error(`${message || '值不該相等'}（兩者皆為 ${format(actual)}）`);
  }
}

export function approx(actual, expected, eps = 1e-6, message = '') {
  if (!Number.isFinite(actual)) {
    throw new Error(`${message || '數值比較'}：實際不是有限數（${format(actual)}）`);
  }
  if (Math.abs(actual - expected) > eps) {
    throw new Error(
      `${message || '數值差距過大'}（實際 ${actual}，預期 ${expected}，允許誤差 ${eps}）`,
    );
  }
}

export function within(actual, lo, hi, message = '') {
  if (!(actual >= lo && actual <= hi)) {
    throw new Error(`${message || '值超出範圍'}（實際 ${format(actual)}，範圍 [${lo}, ${hi}]）`);
  }
}

export function isArray(value, message = '應為陣列') {
  if (!Array.isArray(value)) throw new Error(`${message}（實際 ${typeof value}）`);
}

export function isObj(value, message = '應為物件') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${message}（實際 ${format(value)}）`);
  }
}

export function hasKey(obj, key, message = '') {
  isObj(obj);
  if (!Object.prototype.hasOwnProperty.call(obj, key)) {
    throw new Error(`${message || '缺少欄位'}：${key}（現有：${Object.keys(obj).join(', ')}）`);
  }
}

/** 深度相等（以 JSON 序列化比較；本專案狀態皆為純資料） */
export function deepEq(actual, expected, message = '') {
  const a = stable(actual);
  const b = stable(expected);
  if (a !== b) {
    throw new Error(`${message || '深度比較不相等'}\n    實際：${clip(a)}\n    預期：${clip(b)}`);
  }
}

export function deepNotEq(actual, expected, message = '') {
  if (stable(actual) === stable(expected)) throw new Error(`${message || '深度比較應不相等'}`);
}

/** 約略深度相等：浮點數以 eps 容許（物件 / 陣列遞迴） */
export function deepApprox(actual, expected, eps = 1e-6, message = '') {
  const diffs = [];
  compareApprox(actual, expected, eps, '$', diffs);
  if (diffs.length > 0) {
    throw new Error(`${message || '約略深度比較不相等'}\n    ${diffs.slice(0, 6).join('\n    ')}`);
  }
}

function compareApprox(a, b, eps, path, diffs) {
  if (typeof a === 'number' && typeof b === 'number') {
    if (!Number.isFinite(a) || !Number.isFinite(b) || Math.abs(a - b) > eps) {
      diffs.push(`${path}: ${a} ≉ ${b}`);
    }
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      diffs.push(`${path}: 長度 ${a.length} ≠ ${b.length}`);
      return;
    }
    for (let i = 0; i < a.length; i += 1) compareApprox(a[i], b[i], eps, `${path}[${i}]`, diffs);
    return;
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) diffs.push(`${path}: 欄位數 ${ka.length} ≠ ${kb.length}`);
    for (const k of ka) {
      if (!Object.prototype.hasOwnProperty.call(b, k)) diffs.push(`${path}.${k}: 缺少`);
      else compareApprox(a[k], b[k], eps, `${path}.${k}`, diffs);
    }
    return;
  }
  if (a !== b) diffs.push(`${path}: ${format(a)} ≠ ${format(b)}`);
}

function stable(value) {
  return JSON.stringify(value, (key, v) => {
    if (typeof v === 'number' && !Number.isFinite(v)) return `__nonfinite:${String(v)}`;
    return v;
  });
}

function format(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.length} 項]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).join(',')}}`;
  return String(value);
}

function clip(text, max = 700) {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/* ------------------------------------------------------------ 統計 */

export function summary() {
  const ms = Date.now() - startTime;
  log('');
  log('────────────────────────────────────────────');
  log(`通過 ${results.pass}・失敗 ${results.fail}・略過 ${results.skipped}・備註 ${results.notes}（${ms} ms）`);
  if (results.fail > 0) {
    log('\n失敗清單：');
    for (const f of failures) {
      log(`  ✘ [${f.group}] ${f.name}`);
      log(`    ${f.message}`);
    }
    process.exitCode = 1;
    log('\n結果：失敗');
  } else {
    process.exitCode = 0;
    log('結果：全部通過');
  }
  return { ...results, failures };
}

export default { test, group, eq, ok, run, summary };
