/**
 * engine/audio.js — Web Audio 音效播放（SPEC §2 / §9，E2 擁有）
 *
 * export function createAudio(assets) → {
 *   play(name, opts?),          // 播放一次；缺素材靜默
 *   playAll(names),             // 依序播放多個（sfxQueue 用）
 *   playBgm(name, opts?),       // 循環背景音樂（SPEC-P2 §3 bgm 指令 / Phase 1 settings.bgm）
 *   stopBgm(fade?),             // 停止背景音樂（可淡出秒數）
 *   getBgm(),                   // 目前曲名或 null
 *   setMuted(boolean), getMuted(),
 *   setVolume(v), 
 *   loaded(name),               // 'ready' | 'loading' | 'missing' | 'failed'
 *   unlock(),                   // 使用者手勢後解鎖（play.html / 編輯器可呼叫）
 *   getRecordStream(),          // 錄影用 MediaStream（主輸出同時接到 MediaStreamDestination）
 *   startEventLog(opts?),       // V2-11 事件記錄（bgm/sfx 帶遊戲幀號；不改播放行為）
 *   stopEventLog(), getEventLog(), clearEventLog(), setLogFrame(n),
 *   stats(),
 *   destroy(),
 * }
 *
 * 約定：
 * - assets 可為 loadAssets() 的結果（有 index.audio 與 audio()），或 null。
 * - 音效缺失 / 解碼失敗 → 靜默，不丟例外、不印每幀警告。
 * - AudioContext 延遲到第一次 play 才建立（瀏覽器自動播放政策），並在 suspended 時嘗試 resume。
 * - 同一個 url 只解碼一次（decodeAudioData 快取）；短音效可重疊播放。
 * - BGM 為單一軌道：呼叫新的 playBgm 會淡出舊曲再播新曲；loop 取索引的 loop 欄位
 *   （BGM 一律強制循環，索引沒標 loop 也一樣；用 opts.loop:false 可覆寫）。
 */

const DEFAULT_AUDIO_EXT = '.ogg';

function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value) {
  const n = numOr(value, 1);
  return Math.max(0, Math.min(1, n));
}

function makeSilentApi(reason) {
  const stats = { loaded: 0, failed: 0, missing: 0, playing: 0 };
  let muted = false;
  let volume = 1;
  let bgm = null;
  return {
    play() {
      return false;
    },
    playAll() {
      return 0;
    },
    playBgm(name) {
      bgm = typeof name === 'string' && name ? name : null;
      return false;
    },
    stopBgm() {
      const had = bgm !== null;
      bgm = null;
      return had;
    },
    getBgm() {
      return bgm;
    },
    setMuted(value) {
      muted = value === true;
    },
    getMuted() {
      return muted;
    },
    setVolume(value) {
      const n = Number(value);
      volume = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
    },
    getVolume() {
      return volume;
    },
    loaded() {
      return 'missing';
    },
    unlock() {},
    /** 無 Web Audio → 無法提供錄影用音訊串流（V2-10）。 */
    getRecordStream() {
      return null;
    },
    /* V2-11 事件記錄：沒有 Web Audio 時仍可記錄事件（Node 端照樣混音）。 */
    startEventLog(options) {
      const sink = eventLogSink(true);
      if (!sink) return false;
      sink.start(options);
      return true;
    },
    stopEventLog() {
      const sink = eventLogSink(false);
      if (!sink) return { version: 1, fps: 30, frames: 0, active: false, dropped: 0, events: [] };
      return sink.stop();
    },
    getEventLog() {
      const sink = eventLogSink(false);
      if (!sink) return { version: 1, fps: 30, frames: 0, active: false, dropped: 0, events: [] };
      return sink.get();
    },
    clearEventLog() {
      const sink = eventLogSink(false);
      return sink ? sink.clear() : false;
    },
    setLogFrame(frame) {
      const sink = eventLogSink(true);
      return sink ? sink.setFrame(frame) : 0;
    },
    stats() {
      return { ...stats, reason: reason || 'no-assets' };
    },
    destroy() {},
  };
}

