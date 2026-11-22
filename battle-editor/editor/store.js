/**
 * editor/store.js — 編輯器狀態容器（ED1 擁有）
 *
 * Phase 1（攻擊編輯器）與 Phase 2（遭遇編輯器）共用同一份 store：
 *   - 「文件」一律叫 doc（`store.doc`）；`store.attack` 是 Phase 1 的相容別名。
 *   - 深拷貝草稿提交、復原/重做堆疊（上限 200）、coalesceKey 合併、subscribe 通知、
 *     世代序號錯誤、300ms debounce 自動暫存。
 *
 * 合約見 docs/SPEC.md §10 與 docs/SPEC-P2.md §6。
 *
 * 本模組必須能在 Node（無 DOM）環境被 import，供 editor/store.test.mjs 與
 * editor/encounter/app.test.mjs 測試。
 * localStorage 一律以 try/catch 保護，取不到時自動退回「不自動暫存」模式。
 */

export const FPS = 30;
export const UNDO_LIMIT = 200;
export const AUTOSAVE_KEY = 'dr-battle-editor.autosave.v1';
export const ENCOUNTER_AUTOSAVE_KEY = 'dr-battle-encounter-editor.autosave.v1';
export const AUTOSAVE_DELAY = 300;

/**
 * 選取種類（遭遇編輯器）。Phase 1 另有 'event' / 'bulletType' / 'box' / 'settings' 等。
 * 對外語意：
 *   settings → 整份遭遇設定
 *   actor    → actors.<id>
 *   party    → party[<index>]
 *   enemy    → enemies[<index>]
 *   act      → enemies[<index>].acts[<j>]
 *   item     → items[<index>]
 *   turn     → turns[<index>]
 *   hook     → hooks.<name>
 *   spell    → party[<index>].spells[<j>]
 * 實際位置一律以 selection.path 為準（JSON 路徑，如 'enemies[0].acts[1]'）。
 */
export const SELECTION_KINDS = [
  'settings',
  'actor',
  'party',
  'enemy',
  'act',
  'item',
  'turn',
  'hook',
  'spell',
];

const HAS_STRUCTURED_CLONE = typeof globalThis.structuredClone === 'function';

/* ==========================================================================
 * 泛用小工具
 * ======================================================================== */

/** 深拷貝（文件只會是 JSON 型別，但保留 undefined/Date 等以防萬一） */
export function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (HAS_STRUCTURED_CLONE) {
    try {
      return globalThis.structuredClone(value);
    } catch (_err) {
      /* 含有無法複製的內容時退回手動複製 */
    }
  }
  if (Array.isArray(value)) return value.map(deepClone);
  if (value instanceof Date) return new Date(value.getTime());
  const out = {};
  for (const key of Object.keys(value)) out[key] = deepClone(value[key]);
  return out;
}

/** 以 JSON 序列化比較內容是否相同（文件全部是 JSON 值，足夠可靠） */
export function jsonEqual(a, b) {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_err) {
    return false;
  }
}

/** 找出兩個值之間有變動的葉節點路徑（給檢查器做變更提示用），上限 limit 筆 */
export function diffPaths(prev, next, path = '', out = [], limit = 100) {
  if (out.length >= limit) return out;
  if (prev === next) return out;
  const prevIsObj = prev !== null && typeof prev === 'object';
  const nextIsObj = next !== null && typeof next === 'object';
  if (!prevIsObj || !nextIsObj || Array.isArray(prev) !== Array.isArray(next)) {
    out.push(path || '$');
    return out;
  }
  const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
  for (const key of keys) {
    const child = Array.isArray(prev) ? `${path}[${key}]` : path ? `${path}.${key}` : key;
    if (!(key in prev) || !(key in next)) {
      out.push(child);
    } else {
      diffPaths(prev[key], next[key], child, out, limit);
    }
    if (out.length >= limit) break;
  }
  return out;
}

/* ==========================================================================
 * JSON 路徑工具（選取／cuePath／驗證錯誤都共用）
 * ======================================================================== */

/**
 * 把 'enemies[0].acts[1].cues' 切成 ['enemies', 0, 'acts', 1, 'cues']。
 * '$'、''、null 都代表根節點（回傳 []）。
 * @param {string|Array<string|number>|null} path
 * @returns {(string|number)[]}
 */
