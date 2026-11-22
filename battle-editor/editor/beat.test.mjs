/**
 * editor/beat.test.mjs — V2-06 拍點（BPM）純邏輯測試
 *
 * 覆蓋 SPEC-EXPR-V2 §1–§2 與 ROADMAP-V2 §1 的決策：
 *   - 時間點欄位（at / demo t）加 beatOffset；長度欄位（duration / interval / fade…）不加
 *   - 沒有 bpm 時用拍點字串 → 明確錯誤（不靜默變 0）
 *   - 存檔保留使用者寫法（formatLike）
 *   - 時間軸拍線（beatTimes）與拍點吸附（snapToBeat）
 *
 * 執行：node --test editor/beat.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BEAT_MAJOR_EVERY,
  beatPosition,
  beatSnapMode,
  beatTimes,
  beatsOf,
  formatLike,
  formatSeconds,
  formatTimeRaw,
  isBeatString,
  normalizeTiming,
  parseTime,
  secondsToBeatString,
  shiftBeat,
  snapToBeat,
  timeLengthSeconds,
  timePointSeconds,
  totalBeats,
  cleanSeconds,
} from './beat.js';

const NO_BPM = { bpm: null, beatOffset: 0 };
const B120 = { bpm: 120, beatOffset: 0 };     // 一拍 = 0.5 秒
const B120_OFF = { bpm: 120, beatOffset: 0.25 };

/* ------------------------------------------------------------ normalizeTiming */

test('normalizeTiming：沒有 bpm → hasBpm false、beatSec 0', () => {
  for (const src of [null, undefined, {}, { bpm: null }, { bpm: 0 }, { bpm: -1 }, { bpm: 'x' }]) {
    const t = normalizeTiming(src);
    assert.equal(t.hasBpm, false, `src=${JSON.stringify(src)}`);
    assert.equal(t.bpm, null);
    assert.equal(t.beatSec, 0);
    assert.equal(t.beatOffset, 0);
  }
});

test('normalizeTiming：bpm 120 → beatSec 0.5、beatOffset 保留', () => {
  const plain = normalizeTiming({ bpm: 120 });
  assert.deepEqual(
    { bpm: plain.bpm, hasBpm: plain.hasBpm, beatSec: plain.beatSec, beatOffset: plain.beatOffset },
    { bpm: 120, hasBpm: true, beatSec: 0.5, beatOffset: 0 },
  );
  const off = normalizeTiming({ bpm: 120, beatOffset: 0.25 });
  assert.equal(off.beatOffset, 0.25);
  // 非數字 beatOffset → 0（引擎驗證會另外報錯，這裡不讓計算爆掉）
  assert.equal(normalizeTiming({ bpm: 120, beatOffset: 'x' }).beatOffset, 0);
});

test('normalizeTiming：可重複套用（已正規化的 timing 再丟進去結果相同）', () => {
  const a = normalizeTiming(B120_OFF);
  const b = normalizeTiming(a);
  assert.deepEqual(b, a);
});

/* ------------------------------------------------------------------ parseTime */

test('parseTime：數字＝秒（不因 bpm 改變）', () => {
  assert.deepEqual(parseTime(2, B120).seconds, 2);
  assert.equal(parseTime(2.5, NO_BPM).seconds, 2.5);
  assert.equal(parseTime(0, B120).seconds, 0);
});

test('parseTime：拍點字串 2b（bpm 120 → 1 秒）', () => {
  const r = parseTime('2b', B120);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'beat');
  assert.equal(r.beats, 2);
  assert.equal(r.seconds, 1);
  assert.equal(parseTime('1.5b', B120).seconds, 0.75);
  assert.equal(parseTime('.5b', B120).seconds, 0.25);
});

test('parseTime：時間點加 beatOffset、長度不加（SPEC-EXPR-V2 §1.3）', () => {
  // 時間點（at / demo t）
  assert.equal(parseTime('2b', B120_OFF, { addOffset: true }).seconds, 1.25);
  assert.equal(timePointSeconds('2b', B120_OFF), 1.25);
  // 長度（duration / interval / fade…）
  assert.equal(parseTime('2b', B120_OFF, { addOffset: false }).seconds, 1);
  assert.equal(timeLengthSeconds('2b', B120_OFF), 1);
  // 純數字不受 addOffset 影響（秒就是秒）
  assert.equal(timePointSeconds(2, B120_OFF), 2);
});

