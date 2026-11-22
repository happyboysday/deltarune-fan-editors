/**
 * editor/encounter/fileops.js — 遭遇編輯器檔案操作 + 工具列（ED1 擁有）
 *
 * 內容：
 *   - 通用對話框（openModal / confirmDialog / promptDialog / pickDialog）、
 *     下拉選單（openMenu）、toast
 *   - 伺服器 API：`GET /api/encounters`（清單）、`GET|PUT /api/encounters/<name>.json`
 *     （W2 的 serve.py 提供；路徑與 attacks 相同形式）
 *   - 新建（最小遭遇範本）、開檔、儲存、另存、匯入、匯出、開啟 samples/encounters/
 *   - 自動暫存（由 main.js 讀寫；本檔提供 ensureAutosave / flush 的呼叫點）
 *   - 工具列按鈕、預覽傳輸列、鍵盤快捷鍵（Ctrl+S / Ctrl+Z / Ctrl+Y / 空白鍵 /
 *     Home / ←→ / Esc）
 *
 * 對外：
 *   mountToolbar(ctx) → { refresh, updateDocumentTitle, destroy }
 *   createDefaultEncounter() 由 preview.js 提供（轉出）
 */

import { t, LOCALES, getLocale, setLocale, applyDom, onLocaleChange } from '../i18n.js';
import '../locales/encounter-app.js';
import '../locales/live-sync.js';
import { ENCOUNTER_AUTOSAVE_KEY } from '../store.js';
import { createDefaultEncounter, loadActorPresets } from './preview.js';
import { createSyncClient, normalizeEtag } from '../live-sync.js';

const SERVER_LIST = '/api/encounters';
const SAMPLE_INDEX = 'samples/encounters/index.json';
const SAMPLE_DIR = 'samples/encounters/';
const ENCOUNTER_FORMAT = 'dr-battle-encounter/1';

/** samples/encounters/ 尚不存在時的後備清單（W2 完成後會以 index.json 為準） */
const SAMPLE_FALLBACK = [];

/* ------------------------------------------------------------------ 狀態 */

const els = {};
const state = {
  store: null,
  preview: null,
  mount: null,
  dirty: false,
  lastSavedName: null,
  serverAvailable: null,
  busy: false,
  modalOpen: false,
  menuOpen: false,
  toastSeq: 0,
  notify: null,
  tryActive: false,
  /** B19：?file= / ?sample= 的自動載入 promise（測試 / 除錯可等待） */
  queryLoad: null,
};

const store = () => state.store;
const preview = () => state.preview;
let syncClient = null;

/* ------------------------------------------------------------------ 小工具 */

const q = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function isEditableTarget(target) {
  if (!target || typeof target !== 'object') return false;
  const tag = String(target.tagName || '').toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * 正規化遭遇檔名（B2）。
 *
 * 與攻擊編輯器 `editor/fileops.js` 的 `normalizeFileName` 規則一致：
 *   1. 去頭尾空白
 *   2. `\` → `/`（Windows 路徑）
 *   3. 只取最後一段檔名（`split('/').pop()`）——避免 `encounters/rt-a.json` 被黏成
 *      `encountersrt-a`、把目錄前綴直接併進檔名
 *   4. 去掉 `.json` 後綴
 *   5. 非法字元（含空白）換成 `_`，再去掉頭尾的 `_`
 *
 * serve.py 的白名單是 `[A-Za-z0-9_\-\u4e00-\u9fa5]+`，所以回傳值不含 `.json`，
 * 由呼叫端自行接上（`serverSave` / `serverLoad` 都是這樣用）。
 *
 * @param {string} name 使用者輸入（可含路徑與 .json）
 * @returns {string} 正規化後的檔名（不含 .json）；無法正規化時回空字串
 */
export function normalizeFileName(name) {
  let n = String(name == null ? '' : name).trim();
  if (!n) return '';
  n = n.replace(/\\/g, '/');
  n = n.split('/').pop() || '';
  n = n.replace(/\.json$/i, '');
  n = n.replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]+/g, '_');
  n = n.replace(/^_+|_+$/g, '');
  return n;
}

/** 使用者輸入 → 最終會落地的檔名（含 .json）；給對話框即時預覽用（B2）。 */
export function willSaveAsName(name) {
  const clean = normalizeFileName(name);
  return clean ? `${clean}.json` : '';
}

function stripJson(name) {
  return String(name || '').replace(/\.json$/i, '');
}

function slugify(text) {
  return String(text || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]/g, '');
}

function pickDefaultName(metaName) {
  const fromMeta = normalizeFileName(metaName);
  if (fromMeta) return fromMeta;
  return 'encounter';
}

function setStatusMessage(text, kind = '') {
  if (typeof state.notify === 'function') {
    try {
      state.notify(text, kind);
      return;
    } catch (_err) {
      /* 忽略 */
    }
  }
  const el = q('enc-toolbar-msg');
  if (!el) return;
  el.textContent = String(text == null ? '' : text);
  el.className = `tb-msg${kind ? ` is-${kind}` : ''}`;
}

export function toast(message, kind = '') {
  const root = q('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast${kind ? ` is-${kind}` : ''}`;
  el.textContent = String(message == null ? '' : message);
  root.appendChild(el);
  state.toastSeq += 1;
  setTimeout(() => {
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 220);
  }, kind === 'error' ? 4200 : 2200);
  while (root.children.length > 4) root.firstElementChild.remove();
}

/* ================================================================== 對話框 */

function closeModal() {
  const root = q('modal-root');
  if (!root) return;
  root.hidden = true;
  root.innerHTML = '';
  state.modalOpen = false;
  if (typeof document !== 'undefined' && document.activeElement && document.activeElement.blur) {
    document.activeElement.blur();
  }
}

/** 以程式方式「按下」按鈕（Enter 快捷鍵用；不支援 click() 的環境退回 dispatchEvent）。 */
function activateButton(btn) {
  if (!btn) return false;
  if (typeof btn.click === 'function') {
    btn.click();
    return true;
  }
  if (typeof btn.dispatchEvent === 'function' && typeof Event === 'function') {
    btn.dispatchEvent(new Event('click', { bubbles: true }));
    return true;
  }
  return false;
}

/**
 * 通用對話框。
 * @param {{title:string, body:string|HTMLElement, buttons?:{label:string,kind?:string,value?:any,onClick?:Function,disabled?:boolean}[], wide?:boolean, onClose?:Function}} cfg
 * @returns {Promise<any>}
 */
