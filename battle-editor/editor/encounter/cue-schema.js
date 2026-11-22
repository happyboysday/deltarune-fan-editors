/**
 * editor/encounter/cue-schema.js — ED2：演出指令（cue）描述 + 純邏輯
 *
 * 對應 docs/SPEC-P2.md §3「演出指令」表。本檔**不碰 DOM**，可在 Node 直接 import 測試
 * （editor/encounter/cue-editor.test.mjs）。
 *
 * 內容：
 *   1. CUE_SCHEMA     — 20 個指令的欄位描述（型別 / 預設 / 必填 / 說明鍵 / 所屬類別 / 圖示）
 *   2. 路徑工具        — parseStorePath / formatStorePath / cueAbsPath / getCueAt …
 *   3. 清單操作        — flattenCues / computeDropTarget / moveCues / insertCues / removeCues …
 *   4. 摘要            — cueSummary（三語，依目前 i18n 語系）
 *   5. 錯誤比對        — matchCueErrors（store.errors 的 JSON 路徑 → 卡片 / 欄位）
 *
 * 指令清單必須與引擎 engine/encounter/schema.js 的 CUE_COMMANDS 一致；
 * 測試會以動態 import 比對（引擎檔不存在時跳過並警告）。
 */

import { t, registerStrings, getLocale, battleLangFor } from '../i18n.js';
import CUES_STRINGS from '../locales/cues.js';
// V2-07：form（演員形態切換）追加字串；registerStrings 合併進 cues 命名空間。
import '../locales/encounter-cue-form.js';

registerStrings('cues', CUES_STRINGS);

/* ------------------------------------------------------------------ 常數 */

/**
 * 指令類別（新增指令選單的分組順序）。
 *
 * 與引擎 `engine/encounter/schema.js` 的 `CUE_CATEGORIES` 一致：text / actor /
 * audio / camera / value / flow。SPEC-P2 §6 只列了五類（文字、演員、音效、流程、
 * 數值），但引擎把 `shake` / `flash` 獨立成 camera；此處跟引擎走，避免選單分組與
 * 驗證／文件不一致（偏差已回報）。
 */
export const CUE_GROUPS = ['text', 'actor', 'audio', 'camera', 'value', 'flow'];

/** 補間曲線（與 engine/easing.js 的 EASING_NAMES 一致；測試會比對） */
export const EASE_NAMES = ['linear', 'quadIn', 'quadOut', 'quadInOut', 'sineInOut', 'backOut'];

/** `end` 指令的結果 */
export const END_RESULTS = ['victory', 'spared', 'defeat', 'flee'];

/** `bubble.side` 可選值（auto 依講話者位置決定） */
export const BUBBLE_SIDES = ['auto', 'left', 'right'];

/** `set.op` */
export const SET_OPS = ['set', 'add'];

/** 欄位型別 */
export const FIELD_TYPES = {
  NUMBER: 'number', // 純數字
  EXPR: 'expr', // 數字或表達式（engine/expr.js）
  TEXT: 'text', // 文字；i18n:true 者可切換「單一 / 中英分開」
  ACTOR: 'actor', // 演員 id 下拉
  TARGET: 'target', // heal/damage 目標：隊員 / 敵人 id，或 'party' / 'all'
  SPRITE: 'sprite', // sprite 名（可接收素材面板拖放）
  SOUND: 'sound', // 音效名
  ATTACK: 'attack', // 攻擊檔名 / 內嵌攻擊
  EASE: 'ease', // 補間曲線下拉
  BOOL: 'bool',
  ENUM: 'enum', // options: [{ value, labelKey? }]
  NUMBER_OR_INPUT: 'numberOrInput', // bubble.wait：'input' 或秒數
  COLOR: 'color',
  VAR: 'var', // 自訂變數名
  CUES: 'cues', // 巢狀指令清單（容器）
  RESULT: 'result', // end.result
};

/* -------------------------------------------------- 欄位 / 指令描述工具 */

/** 建立欄位描述；labelKey / descKey 都由 key 推導，維持命名一致 */
function f(key, type, extra = {}) {
  return {
    key,
    type,
    labelKey: `cues.field.${key}`,
    descKey: `cues.fieldDesc.${key}`,
    required: false,
    default: undefined,
    ...extra,
  };
}

function command(cmd, group, icon, fields, extra = {}) {
  return {
    cmd,
    group,
    icon,
    descKey: `cues.desc.${cmd}`,
    fields,
    /**
     * 預設是否阻塞（true = 等這條完成才接下一個；async:true 可覆寫）。
     * 與引擎 CUE_COMMANDS[cmd].blocking 一致，測試會比對。
     */
    blocking: extra.blocking !== false,
    /** 巢狀子清單的欄位名（可展開、可拖入拖出） */
    children: extra.children || null,
  };
}

/* ------------------------------------------------------------ 指令描述 */

/**
 * 20 個指令。欄位順序＝表單顯示順序。
 * `required` 表示 SPEC §3 表格中的必要參數；表單會標 * 並在缺少時提示。
 */
