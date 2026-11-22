/**
 * editor/main.js — 編輯器啟動流程（ED1 擁有）
 *
 * 順序：
 *   1. 建立 store（新建預設攻擊；若有 localStorage 自動暫存則詢問是否恢復）
 *   2. loadAssets('assets/index.json')（失敗 → null，引擎會畫洋紅色佔位方塊）
 *   3. dynamic import editor/preview.js（引擎尚未完成時顯示明顯提示而不是白屏）
 *   4. mountToolbar（工具列＋快捷鍵）
 *   5. 動態 import 並 mount 各面板：timeline / inspector / assets-panel / bullet-types
 *      任一面板 import 失敗時，只在該容器顯示「模組尚未完成」，其餘照常運作
 *
 * 面板掛載點（SPEC §10 + ED1 在 HTML 提供的子容器）：
 *   #timeline      ← editor/timeline.js        mount(rootEl, ctx)
 *   #inspector     ← editor/inspector.js       mount(rootEl, ctx)   （ED3）
 *   #assets-browser← editor/assets-panel.js    mount(rootEl, ctx)   （ED3）
 *   #bullet-types  ← editor/bullet-types.js    mount(rootEl, ctx)   （ED3）
 *   ctx = { store, assets, preview }
 */

import { createStore, readAutosave, clearAutosave, AUTOSAVE_KEY } from './store.js';
import { createDefaultAttack, setToolbarMessage, openFromQuery } from './fileops.js';
import { t, applyDom, getLocale, setLocale, LOCALES, onLocaleChange } from './i18n.js';
import './locales/app.js'; // 註冊 app/toolbar/preview/fileops 字串（副作用）
// 戰鬥框預設值一律取自引擎（SPEC-LAYOUT §5 實機量測），不在編輯器複製數字。
import { BOX_DEFAULTS } from '../engine/attack.js';

const ENGINE_MODULE = '../engine/index.js';
const ASSETS_INDEX = 'assets/index.json';
const PANEL_TIMEOUT = 12000;

/* ------------------------------------------------------------------ 小工具 */

const $ = (id) => document.getElementById(id);

function setBootStatus(text) {
  const el = $('boot-status');
  if (el) el.textContent = text;
}

function showBootError(text, detail) {
  const overlay = $('boot-overlay');
  const status = $('boot-status');
  const box = $('boot-detail');
  if (overlay) {
    overlay.hidden = false;
    overlay.dataset.error = '1';
    overlay.classList.remove('is-fading');
  }
  if (status) status.textContent = text;
  if (box && detail) {
    box.hidden = false;
    box.textContent = String(detail);
  }
  if (typeof window !== 'undefined' && typeof window.__drBootError === 'function') {
    /* 已有全域處理器，不重複設定 */
  }
}

