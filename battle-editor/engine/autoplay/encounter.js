/**
 * engine/autoplay/encounter.js — 遭遇自動演示（SPEC-AUTOPLAY §2.2 / §3）
 *
 * 職責：把遭遇 demo 腳本轉成每幀輸入 `{ press, hold }`，交給 `encounter.step(n, input)`。
 * **只透過輸入驅動**（§1.1）：選單游標移動、文字確認、FIGHT 打擊、躲避方向全是「真的按鍵」，
 * 不直接改引擎狀態，所以畫面看起來就像有人在玩，且決定性（同 demo + 同 seed → 同結果）。
 *
 * 對外 API（SPEC-AUTOPLAY §3）：
 *   const pilot = createEncounterPilot({ demo, menuDelay, dodgePilotFor });
 *   pilot.input(state, frame)  → { press: string[], hold: { left, right, up, down, slow } }
 *   pilot.reset()
 *   pilot.warnings             → string[]（找不到選項 / 卡住脫困等，永不 throw）
 *   pilot.describe()           → { mode, dodge, turn, step }
 *
 * 另外接受（可選，不影響既有呼叫）：
 *   options.encounter / options.doc  已載入（或原始）遭遇 JSON：用來把 demo 裡的
 *                                    id / en 名 / zh 名解析成選單項目，解析不到才退回比對 label。
 *   options.fps                      文字 delay 換算（預設 30，遭遇層固定 30）。
 *   options.stallSeconds             同一狀態多久沒進展就脫困（預設 6 秒）。
 *
 * 設計約束：
 *   - 瀏覽器與 Node 都能載入（零 import、不用 DOM / Node API）。
 *   - `input()` 不 throw：任何資料缺漏都降級成「不按」並記 warning。
 *   - 躲避策略由外部注入的 dodgePilotFor 提供。
 */

import { canonicalInput } from './soul.js';

/** SPEC-AUTOPLAY §2.2 的躲避模式（none = 不閃，站著） */
export const DODGE_MODES = ['path', 'inputs', 'bot', 'none'];

/** FIGHT 打擊時機（§2.2 允許 perfect / good / miss 或 0..1 數值；ok = 普通命中） */
export const FIGHT_MODES = ['perfect', 'good', 'ok', 'miss'];

/** 隊員指令（SPEC-P2 §1） */
export const PARTY_COMMANDS = ['fight', 'act', 'magic', 'item', 'spare', 'defend'];

/** 與 engine/encounter/fight.js 相同的判定門檻（像素） */
const HIT_PERFECT = 10;
const HIT_GOOD = 26;
const HIT_OK = 62;

/** 與 engine/encounter/menu.js 相同的每頁項目數（左右鍵跨頁） */
const MENU_PAGE_SIZE = 5;

/* -------------------------------------------------------------- 小工具 */

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 多語文字：字串原樣；{zh,en} 依語言，缺語言時退回任何一個 */
function textOf(value, lang = 'zh') {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') {
    const v = value[lang];
    if (typeof v === 'string' && v) return v;
    if (typeof value.zh === 'string' && value.zh) return value.zh;
    if (typeof value.en === 'string' && value.en) return value.en;
    return '';
  }
  return String(value);
}

/** 字串 / {zh,en} → 全部可能的文字（給名稱比對用） */
function textsOf(value) {
  if (value === null || value === undefined) return [];
  if (typeof value === 'object') {
    const out = [];
    for (const key of ['zh', 'en']) {
      if (typeof value[key] === 'string' && value[key]) out.push(value[key]);
    }
    if (typeof value.name === 'string') out.push(value.name);
    if (typeof value.id === 'string') out.push(value.id);
    return out;
  }
  return [String(value)];
}

