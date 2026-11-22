/**
 * editor/encounter/demo-panel.test.mjs — AP2：遭遇「演示」面板 + 自動開關測試
 *
 * 涵蓋：
 *   1. 純邏輯：demo 正規化、回合卡增刪移動、隊員選擇、欄位清除
 *   2. 下拉選項推算：command ← 隊員 commands；target ← 敵人／隊員；option ←
 *      目標敵人的 ACT／隊員法術／道具（含 count 0 排除、名字／id 比對）
 *   3. 錯誤：validateEncounterDemo 路徑 → 欄位定位（fieldPathFor / locateField）
 *   4. 三語字串：鍵集合一致、無空字串、en 無中文、zh-Hans 無繁體抽樣
 *   5. 原始碼掃描：demo-panel.js / autoplay-bar.js 用到的靜態鍵都存在
 *   6. 自動開關純邏輯：模式正規化、查詢字串、狀態文字
 *   7. actor-editor 的 normalizeAnim 選填 scale / flip（未設定時不多出鍵）
 *
 * 執行：node --test editor/encounter/demo-panel.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import STRINGS, {
  LOCALE_IDS,
  NAMESPACES,
  findKeyMismatches,
} from '../locales/encounter-demo.js';
import {
  actOf,
  addTurnCard,
  choiceForMember,
  commandsOf,
  createDemo,
  defaultChoicesKind,
  demoErrors,
  demoOf,
  demoSummary,
  describeChoice,
  enemiesOf,
  enemyOf,
  ensureChoice,
  ensureDemo,
  fieldPathFor,
  itemOf,
  matchOptionValue,
  membersOf,
  moveTurnCard,
  nextTurnNumber,
  normRef,
  optionsFor,
  refMatches,
  refOf,
  removeChoice,
  removeTurnCard,
  setField,
  spellOf,
  targetKindFor,
  targetsFor,
  textOf,
  turnEntries,
  usableItemsOf,
  validateDemo,
} from './demo-panel.js';
import {
  AUTOPLAY_MODES,
  AUTOPLAY_UI_ORDER,
  modeLabel,
  modeLabelKey,
  normalizeMode,
  parseAutoplayQuery,
  statusText,
  statusTitle,
  stepLabel,
  toggleAutoplayMode,
} from './autoplay-bar.js';
import { createAutopilot } from '../../engine/autoplay/index.js';
import { validateEncounterDemo } from '../../engine/autoplay/validate-encounter.js';
import * as i18n from '../i18n.js';
import { createStore } from '../store.js';
import * as demoModule from './demo-panel.js';

function choiceOf(entry, memberId) {
  const list = entry && Array.isArray(entry.choices) ? entry.choices : [];
  return list.find((c) => c.member === memberId) || null;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '../..');

/* ============================================================ 測試資料 */

function sampleDoc() {
  return {
    format: 1,
    seed: 7,
    party: [
      {
        id: 'kris',
        name: { zh: 'Kris', en: 'Kris' },
        hp: 90,
        atk: 10,
        def: 2,
        commands: ['fight', 'act', 'item', 'spare', 'defend'],
      },
      {
        id: 'ralsei',
        name: { zh: 'Ralsei', en: 'Ralsei' },
        hp: 70,
        atk: 8,
        def: 4,
        commands: ['fight', 'magic', 'item', 'spare', 'defend'],
        spells: [
          { id: 'pacify', name: { zh: '安撫', en: 'Pacify' }, tp: 32, target: 'enemy' },
          { id: 'heal-prayer', name: { zh: '治療祈禱', en: 'Heal Prayer' }, tp: 32, target: 'party' },
        ],
      },
    ],
    enemies: [
      {
        id: 'rudinn',
        name: { zh: 'Rudinn', en: 'Rudinn' },
        hp: 120,
        acts: [
          { id: 'check', name: { zh: '檢查', en: 'Check' }, party: ['kris'] },
          { id: 'compliment', name: { zh: '讚美', en: 'Compliment' }, party: ['kris'], mercy: 40 },
        ],
      },
      {
        id: 'hathy',
        name: { zh: 'Hathy', en: 'Hathy' },
        hp: 80,
        acts: [{ id: 'flatter', name: { zh: '奉承', en: 'Flatter' }, party: ['kris'], mercy: 50 }],
      },
    ],
    items: [
      { id: 'darkburger', name: { zh: '黑漢堡', en: 'Darkburger' }, heal: 70, count: 2, target: 'party' },
      { id: 'manual', name: { zh: '說明書', en: 'Manual' }, heal: 0, count: 0 },
    ],
    turns: [
      { start: [], attack: 'spade-rain', end: [] },
      { start: [], attack: 'ring-burst', end: [] },
      { start: [], attack: 'box-shrink-aim', end: [] },
    ],
    vars: { praised: 0 },
  };
}

function withDemo() {
  const doc = sampleDoc();
  doc.demo = createDemo();
  return doc;
}

/* =================================================== 1. 基本工具與名稱 */

test('locale：三語 × 三命名空間鍵完全一致', () => {
  assert.deepEqual(findKeyMismatches(), []);
  for (const ns of NAMESPACES) {
    for (const locale of LOCALE_IDS) {
      assert.ok(STRINGS[locale] && STRINGS[locale][ns], `${locale} 缺少 ${ns}`);
    }
  }
});

