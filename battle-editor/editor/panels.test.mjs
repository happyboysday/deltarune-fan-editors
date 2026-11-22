// editor/panels.test.mjs  (ED3)
//
// 純邏輯單元測試（不碰 DOM，node --test 或直接 node 執行）：
//   node editor/panels.test.mjs
//
// 覆蓋：
//   fields.js       路徑字串 ↔ 物件存取、表達式模式判定／語法檢查、錯誤查詢、
//                   bulletType 改名時 timeline 引用更新
//   assets-panel.js 素材條目正規化、tag 收集、篩選、虛擬捲動範圍
//   bullet-types.js 清單、新增／刪除、hitbox 正規化與拖曳換算
//   locales/panels.js 三語（zh-Hant / zh-Hans / en）鍵集合一致、模組用到的鍵都存在

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { setLocale, getLocale, LOCALES } from './i18n.js';
import PANELS, { findKeyMismatches, LOCALE_IDS, NAMESPACES } from './locales/panels.js';

import {
  parsePath,
  formatPath,
  getPath,
  setPath,
  deletePath,
  parentPath,
  elementPath,
  modeOf,
  toNumber,
  isExpr,
  checkExprSyntax,
  tryEvaluateExpr,
  clampSpec,
  roundNice,
  normalizeErrors,
  lookupError,
  lookupErrorPrefix,
  hasErrorUnder,
  fieldErrorKeys,
  findBulletTypeRefs,
  renameBulletTypeRefs,
  canRenameBulletType,
  applyBulletTypeRename,
  defaultSpawnValues,
  SPAWN_FIELDS,
  SPAWN_FIELD_BY_KEY,
  EVENT_SPECS,
  eventSpecOf,
  eventTypeLabel,
  EXPR_VARIABLES,
  EXPR_FUNCTIONS,
  normalizeHex,
  SECTION_STATE_KEY,
  loadSectionState,
  saveSectionState,
} from './fields.js';

import {
  KNOWN_TAGS,
  tagLabel,
  normalizeSpriteEntries,
  collectTags,
  filterSprites,
  gridMetrics,
  virtualRange,
  itemRange,
  spriteInfoLines,
} from './assets-panel.js';

import {
  bulletTypesOf,
  listBulletTypes,
  uniqueBulletTypeName,
  defaultBulletType,
  normalizeHitboxValue,
  circleRadiusFromPoint,
  rectSizeFromPoint,
  hitboxSummary,
  bulletTypeSubtitle,
  addBulletType,
  removeBulletType,
  renameBulletType,
} from './bullet-types.js';

/* ============================ 測試框架 ============================ */

let passed = 0;
const failures = [];
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

function eq(actual, expected, msg) {
  if (msg === undefined) assert.deepStrictEqual(actual, expected);
  else assert.deepStrictEqual(actual, expected, msg);
}
function ok(v, msg) {
  assert.ok(v, msg);
}
function throwsNone(fn, msg) {
  assert.doesNotThrow(fn, msg);
}

/* ============================ 測試語系 ============================ */

// node 環境沒有 localStorage，i18n 會依 navigator（en-US）判定為英文；
// 既有測試斷言的是繁中字串，因此先把語系固定成 zh-Hant。
const ORIGINAL_LOCALE = getLocale();
setLocale('zh-Hant');

/* ============================ fields：路徑 ============================ */

test('parsePath：基本與陣列索引', () => {
  eq(parsePath('timeline[3].spawn.angle'), ['timeline', 3, 'spawn', 'angle']);
  eq(parsePath('bulletTypes.spade.hitbox.r'), ['bulletTypes', 'spade', 'hitbox', 'r']);
  eq(parsePath('[0].type'), [0, 'type']);
  eq(parsePath('a["b-c"].d'), ['a', 'b-c', 'd']);
  eq(parsePath('  a . b '), ['a', 'b']);
});

test('parsePath：非法輸入回傳空陣列', () => {
  eq(parsePath(''), []);
  eq(parsePath('a[b]'), []);          // 非數字且非引號的索引
  eq(parsePath('a[0'), []);           // 未閉合
  eq(parsePath(123), []);
  eq(parsePath(null), []);
  eq(parsePath('a..b'), ['a', 'b']);  // 連續點容忍
});

test('formatPath：token 轉回字串', () => {
  eq(formatPath(['timeline', 3, 'spawn', 'angle']), 'timeline[3].spawn.angle');
  eq(formatPath(['a', 'b-c']), 'a["b-c"]');
  eq(formatPath([]), '');
  eq(formatPath(['x']), 'x');
});

test('parsePath / formatPath 互轉（round-trip）', () => {
  const cases = [
    'timeline[0].spawn.angle',
    'bulletTypes.spade.hitbox.r',
    'party[0].name',
    'meta.name',
  ];
  for (const c of cases) eq(formatPath(parsePath(c)), c);
});

test('getPath：深層讀取與缺失', () => {
  const obj = { timeline: [{ id: 'a', spawn: { angle: 45 } }], meta: { name: 'x' } };
  eq(getPath(obj, 'timeline[0].spawn.angle'), 45);
  eq(getPath(obj, 'meta.name'), 'x');
  eq(getPath(obj, 'timeline[5].spawn.angle'), undefined);
  eq(getPath(obj, 'meta.missing.deep'), undefined);
  eq(getPath(null, 'a.b'), undefined);
});

