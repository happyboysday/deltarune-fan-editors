/**
 * tests/encounter/t-forms.mjs — 演員形態（SPEC-P2 §1 forms）
 *
 * 覆蓋：
 *   1. 正規化：forms / form / 形態 anims / scale / offset
 *   2. 驗證：未知初始形態、未知 form cue 形態、壞掉的 forms 結構
 *   3. 演員系統：形態動畫覆寫、未定義動畫退回 base、setForm 切換 / 未知形態、snapshot / reset
 *   4. cue:form（含 if 變數驅動）與決定性
 */

import { group, test, eq, ok, notOk, deepEq } from '../engine/harness.mjs';
import { createActorSystem } from '../../engine/encounter/actors.js';
import { createWorld } from '../../engine/encounter/world.js';
import { createCueRunner } from '../../engine/encounter/cues.js';
import { normalizeActor, normalizeEncounter, validateEncounter } from '../../engine/encounter/schema.js';

/** 有兩個形態的敵人（normal = 初始形態；angry 有 scale / offset / 覆寫 hurt） */
function formsEncounter(over = {}) {
  const base = {
    format: 'dr-battle-encounter/1',
    meta: { name: '形態測試' },
    settings: { seed: 3, introText: '' },
    actors: {
      e: {
        kind: 'enemy',
        x: 500,
        y: 200,
        form: 'normal',
        anims: {
          idle: { sprite: 'spr_base_idle', fps: 5, loop: true },
          hurt: { sprite: 'spr_base_hurt', fps: 10, loop: false, frames: 3, then: 'idle' },
          special: { sprite: 'spr_base_special', fps: 6, loop: true },
        },
        forms: {
          normal: {
            anims: {
              idle: { sprite: 'spr_n_idle', fps: 5, loop: true },
              talk: { sprite: 'spr_n_talk', fps: 5, loop: true },
            },
          },
          angry: {
            anims: {
              idle: { sprite: 'spr_a_idle', fps: 8, loop: true },
              hurt: { sprite: 'spr_a_hurt', fps: 12, loop: false, frames: 4, then: 'idle' },
            },
            scale: 2,
            offset: { x: 10, y: -20 },
          },
        },
      },
      kris: {
        kind: 'party',
        x: 100,
        y: 200,
        anims: {
          idle: { sprite: 'spr_kris_idle', fps: 5, loop: true },
          hurt: { sprite: 'spr_kris_hurt', fps: 10, loop: false, frames: 3, then: 'idle' },
        },
      },
    },
    party: [{ id: 'kris', actor: 'kris', name: 'Kris', maxHp: 100, hp: 100 }],
    enemies: [{ id: 'e', actor: 'e', name: 'E', maxHp: 100, hp: 100 }],
    turns: [
      {
        id: 't1',
        attack: null,
        start: [{ cmd: 'form', actor: 'e', name: 'angry' }],
        end: [],
      },
    ],
  };
  return { ...base, ...over };
}

/* ===================================================================== */
/* 1. 正規化                                                             */
/* ===================================================================== */

group('forms：正規化');

test('normalizeActor 正規化 forms / form / 形態動畫', () => {
  const a = normalizeActor(formsEncounter().actors.e, 'e');
  eq(a.form, 'normal', '初始形態 = normal');
  ok(a.forms && typeof a.forms === 'object', 'forms 是物件');
  deepEq(Object.keys(a.forms), ['normal', 'angry'], '形態順序保留宣告順序');
  eq(a.forms.normal.anims.idle.sprite, 'spr_n_idle', '形態動畫 sprite');
  eq(a.forms.normal.anims.idle.fps, 5, '形態動畫 fps');
  eq(a.forms.normal.anims.idle.loop, true, 'loop 預設 true');
  eq(a.forms.angry.scale, 2, '形態 scale');
  deepEq(a.forms.angry.offset, { x: 10, y: -20 }, '形態 offset');
  eq(a.forms.angry.anims.hurt.then, 'idle', '形態動畫 then 保留');
  eq(a.anims.idle.sprite, 'spr_base_idle', '基礎 anims 仍保留在 actor.anims');
});

