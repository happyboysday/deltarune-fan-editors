/**
 * 即時同步（SPEC-AGENT §5）
 *
 * 兩個編輯器（攻擊 / 遭遇）共用：
 *   - 訂閱 GET /api/events（SSE）：他人（by ≠ 自己 clientId）改動目前檔案時，
 *     沒有未存修改 → 自動載入新版並以「可復原的變更」套用；有未存修改 → 合併提示。
 *   - 存檔帶 If-Match（ETag）；409 走同一個合併提示。
 *   - 週期 PUT /api/editor/state（clientId / kind / name / selection / frame / lang）。
 *   - 收到 focus 事件 → 切換檔案 / 選取 / 跳幀，並顯示 note。
 *   - 工具列顯示 Agent 連線狀態與最近一次 Agent 動作。
 *
 * 這個模組不直接認識 store / preview 的細節，行為由呼叫端提供的回呼決定，
 * 方便 attack / encounter 兩個編輯器共用，也方便寫純函式測試。
 *
 * @module editor/live-sync
 */

import { t } from './i18n.js';
import './locales/live-sync.js';

/* ------------------------------------------------------------ 純函式 */

/** 正規化 ETag：去掉 W/ 與引號，統一小寫比較 */
export function normalizeEtag(value) {
  if (typeof value !== 'string' || !value) return '';
  let out = value.trim();
  if (out.startsWith('W/')) out = out.slice(2);
  out = out.replace(/^"+|"+$/g, '');
  return out.trim();
}

export function etagEquals(a, b) {
  const na = normalizeEtag(a);
  const nb = normalizeEtag(b);
  return na !== '' && na === nb;
}

/** 存檔用的請求標頭（If-Match / X-Client） */
export function buildSaveHeaders({ etag = '', clientId = '' } = {}) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  const clean = normalizeEtag(etag);
  if (clean) headers['If-Match'] = clean;
  if (clientId) headers['X-Client'] = clientId;
  return headers;
}

/**
 * 遠端 changed 事件要怎麼處理（純決策，測試用）。
 * @returns {'ignore'|'reload'|'conflict'}
 */
export function decideRemoteAction({ kind, selfKind, name, fileName, selfId, by, remoteEtag, baseEtag, dirty }) {
  if (!name || !fileName) return 'ignore';
  const strip = (value) =>
    String(value || '')
      .replace(/^.*[\\/]/, '')
      .replace(/\.json$/i, '');
  if (strip(name) !== strip(fileName)) return 'ignore';
  if (selfKind && kind && kind !== selfKind) return 'ignore';
  if (by && selfId && by === selfId) return 'ignore';
  if (baseEtag && remoteEtag && etagEquals(remoteEtag, baseEtag)) return 'ignore';
  return dirty ? 'conflict' : 'reload';
}

/** 解析 409 回應（純函式）：伺服器回 {conflict:true, etag, current} */
export function parseConflict(status, body, headerEtag = '') {
  if (Number(status) !== 409) return null;
  const payload = body && typeof body === 'object' ? body : {};
  const etag = normalizeEtag(payload.etag || headerEtag);
  if (!payload.conflict && !etag && !payload.current) return null;
  return {
    conflict: true,
    etag,
    current: payload.current && typeof payload.current === 'object' ? payload.current : null,
  };
}

/** 合併提示的選項 → 要套用的文件（純函式） */
export function resolveMergeChoice(choice, { mine = null, theirs = null } = {}) {
  if (choice === 'theirs') return { apply: 'theirs', doc: theirs };
  if (choice === 'mine') return { apply: 'mine', doc: mine };
  return { apply: 'cancel', doc: null };
}

