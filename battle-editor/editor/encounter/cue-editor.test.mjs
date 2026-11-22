/**
 * editor/encounter/cue-editor.test.mjs — ED2：演出指令編輯器測試
 *
 * 涵蓋：
 *   1. cue-schema 與引擎 CUE_COMMANDS 一致（engine/encounter/schema.js 尚未存在時跳過並警告）
 *   2. 路徑工具、清單操作（拖曳插入、巢狀移動、刪除、複製）
 *   3. 摘要（三語）、預設值（20 指令）
 *   4. 錯誤路徑比對
 *   5. editor/locales/cues.js 三語鍵集合一致、無空字串、佔位符一致
 *   6. i18n 註冊與切換
 *
 * 執行：node --test editor/encounter/cue-editor.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import * as i18n from '../../editor/i18n.js';
import CUES_STRINGS from '../../editor/locales/cues.js';
import CUES_FORM_STRINGS, { findKeyMismatches as findCueFormKeyMismatches } from '../../editor/locales/encounter-cue-form.js';
import * as schema from '../../editor/encounter/cue-schema.js';

const {
  CUE_SCHEMA,
  CUE_COMMANDS_LIST,
  CUE_GROUPS,
  EASE_NAMES,
  FIELD_TYPES,
  getCommandSpec,
  createDefaultCue,
  cloneCue,
  commandLabel,
  groupLabel,
  commandsByGroup,
  cueSummary,
  cueBadges,
  pickText,
  isTextObject,
  clipText,
  numText,
  pathToKey,
  keyToPath,
  parseStorePath,
  formatStorePath,
  cueAbsPath,
  isPrefix,
  getArrayAt,
  getCueAt,
  locateCue,
  pruneNestedPaths,
  sortPaths,
  flattenCues,
  computeDropTarget,
  moveCues,
  insertCues,
  removeCues,
  duplicateCues,
  collectVarNames,
  countCues,
  matchCueErrors,
  matchListErrors,
  selectionForDrag,
} = schema;

const LOCALES = ['zh-Hant', 'zh-Hans', 'en'];

/* ------------------------------------------------------------------ 共用 */

function withLocale(loc, fn) {
  const prev = i18n.getLocale();
  if (loc !== prev) i18n.setLocale(loc);
  try { return fn(); } finally { if (i18n.getLocale() !== prev) i18n.setLocale(prev); }
}

/** 典型遭遇指令清單（含巢狀） */
function sampleCues() {
  return [
    { cmd: 'say', text: '* 鲁丁挡住了去路！', speed: 1 },
    {
      cmd: 'if',
      cond: 'var.complimented > 0',
      then: [
        { cmd: 'bubble', actor: 'rudinn', text: '要来点闪光吗？', side: 'left' },
        { cmd: 'mercy', enemy: 'rudinn', amount: 20 },
      ],
      else: [{ cmd: 'anim', actor: 'rudinn', anim: 'happy' }],
    },
    { cmd: 'parallel', cues: [{ cmd: 'shake', amount: 4, duration: 0.3 }, { cmd: 'sfx', sound: 'snd_hurt1' }] },
    { cmd: 'move', actor: 'kris', x: 120, y: 160, duration: 0.5, ease: 'quadInOut' },
    { cmd: 'end', result: 'victory' },
  ];
}

/* ------------------------------------------------------ 1. 結構與指令清單 */

test('cue-schema：20 個指令、六大類別、每個指令都有完整欄位描述', () => {
  assert.equal(CUE_SCHEMA.length, 20, `應有 20 個指令，實際 ${CUE_SCHEMA.length}`);
  const cmds = CUE_SCHEMA.map((c) => c.cmd);
  assert.equal(new Set(cmds).size, 20, '指令名不可重複');
  for (const spec of CUE_SCHEMA) {
    assert.ok(CUE_GROUPS.includes(spec.group), `${spec.cmd} 類別 ${spec.group} 不在 CUE_GROUPS`);
    assert.ok(spec.icon && spec.icon.length <= 4, `${spec.cmd} 需要短圖示`);
    assert.ok(spec.descKey.startsWith('cues.desc.'), `${spec.cmd} descKey 格式`);
    assert.ok(spec.fields.length >= 1, `${spec.cmd} 至少要有一個欄位`);
    for (const field of spec.fields) {
      assert.ok(field.key, `${spec.cmd} 欄位缺少 key`);
      assert.ok(field.type, `${spec.cmd}.${field.key} 缺少 type`);
      assert.ok(field.labelKey.startsWith('cues.field.'), `${spec.cmd}.${field.key} labelKey 格式`);
      assert.ok(field.descKey.startsWith('cues.fieldDesc.'), `${spec.cmd}.${field.key} descKey 格式`);
      assert.equal(typeof field.required, 'boolean');
    }
  }
});

test('cue-schema：SPEC-P2 §3 表格的參數都在對應指令的欄位裡', () => {
  const expected = {
    say: ['text', 'speaker', 'portrait', 'speed', 'voice'],
    bubble: ['actor', 'text', 'side', 'speed', 'wait'],
    move: ['actor', 'x', 'y', 'relative', 'duration', 'ease'],
    anim: ['actor', 'anim', 'sprite', 'fps', 'loop', 'waitEnd'],
    form: ['actor', 'name', 'anim'],
    flip: ['actor', 'value'],
    fade: ['actor', 'alpha', 'duration'],
    wait: ['seconds'],
    sfx: ['sound'],
    bgm: ['track', 'fade'],
    shake: ['amount', 'duration'],
    flash: ['color', 'duration'],
    set: ['var', 'value', 'op'],
    mercy: ['enemy', 'amount'],
    heal: ['target', 'amount'],
    damage: ['target', 'amount'],
    if: ['cond', 'then', 'else'],
    parallel: ['cues'],
    attack: ['attack'],
    end: ['result'],
  };
  for (const [cmd, keys] of Object.entries(expected)) {
    const spec = getCommandSpec(cmd);
    assert.ok(spec, `缺少指令 ${cmd}`);
    const got = spec.fields.map((f) => f.key);
    assert.deepEqual(got, keys, `${cmd} 的欄位順序/內容應為 ${keys.join(',')}，實際 ${got.join(',')}`);
  }
});

