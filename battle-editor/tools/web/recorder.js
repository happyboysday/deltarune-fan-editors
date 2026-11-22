/**
 * tools/web/recorder.js — 頁內錄影（V2-10）
 *
 * 把 <canvas>（play.html / encounter-play.html 的遊戲畫面）＋ engine/audio.js 的
 * MediaStreamDestination 音軌，用 MediaRecorder 錄成 WebM。
 *
 *   import { createRecorder, saveBlob, buildFilename } from './tools/web/recorder.js';
 *
 *   const rec = createRecorder({
 *     canvas,                 // 遊戲畫布（640×480）
 *     audioStream,            // engine/audio.js 的 getRecordStream()；可為 null（純影像）
 *     fps: 30,                // 擷取幀率（預設 30，與模擬幀率一致）
 *     scale: 2,               // 1|2|3（>1 時用離屏 canvas 最近鄰放大，預設 1）
 *     title: '黑桃雨',         // 檔名前綴（作品名）；空白 → recording
 *   });
 *   rec.onUpdate = (snap) => { ... };   // {state, elapsed, bytes, mimeType, scale, filename}
 *   rec.start();                        // → boolean
 *   const blob = await rec.stop();      // → Blob（WebM）
 *   saveBlob(blob, rec.filename);       // 觸發瀏覽器下載
 *
 * 設計重點：
 * - 純 ES module，沒有 DOM 也能匯入（mime 選擇 / 檔名 / 狀態機可在 Node 測試）。
 * - mime 優先序：VP9+Opus → VP8+Opus → VP9 → VP8 → WebM → 瀏覽器預設（''）。
 * - scale > 1 時每幀把原畫布 drawImage 到放大畫布（imageSmoothingEnabled=false，
 *   最近鄰像素風），再對放大畫布 captureStream；音軌與影像軌合成一個 MediaStream。
 * - 輸出檔名：<作品名>-<yyyyMMdd-HHmmss>.webm（本機時間）。
 * - 不影響正常播放：影像只是「旁觀」canvas，音訊是 masterGain 的並聯分接。
 */

/** 錄影狀態機。 */
export const RECORD_STATES = Object.freeze({
  IDLE: 'idle',
  STARTING: 'starting',
  RECORDING: 'recording',
  STOPPING: 'stopping',
  STOPPED: 'stopped',
  ERROR: 'error',
});

/**
 * MediaRecorder mime 候選（優先 VP9+Opus，退 VP8，再退瀏覽器支援的）。
 * 最後一項空字串代表「用 MediaRecorder 的預設格式」。
 */
export const MIME_CANDIDATES = Object.freeze([
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
]);

const MAX_TITLE_LENGTH = 80;
const DEFAULT_TITLE = 'recording';

function globalMediaRecorder() {
  try {
    return typeof MediaRecorder !== 'undefined' ? MediaRecorder : null;
  } catch (_err) {
    return null;
  }
}

function globalMediaStream() {
  try {
    return typeof MediaStream !== 'undefined' ? MediaStream : null;
  } catch (_err) {
    return null;
  }
}