function hideBootOverlay() {
  const overlay = $('boot-overlay');
  if (!overlay) return;
  overlay.classList.add('is-fading');
  setTimeout(() => {
    overlay.hidden = true;
    overlay.classList.remove('is-fading');
  }, 240);
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errText(err) {
  if (!err) return t('app.fallback.unknownError');
  if (typeof err === 'string') return err;
  return err.message || err.stack || String(err);
}

/* ------------------------------------------------------------------ 版面 */

// B3：版號 +1（舊版預設 236 / 210 / 190px 裝不下完整軌道）。
// 舊鍵只用來「沿用欄寬」，時間軸若明顯裝不下完整軌道就改用新的預設高度。
const LAYOUT_KEY = 'dr-battle-editor.layout.v2';
const LEGACY_LAYOUT_KEY = 'dr-battle-editor.layout.v1';
export const LAYOUT_DEFAULTS = { assets: 268, inspector: 312, timeline: 357 };

/**
 * B3：時間軸面板「非軌道內容」的實測高度（CSS px，Edge/Chromium）：
 *   面板頭 27 + 時間軸工具列 27（含底線）+ 尺 35（含底線）= 89～90
 * 9 軌內容高度由 layoutTracks(…, { allTypes: true }) 決定：266（emitter 有 2 列）。
 * 兩者相加 = 357，是最小的「9 軌全可見」高度；再高的話只是浪費預覽區空間。
 */
export const TIMELINE_CHROME_H = 90;
export const TIMELINE_TRACKS_H = 266;
export const TIMELINE_MIN_HEIGHT = TIMELINE_CHROME_H + TIMELINE_TRACKS_H; // 356

/**
 * 預覽區至少要留多少高度，時間軸才用「9 軌全可見」的高版？
 * 46（工具列）+ 8（分隔線）+ 357（時間軸）+ 302（預覽面板含邊框，讓 640×480 至少縮到 0.5 倍）
 *   = 713 → 取 717。低於這個高度就退回 240px 的可捲動時間軸，優先保住預覽區。
 */
const TIMELINE_VIEWPORT_MIN_H = 717;
const TIMELINE_COMPACT_H = 240;

/** 這個視窗高度下，預設時間軸要多高？（太矮的視窗退回 240，改用明顯捲軸＋底部漸層提示） */
export function timelineHeightForViewport(viewportHeight) {
  const vh = Number(viewportHeight);
  if (!Number.isFinite(vh) || vh <= 0) return TIMELINE_MIN_HEIGHT + 1;
  return vh < TIMELINE_VIEWPORT_MIN_H ? TIMELINE_COMPACT_H : TIMELINE_MIN_HEIGHT + 1;
}

/** 目前的預設時間軸高度（讀 window.innerHeight；node／無 window 時用 900） */
export function defaultTimelineHeight() {
  const vh = typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 900;
  return timelineHeightForViewport(vh);
}

/** 分隔線雙擊復原用的預設值（時間軸要跟著視窗高度走） */
function defaultLayoutValue(key) {
  return key === 'timeline' ? defaultTimelineHeight() : LAYOUT_DEFAULTS[key];
}
const LAYOUT_LIMITS = {
  assets: { min: 170, max: 520, varName: '--col-assets' },
  inspector: { min: 210, max: 620, varName: '--col-inspector' },
  timeline: { min: 120, max: 560, varName: '--row-timeline' },
};

function readStoredLayout(storageKey) {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const data = JSON.parse(raw);
    return data && typeof data === 'object' ? data : null;
  } catch (_err) {
    return null;
  }
}

/**
 * 讀版面：v2 優先；沒有就沿用 v1 的欄寬（時間軸太矮則改用新預設）。
 * 只有「使用者自己拖過」的值才會保留 —— v1 的時間軸高度是舊預設值，
 * 沿用下來會讓軌道繼續被裁掉（B3），所以太矮就忽略它。
 */
function readLayout() {
  const saved = { ...LAYOUT_DEFAULTS, timeline: defaultTimelineHeight() };
  const current = readStoredLayout(LAYOUT_KEY);
  const legacy = current ? null : readStoredLayout(LEGACY_LAYOUT_KEY);
  const data = current || legacy;
  if (!data) return saved;
  for (const key of Object.keys(LAYOUT_DEFAULTS)) {
    const v = Number(data[key]);
    if (!Number.isFinite(v)) continue;
    const lim = LAYOUT_LIMITS[key];
    // 從 v1 升級時，太矮的時間軸視為舊預設值 → 用新的預設高度
    if (legacy && key === 'timeline' && v < TIMELINE_MIN_HEIGHT) continue;
    saved[key] = Math.min(lim.max, Math.max(lim.min, Math.round(v)));
  }
  return saved;
}

function applyLayout(layout) {
  const root = document.documentElement;
  for (const key of Object.keys(LAYOUT_DEFAULTS)) {
    const lim = LAYOUT_LIMITS[key];
    const v = Math.min(lim.max, Math.max(lim.min, Math.round(Number(layout[key]) || LAYOUT_DEFAULTS[key])));
    root.style.setProperty(lim.varName, `${v}px`);
  }
}

function writeLayout(layout) {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch (_err) {
    /* 忽略 */
  }
}

/**
 * 分隔線拖曳：key = assets/inspector（左右）、timeline（上下）
 */
