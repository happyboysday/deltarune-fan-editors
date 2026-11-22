// editor/demo.test.mjs — AP4 演示 demo：三語字串、可復原編輯、驗證路徑、自動演示決定性
//
// 純 Node（不碰 DOM）：直接組 store / validateAttack / engine 來驗證 demo 面板
// 依賴的邏輯；實際面板 DOM 由 headless Edge 驗證。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createEmptyAttack } from './inspector.js';
import { createStore } from './store.js';
import { validateAttack } from '../engine/attack.js';
import { createBattle } from '../engine/index.js';
import { createAutopilot } from '../engine/autoplay/index.js';
import demoStrings, { findKeyMismatches, LOCALE_IDS, NAMESPACES } from './locales/demo.js';
import {
  addDemoPoint,
  demoInputToSimulation,
  demoPathTargetAt,
  buildDemoTimeline,
  demoShapeSignature,
} from './demo-path.js';

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

/* ------------------------------------------------------------ 三語字串 */

test('locales/demo.js：三語鍵集合一致、無空字串', () => {
  assert.deepEqual(findKeyMismatches(demoStrings), []);
  assert.deepEqual(LOCALE_IDS, ['zh-Hant', 'zh-Hans', 'en']);
  assert.deepEqual(NAMESPACES, ['demo', 'autoplay']);
});

test('locales/demo.js：demo 面板與自動開關需要的鍵三語都存在', () => {
  const requiredDemo = [
    'section',
    'sectionHint',
    'mode',
    'mode.auto',
    'mode.path',
    'mode.inputs',
    'mode.bot',
    'fallback',
    'fallback.bot',
    'fallback.stay',
    'path',
    'pathInfo',
    'pathEmpty',
    'pathEmptySub',
    'addCursor',
    'addSoul',
    'pointIndex',
    't',
    'x',
    'y',
    'slow',
    'hold',
    'inputs',
    'inputsInfo',
    'inputsLength',
    'inputsEmpty',
    'clearInputs',
    'record',
    'stopRecord',
    'recordActive',
    'recordHint',
    'errorHint',
    'undo.addPoint',
    'undo.removePoint',
    'undo.movePoint',
    'undo.edit',
    'undo.dragPoint',
    'undo.record',
    'undo.clearInputs',
  ];
  const requiredAutoplay = ['label', 'title', 'off', 'demo', 'bot', 'status', 'overlay', 'overlayTitle', 'recording'];
  for (const locale of LOCALE_IDS) {
    const { demo, autoplay } = demoStrings[locale];
    for (const key of requiredDemo) {
      assert.equal(typeof demo[key], 'string', `${locale}.demo.${key} 應為字串`);
      assert.ok(demo[key].length > 0, `${locale}.demo.${key} 不可為空`);
    }
    for (const key of requiredAutoplay) {
      assert.equal(typeof autoplay[key], 'string', `${locale}.autoplay.${key} 應為字串`);
    }
  }
  // 錄製 undo 標籤（SPEC §4：一筆可復原修改，label「錄製演示」）
  assert.equal(demoStrings['zh-Hant'].demo['undo.record'], '錄製演示');
  assert.match(demoStrings['zh-Hant'].autoplay.status, /\{mode\}/);
  assert.match(demoStrings['en'].demo.pathInfo, /\{count\}/);
  assert.match(demoStrings['en'].demo.inputsInfo, /\{segments\}/);
});

/* --------------------------------------------------------- store 可復原編輯 */

test('demo.path 的新增/刪除走一筆可復原的 store.update', () => {
  const doc = createEmptyAttack();
  const store = createStore(doc);
  assert.equal(store.attack.demo, undefined);
  const label = demoStrings['zh-Hant'].demo['undo.addPoint'];
  store.update(
    (draft) => {
      draft.demo = { mode: 'path', path: [] };
      draft.demo.path = addDemoPoint(draft.demo.path, { t: 1.5, x: 300, y: 200 });
    },
    { label },
  );
  assert.equal(store.attack.demo.mode, 'path');
  assert.equal(store.attack.demo.path.length, 1);
  assert.equal(store.attack.demo.path[0].t, 1.5);
  assert.equal(store.canUndo(), true);
  store.undo();
  assert.equal(store.attack.demo, undefined, 'undo 後應回到沒有 demo 的狀態');
  store.redo();
  assert.equal(store.attack.demo.path.length, 1);
});

test('拖曳 demo 路徑點可用 coalesceKey 合併成一步 undo（模擬檢查器/疊加層）', () => {
  const doc = createEmptyAttack();
  doc.demo = { mode: 'path', path: [{ t: 0, x: 280, y: 190 }] };
  const store = createStore(doc);
  const before = store.attack.demo.path[0].x;
  for (let i = 0; i < 6; i += 1) {
    store.update(
      (draft) => {
        draft.demo.path[0].x = before + i + 1;
      },
      { label: demoStrings['zh-Hant'].demo['undo.dragPoint'], coalesceKey: 'demo:point:0' },
    );
  }
  store.endCoalesce();
  assert.equal(store.attack.demo.path[0].x, before + 6);
  store.undo();
  assert.equal(store.attack.demo.path[0].x, before, '整段拖曳應只佔一步 undo');
});

