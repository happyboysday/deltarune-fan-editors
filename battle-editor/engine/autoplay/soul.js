/**
 * engine/autoplay/soul.js — 靈魂自動駕駛（SPEC-AUTOPLAY §2.1）
 *
 * 職責（攻擊層；遭遇層由 AP2 的 encounter.js 組裝）：
 *   - `path`：依時間在相鄰路徑點之間線性插值出目標點，交給 follow.js 的跟隨器
 *     產生輸入（無大死區、slow 微調、預判下一點、框旋轉/瞬移補償）；`slow` 用低速；
 *     `hold` 抵達後停留（後續路徑點的時間一併往後推）。目標點先夾回（可旋轉的）戰鬥框內。
 *   - `inputs`：重播錄製的輸入（行程長度編碼字串，編解碼見本檔）。
 *   - `fallback`：腳本用完後 `bot`（交給 engine/autoplay/bot.js）或 `stay`。
 *
 * 輸出 `{ press, hold }`，必要時帶明確的 dx/dy/slow 覆寫。
 * 純 JS、零 import 外部模組 → 瀏覽器與 Node 皆可載入。
 *
 * 速度來源：`state.attack.soul.speed / slowSpeed`（缺省 4 / 2，與 attack.js 相同）。
 *
 * 輸入字串格式（SPEC-AUTOPLAY §2.1）：
 *   `幀:鍵;幀:鍵;…`，每段代表「從該幀起按住哪些鍵」直到下一段；
 *   鍵字母 L R U D S（S = slow 低速鍵）；`!z` confirm、`!x` cancel、`!c` menu
 *   表示「該幀單次按下」（例：`120:R!z`）；空鍵 = 全部放開。
 *   新動作與明確的方向覆寫用 `v2:` + JSON：
 *   每段為 [frame, 按住的動作名陣列, 按下的動作名陣列, 可選的方向覆寫物件]。
 *
 * 註：encodeInputs / decodeInputs 定義在本檔（純函式），
 *     engine/autoplay/index.js 直接 re-export 為公開 API（避免循環 import）。
 */

import { createBot, directionToInput, neutralInput as neutral, SOUL_AUTOMATION_UNSUPPORTED, usesSoulProfiles } from './bot.js';
import { createPathFollower } from './follow.js';
import { normalizeFrameInput } from '../input.js';

/** 遊戲幀率（與 engine/attack.js 的 FPS 一致）。 */
export const FPS_AUTOPLAY = 30;
/** demo.mode 合法值（SPEC-AUTOPLAY §2.1）。 */
export const DEMO_MODES = ['path', 'inputs', 'bot'];
/** pilot 額外接受的模式：'demo'（依 demo 內容解析）、'stay'、'none'（不按鍵）。 */
export const PILOT_MODES = ['demo', 'path', 'inputs', 'bot', 'stay', 'none'];
/** demo.fallback 合法值。 */
export const FALLBACK_MODES = ['bot', 'stay'];

/** 按住鍵：固定順序 L R U D S（編碼輸出穩定）。 */
const HOLD_KEYS = [
  ['left', 'L'],
  ['right', 'R'],
  ['up', 'U'],
  ['down', 'D'],
  ['slow', 'S'],
];
const LETTER_TO_HOLD = { L: 'left', R: 'right', U: 'up', D: 'down', S: 'slow' };
/** 單次按鍵 token ↔ 動作 */
// 方向鍵也可以是「單次按下」（遭遇選單游標移動）：!l !r !u !d
const TOKEN_TO_PRESS = { z: 'confirm', x: 'cancel', c: 'menu', l: 'left', r: 'right', u: 'up', d: 'down' };
const PRESS_TO_TOKEN = { confirm: 'z', cancel: 'x', menu: 'c', left: 'l', right: 'r', up: 'u', down: 'd' };
const AXES = ['dx', 'dy', 'slow'];
const V2 = 'v2:';

