/**
 * tests/engine/t-graze.mjs — FX-GRAZE：官方心形擦彈判定（SPEC §5 擦彈）
 *
 * 背景：官方擦彈不是「子彈 hitbox 外擴 16px 再與靈魂做圓形距離判定」，
 * 而是「子彈 hitbox 與以靈魂為中心的心形遮罩（素材 spr_grazemask，50×50 半尺寸
 * = 25×25）像素級重疊」。命中判定（pad=0）維持原本的圓形/旋轉矩形 vs SOUL_RADIUS。
 *
 * 涵蓋：
 *   - 遮罩本身的形狀（凹口、兩瓣、下尖端、左右寬度、面積、邊緣）
 *   - 圓形子彈八方向擦彈邊界（上斜比下斜遠 → 心形不是圓）
 *   - 旋轉矩形子彈（含 40×4 長條與 45°）
 *   - 命中判定不變（pad=0 仍是圓 / 旋轉矩形 vs SOUL_RADIUS）
 *   - 擦彈與命中的分工（擦到的地方一定沒命中）
 *   - 決定性（同 seed 同結果）
 *   - 效能（遮罩粗篩：數百顆子彈 × 數十幀要有餘裕）
 *   - render.js 的心形外框邊界與遮罩一致
 */
import { group, test, eq, ok, notOk, approx, within } from './harness.mjs';
import { createSimulation, SOUL_RADIUS, TP_MAX } from '../../engine/sim.js';
import {
  GRAZE_MASK,
  MASK_ROWS,
  MASK_EDGE,
  MASK_AREA,
  MASK_HALF_W,
  MASK_HALF_H,
  MASK_RADIUS,
  MASK_SOURCE_ROWS,
  MASK_SOURCE_AREA,
  maskHasPixel,
  maskRowSpans,
  maskOverlapCircle,
  maskOverlapRect,
} from '../../engine/graze-mask.js';
import { createBot, bestClearance } from '../../engine/autoplay/bot.js';
import { grazeRingBounds } from '../../engine/render.js';

/** 最小攻擊（與 t-sim.mjs 的攻擊格式一致） */
function attack(over) {
  return {
    format: 'dr-battle-attack/1',
    settings: { duration: 5, seed: 1, ...(over && over.settings) },
    box: { x: 320, y: 171, w: 400, h: 400, ...(over && over.box) },
    soul: { x: null, y: null, speed: 4, slowSpeed: 2, mode: 'red', color: '#ff0000' },
    party: [{ name: 'Kris', hp: 90, maxHp: 90, color: '#00ffff' }],
    enemies: [],
    bulletTypes:
      (over && over.bulletTypes) || {
        dot: { sprite: null, hitbox: { shape: 'circle', r: 5 }, damage: null },
      },
    timeline: (over && over.timeline) || [],
  };
}

/** 在 (320+dx, 171+dy) 放一顆不會動的子彈，跑 frames 幀後回傳狀態摘要 */
function probe(dx, dy, { frames = 20, bulletTypes = null, bulletType = 'dot', rotation = 0, settings = null } = {}) {
  const s = createSimulation({ mode: 'preview' });
  s.load(
    attack({
      settings: { damage: 1, ...(settings || {}) },
      ...(bulletTypes ? { bulletTypes } : {}),
      timeline: [
        {
          id: 'sp',
          at: 0.1,
          type: 'spawn',
          bullet: bulletType,
          count: 1,
          x: 320 + dx,
          y: 171 + dy,
          rotation,
          speed: 0,
          life: 5,
        },
      ],
    }),
  );
  s.advance(frames, null);
  const st = s.getState();
  return { tp: st.tp, hp: st.party[0].hp, grazing: st.soul.grazing, grazeFlash: st.grazeFlash };
}

/** 沿方向把子彈往外推，找「擦 / 不擦」的分界（回傳最後一個仍在擦的距離） */
function circleBoundary(r, dx, dy) {
  let lo = 0;
  let hi = 40;
  for (let i = 0; i < 40; i += 1) {
    const mid = (lo + hi) / 2;
    if (maskOverlapCircle(dx * mid, dy * mid, r)) lo = mid;
    else hi = mid;
  }
  return lo;
}

