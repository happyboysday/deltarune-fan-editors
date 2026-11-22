/**
 * tools/web/recorder-ui.js — 頁內錄影的 UI 黏著層（V2-10）
 *
 * 把 tools/web/recorder.js 接到 play.html / encounter-play.html：
 *   ⏺ 錄影 按鈕 / V 鍵切換、錄影中紅點＋時間＋大小、停止後自動下載＋再次下載、
 *   倍率下拉（1×/2×/3×）、?record=1 自動錄一場、?chrome=0 隱藏 UI 但功能照常、
 *   頁面被節流（DD12）時的提示。
 *
 *   import { mountRecorderUi } from './tools/web/recorder-ui.js';
 *   const video = mountRecorderUi({
 *     canvas, audio,                       // engine/audio.js 的 createAudio()
 *     toolbar: document.getElementById('toolbar'),
 *     getTitle: () => attack.meta.name,    // 檔名用的作品名
 *     getEnded: () => Boolean(state.ended),// ?record=1 自動停止的判斷
 *     autoRecord: params.get('record') === '1',
 *     scale: recScaleParam,                // ?recscale=1|2|3
 *   });
 *
 * 設計：
 * - 所有 DOM 由本模組建立（頁面只要給 toolbar 容器），CSS 只注入一次。
 * - 錄影本身（canvas → WebM）在 recorder.js；本檔只做 DOM／熱鍵／狀態列／自動化。
 * - 沒有 DOM 也能 import（純函式 buildThrottleMessage / resolveTitle 可在 Node 測）。
 * - ?chrome=0 時工具列元素被頁面 CSS 隱藏，但錄影照常；節流提示獨立在 body 上，
 *   且錄的是 canvas（不含 DOM），所以提示不會出現在影片裡。
 */

import { createRecorder, saveBlob, formatDuration, formatBytes } from './recorder.js';

/** 錄影倍率的選項（最近鄰放大）。 */
export const SCALE_OPTIONS = Object.freeze([1, 2, 3]);

/** 節流判定：連續幾個取樣都低於門檻才算（避免單一掉幀誤報）。 */
export const THROTTLE_FPS = 20;
export const THROTTLE_SAMPLES = 4;
export const THROTTLE_SAMPLE_MS = 500;
/** 視窗內要有幾個低幀率取樣才判定為「長時間降速」（4 個取樣至少 3 個低）。 */
export const THROTTLE_SLOW_SAMPLES = 3;

let styleInjected = false;

const CSS = `
.vidrec-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.vidrec-btn {
  font: inherit;
  font-size: 12px;
  color: #ffe1e1;
  background: #2a1220;
  border: 1px solid #5e2740;
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
}
.vidrec-btn:hover:not(:disabled) { border-color: #a63b62; }
.vidrec-btn:disabled { opacity: 0.5; cursor: default; }
.vidrec-btn.is-recording {
  color: #fff;
  background: #5a0f22;
  border-color: #ff4466;
}
.vidrec-scale {
  font: inherit;
  font-size: 12px;
  color: inherit;
  background: #171129;
  border: 1px solid #2a2240;
  border-radius: 3px;
  padding: 1px 4px;
}
.vidrec-hud {
  display: none;
  align-items: center;
  gap: 6px;
  color: #ffd7d7;
  font-size: 12px;
  white-space: nowrap;
}
.vidrec-hud[data-visible="1"] { display: inline-flex; }
.vidrec-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #ff2d55;
  box-shadow: 0 0 6px rgba(255, 45, 85, 0.9);
  animation: vidrec-blink 1s steps(2, start) infinite;
}
@keyframes vidrec-blink { to { opacity: 0.25; } }
.vidrec-note { color: #c9c2e6; font-size: 11px; white-space: nowrap; }
.vidrec-note[hidden] { display: none; }
.vidrec-throttle {
  position: fixed;
  left: 50%;
  top: 10px;
  transform: translateX(-50%);
  z-index: 9000;
  max-width: min(760px, 94vw);
  padding: 7px 12px;
  border-radius: 4px;
  border: 1px solid #d08a1e;
  background: rgba(44, 24, 4, 0.94);
  color: #ffd9a0;
  font-family: "Courier New", "Consolas", monospace;
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
  pointer-events: none;
  box-shadow: 0 4px 18px rgba(0, 0, 0, 0.55);
}
.vidrec-throttle[hidden] { display: none; }
.vidrec-throttle.is-recording { border-color: #ff4466; color: #ffe0e6; }
`;

