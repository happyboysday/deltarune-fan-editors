/**
 * engine/render-hud.js — 共用 HUD：隊伍面板列 / TP 條 / 分區框（SPEC-LAYOUT §1 §2 §6）
 *
 * 這支被兩邊共用，保證像素一致：
 *   - engine/render-encounter.js（遭遇戰）
 *   - engine/render.js 的 createRenderer（攻擊編輯器預覽、play.html）
 *
 * 純繪製：不 import sim / world，也不 import 遭遇戰邏輯。
 * 座標常數全部來自 engine/encounter/layout.js（純資料，無 import）。
 *
 * 與 render.js 的循環 import 是刻意允許的：這裡只在**呼叫時**讀 drawText/measureText/
 * LANG_STRINGS，模組載入期完全不碰，因此兩種載入順序都安全。
 *
 * 版面（640×480 邏輯像素）：
 *   y 362..364  分隔線（灰）
 *   y 365..400  隊伍面板列：頭像 → 名字（NAME_SCALE）→「HP」小字 → 數值 → HP 條
 *   y 402..404  分隔線（灰）
 *   x  40..60   TP 條（y 50..258）：spr_tplogo 直排 T/P、橫排數字、% ；MAX 時黃色直排
 */

import { LAYOUT } from './encounter/layout.js';
import { drawText, measureText, LANG_STRINGS, normalizeLang } from './render.js';

const W = LAYOUT.VIEW_W; // 640
const H = LAYOUT.VIEW_H; // 480

export const BATTLE_BOTTOM = LAYOUT.BATTLE_AREA_BOTTOM; // 362
export const PANEL_TOP = LAYOUT.PANEL_TOP; // 365
export const PANEL_BOTTOM = LAYOUT.PANEL_BOTTOM; // 400
export const PANEL_HEIGHT = LAYOUT.PANEL_HEIGHT; // 35
export const TEXT_TOP = LAYOUT.TEXT_TOP; // 405
export const TEXT_BOTTOM = LAYOUT.TEXT_BOTTOM; // 480
export const TP_RECT = LAYOUT.TP_BAR; // {x:40,y:50,w:20,h:208}

/**
 * 名字字級：fnt_mainbig 縮 0.87 → ink 高 16（參考幀 KRIS/SUSIE/RALSEI 都是 16）。
 */
export const NAME_SCALE = 0.87;
/**
 * 名字字距：fnt_mainbig 的 advance 是 shift×scale＝14×0.87＝12.2，
 * 參考幀每字前進約 10px → ASCII 每字收緊 2.6px；CJK 不動（中文點陣字身本來就滿）。
 */
export const NAME_SPACING = (ch) => (/^[\x20-\x7e]$/.test(ch) ? -2.6 : 0);

/**
 * 一般列（參考幀 01/05，Kris 格 x0–213）逐像素量測：
 *   頭像 ink x+5…+44 / y373…（40×32）
 *   名字 ink x+51…+93 y377–392（字高 16）
 *   「HP」小字 ink x+110 y386–393
 *   數字 ink 右緣 x+202、y371–381
 *   HP 條 x+128…+203 y386–395（76×10）
 */
export const CELL = {
  avatarDx: 5,
  avatarY: 7,
  avatarW: 40,
  avatarH: 27,
  nameDx: 51,
  nameY: 6, // → ink y377
  nameSpacing: NAME_SPACING,
  hpLabelDx: 110,
  hpLabelGap: 8,
  hpLabelY: 18, // → ink y386
  numbersRightDx: 205,
  numbersReserve: 60, // 斜線(44) + hp 數字(約 16)：名字最遠只能到 numbersRightDx - 此值
  numbersY: 3, // → y368（ink 371）
  numbersSpacing: 0,
  barDx: 128,
  barY: 21, // → y386
  barW: 76,
  barH: 10,
};

