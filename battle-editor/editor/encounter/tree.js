// editor/encounter/tree.js  (ED3, Phase 2)
//
// 遭遇結構樹：掛在 ED1 提供的 #enc-tree。
//
// 內容依 docs/SPEC-P2.md §1 的遭遇檔結構產生：
//   設定 / 演員 / 隊伍 / 敵人（→ ACT → cues）/ 道具 / 回合（→ talk / start / end）
//   時機掛鉤（intro victory spared defeat flee、每個敵人的 onHurt/onSpare/onDefeat、
//             每個 ACT / 法術的 cues、每回合 start/end）/ 變數
//
// 點選節點 → store.select(kind, id, path)；節點若擁有演出指令（cues），
// 同時把該清單路徑交給 store.setCuePath(path)，讓 ED2 的指令清單編輯器接手。
//
// 本檔分兩層：
//   1) 純邏輯（不碰 DOM）：buildTree / findNode / renameRefs / refsTo / addEntry /
//      removeEntry / applyNodeOp / displayText …   ← 由 panels.test.mjs 測試
//   2) 掛載層：mount(rootEl, ctx)
//
// 對 ED1 介面的假設集中在本檔「store 介面適配」一節（見 STORE_API 說明），
// 若 ED1 回報的介面不同，只需改那一節。

import { TURN_CUE_KEYS } from '../../engine/encounter/schema.js';
import { t, registerStrings, onLocaleChange, getLocale } from '../i18n.js';
import STRINGS from '../locales/encounter-panels.js';
import {
  el,
  clear,
  button,
  emptyState,
  hintBox,
  normalizeErrors,
  lookupErrorPrefix,
  ensureStyles,
  getPath,
  setPath,
  domSig,
} from '../fields.js';
import { LAYOUT } from '../../engine/encounter/layout.js';

registerStrings('encPanels', STRINGS);

/** 本模組的取字串捷徑（動態解析，切換語系後會拿到新值）。 */
const T = (key, params) => t(`encPanels.${key}`, params);

/* =========================================================================
 * 0. 樣式注入
 * ========================================================================= */

/** 確保 editor/encounter/panels.css 已載入（重複呼叫安全）。 */
export function ensureEncounterStyles(href = null) {
  if (typeof document === 'undefined') return;
  let url = href;
  if (!url) {
    try {
      url = new URL('./panels.css', import.meta.url).href;
    } catch {
      url = 'panels.css';
    }
  }
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  const same = (raw) => {
    if (!raw) return false;
    try {
      return new URL(raw, document.baseURI).href === url;
    } catch {
      return raw === url;
    }
  };
  if (links.some((l) => same(l.getAttribute('href')))) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  document.head.appendChild(link);
}

/* =========================================================================
 * 1. 節點種類
 * ========================================================================= */

/** 選取種類（store.selection.kind）。 */
export const KIND = Object.freeze({
  settings: 'settings',
  actor: 'actor',
  party: 'party',
  enemy: 'enemy',
  act: 'act',
  spell: 'spell',
  item: 'item',
  turn: 'turn',
  talk: 'talk',
  cues: 'cues',
  vars: 'vars',
  var: 'var',
  group: 'group',
});

/** 節點 key（同一時間只有一個節點符合）。 */
export function nodeKey(node) {
  if (node.path) return `${node.kind}:${node.path}`;
  if (node.id !== null && node.id !== undefined) return `${node.kind}:${node.id}`;
  return `${node.kind}:#${node.labelKey || ''}`;
}

/* =========================================================================
 * 2. 文字（字串 或 { zh, en }）
 * ========================================================================= */

/** 是否為 {zh, en} 形式。 */
export function isBilingualText(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && ('zh' in v || 'en' in v);
}

/**
 * 取顯示字串：字串原樣；{zh,en} 依語言；
 * lang 'zh'（繁中／簡中編輯器都算 zh，因為資料只有 zh/en 兩種）。
 */
export function displayText(v, lang = 'zh') {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isBilingualText(v)) {
    const first = lang === 'en' ? v.en : v.zh;
    const other = lang === 'en' ? v.zh : v.en;
    return first !== undefined && first !== null ? String(first) : other !== undefined && other !== null ? String(other) : '';
  }
  return '';
}

/** 目前編輯器語系對應的資料語言（zh-Hant / zh-Hans → zh；en → en）。 */
export function dataLang(locale = getLocale()) {
  return locale === 'en' ? 'en' : 'zh';
}

/** 解析文字值 → { mode:'single'|'bi', single, zh, en } */
export function parseTextValue(v) {
  if (isBilingualText(v)) {
    return {
      mode: 'bi',
      single: '',
      zh: v.zh === null || v.zh === undefined ? '' : String(v.zh),
      en: v.en === null || v.en === undefined ? '' : String(v.en),
    };
  }
  return { mode: 'single', single: displayText(v), zh: '', en: '' };
}

/**
 * 由 {mode, single, zh, en} 組成要寫回 JSON 的值。
 * 單一模式一律字串；中英模式若 en 為空則只留 zh（仍以物件儲存，保留「已分開」意圖）。
 */
export function composeTextValue(parsed) {
  const p = parsed || {};
  if (p.mode === 'bi') {
    const out = { zh: p.zh === undefined ? '' : String(p.zh) };
    if (p.en !== undefined && p.en !== '') out.en = String(p.en);
    return out;
  }
  return p.single === undefined || p.single === null ? '' : String(p.single);
}

/* =========================================================================
 * 3. 結構正規化（只補樹／表單需要的容器，不改資料語意）
 * ========================================================================= */

const HOOK_NAMES = ['intro', 'victory', 'spared', 'defeat', 'flee'];
const ENEMY_CUE_KEYS = ['onHurt', 'onSpare', 'onDefeat'];
const TURN_CUE_LABELS = { start: 'tree.turnStart', beforeAttack: 'tree.turnBeforeAttack', end: 'tree.turnEnd' };
const TURN_ORDER_VALUES = ['sequential', 'loop-last', 'random'];

export { HOOK_NAMES, ENEMY_CUE_KEYS, TURN_CUE_KEYS, TURN_ORDER_VALUES };

/**
 * 深拷貝並補齊樹／表單需要存在的容器（不動傳入物件）。
 * 只補「空容器」，不填入任何預設文字，避免改寫使用者資料。
 */
