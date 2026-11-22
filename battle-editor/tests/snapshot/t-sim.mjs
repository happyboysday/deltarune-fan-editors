/**
 * tests/snapshot/t-sim.mjs — 攻擊模擬（engine/sim.js）的快照 / 還原
 *
 * 驗證（對四個攻擊範例）：
 *   1. snapshot() 是純資料：structuredClone / JSON.stringify 都成立
 *   2. restore 到新實例後「再 snapshot」== 原快照（含 JSON 來回）
 *   3. 多個幀點 snapshot → restore → 續跑，逐幀 getState() 與直跑完全相同
 *   4. 還原不依賴原實例（來源實例丟掉後仍可繼續跑）
 *   5. 還原不會重播已發生的事件 / 音效
 *   6. 快照包含 FX-GRAZE 的「已擦過」旗標（grazed）與子彈 memory
 */

import {
  ATTACK_SAMPLES,
  attackInput,
  diffPaths,
  loadModule,
  makeSimulation,
  readAttackSample,
} from './fixtures.mjs';
import { group, test, ok, eq, deepEq, isArray, isObj, hasKey } from '../engine/harness.mjs';

const { createSimulation } = await loadModule('engine/sim.js');

group('快照：攻擊模擬');

/** 每個範例錄製的幀數（不一定要跑到結束） */
const RECORD_FRAMES = 240;

/** 測試用的幀切點（0 = 剛載入；其餘涵蓋發射中 / 擦彈 / 收尾） */
const CUTS = [0, 1, 7, 33, 90, 150, 210];

/** JSON 來回（模擬存檔 / 讀檔） */
function roundTrip(value) {
  return JSON.parse(JSON.stringify(value));
}

for (const name of ATTACK_SAMPLES) {
  const doc = readAttackSample(name);

  test(`${name}：snapshot() 可 JSON / structuredClone 序列化`, async () => {
    const sim = await makeSimulation(doc);
    for (let f = 0; f < 60; f += 1) sim.stepFrame(attackInput(f));
    const snap = sim.snapshot();
    isObj(snap, '快照應為物件');
    ok(typeof structuredClone === 'function', 'Node 應有 structuredClone');
    deepEq(structuredClone(snap), snap, 'structuredClone 後應完全相同');
    deepEq(roundTrip(snap), snap, 'JSON 來回後應完全相同');

    hasKey(snap, 'frame', '快照');
    hasKey(snap, 'rng', '快照');
    hasKey(snap, 'bullets', '快照');
    hasKey(snap, 'scheduleCursor', '快照');
    hasKey(snap, 'emitters', '快照');
    hasKey(snap, 'soul', '快照');
    hasKey(snap, 'tp', '快照');
    hasKey(snap, 'sfxQueue', '快照');
    hasKey(snap, 'grazeFlash', '快照');
    hasKey(snap, 'hurtFlash', '快照');
    isArray(snap.bullets, 'bullets 應為陣列');
    if (snap.bullets.length > 0) {
      hasKey(snap.bullets[0], 'grazed', '子彈快照');
      hasKey(snap.bullets[0], 'mem', '子彈快照');
      hasKey(snap.bullets[0], 'hitbox', '子彈快照');
      hasKey(snap.bullets[0], 'fadeElapsed', '子彈快照');
      hasKey(snap.bullets[0], 'wasInside', '子彈快照');
    }
  });

  test(`${name}：restore 後再 snapshot == 原快照（含 JSON 來回）`, async () => {
    const source = await makeSimulation(doc);
    for (let f = 0; f < 71; f += 1) source.stepFrame(attackInput(f));
    const snap = source.snapshot();

    const restored = await makeSimulation(doc);
    ok(restored.restore(roundTrip(snap)), 'restore 應回傳 true');
    deepEq(restored.snapshot(), snap, '還原後再快照應等於原快照');

    const again = await makeSimulation(doc);
    ok(again.restore(roundTrip(snap)), '第二次 restore 應回傳 true');
    deepEq(again.snapshot(), snap, '重複還原後快照仍應等於原快照');
  });

  test(`${name}：多幀點 snapshot → restore → 續跑 == 直跑（逐幀）`, async () => {
    // 直跑錄製：states[i] = 走完 i 幀後的 getState()（states[0] = 初始狀態）
    const straight = await makeSimulation(doc);
    const states = [straight.getState()];
    for (let f = 0; f < RECORD_FRAMES; f += 1) {
      if (straight.ended) break;
      straight.stepFrame(attackInput(f));
      states.push(straight.getState());
    }
    ok(states.length > 2, '直跑應有狀態');

    for (const cut of CUTS) {
      if (cut >= states.length) continue;
      const a = await makeSimulation(doc);
      for (let f = 0; f < cut; f += 1) a.stepFrame(attackInput(f));
      const snap = roundTrip(a.snapshot());

      const b = await makeSimulation(doc);
      ok(b.restore(snap), `cut ${cut}：restore 應成功`);

      // 還原當下就應該等於直跑第 cut 幀
      const atCut = diffPaths(b.getState(), states[cut]);
      ok(atCut.length === 0, `cut ${cut}：還原後應對上直跑，實得 ${atCut.slice(0, 4).join('；')}`);

      for (let f = cut; f < states.length - 1; f += 1) {
        a.stepFrame(attackInput(f));
        b.stepFrame(attackInput(f));
        const expected = states[f + 1];
        const diffsA = diffPaths(a.getState(), expected);
        ok(diffsA.length === 0, `cut ${cut} 第 ${f + 1} 幀（原實例）不一致：${diffsA.slice(0, 4).join('；')}`);
        const diffsB = diffPaths(b.getState(), expected);
        ok(diffsB.length === 0, `cut ${cut} 第 ${f + 1} 幀（還原實例）不一致：${diffsB.slice(0, 4).join('；')}`);
      }
    }
  });
}