/** 選單升起面板（參考幀 02）：面板 x−14 / y327 / 寬 = 一格 / 高 74 */
export const RAISED = {
  dx: -14,
  top: PANEL_TOP - LAYOUT.PANEL_RAISE - 3, // 327
  height: 74,
  avatarDx: 10,
  avatarY: 10,
  avatarW: 41,
  avatarH: 30,
  nameDx: 51,
  nameY: 10,
  nameSpacing: NAME_SPACING,
  hpLabelDx: 116,
  hpLabelGap: 10,
  hpLabelY: 22,
  numbersRightDx: 208,
  numbersReserve: 62,
  numbersY: 6, // 參考幀 02：數字 ink y336–346
  numbersSpacing: 0,
  barDx: 134,
  barY: 23, // → y350
  barW: 74,
  barH: 10,
};

/** HUD 顏色 */
export const HUD_COLORS = Object.freeze({
  separator: '#2b2533',
  separator2: '#1a1620',
  panelBlack: '#000000',
  cellLine: 'rgba(58, 34, 92, 0.6)',
  name: '#ffffff',
  nameDown: '#6a6a72',
  hpLabel: '#e8e4f4',
  hpLabelDown: '#6a6a72',
  hpDigits: '#ffffff',
  hpSlash: '#d8d4e6',
  hpBarTrack: '#241a34',
  hpBarEdge: 'rgba(120,96,168,0.5)',
  hpBarDown: '#4a2a2a',
  downText: '#c04050',
  gold: '#ffff00',
  dim: '#8f88b0',
  white: '#ffffff',
  tpTrack: '#3a0006',
  tpEdge: '#7a4a12',
});

// 狀態列使用官方小頭像，與對話用的 spr_face_* 分開。
export const AVATAR_SPRITES = Object.freeze({
  kris: 'spr_headkris',
  susie: 'spr_headsusie',
  ralsei: 'spr_headralsei',
});

// 官方指令圖示（包括灰階等變體）只用於指令列。
const COMMAND_ICON = /^spr_(?:btfight|btact|bttech|btitem|btspare|btdefend)(?:_|$)/i;

/** 沒給 actor/sprite 時，用戰鬥精靈的頭部當頭像（攻擊檔只有 name/hp/color/icon） */
export const PARTY_IDLE_SPRITES = Object.freeze({
  kris: 'spr_krisb_idle',
  susie: 'spr_susieb_idle',
  ralsei: 'spr_ralseib_idle',
  noelle: 'spr_noelleb_idle',
});

/* ------------------------------------------------------------ 小工具 */

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

function stringsOf(lang) {
  const table = LANG_STRINGS && typeof LANG_STRINGS === 'object' ? LANG_STRINGS : null;
  if (!table) return {};
  return table[normalizeLang(lang)] || table.zh || {};
}

/* ------------------------------------------------------ 繪圖小工具 */

function fillRect(ctx, x, y, w, h, color, alpha) {
  if (!(w > 0) || !(h > 0)) return;
  ctx.save();
  if (alpha !== undefined) ctx.globalAlpha *= clamp(num(alpha, 1), 0, 1);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

function strokeRect(ctx, x, y, w, h, color, lineWidth) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(0.5, num(lineWidth, 1));
  ctx.strokeRect(x + 0.5, y + 0.5, Math.max(0, w - 1), Math.max(0, h - 1));
  ctx.restore();
}

/** 點陣字（自動帶入語言） */
function text(ctx, str, x, y, opts, lang) {
  const base = opts && typeof opts === 'object' ? opts : {};
  const merged = base.lang === undefined ? { ...base, lang } : base;
  return drawText(ctx, str, x, y, merged);
}

function textWidth(str, opts, lang) {
  try {
    return measureText(str, {
      font: (opts && opts.font) || 'fnt_main',
      lang,
      scale: (opts && opts.scale) || 1,
      size: opts && opts.size,
    }).width;
  } catch (_err) {
    return String(str == null ? '' : str).length * 7;
  }
}

