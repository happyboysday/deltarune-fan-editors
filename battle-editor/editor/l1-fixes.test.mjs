/**
 * editor/l1-fixes.test.mjs — L1 修復的純邏輯測試
 *
 * 執行：node --test editor/l1-fixes.test.mjs
 *
 * 只測純函式／不碰 DOM：
 *   - timelineKeyIntent ……… B14 Delete/Backspace 刪事件的判定（不要求焦點在時間軸內）
 *   - menuItemParts …………… B10 新增事件選單的名稱／id／說明都走 i18n
 *   - parseOpenQuery ………… B19 `?file=` / `?sample=` 參數解析
 *   - nextAutoplayMode ……… B13 P 鍵三態切換（沒有 demo 時 關⇄AI）
 *   - setDemoPointField ……… §4-7 demo 數值表格的增刪改
 *   - filterSprites custom … §4-13 素材面板「自訂」篩選
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { timelineKeyIntent, menuItemParts } from './timeline.js';
import { setLocale, getLocale, LOCALES } from './i18n.js';
import { parseOpenQuery } from './fileops.js';
import {
  attackHasDemo,
  nextAutoplayMode,
  clampDemoTime,
  setDemoPointField,
  DEMO_POINT_FIELDS,
} from './demo-path.js';
import { filterSprites, normalizeSpriteEntries, countCustomSprites } from './assets-panel.js';

/* ------------------------------------------------------------------ B14 */

const keyBase = {
  key: 'Delete',
  focused: false,
  editable: false,
  modalOpen: false,
  menuOpen: false,
  selectedCount: 1,
  ctrl: false,
  shift: false,
  alt: false,
};

test('B14：有選取事件時，即使焦點不在時間軸也刪除', () => {
  assert.equal(timelineKeyIntent({ ...keyBase }), 'delete');
  assert.equal(timelineKeyIntent({ ...keyBase, focused: false }), 'delete', '焦點在別處仍生效');
  assert.equal(timelineKeyIntent({ ...keyBase, key: 'Backspace' }), 'delete', 'Backspace 同樣生效');
});

test('B14：沒有選取時 Delete/Backspace 不做事', () => {
  assert.equal(timelineKeyIntent({ ...keyBase, selectedCount: 0 }), null);
  assert.equal(timelineKeyIntent({ ...keyBase, key: 'Backspace', selectedCount: 0 }), null);
});

test('B14：輸入框／下拉／modal／選單有焦點時不搶鍵', () => {
  assert.equal(timelineKeyIntent({ ...keyBase, editable: true }), null, '檢查器輸入框的 Backspace 不能被吃掉');
  assert.equal(timelineKeyIntent({ ...keyBase, modalOpen: true }), null);
  assert.equal(timelineKeyIntent({ ...keyBase, menuOpen: true }), null);
});

test('B14：其他按鍵不產生刪除意圖；Ctrl+D 只在時間軸內複製', () => {
  assert.equal(timelineKeyIntent({ ...keyBase, key: 'a' }), null);
  assert.equal(timelineKeyIntent({ ...keyBase, key: 'Escape' }), null);
  assert.equal(timelineKeyIntent({ ...keyBase, key: 'd', ctrl: true, focused: false }), null);
  assert.equal(timelineKeyIntent({ ...keyBase, key: 'd', ctrl: true, focused: false, selectedCount: 0 }), null);
  assert.equal(timelineKeyIntent({ ...keyBase, key: 'd', ctrl: true, focused: true, selectedCount: 1 }), 'duplicate');
});

/* ------------------------------------------------------------------ B10 */

test('B10：三語的選單名稱與說明都翻譯，不會中英混排', () => {
  const seen = new Map();
  try {
    for (const loc of LOCALES) {
      setLocale(loc.id);
      assert.equal(getLocale(), loc.id);
      const parts = menuItemParts('emitter');
      assert.equal(parts.id, 'emitter', 'id 只是技術識別字，不翻譯');
      assert.ok(parts.name.length > 0, loc.id);
      assert.ok(parts.desc.length > 0, loc.id);
      const cjk = /[\u4e00-\u9fff]/;
      if (loc.id === 'en') {
        assert.doesNotMatch(parts.name, cjk, 'en 名稱不應有中文');
        assert.doesNotMatch(parts.desc, cjk, 'en 說明不應有中文');
      } else {
        // 繁中／簡中：名稱與說明都是中文，說明不該以英文片語開頭（中英混排）
        assert.match(parts.name, cjk, loc.id);
        assert.match(parts.desc, cjk, loc.id);
        assert.doesNotMatch(parts.desc, /^[A-Za-z]/, `${loc.id} 說明不應以英文開頭`);
      }
      assert.ok(parts.title.includes(parts.name), `${loc.id} tooltip 應含名稱`);
      seen.set(loc.id, `${parts.name}|${parts.desc}`);
    }
  } finally {
    setLocale('zh-Hant');
  }
  // 三語確實不同（真的走了翻譯，而不是固定字串）
  assert.notEqual(seen.get('zh-Hant'), seen.get('en'));
  assert.notEqual(seen.get('zh-Hant'), seen.get('zh-Hans'));
});