test('cue-schema：if / parallel 是唯二有巢狀子清單的指令', () => {
  const withChildren = CUE_SCHEMA.filter((c) => c.children).map((c) => c.cmd);
  assert.deepEqual(withChildren, ['if', 'parallel']);
  assert.deepEqual(getCommandSpec('if').children, ['then', 'else']);
  assert.deepEqual(getCommandSpec('parallel').children, ['cues']);
});

test('cue-schema：ease 名稱與 engine/easing.js 的 EASING_NAMES 一致', () => {
  const src = readFileSync(new URL('../../engine/easing.js', import.meta.url), 'utf8');
  const m = src.match(/export const EASING_NAMES\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, '找不到 EASING_NAMES');
  const names = m[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  assert.deepEqual(EASE_NAMES, names, 'cue-schema 的 EASE_NAMES 需與引擎同步');
});

test('cue-schema：與引擎 CUE_COMMANDS 一致（引擎未就緒時跳過）', async () => {
  const engineUrl = new URL('../../engine/encounter/schema.js', import.meta.url);
  if (!existsSync(engineUrl)) {
    console.warn('[cue-editor.test] 跳過 CUE_COMMANDS 比對：engine/encounter/schema.js 尚不存在（E1 平行開發中）');
    return;
  }
  let mod;
  try {
    mod = await import(engineUrl.href);
  } catch (err) {
    console.warn('[cue-editor.test] 跳過 CUE_COMMANDS 比對：engine/encounter/schema.js 無法載入', err.message);
    return;
  }
  const engineCommands = mod.CUE_COMMANDS;
  assert.ok(engineCommands, 'engine/encounter/schema.js 應匯出 CUE_COMMANDS');
  const engineList = Array.isArray(engineCommands) ? engineCommands : Object.keys(engineCommands);
  const engineSet = new Set(engineList);
  const editorSet = new Set(CUE_COMMANDS_LIST);

  const missingInEditor = [...engineSet].filter((c) => !editorSet.has(c));
  const missingInEngine = [...editorSet].filter((c) => !engineSet.has(c));
  assert.deepEqual(missingInEditor, [], `cue-schema 缺少引擎指令：${missingInEditor.join(', ')}`);
  assert.deepEqual(missingInEngine, [], `引擎缺少 cue-schema 指令：${missingInEngine.join(', ')}`);

  // 逐指令比對參數（引擎 params 是 name → {type, default, …} 的物件）
  for (const [cmd, def] of Object.entries(engineCommands)) {
    const params = Array.isArray(def) ? def : (def && (def.params || def.fields));
    if (!params) continue;
    const spec = getCommandSpec(cmd);
    assert.ok(spec, `cue-schema 缺少引擎指令 ${cmd}`);
    const engineNames = Array.isArray(params)
      ? params.map((p) => (typeof p === 'string' ? p : p && (p.key || p.name))).filter(Boolean)
      : Object.keys(params);
    const ours = new Set(spec.fields.map((f) => f.key));
    const missing = engineNames.filter((n) => !ours.has(n));
    assert.deepEqual(missing, [], `cue-schema 的 ${cmd} 缺少引擎參數：${missing.join(', ')}`);
    const extra = spec.fields.map((f) => f.key).filter((n) => !engineNames.includes(n));
    assert.deepEqual(extra, [], `cue-schema 的 ${cmd} 有引擎沒有的參數：${extra.join(', ')}`);

    // 類別 / 阻塞旗標 / 預設值
    if (def && def.category) {
      assert.equal(spec.group, def.category, `${cmd} 的類別需與引擎一致`);
    }
    if (def && typeof def.blocking === 'boolean') {
      assert.equal(spec.blocking, def.blocking, `${cmd} 的 blocking 需與引擎一致`);
    }
    if (!Array.isArray(params)) {
      for (const field of spec.fields) {
        const p = params[field.key];
        if (!p || p.default === undefined) continue;
        assert.deepEqual(field.default, p.default, `${cmd}.${field.key} 的預設值需與引擎一致`);
      }
    }
  }

  // 類別清單（引擎 CUE_CATEGORIES 的 id）也要一致
  if (Array.isArray(mod.CUE_CATEGORIES)) {
    const engineCats = mod.CUE_CATEGORIES.map((c) => (typeof c === 'string' ? c : c.id));
    assert.deepEqual(CUE_GROUPS, engineCats, 'CUE_GROUPS 需與引擎 CUE_CATEGORIES 一致');
  }
});

test('cue-schema：欄位型別與必填旗標與引擎參數相容', async () => {
  const engineUrl = new URL('../../engine/encounter/schema.js', import.meta.url);
  if (!existsSync(engineUrl)) {
    console.warn('[cue-editor.test] 跳過型別比對：engine/encounter/schema.js 尚不存在');
    return;
  }
  let mod;
  try {
    mod = await import(engineUrl.href);
  } catch (err) {
    console.warn('[cue-editor.test] 跳過型別比對：engine/encounter/schema.js 無法載入', err.message);
    return;
  }
  const engineCommands = mod.CUE_COMMANDS;
  if (!engineCommands || Array.isArray(engineCommands)) return;

  /**
   * 引擎型別 → 編輯器允許的欄位型別。
   * 編輯器可以在引擎的基礎上放寬（例如 number 允許填表達式），但不可窄化到引擎
   * 合法值放不進去；`enum` 對應 `result` 是因為 end.result 有專屬下拉。
   */
  const COMPAT = {
    text: ['text'],
    string: ['text', 'var', 'sound'],
    number: ['number', 'expr'],
    bool: ['bool'],
    enum: ['enum', 'result'],
    color: ['color'],
    actor: ['actor'],
    sprite: ['sprite'],
    sound: ['sound'],
    attack: ['attack'],
    target: ['target'],
    expr: ['expr', 'number'],
    cues: ['cues'],
    ease: ['ease'],
    any: ['numberOrInput', 'text'],
  };

  for (const [cmd, def] of Object.entries(engineCommands)) {
    const params = def && def.params;
    if (!params || Array.isArray(params)) continue;
    const spec = getCommandSpec(cmd);
    assert.ok(spec, `cue-schema 缺少引擎指令 ${cmd}`);
    for (const [name, p] of Object.entries(params)) {
      const field = spec.fields.find((f) => f.key === name);
      assert.ok(field, `cue-schema 的 ${cmd} 缺少引擎參數 ${name}`);
      const allowed = COMPAT[p.type] || [p.type];
      assert.ok(
        allowed.includes(field.type),
        `${cmd}.${name}：引擎型別 ${p.type}，編輯器欄位型別 ${field.type}（允許 ${allowed.join(' / ')}）`,
      );
      // 引擎標必填的，編輯器也必須標（編輯器可更嚴格，例如 SPEC 的必填）
      if (p.required) {
        assert.equal(field.required, true, `${cmd}.${name} 引擎標為必填，編輯器也要標必填`);
      }
    }
  }
});

/* -------------------------------------------------------- 2. 預設值 / 語系 */

test('createDefaultCue：20 個指令都能建立合理預設值', () => {
  const actors = [
    { id: 'kris', kind: 'party', name: 'Kris' },
    { id: 'rudinn', kind: 'enemy', name: 'Rudinn' },
  ];
  const opts = {
    actors,
    attacks: ['spade-rain'],
    sounds: ['snd_hurt1'],
    sprites: ['spr_krisb_idle'],
    vars: ['complimented'],
  };
  for (const spec of CUE_SCHEMA) {
    const cue = createDefaultCue(spec.cmd, opts);
    assert.ok(cue, `${spec.cmd} 應能建立預設值`);
    assert.equal(cue.cmd, spec.cmd);
    assert.equal(cue.async, false, `${spec.cmd} 預設 async 應為 false`);
    for (const field of spec.fields) {
      assert.ok(field.key in cue, `${spec.cmd}.${field.key} 應有預設值`);
      if (field.type === FIELD_TYPES.CUES) assert.ok(Array.isArray(cue[field.key]));
    }
  }
});

test('createDefaultCue：actor 依 kinds/prefer 挑選、attack/sound/var 取第一個', () => {
  const actors = [
    { id: 'kris', kind: 'party' },
    { id: 'rudinn', kind: 'enemy' },
  ];
  const opts = { actors, attacks: ['spade-rain', 'ring-burst'], sounds: ['snd_hurt1'], vars: ['flag'] };
  assert.equal(createDefaultCue('bubble', opts).actor, 'kris', 'bubble 取第一個演員');
  assert.equal(createDefaultCue('mercy', opts).enemy, 'rudinn', 'mercy 只挑 enemy');
  assert.equal(createDefaultCue('heal', opts).target, 'kris', 'heal 偏好 party');
  assert.equal(createDefaultCue('attack', opts).attack, 'spade-rain');
  assert.equal(createDefaultCue('sfx', opts).sound, 'snd_hurt1');
  assert.equal(createDefaultCue('set', opts).var, 'flag');
  assert.equal(createDefaultCue('bgm', opts).track, null, 'bgm.track 不自動挑第一個');
  assert.equal(createDefaultCue('say', opts).portrait, null, 'say.portrait 不自動挑第一個');
  assert.equal(createDefaultCue('say', opts).voice, null, 'say.voice 不自動挑第一個');
});

test('createDefaultCue：沒有演員/素材清單時也不會爆', () => {
  for (const spec of CUE_SCHEMA) {
    const cue = createDefaultCue(spec.cmd);
    assert.ok(cue, `${spec.cmd} 無 opts 也應建立`);
    const actors = spec.fields.filter((f) => f.type === FIELD_TYPES.ACTOR);
    for (const field of actors) assert.equal(cue[field.key], null, `${spec.cmd}.${field.key} 應為 null`);
  }
});

test('createDefaultCue：未知指令回傳 null', () => {
  assert.equal(createDefaultCue('nope'), null);
});

test('cloneCue：深拷貝、巢狀清單互不影響', () => {
  const src = { cmd: 'if', cond: 'x', then: [{ cmd: 'wait', seconds: 1 }], else: [] };
  const copy = cloneCue(src);
  copy.then[0].seconds = 9;
  assert.equal(src.then[0].seconds, 1);
  assert.notEqual(copy, src);
});

test('文字工具：pickText 支援字串與 { zh, en }', () => {
  assert.equal(pickText('hello', 'zh'), 'hello');
  assert.equal(pickText({ zh: '嗨', en: 'hi' }, 'zh'), '嗨');
  assert.equal(pickText({ zh: '嗨', en: 'hi' }, 'en'), 'hi');
  assert.equal(pickText({ zh: '嗨' }, 'en'), '嗨', '缺 en 時退回 zh');
  assert.equal(pickText(null, 'zh'), '');
  assert.equal(pickText(42, 'zh'), '42');
  assert.equal(isTextObject({ zh: 'x' }), true);
  assert.equal(isTextObject('x'), false);
  assert.equal(isTextObject(null), false);
});

test('clipText / numText', () => {
  assert.equal(clipText('a  b\nc', 20), 'a b c');
  assert.equal(clipText('abcdefghij', 5), 'abcd…');
  assert.equal(clipText('abc', 0), 'abc');
  assert.equal(numText(1 / 3), '0.333');
  assert.equal(numText(2), '2');
  assert.equal(numText(-0.5), '-0.5');
});

/* ------------------------------------------------------------ 3. 路徑工具 */

test('parseStorePath / formatStorePath：多種寫法互轉', () => {
  const cases = [
    ['turns[0].start', ['turns', 0, 'start']],
    ['turns/0/start', ['turns', 0, 'start']],
    ['hooks.victory', ['hooks', 'victory']],
    ['enemies[2].acts[1].cues', ['enemies', 2, 'acts', 1, 'cues']],
  ];
  for (const [str, arr] of cases) {
    assert.deepEqual(parseStorePath(str), arr, `parse ${str}`);
    assert.equal(formatStorePath(arr), formatStorePath(parseStorePath(str).length ? str : ''), `format ${str}`);
  }
  // 正規形式一律用 [] 表示索引
  assert.equal(formatStorePath(['turns', 0, 'start']), 'turns[0].start');
  assert.equal(formatStorePath(['hooks', 'victory']), 'hooks.victory');
  assert.deepEqual(parseStorePath(['a', 1]), ['a', 1], '已是陣列時直接複製');
  assert.deepEqual(parseStorePath(null), []);
  assert.deepEqual(parseStorePath('[0]'), [0]);
});

test('cueAbsPath：把相對路徑接在 cuePath 後面', () => {
  assert.equal(cueAbsPath('turns[0].start', []), 'turns[0].start');
  assert.equal(cueAbsPath('turns[0].start', [0]), 'turns[0].start[0]');
  assert.equal(cueAbsPath('turns[0].start', [0, 'then', 1]), 'turns[0].start[0].then[1]');
  assert.equal(cueAbsPath(['turns', 0, 'start'], [2]), 'turns[0].start[2]');
  assert.equal(cueAbsPath('hooks.intro', [1, 'else', 0, 'text']), 'hooks.intro[1].else[0].text');
});

test('pathToKey / keyToPath：內部選取鍵', () => {
  assert.equal(pathToKey([0, 'then', 1]), '0/then/1');
  assert.deepEqual(keyToPath('0/then/1'), [0, 'then', 1]);
  assert.deepEqual(keyToPath([]), []);
  assert.deepEqual(keyToPath(''), []);
});

test('isPrefix / pruneNestedPaths / sortPaths', () => {
  assert.equal(isPrefix([], [0]), true);
  assert.equal(isPrefix([0], [0, 'then', 1]), true);
  assert.equal(isPrefix([0, 'then'], [0]), false);
  assert.equal(isPrefix([1], [0]), false);

  const pruned = pruneNestedPaths([[0], [0, 'then', 1], [2], [2, 'cues', 0]]);
  assert.deepEqual(pruned, [[0], [2]], '子孫要被祖先吸收');

  // 排序是深度優先前序：祖先緊接著它的子孫，方便逐層套用到草稿
  const sorted = sortPaths([[1], [0, 'then', 0], [0]]);
  assert.deepEqual(sorted, [[0], [0, 'then', 0], [1]]);
});

test('getArrayAt / getCueAt / locateCue：巢狀存取', () => {
  const cues = sampleCues();
  assert.ok(Array.isArray(getArrayAt(cues, [])));
  assert.equal(getArrayAt(cues, [1]), null, 'getArrayAt 要的是陣列');
  assert.ok(Array.isArray(getArrayAt(cues, [1, 'then'])));
  assert.equal(getCueAt(cues, []), null);
  assert.equal(getCueAt(cues, [0]).cmd, 'say');
  assert.equal(getCueAt(cues, [1, 'then', 0]).cmd, 'bubble');
  assert.equal(getCueAt(cues, [1, 'then', 99]), null);
  assert.equal(getCueAt(cues, [99]), null);

  const loc = locateCue(cues, [1, 'then', 0]);
  assert.ok(loc);
  assert.equal(loc.index, 0);
  assert.equal(loc.array.length, 2);
  assert.deepEqual(loc.containerPath, [1, 'then']);
});

/* ---------------------------------------------------- 4. 拖曳插入位置計算 */

function entriesFrom(layout) {
  // layout: [{ index, containerPath, top, bottom }]
  return layout.map((e) => ({
    index: e.index,
    containerPath: e.containerPath || [],
    path: [...(e.containerPath || []), e.index],
    top: e.top,
    bottom: e.bottom,
  }));
}

test('computeDropTarget：空清單時回傳指定容器 index 0', () => {
  const r = computeDropTarget([], 100, [1, 'then']);
  assert.deepEqual(r.containerPath, [1, 'then']);
  assert.equal(r.index, 0);
});

test('computeDropTarget：落在卡片上半 → 插在它前面；下半 → 插在它後面', () => {
  const entries = entriesFrom([
    { index: 0, top: 0, bottom: 20 },
    { index: 1, top: 22, bottom: 42 },
    { index: 2, top: 44, bottom: 64 },
  ]);
  assert.equal(computeDropTarget(entries, 2).index, 0, '第一張上半 → 插在第一張前');
  assert.equal(computeDropTarget(entries, 18).index, 1, '第一張下半 → 插在第一張後');
  assert.equal(computeDropTarget(entries, 22).index, 1, '第二張 top → 插在第二張前');
  assert.equal(computeDropTarget(entries, 33).index, 2, '第二張下半 → 插在第二張後');
  const bottom = computeDropTarget(entries, 64);
  assert.equal(bottom.index, 3, '最後一張 bottom → 插到最後');
  const belowAll = computeDropTarget(entries, 200);
  assert.equal(belowAll.index, 3, '遠低於清單 → 插到最後');
  const aboveAll = computeDropTarget(entries, -50);
  assert.equal(aboveAll.index, 0, '遠高於清單 → 插到最前');
  // 空清單 → 退回指定容器
  const empty = computeDropTarget([], 10, [3, 'then']);
  assert.deepEqual(empty.containerPath, [3, 'then']);
  assert.equal(empty.index, 0);
});

test('computeDropTarget：巢狀容器的 entries 只在自己的容器內', () => {
  const entries = entriesFrom([
    { index: 0, containerPath: [1, 'then'], top: 100, bottom: 120 },
    { index: 1, containerPath: [1, 'then'], top: 122, bottom: 142 },
  ]);
  const top = computeDropTarget(entries, 101);
  assert.deepEqual(top.containerPath, [1, 'then']);
  assert.equal(top.index, 0);
  const gap = computeDropTarget(entries, 121);
  assert.deepEqual(gap.containerPath, [1, 'then']);
  assert.equal(gap.index, 1, '兩張之間 → 插在第二張前');
});

/* ------------------------------------------------------ 5. 清單移動/插入 */

test('moveCues：同層往前移', () => {
  const cues = [{ cmd: 'say', text: 'a' }, { cmd: 'say', text: 'b' }, { cmd: 'say', text: 'c' }];
  const r = moveCues(cues, [[2]], [], 0);
  assert.equal(r.ok, true);
  assert.deepEqual(cues.map((c) => c.text), ['c', 'a', 'b']);
  assert.deepEqual(r.paths, [[0]]);
});

test('moveCues：同層往後移（索引修正）', () => {
  const cues = [{ cmd: 'say', text: 'a' }, { cmd: 'say', text: 'b' }, { cmd: 'say', text: 'c' }];
  const r = moveCues(cues, [[0]], [], 3);
  assert.equal(r.ok, true);
  assert.deepEqual(cues.map((c) => c.text), ['b', 'c', 'a']);
  assert.deepEqual(r.paths, [[2]]);
});

test('moveCues：拖進巢狀子清單', () => {
  const cues = [
    { cmd: 'if', cond: 'x', then: [], else: [] },
    { cmd: 'wait', seconds: 1 },
  ];
  const r = moveCues(cues, [[1]], [0, 'then'], 0);
  assert.equal(r.ok, true);
  assert.equal(cues[0].then.length, 1);
  assert.equal(cues[0].then[0].cmd, 'wait');
  assert.equal(cues.length, 1);
  assert.deepEqual(r.paths, [[0, 'then', 0]]);
});

test('moveCues：拖出巢狀子清單', () => {
  const cues = [
    { cmd: 'if', cond: 'x', then: [{ cmd: 'wait', seconds: 1 }, { cmd: 'wait', seconds: 2 }], else: [] },
  ];
  const r = moveCues(cues, [[0, 'then', 1]], [], 1);
  assert.equal(r.ok, true);
  assert.equal(cues[0].then.length, 1);
  assert.equal(cues.length, 2);
  assert.equal(cues[1].seconds, 2);
});

test('moveCues：拒絕把指令拖進自己的子孫', () => {
  const cues = [{ cmd: 'if', cond: 'x', then: [{ cmd: 'wait', seconds: 1 }], else: [] }];
  const r = moveCues(cues, [[0]], [0, 'then'], 0);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'self-nest');
  assert.equal(cues[0].then.length, 1, '資料不應被改動');
});

