/**
 * tests/encounter/t-cues.mjs — 演出指令執行器（SPEC-P2 §3）
 *
 * 測每一個指令的行為、序列阻塞語意、async / parallel / if、錯誤容錯。
 *
 * 注意：`world.update()` 推進演員 / 文字 / 彈幕，`runner.update()` 只推進指令，
 * 所以凡是要「等補間 / 等打字機 / 等彈幕」的測試都必須兩者都呼叫（用 env.step）。
 */

import { group, test, eq, ok, notOk, deepEq, isArray } from '../engine/harness.mjs';
import { createWorld, normalizeInput } from '../../engine/encounter/world.js';
import { createCueRunner } from '../../engine/encounter/cues.js';
import { normalizeEncounter } from '../../engine/encounter/schema.js';
import { baseEncounter, demoAttack, grazeAttack } from './fixtures.mjs';

/**
 * 建立「world + runner」測試環境。
 * @param {object} [over] 覆寫 baseEncounter
 */
function makeEnv(over = {}) {
  const enc = normalizeEncounter(baseEncounter(over));
  const events = [];
  const world = createWorld(enc, {
    fps: 30,
    resolvedAttacks: new Map([
      ['demoAttack', demoAttack()],
      ['grazeAttack', grazeAttack()],
    ]),
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const runner = createCueRunner(world, { fps: 30 });
  const env = {
    world,
    runner,
    events,
    /** 推進一幀（world + runner） */
    tick(raw) {
      const input = normalizeInput(raw || {});
      world.update(input);
      runner.update(input);
      return input;
    },
    /** 推進 n 幀 */
    step(n = 1, raw) {
      for (let i = 0; i < n; i += 1) env.tick(raw);
    },
    /** 推進直到 handle 完成（回傳用了幾幀，-1 = 逾時） */
    stepUntil(handle, frames = 600, raw) {
      if (handle.done) return 0;
      for (let i = 0; i < frames; i += 1) {
        env.tick(raw);
        if (handle.done) return i + 1;
      }
      return -1;
    },
  };
  return env;
}

/** 產生「第 N 幀按 Z」的輸入函式 */
function pressAt(frame, key = 'confirm') {
  return (i) => ({ press: i === frame ? [key] : [], hold: {} });
}

group('cues：序列基本語意');

test('run 建立序列；update 後立即指令同幀完成並移除', () => {
  const env = makeEnv();
  const h = env.runner.run([{ cmd: 'sfx', sound: 'snd_a' }], { label: 'test' });
  ok(env.runner.activeCount() >= 0, 'activeCount 可用');
  env.tick();
  ok(h.done, '立即指令一幀內完成');
  eq(env.runner.busy(), false, '完成後不再忙');
  deepEq(env.world.drainSfx(), ['snd_a'], '音效已送出');
});

test('空清單立刻完成', () => {
  const env = makeEnv();
  const h = env.runner.run([]);
  env.tick();
  ok(h.done, '空清單完成');
  eq(env.runner.busy(), false, '不忙');
});

test('同一幀內連續執行多條立即指令', () => {
  const env = makeEnv();
  env.runner.run([
    { cmd: 'set', var: 'a', value: 1 },
    { cmd: 'set', var: 'b', value: 2 },
    { cmd: 'set', var: 'c', value: 3 },
    { cmd: 'sfx', sound: 'snd_x' },
  ]);
  env.tick();
  eq(env.world.getVar('a'), 1, 'a');
  eq(env.world.getVar('b'), 2, 'b');
  eq(env.world.getVar('c'), 3, 'c');
  deepEq(env.world.drainSfx(), ['snd_x'], 'sfx 也跑了');
});

test('wait 阻塞指定秒數（1 秒 = 30 幀）', () => {
  const env = makeEnv();
  const h = env.runner.run([{ cmd: 'wait', seconds: 1 }]);
  const used = env.stepUntil(h, 90);
  ok(used >= 28 && used <= 31, `約 30 幀完成（實際 ${used}）`);
});

test('wait 後面還有指令時會依序接上', () => {
  const env = makeEnv();
  env.runner.run([
    { cmd: 'wait', seconds: 0.2 }, // 6 幀
    { cmd: 'set', var: 'after', value: 9 },
  ]);
  env.step(3);
  eq(env.world.getVar('after'), 0, '等待期間尚未執行');
  env.step(5);
  eq(env.world.getVar('after'), 9, '等待結束後執行');
});

group('cues：音效與音樂');

test('sfx 推入音效佇列', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'sfx', sound: 'snd_text' }]);
  env.tick();
  deepEq(env.world.drainSfx(), ['snd_text'], '音效名');
  deepEq(env.world.drainSfx(), [], '取完清空');
});

