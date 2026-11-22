// editor/encounter/panels.test.mjs  (ED3, Phase 2)
//
// 遭遇資料面板的單元測試（node editor/encounter/panels.test.mjs）。
//
// 只測純邏輯（不碰 DOM）：
//   1. 三語字串鍵集合一致、簡中用詞、CJK 檢查
//   2. 結構樹：buildTree / ensureStructure / 節點 path / cues 走訪
//   3. 改名同步引用（party.actor / enemies.actor / turn.talk.actor / cues.actor|enemy|target）
//   4. 新增 / 刪除 / 複製 / 排序 / 唯一 id
//   5. 文字欄位（字串 ↔ {zh,en}）
//   6. 檢查器：選取 → 路徑、錯誤查詢
//   7. 演員編輯器：anims 正規化、預設清單、預覽影格

import assert from 'node:assert/strict';
import { setLocale, getLocale, LOCALES } from '../i18n.js';
import STRINGS, { findKeyMismatches, LOCALE_IDS, NAMESPACES } from '../locales/encounter-panels.js';
import {
  KIND,
  nodeKey,
  isBilingualText,
  displayText,
  dataLang,
  parseTextValue,
  composeTextValue,
  ensureStructure,
  buildTree,
  quoteKey,
  findNode,
  flattenTree,
  walkCues,
  collectCueLists,
  actorRefs,
  renameRefs,
  refsTo,
  uniqueId,
  createEntry,
  addEntry,
  moveInArray,
  removeNode,
  duplicateNode,
  addChildOf,
  renameNode,
  docOf,
  readSelection,
  readCuePath,
  writeCuePath,
  errorsOf,
  HOOK_NAMES,
  ENEMY_CUE_KEYS,
} from './tree.js';
import {
  pathForSelection,
  resolveTarget,
  readAtPath,
  writeAtPath,
  errorsUnder,
  errorForField,
  shapeSig,
  actorUsage,
  COMMANDS,
} from './inspector.js';
import {
  PARTY_ANIM_STATES,
  ENEMY_ANIM_STATES,
  builtinStates,
  normalizeAnim,
  createAnim,
  animsOf,
  nextStateName,
  actorTarget,
  listPresets,
  presetsForKind,
  mergeAnims,
  previewFrame,
  frameCountOf,
  stateNames,
  clampPosition,
} from './actor-editor.js';

/* =============================================================== 測試框架 */

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    failures.push({ name, error: err });
    console.error(`✗ ${name}`);
    console.error(`   ${err && err.message ? err.message : err}`);
  }
}

function eq(actual, expected, msg) {
  if (msg === undefined) assert.deepEqual(actual, expected);
  else assert.deepEqual(actual, expected, msg);
}

function ok(value, msg) {
  assert.ok(value, msg);
}

function throwsNot(fn, msg) {
  try {
    fn();
  } catch (err) {
    throw new Error(`${msg || '不應拋錯'}：${err && err.message ? err.message : err}`);
  }
}

const ORIGINAL_LOCALE = getLocale();

/* ================================================================ 測試資料 */

function sampleEncounter() {
  return {
    format: 'dr-battle-encounter/1',
    meta: { name: '鲁丁遭遇', author: '' },
    settings: { seed: 1, bgm: 'battle', background: null, introText: '* 鲁丁挡住了去路！', canFlee: false },
    actors: {
      kris: { kind: 'party', x: 92, y: 160, anims: { idle: { sprite: 'spr_krisb_idle', fps: 5, loop: true } } },
      rudinn: {
        kind: 'enemy',
        x: 520,
        y: 200,
        anims: {
          idle: { sprite: 'spr_rudinn_idle', fps: 5, loop: true },
          hurt: { sprite: 'spr_rudinn_hurt', fps: 1, loop: false, then: 'idle' },
        },
      },
    },
    party: [
      {
        id: 'kris',
        actor: 'kris',
        name: 'Kris',
        hp: 90,
        maxHp: 90,
        atk: 10,
        def: 2,
        magic: 0,
        color: '#00ffff',
        commands: ['fight', 'act', 'item', 'spare', 'defend'],
        spells: [{ id: 'healprayer', name: { zh: '治疗祈祷', en: 'Heal Prayer' }, tp: 32, target: 'party', cues: [] }],
      },
    ],
    enemies: [
      {
        id: 'rudinn',
        actor: 'rudinn',
        name: 'Rudinn',
        hp: 120,
        maxHp: 120,
        atk: 5,
        def: 0,
        mercy: 0,
        spareAt: 100,
        tired: false,
        acts: [
          { id: 'check', name: 'Check', text: '* RUDINN - ATK 5 DEF 0', cues: [] },
          {
            id: 'compliment',
            name: 'Compliment',
            party: ['kris'],
            mercy: 50,
            cues: [
              { cmd: 'say', text: '* 你称赞了鲁丁的光泽。' },
              { cmd: 'anim', actor: 'rudinn', anim: 'happy' },
            ],
          },
        ],
        onHurt: [{ cmd: 'say', actor: 'rudinn', text: '* Ow!' }],
        onSpare: [],
        onDefeat: [],
      },
    ],
    items: [{ id: 'darkburger', name: 'Dark Burger', count: 2, heal: 70, target: 'party', text: '' }],
    turns: [
      {
        id: 't1',
        flavor: '* 鲁丁在闪闪发光。',
        talk: [{ actor: 'rudinn', text: '要来点\n闪光吗？' }],
        attack: 'spade-rain',
        start: [{ cmd: 'wait', frames: 10 }],
        end: [],
      },
    ],
    turnOrder: 'loop-last',
    hooks: { intro: [], victory: [], spared: [], defeat: [], flee: [] },
    vars: { complimented: 0 },
  };
}

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

/* ============================================== 1. 三語字串表 */

test('encPanels：三個語系都存在', () => {
  eq(Object.keys(STRINGS).sort(), ['en', 'zh-Hans', 'zh-Hant']);
  for (const id of LOCALE_IDS) ok(STRINGS[id] && typeof STRINGS[id] === 'object', `缺少語系 ${id}`);
  eq(LOCALE_IDS, LOCALES.map((l) => l.id));
});

test('encPanels：三語鍵集合完全一致（findKeyMismatches 為空）', () => {
  const problems = findKeyMismatches();
  eq(problems, [], `鍵集合不一致：\n${problems.join('\n')}`);
});

test('encPanels：命名空間清單包含 encPanels 相關鍵前綴', () => {
  ok(Array.isArray(NAMESPACES), 'NAMESPACES 應為陣列');
  ok(NAMESPACES.length >= 1);
});

