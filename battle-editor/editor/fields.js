// editor/fields.js  (ED3) — 共用欄位元件與純邏輯工具
//
// 本檔分兩層：
//   1. 純邏輯（不碰 DOM）：路徑字串 ↔ 物件存取、表達式判斷、事件欄位表、
//      重新命名引用更新 …等，export 給 node 測試（editor/panels.test.mjs）使用。
//   2. DOM 元件：小型 helper + 欄位工廠（number / select / color / text …），
//      供 inspector.js / bullet-types.js / assets-panel.js 使用。
//
// 約定：
//   - 欄位工廠都回傳 { el, setValue, setError }，讓面板重繪時能就地更新。
//   - 任何會寫入 store 的操作由呼叫端負責；本檔只提供 controls。
//   - 本檔不假設 ctx 形狀，面板各自把 ctx 傳進來。

import { t, registerStrings } from './i18n.js';
import PANELS from './locales/panels.js';
import { soulT } from './locales/soul.js';
// 時間欄位（秒／拍點字串）沿用編輯器/引擎共用的拍點解析（SPEC-EXPR-V2 §2）。
import { formatSeconds, normalizeTiming, parseTime } from './beat.js';
// 戰鬥框／靈魂預設值一律取自引擎（SPEC-LAYOUT §5 實機量測），不在編輯器複製數字。
import { BOX_DEFAULTS, SOUL_DEFAULTS } from '../engine/attack.js';

registerStrings('fields', PANELS.fields);

/** 本檔命名空間的取字串捷徑（動態解析，切換語系後會拿到新值）。 */
const T = (key, params) => t(`fields.${key}`, params);

/* =========================================================================
 * 1. 純邏輯
 * ========================================================================= */

/** 值是否為「表達式」（非 null、非空字串的字串）。 */
export function isExpr(v) {
  return typeof v === 'string' && v.trim() !== '';
}

/** 純數字字串（"3"、"-1.5"、"1e3"）。 */
const NUMERIC_STRING_RE = /^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/;

/**
 * 數字／表達式雙模式判定。回傳 'expr' | 'number'。
 * 純數字字串（"3"）視為數字模式——要寫常數表達式請用 "3+0"。
 */
export function modeOf(v) {
  if (isExpr(v)) return NUMERIC_STRING_RE.test(v.trim()) ? 'number' : 'expr';
  return 'number';
}

/** 數字字串轉數字；失敗回傳 fallback。 */
export function toNumber(v, fallback = 0) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

/**
 * 路徑字串解析成 token 陣列（數字 → number index，識別字 → string key）。
 * 支援 `timeline[3].spawn.angle`、`bulletTypes.spade.hitbox.r`、`meta["name"]`。
 * 非法輸入回傳 []（呼叫端可用來驗證）。
 */
export function parsePath(path) {
  if (typeof path !== 'string') return [];
  const s = path.trim();
  if (s === '') return [];
  const tokens = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '.' || c === ' ' || c === '\t') { i += 1; continue; }
    if (c === '[') {
      const j = s.indexOf(']', i);
      if (j < 0) return [];
      const inner = s.slice(i + 1, j).trim();
      if (/^\d+$/.test(inner)) tokens.push(Number(inner));
      else if (/^'[^']*'$/.test(inner)) tokens.push(inner.slice(1, -1));
      else if (/^"[^"]*"$/.test(inner)) tokens.push(inner.slice(1, -1));
      else return [];
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
    if (!m) return [];
    tokens.push(m[0]);
    i += m[0].length;
  }
  return tokens;
}