test('setPath：建立中間層並寫入', () => {
  const obj = {};
  ok(setPath(obj, 'timeline[2].spawn.angle', 90));
  eq(obj.timeline.length, 3);
  eq(obj.timeline[2].spawn.angle, 90);
  // 覆寫
  setPath(obj, 'timeline[2].spawn.angle', 180);
  eq(obj.timeline[2].spawn.angle, 180);
  // 陣列自動建立
  const o2 = {};
  setPath(o2, 'party[0].name', 'Kris');
  ok(Array.isArray(o2.party));
  eq(o2.party[0].name, 'Kris');
});

test('setPath：非法參數回傳 false', () => {
  eq(setPath(null, 'a', 1), false);
  eq(setPath({}, '', 1), false);
});

test('deletePath：刪屬性與陣列元素', () => {
  const obj = { a: { b: 1, c: 2 }, list: [1, 2, 3] };
  eq(deletePath(obj, 'a.b'), true);
  eq(obj.a.b, undefined);
  eq(deletePath(obj, 'a.zzz'), false);
  eq(deletePath(obj, 'list[1]'), true);
  eq(obj.list, [1, 3]);
});

test('parentPath / elementPath', () => {
  eq(parentPath('a.b.c'), 'a.b');
  eq(parentPath('a'), '');
  eq(parentPath('timeline[3].spawn.angle'), 'timeline[3].spawn');
  eq(elementPath('timeline', 3), 'timeline[3]');
  eq(elementPath('party', 0), 'party[0]');
});

/* ============================ fields：值模式 ============================ */

test('modeOf：數字 / 表達式判定', () => {
  eq(modeOf(3), 'number');
  eq(modeOf(3.5), 'number');
  eq(modeOf(null), 'number');
  eq(modeOf(undefined), 'number');
  eq(modeOf(''), 'number');
  eq(modeOf('  '), 'number');
  eq(modeOf('42'), 'number');       // 純數字字串 → 數字模式
  eq(modeOf('-1.5e3'), 'number');
  eq(modeOf('sin(t)'), 'expr');
  eq(modeOf('rand(-30,30)'), 'expr');
  eq(modeOf('3+0'), 'expr');
});

test('isExpr / toNumber', () => {
  eq(isExpr('abc'), true);
  eq(isExpr(''), false);
  eq(isExpr(5), false);
  eq(toNumber('3.5'), 3.5);
  eq(toNumber(7), 7);
  eq(toNumber('x', 9), 9);
  eq(toNumber(null, 0), 0);
});

test('checkExprSyntax：合法與非法', () => {
  eq(checkExprSyntax('sin(t) + 3'), null);
  eq(checkExprSyntax('rand(-30, 30) * cos(t * 2)'), null);
  eq(checkExprSyntax('lerp(0, box.w, 0.5)'), null);
  eq(checkExprSyntax('aim(soul.x, soul.y)'), null);
  eq(checkExprSyntax("'(' + ')'"), null); // 字串內的括號不算
  eq(checkExprSyntax(''), '表達式為空');
  eq(checkExprSyntax('sin(t'), '括號未閉合');
  eq(checkExprSyntax('sin(t))'), '括號不對稱：)');
  eq(checkExprSyntax('"abc'), '字串引號未閉合');
  ok(checkExprSyntax('sin(角度)').includes('中文'));
  eq(checkExprSyntax(5), '必須是字串');
});

test('tryEvaluateExpr：編輯器端試算', () => {
  const r = tryEvaluateExpr('1 + 2');
  eq(r.ok, true);
  eq(r.value, 3);
  eq(tryEvaluateExpr('sqrt(16)').value, 4);
  eq(tryEvaluateExpr('floor(3.7)').value, 3);
  eq(tryEvaluateExpr('min(2,5) + max(1,2)').value, 4);
  // 度為單位的三角函式
  eq(roundNice(tryEvaluateExpr('sin(90)').value, 3), 1);
  eq(roundNice(tryEvaluateExpr('cos(0)').value, 3), 1);
  eq(tryEvaluateExpr('lerp(0, 10, 0.25)').value, 2.5);
  // 假 scope 用 engine/attack.js 的 BOX_DEFAULTS（中心 320,190、內部 144×158）
  eq(tryEvaluateExpr('box.w').value, 144);
  eq(tryEvaluateExpr('box.h').value, 158);
  eq(tryEvaluateExpr('box.left').value, 248);
  eq(tryEvaluateExpr('soul.x').value, 320);
  eq(tryEvaluateExpr('soul.y').value, 190);
  eq(tryEvaluateExpr('PI > 3').value, 0); // 布林 → 非有限數字
  eq(tryEvaluateExpr('nope(1)').ok, false);
  eq(tryEvaluateExpr('sin(t').ok, false);
});

test('clampSpec / roundNice', () => {
  eq(clampSpec(5, { min: 0, max: 3 }), 3);
  eq(clampSpec(-5, { min: 0 }), 0);
  eq(clampSpec(5, {}), 5);
  eq(roundNice(0.1 + 0.2), 0.3);
  eq(roundNice(-0.0000001), 0);
  eq(Object.is(roundNice(-0), 0), true);
});

test('normalizeHex', () => {
  eq(normalizeHex('#00c000'), '#00c000');
  eq(normalizeHex('00C000'), '#00c000');
  eq(normalizeHex('0x00c000'), '#00c000');
  eq(normalizeHex('#fff'), '#ffffff');
  eq(normalizeHex('nope'), null);
  eq(normalizeHex(null), null);
});

/* ============================ fields：錯誤查詢 ============================ */

