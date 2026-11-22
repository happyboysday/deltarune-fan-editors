/**
 * editor/encounter/main.js — 遭遇編輯器啟動流程（ED1 擁有）
 *
 * 順序：
 *   1. 套用介面語系（data-i18n）＋建立語系下拉
 *   2. 讀自動暫存 → 詢問是否恢復 → 建立 store（doc = 遭遇 JSON）
 *   3. loadAssets('assets/index.json')（失敗 → null）
 *   4. 建立 preview（createEncounter 實際可玩；引擎缺席則用替代畫面）
 *   5. mountToolbar（工具列＋快捷鍵＋檔案操作）
 *   6. 動態 import 並 mount 各面板：
 *        #enc-tree-body      ← ./tree.js         （ED3）
 *        #enc-inspector-body ← ./inspector.js    （ED3）
 *        #enc-actor-body     ← ./actor-editor.js （ED3）
 *        #enc-cues-body      ← ./cue-editor.js   （ED2）
 *      任一面板 import 失敗時，只在該容器顯示「模組尚未完成」，其餘照常運作。
 *
 * 面板 ctx（給 ED2/ED3，回報會寫清楚）：
 *   {
 *     store,                          // 泛化後的 createStore（store.doc = 遭遇 JSON）
 *     assets,                         // loadAssets('assets/index.json') 的結果或 null
 *     preview,                        // 遭遇預覽 API（見 preview.js 檔頭）
 *     engine,                         // engine/encounter/index.js 模組或 null
 *     encounter,                      // engine 實例（= preview.getEncounter()）或 null
 *     layout: { apply, reset, get },  // 分隔線尺寸（localStorage 記憶）
 *     i18n: { t, getLocale, onLocaleChange, applyDom },
 *     api: { listEncounters, resolveAttackRef, createDefaultEncounter, guessSelectionForPath },
 *     cuePath,                        // 便利函式：目前指令清單路徑（= store.cuePath）
 *     selectionOf: (path) => bool,    // 這個節點目前是否被選取
 *     report(message, kind),          // 工具列狀態訊息
 *   }
 */

import { createStore, readAutosave, clearAutosave, ENCOUNTER_AUTOSAVE_KEY, getAtPath, splitPath } from '../store.js';
import { t, applyDom, getLocale, setLocale, LOCALES, onLocaleChange } from '../i18n.js';
import '../locales/encounter-app.js';
import { createDefaultEncounter, loadActorPresets, resolveAttackRef, clearAttackCache } from './preview.js';
import { guessSelectionForPath } from './fileops.js';

const ENGINE_INDEX = '../../engine/encounter/index.js';
const ASSETS_INDEX = 'assets/index.json';
const LAYOUT_KEY = 'drbe.encounter.layout.v1';

const PANEL_TIMEOUT = 12000;

/* ------------------------------------------------------------------ 小工具 */

const $ = (id) => (typeof document === 'undefined' ? null : document.getElementById(id));

function errText(err) {
  if (!err) return '?';
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  try {
    return String(err);
  } catch (_e) {
    return '?';
  }
}

function setBootStatus(text) {
  const el = $('enc-boot-status');
  if (el) el.textContent = String(text == null ? '' : text);
}

function showBootError(text, detail) {
  const overlay = $('enc-boot-overlay');
  const status = $('enc-boot-status');
  const box = $('enc-boot-detail');
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
}

