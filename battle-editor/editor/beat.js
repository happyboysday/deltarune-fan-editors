// editor/beat.js (V2-06) — BPM / 拍點的純邏輯（不碰 DOM）
//
// 職責：
//   1. 把 settings.bpm / settings.beatOffset 變成時間軸、檢查器、預覽共用的
//      「timing」物件（直接沿用引擎 engine/attack.js 的 beatTimingOf）。
//   2. 時間欄位（`at`、`duration`、`interval`、`life`、`fade`、demo `t`）的
//      解析：數字 = 秒；`"2b"` / `"1.5b"` = 拍點（引擎 SPEC-EXPR-V2 §2）。
//      時間「點」加 beatOffset、長度不加——與引擎 normalizeAttack 完全一致。
//   3. 時間軸拍線座標、拍點吸附、狀態列「第幾拍」字串所需的數學。
//
// 這裡的函式全部是純函式（不讀 store、不取 locale），方便 node 測試；
// UI 文字由呼叫端用 i18n 組。
//
// 注意：這是編輯器端的「預覽解析」，真正的權威仍是引擎 normalizeAttack()。
// 兩邊必須一致，因此這裡直接呼叫引擎的 parseBeatString / beatTimingOf，
// 不自己重寫正則。

import { beatTimingOf, parseBeatString } from '../engine/attack.js';

/** 每幾拍畫一條粗拍線（與 DAW 的 bar 線一致）。 */
export const BEAT_MAJOR_EVERY = 4;

const EPS = 1e-9;
const PRECISION = 1e9;

/** 有限數字或 fallback。 */
function num(v, fallback = 0) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** 把浮點誤差收乾淨（時間軸像素計算用）。 */
export function cleanSeconds(v) {
  const n = num(v, 0);
  return Math.round(n * PRECISION) / PRECISION;
}

/**
 * 保證回傳標準 timing 形狀 `{bpm, beatOffset, hasBpm, beatSec}`。
 * 可傳 attack 文件（取 .settings）、settings 物件或已算好的 timing。
 */
export function normalizeTiming(src) {
  if (!src || typeof src !== 'object') return beatTimingOf(null);
  if (
    Object.prototype.hasOwnProperty.call(src, 'hasBpm') &&
    Object.prototype.hasOwnProperty.call(src, 'beatSec')
  ) {
    const bpm = num(src.bpm, NaN);
    const hasBpm = Number.isFinite(bpm) && bpm > 0;
    return {
      bpm: hasBpm ? bpm : null,
      beatOffset: num(src.beatOffset, 0),
      hasBpm,
      beatSec: hasBpm ? 60 / bpm : 0,
    };
  }
  const settings =
    src.settings && typeof src.settings === 'object' ? src.settings : src;
  return beatTimingOf(settings);
}

/** 從 attack 文件（或 settings）取 timing。 */
export const timingOf = normalizeTiming;

/** 是否為拍點字串（`"2b"`、`".5b"`）。 */
export function isBeatString(raw) {
  return parseBeatString(raw) !== null;
}

/**
 * 解析單一時間欄位。
 *
 * opts.addOffset  — 時間「點」（at / demo t / 游標）傳 true；長度欄位傳 false。
 * opts.allowNegative — 允許負拍（預設 false）。
 *
 * 回傳 `{ ok, empty, kind: 'empty'|'seconds'|'beat', seconds, beats, raw, code }`；
 * 失敗時 code ∈ `'nan'|'type'|'bad'|'no-bpm'|'negative'`（由呼叫端翻成訊息）。
 */
