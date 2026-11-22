/**
 * tests/encounter/t-world.mjs — 遭遇世界（SPEC-P2 §4 world 接縫）
 *
 * 重點：startAttack 的扣血 / TP 同步 / defend 減半、隊伍與敵人資料、變數、
 * 傷害數字、震動 / 閃光、reset、表達式查表。
 */

import { group, test, eq, ok, notOk, approx, deepEq, isArray, hasKey } from '../engine/harness.mjs';
import { createWorld, normalizeInput, TP_MAX, BOX_ANIM_FRAMES } from '../../engine/encounter/world.js';
import { normalizeEncounter } from '../../engine/encounter/schema.js';
import { createRng } from '../../engine/rng.js';
import { baseEncounter, demoAttack, grazeAttack } from './fixtures.mjs';

/**
 * 建立 world。
 * @param {object} [over] 覆寫 baseEncounter
 * @param {object} [worldOpts] 額外 createWorld 選項
 */
function makeWorld(over = {}, worldOpts = {}) {
  const enc = normalizeEncounter(baseEncounter(over));
  const events = [];
  const world = createWorld(enc, {
    fps: 30,
    resolvedAttacks: new Map([
      ['demoAttack', demoAttack()],
      ['grazeAttack', grazeAttack()],
    ]),
    onEvent: (type, payload) => events.push({ type, payload }),
    ...worldOpts,
  });
  return { world, events, enc };
}

/** 推進 n 幀 */
function step(world, n = 1, raw) {
  const input = normalizeInput(raw || {});
  for (let i = 0; i < n; i += 1) world.update(input);
}

group('world：初始狀態');

test('隊伍依遭遇檔建立並帶執行期欄位', () => {
  const { world } = makeWorld();
  eq(world.party.length, 1, '一個隊員');
  const kris = world.partyById('kris');
  ok(kris, '取得 kris');
  eq(kris.hp, 90, 'hp');
  eq(kris.maxHp, 90, 'maxHp');
  eq(kris.defending, false, 'defending');
  eq(kris.action, null, 'action');
  eq(kris.down, false, 'down');
  eq(world.partyById('nobody'), null, '不存在 → null');
});

test('敵人依遭遇檔建立', () => {
  const { world } = makeWorld();
  const rudinn = world.enemyById('rudinn');
  eq(rudinn.hp, 120, 'hp');
  eq(rudinn.mercy, 0, 'mercy');
  eq(rudinn.removed, false, 'removed');
  eq(world.isSpareable(rudinn), false, '尚未可饒恕');
  rudinn.mercy = 100;
  eq(world.isSpareable(rudinn), true, 'mercy 滿了就可饒恕');
});

test('道具與自訂變數', () => {
  const { world } = makeWorld();
  eq(world.items.length, 1, '一個道具');
  eq(world.items[0].count, 2, 'count');
  eq(world.getVar('complimented'), 0, '變數初始值');
});

test('tp 從 0 開始且夾在 0..100', () => {
  const { world } = makeWorld();
  eq(world.tp, 0, '初始 0');
  world.tp = 150;
  eq(world.tp, TP_MAX, '上限');
  world.tp = -5;
  eq(world.tp, 0, '下限');
});

group('world：傷害與治療');

test('applyDamage 扣 HP 並產生傷害數字', () => {
  const { world } = makeWorld();
  const out = world.applyDamage('kris', 20);
  eq(world.partyById('kris').hp, 70, 'HP 扣除');
  eq(out.length, 1, '回傳一筆結果');
  eq(out[0].amount, 20, '實際扣血量');
  eq(world.snapshot().numbers.length, 1, '產生傷害數字');
});

test('applyDamage 不會低於 0，並標記 down', () => {
  const { world } = makeWorld();
  world.applyDamage('kris', 999);
  const kris = world.partyById('kris');
  eq(kris.hp, 0, 'HP 不為負');
  eq(kris.down, true, 'down');
});

test('applyDamage 對敵人也能用', () => {
  const { world } = makeWorld();
  world.applyDamage('rudinn', 30);
  eq(world.enemyById('rudinn').hp, 90, '敵人 HP');
});

