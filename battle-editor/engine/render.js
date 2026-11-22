/**
 * engine/render.js — 640×480 邏輯畫布繪製（SPEC §7 / §9，E2 擁有）
 *
 * export function createRenderer(canvas, assets)
 *   → { draw(state, options), resize(scale), getScale(), destroy() }
 *
 * - 只讀 `battle.getState()` 的形狀；不 import sim。
 * - state 全部欄位皆容錯（缺欄位/空陣列都不崩潰）。
 * - assets 可為 loadAssets() 結果或 null；缺圖一律畫洋紅佔位方塊。
 * - 繪製順序（SPEC §7）：
 *     背景（程序化暗紫格線，或 settings.background 平鋪）
 *     → 敵人 → 戰鬥框（黑底 + 描邊，支援 rotation）
 *     → 子彈（maskToBox 時以框路徑 clip）
 *     → 靈魂（spr_heart；invFrames>0 閃爍；grazing 官方心形外框）
 *     → 底部隊伍面板（y ≥ 362）+ 左側直立橙 TP 條（含百分比）
 *     → hitbox 除錯層（showHitboxes）→ hurtFlash（全屏紅光）
 *
 * 擦彈視覺（FX-GRAZE）：擦彈時畫的是官方 spr_grazeappear 的心形外框（上兩瓣、下尖），
 * 不是圓形光暈。形狀取自 engine/graze-mask.js 的遮罩邊緣（MASK_EDGE），
 * 顏色與亮暗脈動依影片逐幀取樣（亮黃 rgb(252,252,96) ↔ 暗橄欖 rgb(126,130,42)）。
 *   整體套用 state.shake 位移。
 *
 * 原點約定：優先使用索引的 ox/oy。由於 SPEC §2 說明「未驗證者取 0」，
 * 而官方多數 sprite 的原點其實在中心附近，故當 ox===0 && oy===0 時
 * 預設改用中心（sprite.w/2, sprite.h/2）；可用 drawSprite 選項
 * { originMode: 'topLeft' } 覆寫。背景平鋪不受影響。
 *
 * 文字（SPEC §7 2026-11-07 更新）：遊戲畫面文字一律英文 + 官方點陣字體
 * （assets.index.fonts / dr-battle-font/1）。匯出 drawText(ctx, text, x, y, opts)
 * 與 measureText(ctx, text, opts)；字體由 createRenderer 安裝的 resolver 解析
 * （assets.getFont），未載入或缺字時退回 "Courier New", monospace。
 */

// 共用 HUD（隊伍面板列 / TP 條 / 分區框）。render-hud 反向 import 本檔的 drawText/measureText，
// 但只在呼叫時讀取，因此循環 import 安全（模組載入期不觸碰任何 render.js 綁定）。
import * as HUD from './render-hud.js';
import { bulletClip, clipShape, pointInClip } from './arena.js';
// 官方擦彈心形遮罩（FX-GRAZE）：擦彈外框的形狀直接取自遮罩邊緣
import { GRAZE_MASK, MASK_EDGE } from './graze-mask.js';

export const LOGICAL_WIDTH = 640;
export const LOGICAL_HEIGHT = 480;
export const PANEL_Y = 362;
export const SIM_FPS = 30;

/**
 * 戰鬥框缺值退回（SPEC-LAYOUT §5 與 engine/attack.js 的 BOX_DEFAULTS 一致）。
 * 中心 (320,190)、內部 144×158、綠描邊 3px。
 */
const BOX_DEFAULT = Object.freeze({
  x: 320,
  y: 190,
  w: 144,
  h: 158,
  rotation: 0,
  border: 3,
  color: '#00c000',
});

const DEG = Math.PI / 180;
const DEFAULT_SPRITE_W = 16;
const DEFAULT_SPRITE_H = 16;
const MISSING_FILL = '#ff00ff';
const MISSING_EDGE = '#ffd6ff';
const FONT_STACK = '"Courier New", "Consolas", monospace';
const TINT_CACHE_LIMIT = 320;
/** 官方點陣字體名稱（SPEC §7） */
const FONT_MAIN = 'fnt_main';
const FONT_MAINBIG = 'fnt_mainbig';
const FONT_SMALL = 'fnt_small';
/** 對外提供的字體名稱表（編輯器/play.html 可直接用） */
export const FONT_NAMES = Object.freeze({ main: FONT_MAIN, big: FONT_MAINBIG, small: FONT_SMALL });
/** 點陣字形染色快取上限 */
const GLYPH_CACHE_LIMIT = 512;

/* ------------------------------------------- 擦彈外框（官方 grazeappear） */

/**
 * 擦彈外框的顏色（依影片 DeltaruneBossFightSpeedRun.mp4 逐幀取樣）。
 *
 * 影片裡外框在兩種亮度間脈動：亮態約 rgb(250,250,60–120)（接近官方 spr_grazeappear_yellow
 * 的色相）、暗態約 rgb(125,128,30–50)（亮態的一半左右，像 alpha 疊在黑底上）。
 * 亮暗是交替的（同一段擦彈期間會反覆亮暗），不是單調淡出；所以這裡用
 * grazeFlash（1 → 0，8 幀）當「剛擦到」的亮度加成，再疊一個 2 幀周期的閃爍。
 */
const GRAZE_RING_BRIGHT = 'rgb(252, 252, 96)';
const GRAZE_RING_DIM = 'rgb(126, 130, 42)';
/** 外框線寬（遊戲像素；影片量到約 2 video px / 2.5 ≈ 1px，亮態略粗） */
const GRAZE_RING_WIDTH = 1;

/**
 * 畫官方心形擦彈外框（形狀 = 25×25 遮罩的四鄰居邊緣，= spr_grazeappear）。
 *
 * 座標：以靈魂中心為原點；遮罩格 (x, y) 的像素中心 = (x - cx, y - cy)。
 * 外框只是「一像素一格」的方點，不做反鋸齒（官方素材是硬邊像素，640×480 上要維持像素感）。
 *
 * @param {CanvasRenderingContext2D} target
 * @param {number} cx 靈魂中心 x（邏輯座標）
 * @param {number} cy 靈魂中心 y
 * @param {number} flash 0..1 剛擦到的亮度加成
 * @param {number} frame 目前影格（做 2 幀周期的閃爍；可省略）
 * @param {{alpha?:number, color?:string}} [opts]
 */
function drawGrazeRing(target, cx, cy, flash, frame, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const f = clamp(num(flash, 0), 0, 1);
  if (f <= 0.001) return;
  const alpha = clamp(num(o.alpha, 1), 0, 1);
  if (alpha <= 0.001) return;
  const step = Math.floor(num(frame, 0) / 2) % 2; // 2 幀一循環的脈動
  const bright = f * 0.55 + (step === 0 ? 0.3 : 0) + 0.15;
  const color = colorString(o.color) || (bright >= 0.55 ? GRAZE_RING_BRIGHT : GRAZE_RING_DIM);
  const x0 = Math.round(cx - GRAZE_MASK.cx);
  const y0 = Math.round(cy - GRAZE_MASK.cy);
  target.save();
  // 透明度由呼叫端決定（正在擦 = 1、擦完之後 = grazeFlash 淡出）；
  // 亮度脈動是用「換顏色」做，不是改 alpha —— 影片裡外框是實色亮黃 ↔ 暗橄欖。
  target.globalAlpha = alpha;
  target.fillStyle = color;
  for (let i = 0; i < MASK_EDGE.length; i += 1) {
    const p = MASK_EDGE[i];
    target.fillRect(x0 + p[0], y0 + p[1], GRAZE_RING_WIDTH, GRAZE_RING_WIDTH);
  }
  target.restore();
}

/**
 * 擦彈外框的統一入口（world 層，由 drawSoul 呼叫）。
 *
 * 把「正在擦」與「擦完之後的淡出」都畫在這裡，好處是外框跟著靈魂一起受
 * 震動 / 框縮放 / 旋轉變換，跟官方一樣是黏在靈魂身上的。
 * drawFlashOverlay 只負責全屏受傷紅光，不再畫擦彈外框（避免同一幀疊兩層）。
 *
 * @param {CanvasRenderingContext2D} target
 * @param {object} soul state.soul
 * @param {object} state 完整 state（讀 grazeFlash / frame）
 * @param {number} x 靈魂中心 x（邏輯座標）
 * @param {number} y 靈魂中心 y
 */
function drawGrazeRingForSoul(target, soul, state, x, y) {
  const grazing = Boolean(soul && soul.grazing === true);
  const flash = clamp(num(state && state.grazeFlash, 0), 0, 1);
  if (!grazing && flash <= 0.001) return;
  const frame = num(state && state.frame, 0);
  // 正在擦：不透明，亮度靠顏色在亮黃↔暗橄欖之間脈動（至少維持暗態 0.55）。
  // 擦完之後：顏色沿用脈動，但 alpha 跟著 grazeFlash 在 8 幀內 1→0 淡出（sim.js 每幀 -1/8）。
  drawGrazeRing(target, x, y, grazing ? Math.max(flash, 0.55) : flash, frame, {
    alpha: grazing ? 1 : flash,
  });
}

/** 官方擦彈外框的格座標範圍（測試/除錯用；相對靈魂中心） */
export function grazeRingBounds() {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [x, y] of MASK_EDGE) {
    const dx = x - GRAZE_MASK.cx;
    const dy = y - GRAZE_MASK.cy;
    if (dx < minX) minX = dx;
    if (dx > maxX) maxX = dx;
    if (dy < minY) minY = dy;
    if (dy > maxY) maxY = dy;
  }
  return { minX, maxX, minY, maxY };
}

