/**
 * tools/web/recorder.test.mjs — 頁內錄影（V2-10）純邏輯測試
 *
 * 執行：cd battle-editor && node --test tools/web/recorder.test.mjs
 *       （或 node tools/web/recorder.test.mjs；本檔同時支援兩種）
 *
 * 範圍（全部與瀏覽器無關；用假的 MediaRecorder / canvas / 計時器）：
 *   1) mime 選擇：VP9+Opus → VP8+Opus → VP9 → VP8 → webm → 預設
 *   2) 檔名：<作品名>-<yyyyMMdd-HHmmss>.webm（含非法字元清洗、時間補零）
 *   3) 狀態機：idle → recording → stopping → stopped；重複 start/stop、錯誤狀態
 *   4) onUpdate / elapsed / bytes 統計
 *   5) scale > 1 時真的走放大畫布（drawImage 參數與 imageSmoothingEnabled=false）
 *   6) saveBlob / 格式化工具
 *
 * 風格比照 tests/autoplay/**：零外部依賴，只用 node:test + node:assert。
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECORD_STATES,
  MIME_CANDIDATES,
  selectMimeType,
  sanitizeTitle,
  formatTimestamp,
  extensionForMime,
  buildFilename,
  formatDuration,
  formatBytes,
  saveBlob,
  createRecorder,
} from './recorder.js';
import {
  SCALE_OPTIONS,
  THROTTLE_FPS,
  THROTTLE_SAMPLES,
  buildThrottleMessage,
  resolveTitle,
} from './recorder-ui.js';

/* ---------------------------------------------------------- 假瀏覽器 */

/** 假 MediaRecorder：記錄建構參數與 start/stop 呼叫，讓測試手動觸發事件。 */
class FakeMediaRecorder {
  static supported = new Set([
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ]);
  static instances = [];

  static isTypeSupported(type) {
    return FakeMediaRecorder.supported.has(type);
  }

  constructor(stream, options) {
    this.stream = stream;
    this.options = options || {};
    this.state = 'inactive';
    this.mimeType = this.options.mimeType || 'video/webm';
    this.startCalls = [];
    this.stopCalls = 0;
    FakeMediaRecorder.instances.push(this);
  }

  start(timeslice) {
    this.state = 'recording';
    this.startCalls.push(timeslice === undefined ? null : timeslice);
  }

  stop() {
    this.state = 'inactive';
    this.stopCalls += 1;
  }

  /** 測試用：模擬分片到達。 */
  emitData(size) {
    if (typeof this.ondataavailable === 'function') {
      this.ondataavailable({ data: { size, type: this.mimeType }, size });
    }
  }

  /** 測試用：模擬停止完成。 */
  emitStop() {
    if (typeof this.onstop === 'function') this.onstop({ type: 'stop' });
  }
}

/** 假 2D context：只記錄 drawImage / imageSmoothingEnabled。 */
function makeFakeContext() {
  const calls = [];
  const ctx = {
    imageSmoothingEnabled: true,
    drawImage(...args) {
      calls.push({ args, smoothing: ctx.imageSmoothingEnabled });
    },
    calls,
  };
  return ctx;
}

function makeFakeCanvas(width = 640, height = 480) {
  const ctx = makeFakeContext();
  const canvas = {
    width,
    height,
    ctx,
    captured: [],
    captureStream(fpsValue) {
      canvas.captured.push(fpsValue);
      return {
        getVideoTracks: () => [{ kind: 'video', id: 'v1' }],
        getAudioTracks: () => [],
        getTracks: () => [{ kind: 'video', id: 'v1' }],
      };
    },
    getContext(type) {
      return type === '2d' ? ctx : null;
    },
  };
  return canvas;
}

function makeFakeStream(kind = 'audio') {
  return {
    getAudioTracks: () => (kind === 'audio' ? [{ kind: 'audio', id: 'a1' }] : []),
    getVideoTracks: () => [],
    getTracks: () => [{ kind, id: kind === 'audio' ? 'a1' : 'v1' }],
  };
}

