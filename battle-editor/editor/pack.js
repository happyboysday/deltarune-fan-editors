/**
 * editor/pack.js — 作品包匯出／匯入（V2-06）
 *
 * serve.py 已提供兩個端點（V2-05 pack.mjs）：
 *   POST /api/pack/export  body {kind?, name} → .drpack.json（Content-Disposition）
 *   POST /api/pack/import?mode=abort|rename|overwrite  body = 作品包原文
 *
 * 匯入的衝突流程（規格：讓使用者選 abort / rename / overwrite）：
 *   1. 先用 mode=abort 送一次；200 → 直接完成（沒有衝突）
 *   2. 409 + `{ok:false, code:'conflicts', conflicts:[{kind,name,path}], hint}` →
 *      開對話框列出衝突，讓使用者選「取消 / 自動改名 / 覆蓋」
 *   3. 依選擇重送 mode=rename 或 mode=overwrite
 *
 * 純邏輯（payload 組裝、衝突摘要、訊息）都獨立 export，方便 Node 單元測試；
 * DOM 流程集中在 mountPackButtons()。
 */

/** 端點常數（與 serve.py 的 POST 路由一致）。 */
export const PACK_EXPORT_ENDPOINT = '/api/pack/export';
export const PACK_IMPORT_ENDPOINT = '/api/pack/import';

/** 匯入模式；abort = 有衝突就什麼都不寫。 */
export const PACK_MODES = Object.freeze(['abort', 'rename', 'overwrite']);

/** 衝突種類的顯示順序。 */
export const CONFLICT_KINDS = Object.freeze(['encounter', 'attack', 'sprite', 'audio']);

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 目前作品在伺服器上的名稱（不含 .json）。
 * 伺服器端用 name 找檔案，所以優先序：fileName → meta.name → 'attack'。
 */
export function workNameOf(store) {
  if (!store) return '';
  const file = str(store.fileName);
  if (file) return file.replace(/\.json$/i, '');
  const attack = store.attack || {};
  const meta = isObj(attack.meta) ? attack.meta : {};
  const name = str(meta.name);
  if (name) return name;
  return '';
}

/** 作品包匯出的 request body。 */
export function buildPackExportBody(store, extra = {}) {
  const name = workNameOf(store);
  if (!name) {
    const err = new Error('no_name');
    err.code = 'no_name';
    throw err;
  }
  const body = { name };
  const kind = str(extra.kind);
  if (kind) body.kind = kind;
  return body;
}

/** 作品包匯入的 URL（mode 一律帶在 query，和 serve.py 一致）。 */
export function buildPackImportUrl(mode, endpoint = PACK_IMPORT_ENDPOINT) {
  const m = PACK_MODES.includes(mode) ? mode : 'abort';
  return `${endpoint}?mode=${encodeURIComponent(m)}`;
}

/**
 * 把伺服器的衝突 payload 正規化成可直接顯示的清單。
 * @returns {{conflicts: {kind:string,name:string,path:string}[], counts: Record<string,number>, total:number}}
 */
export function parseConflicts(payload) {
  const p = isObj(payload) ? payload : {};
  const raw = Array.isArray(p.conflicts) ? p.conflicts : [];
  const conflicts = [];
  const counts = { encounter: 0, attack: 0, sprite: 0, audio: 0 };
  for (const item of raw) {
    if (!isObj(item)) continue;
    const kind = CONFLICT_KINDS.includes(item.kind) ? item.kind : 'attack';
    const name = str(item.name) || '(unnamed)';
    const path = str(item.path);
    conflicts.push({ kind, name, path });
    counts[kind] += 1;
  }
  return { conflicts, counts, total: conflicts.length };
}

/** 是否為「名稱衝突」回應（serve.py 回 409 + code:'conflicts'）。 */
export function isConflictPayload(status, payload) {
  if (status !== 409) return false;
  const p = isObj(payload) ? payload : {};
  return p.code === 'conflicts' || (Array.isArray(p.conflicts) && p.conflicts.length > 0);
}

