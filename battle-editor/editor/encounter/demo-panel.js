/**
 * editor/encounter/demo-panel.js — 遭遇編輯器「演示」面板（AP2）
 *
 * SPEC-AUTOPLAY §4：清單式面板（與指令清單編輯器同風格）
 *   - 文字自動（auto / delay）
 *   - menuDelay（選單每次按鍵間隔幀數；0 = 每幀）
 *   - 每回合卡片（新增 / 刪除 / 順序、turn 號）
 *       卡片內每位隊員一列：command / target / option / fight / dodge
 *   - default 卡片（沒列在回合卡的回合／隊員都走它）
 *   - 錯誤顯示 validateEncounterDemo 的路徑＋訊息，可點擊定位到欄位
 *
 * 兩層：
 *   1) 純邏輯（不碰 DOM）：demo 正規化、下拉選項推算、增刪移動卡片、
 *      錯誤路徑過濾 → 由 editor/encounter/demo-panel.test.mjs 測試
 *   2) 掛載層：mount(rootEl, ctx) 與 mountDemoTab({panelEl, ctx})
 *
 * 所有寫入都走 store.update()（可復原），並帶上 undo 標籤。
 * 本檔不改引擎；驗證直接呼叫 engine/autoplay/validate-encounter.js（純 ES module）。
 */

import { t, onLocaleChange } from '../i18n.js';
import '../locales/encounter-demo.js'; // 匯入即註冊 encdemo / encauto / encanim 三語字串
import {
  el,
  clear,
  button,
  selectEl,
  checkboxEl,
  fieldRow,
  section,
  hintBox,
  emptyState,
  normalizeErrors,
  textInput,
} from '../fields.js';
import {
  validateEncounterDemo,
  DEMO_COMMANDS,
  DEMO_FIGHT_MODES,
  DEMO_DODGE_MODES,
} from '../../engine/autoplay/validate-encounter.js';

const T = (key, params) => t(`encdemo.${key}`, params);

/* =========================================================================
 * 1. 純邏輯
 * ========================================================================= */

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 名稱可能是字串或 {zh,en} → 取字串。 */
export function textOf(value) {
  if (typeof value === 'string') return value;
  if (isObj(value)) {
    if (typeof value.zh === 'string' && value.zh) return value.zh;
    if (typeof value['zh-Hant'] === 'string' && value['zh-Hant']) return value['zh-Hant'];
    if (typeof value.en === 'string' && value.en) return value.en;
  }
  return '';
}

/** 存進 demo 的參照：優先 id，其次名稱。 */
export function refOf(item) {
  if (!isObj(item)) return '';
  if (typeof item.id === 'string' && item.id) return item.id;
  if (typeof item.id === 'number' && Number.isFinite(item.id)) return String(item.id);
  return textOf(item.name);
}

/** 設定的 ref 是否符合這個項目（id、中文名、英文名都算）。 */
export function refMatches(item, ref) {
  if (!isObj(item)) return false;
  if (ref === null || ref === undefined || ref === '') return false;
  const target = String(ref).trim();
  if (!target) return false;
  const candidates = [refOf(item), textOf(item.name), isObj(item.name) ? textOf(item.name) : '', item.name];
  for (const c of candidates) {
    if (typeof c === 'string' && c && c === target) return true;
  }
  return candidates.some((c) => typeof c === 'string' && c && c.toLowerCase() === target.toLowerCase());
}

/** 比對用的正規化：小寫、去掉非英數（'X-Action' → 'xaction'）。 */
export function normRef(value) {
  return String(value === null || value === undefined ? '' : value)
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '');
}

/**
 * 把 demo 裡的值（可能是 id、中文名、英文名、任意大小寫）對到下拉選項的 value。
 * 找不到就回原值（UI 會顯示「找不到」提示）。
 * @param {Array<{value:string,label?:string}>} options
 * @param {*} ref
 */
export function matchOptionValue(options, ref) {
  const list = Array.isArray(options) ? options : [];
  const raw = ref === null || ref === undefined ? '' : String(ref);
  if (!raw) return '';
  for (const opt of list) if (String(opt.value) === raw) return opt.value;
  const want = normRef(raw);
  if (!want) return raw;
  for (const opt of list) if (normRef(opt.value) === want) return opt.value;
  for (const opt of list) if (normRef(opt.label) === want) return opt.value;
  return raw;
}

/** 派對隊員清單（只保留有 id 的）。 */
export function membersOf(doc) {
  const list = Array.isArray(doc && doc.party) ? doc.party : [];
  return list.filter((m) => isObj(m) && typeof m.id === 'string' && m.id);
}

/** 敵人名單。 */
export function enemiesOf(doc) {
  const list = Array.isArray(doc && doc.enemies) ? doc.enemies : [];
  return list.filter((e) => isObj(e) && typeof e.id === 'string' && e.id);
}

/** 本場能用的道具（count > 0；未給 count 視為 1）。 */
export function usableItemsOf(doc) {
  const list = Array.isArray(doc && doc.items) ? doc.items : [];
  return list.filter((it) => {
    if (!isObj(it)) return false;
    const n = Number(it.count === undefined ? 1 : it.count);
    return !Number.isFinite(n) || n > 0;
  });
}

/** 隊員實際可用的指令（缺 commands 時退回全部）。 */
export function commandsOf(member) {
  const list = member && Array.isArray(member.commands) ? member.commands.filter((c) => DEMO_COMMANDS.includes(c)) : [];
  return list.length ? list : DEMO_COMMANDS.slice();
}

export function memberOf(doc, id) {
  return membersOf(doc).find((m) => m.id === id) || null;
}

export function enemyOf(doc, ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  return enemiesOf(doc).find((e) => e.id === ref || refMatches(e, ref)) || null;
}

export function spellsOf(member) {
  const list = member && Array.isArray(member.spells) ? member.spells : [];
  return list.filter((s) => isObj(s) && (s.id !== undefined || s.name !== undefined));
}

export function itemOf(doc, ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  return usableItemsOf(doc).find((it) => it.id === ref || refMatches(it, ref)) || null;
}

export function spellOf(member, ref) {
  const list = spellsOf(member);
  if (!list.length) return null;
  if (ref === null || ref === undefined || ref === '') return list[0];
  return list.find((s) => s.id === ref || refMatches(s, ref)) || null;
}

export function actOf(enemy, ref) {
  if (!isObj(enemy)) return null;
  const list = Array.isArray(enemy.acts) ? enemy.acts.filter(isObj) : [];
  if (!list.length) return null;
  if (ref === null || ref === undefined || ref === '') return list[0];
  return list.find((a) => a.id === ref || refMatches(a, ref)) || null;
}