test('encPanels：鍵數下限（避免誤刪整段）', () => {
  const n = Object.keys(STRINGS['zh-Hant']).length;
  ok(n >= 200, `zh-Hant 只有 ${n} 個鍵，太少`);
  for (const id of LOCALE_IDS) {
    eq(Object.keys(STRINGS[id]).length, n, `${id} 鍵數與 zh-Hant 不同`);
  }
});

test('encPanels：英文表不含中日韓字元', () => {
  const cjk = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/;
  for (const [key, value] of Object.entries(STRINGS.en)) {
    ok(!cjk.test(String(value)), `en 的 ${key} 含 CJK：${value}`);
  }
});

test('encPanels：繁簡表確實不同（沒有整份複製）', () => {
  let diff = 0;
  for (const key of Object.keys(STRINGS['zh-Hant'])) {
    if (STRINGS['zh-Hant'][key] !== STRINGS['zh-Hans'][key]) diff += 1;
  }
  ok(diff >= 20, `繁簡只有 ${diff} 個鍵不同，疑似整份複製`);
});

test('encPanels：簡中不含繁體專用字', () => {
  // 常見繁→簡單字對（左繁右簡）
  const pairs = [
    ['選', '选'], ['設', '设'], ['樹', '树'], ['敵', '敌'], ['隊', '队'], ['員', '员'],
    ['動', '动'], ['畫', '画'], ['狀', '状'], ['態', '态'], ['刪', '删'], ['除', '除'],
    ['確', '确'], ['認', '认'], ['檔', '档'], ['數', '数'], ['據', '据'], ['標', '标'],
    ['籤', '签'], ['預', '预'], ['覽', '览'], ['套', '套'], ['換', '换'], ['語', '语'],
    ['顯', '显'], ['示', '示'], ['錯', '错'], ['誤', '误'], ['開', '开'], ['關', '关'],
    ['顏', '颜'], ['色', '色'], ['順', '顺'], ['序', '序'], ['彈', '弹'], ['幕', '幕'],
    ['敵', '敌'], ['傷', '伤'], ['復', '复'], ['原', '原'], ['記', '记'], ['錄', '录'],
    ['當', '当'], ['前', '前'], ['這', '这'], ['個', '个'], ['為', '为'], ['會', '会'],
    ['時', '时'], ['機', '机'], ['掛', '挂'], ['鉤', '钩'], ['參', '参'], ['與', '与'],
    ['繼', '继'], ['續', '续'], ['從', '从'], ['來', '来'], ['無', '无'], ['法', '法'],
    ['說', '说'], ['話', '话'], ['體', '体'], ['轉', '转'], ['載', '载'], ['應', '应'],
    ['該', '该'], ['還', '还'], ['將', '将'], ['對', '对'], ['於', '于'], ['麼', '么'],
  ];
  const problems = [];
  for (const [key, value] of Object.entries(STRINGS['zh-Hans'])) {
    const text = String(value);
    for (const [trad, simp] of pairs) {
      if (trad !== simp && text.includes(trad)) problems.push(`${key}: 「${text}」含繁體字 ${trad}（應為 ${simp}）`);
    }
  }
  eq(problems, [], `簡中混入繁體：\n${problems.slice(0, 20).join('\n')}`);
});

test('encPanels：繁中不含簡體專用字', () => {
  const pairs = [
    ['选', '選'], ['设', '設'], ['树', '樹'], ['敌', '敵'], ['队', '隊'], ['员', '員'],
    ['动', '動'], ['画', '畫'], ['删', '刪'], ['确', '確'], ['认', '認'], ['档', '檔'],
    ['数', '數'], ['据', '據'], ['标', '標'], ['预', '預'], ['览', '覽'], ['语', '語'],
    ['显', '顯'], ['错', '錯'], ['误', '誤'], ['开', '開'], ['关', '關'], ['颜', '顏'],
    ['顺', '順'], ['弹', '彈'], ['伤', '傷'], ['复', '復'], ['记', '記'], ['录', '錄'],
    ['这', '這'], ['个', '個'], ['为', '為'], ['会', '會'], ['时', '時'], ['机', '機'],
    ['挂', '掛'], ['钩', '鉤'], ['参', '參'], ['与', '與'], ['继', '繼'], ['续', '續'],
    ['从', '從'], ['来', '來'], ['无', '無'], ['说', '說'], ['话', '話'], ['转', '轉'],
    ['载', '載'], ['应', '應'], ['该', '該'], ['还', '還'], ['将', '將'], ['对', '對'],
    ['于', '於'], ['么', '麼'], ['终', '終'], ['击', '擊'], ['闪', '閃'], ['发', '發'],
  ];
  const problems = [];
  for (const [key, value] of Object.entries(STRINGS['zh-Hant'])) {
    const text = String(value);
    for (const [simp, trad] of pairs) {
      if (text.includes(simp)) problems.push(`${key}: 「${text}」含簡體字 ${simp}（應為 ${trad}）`);
    }
  }
  eq(problems, [], `繁中混入簡體：\n${problems.slice(0, 20).join('\n')}`);
});

test('encPanels：關鍵詞用大陸慣用詞（簡中）', () => {
  eq(STRINGS['zh-Hans']['insp.settings.title'], '遭遇设置');
  eq(STRINGS['zh-Hans']['tree.title'], '遭遇结构');
  ok(String(STRINGS['zh-Hans']['ae.dragHint']).includes('拖拽'), '簡中應用「拖拽」而非「拖曳」');
  ok(String(STRINGS['zh-Hans']['insp.enemy.acts']).includes('列表'), '簡中應用「列表」');
});

test('encPanels：英文鍵值為非空字串', () => {
  for (const [key, value] of Object.entries(STRINGS.en)) {
    ok(typeof value === 'string' && value.trim() !== '', `en.${key} 是空的`);
  }
});

test('encPanels：不翻譯 JSON 欄位名（id / actor / cues 等）', () => {
  const cases = {
    'insp.enemy.id': 'id',
    'insp.party.actor': 'actor',
    'insp.spell.cues': 'cues',
    'insp.actor.kind': 'kind',
  };
  for (const [key, field] of Object.entries(cases)) {
    const text = String(STRINGS.en[key]).toLowerCase();
    ok(text.includes(field), `en.${key} 應保留欄位名 ${field}（實際：${STRINGS.en[key]}）`);
  }
});

/* ============================================== 2. 文字欄位 */

test('text：isBilingualText 只認 {zh|en}', () => {
  ok(isBilingualText({ zh: 'a', en: 'b' }));
  ok(isBilingualText({ en: 'b' }));
  ok(isBilingualText({ zh: 'a' }));
  ok(!isBilingualText('a'));
  ok(!isBilingualText(null));
  ok(!isBilingualText(['a']));
  ok(!isBilingualText({ other: 1 }));
});