export function openModal(cfg) {
  const root = q('modal-root');
  if (!root) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const config = cfg || {};
    root.innerHTML = '';
    const modal = document.createElement('div');
    modal.className = `modal${config.wide ? ' is-wide' : ''}`;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const head = document.createElement('div');
    head.className = 'modal-head';
    const title = document.createElement('span');
    title.className = 'modal-title';
    title.textContent = config.title || '';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'modal-close';
    closeBtn.textContent = '✕';
    closeBtn.title = t('encfileops.closeEsc');
    head.append(title, closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body';
    if (config.body instanceof Node) body.appendChild(config.body);
    else body.innerHTML = config.body || '';

    modal.append(head, body);

    const finish = (value) => {
      const onClose = config.onClose;
      closeModal();
      if (typeof onClose === 'function') {
        try {
          onClose(value);
        } catch (err) {
          console.warn('[encfileops] onClose 錯誤：', err);
        }
      }
      resolve(value);
    };

    const buttons = Array.isArray(config.buttons) ? config.buttons : [];
    let primaryBtn = null;
    if (buttons.length) {
      const foot = document.createElement('div');
      foot.className = 'modal-foot';
      for (const b of buttons) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn${b.kind ? ` btn-${b.kind}` : ''}`;
        btn.textContent = b.label;
        btn.disabled = Boolean(b.disabled);
        btn.addEventListener('click', () => {
          if (typeof b.onClick === 'function') {
            const r = b.onClick(modal);
            if (r === false) return;
          }
          finish(b.value);
        });
        if (b.kind === 'primary' || b.kind === 'danger') {
          if (!primaryBtn) primaryBtn = btn;
          else if (b.kind === 'primary') primaryBtn = btn;
        }
        foot.appendChild(btn);
      }
      modal.appendChild(foot);
    }

    /**
     * Enter ＝確定（單行輸入框）。
     * 只處理 INPUT；textarea（多行）、select、checkbox 等一律不攔，
     * 免得在需要換行的欄位上誤送出。
     */
    modal.addEventListener('keydown', (ev) => {
      if (!ev || ev.key !== 'Enter' || ev.shiftKey || ev.ctrlKey || ev.metaKey || ev.altKey) return;
      const target = ev.target || (typeof document !== 'undefined' ? document.activeElement : null);
      const tag = String((target && target.tagName) || '').toUpperCase();
      if (tag !== 'INPUT') return;
      const type = String((target && target.type) || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio' || type === 'button' || type === 'submit' || type === 'file') return;
      if (!primaryBtn || primaryBtn.disabled) return;
      ev.preventDefault();
      activateButton(primaryBtn);
    });

    closeBtn.addEventListener('click', () => finish(undefined));
    root.appendChild(modal);
    root.hidden = false;
    state.modalOpen = true;
    root.onclick = (ev) => {
      if (ev.target === root) finish(undefined);
    };

    setTimeout(() => {
      const input = modal.querySelector('input[type="text"], input[type="number"], textarea');
      if (input) {
        input.focus();
        if (input.select) input.select();
        return;
      }
      const primary = modal.querySelector('.btn-primary');
      if (primary) primary.focus();
    }, 0);
  });
}

/** 確認對話框；回傳 true/false */
export function confirmDialog(
  message,
  {
    title = t('encfileops.confirm.title'),
    okLabel = t('encfileops.confirm.ok'),
    cancelLabel = t('encfileops.confirm.cancel'),
    danger = false,
    detail = '',
  } = {},
) {
  const body =
    `<p>${escapeHtml(message)}</p>` + (detail ? `<p style="color:#8a8a99;font-size:11.5px">${escapeHtml(detail)}</p>` : '');
  return openModal({
    title,
    body,
    buttons: [
      { label: cancelLabel, value: false },
      { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  }).then((v) => v === true);
}

/**
 * 文字輸入對話框；回傳字串或 null
 *
 * `normalize`（B2）：傳入「輸入 → 實際落地檔名」的函式時，只要正規化結果與輸入不同，
 * 就在對話框裡即時顯示「將存成：xxx.json」，避免使用者以為路徑前綴會被保留。
 */
export function promptDialog(
  message,
  {
    title = t('encfileops.prompt.title'),
    value = '',
    okLabel = t('encfileops.prompt.ok'),
    placeholder = '',
    hint = '',
    normalize = null,
  } = {},
) {
  const wrap = document.createElement('div');
  const p = document.createElement('p');
  p.textContent = message;
  const field = document.createElement('div');
  field.className = 'field';
  const input = document.createElement('input');
  input.type = 'text';
  // 也寫進屬性：querySelector('input[type="text"]') 在極簡 DOM 替身裡才找得到
  if (typeof input.setAttribute === 'function') input.setAttribute('type', 'text');
  input.value = value;
  input.placeholder = placeholder;
  field.appendChild(input);
  if (hint) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = hint;
    field.appendChild(h);
  }
  let previewEl = null;
  if (typeof normalize === 'function') {
    previewEl = document.createElement('div');
    previewEl.className = 'hint enc-save-preview';
    previewEl.hidden = true;
    field.appendChild(previewEl);
    const sync = () => {
      const raw = input.value;
      let resolved = '';
      try {
        resolved = String(normalize(raw) || '');
      } catch (err) {
        resolved = '';
      }
      const changed = resolved !== '' && resolved !== String(raw).trim();
      previewEl.hidden = !changed;
      previewEl.textContent = changed ? t('encfileops.save.willSave', { name: resolved }) : '';
    };
    input.addEventListener('input', sync);
    input.addEventListener('change', sync);
    setTimeout(sync, 0);
  }
  wrap.append(p, field);
  return openModal({
    title,
    body: wrap,
    buttons: [
      { label: t('encfileops.prompt.cancel'), value: null },
      { label: okLabel, value: '__ok__', kind: 'primary' },
    ],
  }).then((v) => (v === '__ok__' ? input.value : null));
}

/** 清單選擇對話框 */
export function pickDialog(title, items, { emptyText = t('encfileops.noItems'), wide = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    const list = document.createElement('div');
    list.className = 'pick-list';
    let settled = false;
    const choose = (value) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value ?? null);
    };
    if (!items || items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pick-empty';
      empty.textContent = emptyText;
      list.appendChild(empty);
    } else {
      for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pick-item';
        const label = document.createElement('span');
        label.textContent = item.label;
        btn.appendChild(label);
        if (item.sub) {
          const sub = document.createElement('span');
          sub.className = 'pick-sub';
          sub.textContent = item.sub;
          btn.appendChild(sub);
        }
        btn.addEventListener('click', () => {
          if (item.onClick) {
            item.onClick();
            choose(null);
            return;
          }
          choose(item.value);
        });
        list.appendChild(btn);
      }
    }
    wrap.appendChild(list);
    openModal({ title, body: wrap, wide, buttons: [{ label: t('encfileops.confirm.cancel'), value: null }] }).then((v) => {
      if (!settled) {
        settled = true;
        resolve(v ?? null);
      }
    });
  });
}

/* ================================================================== 下拉選單 */

export function closeMenu() {
  const root = q('menu-root');
  if (!root) return;
  root.hidden = true;
  root.innerHTML = '';
  state.menuOpen = false;
}

/**
 * 在 anchor 元素下方顯示下拉選單。
 * @param {HTMLElement} anchor
 * @param {{label?:string, sub?:string, onClick?:Function, disabled?:boolean, sep?:boolean, note?:string}[]} items
 */
export function openMenu(anchor, items) {
  const root = q('menu-root');
  if (!root || !anchor) return;
  closeMenu();
  root.innerHTML = '';
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      root.appendChild(sep);
      continue;
    }
    if (item.note) {
      const note = document.createElement('div');
      note.className = 'menu-note';
      note.textContent = item.note;
      root.appendChild(note);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu-item${item.disabled ? ' is-disabled' : ''}`;
    btn.disabled = Boolean(item.disabled);
    const label = document.createElement('span');
    label.textContent = item.label || '';
    btn.appendChild(label);
    if (item.sub) {
      const sub = document.createElement('span');
      sub.className = 'mi-sub';
      sub.textContent = item.sub;
      // B17：描述單行截斷，完整內容放在 title
      sub.title = item.title || item.sub;
      btn.appendChild(sub);
    } else if (item.title) {
      btn.title = item.title;
    }
    btn.addEventListener('click', () => {
      closeMenu();
      if (typeof item.onClick === 'function') item.onClick();
    });
    root.appendChild(btn);
  }
  root.hidden = false;
  state.menuOpen = true;
  const rect = anchor.getBoundingClientRect();
  const mw = root.offsetWidth;
  const mh = root.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 4;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
  if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 4);
  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  const closer = (ev) => {
    if (root.contains(ev.target) || anchor.contains(ev.target)) return;
    document.removeEventListener('pointerdown', closer, true);
    anchor.setAttribute('aria-expanded', 'false');
    closeMenu();
  };
  setTimeout(() => document.addEventListener('pointerdown', closer, true), 0);
}

/* ================================================================ 伺服器 API */

function apiUnavailableMessage(reason) {
  return t('encfileops.api.unreachable', { reason });
}

