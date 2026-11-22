/**
 * tools/web/export-button.js — 「匯出可遊玩 HTML」按鈕（V2-09）
 *
 * 給編輯器/播放頁掛一個獨立按鈕：按下後 POST /api/export/game，拿回單檔 HTML
 * 並用 <a download> 下載。與頁面其他模組零耦合，只要給容器與取得目標的函式：
 *
 *   import { mountExportButton } from './tools/web/export-button.js';
 *   const exp = mountExportButton({
 *     container: document.getElementById('toolbar'),
 *     getTarget: () => ({ name: currentName, kind: currentKind }), // kind: 'attack'|'encounter'|null
 *     lang: 'zh',
 *   });
 *   // 語系變更時不用 destroy 重建：exp.setLang('en');
 *   // 不再需要時 exp.destroy();
 *
 * 設計：
 * - 所有 DOM 由本模組建立（頁面只給容器），CSS 只注入一次。
 * - 沒有 DOM 也能 import（Node 測試用）：純函式 buildExportRequest /
 *   filenameFromDisposition / errorMessageFromPayload 不碰 document。
 * - 下載流程用 fetch + Blob + 暫時 <a download>，不開新視窗。
 * - 伺服器回傳的錯誤（404 找不到、400 參數錯…）以按鈕旁的文字顯示。
 *
 * 注意：本模組不負責「這個名稱存不存在」；呼叫端用 getTarget() 決定要匯出什麼。
 * 本任務不把它掛到任何頁面（編輯器頁由其他任務處理）。
 */

/** 匯出端點（與 serve.py 的 POST /api/export/game 對應）。 */
export const EXPORT_ENDPOINT = '/api/export/game';

/** 按鈕文字（依語系）。 */
export const EXPORT_LABELS = Object.freeze({
  zh: { idle: '匯出可遊玩 HTML', busy: '匯出中…', done: '已下載' },
  en: { idle: 'Export playable HTML', busy: 'Exporting…', done: 'Downloaded' },
});

/**
 * 下載完成後的狀態文字：「已下載：<檔名>（<大小>）」（REALTEST-2 V10）。
 * 只寫「已下載」時，自動化（headless／CDP）與使用者都不知道實際檔名。
 */
export function doneStatusText(lang, filename, bytes) {
  const labels = EXPORT_LABELS[normalizeLang(lang)];
  if (!filename) return labels.done;
  const size = Number(bytes);
  const sizeText = !Number.isFinite(size) || size <= 0
    ? ''
    : size >= 1024 * 1024
      ? `${(size / (1024 * 1024)).toFixed(2)} MB`
      : `${Math.max(1, Math.round(size / 1024))} KB`;
  const sep = normalizeLang(lang) === 'en' ? ': ' : '：';
  return `${labels.done}${sep}${filename}${sizeText ? (normalizeLang(lang) === 'en' ? ` (${sizeText})` : `（${sizeText}）`) : ''}`;
}

/** 合法語言；其他值退回 zh。 */
export function normalizeLang(lang) {
  return lang === 'en' ? 'en' : 'zh';
}

/** 按鈕 tooltip（依語系；setLang 會即時更新）。 */
const BUTTON_TITLES = Object.freeze({
  zh: '下載單一可遊玩 HTML 檔',
  en: 'Download a single playable HTML file',
});

/** 不支援 fetch 時顯示的訊息（依語系）。 */
const FETCH_UNAVAILABLE = Object.freeze({
  zh: '此環境不支援 fetch',
  en: 'fetch unavailable',
});

/** 合法 kind；其他值（含 undefined）代表讓伺服器自動判斷。 */
export function normalizeKind(kind) {
  return kind === 'attack' || kind === 'encounter' ? kind : null;
}

/**
 * 建立 POST /api/export/game 的請求內容。
 * @param {{name?: string, kind?: string}|null} target
 * @param {'zh'|'en'} [lang]
 * @returns {{body: object, request: RequestInit}}（body 需再由呼叫端 JSON.stringify）
 */
export function buildExportRequest(target, lang = 'zh') {
  const name = target && typeof target.name === 'string' ? target.name.trim() : '';
  if (!name) {
    const error = new Error(normalizeLang(lang) === 'en' ? 'No work selected' : '尚未選擇作品');
    error.code = 'no_target';
    throw error;
  }
  const body = { name, lang: normalizeLang(lang) };
  const kind = normalizeKind(target && target.kind);
  if (kind) body.kind = kind;
  return {
    body,
    request: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  };
}