group('快照：攻擊模擬（RNG / 擦彈 / 事件）');

test('RNG 狀態被保存：還原後的子彈序列與直跑相同', async () => {
  const doc = readAttackSample('spade-rain');
  const a = await makeSimulation(doc);
  for (let f = 0; f < 45; f += 1) a.stepFrame(attackInput(f));
  const snap = roundTrip(a.snapshot());

  const b = await makeSimulation(doc);
  ok(b.restore(snap), 'restore 應成功');
  for (let f = 45; f < 200; f += 1) {
    a.stepFrame(attackInput(f));
    b.stepFrame(attackInput(f));
    const d = diffPaths(a.getState().bullets, b.getState().bullets);
    ok(d.length === 0, `第 ${f + 1} 幀子彈配置不一致：${d.slice(0, 3).join('；')}`);
  }
});

test('FX-GRAZE：已擦過的旗標（grazed）會被保存', async () => {
  const doc = readAttackSample('spade-rain');
  const sim = await makeSimulation(doc);
  let found = null;
  for (let f = 0; f < 300 && !found; f += 1) {
    sim.stepFrame(attackInput(f));
    for (const b of sim._state().bullets) {
      if (b.grazed) {
        found = { frame: f, id: b.id };
        break;
      }
    }
  }
  ok(found !== null, 'spade-rain 在 300 幀內應有擦彈');

  const snap = roundTrip(sim.snapshot());
  const hit = snap.bullets.find((b) => b.id === found.id);
  ok(hit, '快照應包含該子彈');
  eq(hit.grazed, true, '快照應保留 grazed 旗標');

  const restored = await makeSimulation(doc);
  ok(restored.restore(snap), 'restore 應成功');
  const raw = restored._state().bullets.find((b) => b.id === found.id);
  ok(raw, '還原後應有該子彈');
  eq(raw.grazed, true, '還原後 grazed 旗標應保持 true');
});

test('子彈 memory：快照存攤平後的數值，還原後仍可讀', async () => {
  // 現有四個範例都沒用到 memory（SPEC-EXPR-V2 §3），這裡用一個最小攻擊檔驗證：
  // emitter 的 spawn 帶 memory（num / phase），pathX 與 speed 都讀 mem.*
  const doc = {
    format: 'dr-battle-attack/1',
    meta: { name: 'memory-probe' },
    settings: { duration: 3, seed: 7 },
    box: { x: 320, y: 190, w: 240, h: 120 },
    soul: { x: 320, y: 190 },
    bulletTypes: {
      dot: { hitbox: { shape: 'circle', r: 4 }, sprite: null, speed: 30, angle: 90, grazeable: true },
    },
    timeline: [
      {
        id: 'e1',
        at: 0,
        type: 'emitter',
        duration: 2,
        interval: 0.1,
        count: 12,
        spawn: {
          bullet: 'dot',
          memory: { num: 'i', phase: 'i * 0.5 + 1' },
          pathX: 'x + sin(age * 2 + mem.phase) * 20',
          speed: '30 + mem.num * 2',
        },
      },
    ],
  };
  const sim = await makeSimulation(doc);
  let snapWithMem = null;
  for (let f = 0; f < 60 && !snapWithMem; f += 1) {
    sim.stepFrame(attackInput(f));
    const s = sim.snapshot();
    if (s.bullets.some((b) => b.mem && Object.keys(b.mem).length > 0)) snapWithMem = s;
  }
  ok(snapWithMem, '快照中應有帶 memory 的子彈（b.mem 是 Proxy，要用 snapshot 觀察）');

  const snap = roundTrip(snapWithMem);
  const entry = snap.bullets.find((b) => b.mem && Object.keys(b.mem).length > 0);
  ok(entry, '快照應包含帶 memory 的子彈');
  isObj(entry.mem, '子彈 memory 應為純物件（不是 Proxy）');
  ok(Object.keys(entry.mem).length >= 2, 'memory 應有多個名稱');
  ok(Number.isFinite(entry.mem.num), 'mem.num 應為數值');

  // 還原後：快照仍相同，且續跑的軌跡與直跑一致（讀同一個 mem 值）
  const restored = await makeSimulation(doc);
  ok(restored.restore(snap), 'restore 應成功');
  const again = roundTrip(restored.snapshot());
  deepEq(again.bullets, snap.bullets, '還原後子彈（含 memory）應完全相同');

  for (let f = 40; f < 90; f += 1) {
    sim.stepFrame(attackInput(f));
    restored.stepFrame(attackInput(f));
    const d = diffPaths(sim.getState().bullets, restored.getState().bullets);
    ok(d.length === 0, `第 ${f + 1} 幀（memory 子彈）不一致：${d.slice(0, 3).join('；')}`);
  }
});

