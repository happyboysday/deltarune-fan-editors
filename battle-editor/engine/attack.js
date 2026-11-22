/**
 * engine/attack.js — 攻擊檔正規化（normalizeAttack）與驗證（validateAttack）
 *
 * SPEC §3（格式）、§4（時間軸事件）、§5（生成欄位與表達式）。
 * 這兩個函式都必須「永不丟出例外」：
 *   - normalizeAttack：把缺漏 / 型別錯誤的欄位補成安全預設值，讓模擬一定跑得動。
 *   - validateAttack：回傳 [{ path, message }]，供編輯器在檢查器標紅。
 */

import { compile, isValidMemoryName } from './expr.js';
import { EASING_NAMES } from './easing.js';
import { validateAttackDemo } from './autoplay/validate.js';
import { ARENA_KINDS, ARENA_SOUL_RADIUS, BOX_APPEARANCES, CLIP_TARGETS, compilePolygon } from './arena.js';

export const ATTACK_FORMAT = 'dr-battle-attack/1';
import { compileSoulProfiles } from './soul-mechanics.js';

export const FPS = 30;

/** 生成欄位（SPEC §5）；pathX/pathY 為每幀求值，其餘生成時求值一次 */
export const SPAWN_NUMERIC_FIELDS = [
  'x',
  'y',
  'speed',
  'angle',
  'accel',
  'angularVel',
  'scale',
  'rotation',
  'life',
  'alpha',
];
/** 每幀求值的欄位：pathX/pathY（位移）＋偽 3D 的 pathScale/pathAlpha/pathZ/solidWhen */
export const SPAWN_PATH_FIELDS = ['pathX', 'pathY', 'pathScale', 'pathAlpha', 'pathZ', 'pathFrame', 'pathRotation', 'solidWhen'];
export const SPAWN_FIELDS = [...SPAWN_NUMERIC_FIELDS, ...SPAWN_PATH_FIELDS];

/** 生成欄位預設值（無時間軸事件時的最小可用攻擊） */
export const SPAWN_DEFAULTS = {
  x: 0,
  y: 0,
  speed: 0,
  angle: 0,
  accel: 0,
  angularVel: 0,
  scale: 1,
  rotation: 0,
  life: null,
  alpha: 1,
  pathX: null,
  pathY: null,
  pathScale: null,
  pathAlpha: null,
  pathZ: null,
  pathFrame: null,
  pathRotation: null,
  solidWhen: null,
};

/**
 * 戰鬥框預設值（依 SPEC-LAYOUT §5 實機量測）：
 *   中心 (320, 190)、內部 144×158、綠描邊 3px → 外框約 150×165。
 */
export const BOX_DEFAULTS = {
  x: 320,
  y: 190,
  w: 144,
  h: 158,
  rotation: 0,
  border: 3,
  color: '#00c000',
};

export const SOUL_DEFAULTS = {
  x: null,
  y: null,
  speed: 4,
  slowSpeed: 2,
  mode: 'red',
  color: '#ff0000',
};

export const SETTINGS_DEFAULTS = {
  duration: 8,
  seed: 1,
  damage: 10,
  invincibleFrames: 30,
  grazeTP: 1.0,
  background: null,
  bgm: null,
  // 拍點（SPEC-EXPR-V2 §2）：bpm 未設定 = null（此時不得使用 "2b" 拍點字串）
  bpm: null,
  beatOffset: 0,
};

export const BULLET_DEFAULTS = {
  sprite: null,
  frameRate: 0,
  scale: 1,
  color: null,
  hitbox: { shape: 'circle', r: 6 },
  damage: null,
  grazeable: true,
  decor: false,
  destroyOnHit: true,
  faceVelocity: true,
  offscreen: 'destroy',
  maskToBox: false,
};

export const EVENT_TYPES = ['spawn', 'emitter', 'box', 'soul', 'soulProfile', 'soulAppearance', 'soulTeleport', 'soulDrift', 'clear', 'shake', 'sfx', 'anim', 'end'];

const DEFAULT_PARTY = [
  { name: 'Kris', hp: 90, maxHp: 90, color: '#00ffff', icon: null },
];

/* ------------------------------------------------------------ 小工具 */

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** 有限數字，否則回傳預設 */
export function num(v, def = 0) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return def;
}

function int(v, def = 0) {
  const n = num(v, def);
  return Math.trunc(n);
}

function bool(v, def) {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === 0) return Boolean(v);
  return def;
}

function str(v, def = '') {
  return typeof v === 'string' ? v : def;
}

function color(v, def) {
  if (typeof v === 'string' && /^#[0-9a-f]{3,8}$/i.test(v.trim())) return v.trim();
  return def;
}

/** 深拷貝純 JSON（保留原始欄位，避免編輯器存檔掉資料） */
export function deepClone(value) {
  if (Array.isArray(value)) return value.map(deepClone);
  if (isObj(value)) {
    const out = {};
    for (const k of Object.keys(value)) out[k] = deepClone(value[k]);
    return out;
  }
  return value;
}

/* -------------------------------------------------------- 拍點（BPM） */

/**
 * 拍點字串格式（SPEC-EXPR-V2 §2）：`"2b"`、`"1.5b"`、`"-0.5b"`、`".5b"`、`"2.5b"`。
 * 只認這種寫法，其他一律當一般表達式處理（例如 `"beat*4"`）。
 */
const BEAT_RE = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))b$/i;

/**
 * 解析拍點字串 → 拍數；不是拍點字串回傳 null。
 * @param {any} raw
 * @returns {number|null}
 */
export function parseBeatString(raw) {
  if (typeof raw !== 'string') return null;
  const m = BEAT_RE.exec(raw.trim());
  if (!m) return null;
  const beats = Number(m[1]);
  return Number.isFinite(beats) ? beats : null;
}

/**
 * 時間欄位轉秒（SPEC-EXPR-V2 §2）。
 *
 * - 數字：原樣（秒）。
 * - `"2b"` 這類拍點字串：beats × beatSec，**再加上** `addOffset`（只有 `at` 傳
 *   `settings.beatOffset`；長度類欄位傳 0，依 ROADMAP §1 的決策）。
 * - 其他字串：視為表達式 → 求值後回傳（呼叫端負責回報錯誤）。
 * - 不合法（例如 `"abc"`）→ 回傳 { value: 0, error }，由呼叫端決定怎麼報。
 *
 * @param {any} raw
 * @param {{bpm?:number|null, beatOffset?:number, addOffset?:boolean}} timing
 * @returns {{value:number, error:string|null, beats?:number|null}}
 */