/** token 陣列轉回標準路徑：['timeline',3,'spawn','angle'] → "timeline[3].spawn.angle" */
export function formatPath(tokens) {
  if (!Array.isArray(tokens) || tokens.length === 0) return '';
  let out = '';
  for (const tok of tokens) {
    if (typeof tok === 'number') { out += `[${tok}]`; continue; }
    const key = String(tok);
    if (/^\d+$/.test(key)) out += `[${key}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(key)) out += out === '' ? key : `.${key}`;
    else out += `[${JSON.stringify(key)}]`;
  }
  return out;
}

/** 安全讀取深層屬性；找不到回傳 undefined。 */
export function getPath(obj, path) {
  const tokens = Array.isArray(path) ? path : parsePath(path);
  let cur = obj;
  for (const tok of tokens) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[tok];
  }
  return cur;
}

/**
 * 安全寫入深層屬性（就地修改），缺少的中間層自動建立（陣列或物件）。
 * 回傳 true 表示成功。
 */
export function setPath(obj, path, value) {
  const tokens = Array.isArray(path) ? path : parsePath(path);
  if (obj === null || obj === undefined || tokens.length === 0) return false;
  let cur = obj;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const tok = tokens[i];
    const nextTok = tokens[i + 1];
    if (cur[tok] === null || typeof cur[tok] !== 'object') {
      cur[tok] = typeof nextTok === 'number' ? [] : {};
    }
    cur = cur[tok];
  }
  cur[tokens[tokens.length - 1]] = value;
  return true;
}

/** 刪除深層屬性（就地）；回傳 true 表示有刪到。 */
export function deletePath(obj, path) {
  const tokens = Array.isArray(path) ? path : parsePath(path);
  if (obj === null || obj === undefined || tokens.length === 0) return false;
  let cur = obj;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const tok = tokens[i];
    if (cur === null || typeof cur !== 'object') return false;
    cur = cur[tok];
  }
  if (cur === null || typeof cur !== 'object') return false;
  const last = tokens[tokens.length - 1];
  if (!(last in cur)) return false;
  if (Array.isArray(cur) && typeof last === 'number') cur.splice(last, 1);
  else delete cur[last];
  return true;
}

/** 父層路徑："a.b.c" → "a.b"。 */
export function parentPath(path) {
  const tokens = Array.isArray(path) ? path : parsePath(path);
  if (tokens.length <= 1) return '';
  return formatPath(tokens.slice(0, -1));
}

/** 陣列元素路徑：elementPath('timeline', 3) → "timeline[3]" */
export function elementPath(base, index) {
  return `${base}[${index}]`;
}

/* ---------- 子彈類型重新命名：引用掃描與更新（純邏輯） ------------------ */

/**
 * 收集所有引用某 bulletType 的位置。
 * 回傳 [{ path, kind, eventId, eventIndex, field }]
 *   spawn   → 讀 ev.bullet 與 ev.spawn.bullet
 *   emitter → 讀 ev.spawn.bullet（也容錯讀 ev.bullet）
 */
export function findBulletTypeRefs(attack, oldName) {
  const refs = [];
  const timeline = Array.isArray(attack?.timeline) ? attack.timeline : [];
  timeline.forEach((ev, i) => {
    if (!ev || typeof ev !== 'object') return;
    const push = (suffix, kind) => {
      refs.push({
        path: suffix === 'bullet' ? `timeline[${i}].bullet` : `timeline[${i}].spawn.bullet`,
        kind,
        eventId: ev.id ?? null,
        eventIndex: i,
        field: suffix === 'bullet' ? 'bullet' : 'spawn.bullet',
      });
    };
    if (ev.bullet === oldName && (ev.type === 'spawn' || ev.type === 'emitter')) push('bullet', ev.type);
    const sp = ev.spawn;
    if (sp && typeof sp === 'object' && sp.bullet === oldName && (ev.type === 'spawn' || ev.type === 'emitter')) push('spawnBullet', ev.type);
  });
  return refs;
}

/** 就地更新所有引用（呼叫端負責先 clone）；回傳修改筆數。 */
export function renameBulletTypeRefs(attack, oldName, newName) {
  const refs = findBulletTypeRefs(attack, oldName);
  for (const ref of refs) setPath(attack, ref.path, newName);
  return refs.length;
}

/**
 * 是否能安全改名：newName 非空、oldName 存在、newName 未被佔用。
 * 回傳 { ok, reason }
 */
export function canRenameBulletType(attack, oldName, newName) {
  const types = attack?.bulletTypes && typeof attack.bulletTypes === 'object' ? attack.bulletTypes : {};
  if (typeof newName !== 'string' || newName.trim() === '') return { ok: false, reason: T('rename.empty'), code: 'empty' };
  const n = newName.trim();
  if (n === oldName) return { ok: false, reason: T('rename.unchanged'), code: 'unchanged' };
  if (!Object.prototype.hasOwnProperty.call(types, oldName)) return { ok: false, reason: T('rename.missing', { name: oldName }), code: 'missing' };
  if (Object.prototype.hasOwnProperty.call(types, n)) return { ok: false, reason: T('rename.exists', { name: n }), code: 'exists' };
  return { ok: true, reason: '', code: '' };
}

/**
 * 在 draft 上改名：搬移 bulletTypes 的鍵並更新所有 timeline 引用。
 * 回傳 { ok, renamedRefs, reason }；失敗時 draft 可能已被部分修改，呼叫端應丟棄 draft。
 */
export function applyBulletTypeRename(draft, oldName, newName) {
  const check = canRenameBulletType(draft, oldName, newName);
  if (!check.ok) return { ok: false, renamedRefs: 0, reason: check.reason };
  const n = newName.trim();
  const types = draft.bulletTypes;
  // 保留原本的鍵順序：重建物件
  const rebuilt = {};
  for (const key of Object.keys(types)) {
    rebuilt[key === oldName ? n : key] = types[key];
  }
  draft.bulletTypes = rebuilt;
  const count = renameBulletTypeRefs(draft, oldName, n);
  return { ok: true, renamedRefs: count, reason: '' };
}

/* ---------- 事件欄位表（SPEC §4、§5） ---------------------------------- */

export const EASE_OPTIONS = ['linear', 'quadIn', 'quadOut', 'quadInOut', 'sineInOut', 'backOut'];

/** 生成欄位（spawn / emitter.spawn）。SPEC §5 */
export const SPAWN_FIELDS = [
  { key: 'x', label: 'X', kind: 'num', def: 320, step: 1, drag: 1, min: -4000, max: 4000 },
  { key: 'y', label: 'Y', kind: 'num', def: 120, step: 1, drag: 1, min: -4000, max: 4000 },
  { key: 'speed', get label() { return T('spawn.speed'); }, kind: 'num', def: 3, step: 0.1, drag: 0.1, min: -100, max: 100, get unit() { return T('unit.pxPerFrame'); } },
  { key: 'angle', get label() { return T('spawn.angle'); }, kind: 'num', def: 90, step: 1, drag: 1, get unit() { return T('unit.deg'); } },
  { key: 'accel', get label() { return T('spawn.accel'); }, kind: 'num', def: 0, step: 0.05, drag: 0.02 },
  { key: 'angularVel', get label() { return T('spawn.angularVel'); }, kind: 'num', def: 0, step: 0.5, drag: 0.5, get unit() { return T('unit.degPerFrame'); } },
  { key: 'scale', get label() { return T('spawn.scale'); }, kind: 'num', def: 1, step: 0.05, drag: 0.02, min: 0, max: 20 },
  { key: 'rotation', get label() { return T('spawn.rotation'); }, kind: 'num', def: 0, step: 1, drag: 1, get unit() { return T('unit.deg'); } },
  { key: 'life', get label() { return T('spawn.life'); }, kind: 'time', timeMode: 'length', def: null, step: 0.1, drag: 0.02, min: 0, nullable: true, get nullLabel() { return T('spawn.lifeUnlimited'); }, get unit() { return T('unit.sec'); } },
  { key: 'alpha', get label() { return T('spawn.alpha'); }, kind: 'num', def: 1, step: 0.05, drag: 0.01, min: 0, max: 1 },
  { key: 'pathX', label: 'pathX', kind: 'num', def: null, exprOnly: true, min: null, max: null, get hint() { return T('spawn.pathXHint'); } },
  { key: 'pathY', label: 'pathY', kind: 'num', def: null, exprOnly: true, min: null, max: null, get hint() { return T('spawn.pathYHint'); } },
  { key: 'pathScale', label: 'pathScale', kind: 'num', def: null, exprOnly: true, min: null, max: null, get hint() { return T('spawn.pathScaleHint'); } },
  { key: 'pathAlpha', label: 'pathAlpha', kind: 'num', def: null, exprOnly: true, min: null, max: null, get hint() { return T('spawn.pathAlphaHint'); } },
  { key: 'pathZ', label: 'pathZ', kind: 'num', def: null, exprOnly: true, min: null, max: null, get hint() { return T('spawn.pathZHint'); } },
  { key: 'pathFrame', label: 'pathFrame', kind: 'num', def: null, exprOnly: true, min: null, max: null, get hint() { return T('spawn.pathFrameHint'); } },
  { key: 'pathRotation', label: 'pathRotation', kind: 'num', def: null, exprOnly: true, min: null, max: null, get hint() { return T('spawn.pathRotationHint'); } },
  { key: 'solidWhen', label: 'solidWhen', kind: 'num', def: null, exprOnly: true, min: null, max: null, get hint() { return T('spawn.solidWhenHint'); } },
];

export const SPAWN_FIELD_BY_KEY = Object.fromEntries(SPAWN_FIELDS.map((f) => [f.key, f]));

/** 生成欄位預設值物件。 */
export function defaultSpawnValues() {
  const out = {};
  for (const f of SPAWN_FIELDS) out[f.key] = f.def;
  return out;
}

/** box 事件的目標欄位（to）。 */
export const BOX_TO_FIELDS = [
  { key: 'x', label: 'X', kind: 'num', def: BOX_DEFAULTS.x, step: 1, drag: 1 },
  { key: 'y', label: 'Y', kind: 'num', def: BOX_DEFAULTS.y, step: 1, drag: 1 },
  { key: 'w', get label() { return T('box.w'); }, kind: 'num', def: BOX_DEFAULTS.w, step: 1, drag: 1, min: 1 },
  { key: 'h', get label() { return T('box.h'); }, kind: 'num', def: BOX_DEFAULTS.h, step: 1, drag: 1, min: 1 },
  { key: 'rotation', get label() { return T('box.rotation'); }, kind: 'num', def: BOX_DEFAULTS.rotation, step: 1, drag: 1, get unit() { return T('unit.deg'); } },
];

/** 每個事件型別的欄位描述（SPEC §4）。sections 描述巢狀區塊。 */
export const EVENT_SPECS = {
  spawn: {
    get label() { return T('typeName.spawn'); },
    fields: [
      { key: 'bullet', get label() { return T('ev.spawn.bullet'); }, kind: 'bullet' },
      { key: 'count', get label() { return T('ev.spawn.count'); }, kind: 'num', def: 1, step: 1, drag: 0.25, min: 0, max: 9999 },
    ],
    sections: [{ get title() { return T('ev.section.spawn'); }, kind: 'spawn', prefix: '' }],
  },
  emitter: {
    get label() { return T('typeName.emitter'); },
    fields: [
      { key: 'duration', get label() { return T('ev.emitter.duration'); }, kind: 'time', timeMode: 'length', def: 1, step: 0.1, drag: 0.05, min: 0, get unit() { return T('unit.sec'); } },
      { key: 'interval', get label() { return T('ev.emitter.interval'); }, kind: 'time', timeMode: 'length', def: 0.2, step: 0.01, drag: 0.005, min: 0.001, get unit() { return T('unit.sec'); } },
      { key: 'count', get label() { return T('ev.emitter.count'); }, kind: 'num', def: 1, step: 1, drag: 0.25, min: 0, max: 9999 },
    ],
    sections: [{ get title() { return T('ev.section.spawn'); }, kind: 'spawn', prefix: 'spawn' }],
  },
  box: {
    get label() { return T('typeName.box'); },
    fields: [
      { key: 'duration', get label() { return T('ev.box.duration'); }, kind: 'time', timeMode: 'length', def: 0.5, step: 0.1, drag: 0.05, min: 0, get unit() { return T('unit.sec'); } },
      { key: 'ease', get label() { return T('ev.box.ease'); }, kind: 'select', options: EASE_OPTIONS, def: 'linear' },
    ],
    sections: [{ get title() { return T('ev.section.boxTo'); }, kind: 'boxTo', prefix: 'to' }],
  },
  soul: {
    get label() { return T('typeName.soul'); },
    fields: [
      { key: 'mode', get label() { return T('ev.soul.mode'); }, kind: 'select', options: ['red'], allowNull: true, get nullLabel() { return T('ev.soul.modeUnchanged'); } },
      { key: 'x', label: 'X', kind: 'num', def: null, step: 1, drag: 1, nullable: true, get nullLabel() { return T('ev.soul.boxCenter'); } },
      { key: 'y', label: 'Y', kind: 'num', def: null, step: 1, drag: 1, nullable: true, get nullLabel() { return T('ev.soul.boxCenter'); } },
      { key: 'color', get label() { return T('ev.soul.color'); }, kind: 'color', def: null, nullable: true },
    ],
  },
  soulProfile: { get label() { return soulT('profile'); }, fields: [] },
  soulAppearance: { get label() { return soulT('appearance'); }, fields: [] },
  soulTeleport: {
    get label() { return soulT('teleport'); },
    fields: [
      { key: 'x', label: 'X', kind: 'num', def: 320, step: 1, drag: 1 },
      { key: 'y', label: 'Y', kind: 'num', def: 171, step: 1, drag: 1 },
    ],
  },
  clear: {
    get label() { return T('typeName.clear'); },
    fields: [
      { key: 'fade', get label() { return T('ev.clear.fade'); }, kind: 'time', timeMode: 'length', def: 0, step: 0.05, drag: 0.01, min: 0, get unit() { return T('unit.sec'); } },
    ],
  },
  shake: {
    get label() { return T('typeName.shake'); },
    fields: [
      { key: 'duration', get label() { return T('ev.shake.duration'); }, kind: 'time', timeMode: 'length', def: 0.3, step: 0.05, drag: 0.02, min: 0, get unit() { return T('unit.sec'); } },
      { key: 'amount', get label() { return T('ev.shake.amount'); }, kind: 'num', def: 4, step: 0.5, drag: 0.25, min: 0, max: 999, get unit() { return T('unit.px'); } },
    ],
  },
  sfx: {
    get label() { return T('typeName.sfx'); },
    fields: [
      { key: 'sound', get label() { return T('ev.sfx.sound'); }, kind: 'text', def: '', get hint() { return T('ev.sfx.hint'); } },
    ],
  },
  anim: {
    get label() { return T('typeName.anim'); },
    fields: [
      { key: 'actor', get label() { return T('ev.anim.actor'); }, kind: 'text', def: '' },
      { key: 'anim', get label() { return T('ev.anim.name'); }, kind: 'text', def: '', get hint() { return T('ev.anim.hint'); } },
    ],
  },
  end: {
    get label() { return T('typeName.end'); },
    fields: [],
  },
};

/** 事件共同欄位（所有型別都有）。 */
export const EVENT_COMMON_FIELDS = [
  { key: 'id', label: 'ID', kind: 'readonly' },
  { key: 'at', get label() { return T('ev.common.at'); }, kind: 'time', timeMode: 'point', def: 0, step: 0.05, drag: 0.02, min: 0, get unit() { return T('unit.sec'); } },
  { key: 'label', get label() { return T('ev.common.label'); }, kind: 'text', def: '', get placeholder() { return T('ev.common.labelPlaceholder'); } },
];

/** 依事件型別取得欄位描述；未知型別回傳 null。 */
export function eventSpecOf(type) {
  return Object.prototype.hasOwnProperty.call(EVENT_SPECS, type) ? EVENT_SPECS[type] : null;
}

/** 事件型別的人類可讀名稱。 */
export function eventTypeLabel(type) {
  if (type && Object.prototype.hasOwnProperty.call(EVENT_SPECS, type)) return EVENT_SPECS[type].label;
  return type || T('typeName.unknown');
}

/* ---------- 錯誤查詢 ---------------------------------------------- */

/** 把 store.errors（Map 或 plain object）正規化成 Map。 */
export function normalizeErrors(errors) {
  if (errors instanceof Map) return errors;
  if (errors && typeof errors === 'object') return new Map(Object.entries(errors));
  return new Map();
}

/**
 * 判斷一組候選 key 是否有錯（完全相符）。
 * 回傳 { hasError, message, exact, key }。
 */
export function lookupError(errors, paths) {
  const map = normalizeErrors(errors);
  const list = Array.isArray(paths) ? paths : [paths];
  for (const p of list) {
    if (p === null || p === undefined) continue;
    const key = typeof p === 'string' ? p : formatPath(p);
    if (key && map.has(key)) return { hasError: true, message: map.get(key), exact: true, key };
  }
  return { hasError: false, message: '', exact: false, key: '' };
}

/**
 * 以路徑前綴查詢（父層標紅用）。
 * withPrefix(errors, 'timeline[3]') 會匹配 'timeline[3].spawn.angle'。
 */
export function lookupErrorPrefix(errors, prefix) {
  const map = normalizeErrors(errors);
  if (prefix === null || prefix === undefined) return { hasError: false, message: '', key: '' };
  const key = typeof prefix === 'string' ? prefix : formatPath(prefix);
  if (key === '') return { hasError: false, message: '', key: '' };
  let found = { hasError: false, message: '', key: '' };
  for (const [k, msg] of map) {
    if (k === key) return { hasError: true, message: msg, key: k };
    if (!found.hasError && (k.startsWith(`${key}.`) || k.startsWith(`${key}[`))) found = { hasError: true, message: msg, key: k };
  }
  return found;
}

/** 判斷 object 是否有任何錯誤 key 以 prefix 開頭。 */
export function hasErrorUnder(errors, prefix) {
  return lookupErrorPrefix(errors, prefix).hasError;
}

/* ---------- 表達式說明（SPEC §5） -------------------------------------- */

export const EXPR_VARIABLES = [
  { name: 't', get desc() { return T('exprVar.t'); } },
  { name: 'T', get desc() { return T('exprVar.T'); } },
  { name: 'i', get desc() { return T('exprVar.i'); } },
  { name: 'n', get desc() { return T('exprVar.n'); } },
  { name: 'k', get desc() { return T('exprVar.k'); } },
  { name: 'age', get desc() { return T('exprVar.age'); } },
  { name: 'box.x box.y box.w box.h', get desc() { return T('exprVar.box'); } },
  { name: 'box.rotation', get desc() { return T('exprVar.boxRotation'); } },
  { name: 'box.left right top bottom', get desc() { return T('exprVar.boxEdges'); } },
  { name: 'soul.x soul.y', get desc() { return T('exprVar.soul'); } },
];

export const EXPR_FUNCTIONS = [
  { name: 'sin cos tan', get desc() { return T('exprFn.trig'); } },
  { name: 'atan2(y,x)', get desc() { return T('exprFn.atan2'); } },
  { name: 'sqrt abs min max', get desc() { return T('exprFn.math'); } },
  { name: 'floor ceil round', get desc() { return T('exprFn.round'); } },
  { name: 'lerp(a,b,u)', get desc() { return T('exprFn.lerp'); } },
  { name: 'rand(a,b)', get desc() { return T('exprFn.rand'); } },
  { name: 'pick(...)', get desc() { return T('exprFn.pick'); } },
  { name: 'aim(x,y)', get desc() { return T('exprFn.aim'); } },
  { name: 'trailX(s) trailY(s)', get desc() { return T('exprFn.trail'); } },
  { name: 'PI', get desc() { return T('exprFn.PI'); } },
];

/** 基本語法檢查（括號／引號平衡、非空）。回傳 null 表示 OK，否則回傳錯誤訊息。 */
export function checkExprSyntax(src) {
  if (typeof src !== 'string') return T('errExprNotString');
  const s = src.trim();
  if (s === '') return T('errExprEmpty');
  const stack = [];
  let quote = null;
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i];
    if (quote) {
      if (c === '\\') { i += 1; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
    if (c === '(' || c === '[' || c === '{') stack.push(c);
    else if (c === ')' || c === ']' || c === '}') {
      const open = stack.pop();
      const ok = (open === '(' && c === ')') || (open === '[' && c === ']') || (open === '{' && c === '}');
      if (!ok) return T('errExprUnbalanced', { ch: c });
    }
  }
  if (quote) return T('errExprUnclosedQuote');
  if (stack.length) return T('errExprUnclosedParen');
  if (/[\u4e00-\u9fff]/.test(s.replace(/(["'`])(?:\\.|(?!\1)[^\\])*\1/g, ''))) return T('errExprChinese');
  return null;
}