/** GET /api/encounters → {ok, files:[{file, metaName, turns, enemies, size, modified}]} */
async function serverList() {
  try {
    const res = await fetch(SERVER_LIST, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    let raw = [];
    if (Array.isArray(data)) raw = data;
    else if (data && Array.isArray(data.encounters)) raw = data.encounters;
    else if (data && Array.isArray(data.items)) raw = data.items;
    else if (data && Array.isArray(data.files)) raw = data.files;

    const items = [];
    const seen = new Set();
    for (const entry of raw) {
      const rawName = typeof entry === 'string' ? entry : entry && (entry.name || entry.file);
      if (typeof rawName !== 'string' || !rawName) continue;
      const fileName = `${normalizeFileName(rawName)}.json`;
      if (fileName === '.json' || seen.has(fileName)) continue;
      seen.add(fileName);
      items.push({
        file: fileName,
        metaName: entry && typeof entry === 'object' ? entry.metaName || '' : '',
        turns: entry && typeof entry === 'object' && Number.isFinite(Number(entry.turns)) ? Number(entry.turns) : null,
        enemies: entry && typeof entry === 'object' && Number.isFinite(Number(entry.enemies)) ? Number(entry.enemies) : null,
        modified: entry && typeof entry === 'object' && Number.isFinite(Number(entry.modified)) ? Number(entry.modified) : null,
        size: entry && typeof entry === 'object' && Number.isFinite(Number(entry.size)) ? Number(entry.size) : null,
      });
    }
    state.serverAvailable = true;
    return { ok: true, files: items };
  } catch (err) {
    state.serverAvailable = false;
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function serverLoad(fileName) {
  const name = normalizeFileName(fileName);
  const url = `${SERVER_LIST}/${encodeURIComponent(name)}.json`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(t('encfileops.api.httpError', { status: res.status, name }));
  const etag = res.headers ? res.headers.get('ETag') || res.headers.get('X-Etag') || '' : '';
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(t('encfileops.api.badJson', { name, msg: err.message }));
  }
  return { data, name, etag: normalizeEtag(etag) };
}

async function serverSave(fileName, doc) {
  const name = normalizeFileName(fileName);
  // 有即時同步客戶端時走 ETag + If-Match（SPEC-AGENT §5）
  if (syncClient) {
    const result = await syncClient.save(`${name}.json`, doc);
    if (result && result.ok) return name;
    if (result && result.conflict) {
      const err = new Error(t('sync.message.conflict'));
      err.conflict = true;
      err.etag = result.etag || '';
      err.current = result.current || null;
      err.name = name;
      throw err;
    }
    throw new Error((result && result.error) || t('encfileops.api.httpError', { status: 0, name }));
  }
  const url = `${SERVER_LIST}/${encodeURIComponent(name)}.json`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(doc, null, 2),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const body = await res.json();
      detail = body && (body.error || body.message) ? `：${body.error || body.message}` : '';
    } catch (_err) {
      /* 忽略 */
    }
    throw new Error(`${t('encfileops.api.httpError', { status: res.status, name })}${detail}`);
  }
  return name;
}

/* ==================================================== B19：網址參數載入 */

/**
 * 解析 `?file=` / `?sample=`（B19）。
 *
 * 兩個參數都容忍：
 *   - 含目錄前綴（`encounters/rudinn.json`、`samples/encounters/rudinn.json`）
 *   - 含或不含 `.json`
 *   - 前後空白、反斜線路徑
 *
 * 回傳值一律是「不含 .json 的正規化檔名」，載入時由呼叫端接上目錄與副檔名。
 * @param {string} search location.search（可含開頭的 `?`）
 * @returns {{file: string|null, sample: string|null}}
 */
export function parseLoadQuery(search) {
  let params = null;
  try {
    params = new URLSearchParams(String(search == null ? '' : search));
  } catch (_err) {
    return { file: null, sample: null };
  }
  const clean = (raw) => {
    let name = String(raw == null ? '' : raw).trim();
    if (!name) return '';
    name = name.replace(/\\/g, '/');
    name = name.split('/').pop() || '';
    name = name.replace(/\.json$/i, '');
    name = name.replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]+/g, '_');
    return name.replace(/^_+|_+$/g, '');
  };
  return { file: clean(params.get('file')) || null, sample: clean(params.get('sample')) || null };
}

/**
 * 產生同步後的查詢字串（純函式，測試用）。
 * patch 的值：undefined = 不動、null/'' = 移除、其他 = 設定。
 * @param {string} search 目前查詢字串
 * @param {{file?: string|null, sample?: string|null}} patch
 * @returns {string} 以 `?` 開頭（空字串 = 沒有任何參數）
 */
export function buildLoadQueryString(search, patch = {}) {
  let params = null;
  try {
    params = new URLSearchParams(String(search == null ? '' : search));
  } catch (_err) {
    params = new URLSearchParams();
  }
  for (const key of ['file', 'sample']) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === undefined || value === '') params.delete(key);
    else params.set(key, String(value));
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}

/** 把 file / sample 同步到網址列（history.replaceState；不新增歷史紀錄） */
function syncLoadQuery(patch) {
  try {
    if (typeof history === 'undefined' || typeof history.replaceState !== 'function') return false;
    if (typeof location === 'undefined') return false;
    const qs = buildLoadQueryString(location.search, patch);
    history.replaceState(history.state, '', `${location.pathname}${qs}${location.hash || ''}`);
    return true;
  } catch (_err) {
    return false;
  }
}

/** ?sample= 的實際網址 */
export function sampleEncounterUrl(name) {
  return `${SAMPLE_DIR}${encodeURIComponent(name)}.json`;
}

/** ?file= 的候選網址：伺服器 API → encounters/ 靜態檔 → samples/（方便 cross-link） */
export function fileCandidateUrls(name) {
  return [
    { kind: 'file', url: `${SERVER_LIST}/${encodeURIComponent(name)}.json` },
    { kind: 'file', url: `encounters/${encodeURIComponent(name)}.json` },
    { kind: 'sample', url: sampleEncounterUrl(name) },
  ];
}

/**
 * 依解析結果抓遭遇檔（B19）。
 * @param {{file: string|null, sample: string|null}} parsed parseLoadQuery 的結果
 * @param {{fetchImpl?: Function}} [opts] fetchImpl 可注入（測試用）
 * @returns {Promise<{ok:boolean, source?:string, name?:string, url?:string, doc?:object, error?:string, tried:string[]}>}
 */
export async function resolveLoadQuery(parsed, opts = {}) {
  const fileFetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : typeof fetch === 'function' ? fetch : null;
  const tried = [];
  const q = parsed && typeof parsed === 'object' ? parsed : { file: null, sample: null };
  if (!q.file && !q.sample) return { ok: false, skipped: true, error: '', tried };
  if (!fileFetch) return { ok: false, name: q.file || q.sample, error: 'fetch 不可用', tried };

  const candidates = q.sample ? [{ kind: 'sample', url: sampleEncounterUrl(q.sample) }] : fileCandidateUrls(q.file);
  for (const candidate of candidates) {
    try {
      const res = await fileFetch(candidate.url, { headers: { Accept: 'application/json' } });
      if (!res || !res.ok) {
        tried.push(`${candidate.url} → HTTP ${res && res.status !== undefined ? res.status : '?'}`);
        continue;
      }
      const doc = await res.json();
      return {
        ok: true,
        source: candidate.kind,
        name: q.sample || q.file,
        url: candidate.url,
        doc,
        etag: normalizeEtag(res.headers?.get('ETag')),
        tried,
      };
    } catch (err) {
      tried.push(`${candidate.url} → ${err && err.message ? err.message : err}`);
    }
  }
  return {
    ok: false,
    name: q.file || q.sample,
    error: tried[tried.length - 1] || '',
    tried,
  };
}