function setupSplitters(layout) {
  const map = [
    { id: 'split-assets', key: 'assets', axis: 'x', dir: 1 },
    { id: 'split-inspector', key: 'inspector', axis: 'x', dir: -1 },
    { id: 'split-timeline', key: 'timeline', axis: 'y', dir: -1 },
  ];

  for (const cfg of map) {
    const handle = $(cfg.id);
    if (!handle) continue;
    const lim = LAYOUT_LIMITS[cfg.key];

    const startDrag = (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      ev.preventDefault();
      const startPos = cfg.axis === 'x' ? ev.clientX : ev.clientY;
      const startVal = layout[cfg.key];
      let current = startVal;
      let moved = false;

      const onMove = (e) => {
        const pos = cfg.axis === 'x' ? e.clientX : e.clientY;
        const delta = (pos - startPos) * cfg.dir;
        const next = Math.round(Math.min(lim.max, Math.max(lim.min, startVal + delta)));
        if (next !== current) {
          current = next;
          layout[cfg.key] = next;
          applyLayout(layout);
          moved = true;
        }
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('pointercancel', onUp, true);
        document.body.classList.remove('dragging-col', 'dragging-row', 'is-splitter-drag');
        handle.classList.remove('is-dragging');
        try {
          handle.releasePointerCapture(pointerId);
        } catch (_err) {
          /* 忽略 */
        }
        if (moved) {
          writeLayout(layout);
          if (typeof window !== 'undefined' && window.dispatchEvent) {
            window.dispatchEvent(new Event('resize'));
          }
        }
      };

      const pointerId = ev.pointerId;
      try {
        handle.setPointerCapture(pointerId);
      } catch (_err) {
        /* 忽略 */
      }
      handle.classList.add('is-dragging');
      document.body.classList.add(cfg.axis === 'x' ? 'dragging-col' : 'dragging-row');
      document.addEventListener('pointermove', onMove, true);
      document.addEventListener('pointerup', onUp, true);
      document.addEventListener('pointercancel', onUp, true);
    };

    handle.addEventListener('pointerdown', startDrag);
    handle.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      // 沒有 PointerEvent 的環境退回滑鼠拖曳
      if (typeof window.PointerEvent === 'function') return;
      ev.preventDefault();
      const startPos = cfg.axis === 'x' ? ev.clientX : ev.clientY;
      const startVal = layout[cfg.key];
      let current = startVal;
      const onMove = (e) => {
        const pos = cfg.axis === 'x' ? e.clientX : e.clientY;
        const delta = (pos - startPos) * cfg.dir;
        const next = Math.round(Math.min(lim.max, Math.max(lim.min, startVal + delta)));
        if (next !== current) {
          current = next;
          layout[cfg.key] = next;
          applyLayout(layout);
        }
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove, true);
        document.removeEventListener('mouseup', onUp, true);
        document.body.classList.remove('dragging-col', 'dragging-row');
        handle.classList.remove('is-dragging');
        writeLayout(layout);
      };
      handle.classList.add('is-dragging');
      document.body.classList.add(cfg.axis === 'x' ? 'dragging-col' : 'dragging-row');
      document.addEventListener('mousemove', onMove, true);
      document.addEventListener('mouseup', onUp, true);
    });

    // 雙擊回復預設
    handle.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      layout[cfg.key] = defaultLayoutValue(cfg.key);
      applyLayout(layout);
      writeLayout(layout);
      if (typeof window !== 'undefined' && window.dispatchEvent) window.dispatchEvent(new Event('resize'));
    });

    // 鍵盤可用性：聚焦後用方向鍵微調
    handle.tabIndex = 0;
    handle.addEventListener('keydown', (ev) => {
      const step = ev.shiftKey ? 24 : 8;
      let delta = 0;
      if (cfg.axis === 'x') {
        if (ev.key === 'ArrowLeft') delta = -step * cfg.dir;
        else if (ev.key === 'ArrowRight') delta = step * cfg.dir;
      } else {
        if (ev.key === 'ArrowUp') delta = -step * cfg.dir;
        else if (ev.key === 'ArrowDown') delta = step * cfg.dir;
      }
      if (!delta) return;
      ev.preventDefault();
      layout[cfg.key] = Math.round(Math.min(lim.max, Math.max(lim.min, layout[cfg.key] + delta)));
      applyLayout(layout);
      writeLayout(layout);
      if (typeof window !== 'undefined' && window.dispatchEvent) window.dispatchEvent(new Event('resize'));
    });
  }
}