test('decor：重疊靈魂不命中、不擦彈，AI 忽略，JSON 快照保留', () => {
  const sim = createSimulation({ mode: 'preview' });
  sim.load(attack({
    bulletTypes: { dot: { decor: true, damage: 99, grazeable: true } },
    timeline: [{ at: 0, type: 'spawn', bullet: 'dot', x: 320, y: 171, speed: 0, life: 5 }],
  }));
  sim.advance(20, null);
  ok(sim.restore(JSON.parse(JSON.stringify(sim.snapshot()))));
  const st = sim.getState();
  eq(st.bullets[0].decor, true);
  eq(st.bullets[0].maskToBox, false);
  eq(st.party[0].hp, 90);
  eq(st.tp, 0);
  eq(st.grazeFlash, 0);
  eq(JSON.stringify(createBot().decide(st)), JSON.stringify(createBot().decide({ ...st, bullets: [] })));
  eq(bestClearance(st), bestClearance({ ...st, bullets: [] }));
});

const SQ = Math.SQRT1_2;

/* ================================================================== */

group('FX-GRAZE：心形遮罩本身');

test('遮罩尺寸與原點（官方 50×50 的半尺寸）', () => {
  eq(GRAZE_MASK.w, 25, '寬 25');
  eq(GRAZE_MASK.h, 25, '高 25');
  eq(GRAZE_MASK.cx, 12, '原點 x=12（13 的半尺寸取整）');
  eq(GRAZE_MASK.cy, 12, '原點 y=12');
  eq(MASK_HALF_W, 12, '半寬 12');
  eq(MASK_HALF_H, 12, '半高 12');
  // 25×25 遮罩的最大半徑：對角到 (12,12) 約 16.97（不是 20 的舊 GRAZE_PAD 圓）
  within(MASK_RADIUS, 16.9, 17.0, `等效半徑 ${MASK_RADIUS}`);
});

test('遮罩面積與邊緣像素數（25×25 = 511；70 個邊緣像素）', () => {
  const counted = MASK_ROWS.reduce(
    (sum, spans) => sum + spans.reduce((s, span) => s + (span[1] - span[0] + 1), 0),
    0,
  );
  eq(counted, MASK_AREA, '每列 span 加總 = MASK_AREA');
  eq(MASK_AREA, 511, '面積 511（官方 50×50 的 2027 px 降採樣結果）');
  eq(MASK_EDGE.length, 70, '邊緣 70 像素（= spr_grazeappear 的 142 px 半尺寸）');
  eq(MASK_SOURCE_AREA, 2027, '官方 50×50 遮罩面積');
  eq(MASK_SOURCE_ROWS.length, 50, '官方遮罩 50 列');
});

test('形狀：上兩瓣、中間凹口不算、下尖端收斂、左右最寬 ±12', () => {
  // 兩瓣（凹口左右的實心區）
  ok(maskHasPixel(-6, -12), '左上瓣 (-6,-12) 是實心');
  ok(maskHasPixel(6, -12), '右上瓣 (6,-12) 是實心');
  ok(maskHasPixel(-6, -11), '左上瓣 (-6,-11) 是實心');
  ok(maskHasPixel(6, -11), '右上瓣 (6,-11) 是實心');
  // 凹口：兩瓣之間的中央上方不是實心（圓形判定會說「擦到」，心形必須說沒有）
  notOk(maskHasPixel(0, -12), '凹口中央 (0,-12) 不是實心');
  notOk(maskHasPixel(0, -13), '凹口中央 (0,-13) 不是實心');
  ok(maskHasPixel(0, -11), '凹口下方 (0,-11) 回到實心');
  // 左右最寬處是 ±12
  ok(maskHasPixel(-12, 0), '左緣 (-12,0) 實心');
  ok(maskHasPixel(12, 0), '右緣 (12,0) 實心');
  notOk(maskHasPixel(-13, 0), '(-13,0) 在遮罩外');
  notOk(maskHasPixel(13, 0), '(13,0) 在遮罩外');
  // 下尖端：中央到 y=12，但兩側先收掉
  ok(maskHasPixel(0, 12), '下尖端 (0,12) 實心');
  notOk(maskHasPixel(0, 13), '(0,13) 在遮罩外');
  notOk(maskHasPixel(-12, 12), '左下 (−12,12) 已收掉（尖端是尖的）');
  notOk(maskHasPixel(12, 12), '右下 (12,12) 已收掉');
  // 第一列是兩段（凹口分成左右）
  eq(maskRowSpans(0).length, 2, '第 0 列是兩段（凹口把頂端分成兩瓣）');
  eq(JSON.stringify(maskRowSpans(0)), JSON.stringify([[4, 9], [14, 20]]), '第 0 列 span');
  eq(JSON.stringify(maskRowSpans(24)), JSON.stringify([[9, 15]]), '最後一列 span（下尖端）');
});

