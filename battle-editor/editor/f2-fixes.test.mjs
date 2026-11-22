/**
 * editor/f2-fixes.test.mjs — F2 修復的純邏輯測試（B3 / B5 / B6 / B9 / B15 / B16 + §4-5）
 *
 * 執行：node --test editor/f2-fixes.test.mjs
 *
 * 只測純函式，不需要 DOM：
 *   - hitTestTolerant …………… B15 事件條上下各 4px 的點擊容差
 *   - placeTimelineMenu ………… B9 新增事件選單以點擊點為錨（下方優先、放不下才往上、不蓋點擊點）
 *   - modalEnterIntent ………… B6 Modal 按 Enter ＝確定（textarea 不攔截）
 *   - timelineHeightForViewport … B3 預設時間軸高度要裝得下 9 軌
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hitTestTolerant,
  layoutTracks,
  placeTimelineMenu,
} from './timeline.js';
import { modalEnterIntent } from './fileops.js';
import {
  LAYOUT_DEFAULTS,
  TIMELINE_CHROME_H,
  TIMELINE_TRACKS_H,
  TIMELINE_MIN_HEIGHT,
  defaultTimelineHeight,
  timelineHeightForViewport,
} from './main.js';

/* ------------------------------------------------------------------ B15 */

test('hitTestTolerant：矩形內命中不受容差影響', () => {
  const rects = [{ id: 'bar', kind: 'event', x: 100, y: 40, w: 120, h: 20 }];
  assert.equal(hitTestTolerant(rects, 150, 50, 4).id, 'bar');
  assert.equal(hitTestTolerant(rects, 100, 40, 4).id, 'bar', '左上角');
  assert.equal(hitTestTolerant(rects, 220, 60, 4).id, 'bar', '右下角');
});

test('hitTestTolerant：上下各 4px 仍算命中（原本偏 1–2px 就變框選）', () => {
  const rects = [{ id: 'bar', kind: 'event', x: 100, y: 40, w: 120, h: 20 }];
  // 上緣外 1 / 4 px
  assert.equal(hitTestTolerant(rects, 150, 39, 4).id, 'bar');
  assert.equal(hitTestTolerant(rects, 150, 36, 4).id, 'bar');
  // 下緣外 1 / 4 px
  assert.equal(hitTestTolerant(rects, 150, 61, 4).id, 'bar');
  assert.equal(hitTestTolerant(rects, 150, 64, 4).id, 'bar');
  // 超過容差 → 沒中
  assert.equal(hitTestTolerant(rects, 150, 35, 4), null, '上緣外 5px');
  assert.equal(hitTestTolerant(rects, 150, 65, 4), null, '下緣外 5px');
  // 水平方向沒有容差（時間軸不能亂選到隔壁事件）
  assert.equal(hitTestTolerant(rects, 96, 50, 4), null, '左邊外 4px');
  assert.equal(hitTestTolerant(rects, 224, 50, 4), null, '右邊外 4px');
});

test('hitTestTolerant：pad=0 等同精確命中；容差內取最近的一個', () => {
  const rects = [
    { id: 'upper', kind: 'event', x: 0, y: 0, w: 100, h: 20 },
    { id: 'lower', kind: 'event', x: 0, y: 30, w: 100, h: 20 },
  ];
  assert.equal(hitTestTolerant(rects, 50, 21, 0), null);
  assert.equal(hitTestTolerant(rects, 50, 22, 4).id, 'upper', '距離 upper 2px、lower 8px');
  assert.equal(hitTestTolerant(rects, 50, 28, 4).id, 'lower', '距離 lower 2px、upper 8px');
  assert.equal(hitTestTolerant(rects, 50, 24, 4).id, 'upper', '距離 upper 4px、lower 6px → 取較近的');
  assert.equal(hitTestTolerant(rects, 50, 26, 4).id, 'lower', '距離 lower 4px、upper 6px → 取較近的');
  assert.equal(hitTestTolerant(rects, 50, 25, 4), null, '兩邊都差 5px（超出容差）→ 不命中');
  assert.equal(hitTestTolerant(null, 0, 0, 4), null);
  assert.equal(hitTestTolerant([], 0, 0, 4), null);
});