/** 表達式預覽用的假 scope（僅 UI 顯示 ≈ 值，不代表引擎結果）。 */
export const EXPR_PREVIEW_SCOPE = {
  t: 0, T: 8, i: 0, n: 1, k: 0, age: 0, PI: Math.PI,
  box: {
    x: BOX_DEFAULTS.x,
    y: BOX_DEFAULTS.y,
    w: BOX_DEFAULTS.w,
    h: BOX_DEFAULTS.h,
    left: BOX_DEFAULTS.x - BOX_DEFAULTS.w / 2,
    right: BOX_DEFAULTS.x + BOX_DEFAULTS.w / 2,
    top: BOX_DEFAULTS.y - BOX_DEFAULTS.h / 2,
    bottom: BOX_DEFAULTS.y + BOX_DEFAULTS.h / 2,
  },
  // soul 預設在框中心（engine/attack.js 的 SOUL_DEFAULTS：x/y = null → 框中心）
  soul: {
    x: Number.isFinite(SOUL_DEFAULTS.x) ? SOUL_DEFAULTS.x : BOX_DEFAULTS.x,
    y: Number.isFinite(SOUL_DEFAULTS.y) ? SOUL_DEFAULTS.y : BOX_DEFAULTS.y,
  },
  sin: (d) => Math.sin((d * Math.PI) / 180),
  cos: (d) => Math.cos((d * Math.PI) / 180),
  tan: (d) => Math.tan((d * Math.PI) / 180),
  atan2: (y, x) => (Math.atan2(y, x) * 180) / Math.PI,
  sqrt: Math.sqrt, abs: Math.abs, min: Math.min, max: Math.max,
  floor: Math.floor, ceil: Math.ceil, round: Math.round,
  lerp: (a, b, u) => a + (b - a) * u,
  rand: (a, b) => (a + b) / 2,
  pick: (...args) => (args.length ? args[0] : 0),
  aim: () => 90,
  trailX: () => (Number.isFinite(SOUL_DEFAULTS.x) ? SOUL_DEFAULTS.x : BOX_DEFAULTS.x),
  trailY: () => (Number.isFinite(SOUL_DEFAULTS.y) ? SOUL_DEFAULTS.y : BOX_DEFAULTS.y),
};