/** option 下拉的候選（依 command）。 */
export function optionsFor(doc, { memberId, command, target } = {}) {
  if (command === 'act') {
    const enemy = enemyOf(doc, target);
    const acts = enemy && Array.isArray(enemy.acts) ? enemy.acts.filter(isObj) : [];
    return acts.map((a) => ({
      value: refOf(a),
      label: textOf(a.name) || refOf(a),
      hint: a.party && a.party.length ? a.party.join(', ') : '',
    }));
  }
  if (command === 'magic') {
    const member = memberOf(doc, memberId);
    return spellsOf(member).map((s) => ({
      value: refOf(s),
      label: textOf(s.name) || refOf(s),
      hint: `${Number.isFinite(Number(s.tp)) ? `${Number(s.tp)} TP` : ''}${s.target === 'party' ? ' · party' : ''}`.trim(),
    }));
  }
  if (command === 'item') {
    return usableItemsOf(doc).map((it) => ({
      value: refOf(it),
      label: textOf(it.name) || refOf(it),
      hint: `×${Number(it.count === undefined ? 1 : it.count)}`,
    }));
  }
  return [];
}

/**
 * target 下拉要列敵人還是隊員（跟 option 有關）。
 * @returns {'enemy'|'party'|null}
 */
export function targetKindFor(doc, { memberId, command, option } = {}) {
  if (!command || command === 'defend') return null;
  if (command === 'fight' || command === 'spare' || command === 'act') return 'enemy';
  if (command === 'magic') {
    const spell = spellOf(memberOf(doc, memberId), option);
    if (!spell) return 'enemy';
    return spell.target === 'party' || spell.target === 'all' ? 'party' : 'enemy';
  }
  if (command === 'item') {
    const item = itemOf(doc, option);
    return item && item.target === 'enemy' ? 'enemy' : 'party';
  }
  return null;
}

/** target 下拉的候選。 */
export function targetsFor(doc, ctx = {}) {
  const kind = targetKindFor(doc, ctx);
  if (kind === 'enemy') {
    return enemiesOf(doc).map((e) => ({
      value: e.id,
      label: textOf(e.name) || e.id,
      hint: e.hp !== undefined ? `${Number(e.hp)} HP` : '',
    }));
  }
  if (kind === 'party') {
    return membersOf(doc).map((m) => ({
      value: m.id,
      label: textOf(m.name) || m.id,
      hint: m.hp !== undefined ? `${Number(m.hp)} HP` : '',
    }));
  }
  return [];
}

/** 一行選擇的摘要（卡片頭與提示用）。 */
export function describeChoice(doc, choice) {
  if (!isObj(choice)) return '';
  const member = memberOf(doc, choice.member);
  const name = member ? textOf(member.name) || member.id : String(choice.member || '?');
  const bits = [name, String(choice.command || '?')];
  if (choice.target) bits.push(String(choice.target));
  if (choice.option) bits.push(String(choice.option));
  if (choice.fight !== undefined) bits.push(`fight:${choice.fight}`);
  return bits.join(' · ');
}

/** demo 物件（不存在就回空殼，不寫入）。 */
export function demoOf(doc) {
  return doc && isObj(doc.demo) ? doc.demo : null;
}

/** 回合卡（依 turn 號排序；沒有 turn 的排最後）。 */
export function turnEntries(demo) {
  if (!isObj(demo) || !Array.isArray(demo.turns)) return [];
  const list = demo.turns.map((entry, index) => ({ entry, index })).filter((it) => isObj(it.entry));
  list.sort((a, b) => {
    const na = Number(a.entry.turn);
    const nb = Number(b.entry.turn);
    const fa = Number.isFinite(na) ? na : Number.MAX_SAFE_INTEGER;
    const fb = Number.isFinite(nb) ? nb : Number.MAX_SAFE_INTEGER;
    if (fa !== fb) return fa - fb;
    return a.index - b.index;
  });
  return list;
}

/** 下一個可用的回合號（1 起算；已用的跳過）。 */
export function nextTurnNumber(demo, turnCount = 0) {
  const used = new Set(
    (isObj(demo) && Array.isArray(demo.turns) ? demo.turns : [])
      .map((e) => (isObj(e) ? Number(e.turn) : NaN))
      .filter((n) => Number.isFinite(n) && n >= 1),
  );
  for (let n = 1; n <= Math.max(1, Number(turnCount) || 0); n += 1) {
    if (!used.has(n)) return n;
  }
  let n = 1;
  while (used.has(n)) n += 1;
  return n;
}

/** 建立空的 demo（寫進 draft 用）。 */
export function createDemo() {
  return {
    text: { auto: true, delay: 0.5 },
    menuDelay: 6,
    turns: [],
    default: { choices: 'fight', fight: 'good', dodge: 'bot' },
  };
}

/** 確保 draft.demo 存在；回傳該物件（會被 store.update 的 draft 擁有）。 */
export function ensureDemo(draft) {
  if (!isObj(draft.demo)) draft.demo = createDemo();
  const demo = draft.demo;
  if (!isObj(demo.text)) demo.text = { auto: true, delay: 0.5 };
  if (!Array.isArray(demo.turns)) demo.turns = [];
  if (!isObj(demo.default)) demo.default = { choices: 'fight', fight: 'good', dodge: 'bot' };
  return demo;
}

/** 找到某隊員在這張回合卡的選擇（沒有就 null）。 */
export function choiceForMember(entry, memberId) {
  if (!isObj(entry) || !Array.isArray(entry.choices)) return null;
  return entry.choices.find((c) => isObj(c) && c.member === memberId) || null;
}

/** 找到或建立某隊員在這張回合卡的選擇（draft 內用）。 */
export function ensureChoice(draft, entryIndex, memberId) {
  const demo = ensureDemo(draft);
  const entry = demo.turns[entryIndex];
  if (!isObj(entry)) return null;
  if (!Array.isArray(entry.choices)) entry.choices = [];
  let choice = entry.choices.find((c) => isObj(c) && c.member === memberId) || null;
  if (!choice) {
    const member = memberOf(draft, memberId);
    const commands = member ? commandsOf(member) : DEMO_COMMANDS.slice();
    choice = { member: memberId, command: commands.includes('fight') ? 'fight' : commands[0] };
    entry.choices.push(choice);
  }
  return choice;
}

