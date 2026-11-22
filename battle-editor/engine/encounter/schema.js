/**
 * engine/encounter/schema.js — 遭遇檔格式（SPEC-P2 §1）
 *
 * 職責：
 *   1. `normalizeEncounter(json)`：補齊所有預設值、轉型，永不 throw（壞資料也能跑）。
 *   2. `validateEncounter(json)`：回傳 `[{ path, message }]`，給編輯器標紅用。
 *   3. `CUE_COMMANDS`：§3 全部演出指令的參數定義，匯出給編輯器（ED2 cue-schema.js
 *      必須與此一致，並以此為比對來源）。
 *
 * 設計原則：
 *   - 未知欄位一律保留（向前相容：編輯器可能先加欄位，引擎後支援）。
 *   - 文字欄位接受字串或 `{ zh, en }`（zh 為簡體），由 pickText() 依語言取用。
 *   - 引擎不碰 DOM、不做 I/O，純資料處理。
 */

import { validateExprSyntax } from '../expr.js';
// 演示腳本驗證（SPEC-AUTOPLAY §2.2）。獨立檔以免與 AP1 的 validate.js 互相衝突；
// 該模組零 import，不會造成循環依賴。
import { validateEncounterDemo } from '../autoplay/validate-encounter.js';

/** 遭遇檔格式代號 */
export const ENCOUNTER_FORMAT = 'dr-battle-encounter/1';

/** 支援的戰鬥語言（SPEC-P2 §0：zh 簡體、en 英文） */
export const LANGS = ['zh', 'en'];

/** 終局結果 */
export const RESULT_TYPES = ['victory', 'spared', 'defeat', 'flee'];

/** 回合順序 */
export const TURN_ORDERS = ['sequential', 'loop-last', 'random'];
export const TURN_CUE_KEYS = ['start', 'beforeAttack', 'end'];

/** 回合階段（§2 狀態機 + §5 state.phase） */
export const PHASES = [
  'intro',
  'turnStart',
  'menu',
  'resolve',
  'enemyTalk',
  'beforeAttack',
  'attack',
  'turnEnd',
  'victory',
  'spared',
  'defeat',
  'flee',
];

/** 時機掛鉤名稱 */
export const HOOK_NAMES = ['intro', 'victory', 'spared', 'defeat', 'flee'];

/** 指令分類（給編輯器「新增指令」選單分組用） */
export const CUE_CATEGORIES = [
  { id: 'text', name: '文字' },
  { id: 'actor', name: '演員' },
  { id: 'audio', name: '音效' },
  { id: 'camera', name: '鏡頭' },
  { id: 'value', name: '數值' },
  { id: 'flow', name: '流程' },
];

/**
 * §3 演出指令定義。
 *
 * 每條指令：
 *   cmd       指令名稱
 *   category  分類 id（對應 CUE_CATEGORIES）
 *   blocking  預設是否阻塞（async:true 可覆寫；本身永遠非阻塞的指令 blocking=false）
 *   params    參數表：name → { type, required?, default?, values?, nullable?, desc? }
 *
 * type 值：text（字串或 {zh,en}）、string、number、bool、enum、color、actor、sprite、
 *          sound、attack、target、expr、cues、ease、any
 */