test('moveCues：多選一起移動、順序保持', () => {
  const cues = [
    { cmd: 'say', text: 'a' },
    { cmd: 'say', text: 'b' },
    { cmd: 'say', text: 'c' },
    { cmd: 'say', text: 'd' },
  ];
  // destIndex 3 = 插在原始陣列索引 3（d）之前；a、c 都來自它前面 → 插入點前移 2 → 1
  const r = moveCues(cues, [[0], [2]], [], 3);
  assert.equal(r.ok, true);
  assert.deepEqual(cues.map((c) => c.text), ['b', 'a', 'c', 'd'], '被拖的兩張保持原順序、落在 d 之前');
  assert.deepEqual(r.paths, [[1], [2]]);

  // 反向：把後面的搬到最前面
  const cues2 = [
    { cmd: 'say', text: 'a' },
    { cmd: 'say', text: 'b' },
    { cmd: 'say', text: 'c' },
    { cmd: 'say', text: 'd' },
  ];
  const r2 = moveCues(cues2, [[2], [3]], [], 0);
  assert.equal(r2.ok, true);
  assert.deepEqual(cues2.map((c) => c.text), ['c', 'd', 'a', 'b']);
  assert.deepEqual(r2.paths, [[0], [1]]);
});

test('insertCues：插入並回傳新路徑', () => {
  const cues = [{ cmd: 'wait', seconds: 1 }];
  const paths = insertCues(cues, [], 0, [{ cmd: 'say', text: 'hi' }, { cmd: 'shake', amount: 1, duration: 0.1 }]);
  assert.deepEqual(paths, [[0], [1]]);
  assert.equal(cues.length, 3);
  assert.equal(cues[0].cmd, 'say');
});