/* ------------------------------------------------------------ 小工具 */

function isObj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function num(value, def = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return def;
}

/** 空的引擎輸入（每次回傳新物件）。 */
export function neutralInput() {
  return neutral();
}

/** 動作名稱正規化（接受 confirm/cancel/menu 與 z/x/c）。 */
export function canonicalPressAction(action) {
  if (typeof action !== 'string') return null;
  const name = action.trim();
  const lower = name.toLowerCase();
  if (['z', 'x', 'c'].includes(lower)) return TOKEN_TO_PRESS[lower];
  return Object.hasOwn(PRESS_TO_TOKEN, lower) ? lower : name || null;
}

/** false 和未列出的 hold 等價；方向覆寫只在不能由 hold 推導時保留。 */
export function canonicalInput(input) {
  const src = isObj(input) ? input : {};
  const frame = normalizeFrameInput(src);
  const holdIn = isObj(src.hold) ? src.hold : directionToInput(frame).hold;
  const hold = Object.fromEntries(Object.keys(holdIn).filter((key) => holdIn[key]).sort().map((key) => [key, true]));
  const press = [...new Set(frame.press.map(canonicalPressAction).filter(Boolean))];
  const derived = normalizeFrameInput({ hold });
  const overrides = Object.fromEntries(AXES.filter((key) => frame[key] !== derived[key]).map((key) => [key, frame[key]]));
  return { press, hold, ...overrides };
}

/* ------------------------------------------------- 輸入字串（編解碼） */

function parseV2(text) {
  let rows;
  try {
    rows = JSON.parse(text);
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { entries: [], errors: [{ index: -1, message: 'v2 inputs 不是有效的 JSON' }] };
  }
  if (!Array.isArray(rows)) return { entries: [], errors: [{ index: -1, message: 'v2 inputs 必須包含段落陣列' }] };
  const entries = [];
  const errors = [];
  const actionList = (names) => Array.isArray(names) && names.every((name) => typeof name === 'string' && name.trim());
  for (const [index, row] of rows.entries()) {
    const [frame, held, press, axes] = Array.isArray(row) ? row : [];
    if (!Number.isInteger(frame) || frame < 0 || !actionList(held) || !actionList(press)
        || (axes !== undefined && (!isObj(axes) || Object.keys(axes).some((key) => !AXES.includes(key)
          || (key === 'slow' ? typeof axes[key] !== 'boolean' : ![-1, 0, 1].includes(axes[key])))))) {
      errors.push({ index, message: `v2 inputs 第 ${index + 1} 段的幀號、動作或方向覆寫無效` });
      continue;
    }
    const hold = Object.fromEntries(held.map((key) => [key, true]));
    entries.push({ frame, ...canonicalInput({ hold, press, ...axes }) });
  }
  entries.sort((a, b) => a.frame - b.frame);
  return { entries, errors };
}

/**
 * 解析輸入字串（寬鬆：回傳能解析的段 + 錯誤清單，永不丟例外）。
 * @param {string} text
 * @returns {{entries: {frame:number, hold:object, press:string[]}[], errors: {index:number, message:string}[]}}
 */