test('形狀是左右對稱的心（凹口除外，官方素材本身有 1 px 不對稱）', () => {
  let mismatches = 0;
  for (let y = -12; y <= 12; y += 1) {
    for (let x = 0; x <= 12; x += 1) {
      if (maskHasPixel(x, y) !== maskHasPixel(-x, y)) mismatches += 1;
    }
  }
  // 官方 25×25 遮罩在第 0 列有一格不對稱（母素材 50×50 也只差 2 px），
  // 這裡只要求「最多 1 對」而不是完全對稱：形狀要對稱，但不為了對稱去改官方像素。
  within(mismatches, 0, 1, `左右不對稱的像素對數（實際 ${mismatches}）`);
});

test('遮罩邊緣像素都是實心且都貼著外部（= spr_grazeappear 的形狀）', () => {
  for (const [x, y] of MASK_EDGE) {
    const dx = x - GRAZE_MASK.cx;
    const dy = y - GRAZE_MASK.cy;
    ok(maskHasPixel(dx, dy), `邊緣點 (${dx},${dy}) 本身是實心`);
    const touchesOutside =
      !maskHasPixel(dx + 1, dy) || !maskHasPixel(dx - 1, dy) || !maskHasPixel(dx, dy + 1) || !maskHasPixel(dx, dy - 1);
    ok(touchesOutside, `邊緣點 (${dx},${dy}) 至少有一個四鄰居在遮罩外`);
  }
  // 邊緣的外接框就是遮罩範圍
  for (const [axis, sign, expect] of [
    ['x', -1, -12],
    ['x', 1, 12],
    ['y', -1, -12],
    ['y', 1, 12],
  ]) {
    const has = MASK_EDGE.some(([x, y]) => (axis === 'x' ? x - GRAZE_MASK.cx : y - GRAZE_MASK.cy) === sign * 12);
    ok(has, `${axis} 方向有到 ${expect} 的邊緣像素`);
  }
});

/* ================================================================== */

group('FX-GRAZE：圓形子彈的擦彈範圍（心形 ≠ 圓形）');

test('圓形子彈 r=5：四方擦彈邊界（右/左/下 17，上 16.58）', () => {
  // 舊的圓形判定：r + GRAZE_PAD = 5 + 16 = 21 → 四方向都是 21。
  // 心形判定：左右下 17（遮罩 ±12 + r=5），正上方因為凹口只有 16.58。
  approx(circleBoundary(5, 1, 0), 17, 0.01, '正右 17');
  approx(circleBoundary(5, -1, 0), 17, 0.01, '正左 17');
  approx(circleBoundary(5, 0, 1), 17, 0.01, '正下 17');
  approx(circleBoundary(5, 0, -1), 16.583, 0.01, '正上 16.58（兩瓣之間凹口讓上方更近）');
  ok(maskOverlapCircle(17, 0, 5), 'dx=17 擦到');
  notOk(maskOverlapCircle(17.5, 0, 5), 'dx=17.5 沒擦到');
  ok(maskOverlapCircle(0, 16.5, 5), 'dy=16.5（下方）擦到');
  notOk(maskOverlapCircle(0, 17.5, 5), 'dy=17.5 沒擦到');
  ok(maskOverlapCircle(0, -16.5, 5), 'dy=-16.5（上方）擦到');
  notOk(maskOverlapCircle(0, -16.8, 5), 'dy=-16.8（上方）沒擦到');
});

