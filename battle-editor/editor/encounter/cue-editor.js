/**
 * editor/encounter/cue-editor.js — ED2：演出指令清單編輯器（SPEC-P2 §3 / §6）
 *
 * 對外介面（SPEC-P2 §8）：
 *   export function mount(rootEl, ctx) → api
 *   ctx = { store, assets, preview, getActors(), getAttacks() }
 *
 * 編輯 store.cuePath 指向的 cues 陣列（陣列路徑，例如 ['turns', 0, 'start']）。
 * 卡片式清單：每條指令一張卡（類別色 + 圖示 + 一行摘要），選取的卡片在卡內展開表單。
 * `if` / `parallel` 的子清單在卡片內以縮排子清單呈現，可拖入拖出。
 *
 * store 介面全部集中在 makeStoreAdapter()，ED1 的實作若有出入只需改那一處。
 * 純邏輯（路徑、摘要、拖曳插入、巢狀移動）在 cue-schema.js，可在 node 測試。
 */

import { t, registerStrings, onLocaleChange, getLocale, battleLangFor } from '../i18n.js';
import CUES_STRINGS from '../locales/cues.js';
import {
  CUE_GROUPS,
  EASE_NAMES,
  END_RESULTS,
  FIELD_TYPES,
  GROUP_COLORS,
  getCommandSpec,
  commandLabel,
  groupLabel,
  commandsByGroup,
  createDefaultCue,
  cloneCue,
  cueSummary,
  cueBadges,
  pickText,
  isTextObject,
  pathToKey,
  keyToPath,
  parseStorePath,
  formatStorePath,
  getArrayAt,
  getCueAt,
  computeDropTarget,
  moveCues,
  removeCues,
  duplicateCues,
  countCues,
  collectVarNames,
  matchCueErrors,
  matchListErrors,
  cueAbsPath,
  selectionForDrag,
} from './cue-schema.js';

registerStrings('cues', CUES_STRINGS);

/* ------------------------------------------------------------ 小工具 */

function ensureStyles() {
  if (typeof document === 'undefined') return;
  const exists = document.querySelector('link[data-cue-editor-css], link[href$="cue-editor.css"]');
  if (exists) return;
  try {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('./cue-editor.css', import.meta.url).href;
    link.dataset.cueEditorCss = '1';
    document.head.appendChild(link);
  } catch (err) {
    console.warn('[cue-editor] 無法自動注入 cue-editor.css', err);
  }
}

function clamp(n, lo, hi) {
  const x = Number(n);
  if (!Number.isFinite(x)) return lo;
  return Math.max(lo, Math.min(hi, x));
}

/** 建立元素；props 支援 className / text / dataset / style（含 --var）/ on* 事件 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'className') node.className = v;
    else if (k === 'text') node.textContent = String(v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'style') {
      for (const [sk, sv] of Object.entries(v)) {
        if (sk.startsWith('--')) node.style.setProperty(sk, String(sv));
        else node.style[sk] = sv;
      }
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k === 'value') node.value = v;
    else if (k === 'checked') node.checked = !!v;
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  const list = Array.isArray(children) ? children : [children];
  for (const c of list) {
    if (c === null || c === undefined || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

/* ---------------------------------------------------------- store 適配 */

/**
 * 把所有對 store 的假設集中在這裡（ED1 的遭遇 store 實作若有出入，只改這個函式）。
 *
 * 假設：
 *   store.encounter（或 doc / document / data / attack）＝ 遭遇文件
 *   store.cuePath           ＝ 目前 cues 陣列的絕對路徑（陣列或 'turns[0].start'）
 *   store.setCuePath(path)  ＝ 設定上面那個路徑（可選）
 *   store.update(fn, opts)  ＝ 套用草稿並提交（opts: { label, coalesceKey }）
 *   store.subscribe(fn)     ＝ fn(store, change)
 *   store.errors            ＝ Map<JSON 路徑, 訊息>
 *   store.select(kind, id)  ＝ 選取（可選；kind 'cue'、id＝卡片路徑字串）
 *   store.endCoalesce()     ＝ 結束合併（可選）
 */
function makeStoreAdapter(store) {
  const DOC_KEYS = ['encounter', 'doc', 'document', 'data', 'attack'];
  return {
    getDoc() {
      for (const key of DOC_KEYS) {
        const v = store[key];
        if (v && typeof v === 'object' && !Array.isArray(v)) return v;
      }
      return {};
    },
    hasDoc() {
      for (const key of DOC_KEYS) {
        const v = store[key];
        if (v && typeof v === 'object' && !Array.isArray(v)) return true;
      }
      return false;
    },
    getPath() {
      let raw;
      if (typeof store.getCuePath === 'function') {
        try { raw = store.getCuePath(); } catch (_err) { raw = undefined; }
      }
      if (raw === undefined) raw = store.cuePath;
      if (raw === null || raw === undefined) return null;
      return parseStorePath(raw);
    },
    setPath(path) {
      const norm = path === null || path === undefined ? null : parseStorePath(path);
      if (typeof store.setCuePath === 'function') {
        try { store.setCuePath(norm); return; } catch (err) { console.warn('[cue-editor] setCuePath 失敗', err); }
      }
      // store 沒提供 setter 時面板自己記住（ED1 接線前也能運作）
      this._localPath = norm;
    },
    update(fn, opts) {
      if (typeof store.update !== 'function') return false;
      try { return store.update(fn, opts); } catch (err) {
        console.error('[cue-editor] store.update 失敗', err);
        return false;
      }
    },
    endCoalesce() {
      if (typeof store.endCoalesce === 'function') {
        try { store.endCoalesce(); } catch (_err) { /* ignore */ }
      }
    },
    select(kind, id, extra) {
      if (typeof store.select !== 'function') return;
      try { store.select(kind, id, extra); } catch (_err) { /* ignore */ }
    },
    errors() {
      const e = store.errors;
      if (!e) return new Map();
      if (e instanceof Map) return e;
      try { return new Map(Object.entries(e)); } catch (_err) { return new Map(); }
    },
    _localPath: null,
  };
}

/* ---------------------------------------------------------------- mount */