test('bgm 設定與停止', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'bgm', track: 'bgm_battle', fade: 0.5 }]);
  env.tick();
  eq(env.world.getBgm().track, 'bgm_battle', 'track');
  env.runner.run([{ cmd: 'bgm', track: null }]);
  env.tick();
  eq(env.world.getBgm().track, null, 'null = 停止');
});

group('cues：數值指令');

test('set 覆寫與 add 累加', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'set', var: 'x', value: 5 }]);
  env.tick();
  eq(env.world.getVar('x'), 5, 'set');
  env.runner.run([{ cmd: 'set', var: 'x', value: 3, op: 'add' }]);
  env.tick();
  eq(env.world.getVar('x'), 8, 'add');
});

test('set 的 value 可用表達式（含 var.xxx）', () => {
  const env = makeEnv();
  env.world.setVar('base', 4);
  env.runner.run([{ cmd: 'set', var: 'x', value: 'var.base * 3 + 1' }]);
  env.tick();
  eq(env.world.getVar('x'), 13, '表達式求值');
});

test('set 可引用 turn / tp', () => {
  const env = makeEnv();
  env.world.tp = 42;
  env.world.setTurn(2);
  env.runner.run([
    { cmd: 'set', var: 'a', value: 'tp' },
    { cmd: 'set', var: 'b', value: 'turn * 10' },
  ]);
  env.tick();
  eq(env.world.getVar('a'), 42, 'tp');
  eq(env.world.getVar('b'), 20, 'turn');
});

test('mercy 夾在 0..100', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'mercy', enemy: 'rudinn', amount: 250 }]);
  env.tick();
  eq(env.world.enemyById('rudinn').mercy, 100, '上限 100');
  env.runner.run([{ cmd: 'mercy', enemy: 'rudinn', amount: -500 }]);
  env.tick();
  eq(env.world.enemyById('rudinn').mercy, 0, '下限 0');
});

test('mercy 可用表達式', () => {
  const env = makeEnv();
  env.world.setVar('m', 30);
  env.runner.run([{ cmd: 'mercy', enemy: 'rudinn', amount: 'var.m + 5' }]);
  env.tick();
  eq(env.world.enemyById('rudinn').mercy, 35, '表達式');
});

test('heal 恢復隊員 HP 且不超過 maxHp', () => {
  const env = makeEnv();
  const kris = env.world.partyById('kris');
  kris.hp = 30;
  env.runner.run([{ cmd: 'heal', target: 'kris', amount: 20 }]);
  env.tick();
  eq(kris.hp, 50, '回復 20');
  env.runner.run([{ cmd: 'heal', target: 'kris', amount: 999 }]);
  env.tick();
  eq(kris.hp, 90, '不超過 maxHp');
});

test('heal target "party" 治療全隊', () => {
  const env = makeEnv();
  env.world.partyById('kris').hp = 10;
  env.runner.run([{ cmd: 'heal', target: 'party', amount: 5 }]);
  env.tick();
  eq(env.world.partyById('kris').hp, 15, '全隊治療');
});

test('damage 對隊員與敵人（可為表達式）', () => {
  const env = makeEnv();
  env.world.setVar('dmg', 7);
  env.runner.run([{ cmd: 'damage', target: 'kris', amount: 'var.dmg' }]);
  env.tick();
  eq(env.world.partyById('kris').hp, 83, '隊員扣血');
  env.runner.run([{ cmd: 'damage', target: 'rudinn', amount: 12 }]);
  env.tick();
  eq(env.world.enemyById('rudinn').hp, 108, '敵人扣血');
});

test('damage 打死敵人會讓 HP 歸零且標記 downed', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'damage', target: 'rudinn', amount: 999 }]);
  env.tick();
  const e = env.world.enemyById('rudinn');
  eq(e.hp, 0, 'HP 歸零');
  eq(e.downed, true, 'downed');
});

group('cues：演員指令');