/**
 * 從 Content-Disposition 取得檔名（支援 filename* 與 filename）。
 * @param {string} disposition
 * @param {string} fallback
 */
export function filenameFromDisposition(disposition, fallback = 'game.html') {
  const header = typeof disposition === 'string' ? disposition : '';
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/^"|"$/g, ''));
    } catch (_err) {
      /* 壞掉的百分號編碼：改用一般 filename */
    }
  }
  const plain = /filename\s*=\s*"([^"]*)"/i.exec(header) || /filename\s*=\s*([^;]+)/i.exec(header);
  if (plain && plain[1].trim()) return plain[1].trim();
  return fallback;
}

/** 把伺服器錯誤 JSON 轉成一行可讀文字。 */
export function errorMessageFromPayload(payload, status) {
  if (payload && typeof payload === 'object') {
    const message = payload.error || payload.message;
    if (typeof message === 'string' && message.trim()) return message.trim();
  }
  if (typeof payload === 'string' && payload.trim()) return payload.trim();
  return `HTTP ${status}`;
}

let styleInjected = false;

const CSS = `
.drexport-group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.drexport-btn {
  font: inherit;
  font-size: 12px;
  color: #d9f0ff;
  background: #0f2330;
  border: 1px solid #2c5a75;
  border-radius: 3px;
  padding: 2px 8px;
  cursor: pointer;
}
.drexport-btn:hover:not(:disabled) { border-color: #4f9cc4; }
.drexport-btn:disabled { opacity: 0.55; cursor: default; }
.drexport-status {
  font-size: 12px;
  color: #9fc3d6;
  white-space: nowrap;
}
.drexport-status.is-error { color: #ff9a9a; white-space: normal; }
`;

function injectStyle(doc) {
  if (styleInjected || !doc || !doc.createElement) return;
  const style = doc.createElement('style');
  style.setAttribute('data-dr-export', '');
  style.textContent = CSS;
  (doc.head || doc.documentElement || doc.body).appendChild(style);
  styleInjected = true;
}

/** 用 <a download> 觸發下載（不開新視窗）。 */
export function downloadBlob(blob, filename, { documentRef, urlRef } = {}) {
  const doc = documentRef || (typeof document !== 'undefined' ? document : null);
  const urls = urlRef || (typeof URL !== 'undefined' ? URL : null);
  if (!doc || !urls) return null;
  const href = urls.createObjectURL(blob);
  const anchor = doc.createElement('a');
  anchor.href = href;
  anchor.download = filename;
  anchor.style.display = 'none';
  (doc.body || doc.documentElement).appendChild(anchor);
  anchor.click();
  if (anchor.parentNode) anchor.parentNode.removeChild(anchor);
  // 瀏覽器要讀完 blob 才會真正下載，稍後再釋放。
  if (typeof urls.revokeObjectURL === 'function') {
    if (typeof setTimeout === 'function') {
      const timer = setTimeout(() => urls.revokeObjectURL(href), 30000);
      // Node 測試環境別讓這個計時器拖住程序（瀏覽器回傳 number，沒有 unref）。
      if (timer && typeof timer.unref === 'function') timer.unref();
    } else {
      urls.revokeObjectURL(href);
    }
  }
  return href;
}

/**
 * 掛上匯出按鈕。
 * @param {{
 *   container: Element,
 *   getTarget: () => ({name?: string, kind?: string}|null),
 *   lang?: 'zh'|'en',
 *   endpoint?: string,
 *   fetchImpl?: typeof fetch,
 *   documentRef?: Document,
 *   urlRef?: typeof URL,
 * }} options
 */
