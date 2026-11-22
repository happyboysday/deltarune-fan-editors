/**
 * editor/encounter/app.test.mjs — ED1 檢查（Phase 2）
 *
 * 1. locales/encounter-app.js：三語（zh-Hant / zh-Hans / en）× 四命名空間
 *    （encapp / enctoolbar / encpreview / encfileops）鍵集合完全一致。
 * 2. encounter.html 用到的 data-i18n* 鍵都存在。
 * 3. editor/encounter/{main,preview,fileops}.js 裡所有 t('…') 鍵都存在。
 * 4. store 泛化：selection.path、cuePath 推導（setCuePath / select / defaultCuePathFor）、
 *    getAt/setAt/updateCue、errorsUnder。
 *
 * 執行：node --test editor/encounter/app.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import strings, { NAMESPACES } from '../locales/encounter-app.js';
import syncStrings from '../locales/live-sync.js';
import phase1Strings from '../locales/app.js';
import {
  createStore,
  defaultCuePathFor,
  normalizeSelection,
  getAtPath,
  setAtPath,
  splitPath,
} from '../store.js';
import { buildTree, selectNode } from './tree.js';

test('選取舊作品缺少的 beforeAttack 清單時保留編輯路徑', () => {
  const store = createStore({ turns: [{ id: 't1', start: [], end: [] }] });
  const node = buildTree(store.doc).byKey.get('cues:turns[0].beforeAttack');
  assert.equal(selectNode(store, node), true);
  assert.equal(store.cuePath, 'turns[0].beforeAttack');
  assert.equal(store.doc.turns[0].beforeAttack, undefined);
});

const LOCALES = ['zh-Hant', 'zh-Hans', 'en'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

/* ------------------------------------------------------------ 字串表本身 */

test('locales/encounter-app.js 有三個語系與四個命名空間', () => {
  assert.deepEqual(Object.keys(strings).sort(), [...LOCALES].sort());
  assert.deepEqual([...NAMESPACES].sort(), ['encapp', 'encfileops', 'encpreview', 'enctoolbar']);
  for (const loc of LOCALES) {
    for (const ns of NAMESPACES) {
      assert.ok(strings[loc] && strings[loc][ns], `${loc} 缺少命名空間 ${ns}`);
      assert.equal(typeof strings[loc][ns], 'object');
    }
  }
});

test('三語鍵集合完全一致（每個命名空間）', () => {
  for (const ns of NAMESPACES) {
    const base = Object.keys(strings['zh-Hant'][ns]).sort();
    assert.ok(base.length > 10, `${ns} 字串太少（${base.length}），可能漏寫`);
    for (const loc of LOCALES) {
      const keys = Object.keys(strings[loc][ns]).sort();
      const missing = base.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !base.includes(k));
      assert.deepEqual(missing, [], `${loc}.${ns} 缺少鍵：${missing.join('、')}`);
      assert.deepEqual(extra, [], `${loc}.${ns} 多了鍵：${extra.join('、')}`);
    }
  }
});

test('每個字串都是非空字串', () => {
  for (const loc of LOCALES) {
    for (const ns of NAMESPACES) {
      for (const [key, value] of Object.entries(strings[loc][ns])) {
        assert.equal(typeof value, 'string', `${loc}.${ns}.${key} 不是字串`);
        assert.ok(value.length > 0, `${loc}.${ns}.${key} 是空字串`);
      }
    }
  }
});

test('佔位符（{name} 之類）在三語之間一致', () => {
  const placeholders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',');
  for (const ns of NAMESPACES) {
    for (const key of Object.keys(strings['zh-Hant'][ns])) {
      const ref = placeholders(strings['zh-Hant'][ns][key]);
      if (!ref) continue;
      for (const loc of ['zh-Hans', 'en']) {
        assert.equal(
          placeholders(strings[loc][ns][key]),
          ref,
          `${loc}.${ns}.${key} 的佔位符與繁中不一致`,
        );
      }
    }
  }
});

test('英文語系不含中日韓字元', () => {
  const cjk = /[\u4e00-\u9fff]/;
  for (const ns of NAMESPACES) {
    for (const [key, value] of Object.entries(strings.en[ns])) {
      assert.equal(cjk.test(value), false, `en.${ns}.${key} 仍含中文字：${value}`);
    }
  }
});