test('move 阻塞到補間結束並精確到位', () => {
  const env = makeEnv();
  const h = env.runner.run([{ cmd: 'move', actor: 'rudinn', x: 300, y: 240, duration: 0.2 }]);
  env.tick();
  notOk(h.done, '補間中');
  const used = env.stepUntil(h, 40);
  ok(used > 0 && used <= 10, `約 6 幀完成（實際 ${used}）`);
  const a = env.world.actors.get('rudinn');
  eq(a.x, 300, 'x 終值');
  eq(a.y, 240, 'y 終值');
});

test('move duration 0 立即完成', () => {
  const env = makeEnv();
  const h = env.runner.run([{ cmd: 'move', actor: 'rudinn', x: 400, duration: 0 }]);
  env.tick();
  ok(h.done, '立即完成');
  eq(env.world.actors.get('rudinn').x, 400, '到位');
});

test('fade 阻塞到透明度補間結束', () => {
  const env = makeEnv();
  const h = env.runner.run([{ cmd: 'fade', actor: 'rudinn', alpha: 0.25, duration: 0.2 }]);
  env.tick();
  notOk(h.done, '補間中');
  const used = env.stepUntil(h, 40);
  ok(used > 0 && used <= 10, `約 6 幀完成（實際 ${used}）`);
  eq(env.world.actors.get('rudinn').alpha, 0.25, 'alpha 終值');
});

test('flip 立即生效', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'flip', actor: 'rudinn', value: true }]);
  env.tick();
  eq(env.world.actors.get('rudinn').flip, true, '翻轉');
});

test('anim 切換動畫狀態', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'anim', actor: 'rudinn', anim: 'hurt' }]);
  env.tick();
  eq(env.world.actors.get('rudinn').animName, 'hurt', 'hurt 狀態');
});

test('anim waitEnd 會等到非循環動畫播完', () => {
  const env = makeEnv();
  // hurt：10fps、4 幀 → 0.4 秒 = 12 幀
  const h = env.runner.run([{ cmd: 'anim', actor: 'rudinn', anim: 'hurt', waitEnd: true }]);
  env.tick();
  notOk(h.done, '尚未播完');
  const used = env.stepUntil(h, 60);
  ok(used > 0 && used <= 20, `約 12 幀播完（實際 ${used}）`);
});

test('anim 找不到演員時回報錯誤但不中斷', () => {
  const env = makeEnv();
  const h = env.runner.run([
    { cmd: 'anim', actor: 'ghost', anim: 'idle' },
    { cmd: 'sfx', sound: 'snd_after' },
  ]);
  env.tick();
  ok(h.done, '序列照常跑完');
  ok(env.events.some((e) => e.type === 'error'), '有 error 事件');
});

test('anim 既沒 anim 也沒 sprite 時回報錯誤', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'anim', actor: 'rudinn' }]);
  env.tick();
  ok(env.events.some((e) => e.type === 'error'), '有 error 事件');
});

group('cues：文字指令');

test('say 阻塞直到按 Z 兩次（先全顯示、再關閉）', () => {
  const env = makeEnv();
  const h = env.runner.run([{ cmd: 'say', text: '* 你好', speed: 0.1 }]);
  env.tick();
  notOk(h.done, '打字中');
  ok(env.world.text.busy(), '文字系統忙');
  // 第一次 Z：全部顯示
  env.tick({ press: ['confirm'], hold: {} });
  notOk(h.done, '全顯示後還不算完成（要再按一次關閉）');
  eq(env.world.text.snapshotTextbox().done, true, '已全部顯示');
  // 第二次 Z：關閉
  env.tick({ press: ['confirm'], hold: {} });
  ok(h.done, '關閉後完成');
});

test('打字機自動打完後仍需按 Z 關閉', () => {
  const env = makeEnv();
  const h = env.runner.run([{ cmd: 'say', text: 'abc', speed: 1 }]);
  env.step(5);
  eq(env.world.text.snapshotTextbox().done, true, '已打完');
  notOk(h.done, '還沒關閉');
  env.tick({ press: ['confirm'], hold: {} });
  ok(h.done, '按 Z 後完成');
});

test('bubble 阻塞到按 Z', () => {
  const env = makeEnv();
  const h = env.runner.run([{ cmd: 'bubble', actor: 'rudinn', text: '* 嘿', speed: 10 }]);
  env.step(2);
  notOk(h.done, '還在顯示');
  env.tick({ press: ['confirm'], hold: {} });
  env.tick({ press: ['confirm'], hold: {} });
  ok(h.done, '按鍵後完成');
});