export function parseEncodedInputs(text) {
  const entries = [];
  const errors = [];
  if (text === undefined || text === null || text === '') return { entries, errors };
  if (typeof text !== 'string') {
    errors.push({ index: -1, message: 'inputs 必須是字串' });
    return { entries, errors };
  }
  const source = text.trim();
  if (source.startsWith(V2)) return parseV2(source.slice(V2.length));
  const parts = source.split(';');
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index].trim();
    if (part === '') continue; // 允許空段與尾端分號
    const colon = part.indexOf(':');
    if (colon < 0) {
      errors.push({ index, message: `第 ${index + 1} 段「${part}」缺少「幀:」前綴` });
      continue;
    }
    const frameText = part.slice(0, colon).trim();
    const frame = Number(frameText);
    if (!Number.isInteger(frame) || frame < 0) {
      errors.push({ index, message: `第 ${index + 1} 段的幀號不是非負整數（「${frameText}」）` });
      continue;
    }
    const rest = part.slice(colon + 1);
    const hold = {};
    const press = [];
    let bad = null;
    for (let i = 0; i < rest.length; i += 1) {
      const ch = rest[i];
      if (ch === ' ' || ch === '\t') continue;
      if (ch === '!') {
        const next = rest[i + 1];
        if (next === undefined) {
          bad = `第 ${index + 1} 段「!」後面缺少動作字母（z = confirm、x = cancel、c = menu）`;
          break;
        }
        i += 1;
        const action = TOKEN_TO_PRESS[next.toLowerCase()];
        if (!action) {
          bad = `第 ${index + 1} 段「!${next}」不是合法動作（z = confirm、x = cancel、c = menu）`;
          break;
        }
        if (!press.includes(action)) press.push(action);
        continue;
      }
      const key = LETTER_TO_HOLD[ch.toUpperCase()];
      if (!key) {
        bad = `第 ${index + 1} 段有未知的鍵字母「${ch}」（可用 L R U D S 與 !z/!x/!c）`;
        break;
      }
      hold[key] = true;
    }
    if (bad) {
      errors.push({ index, message: bad });
      continue;
    }
    entries.push({ frame, hold, press });
  }
  entries.sort((a, b) => a.frame - b.frame);
  return { entries, errors };
}

/**
 * 輸入字串 → 逐段輸入（解析失敗的段略過；嚴格檢查請用 parseEncodedInputs）。
 * @param {string} text
 * @returns {{frame:number, hold:object, press:string[]}[]}
 */
export function decodeInputs(text) {
  return parseEncodedInputs(text).entries;
}

/** 一段輸入的「鍵」字串（L R U D S 順序）。 */
function holdKeyString(hold) {
  let out = '';
  for (const [key, letter] of HOLD_KEYS) if (hold[key]) out += letter;
  return out;
}

export function sameSustainedInput(a, b) {
  return AXES.every((key) => a[key] === b[key])
    && Object.keys(a.hold).length === Object.keys(b.hold).length
    && Object.keys(a.hold).every((key) => Object.hasOwn(b.hold, key));
}

/**
 * 逐段輸入 → 輸入字串（行程長度編碼：與前一段相同的鍵不再重複寫）。
 *
 * 每一段 = 「從該幀起持續按住 `鍵`」；`!z/!x/!c` 只在該幀單次按下。
 * 因此 press-only 的段即使鍵沒變也必須保留。
 *
 * @param {{frame:number, press?:string[], hold?:object}[]} entries
 * @returns {string}
 */
export function encodeInputs(entries) {
  const list = Array.isArray(entries) ? entries : [];
  const sorted = list
    .filter((entry) => isObj(entry) && Number.isFinite(Number(entry.frame)))
    .map((entry) => {
      return { frame: Math.max(0, Math.round(Number(entry.frame))), ...canonicalInput(entry) };
    })
    .sort((a, b) => a.frame - b.frame);

  const segments = sorted.filter((entry, i) => i === 0 || entry.press.length || !sameSustainedInput(sorted[i - 1], entry));
  const needsV2 = segments.some((entry) => AXES.some((key) => key in entry)
    || Object.keys(entry.hold).some((key) => !HOLD_KEYS.some(([legacy]) => legacy === key))
    || entry.press.some((key) => !Object.hasOwn(PRESS_TO_TOKEN, key)));
  if (needsV2) {
    if (segments.at(-1).frame < sorted.at(-1).frame) segments.push(sorted.at(-1));
    return V2 + JSON.stringify(segments.map(({ frame, press, hold, ...axes }) => {
      const row = [frame, Object.keys(hold), press];
      if (Object.keys(axes).length) row.push(axes);
      return row;
    }));
  }
  return segments.map(({ frame, hold, press }) =>
    `${frame}:${holdKeyString(hold)}${press.map((action) => `!${PRESS_TO_TOKEN[action]}`).join('')}`,
  ).join(';');
}

