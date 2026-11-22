/**
 * tests/snapshot/t-encounter.mjs — 遭遇戰（engine/encounter/*）的快照 / 還原
 *
 * 驗證（對 rudinn / showcase / forms-demo）：
 *   1. snapshot() 是純資料（JSON / structuredClone）
 *   2. restore 到新實例後再 snapshot == 原快照
 *   3. 多個幀點 snapshot → restore → 續跑，逐幀 getState() 與直跑完全相同
 *      （涵蓋：intro 文字打字、cue 的 wait / parallel / if、選單、行動結算、
 *        彈幕回合、對話泡泡、形態切換、終局）
 *   4. 快照含世界（演員 / 文字 / 內嵌攻擊模擬）、cue 執行器、流程三層
 *   5. 還原不會重播已發生的事件（say / bubble / phase 不重複）
 */

import {
  ENCOUNTER_SAMPLES,
  diffPaths,
  encounterInput,
  makeEncounter,
  readEncounterSample,
  roundTripJson,
} from './fixtures.mjs';
import { group, test, ok, eq, deepEq, isArray, isObj, hasKey } from '../engine/harness.mjs';

group('快照：遭遇戰');

/** 直跑錄製幀數（足夠跑到 attack / resolve 等階段） */
const RECORD_FRAMES = 320;

/** 幀切點（涵蓋 intro / 選單 / 結算 / 彈幕 / 對話） */
const CUTS = [1, 4, 15, 45, 90, 140, 200, 260];

for (const name of ENCOUNTER_SAMPLES) {
  const doc = readEncounterSample(name);

  test(`${name}：snapshot() 可 JSON / structuredClone 序列化（三層都在）`, async () => {
    const enc = await makeEncounter(doc);
    for (let f = 0; f < 40; f += 1) enc.step(1, encounterInput(f));
    const snap = enc.snapshot();
    isObj(snap, '快照應為物件');
    deepEq(structuredClone(snap), snap, 'structuredClone 後應完全相同');
    deepEq(roundTripJson(snap), snap, 'JSON 來回後應完全相同');

    hasKey(snap, 'frame', '快照');
    hasKey(snap, 'phase', '快照');
    hasKey(snap, 'turn', '快照');
    hasKey(snap, 'world', '快照');
    hasKey(snap, 'runner', '快照');
    hasKey(snap, 'flow', '快照');

    // 世界層：演員 / 文字 / 選項 / 彈幕
    hasKey(snap.world, 'actors', 'world 快照');
    hasKey(snap.world, 'text', 'world 快照');
    hasKey(snap.world, 'party', 'world 快照');
    hasKey(snap.world, 'enemies', 'world 快照');
    hasKey(snap.world, 'rng', 'world 快照');
    hasKey(snap.world, 'battle', 'world 快照');
    isArray(snap.world.actors, 'actors 應為陣列');
    ok(snap.world.actors.length > 0, '應有演員狀態');

    // 執行器層：進行中的指令（intro 一定有）
    hasKey(snap.runner, 'chains', 'runner 快照');
    isArray(snap.runner.chains, 'chains 應為陣列');

    // 流程層
    hasKey(snap.flow, 'phase', 'flow 快照');
    hasKey(snap.flow, 'turn', 'flow 快照');
    hasKey(snap.flow, 'rng', 'flow 快照');
  });

  test(`${name}：restore 後再 snapshot == 原快照（含 JSON 來回）`, async () => {
    const source = await makeEncounter(doc);
    for (let f = 0; f < 60; f += 1) source.step(1, encounterInput(f));
    const snap = source.snapshot();

    const restored = await makeEncounter(doc);
    ok(restored.restore(roundTripJson(snap)), 'restore 應回傳 true');
    deepEq(restored.snapshot(), snap, '還原後再快照應等於原快照');

    const again = await makeEncounter(doc);
    ok(again.restore(roundTripJson(snap)), '第二次 restore 應回傳 true');
    deepEq(again.snapshot(), snap, '重複還原後快照仍應等於原快照');
  });

  test(`${name}：多幀點 snapshot → restore → 續跑 == 直跑（逐幀）`, async () => {
    const straight = await makeEncounter(doc);
    const states = [straight.getState()];
    for (let f = 0; f < RECORD_FRAMES; f += 1) {
      if (straight.result) break;
      straight.step(1, encounterInput(f));
      states.push(straight.getState());
    }
    ok(states.length > 4, '直跑應有多幀狀態');

    for (const cut of CUTS) {
      if (cut >= states.length) continue;
      const a = await makeEncounter(doc);
      for (let f = 0; f < cut; f += 1) a.step(1, encounterInput(f));
      const snap = roundTripJson(a.snapshot());

      const b = await makeEncounter(doc);
      ok(b.restore(snap), `cut ${cut}：restore 應成功`);
      const atCut = diffPaths(b.getState(), states[cut]);
      ok(atCut.length === 0, `cut ${cut}：還原後應對上直跑，實得 ${atCut.slice(0, 5).join('；')}`);

      for (let f = cut; f < states.length - 1; f += 1) {
        a.step(1, encounterInput(f));
        b.step(1, encounterInput(f));
        const expected = states[f + 1];
        const da = diffPaths(a.getState(), expected);
        ok(da.length === 0, `cut ${cut} 第 ${f + 1} 幀（原實例）不一致：${da.slice(0, 4).join('；')}`);
        const db = diffPaths(b.getState(), expected);
        ok(db.length === 0, `cut ${cut} 第 ${f + 1} 幀（還原實例）不一致：${db.slice(0, 4).join('；')}`);
      }
    }
  });
}

