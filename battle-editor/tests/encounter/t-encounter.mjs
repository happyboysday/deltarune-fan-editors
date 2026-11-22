/**
 * tests/encounter/t-encounter.mjs — 遭遇入口（SPEC-P2 §4 API / §5 state）
 *
 * 無頭（canvas = null）測試 createEncounter 的完整 API、事件、決定性、
 * debug 介面、與 flow.js 缺席時的降級行為。
 */

import { group, test, eq, ok, notOk, approx, deepEq, isArray, hasKey, within } from '../engine/harness.mjs';
import { createEncounter, FPS, VIEW_W, VIEW_H } from '../../engine/encounter/index.js';
import { normalizeEncounter } from '../../engine/encounter/schema.js';
import { createEncounterRenderer } from '../../engine/render-encounter.js';
import { baseEncounter, twoTurnEncounter, demoAttack, grazeAttack } from './fixtures.mjs';

/** 預先解析好的假攻擊表（模擬 W2 的 samples 載入器） */
const ATTACKS = new Map([
  ['demoAttack', demoAttack()],
  ['grazeAttack', grazeAttack()],
  ['embedded', demoAttack({ meta: { name: '內嵌' }, settings: { duration: 0.4, seed: 2 } })],
]);

/** resolveAttack 的假實作 */
async function resolveAttack(name) {
  if (ATTACKS.has(name)) return ATTACKS.get(name);
  return null;
}

/**
 * 「不會馬上結束」的遭遇：intro 是一段長 wait，
 * 讓 step(n) 的幀數測試不會被降級流程立刻判定勝利打斷。
 */
function idleEncounter(over = {}) {
  return baseEncounter({
    hooks: { intro: [{ cmd: 'wait', seconds: 20 }], victory: [], spared: [], defeat: [], flee: [] },
    ...over,
  });
}

/** 建立無頭遭遇並載入 */
async function makeEncounter(encJson, options = {}) {
  const enc = createEncounter({ canvas: null, assets: null, resolveAttack, ...options });
  const errors = [];
  enc.on('error', (p) => errors.push(p));
  const events = [];
  enc.on('phase', (p) => events.push({ type: 'phase', payload: p }));
  enc.on('end', (p) => events.push({ type: 'end', payload: p }));
  const loadResult = await enc.load(encJson === undefined ? baseEncounter() : encJson);
  return { enc, events, errors, loadResult };
}

/** 依序跑 n 幀（每幀一次 confirm 可加速推進文字） */
function run(enc, n = 1, input) {
  for (let i = 0; i < n; i += 1) enc.step(1, input);
}

group('encounter：建立與載入');

test('load starts attack reads concurrently and only commits the latest encounter', async () => {
  const pending = new Map();
  const enc = createEncounter({
    resolveAttack: (name) => new Promise((resolve) => pending.set(name, resolve)),
  });
  const first = enc.load(baseEncounter({
    meta: { name: 'older' },
    turns: [{ attack: 'old-a', beforeAttack: [{ cmd: 'attack', attack: 'old-b' }] }],
  }));
  deepEq([...pending.keys()], ['old-a', 'old-b']);
  const second = enc.load(baseEncounter({ meta: { name: 'newer' }, turns: [{ attack: 'new' }] }));
  pending.get('new')(demoAttack());
  await second;
  pending.get('old-a')(demoAttack());
  pending.get('old-b')(demoAttack());
  eq((await first).superseded, true);
  eq(enc.encounter.meta.name, 'newer');
  deepEq(enc.debug.missingAttacks, []);
  enc.destroy();
});

test('無頭 createEncounter 不會爆炸', async () => {
  const { enc } = await makeEncounter();
  ok(enc, '建立成功');
  eq(enc.loaded, true, '已載入');
  notOk(enc.running, '預設不跑');
  eq(enc.result, null, '尚未結束');
  enc.destroy();
});

test('load 回傳驗證錯誤清單（合法資料為空）', async () => {
  const { loadResult } = await makeEncounter();
  isArray(loadResult.errors, 'errors 是陣列');
  eq(loadResult.errors.length, 0, '合法資料沒有錯誤');
});

test('設定曲目與淡出指令交由同一個外部播放器', async () => {
  const heard = [];
  const audio = {
    playBgm(track, { fade }) { heard.push([track, fade]); },
  };
  const { enc } = await makeEncounter(baseEncounter({
    settings: { bgm: 'opening' },
    hooks: { intro: [{ cmd: 'wait', seconds: 0.2 }, { cmd: 'bgm', track: null, fade: 0.4 }] },
  }), { audio });
  run(enc, 1);
  deepEq(heard, [['opening', 0]]);
  run(enc, 9);
  deepEq(heard, [['opening', 0], [null, 0.4]]);
  enc.destroy();
});

