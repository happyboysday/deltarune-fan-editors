#!/usr/bin/env node
/**
 * tools/gen-graze-mask.mjs — 從官方 spr_grazemask.png 產生 engine/graze-mask.js（零外部依賴）
 *
 * 為什麼需要這支腳本：
 *   引擎（含 headless 模擬）不可在執行期讀 PNG，擦彈判定必須是內嵌的決定性資料。
 *   這支腳本把官方心形遮罩壓成每列的 span 表，寫進 engine/graze-mask.js。
 *
 * PNG 解碼：
 *   只用 Node 內建 `node:zlib`。支援 8-bit、非交錯、color type 0/2/3/4/6
 *   （spr_grazemask.png 是 8-bit RGBA = color type 6、50×50）。
 *
 * 兩份資料：
 *   1. MASK_SOURCE_ROWS  官方 50×50 原始遮罩（ch1–ch4 位元完全相同；以 ch2 為準）
 *   2. MASK_ROWS / MASK_EDGE  實際使用的 25×25 遮罩
 *
 * 為什麼實際用 25×25：
 *   - 官方 spr_grazeappear.png（50×50，1px 外框）與 50×50 遮罩的邊緣像素「完全一致」
 *     （142 px，逐點相同），所以外框就是遮罩的輪廓。
 *   - ch4 另外提供現成的 spr_grazemask_small（25×25）與 spr_grazeappear_small（26×26）；
 *     25×25 與把 50×50 做 2×2 多數決降採樣只差 1 個像素 → 官方遊戲就是用半尺寸的遮罩。
 *   - 影片實測（DeltaruneBossFightSpeedRun.mp4，1080p、靈魂 16×16 在畫面上約 40 px）：
 *     擦彈外框外緣直徑約 29–30 遊戲像素 ≈ 25 遮罩 + 1px 外框，與 1:1 的 50 px 明顯不符。
 *   因此 50×50 是「素材解析度」、25×25 才是「遊戲像素解析度」。
 *
 * 用法：
 *   node tools/gen-graze-mask.mjs            # 重產 engine/graze-mask.js
 *   node tools/gen-graze-mask.mjs --check    # 只檢查現有檔案是否與 PNG 一致（不寫檔）
 *
 * 素材路徑：assets-official/01-official/sprites/<ch>/all_sprites/spr_grazemask.png
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const BATTLE_EDITOR = resolve(HERE, '..');
const REPO = resolve(BATTLE_EDITOR, '..');
const SPRITE_ROOT = join(REPO, 'assets-official', '01-official', 'sprites');
const OUT_FILE = join(BATTLE_EDITOR, 'engine', 'graze-mask.js');
const CHAPTERS = ['ch1', 'ch2', 'ch3', 'ch4', 'ch5'];
const REFERENCE_CHAPTER = 'ch2';

/* ===================================================================== */
/* PNG 解碼（只依賴 node:zlib）                                           */
/* ===================================================================== */

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/** 讀 PNG → { width, height, rgba: Uint8Array } */
function decodePng(buffer) {
  for (let i = 0; i < 8; i += 1) {
    if (buffer[i] !== PNG_SIG[i]) throw new Error('不是 PNG（簽章不符）');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  let palette = null;
  let trns = null;
  const idat = [];
  while (pos + 8 <= buffer.length) {
    const len = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = Buffer.from(data);
    } else if (type === 'tRNS') {
      trns = Buffer.from(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }
  if (bitDepth !== 8) throw new Error(`只支援 8-bit PNG（實際 ${bitDepth}）`);
  if (interlace !== 0) throw new Error('不支援交錯式 PNG');
  if (colorType !== 0 && colorType !== 2 && colorType !== 3 && colorType !== 4 && colorType !== 6) {
    throw new Error(`不支援的 PNG color type ${colorType}`);
  }
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType];
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  let off = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[off];
    off += 1;
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x += 1) line[x] = raw[off + x];
    off += stride;
    // 反濾波（PNG spec §9）
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = line[x];
      if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v = (v + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255;
      } else if (filter !== 0) {
        throw new Error(`未知的 PNG filter ${filter}`);
      }
      line[x] = v;
    }
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      if (colorType === 6) {
        out[o] = line[x * 4];
        out[o + 1] = line[x * 4 + 1];
        out[o + 2] = line[x * 4 + 2];
        out[o + 3] = line[x * 4 + 3];
      } else if (colorType === 2) {
        out[o] = line[x * 3];
        out[o + 1] = line[x * 3 + 1];
        out[o + 2] = line[x * 3 + 2];
        out[o + 3] = 255;
      } else if (colorType === 0) {
        out[o] = out[o + 1] = out[o + 2] = line[x];
        out[o + 3] = 255;
      } else if (colorType === 4) {
        out[o] = out[o + 1] = out[o + 2] = line[x * 2];
        out[o + 3] = line[x * 2 + 1];
      } else {
        const idx = line[x];
        out[o] = palette[idx * 3];
        out[o + 1] = palette[idx * 3 + 1];
        out[o + 2] = palette[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev = line;
  }
  return { width, height, rgba: out };
}