/**
 * 帶字距的點陣字（DELTARUNE 面板名字／TP 標籤的寬字距寫法）。
 * spacing 可為數字（固定）或 function(ch) → 數字（ASCII 收緊、CJK 不收）。
 */
export function textSpaced(ctx, str, x, y, opts, spacing, lang) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const s = String(str == null ? '' : str);
  const fixed = typeof spacing === 'function' ? 0 : num(spacing, 0);
  let cursor = num(x, 0);
  for (const ch of s) {
    text(ctx, ch, cursor, y, o, lang);
    cursor += textWidth(ch, o, lang) + (typeof spacing === 'function' ? num(spacing(ch), 0) : fixed);
  }
  return cursor - num(x, 0);
}

/** 帶字距的文字寬度 */
export function spacedWidth(str, opts, spacing, lang) {
  const s = String(str == null ? '' : str);
  if (!s) return 0;
  const fixed = typeof spacing === 'function' ? 0 : num(spacing, 0);
  let w = 0;
  let lastGap = 0;
  for (const ch of s) {
    lastGap = typeof spacing === 'function' ? num(spacing(ch), 0) : fixed;
    w += textWidth(ch, opts, lang) + lastGap;
  }
  return Math.max(0, w - lastGap);
}

/** 細長條（HP / MERCY 小條） */
export function drawBar(ctx, x, y, w, h, pct, color, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const ratio = clamp(num(pct, 0), 0, 1);
  fillRect(ctx, Math.round(x) - 1, Math.round(y) - 1, Math.round(w) + 2, Math.round(h) + 2, 'rgba(0,0,0,0.85)');
  fillRect(ctx, Math.round(x), Math.round(y), Math.round(w), Math.round(h), colorString(o.track) || '#1c1428');
  const fillW = Math.round(w * ratio);
  if (fillW > 0) fillRect(ctx, Math.round(x), Math.round(y), fillW, Math.round(h), color || HUD_COLORS.hpBarDown);
}

/* -------------------------------------------------------- 分區框 */

/**
 * 分區框（SPEC-LAYOUT §1）：y ≥ 362 全黑（背景只鋪 0–362），
 * 並在 362 / 402 各畫兩道細灰線。
 * opts.clearBottom !== false → 先鋪黑；opts.lines !== false → 畫分隔線。
 */
export function drawLayoutFrame(ctx, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  if (o.clearBottom !== false) {
    fillRect(ctx, 0, BATTLE_BOTTOM, W, H - BATTLE_BOTTOM, HUD_COLORS.panelBlack);
  }
  if (o.lines !== false) {
    fillRect(ctx, 0, BATTLE_BOTTOM, W, 2, HUD_COLORS.separator);
    fillRect(ctx, 0, BATTLE_BOTTOM + 2, W, 1, HUD_COLORS.separator2);
    fillRect(ctx, 0, TEXT_TOP - 3, W, 2, HUD_COLORS.separator);
    fillRect(ctx, 0, TEXT_TOP - 1, W, 1, HUD_COLORS.separator2);
  }
}

/* ---------------------------------------------------- 面板格子 */

/** 依隊伍人數切出面板格子（SPEC-LAYOUT §6） */
export function panelCells(count) {
  const n = Math.max(1, Math.min(4, Math.round(num(count, 1))));
  const cells = [];
  if (n >= 3) {
    // 3~4 人：整列平分
    const cw = W / n;
    for (let i = 0; i < n; i += 1) {
      cells.push({ index: i, left: Math.round(cw * i), width: Math.round(cw), right: Math.round(cw * (i + 1)) });
    }
    return cells;
  }
  // 1~2 人：靠中間（SPEC-LAYOUT §6 例：x107–318 / x340–555）
  const cw = 211;
  const left0 = n === 2 ? LAYOUT.PANEL_MARGIN : Math.round((W - cw) / 2);
  for (let i = 0; i < n; i += 1) {
    const left = left0 + i * (cw + LAYOUT.PANEL_GAP);
    cells.push({ index: i, left, width: cw, right: left + cw });
  }
  return cells;
}