test('normalizeErrors：Map 與 plain object', () => {
  const m = new Map([['a', 'x']]);
  eq(normalizeErrors(m), m);
  const o = normalizeErrors({ a: 'x' });
  eq(o.get('a'), 'x');
  eq(normalizeErrors(null).size, 0);
});

test('lookupError：完整路徑與事件 id 變體', () => {
  const errs = new Map([
    ['timeline[3].spawn.angle', '角度不是數字'],
    ['evt-abc.speed', '速度錯誤'],
  ]);
  eq(lookupError(errs, 'timeline[3].spawn.angle').hasError, true);
  eq(lookupError(errs, 'timeline[3].spawn.angle').message, '角度不是數字');
  eq(lookupError(errs, 'timeline[2].spawn.angle').hasError, false);
  eq(lookupError(errs, ['timeline[1].x', 'timeline[3].spawn.angle']).hasError, true);
  // 事件 id 變體
  const keys = fieldErrorKeys('timeline[3]', 'evt-abc', 'speed');
  ok(keys.includes('timeline[3].speed'));
  ok(keys.includes('evt-abc.speed'));
  eq(lookupError(errs, keys).hasError, true);
});

test('lookupErrorPrefix：父層標紅', () => {
  const errs = new Map([
    ['timeline[3].spawn.angle', '角度不是數字'],
    ['bulletTypes.spade.sprite', '缺素材'],
  ]);
  eq(lookupErrorPrefix(errs, 'timeline[3]').hasError, true);
  eq(lookupErrorPrefix(errs, 'timeline[4]').hasError, false);
  eq(lookupErrorPrefix(errs, 'bulletTypes.spade').hasError, true);
  eq(lookupErrorPrefix(errs, 'bulletTypes.heart').hasError, false);
  eq(hasErrorUnder(errs, 'timeline'), true);
  eq(lookupErrorPrefix(errs, '').hasError, false);
});

/* ============================ fields：生成欄位表 ============================ */

test('SPAWN_FIELDS 符合 SPEC §5 清單', () => {
  const expected = ['x', 'y', 'speed', 'angle', 'accel', 'angularVel', 'scale', 'rotation', 'life', 'alpha', 'pathX', 'pathY'];
  eq(SPAWN_FIELDS.map((f) => f.key), expected);
  // pathX / pathY 只能是表達式
  eq(SPAWN_FIELD_BY_KEY.pathX.exprOnly, true);
  eq(SPAWN_FIELD_BY_KEY.pathY.exprOnly, true);
  // life 可為 null
  eq(SPAWN_FIELD_BY_KEY.life.nullable, true);
  // guard：每個欄位都要有 label
  for (const f of SPAWN_FIELDS) ok(typeof f.label === 'string' && f.label.length > 0, f.key);
});

test('defaultSpawnValues：null 欄位保持 null', () => {
  const d = defaultSpawnValues();
  eq(d.x, 320);
  eq(d.speed, 3);
  eq(d.life, null);
  eq(d.pathX, null);
});

test('EVENT_SPECS 覆蓋 SPEC §4 全部型別', () => {
  for (const t of ['spawn', 'emitter', 'box', 'soul', 'clear', 'shake', 'sfx', 'anim', 'end']) {
    ok(eventSpecOf(t), t);
    ok(typeof eventTypeLabel(t) === 'string');
  }
  eq(eventSpecOf('nope'), null);
  // spawn / emitter 都有生成欄位區塊
  eq(EVENT_SPECS.spawn.sections[0].kind, 'spawn');
  eq(EVENT_SPECS.emitter.sections[0].kind, 'spawn');
  eq(EVENT_SPECS.emitter.sections[0].prefix, 'spawn');
  eq(EVENT_SPECS.box.sections[0].kind, 'boxTo');
  // box 有 ease 且選項符合 SPEC
  const ease = EVENT_SPECS.box.fields.find((f) => f.key === 'ease');
  eq(ease.options, ['linear', 'quadIn', 'quadOut', 'quadInOut', 'sineInOut', 'backOut']);
  // end 沒有欄位
  eq(EVENT_SPECS.end.fields, []);
});

test('表達式說明表涵蓋 SPEC §5 的變數與函式', () => {
  const varText = EXPR_VARIABLES.map((v) => v.name).join(' ');
  for (const t of ['t', 'T', 'i', 'n', 'k', 'age', 'box.', 'soul.']) ok(varText.includes(t), t);
  const fnText = EXPR_FUNCTIONS.map((f) => f.name).join(' ');
  for (const f of ['sin', 'cos', 'tan', 'atan2', 'sqrt', 'abs', 'min', 'max', 'floor', 'ceil', 'round', 'PI', 'rand', 'pick', 'aim', 'lerp']) {
    ok(fnText.includes(f), f);
  }
});

/* ============================ fields：bulletType 改名引用 ============================ */

function sampleAttack() {
  return {
    format: 'dr-battle-attack/1',
    bulletTypes: {
      spade: { sprite: 'spr_spade', hitbox: { shape: 'circle', r: 6 } },
      heart: { sprite: 'spr_heart', hitbox: { shape: 'rect', w: 8, h: 8 } },
    },
    timeline: [
      { id: 'e1', at: 0.5, type: 'spawn', bullet: 'spade' },
      { id: 'e2', at: 1.0, type: 'emitter', duration: 2, interval: 0.1, count: 1, spawn: { bullet: 'spade', angle: 0 } },
      { id: 'e3', at: 2.0, type: 'spawn', bullet: 'heart' },
      { id: 'e4', at: 3.0, type: 'box', duration: 1, to: { w: 200 } },
    ],
  };
}