test('load 對壞資料回報錯誤但不丟例外', async () => {
  const { enc, loadResult } = await makeEncounter({
    format: 'wrong-format',
    turns: [{ id: 't1', attack: null }],
  });
  ok(loadResult.errors.length > 0, '有驗證錯誤');
  ok(loadResult.errors.every((e) => typeof e.path === 'string' && typeof e.message === 'string'), 'path/message 都是字串');
  ok(enc.loaded, '仍然完成載入（不崩潰）');
  enc.destroy();
});

test('normalizeEncounter 補齊預設值', async () => {
  const { enc } = await makeEncounter({ turns: [{ id: 'only' }] });
  const e = enc.encounter;
  eq(e.format, 'dr-battle-encounter/1', 'format 補上');
  eq(e.settings.seed, 1, 'seed 預設 1');
  isArray(e.party, 'party 是陣列');
  isArray(e.enemies, 'enemies 是陣列');
  isArray(e.items, 'items 是陣列');
  isArray(e.turns, 'turns 是陣列');
  eq(e.turns[0].attack, null, 'attack 預設 null');
  deepEq(e.turns[0].start, [], 'start 預設空陣列');
  eq(e.turnOrder, 'loop-last', 'turnOrder 預設');
  enc.destroy();
});

test('載入時預先解析攻擊參照', async () => {
  const { enc } = await makeEncounter(
    baseEncounter({
      turns: [{ id: 't1', attack: 'demoAttack', start: [], end: [] }],
    }),
  );
  const missing = enc.debug.missingAttacks;
  deepEq(missing, [], '沒有缺失的攻擊');
  enc.destroy();
});

test('缺失的攻擊會出現在 debug.missingAttacks', async () => {
  const { enc } = await makeEncounter(
    baseEncounter({
      turns: [{ id: 't1', attack: 'no-such-attack', start: [], end: [] }],
    }),
  );
  ok(enc.debug.missingAttacks.includes('no-such-attack'), '列出缺失攻擊');
  enc.destroy();
});

test('沒有 flow.js 時降級為 fallback 流程', async () => {
  const { enc } = await makeEncounter();
  // flow.js 由 FL 提供；若已存在則測正式流程，不存在則測降級
  if (enc.debug.flowUnavailable) {
    eq(enc.debug.flow, null, '沒有 flow 物件');
  } else {
    ok(enc.debug.flow, '有 flow 物件');
  }
  ok(enc.loaded, '兩種情況都能載入');
  enc.destroy();
});

group('encounter：getState（§5）');

test('getState 具備 §5 全部欄位', async () => {
  const { enc } = await makeEncounter();
  const s = enc.getState();
  for (const key of [
    'frame', 'lang', 'phase', 'turn', 'actors', 'party', 'enemies', 'tp',
    'textbox', 'bubbles', 'menu', 'fight', 'numbers', 'battle',
    'boxAnim', 'fade', 'flash', 'result',
  ]) {
    hasKey(s, key);
  }
  eq(s.frame, 0, 'frame 從 0');
  eq(s.lang, 'zh', '預設語言 zh');
  isArray(s.actors, 'actors 陣列');
  isArray(s.party, 'party 陣列');
  isArray(s.enemies, 'enemies 陣列');
  eq(s.battle, null, '沒有彈幕時 battle = null');
  eq(s.menu, null, '沒有選單時 menu = null');
  eq(s.tp, 0, 'tp 0');
  ok(s.shake, 'shake 存在');
  enc.destroy();
});

test('actors snapshot 有 §5 欄位', async () => {
  const { enc } = await makeEncounter();
  const a = enc.getState().actors;
  ok(a.length >= 2, `有演員（${a.length}）`);
  for (const item of a) {
    for (const key of ['id', 'kind', 'sprite', 'frame', 'x', 'y', 'flip', 'alpha', 'scale', 'layer', 'visible', 'hurtShake']) {
      hasKey(item, key);
    }
  }
  enc.destroy();
});

test('party / enemies snapshot 有 §5 欄位', async () => {
  const { enc } = await makeEncounter();
  const s = enc.getState();
  for (const key of ['id', 'name', 'hp', 'maxHp', 'color', 'down', 'defending', 'action']) hasKey(s.party[0], key);
  for (const key of ['id', 'name', 'hp', 'maxHp', 'mercy', 'spareable', 'removed']) hasKey(s.enemies[0], key);
  enc.destroy();
});

test('step 推進 frame', async () => {
  const { enc } = await makeEncounter(idleEncounter());
  eq(enc.frame, 0, '初始 0');
  run(enc, 5);
  eq(enc.frame, 5, 'step 5 次 = 5 幀');
  eq(enc.getState().frame, 5, 'state.frame 同步');
  enc.destroy();
});

test('step(n) 一次推進多幀', async () => {
  const { enc } = await makeEncounter(idleEncounter());
  enc.step(12);
  eq(enc.frame, 12, '12 幀');
  enc.destroy();
});