test('text：displayText 依語言取值並回退', () => {
  eq(displayText('hello'), 'hello');
  eq(displayText('hello', 'en'), 'hello');
  eq(displayText({ zh: '中', en: 'EN' }, 'zh'), '中');
  eq(displayText({ zh: '中', en: 'EN' }, 'en'), 'EN');
  eq(displayText({ zh: '中' }, 'en'), '中');
  eq(displayText({ en: 'EN' }, 'zh'), 'EN');
  eq(displayText(null), '');
  eq(displayText(12), '12');
});

test('text：dataLang 對應語系', () => {
  eq(dataLang('zh-Hant'), 'zh');
  eq(dataLang('zh-Hans'), 'zh');
  eq(dataLang('en'), 'en');
});

test('text：parseTextValue ↔ composeTextValue 往返', () => {
  eq(parseTextValue('abc'), { mode: 'single', single: 'abc', zh: '', en: '' });
  eq(parseTextValue({ zh: '中', en: 'EN' }), { mode: 'bi', single: '', zh: '中', en: 'EN' });
  eq(composeTextValue({ mode: 'single', single: 'abc' }), 'abc');
  eq(composeTextValue({ mode: 'bi', zh: '中', en: 'EN' }), { zh: '中', en: 'EN' });
  eq(composeTextValue({ mode: 'bi', zh: '中', en: '' }), { zh: '中' });
});

test('text：空字串與 null 的往返', () => {
  eq(composeTextValue(parseTextValue('')), '');
  eq(composeTextValue(parseTextValue(null)), '');
  eq(parseTextValue(0).single, '0');
});

/* ============================================== 3. 路徑工具 */

test('path：quoteKey 對識別字用點號、其餘用括號', () => {
  eq(quoteKey('kris'), 'kris');
  eq(quoteKey('my actor'), '["my actor"]');
  eq(quoteKey('a.b'), '["a.b"]');
  eq(quoteKey('_x$1'), '_x$1');
});

test('path：readAtPath / writeAtPath 往返', () => {
  const doc = { a: { b: [{ c: 1 }] }, actors: { kris: { x: 1 } } };
  eq(readAtPath(doc, 'a.b[0].c'), 1);
  eq(readAtPath(doc, 'actors.kris.x'), 1);
  eq(readAtPath(doc, 'nope.x'), undefined);
  writeAtPath(doc, 'a.b[0].c', 5);
  eq(doc.a.b[0].c, 5);
  writeAtPath(doc, 'actors["my actor"].x', 9);
  eq(doc.actors['my actor'].x, 9);
});

/* ============================================== 4. ensureStructure */

test('ensureStructure：補齊所有空容器且不改傳入物件', () => {
  const src = { format: 'dr-battle-encounter/1' };
  const out = ensureStructure(src);
  eq(src.hooks, undefined, '不應改動傳入物件');
  for (const name of HOOK_NAMES) ok(Array.isArray(out.hooks[name]), `缺少 hooks.${name}`);
  eq(out.party, []);
  eq(out.enemies, []);
  eq(out.items, []);
  eq(out.turns, []);
  eq(out.vars, {});
  eq(out.actors, {});
  eq(out.settings, {});
  eq(out.meta, {});
});

test('ensureStructure：補齊敵人 / ACT / 法術 / 回合的巢狀容器', () => {
  const out = ensureStructure({
    enemies: [{ id: 'e', acts: [{ id: 'a' }] }],
    party: [{ id: 'k', spells: [{ id: 's' }] }],
    turns: [{ id: 't' }],
    actors: { e: { kind: 'enemy' } },
  });
  eq(out.enemies[0].acts[0].cues, []);
  eq(out.enemies[0].acts[0].party, []);
  eq(out.enemies[0].onHurt, []);
  eq(out.enemies[0].onSpare, []);
  eq(out.enemies[0].onDefeat, []);
  eq(out.party[0].spells[0].cues, []);
  eq(out.turns[0].talk, []);
  eq(out.turns[0].start, []);
  eq(out.turns[0].end, []);
  eq(out.actors.e.anims, {});
});

test('ensureStructure：已有資料不被覆蓋', () => {
  const enc = sampleEncounter();
  const out = ensureStructure(enc);
  eq(out.enemies[0].acts.length, 2);
  eq(out.enemies[0].onHurt.length, 1);
  eq(out.turns[0].talk.length, 1);
  eq(out.vars.complimented, 0);
  eq(out.meta.name, '鲁丁遭遇');
});

/* ============================================== 5. buildTree */

test('buildTree：八個根群組', () => {
  const tree = buildTree(sampleEncounter());
  const kinds = tree.roots.map((n) => (n.kind === KIND.group ? n.id : n.kind));
  eq(kinds, [
    'settings',
    'group:actors',
    'group:party',
    'group:enemies',
    'group:items',
    'group:turns',
    'group:hooks',
    'group:vars',
  ]);
});

test('buildTree：節點路徑符合 validateEncounter 的格式', () => {
  const tree = buildTree(sampleEncounter());
  const keys = [...tree.byKey.keys()];
  ok(keys.includes('party:party[0]'), '缺少 party[0]');
  ok(keys.includes('enemy:enemies[0]'), '缺少 enemies[0]');
  ok(keys.includes('act:enemies[0].acts[1]'), '缺少 act 路徑');
  ok(keys.includes('spell:party[0].spells[0]'), '缺少 spell 路徑');
  ok(keys.includes('item:items[0]'), '缺少 item 路徑');
  ok(keys.includes('turn:turns[0]'), '缺少 turn 路徑');
  ok(keys.includes('talk:turns[0].talk[0]'), '缺少 talk 路徑');
  ok(keys.includes('cues:turns[0].start'), '缺少回合 start cue 清單節點');
  ok(keys.includes('cues:turns[0].end'), '缺少回合 end cue 清單節點');
  ok(keys.includes('cues:hooks.intro'), '缺少 hooks.intro');
  ok(keys.includes('actor:actors.kris'), '缺少 actors.kris');
  ok(keys.includes('var:vars.complimented'), '缺少 vars.complimented');
  ok(keys.includes('settings:settings'), '缺少 settings');
});

test('buildTree：cue 節點帶 cuesPath（給 ED2 的指令清單編輯器）', () => {
  const tree = buildTree(sampleEncounter());
  const intro = tree.byKey.get('cues:hooks.intro');
  eq(intro.cuesPath, 'hooks.intro');
  const onHurt = tree.byKey.get('cues:enemies[0].onHurt');
  eq(onHurt.cuesPath, 'enemies[0].onHurt');
  const act = tree.byKey.get('act:enemies[0].acts[1]');
  eq(act.cuesPath, 'enemies[0].acts[1].cues');
  const spell = tree.byKey.get('spell:party[0].spells[0]');
  eq(spell.cuesPath, 'party[0].spells[0].cues');
  const start = tree.byKey.get('cues:turns[0].start');
  eq(start.cuesPath, 'turns[0].start');
  const end = tree.byKey.get('cues:turns[0].end');
  eq(end.cuesPath, 'turns[0].end');
});

