/**
 * editor/encounter/preview.js — 遭遇編輯器預覽（ED1 擁有）
 *
 * 職責：
 *  1. 以 `createEncounter`（engine/encounter/index.js）建立「實際可玩」的遭遇預覽
 *  2. 引擎缺席／載入失敗時，改用內建替代畫面（畫演員方塊 + 開場文字 + 可拖曳位置），
 *     絕不白屏
 *  3. 提供工具列需要的一切：重來、跳到第 N 回合、執行目前選取的指令清單
 *     （enc.debug.runCues）、變數／狀態除錯浮窗、語言切換、靜音、hitbox
 *  4. 驗證：validateEncounter + 引擎 `error` 事件 → store.errors（世代序號）
 *  5. 攻擊參照：resolveAttack 先找 /api/attacks/<name>.json，再找 samples/<name>.json
 *
 * 對外介面（給 main.js / fileops.js / ED2 / ED3 使用）：
 *   createEncounterPreview({ canvas, viewport, stage, actorLayer, banner, debugEl,
 *                            store, assets, onStatus, onPhase, onError })
 *   → {
 *       ready, engineReady, engineFailed, usingFallback,
 *       play(), pause(), togglePlay(), isPlaying(), restart(), gotoStart(),
 *       step(delta), seek(frame), getFrame(), getState(), getPhase(), getTurn(),
 *       jumpToTurn(n)（1 起算）, runCues(cues?), runSelectedCues(),
 *       setOptions(patch), getOptions(),
 *       setBattleLang(lang?), getBattleLang(), followLocaleBattleLang(),
 *       setDebugVisible(v), isDebugVisible(), refreshDebug(),
 *       refresh(), resize(), destroy(),
 *       getErrors(), getValidationErrors(), hasEngineError(),
 *       onFrame(fn), onStatus(fn), onPhase(fn), onErrorEvent(fn),
 *       getEncounter()（引擎實例或 null）
 *     }
 */

import { collectAttackRefs } from '../../engine/encounter/attack-refs.js';
import { t, getLocale, onLocaleChange, battleLangFor } from '../i18n.js';
import './../locales/encounter-app.js';
import { FPS, defaultCuePathFor, getAtPath } from '../store.js';
import { LAYOUT } from '../../engine/encounter/layout.js';

/** 邏輯畫面尺寸（唯一來源：engine/encounter/layout.js，與遊戲渲染共用） */
export const VIEW_W = LAYOUT.VIEW_W;
export const VIEW_H = LAYOUT.VIEW_H;
export const PHASE_ORDER = [
  'intro',
  'turnStart',
  'menu',
  'resolve',
  'enemyTalk',
  'attack',
  'turnEnd',
  'victory',
  'spared',
  'defeat',
  'flee',
];

const ENGINE_INDEX = '../../engine/encounter/index.js';
const SERVER_ATTACKS = '/api/attacks';
const SAMPLE_ATTACK_DIR = 'samples/';
const BATTLE_LANG_KEY = 'drbe.encounter.battleLang';
const DEBUG_KEY = 'drbe.encounter.debug';
const MAX_ENGINE_ERRORS = 60;