export function timeToSeconds(raw, timing) {
  const t = isObj(timing) ? timing : {};
  const bpm = num(t.bpm, NaN);
  const hasBpm = Number.isFinite(bpm) && bpm > 0;
  const beatSec = hasBpm ? 60 / bpm : 0;
  const offset = num(t.beatOffset, 0);

  if (raw === null || raw === undefined || raw === '') return { value: 0, error: null };
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw)) return { value: 0, error: `時間不是有限數（${raw}）` };
    return { value: raw, error: null };
  }
  if (typeof raw !== 'string') {
    return { value: 0, error: `時間欄位型別不支援（${typeof raw}）` };
  }
  const beats = parseBeatString(raw);
  if (beats !== null) {
    if (!hasBpm) {
      return {
        value: 0,
        error: `使用了拍點單位 "${raw.trim()}"，但 settings.bpm 未設定（請在 settings 加上正數 bpm，例如 120）`,
        beats,
      };
    }
    const extra = t.addOffset ? offset : 0;
    return { value: beats * beatSec + extra, error: null, beats };
  }
  // 其他字串 → 表達式（`"beat*4"`、`"60/bpm"` 之類；引擎在 sim 例外處理）
  return { value: 0, error: null, expression: true };
}

/**
 * settings 的拍點設定（SPEC-EXPR-V2 §2）。
 * @param {any} srcSettings
 * @returns {{bpm:number|null, beatOffset:number, hasBpm:boolean, beatSec:number}}
 */
export function beatTimingOf(srcSettings) {
  const s = isObj(srcSettings) ? srcSettings : {};
  const bpm = num(s.bpm, NaN);
  const hasBpm = Number.isFinite(bpm) && bpm > 0;
  return {
    bpm: hasBpm ? bpm : null,
    beatOffset: num(s.beatOffset, 0),
    hasBpm,
    beatSec: hasBpm ? 60 / bpm : 0,
  };
}

/** 沒設定 bpm 卻使用拍點字串時的錯誤訊息（SPEC-EXPR-V2 §2） */
function beatMissingBpmMessage(fieldPath, raw) {
  return `"${String(raw).trim()}" 是拍點單位，但 settings.bpm 未設定；請在 settings 加上正數 bpm（例如 "bpm": 120），或把 ${fieldPath} 改成秒數`;
}

/**
 * 驗證單一時間欄位（SPEC-EXPR-V2 §2）：
 *   數字 = 秒；`"2b"` = 拍點（需要 settings.bpm）；其他字串 → 不支援（只有
 *   `at` 等「時間點」與長度欄位接受拍點，運算式請用於生成欄位）。
 */
function validateTimeField(value, path, add, timing, extra, opts) {
  const tm = timing || beatTimingOf(null);
  const label = (opts && opts.label) || String(path).split('.').pop();
  if (value === undefined || value === null || value === '') return;
  const allowNegative = Boolean(opts && opts.allowNegative);
  const beats = parseBeatString(value);
  if (beats !== null) {
    if (!tm.hasBpm) {
      add(path, beatMissingBpmMessage(label, value), extra);
      return;
    }
    if (!allowNegative && beats * tm.beatSec < 0) {
      add(path, `${label} 不可為負數`, extra);
    }
    return;
  }
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    add(path, `${label} 必須是秒數或拍點字串（例如 1.5 或 "2b"）`, extra);
    return;
  }
  if (!allowNegative && n < 0) add(path, `${label} 不可為負數`, extra);
}

/**
 * 單一事件時間欄位 → 秒。永不 throw。
 *
 * @param {any} raw 數字（秒）/ 拍點字串 / 其他
 * @param {{hasBpm:boolean, beatSec:number, beatOffset:number}} timing
 * @param {boolean} addOffset 是否加 beatOffset（只有「時間點」欄位如 at 要加）
 * @returns {{ok:boolean, value:number, beats:number|null, reason:string|null}}
 */
function resolveTime(raw, timing, addOffset) {
  const tm = timing || { hasBpm: false, beatSec: 0, beatOffset: 0 };
  if (raw === null || raw === undefined || raw === '') return { ok: true, value: 0, beats: null, reason: null };
  if (typeof raw === 'number') {
    return Number.isFinite(raw)
      ? { ok: true, value: raw, beats: null, reason: null }
      : { ok: false, value: 0, beats: null, reason: 'nan' };
  }
  if (typeof raw !== 'string') return { ok: false, value: 0, beats: null, reason: 'type' };
  const beats = parseBeatString(raw);
  if (beats === null) {
    // 向後相容：舊檔可能把秒數寫成字串（`"at": "1.5"`、`"duration": "2"`），
    // 舊的 num() 接受這種寫法，這裡照舊視為秒。
    const seconds = Number(raw);
    if (raw.trim() !== '' && Number.isFinite(seconds)) {
      return { ok: true, value: seconds, beats: null, reason: null };
    }
    return { ok: false, value: 0, beats: null, reason: 'bad' };
  }
  if (!tm.hasBpm) return { ok: false, value: 0, beats, reason: 'no-bpm' };
  const offset = addOffset ? num(tm.beatOffset, 0) : 0;
  return { ok: true, value: beats * num(tm.beatSec, 0) + offset, beats, reason: null };
}

/** 時間欄位正規化：轉成秒；不合法（含沒 bpm 的拍點字串）→ fallback */
function normalizeTimeValue(raw, timing, addOffset, fallback) {
  const r = resolveTime(raw, timing, addOffset);
  return r.ok ? r.value : fallback;
}

/**
 * 生成欄位的「時間」欄位（life）：拍點字串 → 秒（不加 offset）；
 * 其他字串保留（表達式，於生成時求值）。
 */
function normalizeSpawnLife(raw, timing) {
  if (raw === null || raw === undefined || raw === '') return SPAWN_DEFAULTS.life;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : SPAWN_DEFAULTS.life;
  if (typeof raw === 'string') {
    const beats = parseBeatString(raw);
    if (beats === null) return raw; // 表達式字串（例如 "beat*2"）
    if (!timing || !timing.hasBpm) return SPAWN_DEFAULTS.life; // 驗證器會報錯
    return beats * num(timing.beatSec, 0);
  }
  return SPAWN_DEFAULTS.life;
}

/** demo.path[].t 正規化（時間點 → 加 beatOffset） */
function normalizeDemo(demo, timing) {
  if (!isObj(demo)) return demo;
  const out = deepClone(demo);
  if (!Array.isArray(out.path)) return out;
  out.path = out.path.map((point) => {
    if (!isObj(point)) return point;
    const raw = point.t;
    if (typeof raw !== 'string') return point;
    const beats = parseBeatString(raw);
    if (beats === null) return point; // 非拍點字串：原樣（驗證器會報錯）
    if (!timing.hasBpm) return point; // 沒 bpm：原樣（驗證器會報錯）
    point.t = Math.max(0, beats * timing.beatSec + timing.beatOffset);
    return point;
  });
  return out;
}