function norm(s) {
  return String(s === null || s === undefined ? '' : s)
    .trim()
    .toLowerCase();
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 圓環上從 from 走到 to 的單步方向（keys = [後退鍵, 前進鍵]） */
function stepDir(from, to, n, keys) {
  if (!(n > 1) || from === to) return null;
  const forward = ((to - from) % n + n) % n;
  const backward = n - forward;
  return forward <= backward ? keys[1] : keys[0];
}

/** 空輸入（避免每幀配置新物件時共享；呼叫端只讀） */
const EMPTY_HOLD = Object.freeze({});

function emptyInput() {
  return { press: [], hold: EMPTY_HOLD };
}

function inputOf(press, hold) {
  return { press: press || [], hold: hold || EMPTY_HOLD };
}

/* ------------------------------------------------- 與 fight.js 一致的判定 */

/**
 * 這一幀是否該按 confirm。
 * @param {number} dist |x - targetX|
 * @param {string|number} mode demo 的 fight 設定
 */
function shouldHitFight(dist, mode) {
  const d = Math.abs(num(dist, 0));
  if (typeof mode === 'number') {
    if (!Number.isFinite(mode)) return d <= HIT_GOOD;
    if (mode >= 1) return false; // 1 = 最邊緣（判定 miss）
    const allow = Math.max(4, clamp(mode, 0, 1) * 100);
    return d <= allow;
  }
  switch (mode) {
    case 'miss':
      return false;
    case 'perfect':
      // 標記每幀 6.5px，瞄準 perfect 窗（<=10）的內側，避免剛好跳過
      return d <= HIT_PERFECT - 1;
    case 'good':
      // 刻意不落在 perfect 窗內
      return d > HIT_PERFECT && d <= HIT_GOOD;
    case 'ok':
      return d > HIT_GOOD && d <= HIT_OK;
    case 'good-or-ok':
      return d <= HIT_OK;
    default:
      return d <= HIT_GOOD;
  }
}

/* =================================================================== */
/* 驗證過 / 原始遭遇的查表                                              */
/* =================================================================== */

function docParty(doc) {
  return Array.isArray(doc && doc.party) ? doc.party : [];
}

function docEnemies(doc) {
  return Array.isArray(doc && doc.enemies) ? doc.enemies : [];
}

function docItems(doc) {
  return Array.isArray(doc && doc.items) ? doc.items : [];
}

function docTurns(doc) {
  return Array.isArray(doc && doc.turns) ? doc.turns : [];
}

/** 某隊員在遭遇檔裡的定義（找不到回 null） */
function docMember(doc, memberId) {
  if (memberId === null || memberId === undefined) return null;
  for (const p of docParty(doc)) {
    if (p && p.id === memberId) return p;
  }
  return null;
}

/** 某隊員的法術表（遭遇檔；沒有回空陣列） */
function docSpells(doc, memberId) {
  const p = docMember(doc, memberId);
  return p && Array.isArray(p.spells) ? p.spells : [];
}

/**
 * 值（字串或 {zh,en}）是否等於 ref（id / 名稱，大小寫不敏感）。
 *
 * 先做精確比對、全部落空才做「包含」比對：否則 `act1` 會提早命中 `act11`
 * （清單第 12 項會被誤判成第 2 項）。
 */
function valueMatches(values, ref) {
  const needles = textsOf(ref).map(norm).filter(Boolean);
  if (needles.length === 0) return false;
  const normalized = [];
  for (const v of values) {
    const nv = norm(v);
    if (nv) normalized.push(nv);
  }
  for (const nv of normalized) {
    if (needles.includes(nv)) return true;
  }
  for (const nv of normalized) {
    for (const needle of needles) {
      if (nv.includes(needle) || needle.includes(nv)) return true;
    }
  }
  return false;
}

/** 用 id / en 名 / zh 名找敵人定義 */
function findDocEnemy(doc, ref) {
  if (ref === null || ref === undefined || ref === '') return null;
  const list = docEnemies(doc);
  // 先精確比 id
  if (typeof ref === 'string') {
    for (const e of list) if (e && e.id === ref) return e;
  }
  for (const e of list) {
    if (!e) continue;
    const values = [e.id, ...textsOf(e.name)];
    if (valueMatches(values, ref)) return e;
  }
  return null;
}

/** 在陣列裡用 id / 名稱找項目 */
function findDocItemByRef(list, ref) {
  if (!Array.isArray(list) || ref === null || ref === undefined || ref === '') return null;
  if (typeof ref === 'string') {
    for (const it of list) if (it && it.id === ref) return it;
  }
  for (const it of list) {
    if (!it) continue;
    const values = [it.id, ...textsOf(it.name)];
    if (valueMatches(values, ref)) return it;
  }
  return null;
}

/** 在清單（選單項目快照）裡用 needles 比對 label */
function matchItemLabel(items, needles) {
  if (!Array.isArray(items) || needles.length === 0) return -1;
  const use = needles.map(norm).filter(Boolean);
  if (use.length === 0) return -1;
  // 先精確比對（避免 "Act 11" 被 "Act 1" 的模糊比對搶先）
  for (let i = 0; i < items.length; i += 1) {
    const label = norm(items[i] && items[i].label);
    if (label && use.includes(label)) return i;
  }
  for (let i = 0; i < items.length; i += 1) {
    const label = norm(items[i] && items[i].label);
    if (!label) continue;
    for (const needle of use) {
      if (label.includes(needle) || needle.includes(label)) return i;
    }
  }
  return -1;
}

/**
 * 在清單裡用 id / 名稱找索引：精確命中優先，全部落空才做「包含」比對。
 * （否則 `act1` 會先命中 `act11`，長清單的選項會指到錯的項目。）
 *
 * @param {any[]} list 來源陣列（ACT / 法術 / 道具定義）
 * @param {(entry:any)=>any[]} refsOf 取該項目的 id / 名稱字串
 * @param {any} ref demo 指定的 ref
 */
function findIndexByRef(list, refsOf, ref) {
  const needles = needlesOf(ref);
  if (!Array.isArray(list) || needles.length === 0) return -1;
  const asTexts = (entry) => {
    const vals = [];
    for (const v of refsOf(entry) || []) {
      for (const t of textsOf(v)) {
        const n = norm(t);
        if (n) vals.push(n);
      }
    }
    return vals;
  };
  for (let i = 0; i < list.length; i += 1) {
    const vals = asTexts(list[i]);
    for (const v of vals) if (needles.includes(v)) return i;
  }
  for (let i = 0; i < list.length; i += 1) {
    const vals = asTexts(list[i]);
    for (const v of vals) {
      for (const needle of needles) {
        if (v.includes(needle) || needle.includes(v)) return i;
      }
    }
  }
  return -1;
}

function needlesOf(ref) {
  return textsOf(ref).map(norm).filter(Boolean);
}

/* =================================================================== */
/* createEncounterPilot                                                */
/* =================================================================== */

/**
 * 建立遭遇自動駕駛（SPEC-AUTOPLAY §3）。
 *
 * @param {object} [options]
 * @param {object} [options.demo]           遭遇檔的 `demo`（省略 = 全部使用 default / AI 規則）
 * @param {number} [options.menuDelay]      選單每次按鍵間隔幀數（0 = 每幀；預設讀 demo.menuDelay，再預設 6）
 * @param {(turn:number, attackDoc:object|string|null, dodge?:string|null)=>object|null} [options.dodgePilotFor]
 *        取得躲避駕駛（AP1 的 createSoulPilot / bot）。回傳物件可提供 decide(state) 或 input(state, frame)。
 * @param {object} [options.encounter]      遭遇 JSON（把 demo 的 id / 名稱解析成選單項目用）
 * @param {object} [options.doc]            options.encounter 的別名
 * @param {(name:string)=>object|null} [options.resolveAttackDoc]  把回合的 attack 參照解析成攻擊檔（同步）
 * @param {number} [options.fps]            文字 delay 換算（預設 30）
 * @param {number} [options.stallSeconds]   同一狀態多久沒進展就按鍵脫困（預設 6 秒）
 */
export function createEncounterPilot(options = {}) {
  const opts = isObj(options) ? options : {};
  const demo = isObj(opts.demo) ? opts.demo : {};
  const demoText = isObj(demo.text) ? demo.text : {};
  const doc = isObj(opts.encounter) ? opts.encounter : isObj(opts.doc) ? opts.doc : null;
  const dodgePilotFor = typeof opts.dodgePilotFor === 'function' ? opts.dodgePilotFor : null;
  const resolveAttackDoc = typeof opts.resolveAttackDoc === 'function' ? opts.resolveAttackDoc : null;

  const fps = Math.max(1, Math.round(num(opts.fps, 30)));

  /* ------------------------------------------------------ 設定（§2.2） */

  const autoText = demoText.auto !== false;
  const textDelay = Math.max(0, num(demoText.delay, 0.5));
  const textDelayFrames = Math.max(0, Math.round(textDelay * fps));
  const menuDelay = Math.max(
    0,
    Math.round(
      Number.isFinite(opts.menuDelay)
        ? num(opts.menuDelay, 6)
        : demo.menuDelay === undefined
          ? 6
          : num(demo.menuDelay, 6),
    ),
  );
  const stallSeconds = Math.max(1, num(opts.stallSeconds, 6));
  const stallLimit = Math.max(1, Math.round(stallSeconds * fps));

  /* ---------------------------------------------------------- 狀態 */

  /** @type {string[]} 對外可見的警告（永不 throw） */
  const warnings = [];
  const warnedKeys = new Set();

  /** 已失敗的 demo 目標（key），失敗後改用 default（§2.2 最後一條） */
  const failedGoals = new Set();

  /** 目前選單的隊員索引 / 已按 confirm 打開的指令（用來判斷清單階段） */
  let menuMember = -1;
  let openedCommand = null;

  /** 選單按鍵節奏 */
  let lastMenuAction = -Infinity;

  /** 文字自動前進 */
  let lastTextKey = null;
  let textReadyFrame = -1;
  let lastTextPress = -Infinity;

  /** 卡住脫困 */
  let stallKey = null;
  let stallCount = 0;
  let stallLevel = 0;
  let forcedDefend = 0;

  /** 躲避 */
  let inBattle = false;
  let dodgePilot = null;
  let dodgeKey = null;
  let dodgeFresh = false;
  let currentAttack = null;

  /** describe() 用 */
  let lastTurn = 1;
  let lastStep = 'idle';
  let internalFrame = 0;

  /* ---------------------------------------------------------- 警告 */

  /** 記一筆 warning（同一則只記一次） */
  function warn(message) {
    const text = String(message || '');
    if (!text || warnedKeys.has(text)) return;
    warnedKeys.add(text);
    warnings.push(text);
  }

  /* ------------------------------------------------------ 文字 / 工具 */

  function turnNoOf(state) {
    return Math.max(1, Math.round(num(state?.turnNumber, num(state?.turn, 0) + 1)));
  }

  function livingEnemies(state) {
    const list = state && Array.isArray(state.enemies) ? state.enemies : [];
    return list.filter((e) => e && !e.removed && num(e.hp, 0) > 0);
  }

  function partyAt(state, index) {
    const list = state && Array.isArray(state.party) ? state.party : [];
    return list[index] || null;
  }

  /** 目前回合在 demo.turns 的條目 */
  function turnEntryFor(turnNo) {
    const turns = Array.isArray(demo.turns) ? demo.turns : [];
    for (let i = 0; i < turns.length; i += 1) {
      const t = turns[i];
      if (!isObj(t)) continue;
      const n = Number(t.turn);
      if (Number.isFinite(n) && Math.round(n) === turnNo) return t;
    }
    return null;
  }

  /** choice 是否指向這位隊員（member = party id；也接受索引） */
  function choiceMatchesMember(choice, memberId, memberIndex) {
    if (!isObj(choice)) return false;
    const m = choice.member;
    if (m === undefined || m === null) return false;
    if (typeof m === 'number') return Math.round(m) === memberIndex;
    if (memberId !== null && memberId !== undefined && String(m) === String(memberId)) return true;
    return String(m) === String(memberIndex);
  }

  /** 這回合這位隊員的 demo 選擇（沒有回 null） */
  function rawChoiceFor(state, memberIndex) {
    const turnNo = turnNoOf(state);
    const entry = turnEntryFor(turnNo);
    const member = partyAt(state, memberIndex);
    const memberId = member ? member.id : null;
    const choices = entry && Array.isArray(entry.choices) ? entry.choices : [];
    for (const c of choices) {
      if (choiceMatchesMember(c, memberId, memberIndex)) return { entry: entry || null, choice: c, member, turnNo };
    }
    return { entry: entry || null, choice: null, member, turnNo };
  }

  function goalKeyOf(turnNo, memberIndex, choice) {
    return [
      turnNo,
      memberIndex,
      choice && choice.command !== undefined ? String(choice.command) : '',
      choice && choice.option !== undefined ? JSON.stringify(choice.option) : '',
      choice && choice.target !== undefined ? JSON.stringify(choice.target) : '',
    ].join('|');
  }

  function fallbackFight() {
    const d = isObj(demo.default) ? demo.default : {};
    const v = d.fight;
    if (typeof v === 'number') return v;
    return typeof v === 'string' && v ? v : 'good';
  }

  function fallbackDodge() {
    const d = isObj(demo.default) ? demo.default : {};
    return typeof d.dodge === 'string' ? d.dodge : null;
  }

  /* -------------------------------------------------------- 行動計畫 */

  /** 這一回合的躲避方式（demo.turns[i].dodge，再來 default.dodge） */
  function dodgeModeFor(turnNo) {
    const entry = turnEntryFor(turnNo);
    if (entry && typeof entry.dodge === 'string') return entry.dodge;
    return fallbackDodge();
  }

  function defaultPlan(state, memberIndex) {
    const member = partyAt(state, memberIndex);
    const memberId = member ? member.id : null;
    const d = isObj(demo.default) ? demo.default : {};
    let command = 'fight';
    let option = null;
    let target = null;

    if (typeof d.choices === 'string' && PARTY_COMMANDS.includes(d.choices)) {
      command = d.choices;
    } else if (Array.isArray(d.choices)) {
      const c = d.choices.find((x) => choiceMatchesMember(x, memberId, memberIndex));
      if (c && typeof c.command === 'string' && PARTY_COMMANDS.includes(c.command)) {
        command = c.command;
        option = c.option === undefined ? null : c.option;
        target = c.target === undefined ? null : c.target;
      }
    }

    const living = livingEnemies(state);
    if (command === 'fight' || command === 'spare' || command === 'act') {
      if (living.length === 0) command = 'defend';
      else if (target === null || target === undefined) target = living[0].id;
    }
    if (command === 'magic' && docSpells(doc, memberId).length === 0) command = 'defend';
    if (command === 'item' && availableItems().length === 0) command = 'defend';

    return {
      command: command,
      target: target === undefined ? null : target,
      option: option === undefined ? null : option,
      fight: d.fight === undefined ? 'good' : d.fight,
      dodge: typeof d.dodge === 'string' ? d.dodge : null,
      source: 'default',
      key: null,
    };
  }

  function defPlan() {
    return { command: 'defend', target: null, option: null, fight: 'good', dodge: null, source: 'forced', key: null };
  }

  /** 這位隊員這一幀該做什麼 */
  function planFor(state, memberIndex) {
    if (forcedDefend > 0) return defPlan();
    const found = rawChoiceFor(state, memberIndex);
    const choice = found.choice;
    if (choice) {
      const key = goalKeyOf(found.turnNo, memberIndex, choice);
      if (!failedGoals.has(key)) {
        const command = typeof choice.command === 'string' ? choice.command : null;
        return {
          command: PARTY_COMMANDS.includes(command) ? command : 'fight',
          target: choice.target === undefined ? null : choice.target,
          option: choice.option === undefined ? null : choice.option,
          fight:
            choice.fight !== undefined
              ? choice.fight
              : found.entry && found.entry.fight !== undefined
                ? found.entry.fight
                : fallbackFight(),
          dodge:
            choice.dodge !== undefined
              ? choice.dodge
              : found.entry && found.entry.dodge !== undefined
                ? found.entry.dodge
                : fallbackDodge(),
          source: 'demo',
          key: key,
        };
      }
    }
    return defaultPlan(state, memberIndex);
  }

  /** 某個 demo 指定的目標失敗 → 記 warning 並改用 default */
  function markFailed(plan, message) {
    if (plan && plan.key) failedGoals.add(plan.key);
    warn(message);
  }

  /* ------------------------------------------------- 選單：清單查表 */

  /** 遭遇檔裡有存貨的道具（沒有 doc 時回傳空陣列） */
  function availableItems() {
    return docItems(doc).filter((it) => it && num(it.count, 0) > 0);
  }

  /** 這一幀的清單階段；回傳 null = 與已打開的指令不符（要退回） */
  function stageForCommand(command, kind) {
    switch (command) {
      case 'fight':
      case 'spare':
        return kind === 'enemy' ? 'target' : null;
      case 'act':
        if (kind === 'enemy') return 'target';
        return kind === 'act' ? 'option' : null;
      case 'magic':
        if (kind === 'magic') return 'option';
        if (kind === 'enemy') return 'target';
        return kind === 'party' ? 'target' : null;
      case 'item':
        if (kind === 'item') return 'option';
        if (kind === 'enemy') return 'target';
        return kind === 'party' ? 'target' : null;
      default:
        return null; // defend 不該有清單
    }
  }

  /** 在敵人清單裡找目標索引 */
  function findEnemyTarget(state, plan, items) {
    const living = livingEnemies(state);
    const ref = plan.target;
    let index = -1;

    if (ref !== null && ref !== undefined) {
      // 先用 id / 名稱對 state.enemies（與選單清單同順序）
      const needles = needlesOf(ref);
      for (let i = 0; i < living.length; i += 1) {
        if (String(living[i].id) === String(ref)) {
          index = i;
          break;
        }
      }
      if (index < 0) {
        index = living.findIndex((e) => valueMatches([e.id, e.name], ref));
      }
      if (index < 0) {
        // 遭遇檔的 id / 名稱 → state 敵人 id
        const docEnemy = findDocEnemy(doc, ref);
        if (docEnemy) index = living.findIndex((e) => String(e.id) === String(docEnemy.id));
      }
      if (index < 0) index = matchItemLabel(items, needles);
    } else {
      index = 0;
    }
    return index;
  }

  /** 在 ACT 清單裡找選項索引 */
  function findActOption(state, plan, items) {
    const option = plan.option;
    if (option === null || option === undefined) {
      return items.length > 0 ? 0 : -1; // 沒指定 → 第一個 ACT
    }
    const needles = needlesOf(option);
    // 1) 遭遇檔：目標敵人的 acts（選單清單與 acts 同順序）
    const enemy = findDocEnemy(doc, plan.target);
    const acts = enemy && Array.isArray(enemy.acts) ? enemy.acts : null;
    if (acts) {
      const i = findIndexByRef(acts, (a) => [a && a.id, a && a.name], option);
      if (i >= 0) return i;
    }
    // 2) 標籤比對
    const byLabel = matchItemLabel(items, needles);
    if (byLabel >= 0) return byLabel;
    // 3) 沒指定敵人時，跨全部敵人找擁有這個 ACT 的敵人
    if (plan.target === null || plan.target === undefined) {
      for (const e of docEnemies(doc)) {
        const list = e && Array.isArray(e.acts) ? e.acts : [];
        const ai = findIndexByRef(list, (a) => [a && a.id, a && a.name], option);
        if (ai < 0) continue;
        const target = findEnemyTarget(state, { target: e.id, command: 'act' }, items);
        if (target >= 0) return -2 - target; // 特殊回傳：先選敵人
      }
    }
    return -1;
  }

  /** 在法術清單裡找索引 */
  function findSpellOption(state, plan, memberIndex, items) {
    const member = partyAt(state, memberIndex);
    const memberId = member ? member.id : null;
    const spells = docSpells(doc, memberId);
    const option = plan.option;
    if (spells.length > 0) {
      if (option === null || option === undefined) {
        const i = spells.findIndex((s) => s && items && items[spells.indexOf(s)] && items[spells.indexOf(s)].enabled !== false);
        return i >= 0 ? i : 0;
      }
      const i = findIndexByRef(spells, (s) => [s && s.id, s && s.name], option);
      if (i >= 0) return i;
    }
    const byLabel = matchItemLabel(items, needlesOf(option));
    if (byLabel >= 0) return byLabel;
    return option === null || option === undefined ? 0 : -1;
  }

  /** 在道具清單裡找索引 */
  function findItemOption(plan, items) {
    const list = availableItems();
    const option = plan.option;
    if (list.length > 0) {
      if (option === null || option === undefined) return 0;
      const i = findIndexByRef(list, (it) => [it && it.id, it && it.name], option);
      if (i >= 0) return i;
    }
    const byLabel = matchItemLabel(items, needlesOf(option));
    if (byLabel >= 0) return byLabel;
    return option === null || option === undefined ? 0 : -1;
  }

  /** 在隊員清單裡找目標索引（item / magic 的己方目標） */
  function findPartyTarget(state, plan, items) {
    const ref = plan.target;
    if (ref === null || ref === undefined) return 0;
    const party = state && Array.isArray(state.party) ? state.party : [];
    let index = party.findIndex((p) => p && String(p.id) === String(ref));
    if (index < 0) index = party.findIndex((p) => p && valueMatches([p.id, p.name], ref));
    if (index < 0) index = matchItemLabel(items, needlesOf(ref));
    return index;
  }

  /** 目前清單的目標索引（-1 = 找不到；-2-n = 先選敵人 n 再進來） */
  function findListIndex(state, plan, memberIndex, list) {
    const kind = list.kind;
    const items = Array.isArray(list.items) ? list.items : [];
    switch (kind) {
      case 'enemy':
        return findEnemyTarget(state, plan, items);
      case 'act':
        return findActOption(state, plan, items);
      case 'magic':
        return findSpellOption(state, plan, memberIndex, items);
      case 'item':
        return findItemOption(plan, items);
      case 'party':
        return findPartyTarget(state, plan, items);
      default:
        return -1;
    }
  }

  /* ------------------------------------------------------ 選單：步進 */

  function menuReady(frame) {
    return menuDelay === 0 || frame - lastMenuAction >= menuDelay;
  }

  function noteMenuAction(frame) {
    lastMenuAction = frame;
  }

  /** 按鈕列：移動到目標指令並按確定 */
  function buttonLayerStep(state, menu, plan, memberIndex, frame) {
    if (!menuReady(frame)) return emptyInput();
    const buttons = Array.isArray(menu.buttons) ? menu.buttons : [];
    const idxOf = (id) => buttons.findIndex((b) => b && b.id === id);
    const enabled = (id) => {
      const i = idxOf(id);
      return i >= 0 && buttons[i].enabled !== false;
    };

    let command = plan.command;
    if (!enabled(command)) {
      if (plan.source === 'demo') {
        markFailed(
          plan,
          `第 ${turnNoOf(state)} 回合 ${memberLabel(state, memberIndex)}：指令 "${command}" 不可用，改用 default`,
        );
        return emptyInput();
      }
      const chain = ['fight', 'act', 'magic', 'item', 'spare', 'defend'];
      command = chain.find(enabled) || null;
      if (!command) {
        // menu.js：沒有任何可用按鈕時，按確定 = 自動防禦
        noteMenuAction(frame);
        openedCommand = 'defend';
        return inputOf(['confirm']);
      }
    }

    const idx = idxOf(command);
    const cursor = Math.max(0, Math.round(num(menu.cursor, 0)));
    if (cursor === idx) {
      noteMenuAction(frame);
      openedCommand = command;
      return inputOf(['confirm']);
    }
    const dir = stepDir(cursor, idx, buttons.length, ['left', 'right']);
    if (!dir) return emptyInput();
    noteMenuAction(frame);
    return inputOf([dir]);
  }

  /** 清單層：依 list.kind 選目標 / 選項 */
  function listLayerStep(state, menu, plan, memberIndex, frame) {
    if (!menuReady(frame)) return emptyInput();
    const list = menu.list;
    const items = Array.isArray(list.items) ? list.items : [];
    const kind = list.kind;

    if (!openedCommand) openedCommand = plan.command;

    // 計畫換了（例如失敗後改 default）→ 先退回按鈕列
    if (openedCommand !== plan.command) {
      noteMenuAction(frame);
      return inputOf(['cancel']);
    }

    if (!stageForCommand(openedCommand, kind)) {
      noteMenuAction(frame);
      return inputOf(['cancel']);
    }

    if (items.length === 0) {
      noteMenuAction(frame);
      return inputOf(['cancel']);
    }

    let target = findListIndex(state, plan, memberIndex, list);
    if (target <= -2) {
      // 沒指定敵人但 ACT 在別的敵人身上：先選那個敵人（退回後由 target 解析）
      const enemyIndex = -2 - target;
      return moveListCursor(menu, items, enemyIndex, frame);
    }
    if (target < 0) {
      const what = kind === 'act' ? `ACT "${describeRef(plan.option)}"` : `"${describeRef(plan.option || plan.target)}"`;
      if (plan.source === 'demo') {
        markFailed(
          plan,
          `第 ${turnNoOf(state)} 回合 ${memberLabel(state, memberIndex)}：清單裡找不到 ${what}（${kind}），改用 default`,
        );
        return emptyInput();
      }
      warn(`第 ${turnNoOf(state)} 回合 ${memberLabel(state, memberIndex)}：找不到 ${what}，改用防禦`);
      forcedDefend += 1;
      noteMenuAction(frame);
      return inputOf(['cancel']);
    }

    const item = items[target];
    if (item && item.enabled === false) {
      const what = describeRef(plan.option || plan.target);
      if (plan.source === 'demo') {
        markFailed(
          plan,
          `第 ${turnNoOf(state)} 回合 ${memberLabel(state, memberIndex)}：選項 "${what}" 目前不可用（${kind}），改用 default`,
        );
        return emptyInput();
      }
      warn(`第 ${turnNoOf(state)} 回合 ${memberLabel(state, memberIndex)}：選項 "${what}" 不可用，改用防禦`);
      forcedDefend += 1;
      noteMenuAction(frame);
      return inputOf(['cancel']);
    }
    return moveListCursor(menu, items, target, frame);
  }

  function moveListCursor(menu, items, target, frame) {
    const cursor = Math.max(0, Math.round(num(menu.list.cursor, 0)));
    if (cursor === target) {
      noteMenuAction(frame);
      return inputOf(['confirm']);
    }
    const n = items.length;
    // 清單可環繞（menu.js：up/down 到底會繞回另一端），但左右跨頁「不會」繞：
    // list.cursor = clamp(cursor ± PAGE_SIZE, 0, n-1)。所以跨頁只在不會越過目標時用，
    // 否則長清單的演示會拖很久（例如 12 項選最後一項）。
    const forward = ((target - cursor) % n + n) % n;
    const backward = n - forward;
    const useForward = forward <= backward;
    if (useForward) {
      if (forward >= MENU_PAGE_SIZE && cursor + MENU_PAGE_SIZE <= target) {
        noteMenuAction(frame);
        return inputOf(['right']);
      }
      noteMenuAction(frame);
      return inputOf(['down']);
    }
    if (backward >= MENU_PAGE_SIZE && cursor - MENU_PAGE_SIZE >= target) {
      noteMenuAction(frame);
      return inputOf(['left']);
    }
    noteMenuAction(frame);
    return inputOf(['up']);
  }

  function memberLabel(state, memberIndex) {
    const p = partyAt(state, memberIndex);
    return p && p.id ? String(p.id) : `#${memberIndex}`;
  }

  function describeRef(ref) {
    if (ref === null || ref === undefined) return '(未指定)';
    if (typeof ref === 'object') {
      const t = textOf(ref, 'zh') || textOf(ref, 'en');
      return t || JSON.stringify(ref);
    }
    return String(ref);
  }

  /** phase === 'menu' 時的輸入 */
  function menuStep(state, frame) {
    const menu = state.menu;
    const memberIndex = Math.max(0, Math.round(num(menu.member, 0)));

    // 隊員換人 → 清掉「已打開的指令」
    if (memberIndex !== menuMember) {
      menuMember = memberIndex;
      openedCommand = null;
    }

    const plan = planFor(state, memberIndex);
    if (!menu.list) {
      openedCommand = null;
      return buttonLayerStep(state, menu, plan, memberIndex, frame);
    }
    return listLayerStep(state, menu, plan, memberIndex, frame);
  }

  /* -------------------------------------------------------- 文字前進 */

  /** 文字打完後 delay 秒按 confirm（打字中不按，避免跳字） */
  function textStep(state, frame) {
    if (!autoText) return emptyInput();
    const textbox = state.textbox && state.textbox.done !== undefined ? state.textbox : null;
    const bubbles = Array.isArray(state.bubbles) ? state.bubbles.filter((b) => b && b.done !== undefined) : [];
    if (!textbox && bubbles.length === 0) {
      lastTextKey = null;
      textReadyFrame = -1;
      return emptyInput();
    }

    const entries = [];
    if (textbox) entries.push(textbox);
    for (const b of bubbles) entries.push(b);

    const key = entries
      .map((e) => `${e.actor || e.speaker || ''}:${num(e.totalChars, 0)}:${e.done === true ? 1 : 0}`)
      .join('|');
    const ready = entries.every((e) => e.done === true);

    if (key !== lastTextKey) {
      lastTextKey = key;
      textReadyFrame = ready ? frame : -1;
    }
    if (!ready) {
      // 打字中：不要按（按了會直接跳到全文，觀眾看不到打字）
      textReadyFrame = -1;
      return emptyInput();
    }
    if (textReadyFrame < 0) textReadyFrame = frame;
    const elapsed = frame - textReadyFrame;
    const sincePress = frame - lastTextPress;
    if (elapsed < textDelayFrames) return emptyInput();
    if (sincePress < Math.max(2, textDelayFrames)) return emptyInput();

    lastTextPress = frame;
    return inputOf(['confirm']);
  }

  /* -------------------------------------------------- FIGHT 打擊條 */

  /** 每位出手隊員各自依 demo 的 fight 時機按 confirm */
  function fightStep(state, frame) {
    const bare = isObj(state) && isObj(state.fight) && Array.isArray(state.fight.bars) ? state.fight.bars : null;
    if (!bare || bare.length === 0) return emptyInput();

    const active = bare.findIndex((b) => b && b.result === null);
    if (active < 0) return emptyInput();
    const bar = bare[active];
    const memberIndex = Math.max(0, Math.round(num(bar.member, active)));

    let mode = 'good';
    const found = rawChoiceFor(state, memberIndex);
    if (found.choice && found.choice.fight !== undefined) mode = found.choice.fight;
    else if (found.entry && found.entry.fight !== undefined) mode = found.entry.fight;
    else if (isObj(demo.default) && demo.default.fight !== undefined) mode = demo.default.fight;

    const dist = Math.abs(num(bar.x, 0) - num(bar.targetX, 0));
    if (!shouldHitFight(dist, mode)) return emptyInput();
    return inputOf(['confirm']);
  }

  /* ---------------------------------------------------------- 躲避 */

  /** 攻擊的名稱（給 UI / 記錄用；狀態裡的攻擊是正規化過的物件） */
  function attackLabel(attack) {
    if (!isObj(attack)) return typeof attack === 'string' && attack ? attack : null;
    const meta = isObj(attack.meta) ? attack.meta : null;
    const name = meta ? meta.name : attack.name;
    const text = textOf(name, 'zh') || textOf(name, 'en');
    if (text) return text;
    if (meta && typeof meta.id === 'string') return meta.id;
    if (typeof attack.id === 'string') return attack.id;
    return null;
  }

  /**
   * 這一回合實際在跑的攻擊檔（SPEC-AUTOPLAY §2.2：dodgePilotFor 收的是 attackDoc，
   * 需要讀它的 `demo`；所以傳物件，不是名字）。
   *
   * 優先序：state.battle 底下的正規化攻擊（含內嵌攻擊）→ 遭遇檔該回合的 attack 參照（可用
   * options.resolveAttackDoc 解析成檔案）→ state.attack 本身。
   */
  function attackDocFor(state) {
    const attack = state && state.attack;
    if (isObj(attack)) return attack;
    const refs = [];
    if (typeof attack === 'string' && attack) refs.push(attack);
    const turns = docTurns(doc);
    const turnDef = turns[state.turn];
    if (turnDef && typeof turnDef.attack === 'string' && turnDef.attack) refs.push(turnDef.attack);
    for (const ref of refs) {
      if (resolveAttackDoc) {
        let docResolved = null;
        try {
          docResolved = resolveAttackDoc(ref);
        } catch (_e) {
          docResolved = null;
        }
        if (isObj(docResolved)) return docResolved;
      }
      return ref;
    }
    return null;
  }

  /** 這一回合的攻擊參照名（遭遇檔寫的字串；沒有就用顯示名） */
  function attackRefFor(state) {
    if (typeof state.attack === 'string' && state.attack) return state.attack;
    const turns = docTurns(doc);
    const turnDef = turns[state.turn];
    if (turnDef && typeof turnDef.attack === 'string' && turnDef.attack) return turnDef.attack;
    return null;
  }

  /** 進入 / 離開彈幕回合時建立（或重置）躲避駕駛 */
  function syncDodge(state, turnNo) {
    if (!state.battle) {
      inBattle = false;
      return;
    }
    const attackDoc = attackDocFor(state);
    const label = attackLabel(attackDoc) || attackRefFor(state);
    const key = `${turnNo}|${label || ''}|${isObj(attackDoc) ? 'doc' : 'ref'}`;
    if (!inBattle || key !== dodgeKey) {
      inBattle = true;
      dodgeKey = key;
      dodgePilot = null;
      dodgeFresh = true;
      currentAttack = attackDoc;
      if (dodgePilotFor) {
        try {
          // SPEC §3：dodgePilotFor(turn, attackDoc)（第 3 個參數是本回合的 dodge 設定）
          dodgePilot = dodgePilotFor(turnNo, attackDoc, dodgeModeFor(turnNo)) || null;
        } catch (err) {
          dodgePilot = null;
          warn(`躲避駕駛建立失敗（回合 ${turnNo}）：${err && err.message ? err.message : String(err)}`);
        }
      }
    }
    if (dodgePilot && dodgeFresh && typeof dodgePilot.reset === 'function') {
      // 新回合第一次見到這個駕駛時重設，確保從乾淨狀態開始
      try {
        dodgePilot.reset();
      } catch (_e) {
        /* 重設失敗不影響 */
      }
      dodgeFresh = false;
    }
  }

  /** state.battle 存在時：轉交躲避駕駛 */
  function dodgeStep(state, frame) {
    syncDodge(state, turnNoOf(state));
    const pilot = dodgePilot;
    if (!pilot) return emptyInput();
    const payload = {
      ...(isObj(state.battle) ? state.battle : {}),
      // battle 快照自帶 attack（soul 速度等）時優先用它，不要被遭遇頂層的 state.attack 蓋掉
      attack: isObj(state.battle) && state.battle.attack ? state.battle.attack : (state.attack === undefined ? null : state.attack),
      party: Array.isArray(state.party) ? state.party : [],
      enemies: Array.isArray(state.enemies) ? state.enemies : [],
      frame: num(state.battle && state.battle.frame, frame),
    };
    // 路徑 / 錄製輸入的時間是相對攻擊開始 → 傳攻擊內的幀號，不是遭遇全域幀號
    const attackFrame = payload.frame;
    try {
      if (typeof pilot.decide === 'function') return canonicalInput(pilot.decide(payload));
      if (typeof pilot.input === 'function') return canonicalInput(pilot.input(payload, attackFrame));
      if (typeof pilot === 'function') return canonicalInput(pilot(payload, attackFrame));
    } catch (err) {
      warn(`躲避駕駛執行錯誤（回合 ${turnNoOf(state)}）：${err && err.message ? err.message : String(err)}`);
      return emptyInput();
    } finally {
      for (const message of pilot.warnings ?? []) warn(`第 ${turnNoOf(state)} 回合：${message}`);
    }
    return emptyInput();
  }

  /* ---------------------------------------------------- 卡住脫困 */

  function progressKey(state) {
    const menu = isObj(state.menu) ? state.menu : null;
    const menuKey = menu
      ? [
          num(menu.member, 0),
          num(menu.cursor, 0),
          isObj(menu.list)
            ? `${menu.list.kind}:${num(menu.list.cursor, 0)}:${num(menu.list.page, 0)}:${(menu.list.items || []).length}`
            : '-',
        ].join(':')
      : '-';
    const textbox = isObj(state.textbox)
      ? `t${num(state.textbox.visibleChars, 0)}/${num(state.textbox.totalChars, 0)}:${state.textbox.done === true ? 1 : 0}`
      : '-';
    const bubbles =
      Array.isArray(state.bubbles) && state.bubbles.length > 0
        ? state.bubbles
            .map((b) => `${b && b.actor}:${num(b && b.visibleChars, 0)}/${num(b && b.totalChars, 0)}:${b && b.done === true ? 1 : 0}`)
            .join(',')
        : '-';
    const fight =
      isObj(state.fight) && Array.isArray(state.fight.bars)
        ? state.fight.bars
            .map((b) => `${b && b.result}:${Math.round(num(b && b.x, 0))}:${Math.round(num(b && b.targetX, 0))}`)
            .join(',')
        : '-';
    return `${state.phase}|${state.turn}|${menuKey}|${textbox}|${bubbles}|${fight}|${state.result || ''}`;
  }

  /**
   * 同一狀態超過 stallSeconds 沒進展 → 按 confirm / cancel 脫困（永不卡死）。
   * 選單卡住時第二次起改為防禦，避免一直卡在同一層。
   *
   * 注意：即使正常的 step 有回傳（空）輸入也要更新計數，否則「一直在輸出空輸入」
   * 的狀態永遠不會被判定成卡住。
   */
  function stallStep(state, frame) {
    if (state.battle) {
      stallKey = null;
      stallCount = 0;
      return null;
    }
    // text.auto=false 是「等人按」：文字還在畫面上時不算卡住（尊重作者設定）
    if (!autoText && (state.textbox || (Array.isArray(state.bubbles) && state.bubbles.length > 0))) {
      stallKey = null;
      stallCount = 0;
      return null;
    }
    const key = progressKey(state);
    if (key !== stallKey) {
      stallKey = key;
      stallCount = 0;
      stallLevel = 0;
      return null;
    }
    stallCount += 1;
    if (stallCount < stallLimit) return null;
    stallCount = 0;
    stallLevel = Math.min(8, stallLevel + 1);
    const press = stallLevel % 2 === 1 ? 'cancel' : 'confirm';
    warn(
      `自動演示卡住（${state.phase}，第 ${turnNoOf(state)} 回合）：按 ${press} 脫困`,
    );
    if (stallLevel >= 2 && state.phase === 'menu') forcedDefend = Math.max(forcedDefend, 1);
    return inputOf([press]);
  }

  /* ------------------------------------------------------------ API */

  /**
   * 每幀取得輸入。
   * @param {object} state 引擎 getState()
   * @param {number} [frame] 幀序號（不給就用內部計數）
   * @returns {{press:string[], hold:object}}
   */
  function input(state, frame) {
    const st = isObj(state) ? state : {};
    const f = Number.isFinite(frame) ? frame : internalFrame;
    internalFrame = f + 1;

    const turnNo = turnNoOf(st);
    if (turnNo !== lastTurn) {
      lastTurn = turnNo;
      lastMenuAction = -Infinity;
      menuMember = -1;
      openedCommand = null;
      lastTextKey = null;
      textReadyFrame = -1;
      forcedDefend = 0;
      stallKey = null;
      stallCount = 0;
      stallLevel = 0;
    }

    let out = null;

    if (st.battle) {
      lastStep = 'dodge';
      out = dodgeStep(st, f);
    } else if (isObj(st.fight)) {
      lastStep = 'fight';
      inBattle = false;
      out = fightStep(st, f);
    } else if (st.phase === 'menu' && isObj(st.menu)) {
      lastStep = 'menu';
      inBattle = false;
      out = menuStep(st, f);
    } else {
      lastStep = 'text';
      inBattle = false;
      out = textStep(st, f);
    }

    // 空輸入也代表「這一幀沒進展」，卡住偵測必須看得到它
    if (!out || !Array.isArray(out.press) || out.press.length === 0) {
      const stall = stallStep(st, f);
      if (stall) out = stall;
    }
    return out || emptyInput();
  }

  /** 重設（新的自動演示，例如關掉再開 / 重來） */
  function reset() {
    warnings.length = 0;
    warnedKeys.clear();
    failedGoals.clear();
    menuMember = -1;
    openedCommand = null;
    lastMenuAction = -Infinity;
    lastTextKey = null;
    textReadyFrame = -1;
    lastTextPress = -Infinity;
    stallKey = null;
    stallCount = 0;
    stallLevel = 0;
    forcedDefend = 0;
    inBattle = false;
    dodgePilot = null;
    dodgeKey = null;
    dodgeFresh = false;
    currentAttack = null;
    lastTurn = 1;
    lastStep = 'idle';
    internalFrame = 0;
  }

  /** UI 顯示用摘要（SPEC-AUTOPLAY §3） */
  function describe() {
    return {
      mode: 'demo',
      dodge: dodgePilot?.mode === 'stay' ? 'stay' : dodgeModeFor(lastTurn),
      turn: lastTurn,
      step: lastStep,
      menuDelay,
      attack: attackLabel(currentAttack),
    };
  }

  return {
    input,
    reset,
    warnings,
    describe,
    /* --- 唯讀資訊（測試 / 除錯用） --- */
    get demo() {
      return demo;
    },
    get menuDelay() {
      return menuDelay;
    },
    get autoText() {
      return autoText;
    },
    get textDelay() {
      return textDelay;
    },
    /** 目前彈幕回合的攻擊檔（含 demo；躲避駕駛用） */
    get attackDoc() {
      return currentAttack;
    },
  };
}

export default createEncounterPilot;