test('遭遇結束後 step 不再推進', async () => {
  const { enc } = await makeEncounter(idleEncounter());
  run(enc, 3);
  // 勝負判定屬於 FL 的職責，這裡直接下結束指令，測「結束後凍結」這個 E1 保證
  enc.debug.end('victory');
  eq(enc.result, 'victory', '已結束');
  const f = enc.frame;
  enc.step(5);
  eq(enc.frame, f, '結束後 frame 凍結');
  enc.destroy();
});

group('encounter：事件');

test('phase 事件在流程轉換時發出', async () => {
  const { enc, events } = await makeEncounter();
  run(enc, 10);
  const phases = events.filter((e) => e.type === 'phase').map((e) => e.payload.phase);
  ok(phases.length > 0, '至少一次 phase 事件');
  // intro 是初始 phase，setPhase 不會重複發事件；檢查後續轉換
  ok(phases.includes('turnStart') || phases.includes('victory'), `有流程轉換（${phases.join('→')}）`);
  enc.destroy();
});

test('phase 事件帶 phase / turn / frame', async () => {
  const { enc, events } = await makeEncounter();
  run(enc, 5);
  const evt = events.find((e) => e.type === 'phase');
  ok(evt, '有事件');
  eq(typeof evt.payload.phase, 'string', 'phase 是字串');
  eq(typeof evt.payload.turn, 'number', 'turn 是數字');
  eq(typeof evt.payload.frame, 'number', 'frame 是數字');
  enc.destroy();
});

test('on 回傳取消訂閱函式', async () => {
  const { enc } = await makeEncounter();
  let count = 0;
  const off = enc.on('phase', () => {
    count += 1;
  });
  run(enc, 5);
  const before = count;
  ok(before > 0, '有收到事件');
  off();
  run(enc, 5);
  eq(count, before, '取消後不再收到');
  enc.destroy();
});

test('訂閱者拋錯不影響模擬', async () => {
  const { enc } = await makeEncounter(idleEncounter());
  enc.on('phase', () => {
    throw new Error('訂閱者爆炸');
  });
  enc.on('frame', () => {
    throw new Error('frame 訂閱者爆炸');
  });
  run(enc, 5);
  eq(enc.frame, 5, '模擬照常推進');
  enc.destroy();
});

test('frame 事件每幀發出', async () => {
  const { enc } = await makeEncounter(idleEncounter());
  let n = 0;
  enc.on('frame', () => {
    n += 1;
  });
  run(enc, 4);
  eq(n, 4, '4 幀 4 次');
  enc.destroy();
});

group('encounter：降級流程行為');

test('降級模式會執行 hooks.intro', async () => {
  const { enc } = await makeEncounter(
    baseEncounter({
      hooks: { intro: [{ cmd: 'set', var: 'introRan', value: 1 }], victory: [], spared: [], defeat: [], flee: [] },
    }),
  );
  if (!enc.debug.flowUnavailable) {
    // FL 的正式流程也應該跑 intro hook；兩種都驗證
    run(enc, 5);
    ok(true, '正式流程載入，略過降級細節');
    enc.destroy();
    return;
  }
  run(enc, 3);
  eq(enc.debug.getVar('introRan'), 1, 'intro hook 已執行');
  enc.destroy();
});

test('降級模式會依序跑完所有回合並以 victory 結束', async () => {
  const { enc, events } = await makeEncounter(twoTurnEncounter());
  if (!enc.debug.flowUnavailable) {
    ok(true, '正式流程載入，略過');
    enc.destroy();
    return;
  }
  // intro 是一句 say，需要按 Z 才能推進；每 10 幀按一次
  for (let i = 0; i < 300 && !enc.result; i += 1) {
    enc.step(1, { press: i % 10 === 0 ? ['confirm'] : [], hold: {} });
  }
  eq(enc.result, 'victory', '結束於 victory');
  ok(events.some((e) => e.type === 'end'), '有 end 事件');
  enc.destroy();
});

test('降級模式會執行 turn.start 的 wait', async () => {
  const { enc } = await makeEncounter(
    baseEncounter({
      turns: [{ id: 't1', attack: null, start: [{ cmd: 'wait', seconds: 0.2 }, { cmd: 'set', var: 'started', value: 1 }], end: [] }],
    }),
  );
  if (!enc.debug.flowUnavailable) {
    ok(true, '正式流程載入，略過');
    enc.destroy();
    return;
  }
  run(enc, 6);
  eq(enc.debug.getVar('started'), 0, '等待中');
  run(enc, 4);
  eq(enc.debug.getVar('started'), 1, '等待結束後執行');
  enc.destroy();
});

