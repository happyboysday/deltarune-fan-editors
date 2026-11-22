/* editor/timeline.js — ED2：時間軸面板
 *
 * 對外介面（SPEC §10）：
 *   export function mount(rootEl, ctx)   ctx = { store, assets /*loadAssets 結果或 null*\/, preview }
 *
 * 只依賴 store（attack / selection / subscribe / update / select / undo? / errors / newId）
 * 與 preview（seek / getFrame / fps / onFrame / duration）。不碰其他模組的內部狀態。
 *
 * 本檔分兩層：
 *   1. 純函式層（時間↔像素、刻度、吸附、分列演算法、命中測試…）→ 可在 node 測試。
 *   2. mount()：DOM + canvas 繪製 + 互動。
 *
 * 介面文字（SPEC §10.1）：全部走 i18n 的 t('timeline.*')，字串放在
 * editor/locales/timeline.js（命名空間 `timeline`，繁中／簡中／英文）。
 */

import { t, registerStrings, onLocaleChange } from './i18n.js';
import TIMELINE_STRINGS from './locales/timeline.js';
import { soulT } from './locales/soul.js';
// 拍點（SPEC-EXPR-V2 §2）：時間欄位可寫 `"2b"`，時間軸要畫拍線並吸附。
import {
  BEAT_MAJOR_EVERY,
  beatPosition,
  beatTimes,
  cleanSeconds,
  formatLike,
  normalizeTiming,
  parseTime,
  secondsToBeatString,
  snapToBeat,
  timeLengthSeconds,
  timePointSeconds,
  totalBeats,
} from './beat.js';
// 戰鬥框預設值一律取自引擎（SPEC-LAYOUT §5 實機量測），不在編輯器複製數字。
import { BOX_DEFAULTS } from '../engine/attack.js';

registerStrings('timeline', TIMELINE_STRINGS);

/* ------------------------------------------------------------------ *
 * 常數
 * ------------------------------------------------------------------ */

export const FPS = 30;                 // SPEC §0：模擬固定 30 FPS
const DEFAULT_DURATION = 8;            // settings.duration 缺省值
const ROW_H = 22;                      // 單列高度（CSS px）
const GROUP_GAP = 5;                   // 類型群組間距
const PAD_TOP = 3;
const RULER_H = 34;
const SOUL_TRACKS = { soulProfile: 'profile', soulAppearance: 'appearance', soulTeleport: 'teleport' };
const EDGE_PX = 7;                     // 條狀事件右緣可拖曳寬度
const EVENT_HIT_PAD = 4;               // B15：事件條上下各擴 4px 判定命中（避免偏 1–2px 就變框選）
const MIN_BAR_PX = 16;                 // 條狀事件小於此寬度不啟用右緣拖曳（先放大再調）
const MIN_ZOOM = 6;                    // px / 秒
const MAX_ZOOM = 3000;
const MAX_DURATION = 600;              // 秒，防手滑
const GUTTER = 96;                     // 左側類型欄寬（CSS px）

/** 軌道類型：label 是 getter（依目前語系），所以換語系後重繪即可生效 */
function trackMeta(type, color) {
  const o = { type, color };
  Object.defineProperty(o, 'label', {
    enumerable: true,
    get() { return SOUL_TRACKS[type] ? soulT(SOUL_TRACKS[type]) : t(`timeline.track.${type}`); },
  });
  return o;
}

export const TRACK_TYPES = [
  trackMeta('spawn', '#4cc9f0'),
  trackMeta('emitter', '#b388ff'),
  trackMeta('box', '#4ade80'),
  trackMeta('soul', '#ff5c7a'),
  trackMeta('soulProfile', '#ff789d'),
  trackMeta('soulAppearance', '#e589fa'),
  trackMeta('soulTeleport', '#7e9bfd'),
  trackMeta('soulDrift', '#9bb4ff'),
  trackMeta('clear', '#ffa94d'),
  trackMeta('shake', '#ffd93d'),
  trackMeta('sfx', '#5eead4'),
  trackMeta('anim', '#fbaf73'),
  trackMeta('end', '#f472b6'),
];
export const TRACK_ORDER = TRACK_TYPES.map((tt) => tt.type);
const TYPE_META = new Map(TRACK_TYPES.map((tt) => [tt.type, tt]));
export const INSTANT_TYPES = Object.freeze(['spawn', 'soul', ...Object.keys(SOUL_TRACKS), 'clear', 'sfx', 'anim', 'end']);
export const DURATION_TYPES = Object.freeze(['emitter', 'box', 'shake']);

function unknownMeta() {
  return { label: t('timeline.track.other'), color: '#94a3b8' };
}
/** 事件類型顯示名（選單／左欄／復原步驟共用） */
export function trackLabel(type) {
  const meta = TYPE_META.get(type);
  return meta ? meta.label : t('timeline.track.other');
}
/** 新增事件選單的類型說明 */
function menuDesc(type) {
  return SOUL_TRACKS[type] ? soulT(SOUL_TRACKS[type]) : TYPE_META.has(type) ? t(`timeline.menu.${type}`) : '';
}

/** 焦點元素是否為可輸入元件（INPUT / TEXTAREA / SELECT / contentEditable）。 */
export function isEditableElement(el) {
  if (!el || typeof el !== 'object') return false;
  if (el.isContentEditable === true) return true;
  const tag = String(el.tagName || '').toUpperCase();
  if (!tag) return false;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** 通用對話框（#modal-root）目前是否開著；在 node（無 document）下永遠 false。 */
export function modalOpenNow(doc) {
  if (!doc || typeof doc.getElementById !== 'function') return false;
  const root = doc.getElementById('modal-root');
  return !!root && root.hidden !== true;
}

/**
 * B14：時間軸鍵盤判定（純函式，方便測試）。
 *
 * 規則：
 *   - 選單或對話框開著 → 不動作（交給它們自己的 Esc/Enter 處理）
 *   - 焦點在可輸入元件 → 不動作（檢查器欄位的 Backspace 必須是「刪字」）
 *   - Delete / Backspace：只要「有選取事件」就刪，**不要求焦點在 .tl-root**
 *     （點過預覽畫布後焦點在 canvas 上，仍然要能刪）
 *   - Ctrl/Cmd+D：複製選取事件（沿用原本「焦點在時間軸」的限制，避免搶瀏覽器書籤快捷鍵）
 *
 * @param {{key:string,focused?:boolean,editable?:boolean,modalOpen?:boolean,menuOpen?:boolean,selectedCount?:number,ctrl?:boolean,shift?:boolean,alt?:boolean}} input
 * @returns {'delete'|'duplicate'|null}
 */
export function timelineKeyIntent(input) {
  const o = input || {};
  if (o.menuOpen || o.modalOpen) return null;
  if (o.editable) return null;
  const key = typeof o.key === 'string' ? o.key : '';
  if (!key) return null;
  const selected = Number(o.selectedCount) > 0;
  if (key === 'Delete' || key === 'Backspace') return selected ? 'delete' : null;
  if (o.ctrl && !o.shift && !o.alt && (key === 'd' || key === 'D')) {
    return selected && o.focused ? 'duplicate' : null;
  }
  return null;
}

/**
 * B10：新增事件選單項目的三段文字（全部走 i18n，只有「事件類型 id」保留原字串）：
 *   name = 已翻譯的類型名（例如「發射器」）
 *   id   = JSON 的事件類型識別字（例如 emitter），顯示在名稱後方的小字
 *   desc = 已翻譯的一行說明
 * 三語都不會出現「名稱英文、說明中文」的中英混排：名稱與說明同屬一種語系，
 * id 只是技術識別字（與 demo 面板的 path / inputs / bot 一樣刻意不翻譯）。
 */
export function menuItemParts(type) {
  const name = trackLabel(type);
  const desc = menuDesc(type);
  return {
    name,
    id: String(type),
    desc,
    title: desc
      ? t('timeline.menu.itemTitle', { name, type, desc })
      : t('timeline.menu.idTitle', { type }),
  };
}

/* ------------------------------------------------------------------ *
 * 純函式層
 * ------------------------------------------------------------------ */

export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** 抹掉浮點誤差（避免 0.30000000000000004 之類）；保留到奈秒級以免累積 */
export function roundTime(t) {
  return Math.round(t * 1e9) / 1e9;
}

/** 秒 → 畫布 x（view = { scrollSec, pxPerSec, gutter }） */
export function timeToX(time, view) {
  return view.gutter + (time - view.scrollSec) * view.pxPerSec;
}

/** 畫布 x → 秒 */
export function xToTime(x, view) {
  return view.scrollSec + (x - view.gutter) / view.pxPerSec;
}

/** 時間吸附：預設吸附到 1/30 秒；coarse=true（Shift）吸附到 0.1 秒 */
export function snapTime(sec, opts = {}) {
  const fps = opts.fps || FPS;
  const step = opts.step != null ? opts.step : (opts.coarse ? 0.1 : 1 / fps);
  if (!(step > 0)) return roundTime(sec);
  return roundTime(Math.round(sec / step) * step);
}

/**
 * 事件開始時間（秒）。`at` 可以是數字（秒）或拍點字串（`"2b"`，
 * 需要 opts.timing 或事件所在的 settings，SPEC-EXPR-V2 §2）。
 * 沒有 timing 又拿到非數字 → 回 null（呼叫端決定是否略過）。
 */
export function eventStartSec(ev, timing) {
  if (!ev || typeof ev !== 'object') return null;
  const raw = ev.at;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') {
    // 缺 at → 0（與舊行為一致）
    return raw === null || raw === undefined || raw === '' ? 0 : null;
  }
  if (timing == null) {
    // 沒有 bpm 上下文：純數字字串仍視為秒（舊檔相容），其餘不解析
    const n = Number(raw.trim());
    return raw.trim() !== '' && Number.isFinite(n) ? n : null;
  }
  const r = parseTime(raw, timing, { addOffset: true, allowNegative: false });
  return r.ok && !r.empty ? r.seconds : null;
}

/** 事件長度（秒）；`duration` 可為拍點字串（長度不加 beatOffset）。 */
export function eventDurationSec(ev, timing) {
  if (!ev || typeof ev !== 'object') return 0;
  const raw = ev.duration;
  if (typeof raw === 'number') return Number.isFinite(raw) && raw > 0 ? raw : 0;
  if (typeof raw !== 'string' || raw.trim() === '') return 0;
  if (timing == null) {
    const n = Number(raw.trim());
    return raw.trim() !== '' && Number.isFinite(n) && n > 0 ? n : 0;
  }
  const d = timeLengthSeconds(raw, timing, 0);
  return Number.isFinite(d) && d > 0 ? d : 0;
}