/* ------------------------------------------------------- 頭像 */

/**
 * 頭部取景：用 alpha 掃描找出精靈的可見邊界，取上緣 55% 作為「頭」，
 * 再以該區的水平重心為中心、取近似正方形（供面板 40×32 頭像 contain）。
 * 無 canvas/document（Node 測試）時回 null，呼叫端退回比例裁切。
 */
const headCropCache = new Map();
export function headCropOf(img, sw, sh) {
  if (!img || !(sw > 0) || !(sh > 0)) return null;
  if (headCropCache.has(img)) return headCropCache.get(img);
  let out = null;
  try {
    if (typeof document !== 'undefined' && document.createElement) {
      const c = document.createElement('canvas');
      c.width = sw;
      c.height = sh;
      const cctx = c.getContext && c.getContext('2d');
      if (cctx) {
        cctx.drawImage(img, 0, 0);
        const data = cctx.getImageData(0, 0, sw, sh).data;
        let minX = sw;
        let maxX = -1;
        let minY = sh;
        let maxY = -1;
        for (let py = 0; py < sh; py += 1) {
          for (let px = 0; px < sw; px += 1) {
            if (data[(py * sw + px) * 4 + 3] > 24) {
              if (px < minX) minX = px;
              if (px > maxX) maxX = px;
              if (py < minY) minY = py;
              if (py > maxY) maxY = py;
            }
          }
        }
        if (maxX >= minX && maxY >= minY) {
          const bodyH = maxY - minY + 1;
          const headH = Math.max(7, Math.round(bodyH * 0.55));
          // 頭部區的重心
          let sum = 0;
          let count = 0;
          const headEnd = Math.min(sh, minY + headH);
          for (let py = minY; py < headEnd; py += 1) {
            for (let px = 0; px < sw; px += 1) {
              if (data[(py * sw + px) * 4 + 3] > 24) {
                sum += px;
                count += 1;
              }
            }
          }
          const cx = count > 8 ? sum / count : (minX + maxX) / 2;
          // 面板頭像比例約 1.25:1（參考幀 41×30）→ 取頭部高度 1.35 倍的寬度
          const side = Math.min(sw, Math.max(headH, Math.round(headH * 1.35)));
          let sx = Math.round(cx - side / 2);
          const sy = Math.max(0, minY - 1);
          sx = Math.max(0, Math.min(sw - 1, sx));
          const cw = Math.max(4, Math.min(side, sw - sx));
          const chh = Math.max(4, Math.min(headH + 2, sh - sy));
          out = { sx, sy, sw: cw, sh: chh };
        }
      }
    }
  } catch (_e) {
    out = null;
  }
  if (headCropCache.size > 64) headCropCache.clear();
  headCropCache.set(img, out);
  return out;
}

/**
 * 面板頭像：自訂或官方頭像 → 待機精靈的第一幀頭部 → 角色色方塊 + 首字母。
 */