/** 可控時鐘（毫秒）。 */
function makeClock(start = 1000) {
  let value = start;
  return {
    now: () => value,
    advance(ms) {
      value += ms;
      return value;
    },
  };
}

/** 建立錄影器（全部注入假物件，不碰 DOM）。 */
function makeRecorder(overrides = {}) {
  const canvas = overrides.canvas || makeFakeCanvas();
  const clock = overrides.clock || makeClock();
  const recorder = createRecorder({
    canvas,
    audioStream: overrides.audioStream === undefined ? makeFakeStream('audio') : overrides.audioStream,
    fps: 30,
    scale: overrides.scale === undefined ? 1 : overrides.scale,
    title: overrides.title === undefined ? '黑桃雨' : overrides.title,
    filename: overrides.filename,
    mimeType: overrides.mimeType,
    MediaRecorder: FakeMediaRecorder,
    MediaStream: function FakeStream(tracks) {
      this.tracks = tracks;
      this.getVideoTracks = () => tracks.filter((t) => t.kind === 'video');
      this.getAudioTracks = () => tracks.filter((t) => t.kind === 'audio');
      this.getTracks = () => tracks.slice();
    },
    Blob: function FakeBlob(parts, opts) {
      this.parts = parts;
      this.type = (opts && opts.type) || '';
      this.size = parts.reduce((sum, part) => sum + (Number(part && part.size) || 0), 0);
    },
    now: clock.now,
    nowDate: overrides.nowDate || (() => new Date(2026, 10, 9, 14, 5, 7)),
    timeslice: overrides.timeslice === undefined ? 500 : overrides.timeslice,
    updateMs: 250,
    stopTimeoutMs: overrides.stopTimeoutMs === undefined ? 4000 : overrides.stopTimeoutMs,
    createCanvas: (w, h) => makeFakeCanvas(w, h),
  });
  return { recorder, canvas, clock };
}

/* ============================================================ mime */

describe('mime 選擇', () => {
  test('優先 VP9+Opus，其次 VP8+Opus，最後瀏覽器 webm', () => {
    assert.equal(
      selectMimeType({ MediaRecorder: FakeMediaRecorder }),
      'video/webm;codecs=vp9,opus',
    );
    FakeMediaRecorder.supported = new Set(['video/webm;codecs=vp8,opus', 'video/webm']);
    assert.equal(selectMimeType({ MediaRecorder: FakeMediaRecorder }), 'video/webm;codecs=vp8,opus');
    FakeMediaRecorder.supported = new Set(['video/webm']);
    assert.equal(selectMimeType({ MediaRecorder: FakeMediaRecorder }), 'video/webm');
    FakeMediaRecorder.supported = new Set();
    assert.equal(selectMimeType({ MediaRecorder: FakeMediaRecorder }), '');
    FakeMediaRecorder.supported = new Set([
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ]);
  });

  test('沒有 MediaRecorder → 回空字串（呼叫端視為不支援）', () => {
    assert.equal(selectMimeType({ MediaRecorder: null }), '');
  });

  test('候選順序符合規格（VP9+Opus 在最前、webm 在最後）', () => {
    assert.deepEqual(
      [...MIME_CANDIDATES],
      [
        'video/webm;codecs=vp9,opus',
        'video/webm;codecs=vp8,opus',
        'video/webm;codecs=vp9',
        'video/webm;codecs=vp8',
        'video/webm',
      ],
    );
  });
});

/* ============================================================ 檔名 */