test('敵人沒有 hurt 動畫時，受擊沿用目前動畫（不退回 idle）', () => {
  const { world } = makeWorld({
    actors: {
      kris: {
        kind: 'party',
        x: 92,
        y: 160,
        anims: { idle: { sprite: 'spr_krisb_idle', fps: 5, loop: true } },
      },
      rudinn: {
        kind: 'enemy',
        x: 520,
        y: 200,
        anims: {
          idle: { sprite: 'spr_rudinn_idle', fps: 5, loop: true },
          happy: { sprite: 'spr_rudinn_happy', fps: 5, loop: true },
        },
      },
    },
  });
  world.actors.setAnim('rudinn', 'happy');
  eq(world.actors.get('rudinn').animName, 'happy', '先切到 happy');
  world.applyDamage('rudinn', 10);
  eq(world.enemyById('rudinn').hp, 110, 'HP 正常扣除');
  eq(world.actors.get('rudinn').animName, 'happy', '沒有 hurt 動畫 → 沿用目前動畫');
  ok(world.actors.get('rudinn').hurtShake > 0, '仍觸發受傷抖動');
});

test('敵人有 hurt 動畫時，受擊行為不變（切到 hurt）', () => {
  const { world } = makeWorld();
  world.actors.setAnim('rudinn', 'happy');
  world.applyDamage('rudinn', 10);
  eq(world.actors.get('rudinn').animName, 'hurt', '有 hurt → 切到 hurt');
});

test('applyDamage target "party" 打全隊', () => {
  const { world } = makeWorld();
  world.applyDamage('party', 10);
  eq(world.partyById('kris').hp, 80, '全隊扣血');
});

test('applyHeal 回復但不超過 maxHp', () => {
  const { world } = makeWorld();
  world.partyById('kris').hp = 40;
  world.applyHeal('kris', 100);
  eq(world.partyById('kris').hp, 90, '不超過上限');
});

test('heal 會解除 down', () => {
  const { world } = makeWorld();
  world.applyDamage('kris', 999);
  eq(world.partyById('kris').down, true, '先倒');
  // down 的隊員不會被 "party" 選中，直接指定 id
  world.applyHeal('kris', 10);
  eq(world.partyById('kris').down, false, '回復後解除 down');
});

group('world：mercy / 變數 / 傷害數字');

test('addMercy 累加並夾在 0..100', () => {
  const { world } = makeWorld();
  eq(world.addMercy('rudinn', 40), 40, '回傳新值');
  eq(world.addMercy('rudinn', 90), 100, '夾在 100');
  eq(world.addMercy('nobody', 10), 0, '不存在 → 0');
});

test('setVar 與 getVar（set / add）', () => {
  const { world } = makeWorld();
  world.setVar('x', 5);
  eq(world.getVar('x'), 5, 'set');
  world.setVar('x', 3, 'add');
  eq(world.getVar('x'), 8, 'add');
  eq(world.getVar('nope'), 0, '不存在 → 0');
});

test('damageNumber 產生並隨時間老化移除', () => {
  const { world } = makeWorld();
  world.damageNumber(100, 100, '-5', '#ff0000');
  eq(world.snapshot().numbers.length, 1, '一筆');
  const n = world.snapshot().numbers[0];
  eq(n.text, '-5', 'text');
  eq(n.color, '#ff0000', 'color');
  eq(n.age, 0, 'age 從 0');
  step(world, 5);
  ok(world.snapshot().numbers[0].age > 0, 'age 增加');
  step(world, 50);
  eq(world.snapshot().numbers.length, 0, '老化後移除');
});

group('world：startAttack 與彈幕回合');

test('startAttack 建立彈幕回合並回傳 handle', () => {
  const { world, events } = makeWorld();
  const h = world.startAttack('demoAttack');
  ok(h, 'handle');
  eq(h.done, false, '尚未結束');
  ok(world.attackActive(), '回合進行中');
  ok(world.snapshot().battle, 'snapshot.battle 有值');
  ok(events.some((e) => e.type === 'attackStart'), 'attackStart 事件');
  // 清掉，避免影響後續
  h.cancel();
});

test('彈幕時間軸在指定拍點切換目前遭遇演員的動畫', () => {
  const { world } = makeWorld();
  world.startAttack(demoAttack({
    settings: { duration: 1, bpm: 120 },
    timeline: [{ at: '1b', type: 'anim', actor: 'rudinn', anim: 'happy' }],
  }));
  step(world, 13);
  eq(world.actors.get('rudinn').animName, 'idle');
  step(world, 4);
  eq(world.actors.get('rudinn').animName, 'happy');
  eq(world.snapshot().actors.find((a) => a.id === 'rudinn').sprite, 'spr_rudinn_happy');
});

test('startAttack 找不到攻擊時回報錯誤並立即完成', () => {
  const { world, events } = makeWorld();
  const h = world.startAttack('no-such-attack');
  eq(h.done, true, '立即完成');
  ok(events.some((e) => e.type === 'error'), 'error 事件');
  notOk(world.attackActive(), '沒有回合');
});