test('normalizeActor：省略 forms 時不產生 forms、form = null', () => {
  const a = normalizeActor({ kind: 'enemy', anims: { idle: { sprite: 'spr_x' } } }, 'x');
  notOk(Object.prototype.hasOwnProperty.call(a, 'forms'), '沒有 forms 欄位');
  eq(a.form, null, 'form = null');
});

test('normalizeActor：未知初始形態 → null（驗證另外報錯）', () => {
  const a = normalizeActor({ kind: 'enemy', form: 'nope', forms: { normal: { anims: {} } } }, 'e');
  eq(a.form, null, '未知形態不會被當成初始形態');
});

test('normalizeEncounter：forms 進入正規化結果（決定性 deepClone）', () => {
  const enc = normalizeEncounter(formsEncounter());
  eq(enc.actors.e.form, 'normal', '正規化後初始形態');
  eq(enc.actors.e.forms.angry.anims.idle.sprite, 'spr_a_idle', '形態動畫正規化');
  const again = normalizeEncounter(formsEncounter());
  deepEq(again.actors.e.forms, enc.actors.e.forms, '兩次正規化相同');
});

/* ===================================================================== */
/* 2. 驗證                                                               */
/* ===================================================================== */

group('forms：驗證');

/** 取某個 path 的錯誤訊息（沒有回 ''） */
function errAt(errors, path) {
  const hit = errors.find((e) => e.path === path);
  return hit ? hit.message : '';
}

test('合法 forms 遭遇沒有 forms 相關錯誤', () => {
  const errors = validateEncounter(formsEncounter());
  deepEq(errors, [], '沒有錯誤');
});

test('actor.form 指向未知形態 → 報錯', () => {
  const doc = formsEncounter();
  doc.actors.e.form = 'ghost';
  const errors = validateEncounter(doc);
  ok(errAt(errors, 'actors.e.form').includes('找不到形態 "ghost"'), `訊息：${errAt(errors, 'actors.e.form')}`);
  ok(errAt(errors, 'actors.e.form').includes('normal'), '訊息列出可用形態');
});

test('actor.form 給了但沒有 forms → 報錯', () => {
  const doc = formsEncounter();
  delete doc.actors.e.forms;
  const errors = validateEncounter(doc);
  ok(errAt(errors, 'actors.e.form').includes('找不到形態'), '報錯');
  ok(errAt(errors, 'actors.e.form').includes('沒有 forms'), '說明沒有 forms');
});

test('cue:form 指向未知形態 → 報錯並列出可用形態', () => {
  const doc = formsEncounter();
  doc.turns[0].start = [{ cmd: 'form', actor: 'e', name: 'ghost' }];
  const errors = validateEncounter(doc);
  const msg = errAt(errors, 'turns[0].start[0].name');
  ok(msg.includes('找不到形態 "ghost"'), `訊息：${msg}`);
  ok(msg.includes('angry'), '列出可用形態');
});

test('beforeAttack 可以用 form: null 切回基礎形態', () => {
  const doc = formsEncounter();
  doc.turns[0].beforeAttack = [{ cmd: 'form', actor: 'e', name: null }];
  eq(validateEncounter(doc).length, 0);
  doc.turns[0].beforeAttack[0].name = 'unknown';
  ok(validateEncounter(doc).some((e) => e.path === 'turns[0].beforeAttack[0].name'));
});

test('cue:form 缺少 name / actor → 報必填', () => {
  const doc = formsEncounter();
  doc.turns[0].start = [{ cmd: 'form', actor: 'e' }, { cmd: 'form', name: 'normal' }];
  const errors = validateEncounter(doc);
  ok(errAt(errors, 'turns[0].start[0].name').includes('缺少必填參數'), '缺 name');
  ok(errAt(errors, 'turns[0].start[1].actor').includes('缺少必填參數'), '缺 actor');
});

test('forms 結構壞掉 / offset 型別錯 → 報錯', () => {
  const doc = formsEncounter();
  doc.actors.e.forms = { bad: 'nope', normal: { anims: { idle: { sprite: 'x', fps: 'fast' } }, offset: 5 } };
  doc.actors.e.form = null;
  const errors = validateEncounter(doc);
  ok(errAt(errors, 'actors.e.forms.bad').includes('形態定義必須是物件'), '形態定義非物件');
  ok(errAt(errors, 'actors.e.forms.normal.anims.idle.fps').includes('fps'), 'fps 型別');
  ok(errAt(errors, 'actors.e.forms.normal.offset').includes('offset'), 'offset 非物件');
});

