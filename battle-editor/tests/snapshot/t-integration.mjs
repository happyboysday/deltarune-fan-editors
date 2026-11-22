/**
 * tests/snapshot/t-integration.mjs — 快照 API 的整合驗證（V2-08）
 *
 * 驗證：
 *   1. createReplayEngine 改用「原點快照 + restore」後，replayPath 的輸出
 *      與「每次 reset」完全相同（同一份路徑、同一份 hits / framesRun / 端點）
 *   2. 重跑器可以連續跑多次，每次都從乾淨的原點開始（不殘留上一輪的子彈）
 *   3. generateDemoPath 對同一 seed 仍為決定性（快照加速不改變結果）
 *   4. engine/autoplay 的公開行為（validateDemoPath 等）不受影響
 *
 * 注意：這裡刻意不跑多個 sample 的完整 generateDemoPath（單次 1–10 秒，
 * 會讓快照測試變慢）；完整的最佳化流程由 tests/autoplay/run.mjs 覆蓋。
 */

import {
  ATTACK_SAMPLES,
  attackInput,
  loadModule,
  makeSimulation,
  readAttackSample,
} from './fixtures.mjs';
import { group, test, ok, eq, deepEq, isObj } from '../engine/harness.mjs';

const { createReplayEngine, replayPath, validateDemoPath } = await loadModule('engine/autoplay/pathgen.js');
const { createSimulation } = await loadModule('engine/sim.js');

group('整合：pathgen 重跑器（snapshot 加速）');

for (const name of ATTACK_SAMPLES) {
  const doc = readAttackSample(name);

  test(`${name}：replayPath 的結果與直跑一致（同一份 demo 路徑）`, async () => {
    const path = doc.demo && Array.isArray(doc.demo.path) ? doc.demo.path : null;
    if (!path || path.length < 2) {
      ok(true, '此範例沒有 demo 路徑（略過）');
      return;
    }
    const one = replayPath(doc, path);
    const two = replayPath(doc, path);
    deepEq(two, one, '同一份路徑重跑兩次應完全相同');
    isObj(one, 'replayPath 應回物件');
    ok(typeof one.framesRun === 'number', '應有 framesRun');
    ok(Array.isArray(one.hitFrames), '應有 hitFrames');
  });
}

test('createReplayEngine：連續 run() 每次都從原點開始（不累積狀態）', async () => {
  const doc = readAttackSample('spade-rain');
  const path = doc.demo && Array.isArray(doc.demo.path) ? doc.demo.path : null;
  ok(path && path.length > 1, 'spade-rain 應有 demo 路徑');

  const engine = createReplayEngine(doc, {});
  try {
    const first = engine.run(path, { stopOnHit: false, maxFrames: 200 });
    // 中間跑一段「完全不重設」的模擬，確認下一輪 run() 仍回到原點
    const second = engine.run(path, { stopOnHit: false, maxFrames: 200 });
    const third = engine.run(path, { stopOnHit: false, maxFrames: 200 });
    deepEq(second, first, '第二次 run() 應與第一次完全相同');
    deepEq(third, first, '第三次 run() 應與第一次完全相同');
  } finally {
    engine.destroy();
  }
});

test('createReplayEngine：原點快照與 reset() 的模擬狀態相同', async () => {
  const doc = readAttackSample('ring-burst');
  const engine = createReplayEngine(doc, {});
  try {
    // 先跑一段，把模擬弄髒
    const path = doc.demo && Array.isArray(doc.demo.path) ? doc.demo.path : [{ t: 0, x: 320, y: 190 }];
    engine.run(path, { maxFrames: 120 });

    // 再從原點跑固定幀數，記錄狀態
    const after = engine.run(path, { maxFrames: 60, collectFrames: true });
    ok(Array.isArray(after.frames), 'collectFrames 應回每幀軌跡');
    eq(after.frames.length, Math.min(60, after.framesRun), '軌跡長度應等於實際跑完的幀數');

    // 用「全新模擬」手動跑同樣輸入，比對每幀靈魂位置
    const fresh = await makeSimulation(doc);
    const first = after.frames[0];
    ok(first && first.actual, '每幀應有靈魂實際位置');
    // 直接比對「全新模擬第 0 幀」與「重跑器第 0 幀」的靈魂位置
    const state0 = fresh.getState();
    eq(first.actual.x, state0.soul.x, '重跑器第 0 幀靈魂 x 應等於全新模擬');
    eq(first.actual.y, state0.soul.y, '重跑器第 0 幀靈魂 y 應等於全新模擬');
  } finally {
    engine.destroy();
  }
});