export function parseTime(raw, timing, opts = {}) {
  const tm = normalizeTiming(timing);
  const addOffset = !!opts.addOffset;
  const allowNegative = !!opts.allowNegative;

  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return { ok: true, empty: true, kind: 'empty', seconds: null, beats: null, raw, code: null };
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) {
      return { ok: false, empty: false, kind: 'seconds', seconds: null, beats: null, raw, code: 'nan' };
    }
    if (!allowNegative && raw < 0) {
      return { ok: false, empty: false, kind: 'seconds', seconds: null, beats: null, raw, code: 'negative' };
    }
    return { ok: true, empty: false, kind: 'seconds', seconds: raw, beats: null, raw, code: null };
  }
  if (typeof raw !== 'string') {
    return { ok: false, empty: false, kind: 'type', seconds: null, beats: null, raw, code: 'type' };
  }
  const text = raw.trim();
  const beats = parseBeatString(text);
  if (beats !== null) {
    if (!tm.hasBpm) {
      return { ok: false, empty: false, kind: 'beat', seconds: null, beats, raw: text, code: 'no-bpm' };
    }
    if (!allowNegative && beats * tm.beatSec < 0) {
      return { ok: false, empty: false, kind: 'beat', seconds: null, beats, raw: text, code: 'negative' };
    }
    const seconds = beats * tm.beatSec + (addOffset ? tm.beatOffset : 0);
    return { ok: true, empty: false, kind: 'beat', seconds, beats, raw: text, code: null };
  }
  const n = Number(text);
  if (Number.isFinite(n)) {
    if (!allowNegative && n < 0) {
      return { ok: false, empty: false, kind: 'seconds', seconds: null, beats: null, raw: text, code: 'negative' };
    }
    return { ok: true, empty: false, kind: 'seconds', seconds: n, beats: null, raw: text, code: null };
  }
  return { ok: false, empty: false, kind: 'bad', seconds: null, beats: null, raw: text, code: 'bad' };
}

/** 時間「點」→ 秒（`at`、demo `t`、游標）；不合法回 fallback。 */
export function timePointSeconds(raw, timing, fallback = 0) {
  const r = parseTime(raw, timing, { addOffset: true });
  return r.ok && !r.empty ? r.seconds : fallback;
}

/** 長度欄位 → 秒（`duration`、`interval`、`life`、`fade`）；不合法回 fallback。 */
export function timeLengthSeconds(raw, timing, fallback = 0) {
  const r = parseTime(raw, timing, { addOffset: false });
  return r.ok && !r.empty ? r.seconds : fallback;
}

/** 秒 → 顯示文字（去掉多餘小數點，例如 1.5 → "1.5"、2 → "2"）。 */
export function formatSeconds(sec, digits = 3) {
  const n = num(sec, 0);
  const p = 10 ** digits;
  const v = Math.round(n * p) / p;
  return String(v);
}

/**
 * 欄位值的「原始寫法」→ 顯示字串。拍點字串原樣保留（存檔要保留使用者寫法）。
 */
export function formatTimeRaw(raw) {
  if (raw === null || raw === undefined) return '';
  return String(raw);
}

/**
 * 時間欄位 → 拍數（浮點）。不是拍點字串或沒有 bpm 回 null。
 */
export function beatsOf(raw, timing) {
  const tm = normalizeTiming(timing);
  if (!tm.hasBpm) return null;
  const beats = parseBeatString(raw);
  if (beats !== null) return beats;
  const r = parseTime(raw, tm, { addOffset: false });
  if (!r.ok || r.empty) return null;
  return r.seconds / tm.beatSec;
}

/**
 * 目前時間 → 拍位置。沒有 bpm 回 null。
 * `index` 從 beatOffset 起算的 0-based 拍索引（可為負），`beat` 是 1-based，
 * `fraction` 是拍內比例（0–1），`position` 是浮點拍數。
 */
export function beatPosition(sec, timing) {
  const tm = normalizeTiming(timing);
  if (!tm.hasBpm) return null;
  const position = (num(sec, 0) - tm.beatOffset) / tm.beatSec;
  const index = Math.floor(position + EPS);
  return {
    index,
    beat: index + 1,
    fraction: position - index,
    position,
  };
}

/** 總長換算成拍數（給狀態列「共 N 拍」）。沒有 bpm 或長度非正回 null。 */
export function totalBeats(durationSec, timing) {
  const tm = normalizeTiming(timing);
  if (!tm.hasBpm) return null;
  const d = num(durationSec, 0);
  if (!(d > 0)) return null;
  return d / tm.beatSec;
}

/**
 * 產生 [fromSec, toSec] 之間的拍線。
 * 回傳 `[{sec, index, beat, major}]`：`index` 0-based（可為負）、`beat` 1-based、
 * `major` 為每 BEAT_MAJOR_EVERY 拍一條粗線。
 */
