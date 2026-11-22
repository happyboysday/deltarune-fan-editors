// editor/encounter/pack-toolbar.js  (V2-07)
//
// 遭遇編輯器工具列：「作品包（匯出／匯入）」與「可遊玩 HTML 輸出」。
//
//   * 作品包走 serve.py 的 POST /api/pack/export 與 POST /api/pack/import?mode=...，
//     回應由 tools/pack.mjs 產生（作品包格式只有一份實作）。
//   * 匯入前先讓使用者選擇同名衝突策略（abort / rename / overwrite），
//     再把原檔內容 POST 給伺服器。
//   * 可遊玩輸出直接掛 tools/web/export-button.js 的 mountExportButton（kind=encounter）；
//     按鈕本身由 export-button 管理下載與狀態。
//   * 工具列寬度有限，作品包匯出／匯入收在同一顆「作品包 ▾」選單裡。
//
// 純資料函式集中在檔案前段，node:test 直接測（不碰 DOM）。

import { t, registerStrings, onLocaleChange, getLocale } from '../i18n.js';
import {
  mountExportButton,
  filenameFromDisposition,
  downloadBlob,
  errorMessageFromPayload,
} from '../../tools/web/export-button.js';
import STRINGS from '../locales/encounter-pack.js';

registerStrings('encPack', STRINGS);

const T = (key, params) => t(`encPack.${key}`, params);

/* =========================================================================
 * 1. 純資料
 * ========================================================================= */

/** 合法的匯入衝突策略（順序即 UI 按鈕順序）。 */
export const IMPORT_MODES = ['abort', 'rename', 'overwrite'];

export const PACK_EXPORT_ENDPOINT = '/api/pack/export';
export const PACK_IMPORT_ENDPOINT = '/api/pack/import';

/** 從 store.fileName（例如 "rudinn.json"）取出作品名（不含副檔名與路徑）。 */
export function packNameFromFileName(fileName) {
  if (typeof fileName !== 'string') return '';
  const base = fileName.split(/[\\/]/).pop() || '';
  return base.replace(/\.json$/i, '').trim();
}

/** 任何輸入都退回合法策略（預設 abort，與伺服器預設一致）。 */
export function importMode(value) {
  return IMPORT_MODES.includes(value) ? value : 'abort';
}

/** 匯入端點（mode 放在 query string）。 */
export function buildImportUrl(mode, base = PACK_IMPORT_ENDPOINT) {
  return `${base}?mode=${importMode(mode)}`;
}

/** 作品包匯出請求內容；名稱為空回傳 null（呼叫端負責提示先儲存）。 */
export function buildPackExportBody(name, kind = 'encounter') {
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed) return null;
  return { kind, name: trimmed };
}

/** 作品包下載檔名：優先用 Content-Disposition，退回 "<name>.drpack.json"。 */
export function packDownloadName(disposition, name) {
  const fallback = `${(typeof name === 'string' && name.trim()) || 'encounter'}.drpack.json`;
  return filenameFromDisposition(disposition, fallback);
}

function listCount(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return 0;
}

/** 匯入結果的數量摘要（遭遇／攻擊／素材）。 */
export function importCounts(imported) {
  const info = imported && typeof imported === 'object' ? imported : {};
  return {
    encounters: listCount(info.encounters),
    attacks: listCount(info.attacks),
    assets: listCount(info.sprites) + listCount(info.audio),
  };
}

/** 匯入結果中被重新命名的項目數（同名衝突採 rename 時 > 0）。 */
export function importRenamedCount(payload) {
  const imported = payload && typeof payload === 'object' ? payload.imported : null;
  const info = imported && typeof imported === 'object' ? imported : {};
  const named = ['encounters', 'attacks', 'sprites', 'audio'];
  let count = 0;
  for (const key of named) {
    const list = info[key];
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      if (entry && typeof entry === 'object' && entry.renamedFrom) count += 1;
    }
  }
  if (payload && typeof payload === 'object' && typeof payload.renamed === 'number' && payload.renamed > 0) {
    count = Math.max(count, payload.renamed);
  }
  return count;
}