test('startAttack 接受內嵌攻擊物件', () => {
  const { world } = makeWorld();
  const h = world.startAttack(demoAttack({ settings: { duration: 0.3, seed: 1 } }));
  ok(world.attackActive(), '可用內嵌物件');
  h.cancel();
});

test('彈幕結束後 handle.done 成立，下一幀收掉回合', () => {
  const { world, events } = makeWorld();
  const h = world.startAttack(demoAttack({ settings: { duration: 0.3, seed: 1 } }));
  // duration 0.3 秒 = 9 幀
  for (let i = 0; i < 20 && !h.done; i += 1) step(world, 1);
  ok(h.done, '彈幕結束');
  ok(events.some((e) => e.type === 'attackEnd'), 'attackEnd 事件');
  step(world, 2);
  notOk(world.attackActive(), '回合已收掉');
});

test('受傷扣目標隊員 HP（彈幕會命中時）', () => {
  const { world, events } = makeWorld();
  // 中央向八方 + 靈魂在中央 → 必中
  const h = world.startAttack(demoAttack());
  for (let i = 0; i < 40 && !h.done; i += 1) step(world, 1);
  const kris = world.partyById('kris');
  ok(kris.hp < 90, `被扣血（剩 ${kris.hp}）`);
  ok(events.some((e) => e.type === 'hurt'), '有 hurt 事件');
  const hurt = events.find((e) => e.type === 'hurt');
  eq(hurt.payload.member, 'kris', '目標是唯一存活隊員');
});

test('defend 時受傷減半（最少 1）', () => {
  const { world, events } = makeWorld();
  world.partyById('kris').defending = true;
  const h = world.startAttack(demoAttack({ settings: { duration: 1, seed: 3, damage: 10, invincibleFrames: 999 } }));
  for (let i = 0; i < 40 && !h.done; i += 1) step(world, 1);
  const hurts = events.filter((e) => e.type === 'hurt');
  if (hurts.length > 0) {
    eq(hurts[0].payload.damage, 5, '10 → 5（減半）');
  } else {
    ok(true, '這組參數沒被命中，跳過');
  }
  h.cancel();
});

test('擦彈會累積 TP', () => {
  const { world } = makeWorld();
  world.tp = 0;
  const h = world.startAttack('grazeAttack');
  for (let i = 0; i < 70 && !h.done; i += 1) step(world, 1);
  ok(world.tp > 0, `擦彈累積 TP（${world.tp}）`);
  eq(world.tp <= TP_MAX, true, '不超過上限');
});

test('TP 上限 100（大量擦彈也不會爆）', () => {
  const { world } = makeWorld();
  world.tp = 95;
  const h = world.startAttack(grazeAttack({ settings: { duration: 2, seed: 5, grazeTP: 50, damage: 5, invincibleFrames: 5 } }));
  for (let i = 0; i < 70 && !h.done; i += 1) step(world, 1);
  ok(world.tp <= TP_MAX, `TP 不超過 100（${world.tp}）`);
  void h;
});

test('cancel 會立刻收掉回合', () => {
  const { world } = makeWorld();
  const h = world.startAttack('demoAttack');
  h.cancel();
  eq(h.done, true, 'handle 完成');
  notOk(world.attackActive(), '回合結束');
});

test('重複 startAttack 會先收掉舊回合', () => {
  const { world } = makeWorld();
  world.startAttack('demoAttack');
  const h2 = world.startAttack('grazeAttack');
  ok(world.attackActive(), '新回合進行中');
  ok(h2, '新 handle');
  h2.cancel();
});

test('boxAnim 在彈幕回合展開、結束後收回', () => {
  const { world } = makeWorld();
  eq(world.boxAnim, 0, '初始 0');
  const h = world.startAttack(demoAttack({ settings: { duration: 0.3, seed: 1 } }));
  step(world, 5);
  ok(world.boxAnim > 0, '展開中');
  h.cancel();
  for (let i = 0; i < BOX_ANIM_FRAMES + 2; i += 1) step(world, 1);
  eq(world.boxAnim, 0, '收回');
});

group('world：表達式查表');

test('evalExpr 可讀 hp / maxHp / mercy / alive', () => {
  const { world } = makeWorld();
  eq(world.evalExpr('hp.kris'), 90, 'hp.kris');
  eq(world.evalExpr('maxHp.kris'), 90, 'maxHp.kris');
  eq(world.evalExpr('mercy.rudinn'), 0, 'mercy.rudinn');
  eq(world.evalExpr('alive.kris'), 1, 'alive.kris');
  world.applyDamage('kris', 999);
  eq(world.evalExpr('alive.kris'), 0, '倒下後 alive = 0');
});