function globalBlob() {
  try {
    return typeof Blob !== 'undefined' ? Blob : null;
  } catch (_err) {
    return null;
  }
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, min, max, fallback) {
  const n = Math.round(num(value, fallback));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** 現在時間（毫秒）；可注入，測試用。 */
function defaultNow() {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch (_err) {
    /* 退回 Date.now */
  }
  return Date.now();
}

/* ------------------------------------------------------------- mime */

/**
 * 挑一個這個瀏覽器支援的 mime。
 * @param {{ MediaRecorder?: any, candidates?: string[] }} [options]
 * @returns {string} 支援的 mime；空字串 = 交給 MediaRecorder 預設
 */
export function selectMimeType(options = {}) {
  const Ctor = options.MediaRecorder || globalMediaRecorder();
  if (!Ctor) return '';
  const candidates =
    Array.isArray(options.candidates) && options.candidates.length ? options.candidates : MIME_CANDIDATES;
  const supported = (value) => {
    if (!value) return true; // '' 永遠可用（瀏覽器預設）
    try {
      if (typeof Ctor.isTypeSupported === 'function') return Ctor.isTypeSupported(value) === true;
    } catch (_err) {
      return false;
    }
    // 沒有 isTypeSupported 的舊環境：不敢保證 → 只信空字串
    return false;
  };
  for (const candidate of candidates) {
    if (supported(candidate)) return candidate;
  }
  return '';
}

/* ----------------------------------------------------------- 檔名 */

/** 把作品名清成合法檔名片段（保留中文；去掉 Windows 不允許的字元）。 */
export function sanitizeTitle(title) {
  const raw = typeof title === 'string' ? title : title === null || title === undefined ? '' : String(title);
  let safe = raw
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '')
    .trim();
  if (safe.length > MAX_TITLE_LENGTH) safe = safe.slice(0, MAX_TITLE_LENGTH).trim();
  return safe;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

/** 本機時間 → yyyyMMdd-HHmmss。 */
export function formatTimestamp(date) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  return (
    String(d.getFullYear()) +
    pad2(d.getMonth() + 1) +
    pad2(d.getDate()) +
    '-' +
    pad2(d.getHours()) +
    pad2(d.getMinutes()) +
    pad2(d.getSeconds())
  );
}

/** mime → 副檔名（WebM 為主；有些瀏覽器只支援 MP4 時給 mp4）。 */
export function extensionForMime(mimeType) {
  return /mp4/i.test(typeof mimeType === 'string' ? mimeType : '') ? 'mp4' : 'webm';
}

/**
 * 輸出檔名：<作品名>-<yyyyMMdd-HHmmss>.webm
 * @param {{title?:string, date?:Date, ext?:string}} [options]
 */
export function buildFilename(options = {}) {
  const title = sanitizeTitle(options.title) || DEFAULT_TITLE;
  const stamp = formatTimestamp(options.date);
  const ext = String(options.ext || 'webm')
    .replace(/^\./, '')
    .replace(/[^a-z0-9]/gi, '')
    .toLowerCase() || 'webm';
  return `${title}-${stamp}.${ext}`;
}

/* ------------------------------------------------------- 顯示格式 */