test('簡中語系不使用繁體常用字（抽樣）', () => {
  const joined = Object.values(strings['zh-Hans'])
    .map((ns) => Object.values(ns).join('\n'))
    .join('\n');
  // 只挑「簡繁寫法不同」的字；「遭遇」等兩岸同形詞不算。
  for (const word of ['儲存', '復原', '預覽', '編輯器', '檢查', '檔案', '演員']) {
    assert.equal(joined.includes(word), false, `簡中不應出現「${word}」`);
  }
});

/* --------------------------------------------------- HTML / JS 的鍵都存在 */

function resolveKey(loc, key) {
  const dot = key.indexOf('.');
  if (dot < 0) return undefined;
  const ns = key.slice(0, dot);
  const rest = key.slice(dot + 1);
  // encounter 自己的字串表，其次共用表（sync / Phase 1 app）
  for (const table of [strings, syncStrings, phase1Strings]) {
    const loc_table = table[loc] || {};
    // 字串表可能是「扁平全鍵」格式（sync.*），也可能是「命名空間 → 短鍵」格式
    const flat = loc_table[key];
    if (typeof flat === 'string') return flat;
    const value = loc_table[ns] && typeof loc_table[ns][rest] === 'string' ? loc_table[ns][rest] : undefined;
    if (typeof value === 'string') return value;
  }
  return undefined;
}