/**
 * 拍點吸附（SPEC V2-06）：有 bpm 時吸附到拍線；按住 Shift 暫時關閉吸附
 * （回到原本的幀／粗吸附）。沒有 bpm → 完全沿用舊行為。
 */
export function snapTimeBeat(sec, timing, opts = {}) {
  const tm = normalizeTiming(timing);
  if (tm.hasBpm && opts.beat !== false) return snapToBeat(sec, tm, { enabled: true });
  return snapTime(sec, opts);
}

/**
 * 依縮放挑選刻度間距（秒）。
 * 回傳 { major, minor, frameTicks, minorIsFrame, majorIsFrame }
 *   major：有數字的刻度；minor：細格線。
 *   frameTicks：是否細到看得見單幀格。
 */
export function chooseTicks(pxPerSec, fps = FPS) {
  const cands = [
    1 / fps, 2 / fps, 3 / fps, 5 / fps, 6 / fps, 10 / fps, 15 / fps, 30 / fps,
    2, 5, 10, 15, 30, 60, 120, 300, 600,
  ];
  const pick = (minPx) => {
    for (const s of cands) if (s * pxPerSec >= minPx) return s;
    return cands[cands.length - 1];
  };
  const major = pick(74);
  const minor = pick(9);
  const framePx = pxPerSec / fps;
  return {
    major,
    minor,
    framePx,
    frameTicks: framePx >= 9,
    minorIsFrame: minor < 1 - 1e-9,
    majorIsFrame: major < 1 - 1e-9,
  };
}

/** 刻度文字：>=1s 顯示整數秒，<1s 顯示兩位小數 */
export function formatTick(sec, step) {
  if (step < 1 - 1e-9) return `${sec.toFixed(2)}s`;
  if (step < 10) return `${Number.isInteger(sec) ? String(sec) : sec.toFixed(1)}s`;
  return `${Math.round(sec)}s`;
}

/** 事件結束時間；無有效 duration 者視為瞬時（佔用 minInstantSec 的寬度以便分列） */
export function eventEnd(ev, minInstantSec = 0, timing = null) {
  if (!ev) return 0;
  const at = eventStartSec(ev, timing) ?? 0;
  const d = eventDurationSec(ev, timing);
  if (Number.isFinite(d) && d > 0) return at + d;
  return at + (minInstantSec || 0);
}

/**
 * 軌道分列：同類型同列重疊時自動往下一子列排。
 * opts.allTypes = true 時，即使某類型沒有事件也會保留一列（面板用，方便看出有哪些軌道）。
 * opts.timing = settings（或 beatTimingOf 結果）：有 bpm 時 `at` / `duration`
 * 可以是拍點字串（SPEC-EXPR-V2 §2）；沒有 timing 時只有數字（與舊行為相容）。
 * 回傳 { groups: [{ type, y, h, laneCount, items: [{ ev, id, type, lane, y, groupY }] }], height, rowHeight }
 * 純函式、不碰 DOM，方便測試。
 */
export function layoutTracks(events, opts = {}) {
  const rowHeight = opts.rowHeight != null ? opts.rowHeight : ROW_H;
  const groupGap = opts.groupGap != null ? opts.groupGap : GROUP_GAP;
  const padTop = opts.padTop != null ? opts.padTop : PAD_TOP;
  const minInstantSec = opts.minInstantSec != null ? opts.minInstantSec : 1 / FPS;
  const order = opts.order || TRACK_ORDER;
  const allTypes = !!opts.allTypes;
  const timing = opts.timing ? normalizeTiming(opts.timing) : null;

  const list = Array.isArray(events) ? events : [];
  const buckets = new Map();
  for (const ev of list) {
    if (!ev || typeof ev !== 'object') continue;
    const start = eventStartSec(ev, timing);
    if (start === null || !Number.isFinite(start)) continue;
    const type = typeof ev.type === 'string' && ev.type ? ev.type : 'unknown';
    if (!buckets.has(type)) buckets.set(type, []);
    buckets.get(type).push({ ev, start });
  }

  const known = allTypes ? order.slice() : order.filter((t) => buckets.has(t));
  const unknown = [...buckets.keys()].filter((t) => !order.includes(t)).sort();
  const groups = [];
  let y = padTop;

  for (const type of known.concat(unknown)) {
    const evs = (buckets.get(type) || []).slice().sort((a, b) => {
      const d = a.start - b.start;
      if (d) return d;
      return String(a.ev.id == null ? '' : a.ev.id).localeCompare(String(b.ev.id == null ? '' : b.ev.id));
    });
    const laneEnds = [];
    const items = [];
    for (const entry of evs) {
      const ev = entry.ev;
      const start = entry.start;
      let lane = -1;
      for (let i = 0; i < laneEnds.length; i++) {
        if (start >= laneEnds[i] - 1e-9) { lane = i; break; }
      }
      if (lane < 0) { lane = laneEnds.length; laneEnds.push(-Infinity); }
      laneEnds[lane] = Math.max(laneEnds[lane], eventEnd(ev, minInstantSec, timing));
      items.push({ ev, id: ev.id, type, lane, y: 0, groupY: y, start });
    }
    const laneCount = Math.max(1, laneEnds.length);
    for (const it of items) it.y = y + it.lane * rowHeight;
    groups.push({ type, y, h: laneCount * rowHeight, laneCount, items });
    y += laneCount * rowHeight + groupGap;
  }

  const height = groups.length ? y - groupGap + padTop : padTop * 2;
  return { groups, height, rowHeight };
}

/** 由後往前找（後畫的在上面） */
export function hitTestRects(rects, x, y) {
  if (!Array.isArray(rects)) return null;
  for (let i = rects.length - 1; i >= 0; i--) {
    const r = rects[i];
    if (!r) continue;
    if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return r;
  }
  return null;
}

/**
 * B15：帶垂直容差的命中測試。
 * 先在實際矩形內找；找不到時，找「水平落在矩形內、垂直距離 ≤ pad」且最近的矩形。
 * 這樣點在 bar 上緣／下緣外 1–4px 仍會選中事件，而不是變成框選並清空選取。
 * @param {Array} rects 命中區
 * @param {number} x 畫布 x
 * @param {number} y 畫布 y
 * @param {number} pad 垂直容差（CSS px）
 */
export function hitTestTolerant(rects, x, y, pad = 4) {
  const exact = hitTestRects(rects, x, y);
  if (exact) return exact;
  if (!Array.isArray(rects)) return null;
  const limit = Number.isFinite(pad) ? Math.max(0, pad) : 0;
  let best = null;
  let bestDy = Infinity;
  for (const r of rects) {
    if (!r) continue;
    if (x < r.x || x > r.x + r.w) continue;
    let dy = 0;
    if (y < r.y) dy = r.y - y;
    else if (y > r.y + r.h) dy = y - (r.y + r.h);
    if (dy <= limit && dy < bestDy) { best = r; bestDy = dy; }
  }
  return best;
}

/**
 * B9：新增事件選單定位（純函式，方便測試）。
 * 座標系是 .tl-root 內部的 CSS px；root 是 .tl-root 的可視尺寸。
 * 規則：
 *   1. 優先在點擊點「下方」（top = 點擊 y + gap）；下方放不下才往上開。
 *   2. 兩邊都放不下時，往空間較大的一邊開，並把選單高度限制在該側空間內，
 *      所以選單永遠不會覆蓋點擊點本身（會被 .tl-root 的 overflow:hidden 裁掉的情況也一併避免）。
 *   3. 水平以點擊 x 為錨，夾在面板內。
 * 回傳 { left, top, maxHeight, placement }，placement 為 'below' | 'above'。
 */
export function placeTimelineMenu(opts = {}) {
  const point = opts.point || { x: 0, y: 0 };
  const root = opts.root || { w: 0, h: 0 };
  const menu = opts.menu || { w: 180, h: 240 };
  const gap = opts.gap != null ? opts.gap : 6;
  const margin = opts.margin != null ? opts.margin : 4;
  const maxMenuHeight = opts.maxMenuHeight != null ? opts.maxMenuHeight : 280;
  const py = Number(point.y) || 0;
  const px = Number(point.x) || 0;
  const rw = Math.max(1, Number(root.w) || 0);
  const rh = Math.max(1, Number(root.h) || 0);
  const mw = Math.max(1, Number(menu.w) || 0);
  const naturalH = Math.max(1, Number(menu.h) || 0);

  const spaceBelow = Math.max(0, rh - margin - (py + gap));
  const spaceAbove = Math.max(0, py - gap - margin);

  let placement;
  let maxHeight;
  if (naturalH <= spaceBelow) {
    placement = 'below';
    maxHeight = Math.min(naturalH, maxMenuHeight);
  } else if (naturalH <= spaceAbove) {
    placement = 'above';
    maxHeight = Math.min(naturalH, maxMenuHeight);
  } else {
    placement = spaceBelow >= spaceAbove ? 'below' : 'above';
    const sideSpace = placement === 'below' ? spaceBelow : spaceAbove;
    maxHeight = Math.min(maxMenuHeight, Math.max(1, sideSpace));
  }

  const mh = Math.max(1, Math.min(naturalH, maxHeight));
  const topRaw = placement === 'below' ? py + gap : py - gap - mh;
  return {
    left: clamp(px, margin, Math.max(margin, rw - mw - margin)),
    top: clamp(topRaw, 0, Math.max(0, rh - mh)),
    maxHeight: Math.max(1, maxHeight),
    placement,
  };
}