export const CUE_SCHEMA = [
  command('say', 'text', 'SAY', [
    f('text', FIELD_TYPES.TEXT, { required: true, i18n: true, default: '' }),
    f('speaker', FIELD_TYPES.TEXT, { default: '' }),
    f('portrait', FIELD_TYPES.SPRITE, { default: null, nullable: true, auto: false }),
    f('speed', FIELD_TYPES.NUMBER, { default: 1, min: 0.05, max: 10, step: 0.5 }),
    f('voice', FIELD_TYPES.SOUND, { default: null, nullable: true, auto: false }),
  ]),
  command('bubble', 'text', 'BUB', [
    f('actor', FIELD_TYPES.ACTOR, { required: true }),
    f('text', FIELD_TYPES.TEXT, { required: true, i18n: true, default: '' }),
    f('side', FIELD_TYPES.ENUM, {
      default: 'auto',
      options: BUBBLE_SIDES.map((v) => ({ value: v, labelKey: `cues.side.${v}` })),
    }),
    f('speed', FIELD_TYPES.NUMBER, { default: 1, min: 0.05, max: 10, step: 0.5 }),
    f('wait', FIELD_TYPES.NUMBER_OR_INPUT, { default: 'input' }),
  ]),
  command('move', 'actor', 'MOV', [
    f('actor', FIELD_TYPES.ACTOR, { required: true }),
    f('x', FIELD_TYPES.EXPR, { default: null, nullable: true }),
    f('y', FIELD_TYPES.EXPR, { default: null, nullable: true }),
    f('relative', FIELD_TYPES.BOOL, { default: false }),
    f('duration', FIELD_TYPES.NUMBER, { required: true, default: 0.5, min: 0, max: 60, step: 1 / 30 }),
    f('ease', FIELD_TYPES.EASE, { default: 'quadOut', nullable: true }),
  ]),
  command('anim', 'actor', 'ANM', [
    f('actor', FIELD_TYPES.ACTOR, { required: true }),
    f('anim', FIELD_TYPES.TEXT, { default: 'idle' }),
    f('sprite', FIELD_TYPES.SPRITE, { default: null, nullable: true, auto: false }),
    f('fps', FIELD_TYPES.NUMBER, { default: null, nullable: true, min: 0.1, max: 60, step: 1 }),
    f('loop', FIELD_TYPES.BOOL, { default: null, nullable: true }),
    f('waitEnd', FIELD_TYPES.BOOL, { default: false }),
  ], { blocking: false }),
  command('form', 'actor', 'FRM', [
    f('actor', FIELD_TYPES.ACTOR, { required: true }),
    f('name', FIELD_TYPES.TEXT, { required: true, nullable: true, default: null }),
    f('anim', FIELD_TYPES.TEXT, { default: '' }),
  ], { blocking: false }),
  command('flip', 'actor', 'FLP', [
    f('actor', FIELD_TYPES.ACTOR, { required: true }),
    f('value', FIELD_TYPES.BOOL, { default: true }),
  ], { blocking: false }),
  command('fade', 'actor', 'FAD', [
    f('actor', FIELD_TYPES.ACTOR, { required: true }),
    f('alpha', FIELD_TYPES.NUMBER, { required: true, default: 0, min: 0, max: 1, step: 0.05 }),
    f('duration', FIELD_TYPES.NUMBER, { default: 0.5, min: 0, max: 60, step: 1 / 30 }),
  ]),
  command('wait', 'flow', 'WAI', [
    f('seconds', FIELD_TYPES.NUMBER, { required: true, default: 0.5, min: 0, max: 60, step: 1 / 30 }),
  ]),
  command('sfx', 'audio', 'SFX', [
    f('sound', FIELD_TYPES.SOUND, { required: true }),
  ], { blocking: false }),
  command('bgm', 'audio', 'BGM', [
    f('track', FIELD_TYPES.SOUND, { required: true, nullable: true, default: null, auto: false }),
    f('fade', FIELD_TYPES.NUMBER, { default: 0, min: 0, max: 10, step: 1 / 30 }),
  ], { blocking: false }),
  command('shake', 'camera', 'SHK', [
    f('amount', FIELD_TYPES.NUMBER, { required: true, default: 4, min: 0, max: 64, step: 1 }),
    f('duration', FIELD_TYPES.NUMBER, { required: true, default: 0.3, min: 0, max: 10, step: 1 / 30 }),
  ]),
  command('flash', 'camera', 'FLS', [
    f('color', FIELD_TYPES.COLOR, { required: true, default: '#ffffff' }),
    f('duration', FIELD_TYPES.NUMBER, { default: 0.2, min: 0, max: 10, step: 1 / 30 }),
  ]),
  command('set', 'value', 'SET', [
    f('var', FIELD_TYPES.VAR, { required: true }),
    f('value', FIELD_TYPES.EXPR, { required: true, default: 0 }),
    f('op', FIELD_TYPES.ENUM, {
      default: 'set',
      options: SET_OPS.map((v) => ({ value: v, labelKey: `cues.op.${v}` })),
    }),
  ], { blocking: false }),
  command('mercy', 'value', 'MRC', [
    f('enemy', FIELD_TYPES.ACTOR, { required: true, kinds: ['enemy'] }),
    f('amount', FIELD_TYPES.EXPR, { required: true, default: 0 }),
  ], { blocking: false }),
  command('heal', 'value', 'HEL', [
    f('target', FIELD_TYPES.TARGET, { required: true, prefer: 'party', default: 'party' }),
    f('amount', FIELD_TYPES.EXPR, { required: true, default: 0 }),
  ], { blocking: false }),
  command('damage', 'value', 'DMG', [
    f('target', FIELD_TYPES.TARGET, { required: true, prefer: 'party', default: 'party' }),
    f('amount', FIELD_TYPES.EXPR, { required: true, default: 0 }),
  ], { blocking: false }),
  command('if', 'flow', 'IF', [
    f('cond', FIELD_TYPES.EXPR, { required: true, default: '' }),
    f('then', FIELD_TYPES.CUES, { default: [] }),
    f('else', FIELD_TYPES.CUES, { default: [] }),
  ], { children: ['then', 'else'] }),
  command('parallel', 'flow', 'PAR', [
    f('cues', FIELD_TYPES.CUES, { default: [] }),
  ], { children: ['cues'] }),
  command('attack', 'flow', 'ATK', [
    f('attack', FIELD_TYPES.ATTACK, { required: true }),
  ]),
  command('end', 'flow', 'END', [
    f('result', FIELD_TYPES.RESULT, {
      required: true,
      default: 'victory',
      options: END_RESULTS.map((v) => ({ value: v, labelKey: `cues.result.${v}` })),
    }),
  ], { blocking: false }),
];