test('findBulletTypeRefs：spawn 與 emitter.spawn', () => {
  const a = sampleAttack();
  const refs = findBulletTypeRefs(a, 'spade');
  eq(refs.length, 2);
  eq(refs[0].path, 'timeline[0].bullet');
  eq(refs[0].kind, 'spawn');
  eq(refs[0].eventId, 'e1');
  eq(refs[1].path, 'timeline[1].spawn.bullet');
  eq(refs[1].kind, 'emitter');
  eq(refs[1].eventId, 'e2');
  // heart 只有 1 處
  eq(findBulletTypeRefs(a, 'heart').length, 1);
  // 不存在
  eq(findBulletTypeRefs(a, 'nope').length, 0);
  // attack 為 null
  eq(findBulletTypeRefs(null, 'x').length, 0);
});

test('renameBulletTypeRefs：更新所有引用', () => {
  const a = sampleAttack();
  const n = renameBulletTypeRefs(a, 'spade', 'spade2');
  eq(n, 2);
  eq(a.timeline[0].bullet, 'spade2');
  eq(a.timeline[1].spawn.bullet, 'spade2');
  eq(a.timeline[2].bullet, 'heart'); // 不受影響
});

test('canRenameBulletType：各種拒絕理由', () => {
  const a = sampleAttack();
  eq(canRenameBulletType(a, 'spade', 'spade2').ok, true);
  eq(canRenameBulletType(a, 'spade', '').ok, false);
  eq(canRenameBulletType(a, 'spade', '   ').ok, false);
  eq(canRenameBulletType(a, 'spade', 'spade').ok, false);
  eq(canRenameBulletType(a, 'spade', 'heart').reason, '名稱「heart」已存在');
  eq(canRenameBulletType(a, 'missing', 'x').ok, false);
});

test('applyBulletTypeRename：搬移鍵並保留順序', () => {
  const draft = sampleAttack();
  const r = applyBulletTypeRename(draft, 'spade', 'club');
  eq(r.ok, true);
  eq(r.renamedRefs, 2);
  eq(Object.keys(draft.bulletTypes), ['club', 'heart']); // 原本順序
  eq(draft.bulletTypes.club.hitbox.r, 6);
  eq(draft.timeline[0].bullet, 'club');
  // 失敗時不改
  const draft2 = sampleAttack();
  const r2 = applyBulletTypeRename(draft2, 'spade', 'heart');
  eq(r2.ok, false);
  eq(Object.keys(draft2.bulletTypes), ['spade', 'heart']);
});

/* ============================ assets-panel ============================ */

function sampleSprites() {
  return {
    spr_heart: { frames: ['sprites/spr_heart/0.png'], w: 16, h: 16, ox: 8, oy: 8, chapter: 'ch1', tags: ['soul'] },
    spr_spade: { frames: ['sprites/spr_spade/0.png', 'sprites/spr_spade/1.png'], w: 8, h: 8, ox: 0, oy: 0, tags: ['bullet'] },
    spr_bg: { frames: ['sprites/spr_bg/0.png'], w: 640, h: 480, tags: ['battlebg'] },
    spr_ui: { frames: [], w: 0, h: 0, tags: ['ui'] },
  };
}

test('KNOWN_TAGS 符合 SPEC §2', () => {
  eq(KNOWN_TAGS, ['soul', 'bullet', 'battlebg', 'enemy', 'ui', 'party']);
});

test('normalizeSpriteEntries：欄位與衍生值', () => {
  const entries = normalizeSpriteEntries(sampleSprites());
  eq(entries.length, 4);
  const heart = entries.find((e) => e.name === 'spr_heart');
  eq(heart.count, 1);
  eq(heart.w, 16);
  eq(heart.ox, 8);
  eq(heart.tags, ['soul']);
  eq(heart.chapter, 'ch1');
  const spade = entries.find((e) => e.name === 'spr_spade');
  eq(spade.count, 2);
  const ui = entries.find((e) => e.name === 'spr_ui');
  eq(ui.count, 0);
  eq(normalizeSpriteEntries(null), []);
  eq(normalizeSpriteEntries([]), []); // 陣列不是物件
});

test('normalizeSpriteEntries：空 meta 不炸', () => {
  const entries = normalizeSpriteEntries({ a: null, b: {}, c: 5 });
  eq(entries.length, 3);
  for (const e of entries) {
    eq(e.tags, []);
    eq(e.count, 0);
  }
});

test('collectTags：依 KNOWN_TAGS 排序並計數', () => {
  const entries = normalizeSpriteEntries(sampleSprites());
  const tags = collectTags(entries);
  eq(tags.map((t) => t.tag), ['soul', 'bullet', 'battlebg', 'ui']);
  eq(tags.find((t) => t.tag === 'soul').count, 1);
});

test('collectTags：未知 tag 排已知之後', () => {
  const entries = normalizeSpriteEntries({ a: { tags: ['zzz', 'soul', 'aaa'] } });
  eq(collectTags(entries).map((t) => t.tag), ['soul', 'aaa', 'zzz']);
});

test('filterSprites：名稱搜尋（不分大小寫）', () => {
  const entries = normalizeSpriteEntries(sampleSprites());
  eq(filterSprites(entries, { query: 'heart' }).map((e) => e.name), ['spr_heart']);
  eq(filterSprites(entries, { query: 'SPR_' }).length, 4);
  eq(filterSprites(entries, { query: 'nope' }).length, 0);
});