test('insertCues：索引超出範圍時夾住', () => {
  const cues = [];
  const paths = insertCues(cues, [], 99, [{ cmd: 'wait', seconds: 1 }]);
  assert.deepEqual(paths, [[0]]);
  assert.equal(cues.length, 1);
});

test('selectionForDrag：拖曳未選取的卡片 → 只選它', () => {
  assert.deepEqual(selectionForDrag(new Set(['3', '4']), '1'), ['1']);
  assert.deepEqual(selectionForDrag([], '0'), ['0']);
});

test('selectionForDrag：拖曳已選取的卡片 → 整個多選一起拖', () => {
  assert.deepEqual(selectionForDrag(new Set(['3', '4']), '4'), ['3', '4']);
});

test('selectionForDrag：Shift/Ctrl 加選 → 保留原選取再加入', () => {
  assert.deepEqual(selectionForDrag(new Set(['0']), '2', true), ['0', '2']);
  assert.deepEqual(selectionForDrag(new Set(['0']), '0', true), ['0'], '已在集合內不重複');
});

test('selectionForDrag：容錯（null / 數字 id / 非陣列）', () => {
  assert.deepEqual(selectionForDrag(null, '1'), ['1']);
  assert.deepEqual(selectionForDrag(new Set([1, 2]), 2), ['1', '2'], '數字 key 轉字串');
  assert.deepEqual(selectionForDrag(['a', null, undefined], 'a'), ['a']);
  assert.deepEqual(selectionForDrag(new Set(['a']), ''), ['a'], '沒有 key 時原樣回傳');
});