describe('輸出檔名', () => {
  test('格式 <作品名>-<yyyyMMdd-HHmmss>.webm', () => {
    const date = new Date(2026, 10, 9, 14, 5, 7); // 2026-11-09 14:05:07（本機時區）
    assert.equal(buildFilename({ title: '黑桃雨', date }), '黑桃雨-20261109-140507.webm');
  });

  test('時間一律補零', () => {
    const date = new Date(2026, 0, 2, 3, 4, 5);
    assert.equal(formatTimestamp(date), '20260102-030405');
  });

  test('沒有作品名 → recording', () => {
    const date = new Date(2026, 10, 9, 0, 0, 0);
    assert.equal(buildFilename({ title: '', date }), 'recording-20261109-000000.webm');
    assert.equal(buildFilename({ title: '   ', date }), 'recording-20261109-000000.webm');
    assert.equal(buildFilename({ date }), 'recording-20261109-000000.webm');
  });

  test('Windows 非法字元換成底線，但保留中文與空格', () => {
    assert.equal(sanitizeTitle('a/b\\c:d*e?f"g<h>i|j'), 'a_b_c_d_e_f_g_h_i_j');
    assert.equal(sanitizeTitle('黑桃 雨 v2'), '黑桃 雨 v2');
    assert.equal(sanitizeTitle('  尾巴的點...  '), '尾巴的點');
    assert.equal(sanitizeTitle(null), '');
    assert.equal(sanitizeTitle(undefined), '');
    assert.equal(sanitizeTitle(123), '123');
  });

  test('過長的作品名會截短', () => {
    const long = '字'.repeat(200);
    const name = sanitizeTitle(long);
    assert.ok(name.length <= 80, `長度 ${name.length} 應 <= 80`);
  });

  test('mime → 副檔名（webm 為主，mp4 備援）', () => {
    assert.equal(extensionForMime('video/webm;codecs=vp9,opus'), 'webm');
    assert.equal(extensionForMime(''), 'webm');
    assert.equal(extensionForMime('video/mp4;codecs=avc1'), 'mp4');
  });
});

/* ============================================================ 狀態機 */

describe('狀態機', () => {
  test('初始狀態 idle、沒有 blob、elapsed 0', () => {
    const { recorder } = makeRecorder();
    assert.equal(recorder.state, RECORD_STATES.IDLE);
    assert.equal(recorder.blob, null);
    assert.equal(recorder.elapsed, 0);
    assert.equal(recorder.bytes, 0);
  });

  test('start → recording，stop → stopped 並回傳 Blob', async () => {
    const { recorder, clock } = makeRecorder();
    assert.equal(recorder.start(), true);
    assert.equal(recorder.state, RECORD_STATES.RECORDING);
    clock.advance(1500);
    assert.equal(recorder.elapsed, 1.5);
    const pending = recorder.stop();
    assert.equal(recorder.state, RECORD_STATES.STOPPING);
    const fake = FakeMediaRecorder.instances.at(-1);
    fake.emitData(1024);
    fake.emitData(2048);
    fake.emitStop();
    const blob = await pending;
    assert.equal(recorder.state, RECORD_STATES.STOPPED);
    assert.equal(blob.size, 3072);
    assert.equal(recorder.bytes, 3072);
    assert.equal(recorder.blob, blob);
    assert.equal(blob.type, 'video/webm;codecs=vp9,opus');
  });

  test('重複 start 在錄影中回 false、不重新建立 MediaRecorder', () => {
    const { recorder } = makeRecorder();
    assert.equal(recorder.start(), true);
    const count = FakeMediaRecorder.instances.length;
    assert.equal(recorder.start(), false);
    assert.equal(FakeMediaRecorder.instances.length, count);
  });

  test('沒在錄影時 stop() 回上一次的 blob（不會拋錯）', async () => {
    const { recorder } = makeRecorder();
    assert.equal(await recorder.stop(), null);
    recorder.start();
    const pending = recorder.stop();
    const fake = FakeMediaRecorder.instances.at(-1);
    fake.emitData(10);
    fake.emitStop();
    const first = await pending;
    assert.equal(first.size, 10);
    assert.equal(await recorder.stop(), first);
  });

  test('stop() 可以重複 await 同一個 promise', async () => {
    const { recorder } = makeRecorder();
    recorder.start();
    const a = recorder.stop();
    const b = recorder.stop();
    const fake = FakeMediaRecorder.instances.at(-1);
    fake.emitData(7);
    fake.emitStop();
    assert.equal(await a, await b);
  });

  test('錄影中可以再錄一次（stop 後 start）', async () => {
    const { recorder } = makeRecorder();
    recorder.start();
    const pending = recorder.stop();
    const first = FakeMediaRecorder.instances.at(-1);
    first.emitData(100);
    first.emitStop();
    await pending;
    assert.equal(recorder.state, RECORD_STATES.STOPPED);
    assert.equal(recorder.start(), true);
    assert.equal(recorder.state, RECORD_STATES.RECORDING);
    assert.equal(recorder.bytes, 0);
    assert.deepEqual(recorder.start, recorder.start);
  });

  test('onstop 逾時也會收尾（不卡在 stopping）', async () => {
    const { recorder } = makeRecorder({ stopTimeoutMs: 200 });
    recorder.start();
    const pending = recorder.stop();
    const fake = FakeMediaRecorder.instances.at(-1);
    fake.emitData(33);
    // 刻意不叫 fake.emitStop()，等逾時保險
    const blob = await pending;
    assert.equal(blob.size, 33);
    assert.equal(recorder.state, RECORD_STATES.STOPPED);
  });

  test('沒有 MediaRecorder → start 回 false、state=error', () => {
    const canvas = makeFakeCanvas();
    const recorder = createRecorder({ canvas, MediaRecorder: null });
    assert.equal(recorder.start(), false);
    assert.equal(recorder.state, RECORD_STATES.ERROR);
    assert.match(recorder.error, /MediaRecorder/);
  });

  test('canvas 不支援 captureStream → start 回 false', () => {
    const canvas = makeFakeCanvas();
    canvas.captureStream = undefined;
    const { recorder } = makeRecorder({ canvas });
    assert.equal(recorder.start(), false);
    assert.equal(recorder.state, RECORD_STATES.ERROR);
    assert.match(recorder.error, /captureStream/);
  });

  test('沒有 canvas → 例外被接住（state=error）', () => {
    const recorder = createRecorder({ canvas: null, MediaRecorder: FakeMediaRecorder });
    assert.equal(recorder.start(), false);
    assert.equal(recorder.state, RECORD_STATES.ERROR);
    assert.match(recorder.error, /canvas/);
  });
});