test('filterSprites：tag any / all', () => {
  const entries = normalizeSpriteEntries(sampleSprites());
  eq(filterSprites(entries, { tags: ['soul'] }).map((e) => e.name), ['spr_heart']);
  eq(filterSprites(entries, { tags: ['bullet', 'battlebg'] }).length, 2); // any
  eq(filterSprites(entries, { tags: ['bullet', 'battlebg'], tagMode: 'all' }).length, 0); // all
  // 複合：query + tag
  eq(filterSprites(entries, { query: 'sp', tags: ['bullet'] }).map((e) => e.name), ['spr_spade']);
  // 無條件 → 全部
  eq(filterSprites(entries, {}).length, 4);
});

test('gridMetrics：欄數計算', () => {
  const m = gridMetrics(320, { tile: 64, gap: 6, pad: 8 });
  eq(m.tile, 64);
  eq(m.cols, Math.max(1, Math.floor((320 - 16 + 6) / 70)));
  ok(m.cols >= 1);
  // 極窄也至少 1 欄
  eq(gridMetrics(10, { tile: 64, gap: 6, pad: 8 }).cols, 1);
  eq(gridMetrics(0, {}).cols, 1);
});

test('virtualRange：可見列範圍', () => {
  // rowH=84, viewport=300 → 可見 4.x 列；overscan 2
  const vr = virtualRange(0, 300, 84, 100, 2);
  eq(vr.startRow, 0);
  ok(vr.endRow >= 5);
  eq(vr.offsetY, 0);
  // 捲到第 10 列
  const vr2 = virtualRange(840, 300, 84, 100, 2);
  eq(vr2.startRow, 8);
  eq(vr2.offsetY, 8 * 84);
  // 捲到底：endRow 不超過 rowCount
  const vr3 = virtualRange(1e9, 300, 84, 100, 2);
  eq(vr3.endRow, 100);
});

test('itemRange：列 → index', () => {
  eq(itemRange(0, 3, 4, 100), { from: 0, to: 12 });
  eq(itemRange(2, 3, 4, 100), { from: 8, to: 12 });
  // 超過總數時夾住
  eq(itemRange(0, 10, 4, 7), { from: 0, to: 7 });
});

test('spriteInfoLines：尺寸／原點／幀數（key 穩定、label 依語系）', () => {
  const entries = normalizeSpriteEntries(sampleSprites());
  const heart = entries.find((e) => e.name === 'spr_heart');
  const lines = spriteInfoLines(heart);
  const byKey = Object.fromEntries(lines.map((l) => [l.key, l]));
  eq(byKey.size.value, '16 × 16');
  eq(byKey.origin.value, '(8, 8)');
  eq(byKey.frames.value, '1');
  eq(byKey.chapter.value, 'ch1');
  eq(byKey.name.label, '名稱');            // zh-Hant
  eq(byKey.size.label, '尺寸');
  eq(spriteInfoLines(null), []);
  // 未知欄位不產生章節列
  const noChapter = normalizeSpriteEntries({ a: { w: 1, h: 1 } })[0];
  eq(spriteInfoLines(noChapter).some((l) => l.key === 'chapter'), false);
  // 無 tag → 顯示「（無）」
  eq(spriteInfoLines(noChapter).find((l) => l.key === 'tags').value, '（無）');
});

/* ============================ bullet-types ============================ */

test('bulletTypesOf / listBulletTypes', () => {
  const a = sampleAttack();
  eq(Object.keys(bulletTypesOf(a)), ['spade', 'heart']);
  eq(bulletTypesOf(null), {});
  eq(bulletTypesOf({ bulletTypes: [] }), {});
  const list = listBulletTypes(a);
  eq(list.map((x) => x.name), ['spade', 'heart']);
  eq(list[0].refs, 2);
  eq(list[1].refs, 1);
});

test('uniqueBulletTypeName：遞增編號', () => {
  const a = sampleAttack();
  eq(uniqueBulletTypeName(a, 'new'), 'new');
  eq(uniqueBulletTypeName(a, 'spade'), 'spade2');
  a.bulletTypes.spade2 = defaultBulletType();
  eq(uniqueBulletTypeName(a, 'spade'), 'spade3');
});

test('defaultBulletType 符合 SPEC §3 預設', () => {
  const d = defaultBulletType('spr_x');
  eq(d.sprite, 'spr_x');
  eq(d.frameRate, 0);
  eq(d.scale, 1);
  eq(d.color, null);
  eq(d.hitbox, { shape: 'circle', r: 6 });
  eq(d.damage, null);
  eq(d.grazeable, true);
  eq(d.destroyOnHit, true);
  eq(d.faceVelocity, true);
  eq(d.offscreen, 'destroy');
  eq(d.maskToBox, false);
});

test('addBulletType：新增與自動改名', () => {
  const draft = sampleAttack();
  const n1 = addBulletType(draft, { name: 'club' });
  eq(n1, 'club');
  ok(draft.bulletTypes.club);
  eq(draft.bulletTypes.club.hitbox.r, 6);
  // 同名 → 自動編號
  const n2 = addBulletType(draft, { name: 'club' });
  eq(n2, 'club2');
  eq(Object.keys(draft.bulletTypes), ['spade', 'heart', 'club', 'club2']);
  // 空 draft
  const empty = {};
  const n3 = addBulletType(empty, { name: 'x' });
  eq(n3, 'x');
  eq(addBulletType(null, {}), null);
});