/** 從素材索引項取出音效相對路徑（與 assets.js 相同容錯規則） */
function audioRelPath(entry) {
  if (!entry) return null;
  if (typeof entry === 'string') return entry;
  if (Array.isArray(entry)) {
    const found = entry.find((v) => typeof v === 'string' && v.length > 0);
    return found || null;
  }
  if (typeof entry !== 'object') return null;
  // 官方索引的 `src` 是「來源資料檔群組」（如 audiogroup1）不是路徑；真實路徑在 `file`。
  const looksLikePath = (v) =>
    typeof v === 'string' && v.length > 0 && (/\.(ogg|wav|mp3|m4a|flac|opus)$/i.test(v) || v.includes('/'));
  const candidates = [entry.file, entry.path, entry.ogg, entry.wav, entry.mp3, entry.url, entry.src];
  if (Array.isArray(entry.frames)) candidates.push(entry.frames[0]);
  if (Array.isArray(entry.files)) candidates.push(entry.files[0]);
  const pathish = candidates.find(looksLikePath);
  if (pathish) return pathish;
  const rel = candidates.find((v) => typeof v === 'string' && v.length > 0);
  // 只有群組名（無副檔名、無斜線）→ 視為缺失路徑
  return looksLikePath(rel) ? rel : null;
}

function audioMeta(entry) {
  const isObj = entry && typeof entry === 'object' && !Array.isArray(entry);
  return {
    volume: isObj ? clamp01(numOr(entry.volume, 1)) : 1,
    loop: isObj ? entry.loop === true : false,
    // 循環區段（秒）：前奏只播一次，之後在 [loopStart, loopEnd) 之間循環；未標記 = 整首循環
    loopStart: isObj && Number.isFinite(entry.loopStart) && entry.loopStart >= 0 ? entry.loopStart : null,
    loopEnd: isObj && Number.isFinite(entry.loopEnd) && entry.loopEnd > 0 ? entry.loopEnd : null,
  };
}