export function ensureStructure(enc) {
  const src = enc && typeof enc === 'object' ? enc : {};
  const out = cloneJson(src);
  if (!out.meta || typeof out.meta !== 'object') out.meta = {};
  if (!out.settings || typeof out.settings !== 'object') out.settings = {};
  if (!out.actors || typeof out.actors !== 'object' || Array.isArray(out.actors)) out.actors = {};
  for (const name of ['party', 'enemies', 'items', 'turns']) {
    if (!Array.isArray(out[name])) out[name] = [];
  }
  if (!out.hooks || typeof out.hooks !== 'object') out.hooks = {};
  for (const name of HOOK_NAMES) {
    if (!Array.isArray(out.hooks[name])) out.hooks[name] = [];
  }
  if (!out.vars || typeof out.vars !== 'object' || Array.isArray(out.vars)) out.vars = {};
  for (const actor of Object.values(out.actors)) {
    if (actor && typeof actor === 'object' && (!actor.anims || typeof actor.anims !== 'object')) actor.anims = {};
  }
  for (const enemy of out.enemies) {
    if (!enemy || typeof enemy !== 'object') continue;
    if (!Array.isArray(enemy.acts)) enemy.acts = [];
    for (const key of ENEMY_CUE_KEYS) if (!Array.isArray(enemy[key])) enemy[key] = [];
    for (const act of enemy.acts) {
      if (act && typeof act === 'object') {
        if (!Array.isArray(act.cues)) act.cues = [];
        if (!Array.isArray(act.party)) act.party = [];
      }
    }
  }
  for (const member of out.party) {
    if (!member || typeof member !== 'object') continue;
    if (!Array.isArray(member.spells)) member.spells = [];
    for (const spell of member.spells) {
      if (spell && typeof spell === 'object' && !Array.isArray(spell.cues)) spell.cues = [];
    }
  }
  for (const turn of out.turns) {
    if (!turn || typeof turn !== 'object') continue;
    if (!Array.isArray(turn.talk)) turn.talk = [];
    for (const key of TURN_CUE_KEYS) if (!Array.isArray(turn[key])) turn[key] = [];
  }
  return out;
}

function cloneJson(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(cloneJson);
  const out = {};
  for (const k of Object.keys(v)) out[k] = cloneJson(v[k]);
  return out;
}

/* =========================================================================
 * 4. 建立結構樹（純邏輯）
 * ========================================================================= */

/**
 * 建立結構樹。
 * @param {object} enc 遭遇資料（建議先過 ensureStructure）
 * @param {{ errors?: Map|object|null }} [opts]
 * @returns {{ roots: Node[], byKey: Map<string, Node>, sig: string }}
 *
 * Node = {
 *   key, kind, id, path,            // path 為 JSON 路徑（validateEncounter 同格式）
 *   labelKey, labelParams,          // 顯示文字（i18n 鍵 + 參數）
 *   cuesPath: string|null,          // 這個節點擁有的演出指令清單路徑
 *   selectable: boolean,
 *   children: Node[],
 *   array: { path, index }|null,    // 陣列項目（排序／複製／刪除用）
 *   objKey: { path, key }|null,     // 物件鍵項目（演員／變數）
 *   addSpec: { kind, ownerPath }|null,
 *   renameKind: string|null,
 *   hasError: boolean,
 * }
 */
export function buildTree(enc, opts = {}) {
  const doc = ensureStructure(enc);
  const errs = normalizeErrors(opts.errors || null);
  const byKey = new Map();
  const roots = [];
  const sigParts = [];

  const mk = (spec) => {
    const node = {
      key: '',
      kind: KIND.group,
      id: null,
      path: '',
      labelKey: '',
      labelParams: null,
      cuesPath: null,
      selectable: true,
      children: [],
      array: null,
      objKey: null,
      addSpec: null,
      renameKind: null,
      hasError: false,
      ...spec,
    };
    node.key = nodeKey(node);
    node.hasError = node.path ? lookupErrorPrefix(errs, node.path).hasError : false;
    sigParts.push(`${node.key}|${node.labelKey}|${JSON.stringify(node.labelParams)}|${node.hasError ? 1 : 0}`);
    byKey.set(node.key, node);
    return node;
  };

  const group = (id, labelKey, children, addSpec = null, extra = {}) =>
    mk({
      kind: KIND.group,
      id: `group:${id}`,
      path: '',
      labelKey,
      selectable: false,
      children,
      addSpec,
      ...extra,
    });

  /* ---- 設定 ---- */
  const settingsNode = mk({
    kind: KIND.settings,
    id: null,
    path: 'settings',
    labelKey: 'tree.settings',
    renameKind: null,
  });
  roots.push(settingsNode);

  /* ---- 演員 ---- */
  const actorIds = Object.keys(doc.actors);
  const actorNodes = actorIds.map((id) => {
    const actor = doc.actors[id];
    const animCount = actor && actor.anims ? Object.keys(actor.anims).length : 0;
    return mk({
      kind: KIND.actor,
      id,
      path: `actors.${quoteKey(id)}`,
      labelKey: 'tree.actorTag',
      labelParams: { id },
      objKey: { path: 'actors', key: id },
      renameKind: 'actor',
      hasBadge: animCount,
      badgeKind: 'anims',
    });
  });
  roots.push(group('actors', 'tree.actors', actorNodes, { kind: KIND.actor }));

  /* ---- 隊伍 ---- */
  const partyNodes = doc.party.map((member, i) => {
    const name = displayText(member && member.name, dataLang());
    const spells = Array.isArray(member && member.spells) ? member.spells : [];
    const spellNodes = spells.map((spell, j) =>
      mk({
        kind: KIND.spell,
        id: spell && spell.id !== undefined ? String(spell.id) : `spell${j}`,
        path: `party[${i}].spells[${j}]`,
        labelKey: 'tree.spellTag',
        labelParams: { name: displayText(spell && spell.name, dataLang()) || (spell && spell.id) || '' },
        array: { path: `party[${i}].spells`, index: j },
        renameKind: 'spell',
        cuesPath: `party[${i}].spells[${j}].cues`,
        addSpec: null,
        ownerPartyIndex: i,
      }),
    );
    const node = mk({
      kind: KIND.party,
      id: member && member.id !== undefined ? String(member.id) : `party${i}`,
      path: `party[${i}]`,
      labelKey: name ? 'tree.partyTag' : 'tree.partyPlain',
      labelParams: name ? { i: i + 1, name } : { i: i + 1 },
      array: { path: 'party', index: i },
      renameKind: 'party',
      children: spellNodes,
      addSpec: { kind: KIND.spell, ownerPath: `party[${i}]` },
    });
    return node;
  });
  roots.push(group('party', 'tree.party', partyNodes, { kind: KIND.party }));

  /* ---- 敵人（→ ACT → cues） ---- */
  const enemyNodes = doc.enemies.map((enemy, i) => {
    const name = displayText(enemy && enemy.name, dataLang());
    const acts = Array.isArray(enemy && enemy.acts) ? enemy.acts : [];
    const actNodes = acts.map((act, j) =>
      mk({
        kind: KIND.act,
        id: act && act.id !== undefined ? String(act.id) : `act${j}`,
        path: `enemies[${i}].acts[${j}]`,
        labelKey: displayText(act && act.name, dataLang()) ? 'tree.actTag' : 'tree.actPlain',
        labelParams: displayText(act && act.name, dataLang())
          ? { i: j + 1, name: displayText(act && act.name, dataLang()) }
          : { i: j + 1 },
        array: { path: `enemies[${i}].acts`, index: j },
        renameKind: 'act',
        cuesPath: `enemies[${i}].acts[${j}].cues`,
        addSpec: { kind: KIND.act, ownerPath: `enemies[${i}]` },
      }),
    );
    const cueNodes = ENEMY_CUE_KEYS.map((key) =>
      mk({
        kind: KIND.cues,
        id: `${enemy && enemy.id ? enemy.id : `enemy${i}`}/${key}`,
        path: `enemies[${i}].${key}`,
        labelKey: key === 'onHurt' ? 'tree.onHurt' : key === 'onSpare' ? 'tree.onSpare' : 'tree.onDefeat',
        cuesPath: `enemies[${i}].${key}`,
        cueCount: (enemy && Array.isArray(enemy[key]) ? enemy[key].length : 0),
      }),
    );
    return mk({
      kind: KIND.enemy,
      id: enemy && enemy.id !== undefined ? String(enemy.id) : `enemy${i}`,
      path: `enemies[${i}]`,
      labelKey: name ? 'tree.enemyTag' : 'tree.enemyPlain',
      labelParams: name ? { i: i + 1, name } : { i: i + 1 },
      array: { path: 'enemies', index: i },
      renameKind: 'enemy',
      children: [...actNodes, ...cueNodes],
      addSpec: { kind: KIND.act, ownerPath: `enemies[${i}]` },
    });
  });
  roots.push(group('enemies', 'tree.enemies', enemyNodes, { kind: KIND.enemy }));

  /* ---- 道具 ---- */
  const itemNodes = doc.items.map((item, i) => {
    const name = displayText(item && item.name, dataLang());
    return mk({
      kind: KIND.item,
      id: item && item.id !== undefined ? String(item.id) : `item${i}`,
      path: `items[${i}]`,
      labelKey: name ? 'tree.itemTag' : 'tree.itemPlain',
      labelParams: name ? { i: i + 1, name, count: item && item.count } : { i: i + 1 },
      array: { path: 'items', index: i },
      renameKind: 'item',
    });
  });
  roots.push(group('items', 'tree.items', itemNodes, { kind: KIND.item }));

  /* ---- 回合（→ talk / start / end） ---- */
  const turnNodes = doc.turns.map((turn, i) => {
    const id = turn && turn.id !== undefined ? String(turn.id) : `turn${i}`;
    const talk = Array.isArray(turn && turn.talk) ? turn.talk : [];
    // 每回合的開始／結束 cue 清單（ED2 指令清單編輯器就是編輯這兩個陣列）
    const turnCueNodes = TURN_CUE_KEYS.map((key) =>
      mk({
        kind: KIND.cues,
        id: `${id}/${key}`,
        path: `turns[${i}].${key}`,
        labelKey: TURN_CUE_LABELS[key],
        cuesPath: `turns[${i}].${key}`,
        cueCount: Array.isArray(turn && turn[key]) ? turn[key].length : 0,
      }),
    );
    const talkNodes = talk.map((bubble, k) => {
      const actor = displayText(bubble && bubble.actor, 'zh') || (bubble && bubble.actor) || '';
      const text = displayText(bubble && bubble.text, dataLang());
      return mk({
        kind: KIND.talk,
        id: `${id}/${k}`,
        path: `turns[${i}].talk[${k}]`,
        labelKey: text ? 'tree.talkActor' : 'tree.talkTag',
        labelParams: text ? { actor, text: shortText(text, 24) } : { i: k + 1 },
        array: { path: `turns[${i}].talk`, index: k },
        renameKind: null,
        ownerTurnIndex: i,
      });
    });
    return mk({
      kind: KIND.turn,
      id,
      path: `turns[${i}]`,
      labelKey: 'tree.turnTag',
      labelParams: { i: i + 1, id },
      array: { path: 'turns', index: i },
      renameKind: 'turn',
      children: [...turnCueNodes, ...talkNodes],
      addSpec: { kind: KIND.talk, ownerPath: `turns[${i}]` },
    });
  });
  roots.push(group('turns', 'tree.turns', turnNodes, { kind: KIND.turn }));

  /* ---- 時機掛鉤 ---- */
  const hookNodes = HOOK_NAMES.map((name) =>
    mk({
      kind: KIND.cues,
      id: `hooks/${name}`,
      path: `hooks.${name}`,
      labelKey: `tree.hook${name.charAt(0).toUpperCase()}${name.slice(1)}`,
      cuesPath: `hooks.${name}`,
      cueCount: (doc.hooks[name] || []).length,
    }),
  );
  roots.push(group('hooks', 'tree.hooks', hookNodes, null));

  /* ---- 變數 ---- */
  const varNodes = Object.keys(doc.vars).map((name) =>
    mk({
      kind: KIND.var,
      id: name,
      path: `vars.${quoteKey(name)}`,
      labelKey: 'tree.varTag',
      labelParams: { name, value: JSON.stringify(doc.vars[name]) },
      objKey: { path: 'vars', key: name },
      renameKind: 'var',
    }),
  );
  roots.push(group('vars', 'tree.vars', varNodes, { kind: KIND.var }));

  const sig = sigParts.join('\n');
  return { roots, byKey, sig };
}