/**
 * 編輯器端的表達式「試算」（寬鬆版，僅供提示；正式求值在引擎）。
 * 回傳 { ok, value, error }。
 */
export function tryEvaluateExpr(src, scope = EXPR_PREVIEW_SCOPE) {
  const syntax = checkExprSyntax(src);
  if (syntax) return { ok: false, value: 0, error: syntax };
  try {
    const fn = new Function('s', `with (s) { return (${src}); }`);
    const v = fn(scope);
    if (typeof v !== 'number' || !Number.isFinite(v)) return { ok: false, value: 0, error: T('errExprNotFinite') };
    return { ok: true, value: v, error: null };
  } catch (e) {
    return { ok: false, value: 0, error: (e && e.message) || String(e) };
  }
}

/** 依 spec 夾範圍。 */
export function clampSpec(n, spec = {}) {
  let v = n;
  if (typeof spec.min === 'number') v = Math.max(spec.min, v);
  if (typeof spec.max === 'number') v = Math.min(spec.max, v);
  return v;
}

/** 去掉浮點誤差尾巴。 */
export function roundNice(n, digits = 4) {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** digits;
  const r = Math.round(n * f) / f;
  return Object.is(r, -0) ? 0 : r;
}

/** 為欄位組候選錯誤 key：完整路徑、事件 id 變體（ED1 可能用 id 當 key）。 */
export function fieldErrorKeys(basePath, eventId, fieldKey) {
  const keys = [];
  if (basePath) keys.push(`${basePath}.${fieldKey}`);
  if (eventId) {
    keys.push(`${eventId}.${fieldKey}`);
    keys.push(`${eventId}:${fieldKey}`);
  }
  return keys;
}

/* =========================================================================
 * 2. DOM
 * ========================================================================= */

export const SVG_NS = 'http://www.w3.org/2000/svg';

/** el('div', {class:'x'}, [child]) */
export function el(tag, attrs = null, children = null) {
  const node = document.createElement(tag);
  if (attrs) applyAttrs(node, attrs);
  appendChildren(node, children);
  return node;
}

/** SVG 元素建立（attr 一律用 setAttribute）。 */
export function svgEl(tag, attrs = null, children = null) {
  const node = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      node.setAttribute(k, String(v));
    }
  }
  appendChildren(node, children);
  return node;
}

function appendChildren(node, children) {
  if (children === null || children === undefined) return;
  if (!Array.isArray(children)) { node.appendChild(toNode(children)); return; }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(toNode(c));
  }
}

function toNode(c) {
  return typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c;
}

function applyAttrs(node, attrs) {
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    switch (k) {
      case 'class': node.className = v; break;
      case 'text': node.textContent = v; break;
      case 'html': node.innerHTML = v; break;
      case 'style': node.setAttribute('style', typeof v === 'string' ? v : styleStr(v)); break;
      case 'dataset':
        for (const [dk, dv] of Object.entries(v)) { if (dv !== null && dv !== undefined) node.dataset[dk] = String(dv); }
        break;
      case 'value': node.value = v; break;
      case 'checked': case 'disabled': case 'selected': case 'hidden': node[k] = !!v; break;
      default:
        if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
        else if (v === true) node.setAttribute(k, '');
        else node.setAttribute(k, String(v));
    }
  }
}

function styleStr(obj) {
  return Object.entries(obj).map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${v}`).join(';');
}

/** 清空子節點。 */
export function clear(node) {
  if (!node) return node;
  // 先快照再逐一移除：移除聚焦中的控制項會同步派送 blur／change 回呼，
  // 回呼可能（間接）再次改動 DOM，用 firstChild 邊走邊移除會拿到已脫離的子節點。
  // （測試用的簡化 DOM 可能沒有 childNodes，退回原本的 firstChild 迴圈。）
  const kids = node.childNodes ? Array.prototype.slice.call(node.childNodes) : null;
  if (kids) {
    for (const kid of kids) {
      if (kid.parentNode !== node) continue;
      try {
        node.removeChild(kid);
      } catch (_err) {
        // 移除聚焦元素會同步派送 blur，處理常式可能已經把節點搬走／移除；
        // 這種情況代表它已經不在畫面上，忽略即可。
      }
    }
  }
  // 保險：回呼造成的殘留
  while (node.firstChild && node.firstChild.parentNode === node) {
    try {
      node.removeChild(node.firstChild);
    } catch (_err) {
      break;
    }
  }
  return node;
}

/** 建立按鈕。 */
export function button(label, opts = {}) {
  const b = el('button', {
    type: 'button',
    class: `pan-btn${opts.variant ? ` pan-btn-${opts.variant}` : ''}${opts.small ? ' pan-btn-small' : ''}${opts.class ? ` ${opts.class}` : ''}`,
    text: label,
    title: opts.title || null,
  });
  if (opts.title) b.title = opts.title;
  b.disabled = !!opts.disabled;
  if (opts.onClick) b.addEventListener('click', opts.onClick);
  return b;
}

/** 建立 <select>。options: [v] | [{value,label}] ；value 可為 null。 */
export function selectEl(options, value, onChange, opts = {}) {
  const s = el('select', { class: `pan-select${opts.class ? ` ${opts.class}` : ''}` });
  for (const opt of options) {
    let v; let label;
    if (opt && typeof opt === 'object' && !Array.isArray(opt)) { v = opt.value; label = opt.label ?? String(opt.value); }
    else { v = opt; label = opt === null ? (opts.nullLabel ?? T('selectUnset')) : String(opt); }
    s.appendChild(el('option', { value: v === null || v === undefined ? '' : String(v), text: label }));
  }
  s.value = value === null || value === undefined ? '' : String(value);
  s.addEventListener('change', () => {
    const raw = s.value;
    if (opts.number) onChange(raw === '' ? null : Number(raw));
    else if (raw === '' && opts.allowNull) onChange(null);
    else onChange(raw);
  });
  return s;
}

/** checkbox；回傳 wrapper（含 setChecked）。 */
export function checkboxEl(checked, onChange, label = null) {
  const wrap = el('label', { class: 'pan-check-wrap' });
  const input = el('input', { type: 'checkbox', class: 'pan-check' });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(!!input.checked));
  wrap.appendChild(input);
  if (label) wrap.appendChild(el('span', { class: 'pan-check-label', text: label }));
  wrap.setChecked = (v) => { input.checked = !!v; };
  wrap.input = input;
  return wrap;
}

/** A compact numeric input for a coordinate in an ordered list of points. */
export function coordinateField({ value, max, label, onChange }) {
  const input = el('input', {
    type: 'number', class: 'pan-input pan-demo-cell', min: 0, max, step: 'any',
    'aria-label': label, title: label,
  });
  const setValue = (v) => {
    value = v;
    input.value = Number.isFinite(v) ? String(v) : '';
  };
  setValue(value);
  input.addEventListener('change', () => {
    const entered = input.valueAsNumber;
    const next = Number.isFinite(entered) ? Math.min(max, Math.max(0, entered)) : value;
    const changed = !Object.is(value, next);
    setValue(next);
    if (changed) onChange(next);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    e.preventDefault();
    if (e.key === 'Escape') setValue(value);
    input.blur();
  });
  return { el: input, setValue };
}

/** 文字輸入；回傳 input（含 Enter/Esc 處理）。 */
export function textInput(value, onChange, opts = {}) {
  const input = el('input', {
    type: 'text',
    class: `pan-input${opts.mono ? ' pan-input-mono' : ''}${opts.class ? ` ${opts.class}` : ''}`,
    placeholder: opts.placeholder || null,
    spellcheck: 'false',
    autocomplete: 'off',
  });
  input.value = value === null || value === undefined ? '' : String(value);
  const commit = () => onChange(input.value);
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); }
    if (e.key === 'Escape') { input.value = value === null || value === undefined ? '' : String(value); input.blur(); }
  });
  return input;
}

/** 顏色輸入 + 清除（null）。回傳 { el, setValue }。 */
export function colorField(value, onChange, opts = {}) {
  const wrap = el('div', { class: 'pan-colorfield' });
  const input = el('input', { type: 'color', class: 'pan-color' });
  const hex = normalizeHex(value) || '#ffffff';
  input.value = hex;
  input.addEventListener('input', () => onChange(input.value));
  input.addEventListener('change', () => onChange(input.value));
  wrap.appendChild(input);
  const txt = el('input', { type: 'text', class: 'pan-input pan-input-mono pan-color-hex', maxlength: '7' });
  txt.value = value === null || value === undefined ? '' : String(value);
  txt.placeholder = opts.placeholder || '#rrggbb';
  txt.addEventListener('change', () => {
    const raw = txt.value.trim();
    if (raw === '') { onChange(null); return; }
    const norm = normalizeHex(raw);
    if (!norm) { txt.value = value ?? ''; return; }
    txt.value = norm;
    input.value = norm;
    onChange(norm);
  });
  wrap.appendChild(txt);
  const clr = button(T('btn.clear'), { small: true, title: T('clearNull'), onClick: () => { txt.value = ''; onChange(null); } });
  wrap.appendChild(clr);
  if (opts.nullable !== true) clr.classList.add('hidden');
  wrap.setValue = (v) => {
    const n = normalizeHex(v) || '#ffffff';
    input.value = n;
    txt.value = v === null || v === undefined ? '' : String(v);
  };
  wrap.isEditing = () => wrap.contains(document.activeElement);
  return wrap;
}

/** "#abc" / "0x00c000" / "00c000" → "#00c000"；非法回傳 null。 */
export function normalizeHex(v) {
  if (typeof v !== 'string') return null;
  let s = v.trim().toLowerCase();
  if (s === '') return null;
  if (s.startsWith('#')) s = s.slice(1);
  else if (s.startsWith('0x')) s = s.slice(2);
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(s)) return null;
  return `#${s}`;
}