test('say 支援雙語（{zh,en}）', () => {
  const env = makeEnv();
  env.world.setLang('en');
  env.runner.run([{ cmd: 'say', text: { zh: '簡體', en: 'English' }, speed: 100 }]);
  // 第 1 幀：world.update 先跑（此時文字框還沒建立），runner.update 才啟動指令
  // 第 2 幀：打字機才推進 → 因此要兩幀才看得到字
  env.step(2);
  eq(env.world.text.snapshotTextbox().lines[0].text, 'English', 'en 取英文');
});

test('say 依 lang 切換語言', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'say', text: { zh: '簡體', en: 'English' }, speed: 100, async: true }]);
  env.step(2);
  eq(env.world.text.snapshotTextbox().lines[0].text, '簡體', '預設 zh');
  env.world.text.clear();
  env.world.setLang('en');
  env.runner.run([{ cmd: 'say', text: { zh: '簡體', en: 'English' }, speed: 100, async: true }]);
  env.step(2);
  eq(env.world.text.snapshotTextbox().lines[0].text, 'English', 'en');
});

test('say 支援 {w} 與 {s} 標記', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'say', text: 'a{w:10}b', speed: 1 }]);
  env.step(2);
  eq(env.world.text.snapshotTextbox().visibleChars, 1, '停在 {w}');
  env.step(12);
  eq(env.world.text.snapshotTextbox().visibleChars, 2, '{w} 後繼續');
});

group('cues：if 與 parallel');

test('if 條件為真執行 then', () => {
  const env = makeEnv();
  env.world.setVar('flag', 1);
  env.runner.run([
    {
      cmd: 'if',
      cond: 'var.flag',
      then: [{ cmd: 'set', var: 'r', value: 1 }],
      else: [{ cmd: 'set', var: 'r', value: 2 }],
    },
  ]);
  env.tick();
  eq(env.world.getVar('r'), 1, 'then');
});

test('if 條件為假執行 else', () => {
  const env = makeEnv();
  env.world.setVar('flag', 0);
  env.runner.run([
    {
      cmd: 'if',
      cond: 'var.flag',
      then: [{ cmd: 'set', var: 'r', value: 1 }],
      else: [{ cmd: 'set', var: 'r', value: 2 }],
    },
  ]);
  env.tick();
  eq(env.world.getVar('r'), 2, 'else');
});

test('if 沒有 else 且條件為假 → 立刻完成', () => {
  const env = makeEnv();
  const h = env.runner.run([{ cmd: 'if', cond: 0, then: [{ cmd: 'set', var: 'r', value: 1 }] }]);
  env.tick();
  ok(h.done, '完成');
  eq(env.world.getVar('r'), 0, 'then 沒跑');
});

test('if 使用 hp.xxx 查表判斷', () => {
  const env = makeEnv();
  env.world.partyById('kris').hp = 20;
  env.runner.run([
    {
      cmd: 'if',
      cond: 'hp.kris < 30',
      then: [{ cmd: 'set', var: 'low', value: 1 }],
    },
  ]);
  env.tick();
  eq(env.world.getVar('low'), 1, '低血判斷成立');
});

test('if 的內部分支可以是阻塞指令', () => {
  const env = makeEnv();
  const h = env.runner.run([
    {
      cmd: 'if',
      cond: 1,
      then: [{ cmd: 'wait', seconds: 0.2 }, { cmd: 'set', var: 'done', value: 1 }],
    },
    { cmd: 'set', var: 'after', value: 1 },
  ]);
  env.tick();
  notOk(h.done, '等待中');
  ok(!env.world.getVar('after'), '後續還沒跑');
  env.step(10);
  ok(h.done, '完成');
  eq(env.world.getVar('done'), 1, '分支跑完');
  eq(env.world.getVar('after'), 1, '後續跑完');
});

test('parallel 同時執行，總時長為最長者', () => {
  const env = makeEnv();
  const h = env.runner.run([
    {
      cmd: 'parallel',
      cues: [
        { cmd: 'move', actor: 'rudinn', x: 500, duration: 0.5 },
        { cmd: 'sfx', sound: 'snd_a' },
        { cmd: 'wait', seconds: 0.1 },
      ],
    },
  ]);
  env.tick();
  deepEq(env.world.drainSfx(), ['snd_a'], '立即指令已跑');
  notOk(h.done, '還在等最長的 move');
  const used = env.stepUntil(h, 60);
  ok(used > 0 && used <= 20, `約 15 幀完成（實際 ${used}）`);
  eq(env.world.actors.get('rudinn').x, 500, 'move 也到位');
});