export const CUE_COMMANDS = {
  say: {
    category: 'text',
    blocking: true,
    params: {
      text: { type: 'text', required: true, desc: '台詞（支援 §3 文字標記）' },
      speaker: { type: 'text', desc: '說話者名稱' },
      portrait: { type: 'sprite', desc: '頭像 sprite 名' },
      speed: { type: 'number', default: 1, desc: '打字速度（字/幀）' },
      voice: { type: 'sound', desc: '每字播放的音效' },
      win: { type: 'bool', default: false, desc: '這句就是勝利旁白：victory/spared 掛鉤裡有它時，引擎不再在掛鉤後補一句「你赢了！」（用來讓演出和勝利旁白同時進行，例如包在 parallel 裡）' },
    },
  },
  bubble: {
    category: 'text',
    blocking: true,
    params: {
      actor: { type: 'actor', required: true, desc: '說話的演員' },
      text: { type: 'text', required: true, desc: '泡泡文字' },
      side: { type: 'enum', values: ['left', 'right', 'auto'], default: 'auto', desc: '泡泡在演員哪一側' },
      speed: { type: 'number', default: 1, desc: '打字速度（字/幀）' },
      wait: { type: 'any', default: 'input', desc: '"input" 等按鍵，或秒數逾時' },
    },
  },
  move: {
    category: 'actor',
    blocking: true,
    params: {
      actor: { type: 'actor', required: true },
      x: { type: 'number', desc: '目標 x（省略 = 不動）' },
      y: { type: 'number', desc: '目標 y（省略 = 不動）' },
      relative: { type: 'bool', default: false, desc: 'x/y 是否為相對位移' },
      duration: { type: 'number', default: 0.5, desc: '補間秒數' },
      ease: { type: 'ease', default: 'quadOut' },
    },
  },
  anim: {
    category: 'actor',
    blocking: false,
    params: {
      actor: { type: 'actor', required: true },
      anim: { type: 'string', desc: '動畫狀態名（anims 的 key）' },
      sprite: { type: 'sprite', desc: '直接指定 sprite（覆寫狀態）' },
      fps: { type: 'number', desc: '覆寫播放速度' },
      loop: { type: 'bool', desc: '覆寫是否循環' },
      waitEnd: { type: 'bool', default: false, desc: '等非循環動畫播完才繼續' },
    },
  },
  form: {
    category: 'actor',
    blocking: false,
    params: {
      actor: { type: 'actor', required: true, desc: '要變身的演員' },
      name: { type: 'string', required: true, nullable: true, desc: '形態名（actor.forms 的 key）；null 切回基礎形態' },
      anim: { type: 'string', desc: '切換後要播的動畫（省略 = 沿用目前動畫名，沒有就 idle）' },
    },
  },
  flip: {
    category: 'actor',
    blocking: false,
    params: {
      actor: { type: 'actor', required: true },
      value: { type: 'bool', default: true, desc: '是否水平翻轉' },
    },
  },
  fade: {
    category: 'actor',
    blocking: true,
    params: {
      actor: { type: 'actor', required: true },
      alpha: { type: 'number', required: true, desc: '目標透明度 0..1' },
      duration: { type: 'number', default: 0.5, desc: '補間秒數' },
    },
  },
  wait: {
    category: 'flow',
    blocking: true,
    params: {
      seconds: { type: 'number', default: 0.5, desc: '等待秒數' },
    },
  },
  sfx: {
    category: 'audio',
    blocking: false,
    params: {
      sound: { type: 'sound', required: true, desc: '音效索引名' },
    },
  },
  bgm: {
    category: 'audio',
    blocking: false,
    params: {
      track: { type: 'string', nullable: true, desc: '音樂名；null = 停止' },
      fade: { type: 'number', default: 0, desc: '淡出秒數（0 = 立即）' },
    },
  },
  shake: {
    category: 'camera',
    blocking: true,
    params: {
      amount: { type: 'number', default: 4, desc: '震動像素' },
      duration: { type: 'number', default: 0.3, desc: '震動秒數' },
    },
  },
  flash: {
    category: 'camera',
    blocking: true,
    params: {
      color: { type: 'color', default: '#ffffff', desc: '閃光顏色' },
      duration: { type: 'number', default: 0.2, desc: '閃光秒數' },
    },
  },
  set: {
    category: 'value',
    blocking: false,
    params: {
      var: { type: 'string', required: true, desc: '自訂變數名' },
      value: { type: 'expr', default: 0, desc: '數值或表達式' },
      op: { type: 'enum', values: ['set', 'add'], default: 'set', desc: '覆寫或累加' },
    },
  },
  mercy: {
    category: 'value',
    blocking: false,
    params: {
      enemy: { type: 'actor', required: true, desc: '敵人 id' },
      amount: { type: 'expr', default: 0, desc: '增加量（夾在 0..100；可為表達式）' },
    },
  },
  heal: {
    category: 'value',
    blocking: false,
    params: {
      target: { type: 'target', required: true, desc: '隊員 id / 敵人 id / "party"' },
      amount: { type: 'expr', default: 0, desc: '回復量（可為表達式）' },
    },
  },
  item: {
    category: 'value',
    blocking: false,
    params: {
      id: { type: 'string', required: true, desc: '這場遭遇 items 裡的道具 id' },
      delta: { type: 'expr', default: 1, desc: '增減數量（負數為消耗；減到 0 為止）' },
    },
  },
  damage: {
    category: 'value',
    blocking: false,
    params: {
      target: { type: 'target', required: true, desc: '隊員 id / 敵人 id / "party"' },
      amount: { type: 'expr', default: 0, desc: '傷害量（可為表達式）' },
    },
  },
  if: {
    category: 'flow',
    blocking: true,
    params: {
      cond: { type: 'expr', required: true, desc: '條件表達式（非 0 為真）' },
      then: { type: 'cues', default: [], desc: '條件成立時執行' },
      else: { type: 'cues', default: [], desc: '條件不成立時執行' },
    },
  },
  parallel: {
    category: 'flow',
    blocking: true,
    params: {
      cues: { type: 'cues', default: [], desc: '同時執行的子指令' },
    },
  },
  attack: {
    category: 'flow',
    blocking: true,
    params: {
      attack: { type: 'attack', required: true, desc: '攻擊檔名或內嵌攻擊物件' },
    },
  },
  end: {
    category: 'flow',
    blocking: false,
    params: {
      result: { type: 'enum', values: RESULT_TYPES, default: 'victory', desc: '終局結果' },
    },
  },
};

/** 指令名稱清單（依宣告順序） */
export const CUE_COMMAND_NAMES = Object.keys(CUE_COMMANDS);

/** 內建演員動畫狀態名（§3；未定義的狀態退回 idle） */
export const PARTY_ANIM_STATES = [
  'idle',
  'attack',
  'act',
  'magic',
  'item',
  'spare',
  'defend',
  'hurt',
  'down',
  'victory',
];
/** 敵人內建動畫狀態名 */
export const ENEMY_ANIM_STATES = ['idle', 'hurt', 'spared', 'defeat'];

/* ===================================================================== */
/* 小工具                                                                */
/* ===================================================================== */

/** 是否為純物件（排除 null / 陣列） */
export function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 轉數字；不合法回退 default（永不 NaN） */
export function num(v, def = 0) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : def;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return def;
}

/** 轉布林（字串 "false"/"0" 視為 false） */
export function bool(v, def = false) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase();
    if (s === 'true' || s === '1' || s === 'yes') return true;
    if (s === 'false' || s === '0' || s === 'no' || s === '') return false;
  }
  return def;
}

/** 文字欄位 → 依語言取字串（字串原樣回傳） */
export function pickText(value, lang = 'zh') {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (isPlainObject(value)) {
    const l = LANGS.includes(lang) ? lang : 'zh';
    const v = value[l];
    if (typeof v === 'string') return v;
    const zh = value.zh;
    if (typeof zh === 'string') return zh;
    const en = value.en;
    if (typeof en === 'string') return en;
  }
  return '';
}

/** 文字欄位是否合法（字串，或 {zh?,en?}） */
export function isTextValue(v) {
  if (typeof v === 'string') return true;
  if (!isPlainObject(v)) return false;
  for (const k of Object.keys(v)) {
    if (!LANGS.includes(k)) return false;
    if (typeof v[k] !== 'string') return false;
  }
  return true;
}

/** 深拷貝（JSON 安全；保留未知欄位） */
export function deepClone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(deepClone);
  const out = {};
  for (const k of Object.keys(v)) out[k] = deepClone(v[k]);
  return out;
}

/** 正規化文字欄位（保留原字串 / {zh,en} 形狀，非法值轉空字串） */
function textField(v, def = '') {
  if (typeof v === 'string') return v;
  if (isPlainObject(v)) {
    const out = {};
    for (const k of Object.keys(v)) if (LANGS.includes(k) && typeof v[k] === 'string') out[k] = v[k];
    if (Object.keys(out).length > 0) return out;
    return def;
  }
  if (v === null || v === undefined) return def;
  if (typeof v === 'number') return String(v);
  return def;
}

/* ===================================================================== */
/* 正規化：演員 / 動畫                                                    */
/* ===================================================================== */

