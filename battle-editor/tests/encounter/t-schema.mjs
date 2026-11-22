/**
 * tests/encounter/t-schema.mjs — 遭遇檔正規化 / 驗證 / 指令定義
 */

import { group, test, eq, ok, notOk, isArray, isObj, hasKey, deepEq } from '../engine/harness.mjs';
import {
  normalizeEncounter,
  validateEncounter,
  CUE_COMMANDS,
  ENCOUNTER_FORMAT,
  pickText,
  isTextValue,
  normalizeCue,
  normalizeCueList,
  num,
  bool,
} from '../../engine/encounter/schema.js';
import { baseEncounter, twoTurnEncounter } from './fixtures.mjs';

group('schema：normalizeEncounter');

test('空輸入也能正規化（永不 throw）', () => {
  const e = normalizeEncounter(null);
  isObj(e, '回傳物件');
  eq(e.format, ENCOUNTER_FORMAT, '補上 format');
  isArray(e.party, 'party 是陣列');
  isArray(e.enemies, 'enemies 是陣列');
  isArray(e.turns, 'turns 是陣列');
  isObj(e.actors, 'actors 是物件');
  eq(e.turnOrder, 'loop-last', 'turnOrder 預設 loop-last');
  eq(e.settings.seed, 1, 'seed 預設 1');
  deepEq(e.hooks, { intro: [], victory: [], spared: [], defeat: [], flee: [] }, 'hooks 全部補齊');
});

test('未知欄位保留（向前相容）', () => {
  const e = normalizeEncounter({ customTop: 42, meta: { name: 'x', extraMeta: 'y' }, settings: { weird: 1 } });
  eq(e.customTop, 42, '頂層未知欄位保留');
  eq(e.meta.extraMeta, 'y', 'meta 未知欄位保留');
  eq(e.settings.weird, 1, 'settings 未知欄位保留');
});

test('陣列欄位逐項補預設', () => {
  const e = normalizeEncounter({
    party: [{ id: 'kris' }],
    enemies: [{ id: 'r' }],
    turns: [{ id: 't1' }],
    items: [{ id: 'i1' }],
  });
  eq(e.party[0].maxHp, 100, '隊員 maxHp 預設 100');
  eq(e.party[0].hp, 100, 'hp 預設等於 maxHp');
  eq(e.party[0].color, '#ffff00', '預設顏色');
  deepEq(e.party[0].commands, ['fight', 'act', 'item', 'spare', 'defend'], '預設指令列');
  eq(e.enemies[0].spareAt, 100, 'spareAt 預設 100');
  eq(e.turns[0].attack, null, '沒攻擊時為 null');
  deepEq(e.turns[0].start, [], 'start 預設空');
  eq(e.items[0].count, 1, '道具數量預設 1');
  eq(e.items[0].target, 'party', '道具目標預設 party');
});

test('hp / maxHp 會被夾在合法範圍', () => {
  const e = normalizeEncounter({ party: [{ id: 'a', hp: 500, maxHp: 100 }], enemies: [{ id: 'b', hp: -5, maxHp: 50 }] });
  eq(e.party[0].hp, 100, 'hp 不可超過 maxHp');
  eq(e.enemies[0].hp, 0, 'hp 不可為負');
});

test('文字欄位接受字串與 {zh,en}', () => {
  const e = normalizeEncounter({
    meta: { name: { zh: '簡中', en: 'English' } },
    settings: { introText: '純字串' },
    turns: [{ id: 't', flavor: { zh: '旁邊', en: 'aside' } }],
  });
  deepEq(e.meta.name, { zh: '簡中', en: 'English' }, 'meta.name 保留雙語物件');
  eq(e.settings.introText, '純字串', 'introText 保留字串');
  deepEq(e.turns[0].flavor, { zh: '旁邊', en: 'aside' }, 'flavor 保留雙語');
});