test('圓形子彈 r=5：斜上方比斜下方遠（心形的兩瓣讓上斜方向更寬）', () => {
  // 同一個距離 18：斜上擦到、正右/正下/斜下都沒擦到 → 只看距離的圓形判定做不到。
  ok(maskOverlapCircle(18 * SQ, -18 * SQ, 5), '斜上距離 18 → 擦到');
  notOk(maskOverlapCircle(18, 0, 5), '正右距離 18 → 沒擦到');
  notOk(maskOverlapCircle(18 * SQ, 18 * SQ, 5), '斜下距離 18 → 沒擦到');
  approx(circleBoundary(5, SQ, -SQ), 19.142, 0.01, '斜上邊界 19.14');
  approx(circleBoundary(5, SQ, SQ), 15.556, 0.01, '斜下邊界 15.56');
  approx(circleBoundary(5, -SQ, -SQ), 19.142, 0.01, '左斜上 19.14');
  approx(circleBoundary(5, -SQ, SQ), 15.556, 0.01, '左斜下 15.56');
});

test('圓形子彈半徑不同 → 擦彈範圍跟著平移（r=3 / r=6）', () => {
  approx(circleBoundary(3, 1, 0), 15, 0.01, 'r=3 正右 15');
  approx(circleBoundary(3, 0, -1), 14.236, 0.01, 'r=3 正上 14.24');
  approx(circleBoundary(6, 1, 0), 18, 0.01, 'r=6 正右 18');
  approx(circleBoundary(6, SQ, -SQ), 20.142, 0.01, 'r=6 斜上 20.14');
  // r=1（點狀子彈）：遮罩本身就決定範圍
  approx(circleBoundary(1, 1, 0), 13, 0.01, 'r=1 正右 13');
  // 完全在遮罩外
  notOk(maskOverlapCircle(0, -20, 5), '正上方 20px 沒擦到');
  notOk(maskOverlapCircle(25, 0, 5), '右方 25px 沒擦到');
  ok(maskOverlapCircle(0, 0, 1), '子彈中心壓在靈魂上 → 擦到（也是命中）');
});

test('圓形子彈的擦彈範圍不會因為繞一圈而變成圓', () => {
  // 掃 360 度，記下每個方向的最大擦彈距離；心形應該有明顯的「上寬下窄」不對稱。
  const N = 72;
  const ds = [];
  for (let i = 0; i < N; i += 1) {
    const a = (i / N) * Math.PI * 2;
    ds.push(circleBoundary(5, Math.cos(a), Math.sin(a)));
  }
  const maxD = Math.max(...ds);
  const minD = Math.min(...ds);
  ok(maxD - minD > 3, `最大/最小擦彈距離差 ${maxD.toFixed(2)} / ${minD.toFixed(2)} 應大於 3（心形不是圓）`);
  within(minD, 15, 16.7, '最短方向（斜下）約 15.56');
  // 最長方向比 45° 稍偏（遮罩是格狀像素，最遠點出現在兩瓣外側附近），約 19.14–19.41
  within(maxD, 19, 19.8, '最長方向（上斜）約 19.1–19.4');
});

/* ================================================================== */

group('FX-GRAZE：旋轉矩形子彈的擦彈範圍');

test('矩形 8×8（未旋轉）：四方 16、斜上 19.80、斜下 15.56', () => {
  const c0 = 1;
  const s0 = 0;
  ok(maskOverlapRect(16, 0, 4, 4, c0, s0), 'dx=16 擦到');
  notOk(maskOverlapRect(16.2, 0, 4, 4, c0, s0), 'dx=16.2 沒擦到');
  ok(maskOverlapRect(0, -16, 4, 4, c0, s0), '上方 dy=-16 擦到');
  notOk(maskOverlapRect(0, -16.2, 4, 4, c0, s0), '上方 dy=-16.2 沒擦到');
  ok(maskOverlapRect(19.6 * SQ, -19.6 * SQ, 4, 4, c0, s0), '斜上 19.6 擦到');
  notOk(maskOverlapRect(20.0 * SQ, -20.0 * SQ, 4, 4, c0, s0), '斜上 20.0 沒擦到');
  notOk(maskOverlapRect(15.7 * SQ, 15.7 * SQ, 4, 4, c0, s0), '斜下 15.7 沒擦到');
});