/** memory 正規化（SPEC-EXPR-V2 §3）：只留合法識別字 + 數字 / 非空字串 */
function normalizeMemory(raw) {
  const mem = {};
  if (!isObj(raw)) return mem;
  for (const name of Object.keys(raw)) {
    if (!isValidMemoryName(name)) continue;
    const v = raw[name];
    if (typeof v === 'number' && Number.isFinite(v)) mem[name] = v;
    else if (typeof v === 'string' && v.trim() !== '') mem[name] = v;
  }
  return mem;
}

/**
 * 正規化生成欄位：數字保持數字，字串保留（表達式），null/undefined → 預設。
 * 注意：speed/angle 等若為空字串，視為預設值而非表達式。
 */
function normalizeSpawnFields(src, out, timing) {
  const input = isObj(src) ? src : {};
  for (const key of SPAWN_FIELDS) {
    const raw = input[key];
    const def = SPAWN_DEFAULTS[key];
    if (raw === null || raw === undefined || raw === '') {
      out[key] = def;
    } else if (typeof raw === 'number') {
      out[key] = Number.isFinite(raw) ? raw : def;
    } else if (typeof raw === 'string') {
      // life 是「時間長度」：拍點字串（"2b"）在這裡就換成秒（不加 beatOffset）；
      // 其他字串（"beat*2" 之類）保留給引擎當表達式求值（SPEC-EXPR-V2 §2）。
      out[key] = key === 'life' ? normalizeSpawnLife(raw, timing) : raw;
    } else {
      out[key] = def;
    }
  }
  // memory（SPEC-EXPR-V2 §3）：spawn 時求值一次並固定在子彈上
  out.memory = normalizeMemory(input.memory);
  return out;
}

/* --------------------------------------------------------- normalize */

/**
 * 把任意輸入補成完整可用的攻擊物件。
 * @param {any} json
 * @returns {object} 正規化後的攻擊（新物件，不共用輸入參考）
 */
export function normalizeAttack(json) {
  const src = isObj(json) ? json : {};
  const out = deepClone(src);

  out.format = ATTACK_FORMAT;

  /* meta（保留未知欄位，編輯器可能有擴充） */
  const metaIn = isObj(src.meta) ? src.meta : {};
  const meta = deepClone(metaIn);
  meta.name = str(metaIn.name, '未命名攻擊');
  meta.author = str(metaIn.author, '');
  out.meta = meta;

  /* settings */
  const sIn = isObj(src.settings) ? src.settings : {};
  // 拍點設定先解析，事件時間欄位要用（SPEC-EXPR-V2 §2）
  const timing = beatTimingOf(sIn);
  const givenDuration =
    sIn.duration !== undefined && sIn.duration !== null && parseBeatString(sIn.duration) !== null
      ? normalizeTimeValue(sIn.duration, timing, false, NaN)
      : num(sIn.duration, NaN);
  const settings = {
    duration: givenDuration > 0 ? givenDuration : deriveDuration(src.timeline, timing),
    seed: int(sIn.seed, SETTINGS_DEFAULTS.seed),
    damage: num(sIn.damage, SETTINGS_DEFAULTS.damage),
    invincibleFrames: Math.round(num(sIn.invincibleFrames, SETTINGS_DEFAULTS.invincibleFrames)),
    grazeTP: num(sIn.grazeTP, SETTINGS_DEFAULTS.grazeTP),
    background:
      typeof sIn.background === 'string' && sIn.background ? sIn.background : null,
    bgm: typeof sIn.bgm === 'string' && sIn.bgm ? sIn.bgm : null,
    bpm: timing.bpm,
    beatOffset: timing.beatOffset,
  };
  if (settings.invincibleFrames < 0) settings.invincibleFrames = 0;
  if (settings.damage < 0) settings.damage = 0;
  out.settings = settings;

  /* box（x/y 為中心點） */
  const bIn = isObj(src.box) ? src.box : {};
  const box = {
    x: num(bIn.x, BOX_DEFAULTS.x),
    y: num(bIn.y, BOX_DEFAULTS.y),
    w: num(bIn.w, BOX_DEFAULTS.w),
    h: num(bIn.h, BOX_DEFAULTS.h),
    rotation: num(bIn.rotation, BOX_DEFAULTS.rotation),
    border: Math.max(0, num(bIn.border, BOX_DEFAULTS.border)),
    color: color(bIn.color, BOX_DEFAULTS.color),
  };
  if (Math.abs(box.w) < 1) box.w = BOX_DEFAULTS.w;
  if (Math.abs(box.h) < 1) box.h = BOX_DEFAULTS.h;
  box.w = Math.abs(box.w);
  box.h = Math.abs(box.h);
  if (BOX_APPEARANCES.includes(bIn.appearance)) box.appearance = bIn.appearance;
  out.box = box;

  /* soul */
  const soIn = isObj(src.soul) ? src.soul : {};
  // 速度：有給但不合法 → 0（不偷偷沿用預設，避免出現「明明寫錯卻跑很快」）
  const soulSpeed = soIn.speed === undefined || soIn.speed === null ? SOUL_DEFAULTS.speed : Math.max(0, num(soIn.speed, 0));
  const soulSlow =
    soIn.slowSpeed === undefined || soIn.slowSpeed === null ? SOUL_DEFAULTS.slowSpeed : Math.max(0, num(soIn.slowSpeed, 0));
  out.soul = {
    x: soIn.x === null || soIn.x === undefined ? null : num(soIn.x, null),
    y: soIn.y === null || soIn.y === undefined ? null : num(soIn.y, null),
    speed: soulSpeed,
    slowSpeed: soulSlow,
    mode: str(soIn.mode, SOUL_DEFAULTS.mode) || 'red',
    color: color(soIn.color, SOUL_DEFAULTS.color),
    ...(Object.hasOwn(soIn, 'profile') ? { profile: soIn.profile } : {}),
  };
  if (Object.hasOwn(src, 'soulProfiles')) out.soulProfiles = deepClone(src.soulProfiles);

  /* party */
  const partyIn = Array.isArray(src.party) ? src.party : [];
  out.party = partyIn.length
    ? partyIn.filter(isObj).map((p) => {
        const maxHp = Math.max(1, num(p.maxHp, num(p.hp, 1)));
        return {
          name: str(p.name, '隊員'),
          hp: Math.max(0, Math.min(maxHp, num(p.hp, maxHp))),
          maxHp,
          color: color(p.color, '#ffffff'),
          icon: typeof p.icon === 'string' && p.icon ? p.icon : null,
        };
      })
    : deepClone(DEFAULT_PARTY);
  if (out.party.length === 0) out.party = deepClone(DEFAULT_PARTY);

  /* enemies */
  const enemiesIn = Array.isArray(src.enemies) ? src.enemies : [];
  out.enemies = enemiesIn.filter(isObj).map((e) => ({
    sprite: typeof e.sprite === 'string' && e.sprite ? e.sprite : null,
    x: num(e.x, 520),
    y: num(e.y, 200),
    scale: num(e.scale, 1),
    frameRate: Math.max(0, num(e.frameRate, 4)),
  }));

  /* bulletTypes */
  const btIn = isObj(src.bulletTypes) ? src.bulletTypes : {};
  const bulletTypes = {};
  for (const name of Object.keys(btIn)) {
    if (!isObj(btIn[name])) continue;
    bulletTypes[name] = normalizeBulletType(btIn[name]);
  }
  out.bulletTypes = bulletTypes;

  /* timeline */
  const timelineIn = Array.isArray(src.timeline) ? src.timeline : [];
  out.timeline = timelineIn.map((ev, index) => normalizeEvent(ev, index, timing));

  /* demo（SPEC-AUTOPLAY §2.1）：path[].t 也接受 "2b"（時間點 → 加 beatOffset） */
  out.demo = normalizeDemo(src.demo, timing);

  return out;
}