/**
 * 正規化單一動畫狀態。
 * `{ sprite, fps, loop, then? }`；另有兩個選填擴充：
 *   frames   總幀數（用於計算非循環動畫長度；省略時由 encounter 世界向素材索引查實際幀數）
 *   duration 秒數（frames 未提供時的長度）
 *   scale    此狀態的額外縮放（乘上演員 scale；例如本體 1.5、偽裝 1）
 *   flip     此狀態固定的水平翻轉（省略 = 沿用演員 flip）
 */
export function defaultAnimLoop(name) {
  return name === 'idle' || (!PARTY_ANIM_STATES.includes(name) && !ENEMY_ANIM_STATES.includes(name));
}

export function normalizeAnim(json, name) {
  const src = isPlainObject(json) ? json : {};
  const out = deepClone(src);
  out.sprite = typeof src.sprite === 'string' ? src.sprite : '';
  out.fps = Math.max(0, num(src.fps, 10));
  out.loop = bool(src.loop, defaultAnimLoop(name));
  out.then = typeof src.then === 'string' && src.then ? src.then : null;
  if (src.frames !== undefined) out.frames = Math.max(0, Math.round(num(src.frames, 0)));
  if (src.duration !== undefined) out.duration = Math.max(0, num(src.duration, 0));
  if (src.scale !== undefined) out.scale = Math.max(0.01, num(src.scale, 1));
  if (src.flip !== undefined) out.flip = bool(src.flip, false);
  return out;
}

/**
 * 動畫總幀數：`frames` 優先；省略時用素材實際幀數（由 encounter 世界的
 * spriteFrames(name) 查詢提供）。0 = 未知（退回 duration / 1 秒規則）。
 */
export function animTotalFrames(anim, spriteFrames) {
  if (!isPlainObject(anim)) return 0;
  const explicit = Math.round(num(anim.frames, 0));
  if (explicit > 0) return explicit;
  const fromSprite = Math.round(num(spriteFrames, 0));
  return fromSprite > 0 ? fromSprite : 0;
}

/**
 * 非循環動畫長度（秒）：frames（或素材實際幀數）/fps → duration → 1 秒。
 *
 * @param {object} anim 正規化後的動畫
 * @param {number} [spriteFrames] 素材實際幀數（省略時只能用 frames / duration）
 */
export function animDuration(anim, spriteFrames) {
  if (!isPlainObject(anim)) return 0;
  const fps = Math.max(0, num(anim.fps, 10));
  const total = animTotalFrames(anim, spriteFrames);
  if (total > 0 && fps > 0) return total / fps;
  if (num(anim.duration, 0) > 0) return num(anim.duration, 0);
  return 1;
}

/** 正規化演員定義 */
export function normalizeActor(json, id) {
  const src = isPlainObject(json) ? json : {};
  const out = deepClone(src);
  out.id = typeof src.id === 'string' && src.id ? src.id : id;
  out.kind = src.kind === 'party' ? 'party' : 'enemy';
  out.x = num(src.x, out.kind === 'party' ? 120 : 520);
  out.y = num(src.y, 200);
  out.flip = bool(src.flip, false);
  out.alpha = Math.max(0, Math.min(1, num(src.alpha, 1)));
  out.scale = num(src.scale, 1);
  // 精靈原始高度（選填）：泡泡要靠它對齊頭部（SPEC-LAYOUT §8）；沒給就用預設值
  out.spriteH = Math.max(1, num(src.spriteH, num(src.h, 32)));
  out.layer = num(src.layer, 0);
  out.visible = bool(src.visible, true);
  const anims = {};
  if (isPlainObject(src.anims)) {
    for (const name of Object.keys(src.anims)) anims[name] = normalizeAnim(src.anims[name], name);
  }
  out.anims = anims;
  // 形態（SPEC-P2 §1 forms）：{ name: { anims, scale?, offset? } }；
  // form = 初始形態名（省略 / 未知 → null = 基礎動畫）
  if (isPlainObject(src.forms)) {
    const forms = {};
    for (const name of Object.keys(src.forms)) {
      const f = isPlainObject(src.forms[name]) ? src.forms[name] : {};
      const formOut = deepClone(f);
      const fanims = {};
      if (isPlainObject(f.anims)) {
        for (const st of Object.keys(f.anims)) fanims[st] = normalizeAnim(f.anims[st], st);
      }
      formOut.anims = fanims;
      if (f.scale !== undefined && f.scale !== null) formOut.scale = Math.max(0.01, num(f.scale, 1));
      else delete formOut.scale;
      if (isPlainObject(f.offset)) formOut.offset = { x: num(f.offset.x, 0), y: num(f.offset.y, 0) };
      else delete formOut.offset;
      forms[name] = formOut;
    }
    out.forms = forms;
    out.form = typeof src.form === 'string' && src.form && forms[src.form] ? src.form : null;
  } else {
    delete out.forms;
    out.form = null;
  }
  out.initialAnim = typeof src.initialAnim === 'string' ? src.initialAnim : 'idle';
  return out;
}

/* ===================================================================== */
/* 正規化：隊伍 / 敵人 / 道具                                             */
/* ===================================================================== */

export const PARTY_COMMANDS = ['fight', 'act', 'magic', 'item', 'spare', 'defend'];

/** 正規化隊伍成員 */
export function normalizePartyMember(json, i) {
  const src = isPlainObject(json) ? json : {};
  const out = deepClone(src);
  out.id = typeof src.id === 'string' && src.id ? src.id : `party${i}`;
  out.actor = typeof src.actor === 'string' && src.actor ? src.actor : null;
  out.name = textField(src.name, out.id);
  out.maxHp = Math.max(1, Math.round(num(src.maxHp, 100)));
  out.hp = Math.max(0, Math.min(out.maxHp, Math.round(num(src.hp, out.maxHp))));
  out.atk = num(src.atk, 10);
  out.def = num(src.def, 0);
  out.magic = num(src.magic, 0);
  out.color = typeof src.color === 'string' && src.color ? src.color : '#ffff00';
  out.icon = typeof src.icon === 'string' && src.icon ? src.icon : null;
  const cmds = Array.isArray(src.commands) ? src.commands.filter((c) => PARTY_COMMANDS.includes(c)) : null;
  out.commands = cmds && cmds.length > 0 ? cmds : ['fight', 'act', 'item', 'spare', 'defend'];
  out.spells = Array.isArray(src.spells)
    ? src.spells.map((s, si) => {
        const ss = isPlainObject(s) ? s : {};
        const so = deepClone(ss);
        so.id = typeof ss.id === 'string' && ss.id ? ss.id : `spell${si}`;
        so.name = textField(ss.name, so.id);
        so.tp = Math.max(0, num(ss.tp, 0));
        so.target = ['enemy', 'party', 'all'].includes(ss.target) ? ss.target : 'enemy';
        so.cues = Array.isArray(ss.cues) ? ss.cues.map((c) => normalizeCue(c)) : [];
        return so;
      })
    : [];
  return out;
}