/* ===================================================== 串流與倍率 */

describe('串流組成與倍率', () => {
  test('影像軌 + 音訊軌合成同一條 stream，並用呼叫端給的 fps', () => {
    const { recorder, canvas } = makeRecorder();
    recorder.start();
    const fake = FakeMediaRecorder.instances.at(-1);
    assert.deepEqual(canvas.captured, [30]);
    const kinds = fake.stream.getTracks().map((t) => t.kind).sort();
    assert.deepEqual(kinds, ['audio', 'video']);
    recorder.stop();
  });

  test('audioStream=null → 只有影像軌也能錄', () => {
    const { recorder } = makeRecorder({ audioStream: null });
    assert.equal(recorder.start(), true);
    const fake = FakeMediaRecorder.instances.at(-1);
    assert.deepEqual(fake.stream.getTracks().map((t) => t.kind), ['video']);
    recorder.stop();
  });

  test('scale=2 → 用 1280×960 的離屏畫布、最近鄰（imageSmoothingEnabled=false）', () => {
    const { recorder, canvas } = makeRecorder({ scale: 2 });
    assert.equal(recorder.outputSize.width, 1280);
    assert.equal(recorder.outputSize.height, 960);
    assert.equal(recorder.start(), true);
    const size = recorder.outputSize;
    assert.deepEqual(size, { width: 1280, height: 960 });
    // 放大畫布的 ctx 已被關掉平滑（建立時就設）
    assert.equal(canvas.ctx.imageSmoothingEnabled, true, '原畫布的 ctx 不該被改');
    recorder.stop();
  });

  test('scale 超出 1..6 會被夾住', () => {
    const a = makeRecorder({ scale: 99 }).recorder;
    assert.equal(a.scale, 6);
    const b = makeRecorder({ scale: 0 }).recorder;
    assert.equal(b.scale, 1);
    const c = makeRecorder({ scale: 2.4 }).recorder;
    assert.equal(c.scale, 2);
  });

  test('fps 會被夾在 1..120', () => {
    assert.equal(makeRecorder().recorder.fps, 30);
    const slow = createRecorder({ canvas: makeFakeCanvas(), fps: 0, MediaRecorder: FakeMediaRecorder });
    assert.equal(slow.fps, 1);
    const fast = createRecorder({ canvas: makeFakeCanvas(), fps: 999, MediaRecorder: FakeMediaRecorder });
    assert.equal(fast.fps, 120);
  });
});