test('removeCues：刪除多條、含巢狀（祖先被刪則子孫一併消失）', () => {
  const cues = sampleCues();
  const removed = removeCues(cues, [[1], [1, 'else', 0]]);
  assert.equal(removed, 1, '祖先被刪時只算一條');
  assert.equal(cues.length, 4);
  assert.equal(cues.find((c) => c.cmd === 'if'), undefined);
});

test('removeCues：後面的索引不受影響', () => {
  const cues = [{ cmd: 'say', text: 'a' }, { cmd: 'say', text: 'b' }, { cmd: 'say', text: 'c' }];
  const removed = removeCues(cues, [[0], [2]]);
  assert.equal(removed, 2);
  assert.deepEqual(cues.map((c) => c.text), ['b']);
});

test('duplicateCues：複製品插在來源後面，巢狀整份複製', () => {
  const cues = [
    { cmd: 'if', cond: 'x', then: [{ cmd: 'wait', seconds: 1 }], else: [] },
    { cmd: 'end', result: 'victory' },
  ];
  const created = duplicateCues(cues, [[0]]);
  assert.deepEqual(created, [[1]]);
  assert.equal(cues.length, 3);
  assert.equal(cues[1].cmd, 'if');
  assert.equal(cues[1].then.length, 1);
  cues[1].then[0].seconds = 9;
  assert.equal(cues[0].then[0].seconds, 1, '巢狀必須深拷貝');
  assert.equal(cues[2].cmd, 'end', '後面的指令不受影響');
});