/** 物件鍵的路徑片段：識別字用 `.key`，其餘用 ["..."]。 */
export function quoteKey(key) {
  const s = String(key);
  if (/^[A-Za-z_$][\w$]*$/.test(s)) return s;
  return `[${JSON.stringify(s)}]`;
}

function shortText(s, n) {
  const text = String(s || '').replace(/\s+/g, ' ').trim();
  return text.length > n ? `${text.slice(0, n - 1)}…` : text;
}

/** 依 key 找節點（含子樹）。 */
export function findNode(tree, key) {
  if (!tree || !key) return null;
  if (tree.byKey && tree.byKey.has(key)) return tree.byKey.get(key);
  if (Array.isArray(tree)) {
    for (const node of tree) {
      const hit = findNode(node, key);
      if (hit) return hit;
    }
    return null;
  }
  for (const child of tree.children || []) {
    const hit = findNode(child, key);
    if (hit) return hit;
  }
  return null;
}

/** 攤平所有節點（含群組）。 */
export function flattenTree(tree) {
  const out = [];
  const walk = (nodes) => {
    for (const node of nodes || []) {
      out.push(node);
      if (node.children && node.children.length) walk(node.children);
    }
  };
  walk(tree && tree.roots ? tree.roots : tree);
  return out;
}

/* =========================================================================
 * 5. 演出指令清單（cues）走訪
 * ========================================================================= */

/**
 * 走訪一個 cues 陣列，含 if/parallel 的巢狀子清單。
 * fn(cue, path) — path 為該 cue 的 JSON 路徑。
 */
export function walkCues(cues, pathPrefix, fn) {
  if (!Array.isArray(cues)) return;
  cues.forEach((cue, i) => {
    if (!cue || typeof cue !== 'object') return;
    const path = `${pathPrefix}[${i}]`;
    fn(cue, path);
    if (cue.cmd === 'if') {
      walkCues(cue.then, `${path}.then`, fn);
      walkCues(cue.else, `${path}.else`, fn);
    } else if (cue.cmd === 'parallel') {
      walkCues(cue.cues, `${path}.cues`, fn);
    }
  });
}

/**
 * 收集整份遭遇的所有 cues 清單。
 * @returns {{ path: string, ownerKind: string, ownerId: string|null, cues: any[] }[]}
 */