export function splitPath(path) {
  if (Array.isArray(path)) return path.slice();
  if (path === null || path === undefined) return [];
  const text = String(path).trim();
  if (text === '' || text === '$') return [];
  const segments = text
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/^\./, '')
    .split('.')
    .filter((seg) => seg !== '');
  return segments.map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg));
}

/**
 * 依路徑取值；路徑不存在時回傳 undefined。
 * @param {any} root
 * @param {string|Array<string|number>|null} path
 */
export function getAtPath(root, path) {
  let node = root;
  const segments = splitPath(path);
  for (const seg of segments) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[seg];
    if (node === undefined) return undefined;
  }
  return node;
}

/**
 * 依路徑就地寫值（會修改 root）。中間缺少的容器會自動建立
 * （下一段是數字 → 建陣列，否則建物件）。回傳是否寫入成功。
 * @param {any} root
 * @param {string|Array<string|number>|null} path
 * @param {any} value
 */
export function setAtPath(root, path, value) {
  const segments = splitPath(path);
  if (segments.length === 0) return false;
  let node = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const seg = segments[i];
    if (node === null || typeof node !== 'object') return false;
    let child = node[seg];
    if (child === null || typeof child !== 'object') {
      child = typeof segments[i + 1] === 'number' ? [] : {};
      node[seg] = child;
    }
    node = child;
  }
  if (node === null || typeof node !== 'object') return false;
  node[segments[segments.length - 1]] = value;
  return true;
}

/** 路徑是否符合前綴（'enemies[0]' 涵蓋 'enemies[0].hp' 與 'enemies[0].acts[1]'） */
export function pathUnder(path, prefix) {
  if (!prefix || prefix === '$') return true;
  const p = String(path || '');
  const pre = String(prefix);
  if (p === pre) return true;
  const rest = p.slice(pre.length);
  return p.startsWith(pre) && (rest.startsWith('.') || rest.startsWith('['));
}

/* ==========================================================================
 * localStorage 自動暫存
 * ======================================================================== */

/** 取得可用的 localStorage（Node 或隱私模式下回傳 null） */
export function defaultStorage() {
  try {
    const ls = globalThis.localStorage;
    if (!ls) return null;
    return typeof ls.getItem === 'function' ? ls : null;
  } catch (_err) {
    return null;
  }
}

/**
 * 讀取自動暫存。
 * @param {Storage|null} [storage]
 * @param {string} [key] 預設攻擊編輯器的 key（遭遇編輯器傳 ENCOUNTER_AUTOSAVE_KEY）
 * @returns {null | { savedAt:number, fileName:string|null, dirty:boolean, doc:object, attack:object }}
 */
export function readAutosave(storage = null, key = AUTOSAVE_KEY) {
  const ls = storage || defaultStorage();
  if (!ls) return null;
  try {
    const raw = ls.getItem(key);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    // 新格式寫 doc；Phase 1 舊暫存寫 attack → 兩者都接受
    const doc = data.doc && typeof data.doc === 'object' ? data.doc : null;
    const legacy = data.attack && typeof data.attack === 'object' ? data.attack : null;
    const resolved = doc || legacy;
    if (!resolved) return null;
    return {
      ...data,
      doc: resolved,
      attack: resolved, // Phase 1 呼叫端相容
    };
  } catch (_err) {
    return null;
  }
}

/** 清除自動暫存 */
export function clearAutosave(storage = null, key = AUTOSAVE_KEY) {
  const ls = storage || defaultStorage();
  if (!ls) return false;
  try {
    ls.removeItem(key);
    return true;
  } catch (_err) {
    return false;
  }
}

/* ==========================================================================
 * 選取
 * ======================================================================== */

function makeInitialSelection() {
  return { kind: null, id: null, path: null };
}

/**
 * 正規化選取物件。
 * 接受字串（視為 kind）、{kind,id}（Phase 1）或 {kind,id,path,meta}（Phase 2）。
 */
export function normalizeSelection(selection) {
  if (typeof selection === 'string') return { kind: selection, id: null, path: null };
  if (!selection || typeof selection !== 'object') return makeInitialSelection();
  const out = {
    kind: selection.kind ?? null,
    id: selection.id ?? null,
    path:
      selection.path === undefined || selection.path === null
        ? null
        : typeof selection.path === 'string'
          ? selection.path
          : String(selection.path),
  };
  if (selection.meta && typeof selection.meta === 'object') out.meta = deepClone(selection.meta);
  return out;
}