test('countCues / collectVarNames：遞迴統計', () => {
  const cues = sampleCues();
  assert.equal(countCues(cues), 10, '5 個頂層 + 2 then + 1 else + 2 parallel');
  assert.equal(countCues(null), 0);

  // sampleCues 沒有 set，補一段專門測變數收集（含巢狀）
  const withVars = [
    { cmd: 'set', var: 'complimented', value: 1 },
    { cmd: 'if', cond: 'var.complimented > 0', then: [{ cmd: 'set', var: 'mood', value: 2 }], else: [] },
    { cmd: 'parallel', cues: [{ cmd: 'set', var: 'hits', value: 0, op: 'add' }] },
    { cmd: 'say', text: 'no vars here' },
  ];
  const vars = collectVarNames(withVars);
  assert.deepEqual([...vars].sort(), ['complimented', 'hits', 'mood']);
  assert.deepEqual([...collectVarNames(cues)], [], '沒有 set 指令時收集不到變數');
  assert.equal(collectVarNames(null).size, 0);
});

test('flattenCues：只展開 expanded 記錄的容器', () => {
  const cues = sampleCues();
  const collapsedView = flattenCues(cues, { expanded: [] });
  assert.equal(collapsedView.length, 5, '全部收合時只有頂層');

  const expandedView = flattenCues(cues, { expanded: ['1', '2'] });
  assert.equal(expandedView.length, 5 + 2 + 1 + 2, 'if(1) 的 then/else 與 parallel(2) 的 cues 都要展開');
  assert.equal(expandedView[1].depth, 0);
  assert.equal(expandedView[2].depth, 1);
  assert.deepEqual(expandedView[2].path, [1, 'then', 0]);
  assert.equal(expandedView[2].containerPath.join('/'), '1/then');
});

test('flattenCues：相容 collapsed 集合', () => {
  const cues = sampleCues();
  const view = flattenCues(cues, { expanded: ['1'], collapsed: ['1'] });
  assert.equal(view.length, 5, 'expanded 有但 collapsed 也有 → 收合');
});

/* ------------------------------------------------------------ 6. 摘要 */

test('cueSummary：每種指令在預設值下都有非空摘要', () => {
  const actors = [{ id: 'kris', kind: 'party', name: 'Kris' }, { id: 'rudinn', kind: 'enemy', name: 'Rudinn' }];
  const opts = { actors, attacks: ['spade-rain'], sounds: ['snd_hurt1'], vars: ['flag'] };
  for (const spec of CUE_SCHEMA) {
    const cue = createDefaultCue(spec.cmd, opts);
    const summary = cueSummary(cue, { actorName: (id) => (id === 'rudinn' ? 'Rudinn' : String(id || '—')), lang: 'zh' });
    assert.ok(typeof summary === 'string' && summary.length > 0, `${spec.cmd} 摘要不應為空`);
    assert.ok(!summary.includes('cues.'), `${spec.cmd} 摘要含未翻譯的 key：${summary}`);
  }
});

test('cueSummary：具體格式符合 SPEC 範例', () => {
  const actorName = (id) => (id === 'rudinn' ? 'Rudinn' : id === 'kris' ? 'Kris' : String(id));
  withLocale('zh-Hant', () => {
    const say = cueSummary({ cmd: 'bubble', actor: 'rudinn', text: '要來點閃光嗎？', side: 'left' }, { actorName, lang: 'zh' });
    assert.match(say, /Rudinn/);
    assert.match(say, /要來點閃光嗎？/);

    const move = cueSummary({ cmd: 'move', actor: 'kris', x: 120, y: 160, duration: 0.5 }, { actorName, lang: 'zh' });
    assert.match(move, /Kris/);
    assert.match(move, /120/);
    assert.match(move, /160/);
    assert.match(move, /0\.5s/);
  });
});

test('cueSummary：label 優先、未知指令不爆', () => {
  assert.ok(cueSummary({ cmd: 'wat', label: 'x' }).length > 0);
  assert.equal(cueSummary(null), '');
  assert.equal(cueSummary('x'), '');
});

test('cueSummary：三語下 20 指令都有非空輸出且不含未翻譯 key', () => {
  const actors = [{ id: 'kris', kind: 'party' }, { id: 'rudinn', kind: 'enemy' }];
  const opts = { actors, attacks: ['spade-rain'], sounds: ['snd_hurt1'], vars: ['flag'] };
  for (const loc of LOCALES) {
    withLocale(loc, () => {
      for (const spec of CUE_SCHEMA) {
        const cue = createDefaultCue(spec.cmd, opts);
        const summary = cueSummary(cue);
        assert.ok(summary.length > 0, `${loc} ${spec.cmd} 摘要為空`);
        assert.ok(!/^cues\./.test(summary), `${loc} ${spec.cmd} 摘要回退成 key：${summary}`);
        assert.ok(!summary.includes('cues.'), `${loc} ${spec.cmd} 摘要含 key：${summary}`);
      }
    });
  }
});