/** 指令名清單（與引擎 CUE_COMMANDS 比對用） */
export const CUE_COMMANDS_LIST = CUE_SCHEMA.map((c) => c.cmd);

const CMD_LOOKUP = new Map(CUE_SCHEMA.map((c) => [c.cmd, c]));

/** 取得指令描述；未知指令回傳 null */
export function getCommandSpec(cmd) {
  return CMD_LOOKUP.get(cmd) || null;
}

/** 指令顯示名（未知指令顯示原字串） */
export function commandLabel(cmd) {
  return getCommandSpec(cmd) ? t(`cues.cmd.${cmd}`) : String(cmd || '?');
}

/** 類別顯示名 */
export function groupLabel(group) {
  return t(`cues.group.${group}`);
}

/** 類別色（卡片左緣 / 圖示底色） */
export const GROUP_COLORS = {
  text: '#7fd1ff',
  actor: '#ffd166',
  audio: '#c792ea',
  camera: '#f2a1d0',
  flow: '#8bd17c',
  value: '#ff8fa3',
};

/** 依類別分組（新增指令選單用） */
export function commandsByGroup() {
  return CUE_GROUPS.map((group) => ({
    group,
    label: groupLabel(group),
    color: GROUP_COLORS[group],
    commands: CUE_SCHEMA.filter((c) => c.group === group),
  }));
}

/* -------------------------------------------------------------- 預設值 */

function firstOf(list) {
  return Array.isArray(list) && list.length ? list[0] : null;
}

function actorIdOfKind(actors, kinds, prefer) {
  const list = Array.isArray(actors) ? actors : [];
  if (kinds && kinds.length) {
    const hit = list.find((a) => a && kinds.includes(a.kind));
    if (hit) return hit.id;
  }
  if (prefer) {
    const hit = list.find((a) => a && a.kind === prefer);
    if (hit) return hit.id;
  }
  const hit = firstOf(list);
  return hit ? hit.id : null;
}

/**
 * 建立某指令的合理預設值。
 * @param {string} cmd
 * @param {{ actors?: any[], attacks?: any[], sounds?: any[], sprites?: any[], vars?: any[] }} [opts]
 * @returns {object|null}
 */
export function createDefaultCue(cmd, opts = {}) {
  const spec = getCommandSpec(cmd);
  if (!spec) return null;
  const actors = Array.isArray(opts.actors) ? opts.actors : [];
  const cue = { cmd };
  for (const field of spec.fields) {
    cue[field.key] = defaultForField(field, opts, actors);
  }
  cue.async = false;
  return cue;
}