test('pickText 依語言取字，缺語言時退回 zh / en', () => {
  eq(pickText({ zh: '甲', en: 'A' }, 'zh'), '甲', 'zh');
  eq(pickText({ zh: '甲', en: 'A' }, 'en'), 'A', 'en');
  eq(pickText({ en: 'A' }, 'zh'), 'A', '缺 zh 時退回 en');
  eq(pickText({ zh: '甲' }, 'en'), '甲', '缺 en 時退回 zh');
  eq(pickText('字串', 'en'), '字串', '字串原樣');
  eq(pickText(null, 'zh'), '', 'null → 空字串');
});

test('isTextValue 判定文字欄位', () => {
  ok(isTextValue('字串'), '字串合法');
  ok(isTextValue({ zh: '甲' }), '{zh} 合法');
  ok(isTextValue({ zh: '甲', en: 'A' }), '{zh,en} 合法');
  ok(isTextValue({}), '空物件視為合法（等於空字串）');
  notOk(isTextValue(42), '數字不合法');
  notOk(isTextValue({ ja: 'あ' }), '未知語言不合法');
  notOk(isTextValue({ zh: 1 }), '語系值非字串不合法');
});

test('actor 動畫狀態表會正規化', () => {
  const e = normalizeEncounter(baseEncounter());
  const idle = e.actors.kris.anims.idle;
  eq(idle.sprite, 'spr_krisb_idle', 'sprite');
  eq(idle.fps, 5, 'fps');
  eq(idle.loop, true, 'loop');
  eq(e.actors.kris.anims.hurt.then, 'idle', 'then');
  eq(e.actors.kris.kind, 'party', 'kind');
  eq(e.actors.rudinn.kind, 'enemy', '敵人 kind');
});

test('巢狀指令清單會被正規化（if / parallel）', () => {
  const e = normalizeEncounter({
    turns: [{
      id: 't',
      start: [
        { cmd: 'if', cond: '1', then: [{ cmd: 'wait', seconds: 0.2 }], else: [{ cmd: 'sfx', sound: 's' }] },
        { cmd: 'parallel', cues: [{ cmd: 'wait', seconds: 0.1 }] },
      ],
    }],
  });
  eq(e.turns[0].start[0].then[0].seconds, 0.2, 'then 內指令補齊');
  eq(e.turns[0].start[1].cues.length, 1, 'parallel 子清單長度');
  eq(e.turns[0].start[0].async, false, 'async 預設 false');
});

test('emitter / 攻擊內嵌物件保留', () => {
  const inline = { format: 'dr-battle-attack/1', settings: { duration: 2 }, timeline: [] };
  const e = normalizeEncounter({ turns: [{ id: 't', attack: inline }] });
  isObj(e.turns[0].attack, '內嵌攻擊保留為物件');
  eq(e.turns[0].attack.settings.duration, 2, '內容保留');
  const e2 = normalizeEncounter({ turns: [{ id: 't', attack: 'spade-rain' }] });
  eq(e2.turns[0].attack, 'spade-rain', '檔名字串保留');
});

group('schema：validateEncounter');

test('合法遭遇回傳空錯誤陣列', () => {
  deepEq(validateEncounter(baseEncounter()), [], '無錯誤');
  deepEq(validateEncounter(twoTurnEncounter()), [], '兩回合也無錯誤');
});

test('非物件 / 格式錯誤', () => {
  ok(validateEncounter(null).length > 0, 'null 應報錯');
  isArray(validateEncounter(null), '回傳陣列');
  const errs = validateEncounter({ format: 'wrong/1' });
  eq(errs[0].path, 'format', 'format 錯誤路徑');
  ok(errs[0].message.includes('dr-battle-encounter/1'), '訊息含正確格式');
});