export function drawAvatar(ctx, painter, member, actor, x, y, w, h, lang) {
  const { name, color, icon } = member;
  const keys = [member.id, actor?.id, name].map((key) => String(key || '').toLowerCase());
  const official = keys.map((key) => AVATAR_SPRITES[key]).find(Boolean);
  for (const portrait of [icon, official]) {
    if (!portrait || COMMAND_ICON.test(portrait)) continue;
    const pImg = painter.spriteImage(portrait, 0);
    if (pImg) {
      const pm = painter.spriteMetrics(portrait, pImg);
      const k = Math.min(w / Math.max(1, pm.w), h / Math.max(1, pm.h));
      const dw = Math.max(1, Math.round(pm.w * k));
      const dh = Math.max(1, Math.round(pm.h * k));
      ctx.save();
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(pImg, Math.round(x + (w - dw) / 2), Math.round(y + (h - dh) / 2), dw, dh);
      ctx.restore();
      return;
    }
  }

  const spriteName = actor?.idleSprite || keys.map((key) => PARTY_IDLE_SPRITES[key]).find(Boolean);
  const img = spriteName && !COMMAND_ICON.test(spriteName) ? painter.spriteImage(spriteName, 0) : null;
  if (img) {
    const m = painter.spriteMetrics(spriteName, img);
    const sw = Math.max(1, m.w);
    const sh = Math.max(1, m.h);
    const crop =
      headCropOf(img, sw, sh) ||
      (() => {
        // 退回：精靈最上面 52%，中心用索引 ox
        const srcH = Math.max(8, Math.round(sh * 0.52));
        const srcW = Math.min(sw, Math.max(8, Math.round(srcH * 1.15)));
        const centerX = Number.isFinite(m.ox) && m.ox > 0 && m.ox < sw ? m.ox : sw / 2;
        return { sx: clamp(Math.round(centerX - srcW / 2), 0, Math.max(0, sw - srcW)), sy: 0, sw: srcW, sh: srcH };
      })();
    const k = Math.min(w / crop.sw, h / crop.sh);
    const dw = Math.max(1, Math.round(crop.sw * k));
    const dh = Math.max(1, Math.round(crop.sh * k));
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      img,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      Math.round(x + (w - dw) / 2),
      Math.round(y + (h - dh) / 2),
      dw,
      dh,
    );
    ctx.restore();
    return;
  }

  // 佔位：角色色方塊 + 首字母
  fillRect(ctx, x, y, w, h, 'rgba(0,0,0,0.6)');
  strokeRect(ctx, x, y, w, h, color || HUD_COLORS.dim, 1);
  text(ctx, String(name || '?').slice(0, 1).toUpperCase(), x + w / 2, y + h / 2, {
    font: 'fnt_main',
    color: color || HUD_COLORS.white,
    align: 'center',
    baseline: 'middle',
  }, lang);
}

/* ------------------------------------------------- 面板文字（名字/HP） */

/**
 * 面板中的名字 + 「HP」小字 + 數字 + HP 條（SPEC-LAYOUT §6，位置逐像素量測）。
 * panel: {left, top, width}；raised 決定用 CELL 還是 RAISED 那組偏移。
 */