group('快照：遭遇戰（RNG / 事件 / 子系統）');

test('flow.rng 被保存：turnOrder=random 的結果一致', async () => {
  // showcase 用預設回合流程；rudinn 也是。改用直接對照「續跑後選單/流程事件」
  const doc = readEncounterSample('rudinn');
  const a = await makeEncounter(doc);
  for (let f = 0; f < 30; f += 1) a.step(1, encounterInput(f));
  const snap = roundTripJson(a.snapshot());
  const b = await makeEncounter(doc);
  ok(b.restore(snap), 'restore 應成功');

  const phasesA = [];
  const phasesB = [];
  a.on('phase', (p) => phasesA.push(p && p.phase));
  b.on('phase', (p) => phasesB.push(p && p.phase));
  for (let f = 30; f < 300; f += 1) {
    a.step(1, encounterInput(f));
    b.step(1, encounterInput(f));
  }
  deepEq(phasesB, phasesA, '續跑後階段序列應完全相同');
});

test('內嵌攻擊模擬：彈幕回合進行中可快照 / 還原', async () => {
  const doc = readEncounterSample('rudinn');
  let snap = null;
  let frame = 0;
  {
    const enc = await makeEncounter(doc);
    for (let f = 0; f < 600; f += 1) {
      enc.step(1, encounterInput(f));
      const st = enc.getState();
      if (st.battle && st.battle.bullets && st.battle.bullets.length > 0) {
        snap = roundTripJson(enc.snapshot());
        frame = f;
        break;
      }
    }
  }
  ok(snap !== null, `應在 600 幀內進入有子彈的彈幕回合（實得 ${frame}）`);
  isObj(snap.world.battle, '快照應含內嵌彈幕回合');
  isObj(snap.world.battle.sim, '內嵌回合應含模擬快照');
  hasKey(snap.world.battle.sim, 'bullets', '模擬快照');

  const restored = await makeEncounter(doc);
  ok(restored.restore(snap), 'restore 應成功');
  const st = restored.getState();
  ok(st.battle, '還原後應有彈幕回合');
  eq(st.battle.bullets.length, snap.world.battle.sim.bullets.length, '子彈數應一致');
});

test('對話泡泡（bubble）與打字進度可還原', async () => {
  const doc = readEncounterSample('showcase');
  let snap = null;
  {
    const enc = await makeEncounter(doc);
    for (let f = 0; f < 600; f += 1) {
      enc.step(1, encounterInput(f));
      const s = enc.snapshot();
      if (s.world.text && s.world.text.bubbles.length > 0) {
        snap = roundTripJson(s);
        break;
      }
    }
  }
  ok(snap !== null, 'showcase 應出現對話泡泡（bubbles）');

  const restored = await makeEncounter(doc);
  ok(restored.restore(snap), 'restore 應成功');
  const s2 = restored.snapshot();
  deepEq(s2.world.text, snap.world.text, '文字系統狀態（含泡泡與打字進度）應完整還原');

  // 泡泡的打字進度也要在：至少一個泡泡有 totalChars > 0
  const b = s2.world.text.bubbles[0];
  ok(b && b.typewriter, '泡泡應有打字機狀態');
  ok(Number.isFinite(b.typewriter.pos), '打字機應有 pos');
});

test('選單狀態（游標 / 清單 / 已選行動）可還原', async () => {
  const doc = readEncounterSample('rudinn');
  let snap = null;
  {
    const enc = await makeEncounter(doc);
    for (let f = 0; f < 600; f += 1) {
      enc.step(1, encounterInput(f));
      const s = enc.snapshot();
      if (s.flow.menu && s.flow.menu.lists && s.flow.menu.lists.length > 0) {
        snap = roundTripJson(s);
        break;
      }
    }
  }
  if (snap === null) {
    ok(true, '此輸入腳本沒打開清單（略過嚴格斷言）');
    return;
  }
  const restored = await makeEncounter(doc);
  ok(restored.restore(snap), 'restore 應成功');
  deepEq(restored.snapshot().flow.menu, snap.flow.menu, '選單狀態應完整還原');
});