/** 秒 → m:ss（錄影狀態列用）。 */
export function formatDuration(seconds) {
  const total = Math.max(0, Math.floor(num(seconds, 0)));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${pad2(s)}`;
}

/** bytes → 人類可讀（1.2 MB）。 */
export function formatBytes(bytes) {
  const n = Math.max(0, num(bytes, 0));
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* -------------------------------------------------------- 下載 */

/**
 * 用 <a download> 觸發瀏覽器下載。
 * @param {Blob} blob
 * @param {string} filename
 * @param {{document?:Document, URL?:any}} [options]
 * @returns {boolean}
 */
export function saveBlob(blob, filename, options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const urlApi = options.URL || (typeof URL !== 'undefined' ? URL : null);
  if (!blob || !doc || !urlApi || typeof doc.createElement !== 'function') return false;
  let url = '';
  try {
    url = urlApi.createObjectURL(blob);
  } catch (_err) {
    return false;
  }
  try {
    const link = doc.createElement('a');
    link.href = url;
    link.download = filename || buildFilename();
    link.rel = 'noopener';
    link.style.display = 'none';
    (doc.body || doc.documentElement).appendChild(link);
    link.click();
    link.remove();
  } catch (_err) {
    try {
      urlApi.revokeObjectURL(url);
    } catch (_err2) {
      /* 靜默 */
    }
    return false;
  }
  const revoke = () => {
    try {
      urlApi.revokeObjectURL(url);
    } catch (_err) {
      /* 靜默 */
    }
  };
  try {
    setTimeout(revoke, 2000);
  } catch (_err) {
    /* 靜默 */
  }
  return true;
}

/* ------------------------------------------------------ 錄影器 */

function makeDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * 建立錄影器（不會自動開始）。
 *
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   audioStream?: MediaStream|null,
 *   fps?: number,                    // 預設 30
 *   scale?: 1|2|3,                   // 預設 1
 *   title?: string,                  // 檔名用的作品名
 *   filename?: string,               // 直接指定檔名（覆寫 title）
 *   mimeType?: string,               // 指定 mime（跳過自動挑選）
 *   videoBitsPerSecond?: number,
 *   timeslice?: number,              // MediaRecorder 分片毫秒（預設 500）
 *   updateMs?: number,               // onUpdate 更新間隔（預設 250）
 *   stopTimeoutMs?: number,          // stop() 保險逾時（預設 4000）
 *   createCanvas?: (w:number,h:number)=>any,
 *   MediaRecorder?: any, MediaStream?: any, Blob?: any,
 *   now?: ()=>number, nowDate?: ()=>Date,
 * }} options
 */
export function createRecorder(options = {}) {
  const canvas = options.canvas || null;
  const fps = clampInt(options.fps, 1, 120, 30);
  const scale = clampInt(options.scale, 1, 6, 1);
  const audioStream = options.audioStream || null;
  const title = typeof options.title === 'string' ? options.title : '';
  const fixedFilename = typeof options.filename === 'string' && options.filename ? options.filename : '';
  const timeslice = clampInt(options.timeslice, 0, 60000, 500);
  const updateMs = clampInt(options.updateMs, 50, 5000, 250);
  const stopTimeoutMs = clampInt(options.stopTimeoutMs, 200, 60000, 4000);
  const now = typeof options.now === 'function' ? options.now : defaultNow;
  const nowDate = typeof options.nowDate === 'function' ? options.nowDate : () => new Date();
  const createCanvas =
    typeof options.createCanvas === 'function'
      ? options.createCanvas
      : (w, h) => {
          const doc = typeof document !== 'undefined' ? document : null;
          if (!doc || typeof doc.createElement !== 'function') return null;
          const c = doc.createElement('canvas');
          c.width = w;
          c.height = h;
          return c;
        };
  const SnapshotStream = options.MediaStream || globalMediaStream();
  const BlobCtor = options.Blob || globalBlob();

  let state = RECORD_STATES.IDLE;
  let errorMessage = '';
  let mimeType = typeof options.mimeType === 'string' && options.mimeType ? options.mimeType : selectMimeType(options);
  let blob = null;
  let filename = '';
  let recorder = null;
  let stream = null;
  let chunks = [];
  let bytes = 0;
  let startedPerf = 0;
  let startedDate = null;
  let elapsed = 0;
  let surface = null;
  let drawRaf = 0;
  let drawTimer = 0;
  let uiTimer = 0;
  let stopTimer = 0;
  let stopDeferred = null;
  let disposed = false;

  function liveElapsed() {
    if (state === RECORD_STATES.RECORDING || state === RECORD_STATES.STARTING) {
      return Math.max(0, (now() - startedPerf) / 1000);
    }
    return elapsed;
  }

  function snapshot() {
    return {
      state,
      elapsed: liveElapsed(),
      bytes,
      mimeType,
      scale,
      fps,
      filename,
      error: errorMessage,
      recording: state === RECORD_STATES.RECORDING,
    };
  }

  function emit() {
    const handler = api.onUpdate;
    if (typeof handler !== 'function') return;
    try {
      handler(snapshot());
    } catch (_err) {
      /* 使用者回呼不該弄壞錄影 */
    }
  }

  /* ---------------------------------------------------- 放大畫布 */

  function ensureSurface() {
    if (!canvas) throw new Error('createRecorder 需要 canvas');
    if (scale <= 1) return { canvas, ctx: null };
    if (surface) return surface;
    const wantW = Math.max(1, Math.round(canvas.width * scale));
    const wantH = Math.max(1, Math.round(canvas.height * scale));
    const target = createCanvas(wantW, wantH);
    if (!target || typeof target.getContext !== 'function') throw new Error('無法建立放大用的離屏畫布');
    // 自訂 createCanvas（例如頁面注入的 document.createElement）不一定會套用尺寸 → 這裡再設一次
    if (target.width !== wantW || target.height !== wantH) {
      target.width = wantW;
      target.height = wantH;
    }
    const ctx = target.getContext('2d');
    if (!ctx) throw new Error('離屏畫布沒有 2D context');
    // 最近鄰：像素風放大不能模糊
    ctx.imageSmoothingEnabled = false;
    ctx.mozImageSmoothingEnabled = false;
    ctx.webkitImageSmoothingEnabled = false;
    ctx.msImageSmoothingEnabled = false;
    surface = { canvas: target, ctx };
    return surface;
  }

  function drawScaledFrame() {
    if (!surface || !surface.ctx || !canvas) return;
    const ctx = surface.ctx;
    try {
      if (ctx.imageSmoothingEnabled !== false) ctx.imageSmoothingEnabled = false;
      const w = surface.canvas.width;
      const h = surface.canvas.height;
      ctx.drawImage(canvas, 0, 0, canvas.width, canvas.height, 0, 0, w, h);
    } catch (_err) {
      /* 單幀失敗不影響錄影 */
    }
  }

  function startDrawLoop() {
    stopDrawLoop();
    if (scale <= 1) return;
    const raf =
      typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame
        : (cb) => {
            drawTimer = setTimeout(() => cb(now()), Math.max(1, Math.round(1000 / fps)));
            return drawTimer;
          };
    const tick = () => {
      if (state !== RECORD_STATES.RECORDING && state !== RECORD_STATES.STARTING) return;
      drawScaledFrame();
      drawRaf = raf(tick);
    };
    drawRaf = raf(tick);
  }

  function stopDrawLoop() {
    if (drawRaf && typeof cancelAnimationFrame === 'function') {
      try {
        cancelAnimationFrame(drawRaf);
      } catch (_err) {
        /* 靜默 */
      }
    }
    if (drawTimer) {
      clearTimeout(drawTimer);
    }
    drawRaf = 0;
    drawTimer = 0;
  }

  /* ---------------------------------------------------- 狀態更新 */

  function startUiTimer() {
    stopUiTimer();
    uiTimer = setInterval(() => {
      if (state !== RECORD_STATES.RECORDING && state !== RECORD_STATES.STOPPING) return;
      elapsed = liveElapsed();
      emit();
    }, updateMs);
    if (uiTimer && typeof uiTimer.unref === 'function') uiTimer.unref();
  }

  function stopUiTimer() {
    if (uiTimer) {
      clearInterval(uiTimer);
      uiTimer = 0;
    }
  }

  function clearStopTimer() {
    if (stopTimer) {
      clearTimeout(stopTimer);
      stopTimer = 0;
    }
  }

  /* ---------------------------------------------------- 收尾 */

  function finalize() {
    clearStopTimer();
    stopUiTimer();
    stopDrawLoop();
    if (state === RECORD_STATES.STOPPED && blob) {
      // 保險逾時後真正的 onstop 才到：不重建 blob
      const deferred = stopDeferred;
      stopDeferred = null;
      if (deferred) deferred.resolve(blob);
      return;
    }
    elapsed = startedPerf ? Math.max(0, (now() - startedPerf) / 1000) : elapsed;
    const type = mimeType || (recorder && recorder.mimeType) || 'video/webm';
    let made = null;
    try {
      if (typeof BlobCtor === 'function') made = new BlobCtor(chunks, { type });
    } catch (_err) {
      made = null;
    }
    if (!made) made = { size: bytes, type, isFallbackBlob: true };
    blob = made;
    bytes = Math.max(bytes, Number(made.size) || 0);
    state = RECORD_STATES.STOPPED;
    recorder = null;
    stream = null;
    const deferred = stopDeferred;
    stopDeferred = null;
    emit();
    if (deferred) deferred.resolve(blob);
  }

  /* ---------------------------------------------------- 開始 */

  function start(overrides = {}) {
    if (disposed) return false;
    if (state === RECORD_STATES.RECORDING || state === RECORD_STATES.STARTING) return false;
    const Ctor = (overrides && overrides.MediaRecorder) || options.MediaRecorder || globalMediaRecorder();
    if (!Ctor) {
      state = RECORD_STATES.ERROR;
      errorMessage = '此瀏覽器沒有 MediaRecorder，無法錄影';
      emit();
      return false;
    }
    try {
      const src = ensureSurface();
      let videoStream = null;
      try {
        videoStream = typeof src.canvas.captureStream === 'function' ? src.canvas.captureStream(fps) : null;
      } catch (err) {
        videoStream = null;
        errorMessage = 'canvas.captureStream 失敗：' + ((err && err.message) || err);
      }
      if (!videoStream) {
        state = RECORD_STATES.ERROR;
        errorMessage = errorMessage || '此瀏覽器不支援 canvas.captureStream，無法錄影';
        emit();
        return false;
      }
      // 影像軌 + 音軌合成一條 stream（MediaStream 不存在時退回純影像軌）
      const tracks = [];
      let videoTrackCount = 0;
      try {
        for (const track of videoStream.getVideoTracks ? videoStream.getVideoTracks() : []) {
          tracks.push(track);
          videoTrackCount += 1;
        }
      } catch (_err) {
        /* 靜默 */
      }
      if (audioStream) {
        try {
          for (const track of audioStream.getAudioTracks ? audioStream.getAudioTracks() : []) tracks.push(track);
        } catch (_err) {
          /* 沒有音訊也能錄影 */
        }
      }
      stream = null;
      if (SnapshotStream) {
        try {
          stream = new SnapshotStream(tracks);
        } catch (_err) {
          stream = null;
        }
      }
      // 沒有 MediaStream 建構子（或建構失敗）→ 直接錄影像軌，至少影片能出來
      if (!stream) stream = videoStream;

      const recOptions = {};
      if (mimeType) recOptions.mimeType = mimeType;
      if (Number.isFinite(Number(options.videoBitsPerSecond)) && Number(options.videoBitsPerSecond) > 0) {
        recOptions.videoBitsPerSecond = Math.round(Number(options.videoBitsPerSecond));
      }
      try {
        recorder = new Ctor(stream, recOptions);
      } catch (_err) {
        try {
          recorder = new Ctor(stream);
        } catch (err2) {
          recorder = null;
          state = RECORD_STATES.ERROR;
          errorMessage = '建立 MediaRecorder 失敗：' + ((err2 && err2.message) || err2);
          emit();
          return false;
        }
      }
      chunks = [];
      bytes = 0;
      elapsed = 0;
      errorMessage = '';
      blob = null;
      stopDeferred = null;
      recorder.ondataavailable = (event) => {
        const data = event && event.data;
        if (!data) return;
        const size = Number(data.size) || 0;
        if (size <= 0) return;
        chunks.push(data);
        bytes += size;
      };
      recorder.onerror = (event) => {
        const err = event && (event.error || event);
        errorMessage = '錄影錯誤：' + ((err && err.message) || err || '未知');
        emit();
      };
      recorder.onstop = () => {
        finalize();
      };

      startedPerf = now();
      startedDate = nowDate();
      filename =
        fixedFilename ||
        buildFilename({ title, date: startedDate, ext: extensionForMime(mimeType || (recorder && recorder.mimeType)) });
      state = RECORD_STATES.STARTING;
      try {
        if (timeslice > 0) recorder.start(timeslice);
        else recorder.start();
      } catch (err) {
        state = RECORD_STATES.ERROR;
        errorMessage = 'MediaRecorder.start 失敗：' + ((err && err.message) || err);
        recorder = null;
        stream = null;
        emit();
        return false;
      }
      state = RECORD_STATES.RECORDING;
      startedPerf = now();
      // 先畫一格放大畫布，避免錄影開頭是空白幀
      drawScaledFrame();
      startUiTimer();
      startDrawLoop();
      emit();
      return true;
    } catch (err) {
      state = RECORD_STATES.ERROR;
      errorMessage = String((err && err.message) || err);
      emit();
      return false;
    }
  }

  /* ---------------------------------------------------- 停止 */

  function stop() {
    if (stopDeferred) return stopDeferred.promise;
    const deferred = makeDeferred();
    stopDeferred = deferred;
    if (state !== RECORD_STATES.RECORDING && state !== RECORD_STATES.STARTING && state !== RECORD_STATES.STOPPING) {
      // 沒有在錄：直接回上次結果（可能 null）
      const pending = stopDeferred;
      stopDeferred = null;
      pending.resolve(blob);
      return pending.promise;
    }
    elapsed = liveElapsed();
    state = RECORD_STATES.STOPPING;
    emit();
    if (!recorder) {
      finalize();
      return deferred.promise;
    }
    // 保險：某些環境的 onstop 不會來（分頁被關、headless 怪癖）
    clearStopTimer();
    stopTimer = setTimeout(() => {
      stopTimer = 0;
      if (state === RECORD_STATES.STOPPING) {
        errorMessage = errorMessage || '停止錄影逾時（MediaRecorder 沒有回報 onstop）';
        finalize();
      }
    }, stopTimeoutMs);
    if (stopTimer && typeof stopTimer.unref === 'function') stopTimer.unref();
    try {
      recorder.stop();
    } catch (err) {
      errorMessage = 'MediaRecorder.stop 失敗：' + ((err && err.message) || err);
      finalize();
    }
    return deferred.promise;
  }

  function dispose() {
    disposed = true;
    clearStopTimer();
    stopUiTimer();
    stopDrawLoop();
    try {
      if (recorder && (state === RECORD_STATES.RECORDING || state === RECORD_STATES.STARTING)) recorder.stop();
    } catch (_err) {
      /* 靜默 */
    }
    recorder = null;
    stream = null;
    state = RECORD_STATES.IDLE;
  }

  const api = {
    start,
    stop,
    dispose,
    getSnapshot: snapshot,
    /** onUpdate(snapshot)；狀態變化與錄影中每隔 updateMs 各觸發一次。 */
    onUpdate: typeof options.onUpdate === 'function' ? options.onUpdate : null,
    get state() {
      return state;
    },
    get elapsed() {
      return liveElapsed();
    },
    get bytes() {
      return bytes;
    },
    get blob() {
      return blob;
    },
    get filename() {
      return filename;
    },
    get mimeType() {
      return mimeType;
    },
    get scale() {
      return scale;
    },
    get fps() {
      return fps;
    },
    get error() {
      return errorMessage;
    },
    get recordedAt() {
      return startedDate;
    },
    /** 放大畫布的尺寸（scale=1 時等於原畫布尺寸）。 */
    get outputSize() {
      if (scale <= 1) return { width: canvas ? canvas.width : 0, height: canvas ? canvas.height : 0 };
      const surfaceCanvas = surface ? surface.canvas : null;
      return {
        width: surfaceCanvas ? surfaceCanvas.width : canvas ? canvas.width * scale : 0,
        height: surfaceCanvas ? surfaceCanvas.height : canvas ? canvas.height * scale : 0,
      };
    },
    /** 測試 / 除錯用：目前的媒體串流（未錄影時 null）。 */
    get stream() {
      return stream;
    },
  };

  return api;
}

export default createRecorder;