function sameSelection(a, b) {
  return (
    a.kind === b.kind &&
    a.id === b.id &&
    a.path === b.path &&
    jsonEqual(a.meta === undefined ? null : a.meta, b.meta === undefined ? null : b.meta)
  );
}

/** 陣列內容看起來像 cue 清單（每項是 {cmd:...} 物件） */
export function looksLikeCueList(value) {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return false;
  return value.every((item) => item && typeof item === 'object' && !Array.isArray(item) && typeof item.cmd === 'string');
}

/**
 * 由選取推算「指令清單編輯器要編輯的 cues 陣列路徑」。
 *
 * 規則（依序）：
 *   1. selection.cuePath / selection.cuesPath / selection.meta.cuesPath 有值 → 直接用
 *   2. selection.path 指向的值本身就是陣列 → 就是它（hooks 掛鉤、已指向 cues 陣列）
 *   3. selection.path 指向的值是物件且有 `.cues` 陣列 → `<path>.cues`（ACT、法術）
 *   4. kind 是 'act' / 'spell' → `<path>.cues`
 *   5. kind 是 'turn' → `<path>.start`（回合開始指令，ED3 可用 meta.cuesPath 指定 .end）
 *   6. 其他 → null
 *
 * @param {object} doc 文件
 * @param {object|string|null} selection 選取
 * @returns {string|null}
 */
export function defaultCuePathFor(doc, selection) {
  const sel = normalizeSelection(selection);
  const explicit =
    sel.cuePath !== undefined && sel.cuePath !== null
      ? sel.cuePath
      : sel.meta && sel.meta.cuesPath !== undefined && sel.meta.cuesPath !== null
        ? sel.meta.cuesPath
        : null;
  if (explicit) return String(explicit);
  const path = sel.path;
  if (!path) return null;

  const value = getAtPath(doc, path);
  if (Array.isArray(value)) return path;
  if (value && typeof value === 'object') {
    if (Array.isArray(value.cues)) return `${path}.cues`;
    if (sel.kind === 'turn') {
      if (Array.isArray(value.start)) return `${path}.start`;
      if (Array.isArray(value.end)) return `${path}.end`;
    }
  }
  if (sel.kind === 'act' || sel.kind === 'spell') return `${path}.cues`;
  if (sel.kind === 'turn') return `${path}.start`;
  return null;
}

/* ==========================================================================
 * createStore
 * ======================================================================== */

/**
 * 建立 store。
 * @param {object} initialDoc 初始文件 JSON（會被深拷貝，呼叫端的物件不會被改）
 * @param {{
 *   storage?: Storage|null,
 *   fileName?: string|null,
 *   autosave?: boolean,
 *   autosaveKey?: string,
 *   initialSelection?: object|string|null,
 *   initialCuePath?: string|null,
 * }} [options]
 */