/**
 * B19：套用 `?file=` / `?sample=`（開頁自動載入）。
 * 成功後把真正載入的來源同步回網址列；找不到檔案 → toast 錯誤。
 * @param {string} search location.search
 * @param {{fetchImpl?: Function}} [opts]
 */
export async function loadFromQuery(search, opts = {}) {
  const parsed = parseLoadQuery(search);
  if (!parsed.file && !parsed.sample) return { ok: true, skipped: true };
  const wanted = parsed.sample || parsed.file;
  setStatusMessage(t('encfileops.load.loading', { name: wanted }));
  const result = await resolveLoadQuery(parsed, opts);
  if (!result.ok) {
    const msg = t('encfileops.load.failed', {
      name: result.name || wanted,
      msg: result.error || 'Not found',
    });
    setStatusMessage(msg, 'error');
    toast(msg, 'error');
    return result;
  }
  const format = result.doc && result.doc.format;
  if (format !== undefined && format !== ENCOUNTER_FORMAT) {
    const msg = t('encfileops.load.badFormat', { name: result.name || wanted, format: String(format) });
    setStatusMessage(msg, 'error');
    toast(msg, 'error');
    return { ok: false, name: result.name || wanted, error: msg, tried: result.tried };
  }
  const isSample = result.source === 'sample';
  const label = isSample
    ? t('encfileops.samples.opened', { name: stripJson(result.name || '') })
    : t('encfileops.open.opened', { name: stripJson(result.name || '') });
  afterOpen(result.doc, label, isSample ? null : `${normalizeFileName(result.name || '')}.json`, result.etag);
  syncLoadQuery(isSample ? { sample: `${result.name}.json`, file: null } : { file: `${result.name}.json`, sample: null });
  setStatusMessage(label, 'ok');
  toast(label, 'ok');
  return result;
}

/**
 * B19：開頁時讀 `?file=` / `?sample=`。
 *
 * 刻意的行為選擇：**不問「要不要捨棄目前變更」**。網址參數是使用者明確要求的
 * 目標文件，若先跳確認框會讓 `encounter.html?sample=rudinn` 這種分享連結
 * 直接卡在 modal（自動化 / 截圖也會卡住）。沒有參數時完全不做任何事。
 */
function startQueryLoad() {
  if (typeof location === 'undefined') return Promise.resolve({ ok: true, skipped: true });
  const parsed = parseLoadQuery(location.search);
  if (!parsed.file && !parsed.sample) return Promise.resolve({ ok: true, skipped: true });
  return loadFromQuery(location.search).catch((err) => {
    const msg = t('encfileops.load.failed', {
      name: parsed.sample || parsed.file || '',
      msg: err && err.message ? err.message : String(err),
    });
    setStatusMessage(msg, 'error');
    toast(msg, 'error');
    return { ok: false, error: msg };
  });
}

/* ================================================================ 開檔共用流程 */

async function confirmDiscard(actionLabel) {
  if (state.busy) return false;
  const s = store();
  if (!s || !s.isDirty()) return true;
  return confirmDialog(t('encfileops.discard.busyMessage', { action: actionLabel }), {
    title: t('encfileops.discard.title'),
    okLabel: t('encfileops.discard.ok'),
    cancelLabel: t('encfileops.discard.cancel'),
    danger: true,
  });
}

function afterOpen(doc, label, fileName, etag = '') {
  const s = store();
  if (!s) return;
  s.replace(doc, label);
  s.fileName = fileName || null;
  state.lastSavedName = fileName || null;
  // 開檔時記住伺服器版本；之後存檔帶 If-Match，被別人改過就會 409
  if (syncClient) syncClient.setEtag(etag || '');
  // B19：開檔成功 → 網址列同步 ?file=（範例與匯入沒有檔名，改清除參數）
  syncLoadQuery(fileName ? { file: fileName, sample: null } : { file: null, sample: null });
  const p = preview();
  if (p && typeof p.restart === 'function') {
    try {
      p.restart();
    } catch (_err) {
      /* 忽略 */
    }
  }
  refreshToolbarState();
  updateDocumentTitle();
}

/* ================================================================ 檔案操作 */

/** 新建（最小遭遇範本） */
export async function newEncounter() {
  if (!(await confirmDiscard(t('encfileops.new.label')))) return false;
  // A3 的 actor-presets.json 有三人隊伍 layouts，優先用它組範本；失敗則退回最小範本
  const presets = await loadActorPresets();
  const doc = createDefaultEncounter(presets);
  afterOpen(doc, t('encfileops.new.title'), null);
  setStatusMessage(t('encfileops.new.done'), 'ok');
  toast(t('encfileops.new.done'), 'ok');
  return true;
}

/** 開啟伺服器上的遭遇檔（清單對話框） */
export async function openFromServer() {
  if (!(await confirmDiscard(t('encfileops.open.title')))) return false;
  setStatusMessage(t('encfileops.open.loading'));
  const res = await serverList();
  if (!res.ok) {
    setStatusMessage(t('encfileops.open.failedTitle'), 'error');
    await openModal({
      title: t('encfileops.open.noServer'),
      body: `<p>${escapeHtml(apiUnavailableMessage(res.error))}</p>`,
      buttons: [{ label: t('encfileops.ack'), value: true, kind: 'primary' }],
    });
    return false;
  }
  if (res.files.length === 0) {
    await openModal({
      title: t('encfileops.open.emptyTitle'),
      body: t('encfileops.open.emptyBody'),
      buttons: [{ label: t('encfileops.ack'), value: true, kind: 'primary' }],
    });
    return false;
  }
  const items = res.files.map((f) => {
    const label = f.metaName || stripJson(f.file);
    const bits = [];
    if (f.metaName) bits.push(f.file);
    if (f.turns !== null) bits.push(t('encfileops.doc.turns', { n: f.turns }));
    if (f.modified) {
      try {
        bits.push(new Date(f.modified).toLocaleString(getLocale() === 'en' ? 'en-US' : 'zh-TW', { hour12: false }));
      } catch (_err) {
        /* 忽略 */
      }
    }
    return { label, sub: bits.length ? bits.join('・') : f.file, value: f.file };
  });
  const picked = await pickDialog(t('encfileops.open.dialogTitle'), items, { wide: true });
  if (!picked) return false;
  setStatusMessage(t('encfileops.open.opening', { name: picked }));
  try {
    const { data, name, etag } = await serverLoad(picked);
    const formatOK = !data || data.format === undefined || data.format === ENCOUNTER_FORMAT;
    if (!formatOK) {
      toast(t('encfileops.import.notEncounter', { format: data.format }), 'error');
      return false;
    }
    afterOpen(data, t('encfileops.open.opened', { name }), name, etag);
    setStatusMessage(t('encfileops.open.opened', { name }), 'ok');
    toast(t('encfileops.open.opened', { name }), 'ok');
    return true;
  } catch (err) {
    setStatusMessage(t('encfileops.open.failedTitle2'), 'error');
    toast(t('encfileops.open.failed', { msg: err.message || err }), 'error');
    return false;
  }
}

/** 儲存（有檔名直接存，否則另存） */
export async function saveEncounter() {
  const s = store();
  if (!s) return false;
  const fileName = s.fileName || state.lastSavedName;
  if (!fileName) return saveEncounterAs();
  return doSave(fileName);
}

/** 另存新檔 */
export async function saveEncounterAs() {
  const s = store();
  if (!s) return false;
  const doc = s.doc || {};
  const suggested = pickDefaultName(doc.meta ? doc.meta.name : '');
  const name = await promptDialog(t('encfileops.save.dialogTitle'), {
    title: t('encfileops.save.asTitle'),
    value: suggested,
    placeholder: 'encounter',
    hint: t('encfileops.save.hint'),
    // B2：含路徑或空白時，即時顯示實際會落地的檔名
    normalize: willSaveAsName,
  });
  if (name === null) return false;
  const clean = normalizeFileName(name);
  if (!clean) {
    toast(t('encfileops.save.emptyName'), 'error');
    return false;
  }
  return doSave(clean);
}