function defaultForField(field, opts, actors) {
  const type = field.type;
  if (type === FIELD_TYPES.CUES) return [];
  if (field.auto === false) {
    // 明確標示「不要自動挑第一個」（例如 portrait / voice / bgm.track）
    if (type === FIELD_TYPES.COLOR) return field.default ?? '#ffffff';
    if (type === FIELD_TYPES.BOOL) return field.default === undefined ? false : field.default;
    if (type === FIELD_TYPES.NUMBER || type === FIELD_TYPES.EXPR) return field.default === undefined ? 0 : field.default;
    return field.default === undefined ? null : field.default;
  }
  switch (type) {
    case FIELD_TYPES.ACTOR:
      return actorIdOfKind(actors, field.kinds, field.prefer);
    case FIELD_TYPES.TARGET: {
      // heal/damage.target：優先挑隊員 id（引擎也接受 'party' / 'all'）
      const partyHit = actors.find((a) => a && a.kind === 'party');
      return partyHit ? partyHit.id : (field.default ?? 'party');
    }
    case FIELD_TYPES.SOUND:
      return firstOf(opts.sounds) ?? field.default ?? null;
    case FIELD_TYPES.ATTACK:
      return firstOf(opts.attacks) ?? field.default ?? '';
    case FIELD_TYPES.SPRITE:
      return firstOf(opts.sprites) ?? field.default ?? null;
    case FIELD_TYPES.VAR:
      return firstOf(opts.vars) ?? field.default ?? 'flag';
    case FIELD_TYPES.COLOR:
      return field.default ?? '#ffffff';
    case FIELD_TYPES.BOOL:
      return field.default === undefined ? false : field.default;
    case FIELD_TYPES.NUMBER:
    case FIELD_TYPES.EXPR:
      return field.default === undefined ? 0 : field.default;
    case FIELD_TYPES.TEXT:
      return field.default === undefined ? '' : field.default;
    case FIELD_TYPES.NUMBER_OR_INPUT:
      return field.default === undefined ? 'input' : field.default;
    case FIELD_TYPES.ENUM:
      return field.default !== undefined ? field.default : (field.options && field.options[0] ? field.options[0].value : '');
    case FIELD_TYPES.RESULT:
      return field.default || 'victory';
    default:
      return field.default === undefined ? null : field.default;
  }
}

/** 深拷貝一條指令（cue 皆為 JSON 安全物件） */
export function cloneCue(cue) {
  if (!cue || typeof cue !== 'object') return cue;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(cue); } catch (_err) { /* 退回手動複製 */ }
  }
  return JSON.parse(JSON.stringify(cue));
}

/* ------------------------------------------------------------ 文字工具 */

/** 取文字欄位的值（支援字串或 { zh, en }），依戰鬥語言挑選 */
export function pickText(value, lang) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (typeof value === 'object') {
    const order = [lang, 'zh', 'en'].filter(Boolean);
    for (const key of order) {
      if (typeof value[key] === 'string' && value[key]) return value[key];
    }
    for (const key of Object.keys(value)) {
      if (typeof value[key] === 'string' && value[key]) return value[key];
    }
  }
  return '';
}

/** 是否是「中英分開」的物件形式 */
export function isTextObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** 截斷文字（給卡片摘要用） */
export function clipText(text, max = 26) {
  const s = String(text === null || text === undefined ? '' : text).replace(/\s+/g, ' ').trim();
  if (!max || s.length <= max) return s;
  return `${s.slice(0, Math.max(1, max - 1))}…`;
}

/** 數字顯示（去尾零，最多 3 位小數） */
export function numText(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  const r = Math.round(n * 1000) / 1000;
  return String(r);
}

function secondsText(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value ?? '');
  return `${numText(n)}s`;
}

/* ------------------------------------------------------------ 路徑工具 */

/** 路徑字串（DOM dataset / 選取狀態用）：[0,'then',1] → '0/then/1' */
export function pathToKey(path) {
  return (path || []).join('/');
}