test('降級模式會在回合中插入 turn.attack 的彈幕', async () => {
  const { enc } = await makeEncounter(
    baseEncounter({
      turns: [{ id: 't1', attack: 'demoAttack', start: [], end: [] }],
    }),
  );
  if (!enc.debug.flowUnavailable) {
    ok(true, '正式流程載入，略過');
    enc.destroy();
    return;
  }
  let sawBattle = false;
  for (let i = 0; i < 40; i += 1) {
    enc.step(1, { press: [], hold: {} });
    if (enc.getState().battle) sawBattle = true;
  }
  ok(sawBattle, '回合中有彈幕');
  enc.destroy();
});

test('hook 裡的 end 指令會結束遭遇', async () => {
  const { enc } = await makeEncounter(
    baseEncounter({
      hooks: { intro: [{ cmd: 'end', result: 'spared' }], victory: [], spared: [], defeat: [], flee: [] },
    }),
  );
  run(enc, 3);
  eq(enc.result, 'spared', '結束於 spared');
  eq(enc.getState().phase, 'spared', 'phase = spared');
  eq(enc.getState().textbox.lines[0].text, '* 你赢了！', '立即結束也有勝利旁白');
  enc.destroy();
});

test('全饒恕：敵人和終局掛鉤執行後，確認勝利旁白才送出 end', async () => {
  const doc = baseEncounter();
  doc.party[0].commands = ['spare'];
  doc.actors.kris.anims.spare = { sprite: 'spr_krisb_act', fps: 10, loop: false };
  doc.enemies[0].mercy = 100;
  doc.enemies[0].onSpare = [{ cmd: 'set', var: 'spareRan', value: 1 }];
  doc.hooks.spared = [
    { cmd: 'say', text: '* Farewell.' },
    { cmd: 'set', var: 'hookRan', value: 1 },
  ];
  doc.hooks.victory = [{ cmd: 'set', var: 'wrongHook', value: 1 }];
  const { enc, events } = await makeEncounter(doc);
  enc.setOptions({ lang: 'en' });
  const confirm = { press: ['confirm'] };
  run(enc);
  run(enc, 2, confirm);
  eq(enc.getState().actors.find((a) => a.id === 'kris').anim, 'spare', '饒恕結算時操作者播 spare');
  run(enc, 30);
  eq(enc.getState().textbox.lines[0].text, '* Farewell.', '先顯示掛鉤台詞');
  eq(enc.getState().vars.spareRan, 1, '敵人 onSpare 已執行');
  eq(enc.result, null, '掛鉤還在等待玩家');
  run(enc, 1, confirm);
  run(enc, 30);
  const state = enc.getState();
  eq(state.vars.hookRan, 1, '終局掛鉤執行完畢');
  eq(state.vars.wrongHook, undefined, '只執行 spared 掛鉤');
  eq(state.textbox.lines[0].text, '* YOU WON!', '底部文字框顯示勝利旁白');
  eq(state.textbox.done, true, '已打完字');
  eq(enc.result, null, '等待玩家確認');
  eq(events.filter((e) => e.type === 'end').length, 0, '尚未發出 end');
  run(enc, 2, confirm);
  eq(enc.result, 'spared', '保留 spared 結果');
  eq(enc.getState().textbox.lines[0].text, '* YOU WON!', '保留最後一幀的旁白');
  eq(events.filter((e) => e.type === 'end').length, 1, '只發出一次 end');
  enc.reset();
  eq(enc.result, null, '可重播');
  enc.destroy();
});

test('HUD 選擇與結算時都畫相同頭像，並依隊員綁定的演員取待機幀', async () => {
  const doc = baseEncounter();
  doc.actors.partner = {
    kind: 'party',
    anims: { idle: { sprite: 'spr_partner_idle' }, act: { sprite: 'spr_partner_act' } },
  };
  doc.party = [
    { id: 'guest', actor: 'partner', commands: ['defend'] },
    { id: 'kris', actor: 'kris', icon: 'spr_btact', commands: ['defend'] },
    { id: 'custom', icon: 'custom_party_face', commands: ['defend'] },
  ];
  const { enc } = await makeEncounter(doc);
  const draws = [];
  const gradient = () => ({ addColorStop() {} });
  const ctx = new Proxy({
    drawImage(img, ...coords) { draws.push({ img, y: coords.at(-3) }); },
    measureText(text) { return { width: text.length * 8 }; },
    createLinearGradient: gradient,
    createRadialGradient: gradient,
  }, { get: (target, key) => target[key] ?? (() => {}) });
  const renderer = createEncounterRenderer({ getContext: () => ctx }, {
    getImage: (name, frame) => ({ name, frame, width: 32, height: 32 }),
  });
  run(enc);
  renderer.draw(enc.getState());
  const faces = () => draws.filter(({ y }) => y >= 337 && y <= 399).map(({ img }) => img.name);
  const expected = ['spr_partner_idle', 'spr_headkris', 'custom_party_face'];
  deepEq(faces().filter((name) => !name.startsWith('spr_bt')), [...expected.slice(1), expected[0]], '升起面板的頭像最後繪製');
  ok(draws.some(({ img }) => img.name === 'spr_btdefend'), '指令列仍顯示指令圖示');
  draws.length = 0;
  enc.debug.runCues([{ cmd: 'anim', actor: 'partner', anim: 'act' }]);
  run(enc);
  const state = enc.getState();
  eq(state.actors.find((a) => a.id === 'partner').sprite, 'spr_partner_act', '演員正在播動作');
  renderer.draw({ ...state, phase: 'resolve', menu: null, party: state.party.map((p) => ({ ...p, action: 'act' })) });
  deepEq(faces(), expected, '結算時仍畫原頭像');
  renderer.destroy();
  enc.destroy();
});