/** 移除某隊員在這張回合卡的選擇（回到預設）。 */
export function removeChoice(draft, entryIndex, memberId) {
  const demo = ensureDemo(draft);
  const entry = demo.turns[entryIndex];
  if (!isObj(entry) || !Array.isArray(entry.choices)) return false;
  const before = entry.choices.length;
  entry.choices = entry.choices.filter((c) => !(isObj(c) && c.member === memberId));
  return entry.choices.length !== before;
}

/** 新增一張回合卡（draft 內用）；回傳新卡。 */
export function addTurnCard(draft, turnCount = 0) {
  const demo = ensureDemo(draft);
  const turn = nextTurnNumber(demo, turnCount);
  const entry = { turn, choices: [] };
  demo.turns.push(entry);
  return entry;
}

/** 刪除第 index 張卡（draft 內用）。 */
export function removeTurnCard(draft, index) {
  const demo = ensureDemo(draft);
  if (!Number.isInteger(index) || index < 0 || index >= demo.turns.length) return false;
  demo.turns.splice(index, 1);
  return true;
}

/**
 * 移動卡片順序：與相鄰卡片交換 turn 號（＝腳本順序改變）；
 * 沒 turn 號時只交換陣列位置。
 * @param {object} draft
 * @param {number} index
 * @param {number} delta -1 上移 / +1 下移
 */
export function moveTurnCard(draft, index, delta) {
  const demo = ensureDemo(draft);
  const order = turnEntries(demo);
  const pos = order.findIndex((it) => it.index === index);
  if (pos < 0) return false;
  const targetPos = pos + (delta < 0 ? -1 : 1);
  if (targetPos < 0 || targetPos >= order.length) return false;
  const a = order[pos];
  const b = order[targetPos];
  const na = Number(a.entry.turn);
  const nb = Number(b.entry.turn);
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) {
    a.entry.turn = nb;
    b.entry.turn = na;
    return true;
  }
  const list = demo.turns;
  const tmp = list[a.index];
  list[a.index] = list[b.index];
  list[b.index] = tmp;
  return true;
}

/** 設定／清除卡片或選擇上的欄位（值為 '' / undefined 就刪）。 */
export function setField(target, key, value) {
  if (!isObj(target)) return false;
  if (value === '' || value === null || value === undefined) {
    if (!(key in target)) return false;
    delete target[key];
    return true;
  }
  if (target[key] === value) return false;
  target[key] = value;
  return true;
}

/** default.choices 正規化：字串指令或 choice 陣列。 */
export function defaultChoicesKind(demo) {
  const d = isObj(demo) && isObj(demo.default) ? demo.default : null;
  if (!d || d.choices === undefined || d.choices === null) return { kind: 'unset', value: '', list: [] };
  if (typeof d.choices === 'string') return { kind: 'command', value: d.choices, list: [] };
  if (Array.isArray(d.choices)) return { kind: 'array', value: '', list: d.choices.filter(isObj) };
  return { kind: 'invalid', value: '', list: [] };
}

/** 把 store.errors（Map 或 [{path,message}]）過濾成 demo 的錯誤清單。 */
export function demoErrors(errors) {
  const out = [];
  const push = (path, message) => {
    const p = String(path || '');
    if (p === 'demo' || p.startsWith('demo.')) out.push({ path: p, message: String(message || '') });
  };
  if (errors instanceof Map) {
    for (const [k, v] of errors) push(k, v);
  } else if (Array.isArray(errors)) {
    for (const item of errors) if (isObj(item)) push(item.path || item.key, item.message || item.msg);
  } else if (isObj(errors)) {
    for (const [k, v] of Object.entries(errors)) push(k, v);
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** 直接跑驗證（面板給提示用；不依賴 preview 是否已即時驗證）。 */
export function validateDemo(doc) {
  if (!isObj(doc) || doc.demo === undefined || doc.demo === null) return [];
  try {
    return validateEncounterDemo(doc.demo, doc).map((e) => ({ path: String(e.path || 'demo'), message: String(e.message || '') }));
  } catch (err) {
    return [{ path: 'demo', message: err && err.message ? err.message : String(err) }];
  }
}

/** 面板摘要（分頁標籤、`#enc-cue-path` 用）。 */
export function demoSummary(doc) {
  const demo = demoOf(doc);
  if (!demo) return { hasDemo: false, cards: 0, choices: 0, turnCount: Array.isArray(doc && doc.turns) ? doc.turns.length : 0 };
  const entries = turnEntries(demo);
  let choices = 0;
  for (const { entry } of entries) if (Array.isArray(entry.choices)) choices += entry.choices.filter(isObj).length;
  const d = isObj(demo.default) ? demo.default : {};
  return {
    hasDemo: true,
    cards: entries.length,
    choices,
    turnCount: Array.isArray(doc && doc.turns) ? doc.turns.length : 0,
    autoText: !(isObj(demo.text) && demo.text.auto === false),
    menuDelay: Number.isFinite(Number(demo.menuDelay)) ? Number(demo.menuDelay) : 6,
    defaultKind: defaultChoicesKind(demo).kind,
    defaultChoices: d.choices === undefined ? null : d.choices,
  };
}

/**
 * 錯誤路徑 → 要定位的欄位（同一張卡／同一列的子欄位共用一個 data-demo-path）。
 * 例：demo.turns[0].choices[1].option → demo.turns[0].choices[1]
 */
export function fieldPathFor(errorPath) {
  const path = String(errorPath || '');
  const choice = /^(demo\.turns\[\d+\]\.choices\[\d+\])/.exec(path);
  if (choice) return choice[1];
  const turn = /^(demo\.turns\[\d+\])/.exec(path);
  if (turn) return turn[1];
  if (path === 'demo.default' || path.startsWith('demo.default.')) return 'demo.default';
  if (path === 'demo.text' || path.startsWith('demo.text.')) return 'demo.text';
  if (path === 'demo.menuDelay') return 'demo.menuDelay';
  return path || 'demo';
}

/* =========================================================================
 * 2. 版面小工具
 * ========================================================================= */

function ensureDemoStyles() {
  if (typeof document === 'undefined') return;
  const href = (() => {
    try {
      return new URL('./demo-panel.css', import.meta.url).href;
    } catch (_err) {
      return 'demo-panel.css';
    }
  })();
  const links = Array.from(document.querySelectorAll('link[rel="stylesheet"]'));
  const exists = links.some((link) => {
    const raw = link.getAttribute('href') || '';
    if (!raw) return false;
    if (raw.endsWith('demo-panel.css')) return true;
    try {
      return new URL(raw, document.baseURI).href === href;
    } catch (_err) {
      return false;
    }
  });
  if (exists) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.demoPanelCss = '1';
  document.head.appendChild(link);
}

/** 一個帶錯誤提示的 <select>（錯誤路徑掛在 data-demo-path 上，交由列處理）。 */
function demoSelect(options, value, onChange, opts = {}) {
  const list = Array.isArray(options) ? options.slice() : [];
  const has = list.some((o) => String(o.value) === String(value ?? ''));
  if (value !== undefined && value !== null && value !== '' && !has) {
    list.push({ value, label: T('optionMissing', { name: String(value) }), missing: true });
  }
  const node = selectEl(list, value ?? '', onChange, { class: `encdemo-select${opts.class ? ` ${opts.class}` : ''}` });
  if (opts.disabled) node.disabled = true;
  if (opts.width) node.style.maxWidth = opts.width;
  // F3：短標籤 + 完整說明。每個 <option> 也帶 title（滑過展開清單就看得到全文），
  // 收起來的 select 則顯示「目前選取項」的完整說明。
  const titleFor = (v) => {
    const hit = list.find((o) => String(o.value) === String(v ?? ''));
    return hit && typeof hit.title === 'string' && hit.title ? hit.title : '';
  };
  const opts_ = Array.from(node.options || node.querySelectorAll('option') || []);
  for (const optNode of opts_) {
    const full = titleFor(optNode.value);
    if (full) optNode.title = full;
  }
  const applyTitle = () => {
    const full = titleFor(node.value);
    node.title = full || opts.title || '';
  };
  applyTitle();
  node.addEventListener('change', applyTitle);
  if (opts.title && !node.title) node.title = opts.title;
  return node;
}

/** 數值輸入（允許空字串 = 未指定）。 */
function demoNumber(value, onChange, opts = {}) {
  const input = el('input', {
    type: 'number',
    class: 'pan-input pan-input-num encdemo-num',
    step: opts.step === undefined ? '1' : String(opts.step),
    min: opts.min === undefined ? null : String(opts.min),
    max: opts.max === undefined ? null : String(opts.max),
  });
  input.value = value === undefined || value === null ? '' : String(value);
  const commitNum = () => {
    const raw = input.value.trim();
    if (raw === '') {
      onChange(null);
      return;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      input.value = value === undefined || value === null ? '' : String(value);
      return;
    }
    let out = n;
    if (opts.integer) out = Math.round(out);
    if (opts.min !== undefined && out < opts.min) out = opts.min;
    if (opts.max !== undefined && out > opts.max) out = opts.max;
    if (out !== n) input.value = String(out);
    onChange(out);
  };
  input.addEventListener('change', commitNum);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitNum();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = value === undefined || value === null ? '' : String(value);
      input.blur();
    }
  });
  return input;
}

