// editor/demo-path.test.mjs — 演示路徑純邏輯（AP4）
//
// 只測 editor/demo-path.js（不碰 DOM）；用 node --test 或 node 直接跑。
// 期望語意對齊 SPEC-AUTOPLAY §2.1 與 engine/autoplay/soul.js 的 path 模式。

import assert from 'node:assert/strict';
import { encodeInputs } from '../engine/autoplay/soul.js';
import {
  DEMO_FPS,
  addDemoPoint,
  buildDemoTimeline,
  clampDemoPoint,
  decodeDemoInputs,
  demoBoxFor,
  demoFrameToTime,
  demoInputToSimulation,
  demoPathDuration,
  demoPathOf,
  demoPathTargetAt,
  demoShapeSignature,
  demoTimeToFrame,
  formatDemoTime,
  moveDemoPoint,
  normalizeDemoPath,
  normalizeDemoPoint,
  removeDemoPoint,
  roundDemoValue,
  sortDemoPath,
} from './demo-path.js';
import { BOX_DEFAULTS } from '../engine/attack.js';

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ---------------------------------------------------------------- 座標/時間 */

test('roundDemoValue：四捨五入到指定位數，非數字回 0', () => {
  assert.equal(roundDemoValue(1.23456), 1.23);
  assert.equal(roundDemoValue(1.235), 1.24);
  assert.equal(roundDemoValue(-0.004), 0);
  assert.equal(roundDemoValue('x'), 0);
  assert.equal(roundDemoValue(123.456, 1), 123.5);
});

test('demoFrameToTime / demoTimeToFrame：30fps 換算', () => {
  assert.equal(DEMO_FPS, 30);
  assert.equal(demoFrameToTime(0), 0);
  assert.equal(demoFrameToTime(45), 1.5);
  assert.equal(demoTimeToFrame(1.5), 45);
  assert.equal(demoTimeToFrame(0.02), 1);
  assert.equal(demoFrameToTime('x'), 0);
});

test('formatDemoTime：一位小數 + s', () => {
  assert.equal(formatDemoTime(1.234), '1.2s');
  assert.equal(formatDemoTime(0), '0.0s');
  assert.equal(formatDemoTime(Number.NaN), '0.0s');
});

/* ------------------------------------------------------------ 點正規化/排序 */

test('normalizeDemoPoint：保留合法欄位、省略預設值、壞點回 null', () => {
  assert.equal(normalizeDemoPoint(null), null);
  assert.equal(normalizeDemoPoint({ t: -1, x: 0, y: 0 }), null);
  assert.equal(normalizeDemoPoint({ t: 0, x: 'a', y: 0 }), null);
  assert.equal(normalizeDemoPoint({ x: 0, y: 0 }), null);
  assert.deepEqual(normalizeDemoPoint({ t: 1.23456, x: 320.123, y: 190, slow: true, hold: 0 }), {
    t: 1.235,
    x: 320.12,
    y: 190,
    slow: true,
  });
  assert.deepEqual(normalizeDemoPoint({ t: 0, x: 1, y: 2, hold: 0.5 }), { t: 0, x: 1, y: 2, hold: 0.5 });
});

test('normalizeDemoPath / sortDemoPath：丟壞點並依 t 穩定排序', () => {
  const out = normalizeDemoPath([
    { t: 2, x: 1, y: 1 },
    { t: -1, x: 9, y: 9 },
    { t: 0, x: 2, y: 2 },
    null,
  ]);
  assert.deepEqual(out.map((p) => p.t), [0, 2]);
  const same = sortDemoPath([
    { t: 0, x: 1, y: 1, tag: 'a' },
    { t: 0, x: 2, y: 2, tag: 'b' },
    { t: 1, x: 3, y: 3, tag: 'c' },
  ]);
  assert.deepEqual(same.map((p) => p.tag), ['a', 'b', 'c']);
});

/* ---------------------------------------------------------------- 時間軸 */

test('buildDemoTimeline：hold 會把後續點推遲（start 取 max）', () => {
  const timeline = buildDemoTimeline([
    { t: 0, x: 0, y: 0, hold: 1 },
    { t: 0.2, x: 100, y: 0 },
    { t: 3, x: 100, y: 100 },
  ]);
  assert.ok(timeline);
  assert.deepEqual(timeline.starts, [0, 1, 3]);
  assert.equal(timeline.end, 3);
  assert.equal(buildDemoTimeline([]), null);
  assert.equal(demoPathDuration([{ t: 0, x: 0, y: 0, hold: 2 }]), 2);
});

test('demoPathTargetAt：段內線性插值、slow 繼承前點、t>=end 回 null', () => {
  const timeline = buildDemoTimeline([
    { t: 0, x: 0, y: 0 },
    { t: 2, x: 100, y: 200, slow: true },
    { t: 4, x: 100, y: 200 },
  ]);
  assert.deepEqual(demoPathTargetAt(timeline, 1), { x: 50, y: 100, slow: false, t: 1 });
  assert.deepEqual(demoPathTargetAt(timeline, 3), { x: 100, y: 200, slow: true, t: 3 });
  assert.equal(demoPathTargetAt(timeline, 4), null);
  assert.equal(demoPathTargetAt(timeline, 99), null);
  assert.equal(demoPathTargetAt(null, 0), null);
  // 單點：end 之前都回該點
  const single = buildDemoTimeline([{ t: 1, x: 7, y: 8, slow: true }]);
  assert.deepEqual(demoPathTargetAt(single, 0.5), { x: 7, y: 8, slow: true, t: 1 });
  assert.equal(demoPathTargetAt(single, 1), null);
});

