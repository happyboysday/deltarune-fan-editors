/**
 * editor/encounter/autoplay-bar.js — 預覽工具列的「自動」開關（AP2）
 *
 * SPEC-AUTOPLAY §4：工具列上的「自動」開關（腳本 / AI / 關），狀態顯示在畫布外。
 * 這裡只做 UI 與純邏輯；實際餵輸入的是 preview.js 的 createAutopilot 接線
 * （pilot 由 engine/autoplay/index.js 提供，遭遇層再交給 encounter.js）。
 *
 * 兩層：
 *   1) 純邏輯：模式清單、查詢字串解析、狀態文字（測試可直接呼叫）
 *   2) 掛載層：mountAutoplayBar({ preview, transportEl, ctx })
 */

import { t, onLocaleChange } from '../i18n.js';
import '../locales/encounter-demo.js'; // 註冊 encauto 字串
import { el } from '../fields.js';

const T = (key, params) => t(`encauto.${key}`, params);

/** 三種模式（與 SPEC §4 的「腳本 / AI / 關」一一對應）。 */
export const AUTOPLAY_MODES = ['off', 'demo', 'bot'];

/** UI 顯示順序：關 → 腳本 → AI。 */
export const AUTOPLAY_UI_ORDER = ['off', 'demo', 'bot'];

/**
 * 正規化模式字串。
 * @returns {'off'|'demo'|'bot'}
 */
export function normalizeMode(mode) {
  if (mode === 'demo' || mode === 'bot') return mode;
  return 'off';
}

/**
 * SPEC §4：`P` 鍵切換自動演示。關 → 上次開啟的模式；開 → 關。
 * @param {'off'|'demo'|'bot'} mode 目前模式
 * @param {'off'|'demo'|'bot'} memory 上次非關的模式
 */
export function toggleAutoplayMode(mode, memory = 'demo') {
  const current = normalizeMode(mode);
  if (current !== 'off') return 'off';
  const last = normalizeMode(memory);
  return last === 'off' ? 'demo' : last;
}

/** 模式的介面字串鍵後綴（encauto.off / demo / bot）。 */
export function modeLabelKey(mode) {
  return normalizeMode(mode);
}

/** 模式顯示文字。 */
export function modeLabel(mode) {
  return T(modeLabelKey(mode));
}

/** 步驟（pilot.describe().step）→ encauto 的字串鍵；未知步驟原樣顯示。 */
export function stepLabel(step) {
  const map = { idle: 'stepIdle', menu: 'stepMenu', text: 'stepText', fight: 'stepFight', dodge: 'stepDodge' };
  const key = map[String(step)];
  return key ? T(key) : String(step ?? '');
}

/**
 * 由查詢字串解析自動模式（`?autoplay=demo|bot`；其他值 → off）。
 * @param {string} search 例如 location.search
 */
export function parseAutoplayQuery(search) {
  const raw = String(search || '');
  const q = raw.startsWith('?') ? raw.slice(1) : raw;
  if (!q) return null;
  let params = null;
  try {
    params = new URLSearchParams(q);
  } catch (_err) {
    return null;
  }
  const value = params.get('autoplay');
  if (value === null) return null;
  if (value === 'demo' || value === 'bot' || value === 'off') return value;
  return 'off';
}

/** 「自動」開關的狀態摘要文字（畫布外顯示）。 */
export function statusText({ mode, describe, warnings } = {}) {
  const m = normalizeMode(mode);
  const base = m === 'off' ? T('off') : `AUTO · ${T(modeLabelKey(m))}`;
  const d = describe && typeof describe === 'object' ? describe : null;
  const bits = [];
  if (d && d.turn !== null && d.turn !== undefined) {
    // statusDetail 不含模式（模式已在 base 顯示），避免「AUTO · 腳本 · 腳本…」重複
    bits.push(T('statusDetail', { mode: '', turn: d.turn, step: stepLabel(d.step) }));
  }
  if (warnings && warnings.length) bits.push(T('warnings', { n: warnings.length }));
  return bits.length ? `${base} · ${bits.join(' · ')}` : base;
}

/** 給 aria/title 用的完整說明。 */
export function statusTitle({ mode, describe, warnings } = {}) {
  const m = normalizeMode(mode);
  const parts = [T('title'), modeLabel(m)];
  const d = describe && typeof describe === 'object' ? describe : null;
  if (d && d.turn !== null && d.turn !== undefined) {
    parts.push(T('statusDetail', { mode: modeLabel(m), turn: d.turn, step: stepLabel(d.step) }));
  }
  if (warnings && warnings.length) parts.push(T('warnings', { n: warnings.length }));
  return parts.join('\n');
}