/**
 * 解析 POST /api/pack/import 的回應。
 * @returns {{ok:boolean, code:string, message:string, conflicts:Array, imported:object|null, counts:object, renamed:number}}
 */
export function parseImportResponse(status, payload) {
  const result = {
    ok: false,
    code: 'error',
    message: '',
    conflicts: [],
    imported: null,
    counts: { encounters: 0, attacks: 0, assets: 0 },
    renamed: 0,
  };
  if (!payload || typeof payload !== 'object') {
    result.message = `HTTP ${status}`;
    return result;
  }
  const code = typeof payload.code === 'string' ? payload.code : '';
  if (status >= 200 && status < 300 && payload.ok !== false) {
    result.ok = true;
    result.code = 'ok';
    result.imported = payload.imported && typeof payload.imported === 'object' ? payload.imported : {};
    result.counts = importCounts(result.imported);
    result.renamed = importRenamedCount(payload);
    return result;
  }
  result.code = code || (status === 409 ? 'conflicts' : 'error');
  if (Array.isArray(payload.conflicts)) result.conflicts = payload.conflicts;
  result.message = errorMessageFromPayload(payload, status);
  return result;
}

/* =========================================================================
 * 2. 掛載
 * ========================================================================= */

function makeButton(id, label, title) {
  const button = document.createElement('button');
  button.type = 'button';
  button.id = id;
  button.className = 'tb-btn has-menu enc-pack-btn';
  button.textContent = label;
  button.title = title;
  button.setAttribute('aria-haspopup', 'true');
  button.setAttribute('aria-expanded', 'false');
  return button;
}

/**
 * 把作品包選單／可遊玩輸出掛進工具列（放在「範例」群組後面）。
 * @param {{ctx: object}} options
 * @returns {Promise<{group: HTMLElement, buttons: object, playable: object|null, refresh: Function, destroy: Function}>}
 */