/** 匯入結果摘要（成功時顯示「匯入了幾個」）。 */
export function summarizeImport(payload) {
  const p = isObj(payload) ? payload : {};
  const imported = isObj(p.imported) ? p.imported : {};
  const list = (key) => (Array.isArray(imported[key]) ? imported[key] : []);
  const counts = {
    encounters: list('encounters').length,
    attacks: list('attacks').length,
    sprites: list('sprites').length,
    audio: list('audio').length,
  };
  const total = counts.encounters + counts.attacks + counts.sprites + counts.audio;
  // rename 模式下有改名的項目：imported.attacks[i].renamedFrom 有值
  const renamed = [];
  for (const key of ['encounters', 'attacks']) {
    for (const item of list(key)) {
      if (isObj(item) && str(item.renamedFrom)) {
        renamed.push({ kind: key.replace(/s$/, ''), from: str(item.renamedFrom), to: str(item.name) });
      }
    }
  }
  return {
    ok: p.ok !== false && total > 0,
    counts,
    total,
    renamed,
    warnings: Array.isArray(p.warnings) ? p.warnings.map((w) => String(w)) : [],
    mode: str(p.mode) || 'abort',
  };
}

/** 從 Content-Disposition 取檔名（ASCII filename 優先，其次 RFC 5987 filename*）。 */
export function filenameFromDisposition(disposition, fallback = 'pack.drpack.json') {
  const text = String(disposition || '');
  if (!text) return fallback;
  const utf8 = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(text);
  if (utf8 && utf8[1]) {
    try {
      return decodeURIComponent(utf8[1].trim().replace(/^"|"$/g, ''));
    } catch (_err) {
      /* 忽略，退回 ASCII 版 */
    }
  }
  const ascii = /filename\s*=\s*"?([^";]+)"?/i.exec(text);
  if (ascii && ascii[1]) return ascii[1].trim();
  return fallback;
}

/** 伺服器錯誤訊息（中文原文直接顯示，測試只保證有字串）。 */
export function errorMessageFromPayload(payload, status) {
  const p = isObj(payload) ? payload : {};
  if (str(p.error)) return str(p.error);
  if (str(p.code)) return `${str(p.code)} (HTTP ${status})`;
  return `HTTP ${status}`;
}

/* ------------------------------------------------------------------ DOM 流程 */

function downloadBlob(blob, filename, documentRef = typeof document !== 'undefined' ? document : null) {
  if (!documentRef || typeof URL === 'undefined' || typeof Blob === 'undefined') return false;
  const url = URL.createObjectURL(blob);
  const a = documentRef.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  documentRef.body.appendChild(a);
  a.click();
  setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch (_err) {
      /* 忽略 */
    }
    a.remove();
  }, 0);
  return true;
}

/**
 * 掛上「匯出作品包」「匯入作品包」兩個工具列按鈕。
 *
 * @param {{
 *   store: any,
 *   toast?: (msg:string, kind?:string)=>void,
 *   openModal?: Function,
 *   confirmDialog?: Function,
 *   fetchImpl?: typeof fetch,
 *   documentRef?: Document,
 * }} opts
 * @returns {{exportPack: Function, importPack: Function, destroy: Function, isBusy: ()=>boolean}}
 */