group('encounter：戰鬥指令回饋');

test('ITEM 復活倒下的隊員並恢復循環待機', async () => {
  const doc = baseEncounter();
  doc.party[0].commands = ['act'];
  doc.actors.susie = structuredClone(doc.actors.kris);
  doc.actors.ralsei = structuredClone(doc.actors.kris);
  doc.party.push(
    { id: 'susie', actor: 'susie', commands: ['item'] },
    { id: 'ralsei', actor: 'ralsei', hp: 40, maxHp: 40, commands: ['defend'] },
  );
  doc.items = [{ id: 'revivemint', name: 'Revive Mint', heal: 20, count: 1 }];
  // 先選擇仍存活的道具目標，結算時前一個 ACT 才讓他倒下。
  doc.enemies[0].acts = [{ id: 'drop', name: 'Drop', cues: [
    { cmd: 'damage', target: 'ralsei', amount: 40 },
    { cmd: 'wait', seconds: 0.2 },
  ] }];
  const { enc } = await makeEncounter(doc);
  const pose = () => enc.getState().actors.find((a) => a.id === 'ralsei');
  const confirm = { press: ['confirm'] };
  run(enc);
  run(enc, 5, confirm);
  run(enc, 2, { press: ['down'] });
  run(enc, 2, confirm);
  run(enc);
  eq(pose().anim, 'down', 'ACT 先讓目標倒下');
  run(enc, 12);
  const target = enc.getState().party[2];
  eq(target.hp, 20, '恢復目標隊員的 HP');
  eq(target.down, false);
  eq(pose().anim, 'idle');
  eq(pose().animLoop, true, '待機動畫循環');
  enc.destroy();
});

test('FIGHT 標記、殘影與判定都在目標框的列內，判定點仍在左緣', () => {
  const rects = [];
  const labels = [];
  const outlines = [];
  const gradient = () => ({ addColorStop() {} });
  const ctx = new Proxy({
    fillRect(...coords) { rects.push({ coords, color: this.fillStyle }); },
    strokeRect(...coords) { outlines.push({ coords, color: this.strokeStyle }); },
    fillText(label, x, y) { labels.push({ label, x, y, align: this.textAlign }); },
    measureText(text) { return { width: text.length * 8 }; },
    createLinearGradient: gradient,
    createRadialGradient: gradient,
  }, { get: (target, key) => target[key] ?? (() => {}) });
  const renderer = createEncounterRenderer({ getContext: () => ctx }, null);
  const bar = { member: 0, color: '#ff44cc', x: 1, targetX: 1, result: null };
  const draw = () => renderer.draw({ phase: 'resolve', fight: { bars: [bar] } }, { lang: 'en' });
  draw();
  const { coords: [left, top, width, height] } = outlines.find(({ color, coords: [x] }) => color === bar.color && x > 51);
  const feedback = rects.filter(({ coords: [x, y] }) => x > 51 && y >= 405);
  ok(feedback.every(({ coords: [, y, , h] }) => y >= top - 0.5 && y + h <= top + height + 0.5),
    '標記與殘影不得超過目標框的上下緣');
  const marker = feedback.find(({ color, coords: [, , w] }) => color === '#ffffff' && w === 4);
  eq(marker.coords[0] + 2, Math.floor(left) + bar.targetX, '標記到達判定點時對齊左緣');
  ok(feedback.some(({ color, coords: [x, , w] }) => color === '#ffffff' && w === 2 && x > left),
    '標記後方仍有殘影');

  bar.result = 'perfect';
  draw();
  const result = labels.find(({ label }) => label === 'PERFECT');
  eq(result.align, 'center', '判定文字置中');
  eq(result.x, left + width / 2, '判定文字在框中央');
  within(result.y, top, top + height, '判定文字高度在框內');
  renderer.destroy();
});