export function beatTimes(timing, fromSec, toSec, opts = {}) {
  const tm = normalizeTiming(timing);
  if (!tm.hasBpm) return [];
  const majorEvery = Math.max(1, Math.round(num(opts.majorEvery, BEAT_MAJOR_EVERY)));
  const limit = Math.max(1, Math.round(num(opts.limit, 4096)));
  const from = num(fromSec, 0);
  const to = num(toSec, 0);
  if (!(to >= from)) return [];
  const startIdx = Math.ceil((from - tm.beatOffset) / tm.beatSec - EPS);
  const endIdx = Math.floor((to - tm.beatOffset) / tm.beatSec + EPS);
  if (endIdx < startIdx) return [];
  const out = [];
  const count = Math.min(endIdx - startIdx + 1, limit);
  for (let i = 0; i < count; i += 1) {
    const index = startIdx + i;
    out.push({
      sec: cleanSeconds(tm.beatOffset + index * tm.beatSec),
      index,
      beat: index + 1,
      major: ((index % majorEvery) + majorEvery) % majorEvery === 0,
    });
  }
  return out;
}

/** 最近的拍線時間（吸附用）。沒有 bpm 或 opts.enabled === false → 原值（夾在 ≥0）。 */
export function snapToBeat(sec, timing, opts = {}) {
  const tm = normalizeTiming(timing);
  const s = num(sec, 0);
  if (!tm.hasBpm || opts.enabled === false) return Math.max(0, s);
  const idx = Math.round((s - tm.beatOffset) / tm.beatSec);
  return Math.max(0, cleanSeconds(tm.beatOffset + idx * tm.beatSec));
}

/** 往前／往後一個拍線（鍵盤微調用；dir = ±1）。 */
export function shiftBeat(sec, timing, dir = 1) {
  const tm = normalizeTiming(timing);
  const s = num(sec, 0);
  if (!tm.hasBpm) return Math.max(0, s);
  const step = Math.sign(dir || 1);
  // 目前在拍線上 → 直接跳一格；否則跳到下／上一個拍線。
  const rel = (s - tm.beatOffset) / tm.beatSec;
  const nearest = Math.round(rel);
  const isOnBeat = Math.abs(rel - nearest) < 1e-6;
  const target = isOnBeat ? nearest + step : step > 0 ? Math.ceil(rel) : Math.floor(rel);
  return Math.max(0, cleanSeconds(tm.beatOffset + target * tm.beatSec));
}

/**
 * 拍點吸附的「開關」判斷（時間軸拖曳用）。
 *  - 沒有 bpm → null（呼叫端沿用舊的幀／粗吸附）。
 *  - 有 bpm → 預設吸附；按住 Shift 暫時關閉（規格：Shift 暫時切換吸附）。
 */
export function beatSnapMode(timing, event) {
  const tm = normalizeTiming(timing);
  if (!tm.hasBpm) return null;
  return { enabled: !(event && event.shiftKey), timing: tm };
}

/** 秒 → 拍點字串（`"2b"`、`"1.5b"`）；沒有 bpm 回 null。 */
export function secondsToBeatString(sec, timing, addOffset = false, digits = 4) {
  const tm = normalizeTiming(timing);
  if (!tm.hasBpm) return null;
  const s = num(sec, 0) - (addOffset ? tm.beatOffset : 0);
  const beats = s / tm.beatSec;
  const p = 10 ** digits;
  const rounded = Math.round(beats * p) / p;
  return `${rounded}b`;
}

/**
 * 拖曳寫回時保留使用者的寫法（SPEC-EXPR-V2 §2「存檔保留使用者寫法」）：
 * 原本是拍點字串 → 寫回拍點字串；原本是數字 → 寫回數字秒。
 *
 * original 是事件原本的值（`at` 或 `duration`）。
 */
export function formatLike(sec, original, timing, addOffset = false) {
  const tm = normalizeTiming(timing);
  if (typeof original === 'string' && tm.hasBpm && isBeatString(original)) {
    return secondsToBeatString(sec, tm, addOffset);
  }
  const n = num(sec, 0);
  return Math.round(n * PRECISION) / PRECISION;
}