test('parallel 內各分支獨立（不會被其中一條卡住）', () => {
  const env = makeEnv();
  env.runner.run([
    {
      cmd: 'parallel',
      cues: [
        { cmd: 'wait', seconds: 0.05 },
        { cmd: 'set', var: 'quick', value: 1 },
      ],
    },
  ]);
  env.tick();
  eq(env.world.getVar('quick'), 1, '短分支已完成');
});

test('巢狀 if 在 parallel 裡', () => {
  const env = makeEnv();
  env.world.setVar('a', 1);
  env.runner.run([
    {
      cmd: 'parallel',
      cues: [
        { cmd: 'if', cond: 'var.a', then: [{ cmd: 'set', var: 'x', value: 10 }] },
        { cmd: 'wait', seconds: 0.05 },
      ],
    },
  ]);
  env.tick();
  eq(env.world.getVar('x'), 10, '巢狀 if 生效');
});

group('cues：async 與序列控制');

test('async:true 不阻塞序列', () => {
  const env = makeEnv();
  env.runner.run([
    { cmd: 'wait', seconds: 1, async: true },
    { cmd: 'set', var: 'next', value: 1 },
  ]);
  env.tick();
  eq(env.world.getVar('next'), 1, '後續指令同幀執行');
});

test('async 指令仍會被 runner 追蹤', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'wait', seconds: 0.3, async: true }]);
  env.tick();
  ok(env.runner.busyAsync(), '還在追蹤 async');
  env.step(12);
  notOk(env.runner.busyAsync(), '結束後清掉');
});

test('async 的 say 不會卡住主序列', () => {
  const env = makeEnv();
  env.runner.run([
    { cmd: 'say', text: '* 旁白', speed: 0.05, async: true },
    { cmd: 'set', var: 'ok', value: 1 },
  ]);
  env.tick();
  eq(env.world.getVar('ok'), 1, '主序列繼續');
  ok(env.runner.busyAsync(), '旁白仍在跑');
});

test('clear 取消所有指令', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'say', text: '* 很長很長的台詞', speed: 0.05 }]);
  env.tick();
  ok(env.world.text.busy(), '文字顯示中');
  env.runner.clear();
  eq(env.runner.busy(), false, '不忙');
  notOk(env.world.text.busy(), '文字被清掉');
});

test('run 的 replace 會先取消既有序列', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'say', text: '* 第一段', speed: 0.05 }]);
  env.tick();
  env.runner.run([{ cmd: 'say', text: '* 第二段', speed: 100 }], { replace: true });
  env.tick();
  ok(!env.world.text.snapshotTextbox().lines[0].text.includes('第一段'), '舊文字被換掉');
});

test('labels 回傳進行中序列的標籤', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'wait', seconds: 1 }], { label: 'intro' });
  env.tick();
  isArray(env.runner.labels(), 'labels 是陣列');
  ok(env.runner.labels().includes('intro'), '含 intro');
});

group('cues：attack 與 end');

test('attack 指令阻塞到彈幕結束', () => {
  const env = makeEnv();
  const h = env.runner.run([{ cmd: 'attack', attack: 'demoAttack' }]);
  env.tick();
  notOk(h.done, '彈幕進行中');
  ok(env.world.attackActive(), 'world 有彈幕回合');
  ok(env.events.some((e) => e.type === 'attackStart'), '有 attackStart 事件');
  const used = env.stepUntil(h, 120);
  ok(used > 0, `彈幕結束後完成（實際 ${used} 幀）`);
  ok(env.events.some((e) => e.type === 'attackEnd'), '有 attackEnd 事件');
});

test('attack 參照不存在時回報錯誤但不中斷', () => {
  const env = makeEnv();
  const h = env.runner.run([
    { cmd: 'attack', attack: 'no-such-attack' },
    { cmd: 'sfx', sound: 'snd_after' },
  ]);
  env.tick();
  ok(h.done, '序列照常跑完');
  ok(env.events.some((e) => e.type === 'error'), '有 error 事件');
});

test('end 設定結束請求', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'end', result: 'spared' }]);
  env.tick();
  eq(env.world.consumeEndRequest(), 'spared', '請求 spared');
  eq(env.world.consumeEndRequest(), null, '取完清空');
});

