/**
 * engine/graze-mask.js — 官方擦彈心形遮罩（自動產生，請勿手改）
 *
 * 來源：assets-official/01-official/sprites/ch1|ch2|ch3|ch4|ch5/all_sprites/spr_grazemask.png
 *      官方原始遮罩 50×50、顏色 rgb(64,255,64)、實心 2027 px；上述章節位元完全相同。
 * 產生：node tools/gen-graze-mask.mjs（PNG 由 node:zlib 直接解，零外部依賴）
 *
 * 兩份資料，各有用途：
 *   MASK_SOURCE_ROWS   官方 50×50 原始列資料（出處 / 測試比對用）
 *   MASK_ROWS          實際使用的 25×25，= 官方遮罩 2×2 多數決降採樣
 *
 * 為什麼實際用 25×25：
 *   - 官方 spr_grazeappear.png（50×50）逐點等於 50×50 遮罩的 1px 邊緣（142 px 全等），
 *     所以擦彈外框就是遮罩輪廓。
 *   - ch4 另有現成的 spr_grazemask_small（25×25）與 spr_grazeappear_small（26×26）；
 *     該 25×25 與把 50×50 做 2×2 多數決降採樣只差 1 px → 官方遊戲用半尺寸遮罩。
 *   - 影片 DeltaruneBossFightSpeedRun.mp4 實測（1080p；spr_heart 16×16 在畫面上約 40 px）：
 *     擦彈外框外緣直徑約 29–30 遊戲像素 ≈ 25 遮罩 + 1px 外框，與 1:1 的 50 px 明顯不符。
 *
 * 座標約定：
 *   格子 (x, y) 的像素中心，相對「靈魂中心」的位移是 (x - 12, y - 12)；
 *   也就是遮罩橫跨 dx = -12..+12、dy = -12..+12（整數格）。
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

/** 遮罩尺寸與原點（格子座標；格 (12, 12) 的中心 = 靈魂中心） */
export const GRAZE_MASK = Object.freeze({ w: 25, h: 25, cx: 12, cy: 12 });

/** 每列實心 span（[x0, x1] 含頭尾；空陣列 = 該列沒有實心像素） */
export const MASK_ROWS = Object.freeze([
  [[4, 9], [14, 20]],
  [[3, 21]],
  [[2, 22]],
  [[1, 23]],
  [[0, 24]],
  [[0, 24]],
  [[0, 24]],
  [[0, 24]],
  [[0, 24]],
  [[0, 24]],
  [[0, 24]],
  [[0, 24]],
  [[0, 24]],
  [[0, 24]],
  [[0, 24]],
  [[0, 24]],
  [[1, 23]],
  [[2, 22]],
  [[3, 21]],
  [[4, 20]],
  [[5, 19]],
  [[6, 18]],
  [[7, 17]],
  [[8, 16]],
  [[9, 15]], 
].map((row) => Object.freeze(row.map((span) => Object.freeze(span)))));

/** 邊緣像素 [x, y]（= 官方 spr_grazeappear 的 1px 外框；繪製擦彈外框用） */
export const MASK_EDGE = Object.freeze([
  [4, 0],
  [5, 0],
  [6, 0],
  [7, 0],
  [8, 0],
  [9, 0],
  [14, 0],
  [15, 0],
  [16, 0],
  [17, 0],
  [18, 0],
  [19, 0],
  [20, 0],
  [3, 1],
  [10, 1],
  [11, 1],
  [12, 1],
  [13, 1],
  [21, 1],
  [2, 2],
  [22, 2],
  [1, 3],
  [23, 3],
  [0, 4],
  [24, 4],
  [0, 5],
  [24, 5],
  [0, 6],
  [24, 6],
  [0, 7],
  [24, 7],
  [0, 8],
  [24, 8],
  [0, 9],
  [24, 9],
  [0, 10],
  [24, 10],
  [0, 11],
  [24, 11],
  [0, 12],
  [24, 12],
  [0, 13],
  [24, 13],
  [0, 14],
  [24, 14],
  [0, 15],
  [24, 15],
  [1, 16],
  [23, 16],
  [2, 17],
  [22, 17],
  [3, 18],
  [21, 18],
  [4, 19],
  [20, 19],
  [5, 20],
  [19, 20],
  [6, 21],
  [18, 21],
  [7, 22],
  [17, 22],
  [8, 23],
  [16, 23],
  [9, 24],
  [10, 24],
  [11, 24],
  [12, 24],
  [13, 24],
  [14, 24],
  [15, 24],
].map((p) => Object.freeze(p)));

/** 實心像素數（測試 / 除錯用） */
export const MASK_AREA = 511;

/** 遮罩在四個方向的整數格上限（粗篩用） */
export const MASK_HALF_W = 12;
export const MASK_HALF_H = 12;

/** 外接圓半徑（粗篩用；含 0.5 的格半寬） */
export const MASK_RADIUS = 16.970563;

/** 官方原始 50×50 遮罩的每列 span（出處 / 測試用；執行期判定不使用） */
export const MASK_SOURCE_ROWS = Object.freeze([
  [[8, 19], [30, 41]],
  [[7, 20], [28, 42]],
  [[6, 22], [27, 43]],
  [[5, 44]],
  [[4, 45]],
  [[3, 46]],
  [[2, 47]],
  [[1, 48]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[0, 49]],
  [[1, 48]],
  [[2, 47]],
  [[3, 46]],
  [[4, 45]],
  [[5, 44]],
  [[6, 43]],
  [[7, 42]],
  [[8, 41]],
  [[9, 40]],
  [[10, 39]],
  [[11, 38]],
  [[12, 37]],
  [[13, 36]],
  [[14, 35]],
  [[15, 34]],
  [[16, 33]],
  [[17, 32]],
  [[18, 31]],
  [[19, 30]], 
].map((row) => Object.freeze(row.map((span) => Object.freeze(span)))));

/** 官方原始遮罩的實心像素數 */
export const MASK_SOURCE_AREA = 2027;

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