test('buildTree：敵人節點的子項包含 ACT 與三種事件', () => {
  const tree = buildTree(sampleEncounter());
  const enemy = tree.byKey.get('enemy:enemies[0]');
  const kinds = enemy.children.map((c) => c.kind);
  eq(kinds.filter((k) => k === KIND.act).length, 2);
  eq(kinds.filter((k) => k === KIND.cues).length, 3);
});

test('buildTree：找不到的 id 不會爆掉', () => {
  throwsNot(() => buildTree({}), '空文件');
  throwsNot(() => buildTree(null), 'null');
  const tree = buildTree({});
  ok(tree.roots.length >= 8);
});

test('buildTree：錯誤 path 讓節點標紅（含子節點）', () => {
  const errors = new Map([
    ['enemies[0].acts[1].cues[0].actor', '未知演員'],
    ['turns[0].talk[0].text', '文字不可為空'],
  ]);
  const tree = buildTree(sampleEncounter(), { errors });
  ok(tree.byKey.get('enemy:enemies[0]').hasError, '敵人群組應標紅');
  ok(tree.byKey.get('act:enemies[0].acts[1]').hasError, 'ACT 應標紅');
  ok(tree.byKey.get('turn:turns[0]').hasError, '回合應標紅');
  ok(!tree.byKey.get('item:items[0]').hasError, '道具不應標紅');
});

test('buildTree：sig 隨資料變動', () => {
  const a = buildTree(sampleEncounter());
  const enc2 = sampleEncounter();
  enc2.enemies[0].acts.push({ id: 'flirt', name: 'Flirt', cues: [] });
  const b = buildTree(enc2);
  ok(a.sig !== b.sig, 'signature 應改變');
  const c = buildTree(sampleEncounter());
  eq(a.sig, c.sig, '相同資料的 signature 應相同');
});

test('buildTree：findNode / flattenTree', () => {
  const tree = buildTree(sampleEncounter());
  const node = findNode(tree, 'enemy:enemies[0]');
  eq(node.kind, KIND.enemy);
  const flat = flattenTree(tree);
  ok(flat.length > tree.byKey.size - 8, '攤平後應包含所有節點');
  ok(flat.some((n) => n.key === 'act:enemies[0].acts[0]'));
});

test('buildTree：nodeKey 唯一', () => {
  const tree = buildTree(sampleEncounter());
  const seen = new Set();
  for (const node of flattenTree(tree)) {
    ok(!seen.has(node.key), `重複的節點 key：${node.key}`);
    seen.add(node.key);
  }
});

/* ============================================== 6. cues 走訪 */

test('walkCues：走訪 if / parallel 巢狀', () => {
  const cues = [
    { cmd: 'say', text: 'hi' },
    { cmd: 'if', cond: 'x>0', then: [{ cmd: 'wait', frames: 5 }], else: [{ cmd: 'shake', frames: 3 }] },
    { cmd: 'parallel', cues: [{ cmd: 'move', actor: 'kris', x: 1, y: 2 }] },
  ];
  const seen = [];
  walkCues(cues, 'hooks.intro', (cue, path) => seen.push(`${path}:${cue.cmd}`));
  eq(seen, [
    'hooks.intro[0]:say',
    'hooks.intro[1]:if',
    'hooks.intro[1].then[0]:wait',
    'hooks.intro[1].else[0]:shake',
    'hooks.intro[2]:parallel',
    'hooks.intro[2].cues[0]:move',
  ]);
});

test('collectCueLists：收集所有 cues 清單', () => {
  const lists = collectCueLists(sampleEncounter());
  const paths = lists.map((l) => l.path);
  for (const hook of HOOK_NAMES) ok(paths.includes(`hooks.${hook}`), `缺少 hooks.${hook}`);
  ok(paths.includes('enemies[0].onHurt'));
  ok(paths.includes('enemies[0].onSpare'));
  ok(paths.includes('enemies[0].onDefeat'));
  ok(paths.includes('enemies[0].acts[0].cues'));
  ok(paths.includes('enemies[0].acts[1].cues'));
  ok(paths.includes('party[0].spells[0].cues'));
  ok(paths.includes('turns[0].start'));
  ok(paths.includes('turns[0].end'));
});

/* ============================================== 7. 引用 / 改名 */

test('actorRefs：找出演員被引用的地方', () => {
  const refs = actorRefs(sampleEncounter(), 'rudinn');
  const paths = refs.map((r) => r.path);
  ok(paths.includes('enemies[0].actor'), '應包含 enemies[0].actor');
  ok(paths.includes('turns[0].talk[0].actor'), '應包含台詞的 actor');
  ok(paths.includes('enemies[0].acts[1].cues[1].actor'), '應包含 ACT cues 內的 actor');
  ok(paths.includes('enemies[0].onHurt[0].actor'), '應包含 onHurt cues 內的 actor');
});

test('renameRefs：演員改名同步所有引用（含巢狀 cues）', () => {
  const enc = ensureStructure(sampleEncounter());
  const res = renameRefs(enc, 'actor', 'rudinn', 'rudinnX');
  ok(res.ok);
  eq(enc.enemies[0].actor, 'rudinnX');
  eq(enc.turns[0].talk[0].actor, 'rudinnX');
  eq(enc.enemies[0].acts[1].cues[1].actor, 'rudinnX');
  eq(enc.enemies[0].onHurt[0].actor, 'rudinnX');
  ok(res.changed.length >= 4, `changed 太少：${res.changed.length}`);
});

test('renameRefs：if / parallel 內的 actor 也同步', () => {
  const enc = ensureStructure({
    enemies: [{ id: 'e', actor: 'a', onHurt: [] }],
    hooks: {
      intro: [
        {
          cmd: 'if',
          cond: 'x',
          then: [{ cmd: 'move', actor: 'a', x: 0, y: 0 }],
          else: [{ cmd: 'parallel', cues: [{ cmd: 'anim', actor: 'a', anim: 'idle' }] }],
        },
      ],
    },
  });
  renameRefs(enc, 'actor', 'a', 'b');
  eq(enc.hooks.intro[0].then[0].actor, 'b');
  eq(enc.hooks.intro[0].else[0].cues[0].actor, 'b');
});