/* ---------- sprite 欄位（文字 + 素材挑選器 + 拖放） -------------------- */

/**
 * 跨面板拖曳的 payload 後備：部分瀏覽器／無頭環境的 DragEvent 可能不帶
 * dataTransfer，或 drop 階段拿不到 getData，因此 dragstart 時在模組層記一份。
 * 素材瀏覽器寫入，檢查器讀取（仍以 dataTransfer 為第一優先）。
 */
export const dragState = { sprite: null };

/** 依 ctx.assets 取得 sprite 名稱清單（可能為 null）。 */
export function spriteNamesOf(assets) {
  const sprites = assets && assets.index && assets.index.sprites;
  return sprites && typeof sprites === 'object' ? Object.keys(sprites).sort() : [];
}

/**
 * sprite 欄位：文字輸入 + 「選」彈出挑選器 + 接受素材瀏覽器拖放。
 * opts: { value, onChange(name|null), assets, nullable }
 * 回傳 { el, setValue, setError, openPicker }
 */
export function spriteField(opts) {
  const wrap = el('div', { class: 'pan-spritefield' });
  const input = el('input', { type: 'text', class: 'pan-input pan-input-mono', placeholder: opts.placeholder || T('spritePlaceholder'), spellcheck: 'false', autocomplete: 'off' });
  input.value = opts.value === null || opts.value === undefined ? '' : String(opts.value);
  const pickBtn = button(T('btn.pick'), { small: true, title: T('pickFromIndex'), onClick: () => togglePicker() });
  const clr = button(T('btn.clear'), { small: true, title: T('clearNull'), onClick: () => { input.value = ''; emit(null); } });
  if (!opts.nullable) clr.classList.add('hidden');
  wrap.appendChild(input);
  wrap.appendChild(pickBtn);
  wrap.appendChild(clr);

  const errEl = el('div', { class: 'pan-field-error' });
  const holder = el('div', { class: 'pan-field pan-field-sprite' });
  holder.appendChild(wrap);
  holder.appendChild(errEl);

  let picker = null;
  const emit = (v) => opts.onChange?.(v === '' ? (opts.nullable ? null : '') : v);
  const closePicker = () => { if (picker) { picker.remove(); picker = null; document.removeEventListener('pointerdown', onDocDown, true); } };
  const onDocDown = (e) => { if (picker && !picker.contains(e.target) && e.target !== pickBtn) closePicker(); };

  function togglePicker() {
    if (picker) { closePicker(); return; }
    const names = spriteNamesOf(opts.assets);
    const pop = el('div', { class: 'pan-sprite-picker' });
    if (names.length === 0) {
      pop.appendChild(el('div', { class: 'pan-empty-sub', text: T('noAssetIndex') }));
    } else {
      const search = el('input', { type: 'text', class: 'pan-input pan-input-small', placeholder: T('searchSprite') });
      const list = el('div', { class: 'pan-sprite-list' });
      const renderList = () => {
        clear(list);
        const q = search.value.trim().toLowerCase();
        const shown = names.filter((n) => !q || n.toLowerCase().includes(q)).slice(0, 300);
        if (shown.length === 0) list.appendChild(el('div', { class: 'pan-empty-sub', text: T('noSpriteMatch') }));
        for (const n of shown) {
          const item = el('button', { type: 'button', class: 'pan-sprite-item', text: n });
          const meta = opts.assets?.sprite?.(n);
          if (meta) item.title = T('spriteMetaTitle', { w: meta.w, h: meta.h, frames: meta.frames ? meta.frames.length : 1 });
          item.addEventListener('click', () => { input.value = n; emit(n); closePicker(); });
          list.appendChild(item);
        }
      };
      search.addEventListener('input', renderList);
      renderList();
      pop.appendChild(search);
      pop.appendChild(list);
    }
    pop.appendChild(el('div', { class: 'pan-sprite-picker-hint', text: T('spriteDropHint') }));
    holder.appendChild(pop);
    picker = pop;
    setTimeout(() => document.addEventListener('pointerdown', onDocDown, true), 0);
  }

  const commit = () => {
    const v = input.value.trim();
    emit(v === '' ? (opts.nullable ? null : '') : v);
  };
  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); }
    if (e.key === 'Escape') { input.value = opts.value ?? ''; input.blur(); }
  });

  // 接受素材瀏覽器拖放：dataTransfer text/plain = sprite 名
  const onDragOver = (e) => {
    if (!e.dataTransfer && !dragState.sprite) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    wrap.classList.add('drop-target');
  };
  const onDragLeave = () => wrap.classList.remove('drop-target');
  const onDrop = (e) => {
    e.preventDefault();
    e.stopPropagation?.();
    wrap.classList.remove('drop-target');
    let name = '';
    try {
      name = e.dataTransfer?.getData('text/plain') || e.dataTransfer?.getData('application/x-dr-sprite') || '';
    } catch { /* 某些環境下 getData 會擲回 */ }
    // 後備：素材瀏覽器在 dragstart 時記下的名稱（無頭環境常拿不到 dataTransfer 內容）
    if (!name && dragState.sprite) name = String(dragState.sprite);
    dragState.sprite = null;
    if (!name) return;
    input.value = name;
    emit(name);
  };
  wrap.addEventListener('dragover', onDragOver);
  wrap.addEventListener('dragleave', onDragLeave);
  wrap.addEventListener('drop', onDrop);

  holder.setValue = (v) => {
    input.value = v === null || v === undefined ? '' : String(v);
    holder.classList.remove('has-error');
    errEl.textContent = '';
    errEl.classList.remove('show');
  };
  holder.setError = (msg) => {
    errEl.textContent = msg || '';
    errEl.classList.toggle('show', !!msg);
    holder.classList.toggle('has-error', !!msg);
  };
  holder.isEditing = () => holder.contains(document.activeElement);
  holder.openPicker = togglePicker;
  holder.input = input;
  return holder;
}

/* ---------- 數字／表達式雙模式欄位（Blender 式拖曳） ------------------- */

/**
 * 建數字欄位。opts:
 *   { value, spec, coalesceKey, onChange(v, {mode, coalesceKey}), onModeChange? }
 * spec: SPAWN_FIELDS / EVENT Common 的單一項（label, step, drag, min, max, unit, nullable, exprOnly, hint）
 * 回傳 { el, setValue, setError, getMode, focus }
 */