/** 從任意輸入取有限數字 */
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
  if (/^[a-z]{3,20}$/i.test(s)) return s; // CSS 顏色名
  return null;
}

/* ------------------------------------------------------ 點陣字體（§7） */

/**
 * 遊戲畫面固定字串表（SPEC §7）。zh 用**簡體中文**（配合簡體補丁點陣字庫），
 * HP / TP 為官方原樣；隊名、敵名等使用者資料不經過此表。
 * @type {{zh: Readonly<Record<string,string>>, en: Readonly<Record<string,string>>}}
 */
export const LANG_STRINGS = Object.freeze({
  zh: Object.freeze({
    hp: 'HP',
    tp: 'TP',
    max: '最大',
    down: '倒下',
    miss: '未命中',
    hit: '被击中',
    graze: '擦弹',
    pause: '暂停',
    resume: '继续',
    restart: '重新开始',
    gameover: '战斗结束',
    lang: '简体中文',
    // ---- 遭遇戰（SPEC-P2 §2 選單與結算；zh 為簡體，配合 @zh 點陣字庫）----
    fight: '战斗',
    act: '行动',
    magic: '魔法',
    item: '物品',
    spare: '饶恕',
    defend: '防御',
    mercy: '饶恕',
    target: '目标',
    turn: '回合',
    defeat: '失败',
    flee: '逃离',
    press: '按 Z 继续',
    allow: '允许',
    toospare: '还不能饶恕',
    actions: '行动',
  }),
  en: Object.freeze({
    hp: 'HP',
    tp: 'TP',
    max: 'MAX',
    down: 'DOWN',
    miss: 'MISS',
    hit: 'HIT',
    graze: 'GRAZE',
    pause: 'PAUSE',
    resume: 'RESUME',
    restart: 'RESTART',
    gameover: 'GAME OVER',
    lang: 'English',
    // ---- encounter menu / result (SPEC-P2 §2) ----
    fight: 'FIGHT',
    act: 'ACT',
    magic: 'MAGIC',
    item: 'ITEM',
    spare: 'SPARE',
    defend: 'DEFEND',
    mercy: 'MERCY',
    target: 'TARGET',
    turn: 'TURN',
    defeat: 'DEFEAT',
    flee: 'FLEE',
    press: 'PRESS Z',
    allow: 'SPARE',
    toospare: 'NOT YET',
    actions: 'ACT',
  }),
});

/** 正規化語言代碼；未知值 → 'zh'（SPEC §7 預設 zh） */
export function normalizeLang(lang) {
  return lang === 'en' ? 'en' : 'zh';
}

/** 取固定字串表 */
export function getStrings(lang) {
  return LANG_STRINGS[normalizeLang(lang)];
}

/** 取單一字串；未知 key 回傳 key 本身 */
export function t(lang, key) {
  const table = getStrings(lang);
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : String(key);
}

/**
 * 字體提供者：createRenderer(canvas, assets) 會把 assets.getFont 註冊進來；
 * Node 測試 / 特殊情境可用 registerFont(name, font) 直接塞字型。
 * @type {Set<(name:string)=>any>}
 */
const fontProviders = new Set();
/** @type {Map<string, any>} 手動註冊的字型（name → 字型物件） */
const registeredFonts = new Map();
/** @type {Map<string, any>} 染色後的圖集快取：key = 字型|顏色 */
const glyphAtlases = new Map();
/** @type {WeakMap<object, number>} 字型物件 → 大寫字高（像素） */
const capHeights = new WeakMap();
const GLYPH_ATLAS_CACHE_LIMIT = 12;
/**
 * 超過這個像素量的字形圖集不做整張染色，改用逐字染色（快取）：
 * 中文 @zh 圖集動輒 733k–2.5M px，整張染色每個顏色要多佔數 MB。
 * 英文 fnt_main(128×128)、fnt_mainbig(256×256) 都遠低於門檻，仍走整張快取。
 */
const ATLAS_TINT_MAX_PIXELS = 400000;
/** SPEC §7 退回鏈最後一層的中文 OTF 字體索引名 */
const OTF_FONT_NAME = 'DTM';

/** 註冊字型提供者；回傳取消函式 */
export function registerFontProvider(provider) {
  if (typeof provider !== 'function') return () => {};
  fontProviders.add(provider);
  return () => fontProviders.delete(provider);
}

/** 直接註冊字型物件（dr-battle-font 形狀：{ name, image, glyph(char), lineHeight, size, missingChar }） */
export function registerFont(name, font) {
  const key = typeof name === 'string' && name ? name : font && font.name;
  if (!key || !font || typeof font !== 'object') return () => {};
  registeredFonts.set(key, font);
  return () => {
    if (registeredFonts.get(key) === font) registeredFonts.delete(key);
  };
}

/** 依名稱解析字型（不自動退回主字體；找不到回 null） */
function resolveNamedFont(name) {
  if (!name || typeof name !== 'string') return null;
  for (const provider of fontProviders) {
    try {
      const font = provider(name);
      if (font && typeof font === 'object') return font;
    } catch (_err) {
      /* 提供者出錯不影響繪製 */
    }
  }
  return registeredFonts.get(name) || null;
}

/** 是否為點陣字型（有圖集與 glyph()） */
function isBitmapFont(font) {
  return !!(font && font.image && typeof font.glyph === 'function');
}

/** 解析字型名稱 → 點陣字型物件（找不到回 null） */
function resolveFont(nameOrFont) {
  if (nameOrFont && typeof nameOrFont === 'object') return nameOrFont;
  const name = typeof nameOrFont === 'string' && nameOrFont ? nameOrFont : FONT_MAIN;
  return resolveNamedFont(name);
}

/**
 * SPEC §7 字元退回鏈：
 *   lang=zh → `<名>@zh` 點陣 → `<名>` 英文點陣 → DTM.otf → 系統字體
 *   lang=en → `<名>` 英文點陣 → 系統字體
 * @returns {{ chain:any[], otf:any|null, primary:any|null, lang:'zh'|'en' }}
 */
function fontChain(fontOpt, lang) {
  const langKey = normalizeLang(lang);
  const requested =
    fontOpt && typeof fontOpt === 'object'
      ? fontOpt
      : resolveNamedFont(typeof fontOpt === 'string' && fontOpt ? fontOpt : FONT_MAIN);
  const baseName =
    (requested && typeof requested.name === 'string' && requested.name) ||
    (typeof fontOpt === 'string' && fontOpt ? fontOpt : FONT_MAIN);

  const chain = [];
  if (langKey === 'zh') {
    const zhFont = resolveNamedFont(baseName + '@zh');
    if (isBitmapFont(zhFont)) chain.push(zhFont);
    // 中文缺字時仍嘗試主字體（基底名）本身
    if (!isBitmapFont(requested)) {
      const fallbackZh = resolveNamedFont(FONT_MAIN + '@zh');
      if (isBitmapFont(fallbackZh) && chain.indexOf(fallbackZh) < 0) chain.push(fallbackZh);
    }
  }
  if (isBitmapFont(requested) && chain.indexOf(requested) < 0) chain.push(requested);
  if (!chain.length) {
    const main = resolveNamedFont(FONT_MAIN);
    if (isBitmapFont(main)) chain.push(main);
  }

  let otf = null;
  if (langKey === 'zh') {
    const candidate = resolveNamedFont(OTF_FONT_NAME);
    if (candidate && (candidate.kind === 'otf' || candidate.family)) otf = candidate;
  }
  return { chain, otf, primary: chain[0] || null, lang: langKey };
}

/** 取字型中某字元的字形（缺字回 null） */
function glyphFor(font, ch) {
  if (!font || typeof font.glyph !== 'function') return null;
  try {
    const glyph = font.glyph(ch);
    return glyph && typeof glyph === 'object' ? glyph : null;
  } catch (_err) {
    return null;
  }
}

/** 字型的大寫字高（用來把 alphabetic baseline 換成圖集列頂端） */
function fontCapHeight(font) {
  const cached = capHeights.get(font);
  if (cached) return cached;
  let h = 0;
  if (typeof font.glyph === 'function') {
    for (const probe of ['A', 'H', 'M', '0']) {
      const glyph = font.glyph(probe);
      const gh = glyph ? num(glyph.h, 0) : 0;
      if (gh > 0) {
        h = gh;
        break;
      }
    }
  }
  if (!(h > 0)) h = Math.max(1, Math.round(num(font.size, 12)));
  capHeights.set(font, h);
  return h;
}

function glyphAtlasKey(font) {
  const img = font && font.image;
  const src = img ? img.currentSrc || img.src || '' : '';
  return String(font && font.name ? font.name : 'font') + '|' + src;
}

/**
 * 取（必要時建立）染色後的圖集：字形只存在 alpha 通道、RGB 全白，
 * 用離屏 canvas 以 source-in 填色 → 快取。純白直接用原圖（省一次大圖拷貝）。
 */