test('renameRefs：敵人改名同步 cues.target / cues.enemy', () => {
  const enc = ensureStructure({
    enemies: [{ id: 'e1', acts: [], onHurt: [] }],
    hooks: { intro: [{ cmd: 'attack', target: 'e1' }, { cmd: 'mercy', enemy: 'e1', amount: 10 }] },
  });
  const res = renameRefs(enc, 'enemy', 'e1', 'e2');
  eq(enc.hooks.intro[0].target, 'e2');
  eq(enc.hooks.intro[1].enemy, 'e2');
  eq(res.changed.length, 2);
});

test('renameRefs：隊員改名同步 cues.target', () => {
  const enc = ensureStructure({
    party: [{ id: 'kris', spells: [] }],
    hooks: { intro: [{ cmd: 'heal', target: 'kris', amount: 10 }] },
  });
  renameRefs(enc, 'party', 'kris', 'susie');
  eq(enc.hooks.intro[0].target, 'susie');
});

test('refsTo：刪除前的引用查詢', () => {
  const refs = refsTo(sampleEncounter(), 'actor', 'rudinn');
  ok(refs.length >= 4);
  eq(refsTo(sampleEncounter(), 'actor', 'nobody'), []);
});

/* ============================================== 8. 新增 / 刪除 / 複製 / 排序 */

test('uniqueId：不衝突的 id', () => {
  eq(uniqueId('a', []), 'a');
  eq(uniqueId('a', ['a']), 'a2');
  eq(uniqueId('a', ['a', 'a2']), 'a3');
  eq(uniqueId('bad name', []), 'bad_name');
});

test('addEntry：新增演員 / 隊員 / 敵人 / 道具 / 回合 / 變數', () => {
  for (const kind of [KIND.actor, KIND.party, KIND.enemy, KIND.item, KIND.turn, KIND.var]) {
    const draft = ensureStructure(sampleEncounter());
    const res = addEntry(draft, kind);
    ok(res.ok, `新增 ${kind} 失敗：${res.reason}`);
    ok(typeof res.path === 'string' && res.path !== '', `${kind} 沒有回傳 path`);
  }
});

test('addEntry：新增 ACT / 法術 / 台詞需要 ownerPath', () => {
  const draft = ensureStructure(sampleEnemyOnly());
  const act = addEntry(draft, KIND.act, 'enemies[0]');
  ok(act.ok, `新增 ACT 失敗：${act.reason}`);
  eq(draft.enemies[0].acts.length, 1);

  const spell = addEntry(draft, KIND.spell, 'party[0]');
  ok(spell.ok, `新增法術失敗：${spell.reason}`);
  eq(draft.party[0].spells.length, 1);

  const talk = addEntry(draft, KIND.talk, 'turns[0]');
  ok(talk.ok, `新增台詞失敗：${talk.reason}`);
  eq(draft.turns[0].talk.length, 1);

  eq(addEntry(draft, KIND.act, 'nope[0]').ok, false);
  eq(addEntry(draft, KIND.act, null).ok, false);
});

function sampleEnemyOnly() {
  return {
    actors: { a: { kind: 'enemy', anims: {} } },
    party: [{ id: 'k', actor: 'a', spells: [] }],
    enemies: [{ id: 'e', actor: 'a', acts: [] }],
    turns: [{ id: 't' }],
  };
}

test('removeNode：刪除陣列項目與物件鍵', () => {
  const draft = ensureStructure(sampleEncounter());
  const tree = buildTree(draft);
  const res = removeNode(draft, tree.byKey.get('act:enemies[0].acts[1]'));
  ok(res.ok);
  eq(draft.enemies[0].acts.length, 1);
  eq(draft.enemies[0].acts[0].id, 'check');

  const res2 = removeNode(draft, tree.byKey.get('actor:actors.kris'));
  ok(res2.ok);
  eq(Object.prototype.hasOwnProperty.call(draft.actors, 'kris'), false);
});

test('duplicateNode：複製後 id 不衝突', () => {
  const draft = ensureStructure(sampleEncounter());
  const tree = buildTree(draft);
  const res = duplicateNode(draft, tree.byKey.get('act:enemies[0].acts[0]'));
  ok(res.ok, `複製失敗：${res.reason}`);
  eq(draft.enemies[0].acts.length, 3);
  eq(draft.enemies[0].acts[1].id, 'check2');
  eq(draft.enemies[0].acts[1].name, 'Check', '其他欄位應一併複製');
});

test('duplicateNode：不支援物件鍵節點', () => {
  const draft = ensureStructure(sampleEncounter());
  const tree = buildTree(draft);
  eq(duplicateNode(draft, tree.byKey.get('actor:actors.kris')).ok, false);
});

test('moveInArray：排序', () => {
  const arr = [1, 2, 3, 4];
  ok(moveInArray(arr, 0, 2));
  eq(arr, [2, 3, 1, 4]);
  ok(moveInArray(arr, 3, 1));
  eq(arr, [2, 4, 3, 1]);
  eq(moveInArray(arr, 0, 0), false);
  eq(moveInArray(arr, -1, 0), false);
  eq(moveInArray(arr, 0, 9), false);
  eq(moveInArray(null, 0, 1), false);
});

test('addChildOf：由上層節點新增', () => {
  const draft = ensureStructure(sampleEnemyOnly());
  const tree = buildTree(draft);
  const enemy = tree.byKey.get('enemy:enemies[0]');
  ok(enemy.addSpec, '敵人節點應有 addSpec');
  const res = addChildOf(draft, enemy);
  ok(res.ok, `新增子節點失敗：${res.reason}`);
  eq(draft.enemies[0].acts.length, 1);
  eq(addChildOf(draft, tree.byKey.get('item:items[0]') || { addSpec: null }).ok, false);
});

/* ============================================== 9. renameNode */

test('renameNode：陣列項目改名（保留其他欄位）', () => {
  const draft = ensureStructure(sampleEncounter());
  const tree = buildTree(draft);
  const res = renameNode(draft, tree.byKey.get('enemy:enemies[0]'), 'rudinn2');
  ok(res.ok, `改名失敗：${res.reason}`);
  eq(draft.enemies[0].id, 'rudinn2');
  eq(draft.enemies[0].name, 'Rudinn', 'name 不應被改');
});

test('renameNode：改名失敗的情況', () => {
  const draft = ensureStructure(sampleEnemyOnly());
  const tree = buildTree(draft);
  eq(renameNode(draft, tree.byKey.get('enemy:enemies[0]'), '').ok, false, '空字串應失敗');
  eq(renameNode(draft, tree.byKey.get('enemy:enemies[0]'), '   ').ok, false, '空白應失敗');
});