/** 子彈類型正規化 */
export function normalizeBulletType(src) {
  const input = isObj(src) ? src : {};
  const hb = isObj(input.hitbox) ? input.hitbox : {};
  const shape = hb.shape === 'rect' ? 'rect' : 'circle';
  const hitbox =
    shape === 'rect'
      ? { shape: 'rect', w: Math.max(0, num(hb.w, 8)), h: Math.max(0, num(hb.h, 8)) }
      : { shape: 'circle', r: Math.max(0, num(hb.r, 6)) };
  const out = deepClone(input);
  out.sprite = typeof input.sprite === 'string' && input.sprite ? input.sprite : null;
  out.frameRate = Math.max(0, num(input.frameRate, BULLET_DEFAULTS.frameRate));
  out.scale = num(input.scale, BULLET_DEFAULTS.scale);
  out.color = typeof input.color === 'string' && input.color ? color(input.color, null) : null;
  out.hitbox = hitbox;
  out.damage =
    input.damage === null || input.damage === undefined ? null : Math.max(0, num(input.damage, null));
  out.grazeable = bool(input.grazeable, BULLET_DEFAULTS.grazeable);
  out.decor = bool(input.decor, BULLET_DEFAULTS.decor);
  out.destroyOnHit = bool(input.destroyOnHit, BULLET_DEFAULTS.destroyOnHit);
  out.faceVelocity = bool(input.faceVelocity, BULLET_DEFAULTS.faceVelocity);
  out.offscreen = input.offscreen === 'keep' ? 'keep' : 'destroy';
  out.maskToBox = bool(input.maskToBox, BULLET_DEFAULTS.maskToBox);
  if (!CLIP_TARGETS.includes(out.clipTo)) delete out.clipTo;
  if (input.shootable === true) out.shootable = true;
  else delete out.shootable;
  if (input.platform === true) out.platform = true;
  else delete out.platform;
  if (Number.isFinite(input.bounce) && input.bounce > 0) out.bounce = input.bounce;
  else delete out.bounce;
  if (Number.isFinite(input.hp) && input.hp > 1) out.hp = Math.min(99, Math.round(input.hp));
  else delete out.hp;
  return out;
}

/** 時間軸事件正規化（依 type 補預設值，保留未知欄位） */
export function normalizeEvent(src, index, timing) {
  const tm = timing || beatTimingOf(null);
  const input = isObj(src) ? src : {};
  const out = deepClone(input);
  out.id = typeof input.id === 'string' && input.id ? input.id : `ev_${index}`;
  // at 是「時間點」→ 拍點字串換算後加上 beatOffset（SPEC-EXPR-V2 §2）
  out.at = Math.max(0, normalizeTimeValue(input.at, tm, true, 0));
  const type = typeof input.type === 'string' ? input.type : 'spawn';
  out.type = EVENT_TYPES.includes(type) ? type : type;
  out.label = typeof input.label === 'string' ? input.label : '';

  switch (out.type) {
    case 'spawn': {
      const fields = normalizeSpawnFields(input, {}, tm);
      Object.assign(out, fields);
      out.bullet = typeof input.bullet === 'string' ? input.bullet : '';
      out.count = Math.max(1, int(input.count, 1));
      break;
    }
    case 'emitter': {
      out.duration = Math.max(0, normalizeTimeValue(input.duration, tm, false, 0));
      out.interval = Math.max(1 / FPS, normalizeTimeValue(input.interval, tm, false, 0.25));
      out.count = Math.max(1, int(input.count, 1));
      const spawnIn = isObj(input.spawn) ? input.spawn : {};
      const spawn = normalizeSpawnFields(spawnIn, {}, tm);
      spawn.bullet = typeof spawnIn.bullet === 'string' ? spawnIn.bullet : '';
      out.spawn = spawn;
      break;
    }
    case 'box': {
      out.duration = Math.max(0, normalizeTimeValue(input.duration, tm, false, 0.5));
      out.ease = typeof input.ease === 'string' && input.ease ? input.ease : 'linear';
      const toIn = isObj(input.to) ? input.to : {};
      const to = {};
      for (const key of ['x', 'y', 'w', 'h', 'rotation']) {
        if (toIn[key] !== undefined && toIn[key] !== null && Number.isFinite(Number(toIn[key]))) {
          to[key] = Number(toIn[key]);
        }
      }
      out.to = to;
      break;
    }
    case 'soul': {
      if (input.mode !== undefined) out.mode = str(input.mode, 'red');
      if (input.x !== undefined) out.x = input.x === null ? null : num(input.x, null);
      if (input.y !== undefined) out.y = input.y === null ? null : num(input.y, null);
      if (input.color !== undefined) out.color = color(input.color, null);
      break;
    }
    case 'clear': {
      out.fade = Math.max(0, normalizeTimeValue(input.fade, tm, false, 0.3));
      break;
    }
    case 'shake': {
      out.duration = Math.max(0, normalizeTimeValue(input.duration, tm, false, 0.4));
      out.amount = Math.max(0, num(input.amount, 4));
      break;
    }
    case 'anim': {
      out.actor = str(input.actor, '');
      out.anim = str(input.anim, '');
      break;
    }
    case 'soulDrift': {
      // 每幀把靈魂推 (dx, dy) px（運算式，可讀 soul／box／t＝這個事件開始後的秒數）；
      // 一直生效到下一個 soulDrift 事件；dx、dy 都留空或 0 就是停止。
      for (const key of ['dx', 'dy']) {
        const v = input[key];
        out[key] = typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() ? v : 0;
      }
      break;
    }
    case 'sfx': {
      out.sound = typeof input.sound === 'string' ? input.sound : '';
      break;
    }
    case 'end':
    default:
      break;
  }
  return out;
}