function tintGlyphAtlas(font, css) {
  const img = font && font.image;
  if (!img) return null;
  if (!css || css === '#ffffff' || css === '#fff' || css === 'white') return img;
  const key = glyphAtlasKey(font) + '|' + css;
  const cached = glyphAtlases.get(key);
  if (cached) return cached;
  if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') {
    return img; // 無 DOM：直接畫白色圖集
  }
  const w = Math.round(num(img.naturalWidth || img.width, 0));
  const h = Math.round(num(img.naturalHeight || img.height, 0));
  if (!(w > 0) || !(h > 0)) return img;
  // 超大中文圖集（例如 fnt_mainbig@zh 1579×1591）不做整張染色，
  // 改由 tintGlyphQuad() 逐字染色（記憶體小兩個數量級）。
  if (w * h > ATLAS_TINT_MAX_PIXELS) return img;

  let off = null;
  try {
    off = document.createElement('canvas');
    off.width = w;
    off.height = h;
    const octx = off.getContext('2d');
    if (!octx) return img;
    octx.imageSmoothingEnabled = false;
    octx.clearRect(0, 0, w, h);
    octx.drawImage(img, 0, 0);
    // source-in：只留圖集有 alpha 的像素，並換成指定顏色
    octx.globalCompositeOperation = 'source-in';
    octx.fillStyle = css;
    octx.fillRect(0, 0, w, h);
    octx.globalCompositeOperation = 'source-over';
  } catch (_err) {
    return img;
  }

  if (glyphAtlases.size >= GLYPH_ATLAS_CACHE_LIMIT) glyphAtlases.clear();
  glyphAtlases.set(key, off);
  return off;
}

/** @type {Map<string, any>} 逐字染色快取（大字庫用）：key = 字型|顏色|碼位 */
const tintedGlyphs = new Map();
const TINTED_GLYPH_CACHE_LIMIT = 512;

/**
 * 決定畫某個字形要用哪張圖與來源矩形。
 * 小圖集 → 整張染色（快取）；大圖集 → 逐字染色的小 canvas（快取）。
 * @returns {{ img:any, sx:number, sy:number, sw:number, sh:number }}
 */
function tintGlyphQuad(font, css) {
  const img = font && font.image;
  const glyphArg = arguments.length > 2 ? arguments[2] : null;
  const glyph = glyphArg && typeof glyphArg === 'object' ? glyphArg : null;
  const sx = Math.max(0, Math.round(num(glyph && glyph.x, 0)));
  const sy = Math.max(0, Math.round(num(glyph && glyph.y, 0)));
  const sw = Math.max(1, Math.round(num(glyph && glyph.w, 1)));
  const sh = Math.max(1, Math.round(num(glyph && glyph.h, 1)));
  if (!img) return { img, sx, sy, sw, sh };

  const w = Math.round(num(img.naturalWidth || img.width, 0));
  const h = Math.round(num(img.naturalHeight || img.height, 0));
  if (!css || css === '#ffffff' || css === '#fff' || css === 'white' || !(w > 0) || !(h > 0)) {
    return { img, sx, sy, sw, sh };
  }
  if (w * h <= ATLAS_TINT_MAX_PIXELS) {
    return { img: tintGlyphAtlas(font, css) || img, sx, sy, sw, sh };
  }
  if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') {
    return { img, sx, sy, sw, sh };
  }

  const key = glyphAtlasKey(font) + '|' + css + '|' + sx + ',' + sy + ',' + sw + ',' + sh;
  const cached = tintedGlyphs.get(key);
  if (cached) return { img: cached, sx: 0, sy: 0, sw, sh };
  try {
    const off = document.createElement('canvas');
    if (!off) return { img, sx, sy, sw, sh };
    off.width = sw;
    off.height = sh;
    const octx = off.getContext('2d');
    if (!octx) return { img, sx, sy, sw, sh };
    octx.imageSmoothingEnabled = false;
    octx.clearRect(0, 0, sw, sh);
    octx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
    octx.globalCompositeOperation = 'source-in';
    octx.fillStyle = css;
    octx.fillRect(0, 0, sw, sh);
    octx.globalCompositeOperation = 'source-over';
    if (tintedGlyphs.size >= TINTED_GLYPH_CACHE_LIMIT) tintedGlyphs.clear();
    tintedGlyphs.set(key, off);
    return { img: off, sx: 0, sy: 0, sw, sh };
  } catch (_err) {
    return { img, sx, sy, sw, sh };
  }
}

/** 文字排版資訊（不含繪製）：逐字元依 SPEC §7 退回鏈選字型 */
function layoutText(text, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const str = text == null ? '' : String(text);
  // 允許分數級縮放（參考幀量測出 0.55 / 0.78 這種字級）；整數仍是最清晰的
  const rawScale = num(o.scale, 1);
  const scale = Number.isFinite(rawScale) && rawScale > 0 ? Math.max(0.25, rawScale) : 1;
  const { chain, otf, lang } = fontChain(o.font, o.lang);
  const lines = str.split('\n');
  const baseSize = Math.max(1, Math.round(num(o.size, chain[0] ? num(chain[0].size, 12) : 12)));

  // 每個字元挑第一個有字形的點陣字型；都沒有 → null（該字走 OTF / 系統字）
  const runs = lines.map((line) =>
    Array.from(line).map((ch) => {
      for (const font of chain) {
        const glyph = glyphFor(font, ch);
        if (glyph) return { ch, font, glyph };
      }
      return { ch, font: null, glyph: null };
    }),
  );

  const anyBitmap = runs.some((line) => line.some((cell) => cell.glyph));
  const anyFallback = runs.some((line) => line.some((cell) => !cell.glyph));
  const lineHeight = anyBitmap
    ? Math.max(1, Math.round(num(chain[0] && chain[0].lineHeight, baseSize + 4))) * scale
    : baseSize + 4;

  // 寬度：點陣字用 shift；退回字用近似值（0.55 em / 中文 1 em）
  let width = 0;
  for (const line of runs) {
    let lineWidth = 0;
    for (const cell of line) {
      if (cell.glyph) lineWidth += num(cell.glyph.shift, 0) * scale;
      else lineWidth += approxCharWidth(cell.ch, baseSize) * scale;
    }
    if (lineWidth > width) width = lineWidth;
  }

  return {
    width,
    lines,
    runs,
    lineHeight,
    bitmap: anyBitmap,
    hasFallback: anyFallback,
    chain,
    otf,
    lang,
    size: baseSize,
    scale,
  };
}

/** 非點陣字（OTF / 系統字）的寬度近似：ASCII 0.55em、CJK 1em */
function approxCharWidth(ch, size) {
  const code = ch && ch.codePointAt ? ch.codePointAt(0) || 0 : 0;
  if (code > 0x2e80) return size; // CJK / 全形
  return size * 0.55;
}

/**
 * 量測點陣文字（供右對齊 / 置中排版；不需要 canvas）。
 * @param {string} text
 * @param {{ font?:string|object, scale?:number, size?:number }} [opts]
 * @returns {{ width:number, height:number, lineHeight:number, lines:string[], bitmap:boolean }}
 */
export function measureText(text, opts) {
  const layout = layoutText(text, opts);
  return {
    width: layout.width,
    height: layout.lines.length * layout.lineHeight,
    lineHeight: layout.lineHeight,
    lines: layout.lines,
    bitmap: layout.bitmap,
  };
}

/**
 * 繪製點陣文字（SPEC §7）。字形來源矩形 x,y,w,h → 畫在 (cx, cy + offset)，
 * 游標前進 shift，換行 lineHeight。字元退回鏈：
 *   lang=zh → `<名>@zh` 點陣 → `<名>` 英文點陣 → DTM.otf → 系統字體
 *   lang=en → `<名>` 英文點陣 → 系統字體
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} text 支援 \n 換行
 * @param {number} x
 * @param {number} y 依 opts.baseline 解讀（預設 alphabetic）
 * @param {{ font?:string|object, lang?:'zh'|'en', color?:string, align?:'left'|'center'|'right',
 *           baseline?:'alphabetic'|'top'|'middle'|'bottom', scale?:number, size?:number,
 *           alpha?:number }} [opts]
 * @returns {number} 內容寬度（像素）
 */
export function drawText(ctx, text, x, y, opts) {
  if (!ctx || typeof ctx !== 'object') return 0;
  const o = opts && typeof opts === 'object' ? opts : {};
  const str = text == null ? '' : String(text);
  if (!str) return 0;

  const layout = layoutText(str, o);
  const scale = layout.scale;
  const color = colorString(o.color) || '#ffffff';
  const align = o.align === 'center' || o.align === 'right' ? o.align : 'left';
  const baseline = ['top', 'middle', 'bottom', 'alphabetic'].indexOf(o.baseline) >= 0 ? o.baseline : 'alphabetic';
  const alpha = clamp(num(o.alpha, 1), 0, 1);
  if (alpha <= 0) return 0;
  const primary = layout.chain[0] || null;

  ctx.save();
  ctx.imageSmoothingEnabled = false;
  if (alpha < 1) ctx.globalAlpha *= alpha;

  if (layout.bitmap) {
    const capH = primary ? Math.round(fontCapHeight(primary) * scale) : Math.round(layout.size * 0.75);
    let top0;
    if (baseline === 'top') top0 = y;
    else if (baseline === 'middle') top0 = y - Math.round(capH / 2);
    else top0 = y - capH; // 'alphabetic' / 'bottom'

    for (let i = 0; i < layout.runs.length; i += 1) {
      const cells = layout.runs[i];
      let lineWidth = 0;
      for (const cell of cells) {
        lineWidth += cell.glyph ? num(cell.glyph.shift, 0) * scale : approxCharWidth(cell.ch, layout.size) * scale;
      }
      let cursor =
        align === 'center' ? Math.round(x - lineWidth / 2) : align === 'right' ? Math.round(x - lineWidth) : Math.round(x);
      const lineTop = Math.round(top0 + i * layout.lineHeight);
      let pendingFallback = '';
      let fallbackStart = cursor;

      const flushFallback = () => {
        if (!pendingFallback) return;
        const px = Math.max(1, Math.round(layout.size * scale));
        ctx.save();
        ctx.font = (o.bold ? 'bold ' : '') + px + 'px ' + fallbackFontStack(layout);
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = color;
        ctx.fillText(pendingFallback, Math.round(fallbackStart), Math.round(lineTop + capH));
        ctx.restore();
        pendingFallback = '';
      };

      for (const cell of cells) {
        if (!cell.glyph) {
          // 退回鏈下一層（OTF / 系統字），累積到下一段一起畫
          if (!pendingFallback) fallbackStart = cursor;
          pendingFallback += cell.ch;
          cursor += approxCharWidth(cell.ch, layout.size) * scale;
          continue;
        }
        flushFallback();
        const glyph = cell.glyph;
        const gw = Math.max(1, Math.round(num(glyph.w, 0) * scale));
        const gh = Math.max(1, Math.round(num(glyph.h, 0) * scale));
        const glyphFont = cell.font || primary;
        // 小圖集整張染色；超大中文圖集逐字染色（快取）
        const quad = tintGlyphQuad(glyphFont, color, glyph);
        ctx.drawImage(
          quad.img,
          quad.sx,
          quad.sy,
          quad.sw,
          quad.sh,
          Math.round(cursor),
          Math.round(lineTop + num(glyph.offset, 0) * scale),
          gw,
          gh,
        );
        cursor += num(glyph.shift, 0) * scale;
      }
      flushFallback();
    }
    ctx.restore();
    return layout.width;
  }

  // 完全沒有點陣字：OTF 或系統等寬字
  const px = Math.max(1, Math.round(layout.size * scale));
  ctx.font = (o.bold ? 'bold ' : '') + px + 'px ' + fallbackFontStack(layout);
  ctx.textAlign = align;
  ctx.textBaseline = baseline;
  ctx.fillStyle = color;
  for (let i = 0; i < layout.lines.length; i += 1) {
    ctx.fillText(layout.lines[i], x, y + i * layout.lineHeight);
  }
  ctx.restore();
  return layout.width;
}