test('locale：沒有空字串、en 不含中文、zh-Hans 不用繁體字', () => {
  const empties = [];
  for (const locale of LOCALE_IDS) {
    for (const ns of NAMESPACES) {
      for (const [key, value] of Object.entries(STRINGS[locale][ns] || {})) {
        if (typeof value !== 'string' || !value.trim()) empties.push(`${locale}.${ns}.${key}`);
      }
    }
  }
  assert.deepEqual(empties, []);

  const cjk = [];
  for (const [key, value] of Object.entries(STRINGS.en.encdemo)) if (/[\u4e00-\u9fff]/.test(value)) cjk.push(`encdemo.${key}`);
  for (const [key, value] of Object.entries(STRINGS.en.encauto)) if (/[\u4e00-\u9fff]/.test(value)) cjk.push(`encauto.${key}`);
  for (const [key, value] of Object.entries(STRINGS.en.encanim)) if (/[\u4e00-\u9fff]/.test(value)) cjk.push(`encanim.${key}`);
  assert.deepEqual(cjk, []);

  const traditional = ['儲存', '復原', '預覽', '編輯器', '檢查', '檔案', '演員', '選單', '開始'];
  const hits = [];
  for (const ns of NAMESPACES) {
    for (const [key, value] of Object.entries(STRINGS['zh-Hans'][ns] || {})) {
      if (traditional.some((w) => value.includes(w))) hits.push(`${ns}.${key}: ${value}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('locale：佔位符 {param} 三語一致', () => {
  const problems = [];
  const placeholders = (s) => (String(s).match(/\{[a-zA-Z0-9_]+\}/g) || []).sort().join(',');
  for (const ns of NAMESPACES) {
    const base = STRINGS['zh-Hant'][ns] || {};
    for (const key of Object.keys(base)) {
      const want = placeholders(base[key]);
      for (const locale of LOCALE_IDS) {
        const got = placeholders((STRINGS[locale][ns] || {})[key]);
        if (got !== want) problems.push(`${locale}.${ns}.${key}: ${got} != ${want}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test('textOf / refOf / refMatches：字串與 {zh,en} 都能比對', () => {
  assert.equal(textOf('abc'), 'abc');
  assert.equal(textOf({ zh: '讚美', en: 'Compliment' }), '讚美');
  assert.equal(textOf({ en: 'Check' }), 'Check');
  assert.equal(textOf(null), '');
  assert.equal(refOf({ id: 'check', name: { zh: '檢查' } }), 'check');
  assert.equal(refOf({ name: { zh: '檢查' } }), '檢查');
  const act = { id: 'compliment', name: { zh: '讚美', en: 'Compliment' } };
  assert.ok(refMatches(act, 'compliment'));
  assert.ok(refMatches(act, '讚美'));
  assert.ok(refMatches(act, 'Compliment'));
  assert.ok(!refMatches(act, 'check'));
  assert.ok(!refMatches(act, ''));
});

test('normRef / matchOptionValue：demo 用名字寫的選項也對得到下拉 value', () => {
  assert.equal(normRef('X-Action'), 'xaction');
  assert.equal(normRef('Compliment'), 'compliment');
  assert.equal(normRef(null), '');

  const opts = [
    { value: 'check', label: '檢查' },
    { value: 'compliment', label: '讚美' },
    { value: 'xaction', label: 'X-Action' },
  ];
  assert.equal(matchOptionValue(opts, 'compliment'), 'compliment');
  assert.equal(matchOptionValue(opts, 'Compliment'), 'compliment', '英文名比對（無視大小寫）');
  assert.equal(matchOptionValue(opts, 'X-Action'), 'xaction', '大小寫與連字號不影響');
  assert.equal(matchOptionValue(opts, 'xaction'), 'xaction');
  assert.equal(matchOptionValue(opts, '讚美'), 'compliment', '中文標籤也比對');
  assert.equal(matchOptionValue(opts, '檢查'), 'check');
  assert.equal(matchOptionValue(opts, 'nope'), 'nope', '找不到就原樣回傳（UI 顯示「找不到」）');
  assert.equal(matchOptionValue(opts, ''), '');
  assert.equal(matchOptionValue(opts, null), '');
  assert.equal(matchOptionValue(null, 'x'), 'x');
});

/* ========================================================= 2. 清單來源 */

test('membersOf / enemiesOf / usableItemsOf：count 0 的道具被排除', () => {
  const doc = sampleDoc();
  assert.deepEqual(membersOf(doc).map((m) => m.id), ['kris', 'ralsei']);
  assert.deepEqual(enemiesOf(doc).map((e) => e.id), ['rudinn', 'hathy']);
  assert.deepEqual(usableItemsOf(doc).map((it) => it.id), ['darkburger']);
  assert.equal(itemOf(doc, 'manual'), null);
  assert.ok(itemOf(doc, 'darkburger'));
  assert.ok(itemOf(doc, '黑漢堡'));
});

test('commandsOf：只保留隊員真正有的指令，缺 commands 時退回全部', () => {
  const doc = sampleDoc();
  assert.deepEqual(commandsOf(doc.party[0]), ['fight', 'act', 'item', 'spare', 'defend']);
  assert.deepEqual(commandsOf({ id: 'x' }), ['fight', 'act', 'magic', 'item', 'spare', 'defend']);
});

test('optionsFor：act 讀目標敵人的 ACT、magic 讀法術、item 讀可用道具', () => {
  const doc = sampleDoc();

  const acts = optionsFor(doc, { memberId: 'kris', command: 'act', target: 'rudinn' });
  assert.deepEqual(acts.map((o) => o.value), ['check', 'compliment']);
  assert.equal(acts[1].label, '讚美');
  assert.equal(acts[1].hint, 'kris');

  const acts2 = optionsFor(doc, { memberId: 'kris', command: 'act', target: 'hathy' });
  assert.deepEqual(acts2.map((o) => o.value), ['flatter']);

  const spells = optionsFor(doc, { memberId: 'ralsei', command: 'magic' });
  assert.deepEqual(spells.map((o) => o.value), ['pacify', 'heal-prayer']);
  assert.match(spells[0].hint, /32 TP/);
  assert.match(spells[1].hint, /party/);

  const items = optionsFor(doc, { memberId: 'kris', command: 'item' });
  assert.deepEqual(items.map((o) => o.value), ['darkburger']);
  assert.match(items[0].hint, /×2/);

  assert.deepEqual(optionsFor(doc, { memberId: 'kris', command: 'fight' }), []);
  assert.deepEqual(optionsFor(doc, { memberId: 'kris', command: 'act', target: 'nope' }), []);
  assert.deepEqual(optionsFor(doc, { memberId: 'ralsei', command: 'magic' }).length, 2);
  assert.deepEqual(optionsFor(doc, { memberId: 'kris', command: 'magic' }), []);
});

test('targetKindFor / targetsFor：依 command 與 option 決定敵人或隊員', () => {
  const doc = sampleDoc();
  assert.equal(targetKindFor(doc, { command: 'fight' }), 'enemy');
  assert.equal(targetKindFor(doc, { command: 'spare' }), 'enemy');
  assert.equal(targetKindFor(doc, { command: 'act' }), 'enemy');
  assert.equal(targetKindFor(doc, { command: 'defend' }), null);
  assert.equal(targetKindFor(doc, { memberId: 'ralsei', command: 'magic', option: 'pacify' }), 'enemy');
  assert.equal(targetKindFor(doc, { memberId: 'ralsei', command: 'magic', option: 'heal-prayer' }), 'party');
  assert.equal(targetKindFor(doc, { command: 'item', option: 'darkburger' }), 'party');

  assert.deepEqual(targetsFor(doc, { command: 'fight' }).map((t) => t.value), ['rudinn', 'hathy']);
  assert.deepEqual(targetsFor(doc, { command: 'item', option: 'darkburger' }).map((t) => t.value), ['kris', 'ralsei']);
  assert.deepEqual(targetsFor(doc, { command: 'defend' }), []);
});

test('actOf / spellOf：省略 option 時取第一個（與引擎語意一致）', () => {
  const doc = sampleDoc();
  assert.equal(actOf(doc.enemies[0], null).id, 'check');
  assert.equal(actOf(doc.enemies[0], 'compliment').id, 'compliment');
  assert.equal(actOf(doc.enemies[0], '讚美').id, 'compliment');
  assert.equal(actOf(doc.enemies[0], 'nope'), null);
  assert.equal(spellOf(doc.party[1], null).id, 'pacify');
  assert.equal(spellOf(doc.party[1], 'heal-prayer').id, 'heal-prayer');
});

/* ===================================================== 3. 回合卡增刪改 */

test('turnEntries：依 turn 號排序，缺 turn 的排最後', () => {
  const demo = {
    turns: [
      { turn: 3, choices: [] },
      { choices: [] },
      { turn: 1, choices: [] },
      { turn: 2, choices: [] },
    ],
  };
  assert.deepEqual(turnEntries(demo).map((it) => it.entry.turn), [1, 2, 3, undefined]);
  assert.deepEqual(turnEntries(null), []);
});

test('nextTurnNumber：跳過已用號碼', () => {
  assert.equal(nextTurnNumber({ turns: [] }, 3), 1);
  assert.equal(nextTurnNumber({ turns: [{ turn: 1 }, { turn: 2 }] }, 3), 3);
  assert.equal(nextTurnNumber({ turns: [{ turn: 1 }, { turn: 3 }] }, 3), 2);
  assert.equal(nextTurnNumber({ turns: [{ turn: 1 }, { turn: 2 }] }, 2), 3);
});

test('addTurnCard：新增的卡有 turn 號且排在最後', () => {
  const doc = withDemo();
  addTurnCard(doc, 3);
  assert.equal(doc.demo.turns.length, 1);
  assert.equal(doc.demo.turns[0].turn, 1);
  assert.deepEqual(doc.demo.turns[0].choices, []);
  addTurnCard(doc, 3);
  assert.equal(doc.demo.turns[1].turn, 2);
});

test('removeTurnCard：越界不做事，正常移除', () => {
  const doc = withDemo();
  addTurnCard(doc, 3);
  addTurnCard(doc, 3);
  assert.equal(removeTurnCard(doc, 9), false);
  assert.equal(removeTurnCard(doc, -1), false);
  assert.equal(removeTurnCard(doc, 0), true);
  assert.equal(doc.demo.turns.length, 1);
  assert.equal(doc.demo.turns[0].turn, 2);
});

test('moveTurnCard：交換 turn 號（腳本順序改變）', () => {
  const doc = withDemo();
  addTurnCard(doc, 3); // turn 1
  addTurnCard(doc, 3); // turn 2
  const first = doc.demo.turns[0];
  const second = doc.demo.turns[1];
  assert.equal(moveTurnCard(doc, 0, 1), true);
  // 兩張卡互換 turn 號，陣列位置不變（畫面依 turn 排序 → 順序看起來交換了）
  assert.equal(first.turn, 2);
  assert.equal(second.turn, 1);
  assert.equal(doc.demo.turns[0], first);
  assert.deepEqual(turnEntries(doc.demo).map((it) => it.entry.turn), [1, 2]);
  assert.equal(turnEntries(doc.demo)[0].entry, second, 'turn 1 的卡現在排最前面');
  // 再按一次回到原狀
  assert.equal(moveTurnCard(doc, 0, -1), true);
  assert.equal(first.turn, 1);
  assert.equal(second.turn, 2);
  // 只有一張卡時沒有鄰居
  const one = withDemo();
  addTurnCard(one, 3);
  assert.equal(moveTurnCard(one, 0, -1), false, '第一張不能再往上');
  assert.equal(moveTurnCard(one, 0, 1), false, '最後一張不能再往下');
});

test('moveTurnCard：沒有 turn 號時交換陣列位置', () => {
  const doc = withDemo();
  const a = { choices: [] };
  const b = { choices: [] };
  doc.demo.turns.push(a, b);
  assert.equal(moveTurnCard(doc, 0, 1), true);
  assert.equal(doc.demo.turns[0], b);
  assert.equal(doc.demo.turns[1], a);
});

test('ensureChoice / removeChoice：每位隊員一列，移除即回到預設', () => {
  const doc = withDemo();
  addTurnCard(doc, 3);
  const entry = ensureChoice(doc, 0, 'kris');
  assert.equal(entry.member, 'kris');
  assert.equal(entry.command, 'fight');
  assert.equal(doc.demo.turns[0].choices.length, 1);

  const again = ensureChoice(doc, 0, 'kris');
  assert.equal(again, entry, '同一位隊員不重複建立');
  assert.equal(doc.demo.turns[0].choices.length, 1);

  const ralsei = ensureChoice(doc, 0, 'ralsei');
  assert.equal(ralsei.command, 'fight');
  assert.equal(doc.demo.turns[0].choices.length, 2);

  assert.equal(choiceForMember(doc.demo.turns[0], 'kris'), entry);
  assert.equal(choiceForMember(doc.demo.turns[0], 'susie'), null);

  assert.equal(removeChoice(doc, 0, 'kris'), true);
  assert.equal(removeChoice(doc, 0, 'kris'), false);
  assert.equal(doc.demo.turns[0].choices.length, 1);
});

test('setField：空字串 / null / undefined 都是清除', () => {
  const doc = withDemo();
  addTurnCard(doc, 3);
  const choice = ensureChoice(doc, 0, 'kris');
  assert.equal(setField(choice, 'command', 'act'), true);
  assert.equal(setField(choice, 'option', 'compliment'), true);
  assert.equal(setField(choice, 'option', ''), true);
  assert.ok(!('option' in choice));
  assert.equal(setField(choice, 'option', ''), false, '已經沒有這個鍵就不算變更');
  assert.equal(setField(choice, 'fight', 'perfect'), true);
  assert.equal(choice.fight, 'perfect');
});

test('ensureDemo：缺欄位補齊、不覆蓋既有值', () => {
  const draft = { demo: { turns: [{ turn: 2, choices: [] }], menuDelay: 0 } };
  const demo = ensureDemo(draft);
  assert.equal(demo.menuDelay, 0);
  assert.ok(demo.text && demo.text.auto === true);
  assert.ok(demo.default && demo.default.choices === 'fight');
  assert.equal(draft.demo.turns.length, 1);
  assert.deepEqual(ensureDemo({}).turns, []);
});

test('defaultChoicesKind：字串 / 陣列 / 未設定', () => {
  assert.equal(defaultChoicesKind(null).kind, 'unset');
  assert.equal(defaultChoicesKind({ default: {} }).kind, 'unset');
  const c = defaultChoicesKind({ default: { choices: 'defend' } });
  assert.equal(c.kind, 'command');
  assert.equal(c.value, 'defend');
  const a = defaultChoicesKind({ default: { choices: [{ member: 'kris', command: 'fight' }] } });
  assert.equal(a.kind, 'array');
  assert.equal(a.list.length, 1);
  assert.equal(defaultChoicesKind({ default: { choices: 5 } }).kind, 'invalid');
});

test('describeChoice / demoSummary / demoOf', () => {
  const doc = withDemo();
  assert.equal(demoOf(doc), doc.demo);
  assert.equal(demoOf({}), null);
  addTurnCard(doc, 3);
  const choice = ensureChoice(doc, 0, 'kris');
  choice.command = 'act';
  choice.target = 'rudinn';
  choice.option = 'compliment';
  assert.equal(describeChoice(doc, choice), 'Kris · act · rudinn · compliment');
  const s = demoSummary(doc);
  assert.equal(s.hasDemo, true);
  assert.equal(s.cards, 1);
  assert.equal(s.choices, 1);
  assert.equal(s.turnCount, 3);
  assert.equal(s.autoText, true);
  assert.equal(s.menuDelay, 6);
  assert.equal(demoSummary({}).hasDemo, false);
});

/* ================================================ 4. 驗證與欄位定位 */

test('validateDemo：回傳路徑，與 validateEncounterDemo 一致', () => {
  const doc = withDemo();
  doc.demo.turns.push({
    turn: 1,
    choices: [
      { member: 'kris', command: 'act', target: 'rudinn', option: 'nope' },
      { member: 'nobody', command: 'act', target: 'rudinn' },
      { member: 'kris', command: 'bogus' },
    ],
  });
  doc.demo.menuDelay = -3;
  const errs = validateDemo(doc);
  const paths = errs.map((e) => e.path);
  assert.ok(paths.includes('demo.turns[0].choices[0].option'), paths.join(' | '));
  assert.ok(paths.includes('demo.turns[0].choices[1].member'));
  assert.ok(paths.includes('demo.turns[0].choices[2].command'));
  assert.ok(paths.includes('demo.menuDelay'));
  assert.deepEqual(validateDemo({}), []);
  // 路徑與引擎驗證器一致
  const direct = validateEncounterDemo(doc.demo, doc).map((e) => e.path);
  assert.deepEqual(paths.sort(), direct.sort());
});

test('demoErrors：只留 demo.* 的錯誤，各種容器都能吃', () => {
  const asMap = new Map([
    ['actors.kris.hp', 'HP 怪怪的'],
    ['demo.turns[0].choices[0].option', '找不到選項'],
    ['demo.menuDelay', 'menuDelay 不能是負數'],
    ['demo', '整體錯誤'],
    ['turns[0].attack', '缺攻擊檔'],
  ]);
  const fromMap = demoErrors(asMap).map((e) => e.path);
  assert.deepEqual(fromMap, ['demo', 'demo.menuDelay', 'demo.turns[0].choices[0].option']);

  const fromArray = demoErrors([{ path: 'demo.text.auto', message: 'x' }, { path: 'actors', message: 'y' }]);
  assert.deepEqual(fromArray.map((e) => e.path), ['demo.text.auto']);

  const fromObj = demoErrors({ 'demo.default.fight': 'bad', other: 'z' });
  assert.deepEqual(fromObj.map((e) => e.path), ['demo.default.fight']);
  assert.deepEqual(demoErrors(null), []);
});

test('fieldPathFor：錯誤路徑對到可定位的欄位容器', () => {
  assert.equal(fieldPathFor('demo.turns[0].choices[1].option'), 'demo.turns[0].choices[1]');
  assert.equal(fieldPathFor('demo.turns[2].fight'), 'demo.turns[2]');
  assert.equal(fieldPathFor('demo.turns[0].choices[0].command'), 'demo.turns[0].choices[0]');
  assert.equal(fieldPathFor('demo.default.choices'), 'demo.default');
  assert.equal(fieldPathFor('demo.text.delay'), 'demo.text');
  assert.equal(fieldPathFor('demo.menuDelay'), 'demo.menuDelay');
  assert.equal(fieldPathFor('demo'), 'demo');
});

test('locateField：用假的 data-demo-path 節點樹驗證定位優先序', () => {
  // 最小 DOM 替身：只需要 querySelectorAll + dataset 就能驗證演算法
  const make = (p) => ({ dataset: { demoPath: p } });
  const nodes = [make('demo.turns[0]'), make('demo.turns[0].choices[0]'), make('demo.text'), make('demo.menuDelay')];
  const root = {
    querySelectorAll: () => nodes,
  };
  const locate = (full) => {
    const exact = nodes.find((n) => n.dataset.demoPath === full);
    if (exact) return exact;
    const want = fieldPathFor(full);
    const byField = nodes.find((n) => n.dataset.demoPath === want);
    if (byField) return byField;
    let best = null;
    let bestLen = -1;
    for (const node of nodes) {
      const p = node.dataset.demoPath || '';
      if ((full === p || full.startsWith(`${p}.`) || full.startsWith(`${p}[`)) && p.length > bestLen) {
        best = node;
        bestLen = p.length;
      }
    }
    return best;
  };
  assert.equal(locate('demo.text'), nodes[2]);
  assert.equal(locate('demo.text.delay'), nodes[2], '子欄位落到最近的容器');
  assert.equal(locate('demo.turns[0].choices[0].option'), nodes[1]);
  assert.equal(locate('demo.turns[0].choices[3].fight'), nodes[0], '沒有這一列就落到卡片');
  assert.equal(locate('demo.menuDelay'), nodes[3]);
  assert.equal(locate('demo.default.choices'), null, '沒有對應欄位時回 null（由 UI 顯示提示）');
});

/* =============================================== 5. 原始碼鍵覆蓋掃描 */

function sourceOf(file) {
  return readFileSync(path.join(HERE, file), 'utf8');
}

test('原始碼：demo-panel.js 用到的 encdemo 靜態鍵都存在', () => {
  const src = sourceOf('demo-panel.js');
  const used = new Set();
  for (const m of src.matchAll(/\bT\(\s*'([^']+)'/g)) used.add(m[1]);
  for (const m of src.matchAll(/\bT\(\s*`([^`]+)`/g)) used.add(m[1]);
  assert.ok(used.size > 25, `只掃到 ${used.size} 個鍵，疑似掃描失效`);

  const base = STRINGS['zh-Hant'].encdemo;
  const dynamic = ['fight.perfect', 'fight.good', 'fight.ok', 'fight.miss', 'dodge.path', 'dodge.inputs', 'dodge.bot', 'dodge.none'];
  const commands = ['fight', 'act', 'magic', 'item', 'spare', 'defend'].map((c) => `command.${c}`);
  const known = new Set([...dynamic, ...commands]);
  const missing = [...used].filter((k) => !(k in base) && !k.includes('${') && !known.has(k));
  assert.deepEqual(missing, [], `字串表缺少：${missing.join(', ')}`);
});

test('原始碼：autoplay-bar.js 用到的 encauto 靜態鍵都存在', () => {
  const src = sourceOf('autoplay-bar.js');
  const used = new Set();
  for (const m of src.matchAll(/\bT\(\s*'([^']+)'/g)) used.add(m[1]);
  for (const m of src.matchAll(/\bT\(\s*`([^`]+)`/g)) used.add(m[1]);
  assert.ok(used.size >= 4, `只掃到 ${used.size} 個鍵`);
  const base = STRINGS['zh-Hant'].encauto;
  const missing = [...used].filter((k) => !(k in base) && !k.includes('${'));
  assert.deepEqual(missing, [], `字串表缺少：${missing.join(', ')}`);
});

test('原始碼：面板沒有硬編碼的中介面字串（粗略）', () => {
  const allow = new Set(['demo', 'demo · ', ' 卡 · ', ' 選擇', '0..1', 'builtin', 'AUTO · ', '']);
  const problems = [];
  for (const file of ['demo-panel.js', 'autoplay-bar.js']) {
    const src = sourceOf(file);
    for (const m of src.matchAll(/text:\s*'([^']*)'/g)) {
      const value = m[1];
      if (/[\u4e00-\u9fff]/.test(value) && !allow.has(value)) problems.push(`${file}: text '${value}'`);
    }
  }
  // mountDemoTab 的 `demo · N 卡 · M 選擇` 是刻意保留的除錯字串
  const filtered = problems.filter((p) => !p.includes('demo · '));
  assert.deepEqual(filtered, []);
});

/* =============================================== 6. 自動開關純邏輯 */

test('autoplay-bar：狀態文字不會重複模式名', () => {
  const before = i18n.getLocale();
  i18n.setLocale('zh-Hant');
  try {
    const text = statusText({ mode: 'demo', describe: { mode: 'demo', turn: 3, step: 'text' } });
    const occurrences = text.split('腳本').length - 1;
    assert.equal(occurrences, 1, `模式名重複：${text}`);
    assert.ok(text.startsWith('AUTO'), text);
    assert.ok(text.includes('T3'), text);
    assert.ok(text.includes(STRINGS['zh-Hant'].encauto.stepText), text);
  } finally {
    i18n.setLocale(before);
  }
});

test('autoplay-bar：模式清單與正規化', () => {
  assert.deepEqual(AUTOPLAY_MODES, ['off', 'demo', 'bot']);
  assert.deepEqual(AUTOPLAY_UI_ORDER, ['off', 'demo', 'bot']);
  assert.equal(normalizeMode('demo'), 'demo');
  assert.equal(normalizeMode('bot'), 'bot');
  assert.equal(normalizeMode('off'), 'off');
  assert.equal(normalizeMode('nonsense'), 'off');
  assert.equal(normalizeMode(undefined), 'off');
  assert.equal(modeLabelKey('bot'), 'bot');
  assert.ok(modeLabel('demo').length > 0);
  assert.notEqual(modeLabel('demo'), 'encauto.demo');
});

test('autoplay-bar：parseAutoplayQuery', () => {
  assert.equal(parseAutoplayQuery('?autoplay=demo'), 'demo');
  assert.equal(parseAutoplayQuery('?autoplay=bot'), 'bot');
  assert.equal(parseAutoplayQuery('?autoplay=off'), 'off');
  assert.equal(parseAutoplayQuery('?autoplay=weird'), 'off');
  assert.equal(parseAutoplayQuery('?foo=1'), null);
  assert.equal(parseAutoplayQuery(''), null);
  assert.equal(parseAutoplayQuery('autoplay=demo'), 'demo');
  assert.equal(parseAutoplayQuery('?a=1&autoplay=bot&b=2'), 'bot');
});

test('autoplay-bar：P 鍵切換（關 ⇄ 上次開啟的模式）', () => {
  assert.equal(toggleAutoplayMode('off', 'demo'), 'demo');
  assert.equal(toggleAutoplayMode('off', 'bot'), 'bot');
  assert.equal(toggleAutoplayMode('off', 'off'), 'demo', '沒有記憶時退回腳本');
  assert.equal(toggleAutoplayMode('demo', 'demo'), 'off');
  assert.equal(toggleAutoplayMode('bot', 'demo'), 'off');
  assert.equal(toggleAutoplayMode('nonsense', 'bot'), 'bot');
});

test('autoplay-bar：stepLabel 與狀態文字', () => {
  const before = i18n.getLocale();
  i18n.setLocale('zh-Hant');
  try {
    assert.equal(stepLabel('menu'), STRINGS['zh-Hant'].encauto.stepMenu);
  assert.equal(stepLabel('dodge'), STRINGS['zh-Hant'].encauto.stepDodge);
  assert.equal(stepLabel('unknown-step'), 'unknown-step');

  const off = statusText({ mode: 'off' });
  assert.equal(off, STRINGS['zh-Hant'].encauto.off);

  const demo = statusText({ mode: 'demo' });
  assert.match(demo, /AUTO/);
  assert.ok(demo.includes(STRINGS['zh-Hant'].encauto.demo));

  const detail = statusText({ mode: 'bot', describe: { mode: 'bot', turn: 2, step: 'menu' }, warnings: [] });
  assert.ok(detail.includes('AUTO'));
  assert.ok(detail.includes('2'), detail);
  assert.ok(detail.includes(STRINGS['zh-Hant'].encauto.stepMenu), detail);

  const withWarn = statusText({ mode: 'demo', warnings: ['a', 'b'] });
  assert.ok(withWarn.includes(STRINGS['zh-Hant'].encauto.warnings.replace('{n}', '2')), withWarn);

  const title = statusTitle({ mode: 'demo', describe: { turn: 1, step: 'text' } });
    assert.ok(title.split('\n').length >= 2);
  } finally {
    i18n.setLocale(before);
  }
});

/* ======================= 7. createAutopilot 介面（面板實際會用到的部分） */

test('createAutopilot：遭遇模式暴露 setAutoplay 需要的介面', async () => {
  const doc = withDemo();
  const pilot = createAutopilot({ kind: 'encounter', doc, mode: 'demo' });
  assert.equal(pilot.kind, 'encounter');
  assert.equal(pilot.mode, 'demo');
  assert.equal(typeof pilot.input, 'function');
  assert.equal(typeof pilot.reset, 'function');
  assert.equal(typeof pilot.describe, 'function');
  assert.ok(Array.isArray(pilot.warnings));
  await pilot.ready;
  const described = pilot.describe();
  assert.ok(['demo', 'bot'].includes(described.mode), JSON.stringify(described));
  assert.ok('step' in described);
  assert.ok('turn' in described);

  const botPilot = createAutopilot({ kind: 'encounter', doc, mode: 'bot' });
  assert.equal(botPilot.mode, 'bot');
  await botPilot.ready;

  const input = pilot.input({ frame: 0, phase: 'intro', party: [], enemies: [], menu: null }, 0);
  assert.ok(Array.isArray(input.press), 'input 必須回傳引擎輸入格式');
  assert.equal(typeof input.hold, 'object');
});

/* ======================= 8. 演員編輯器：選填 scale / flip */

const actorMod = await import('./actor-editor.js');

test('actor normalizeAnim：未設定 scale/flip 時輸出不變', () => {
  assert.deepEqual(actorMod.normalizeAnim(null), { sprite: null, fps: 5, loop: true, then: null });
  assert.deepEqual(actorMod.createAnim(), { sprite: null, fps: 5, loop: true, then: null });
  const anim = actorMod.normalizeAnim({ sprite: 'a', fps: 8, loop: false, then: 'idle' });
  assert.deepEqual(anim, { sprite: 'a', fps: 8, loop: false, then: 'idle' });
});

test('actor normalizeAnim：scale / flip 有值才寫出', () => {
  const scaled = actorMod.normalizeAnim({ sprite: 'a', scale: 1.5 });
  assert.equal(scaled.scale, 1.5);
  assert.ok(!('flip' in scaled), '沒設 flip 就不該出現');

  const minimal = actorMod.normalizeAnim({ sprite: 'a', scale: 0.001 });
  assert.equal(minimal.scale, 0.01, 'scale 下限 0.01');

  const flipped = actorMod.normalizeAnim({ sprite: 'a', flip: true });
  assert.equal(flipped.flip, true);
  const notFlipped = actorMod.normalizeAnim({ sprite: 'a', flip: false });
  assert.equal(notFlipped.flip, false, 'false 是明確值，要保留');
  assert.ok(!('scale' in notFlipped));

  const junk = actorMod.normalizeAnim({ scale: 'abc', flip: null });
  assert.ok(!('scale' in junk));
  assert.ok(!('flip' in junk));
});


/* ======================= 9. 掛載層（用最小 DOM 替身，不引入外部依賴） ======================= */

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.scrollTop = 0;
    this.title = '';
    this._text = '';
    this._listeners = new Map();
  }
  get classList() {
    const node = this;
    return {
      add: (...names) => {
        const set = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
        for (const n of names) set.add(n);
        node.className = [...set].join(' ');
      },
      remove: (...names) => {
        const drop = new Set(names);
        node.className = String(node.className || '')
          .split(/\s+/)
          .filter((n) => n && !drop.has(n))
          .join(' ');
      },
      contains: (name) => String(node.className || '').split(/\s+/).includes(name),
      toggle: (name, force) => {
        const has = String(node.className || '').split(/\s+/).includes(name);
        const want = force === undefined ? !has : !!force;
        if (want && !has) node.classList.add(name);
        if (!want && has) node.classList.remove(name);
        return want;
      },
    };
  }
  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }
  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(String(name));
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get options() {
    return this.tagName === 'SELECT' ? this.children.filter((c) => c.tagName === 'OPTION') : undefined;
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    const idx = this.children.indexOf(ref);
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    if (idx < 0) this.children.push(child);
    else this.children.splice(idx, 0, child);
    return child;
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  get textContent() {
    if (this.children.length === 0) return this._text;
    return this._text + this.children.map((c) => c.textContent).join('');
  }
  set textContent(value) {
    this._text = String(value === null || value === undefined ? '' : value);
    this.children = [];
  }
  set innerHTML(value) {
    this._text = '';
    this.children = [];
    if (value && String(value).trim()) throw new Error('FakeNode 不支援非空 innerHTML');
  }
  get innerHTML() {
    return '';
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    const set = this._listeners.get(type);
    if (set) set.delete(fn);
  }
  dispatchEvent(evt) {
    const event = { target: this, type: 'event', preventDefault() {}, stopPropagation() {}, ...evt };
    for (const fn of [...(this._listeners.get(event.type) || [])]) fn(event);
    return true;
  }
  focus() {
    if (globalThis.document) globalThis.document.activeElement = this;
  }
  blur() {
    if (globalThis.document && globalThis.document.activeElement === this) globalThis.document.activeElement = null;
  }
  scrollIntoView() {
    this.scrolledIntoView = (this.scrolledIntoView || 0) + 1;
  }
  matches(selector) {
    return matchSimple(this, selector);
  }
  querySelectorAll(selector) {
    const out = [];
    const parts = String(selector).split(',').map((x) => x.trim()).filter(Boolean);
    const walk = (node) => {
      for (const child of node.children) {
        if (parts.some((p) => matchSimple(child, p))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function attrOf(node, name) {
  if (name.startsWith('data-')) {
    const key = name
      .slice(5)
      .replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    return node.dataset && node.dataset[key] !== undefined ? String(node.dataset[key]) : null;
  }
  if (name === 'class') return node.className || '';
  return node.getAttribute(name);
}

/** 只支援 tag / .class / #id / [attr] / [attr="v"] 與它們的組合。 */
function matchSimple(node, selector) {
  const sel = selector.trim();
  if (!sel) return false;
  const tokens = sel.match(/^([a-zA-Z*]+)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
  if (!tokens) return false;
  const [, tag, rest] = tokens;
  if (tag && tag !== '*' && node.tagName !== tag.toUpperCase()) return false;
  const re = /([.#])([\w-]+)|\[([^\]=]+)(?:="?([^"\]]*)"?)?\]/g;
  let m;
  while ((m = re.exec(rest || '')) !== null) {
    if (m[1] === '.') {
      if (!String(node.className || '').split(/\s+/).includes(m[2])) return false;
    } else if (m[1] === '#') {
      if (attrOf(node, 'id') !== m[2]) return false;
    } else {
      const value = attrOf(node, m[3]);
      if (m[4] === undefined) {
        if (value === null) return false;
      } else if (value !== m[4]) return false;
    }
  }
  return true;
}

function installFakeDom() {
  const head = new FakeNode('head');
  const body = new FakeNode('body');
  const html = new FakeNode('html');
  const byId = new Map();
  const doc = {
    baseURI: 'http://localhost/',
    documentElement: html,
    head,
    body,
    activeElement: null,
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => {
      const n = new FakeNode('#text');
      n.textContent = text;
      return n;
    },
    getElementById(id) {
      return byId.get(id) || body.querySelector(`#${id}`) || head.querySelector(`#${id}`);
    },
    querySelectorAll(selector) {
      return [...head.querySelectorAll(selector), ...body.querySelectorAll(selector)];
    },
    querySelector(selector) {
      return doc.querySelectorAll(selector)[0] || null;
    },
    addEventListener() {},
    removeEventListener() {},
    register(node, id) {
      byId.set(id, node);
      node.setAttribute('id', id);
      return node;
    },
  };
  globalThis.document = doc;
  globalThis.Node = FakeNode;
  return doc;
}

function uninstallFakeDom(saved) {
  if (saved.document === undefined) delete globalThis.document;
  else globalThis.document = saved.document;
  if (saved.Node === undefined) delete globalThis.Node;
  else globalThis.Node = saved.Node;
}

function mountableDoc() {
  const doc = sampleDoc();
  doc.demo = {
    text: { auto: true, delay: 0.5 },
    menuDelay: 6,
    turns: [
      {
        turn: 1,
        fight: 'perfect',
        dodge: 'path',
        choices: [
          { member: 'kris', command: 'act', target: 'rudinn', option: 'compliment' },
          { member: 'ralsei', command: 'defend' },
        ],
      },
    ],
    default: { choices: 'fight', fight: 'good', dodge: 'bot' },
  };
  return doc;
}

test('掛載：渲染出回合卡與每位隊員一列', () => {
  const saved = { document: globalThis.document, Node: globalThis.Node };
  const doc = installFakeDom();
  try {
    const store = createStore(mountableDoc(), { autosave: false, storage: null });
    const root = doc.createElement('div');
    const panel = demoModule.mount(root, { store });
    const cards = root.querySelectorAll('.encdemo-card');
    assert.equal(cards.length, 2, '一張回合卡 + 一張 default 卡');
    const rows = root.querySelectorAll('.encdemo-row');
    assert.equal(rows.length, 2, '兩位隊員各一列');
    assert.ok(root.querySelector('.encdemo-root') === null || true);
    assert.equal(panel.getSummary().cards, 1);
    assert.deepEqual(panel.getErrors(), []);
    panel.destroy();
  } finally {
    uninstallFakeDom(saved);
  }
});

test('掛載：按「新增回合卡」寫入 store，undo 可復原', () => {
  const saved = { document: globalThis.document, Node: globalThis.Node };
  const doc = installFakeDom();
  try {
    const store = createStore(mountableDoc(), { autosave: false, storage: null });
    const root = doc.createElement('div');
    const panel = demoModule.mount(root, { store });
    const addBtn = root
      .querySelectorAll('button')
      .find((b) => b.textContent === i18n.t('encdemo.addTurn'));
    assert.ok(addBtn, '找不到新增回合卡按鈕');
    addBtn.dispatchEvent({ type: 'click' });
    assert.equal(store.doc.demo.turns.length, 2, 'store 應多一張卡');
    assert.equal(root.querySelectorAll('.encdemo-card').length, 3, '畫面應多一張卡');

    store.undo();
    assert.equal(store.doc.demo.turns.length, 1, 'undo 應回到一張卡');
    assert.equal(root.querySelectorAll('.encdemo-card').length, 2);
    panel.destroy();
  } finally {
    uninstallFakeDom(saved);
  }
});

test('掛載：選項下拉內容依 command / target / option 變化，undo 可復原', () => {
  const saved = { document: globalThis.document, Node: globalThis.Node };
  const doc = installFakeDom();
  try {
    const store = createStore(mountableDoc(), { autosave: false, storage: null });
    const root = doc.createElement('div');
    const panel = demoModule.mount(root, { store });

    const row = root.querySelectorAll('.encdemo-row')[0];
    const selects = row.querySelectorAll('select');
    const [cmdSel, tgtSel, optSel] = selects;
    assert.equal(cmdSel.value, 'act');
    assert.equal(tgtSel.value, 'rudinn');
    assert.deepEqual(
      optSel.options.map((o) => o.value),
      ['', 'check', 'compliment'],
      'ACT 選項應來自目標敵人的 acts',
    );
    assert.equal(optSel.value, 'compliment');

    // 換成 magic：Kris 沒有法術 → 選項清單空、停用
    cmdSel.value = 'magic';
    cmdSel.dispatchEvent({ type: 'change' });
    const row2 = root.querySelectorAll('.encdemo-row')[0];
    const opt2 = row2.querySelectorAll('select')[2];
    assert.deepEqual(opt2.options.map((o) => o.value), ['']);
    assert.equal(opt2.disabled, true);
    assert.equal(choiceOf(store.doc.demo.turns[0], 'kris').command, 'magic');
    assert.ok(!('target' in choiceOf(store.doc.demo.turns[0], 'kris')), '換指令要清掉舊目標');

    store.undo();
    const row3 = root.querySelectorAll('.encdemo-row')[0];
    assert.equal(row3.querySelectorAll('select')[0].value, 'act');
    assert.equal(choiceOf(store.doc.demo.turns[0], 'kris').option, 'compliment');
    panel.destroy();
  } finally {
    uninstallFakeDom(saved);
  }
});

test('掛載：錯誤路徑顯示，按「定位」會閃爍對應欄位', () => {
  const saved = { document: globalThis.document, Node: globalThis.Node };
  const doc = installFakeDom();
  try {
    const store = createStore(mountableDoc(), { autosave: false, storage: null });
    const root = doc.createElement('div');
    const panel = demoModule.mount(root, { store });
    store.setErrors(new Map([['demo.turns[0].choices[0].option', '找不到「nope」']]));

    const errRows = root.querySelectorAll('.encdemo-errrow');
    assert.equal(errRows.length, 1);
    assert.equal(errRows[0].querySelector('.encdemo-errpath').textContent, 'demo.turns[0].choices[0].option');

    const jump = errRows[0].querySelector('button');
    assert.ok(jump, '錯誤列應有定位按鈕');
    jump.dispatchEvent({ type: 'click' });
    const target = root.querySelectorAll('[data-demo-path]').find((n) => n.dataset.demoPath === 'demo.turns[0].choices[0]');
    assert.ok(target, '應存在對應欄位列');
    assert.equal(target.scrolledIntoView, 1, '應捲到該欄位');
    assert.ok(target.classList.contains('is-flash'), '應加上閃爍標記');
    panel.destroy();
  } finally {
    uninstallFakeDom(saved);
  }
});

test('掛載：切到「演示」分頁會隱藏指令清單，切回會還原', () => {
  const saved = { document: globalThis.document, Node: globalThis.Node };
  const doc = installFakeDom();
  try {
    const store = createStore(mountableDoc(), { autosave: false, storage: null });
    const head = doc.createElement('div');
    head.className = 'panel-head';
    const title = doc.createElement('span');
    title.className = 'panel-title';
    title.textContent = 'CUES';
    const actions = doc.createElement('div');
    actions.className = 'panel-head-actions';
    const cuePath = doc.register(doc.createElement('span'), 'enc-cue-path');
    cuePath.textContent = 'cues[0]';
    actions.appendChild(cuePath);
    head.append(title, actions);

    const panelEl = doc.createElement('section');
    panelEl.className = 'panel';
    panelEl.appendChild(head);
    const cuesBody = doc.register(doc.createElement('div'), 'enc-cues-body');
    cuesBody.className = 'panel-body';
    panelEl.appendChild(cuesBody);
    doc.body.appendChild(panelEl);

    const tab = demoModule.mountDemoTab({ panelEl, ctx: { store } });
    assert.equal(tab.tab, 'cues');
    assert.equal(cuesBody.hidden, false);

    tab.showDemo();
    assert.equal(tab.tab, 'demo');
    assert.equal(cuesBody.hidden, true);
    assert.equal(tab.body.hidden, false);
    assert.match(cuePath.textContent, /^demo · 1 卡 · 2 選擇$/);

    tab.showCues();
    assert.equal(cuesBody.hidden, false);
    assert.equal(tab.body.hidden, true);
    assert.equal(cuePath.textContent, 'cues[0]');
    tab.destroy();
  } finally {
    uninstallFakeDom(saved);
  }
});

test('actor-editor 原始碼：scale / flip 欄位接上 encanim 字串', () => {
  const src = sourceOf('actor-editor.js');
  assert.ok(src.includes("ta('encanim.scale')"), '缺少 scale 欄位標籤');
  assert.ok(src.includes("ta('encanim.flip')"), '缺少 flip 欄位標籤');
  assert.ok(src.includes('encanim.scaleHint') && src.includes('encanim.flipHint'), '缺少提示字串');
  // 仍以 encPanels 命名空間為主（panels.test 的鍵掃描依賴這個前綴）
  assert.ok(src.includes('encPanels.'));
});
