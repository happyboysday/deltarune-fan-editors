/**
 * editor/feature-v206.test.mjs — V2-06 新功能的整合式單元測試
 *
 * 這裡測「純函式層」的跨模組行為（不開瀏覽器）：
 *   1. 字串時間（`"2b"`）在時間軸 / demo 路徑 / 預覽長度計算中一致
 *   2. 拍點吸附計算（含 Shift 暫時切換）在 timeline 的 snapTimeBeat
 *   3. demo-gen 的結果正規化（套用到 demo.path 前後）
 *   4. 軌跡資料（traceDemo 的 frames / hits）→ 疊加層需要的形狀
 *
 * 執行：node --test editor/feature-v206.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildDemoFromResult,
  nextDemoForResult,
  normalizeGenOptions,
  normalizeProgress,
  summarizeGenResult,
  GEN_DEFAULTS,
} from './demo-gen.js';
import {
  normalizeDemoPath,
  setDemoPointField,
  buildDemoTimeline,
  demoPathDuration,
} from './demo-path.js';
import {
  eventStartSec,
  eventDurationSec,
  eventEnd,
  snapTimeBeat,
  layoutTracks,
  snapTime,
} from './timeline.js';
import { normalizeTiming, parseTime, timePointSeconds, timeLengthSeconds } from './beat.js';

const B120 = { bpm: 120, beatOffset: 0 }; // 一拍 0.5s
const TIMING = normalizeTiming(B120);

/* ------------------------------------------------ 1. 字串時間的一致性 */

test('字串時間：timeline / demo-path / preview 用同一套換算（bpm 120）', () => {
  // 事件 at 用 "2b" → 1 秒（時間點加 beatOffset）
  assert.equal(eventStartSec({ at: '2b' }, TIMING), 1);
  // duration 用 "2b" → 也是 1 秒（長度不加 beatOffset）
  assert.equal(eventDurationSec({ duration: '2b' }, TIMING), 1);
  assert.equal(eventEnd({ at: '1b', duration: '2b' }, 0, TIMING), 0.5 + 1);
  // 沒有 timing 時字串不解析（避免舊測試與壞檔被誤判）
  assert.equal(eventStartSec({ at: '2b' }, null), null);
  assert.equal(eventStartSec({ at: '2b' }), null);
  // 純數字字串在沒有 timing 時仍視為秒（舊檔相容）
  assert.equal(eventStartSec({ at: '1.5' }, null), 1.5);
  // demo 路徑的 t 同樣吃拍點字串
  const points = normalizeDemoPath([{ t: '2b', x: 10, y: 20 }], { timing: B120 });
  assert.equal(points.length, 1);
  assert.equal(points[0].t, 1);
  // 沒有 bpm 的檔案：字串 t 被丟掉（引擎也會報錯）
  assert.equal(normalizeDemoPath([{ t: '2b', x: 10, y: 20 }]).length, 0);
});

test('字串時間：beatOffset 只影響時間點，不影響長度（SPEC-EXPR-V2 §1.3）', () => {
  const timing = normalizeTiming({ bpm: 120, beatOffset: 0.25 });
  assert.equal(timePointSeconds('2b', timing), 1.25);
  assert.equal(timeLengthSeconds('2b', timing), 1);
  assert.equal(eventStartSec({ at: '2b' }, timing), 1.25);
  assert.equal(eventDurationSec({ duration: '2b' }, timing), 1);
});

test('字串時間：demo.path 的 t 保留使用者寫法（setDemoPointField + formatLike）', () => {
  const points = [{ t: '2b', x: 10, y: 20 }, { t: '4b', x: 30, y: 40 }];
  // 拖到 2.5b（= 1.25 秒）：原本是拍點字串 → 寫回拍點字串
  const next = setDemoPointField(points, 0, 't', '2.5b', { timing: B120 });
  assert.equal(typeof next[0].t, 'string');
  assert.equal(next[0].t, '2.5b');
  // 用秒數寫入（0.75 秒）但原本是拍點寫法 → 仍以拍點表示（1.5b），寫法一致
  const next2 = setDemoPointField(points, 0, 't', 0.75, { timing: B120 });
  assert.equal(next2[0].t, '1.5b');
  // 原本是數字的點 → 維持數字秒
  const nums = [{ t: 0, x: 10, y: 20 }, { t: 1, x: 30, y: 40 }];
  assert.equal(setDemoPointField(nums, 0, 't', 0.5, { timing: B120 })[0].t, 0.5);
});