test('removeBulletType：有引用仍可刪，回報引用數', () => {
  const draft = sampleAttack();
  const r = removeBulletType(draft, 'spade');
  eq(r.ok, true);
  eq(r.refs, 2);
  eq(draft.bulletTypes.spade, undefined);
  // 不存在的
  const r2 = removeBulletType(draft, 'spade');
  eq(r2.ok, false);
});

test('renameBulletType 包裝', () => {
  const draft = sampleAttack();
  const r = renameBulletType(draft, 'heart', 'heart2');
  eq(r.ok, true);
  eq(r.renamedRefs, 1);
  eq(draft.timeline[2].bullet, 'heart2');
  eq(draft.bulletTypes.heart, undefined);
  eq(draft.bulletTypes.heart2.sprite, 'spr_heart');
});

test('normalizeHitboxValue', () => {
  eq(normalizeHitboxValue({ shape: 'circle', r: 10 }), { shape: 'circle', r: 10 });
  eq(normalizeHitboxValue({ shape: 'rect', w: 12, h: 6 }), { shape: 'rect', w: 12, h: 6 });
  eq(normalizeHitboxValue({}), { shape: 'circle', r: 6 });
  eq(normalizeHitboxValue(null), { shape: 'circle', r: 6 });
  eq(normalizeHitboxValue({ shape: 'circle', r: '7' }), { shape: 'circle', r: 7 });
  eq(normalizeHitboxValue({ shape: 'circle', r: 'x' }), { shape: 'circle', r: 6 });
  eq(normalizeHitboxValue({ shape: 'circle', r: null }), { shape: 'circle', r: 6 });
  eq(normalizeHitboxValue({ shape: 'circle', r: '' }), { shape: 'circle', r: 6 });
  eq(normalizeHitboxValue({ shape: 'circle', r: 0 }), { shape: 'circle', r: 0 });
});

test('拖曳換算：圓形半徑 / 矩形尺寸', () => {
  eq(circleRadiusFromPoint(3, 4), 5);
  eq(circleRadiusFromPoint(0, 0), 0);
  eq(circleRadiusFromPoint(-3, -4), 5);
  // 矩形是全寬 / 全高（點到中心距離 ×2）
  eq(rectSizeFromPoint(4, 3), { w: 8, h: 6 });
  eq(rectSizeFromPoint(-4, -3), { w: 8, h: 6 });
  eq(rectSizeFromPoint(0, 0), { w: 0, h: 0 });
});

test('hitboxSummary / bulletTypeSubtitle', () => {
  eq(hitboxSummary({ hitbox: { shape: 'circle', r: 6 } }), 'circle r=6');
  eq(hitboxSummary({ hitbox: { shape: 'rect', w: 8, h: 4 } }), 'rect 8×4');
  eq(hitboxSummary(null), 'circle r=6');
  const sub = bulletTypeSubtitle({ sprite: 'spr_x', damage: 5, hitbox: { shape: 'circle', r: 3 } });
  ok(sub.includes('spr_x'));
  ok(sub.includes('r=3'));
  ok(sub.includes('5 傷害'));
  ok(bulletTypeSubtitle({}).includes('預設傷害'));
});

/* ============================ i18n：三語字串表 ============================ */

test('locales/panels.js：四個命名空間都存在且為三語', () => {
  eq(NAMESPACES, ['inspector', 'assets', 'bulletTypes', 'fields']);
  eq(LOCALE_IDS, ['zh-Hant', 'zh-Hans', 'en']);
  for (const ns of NAMESPACES) {
    ok(PANELS[ns], `缺少命名空間 ${ns}`);
    for (const loc of LOCALE_IDS) {
      ok(PANELS[ns][loc] && typeof PANELS[ns][loc] === 'object', `${ns}/${loc} 不是物件`);
    }
  }
});

test('locales/panels.js：三語鍵集合完全一致（且沒有空字串）', () => {
  const problems = findKeyMismatches();
  eq(problems, []);
});

test('locales/panels.js：每個命名空間都有足夠的鍵（避免空表）', () => {
  const min = { inspector: 60, assets: 30, bulletTypes: 35, fields: 60 };
  for (const ns of NAMESPACES) {
    const n = Object.keys(PANELS[ns]['zh-Hant']).length;
    ok(n >= min[ns], `${ns} 只有 ${n} 個鍵（預期 ≥ ${min[ns]}）`);
  }
});

test('locales/panels.js：英文表不含中日韓字元（技術名詞除外）', () => {
  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f]/;
  const bad = [];
  for (const ns of NAMESPACES) {
    for (const [k, v] of Object.entries(PANELS[ns].en)) {
      // 允許的例外：沒有任何英文純技術字串需要中文
      if (CJK.test(v)) bad.push(`${ns}.${k} = ${v}`);
    }
  }
  eq(bad, []);
});

test('locales/panels.js：繁中與簡中確實不同（不是複製貼上）', () => {
  let diff = 0;
  let total = 0;
  for (const ns of NAMESPACES) {
    for (const k of Object.keys(PANELS[ns]['zh-Hant'])) {
      total += 1;
      if (PANELS[ns]['zh-Hant'][k] !== PANELS[ns]['zh-Hans'][k]) diff += 1;
    }
  }
  // 少數詞（如「名字」「速度」）兩地相同是正常的；但整體必須有明顯差異
  ok(diff > 20, `繁中／簡中只有 ${diff}/${total} 個鍵不同，疑似未實際轉換`);
});