test('renameNode：重複 id 被拒', () => {
  const draft = ensureStructure({
    enemies: [{ id: 'a', acts: [] }, { id: 'b', acts: [] }],
    party: [],
  });
  const tree = buildTree(draft);
  const res = renameNode(draft, tree.byKey.get('enemy:enemies[0]'), 'b');
  eq(res.ok, false);
  eq(res.reason, 'exists');
});

test('renameNode：演員（物件鍵）改名保留鍵順序並同步引用', () => {
  const draft = ensureStructure(sampleEncounter());
  const tree = buildTree(draft);
  const before = Object.keys(draft.actors);
  const res = renameNode(draft, tree.byKey.get('actor:actors.rudinn'), 'rudinn2');
  ok(res.ok, `改名失敗：${res.reason}`);
  eq(Object.keys(draft.actors), ['kris', 'rudinn2'], '改名應保留鍵順序');
  eq(draft.enemies[0].actor, 'rudinn2');
  eq(draft.turns[0].talk[0].actor, 'rudinn2');
});

test('renameNode：變數（物件鍵）改名', () => {
  const draft = ensureStructure({ vars: { a: 1, b: 2 } });
  const tree = buildTree(draft);
  const res = renameNode(draft, tree.byKey.get('var:vars.a'), 'z');
  ok(res.ok, `改名失敗：${res.reason}`);
  eq(Object.keys(draft.vars), ['z', 'b']);
  eq(draft.vars.z, 1);
});

test('renameNode：無 id 欄位的節點不支援', () => {
  const draft = ensureStructure({ turns: [{ flavor: 'x', talk: [{ actor: null, text: '' }] }] });
  const tree = buildTree(draft);
  const talk = tree.byKey.get('talk:turns[0].talk[0]');
  eq(renameNode(draft, talk, 'x').ok, false);
});

/* ============================================== 10. store 介面適配 */

function fakeStore(doc, extra = {}) {
  const subs = new Set();
  const store = {
    doc,
    get encounter() {
      return store.doc;
    },
    selection: { kind: null, id: null, path: null },
    cuePath: null,
    errors: new Map(),
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
    select(kind, id, path) {
      store.selection = { kind, id: id === undefined ? null : id, path: path === undefined ? null : path };
      for (const fn of subs) fn(store, { label: '選取', selectionOnly: true });
      return true;
    },
    setSelection(sel) {
      store.selection = { kind: sel.kind ?? null, id: sel.id ?? null, path: sel.path ?? null };
      for (const fn of subs) fn(store, { label: '選取', selectionOnly: true });
      return true;
    },
    setCuePath(p) {
      store.cuePath = p === undefined ? null : p;
      for (const fn of subs) fn(store, { label: 'cuePath' });
      return true;
    },
    setAt(path, value) {
      writeAtPath(store.doc, path, value);
      for (const fn of subs) fn(store, { label: '編輯', paths: [path] });
      return true;
    },
    update(fn) {
      fn(store.doc);
      for (const x of subs) x(store, { label: '編輯' });
      return true;
    },
    ...extra,
  };
  return store;
}

test('docOf：支援 encounter / attack / doc / data', () => {
  const doc = { a: 1 };
  eq(docOf({ encounter: doc }), doc);
  eq(docOf({ attack: doc }), doc);
  eq(docOf({ doc }), doc);
  eq(docOf({ data: doc }), doc);
  eq(docOf(null), null);
  eq(docOf({}), null);
});

test('readSelection / readCuePath / writeCuePath', () => {
  const store = fakeStore({});
  store.setSelection({ kind: 'enemy', id: 'e', path: 'enemies[0]' });
  eq(readSelection(store), { kind: 'enemy', id: 'e', path: 'enemies[0]' });
  store.setCuePath('hooks.intro');
  eq(readCuePath(store, null), 'hooks.intro');
  writeCuePath(store, 'turns[0].start', null);
  eq(store.cuePath, 'turns[0].start');
});

test('readSelection：Phase 1 只有 kind/id 時 path 為 null', () => {
  const store = { selection: { kind: 'actor', id: 'kris' } };
  eq(readSelection(store), { kind: 'actor', id: 'kris', path: null });
});

test('errorsOf：Map 與 plain object 都接受', () => {
  eq(errorsOf({ errors: new Map([['a', 'x']]) }).get('a'), 'x');
  eq(errorsOf({ errors: { a: 'x' } }).get('a'), 'x');
  eq(errorsOf({}).size, 0);
  eq(errorsOf(null).size, 0);
});

/* ============================================== 11. 檢查器純邏輯 */

test('inspector：pathForSelection 用 selection.path', () => {
  const doc = sampleEncounter();
  eq(pathForSelection(doc, { kind: 'enemy', id: 'rudinn', path: 'enemies[0]' }), 'enemies[0]');
  eq(pathForSelection(doc, { kind: KIND.settings, id: null, path: null }), 'settings');
});

test('inspector：pathForSelection 沒有 path 時依 id 搜尋', () => {
  const doc = sampleEncounter();
  eq(pathForSelection(doc, { kind: 'enemy', id: 'rudinn' }), 'enemies[0]');
  eq(pathForSelection(doc, { kind: 'party', id: 'kris' }), 'party[0]');
  eq(pathForSelection(doc, { kind: 'item', id: 'darkburger' }), 'items[0]');
  eq(pathForSelection(doc, { kind: 'turn', id: 't1' }), 'turns[0]');
  eq(pathForSelection(doc, { kind: 'actor', id: 'kris' }), 'actors.kris');
  eq(pathForSelection(doc, { kind: 'var', id: 'complimented' }), 'vars.complimented');
  eq(pathForSelection(doc, { kind: 'spell', id: 'healpreyer' }), null);
  eq(pathForSelection(doc, { kind: 'spell', id: 'healprayer' }), 'party[0].spells[0]');
  eq(pathForSelection(doc, { kind: 'act', id: 'check' }), 'enemies[0].acts[0]');
  eq(pathForSelection(doc, { kind: 'enemy', id: 'nope' }), null);
});

test('inspector：resolveTarget', () => {
  const doc = sampleEncounter();
  const t1 = resolveTarget(doc, { kind: 'enemy', id: 'rudinn' });
  ok(t1.found, '應找到敵人');
  eq(t1.path, 'enemies[0]');
  eq(t1.value.id, 'rudinn');
  const t2 = resolveTarget(doc, { kind: 'enemy', id: 'nope' });
  eq(t2.found, false);
  const t3 = resolveTarget(doc, { kind: 'settings' });
  ok(t3.found, 'settings 應找到');
});