/** 退回字體的 CSS font-family 字串：DTM.otf → Courier New, monospace */
function fallbackFontStack(layout) {
  const otf = layout && layout.otf;
  const family = otf && typeof otf.family === 'string' && otf.family ? otf.family : '';
  if (otf) {
    return family
      ? '"' + family + '", "DTM", "Microsoft JhengHei", ' + FONT_STACK
      : '"DTM", "Microsoft JhengHei", ' + FONT_STACK;
  }
  return FONT_STACK;
}

function setupCanvas(canvas, scale) {
  const s = clamp(Math.floor(num(scale, 1)), 1, 16);
  const w = LOGICAL_WIDTH * s;
  const h = LOGICAL_HEIGHT * s;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  return s;
}

/**
 * 依可用視窗大小算出整數縮放倍率（play.html 用；不屬於 SPEC 合約）。
 * @param {number} viewW
 * @param {number} viewH
 * @param {number} [maxScale=4]
 * @returns {number} 至少 1 的整數
 */
export function computeFitScale(viewW, viewH, maxScale = 4) {
  const w = Math.max(1, Math.floor(num(viewW, LOGICAL_WIDTH)));
  const h = Math.max(1, Math.floor(num(viewH, LOGICAL_HEIGHT)));
  const fit = Math.min(Math.floor(w / LOGICAL_WIDTH), Math.floor(h / LOGICAL_HEIGHT));
  return clamp(fit || 1, 1, Math.max(1, Math.floor(num(maxScale, 4))));
}

/**
 * 共用繪製核心（SPEC-P2 §8：render.js 只加最小掛鉤）。
 *
 * createRenderer 與 export drawBattleLayer / createSpritePainter 都建立在這個
 * painter 上：sprite 查詢、染色快取、程序化背景、戰鬥框、子彈、靈魂、hitbox。
 * 由 createRenderer 使用時行為與 Phase 1 完全相同（同一份程式碼、同一套順序）。
 *
 * @param {CanvasRenderingContext2D} ctx 已設為 640×480 邏輯座標
 * @param {object|null} assets loadAssets() 的結果
 */