/** 產生「檢視差異」用的摘要（純函式；只列出路徑與兩邊型別/長度，不逐字比對大物件） */
export function summarizeDiff(mine, theirs, maxItems = 40) {
  const out = [];
  const walk = (a, b, path, depth) => {
    if (out.length >= maxItems) return;
    if (a === b) return;
    const ta = a === null ? 'null' : Array.isArray(a) ? 'array' : typeof a;
    const tb = b === null ? 'null' : Array.isArray(b) ? 'array' : typeof b;
    if (ta !== tb) {
      out.push({ path: path || '$', mine: formatValue(a), theirs: formatValue(b) });
      return;
    }
    if (ta === 'object' || ta === 'array') {
      const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
      for (const key of keys) {
        if (out.length >= maxItems) return;
        const child = path ? (Array.isArray(a) || Array.isArray(b) ? `${path}[${key}]` : `${path}.${key}`) : key;
        walk(a ? a[key] : undefined, b ? b[key] : undefined, child, depth + 1);
      }
      return;
    }
    if (depth > 12) return;
    out.push({ path: path || '$', mine: formatValue(a), theirs: formatValue(b) });
  };
  walk(mine, theirs, '', 0);
  return out;
}

function formatValue(value) {
  if (value === undefined) return '（無）';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length > 60 ? `${value.slice(0, 57)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return `[${value.length}]`;
  return '{…}';
}

/** 穩定的 clientId：同一個分頁重新整理後不變（sessionStorage） */
export function readClientId(storage, key = 'drbe.clientId') {
  let id = '';
  try {
    id = storage ? String(storage.getItem(key) || '') : '';
  } catch (_err) {
    id = '';
  }
  if (!id) {
    id = `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    try {
      if (storage) storage.setItem(key, id);
    } catch (_err) {
      /* 忽略 */
    }
  }
  return id;
}

/* ------------------------------------------------------------ 合併對話框 */

const MODAL_STYLE = [
  'position:fixed',
  'inset:0',
  'z-index:9000',
  'display:flex',
  'align-items:center',
  'justify-content:center',
  'background:rgba(0,0,0,0.62)',
].join(';');

/**
 * 三選一合併提示：保留我的 / 採用對方 / 檢視差異。
 * @returns {Promise<'mine'|'theirs'|'cancel'>}
 */
export function openMergeDialog({ title, message, diff = null, source = '' }) {
  return new Promise((resolve) => {
    if (typeof document === 'undefined') {
      resolve('cancel');
      return;
    }
    const wrap = document.createElement('div');
    wrap.style.cssText = MODAL_STYLE;
    wrap.setAttribute('role', 'dialog');
    wrap.setAttribute('aria-modal', 'true');

    const card = document.createElement('div');
    card.className = 'modal-card';
    card.style.cssText = 'width:min(620px,92vw);max-height:86vh;overflow:auto';

    const h = document.createElement('h3');
    h.className = 'modal-title';
    h.textContent = title || t('sync.merge.title');
    const body = document.createElement('div');
    body.className = 'modal-body';
    const p = document.createElement('p');
    p.textContent = message || t('sync.merge.body');
    body.append(p);
    if (source) {
      const src = document.createElement('p');
      src.style.cssText = 'color:var(--accent);font-size:12px';
      src.textContent = source;
      body.append(src);
    }

    const diffBox = document.createElement('div');
    diffBox.className = 'sync-diff';
    diffBox.hidden = true;
    body.append(diffBox);

    const actions = document.createElement('div');
    actions.className = 'modal-actions';

    let viewBtn = null;
    const mkBtn = (label, value, kind) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `btn${kind ? ` btn-${kind}` : ''}`;
      b.textContent = label;
      b.addEventListener('click', () => {
        if (value === 'view') {
          diffBox.hidden = false;
          if (viewBtn) viewBtn.disabled = true;
          return;
        }
        cleanup();
        resolve(value);
      });
      return b;
    };

    const cancel = mkBtn(t('sync.merge.cancel'), 'cancel');
    const mine = mkBtn(t('sync.merge.mine'), 'mine');
    const theirs = mkBtn(t('sync.merge.theirs'), 'theirs', 'primary');
    viewBtn = diff && diff.length ? mkBtn(t('sync.merge.viewDiff'), 'view') : null;
    if (viewBtn) actions.append(viewBtn);
    actions.append(cancel, mine, theirs);

    if (diff && diff.length) {
      for (const row of diff.slice(0, 40)) {
        const line = document.createElement('div');
        line.className = 'sync-diff-row';
        line.textContent = `${row.path}  ·  ${t('sync.merge.mineShort')} ${row.mine}  →  ${t('sync.merge.theirsShort')} ${row.theirs}`;
        diffBox.append(line);
      }
    }

    card.append(h, body, actions);
    wrap.append(card);
    document.body.append(wrap);

    function onKey(ev) {
      if (ev.key === 'Escape') {
        cleanup();
        resolve('cancel');
      }
    }
    function cleanup() {
      document.removeEventListener('keydown', onKey, true);
      wrap.remove();
    }
    document.addEventListener('keydown', onKey, true);
    cancel.focus();
  });
}