/* ------------------------------------------------------------ 夾框/新增/刪除 */

test('clampDemoPoint：框內不動、框外夾回、支援旋轉框', () => {
  const box = { x: 320, y: 190, w: 150, h: 165, rotation: 0 };
  assert.deepEqual(clampDemoPoint(320, 190, box, 4), { x: 320, y: 190 });
  assert.deepEqual(clampDemoPoint(-100, -100, box, 4), { x: 320 - 75 + 4, y: 190 - 82.5 + 4 });
  // 旋轉 90°：把點夾到框的左/右邊界時仍落在框的範圍內
  const rotated = { x: 0, y: 0, w: 100, h: 40, rotation: 90 };
  const clamped = clampDemoPoint(500, 500, rotated, 4);
  const rad = (90 * Math.PI) / 180;
  const dx = clamped.x - rotated.x;
  const dy = clamped.y - rotated.y;
  const lx = dx * Math.cos(rad) + dy * Math.sin(rad);
  const ly = -dx * Math.sin(rad) + dy * Math.cos(rad);
  assert.ok(Math.abs(lx) <= 50 - 4 + 0.01);
  assert.ok(Math.abs(ly) <= 20 - 4 + 0.01);
});

test('addDemoPoint / removeDemoPoint / moveDemoPoint：排序、刪除、交換 t 上移', () => {
  let path = addDemoPoint([], { t: 2, x: 30, y: 30 });
  path = addDemoPoint(path, { t: 0, x: 10, y: 10 });
  path = addDemoPoint(path, { t: 1, x: 20, y: 20 });
  assert.deepEqual(path.map((p) => p.t), [0, 1, 2]);
  const removed = removeDemoPoint(path, 1);
  assert.equal(removed.length, 2);
  assert.equal(path.length, 3, 'removeDemoPoint 不應改原陣列');
  const moved = moveDemoPoint(path, 1, -1);
  // t 值交換後重新排序：x:20 的點移到 t=0、x:10 的點變 t=1
  assert.deepEqual(moved.map((p) => p.x), [20, 10, 30]);
  assert.deepEqual(moved.map((p) => p.t), [0, 1, 2]);
  // 邊界：不可移動時回傳等價內容
  assert.deepEqual(moveDemoPoint(path, 0, -1), normalizeDemoPath(path));
  assert.deepEqual(moveDemoPoint(path, 2, 1), normalizeDemoPath(path));
});

/* ------------------------------------------------------------------ inputs */

test('decodeDemoInputs：段數/幀數與解析錯誤', () => {
  const text = encodeInputs([
    { frame: 0, press: [], hold: {} },
    { frame: 12, press: [], hold: { right: true } },
    { frame: 30, press: ['confirm'], hold: { right: true, down: true } },
  ]);
  const info = decodeDemoInputs(text);
  assert.equal(info.ok, true);
  assert.equal(info.segments, 3);
  assert.equal(info.frames, 31);
  assert.deepEqual(info.errors, []);
  const bad = decodeDemoInputs('oops');
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length > 0);
  assert.equal(decodeDemoInputs('').segments, 0);
  assert.equal(decodeDemoInputs(null).segments, 0);
});

/* ------------------------------------------------------ 結構簽章 / 取用工具 */

test('demoShapeSignature：只反映會改變 DOM 結構的欄位', () => {
  const a = demoShapeSignature({ mode: 'path', fallback: 'bot', path: [1, 2], inputs: '0:;' });
  assert.equal(a, 'path|bot|2|3');
  assert.equal(demoShapeSignature(null), '||0|0');
  const b = demoShapeSignature({ mode: 'path', fallback: 'bot', path: [1, 2, 3], inputs: '0:;' });
  assert.notEqual(a, b);
});

test('demoPathOf / demoBoxFor：取 demo.path 與戰鬥框（缺值用預設）', () => {
  assert.deepEqual(demoPathOf(null), []);
  assert.deepEqual(demoPathOf({ path: [{ t: 0 }] }), [{ t: 0 }]);
  const attack = { box: { x: 100, y: 120, w: 200, h: 80 } };
  assert.deepEqual(demoBoxFor(attack), { x: 100, y: 120, w: 200, h: 80, rotation: 0 });
  const fallback = demoBoxFor({});
  assert.equal(fallback.x, BOX_DEFAULTS.x);
  assert.equal(fallback.w, BOX_DEFAULTS.w);
  assert.equal(fallback.rotation, 0);
});

test('demoInputToSimulation：{press,hold} → 攻擊模擬的 {dx,dy,slow}', () => {
  assert.deepEqual(demoInputToSimulation({ press: [], hold: {} }), { dx: 0, dy: 0, slow: false });
  assert.deepEqual(demoInputToSimulation({ hold: { right: true, up: true, slow: true } }), {
    dx: 1,
    dy: -1,
    slow: true,
  });
  // 左右/上下同時按 = 0（與 world.normalizeInput 語意一致）
  assert.deepEqual(demoInputToSimulation({ hold: { left: true, right: true, up: true, down: true } }), {
    dx: 0,
    dy: 0,
    slow: false,
  });
  assert.deepEqual(demoInputToSimulation(null), { dx: 0, dy: 0, slow: false });
  assert.deepEqual(demoInputToSimulation({ dx: 1, dy: 1 }), { dx: 0, dy: 0, slow: false });
});

/* ---------------------------------------------------------------- 執行測試 */

for (const [name, fn] of tests) {
  try {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  } catch (err) {
    failures.push({ name, err });
    console.error(`not ok - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}

const total = passed + failures.length;
console.log(`\n${total} tests, ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) process.exitCode = 1;