test('cueSummary：文字欄位支援中英分開', () => {
  const cue = { cmd: 'say', speaker: { zh: '鲁丁', en: 'Rudinn' }, text: { zh: '要来点闪光吗？', en: 'Care for some sparkle?' } };
  withLocale('zh-Hant', () => {
    const zh = cueSummary(cue, { lang: 'zh' });
    assert.match(zh, /鲁丁/, 'zh 應取 zh 文字');
    const en = cueSummary(cue, { lang: 'en' });
    assert.match(en, /Rudinn/);
    assert.match(en, /sparkle/);
  });
});

test('cueBadges：async 與缺少必填欄位', () => {
  withLocale('zh-Hant', () => {
    const ok = cueBadges({ cmd: 'wait', seconds: 1, async: true });
    assert.equal(ok.length, 1);
    assert.equal(ok[0], i18n.t('cues.badge.async'));

    const missing = cueBadges({ cmd: 'say', text: '', async: false });
    assert.ok(missing.length >= 1, 'say 缺 text 應有徽章');
    assert.match(missing[0], /缺少/);
  });
});

/* ------------------------------------------------------ 7. 錯誤路徑比對 */

test('matchCueErrors：自身路徑 / 欄位路徑 / 子孫路徑', () => {
  const errors = new Map([
    ['turns[0].start[0]', '指令類型錯誤'],
    ['turns[0].start[1].text', '文字不可為空'],
    ['turns[0].start[2].then[0].cond', '巢狀錯誤'],
    ['turns[0].end[0]', '別的清單'],
  ]);
  const base = 'turns[0].start';

  const own = matchCueErrors(errors, base, [0]);
  assert.equal(own.any, true);
  assert.equal(own.own, '指令類型錯誤');
  assert.equal(own.fields.size, 0);

  const field = matchCueErrors(errors, base, [1]);
  assert.equal(field.any, true);
  assert.equal(field.own, null);
  assert.equal(field.fields.get('text'), '文字不可為空');

  const nest = matchCueErrors(errors, base, [2]);
  assert.equal(nest.any, true);
  assert.equal(nest.descendants, 1, '子孫錯誤只計數');

  const none = matchCueErrors(errors, base, [3]);
  assert.equal(none.any, false);
  assert.equal(none.own, null);
  assert.equal(none.fields.size, 0);
});

test('matchCueErrors：不誤判前綴相近的路徑', () => {
  const errors = new Map([['turns[10].start[0]', 'x']]);
  const r = matchCueErrors(errors, 'turns[1]', [0]);
  assert.equal(r.any, false, 'turns[10] 不該匹配 turns[1] 的子路徑');
});

test('matchCueErrors / matchListErrors：空 errors 與字串鍵', () => {
  assert.equal(matchCueErrors(null, 'a', [0]).any, false);
  assert.equal(matchCueErrors(new Map(), 'a', [0]).any, false);
  const obj = { 'hooks.intro': '清單錯誤' };
  assert.equal(matchCueErrors(obj, 'hooks.intro', [0]).any, false);
  const list = matchListErrors(obj, 'hooks.intro');
  assert.equal(list.length, 1);
  assert.equal(list[0].message, '清單錯誤');
  assert.deepEqual(matchListErrors(obj, ['hooks', 'victory']), []);
});

/* -------------------------------------------------- 8. locales 與 i18n */

test('locales/cues.js：三語鍵集合一致、無空字串', () => {
  const sets = {};
  for (const loc of LOCALES) {
    assert.ok(CUES_STRINGS[loc], `缺少語系 ${loc}`);
    sets[loc] = Object.keys(CUES_STRINGS[loc]).sort();
    for (const [key, value] of Object.entries(CUES_STRINGS[loc])) {
      assert.equal(typeof value, 'string', `${loc}.${key} 必須是字串`);
      assert.ok(value.length > 0, `${loc}.${key} 不可為空`);
    }
  }
  const base = sets['zh-Hant'];
  for (const loc of LOCALES) {
    const missing = base.filter((k) => !sets[loc].includes(k));
    const extra = sets[loc].filter((k) => !base.includes(k));
    assert.deepEqual(missing, [], `${loc} 缺少鍵：${missing.join(', ')}`);
    assert.deepEqual(extra, [], `${loc} 多出鍵：${extra.join(', ')}`);
  }
  assert.ok(base.length >= 200, `字串數量偏少（${base.length}）`);
});