async function doSave(fileName, { retry = false } = {}) {
  const s = store();
  if (!s || state.busy) return false;
  state.busy = true;
  refreshToolbarState();
  setStatusMessage(t('encfileops.save.title'));
  try {
    const snapshot = s.doc;
    const saved = await serverSave(fileName, snapshot);
    const clean = s.markSaved(saved, snapshot);
    state.lastSavedName = saved;
    // B19：儲存／另存成功後網址列同步 ?file=（重新整理或分享網址都會開同一份）
    syncLoadQuery({ file: saved ? `${saved}.json` : null, sample: null });
    updateDocumentTitle();
    const message = clean ? t('encfileops.save.done', { name: saved }) : t('fileops.save.pendingEdits');
    setStatusMessage(message, clean ? 'ok' : 'warn');
    toast(message, clean ? 'ok' : 'warn');
    return true;
  } catch (err) {
    // 409：別人改過這個檔案 → 合併提示（保留我的 / 採用對方 / 檢視差異）
    if (err && err.conflict && syncClient && !retry) {
      setStatusMessage(t('sync.message.conflict'), 'warn');
      const choice = await syncClient.resolveConflict({
        name: `${normalizeFileName(fileName)}.json`,
        current: err.current,
        etag: err.etag,
      });
      if (choice === 'theirs') {
        const clean = normalizeFileName(fileName);
        s.markSaved(clean);
        state.lastSavedName = clean;
        updateDocumentTitle();
        setStatusMessage(t('sync.merge.doneTheirs'), 'ok');
        toast(t('sync.merge.doneTheirs'), 'ok');
        return true;
      }
      if (choice === 'mine') {
        state.busy = false;
        refreshToolbarState();
        return doSave(fileName, { retry: true });
      }
      setStatusMessage(t('encfileops.save.failedTitle'), 'warn');
      return false;
    }
    setStatusMessage(t('encfileops.save.failedTitle'), 'error');
    const msg = err && err.message ? err.message : String(err);
    await openModal({
      title: t('encfileops.save.failedTitle'),
      body:
        `<p>${escapeHtml(t('encfileops.save.failed', { msg }))}</p>` +
        `<p style="color:#8a8a99">${escapeHtml(msg)}</p>` +
        t('encfileops.save.fallbackHint'),
      buttons: [
        { label: t('encfileops.confirm.cancel'), value: null },
        { label: t('encfileops.save.exportInstead'), value: 'export', kind: 'primary' },
      ],
    }).then((v) => {
      if (v === 'export') exportEncounter();
    });
    return false;
  } finally {
    state.busy = false;
    refreshToolbarState();
  }
}

/** 匯入本機 JSON */
export async function importEncounter() {
  if (!(await confirmDiscard(t('encfileops.import.title')))) return false;
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) {
        resolve(false);
        return;
      }
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (data && data.format !== undefined && data.format !== ENCOUNTER_FORMAT) {
          toast(t('encfileops.import.notEncounter', { format: data.format }), 'error');
          resolve(false);
          return;
        }
        afterOpen(data, t('encfileops.import.loading', { name: file.name }), null);
        setStatusMessage(t('encfileops.import.done', { name: file.name }), 'ok');
        toast(t('encfileops.import.done', { name: file.name }), 'ok');
        resolve(true);
      } catch (err) {
        toast(t('encfileops.import.failed', { msg: err.message || err }), 'error');
        await openModal({
          title: t('encfileops.import.failedTitle'),
          body:
            `<p>${escapeHtml(t('encfileops.import.failed', { msg: err && err.message ? err.message : String(err) }))}</p>` +
            `<p style="color:#ff8f99">${escapeHtml(err && err.message ? err.message : String(err))}</p>`,
          buttons: [{ label: t('encfileops.ack'), value: true, kind: 'primary' }],
        });
        resolve(false);
      }
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(false);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** 匯出本機 JSON */
export function exportEncounter() {
  const s = store();
  if (!s) return false;
  const doc = s.doc || {};
  const metaName = doc.meta && doc.meta.name ? String(doc.meta.name) : '';
  const base = s.fileName ? stripJson(s.fileName) : slugify(metaName) || 'encounter';
  const name = `${normalizeFileName(base) || 'encounter'}.json`;
  try {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
    setStatusMessage(t('encfileops.export.done', { name }), 'ok');
    toast(t('encfileops.export.done', { name }), 'ok');
    return true;
  } catch (err) {
    toast(t('encfileops.export.failed', { msg: err.message || err }), 'error');
    return false;
  }
}

/** 開啟 samples/encounters/ 範例 */
export async function openSamplesMenu(anchorEl) {
  let samples = SAMPLE_FALLBACK.slice();
  try {
    const res = await fetch(SAMPLE_INDEX, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const data = await res.json();
      const raw = Array.isArray(data) ? data : (data && (data.samples || data.encounters)) || [];
      if (Array.isArray(raw) && raw.length) {
        samples = raw
          .map((s) => {
            if (typeof s === 'string') return { file: s, name: stripJson(s) };
            if (!s || typeof s !== 'object') return null;
            const file = s.file || s.name;
            if (!file) return null;
            return {
              file: String(file).endsWith('.json') ? String(file) : `${file}.json`,
              name: s.name || stripJson(String(file)),
              description: s.description || '',
            };
          })
          .filter(Boolean);
      }
    }
  } catch (_err) {
    /* 用後備清單 */
  }

  if (!samples.length) {
    return openModal({
      title: t('encfileops.samples.empty'),
      body: t('encfileops.samples.emptyBody'),
      buttons: [{ label: t('encfileops.ack'), value: true, kind: 'primary' }],
    });
  }

  const items = samples.map((s) => ({
    label: s.name || s.file,
    sub: s.description ? `${s.file}・${s.description}` : s.file,
    title: s.description ? `${s.file}・${s.description}` : s.file,
    onClick: () => {
      loadSample(s.file).catch(() => {});
    },
  }));
  openMenu(anchorEl || els.btnSamples, items);
  return true;
}