test('矩形 8×8 旋轉 45°：旋轉會改變擦彈邊界', () => {
  const c = Math.SQRT1_2;
  const s = Math.SQRT1_2;
  ok(maskOverlapRect(17.5, 0, 4, 4, c, s), 'rot45 正右 17.5 擦到');
  notOk(maskOverlapRect(17.8, 0, 4, 4, c, s), 'rot45 正右 17.8 沒擦到');
  ok(maskOverlapRect(14.4 * SQ, 14.4 * SQ, 4, 4, c, s), 'rot45 斜下 14.4 擦到');
  notOk(maskOverlapRect(14.8 * SQ, 14.8 * SQ, 4, 4, c, s), 'rot45 斜下 14.8 沒擦到');
  // 旋轉 45° 後，正右邊界比未旋轉時遠（角朝外）
  ok(maskOverlapRect(16.5, 0, 4, 4, c, s), 'rot45 正右 16.5 擦到（未旋轉時 16 就已經是邊界）');
});

test('長條 40×4：擦彈範圍隨 rotation 轉向（90° 後變垂直）', () => {
  const c90 = Math.cos(Math.PI / 2);
  const s90 = Math.sin(Math.PI / 2);
  // 未旋轉：水平長條 → 左右可以很遠（32），上下只有 14
  ok(maskOverlapRect(31, 0, 20, 2, 1, 0), 'rot0 右 31 擦到');
  notOk(maskOverlapRect(33, 0, 20, 2, 1, 0), 'rot0 右 33 沒擦到');
  ok(maskOverlapRect(0, -13, 20, 2, 1, 0), 'rot0 上 13 擦到');
  notOk(maskOverlapRect(0, -15, 20, 2, 1, 0), 'rot0 上 15 沒擦到（長條太窄）');
  // 旋轉 90°：變垂直 → 上下可以很遠，左右只有 14
  ok(maskOverlapRect(0, -31, 20, 2, c90, s90), 'rot90 上 31 擦到');
  notOk(maskOverlapRect(0, -33, 20, 2, c90, s90), 'rot90 上 33 沒擦到');
  ok(maskOverlapRect(14, 0, 20, 2, c90, s90), 'rot90 右 14 擦到');
  notOk(maskOverlapRect(15, 0, 20, 2, c90, s90), 'rot90 右 15 沒擦到');
  // 旋轉 90° 後上方仍受凹口影響：31 可以，但 (0,-31) 是「貼著兩瓣外側」通過的
  ok(maskOverlapRect(0, -32, 20, 2, c90, s90), 'rot90 上 32 擦到（穿過兩瓣）');
  notOk(maskOverlapRect(0, -33, 20, 2, c90, s90), 'rot90 上 33 沒擦到');
});

/* ================================================================== */

group('FX-GRAZE：命中判定不變（pad=0 的圓 / 旋轉矩形）');

test('dot 子彈 r=5：dx≤9 命中、dx=10..17 只擦彈、dx≥18 都沒有', () => {
  const hit = probe(9, 0);
  eq(hit.hp, 89, 'dx=9 命中（r+SOUL_RADIUS=9，含等號）→ 扣 1 血');
  eq(hit.tp, 0, '命中時不算擦彈（擦彈要求 !actual）');
  eq(hit.grazing, false, '命中時 grazing=false');

  const graze = probe(12, 0);
  eq(graze.hp, 90, 'dx=12 沒命中');
  eq(graze.tp, 1, 'dx=12 擦彈 +1 TP');
  eq(graze.grazing, true, 'dx=12 grazing=true');

  const far = probe(18, 0);
  eq(far.hp, 90, 'dx=18 沒命中');
  eq(far.tp, 0, 'dx=18 沒擦彈');

  // r=5 + SOUL_RADIUS=4 = 9 → 命中半徑與心形無關，仍是圓
  eq(SOUL_RADIUS, 4, 'SOUL_RADIUS 沒被改動');
});

test('命中判定仍用 SOUL_RADIUS（不是遮罩）：正上方 -9 命中、-10 只擦彈', () => {
  const hit = probe(0, -9);
  eq(hit.hp, 89, 'dy=-9 命中（圓形命中判定）');
  const graze = probe(0, -10);
  eq(graze.hp, 90, 'dy=-10 沒命中');
  eq(graze.tp, 1, 'dy=-10 擦彈');
  // 心形凹口讓「擦到」的上界變近：-16.58 之後就沒有了
  const upper = probe(0, -17);
  eq(upper.tp, 0, 'dy=-17 已超出凹口上界（-16.58）→ 不擦');
});