/* ------------------------------------------------------------------- B9 */

const ROOT = { w: 1200, h: 260 };

test('placeTimelineMenu：下方放得下 → 在點擊點下方，且不覆蓋點擊點', () => {
  const p = placeTimelineMenu({
    point: { x: 300, y: 20 },
    root: ROOT,
    menu: { w: 200, h: 200 },
  });
  assert.equal(p.placement, 'below');
  assert.equal(p.top, 26, 'top = 點擊 y + 6px 間隙');
  assert.ok(p.top > 20, '選單不可蓋住點擊點');
  assert.equal(p.left, 300, '水平以點擊點為錨');
  assert.equal(p.maxHeight, 200);
});

test('placeTimelineMenu：下方放不下但上方放得下 → 往上開', () => {
  const p = placeTimelineMenu({
    point: { x: 300, y: 240 },
    root: ROOT,
    menu: { w: 200, h: 200 },
  });
  assert.equal(p.placement, 'above');
  assert.ok(p.top + 200 <= 240, '選單底端要在點擊點之上');
  assert.equal(p.top, 34, 'top = 240 - 6 - 200');
});

test('placeTimelineMenu：上下都放不下 → 開在空間較大的一側並限高，仍不蓋點擊點', () => {
  // 下方可用 260-4-(128+6)=122、上方可用 128-6-4=118 → 下方大 → 選下方
  const below = placeTimelineMenu({
    point: { x: 300, y: 128 },
    root: ROOT,
    menu: { w: 200, h: 200 },
  });
  assert.equal(below.placement, 'below');
  assert.equal(below.maxHeight, 260 - 4 - (128 + 6), '限高 = 下方可用空間');
  assert.ok(below.top >= 128, '不覆蓋點擊點');
  assert.ok(below.top + below.maxHeight <= ROOT.h);

  // 下方可用 116、上方可用 124 → 上方大 → 選上方
  const above = placeTimelineMenu({
    point: { x: 300, y: 134 },
    root: ROOT,
    menu: { w: 200, h: 200 },
  });
  assert.equal(above.placement, 'above');
  assert.equal(above.maxHeight, 134 - 6 - 4, '限高 = 上方可用空間');
  assert.ok(above.top + above.maxHeight <= 134, '選單底端不超過點擊點');
});

test('placeTimelineMenu：靠近右緣 → 水平夾回面板內', () => {
  const p = placeTimelineMenu({
    point: { x: 1150, y: 20 },
    root: ROOT,
    menu: { w: 200, h: 120 },
  });
  assert.equal(p.left, ROOT.w - 200 - 4);
});

test('placeTimelineMenu：資料異常也不炸（缺 root / menu / point）', () => {
  assert.doesNotThrow(() => placeTimelineMenu());
  const p = placeTimelineMenu({ point: { x: NaN, y: NaN } });
  assert.ok(Number.isFinite(p.left) && Number.isFinite(p.top));
  assert.ok(p.maxHeight >= 1);
});

/* ------------------------------------------------------------------- B6 */

const fakeEl = (tagName, extra = {}) => ({ tagName, isContentEditable: false, type: 'text', ...extra });

test('modalEnterIntent：單行 input / modal 本身 → 確定', () => {
  assert.equal(modalEnterIntent(fakeEl('INPUT')), 'primary');
  assert.equal(modalEnterIntent(fakeEl('INPUT', { type: 'text' })), 'primary');
  assert.equal(modalEnterIntent(fakeEl('INPUT', { type: 'number' })), 'primary');
  assert.equal(modalEnterIntent(fakeEl('DIV')), 'primary', '焦點在 modal 容器');
  assert.equal(modalEnterIntent(null), 'primary', '沒有焦點 → 確定');
  assert.equal(modalEnterIntent({ tagName: '' }), 'primary');
});

test('modalEnterIntent：textarea / contenteditable 不攔截', () => {
  assert.equal(modalEnterIntent(fakeEl('TEXTAREA')), 'ignore');
  assert.equal(modalEnterIntent(fakeEl('INPUT', { type: 'textarea' })), 'ignore');
  assert.equal(modalEnterIntent(fakeEl('DIV', { isContentEditable: true })), 'ignore');
});