test('未知指令 / 缺少必填 / 型別錯誤都會有 path', () => {
  const errs = validateEncounter({
    actors: { kris: { kind: 'party', x: 1, y: 1, anims: {} } },
    party: [{ id: 'kris', actor: 'kris', maxHp: 10 }],
    turns: [{
      id: 't',
      start: [
        { cmd: 'nope' },
        { cmd: 'move' },
        { cmd: 'wait', seconds: '不是數字' },
        { cmd: 'flip', actor: 'kris', value: 'yes' },
      ],
    }],
  });
  const paths = errs.map((e) => e.path);
  ok(paths.includes('turns[0].start[0].cmd'), '未知指令回報 cmd 路徑');
  ok(paths.includes('turns[0].start[1].actor'), 'move 缺 actor');
  ok(paths.some((p) => p === 'turns[0].start[2].seconds'), 'wait.seconds 型別');
  ok(paths.includes('turns[0].start[3].value'), 'flip.value 型別');
});

test('找不到演員 / 敵人 / 隊員 id 會報錯', () => {
  const errs = validateEncounter({
    actors: { a: { kind: 'party', x: 0, y: 0, anims: {} } },
    party: [{ id: 'kris', actor: '不存在', maxHp: 10 }],
    enemies: [{ id: 'e1', actor: 'a', acts: [{ id: 'x', cues: [{ cmd: 'anim', actor: 'ghost', anim: 'idle' }] }] }],
    turns: [{ id: 't', talk: [{ actor: 'nobody', text: 'hi' }] }],
  });
  const paths = errs.map((e) => e.path);
  ok(paths.includes('party[0].actor'), '隊員演員不存在');
  ok(paths.includes('enemies[0].acts[0].cues[0].actor'), '指令演員不存在（路徑格式同 SPEC）');
  ok(paths.includes('turns[0].talk[0].actor'), '台詞演員不存在');
});

test('重複 id 會報錯', () => {
  const errs = validateEncounter({
    actors: { a: { kind: 'party', x: 0, y: 0, anims: {} } },
    party: [
      { id: 'kris', actor: 'a', maxHp: 10 },
      { id: 'kris', actor: 'a', maxHp: 10 },
    ],
  });
  ok(errs.some((e) => e.path === 'party[1].id'), '隊員 id 重複');
});

test('表達式非法會在 validate 階段被擋下（含沙箱逃逸）', () => {
  const errs = validateEncounter({
    turns: [{
      id: 't',
      start: [{ cmd: 'set', var: 'x', value: '(0).constructor.constructor("return 1")()' }],
    }],
  });
  ok(errs.length > 0, '逃逸表達式應報錯');
  ok(errs[0].path === 'turns[0].start[0].value', `路徑應為 value（實際 ${errs[0].path}）`);
  ok(errs[0].message.includes('表達式'), '訊息提到表達式');
});

test('合法表達式不會被誤擋', () => {
  const errs = validateEncounter({
    actors: { kris: { kind: 'party', x: 0, y: 0, anims: {} }, rudinn: { kind: 'enemy', x: 1, y: 1, anims: {} } },
    party: [{ id: 'kris', actor: 'kris', maxHp: 90, hp: 50 }],
    enemies: [{ id: 'rudinn', actor: 'rudinn' }],
    turns: [{
      id: 't',
      start: [
        { cmd: 'set', var: 'x', value: 'var.complimented + 1' },
        { cmd: 'if', cond: 'mercy.rudinn >= 50 && hp.kris > 0' },
        { cmd: 'damage', target: 'party', amount: 'maxHp.kris - hp.kris' },
        { cmd: 'heal', target: 'kris', amount: 'lerp(1, 10, 0.5)' },
        { cmd: 'mercy', enemy: 'rudinn', amount: 'actCount.rudinn_compliment * 10 + turn * 2 + tp' },
      ],
    }],
  });
  deepEq(errs, [], '全部合法');
});

test('turns / hooks / vars 型別檢查', () => {
  const errs = validateEncounter({
    turns: 'not-array',
    hooks: { nope: [] },
    vars: { a: 'x' },
    turnOrder: 'weird',
  });
  const paths = errs.map((e) => e.path);
  ok(paths.includes('turns'), 'turns 型別');
  ok(paths.includes('hooks.nope'), '未知 hook');
  ok(paths.includes('vars.a'), 'vars 非數字');
  ok(paths.includes('turnOrder'), 'turnOrder 值域');
});

