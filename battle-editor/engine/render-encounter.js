/**
 * engine/render-encounter.js — 遭遇戰渲染（SPEC-P2 §5 / §8、SPEC-LAYOUT 全篇）
 *
 * export function createEncounterRenderer(canvas, assets)
 *   → { draw(state, options), resize(scale), getScale(), getLang(), destroy() }
 *
 * 資料來源只有 encounter.getState()（= world.snapshot() + flow.snapshot() + §5 欄位）：
 *   frame / lang / phase / turn / actors / party / enemies / tp / textbox / bubbles /
 *   menu / fight / numbers / battle / boxAnim / boxAnimRotation / layout / fade / flash /
 *   shake / result。
 * 本模組只用版面與攻擊條的常數，不執行遭遇流程或模擬。
 *
 * 版面（SPEC-LAYOUT，640×480 邏輯像素）：
 *   y   0..362  戰場：背景（只鋪到 362）→ 演員 → 戰鬥框／子彈／靈魂 → 泡泡 → 傷害數字
 *   y 362..364  分隔線（灰）
 *   y 365..400  隊伍面板列（每人一格；選單中的隊員整格上移 35px 並顯示按鈕列）
 *   y 402..404  分隔線（灰）
 *   y 405..480  底部文字區：旁白 flavor / 帶頭像的對話 / 選單清單 / FIGHT 攻擊條 / 結算
 *   x  40..60   TP 條（y 50..258，左側直排 T P + 數字 + %，MAX 時黃色直排）
 */

import { LAYOUT } from './encounter/layout.js';
import { TRACK_W } from './encounter/fight.js';
import * as HUD from './render-hud.js';
import {
  LOGICAL_WIDTH,
  LOGICAL_HEIGHT,
  PANEL_Y,
  SIM_FPS,
  LANG_STRINGS,
  normalizeLang,
  measureText,
  drawText,
  registerFontProvider,
  createSpritePainter,
} from './render.js';

const DEG = Math.PI / 180;

/* 方便呼叫端（encounter-play.html / 編輯器預覽）直接從這一支拿 */
export { LOGICAL_WIDTH, LOGICAL_HEIGHT, PANEL_Y, SIM_FPS };
export { LANG_STRINGS, normalizeLang, drawText, measureText, computeFitScale } from './render.js';

/* ------------------------------------------------------------- 版面常數 */
/* 全部由 engine/encounter/layout.js 的 LAYOUT 衍生（唯一數字來源，不再抄一份）。 */

const W = LOGICAL_WIDTH; // 640
const H = LOGICAL_HEIGHT; // 480

const BATTLE_BOTTOM = LAYOUT.BATTLE_AREA_BOTTOM; // 362
const PANEL_TOP = LAYOUT.PANEL_TOP; // 365
const PANEL_BOTTOM = LAYOUT.PANEL_BOTTOM; // 400
const PANEL_HEIGHT = LAYOUT.PANEL_HEIGHT; // 35
const PANEL_RAISE = LAYOUT.PANEL_RAISE; // 35
const PANEL_MARGIN = LAYOUT.PANEL_MARGIN; // 107
const PANEL_GAP = LAYOUT.PANEL_GAP; // 22
const AVATAR_SIZE = LAYOUT.PANEL_AVATAR_SIZE; // 16
const AVATAR_SCALE = LAYOUT.PANEL_AVATAR_SCALE; // 2 → 32×32
const AVATAR_PX = AVATAR_SIZE * AVATAR_SCALE; // 32
const HP_BAR = LAYOUT.PANEL_HP_BAR; // {dx:128,w:77,h:8}

const TEXT_TOP = LAYOUT.TEXT_TOP; // 405
const TEXT_BOTTOM = LAYOUT.TEXT_BOTTOM; // 480
const TEXT_LEFT = LAYOUT.TEXT_LEFT; // 30
const TEXT_INDENT = LAYOUT.TEXT_INDENT; // 58
const TEXT_LINE = LAYOUT.TEXT_LINE_HEIGHT; // 32
const TEXT_AREA_H = TEXT_BOTTOM - TEXT_TOP; // 75

const BUBBLE = LAYOUT.BUBBLE; // {width:168,lineHeight:14,gap:46,headOffset:0,defaultSpriteHeight:32}
const NUMBER = LAYOUT.NUMBER; // {lineHeight:20,offsetX:24,offsetY:10,life:40,fadeStart:0.75,...}

const PARTY_CENTER_X = LAYOUT.PARTY_CENTER_X; // 128
const PARTY_STAGGER_X = LAYOUT.PARTY_STAGGER_X; // 8
const ENEMY_CENTER_X = LAYOUT.ENEMY_CENTER_X; // 505
const ENEMY_FEET_Y = LAYOUT.ENEMY_FEET_Y; // 270
const ENEMY_STAGGER = LAYOUT.ENEMY_STAGGER; // {x:25,y:45}

/** 演員一律放大 2 倍（SPEC-LAYOUT §3：隊員精靈放大 2 倍） */
const ACTOR_BASE_SCALE = 2;

/**
 * 面板內各元素的位置。數值由 docs/reference-frames 逐像素量測（640×480 空間）：
 *   一般列（01/05 幀，Kris 格）：頭像 ink x+5…+44、y373…（40×32）；
 *   名字 ink x+51…+93 y377–392（字高 16 = fnt_main_wide、字距 5 → 每字前進 12）；
 *   數字 ink 右緣 x+202、y371–381（fnt_main、字距 3）；
 *   「HP」小字 ink x+110 y386–393（fnt_tinynoelle）；
 *   HP 條 x+128…+203 y386–395（76×10）。
 *   升起（02 幀）：面板 x−14 / y327 / 寬 = 一個格子寬 / 高 74；頭像 x+4 y+10（47×30）；
 *   名字 x+51 y+14；數字右緣 x+208 y+9；條 x+134 y+23（74×10）；
 *   按鈕 30×31、間距 5、從面板左 +16 起、y 368。
 */
/** 選單按鈕列（參考幀 02：5 顆 30×31、間距 5、從面板左 +16、y 368–398） */
const BUTTON_ROW = {
  y: 368,
  w: 30,
  h: 31,
  gap: 5,
  dx: 16,
};

/** 底部文字區的排版常數 */
const BOTTOM = {
  rowH2: 34, // 敵人清單（每頁 2 行）
  rowH3: 24, // 兩欄清單（每頁 3 行）
  colX: [TEXT_LEFT + 25, 330], // 兩欄的項目起點（55 / 330）
  cursorX: TEXT_LEFT, // 紅心游標
  fightRowH: 42,
  fightAvatarX: 10,
  fightAvatarSize: 30,
  fightPressX: 51,
  fightBoxX: 80,
  fightBoxRight: 203,
  fightTrackRight: 380, // bar.x = TRACK_W → 起點
};