test('modalEnterIntent：焦點跑到 modal 外面時仍然要確定（modal 是強制的）', () => {
  assert.equal(modalEnterIntent(fakeEl('BUTTON'), false), 'primary', '焦點在工具列按鈕，但對話框開著');
  assert.equal(modalEnterIntent(fakeEl('TEXTAREA'), false), 'primary', '焦點在別處的 textarea');
  assert.equal(modalEnterIntent(null, false), 'primary');
  // 預設（省略第二個參數）＝視為在 modal 內
  assert.equal(modalEnterIntent(fakeEl('TEXTAREA')), 'ignore');
});

test('modalEnterIntent：按鈕／下拉／連結有原生 Enter 語意 → 交給瀏覽器', () => {
  assert.equal(modalEnterIntent(fakeEl('BUTTON')), 'passthrough');
  assert.equal(modalEnterIntent(fakeEl('SELECT')), 'passthrough');
  assert.equal(modalEnterIntent(fakeEl('A')), 'passthrough');
  assert.equal(modalEnterIntent(fakeEl('INPUT', { type: 'checkbox' })), 'passthrough');
  assert.equal(modalEnterIntent(fakeEl('INPUT', { type: 'file' })), 'passthrough');
});

/* ------------------------------------------------------------------- B3 */

test('B3：預設時間軸高度裝得下 9 軌（黑桃雨實測的分列結果）', () => {
  const events = [
    { id: 'ev_rain_a', at: 0.4, type: 'emitter', duration: 8.4 },
    { id: 'ev_rain_edge', at: 2.6, type: 'emitter', duration: 5.6 },
    { id: 'ev_shake', at: 4.2, type: 'shake', duration: 0.5 },
    { id: 'ev_sfx', at: 4.2, type: 'sfx' },
    { id: 'ev_clear', at: 9.0, type: 'clear' },
    { id: 'ev_end', at: 9.9, type: 'end' },
  ];
  const layout = layoutTracks(events, { allTypes: true, minInstantSec: 1 / 30 });
  assert.equal(layout.groups.length, 9, '九種軌道一律顯示');
  assert.ok(layout.height <= TIMELINE_TRACKS_H, `9 軌內容高度 ${layout.height} 應 <= ${TIMELINE_TRACKS_H}`);
  // 面板頭 + 工具列 + 尺 + 9 軌內容 都要塞得進預設高度
  assert.ok(
    TIMELINE_CHROME_H + layout.height <= LAYOUT_DEFAULTS.timeline,
    `預設 ${LAYOUT_DEFAULTS.timeline}px 裝不下 ${TIMELINE_CHROME_H} + ${layout.height}`,
  );
  assert.equal(TIMELINE_MIN_HEIGHT, TIMELINE_CHROME_H + TIMELINE_TRACKS_H);
});

test('B3：1440×900 / 1280×720 用預設高度；太矮的視窗改用可捲動的 240px', () => {
  assert.equal(timelineHeightForViewport(900), LAYOUT_DEFAULTS.timeline);
  assert.equal(timelineHeightForViewport(768), LAYOUT_DEFAULTS.timeline);
  assert.equal(timelineHeightForViewport(720), LAYOUT_DEFAULTS.timeline);
  assert.ok(timelineHeightForViewport(900) >= TIMELINE_MIN_HEIGHT);
  // 717 是「預覽區還留得住 0.5 倍（320×240）」的門檻
  assert.equal(timelineHeightForViewport(717), LAYOUT_DEFAULTS.timeline);
  assert.equal(timelineHeightForViewport(716), 240, '再矮 1px 就退回可捲動時間軸');
  assert.equal(timelineHeightForViewport(600), 240);
  assert.equal(timelineHeightForViewport(520), 240);
  assert.ok(timelineHeightForViewport(520) < TIMELINE_MIN_HEIGHT, '矮視窗會出現捲軸');
  // 沒有 window（node）時預設 900 的行為
  assert.equal(defaultTimelineHeight(), LAYOUT_DEFAULTS.timeline);
});