function hideBootOverlay() {
  const overlay = $('enc-boot-overlay');
  if (!overlay) return;
  overlay.classList.add('is-fading');
  setTimeout(() => {
    overlay.hidden = true;
    overlay.classList.remove('is-fading');
    // B12：載入完成後清空殘留的狀態文字（"Loading editor panels…" 不該留在 DOM）
    setBootStatus('');
  }, 240);
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function report(message, kind = '') {
  const elm = $('enc-toolbar-msg');
  if (elm) {
    elm.textContent = String(message == null ? '' : message);
    elm.className = `tb-msg${kind ? ` is-${kind}` : ''}`;
  }
  if (kind === 'error') console.warn('[encounter:main]', message);
}

/** 帶逾時的動態 import：面板卡住時不要拖垮整個啟動流程 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`${label} 載入逾時（${ms}ms）`));
    }, ms);
    promise.then(
      (value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(value);
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
 * 掛載一個可選面板：import 失敗或沒有 mount 時，只在容器顯示提示。
 * @returns {Promise<{name:string, ok:boolean, error?:Error, module?:any}>}
 */
async function mountPanel({ name, file, container, ctx, missingText }) {
  const host = container || null;
  const showPlaceholder = (titleKey, hintText) => {
    if (!host) return;
    host.innerHTML = '';
    const wrap = el('div', 'panel-placeholder');
    const icon = el('div', 'ph-icon', '▨');
    const strong = el('strong', null, t(titleKey));
    const hint = el('div', 'ph-hint', hintText || '');
    const code = el('code', null, file);
    wrap.append(icon, strong, hint, code);
    host.appendChild(wrap);
  };
  if (!host) return { name, ok: false, error: new Error('缺少容器') };
  let mod;
  try {
    mod = await withTimeout(import(new URL(file, import.meta.url).href), PANEL_TIMEOUT, name);
  } catch (err) {
    console.warn(`[encounter:main] 面板「${name}」載入失敗（${file}）：`, err);
    showPlaceholder(
      'encapp.panelMissing',
      t('encapp.panelMissingHint', { file }) + (errText(err) ? `（${errText(err)}）` : ''),
    );
    return { name, ok: false, error: err };
  }
  const mount = mod && (mod.mount || mod.default);
  if (typeof mount !== 'function') {
    console.warn(`[encounter:main] 面板「${name}」沒有 export mount()（${file}）`);
    showPlaceholder('encapp.panelMissing', t('encapp.panelMissingHint', { file }));
    return { name, ok: false, error: new Error('沒有 mount()'), module: mod };
  }
  try {
    const api = await mount(host, ctx);
    return { name, ok: true, module: mod, api };
  } catch (err) {
    console.error(`[encounter:main] 面板「${name}」mount 失敗（${file}）：`, err);
    showPlaceholder('encapp.panelError', `${t('encapp.panelMissingHint', { file })}：${errText(err)}`);
    return { name, ok: false, error: err, module: mod };
  }
}

/* ------------------------------------------------------------------ 版面 */

const LAYOUT_DEFAULTS = { tree: 258, inspector: 312, cues: 300 };
const LAYOUT_LIMITS = {
  tree: [180, 460],
  inspector: [220, 560],
  cues: [120, 560],
};

function clampNum(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  return Math.min(hi, Math.max(lo, n));
}

function readLayout() {
  const out = { ...LAYOUT_DEFAULTS };
  try {
    const raw = globalThis.localStorage?.getItem(LAYOUT_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') {
        for (const key of Object.keys(LAYOUT_DEFAULTS)) {
          if (data[key] !== undefined) out[key] = clampNum(data[key], LAYOUT_LIMITS[key][0], LAYOUT_LIMITS[key][1]);
        }
      }
    }
  } catch (_err) {
    /* 忽略 */
  }
  return out;
}

function writeLayout(layout) {
  try {
    globalThis.localStorage?.setItem(LAYOUT_KEY, JSON.stringify(layout));
  } catch (_err) {
    /* 忽略 */
  }
}

function applyLayout(layout) {
  const root = document.documentElement;
  if (!root) return layout;
  root.style.setProperty('--col-tree', `${layout.tree}px`);
  root.style.setProperty('--col-inspector', `${layout.inspector}px`);
  root.style.setProperty('--row-cues', `${layout.cues}px`);
  return layout;
}

/**
 * 分隔線拖曳。data-split 指出要調整哪個尺寸：
 *   tree / inspector（垂直，改寬度）、cues（水平，改高度）
 */
