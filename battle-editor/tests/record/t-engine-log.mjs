/**
 * tests/record/t-engine-log.mjs — engine/audio.js 的 V2-11 事件記錄模式
 *
 * 這裡不開瀏覽器：用一個「假的 window + 假的 AudioContext」把 engine/audio.js
 * 載進來（它只依賴 window.AudioContext / window.__drAudioLog），驗：
 *   1. 事件記錄器（window.__drAudioLog）的 start / stop / clear / setFrame / get
 *   2. bgm play / stop / 切歌（previous）、sfx、setVolume / setMuted 都帶 frame 與 t
 *   3. 多個 createAudio 實例共用同一份事件表（src 不同）
 *   4. 錄影工具「先放空殼、頁面 boot 時先播 BGM」也記得到
 *   5. V2-10 的 getRecordStream() 不受影響（沒有 Web Audio 錄影目的地時回 null）
 *   6. 記錄器沒開啟時完全不記錄（正常遊玩零成本、不影響播放）
 */

import { group, test, ok, eq, approx } from '../engine/harness.mjs';

group('10) 逐幀錄影：engine/audio.js 事件記錄');

/** 建立假 AudioContext（只實作 audio.js 會用到的節點；沒有 decodeAudioData → 解碼失敗，不會發網路請求）。 */
function makeFakeAudioContextClass({ withStreamDest = false, state = 'running' } = {}) {
  return class FakeAudioContext {
    constructor() {
      this.state = state;
      this.currentTime = 0;
      this.destination = { name: 'destination' };
    }
    createGain() {
      return {
        gain: {
          value: 1,
          cancelScheduledValues() {},
          setValueAtTime() {},
          linearRampToValueAtTime() {},
        },
        connect() {},
        disconnect() {},
      };
    }
    createBufferSource() {
      return {
        buffer: null,
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        connect() {},
        disconnect() {},
        start() {},
        stop() {},
      };
    }
    resume() {
      this.state = 'running';
      return Promise.resolve();
    }
    createMediaStreamDestination() {
      if (!withStreamDest) throw new Error('不支援');
      return { stream: { id: 'fake-stream' } };
    }
  };
}

function makeAssets(audio = {}) {
  return {
    index: { audio },
    baseUrl: '/assets/',
    resolveUrl(rel) {
      return `/assets/${String(rel).replace(/^\/+/, '')}`;
    },
  };
}

const AUDIO_INDEX = {
  battle: { file: 'audio/mus/battle.ogg', kind: 'music', loop: true },
  boss: { file: 'audio/mus/boss.ogg', kind: 'music', loop: true, loopStart: 30, loopEnd: 40, volume: 0.8 },
  snd_hurt1: { file: 'audio/snd/snd_hurt1.wav', kind: 'sfx', groups: ['hurt'] },
};