test('模組用到的每個 t() 鍵都存在於字串表（防漂移）', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const files = [
    ['fields.js', ['fields']],
    ['inspector.js', ['inspector', 'fields']],
    ['assets-panel.js', ['assets']],
    ['bullet-types.js', ['bulletTypes', 'fields']],
  ];
  const missing = [];
  for (const [file, nss] of files) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const usedByNs = new Map(nss.map((ns) => [ns, new Set()]));
    // 面板捷徑：T('own.namespace.key')（fields.js 也是 T = fields）
    for (const m of src.matchAll(/\bT\('([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)'/g)) {
      usedByNs.get(nss[0]).add(m[1]);
    }
    // inspector 另外用 F() 指向 fields 命名空間
    if (src.includes('const F =')) {
      for (const m of src.matchAll(/\bF\('([A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)*)'/g)) {
        usedByNs.get('fields')?.add(m[1]);
      }
    }
    for (const [ns, used] of usedByNs) {
      const defined = new Set(Object.keys(PANELS[ns]['zh-Hant']));
      for (const key of used) {
        if (!defined.has(key)) missing.push(`${file}: ${ns}.${key}`);
      }
    }
  }
  eq(missing, []);
});

test('setLocale 切換後 t() 立即回傳該語系字串', () => {
  try {
    setLocale('zh-Hant');
    ok(getLocale() === 'zh-Hant');
    // 用欄位表的 label（getter 每次呼叫都重新解析）
    eq(SPAWN_FIELD_BY_KEY.speed.label, '速度');
    eq(eventTypeLabel('spawn'), '生成');

    setLocale('zh-Hans');
    eq(SPAWN_FIELD_BY_KEY.speed.label, '速度');   // 兩地同字
    eq(eventTypeLabel('emitter'), '发射器');      // 簡中慣用詞

    setLocale('en');
    eq(SPAWN_FIELD_BY_KEY.speed.label, 'Speed');
    eq(eventTypeLabel('emitter'), 'emitter');
    eq(checkExprSyntax(''), 'Expression is empty');
    eq(hitboxSummary({ hitbox: { shape: 'circle', r: 6 } }), 'circle r=6'); // 技術字串不翻譯
    ok(bulletTypeSubtitle({ sprite: 'spr_x', damage: 5 }).includes('5 damage'));
  } finally {
    setLocale('zh-Hant');
  }
});

test('locales/panels.js：簡中不含繁體專用字（繁簡確實轉換）', () => {
  // (繁, 簡) 字形不同、兩地不會混用的常用字；「存、入、名、定」等兩地共用的字不收錄
  const PAIRS = [
    ['儲', '储'], ['復', '复'], ['時', '时'], ['間', '间'], ['軸', '轴'], ['編', '编'], ['輯', '辑'],
    ['檔', '档'], ['選', '选'], ['確', '确'], ['開', '开'], ['關', '关'], ['圖', '图'], ['資', '资'],
    ['檢', '检'], ['預', '预'], ['覽', '览'], ['動', '动'], ['畫', '画'], ['數', '数'], ['變', '变'],
    ['刪', '删'], ['顏', '颜'], ['寬', '宽'], ['長', '长'], ['幀', '帧'], ['顯', '显'], ['隱', '隐'],
    ['輸', '输'], ['錯', '错'], ['誤', '误'], ['參', '参'], ['設', '设'], ['戰', '战'], ['靈', '灵'],
    ['團', '团'], ['隊', '队'], ['敵', '敌'], ['節', '节'], ['複', '复'], ['貼', '贴'], ['匯', '汇'],
    ['鍵', '键'], ['盤', '盘'], ['聲', '声'], ['暫', '暂'], ['繼', '继'], ['續', '续'], ['傷', '伤'],
    ['範', '范'], ['圍', '围'], ['體', '体'], ['載', '载'], ['讀', '读'], ['絕', '绝'], ['執', '执'],
    ['備', '备'], ['準', '准'], ['閉', '闭'], ['視', '视'], ['發', '发'], ['測', '测'], ['應', '应'],
    ['該', '该'], ['麼', '么'], ['雖', '虽'], ['與', '与'], ['並', '并'], ['來', '来'], ['後', '后'],
    ['給', '给'], ['過', '过'], ['還', '还'], ['裡', '里'], ['樣', '样'], ['對', '对'], ['從', '从'],
    ['會', '会'], ['種', '种'], ['處', '处'], ['實', '实'], ['現', '现'], ['轉', '转'], ['換', '换'],
    ['條', '条'], ['雙', '双'], ['單', '单'], ['擊', '击'], ['縮', '缩'], ['傳', '传'], ['遞', '递'],
    ['們', '们'], ['個', '个'], ['這', '这'], ['為', '为'], ['沒', '没'], ['點', '点'], ['稱', '称'],
    ['員', '员'], ['頂', '顶'], ['側', '侧'], ['縱', '纵'], ['橫', '横'], ['徑', '径'], ['圓', '圆'],
    ['線', '线'], ['邊', '边'], ['層', '层'], ['級', '级'], ['於', '于'], ['啟', '启'], ['將', '将'],
  ];
  const tradOnly = new Set(PAIRS.map((p) => p[0]));
  const simpOnly = new Set(PAIRS.map((p) => p[1]));

  const badHans = [];
  const badHant = [];
  for (const ns of NAMESPACES) {
    for (const [k, v] of Object.entries(PANELS[ns]['zh-Hans'])) {
      const hits = [...new Set([...v].filter((ch) => tradOnly.has(ch)))];
      if (hits.length) badHans.push(`zh-Hans ${ns}.${k} 含繁體字 ${hits.join('')}`);
    }
    for (const [k, v] of Object.entries(PANELS[ns]['zh-Hant'])) {
      const hits = [...new Set([...v].filter((ch) => simpOnly.has(ch)))];
      if (hits.length) badHant.push(`zh-Hant ${ns}.${k} 含簡體字 ${hits.join('')}`);
    }
  }
  eq(badHans, []);
  eq(badHant, []);
});