export function mountPackButtons(opts = {}) {
  const store = opts.store || null;
  const doc = opts.documentRef || (typeof document !== 'undefined' ? document : null);
  const toast = typeof opts.toast === 'function' ? opts.toast : () => {};
  const openModal = typeof opts.openModal === 'function' ? opts.openModal : null;
  const fetchImpl = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (typeof fetch === 'function' ? fetch : null);
  const T = typeof opts.t === 'function' ? opts.t : (key) => key;

  const exportBtn = doc ? doc.getElementById('btn-pack-export') : null;
  const importBtn = doc ? doc.getElementById('btn-pack-import') : null;
  let busy = false;

  const setBusy = (value) => {
    busy = Boolean(value);
    for (const btn of [exportBtn, importBtn]) {
      if (btn) btn.disabled = busy;
    }
  };

  const localize = () => {
    if (exportBtn) {
      exportBtn.textContent = T('pack.export');
      exportBtn.title = T('pack.exportTip');
    }
    if (importBtn) {
      importBtn.textContent = T('pack.import');
      importBtn.title = T('pack.importTip');
    }
  };
  localize();

  async function readJson(res) {
    try {
      return await res.json();
    } catch (_err) {
      return null;
    }
  }

  /** 匯出目前作品為作品包（含遭遇／素材）。 */
  async function exportPack() {
    if (!fetchImpl || busy) return false;
    if (!store?.fileName || store.isDirty()) {
      toast(T('export.saveFirst'), 'error');
      return false;
    }
    const body = buildPackExportBody(store, { kind: 'attack' });
    setBusy(true);
    toast(T('pack.exporting', { name: body.name }));
    try {
      const res = await fetchImpl(PACK_EXPORT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const payload = await readJson(res);
        toast(T('pack.exportFailed', { msg: errorMessageFromPayload(payload, res.status) }), 'error');
        return false;
      }
      const blob = await res.blob();
      const filename = filenameFromDisposition(
        res.headers && typeof res.headers.get === 'function' ? res.headers.get('Content-Disposition') : '',
        `${body.name}.drpack.json`,
      );
      downloadBlob(blob, filename, doc);
      toast(T('pack.exported', { name: filename }), 'ok');
      return true;
    } catch (err) {
      toast(T('pack.exportFailed', { msg: (err && err.message) || err }), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** 送一次匯入；回傳 {status, payload}。 */
  async function postImport(mode, text) {
    const res = await fetchImpl(buildPackImportUrl(mode), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: text,
    });
    return { status: res.status, ok: res.ok, payload: await readJson(res) };
  }

  /** 衝突對話框：回傳 'abort' | 'rename' | 'overwrite'。 */
  async function askConflictMode(info) {
    const rows = info.conflicts.slice(0, 12).map(
      (c) => `<li><code>${escapeHtml(c.name)}</code><span class="pk-kind">${escapeHtml(c.kind)}</span></li>`,
    );
    const more = info.total > 12
      ? `<p class="pk-more">${escapeHtml(T('pack.more', { n: info.total - 12 }))}</p>`
      : '';
    const body =
      `<p>${escapeHtml(T('pack.conflictBody', { n: info.total }))}</p>` +
      `<ul class="pk-list">${rows.join('')}</ul>${more}` +
      `<p class="pk-hint">${escapeHtml(T('pack.conflictHint'))}</p>`;
    if (!openModal) return 'abort';
    const value = await openModal({
      title: T('pack.conflictTitle'),
      body,
      closeBtn: true,
      buttons: [
        { label: T('pack.modeAbort'), value: 'abort', kind: 'primary' },
        { label: T('pack.modeRename'), value: 'rename' },
        { label: T('pack.modeOverwrite'), value: 'overwrite', kind: 'danger' },
      ],
    });
    return PACK_MODES.includes(value) ? value : 'abort';
  }

  /** 選檔 → 匯入（衝突時詢問模式）。 */
  async function importPack() {
    if (!fetchImpl || busy || !doc) return false;
    const file = await pickFile(doc);
    if (!file) return false;
    let text = '';
    try {
      text = await file.text();
    } catch (err) {
      toast(T('pack.importFailed', { msg: (err && err.message) || err }), 'error');
      return false;
    }
    setBusy(true);
    toast(T('pack.importing', { name: file.name }));
    try {
      let result = await postImport('abort', text);
      if (isConflictPayload(result.status, result.payload)) {
        const info = parseConflicts(result.payload);
        const mode = await askConflictMode(info);
        if (mode === 'abort') {
          toast(T('pack.cancelled'), '');
          return false;
        }
        result = await postImport(mode, text);
      }
      if (!result.ok) {
        toast(
          T('pack.importFailed', { msg: errorMessageFromPayload(result.payload, result.status) }),
          'error',
        );
        return false;
      }
      const summary = summarizeImport(result.payload);
      toast(
        T('pack.imported', {
          total: summary.total,
          encounters: summary.counts.encounters,
          attacks: summary.counts.attacks,
        }),
        'ok',
      );
      if (summary.renamed.length > 0) {
        const pairs = summary.renamed.slice(0, 6).map((r) => `${r.from} → ${r.to}`).join('、');
        toast(T('pack.renamed', { pairs }), '');
      }
      for (const warning of summary.warnings.slice(0, 3)) toast(warning, '');
      return true;
    } catch (err) {
      toast(T('pack.importFailed', { msg: (err && err.message) || err }), 'error');
      return false;
    } finally {
      setBusy(false);
    }
  }

  const onExport = (e) => {
    if (e) e.preventDefault();
    exportPack();
  };
  const onImport = (e) => {
    if (e) e.preventDefault();
    importPack();
  };
  if (exportBtn) exportBtn.addEventListener('click', onExport);
  if (importBtn) importBtn.addEventListener('click', onImport);

  return {
    exportPack,
    importPack,
    isBusy: () => busy,
    localize,
    destroy() {
      if (exportBtn) exportBtn.removeEventListener('click', onExport);
      if (importBtn) importBtn.removeEventListener('click', onImport);
    },
  };
}

/** 開檔案選擇器（.drpack.json）；取消回 null。 */
function pickFile(doc) {
  return new Promise((resolve) => {
    const input = doc.createElement('input');
    input.type = 'file';
    input.accept = '.json,.drpack.json,application/json';
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = (input.files && input.files[0]) || null;
      input.remove();
      resolve(file);
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(null);
    });
    doc.body.appendChild(input);
    input.click();
  });
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export default mountPackButtons;