/* ===================================================================== */
/* 遮罩處理                                                               */
/* ===================================================================== */

/** PNG → 二值遮罩 { w, h, m }（alpha > 127 視為實心） */
function alphaMask(png, threshold = 127) {
  const { width, height, rgba } = png;
  const m = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i += 1) m[i] = rgba[i * 4 + 3] > threshold ? 1 : 0;
  return { w: width, h: height, m };
}

/** 2×2 多數決降採樣（4 個子像素中 ≥2 個實心 → 實心） */
function downsample2(mask) {
  const w = mask.w >> 1;
  const h = mask.h >> 1;
  const m = new Uint8Array(w * h);
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      const n =
        mask.m[2 * y * mask.w + 2 * x] +
        mask.m[2 * y * mask.w + 2 * x + 1] +
        mask.m[(2 * y + 1) * mask.w + 2 * x] +
        mask.m[(2 * y + 1) * mask.w + 2 * x + 1];
      m[y * w + x] = n >= 2 ? 1 : 0;
    }
  }
  return { w, h, m };
}

/** 遮罩 → 每列 span（[x0, x1] 含頭尾；空列 = []） */
function toSpans(mask) {
  const rows = [];
  for (let y = 0; y < mask.h; y += 1) {
    const spans = [];
    let start = -1;
    for (let x = 0; x < mask.w; x += 1) {
      const solid = mask.m[y * mask.w + x] === 1;
      if (solid && start < 0) start = x;
      if (!solid && start >= 0) {
        spans.push([start, x - 1]);
        start = -1;
      }
    }
    if (start >= 0) spans.push([start, mask.w - 1]);
    rows.push(spans);
  }
  return rows;
}

/** 遮罩 → 邊緣像素（四鄰居有任一邊非實心；= 官方 spr_grazeappear 的定義） */
function edgePixels(mask) {
  const solid = (y, x) => y >= 0 && y < mask.h && x >= 0 && x < mask.w && mask.m[y * mask.w + x] === 1;
  const px = [];
  for (let y = 0; y < mask.h; y += 1) {
    for (let x = 0; x < mask.w; x += 1) {
      if (!solid(y, x)) continue;
      if (!solid(y, x - 1) || !solid(y, x + 1) || !solid(y - 1, x) || !solid(y + 1, x)) px.push([x, y]);
    }
  }
  return px;
}

function area(mask) {
  let n = 0;
  for (let i = 0; i < mask.m.length; i += 1) n += mask.m[i];
  return n;
}

/** 兩份遮罩是否逐位元相同 */
function sameMask(a, b) {
  if (a.w !== b.w || a.h !== b.h) return false;
  for (let i = 0; i < a.m.length; i += 1) if (a.m[i] !== b.m[i]) return false;
  return true;
}

/* ===================================================================== */
/* 讀官方素材                                                             */
/* ===================================================================== */

function loadReference() {
  const variants = [];
  for (const ch of CHAPTERS) {
    const path = join(SPRITE_ROOT, ch, 'all_sprites', 'spr_grazemask.png');
    try {
      const png = decodePng(readFileSync(path));
      variants.push({ ch, path, png, mask: alphaMask(png) });
    } catch (err) {
      if (ch === REFERENCE_CHAPTER) console.warn(`讀不到 ${ch}/spr_grazemask.png：${err.message}`);
    }
  }
  const ref = variants.find((v) => v.ch === REFERENCE_CHAPTER) || variants[0];
  if (!ref) throw new Error('找不到 spr_grazemask.png（assets-official 未解包？）');

  const identical = variants.filter((v) => sameMask(v.mask, ref.mask)).map((v) => v.ch);
  const different = variants.filter((v) => !sameMask(v.mask, ref.mask)).map((v) => v.ch);
  return { ref, variants, identical, different };
}