group('schema：指令定義（給編輯器比對）');

test('每條 CUE_COMMANDS 都有 category / blocking / params', () => {
  for (const [name, def] of Object.entries(CUE_COMMANDS)) {
    hasKey(def, 'category', `${name}.category`);
    hasKey(def, 'blocking', `${name}.blocking`);
    hasKey(def, 'params', `${name}.params`);
    ok(typeof def.blocking === 'boolean', `${name}.blocking 是布林`);
  }
});

test('必填參數標記正確', () => {
  ok(CUE_COMMANDS.say.params.text.required, 'say.text 必填');
  ok(CUE_COMMANDS.bubble.params.actor.required, 'bubble.actor 必填');
  ok(CUE_COMMANDS.move.params.actor.required, 'move.actor 必填');
  ok(CUE_COMMANDS.attack.params.attack.required, 'attack.attack 必填');
  ok(CUE_COMMANDS.end.params.result.required !== true, 'end.result 非必填');
  ok(CUE_COMMANDS['if'].params.cond.required, 'if.cond 必填');
});

test('enum 參數的值域與 SPEC-P2 一致', () => {
  deepEq(CUE_COMMANDS.end.params.result.values, ['victory', 'spared', 'defeat', 'flee'], 'end.result');
  deepEq(CUE_COMMANDS.bubble.params.side.values, ['left', 'right', 'auto'], 'bubble.side');
  deepEq(CUE_COMMANDS.set.params.op.values, ['set', 'add'], 'set.op');
});

test('normalizeCue 會補預設值', () => {
  eq(normalizeCue({ cmd: 'wait' }).seconds, 0.5, 'wait.seconds 預設 0.5');
  eq(normalizeCue({ cmd: 'move', actor: 'a' }).duration, 0.5, 'move.duration 預設 0.5');
  eq(normalizeCue({ cmd: 'move', actor: 'a' }).ease, 'quadOut', 'move.ease 預設 quadOut');
  eq(normalizeCue({ cmd: 'shake' }).amount, 4, 'shake.amount 預設 4');
  eq(normalizeCue({ cmd: 'bubble', actor: 'a', text: 'x' }).wait, 'input', 'bubble.wait 預設 input');
  eq(normalizeCue({ cmd: 'end' }).result, 'victory', 'end.result 預設 victory');
  eq(normalizeCue(null).cmd, 'wait', '空指令退化成 wait');
});

test('normalizeCue 保留 mercy 的表達式（不轉成 0）', () => {
  eq(normalizeCue({ cmd: 'mercy', enemy: 'e', amount: 'max(0, min(10, 94 - mercy.e))' }).amount,
    'max(0, min(10, 94 - mercy.e))', '表達式原樣保留，執行時才求值');
  eq(normalizeCue({ cmd: 'mercy', enemy: 'e', amount: 12 }).amount, 12, '數字照舊');
  eq(normalizeCue({ cmd: 'mercy', enemy: 'e' }).amount, 0, '沒給 → 0');
});

test('normalizeCueList 保留順序與巢狀', () => {
  const list = normalizeCueList([
    { cmd: 'wait', seconds: 1 },
    { cmd: 'parallel', cues: [{ cmd: 'sfx', sound: 'a' }] },
  ]);
  eq(list.length, 2, '長度');
  eq(list[0].seconds, 1, '順序 0');
  eq(list[1].cues[0].sound, 'a', '巢狀保留');
  deepEq(normalizeCueList('不是陣列'), [], '非陣列 → 空清單');
});

group('schema：小工具');

test('num / bool 轉型安全', () => {
  eq(num('12', 0), 12, '字串轉數字');
  eq(num('abc', 7), 7, '不合法回退');
  eq(num(NaN, 3), 3, 'NaN 回退');
  eq(bool('true'), true, '字串 true');
  eq(bool('0'), false, '字串 0');
  eq(bool(undefined, true), true, 'undefined 用預設');
  eq(bool(1), true, '數字 1');
});