test('命中判定不受心形遮罩影響：凹口讓「擦彈」變少，但「命中」範圍完全不變', () => {
  // 1×1 的小 hitbox 放在凹口 (0,-12)：心形遮罩在那裡沒有實心像素 → 不擦。
  // 同一顆子彈放到兩瓣上 (±6,-12) → 擦到。這是像素級判定才有的結果。
  const tinyRect = { tiny: { hitbox: { shape: 'rect', w: 1, h: 1 } } };
  const notch = probe(0, -12, { bulletTypes: tinyRect, bulletType: 'tiny' });
  eq(notch.tp, 0, '凹口正中央不擦（心形凹口）');
  const lobeL = probe(-6, -12, { bulletTypes: tinyRect, bulletType: 'tiny' });
  eq(lobeL.tp, 1, '左上瓣 (−6,−12) 擦到');
  const lobeR = probe(6, -12, { bulletTypes: tinyRect, bulletType: 'tiny' });
  eq(lobeR.tp, 1, '右上瓣 (6,−12) 擦到');
  // 命中判定仍是「hitbox 與靈魂圓」：這三處都離靈魂 >9，全部不命中。
  eq(notch.hp, 90, '凹口不命中');
  eq(lobeL.hp, 90, '左瓣不命中');
  eq(lobeR.hp, 90, '右瓣不命中');
});

test('矩形子彈命中判定不變（40×4 旋轉 0 vs 90）', () => {
  const bt = { bar: { hitbox: { shape: 'rect', w: 40, h: 4 } } };
  // 未旋轉的水平長條：靈魂在正下方 12px → 2 + SOUL_RADIUS 4 = 6 < 12 → 不命中
  const flat = probe(0, -12, { bulletTypes: bt, bulletType: 'bar', rotation: 0 });
  eq(flat.hp, 90, 'rot0 上 12px 沒命中');
  eq(flat.tp, 1, 'rot0 上 12px 擦到（長條穿過兩瓣）');
  // 旋轉 90° 變垂直 → 長條涵蓋到靈魂 → 命中（命中判定是幾何，跟心形無關）
  const vert = probe(0, -12, { bulletTypes: bt, bulletType: 'bar', rotation: 90 });
  eq(vert.hp, 89, 'rot90 上 12px 命中（長條轉成垂直，涵蓋到靈魂）');
  eq(vert.tp, 0, '命中時不算擦彈');
});

/* ================================================================== */

group('FX-GRAZE：擦彈與 TP / 事件');

test('擦彈加 TP 且只加一次（多次重疊不重複加）', () => {
  const s = createSimulation({ mode: 'preview' });
  s.load(
    attack({
      settings: { grazeTP: 2, duration: 5 },
      timeline: [
        { id: 'a', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 332, y: 171, speed: 0, life: 5 },
        { id: 'b', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 308, y: 171, speed: 0, life: 5 },
        { id: 'c', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 320, y: 185, speed: 0, life: 5 },
      ],
    }),
  );
  s.advance(5, null);
  eq(s.getState().tp, 6, '三顆子彈各擦一次 → 2×3=6');
  s.advance(25, null);
  eq(s.getState().tp, 6, '同一批子彈不會重複加 TP');
});

test('grazeFlash 在擦彈後升高，8 幀內衰減回 0', () => {
  const s = createSimulation({ mode: 'preview' });
  s.load(
    attack({
      timeline: [{ id: 'sp', at: 0.1, type: 'spawn', bullet: 'dot', count: 1, x: 334, y: 171, speed: 0, life: 2 }],
    }),
  );
  s.advance(4, null);
  const flash = s.getState().grazeFlash;
  ok(flash > 0, `擦彈後 grazeFlash > 0（實際 ${flash}）`);
  s.advance(10, null);
  eq(s.getState().grazeFlash, 0, '8 幀後衰減到 0');
});