export function createStore(initialDoc, options = {}) {
  const autosaveKey = options.autosaveKey || AUTOSAVE_KEY;
  const state = {
    doc: deepClone(initialDoc || {}),
    selection: normalizeSelection(options.initialSelection),
    cuePath: options.initialCuePath ?? null,
    errors: new Map(),
    dirty: false,
    fileName: options.fileName ?? null,
    savedAt: null,
  };

  /** @type {Set<(store:any, change:any)=>void>} */
  const listeners = new Set();
  /** @type {{doc:object,label:string}[]} */
  const undoStack = [];
  /** @type {{doc:object,label:string}[]} */
  const redoStack = [];

  let lastCoalesceKey = null;
  let idSeq = 0;
  let autosaveTimer = 0;
  let autosaveBroken = false;
  let autoSaveEnabled = options.autosave !== false;
  // 錯誤重建的世代序號：只接受最新一次的結果，避免非同步時序下舊結果覆蓋新結果。
  let errorSeqCounter = 0;
  let lastAppliedErrorSeq = 0;
  const storage = options.storage !== undefined ? options.storage : defaultStorage();

  // ------------------------------------------------------------------ 通知

  function emit(change) {
    const payload = change || { label: '更新' };
    for (const fn of [...listeners]) {
      try {
        fn(store, payload);
      } catch (err) {
        console.error('[store] 訂閱回呼發生錯誤：', err);
      }
    }
  }

  function subscribe(fn) {
    if (typeof fn !== 'function') return () => {};
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  }

  // -------------------------------------------------------------- 自動暫存

  function writeAutosaveNow() {
    if (!storage || autosaveBroken) return;
    try {
      storage.setItem(
        autosaveKey,
        JSON.stringify({
          version: 1,
          savedAt: Date.now(),
          fileName: state.fileName,
          dirty: state.dirty,
          format: state.doc ? state.doc.format || null : null,
          doc: state.doc,
        }),
      );
    } catch (err) {
      autosaveBroken = true;
      console.warn('[store] 自動暫存失敗（已停用）：', err);
    }
  }

  function scheduleAutosave() {
    if (!storage || !autoSaveEnabled || autosaveBroken) return;
    if (autosaveTimer) clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => {
      autosaveTimer = 0;
      writeAutosaveNow();
    }, AUTOSAVE_DELAY);
  }

  function cancelAutosaveTimer() {
    if (autosaveTimer) {
      clearTimeout(autosaveTimer);
      autosaveTimer = 0;
    }
  }

  // ---------------------------------------------------------------- 提交

  /** 看起來像整份文件（而非只是草稿）→ 允許 update 以回傳值取代草稿 */
  function looksLikeDocument(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    return (
      typeof value.format === 'string' ||
      Array.isArray(value.timeline) ||
      value.settings !== undefined ||
      value.box !== undefined ||
      value.actors !== undefined ||
      Array.isArray(value.party) ||
      Array.isArray(value.enemies) ||
      Array.isArray(value.turns)
    );
  }

  /**
   * 套用新草稿。
   * @returns {boolean} 內容是否有變動
   */
  function commit(next, options2 = {}) {
    const label = options2.label || '編輯';
    const coalesceKey = options2.coalesceKey || null;
    const prev = state.doc;

    if (jsonEqual(prev, next)) {
      if (options2.selection) {
        applySelection(options2.selection, { silent: true });
      }
      return false;
    }

    // 同 coalesceKey 連續更新合併為一步復原：不推入新的復原快照
    const merged = Boolean(coalesceKey && coalesceKey === lastCoalesceKey && undoStack.length > 0);
    if (!merged) {
      undoStack.push({ doc: prev, label });
      while (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0;
    }

    state.doc = next;
    lastCoalesceKey = coalesceKey;
    if (options2.selection) state.selection = normalizeSelection(options2.selection);
    state.dirty = true;

    const change = {
      label,
      coalesceKey,
      paths: options2.paths || diffPaths(prev, next),
    };
    if (options2.selection) change.selection = { ...state.selection };

    emit(change);
    scheduleAutosave();
    return true;
  }

  function applySelection(selection, { silent = false, autoCuePath = true } = {}) {
    const next = normalizeSelection(selection);
    if (sameSelection(next, state.selection)) return false;
    state.selection = next;
    if (autoCuePath && options.autoCuePath !== false) {
      const derived = defaultCuePathFor(state.doc, next);
      if (derived !== state.cuePath) state.cuePath = derived;
    }
    if (!silent) {
      emit({ label: '選取', selectionOnly: true, selection: { ...next }, cuePath: state.cuePath });
    }
    return true;
  }

  // ---------------------------------------------------------------- 復原

  function restore(entry, label) {
    const prevCurrent = state.doc;
    state.doc = entry.doc;
    lastCoalesceKey = null;
    state.dirty = true;
    emit({ label, paths: diffPaths(prevCurrent, state.doc), selection: { ...state.selection }, history: true });
    scheduleAutosave();
  }

  function undo() {
    const entry = undoStack.pop();
    if (!entry) return false;
    redoStack.push({ doc: state.doc, label: entry.label });
    while (redoStack.length > UNDO_LIMIT) redoStack.shift();
    restore(entry, `復原：${entry.label}`);
    return true;
  }

  function redo() {
    const entry = redoStack.pop();
    if (!entry) return false;
    undoStack.push({ doc: state.doc, label: entry.label });
    while (undoStack.length > UNDO_LIMIT) undoStack.shift();
    restore(entry, `重做：${entry.label}`);
    return true;
  }

  // ---------------------------------------------------------------- 錯誤

  function nextErrorSeq() {
    errorSeqCounter += 1;
    return errorSeqCounter;
  }

  function bumpErrorSeq() {
    errorSeqCounter += 1;
    lastAppliedErrorSeq = errorSeqCounter;
    return lastAppliedErrorSeq;
  }

  /**
   * 整批設定錯誤。
   * @param {Map<string,string>|Array<{path?:string,message?:string}>|Record<string,string>} source
   * @param {number} [seq] nextErrorSeq() 取得的重建序號；比已套用序號舊會被丟棄
   * @returns {boolean} 是否有變更
   */
  function setErrors(source, seq) {
    if (typeof seq === 'number' && Number.isFinite(seq)) {
      if (seq < lastAppliedErrorSeq) return false; // 舊的重建結果，丟棄
      lastAppliedErrorSeq = seq;
    } else {
      bumpErrorSeq();
    }

    const next = new Map();
    if (source instanceof Map) {
      for (const [key, value] of source) {
        if (value === null || value === undefined || value === '') continue;
        next.set(String(key), String(value));
      }
    } else if (Array.isArray(source)) {
      for (const item of source) {
        if (!item || typeof item !== 'object') continue;
        const key = item.path ?? item.key ?? item.field ?? '$';
        const message = item.message ?? item.msg ?? '';
        if (message) next.set(String(key), String(message));
      }
    } else if (source && typeof source === 'object') {
      for (const key of Object.keys(source)) {
        const value = source[key];
        if (value === null || value === undefined || value === '') continue;
        next.set(String(key), String(value));
      }
    }

    let same = next.size === state.errors.size;
    if (same) {
      for (const [key, value] of next) {
        if (state.errors.get(key) !== value) {
          same = false;
          break;
        }
      }
    }
    if (same) return false;

    // 就地更新 Map，讓持有 store.errors 參考的面板也能看到最新內容
    state.errors.clear();
    for (const [key, value] of next) state.errors.set(key, value);

    emit({ label: 'errors', errors: true, errorCount: state.errors.size });
    return true;
  }

  function setError(key, message) {
    if (!key) return false;
    if (!message) return clearError(key);
    if (state.errors.get(String(key)) === String(message)) return false;
    bumpErrorSeq();
    state.errors.set(String(key), String(message));
    emit({ label: 'errors', errors: true, errorCount: state.errors.size });
    return true;
  }

  function clearError(key) {
    if (!state.errors.has(String(key))) return false;
    bumpErrorSeq();
    state.errors.delete(String(key));
    emit({ label: 'errors', errors: true, errorCount: state.errors.size });
    return true;
  }

  function clearErrors() {
    if (state.errors.size === 0) return false;
    bumpErrorSeq();
    state.errors.clear();
    emit({ label: 'errors', errors: true, errorCount: 0 });
    return true;
  }

  /**
   * 取出某個路徑（含子路徑）下的錯誤，供結構樹／卡片標紅。
   * @param {string} prefix JSON 路徑前綴；空字串或 '$' 代表全部
   * @returns {Array<[string,string]>}
   */
  function errorsUnder(prefix) {
    const out = [];
    for (const [key, value] of state.errors) {
      if (pathUnder(key, prefix)) out.push([key, value]);
    }
    return out;
  }

  function hasErrorUnder(prefix) {
    for (const key of state.errors.keys()) {
      if (pathUnder(key, prefix)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- 身分

  /** 遞迴收集文件裡所有 `id` 字串，避免新 id 撞到既有 id */
  function collectIds(value, out, depth = 0) {
    if (!value || typeof value !== 'object' || depth > 16) return out;
    if (Array.isArray(value)) {
      for (const item of value) collectIds(item, out, depth + 1);
      return out;
    }
    if (typeof value.id === 'string') out.add(value.id);
    for (const key of Object.keys(value)) collectIds(value[key], out, depth + 1);
    return out;
  }

  function newId(prefix = 'ev') {
    const used = collectIds(state.doc, new Set());
    const safePrefix = String(prefix || 'id').replace(/[^A-Za-z0-9_-]/g, '_');
    let id = '';
    do {
      idSeq += 1;
      const rand = Math.random().toString(36).slice(2, 6);
      id = `${safePrefix}_${idSeq.toString(36)}${rand}`;
    } while (used.has(id));
    return id;
  }

  // ---------------------------------------------------------------- cuePath

  /** 目前指令清單編輯器要編輯的 cues 陣列路徑（JSON 路徑字串或 null） */
  function setCuePath(path, { silent = false } = {}) {
    const next = path === undefined || path === null || path === '' ? null : String(path);
    if (next === state.cuePath) return false;
    state.cuePath = next;
    if (!silent) {
      emit({ label: 'cuePath', cuePath: next, selectionOnly: true, selection: { ...state.selection } });
    }
    return true;
  }

  function getCue() {
    if (!state.cuePath) return null;
    return getAtPath(state.doc, state.cuePath);
  }

  // ------------------------------------------------------------------ 公開

  const store = {
    // --- 唯讀狀態 ---
    get doc() {
      return state.doc;
    },
    /** Phase 1 相容別名（攻擊編輯器的文件就是「攻擊」） */
    get attack() {
      return state.doc;
    },
    get selection() {
      return state.selection;
    },
    get cuePath() {
      return state.cuePath;
    },
    get errors() {
      return state.errors;
    },
    get fileName() {
      return state.fileName;
    },
    set fileName(value) {
      state.fileName = value || null;
      scheduleAutosave();
    },
    get savedAt() {
      return state.savedAt;
    },
    get fps() {
      return FPS;
    },
    get format() {
      return state.doc ? state.doc.format || null : null;
    },

    subscribe,

    /**
     * fn(draftClone) 修改草稿後提交。
     * @param {(draft:object)=>void} fn
     * @param {{label?:string, coalesceKey?:string|null, paths?:string[], selection?:object}} [opts]
     */
    update(fn, opts = {}) {
      if (typeof fn !== 'function') return false;
      const before = state.doc;
      let draft;
      try {
        draft = deepClone(before);
      } catch (err) {
        console.error('[store] 無法複製草稿：', err);
        return false;
      }
      let result;
      try {
        result = fn(draft);
      } catch (err) {
        console.error(`[store] 更新失敗（${opts.label || '編輯'}）：`, err);
        return false;
      }
      // 容忍「回傳新物件」的寫法；只有看起來像整份文件才採用
      let next = draft;
      if (result && typeof result === 'object' && result !== draft && looksLikeDocument(result)) {
        next = result;
      }
      return commit(next, opts);
    },

    /** 取目前文件某路徑的值 */
    getAt(path) {
      return getAtPath(state.doc, path);
    },

    /**
     * 依路徑改值（面板最常用的寫入方式）。
     * @param {string} path JSON 路徑
     * @param {any} value
     * @param {{label?:string, coalesceKey?:string|null}} [opts]
     */
    setAt(path, value, opts = {}) {
      let ok = false;
      const changed = store.update(
        (draft) => {
          ok = setAtPath(draft, path, deepClone(value));
        },
        { label: opts.label || `編輯 ${path}`, coalesceKey: opts.coalesceKey, paths: [String(path)] },
      );
      return changed && ok;
    },

    /**
     * Phase 1 相容：select(kind, id) 或 select(kind, id, pathOrExtra)。
     * Phase 2 建議直接用 setSelection({kind, id, path, meta})。
     */
    select(kind, id, extra) {
      if (kind && typeof kind === 'object') return applySelection(kind);
      const selection = { kind, id };
      if (typeof extra === 'string') selection.path = extra;
      else if (extra && typeof extra === 'object') {
        if (extra.path !== undefined) selection.path = extra.path;
        if (extra.meta !== undefined) selection.meta = extra.meta;
      }
      return applySelection(selection);
    },

    setSelection(selection) {
      return applySelection(selection);
    },

    clearSelection() {
      return applySelection(null);
    },

    setCuePath,
    getCue,

    /**
     * 修改目前 cuePath 指向的 cues 陣列（ED2 指令清單編輯器用）。
     * mutator 收到的是「陣列的深拷貝」，就地修改即可。
     * @param {(cues:any[], draft:object)=>void} mutator
     */
    updateCue(mutator, opts = {}) {
      if (!state.cuePath || typeof mutator !== 'function') return false;
      const path = state.cuePath;
      return store.update(
        (draft) => {
          const arr = getAtPath(draft, path);
          if (!Array.isArray(arr)) throw new Error(`cuePath 不是陣列：${path}`);
          mutator(arr, draft);
        },
        { label: opts.label || '編輯指令清單', coalesceKey: opts.coalesceKey, paths: [path], selection: opts.selection },
      );
    },

    undo,
    redo,
    canUndo() {
      return undoStack.length > 0;
    },
    canRedo() {
      return redoStack.length > 0;
    },
    historySize() {
      return { undo: undoStack.length, redo: redoStack.length };
    },

    /** 開檔／新建：直接換掉整份文件並清空復原堆疊 */
    replace(doc, label = '開檔') {
      state.doc = deepClone(doc || {});
      state.selection = makeInitialSelection();
      state.cuePath = null;
      state.errors.clear();
      undoStack.length = 0;
      redoStack.length = 0;
      lastCoalesceKey = null;
      state.dirty = false;
      state.savedAt = Date.now();
      cancelAutosaveTimer();
      clearAutosave(storage, autosaveKey);
      emit({
        label,
        reset: true,
        document: true,
        paths: ['$'],
        selection: { ...state.selection },
        cuePath: null,
        errorCount: 0,
      });
      return state.doc;
    },

    newId,

    /**
     * 套用遠端（Agent / 其他編輯器）版本：可以復原（推一筆 undo），但不算未存修改。
     * SPEC-AGENT §5：他人改動要成為「一筆可復原的變更」。
     * @param {object} doc 遠端文件
     * @param {string} [label] 歷史標籤（例如「Agent 修改」）
     */
    applyRemote(doc, label = '遠端修改') {
      if (!doc || typeof doc !== 'object') return false;
      const next = deepClone(doc);
      if (jsonEqual(next, state.doc)) {
        state.dirty = false;
        emit({ label, remote: true, errors: false, errorCount: state.errors.size });
        return false;
      }
      const prev = state.doc;
      undoStack.push({ doc: prev, label });
      if (undoStack.length > UNDO_LIMIT) undoStack.shift();
      redoStack.length = 0;
      lastCoalesceKey = null;
      state.doc = next;
      state.dirty = false;
      state.savedAt = Date.now();
      cancelAutosaveTimer();
      emit({
        label,
        reset: true,
        document: true,
        remote: true,
        paths: ['$'],
        selection: { ...state.selection },
        cuePath: state.cuePath,
        errorCount: state.errors.size,
      });
      return true;
    },

    /** 錯誤重建序號：呼叫端先取號、算完連同結果交給 setErrors(source, seq) */
    nextErrorSeq,
    setErrors,
    setError,
    clearError,
    clearErrors,
    errorsUnder,
    hasErrorUnder,

    /** 結束目前的 coalesce 群組（拖曳結束時呼叫，下一次同 key 會是新的一步） */
    endCoalesce() {
      lastCoalesceKey = null;
    },

    isDirty() {
      return state.dirty;
    },

    /** 儲存成功後呼叫：清除 dirty 與自動暫存 */
    markSaved(fileName, savedDoc = state.doc) {
      state.dirty = state.doc !== savedDoc;
      state.savedAt = Date.now();
      if (fileName !== undefined && fileName !== null) state.fileName = fileName || null;
      if (state.dirty) scheduleAutosave();
      else {
        cancelAutosaveTimer();
        clearAutosave(storage, autosaveKey);
      }
      emit({ label: '已儲存', saved: !state.dirty, fileName: state.fileName, savedAt: state.savedAt });
      return !state.dirty;
    },

    /** 只把 dirty 標記清除（例如內容確實已同步到磁碟） */
    markClean() {
      state.dirty = false;
      emit({ label: '已同步', saved: true });
    },

    flushAutosave() {
      cancelAutosaveTimer();
      writeAutosaveNow();
    },

    setAutoSave(enabled) {
      autoSaveEnabled = Boolean(enabled);
      if (!autoSaveEnabled) cancelAutosaveTimer();
    },

    dispose() {
      cancelAutosaveTimer();
      listeners.clear();
    },
  };

  return store;
}

export default createStore;