export function mountExportButton(options = {}) {
  const container = options.container;
  if (!container) throw new Error('mountExportButton 需要 container');
  if (typeof options.getTarget !== 'function') throw new Error('mountExportButton 需要 getTarget()');
  let currentLang = normalizeLang(options.lang);
  let labels = EXPORT_LABELS[currentLang];
  const doc = options.documentRef || (typeof document !== 'undefined' ? document : null);
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const endpoint = options.endpoint || EXPORT_ENDPOINT;
  const getTarget = options.getTarget;

  injectStyle(doc);

  const group = doc.createElement('span');
  group.className = 'drexport-group';
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'drexport-btn';
  button.textContent = labels.idle;
  button.title = BUTTON_TITLES[currentLang];
  const status = doc.createElement('span');
  status.className = 'drexport-status';
  group.appendChild(button);
  group.appendChild(status);
  container.appendChild(group);

  let busy = false;
  let destroyed = false;
  /** 最近一次成功匯出：{ filename, bytes, blob }（自動化可用 lastExport() 取回內容，不必去找下載資料夾）。 */
  let last = null;

  function setStatus(text, isError = false) {
    status.textContent = text || '';
    status.classList.toggle('is-error', Boolean(isError));
  }

  async function exportNow() {
    if (busy || destroyed) return null;
    if (!fetchImpl) {
      setStatus(FETCH_UNAVAILABLE[currentLang], true);
      return null;
    }
    let request;
    try {
      request = buildExportRequest(getTarget(), currentLang);
    } catch (err) {
      setStatus(err && err.message ? err.message : String(err), true);
      return null;
    }
    busy = true;
    button.disabled = true;
    button.textContent = labels.busy;
    setStatus('');
    try {
      const response = await fetchImpl(endpoint, request.request);
      if (!response || !response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch (_err) {
          /* 非 JSON 錯誤內容 */
        }
        setStatus(errorMessageFromPayload(payload, response ? response.status : 0), true);
        return null;
      }
      const blob = await response.blob();
      const fallbackName = `${request.body.name}.html`;
      const filename = filenameFromDisposition(
        response.headers && typeof response.headers.get === 'function'
          ? response.headers.get('Content-Disposition')
          : '',
        fallbackName,
      );
      downloadBlob(blob, filename, { documentRef: doc, urlRef: options.urlRef });
      const bytes = blob && typeof blob.size === 'number' ? blob.size : 0;
      last = { filename, bytes, blob };
      setStatus(doneStatusText(currentLang, filename, bytes));
      if (group.dataset) {
        group.dataset.exportFilename = filename;
        group.dataset.exportBytes = String(bytes);
      }
      // headless／自動化下檔案會落在瀏覽器自己的下載資料夾：至少把實際檔名與大小印出來，
      // 並在 window.__drLastExport 留一份（含 Blob），CDP 可直接讀回內容。
      if (typeof console !== 'undefined' && typeof console.info === 'function') {
        console.info(`[export] downloaded ${filename} (${bytes} bytes)`);
      }
      const win = doc && doc.defaultView ? doc.defaultView : typeof window !== 'undefined' ? window : null;
      if (win) {
        try {
          win.__drLastExport = last;
          if (typeof win.CustomEvent === 'function' && typeof group.dispatchEvent === 'function') {
            group.dispatchEvent(new win.CustomEvent('drexport:downloaded', { bubbles: true, detail: { filename, bytes } }));
          }
        } catch (_err) {
          /* 忽略 */
        }
      }
      return { blob, filename, bytes };
    } catch (err) {
      setStatus(err && err.message ? err.message : String(err), true);
      return null;
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = labels.idle;
    }
  }

  const onClick = () => {
    void exportNow();
  };
  button.addEventListener('click', onClick);

  /**
   * 切換語系（V2-FIX1）：即時更新按鈕文字與 tooltip，不必 destroy 後重建整顆按鈕。
   * @param {'zh'|'en'} nextLang
   * @returns {boolean} 語系是否真的改變
   */
  function setLang(nextLang) {
    const normalized = normalizeLang(nextLang);
    const prevDone = last ? doneStatusText(currentLang, last.filename, last.bytes) : null;
    const prevLabels = labels;
    const changed = normalized !== currentLang;
    currentLang = normalized;
    labels = EXPORT_LABELS[currentLang];
    button.textContent = busy ? labels.busy : labels.idle;
    button.title = BUTTON_TITLES[currentLang];
    // 狀態文字若還停在「已下載」，跟著換；錯誤訊息保持原樣（是伺服器/環境給的）。
    if (changed && status.textContent === prevLabels.done) status.textContent = labels.done;
    else if (changed && last && status.textContent === prevDone) status.textContent = doneStatusText(currentLang, last.filename, last.bytes);
    return changed;
  }

  return {
    button,
    group,
    status,
    exportNow,
    setLang,
    isBusy: () => busy,
    lastExport: () => last,
    destroy() {
      destroyed = true;
      button.removeEventListener('click', onClick);
      if (group.parentNode) group.parentNode.removeChild(group);
    },
  };
}