/** '0/then/1' → [0,'then',1]（純數字段轉成 number） */
export function keyToPath(key) {
  if (Array.isArray(key)) return key.slice();
  if (key === null || key === undefined || key === '') return [];
  return String(key).split('/').map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

/** 兩個路徑段是否相同 */
export function segEqual(a, b) {
  return String(a) === String(b);
}

/**
 * 解析 store.cuePath：支援 'turns[0].start'、'turns/0/start'、['turns',0,'start']。
 * @returns {Array<string|number>}
 */
export function parseStorePath(path) {
  if (Array.isArray(path)) return path.slice();
  if (typeof path !== 'string') return [];
  const out = [];
  const STOP = '.[]/ ';
  let i = 0;
  const s = path.trim();
  while (i < s.length) {
    const ch = s[i];
    if (ch === '.' || ch === '/' || ch === ' ') { i += 1; continue; }
    if (ch === '[') {
      const j = s.indexOf(']', i);
      if (j < 0) break;
      const inner = s.slice(i + 1, j).trim().replace(/^['"]|['"]$/g, '');
      out.push(/^\d+$/.test(inner) ? Number(inner) : inner);
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < s.length && STOP.indexOf(s[j]) < 0) j += 1;
    if (j === i) { i += 1; continue; }
    const name = s.slice(i, j);
    out.push(/^\d+$/.test(name) ? Number(name) : name);
    i = j;
  }
  return out;
}

/** 路徑段陣列 → 可讀字串 'turns[0].start' */
export function formatStorePath(path) {
  const segs = Array.isArray(path) ? path : parseStorePath(path);
  let out = '';
  for (const seg of segs) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out;
}

/**
 * 指令的絕對路徑（給 store.errors 比對用）。
 * cueAbsPath('turns[0].start', [0,'then',1]) → 'turns[0].start[0].then[1]'
 */
export function cueAbsPath(basePath, relPath) {
  const base = typeof basePath === 'string' ? basePath : formatStorePath(basePath || []);
  let out = base;
  for (const seg of relPath || []) {
    if (typeof seg === 'number') out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out;
}

/** prefix 是否為 path 的前綴（含相等） */
export function isPrefix(prefix, path) {
  const a = prefix || [];
  const b = path || [];
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (!segEqual(a[i], b[i])) return false;
  return true;
}

function samePath(a, b) {
  const x = a || [];
  const y = b || [];
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) if (!segEqual(x[i], y[i])) return false;
  return true;
}

/** 取得 containerPath 指向的指令陣列（containerPath 由 index / 欄位名交替組成） */
export function getArrayAt(cues, containerPath) {
  let cur = cues;
  for (const seg of containerPath || []) {
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return null;
      cur = cur[seg];
    } else {
      if (!cur || typeof cur !== 'object' || Array.isArray(cur)) return null;
      cur = cur[seg];
    }
    if (cur === undefined || cur === null) return null;
  }
  return Array.isArray(cur) ? cur : null;
}

/** 取得某條指令（relPath，例如 [0,'then',1]） */
export function getCueAt(cues, relPath) {
  const path = relPath || [];
  if (!path.length) return null;
  const last = path[path.length - 1];
  if (typeof last !== 'number') return null;
  const arr = getArrayAt(cues, path.slice(0, -1));
  if (!arr) return null;
  const cue = arr[last];
  return cue && typeof cue === 'object' ? cue : null;
}

/** 取得某條指令所在的陣列與索引 */
export function locateCue(cues, relPath) {
  const path = relPath || [];
  if (!path.length) return null;
  const index = path[path.length - 1];
  if (typeof index !== 'number') return null;
  const containerPath = path.slice(0, -1);
  const arr = getArrayAt(cues, containerPath);
  if (!arr || !(index in arr)) return null;
  return { array: arr, index, containerPath };
}

/** 就地修改某條指令 */
export function updateCueAt(cues, relPath, fn) {
  const cue = getCueAt(cues, relPath);
  if (!cue || typeof fn !== 'function') return false;
  fn(cue);
  return true;
}

/** 去掉「祖先也在清單裡」的路徑（避免同一子樹被移動兩次） */
export function pruneNestedPaths(paths) {
  const list = (paths || []).map((p) => (Array.isArray(p) ? p : keyToPath(p)));
  return list.filter((p) => !list.some((q) => q !== p && isPrefix(q, p)));
}

/** 依路徑排序（淺的在前、同層依索引） */
export function sortPaths(paths) {
  return (paths || []).slice().sort((a, b) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const x = a[i];
      const y = b[i];
      if (x === y) continue;
      if (typeof x === 'number' && typeof y === 'number') return x - y;
      return String(x) < String(y) ? -1 : 1;
    }
    return a.length - b.length;
  });
}

/* -------------------------------------------------------- 清單展開/拖曳 */

/**
 * 把指令清單攤平成畫面順序（含展開的巢狀子清單）。
 * @param {Array} cues
 * @param {{ expanded?: Set<string>|string[], basePath?: Array, collapsed?: Set<string>|string[] }} [opts]
 * @returns {{ cue:object, path:Array, index:number, containerPath:Array, depth:number }[]}
 */
export function flattenCues(cues, opts = {}) {
  const expanded = opts.expanded instanceof Set ? opts.expanded : new Set(opts.expanded || []);
  const collapsed = opts.collapsed instanceof Set ? opts.collapsed : new Set(opts.collapsed || []);
  const basePath = Array.isArray(opts.basePath) ? opts.basePath : [];
  const out = [];

  const walk = (list, containerPath, depth) => {
    if (!Array.isArray(list)) return;
    for (let i = 0; i < list.length; i++) {
      const cue = list[i];
      if (!cue || typeof cue !== 'object') continue;
      const path = [...containerPath, i];
      out.push({ cue, path, index: i, containerPath, depth });
      const spec = getCommandSpec(cue.cmd);
      if (!spec || !spec.children) continue;
      const key = pathToKey(path);
      // 預設展開：展開集合有記錄就展開；collapsed 明確收合者不展開
      const isOpen = expanded.has(key) && !collapsed.has(key);
      if (!isOpen) continue;
      for (const childKey of spec.children) {
        walk(cue[childKey], [...path, childKey], depth + 1);
      }
    }
  };

  walk(Array.isArray(cues) ? cues : [], basePath, 0);
  return out;
}

/**
 * 依拖曳位置計算插入點。
 * entries 需含 { top, bottom, index, containerPath, path }（top/bottom 為同一座標系）。
 * @returns {{ containerPath: Array, index: number, before?: Array|null }}
 */