export async function mountPackToolbar(options = {}) {
  const ctx = options.ctx || {};
  const store = ctx.store || null;
  const fileops = await import(new URL('./fileops.js', import.meta.url).href);

  const anchor = document.getElementById('enc-btn-samples');
  const toolbar = anchor ? anchor.closest('#enc-toolbar') : document.getElementById('enc-toolbar');
  if (!anchor || !anchor.parentElement) {
    console.warn('[encpack] 找不到範例按鈕，略過作品包工具列');
    return { group: null, buttons: {}, playable: null, refresh: () => {}, destroy: () => {} };
  }

  const group = document.createElement('div');
  group.className = 'tb-group enc-toolbar-pack';
  group.setAttribute('role', 'group');
  group.setAttribute('aria-label', T('packGroup'));

  const menuBtn = makeButton('enc-btn-pack-menu', T('packMenu'), T('packMenuTitle'));

  const playableWrap = document.createElement('span');
  playableWrap.className = 'enc-pack-playable';

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,.drpack.json,application/json';
  fileInput.className = 'enc-pack-file';
  fileInput.setAttribute('aria-label', T('filePicker'));

  group.append(menuBtn, playableWrap, fileInput);
  anchor.parentElement.after(group);

  let playable = null;
  let busy = false;
  let destroyed = false;

  const notify = (message, kind = '') => {
    if (typeof ctx.toast === 'function') {
      ctx.toast(message, kind);
      return;
    }
    void fileops.toast(message, kind);
  };

  function currentName() {
    return packNameFromFileName(store && store.fileName);
  }

  function savedName() {
    const name = currentName();
    if (name && !store.isDirty()) return name;
    notify(T('saveFirst'), 'error');
    return '';
  }

  function setBusy(next) {
    busy = next;
    menuBtn.disabled = next;
  }

  /* ---------------- 作品包匯出 ---------------- */

  async function exportPack() {
    if (busy || destroyed) return null;
    const name = savedName();
    if (!name) return null;
    const body = buildPackExportBody(name);
    setBusy(true);
    try {
      const response = await fetch(PACK_EXPORT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response || !response.ok) {
        let payload = null;
        try {
          payload = await response.json();
        } catch (_err) {
          /* 非 JSON 錯誤內容 */
        }
        notify(T('packExportFailed', { error: errorMessageFromPayload(payload, response ? response.status : 0) }), 'error');
        return null;
      }
      const blob = await response.blob();
      const disposition = response.headers && typeof response.headers.get === 'function'
        ? response.headers.get('Content-Disposition')
        : '';
      const filename = packDownloadName(disposition, name);
      downloadBlob(blob, filename, {});
      notify(T('packExported', { name: filename }));
      return { blob, filename };
    } catch (err) {
      notify(T('packExportFailed', { error: err && err.message ? err.message : String(err) }), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- 作品包匯入 ---------------- */

  async function chooseImportMode(fileName) {
    const body = document.createElement('div');
    body.className = 'enc-pack-import-body';
    const intro = document.createElement('p');
    intro.className = 'enc-pack-import-intro';
    intro.textContent = T('importIntro', { file: fileName || '' });
    body.appendChild(intro);

    const value = await fileops.openModal({
      title: T('importTitle'),
      body,
      buttons: [
        { label: T('importCancel'), value: null },
        { label: T('importModeAbort'), value: 'abort' },
        { label: T('importModeOverwrite'), value: 'overwrite', kind: 'danger' },
        { label: T('importModeRename'), value: 'rename', kind: 'primary' },
      ],
    });
    return value === 'abort' || value === 'overwrite' || value === 'rename' ? value : null;
  }

  async function importPackFile(file) {
    if (busy || destroyed || !file) return null;
    let text = '';
    try {
      text = await file.text();
    } catch (err) {
      notify(T('readFailed', { error: err && err.message ? err.message : String(err) }), 'error');
      return null;
    }
    if (!text || !text.trim()) {
      notify(T('emptyPackFile'), 'error');
      return null;
    }
    try {
      JSON.parse(text);
    } catch (err) {
      notify(T('badPackJson', { error: err && err.message ? err.message : String(err) }), 'error');
      return null;
    }

    const mode = await chooseImportMode(file.name);
    if (!mode || destroyed) return null;

    setBusy(true);
    try {
      const response = await fetch(buildImportUrl(mode), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: text,
      });
      let payload = null;
      try {
        payload = await response.json();
      } catch (_err) {
        /* 非 JSON 錯誤內容 */
      }
      const result = parseImportResponse(response ? response.status : 0, payload);
      if (!result.ok) {
        if (result.code === 'conflicts') {
          notify(T('importConflicts', { n: result.conflicts.length || 0 }), 'error');
        } else {
          notify(T('importFailed', { error: result.message }), 'error');
        }
        return null;
      }
      const params = {
        encounters: result.counts.encounters,
        attacks: result.counts.attacks,
        assets: result.counts.assets,
        renamed: result.renamed,
      };
      notify(result.renamed > 0 ? T('importDoneRenamed', params) : T('importDone', params));
      if (ctx.api && typeof ctx.api.refreshAttacks === 'function') {
        try {
          await ctx.api.refreshAttacks();
        } catch (_err) {
          /* 重新整理攻擊清單失敗不影響匯入結果 */
        }
      }
      return result;
    } catch (err) {
      notify(T('importFailed', { error: err && err.message ? err.message : String(err) }), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  }

  const onFileChange = () => {
    const file = fileInput.files && fileInput.files[0];
    fileInput.value = '';
    void importPackFile(file);
  };
  fileInput.addEventListener('change', onFileChange);

  /* ---------------- 可遊玩輸出 ---------------- */

  function mountPlayable() {
    if (playable && typeof playable.destroy === 'function') playable.destroy();
    playableWrap.textContent = '';
    playable = mountExportButton({
      container: playableWrap,
      getTarget: () => ({ name: currentName(), kind: 'encounter' }),
      lang: getLocale() === 'en' ? 'en' : 'zh',
      fetchImpl: typeof fetch === 'function' ? fetch : null,
    });
    playable.button.title = T('playableTip');
    if (playable.group) playable.group.setAttribute('aria-label', T('playableGroup'));
    return playable;
  }

  // 共用匯出按鈕可能被直接點擊，也必須擋住未儲存的內容。
  const onPlayableClickCapture = (event) => {
    if (savedName()) return;
    event.preventDefault();
    event.stopPropagation();
  };
  playableWrap.addEventListener('click', onPlayableClickCapture, true);

  /* ---------------- 作品包選單 ---------------- */

  function menuItems() {
    return [
      { label: T('packExport'), sub: T('packExportSub'), title: T('packExportTip'), onClick: () => void exportPack() },
      { label: T('packImport'), sub: T('packImportSub'), title: T('packImportTip'), onClick: () => fileInput.click() },
      { sep: true },
      { label: T('playableGroup'), sub: T('playableSub'), title: T('playableTip'), onClick: () => togglePlayableExport() },
    ];
  }

  function openPackMenu() {
    if (busy || destroyed) return;
    fileops.openMenu(menuBtn, menuItems());
    menuBtn.setAttribute('aria-expanded', 'true');
    const close = () => {
      menuBtn.setAttribute('aria-expanded', 'false');
      if (typeof document !== 'undefined') document.removeEventListener('click', onDocClick, true);
    };
    const onDocClick = (event) => {
      if (event.target === menuBtn) return;
      if (event.target && typeof event.target.closest === 'function' && event.target.closest('#menu-root')) return;
      close();
    };
    if (typeof document !== 'undefined') {
      document.addEventListener('click', onDocClick, true);
      document.addEventListener('keydown', close, { once: true });
    }
  }

  /** 可遊玩輸出：由 export-button 真正下載；選單只負責觸發與提示。 */
  async function togglePlayableExport() {
    if (busy || destroyed) return null;
    if (!savedName()) return null;
    if (!playable) mountPlayable();
    const result = await playable.exportNow();
    if (result && result.filename) notify(T('playableExported', { name: result.filename }));
    return result;
  }

  const onMenuClick = () => {
    if (!busy && !destroyed) openPackMenu();
  };
  menuBtn.addEventListener('click', onMenuClick);

  /* ---------------- 語系 ---------------- */

  /** 語系變更時更新已掛好的可遊玩按鈕（V2-FIX1）：有 setLang 就地換文字，否則重建。 */
  function localizePlayable() {
    if (!playable) return;
    if (typeof playable.setLang === 'function') {
      playable.setLang(getLocale() === 'en' ? 'en' : 'zh');
      playable.button.title = T('playableTip');
      if (playable.group) playable.group.setAttribute('aria-label', T('playableGroup'));
      return;
    }
    mountPlayable();
  }

  function refreshLabels() {
    group.setAttribute('aria-label', T('packGroup'));
    menuBtn.textContent = T('packMenu');
    menuBtn.title = T('packMenuTitle');
    fileInput.setAttribute('aria-label', T('filePicker'));
    localizePlayable();
  }

  let unsubLocale = null;
  if (typeof onLocaleChange === 'function') {
    unsubLocale = onLocaleChange(() => {
      if (!destroyed) refreshLabels();
    });
  }

  mountPlayable();

  return {
    group,
    buttons: { menu: menuBtn },
    playable,
    exportPack,
    importPackFile,
    openPackMenu,
    togglePlayableExport,
    refresh: refreshLabels,
    destroy() {
      destroyed = true;
      menuBtn.removeEventListener('click', onMenuClick);
      fileInput.removeEventListener('change', onFileChange);
      playableWrap.removeEventListener('click', onPlayableClickCapture, true);
      if (typeof unsubLocale === 'function') unsubLocale();
      if (playable && typeof playable.destroy === 'function') playable.destroy();
      if (group.parentNode) group.parentNode.removeChild(group);
      try {
        fileops.closeMenu();
      } catch (_err) {
        /* 選單可能已關閉 */
      }
    },
  };
}