/** 按鈕 id → 官方 sprite 名（A3 已補全幀；0=未選 1=選中黃框 2=禁用灰） */
const BUTTON_SPRITES = Object.freeze({
  fight: 'spr_btfight',
  act: 'spr_btact',
  magic: 'spr_bttech',
  item: 'spr_btitem',
  spare: 'spr_btspare',
  defend: 'spr_btdefend',
});
const BUTTON_GREY_SPRITES = Object.freeze({ item: 'spr_btitem_grey' });
export const ENCOUNTER_BUTTON_SPRITES = Object.freeze([
  ...Object.values(BUTTON_SPRITES), ...Object.values(BUTTON_GREY_SPRITES),
]);

/** 行動 → 面板頭像要換成的小圖示（SPEC-LAYOUT §6「已選行動後頭像換成行動圖示」） */
/** 顏色 */
const UI = Object.freeze({
  separator: '#2b2533',
  separator2: '#1a1620',
  panelBlack: '#000000',
  cellLine: 'rgba(58, 34, 92, 0.9)',
  name: '#ffffff',
  dim: '#8f88b0',
  faint: 'rgba(143,136,176,0.55)',
  gold: '#ffff00',
  cyan: '#00d8ff',
  red: '#ff5a6a',
  green: '#00e060',
  white: '#ffffff',
  bubble: '#ffffff',
  bubbleInk: '#12101c',
  tpTrack: '#3a0006',
  tpEdge: '#7a4a12',
  boxBlack: '#000000',
});

/** 遭遇戰專用小字串（其餘走 LANG_STRINGS） */
const ENC_STRINGS = Object.freeze({
  zh: Object.freeze({
    press: '按下',
    miss: '未命中',
    perfect: '完美',
    good: '不错',
    ok: '还行',
    page: '页',
  }),
  en: Object.freeze({
    press: 'PRESS',
    miss: 'MISS',
    perfect: 'PERFECT',
    good: 'GOOD',
    ok: 'OK',
    page: 'PAGE',
  }),
});

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return value < min ? min : value > max ? max : value;
}

function colorString(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s)) return s;
  if (/^(?:rgb|hsl)a?\(/i.test(s)) return s;
  if (/^[a-z]{3,20}$/i.test(s)) return s;
  return null;
}

function setupCanvas(canvas, scale) {
  const s = clamp(Math.floor(num(scale, 1)), 1, 16);
  const w = W * s;
  const h = H * s;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return s;
}

/**
 * 演員選幀（SPEC-P2 §3）：非循環動畫永遠夾在最後一幀（絕不取模；
 * 幀數未知時用素材實際幀數夾住）；循環動畫原樣交給 drawSprite 取模。
 *
 * @param {{frame?:number, animLoop?:boolean}} actor state.actors 的一項
 * @param {number} frameCount 素材實際幀數（0 = 未知）
 * @returns {number}
 */
export function resolveActorFrame(actor, frameCount) {
  const frame = Math.max(0, Math.floor(num(actor && actor.frame, 0)));
  const count = Math.round(num(frameCount, 0));
  if (actor && actor.animLoop === false && count > 0) return Math.min(frame, count - 1);
  return frame;
}

/* ============================================================ 渲染器 */