/* ===================================================================== */
/* 產生原始碼                                                             */
/* ===================================================================== */

function formatSpans(rows, indent = '  ') {
  return rows
    .map((spans, y) => `${indent}[${spans.map(([a, b]) => `[${a}, ${b}]`).join(', ')}],${y === rows.length - 1 ? ' ' : ''}`)
    .join('\n');
}

function buildSource({ ref, identical, different, mask50, mask25, rows50, rows25, edge25, area50, area25 }) {
  const cx = mask25.w >> 1;
  const cy = mask25.h >> 1;
  const halfW = Math.max(cx, mask25.w - 1 - cx);
  const halfH = Math.max(cy, mask25.h - 1 - cy);
  return `/**
 * engine/graze-mask.js — 官方擦彈心形遮罩（自動產生，請勿手改）
 *
 * 來源：assets-official/01-official/sprites/${identical.join('|')}/all_sprites/spr_grazemask.png
 *      官方原始遮罩 ${mask50.w}×${mask50.h}、顏色 rgb(64,255,64)、實心 ${area50} px；上述章節位元完全相同。
 * 產生：node tools/gen-graze-mask.mjs（PNG 由 node:zlib 直接解，零外部依賴）
 *
 * 兩份資料，各有用途：
 *   MASK_SOURCE_ROWS   官方 ${mask50.w}×${mask50.h} 原始列資料（出處 / 測試比對用）
 *   MASK_ROWS          實際使用的 ${mask25.w}×${mask25.h}，= 官方遮罩 2×2 多數決降採樣
 *
 * 為什麼實際用 ${mask25.w}×${mask25.h}：
 *   - 官方 spr_grazeappear.png（${mask50.w}×${mask50.h}）逐點等於 ${mask50.w}×${mask50.h} 遮罩的 1px 邊緣（142 px 全等），
 *     所以擦彈外框就是遮罩輪廓。
 *   - ch4 另有現成的 spr_grazemask_small（${mask25.w}×${mask25.h}）與 spr_grazeappear_small（26×26）；
 *     該 ${mask25.w}×${mask25.h} 與把 ${mask50.w}×${mask50.h} 做 2×2 多數決降採樣只差 1 px → 官方遊戲用半尺寸遮罩。
 *   - 影片 DeltaruneBossFightSpeedRun.mp4 實測（1080p；spr_heart 16×16 在畫面上約 40 px）：
 *     擦彈外框外緣直徑約 29–30 遊戲像素 ≈ ${mask25.w} 遮罩 + 1px 外框，與 1:1 的 ${mask50.w} px 明顯不符。
 *
 * 座標約定：
 *   格子 (x, y) 的像素中心，相對「靈魂中心」的位移是 (x - ${cx}, y - ${cy})；
 *   也就是遮罩橫跨 dx = -${halfW}..+${halfW}、dy = -${halfH}..+${halfH}（整數格）。
 *   像素中心落在子彈 hitbox 內即算重疊（與 SPEC 的像素級擦彈判定一致）。
 *
 * 對外：
 *   GRAZE_MASK / MASK_ROWS / MASK_EDGE / MASK_AREA / MASK_HALF_W / MASK_HALF_H / MASK_RADIUS
 *   MASK_SOURCE_ROWS / MASK_SOURCE_AREA   官方原始 50×50（出處）
 *   maskHasPixel(dx, dy)                  像素中心是否實心
 *   maskRowSpans(row)                     第 row 列 span（沒有就空陣列）
 *   maskOverlapCircle(cx, cy, r)          以靈魂為原點、圓心 (cx, cy)、半徑 r 的圓是否碰到遮罩
 *   maskOverlapRect(cx, cy, hw, hh, cos, sin)  旋轉矩形是否碰到遮罩（cos/sin 為子彈旋轉）
 *
 * 本模組不 import 任何東西，Node / 瀏覽器 / headless 都能用，且完全決定性。
 */

/** 遮罩尺寸與原點（格子座標；格 (${cx}, ${cy}) 的中心 = 靈魂中心） */
export const GRAZE_MASK = Object.freeze({ w: ${mask25.w}, h: ${mask25.h}, cx: ${cx}, cy: ${cy} });

/** 每列實心 span（[x0, x1] 含頭尾；空陣列 = 該列沒有實心像素） */
export const MASK_ROWS = Object.freeze([
${formatSpans(rows25)}
].map((row) => Object.freeze(row.map((span) => Object.freeze(span)))));

/** 邊緣像素 [x, y]（= 官方 spr_grazeappear 的 1px 外框；繪製擦彈外框用） */
export const MASK_EDGE = Object.freeze([
${edge25.map(([x, y]) => `  [${x}, ${y}],`).join('\n')}
].map((p) => Object.freeze(p)));

/** 實心像素數（測試 / 除錯用） */
export const MASK_AREA = ${area25};

/** 遮罩在四個方向的整數格上限（粗篩用） */
export const MASK_HALF_W = ${halfW};
export const MASK_HALF_H = ${halfH};

/** 外接圓半徑（粗篩用；含 0.5 的格半寬） */
export const MASK_RADIUS = ${(Math.sqrt(halfW * halfW + halfH * halfH) * 1).toFixed(6)};

/** 官方原始 ${mask50.w}×${mask50.h} 遮罩的每列 span（出處 / 測試用；執行期判定不使用） */
export const MASK_SOURCE_ROWS = Object.freeze([
${formatSpans(rows50)}
].map((row) => Object.freeze(row.map((span) => Object.freeze(span)))));

/** 官方原始遮罩的實心像素數 */
export const MASK_SOURCE_AREA = ${area50};

const EMPTY_SPANS = Object.freeze([]);

/** 像素中心 (dx, dy)（相對靈魂、整數格）是否在遮罩內 */
export function maskHasPixel(dx, dy) {
  const x = dx + GRAZE_MASK.cx;
  const y = dy + GRAZE_MASK.cy;
  if (x < 0 || y < 0 || x >= GRAZE_MASK.w || y >= GRAZE_MASK.h) return false;
  const spans = MASK_ROWS[y];
  for (let i = 0; i < spans.length; i += 1) {
    if (x >= spans[i][0] && x <= spans[i][1]) return true;
  }
  return false;
}

/** 第 row 列（格座標 0..h-1）的 span；超出範圍回空陣列 */
export function maskRowSpans(row) {
  if (row < 0 || row >= GRAZE_MASK.h) return EMPTY_SPANS;
  return MASK_ROWS[row];
}

/**
 * 圓形 hitbox 是否碰到遮罩（兩者都以靈魂為原點）。
 * 先用外接框粗篩，再逐列逐 span 取「該列與圓的 x 交集」逐像素測。
 * @param {number} cx 圓心 dx（子彈中心 - 靈魂中心）
 * @param {number} cy 圓心 dy
 * @param {number} r 圓半徑
 */
export function maskOverlapCircle(cx, cy, r) {
  const rr = r * r;
  // 先與遮罩外接框求交集（粗篩）
  const bx0 = Math.max(cx - r, -MASK_HALF_W);
  const bx1 = Math.min(cx + r, MASK_HALF_W);
  const by0 = Math.max(cy - r, -MASK_HALF_H);
  const by1 = Math.min(cy + r, MASK_HALF_H);
  if (bx0 > bx1 || by0 > by1) return false;
  const yStart = Math.max(0, Math.ceil(by0) + GRAZE_MASK.cy);
  const yEnd = Math.min(GRAZE_MASK.h - 1, Math.floor(by1) + GRAZE_MASK.cy);
  for (let gy = yStart; gy <= yEnd; gy += 1) {
    const dy = gy - GRAZE_MASK.cy - cy; // 相對圓心
    const w = rr - dy * dy;
    if (w < 0) continue;
    const half = Math.sqrt(w);
    // 這一列「像素中心」可能落在圓內的整數 dx 範圍
    const lo = Math.max(bx0, cx - half);
    const hi = Math.min(bx1, cx + half);
    const ix = Math.ceil(lo);
    const ixx = Math.floor(hi);
    if (ix > ixx) continue;
    const spans = MASK_ROWS[gy];
    for (let i = 0; i < spans.length; i += 1) {
      const sx = spans[i][0] - GRAZE_MASK.cx;
      if (sx > ixx) break;
      const ex = spans[i][1] - GRAZE_MASK.cx;
      if (ex < ix) continue;
      return true; // 有整數像素格同時落在 span 與圓內
    }
  }
  return false;
}

/**
 * 旋轉矩形 hitbox 是否碰到遮罩（兩者都以靈魂為原點）。
 * @param {number} cx 矩形中心 dx
 * @param {number} cy 矩形中心 dy
 * @param {number} hw 半寬
 * @param {number} hh 半高
 * @param {number} cos 子彈旋轉的 cos
 * @param {number} sin 子彈旋轉的 sin
 */
export function maskOverlapRect(cx, cy, hw, hh, cos, sin) {
  // cx/cy = 矩形中心相對靈魂；遮罩像素相對靈魂 (dx, dy) → 相對矩形 (dx - cx, dy - cy)
  const radius = Math.sqrt(hw * hw + hh * hh); // 外接圓（粗篩）
  const bx0 = Math.max(cx - radius, -MASK_HALF_W);
  const bx1 = Math.min(cx + radius, MASK_HALF_W);
  const by0 = Math.max(cy - radius, -MASK_HALF_H);
  const by1 = Math.min(cy + radius, MASK_HALF_H);
  if (bx0 > bx1 || by0 > by1) return false;
  const yStart = Math.max(0, Math.ceil(by0) + GRAZE_MASK.cy);
  const yEnd = Math.min(GRAZE_MASK.h - 1, Math.floor(by1) + GRAZE_MASK.cy);
  // 像素中心的整數 dx 容許範圍
  const ixMin = Math.ceil(bx0);
  const ixMax = Math.floor(bx1);
  if (ixMin > ixMax) return false;
  for (let gy = yStart; gy <= yEnd; gy += 1) {
    const py = gy - GRAZE_MASK.cy - cy; // 相對矩形中心的 dy
    const spans = MASK_ROWS[gy];
    for (let i = 0; i < spans.length; i += 1) {
      const s = Math.max(spans[i][0] - GRAZE_MASK.cx, ixMin);
      const e = Math.min(spans[i][1] - GRAZE_MASK.cx, ixMax);
      for (let px = s; px <= e; px += 1) {
        const dx = px - cx;
        // 世界 → 子彈本地座標（與 sim.js hitTest 的 rect 分支相同定義）
        const lx = dx * cos + py * sin;
        const ly = -dx * sin + py * cos;
        if (lx >= -hw && lx <= hw && ly >= -hh && ly <= hh) return true;
      }
    }
  }
  return false;
}

export default GRAZE_MASK;
`;
}