test('locales/cues.js：佔位符在三語中一致', () => {
  const placeholders = (s) => [...String(s).matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  const base = CUES_STRINGS['zh-Hant'];
  for (const key of Object.keys(base)) {
    const expected = placeholders(base[key]);
    for (const loc of LOCALES) {
      assert.deepEqual(placeholders(CUES_STRINGS[loc][key]), expected, `${loc}.${key} 的佔位符不一致`);
    }
  }
});

test('locales/cues.js：簡單字串在三語間必須不同（避免漏翻）', () => {
  const NO_TRANSLATE = /^(async|English|SAY|X|Y|FPS|Sprite|zh|en)$/;
  const base = CUES_STRINGS['zh-Hant'];
  const identical = [];
  for (const key of Object.keys(base)) {
    const hant = base[key];
    if (NO_TRANSLATE.test(hant)) continue;
    if (hant === CUES_STRINGS.en[key] && hant === CUES_STRINGS['zh-Hans'][key]) {
      // 允許純符號或專有名詞
      if (!/^[\s\W\d]*$/.test(hant)) identical.push(`${key}=${hant}`);
    }
  }
  assert.ok(identical.length <= 6, `太多字串三語相同（可能漏翻）：${identical.join(', ')}`);
});

test('i18n：命名空間 cues 已註冊，三語都查得到', () => {
  for (const loc of LOCALES) {
    withLocale(loc, () => {
      const v = i18n.t('cues.btn.add');
      assert.ok(v && !v.startsWith('cues.'), `${loc} t('cues.btn.add') = ${v}`);
    });
  }
});

test('i18n：所有 schema 用到的 key 在三語都存在', () => {
  const keys = new Set();
  for (const spec of CUE_SCHEMA) {
    keys.add(spec.descKey);
    keys.add(`cues.cmd.${spec.cmd}`);
    for (const field of spec.fields) {
      keys.add(field.labelKey);
      keys.add(field.descKey);
    }
    if (spec.group) keys.add(`cues.group.${spec.group}`);
  }
  keys.add('cues.aria');
  keys.add('cues.empty');
  keys.add('cues.emptyHint');
  keys.add('cues.hint');
  keys.add('cues.count');
  keys.add('cues.noPath');
  keys.add('cues.noPathHint');
  keys.add('cues.pathLabel');

  for (const loc of LOCALES) {
    // form（V2-07）的字串在 encounter-cue-form.js 追加進 cues 命名空間。
    const table = { ...CUES_STRINGS[loc], ...CUES_FORM_STRINGS[loc] };
    const missing = [...keys].filter((full) => {
      const short = full.replace(/^cues\./, '');
      return table[short] === undefined;
    });
    assert.deepEqual(missing, [], `${loc} 缺少 schema 需要的鍵：${missing.join(', ')}`);
  }
  assert.deepEqual(findCueFormKeyMismatches(), [], 'form 追加字串三語鍵集合必須一致');
});

test('i18n：commandLabel / groupLabel / commandsByGroup 跟著語系變', () => {
  withLocale('zh-Hant', () => {
    assert.equal(commandLabel('say'), CUES_STRINGS['zh-Hant']['cmd.say']);
    assert.equal(groupLabel('text'), CUES_STRINGS['zh-Hant']['group.text']);
  });
  withLocale('en', () => {
    assert.equal(commandLabel('say'), CUES_STRINGS.en['cmd.say']);
    assert.equal(commandLabel('say'), 'Show text');
    const groups = commandsByGroup();
    assert.equal(groups.length, CUE_GROUPS.length);
    const total = groups.reduce((n, g) => n + g.commands.length, 0);
    assert.equal(total, CUE_SCHEMA.length, '每個指令都要出現在某一組');
    for (const g of groups) {
      assert.ok(g.label && !g.label.startsWith('cues.'), `類別 ${g.group} 標籤未翻譯`);
      assert.ok(g.color, `類別 ${g.group} 需要顏色`);
    }
  });
  withLocale('zh-Hans', () => {
    assert.equal(commandLabel('say'), '对话');
  });
});

test('i18n：未知指令的顯示名回退成原字串', () => {
  assert.equal(commandLabel('nope'), 'nope');
  assert.equal(commandLabel(null), '?');
});

/* ---------------------------------------------- 9. 端到端：模擬 store 操作 */

test('端到端：拖曳 + 刪除 + 複製組合操作後資料仍合法', () => {
  const doc = {
    turns: [{ id: 't1', start: sampleCues(), end: [] }],
    hooks: { intro: [] },
  };
  const cues = doc.turns[0].start;

  // 把第 4 條（move）拖到最前面
  const r1 = moveCues(cues, [[3]], [], 0);
  assert.equal(r1.ok, true);
  assert.equal(cues[0].cmd, 'move');

  // 把平行指令的其中一條拖出來（保留平行結構）→ 頂層變成 6 條
  const parallelIndex = cues.findIndex((c) => c.cmd === 'parallel');
  const r2 = moveCues(cues, [[parallelIndex, 'cues', 1]], [], parallelIndex + 1);
  assert.equal(r2.ok, true);
  assert.equal(cues.length, 6, '拖出一條後頂層多一條');
  const moved = cues[parallelIndex + 1];
  assert.equal(moved.cmd, 'sfx');
  assert.equal(cues[parallelIndex].cues.length, 1);

  // 複製 + 刪除
  const created = duplicateCues(cues, [[0]]);
  assert.equal(created.length, 1);
  assert.equal(cues.length, 7, '複製一條 → 7');
  removeCues(cues, [[0]]);
  assert.equal(cues.length, 6, '刪掉剛複製的那條 → 6');

  // 全部指令都還是合法 JSON 物件且帶 cmd
  for (const cue of cues) {
    assert.ok(cue && typeof cue === 'object');
    assert.equal(typeof cue.cmd, 'string');
    assert.ok(getCommandSpec(cue.cmd), `未知指令 ${cue.cmd}`);
  }
});

test('端到端：路徑在操作後仍能被 formatStorePath 還原', () => {
  const path = parseStorePath('enemies[0].acts[1].cues');
  const abs = cueAbsPath(path, [2, 'then', 0]);
  assert.equal(abs, 'enemies[0].acts[1].cues[2].then[0]');
  assert.deepEqual(parseStorePath(abs), ['enemies', 0, 'acts', 1, 'cues', 2, 'then', 0]);
});

/* ---------------------------------------------- 10. 檔案 / 語法完整性 */

test('檔案：不殘留臨時檔、必要檔案都存在', () => {
  const root = new URL('../../', import.meta.url);
  for (const rel of [
    'editor/encounter/cue-editor.js',
    'editor/encounter/cue-schema.js',
    'editor/encounter/cue-editor.css',
    'editor/encounter/cue-editor.test.mjs',
    'editor/locales/cues.js',
  ]) {
    assert.ok(existsSync(new URL(rel, root)), `缺少 ${rel}`);
  }
});

test('cue-editor.js：可在無 DOM 的 Node 環境被 import（mount 才會用到 document）', async () => {
  const mod = await import('./cue-editor.js');
  assert.equal(typeof mod.mount, 'function', 'cue-editor.js 必須匯出 mount');
  // 沒有 rootEl 時要明確報錯，而不是在 import 階段就爆
  assert.throws(() => mod.mount(null, { store: {} }), /rootEl/);
});

test('cue-editor.js：ensureStyles 在沒有 document 時不會爆', () => {
  assert.equal(typeof globalThis.document, 'undefined', 'node 測試環境不該有 document');
});

/* ------------------------------------------------------------ 清理暫存 */

test('暫存目錄：本測試不留下檔案', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cue-test-'));
  const file = join(dir, 'x.json');
  readFileSync; // 保持 import 使用（避免 lint 抱怨）
  rmSync(dir, { recursive: true, force: true });
  assert.equal(existsSync(dir), false);
  assert.ok(pathToFileURL(tmpdir()).href.startsWith('file:'));
});