/** 正規化敵人 */
export function normalizeEnemy(json, i) {
  const src = isPlainObject(json) ? json : {};
  const out = deepClone(src);
  out.id = typeof src.id === 'string' && src.id ? src.id : `enemy${i}`;
  out.actor = typeof src.actor === 'string' && src.actor ? src.actor : null;
  out.name = textField(src.name, out.id);
  out.maxHp = Math.max(1, Math.round(num(src.maxHp, 100)));
  out.hp = Math.max(0, Math.min(out.maxHp, Math.round(num(src.hp, out.maxHp))));
  out.atk = num(src.atk, 5);
  out.def = num(src.def, 0);
  out.mercy = Math.max(0, Math.min(100, num(src.mercy, 0)));
  out.spareAt = Math.max(0, Math.min(100, num(src.spareAt, 100)));
  out.tired = bool(src.tired, false);
  out.acts = Array.isArray(src.acts) ? src.acts.map((a, ai) => normalizeAct(a, ai)) : [];
  out.onHurt = normalizeCueList(src.onHurt);
  out.onSpare = normalizeCueList(src.onSpare);
  out.onDefeat = normalizeCueList(src.onDefeat);
  return out;
}

/** 正規化一個 ACT */
export function normalizeAct(json, i) {
  const src = isPlainObject(json) ? json : {};
  const out = deepClone(src);
  out.id = typeof src.id === 'string' && src.id ? src.id : `act${i}`;
  out.name = textField(src.name, out.id);
  out.text = src.text === undefined || src.text === null ? null : textField(src.text, '');
  out.party = Array.isArray(src.party) ? src.party.filter((p) => typeof p === 'string') : [];
  out.autoAnim = bool(src.autoAnim, true);
  out.mercy = Math.max(0, Math.min(100, num(src.mercy, 0)));
  out.cues = normalizeCueList(src.cues);
  return out;
}

/** 正規化道具 */
export function normalizeItem(json, i) {
  const src = isPlainObject(json) ? json : {};
  const out = deepClone(src);
  out.id = typeof src.id === 'string' && src.id ? src.id : `item${i}`;
  out.name = textField(src.name, out.id);
  out.count = Math.max(0, Math.round(num(src.count, 1)));
  out.heal = num(src.heal, 0);
  out.revive = bool(src.revive, false);
  out.target = ['party', 'enemy', 'all'].includes(src.target) ? src.target : 'party';
  out.text = src.text === undefined || src.text === null ? null : textField(src.text, '');
  return out;
}

/* ===================================================================== */
/* 正規化：指令（cue）                                                    */
/* ===================================================================== */

/** 依 CUE_COMMANDS 的 default 補齊參數（保留未知欄位） */
function applyCueDefaults(cmd, out) {
  const def = CUE_COMMANDS[cmd];
  if (!def) return out;
  for (const name of Object.keys(def.params)) {
    const p = def.params[name];
    if (out[name] !== undefined) continue;
    if (p.default !== undefined) out[name] = deepClone(p.default);
    else if (p.required) out[name] = p.nullable ? null : undefined;
    else out[name] = p.nullable ? null : undefined;
  }
  return out;
}

/** 正規化單一指令（含巢狀 then / else / cues） */
export function normalizeCue(json) {
  const src = isPlainObject(json) ? json : {};
  const out = deepClone(src);
  out.cmd = typeof src.cmd === 'string' && src.cmd ? src.cmd : 'wait';
  out.async = bool(src.async, false);
  switch (out.cmd) {
    case 'if':
      out.then = normalizeCueList(src.then);
      out.else = normalizeCueList(src.else);
      if (out.cond === undefined) out.cond = 0;
      break;
    case 'parallel':
      out.cues = normalizeCueList(src.cues);
      break;
    case 'move':
      out.duration = num(src.duration, 0.5);
      out.relative = bool(src.relative, false);
      out.ease = typeof src.ease === 'string' ? src.ease : 'quadOut';
      break;
    case 'fade':
      out.alpha = Math.max(0, Math.min(1, num(src.alpha, 1)));
      out.duration = num(src.duration, 0.5);
      break;
    case 'wait':
      out.seconds = Math.max(0, num(src.seconds, 0.5));
      break;
    case 'shake':
      out.amount = num(src.amount, 4);
      out.duration = num(src.duration, 0.3);
      break;
    case 'flash':
      out.color = typeof src.color === 'string' ? src.color : '#ffffff';
      out.duration = num(src.duration, 0.2);
      break;
    case 'say':
      out.speed = num(src.speed, 1);
      break;
    case 'bubble':
      out.speed = num(src.speed, 1);
      if (out.side === undefined) out.side = 'auto';
      if (out.wait === undefined) out.wait = 'input';
      break;
    case 'anim':
      out.waitEnd = bool(src.waitEnd, false);
      break;
    case 'set':
      out.op = src.op === 'add' ? 'add' : 'set';
      if (out.value === undefined) out.value = 0;
      break;
    case 'mercy':
      // amount 可為數字或表達式（例如 "max(0, min(10, 94 - mercy.boss))"）：和 heal / damage 一樣保留原樣，
      // 執行時才由 cues.js 求值。原本 num() 會把表達式字串變成 0，整場 ACT 都加不到仁慈。
      out.amount = src.amount === undefined ? 0 : src.amount;
      break;
    case 'heal':
    case 'damage':
      out.amount = src.amount === undefined ? 0 : src.amount;
      break;
    case 'bgm':
      out.fade = num(src.fade, 0);
      break;
    case 'end':
      out.result = RESULT_TYPES.includes(src.result) ? src.result : 'victory';
      break;
    default:
      break;
  }
  return applyCueDefaults(out.cmd, out);
}