test('B10：未知型別也能給出 id 與說明，不會拋錯', () => {
  const parts = menuItemParts('weird');
  assert.equal(parts.id, 'weird');
  assert.equal(typeof parts.name, 'string');
  assert.equal(typeof parts.desc, 'string');
});

/* ------------------------------------------------------------------ B19 */

test('B19：?file= 接受有無 attacks/ 前綴與 .json 後綴', () => {
  const cases = [
    '?file=spade-rain',
    '?file=spade-rain.json',
    '?file=attacks/spade-rain.json',
    '?file=attacks%2Fspade-rain.json',
    '?file=%2Fattacks%2Fspade-rain.json',
    '?file=./attacks/spade-rain',
    '?attack=attacks%2Fspade-rain.json',
    '?attack=spade-rain',
  ];
  for (const q of cases) {
    const got = parseOpenQuery(q);
    assert.ok(got, q);
    assert.equal(got.kind, 'file', q);
    assert.equal(got.name, 'spade-rain', q);
  }
});

test('B19：?sample= 解析成 sample 種類，file 優先於 sample', () => {
  assert.deepEqual(parseOpenQuery('?sample=ring-burst').name, 'ring-burst');
  assert.equal(parseOpenQuery('?sample=ring-burst').kind, 'sample');
  assert.equal(parseOpenQuery('?sample=samples%2Fring-burst.json').name, 'ring-burst');
  const both = parseOpenQuery('?sample=ring-burst&file=spade-rain');
  assert.equal(both.kind, 'file');
  assert.equal(both.name, 'spade-rain');
});

test('B19：沒有參數／空值 → null', () => {
  assert.equal(parseOpenQuery(''), null);
  assert.equal(parseOpenQuery('?'), null);
  assert.equal(parseOpenQuery('?file='), null);
  assert.equal(parseOpenQuery('?sample=&file='), null);
  assert.equal(parseOpenQuery(null), null);
  assert.equal(parseOpenQuery(undefined), null);
  assert.equal(parseOpenQuery('?other=1'), null);
});

/* ------------------------------------------------------------------ B13 */

test('B13：有 demo 時 P 鍵三態 關→腳本→AI→關', () => {
  const hasDemo = { demo: { mode: 'path', path: [{ t: 0, x: 10, y: 20 }] } };
  assert.equal(attackHasDemo(hasDemo), true);
  assert.equal(nextAutoplayMode('off', true), 'demo');
  assert.equal(nextAutoplayMode('demo', true), 'bot');
  assert.equal(nextAutoplayMode('bot', true), 'off');
});

test('B13：沒有 demo 時 P 鍵只在 關⇄AI 之間切換', () => {
  const noDemo = { format: 'dr-battle-attack/1', timeline: [] };
  assert.equal(attackHasDemo(noDemo), false);
  assert.equal(attackHasDemo(null), false);
  assert.equal(nextAutoplayMode('off', false), 'bot');
  assert.equal(nextAutoplayMode('bot', false), 'off');
  assert.equal(nextAutoplayMode('demo', false), 'off', '腳本模式沒東西可跑，直接關掉');
});

test('B13：只有 demo.inputs 或 bot 模式也算有 demo', () => {
  assert.equal(attackHasDemo({ demo: { inputs: 'R>30' } }), true);
  assert.equal(attackHasDemo({ demo: { mode: 'bot' } }), true);
  assert.equal(attackHasDemo({ demo: {} }), false);
});

/* ------------------------------------------------------------------ §4-7 demo 表格 */

const emptyDemo = () => ({ mode: 'path', path: [] });
const rows = [
  { t: 0, x: 10, y: 20 },
  { t: 1.5, x: 30, y: 40, slow: true },
  { t: 3, x: 50, y: 60, hold: 0.5 },
];

test('§4-7：DEMO_POINT_FIELDS 含表格欄位', () => {
  for (const k of ['t', 'x', 'y', 'slow', 'hold']) assert.ok(DEMO_POINT_FIELDS.includes(k), k);
});