test('字串時間：layoutTracks 在有 timing 時把 "2b" 事件排進軌道', () => {
  const events = [
    { id: 'a', type: 'spawn', at: '2b' },
    { id: 'b', type: 'spawn', at: 1 },
  ];
  const layout = layoutTracks(events, { timing: TIMING, allTypes: true });
  const spawn = layout.groups.find((g) => g.type === 'spawn');
  assert.equal(spawn.items.length, 2);
  assert.deepEqual(spawn.items.map((it) => it.start), [1, 1]);
  // 沒有 timing 時字串事件被略過（既有行為，不能回歸）
  const noTiming = layoutTracks(events, { allTypes: true });
  const spawn2 = noTiming.groups.find((g) => g.type === 'spawn');
  assert.equal(spawn2.items.length, 1);
  assert.equal(spawn2.items[0].id, 'b');
});

test('字串時間：demoPathDuration 會把拍點字串算進去', () => {
  const points = [{ t: '2b', x: 10, y: 20 }, { t: '4b', x: 30, y: 40 }];
  assert.equal(demoPathDuration(points, { timing: B120 }), 2);
  const tl = buildDemoTimeline(points, { timing: B120 });
  assert.equal(tl.starts.length, 2);
  assert.equal(tl.starts[0], 1);
  assert.equal(tl.starts[1], 2);
});

/* ------------------------------------------------ 2. 拍點吸附計算 */

test('拍點吸附：有 bpm 預設吸到拍線，Shift 暫時關閉（V2-06 規格）', () => {
  // 0.26 秒 → 最近的拍線 0.5（bpm 120）
  assert.equal(snapTimeBeat(0.26, TIMING, { beat: true }), 0.5);
  assert.equal(snapTimeBeat(0.24, TIMING, { beat: true }), 0);
  // Shift（beat:false）→ 回到原本的幀吸附
  assert.equal(snapTimeBeat(0.26, TIMING, { beat: false }), snapTime(0.26, {}));
  // 沒有 bpm → 幀吸附
  assert.equal(snapTimeBeat(0.26, null, { beat: true }), snapTime(0.26, {}));
});

test('拍點吸附：拖曳換算（origAt + delta 後吸附）不會產生負值', () => {
  const timing = TIMING;
  const origAt = 0.1;
  const delta = -0.5;
  const snapped = Math.max(0, snapTimeBeat(origAt + delta, timing, { beat: true }));
  assert.equal(snapped, 0);
  const snapped2 = Math.max(0, snapTimeBeat(0.9, timing, { beat: true }));
  assert.equal(snapped2, 1);
});

/* ------------------------------------------------ 3. demo-gen 正規化 */

test('demo-gen：normalizeGenOptions 夾住時間預算與 seed', () => {
  assert.deepEqual(normalizeGenOptions(null), {
    seed: GEN_DEFAULTS.seed,
    step: GEN_DEFAULTS.step,
    timeBudgetMs: GEN_DEFAULTS.timeBudgetMs,
  });
  const o = normalizeGenOptions({ seed: 7.9, step: 0, timeBudgetMs: 999999 });
  assert.equal(o.seed, 7);
  assert.equal(o.step, GEN_DEFAULTS.step, 'step 0 不合法 → 用預設');
  assert.equal(o.timeBudgetMs, 120000, '上限 120 秒');
  assert.equal(normalizeGenOptions({ timeBudgetMs: 1 }).timeBudgetMs, 200, '下限 200ms');
});