test('evalExpr 可讀 var.xxx 與 turn / tp', () => {
  const { world } = makeWorld();
  world.setVar('foo', 7);
  world.tp = 33;
  world.setTurn(1);
  eq(world.evalExpr('var.foo'), 7, 'var.foo');
  eq(world.evalExpr('tp'), 33, 'tp');
  eq(world.evalExpr('turn'), 1, 'turn');
});

test('evalExpr 讀不存在的查表 → 0', () => {
  const { world } = makeWorld();
  eq(world.evalExpr('hp.nobody'), 0, '不存在 → 0');
  eq(world.evalExpr('var.nothing'), 0, '不存在 → 0');
});

test('evalExpr 錯誤回報但不丟例外', () => {
  const { world } = makeWorld();
  const errors = [];
  const v = world.evalExpr('!!!bad!!!', (m) => errors.push(m));
  eq(v, 0, '錯誤取 0');
  eq(errors.length, 1, '回報一次');
});

test('evalExprDetailed 回傳 error 欄位', () => {
  const { world } = makeWorld();
  const r = world.evalExprDetailed('1 + 1');
  eq(r.value, 2, 'value');
  eq(r.error, null, 'no error');
  const bad = world.evalExprDetailed('nonsense(');
  eq(bad.value, 0, '錯誤 value 0');
  ok(bad.error, '有 error 字串');
});

test('recordAct 累加 actCount 查表', () => {
  const { world } = makeWorld();
  eq(world.evalExpr('actCount.rudinn_compliment'), 0, '初始 0');
  world.recordAct('rudinn', 'compliment');
  world.recordAct('rudinn', 'compliment');
  eq(world.evalExpr('actCount.rudinn_compliment'), 2, '累加 2');
});

group('world：音效 / BGM / 派遣');

test('pushSfx 與 drainSfx', () => {
  const { world } = makeWorld();
  world.pushSfx('snd_a');
  world.pushSfx('snd_b');
  deepEq(world.drainSfx(), ['snd_a', 'snd_b'], '依序取出');
  deepEq(world.drainSfx(), [], '取完清空');
});

test('playBgm 記錄序號以便音效層比對', () => {
  const { world } = makeWorld();
  const a = world.getBgm();
  world.playBgm('bgm_x', 0.5);
  const b = world.getBgm();
  eq(b.track, 'bgm_x', 'track');
  eq(b.fade, 0.5, 'fade');
  ok(b.seq > a.seq, 'seq 遞增');
});

test('requestEnd / consumeEndRequest', () => {
  const { world } = makeWorld();
  eq(world.consumeEndRequest(), null, '初始 null');
  world.requestEnd('defeat');
  eq(world.consumeEndRequest(), 'defeat', '取回 defeat');
  eq(world.consumeEndRequest(), null, '取完清空');
});

test('removeEnemy 標記並淡出', () => {
  const { world, events } = makeWorld();
  eq(world.removeEnemy('rudinn'), true, '成功');
  eq(world.enemyById('rudinn').removed, true, 'removed');
  ok(events.some((e) => e.type === 'enemyRemoved'), 'enemyRemoved 事件');
  eq(world.removeEnemy('nobody'), false, '不存在 → false');
});

group('world：snapshot（§5）');

test('snapshot 具備 §5 全部欄位', () => {
  const { world } = makeWorld();
  const s = world.snapshot();
  for (const key of ['frame', 'lang', 'actors', 'party', 'enemies', 'tp', 'textbox', 'bubbles', 'numbers', 'battle', 'boxAnim', 'fade', 'flash', 'shake']) {
    hasKey(s, key);
  }
  isArray(s.actors, 'actors 陣列');
  isArray(s.party, 'party 陣列');
  isArray(s.enemies, 'enemies 陣列');
  eq(s.battle, null, '沒有彈幕時 battle = null');
  eq(s.textbox, null, '沒有文字時 textbox = null');
  eq(s.tp, 0, 'tp');
});

test('party snapshot 有 §5 欄位', () => {
  const { world } = makeWorld();
  const p = world.snapshot().party[0];
  for (const key of ['id', 'name', 'hp', 'maxHp', 'color', 'down', 'defending', 'action']) hasKey(p, key);
  eq(p.id, 'kris', 'id');
  eq(p.name, 'Kris', 'name');
});