/** 在假 window 環境下執行 fn()；結束後還原全域（測試檔共用一個 process）。 */
async function withFakeWindow(options, fn) {
  const previousWindow = Object.prototype.hasOwnProperty.call(globalThis, 'window') ? globalThis.window : undefined;
  const win = {
    AudioContext: makeFakeAudioContextClass(options),
  };
  globalThis.window = win;
  try {
    return await fn(win);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

/** 取一個乾淨的 createAudio 實例（每次 import 同一份模組，實例序號會累加）。 */
async function freshAudio(assets, options = {}) {
  const { createAudio } = await import('../../engine/audio.js');
  return createAudio(assets);
}

test('createAudio()：有多個記錄方法（真實 API 與 silent API 都有）', async () => {
  const { createAudio } = await import('../../engine/audio.js');
  const silent = createAudio(null);
  for (const name of ['startEventLog', 'stopEventLog', 'getEventLog', 'clearEventLog', 'setLogFrame']) {
    ok(typeof silent[name] === 'function', `silent API 缺少 ${name}()`);
  }
  await withFakeWindow({}, async () => {
    const real = createAudio(makeAssets(AUDIO_INDEX));
    for (const name of ['startEventLog', 'stopEventLog', 'getEventLog', 'clearEventLog', 'setLogFrame']) {
      ok(typeof real[name] === 'function', `真實 API 缺少 ${name}()`);
    }
    ok(typeof real.getRecordStream === 'function', 'V2-10 的 getRecordStream 不能消失');
  });
});

test('startEventLog()：建立 window.__drAudioLog、清空舊事件、回報 fps', async () => {
  await withFakeWindow({}, async (win) => {
    const audio = await freshAudio(makeAssets(AUDIO_INDEX));
    // createAudio 只會「補方法」不主動建立記錄器（正常遊玩零成本）；
    // 錄影工具會在頁面載入前注入空殼，或由 startEventLog() 建立。
    const started = audio.startEventLog({ fps: 30 });
    eq(started, true, '回傳 true');
    eq(!!win.__drAudioLog, true, 'startEventLog() 後有記錄器（給錄影工具取用）');
    eq(win.__drAudioLog.active, true, '記錄中');
    eq(win.__drAudioLog.fps, 30, 'fps');
    eq(win.__drAudioLog.events.length, 0, '起始無事件');
  });
});

test('setVolume() / setMuted()：事件帶 frame、t 與 src 實例序號', async () => {
  await withFakeWindow({}, async (win) => {
    const audio = await freshAudio(makeAssets(AUDIO_INDEX));
    audio.startEventLog({ fps: 30 });
    audio.setLogFrame(45);
    audio.setVolume(0.5);
    audio.setMuted(true);
    const log = audio.getEventLog();
    eq(log.events.length, 2, '兩筆事件');
    eq(log.events[0].type, 'volume', '第一筆音量');
    eq(log.events[0].value, 0.5, '音量值');
    eq(log.events[0].frame, 45, '幀號');
    approx(log.events[0].t, 1.5, 1e-9, 't = frame / fps');
    ok(Number.isInteger(log.events[0].src) && log.events[0].src > 0, `src 應為正整數實例序號，實際 ${log.events[0].src}`);
    eq(log.events[1].type, 'mute', '第二筆靜音');
    eq(log.events[1].value, true, '靜音值');
    ok(Number.isFinite(log.events[1].frame), '有幀號');
    eq(win.__drAudioLog.events.length, 2, '事件表就在 window 上（錄影工具讀這裡）');
  });
});

test('play()：音效事件帶 name / file / url / volume / loop / frame', async () => {
  await withFakeWindow({}, async () => {
    const audio = await freshAudio(makeAssets(AUDIO_INDEX));
    audio.startEventLog({ fps: 30 });
    audio.setLogFrame(12);
    audio.play('snd_hurt1', { volume: 0.8 });
    const log = audio.getEventLog();
    eq(log.events.length, 1, '一筆音效');
    const event = log.events[0];
    eq(event.type, 'sfx', '型別');
    eq(event.name, 'snd_hurt1', '名稱');
    eq(event.file, 'audio/snd/snd_hurt1.wav', '相對 assets 的檔案路徑（Node 端靠它找檔）');
    eq(event.url, '/assets/audio/snd/snd_hurt1.wav', '實際 URL');
    approx(event.volume, 0.8, 1e-9, '音量');
    eq(event.loop, false, '不循環');
    eq(event.frame, 12, '幀號');
    approx(event.t, 0.4, 1e-9, 't');
  });
});

test('playBgm()：記錄 play、loop、loopStart/loopEnd、fade 與 previous（切歌）', async () => {
  await withFakeWindow({}, async () => {
    const audio = await freshAudio(makeAssets(AUDIO_INDEX));
    audio.startEventLog({ fps: 30 });
    audio.setLogFrame(0);
    audio.playBgm('battle', { fade: 0.35 });
    audio.setLogFrame(90);
    audio.playBgm('boss', { fade: 0.8 });
    const log = audio.getEventLog();
    eq(log.events.length, 2, '兩筆 BGM 事件');
    const first = log.events[0];
    eq(first.type, 'bgm', '型別');
    eq(first.action, 'play', '動作');
    eq(first.name, 'battle', '曲名');
    eq(first.file, 'audio/mus/battle.ogg', '檔案');
    eq(first.loop, true, '索引標記循環 → loop true');
    eq(first.loopStart, null, '沒有 loopStart');
    eq(first.loopEnd, null, '沒有 loopEnd');
    approx(first.fade, 0.35, 1e-9, '淡入秒數');
    eq(first.previous, null, '第一首沒有前一曲');
    const second = log.events[1];
    eq(second.name, 'boss', '第二首');
    eq(second.previous, 'battle', '切歌要記前一曲（Node 端排舊曲淡出）');
    approx(second.loopStart, 30, 1e-9, 'loopStart 從索引帶出');
    approx(second.loopEnd, 40, 1e-9, 'loopEnd 從索引帶出');
    approx(second.volume, 0.8, 1e-9, '索引音量');
    approx(second.fade, 0.8, 1e-9, '切歌淡出');
    eq(second.frame, 90, '切歌幀號');
    approx(second.t, 3, 1e-9, '切歌時間');
  });
});

test('stopBgm()：記錄 stop 與 fade；同名重播不記第二筆', async () => {
  await withFakeWindow({}, async () => {
    const audio = await freshAudio(makeAssets(AUDIO_INDEX));
    audio.startEventLog({ fps: 30 });
    audio.playBgm('battle');
    audio.playBgm('battle'); // 同名 → 不重啟、不記事件
    audio.setLogFrame(150);
    audio.stopBgm(1.5);
    const log = audio.getEventLog();
    eq(log.events.length, 2, 'play + stop');
    eq(log.events[0].action, 'play', '第一筆 play');
    eq(log.events[1].action, 'stop', '第二筆 stop');
    eq(log.events[1].name, 'battle', '停止前曲名');
    eq(log.events[1].file, 'audio/mus/battle.ogg', '檔案');
    approx(log.events[1].fade, 1.5, 1e-9, '淡出秒數');
    eq(log.events[1].frame, 150, '停止幀號');
  });
});

test('兩個 createAudio 實例共用同一份事件表（src 不同，時間仍一致）', async () => {
  await withFakeWindow({}, async (win) => {
    const page = await freshAudio(makeAssets(AUDIO_INDEX));
    const engine = await freshAudio(makeAssets(AUDIO_INDEX));
    page.startEventLog({ fps: 30 });
    page.setLogFrame(3);
    page.play('snd_hurt1');
    engine.setLogFrame(3);
    engine.play('snd_hurt1');
    const log = page.getEventLog();
    eq(log.events.length, 2, '兩個實例的事件都在同一張表');
    ok(log.events[0].src !== log.events[1].src, 'src 不同（可分辨來源）');
    eq(log.events[0].frame, log.events[1].frame, '同一幀');
    eq(win.__drAudioLog === undefined, false, 'window 上有記錄器');
  });
});

test('錄影工具先放空殼 → 頁面 boot 播的第一首 BGM 也記得到', async () => {
  await withFakeWindow({}, async (win) => {
    // 模擬 tools/record.mjs 的 PRELOAD_SCRIPT 先放的 sink
    win.__drAudioLog = {
      version: 1,
      active: true,
      fps: 30,
      frame: 0,
      dropped: 0,
      maxEvents: 400000,
      startedAt: Date.now(),
      stoppedAt: 0,
      events: [],
    };
    const audio = await freshAudio(makeAssets(AUDIO_INDEX));
    ok(typeof win.__drAudioLog.start === 'function', 'createAudio 會把方法補上');
    audio.playBgm('battle', { fade: 0.35 });
    const log = win.__drAudioLog.get();
    eq(log.events.length, 1, 'boot 的 BGM 記到了');
    eq(log.events[0].name, 'battle', '曲名');
    eq(log.events[0].frame, 0, '第 0 幀');
  });
});

test('記錄器沒開啟（active:false）→ 完全不記錄，播放行為不受影響', async () => {
  await withFakeWindow({}, async (win) => {
    // 錄影工具注入的空殼就是長這樣（active 由工具決定；這裡模擬「有 sink 但沒開記錄」）
    win.__drAudioLog = { version: 1, active: false, fps: 30, frame: 0, dropped: 0, maxEvents: 400000, events: [] };
    const audio = await freshAudio(makeAssets(AUDIO_INDEX));
    eq(win.__drAudioLog.active, false, '沒開啟');
    audio.setLogFrame(10);
    audio.setVolume(0.3);
    audio.play('snd_hurt1');
    audio.playBgm('battle');
    audio.stopBgm(0);
    eq(audio.getEventLog().events.length, 0, '沒有記錄任何事件');
    // 播放狀態仍然正常（記錄只是旁路）
    audio.playBgm('battle');
    eq(audio.getBgm(), 'battle', 'BGM 狀態正常');
    audio.stopBgm(0);
    eq(audio.getBgm(), null, '停止後是 null');
  });
});

test('stopEventLog() / clearEventLog()：停止後不再記錄、清空回空表', async () => {
  await withFakeWindow({}, async () => {
    const audio = await freshAudio(makeAssets(AUDIO_INDEX));
    audio.startEventLog({ fps: 30 });
    audio.setLogFrame(1);
    audio.play('snd_hurt1');
    const log = audio.stopEventLog();
    eq(log.active, false, '已停止');
    eq(log.events.length, 1, '保留停止前的事件');
    audio.play('snd_hurt1');
    eq(audio.getEventLog().events.length, 1, '停止後不再新增');
    audio.clearEventLog();
    eq(audio.getEventLog().events.length, 0, '清空');
    audio.startEventLog({ fps: 30 });
    eq(audio.getEventLog().active, true, '可以重新開始');
    eq(audio.getEventLog().fps, 30, 'fps 保留');
  });
});

test('setLogFrame()：非法值不動、合法值四捨五入；沒有記錄器時回 0', async () => {
  await withFakeWindow({}, async () => {
    const audio = await freshAudio(makeAssets(AUDIO_INDEX));
    eq(audio.setLogFrame(7.6), 8, '四捨五入（會順便建立記錄器）');
    eq(audio.setLogFrame(-1), 8, '負數不動');
    eq(audio.setLogFrame('bad'), 8, '非數字不動');
    eq(audio.setLogFrame(0), 0, '可以歸零');
  });
});

test('事件表上限：超過 maxEvents 記 dropped、不再無限長大', async () => {
  await withFakeWindow({}, async (win) => {
    const audio = await freshAudio(makeAssets(AUDIO_INDEX));
    audio.startEventLog({ fps: 30 });
    win.__drAudioLog.maxEvents = 3;
    for (let i = 0; i < 5; i += 1) audio.setVolume((i + 1) / 10);
    const log = audio.getEventLog();
    eq(log.events.length, 3, '只留上限數量');
    eq(log.dropped, 2, '被丟棄的筆數有記');
    eq(log.events[2].value, 0.3, '保留的是前 3 筆');
  });
});

test('V2-10 getRecordStream()：仍可運作且不影響事件記錄', async () => {
  await withFakeWindow({ withStreamDest: false }, async () => {
    const audio = await freshAudio(makeAssets(AUDIO_INDEX));
    // 沒有 createMediaStreamDestination 實作 → 回 null（純影像錄影）
    eq(audio.getRecordStream(), null, '沒有目的地時回 null');
    audio.startEventLog({ fps: 30 });
    audio.setLogFrame(2);
    audio.play('snd_hurt1');
    eq(audio.getEventLog().events.length, 1, '事件記錄照常');
  });
  await withFakeWindow({ withStreamDest: true }, async () => {
    const audio = await freshAudio(makeAssets(AUDIO_INDEX));
    const stream = audio.getRecordStream();
    ok(stream && stream.id === 'fake-stream', '有目的地時回傳 MediaStream');
    eq(audio.getRecordStream(), stream, '重複呼叫回同一個 stream');
    audio.startEventLog({ fps: 30 });
    audio.play('snd_hurt1');
    eq(audio.getEventLog().events.length, 1, '錄音串流與事件記錄可同時用');
  });
});

test('silent API（沒有 Web Audio）：記錄方法仍可呼叫、回空表不丟錯', async () => {
  const { createAudio } = await import('../../engine/audio.js');
  const silent = createAudio(null);
  // 沒有 window（純 Node）→ 沒有記錄器可用，但呼叫不能丟錯
  eq(silent.startEventLog({ fps: 30 }), false, '沒有 window 時 startEventLog 回 false');
  eq(silent.stopEventLog().events.length, 0, '空表');
  eq(silent.setLogFrame(5), 0, '沒有記錄器時 setLogFrame 回 0');
  eq(silent.getEventLog().events.length, 0, '沒有事件');
  eq(silent.clearEventLog(), false, '沒有記錄器時 clearEventLog 回 false');
  eq(silent.getRecordStream(), null, 'V2-10 串流仍是 null');
  // 有 window 時，silent API 也能記錄（沒有 Web Audio 的瀏覽器＝headless 環境常見）
  await withFakeWindow({}, async (win) => {
    const silentInPage = createAudio(null);
    eq(silentInPage.startEventLog({ fps: 30 }), true, '有 window 時可以開始記錄');
    eq(win.__drAudioLog.active, true, '記錄器開啟');
    silentInPage.setLogFrame(5);
    silentInPage.play('snd_hurt1');
    eq(win.__drAudioLog.events.length, 0, 'silent API 的 play() 不播也不記事件（只有播放實例會記）');
    eq(silentInPage.getEventLog().fps, 30, 'fps 正確');
  });
});
