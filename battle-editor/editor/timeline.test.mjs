/**
 * editor/timeline.test.mjs — ED2 時間軸純邏輯測試
 *
 * 執行：node editor/timeline.test.mjs  （或 node --test editor/）
 * 只測試 timeline.js 的純函式，不需要 DOM / store / preview。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LOCALES, getLocale, setLocale, t } from './i18n.js';
import TIMELINE_STRINGS from './locales/timeline.js';
import {
  FPS,
  TRACK_ORDER,
  TRACK_TYPES,
  INSTANT_TYPES,
  DURATION_TYPES,
  clamp,
  roundTime,
  timeToX,
  xToTime,
  snapTime,
  chooseTicks,
  formatTick,
  eventEnd,
  layoutTracks,
  hitTestRects,
  normBox,
  rectsIntersect,
  rectsInBox,
  zoomAt,
  clampScroll,
  fitPxPerSec,
  eventSummary,
  firstBulletName,
  createDefaultEvent,
  cloneEvent,
  trackLabel,
} from './timeline.js';

/* ------------------------------------------------------------------ 基本 */

test('FPS 為 30、9 種軌道類型齊全', () => {
  assert.equal(FPS, 30);
  assert.deepEqual(TRACK_ORDER, [
    'spawn', 'emitter', 'box', 'soul', 'clear', 'shake', 'sfx', 'anim', 'end',
  ]);
  assert.equal(TRACK_TYPES.length, 9);
  assert.deepEqual([...INSTANT_TYPES].sort(), ['anim', 'clear', 'end', 'sfx', 'soul', 'spawn']);
  assert.deepEqual([...DURATION_TYPES].sort(), ['box', 'emitter', 'shake']);
  for (const t of TRACK_TYPES) {
    assert.equal(typeof t.label, 'string');
    assert.match(t.color, /^#[0-9a-f]{6}$/i);
  }
});

test('clamp / roundTime', () => {
  assert.equal(clamp(5, 0, 10), 5);
  assert.equal(clamp(-1, 0, 10), 0);
  assert.equal(clamp(99, 0, 10), 10);
  assert.equal(roundTime(0.1 + 0.2), 0.3);
  assert.equal(roundTime(1 / 3), 0.333333333);
  assert.equal(roundTime(1 / 30), 0.033333333);
});

/* ------------------------------------------------------------ 時間↔像素 */

test('timeToX / xToTime 互為反函式', () => {
  const view = { scrollSec: 1.5, pxPerSec: 120, gutter: 96 };
  for (const t of [0, 0.5, 1.5, 3.25, 10]) {
    const x = timeToX(t, view);
    assert.ok(Math.abs(xToTime(x, view) - t) < 1e-9, `t=${t}`);
  }
  // 左側 gutter 起點 = 時間軸 0 的位置
  assert.equal(timeToX(0, { ...view, scrollSec: 0 }), 96);
  // 1 秒 = pxPerSec 像素
  assert.equal(
    timeToX(2, { scrollSec: 0, pxPerSec: 100, gutter: 96 }) -
      timeToX(1, { scrollSec: 0, pxPerSec: 100, gutter: 96 }),
    100,
  );
});

test('snapTime：預設吸附 1/30 秒，Shift（coarse）吸附 0.1 秒', () => {
  assert.equal(snapTime(0.49, {}), 0.5);           // 0.49*30=14.7 → 15 → 0.5
  // 即使吸附後再乘 30 會有浮點誤差，也應對應到最接近的整數幀
  for (const v of [0.013, 0.137, 1.004, 7.999]) {
    const s = snapTime(v, {});
    assert.ok(Math.abs(s * FPS - Math.round(s * FPS)) < 1e-4, `v=${v} → ${s}`);
  }
  // 結果一定是 1/30 的整數倍（以幀序號驗證）
  assert.equal(Math.round(snapTime(0.013, {}) * FPS), 0);
  assert.equal(Math.round(snapTime(0.137, {}) * FPS), 4);
  // coarse
  assert.equal(snapTime(0.13, { coarse: true }), 0.1);
  assert.equal(snapTime(0.16, { coarse: true }), 0.2);
  assert.equal(snapTime(1.0, { coarse: true }), 1);
  // 自訂 step
  assert.equal(snapTime(0.34, { step: 0.5 }), 0.5);
  // 無效 step 不崩
  assert.equal(snapTime(0.34, { step: 0 }), 0.34);
});

test('chooseTicks：拉遠拉近都給出合理刻度', () => {
  const close = chooseTicks(600);      // 每幀 20px，很寬
  assert.ok(close.frameTicks, '高縮放要看得見單幀格線');
  assert.ok(close.major * 600 >= 74);
  assert.ok(close.minor < close.major);

  const far = chooseTicks(12);         // 8 秒約 96px
  assert.equal(far.frameTicks, false);
  assert.ok(far.minor >= 1, '低縮放細格不應小於 1 秒');
  assert.ok(far.major >= 2);

  const mid = chooseTicks(90);
  assert.ok(mid.minor <= mid.major);

  // 任何縮放下的刻度都要遞增且有限
  for (const pps of [6, 20, 60, 150, 400, 1200, 3000]) {
    const t = chooseTicks(pps);
    assert.ok(Number.isFinite(t.major) && Number.isFinite(t.minor));
    assert.ok(t.major >= t.minor);
    assert.ok(t.major * pps >= 74, `pps=${pps} 主刻度間距應 >= 74px`);
  }
});

test('formatTick', () => {
  assert.equal(formatTick(1, 1), '1s');
  assert.equal(formatTick(2.5, 2.5), '2.5s');
  assert.equal(formatTick(10, 10), '10s');
  assert.equal(formatTick(0.1, 0.1), '0.10s');
  assert.equal(formatTick(0.9, 0.1), '0.90s');
});

/* -------------------------------------------------------------- 事件長度 */

test('eventEnd：有時長用 at+duration，瞬時給最小寬度', () => {
  assert.equal(eventEnd({ at: 2, duration: 1.5 }), 3.5);
  assert.equal(eventEnd({ at: 2 }), 2);
  assert.equal(eventEnd({ at: 2, duration: 0 }), 2);
  assert.equal(eventEnd({ at: 2, duration: -1 }), 2);
  assert.equal(eventEnd({ at: 2, duration: 'x' }), 2);
  assert.equal(eventEnd({ at: 2 }, 1 / FPS), 2 + 1 / FPS);
  assert.equal(eventEnd(null), 0);
});

/* ---------------------------------------------------------- 分列（排版） */

test('layoutTracks：每類一列、重疊自動分子列', () => {
  const events = [
    { id: 'a', at: 1.0, type: 'spawn' },
    { id: 'b', at: 1.0, type: 'spawn' },     // 與 a 同時 → 第二子列
    { id: 'c', at: 2.0, type: 'spawn' },     // 第一子列已空 → 回填第一列
    { id: 'd', at: 0.5, duration: 3, type: 'box' },
    { id: 'e', at: 1.0, duration: 1, type: 'box' }, // 與 d 重疊 → 第二子列
    { id: 'f', at: 4.5, duration: 1, type: 'box' }, // 不重疊 → 第一子列
    { id: 'g', at: 0, type: 'clear' },
    { id: 'h', at: 0, type: 'end' },
  ];
  const out = layoutTracks(events, { rowHeight: 20, groupGap: 4, padTop: 2, minInstantSec: 1 / FPS });

  const byType = Object.fromEntries(out.groups.map((g) => [g.type, g]));
  // 只有出現事件的類型才產生群組，且順序照 TRACK_ORDER
  assert.deepEqual(out.groups.map((g) => g.type), ['spawn', 'box', 'clear', 'end']);

  assert.equal(byType.spawn.laneCount, 2);
  assert.equal(byType.box.laneCount, 2);
  assert.equal(byType.clear.laneCount, 1);

  const laneOf = (id) => {
    for (const g of out.groups) {
      const it = g.items.find((x) => x.id === id);
      if (it) return it.lane;
    }
    return -1;
  };
  assert.equal(laneOf('a'), 0);
  assert.equal(laneOf('b'), 1);
  assert.equal(laneOf('c'), 0, '重疊解除後應回填第一子列');
  assert.equal(laneOf('d'), 0);
  assert.equal(laneOf('e'), 1);
  assert.equal(laneOf('f'), 0, 'd 到 3.5 結束、f 從 4.5 開始 → 應回填第一子列');

  // 事件 y 座標不重疊（同類型內）
  const ys = new Set();
  for (const it of byType.spawn.items) ys.add(it.y);
  assert.equal(ys.size, 2);

  // 群組垂直排列不重疊
  let prevBottom = -Infinity;
  for (const g of out.groups) {
    assert.ok(g.y >= prevBottom, '群組之間不應重疊');
    prevBottom = g.y + g.h;
  }
  assert.ok(out.height > 0);
});

test('layoutTracks：時長條會佔用時間範圍，瞬時事件也佔最小寬度', () => {
  // 同一幀的兩個瞬時事件視為重疊
  const a = layoutTracks(
    [
      { id: 'x', at: 1, type: 'sfx' },
      { id: 'y', at: 1, type: 'sfx' },
    ],
    { minInstantSec: 1 / FPS },
  );
  assert.equal(a.groups[0].laneCount, 2);

  // 相隔一幀以上就不重疊
  const b = layoutTracks(
    [
      { id: 'x', at: 1, type: 'sfx' },
      { id: 'y', at: 1 + 2 / FPS, type: 'sfx' },
    ],
    { minInstantSec: 1 / FPS },
  );
  assert.equal(b.groups[0].laneCount, 1);
});

test('layoutTracks：不同類型互不影響、未知類型與壞資料不崩', () => {
  const events = [
    { id: 'a', at: 1, type: 'spawn' },
    { id: 'b', at: 1, type: 'soul' },
    null,
    { id: 'c', at: 'x', type: 'spawn' },     // at 非數字 → 略過
    { id: 'd', type: 'spawn' },              // 無 at → 略過
    { id: 'e', at: 1, type: 'weird' },       // 未知類型 → 最後一組
  ];
  const out = layoutTracks(events);
  assert.deepEqual(out.groups.map((g) => g.type), ['spawn', 'soul', 'weird']);
  assert.equal(out.groups[0].laneCount, 1);
  assert.equal(out.groups[1].laneCount, 1);

  // 空清單
  const empty = layoutTracks([]);
  assert.deepEqual(empty.groups, []);
  assert.ok(empty.height > 0);
  assert.doesNotThrow(() => layoutTracks(null));
});

test('layoutTracks：同類型內以 at 排序', () => {
  const out = layoutTracks([
    { id: 'late', at: 5, type: 'spawn' },
    { id: 'early', at: 1, type: 'spawn' },
    { id: 'mid', at: 3, type: 'spawn' },
  ]);
  assert.deepEqual(out.groups[0].items.map((i) => i.id), ['early', 'mid', 'late']);
});

test('layoutTracks：200 個事件仍能在一幀時間內算完', () => {
  const types = TRACK_ORDER;
  const events = [];
  for (let i = 0; i < 200; i++) {
    const type = types[i % types.length];
    events.push({ id: `e${i}`, at: (i % 40) * 0.2, type, duration: type === 'box' ? 0.5 : undefined });
  }
  const t0 = performance.now();
  const out = layoutTracks(events);
  const dt = performance.now() - t0;
  assert.equal(out.groups.length, 9);
  assert.ok(out.height > 0);
  assert.ok(dt < 100, `分列耗時 ${dt.toFixed(1)}ms，應遠低於 100ms`);
});

/* ------------------------------------------------------------ 命中測試 */

test('hitTestRects：由後往前（上層優先）', () => {
  const rects = [
    { id: 'under', x: 0, y: 0, w: 100, h: 20 },
    { id: 'over', x: 10, y: 0, w: 20, h: 20 },
  ];
  assert.equal(hitTestRects(rects, 15, 10).id, 'over');
  assert.equal(hitTestRects(rects, 60, 10).id, 'under');
  assert.equal(hitTestRects(rects, 500, 10), null);
  assert.equal(hitTestRects(null, 0, 0), null);
});

test('normBox / rectsIntersect / rectsInBox', () => {
  assert.deepEqual(normBox({ x: 10, y: 20 }, { x: 0, y: 5 }), { x: 0, y: 5, w: 10, h: 15 });
  assert.deepEqual(normBox({ x: 0, y: 0 }, { x: 4, y: 6 }), { x: 0, y: 0, w: 4, h: 6 });

  const a = { x: 0, y: 0, w: 10, h: 10 };
  assert.ok(rectsIntersect(a, { x: 5, y: 5, w: 10, h: 10 }));
  assert.ok(rectsIntersect(a, { x: 10, y: 10, w: 1, h: 1 }), '邊界接觸算相交');
  assert.ok(!rectsIntersect(a, { x: 11, y: 0, w: 10, h: 10 }));

  const rects = [
    { id: 'a', x: 0, y: 0, w: 10, h: 10 },
    { id: 'b', x: 20, y: 0, w: 10, h: 10 },
    { id: 'c', x: 5, y: 5, w: 10, h: 10 },
    { id: 'a', x: 0, y: 0, w: 10, h: 10 },   // 重複 id 只回一次
  ];
  const hit = rectsInBox(rects, { x: 0, y: 0, w: 12, h: 12 });
  assert.deepEqual(hit.map((r) => r.id), ['a', 'c']);
});

/* -------------------------------------------------------------- 縮放／捲動 */

test('zoomAt：錨點底下的時間不變', () => {
  const base = { pxPerSec: 100, scrollSec: 2, gutter: 96, anchorX: 400, min: 6, max: 3000 };
  const anchorTime = base.scrollSec + (base.anchorX - base.gutter) / base.pxPerSec;

  for (const factor of [1.2, 0.8, 4, 0.25]) {
    const r = zoomAt({ ...base, factor });
    const t = r.scrollSec + (base.anchorX - base.gutter) / r.pxPerSec;
    assert.ok(Math.abs(t - anchorTime) < 1e-9, `factor=${factor}`);
    assert.ok(r.pxPerSec > 0);
  }
});

test('zoomAt：夾在 min/max 之間', () => {
  const small = zoomAt({ pxPerSec: 100, scrollSec: 0, anchorX: 200, gutter: 96, factor: 0.001, min: 6, max: 3000 });
  assert.equal(small.pxPerSec, 6);
  const big = zoomAt({ pxPerSec: 100, scrollSec: 0, anchorX: 200, gutter: 96, factor: 10000, min: 6, max: 3000 });
  assert.equal(big.pxPerSec, 3000);
});

test('clampScroll：不超過內容尾端、不為負', () => {
  // 8 秒、100px/s、可用寬 900px → 可視 9 秒 > 8.5 秒內容 → 不需捲動
  assert.equal(clampScroll(5, 100, 1000, 96, 8), 0);
  // 放大後：可用 896px / 600px/s = 1.4933 秒可視；上限 = 8.5 - 1.4933 = 7.0067
  assert.equal(clampScroll(-3, 600, 1000, 96, 8), 0);
  const maxScroll = 8 + 0.5 - 896 / 600;
  assert.ok(Math.abs(clampScroll(999, 600, 1000, 96, 8) - maxScroll) < 1e-9);
  assert.equal(clampScroll(3, 600, 1000, 96, 8), 3);
});

test('fitPxPerSec：讓 duration 剛好塞進可用寬度', () => {
  const pps = fitPxPerSec(1000, 96, 8);
  assert.ok(pps > 0);
  const usable = Math.max(24, 1000 - 96 - 28);
  assert.ok(Math.abs(pps - usable / 8) < 1e-6);

  // 太短或太長都要夾在界限內
  assert.ok(fitPxPerSec(200, 96, 600) >= 6);
  assert.ok(fitPxPerSec(5000, 96, 0.25) <= 3000);
  assert.ok(Number.isFinite(fitPxPerSec(100, 96, 0)));
});

/* ---------------------------------------------------------------- 摘要 */

test('eventSummary：label 優先，否則給簡短摘要', () => {
  assert.equal(eventSummary({ type: 'spawn', bullet: 'spade', label: '黑桃雨' }), '黑桃雨');
  assert.equal(eventSummary({ type: 'spawn', bullet: 'spade', count: 3 }), 'spade×3');
  assert.equal(eventSummary({ type: 'spawn', bullet: 'spade', count: 1 }), 'spade');
  assert.equal(eventSummary({ type: 'emitter', interval: 0.2, count: 2, spawn: { bullet: 'bone' } }), 'bone 0.2s/×2');
  assert.ok(eventSummary({ type: 'box', to: { x: 1, y: 2 } }).startsWith('→'));
  assert.equal(eventSummary({ type: 'box', to: {} }), '→');
  // 以下含介面文字 → 用目前語系的字串表比對，測試不綁死某一語系
  const S = TIMELINE_STRINGS[getLocale()] || TIMELINE_STRINGS['zh-Hant'];
  assert.equal(eventSummary({ type: 'soul', mode: 'red' }), S['summary.mode'].replace('{mode}', 'red'));
  assert.equal(eventSummary({ type: 'soul' }), S['summary.soul']);
  assert.equal(eventSummary({ type: 'clear', fade: 0.3 }), S['summary.fade'].replace('{fade}', '0.3'));
  assert.equal(eventSummary({ type: 'clear' }), S['summary.clear']);
  assert.equal(eventSummary({ type: 'sfx' }), S['summary.noSound']);
  assert.equal(eventSummary({ type: 'sfx', sound: 'boom' }), 'boom');
  assert.equal(eventSummary({ type: 'end' }), S['summary.end']);
  assert.equal(eventSummary({ type: 'shake', duration: 0.5, amount: 6 }), '6px 0.5s');
  assert.equal(eventSummary({ type: 'nope' }), 'nope');
  assert.equal(eventSummary(null), '');
  // 空字串 label 不算 label
  assert.equal(eventSummary({ type: 'spawn', bullet: 'x', count: 2, label: '   ' }), 'x×2');
});

test('eventSummary：三語下都有非空輸出（SPEC §10.1）', () => {
  const prev = getLocale();
  try {
    for (const loc of LOCALES) {
      setLocale(loc.id);
      assert.equal(getLocale(), loc.id, `切換到 ${loc.id} 失敗`);
      for (const type of TRACK_ORDER) {
        const ev = createDefaultEvent(type, 1, { newId: (p) => `${p}-x` });
        const s = eventSummary(ev);
        assert.equal(typeof s, 'string', `${loc.id}/${type} 摘要不是字串`);
        assert.ok(s.trim().length > 0, `${loc.id}/${type} 摘要為空`);
      }
      // 各語系的摘要文字不應是未翻譯的 key
      assert.ok(!eventSummary({ type: 'end' }).includes('timeline.'), `${loc.id} end 摘要漏翻`);
      assert.ok(!eventSummary({ type: 'sfx' }).includes('timeline.'), `${loc.id} sfx 摘要漏翻`);
    }
  } finally {
    setLocale(prev);
  }
});

test('locales/timeline.js：三語鍵集合一致且無空字串', () => {
  const locales = Object.keys(TIMELINE_STRINGS);
  assert.deepEqual(locales.sort(), ['en', 'zh-Hans', 'zh-Hant']);
  const base = Object.keys(TIMELINE_STRINGS['zh-Hant']).sort();
  assert.ok(base.length > 0);
  for (const loc of locales) {
    const keys = Object.keys(TIMELINE_STRINGS[loc]).sort();
    assert.deepEqual(keys, base, `${loc} 的鍵集合與 zh-Hant 不一致`);
    for (const k of keys) {
      assert.equal(typeof TIMELINE_STRINGS[loc][k], 'string', `${loc}/${k} 不是字串`);
      assert.ok(TIMELINE_STRINGS[loc][k].length > 0, `${loc}/${k} 是空字串`);
    }
  }
  // 佔位符也要三語一致（避免某語系漏掉 {n} / {frame} 之類）
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join(',');
  for (const k of base) {
    const want = ph(TIMELINE_STRINGS['zh-Hant'][k]);
    for (const loc of locales) {
      assert.equal(ph(TIMELINE_STRINGS[loc][k]), want, `${loc}/${k} 的佔位符不一致`);
    }
  }
});

test('t()：三語都查得到 timeline.* 字串且會替換參數', () => {
  const prev = getLocale();
  try {
    for (const loc of LOCALES) {
      setLocale(loc.id);
      const table = TIMELINE_STRINGS[loc.id];
      for (const k of Object.keys(table)) {
        const s = t(`timeline.${k}`);
        assert.equal(typeof s, 'string');
        assert.ok(s.length > 0);
        assert.ok(!s.startsWith('timeline.'), `${loc.id} 缺少 timeline.${k}`);
      }
      assert.equal(
        t('timeline.ruler.frames', { n: 240 }),
        table['ruler.frames'].replace('{n}', '240'),
      );
    }
  } finally {
    setLocale(prev);
  }
});

test('trackLabel / TRACK_TYPES.label 會跟著語系變', () => {
  const prev = getLocale();
  try {
    setLocale('zh-Hant');
    assert.equal(trackLabel('spawn'), TIMELINE_STRINGS['zh-Hant']['track.spawn']);
    setLocale('en');
    assert.equal(trackLabel('spawn'), TIMELINE_STRINGS.en['track.spawn']);
    assert.equal(TRACK_TYPES[0].label, TIMELINE_STRINGS.en['track.spawn']);
    setLocale('zh-Hans');
    assert.equal(trackLabel('spawn'), TIMELINE_STRINGS['zh-Hans']['track.spawn']);
    // 未知類型退回「其他」
    assert.equal(trackLabel('nope'), TIMELINE_STRINGS['zh-Hans']['track.other']);
  } finally {
    setLocale(prev);
  }
});

test('timeline 命名空間已向 i18n 註冊（import 即生效）', () => {
  const prev = getLocale();
  try {
    for (const loc of LOCALES) {
      setLocale(loc.id);
      // 未註冊時 t() 會回傳 key 本身；能查到代表 registerStrings 已在模組頂部跑過
      assert.equal(t('timeline.track.spawn'), TIMELINE_STRINGS[loc.id]['track.spawn']);
      assert.equal(t('timeline.empty'), TIMELINE_STRINGS[loc.id].empty);
    }
  } finally {
    setLocale(prev);
  }
});

test('firstBulletName：取第一個子彈類型，否則 "bullet"', () => {
  assert.equal(firstBulletName({ bulletTypes: { spade: {}, bone: {} } }), 'spade');
  assert.equal(firstBulletName({ bulletTypes: {} }), 'bullet');
  assert.equal(firstBulletName({}), 'bullet');
  assert.equal(firstBulletName(null), 'bullet');
});

/* ------------------------------------------------------------ 預設事件 */

test('createDefaultEvent：八種類型都有合理預設值與 id', () => {
  const attack = {
    bulletTypes: { spade: {} },
    box: { x: 300, y: 160, w: 140, h: 120 },
    soul: { mode: 'red' },
  };
  let n = 0;
  const opts = { newId: (prefix) => `${prefix}-${++n}`, attack, sfxName: 'hit' };

  const spawn = createDefaultEvent('spawn', 1.234, opts);
  assert.equal(spawn.type, 'spawn');
  assert.equal(spawn.id, 'spawn-1');
  assert.equal(spawn.at, 1.234);
  assert.equal(spawn.bullet, 'spade');
  assert.equal(spawn.count, 1);
  assert.equal(spawn.x, 300);
  assert.equal(spawn.angle, 90);

  const emitter = createDefaultEvent('emitter', 2, opts);
  assert.equal(emitter.type, 'emitter');
  assert.ok(emitter.duration > 0);
  assert.ok(emitter.interval > 0);
  assert.equal(emitter.spawn.bullet, 'spade');
  assert.equal(emitter.spawn.x, 300);

  const box = createDefaultEvent('box', 0, opts);
  assert.equal(box.type, 'box');
  assert.ok(['linear', 'quadIn', 'quadOut', 'quadInOut', 'sineInOut', 'backOut'].includes(box.ease));
  assert.deepEqual(box.to, { x: 300, y: 160, w: 140, h: 120 });

  const soul = createDefaultEvent('soul', 0, opts);
  assert.equal(soul.mode, 'red');

  const clear = createDefaultEvent('clear', 0, opts);
  assert.ok(clear.fade >= 0);

  const shake = createDefaultEvent('shake', 0, opts);
  assert.ok(shake.duration > 0 && shake.amount > 0);

  const sfx = createDefaultEvent('sfx', 0, opts);
  assert.equal(sfx.sound, 'hit', '有素材時用第一個音效名');

  const end = createDefaultEvent('end', 0, opts);
  assert.equal(end.type, 'end');
  assert.ok(end.id);

  // 負數 at 會被夾到 0；每個 id 都不同
  assert.equal(createDefaultEvent('spawn', -5, opts).at, 0);
  const ids = new Set([
    createDefaultEvent('spawn', 0, opts).id,
    createDefaultEvent('spawn', 0, opts).id,
  ]);
  assert.equal(ids.size, 2);
});

test('createDefaultEvent：沒有 store.newId 時仍能產生唯一 id', () => {
  const a = createDefaultEvent('spawn', 0, {});
  const b = createDefaultEvent('spawn', 0, {});
  assert.ok(a.id && b.id);
  assert.notEqual(a.id, b.id);
  // 沒有 attack 也能建立
  assert.equal(createDefaultEvent('spawn', 1, {}).bullet, 'bullet');
});

test('cloneEvent：深拷貝、彼此獨立', () => {
  const ev = { id: 'a', at: 1, type: 'emitter', spawn: { bullet: 'x', angle: 90 } };
  const copy = cloneEvent(ev);
  assert.notEqual(copy, ev);
  assert.notEqual(copy.spawn, ev.spawn);
  assert.deepEqual(copy, ev);
  copy.spawn.angle = 0;
  assert.equal(ev.spawn.angle, 90);
});