/* ===================================================================== */
/* 3. 演員系統                                                           */
/* ===================================================================== */

group('forms：演員系統');

/** 建立只有 form 敵人的演員系統 */
function makeActors() {
  const enc = normalizeEncounter(formsEncounter());
  return createActorSystem(enc.actors);
}

test('初始形態生效：動畫用形態覆寫，未定義者退回基礎動畫', () => {
  const a = makeActors();
  const e = a.get('e');
  eq(e.form, 'normal', '目前形態 normal');
  eq(e.animName, 'idle', '初始動畫 idle');
  eq(e.anim.sprite, 'spr_n_idle', 'idle 用形態覆寫的 sprite');
  a.setAnim('e', 'hurt');
  eq(a.get('e').anim.sprite, 'spr_base_hurt', 'normal 沒定義 hurt → 退回基礎 anims');
  a.setAnim('e', 'talk');
  eq(a.get('e').anim.sprite, 'spr_n_talk', '形態自訂動畫可用');
});

test('setForm：切換後沿用目前動畫名（新形態有同名動畫就用它）', () => {
  const a = makeActors();
  a.setAnim('e', 'hurt');
  const before = a.get('e').anim.sprite;
  eq(a.setForm('e', 'angry'), true, '切到 angry 成功');
  const e = a.get('e');
  eq(e.form, 'angry', '目前形態 angry');
  eq(e.animName, 'hurt', '動畫名沿用 hurt');
  notOk(e.anim.sprite === before, '動畫定義換成 angry 的 hurt');
  eq(e.anim.sprite, 'spr_a_hurt', 'angry 的 hurt sprite');
});

test('setForm：新形態沒有的動畫退回基礎，再沒有就 idle', () => {
  const a = makeActors();
  a.setAnim('e', 'special'); // 只在 base 有
  a.setForm('e', 'angry');
  eq(a.get('e').animName, 'special', 'angry 沒定義 special → 退回基礎 special');
  eq(a.get('e').anim.sprite, 'spr_base_special', '用基礎 sprite');
  // 把目前動畫名清空（sprite 指令）→ 切形態時沒有同名動畫 → idle
  a.setSprite('e', 'spr_raw');
  eq(a.get('e').animName, null, 'sprite 指令不經 anims 表');
  a.setForm('e', 'normal');
  eq(a.get('e').animName, 'idle', '沒有同名動畫 → idle');
});

test('setForm：opts.anim 指定新形態動畫', () => {
  const a = makeActors();
  a.setForm('e', 'angry', { anim: 'idle' });
  eq(a.get('e').animName, 'idle', '指定 idle');
  eq(a.get('e').anim.sprite, 'spr_a_idle', '用 angry idle');
});

test('setForm：未知形態回 false 且不改變現況', () => {
  const a = makeActors();
  a.setForm('e', 'normal');
  eq(a.setForm('e', 'ghost'), false, '未知形態');
  eq(a.get('e').form, 'normal', '形態不變');
  eq(a.setForm('nobody', 'normal'), false, '未知演員');
});

test('setForm(null)：回到基礎動畫', () => {
  const a = makeActors();
  a.setForm('e', 'angry');
  eq(a.setForm('e', null), true, '清回基礎');
  eq(a.get('e').form, null, 'form = null');
  eq(a.get('e').anim.sprite, 'spr_base_idle', 'idle 用基礎 sprite');
});

test('snapshot：form / 形態 offset / 形態 scale', () => {
  const a = makeActors();
  a.setForm('e', 'angry', { anim: 'idle' });
  const snap = a.snapshot().find((s) => s.id === 'e');
  eq(snap.form, 'angry', 'snapshot.form');
  eq(snap.x, 510, 'x 含形態 offset.x');
  eq(snap.y, 180, 'y 含形態 offset.y');
  eq(snap.scale, 2, 'scale = actor.scale × 形態 scale');
  eq(snap.sprite, 'spr_a_idle', 'sprite');
  const pos = a.displayPos('e');
  deepEq(pos, { x: 510, y: 180, h: 32, scale: 2 }, 'displayPos 與 snapshot 一致');
  eq(a.getForm('e'), 'angry', 'getForm');
  deepEq(a.formNames('e'), ['normal', 'angry'], 'formNames');
});