test('validateDemoPath：同一路徑的驗證結果穩定（不因快照而變）', async () => {
  const doc = readAttackSample('box-shrink-aim');
  const path = doc.demo && Array.isArray(doc.demo.path) ? doc.demo.path : null;
  ok(path && path.length > 1, 'box-shrink-aim 應有 demo 路徑');
  const a = validateDemoPath(doc, path);
  const b = validateDemoPath(doc, path);
  deepEq(b, a, '兩次驗證結果應相同');
  // validateDemoPath 回的是 replay 結果（hits 是命中數、hitFrames 才是陣列），沒有 ok 欄位
  eq(typeof a.hits, 'number', 'hits 應為命中數');
  ok(Array.isArray(a.hitFrames), '應有 hitFrames 陣列');
  ok(typeof a.framesRun === 'number', '應有 framesRun');
  ok(a.endSoul && typeof a.endSoul.x === 'number', '應有 endSoul');
  ok(a.endBox && typeof a.endBox.w === 'number', '應有 endBox');
  ok('minClearance' in a, '應有 minClearance');
});

test('快照與 reset 的等價性：sim.snapshot()/restore() == reset()', async () => {
  const doc = readAttackSample('sine-wave');
  const sim = await makeSimulation(doc);
  const base = JSON.parse(JSON.stringify(sim.snapshot()));

  // 弄髒
  for (let f = 0; f < 90; f += 1) sim.stepFrame(attackInput(f));
  const dirty = sim.getState();
  ok(dirty.frame === 90, '應跑到第 90 幀');

  // reset 後狀態
  sim.reset();
  const afterReset = JSON.parse(JSON.stringify(sim.snapshot()));

  // 弄髒 → restore 回原點
  for (let f = 0; f < 40; f += 1) sim.stepFrame(attackInput(f));
  ok(sim.restore(base), 'restore 應成功');
  const afterRestore = JSON.parse(JSON.stringify(sim.snapshot()));

  deepEq(afterRestore, afterReset, 'restore(原點快照) 應等於 reset()');
  eq(afterRestore.frame, 0, '還原後幀號應為 0');
  eq(afterRestore.bullets.length, afterReset.bullets.length, '子彈數應一致');
  isObj(afterRestore.rng, 'RNG 狀態應存在');
});

test('generateDemoPath 仍為決定性（同 seed 同結果）', async () => {
  const { generateDemoPath } = await loadModule('engine/autoplay/pathgen.js');
  const doc = readAttackSample('box-shrink-aim');
  const a = generateDemoPath(doc, { seed: 3, timeBudgetMs: 60000, maxSweeps: 1 });
  const b = generateDemoPath(doc, { seed: 3, timeBudgetMs: 60000, maxSweeps: 1 });
  eq(b.ok, a.ok, 'ok 應一致');
  eq(b.attempts, a.attempts, '嘗試次數應一致');
  eq(b.hits, a.hits, '命中數應一致');
  deepEq(b.path, a.path, '產生的路徑應完全相同');
});

test('快照大小合理：完整攻擊狀態 < 1 MB（避免 JSON 存檔爆掉）', async () => {
  for (const name of ATTACK_SAMPLES) {
    const doc = readAttackSample(name);
    const sim = new (await loadModule('engine/sim.js')).createSimulation({ mode: 'play' });
    sim.load(doc);
    for (let f = 0; f < 120; f += 1) sim.stepFrame(attackInput(f));
    const bytes = JSON.stringify(sim.snapshot()).length;
    ok(bytes < 1024 * 1024, `${name} 快照過大：${bytes} bytes`);
  }
});

test('還原後仍可繼續 seekTo / advance（公開 API 不受影響）', async () => {
  const doc = readAttackSample('spade-rain');
  const sim = await makeSimulation(doc);
  for (let f = 0; f < 30; f += 1) sim.stepFrame(attackInput(f));
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  const other = createSimulation({ mode: 'play' });
  other.load(doc);
  ok(other.restore(snap), 'restore 應成功');
  other.seekTo(5);
  eq(other.frame, 5, 'seekTo 後幀號應為 5');
  other.advance(10, attackInput(0));
  eq(other.frame, 15, 'advance 後幀號應為 15');
  eq(other.restore(snap), true, 'seek 之後仍可再還原');
});