/** 正規化指令清單 */
export function normalizeCueList(list) {
  if (!Array.isArray(list)) return [];
  return list.map((c) => normalizeCue(c));
}

/* ===================================================================== */
/* 正規化：回合 / 遭遇                                                    */
/* ===================================================================== */

/** 正規化一回合 */
export function normalizeTurn(json, i) {
  const src = isPlainObject(json) ? json : {};
  const out = deepClone(src);
  out.id = typeof src.id === 'string' && src.id ? src.id : `turn${i}`;
  out.flavor = src.flavor === undefined || src.flavor === null ? null : textField(src.flavor, '');
  out.talk = Array.isArray(src.talk)
    ? src.talk.map((t) => {
        const ts = isPlainObject(t) ? t : {};
        const to = deepClone(ts);
        to.actor = typeof ts.actor === 'string' ? ts.actor : '';
        to.text = textField(ts.text, '');
        to.parallel = bool(ts.parallel, false);
        to.speed = num(ts.speed, 1);
        return to;
      })
    : [];
  out.attack = normalizeAttackRef(src.attack);
  for (const key of TURN_CUE_KEYS) out[key] = normalizeCueList(src[key]);
  return out;
}

/** 攻擊參照：檔名字串 / 內嵌攻擊物件 / null */
export function normalizeAttackRef(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'string') return v;
  if (isPlainObject(v)) return deepClone(v);
  return null;
}

/**
 * 正規化整份遭遇檔。永不 throw。
 * @param {object} json
 * @returns {object} 正規化後的遭遇（深拷貝）
 */
export function normalizeEncounter(json) {
  const src = isPlainObject(json) ? json : {};
  const out = deepClone(src);

  out.format = typeof src.format === 'string' && src.format ? src.format : ENCOUNTER_FORMAT;

  extendsSafe(out, 'meta', isPlainObject(src.meta) ? src.meta : {}, (m, s) => {
    m.name = textField(s.name, '未命名遭遇');
    m.author = textField(s.author, '');
  });

  extendsSafe(out, 'settings', isPlainObject(src.settings) ? src.settings : {}, (s, ss) => {
    s.seed = num(ss.seed, 1);
    s.bgm = typeof ss.bgm === 'string' && ss.bgm ? ss.bgm : null;
    s.background = typeof ss.background === 'string' && ss.background ? ss.background : null;
    s.introText = ss.introText === undefined || ss.introText === null ? '' : textField(ss.introText, '');
    s.canFlee = bool(ss.canFlee, false);
    // 選用：隊員站位覆寫 { x, feet:[...], stagger }（預設 SPEC-LAYOUT §3 的 x≈128、腳底 140/230/322）
    s.partyLayout = null;
    if (isPlainObject(ss.partyLayout)) {
      const pl = ss.partyLayout;
      s.partyLayout = {
        x: Number.isFinite(Number(pl.x)) ? Number(pl.x) : null,
        feet: Array.isArray(pl.feet) ? pl.feet.map((v) => num(v, 240)) : null,
        stagger: Number.isFinite(Number(pl.stagger)) ? Number(pl.stagger) : null,
      };
    }
  });

  // 演員
  const actorsSrc = isPlainObject(src.actors) ? src.actors : {};
  const actors = {};
  for (const id of Object.keys(actorsSrc)) actors[id] = normalizeActor(actorsSrc[id], id);
  out.actors = actors;

  out.party = Array.isArray(src.party) ? src.party.map((p, i) => normalizePartyMember(p, i)) : [];
  out.enemies = Array.isArray(src.enemies) ? src.enemies.map((e, i) => normalizeEnemy(e, i)) : [];
  out.items = Array.isArray(src.items) ? src.items.map((it, i) => normalizeItem(it, i)) : [];
  out.turns = Array.isArray(src.turns) ? src.turns.map((t, i) => normalizeTurn(t, i)) : [];

  out.turnOrder = TURN_ORDERS.includes(src.turnOrder) ? src.turnOrder : 'loop-last';

  const hooksSrc = isPlainObject(src.hooks) ? src.hooks : {};
  const hooks = {};
  for (const name of HOOK_NAMES) hooks[name] = normalizeCueList(hooksSrc[name]);
  out.hooks = hooks;

  // 自訂變數：只留有限數
  const varsSrc = isPlainObject(src.vars) ? src.vars : {};
  const vars = {};
  for (const k of Object.keys(varsSrc)) vars[k] = num(varsSrc[k], 0);
  out.vars = vars;

  return out;
}

/** 在保留未知欄位的前提下，把已知欄位寫進既有物件 */
function extendsSafe(target, key, srcObj, fill) {
  const base = isPlainObject(target[key]) ? target[key] : {};
  const clone = deepClone(srcObj);
  const merged = { ...clone, ...base };
  fill(merged, srcObj);
  target[key] = merged;
}

/* ===================================================================== */
/* 驗證                                                                  */
/* ===================================================================== */

/**
 * 驗證 anims 物件（演員基礎動畫與形態動畫共用；SPEC-P2 §1 / §3）。
 * @param {any} anims
 * @param {string} path
 * @param {(path:string, message:string)=>void} push
 */
function validateAnimsField(anims, path, push) {
  if (!isPlainObject(anims)) {
    push(path, 'anims 必須是物件（狀態名 → 動畫）');
    return;
  }
  for (const st of Object.keys(anims)) {
    const anim = anims[st];
    if (!isPlainObject(anim)) {
      push(`${path}.${st}`, '動畫定義必須是物件');
      continue;
    }
    if (typeof anim.sprite !== 'string' || !anim.sprite) push(`${path}.${st}.sprite`, 'sprite 必須是 sprite 名稱字串');
    if (anim.fps !== undefined && !Number.isFinite(num(anim.fps, NaN))) push(`${path}.${st}.fps`, 'fps 必須是數字');
  }
}

/**
 * 驗證遭遇檔，回傳 `[{ path, message }]`。永不 throw。
 * path 格式與 Phase 1 相同，例如 `enemies[0].acts[1].cues[0].actor`。
 *
 * @param {object} json 原始（未正規化）遭遇檔
 * @returns {{path:string, message:string}[]}
 */