export function computeDropTarget(entries, y, fallbackContainerPath = []) {
  const list = Array.isArray(entries) ? entries.filter((e) => e && Number.isFinite(e.top) && Number.isFinite(e.bottom)) : [];
  if (!list.length) return { containerPath: (fallbackContainerPath || []).slice(), index: 0, before: null };
  let best = null;
  for (const e of list) {
    const candidates = [
      { pos: e.top, index: typeof e.index === 'number' ? e.index : 0, before: e.path || null },
      { pos: e.bottom, index: (typeof e.index === 'number' ? e.index : 0) + 1, before: null },
    ];
    for (const c of candidates) {
      const d = Math.abs(y - c.pos);
      if (!best || d < best.d) {
        best = {
          d,
          containerPath: (e.containerPath || []).slice(),
          index: Math.max(0, c.index),
          before: c.before,
        };
      }
    }
  }
  return best;
}

/**
 * 把 srcPaths 指定的指令移到 destContainerPath 的 destIndex。
 * - 目標在來源子樹內 → 拒絕（回傳 ok:false）
 * - 同一個容器內移動會自動修正索引
 * @returns {{ ok:boolean, paths:Array<Array>, reason?:string }}
 */
export function moveCues(cues, srcPaths, destContainerPath, destIndex) {
  if (!Array.isArray(cues)) return { ok: false, paths: [], reason: 'no-root' };
  const sources = pruneNestedPaths(srcPaths || []);
  if (!sources.length) return { ok: false, paths: [], reason: 'no-source' };
  const dest = Array.isArray(destContainerPath) ? destContainerPath : keyToPath(destContainerPath);
  if (!getArrayAt(cues, dest)) return { ok: false, paths: [], reason: 'no-dest' };
  for (const p of sources) {
    // 不能把指令拖進自己的子孫容器
    if (isPrefix(p, dest)) return { ok: false, paths: [], reason: 'self-nest' };
  }
  const items = [];
  for (const p of sources) {
    const loc = locateCue(cues, p);
    if (!loc) continue;
    items.push({ path: p, cue: loc.array[loc.index] });
  }
  if (!items.length) return { ok: false, paths: [], reason: 'missing' };

  // 目標索引修正：同一容器中、索引小於插入點的來源先被移除 → 插入點前移
  // （用原始 destIndex 一次算出偏移量，避免逐項遞減造成順序相依）
  let index = typeof destIndex === 'number' ? destIndex : 0;
  let shift = 0;
  for (const it of items) {
    const container = it.path.slice(0, -1);
    if (!samePath(container, dest)) continue;
    const from = it.path[it.path.length - 1];
    if (typeof from === 'number' && from < index) shift += 1;
  }
  index = Math.max(0, index - shift);

  // 由後往前移除，避免索引位移
  const ordered = sortPaths(items.map((it) => it.path)).reverse();
  for (const p of ordered) {
    const loc = locateCue(cues, p);
    if (loc) loc.array.splice(loc.index, 1);
  }

  const arr = getArrayAt(cues, dest);
  if (!arr) return { ok: false, paths: [], reason: 'no-dest' };
  const clamped = Math.max(0, Math.min(index, arr.length));
  const cuesToInsert = items.map((it) => it.cue);
  arr.splice(clamped, 0, ...cuesToInsert);

  const paths = items.map((_it, i) => [...dest, clamped + i]);
  return { ok: true, paths };
}

/**
 * 插入新指令。
 * @returns {Array<Array>} 插入後的相對路徑
 */
export function insertCues(cues, destContainerPath, destIndex, newCues) {
  const dest = Array.isArray(destContainerPath) ? destContainerPath : keyToPath(destContainerPath);
  const arr = getArrayAt(cues, dest);
  const list = Array.isArray(newCues) ? newCues : [];
  if (!arr || !list.length) return [];
  const at = Math.max(0, Math.min(typeof destIndex === 'number' ? destIndex : arr.length, arr.length));
  arr.splice(at, 0, ...list);
  return list.map((_cue, i) => [...dest, at + i]);
}

/**
 * 刪除指令（自動處理同批的祖先／子孫）。
 * @returns {number} 實際刪除的條數（含子孫）
 */
export function removeCues(cues, paths) {
  if (!Array.isArray(cues)) return 0;
  const sources = pruneNestedPaths(paths || []);
  let removed = 0;
  const ordered = sortPaths(sources).reverse();
  for (const p of ordered) {
    const loc = locateCue(cues, p);
    if (!loc) continue;
    removed += 1;
    loc.array.splice(loc.index, 1);
  }
  return removed;
}

/**
 * 複製指令（插在來源後面），回傳新路徑。
 */
export function duplicateCues(cues, paths) {
  if (!Array.isArray(cues)) return [];
  const sources = pruneNestedPaths(paths || []);
  // 由後往前處理，插入不影響前面的索引
  const ordered = sortPaths(sources).reverse();
  const created = [];
  for (const p of ordered) {
    const loc = locateCue(cues, p);
    if (!loc) continue;
    const copy = cloneCue(loc.array[loc.index]);
    loc.array.splice(loc.index + 1, 0, copy);
    created.push([...loc.containerPath, loc.index + 1]);
  }
  return created.reverse();
}

/**
 * 收集指令清單中所有已使用的變數名（給 set 的 datalist 用）。
 */