test('end 的非法 result 退回 victory', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'end', result: 'nonsense' }]);
  env.tick();
  eq(env.world.consumeEndRequest(), 'victory', '退回 victory');
});

group('cues：容錯');

test('未知指令回報錯誤並繼續下一條', () => {
  const env = makeEnv();
  const h = env.runner.run([
    { cmd: 'not-a-cmd' },
    { cmd: 'set', var: 'after', value: 1 },
  ]);
  env.tick();
  ok(h.done, '完成');
  eq(env.world.getVar('after'), 1, '後續照跑');
  ok(env.events.some((e) => e.type === 'error' && /未知的指令/.test(e.payload.message)), '錯誤訊息');
});

test('表達式錯誤取 0 且不中斷', () => {
  const env = makeEnv();
  const h = env.runner.run([
    { cmd: 'set', var: 'x', value: 'this is not valid' },
    { cmd: 'set', var: 'y', value: 3 },
  ]);
  env.tick();
  ok(h.done, '完成');
  eq(env.world.getVar('x'), 0, '錯誤取 0');
  eq(env.world.getVar('y'), 3, '後續照跑');
  ok(env.events.some((e) => e.type === 'error'), '有 error 事件');
});

test('set 缺 var 參數時回報錯誤', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'set', value: 1 }]);
  env.tick();
  ok(env.events.some((e) => e.type === 'error'), 'set 缺 var 有錯誤');
});

test('startCue 可單獨執行一條指令（編輯器預覽用）', () => {
  const env = makeEnv();
  const h = env.runner.startCue({ cmd: 'set', var: 'single', value: 7 });
  ok(h.done, '立即完成');
  eq(env.world.getVar('single'), 7, '已生效');
});

group('cues：鏡頭指令');

test('shake 有震動並在時間內衰減回 0', () => {
  const env = makeEnv();
  env.world.startShake(6, 0.2);
  const seen = [];
  for (let i = 0; i < 10; i += 1) {
    env.world.update(normalizeInput({}));
    seen.push(env.world.snapshot().shake);
  }
  ok(seen.some((s) => Math.abs(s.x) > 0 || Math.abs(s.y) > 0), '有非零位移');
  const last = seen[seen.length - 1];
  eq(last.x, 0, '結束後 x 歸零');
  eq(last.y, 0, '結束後 y 歸零');
});

test('flash 建立閃光並逐幀淡出', () => {
  const env = makeEnv();
  env.world.startFlash('#ffffff', 0.2);
  eq(env.world.snapshot().flash.alpha, 1, '從 1 開始');
  env.world.update(normalizeInput({}));
  ok(env.world.snapshot().flash.alpha < 1, '淡出中');
  for (let i = 0; i < 10; i += 1) env.world.update(normalizeInput({}));
  eq(env.world.snapshot().flash.alpha, 0, '歸零');
});

group('cues：輸入工具');

test('normalizeInput 產生 has / dx / dy / slow', () => {
  const i1 = normalizeInput({ press: ['confirm'], hold: { right: true, slow: true } });
  eq(i1.has('confirm'), true, 'has confirm');
  eq(i1.has('cancel'), false, 'has cancel = false');
  eq(i1.dx, 1, 'dx');
  eq(i1.dy, 0, 'dy');
  eq(i1.slow, true, 'slow');
  const i2 = normalizeInput({ hold: { left: true, up: true } });
  eq(i2.dx, -1, '左');
  eq(i2.dy, -1, '上');
  // 明確給的方向 / 慢速優先（bot 與輸入腳本用 {dx,dy,slow}）
  const i3 = normalizeInput({ dx: -1, dy: 1, slow: true });
  eq(i3.dx, -1, '明確 dx 優先');
  eq(i3.dy, 1, '明確 dy 優先');
  eq(i3.slow, true, '明確 slow 優先');
  const i4 = normalizeInput({ dx: 0, dy: 0, slow: false, hold: { right: true, down: true, slow: true } });
  eq(i4.dx, 0, '明確 dx=0 覆蓋 hold');
  eq(i4.dy, 0, '明確 dy=0 覆蓋 hold');
  eq(i4.slow, false, '明確 slow=false 覆蓋 hold');
});

test('normalizeInput 對空輸入安全', () => {
  const i = normalizeInput();
  eq(i.press.length, 0, '空 press');
  eq(i.dx, 0, 'dx 0');
  eq(i.has('confirm'), false, 'has false');
});