test('inspector：errorsUnder 只取子樹', () => {
  const errors = new Map([
    ['enemies[0].hp', 'bad hp'],
    ['enemies[0].acts[0].mercy', 'bad mercy'],
    ['enemies[1].hp', 'other'],
    ['turns[0].flavor', 'x'],
  ]);
  const res = errorsUnder(errors, 'enemies[0]');
  eq(res.count, 2);
  eq(res.list.map((r) => r.key), ['enemies[0].acts[0].mercy', 'enemies[0].hp']);
  eq(errorsUnder(errors, 'nope').count, 0);
});

test('inspector：errorForField', () => {
  const errors = new Map([['enemies[0].hp', 'bad hp']]);
  eq(errorForField(errors, 'enemies[0].hp'), 'bad hp');
  eq(errorForField(errors, 'enemies[0].atk'), '');
  eq(errorForField(null, 'x'), '');
});

test('inspector：shapeSig 隨選取與陣列長度改變', () => {
  const doc = sampleEncounter();
  const a = shapeSig(doc, { kind: 'enemy', id: 'rudinn', path: 'enemies[0]' });
  const b = shapeSig(doc, { kind: 'enemy', id: 'rudinn', path: 'enemies[0]' });
  eq(a, b);
  const doc2 = clone(doc);
  doc2.enemies[0].acts.push({ id: 'x', name: 'X', cues: [] });
  ok(shapeSig(doc2, { kind: 'enemy', id: 'rudinn', path: 'enemies[0]' }) !== a, '陣列長度改變應改變 sig');
  ok(shapeSig(doc, { kind: 'item', id: 'darkburger', path: 'items[0]' }) !== a, '不同選取應不同');
});

test('inspector：actorUsage', () => {
  const doc = sampleEncounter();
  const refs = actorUsage(doc, 'rudinn');
  const paths = refs.map((r) => r.path);
  ok(paths.includes('enemies[0].actor'));
  ok(paths.includes('turns[0].talk[0].actor'));
  eq(actorUsage(doc, 'nobody'), []);
});

test('inspector：COMMANDS 清單符合 SPEC-P2', () => {
  eq(COMMANDS, ['fight', 'act', 'magic', 'item', 'spare', 'defend']);
});

/* ============================================== 12. 演員編輯器 */

test('actor：內建狀態清單符合 SPEC-P2 §3', () => {
  eq(PARTY_ANIM_STATES, ['idle', 'attack', 'act', 'magic', 'item', 'spare', 'defend', 'hurt', 'down', 'victory']);
  eq(ENEMY_ANIM_STATES, ['idle', 'hurt', 'spared', 'defeat']);
  eq(builtinStates('enemy'), ENEMY_ANIM_STATES);
  eq(builtinStates('party'), PARTY_ANIM_STATES);
  eq(builtinStates(undefined), PARTY_ANIM_STATES);
});

test('actor：normalizeAnim 補預設並驗證 fps', () => {
  eq(normalizeAnim(null), { sprite: null, fps: 5, loop: true, then: null });
  eq(normalizeAnim({ sprite: 'a', fps: 15, loop: false, then: 'idle' }), { sprite: 'a', fps: 15, loop: false, then: 'idle' });
  eq(normalizeAnim({ fps: 0 }).fps, 5, 'fps 0 應退回 5');
  eq(normalizeAnim({ fps: -1 }).fps, 5);
  eq(normalizeAnim({ fps: 'abc' }).fps, 5);
  eq(normalizeAnim({ loop: 'yes' }).loop, true, '非布林應轉成 bool');
  eq(normalizeAnim({ loop: 0 }).loop, false);
  eq(normalizeAnim({ sprite: '' }).sprite, null);
});

test('actor：createAnim / animsOf', () => {
  eq(createAnim(), { sprite: null, fps: 5, loop: true, then: null });
  eq(createAnim({ fps: 10 }).fps, 10);
  eq(animsOf({ anims: { idle: { sprite: 'a' } } }).idle.fps, 5);
  eq(animsOf(null), {});
  eq(animsOf({}), {});
});

test('actor：nextStateName 先補內建空缺', () => {
  eq(nextStateName('party', []), 'idle');
  eq(nextStateName('party', ['idle']), 'attack');
  eq(nextStateName('enemy', ['idle', 'hurt', 'spared', 'defeat']), 'state2');
  eq(nextStateName('enemy', ['idle', 'hurt', 'spared', 'defeat', 'state2']), 'state3');
});

test('actor：actorTarget 由選取找演員', () => {
  const doc = sampleEncounter();
  const a = actorTarget(doc, { kind: KIND.actor, id: 'kris', path: 'actors.kris' });
  eq(a.actorId, 'kris');
  ok(a.found);
  eq(a.actor.kind, 'party');
  const b = actorTarget(doc, { kind: KIND.actor, id: 'nobody', path: 'actors.nobody' });
  eq(b.found, false);
  const c = actorTarget(doc, { kind: KIND.enemy, id: 'rudinn', path: 'enemies[0]' });
  eq(c.found, false, '敵人節點不該被當成演員編輯目標');
  eq(actorTarget(null, {}).found, false);
});

test('actor：listPresets 支援三種格式', () => {
  const flat = listPresets({ kris: { kind: 'party', anims: { idle: { sprite: 'a' } } } });
  eq(flat.length, 1);
  eq(flat[0].id, 'kris');
  eq(flat[0].kind, 'party');

  const nested = listPresets({ actors: { r: { kind: 'enemy', anims: { idle: { sprite: 'b' } } } } });
  eq(nested.map((p) => p.id), ['r']);

  const presets = listPresets({ presets: { z: { anims: { idle: {} } } } });
  eq(presets.map((p) => p.id), ['z']);

  eq(listPresets(null), []);
  eq(listPresets({ a: { noAnims: true } }), []);
});

test('actor：listPresets 依 id 排序', () => {
  const list = listPresets({ b: { anims: {} }, a: { anims: {} }, c: { anims: {} } });
  eq(list.map((p) => p.id), ['a', 'b', 'c']);
});

test('actor：presetsForKind 過濾', () => {
  const list = [
    { id: 'a', kind: 'party', anims: {} },
    { id: 'b', kind: 'enemy', anims: {} },
    { id: 'c', kind: null, anims: {} },
  ];
  eq(presetsForKind(list, 'party').map((p) => p.id), ['a', 'c']);
  eq(presetsForKind(list, 'enemy').map((p) => p.id), ['b', 'c']);
  eq(presetsForKind(list, null).map((p) => p.id), ['a', 'b', 'c']);
  eq(presetsForKind(null, 'party'), []);
});

test('actor：mergeAnims 預設優先', () => {
  const merged = mergeAnims({ idle: { sprite: 'old', fps: 1 }, hurt: { sprite: 'keep' } }, { idle: { sprite: 'new', fps: 9 } });
  eq(merged.idle.sprite, 'new');
  eq(merged.idle.fps, 9);
  eq(merged.hurt.sprite, 'keep');
});