/** duration 未給或非法時，由時間軸推算（含 emitter 的完整區間） */
export function deriveDuration(timeline, timing) {
  const tm = timing || beatTimingOf(null);
  let maxEnd = 0;
  if (Array.isArray(timeline)) {
    for (const ev of timeline) {
      if (!isObj(ev)) continue;
      const at = Math.max(0, normalizeTimeValue(ev.at, tm, true, 0));
      const dur = (raw, fallback) => Math.max(0, normalizeTimeValue(raw, tm, false, fallback));
      let end = at;
      if (ev.type === 'emitter') end = at + dur(ev.duration, 0);
      else if (ev.type === 'box') end = at + dur(ev.duration, 0);
      else if (ev.type === 'shake') end = at + dur(ev.duration, 0);
      else if (ev.type === 'clear') end = at + dur(ev.fade, 0);
      if (end > maxEnd) maxEnd = end;
    }
  }
  return maxEnd > 0 ? Math.min(600, maxEnd + 0.5) : SETTINGS_DEFAULTS.duration;
}

/* ---------------------------------------------------------- validate */

/**
 * 驗證攻擊檔，回傳錯誤清單（空陣列 = 沒問題）。
 * @param {any} json
 * @returns {{path:string, message:string, id?:string, field?:string}[]}
 */
/**
 * 攻擊檔的「提示」（info 級；不是錯誤也不是警告，不影響能不能存檔／執行）。
 *
 * 目前只有一條（REALTEST-2 V16）：settings.bpm 已設定、時間軸其他事件多數用拍點（"2b"），
 * 但 `clear` / `end` 的 `at` 卻是純秒數 → 很可能是忘了換算（秒與拍混用是合法的，
 * 只是回合會在意料之外的時間清場／結束）。提示會附上換算後的拍數。
 *
 * @param {object} json 攻擊檔
 * @returns {{path:string, message:string, level:'info'}[]}
 */
export function attackHints(json) {
  const hints = [];
  if (!isObj(json) || !Array.isArray(json.timeline)) return hints;
  const timing = beatTimingOf(isObj(json.settings) ? json.settings : {});
  if (!timing.hasBpm) return hints;
  let beatCount = 0;
  let secondCount = 0;
  const suspects = [];
  json.timeline.forEach((ev, index) => {
    if (!isObj(ev)) return;
    const isBeat = parseBeatString(ev.at) !== null;
    const isSeconds = typeof ev.at === 'number' && Number.isFinite(ev.at);
    if (ev.type === 'clear' || ev.type === 'end') {
      if (isSeconds && ev.at > 0) suspects.push({ ev, index });
      return;
    }
    if (isBeat) beatCount += 1;
    else if (isSeconds && ev.at > 0) secondCount += 1;
  });
  // 其他事件「多數用拍點」才提示（至少 2 個，且比用秒的多）
  if (suspects.length === 0 || beatCount < 2 || beatCount <= secondCount) return hints;
  for (const { ev, index } of suspects) {
    const beats = Math.round(((ev.at - timing.beatOffset * timing.beatSec) / timing.beatSec) * 100) / 100;
    hints.push({
      path: `timeline[${index}].at`,
      level: 'info',
      message:
        `${ev.type} 事件的 at 是秒數 ${ev.at}（bpm ${timing.bpm} 下約為第 ${beats} 拍），` +
        `但其他事件多用拍點；若想對拍請改成拍點字串（例如 "${Math.max(0, Math.round(beats * 2) / 2)}b"），` +
        '想用秒數可忽略這則提示',
    });
  }
  return hints;
}