function setupSplitters(layout) {
  const state = { ...layout };
  const splitters = document.querySelectorAll('#enc-app .splitter[data-split]');
  for (const node of splitters) {
    const which = node.dataset.split;
    const vertical = which !== 'cues';

    const apply = () => {
      applyLayout(state);
    };

    const onPointerDown = (ev) => {
      if (ev.button !== undefined && ev.button !== 0) return;
      ev.preventDefault();
      const startPos = vertical ? ev.clientX : ev.clientY;
      const startValue = state[which];
      node.classList.add('is-dragging');
      document.body.classList.add(vertical ? 'dragging-col' : 'dragging-row');
      if (node.setPointerCapture) {
        try {
          node.setPointerCapture(ev.pointerId);
        } catch (_err) {
          /* 忽略 */
        }
      }

      const onMove = (moveEv) => {
        const delta = (vertical ? moveEv.clientX : moveEv.clientY) - startPos;
        const dir = which === 'inspector' || which === 'cues' ? -1 : 1;
        const [lo, hi] = LAYOUT_LIMITS[which];
        state[which] = clampNum(startValue + delta * dir, lo, hi);
        apply();
      };

      const onUp = () => {
        node.classList.remove('is-dragging');
        document.body.classList.remove('dragging-col', 'dragging-row');
        window.removeEventListener('pointermove', onMove, true);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        writeLayout(state);
      };

      window.addEventListener('pointermove', onMove, true);
      window.addEventListener('pointerup', onUp, true);
      window.addEventListener('pointercancel', onUp, true);
    };

    const onDoubleClick = () => {
      state[which] = LAYOUT_DEFAULTS[which];
      apply();
      writeLayout(state);
    };

    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('dblclick', onDoubleClick);
  }
  return state;
}

/** 右側檢查器分頁（檢查器 / 演員） */
function setupInspectorTabs() {
  const tabs = Array.from(document.querySelectorAll('#enc-inspector .panel-tab'));
  const panes = Array.from(document.querySelectorAll('#enc-inspector .pane'));
  let currentTab = tabs.length ? tabs[0].dataset.tab || null : null;

  const activate = (target) => {
    if (!target) return false;
    const found = tabs.find((tab) => tab.dataset.tab === target);
    if (!found) return false;
    for (const other of tabs) {
      const active = other === found;
      other.classList.toggle('is-active', active);
      other.setAttribute('aria-selected', active ? 'true' : 'false');
    }
    for (const pane of panes) pane.hidden = pane.dataset.pane !== target;
    currentTab = target;
    return true;
  };

  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      activate(tab.dataset.tab);
    });
  }

  return {
    activate,
    tabs,
    panes,
    get currentTab() {
      return currentTab;
    },
  };
}

/* ------------------------------------------------------------- 自動暫存 */

function describeAutosave(info) {
  const doc = info && info.doc ? info.doc : {};
  const name = (doc.meta && doc.meta.name) || t('encapp.untitled');
  const turnCount = Array.isArray(doc.turns) ? doc.turns.length : 0;
  let when = '';
  try {
    when = new Date(info.savedAt).toLocaleString(getLocale() === 'en' ? 'en-US' : 'zh-TW', { hour12: false });
  } catch (_err) {
    when = '—';
  }
  return t('encapp.restore.body', { name, turns: turnCount, time: when });
}

/**
 * 在啟動遮罩上詢問是否恢復自動暫存。
 * @returns {Promise<'restore'|'discard'|'later'>}
 */
function askRestore(info) {
  return new Promise((resolve) => {
    const overlay = $('enc-boot-overlay');
    const card = overlay ? overlay.querySelector('.boot-card') : null;
    if (!card) {
      resolve('later');
      return;
    }
    setBootStatus(t('encapp.restore.title'));
    const detail = $('enc-boot-detail');
    if (detail) {
      detail.hidden = false;
      detail.textContent = describeAutosave(info);
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
      mk(t('encapp.restore.accept'), 'primary', 'restore'),
      mk(t('encapp.restore.discard'), null, 'discard'),
    );
    if (info.fileName) actions.append(mk(t('encapp.restore.later'), null, 'later'));
    card.appendChild(actions);

    const hint = overlay.querySelector('.boot-hint');
    if (hint) hint.hidden = true;
  });
}

/* --------------------------------------------------------------- 語系下拉 */

function setupLocaleSelect() {
  const select = $('enc-opt-locale');
  if (!select) return;
  select.innerHTML = '';
  for (const loc of LOCALES) {
    const opt = el('option', null, loc.label);
    opt.value = loc.id;
    select.appendChild(opt);
  }
  select.value = getLocale();
  select.addEventListener('change', () => {
    setLocale(select.value);
    applyDom(document);
  });
}