test('parseTime：沒有 bpm 用拍點字串 → code no-bpm（不靜默當 0）', () => {
  const r = parseTime('2b', NO_BPM);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'no-bpm');
  assert.equal(r.seconds, null, '不可把 "2b" 靜默當成 0 秒');
  assert.ok(r.beats === 2, '仍要保留 beats 以便顯示');
});

test('parseTime：非法字串／型別 → bad / type', () => {
  assert.equal(parseTime('abc', B120).ok, false);
  assert.equal(parseTime('abc', B120).code, 'bad');
  assert.equal(parseTime({}, B120).ok, false);
  assert.equal(parseTime({}, B120).code, 'type');
  assert.equal(parseTime('', B120).empty, true);
  assert.equal(parseTime(null, B120).empty, true);
});

test('parseTime：純數字字串視為秒（舊檔相容）', () => {
  assert.equal(parseTime('1.5', B120).seconds, 1.5);
  assert.equal(parseTime('1.5', B120).kind, 'seconds');
});

test('parseTime：負值（allowNegative 預設 false → negative）', () => {
  assert.equal(parseTime(-1, B120).code, 'negative');
  assert.equal(parseTime('-1b', B120).code, 'negative');
  assert.equal(parseTime(-1, B120, { allowNegative: true }).ok, true);
});

test('isBeatString：只有 `數字b` 才算', () => {
  assert.equal(isBeatString('2b'), true);
  assert.equal(isBeatString('1.5B'), true);
  assert.equal(isBeatString('-1b'), true);
  assert.equal(isBeatString('2'), false);
  assert.equal(isBeatString('b'), false);
  assert.equal(isBeatString(2), false);
  assert.equal(isBeatString(null), false);
});

/* ------------------------------------------------------- 拍位置 / 拍線 / 吸附 */

test('beatPosition：秒 → 第幾拍（beat 從 1 起算）', () => {
  const p0 = beatPosition(0, B120);
  assert.equal(p0.beat, 1);
  assert.equal(p0.index, 0);
  assert.equal(p0.fraction, 0);
  const p1 = beatPosition(0.5, B120);
  assert.equal(p1.beat, 2);
  const p2 = beatPosition(0.75, B120);
  assert.equal(p2.beat, 2);
  assert.ok(Math.abs(p2.fraction - 0.5) < 1e-9);
  // 沒有 bpm → null
  assert.equal(beatPosition(1, NO_BPM), null);
});

test('beatPosition：beatOffset 會把拍線整體後移', () => {
  // beatOffset 0.25 + bpm120：拍線落在 0.25、0.75、1.25…
  const p = beatPosition(0.75, B120_OFF);
  assert.equal(p.beat, 2);
  assert.equal(p.fraction, 0);
  // 比 beatOffset 還早 → 前一首的尾拍（index 負）
  const before = beatPosition(0, B120_OFF);
  assert.equal(before.beat, 0);
});

test('totalBeats：回合長度換算成拍數（沒有 bpm → null）', () => {
  assert.equal(totalBeats(2, B120), 4);
  assert.equal(totalBeats(0, B120), null);
  assert.equal(totalBeats(2, NO_BPM), null);
});

test('beatTimes：每拍一條，每 4 拍 major（時間軸拍線）', () => {
  const beats = beatTimes(B120, 0, 2, { majorEvery: BEAT_MAJOR_EVERY });
  assert.equal(beats.length, 5, '0, 0.5, 1, 1.5, 2');
  assert.deepEqual(beats.map((b) => b.sec), [0, 0.5, 1, 1.5, 2]);
  assert.deepEqual(beats.map((b) => b.beat), [1, 2, 3, 4, 5]);
  assert.deepEqual(beats.map((b) => b.major), [true, false, false, false, true]);
});

test('beatTimes：只回傳視窗內的拍線（縮放/捲動時不爆量）', () => {
  const beats = beatTimes(B120, 1.1, 2.1, { majorEvery: 4 });
  assert.deepEqual(beats.map((b) => b.sec), [1.5, 2]);
  // 沒有 bpm → 空陣列
  assert.deepEqual(beatTimes(NO_BPM, 0, 10), []);
  // 反向區間 → 空
  assert.deepEqual(beatTimes(B120, 2, 1), []);
});