export function collectCueLists(enc) {
  const doc = readDoc(enc);
  const out = [];
  const push = (path, ownerKind, ownerId, cues) => {
    if (Array.isArray(cues)) out.push({ path, ownerKind, ownerId, cues });
  };
  const hooks = doc.hooks && typeof doc.hooks === 'object' ? doc.hooks : {};
  for (const name of HOOK_NAMES) push(`hooks.${name}`, KIND.cues, `hooks/${name}`, hooks[name]);
  const enemies = Array.isArray(doc.enemies) ? doc.enemies : [];
  enemies.forEach((enemy, i) => {
    const enemyId = enemy && enemy.id !== undefined ? String(enemy.id) : `enemy${i}`;
    for (const key of ENEMY_CUE_KEYS) push(`enemies[${i}].${key}`, KIND.enemy, enemyId, enemy && enemy[key]);
    (Array.isArray(enemy && enemy.acts) ? enemy.acts : []).forEach((act, j) => {
      const actId = act && act.id !== undefined ? String(act.id) : `act${j}`;
      push(`enemies[${i}].acts[${j}].cues`, KIND.act, `${enemyId}/${actId}`, act && act.cues);
    });
  });
  const party = Array.isArray(doc.party) ? doc.party : [];
  party.forEach((member, i) => {
    const memberId = member && member.id !== undefined ? String(member.id) : `party${i}`;
    (Array.isArray(member && member.spells) ? member.spells : []).forEach((spell, j) => {
      const spellId = spell && spell.id !== undefined ? String(spell.id) : `spell${j}`;
      push(`party[${i}].spells[${j}].cues`, KIND.spell, `${memberId}/${spellId}`, spell && spell.cues);
    });
  });
  const turns = Array.isArray(doc.turns) ? doc.turns : [];
  turns.forEach((turn, i) => {
    const turnId = turn && turn.id !== undefined ? String(turn.id) : `turn${i}`;
    for (const key of TURN_CUE_KEYS) push(`turns[${i}].${key}`, KIND.turn, `${turnId}/${key}`, turn?.[key]);
  });
  return out;
}

/**
 * 讀取用：不複製、不補容器（改名等就地修改必須用這條路，
 * 否則改到的是 ensureStructure 的副本）。
 */
export function readDoc(enc) {
  return enc && typeof enc === 'object' ? enc : {};
}

/* =========================================================================
 * 6. 引用查詢 / 改名同步
 * ========================================================================= */

/** 隊員／敵人若引用某演員，回傳描述清單。 */
export function actorRefs(enc, actorId) {
  const doc = readDoc(enc);
  const refs = [];
  const party = Array.isArray(doc.party) ? doc.party : [];
  party.forEach((member, i) => {
    if (member && member.actor === actorId) refs.push({ path: `party[${i}].actor`, kind: KIND.party });
  });
  const enemies = Array.isArray(doc.enemies) ? doc.enemies : [];
  enemies.forEach((enemy, i) => {
    if (enemy && enemy.actor === actorId) refs.push({ path: `enemies[${i}].actor`, kind: KIND.enemy });
  });
  const turns = Array.isArray(doc.turns) ? doc.turns : [];
  turns.forEach((turn, i) => {
    (Array.isArray(turn && turn.talk) ? turn.talk : []).forEach((bubble, k) => {
      if (bubble && bubble.actor === actorId) refs.push({ path: `turns[${i}].talk[${k}].actor`, kind: KIND.talk });
    });
  });
  for (const list of collectCueLists(doc)) {
    walkCues(list.cues, list.path, (cue, path) => {
      if (cue.actor === actorId) refs.push({ path: `${path}.actor`, kind: KIND.cues, cue: cue.cmd });
    });
  }
  return refs;
}

/**
 * 改名時要同步的引用：party.actor / enemies.actor / turn.talk[].actor /
 * cues 內 actor、enemy、target 欄位（含 if/parallel 巢狀）。
 * @returns {{ ok: boolean, changed: string[], reason?: string }}
 */
export function renameRefs(enc, kind, oldId, newId) {
  const doc = readDoc(enc);
  if (!oldId || !newId || oldId === newId) return { ok: true, changed: [] };
  const changed = [];
  const fix = (obj, key) => {
    if (obj && obj[key] === oldId) {
      obj[key] = newId;
      return true;
    }
    return false;
  };

  if (kind === 'actor') {
    (Array.isArray(doc.party) ? doc.party : []).forEach((member, i) => {
      if (fix(member, 'actor')) changed.push(`party[${i}].actor`);
    });
    (Array.isArray(doc.enemies) ? doc.enemies : []).forEach((enemy, i) => {
      if (fix(enemy, 'actor')) changed.push(`enemies[${i}].actor`);
    });
    (Array.isArray(doc.turns) ? doc.turns : []).forEach((turn, i) => {
      (Array.isArray(turn && turn.talk) ? turn.talk : []).forEach((bubble, k) => {
        if (fix(bubble, 'actor')) changed.push(`turns[${i}].talk[${k}].actor`);
      });
    });
    for (const list of collectCueLists(doc)) {
      walkCues(list.cues, list.path, (cue, path) => {
        if (fix(cue, 'actor')) changed.push(`${path}.actor`);
      });
    }
  } else if (kind === 'party' || kind === 'enemy') {
    for (const list of collectCueLists(doc)) {
      walkCues(list.cues, list.path, (cue, path) => {
        if (fix(cue, 'target')) changed.push(`${path}.target`);
        if (kind === 'enemy' && fix(cue, 'enemy')) changed.push(`${path}.enemy`);
      });
    }
  }
  return { ok: true, changed };
}

/** 節點被刪除時的引用數（用於刪除警告）。 */
export function refsTo(enc, kind, id) {
  if (!id) return [];
  if (kind === 'actor') return actorRefs(enc, id);
  if (kind === 'party' || kind === 'enemy') {
    const doc = readDoc(enc);
    const refs = [];
    for (const list of collectCueLists(doc)) {
      walkCues(list.cues, list.path, (cue, path) => {
        if (cue.target === id) refs.push({ path: `${path}.target`, kind });
        if (kind === 'enemy' && cue.enemy === id) refs.push({ path: `${path}.enemy`, kind });
      });
    }
    return refs;
  }
  return [];
}

/** 值裡是否已有使用者內容（數字 0 / 布林 false / 空容器視為預設值）。 */
function hasUserContent(value, depth = 0) {
  if (depth > 5 || value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim() !== '';
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'boolean') return value === true;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'object') {
    return Object.entries(value).some(([key, v]) => key !== 'id' && key !== 'name' && hasUserContent(v, depth + 1));
  }
  return false;
}

/**
 * 節點是否已有子內容（B1：刪除前是否需要確認）。
 * 有子節點、或葉節點本身有實質資料 → true；全新空白節點 → false（可直接刪）。
 * @param {object} node buildTree 節點
 * @param {object|null} doc 遭遇文件
 */
export function nodeHasChildContent(node, doc) {
  if (!node) return false;
  if ((node.children || []).length > 0) return true;
  const value = node.path && doc ? getPath(doc, node.path) : null;
  return hasUserContent(value);
}

/* =========================================================================
 * 7. 新增 / 刪除 / 複製 / 排序（純邏輯，直接改傳入的 draft）
 * ========================================================================= */

/** 產生不衝突的 id：base、base2、base3… */
export function uniqueId(base, taken) {
  const used = new Set((taken || []).map(String));
  const safe = String(base || 'id').replace(/[^\w-]/g, '_') || 'id';
  if (!used.has(safe)) return safe;
  let n = 2;
  while (used.has(`${safe}${n}`)) n += 1;
  return `${safe}${n}`;
}

const COMMAND_DEFAULTS = ['fight', 'act', 'item', 'spare', 'defend'];