test('demo-gen：normalizeProgress 對缺欄位給安全預設', () => {
  assert.deepEqual(normalizeProgress(null), {
    phase: '', sweep: 0, index: 0, nodes: 0, hits: 0, firstHit: null, bestCost: null, elapsedMs: 0,
  });
  const p = normalizeProgress({ phase: 'optimize', sweep: 2, hits: 1, elapsedMs: 120.5 });
  assert.equal(p.phase, 'optimize');
  assert.equal(p.sweep, 2);
  assert.equal(p.hits, 1);
  assert.equal(p.elapsedMs, 120.5);
});

test('demo-gen：buildDemoFromResult 丟掉壞點、截斷上限、保留 slow/hold', () => {
  const demo = buildDemoFromResult({
    demo: {
      mode: 'path',
      fallback: 'bot',
      path: [
        { t: 0, x: 10, y: 20 },
        { t: 'x', x: 1, y: 1 },      // 壞點
        { t: 0.5, x: 30, y: 40, slow: true, hold: 0.25 },
        null,
        { t: -1, x: 1, y: 2 },       // 負時間被夾到 0
      ],
    },
  });
  assert.equal(demo.mode, 'path');
  assert.equal(demo.fallback, 'bot');
  assert.equal(demo.path.length, 3);
  assert.deepEqual(demo.path[1], { t: 0.5, x: 30, y: 40, slow: true, hold: 0.25 });
  assert.equal(demo.path[2].t, 0);
});

test('demo-gen：nextDemoForResult 空路徑回 null（呼叫端維持原狀）', () => {
  assert.equal(nextDemoForResult({ demo: { path: [] } }), null);
  assert.equal(nextDemoForResult(null), null);
  const ok = nextDemoForResult({ path: [{ t: 0, x: 1, y: 2 }] });
  assert.equal(ok.path.length, 1);
  assert.equal(ok.mode, 'path');
});

test('demo-gen：summarizeGenResult 摘要（hits / hitFrames / reason）', () => {
  const s = summarizeGenResult({
    ok: true,
    hits: [{ frame: 1 }],
    hitFrames: [1],
    attempts: 4,
    elapsedMs: 1234,
    demo: { path: [{ t: 0, x: 1, y: 2 }] },
  });
  assert.equal(s.ok, true);
  assert.equal(s.hits, 1);
  assert.deepEqual(s.hitFrames, [1]);
  assert.equal(s.attempts, 4);
  assert.equal(s.elapsedMs, 1234);
  assert.equal(s.reason, 'ok');
  // 被取消 / 沒有路徑點 → ok=false
  assert.equal(summarizeGenResult({ aborted: true, demo: { path: [] } }).ok, false);
  assert.equal(summarizeGenResult({ reason: 'aborted', demo: { path: [{ t: 0, x: 1, y: 2 }] } }).aborted, true);
});

/* ------------------------------------------------ 4. 軌跡資料形狀 */

test('軌跡疊圖：traceDemo 的 frames 可直接轉成 polyline 座標（只取 actual）', () => {
  const frames = [
    { frame: 0, target: { x: 100, y: 100 }, actual: { x: 100, y: 100 }, hit: false },
    { frame: 1, target: { x: 110, y: 100 }, actual: { x: 101, y: 100 }, hit: false },
    { frame: 2, target: { x: 120, y: 100 }, actual: { x: 102, y: 100 }, hit: true },
  ];
  const polyline = frames
    .filter((f) => f && f.actual && Number.isFinite(f.actual.x) && Number.isFinite(f.actual.y))
    .map((f) => `${f.actual.x},${f.actual.y}`);
  assert.deepEqual(polyline, ['100,100', '101,100', '102,100']);
  // 預定路線是 target
  const targetLine = frames.map((f) => `${f.target.x},${f.target.y}`);
  assert.deepEqual(targetLine, ['100,100', '110,100', '120,100']);
});

test('軌跡疊圖：命中幀標記只用 hits（frame / x / y）', () => {
  const hits = [{ frame: 52, x: 320, y: 190, type: 'spade', damage: 12 }];
  const marks = hits
    .filter((h) => Number.isFinite(h.x) && Number.isFinite(h.y))
    .map((h) => ({ cx: h.x, cy: h.y, label: `f${h.frame}` }));
  assert.deepEqual(marks, [{ cx: 320, cy: 190, label: 'f52' }]);
});