test('beatTimes：limit 保護（極長回合也不會產生無限陣列）', () => {
  const beats = beatTimes({ bpm: 600, beatOffset: 0 }, 0, 600, { majorEvery: 4, limit: 100 });
  assert.equal(beats.length, 100);
});

test('snapToBeat：吸附到最近拍線；enabled=false 時原值', () => {
  assert.equal(snapToBeat(0.26, B120, { enabled: true }), 0.5);
  assert.equal(snapToBeat(0.24, B120, { enabled: true }), 0);
  assert.equal(snapToBeat(0.26, B120, { enabled: false }), 0.26);
  // 沒有 bpm → 原值（呼叫端會退回幀吸附）
  assert.equal(snapToBeat(0.26, NO_BPM, { enabled: true }), 0.26);
  // beatOffset 生效：拍線 0.25 / 0.75 → 0.6 吸到 0.75
  assert.equal(snapToBeat(0.6, B120_OFF, { enabled: true }), 0.75);
});

test('beatSnapMode：Shift 暫時關閉吸附（V2-06 規格）', () => {
  assert.equal(beatSnapMode(NO_BPM, null), null);
  assert.equal(beatSnapMode(B120, null).enabled, true);
  assert.equal(beatSnapMode(B120, { shiftKey: false }).enabled, true);
  assert.equal(beatSnapMode(B120, { shiftKey: true }).enabled, false);
});

test('shiftBeat：往前／往後一拍（沒有 bpm → 原值）', () => {
  assert.equal(shiftBeat(1, B120, 1), 1.5);
  assert.equal(shiftBeat(1, B120, -1), 0.5);
  assert.equal(shiftBeat(0, B120, -1), 0, '不為負');
  assert.equal(shiftBeat(1, NO_BPM, 1), 1);
});

/* -------------------------------------------------- 保留使用者寫法 / 格式化 */

test('formatLike：原本寫 "2b" → 寫回拍點字串', () => {
  assert.equal(formatLike(1, '2b', B120, true), '2b');
  assert.equal(formatLike(1.5, '2b', B120, true), '3b');
  assert.equal(formatLike(1, '2b', B120_OFF, true), '1.5b');
});

test('formatLike：原本是數字 → 寫回數字秒', () => {
  assert.equal(formatLike(1.5, 0.5, B120, true), 1.5);
  assert.equal(typeof formatLike(1.5, 0.5, B120, true), 'number');
  // 沒有 bpm 但原本是字串（壞檔）→ 退回數字，不產生非法拍點字串
  assert.equal(formatLike(1.5, '2b', NO_BPM, true), 1.5);
});

test('secondsToBeatString：秒 → 拍點字串（沒有 bpm → null）', () => {
  assert.equal(secondsToBeatString(1, B120), '2b');
  assert.equal(secondsToBeatString(0.75, B120), '1.5b');
  assert.equal(secondsToBeatString(1.25, B120_OFF, true), '2b');
  assert.equal(secondsToBeatString(1, NO_BPM), null);
});

test('beatsOf / formatSeconds / formatTimeRaw / cleanSeconds', () => {
  assert.equal(beatsOf('2b', B120), 2);
  assert.equal(beatsOf(1, B120), 2);
  assert.equal(beatsOf('x', B120), null);
  assert.equal(beatsOf('2b', NO_BPM), null);
  assert.equal(formatSeconds(0.5), '0.5');
  assert.equal(formatSeconds(0.5, 1), '0.5');
  assert.equal(formatSeconds(1.2345, 2), '1.23');
  assert.equal(formatTimeRaw(0.5), '0.5');
  assert.equal(formatTimeRaw('2b'), '2b');
  assert.equal(cleanSeconds(0.1 + 0.2), 0.3);
});

/* --------------------------------------------------- 與引擎驗證語意對齊 */

test('與 engine/attack.js 的計算一致：拍點 → 秒的換算表', () => {
  // SPEC-EXPR-V2 §1.3 表：時間點加 offset、長度不加
  const timing = { bpm: 100, beatOffset: 0.1 }; // 一拍 0.6 秒
  assert.ok(Math.abs(timePointSeconds('2b', timing) - 1.3) < 1e-9);
  assert.ok(Math.abs(timeLengthSeconds('2b', timing) - 1.2) < 1e-9);
  assert.ok(Math.abs(secondsToBeatString(1.3, timing, true) === '2b' ? 0 : 1) === 0);
});