function createPainter(ctx, assets) {
  const assetStore = assets && typeof assets === 'object' ? assets : null;
  let bgGradient = null;
  let vignetteGradient = null;
  /** @type {Map<string, HTMLCanvasElement>} 染色快取：key = sprite|frame|color */
  const tintCache = new Map();

  /* ------------------------------------------------------------ 素材查詢 */

  function spriteEntry(name) {
    if (!assetStore || typeof name !== 'string' || !name) return null;
    if (typeof assetStore.sprite === 'function') {
      try {
        const entry = assetStore.sprite(name);
        if (entry && typeof entry === 'object') return entry;
      } catch (_err) {
        /* 忽略 */
      }
      return null;
    }
    const list = assetStore.index && assetStore.index.sprites;
    const entry = list && list[name];
    return entry && typeof entry === 'object' ? entry : null;
  }

  function spriteImage(name, frameIndex) {
    if (!assetStore || typeof name !== 'string' || !name) return null;
    if (typeof assetStore.getImage !== 'function') return null;
    try {
      const img = assetStore.getImage(name, frameIndex);
      return img && typeof img === 'object' ? img : null;
    } catch (_err) {
      return null;
    }
  }

  function spriteFrameCount(name) {
    const entry = spriteEntry(name);
    if (!entry) return 1;
    if (Array.isArray(entry.frames) && entry.frames.length) return entry.frames.length;
    return 1;
  }

  function spriteMetrics(name, img) {
    const entry = spriteEntry(name);
    let w = img ? num(img.naturalWidth || img.width, 0) : 0;
    let h = img ? num(img.naturalHeight || img.height, 0) : 0;
    if (!(w > 0)) w = num(entry && entry.w, DEFAULT_SPRITE_W);
    if (!(h > 0)) h = num(entry && entry.h, DEFAULT_SPRITE_H);
    if (!(w > 0)) w = DEFAULT_SPRITE_W;
    if (!(h > 0)) h = DEFAULT_SPRITE_H;
    let ox = num(entry && entry.ox, 0);
    let oy = num(entry && entry.oy, 0);
    return { w, h, ox, oy };
  }

  /* -------------------------------------------------------------- 染色 */

  function tintedImage(img, color, flatColor) {
    if (!img) return null;
    const css = colorString(color);
    if (!css) return img;
    if (typeof document === 'undefined' || !document || typeof document.createElement !== 'function') {
      return img;
    }
    const w = num(img.naturalWidth || img.width, 0) | 0;
    const h = num(img.naturalHeight || img.height, 0) | 0;
    if (!(w > 0) || !(h > 0)) return img;

    const key = (img.src || 'img') + '|' + (img.__drFrame || '') + '|' + w + 'x' + h + '|' + css + (flatColor ? '|flat' : '');
    const cached = tintCache.get(key);
    if (cached) return cached;

    let off = null;
    try {
      off = document.createElement('canvas');
      off.width = w;
      off.height = h;
      const octx = off.getContext('2d');
      if (!octx) return img;
      octx.imageSmoothingEnabled = false;
      octx.clearRect(0, 0, w, h);
      octx.drawImage(img, 0, 0);
      // 心形以原 sprite 的 alpha 上色，紅色原圖也能換成黃色。
      octx.globalCompositeOperation = flatColor ? 'source-in' : 'multiply';
      octx.fillStyle = css;
      octx.fillRect(0, 0, w, h);
      // destination-in：用原圖 alpha 削回輪廓
      if (!flatColor) {
        octx.globalCompositeOperation = 'destination-in';
        octx.drawImage(img, 0, 0);
      }
      octx.globalCompositeOperation = 'source-over';
    } catch (_err) {
      return img;
    }

    if (tintCache.size >= TINT_CACHE_LIMIT) tintCache.clear();
    tintCache.set(key, off);
    return off;
  }

  function drawPlaceholder(x, y, w, h, alpha) {
    const pw = Math.max(2, w);
    const ph = Math.max(2, h);
    if (alpha < 1) {
      ctx.save();
      ctx.globalAlpha *= clamp(alpha, 0, 1);
    }
    ctx.fillStyle = MISSING_FILL;
    ctx.fillRect(x, y, pw, ph);
    ctx.strokeStyle = MISSING_EDGE;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, pw - 1), Math.max(0, ph - 1));
    ctx.beginPath();
    ctx.moveTo(x + 0.5, y + 0.5);
    ctx.lineTo(x + pw - 0.5, y + ph - 0.5);
    ctx.moveTo(x + pw - 0.5, y + 0.5);
    ctx.lineTo(x + 0.5, y + ph - 0.5);
    ctx.stroke();
    if (alpha < 1) ctx.restore();
  }

  /**
   * 繪製一個 sprite（缺圖畫洋紅佔位）。
   * @param {string} name
   * @param {number} frameIndex
   * @param {number} x
   * @param {number} y
   * @param {{ rotation?:number, scale?:number, alpha?:number, color?:string,
   *           originMode?:'auto'|'topLeft'|'center', fallbackW?:number, fallbackH?:number }} [opts]
   * @returns {boolean} 是否畫出真圖（false = 佔位方塊）
   */
  function drawSprite(name, frameIndex, x, y, opts) {
    const o = opts || {};
    const scale = Math.abs(num(o.scale, 1)) || 1;
    const alpha = clamp(num(o.alpha, 1), 0, 1);
    if (alpha <= 0) return false;

    const img = spriteImage(name, frameIndex);
    const m = spriteMetrics(name, img);
    const w = m.w > 0 ? m.w : num(o.fallbackW, DEFAULT_SPRITE_W);
    const h = m.h > 0 ? m.h : num(o.fallbackH, DEFAULT_SPRITE_H);

    const mode = o.originMode || 'auto';
    let ox;
    let oy;
    if (mode === 'topLeft') {
      ox = 0;
      oy = 0;
    } else if (mode === 'center') {
      ox = w / 2;
      oy = h / 2;
    } else if (m.ox !== 0 || m.oy !== 0) {
      ox = m.ox;
      oy = m.oy;
    } else {
      // 索引未驗證原點（0,0）→ 以中心為原點，視覺較正確
      ox = w / 2;
      oy = h / 2;
    }

    const rotation = num(o.rotation, 0);
    ctx.save();
    ctx.translate(num(x, 0), num(y, 0));
    if (rotation) ctx.rotate(rotation * DEG);
    ctx.scale(scale, scale);
    ctx.globalAlpha *= alpha;

    const drawable = img ? tintedImage(img, o.color, o.flatColor) : null;
    let real = false;
    if (drawable) {
      ctx.drawImage(drawable, -ox, -oy, w, h);
      real = true;
    } else {
      drawPlaceholder(-ox, -oy, w, h, 1);
    }
    ctx.restore();
    return real;
  }

  /* ---------------------------------------------------------- 背景 */

  function drawProceduralBackground(time) {
    const W = LOGICAL_WIDTH;
    const H = LOGICAL_HEIGHT;
    if (!bgGradient) {
      bgGradient = ctx.createLinearGradient(0, 0, 0, H);
      bgGradient.addColorStop(0, '#07030f');
      bgGradient.addColorStop(0.45, '#100720');
      bgGradient.addColorStop(1, '#1a0a2a');
    }
    ctx.fillStyle = bgGradient;
    ctx.fillRect(-32, -32, W + 64, H + 64);

    // 中央紫色微光
    if (!vignetteGradient) {
      vignetteGradient = ctx.createRadialGradient(W / 2, H * 0.42, 18, W / 2, H * 0.42, 340);
      vignetteGradient.addColorStop(0, 'rgba(96, 48, 168, 0.30)');
      vignetteGradient.addColorStop(0.55, 'rgba(64, 28, 120, 0.12)');
      vignetteGradient.addColorStop(1, 'rgba(0, 0, 0, 0)');
    }
    ctx.fillStyle = vignetteGradient;
    ctx.fillRect(0, 0, W, H);

    const t = num(time, 0);
    // 細格線（慢速漂移）
    const stepA = 40;
    const offA = -((t * 14) % stepA);
    const offAy = -((t * 6) % stepA);
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(96, 56, 150, 0.34)';
    ctx.beginPath();
    for (let x = offA; x <= W + stepA; x += stepA) {
      ctx.moveTo(Math.round(x) + 0.5, -32);
      ctx.lineTo(Math.round(x) + 0.5, H + 32);
    }
    for (let y = offAy; y <= H + stepA; y += stepA) {
      ctx.moveTo(-32, Math.round(y) + 0.5);
      ctx.lineTo(W + 32, Math.round(y) + 0.5);
    }
    ctx.stroke();

    // 粗格線（更慢，帶紫光）
    const stepB = 160;
    const offB = -((t * 7) % stepB);
    const offBy = -((t * 3) % stepB);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(150, 96, 226, 0.22)';
    ctx.beginPath();
    for (let x = offB; x <= W + stepB; x += stepB) {
      ctx.moveTo(Math.round(x), -32);
      ctx.lineTo(Math.round(x), H + 32);
    }
    for (let y = offBy; y <= H + stepB; y += stepB) {
      ctx.moveTo(-32, Math.round(y));
      ctx.lineTo(W + 32, Math.round(y));
    }
    ctx.stroke();

    // 斜向暗紋，增加暗世界層次
    ctx.strokeStyle = 'rgba(60, 24, 96, 0.35)';
    ctx.lineWidth = 1;
    const diag = 64;
    const offD = (t * 22) % diag;
    ctx.beginPath();
    for (let i = -H; i <= W + H; i += diag) {
      const x0 = i + offD;
      ctx.moveTo(x0, -32);
      ctx.lineTo(x0 + H * 0.55, H + 32);
    }
    ctx.stroke();
  }

  function drawBackground(state, options) {
    const time = num(state.time, 0);
    const attack = state.attack && typeof state.attack === 'object' ? state.attack : {};
    const settings = attack.settings && typeof attack.settings === 'object' ? attack.settings : {};
    const bgName = typeof settings.background === 'string' ? settings.background : null;

    if (!bgName) {
      if (options.showGrid) drawProceduralBackground(time);
      else {
        ctx.fillStyle = '#000000';
        ctx.fillRect(-32, -32, LOGICAL_WIDTH + 64, LOGICAL_HEIGHT + 64);
      }
      return;
    }

    const frames = spriteFrameCount(bgName);
    let img = null;
    let frameIndex = 0;
    for (let guard = 0; guard < Math.max(1, frames); guard += 1) {
      const idx = (Math.floor(time * 4) + guard) % Math.max(1, frames);
      img = spriteImage(bgName, idx);
      if (img) {
        frameIndex = idx;
        break;
      }
    }

    if (!img) {
      // 有指定背景但素材缺失：退回程序化背景，不畫滿畫面洋紅方塊
      if (options.showGrid) drawProceduralBackground(time);
      else {
        ctx.fillStyle = '#000000';
        ctx.fillRect(-32, -32, LOGICAL_WIDTH + 64, LOGICAL_HEIGHT + 64);
      }
      return;
    }

    const m = spriteMetrics(bgName, img);
    const tileW = Math.max(8, m.w);
    const tileH = Math.max(8, m.h);
    const driftX = -((time * 10) % tileW);
    const driftY = -((time * 4) % tileH);
    ctx.save();
    ctx.beginPath();
    ctx.rect(-32, -32, LOGICAL_WIDTH + 64, LOGICAL_HEIGHT + 64);
    ctx.clip();
    // 官方戰鬥背景 sprite（spr_battlebg_*）多半是透明底 + 白色線條，
    // 直接平鋪會幾乎全黑；先鋪一層暗紫底，平鋪後才有「暗世界格線」的層次。
    ctx.fillStyle = '#0b0418';
    ctx.fillRect(-32, -32, LOGICAL_WIDTH + 64, LOGICAL_HEIGHT + 64);
    // 平鋪時把 sprite 當「白色線條遮罩」上淡紫色，比原白色更接近暗世界背景
    const tile = tintedImage(img, '#6a4fa8') || img;
    for (let y = driftY - tileH; y < LOGICAL_HEIGHT + tileH; y += tileH) {
      for (let x = driftX - tileW; x < LOGICAL_WIDTH + tileW; x += tileW) {
        ctx.drawImage(tile, Math.round(x), Math.round(y), tileW, tileH);
      }
    }
    // 壓暗，讓子彈/靈魂可讀
    ctx.fillStyle = 'rgba(6, 2, 14, 0.42)';
    ctx.fillRect(-32, -32, LOGICAL_WIDTH + 64, LOGICAL_HEIGHT + 64);
    ctx.restore();
    // 背景即時影格索引供除錯：不影響畫面
    void frameIndex;
  }

  /* ---------------------------------------------------------- 敵人 */

  function drawEnemies(state, options) {
    void options;
    const enemies = Array.isArray(state.enemies) ? state.enemies : [];
    for (const enemy of enemies) {
      if (!enemy || typeof enemy !== 'object') continue;
      const scale = num(enemy.scale, 1) || 1;
      let imgW = DEFAULT_SPRITE_W;
      let imgH = DEFAULT_SPRITE_H;
      const entry = spriteEntry(enemy.sprite);
      if (entry) {
        imgW = num(entry.w, imgW) || imgW;
        imgH = num(entry.h, imgH) || imgH;
      }
      const x = num(enemy.x, 0);
      const y = num(enemy.y, 0);
      // 腳下陰影
      ctx.save();
      ctx.globalAlpha = 0.32;
      ctx.fillStyle = '#000000';
      ctx.beginPath();
      ctx.ellipse(x, y + (imgH * scale) / 2 - 2, (imgW * scale) / 3, Math.max(2, (imgH * scale) / 10), 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      drawSprite(enemy.sprite, num(enemy.frame, 0), x, y, {
        scale,
        alpha: num(enemy.alpha, 1),
        color: enemy.color,
        originMode: 'center',
        fallbackW: imgW,
        fallbackH: imgH,
      });
    }
  }

  /* ---------------------------------------------------------- 戰鬥框 */

  function boxMetrics(box) {
    const b = box && typeof box === 'object' ? box : {};
    // 缺值退回與 engine/attack.js 的 BOX_DEFAULTS 一致
    // （SPEC-LAYOUT §5：中心 320,190；內部 144×158；綠描邊 3px）
    return {
      x: num(b.x, BOX_DEFAULT.x),
      y: num(b.y, BOX_DEFAULT.y),
      w: Math.max(1, num(b.w, BOX_DEFAULT.w)),
      h: Math.max(1, num(b.h, BOX_DEFAULT.h)),
      rotation: num(b.rotation, BOX_DEFAULT.rotation),
      border: Math.max(0, num(b.border, BOX_DEFAULT.border)),
      color: colorString(b.color) || BOX_DEFAULT.color,
      ...(b.appearance ? { appearance: b.appearance } : {}),
    };
  }

  function drawBox(state) {
    const b = boxMetrics(state.box);
    if (b.appearance === 'hidden') return b;
    ctx.save();
    ctx.translate(b.x, b.y);
    if (b.rotation) ctx.rotate(b.rotation * DEG);

    const left = -b.w / 2;
    const top = -b.h / 2;

    // 外圈微光（暗世界風格，貼著框邊緣、低透明度）
    ctx.save();
    ctx.globalAlpha = 0.16;
    ctx.strokeStyle = b.color;
    ctx.lineWidth = Math.max(2, b.border);
    ctx.strokeRect(left - b.border, top - b.border, b.w + b.border * 2, b.h + b.border * 2);
    ctx.restore();

    // 黑底
    if (b.appearance !== 'outline' && !state.arena?.fill) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(left, top, b.w, b.h);
    }

    // 描邊（畫在框內側，避免超出框範圍）
    if (b.border > 0) {
      ctx.strokeStyle = b.color;
      ctx.lineWidth = b.border;
      ctx.strokeRect(left + b.border / 2, top + b.border / 2, b.w - b.border, b.h - b.border);
    }
    ctx.restore();
    return b;
  }

  /**
   * 建立戰鬥框裁剪路徑（呼叫端負責 save/restore；clip 一旦建立即固定於裝置空間）。
   *
   * 重要：子彈是用「世界座標」繪製的，所以 clip 建好之後必須把座標系還原回世界座標，
   * 否則 translate(b.x,b.y) 會讓每顆子彈再被平移一次（= 全部飛到框外被裁掉）。
   */
  function clipToBox(b) {
    const rot = (b.rotation || 0) * DEG;
    ctx.translate(b.x, b.y);
    if (rot) ctx.rotate(rot);
    ctx.beginPath();
    ctx.rect(-b.w / 2, -b.h / 2, b.w, b.h);
    ctx.clip();
    // 還原成世界座標：clip 已經固定在裝置空間，不受後續變換影響
    if (rot) ctx.rotate(-rot);
    ctx.translate(-b.x, -b.y);
  }

  function polygonPath(points) {
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) ctx.lineTo(points[i].x, points[i].y);
    ctx.closePath();
  }

  function drawArena(state, box, { fill = true, outline = true } = {}) {
    const fillColor = fill && state.arena?.fill;
    const showOutline = outline && state.arena?.outline;
    if (!showOutline && !fillColor) return;
    const shape = clipShape('arena', box, state.arena);
    ctx.save();
    ctx.strokeStyle = box.color;
    ctx.lineWidth = Math.max(1, box.border);
    if (fillColor) ctx.fillStyle = fillColor;
    if (shape.points) {
      polygonPath(shape.points);
      if (fillColor) {
        ctx.save();
        ctx.globalAlpha *= state.arena.fillAlpha ?? 1;
        ctx.fill();
        ctx.restore();
      }
      if (showOutline) ctx.stroke();
    } else {
      ctx.translate(shape.x, shape.y);
      if (shape.rotation) ctx.rotate(shape.rotation * DEG);
      if (fillColor) {
        ctx.save();
        ctx.globalAlpha *= state.arena.fillAlpha ?? 1;
        ctx.fillRect(-shape.w / 2, -shape.h / 2, shape.w, shape.h);
        ctx.restore();
      }
      if (showOutline) ctx.strokeRect(-shape.w / 2 + 1, -shape.h / 2 + 1, shape.w - 2, shape.h - 2);
    }
    ctx.restore();
  }

  /* ---------------------------------------------------------- 子彈 */

  function bulletDrawOptions(bullet) {
    return {
      scale: num(bullet.scale, 1) || 1,
      alpha: num(bullet.alpha, 1),
      color: bullet.color,
      rotation: num(bullet.rotation, 0),
      originMode: 'auto',
    };
  }

  function drawBullet(bullet) {
    if (!bullet || typeof bullet !== 'object') return;
    const hitbox = bullet.hitbox && typeof bullet.hitbox === 'object' ? bullet.hitbox : null;
    let fallbackW = DEFAULT_SPRITE_W;
    let fallbackH = DEFAULT_SPRITE_H;
    if (hitbox) {
      if (hitbox.shape === 'circle') {
        fallbackW = Math.max(2, num(hitbox.r, 4) * 2);
        fallbackH = fallbackW;
      } else {
        fallbackW = Math.max(2, num(hitbox.w, 8));
        fallbackH = Math.max(2, num(hitbox.h, 8));
      }
    }
    drawSprite(bullet.sprite, num(bullet.frame, 0), num(bullet.x, 0), num(bullet.y, 0), {
      ...bulletDrawOptions(bullet),
      fallbackW,
      fallbackH,
    });
  }

  function drawBullets(state, b) {
    const bullets = Array.isArray(state.bullets) ? state.bullets : [];
    const masked = new Map();

    // 背景投影：先畫非裁切子彈
    for (const bullet of bullets) {
      if (!bullet || typeof bullet !== 'object') continue;
      const target = bulletClip(bullet);
      if (target === 'none') drawBullet(bullet);
      else {
        if (!masked.has(target)) masked.set(target, []);
        masked.get(target).push(bullet);
      }
    }

    for (const [target, group] of masked) {
      const shape = clipShape(target, b, state.arena, state.clipRegion);
      ctx.save();
      if (shape.points) {
        polygonPath(shape.points);
        ctx.clip();
      } else clipToBox(shape);
      for (const bullet of group) drawBullet(bullet);
      ctx.restore();
    }
    for (const shot of state.playerShots ?? []) {
      const speed = Math.hypot(shot.dx, shot.dy);
      ctx.fillStyle = shot.color;
      for (let i = 1; i <= 3; i++) ctx.fillRect(Math.round(shot.x - shot.dx * i * 2 / speed) - 1,
        Math.round(shot.y - shot.dy * i * 2 / speed) - 1, 3, 3);
      ctx.fillStyle = '#fff8d8';
      ctx.fillRect(Math.round(shot.x) - 1, Math.round(shot.y) - 1, 3, 3);
    }
    for (const burst of state.shotBursts ?? []) {
      const age = state.frame - burst.frame;
      const r = age + 3;
      ctx.save();
      ctx.translate(Math.round(burst.x), Math.round(burst.y));
      ctx.globalAlpha *= (8 - age) / 8;
      ctx.fillStyle = burst.color;
      ctx.fillRect(-r - 2, 0, 4, 1); ctx.fillRect(r - 2, 0, 4, 1);
      ctx.fillRect(0, -r - 2, 1, 4); ctx.fillRect(0, r - 2, 1, 4);
      ctx.restore();
    }
  }

  /* ---------------------------------------------------------- 靈魂 */

  function drawSoul(state) {
    const soul = state.soul && typeof state.soul === 'object' ? state.soul : null;
    if (!soul) return;
    if (soul.visible === false) return;

    const x = num(soul.x, LOGICAL_WIDTH / 2);
    const y = num(soul.y, 171);
    const inv = num(soul.invFrames, 0);
    const frame = num(state.frame, 0);
    if (inv > 0) {
      // 受傷無敵幀閃爍：4 幀一循環，亮 2 幀
      if (Math.floor(frame / 2) % 2 === 1) return;
    }

    // 擦彈外框畫在靈魂底下的世界層（跟著震動一起動），與重力/框變換一致。
    drawGrazeRingForSoul(ctx, soul, state, x, y);

    const color = colorString(soul.color) || '#ff0000';
    const look = soul.appearance;
    const rotation = look?.rotate ? num(soul.heading, 0) : num(soul.orient, 0);
    const c = Math.cos(rotation * DEG), s = Math.sin(rotation * DEG);
    const ax = look?.anchorX ?? 0, ay = look?.anchorY ?? 0;
    const px = x - (ax * c - ay * s), py = y - (ax * s + ay * c);
    if (look?.sprite === 'builtin:soul-car') {
      ctx.save();
      ctx.translate(Math.round(px), Math.round(py));
      ctx.rotate(rotation * DEG);
      ctx.fillStyle = '#0e192c';
      for (const xx of [-10, 5]) for (const yy of [-7, 4]) ctx.fillRect(xx, yy, 5, 3);
      ctx.fillStyle = '#192f4f';
      ctx.fillRect(-11, -4, 20, 8);
      ctx.fillStyle = color;
      ctx.fillRect(-9, -5, 16, 10);
      ctx.fillRect(6, -3, 5, 6);
      ctx.fillStyle = '#0b2940';
      ctx.fillRect(-3, -4, 6, 8);
      ctx.fillStyle = '#f7ffff';
      ctx.fillRect(9, -3, 2, 1); ctx.fillRect(9, 2, 2, 1);
      ctx.fillStyle = '#ff4261';
      ctx.fillRect(-10, -3, 2, 1); ctx.fillRect(-10, 2, 2, 1);
      ctx.restore();
      drawSprite('spr_heart', 0, x, y, { color: '#ff4f7a', scale: 0.45, originMode: 'center' });
      return;
    }
    drawSprite(look?.sprite ?? 'spr_heart', 0, px, py, {
      color: look?.sprite ? null : color,
      flatColor: Boolean(look),
      rotation,
      scale: 1,
      alpha: 1,
      originMode: 'center',
      fallbackW: 16,
      fallbackH: 16,
    });
  }

  /* ------------------------------------------------------ hitbox 除錯 */

  function drawHitboxes(state, b) {
    const soul = state.soul && typeof state.soul === 'object' ? state.soul : {};
    const sx = num(soul.x, LOGICAL_WIDTH / 2);
    const sy = num(soul.y, 171);

    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;

    // 戰鬥框
    ctx.strokeStyle = '#00ffff';
    ctx.save();
    ctx.translate(b.x, b.y);
    if (b.rotation) ctx.rotate(b.rotation * DEG);
    ctx.strokeRect(-b.w / 2 - 1.5, -b.h / 2 - 1.5, b.w + 3, b.h + 3);
    ctx.restore();

    // 靈魂 hitbox（r=4）與擦彈範圍（官方心形遮罩的邊緣，= spr_grazeappear 形狀）
    ctx.strokeStyle = '#00ff88';
    ctx.beginPath();
    ctx.arc(sx, sy, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.save();
    ctx.setLineDash([]);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.lineWidth = 1;
    const gx0 = Math.round(sx - GRAZE_MASK.cx);
    const gy0 = Math.round(sy - GRAZE_MASK.cy);
    ctx.beginPath();
    for (let i = 0; i < MASK_EDGE.length; i += 1) {
      const px = gx0 + MASK_EDGE[i][0] + 0.5;
      const py = gy0 + MASK_EDGE[i][1] + 0.5;
      ctx.moveTo(px - 0.5, py - 0.5);
      ctx.lineTo(px + 0.5, py + 0.5);
      ctx.moveTo(px + 0.5, py - 0.5);
      ctx.lineTo(px - 0.5, py + 0.5);
    }
    ctx.stroke();
    ctx.restore();

    // 子彈 hitbox
    const bullets = Array.isArray(state.bullets) ? state.bullets : [];
    const metrics = b || boxMetrics(state.box);
    for (const bullet of bullets) {
      if (!bullet || typeof bullet !== 'object' || bullet.decor) continue;
      if (!pointInClip(bullet, clipShape(bulletClip(bullet), metrics, state.arena, state.clipRegion))) continue;
      const hb = bullet.hitbox && typeof bullet.hitbox === 'object' ? bullet.hitbox : null;
      if (!hb) continue;
      const bx = num(bullet.x, 0);
      const by = num(bullet.y, 0);
      const rot = num(bullet.rotation, 0) * DEG;
      ctx.save();
      ctx.translate(bx, by);
      if (rot) ctx.rotate(rot);
      ctx.strokeStyle = hb.shape === 'circle' ? '#ff4d4d' : '#ffcc00';
      if (hb.shape === 'circle') {
        ctx.beginPath();
        ctx.arc(0, 0, Math.max(0.5, num(hb.r, 4)), 0, Math.PI * 2);
        ctx.stroke();
      } else {
        const w = Math.max(1, num(hb.w, 8));
        const h = Math.max(1, num(hb.h, 8));
        ctx.strokeRect(-w / 2, -h / 2, w, h);
      }
      ctx.restore();
    }
    if (soul.profile) {
      const heading = soul.heading * DEG;
      ctx.setLineDash([]);
      ctx.strokeStyle = '#80ffe6';
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.lineTo(sx + 15 * Math.cos(heading), sy + 15 * Math.sin(heading));
      ctx.stroke();
      const info = [soul.profile + ' · ' + soul.speed.toFixed(1) + ' px/f · ' + Math.round(soul.heading) + '°',
        ...soul.abilities.map((ability) => ability.id + ' ' + (ability.cooldown ? ability.cooldown + 'f' : '✓'))].join(' | ');
      ctx.font = '11px monospace';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      const width = ctx.measureText(info).width + 8;
      const x = Math.max(4, Math.min(LOGICAL_WIDTH - width - 4, sx - width / 2));
      const y = sy < 34 ? sy + 22 : sy - 22;
      ctx.fillStyle = '#0a0a10';
      ctx.fillRect(x, y - 8, width, 16);
      ctx.fillStyle = '#baffed';
      ctx.fillText(info, x + 4, y);
    }
    ctx.restore();
  }


  /* ------------------------------------ 對外：戰鬥層（SPEC-P2 §8 掛鉤） */

  /** 戰鬥框展開補間：0..1 → 0.06..1（ease-out，約 10 幀） */
  function boxAnimScale(value) {
    const k = clamp(num(value, 1), 0, 1);
    if (k >= 1) return 1;
    const inv = 1 - k;
    const eased = 1 - inv * inv * inv;
    return 0.06 + 0.94 * eased;
  }

  /**
   * 繪製「戰鬥框 + 子彈 + 靈魂」這一層（SPEC §5 battle 形狀 / SPEC-P2 §5）。
   * 呼叫端負責：把 ctx 設到 640×480 邏輯座標（含裝置縮放）。
   *
   * @param {{box?:object, bullets?:any[], soul?:object, shake?:{x:number,y:number}}|null} battle
   * @param {{ boxAnim?:number, showHitboxes?:boolean, applyShake?:boolean,
   *           parts?:{box?:boolean,arenaFill?:boolean,bullets?:boolean,soul?:boolean},
   *           spriteScale?:number }} [opts]
   * @returns {{x:number,y:number,w:number,h:number,rotation:number,border:number,color:string}|null}
   */
  function drawBattleLayer(battle, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const state = battle && typeof battle === 'object' ? battle : null;
    if (!state) return null;
    const parts = o.parts && typeof o.parts === 'object' ? o.parts : {};
    const showBox = parts.box !== false;
    const showBullets = parts.bullets !== false;
    const showSoul = parts.soul !== false;
    const applyShake = o.applyShake !== false;
    const shake = applyShake && state.shake && typeof state.shake === 'object' ? state.shake : null;
    const shakeX = shake ? num(shake.x, 0) : 0;
    const shakeY = shake ? num(shake.y, 0) : 0;
    const metrics = boxMetrics(state.box);
    const scale = boxAnimScale(o.boxAnim);
    const scaled = scale < 1;
    // SPEC-LAYOUT §5：展開時整層由 ±90° 收斂到 0（E1 的 state.boxAnimRotation，度）
    const animRotation = num(o.boxRotation, 0);

    const applyTransform = () => {
      if (shakeX || shakeY) ctx.translate(shakeX, shakeY);
      if (scaled || animRotation) {
        ctx.translate(metrics.x, metrics.y);
        if (animRotation) ctx.rotate(animRotation * DEG);
        if (scaled) ctx.scale(scale, scale);
        ctx.translate(-metrics.x, -metrics.y);
      }
    };

    ctx.save();
    applyTransform();
    let drawnBox = metrics;
    if (parts.arenaFill ?? showBox) drawArena(state, drawnBox, { outline: false });
    if (showBox) {
      drawnBox = drawBox(state);
      drawArena(state, drawnBox, { fill: false });
    }
    if (showBullets) drawBullets(state, drawnBox);
    if (showSoul) drawSoul(state);
    ctx.restore();

    if (o.showHitboxes === true) {
      ctx.save();
      applyTransform();
      drawHitboxes(state, drawnBox);
      ctx.restore();
    }
    return drawnBox;
  }

  function destroy() {
    tintCache.clear();
    bgGradient = null;
    vignetteGradient = null;
  }

  return {
    spriteEntry,
    spriteImage,
    spriteFrameCount,
    spriteMetrics,
    tintedImage,
    drawPlaceholder,
    drawSprite,
    drawProceduralBackground,
    drawBackground,
    drawEnemies,
    boxMetrics,
    drawBox,
    drawArena,
    clipToBox,
    drawBullets,
    drawSoul,
    drawHitboxes,
    drawBattleLayer,
    boxAnimScale,
    destroy,
  };
}