function injectStyle(doc) {
  if (styleInjected || !doc || typeof doc.createElement !== 'function') return;
  styleInjected = true;
  try {
    const style = doc.createElement('style');
    style.setAttribute('data-vidrec', '1');
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  } catch (_err) {
    /* 樣式失敗不影響錄影 */
  }
}

function num(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 作品名 → 檔名前綴（純函式，測試用）。
 * 接受字串，或 { name } / { name: { zh } } 這種 meta 形狀。
 */
export function resolveTitle(source) {
  if (typeof source === 'string') return source;
  if (!source || typeof source !== 'object') return '';
  const name = source.name;
  if (typeof name === 'string') return name;
  if (name && typeof name === 'object') {
    const zh = name.zh || name.en || name['zh-Hant'] || name['zh-Hans'];
    if (typeof zh === 'string') return zh;
  }
  if (typeof source.title === 'string') return source.title;
  return '';
}

/**
 * 節流提示文字（純函式，測試用）。
 * @param {{hidden?:boolean, fps?:number, recording?:boolean, slow?:boolean}} state
 * @returns {string} 空字串 = 不顯示
 */
export function buildThrottleMessage(state = {}) {
  const fps = Math.max(0, Math.round(num(state.fps, 0)));
  const hidden = state.hidden === true;
  const slow = state.slow === true;
  if (!hidden && !slow) return '';
  // 需求（DD12）指定文案；hidden 與「長時間 <20 FPS」都算被節流，用同一句話。
  const head = `頁面在背景，已降速（約 ${fps} FPS）——請把視窗切到前景`;
  return state.recording === true ? `${head}；錄影可能掉幀` : head;
}

/** 簡單的 el() 建構器（沒有 DOM 時回 null）。 */
function el(doc, tag, props = {}, text = '') {
  if (!doc || typeof doc.createElement !== 'function') return null;
  const node = doc.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'dataset') {
      for (const [dataKey, dataValue] of Object.entries(value)) node.dataset[dataKey] = String(dataValue);
    } else if (key === 'style' && value && typeof value === 'object') {
      Object.assign(node.style, value);
    } else if (key in node) {
      try {
        node[key] = value;
      } catch (_err) {
        node.setAttribute(key, String(value));
      }
    } else {
      node.setAttribute(key, String(value));
    }
  }
  if (text) node.textContent = text;
  return node;
}

/**
 * 掛上錄影 UI（自動建立 DOM、V 熱鍵、節流偵測）。
 *
 * @param {{
 *   canvas: HTMLCanvasElement,
 *   audio?: any,                     // engine/audio.js 的 api（可為 null）
 *   toolbar?: HTMLElement|null,      // 工具列容器；null → 浮動面板
 *   getTitle?: () => any,            // 檔名用的作品名
 *   getEnded?: () => boolean,        // ?record=1 的結束判斷
 *   autoRecord?: boolean,            // ?record=1
 *   autoStopDelayMs?: number,        // 戰鬥結束後再多錄（預設 1000）
 *   autoMaxMs?: number,              // ?record=1 保險上限（預設 10 分鐘）
 *   scale?: number,                  // 錄影倍率（1|2|3）
 *   fps?: number,                    // 擷取幀率（預設 30）
 *   chromeHidden?: boolean,          // ?chrome=0（UI 被頁面 CSS 隱藏，功能不變）
 *   autoDownload?: boolean,          // 停止後自動下載（預設 true）
 *   keyboard?: boolean,              // 綁 V 熱鍵（預設 true）
 *   now?: () => number,
 *   nowDate?: () => Date,
 *   document?: Document,             // 測試注入
 *   URL?: any,
 *   onUpdate?: (snap) => void,
 *   onFinished?: (result) => void,
 * }} options
 */