/** 兩點 → 正規化矩形 { x, y, w, h } */
export function normBox(a, b) {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

export function rectsIntersect(a, b) {
  return a.x <= b.x + b.w && b.x <= a.x + a.w && a.y <= b.y + b.h && b.y <= a.y + a.h;
}

/** 框選命中的 rect（去重依 id） */
export function rectsInBox(rects, box) {
  const out = [];
  const seen = new Set();
  for (const r of rects || []) {
    if (!r || !r.id || seen.has(r.id)) continue;
    if (rectsIntersect(box, r)) { seen.add(r.id); out.push(r); }
  }
  return out;
}

/**
 * 以 anchorX 為中心縮放；回傳新的 { pxPerSec, scrollSec }（未經邊界夾取）。
 * 保證 anchorX 底下的時間點不變。
 */
export function zoomAt(opts = {}) {
  const gutter = opts.gutter != null ? opts.gutter : GUTTER;
  const min = opts.min != null ? opts.min : MIN_ZOOM;
  const max = opts.max != null ? opts.max : MAX_ZOOM;
  const pxPerSec = Math.max(1e-6, Number(opts.pxPerSec) || 1);
  const scrollSec = Number(opts.scrollSec) || 0;
  const anchorX = Number(opts.anchorX) || 0;
  const factor = Number(opts.factor) || 1;
  const next = clamp(pxPerSec * factor, min, max);
  const anchorTime = scrollSec + (anchorX - gutter) / pxPerSec;
  const nextScroll = anchorTime - (anchorX - gutter) / next;
  return { pxPerSec: next, scrollSec: nextScroll };
}

/** 水平捲動夾取：允許看到 duration 之後 0.5 秒 */
export function clampScroll(scrollSec, pxPerSec, viewWidth, gutter, duration) {
  const usable = Math.max(1, viewWidth - gutter - 8);
  const visible = usable / Math.max(1e-6, pxPerSec);
  const maxScroll = Math.max(0, (Number(duration) || 0) + 0.5 - visible);
  return clamp(Number(scrollSec) || 0, 0, maxScroll);
}

/** 「適合全部」：讓 duration 剛好塞進可用寬度 */
export function fitPxPerSec(viewWidth, gutter, duration, min = MIN_ZOOM, max = MAX_ZOOM) {
  const usable = Math.max(24, viewWidth - gutter - 28);
  return clamp(usable / Math.max(0.25, Number(duration) || 0), min, max);
}

/** 事件簡短摘要（label 優先） */
export function eventSummary(ev) {
  if (!ev) return '';
  if (typeof ev.label === 'string' && ev.label.trim()) return ev.label.trim();
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  switch (ev.type) {
    case 'spawn': {
      const b = ev.bullet || 'bullet';
      const c = num(ev.count);
      return c != null && c > 1 ? `${b}×${c}` : b;
    }
    case 'emitter': {
      const sp = ev.spawn || {};
      const b = sp.bullet || ev.bullet || 'bullet';
      const iv = num(ev.interval);
      const c = num(ev.count) || 1;
      return `${b} ${iv != null ? `${iv}s/` : ''}×${c}`;
    }
    case 'box': {
      const to = ev.to || {};
      const parts = [];
      for (const k of ['x', 'y', 'w', 'h', 'rotation']) {
        if (to[k] !== undefined && to[k] !== null) parts.push(`${k}:${fmtNum(to[k])}`);
      }
      return parts.length ? `→ ${parts.join(' ')}` : '→';
    }
    case 'soulProfile': return ev.profile || soulT('pick');
    case 'soulAppearance': return ev.appearance?.color || ev.appearance?.sprite || soulT('appearance');
    case 'soulTeleport': return '(' + ev.x + ', ' + ev.y + ')';
    case 'soulDrift': return (ev.dx || ev.dy) ? '→ (' + ev.dx + ', ' + ev.dy + ')' : '■';
    case 'soul':
      return ev.mode ? t('timeline.summary.mode', { mode: ev.mode }) : t('timeline.summary.soul');
    case 'clear':
      return num(ev.fade) != null
        ? t('timeline.summary.fade', { fade: ev.fade })
        : t('timeline.summary.clear');
    case 'shake':
      return `${num(ev.amount) != null ? ev.amount : 4}px ${num(ev.duration) != null ? ev.duration : 0}s`;
    case 'sfx':
      return ev.sound ? String(ev.sound) : t('timeline.summary.noSound');
    case 'anim':
      return String(ev.actor || '?') + ' / ' + String(ev.anim || '?');
    case 'end':
      return t('timeline.summary.end');
    default:
      return String(ev.type || '?');
  }
}

function fmtNum(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100);
  return String(v);
}

/** 找 attack 裡可用的第一個子彈類型名 */
export function firstBulletName(attack) {
  const bt = attack && attack.bulletTypes;
  if (bt && typeof bt === 'object') {
    const keys = Object.keys(bt);
    if (keys.length) return keys[0];
  }
  return 'bullet';
}

let _fallbackId = 0;

/**
 * 建立某類型事件的合理預設值。
 * opts: { newId(prefix) → id, attack, sfxName }
 */
export function createDefaultEvent(type, at, opts = {}) {
  const newId = typeof opts.newId === 'function'
    ? opts.newId
    : (prefix) => `${prefix}-${Date.now().toString(36)}-${(_fallbackId++).toString(36)}`;
  const attack = opts.attack || {};
  const atR = roundTime(Math.max(0, Number(at) || 0));
  const id = newId(type);
  const bullet = firstBulletName(attack);
  const srcBox = attack.box && typeof attack.box === 'object' ? attack.box : {};
  const bx = numOr(srcBox.x, BOX_DEFAULTS.x);
  const by = numOr(srcBox.y, BOX_DEFAULTS.y);
  const bw = numOr(srcBox.w, BOX_DEFAULTS.w);
  const bh = numOr(srcBox.h, BOX_DEFAULTS.h);
  const base = { id, at: atR, type };

  switch (type) {
    case 'spawn':
      return { ...base, bullet, count: 1, x: bx, y: by, speed: 4, angle: 90 };
    case 'emitter':
      return {
        ...base,
        duration: 2,
        interval: 0.2,
        count: 1,
        spawn: { bullet, x: bx, y: by, speed: 3, angle: 90 },
      };
    case 'box':
      return { ...base, duration: 1, ease: 'linear', to: { x: bx, y: by, w: bw, h: bh } };
    case 'soulProfile': return { ...base, profile: attack.soul?.profile ?? Object.keys(attack.soulProfiles ?? {})[0] };
    case 'soulAppearance': return { ...base, appearance: {} };
    case 'soulTeleport': return { ...base, x: bx, y: by };
    case 'soul':
      return { ...base, mode: (attack.soul && attack.soul.mode) || 'red' };
    case 'clear':
      return { ...base, fade: 0.2 };
    case 'shake':
      return { ...base, duration: 0.4, amount: 4 };
    case 'sfx':
      return { ...base, sound: opts.sfxName || '' };
    case 'anim':
      return { ...base, actor: '', anim: '' };
    case 'end':
      return { ...base };
    default:
      return { ...base, label: type };
  }
}

function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 深拷貝事件（事件皆為 JSON 安全物件） */
export function cloneEvent(ev) {
  try {
    return JSON.parse(JSON.stringify(ev));
  } catch (err) {
    return { ...ev };
  }
}

/* ------------------------------------------------------------------ *
 * 繪圖小工具
 * ------------------------------------------------------------------ */

function rr(g, x, y, w, h, r) {
  const rad = Math.min(r || 0, Math.abs(w) / 2, Math.abs(h) / 2);
  if (rad <= 0.5) { g.rect(x, y, w, h); return; }
  g.beginPath();
  g.moveTo(x + rad, y);
  g.lineTo(x + w - rad, y);
  g.arcTo(x + w, y, x + w, y + rad, rad);
  g.lineTo(x + w, y + h - rad);
  g.arcTo(x + w, y + h, x + w - rad, y + h, rad);
  g.lineTo(x + rad, y + h);
  g.arcTo(x, y + h, x, y + h - rad, rad);
  g.lineTo(x, y + rad);
  g.arcTo(x, y, x + rad, y, rad);
  g.closePath();
}

/** HTML 轉義（選單字串來自語系檔，仍一律轉義） */
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function fitText(g, text, maxW) {
  if (!text) return '';
  if (maxW <= 6) return '';
  if (g.measureText(text).width <= maxW) return text;
  let t = String(text);
  while (t.length > 1 && g.measureText(`${t}…`).width > maxW) t = t.slice(0, -1);
  return t.length > 1 ? `${t}…` : '';
}