test('encounter.html 用到的 data-i18n 鍵都存在（三語齊備）', () => {
  const html = readFileSync(path.join(ROOT, 'encounter.html'), 'utf8');
  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-title|-placeholder|-aria-label)?="([^"]+)"/g)) keys.add(m[1]);
  assert.ok(keys.size > 30, `encounter.html 的 data-i18n 鍵太少（${keys.size}）`);

  const missing = [];
  for (const key of keys) {
    for (const loc of LOCALES) {
      if (typeof resolveKey(loc, key) !== 'string') missing.push(`${loc}:${key}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], `encounter.html 用到但字串表缺少的鍵：${missing.join('、')}`);
});

test('editor/encounter 的 JS 檔案裡所有 t(…) 鍵都存在', () => {
  const files = ['main.js', 'preview.js', 'fileops.js'];
  const missing = [];
  const used = new Set();
  for (const file of files) {
    const src = readFileSync(path.join(HERE, file), 'utf8');
    for (const m of src.matchAll(/(?:^|[^\w$.])t\(\s*'([A-Za-z][A-Za-z0-9_.]*)'/g)) {
      const key = m[1];
      if (!key.includes('.')) continue;
      used.add(key);
      for (const loc of LOCALES) {
        if (typeof resolveKey(loc, key) !== 'string') missing.push(`${file} → ${loc}:${key}`);
      }
    }
  }
  assert.ok(used.size > 40, `t() 使用量太少（${used.size}），掃描可能失效`);
  assert.deepEqual([...new Set(missing)], [], `JS 用到但字串表缺少的鍵：${missing.join('、')}`);
});

/* --------------------------------------------------- store 泛化（cuePath） */

/** 測試用的最小遭遇（欄位齊備度不影響 store） */
function makeEncounter() {
  return {
    format: 'dr-battle-encounter/1',
    meta: { name: '測試遭遇', author: '' },
    settings: { seed: 1, bgm: null, background: 'bg', introText: '', canFlee: true },
    actors: { kris: { kind: 'party', x: 160, y: 240, anims: {} } },
    party: [
      {
        id: 'kris',
        actor: 'kris',
        name: 'Kris',
        hp: 90,
        maxHp: 90,
        commands: ['fight', 'act', 'item', 'spare'],
        spells: [{ id: 'heal1', name: '治療', tp: 20, target: 'ally', cues: [] }],
      },
    ],
    enemies: [
      {
        id: 'rudinn',
        actor: 'rudinn',
        name: 'Rudinn',
        hp: 100,
        maxHp: 100,
        acts: [{ id: 'check', name: '查看', text: '', cues: [{ cmd: 'say', text: 'hi' }] }],
      },
    ],
    items: [],
    turns: [
      { id: 't0', flavor: '第一回合', attack: null, talk: [], start: [], end: [] },
      { id: 't1', flavor: '第二回合', attack: null, talk: [], start: [{ cmd: 'wait', frames: 10 }], end: [] },
    ],
    turnOrder: 'loop-last',
    hooks: { intro: [], victory: [], spared: [], defeat: [], flee: [] },
    vars: {},
  };
}

function makeStore() {
  return createStore(makeEncounter(), { storage: null, autosave: false });
}

test('store 的 doc / attack 是同一份（Phase 1 相容）', () => {
  const store = makeStore();
  assert.equal(store.doc, store.attack);
  assert.equal(store.doc.format, 'dr-battle-encounter/1');
});

test('normalizeSelection 保留 path 與 meta', () => {
  // 字串一律視為 kind（Phase 1 風格 normalizeSelection('event')）
  assert.deepEqual(normalizeSelection('turn'), { kind: 'turn', id: null, path: null });
  assert.deepEqual(normalizeSelection('turns[1]'), { kind: 'turns[1]', id: null, path: null });
  const sel = normalizeSelection({ kind: 'enemy', id: 'rudinn', path: 'enemies[0]', meta: { x: 1 } });
  assert.equal(sel.path, 'enemies[0]');
  assert.equal(sel.kind, 'enemy');
  assert.deepEqual(sel.meta, { x: 1 });
  assert.equal(normalizeSelection(null).path, null);
  assert.equal(normalizeSelection({ path: 'turns[1]' }).path, 'turns[1]');
});

test('defaultCuePathFor：ACT／法術／回合各指向正確的 cues 陣列', () => {
  const doc = makeEncounter();
  // 敵人 ACT
  assert.equal(
    defaultCuePathFor(doc, { kind: 'act', id: 'check', path: 'enemies[0].acts[0]' }),
    'enemies[0].acts[0].cues',
  );
  // 隊伍法術
  assert.equal(
    defaultCuePathFor(doc, { kind: 'spell', id: 'heal1', path: 'party[0].spells[0]' }),
    'party[0].spells[0].cues',
  );
  // 回合 → start（沒有 start 就用 end）
  assert.equal(defaultCuePathFor(doc, { kind: 'turn', id: 't1', path: 'turns[1]' }), 'turns[1].start');
  // 明確指定優先
  assert.equal(
    defaultCuePathFor(doc, { kind: 'turn', id: 't1', path: 'turns[1]', meta: { cuesPath: 'turns[1].end' } }),
    'turns[1].end',
  );
  // path 本身就是陣列
  assert.equal(defaultCuePathFor(doc, { kind: 'hook', path: 'hooks.intro' }), 'hooks.intro');
  // 沒有 cues 概念 → null
  assert.equal(defaultCuePathFor(doc, { kind: 'settings', path: 'settings' }), null);
});

test('select() 會自動推導 cuePath，setCuePath 會通知訂閱者', () => {
  const store = makeStore();
  const events = [];
  // 訂閱回呼簽名是 (store, change)
  store.subscribe((_store, change) => events.push(change));

  store.select('turn', 't1', 'turns[1]');
  assert.equal(store.selection.path, 'turns[1]');
  assert.equal(store.cuePath, 'turns[1].start');

  store.setCuePath('turns[1].end');
  assert.equal(store.cuePath, 'turns[1].end');
  assert.ok(
    events.some((e) => e && e.label === 'cuePath' && e.cuePath === 'turns[1].end'),
    'setCuePath 應發出 label=cuePath 的通知',
  );

  // selectionOnly 的通知會帶 cuePath
  const selectionOnly = events.filter((e) => e && e.selectionOnly);
  assert.ok(selectionOnly.length >= 1, '選取變更應發出 selectionOnly 通知');
  assert.equal(selectionOnly[0].cuePath, 'turns[1].start');

  store.setSelection({ kind: 'enemy', id: 'rudinn', path: 'enemies[0]' });
  assert.equal(store.cuePath, null, '敵人本身沒有 cues 陣列');

  store.clearSelection();
  assert.equal(store.selection.path, null);
  assert.equal(store.cuePath, null);
});

test('getAt / setAt / updateCue 只動 cuePath 指向的陣列', () => {
  const store = makeStore();
  store.select('enemy', 'rudinn', 'enemies[0].acts[0]');
  assert.equal(store.cuePath, 'enemies[0].acts[0].cues');
  assert.deepEqual(getAtPath(store.doc, store.cuePath), [{ cmd: 'say', text: 'hi' }]);

  const before = JSON.stringify(store.doc);
  store.updateCue((cues) => {
    cues.push({ cmd: 'wait', frames: 5 });
    cues[0].text = 'hello';
    return cues;
  });
  const after = JSON.parse(JSON.stringify(store.doc));
  assert.deepEqual(after.enemies[0].acts[0].cues, [
    { cmd: 'say', text: 'hello' },
    { cmd: 'wait', frames: 5 },
  ]);
  // 其他部分沒被動到
  assert.equal(after.party[0].name, 'Kris');
  assert.notEqual(JSON.stringify(after), before);

  // setAt 走同一條 commit 路徑（可復原）
  store.setAt('vars.flag', true);
  assert.equal(store.getAt('vars.flag'), true);
  assert.equal(store.isDirty(), true);
  store.undo();
  assert.equal(store.getAt('vars.flag'), undefined);
});

test('errorsUnder / hasErrorUnder 依路徑前綴過濾', () => {
  const store = makeStore();
  const seq = store.nextErrorSeq();
  store.setErrors(
    new Map([
      ['enemies[0].acts[0].cues[0].actor', { path: 'enemies[0].acts[0].cues[0].actor', message: 'a' }],
      ['turns[0].start', { path: 'turns[0].start', message: 'b' }],
    ]),
    seq,
  );
  // errorsUnder 回傳 [[path, message], …]
  assert.equal(store.errorsUnder('enemies').length, 1);
  assert.equal(store.errorsUnder('enemies')[0][0], 'enemies[0].acts[0].cues[0].actor');
  assert.equal(store.hasErrorUnder('enemies[0]'), true);
  assert.equal(store.hasErrorUnder('party'), false);
  assert.equal(store.errorsUnder('turns[0]').length, 1);
  assert.equal(store.errorsUnder('').length, 2, '空前綴代表全部錯誤');
});

test('splitPath 支援索引與屬性混用', () => {
  assert.deepEqual(splitPath('enemies[0].acts[1].cues[2]'), ['enemies', 0, 'acts', 1, 'cues', 2]);
  assert.deepEqual(splitPath('settings'), ['settings']);
  assert.deepEqual(splitPath(''), []);
  const doc = { a: [{ b: [10, 20] }] };
  assert.equal(getAtPath(doc, 'a[0].b[1]'), 20);
  const copy = JSON.parse(JSON.stringify(doc));
  setAtPath(copy, 'a[0].b[1]', 99);
  assert.equal(copy.a[0].b[1], 99);
});

test('replace() 會清空 cuePath 並標記 reset', () => {
  const store = makeStore();
  store.select('turn', 't1', 'turns[1]');
  assert.ok(store.cuePath);
  const events = [];
  store.subscribe((_store, change) => events.push(change));
  store.replace(makeEncounter(), '載入測試');
  assert.equal(store.cuePath, null);
  const last = events[events.length - 1];
  assert.equal(last.reset, true);
  assert.deepEqual(last.paths, ['$']);
});

test('復原堆疊在遭遇文件上仍然有效（上限 200）', () => {
  const store = makeStore();
  for (let i = 0; i < 5; i += 1) {
    store.update((doc) => {
      doc.vars['n' + i] = i;
    });
  }
  assert.equal(store.historySize().undo, 5);
  store.undo();
  store.undo();
  assert.equal(store.getAt('vars.n4'), undefined, '第 2 次復原後 n4 應消失');
  assert.equal(store.getAt('vars.n3'), undefined, '第 2 次復原後 n3 應消失');
  assert.equal(store.getAt('vars.n2'), 2, 'n2 仍保留');
  store.redo();
  assert.equal(store.getAt('vars.n3'), 3, '重做應還原 n3');
});

test('復原上限是 200 步', () => {
  const store = makeStore();
  for (let i = 0; i < 205; i += 1) {
    store.update((doc) => {
      doc.vars.n = i;
    });
  }
  assert.equal(store.historySize().undo, 200);
});

/* ------------------------------------------------- 版面同步（SPEC-LAYOUT） */

test('預覽尺寸與站位常數都來自 engine/encounter/layout.js', async () => {
  const layout = await import('../../engine/encounter/layout.js');
  const preview = await import('./preview.js');
  assert.equal(preview.VIEW_W, layout.LAYOUT.VIEW_W);
  assert.equal(preview.VIEW_H, layout.LAYOUT.VIEW_H);

  // 隊員：共用中心與交錯偏移，腳底 y 依人數
  for (const count of [1, 2, 3, 4]) {
    const feet = layout.LAYOUT.partyFeetFor(count);
    assert.equal(feet.length, count, `partyFeetFor(${count}) 長度`);
    for (let i = 0; i < count; i += 1) {
      const spot = preview.partySpotFor(i, count);
      assert.equal(spot.y, feet[i], `第 ${i} 位隊員腳底 y 應等於 LAYOUT`);
      const offset = layout.LAYOUT.PARTY_STAGGER_X / 2 * (i % 2 === 0 ? -1 : 1);
      assert.equal(spot.x, layout.LAYOUT.PARTY_CENTER_X + offset);
    }
  }

  // 敵人：單隻＝LAYOUT 錨點；多隻上下錯開
  assert.deepEqual(preview.enemySpotFor(0, 1), {
    x: layout.LAYOUT.ENEMY_CENTER_X,
    y: layout.LAYOUT.ENEMY_FEET_Y,
  });
  const two = [preview.enemySpotFor(0, 2), preview.enemySpotFor(1, 2)];
  assert.ok(two[0].x < two[1].x, '多隻敵人 x 應交錯');
  assert.ok(two[0].y < two[1].y, '多隻敵人腳底 y 應上下錯開');
});

test('fallbackSpotFor：未設座標時退回 LAYOUT 站位（隊員縱列 / 敵人錨點）', async () => {
  const layout = await import('../../engine/encounter/layout.js');
  const preview = await import('./preview.js');
  const doc = {
    actors: {
      kris: { kind: 'party' },
      susie: { kind: 'party' },
      ralsei: { kind: 'party' },
      rudinn: { kind: 'enemy' },
    },
    party: [{ id: 'kris' }, { id: 'susie' }, { id: 'ralsei' }],
    enemies: [{ id: 'rudinn' }],
  };
  const feet = layout.LAYOUT.partyFeetFor(3);
  assert.equal(preview.fallbackSpotFor(doc, 'kris').y, feet[0]);
  assert.equal(preview.fallbackSpotFor(doc, 'susie').y, feet[1]);
  assert.equal(preview.fallbackSpotFor(doc, 'ralsei').y, feet[2]);
  const foe = preview.fallbackSpotFor(doc, 'rudinn');
  assert.equal(foe.kind, 'enemy');
  assert.equal(foe.x, layout.LAYOUT.ENEMY_CENTER_X);
  assert.equal(foe.y, layout.LAYOUT.ENEMY_FEET_Y);
  // 不在 actors 裡也有合理退回值（不拋錯）
  assert.equal(typeof preview.fallbackSpotFor(doc, 'ghost').x, 'number');
});

test('新遭遇範本：角色名為英文字串、站位取自 LAYOUT', async () => {
  const layout = await import('../../engine/encounter/layout.js');
  const preview = await import('./preview.js');
  const doc = preview.createDefaultEncounter(null);
  for (const member of doc.party) {
    assert.equal(typeof member.name, 'string', '隊員 name 應為字串（不是 {zh,en} 物件）');
  }
  for (const enemy of doc.enemies) {
    assert.equal(typeof enemy.name, 'string', '敵人 name 應為字串（不是 {zh,en} 物件）');
  }
  const heroActor = doc.actors[doc.party[0].actor];
  const foeActor = doc.actors[doc.enemies[0].actor];
  const heroSpot = preview.partySpotFor(0, 1);
  const foeSpot = preview.enemySpotFor(0, 1);
  assert.equal(heroActor.x, heroSpot.x);
  assert.equal(heroActor.y, heroSpot.y);
  assert.equal(foeActor.x, foeSpot.x);
  assert.equal(foeActor.y, foeSpot.y);
  assert.equal(foeActor.x, layout.LAYOUT.ENEMY_CENTER_X);
  assert.equal(foeActor.y, layout.LAYOUT.ENEMY_FEET_Y);
});