/** @type {WeakMap<object, {painter:any, assets:any}>} drawBattleLayer 獨立呼叫用 */
const battlePainters = new WeakMap();

function painterFor(targetCtx, assets) {
  if (!targetCtx || typeof targetCtx !== 'object') return null;
  const cached = battlePainters.get(targetCtx);
  if (cached && cached.assets === assets) return cached.painter;
  const painter = createPainter(targetCtx, assets);
  battlePainters.set(targetCtx, { painter, assets });
  return painter;
}

/**
 * SPEC-P2 §8 掛鉤：把 Phase 1 的「戰鬥框／子彈／靈魂」繪製給遭遇渲染器重用。
 * 不影響 createRenderer 的既有行為。
 *
 * @param {CanvasRenderingContext2D} targetCtx 已設為 640×480 邏輯座標的 context
 * @param {object} battleState SPEC-P2 §5 的 state.battle（或 Phase 1 state）
 * @param {{ assets?:object, boxAnim?:number, showHitboxes?:boolean, applyShake?:boolean,
 *           parts?:{box?:boolean,arenaFill?:boolean,bullets?:boolean,soul?:boolean} }} [opts]
 * @returns {object|null} 畫出的框矩形（box metrics）
 */
export function drawBattleLayer(targetCtx, battleState, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const painter = painterFor(targetCtx, o.assets);
  if (!painter) return null;
  return painter.drawBattleLayer(battleState, o);
}