/** 素材面板分頁：素材 / 子彈類型 */
function setupAssetsTabs() {
  const panel = $('assets-panel');
  if (!panel) return;
  const tabs = [...panel.querySelectorAll('.panel-tab')];
  const panes = [...panel.querySelectorAll('.pane[data-pane]')];
  const activate = (targetId) => {
    for (const tab of tabs) {
      const on = tab.dataset.tab === targetId;
      tab.classList.toggle('is-active', on);
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    for (const pane of panes) {
      const on = pane.dataset.pane === targetId;
      pane.hidden = !on;
    }
    if (typeof window !== 'undefined' && window.dispatchEvent) window.dispatchEvent(new Event('resize'));
  };
  for (const tab of tabs) {
    tab.addEventListener('click', () => activate(tab.dataset.tab));
    tab.addEventListener('keydown', (ev) => {
      if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return;
      ev.preventDefault();
      const idx = tabs.indexOf(tab);
      const nextIdx = ev.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
      tabs[nextIdx].focus();
      activate(tabs[nextIdx].dataset.tab);
    });
  }
  // 允許外部（例如檢查器）切換分頁
  window.__drShowAssetsPane = activate;
}

/* -------------------------------------------------------------- 面板載入 */

function placeholder(container, kind, detail, { warn = false } = {}) {
  if (!container) return;
  container.innerHTML = '';
  const wrap = el('div', 'panel-placeholder');
  const icon = el('span', 'ph-icon', warn ? '⚠' : '◌');
  const title = el('strong', null, kind);
  wrap.append(icon, title);
  const body = el('div', null, detail || '');
  wrap.appendChild(body);
  if (warn) wrap.style.color = '#b98a90';
  container.appendChild(wrap);
}

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(t('app.panel.timeout', { name: label, ms })));
    }, ms);
    Promise.resolve(promise).then(
      (v) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * 載入並掛載一個面板模組。
 * @param {{ name:string, file:string, container:HTMLElement|null, ctx:any, optional?:boolean }} cfg
 */
async function mountPanel(cfg) {
  const { name, file, container, ctx, optional = true } = cfg;
  if (!container) {
    console.warn(t('app.panel.noContainer', { name }));
    return { name, ok: false, reason: 'missing-container' };
  }
  if (typeof container.__drMounted !== 'undefined') return { name, ok: true, reason: 'already' };
  placeholder(container, name, t('app.panel.loading'));

  let mod;
  try {
    mod = await withTimeout(import(new URL(file, import.meta.url).href), PANEL_TIMEOUT, name);
  } catch (err) {
    const missing = /Failed to (fetch|load|resolve)|404|Cannot find module|ERR_MODULE|MIME/i.test(errText(err));
    placeholder(
      container,
      missing ? t('app.panel.notReady') : t('app.panel.loadFailed'),
      missing
        ? t('app.panel.missingDetail', { file })
        : t('app.panel.loadDetail', { file, msg: errText(err) }),
      { warn: true },
    );
    console.warn(`[main] ${name} 模組載入失敗：`, err);
    container.__drMounted = false;
    return { name, ok: false, reason: 'import', error: err };
  }

  const mountFn = mod && (typeof mod.mount === 'function' ? mod.mount : typeof mod.default === 'function' ? mod.default : null);
  if (!mountFn) {
    placeholder(container, t('app.panel.noMount'), t('app.panel.noMountDetail', { file }), { warn: true });
    container.__drMounted = false;
    return { name, ok: false, reason: 'no-mount' };
  }

  try {
    container.innerHTML = '';
    const result = await mountFn(container, ctx);
    container.__drMounted = true;
    container.__drPanel = result || true;
    if (optional === false) {
      /* 非選用面板失敗要處理，目前全部都是選用 */
    }
    return { name, ok: true, result };
  } catch (err) {
    console.error(`[main] ${name}.mount 失敗：`, err);
    placeholder(container, t('app.panel.mountFailed'), t('app.panel.mountDetail', { file, msg: errText(err) }), {
      warn: true,
    });
    container.__drMounted = false;
    return { name, ok: false, reason: 'mount', error: err };
  }
}

/* -------------------------------------------------------------- 恢復暫存 */

function describeAutosave(data) {
  const attack = data && data.attack ? data.attack : {};
  const name = (attack.meta && attack.meta.name) || data.fileName || t('app.untitled');
  let when = '';
  if (data && Number.isFinite(data.savedAt)) {
    try {
      when = new Date(data.savedAt).toLocaleString(getLocale(), { hour12: false });
    } catch (_err) {
      when = '';
    }
  }
  const count = Array.isArray(attack.timeline) ? attack.timeline.length : 0;
  return { name, when, count, fileName: data.fileName || '' };
}

/**
 * 詢問是否恢復自動暫存。回傳攻擊物件或 null。
 */
function askRestore(autosave) {
  const info = describeAutosave(autosave);
  return new Promise((resolve) => {
    const overlay = $('boot-overlay');
    if (!overlay) {
      resolve(null);
      return;
    }
    overlay.hidden = false;
    overlay.classList.remove('is-fading');
    overlay.dataset.error = '';
    const status = $('boot-status');
    const detail = $('boot-detail');
    if (status) status.textContent = t('app.restore.title');
    if (detail) {
      detail.hidden = false;
      detail.textContent =
        `${t('app.restore.name', { value: info.name })}\n` +
        (info.fileName ? `${t('app.restore.file', { value: info.fileName })}\n` : '') +
        `${t('app.restore.events', { value: info.count })}\n` +
        (info.when ? t('app.restore.when', { value: info.when }) : '');
    }

    const card = overlay.querySelector('.boot-card');
    if (!card) {
      resolve(null);
      return;
    }
    let actions = card.querySelector('.boot-actions');
    if (actions) actions.remove();
    actions = el('div', 'boot-actions');
    actions.style.cssText = 'display:flex;gap:8px;margin-top:14px;flex-wrap:wrap';

    const mk = (label, kind, value) => {
      const b = el('button', `btn${kind ? ` btn-${kind}` : ''}`, label);
      b.type = 'button';
      b.addEventListener('click', () => {
        actions.remove();
        resolve(value);
      });
      return b;
    };
    actions.append(
      mk(t('app.restore.accept'), 'primary', 'restore'),
      mk(t('app.restore.discard'), null, 'discard'),
    );
    if (info.fileName) actions.append(mk(t('app.restore.later'), null, 'later'));
    card.appendChild(actions);

    const hint = overlay.querySelector('.boot-hint');
    if (hint) hint.hidden = true;
  });
}

/* ---------------------------------------------------------------- 主流程 */

export async function boot() {
  setBootStatus(t('app.boot.status.init'));

  // 版面（先套用避免閃爍）
  const layout = readLayout();
  applyLayout(layout);

  // ---- store ----
  const autosave = readAutosave();
  let initialAttack = createDefaultAttack();
  let restored = false;
  let discarded = false;

  if (autosave) {
    setBootStatus(t('app.boot.status.autosave'));
    const choice = await askRestore(autosave);
    if (choice === 'restore') {
      initialAttack = autosave.attack;
      restored = true;
    } else if (choice === 'discard') {
      clearAutosave();
      discarded = true;
    }
    // 'later' → 保留暫存檔，但這次先用預設攻擊
  }

  const store = createStore(initialAttack, { fileName: restored ? autosave.fileName || null : null });
  if (restored) {
    store.markSaved(autosave.fileName || null);
    store.markClean();
  }

  // ---- 版面互動 / 分頁 ----
  setupSplitters(layout);
  setupAssetsTabs();

  setBootStatus(t('app.boot.status.assets'));

  // ---- 引擎（dynamic import，失敗不白屏） ----
  let engineMod = null;
  let engineError = null;
  try {
    engineMod = await import(new URL(ENGINE_MODULE, import.meta.url).href);
  } catch (err) {
    engineError = err;
    console.warn('[main] 引擎載入失敗：', err);
  }

  // ---- 素材 ----
  let assets = null;
  const assetsState = $('assets-state');
  const engineLoadAssets =
    engineMod && typeof engineMod.loadAssets === 'function' ? engineMod.loadAssets : null;

  // preview.js 靜態 import 了 engine/index.js，故引擎若壞掉，preview 也會失敗；
  // 這種情況我們仍照常掛載 UI，只是預覽顯示提示。
  if (engineLoadAssets) {
    try {
      setBootStatus(t('app.boot.status.assets'));
      assets = await engineLoadAssets(ASSETS_INDEX);
      if (assetsState) {
        const count = assets && assets.index && assets.index.sprites ? Object.keys(assets.index.sprites).length : 0;
        assetsState.textContent = count ? t('app.assets.count', { n: count }) : t('app.assets.empty');
        assetsState.title = `${ASSETS_INDEX}`;
      }
    } catch (err) {
      console.warn('[main] 素材索引載入失敗（將以 null 繼續）：', err);
      assets = null;
      if (assetsState) {
        assetsState.textContent = t('app.assets.failed');
        assetsState.title = errText(err);
      }
    }
  } else {
    assets = null;
    if (assetsState) {
      assetsState.textContent = engineError ? t('app.assets.engineMissing') : t('app.assets.noLoader');
      if (engineError) assetsState.title = errText(engineError);
    }
  }

  // ---- preview ----
  setBootStatus(t('app.boot.status.preview'));
  let preview = null;
  try {
    const previewMod = await import(new URL('./preview.js', import.meta.url).href);
    const createPreview = previewMod && (previewMod.createPreview || previewMod.default);
    if (typeof createPreview !== 'function') throw new Error(t('preview.previewNotReady'));
    preview = createPreview({
      canvas: $('preview-canvas'),
      viewport: $('stage-viewport'),
      stage: $('preview-stage'),
      overlay: $('editor-overlay'),
      boxShape: $('box-shape'),
      banner: $('engine-banner'),
      store,
      assets,
      onStatus: () => {
        /* 由 fileops 的 onStatus 訂閱處理 */
      },
    });
  } catch (err) {
    console.error('[main] 預覽初始化失敗：', err);
    engineError = engineError || err;
    const banner = $('engine-banner');
    if (banner) {
      const missingModule = /Failed to fetch|404|Cannot find module|Failed to load|ERR_MODULE|MIME/i.test(errText(err));
      banner.hidden = false;
      banner.innerHTML = missingModule
        ? `<h3>${escapeHtml(t('app.engine.missingTitle'))}</h3>` +
          `<p>${escapeHtml(t('app.engine.missingLine1'))}</p>` +
          `<p>${escapeHtml(t('app.engine.missingLine2'))}</p>` +
          `<p>${escapeHtml(t('app.engine.errorDetail', { msg: errText(err) }))}</p>`
        : `<h3>${escapeHtml(t('app.engine.failTitle'))}</h3>` +
          `<p>${escapeHtml(t('app.engine.failLine1'))}</p>` +
          `<p>${escapeHtml(t('app.engine.reason', { msg: errText(err) }))}</p>` +
          `<p>${escapeHtml(t('app.engine.failLine2'))}</p>`;
    }
    // 提供最小可用的 preview 替代品，讓面板與工具列不會因 undefined 崩潰
    preview = makeFallbackPreview(store);
  }

  // ---- 工具列 ----
  setBootStatus(t('app.boot.status.toolbar'));
  let toolbar = null;
  try {
    const fileops = await import(new URL('./fileops.js', import.meta.url).href);
    const mountToolbar = fileops.mountToolbar || fileops.default;
    toolbar = mountToolbar({
      store,
      preview,
      onMessage: (text, kind) => setBootLog(text, kind),
    });
  } catch (err) {
    console.error('[main] 工具列初始化失敗：', err);
  }

  // ---- 面板 ----
  setBootStatus(t('app.boot.status.panels'));
  const ctx = { store, assets, preview, engine: engineMod };
  const P = {
    timeline: t('app.panel.timeline'),
    inspector: t('app.panel.inspector'),
    assets: t('app.panel.assets'),
    bullets: t('app.panel.bulletTypes'),
  };
  const results = await Promise.all([
    mountPanel({ name: P.timeline, file: './timeline.js', container: $('timeline-body'), ctx }),
    mountPanel({ name: P.inspector, file: './inspector.js', container: $('inspector-body'), ctx }),
    mountPanel({ name: P.assets, file: './assets-panel.js', container: $('assets-browser'), ctx }),
    mountPanel({ name: P.bullets, file: './bullet-types.js', container: $('bullet-types'), ctx }),
  ]);

  const okCount = results.filter((r) => r.ok).length;
  const missing = results.filter((r) => !r.ok);
  console.info(
    `[main] 面板載入結果：${okCount}/4 成功` +
      (missing.length ? `；未載入：${missing.map((m) => m.name).join('、')}` : ''),
  );

  // ---- 收尾 ----
  if (toolbar && typeof toolbar.refresh === 'function') {
    try {
      toolbar.refresh();
    } catch (_err) {
      /* 忽略 */
    }
  }
  if (toolbar && typeof toolbar.updateDocumentTitle === 'function') {
    try {
      toolbar.updateDocumentTitle();
    } catch (_err) {
      /* 忽略 */
    }
  }

  // 通知各面板初始攻擊已就緒（面板若已掛載可忽略）
  window.__drEditor = { store, preview, assets, engine: engineMod, layout, mountPanel, results };

  if (engineError) {
    console.warn('[main] 引擎不可用，已顯示提示橫幅');
  }
  if (restored) setBootLog(t('app.restore.accepted'), 'ok');
  else if (discarded) setBootLog(t('app.restore.discarded'), 'warn');

  hideBootOverlay();

  // B19：`index.html?file=<name>` / `?sample=<name>` 自動載入。
  // 放在 boot 尾端：store/preview/toolbar 都就緒，toast 與狀態列才有效；
  // 失敗時維持目前的空白文件（openFromQuery 內部已 toast）。
  if (typeof window !== 'undefined' && window.location) {
    openFromQuery(window.location.search).catch((err) => {
      console.warn('[main] 依網址自動載入失敗：', err);
    });
  }
  return { store, preview, assets, engine: engineMod, results, engineError, toolbar };
}

function setBootLog(text, kind) {
  setToolbarMessage(text, kind);
  if (kind === 'error') console.warn('[main]', text);
}

/** 引擎／預覽不可用時的替代 preview（避免面板崩潰） */
function makeFallbackPreview(store) {
  let frame = 0;
  const subs = new Set();
  const statusSubs = new Set();
  const dur = () => {
    const s = store && store.attack && store.attack.settings;
    const d = Number(s && s.duration);
    return Number.isFinite(d) && d > 0 ? d : 8;
  };
  /** 沒有引擎時仍更新時間碼與模式晶片，讓使用者知道游標位置 */
  const paintTransport = () => {
    if (typeof document === 'undefined') return;
    const tc = document.getElementById('timecode');
    if (tc) {
      const fps = 30;
      const total = Math.round(dur() * fps);
      const fmt = (f) => {
        const v = Math.max(0, Math.round(f));
        const sec = Math.floor(v / fps);
        return `${String(sec).padStart(2, '0')}:${String(v - sec * fps).padStart(2, '0')}`;
      };
      tc.innerHTML =
        `<span class="tc-now">${fmt(frame)}</span>` +
        `<span class="tc-sep">/</span>` +
        `<span class="tc-dim">${fmt(total)}</span>`;
      tc.title = t('app.fallback.timecodeTitle', {
        now: (frame / fps).toFixed(2),
        total: dur().toFixed(2),
      });
    }
    const chip = document.getElementById('preview-mode');
    if (chip) {
      chip.textContent = t('preview.mode.noEngine');
      chip.classList.remove('is-try');
    }
  };
  const emit = (f) => {
    paintTransport();
    for (const fn of [...subs]) {
      try {
        fn(f);
      } catch (err) {
        console.warn('[preview:fallback] onFrame 回呼錯誤：', err);
      }
    }
    for (const fn of [...statusSubs]) {
      try {
        fn({ frame: f, duration: dur(), playing: false, mode: 'preview', ready: false, engineFailed: true, frameCount: Math.round(dur() * 30) });
      } catch (_err) {
        /* 忽略 */
      }
    }
  };
  return {
    fps: 30,
    seek(f) {
      frame = Math.max(0, Math.min(Math.round(dur() * 30), Math.round(Number(f) || 0)));
      emit(frame);
    },
    getFrame: () => frame,
    onFrame(fn) {
      if (typeof fn !== 'function') return () => {};
      subs.add(fn);
      return () => subs.delete(fn);
    },
    duration: dur,
    play: () => false,
    pause: () => false,
    togglePlay: () => false,
    step(delta = 1) {
      this.seek(frame + delta);
    },
    gotoStart() {
      this.seek(0);
    },
    isPlaying: () => false,
    isReady: () => false,
    enterTry: () => false,
    exitTry: () => false,
    isTrying: () => false,
    getMode: () => 'preview',
    setShowGrid() {},
    setShowHitboxes() {},
    setMuted() {},
    getOptions: () => ({ showGrid: true, showHitboxes: false, muted: false }),
    getScale: () => 1,
    getState: () => null,
    getBattle: () => null,
    onStatus(fn) {
      if (typeof fn !== 'function') return () => {};
      statusSubs.add(fn);
      return () => statusSubs.delete(fn);
    },
    getStatus: () => ({ frame, duration: dur(), playing: false, mode: 'preview', ready: false, engineFailed: true }),
    getErrors: () => new Map(),
    hasEngineError: () => true,
    reload() {},
    refresh() {},
    resize() {},
    getBoxRect: () => ({
      left: BOX_DEFAULTS.x - BOX_DEFAULTS.w / 2,
      top: BOX_DEFAULTS.y - BOX_DEFAULTS.h / 2,
      w: BOX_DEFAULTS.w,
      h: BOX_DEFAULTS.h,
    }),
    getBoxAnchor: () => ({ ax: 0.5, ay: 0.5 }),
    focusStage() {},
    destroy() {
      subs.clear();
      statusSubs.clear();
    },
  };
}

/* 自動啟動 */
if (typeof document !== 'undefined') {
  const start = () => {
    // 先套用靜態 HTML 的 data-i18n 文字（工具列／面板標題／提示），再做非同步啟動
    // （<html lang> 由 i18n.js 在載入與 setLocale 時同步，這裡不用再補）
    try {
      applyDom(document);
    } catch (err) {
      console.warn('[main] 介面語系套用失敗：', err);
    }
    setupLocaleSelect();
    onLocaleChange(() => {
      try {
        applyDom(document);
      } catch (err) {
        console.warn('[main] 介面語系套用失敗：', err);
      }
    });
    boot().catch((err) => {
      console.error('[main] 啟動失敗：', err);
      showBootError(t('app.boot.failed'), errText(err));
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}

/** 工具列語系下拉：列出 i18n.js 的 LOCALES，切換時呼叫 setLocale */
function setupLocaleSelect() {
  const select = $('opt-locale');
  if (!select || select.dataset.ready === '1') return;
  select.dataset.ready = '1';
  select.innerHTML = '';
  for (const item of LOCALES) {
    const opt = document.createElement('option');
    opt.value = item.id;
    opt.textContent = item.label;
    select.appendChild(opt);
  }
  select.value = getLocale();
  select.addEventListener('change', () => {
    setLocale(select.value);
    // setLocale 會通知 listeners；applyDom 由 onLocaleChange 處理
    select.value = getLocale();
  });
}

export default boot;