test('reset：回到初始形態與初始動畫', () => {
  const a = makeActors();
  a.setForm('e', 'angry');
  a.setAnim('e', 'hurt');
  a.reset();
  const e = a.get('e');
  eq(e.form, 'normal', '回到初始形態 normal');
  eq(e.animName, 'idle', '回到初始動畫 idle');
  eq(e.anim.sprite, 'spr_n_idle', '用 normal idle');
});

test('決定性：同樣操作 → 同樣 snapshot（含 form / offset / scale）', () => {
  const run = () => {
    const a = makeActors();
    const shots = [];
    a.setAnim('e', 'hurt');
    shots.push(a.snapshot());
    a.setForm('e', 'angry');
    shots.push(a.snapshot());
    a.setForm('e', 'normal', { anim: 'talk' });
    shots.push(a.snapshot());
    return shots;
  };
  deepEq(run(), run(), '兩次結果完全相同');
});

/* ===================================================================== */
/* 4. cue:form（world + runner）                                          */
/* ===================================================================== */

group('forms：cue 切換與變數驅動');

function makeEnv(over = {}) {
  const enc = normalizeEncounter(formsEncounter(over));
  const events = [];
  const world = createWorld(enc, {
    fps: 30,
    onEvent: (type, payload) => events.push({ type, payload }),
  });
  const runner = createCueRunner(world, { fps: 30 });
  return {
    world,
    runner,
    events,
    tick() {
      world.update({ press: [], hold: {} });
      runner.update({ press: [], hold: {} });
    },
    step(n) {
      for (let i = 0; i < n; i += 1) this.tick();
    },
  };
}

test('cue:form 切換形態並發出 form 事件（只觀察）', () => {
  const env = makeEnv();
  const h = env.runner.run([{ cmd: 'form', actor: 'e', name: 'angry' }]);
  env.tick();
  ok(h.done, '立即指令一幀內完成');
  eq(env.world.actors.get('e').form, 'angry', '形態已切換');
  const ev = env.events.find((x) => x.type === 'form');
  ok(ev, '發出 form 事件');
  eq(ev.payload.actor, 'e', '事件 actor');
  eq(ev.payload.form, 'angry', '事件 form');
  const snap = env.world.snapshot().actors.find((s) => s.id === 'e');
  eq(snap.form, 'angry', 'state.actors[].form');
});

test('cue:form 帶 anim 參數', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'form', actor: 'e', name: 'angry', anim: 'hurt' }]);
  env.tick();
  eq(env.world.actors.get('e').animName, 'hurt', '切換後播 hurt');
});

test('cue:form 未知形態 → 錯誤事件，不中斷', () => {
  const env = makeEnv();
  env.runner.run([{ cmd: 'form', actor: 'e', name: 'ghost' }]);
  env.tick();
  eq(env.world.actors.get('e').form, 'normal', '形態不變');
  const err = env.events.find((x) => x.type === 'error');
  ok(err, '有錯誤事件');
  ok(String(err.payload.message).includes('找不到形態'), `訊息：${err.payload.message}`);
});

test('if 依變數切換形態（沿用既有 cue 機制）', () => {
  const env = makeEnv();
  env.runner.run([
    { cmd: 'set', var: 'phase', value: 2 },
    {
      cmd: 'if',
      cond: 'vars.phase',
      then: [{ cmd: 'form', actor: 'e', name: 'angry' }],
      else: [{ cmd: 'form', actor: 'e', name: 'normal' }],
    },
  ]);
  env.step(3);
  eq(env.world.actors.get('e').form, 'angry', 'cond 成立 → angry');
  eq(env.world.vars.phase, 2, '變數已設定');
});

test('form 事件與形態切換具決定性（兩次相同）', () => {
  const run = () => {
    const env = makeEnv();
    env.runner.run([{ cmd: 'form', actor: 'e', name: 'angry' }]);
    env.step(2);
    return {
      snap: env.world.snapshot().actors,
      events: env.events.filter((x) => x.type === 'form'),
    };
  };
  deepEq(run(), run(), '兩次完全相同');
});