/** 各種節目的預設內容（純資料，不含介面字串）。 */
export function createEntry(kind, enc, ownerPath) {
  const doc = enc || {};
  const actorIds = Object.keys(doc.actors || {});
  if (kind === KIND.actor) {
    return {
      id: uniqueId('actor', actorIds),
      // 預設站位＝LAYOUT 的敵人錨點（腳底 y），與替代畫面／遊戲渲染一致
      value: {
        kind: 'enemy',
        x: LAYOUT.ENEMY_CENTER_X,
        y: LAYOUT.ENEMY_FEET_Y,
        anims: { idle: { sprite: null, fps: 5, loop: true } },
      },
    };
  }
  if (kind === KIND.party) {
    const ids = (doc.party || []).map((m) => String((m && m.id) || ''));
    return {
      id: uniqueId('hero', ids),
      value: {
        id: uniqueId('hero', ids),
        actor: actorIds[0] || null,
        name: 'Hero',
        hp: 90,
        maxHp: 90,
        atk: 10,
        def: 2,
        magic: 0,
        color: '#00ffff',
        commands: [...COMMAND_DEFAULTS],
        spells: [],
      },
    };
  }
  if (kind === KIND.enemy) {
    const ids = (doc.enemies || []).map((m) => String((m && m.id) || ''));
    return {
      id: uniqueId('enemy', ids),
      value: {
        id: uniqueId('enemy', ids),
        actor: actorIds[0] || null,
        name: 'Enemy',
        hp: 100,
        maxHp: 100,
        atk: 5,
        def: 0,
        mercy: 0,
        spareAt: 100,
        tired: false,
        acts: [],
        onHurt: [],
        onSpare: [],
        onDefeat: [],
      },
    };
  }
  if (kind === KIND.act) {
    const owner = ownerPath ? getPath(doc, ownerPath) : null;
    const ids = Array.isArray(owner && owner.acts) ? owner.acts.map((a) => String((a && a.id) || '')) : [];
    const id = uniqueId('act', ids);
    return { id, value: { id, name: 'Act', party: [], mercy: 0, text: '', cues: [] } };
  }
  if (kind === KIND.spell) {
    const owner = ownerPath ? getPath(doc, ownerPath) : null;
    const ids = Array.isArray(owner && owner.spells) ? owner.spells.map((a) => String((a && a.id) || '')) : [];
    const id = uniqueId('spell', ids);
    return { id, value: { id, name: 'Spell', tp: 0, target: 'enemy', cues: [] } };
  }
  if (kind === KIND.item) {
    const ids = (doc.items || []).map((m) => String((m && m.id) || ''));
    const id = uniqueId('item', ids);
    return { id, value: { id, name: 'Item', count: 1, heal: 10, target: 'party', text: '' } };
  }
  if (kind === KIND.turn) {
    const ids = (doc.turns || []).map((m) => String((m && m.id) || ''));
    const id = uniqueId('t', ids);
    return { id, value: { id, flavor: '', talk: [], attack: null, start: [], beforeAttack: [], end: [] } };
  }
  if (kind === KIND.talk) {
    return { id: '', value: { actor: actorIds[0] || null, text: '' } };
  }
  if (kind === KIND.var) {
    const names = Object.keys(doc.vars || {});
    const name = uniqueId('newVar', names);
    return { id: name, value: 0 };
  }
  return { id: '', value: null };
}

/**
 * 在各自容器新增一個節點。
 * @returns {{ ok: boolean, path?: string, id?: string, reason?: string }}
 */
export function addEntry(draft, kind, ownerPath = null) {
  if (!draft || typeof draft !== 'object') return { ok: false, reason: 'noDoc' };
  const made = createEntry(kind, draft, ownerPath);
  if (made.value === null) return { ok: false, reason: 'unsupported' };

  if (kind === KIND.actor) {
    if (!draft.actors || typeof draft.actors !== 'object') draft.actors = {};
    draft.actors[made.id] = made.value;
    return { ok: true, path: `actors.${quoteKey(made.id)}`, id: made.id };
  }
  if (kind === KIND.var) {
    if (!draft.vars || typeof draft.vars !== 'object') draft.vars = {};
    draft.vars[made.id] = made.value;
    return { ok: true, path: `vars.${quoteKey(made.id)}`, id: made.id };
  }
  if (kind === KIND.party || kind === KIND.enemy || kind === KIND.item || kind === KIND.turn) {
    const key = kind === KIND.party ? 'party' : kind === KIND.enemy ? 'enemies' : kind === KIND.item ? 'items' : 'turns';
    if (!Array.isArray(draft[key])) draft[key] = [];
    draft[key].push(made.value);
    return { ok: true, path: `${key}[${draft[key].length - 1}]`, id: made.id };
  }
  if (kind === KIND.act || kind === KIND.spell || kind === KIND.talk) {
    if (!ownerPath) return { ok: false, reason: 'noOwner' };
    const owner = getPath(draft, ownerPath);
    if (!owner || typeof owner !== 'object') return { ok: false, reason: 'noOwner' };
    const listKey = kind === KIND.act ? 'acts' : kind === KIND.spell ? 'spells' : 'talk';
    if (!Array.isArray(owner[listKey])) owner[listKey] = [];
    owner[listKey].push(made.value);
    return { ok: true, path: `${ownerPath}.${listKey}[${owner[listKey].length - 1}]`, id: made.id };
  }
  return { ok: false, reason: 'unsupported' };
}

/** 陣列內搬移（回傳是否變動）。 */
export function moveInArray(arr, from, to) {
  if (!Array.isArray(arr)) return false;
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false;
  if (from < 0 || from >= arr.length || to < 0 || to >= arr.length || from === to) return false;
  const [item] = arr.splice(from, 1);
  arr.splice(to, 0, item);
  return true;
}

/** 由 buildTree 產生的節點刪除自己。 */
export function removeNode(draft, node) {
  if (!draft || !node) return { ok: false, reason: 'noNode' };
  if (node.array) {
    const arr = getPath(draft, node.array.path);
    if (!Array.isArray(arr) || node.array.index < 0 || node.array.index >= arr.length) {
      return { ok: false, reason: 'missing' };
    }
    arr.splice(node.array.index, 1);
    return { ok: true };
  }
  if (node.objKey) {
    const obj = getPath(draft, node.objKey.path);
    if (!obj || typeof obj !== 'object' || !(node.objKey.key in obj)) return { ok: false, reason: 'missing' };
    delete obj[node.objKey.key];
    return { ok: true };
  }
  return { ok: false, reason: 'unsupported' };
}

/** 複製節點（演員／變數以外都支援；id 會自動改成不衝突值）。 */
export function duplicateNode(draft, node) {
  if (!draft || !node || !node.array) return { ok: false, reason: 'unsupported' };
  const arr = getPath(draft, node.array.path);
  if (!Array.isArray(arr) || !arr[node.array.index]) return { ok: false, reason: 'missing' };
  const copy = cloneJson(arr[node.array.index]);
  if (copy && typeof copy === 'object' && 'id' in copy) {
    const taken = arr.map((it) => String((it && it.id) || ''));
    copy.id = uniqueId(`${copy.id}`, taken);
  }
  arr.splice(node.array.index + 1, 0, copy);
  return { ok: true, index: node.array.index + 1, id: copy && copy.id };
}