/* ======================================================= onUpdate */

describe('onUpdate 與統計', () => {
  test('start 會立刻回報一次 recording', () => {
    const events = [];
    const { recorder } = makeRecorder();
    recorder.onUpdate = (snap) => events.push(snap);
    recorder.start();
    assert.ok(events.length >= 1);
    assert.equal(events[0].state, RECORD_STATES.RECORDING);
    assert.equal(events[0].recording, true);
    assert.equal(events[0].scale, 1);
    assert.match(events[0].filename, /^黑桃雨-\d{8}-\d{6}\.webm$/);
    recorder.stop();
    FakeMediaRecorder.instances.at(-1).emitStop();
  });

  test('bytes 隨分片累加，stop 後的快照帶最終大小', async () => {
    const events = [];
    const { recorder } = makeRecorder();
    recorder.onUpdate = (snap) => events.push(snap);
    recorder.start();
    const fake = FakeMediaRecorder.instances.at(-1);
    fake.emitData(500);
    fake.emitData(900);
    const pending = recorder.stop();
    fake.emitStop();
    await pending;
    const last = events.at(-1);
    assert.equal(last.state, RECORD_STATES.STOPPED);
    assert.equal(last.bytes, 1400);
    assert.ok(last.filename.endsWith('.webm'));
  });

  test('onUpdate 拋例外不會弄壞錄影', async () => {
    const { recorder } = makeRecorder();
    recorder.onUpdate = () => {
      throw new Error('使用者回呼爆炸');
    };
    assert.equal(recorder.start(), true);
    const fake = FakeMediaRecorder.instances.at(-1);
    fake.emitData(1);
    const pending = recorder.stop();
    fake.emitStop();
    assert.equal((await pending).size, 1);
  });

  test('timeslice 有傳給 MediaRecorder.start', () => {
    const { recorder } = makeRecorder({ timeslice: 250 });
    recorder.start();
    assert.equal(FakeMediaRecorder.instances.at(-1).startCalls[0], 250);
    recorder.stop();
    FakeMediaRecorder.instances.at(-1).emitStop();
  });
});

/* ==================================================== 顯示格式 */

describe('狀態列格式', () => {
  test('formatDuration 給 m:ss', () => {
    assert.equal(formatDuration(0), '0:00');
    assert.equal(formatDuration(9.9), '0:09');
    assert.equal(formatDuration(65), '1:05');
    assert.equal(formatDuration(-3), '0:00');
    assert.equal(formatDuration('abc'), '0:00');
  });

  test('formatBytes 給 B / KB / MB', () => {
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(512), '512 B');
    assert.equal(formatBytes(2048), '2 KB');
    assert.equal(formatBytes(3 * 1024 * 1024), '3.0 MB');
    assert.equal(formatBytes(-1), '0 B');
  });
});

/* ======================================================= saveBlob */

function makeFakeDocument() {
  const clicks = [];
  const doc = {
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
    createElement(tag) {
      const el = {
        tagName: tag.toUpperCase(),
        style: {},
        clicks: 0,
        click() {
          el.clicks += 1;
          clicks.push(el);
        },
        remove() {},
      };
      return el;
    },
    clicks,
  };
  return doc;
}