/* ===================================================================== */
/* 主程式                                                                 */
/* ===================================================================== */

function main() {
  const { ref, identical, different, variants } = loadReference();
  if (different.length) console.warn(`注意：${different.join(', ')} 的 spr_grazemask 與 ${ref.ch} 不同（以 ${ref.ch} 為準）`);
  const mask50 = ref.mask;
  const rows50 = toSpans(mask50);
  const edge50 = edgePixels(mask50);
  const area50 = area(mask50);
  const mask25 = downsample2(mask50);
  const rows25 = toSpans(mask25);
  const edge25 = edgePixels(mask25);
  const area25 = area(mask25);

  const src = buildSource({
    ref,
    identical,
    different,
    variants,
    mask50,
    mask25,
    rows50,
    rows25,
    edge25,
    area50,
    area25,
  });

  if (process.argv.includes('--check')) {
    let current = '';
    try {
      current = readFileSync(OUT_FILE, 'utf8');
    } catch {
      console.error(`缺少 ${OUT_FILE}，請執行 node tools/gen-graze-mask.mjs`);
      process.exitCode = 1;
      return;
    }
    const norm = (s) => s.replace(/\r\n/g, '\n').trimEnd();
    if (norm(current) !== norm(src)) {
      console.error('engine/graze-mask.js 與 spr_grazemask.png 不一致，請重跑 node tools/gen-graze-mask.mjs');
      process.exitCode = 1;
    } else {
      console.log(`✔ 一致（${mask25.w}×${mask25.h}、${area25} px、邊緣 ${edge25.length} px；官方 ${mask50.w}×${mask50.h}、${area50} px）`);
    }
    return;
  }

  writeFileSync(OUT_FILE, src, 'utf8');
  console.log(`✔ 已寫入 engine/graze-mask.js`);
  console.log(`  官方 50×50：${area50} px、邊緣 ${edge50.length} px（spr_grazeappear 同形狀）`);
  console.log(`  使用 ${mask25.w}×${mask25.h}：${area25} px、邊緣 ${edge25.length} px、原點 (${mask25.w >> 1}, ${mask25.h >> 1})`);
  console.log(`  位元相同章節：${identical.join(', ')}`);
}

main();