export function validateEncounter(json) {
  const errors = [];
  const push = (path, message) => errors.push({ path, message });

  if (!isPlainObject(json)) {
    push('', '遭遇檔必須是物件');
    return errors;
  }

  if (json.format !== undefined && json.format !== ENCOUNTER_FORMAT) {
    push('format', `格式必須是 "${ENCOUNTER_FORMAT}"（目前 "${json.format}"）`);
  }

  /* --- settings --- */
  if (json.settings !== undefined) {
    if (!isPlainObject(json.settings)) push('settings', 'settings 必須是物件');
    else {
      const s = json.settings;
      if (s.seed !== undefined && !Number.isFinite(num(s.seed, NaN))) push('settings.seed', 'seed 必須是數字');
      if (s.bgm !== undefined && s.bgm !== null && typeof s.bgm !== 'string') push('settings.bgm', 'bgm 必須是字串或 null');
      if (s.background !== undefined && s.background !== null && typeof s.background !== 'string') {
        push('settings.background', 'background 必須是字串或 null');
      }
      if (s.introText !== undefined && !isTextValue(s.introText)) push('settings.introText', 'introText 必須是字串或 {zh,en}');
      if (s.canFlee !== undefined && typeof s.canFlee !== 'boolean') push('settings.canFlee', 'canFlee 必須是布林');
      if (s.partyLayout !== undefined && s.partyLayout !== null) {
        const pl = s.partyLayout;
        if (!isPlainObject(pl)) push('settings.partyLayout', 'partyLayout 必須是物件 { x, feet, stagger }');
        else {
          if (pl.x !== undefined && !Number.isFinite(Number(pl.x))) push('settings.partyLayout.x', 'x 必須是數字');
          if (pl.stagger !== undefined && !Number.isFinite(Number(pl.stagger))) push('settings.partyLayout.stagger', 'stagger 必須是數字');
          if (pl.feet !== undefined && (!Array.isArray(pl.feet) || pl.feet.some((v) => !Number.isFinite(Number(v))))) {
            push('settings.partyLayout.feet', 'feet 必須是數字陣列（第 i 位隊員的腳底 y）');
          }
        }
      }
    }
  }

  /* --- 演員 --- */
  const actorIds = new Set();
  // 演員 id → 形態名集合（form cue 驗證用；SPEC-P2 §1 forms）
  const actorForms = new Map();
  if (json.actors !== undefined) {
    if (!isPlainObject(json.actors)) push('actors', 'actors 必須是物件（id → 演員定義）');
    else {
      for (const id of Object.keys(json.actors)) {
        const a = json.actors[id];
        const path = `actors.${id}`;
        actorIds.add(id);
        const formNames = new Set();
        actorForms.set(id, formNames);
        if (!isPlainObject(a)) {
          push(path, '演員定義必須是物件');
          continue;
        }
        if (a.kind !== undefined && !['party', 'enemy'].includes(a.kind)) push(`${path}.kind`, 'kind 必須是 party 或 enemy');
        if (a.x !== undefined && !Number.isFinite(num(a.x, NaN))) push(`${path}.x`, 'x 必須是數字');
        if (a.y !== undefined && !Number.isFinite(num(a.y, NaN))) push(`${path}.y`, 'y 必須是數字');
        if (a.anims !== undefined) validateAnimsField(a.anims, `${path}.anims`, push);
        // 形態（SPEC-P2 §1 forms）
        if (a.forms !== undefined) {
          if (!isPlainObject(a.forms)) push(`${path}.forms`, 'forms 必須是物件（形態名 → 形態定義）');
          else {
            for (const name of Object.keys(a.forms)) {
              const fp = `${path}.forms.${name}`;
              formNames.add(name);
              const f = a.forms[name];
              if (!isPlainObject(f)) {
                push(fp, '形態定義必須是物件');
                continue;
              }
              if (f.scale !== undefined && !(num(f.scale, 0) > 0)) push(`${fp}.scale`, 'scale 必須大於 0');
              if (f.offset !== undefined) {
                if (!isPlainObject(f.offset)) push(`${fp}.offset`, 'offset 必須是 {x,y} 物件');
                else {
                  if (f.offset.x !== undefined && !Number.isFinite(num(f.offset.x, NaN))) push(`${fp}.offset.x`, 'offset.x 必須是數字');
                  if (f.offset.y !== undefined && !Number.isFinite(num(f.offset.y, NaN))) push(`${fp}.offset.y`, 'offset.y 必須是數字');
                }
              }
              if (f.anims !== undefined) validateAnimsField(f.anims, `${fp}.anims`, push);
            }
          }
        }
        if (a.form !== undefined && a.form !== null) {
          if (typeof a.form !== 'string' || !a.form) push(`${path}.form`, 'form 必須是非空字串（形態名）');
          else if (!formNames.has(a.form)) {
            const available = Array.from(formNames);
            push(
              `${path}.form`,
              `找不到形態 "${a.form}"` + (available.length ? `（可用：${available.join(' / ')}）` : '（這個演員沒有 forms）'),
            );
          }
        }
      }
    }
  }

  /* --- 隊伍 --- */
  const partyIds = new Set();
  if (json.party !== undefined) {
    if (!Array.isArray(json.party)) push('party', 'party 必須是陣列');
    else if (json.party.length === 0) push('party', 'party 至少要有一位隊員');
    else {
      json.party.forEach((p, i) => {
        const path = `party[${i}]`;
        if (!isPlainObject(p)) {
          push(path, '隊員必須是物件');
          return;
        }
        if (typeof p.id !== 'string' || !p.id) push(`${path}.id`, 'id 必須是非空字串');
        else if (partyIds.has(p.id)) push(`${path}.id`, `隊員 id 重複："${p.id}"`);
        else partyIds.add(p.id);
        if (p.actor !== undefined && p.actor !== null && !actorIds.has(p.actor)) {
          push(`${path}.actor`, `找不到演員 "${p.actor}"`);
        }
        if (p.icon != null && (typeof p.icon !== 'string' || !p.icon)) {
          push(`${path}.icon`, 'icon 必須是非空字串或 null');
        }
        if (p.maxHp !== undefined && !(num(p.maxHp, 0) > 0)) push(`${path}.maxHp`, 'maxHp 必須大於 0');
        if (p.hp !== undefined) {
          const hp = num(p.hp, NaN);
          if (!Number.isFinite(hp) || hp < 0) push(`${path}.hp`, 'hp 必須是非負數');
          else if (p.maxHp !== undefined && hp > num(p.maxHp, 0)) push(`${path}.hp`, 'hp 不可大於 maxHp');
        }
        if (p.commands !== undefined) {
          if (!Array.isArray(p.commands)) push(`${path}.commands`, 'commands 必須是陣列');
          else {
            for (const c of p.commands) {
              if (!PARTY_COMMANDS.includes(c)) push(`${path}.commands`, `未知的指令 "${c}"`);
            }
          }
        }
        if (p.spells !== undefined && !Array.isArray(p.spells)) push(`${path}.spells`, 'spells 必須是陣列');
      });
    }
  }

  /* --- 敵人 --- */
  const enemyIds = new Set();
  if (json.enemies !== undefined) {
    if (!Array.isArray(json.enemies)) push('enemies', 'enemies 必須是陣列');
    else {
      json.enemies.forEach((e, i) => {
        const path = `enemies[${i}]`;
        if (!isPlainObject(e)) {
          push(path, '敵人必須是物件');
          return;
        }
        if (typeof e.id !== 'string' || !e.id) push(`${path}.id`, 'id 必須是非空字串');
        else if (enemyIds.has(e.id)) push(`${path}.id`, `敵人 id 重複："${e.id}"`);
        else enemyIds.add(e.id);
        if (e.actor !== undefined && e.actor !== null && !actorIds.has(e.actor)) {
          push(`${path}.actor`, `找不到演員 "${e.actor}"`);
        }
        if (e.maxHp !== undefined && !(num(e.maxHp, 0) > 0)) push(`${path}.maxHp`, 'maxHp 必須大於 0');
        if (e.mercy !== undefined && (num(e.mercy, -1) < 0 || num(e.mercy, 101) > 100)) push(`${path}.mercy`, 'mercy 必須在 0..100');
        if (e.acts !== undefined) {
          if (!Array.isArray(e.acts)) push(`${path}.acts`, 'acts 必須是陣列');
          else {
            e.acts.forEach((a, ai) => {
              const ap = `${path}.acts[${ai}]`;
              if (!isPlainObject(a)) {
                push(ap, 'ACT 必須是物件');
                return;
              }
              if (typeof a.id !== 'string' || !a.id) push(`${ap}.id`, 'id 必須是非空字串');
              if (a.text !== undefined && a.text !== null && !isTextValue(a.text)) push(`${ap}.text`, 'text 必須是字串或 {zh,en}');
              if (a.mercy !== undefined && (num(a.mercy, -1) < 0 || num(a.mercy, 101) > 100)) push(`${ap}.mercy`, 'mercy 必須在 0..100');
              if (a.cues !== undefined) validateCueList(a.cues, `${ap}.cues`, errors, { actorIds, enemyIds, partyIds, actorForms });
            });
          }
        }
        for (const hookName of ['onHurt', 'onSpare', 'onDefeat']) {
          if (e[hookName] !== undefined) validateCueList(e[hookName], `${path}.${hookName}`, errors, { actorIds, enemyIds, partyIds, actorForms });
        }
      });
    }
  }

  /* --- 道具 --- */
  if (json.items !== undefined) {
    if (!Array.isArray(json.items)) push('items', 'items 必須是陣列');
    else {
      json.items.forEach((it, i) => {
        const path = `items[${i}]`;
        if (!isPlainObject(it)) {
          push(path, '道具必須是物件');
          return;
        }
        if (typeof it.id !== 'string' || !it.id) push(`${path}.id`, 'id 必須是非空字串');
        if (it.count !== undefined && num(it.count, -1) < 0) push(`${path}.count`, 'count 必須是非負數');
        if (it.heal !== undefined && !Number.isFinite(num(it.heal, NaN))) push(`${path}.heal`, 'heal 必須是數字');
        if (it.text !== undefined && it.text !== null && !isTextValue(it.text)) push(`${path}.text`, 'text 必須是字串或 {zh,en}');
      });
    }
  }

  /* --- 回合 --- */
  if (json.turns !== undefined) {
    if (!Array.isArray(json.turns)) push('turns', 'turns 必須是陣列');
    else {
      json.turns.forEach((t, i) => {
        const path = `turns[${i}]`;
        if (!isPlainObject(t)) {
          push(path, '回合必須是物件');
          return;
        }
        if (t.flavor !== undefined && t.flavor !== null && !isTextValue(t.flavor)) push(`${path}.flavor`, 'flavor 必須是字串或 {zh,en}');
        if (t.attack !== undefined && t.attack !== null && typeof t.attack !== 'string' && !isPlainObject(t.attack)) {
          push(`${path}.attack`, 'attack 必須是檔名字串、內嵌攻擊物件或 null');
        }
        if (t.talk !== undefined) {
          if (!Array.isArray(t.talk)) push(`${path}.talk`, 'talk 必須是陣列');
          else {
            t.talk.forEach((tk, ti) => {
              const tp = `${path}.talk[${ti}]`;
              if (!isPlainObject(tk)) {
                push(tp, '台詞必須是物件');
                return;
              }
              if (typeof tk.actor !== 'string' || !tk.actor) push(`${tp}.actor`, 'actor 必須是演員 id');
              else if (!actorIds.has(tk.actor)) push(`${tp}.actor`, `找不到演員 "${tk.actor}"`);
              if (!isTextValue(tk.text)) push(`${tp}.text`, 'text 必須是字串或 {zh,en}');
            });
          }
        }
        for (const key of TURN_CUE_KEYS) {
          validateCueList(t[key], `${path}.${key}`, errors, { actorIds, enemyIds, partyIds, actorForms });
        }
      });
    }
  }

  if (json.turnOrder !== undefined && !TURN_ORDERS.includes(json.turnOrder)) {
    push('turnOrder', `turnOrder 必須是 ${TURN_ORDERS.join(' / ')}`);
  }

  /* --- hooks / vars --- */
  if (json.hooks !== undefined) {
    if (!isPlainObject(json.hooks)) push('hooks', 'hooks 必須是物件');
    else {
      for (const name of Object.keys(json.hooks)) {
        const path = `hooks.${name}`;
        if (!HOOK_NAMES.includes(name)) {
          push(path, `未知的時機掛鉤 "${name}"（可用：${HOOK_NAMES.join(' / ')}）`);
          continue;
        }
        validateCueList(json.hooks[name], path, errors, { actorIds, enemyIds, partyIds, actorForms });
      }
    }
  }
  if (json.vars !== undefined) {
    if (!isPlainObject(json.vars)) push('vars', 'vars 必須是物件');
    else {
      for (const k of Object.keys(json.vars)) {
        if (!Number.isFinite(num(json.vars[k], NaN))) push(`vars.${k}`, '變數初值必須是數字');
      }
    }
  }

  /* --- demo（SPEC-AUTOPLAY §2.2）：自動演示腳本 --- */
  // 驗證邏輯在 ../autoplay/validate-encounter.js（AP1 的 validate.js 只管攻擊）。
  // 這裡只負責把錯誤接進同一份 [{path, message}]（path 以 demo.* 為前綴）。
  if (json.demo !== undefined && json.demo !== null) {
    try {
      const demoErrors = validateEncounterDemo(json.demo, json);
      for (const e of demoErrors) {
        if (!e) continue;
        push(e.path === undefined ? 'demo' : e.path, e.message === undefined ? 'demo 不合法' : e.message);
      }
    } catch (err) {
      push('demo', `驗證 demo 時發生錯誤：${err && err.message ? err.message : String(err)}`);
    }
  }

  return errors;
}