/* ------------------------------------------------------------ 選取輔助 */

/** 這個路徑目前是否被選取（含子節點） */
function selectionCovers(path, selection) {
  const sel = selection || {};
  if (!sel.path || !path) return false;
  if (sel.path === path) return true;
  return path.startsWith(`${sel.path}.`) || path.startsWith(`${sel.path}[`);
}

/* ------------------------------------------------------------------ 主流程 */

export async function boot() {
  setBootStatus(t('encapp.boot.status.init'));

  const layout = applyLayout(readLayout());
  setupSplitters(layout);
  const inspectorTabs = setupInspectorTabs();

  // ---- 自動暫存 ----
  const autosave = readAutosave(null, ENCOUNTER_AUTOSAVE_KEY);
  let initialDoc = null;
  let actorPresets = null;
  let restored = false;
  let discarded = false;
  if (autosave) {
    setBootStatus(t('encapp.boot.status.autosave'));
    const choice = await askRestore(autosave);
    if (choice === 'restore') {
      initialDoc = autosave.doc;
      restored = true;
    } else if (choice === 'discard') {
      clearAutosave(null, ENCOUNTER_AUTOSAVE_KEY);
      discarded = true;
    }
  }
  if (!initialDoc) {
    // A3 的 actor-presets.json：有 layouts 就用三人隊伍當新檔範本
    setBootStatus(t('encapp.boot.status.template'));
    actorPresets = await loadActorPresets();
    initialDoc = createDefaultEncounter(actorPresets);
  }

  const store = createStore(initialDoc, {
    fileName: restored ? autosave.fileName || null : null,
    autosaveKey: ENCOUNTER_AUTOSAVE_KEY,
    initialSelection: { kind: 'settings', id: null, path: 'settings' },
  });
  if (restored) {
    store.markSaved(autosave.fileName || null);
    store.markClean();
  }

  // ---- 引擎（dynamic import，失敗不白屏） ----
  setBootStatus(t('encapp.boot.status.engine'));
  let engineMod = null;
  let engineError = null;
  try {
    engineMod = await import(new URL(ENGINE_INDEX, import.meta.url).href);
  } catch (err) {
    engineError = err;
    console.warn('[encounter:main] 遭遇引擎載入失敗：', err);
  }

  // ---- 素材 ----
  setBootStatus(t('encapp.boot.status.assets'));
  let assets = null;
  const assetsState = $('enc-assets-state');
  // 遭遇引擎不一定 re-export loadAssets；依序退回 Phase 1 的 engine/index.js、engine/assets.js。
  let loadAssets = engineMod && typeof engineMod.loadAssets === 'function' ? engineMod.loadAssets : null;
  if (!loadAssets) {
    try {
      const assetMod = await import(new URL('../../engine/assets.js', import.meta.url).href);
      if (assetMod && typeof assetMod.loadAssets === 'function') loadAssets = assetMod.loadAssets;
    } catch (_err) {
      /* 引擎尚未提供素材載入 → 以下會顯示對應狀態 */
    }
  }
  if (loadAssets) {
    try {
      assets = await loadAssets(ASSETS_INDEX);
      if (assetsState) {
        const count = assets && assets.index && assets.index.sprites ? Object.keys(assets.index.sprites).length : 0;
        assetsState.textContent = count ? t('encapp.assets.count', { n: count }) : t('encapp.assets.empty');
      }
    } catch (err) {
      console.warn('[encounter:main] 素材索引載入失敗（以 null 繼續）：', err);
      assets = null;
      if (assetsState) assetsState.textContent = t('encapp.assets.failed');
    }
  } else if (assetsState) {
    assetsState.textContent = engineError ? t('encapp.assets.engineMissing') : t('encapp.assets.noLoader');
  }

  // ---- 預覽 ----
  setBootStatus(t('encapp.boot.status.preview'));
  let preview = null;
  try {
    const previewMod = await import(new URL('./preview.js', import.meta.url).href);
    const createPreview = previewMod.createEncounterPreview || previewMod.default;
    if (typeof createPreview !== 'function') throw new Error('preview.js 沒有 createEncounterPreview');
    preview = createPreview({
      canvas: $('enc-canvas'),
      viewport: $('enc-viewport'),
      stage: $('enc-stage'),
      actorLayer: $('enc-actor-layer'),
      banner: $('enc-banner'),
      debugEl: $('enc-debug'),
      store,
      assets,
    });
    await preview.init();
  } catch (err) {
    console.error('[encounter:main] 預覽初始化失敗：', err);
    const banner = $('enc-banner');
    if (banner) {
      banner.hidden = false;
      banner.dataset.kind = 'error';
      banner.innerHTML =
        `<h3>${escapeText(t('encapp.engine.failTitle'))}</h3>` +
        `<p>${escapeText(t('encapp.engine.reason', { msg: errText(err) }))}</p>`;
    }
    preview = makeFallbackPreview(store);
  }

  // ---- 工具列 ----
  setBootStatus(t('encapp.boot.status.toolbar'));
  let toolbar = null;
  try {
    const fileops = await import(new URL('./fileops.js', import.meta.url).href);
    const mountToolbar = fileops.mountToolbar || fileops.default;
    toolbar = mountToolbar({
      store,
      preview,
      onMessage: (text, kind) => report(text, kind),
    });
  } catch (err) {
    console.error('[encounter:main] 工具列初始化失敗：', err);
    report(t('encapp.boot.failed'), 'error');
  }

  // ---- 面板 ----
  setBootStatus(t('encapp.boot.status.panels'));
  const layoutApi = {
    apply: (patch) => applyLayout({ ...layout, ...(patch || {}) }),
    reset: () => {
      const def = { ...LAYOUT_DEFAULTS };
      applyLayout(def);
      writeLayout(def);
      return def;
    },
    get: () => ({ ...readLayout() }),
  };

  const apiGetActors = () => (preview && typeof preview.getActors === 'function' ? preview.getActors() : []);
  const apiGetAttacks = () => (preview && typeof preview.getAttacks === 'function' ? preview.getAttacks() : []);

  const ctx = {
    store,
    assets,
    preview,
    engine: engineMod,
    encounter: preview && typeof preview.getEncounter === 'function' ? preview.getEncounter() : null,
    layout: layoutApi,
    i18n: { t, getLocale, onLocaleChange, applyDom, LOCALES },
    // 面板（ED2 cue-editor / ED3 inspector）直接讀 ctx.getActors() / getAttacks()
    getActors: apiGetActors,
    getAttacks: apiGetAttacks,
    inspector: {
      activate: (pane) => inspectorTabs.activate(pane),
      get current() {
        return inspectorTabs.currentTab;
      },
    },
    api: {
      listEncounters: (fileopsMod) => fileopsMod,
      resolveAttackRef,
      clearAttackCache,
      loadActorPresets,
      actorPresets,
      createDefaultEncounter: (presets) => createDefaultEncounter(presets || actorPresets),
      guessSelectionForPath,
      getCuePath: () => store.cuePath,
      setCuePath: (path) => store.setCuePath(path),
      getAtPath: (path) => getAtPath(store.doc, path),
      splitPath,
      getActors: apiGetActors,
      getAttacks: apiGetAttacks,
      refreshAttacks: () => (preview && typeof preview.refreshAttacks === 'function' ? preview.refreshAttacks() : Promise.resolve([])),
      startActorDrag: (actorId) => (preview && typeof preview.startActorDrag === 'function' ? preview.startActorDrag(actorId) : false),
      showInspectorTab: (pane) => inspectorTabs.activate(pane),
    },
    get cuePath() {
      return store.cuePath;
    },
    selectionOf: (path) => selectionCovers(path, store.selection),
    report,
    // 面板（結構樹）共用工具列的對話框／提示，避免各面板自己長一套 UI
    confirmDialog: toolbar && typeof toolbar.confirmDialog === 'function' ? toolbar.confirmDialog : null,
    toast: toolbar && typeof toolbar.toast === 'function' ? toolbar.toast : null,
  };

  const P = {
    tree: t('encapp.panel.tree'),
    inspector: t('encapp.panel.inspector'),
    actor: t('encapp.panel.actor'),
    cues: t('encapp.panel.cues'),
  };

  const results = await Promise.all([
    mountPanel({ name: P.tree, file: './tree.js', container: $('enc-tree-body'), ctx }),
    mountPanel({ name: P.inspector, file: './inspector.js', container: $('enc-inspector-body'), ctx }),
    mountPanel({ name: P.actor, file: './actor-editor.js', container: $('enc-actor-body'), ctx }),
    mountPanel({ name: P.cues, file: './cue-editor.js', container: $('enc-cues-body'), ctx }),
  ]);

  // ---- 演示面板（AP2）：掛在「指令清單」面板旁邊的分頁 ----
  let demoPanel = null;
  let autoplayBar = null;
  let timelinePanel = null;
  let packToolbar = null;
  try {
    const demoMod = await import(new URL('./demo-panel.js', import.meta.url).href);
    const cuesPanelEl = $('enc-cues');
    if (cuesPanelEl && typeof demoMod.mountDemoTab === 'function') {
      demoPanel = demoMod.mountDemoTab({ panelEl: cuesPanelEl, ctx });
    }
    // ---- 時間軸總覽（V2-07）：共用同一個分頁列（需在 demo 分頁之後） ----
    try {
      const timelineMod = await import(new URL('./timeline.js', import.meta.url).href);
      if (cuesPanelEl && demoPanel && typeof timelineMod.mountTimelineTab === 'function') {
        timelinePanel = timelineMod.mountTimelineTab({ panelEl: cuesPanelEl, ctx });
      }
    } catch (err) {
      console.warn('[encounter] 時間軸面板掛載失敗（不影響其他功能）：', err);
    }
    const barMod = await import(new URL('./autoplay-bar.js', import.meta.url).href);
    if (preview && typeof barMod.mountAutoplayBar === 'function') {
      autoplayBar = barMod.mountAutoplayBar({ preview });
      // 網址 ?autoplay=demo|bot 開場就套用（SPEC §4）
      const fromQuery = barMod.parseAutoplayQuery(typeof location !== 'undefined' ? location.search : '');
      if (fromQuery && fromQuery !== 'off') {
        try {
          await preview.setAutoplay(fromQuery);
        } catch (_err) {
          /* 已由開關自行回報 */
        }
      }
    }
  } catch (err) {
    console.warn('[encounter:main] 演示面板載入失敗：', err);
  }

  // ---- 作品包匯出／匯入＋可遊玩輸出（V2-07）：工具列按鈕 ----
  try {
    const packMod = await import(new URL('./pack-toolbar.js', import.meta.url).href);
    if (typeof packMod.mountPackToolbar === 'function') {
      packToolbar = await packMod.mountPackToolbar({ ctx });
    }
  } catch (err) {
    console.warn('[encounter:main] 作品包工具列載入失敗：', err);
  }

  // 選到演員節點 → 自動切到「演員」分頁（ED3 的演員編輯器）；選到其他東西時切回檢查器
  const unsubscribeSelectionTab = store.subscribe((_s, change) => {
    const sel = change && change.selection;
    if (!sel || !sel.kind) return;
    try {
      if (sel.kind === 'actor') inspectorTabs.activate('pane-actor');
      else if (inspectorTabs.currentTab === 'pane-actor') inspectorTabs.activate('pane-inspector');
    } catch (_err) {
      /* 忽略 */
    }
  });

  const okCount = results.filter((r) => r.ok).length;
  const missing = results.filter((r) => !r.ok);
  console.info(
    `[encounter:main] 面板載入結果：${okCount}/4 成功` +
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
  if (preview && typeof preview.refreshDebug === 'function' && preview.isDebugVisible && preview.isDebugVisible()) {
    try {
      preview.refreshDebug();
    } catch (_err) {
      /* 忽略 */
    }
  }

  window.__drEncounterEditor = {
    store,
    preview,
    assets,
    engine: engineMod,
    layout,
    ctx,
    results,
    toolbar,
    inspectorTabs,
    unsubscribeSelectionTab,
    demoPanel,
    autoplayBar,
    timelinePanel,
    packToolbar,
  };

  if (restored) report(t('encapp.restore.accepted'), 'ok');
  else if (discarded) report(t('encapp.restore.discarded'), 'warn');

  hideBootOverlay();
  return { store, preview, assets, engine: engineMod, results, engineError, toolbar, ctx, layout, demoPanel, autoplayBar, timelinePanel, packToolbar };
}

function escapeText(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 預覽完全不可用時的替代品（避免工具列與面板崩潰）。
 * 只提供最小介面；正式預覽由 ./preview.js 提供。
 */
function makeFallbackPreview(store) {
  let frame = 0;
  const subs = new Set();
  const statusSubs = new Set();
  const turnCount = () => {
    const doc = store && store.doc;
    return doc && Array.isArray(doc.turns) ? Math.max(1, doc.turns.length) : 1;
  };
  const paint = () => {
    if (typeof document === 'undefined') return;
    const tc = $('enc-timecode');
    if (tc) tc.textContent = `${String(Math.floor(frame / 30)).padStart(2, '0')}:${String(frame % 30).padStart(2, '0')}`;
    const chip = $('enc-mode-chip');
    if (chip) chip.textContent = t('encpreview.modeNoEngine');
  };
  const emit = () => {
    paint();
    for (const fn of [...subs]) {
      try {
        fn(frame);
      } catch (_err) {
        /* 忽略 */
      }
    }
    for (const fn of [...statusSubs]) {
      try {
        fn({ ready: false, engineReady: false, engineFailed: true, usingFallback: true, playing: false, frame });
      } catch (_err) {
        /* 忽略 */
      }
    }
  };
  return {
    ready: false,
    engineReady: false,
    engineFailed: true,
    usingFallback: true,
    getEncounter: () => null,
    play: () => false,
    pause: () => false,
    togglePlay: () => false,
    isPlaying: () => false,
    restart: () => {
      frame = 0;
      emit();
      return true;
    },
    gotoStart: () => {
      frame = 0;
      emit();
    },
    step: (d = 1) => {
      frame = Math.max(0, frame + Math.round(Number(d) || 0));
      emit();
    },
    seek: (f) => {
      frame = Math.max(0, Math.round(Number(f) || 0));
      emit();
    },
    getFrame: () => frame,
    getPhase: () => 'intro',
    getTurn: () => 0,
    getTurnCount: turnCount,
    getState: () => ({ frame, phase: 'intro', turn: 0, actors: [], party: [], enemies: [], fallback: true }),
    jumpToTurn: () => false,
    runCues: () => false,
    runSelectedCues: () => ({ ok: false, count: 0, cues: null, reason: t('encpreview.runCuesNone') }),
    setOptions: () => ({}),
    getOptions: () => ({ showHitboxes: false, showGrid: true, muted: false }),
    setBattleLang: () => 'zh',
    getBattleLang: () => 'zh',
    followLocaleBattleLang: () => 'zh',
    isBattleLangManual: () => false,
    setDebugVisible: () => false,
    isDebugVisible: () => false,
    refreshDebug: () => {},
    phaseLabel: (p) => t(`encpreview.phase.${p || 'unknown'}`),
    resize: () => {},
    refresh: () => {},
    getScale: () => 1,
    getErrors: () => new Map(),
    getValidationErrors: () => new Map(),
    getEngineErrors: () => new Map(),
    hasEngineError: () => false,
    onFrame(fn) {
      if (typeof fn !== 'function') return () => {};
      subs.add(fn);
      return () => subs.delete(fn);
    },
    onStatus(fn) {
      if (typeof fn !== 'function') return () => {};
      statusSubs.add(fn);
      return () => statusSubs.delete(fn);
    },
    onPhase: () => () => {},
    onError: () => () => {},
    getStatus: () => ({ ready: false, frame }),
    init: async () => true,
    destroy: () => {
      subs.clear();
      statusSubs.clear();
    },
  };
}

/* --------------------------------------------------------------- 自動啟動 */

if (typeof document !== 'undefined') {
  const start = () => {
    try {
      applyDom(document);
    } catch (err) {
      console.warn('[encounter:main] 介面語系套用失敗：', err);
    }
    setupLocaleSelect();
    onLocaleChange(() => {
      try {
        applyDom(document);
      } catch (err) {
        console.warn('[encounter:main] 介面語系套用失敗：', err);
      }
    });
    boot().catch((err) => {
      console.error('[encounter:main] 啟動失敗：', err);
      showBootError(t('encapp.boot.failed'), errText(err));
    });
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
}