test('grazeable=false 與遠離的子彈都不擦', () => {
  // r=9 的子彈：命中範圍 9+SOUL_RADIUS=13，擦彈範圍 12+9=21。
  // 放在 dx=20 → 在擦彈範圍內但一定沒命中，才測得到 grazeable 的效果。
  const bt = { solid: { hitbox: { shape: 'circle', r: 9 }, grazeable: false } };
  const noGraze = probe(20, 0, { bulletTypes: bt, bulletType: 'solid' });
  eq(noGraze.hp, 90, 'dx=20 沒命中');
  eq(noGraze.tp, 0, 'grazeable=false → 不擦');
  const far = probe(100, 0);
  eq(far.tp, 0, '距離 100 → 不擦');
});

/* ================================================================== */

group('FX-GRAZE：決定性');

test('同 seed 同輸入 → 擦彈結果完全相同（含 grazing / grazeFlash / TP）', () => {
  const mk = () => {
    const s = createSimulation({ mode: 'preview' });
    s.load(
      attack({
        settings: { grazeTP: 1, duration: 6 },
        timeline: [
          {
            id: 'em',
            at: 0,
            type: 'emitter',
            duration: 3,
            interval: 0.1,
            count: 12,
            spawn: { bullet: 'dot', x: '320 + 12 + (i % 3) * 3', y: '171 - 8 + (i % 5) * 4', speed: 0, life: 3 },
          },
        ],
      }),
    );
    const out = [];
    for (let i = 0; i < 40; i += 1) {
      s.advance(1, null);
      const st = s.getState();
      out.push([st.tp, st.grazeFlash, st.soul.grazing ? 1 : 0, st.frame]);
    }
    return out;
  };
  const a = JSON.stringify(mk());
  const b = JSON.stringify(mk());
  eq(a, b, '兩次模擬逐幀完全一致');
});

test('遮罩查詢是純函式（同輸入永遠同輸出、不改動遮罩）', () => {
  const before = JSON.stringify(MASK_ROWS);
  const r1 = maskOverlapCircle(12.5, -8.25, 4);
  const r2 = maskOverlapCircle(12.5, -8.25, 4);
  eq(r1, r2, '連續兩次結果相同');
  eq(JSON.stringify(MASK_ROWS), before, '查詢不會改動遮罩資料');
  ok(Object.isFrozen(MASK_ROWS), 'MASK_ROWS 已凍結');
  ok(Object.isFrozen(GRAZE_MASK), 'GRAZE_MASK 已凍結');
});

/* ================================================================== */

group('FX-GRAZE：效能（粗篩 + 逐列 span）');

test('數百顆子彈 × 數十幀的擦彈查詢在預算內', () => {
  // 官方上限 MAX_BULLETS=4000，但實務上每幀數百顆；這裡抓 600 顆（一半很近、一半很遠）。
  const near = [];
  const far = [];
  for (let i = 0; i < 600; i += 1) {
    near.push([Math.cos(i) * 14, Math.sin(i) * 14]);
    far.push([Math.cos(i) * 260, Math.sin(i * 1.7) * 200]);
  }
  const t0 = Date.now();
  let hits = 0;
  for (let f = 0; f < 60; f += 1) {
    for (const [x, y] of near) if (maskOverlapCircle(x, y, 5)) hits += 1;
    for (const [x, y] of far) if (maskOverlapCircle(x, y, 5)) hits += 1;
  }
  const ms = Date.now() - t0;
  ok(hits > 0, '有查到擦彈（確保沒被最佳化成空迴圈）');
  ok(ms < 400, `600 顆 × 60 幀耗時 ${ms}ms，應遠低於每幀預算（實測數毫秒）`);
});

/* ================================================================== */

group('FX-GRAZE：render.js 的心形外框與遮罩一致');

test('grazeRingBounds() 回傳遮罩邊緣的範圍（±12）', () => {
  const b = grazeRingBounds();
  eq(b.minX, -12, '最左 -12');
  eq(b.maxX, 12, '最右 12');
  eq(b.minY, -12, '最上 -12');
  eq(b.maxY, 12, '最下 12');
});

test('外框邊緣像素數與遮罩邊緣相同（70 點），且都落在 ±12 內', () => {
  eq(MASK_EDGE.length, 70, '外框用 70 個邊緣像素');
  for (const [x, y] of MASK_EDGE) {
    within(x, 0, 24, 'x 在 0..24');
    within(y, 0, 24, 'y 在 0..24');
  }
});