export function drawCellText(ctx, painter, member, panel, color, down, raised, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const lang = normalizeLang(o.lang);
  const strings = o.strings && typeof o.strings === 'object' ? o.strings : stringsOf(lang);
  const m = member && typeof member === 'object' ? member : {};
  const name = typeof m.name === 'string' && m.name ? m.name : '???';
  const hp = Math.max(0, num(m.hp, 0));
  const maxHp = Math.max(1, num(m.maxHp, Math.max(1, hp)));
  const L = raised ? RAISED : CELL;
  const top = raised ? panel.top : PANEL_TOP;
  const nameColor = down ? HUD_COLORS.nameDown : HUD_COLORS.name;

  // 名字（大寫）。中文名太長才縮字級 / 截斷；英文 6 字母維持參考幀字級。
  const shown = name === name.toUpperCase() ? name : name.toUpperCase();
  const nameOpts = { font: 'fnt_mainbig', scale: NAME_SCALE, color: nameColor, baseline: 'top' };
  // 可用寬度 = 到「HP」小字的預設位置為止（HP 小字會自己往右讓，但不得壓到 HP 條）
  const nameAvail = Math.max(32, L.hpLabelDx - L.nameDx - 2);
  let nameText = shown;
  let nameW = spacedWidth(nameText, nameOpts, L.nameSpacing, lang);
  if (nameW > nameAvail) {
    const fitScale = Math.max(0.62, (NAME_SCALE * nameAvail) / nameW);
    nameOpts.scale = Math.round(fitScale * 100) / 100;
    nameW = spacedWidth(nameText, nameOpts, L.nameSpacing, lang);
  }
  if (nameW > nameAvail) {
    const chars = Array.from(nameText);
    while (chars.length > 1 && spacedWidth(chars.join('') + '…', nameOpts, L.nameSpacing, lang) > nameAvail) {
      chars.pop();
    }
    nameText = chars.join('') + '…';
    nameW = spacedWidth(nameText, nameOpts, L.nameSpacing, lang);
  }
  textSpaced(ctx, nameText, panel.left + L.nameDx, top + L.nameY, nameOpts, L.nameSpacing, lang);

  // 「HP」小字：落在名字右側，但硬上限在 HP 條左緣之前
  const hpLabelX =
    panel.left + Math.min(L.barDx - 18, Math.max(L.hpLabelDx, L.nameDx + nameW + L.hpLabelGap));
  text(ctx, strings.hp == null ? 'HP' : strings.hp, hpLabelX, top + L.hpLabelY, {
    font: 'fnt_tinynoelle',
    scale: 1.35,
    color: down ? HUD_COLORS.hpLabelDown : HUD_COLORS.hpLabel,
    baseline: 'top',
  }, lang);

  const rightX = panel.left + L.numbersRightDx;
  if (down) {
    text(ctx, strings.down == null ? 'DOWN' : strings.down, rightX, top + L.numbersY + 2, {
      font: 'fnt_main',
      color: HUD_COLORS.downText,
      align: 'right',
      baseline: 'top',
    }, lang);
    return;
  }

  // 數字「90/ 90」：hp 數字 + 手繪粗斜線 + max（點陣字沒有 12 寬的粗斜線）
  const numOpts = { font: 'fnt_dotumche', scale: 0.88 };
  const gap = L.numbersSpacing;
  const hpStr = String(Math.round(hp));
  const maxStr = String(Math.round(maxHp));
  const numY = top + L.numbersY;
  const maxW = spacedWidth(maxStr, numOpts, gap, lang);
  textSpaced(ctx, maxStr, rightX - maxW, numY, { ...numOpts, color: HUD_COLORS.hpDigits, baseline: 'top' }, gap, lang);

  const slashLeft = rightX - 44;
  ctx.save();
  ctx.fillStyle = HUD_COLORS.hpSlash;
  ctx.beginPath();
  ctx.moveTo(slashLeft + 1, numY + 12);
  ctx.lineTo(slashLeft + 11, numY);
  ctx.lineTo(slashLeft + 13, numY);
  ctx.lineTo(slashLeft + 3, numY + 12);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  const hpW = spacedWidth(hpStr, numOpts, gap, lang);
  textSpaced(ctx, hpStr, slashLeft - 1 - hpW, numY, { ...numOpts, color: HUD_COLORS.hpDigits, baseline: 'top' }, gap, lang);

  // HP 條（角色色）
  const barX = panel.left + L.barDx;
  const barY = top + L.barY;
  drawBar(ctx, barX, barY, L.barW, L.barH, hp / maxHp, down ? HUD_COLORS.hpBarDown : color, {
    track: HUD_COLORS.hpBarTrack,
  });
  strokeRect(ctx, barX - 1, barY - 1, L.barW + 2, L.barH + 2, HUD_COLORS.hpBarEdge, 1);
}

/**
 * 一格面板（一般列）：頭像 → 名字/HP → 格線。
 * opts: {lang, actor, strings, last}
 */