export function validateAttack(json) {
  const errors = [];
  const add = (path, message, extra) => {
    errors.push(extra ? { path, message, ...extra } : { path, message });
  };

  if (!isObj(json)) {
    add('$', '攻擊檔必須是 JSON 物件');
    return errors;
  }

  // 拍點設定（SPEC-EXPR-V2 §2）：時間欄位驗證要用
  const timing = beatTimingOf(isObj(json.settings) ? json.settings : {});

  if (json.format !== undefined && json.format !== ATTACK_FORMAT) {
    add('format', `格式應為 "${ATTACK_FORMAT}"，目前是 ${JSON.stringify(json.format)}`);
  }

  /* --- settings --- */
  if (json.settings !== undefined && !isObj(json.settings)) {
    add('settings', 'settings 必須是物件');
  } else {
    const s = isObj(json.settings) ? json.settings : {};
    if (s.duration !== undefined && !(num(s.duration, NaN) > 0)) {
      // 允許 duration 用拍點字串（"8b"），但要有 bpm
      const beatsDuration = parseBeatString(s.duration);
      if (beatsDuration === null) {
        add('settings.duration', 'duration 必須是大於 0 的秒數');
      } else if (!beatTimingOf(s).hasBpm) {
        add('settings.duration', beatMissingBpmMessage('settings.duration', s.duration));
      } else if (!(beatsDuration * beatTimingOf(s).beatSec > 0)) {
        add('settings.duration', 'duration 必須是大於 0 的秒數');
      }
    }
    if (s.seed !== undefined && !Number.isFinite(Number(s.seed))) {
      add('settings.seed', 'seed 必須是數字');
    }
    if (s.damage !== undefined && !(num(s.damage, NaN) >= 0)) {
      add('settings.damage', 'damage 必須是大於等於 0 的數字');
    }
    if (s.invincibleFrames !== undefined && !(num(s.invincibleFrames, NaN) >= 0)) {
      add('settings.invincibleFrames', 'invincibleFrames 必須是大於等於 0 的幀數');
    }
    if (s.grazeTP !== undefined && !(num(s.grazeTP, NaN) >= 0)) {
      add('settings.grazeTP', 'grazeTP 必須是大於等於 0 的數字');
    }
    if (s.background !== undefined && s.background !== null && typeof s.background !== 'string') {
      add('settings.background', 'background 必須是 sprite 名稱字串或 null');
    }
    if (s.bgm !== undefined && s.bgm !== null && typeof s.bgm !== 'string') {
      add('settings.bgm', 'bgm 必須是音效名稱字串或 null');
    }
    /* 拍點（SPEC-EXPR-V2 §2） */
    if (s.bpm !== undefined && s.bpm !== null) {
      if (!(num(s.bpm, NaN) > 0)) add('settings.bpm', 'bpm 必須是大於 0 的數字（例如 120）');
    }
    if (s.beatOffset !== undefined && s.beatOffset !== null && !Number.isFinite(Number(s.beatOffset))) {
      add('settings.beatOffset', 'beatOffset 必須是數字（秒）');
    }
  }

  /* --- box --- */
  if (json.box !== undefined && !isObj(json.box)) {
    add('box', 'box 必須是物件');
  } else {
    const b = isObj(json.box) ? json.box : {};
    for (const key of ['x', 'y', 'rotation', 'border']) {
      if (b[key] !== undefined && !Number.isFinite(Number(b[key]))) {
        add(`box.${key}`, `box.${key} 必須是數字`);
      }
    }
    if (b.w !== undefined && !(Number(b.w) > 0)) add('box.w', 'box.w 必須大於 0');
    if (b.h !== undefined && !(Number(b.h) > 0)) add('box.h', 'box.h 必須大於 0');
    if (b.color !== undefined && !(typeof b.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(b.color))) {
      add('box.color', '顏色需為 #rrggbb 形式');
    }
    if (b.appearance !== undefined && !BOX_APPEARANCES.includes(b.appearance)) {
      add('box.appearance', '戰鬥框樣式需為 classic、outline 或 hidden');
    }
  }

  if (json.arena !== undefined) {
    const spec = json.arena;
    if (!isObj(spec) || !ARENA_KINDS.includes(spec.kind)) add('arena.kind', '活動區需選擇 box、stage 或 polygon');
    else {
      if (spec.outline !== undefined && typeof spec.outline !== 'boolean') add('arena.outline', '邊線設定需為布林值');
      if (spec.fill !== undefined && spec.fill !== null && (typeof spec.fill !== 'string' || !/^#[0-9a-f]{6}$/i.test(spec.fill))) {
        add('arena.fill', '活動範圍底色需為 #rrggbb；省略或 null 表示不指定底色');
      }
      if (spec.fillAlpha !== undefined && spec.fillAlpha !== null
          && (!Number.isFinite(spec.fillAlpha) || spec.fillAlpha < 0 || spec.fillAlpha > 1)) {
        add('arena.fillAlpha', '底色不透明度需為 0–1 的數字；0 全透明，1（100%）不透明；省略或 null 使用 1');
      }
      if (spec.kind === 'polygon' && !compilePolygon(spec.points, ARENA_SOUL_RADIUS)) {
        add('arena.points', '活動區需有 3–64 個舞台內的頂點、邊線不得交叉，且需容得下靈魂');
      }
    }
  }
  const validClip = json.clipRegion === undefined || compilePolygon(json.clipRegion?.points);
  if (!validClip) add('clipRegion.points', '裁剪區需有 3–64 個舞台內的頂點，邊線不得交叉');
  // 動態裁剪區（「掃到才出現」）：motion.x / y / rotation 是數字或「回合時間 t（秒）」的運算式；pivot 是旋轉中心
  const motion = json.clipRegion?.motion;
  if (motion !== undefined) {
    if (!isObj(motion)) add('clipRegion.motion', '裁剪區動態設定必須是物件');
    else {
      for (const key of ['x', 'y', 'rotation']) {
        const v = motion[key];
        if (v === undefined || v === null || v === '' || (typeof v === 'number' && Number.isFinite(v))) continue;
        if (typeof v !== 'string') add(`clipRegion.motion.${key}`, '必須是數字或運算式字串');
        else if (compile(v).error) add(`clipRegion.motion.${key}`, compile(v).error);
      }
      const pv = motion.pivot;
      if (pv !== undefined && !(isObj(pv) && Number.isFinite(pv.x) && Number.isFinite(pv.y))) {
        add('clipRegion.motion.pivot', '旋轉中心需為 {x, y} 數字');
      }
    }
  }

  /* --- soul --- */
  if (json.soul !== undefined && !isObj(json.soul)) {
    add('soul', 'soul 必須是物件');
  } else {
    const s = isObj(json.soul) ? json.soul : {};
    if (s.speed !== undefined && !(num(s.speed, NaN) >= 0)) add('soul.speed', 'soul.speed 必須大於等於 0');
    if (s.slowSpeed !== undefined && !(num(s.slowSpeed, NaN) >= 0)) {
      add('soul.slowSpeed', 'soul.slowSpeed 必須大於等於 0');
    }
    if (s.mode !== undefined && s.mode !== 'red') {
      // Phase 1 只有 red 模式；其他值保留並提示，不算錯誤
      add('soul.mode', `Phase 1 僅支援 red 模式（目前 ${JSON.stringify(s.mode)}，將以 red 執行）`);
    }
    if (s.color !== undefined && s.color !== null && !(typeof s.color === 'string' && /^#[0-9a-f]{3,8}$/i.test(s.color))) {
      add('soul.color', '顏色需為 #rrggbb 形式');
    }
  }

  for (const { path, message } of compileSoulProfiles(json).errors) add(path, message);

  /* --- party --- */
  if (json.party !== undefined) {
    if (!Array.isArray(json.party)) {
      add('party', 'party 必須是陣列');
    } else if (json.party.length === 0) {
      add('party', 'party 至少需要一位隊員');
    } else {
      json.party.forEach((p, i) => {
        if (!isObj(p)) {
          add(`party[${i}]`, '隊員必須是物件');
          return;
        }
        if (typeof p.name !== 'string' || !p.name) add(`party[${i}].name`, '隊員需要名字');
        if (!(num(p.maxHp, NaN) > 0)) add(`party[${i}].maxHp`, 'maxHp 必須大於 0');
        if (!(num(p.hp, NaN) >= 0)) add(`party[${i}].hp`, 'hp 必須大於等於 0');
        else if (num(p.hp, 0) > num(p.maxHp, 0)) add(`party[${i}].hp`, 'hp 不可大於 maxHp');
      });
    }
  }

  /* --- enemies --- */
  if (json.enemies !== undefined) {
    if (!Array.isArray(json.enemies)) add('enemies', 'enemies 必須是陣列');
    else {
      json.enemies.forEach((e, i) => {
        if (!isObj(e)) {
          add(`enemies[${i}]`, '敵人必須是物件');
          return;
        }
        if (typeof e.sprite !== 'string' || !e.sprite) {
          add(`enemies[${i}].sprite`, '需要 sprite 名稱');
        }
        if (e.x !== undefined && !Number.isFinite(Number(e.x))) add(`enemies[${i}].x`, 'x 必須是數字');
        if (e.y !== undefined && !Number.isFinite(Number(e.y))) add(`enemies[${i}].y`, 'y 必須是數字');
      });
    }
  }

  /* --- bulletTypes --- */
  const bulletTypes = isObj(json.bulletTypes) ? json.bulletTypes : {};
  if (json.bulletTypes !== undefined && !isObj(json.bulletTypes)) {
    add('bulletTypes', 'bulletTypes 必須是物件');
  }
  for (const name of Object.keys(bulletTypes)) {
    const base = `bulletTypes.${name}`;
    const bt = bulletTypes[name];
    if (!isObj(bt)) {
      add(base, '子彈類型必須是物件');
      continue;
    }
    if (bt.sprite !== undefined && bt.sprite !== null && typeof bt.sprite !== 'string') {
      add(`${base}.sprite`, 'sprite 必須是 sprite 名稱或 null');
    }
    if (bt.frameRate !== undefined && !(num(bt.frameRate, NaN) >= 0)) {
      add(`${base}.frameRate`, 'frameRate 必須大於等於 0');
    }
    if (bt.scale !== undefined && !Number.isFinite(Number(bt.scale))) {
      add(`${base}.scale`, 'scale 必須是數字');
    }
    if (bt.damage !== undefined && bt.damage !== null && !(num(bt.damage, NaN) >= 0)) {
      add(`${base}.damage`, 'damage 必須大於等於 0 或 null');
    }
    if (bt.offscreen !== undefined && bt.offscreen !== 'destroy' && bt.offscreen !== 'keep') {
      add(`${base}.offscreen`, 'offscreen 只能是 "destroy" 或 "keep"');
    }
    if (bt.decor !== undefined && typeof bt.decor !== 'boolean') add(`${base}.decor`, 'decor 必須是布林');
    if (bt.shootable !== undefined && typeof bt.shootable !== 'boolean') add(base + '.shootable', '可擊破設定必須是布林值');
    if (bt.platform !== undefined && typeof bt.platform !== 'boolean') add(base + '.platform', '平台設定必須是布林值');
    if (bt.bounce !== undefined && !(Number.isFinite(bt.bounce) && bt.bounce >= 0)) add(base + '.bounce', '彈跳係數必須是 0 以上的數字');
    if (bt.hp !== undefined && !(Number.isInteger(bt.hp) && bt.hp >= 1 && bt.hp <= 99)) add(base + '.hp', '血量（要射中幾下才碎）必須是 1–99 的整數');
    if (bt.clipTo !== undefined && !CLIP_TARGETS.includes(bt.clipTo)) add(`${base}.clipTo`, '裁剪方式不正確');
    if (bt.clipTo === 'custom' && json.clipRegion === undefined) add(`${base}.clipTo`, '請先設定自訂裁剪區');
    const hb = isObj(bt.hitbox) ? bt.hitbox : null;
    if (!hb) {
      if (bt.decor === true && bt.hitbox === undefined) continue;
      add(`${base}.hitbox`, '缺少 hitbox（需為 circle 或 rect）');
    } else if (hb.shape !== 'circle' && hb.shape !== 'rect') {
      add(`${base}.hitbox.shape`, 'hitbox.shape 只能是 "circle" 或 "rect"');
    } else if (hb.shape === 'circle') {
      if (!(num(hb.r, NaN) >= 0)) add(`${base}.hitbox.r`, 'circle hitbox 需要大於等於 0 的 r');
    } else {
      if (!(num(hb.w, NaN) >= 0)) add(`${base}.hitbox.w`, 'rect hitbox 需要大於等於 0 的 w');
      if (!(num(hb.h, NaN) >= 0)) add(`${base}.hitbox.h`, 'rect hitbox 需要大於等於 0 的 h');
    }
  }

  /* --- timeline --- */
  if (json.timeline !== undefined && !Array.isArray(json.timeline)) {
    add('timeline', 'timeline 必須是陣列');
  } else {
    const timeline = Array.isArray(json.timeline) ? json.timeline : [];
    const seen = new Map();
    timeline.forEach((ev, i) => {
      const base = `timeline[${i}]`;
      if (!isObj(ev)) {
        add(base, '事件必須是物件');
        return;
      }
      const id = ev.id;
      if (id !== undefined) {
        if (typeof id !== 'string' || !id) {
          add(`${base}.id`, '事件 id 必須是非空字串');
        } else if (seen.has(id)) {
          add(`${base}.id`, `事件 id "${id}" 重複（先出現於 timeline[${seen.get(id)}]）`, {
            id,
            field: 'id',
          });
        } else {
          seen.set(id, i);
        }
      }
      if (!Number.isFinite(Number(ev.at)) && parseBeatString(ev.at) === null) {
        add(`${base}.at`, 'at 必須是秒數或拍點字串（例如 1.5 或 "2b"）');
      } else {
        validateTimeField(ev.at, `${base}.at`, add, timing, undefined, { label: 'at' });
      }
      const type = ev.type;
      if (typeof type !== 'string' || !EVENT_TYPES.includes(type)) {
        add(`${base}.type`, `未知事件類型（可用：${EVENT_TYPES.join(' / ')}）`);
        return;
      }
      const extra = typeof id === 'string' ? { id } : undefined;
      validateEvent(ev, base, type, bulletTypes, add, extra, timing);
    });
  }

  /* --- demo（SPEC-AUTOPLAY §2.1；實作在 engine/autoplay/validate.js） --- */
  try {
    // demo.path[].t 的拍點字串先換成秒（autoplay 驗證器只看數字），
    // 轉換前的字串值另外檢查，錯誤路徑仍指向原始位置。
    if (isObj(json.demo) && Array.isArray(json.demo.path)) {
      json.demo.path.forEach((point, i) => {
        if (!isObj(point)) return;
        const raw = point.t;
        if (parseBeatString(raw) === null) return;
        if (!timing.hasBpm) {
          add(`demo.path[${i}].t`, beatMissingBpmMessage('demo.path[].t', raw));
        }
      });
    }
    for (const demoError of validateAttackDemo(normalizeDemo(json.demo, timing))) {
      if (demoError && typeof demoError.path === 'string' && typeof demoError.message === 'string') {
        add(demoError.path, demoError.message);
      }
    }
  } catch (err) {
    // 驗證器本身出錯不能讓 validateAttack 拋例外
    add('demo', `示範腳本驗證失敗：${err && err.message ? err.message : err}`);
  }

  return errors;
}

/** 單一事件的型別檢查 */
function validateEvent(ev, base, type, bulletTypes, add, extra, timing) {
  const bulletNames = Object.keys(bulletTypes);
  const tm = timing || beatTimingOf(null);
  const checkBullet = (bullet, path) => {
    if (typeof bullet !== 'string' || !bullet) {
      add(path, '需要子彈類型名稱', extra);
      return;
    }
    if (bulletNames.length > 0 && !Object.prototype.hasOwnProperty.call(bulletTypes, bullet)) {
      add(path, `找不到子彈類型 "${bullet}"`, extra);
    }
  };
  const checkExpr = (value, path) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    const compiled = compile(value);
    if (compiled.error) add(path, compiled.error, extra);
  };
  const checkSpawn = (src, pathPrefix) => {
    for (const key of SPAWN_NUMERIC_FIELDS) {
      // life 是時間長度欄位：接受數字秒 / 拍點字串（需 bpm）/ 其他表達式字串
      // （SPEC §5「每個欄位可為數字或表達式字串」，life 也可在生成時求值）。
      if (key === 'life') {
        const raw = src[key];
        const isTimeLike = typeof raw === 'number' || parseBeatString(raw) !== null;
        if (isTimeLike) {
          validateTimeField(raw, `${pathPrefix}.${key}`, add, tm, extra, { label: 'life' });
        } else {
          checkExpr(raw, `${pathPrefix}.${key}`);
        }
        continue;
      }
      checkExpr(src[key], `${pathPrefix}.${key}`);
    }
    for (const key of SPAWN_PATH_FIELDS) {
      checkExpr(src[key], `${pathPrefix}.${key}`);
    }
    /* memory（SPEC-EXPR-V2 §3）：每顆子彈的記憶，名稱需為合法識別字 */
    if (src.memory !== undefined && src.memory !== null) {
      if (!isObj(src.memory)) {
        add(`${pathPrefix}.memory`, 'memory 必須是物件（{ 名稱: 數字或表達式 }）', extra);
      } else {
        for (const name of Object.keys(src.memory)) {
          if (!isValidMemoryName(name)) {
            add(
              `${pathPrefix}.memory`,
              `不允許的記憶名稱 "${name}"（需為合法識別字，且不可用 constructor / __proto__ 等保留名）`,
              extra,
            );
            continue;
          }
          const raw = src.memory[name];
          if (raw === null || raw === undefined) continue;
          if (typeof raw === 'number') {
            if (!Number.isFinite(raw)) add(`${pathPrefix}.memory.${name}`, `${name} 必須是有限數字或表達式`, extra);
            continue;
          }
          if (typeof raw !== 'string') {
            add(`${pathPrefix}.memory.${name}`, `${name} 必須是數字或表達式字串`, extra);
            continue;
          }
          if (raw.trim() === '') continue;
          checkExpr(raw, `${pathPrefix}.memory.${name}`);
        }
      }
    }
  };

  switch (type) {
    case 'anim': {
      for (const field of ['actor', 'anim']) {
        if (typeof ev[field] !== 'string' || !ev[field].trim()) {
          add(`${base}.${field}`, `${field} 必須是非空字串`, extra);
        }
      }
      break;
    }
    case 'spawn': {
      checkBullet(ev.bullet, `${base}.bullet`);
      if (ev.count !== undefined && !(int(ev.count, NaN) >= 1)) {
        add(`${base}.count`, 'count 必須是大於等於 1 的整數', extra);
      }
      checkSpawn(ev, base);
      break;
    }
    case 'emitter': {
      // duration / interval：秒數或拍點字串（SPEC-EXPR-V2 §2）
      if (parseBeatString(ev.duration) !== null) {
        validateTimeField(ev.duration, `${base}.duration`, add, tm, extra, { label: 'emitter duration' });
        const beats = parseBeatString(ev.duration);
        if (beats !== null && beats <= 0 && tm.hasBpm) {
          add(`${base}.duration`, 'emitter 需要大於 0 的 duration', extra);
        }
      } else if (!(num(ev.duration, NaN) > 0)) {
        add(`${base}.duration`, 'emitter 需要大於 0 的 duration', extra);
      }
      if (parseBeatString(ev.interval) !== null) {
        validateTimeField(ev.interval, `${base}.interval`, add, tm, extra, { label: 'emitter interval' });
        const beats = parseBeatString(ev.interval);
        if (beats !== null && beats <= 0 && tm.hasBpm) {
          add(`${base}.interval`, 'emitter 需要大於 0 的 interval', extra);
        }
      } else if (!(num(ev.interval, NaN) > 0)) {
        add(`${base}.interval`, 'emitter 需要大於 0 的 interval', extra);
      }
      if (ev.count !== undefined && !(int(ev.count, NaN) >= 1)) {
        add(`${base}.count`, 'count 必須是大於等於 1 的整數', extra);
      }
      const spawn = isObj(ev.spawn) ? ev.spawn : null;
      if (!spawn) {
        add(`${base}.spawn`, 'emitter 需要 spawn 物件', extra);
      } else {
        checkBullet(spawn.bullet, `${base}.spawn.bullet`);
        checkSpawn(spawn, `${base}.spawn`);
      }
      break;
    }
    case 'box': {
      if (parseBeatString(ev.duration) !== null) {
        validateTimeField(ev.duration, `${base}.duration`, add, tm, extra, { label: 'box duration' });
      } else if (!(num(ev.duration, NaN) > 0)) {
        add(`${base}.duration`, 'box 事件需要大於 0 的 duration', extra);
      }
      if (ev.ease !== undefined && !EASING_NAMES.includes(ev.ease)) {
        add(`${base}.ease`, `未知 easing（可用：${EASING_NAMES.join(' / ')}）`, extra);
      }
      const to = isObj(ev.to) ? ev.to : null;
      if (!to) {
        add(`${base}.to`, 'box 事件需要 to 物件', extra);
      } else {
        const keys = ['x', 'y', 'w', 'h', 'rotation'].filter((k) => to[k] !== undefined);
        if (keys.length === 0) add(`${base}.to`, 'to 至少要指定 x / y / w / h / rotation 其中一項', extra);
        for (const k of keys) {
          if (!Number.isFinite(Number(to[k]))) add(`${base}.to.${k}`, `to.${k} 必須是數字`, extra);
        }
        if (to.w !== undefined && !(Number(to.w) > 0)) add(`${base}.to.w`, 'to.w 必須大於 0', extra);
        if (to.h !== undefined && !(Number(to.h) > 0)) add(`${base}.to.h`, 'to.h 必須大於 0', extra);
      }
      break;
    }
    case 'soul': {
      if (ev.mode !== undefined && ev.mode !== 'red') {
        add(`${base}.mode`, 'Phase 1 僅支援 red 模式', extra);
      }
      for (const k of ['x', 'y']) {
        if (ev[k] !== undefined && ev[k] !== null && !Number.isFinite(Number(ev[k]))) {
          add(`${base}.${k}`, `${k} 必須是數字或 null`, extra);
        }
      }
      break;
    }
    case 'clear': {
      if (parseBeatString(ev.fade) !== null) {
        validateTimeField(ev.fade, `${base}.fade`, add, tm, extra, { label: 'fade' });
      } else if (ev.fade !== undefined && !(num(ev.fade, NaN) >= 0)) {
        add(`${base}.fade`, 'fade 必須大於等於 0 秒', extra);
      }
      break;
    }
    case 'shake': {
      if (parseBeatString(ev.duration) !== null) {
        validateTimeField(ev.duration, `${base}.duration`, add, tm, extra, { label: 'shake duration' });
      } else if (!(num(ev.duration, NaN) >= 0)) {
        add(`${base}.duration`, 'shake 需要大於等於 0 的 duration', extra);
      }
      if (!(num(ev.amount, NaN) >= 0)) add(`${base}.amount`, 'shake 需要大於等於 0 的 amount', extra);
      break;
    }
    case 'sfx': {
      if (typeof ev.sound !== 'string' || !ev.sound) add(`${base}.sound`, 'sfx 需要音效名稱', extra);
      break;
    }
    case 'end':
    default:
      break;
  }
}

export default normalizeAttack;