/* =========================================================================
 * 掛載層
 * ========================================================================= */

let mounted = null;

/**
 * 建立（或更新）工具列的「自動」開關。
 *
 * @param {object} options
 * @param {object} options.preview  createEncounterPreview() 的回傳
 * @param {HTMLElement} [options.transportEl]  #enc-transport（省略則自行找）
 * @param {HTMLElement} [options.statusHost]   狀態文字要放的容器（預設與開關同一列）
 * @param {string} [options.search]            覆寫 location.search（測試用）
 */
/** 自動開關的樣式（注入一次；不依賴任何 HTML/CSS 檔）。 */
function ensureBarStyles() {
  if (typeof document === 'undefined' || document.getElementById('enc-auto-style')) return;
  const style = document.createElement('style');
  style.id = 'enc-auto-style';
  style.textContent = `
  .auto-wrap { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; }
  .auto-label { color: var(--text-dim); font-size: 11px; white-space: nowrap; }
  .auto-select {
    height: 22px; padding: 0 4px; font: inherit; font-size: 11px;
    color: var(--text-dim); background: var(--panel-3);
    border: 1px solid var(--line); border-radius: var(--radius);
  }
  .auto-select.is-on { color: #1a1a1a; background: var(--accent); border-color: var(--accent); font-weight: 700; }
  .auto-chip {
    font-size: 10.5px; padding: 1px 7px; border-radius: 999px;
    border: 1px solid var(--line-strong); color: var(--text-faint);
    white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis;
  }
  .auto-chip.is-on { color: #101014; background: var(--accent); border-color: var(--accent); }
  #enc-auto-chip[data-mode="off"] { color: var(--text-faint); }
  .auto-status { justify-self: end; }
  `;
  document.head.appendChild(style);
}