export function numberField(opts) {
  const spec = opts.spec || {};
  const holder = el('div', { class: 'pan-field pan-field-num' });
  const wrap = el('div', { class: 'pan-numfield' });
  const label = el('button', { type: 'button', class: 'pan-numlabel', text: spec.label ?? '', title: T('dragLabelTitle') });
  const modeWrap = el('div', { class: 'pan-nummode' });
  const numBtn = el('button', { type: 'button', class: 'pan-modebtn', text: '123', title: T('modeNumber') });
  const exprBtn = el('button', { type: 'button', class: 'pan-modebtn', text: 'ƒx', title: T('modeExpr') });
  modeWrap.appendChild(numBtn);
  modeWrap.appendChild(exprBtn);
  const inputWrap = el('div', { class: 'pan-numinput' });
  const numInput = el('input', { type: 'number', class: 'pan-input pan-input-num', step: 'any' });
  const exprInput = el('input', { type: 'text', class: 'pan-input pan-input-expr hidden', spellcheck: 'false', autocomplete: 'off', placeholder: T('exprPlaceholder') });
  inputWrap.appendChild(numInput);
  inputWrap.appendChild(exprInput);
  wrap.appendChild(label);
  wrap.appendChild(modeWrap);
  wrap.appendChild(inputWrap);
  if (spec.unit) wrap.appendChild(el('span', { class: 'pan-unit', text: spec.unit }));
  holder.appendChild(wrap);
  const errEl = el('div', { class: 'pan-field-error' });
  holder.appendChild(errEl);
  if (spec.hint) holder.appendChild(el('div', { class: 'pan-hint', text: spec.hint }));
  const exprHint = el('div', { class: 'pan-expr-hint hidden' });
  holder.appendChild(exprHint);
  if (spec.exprOnly) {
    numBtn.classList.add('hidden');
    exprBtn.classList.add('hidden');
    modeWrap.classList.add('hidden');
  }

  let mode = spec.exprOnly ? 'expr' : modeOf(opts.value);
  let current = opts.value; // 最後一次送出／同步的值

  const refreshExprHint = () => {
    if (mode !== 'expr') { exprHint.classList.add('hidden'); return; }
    exprHint.classList.remove('hidden');
    clear(exprHint);
    const src = exprInput.value;
    if (src.trim() === '') {
      exprHint.appendChild(el('span', { class: 'pan-hint', text: spec.exprOnly ? T('exprEmptyExprOnly') : T('exprEmptyDefault') }));
      return;
    }
    const syntax = checkExprSyntax(src);
    if (syntax) {
      exprHint.appendChild(el('span', { class: 'pan-hint-bad', text: `⚠ ${syntax}` }));
      return;
    }
    const r = tryEvaluateExpr(src);
    if (r.ok) exprHint.appendChild(el('span', { class: 'pan-hint-ok', text: T('exprPreview', { value: roundNice(r.value) }) }));
    else exprHint.appendChild(el('span', { class: 'pan-hint-bad', text: `⚠ ${r.error}` }));
  };

  const syncMode = () => {
    numBtn.classList.toggle('active', mode === 'number');
    exprBtn.classList.toggle('active', mode === 'expr');
    numInput.classList.toggle('hidden', mode !== 'number');
    exprInput.classList.toggle('hidden', mode !== 'expr');
    if (mode === 'number') {
      const n = toNumber(current, spec.def ?? 0);
      numInput.value = current === null || current === undefined ? '' : String(roundNice(n));
      numInput.placeholder = spec.nullable ? (spec.nullLabel || T('nullPlaceholder')) : '';
    } else {
      exprInput.value = isExpr(current) ? current : (isExpr(exprDraft) ? exprDraft : '');
    }
    refreshExprHint();
  };

  let exprDraft = '';

  const emit = (v) => {
    current = v;
    opts.onChange?.(v, { mode });
  };

  const showError = (msg) => {
    errEl.textContent = msg || '';
    errEl.classList.toggle('show', !!msg);
    holder.classList.toggle('has-error', !!msg);
  };

  const commitNumber = () => {
    const raw = numInput.value.trim();
    if (raw === '') { showError(''); emit(spec.nullable ? null : (spec.def ?? 0)); return; }
    const n = Number(raw);
    if (!Number.isFinite(n)) { showError(T('notNumber')); return; }
    showError('');
    const v = roundNice(clampSpec(n, spec));
    numInput.value = String(v);
    emit(v);
  };

  const commitExpr = () => {
    const raw = exprInput.value;
    if (raw.trim() === '') {
      exprDraft = '';
      showError('');
      emit(spec.nullable ? null : (spec.def ?? 0));
      refreshExprHint();
      return;
    }
    const syntax = checkExprSyntax(raw);
    if (syntax) { showError(syntax); return; }
    showError('');
    exprDraft = raw;
    emit(raw);
    refreshExprHint();
  };

  const setMode = (m) => {
    if (spec.exprOnly) m = 'expr';
    if (m === mode) return;
    // 切換模式時把當前值轉成新模式的表示再送出（保證 store 與 UI 一致）
    mode = m;
    if (m === 'number') {
      const n = typeof current === 'string' ? toNumber(current, spec.def ?? 0) : (current ?? spec.def ?? 0);
      current = n;
    }
    syncMode();
    emit(current);
  };

  // 事件綁定
  numInput.addEventListener('change', commitNumber);
  numInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitNumber(); numInput.blur(); }
    if (e.key === 'Escape') { syncMode(); numInput.blur(); }
    arrowStep(e, numInput, spec, () => commitNumber());
  });
  exprInput.addEventListener('change', commitExpr);
  exprInput.addEventListener('input', refreshExprHint);
  exprInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitExpr(); }
    if (e.key === 'Escape') { syncMode(); exprInput.blur(); }
  });
  numBtn.addEventListener('click', () => { setMode('number'); numInput.focus(); numInput.select(); });
  exprBtn.addEventListener('click', () => { setMode('expr'); exprInput.focus(); });

  // Blender 式拖曳（在標籤上左右拖）
  const drag = { on: false, x0: 0, v0: 0, pid: null };
  const dragStep = spec.drag ?? spec.step ?? 1;
  const startDrag = (e) => {
    if (e.button !== 0 || spec.exprOnly) return;
    drag.on = true;
    drag.x0 = e.clientX;
    drag.v0 = toNumber(mode === 'expr' ? current : numInput.value, spec.def ?? 0);
    drag.pid = e.pointerId;
    try { label.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    wrap.classList.add('dragging');
    document.body.classList.add('pan-value-dragging');
    e.preventDefault();
  };
  const moveDrag = (e) => {
    if (!drag.on) return;
    const mult = (e.shiftKey ? 10 : 1) * (e.altKey ? 0.1 : 1);
    const raw = drag.v0 + (e.clientX - drag.x0) * dragStep * mult;
    const v = roundNice(clampSpec(raw, spec));
    if (mode !== 'number') {
      mode = 'number';
      syncMode();
    }
    numInput.value = String(v);
    current = v;
    const ck = opts.coalesceKey ? `${opts.coalesceKey}#drag` : (spec.key ? `field:${spec.key}` : null);
    opts.onChange?.(v, { mode: 'number', coalesceKey: ck });
    e.preventDefault();
  };
  const endDrag = (e) => {
    if (!drag.on) return;
    drag.on = false;
    wrap.classList.remove('dragging');
    document.body.classList.remove('pan-value-dragging');
    try { label.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  label.addEventListener('pointerdown', startDrag);
  label.addEventListener('pointermove', moveDrag);
  label.addEventListener('pointerup', endDrag);
  label.addEventListener('pointercancel', endDrag);
  label.addEventListener('dblclick', () => { if (!spec.exprOnly) { setMode('number'); numInput.focus(); numInput.select(); } });
  label.addEventListener('contextmenu', (e) => {
    if (spec.exprOnly) return;
    e.preventDefault();
    setMode(mode === 'number' ? 'expr' : 'number');
  });

  syncMode();

  const api = {
    el: holder,
    getMode: () => mode,
    setValue(v) {
      current = v;
      if (spec.exprOnly) mode = 'expr';
      else mode = modeOf(v);
      syncMode();
      showError('');
    },
    setError(msg) { showError(msg); },
    focus() { (mode === 'number' ? numInput : exprInput).focus(); },
    isEditing() { return holder.contains(document.activeElement); },
    spec,
  };
  return api;
}

/* ---------- BGM 可搜尋下拉（音樂素材，SPEC CUSTOM-ASSETS） ------------- */

/** 從素材索引取出所有 kind === 'music' 的音訊條目。 */
export function musicEntriesOf(assets) {
  const audio = assets && assets.index && assets.index.audio;
  if (!audio || typeof audio !== 'object') return [];
  const out = [];
  for (const name of Object.keys(audio)) {
    const entry = audio[name];
    if (!entry || typeof entry !== 'object') continue;
    if (String(entry.kind || '') !== 'music') continue;
    out.push({
      name,
      tags: Array.isArray(entry.tags) ? entry.tags.map(String) : [],
      loop: entry.loop !== false,
      custom: entry.custom === true || entry.source === 'custom',
      file: typeof entry.file === 'string' ? entry.file : '',
      bytes: Number.isFinite(entry.bytes) ? entry.bytes : null,
    });
  }
  out.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/** 依搜尋字串篩選音樂條目（名稱 / tag 皆可比對，大小寫不敏感）。 */
export function filterMusicEntries(entries, query) {
  const list = Array.isArray(entries) ? entries : [];
  const q = String(query == null ? '' : query).trim().toLowerCase();
  if (q === '') return list.slice();
  return list.filter((e) => {
    if (e.name.toLowerCase().includes(q)) return true;
    return e.tags.some((tag) => String(tag).toLowerCase().includes(q));
  });
}

/**
 * BGM 欄位：可搜尋下拉（音樂素材）＋仍可手打。
 *
 * opts: { value, assets, onChange(v), placeholder }
 * 回傳 { el, setValue, setError, isEditing, openPicker, input }
 */
export function musicField(opts = {}) {
  const holder = el('div', { class: 'pan-field pan-field-sprite pan-field-music' });
  const row = el('div', { class: 'pan-spritefield' });
  const input = el('input', {
    type: 'text',
    class: 'pan-input pan-input-mono',
    placeholder: opts.placeholder || T('music.placeholder'),
    spellcheck: 'false',
    autocomplete: 'off',
  });
  input.value = opts.value === null || opts.value === undefined ? '' : String(opts.value);

  const pick = button(T('music.pick'), {
    small: true,
    title: T('music.pickTitle'),
    onClick: (e) => {
      e.stopPropagation();
      togglePicker();
    },
  });
  const clr = button(T('btn.clear'), {
    small: true,
    title: T('music.clearTitle'),
    onClick: () => {
      input.value = '';
      emit(null);
      closePicker();
    },
  });
  row.appendChild(input);
  row.appendChild(pick);
  row.appendChild(clr);

  const errEl = el('div', { class: 'pan-field-error' });
  const metaEl = el('div', { class: 'pan-hint pan-music-meta' });
  holder.appendChild(row);
  holder.appendChild(metaEl);
  holder.appendChild(errEl);

  let picker = null;

  const allEntries = () => musicEntriesOf(opts.assets);

  const describe = (name) => {
    if (!name) {
      metaEl.textContent = '';
      return;
    }
    const entry = allEntries().find((e) => e.name === name);
    if (!entry) {
      metaEl.textContent = '';
      return;
    }
    const bits = [];
    if (entry.tags.length) bits.push(entry.tags.join(' · '));
    if (entry.custom) bits.push(T('music.custom'));
    metaEl.textContent = bits.join(' — ');
  };

  const emit = (v) => {
    input.value = v === null || v === undefined ? '' : String(v);
    describe(v);
    opts.onChange?.(v);
  };

  const closePicker = () => {
    if (!picker) return;
    picker.remove();
    picker = null;
    document.removeEventListener('pointerdown', onDocDown, true);
  };

  const onDocDown = (ev) => {
    if (!picker) return;
    if (picker.contains(ev.target) || ev.target === pick) return;
    closePicker();
  };

  const buildList = (query) => {
    if (!picker) return;
    const list = picker.querySelector('.pan-sprite-list');
    if (!list) return;
    clear(list);
    const entries = filterMusicEntries(allEntries(), query);
    if (entries.length === 0) {
      list.appendChild(el('div', { class: 'pan-empty-sub', text: T('music.empty') }));
      return;
    }
    for (const entry of entries) {
      const item = el('button', { type: 'button', class: 'pan-sprite-item pan-music-item' });
      item.appendChild(el('span', { class: 'pan-music-name', text: entry.name }));
      if (entry.tags.length) item.appendChild(el('span', { class: 'pan-music-tags', text: entry.tags.join(' ') }));
      if (entry.custom) item.appendChild(el('span', { class: 'pan-music-badge', text: T('music.custom') }));
      item.addEventListener('click', () => {
        emit(entry.name);
        closePicker();
      });
      list.appendChild(item);
    }
  };

  const togglePicker = () => {
    if (picker) { closePicker(); return; }
    picker = el('div', { class: 'pan-sprite-picker pan-music-picker' });
    const search = el('input', {
      type: 'text',
      class: 'pan-input pan-input-small',
      placeholder: T('music.search'),
      spellcheck: 'false',
      autocomplete: 'off',
    });
    search.addEventListener('input', () => buildList(search.value));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
    });
    picker.appendChild(search);
    const list = el('div', { class: 'pan-sprite-list' });
    picker.appendChild(list);
    holder.appendChild(picker);
    buildList('');
    search.focus();
    setTimeout(() => document.addEventListener('pointerdown', onDocDown, true), 0);
  };

  const doCommit = () => {
    const v = input.value.trim();
    emit(v === '' ? null : v);
  };
  input.addEventListener('change', doCommit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); doCommit(); input.blur(); }
    if (e.key === 'Escape') { input.value = opts.value ?? ''; describe(opts.value ?? ''); input.blur(); }
  });

  describe(opts.value);

  return {
    el: holder,
    setValue(v) {
      const next = v === null || v === undefined ? '' : String(v);
      if (input.value !== next) input.value = next;
      describe(next);
    },
    setError(msg) {
      errEl.textContent = msg || '';
      errEl.classList.toggle('show', !!msg);
      holder.classList.toggle('has-error', !!msg);
    },
    isEditing: () => document.activeElement === input,
    openPicker: togglePicker,
    input,
  };
}