export function createEncounterRenderer(canvas, assets) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('createEncounterRenderer 需要一個 canvas 元素');
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('無法取得 canvas 2D context');

  const assetStore = assets && typeof assets === 'object' ? assets : null;
  const painter = createSpritePainter(ctx, assetStore);

  // 點陣字（SPEC §7）：接上 assets.getFont 並預熱常用字體（含 @zh 與 DTM.otf）
  let unregisterFontProvider = null;
  if (assetStore && typeof assetStore.getFont === 'function') {
    unregisterFontProvider = registerFontProvider((name) => assetStore.getFont(name));
  }
  if (assetStore && typeof assetStore.preloadFonts === 'function') {
    try {
      const warm = assetStore.preloadFonts([
        'fnt_main',
        'fnt_main_wide',
        'fnt_mainbig',
        'fnt_small',
        'fnt_dotumche',
        'fnt_tinynoelle',
        'fnt_main@zh',
        'fnt_mainbig@zh',
        'fnt_dotumche@zh',
        'fnt_tinynoelle@zh',
        'DTM',
      ]);
      if (warm && typeof warm.catch === 'function') warm.catch(() => {});
    } catch (_err) {
      /* 預熱失敗不影響繪製 */
    }
  }

  let destroyed = false;
  let currentScale = 0;
  let currentLang = 'zh';
  let currentStrings = LANG_STRINGS.zh;
  let currentEncStrings = ENC_STRINGS.zh;

  /* -------------------------------------------------------- 基礎繪圖 */

  function applyTransform(shakeX, shakeY) {
    const sx = canvas.width > 0 ? canvas.width / W : 1;
    const sy = canvas.height > 0 ? canvas.height / H : 1;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.imageSmoothingEnabled = false;
    if (shakeX || shakeY) ctx.translate(num(shakeX, 0), num(shakeY, 0));
  }

  /** 點陣字（自動帶入目前語言） */
  function text(str, x, y, opts) {
    const base = opts && typeof opts === 'object' ? opts : {};
    const merged = base.lang === undefined ? { ...base, lang: currentLang } : base;
    return drawText(ctx, str, x, y, merged);
  }

  function textWidth(str, opts) {
    try {
      return measureText(str, {
        font: (opts && opts.font) || 'fnt_main',
        lang: currentLang,
        scale: (opts && opts.scale) || 1,
        size: opts && opts.size,
      }).width;
    } catch (_err) {
      return String(str == null ? '' : str).length * 7;
    }
  }

  /** 帶字距的點陣字（共用實作見 engine/render-hud.js） */
  function textSpaced(str, x, y, opts, spacing) {
    return HUD.textSpaced(ctx, str, x, y, opts, spacing, currentLang);
  }

  function drawSprite(name, frame, x, y, opts) {
    return painter.drawSprite(name, frame, x, y, opts);
  }

  function fillRect(x, y, w, h, color, alpha) {
    if (!(w > 0) || !(h > 0)) return;
    ctx.save();
    if (alpha !== undefined) ctx.globalAlpha *= clamp(num(alpha, 1), 0, 1);
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.restore();
  }

  function strokeRect(x, y, w, h, color, lineWidth) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(0.5, num(lineWidth, 1));
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
    ctx.restore();
  }

  function roundRect(x, y, w, h, r, fill, stroke, lineWidth) {
    const radius = clamp(num(r, 4), 0, Math.min(w, h) / 2);
    ctx.save();
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, h, radius);
    } else {
      ctx.moveTo(x + radius, y);
      ctx.lineTo(x + w - radius, y);
      ctx.quadraticCurveTo(x + w, y, x + w, y + radius);
      ctx.lineTo(x + w, y + h - radius);
      ctx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
      ctx.lineTo(x + radius, y + h);
      ctx.quadraticCurveTo(x, y + h, x, y + h - radius);
      ctx.lineTo(x, y + radius);
      ctx.quadraticCurveTo(x, y, x + radius, y);
      ctx.closePath();
    }
    if (fill) {
      ctx.fillStyle = fill;
      ctx.fill();
    }
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = Math.max(1, num(lineWidth, 2));
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 細長條（HP / MERCY 小條；共用實作見 engine/render-hud.js） */
  function drawBar(x, y, w, h, pct, color, opts) {
    HUD.drawBar(ctx, x, y, w, h, pct, color, opts);
  }

  /* ------------------------------------------------------------ 背景 */

  function drawBackground(state, view) {
    const bgName =
      (typeof view.background === 'string' && view.background) ||
      (typeof state.background === 'string' && state.background) ||
      (state.attack && state.attack.settings && typeof state.attack.settings.background === 'string'
        ? state.attack.settings.background
        : null);
    const time = num(state.frame, 0) / SIM_FPS;
    painter.drawBackground({ time, attack: { settings: { background: bgName } } }, { showGrid: view.showGrid !== false });
    // SPEC-LAYOUT §1：背景只鋪 y 0..362，以下純黑
    fillRect(0, BATTLE_BOTTOM, W, H - BATTLE_BOTTOM, '#000000');
  }

  /* ------------------------------------------------------------ 演員 */

  function actorMap(state) {
    const map = new Map();
    const list = Array.isArray(state.actors) ? state.actors : [];
    for (const actor of list) {
      if (actor && typeof actor === 'object' && typeof actor.id === 'string') map.set(actor.id, actor);
    }
    return map;
  }

  /** state.layout 或 LAYOUT 的腳底表（SPEC-LAYOUT §3） */
  function partyFeetArray(state, count) {
    const fromState = state.layout && Array.isArray(state.layout.partyFeet) ? state.layout.partyFeet : null;
    if (fromState && fromState.length) return fromState;
    const table = LAYOUT.PARTY_FEET || {};
    const n = clamp(Math.round(num(count, 1)), 1, 4);
    const feet = table[n] || table[3] || [240];
    return feet;
  }

  function spriteSizeOf(name) {
    const entry = painter.spriteEntry(name);
    const metrics = entry ? painter.spriteMetrics(name, null) : { w: 16, h: 16 };
    return metrics;
  }

  /** 反轉繪製（painter.drawSprite 沒有 flip） */
  function drawSpriteFlipped(name, frame, x, y, aopts) {
    const o = aopts && typeof aopts === 'object' ? aopts : {};
    ctx.save();
    ctx.translate(num(x, 0), 0);
    ctx.scale(-1, 1);
    ctx.translate(-num(x, 0), 0);
    const real = drawSprite(name, frame, x, y, o);
    ctx.restore();
    return real;
  }

  /**
   * 演員繪製（SPEC-LAYOUT §3 隊員縱列 / §4 敵人）。
   * 隊員忽略 encounter 檔的 x/y，一律套 §3 的縱列表（x≈100、腳底 140/230/322）；
   * 敵人用 §4 的錨點（x 470–540、腳底 240–300）。
   */
  /** 演員繪製順序（隊員縱列 + 敵人錨點，依 layer 排序）。drawActors 與入戰轉場共用。 */
  function actorOrder(state) {
    const actors = Array.isArray(state.actors) ? state.actors : [];
    if (!actors.length) return [];
    const party = Array.isArray(state.party) ? state.party : [];

    // 隊員索引：party[i].id → actor.id（找不到就用第 i 個 kind==='party' 的演員）
    const byId = actorMap(state);
    const partyActors = actors.filter((a) => a && a.kind === 'party');
    const enemyActors = actors.filter((a) => a && a.kind !== 'party');
    const feetTable = partyFeetArray(state, party.length || partyActors.length);

    const order = [];
    for (let i = 0; i < Math.max(party.length, partyActors.length); i += 1) {
      const memberId = party[i] && party[i].id;
      const actor = (memberId && byId.get(memberId)) || partyActors[i] || null;
      if (!actor) continue;
      order.push({ actor, kind: 'party', index: i, feet: num(feetTable[i], 240) });
    }
    for (let i = 0; i < enemyActors.length; i += 1) {
      const actor = enemyActors[i];
      const fallbackFeet = ENEMY_FEET_Y + (i - (enemyActors.length - 1) / 2) * ENEMY_STAGGER.y * 0.5;
      order.push({
        actor,
        kind: 'enemy',
        index: i,
        feet: num(actor.y, fallbackFeet),
        x: num(actor.x, ENEMY_CENTER_X + (i - (enemyActors.length - 1) / 2) * ENEMY_STAGGER.x),
      });
    }

    // 依 layer 排序（同 layer 時隊員在後、敵人在前）
    order.sort((a, b) => {
      const la = num(a.actor.layer, 0);
      const lb = num(b.actor.layer, 0);
      if (la !== lb) return la - lb;
      return a.kind === 'party' ? -1 : 1;
    });
    return order;
  }

  /** 演員在畫面上的位置與大小（含受擊抖動）。 */
  function actorPose(state, item, frame, { shake = true } = {}) {
    const actor = item.actor;
    const scale = (num(actor.scale, 1) || 1) * ACTOR_BASE_SCALE;
    const metrics = spriteSizeOf(actor.sprite);
    const drawH = Math.max(1, metrics.h * scale);
    const drawW = Math.max(1, metrics.w * scale);

    // 水平位置：隊員固定縱列（±8 交錯），敵人用 §4 的 x
    const lay = state.layout || {};
    const sx = num(lay.partyStagger, PARTY_STAGGER_X);
    const stagger = item.kind === 'party' ? (item.index % 2 === 0 ? -sx / 2 : sx / 2) : 0;
    let x = item.kind === 'party' ? num(lay.partyX, PARTY_CENTER_X) + stagger : num(item.x, ENEMY_CENTER_X);

    // 受擊橫向抖動（§4）
    const hurt = clamp(num(actor.hurtShake, 0), 0, 1);
    if (shake && hurt > 0.001) x += Math.sin(frame * 2.4) * 3.5 * hurt;

    const feetY = clamp(num(item.feet, 240), 0, BATTLE_BOTTOM - 2);
    const y = actor.spriteOrigin ? feetY : feetY - drawH / 2;
    return { x, y, feetY, drawW, drawH, scale, metrics };
  }

  /**
   * 演員繪製（SPEC-LAYOUT §3 隊員縱列 / §4 敵人）。
   * 隊員忽略 encounter 檔的 x/y，一律套 §3 的縱列表（x≈100、腳底 140/230/322）；
   * 敵人用 §4 的錨點（x 470–540、腳底 240–300）。
   * placement：Map(id → {x, y, opacity?, hidden?})，入戰轉場用來把演員畫在指定的腳底位置。
   */
  function drawActors(state, pass = 'all', placement = null) {
    const order = actorOrder(state);
    if (!order.length) return;
    const frame = num(state.frame, 0);
    for (const item of order) {
      const actor = item.actor;
      if (!actor || actor.visible === false) continue;
      const backgroundActor = num(actor.layer, 0) < 0;
      if (pass === 'background' && !backgroundActor || pass === 'foreground' && backgroundActor) continue;
      const place = placement ? placement.get(actor.id) : null;
      if (place && place.hidden) continue;
      const opacity = place && place.opacity !== undefined ? num(place.opacity, 1) : 1;
      const alpha = clamp(num(actor.alpha, 1) * opacity, 0, 1);
      if (alpha <= 0.003) continue;

      const pose = actorPose(state, item, frame);
      if (place) {
        const dy = num(place.y, pose.feetY) - pose.feetY;
        pose.x = num(place.x, pose.x);
        pose.feetY += dy;
        pose.y += dy;
      }
      const { x, y, feetY, drawW, drawH, scale, metrics } = pose;

      // 腳下陰影：大小跟著演員的 idle（攻擊、揮手等動作圖畫布比較寬，陰影不該跟著變大）
      let shW = drawW;
      let shH = drawH;
      let shOrigin = actor.spriteOrigin === true;
      if (actor.idleSprite && actor.idleSprite !== actor.sprite) {
        const im = spriteSizeOf(actor.idleSprite);
        const idleScale = (num(actor.idleScale, 1) || 1) * ACTOR_BASE_SCALE;
        shW = Math.max(1, im.w * idleScale);
        shH = Math.max(1, im.h * idleScale);
        shOrigin = actor.idleOrigin === true;
      }
      ctx.save();
      ctx.globalAlpha = 0.3 * alpha;
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.ellipse(x, feetY - 1, shOrigin ? Math.min(24, Math.max(8, shW / 3)) : Math.max(8, shW / 3),
        shOrigin ? 4 : Math.max(2, shH / 12), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      const popts = {
        scale,
        alpha,
        originMode: actor.spriteOrigin ? 'auto' : 'center',
        fallbackW: metrics.w,
        fallbackH: metrics.h,
      };
      // 選幀：非循環動畫夾在最後一幀（不取模；幀數未知時用素材實際幀數）
      const frameCount =
        num(actor.animFrames, 0) > 0 ? num(actor.animFrames, 0) : painter.spriteFrameCount(actor.sprite);
      const frameNo = resolveActorFrame(actor, frameCount);
      if (actor.flip === true) drawSpriteFlipped(actor.sprite, frameNo, x, y, popts);
      else drawSprite(actor.sprite, frameNo, x, y, popts);
    }
  }

  /* -------------------------------------------------------- 彈幕回合 */

  function drawBattle(state, view, parts) {
    const battle = state.battle && typeof state.battle === 'object' ? state.battle : null;
    if (!battle) return null;
    return painter.drawBattleLayer(battle, {
      boxAnim: num(state.boxAnim, 1),
      // SPEC-LAYOUT §5：從中心旋轉 + 縮放展開（E1 的 world.boxAnimRotation，度）
      boxRotation: num(state.boxAnimRotation, 0),
      showHitboxes: view.showHitboxes === true,
      applyShake: true,
      parts,
    });
  }

  /* ------------------------------------------------------------ TP 條 */

  /** TP 條（共用實作見 engine/render-hud.js，與攻擊編輯器預覽同一份程式碼） */
  function drawTpBar(state) {
    HUD.drawTpBar(ctx, painter, state.tp, { lang: currentLang });
  }

  /* -------------------------------------------------------- 隊伍面板 */

  /** 選單按鈕列（SPEC-LAYOUT §6 / 參考幀 02：5 顆 30×30、間距 5、從面板左緣 +14 起、y 368–398） */
  function drawButtons(state, menu, panel) {
    const buttons = menu && Array.isArray(menu.buttons) ? menu.buttons : [];
    if (!buttons.length) return;
    const cursor = clamp(Math.round(num(menu.cursor, 0)), 0, buttons.length - 1);
    const gap = BUTTON_ROW.gap;
    const bw = BUTTON_ROW.w;
    const rowW = bw * buttons.length + gap * (buttons.length - 1);
    // 置中於面板；面板太窄時才縮
    const shrink = rowW > panel.width - BUTTON_ROW.dx * 2 ? (panel.width - BUTTON_ROW.dx * 2) / rowW : 1;
    const bwc = Math.max(16, Math.floor(bw * shrink));
    const row = bwc * buttons.length + gap * (buttons.length - 1);
    const startX = Math.round(
      row <= panel.width - BUTTON_ROW.dx * 2
        ? panel.left + BUTTON_ROW.dx
        : panel.left + (panel.width - row) / 2,
    );
    const y = BUTTON_ROW.y;
    let label = null;

    for (let i = 0; i < buttons.length; i += 1) {
      const button = buttons[i] && typeof buttons[i] === 'object' ? buttons[i] : { id: 'fight', enabled: true };
      const id = String(button.id || 'fight');
      const enabled = button.enabled !== false;
      const selected = i === cursor && enabled;
      const bx = startX + i * (bwc + gap);

      let sprite = BUTTON_SPRITES[id] || 'spr_btfight';
      let frame = selected ? 1 : 0;
      if (!enabled) {
        if (BUTTON_GREY_SPRITES[id]) {
          sprite = BUTTON_GREY_SPRITES[id];
          frame = 0;
        } else {
          frame = 2;
        }
      }
      // 選中框（frame 1）的 sprite 底下烤了英文標籤（FIGHT/ACT…），
      // 語言可切換 → 只取按鈕方框部分，標籤由我們自己畫（見下方 raisedLabel）
      ctx.save();
      if (selected) {
        ctx.beginPath();
        ctx.rect(bx - 2, y - 2, bwc + 4, 28);
        ctx.clip();
      }
      const ok = drawSprite(sprite, frame, bx + bwc / 2, y + BUTTON_ROW.h / 2, {
        scale: Math.min(1, bwc / 30),
        originMode: 'center',
        fallbackW: 16,
        fallbackH: 16,
      });
      ctx.restore();
      if (!ok) drawProceduralButton(id, bx, y, bwc, enabled, selected);

      // 選中：按鈕正下方小字標籤（SPEC-LAYOUT §6 / 參考幀 02 的黃字「魔法」）
      // 標籤會壓到 400–406 的邊界帶，因此只回報位置，由 drawPartyPanel 最後畫（避免被分隔線蓋掉）
      if (selected) {
        label = { text: currentStrings[id] || id.toUpperCase(), x: bx + bwc / 2 };
      }
    }
    return label;
  }

  /** 官方按鈕 sprite 缺失時的程序化備援 */
  function drawProceduralButton(id, x, y, w, enabled, selected) {
    const h = BUTTON_ROW.h;
    const border = selected ? UI.gold : enabled ? '#ff9a3c' : '#5a5468';
    fillRect(x, y, w, h, '#0b0714');
    strokeRect(x, y, w, h, border, 2);
    const key = String(id || '');
    const label = currentStrings[key] || key.toUpperCase();
    text(label, x + w / 2, y + h - 6, {
      font: 'fnt_small',
      color: selected ? UI.gold : enabled ? '#ffb15a' : UI.dim,
      align: 'center',
      baseline: 'bottom',
    });
  }

  function drawPartyPanel(state) {
    const menu = state.menu;
    const party = Array.isArray(state.party) ? state.party : [];
    const cells = HUD.panelCells(party.length);
    const memberIndex = menu ? Math.round(num(menu.member, -1)) : -1;
    const actors = actorMap(state);
    const hudOpts = { lang: currentLang, strings: currentStrings };

    // 普通格與舞台分隔線在下層，升起的格子連同其橫線在最上層。
    for (let i = 0; i < party.length; i += 1) {
      if (i === memberIndex) continue;
      const member = party[i];
      const actor = actors.get(member.actor || member.id);
      HUD.drawPartyCell(ctx, painter, cells[i], member, { ...hudOpts, actor, last: i === party.length - 1 });
    }
    HUD.drawLayoutFrame(ctx, { clearBottom: false, lines: true });

    const cell = cells[memberIndex];
    if (!cell) return;
    const member = party[memberIndex];
    const actor = actors.get(member.actor || member.id);
    const color = colorString(member.color) || UI.white;
    const down = member.down === true || num(member.hp, 0) <= 0;
    const panel = {
      left: clamp(cell.left + HUD.RAISED.dx, 2, W - cell.width - 2),
      top: HUD.RAISED.top,
      width: cell.width,
      height: HUD.RAISED.height,
    };
    fillRect(panel.left, panel.top, panel.width, panel.height, UI.panelBlack);
    strokeRect(panel.left + 1, panel.top + 1, panel.width - 2, panel.height - 2, color, 2);
    fillRect(panel.left + 1, BUTTON_ROW.y - 1, panel.width - 2, 1, color);

    HUD.drawAvatar(ctx, painter, member, actor,
      panel.left + HUD.RAISED.avatarDx, panel.top + HUD.RAISED.avatarY,
      HUD.RAISED.avatarW, HUD.RAISED.avatarH, currentLang);
    HUD.drawCellText(ctx, painter, member, panel, color, down, true, hudOpts);
    const label = drawButtons(state, menu, panel);
    if (label) {
      text(label.text, label.x, PANEL_BOTTOM - 1, {
        font: 'fnt_tinynoelle',
        color: UI.gold,
        align: 'center',
        baseline: 'top',
        scale: 0.75,
      });
    }
  }

  /* ------------------------------------------------- 底部文字區（405–480） */

  /** 旁白 / 對話：fnt_mainbig，一行高 32，最多 2 行（SPEC-LAYOUT §7） */
  function drawTextbox(state) {
    const box = state.textbox && typeof state.textbox === 'object' ? state.textbox : null;
    if (!box) return;
    const lines = Array.isArray(box.lines) ? box.lines : [];

    // 完整頭像要同時放得進寬、高；優先用整數倍保留像素輪廓。
    let firstX = TEXT_LEFT;
    let contX = TEXT_INDENT;
    const portrait = typeof box.portrait === 'string' && box.portrait ? box.portrait : null;
    if (portrait) {
      firstX = 146;
      contX = 182;
      const px = 20;
      const pw = 92;
      const size = spriteSizeOf(portrait);
      const fit = Math.min(pw / size.w, (TEXT_AREA_H - 6) / size.h);
      const scale = fit < 1 ? fit : Math.min(4, Math.floor(fit));
      drawSprite(portrait, 0, px + pw / 2, TEXT_TOP + TEXT_AREA_H / 2, {
        scale,
        originMode: 'center',
        fallbackW: 45,
        fallbackH: 51,
      });
    }

    // 打字機：visibleChars 是已顯示字元總數，跨行累計裁切
    let remain =
      typeof box.visibleChars === 'number' && Number.isFinite(box.visibleChars)
        ? Math.max(0, Math.floor(box.visibleChars))
        : Infinity;

    const maxLines = Math.max(1, Math.min(2, lines.length || 1));
    for (let i = 0; i < maxLines; i += 1) {
      const line = lines[i] && typeof lines[i] === 'object' ? lines[i] : { text: '' };
      const raw = typeof line.text === 'string' ? line.text : '';
      let str = raw;
      if (remain !== Infinity) {
        if (remain <= 0) str = '';
        else if (raw.length > remain) str = raw.slice(0, remain);
        remain -= raw.length;
      }
      if (!str && raw) continue;
      const color = colorString(line.color) || UI.white;
      text(str, i === 0 ? firstX : contX, TEXT_TOP + 12 + i * TEXT_LINE, {
        font: 'fnt_mainbig',
        color,
        baseline: 'top',
      });
    }

    // 打完字提示（右下角閃爍三角）
    if (!state.result && box.done === true && num(state.frame, 0) % 24 < 15) {
      const ax = W - 16;
      const ay = TEXT_BOTTOM - 10;
      ctx.save();
      ctx.fillStyle = UI.white;
      ctx.beginPath();
      ctx.moveTo(ax - 5, ay - 4);
      ctx.lineTo(ax + 5, ay - 4);
      ctx.lineTo(ax, ay + 4);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  /** 清單項目名稱（flow 的敵人 label 可能是空字串 → 用 state.enemies 回填） */
  function listLabelOf(state, list, item, index) {
    const own = typeof item.label === 'string' ? item.label : '';
    if (own) return own;
    if (!list || list.kind !== 'enemy') return own;
    const enemies = Array.isArray(state.enemies) ? state.enemies : [];
    const living = enemies.filter((e) => e && !e.removed && num(e.hp, 0) > 0);
    const enemy = living[index];
    if (!enemy) return own;
    return typeof enemy.name === 'string' ? enemy.name : '';
  }

  /** 選單清單（SPEC-LAYOUT §7：紅心游標 x30、項目 x55；敵人清單 2 行 / 兩欄清單 3 行） */
  function drawMenuList(state) {
    const menu = state.menu && typeof state.menu === 'object' ? state.menu : null;
    if (!menu || !menu.list || typeof menu.list !== 'object') return;
    const list = menu.list;
    const items = Array.isArray(list.items) ? list.items : [];
    if (!items.length) return;
    const kind = String(list.kind || 'enemy');
    const cursor = Math.round(num(list.cursor, 0));
    const page = Math.max(0, Math.round(num(list.page, 0)));
    const twoCol = kind === 'act' || kind === 'magic' || kind === 'item' || kind === 'party';
    const perPage = twoCol ? 6 : 2;
    const pageStart = Math.floor(cursor / perPage) * perPage;

    const drawCursor = (x, y) => {
      const ok = drawSprite('spr_heart', 0, x + 8, y + 8, {
        scale: 1,
        color: '#ff2020',
        originMode: 'center',
        fallbackW: 12,
        fallbackH: 12,
      });
      if (!ok) {
        ctx.save();
        ctx.fillStyle = '#ff2020';
        ctx.beginPath();
        ctx.arc(x + 8, y + 8, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
      }
    };

    if (!twoCol) {
      // 敵人清單：每行一隻，右側 HP / MERCY 兩條小條（x 510–590）
      const rowH = BOTTOM.rowH2;
      for (let i = 0; i < perPage; i += 1) {
        const index = pageStart + i;
        if (index >= items.length) break;
        const item = items[index] && typeof items[index] === 'object' ? items[index] : {};
        const rowY = TEXT_TOP + 6 + i * rowH;
        const selected = index === cursor;
        if (selected) drawCursor(BOTTOM.cursorX, rowY);
        const label = listLabelOf(state, list, item, index);
        const enabled = item.enabled !== false;
        text(label, TEXT_LEFT + 25, rowY + 2, {
          font: 'fnt_mainbig',
          color: enabled ? (selected ? UI.white : '#d8d2ea') : UI.dim,
          baseline: 'top',
        });
        const sub = typeof item.sub === 'string' ? item.sub : '';
        if (sub) {
          const labelW = textWidth(label, { font: 'fnt_mainbig' });
          text(sub, TEXT_LEFT + 25 + labelW + 14, rowY + 12, {
            font: 'fnt_main',
            color: UI.cyan,
            baseline: 'top',
          });
        }
        // 右側兩條小條
        const barX = 510;
        const barW = 80;
        const hpPctRaw = num(item.hpPct, NaN);
        if (!Number.isNaN(hpPctRaw)) {
          const pct = hpPctRaw > 1.001 ? hpPctRaw / 100 : hpPctRaw;
          drawBar(barX, rowY + 8, barW, 7, pct, pct > 0.3 ? UI.green : UI.red, { track: '#2a0f14' });
        }
        const mercyRaw = num(item.mercy, NaN);
        if (!Number.isNaN(mercyRaw)) {
          const pct = mercyRaw > 1.001 ? mercyRaw / 100 : mercyRaw;
          drawBar(barX, rowY + 20, barW, 7, pct, UI.gold, { track: '#2a2410' });
          if (pct >= 1) {
            text(currentStrings.allow, barX + barW + 6, rowY + 18, {
              font: 'fnt_tinynoelle',
              color: UI.gold,
              baseline: 'top',
            });
          }
        }
      }
      // 分頁
      if (items.length > perPage) {
        const pages = Math.max(1, Math.ceil(items.length / perPage));
        text(`${Math.min(pages, Math.floor(cursor / perPage) + 1)}/${pages}`, W - 12, TEXT_BOTTOM - 14, {
          font: 'fnt_tinynoelle',
          color: UI.dim,
          align: 'right',
          baseline: 'top',
        });
      }
      return;
    }

    // 兩欄清單（ACT / 魔法 / 道具 / 選隊員）：每欄 3 行
    const rowH = BOTTOM.rowH3;
    const colX = BOTTOM.colX; // [55, 330]
    const rows = 3;
    for (let i = 0; i < perPage; i += 1) {
      const index = pageStart + i;
      if (index >= items.length) break;
      const item = items[index] && typeof items[index] === 'object' ? items[index] : {};
      const col = Math.floor(i / rows);
      const row = i % rows;
      const x = colX[col] !== undefined ? colX[col] : colX[0];
      const rowY = TEXT_TOP + 2 + row * rowH;
      const selected = index === cursor;
      const enabled = item.enabled !== false;
      if (selected) drawCursor(x - 25, rowY - 1);

      // X-Action 項目前加隊員小頭像（SPEC-LAYOUT §7）
      let labelX = x;
      if (kind === 'act' && item.member !== undefined) {
        const party = Array.isArray(state.party) ? state.party : [];
        const pm = party[num(item.member, -1)];
        if (pm) HUD.drawAvatar(ctx, painter, pm, actorMap(state).get(pm.actor || pm.id), x - 2, rowY + 1, 18, 18, currentLang);
        labelX = x + 20;
      }

      const label = typeof item.label === 'string' && item.label ? item.label : '';
      text(label, labelX, rowY + 3, {
        font: 'fnt_main',
        color: enabled ? (selected ? UI.white : '#cfc7e2') : UI.dim,
        baseline: 'top',
      });
      const sub = typeof item.sub === 'string' ? item.sub : '';
      if (sub) {
        const labelW = textWidth(label, { font: 'fnt_main' });
        text(sub, labelX + labelW + 10, rowY + 3, {
          font: 'fnt_tinynoelle',
          color: UI.dim,
          baseline: 'top',
        });
      }
    }

    // 右側說明（灰）：目前項目的 sub
    const cur = items[cursor];
    if (cur && typeof cur.sub === 'string' && cur.sub) {
      text(cur.sub, W - 14, TEXT_TOP + 4, {
        font: 'fnt_tinynoelle',
        color: UI.dim,
        align: 'right',
        baseline: 'top',
      });
    }
    if (items.length > perPage) {
      const pages = Math.max(1, Math.ceil(items.length / perPage));
      text(`${Math.min(pages, Math.floor(cursor / perPage) + 1)}/${pages}`, W - 12, TEXT_BOTTOM - 14, {
        font: 'fnt_tinynoelle',
        color: UI.dim,
        align: 'right',
        baseline: 'top',
      });
    }
  }

  /* ------------------------------------------------------- FIGHT 攻擊條 */

  function fightResultLabel(result) {
    if (result === 'perfect') return currentEncStrings.perfect;
    if (result === 'good') return currentEncStrings.good;
    if (result === 'ok') return currentEncStrings.ok;
    if (result === 'miss') return currentEncStrings.miss;
    return '';
  }

  /**
   * FIGHT 攻擊條（SPEC-LAYOUT §7）：底部文字區每位出手隊員一列，
   * 左側頭像 + 小字「按下」、目標框 x80–203（左緣＝隊員色粗線＝判定點）、
   * 白色豎線標記從右側往左移動並拖出殘影。
   */
  function drawFightBars(state) {
    const fight = state.fight && typeof state.fight === 'object' ? state.fight : null;
    if (!fight) return;
    const bars = Array.isArray(fight.bars) ? fight.bars : [];
    if (!bars.length) return;
    const party = Array.isArray(state.party) ? state.party : [];
    const actors = actorMap(state);
    const n = Math.min(4, bars.length);
    // 參考幀 06：每列 38px 高，一次只看得到 ~2 列 → 讓「當前還沒判定」的那列留在畫面內
    const rowH = BOTTOM.fightRowH;
    const visible = Math.max(1, Math.min(n, Math.ceil(TEXT_AREA_H / rowH)));
    let active = bars.findIndex((b) => !b || b.result === null || b.result === undefined);
    if (active < 0) active = n - 1;
    const first = clamp(active - (visible - 1), 0, Math.max(0, n - visible));

    for (let k = 0; k < n; k += 1) {
      if (k < first || k >= first + visible) continue;
      const bar = bars[k] && typeof bars[k] === 'object' ? bars[k] : {};
      const rowY = TEXT_TOP + (k - first) * rowH;
      const color = colorString(bar.color) || UI.white;
      const memberIdx = num(bar.member, k);
      const pm = party[memberIdx] || { color };
      const actor = actors.get(pm.actor || pm.id);

      // 隊員頭像 + 「按下」
      HUD.drawAvatar(
        ctx,
        painter,
        pm,
        actor,
        BOTTOM.fightAvatarX,
        rowY + 4,
        BOTTOM.fightAvatarSize,
        Math.min(BOTTOM.fightAvatarSize, rowH - 8),
        currentLang,
      );
      text(currentEncStrings.press, BOTTOM.fightPressX, rowY + Math.round(rowH / 2) - 6, {
        font: 'fnt_main',
        color: UI.white,
        baseline: 'top',
      });

      // 目標框：外框 + 左緣粗線（判定點）
      const boxX = BOTTOM.fightBoxX;
      const boxR = BOTTOM.fightBoxRight;
      const boxY = rowY + 2;
      const boxH = rowH - 5;
      strokeRect(boxX, boxY, boxR - boxX, boxH, color, 1);
      fillRect(boxX, boxY, 3, boxH, color);
      fillRect(boxX, boxY + boxH - 2, 8, 2, color);

      // 左緣粗線同時是標記軌道的判定端。
      const toScreen = (v) => boxX + (clamp(num(v, 0), 0, TRACK_W) / TRACK_W) * (BOTTOM.fightTrackRight - boxX);

      // 移動標記 + 殘影（標記往左移動 → 殘影在右側）
      if (bar.result === null || bar.result === undefined) {
        const mx = Math.round(toScreen(bar.x));
        for (let k = 1; k <= 5; k += 1) {
          ctx.save();
          ctx.globalAlpha = 0.32 - k * 0.05;
          fillRect(mx + k * 7, boxY + 1, 2, boxH - 2, UI.white);
          ctx.restore();
        }
        fillRect(mx - 2, boxY + 1, 4, boxH - 2, UI.white);
      } else {
        // 判定結果字
        const label = fightResultLabel(bar.result);
        if (label) {
          text(label, (boxX + boxR) / 2, boxY + boxH / 2, {
            font: 'fnt_main',
            color: bar.result === 'miss' ? UI.dim : UI.gold,
            align: 'center',
            baseline: 'middle',
          });
        }
      }
    }
  }

  /* ------------------------------------------------------------ 泡泡 */

  /**
   * 敵人泡泡（SPEC-LAYOUT §8）：白色圓角矩形、位於說話者左側、尾巴指向說話者、
   * 黑色文字（fnt_dotumche）。text.js 給的 (x,y)：x 是靠演員那一側的邊、y 是頭部高度
   * （泡泡底邊對齊頭部，往上畫）。
   */
  function drawBubbles(state) {
    const bubbles = Array.isArray(state.bubbles) ? state.bubbles : [];
    if (!bubbles.length) return;
    const actors = actorMap(state);
    const frame = num(state.frame, 0);

    for (const bubble of bubbles) {
      if (!bubble || typeof bubble !== 'object') continue;
      const actor = actors.get(bubble.actor) || null;
      const actorX = actor ? num(actor.x, ENEMY_CENTER_X) : ENEMY_CENTER_X;
      const actorFeet = actor ? num(actor.y, ENEMY_FEET_Y) : ENEMY_FEET_Y;
      const spriteH = actor ? num(actor.spriteH, BUBBLE.defaultSpriteHeight) : BUBBLE.defaultSpriteHeight;
      const headY = actorFeet - spriteH * ACTOR_BASE_SCALE * 0.9;

      const hasPos = Number.isFinite(bubble.x) && Number.isFinite(bubble.y) && !(num(bubble.x, 0) === 0 && num(bubble.y, 0) === 0);
      const side = bubble.side === 'right' ? 'right' : 'left';
      const anchorX = hasPos ? num(bubble.x, actorX) : side === 'left' ? actorX - BUBBLE.gap : actorX + BUBBLE.gap;
      const anchorY = hasPos ? num(bubble.y, headY) : headY;

      const texts = (Array.isArray(bubble.lines) ? bubble.lines : []).map((l) =>
        l && typeof l.text === 'string' ? l.text : '',
      );
      const lineH = Math.round(BUBBLE.lineHeight);
      const padX = 10;
      const padY = 7;
      let maxTextW = 0;
      for (const t of texts) maxTextW = Math.max(maxTextW, textWidth(t, { font: 'fnt_dotumche' }));
      const bw = clamp(Math.round(num(bubble.w, BUBBLE.width)), 60, 240);
      const bh = Math.max(24, texts.length * lineH + padY * 2);

      // 泡泡底邊對齊頭部，往上畫；x 是靠演員那一側的邊
      const bx = side === 'left' ? clamp(anchorX - bw, 6, W - bw - 6) : clamp(anchorX, 6, W - bw - 6);
      const by = clamp(anchorY - bh, 8, BATTLE_BOTTOM - bh - 6);
      const bounce = Math.round(Math.sin((frame + num(anchorX, 0)) * 0.16) * 1);

      // 尾巴（指向演員）
      const tailY = clamp(anchorY - 10, by + 10, by + bh - 8);
      const tailX = side === 'left' ? bx + bw : bx;
      ctx.save();
      ctx.fillStyle = UI.bubble;
      ctx.beginPath();
      ctx.moveTo(tailX, tailY - 7);
      ctx.lineTo(clamp(actorX, 4, W - 4), clamp(anchorY, 4, BATTLE_BOTTOM - 4));
      ctx.lineTo(tailX, tailY + 7);
      ctx.closePath();
      ctx.fill();
      ctx.restore();

      roundRect(bx, by + bounce, bw, bh, 5, UI.bubble, null, 0);
      // 深色描邊（用細框畫在內側，避免蓋住尾巴根部）
      strokeRect(bx + 0.5, by + bounce + 0.5, bw - 1, bh - 1, '#1b1224', 2);

      // 文字（黑；visibleChars 打字機）
      let remain =
        typeof bubble.visibleChars === 'number' && Number.isFinite(bubble.visibleChars)
          ? Math.max(0, Math.floor(bubble.visibleChars))
          : Infinity;
      for (let i = 0; i < texts.length; i += 1) {
        const raw = texts[i];
        let t = raw;
        if (remain !== Infinity) {
          if (remain <= 0) t = '';
          else if (raw.length > remain) t = raw.slice(0, remain);
          remain -= raw.length;
        }
        if (t) {
          text(t, bx + padX, by + bounce + padY + i * lineH, {
            font: 'fnt_dotumche',
            color: UI.bubbleInk,
            baseline: 'top',
          });
        }
      }

      // 打完字提示
      if (bubble.done === true && frame % 24 < 15) {
        ctx.save();
        ctx.fillStyle = '#5a4a80';
        const dx = bx + bw - 8;
        const dy = by + bounce + bh - 7;
        ctx.beginPath();
        ctx.moveTo(dx - 4, dy - 3);
        ctx.lineTo(dx + 4, dy - 3);
        ctx.lineTo(dx, dy + 4);
        ctx.closePath();
        ctx.fill();
        ctx.restore();
      }
    }
  }

  /* -------------------------------------------------------- 傷害數字 */

  /** 傷害數字（SPEC-LAYOUT §9）：目標右側、由上往下堆疊、出手者顏色、先上彈再停、淡出 */
  function drawNumbers(state) {
    const numbers = Array.isArray(state.numbers) ? state.numbers : [];
    for (const item of numbers) {
      if (!item || typeof item !== 'object') continue;
      // world 每幀已把 vy 套進 y（n.y += n.vy），渲染器只讀 y，不再自行位移
      const alpha = clamp(num(item.alpha, 1), 0, 1);
      if (alpha <= 0.01) continue;
      const str = item.text == null ? '' : String(item.text);
      if (!str) continue;
      const x = num(item.x, ENEMY_CENTER_X + NUMBER.offsetX);
      const y = num(item.y, ENEMY_FEET_Y);
      const color = item.miss === true ? '#9a9a9a' : colorString(item.color) || UI.white;
      ctx.save();
      ctx.globalAlpha = alpha;
      // 四方向黑描邊（讓數字在背景上可讀）
      for (const [ox, oy] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
        text(str, x + ox, y + oy, {
          font: 'fnt_mainbig',
          color: '#000000',
          align: 'center',
          baseline: 'middle',
        });
      }
      text(str, x, y, { font: 'fnt_mainbig', color, align: 'center', baseline: 'middle' });
      ctx.restore();
    }
  }

  /* ------------------------------------------------------ fade / flash */

  function drawFadeFlash(state) {
    const flash = state.flash && typeof state.flash === 'object' ? state.flash : null;
    const fade = state.fade && typeof state.fade === 'object' ? state.fade : null;
    if (fade) {
      const alpha = clamp(num(fade.alpha, 0), 0, 1);
      if (alpha > 0.001) fillRect(0, 0, W, H, colorString(fade.color) || '#000000', alpha);
    }
    if (flash) {
      const alpha = clamp(num(flash.alpha, 0), 0, 1);
      if (alpha > 0.001) fillRect(0, 0, W, H, colorString(flash.color) || '#ffffff', alpha);
    }
  }

  /* ---------------------------------------------------------- 結算畫面 */

  /** 敗北或逃跑的結算標題；勝利用一般旁白框。 */
  function drawLossResult(state) {
    const label = currentStrings[state.result];
    const color = state.result === 'defeat' ? UI.red : UI.dim;
    fillRect(0, TEXT_TOP, W, TEXT_AREA_H, '#000000');
    fillRect(0, TEXT_TOP, W, 1, color);
    text(label, W / 2, TEXT_TOP + 6, {
      font: 'fnt_mainbig',
      scale: 2,
      color,
      align: 'center',
      baseline: 'top',
    });
    if (num(state.frame, 0) % 30 < 20) {
      text(currentStrings.press, W / 2, TEXT_BOTTOM - 16, {
        font: 'fnt_tinynoelle',
        color: UI.white,
        align: 'center',
        baseline: 'top',
      });
    }
  }

  /* ------------------------------------------------------------ 對外 */

  function resize(scale) {
    if (destroyed) return currentScale || 1;
    currentScale = setupCanvas(canvas, scale);
    return currentScale;
  }

  function draw(state, options) {
    if (destroyed || !ctx) return;
    const opts = options && typeof options === 'object' ? options : {};
    if (typeof opts.scale === 'number' && Number.isFinite(opts.scale)) {
      const s = clamp(Math.floor(opts.scale), 1, 16);
      if (s !== currentScale) currentScale = setupCanvas(canvas, s);
    } else if (!currentScale) {
      currentScale = setupCanvas(canvas, 1);
    }
    if (canvas.width <= 0 || canvas.height <= 0) return;

    const lang = normalizeLang(opts.lang);
    if (lang !== currentLang || currentStrings !== LANG_STRINGS[lang]) {
      currentLang = lang;
      currentStrings = LANG_STRINGS[lang];
      currentEncStrings = ENC_STRINGS[lang] || ENC_STRINGS.zh;
    }
    const view = {
      lang,
      showHitboxes: opts.showHitboxes === true,
      showGrid: opts.showGrid !== false,
      background: opts.background,
    };

    const safeState = state && typeof state === 'object' ? state : null;

    // 清空
    applyTransform(0, 0);
    fillRect(0, 0, W, H, '#000000');
    if (!safeState) {
      drawBackground({ frame: 0 }, view);
      return;
    }

    const shake = safeState.shake && typeof safeState.shake === 'object' ? safeState.shake : null;
    const shakeX = num(shake && shake.x, 0);
    const shakeY = num(shake && shake.y, 0);

    // 1) 背景（只鋪 y0..362，不震動）
    applyTransform(0, 0);
    drawBackground(safeState, view);

    const hasArenaFill = Boolean(safeState.battle?.arena?.fill);
    // Explicit arena fills cover scenery (negative layers), but preserve actors and props.
    ctx.save();
    applyTransform(shakeX, shakeY);
    drawActors(safeState, hasArenaFill ? 'background' : 'all');
    ctx.restore();

    // 3) 彈幕回合：框／子彈／靈魂（SPEC-LAYOUT §5：框畫在敵人之上）
    applyTransform(shakeX, shakeY);
    if (hasArenaFill) {
      drawBattle(safeState, view, { box: false, arenaFill: true, bullets: false, soul: false });
      drawActors(safeState, 'foreground');
    }
    drawBattle(safeState, view, { arenaFill: !hasArenaFill });

    // 4) 敵人泡泡（半震）
    applyTransform(shakeX * 0.5, shakeY * 0.5);
    drawBubbles(safeState);

    // 5) 傷害數字（不震）
    applyTransform(0, 0);
    drawNumbers(safeState);

    // 6) TP 條
    drawTpBar(safeState);

    // 7) 隊伍面板列（含選單按鈕列與分隔線）
    drawPartyPanel(safeState);

    // 8) 底部文字區：敗北/逃跑標題 > FIGHT 條 > 選單清單 > 旁白/對話
    const lossResult = safeState.result === 'defeat' || safeState.result === 'flee';
    if (lossResult) drawLossResult(safeState);
    else if (!safeState.result && safeState.fight?.bars?.length) drawFightBars(safeState);
    else if (!safeState.result && safeState.menu?.list) drawMenuList(safeState);
    else drawTextbox(safeState);

    // 9) fade / flash
    applyTransform(0, 0);
    drawFadeFlash(safeState);
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    if (typeof unregisterFontProvider === 'function') {
      unregisterFontProvider();
      unregisterFontProvider = null;
    }
    if (painter && typeof painter.release === 'function') painter.release();
  }

  return {
    draw,
    resize,
    getScale: () => currentScale || 1,
    getLang: () => currentLang,
    /** 版面常數（除錯 / 測試用；與 LAYOUT 同源） */
    getLayout: () => LAYOUT,
    /** 入戰轉場：每個可見演員在戰鬥畫面上的腳底位置（場景編輯器把場景人物移動到這裡）。 */
    entryPositions(state) {
      const safe = state && typeof state === 'object' ? state : {};
      const frame = num(safe.frame, 0);
      return actorOrder(safe).filter(({ actor }) => actor && actor.visible !== false).map((item) => {
        const { x, feetY } = actorPose(safe, item, frame, { shake: false });
        return { id: item.actor.id, kind: item.kind, index: item.index, x, y: feetY };
      });
    },
    /** 入戰轉場：分開畫背景與演員（positions / trails 是 entryPositions 形狀的位置表）。 */
    drawEntry(state, positions, { background = true, actors = true, trails = [] } = {}) {
      if (destroyed || !ctx) return;
      if (!currentScale) currentScale = setupCanvas(canvas, 1);
      const safe = state && typeof state === 'object' ? state : {};
      applyTransform(0, 0);
      ctx.clearRect(0, 0, W, H);
      if (background) drawBackground(safe, { background: safe.background, showGrid: true });
      if (actors) {
        for (const trail of Array.isArray(trails) ? trails : []) drawActors(safe, 'all', new Map(trail.map((p) => [p.id, p])));
        drawActors(safe, 'all', new Map((Array.isArray(positions) ? positions : []).map((p) => [p.id, p])));
      }
    },
    destroy,
  };
}

export default createEncounterRenderer;