test('事件游標：還原後不會重播已發生的事件（音效 / 事件計數一致）', async () => {
  const doc = readAttackSample('ring-burst');
  const counts = { graze: 0, hit: 0, error: 0 };
  const a = createSimulation({
    mode: 'play',
    onEvent: (evt) => {
      if (evt && evt.type && counts[evt.type] !== undefined) counts[evt.type] += 1;
    },
  });
  a.load(doc);
  for (let f = 0; f < 80; f += 1) a.stepFrame(attackInput(f));
  const snap = roundTrip(a.snapshot());

  const countsB = { graze: 0, hit: 0, error: 0 };
  const b = createSimulation({
    mode: 'play',
    onEvent: (evt) => {
      if (evt && evt.type && countsB[evt.type] !== undefined) countsB[evt.type] += 1;
    },
  });
  b.load(doc);
  ok(b.restore(snap), 'restore 應成功');
  eq(countsB.graze, 0, '還原不該重播 graze 事件');
  eq(countsB.hit, 0, '還原不該重播 hit 事件');

  // a 的事件數是從第 0 幀累積的；續跑前先記下基準，只比較「續跑期間」的增量
  const baseCounts = { ...counts };
  for (let f = 80; f < 160; f += 1) {
    a.stepFrame(attackInput(f));
    b.stepFrame(attackInput(f));
  }
  eq(countsB.graze, counts.graze - baseCounts.graze, '續跑後擦彈事件數應一致');
  eq(countsB.hit, counts.hit - baseCounts.hit, '續跑後命中事件數應一致');
  eq(countsB.error, counts.error - baseCounts.error, '續跑後錯誤事件數應一致');
});

test('音效佇列：快照保留未消費的 sfxQueue', async () => {
  const doc = readAttackSample('spade-rain');
  const sim = await makeSimulation(doc);
  let snap = null;
  for (let f = 0; f < 300; f += 1) {
    sim.stepFrame(attackInput(f));
    const s = sim.snapshot();
    if (s.sfxQueue.length > 0) {
      snap = roundTrip(s);
      break;
    }
  }
  ok(snap !== null, '應找到有 sfxQueue 的幀');
  const restored = await makeSimulation(doc);
  ok(restored.restore(snap), 'restore 應成功');
  deepEq(restored.snapshot().sfxQueue, snap.sfxQueue, '音效佇列應保留');
});

test('restore 參數檢查：壞資料回 false，不影響現有狀態', async () => {
  const doc = readAttackSample('spade-rain');
  const sim = await makeSimulation(doc);
  for (let f = 0; f < 10; f += 1) sim.stepFrame(attackInput(f));
  const before = sim.getState();
  eq(sim.restore(null), false, 'null 應回 false');
  eq(sim.restore({}), false, '空物件應回 false');
  eq(sim.restore({ version: 999, frame: 1, bullets: [] }), false, '版本不符應回 false');
  deepEq(sim.getState(), before, '失敗的 restore 不該改動狀態');
});

test('還原不需要原實例：來源實例丟掉後仍可續跑', async () => {
  const doc = readAttackSample('box-shrink-aim');
  let snap = null;
  {
    const source = await makeSimulation(doc);
    for (let f = 0; f < 50; f += 1) source.stepFrame(attackInput(f));
    snap = roundTrip(source.snapshot());
  }
  const restored = await makeSimulation(doc);
  ok(restored.restore(snap), 'restore 應成功');
  for (let f = 50; f < 110; f += 1) restored.stepFrame(attackInput(f));
  eq(restored.frame, 110, '幀號應前進到 110');
  isObj(restored.getState(), 'getState 應可用');
  isArray(restored.snapshot().bullets, '還原後仍可快照');
});