function arrowStep(e, input, spec, commit) {
  if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
  e.preventDefault();
  const dir = e.key === 'ArrowUp' ? 1 : -1;
  const step = (spec.step ?? 1) * (e.shiftKey ? 10 : 1) * (e.altKey ? 0.1 : 1);
  const cur = Number(input.value);
  const next = roundNice(clampSpec((Number.isFinite(cur) ? cur : 0) + dir * step, spec));
  input.value = String(next);
  commit();
}

/* ---------- 時間欄位（秒／拍點字串，SPEC-EXPR-V2 §2） ------------------ */

/**
 * 時間欄位：接受「秒」或「拍點字串」（`"2b"`、`"1.5b"`；SPEC-EXPR-V2 §2）。
 *
 * - 存檔保留使用者寫法：輸入 `"2b"` 就寫回 `"2b"`，輸入 `1.5` 就寫回數字。
 * - 顯示等值秒數提示（`= 1 秒`），沒有 bpm 時輸入拍點字串會即時報錯。
 * - 標籤可左右拖曳調值（寫回數字秒），↑／↓ 以秒微調。
 *
 * opts:
 *   { value, spec, coalesceKey, getTiming():timing, onChange(v, {mode, coalesceKey}) }
 * spec 追加欄位：
 *   timeMode: 'point' | 'length'（預設 'length'；point 會加 settings.beatOffset）
 *   allowNegative: boolean
 */