/**
 * 供 render-encounter / 編輯器重用 sprite 與背景繪製（不影響 Phase 1 行為）。
 * @param {CanvasRenderingContext2D} targetCtx 已設為 640×480 邏輯座標的 context
 * @param {object|null} assets
 */
export function createSpritePainter(targetCtx, assets) {
  const painter = painterFor(targetCtx, assets);
  if (!painter) return null;
  return {
    spriteEntry: painter.spriteEntry,
    spriteMetrics: painter.spriteMetrics,
    spriteFrameCount: painter.spriteFrameCount,
    spriteImage: painter.spriteImage,
    drawSprite: painter.drawSprite,
    drawPlaceholder: painter.drawPlaceholder,
    tintedImage: painter.tintedImage,
    drawProceduralBackground: painter.drawProceduralBackground,
    drawBackground: painter.drawBackground,
    drawEnemies: painter.drawEnemies,
    boxMetrics: painter.boxMetrics,
    drawBox: painter.drawBox,
    clipToBox: painter.clipToBox,
    drawBullets: painter.drawBullets,
    drawSoul: painter.drawSoul,
    drawHitboxes: painter.drawHitboxes,
    drawBattleLayer: painter.drawBattleLayer,
    boxAnimScale: painter.boxAnimScale,
    release() {
      const cached = battlePainters.get(targetCtx);
      if (cached && cached.painter === painter) battlePainters.delete(targetCtx);
    },
  };
}