const FIGHT_LABEL = (mode) => T(`fight.${mode}`);
const DODGE_LABEL = (mode) => T(`dodge.${mode}`);
const COMMAND_LABEL = (cmd) => T(`command.${cmd}`);
/** F3：下拉顯示短標籤（perfect / good / …），完整說明放 title，避免被欄寬截斷 */
const FIGHT_HELP = (mode) => T(`fight.full.${mode}`);
const DODGE_HELP = (mode) => T(`dodge.full.${mode}`);

function fightOptions(current) {
  const list = [{ value: '', label: T('unset') }];
  for (const mode of DEMO_FIGHT_MODES) list.push({ value: mode, label: FIGHT_LABEL(mode), title: FIGHT_HELP(mode) });
  list.push({ value: '#number', label: '0..1', title: T('fight.full.number') });
  if (typeof current === 'number') return list;
  return list;
}

function dodgeOptions() {
  const list = [{ value: '', label: T('unset') }];
  for (const mode of DEMO_DODGE_MODES) list.push({ value: mode, label: DODGE_LABEL(mode), title: DODGE_HELP(mode) });
  return list;
}

/* =========================================================================
 * 3. 掛載層
 * ========================================================================= */

/**
 * 掛載「演示」面板。
 * @param {HTMLElement} rootEl
 * @param {object} ctx  { store, preview, report?, ... }
 */