test('DEFEND 保護每段巢狀彈幕，最後一段後才在台詞前恢復待機', async () => {
  const doc = baseEncounter();
  doc.party[0].commands = ['defend'];
  doc.actors.kris.anims.defend = { sprite: 'spr_krisb_defend', loop: false };
  doc.actors.kris.anims.hurt.then = 'defend';
  doc.turns[0].attack = 'main';
  doc.turns[0].end = [
    { cmd: 'parallel', cues: [
      { cmd: 'if', cond: '1', then: [
        { cmd: 'attack', attack: 'middle' },
        { cmd: 'bubble', actor: 'rudinn', text: 'Between', wait: 0.3 },
        { cmd: 'attack', attack: 'last' },
        { cmd: 'if', cond: '0', then: [{ cmd: 'attack', attack: 'skipped' }],
          else: [{ cmd: 'bubble', actor: 'rudinn', text: 'After' }] },
      ] },
    ] },
    { cmd: 'anim', actor: 'kris', anim: 'defend' },
    { cmd: 'bubble', actor: 'rudinn', text: 'Scripted' },
  ];
  const shot = demoAttack({
    settings: { duration: 0.7, damage: 10 },
    timeline: [{ id: 'hit', at: 0, type: 'spawn', bullet: 'b', count: 1, x: 320, y: 240, speed: 0 }],
  });
  const { enc, errors } = await makeEncounter(doc, { resolveAttack: async () => shot });
  const confirm = { press: ['confirm'] };
  const starts = [];
  const hits = [];
  const dialoguePoses = new Map();
  const pose = (state) => state.actors.find((a) => a.id === 'kris').anim;
  enc.on('attackStart', ({ ref }) => starts.push([ref, enc.getState().party[0].defending]));
  enc.on('hurt', ({ damage }) => hits.push(damage));
  enc.on('frame', () => {
    const state = enc.getState();
    if (state.bubbles.length && !dialoguePoses.has(starts.length)) dialoguePoses.set(starts.length, pose(state));
  });
  run(enc);
  run(enc, 1, confirm);
  run(enc, 150);
  deepEq(errors, []);
  deepEq(starts, [['main', true], ['middle', true], ['last', true]]);
  deepEq(hits, [5, 5, 5], '每段 10 傷害均減半');
  eq(dialoguePoses.get(2), 'defend', '中途台詞仍在防禦');
  eq(dialoguePoses.get(3), 'idle', '最後一段之後、台詞出現時已待機');
  eq(enc.getState().bubbles[0]?.lines[0]?.text, 'After');
  eq(enc.getState().party[0].defending, false);
  run(enc, 1, confirm);
  run(enc, 12);
  eq(enc.getState().bubbles[0]?.lines[0]?.text, 'Scripted');
  eq(pose(enc.getState()), 'defend', '後續明示的防禦動畫不被清掉');
  enc.destroy();
});

test('DEFEND 在一般彈幕後不蓋掉受傷或倒下的動畫', async () => {
  const doc = baseEncounter();
  doc.party[0].commands = ['defend'];
  doc.actors.kris.anims.defend = { sprite: 'spr_krisb_defend', loop: false };
  doc.actors.kris.anims.hurt = { sprite: 'spr_krisb_hurt', fps: 1, frames: 4, loop: false };
  doc.actors.susie = structuredClone(doc.actors.kris);
  doc.party.push({ ...doc.party[0], id: 'susie', actor: 'susie' });
  doc.turns[0].beforeAttack = [
    { cmd: 'damage', target: 'kris', amount: 1 },
    { cmd: 'damage', target: 'susie', amount: 90 },
  ];
  doc.turns[0].attack = 'empty';
  doc.turns[0].end = [{ cmd: 'bubble', actor: 'rudinn', text: 'After' }];
  const empty = demoAttack({ settings: { duration: 0.2 }, timeline: [] });
  const { enc, errors } = await makeEncounter(doc, { resolveAttack: async () => empty });
  run(enc);
  run(enc, 2, { press: ['confirm'] });
  run(enc, 60);
  const state = enc.getState();
  deepEq(errors, []);
  eq(state.bubbles[0].lines[0].text, 'After');
  eq(state.actors.find((a) => a.id === 'kris').anim, 'hurt');
  eq(state.actors.find((a) => a.id === 'susie').anim, 'down');
  eq(state.party[0].defending, false);
  enc.destroy();
});

group('encounter：pause / play / reset');

test('pause 停止推進', async () => {
  const { enc } = await makeEncounter(idleEncounter());
  enc.play();
  enc.pause();
  notOk(enc.running, 'pause 後不在跑');
  const f = enc.frame;
  enc.step(3);
  eq(enc.frame, f + 3, '手動 step 仍可推進');
  enc.destroy();
});

test('reset 回到初始狀態', async () => {
  const { enc } = await makeEncounter(idleEncounter());
  run(enc, 15);
  ok(enc.frame > 0, '有推進');
  enc.reset();
  eq(enc.frame, 0, 'frame 歸零');
  eq(enc.result, null, 'result 清空');
  eq(enc.getState().party[0].hp, 90, 'HP 復原');
  enc.destroy();
});

test('reset 後可以重新推進', async () => {
  const { enc } = await makeEncounter(idleEncounter());
  run(enc, 10);
  enc.reset();
  run(enc, 4);
  eq(enc.frame, 4, '重新計算');
  enc.destroy();
});