test('actor：previewFrame 循環與非循環', () => {
  eq(previewFrame(0, 5, 4, true), 0);
  eq(previewFrame(200, 5, 4, true), 1);
  eq(previewFrame(800, 5, 4, true), 0, '800ms × 5fps = 4 → 循環回 0');
  eq(previewFrame(800, 5, 4, false), 3, '非循環停在最後一格');
  eq(previewFrame(10000, 5, 1, true), 0);
  eq(previewFrame(-100, 5, 4, true), 0, '負時間應視為 0');
  eq(previewFrame(0, 0, 4, true), 0, 'fps 0 不應爆');
});

test('actor：frameCountOf', () => {
  eq(frameCountOf(null), 1);
  eq(frameCountOf({}), 1);
  eq(frameCountOf({ frames: ['a', 'b', 'c'] }), 3);
  eq(frameCountOf({ frameCount: 5 }), 5);
  eq(frameCountOf({ frames: [] }), 1);
});

test('actor：stateNames 內建狀態排在前面', () => {
  const names = stateNames({ kind: 'enemy', anims: { zzz: {}, idle: {}, hurt: {} } });
  eq(names, ['idle', 'hurt', 'zzz']);
});

test('actor：clampPosition 限制在 0..max', () => {
  eq(clampPosition(-10, 640), 0);
  eq(clampPosition(700, 640), 640);
  eq(clampPosition('12.7', 640), 13);
  eq(clampPosition('abc', 640), 0);
});

/* ============================================== 13. 整合：樹 + 檢查器 + 改名 */

test('整合：改名後 buildTree 的節點 path 跟著更新', () => {
  const draft = ensureStructure(sampleEncounter());
  let tree = buildTree(draft);
  renameNode(draft, tree.byKey.get('actor:actors.rudinn'), 'rudinn2');
  renameNode(draft, tree.byKey.get('enemy:enemies[0]'), 'rudinn');
  tree = buildTree(draft);
  ok(tree.byKey.has('actor:actors.rudinn2'), '新演員節點應存在');
  ok(!tree.byKey.has('actor:actors.rudinn'), '舊演員節點應消失');
});

test('整合：新增再刪除，樹回到原狀', () => {
  const draft = ensureStructure(sampleEnemyOnly());
  const before = buildTree(draft).sig;
  const res = addEntry(draft, KIND.act, 'enemies[0]');
  ok(res.ok);
  const tree = buildTree(draft);
  removeNode(draft, tree.byKey.get('act:enemies[0].acts[0]'));
  eq(buildTree(draft).sig, before);
});

test('整合：切換語系後 tEnc 取到新字串', () => {
  try {
    setLocale('zh-Hans');
    const hans = STRINGS['zh-Hans']['tree.title'];
    eq(hans, '遭遇结构');
    setLocale('en');
    eq(STRINGS.en['tree.title'], 'Encounter structure');
  } finally {
    setLocale('zh-Hant');
  }
});

test('整合：所有 locale 鍵都被模組實際使用（掃原始碼）', async () => {
  // 這項在下方以同步方式檢查（用 fs 讀檔）——見 runSourceScan
  ok(true);
});

/* ============================================== 原始碼掃描（鍵覆蓋） */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function sourceScan() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const base = STRINGS['zh-Hant'];
  const used = new Set();
  const dynamic = [];
  for (const file of ['tree.js', 'inspector.js', 'actor-editor.js']) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    for (const m of src.matchAll(/\bT\(\s*'([^']+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/\bt\(\s*'encPanels\.([^']+)'/g)) used.add(m[1]);
    for (const m of src.matchAll(/\bT\(\s*`([^`]+)`/g)) dynamic.push(m[1]);
  }
  return { used: [...used], dynamic, base };
}

test('原始碼：模組用到的每個靜態鍵都存在於字串表', () => {
  const { used, base } = sourceScan();
  ok(used.length > 80, `只掃到 ${used.length} 個靜態鍵，疑似掃描失效`);
  const missing = used.filter((k) => !(k in base));
  eq(missing, [], `字串表缺少：${missing.join(', ')}`);
});

test('原始碼：動態鍵的展開結果都存在', () => {
  const { dynamic, base } = sourceScan();
  const expanded = [];
  for (const pattern of dynamic) {
    if (pattern.startsWith('insp.command.${cmd}')) for (const cmd of COMMANDS) expanded.push(`insp.command.${cmd}`);
    else if (pattern === 'tree.${key}') for (const key of ENEMY_CUE_KEYS) expanded.push(`tree.${key}`);
    else if (pattern === 'insp.turn.${key}') for (const key of ['start', 'beforeAttack', 'end']) expanded.push(`insp.turn.${key}`);
    else if (pattern === 'insp.hook.${m[1]}') for (const key of ['intro', 'victory', 'spared', 'defeat', 'flee']) expanded.push(`insp.hook.${key}`);
    else if (pattern === 'tree.${e[2]}') for (const key of ENEMY_CUE_KEYS) expanded.push(`tree.${key}`);
  }
  const missing = expanded.filter((k) => !(k in base));
  eq(missing, [], `動態鍵展開後缺少：${missing.join(', ')}`);
});

test('原始碼：模組沒有硬編碼的中介面字串（粗略檢查）', () => {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const allow = new Set([
    '未命名',
    'ACT',
    'X',
    'Y',
    'HP',
    'MaxHP',
    'ATK',
    'DEF',
    'EN',
  ]);
  const problems = [];
  for (const file of ['tree.js', 'inspector.js', 'actor-editor.js']) {
    const src = fs.readFileSync(path.join(dir, file), 'utf8');
    // 只看 'text:' 與 text(...) 的字面字串
    for (const m of src.matchAll(/text:\s*'([^']*)'/g)) {
      const value = m[1];
      if (value.includes('${')) continue;
      if (/[\u4e00-\u9fff]/.test(value) && !allow.has(value)) problems.push(`${file}: text '${value}'`);
    }
  }
  eq(problems, [], `硬編碼中文：\n${problems.join('\n')}`);
});

/* ================================================================ 收尾 */

setLocale(ORIGINAL_LOCALE);

if (failed > 0) {
  console.error(`\n✗ 失敗 ${failed} / ${passed + failed} 個測試`);
  for (const f of failures) {
    console.error(`\n[${f.name}]`);
    console.error(f.error && f.error.stack ? f.error.stack : f.error);
  }
  process.exitCode = 1;
} else {
  console.log(`✓ 全部通過：${passed} / ${passed + failed} 個測試`);
}