export function mount(rootEl, ctx = {}) {
  if (!rootEl) throw new Error('[cue-editor] mount 需要 rootEl');
  const store = ctx.store;
  if (!store) throw new Error('[cue-editor] mount 需要 ctx.store');
  const assets = ctx.assets || null;
  const preview = ctx.preview || null;
  const getActorsFn = typeof ctx.getActors === 'function' ? ctx.getActors : null;
  const getAttacksFn = typeof ctx.getAttacks === 'function' ? ctx.getAttacks : null;
  const adapter = makeStoreAdapter(store);

  ensureStyles();

  /* ---------------- DOM ---------------- */
  rootEl.classList.add('cue-root');
  if (!rootEl.hasAttribute('tabindex')) rootEl.tabIndex = -1;
  rootEl.innerHTML = `
    <div class="cue-toolbar">
      <button class="cue-btn cue-btn-primary" type="button" data-act="add" aria-haspopup="menu"></button>
      <span class="cue-path" data-role="path"></span>
      <span class="cue-spacer"></span>
      <span class="cue-count" data-role="count"></span>
      <button class="cue-btn cue-btn-icon" type="button" data-act="expand" data-i18n-title="cues.btn.expandAll"></button>
      <button class="cue-btn cue-btn-icon" type="button" data-act="collapse" data-i18n-title="cues.btn.collapseAll"></button>
    </div>
    <div class="cue-banner" data-role="banner" hidden></div>
    <div class="cue-scroll" data-role="scroll" tabindex="-1">
      <div class="cue-list" role="listbox" aria-multiselectable="true" data-role="list"></div>
      <div class="cue-empty" data-role="empty" hidden>
        <div class="cue-empty-title" data-role="emptyTitle"></div>
        <div class="cue-empty-hint" data-role="emptyHint"></div>
      </div>
      <div class="cue-nopath" data-role="nopath" hidden>
        <div class="cue-empty-title" data-role="nopathTitle"></div>
        <div class="cue-empty-hint" data-role="nopathHint"></div>
      </div>
    </div>
    <div class="cue-hint" data-role="hint"></div>
    <div class="cue-status" data-role="status" role="status" hidden></div>
    <div class="cue-menu" data-role="menu" role="menu" hidden></div>
    <div class="cue-drop" data-role="dropline" hidden></div>
    <datalist data-role="dl-sprites"></datalist>
    <datalist data-role="dl-sounds"></datalist>
    <datalist data-role="dl-attacks"></datalist>
    <datalist data-role="dl-vars"></datalist>
    <datalist data-role="dl-colors"></datalist>
  `;
  const $ = (sel) => rootEl.querySelector(sel);
  const toolbar = $('.cue-toolbar');
  const pathEl = $('[data-role="path"]');
  const countEl = $('[data-role="count"]');
  const bannerEl = $('[data-role="banner"]');
  const scrollEl = $('[data-role="scroll"]');
  const listEl = $('[data-role="list"]');
  const emptyEl = $('[data-role="empty"]');
  const nopathEl = $('[data-role="nopath"]');
  const hintEl = $('[data-role="hint"]');
  const statusEl = $('[data-role="status"]');
  const menuEl = $('[data-role="menu"]');
  const dropLineEl = $('[data-role="dropline"]');
  const addBtn = $('[data-act="add"]');
  const dlSprites = $('[data-role="dl-sprites"]');
  const dlSounds = $('[data-role="dl-sounds"]');
  const dlAttacks = $('[data-role="dl-attacks"]');
  const dlVars = $('[data-role="dl-vars"]');
  const dlColors = $('[data-role="dl-colors"]');

  /* ---------------- 狀態 ---------------- */
  let currentPath = null;      // 陣列路徑或 null
  let currentPathKey = '';     // pathToKey(currentPath)
  let sel = new Set();         // 卡片路徑字串
  let primaryKey = null;
  let collapsed = new Set();   // 收合的容器路徑字串（預設全展開）
  const textModes = new Map(); // 'path:field' → 'single' | 'split'
  let clipboard = [];          // 指令深拷貝清單
  let menuTarget = null;       // { containerPath, index }
  let menuOpen = false;
  let selLock = 0;
  let destroyed = false;
  let structSig = '';
  let dragState = null;
  let formRefs = new Map();    // fieldKey → { row, errEl }
  let errorSeqSeen = '';

  const timers = { status: 0 };

  /* ---------------- 資料存取 ---------------- */
  function cuesOf() {
    if (!currentPath) return null;
    const doc = adapter.getDoc();
    const arr = getArrayAt(doc, currentPath);
    return Array.isArray(arr) ? arr : [];
  }

  function cuePathStr() {
    return currentPath ? formatStorePath(currentPath) : '';
  }

  /** 在草稿中取得（必要時建立）cues 陣列 */
  function ensureArrayAt(dock, path) {
    if (!path || !path.length) return Array.isArray(dock) ? dock : null;
    let parent = dock;
    const parentPath = path.slice(0, -1);
    for (const seg of parentPath) {
      if (typeof seg === 'number') {
        if (!Array.isArray(parent)) return null;
        if (!parent[seg] || typeof parent[seg] !== 'object') parent[seg] = {};
        parent = parent[seg];
      } else {
        if (!parent || typeof parent !== 'object') return null;
        if (!parent[seg] || typeof parent[seg] !== 'object') parent[seg] = {};
        parent = parent[seg];
      }
    }
    const last = path[path.length - 1];
    if (typeof last === 'number') {
      if (!Array.isArray(parent)) return null;
      if (!Array.isArray(parent[last])) parent[last] = [];
      return parent[last];
    }
    if (!parent || typeof parent !== 'object') return null;
    if (!Array.isArray(parent[last])) parent[last] = [];
    return parent[last];
  }

  /**
   * 修改目前的 cues 陣列（自動建立不存在的路徑）。
   * @param {(arr:any[], draft:object)=>void} fn
   */
  function mutateCues(fn, opts = {}) {
    const path = currentPath;
    if (!path) return false;
    const changed = adapter.update((draft) => {
      const arr = ensureArrayAt(draft, path);
      if (!arr) throw new Error('[cue-editor] 無法建立 cues 陣列');
      fn(arr, draft);
    }, opts);
    return changed;
  }

  /* ---------------- 來源清單（演員 / 攻擊 / 音效 / sprite / 變數） ---------------- */
  function actorOptions() {
    const out = [];
    const seen = new Set();
    const push = (id, kind, name) => {
      if (id === null || id === undefined || id === '') return;
      const key = String(id);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ id: key, kind: kind || 'actor', name: name || key });
    };
    if (getActorsFn) {
      try {
        const list = getActorsFn();
        if (Array.isArray(list)) for (const a of list) push(a && a.id, a && a.kind, a && (a.name || a.id));
      } catch (err) { console.warn('[cue-editor] getActors 失敗', err); }
    }
    if (!out.length) {
      const doc = adapter.getDoc();
      const actors = doc.actors && typeof doc.actors === 'object' ? doc.actors : {};
      for (const [id, def] of Object.entries(actors)) push(id, def && def.kind, id);
      for (const p of Array.isArray(doc.party) ? doc.party : []) push(p && (p.actor || p.id), 'party', p && (p.name || p.id));
      for (const e of Array.isArray(doc.enemies) ? doc.enemies : []) push(e && (e.actor || e.id), 'enemy', e && (e.name || e.id));
    }
    return out;
  }

  function attackNames() {
    const out = [];
    const push = (v) => {
      if (v === null || v === undefined || v === '') return;
      if (typeof v === 'string') { if (!out.includes(v)) out.push(v); return; }
      if (typeof v === 'object') {
        const n = v.name || v.id || v.file;
        if (n && !out.includes(String(n))) out.push(String(n));
      }
    };
    if (getAttacksFn) {
      try {
        const list = getAttacksFn();
        if (Array.isArray(list)) for (const a of list) push(a);
        else if (list && typeof list === 'object') for (const k of Object.keys(list)) push(k);
      } catch (err) { console.warn('[cue-editor] getAttacks 失敗', err); }
    }
    if (!out.length) {
      const idx = assets && assets.attacks ? assets.attacks : null;
      if (Array.isArray(idx)) for (const a of idx) push(a);
    }
    return out;
  }

  function indexKeys(group) {
    const idx = assets && assets.index ? assets.index : null;
    const bucket = idx && idx[group] ? idx[group] : null;
    if (!bucket || typeof bucket !== 'object') return [];
    return Object.keys(bucket);
  }

  function soundNames() { return indexKeys('audio'); }
  function spriteNames() { return indexKeys('sprites'); }

  function varNames() {
    const names = new Set();
    const doc = adapter.getDoc();
    if (doc.vars && typeof doc.vars === 'object' && !Array.isArray(doc.vars)) {
      for (const k of Object.keys(doc.vars)) names.add(k);
    }
    const cues = cuesOf();
    if (Array.isArray(cues)) collectVarNames(cues, names);
    return [...names];
  }

  function actorLabel(id) {
    if (id === null || id === undefined || id === '') return '—';
    const hit = actorOptions().find((a) => a.id === String(id));
    return hit ? hit.name : String(id);
  }

  function attackLabel(ref) {
    if (ref === null || ref === undefined || ref === '') return '—';
    if (typeof ref === 'object') return String(ref.name || ref.id || '{}');
    return String(ref);
  }

  /* ---------------- 語系 / 靜態字串 ---------------- */
  function applyStaticStrings() {
    if (addBtn) addBtn.textContent = `＋ ${t('cues.btn.add')}`;
    if (hintEl) hintEl.textContent = t('cues.hint');
    for (const btn of rootEl.querySelectorAll('[data-i18n-title]')) btn.title = t(btn.dataset.i18nTitle);
    for (const btn of rootEl.querySelectorAll('[data-i18n-aria-label]')) btn.setAttribute('aria-label', t(btn.dataset.i18nAriaLabel));
    rootEl.setAttribute('aria-label', t('cues.aria'));
    listEl.setAttribute('aria-label', t('cues.aria'));
    $('[data-role="emptyTitle"]').textContent = t('cues.empty');
    $('[data-role="emptyHint"]').textContent = t('cues.emptyHint');
    $('[data-role="nopathTitle"]').textContent = t('cues.noPath');
    $('[data-role="nopathHint"]').textContent = t('cues.noPathHint');
    fillDatalists();
    renderMenu();
  }

  function fillDatalist(node, values) {
    if (!node) return;
    node.textContent = '';
    for (const v of values) node.appendChild(el('option', { value: String(v) }));
  }

  function fillDatalists() {
    fillDatalist(dlSprites, spriteNames());
    fillDatalist(dlSounds, soundNames());
    fillDatalist(dlAttacks, attackNames());
    fillDatalist(dlVars, varNames());
    fillDatalist(dlColors, ['#ffffff', '#000000', '#ff0000', '#00ffff', '#ffff00', '#ff00ff', '#00ff00']);
  }

  /* ---------------- 新增指令選單 ---------------- */
  function renderMenu() {
    if (!menuEl) return;
    menuEl.textContent = '';
    menuEl.setAttribute('aria-label', t('cues.menu.title'));
    const head = el('div', { className: 'cue-menu-head', text: t('cues.menu.title') });
    menuEl.appendChild(head);
    for (const group of commandsByGroup()) {
      const box = el('div', { className: 'cue-menu-group' });
      box.appendChild(el('div', { className: 'cue-menu-cat' }, [
        el('span', { className: 'cue-dot', style: { '--c': group.color || GROUP_COLORS[group.group] } }),
        el('span', { text: group.label }),
      ]));
      for (const spec of group.commands) {
        box.appendChild(el('button', {
          type: 'button',
          role: 'menuitem',
          className: 'cue-menu-item',
          dataset: { cmd: spec.cmd },
          title: t(spec.descKey),
          onclick: (e) => { e.preventDefault(); e.stopPropagation(); pickCommand(spec.cmd); },
        }, [
          el('span', { className: 'cue-menu-icon', style: { '--c': group.color || GROUP_COLORS[group.group] }, text: spec.icon }),
          el('span', { className: 'cue-menu-label', text: commandLabel(spec.cmd) }),
          el('span', { className: 'cue-menu-desc', text: t(spec.descKey) }),
        ]));
      }
      menuEl.appendChild(box);
    }
  }

  function openMenu(anchorEl, target) {
    menuTarget = target || { containerPath: [], index: (cuesOf() || []).length };
    menuOpen = true;
    menuEl.hidden = false;
    menuEl.classList.add('is-open');
    const rootRect = rootEl.getBoundingClientRect();
    const anchorRect = anchorEl && anchorEl.getBoundingClientRect
      ? anchorEl.getBoundingClientRect()
      : rootRect;
    const availH = Math.max(96, (window.innerHeight || rootRect.bottom) - rootRect.top - 12);
    menuEl.style.maxHeight = `${Math.round(Math.min(420, availH))}px`;
    const mw = menuEl.offsetWidth || 240;
    const mh = menuEl.offsetHeight || 300;
    let left = clamp(anchorRect.left - rootRect.left, 4, Math.max(4, rootRect.width - mw - 4));
    let top = clamp(anchorRect.bottom - rootRect.top + 2, 4, Math.max(4, rootRect.height - mh - 4));
    const absRight = rootRect.left + left + mw;
    const absBottom = rootRect.top + top + mh;
    const vw = window.innerWidth || rootRect.right;
    const vh = window.innerHeight || rootRect.bottom;
    if (absRight > vw - 2) left = Math.max(0, left - (absRight - vw + 4));
    if (absBottom > vh - 2) top = Math.max(0, top - (absBottom - vh + 4));
    menuEl.style.left = `${Math.round(left)}px`;
    menuEl.style.top = `${Math.round(top)}px`;
    const first = menuEl.querySelector('.cue-menu-item');
    if (first && typeof first.focus === 'function') { try { first.focus({ preventScroll: true }); } catch (_err) { /* ignore */ } }
  }

  function closeMenu() {
    if (!menuOpen) return;
    menuOpen = false;
    menuEl.hidden = true;
    menuEl.classList.remove('is-open');
    menuTarget = null;
  }

  function pickCommand(cmd) {
    const target = menuTarget || { containerPath: [], index: (cuesOf() || []).length };
    closeMenu();
    addCue(cmd, target);
  }

  /* ---------------- 選取 ---------------- */
  function setSelection(keys, primary) {
    const next = new Set(keys || []);
    sel = next;
    primaryKey = primary && next.has(primary) ? primary : ([...next][0] || null);
    if (!primaryKey) primaryKey = null;
    syncSelectionToStore();
    render();
  }

  function syncSelectionToStore() {
    if (typeof store.select !== 'function') return;
    selLock += 1;
    try {
      // 一定要帶 meta.cuesPath：store.applySelection() 會用 defaultCuePathFor()
      // 重算 cuePath，而 kind:'cue' 的選取本身推不出清單路徑（會被清成 null），
      // 面板就會在每次點卡片後失去編輯目標。
      const selection = { meta: { cuesPath: cuePathStr() } };
      if (primaryKey) {
        selection.path = cueAbsPath(cuePathStr(), keyToPath(primaryKey));
        selection.meta.cueId = primaryKey;
      }
      adapter.select('cue', primaryKey || null, selection);
    } finally {
      selLock -= 1;
    }
  }

  function toggleSelection(key) {
    const next = new Set(sel);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setSelection(next, next.has(key) ? key : ([...next].pop() || null));
  }

  function selectOnly(key) {
    if (sel.size === 1 && primaryKey === key) return;
    setSelection([key], key);
  }

  function isSelected(key) { return sel.has(key); }

  /* ---------------- 狀態訊息 ---------------- */
  function status(message, ms = 2200) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.hidden = !message;
    if (timers.status) clearTimeout(timers.status);
    if (message && ms > 0) {
      timers.status = setTimeout(() => {
        timers.status = 0;
        if (statusEl) { statusEl.hidden = true; statusEl.textContent = ''; }
      }, ms);
    }
  }

  /* ---------------- 錯誤狀態 ---------------- */
  function cueError(path) {
    const errors = adapter.errors();
    if (!errors.size || !currentPath) return null;
    const spec = getCommandSpec((getCueAt(cuesOf() || [], path) || {}).cmd);
    const fieldKeys = spec ? new Set(spec.fields.map((field) => field.key)) : null;
    return matchCueErrors(errors, cuePathStr(), path, fieldKeys);
  }

  function listErrors() {
    const errors = adapter.errors();
    if (!errors.size || !currentPath) return [];
    return matchListErrors(errors, cuePathStr());
  }

  /* ---------------- 卡片結構簽章 ---------------- */
  function structSignature(cues) {
    const parts = [];
    const walk = (list) => {
      if (!Array.isArray(list)) { parts.push('x'); return; }
      parts.push(`#${list.length}`);
      for (const cue of list) {
        if (!cue || typeof cue !== 'object') { parts.push('?'); continue; }
        parts.push(`${cue.cmd || ''}${cue.async ? '!' : ''}`);
        const spec = getCommandSpec(cue.cmd);
        if (spec && spec.children) for (const key of spec.children) walk(cue[key]);
      }
    };
    walk(cues);
    return parts.join('|');
  }

  /* ---------------- 卡片 ---------------- */
  function buildCards(list, containerPath, depth) {
    const frag = document.createDocumentFragment();
    if (!Array.isArray(list)) return frag;
    list.forEach((cue, index) => {
      frag.appendChild(buildCard(cue, [...containerPath, index], containerPath, index, depth));
    });
    return frag;
  }

  function buildCard(cue, path, containerPath, index, depth) {
    const key = pathToKey(path);
    const spec = getCommandSpec(cue.cmd);
    const err = cueError(path);
    const color = (spec && GROUP_COLORS[spec.group]) || '#7a7a95';
    const card = el('div', {
      className: [
        'cue-card',
        isSelected(key) ? 'is-sel' : '',
        primaryKey === key ? 'is-primary' : '',
        err && err.any ? 'is-error' : '',
      ].filter(Boolean).join(' '),
      role: 'option',
      'aria-selected': isSelected(key) ? 'true' : 'false',
      dataset: { path: key, container: pathToKey(containerPath), index: String(index), depth: String(depth) },
      style: { '--depth': depth, '--c': color },
    });

    /* ---- 卡片頭 ---- */
    const head = el('div', { className: 'cue-card-head', dataset: { path: key } });
    head.appendChild(el('span', { className: 'cue-grip', 'aria-hidden': 'true', text: '⠿' }));
    head.appendChild(el('span', { className: 'cue-icon', text: (spec && spec.icon) || '???' }));
    const title = el('span', { className: 'cue-cmd', text: commandLabel(cue.cmd) });
    if (depth > 0) title.appendChild(el('span', { className: 'cue-depth', text: ` ${depth}` }));
    head.appendChild(title);
    head.appendChild(el('span', { className: 'cue-sum', text: cueSummary(cue, { actorName: actorLabel, attackName: attackLabel }) }));
    const badges = cueBadges(cue);
    if (err && err.any) badges.unshift(t('cues.card.err'));
    if (badges.length) {
      head.appendChild(el('span', { className: 'cue-badges' }, badges.map((b) => el('span', {
        className: 'cue-badge' + (b === t('cues.card.err') ? ' is-err' : ''),
        text: b,
        title: err && err.own ? err.own : b,
      }))));
    }
    const acts = el('span', { className: 'cue-card-acts' });
    acts.appendChild(el('button', {
      type: 'button',
      className: 'cue-mini' + (cue.async ? ' is-on' : ''),
      dataset: { act: 'async' },
      title: t('cues.card.asyncTitle'),
      text: cue.async ? t('cues.card.asyncOn') : t('cues.card.asyncOff'),
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleAsync(key); },
    }));
    acts.appendChild(el('button', {
      type: 'button', className: 'cue-mini', dataset: { act: 'dup' }, title: t('cues.card.dup'), text: '⧉',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); duplicatePaths([key], key); },
    }));
    acts.appendChild(el('button', {
      type: 'button', className: 'cue-mini is-danger', dataset: { act: 'del' }, title: t('cues.card.del'), text: '✕',
      onclick: (e) => { e.preventDefault(); e.stopPropagation(); deletePaths([key]); },
    }));
    if (spec && spec.children) {
      const open = !collapsed.has(key);
      acts.insertBefore(el('button', {
        type: 'button',
        className: 'cue-mini',
        dataset: { act: 'toggle' },
        title: open ? t('cues.card.close') : t('cues.card.open'),
        text: open ? '▾' : '▸',
        onclick: (e) => { e.preventDefault(); e.stopPropagation(); toggleCollapse(key); },
      }), acts.firstChild);
    }
    head.appendChild(acts);
    card.appendChild(head);

    /* ---- 表單（只有單選的主要卡片展開） ---- */
    if (primaryKey === key && sel.size === 1) card.appendChild(buildForm(cue, path));

    /* ---- 巢狀子清單 ---- */
    if (spec && spec.children && !collapsed.has(key)) {
      for (const childKey of spec.children) {
        const childPath = [...path, childKey];
        const childArr = Array.isArray(cue[childKey]) ? cue[childKey] : [];
        const sub = el('div', {
          className: 'cue-sublist',
          dataset: { container: pathToKey(childPath), parent: key, field: childKey },
        });
        const label = el('div', { className: 'cue-sublist-head' }, [
          el('span', { className: 'cue-sublist-label', text: `${t(`cues.field.${childKey}`)} · ${t('cues.count', { n: childArr.length })}` }),
          el('button', {
            type: 'button',
            className: 'cue-mini',
            dataset: { act: 'addchild' },
            title: t('cues.form.addChild'),
            text: '＋',
            onclick: (e) => {
              e.preventDefault();
              e.stopPropagation();
              openMenu(e.currentTarget, { containerPath: childPath, index: childArr.length });
            },
          }),
        ]);
        sub.appendChild(label);
        const inner = el('div', { className: 'cue-sublist-body', dataset: { container: pathToKey(childPath) } });
        if (!childArr.length) {
          inner.appendChild(el('div', { className: 'cue-sublist-empty', text: t('cues.form.emptyChild') }));
        } else {
          inner.appendChild(buildCards(childArr, childPath, depth + 1));
        }
        sub.appendChild(inner);
        card.appendChild(sub);
      }
    }
    return card;
  }

  /* ---------------- 表單 ---------------- */
  function buildForm(cue, path) {
    const key = pathToKey(path);
    formRefs = new Map();
    const err = cueError(path);
    const form = el('div', { className: 'cue-form', dataset: { path: key } });
    form.appendChild(el('div', { className: 'cue-form-head' }, [
      el('span', { text: t('cues.form.title') }),
      el('span', { className: 'cue-form-cmd', text: commandLabel(cue.cmd) }),
    ]));
    const spec = getCommandSpec(cue.cmd);
    if (!spec) {
      form.appendChild(el('div', { className: 'cue-form-warn', text: cueSummary(cue) }));
      return form;
    }
    for (const field of spec.fields) form.appendChild(buildFieldRow(field, cue, path, err));
    return form;
  }

  function buildFieldRow(field, cue, path, cueErr) {
    const key = pathToKey(path);
    const fieldErr = cueErr && cueErr.fields.get(field.key);
    const row = el('div', {
      className: 'cue-row' + (field.required ? ' is-required' : '') + (fieldErr ? ' is-error' : ''),
      dataset: { field: field.key },
    });
    const label = el('label', { className: 'cue-row-label' }, [
      el('span', { className: 'cue-row-name', text: t(field.labelKey) }),
      field.required ? el('span', { className: 'cue-req', title: t('cues.form.required'), text: '*' }) : null,
    ]);
    row.appendChild(label);
    const box = el('div', { className: 'cue-row-input' });
    row.appendChild(box);
    const desc = t(field.descKey);
    if (desc) row.appendChild(el('div', { className: 'cue-row-desc', text: desc }));
    const errEl = el('div', { className: 'cue-row-err', text: fieldErr ? t('cues.field.err', { message: fieldErr }) : '' });
    if (fieldErr) errEl.hidden = false; else errEl.hidden = true;
    row.appendChild(errEl);
    formRefs.set(field.key, { row, errEl });

    if (field.type === FIELD_TYPES.CUES) {
      box.appendChild(buildChildrenControls(field, cue, path));
      return row;
    }
    box.appendChild(buildFieldInput(field, cue, path));
    return row;
  }

  function buildChildrenControls(field, cue, path) {
    const key = pathToKey(path);
    const arr = Array.isArray(cue[field.key]) ? cue[field.key] : [];
    const wrap = el('div', { className: 'cue-children' });
    wrap.appendChild(el('span', { className: 'cue-children-count', text: t('cues.count', { n: arr.length }) }));
    wrap.appendChild(el('button', {
      type: 'button',
      className: 'cue-btn cue-btn-sm',
      text: `＋ ${t('cues.form.addChild')}`,
      onclick: (e) => {
        e.preventDefault();
        openMenu(e.currentTarget, { containerPath: [...keyToPath(key), field.key], index: arr.length });
      },
    }));
    return wrap;
  }

  function commitField(path, field, value) {
    const key = pathToKey(path);
    mutateCues((arr) => {
      const cue = getCueAt(arr, path);
      if (!cue) return;
      if (value === undefined) delete cue[field.key];
      else cue[field.key] = value;
    }, { label: t('cues.undo.field'), coalesceKey: `cue-field:${key}:${field.key}` });
    // 型別/值改變可能影響卡片摘要 → 就地更新（不重建，保住輸入焦點）
    patchSummaries();
  }

  function endFieldEdit() {
    adapter.endCoalesce();
  }

  function buildFieldInput(field, cue, path) {
    const value = cue[field.key];
    const onChange = (v) => commitField(path, field, v);
    switch (field.type) {
      case FIELD_TYPES.TEXT:
        return field.i18n ? buildTextInput(field, cue, path, onChange)
          : buildPlainText(field, value, (text) => onChange(field.nullable && text === '' ? null : text));
      case FIELD_TYPES.NUMBER:
        return buildNumberInput(field, value, onChange, false);
      case FIELD_TYPES.EXPR:
        return buildPlainText(field, value === null || value === undefined ? '' : String(value), (v) => {
          onChange(v === '' ? null : v);
        }, { placeholder: '0 / hp.kris + 1' });
      case FIELD_TYPES.ACTOR:
        return buildActorSelect(field, value, onChange);
      case FIELD_TYPES.TARGET:
        return buildTargetSelect(field, value, onChange);
      case FIELD_TYPES.SPRITE:
      case FIELD_TYPES.SOUND:
      case FIELD_TYPES.ATTACK: {
        const listId = field.type === FIELD_TYPES.SPRITE ? 'dl-sprites'
          : field.type === FIELD_TYPES.SOUND ? 'dl-sounds' : 'dl-attacks';
        const input = buildPlainText(field, value === null || value === undefined ? '' : String(value), (v) => {
          onChange(v === '' ? (field.nullable ? null : '') : v);
        }, { list: listId, placeholder: t('cues.form.optional') });
        // 素材面板拖放：text/plain 帶 sprite 名
        input.addEventListener('dragover', (e) => { e.preventDefault(); input.classList.add('is-dragover'); });
        input.addEventListener('dragleave', () => input.classList.remove('is-dragover'));
        input.addEventListener('drop', (e) => {
          e.preventDefault();
          input.classList.remove('is-dragover');
          const text = e.dataTransfer ? (e.dataTransfer.getData('text/plain') || '') : '';
          if (!text) return;
          input.value = text.trim();
          onChange(input.value);
        });
        return input;
      }
      case FIELD_TYPES.EASE:
        return buildSelect(field, value, EASE_NAMES, onChange, { nullable: field.nullable !== false, labelFor: (v) => v });
      case FIELD_TYPES.ENUM:
        return buildEnumSelect(field, value, onChange);
      case FIELD_TYPES.BOOL:
        return buildBoolSelect(field, value, onChange);
      case FIELD_TYPES.NUMBER_OR_INPUT:
        return buildPlainText(field, value === null || value === undefined ? '' : String(value), (v) => {
          if (v === '') onChange('input');
          else if (v === 'input') onChange('input');
          else {
            const n = Number(v);
            onChange(Number.isFinite(n) ? n : 'input');
          }
        }, { list: 'dl-none', placeholder: 'input / 1.5' });
      case FIELD_TYPES.COLOR:
        return buildColorInput(field, value, onChange);
      case FIELD_TYPES.VAR:
        return buildPlainText(field, value === null || value === undefined ? '' : String(value), (v) => onChange(v), { list: 'dl-vars' });
      case FIELD_TYPES.RESULT:
        return buildSelect(field, value, END_RESULTS, onChange, {
          nullable: false,
          labelFor: (v) => t(`cues.result.${v}`),
        });
      default:
        return buildPlainText(field, value === null || value === undefined ? '' : String(value), (v) => onChange(v));
    }
  }

  function buildPlainText(field, value, onChange, opts = {}) {
    const input = el('input', {
      type: 'text',
      className: 'cue-input',
      dataset: { field: field.key },
      value: value === null || value === undefined ? '' : String(value),
      placeholder: opts.placeholder || '',
    });
    if (opts.list) input.setAttribute('list', opts.list);
    input.addEventListener('input', () => onChange(input.value));
    input.addEventListener('change', () => endFieldEdit());
    input.addEventListener('blur', () => endFieldEdit());
    return input;
  }

  function buildNumberInput(field, value, onChange, nullable) {
    const input = el('input', {
      type: 'text',
      inputmode: 'decimal',
      className: 'cue-input cue-input-num',
      dataset: { field: field.key },
      value: value === null || value === undefined ? '' : String(value),
      placeholder: field.default === undefined ? '' : String(field.default),
    });
    const apply = () => {
      const raw = input.value.trim();
      if (raw === '') { onChange(nullable ? null : 0); return; }
      const n = Number(raw);
      onChange(Number.isFinite(n) ? n : (nullable ? null : 0));
    };
    input.addEventListener('input', () => {
      const raw = input.value.trim();
      if (raw === '' || Number.isFinite(Number(raw))) apply();
    });
    input.addEventListener('change', () => { apply(); endFieldEdit(); });
    input.addEventListener('blur', () => endFieldEdit());
    return input;
  }

  function buildTextInput(field, cue, path, onChange) {
    const modeKey = `${pathToKey(path)}:${field.key}`;
    const value = cue[field.key];
    const split = isTextObject(value) || textModes.get(modeKey) === 'split';
    const wrap = el('div', { className: 'cue-textfield' });
    const headRow = el('div', { className: 'cue-textfield-head' });
    headRow.appendChild(el('span', { className: 'cue-textfield-mode', text: t('cues.form.textMode') }));
    const toggle = el('button', {
      type: 'button',
      className: 'cue-mini cue-mini-wide',
      title: t('cues.textMode.title'),
      text: split ? t('cues.textMode.split') : t('cues.textMode.single'),
      onclick: (e) => {
        e.preventDefault();
        const next = !split;
        textModes.set(modeKey, next ? 'split' : 'single');
        const current = cue[field.key];
        if (next) {
          const zh = typeof current === 'string' ? current : pickText(current, 'zh');
          onChange({ zh, en: '' });
        } else {
          onChange(pickText(current, 'zh'));
        }
        render();
      },
    });
    headRow.appendChild(toggle);
    wrap.appendChild(headRow);

    if (!split) {
      wrap.appendChild(buildTextArea(field, value, onChange, 2));
    } else {
      const obj = isTextObject(value) ? value : { zh: pickText(value, 'zh'), en: '' };
      const zhRow = el('div', { className: 'cue-textfield-row' });
      zhRow.appendChild(el('span', { className: 'cue-textfield-lang', text: t('cues.text.zh') }));
      zhRow.appendChild(buildTextArea(field, obj.zh, (v) => onChange({ ...obj, zh: v }), 2));
      const enRow = el('div', { className: 'cue-textfield-row' });
      enRow.appendChild(el('span', { className: 'cue-textfield-lang', text: t('cues.text.en') }));
      enRow.appendChild(buildTextArea(field, obj.en, (v) => onChange({ ...obj, en: v }), 2));
      wrap.appendChild(zhRow);
      wrap.appendChild(enRow);
    }
    return wrap;
  }

  function buildTextArea(field, value, onChange, rows) {
    const ta = el('textarea', {
      className: 'cue-textarea',
      rows: String(rows || 2),
      dataset: { field: field.key },
    });
    ta.value = value === null || value === undefined ? '' : String(value);
    ta.addEventListener('input', () => onChange(ta.value));
    ta.addEventListener('change', () => endFieldEdit());
    ta.addEventListener('blur', () => endFieldEdit());
    return ta;
  }

  function buildActorSelect(field, value, onChange) {
    const actors = actorOptions();
    let list = actors;
    if (field.kinds && field.kinds.length) {
      const filtered = actors.filter((a) => field.kinds.includes(a.kind));
      if (filtered.length) list = filtered;
    }
    const select = el('select', { className: 'cue-select', dataset: { field: field.key } });
    if (field.nullable !== false && !field.required) {
      select.appendChild(el('option', { value: '', text: t('cues.opt.none') }));
    }
    if (!list.length) select.appendChild(el('option', { value: '', text: t('cues.actor.none') }));
    for (const actor of list) {
      select.appendChild(el('option', {
        value: actor.id,
        text: actor.kind === 'enemy' ? `${actor.name} · enemy` : actor.name,
      }));
    }
    select.value = value === null || value === undefined ? '' : String(value);
    if (select.value !== String(value ?? '') && value) {
      // 值不在清單裡（例如演員被刪）→ 補一個避免靜默改寫
      select.appendChild(el('option', { value: String(value), text: `${value} (?)` }));
      select.value = String(value);
    }
    select.addEventListener('change', () => {
      onChange(select.value === '' ? null : select.value);
      endFieldEdit();
    });
    return select;
  }

  function buildTargetSelect(field, value, onChange) {
    // heal/damage 的 target：隊員或敵人 id，也可以是 'party' / 'all'
    const actors = actorOptions();
    const select = el('select', { className: 'cue-select', dataset: { field: field.key } });
    const seen = new Set();
    const addOption = (v, label) => {
      const key = String(v);
      if (seen.has(key)) return;
      seen.add(key);
      select.appendChild(el('option', { value: key, text: label }));
    };
    const partyLike = actors.filter((a) => a.kind === 'party');
    const enemyLike = actors.filter((a) => a.kind === 'enemy');
    const others = actors.filter((a) => a.kind !== 'party' && a.kind !== 'enemy');
    for (const a of partyLike) addOption(a.id, a.name);
    for (const a of enemyLike) addOption(a.id, `${a.name} · enemy`);
    for (const a of others) addOption(a.id, a.name);
    addOption('party', t('cues.target.party'));
    addOption('all', t('cues.target.all'));
    if (value !== null && value !== undefined && !seen.has(String(value))) {
      addOption(value, `${value} (?)`);
    }
    select.value = value === null || value === undefined ? 'party' : String(value);
    select.addEventListener('change', () => { onChange(select.value); endFieldEdit(); });
    return select;
  }

  function buildEnumSelect(field, value, onChange) {
    const options = field.options || [];
    const select = el('select', { className: 'cue-select', dataset: { field: field.key } });
    for (const opt of options) {
      select.appendChild(el('option', {
        value: opt.value,
        text: opt.labelKey ? t(opt.labelKey) : String(opt.label),
      }));
    }
    select.value = value === null || value === undefined ? '' : String(value);
    if (!select.value && options.length) select.value = String(options[0].value);
    select.addEventListener('change', () => { onChange(select.value); endFieldEdit(); });
    return select;
  }

  function buildBoolSelect(field, value, onChange) {
    const select = el('select', { className: 'cue-select', dataset: { field: field.key } });
    const nullable = field.nullable !== false;
    if (nullable) select.appendChild(el('option', { value: '', text: t('cues.form.unset') }));
    select.appendChild(el('option', { value: 'true', text: t('cues.value.on') }));
    select.appendChild(el('option', { value: 'false', text: t('cues.value.off') }));
    select.value = value === null || value === undefined ? '' : (value ? 'true' : 'false');
    select.addEventListener('change', () => {
      onChange(select.value === '' ? null : select.value === 'true');
      endFieldEdit();
    });
    return select;
  }

  function buildSelect(field, value, names, onChange, opts = {}) {
    const select = el('select', { className: 'cue-select', dataset: { field: field.key } });
    if (opts.nullable) select.appendChild(el('option', { value: '', text: t('cues.opt.none') }));
    for (const name of names) {
      select.appendChild(el('option', {
        value: String(name),
        text: opts.labelFor ? opts.labelFor(name) : String(name),
      }));
    }
    select.value = value === null || value === undefined ? '' : String(value);
    if (select.value !== String(value ?? '') && value !== null && value !== undefined) {
      select.appendChild(el('option', { value: String(value), text: `${value} (?)` }));
      select.value = String(value);
    }
    select.addEventListener('change', () => {
      onChange(select.value === '' ? (opts.nullable ? null : '') : select.value);
      endFieldEdit();
    });
    return select;
  }

  function buildColorInput(field, value, onChange) {
    const wrap = el('div', { className: 'cue-color' });
    const text = buildPlainText(field, value === null || value === undefined ? '' : String(value), (v) => {
      onChange(v);
      swatch.value = /^#[0-9a-fA-F]{6}$/.test(v) ? v : swatch.value;
    }, { list: 'dl-colors' });
    const swatch = el('input', { type: 'color', className: 'cue-color-swatch', value: /^#[0-9a-fA-F]{6}$/.test(String(value)) ? String(value) : '#ffffff' });
    swatch.addEventListener('input', () => { text.value = swatch.value; onChange(swatch.value); });
    swatch.addEventListener('change', () => endFieldEdit());
    wrap.appendChild(text);
    wrap.appendChild(swatch);
    return wrap;
  }

  /* ---------------- 編輯操作 ---------------- */

  function toggleAsync(key) {
    const path = keyToPath(key);
    mutateCues((arr) => {
      const cue = getCueAt(arr, path);
      if (!cue) return;
      cue.async = !cue.async;
    }, { label: t('cues.undo.async') });
  }

  function toggleCollapse(key) {
    if (collapsed.has(key)) collapsed.delete(key);
    else collapsed.add(key);
    render();
  }

  function addCue(cmd, target) {
    const spec = getCommandSpec(cmd);
    if (!spec) return;
    const cue = createDefaultCue(cmd, {
      actors: actorOptions(),
      attacks: attackNames(),
      sounds: soundNames(),
      sprites: spriteNames(),
      vars: varNames(),
    });
    const destContainer = (target && target.containerPath) || [];
    const destIndex = target && Number.isFinite(target.index) ? target.index : 0;
    let newKey = null;
    mutateCues((arr) => {
      const container = destContainer.length ? getArrayAt(arr, destContainer) : arr;
      if (!Array.isArray(container)) return;
      const at = clamp(destIndex, 0, container.length);
      container.splice(at, 0, cue);
      newKey = pathToKey([...destContainer, at]);
    }, { label: t('cues.undo.add', { cmd: commandLabel(cmd) }) });
    if (!newKey) { status(t('cues.listError', { message: 'container' })); return; }
    // 展開所有祖先容器，讓新卡片可見
    let ancestor = '';
    const segs = keyToPath(newKey);
    for (let i = 1; i < segs.length; i += 1) {
      const prefix = segs.slice(0, i);
      if (typeof prefix[prefix.length - 1] === 'number') {
        ancestor = pathToKey(prefix);
        collapsed.delete(ancestor);
      }
    }
    setSelection([newKey], newKey);
    const cardEl = listEl.querySelector(`.cue-card[data-path="${newKey}"]`);
    if (cardEl && typeof cardEl.scrollIntoView === 'function') {
      try { cardEl.scrollIntoView({ block: 'nearest' }); } catch (_err) { /* ignore */ }
    }
  }

  function deletePaths(keys) {
    const list = (keys && keys.length ? keys : [...sel]).map((k) => keyToPath(k));
    if (!list.length) return;
    let removed = 0;
    mutateCues((arr) => { removed = removeCues(arr, list); }, { label: t('cues.undo.delete') });
    if (removed) setSelection([], null);
  }

  function duplicatePaths(keys, primary) {
    const list = (keys && keys.length ? keys : [...sel]).map((k) => keyToPath(k));
    if (!list.length) return;
    let created = [];
    mutateCues((arr) => { created = duplicateCues(arr, list); }, { label: t('cues.undo.duplicate') });
    if (created.length) {
      const newKeys = created.map((p) => pathToKey(p));
      setSelection(newKeys, primary ? newKeys[newKeys.length - 1] : newKeys[0]);
    }
  }

  function copySelection() {
    const cues = cuesOf();
    if (!Array.isArray(cues) || !sel.size) return false;
    const list = [...sel]
      .map((k) => ({ key: k, path: keyToPath(k) }))
      .sort((a, b) => {
        for (let i = 0; i < Math.min(a.path.length, b.path.length); i += 1) {
          const x = a.path[i];
          const y = b.path[i];
          if (x === y) continue;
          if (typeof x === 'number' && typeof y === 'number') return x - y;
          return String(x) < String(y) ? -1 : 1;
        }
        return a.path.length - b.path.length;
      });
    const out = [];
    for (const item of list) {
      const cue = getCueAt(cues, item.path);
      if (cue) out.push(cloneCue(cue));
    }
    clipboard = out;
    return out.length > 0;
  }

  function pasteClipboard() {
    if (!clipboard.length) { status(t('cues.paste.empty')); return; }
    const target = pasteTarget();
    const copies = clipboard.map((c) => cloneCue(c));
    let keys = [];
    mutateCues((arr) => {
      const container = target.containerPath.length ? getArrayAt(arr, target.containerPath) : arr;
      if (!Array.isArray(container)) return;
      const at = clamp(target.index, 0, container.length);
      container.splice(at, 0, ...copies);
      keys = copies.map((_c, i) => pathToKey([...target.containerPath, at + i]));
    }, { label: t('cues.undo.paste') });
    if (keys.length) setSelection(keys, keys[keys.length - 1]);
  }

  function pasteTarget() {
    const cues = cuesOf() || [];
    if (primaryKey && sel.size === 1) {
      const path = keyToPath(primaryKey);
      const container = path.slice(0, -1);
      const index = path[path.length - 1];
      if (typeof index === 'number') return { containerPath: container, index: index + 1 };
    }
    const last = [...sel].pop();
    if (last) {
      const path = keyToPath(last);
      if (path.length) {
        return { containerPath: path.slice(0, -1), index: (path[path.length - 1] || 0) + 1 };
      }
    }
    return { containerPath: [], index: cues.length };
  }

  function moveSelection(delta) {
    if (!primaryKey) return;
    const cues = cuesOf() || [];
    const path = keyToPath(primaryKey);
    const container = path.slice(0, -1);
    const arr = container.length ? getArrayAt(cues, container) : cues;
    if (!Array.isArray(arr)) return;
    const index = path[path.length - 1];
    const next = index + delta;
    if (next < 0 || next >= arr.length) return;
    const containerPath = container;
    const destIndex = delta > 0 ? next + 1 : next;
    let newKey = null;
    mutateCues((draft) => {
      const r = moveCues(draft, [path], containerPath, destIndex);
      if (r.ok && r.paths.length) newKey = pathToKey(r.paths[0]);
    }, { label: t('cues.undo.move') });
    if (newKey) {
      collapsed.delete(pathToKey(containerPath));
      setSelection([newKey], newKey);
    }
  }

  function setFieldValue(path, fieldKey, value) {
    const field = getCommandSpec(getCueAt(cuesOf() || [], path)?.cmd)?.fields?.find((f) => f.key === fieldKey);
    if (!field) return;
    commitField(path, field, value);
  }

  /* ---------------- 拖曳排序 ---------------- */
  function cardRectInfo(cardEl) {
    const r = cardEl.getBoundingClientRect();
    return {
      top: r.top,
      bottom: r.bottom,
      path: keyToPath(cardEl.dataset.path),
      index: Number(cardEl.dataset.index),
      containerPath: keyToPath(cardEl.dataset.container),
    };
  }

  function isPathPrefix(prefix, path) {
    if (!Array.isArray(prefix) || !Array.isArray(path) || prefix.length > path.length) return false;
    for (let i = 0; i < prefix.length; i += 1) if (String(prefix[i]) !== String(path[i])) return false;
    return true;
  }

  function dragPaths() {
    if (!dragState) return [];
    const keys = dragState.paths.length ? dragState.paths : [dragState.key];
    return keys.map((k) => keyToPath(k));
  }

  function computeDrop(clientX, clientY) {
    const dragged = dragPaths();
    const skip = (path) => dragged.some((p) => isPathPrefix(p, path));
    const subs = [...listEl.querySelectorAll('.cue-sublist-body')];
    for (const sub of subs) {
      const r = sub.getBoundingClientRect();
      if (clientY < r.top - 3 || clientY > r.bottom + 3) continue;
      if (clientX < r.left - 8 || clientX > r.right + 32) continue;
      const container = keyToPath(sub.dataset.container);
      if (dragged.some((p) => isPathPrefix(p, container))) continue; // 不能拖進自己的子孫
      const childEntries = [...sub.querySelectorAll(':scope > .cue-card')]
        .filter((cardEl) => !skip(keyToPath(cardEl.dataset.path)))
        .map(cardRectInfo);
      const target = computeDropTarget(childEntries, clientY, container);
      return { containerPath: container, index: target.index, y: dropLineY(container, target.index) };
    }
    const entries = [...listEl.querySelectorAll(':scope > .cue-card')]
      .filter((cardEl) => !skip(keyToPath(cardEl.dataset.path)))
      .map(cardRectInfo);
    const target = computeDropTarget(entries, clientY, []);
    return { containerPath: target.containerPath, index: target.index, y: dropLineY(target.containerPath, target.index) };
  }

  function dropLineY(containerPath, index) {
    const container = containerPath.length
      ? listEl.querySelector(`.cue-sublist-body[data-container="${pathToKey(containerPath)}"]`)
      : listEl;
    if (!container) return 0;
    const cards = [...container.querySelectorAll(':scope > .cue-card')];
    if (!cards.length) {
      const r = container.getBoundingClientRect();
      return r.top + 4;
    }
    if (index <= 0) return cards[0].getBoundingClientRect().top;
    if (index >= cards.length) return cards[cards.length - 1].getBoundingClientRect().bottom;
    return cards[index].getBoundingClientRect().top;
  }

  function showDropLine(clientY, drop) {
    const rootRect = rootEl.getBoundingClientRect();
    const scrollRect = scrollEl.getBoundingClientRect();
    const y = drop.y - scrollRect.top + scrollEl.scrollTop;
    dropLineEl.hidden = false;
    dropLineEl.style.top = `${Math.round(y)}px`;
    if (dropLineEl.parentElement !== scrollEl) scrollEl.appendChild(dropLineEl);
    const label = t('cues.drag.drop');
    dropLineEl.dataset.label = label;
    void rootRect;
  }

  function beginDrag(e) {
    const head = e.target.closest ? e.target.closest('.cue-card-head') : null;
    if (!head) return;
    if (e.target.closest('button, input, select, textarea, a, label')) return;
    if (e.button !== 0) return;
    rootEl.focus({ preventScroll: true });
    closeMenu();
    const card = head.closest('.cue-card');
    if (!card) return;
    const key = card.dataset.path;
    // 這裡刻意不改選取、不重繪：選取會展開表單，卡片一變高，拖曳過程中的
    // 插入點就會跟著跳。真正的選取改到超過拖曳門檻時（applyDragSelection）
    // 才套用，而且只切換 class、不重建 DOM。
    dragState = {
      key,
      paths: [],
      startX: e.clientX,
      startY: e.clientY,
      active: false,
      additive: Boolean(e.shiftKey || e.ctrlKey || e.metaKey),
      winId: null,
      drop: null,
      ghost: null,
    };
    const onMove = (ev) => onDragMove(ev);
    const onUp = (ev) => onDragUp(ev);
    dragState.cleanup = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  }

  /** 只切換選取樣式（不重建 DOM、不展開表單），拖曳期間用 */
  function paintSelection() {
    if (!listEl) return;
    for (const cardEl of listEl.querySelectorAll('.cue-card')) {
      const k = cardEl.dataset.path;
      cardEl.classList.toggle('is-sel', sel.has(k));
      cardEl.classList.toggle('is-primary', primaryKey === k);
      cardEl.setAttribute('aria-selected', sel.has(k) ? 'true' : 'false');
    }
  }

  /** 開始拖曳時才真正套用選取（拖曳中的卡片一定要在選取集合內） */
  function applyDragSelection() {
    if (!dragState) return;
    sel = new Set(selectionForDrag(sel, dragState.key, dragState.additive));
    primaryKey = dragState.key;
    syncSelectionToStore();
    paintSelection();
    dragState.paths = [...sel];
  }

  function startDragVisual() {
    if (!dragState || dragState.active) return;
    dragState.active = true;
    applyDragSelection();
    const n = dragState.paths.length;
    dragState.ghost = el('div', {
      className: 'cue-ghost',
      text: n > 1 ? t('cues.drag.moving', { n }) : t('cues.drag.moving', { n: 1 }),
    });
    document.body.appendChild(dragState.ghost);
    rootEl.classList.add('is-dragging');
  }

  function onDragMove(e) {
    if (!dragState) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.active && Math.hypot(dx, dy) < 5) return;
    startDragVisual();
    if (dragState.ghost) {
      dragState.ghost.style.left = `${Math.round(e.clientX + 12)}px`;
      dragState.ghost.style.top = `${Math.round(e.clientY + 10)}px`;
    }
    const inside = e.clientY >= scrollEl.getBoundingClientRect().top - 40
      && e.clientY <= scrollEl.getBoundingClientRect().bottom + 40;
    if (!inside) { dropLineEl.hidden = true; dragState.drop = null; return; }
    const drop = computeDrop(e.clientX, e.clientY);
    dragState.drop = drop;
    showDropLine(e.clientY, drop);
  }

  function onDragUp() {
    if (!dragState) return;
    const state = dragState;
    dragState = null;
    if (typeof state.cleanup === 'function') state.cleanup();
    if (state.ghost && state.ghost.parentElement) state.ghost.parentElement.removeChild(state.ghost);
    rootEl.classList.remove('is-dragging');
    dropLineEl.hidden = true;
    if (!state.active) {
      // 沒超過拖曳門檻 → 當成點擊：補上 pointerdown 刻意延後的選取
      // （shift/ctrl 的切換交給 click 處理，這裡不動）
      if (!state.additive) selectOnly(state.key);
      return;
    }
    if (!state.drop) { render(); return; }
    const drop = state.drop;
    const paths = state.paths.map((k) => keyToPath(k));
    if (!paths.length) { render(); return; }
    let ok = false;
    let newKeys = [];
    mutateCues((arr) => {
      const result = moveCues(arr, paths, drop.containerPath, drop.index);
      ok = result.ok;
      newKeys = result.paths.map((p) => pathToKey(p));
      if (!result.ok) console.warn('[cue-editor] 無法移動指令：', result.reason);
    }, { label: t('cues.undo.move') });
    if (ok && newKeys.length) {
      collapsed.delete(pathToKey(drop.containerPath));
      setSelection(newKeys, newKeys[0]);
    } else {
      render();
    }
  }

  /* ---------------- 清單 / 表單渲染 ---------------- */
  function patchSummaries() {
    const cues = cuesOf();
    if (!Array.isArray(cues)) return;
    for (const cardEl of listEl.querySelectorAll('.cue-card')) {
      const path = keyToPath(cardEl.dataset.path);
      const cue = getCueAt(cues, path);
      if (!cue) continue;
      const sumEl = cardEl.querySelector(':scope > .cue-card-head > .cue-sum');
      if (sumEl) sumEl.textContent = cueSummary(cue, { actorName: actorLabel, attackName: attackLabel });
      const asyncBtn = cardEl.querySelector(':scope > .cue-card-head [data-act="async"]');
      if (asyncBtn) {
        asyncBtn.textContent = cue.async ? t('cues.card.asyncOn') : t('cues.card.asyncOff');
        asyncBtn.classList.toggle('is-on', !!cue.async);
      }
    }
    patchErrors();
  }

  function patchErrors() {
    const bannerText = listErrors().map((e) => t('cues.listError', { message: e.message })).join(' · ');
    bannerEl.textContent = bannerText;
    bannerEl.hidden = !bannerText;

    for (const cardEl of listEl.querySelectorAll('.cue-card')) {
      const path = keyToPath(cardEl.dataset.path);
      const err = cueError(path);
      cardEl.classList.toggle('is-error', !!(err && err.any));
      let badgeEl = cardEl.querySelector(':scope > .cue-card-head > .cue-badges');
      const existing = badgeEl ? badgeEl.querySelector('.cue-badge.is-err') : null;
      if (err && err.any) {
        if (!existing) {
          if (!badgeEl) {
            badgeEl = el('span', { className: 'cue-badges' });
            const head = cardEl.querySelector(':scope > .cue-card-head');
            const acts = head.querySelector('.cue-card-acts');
            head.insertBefore(badgeEl, acts);
          }
          badgeEl.insertBefore(el('span', {
            className: 'cue-badge is-err',
            text: t('cues.card.err'),
            title: err.own || '',
          }), badgeEl.firstChild);
        } else if (err.own) {
          existing.title = err.own;
        }
      } else if (existing && existing.parentElement) {
        existing.parentElement.removeChild(existing);
      }
      // 表單內的欄位錯誤
      if (cardEl.dataset.path === primaryKey) {
        for (const [fieldKey, ref] of formRefs) {
          const message = err && err.fields.get(fieldKey);
          ref.row.classList.toggle('is-error', !!message);
          ref.errEl.textContent = message ? t('cues.field.err', { message }) : '';
          ref.errEl.hidden = !message;
        }
      }
    }
  }

  function render() {
    if (destroyed) return;
    const pathNow = adapter.getPath();
    const keyNow = pathNow ? pathToKey(pathNow) : '';
    if (keyNow !== currentPathKey) onPathChanged(pathNow);
    currentPathKey = keyNow;
    currentPath = pathNow;

    applyStaticStrings();
    if (!currentPath) {
      listEl.textContent = '';
      listEl.hidden = true;
      emptyEl.hidden = true;
      nopathEl.hidden = false;
      countEl.textContent = '';
      pathEl.textContent = '';
      addBtn.disabled = true;
      bannerEl.hidden = true;
      return;
    }
    addBtn.disabled = false;
    pathEl.textContent = `${t('cues.pathLabel')}: ${cuePathStr()}`;
    pathEl.title = cuePathStr();
    nopathEl.hidden = true;

    const cues = cuesOf() || [];
    const sig = structSignature(cues);
    const structural = sig !== structSig;
    structSig = sig;

    // 清掉失效的選取
    const validKeys = new Set();
    const collectKeys = (list, base) => {
      if (!Array.isArray(list)) return;
      list.forEach((cue, i) => {
        const p = [...base, i];
        validKeys.add(pathToKey(p));
        const spec = getCommandSpec(cue && cue.cmd);
        if (spec && spec.children) for (const ck of spec.children) collectKeys(cue[ck], [...p, ck]);
      });
    };
    collectKeys(cues, []);
    let selChanged = false;
    for (const k of [...sel]) if (!validKeys.has(k)) { sel.delete(k); selChanged = true; }
    if (primaryKey && !validKeys.has(primaryKey)) { primaryKey = null; selChanged = true; }
    if (!primaryKey && sel.size) { primaryKey = [...sel][0]; selChanged = true; }
    if (selChanged) syncSelectionToStore();

    const total = countCues(cues);
    countEl.textContent = t('cues.count', { n: total });
    emptyEl.hidden = total > 0;
    listEl.hidden = total === 0;
    if (structural || !listEl.children.length) {
      listEl.textContent = '';
      listEl.appendChild(buildCards(cues, [], 0));
      if (total === 0) {
        listEl.hidden = true;
      }
    } else {
      // 只換卡片內容（重建可確保順序與巢狀結構正確；值變動走 patchSummaries）
      listEl.textContent = '';
      listEl.appendChild(buildCards(cues, [], 0));
    }
    patchErrors();
  }

  function onPathChanged(nextPath) {
    sel = new Set();
    primaryKey = null;
    collapsed = new Set();
    textModes.clear();
    formRefs = new Map();
    structSig = '';
    if (typeof preview.clearSelection === 'function') { try { preview.clearSelection(); } catch (_err) { /* ignore */ } }
    void nextPath;
  }

  /* ---------------- 事件綁定 ---------------- */
  const ac = typeof AbortController === 'function' ? new AbortController() : null;
  const signal = ac ? ac.signal : undefined;
  const on = (target, type, fn, opts) => target.addEventListener(type, fn, { ...(opts || {}), signal });

  on(toolbar, 'click', (e) => {
    const btn = e.target.closest ? e.target.closest('[data-act]') : null;
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'add') { if (menuOpen) closeMenu(); else openMenu(addBtn, { containerPath: [], index: (cuesOf() || []).length }); }
    else if (act === 'expand') { collapsed = new Set(); render(); }
    else if (act === 'collapse') { collapsed = new Set(allContainerKeys()); render(); }
    btn.blur();
  });

  function allContainerKeys() {
    const out = [];
    const cues = cuesOf() || [];
    const walk = (list, base) => {
      if (!Array.isArray(list)) return;
      list.forEach((cue, i) => {
        const p = [...base, i];
        const spec = getCommandSpec(cue && cue.cmd);
        if (spec && spec.children) {
          out.push(pathToKey(p));
          for (const ck of spec.children) walk(cue[ck], [...p, ck]);
        }
      });
    };
    walk(cues, []);
    return out;
  }

  on(listEl, 'pointerdown', (e) => {
    if (e.button !== 0) return;
    rootEl.focus({ preventScroll: true });
    beginDrag(e);
  });

  on(listEl, 'keydown', (e) => {
    if (!sel.size) return;
    if (e.key === 'ArrowUp') { moveSelection(-1); e.preventDefault(); }
    else if (e.key === 'ArrowDown') { moveSelection(1); e.preventDefault(); }
    else if (e.key === 'Escape') { setSelection([], null); e.preventDefault(); }
  });

  // 雙擊空白處 → 新增指令
  on(listEl, 'dblclick', (e) => {
    if (e.target.closest && e.target.closest('.cue-card')) return;
    const cues = cuesOf() || [];
    openMenu(scrollEl, { containerPath: [], index: cues.length });
    e.preventDefault();
  });
  on(emptyEl, 'dblclick', () => openMenu(addBtn, { containerPath: [], index: (cuesOf() || []).length }));

  on(scrollEl, 'contextmenu', (e) => {
    // 空白處右鍵 → 新增（方便快速插入）
    if (e.target.closest && e.target.closest('.cue-card')) return;
    const cues = cuesOf() || [];
    openMenu(scrollEl, { containerPath: [], index: cues.length });
    e.preventDefault();
  });

  // 點擊卡片（非拖曳）→ 選取 / 展開
  on(listEl, 'click', (e) => {
    const head = e.target.closest ? e.target.closest('.cue-card-head') : null;
    if (!head) return;
    if (e.target.closest('button, input, select, textarea, a, label')) return;
    const card = head.closest('.cue-card');
    if (!card) return;
    const key = card.dataset.path;
    if (e.shiftKey || e.ctrlKey || e.metaKey) { toggleSelection(key); return; }
    if (isSelected(key) && primaryKey === key) {
      // 再點一次已選的主要卡片：容器切換展開，其餘維持
      const spec = getCommandSpec((getCueAt(cuesOf() || [], keyToPath(key)) || {}).cmd);
      if (spec && spec.children) toggleCollapse(key);
      else render();
      return;
    }
    selectOnly(key);
  });

  on(menuEl, 'click', (e) => {
    const item = e.target.closest ? e.target.closest('.cue-menu-item') : null;
    if (!item) return;
    pickCommand(item.dataset.cmd);
    e.preventDefault();
  });

  on(document, 'pointerdown', (e) => {
    if (!menuOpen) return;
    if (menuEl.contains(e.target) || toolbar.contains(e.target)) return;
    closeMenu();
  }, { capture: true });

  on(rootEl, 'keydown', (e) => {
    if (destroyed) return;
    if (menuOpen) {
      if (e.key === 'Escape') { closeMenu(); e.preventDefault(); }
      return;
    }
    const tag = (e.target && e.target.tagName) || '';
    const editing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (e.target && e.target.isContentEditable);
    if (editing) {
      if (e.key === 'Escape') { e.target.blur(); e.preventDefault(); }
      return;
    }
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'c' || e.key === 'C')) {
      if (copySelection()) e.preventDefault();
    } else if (mod && (e.key === 'v' || e.key === 'V')) {
      pasteClipboard(); e.preventDefault();
    } else if (mod && (e.key === 'd' || e.key === 'D')) {
      duplicatePaths([...sel], primaryKey); e.preventDefault();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (sel.size) { deletePaths([...sel]); e.preventDefault(); }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      if (!sel.size) return;
      moveSelection(e.key === 'ArrowUp' ? -1 : 1);
      e.preventDefault();
    } else if (e.key === 'Enter' || e.key === ' ') {
      if (!primaryKey) return;
      const spec = getCommandSpec((getCueAt(cuesOf() || [], keyToPath(primaryKey)) || {}).cmd);
      if (spec && spec.children) { toggleCollapse(primaryKey); e.preventDefault(); }
    } else if (e.key === 'Escape') {
      setSelection([], null);
      e.preventDefault();
    }
  });

  on(scrollEl, 'scroll', () => { if (menuOpen) closeMenu(); });

  /* ---------------- store / 語系 訂閱 ---------------- */
  let unsubStore = null;
  if (typeof store.subscribe === 'function') {
    unsubStore = store.subscribe((_st, change) => {
      if (destroyed) return;
      // store → 面板的選取同步（避免與本面板寫入互相覆蓋）
      if (!selLock && change && change.selectionOnly && store.selection && store.selection.kind === 'cue') {
        const id = store.selection.id;
        if (id && id !== primaryKey) { setSelection([id], id); return; }
        if (!id && sel.size) { setSelection([], null); return; }
      }
      const errorsKey = errorKeySignature();
      const errorsChanged = errorsKey !== errorSeqSeen;
      errorSeqSeen = errorsKey;
      const before = currentPathKey;
      const pathNow = adapter.getPath();
      const keyNow = pathNow ? pathToKey(pathNow) : '';
      if (keyNow !== before) { render(); return; }
      const cues = cuesOf() || [];
      const sig = structSignature(cues);
      if (sig !== structSig) { render(); return; }
      patchSummaries();
      if (errorsChanged) patchErrors();
    });
  }

  function errorKeySignature() {
    const errors = adapter.errors();
    if (!errors.size) return '';
    const parts = [];
    for (const [k, v] of errors) parts.push(`${k}=${v}`);
    parts.sort();
    return parts.join('|');
  }

  let unsubLocale = null;
  if (typeof onLocaleChange === 'function') {
    unsubLocale = onLocaleChange(() => {
      if (destroyed) return;
      // 保留選取、collapsed、捲動位置；只重繪文字
      render();
    });
  }

  /* ---------------- 公開 API ---------------- */
  const api = {
    version: '1.0.0',
    refresh() { render(); },
    getCuePath() { return currentPath ? currentPath.slice() : null; },
    setCuePath(path) { adapter.setPath(path); render(); },
    getSelection() { return [...sel]; },
    getPrimary() { return primaryKey; },
    getCount() { return countCues(cuesOf() || []); },
    /** 測試 / 除錯用：直接開新增選單（target 可指定容器與插入位置） */
    openAddMenu(target) {
      openMenu(addBtn, target || { containerPath: [], index: (cuesOf() || []).length });
    },
    closeMenu,
    /** 測試 / 除錯用：目前清單的攤平結構 */
    getFlattened() {
      return [...listEl.querySelectorAll('.cue-card')].map((cardEl) => ({
        path: cardEl.dataset.path,
        depth: Number(cardEl.dataset.depth),
        selected: isSelected(cardEl.dataset.path),
        primary: cardEl.dataset.path === primaryKey,
      }));
    },
    unmount() {
      destroyed = true;
      if (ac) ac.abort();
      if (typeof unsubStore === 'function') { try { unsubStore(); } catch (_err) { /* ignore */ } }
      if (typeof unsubLocale === 'function') { try { unsubLocale(); } catch (_err) { /* ignore */ } }
      if (dragState && typeof dragState.cleanup === 'function') dragState.cleanup();
      if (dragState && dragState.ghost && dragState.ghost.parentElement) dragState.ghost.parentElement.removeChild(dragState.ghost);
      dragState = null;
      if (timers.status) clearTimeout(timers.status);
      rootEl.classList.remove('cue-root', 'is-dragging');
      rootEl.innerHTML = '';
    },
  };

  // 曝光給測試/整合頁（與 timeline 面板一致的做法）
  rootEl.__drCueEditor = api;

  errorSeqSeen = errorKeySignature();
  render();
  return api;
}

export default mount;