export function mountAutoplayBar({ preview, transportEl = null, statusHost = null, search = null } = {}) {
  if (typeof document === 'undefined') return { destroy() {} };
  ensureBarStyles();
  const host = transportEl || document.getElementById('enc-transport');
  if (!host) return { destroy() {} };
  if (mounted && mounted.host === host) {
    mounted.destroy();
  }

  const wrap = el('span', { class: 'auto-wrap', id: 'enc-auto-wrap' });
  const label = el('span', { class: 'auto-label', text: T('tab') });
  const select = el('select', { class: 'auto-select', id: 'enc-auto-mode', title: T('title') });
  for (const mode of AUTOPLAY_UI_ORDER) {
    select.appendChild(el('option', { value: mode, text: modeLabel(mode) }));
  }
  wrap.append(label, select);
  // 插在模式晶片前面（附加到最後會把 #enc-preview-meta 擠出可視範圍）
  const insertAnchor = host.querySelector('#enc-mode-chip');
  const sep = insertAnchor && insertAnchor.previousElementSibling;
  if (sep && sep.classList && sep.classList.contains('tp-sep')) host.insertBefore(wrap, sep);
  else if (insertAnchor) host.insertBefore(wrap, insertAnchor);
  else host.appendChild(wrap);

  // 狀態顯示在畫布外：預覽面板標題列（若找不到就退回控制列旁的小晶片）
  let status = statusHost;
  if (!status) {
    const head = document.querySelector('#enc-preview .panel-head .panel-head-actions');
    if (head) {
      status = el('span', { class: 'mode-chip auto-status', id: 'enc-auto-chip', text: modeLabel('off') });
      const anchor = document.getElementById('enc-turn-chip');
      if (anchor) head.insertBefore(status, anchor);
      else head.appendChild(status);
      status.dataset.mode = 'off';
    }
  }
  if (!status) {
    status = el('span', { class: 'auto-chip', id: 'enc-auto-chip', text: modeLabel('off') });
    wrap.appendChild(status);
    status.dataset.mode = 'off';
  }
  const chip = status;

  let unsubscribe = null;
  let offLocale = null;
  let timer = 0;
  let lastText = '';
  let lastOnMode = 'demo';
  let keydownBound = false;

  const currentMode = () => normalizeMode(preview && typeof preview.getAutoplay === 'function' ? preview.getAutoplay().mode : 'off');
  const describe = () => {
    const info = preview && typeof preview.getAutoplay === 'function' ? preview.getAutoplay() : null;
    return info && info.describe ? info.describe : null;
  };
  const warnings = () => {
    const info = preview && typeof preview.getAutoplay === 'function' ? preview.getAutoplay() : null;
    return info && Array.isArray(info.warnings) ? info.warnings : [];
  };

  const paint = () => {
    const mode = currentMode();
    select.value = mode;
    chip.dataset.mode = mode;
    chip.classList.toggle('is-on', mode !== 'off');
    const d = describe();
    const w = warnings();
    const text = statusText({ mode, describe: d, warnings: w });
    if (text !== lastText) {
      lastText = text;
      chip.textContent = text;
    }
    const title = statusTitle({ mode, describe: d, warnings: w });
    chip.title = title;
    select.classList.toggle('is-on', mode !== 'off');
    wrap.dataset.mode = mode;
  };

  const apply = async (mode) => {
    if (!preview || typeof preview.setAutoplay !== 'function') return;
    try {
      await preview.setAutoplay(mode);
    } catch (err) {
      console.warn('[autoplay-bar] 切換自動模式失敗：', err);
    }
    paint();
  };

  select.addEventListener('change', () => apply(select.value));
  select.addEventListener('click', (ev) => ev.stopPropagation());

  const unsubscribeAll = [];
  if (preview && typeof preview.onAutoplay === 'function') {
    // 模式切換／重播時立刻更新（onStatus 不一定會發）
    unsubscribeAll.push(preview.onAutoplay(() => paint()));
  }
  if (preview && typeof preview.onStatus === 'function') {
    unsubscribeAll.push(preview.onStatus(() => paint()));
  }
  unsubscribe = () => {
    for (const fn of unsubscribeAll) {
      try {
        if (typeof fn === 'function') fn();
      } catch (_err) {
        /* 忽略 */
      }
    }
  };
  // pilot.describe() 不會每次狀態變更都發事件（例如文字自動前進時），低頻輪詢一次
  timer = setInterval(() => {
    if (mounted && mounted.destroyed) return;
    paint();
  }, 250);

  // SPEC §4：`P` 鍵切換自動演示（關 ⇄ 上次開啟的模式）、`R` 重來（會一併重置
  // pilot，維持決定性）。輸入框/彈窗有焦點時不搶鍵，避免打字時被切換。
  const onKeyDown = (ev) => {
    if (!ev || ev.defaultPrevented) return;
    if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
    const key = String(ev.key || '').toLowerCase();
    if (key !== 'p' && key !== 'r') return;
    const target = ev.target;
    const tag = target && target.tagName ? String(target.tagName).toUpperCase() : '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (target && target.isContentEditable)) return;
    if (document.getElementById('modal-root') && !document.getElementById('modal-root').hidden) return;
    const mode = currentMode();
    if (key === 'r') {
      // 只有自動演示開啟時才接管 R（平時 R 不屬於編輯器快速鍵）
      if (mode === 'off') return;
      if (!preview || typeof preview.restart !== 'function') return;
      ev.preventDefault();
      try {
        preview.restart();
      } catch (err) {
        console.warn('[autoplay-bar] 重來失敗：', err);
      }
      paint();
      return;
    }
    const next = toggleAutoplayMode(mode, lastOnMode);
    if (mode !== 'off') lastOnMode = mode;
    ev.preventDefault();
    apply(next);
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('keydown', onKeyDown);
    keydownBound = true;
  }

  offLocale =
    typeof onLocaleChange === 'function'
      ? onLocaleChange(() => {
          label.textContent = T('tab');
          select.title = T('title');
          for (const opt of Array.from(select.options)) opt.textContent = modeLabel(opt.value);
          lastText = '';
          paint();
        })
      : null;

  // 網址參數（?autoplay=demo|bot）開場就套用
  const fromQuery = parseAutoplayQuery(search !== null ? search : typeof location !== 'undefined' ? location.search : '');
  if (fromQuery && fromQuery !== 'off') {
    select.value = fromQuery;
    apply(fromQuery);
  } else {
    paint();
  }

  const api = {
    host,
    get mode() {
      return currentMode();
    },
    setMode: (mode) => apply(mode),
    refresh: () => paint(),
    destroy() {
      api.destroyed = true;
      if (typeof unsubscribe === 'function') unsubscribe();
      unsubscribe = null;
      if (offLocale) offLocale();
      if (timer) clearInterval(timer);
      if (keydownBound && typeof document !== 'undefined') {
        document.removeEventListener('keydown', onKeyDown);
        keydownBound = false;
      }
      wrap.remove();
      mounted = null;
    },
  };
  mounted = api;
  return api;
}

/** 目前掛載中的開關（測試／除錯用）。 */
export function currentAutoplayBar() {
  return mounted;
}

export default mountAutoplayBar;