function resolveAudioUrl(assets, rel) {
  if (typeof rel !== 'string' || !rel) return '';
  if (/^(?:[a-z]+:)?\/\//i.test(rel) || /^data:/i.test(rel)) return rel;
  if (assets && typeof assets.resolveUrl === 'function') {
    try {
      return assets.resolveUrl(rel);
    } catch (_err) {
      /* 退回下方 */
    }
  }
  const base = assets && typeof assets.baseUrl === 'string' ? assets.baseUrl : '';
  if (!base) return rel;
  try {
    return new URL(rel, base).href;
  } catch (_err) {
    return base.replace(/\/?$/, '/') + rel.replace(/^\/+/, '');
  }
}

/* ------------------------------------------- V2-11 逐幀錄影：音訊事件記錄 */

/**
 * 事件記錄模式（只加功能，不改既有播放行為；V2-10 的 getRecordStream 不受影響）。
 *
 * 為什麼要共用一個 window 記錄器：
 *   頁面自己會建一個 createAudio()（播 BGM、補 sfxQueue），引擎內部也會建一個
 *   （engine/index.js、engine/encounter/index.js 各自 audio）。逐幀錄影只要知道
 *   「哪一幀開始播哪個音檔、音量多少」，不必管是哪個實例在播 → 全部寫進同一個
 *   `window.__drAudioLog`。錄影工具在頁面載入前先放一個 {active:true, frame:0}
 *   的空殼，audio.js 第一次用到時會把方法補上，所以頁面 boot 時播的第一首 BGM
 *   也記得到（見 tools/record.mjs 的 INJECT_EVENT_LOG）。
 *
 * 事件形狀（events[]，依發生順序）：
 *   { type:'bgm',  action:'play'|'stop', name, file, url, volume, loop,
 *     loopStart, loopEnd, fade, previous, frame, t, src }
 *   { type:'sfx',  name, file, url, volume, loop, frame, t, src }
 *   { type:'volume', value, frame, t, src }        // setVolume()
 *   { type:'mute',   value, frame, t, src }        // setMuted()
 *
 * frame 是「遊戲幀號」，由錄影工具在推進每一幀前用 setFrame() 設定（頁面本身
 * 不推進幀號，正常遊玩時記錄器沒開啟，零成本）。
 */
const EVENT_LOG_KEY = '__drAudioLog';
let audioInstanceSeq = 0;

/** 把記錄器的方法補上（已補過就原樣回傳；可重複呼叫）。 */
function ensureEventLogApi(sink) {
  if (!sink || typeof sink !== 'object') return null;
  if (!Array.isArray(sink.events)) sink.events = [];
  if (typeof sink.start === 'function') return sink;
  if (!Number.isFinite(Number(sink.fps)) || Number(sink.fps) <= 0) sink.fps = 30;
  if (!Number.isFinite(Number(sink.frame))) sink.frame = 0;
  if (!Number.isFinite(Number(sink.dropped))) sink.dropped = 0;
  if (!Number.isFinite(Number(sink.maxEvents)) || Number(sink.maxEvents) <= 0) sink.maxEvents = 200000;
  sink.start = function start(options) {
    const o = options && typeof options === 'object' ? options : {};
    const fps = Number(o.fps);
    this.fps = Number.isFinite(fps) && fps > 0 ? fps : this.fps || 30;
    this.events.length = 0;
    this.frame = 0;
    this.dropped = 0;
    this.startedAt = Date.now();
    this.stoppedAt = 0;
    this.active = true;
    return { fps: this.fps, active: true };
  };
  sink.stop = function stop() {
    this.active = false;
    this.stoppedAt = Date.now();
    return this.get();
  };
  sink.clear = function clear() {
    this.events.length = 0;
    this.dropped = 0;
    this.frame = 0;
    return true;
  };
  sink.setFrame = function setFrame(frame) {
    const n = Number(frame);
    if (Number.isFinite(n) && n >= 0) this.frame = Math.round(n);
    return this.frame;
  };
  sink.get = function get() {
    return {
      version: 1,
      fps: this.fps,
      frames: this.frame,
      active: this.active,
      dropped: this.dropped,
      startedAt: this.startedAt,
      stoppedAt: this.stoppedAt,
      events: this.events.slice(),
    };
  };
  return sink;
}

/**
 * 取得（必要時建立）全域音訊事件記錄器。
 * @param {boolean} create 沒有就建立（createAudio 建構時用 true）
 */
function eventLogSink(create = false) {
  if (typeof window === 'undefined' || !window) return null;
  try {
    const existing = window[EVENT_LOG_KEY];
    if (existing && typeof existing === 'object' && Array.isArray(existing.events)) return ensureEventLogApi(existing);
    if (!create) return null;
    const sink = ensureEventLogApi({
      version: 1,
      active: false,
      fps: 30,
      frame: 0,
      startedAt: 0,
      stoppedAt: 0,
      dropped: 0,
      maxEvents: 200000,
      events: [],
    });
    window[EVENT_LOG_KEY] = sink;
    return sink;
  } catch (_err) {
    return null;
  }
}

/**
 * 寫入一筆事件（沒有記錄器或記錄器未開啟時什麼都不做）。
 * @param {number} instanceId createAudio 實例序號（同頁可能有多個實例：頁面自己 + 引擎）
 * @param {object} event 事件內容（type/name/file/...）
 */
function logAudioEvent(instanceId, event) {
  const sink = eventLogSink(false);
  if (!sink || sink.active !== true) return false;
  try {
    const list = sink.events;
    if (!Array.isArray(list)) return false;
    const max = Number(sink.maxEvents) > 0 ? Number(sink.maxEvents) : 200000;
    if (list.length >= max) {
      sink.dropped = (Number(sink.dropped) || 0) + 1;
      return false;
    }
    const frame = Number.isFinite(Number(sink.frame)) ? Number(sink.frame) : 0;
    const fps = Number(sink.fps) > 0 ? Number(sink.fps) : 30;
    list.push({ ...event, frame, t: frame / fps, src: instanceId });
    return true;
  } catch (_err) {
    return false;
  }
}

function getAudioIndex(assets) {
  if (!assets) return null;
  const index = assets.index;
  if (!index || typeof index !== 'object') return null;
  const audio = index.audio;
  return audio && typeof audio === 'object' ? audio : null;
}

function lookupEntry(assets, name) {
  if (typeof name !== 'string' || !name) return null;
  const audioIndex = getAudioIndex(assets);
  if (!audioIndex) return null;
  const entry = audioIndex[name];
  if (entry === undefined || entry === null) return null;
  return entry;
}

export function createAudio(assets) {
  if (!assets) return makeSilentApi('no-assets');

  const audioIndex = getAudioIndex(assets);
  if (!audioIndex) return makeSilentApi('no-audio-index');

  let AudioCtor = null;
  try {
    AudioCtor =
      (typeof window !== 'undefined' && (window.AudioContext || window.webkitAudioContext)) || null;
  } catch (_err) {
    AudioCtor = null;
  }
  if (!AudioCtor) return makeSilentApi('no-web-audio');

  let context = null;
  let masterGain = null;
  let muted = false;
  let volume = 1;
  let destroyed = false;
  let unlockBound = false;
  // V2-10 錄影：主輸出另外接到一個 MediaStreamDestination，供 canvas 錄影混音成 WebM。
  let recordDest = null;
  let recordStream = null;
  // V2-11 逐幀錄影：每個實例一個序號，事件表才知道是哪個 createAudio 發的。
  audioInstanceSeq += 1;
  const instanceId = audioInstanceSeq;
  // 頁面若先放好事件記錄器（window.__drAudioLog），這裡就把方法補齊——頁面 boot 時
  // 播的第一首 BGM 才記得到（錄影工具在頁面載入前注入空殼）。
  try {
    eventLogSink(false);
  } catch (_err) {
    /* 記錄器不可用時完全靜默（不影響播放） */
  }

  /** @type {Map<string, {state:'loading'|'ready'|'failed', buffer:any, waiters:Function[], url:string}>} */
  const buffers = new Map();
  const stats = { loaded: 0, failed: 0, missing: 0, playing: 0 };

  function ensureContext() {
    if (destroyed) return null;
    if (context) return context;
    try {
      context = new AudioCtor();
    } catch (err) {
      context = null;
      return null;
    }
    try {
      masterGain = context.createGain();
      masterGain.gain.value = muted ? 0 : volume;
      masterGain.connect(context.destination);
      // 錄影目的地若已建立（getRecordStream 先於任何播放被呼叫），一併接上主輸出。
      if (recordDest) {
        try {
          masterGain.connect(recordDest);
        } catch (_err) {
          /* 靜默 */
        }
      }
    } catch (_err) {
      masterGain = null;
    }
    return context;
  }

  /**
   * V2-10：取得錄影用的 MediaStream（主輸出同時接到 MediaStreamDestination）。
   *
   * - AudioContext 尚未建立時會在這裡建立（呼叫端需已取得使用者互動，瀏覽器才會讓它 running）。
   * - 只建立一次；之後重複呼叫回傳同一個 stream（MediaRecorder 可重複 start/stop）。
   * - 不影響正常播放：主音量節點同時接喇叭（context.destination）與錄影目的地。
   * - 瀏覽器不支援 createMediaStreamDestination（或沒有 Web Audio）→ 回 null（錄影改純影像）。
   * @returns {MediaStream|null}
   */
  function getRecordStream() {
    if (destroyed) return null;
    if (recordStream) return recordStream;
    const ctx = ensureContext();
    if (!ctx || typeof ctx.createMediaStreamDestination !== 'function') return null;
    try {
      recordDest = ctx.createMediaStreamDestination();
    } catch (_err) {
      recordDest = null;
      return null;
    }
    if (masterGain) {
      try {
        masterGain.connect(recordDest);
      } catch (_err) {
        /* 靜默：沒有錄音軌仍可錄影 */
      }
    }
    if (ctx.state === 'suspended') unlock();
    recordStream = recordDest.stream || null;
    return recordStream;
  }

  function unlock() {
    const ctx = ensureContext();
    if (!ctx) return;
    if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
      try {
        const p = ctx.resume();
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_err) {
        /* 靜默 */
      }
    }
    if (!unlockBound && typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      unlockBound = true;
      const kick = () => {
        try {
          if (context && context.state === 'suspended') context.resume();
        } catch (_err) {
          /* 靜默 */
        }
      };
      window.addEventListener('pointerdown', kick, { passive: true });
      window.addEventListener('keydown', kick, { passive: true });
    }
  }

  function decode(rel, url) {
    const key = url || rel;
    const existing = buffers.get(key);
    if (existing) return existing;
    const rec = { state: 'loading', buffer: null, waiters: [], url: key };
    buffers.set(key, rec);

    const ctx = ensureContext();
    if (!ctx || typeof ctx.decodeAudioData !== 'function' || typeof fetch !== 'function') {
      rec.state = 'failed';
      stats.failed += 1;
      return rec;
    }
    Promise.resolve()
      .then(() => fetch(key, { cache: 'force-cache' }))
      .then((response) => {
        if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : '?'));
        return response.arrayBuffer();
      })
      .then(
        (data) =>
          new Promise((resolve, reject) => {
            let pending = true;
            const done = (buf) => {
              if (!pending) return;
              pending = false;
              if (buf) resolve(buf);
              else reject(new Error('decodeAudioData 回傳空值'));
            };
            try {
              const maybe = ctx.decodeAudioData(data, done, (err) => {
                if (!pending) return;
                pending = false;
                reject(err || new Error('decodeAudioData 失敗'));
              });
              if (maybe && typeof maybe.then === 'function') {
                maybe.then((buf) => done(buf), (err) => {
                  if (!pending) return;
                  pending = false;
                  reject(err || new Error('decodeAudioData 失敗'));
                });
              }
            } catch (err) {
              if (!pending) return;
              pending = false;
              reject(err);
            }
          }),
      )
      .then(
        (buffer) => {
          if (destroyed) return;
          rec.buffer = buffer;
          rec.state = 'ready';
          stats.loaded += 1;
          flushWaiters(rec);
        },
        () => {
          if (destroyed) return;
          rec.state = 'failed';
          stats.failed += 1;
          flushWaiters(rec);
        },
      );

    return rec;
  }

  function flushWaiters(rec) {
    if (!rec.waiters.length) return;
    const waiters = rec.waiters.splice(0, rec.waiters.length);
    for (const fn of waiters) {
      try {
        fn(rec.state === 'ready' ? rec.buffer : null);
      } catch (_err) {
        /* 靜默 */
      }
    }
  }

  function playBuffer(buffer, gainValue, loop) {
    if (!buffer) return false;
    const ctx = ensureContext();
    if (!ctx) return false;
    if (ctx.state === 'suspended') unlock();
    try {
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = !!loop;
      let out = source;
      if (masterGain) {
        const gain = ctx.createGain();
        gain.gain.value = clamp01(gainValue) * clamp01(volume);
        source.connect(gain);
        gain.connect(masterGain);
        out = gain;
      } else {
        source.connect(ctx.destination);
      }
      source.onended = () => {
        try {
          source.disconnect();
          if (out !== source) out.disconnect();
        } catch (_err) {
          /* 靜默 */
        }
      };
      source.start(0);
      return true;
    } catch (_err) {
      return false;
    }
  }

  /**
   * 播放音效。
   * @param {string} name
   * @param {{ volume?: number, loop?: boolean }} [opts]
   * @returns {boolean} 是否真的開始播放（未載入完成時回 false，但會在載入後不補播）
   */
  function play(name, opts) {
    if (destroyed || muted) return false;
    const entry = lookupEntry(assets, name);
    if (!entry) {
      stats.missing += 1;
      return false;
    }
    const rel = audioRelPath(entry);
    if (!rel) {
      stats.missing += 1;
      return false;
    }
    const meta = audioMeta(entry);
    const url = resolveAudioUrl(assets, rel);
    const rec = buffers.get(url);
    const gainValue = clamp01(numOr(opts && opts.volume, meta.volume));
    const loop = opts && typeof opts.loop === 'boolean' ? opts.loop : meta.loop;

    // V2-11：事件記錄（在真正開始播放的同一幀記一筆；未開啟記錄時零成本）
    logAudioEvent(instanceId, {
      type: 'sfx',
      name,
      file: rel,
      url,
      volume: gainValue,
      loop: Boolean(loop),
    });

    if (!rec) {
      // 首次播放：開始解碼，載入完成後立即播（首播仍能出聲）
      const startedAt = Date.now();
      const fresh = decode(rel, url);
      fresh.waiters.push((buffer) => {
        if (destroyed || muted) return;
        // 解碼太久（>2 秒）就不補播，避免延遲音效亂序
        if (Date.now() - startedAt > 2000) return;
        if (playBuffer(buffer, gainValue, loop)) stats.playing += 1;
      });
      return false;
    }
    if (rec.state === 'ready') {
      if (playBuffer(rec.buffer, gainValue, loop)) {
        stats.playing += 1;
        return true;
      }
      return false;
    }
    if (rec.state === 'loading') {
      rec.waiters.push((buffer) => {
        if (destroyed || muted) return;
        if (playBuffer(buffer, gainValue, loop)) stats.playing += 1;
      });
    }
    return false;
  }

  /**
   * 依序播放多個音效（state.sfxQueue）。同名在同幀重複會去重，避免爆音。
   * @param {string[]} names
   * @returns {number} 實際觸發數
   */
  function playAll(names) {
    if (destroyed || muted) return 0;
    if (!Array.isArray(names) || !names.length) return 0;
    const seen = new Set();
    let count = 0;
    for (const name of names) {
      if (typeof name !== 'string' || seen.has(name)) continue;
      seen.add(name);
      if (play(name)) count += 1;
    }
    return count;
  }

  function setMuted(value) {
    muted = value === true;
    logAudioEvent(instanceId, { type: 'mute', value: muted });
    if (masterGain) {
      try {
        masterGain.gain.value = muted ? 0 : clamp01(volume);
      } catch (_err) {
        /* 靜默 */
      }
    }
  }

  function setVolume(value) {
    volume = clamp01(numOr(value, 1));
    logAudioEvent(instanceId, { type: 'volume', value: volume });
    if (masterGain && !muted) {
      try {
        masterGain.gain.value = volume;
      } catch (_err) {
        /* 靜默 */
      }
    }
  }

  function loadedState(name) {
    const entry = lookupEntry(assets, name);
    if (!entry) return 'missing';
    const rel = audioRelPath(entry);
    if (!rel) return 'missing';
    const rec = buffers.get(resolveAudioUrl(assets, rel));
    return rec ? rec.state : 'idle';
  }

  /* -------------------------------------------------------------- BGM */

  /** 目前 BGM 播放狀態：{ name, url, source, gain, fading } */
  let bgmState = null;
  let bgmToken = 0;

  function fadeNode(node, gainApi, from, to, seconds, done) {
    const ctx = context;
    if (!ctx || !node || !gainApi) {
      if (typeof done === 'function') done();
      return;
    }
    const dur = Math.max(0, numOr(seconds, 0));
    if (dur <= 0.001) {
      try {
        gainApi.gain.value = to;
      } catch (_err) {
        /* 靜默 */
      }
      if (typeof done === 'function') done();
      return;
    }
    try {
      const now = ctx.currentTime;
      gainApi.gain.cancelScheduledValues(now);
      gainApi.gain.setValueAtTime(from, now);
      gainApi.gain.linearRampToValueAtTime(to, now + dur);
      setTimeout(() => {
        if (typeof done === 'function') done();
      }, Math.round(dur * 1000) + 30);
    } catch (_err) {
      if (typeof done === 'function') done();
    }
  }

  /**
   * 停止目前 BGM。
   * @param {number} [fade=0] 淡出秒數
   * @returns {boolean} 是否有 BGM 被停止
   */
  function stopBgm(fade) {
    bgmToken += 1;
    if (!bgmState) return false;
    const rec = bgmState;
    bgmState = null;
    const seconds = Math.max(0, numOr(fade, 0));
    // V2-11：記錄「BGM 停止」（name 為停止前的曲名；fade 給 Node 端做淡出）
    logAudioEvent(instanceId, { type: 'bgm', action: 'stop', name: rec.name, file: rec.file || null, fade: seconds });
    if (rec.gain) {
      const current = clamp01(rec.volume);
      fadeNode(rec.source, rec.gain, current, 0.0001, seconds, () => {});
    }
    const stopAt = seconds > 0.001 ? seconds + 0.02 : 0;
    setTimeout(
      () => {
        try {
          if (rec.source) rec.source.stop();
        } catch (_err) {
          /* 已停止 */
        }
        try {
          if (rec.source) rec.source.disconnect();
          if (rec.gain) rec.gain.disconnect();
        } catch (_err) {
          /* 靜默 */
        }
      },
      Math.round(stopAt * 1000),
    );
    return true;
  }

  /**
   * 播放背景音樂（單一軌道、循環）。同名重播不會重啟；切歌會淡出舊曲。
   * @param {string|null} name 音效索引名；null = 停止
   * @param {{ fade?:number, volume?:number, loop?:boolean, restart?:boolean }} [opts]
   * @returns {boolean} 是否已開始播放（尚未解碼完成時回 false，載入後自動接上）
   */
  function playBgm(name, opts) {
    if (destroyed) return false;
    const o = opts && typeof opts === 'object' ? opts : {};
    if (name === null || name === undefined || name === '') {
      stopBgm(o.fade);
      return false;
    }
    if (typeof name !== 'string') return false;
    // 同名且正在播 → 不重啟（遭遇流程每幀呼叫也安全）
    if (bgmState && bgmState.name === name && o.restart !== true) return true;

    const entry = lookupEntry(assets, name);
    const rel = entry ? audioRelPath(entry) : null;
    if (!rel) {
      stats.missing += 1;
      stopBgm(o.fade);
      return false;
    }
    const meta = audioMeta(entry);
    const url = resolveAudioUrl(assets, rel);
    const volume = clamp01(numOr(o.volume, meta.volume));
    const loop = typeof o.loop === 'boolean' ? o.loop : meta.loop !== false;
    const fadeSeconds = Math.max(0, numOr(o.fade, 0.35));
    const token = (bgmToken += 1);

    // 舊曲淡出（先記下曲名：V2-11 的事件表要靠它排舊曲淡出）
    const previousName = bgmState ? bgmState.name : null;
    if (bgmState) {
      const previous = bgmState;
      bgmState = null;
      if (previous.gain) fadeNode(previous.source, previous.gain, clamp01(previous.volume), 0.0001, fadeSeconds, () => {});
      setTimeout(
        () => {
          try {
            if (previous.source) previous.source.stop();
            if (previous.source) previous.source.disconnect();
            if (previous.gain) previous.gain.disconnect();
          } catch (_err) {
            /* 靜默 */
          }
        },
        Math.round((fadeSeconds + 0.02) * 1000),
      );
    }

    const rec = { name, url, volume, loop, source: null, gain: null, token, file: rel };
    const loopStart = meta.loopStart;
    const loopEnd = meta.loopEnd;
    bgmState = rec;

    // V2-11：記錄「BGM 開始／切換」（切換時同一筆帶 previous 曲名，Node 端依此排淡出）
    logAudioEvent(instanceId, {
      type: 'bgm',
      action: 'play',
      name,
      file: rel,
      url,
      volume,
      loop: Boolean(loop),
      loopStart: loopStart === null ? null : loopStart,
      loopEnd: loopEnd === null ? null : loopEnd,
      fade: fadeSeconds,
      previous: previousName,
    });

    const start = (buffer) => {
      if (destroyed || token !== bgmToken || bgmState !== rec) return false;
      if (!buffer) return false;
      const ctx = ensureContext();
      if (!ctx) return false;
      if (ctx.state === 'suspended') unlock();
      try {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.loop = !!loop;
        if (loop && loopEnd !== null && loopEnd <= buffer.duration) {
          const ls = loopStart !== null && loopStart < loopEnd ? loopStart : 0;
          source.loopStart = ls;
          source.loopEnd = loopEnd;
        }
        const gain = ctx.createGain();
        gain.gain.value = 0.0001;
        source.connect(gain);
        if (masterGain) gain.connect(masterGain);
        else gain.connect(ctx.destination);
        source.start(0);
        // 淡入（切歌或首次播放都柔順）
        fadeNode(source, gain, 0.0001, clamp01(volume), Math.max(0.05, fadeSeconds), () => {});
        rec.source = source;
        rec.gain = gain;
        return true;
      } catch (_err) {
        return false;
      }
    };

    const cached = buffers.get(url);
    if (cached && cached.state === 'ready' && cached.buffer) {
      const started = start(cached.buffer);
      if (started) stats.playing += 1;
      return started;
    }
    if (cached && cached.state === 'failed') {
      stats.failed += 1;
      return false;
    }
    const fresh = cached || decode(rel, url);
    fresh.waiters.push((buffer) => {
      if (start(buffer)) stats.playing += 1;
    });
    return false;
  }

  function getBgm() {
    return bgmState ? bgmState.name : null;
  }

  return {
    play,
    playAll,
    playBgm,
    stopBgm,
    getBgm,
    setMuted,
    getMuted: () => muted,
    setVolume,
    getVolume: () => volume,
    loaded: loadedState,
    unlock,
    getRecordStream,
    /* ------------------- V2-11：事件記錄（只加功能，不改播放行為） ------------------- */
    /** 開始記錄（清空舊事件）；fps 只用來換算 t=frame/fps，預設 30。 */
    startEventLog(options) {
      const sink = eventLogSink(true);
      if (!sink) return false;
      sink.start(options);
      return true;
    },
    /** 停止記錄並回傳事件表（沒開始過也回空表）。 */
    stopEventLog() {
      const sink = eventLogSink(false);
      if (!sink) return { version: 1, fps: 30, frames: 0, active: false, dropped: 0, events: [] };
      return sink.stop();
    },
    /** 目前記錄器狀態與事件（不停止）。 */
    getEventLog() {
      const sink = eventLogSink(false);
      if (!sink) return { version: 1, fps: 30, frames: 0, active: false, dropped: 0, events: [] };
      return sink.get();
    },
    clearEventLog() {
      const sink = eventLogSink(false);
      return sink ? sink.clear() : false;
    },
    /** 設定「目前遊戲幀號」：錄影工具在每幀 tick 前呼叫，事件就會帶正確的幀。 */
    setLogFrame(frame) {
      const sink = eventLogSink(true);
      return sink ? sink.setFrame(frame) : 0;
    },
    stats: () => ({ ...stats, bgm: getBgm() }),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      bgmToken += 1;
      if (bgmState && bgmState.source) {
        try {
          bgmState.source.stop();
        } catch (_err) {
          /* 靜默 */
        }
      }
      bgmState = null;
      try {
        if (recordStream) {
          for (const track of recordStream.getTracks ? recordStream.getTracks() : []) {
            try {
              track.stop();
            } catch (_err) {
              /* 靜默 */
            }
          }
        }
        if (recordDest) recordDest.disconnect();
      } catch (_err) {
        /* 靜默 */
      }
      recordStream = null;
      recordDest = null;
      buffers.clear();
      if (context && typeof context.close === 'function') {
        try {
          const p = context.close();
          if (p && typeof p.catch === 'function') p.catch(() => {});
        } catch (_err) {
          /* 靜默 */
        }
      }
      context = null;
      masterGain = null;
    },
  };
}

export { DEFAULT_AUDIO_EXT };
export default createAudio;