test('locales/panels.js：簡中使用大陸慣用詞（抽樣）', () => {
  const hans = PANELS.inspector['zh-Hans'];
  eq(hans['typeOption.emitter'], '发射器 emitter');
  eq(hans['title.panel'], '属性');
  eq(hans['title.bulletType'], '子弹类型');
  eq(hans['title.settings'], '回合设置');
  ok(hans['aria'].includes('检查器'), hans['aria']);
  ok(hans['title.deleteEvent'].includes('时间轴'), hans['title.deleteEvent']);
  ok(PANELS.assets['zh-Hans']['detail.emptySub'].includes('缩略图'), PANELS.assets['zh-Hans']['detail.emptySub']);
});

test('面板模組不含硬編碼的中介面字串（除了資料值）', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // 允許的例外：寫進攻擊檔的資料（不是介面字串），以及 CSS class / dataTransfer MIME
  const ALLOW = new Set(['未命名']);
  const CJK = /[\u4e00-\u9fff]/;
  const files = ['fields.js', 'inspector.js', 'assets-panel.js', 'bullet-types.js'];
  const bad = [];
  for (const file of files) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
      if (!CJK.test(line)) continue;
      // 只檢查字串常值裡的內容
      for (const m of line.matchAll(/'([^'\\]*)'|"([^"\\]*)"|`([^`\\]*)`/g)) {
        const text = m[1] ?? m[2] ?? m[3] ?? '';
        if (!CJK.test(text)) continue;
        if (ALLOW.has(text)) continue;
        bad.push(`${file}:${i + 1} 「${text}」`);
      }
    }
  }
  eq(bad, []);
});

test('tagLabel：已知 tag 顯示雙語說明、未知 tag 原樣輸出', () => {
  try {
    setLocale('zh-Hant');
    eq(tagLabel('soul'), '靈魂 soul');
    eq(tagLabel('battlebg'), '背景 battlebg');
    setLocale('zh-Hans');
    eq(tagLabel('bullet'), '子弹 bullet');
    setLocale('en');
    eq(tagLabel('enemy'), 'enemy');
    eq(tagLabel('party'), 'party');
    // 未知 tag 不翻譯、也不拋錯
    eq(tagLabel('custom'), 'custom');
    eq(tagLabel(''), '');
  } finally {
    setLocale('zh-Hant');
  }
});

/* ============================ 執行 ============================ */

let current = '';
test('section 摺疊狀態：loadSectionState / saveSectionState 往返、壞資料回空物件（REALTEST-2 V13）', () => {
  const store = new Map();
  const storage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  assert.deepEqual(loadSectionState(storage), {});
  assert.equal(saveSectionState(storage, { demo: false, meta: true, junk: 'x' }), true);
  assert.deepEqual(JSON.parse(store.get(SECTION_STATE_KEY)), { demo: false, meta: true });
  assert.deepEqual(loadSectionState(storage), { demo: false, meta: true });
  store.set(SECTION_STATE_KEY, '{not json');
  assert.deepEqual(loadSectionState(storage), {});
  store.set(SECTION_STATE_KEY, '[1,2]');
  assert.deepEqual(loadSectionState(storage), {});
  assert.deepEqual(loadSectionState(null), {});
  assert.equal(saveSectionState(null, { demo: true }), false);
  assert.equal(saveSectionState({ setItem() { throw new Error('quota'); } }, { demo: true }), false);
});

test('檢查器：Demo 區塊預設收合、標題列有「產生路徑」捷徑、摺疊提示三語都有', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'inspector.js'), 'utf8');
  assert.match(src, /sec\('demo', D\('section'\), body, \{ collapsed: true \}\)/);
  assert.match(src, /gen\.shortcutTitle/);
  assert.match(src, /loadSectionState\(sectionStorage\(\)\)/);
  for (const lang of LOCALE_IDS) {
    assert.ok(PANELS.inspector[lang]['section.expandTip'], `${lang} 缺 section.expandTip`);
    assert.ok(PANELS.inspector[lang]['section.collapseTip'], `${lang} 缺 section.collapseTip`);
  }
});

for (const [name, fn] of tests) {
  current = name;
  try {
    fn();
    passed += 1;
  } catch (e) {
    failures.push({ name, error: e });
  }
}

if (failures.length > 0) {
  console.error(`\n✗ ${failures.length} 個測試失敗 / 共 ${tests.length} 個\n`);
  for (const f of failures) {
    console.error(`✗ ${f.name}`);
    console.error(String(f.error && f.error.stack ? f.error.stack : f.error).split('\n').slice(0, 6).join('\n'));
    console.error('');
  }
  process.exitCode = 1;
} else {
  console.log(`✓ 全部通過：${passed} / ${tests.length} 個測試`);
}
void throwsNone;
void current;
void ORIGINAL_LOCALE;
void LOCALES;