/* ------------------------------------------------------------ 同步客戶端 */

const IDLE_INTERVAL = 9000;
const ACTIVE_INTERVAL = 2500;

/**
 * @param {object} opts
 * @param {'attack'|'encounter'} opts.kind
 * @param {object} opts.store             createStore 實例
 * @param {object} [opts.preview]         需要 getFrame()/seek()/getBattleLang()
 * @param {() => string|null} opts.getFileName 目前開啟的檔名（含 .json）
 * @param {(text:string, kind?:string)=>{}} [opts.onMessage] 工具列狀態訊息
 * @param {(status:object)=>{}} [opts.onStatus] 連線狀態 / 最近動作
 * @param {(focus:object)=>Promise<void>|void} [opts.onFocus] 收到 focus 時的處理
 * @param {typeof fetch} [opts.fetchImpl]
 * @param {typeof EventSource} [opts.EventSourceImpl]
 * @param {Storage} [opts.sessionStorage] clientId 儲存處
 */
export function createSyncClient(opts = {}) {
  const {
    kind = 'attack',
    store,
    preview = null,
    getFileName = () => null,
    onMessage = () => {},
    onStatus = () => {},
    onFocus = null,
    onFileEvent = () => {},
    onReconnect = () => {},
    fetchImpl = typeof fetch === 'function' ? fetch.bind(globalThis) : null,
    EventSourceImpl = typeof EventSource === 'function' ? EventSource : null,
    sessionStorage: sessionStore = typeof sessionStorage !== 'undefined' ? sessionStorage : null,
  } = opts;

  const clientId = readClientId(sessionStore);
  const state = {
    started: false,
    connected: false,
    available: Boolean(fetchImpl),
    etag: '',
    lastAgentAction: '',
    lastReportAt: 0,
    lastReportKey: '',
    pendingRemote: null, // {etag, by, name, current?}
    overwrite: null, // 使用者確認覆蓋的目標名稱與遠端版本
  };

  let source = null;
  let reportTimer = 0;
  let destroyed = false;
  let busy = false;

  const apiBase = `/api/${kind === 'encounter' ? 'encounters' : 'attacks'}`;

  function fileName() {
    const name = getFileName();
    return typeof name === 'string' && name ? name : null;
  }

  function stem(name) {
    return String(name || '')
      .replace(/^.*[\\/]/, '')
      .replace(/\.json$/i, '');
  }

  function emitStatus(extra = {}) {
    onStatus({
      clientId,
      kind,
      connected: state.connected,
      available: state.available,
      etag: state.etag,
      lastAgentAction: state.lastAgentAction,
      fileName: fileName(),
      ...extra,
    });
  }

  /* ---------------------------------------------------------- 存檔（ETag） */

  /**
   * PUT 目前文件；遇到 409 回 conflict（不自動覆蓋）。
   * @returns {Promise<{ok:true,name:string,etag:string}|{ok:false,conflict?:boolean,etag?:string,current?:object,error?:string}>}
   */
  async function save(targetName, doc) {
    if (!fetchImpl) return { ok: false, error: 'fetch-unavailable' };
    const name = targetName || fileName();
    if (!name) return { ok: false, error: 'no-file-name' };
    const cleanName = typeof name === 'string' && /\.json$/i.test(name) ? name : `${stem(name)}.json`;
    const url = `${apiBase}/${encodeURIComponent(cleanName)}`;
    const key = stem(cleanName);
    const current = key === stem(fileName());
    const confirmed = state.overwrite?.name === key ? state.overwrite.etag : '';
    const etag = confirmed || (current ? state.etag : '');
    const headers = buildSaveHeaders({ etag, clientId });
    if (!etag) headers['If-None-Match'] = '*';
    state.overwrite = null;
    let res;
    try {
      res = await fetchImpl(url, { method: 'PUT', headers, body: JSON.stringify(doc, null, 2) });
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
    const headerEtag = res.headers ? res.headers.get('ETag') || res.headers.get('X-Etag') || '' : '';
    let payload = null;
    try {
      payload = await res.json();
    } catch (_err) {
      payload = null;
    }
    if (res.status === 409) {
      const conflict = parseConflict(409, payload, headerEtag) || { conflict: true, etag: normalizeEtag(headerEtag), current: null };
      return { ok: false, conflict: true, etag: conflict.etag, current: conflict.current };
    }
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}`, etag: normalizeEtag((payload && payload.etag) || headerEtag) };
    }
    state.etag = normalizeEtag((payload && payload.etag) || headerEtag);
    state.pendingRemote = null;
    return { ok: true, name: (payload && payload.name) || cleanName, etag: state.etag };
  }

  /** 伺服器回 409 時使用：記住遠端版本並開合併提示 */
  async function resolveConflict({ name = null, current = null, etag = '', by = '' } = {}) {
    const target = name || fileName();
    let remoteDoc = current;
    let remoteEtag = normalizeEtag(etag);
    if (!remoteDoc) {
      const loaded = await loadRemote(target);
      if (loaded.ok) {
        remoteDoc = loaded.doc;
        remoteEtag = loaded.etag || remoteEtag;
      }
    }
    const mine = store && typeof store.doc !== 'undefined' ? store.doc : null;
    const diff = summarizeDiff(mine, remoteDoc);
    const choice = await openMergeDialog({
      title: t('sync.merge.title'),
      message: t('sync.merge.body'),
      diff,
      source: by ? t('sync.merge.by', { by }) : '',
    });
    const decision = resolveMergeChoice(choice, { mine, theirs: remoteDoc });
    if (decision.apply === 'theirs') {
      applyRemoteDocument(remoteDoc, remoteEtag, by);
      return 'theirs';
    }
    if (decision.apply === 'mine') {
      state.overwrite = { name: stem(target), etag: remoteEtag };
      store.markDirty ? store.markDirty() : null;
      onMessage(t('sync.merge.keepMineNote'), 'warn');
      return 'mine';
    }
    return 'cancel';
  }

  /* ---------------------------------------------------------- 讀取遠端 */

  async function loadRemote(name) {
    if (!fetchImpl || !name) return { ok: false };
    const url = `${apiBase}/${encodeURIComponent(name)}`;
    try {
      const res = await fetchImpl(url, { headers: { Accept: 'application/json', 'X-Client': clientId } });
      if (!res.ok) return { ok: false, status: res.status };
      const headerEtag = res.headers ? res.headers.get('ETag') || res.headers.get('X-Etag') || '' : '';
      const doc = await res.json();
      return { ok: true, doc, etag: normalizeEtag(headerEtag) };
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }
  }

  function applyRemoteDocument(doc, etag, by) {
    if (!doc || typeof doc !== 'object' || !store) return;
    state.etag = normalizeEtag(etag) || state.etag;
    state.pendingRemote = null;
    const label = by && by !== 'agent' ? t('sync.label.by', { by }) : t('sync.label.agent');
    try {
      if (typeof store.applyRemote === 'function') store.applyRemote(doc, label);
      else store.replace(doc, label);
    } catch (err) {
      onMessage(String(err && err.message ? err.message : err), 'error');
    }
  }

  /* ---------------------------------------------------------- 遠端事件 */

  let remoteRead = 0;
  async function handleChanged(event) {
    if (!event || destroyed) return;
    const name = stem(event.name);
    const current = stem(fileName());
    if (!name || !current || name !== current) return;
    if (event.by && event.by === clientId) return;
    const action = decideRemoteAction({
      kind,
      selfKind: kind,
      name,
      fileName: current,
      selfId: clientId,
      by: event.by,
      remoteEtag: event.etag,
      baseEtag: state.etag,
      dirty: Boolean(store && store.isDirty && store.isDirty()),
    });
    if (action === 'ignore') return;
    const request = ++remoteRead;
    state.lastAgentAction = t('sync.action.changed', { name: `${name}.json` });
    emitStatus({ lastEvent: 'changed' });
    if (action === 'conflict') {
      state.pendingRemote = { etag: event.etag, by: event.by, name };
      const result = await resolveConflict({ name: `${name}.json`, etag: event.etag, by: event.by });
      if (result === 'theirs') onMessage(t('sync.message.reloaded', { name: `${name}.json` }), 'ok');
      return;
    }
    const baseEtag = state.etag;
    const loaded = await loadRemote(`${name}.json`);
    if (!loaded.ok || destroyed || request !== remoteRead || name !== stem(fileName()) || state.etag !== baseEtag) return;
    if (store.isDirty()) {
      state.pendingRemote = { etag: loaded.etag || event.etag, by: event.by, name };
      await resolveConflict({ name: `${name}.json`, current: loaded.doc, etag: loaded.etag || event.etag, by: event.by });
      return;
    }
    applyRemoteDocument(loaded.doc, loaded.etag || event.etag, event.by);
    onMessage(t('sync.message.reloaded', { name: `${name}.json` }), 'ok');
  }

  async function handleDeleted(event) {
    if (!event || destroyed) return;
    const name = stem(event.name);
    const current = stem(fileName());
    if (!name || !current || name !== current) return;
    if (event.by && event.by === clientId) return;
    remoteRead += 1;
    state.lastAgentAction = t('sync.action.deleted', { name: `${name}.json` });
    emitStatus({ lastEvent: 'deleted' });
    onMessage(t('sync.message.deleted', { name: `${name}.json` }), 'warn');
  }

  async function handleFocus(event) {
    if (!event || destroyed) return;
    const focus = event.focus && typeof event.focus === 'object' ? event.focus : event;
    const by = event.by || focus.clientId || '';
    if (by && by === clientId) return;
    state.lastAgentAction = t('sync.action.focus', { by: by || 'agent' });
    emitStatus({ lastEvent: 'focus' });
    try {
      if (typeof onFocus === 'function') await onFocus(focus, by);
    } catch (err) {
      onMessage(String(err && err.message ? err.message : err), 'error');
    }
    if (focus.note) onMessage(String(focus.note), 'ok');
  }

  function dispatch(event) {
    if (!event || typeof event !== 'object') return;
    if (event.type === 'focus') {
      const targetKind = event.focus?.kind || event.kind;
      if (targetKind && targetKind !== kind) return;
      handleFocus(event);
      return;
    }
    if (event.type !== 'changed' && event.type !== 'deleted') return;
    onFileEvent(event);
    if (event.kind && event.kind !== kind) return;
    if (event.type === 'changed') handleChanged(event);
    else handleDeleted(event);
  }

  function connect() {
    if (source || destroyed || !EventSourceImpl) return;
    try {
      source = new EventSourceImpl('/api/events');
    } catch (err) {
      state.available = false;
      emitStatus();
      return;
    }
    let opened = false;
    source.addEventListener('open', () => {
      state.connected = true;
      state.available = true;
      if (opened) onReconnect();
      opened = true;
      emitStatus();
    });
    source.addEventListener('error', () => {
      state.connected = false;
      emitStatus();
    });
    const onEvent = (fallbackType) => (ev) => {
      let event = null;
      try {
        event = JSON.parse(ev.data);
      } catch (_err) {
        return;
      }
      if (!event || typeof event !== 'object') return;
      if (!event.type && fallbackType) event.type = fallbackType;
      dispatch(event);
    };
    // serve.py 的 SSE 會用「具名事件」送出（`event: changed` / `deleted` / `focus`），
    // 只監聽 message 會完全收不到，所以三種都要註冊；無具名時仍走 message。
    source.addEventListener('message', onEvent(null));
    for (const type of ['changed', 'deleted', 'focus']) {
      source.addEventListener(type, onEvent(type));
    }
  }

  /* ---------------------------------------------------------- 週期回報 */

  function reportPayload() {
    const selection = store && store.selection ? store.selection : null;
    const payload = {
      clientId,
      kind,
      name: fileName() ? stem(fileName()) : null,
      selection: selection ? { kind: selection.kind || null, id: selection.id ?? null, path: selection.path || null } : null,
      lang: preview && typeof preview.getBattleLang === 'function' ? preview.getBattleLang() : null,
      dirty: Boolean(store && store.isDirty && store.isDirty()),
      at: Date.now(),
    };
    if (preview && typeof preview.getFrame === 'function') {
      try {
        payload.frame = preview.getFrame();
      } catch (_err) {
        payload.frame = null;
      }
    }
    return payload;
  }

  async function reportState(force = false) {
    if (!fetchImpl || destroyed) return false;
    const payload = reportPayload();
    const key = JSON.stringify([payload.name, payload.selection, payload.frame, payload.lang, payload.dirty]);
    const now = Date.now();
    if (!force && key === state.lastReportKey && now - state.lastReportAt < IDLE_INTERVAL) return false;
    state.lastReportKey = key;
    state.lastReportAt = now;
    try {
      const res = await fetchImpl('/api/editor/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'X-Client': clientId },
        body: JSON.stringify(payload),
      });
      if (res && res.ok) {
        state.available = true;
        return true;
      }
    } catch (_err) {
      /* 舊版伺服器沒有這個端點 → 靜默 */
    }
    return false;
  }

  function scheduleReport() {
    if (reportTimer || destroyed) return;
    reportTimer = setTimeout(async () => {
      reportTimer = 0;
      if (destroyed) return;
      await reportState(false);
      scheduleReport();
    }, ACTIVE_INTERVAL);
  }

  /* ---------------------------------------------------------- 生命週期 */

  function start() {
    if (state.started || destroyed) return false;
    state.started = true;
    connect();
    scheduleReport();
    reportState(true);
    emitStatus();
    return true;
  }

  function destroy() {
    destroyed = true;
    if (reportTimer) clearTimeout(reportTimer);
    reportTimer = 0;
    if (source) {
      try {
        source.close();
      } catch (_err) {
        /* 忽略 */
      }
      source = null;
    }
    state.connected = false;
  }

  return {
    clientId,
    kind,
    apiBase,
    start,
    destroy,
    save,
    resolveConflict,
    loadRemote,
    reportState,
    emitStatus,
    handleEvent: dispatch,
    getEtag: () => state.etag,
    setEtag: (value) => {
      state.etag = normalizeEtag(value);
      state.overwrite = null;
      return state.etag;
    },
    getStatus: () => ({
      clientId,
      connected: state.connected,
      available: state.available,
      etag: state.etag,
      lastAgentAction: state.lastAgentAction,
      fileName: fileName(),
    }),
    isBusy: () => busy,
    setBusy: (value) => {
      busy = Boolean(value);
    },
    /** 給測試 / 除錯用 */
    _state: state,
  };
}

export default createSyncClient;