export function mount(rootEl, ctx = {}) {
  if (!rootEl || typeof document === 'undefined') return { destroy() {} };
  ensureDemoStyles();

  const previous = instances.get(rootEl);
  if (previous && typeof previous.destroy === 'function') previous.destroy();

  const store = ctx.store || null;
  const state = {
    destroyed: false,
    sections: {},
    focusPath: null,
    lastSig: '',
    unsub: null,
    offLocale: null,
  };

  rootEl.classList.add('encdemo-root');
  rootEl.innerHTML = '';

  const ui = {
    toolbar: el('div', { class: 'encdemo-toolbar' }),
    addBtn: el('div', { class: 'encdemo-toolbar-actions' }),
    note: el('span', { class: 'encdemo-note' }),
    scroll: el('div', { class: 'encdemo-scroll' }),
    list: el('div', { class: 'encdemo-list' }),
  };
  ui.toolbar.append(ui.addBtn, ui.note);
  ui.scroll.appendChild(ui.list);
  rootEl.append(ui.toolbar, ui.scroll);

  const doc = () => (store && store.doc ? store.doc : null);

  const commit = (fn, label) => {
    if (!store || typeof store.update !== 'function') return false;
    try {
      return store.update(fn, { label: label || T('undoSettings') });
    } catch (err) {
      console.warn('[demo-panel] 寫入失敗：', err);
      return false;
    }
  };

  const turnCount = () => (Array.isArray(doc() && doc().turns) ? doc().turns.length : 0);
  const report = (message, kind) => {
    if (typeof ctx.report === 'function') {
      try {
        ctx.report(message, kind || 'info');
      } catch (_err) {
        /* 忽略 */
      }
    }
  };

  /* ------------------------------------------------------- 寫入動作 */

  const setDemoField = (mutate, label) =>
    commit((draft) => {
      const demo = ensureDemo(draft);
      mutate(demo, draft);
    }, label);

  const onToggleAuto = (on) =>
    setDemoField((demo) => {
      demo.text = isObj(demo.text) ? demo.text : {};
      demo.text.auto = Boolean(on);
    }, T('undoSettings'));

  const onDelay = (seconds) =>
    setDemoField((demo) => {
      demo.text = isObj(demo.text) ? demo.text : {};
      if (seconds === null) delete demo.text.delay;
      else demo.text.delay = seconds;
    }, T('undoSettings'));

  const onMenuDelay = (frames) =>
    setDemoField((demo) => {
      if (frames === null) delete demo.menuDelay;
      else demo.menuDelay = Math.max(0, Math.round(frames));
    }, T('undoSettings'));

  const onCreateDemo = () =>
    commit((draft) => {
      if (!isObj(draft.demo)) draft.demo = createDemo();
    }, T('undoSettings'));

  const onAddTurn = () => {
    const ok = commit((draft) => {
      addTurnCard(draft, Array.isArray(draft.turns) ? draft.turns.length : 0);
    }, T('undoAddTurn'));
    if (ok) report(T('undoAddTurn'));
    render();
    return ok;
  };

  const onRemoveTurn = (index) =>
    commit((draft) => {
      removeTurnCard(draft, index);
    }, T('undoRemoveTurn'));

  const onMoveTurn = (index, delta) =>
    commit((draft) => {
      moveTurnCard(draft, index, delta);
    }, T('undoMoveTurn'));

  const onTurnNumber = (index, value) =>
    commit((draft) => {
      const demo = ensureDemo(draft);
      const entry = demo.turns[index];
      if (!isObj(entry)) return;
      if (value === null) delete entry.turn;
      else entry.turn = value;
    }, T('undoCard'));

  const onTurnField = (index, key, value) =>
    commit((draft) => {
      const demo = ensureDemo(draft);
      const entry = demo.turns[index];
      if (!isObj(entry)) return;
      setField(entry, key, value);
    }, T('undoCard'));

  const onChoiceField = (index, memberId, key, value) =>
    commit((draft) => {
      if (value === '' || value === null || value === undefined) {
        if (key === 'command') {
          removeChoice(draft, index, memberId);
          return;
        }
        const demo = ensureDemo(draft);
        const entry = demo.turns[index];
        const choice = isObj(entry) && Array.isArray(entry.choices) ? entry.choices.find((c) => isObj(c) && c.member === memberId) : null;
        if (choice) setField(choice, key, '');
        return;
      }
      const choice = ensureChoice(draft, index, memberId);
      if (!choice) return;
      if (key === 'command') {
        if (choice.command !== value) {
          delete choice.target;
          delete choice.option;
        }
        choice.command = value;
        return;
      }
      if (key === 'target' || key === 'option') {
        // 換了 ACT 目標 → option 失效；換了法術／道具 → target 種類可能翻轉
        setField(choice, key, value);
        if (key === 'target') delete choice.option;
        if (key === 'option' && choice.command === 'magic') delete choice.target;
        if (key === 'option' && choice.command === 'item') delete choice.target;
        return;
      }
      setField(choice, key, value);
    }, T('undoChoice'));

  const onDefaultField = (key, value) =>
    commit((draft) => {
      const demo = ensureDemo(draft);
      demo.default = isObj(demo.default) ? demo.default : {};
      if (key === 'choices' && value === '') delete demo.default.choices;
      else if (value === '' || value === null || value === undefined) delete demo.default[key];
      else demo.default[key] = value;
    }, T('undoDefault'));

  const onDefaultArrayToCommand = () =>
    commit((draft) => {
      const demo = ensureDemo(draft);
      demo.default = isObj(demo.default) ? demo.default : {};
      demo.default.choices = 'fight';
    }, T('undoDefault'));

  /* ------------------------------------------------------------- 渲染 */

  const fieldErrorMap = () => {
    const previewErrors = ctx.preview && typeof ctx.preview.getErrors === 'function' ? ctx.preview.getErrors() : null;
    const merged = new Map();
    const put = (errs) => {
      for (const [k, v] of normalizeErrors(errs)) merged.set(k, v);
    };
    if (previewErrors) put(previewErrors);
    if (store && store.errors) put(store.errors);
    return merged;
  };

  const sigOf = () => {
    const d = doc();
    const demo = demoOf(d);
    const errs = fieldErrorMap();
    const errPart = Array.from(errs.keys())
      .filter((k) => k === 'demo' || k.startsWith('demo.'))
      .sort()
      .map((k) => `${k}=${errs.get(k)}`)
      .join('\n');
    return `${demo ? JSON.stringify(demo) : 'nodemo'}|${errPart}|${turnCount()}`;
  };

  const fieldError = (errors, path) => {
    const hit = normalizeErrors(errors).get(path);
    return typeof hit === 'string' ? hit : hit ? String(hit) : '';
  };

  /** 一列隊員（command / target / option / fight / dodge）。 */
  const memberRow = (demo, entryIndex, entry, member, errors) => {
    const d = doc();
    const choice = choiceForMember(entry, member.id);
    const command = choice && typeof choice.command === 'string' ? choice.command : '';
    const target = choice && choice.target !== undefined ? String(choice.target) : '';
    const option = choice && choice.option !== undefined ? String(choice.option) : '';
    const path = choice ? `demo.turns[${entryIndex}].choices[${choicesIndex(entry, member.id)}]` : `demo.turns[${entryIndex}]`;
    const row = el('div', { class: 'encdemo-row', dataset: { demoPath: path } });

    row.appendChild(
      el('span', {
        class: 'encdemo-member',
        text: textOf(member.name) || member.id,
        title: member.id,
      }),
    );

    const commands = commandsOf(member);
    const cmdOptions = [{ value: '', label: T('unset') }].concat(commands.map((c) => ({ value: c, label: COMMAND_LABEL(c) })));
    const cmdSel = demoSelect(cmdOptions, matchOptionValue(cmdOptions, command), (v) => {
      onChoiceField(entryIndex, member.id, 'command', v);
      render();
    }, { disabled: false, width: '120px' });
    row.appendChild(cmdSel);

    const kind = targetKindFor(d, { memberId: member.id, command, option });
    const targets = targetsFor(d, { memberId: member.id, command, option });
    const targetOptions = [{ value: '', label: kind ? T('unset') : T('noTarget') }].concat(targets.map((o) => ({ value: o.value, label: o.label })));
    const tgtSel = demoSelect(targetOptions, matchOptionValue(targetOptions, target), (v) => {
      onChoiceField(entryIndex, member.id, 'target', v);
      render();
    }, { disabled: !kind, width: '130px' });
    row.appendChild(tgtSel);

    const options = optionsFor(d, { memberId: member.id, command, target });
    const optOptions = [{ value: '', label: options.length ? T('unset') : T('noOptions') }].concat(
      options.map((o) => ({ value: o.value, label: o.label })),
    );
    const optSel = demoSelect(optOptions, matchOptionValue(optOptions, option), (v) => {
      onChoiceField(entryIndex, member.id, 'option', v);
      render();
    }, { disabled: !options.length, width: '' });
    row.appendChild(optSel);

    /* fight（choice 覆寫） */
    const fightCell = el('div', { class: 'encdemo-cell encdemo-fightcell' });
    const fightValue = choice && choice.fight !== undefined ? choice.fight : '';
    const fightSel = demoSelect(fightOptions(fightValue), typeof fightValue === 'number' ? '#number' : String(fightValue), (v) => {
      if (v === '#number') {
        onChoiceField(entryIndex, member.id, 'fight', 0);
      } else {
        onChoiceField(entryIndex, member.id, 'fight', v);
      }
      render();
    }, { width: '120px' });
    fightCell.appendChild(fightSel);
    if (typeof fightValue === 'number') {
      fightCell.appendChild(
        demoNumber(fightValue, (v) => {
          onChoiceField(entryIndex, member.id, 'fight', v === null ? '' : v);
          render();
        }, { step: '0.05', min: 0, max: 1 }),
      );
    }
    row.appendChild(fightCell);

    /* dodge（choice 覆寫） */
    const dodgeValue = choice && choice.dodge !== undefined ? choice.dodge : '';
    row.appendChild(
      demoSelect(dodgeOptions(), dodgeValue, (v) => {
        onChoiceField(entryIndex, member.id, 'dodge', v);
        render();
      }, { width: '120px' }),
    );

    const err = [path, `${path}.command`, `${path}.target`, `${path}.option`]
      .map((p) => fieldError(errors, p))
      .filter(Boolean)[0];
    if (err) {
      row.classList.add('is-error');
      row.title = err;
    }
    return row;
  };

  const choicesIndex = (entry, memberId) => {
    const list = isObj(entry) && Array.isArray(entry.choices) ? entry.choices : [];
    return list.findIndex((c) => isObj(c) && c.member === memberId);
  };

  /** 一張回合卡。 */
  const turnCard = (demo, entryIndex, entry, number, errors) => {
    const d = doc();
    const cardPath = `demo.turns[${entryIndex}]`;
    const card = el('div', { class: 'encdemo-card', dataset: { demoPath: cardPath } });

    const head = el('div', { class: 'encdemo-card-head' });
    head.appendChild(el('span', { class: 'encdemo-card-title', text: T('cardTitle', { n: Number(entry.turn) || number }) }));
    const choiceRows = isObj(entry) && Array.isArray(entry.choices) ? entry.choices.filter(isObj).length : 0;
    head.appendChild(el('span', { class: 'encdemo-chip', text: `${choiceRows}` }));

    const turnInput = demoNumber(entry.turn, (v) => {
      onTurnNumber(entryIndex, v);
      render();
    }, { integer: true, min: 1 });
    // 標題已經寫了「第 N 回合」，輸入框只留 tooltip 說明，避免標籤重複
    turnInput.title = T('turnNo');
    turnInput.setAttribute('aria-label', T('turnNo'));
    turnInput.classList.add('encdemo-turnnum');
    head.appendChild(turnInput);

    /* 回合層級 fight / dodge */
    const turnFight = entry.fight !== undefined ? entry.fight : '';
    head.appendChild(
      demoSelect(fightOptions(turnFight), typeof turnFight === 'number' ? '#number' : String(turnFight), (v) => {
        if (v === '#number') onTurnField(entryIndex, 'fight', 0);
        else onTurnField(entryIndex, 'fight', v);
        render();
      }, { class: 'encdemo-headselect', width: '110px' }),
    );
    head.appendChild(
      demoSelect(dodgeOptions(), entry.dodge !== undefined ? entry.dodge : '', (v) => {
        onTurnField(entryIndex, 'dodge', v);
        render();
      }, { class: 'encdemo-headselect', width: '110px' }),
    );

    const up = button('▲', {
      small: true,
      class: 'encdemo-mini',
      title: T('up'),
      disabled: number <= 1,
      onClick: (e) => {
        e.stopPropagation();
        onMoveTurn(entryIndex, -1);
        render();
      },
    });
    const down = button('▼', {
      small: true,
      class: 'encdemo-mini',
      title: T('down'),
      onClick: (e) => {
        e.stopPropagation();
        onMoveTurn(entryIndex, 1);
        render();
      },
    });
    const del = button('✕', {
      small: true,
      variant: 'danger',
      class: 'encdemo-mini',
      title: T('remove'),
      onClick: (e) => {
        e.stopPropagation();
        onRemoveTurn(entryIndex);
        render();
      },
    });
    head.append(up, down, del);
    card.appendChild(head);

    const body = el('div', { class: 'encdemo-card-body' });
    const members = membersOf(d);
    if (!members.length) {
      body.appendChild(el('div', { class: 'encdemo-empty', text: T('emptySub') }));
    }
    for (const member of members) body.appendChild(memberRow(demo, entryIndex, entry, member, errors));
    card.appendChild(body);

    const errs = demoErrors(errors).filter((e) => e.path.startsWith(cardPath));
    if (errs.length) card.classList.add('is-error');
    return card;
  };

  /** 設定區（文字自動 / delay / menuDelay）。 */
  const settingsBlock = (demo, errors) => {
    const wrap = el('div', { class: 'encdemo-settings' });
    const text = isObj(demo.text) ? demo.text : {};
    const autoOn = text.auto !== false;

    const autoRow = el('div', { class: 'encdemo-inline', dataset: { demoPath: 'demo.text' } });
    autoRow.appendChild(checkboxEl(autoOn, (v) => {
      onToggleAuto(v);
      render();
    }, T('auto')));
    autoRow.appendChild(el('span', { class: 'encdemo-hint', text: T('autoHint', { delay: Number.isFinite(Number(text.delay)) ? Number(text.delay) : 0 }) }));
    wrap.appendChild(autoRow);

    const delayRow = el('div', { class: 'encdemo-inline', dataset: { demoPath: 'demo.text.delay' } });
    delayRow.appendChild(el('span', { class: 'encdemo-mini-label', text: T('delay') }));
    delayRow.appendChild(demoNumber(text.delay, (v) => {
      onDelay(v);
      render();
    }, { step: '0.1', min: 0, max: 10 }));
    wrap.appendChild(delayRow);

    const menuRow = el('div', { class: 'encdemo-inline', dataset: { demoPath: 'demo.menuDelay' } });
    menuRow.appendChild(el('span', { class: 'encdemo-mini-label', text: T('menuDelay') }));
    menuRow.appendChild(demoNumber(demo.menuDelay, (v) => {
      onMenuDelay(v);
      render();
    }, { integer: true, min: 0, max: 60 }));
    menuRow.appendChild(el('span', { class: 'encdemo-hint', text: T('menuDelayHint') }));
    wrap.appendChild(menuRow);

    const err = fieldError(errors, 'demo.menuDelay');
    if (err) menuRow.classList.add('is-error');
    const textErr = fieldError(errors, 'demo.text') || fieldError(errors, 'demo.text.delay') || fieldError(errors, 'demo.text.auto');
    if (textErr) autoRow.classList.add('is-error');
    return wrap;
  };

  /** default 卡片。 */
  const defaultCard = (demo, errors) => {
    const d = doc();
    const info = defaultChoicesKind(demo);
    const card = el('div', { class: 'encdemo-card encdemo-card-default', dataset: { demoPath: 'demo.default' } });
    const head = el('div', { class: 'encdemo-card-head' });
    head.appendChild(el('span', { class: 'encdemo-card-title', text: T('defaultCardTitle') }));
    head.appendChild(el('span', { class: 'encdemo-hint', text: T('defaultHint') }));
    card.appendChild(head);
    const body = el('div', { class: 'encdemo-card-body encdemo-default-body' });

    const choiceRow = el('div', { class: 'encdemo-inline' });
    choiceRow.appendChild(el('span', { class: 'encdemo-mini-label', text: T('defaultChoices') }));
    if (info.kind === 'array') {
      choiceRow.appendChild(el('span', { class: 'encdemo-hint', text: T('defaultCustom', { n: info.list.length }) }));
      choiceRow.appendChild(
        button(T('defaultChoices'), {
          small: true,
          onClick: () => {
            onDefaultArrayToCommand();
            render();
          },
        }),
      );
    } else {
      const opts = [{ value: '', label: T('unset') }].concat(DEMO_COMMANDS.map((c) => ({ value: c, label: COMMAND_LABEL(c) })));
      choiceRow.appendChild(
        demoSelect(opts, matchOptionValue(opts, info.kind === 'command' ? info.value : ''), (v) => {
          onDefaultField('choices', v);
          render();
        }, { width: '160px' }),
      );
    }
    body.appendChild(choiceRow);

    const fightRow = el('div', { class: 'encdemo-inline' });
    fightRow.appendChild(el('span', { class: 'encdemo-mini-label', text: T('defaultFight') }));
    const df = isObj(demo.default) ? demo.default.fight : undefined;
    fightRow.appendChild(
      demoSelect(fightOptions(df), typeof df === 'number' ? '#number' : String(df ?? ''), (v) => {
        if (v === '#number') onDefaultField('fight', 0);
        else onDefaultField('fight', v);
        render();
      }, { width: '140px' }),
    );
    body.appendChild(fightRow);

    const dodgeRow = el('div', { class: 'encdemo-inline' });
    dodgeRow.appendChild(el('span', { class: 'encdemo-mini-label', text: T('defaultDodge') }));
    const dd = isObj(demo.default) ? demo.default.dodge : undefined;
    dodgeRow.appendChild(
      demoSelect(dodgeOptions(), dd ?? '', (v) => {
        onDefaultField('dodge', v);
        render();
      }, { width: '140px' }),
    );
    body.appendChild(dodgeRow);

    card.appendChild(body);
    if (demoErrors(errors).some((e) => e.path.startsWith('demo.default'))) card.classList.add('is-error');
    return card;
  };

  /** 錯誤清單（路徑 + 訊息 + 定位按鈕）。 */
  const errorsBlock = (errors) => {
    const list = demoErrors(errors);
    const wrap = el('div', { class: 'encdemo-errors' });
    const head = el('div', { class: 'encdemo-errors-head' });
    head.appendChild(el('span', { class: 'encdemo-errors-title', text: `${T('errorsTitle')}${list.length ? `（${T('errorsCount', { n: list.length })}）` : ''}` }));
    head.appendChild(el('span', { class: 'encdemo-hint', text: T('errorsHint') }));
    wrap.appendChild(head);
    if (!list.length) {
      wrap.appendChild(el('div', { class: 'encdemo-errors-none', text: T('errorsNone') }));
      return wrap;
    }
    for (const item of list) {
      const row = el('div', { class: 'encdemo-errrow' });
      const code = el('code', { class: 'encdemo-errpath', text: item.path });
      const msg = el('span', { class: 'encdemo-errmsg', text: item.message });
      const jump = button(T('jump'), {
        small: true,
        class: 'encdemo-jump',
        title: item.path,
        onClick: () => {
          const target = locateField(rootEl, item.path);
          if (target && typeof target.scrollIntoView === 'function') {
            target.scrollIntoView({ block: 'center', behavior: 'smooth' });
            target.classList.add('is-flash');
            setTimeout(() => {
              try {
                target.classList.remove('is-flash');
              } catch (_err) {
                /* 忽略 */
              }
            }, 1200);
          } else {
            report(T('errorsHint'), 'warn');
          }
        },
      });
      row.append(code, msg, jump);
      wrap.appendChild(row);
    }
    return wrap;
  };

  const render = () => {
    if (state.destroyed) return;
    const d = doc();
    const scrollTop = ui.scroll.scrollTop;
    const active = document.activeElement;
    const focusPath = active && active.dataset ? active.dataset.demoPath || null : null;
    const errors = fieldErrorMap();

    clear(ui.list);
    clear(ui.addBtn);
    ui.note.textContent = '';

    if (!d) {
      ui.list.appendChild(emptyState(T('title'), t('tip.noDoc') || ''));
      ui.addBtn.appendChild(
        button(T('addTurn'), {
          small: true,
          disabled: true,
          onClick: () => {},
        }),
      );
      return;
    }

    const demo = demoOf(d);
    if (!demo) {
      ui.list.appendChild(emptyState(T('title'), T('hint')));
      ui.addBtn.appendChild(button('＋ demo', { small: true, variant: 'primary', onClick: onCreateDemo }));
      ui.list.appendChild(hintBox(T('emptySub')));
      state.lastSig = sigOf();
      return;
    }

    ui.addBtn.appendChild(button(T('addTurn'), { small: true, variant: 'primary', onClick: onAddTurn }));
    const summary = demoSummary(d);
    ui.note.textContent = T('scriptedRounds', { n: summary.cards });

    ui.list.appendChild(settingsBlock(demo, errors));
    ui.list.appendChild(errorsBlock(errors));

    const entries = turnEntries(demo);
    if (!entries.length) {
      ui.list.appendChild(emptyState(T('empty'), T('emptySub')));
    } else {
      ui.list.appendChild(el('div', { class: 'encdemo-section-title', text: T('turnsTitle') }));
      entries.forEach(({ entry, index }, i) => {
        ui.list.appendChild(turnCard(demo, index, entry, i + 1, errors));
      });
    }
    ui.list.appendChild(defaultCard(demo, errors));

    ui.scroll.scrollTop = scrollTop;
    if (focusPath) {
      const next = ui.list.querySelector(`[data-demo-path="${focusPath.replace(/"/g, '\\"')}"]`);
      if (next && typeof next.focus === 'function') {
        const input = next.matches('input, select, button') ? next : next.querySelector('input, select, button');
        if (input) input.focus();
      }
    }
    state.lastSig = sigOf();
  };

  const onStoreChange = (_s, change) => {
    if (state.destroyed) return;
    if (change && change.selectionOnly) return;
    render();
  };

  state.unsub = store && typeof store.subscribe === 'function' ? store.subscribe(onStoreChange) : null;
  state.offLocale =
    typeof onLocaleChange === 'function'
      ? onLocaleChange(() => {
          if (state.destroyed) return;
          render();
        })
      : null;

  render();

  const api = {
    refresh: () => render(),
    getDemo: () => demoOf(doc()),
    getSummary: () => demoSummary(doc()),
    getErrors: () => demoErrors(fieldErrorMap()),
    addTurn: () => onAddTurn(),
    get root() {
      return rootEl;
    },
    destroy() {
      state.destroyed = true;
      if (state.unsub) state.unsub();
      if (state.offLocale) state.offLocale();
      instances.delete(rootEl);
      rootEl.innerHTML = '';
    },
  };
  instances.set(rootEl, api);
  return api;
}