export function collectVarNames(cues, out = new Set()) {
  if (!Array.isArray(cues)) return out;
  for (const cue of cues) {
    if (!cue || typeof cue !== 'object') continue;
    if (cue.cmd === 'set' && typeof cue.var === 'string' && cue.var) out.add(cue.var);
    const spec = getCommandSpec(cue.cmd);
    if (spec && spec.children) {
      for (const key of spec.children) collectVarNames(cue[key], out);
    }
  }
  return out;
}

/** 指令清單的總條數（含巢狀） */
export function countCues(cues) {
  if (!Array.isArray(cues)) return 0;
  let n = 0;
  for (const cue of cues) {
    if (!cue || typeof cue !== 'object') continue;
    n += 1;
    const spec = getCommandSpec(cue.cmd);
    if (spec && spec.children) for (const key of spec.children) n += countCues(cue[key]);
  }
  return n;
}

/* ---------------------------------------------------------------- 摘要 */

/**
 * 卡片的一行摘要（依目前語系）。
 * @param {object} cue
 * @param {{ actorName?: (id:string)=>string, attackName?: (ref:any)=>string, lang?: string }} [opts]
 */
export function cueSummary(cue, opts = {}) {
  if (!cue || typeof cue !== 'object') return '';
  const lang = opts.lang || battleLangFor(getLocale());
  const actorName = typeof opts.actorName === 'function'
    ? opts.actorName
    : (id) => (id === null || id === undefined || id === '' ? '—' : String(id));
  const attackName = typeof opts.attackName === 'function'
    ? opts.attackName
    : (ref) => (ref && typeof ref === 'object' ? (ref.name || ref.id || '{}') : String(ref ?? '—'));
  const text = (v, max = 26) => clipText(pickText(v, lang), max) || '…';
  const actor = (id) => actorName(id);
  // heal/damage.target 也可以是引擎的特殊值
  const targetName = (v) => {
    if (v === 'party') return t('cues.target.party');
    if (v === 'all') return t('cues.target.all');
    return actorName(v);
  };

  switch (cue.cmd) {
    case 'say': {
      const speaker = cue.speaker ? clipText(pickText(cue.speaker, lang), 12) : '';
      const key = speaker ? 'cues.summary.say' : 'cues.summary.sayAnonymous';
      return t(key, { speaker, text: text(cue.text) });
    }
    case 'bubble': {
      const sideTag = cue.side && cue.side !== 'auto' ? t(`cues.sideTag.${cue.side}`) : '';
      return t('cues.summary.bubble', { actor: actor(cue.actor), side: sideTag, text: text(cue.text) });
    }
    case 'move': {
      const parts = [];
      if (cue.x !== undefined && cue.x !== null && cue.x !== '') parts.push(`x=${numText(cue.x)}`);
      if (cue.y !== undefined && cue.y !== null && cue.y !== '') parts.push(`y=${numText(cue.y)}`);
      const where = parts.length ? `(${parts.join(', ')})` : '—';
      const key = cue.relative ? 'cues.summary.moveRelative' : 'cues.summary.move';
      return t(key, { actor: actor(cue.actor), where, dur: secondsText(cue.duration) });
    }
    case 'anim': {
      const what = cue.anim ? String(cue.anim) : (cue.sprite ? `sprite ${cue.sprite}` : '—');
      return t('cues.summary.anim', { actor: actor(cue.actor), anim: what });
    }
    case 'form': {
      const form = clipText(String(cue.name ?? '—'), 18);
      return cue.anim
        ? t('cues.summary.formAnim', { actor: actor(cue.actor), form, anim: clipText(String(cue.anim), 12) })
        : t('cues.summary.form', { actor: actor(cue.actor), form });
    }
    case 'flip':
      return t('cues.summary.flip', {
        actor: actor(cue.actor),
        value: t(cue.value ? 'cues.value.on' : 'cues.value.off'),
      });
    case 'fade':
      return t('cues.summary.fade', { actor: actor(cue.actor), alpha: numText(cue.alpha), dur: secondsText(cue.duration) });
    case 'wait':
      return t('cues.summary.wait', { dur: secondsText(cue.seconds) });
    case 'sfx':
      return t('cues.summary.sfx', { sound: cue.sound || '—' });
    case 'bgm':
      return cue.track
        ? t('cues.summary.bgm', { track: String(cue.track) })
        : t('cues.summary.bgmStop');
    case 'shake':
      return t('cues.summary.shake', { amount: numText(cue.amount), dur: secondsText(cue.duration) });
    case 'flash':
      return t('cues.summary.flash', { color: String(cue.color || '—'), dur: secondsText(cue.duration) });
    case 'set': {
      const op = cue.op === 'add' ? '+=' : '=';
      return t('cues.summary.set', { name: String(cue.var ?? '—'), op, value: clipText(String(cue.value ?? '—'), 20) });
    }
    case 'mercy':
      return t('cues.summary.mercy', { enemy: actor(cue.enemy), amount: clipText(String(cue.amount ?? '—'), 16) });
    case 'heal':
      return t('cues.summary.heal', { target: targetName(cue.target), amount: clipText(String(cue.amount ?? '—'), 16) });
    case 'damage':
      return t('cues.summary.damage', { target: targetName(cue.target), amount: clipText(String(cue.amount ?? '—'), 16) });
    case 'if':
      return t('cues.summary.if', {
        cond: clipText(String(cue.cond ?? '—'), 22),
        then: countCues(cue.then),
        else: countCues(cue.else),
      });
    case 'parallel':
      return t('cues.summary.parallel', { n: countCues(cue.cues) });
    case 'attack':
      return t('cues.summary.attack', { attack: attackName(cue.attack) });
    case 'end':
      return t('cues.summary.end', { result: t(`cues.result.${cue.result || 'victory'}`) });
    default:
      return t('cues.summary.unknown', { cmd: String(cue.cmd ?? '?') });
  }
}