test('§4-7：改 x / y 只動該點、四捨五入到小數第二位', () => {
  const next = setDemoPointField(rows, 1, 'x', 33.333);
  assert.equal(next.length, 3);
  assert.equal(next[1].x, 33.33);
  assert.equal(next[1].y, 40, '同點其他欄位不動');
  assert.equal(next[0].x, 10, '其他點不動');
  assert.equal(rows[1].x, 30, '原陣列不被改（可 undo）');
});

test('§4-7：改 t 會夾在鄰點之間，維持時間遞增', () => {
  assert.equal(setDemoPointField(rows, 1, 't', 99)[1].t, 3, '不能超過下一個點');
  assert.equal(setDemoPointField(rows, 1, 't', -5)[1].t, 0, '不能早於前一個點');
  assert.equal(setDemoPointField(rows, 1, 't', 0.5)[1].t, 0.5, '合法值原樣寫入');
  assert.equal(clampDemoTime(rows, 2, 0), 1.5);
  assert.equal(clampDemoTime(rows, 0, 5), 1.5);
});

test('§4-7：slow / hold 可以設定也可以清除', () => {
  assert.equal(setDemoPointField(rows, 0, 'slow', true)[0].slow, true);
  assert.equal(setDemoPointField(rows, 1, 'slow', false)[1].slow, undefined, 'false 時刪除欄位');
  assert.equal(setDemoPointField(rows, 0, 'hold', 0.5)[0].hold, 0.5);
  assert.equal(setDemoPointField(rows, 2, 'hold', null)[2].hold, undefined, 'null 清除 hold');
  assert.equal(setDemoPointField(rows, 0, 'hold', 0)[0].hold, undefined, '0 等同不用 hold');
});

test('§4-7：越界索引或非數字輸入不炸', () => {
  assert.deepEqual(setDemoPointField(rows, 9, 'x', 1), rows);
  assert.deepEqual(setDemoPointField(rows, -1, 'x', 1), rows);
  assert.deepEqual(setDemoPointField(rows, 1, 'x', null), rows, '清空 x 不可用 → 原樣回傳');
  assert.deepEqual(setDemoPointField(rows, 1, 't', 'abc'), rows);
  assert.deepEqual(setDemoPointField(null, 0, 'x', 1), []);
});

test('§4-7：表格刪點後其餘索引不位移錯亂', () => {
  const next = rows.filter((_p, i) => i !== 1);
  assert.equal(next.length, 2);
  assert.equal(next[1].t, 3);
  // 表格以 index 定址，拖曳 overlay 也用同一個 index，所以刪點後重新計算是正確的
  assert.equal(setDemoPointField(next, 1, 'y', 70)[1].y, 70);
  void emptyDemo;
});

/* ------------------------------------------------------------------ §4-13 自訂篩選 */

const spriteIndex = {
  spr_heart: { w: 8, h: 8, tags: ['soul'] },
  spr_spade: { w: 16, h: 16, tags: ['bullet'], custom: true },
  spr_bg: { w: 320, h: 240, tags: ['battlebg'] },
  spr_ui: { w: 32, h: 32, tags: ['ui'], custom: true },
};

test('§4-13：normalizeSpriteEntries 帶出 custom 旗標', () => {
  const entries = normalizeSpriteEntries(spriteIndex);
  const byName = new Map(entries.map((e) => [e.name, e]));
  assert.equal(byName.get('spr_spade').custom, true);
  assert.equal(byName.get('spr_ui').custom, true);
  assert.equal(byName.get('spr_heart').custom, false);
});

test('§4-13：custom 篩選只留 custom:true，且可與 tag/query 疊加', () => {
  const entries = normalizeSpriteEntries(spriteIndex);
  assert.equal(countCustomSprites(entries), 2);
  const custom = filterSprites(entries, { custom: true });
  assert.deepEqual(custom.map((e) => e.name).sort(), ['spr_spade', 'spr_ui']);
  assert.equal(filterSprites(entries, { custom: false }).length, 4, '關閉時不篩');
  assert.deepEqual(filterSprites(entries, { custom: true, tags: ['ui'] }).map((e) => e.name), ['spr_ui']);
  assert.deepEqual(filterSprites(entries, { custom: true, query: 'spade' }).map((e) => e.name), ['spr_spade']);
});

test('§4-13：沒有 custom 素材時數量為 0（chip 仍要顯示且可點）', () => {
  const plain = normalizeSpriteEntries({ spr_a: { w: 1, h: 1 }, spr_b: { w: 2, h: 2 } });
  assert.equal(countCustomSprites(plain), 0);
  assert.deepEqual(filterSprites(plain, { custom: true }), []);
});