group('encounter：setOptions');

test('setOptions 切換語言並透傳給世界', async () => {
  const { enc } = await makeEncounter(
    baseEncounter({
      party: [
        { id: 'kris', actor: 'kris', name: { zh: '克里斯', en: 'Kris' }, hp: 90, maxHp: 90, color: '#00ffff', commands: ['fight'] },
      ],
    }),
  );
  eq(enc.getState().party[0].name, '克里斯', '預設 zh');
  enc.setOptions({ lang: 'en' });
  eq(enc.getState().lang, 'en', 'state.lang');
  eq(enc.getState().party[0].name, 'Kris', '名字切成英文');
  eq(enc.getOptions().lang, 'en', 'getOptions');
  enc.destroy();
});

test('setOptions 拒絕非法語言', async () => {
  const { enc } = await makeEncounter();
  enc.setOptions({ lang: 'fr' });
  eq(enc.getOptions().lang, 'zh', '維持 zh');
  enc.destroy();
});

test('setOptions 設定 showHitboxes / muted / scale', async () => {
  const { enc } = await makeEncounter();
  enc.setOptions({ showHitboxes: true, muted: true, scale: 2 });
  const o = enc.getOptions();
  eq(o.showHitboxes, true, 'showHitboxes');
  eq(o.muted, true, 'muted');
  eq(o.scale, 2, 'scale');
  enc.destroy();
});

test('setOptions 不會吃掉未提供的欄位', async () => {
  const { enc } = await makeEncounter();
  enc.setOptions({ lang: 'en', scale: 3 });
  enc.setOptions({ muted: true });
  const o = enc.getOptions();
  eq(o.lang, 'en', 'lang 保留');
  eq(o.scale, 3, 'scale 保留');
  eq(o.muted, true, 'muted 更新');
  enc.destroy();
});

group('encounter：debug 介面');

test('debug.jumpToTurn 切換回合', async () => {
  const { enc } = await makeEncounter(twoTurnEncounter());
  enc.debug.jumpToTurn(1);
  eq(enc.turn, 1, 'turn = 1');
  eq(enc.frame, 0, 'frame 重置');
  enc.destroy();
});

test('debug.jumpToTurn 夾在合法範圍', async () => {
  const { enc } = await makeEncounter(twoTurnEncounter());
  enc.debug.jumpToTurn(99);
  eq(enc.turn, 1, '夾到最後一回合');
  enc.debug.jumpToTurn(-5);
  eq(enc.turn, 0, '夾到第一回合');
  enc.destroy();
});

test('debug.runCues 執行指令清單', async () => {
  const { enc } = await makeEncounter();
  enc.debug.runCues([{ cmd: 'set', var: 'dbg', value: 42 }]);
  run(enc, 2);
  eq(enc.debug.getVar('dbg'), 42, '指令已執行');
  enc.destroy();
});

test('debug.setVar / getVar', async () => {
  const { enc } = await makeEncounter();
  enc.debug.setVar('x', 7);
  eq(enc.debug.getVar('x'), 7, 'setVar');
  enc.debug.setVar('x', 3, 'add');
  eq(enc.debug.getVar('x'), 10, 'add');
  enc.destroy();
});

test('debug.setPhase 驗證合法值', async () => {
  const { enc } = await makeEncounter();
  enc.debug.setPhase('menu');
  eq(enc.getState().phase, 'menu', '切成 menu');
  enc.debug.setPhase('nonsense');
  eq(enc.getState().phase, 'menu', '非法值被忽略');
  enc.destroy();
});

test('debug.end 直接結束', async () => {
  const { enc } = await makeEncounter();
  enc.debug.end('defeat');
  eq(enc.result, 'defeat', 'result');
  enc.destroy();
});

test('debug.startAttack 直接開彈幕（已預載的攻擊）', async () => {
  // 只有被遭遇檔引用到的攻擊才會預載；這裡讓 turn.attack 引用它
  const { enc } = await makeEncounter(
    baseEncounter({ turns: [{ id: 't1', attack: 'demoAttack', start: [], end: [] }] }),
  );
  const h = enc.debug.startAttack('demoAttack');
  ok(h, 'handle');
  ok(!h.done, '尚未結束');
  run(enc, 3);
  ok(enc.getState().battle, 'state.battle 有值');
  h.cancel();
  enc.destroy();
});

test('debug.startAttack 可直接吃內嵌攻擊物件', async () => {
  const { enc } = await makeEncounter(idleEncounter());
  const h = enc.debug.startAttack(demoAttack({ settings: { duration: 0.5, seed: 1 } }));
  ok(h && !h.done, '內嵌物件可開回合');
  run(enc, 2);
  ok(enc.getState().battle, 'state.battle 有值');
  h.cancel();
  enc.destroy();
});