const instances = new WeakMap();

/**
 * 錯誤路徑 → 最接近的欄位元素（先精確比對，再找最長前綴）。
 * @param {HTMLElement} root
 * @param {string} path
 * @returns {HTMLElement|null}
 */
export function locateField(root, path) {
  if (!root || typeof root.querySelectorAll !== 'function') return null;
  const full = String(path || '');
  if (!full) return null;
  const nodes = Array.from(root.querySelectorAll('[data-demo-path]'));
  const exact = nodes.find((n) => n.dataset.demoPath === full);
  if (exact) return exact;
  const target = fieldPathFor(full);
  const byField = nodes.find((n) => n.dataset.demoPath === target);
  if (byField) return byField;
  let best = null;
  let bestLen = -1;
  for (const node of nodes) {
    const p = node.dataset.demoPath || '';
    if (!p) continue;
    if ((full === p || full.startsWith(`${p}.`) || full.startsWith(`${p}[`)) && p.length > bestLen) {
      best = node;
      bestLen = p.length;
    }
  }
  return best;
}

/* =========================================================================
 * 4. 分頁（掛在 #enc-cues 的面板切換）
 * ========================================================================= */

/**
 * 在既有「指令清單」面板上掛出「演示」分頁。
 *
 * 只在執行期建立 DOM（不動 encounter.html）：
 *   - `.panel-head` 內插入 `.panel-tabs`
 *   - `#enc-cues` 內新增一個 `.panel-body` 當 demo 的容器
 *   - 切到「演示」時隱藏 `#enc-cues-body`，反之亦然
 *
 * @param {{panelEl:HTMLElement, ctx:object, cueMeta?:{path?:string}}} options
 */