/** 驗證指令清單（遞迴） */
function validateCueList(list, path, errors, ctx) {
  if (list === undefined || list === null) return;
  if (!Array.isArray(list)) {
    errors.push({ path, message: '指令清單必須是陣列' });
    return;
  }
  list.forEach((cue, i) => {
    validateCue(cue, `${path}[${i}]`, errors, ctx);
  });
}

/** 驗證單一指令 */
function validateCue(cue, path, errors, ctx) {
  if (!isPlainObject(cue)) {
    errors.push({ path, message: '指令必須是物件' });
    return;
  }
  const cmd = cue.cmd;
  if (typeof cmd !== 'string' || !cmd) {
    errors.push({ path: `${path}.cmd`, message: 'cmd 必須是指令名稱' });
    return;
  }
  const def = Object.hasOwn(CUE_COMMANDS, cmd) ? CUE_COMMANDS[cmd] : null;
  if (!def) {
    errors.push({ path: `${path}.cmd`, message: `未知的指令 "${cmd}"` });
    return;
  }

  // 必填參數
  for (const name of Object.keys(def.params)) {
    const p = def.params[name];
    if (p.required && (cue[name] === undefined || (cue[name] === null && !p.nullable) || cue[name] === '')) {
      errors.push({ path: `${path}.${name}`, message: `指令 "${cmd}" 缺少必填參數 ${name}` });
    }
  }

  // 型別檢查（只檢查有給的）
  for (const name of Object.keys(def.params)) {
    if (cue[name] === undefined) continue;
    const p = def.params[name];
    const v = cue[name];
    const pp = `${path}.${name}`;
    switch (p.type) {
      case 'text':
        if (!isTextValue(v)) errors.push({ path: pp, message: '必須是字串或 {zh,en}' });
        break;
      case 'string':
      case 'sprite':
      case 'sound':
        if (v !== null && typeof v !== 'string') errors.push({ path: pp, message: '必須是字串' });
        break;
      case 'number':
        // 數值參數同樣接受表達式字串（在指令啟動時求值一次）
        validateExprField(v, pp, errors);
        break;
      case 'expr':
        validateExprField(v, pp, errors);
        break;
      case 'bool':
        if (typeof v !== 'boolean') errors.push({ path: pp, message: '必須是布林' });
        break;
      case 'enum':
        if (p.values && !p.values.includes(v)) errors.push({ path: pp, message: `必須是 ${p.values.join(' / ')}` });
        break;
      case 'actor':
        if (typeof v === 'string' && !ctx.actorIds.has(v) && !ctx.enemyIds.has(v) && !ctx.partyIds.has(v)) {
          errors.push({ path: pp, message: `找不到演員 / 敵人 / 隊員 "${v}"` });
        }
        break;
      case 'target':
        if (typeof v === 'string' && v !== 'party' && v !== 'all' && !ctx.partyIds.has(v) && !ctx.enemyIds.has(v)) {
          errors.push({ path: pp, message: `找不到目標 "${v}"` });
        }
        break;
      case 'cues':
        validateCueList(v, pp, errors, ctx);
        break;
      case 'attack':
        break;
      default:
        break;
    }
  }

  // form cue：形態名必須存在於該演員的 forms（SPEC-P2 §1 forms）
  if (cmd === 'form' && !ctx.actorIds.has(cue.actor)) {
    errors.push({ path: `${path}.actor`, message: `找不到演員 "${cue.actor}"` });
  }
  if (cmd === 'form' && typeof cue.actor === 'string' && typeof cue.name === 'string' && cue.name) {
    const forms = ctx && ctx.actorForms instanceof Map ? ctx.actorForms.get(cue.actor) : null;
    if (forms && !forms.has(cue.name)) {
      const available = Array.from(forms);
      errors.push({
        path: `${path}.name`,
        message:
          `找不到形態 "${cue.name}"` + (available.length ? `（可用：${available.join(' / ')}）` : '（這個演員沒有 forms）'),
      });
    }
  }
}

/** 驗證表達式欄位（數字合法；字串走詞法白名單） */
function validateExprField(v, path, errors) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) errors.push({ path, message: '表達式數值不合法' });
    return;
  }
  if (typeof v === 'string') {
    if (v.trim() === '') return;
    const err = validateExprSyntax(v);
    if (err) errors.push({ path, message: `表達式不合法：${err}` });
    return;
  }
  if (typeof v === 'boolean') return;
  errors.push({ path, message: '必須是數字或表達式字串' });
}

export default {
  ENCOUNTER_FORMAT,
  CUE_COMMANDS,
  normalizeEncounter,
  validateEncounter,
};