export function createRenderer(canvas, assets) {
  if (!canvas || typeof canvas.getContext !== 'function') {
    throw new Error('createRenderer 需要一個 canvas 元素');
  }
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('無法取得 canvas 2D context');

  const assetStore = assets && typeof assets === 'object' ? assets : null;

  // 點陣字體（SPEC §7）：把 assets.getFont 接進 drawText 的分辨流程
  let unregisterFontProvider = null;
  if (assetStore && typeof assetStore.getFont === 'function') {
    unregisterFontProvider = registerFontProvider((name) => assetStore.getFont(name));
  }
  // 預熱字體（不阻塞繪製）：第一幀前先開始載入，避免開場幾幀掉回系統字
  if (assetStore && typeof assetStore.preloadFonts === 'function') {
    try {
      const warm = assetStore.preloadFonts([
        FONT_MAIN,
        FONT_MAINBIG,
        FONT_SMALL,
        FONT_MAIN + '@zh',
        FONT_MAINBIG + '@zh',
        OTF_FONT_NAME,
      ]);
      if (warm && typeof warm.catch === 'function') warm.catch(() => {});
    } catch (_err) {
      /* 預熱失敗不影響繪製（drawText 會退回系統字） */
    }
  }

  let destroyed = false;
  let currentScale = 0;

  // 戰鬥層繪製（sprite/背景/框/子彈/靈魂/hitbox）由模組級 painter 提供，
  // 讓 render-encounter 也能重用同一份程式碼（SPEC-P2 §8 最小掛鉤）。
  const painter = createPainter(ctx, assetStore);
  const drawSprite = painter.drawSprite;
  const drawBackground = painter.drawBackground;
  const drawEnemies = painter.drawEnemies;
  const drawBox = painter.drawBox;
  const drawBullets = painter.drawBullets;
  const drawSoul = painter.drawSoul;
  const drawHitboxes = painter.drawHitboxes;
  /* ------------------------------------------------------------ 繪圖核心 */

  /** 目前語言（SPEC §7；由 draw options.lang 設定，預設 zh） */
  let currentLang = 'zh';
  let currentStrings = LANG_STRINGS.zh;

  /** 內部文字繪製：自動帶入目前語言（固定字串表 + 字元退回鏈） */
  function text(str, x, y, opts) {
    const base = opts && typeof opts === 'object' ? opts : {};
    const merged = base.lang === undefined ? { ...base, lang: currentLang } : base;
    return drawText(ctx, str, x, y, merged);
  }

  function applyWorldTransform(shakeX, shakeY) {
    const sx = canvas.width > 0 ? canvas.width / LOGICAL_WIDTH : 1;
    const sy = canvas.height > 0 ? canvas.height / LOGICAL_HEIGHT : 1;
    ctx.setTransform(sx, 0, 0, sy, 0, 0);
    ctx.imageSmoothingEnabled = false;
    ctx.translate(num(shakeX, 0), num(shakeY, 0));
  }

  /* ------------------------------------- 隊伍面板 / TP 條（共用 HUD） */


  /** 隊伍面板列（y365–400）：頭像 + 名字 + HP 小字 + 數值 + HP 條（共用 HUD，新樣式） */
  function drawPartyPanel(state) {
    const party = Array.isArray(state.party) ? state.party : [];
    HUD.drawPartyRow(ctx, painter, party, { lang: currentLang, strings: currentStrings });
  }

  /** TP 條（x40–60 / y50–258）：spr_tplogo 直排 T/P + 橫排數字 + %，MAX 黃色（共用 HUD） */
  function drawTpBar(state) {
    HUD.drawTpBar(ctx, painter, state.tp, { lang: currentLang });
  }

  /* --------------------------------------------------------- 全屏閃光 */

  function drawFlashOverlay(state) {
    const hurt = clamp(num(state.hurtFlash, 0), 0, 1);
    if (hurt <= 0.001) return;

    // 擦彈外框已由 drawBattleLayer → drawSoul → drawGrazeRingForSoul 畫在世界層
    // （跟著靈魂受震動/框變換），這裡只處理受傷的全屏紅光。

    // 受傷：全屏偏紅（邊緣更濃，中央仍可辨識；UI 文字保持可讀）
    if (hurt > 0.001) {
      ctx.save();
      ctx.globalAlpha = hurt * 0.8;
      const grad = ctx.createRadialGradient(
        LOGICAL_WIDTH / 2,
        LOGICAL_HEIGHT / 2,
        80,
        LOGICAL_WIDTH / 2,
        LOGICAL_HEIGHT / 2,
        380,
      );
      grad.addColorStop(0, 'rgba(255, 40, 60, 0.02)');
      grad.addColorStop(0.75, 'rgba(220, 24, 44, 0.18)');
      grad.addColorStop(1, 'rgba(180, 8, 32, 0.42)');
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
      ctx.restore();
    }
  }

  /** 畫面最表層：受傷時輕微紅色疊加（由 state.hurtFlash 驅動） */
  function drawEdgeVignette(state) {
    const hurt = clamp(num(state.hurtFlash, 0), 0, 1);
    if (hurt <= 0.001) return;
    ctx.save();
    ctx.globalAlpha = hurt * 0.65;
    const grad = ctx.createRadialGradient(
      LOGICAL_WIDTH / 2,
      LOGICAL_HEIGHT / 2,
      150,
      LOGICAL_WIDTH / 2,
      LOGICAL_HEIGHT / 2,
      390,
    );
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(120, 0, 16, 0.9)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    ctx.restore();
  }

  /* ----------------------------------------------------------- 對外 */

  function resize(scale) {
    if (destroyed) return currentScale || 1;
    currentScale = setupCanvas(canvas, scale);
    return currentScale;
  }

  function draw(state, options) {
    if (destroyed || !ctx) return;
    if (canvas.width <= 0 || canvas.height <= 0) return;

    const opts = options && typeof options === 'object' ? options : {};
    if (typeof opts.scale === 'number' && Number.isFinite(opts.scale)) {
      const s = clamp(Math.floor(opts.scale), 1, 16);
      if (s !== currentScale) currentScale = setupCanvas(canvas, s);
    } else if (!currentScale) {
      currentScale = setupCanvas(canvas, 1);
    }

    const showGrid = opts.showGrid !== false;
    const showHitboxes = opts.showHitboxes === true;
    // SPEC §7 語言切換（檢視偏好；預設 zh）
    const lang = normalizeLang(opts.lang);
    if (lang !== currentLang || currentStrings !== LANG_STRINGS[lang]) {
      currentLang = lang;
      currentStrings = LANG_STRINGS[lang];
    }
    const view = { showGrid, showHitboxes, lang };

    const safeState = state && typeof state === 'object' ? state : null;
    if (!safeState) {
      // 尚未載入任何狀態：只畫背景
      applyWorldTransform(0, 0);
      drawBackground({ time: 0, attack: null }, view);
      return;
    }

    const shake = safeState.shake && typeof safeState.shake === 'object' ? safeState.shake : null;
    const shakeX = shake ? num(shake.x, 0) : 0;
    const shakeY = shake ? num(shake.y, 0) : 0;

    // 清空（背景會蓋滿，仍先填黑避免透明邊）
    ctx.save();
    applyWorldTransform(0, 0);
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, LOGICAL_WIDTH, LOGICAL_HEIGHT);
    ctx.restore();

    // 世界層（套 shake）
    ctx.save();
    applyWorldTransform(shakeX, shakeY);
    drawBackground(safeState, view);
    painter.drawArena(safeState, painter.boxMetrics(safeState.box), { outline: false });
    drawEnemies(safeState, view);
    const b = drawBox(safeState);
    painter.drawArena(safeState, b, { fill: false });
    drawBullets(safeState, b);
    drawSoul(safeState);
    ctx.restore();

    // UI 層（同樣套 shake，讓整體一起震動）
    // SPEC-LAYOUT §1：362 以下是黑底面板列 + 底部文字區（躲避回合保持空白），
    // 背景只鋪到 y362 —— 與遭遇戰共用同一份 HUD 繪製。
    ctx.save();
    applyWorldTransform(shakeX, shakeY);
    // 順序：先鋪 y≥362 黑底（含震動溢邊）→ 面板列 → TP 條
    //        → 最後才畫 362/402 分隔線（否則會被面板列的黑底蓋掉）
    ctx.save();
    ctx.fillStyle = '#000000';
    ctx.fillRect(-40, PANEL_Y, LOGICAL_WIDTH + 80, LOGICAL_HEIGHT - PANEL_Y + 64);
    ctx.restore();
    drawPartyPanel(safeState);
    drawTpBar(safeState);
    HUD.drawLayoutFrame(ctx, { clearBottom: false, lines: true });
    ctx.restore();

    // 除錯層（SPEC §7 順序：隊伍面板/TP 之後、全屏 hurtFlash 紅光之前）
    if (showHitboxes) {
      ctx.save();
      applyWorldTransform(shakeX, shakeY);
      drawHitboxes(safeState, b);
      ctx.restore();
    }

    // 全屏效果（不震動）
    ctx.save();
    applyWorldTransform(0, 0);
    drawEdgeVignette(safeState);
    drawFlashOverlay(safeState);
    ctx.restore();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    painter.destroy();
    glyphAtlases.clear();
    if (typeof unregisterFontProvider === 'function') {
      unregisterFontProvider();
      unregisterFontProvider = null;
    }
  }

  return {
    draw,
    resize,
    getScale: () => currentScale || 1,
    destroy,
    /** 目前語言（draw options.lang 的最近值） */
    getLang: () => currentLang,
    /** 對外（方便測試/編輯器）：點陣文字繪製與量測 */
    drawText: (targetCtx, text, x, y, opts) => drawText(targetCtx || ctx, text, x, y, opts),
    measureText,
  };
}

export default createRenderer;