export function mountDemoTab({ panelEl, ctx = {}, cueMeta = null } = {}) {
  if (!panelEl || typeof document === 'undefined') {
    return { activate() {}, destroy() {}, get tab() { return null; } };
  }
  const head = panelEl.querySelector('.panel-head');
  const cuesBody = panelEl.querySelector('#enc-cues-body') || panelEl.querySelector('.panel-body');
  if (!head || !cuesBody) return { activate() {}, destroy() {}, get tab() { return null; } };

  const store = ctx.store || null;
  const doc = () => (store && store.doc ? store.doc : null);

  // 分頁列
  const tabs = el('div', { class: 'panel-tabs encdemo-tabs' });
  const cueTab = el('button', { type: 'button', class: 'panel-tab is-active', text: T('tabCues') });
  const demoTab = el('button', { type: 'button', class: 'panel-tab', text: T('tab') });
  tabs.append(cueTab, demoTab);

  const title = head.querySelector('.panel-title');
  if (title) head.insertBefore(tabs, title.nextSibling);
  else head.insertBefore(tabs, head.firstChild);

  // demo 容器
  const demoBody = el('div', { class: 'panel-body encdemo-body', id: 'enc-demo-body' });
  demoBody.hidden = true;
  panelEl.appendChild(demoBody);

  const api = mount(demoBody, ctx);
  const cuePathEl = document.getElementById('enc-cue-path');
  const cuePathSaved = cuePathEl ? cuePathEl.textContent : '';

  let current = 'cues';
  const paint = () => {
    const isDemo = current === 'demo';
    cueTab.classList.toggle('is-active', !isDemo);
    demoTab.classList.toggle('is-active', isDemo);
    cuesBody.hidden = isDemo;
    demoBody.hidden = !isDemo;
    if (cuePathEl) {
      if (isDemo) {
        const s = api.getSummary ? api.getSummary() : { cards: 0, choices: 0 };
        cuePathEl.textContent = `demo · ${s.cards} 卡 · ${s.choices} 選擇`;
      } else {
        cuePathEl.textContent = cuePathSaved;
      }
    }
    if (isDemo) api.refresh();
  };

  const activate = (which) => {
    current = which === 'demo' ? 'demo' : 'cues';
    paint();
    return current;
  };
  cueTab.addEventListener('click', () => activate('cues'));
  demoTab.addEventListener('click', () => activate('demo'));

  const unsub =
    store && typeof store.subscribe === 'function'
      ? store.subscribe(() => {
          if (current === 'demo' && cuePathEl) {
            const s = api.getSummary ? api.getSummary() : null;
            if (s) cuePathEl.textContent = `demo · ${s.cards} 卡 · ${s.choices} 選擇`;
          }
        })
      : null;

  const offLocale =
    typeof onLocaleChange === 'function'
      ? onLocaleChange(() => {
          cueTab.textContent = T('tabCues');
          demoTab.textContent = T('tab');
          paint();
        })
      : null;

  paint();

  const result = {
    get tab() {
      return current;
    },
    activate,
    showDemo: () => activate('demo'),
    showCues: () => activate('cues'),
    get body() {
      return demoBody;
    },
    api,
    destroy() {
      if (unsub) unsub();
      if (offLocale) offLocale();
      if (api && typeof api.destroy === 'function') api.destroy();
      tabs.remove();
      demoBody.remove();
      if (cuePathEl) cuePathEl.textContent = cuePathSaved;
      if (cueMeta && cueMeta.path && cuePathEl) cuePathEl.textContent = cueMeta.path;
    },
  };
  return result;
}

export default mount;