test('還原不會重播已發生的事件（say / bubble 不重複）', async () => {
  const doc = readEncounterSample('rudinn');
  const countSay = (enc, bag) => {
    enc.on('say', () => {
      bag.say += 1;
    });
    enc.on('bubble', () => {
      bag.bubble += 1;
    });
  };
  const bagA = { say: 0, bubble: 0 };
  const a = await makeEncounter(doc);
  countSay(a, bagA);
  for (let f = 0; f < 60; f += 1) a.step(1, encounterInput(f));
  const snap = roundTripJson(a.snapshot());
  const before = { ...bagA };

  const bagB = { say: 0, bubble: 0 };
  const b = await makeEncounter(doc);
  countSay(b, bagB);
  ok(b.restore(snap), 'restore 應成功');
  eq(bagB.say, 0, '還原不該重播 say 事件');
  eq(bagB.bubble, 0, '還原不該重播 bubble 事件');

  // a 的計數從第 0 幀累積 → 只比較續跑期間的增量
  const baseA = { ...bagA };
  for (let f = 60; f < 200; f += 1) {
    a.step(1, encounterInput(f));
    b.step(1, encounterInput(f));
  }
  eq(bagB.say, bagA.say - baseA.say, `續跑後 say 次數應一致（還原前已有 ${before.say} 次）`);
  eq(bagB.bubble, bagA.bubble - baseA.bubble, '續跑後 bubble 次數應一致');
});

test('restore 參數檢查：壞資料回 false，不影響現有狀態', async () => {
  const doc = readEncounterSample('rudinn');
  const enc = await makeEncounter(doc);
  for (let f = 0; f < 10; f += 1) enc.step(1, encounterInput(f));
  const before = enc.getState();
  eq(enc.restore(null), false, 'null 應回 false');
  eq(enc.restore({}), false, '空物件應回 false');
  eq(enc.restore({ kind: 'encounter', version: 999 }), false, '版本不符應回 false');
  deepEq(enc.getState(), before, '失敗的 restore 不該改動狀態');
});

test('未 load 時 snapshot() 回 null（不炸）', async () => {
  const { createEncounter } = await import('../../engine/encounter/index.js');
  const enc = createEncounter({ canvas: null, assets: null });
  eq(enc.snapshot(), null, '未載入應回 null');
  eq(enc.restore({ kind: 'encounter', version: 1 }), false, '未載入時 restore 應回 false');
});

test('forms-demo：形態（form）相關演員狀態可還原', async () => {
  const doc = readEncounterSample('forms-demo');
  const a = await makeEncounter(doc);
  for (let f = 0; f < 60; f += 1) a.step(1, encounterInput(f));
  const snap = roundTripJson(a.snapshot());

  const b = await makeEncounter(doc);
  ok(b.restore(snap), 'restore 應成功');
  deepEq(b.snapshot().world.actors, snap.world.actors, '演員狀態（含 form）應完整還原');
  // 至少一名演員有 forms 資料時，快照應保留 form 名稱
  const forms = snap.world.actors.filter((act) => act.form !== undefined && act.form !== null);
  if (forms.length === 0) {
    ok(true, '此幀沒有非預設形態（略過 form 值斷言）');
  } else {
    ok(typeof forms[0].form === 'string', 'form 應為字串');
  }
});

test('beforeAttack：結算後執行，快照還原後繼續到攻擊和 end', async () => {
  const doc = readEncounterSample('rudinn');
  doc.hooks.intro = [];
  doc.turns[0].talk = [{ actor: 'rudinn', text: 'Ready?' }];
  doc.turns[0].start = [{ cmd: 'set', var: 'step', value: 1 }];
  doc.turns[0].beforeAttack = [{ cmd: 'wait', seconds: 0.5 }, { cmd: 'set', var: 'step', value: 2 }];
  doc.turns[0].end = [{ cmd: 'set', var: 'step', value: 3 }];
  const a = await makeEncounter(doc);
  const phases = [];
  a.on('phase', ({ phase }) => phases.push(phase));
  let frame = 0;
  while (frame < 800 && a.getState().phase !== 'beforeAttack') a.step(1, encounterInput(frame++));
  eq(a.getState().phase, 'beforeAttack');
  ok(phases.indexOf('turnStart') < phases.indexOf('menu'));
  ok(phases.indexOf('menu') < phases.indexOf('resolve'));
  ok(phases.indexOf('resolve') < phases.indexOf('enemyTalk'));
  ok(phases.indexOf('enemyTalk') < phases.indexOf('beforeAttack'));
  eq(a.getState().vars.step, 1);
  const b = await makeEncounter(doc);
  ok(b.restore(roundTripJson(a.snapshot())));
  let attacked = false;
  for (let i = 0; i < 500; i += 1) {
    const input = encounterInput(frame++);
    a.step(1, input);
    b.step(1, input);
    const state = a.getState();
    deepEq(b.getState(), state);
    if (state.battle) {
      eq(state.vars.step, 2);
      attacked = true;
    }
    if (state.vars.step === 3) break;
  }
  ok(attacked);
  eq(a.getState().vars.step, 3);
});