test('debug.world / runner / encounter 可用', async () => {
  const { enc } = await makeEncounter();
  ok(enc.debug.world, 'world');
  ok(enc.debug.runner, 'runner');
  ok(enc.debug.encounter, 'encounter');
  isArray(enc.debug.encounter.turns, 'encounter.turns');
  enc.destroy();
});

group('encounter：決定性');

test('相同 seed 與相同輸入 → 兩次相同 state', async () => {
  const script = [];
  for (let i = 0; i < 60; i += 1) {
    script.push({ press: i % 7 === 0 ? ['confirm'] : [], hold: { right: i % 5 < 2, slow: i % 3 === 0 } });
  }
  const runOnce = async () => {
    const { enc } = await makeEncounter(
      baseEncounter({ turns: [{ id: 't1', attack: 'demoAttack', start: [{ cmd: 'wait', seconds: 0.1 }], end: [] }] }),
    );
    const out = [];
    for (const inp of script) {
      enc.step(1, inp);
      const s = enc.getState();
      out.push(`${s.frame}|${s.phase}|${s.turn}|${s.tp}|${s.boxAnim.toFixed(4)}|${JSON.stringify(s.party)}`);
    }
    enc.destroy();
    return out;
  };
  const a = await runOnce();
  const b = await runOnce();
  deepEq(a, b, '兩次完全相同');
});

test('不同 seed 產生不同亂數（攻擊中的 rand 有作用）', async () => {
  const collect = async (seed) => {
    const { enc } = await makeEncounter(
      baseEncounter({
        settings: { seed },
        turns: [
          {
            id: 't1',
            attack: null,
            start: [{ cmd: 'set', var: 'r', value: 'rand(0, 100000)' }],
            end: [],
          },
        ],
      }),
    );
    for (let i = 0; i < 8; i += 1) enc.step(1, { press: [], hold: {} });
    const v = enc.debug.getVar('r');
    enc.destroy();
    return v;
  };
  const v1 = await collect(1);
  const v2 = await collect(4242);
  notOk(v1 === v2, `不同 seed 不同（${v1} vs ${v2}）`);
});

group('encounter：渲染資料（背景 / 名稱本地化）');

test('getState().background 取自 settings.background', async () => {
  const { enc } = await makeEncounter(baseEncounter({ settings: { background: 'spr_battlebg_0' } }));
  run(enc, 2);
  eq(enc.getState().background, 'spr_battlebg_0', 'background 有透傳');
  // 沒設定時為 null（渲染器會退回程序化背景）
  const { enc: enc2 } = await makeEncounter();
  eq(enc2.getState().background, null, '未設定時為 null');
  enc.destroy();
  enc2.destroy();
});

test('敵人 / 隊員的 name 在執行期保留原始值，state 為本地化字串', async () => {
  const json = baseEncounter();
  json.enemies[0].name = { zh: '敌人甲', en: 'Enemy A' };
  json.party[0].name = { zh: '克里', en: 'Kris' };
  const { enc } = await makeEncounter(json);

  // 世界內部（FL 的 menu.js 會讀）保留原始字串或 {zh,en} 物件
  const rawEnemy = enc.debug.world.enemies[0];
  const rawParty = enc.debug.world.party[0];
  ok(
    typeof rawEnemy.name === 'object' && rawEnemy.name && rawEnemy.name.zh === '敌人甲',
    `world.enemies[0].name 保留 {zh,en}（實際 ${JSON.stringify(rawEnemy.name)}）`
  );
  eq(rawParty.name.en, 'Kris', 'world.party[0].name 保留 {zh,en}');

  // 對外 snapshot 依 lang 本地化
  eq(enc.getState().enemies[0].name, '敌人甲', 'zh 敵人名字');
  eq(enc.getState().party[0].name, '克里', 'zh 隊員名字');
  enc.setOptions({ lang: 'en' });
  eq(enc.getState().enemies[0].name, 'Enemy A', 'en 敵人名字');
  eq(enc.getState().party[0].name, 'Kris', 'en 隊員名字');
  enc.destroy();
});

group('encounter：destroy');

test('destroy 後不再推進', async () => {
  const { enc } = await makeEncounter();
  run(enc, 3);
  const f = enc.frame;
  enc.destroy();
  enc.step(3);
  eq(enc.frame, f, 'destroy 後 step 無效');
});

test('destroy 是幂等的', async () => {
  const { enc } = await makeEncounter();
  enc.destroy();
  enc.destroy();
  ok(true, '重複呼叫不爆炸');
});

test('destroy 後 getState 仍可呼叫（回傳空狀態）', async () => {
  const { enc } = await makeEncounter();
  enc.destroy();
  const s = enc.getState();
  ok(s, '有回傳值');
  isArray(s.actors, 'actors 陣列');
});

group('encounter：常數');

test('FPS / VIEW 尺寸符合 SPEC', () => {
  eq(FPS, 30, '30 FPS');
  eq(VIEW_W, 640, '640 寬');
  eq(VIEW_H, 480, '480 高');
});