export function drawPartyCell(ctx, painter, cell, member, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const lang = normalizeLang(o.lang);
  const m = member && typeof member === 'object' ? member : {};
  const color = colorString(m.color) || HUD_COLORS.white;
  const hp = Math.max(0, num(m.hp, 0));
  const down = m.down === true || hp <= 0;
  const actor = o.actor && typeof o.actor === 'object' ? o.actor : null;

  drawAvatar(ctx, painter, m, actor, cell.left + CELL.avatarDx, PANEL_TOP + CELL.avatarY, CELL.avatarW, CELL.avatarH, lang);
  drawCellText(ctx, painter, m, cell, color, down, false, { lang, strings: o.strings });

  if (o.last !== true) {
    fillRect(ctx, cell.right, PANEL_TOP + 6, 1, PANEL_HEIGHT - 10, HUD_COLORS.cellLine);
  }
}

/**
 * 整列隊伍面板（一般列，不含選單升起面板）。
 * party: [{name, hp, maxHp, color, icon}]
 * opts: {lang, strings, actors: Map<id, actor> | Array}
 */
export function drawPartyRow(ctx, painter, party, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const lang = normalizeLang(o.lang);
  const list = Array.isArray(party) ? party : [];
  fillRect(ctx, 0, BATTLE_BOTTOM, W, H - BATTLE_BOTTOM, HUD_COLORS.panelBlack);
  if (!list.length) return;
  const cells = panelCells(list.length);
  const actors = o.actors instanceof Map ? o.actors : null;
  const actorList = Array.isArray(o.actors) ? o.actors : null;

  for (let i = 0; i < list.length; i += 1) {
    const member = list[i] && typeof list[i] === 'object' ? list[i] : {};
    const cell = cells[i];
    if (!cell) continue;
    const actor = actors?.get(member.actor || member.id) || actorList?.[i];
    drawPartyCell(ctx, painter, cell, member, { lang, actor, strings: o.strings, last: i === list.length - 1 });
  }
}

/* ---------------------------------------------------------- TP 條 */

/**
 * TP 條（SPEC-LAYOUT §2）：直立條 x40–60 / y50–258、深紅底、橙色填充由下往上、頂端斜切；
 * 標籤在條左側：官方 spr_tplogo 的 T/P 直排 → 數字橫排一行 →「%」；MAX 時黃色直排 MAX。
 */