/* ------------------------------------------------------- validateAttack 路徑 */

test('validateAttack 併入 validateAttackDemo：錯誤路徑是 demo.path[i].欄位', () => {
  const doc = createEmptyAttack();
  doc.demo = {
    mode: 'path',
    fallback: 'stay',
    path: [
      { t: 1, x: 300, y: 200 },
      { t: 0, x: 300, y: 200 }, // t 未遞增
      { t: 2, x: 300 }, // 缺 y
      { t: 3, x: 300, y: 200, slow: 1 }, // slow 非布林
    ],
  };
  const errors = validateAttack(doc);
  assert.ok(Array.isArray(errors));
  const byPath = new Map(errors.map((error) => [error.path, error.message]));
  assert.ok(byPath.has('demo.path[1].t'), `應有 demo.path[1].t；實際：${[...byPath.keys()].join(', ')}`);
  assert.match(byPath.get('demo.path[1].t'), /遞增/);
  assert.ok(byPath.has('demo.path[2].y'));
  assert.ok(byPath.has('demo.path[3].slow'));

  const badMode = createEmptyAttack();
  badMode.demo = { mode: 'walk', fallback: 'teleport' };
  const modeErrors = validateAttack(badMode).map((error) => error.path);
  assert.ok(modeErrors.includes('demo.mode'));
  assert.ok(modeErrors.includes('demo.fallback'));

  const badInputs = createEmptyAttack();
  badInputs.demo = { mode: 'inputs', inputs: 'this is not rle' };
  const inputErrors = validateAttack(badInputs);
  assert.ok(inputErrors.some((error) => error.path === 'demo.inputs'));
});

test('合法 demo 不會產生任何 demo.* 驗證錯誤', () => {
  const doc = createEmptyAttack();
  doc.demo = {
    mode: 'path',
    fallback: 'bot',
    path: [
      { t: 0, x: 320, y: 190 },
      { t: 1.2, x: 280, y: 240, slow: true },
      { t: 2, x: 360, y: 240, hold: 0.4 },
    ],
  };
  const demoErrors = validateAttack(doc).filter((error) => String(error.path).startsWith('demo'));
  assert.deepEqual(demoErrors, []);
});

/* ------------------------------------------- 自動演示決定性 / 受傷 0（Node） */

function runDemoOnce(battle, pilot, onHit) {
  const trace = [];
  for (let i = 0; i < battle.durationFrames; i += 1) {
    const state = battle.engine.getState();
    const input = pilot.input(state, state.frame);
    battle.engine.stepFrame(demoInputToSimulation(input));
    const after = battle.engine.getState();
    trace.push([after.soul.x, after.soul.y]);
    if (onHit) onHit(after);
    if (typeof battle.engine.drainSfx === 'function') battle.engine.drainSfx();
  }
  return trace;
}

test('samples/spade-rain.json：demo.path 自動演示受傷 0，且 seek 重算逐幀一致', () => {
  const url = new URL('../samples/spade-rain.json', import.meta.url);
  const doc = JSON.parse(fs.readFileSync(url, 'utf8'));
  assert.ok(doc.demo && Array.isArray(doc.demo.path) && doc.demo.path.length > 1, '範例應附 demo.path');

  const battle = createBattle({ canvas: null, assets: null, mode: 'play' });
  battle.load(doc);
  const hits = [];
  battle.on('hit', (payload) => hits.push(payload));

  const pilot = createAutopilot({ kind: 'attack', doc, mode: 'demo' });
  assert.ok(Array.isArray(pilot.warnings));

  // 第一次：從第 0 幀播放
  const traceA = runDemoOnce(battle, pilot);
  const hitsA = hits.length;
  assert.equal(hitsA, 0, `demo.path 應完全閃避 spade-rain（實際受傷 ${hitsA} 次）`);

  // 第二次：seek 重模擬（reset pilot + engine，從第 0 幀重算）→ 必須逐幀相同
  pilot.reset();
  battle.engine.reset();
  const traceB = runDemoOnce(battle, pilot);
  assert.equal(hits.length, hitsA, '重算不應新增受傷');
  assert.deepEqual(traceB, traceA, '同一個 pilot 從第 0 幀重算應逐幀一致（決定性，SPEC §1）');

  // 路徑時間軸與 pilot 的 path 模式一致
  const timeline = buildDemoTimeline(doc.demo.path);
  const target = demoPathTargetAt(timeline, 0);
  assert.ok(target && Number.isFinite(target.x) && Number.isFinite(target.y));
});

test('demo 結構簽章變更（新增點）會讓檢查器 shapeKey 改變', () => {
  const base = { mode: 'path', fallback: 'bot', path: [{ t: 0, x: 1, y: 1 }] };
  const before = demoShapeSignature(base);
  const after = demoShapeSignature({ ...base, path: [...base.path, { t: 1, x: 2, y: 2 }] });
  assert.notEqual(before, after);
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