export function mountRecorderUi(options = {}) {
  const doc = options.document || (typeof document !== 'undefined' ? document : null);
  const canvas = options.canvas || null;
  const audio = options.audio || null;
  const getTitle = typeof options.getTitle === 'function' ? options.getTitle : () => '';
  const getEnded = typeof options.getEnded === 'function' ? options.getEnded : () => false;
  const autoRecord = options.autoRecord === true;
  const autoStopDelayMs = Math.max(0, Math.round(num(options.autoStopDelayMs, 1000)));
  const autoMaxMs = Math.max(1000, Math.round(num(options.autoMaxMs, 10 * 60 * 1000)));
  const autoDownload = options.autoDownload !== false;
  const fps = Math.max(1, Math.round(num(options.fps, 30)));
  const chromeHidden = options.chromeHidden === true;
  const bindKeyboard = options.keyboard !== false;
  const now = typeof options.now === 'function' ? options.now : () => (
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
  );
  const nowDate =
    typeof options.nowDate === 'function'
      ? options.nowDate
      : () => new Date();
  const urlApi = options.URL || (typeof URL !== 'undefined' ? URL : null);

  let scale = SCALE_OPTIONS.includes(Math.round(num(options.scale, 1))) ? Math.round(num(options.scale, 1)) : 1;
  let recorder = null;
  let lastBlob = null;
  let lastFilename = '';
  let lastBytes = 0;
  let lastMime = '';
  let audioWarning = '';
  let stopping = null;
  let autoTimer = 0;
  let autoStartedAt = 0;
  let autoStopAt = 0;
  let pollTimer = 0;
  let destroyed = false;
  let startedAt = 0;
  const finishedQueue = [];

  /* ----------------------------------------------------- DOM */

  injectStyle(doc);

  const group = doc ? el(doc, 'span', { className: 'vidrec-group', id: 'vidrec-group' }) : null;
  const toggleBtn = doc
    ? el(doc, 'button', {
        type: 'button',
        id: 'vidrec-toggle',
        className: 'vidrec-btn',
        title: '快捷鍵 V｜錄影（WebM，含遊戲音訊）',
      }, '⏺ 錄影')
    : null;
  const scaleSelect = doc
    ? el(doc, 'select', { id: 'vidrec-scale', className: 'vidrec-scale', title: '錄影輸出倍率（最近鄰放大）' })
    : null;
  if (scaleSelect && doc) {
    for (const value of SCALE_OPTIONS) {
      const option = el(doc, 'option', { value: String(value) }, `${value}×`);
      if (option) scaleSelect.appendChild(option);
    }
    scaleSelect.value = String(scale);
  }
  const hud = doc ? el(doc, 'span', { className: 'vidrec-hud', id: 'vidrec-hud' }) : null;
  const dot = doc ? el(doc, 'span', { className: 'vidrec-dot' }) : null;
  const hudText = doc ? el(doc, 'span', { id: 'vidrec-hud-text' }, '') : null;
  if (hud && dot && hudText) {
    hud.appendChild(dot);
    hud.appendChild(hudText);
  }
  const downloadBtn = doc
    ? el(doc, 'button', {
        type: 'button',
        id: 'vidrec-download',
        className: 'vidrec-btn',
        hidden: true,
        title: '再次下載上一段錄影',
      }, '⬇ 再次下載')
    : null;
  const noteEl = doc ? el(doc, 'span', { className: 'vidrec-note', id: 'vidrec-note', hidden: true }, '') : null;

  if (group && doc) {
    if (toggleBtn) group.appendChild(toggleBtn);
    if (scaleSelect) group.appendChild(scaleSelect);
    if (hud) group.appendChild(hud);
    if (downloadBtn) group.appendChild(downloadBtn);
    if (noteEl) group.appendChild(noteEl);
    const host = options.toolbar || null;
    if (host && typeof host.appendChild === 'function') {
      host.appendChild(group);
    } else if (doc.body) {
      try {
        Object.assign(group.style, {
          position: 'fixed',
          right: '10px',
          bottom: '10px',
          zIndex: '9001',
          padding: '6px 8px',
          background: 'rgba(10,6,18,0.88)',
          border: '1px solid #2a2240',
          borderRadius: '4px',
        });
        doc.body.appendChild(group);
      } catch (_err) {
        /* 靜默 */
      }
    }
  }

  const throttleEl = doc ? el(doc, 'div', { id: 'vidrec-throttle', className: 'vidrec-throttle', hidden: true, role: 'status' }) : null;
  if (throttleEl && doc && doc.body) {
    try {
      doc.body.appendChild(throttleEl);
    } catch (_err) {
      /* 靜默 */
    }
  }

  /* -------------------------------------------------- 節流偵測 */

  const throttle = {
    hidden: false,
    samples: [],
    fps: 0,
    forced: null,
    message: '',
    throttled: false,
  };

  function readDocumentHidden() {
    if (throttle.forced && typeof throttle.forced.hidden === 'boolean') return throttle.forced.hidden;
    try {
      return doc ? doc.hidden === true || doc.visibilityState === 'hidden' : false;
    } catch (_err) {
      return false;
    }
  }

  function computeFps() {
    if (throttle.forced && Number.isFinite(Number(throttle.forced.fps))) return Number(throttle.forced.fps);
    if (!throttle.samples.length) return throttle.fps;
    // 取樣包含「剛開始錄影 / 剛切前景」的暖機低值，用中位數比平均穩
    const sorted = throttle.samples.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  }

  function refreshThrottle() {
    const hidden = readDocumentHidden();
    const measured = computeFps();
    throttle.fps = Math.round(measured * 10) / 10;
    // 「長時間 < 20 FPS」：取樣視窗內至少 THROTTLE_SLOW_SAMPLES 個低於門檻
    const slowCount = throttle.samples.filter((value) => value < THROTTLE_FPS).length;
    const slow = slowCount >= THROTTLE_SLOW_SAMPLES;
    const forcedSlow = throttle.forced ? throttle.forced.slow === true : false;
    const isSlow = slow || forcedSlow;
    throttle.hidden = hidden;
    throttle.throttled = hidden || isSlow;
    const recording = Boolean(recorder && recorder.state === 'recording');
    const message = buildThrottleMessage({ hidden, fps: throttle.fps, recording, slow: isSlow });
    throttle.message = message;
    if (throttleEl) {
      if (message) {
        throttleEl.hidden = false;
        throttleEl.textContent = message;
        if (recording) throttleEl.classList.add('is-recording');
        else throttleEl.classList.remove('is-recording');
      } else {
        throttleEl.hidden = true;
        throttleEl.textContent = '';
        throttleEl.classList.remove('is-recording');
      }
    }
    return message;
  }

  let rafId = 0;
  let sampleStart = now();
  let sampleFrames = 0;
  let usingRaf = false;

  function sampleTick() {
    if (destroyed) return;
    rafId = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(sampleTick) : 0;
    sampleFrames += 1;
    const t = now();
    const span = t - sampleStart;
    if (span >= THROTTLE_SAMPLE_MS) {
      throttle.samples.push((sampleFrames * 1000) / span);
      while (throttle.samples.length > THROTTLE_SAMPLES) throttle.samples.shift();
      sampleFrames = 0;
      sampleStart = t;
      refreshThrottle();
    }
  }

  function startSampling() {
    if (typeof requestAnimationFrame !== 'function') return;
    usingRaf = true;
    sampleStart = now();
    sampleFrames = 0;
    rafId = requestAnimationFrame(sampleTick);
  }

  function stopSampling() {
    if (rafId && typeof cancelAnimationFrame === 'function') {
      try {
        cancelAnimationFrame(rafId);
      } catch (_err) {
        /* 靜默 */
      }
    }
    rafId = 0;
  }

  function onVisibility() {
    refreshThrottle();
  }
  if (doc && typeof doc.addEventListener === 'function') {
    try {
      doc.addEventListener('visibilitychange', onVisibility);
    } catch (_err) {
      /* 靜默 */
    }
  }
  startSampling();

  /* ------------------------------------------------------ 狀態列 */

  function setNote(text) {
    if (!noteEl) return;
    if (!text) {
      noteEl.hidden = true;
      noteEl.textContent = '';
      return;
    }
    noteEl.hidden = false;
    noteEl.textContent = text;
  }

  function paint() {
    const recording = Boolean(recorder && recorder.state === 'recording');
    const snap = getSnapshot();
    if (toggleBtn) {
      toggleBtn.textContent = recording ? `⏹ 停止（${formatDuration(snap.elapsed)}）` : '⏺ 錄影';
      toggleBtn.classList.toggle('is-recording', recording);
      toggleBtn.setAttribute('aria-pressed', recording ? 'true' : 'false');
    }
    if (hud) {
      hud.dataset.visible = recording ? '1' : '0';
      if (hudText) {
        // 分片還沒到（開頭只有幾 bytes 的長度標頭）時顯示「錄影中…」，避免看到 1 B
        hudText.textContent =
          snap.bytes >= 1024
            ? `${formatDuration(snap.elapsed)} · ${formatBytes(snap.bytes)}`
            : `${formatDuration(snap.elapsed)} · 錄影中…`;
      }
    }
    if (scaleSelect && doc) {
      scaleSelect.disabled = recording;
      if (!recording && scaleSelect.value !== String(scale)) scaleSelect.value = String(scale);
    }
    if (downloadBtn) downloadBtn.hidden = !lastBlob;
    if (recording) refreshThrottle();
  }

  function getSnapshot() {
    const recording = Boolean(recorder && recorder.state === 'recording');
    const elapsed = recording ? Math.max(0, (now() - startedAt) / 1000) : lastBlob ? lastElapsed : 0;
    const bytes = recording && recorder ? recorder.bytes : lastBytes;
    return {
      state: recorder ? recorder.state : lastBlob ? 'stopped' : 'idle',
      recording,
      elapsed,
      bytes,
      scale,
      fps,
      filename: recording && recorder ? recorder.filename : lastFilename,
      mimeType: recording && recorder ? recorder.mimeType : lastMime,
      lastBlob: lastBlob ? { size: lastBlob.size, type: lastBlob.type, filename: lastFilename } : null,
      hasBlob: Boolean(lastBlob),
      chromeHidden,
      autoRecord,
      audioWarning,
      throttle: {
        hidden: throttle.hidden,
        fps: throttle.fps,
        throttled: throttle.throttled,
        message: throttle.message,
      },
    };
  }

  let lastElapsed = 0;

  function handleUpdate(snap) {
    if (!snap) return;
    lastElapsed = snap.elapsed;
    if (typeof options.onUpdate === 'function') {
      try {
        options.onUpdate(snap);
      } catch (_err) {
        /* 使用者的回呼不該弄壞錄影 */
      }
    }
    // 錄影中的時間／大小只在有 UI 或事件時更新，避免每幀 DOM 操作
    if (typeof requestAnimationFrame === 'function') {
      if (!paintScheduled) {
        paintScheduled = true;
        requestAnimationFrame(() => {
          paintScheduled = false;
          paint();
        });
      }
    }
  }

  let paintScheduled = false;

  let uiTimer = 0;
  function startUiTimer() {
    if (!doc || typeof setInterval !== 'function') return;
    if (uiTimer) return;
    uiTimer = setInterval(() => {
      if (recorder && recorder.state === 'recording') paint();
    }, 250);
    if (uiTimer && typeof uiTimer.unref === 'function') uiTimer.unref();
  }
  function stopUiTimer() {
    if (uiTimer) {
      clearInterval(uiTimer);
      uiTimer = 0;
    }
  }

  /* ------------------------------------------------------- 錄影 */

  function currentTitle() {
    let source = null;
    try {
      source = getTitle();
    } catch (_err) {
      source = null;
    }
    return resolveTitle(source);
  }

  function ensureAudioStream() {
    audioWarning = '';
    if (!audio) {
      audioWarning = '沒有音訊模組（只錄影像）';
      return null;
    }
    try {
      if (typeof audio.unlock === 'function') audio.unlock();
    } catch (_err) {
      /* 靜默 */
    }
    try {
      if (typeof audio.getRecordStream === 'function') {
        const stream = audio.getRecordStream();
        if (stream) return stream;
        audioWarning = '瀏覽器沒有提供錄音輸出（只錄影像）';
        return null;
      }
    } catch (err) {
      audioWarning = '取得錄音輸出失敗：' + ((err && err.message) || err);
      return null;
    }
    audioWarning = '音訊模組不支援錄音輸出（只錄影像）';
    return null;
  }

  /** 開始錄影（同步回傳 boolean；失敗時看 getSnapshot().error/audioWarning）。 */
  function start() {
    if (destroyed) return false;
    if (recorder && recorder.state === 'recording') return false;
    const stream = ensureAudioStream();
    const title = currentTitle();
    recorder = createRecorder({
      canvas,
      audioStream: stream,
      fps,
      scale,
      title,
      // 用頁面的 document 建離屏畫布（測試注入時也一致）
      createCanvas: (w, h) => (doc && typeof doc.createElement === 'function' ? doc.createElement('canvas') : null),
      onUpdate: handleUpdate,
    });
    const ok = recorder.start();
    if (!ok) {
      setNote('錄影失敗：' + (recorder.error || '瀏覽器不支援 MediaRecorder'));
      paint();
      return false;
    }
    startedAt = now();
    lastElapsed = 0;
    setNote(audioWarning ? `錄影中（${audioWarning}）` : '');
    startUiTimer();
    paint();
    return true;
  }

  function downloadBlob(blob, filename) {
    if (!blob) return false;
    const name = filename || lastFilename || 'recording.webm';
    const ok = saveBlob(blob, name, { document: doc, URL: urlApi });
    if (ok) {
      setNote(`已下載 ${name}（${formatBytes(blob.size)}）`);
    } else {
      setNote(`無法自動下載；請按「⬇ 再次下載」或檢查瀏覽器下載權限（${name}）`);
    }
    return ok;
  }

  /** 停止錄影 → Promise<{blob, filename, bytes, downloaded, empty}>。 */
  function stop(stopOptions = {}) {
    if (stopping) return stopping;
    if (!recorder || (recorder.state !== 'recording' && recorder.state !== 'starting')) {
      const result = { blob: lastBlob, filename: lastFilename, bytes: lastBytes, downloaded: false, empty: !lastBlob };
      return Promise.resolve(result);
    }
    const shouldDownload = stopOptions.download !== false && autoDownload;
    stopping = (async () => {
      let blob = null;
      try {
        blob = await recorder.stop();
      } catch (err) {
        setNote('停止錄影失敗：' + ((err && err.message) || err));
      }
      lastElapsed = recorder ? recorder.elapsed : lastElapsed;
      lastFilename = recorder ? recorder.filename : lastFilename;
      lastMime = recorder ? recorder.mimeType : lastMime;
      lastBlob = blob;
      lastBytes = blob ? Number(blob.size) || 0 : 0;
      let downloaded = false;
      if (blob && lastBytes > 0) {
        if (shouldDownload) downloaded = downloadBlob(blob, lastFilename);
        else setNote(`已停止：${lastFilename}（${formatBytes(lastBytes)}）`);
      } else {
        setNote('錄影沒有產生資料（長度太短或瀏覽器不支援）');
      }
      stopUiTimer();
      paint();
      finish({ blob, filename: lastFilename, bytes: lastBytes, downloaded, empty: !blob || lastBytes === 0 });
      stopping = null;
      return { blob, filename: lastFilename, bytes: lastBytes, downloaded, empty: !blob || lastBytes === 0 };
    })();
    return stopping;
  }

  function toggle() {
    if (recorder && recorder.state === 'recording') {
      void stop();
      return false;
    }
    return start();
  }

  function download() {
    if (!lastBlob) return false;
    return downloadBlob(lastBlob, lastFilename);
  }

  function setScale(value) {
    const next = Math.round(num(value, scale));
    if (!SCALE_OPTIONS.includes(next)) return scale;
    if (recorder && recorder.state === 'recording') return scale;
    scale = next;
    if (scaleSelect) scaleSelect.value = String(scale);
    paint();
    return scale;
  }

  /* ------------------------------------ ?record=1 自動錄 + 自動停 */

  function finish(result) {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = 0;
    }
    stopAutoPoll();
    if (typeof options.onFinished === 'function') {
      try {
        options.onFinished(result);
      } catch (_err) {
        /* 靜默 */
      }
    }
    finishedQueue.push(result);
  }

  function stopAutoPoll() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = 0;
    }
  }

  function beginAutoStop(delay) {
    if (autoTimer) return;
    autoStopAt = now() + delay;
    autoTimer = setTimeout(() => {
      autoTimer = 0;
      void stop({ download: true });
    }, delay);
    if (autoTimer && typeof autoTimer.unref === 'function') autoTimer.unref();
    setNote(`戰鬥結束，${(delay / 1000).toFixed(1)} 秒後自動停止…`);
  }

  function pollAutoRecord() {
    if (destroyed || !autoRecord) return;
    if (!recorder || recorder.state !== 'recording') return;
    if (autoTimer) return;
    let ended = false;
    try {
      ended = getEnded() === true;
    } catch (_err) {
      ended = false;
    }
    if (ended) {
      beginAutoStop(autoStopDelayMs);
      return;
    }
    if (autoStartedAt && now() - autoStartedAt > autoMaxMs) {
      setNote(`已錄 ${formatDuration((now() - autoStartedAt) / 1000)}；達到上限，自動停止`);
      void stop({ download: true });
    }
  }

  /** ?record=1：頁面就緒後呼叫，開始錄影並掛上「戰鬥結束 → 再錄 N 秒 → 停止下載」。 */
  function autoStart() {
    if (!autoRecord || destroyed) return false;
    if (recorder && recorder.state === 'recording') return true;
    if (!start()) return false;
    autoStartedAt = now();
    stopAutoPoll();
    pollTimer = setInterval(pollAutoRecord, 200);
    if (pollTimer && typeof pollTimer.unref === 'function') pollTimer.unref();
    pollAutoRecord();
    return true;
  }

  /* ----------------------------------------------------- 事件綁定 */

  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      toggle();
      toggleBtn.blur();
    });
  }
  if (scaleSelect) {
    scaleSelect.addEventListener('change', () => {
      setScale(scaleSelect.value);
      scaleSelect.blur();
    });
  }
  if (downloadBtn) {
    downloadBtn.addEventListener('click', () => {
      download();
      downloadBtn.blur();
    });
  }

  function onKeydown(event) {
    if (!event || event.defaultPrevented) return;
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const key = typeof event.key === 'string' ? event.key.toLowerCase() : '';
    if (key !== 'v') return;
    const target = event.target;
    const tag = target && typeof target.tagName === 'string' ? target.tagName.toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
    toggle();
    if (typeof event.preventDefault === 'function') event.preventDefault();
  }
  if (bindKeyboard && doc && typeof doc.addEventListener === 'function' && typeof window !== 'undefined') {
    try {
      window.addEventListener('keydown', onKeydown);
    } catch (_err) {
      /* 靜默 */
    }
  }

  /* ------------------------------------------------------- 對外 */

  const api = {
    element: group,
    scaleSelect,
    toggleBtn,
    hud,
    throttleEl,
    start,
    stop,
    toggle,
    download,
    setScale,
    getScale: () => scale,
    autoStart,
    getSnapshot,
    isRecording: () => Boolean(recorder && recorder.state === 'recording'),
    getFilename: () => (recorder && recorder.state === 'recording' ? recorder.filename : lastFilename),
    getBlob: () => lastBlob,
    getAudioWarning: () => audioWarning,
    /** ?record=1 時已完成的錄影結果（測試用；停止後才有）。 */
    getResults: () => finishedQueue.slice(),
    /** 等待下一次 finish（測試用）。 */
    whenFinished: (timeoutMs = 60000) =>
      new Promise((resolve) => {
        const started = now();
        const timer = setInterval(() => {
          if (finishedQueue.length) {
            clearInterval(timer);
            resolve(finishedQueue[finishedQueue.length - 1]);
            return;
          }
          if (now() - started > timeoutMs) {
            clearInterval(timer);
            resolve(null);
          }
        }, 100);
        if (timer && typeof timer.unref === 'function') timer.unref();
      }),
    /** 節流偵測：狀態與測試注入。 */
    throttle: {
      state: () => ({
        hidden: throttle.hidden,
        fps: throttle.fps,
        throttled: throttle.throttled,
        message: throttle.message,
        recording: Boolean(recorder && recorder.state === 'recording'),
        samples: throttle.samples.slice(),
      }),
      /** 測試用：覆寫偵測值（hidden 或 fps;傳 null 恢復）。 */
      simulate: (values) => {
        if (!values || typeof values !== 'object') {
          throttle.forced = null;
        } else {
          throttle.forced = {
            hidden: typeof values.hidden === 'boolean' ? values.hidden : null,
            fps: Number.isFinite(Number(values.fps)) ? Number(values.fps) : null,
            slow: values.slow === true,
          };
          if (Number.isFinite(Number(values.fps))) {
            throttle.samples = Array.from({ length: THROTTLE_SAMPLES }, () => Number(values.fps));
          }
        }
        return refreshThrottle();
      },
      refresh: refreshThrottle,
    },
    destroy() {
      destroyed = true;
      stopAutoPoll();
      if (autoTimer) {
        clearTimeout(autoTimer);
        autoTimer = 0;
      }
      stopUiTimer();
      stopSampling();
      if (doc && typeof doc.removeEventListener === 'function') {
        try {
          doc.removeEventListener('visibilitychange', onVisibility);
        } catch (_err) {
          /* 靜默 */
        }
      }
      if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
        try {
          window.removeEventListener('keydown', onKeydown);
        } catch (_err) {
          /* 靜默 */
        }
      }
      try {
        if (recorder) recorder.dispose();
      } catch (_err) {
        /* 靜默 */
      }
      recorder = null;
      try {
        if (group && group.parentNode) group.parentNode.removeChild(group);
        if (throttleEl && throttleEl.parentNode) throttleEl.parentNode.removeChild(throttleEl);
      } catch (_err) {
        /* 靜默 */
      }
    },
  };

  paint();
  refreshThrottle();
  return api;
}

export default mountRecorderUi;