/* ------------------------------------------------------- demo 模式解析 */

/** demo 是否有可用的路徑點。 */
export function hasDemoPath(demo) {
  return isObj(demo) && Array.isArray(demo.path) && demo.path.length > 0;
}

/** demo 是否有可用的輸入字串。 */
export function hasDemoInputs(demo) {
  return isObj(demo) && typeof demo.inputs === 'string' && demo.inputs.trim() !== '';
}

/**
 * 解析示範模式：明確模式優先；`'demo'`（或省略／非法值）時依 SPEC 規則
 * 「有 path 用 path、否則有 inputs 用 inputs、否則 bot」。
 *
 * @param {any} demo
 * @param {string} [requested='demo']
 * @returns {'path'|'inputs'|'bot'|'stay'|'none'}
 */
export function resolveDemoMode(demo, requested = 'demo') {
  const req = typeof requested === 'string' ? requested : 'demo';
  if (req === 'path') return hasDemoPath(demo) ? 'path' : 'bot';
  if (req === 'inputs') return hasDemoInputs(demo) ? 'inputs' : 'bot';
  if (req === 'bot' || req === 'stay' || req === 'none') return req;
  if (!isObj(demo)) return 'bot';
  if (demo.mode === 'path') return hasDemoPath(demo) ? 'path' : 'bot';
  if (demo.mode === 'inputs') return hasDemoInputs(demo) ? 'inputs' : 'bot';
  if (demo.mode === 'bot') return 'bot';
  if (hasDemoPath(demo)) return 'path';
  if (hasDemoInputs(demo)) return 'inputs';
  return 'bot';
}

/* ------------------------------------------------------------ 路徑時間軸 */

/** 建立路徑時間軸：每點的實際起始時間（`hold` 把後續點往後推）。 */
export function buildPathTimeline(points) {
  const pts = (Array.isArray(points) ? points : [])
    .filter(
      (p) =>
        isObj(p) &&
        Number.isFinite(Number(p.t)) &&
        Number.isFinite(Number(p.x)) &&
        Number.isFinite(Number(p.y)),
    )
    .map((p) => ({
      t: Math.max(0, Number(p.t)),
      x: Number(p.x),
      y: Number(p.y),
      slow: Boolean(p.slow),
      hold: Math.max(0, num(p.hold, 0)),
    }))
    .sort((a, b) => a.t - b.t);
  if (pts.length === 0) return null;
  const starts = new Array(pts.length);
  starts[0] = pts[0].t;
  for (let i = 1; i < pts.length; i += 1) {
    starts[i] = Math.max(pts[i].t, starts[i - 1] + pts[i - 1].hold);
  }
  return { pts, starts, end: starts[pts.length - 1] + pts[pts.length - 1].hold };
}

/**
 * 時間 t（秒）的目標點。
 * @returns {{x:number, y:number, slow:boolean}|null} null = 路徑已用完 → fallback
 */
export function pathTargetAt(timeline, t) {
  const { pts, starts, end } = timeline;
  if (!(t < end)) return null;
  if (pts.length === 1) return { x: pts[0].x, y: pts[0].y, slow: pts[0].slow };
  let i = 0;
  while (i < pts.length - 2 && t >= starts[i + 1]) i += 1;
  const a = pts[i];
  const b = pts[i + 1];
  if (t <= starts[i]) return { x: a.x, y: a.y, slow: a.slow };
  const span = starts[i + 1] - starts[i];
  const u = span > 0 ? Math.min(1, Math.max(0, (t - starts[i]) / span)) : 1;
  return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, slow: a.slow };
}

/* ------------------------------------------------------------ 靈魂駕駛 */