/** 卡片右上角的一行補充（欄位有錯時的提示、async 標記等） */
export function cueBadges(cue) {
  const out = [];
  if (!cue || typeof cue !== 'object') return out;
  if (cue.async) out.push(t('cues.badge.async'));
  const spec = getCommandSpec(cue.cmd);
  if (spec) {
    for (const field of spec.fields) {
      if (field.type === FIELD_TYPES.CUES || !field.required) continue;
      const v = cue[field.key];
      if (v === undefined || v === null || v === '' || v === '—') out.push(t('cues.badge.missing', { field: t(field.labelKey) }));
    }
  }
  return out;
}

/* ------------------------------------------------------------ 錯誤比對 */

function errorsIterable(errors) {
  if (!errors) return [];
  if (errors instanceof Map) return [...errors.entries()];
  if (typeof errors === 'object') return Object.entries(errors);
  return [];
}

/**
 * 把 store.errors（JSON 路徑 → 訊息）對到某條指令。
 * @param {Map|object} errors
 * @param {string|Array} basePath store.cuePath（cues 陣列的絕對路徑）
 * @param {Array} relPath 指令的相對路徑
 * @param {Set<string>|string[]} [fieldKeys] 這條指令的直接欄位名（決定 `x` 算欄位、`then[0].cond` 算子孫）
 * @returns {{ any:boolean, own:string|null, fields:Map<string,string>, descendants:number }}
 */
export function matchCueErrors(errors, basePath, relPath, fieldKeys) {
  const result = { any: false, own: null, fields: new Map(), descendants: 0 };
  const known = fieldKeys instanceof Set ? fieldKeys : new Set(fieldKeys || []);
  const prefix = cueAbsPath(basePath, relPath || []);
  for (const [key, message] of errorsIterable(errors)) {
    const k = String(key);
    if (k === prefix) {
      result.any = true;
      result.own = String(message);
      continue;
    }
    if (!k.startsWith(prefix)) continue;
    const next = k.charAt(prefix.length);
    if (next !== '.' && next !== '[') continue;
    result.any = true;
    if (next === '.') {
      const rest = k.slice(prefix.length + 1);
      // 只有「單一欄位名」才算欄位錯誤；巢狀（then[0].cond）算子孫
      if (rest && !/[.[\]]/.test(rest) && (known.size === 0 || known.has(rest))) {
        result.fields.set(rest, String(message));
      } else {
        result.descendants += 1;
      }
    } else {
      result.descendants += 1;
    }
  }
  return result;
}

/**
 * 指令清單本身（不是某條指令）的錯誤，例如 `turns[0].start`。
 */
export function matchListErrors(errors, basePath) {
  const prefix = typeof basePath === 'string' ? basePath : formatStorePath(basePath || []);
  const out = [];
  for (const [key, message] of errorsIterable(errors)) {
    const k = String(key);
    if (k === prefix) out.push({ path: '', message: String(message) });
  }
  return out;
}

/**
 * 開始拖曳時要套用的選取集合：被拖曳的那張卡一定要在集合裡。
 * - additive（Shift/Ctrl）→ 加進既有選取
 * - 已經在多選集合內 → 保持整個集合（一起拖）
 * - 不在集合內 → 只選這一張
 * @param {Set<string>|string[]} keys 目前的選取（卡片路徑字串）
 * @param {string} key 被拖曳的卡片
 * @param {boolean} [additive]
 * @returns {string[]} 新的選取（順序：原順序 + 補上的那張）
 */
export function selectionForDrag(keys, key, additive = false) {
  let list = [];
  if (keys instanceof Set) list = [...keys];
  else if (Array.isArray(keys)) list = keys.slice();
  const out = new Set(list.filter((k) => k !== null && k !== undefined).map(String));
  const target = key === null || key === undefined ? '' : String(key);
  if (!target) return [...out];
  if (additive || out.has(target)) out.add(target);
  else { out.clear(); out.add(target); }
  return [...out];
}

export default {
  CUE_SCHEMA,
  CUE_COMMANDS_LIST,
  CUE_GROUPS,
  getCommandSpec,
  createDefaultCue,
  cueSummary,
  selectionForDrag,
};