export function drawTpBar(ctx, painter, tpValue, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const lang = normalizeLang(o.lang);
  const tp = clamp(num(tpValue, 0), 0, 100);
  const { x, y, w, h } = TP_RECT;
  const right = x + w;
  const bottom = y + h;
  const slant = 7;

  const path = () => {
    ctx.beginPath();
    ctx.moveTo(x, y + slant);
    ctx.lineTo(right, y);
    ctx.lineTo(right, bottom - slant);
    ctx.lineTo(x, bottom);
    ctx.closePath();
  };

  // 深紅底
  ctx.save();
  ctx.fillStyle = HUD_COLORS.tpTrack;
  path();
  ctx.fill();
  ctx.restore();

  // 橙色填充（由下往上，斜切邊留 3px 內縮）
  const fillMax = h - slant * 2;
  const fillH = Math.round(fillMax * (tp / 100));
  if (fillH > 0) {
    const isMaxFill = tp >= 99.5;
    ctx.save();
    path();
    ctx.clip();
    const grad = ctx.createLinearGradient(0, bottom, 0, y);
    if (isMaxFill) {
      grad.addColorStop(0, '#ffd400');
      grad.addColorStop(0.5, '#ffe14a');
      grad.addColorStop(1, '#fff08a');
    } else {
      grad.addColorStop(0, '#ff6a00');
      grad.addColorStop(0.55, '#ff9a2e');
      grad.addColorStop(1, '#ffc45a');
    }
    ctx.fillStyle = grad;
    if (isMaxFill) {
      // MAX：整條填滿（含頂端斜切的楔形；原本停在 y+11，頂上留一塊深紅）
      ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    } else {
      ctx.fillRect(x - 2, bottom - 3 - fillH, w + 4, fillH + 4);
    }
    ctx.restore();
  }

  // 邊框
  ctx.save();
  ctx.strokeStyle = HUD_COLORS.tpEdge;
  ctx.lineWidth = 2;
  path();
  ctx.stroke();
  ctx.restore();

  // ── 左側 TP 標籤（逐像素量測參考幀 01/06/08）──
  const labelCX = 19.5;
  const isMax = tp >= 99.5;
  const shownTp = Math.round(tp);

  const drawTpLogo = () => {
    // 官方 spr_tplogo（22×44：上半 T、下半 P）；缺圖時退回點陣字
    const img = typeof painter.spriteImage === 'function' ? painter.spriteImage('spr_tplogo', 0) : null;
    if (!img) {
      text(ctx, 'T', labelCX, y + 30, { font: 'fnt_mainbig', scale: 0.85, color: HUD_COLORS.white, align: 'center', baseline: 'top' }, lang);
      text(ctx, 'P', labelCX, y + 50, { font: 'fnt_mainbig', scale: 0.85, color: HUD_COLORS.white, align: 'center', baseline: 'top' }, lang);
      return;
    }
    // 點陣圖非整數縮小會糊掉邊緣（22→18 實測 ink 只剩 14 寬）→ 維持 1:1 原生尺寸
    const destX = Math.round(labelCX - 12); // 參考幀 ink 起 x10（原生 sprite ink 起 x2）
    ctx.save();
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0, 22, 22, destX, 79, 22, 22); // T：ink 起 y86
    ctx.drawImage(img, 0, 22, 22, 22, destX, 103, 22, 22); // P：ink 起 y106
    ctx.restore();
  };
  drawTpLogo();

  // fnt_mainbig 的 cell 高 26、字形 ink 由 cell 頂端數來 8px → drawText 的 y = 目標 - 8*scale
  const inkOffset = (scale) => 8 * scale;

  if (isMax) {
    // 黃色 MAX 直排（參考幀 08：ink 20 高、行距 22.5、每行右移約 3.5px → 斜排感）
    const letters = ['M', 'A', 'X'];
    const letterScale = 1.1;
    for (let i = 0; i < letters.length; i += 1) {
      text(ctx, letters[i], labelCX - 2 + i * 3.5, y + 81 + i * 22.5 - inkOffset(letterScale), {
        font: 'fnt_mainbig',
        scale: letterScale,
        color: HUD_COLORS.gold,
        align: 'center',
        baseline: 'top',
      }, lang);
    }
  } else {
    // 數字橫排一行（參考幀 01/06：ink y130–149、x8–33；fnt_mainbig scale 1 → 「16」正好 26 寬）
    text(ctx, String(shownTp), labelCX + 2, y + 80 - inkOffset(1), {
      font: 'fnt_mainbig',
      scale: 1,
      color: HUD_COLORS.white,
      align: 'center',
      baseline: 'top',
    }, lang);
    // % 下一行（參考幀：ink y158–177、x13–26）
    text(ctx, '%', labelCX + 1, y + 108 - inkOffset(1), {
      font: 'fnt_mainbig',
      scale: 1,
      color: HUD_COLORS.white,
      align: 'center',
      baseline: 'top',
    }, lang);
  }
}

export default {
  BATTLE_BOTTOM,
  PANEL_TOP,
  PANEL_BOTTOM,
  PANEL_HEIGHT,
  TEXT_TOP,
  TEXT_BOTTOM,
  TP_RECT,
  NAME_SCALE,
  NAME_SPACING,
  CELL,
  RAISED,
  HUD_COLORS,
  AVATAR_SPRITES,
  PARTY_IDLE_SPRITES,
  panelCells,
  drawLayoutFrame,
  drawPartyRow,
  drawPartyCell,
  drawCellText,
  drawAvatar,
  drawBar,
  drawTpBar,
  textSpaced,
  spacedWidth,
  headCropOf,
};