/** 由上層群組新增（node.addSpec）。 */
export function addChildOf(draft, node) {
  if (!node || !node.addSpec) return { ok: false, reason: 'unsupported' };
  return addEntry(draft, node.addSpec.kind, node.addSpec.ownerPath || null);
}

/**
 * 改名（含同步引用）。陣列項目改 id 欄位；物件項目改鍵。
 * @returns {{ ok: boolean, reason?: string, changed?: string[], newPath?: string }}
 */
export function renameNode(draft, node, rawNewId) {
  if (!draft || !node) return { ok: false, reason: 'noNode' };
  const newId = String(rawNewId === null || rawNewId === undefined ? '' : rawNewId).trim();
  if (newId === '') return { ok: false, reason: 'empty' };
  const oldId = node.id === null || node.id === undefined ? '' : String(node.id);
  if (newId === oldId) return { ok: true, changed: [] };

  if (node.objKey) {
    const obj = getPath(draft, node.objKey.path);
    if (!obj || typeof obj !== 'object') return { ok: false, reason: 'missing' };
    if (Object.prototype.hasOwnProperty.call(obj, newId)) return { ok: false, reason: 'exists' };
    // 保留鍵順序
    const entries = Object.entries(obj).map(([k, v]) => [k === node.objKey.key ? newId : k, v]);
    for (const k of Object.keys(obj)) delete obj[k];
    for (const [k, v] of entries) obj[k] = v;
    const refs = node.renameKind ? renameRefs(draft, node.renameKind, oldId, newId) : { changed: [] };
    return { ok: true, changed: refs.changed, newPath: `${node.objKey.path}.${quoteKey(newId)}` };
  }

  if (!node.array) return { ok: false, reason: 'unsupported' };
  const arr = getPath(draft, node.array.path);
  if (!Array.isArray(arr) || !arr[node.array.index]) return { ok: false, reason: 'missing' };
  const item = arr[node.array.index];
  if (!item || typeof item !== 'object' || !('id' in item)) return { ok: false, reason: 'noId' };
  if (arr.some((it, i) => i !== node.array.index && it && String(it.id) === newId)) {
    return { ok: false, reason: 'exists' };
  }
  item.id = newId;
  let changed = [];
  if (node.renameKind === 'party' || node.renameKind === 'enemy') {
    changed = renameRefs(draft, node.renameKind, oldId, newId).changed;
  }
  return { ok: true, changed, newPath: `${node.array.path}[${node.array.index}]` };
}

/* =========================================================================
 * 8. store 介面適配（對 ED1 的假設集中在這裡）
 * =========================================================================
 *
 * 假設（ED1 回報後若不同，只需改本節）：
 *   store.encounter  遭遇文件（若沒有則用 Phase 1 的 store.attack）
 *   store.selection  { kind, id, path? }（Phase 1 只有 kind/id，path 為 Phase 2 擴充）
 *   store.select(kind, id, path?)   多傳的第三個參數在 Phase 1 會被忽略
 *   store.cuePath / store.setCuePath(path)  目前選取的演出指令清單路徑
 *   store.update(fn, { label, coalesceKey })、store.subscribe(fn)、store.errors(Map)
 *
 * 若 store 沒有 cuePath API，退回模組內的本地狀態，並在 document 上發
 * `dr-cue-path` CustomEvent，讓 ED2 仍能收到（無 store 支援時的後備）。
 */

/** 取遭遇文件（相容 Phase 1 的 store.attack 命名）。 */
export function docOf(store) {
  if (!store) return null;
  const candidates = [store.encounter, store.attack, store.doc, store.data];
  for (const c of candidates) {
    if (c && typeof c === 'object') return c;
  }
  return null;
}

/** 正規化 store.selection。 */
export function readSelection(store) {
  const raw = (store && store.selection) || {};
  return {
    kind: raw.kind ?? null,
    id: raw.id ?? null,
    path: raw.path ?? raw.nodePath ?? null,
  };
}

/** 選取一個節點（並同步 cuePath）。 */
export function selectNode(store, node, local = null) {
  if (!node || node.selectable === false) return false;
  writeCuePath(store, node.cuesPath || null, local);
  if (!store) return false;
  const sel = {
    kind: node.kind,
    id: node.id === undefined ? null : node.id,
    path: node.path || null,
    ...(node.cuesPath ? { meta: { cuesPath: node.cuesPath } } : {}),
  };
  try {
    // ED1 Phase 2 的正式介面：setSelection({kind, id, path, meta})。
    if (typeof store.setSelection === 'function') {
      store.setSelection(sel);
      return true;
    }
    if (typeof store.select === 'function') {
      // Phase 1 相容形式：select(kind, id, pathOrExtra)；null 會被忽略，故用 undefined。
      store.select(sel.kind, sel.id, sel.path === null ? undefined : sel.path);
      return true;
    }
  } catch (err) {
    console.error('[encounter-tree] store 選取失敗：', err);
  }
  return false;
}

/** 讀取目前 cuePath（store 優先，其次本地後備）。 */
export function readCuePath(store, local = null) {
  if (store && typeof store.cuePath === 'string') return store.cuePath;
  if (store && typeof store.getCuePath === 'function') {
    try {
      return store.getCuePath() || null;
    } catch {
      /* 忽略 */
    }
  }
  return local && local.cuePath ? local.cuePath : null;
}

/** 設定 cuePath（store 優先，其次本地後備 + 事件）。 */
export function writeCuePath(store, path, local = null) {
  const value = path || null;
  if (local) local.cuePath = value;
  let handled = false;
  if (store && typeof store.setCuePath === 'function') {
    try {
      store.setCuePath(value);
      handled = true;
    } catch (err) {
      console.error('[encounter-tree] store.setCuePath 失敗：', err);
    }
  }
  if (!handled && typeof document !== 'undefined' && typeof document.dispatchEvent === 'function') {
    try {
      document.dispatchEvent(new CustomEvent('dr-cue-path', { detail: { path: value } }));
    } catch {
      /* 無 CustomEvent 的環境忽略 */
    }
  }
  return value;
}

/** 取錯誤 Map（store.errors 可能是 Map 或物件）。 */
export function errorsOf(store) {
  const raw = store && store.errors;
  if (!raw) return new Map();
  if (raw instanceof Map) return raw;
  if (typeof raw === 'object') return new Map(Object.entries(raw));
  return new Map();
}

/* =========================================================================
 * 9. 掛載層
 * ========================================================================= */

const ICONS = {
  [KIND.settings]: '§',
  [KIND.actor]: '☺',
  [KIND.party]: '◆',
  [KIND.enemy]: '▲',
  [KIND.act]: '☆',
  [KIND.spell]: '✧',
  [KIND.item]: '▤',
  [KIND.turn]: '↻',
  [KIND.talk]: '“',
  [KIND.cues]: '≡',
  [KIND.vars]: '𝑥',
  [KIND.var]: '𝑥',
  [KIND.group]: '',
};

const instances = new WeakMap();

/**
 * 掛載結構樹。
 * @param {HTMLElement} rootEl 通常是 #enc-tree
 * @param {{ store: object, assets?: object|null, preview?: object|null,
 *           confirmDialog?: Function, toast?: Function }} ctx
 *   confirmDialog / toast 由 main.js 注入（沿用遭遇編輯器既有的 modal 與 toast）；
 *   沒注入時退回動態載入 fileops.js，最後才退回瀏覽器原生 confirm。
 */