async function loadSample(file) {
  if (!(await confirmDiscard(t('encfileops.samples.title')))) return false;
  setStatusMessage(t('encfileops.samples.loading'));
  const dir = state.lastSampleDir || SAMPLE_DIR;
  try {
    const res = await fetch(`${dir}${encodeURIComponent(file)}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    afterOpen(data, t('encfileops.samples.opened', { name: stripJson(file) }), null);
    setStatusMessage(t('encfileops.samples.opened', { name: stripJson(file) }), 'ok');
    toast(t('encfileops.samples.opened', { name: stripJson(file) }), 'ok');
    return true;
  } catch (err) {
    setStatusMessage(t('encfileops.samples.failed', { msg: err.message || err }), 'error');
    toast(t('encfileops.samples.failed', { msg: err.message || err }), 'error');
    return false;
  }
}

/* ================================================================ 復原/重做 */

export function doUndo() {
  const s = store();
  if (!s) return false;
  if (!s.undo()) {
    setStatusMessage(t('encfileops.undo.none'));
    return false;
  }
  setStatusMessage(t('encfileops.undo.done'));
  refreshToolbarState();
  return true;
}

export function doRedo() {
  const s = store();
  if (!s) return false;
  if (!s.redo()) {
    setStatusMessage(t('encfileops.redo.none'));
    return false;
  }
  setStatusMessage(t('encfileops.redo.done'));
  refreshToolbarState();
  return true;
}

/* ================================================================ 工具列狀態 */

export function refreshToolbarState() {
  const s = store();
  if (!s) return;
  if (els.btnUndo) els.btnUndo.disabled = !s.canUndo();
  if (els.btnRedo) els.btnRedo.disabled = !s.canRedo();
  if (els.docDirty) els.docDirty.hidden = !s.isDirty();
  if (els.errCount) {
    const n = s.errors ? s.errors.size : 0;
    els.errCount.hidden = n === 0;
    els.errCount.textContent = t('encapp.errors.chip', { n });
  }
  if (els.btnPlay) {
    const p = preview();
    const playing = Boolean(p && p.isPlaying && p.isPlaying());
    els.btnPlay.textContent = playing ? `❚❚ ${t('enctoolbar.pause')}` : `▶ ${t('enctoolbar.play')}`;
    els.btnPlay.disabled = false;
  }
  if (els.previewMeta) {
    const p = preview();
    if (p && p.usingFallback) els.previewMeta.textContent = t('encpreview.fallback.banner');
  }
}

export function updateDocumentTitle() {
  const s = store();
  if (!s) return;
  const doc = s.doc || {};
  const metaName = doc.meta && doc.meta.name ? String(doc.meta.name) : '';
  // B7：與攻擊編輯器一致——存檔／另存後以「檔名」為標題；沒有檔名才退回 meta.name。
  const fileName = s.fileName || state.lastSavedName || '';
  const label = fileName ? stripJson(fileName) : metaName || t('encapp.untitled');
  if (els.docName) {
    els.docName.textContent = label;
    els.docName.title = fileName
      ? t('encfileops.doc.fileInfo', { name: fileName })
      : t('encfileops.doc.metaInfo', { name: label });
  }
  if (typeof document !== 'undefined') {
    document.title = t('encapp.docTitle', { name: label });
  }
}

/* ================================================================ 錯誤清單 */

export function showErrorList() {
  const s = store();
  if (!s) return;
  const errors = s.errors || new Map();
  if (errors.size === 0) {
    return openModal({
      title: t('encfileops.errors.none'),
      body: t('encfileops.errors.noneBody'),
      buttons: [{ label: t('encfileops.ack'), value: true, kind: 'primary' }],
    });
  }
  const rows = [];
  for (const [path, message] of errors) {
    rows.push(
      `<div class="err-row"><code>${escapeHtml(path)}</code><span>${escapeHtml(message)}</span>` +
        `<button type="button" class="err-jump" data-path="${escapeHtml(path)}" title="選取此節點">→</button></div>`,
    );
  }
  const body = `<div class="err-list">${rows.join('')}</div>` + t('encfileops.errors.hint', { rows: '' });
  const promise = openModal({
    title: t('encfileops.errors.title', { n: errors.size }),
    body,
    wide: true,
    buttons: [{ label: t('encfileops.ack'), value: true, kind: 'primary' }],
  });
  // 點路徑旁的箭頭 → 把選取移到該節點（結構樹／檢查器會跟著跳）
  const root = q('modal-root');
  if (root) {
    root.addEventListener('click', (ev) => {
      const btn = ev.target && ev.target.closest ? ev.target.closest('.err-jump') : null;
      if (!btn) return;
      const path = btn.dataset.path || '';
      const guessed = guessSelectionForPath(path);
      if (guessed) s.setSelection(guessed);
      closeModal();
    });
  }
  return promise;
}

/**
 * 由驗證錯誤的 JSON 路徑猜一個選取（給「錯誤清單 → 點箭頭跳過去」用）。
 * @param {string} path 例如 'enemies[0].acts[1].cues[0].actor'
 * @returns {{kind:string,id:(string|null),path:(string|null)}|null}
 */
export function guessSelectionForPath(path) {
  const text = String(path || '');
  if (!text || text === '$') return { kind: 'settings', id: null, path: 'settings' };
  let m = text.match(/^actors\.([A-Za-z0-9_\-]+)/);
  if (m) return { kind: 'actor', id: m[1], path: `actors.${m[1]}` };
  m = text.match(/^hooks\.([A-Za-z0-9_\-]+)/);
  if (m) return { kind: 'hook', id: m[1], path: `hooks.${m[1]}` };
  m = text.match(/^party\[(\d+)\](?:\.spells\[(\d+)\])?/);
  if (m) {
    const i = Number(m[1]);
    if (m[2] !== undefined) {
      const j = Number(m[2]);
      return { kind: 'spell', id: null, path: `party[${i}].spells[${j}]`, meta: { index: i, index2: j } };
    }
    return { kind: 'party', id: null, path: `party[${i}]`, meta: { index: i } };
  }
  m = text.match(/^enemies\[(\d+)\](?:\.acts\[(\d+)\])?/);
  if (m) {
    const i = Number(m[1]);
    if (m[2] !== undefined) {
      const j = Number(m[2]);
      return { kind: 'act', id: null, path: `enemies[${i}].acts[${j}]`, meta: { index: i, index2: j } };
    }
    return { kind: 'enemy', id: null, path: `enemies[${i}]`, meta: { index: i } };
  }
  m = text.match(/^items\[(\d+)\]/);
  if (m) return { kind: 'item', id: null, path: `items[${Number(m[1])}]`, meta: { index: Number(m[1]) } };
  m = text.match(/^turns\[(\d+)\]/);
  if (m) {
    const i = Number(m[1]);
    const sub = /\.(start|end)\./.exec(text);
    return {
      kind: 'turn',
      id: null,
      path: `turns[${i}]`,
      meta: { index: i, cuesPath: sub ? `turns[${i}].${sub[1]}` : undefined },
    };
  }
  if (text.startsWith('settings') || text.startsWith('turnOrder') || text.startsWith('vars')) {
    return { kind: 'settings', id: null, path: 'settings' };
  }
  return null;
}

/* ================================================================ 預覽控制 */

export function togglePlay() {
  const p = preview();
  if (!p) return false;
  const playing = p.togglePlay ? p.togglePlay() : false;
  refreshToolbarState();
  return playing;
}

/** 跳到第 N 回合（輸入對話框） */
export async function promptJumpToTurn() {
  const p = preview();
  if (!p) return false;
  const max = p.getTurnCount ? p.getTurnCount() : 1;
  const raw = await promptDialog(t('encpreview.jumpPrompt', { max }), {
    title: t('encpreview.jump'),
    value: String((p.getTurn ? p.getTurn() : 0) + 1),
    placeholder: '1',
  });
  if (raw === null) return false;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n) || n < 1 || n > Math.max(1, max)) {
    toast(t('encpreview.jumpInvalid', { max: Math.max(1, max) }), 'error');
    return false;
  }
  const ok = p.jumpToTurn ? p.jumpToTurn(n) : false;
  if (!ok) {
    toast(t('encpreview.jumpFailed', { msg: t('encpreview.notReady') }), 'error');
    return false;
  }
  setStatusMessage(`${t('encpreview.jump')} ${n}`);
  return true;
}

/** 執行目前選取的指令清單 */
export function runSelectedCues() {
  const p = preview();
  if (!p || typeof p.runSelectedCues !== 'function') return false;
  const result = p.runSelectedCues();
  if (!result || !result.ok) {
    toast((result && result.reason) || t('encpreview.runCuesNone'), 'error');
    return false;
  }
  setStatusMessage(t('encpreview.runCuesDone', { n: result.count }), 'ok');
  return true;
}

/** 切換除錯浮窗 */
export function toggleDebugOverlay() {
  const p = preview();
  if (!p) return false;
  const visible = p.setDebugVisible ? p.setDebugVisible(!p.isDebugVisible()) : false;
  if (els.btnDebug) els.btnDebug.setAttribute('aria-pressed', visible ? 'true' : 'false');
  return visible;
}

/** 切換戰鬥語言 */
export function toggleBattleLang() {
  const p = preview();
  if (!p) return false;
  const lang = p.setBattleLang ? p.setBattleLang() : 'zh';
  setStatusMessage(`${t('encpreview.battleLang')}：${lang === 'en' ? 'EN' : '中'}`);
  refreshToolbarState();
  return lang;
}

/* ================================================================ 元素快取 */

function cacheElements() {
  els.btnNew = q('enc-btn-new');
  els.btnOpen = q('enc-btn-open');
  els.btnSave = q('enc-btn-save');
  els.btnSaveAs = q('enc-btn-save-as');
  els.btnImport = q('enc-btn-import');
  els.btnExport = q('enc-btn-export');
  els.btnSamples = q('enc-btn-samples');
  els.btnUndo = q('enc-btn-undo');
  els.btnRedo = q('enc-btn-redo');
  els.btnPlay = q('enc-btn-play');
  els.docName = q('enc-doc-name');
  els.docDirty = q('enc-doc-dirty');
  els.errCount = q('enc-error-count');
  els.previewMeta = q('enc-preview-meta');
  els.btnGoStart = q('enc-btn-goto-start');
  els.btnRestart = q('enc-btn-restart');
  els.btnStepBack = q('enc-btn-step-back');
  els.btnPlayPause = q('enc-btn-play-pause');
  els.btnStepFwd = q('enc-btn-step-fwd');
  els.btnJump = q('enc-btn-jump');
  els.btnRunCues = q('enc-btn-run-cues');
  els.btnDebug = q('enc-btn-debug');
  els.btnBattleLang = q('enc-btn-battle-lang');
  els.optGrid = q('enc-opt-grid');
  els.optHitbox = q('enc-opt-hitbox');
  els.optMute = q('enc-opt-mute');
  els.optLocale = q('enc-opt-locale');
  els.syncChip = q('enc-sync-chip');
  els.agentNote = q('enc-agent-note');
}

/* ================================================================ 語系下拉 */

function setupLocaleSelect() {
  const select = els.optLocale;
  if (!select) return;
  select.innerHTML = '';
  for (const loc of LOCALES) {
    const opt = document.createElement('option');
    opt.value = loc.id;
    opt.textContent = loc.label;
    select.appendChild(opt);
  }
  select.value = getLocale();
  select.addEventListener('change', () => {
    setLocale(select.value);
    applyDom(document);
    refreshToolbarState();
    updateDocumentTitle();
  });
}

/* ================================================================ 按鈕接線 */

function wireButtons() {
  if (els.btnNew) els.btnNew.addEventListener('click', () => newEncounter());
  if (els.btnOpen) els.btnOpen.addEventListener('click', () => openFromServer());
  if (els.btnSave) els.btnSave.addEventListener('click', () => saveEncounter());
  if (els.btnSaveAs) els.btnSaveAs.addEventListener('click', () => saveEncounterAs());
  if (els.btnImport) els.btnImport.addEventListener('click', () => importEncounter());
  if (els.btnExport) els.btnExport.addEventListener('click', () => exportEncounter());
  if (els.btnSamples) {
    els.btnSamples.addEventListener('click', (ev) => {
      ev.preventDefault();
      openSamplesMenu(els.btnSamples);
    });
  }
  if (els.btnUndo) els.btnUndo.addEventListener('click', () => doUndo());
  if (els.btnRedo) els.btnRedo.addEventListener('click', () => doRedo());
  if (els.btnPlay) els.btnPlay.addEventListener('click', () => togglePlay());
  if (els.errCount) els.errCount.addEventListener('click', () => showErrorList());

  // 預覽傳輸列
  if (els.btnGoStart) {
    els.btnGoStart.addEventListener('click', () => {
      const p = preview();
      if (p && p.gotoStart) p.gotoStart();
    });
  }
  if (els.btnRestart) {
    els.btnRestart.addEventListener('click', () => {
      const p = preview();
      if (p && p.restart) p.restart();
    });
  }
  if (els.btnStepBack) {
    els.btnStepBack.addEventListener('click', () => {
      const p = preview();
      if (p && p.step) p.step(-1);
    });
  }
  if (els.btnPlayPause) {
    els.btnPlayPause.addEventListener('click', () => {
      const p = preview();
      if (p && p.togglePlay) p.togglePlay();
      refreshToolbarState();
    });
  }
  if (els.btnStepFwd) {
    els.btnStepFwd.addEventListener('click', () => {
      const p = preview();
      if (p && p.step) p.step(1);
    });
  }
  if (els.btnJump) els.btnJump.addEventListener('click', () => promptJumpToTurn());
  if (els.btnRunCues) els.btnRunCues.addEventListener('click', () => runSelectedCues());
  if (els.btnDebug) els.btnDebug.addEventListener('click', () => toggleDebugOverlay());
  if (els.btnBattleLang) {
    els.btnBattleLang.addEventListener('click', () => toggleBattleLang());
    els.btnBattleLang.addEventListener('dblclick', () => {
      const p = preview();
      if (p && p.followLocaleBattleLang) p.followLocaleBattleLang();
      setStatusMessage(t('encpreview.battleLang'));
    });
  }

  // 選項
  const p = preview();
  const opts = (p && p.getOptions && p.getOptions()) || {};
  if (els.optGrid) {
    els.optGrid.checked = opts.showGrid !== false;
    els.optGrid.addEventListener('change', () => {
      const pp = preview();
      if (!pp || !pp.setOptions) return;
      pp.setOptions({ showGrid: els.optGrid.checked });
    });
  }
  if (els.optHitbox) {
    els.optHitbox.checked = Boolean(opts.showHitboxes);
    els.optHitbox.addEventListener('change', () => {
      const pp = preview();
      if (!pp || !pp.setOptions) return;
      pp.setOptions({ showHitboxes: els.optHitbox.checked });
    });
  }
  if (els.optMute) {
    els.optMute.checked = Boolean(opts.muted);
    els.optMute.addEventListener('change', () => {
      const pp = preview();
      if (!pp) return;
      if (pp.setOptions) pp.setOptions({ muted: els.optMute.checked });
      setStatusMessage(els.optMute.checked ? t('encpreview.audio.muted') : t('encpreview.audio.unmuted'));
    });
  }
}

/* ================================================================ 快捷鍵 */

function onKeyDown(ev) {
  if (ev.defaultPrevented) return;
  const key = ev.key || '';
  const mod = ev.ctrlKey || ev.metaKey;

  if (mod && !ev.altKey) {
    const k = key.toLowerCase();
    if (k === 's') {
      ev.preventDefault();
      saveEncounter();
      return;
    }
    if (k === 'z') {
      ev.preventDefault();
      if (ev.shiftKey) doRedo();
      else doUndo();
      return;
    }
    if (k === 'y') {
      ev.preventDefault();
      doRedo();
      return;
    }
  }

  if (isEditableTarget(ev.target)) return;
  if (state.modalOpen) {
    if (key === 'Escape') {
      ev.preventDefault();
      closeModal();
    }
    return;
  }

  if (key === 'Escape') {
    if (state.menuOpen) {
      ev.preventDefault();
      closeMenu();
    }
    return;
  }

  if (key === ' ' || key === 'Spacebar') {
    ev.preventDefault();
    togglePlay();
    return;
  }
  if (key === 'Home') {
    ev.preventDefault();
    const p = preview();
    if (p && p.gotoStart) p.gotoStart();
    return;
  }
  if (key === 'ArrowRight' && !ev.shiftKey) {
    ev.preventDefault();
    const p = preview();
    if (p && p.step) p.step(1);
    return;
  }
  if (key === 'ArrowLeft' && !ev.shiftKey) {
    ev.preventDefault();
    const p = preview();
    if (p && p.step) p.step(-1);
    return;
  }
  if (key === 'j' || key === 'J') {
    ev.preventDefault();
    promptJumpToTurn();
  }
}

/* ================================================================ 即時同步（SPEC-AGENT §5） */

function renderSyncStatus(status) {
  const s = status || {};
  const chip = els.syncChip || q('enc-sync-chip');
  const note = els.agentNote || q('enc-agent-note');
  if (chip) {
    if (!s.available && !s.connected) {
      chip.hidden = true;
    } else {
      chip.hidden = false;
      chip.dataset.state = s.connected ? 'online' : 'offline';
      chip.textContent = s.connected ? t('sync.chip.connected') : t('sync.chip.idle');
      chip.title = s.lastAgentAction ? t('sync.chip.lastAction', { action: s.lastAgentAction }) : t('sync.chip.title');
    }
  }
  if (note) {
    if (s.lastAgentAction) {
      note.hidden = false;
      note.textContent = s.lastAgentAction;
    } else {
      note.hidden = true;
      note.textContent = '';
    }
  }
}

/** 在文件裡找出 id 對應的 JSON 路徑（focus 事件的 eventId 用） */
function findPathById(node, id, path = '') {
  if (!node || typeof node !== 'object' || id === undefined || id === null) return null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const found = findPathById(node[i], id, `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (String(node.id) === String(id) && path) return path;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === 'object') {
      const found = findPathById(value, id, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return null;
}

/** 套用 focus 的「選取事件 + 跳回合/跳幀」部分（可重複呼叫，必須冪等） */
function applyFocusView(focus) {
  const s = store();
  if (!focus || !s) return;
  if (focus.eventId !== undefined && focus.eventId !== null) {
    const path = findPathById(s.doc, focus.eventId);
    if (path) {
      try {
        const guess = guessSelectionForPath(path);
        if (guess && guess.kind) s.setSelection(guess);
        else s.setSelection({ kind: 'turn', id: focus.eventId, path });
      } catch (_err) {
        /* 忽略 */
      }
    }
  }
  const p = preview();
  if (focus.turn !== undefined && focus.turn !== null && p && typeof p.jumpToTurn === 'function') {
    try {
      p.jumpToTurn(Math.max(0, Math.round(Number(focus.turn) || 0)));
    } catch (_err) {
      /* 忽略 */
    }
  }
  if (focus.frame !== undefined && focus.frame !== null && p && typeof p.seek === 'function') {
    try {
      p.seek(Math.max(0, Math.round(Number(focus.frame) || 0)));
    } catch (_err) {
      /* 忽略 */
    }
  }
}

/**
 * 剛換檔時 preview 會 debounce 重載並把 frame 歸零，
 * 直接 seek 會被蓋掉 → 等重載穩定後再套用（最多 ~1.6 秒）。
 */
async function applyFocusViewAfterSwitch(focus) {
  const target = Number(focus && focus.frame);
  for (let i = 0; i < 16; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    applyFocusView(focus);
    if (!Number.isFinite(target)) break;
    const p = preview();
    const frame = p && typeof p.getFrame === 'function' ? p.getFrame() : null;
    if (typeof frame === 'number' && Math.abs(frame - target) <= 1) break;
  }
}

async function handleFocusEvent(focus, by = '') {
  const s = store();
  if (!focus || !s) return;
  const target = focus.name ? normalizeFileName(focus.name) : null;
  const current = s.fileName || state.lastSavedName;
  let switched = false;
  if (target && `${target}.json` !== current && target !== current) {
    if (!(await confirmDiscard(t('sync.action.focus', { by: by || 'agent' })))) return;
    try {
      const loaded = await serverLoad(target);
      afterOpen(loaded.data, t('sync.focus.fileSwitched', { name: `${target}.json` }), `${target}.json`, loaded.etag);
      toast(t('sync.focus.fileSwitched', { name: `${target}.json` }), 'ok');
      switched = true;
    } catch (err) {
      toast(err && err.message ? err.message : String(err), 'error');
      return;
    }
  }
  if (switched) await applyFocusViewAfterSwitch(focus);
  else applyFocusView(focus);
  if (focus.frame !== undefined && focus.frame !== null) {
    toast(t('sync.focus.frame', { frame: Math.round(Number(focus.frame) || 0) }), 'ok');
  }
}

function startSyncClient() {
  if (syncClient || typeof window === 'undefined') return;
  const s = store();
  if (!s) return;
  try {
    let sessionStore = null;
    try {
      sessionStore = window.sessionStorage;
    } catch (_err) {
      sessionStore = null;
    }
    syncClient = createSyncClient({
      kind: 'encounter',
      store: s,
      preview: preview(),
      getFileName: () => {
        const current = store();
        return (current && current.fileName) || state.lastSavedName;
      },
      onMessage: (text, kind) => {
        const level = kind === 'error' ? 'error' : 'ok';
        setStatusMessage(text, level);
        if (level === 'error') toast(text, 'error');
      },
      onStatus: renderSyncStatus,
      onFileEvent: (event) => {
        if (event.kind === 'attack') preview()?.invalidateAttack?.(event.name);
      },
      onReconnect: () => preview()?.invalidateAttack?.(),
      onFocus: (focus, by) => handleFocusEvent(focus, by),
      sessionStorage: sessionStore,
    });
    syncClient.start();
    renderSyncStatus(syncClient.getStatus());
  } catch (err) {
    console.warn('[encounter:fileops] 即時同步初始化失敗：', err);
  }
}

/* ================================================================ mount */

/**
 * 建立工具列與預覽控制列。
 * @param {{store:object, preview:object, onMessage?:Function}} ctx
 * @returns {{refresh:Function, updateDocumentTitle:Function, destroy:Function}}
 */
export function mountToolbar(ctx = {}) {
  state.store = ctx.store || null;
  state.preview = ctx.preview || null;
  state.notify = typeof ctx.onMessage === 'function' ? ctx.onMessage : null;
  if (!state.store) throw new Error('[encounter:fileops] mountToolbar 需要 ctx.store');

  cacheElements();
  setupLocaleSelect();
  wireButtons();

  const unsub = state.store.subscribe(() => {
    refreshToolbarState();
    updateDocumentTitle();
    // SPEC-AGENT §5：選取 / 時間游標 / 語言變動都要回報給 Agent
    if (syncClient) syncClient.reportState(false);
  });
  const offLocale = onLocaleChange(() => {
    applyDom(document);
    refreshToolbarState();
    updateDocumentTitle();
  });

  document.addEventListener('keydown', onKeyDown);

  refreshToolbarState();
  updateDocumentTitle();
  startSyncClient();
  // B19：?file= / ?sample= 開頁自動載入（非阻塞；失敗只 toast，不動目前文件）
  state.queryLoad = startQueryLoad();

  // 預覽尚未建立時（main.js 會在 mount 之後 init）先給出正確狀態
  const api = {
    refresh() {
      refreshToolbarState();
      updateDocumentTitle();
    },
    updateDocumentTitle,
    refreshToolbarState,
    destroy() {
      document.removeEventListener('keydown', onKeyDown);
      if (unsub) unsub();
      if (offLocale) offLocale();
      if (syncClient) {
        try {
          syncClient.destroy();
        } catch (_err) {
          /* 忽略 */
        }
        syncClient = null;
      }
    },
    // 對外轉出常用動作（main.js / 面板可直接呼叫）
    newEncounter,
    openFromServer,
    saveEncounter,
    saveEncounterAs,
    importEncounter,
    exportEncounter,
    openSamplesMenu,
    doUndo,
    doRedo,
    togglePlay,
    promptJumpToTurn,
    runSelectedCues,
    toggleDebugOverlay,
    toggleBattleLang,
    showErrorList,
    toast,
    openModal,
    confirmDialog,
    promptDialog,
    pickDialog,
    openMenu,
    closeMenu,
    normalizeFileName,
    // B19：網址參數載入（?file= / ?sample=）
    parseLoadQuery,
    buildLoadQueryString,
    loadFromQuery,
    autosaveKey: ENCOUNTER_AUTOSAVE_KEY,
  };
  state.mount = api;
  return api;
}

export default mountToolbar;