function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return `rgba(148,163,184,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const FONT_10 = '10px "Courier New", "Consolas", monospace';
const FONT_11 = '11px "Courier New", "Consolas", monospace';
const FONT_9 = '9px "Courier New", "Consolas", monospace';

function fmtDur(d) {
  const n = Number(d) || 0;
  return `${(Number.isInteger(n) ? n.toFixed(1) : n.toFixed(2))}s`;
}

/* ------------------------------------------------------------------ *
 * CSS 注入（ED1 未用 <link> 引入 timeline.css 時的後備）
 * ------------------------------------------------------------------ */

function ensureStyles() {
  if (typeof document === 'undefined') return;
  const exists = document.querySelector(
    'link[data-editor-timeline-css], link[href$="timeline.css"]',
  );
  if (exists) return;
  try {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./timeline.css', import.meta.url).href;
    link.dataset.editorTimelineCss = '1';
    document.head.appendChild(link);
  } catch (err) {
    console.warn('[timeline] 無法自動注入 timeline.css', err);
  }
}

/* ------------------------------------------------------------------ *
 * mount
 * ------------------------------------------------------------------ */

export function mount(rootEl, ctx) {
  if (!rootEl) throw new Error('[timeline] mount 需要 rootEl');
  const store = ctx && ctx.store;
  if (!store) throw new Error('[timeline] mount 需要 ctx.store');
  const preview = (ctx && ctx.preview) || null;
  const assets = (ctx && ctx.assets) || null;

  ensureStyles();

  /* ---------- DOM ---------- */
  rootEl.classList.add('tl-root');
  if (!rootEl.hasAttribute('tabindex')) rootEl.tabIndex = -1;
  rootEl.innerHTML = `
    <div class="tl-toolbar">
      <button class="tl-btn" type="button" data-act="fit" data-i18n-title="timeline.btn.fitTitle"></button>
      <button class="tl-btn tl-btn-icon" type="button" data-act="zoomout" data-i18n-title="timeline.btn.zoomOutTitle" data-i18n-aria-label="timeline.btn.zoomOut">−</button>
      <button class="tl-btn tl-btn-icon" type="button" data-act="zoomin" data-i18n-title="timeline.btn.zoomInTitle" data-i18n-aria-label="timeline.btn.zoomIn">＋</button>
      <span class="tl-sep"></span>
      <span class="tl-time" data-role="time">0.00s / 0.00s</span>
      <span class="tl-sep"></span>
      <span class="tl-zoom" data-role="zoom">100 px/s</span>
      <span class="tl-hint" data-role="hint"></span>
    </div>
    <div class="tl-rulerwrap"><canvas class="tl-ruler" tabindex="-1"></canvas></div>
    <div class="tl-trackswrap"><canvas class="tl-tracks" tabindex="-1"></canvas></div>
    <div class="tl-scrollfade" data-role="fade" aria-hidden="true" hidden></div>
    <div class="tl-menu" role="menu"></div>
  `;
  const $ = (sel) => rootEl.querySelector(sel);
  const toolbar = $('.tl-toolbar');
  const rulerWrap = $('.tl-rulerwrap');
  const tracksWrap = $('.tl-trackswrap');
  const rulerCanvas = $('.tl-ruler');
  const trackCanvas = $('.tl-tracks');
  const menuEl = $('.tl-menu');
  const fadeEl = $('[data-role="fade"]');
  const timeEl = $('[data-role="time"]');
  const zoomEl = $('[data-role="zoom"]');
  const hintEl = $('[data-role="hint"]');
  const fitBtn = $('[data-act="fit"]');
  const rulerCtx = rulerCanvas.getContext('2d');
  const trackCtx = trackCanvas.getContext('2d');

  /** 把目前語系的字串套到靜態 DOM（掛載時與換語系時各跑一次） */
  function applyStaticStrings() {
    if (fitBtn) fitBtn.textContent = t('timeline.btn.fit');
    if (hintEl) {
      // V2-06：有 bpm 時提示改成「預設吸附拍線、Shift 暫時關閉」
      const settings = store && store.attack ? store.attack.settings : null;
      const hasBpm = !!settings && normalizeTiming(settings).hasBpm;
      const hint = t(hasBpm ? 'timeline.hintBeats' : 'timeline.hint');
      hintEl.textContent = hint;
      // 窄視窗時提示會被省略號截斷：滑過去看完整內容
      hintEl.title = hint;
    }
    if (timeEl) timeEl.textContent = t('timeline.readout', { sec: '0.00', dur: '0.00', frame: 0 });
    for (const btn of rootEl.querySelectorAll('[data-i18n-title]')) {
      btn.title = t(btn.dataset.i18nTitle);
    }
    for (const btn of rootEl.querySelectorAll('[data-i18n-aria-label]')) {
      btn.setAttribute('aria-label', t(btn.dataset.i18nAriaLabel));
    }
    menuEl.setAttribute('aria-label', t('timeline.menu.aria'));
    menuEl.innerHTML = TRACK_TYPES.map((tt) => {
      const parts = menuItemParts(tt.type);
      return `
      <button class="tl-menu-item" type="button" role="menuitem" data-type="${tt.type}" title="${esc(parts.title)}">
        <span class="tl-dot" style="background:${tt.color}"></span>
        <span class="tl-menu-name">${esc(parts.name)}</span><span class="tl-menu-id">${esc(parts.id)}</span>
        <span class="tl-menu-sub">${esc(parts.desc)}</span>
      </button>`;
    }).join('');
  }
  applyStaticStrings();

  /* ---------- 狀態 ---------- */
  const view = { scrollSec: 0, pxPerSec: 120, gutter: GUTTER };
  let sel = new Set();
  let primaryId = null;
  let curFrame = 0;
  let layout = { groups: [], height: 0, rowHeight: ROW_H };
  let hitRects = [];        // 事件與 duration 的命中區（畫布座標）
  let rulerHits = [];
  let errIds = new Set();
  let drag = null;
  let needFit = true;
  let rafId = 0;
  let viewW = 0;
  let viewH = 0;
  let menuOpen = false;
  let menuSec = 0;
  let session = 0;
  let lastManualScrollAt = -1e9;
  let flashTimer = 0;
  let destroyed = false;

  const ac = new AbortController();
  const sig = ac.signal;
  const on = (el, type, fn, opts) => el.addEventListener(type, fn, { ...(opts || {}), signal: sig });

  /* ---------- 資料存取 ---------- */
  const attackOf = () => (store && store.attack) || {};
  const eventsOf = () => {
    const a = attackOf();
    return Array.isArray(a.timeline) ? a.timeline : [];
  };
  const durationSec = () => {
    const a = attackOf();
    const d = a.settings && a.settings.duration;
    // settings.duration 可為秒數或拍點字串（SPEC-EXPR-V2 §2）
    if (typeof d === 'string') {
      const sec = timeLengthSeconds(d, timingOf(), 0);
      if (Number.isFinite(sec) && sec > 0) return sec;
    } else if (Number.isFinite(d) && d > 0) {
      return d;
    }
    if (preview && typeof preview.duration === 'function') {
      const pd = preview.duration();
      if (Number.isFinite(pd) && pd > 0) return pd;
    }
    return DEFAULT_DURATION;
  };
  /** 目前文件的拍點設定（settings.bpm / beatOffset）；供時間解析與拍線共用 */
  const timingOf = () => {
    const a = attackOf();
    return normalizeTiming(a.settings || null);
  };
  /** 事件在畫布上的起點（秒）；字串時間會被解析，無法解析回 null */
  const startOf = (ev) => eventStartSec(ev, timingOf());
  const durOf = (ev) => eventDurationSec(ev, timingOf());
  const byId = (list, id) => list.find((e) => e && e.id === id) || null;

  function applyUpdate(fn, opts) {
    if (typeof store.update !== 'function' || destroyed) return;
    try {
      store.update(fn, opts || {});
    } catch (err) {
      console.error('[timeline] store.update 失敗', err);
    }
  }

  function nextKey(kind) {
    session += 1;
    return `tl-${kind}-${session}`;
  }

  /* ---------- 尺寸 / 高 DPI ---------- */
  function fitCanvas(cv, cssW, cssH, ctx2d) {
    const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
    const w = Math.max(1, Math.round(cssW * dpr));
    const h = Math.max(1, Math.round(cssH * dpr));
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    cv.style.width = `${cssW}px`;
    cv.style.height = `${cssH}px`;
    ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    return ctx2d;
  }

  /* ---------- 選取 ---------- */
  /** 面板主動改寫 store.selection 時，暫停「store → 面板」的選取回寫，避免互相覆蓋 */
  let localSelLock = 0;
  function withLocalSelLock(fn) {
    localSelLock += 1;
    try { return fn(); } finally { localSelLock -= 1; }
  }

  /** 把面板當下選取寫回 store.selection（store 只認主要選取） */
  function syncSelectionToStore() {
    if (typeof store.select !== 'function') return;
    withLocalSelLock(() => {
      if (primaryId) store.select('event', primaryId);
      else store.select(null, null);
    });
  }

  function setSelection(next, primary, notify = true) {
    sel = next instanceof Set ? next : new Set(next || []);
    primaryId = primary && sel.has(primary) ? primary : ([...sel][0] || null);
    if (notify) syncSelectionToStore();
    scheduleRender();
  }

  function pruneSelection() {
    const ids = new Set(eventsOf().map((e) => e && e.id));
    let changed = false;
    for (const id of [...sel]) {
      if (!ids.has(id)) { sel.delete(id); changed = true; }
    }
    if (primaryId && !ids.has(primaryId)) {
      primaryId = [...sel][0] || null;
      changed = true;
    }
    return changed;
  }

  /**
   * B5：雙擊事件後把檢查器捲回頂端並短暫高亮，
   * 讓「選取」與「檢查器看到的事件」在同一個視線範圍內。
   */
  function focusInspectorPanel() {
    if (typeof document === 'undefined') return;
    try {
      const body = document.getElementById('inspector-body');
      if (!body) return;
      body.scrollTop = 0;
      body.classList.remove('is-flash');
      // 強制回流，讓同一個事件連按兩次也能重播動畫
      void body.offsetWidth;
      body.classList.add('is-flash');
      if (flashTimer) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => {
        flashTimer = 0;
        body.classList.remove('is-flash');
      }, 900);
    } catch (err) {
      /* 忽略：沒有檢查器面板時只做選取 */
    }
  }

  /* ---------- 錯誤對照（store.errors：事件 id 或 JSON 路徑） ---------- */
  function rebuildErrors() {
    errIds = new Set();
    const errs = store.errors;
    if (!errs) return;
    const tl = eventsOf();
    const mark = (key) => {
      if (typeof key !== 'string') return;
      const m = /^timeline\[(\d+)\]/.exec(key);
      if (m) {
        const ev = tl[Number(m[1])];
        if (ev && ev.id) errIds.add(ev.id);
        return;
      }
      if (key.startsWith('timeline') && !key.includes('[')) return;
      if (tl.some((ev) => ev && ev.id === key)) errIds.add(key);
    };
    if (typeof errs.forEach === 'function') errs.forEach((_v, k) => mark(k));
    else if (typeof errs === 'object') for (const k of Object.keys(errs)) mark(k);
  }

  /* ---------- 繪製 ---------- */
  function scheduleRender() {
    if (destroyed || rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }

  function render() {
    if (destroyed) return;
    const W = trackCanvas.parentElement ? tracksWrap.clientWidth : 0;
    const H0 = tracksWrap.clientHeight;
    if (!W || !H0) return;
    viewW = W;
    viewH = H0;
    const dur = durationSec();
    if (needFit) {
      view.pxPerSec = fitPxPerSec(W, view.gutter, dur, MIN_ZOOM, MAX_ZOOM);
      view.scrollSec = 0;
      needFit = false;
    }
    view.scrollSec = clampScroll(view.scrollSec, view.pxPerSec, W, view.gutter, dur);

    const tl = eventsOf();
    layout = layoutTracks(tl, {
      rowHeight: ROW_H,
      groupGap: GROUP_GAP,
      padTop: PAD_TOP,
      minInstantSec: 1 / FPS,
      allTypes: true,          // 八種軌道一律顯示，方便看出有哪些類型
      timing: timingOf(),      // 有 bpm 時 `at` / `duration` 可為拍點字串
    });
    rebuildErrors();

    const contentH = Math.max(layout.height, H0);
    fitCanvas(trackCanvas, W, contentH, trackCtx);
    // 尺的可用寬度以它自己的容器為準（軌道區出現垂直捲軸時會少約 10px）
    const rulerW = Math.max(1, rulerWrap.clientWidth || W);
    fitCanvas(rulerCanvas, rulerW, RULER_H, rulerCtx);

    hitRects = [];
    rulerHits = [];
    drawTracks(trackCtx, W, contentH, dur);
    drawRuler(rulerCtx, rulerW, dur);
    updateReadout(dur);
    updateScrollFade();
  }

  /** B16：內容超出面板時，在軌道區底部顯示淡出漸層提示（捲到底就隱藏） */
  function updateScrollFade() {
    if (!fadeEl) return;
    const wrapH = tracksWrap.clientHeight;
    const scrollable = tracksWrap.scrollHeight > wrapH + 1;
    const atEnd = tracksWrap.scrollTop + wrapH >= tracksWrap.scrollHeight - 2;
    const show = scrollable && !atEnd;
    fadeEl.hidden = !show;
    if (!show) return;
    // 漸層只蓋內容，不蓋垂直捲軸
    const sbw = Math.max(0, tracksWrap.offsetWidth - tracksWrap.clientWidth);
    fadeEl.style.right = `${Math.round(sbw)}px`;
  }

  let hintHasBpm = null;
  /** V2-06：bpm 開／關時切換提示文字（不必整份重繪選單） */
  function syncHint() {
    if (!hintEl) return;
    const settings = store && store.attack ? store.attack.settings : null;
    const hasBpm = !!settings && normalizeTiming(settings).hasBpm;
    if (hintHasBpm === hasBpm) return;
    hintHasBpm = hasBpm;
    const hint = t(hasBpm ? 'timeline.hintBeats' : 'timeline.hint');
    hintEl.textContent = hint;
    hintEl.title = hint;
  }

  function updateReadout(dur) {
    const sec = curFrame / FPS;
    const timing = timingOf();
    syncHint();
    const pos = beatPosition(sec, timing);
    // V2-06：狀態列同時顯示「秒 / 第幾拍」
    const label = pos
      ? t('timeline.readoutBeats', {
        sec: sec.toFixed(2),
        dur: dur.toFixed(2),
        frame: Math.round(sec * FPS),
        beat: pos.beat,
        beatFrac: pos.fraction.toFixed(2).slice(1),
      })
      : t('timeline.readout', {
        sec: sec.toFixed(2),
        dur: dur.toFixed(2),
        frame: Math.round(sec * FPS),
      });
    if (timeEl.textContent !== label) timeEl.textContent = label;
    const tb = totalBeats(dur, timing);
    const z = tb ? `${Math.round(view.pxPerSec)} px/s · ${Math.round(tb * 100) / 100} ${t('timeline.beatUnit')}` : `${Math.round(view.pxPerSec)} px/s`;
    if (zoomEl.textContent !== z) zoomEl.textContent = z;
  }

  /** V2-06：拍線（每拍細線、每 4 拍粗線，跟隨縮放） */
  function drawBeats(g, W, H, timing) {
    if (!timing || !timing.hasBpm) return;
    const t0 = xToTime(view.gutter, view);
    const t1 = xToTime(W, view);
    const beats = beatTimes(timing, t0, t1, { majorEvery: BEAT_MAJOR_EVERY, limit: 4096 });
    if (!beats.length) return;
    for (const b of beats) {
      const x = Math.round(timeToX(b.sec, view)) + 0.5;
      if (x < view.gutter || x > W) continue;
      // 顏色要能在 #0a0a11 背景上看得出來（細線淡、粗線明顯，跟隨縮放不變粗）
      g.strokeStyle = b.major ? 'rgba(120,220,255,0.6)' : 'rgba(120,220,255,0.28)';
      g.lineWidth = b.major ? 1.5 : 1;
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
    }
  }

  function drawGrid(g, W, H, ticks) {
    const t0 = xToTime(view.gutter, view);
    const t1 = xToTime(W, view);
    const i0 = Math.floor(t0 / ticks.minor) - 1;
    const i1 = Math.ceil(t1 / ticks.minor) + 1;
    g.lineWidth = 1;
    for (let i = i0; i <= i1; i++) {
      const t = i * ticks.minor;
      if (t < -1e-9) continue;
      const x = Math.round(timeToX(t, view)) + 0.5;
      if (x < view.gutter || x > W) continue;
      const isMajor = Math.abs(t / ticks.major - Math.round(t / ticks.major)) < 1e-6;
      g.strokeStyle = isMajor ? 'rgba(255,255,255,0.075)' : 'rgba(255,255,255,0.032)';
      g.beginPath();
      g.moveTo(x, 0);
      g.lineTo(x, H);
      g.stroke();
    }
  }

  function drawTracks(g, W, H, dur) {
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#0a0a11';
    g.fillRect(0, 0, W, H);

    const ticks = chooseTicks(view.pxPerSec, FPS);
    const endX = timeToX(dur, view);

    // 內容區（避開左側類型欄）
    g.save();
    g.beginPath();
    g.rect(view.gutter, 0, Math.max(0, W - view.gutter), H);
    g.clip();

    // duration 之後的暗區
    if (endX < W) {
      const x0 = Math.max(view.gutter, endX);
      g.fillStyle = 'rgba(255,92,122,0.05)';
      g.fillRect(x0, 0, W - x0, H);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect(x0, 0, W - x0, H);
    }

    drawGrid(g, W, H, ticks);
    drawBeats(g, W, H, timingOf());

    // 事件
    const summaryCache = new Map();
    for (const grp of layout.groups) {
      const meta = TYPE_META.get(grp.type) || unknownMeta();
      const items = grp.items;
      // 先算 x，供標籤寬度避讓使用
      const xs = items.map((it) => timeToX(it.start != null ? it.start : (startOf(it.ev) ?? 0), view));
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const ev = it.ev;
        const x = xs[i];
        const selected = sel.has(ev.id);
        const hasErr = errIds.has(ev.id);
        const evDur = durOf(ev);
        const isDur = evDur > 0;
        const cy = it.y + ROW_H / 2;
        if (!summaryCache.has(ev.id)) summaryCache.set(ev.id, eventSummary(ev));

        if (isDur) {
          const w = Math.max(3, evDur * view.pxPerSec);
          const bx = Math.max(x, view.gutter - 2);
          const bw = Math.max(3, x + w - bx);
          const by = it.y + 3;
          const bh = ROW_H - 6;
          rr(g, bx, by, bw, bh, 3);
          g.globalAlpha = selected ? 1 : 0.82;
          g.fillStyle = meta.color;
          g.fill();
          g.globalAlpha = 1;
          // 內部標籤
          if (bw >= 30) {
            g.fillStyle = '#0a0a11';
            g.font = FONT_10;
            g.textAlign = 'left';
            g.textBaseline = 'middle';
            const label = fitText(g, summaryCache.get(ev.id), bw - 10);
            if (label) g.fillText(label, bx + 5, cy + 0.5);
          }
          if (hasErr) {
            rr(g, bx - 1, by - 1, bw + 2, bh + 2, 4);
            g.strokeStyle = '#ff4b4b';
            g.lineWidth = 2;
            g.stroke();
          } else if (selected) {
            // B15：選取中的事件條要有明顯外框（2px 亮黃）
            rr(g, bx - 2, by - 2, bw + 4, bh + 4, 4);
            g.strokeStyle = '#ffd93d';
            g.lineWidth = 2;
            g.stroke();
            // 右緣把手
            g.fillStyle = 'rgba(255,255,255,0.9)';
            g.fillRect(bx + bw - 3, by + 2, 2, bh - 4);
          }
          hitRects.push({
            kind: 'event', id: ev.id, type: grp.type,
            x: bx, y: it.y + 1, w: Math.max(bw, 6), h: ROW_H - 2,
            edge: true, right: bx + bw, durPx: bw,
          });
        } else {
          if (x > W + 12 || x < view.gutter - 24) {
            hitRects.push({
              kind: 'event', id: ev.id, type: grp.type,
              x: x - 7, y: it.y + 1, w: 14, h: ROW_H - 2, edge: false, right: x + 7,
            });
            continue;
          }
          const r = 5.5;
          g.beginPath();
          g.moveTo(x, cy - r);
          g.lineTo(x + r, cy);
          g.lineTo(x, cy + r);
          g.lineTo(x - r, cy);
          g.closePath();
          g.fillStyle = meta.color;
          g.fill();
          if (hasErr) {
            g.strokeStyle = '#ff4b4b';
            g.lineWidth = 2;
            g.stroke();
          } else if (selected) {
            // B15：選取中的（瞬時）事件也要有明顯外框（2px 亮黃）
            g.strokeStyle = '#ffd93d';
            g.lineWidth = 2;
            g.stroke();
          }
          // 標籤（往右，遇到下一個事件就截斷）
          let maxW = W - (x + 9) - 6;
          if (i + 1 < items.length) maxW = Math.min(maxW, xs[i + 1] - x - 12);
          maxW = Math.min(maxW, 170);
          g.font = FONT_10;
          const label = fitText(g, summaryCache.get(ev.id), maxW);
          if (label) {
            g.textAlign = 'left';
            g.textBaseline = 'middle';
            g.fillStyle = selected ? '#ffffff' : 'rgba(206,210,226,0.86)';
            g.fillText(label, x + 9, cy);
          }
          hitRects.push({
            kind: 'event', id: ev.id, type: grp.type,
            x: x - 7, y: it.y + 1, w: 14, h: ROW_H - 2, edge: false, right: x + 7,
          });
        }
      }
    }

    // 群組列背景 / 分隔線
    for (const grp of layout.groups) {
      g.strokeStyle = 'rgba(255,255,255,0.05)';
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(view.gutter, Math.round(grp.y + grp.h) + 0.5);
      g.lineTo(W, Math.round(grp.y + grp.h) + 0.5);
      g.stroke();
    }

    // 吸附導引線
    if (drag && drag.kind !== 'marquee' && Number.isFinite(drag.snapTime)) {
      const sx = Math.round(timeToX(drag.snapTime, view)) + 0.5;
      g.strokeStyle = 'rgba(255,217,61,0.75)';
      g.setLineDash([4, 3]);
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(sx, 0);
      g.lineTo(sx, H);
      g.stroke();
      g.setLineDash([]);
    }

    // 框選
    if (drag && drag.kind === 'marquee' && drag.cur) {
      const b = normBox(drag.start, drag.cur);
      if (b.w > 2 || b.h > 2) {
        g.fillStyle = 'rgba(76,201,240,0.13)';
        g.fillRect(b.x, b.y, b.w, b.h);
        g.strokeStyle = 'rgba(76,201,240,0.85)';
        g.lineWidth = 1;
        g.strokeRect(Math.round(b.x) + 0.5, Math.round(b.y) + 0.5, Math.round(b.w), Math.round(b.h));
      }
    }

    // duration 線（畫在事件之後，讓它在空白處仍可抓；命中區順序見下）
    if (endX >= view.gutter - 2 && endX <= W) {
      g.strokeStyle = 'rgba(255,92,122,0.85)';
      g.lineWidth = 2;
      g.setLineDash([6, 4]);
      g.beginPath();
      g.moveTo(Math.round(endX) + 0.5, 0);
      g.lineTo(Math.round(endX) + 0.5, H);
      g.stroke();
      g.setLineDash([]);
    }
    g.restore();

    // 左側類型欄
    g.fillStyle = '#0d0d16';
    g.fillRect(0, 0, view.gutter, H);
    g.strokeStyle = '#22223a';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(view.gutter + 0.5, 0);
    g.lineTo(view.gutter + 0.5, H);
    g.stroke();

    for (const grp of layout.groups) {
      const meta = TYPE_META.get(grp.type) || unknownMeta();
      g.fillStyle = meta.color;
      g.fillRect(4, grp.y + 3, 3, Math.max(6, grp.h - 6));
      g.textAlign = 'left';
      g.textBaseline = 'middle';
      g.font = FONT_11;
      g.fillStyle = meta.color;
      const name = fitText(g, meta.label, view.gutter - 40);
      g.fillText(name, 13, grp.y + ROW_H / 2);
      g.font = FONT_9;
      g.fillStyle = '#5b5c78';
      g.fillText(`×${grp.items.length}`, view.gutter - 26, grp.y + ROW_H / 2);
    }

    // 空狀態提示（完全沒有事件時）
    {
      const count = layout.groups.reduce((n, grp) => n + grp.items.length, 0);
      if (!count && H > 24) {
        g.textAlign = 'center';
        g.textBaseline = 'middle';
        g.font = FONT_11;
        g.fillStyle = 'rgba(141,142,168,0.55)';
        const midX = view.gutter + (W - view.gutter) / 2;
        g.fillText(t('timeline.empty'), midX, Math.min(H / 2, 70));
      }
    }

    // 游標
    const px = timeToX(curFrame / FPS, view);
    if (px >= view.gutter && px <= W) {
      g.strokeStyle = 'rgba(255,255,255,0.9)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(Math.round(px) + 0.5, 0);
      g.lineTo(Math.round(px) + 0.5, H);
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.9)';
      g.beginPath();
      g.moveTo(px - 4, 0);
      g.lineTo(px + 4, 0);
      g.lineTo(px, 6);
      g.closePath();
      g.fill();
    }

    // duration 命中區（先推 → 事件在後，事件優先）
    if (endX >= view.gutter - 6 && endX <= W + 6) {
      hitRects.unshift({ kind: 'duration', x: endX - 5, y: 0, w: 10, h: H });
    }
  }

  function drawRuler(g, W, dur) {
    g.clearRect(0, 0, W, RULER_H);
    g.fillStyle = '#0d0d16';
    g.fillRect(0, 0, W, RULER_H);

    const ticks = chooseTicks(view.pxPerSec, FPS);
    const endX = timeToX(dur, view);

    g.save();
    g.beginPath();
    g.rect(view.gutter, 0, Math.max(0, W - view.gutter), RULER_H);
    g.clip();

    if (endX < W) {
      g.fillStyle = 'rgba(255,92,122,0.06)';
      g.fillRect(Math.max(view.gutter, endX), 0, W - Math.max(view.gutter, endX), RULER_H);
    }

    const t0 = xToTime(view.gutter, view);
    const t1 = xToTime(W, view);
    const i0 = Math.floor(t0 / ticks.minor) - 1;
    const i1 = Math.ceil(t1 / ticks.minor) + 1;

    for (let i = i0; i <= i1; i++) {
      const tick = i * ticks.minor;
      if (tick < -1e-9) continue;
      const x = Math.round(timeToX(tick, view)) + 0.5;
      if (x < view.gutter || x > W) continue;
      const isMajor = Math.abs(tick / ticks.major - Math.round(tick / ticks.major)) < 1e-6;
      if (isMajor) {
        g.strokeStyle = '#42425e';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, 11);
        g.lineTo(x, RULER_H);
        g.stroke();
        g.font = FONT_10;
        g.fillStyle = '#8d8ea8';
        g.textAlign = 'left';
        g.textBaseline = 'alphabetic';
        g.fillText(formatTick(tick, ticks.major), x + 3, 20);
        if (ticks.major < 1 - 1e-9) {
          g.font = FONT_9;
          g.fillStyle = '#54556e';
          g.fillText(t('timeline.ruler.frameTick', { n: Math.round(tick * FPS) }), x + 3, 30);
        }
      } else {
        g.strokeStyle = '#27273a';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, RULER_H - 6);
        g.lineTo(x, RULER_H);
        g.stroke();
      }
    }
    g.restore();

    // 左欄
    g.fillStyle = '#10101b';
    g.fillRect(0, 0, view.gutter, RULER_H);
    g.strokeStyle = '#22223a';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(view.gutter + 0.5, 0);
    g.lineTo(view.gutter + 0.5, RULER_H);
    g.stroke();
    g.fillStyle = '#6f7089';
    g.font = FONT_10;
    g.textAlign = 'left';
    g.textBaseline = 'middle';
    g.fillText(t('timeline.ruler.secondsFrames'), 8, RULER_H / 2 - 5);
    g.fillStyle = '#4a4b62';
    g.fillText(t('timeline.ruler.frames', { n: Math.round(dur * FPS) }), 8, RULER_H / 2 + 7);

    // duration 結束旗標（拖曳改 duration）
    if (endX >= view.gutter - 40 && endX <= W + 40) {
      const fw = 58;
      const fh = 15;
      const fx = clamp(endX - fw / 2, view.gutter + 1, Math.max(view.gutter + 1, W - fw - 1));
      const fy = 1;
      rr(g, fx, fy, fw, fh, 3);
      g.fillStyle = '#2b1017';
      g.fill();
      g.strokeStyle = '#ff5c7a';
      g.lineWidth = 1;
      g.stroke();
      g.fillStyle = '#ffb3c1';
      g.font = FONT_10;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(fmtDur(dur), fx + fw / 2, fy + fh / 2 + 0.5);
      rulerHits.push({ kind: 'duration', x: fx - 2, y: 0, w: fw + 4, h: RULER_H });
    }
    // 游標
    const px = timeToX(curFrame / FPS, view);
    if (px >= view.gutter && px <= W) {
      g.strokeStyle = 'rgba(255,255,255,0.95)';
      g.lineWidth = 1.5;
      g.beginPath();
      g.moveTo(Math.round(px) + 0.5, 8);
      g.lineTo(Math.round(px) + 0.5, RULER_H);
      g.stroke();
      g.fillStyle = '#ff5c7a';
      g.beginPath();
      g.moveTo(px - 5, RULER_H);
      g.lineTo(px + 5, RULER_H);
      g.lineTo(px, RULER_H - 7);
      g.closePath();
      g.fill();
    }
  }

  /* ---------- 座標 ---------- */
  function pointOf(e, cv) {
    const r = cv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function snapOpts(e) {
    // V2-06：有 bpm 時預設吸附到拍線，按住 Shift 暫時關閉（回到幀／粗吸附）
    const timing = timingOf();
    if (timing.hasBpm) return { beat: !(e && e.shiftKey), coarse: !!(e && e.shiftKey) };
    return { coarse: !!(e && e.shiftKey) };
  }
  /** 依目前 timing + 修飾鍵換算吸附後的秒數 */
  function snapWith(sec, e) {
    return snapTimeBeat(sec, timingOf(), snapOpts(e));
  }

  /* ---------- 游標 / 播放跟隨 ---------- */
  function seekFromX(x) {
    const dur = durationSec();
    const sec = clamp(xToTime(x, view), 0, dur);
    const frame = clamp(Math.round(sec * FPS), 0, Math.round(dur * FPS));
    curFrame = frame;
    if (preview && typeof preview.seek === 'function') {
      try { preview.seek(frame); } catch (err) { console.warn('[timeline] preview.seek 失敗', err); }
    }
    scheduleRender();
  }

  function ensureVisible(sec) {
    // 播放跟隨：使用者剛手動捲動過就暫時不搶捲動位置
    if (performance.now() - lastManualScrollAt < 900) return;
    const usable = Math.max(1, viewW - view.gutter - 8);
    const x = timeToX(sec, view);
    if (x > view.gutter + usable * 0.82 || x < view.gutter) {
      view.scrollSec = clampScroll(sec - usable / view.pxPerSec * 0.55, view.pxPerSec, viewW, view.gutter, durationSec());
      scheduleRender();
    }
  }

  /* ---------- 時間尺互動 ---------- */
  function beginDurationDrag(e, cv, p) {
    drag = { kind: 'duration', startX: p.x, startDur: durationSec(), key: nextKey('dur'), cv };
    try { cv.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
    scheduleRender();
  }

  function onRulerDown(e) {
    if (e.button !== 0) return;
    rootEl.focus({ preventScroll: true });
    closeMenu();
    const p = pointOf(e, rulerCanvas);
    const hit = hitTestRects(rulerHits, p.x, p.y);
    if (hit && hit.kind === 'duration') { beginDurationDrag(e, rulerCanvas, p); return; }
    drag = { kind: 'playhead', cv: rulerCanvas };
    try { rulerCanvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    seekFromX(p.x);
    e.preventDefault();
  }

  function onRulerMove(e) {
    if (!drag) { updateRulerCursor(e); return; }
    const cv = drag.cv || rulerCanvas;
    const p = pointOf(e, cv);
    if (drag.kind === 'playhead') {
      seekFromX(p.x);
    } else if (drag.kind === 'duration') {
      const sec = clamp(snapWith(xToTime(p.x, view), e), 1 / FPS, MAX_DURATION);
      setDuration(sec);
    }
  }

  function onRulerUp(e) {
    if (!drag) return;
    if (drag.cv) { try { drag.cv.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
    drag = null;
    if (typeof store.endCoalesce === 'function') {
      try { store.endCoalesce(); } catch (err) { /* ignore */ }
    }
    scheduleRender();
  }

  function updateRulerCursor(e) {
    const p = pointOf(e, rulerCanvas);
    const hit = hitTestRects(rulerHits, p.x, p.y);
    const c = hit && hit.kind === 'duration' ? 'col-resize' : 'ew-resize';
    if (rulerCanvas.style.cursor !== c) rulerCanvas.style.cursor = c;
  }

  function setDuration(sec) {
    const next = roundTime(clamp(sec, 1 / FPS, MAX_DURATION));
    applyUpdate((draft) => {
      if (!draft.settings || typeof draft.settings !== 'object') draft.settings = {};
      draft.settings.duration = next;
    }, { label: t('timeline.undo.duration'), coalesceKey: drag ? drag.key : 'tl-duration' });
    curFrame = Math.min(curFrame, Math.round(next * FPS));
  }

  /* ---------- 軌道互動 ---------- */
  function onTracksDown(e) {
    if (e.button !== 0) return;
    rootEl.focus({ preventScroll: true });
    closeMenu();
    const p = pointOf(e, trackCanvas);
    const hit = hitTestTolerant(hitRects, p.x, p.y, EVENT_HIT_PAD);
    if (hit && hit.kind === 'duration') { beginDurationDrag(e, trackCanvas, p); return; }
    if (hit && hit.kind === 'event') { beginEventDrag(e, hit, p); return; }
    beginMarquee(e, p);
  }

  /** Alt 拖曳複製：把目前拖曳目標複製一份，改拖複製品（可在 pointerdown 或第一次 move 觸發） */
  function startAltCopy() {
    if (!drag || drag.altDone || drag.kind !== 'move') return false;
    const evs = eventsOf();
    const srcIds = drag.targets.map((t) => t.id);
    const newIds = srcIds.map((id) => {
      const src = byId(evs, id);
      return store.newId(src && src.type ? src.type : 'event');
    });
    const copies = drag.targets.map((t, i) => ({ ...t, id: newIds[i] }));
    drag.altDone = true;
    drag.targets = copies;
    drag.primaryOrigAt = copies[0].origAt;
    drag.primaryOrigDur = copies[0].origDur;
    drag.snapTime = copies[0].origAt;
    drag.key = nextKey('copy');
    sel = new Set(newIds);
    primaryId = newIds[0];
    applyUpdate((draft) => {
      if (!Array.isArray(draft.timeline)) return;
      for (let i = 0; i < srcIds.length; i++) {
        const src = byId(draft.timeline, srcIds[i]);
        if (!src) continue;
        const copy = cloneEvent(src);
        copy.id = newIds[i];
        draft.timeline.push(copy);
      }
    }, { label: t('timeline.undo.duplicate'), coalesceKey: drag.key });
    syncSelectionToStore();
    scheduleRender();
    return true;
  }

  function beginEventDrag(e, hit, p) {
    const evs = eventsOf();
    const ev = byId(evs, hit.id);
    if (!ev) return;

    // 選取規則
    if (e.shiftKey) {
      if (sel.has(ev.id)) {
        sel.delete(ev.id);
        if (primaryId === ev.id) primaryId = [...sel].pop() || null;
      } else {
        sel.add(ev.id);
        primaryId = ev.id;
      }
    } else if (!sel.has(ev.id)) {
      sel = new Set([ev.id]);
      primaryId = ev.id;
    } else if (primaryId !== ev.id) {
      primaryId = ev.id;
    }
    if (typeof store.select === 'function') {
      withLocalSelLock(() => {
        if (primaryId) store.select('event', primaryId);
        else store.select(null, null);
      });
    }
    if (!sel.has(ev.id)) { scheduleRender(); return; }

    // 拖曳目標：整組選取；右緣調整只作用在被抓的那一個
    const edgeActive = !!hit.edge && hit.durPx >= MIN_BAR_PX && p.x >= hit.right - EDGE_PX;
    const timing = timingOf();
    const selectedTargets = [...sel].map((id) => {
      const item = byId(evs, id);
      if (!item) return null;
      const dur = durOf(item);
      return {
        id,
        type: item.type,
        origAt: startOf(item) ?? 0,
        origDur: dur > 0 ? dur : 0,
        hasDur: dur > 0,
        beatStyle: typeof item.at === 'string' && item.at.trim().endsWith('b'),
        durIsBeat: typeof item.duration === 'string',
      };
    }).filter(Boolean);
    if (!selectedTargets.length) return;

    let targets = edgeActive ? selectedTargets.filter((t) => t.id === ev.id) : selectedTargets;
    if (!targets.length) targets = [selectedTargets[0]];
    if (edgeActive && targets.length > 1) targets = [targets.find((t) => t.id === ev.id) || targets[0]];

    drag = {
      kind: edgeActive ? 'resize' : 'move',
      key: nextKey(edgeActive ? 'resize' : 'move'),
      startX: p.x,
      targets,
      altDone: false,
      primaryOrigAt: targets[0].origAt,
      primaryOrigDur: targets[0].origDur,
      snapTime: targets[0].origAt,
      timing,
      beatSnap: timing.hasBpm,
      cv: trackCanvas,
    };
    if (e.altKey) startAltCopy();
    try { trackCanvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
    scheduleRender();
  }

  function onTracksMove(e) {
    if (!drag) { updateTrackCursor(e); return; }
    if (drag.kind === 'marquee') {
      const p = pointOf(e, trackCanvas);
      drag.cur = p;
      const b = normBox(drag.start, p);
      const hits = b.w > 2 || b.h > 2 ? rectsInBox(hitRects, b) : [];
      const next = new Set(drag.additive ? drag.base : []);
      for (const h of hits) if (h.id) next.add(h.id);
      sel = next;
      primaryId = [...next][0] || null;
      scheduleRender();
      return;
    }
    if (drag.kind === 'playhead') return;
    if (drag.kind === 'move' && e.altKey && !drag.altDone) startAltCopy();
    const p = pointOf(e, drag.cv || trackCanvas);
    const dsec = (p.x - drag.startX) / view.pxPerSec;

    if (drag.kind === 'move') {
      const snapped = Math.max(0, snapWith(drag.primaryOrigAt + dsec, e));
      const applied = snapped - drag.primaryOrigAt;
      drag.snapTime = snapped;
      const targets = drag.targets;
      const timing = drag.timing || timingOf();
      applyUpdate((draft) => {
        if (!Array.isArray(draft.timeline)) return;
        for (const t of targets) {
          const item = byId(draft.timeline, t.id);
          if (!item) continue;
          // 保留使用者寫法：原本寫 "2b" 就繼續寫拍點字串
          item.at = formatLike(Math.max(0, t.origAt + applied), item.at, timing, true);
        }
      }, { label: t('timeline.undo.move'), coalesceKey: drag.key });
    } else if (drag.kind === 'resize') {
      const target = drag.targets[0];
      const nd = clamp(snapWith(target.origDur + dsec, e), 1 / FPS, MAX_DURATION);
      drag.snapTime = target.origAt + nd;
      const id = target.id;
      const timing = drag.timing || timingOf();
      applyUpdate((draft) => {
        if (!Array.isArray(draft.timeline)) return;
        const item = byId(draft.timeline, id);
        if (!item) return;
        item.duration = formatLike(nd, item.duration, timing, false);
      }, { label: t('timeline.undo.resize'), coalesceKey: drag.key });
    }
    scheduleRender();
  }

  function onTracksUp(e) {
    if (!drag) return;
    if (drag.kind === 'marquee') {
      const b = drag.cur ? normBox(drag.start, drag.cur) : null;
      if (!b || (b.w <= 2 && b.h <= 2)) {
        setSelection(new Set(), null);
      } else {
        const hits = rectsInBox(hitRects, b);
        const next = new Set(drag.additive ? drag.base : []);
        for (const h of hits) if (h.id) next.add(h.id);
        setSelection(next, [...next][0] || null);
      }
    }
    if (drag.cv) { try { drag.cv.releasePointerCapture(e.pointerId); } catch (err) { /* ignore */ } }
    drag = null;
    // 結束 coalesce 群組：下次拖曳視為新的復原步驟（store 有此擴充就呼叫，沒有也不影響）
    if (typeof store.endCoalesce === 'function') {
      try { store.endCoalesce(); } catch (err) { /* ignore */ }
    }
    scheduleRender();
  }

  function updateTrackCursor(e) {
    const p = pointOf(e, trackCanvas);
    const hit = hitTestTolerant(hitRects, p.x, p.y, EVENT_HIT_PAD);
    let c = 'crosshair';
    if (hit && hit.kind === 'duration') c = 'col-resize';
    else if (hit && hit.kind === 'event') {
      if (hit.edge && hit.durPx >= MIN_BAR_PX && p.x >= hit.right - EDGE_PX) c = 'ew-resize';
      else c = 'grab';
    }
    if (trackCanvas.style.cursor !== c) trackCanvas.style.cursor = c;
  }

  function beginMarquee(e, p) {
    drag = {
      kind: 'marquee',
      start: p,
      cur: p,
      additive: !!e.shiftKey,
      base: new Set(sel),
      cv: trackCanvas,
    };
    if (!e.shiftKey) { sel = new Set(); primaryId = null; }
    try { trackCanvas.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
    e.preventDefault();
    scheduleRender();
  }

  /* ---------- 新增事件選單 ---------- */
  function openMenu(canvasX, canvasY, sec) {
    menuSec = sec;
    menuEl.classList.add('open');
    menuOpen = true;
    // 先量自然尺寸（maxHeight 設 none 才量得到完整高度），再依點擊點挑上下方位
    menuEl.style.maxHeight = 'none';
    const rootRect = rootEl.getBoundingClientRect();
    const cvRect = trackCanvas.getBoundingClientRect();
    const rootW = rootEl.clientWidth || rootRect.width;
    const rootH = rootEl.clientHeight || rootRect.height;
    const pointX = cvRect.left - rootRect.left + canvasX;
    const pointY = cvRect.top - rootRect.top + canvasY;
    const place = placeTimelineMenu({
      point: { x: pointX, y: pointY },
      root: { w: rootW, h: rootH },
      menu: { w: menuEl.offsetWidth || 190, h: menuEl.offsetHeight || 240 },
    });
    menuEl.style.maxHeight = `${Math.round(place.maxHeight)}px`;
    menuEl.dataset.placement = place.placement;
    menuEl.style.left = `${Math.round(place.left)}px`;
    menuEl.style.top = `${Math.round(place.top)}px`;
    try { menuEl.focus({ preventScroll: true }); } catch (err) { /* ignore */ }
  }

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    menuEl.classList.remove('open');
  }

  function sfxDefaultName() {
    const idx = assets && assets.index ? assets.index : null;
    const audio = idx && idx.audio;
    if (audio && typeof audio === 'object') {
      const keys = Object.keys(audio);
      if (keys.length) return keys[0];
    }
    return '';
  }

  function addEventAt(type, sec) {
    const ev = createDefaultEvent(type, sec, {
      newId: typeof store.newId === 'function' ? store.newId.bind(store) : undefined,
      attack: attackOf(),
      sfxName: sfxDefaultName(),
    });
    applyUpdate((draft) => {
      if (!Array.isArray(draft.timeline)) draft.timeline = [];
      draft.timeline.push(ev);
    }, { label: t('timeline.undo.add', { type: trackLabel(type) }) });
    setSelection(new Set([ev.id]), ev.id);
    scheduleRender();
  }

  /* ---------- 鍵盤 ---------- */
  function focusedHere() {
    const a = document.activeElement;
    return !!a && (a === rootEl || rootEl.contains(a));
  }

  function deleteSelected() {
    if (!sel.size) return;
    const ids = new Set(sel);
    applyUpdate((draft) => {
      if (!Array.isArray(draft.timeline)) return;
      draft.timeline = draft.timeline.filter((ev) => !ev || !ids.has(ev.id));
    }, { label: t('timeline.undo.delete') });
    setSelection(new Set(), null);
  }

  function duplicateSelected() {
    if (!sel.size) return;
    const evs = eventsOf().filter((ev) => ev && sel.has(ev.id));
    if (!evs.length) return;
    const newIds = evs.map((ev) => store.newId(ev.type || 'event'));
    const srcIds = evs.map((ev) => ev.id);
    const timing = timingOf();
    applyUpdate((draft) => {
      if (!Array.isArray(draft.timeline)) return;
      for (let i = 0; i < srcIds.length; i++) {
        const src = byId(draft.timeline, srcIds[i]);
        if (!src) continue;
        const copy = cloneEvent(src);
        copy.id = newIds[i];
        // 保留使用者寫法：原本是拍點字串就複製成「下一拍」，否則往後一格（1/30 秒）
        const start = startOf(src) ?? 0;
        if (timing.hasBpm && typeof src.at === 'string' && /b$/i.test(src.at.trim())) {
          const nextBeat = secondsToBeatString(start + timing.beatSec, timing, true);
          copy.at = nextBeat === null ? roundTime(Math.max(0, start + 1 / FPS)) : nextBeat;
        } else {
          copy.at = roundTime(Math.max(0, start + 1 / FPS));
        }
        draft.timeline.push(copy);
      }
    }, { label: t('timeline.undo.duplicate') });
    setSelection(new Set(newIds), newIds[newIds.length - 1]);
  }

  function onKeyDown(e) {
    if (destroyed) return;
    if (!focusedHere() && !(sel.size > 0)) return;
    if (menuOpen) {
      if (e.key === 'Escape') { closeMenu(); e.preventDefault(); }
      return;
    }
    const target = e.target || document.activeElement;
    // B14：Delete/Backspace 在「有選取事件」時只要焦點不在輸入元件／對話框內就生效，
    // 不再要求焦點在 .tl-root（點過預覽畫布後仍要能刪）。
    const intent = timelineKeyIntent({
      key: e.key,
      focused: focusedHere(),
      editable: isEditableElement(target),
      modalOpen: modalOpenNow(document),
      menuOpen: false,
      selectedCount: sel.size,
      ctrl: e.ctrlKey || e.metaKey,
      shift: e.shiftKey,
      alt: e.altKey,
    });
    if (intent === 'delete') {
      deleteSelected();
      e.preventDefault();
      return;
    }
    if (intent === 'duplicate') {
      duplicateSelected();
      e.preventDefault();
      return;
    }
    if (!focusedHere()) return;
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable)) return;
    if (e.key === 'Escape') {
      setSelection(new Set(), null);
      e.preventDefault();
    }
  }

  /* ---------- 縮放 / 捲動 ---------- */
  function zoomBy(factor, anchorX) {
    const ax = anchorX != null ? anchorX : (viewW ? (view.gutter + viewW) / 2 : view.gutter);
    const r = zoomAt({
      pxPerSec: view.pxPerSec,
      scrollSec: view.scrollSec,
      anchorX: ax,
      factor,
      gutter: view.gutter,
      min: MIN_ZOOM,
      max: MAX_ZOOM,
    });
    view.pxPerSec = r.pxPerSec;
    view.scrollSec = clampScroll(r.scrollSec, view.pxPerSec, viewW, view.gutter, durationSec());
    scheduleRender();
  }

  function fitAll() {
    const W = viewW || tracksWrap.clientWidth || rootEl.clientWidth;
    if (!W) { needFit = true; return; }
    view.pxPerSec = fitPxPerSec(W, view.gutter, durationSec(), MIN_ZOOM, MAX_ZOOM);
    view.scrollSec = 0;
    needFit = false;
    lastManualScrollAt = -1e9; // 明確要求「看全部」→ 恢復播放跟隨
    scheduleRender();
  }

  function onWheel(e) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const cv = e.currentTarget === rulerCanvas || e.target === rulerCanvas ? rulerCanvas : trackCanvas;
      const p = pointOf(e, cv);
      zoomBy(Math.exp(-e.deltaY * 0.0022), p.x);
      return;
    }
    const dx = e.deltaX || 0;
    const dy = e.deltaY || 0;
    if (!dx && !dy) return;

    // Shift+滾輪 或 水平滾輪 → 水平捲動時間軸
    const horizontal = Math.abs(dx) > Math.abs(dy) || e.shiftKey;
    if (!horizontal) {
      // 軌道比面板高時，垂直滾輪交給原生垂直捲動；否則用來水平捲動時間軸
      if (tracksWrap.scrollHeight > tracksWrap.clientHeight + 1) {
        lastManualScrollAt = performance.now();
        return;
      }
      e.preventDefault();
      lastManualScrollAt = performance.now();
      view.scrollSec = clampScroll(
        view.scrollSec + dy / view.pxPerSec,
        view.pxPerSec, viewW, view.gutter, durationSec(),
      );
      scheduleRender();
      return;
    }
    const delta = Math.abs(dx) > Math.abs(dy) ? dx : dy;
    if (!delta) return;
    e.preventDefault();
    lastManualScrollAt = performance.now();
    view.scrollSec = clampScroll(
      view.scrollSec + delta / view.pxPerSec,
      view.pxPerSec, viewW, view.gutter, durationSec(),
    );
    scheduleRender();
  }

  /* ---------- 事件綁定 ---------- */
  on(rulerCanvas, 'pointerdown', onRulerDown);
  on(rulerCanvas, 'pointermove', onRulerMove);
  on(rulerCanvas, 'pointerup', onRulerUp);
  on(rulerCanvas, 'pointercancel', onRulerUp);
  on(trackCanvas, 'pointerdown', onTracksDown);
  on(trackCanvas, 'pointermove', onTracksMove);
  on(trackCanvas, 'pointerup', onTracksUp);
  on(trackCanvas, 'pointercancel', onTracksUp);
  on(trackCanvas, 'pointerleave', () => {
    if (!drag) trackCanvas.style.cursor = 'default';
  });
  on(tracksWrap, 'scroll', updateScrollFade, { passive: true });

  on(trackCanvas, 'dblclick', (e) => {
    const p = pointOf(e, trackCanvas);
    // B5：雙擊事件條 = 選取該事件並把焦點帶到檢查器（行為要與提示文案一致）
    const hit = hitTestTolerant(hitRects, p.x, p.y, EVENT_HIT_PAD);
    if (hit && hit.kind === 'event' && hit.id) {
      closeMenu();
      setSelection(new Set([hit.id]), hit.id);
      focusInspectorPanel();
      e.preventDefault();
      return;
    }
    if (hitTestRects(hitRects, p.x, p.y)) return;
    const sec = Math.max(0, snapWith(xToTime(p.x, view), e));
    openMenu(p.x, p.y, sec);
    e.preventDefault();
  });

  on(menuEl, 'click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('.tl-menu-item') : null;
    if (!btn) return;
    const type = btn.dataset.type;
    closeMenu();
    addEventAt(type, menuSec);
    e.preventDefault();
  });

  on(menuEl, 'keydown', (e) => {
    if (e.key === 'Escape') { closeMenu(); e.preventDefault(); }
  });

  on(toolbar, 'click', (e) => {
    const btn = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'fit') fitAll();
    else if (act === 'zoomin') zoomBy(1.35);
    else if (act === 'zoomout') zoomBy(1 / 1.35);
    btn.blur();
  });

  on(document, 'pointerdown', (e) => {
    if (!menuOpen) return;
    if (menuEl.contains(e.target) || toolbar.contains(e.target)) return;
    closeMenu();
  }, true);

  on(document, 'keydown', onKeyDown);
  on(document, 'keydown', (e) => {
    if (menuOpen && e.key === 'Escape') { closeMenu(); e.preventDefault(); e.stopPropagation(); }
  }, true);
  on(rootEl, 'wheel', onWheel, { passive: false });

  on(window, 'resize', scheduleRender);

  /* ---------- 語系切換（SPEC §10.1） ----------
   * 只重新套字串 + 重繪，不動 view（縮放/捲動）、sel、layout 快取，
   * 所以選取與捲動位置都保留。 */
  let unsubLocale = null;
  if (typeof onLocaleChange === 'function') {
    unsubLocale = onLocaleChange(() => {
      if (destroyed) return;
      applyStaticStrings();
      scheduleRender();
    });
  }

  /* ---------- store / preview 訂閱 ---------- */
  let unsubStore = null;
  if (typeof store.subscribe === 'function') {
    unsubStore = store.subscribe((st, change) => {
      if (destroyed) return;
      // 開檔／新建／換掉整份攻擊：重新適合全部並清掉失效選取。
      // （SPEC §10 只保證 change = { label, paths? }；paths 含 '$' 時視為整份文件被換掉）
      const wholeDoc = !!(change && (change.reset || change.document ||
        (Array.isArray(change.paths) && change.paths.includes('$'))));
      if (wholeDoc) {
        sel = new Set();
        primaryId = null;
        needFit = true;
        scheduleRender();
        return;
      }
      // store → 面板：只有在不是本面板自己寫入時才單向同步（避免拖曳時互相打架）
      if (!localSelLock) {
        const selection = st ? st.selection : store.selection;
        const selId = selection && selection.kind === 'event' ? selection.id : null;
        if (selId !== primaryId) {
          if (selId) {
            if (!sel.has(selId)) sel = new Set([selId]);
            primaryId = selId;
          } else if (sel.size) {
            sel = new Set();
            primaryId = null;
          }
        }
      }
      pruneSelection();
      scheduleRender();
    });
  }

  let unsubFrame = null;
  if (preview && typeof preview.onFrame === 'function') {
    try {
      unsubFrame = preview.onFrame((frame) => {
        if (destroyed) return;
        const f = Number(frame);
        if (!Number.isFinite(f)) return;
        const prev = curFrame;
        curFrame = f;
        if (f > prev && f - prev <= 6) ensureVisible(f / FPS);
        scheduleRender();
      });
    } catch (err) {
      console.warn('[timeline] preview.onFrame 訂閱失敗', err);
    }
  }
  if (preview && typeof preview.getFrame === 'function') {
    try {
      const f = preview.getFrame();
      if (Number.isFinite(f)) curFrame = f;
    } catch (err) { /* ignore */ }
  }

  /* ---------- 尺寸監看 ---------- */
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => scheduleRender());
    ro.observe(rootEl);
    ro.observe(tracksWrap);
  }

  // 首次排版後再 fit（mount 當下可能還沒有尺寸）
  scheduleRender();
  requestAnimationFrame(() => {
    if (!viewW) return;
    fitAll();
  });

  const api = {
    version: '1.0.0',
    refresh() { render(); },
    fit: fitAll,
    getSelection() { return [...sel]; },
    getView() { return { ...view }; },
    /** 目前的分列結果（除錯／測試用；請勿修改回傳物件） */
    getLayout() { return layout; },
    /** 畫布座標命中測試（除錯／測試用） */
    hitTest(x, y) { return hitTestRects(hitRects, x, y); },
    /** 目前游標幀 */
    getFrame() { return curFrame; },
    setView(next) {
      if (next && Number.isFinite(next.pxPerSec)) view.pxPerSec = clamp(next.pxPerSec, MIN_ZOOM, MAX_ZOOM);
      if (next && Number.isFinite(next.scrollSec)) view.scrollSec = next.scrollSec;
      scheduleRender();
    },
    unmount() {
      destroyed = true;
      if (flashTimer) { clearTimeout(flashTimer); flashTimer = 0; }
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      ac.abort();
      if (ro) { ro.disconnect(); ro = null; }
      if (typeof unsubStore === 'function') { try { unsubStore(); } catch (err) { /* ignore */ } }
      if (typeof unsubFrame === 'function') { try { unsubFrame(); } catch (err) { /* ignore */ } }
      if (typeof unsubLocale === 'function') { try { unsubLocale(); } catch (err) { /* ignore */ } }
      rootEl.classList.remove('tl-root');
      rootEl.innerHTML = '';
    },
  };
  return api;
}