export function mount(rootEl, ctx = {}) {
  if (!rootEl) return { destroy() {} };
  const previous = instances.get(rootEl);
  if (previous && typeof previous.destroy === 'function') previous.destroy();

  ensureEncounterStyles();
  ensureStyles();

  const store = ctx.store || null;
  const local = { cuePath: null };
  const state = {
    destroyed: false,
    collapsed: new Map(),
    lastSig: '',
    tree: null,
    unsub: null,
    unsubLocale: null,
  };

  rootEl.classList.add('enc-tree');
  rootEl.setAttribute('role', 'tree');
  rootEl.setAttribute('aria-label', T('tree.aria'));

  const selectedKey = () => {
    const sel = readSelection(store);
    if (!sel.kind) return '';
    if (sel.path) return `${sel.kind}:${sel.path}`;
    // 沒有 path 時退回用 id 比對（Phase 1 store 只有 kind/id）
    const tree = state.tree;
    if (!tree) return '';
    for (const node of flattenTree(tree)) {
      if (node.kind === sel.kind && String(node.id) === String(sel.id)) return node.key;
    }
    return '';
  };

  const updateDoc = (fn, opts) => {
    if (!store || typeof store.update !== 'function') return false;
    try {
      return store.update(fn, opts || { label: T('btn.add') });
    } catch (err) {
      console.error('[encounter-tree] store.update 失敗：', err);
      return false;
    }
  };

  /* ---------------- 操作 ---------------- */

  /* ---------------- 對話框（沿用遭遇編輯器既有的 modal／toast） ---------------- */

  const injectedConfirm = typeof ctx.confirmDialog === 'function' ? ctx.confirmDialog : null;
  const injectedToast = typeof ctx.toast === 'function' ? ctx.toast : null;
  let fileopsMod = null;

  /** 取得 fileops 的 confirmDialog / toast（main.js 沒注入時的後備）。 */
  const ensureFileops = async () => {
    if (fileopsMod) return fileopsMod;
    try {
      fileopsMod = await import('./fileops.js');
    } catch (err) {
      console.warn('[encounter-tree] 無法載入 fileops 對話框：', err);
      fileopsMod = {};
    }
    return fileopsMod;
  };

  /** 確認對話框（優先使用既有的 modal，最後才退回原生 confirm）。 */
  const askConfirm = async (message, opts = {}) => {
    const fn = injectedConfirm || (await ensureFileops()).confirmDialog;
    if (typeof fn === 'function') {
      const result = await fn(message, {
        title: opts.title,
        okLabel: opts.okLabel,
        cancelLabel: opts.cancelLabel,
        danger: Boolean(opts.danger),
        detail: opts.detail || '',
      });
      return result === true;
    }
    if (typeof confirm === 'function') return Boolean(confirm(opts.detail ? `${message}\n${opts.detail}` : message));
    return false;
  };

  /** 提示訊息（沿用工具列的 toast）。 */
  const notify = (message, kind = '') => {
    const fn = injectedToast || (fileopsMod && fileopsMod.toast);
    if (typeof fn === 'function') {
      try {
        fn(message, kind);
        return true;
      } catch (err) {
        console.warn('[encounter-tree] toast 失敗：', err);
      }
    }
    if (!injectedToast && !fileopsMod) {
      ensureFileops().then((mod) => {
        if (mod && typeof mod.toast === 'function') mod.toast(message, kind);
      });
    }
    return false;
  };

  const doAdd = (node) => {
    updateDoc(
      (draft) => {
        const made = addChildOf(draft, node);
        if (made.ok && made.path && made.path.includes('[id]')) {
          /* 不會發生；保留防禦 */
        }
        return made;
      },
      { label: T('btn.add') },
    );
  };

  const doRemove = async (node) => {
    if (!node) return false;
    const doc = docOf(store);
    const refs = refsTo(doc, node.renameKind || node.kind, node.id);
    const name = labelOf(node);
    // 只有「沒有子內容、也沒被引用」的節點才直接刪；其餘一律先確認。
    const needsAsk = nodeHasChildContent(node, doc) || refs.length > 0;
    if (needsAsk) {
      const detail = refs.length > 0 ? T('tree.refCount', { n: refs.length }) : '';
      const okToDelete = await askConfirm(T('confirm.delete', { name }), {
        title: T('btn.delete'),
        okLabel: T('btn.delete'),
        cancelLabel: T('btn.cancel'),
        danger: true,
        detail,
      });
      if (!okToDelete) return false;
    }
    const changed = updateDoc((draft) => removeNode(draft, node), { label: T('btn.delete') });
    // 不論是直接刪或確認後刪，都提示「可以 Ctrl+Z 復原」
    if (changed !== false) notify(T('tree.deletedUndo', { name }));
    return true;
  };

  const doDuplicate = (node) => {
    updateDoc((draft) => duplicateNode(draft, node), { label: T('btn.duplicate') });
  };

  const doMove = (node, dir) => {
    updateDoc(
      (draft) => {
        const arr = node.array ? getPath(draft, node.array.path) : null;
        return moveInArray(arr, node.array.index, node.array.index + dir);
      },
      { label: dir < 0 ? T('btn.up') : T('btn.down') },
    );
  };

  const doRename = (node) => {
    if (!node.renameKind) return;
    const current = node.id === null || node.id === undefined ? '' : String(node.id);
    const input = typeof prompt === 'function' ? prompt(T('tree.renamePrompt'), current) : null;
    if (input === null || String(input).trim() === '' || String(input) === current) return;
    updateDoc(
      (draft) => {
        const res = renameNode(draft, node, String(input).trim());
        if (!res.ok) {
          console.warn('[encounter-tree] 改名失敗：', res.reason);
        }
        return res;
      },
      { label: T('btn.rename') },
    );
  };

  const doSelect = (node) => {
    if (!node.selectable) return;
    selectNode(store, node, local);
    render();
  };

  /* ---------------- 渲染 ---------------- */

  const labelOf = (node) => {
    if (!node.labelKey) return '';
    return T(node.labelKey, node.labelParams || undefined);
  };

  const badgeOf = (node) => {
    const cuePath = node.cuesPath;
    if (cuePath) {
      const doc = docOf(store);
      const cues = doc ? getPath(doc, cuePath) : null;
      if (Array.isArray(cues)) return cues.length ? String(cues.length) : '';
    }
    if (node.badgeKind === 'anims' && Number.isFinite(node.hasBadge) && node.hasBadge > 0) return String(node.hasBadge);
    return '';
  };

  const isCollapsed = (node) => state.collapsed.get(node.key) === true;

  const rowFor = (node, depth) => {
    const wrap = el('div', { class: 'enc-tnode-wrap' });
    const row = el('div', {
      class: `enc-tnode enc-kind-${node.kind}${node.selectable ? '' : ' enc-tnode-group'}${node.hasError ? ' has-error' : ''}`,
    });
    row.dataset.key = node.key;
    row.dataset.kind = node.kind;
    row.dataset.path = node.path || '';
    row.style.paddingLeft = `${8 + depth * 12}px`;
    row.setAttribute('role', 'treeitem');

    const hasChildren = (node.children || []).length > 0;
    const twisty = el('button', {
      type: 'button',
      class: 'enc-twisty',
      text: hasChildren ? (isCollapsed(node) ? '▸' : '▾') : '',
      tabIndex: '-1',
      'aria-hidden': 'true',
    });
    if (!hasChildren) twisty.classList.add('enc-twisty-empty');
    if (hasChildren) {
      twisty.addEventListener('click', (e) => {
        e.stopPropagation();
        state.collapsed.set(node.key, !isCollapsed(node));
        render(true);
      });
    }
    row.appendChild(twisty);

    const icon = ICONS[node.kind] || '';
    if (icon) row.appendChild(el('span', { class: 'enc-ticon', text: icon }));

    const label = el('span', { class: 'enc-tlabel', text: labelOf(node), title: labelOf(node) });
    row.appendChild(label);

    const badge = badgeOf(node);
    if (badge) {
      row.appendChild(el('span', { class: `enc-tbadge${node.cuesPath ? ' enc-tbadge-cue' : ''}`, text: badge }));
      if (node.cuesPath) row.title = T('tree.cueCount', { n: Number(badge) });
    }

    if (!node.selectable) row.appendChild(el('span', { class: 'enc-tdot', text: '—' }));

    // 操作按鈕：浮在列尾（position:absolute，不參與 flex、不壓縮 label），
    // 只佔右側最小寬度；點列（非按鈕）一律只選取。
    const ops = el('div', { class: 'enc-tops' });
    const insideOps = (target) => {
      let cur = target;
      while (cur && cur !== row) {
        if (cur.classList && cur.classList.contains('enc-tops')) return true;
        cur = cur.parentNode;
      }
      return false;
    };
    const mkOp = (glyph, title, fn, opts = {}) => {
      const b = el('button', {
        type: 'button',
        class: `enc-op${opts.danger ? ' enc-op-danger' : ''}`,
        text: glyph,
        title,
        tabIndex: '-1',
        'aria-label': title,
        'data-op': opts.op || '',
      });
      // 按鈕上的所有滑鼠事件都不冒泡到列（否則點刪除會先選取、甚至誤觸拖曳）
      const stop = (e) => {
        e.stopPropagation();
      };
      b.addEventListener('pointerdown', stop);
      b.addEventListener('mousedown', stop);
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        e.preventDefault();
        fn();
      });
      ops.appendChild(b);
    };
    if (node.addSpec) mkOp('＋', T('btn.add'), () => doAdd(node), { op: 'add' });
    if (node.array) {
      mkOp('↑', T('btn.up'), () => doMove(node, -1), { op: 'up' });
      mkOp('↓', T('btn.down'), () => doMove(node, 1), { op: 'down' });
      mkOp('⧉', T('btn.duplicate'), () => doDuplicate(node), { op: 'duplicate' });
    }
    if (node.renameKind) mkOp('✎', T('btn.rename'), () => doRename(node), { op: 'rename' });
    if (node.array || node.objKey) mkOp('✕', T('btn.delete'), () => doRemove(node), { op: 'delete', danger: true });
    if (ops.childNodes.length) {
      ops.addEventListener('click', (e) => e.stopPropagation());
      row.appendChild(ops);
    }

    if (node.selectable) {
      row.tabIndex = 0;
      // 點列＝只選取；點在操作鈕上一律交給按鈕自己處理（不冒泡、不改資料）
      row.addEventListener('click', (e) => {
        if (insideOps(e && e.target)) return;
        doSelect(node);
      });
      row.addEventListener('dblclick', (e) => {
        if (insideOps(e && e.target)) return;
        e.preventDefault();
        if (node.renameKind) doRename(node);
      });
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          doSelect(node);
        }
      });
    }

    wrap.appendChild(row);

    const sel = readSelection(store);
    const cuePath = readCuePath(store, local);
    const isSelected = sel.kind === node.kind && (node.path ? sel.path === node.path || (!sel.path && String(sel.id) === String(node.id)) : false);
    if (isSelected) {
      row.classList.add('is-selected');
      wrap.classList.add('is-selected');
      row.setAttribute('aria-selected', 'true');
    }
    if (node.cuesPath && cuePath && node.cuesPath === cuePath) {
      row.classList.add('is-cue-active');
    }

    if (hasChildren && !isCollapsed(node)) {
      const kids = el('div', { class: 'enc-tchildren', role: 'group' });
      for (const child of node.children) kids.appendChild(rowFor(child, depth + 1));
      wrap.appendChild(kids);
    }
    return wrap;
  };

  const render = (force = false) => {
    if (state.destroyed) return;
    const scrollTop = rootEl.scrollTop;

    const doc = docOf(store);
    if (!doc) {
      clear(rootEl);
      rootEl.appendChild(panelLikeHeader());
      rootEl.appendChild(emptyState(T('tip.noDoc')));
      return;
    }

    const tree = buildTree(doc, { errors: errorsOf(store) });
    // store 任何變更都會呼叫 render()；內容沒變就只更新 sig，避免整棵樹重畫
    // （保留 hover、焦點與捲動，也避免演員拖曳時每幀重建 DOM）。
    const nextSig = domSig({ sel: readSelection(store), cue: readCuePath(store, local), sig: tree.sig });
    if (!force && nextSig === state.lastSig && rootEl.querySelector('.enc-tree-body')) {
      state.tree = tree;
      return;
    }
    state.lastSig = nextSig;

    clear(rootEl);
    state.tree = tree;

    const header = panelLikeHeader();
    rootEl.appendChild(header);

    const body = el('div', { class: 'enc-tree-body' });
    for (const node of tree.roots) body.appendChild(rowFor(node, 0));
    rootEl.appendChild(body);

    rootEl.appendChild(hintBox(T('tree.hint')));

    rootEl.scrollTop = scrollTop;
  };

  const panelLikeHeader = () => {
    const h = el('div', { class: 'pan-header enc-tree-header' });
    h.appendChild(el('span', { class: 'pan-title', text: T('tree.title') }));
    return h;
  };

  /* ---------------- 生命週期 ---------------- */

  const relabel = () => {
    if (state.destroyed) return;
    rootEl.setAttribute('aria-label', T('tree.aria'));
    render(true);
  };

  render();

  if (store && typeof store.subscribe === 'function') {
    const unsub = store.subscribe(() => {
      if (state.destroyed) return;
      render();
    });
    state.unsub = typeof unsub === 'function' ? unsub : null;
  }
  state.unsubLocale = onLocaleChange(() => relabel());

  const controller = {
    destroy() {
      state.destroyed = true;
      if (typeof state.unsub === 'function') state.unsub();
      if (typeof state.unsubLocale === 'function') state.unsubLocale();
      clear(rootEl);
      rootEl.classList.remove('enc-tree');
      instances.delete(rootEl);
    },
    refresh: () => render(true),
    get tree() {
      return state.tree;
    },
    /** 目前選取的 cue 清單路徑（本地後備也包含）。 */
    get cuePath() {
      return readCuePath(store, local);
    },
  };
  instances.set(rootEl, controller);
  return controller;
}

/* =========================================================================
 * 10. 額外匯出（給檢查器 / 演員編輯器共用）
 * ========================================================================= */

export { T as tEnc, ICONS as NODE_ICONS };
export default { mount, buildTree };