/* ------------------------------------------------------------------ 小工具 */

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(v, lo, hi) {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function errText(err) {
  if (!err) return t('encpreview.phase.unknown');
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  try {
    return String(err);
  } catch (_e) {
    return '?';
  }
}

function safeCall(obj, method, ...args) {
  if (!obj || typeof obj[method] !== 'function') return undefined;
  try {
    return obj[method](...args);
  } catch (err) {
    console.warn(`[encounter:preview] ${method} 失敗：`, err);
    return undefined;
  }
}

/** 秒:幀 時間碼（30 FPS） */
export function formatTimecode(frame, fps = FPS) {
  const total = Math.max(0, Math.round(num(frame, 0)));
  const sec = Math.floor(total / fps);
  const f = total - sec * fps;
  return `${String(sec).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

/** 取文字欄位（可能為字串或 {zh,en}） */
export function pickText(value, lang = 'zh') {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const v = value[lang];
    if (typeof v === 'string') return v;
    if (typeof value.zh === 'string') return value.zh;
    if (typeof value.en === 'string') return value.en;
  }
  return '';
}

/* ------------------------------------------------- §4-10 預覽縮放與座標 */

/**
 * 把「理想縮放倍率」吸附到可保持像素清晰的倍率（SPEC §4-10）。
 *
 * 規則：**1× 以上只走整數倍，小於 1× 一律 0.5×**。
 *
 *   - `#enc-canvas` 的 backing store 永遠是 640×480（引擎 `setupCanvas` 對
 *     scale < 1 會 floor 成 1），CSS 再用 `image-rendering: pixelated` 放大到
 *     `VIEW_W × scale`。只有整數倍時「1 邏輯像素 = n×n 螢幕像素」才完全均勻；
 *     1.5× 這種半倍會讓像素寬度在 1～2 px 之間跳（摩爾紋），所以不用。
 *   - 小於 1× 只有 0.5× 是精確的 2:1 縮小（最銳利），這也是唯一還能塞進
 *     小視窗又不糊的比例；§4-10 報告量到的 0.975×（624×468）正是任意倍率
 *     造成的模糊與點擊換算漂移。
 *   - 下限 0.5、上限 16（與 engine/render-encounter.js 的 canvas 上限一致）。
 *
 * @param {number} ideal 依容器可用空間算出的理想倍率
 * @returns {number} 0.5 或整數倍
 */
export function snapPreviewScale(ideal) {
  const raw = Number(ideal);
  const s = Number.isFinite(raw) && raw > 0 ? raw : 1;
  if (s >= 1) return Math.min(16, Math.max(1, Math.floor(s)));
  // 小於 1×：0.75 / 0.5 / 0.25 三檔（4 的倍數像素對齊；只給 0.5 會在常見視窗下浪費一半空間）
  return Math.max(0.25, Math.floor(s * 4) / 4);
}

/**
 * 預覽（CSS 像素）→ 遊戲邏輯座標（640×480）。
 *
 * 以 `viewport` 的實際顯示框為準，而不是 canvas.width（那個是縮放後的裝置像素），
 * 所以視窗縮放、縮放倍率改變、甚至瀏覽器 zoom 都不影響換算。
 *
 * @param {{x:number, y:number}} client 相對於 viewport 左上角的 CSS 像素座標
 * @param {{width:number, height:number}|{clientWidth:number, clientHeight:number}} box
 * @param {{clamp?:boolean}} [opts] clamp=true（預設）把結果夾在畫面內
 * @returns {{x:number, y:number}} 遊戲座標（整數）
 */
export function previewToGame(client, box = {}, opts = {}) {
  const rectW = Math.max(1, num(box && (box.width !== undefined ? box.width : box.clientWidth), VIEW_W));
  const rectH = Math.max(1, num(box && (box.height !== undefined ? box.height : box.clientHeight), VIEW_H));
  const cx = num(client && client.x, 0);
  const cy = num(client && client.y, 0);
  const x = Math.round((cx / rectW) * VIEW_W);
  const y = Math.round((cy / rectH) * VIEW_H);
  if (opts.clamp === false) return { x, y };
  return { x: clamp(x, 0, VIEW_W), y: clamp(y, 0, VIEW_H) };
}

/**
 * 遊戲邏輯座標 → 預覽 CSS 像素座標（previewToGame 的反函式；除錯與覆蓋層用）。
 * @param {{x:number, y:number}} point 遊戲座標
 * @param {{width:number, height:number}|{clientWidth:number, clientHeight:number}} box
 * @returns {{x:number, y:number}} CSS 像素（未取整，交給呼叫端）
 */
export function gameToPreview(point, box = {}) {
  const rectW = Math.max(1, num(box && (box.width !== undefined ? box.width : box.clientWidth), VIEW_W));
  const rectH = Math.max(1, num(box && (box.height !== undefined ? box.height : box.clientHeight), VIEW_H));
  return {
    x: (num(point && point.x, 0) / VIEW_W) * rectW,
    y: (num(point && point.y, 0) / VIEW_H) * rectH,
  };
}

/* ------------------------------------------------------- 攻擊參照解析（§6） */

/** 記憶化的攻擊載入（同一個 name 只抓一次；失敗也快取 30 秒避免風暴） */
const attackCache = new Map();

/**
 * 解析攻擊參照：'spade-rain' → 先 /api/attacks/spade-rain.json，
 * 再 samples/spade-rain.json。找不到回傳 null（引擎會當成空彈幕）。
 * @param {string} name
 * @returns {Promise<object|null>}
 */
export async function resolveAttackRef(name) {
  if (!name || typeof name !== 'string') return null;
  const key = name.trim();
  if (!key) return null;
  const cached = attackCache.get(key);
  if (cached && (cached.promise || cached.json || Date.now() < cached.expires)) return cached.promise || cached.json;
  const entry = {};
  entry.promise = fetchAttackRef(key).then((json) => {
    entry.json = json;
    entry.expires = Date.now() + 30000;
    entry.promise = null;
    return json;
  });
  attackCache.set(key, entry);
  return entry.promise;
}

async function fetchAttackRef(key) {
  // 先問一次作品清單：名字不在作品裡就直接找 samples/，不要每個範例攻擊都打出一個 404
  // （--works 模式下開範例遭遇會滿版紅字，REALTEST-2 V8）。清單拿不到時維持舊行為。
  const works = await worksAttackNames();
  const candidates = [];
  if (!works || works.has(key)) candidates.push(`${SERVER_ATTACKS}/${encodeURIComponent(key)}.json`);
  candidates.push(`${SAMPLE_ATTACK_DIR}${encodeURIComponent(key)}.json`);
  for (const url of candidates) {
    try {
      const res = await fetch(url, { headers: { Accept: 'application/json' } });
      if (!res.ok) continue;
      const json = await res.json();
      if (json && typeof json === 'object') return json;
    } catch (_err) {
      /* 換下一個來源 */
    }
  }
  return null;
}

/** 作品裡的攻擊名稱清單（GET /api/attacks；5 秒快取）。拿不到回 null（= 不知道，照舊逐一嘗試）。 */
let worksAttackList = null;
async function worksAttackNames() {
  if (worksAttackList && Date.now() < worksAttackList.expires) return worksAttackList.promise;
  const promise = (async () => {
    try {
      const res = await fetch(SERVER_ATTACKS, { headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const data = await res.json();
      const items = Array.isArray(data) ? data : data && (data.items || data.attacks);
      if (!Array.isArray(items)) return null;
      const names = new Set();
      for (const item of items) {
        const raw = typeof item === 'string' ? item : item && item.name;
        if (typeof raw === 'string' && raw) names.add(raw.replace(/\.json$/i, ''));
      }
      return names;
    } catch (_err) {
      return null;
    }
  })();
  worksAttackList = { promise, expires: Date.now() + 5000 };
  return promise;
}

/** 清空攻擊快取（測試或換伺服器時用） */
export function clearAttackCache() {
  attackCache.clear();
  worksAttackList = null;
}

/* ------------------------------------------------------------ 預設遭遇（新建） */

/** 最小可用遭遇：一位隊員 + 一個敵人 + 一個回合 + 開場掛鉤 */
/* ------------------------------------------------ A3 演員預設（新建範本用） */

const PRESETS_URL = 'assets/actor-presets.json';
let presetsCache = null;
let presetsPending = null;

/**
 * 讀取 `assets/actor-presets.json`（A3 提供；含 actors / layouts / displayNames）。
 * 失敗或檔案不存在時回 null（呼叫端一律要有後備）。
 * @returns {Promise<object|null>}
 */
export function loadActorPresets() {
  if (presetsCache) return Promise.resolve(presetsCache);
  if (presetsPending) return presetsPending;
  presetsPending = (async () => {
    try {
      const res = await fetch(PRESETS_URL, { cache: 'no-cache' });
      if (!res || !res.ok) return null;
      const data = await res.json();
      if (!data || typeof data !== 'object' || !data.actors || typeof data.actors !== 'object') return null;
      presetsCache = data;
      return data;
    } catch (_err) {
      return null;
    } finally {
      presetsPending = null;
    }
  })();
  return presetsPending;
}

const PRESET_PARTY_IDS = ['kris', 'susie', 'ralsei'];
const PRESET_ENEMY_ID = 'rudinn';

/* -------------------------------------------------- 版面預設（LAYOUT 唯一來源） */

/**
 * 隊員預設置位（SPEC-LAYOUT §3）：x = 縱列中心 ± 交錯（約 96–108）、
 * y = 該人數的腳底 y（精靈以腳底為錨點，與渲染一致）。
 * @param {number} index 第幾位隊員（0 起算）
 * @param {number} count 隊伍人數（1–4）
 * @returns {{x:number, y:number}}
 */
export function partySpotFor(index, count = 3) {
  const i = Math.max(0, Math.round(num(index, 0)));
  const feet = LAYOUT.partyFeetFor(count);
  const y = num(feet[i], num(LAYOUT.PARTY_FEET[3] && LAYOUT.PARTY_FEET[3][i], LAYOUT.ENEMY_FEET_Y));
  const x = LAYOUT.PARTY_CENTER_X + (i % 2 === 0 ? -LAYOUT.PARTY_STAGGER_X / 2 : LAYOUT.PARTY_STAGGER_X / 2);
  return { x, y };
}

/**
 * 敵人預設置位（SPEC-LAYOUT §4）：中心 x 505、腳底 y 270；多隻時上下錯開
 * （公式與 engine/render-encounter.js 的退回值一致）。
 * @param {number} index 第幾隻敵人（0 起算）
 * @param {number} count 敵人數
 * @returns {{x:number, y:number}}
 */
export function enemySpotFor(index = 0, count = 1) {
  const n = Math.max(1, Math.round(num(count, 1)));
  const i = Math.max(0, Math.round(num(index, 0)));
  const mid = (n - 1) / 2;
  return {
    x: Math.round(LAYOUT.ENEMY_CENTER_X + (i - mid) * LAYOUT.ENEMY_STAGGER.x),
    y: Math.round(LAYOUT.ENEMY_FEET_Y + (i - mid) * LAYOUT.ENEMY_STAGGER.y * 0.5),
  };
}

/**
 * 依文件內容推算某演員的預設置位（替代畫面與拖曳的退回值）。
 * 隊員用 §3 縱列、敵人用 §4 錨點；找不到演員時視為第 0 位隊員。
 * @param {object} doc 遭遇文件
 * @param {string} actorId
 * @returns {{x:number, y:number, kind:'party'|'enemy'}}
 */
export function fallbackSpotFor(doc, actorId) {
  const actors = doc && doc.actors && typeof doc.actors === 'object' ? doc.actors : {};
  const self = actors[actorId];
  const kind = self && self.kind === 'enemy' ? 'enemy' : 'party';
  let index = -1;
  let count = 0;
  for (const id of Object.keys(actors)) {
    const a = actors[id] || {};
    const k = a.kind === 'enemy' ? 'enemy' : 'party';
    if (k !== kind) continue;
    if (id === actorId) index = count;
    count += 1;
  }
  if (index < 0) index = 0;
  if (kind === 'enemy') return { ...enemySpotFor(index, Math.max(1, count)), kind };
  const partyCount = Array.isArray(doc && doc.party) && doc.party.length ? doc.party.length : Math.max(1, count);
  return { ...partySpotFor(index, partyCount), kind };
}

const PRESET_PARTY_STATS = {
  kris: {
    hp: 90, maxHp: 90, atk: 10, def: 2, magic: 0, color: '#00ffff',
    commands: ['fight', 'act', 'item', 'spare', 'defend'],
    spells: [],
  },
  susie: {
    hp: 110, maxHp: 110, atk: 14, def: 2, magic: 0, color: '#c000c0',
    commands: ['fight', 'act', 'item', 'spare', 'defend'],
    spells: [],
  },
  ralsei: {
    hp: 70, maxHp: 70, atk: 8, def: 4, magic: 12, color: '#00ff00',
    commands: ['fight', 'magic', 'item', 'spare', 'defend'],
    spells: [
      {
        id: 'pacify',
        name: 'Pacify',
        tp: 32,
        target: 'enemy',
        cues: [
          { cmd: 'say', text: '* Ralsei 唱起了安撫的歌。' },
          { cmd: 'mercy', enemy: 'rudinn', amount: 25 },
        ],
      },
    ],
  },
};

function cloneJson(value) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_err) {
    return null;
  }
}

/**
 * 用 actor-presets 組一份「三人隊伍 + 一隻敵人」的新遭遇範本。
 * 任何欄位不對就回 null（呼叫端退回最小範本）。
 */
function buildPresetEncounter(presets) {
  try {
    const table = presets && presets.actors;
    if (!table || typeof table !== 'object') return null;
    const need = [...PRESET_PARTY_IDS, PRESET_ENEMY_ID];
    if (!need.every((id) => table[id] && typeof table[id] === 'object')) return null;

    const layouts = presets.layouts || {};
    const partyLayout = Array.isArray(layouts.party3) ? layouts.party3 : [];
    const enemyLayout = Array.isArray(layouts.enemy1) ? layouts.enemy1 : [];
    const displayNames = presets.displayNames || {};

    const actors = {};
    const party = [];
    PRESET_PARTY_IDS.forEach((id, i) => {
      const src = cloneJson(table[id]);
      if (!src) return;
      const spot = partyLayout.find((p) => p && p.id === id) || {};
      const fallback = partySpotFor(i, PRESET_PARTY_IDS.length);
      actors[id] = {
        ...src,
        kind: 'party',
        x: num(spot.x, fallback.x),
        y: num(spot.y, fallback.y),
      };
      const stats = PRESET_PARTY_STATS[id] || {};
      party.push({
        id,
        actor: id,
        name: displayNames[id] || id,
        hp: num(stats.hp, 80),
        maxHp: num(stats.maxHp, num(stats.hp, 80)),
        atk: num(stats.atk, 10),
        def: num(stats.def, 2),
        magic: num(stats.magic, 0),
        color: stats.color || '#ffffff',
        commands: Array.isArray(stats.commands) ? stats.commands.slice() : ['fight', 'act', 'item', 'spare', 'defend'],
        spells: Array.isArray(stats.spells) ? cloneJson(stats.spells) || [] : [],
      });
    });
    if (party.length !== PRESET_PARTY_IDS.length) return null;

    const enemySrc = cloneJson(table[PRESET_ENEMY_ID]);
    if (!enemySrc) return null;
    const espot = enemyLayout.find((p) => p && typeof p === 'object' && (p.id === undefined || p.id === PRESET_ENEMY_ID)) || {};
    const efback = enemySpotFor(0, 1);
    actors[PRESET_ENEMY_ID] = {
      ...enemySrc,
      kind: 'enemy',
      x: num(espot.x, efback.x),
      y: num(espot.y, efback.y),
    };

    return {
      format: 'dr-battle-encounter/1',
      meta: { name: t('encapp.untitled') || '未命名遭遇', author: '' },
      settings: {
        seed: 1,
        bgm: null,
        background: null,
        introText: t('encapp.template.intro') || '* 遭遇開始了。',
        canFlee: false,
      },
      actors,
      party,
      enemies: [
        {
          id: PRESET_ENEMY_ID,
          actor: PRESET_ENEMY_ID,
          name: displayNames[PRESET_ENEMY_ID] || 'Rudinn',
          hp: 120,
          maxHp: 120,
          atk: 5,
          def: 0,
          mercy: 0,
          spareAt: 100,
          acts: [
            {
              id: 'check',
              name: 'Check',
              text: '* RUDINN - ATK 5 DEF 0',
              cues: [],
            },
          ],
          onHurt: [],
          onSpare: [],
          onDefeat: [],
        },
      ],
      items: [],
      turns: [{ id: 't1', flavor: '', talk: [], attack: null, start: [], end: [] }],
      turnOrder: 'loop-last',
      hooks: { intro: [], victory: [], spared: [], defeat: [], flee: [] },
      vars: {},
    };
  } catch (_err) {
    return null;
  }
}

export function createDefaultEncounter(presets = null) {
  const presetDoc = buildPresetEncounter(presets);
  if (presetDoc) return presetDoc;
  // 最小範本（presets 缺席時）：站位同樣走 LAYOUT，不寫死座標
  const heroSpot = partySpotFor(0, 1);
  const foeSpot = enemySpotFor(0, 1);
  return {
    format: 'dr-battle-encounter/1',
    meta: { name: t('encapp.untitled') || '未命名遭遇', author: '' },
    settings: {
      seed: 1,
      bgm: null,
      background: null,
      introText: '* 遭遇開始了。',
      canFlee: false,
    },
    actors: {
      kris: {
        kind: 'party',
        x: heroSpot.x,
        y: heroSpot.y,
        anims: { idle: { sprite: 'spr_krisb_idle', fps: 5, loop: true } },
      },
      enemy: {
        kind: 'enemy',
        x: foeSpot.x,
        y: foeSpot.y,
        anims: { idle: { sprite: 'spr_rudinn_idle', fps: 5, loop: true } },
      },
    },
    party: [
      {
        id: 'kris',
        actor: 'kris',
        name: 'Kris',
        hp: 90,
        maxHp: 90,
        atk: 10,
        def: 2,
        magic: 0,
        color: '#00ffff',
        commands: ['fight', 'act', 'item', 'spare', 'defend'],
      },
    ],
    enemies: [
      {
        id: 'rudinn',
        actor: 'enemy',
        name: 'Rudinn',
        hp: 120,
        maxHp: 120,
        atk: 5,
        def: 0,
        mercy: 0,
        spareAt: 100,
        acts: [{ id: 'check', name: 'Check', text: '* RUDINN - ATK 5 DEF 0', cues: [] }],
        onHurt: [],
        onSpare: [],
        onDefeat: [],
      },
    ],
    items: [],
    turns: [{ id: 't1', flavor: '', talk: [], attack: null, start: [], end: [] }],
    turnOrder: 'loop-last',
    hooks: { intro: [], victory: [], spared: [], defeat: [], flee: [] },
    vars: {},
  };
}

/* ================================================================== 主體 */

/**
 * 建立遭遇預覽。
 * @param {object} opts
 */
export function createEncounterPreview(opts = {}) {
  const {
    canvas,
    viewport,
    stage,
    actorLayer = null,
    banner = null,
    debugEl = null,
    store,
    assets = null,
    onStatus = null,
    onPhase = null,
    onError: onErrorEvent = null,
  } = opts;

  if (!store || typeof store.subscribe !== 'function') {
    throw new Error(t('encpreview.notReady'));
  }

  /* ------------------------------------------------------------ 內部狀態 */

  let enc = null; // createEncounter 實例
  let engineMod = null; // engine/encounter/index.js 模組
  let engineReady = false;
  let engineFailed = false;
  let usingFallback = true;
  let destroyed = false;

  let playing = false;
  let manualTimer = 0;
  let manualLast = 0;
  let manualAcc = 0;
  let currentFrame = 0;
  let currentPhase = 'intro';
  let currentTurn = 0;

  /**
   * 自動演示（SPEC-AUTOPLAY §4）。
   * 只把 pilot 產生的輸入餵給引擎；不改任何引擎狀態、不寫 store。
   * mode: 'off' | 'demo' | 'bot'（'demo' = 腳本，'bot' = AI）
   */
  const autoplay = {
    mode: 'off',
    pilot: null,
    loading: null,
    describe: null,
    warnings: [],
    error: '',
  };
  const autoplaySubs = new Set();
  const AUTOPLAY_MODULE = '../../engine/autoplay/index.js';

  let scale = 1;
  let debugVisible = readDebugPref();

  let manualBattleLang = readManualBattleLang();

  const options = { showHitboxes: false, showGrid: true, muted: false, scale: 1 };
  const frameSubs = new Set();
  const statusSubs = new Set();
  const phaseSubs = new Set();
  const errorSubs = new Set();

  const validationErrors = new Map();
  const engineErrors = new Map();

  let unsubscribeLocale = null;
  let unsubscribeStore = null;
  let resizeObserver = null;
  let statusTimer = 0;

  /* -------------------------------------------------------- 戰鬥語言偏好 */

  function readManualBattleLang() {
    try {
      const v = globalThis.localStorage?.getItem(BATTLE_LANG_KEY);
      return v === 'zh' || v === 'en' ? v : null;
    } catch (_err) {
      return null;
    }
  }

  function writeManualBattleLang(value) {
    try {
      if (value === 'zh' || value === 'en') globalThis.localStorage?.setItem(BATTLE_LANG_KEY, value);
      else globalThis.localStorage?.removeItem(BATTLE_LANG_KEY);
    } catch (_err) {
      /* 忽略 */
    }
  }

  function effectiveBattleLang() {
    return manualBattleLang || battleLangFor(getLocale());
  }

  function readDebugPref() {
    try {
      return globalThis.localStorage?.getItem(DEBUG_KEY) === '1';
    } catch (_err) {
      return false;
    }
  }

  function writeDebugPref(value) {
    try {
      if (value) globalThis.localStorage?.setItem(DEBUG_KEY, '1');
      else globalThis.localStorage?.removeItem(DEBUG_KEY);
    } catch (_err) {
      /* 忽略 */
    }
  }

  /* -------------------------------------------------------------- 遭遇資料 */

  function currentEncounter() {
    return (store && store.doc) || {};
  }

  function turns() {
    const doc = currentEncounter();
    return Array.isArray(doc.turns) ? doc.turns : [];
  }

  /* ---------------------------------------------------------------- 通知 */

  function emitStatus(force) {
    const payload = statusPayload();
    if (!force && statusTimer) return;
    statusTimer = 0;
    for (const fn of [...statusSubs]) {
      try {
        fn(payload);
      } catch (err) {
        console.warn('[encounter:preview] onStatus 回呼錯誤：', err);
      }
    }
    if (typeof onStatus === 'function') {
      try {
        onStatus(payload);
      } catch (_err) {
        /* 忽略 */
      }
    }
  }

  function scheduleStatus() {
    if (statusTimer) return;
    statusTimer = setTimeout(() => {
      statusTimer = 0;
      emitStatus(true);
    }, 60);
  }

  function statusPayload() {
    return {
      ready: engineReady,
      engineReady,
      engineFailed,
      usingFallback,
      playing,
      phase: currentPhase,
      turn: currentTurn,
      frame: currentFrame,
      lang: effectiveBattleLang(),
      options: { ...options },
      scale,
      debugVisible,
      errorCount: validationErrors.size + engineErrors.size,
    };
  }

  function notifyFrame(frame) {
    currentFrame = frame;
    for (const fn of [...frameSubs]) {
      try {
        fn(frame);
      } catch (err) {
        console.warn('[encounter:preview] onFrame 回呼錯誤：', err);
      }
    }
    paintTransport();
    if (debugVisible) refreshDebug();
  }

  function notifyPhase(phase, turn) {
    const changed = phase !== currentPhase || turn !== currentTurn;
    currentPhase = phase;
    currentTurn = turn;
    if (!changed) return;
    for (const fn of [...phaseSubs]) {
      try {
        fn({ phase, turn });
      } catch (err) {
        console.warn('[encounter:preview] onPhase 回呼錯誤：', err);
      }
    }
    if (typeof onPhase === 'function') {
      try {
        onPhase({ phase, turn });
      } catch (_err) {
        /* 忽略 */
      }
    }
    scheduleStatus();
  }

  function notifyError(payload) {
    for (const fn of [...errorSubs]) {
      try {
        fn(payload);
      } catch (err) {
        console.warn('[encounter:preview] onError 回呼錯誤：', err);
      }
    }
    if (typeof onErrorEvent === 'function') {
      try {
        onErrorEvent(payload);
      } catch (_err) {
        /* 忽略 */
      }
    }
  }

  /* ---------------------------------------------------------------- 橫幅 */

  function showBanner(html, kind) {
    if (!banner) return;
    banner.hidden = false;
    banner.dataset.kind = kind || 'error';
    banner.innerHTML = html;
  }

  function hideBanner() {
    if (!banner) return;
    banner.hidden = true;
    banner.innerHTML = '';
    delete banner.dataset.kind;
  }

  function engineMissingBanner(err) {
    showBanner(
      `<h3>${escapeHtml(t('encapp.engine.missingTitle'))}</h3>` +
        `<p>${escapeHtml(t('encapp.engine.missingLine1'))}</p>` +
        `<p>${escapeHtml(t('encapp.engine.missingLine2'))}</p>` +
        `<p class="banner-detail">${escapeHtml(t('encapp.engine.errorDetail', { msg: errText(err) }))}</p>`,
      'warn',
    );
  }

  function engineFailureBanner(err) {
    showBanner(
      `<h3>${escapeHtml(t('encapp.engine.failTitle'))}</h3>` +
        `<p>${escapeHtml(t('encapp.engine.failLine1'))}</p>` +
        `<p class="banner-detail">${escapeHtml(t('encapp.engine.reason', { msg: errText(err) }))}</p>` +
        `<p>${escapeHtml(t('encapp.engine.failLine2'))}</p>`,
      'error',
    );
  }

  /* -------------------------------------------------------- 引擎錯誤收集 */

  function clearEngineErrors() {
    if (engineErrors.size === 0) return;
    engineErrors.clear();
    rebuildErrors();
  }

  function addEngineError(payload) {
    const path = String(payload?.path || payload?.where || '$');
    const message = String(payload?.message || payload?.msg || '');
    if (!message) return;
    if (engineErrors.size >= MAX_ENGINE_ERRORS && !engineErrors.has(path)) return;
    const next = `${message}${payload && payload.frame !== undefined ? `（frame ${payload.frame}）` : ''}`;
    if (engineErrors.get(path) === next) return;
    engineErrors.set(path, next);
    rebuildErrors();
  }

  function rebuildErrors() {
    const merged = new Map();
    for (const [k, v] of validationErrors) merged.set(k, v);
    for (const [k, v] of engineErrors) {
      merged.set(k, merged.has(k) ? `${merged.get(k)}；${v}` : v);
    }
    store.setErrors(merged);
    notifyError({ type: 'errors', errors: merged });
    scheduleStatus();
  }

  /* ------------------------------------------------------------ 驗證 */

  function runValidation() {
    validationErrors.clear();
    const validate = engineMod && typeof engineMod.validateEncounter === 'function' ? engineMod.validateEncounter : null;
    if (validate) {
      try {
        const list = validate(currentEncounter());
        if (Array.isArray(list)) {
          for (const item of list) {
            if (!item) continue;
            const path = String(item.path ?? item.key ?? '$');
            const message = String(item.message ?? item.msg ?? '');
            if (message) validationErrors.set(path, message);
          }
        }
      } catch (err) {
        console.warn('[encounter:preview] validateEncounter 拋錯：', err);
        validationErrors.set('$', t('encpreview.loadFailed', { msg: errText(err) }));
      }
    } else {
      // 引擎尚未完成：只驗最基本的結構，讓使用者早點看到問題
      const doc = currentEncounter();
      if (!doc || typeof doc !== 'object') {
        validationErrors.set('$', '遭遇不是 JSON 物件');
      } else {
        if (doc.format !== 'dr-battle-encounter/1') {
          validationErrors.set('format', `format 必須是 dr-battle-encounter/1（目前 ${JSON.stringify(doc.format ?? null)}）`);
        }
        if (!Array.isArray(doc.party) || doc.party.length === 0) {
          validationErrors.set('party', '至少需要一位隊員');
        }
        if (!Array.isArray(doc.enemies) || doc.enemies.length === 0) {
          validationErrors.set('enemies', '至少需要一位敵人');
        }
        if (!Array.isArray(doc.turns) || doc.turns.length === 0) {
          validationErrors.set('turns', '至少需要一個回合');
        }
        const actors = doc.actors && typeof doc.actors === 'object' ? doc.actors : {};
        const needActor = [...(doc.party || []), ...(doc.enemies || [])];
        for (let i = 0; i < needActor.length; i += 1) {
          const item = needActor[i];
          if (!item || typeof item !== 'object') continue;
          if (typeof item.actor === 'string' && item.actor && !actors[item.actor]) {
            const list = Array.isArray(doc.party) && i < doc.party.length ? 'party' : 'enemies';
            const idx = list === 'party' ? i : i - (doc.party || []).length;
            validationErrors.set(`${list}[${idx}].actor`, `找不到演員定義「${item.actor}」`);
          }
        }
      }
    }
    rebuildErrors();
  }

  /* -------------------------------------------------------------- 縮放 */

  function computeScale() {
    const host = stage || (viewport && viewport.parentElement) || viewport;
    // 留白少一點，1× 在 1600×1000 左右的視窗就放得下（整數倍比較容易達到）
    const pad = 12;
    const availW = Math.max(160, (host ? host.clientWidth : VIEW_W) - pad);
    const availH = Math.max(160, (host ? host.clientHeight : VIEW_H) - pad);
    return snapPreviewScale(Math.min(availW / VIEW_W, availH / VIEW_H));
  }

  function applyScale() {
    scale = computeScale();
    options.scale = scale;
    if (viewport) {
      viewport.style.width = `${Math.round(VIEW_W * scale)}px`;
      viewport.style.height = `${Math.round(VIEW_H * scale)}px`;
    }
    applyOptions();
    emitStatus(true);
  }

  /* ------------------------------------------------------------ 引擎選項 */

  function applyOptions() {
    if (!enc) return;
    const payload = {
      lang: effectiveBattleLang(),
      showHitboxes: Boolean(options.showHitboxes),
      muted: Boolean(options.muted),
      scale,
    };
    if (options.showGrid !== undefined) payload.showGrid = Boolean(options.showGrid);
    safeCall(enc, 'setOptions', payload);
  }

  /* -------------------------------------------------------------- 引擎建立 */

  async function loadEngine() {
    try {
      engineMod = await import(new URL(ENGINE_INDEX, import.meta.url).href);
    } catch (err) {
      engineMod = null;
      engineFailed = true;
      usingFallback = true;
      engineMissingBanner(err);
      console.warn('[encounter:preview] 引擎載入失敗（改用替代畫面）：', err);
      return false;
    }
    const createEncounter = engineMod && engineMod.createEncounter;
    if (typeof createEncounter !== 'function') {
      engineFailed = true;
      usingFallback = true;
      engineMissingBanner(new Error('engine/encounter/index.js 沒有 createEncounter'));
      return false;
    }
    try {
      enc = createEncounter({
        canvas: canvas || null,
        assets: assets || null,
        resolveAttack: (name) => resolveAttackRef(name),
      });
      if (!enc || typeof enc !== 'object') throw new Error('createEncounter 沒有回傳物件');
      // 重要：'error' 必須在 load() 之前掛上（load 會立刻觸發 at=0 事件）
      bindEncounter(enc);
      engineReady = true;
      engineFailed = false;
      usingFallback = false;
      hideBanner();
      if (canvas) canvas.classList.remove('is-fallback');
      if (actorLayer) actorLayer.hidden = true;
      applyOptions();
      return true;
    } catch (err) {
      enc = null;
      engineReady = false;
      engineFailed = true;
      usingFallback = true;
      engineFailureBanner(err);
      console.warn('[encounter:preview] createEncounter 失敗（改用替代畫面）：', err);
      return false;
    }
  }

  /** 綁定引擎事件（必須在 load 之前呼叫） */
  function bindEncounter(instance) {
    if (!instance || typeof instance.on !== 'function') return;
    const on = (evt, cb) => {
      try {
        instance.on(evt, cb);
      } catch (err) {
        console.warn(`[encounter:preview] on('${evt}') 失敗：`, err);
      }
    };
    on('error', (payload) => addEngineError(payload));
    on('phase', (payload) => {
      const phase = payload && typeof payload === 'object' ? payload.phase : payload;
      const turn = payload && typeof payload === 'object' ? num(payload.turn, currentTurn) : currentTurn;
      notifyPhase(String(phase || 'intro'), turn);
    });
    on('end', (payload) => {
      const result = payload && typeof payload === 'object' ? payload.result : payload;
      notifyPhase(String(result || 'victory'), currentTurn);
      pause();
      if (autoplay.mode !== 'off') emitAutoplay();
    });
    on('frame', () => {
      /* 由主迴圈統一輪詢，這裡只確保有事件時也會更新 */
      scheduleStatus();
    });
  }

  /** 載入目前遭遇（會先 normalize，避免未知欄位讓引擎炸掉） */
  async function loadCurrent({ resetFrame = true } = {}) {
    if (!engineReady || !enc) {
      usingFallback = true;
      paintFallback();
      runValidation();
      notifyFrame(0);
      return false;
    }
    const doc = currentEncounter();
    clearEngineErrors();
    try {
      await enc.load(doc);
      engineReady = true;
      hideBanner();
      if (canvas) canvas.classList.remove('is-fallback');
      if (resetFrame) {
        seekInternal(0, { force: true });
      } else {
        seekInternal(currentFrame, { force: true });
      }
      syncState();
      afterDocumentLoad();
      return true;
    } catch (err) {
      console.error('[encounter:preview] enc.load 失敗：', err);
      engineFailed = true;
      usingFallback = true;
      engineFailureBanner(err);
      if (canvas) canvas.classList.add('is-fallback');
      paintFallback();
      return false;
    } finally {
      runValidation();
      // 引擎就緒後要把「編輯模式（無引擎）」之類的舊字樣刷新掉
      updateTransportUI();
      emitStatus(true);
    }
  }

  /* -------------------------------------------------------------- 繪製 */

  function redraw() {
    if (engineReady && enc) {
      engineRedraw();
      return;
    }
    paintFallback();
  }

  /**
   * 引擎對外 API 沒有 redraw；setOptions({}) 會觸發內部的 draw()。
   * （engine/encounter/index.js: setOptions() 最後一定呼叫 draw()）
   */
  function engineRedraw() {
    if (!enc || destroyed) return false;
    try {
      if (typeof enc.redraw === 'function') {
        enc.redraw();
        return true;
      }
    } catch (err) {
      console.warn('[encounter:preview] enc.redraw 失敗：', err);
    }
    try {
      if (typeof enc.setOptions === 'function') {
        enc.setOptions({}); // 空物件不會改任何選項，只會重畫
        return true;
      }
    } catch (err) {
      console.warn('[encounter:preview] enc.setOptions({}) 重畫失敗：', err);
    }
    return false;
  }

  /* -------------------------------------------------- 素材載入後重畫 */

  /**
   * 引擎的圖片是 lazy load：draw 時圖片沒回來就畫洋紅佔位；
   * 圖片到位後引擎不會自己重畫（暫停時就一直是洋紅）。
   * 這裡補兩件事：
   *   1) 監聽 assets.onProgress：載入中每 120ms 節流重畫，全部完成再畫一次；
   *   2) 換文件後只預載「目前畫面用到的 sprite」，不用等整份索引。
   */
  const ASSET_REPAINT_INTERVAL = 120;
  let assetsUnsub = null;
  let repaintTimer = 0;
  let lastRepaintAt = 0;

  function assetStats() {
    try {
      return assets && typeof assets.stats === 'function' ? assets.stats() : null;
    } catch (_err) {
      return null;
    }
  }

  function pendingAssetCount() {
    const snap = assetStats();
    const n = snap ? Number(snap.pending) : 0;
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function repaintNow() {
    if (destroyed) return;
    repaintTimer = 0;
    lastRepaintAt = Date.now();
    redraw();
  }

  function scheduleRepaint(wait = 0) {
    if (destroyed || repaintTimer) return;
    const delay = Math.max(0, Number(wait) || 0);
    repaintTimer = setTimeout(repaintNow, delay);
  }

  /** 素材還沒載完：最多每 ASSET_REPAINT_INTERVAL 毫秒重畫一次 */
  function scheduleThrottledRepaint() {
    if (destroyed) return;
    const wait = Math.max(0, ASSET_REPAINT_INTERVAL - (Date.now() - lastRepaintAt));
    scheduleRepaint(wait);
  }

  function cancelRepaint() {
    if (repaintTimer) {
      clearTimeout(repaintTimer);
      repaintTimer = 0;
    }
  }

  function armAssetRepaint() {
    if (assetsUnsub || destroyed) return;
    if (!assets || typeof assets.onProgress !== 'function') return;
    try {
      assetsUnsub = assets.onProgress((snap) => {
        if (destroyed || usingFallback) return;
        const pending = snap && Number.isFinite(Number(snap.pending)) ? Number(snap.pending) : pendingAssetCount();
        if (pending > 0) scheduleThrottledRepaint();
        else scheduleRepaint(0);
      });
    } catch (err) {
      console.warn('[encounter:preview] assets.onProgress 掛載失敗：', err);
      assetsUnsub = null;
    }
  }

  /** 目前畫面會用到的 sprite 名稱（引擎狀態 + 文件裡所有動畫） */
  function collectVisibleSpriteNames() {
    const names = new Set();
    try {
      const st = getState();
      const list = (st && st.actors) || [];
      for (const actor of list) {
        if (actor && typeof actor.sprite === 'string' && actor.sprite) names.add(actor.sprite);
      }
    } catch (_err) {
      /* 忽略 */
    }
    const doc = currentEncounter();
    const actors = doc && doc.actors && typeof doc.actors === 'object' ? doc.actors : {};
    for (const id of Object.keys(actors)) {
      const anims = actors[id] && actors[id].anims;
      if (!anims || typeof anims !== 'object') continue;
      for (const key of Object.keys(anims)) {
        const anim = anims[key];
        if (anim && typeof anim.sprite === 'string' && anim.sprite) names.add(anim.sprite);
      }
    }
    return Array.from(names);
  }

  function preloadVisibleSprites() {
    if (!assets || typeof assets.preload !== 'function') return;
    const names = collectVisibleSpriteNames();
    if (!names.length) return;
    let task = null;
    try {
      task = assets.preload(names);
    } catch (err) {
      console.warn('[encounter:preview] 預載演員素材失敗：', err);
      return;
    }
    scheduleThrottledRepaint();
    if (task && typeof task.then === 'function') {
      task
        .then(() => {
          if (!destroyed) scheduleRepaint(0);
        })
        .catch(() => {});
    }
  }

  /** 文件載入完成後：補畫 + 預載（引擎建立渲染器是非同步的，第一次 draw 可能還沒畫到） */
  function afterDocumentLoad() {
    if (destroyed) return;
    scheduleRepaint(0);
    scheduleRepaint(60);
    scheduleRepaint(220);
    preloadVisibleSprites();
  }

  /**
   * 引擎缺席時的替代畫面（依 SPEC-LAYOUT 的分區 1/6/7）：
   *   - 背景只鋪 y 0–362，以下純黑
   *   - y 362 / y 402 兩條細分隔線；中間是隊伍面板列（y 365–400）
   *   - 旁白／開場文字只在底部文字區（y 405–480），不在戰場中間
   *   - 戰鬥框參考線固定在 LAYOUT.BATTLE_BOX（中心 320,190、144×158）
   *   - 演員方塊以「腳底」為錨點（與 engine/render-encounter.js 一致）
   */
  function paintFallback() {
    if (!canvas) return;
    const ctx = canvas.getContext && canvas.getContext('2d');
    if (!ctx) return;
    if (!canvas.classList.contains('is-fallback')) canvas.classList.add('is-fallback');

    const doc = currentEncounter();
    const w = VIEW_W;
    const h = VIEW_H;
    const battleBottom = LAYOUT.BATTLE_AREA_BOTTOM;
    const textTop = LAYOUT.TEXT_TOP;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // 背景：只鋪到 y 362（§1），以下純黑
    ctx.fillStyle = '#0b0b10';
    ctx.fillRect(0, 0, w, battleBottom);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, battleBottom, w, h - battleBottom);
    if (options.showGrid) {
      ctx.strokeStyle = 'rgba(255,255,255,0.045)';
      ctx.lineWidth = 1;
      for (let gx = 0; gx <= w; gx += 32) {
        ctx.beginPath();
        ctx.moveTo(gx + 0.5, 0);
        ctx.lineTo(gx + 0.5, battleBottom);
        ctx.stroke();
      }
      for (let gy = 0; gy <= battleBottom; gy += 32) {
        ctx.beginPath();
        ctx.moveTo(0, gy + 0.5);
        ctx.lineTo(w, gy + 0.5);
        ctx.stroke();
      }
    }

    // 分區線（§1）：y 362＝戰場／隊伍面板，y 402＝面板／底部文字區
    // （與 engine/render-encounter.js 同位置：BATTLE_AREA_BOTTOM、TEXT_TOP-3）
    ctx.strokeStyle = 'rgba(180,180,200,0.42)';
    ctx.lineWidth = 1;
    for (const lineY of [LAYOUT.BATTLE_AREA_BOTTOM, LAYOUT.TEXT_TOP - 3]) {
      ctx.beginPath();
      ctx.moveTo(0, lineY + 0.5);
      ctx.lineTo(w, lineY + 0.5);
      ctx.stroke();
    }

    // 隊伍面板列（§6）
    drawFallbackPanels(ctx, doc, w);

    // 開場文字（第一回合 flavor，否則 settings.introText）：只畫在底部文字區（§7）
    const lang = effectiveBattleLang() === 'en' ? 'en' : 'zh';
    const turn0 = turns()[0] || {};
    const intro =
      pickText(turn0.flavor, lang) ||
      pickText(doc.settings && doc.settings.introText, lang) ||
      t('encpreview.fallback.banner');
    ctx.fillStyle = '#ffffff';
    ctx.font = '16px "Cascadia Mono", Consolas, monospace';
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    const lines = String(intro).split(/\\n|\n/);
    for (let i = 0; i < lines.length && i < 2; i += 1) {
      const padX = i === 0 ? LAYOUT.TEXT_LEFT : LAYOUT.TEXT_INDENT;
      const lineY = textTop + 6 + i * Math.round(LAYOUT.TEXT_LINE_HEIGHT * 0.8);
      ctx.fillText(lines[i], padX, lineY);
    }

    // 頂部提示：這是替代畫面
    ctx.fillStyle = 'rgba(255,216,74,0.92)';
    ctx.font = '13px "Microsoft JhengHei", Droid Sans Fallback, sans-serif';
    ctx.fillText(t('encpreview.fallback.banner'), 16, 12);

    // 戰鬥框參考線（§5）：LAYOUT.BATTLE_BOX，中心 (320,190)、144×158、綠描邊 3px
    const box = LAYOUT.BATTLE_BOX;
    const boxLeft = box.x - box.w / 2;
    const boxTop = box.y - box.h / 2;
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(boxLeft, boxTop, box.w, box.h);
    ctx.strokeStyle = box.color;
    ctx.lineWidth = box.border;
    ctx.strokeRect(boxLeft + box.border / 2, boxTop + box.border / 2, box.w - box.border, box.h - box.border);

    // 演員（低成本方塊；以腳底為錨點，位置與渲染一致）
    const actors = doc.actors && typeof doc.actors === 'object' ? doc.actors : {};
    const party = Array.isArray(doc.party) ? doc.party : [];
    const enemies = Array.isArray(doc.enemies) ? doc.enemies : [];
    const drawActor = (actorId, kind, label) => {
      const a = actors[actorId];
      const spot = fallbackSpotFor(doc, actorId);
      const ax = a ? num(a.x, spot.x) : spot.x;
      // y 即「腳底」（與 render-encounter 相同語意）；缺值才退回 LAYOUT 的預設置位
      const feetY = a ? num(a.y, spot.y) : spot.y;
      const bw = 32;
      const bh = 44;
      ctx.fillStyle = kind === 'party' ? '#00a8ff' : '#ff5f7a';
      ctx.fillRect(ax - bw / 2, feetY - bh, bw, bh);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 2;
      ctx.strokeRect(ax - bw / 2, feetY - bh, bw, bh);
      // 腳底基準線：讓拖曳把手對齊腳底一目了然
      ctx.strokeStyle = 'rgba(255,255,255,0.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(ax - bw / 2 - 3, feetY + 0.5);
      ctx.lineTo(ax + bw / 2 + 3, feetY + 0.5);
      ctx.stroke();
      ctx.fillStyle = '#cfcfe0';
      // 名字：有 DOM 把手圖層時由 .fb-name 負責（避免和座標提示疊字）；沒有圖層才畫在 canvas 上
      if (!actorLayer) {
        ctx.font = '11px "Cascadia Mono", Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.fillText(String(label || actorId || '').slice(0, 12), ax, feetY + 6);
        ctx.textAlign = 'left';
      }
    };
    party.forEach((p) => {
      if (!p || p.hp === 0) return;
      drawActor(p.actor, 'party', p.name || p.id);
    });
    enemies.forEach((e) => {
      if (!e) return;
      drawActor(e.actor, 'enemy', e.name || e.id);
    });

    ctx.restore();
    paintActorLayer();
  }

  /** 替代畫面的隊伍面板列（§6：y 365–400，每人一格 → 名字 + HP 條） */
  function drawFallbackPanels(ctx, doc, w) {
    const party = Array.isArray(doc.party) ? doc.party : [];
    if (!party.length) return;
    const top = LAYOUT.PANEL_TOP;
    const height = LAYOUT.PANEL_HEIGHT;
    const cells = panelCells(party.length, w);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    for (let i = 0; i < party.length; i += 1) {
      const p = party[i];
      if (!p) continue;
      const cell = cells[i];
      if (!cell) continue;
      const midY = top + height / 2;
      const hp = num(p.hp, 0);
      const max = Math.max(1, num(p.maxHp, 1));
      ctx.fillStyle = p.color || '#ffffff';
      ctx.fillRect(cell.left + 2, top + 2, 2, height - 4);
      ctx.font = '11px "Cascadia Mono", Consolas, monospace';
      ctx.fillStyle = '#ffffff';
      const nameX = cell.left + LAYOUT.PANEL_AVATAR_SIZE * LAYOUT.PANEL_AVATAR_SCALE + 6;
      ctx.fillText(String(p.name || p.id || '').toUpperCase().slice(0, 10), nameX, midY);
      const bar = LAYOUT.PANEL_HP_BAR;
      const barX = cell.left + bar.dx;
      ctx.fillStyle = '#556677';
      ctx.fillRect(barX, midY + 4, bar.w, bar.h);
      ctx.fillStyle = hp / max > 0.3 ? '#35d07f' : '#ff4d5a';
      ctx.fillRect(barX, midY + 4, Math.max(0, Math.min(1, hp / max)) * bar.w, bar.h);
      ctx.fillStyle = '#9696a6';
      ctx.font = '10px "Cascadia Mono", Consolas, monospace';
      ctx.fillText(`${hp}/${max}`, barX, midY - 6);
    }
    ctx.textBaseline = 'top';
  }

  /**
   * 隊伍面板格子（與 engine/render-encounter.js 的 panelCells 同規則）：
   * 3~4 人平分全寬；1~2 人靠中間（§6 例：x107–318 / x340–555）。
   * @param {number} count
   * @param {number} w 畫面寬
   * @returns {{left:number,width:number,right:number}[]}
   */
  function panelCells(count, w) {
    const n = Math.max(1, Math.min(4, Math.round(num(count, 1))));
    const cells = [];
    if (n >= 3) {
      const cw = w / n;
      for (let i = 0; i < n; i += 1) {
        cells.push({ left: Math.round(cw * i), width: Math.round(cw), right: Math.round(cw * (i + 1)) });
      }
      return cells;
    }
    const cw = 211;
    const left0 = n === 2 ? LAYOUT.PANEL_MARGIN : Math.round((w - cw) / 2);
    for (let i = 0; i < n; i += 1) {
      const left = left0 + i * (cw + LAYOUT.PANEL_GAP);
      cells.push({ left, width: cw, right: left + cw });
    }
    return cells;
  }

  /**
   * 替代模式的演員圖層：可拖曳改 actors.<id>.x / y。
   * - 位置退回值走 LAYOUT（隊員 §3 縱列、敵人 §4 錨點），不再用畫面中心
   * - 把手以「腳底」為錨點：node 底邊 = y（與 engine/render-encounter.js 一致）
   */
  function paintActorLayer() {
    if (!actorLayer) return;
    const show = usingFallback;
    actorLayer.hidden = !show;
    if (!show) {
      actorLayer.innerHTML = '';
      return;
    }
    const doc = currentEncounter();
    const actors = doc.actors && typeof doc.actors === 'object' ? doc.actors : {};
    const selected = store.selection || {};
    const keys = Object.keys(actors);
    const spotOf = (id) => fallbackSpotFor(doc, id);
    const sig = JSON.stringify(
      keys.map((k) => {
        const spot = spotOf(k);
        return [k, num(actors[k] && actors[k].x, spot.x), num(actors[k] && actors[k].y, spot.y), store.selection && store.selection.path];
      }),
    );
    if (actorLayer.dataset.sig === sig && actorLayer.children.length) return;
    actorLayer.dataset.sig = sig;
    actorLayer.innerHTML = '';
    const hint = document.createElement('div');
    hint.className = 'fb-hint';
    hint.textContent = t('encpreview.fallback.actors');
    actorLayer.appendChild(hint);
    for (const id of keys) {
      const a = actors[id] || {};
      const spot = spotOf(id);
      const x = num(a.x, spot.x);
      const y = num(a.y, spot.y); // y = 腳底
      const node = document.createElement('div');
      node.className = `fb-actor${selected && selected.path === `actors.${id}` ? ' is-selected' : ''}`;
      node.dataset.actor = id;
      node.dataset.kind = a.kind === 'enemy' ? 'enemy' : 'party';
      node.style.left = `${(x / VIEW_W) * 100}%`;
      node.style.top = `${(y / VIEW_H) * 100}%`;
      const body = document.createElement('div');
      body.className = 'fb-body';
      body.style.background = a.kind === 'enemy' ? '#ff5f7a' : '#00a8ff';
      const name = document.createElement('div');
      name.className = 'fb-name';
      name.textContent = id;
      const pos = document.createElement('div');
      pos.className = 'fb-pos';
      pos.textContent = `${Math.round(x)}, ${Math.round(y)}`;
      node.append(body, name, pos);
      node.title = `${id} — x ${Math.round(x)} / 腳底 y ${Math.round(y)}`;
      node.addEventListener('pointerdown', (ev) => beginActorDrag(ev, id));
      actorLayer.appendChild(node);
    }
  }

  let actorDrag = null;

  function beginActorDrag(ev, actorId) {
    if (ev.button !== undefined && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const doc = currentEncounter();
    const actor = doc.actors && doc.actors[actorId];
    if (!actor) return;
    const spot = fallbackSpotFor(doc, actorId);
    store.setSelection({ kind: 'actor', id: actorId, path: `actors.${actorId}` });
    actorDrag = {
      id: actorId,
      startX: ev.clientX,
      startY: ev.clientY,
      // 錨點＝腳底（與渲染一致）：拖曳位移直接改 x / 腳底 y
      originX: num(actor.x, spot.x),
      originY: num(actor.y, spot.y),
      pointerId: ev.pointerId,
    };
    if (ev.currentTarget && ev.currentTarget.setPointerCapture) {
      try {
        ev.currentTarget.setPointerCapture(ev.pointerId);
      } catch (_err) {
        /* 忽略 */
      }
    }
    window.addEventListener('pointermove', onActorDragMove, true);
    window.addEventListener('pointerup', onActorDragEnd, true);
    window.addEventListener('pointercancel', onActorDragEnd, true);
  }

  function onActorDragMove(ev) {
    if (!actorDrag) return;
    const rect = viewport ? viewport.getBoundingClientRect() : { width: VIEW_W, height: VIEW_H };
    // §4-10：位移換算與「點擊座標 → 遊戲座標」共用同一個函式（previewToGame），
    // 避免兩套換算各自漂移（縮放倍率改變時最容易出錯）。
    const delta = previewToGame(
      { x: ev.clientX - actorDrag.startX, y: ev.clientY - actorDrag.startY },
      rect,
      { clamp: false },
    );
    const x = clamp(actorDrag.originX + delta.x, 0, VIEW_W);
    const y = clamp(actorDrag.originY + delta.y, 0, VIEW_H);
    store.update(
      (draft) => {
        if (!draft.actors || !draft.actors[actorDrag.id]) return;
        draft.actors[actorDrag.id].x = x;
        draft.actors[actorDrag.id].y = y;
      },
      { label: t('encpreview.fallback.actors'), coalesceKey: `actor:move:${actorDrag.id}` },
    );
  }

  function onActorDragEnd() {
    if (!actorDrag) return;
    store.endCoalesce();
    actorDrag = null;
    window.removeEventListener('pointermove', onActorDragMove, true);
    window.removeEventListener('pointerup', onActorDragEnd, true);
    window.removeEventListener('pointercancel', onActorDragEnd, true);
  }

  /* ---------------------------------------------- 在預覽中拖曳演員（對外 API） */

  /**
   * 給演員編輯器（ED3）用：`preview.startActorDrag(actorId)` 之後，
   * 使用者在預覽畫面上按下滑鼠即可拖動該演員（引擎模式與替代模式都支援）。
   */
  let armedActorId = null;

  function setArmedCursor(on) {
    if (!viewport) return;
    viewport.classList.toggle('is-actor-drag-armed', Boolean(on));
  }

  function armActorDrag(actorId) {
    if (destroyed || !actorId) return false;
    const doc = currentEncounter();
    const actor = doc && doc.actors && doc.actors[actorId];
    if (!actor) return false;
    armedActorId = String(actorId);
    setArmedCursor(true);
    store.setSelection({ kind: 'actor', id: String(actorId), path: `actors.${actorId}` });
    return true;
  }

  function disarmActorDrag() {
    if (!armedActorId) return;
    armedActorId = null;
    setArmedCursor(false);
  }

  function onViewportPointerDown(ev) {
    if (!armedActorId) return;
    if (ev.button !== undefined && ev.button !== 0) return;
    const id = armedActorId;
    disarmActorDrag();
    beginActorDrag(ev, id);
  }

  /* -------------------------------------------------- 給面板的查詢 API */

  /** 演員清單（cue-editor / 檢查器的演員下拉用） */
  function listActors() {
    const doc = currentEncounter();
    const actors = doc && doc.actors && typeof doc.actors === 'object' ? doc.actors : {};
    const presets = presetsCache && typeof presetsCache === 'object' ? presetsCache : null;
    const names =
      presets && presets.displayNames && typeof presets.displayNames === 'object' ? presets.displayNames : {};
    const out = [];
    for (const id of Object.keys(actors)) {
      const def = actors[id] || {};
      const idle = def.anims && def.anims.idle ? def.anims.idle : null;
      // 未設定座標時的退回值＝LAYOUT 站位（與替代畫面／遊戲渲染同一套）
      const spot = fallbackSpotFor(doc, id);
      out.push({
        id,
        kind: def.kind === 'enemy' ? 'enemy' : 'party',
        name: typeof names[id] === 'string' && names[id] ? names[id] : id,
        sprite: idle && typeof idle.sprite === 'string' ? idle.sprite : null,
        x: num(def.x, spot.x),
        y: num(def.y, spot.y),
      });
    }
    return out;
  }

  const ATTACK_LIST_URL = '/api/attacks';
  const SAMPLE_INDEX_URL = 'samples/index.json';
  const ATTACK_NAMES_TIMEOUT = 900;
  let attackNameCache = null;
  let attackNamesPending = null;

  function normalizeAttackName(value) {
    if (typeof value !== 'string') return null;
    let name = value.trim();
    if (!name) return null;
    name = name.replace(/^.*[\\/]/, '');
    name = name.replace(/\.json$/i, '');
    return name || null;
  }

  async function fetchAttackNames() {
    const names = [];
    const push = (value) => {
      const name = normalizeAttackName(value);
      if (name && !names.includes(name)) names.push(name);
    };
    try {
      const res = await fetch(ATTACK_LIST_URL, { headers: { Accept: 'application/json' } });
      if (res && res.ok) {
        const data = await res.json();
        const items = Array.isArray(data)
          ? data
          : (data && (data.items || data.attacks || data.files || data.list)) || [];
        for (const item of items) push(item && typeof item === 'object' ? item.name || item.file || item : item);
      }
    } catch (_err) {
      /* 伺服器選項：失敗就用 samples 與文件內引用 */
    }
    try {
      const res = await fetch(SAMPLE_INDEX_URL, { headers: { Accept: 'application/json' } });
      if (res && res.ok) {
        const data = await res.json();
        const list = Array.isArray(data) ? data : (data && (data.samples || data.items || data.list)) || [];
        // samples/index.json 的 name 是顯示名稱（黑桃雨），真正要放進 attack 指令的是 file（spade-rain.json）
        for (const item of list) push(item && typeof item === 'object' ? item.file || item.name || item : item);
      }
    } catch (_err) {
      /* 忽略 */
    }
    return names;
  }

  function refreshAttackNames() {
    if (attackNamesPending) return attackNamesPending;
    attackNamesPending = fetchAttackNames()
      .then((names) => {
        attackNameCache = names;
        attackNamesPending = null;
        return names;
      })
      .catch(() => {
        attackNamesPending = null;
        return attackNameCache || [];
      });
    return attackNamesPending;
  }

  /** 文件裡引用到的攻擊名（attack 指令 / turn.attack 等） */
  function referencedAttackNames() {
    return [...collectAttackRefs(currentEncounter())];
  }

  function listAttacks() {
    const out = new Set(referencedAttackNames());
    for (const name of attackNameCache || []) out.add(name);
    return Array.from(out);
  }

  /* ------------------------------------------------------------ 狀態同步 */

  function getState() {
    if (engineReady && enc && typeof enc.getState === 'function') {
      try {
        const st = enc.getState();
        if (st && typeof st === 'object') return st;
      } catch (err) {
        console.warn('[encounter:preview] getState 失敗：', err);
      }
    }
    return {
      frame: currentFrame,
      lang: effectiveBattleLang(),
      phase: currentPhase,
      turn: currentTurn,
      actors: [],
      party: [],
      enemies: [],
      tp: 0,
      textbox: null,
      bubbles: [],
      menu: null,
      fight: null,
      numbers: [],
      battle: null,
      boxAnim: 0,
      fade: { color: '#000000', alpha: 0 },
      flash: { color: '#ffffff', alpha: 0 },
      result: null,
      fallback: usingFallback,
    };
  }

  function syncState() {
    const st = getState();
    const frame = num(st.frame, currentFrame);
    notifyFrame(frame);
    notifyPhase(String(st.phase || currentPhase), num(st.turn, currentTurn));
    if (usingFallback) paintFallback();
    return st;
  }

  /* ---------------------------------------------------------- 播放控制 */

  function play() {
    if (destroyed) return false;
    if (!engineReady) {
      // 沒有引擎：替代模式只做「階段展示」，讓使用者看得到回合切換
      playing = true;
      startManualPlayback(true);
      updateTransportUI();
      emitStatus(true);
      return true;
    }
    if (playing) return true;
    playing = true;
    // 自動演示時只由編輯器的固定步進迴圈推進（引擎自己的 rAF 迴圈會依實際時間
    // 多推幾幀 → 同一份 demo 每次結束幀不同，違反決定性）。
    if (autoplay.mode === 'off') safeCall(enc, 'play');
    else safeCall(enc, 'pause');
    startManualPlayback(false);
    updateTransportUI();
    emitStatus(true);
    return true;
  }

  function pause() {
    if (!playing) {
      updateTransportUI();
      return false;
    }
    playing = false;
    stopManualPlayback();
    safeCall(enc, 'pause');
    if (engineReady) syncState();
    updateTransportUI();
    emitStatus(true);
    return true;
  }

  function togglePlay() {
    return playing ? (pause(), false) : play();
  }

  /**
   * 編輯器自驅動播放。
   * 無頭 Edge 的 rAF 只觸發一次，所以一律用 setInterval + 時間累加，
   * 並用 enc.step() 推進引擎（引擎若已自己推進，step 只會補 0）。
   * @param {boolean} fallbackMode 沒有引擎時的假播放（只推進替代畫面的影格）
   */
  function startManualPlayback(fallbackMode) {
    stopManualPlayback();
    manualLast = Date.now();
    manualAcc = 0;
    const interval = 1000 / FPS;
    manualTimer = setInterval(() => {
      if (destroyed || !playing) return;
      const now = Date.now();
      const dt = now - manualLast;
      manualLast = now;
      manualAcc += dt;
      let steps = 0;
      while (manualAcc >= interval && steps < 5) {
        manualAcc -= interval;
        steps += 1;
      }
      if (steps === 0) return;
      if (fallbackMode) {
        // 假播放：短暫展示回合切換
        const total = Math.max(1, turns().length) * FPS * 3;
        let f = currentFrame + steps;
        if (f >= total) {
          f = 0;
          notifyPhase('turnStart', (currentTurn + 1) % Math.max(1, turns().length));
        }
        notifyFrame(f);
        paintFallback();
        return;
      }
      for (let i = 0; i < steps; i += 1) {
        // 一幀一步；結束事件會在 step 內 pause()（playing=false），因此立刻收手，
        // 不會在同一批多推幾幀 → 同一份 demo 每次跑到的結束幀一致（決定性）。
        if (!playing) break;
        const input = autoplayInput();
        if (input) safeCall(enc, 'step', 1, input);
        else safeCall(enc, 'step', 1);
      }
      syncState();
    }, 8);
  }

  function stopManualPlayback() {
    if (manualTimer) {
      clearInterval(manualTimer);
      manualTimer = 0;
    }
  }

  /* ------------------------------------------------------- 自動演示（§4） */

  /** 同步取攻擊檔（pilot 的 dodgePilotFor 需要 demo.path；已快取才有）。 */
  function cachedAttackDoc(name) {
    const key = typeof name === 'string' ? name.trim() : '';
    if (!key) return null;
    return attackCache.get(key)?.json ?? null;
  }

  /** 暖機：把本遭遇引用到的攻擊檔都抓進快取（不然 path 躲避沒有資料）。 */
  async function prefetchAttackDocs() {
    const names = referencedAttackNames();
    if (!names.length) return;
    await Promise.all(names.map(resolveAttackRef));
  }

  function autoplaySnapshot() {
    return {
      mode: autoplay.mode,
      ready: Boolean(autoplay.pilot),
      loading: Boolean(autoplay.loading),
      describe: autoplay.describe,
      warnings: Array.isArray(autoplay.warnings) ? autoplay.warnings.slice() : [],
      error: autoplay.error,
      playing,
    };
  }

  /** 廣播自動演示狀態（工具列開關用）。 */
  function emitAutoplay() {
    const snap = autoplaySnapshot();
    for (const fn of [...autoplaySubs]) {
      try {
        fn(snap);
      } catch (err) {
        console.warn('[encounter:preview] autoplay listener error', err);
      }
    }
    if (typeof paintAutoplayStatus === 'function') paintAutoplayStatus(snap);
    return snap;
  }

  /**
   * 把自動演示狀態反映到畫布外的元素（元素不存在也安全）。
   * 文字由 autoplay-bar.js 自己維護（它有 250ms 輪詢），這裡只同步 dataset。
   */
  function paintAutoplayStatus(snap) {
    if (typeof document === 'undefined') return;
    const info = snap && typeof snap === 'object' ? snap : autoplaySnapshot();
    const chip = document.getElementById('enc-auto-chip');
    if (chip) {
      chip.dataset.mode = info.mode;
      chip.classList.toggle('is-on', info.mode !== 'off');
      if (info.error) chip.dataset.error = '1';
      else delete chip.dataset.error;
    }
    const modeChip = document.getElementById('enc-mode-chip');
    if (modeChip && info.mode !== 'off') modeChip.dataset.autoplay = info.mode;
    else if (modeChip) delete modeChip.dataset.autoplay;
  }

  /** 建立 / 更新 pilot（同 mode 且文件未換就重用）。 */
  async function ensureAutopilot(mode) {
    const doc = currentEncounter();
    if (autoplay.pilot && autoplay.pilotMode === mode && autoplay.pilotDoc === doc) {
      return autoplay.pilot;
    }
    autoplay.pilot = null;
    autoplay.warnings = [];
    autoplay.error = '';
    autoplay.describe = null;
    const mod = await import(new URL(AUTOPLAY_MODULE, import.meta.url).href);
    const create = mod && (mod.createAutopilot || mod.default);
    if (typeof create !== 'function') throw new Error('engine/autoplay/index.js 沒有 createAutopilot');
    const pilot = create({
      kind: 'encounter',
      doc,
      mode,
      resolveAttackDoc: cachedAttackDoc,
    });
    autoplay.pilot = pilot;
    autoplay.pilotMode = mode;
    autoplay.pilotDoc = doc;
    autoplay.error = '';
    if (pilot && pilot.ready && typeof pilot.ready.then === 'function') {
      try {
        await pilot.ready;
      } catch (err) {
        autoplay.error = errText(err);
      }
    }
    autoplay.warnings = pilot && Array.isArray(pilot.warnings) ? pilot.warnings : [];
    return pilot;
  }

  function resetAutopilot() {
    if (!autoplay.pilot || typeof autoplay.pilot.reset !== 'function') {
      autoplay.describe = null;
      return false;
    }
    try {
      autoplay.pilot.reset();
    } catch (err) {
      autoplay.warnings = [...autoplay.warnings, `pilot.reset 失敗：${errText(err)}`];
    }
    autoplay.describe = null;
    return true;
  }

  /** 這一幀要餵給引擎的輸入（沒有自動就回 null = 讓引擎自己讀鍵盤）。 */
  function autoplayInput() {
    if (autoplay.mode === 'off' || !autoplay.pilot) return null;
    try {
      const st = getState();
      const input = autoplay.pilot.input(st, num(st.frame, currentFrame));
      if (autoplay.pilot && typeof autoplay.pilot.describe === 'function') {
        try {
          autoplay.describe = autoplay.pilot.describe();
        } catch (_err) {
          autoplay.describe = null;
        }
      }
      if (Array.isArray(autoplay.pilot.warnings) && autoplay.pilot.warnings.length !== autoplay.warnings.length) {
        autoplay.warnings = autoplay.pilot.warnings.slice();
      }
      return input && typeof input === 'object' ? input : null;
    } catch (err) {
      autoplay.error = errText(err);
      autoplay.warnings = [...autoplay.warnings, `pilot.input 失敗：${errText(err)}`];
      return null;
    }
  }

  /**
   * 切換自動模式（'off' | 'demo' | 'bot'）。
   * 開啟時一律從頭重播，保證決定性；關閉時交還鍵盤。
   * @returns {Promise<object>} getAutoplay()
   */
  async function setAutoplay(mode) {
    const next = mode === 'demo' ? 'demo' : mode === 'bot' ? 'bot' : 'off';
    if (autoplay.loading) {
      // 上一次切換還沒完成：等它，再以最新的 mode 為準
      try {
        await autoplay.loading;
      } catch (_err) {
        /* 忽略 */
      }
    }
    autoplay.mode = next;
    if (next === 'off') {
      autoplay.pilot = null;
      autoplay.pilotMode = null;
      autoplay.pilotDoc = null;
      autoplay.describe = null;
      autoplay.warnings = [];
      autoplay.error = '';
      if (playing) pause();
      emitAutoplay();
      return autoplaySnapshot();
    }
    autoplay.loading = (async () => {
      try {
        await prefetchAttackDocs();
        await ensureAutopilot(next);
      } catch (err) {
        autoplay.error = errText(err);
        autoplay.warnings = [...autoplay.warnings, `自動演示載入失敗：${errText(err)}`];
        console.warn('[encounter:preview] 自動演示載入失敗：', err);
      } finally {
        autoplay.loading = null;
      }
    })();
    await autoplay.loading;
    // 決定性：從頭播放（pilot.reset() 在 restart 內）
    restart();
    if (!playing) play();
    emitAutoplay();
    return autoplaySnapshot();
  }

  function getAutoplay() {
    return autoplaySnapshot();
  }

  /** 文件換了 / 跳回合 / 重來後，重建 pilot 並從頭重播（維持決定性）。 */
  async function replayAutoplay() {
    if (autoplay.mode === 'off') return false;
    const mode = autoplay.mode;
    autoplay.pilot = null;
    autoplay.pilotDoc = null;
    try {
      await ensureAutopilot(mode);
    } catch (err) {
      autoplay.error = errText(err);
      emitAutoplay();
      return false;
    }
    restart();
    if (!playing) play();
    emitAutoplay();
    return true;
  }

  function restart() {
    const wasPlaying = playing;
    if (wasPlaying) pause();
    resetAutopilot();
    if (engineReady && enc) {
      clearEngineErrors();
      safeCall(enc, 'reset');
      if (typeof enc.load === 'function') {
        // reset 之後有些實作需要重新載入才有完整狀態；失敗就算了
        // （引擎若沒實作 reset 的完整語意，下一行的 seek(0) 仍會給出合理畫面）
      }
      seekInternal(0, { force: true });
      syncState();
    } else {
      notifyFrame(0);
      notifyPhase('intro', 0);
      paintFallback();
    }
    runValidation();
    return true;
  }

  function gotoStart() {
    if (playing) pause();
    resetAutopilot();
    if (engineReady && enc) {
      safeCall(enc, 'reset');
      seekInternal(0, { force: true });
      syncState();
    } else {
      notifyFrame(0);
      paintFallback();
    }
  }

  function seekInternal(frame, { force = false } = {}) {
    const target = Math.max(0, Math.round(num(frame, currentFrame)));
    if (engineReady && enc && typeof enc.seek === 'function') {
      try {
        enc.seek(target);
      } catch (err) {
        console.warn('[encounter:preview] enc.seek 失敗：', err);
      }
    } else if (engineReady && enc && typeof enc.step === 'function') {
      try {
        enc.reset();
        enc.step(target);
      } catch (err) {
        console.warn('[encounter:preview] enc.step 失敗：', err);
      }
    }
    if (force && engineReady) {
      const st = getState();
      notifyFrame(num(st.frame, target));
      return st;
    }
    notifyFrame(target);
    return null;
  }

  function seek(frame) {
    if (playing) pause();
    if (engineReady && enc) {
      const st = seekInternal(frame, { force: true });
      if (st) notifyPhase(String(st.phase || currentPhase), num(st.turn, currentTurn));
    } else {
      notifyFrame(frame);
      paintFallback();
    }
  }

  function step(delta = 1) {
    if (destroyed) return;
    const d = Math.round(num(delta, 1));
    if (playing) pause();
    if (d === 0) return;
    if (engineReady && enc && typeof enc.step === 'function') {
      if (d > 0) {
        try {
          enc.step(d);
        } catch (err) {
          console.warn('[encounter:preview] enc.step 失敗：', err);
        }
        syncState();
        return;
      }
      // 引擎只支援往前推進：倒退用 reset + 重播到目標幀（deterministic）
      const target = Math.max(0, currentFrame + d);
      const st = seekInternal(target, { force: true });
      if (st) notifyPhase(String(st.phase || currentPhase), num(st.turn, currentTurn));
      syncState();
      return;
    }
    notifyFrame(Math.max(0, currentFrame + d));
    paintFallback();
  }

  /**
   * 跳到第 N 回合（1 起算；UI 給使用者看的編號）。
   * @returns {boolean}
   */
  function jumpToTurn(n) {
    const list = turns();
    const max = list.length;
    if (!max) return false;
    const idx = clamp(Math.round(num(n, 1)) - 1, 0, max - 1);
    if (playing) pause();
    resetAutopilot();
    if (engineReady && enc && enc.debug && typeof enc.debug.jumpToTurn === 'function') {
      try {
        enc.debug.jumpToTurn(idx);
        syncState();
        notifyPhase(String(getState().phase || 'turnStart'), idx);
        if (autoplay.mode !== 'off' && !playing) play();
        emitAutoplay();
        return true;
      } catch (err) {
        console.warn('[encounter:preview] debug.jumpToTurn 失敗：', err);
        return false;
      }
    }
    if (engineReady && enc) {
      // 沒有 debug API：至少把回合編號與顯示更新，讓使用者知道選了哪一回合
      notifyPhase('turnStart', idx);
      scheduleStatus();
      return true;
    }
    notifyPhase('turnStart', idx);
    paintFallback();
    return true;
  }

  /**
   * 執行一段指令清單（除錯用）。
   * @param {any[]} cues
   * @returns {boolean}
   */
  function runCues(cues) {
    if (!Array.isArray(cues)) return false;
    if (engineReady && enc && enc.debug && typeof enc.debug.runCues === 'function') {
      try {
        enc.debug.runCues(cues);
        syncState();
        return true;
      } catch (err) {
        console.warn('[encounter:preview] debug.runCues 失敗：', err);
        return false;
      }
    }
    // 沒有引擎：把打算執行的指令印出來，編輯器仍可看到結果（也方便測試）
    console.info('[encounter:preview] 引擎未就緒，指令清單（未實際執行）：', cues);
    return false;
  }

  /**
   * 執行 store.cuePath 目前指向的指令清單。
   * ED2 的「執行指令」按鈕直接呼叫這個。
   * @returns {{ok:boolean, count:number, cues:any[]|null, reason?:string}}
   */
  function runSelectedCues() {
    const doc = currentEncounter();
    let path = store.cuePath || defaultCuePathFor(doc, store.selection);
    let cues = path ? getAtPath(doc, path) : null;
    if (!Array.isArray(cues)) {
      // 選到的可能是 hooks.intro 這種空陣列（合法）或指向物件 → 再試一次推導
      const derived = defaultCuePathFor(doc, store.selection);
      if (derived && derived !== path) {
        path = derived;
        cues = getAtPath(doc, path);
      }
    }
    if (!Array.isArray(cues)) {
      return { ok: false, count: 0, cues: null, reason: t('encpreview.runCuesNone') };
    }
    if (cues.length === 0) {
      return { ok: false, count: 0, cues, reason: t('encpreview.runCuesNone') };
    }
    const ok = runCues(cues);
    return { ok, count: cues.length, cues, path };
  }

  /* ------------------------------------------------------------ 除錯浮窗 */

  function setDebugVisible(visible) {
    debugVisible = Boolean(visible);
    writeDebugPref(debugVisible);
    if (debugEl) {
      debugEl.hidden = !debugVisible;
      if (debugVisible) refreshDebug();
    }
    emitStatus(true);
    return debugVisible;
  }

  function isDebugVisible() {
    return debugVisible;
  }

  function rowEl(label, value, cls) {
    const row = document.createElement('div');
    row.className = 'dbg-row';
    const a = document.createElement('span');
    a.textContent = label;
    const b = document.createElement('span');
    b.textContent = value;
    if (cls) b.className = cls;
    row.append(a, b);
    return row;
  }

  function sectionEl(title) {
    const h = document.createElement('h4');
    h.textContent = title;
    return h;
  }

  function refreshDebug() {
    if (!debugEl || !debugVisible) return;
    const st = getState();
    const frag = document.createDocumentFragment();

    frag.appendChild(sectionEl(t('encpreview.debugTitle')));
    frag.appendChild(rowEl(t('encpreview.debugPhase'), phaseLabel(st.phase)));
    frag.appendChild(rowEl(t('encpreview.debugTurn'), String(num(st.turn, 0) + 1)));
    frag.appendChild(rowEl(t('encpreview.debugFrame'), String(num(st.frame, 0))));
    frag.appendChild(rowEl(t('encpreview.debugTp'), String(Math.round(num(st.tp, 0)))));

    if (usingFallback) {
      const note = document.createElement('div');
      note.className = 'dbg-empty';
      note.textContent = t('encpreview.debugNoEngine');
      frag.appendChild(note);
    }

    const doc = currentEncounter();
    const vars = doc.vars && typeof doc.vars === 'object' ? doc.vars : {};
    const varKeys = Object.keys(vars);
    const runtimeVars = st && st.vars && typeof st.vars === 'object' ? st.vars : null;
    const mergedVarKeys = runtimeVars ? Object.keys(runtimeVars) : varKeys;
    if (mergedVarKeys.length) {
      frag.appendChild(sectionEl(t('encpreview.debugVars')));
      for (const key of mergedVarKeys) {
        const value = runtimeVars && runtimeVars[key] !== undefined ? runtimeVars[key] : vars[key];
        frag.appendChild(rowEl(key, String(value)));
      }
    }

    const party = Array.isArray(st.party) && st.party.length ? st.party : null;
    if (party) {
      frag.appendChild(sectionEl(t('encpreview.debugParty')));
      for (const p of party) {
        const hp = num(p.hp, 0);
        const max = Math.max(1, num(p.maxHp, 1));
        frag.appendChild(rowEl(p.name || p.id, `${hp}/${max}`, hp / max > 0.3 ? 'dbg-hp' : 'dbg-hp is-low'));
      }
    }

    const enemies = Array.isArray(st.enemies) && st.enemies.length ? st.enemies : null;
    if (enemies) {
      frag.appendChild(sectionEl(t('encpreview.debugEnemies')));
      for (const e of enemies) {
        const hp = num(e.hp, 0);
        const max = Math.max(1, num(e.maxHp, 1));
        frag.appendChild(rowEl(e.name || e.id, `${hp}/${max}`, 'dbg-mercy'));
      }
    }

    debugEl.innerHTML = '';
    debugEl.appendChild(frag);
  }

  function phaseLabel(phase) {
    const key = `encpreview.phase.${phase || 'unknown'}`;
    const label = t(key);
    return label === key ? t('encpreview.phase.unknown') : label;
  }

  /* --------------------------------------------------- 傳輸列（時間碼等） */

  function paintTransport() {
    if (typeof document === 'undefined') return;
    const tc = document.getElementById('enc-timecode');
    if (tc) {
      const total = Math.max(1, turns().length) * FPS * 3;
      tc.textContent = t('encpreview.timecode', { now: formatTimecode(currentFrame), total: formatTimecode(total) });
      tc.title = t('encpreview.timecodeTitle', { frame: currentFrame, total });
    }
    const phaseChip = document.getElementById('enc-phase-chip');
    if (phaseChip) {
      phaseChip.textContent = phaseLabel(currentPhase);
      phaseChip.dataset.phase = currentPhase;
    }
    const turnChip = document.getElementById('enc-turn-chip');
    if (turnChip) {
      const max = Math.max(1, turns().length);
      turnChip.textContent = `${Math.min(currentTurn + 1, max)} / ${max}`;
    }
    const meta = document.getElementById('enc-preview-meta');
    if (meta) {
      meta.textContent = usingFallback ? t('encpreview.fallback.banner') : `${FPS} FPS`;
    }
  }

  function updateTransportUI() {
    if (typeof document === 'undefined') return;
    const btn = document.getElementById('enc-btn-play-pause');
    if (btn) {
      btn.textContent = playing ? '❚❚' : '▶';
      btn.title = playing ? t('encpreview.pause') : t('encpreview.play');
      btn.setAttribute('aria-pressed', playing ? 'true' : 'false');
      btn.classList.toggle('is-playing', playing);
    }
    const modeChip = document.getElementById('enc-mode-chip');
    if (modeChip) {
      modeChip.textContent = usingFallback
        ? t('encpreview.modeNoEngine')
        : playing
          ? t('encpreview.modePlaying')
          : t('encpreview.modeEdit');
      modeChip.classList.toggle('is-playing', playing);
    }
    paintAutoplayStatus(autoplaySnapshot());
    const langBtn = document.getElementById('enc-btn-battle-lang');
    if (langBtn) {
      const lang = effectiveBattleLang();
      langBtn.textContent = lang === 'en' ? 'EN' : '中';
      langBtn.classList.toggle('is-en', lang === 'en');
      langBtn.setAttribute('aria-pressed', lang === 'en' ? 'true' : 'false');
      langBtn.title = t('encpreview.langTip');
      langBtn.dataset.lang = lang;
    }
    const toolbarPlay = document.getElementById('enc-btn-play');
    if (toolbarPlay) {
      toolbarPlay.textContent = playing ? `❚❚ ${t('enctoolbar.pause')}` : `▶ ${t('enctoolbar.play')}`;
    }
    const debugBtn = document.getElementById('enc-btn-debug');
    if (debugBtn) debugBtn.setAttribute('aria-pressed', debugVisible ? 'true' : 'false');
  }

  /* ---------------------------------------------------------- 選項 / 語言 */

  function setOptions(patch) {
    if (!patch || typeof patch !== 'object') return { ...options };
    for (const key of ['showHitboxes', 'showGrid', 'muted']) {
      if (patch[key] !== undefined) options[key] = Boolean(patch[key]);
    }
    if (patch.scale !== undefined && Number.isFinite(Number(patch.scale))) scale = Number(patch.scale);
    if (patch.lang === 'zh' || patch.lang === 'en') {
      manualBattleLang = patch.lang;
      writeManualBattleLang(manualBattleLang);
    }
    applyOptions();
    if (usingFallback) paintFallback();
    else redraw();
    updateTransportUI();
    emitStatus(true);
    return { ...options };
  }

  function getOptions() {
    return { ...options, lang: effectiveBattleLang(), debugVisible };
  }

  function setBattleLang(next) {
    const target = next === 'zh' || next === 'en' ? next : effectiveBattleLang() === 'en' ? 'zh' : 'en';
    manualBattleLang = target;
    writeManualBattleLang(target);
    applyOptions();
    if (usingFallback) paintFallback();
    runValidation();
    updateTransportUI();
    emitStatus(true);
    return target;
  }

  function followLocaleBattleLang() {
    manualBattleLang = null;
    writeManualBattleLang(null);
    applyOptions();
    if (usingFallback) paintFallback();
    updateTransportUI();
    emitStatus(true);
    return effectiveBattleLang();
  }

  function getBattleLang() {
    return effectiveBattleLang();
  }

  /* ---------------------------------------------------------- store 連動 */

  let observedDoc = currentEncounter();
  function onStoreChange(_store, change) {
    if (destroyed) return;
    const c = change || {};
    if (c.errors) {
      updateTransportUI();
      return;
    }
    if (c.selectionOnly) {
      if (debugVisible) refreshDebug();
      if (usingFallback) paintActorLayer();
      return;
    }
    const doc = currentEncounter();
    if (doc === observedDoc) return;
    observedDoc = doc;
    // 文件內容變更：重新載入（保留目前幀，除非是 reset/開檔）
    if (c.reset || c.document || !c.paths || c.paths.includes('$')) {
      queueReload(true);
      return;
    }
    queueReload(false);
  }

  let reloadTimer = 0;
  let pendingReload = null;
  let reloading = false;
  const attackListeners = new Set();

  function invalidateAttack(name) {
    const key = normalizeAttackName(name);
    if (key) {
      attackCache.delete(key);
      worksAttackList = null;
    } else clearAttackCache();
    void refreshAttackNames();
    if (key && !referencedAttackNames().includes(key)) return;
    for (const notify of attackListeners) notify();
    queueReload(false);
  }

  function queueReload(reset) {
    pendingReload = Boolean(pendingReload || reset);
    if (reloadTimer || reloading) return;
    reloadTimer = setTimeout(async () => {
      reloadTimer = 0;
      if (destroyed) return;
      const doReset = pendingReload;
      pendingReload = null;
      reloading = true;
      if (doReset) {
        currentFrame = 0;
        currentPhase = 'intro';
        currentTurn = 0;
      }
      try {
        await loadCurrent({ resetFrame: doReset });
        if (destroyed) return;
        if (usingFallback) paintFallback();
        updateTransportUI();
        if (autoplay.mode !== 'off') await replayAutoplay();
      } finally {
        reloading = false;
        if (!destroyed && pendingReload !== null) queueReload(pendingReload);
      }
    }, 90);
  }

  /* ---------------------------------------------------------------- 生命週期 */

  async function init() {
    if (canvas) canvas.classList.add('is-fallback');
    runValidation();
    paintFallback();
    paintTransport();
    updateTransportUI();
    const ok = await loadEngine();
    if (ok) {
      armAssetRepaint();
      await loadCurrent({ resetFrame: true });
    } else {
      paintFallback();
      notifyFrame(0);
      notifyPhase('intro', 0);
    }
    if (debugEl) debugEl.hidden = !debugVisible;
    // 面板（cue-editor / 檢查器）在掛載時就會同步讀取攻擊清單，先抓一次
    try {
      await Promise.race([refreshAttackNames(), new Promise((resolve) => setTimeout(resolve, ATTACK_NAMES_TIMEOUT))]);
    } catch (_err) {
      /* 忽略 */
    }
    if (viewport) viewport.addEventListener('pointerdown', onViewportPointerDown);
    if (debugVisible) refreshDebug();
    unsubscribeStore = store.subscribe(onStoreChange);
    unsubscribeLocale = onLocaleChange(() => {
      if (!manualBattleLang) applyOptions();
      // 介面字串變了：替代畫面與除錯浮窗都要重繪
      if (usingFallback) paintFallback();
      paintTransport();
      updateTransportUI();
      if (debugVisible) refreshDebug();
      emitStatus(true);
    });
    if (typeof ResizeObserver === 'function' && stage) {
      resizeObserver = new ResizeObserver(() => resize());
      try {
        resizeObserver.observe(stage);
      } catch (_err) {
        /* 忽略 */
      }
    }
    applyScale();
    emitStatus(true);
    return true;
  }

  function resize() {
    if (destroyed) return;
    applyScale();
    if (usingFallback) paintFallback();
    else redraw();
  }

  function refresh() {
    if (destroyed) return;
    runValidation();
    if (engineReady) {
      loadCurrent({ resetFrame: false }).then(() => {
        if (usingFallback) paintFallback();
      });
    } else {
      paintFallback();
    }
  }

  function destroy() {
    destroyed = true;
    playing = false;
    stopManualPlayback();
    cancelRepaint();
    if (assetsUnsub) {
      try {
        assetsUnsub();
      } catch (_err) {
        /* 忽略 */
      }
      assetsUnsub = null;
    }
    if (reloadTimer) clearTimeout(reloadTimer);
    if (statusTimer) clearTimeout(statusTimer);
    if (resizeObserver) {
      try {
        resizeObserver.disconnect();
      } catch (_err) {
        /* 忽略 */
      }
    }
    if (unsubscribeStore) unsubscribeStore();
    if (unsubscribeLocale) unsubscribeLocale();
    autoplay.mode = 'off';
    autoplay.pilot = null;
    autoplay.pilotMode = null;
    autoplay.pilotDoc = null;
    autoplaySubs.clear();
    disarmActorDrag();
    if (viewport) viewport.removeEventListener('pointerdown', onViewportPointerDown);
    onActorDragEnd();
    safeCall(enc, 'destroy');
    enc = null;
    frameSubs.clear();
    statusSubs.clear();
    phaseSubs.clear();
    errorSubs.clear();
  }

  /* ------------------------------------------------------------------ 公開 */

  const api = {
    // --- 狀態 ---
    get ready() {
      return engineReady;
    },
    get engineReady() {
      return engineReady;
    },
    get engineFailed() {
      return engineFailed;
    },
    get usingFallback() {
      return usingFallback;
    },
    get engine() {
      return engineMod;
    },
    getEncounter: () => enc,

    // --- 播放 ---
    play,
    pause,
    togglePlay,
    isPlaying: () => playing,
    restart,
    gotoStart,
    step,
    seek,
    getFrame: () => (engineReady ? num(getState().frame, currentFrame) : currentFrame),
    getPhase: () => currentPhase,
    getTurn: () => currentTurn,
    getState,
    jumpToTurn,
    runCues,
    runSelectedCues,
    getTurnCount: () => turns().length,

    // --- 自動演示（SPEC-AUTOPLAY §4）---
    setAutoplay,
    getAutoplay,
    isAutoplayOn: () => autoplay.mode !== 'off',
    onAutoplay(fn) {
      if (typeof fn !== 'function') return () => {};
      autoplaySubs.add(fn);
      try {
        fn(autoplaySnapshot());
      } catch (err) {
        console.warn('[encounter:preview] autoplay listener error', err);
      }
      return () => autoplaySubs.delete(fn);
    },

    // --- 選項 ---
    setOptions,
    getOptions,
    setBattleLang,
    getBattleLang,
    followLocaleBattleLang,
    isBattleLangManual: () => manualBattleLang !== null,
    setDebugVisible,
    isDebugVisible,
    refreshDebug,
    phaseLabel,

    // --- 版面 ---
    resize,
    refresh,
    getScale: () => scale,
    /** §4-10：預覽 CSS 像素 → 遊戲座標（面板／覆蓋層點擊換算共用） */
    clientToGame(client) {
      const rect = viewport && viewport.getBoundingClientRect ? viewport.getBoundingClientRect() : null;
      return previewToGame(client, rect || { width: VIEW_W * scale, height: VIEW_H * scale });
    },
    /** §4-10：遊戲座標 → 預覽 CSS 像素（覆蓋層定位用） */
    gameToClient(point) {
      const rect = viewport && viewport.getBoundingClientRect ? viewport.getBoundingClientRect() : null;
      return gameToPreview(point, rect || { width: VIEW_W * scale, height: VIEW_H * scale });
    },

    // --- 給面板的查詢 / 拖曳 API ---
    getActors: () => listActors(),
    getAttacks: () => listAttacks(),
    refreshAttacks: () => refreshAttackNames(),
    invalidateAttack,
    onAttackChange(listener) {
      attackListeners.add(listener);
      return () => attackListeners.delete(listener);
    },
    startActorDrag: (actorId) => armActorDrag(actorId),
    beginActorDrag: (ev, actorId) => {
      if (ev && typeof ev === 'object') beginActorDrag(ev, actorId);
      else armActorDrag(ev);
    },
    endActorDrag: () => onActorDragEnd(),
    isActorDragArmed: () => armedActorId !== null,

    // --- 錯誤 ---
    getErrors() {
      const merged = new Map(validationErrors);
      for (const [k, v] of engineErrors) merged.set(k, merged.has(k) ? `${merged.get(k)}；${v}` : v);
      return merged;
    },
    getValidationErrors: () => new Map(validationErrors),
    getEngineErrors: () => new Map(engineErrors),
    hasEngineError: () => engineErrors.size > 0,

    // --- 訂閱 ---
    onFrame(fn) {
      if (typeof fn !== 'function') return () => {};
      frameSubs.add(fn);
      return () => frameSubs.delete(fn);
    },
    onStatus(fn) {
      if (typeof fn !== 'function') return () => {};
      statusSubs.add(fn);
      return () => statusSubs.delete(fn);
    },
    onPhase(fn) {
      if (typeof fn !== 'function') return () => {};
      phaseSubs.add(fn);
      return () => phaseSubs.delete(fn);
    },
    onError(fn) {
      if (typeof fn !== 'function') return () => {};
      errorSubs.add(fn);
      return () => errorSubs.delete(fn);
    },
    getStatus: statusPayload,

    // --- 生命週期 ---
    init,
    destroy,
  };

  return api;
}

export default createEncounterPreview;