/**
 * 建立靈魂自動駕駛。
 *
 * @param {object} [options]
 * @param {any}    [options.demo]   攻擊檔的 `demo`（SPEC-AUTOPLAY §2.1；可為 null）
 * @param {object} [options.attack] 攻擊檔（預先判定是否支援路徑／bot）
 * @param {string} [options.mode]   'demo'（預設，依 demo 內容解析）|
 *                                  'path' | 'inputs' | 'bot' | 'stay' | 'none'
 * @param {object} [options.botOptions] fallback bot 選項（horizon/grazeBias/seed…）
 * @param {number} [options.fps]    幀率（預設 30）
 */
export function createSoulPilot(options = {}) {
  const opts = isObj(options) ? options : {};
  const fps = Math.max(1, num(opts.fps, FPS_AUTOPLAY));
  const demo = isObj(opts.demo) ? opts.demo : null;
  const botOptions = isObj(opts.botOptions) ? opts.botOptions : {};
  const followerOptions = isObj(opts.followerOptions) ? opts.followerOptions : {};
  const requested = typeof opts.mode === 'string' ? opts.mode : 'demo';
  const warnings = [];
  const profiled = usesSoulProfiles(opts.attack);
  const fallbackLabel = profiled ? '' : '，改用 bot';

  const resolvedMode = resolveDemoMode(demo, requested);
  if (demo && demo.mode === 'path' && !hasDemoPath(demo)) {
    warnings.push(`demo.mode 為 "path" 但沒有 path 路徑點${fallbackLabel}`);
  }
  if (demo && demo.mode === 'inputs' && !hasDemoInputs(demo)) {
    warnings.push(`demo.mode 為 "inputs" 但沒有 inputs 字串${fallbackLabel}`);
  }

  /** 路徑時間軸（path 模式才建立） */
  let timeline = null;
  if (resolvedMode === 'path') {
    timeline = buildPathTimeline(demo.path);
    if (!timeline) warnings.push(`demo.path 沒有可用的路徑點${fallbackLabel}`);
  }
  const effectiveMode = resolvedMode === 'path' && !timeline ? 'bot' : resolvedMode;

  /** 重播段（inputs 模式才建立） */
  let replay = [];
  if (effectiveMode === 'inputs') {
    const parsed = parseEncodedInputs(demo.inputs);
    for (const err of parsed.errors) warnings.push(`demo.inputs：${err.message}`);
    replay = parsed.entries;
    if (replay.length === 0) warnings.push(`demo.inputs 解析後沒有可用的段${fallbackLabel}`);
  }
  const finalMode = effectiveMode === 'inputs' && replay.length === 0 ? 'bot' : effectiveMode;

  /** 腳本用完後的行為（SPEC §2.1，預設 stay） */
  const fallback = demo && demo.fallback === 'bot' ? 'bot' : 'stay';
  let blocked = false;
  function rejectLegacyAutomation() {
    if (!warnings.includes(SOUL_AUTOMATION_UNSUPPORTED)) warnings.unshift(SOUL_AUTOMATION_UNSUPPORTED);
    return neutralInput();
  }
  if (profiled && (finalMode === 'path' || finalMode === 'bot')) {
    blocked = true;
    rejectLegacyAutomation();
  }

  let bot = null;
  let internalFrame = 0;
  let steps = 0;
  /** 重播游標（seek 倒退時重設） */
  let replayCursor = 0;

  function getBot() {
    if (!bot) bot = createBot(botOptions);
    return bot;
  }

  function fallbackInput(state) {
    if (fallback !== 'bot') return neutralInput();
    if (profiled || state?.soul?.profile || usesSoulProfiles(state?.attack)) return rejectLegacyAutomation();
    return getBot().input(state);
  }

  /** path：交給 follow.js 的跟隨器（精度 + slow 微調 + 框/瞬移補償） */
  let follower = null;
  function getFollower() {
    if (!follower) follower = createPathFollower(followerOptions);
    return follower;
  }
  function followTarget(state, target, nextTarget) {
    if (!isObj(state) || !isObj(state.soul) || !isObj(state.box)) return neutralInput();
    return getFollower().input(state, target, nextTarget);
  }

  /** inputs：重播錄製的輸入 */
  function replayInput(frame) {
    const lastFrame = replay[replay.length - 1].frame;
    if (frame > lastFrame) return null; // → fallback
    if (replayCursor >= replay.length || replay[replayCursor].frame > frame) replayCursor = 0;
    while (replayCursor + 1 < replay.length && replay[replayCursor + 1].frame <= frame) replayCursor += 1;
    const entry = replay[replayCursor];
    if (!entry || entry.frame > frame) return neutralInput();
    // 單次按下只在「該段所在的幀」送出
    const press = entry.frame === frame ? entry.press.slice() : [];
    const { frame: _frame, hold, press: _press, ...axes } = entry;
    return { press, hold: { ...hold }, ...axes };
  }

  /**
   * 這一幀的輸入。
   * @param {object|null} state 引擎 getState()（path 模式需要 soul/box/attack）
   * @param {number} frame 幀號（0 起算）
   * @returns {{press: string[], hold: object}}
   */
  function computeInput(state, frame) {
    if (finalMode === 'none' || finalMode === 'stay') return neutralInput();
    if (blocked) return neutralInput();
    if ((finalMode === 'path' || finalMode === 'bot') && (state?.soul?.profile || usesSoulProfiles(state?.attack))) {
      blocked = true;
      return rejectLegacyAutomation();
    }
    if (finalMode === 'bot') return getBot().input(state);
    if (finalMode === 'inputs') {
      const replayed = replayInput(frame);
      return replayed || fallbackInput(state);
    }
    // path
    const target = pathTargetAt(timeline, Math.max(0, frame) / fps);
    if (!target) return fallbackInput(state);
    // 下一幀目標：讓跟隨器提前瞄準，減少過衝（SPEC-AUTOPLAY §2.1）
    const nextTarget = pathTargetAt(timeline, (Math.max(0, frame) + 1) / fps);
    return followTarget(state, target, nextTarget);
  }

  const pilot = {
    /** 解析後的實際模式（'path' | 'inputs' | 'bot' | 'stay' | 'none'）。 */
    get mode() {
      return blocked ? 'stay' : finalMode;
    },
    /** 腳本用完後的行為（'bot' | 'stay'）。 */
    get fallback() {
      return fallback;
    },
    /** 已呼叫 input() 的次數。 */
    get steps() {
      return steps;
    },
    /** 解析／驗證期的提示訊息（永不丟例外）。 */
    get warnings() {
      return warnings;
    },

    /**
     * 決定這一幀的引擎輸入。
     * @param {object|null} state 引擎 getState()
     * @param {number} [frame] 幀號；省略時用 state.frame，再省略用內部計數
     * @returns {{press: string[], hold: object}}
     */
    input(state, frame) {
      steps += 1;
      let f;
      if (Number.isFinite(frame)) f = Math.max(0, Number(frame));
      else if (isObj(state) && Number.isFinite(state.frame)) f = Math.max(0, Number(state.frame));
      else f = internalFrame;
      internalFrame = f + 1;
      return computeInput(state, f);
    },

    /** 重設到開頭（保留 demo 解析結果與 warnings）。 */
    reset() {
      internalFrame = 0;
      steps = 0;
      replayCursor = 0;
      if (bot) bot.reset();
    },

    /** 給 UI 顯示的摘要：{ mode, dodge, turn, step }（SPEC-AUTOPLAY §3）。 */
    describe() {
      return {
        mode: requested === 'demo' ? 'demo' : requested,
        dodge: pilot.mode,
        turn: null,
        step: steps,
      };
    },
  };

  return pilot;
}

export default createSoulPilot;