export function timeField(opts) {
  const spec = opts.spec || {};
  const point = spec.timeMode === 'point';
  const allowNegative = !!spec.allowNegative;
  const getTiming = () => {
    try {
      return normalizeTiming(typeof opts.getTiming === 'function' ? opts.getTiming() : opts.timing);
    } catch (_err) {
      return normalizeTiming(null);
    }
  };

  const holder = el('div', { class: 'pan-field pan-field-num pan-field-time' });
  const wrap = el('div', { class: 'pan-numfield' });
  const label = el('button', { type: 'button', class: 'pan-numlabel', text: spec.label ?? '', title: T('time.dragTitle') });
  const inputWrap = el('div', { class: 'pan-numinput' });
  const input = el('input', {
    type: 'text',
    class: 'pan-input pan-input-time',
    spellcheck: 'false',
    autocomplete: 'off',
    placeholder: spec.nullable ? (spec.nullLabel || T('nullPlaceholder')) : T('time.placeholder'),
  });
  inputWrap.appendChild(input);
  wrap.appendChild(label);
  wrap.appendChild(inputWrap);
  if (spec.unit) wrap.appendChild(el('span', { class: 'pan-unit', text: spec.unit }));
  holder.appendChild(wrap);
  const errEl = el('div', { class: 'pan-field-error' });
  holder.appendChild(errEl);
  const hintEl = el('div', { class: 'pan-hint pan-time-hint' });
  holder.appendChild(hintEl);

  let current = opts.value;

  const parseCurrent = (raw) => parseTime(raw, getTiming(), { addOffset: point, allowNegative });

  const showError = (msg) => {
    errEl.textContent = msg || '';
    errEl.classList.toggle('show', !!msg);
    holder.classList.toggle('has-error', !!msg);
  };

  const messageFor = (p) => {
    if (!p || p.ok) return '';
    if (p.code === 'no-bpm') return T('time.noBpm', { raw: p.raw });
    if (p.code === 'negative') return T('time.negative');
    return T('time.invalid');
  };

  const setDisplay = (raw) => {
    input.value = raw === null || raw === undefined ? '' : String(raw);
  };

  const refreshHint = () => {
    hintEl.textContent = '';
    const p = parseCurrent(current);
    if (p.empty || !p.ok) return;
    if (p.kind === 'beat') hintEl.textContent = T('time.beatHint', { sec: formatSeconds(p.seconds, 3) });
  };

  const commit = () => {
    const raw = input.value.trim();
    if (raw === '') {
      showError('');
      current = spec.nullable ? null : (spec.def ?? 0);
      setDisplay(current);
      refreshHint();
      opts.onChange?.(current, { mode: 'time' });
      return;
    }
    const p = parseCurrent(raw);
    if (!p.ok) {
      showError(messageFor(p));
      return;
    }
    showError('');
    // 拍點字串保留原寫法；秒數一律存數字（與引擎的寫法一致）
    current = p.kind === 'beat' ? raw : p.seconds;
    setDisplay(current);
    refreshHint();
    opts.onChange?.(current, { mode: p.kind === 'beat' ? 'beat' : 'number', coalesceKey: opts.coalesceKey });
  };

  input.addEventListener('change', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); input.blur(); return; }
    if (e.key === 'Escape') { setDisplay(current); showError(''); input.blur(); return; }
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const dir = e.key === 'ArrowUp' ? 1 : -1;
      const p = parseCurrent(input.value.trim() === '' ? current : input.value);
      const base = p.ok && !p.empty ? p.seconds : (spec.def ?? 0);
      const step = (spec.step ?? 0.05) * (e.shiftKey ? 10 : 1) * (e.altKey ? 0.1 : 1);
      const next = roundNice(clampSpec(base + dir * step, spec));
      input.value = formatSeconds(next, 4);
      commit();
    }
  });

  // Blender 式拖曳：以秒為單位調整
  const drag = { on: false, x0: 0, v0: 0, pid: null };
  const dragStep = spec.drag ?? spec.step ?? 0.05;
  const startDrag = (e) => {
    if (e.button !== 0) return;
    drag.on = true;
    drag.x0 = e.clientX;
    const p = parseCurrent(input.value);
    drag.v0 = p.ok && !p.empty ? p.seconds : (spec.def ?? 0);
    drag.pid = e.pointerId;
    try { label.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    wrap.classList.add('dragging');
    document.body.classList.add('pan-value-dragging');
    e.preventDefault();
  };
  const moveDrag = (e) => {
    if (!drag.on) return;
    const mult = (e.shiftKey ? 10 : 1) * (e.altKey ? 0.1 : 1);
    const v = roundNice(clampSpec(drag.v0 + (e.clientX - drag.x0) * dragStep * mult, spec));
    input.value = formatSeconds(v, 4);
    showError('');
    current = v;
    refreshHint();
    const ck = opts.coalesceKey ? `${opts.coalesceKey}#drag` : (spec.key ? `field:${spec.key}` : null);
    opts.onChange?.(v, { mode: 'number', coalesceKey: ck });
    e.preventDefault();
  };
  const endDrag = (e) => {
    if (!drag.on) return;
    drag.on = false;
    wrap.classList.remove('dragging');
    document.body.classList.remove('pan-value-dragging');
    try { label.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  label.addEventListener('pointerdown', startDrag);
  label.addEventListener('pointermove', moveDrag);
  label.addEventListener('pointerup', endDrag);
  label.addEventListener('pointercancel', endDrag);

  setDisplay(current);
  refreshHint();

  return {
    el: holder,
    getMode: () => 'time',
    setValue(v) {
      current = v;
      setDisplay(v);
      showError('');
      refreshHint();
    },
    setError(msg) { showError(msg); },
    setTimingHint() { refreshHint(); },
    focus() { input.focus(); input.select?.(); },
    isEditing() { return holder.contains(document.activeElement); },
    input,
    spec,
  };
}


/* ---------- 版面骨架 -------------------------------------------------- */

/** 面板標題列。 */
export function panelHeader(title, tools = null) {
  const h = el('div', { class: 'pan-header' });
  h.appendChild(el('span', { class: 'pan-title', text: title }));
  if (tools) {
    const t = el('div', { class: 'pan-header-tools' });
    for (const item of (Array.isArray(tools) ? tools : [tools])) t.appendChild(item instanceof Node ? item : el('span', { text: String(item) }));
    h.appendChild(t);
  }
  return h;
}

/** 檢查器區塊摺疊狀態的 localStorage 鍵（REALTEST-2 V13：記住使用者收合了哪些區塊）。 */
export const SECTION_STATE_KEY = 'dr-editor.inspector.sections';

/** 讀回摺疊狀態 { 區塊鍵: 是否收合 }；壞資料或沒有 storage 時回空物件。 */
export function loadSectionState(storage, key = SECTION_STATE_KEY) {
  const out = {};
  try {
    const raw = storage && typeof storage.getItem === 'function' ? storage.getItem(key) : null;
    const data = raw ? JSON.parse(raw) : null;
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [name, value] of Object.entries(data)) {
        if (typeof value === 'boolean') out[name] = value;
      }
    }
  } catch (_err) {
    /* 忽略：用預設值 */
  }
  return out;
}

/** 寫回摺疊狀態；成功回 true。 */
export function saveSectionState(storage, state, key = SECTION_STATE_KEY) {
  try {
    if (!storage || typeof storage.setItem !== 'function') return false;
    const clean = {};
    for (const [name, value] of Object.entries(state || {})) {
      if (typeof value === 'boolean') clean[name] = value;
    }
    storage.setItem(key, JSON.stringify(clean));
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * 可折疊區塊；回傳 section 節點（body 在 .body）。
 * opts：collapsed（預設狀態）、stateMap/stateKey（記住狀態）、onToggle(collapsed)（狀態改變時）、
 *       expandTitle / collapseTitle（標題列的 hover 提示：點一下會展開／收合）。
 */
export function section(title, children = null, opts = {}) {
  const s = el('section', { class: `pan-section${opts.class ? ` ${opts.class}` : ''}` });
  const body = el('div', { class: 'pan-section-body' });
  if (title) {
    const head = el('div', { class: 'pan-section-title' });
    const arrow = el('span', { class: 'pan-section-arrow', text: '▾' });
    head.appendChild(arrow);
    head.appendChild(el('span', { class: 'pan-section-label', text: title }));
    s.appendChild(head);
    const stateMap = opts.stateMap || null;
    const stateKey = opts.stateKey || null;
    const remembered = stateMap && stateKey && Object.prototype.hasOwnProperty.call(stateMap, stateKey);
    let collapsed = remembered ? !!stateMap[stateKey] : !!opts.collapsed;
    body.classList.toggle('collapsed', collapsed);
    if (collapsed) arrow.textContent = '▸';
    const paintTitle = () => {
      const tip = collapsed ? opts.expandTitle : opts.collapseTitle;
      if (tip) head.title = tip;
      head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    };
    paintTitle();
    head.addEventListener('click', () => {
      collapsed = !collapsed;
      if (stateMap && stateKey) stateMap[stateKey] = collapsed;
      body.classList.toggle('collapsed', collapsed);
      arrow.textContent = collapsed ? '▸' : '▾';
      paintTitle();
      if (typeof opts.onToggle === 'function') opts.onToggle(collapsed);
    });
    s.head = head;
  }
  if (children) body.appendChild(children instanceof Node ? children : el('div', null, children));
  s.appendChild(body);
  s.body = body;
  return s;
}

/** label + control 一列。 */
export function fieldRow(label, control, opts = {}) {
  const row = el('div', { class: `pan-row${opts.class ? ` ${opts.class}` : ''}` });
  if (label !== null && label !== undefined && label !== '') {
    row.appendChild(el('label', { class: 'pan-row-label', text: label, title: opts.title || null }));
  }
  const ctl = el('div', { class: 'pan-row-control' });
  if (control) ctl.appendChild(control instanceof Node ? control : el('div', null, control));
  row.appendChild(ctl);
  row.control = ctl;
  return row;
}

/** 空狀態。 */
export function emptyState(msg, sub = null) {
  const d = el('div', { class: 'pan-empty' });
  d.appendChild(el('div', { class: 'pan-empty-main', text: msg }));
  if (sub) d.appendChild(el('div', { class: 'pan-empty-sub', text: sub }));
  return d;
}

/** 提示文字區塊。 */
export function hintBox(text) {
  return el('div', { class: 'pan-hint', text });
}

/**
 * 確保 panels.css 已載入（ED1 若沒引入也能自己注入；重複呼叫安全）。
 * 以「解析後的絕對 URL 是否相同」判斷，避免 Phase 2 的
 * `editor/encounter/panels.css` 被誤認為本檔的樣式表。
 */
export function ensureStyles(href = null) {
  if (typeof document === 'undefined') return;
  let url = href;
  if (!url) {
    try { url = new URL('./panels.css', import.meta.url).href; } catch { url = 'panels.css'; }
  }
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  const sameAs = (raw) => {
    if (!raw) return false;
    try { return new URL(raw, document.baseURI).href === url; } catch { return raw === url; }
  };
  if (links.some((l) => sameAs(l.getAttribute('href')))) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = url;
  document.head.appendChild(link);
}

/** 訂閱 store 並在變更後重繪；回傳取消函式。 */
export function subscribeRender(store, render) {
  if (!store || typeof store.subscribe !== 'function') return () => {};
  const unsub = store.subscribe(() => render());
  return typeof unsub === 'function' ? unsub : () => {};
}

/** DOM 內容簽章（避免整份面板每幀重繪）。 */
export function domSig(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

/** 節點是否為 textarea/input（重繪時保留焦點判斷用）。 */
export function isEditingIn(root) {
  const a = document.activeElement;
  if (!a || !root.contains(a)) return false;
  const tag = a.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable;
}