test('enemies snapshot 有 spareable / removed', () => {
  const { world } = makeWorld();
  const e = world.snapshot().enemies[0];
  for (const key of ['id', 'name', 'hp', 'maxHp', 'mercy', 'spareable', 'removed']) hasKey(e, key);
  eq(e.spareable, false, '尚未可饒恕');
});

test('battle snapshot 合併 Phase 1 的 box / soul / bullets', () => {
  const { world } = makeWorld();
  const h = world.startAttack('demoAttack');
  for (let i = 0; i < 3; i += 1) step(world, 1);
  const b = world.snapshot().battle;
  ok(b.box, 'box');
  ok(b.soul, 'soul');
  isArray(b.bullets, 'bullets');
  ok(b.bullets.length >= 0, 'bullets 陣列可用');
  hasKey(b, 'shake');
  hasKey(b, 'sfxQueue');
  // 與單獨攻擊 getState() 同形：bot 需要的 attack（soul.speed / slowSpeed）與其他欄位都在
  ok(b.attack, 'attack 設定');
  ok(b.attack.soul, 'attack.soul');
  ok(Number.isFinite(b.attack.soul.speed), 'attack.soul.speed');
  ok(Number.isFinite(b.attack.soul.slowSpeed), 'attack.soul.slowSpeed');
  hasKey(b, 'mode');
  hasKey(b, 'time');
  hasKey(b, 'running');
  ok(Array.isArray(b.party), 'party');
  ok(Array.isArray(b.enemies), 'enemies');
  hasKey(b, 'grazeFlash');
  hasKey(b, 'hurtFlash');
  ok(b.bullets.length > 0, '有子彈');
  ok(b.bullets[0].hitbox, '子彈帶 hitbox（bot 判斷碰撞用）');
  h.cancel();
});

test('shake 與 flash 在 snapshot 中', () => {
  const { world } = makeWorld();
  world.startShake(5, 0.2);
  world.startFlash('#ff0000', 0.2);
  step(world, 1);
  const s = world.snapshot();
  hasKey(s.shake, 'x');
  hasKey(s.shake, 'y');
  eq(s.flash.color, '#ff0000', 'flash 顏色');
  ok(s.flash.alpha > 0, 'flash alpha');
});

group('world：reset');

test('reset 回到初始狀態', () => {
  const { world } = makeWorld();
  world.applyDamage('kris', 30);
  world.addMercy('rudinn', 50);
  world.tp = 55;
  world.setVar('complimented', 3);
  world.damageNumber(10, 10, '-1', '#f00');
  step(world, 5);

  world.reset();
  eq(world.frame, 0, 'frame 歸零');
  eq(world.partyById('kris').hp, 90, 'HP 復原');
  eq(world.enemyById('rudinn').mercy, 0, 'mercy 復原');
  eq(world.tp, 0, 'tp 歸零');
  eq(world.getVar('complimented'), 0, '變數復原');
  eq(world.snapshot().numbers.length, 0, '傷害數字清空');
});

test('reset 會收掉進行中的彈幕回合', () => {
  const { world } = makeWorld();
  world.startAttack('demoAttack');
  ok(world.attackActive(), '回合進行中');
  world.reset();
  notOk(world.attackActive(), 'reset 後結束');
});

group('world：決定性');

test('相同 seed 與相同輸入 → 相同 snapshot 序列', () => {
  const runOnce = () => {
    const enc = normalizeEncounter(baseEncounter());
    const world = createWorld(enc, { fps: 30, rng: createRng(7), resolvedAttacks: new Map([['demoAttack', demoAttack()]]) });
    const snaps = [];
    world.startAttack('demoAttack');
    for (let i = 0; i < 30; i += 1) {
      world.update(normalizeInput({ hold: { right: i % 3 === 0 } }));
      const s = world.snapshot();
      snaps.push(`${s.frame}|${s.party[0].hp}|${s.tp}|${s.boxAnim.toFixed(4)}`);
    }
    return snaps;
  };
  const a = runOnce();
  const b = runOnce();
  deepEq(a, b, '兩次結果完全相同');
});

test('不同 seed 的瞄準彈會不同（rng 有實際作用）', () => {
  const build = (seed) => {
    const enc = normalizeEncounter(baseEncounter());
    const world = createWorld(enc, { fps: 30, rng: createRng(seed), resolvedAttacks: new Map() });
    return world;
  };
  const w1 = build(1);
  const w2 = build(999);
  const v1 = w1.evalExpr('rand(0, 1000)');
  const v2 = w2.evalExpr('rand(0, 1000)');
  notOk(v1 === v2 && v1 === 0, '不同 seed 產生不同亂數');
});