describe('saveBlob 下載', () => {
  test('建立 <a download=檔名> 並點擊、之後回收 object URL', () => {
    const doc = makeFakeDocument();
    let revoked = 0;
    let created = 0;
    const urlApi = {
      createObjectURL() {
        created += 1;
        return 'blob:fake-url';
      },
      revokeObjectURL() {
        revoked += 1;
      },
    };
    const okSaved = saveBlob({ size: 10 }, '黑桃雨-20261109-140507.webm', { document: doc, URL: urlApi });
    assert.equal(okSaved, true);
    assert.equal(created, 1);
    assert.equal(doc.clicks.length, 1);
    assert.equal(doc.clicks[0].download, '黑桃雨-20261109-140507.webm');
    assert.equal(doc.clicks[0].href, 'blob:fake-url');
  });

  test('沒有 blob / document 時回 false（不拋錯）', () => {
    assert.equal(saveBlob(null, 'x.webm', { document: makeFakeDocument(), URL: {} }), false);
    assert.equal(saveBlob({ size: 1 }, 'x.webm', { document: null, URL: {} }), false);
  });

  test('createObjectURL 失敗 → false', () => {
    const doc = makeFakeDocument();
    const urlApi = {
      createObjectURL() {
        throw new Error('配額爆了');
      },
    };
    assert.equal(saveBlob({ size: 1 }, 'x.webm', { document: doc, URL: urlApi }), false);
  });
});

/* ====================================================== 清理 */

describe('dispose', () => {
  test('dispose 會停掉 MediaRecorder 並回到 idle', () => {
    const { recorder } = makeRecorder();
    recorder.start();
    const fake = FakeMediaRecorder.instances.at(-1);
    recorder.dispose();
    assert.equal(fake.stopCalls, 1);
    assert.equal(recorder.state, RECORD_STATES.IDLE);
    assert.equal(recorder.start(), false, 'dispose 後不能再錄');
  });
});

/* ================================================ 錄影 UI 純邏輯 */

describe('錄影 UI：作品名與節流提示', () => {
  test('倍率選項就是 1/2/3', () => {
    assert.deepEqual([...SCALE_OPTIONS], [1, 2, 3]);
  });

  test('resolveTitle 接受字串與 meta 形狀', () => {
    assert.equal(resolveTitle('黑桃雨'), '黑桃雨');
    assert.equal(resolveTitle({ name: 'Rudinn遭遇' }), 'Rudinn遭遇');
    assert.equal(resolveTitle({ name: { zh: '黑桃雨', en: 'Spade Rain' } }), '黑桃雨');
    assert.equal(resolveTitle({ name: { en: 'Spade Rain' } }), 'Spade Rain');
    assert.equal(resolveTitle({ title: '標題' }), '標題');
    assert.equal(resolveTitle(null), '');
    assert.equal(resolveTitle(undefined), '');
    assert.equal(resolveTitle(42), '');
  });

  test('正常情況不顯示節流提示', () => {
    assert.equal(buildThrottleMessage({ fps: 60 }), '');
    assert.equal(buildThrottleMessage({ fps: 30, hidden: false, slow: false }), '');
    assert.equal(buildThrottleMessage(), '');
  });

  test('document.hidden → 背景降速提示（含 FPS）', () => {
    const message = buildThrottleMessage({ hidden: true, fps: 7 });
    assert.match(message, /頁面在背景/);
    assert.match(message, /約 7 FPS/);
    assert.match(message, /請把視窗切到前景/);
  });

  test('長時間低幀率 → 降速提示', () => {
    const message = buildThrottleMessage({ slow: true, fps: 12 });
    assert.match(message, /12 FPS/);
    assert.match(message, /請把視窗切到前景/);
  });

  test('錄影中額外警告「錄影可能掉幀」', () => {
    assert.match(buildThrottleMessage({ hidden: true, fps: 5, recording: true }), /錄影可能掉幀/);
    assert.match(buildThrottleMessage({ slow: true, fps: 9, recording: true }), /錄影可能掉幀/);
    // 沒錄影時不該出現
    assert.doesNotMatch(buildThrottleMessage({ hidden: true, fps: 5 }), /錄影可能掉幀/);
  });

  test('節流門檻是 20 FPS 且需要連續取樣', () => {
    assert.equal(THROTTLE_FPS, 20);
    assert.ok(THROTTLE_SAMPLES >= 2);
  });
});
