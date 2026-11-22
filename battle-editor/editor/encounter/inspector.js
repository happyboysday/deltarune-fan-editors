// editor/encounter/inspector.js  (ED3, Phase 2)
//
// 遭遇編輯器的屬性檢查器：掛在 ED1 提供的 #enc-inspector（或其 body）。
//
// 依 store.selection 呈現表單：
//   settings / actor / party / spell / enemy / act / item / turn / talk /
//   cues（時機掛鉤） / var / vars
//
// 文字欄位可切「單一」與「中英 {zh,en}」兩種模式（SPEC-P2 §0）。
// store.errors 上的路徑會在對應欄位標紅並顯示訊息。
//
// 純邏輯（選取 → 路徑、錯誤查詢、文字模式轉換）集中在檔案前段，可直接在 node 測試。

import { TURN_CUE_KEYS } from '../../engine/encounter/schema.js';
import { t, registerStrings, onLocaleChange, getLocale } from '../i18n.js';
import STRINGS from '../locales/encounter-panels.js';
import {
  el,
  clear,
  button,
  fieldRow,
  section,
  emptyState,
  hintBox,
  selectEl,
  checkboxEl,
  textInput,
  colorField,
  spriteField,
  normalizeErrors,
  lookupError,
  lookupErrorPrefix,
  domSig,
  isEditingIn,
} from '../fields.js';
import {
  ensureEncounterStyles,
  ensureStructure,
  isBilingualText,
  parseTextValue,
  composeTextValue,
  dataLang,
  docOf,
  readSelection,
  readCuePath,
  writeCuePath,
  quoteKey,
  KIND,
} from './tree.js';

registerStrings('encPanels', STRINGS);

const T = (key, params) => t(`encPanels.${key}`, params);

/* =========================================================================
 * 1. 純邏輯：選取 → 目標節點
 * ========================================================================= */

/** kind → 陣列容器名稱（用來由 id 反推 path）。 */
const KIND_COLLECTION = {
  [KIND.party]: 'party',
  [KIND.enemy]: 'enemies',
  [KIND.item]: 'items',
  [KIND.turn]: 'turns',
};

function findIndexById(list, id) {
  if (!Array.isArray(list)) return -1;
  const target = String(id);
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (item && item.id !== undefined && String(item.id) === target) return i;
  }
  return -1;
}

/**
 * 由選取推算「這個節點在文件裡的路徑」。
 * 優先使用 selection.path；沒有時依 kind+id 搜尋（相容 Phase 1 的兩參數 select）。
 * @returns {string|null}
 */
export function pathForSelection(doc, selection) {
  if (!doc || !selection) return null;
  const kind = selection.kind;
  if (!kind) return null;
  if (kind === KIND.settings) return 'settings';
  if (selection.path) return String(selection.path);

  const id = selection.id;
  if (kind === KIND.actor) {
    const actors = doc.actors && typeof doc.actors === 'object' ? doc.actors : {};
    if (id !== null && id !== undefined && Object.prototype.hasOwnProperty.call(actors, String(id))) {
      return `actors.${quoteKey(String(id))}`;
    }
    return null;
  }
  if (kind === KIND.var) {
    const vars = doc.vars && typeof doc.vars === 'object' ? doc.vars : {};
    if (id !== null && id !== undefined && Object.prototype.hasOwnProperty.call(vars, String(id))) {
      return `vars.${quoteKey(String(id))}`;
    }
    return null;
  }
  if (kind === KIND.vars) return 'vars';
  if (kind === KIND.spell || kind === KIND.act || kind === KIND.talk) {
    // 需要 path；沒有 path 時用 id 在所有容器裡找
    const wanted = String(id);
    const partyList = Array.isArray(doc.party) ? doc.party : [];
    for (let i = 0; i < partyList.length; i += 1) {
      const spells = Array.isArray(partyList[i] && partyList[i].spells) ? partyList[i].spells : [];
      const j = findIndexById(spells, wanted);
      if (j >= 0) return `party[${i}].spells[${j}]`;
    }
    const enemyList = Array.isArray(doc.enemies) ? doc.enemies : [];
    for (let i = 0; i < enemyList.length; i += 1) {
      const acts = Array.isArray(enemyList[i] && enemyList[i].acts) ? enemyList[i].acts : [];
      const j = findIndexById(acts, wanted);
      if (j >= 0) return `enemies[${i}].acts[${j}]`;
    }
    const turnList = Array.isArray(doc.turns) ? doc.turns : [];
    for (let i = 0; i < turnList.length; i += 1) {
      const talk = Array.isArray(turnList[i] && turnList[i].talk) ? turnList[i].talk : [];
      const k = talk.findIndex((b) => b && String(b.actor) === wanted && String(b.text || '') === '');
      if (k >= 0) return `turns[${i}].talk[${k}]`;
    }
    return null;
  }
  if (kind === KIND.cues) {
    if (selection.path) return String(selection.path);
    return typeof id === 'string' && id.includes('/') ? null : null;
  }
  const collection = KIND_COLLECTION[kind];
  if (collection) {
    const list = Array.isArray(doc[collection]) ? doc[collection] : [];
    const i = findIndexById(list, id);
    return i >= 0 ? `${collection}[${i}]` : null;
  }
  return null;
}

/**
 * 解析選取 → { kind, path, value, found }。
 * 找不到資料時 found=false（表單顯示「可能已被刪除」）。
 */
export function resolveTarget(doc, selection) {
  const sel = selection || {};
  if (!doc || !sel.kind) return { kind: sel.kind || null, path: null, value: null, found: false };
  const path = pathForSelection(doc, sel);
  if (!path) return { kind: sel.kind, path: sel.path || null, value: null, found: false };
  // 用 fields.getPath 的語意自己走（避免多一層 import 循環）
  const value = readAtPath(doc, path);
  if (value === undefined || value === null) {
    return { kind: sel.kind, path, value: value === null ? null : undefined, found: false };
  }
  return { kind: sel.kind, path, value, found: true };
}

/** 讀取路徑值（支援 `a.b[0].c` 與 `a["x y"]`）。 */
export function readAtPath(doc, path) {
  if (!doc || !path) return undefined;
  const tokens = [];
  const s = String(path);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '.' || c === ' ') { i += 1; continue; }
    if (c === '[') {
      const j = s.indexOf(']', i);
      if (j < 0) return undefined;
      const inner = s.slice(i + 1, j).trim();
      if (/^\d+$/.test(inner)) tokens.push(Number(inner));
      else if (/^"(?:[^"\\]|\\.)*"$/.test(inner)) {
        try { tokens.push(JSON.parse(inner)); } catch { return undefined; }
      } else return undefined;
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
    if (!m) return undefined;
    tokens.push(m[0]);
    i += m[0].length;
  }
  let cur = doc;
  for (const tok of tokens) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[tok];
  }
  return cur;
}

/** 該節點底下（含自己）的錯誤：{ list: [{key,msg}], count }。 */
export function errorsUnder(errors, path) {
  const map = normalizeErrors(errors);
  const out = [];
  if (!path) return { list: out, count: 0 };
  for (const [key, msg] of map) {
    if (key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) out.push({ key, msg });
  }
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { list: out, count: out.length };
}

/** 某欄位的錯誤訊息（精確路徑）。 */
export function errorForField(errors, path) {
  const hit = lookupError(errors, [path]);
  return hit.hasError ? String(hit.message || '') : '';
}

/** 由路徑推算「節點形狀簽章」：選取改變或陣列長度改變時需要整份重繪。 */
export function shapeSig(doc, selection) {
  const sel = selection || {};
  const path = doc ? pathForSelection(doc, sel) : null;
  if (!path) return `${sel.kind || ''}|${sel.id || ''}|none`;
  const value = readAtPath(doc, path);
  const keys = value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).join(',') : '';
  const arrLens = [];
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (Array.isArray(v)) arrLens.push(`${k}:${v.length}`);
    }
  }
  const collect = (v, depth = 0) => {
    if (!v || typeof v !== 'object' || depth > 2) return '';
    const acc = [];
    for (const [k, child] of Object.entries(v)) {
      if (Array.isArray(child)) acc.push(`${k}:${child.length}`);
      else if (child && typeof child === 'object') acc.push(`${k}{${Object.keys(child).length}}`);
    }
    return acc.join(',');
  };
  return `${sel.kind}|${path}|${keys}|${arrLens.join(',')}|${collect(value)}`;
}

/* =========================================================================
 * 2. 掛載層
 * ========================================================================= */

const instances = new WeakMap();

/** 取得真正的內容容器（#enc-tree → #enc-tree-body）。 */
function contentHost(rootEl) {
  if (!rootEl) return null;
  const id = rootEl.id;
  if (id && typeof document !== 'undefined') {
    const inner = document.getElementById(`${id}-body`);
    if (inner && inner !== rootEl && rootEl.contains(inner)) return inner;
  }
  return rootEl;
}

/**
 * 掛載檢查器。
 * @param {HTMLElement} rootEl #enc-inspector 或其 body
 * @param {{store:object, assets?:object|null, preview?:object|null, getAttacks?:Function}} ctx
 */
export function mount(rootEl, ctx = {}) {
  if (!rootEl) return { destroy() {} };
  const previous = instances.get(rootEl);
  if (previous && typeof previous.destroy === 'function') previous.destroy();

  ensureEncounterStyles();

  const store = ctx.store || null;
  const assets = ctx.assets || null;
  const host = contentHost(rootEl);

  const state = {
    destroyed: false,
    sections: {},
    textModes: new Map(),
    shape: '',
    lastErrorsSig: '',
    renderTimer: 0,
    bound: [],
    unsub: null,
    unsubLocale: null,
    title: '',
  };

  host.classList.add('enc-inspector-pane');

  /* ---------------- 寫入 ---------------- */

  const commit = (path, value, label) => {
    if (!store) return false;
    const undoLabel = label || T('undo.edit');
    try {
      if (typeof store.setAt === 'function') return store.setAt(path, value, { label: undoLabel });
      if (typeof store.update === 'function') {
        return store.update(
          (draft) => {
            writeAtPath(draft, path, value);
          },
          { label: undoLabel, paths: [String(path)] },
        );
      }
    } catch (err) {
      console.error('[encounter-inspector] 寫入失敗：', err);
    }
    return false;
  };

  // 座標拖曳等連續操作合併成一步復原
  const commitCoalesced = (path, value, coalesceKey, label) => {
    if (!store) return false;
    const undoLabel = label || T('undo.edit');
    try {
      if (typeof store.setAt === 'function') {
        return store.setAt(path, value, { label: undoLabel, coalesceKey });
      }
    } catch (err) {
      console.error('[encounter-inspector] 寫入失敗：', err);
    }
    return commit(path, value, undoLabel);
  };

  /* ---------------- 欄位建構 ---------------- */

  /** 欄位外框（標紅 + 錯誤訊息）。回傳 { el, sync?, setError }。 */
  const withError = (path, control) => {
    const wrap = el('div', { class: 'enc-field' });
    wrap.appendChild(control);
    const errEl = el('div', { class: 'pan-field-error' });
    wrap.appendChild(errEl);
    const sync = () => {
      const errs = store ? store.errors : null;
      const msg = path ? errorForField(errs, path) : '';
      errEl.textContent = msg;
      errEl.classList.toggle('show', !!msg);
      wrap.classList.toggle('has-error', !!msg);
      if (msg) wrap.title = msg;
      else wrap.removeAttribute('title');
    };
    sync();
    state.bound.push({ sync });
    return wrap;
  };

  /** 數字欄位：change/Enter 提交，Esc 還原。 */
  const numberInput = (path, value, opts = {}) => {
    const input = el('input', {
      type: 'number',
      class: 'pan-input pan-input-num enc-input-num',
      step: opts.step === undefined ? '1' : String(opts.step),
      min: opts.min === undefined ? null : String(opts.min),
      max: opts.max === undefined ? null : String(opts.max),
      placeholder: opts.placeholder || null,
    });
    const setInput = (v) => {
      input.value = v === null || v === undefined || v === '' ? '' : String(v);
    };
    setInput(value);
    const finish = () => {
      const raw = input.value.trim();
      if (raw === '') {
        if (opts.nullable) {
          commit(path, null, opts.label);
          return;
        }
        setInput(value);
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        setInput(value);
        return;
      }
      const out = opts.integer ? Math.round(n) : n;
      if (opts.min !== undefined && out < opts.min) setInput(value);
      else if (opts.max !== undefined && out > opts.max) setInput(value);
      else if (n !== out) setInput(out);
      if (n === value) return;
      commit(path, opts.integer ? Math.round(n) : n, opts.label);
    };
    input.addEventListener('change', finish);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        finish();
        input.blur();
      } else if (e.key === 'Escape') {
        setInput(value);
        input.blur();
      }
    });
    state.bound.push({
      sync: (doc) => {
        const v = readAtPath(doc, path);
        if (document.activeElement !== input) setInput(v);
      },
    });
    return input;
  };

  /** 單行文字欄位。 */
  const textOf = (path, value, opts = {}) => {
    const input = textInput(
      value === null || value === undefined ? '' : String(value),
      (next) => commit(path, next, opts.label),
      { mono: opts.mono, placeholder: opts.placeholder },
    );
    state.bound.push({
      sync: (doc) => {
        if (document.activeElement === input) return;
        const v = readAtPath(doc, path);
        input.value = v === null || v === undefined ? '' : String(v);
      },
    });
    return input;
  };

  /**
   * 文字欄位（單一 / 中英）。
   * 回傳一個容器，內含模式切換與對應輸入框。
   */
  const textField = (path, value, opts = {}) => {
    const wrap = el('div', { class: 'enc-textfield' });
    const modeBar = el('div', { class: 'enc-textmode' });
    const singleBtn = el('button', { type: 'button', class: 'enc-modebtn', text: T('insp.text.single') });
    const biBtn = el('button', { type: 'button', class: 'enc-modebtn', text: T('insp.text.bilingual') });
    modeBar.appendChild(singleBtn);
    modeBar.appendChild(biBtn);
    const body = el('div', { class: 'enc-textbody' });
    wrap.appendChild(modeBar);
    wrap.appendChild(body);

    let mode = state.textModes.get(path) || (isBilingualText(value) ? 'bi' : 'single');
    state.textModes.set(path, mode);

    const rows = [];
    const renderBody = () => {
      clear(body);
      rows.length = 0;
      singleBtn.classList.toggle('active', mode === 'single');
      biBtn.classList.toggle('active', mode === 'bi');
      const parsed = parseTextValue(value);
      if (mode === 'bi') {
        const mk = (label, lang) => {
          const input = textInput(parsed[lang] || '', (next) => {
            const cur = readAtPath(docOf(store) || {}, path);
            const p = parseTextValue(cur);
            p.mode = 'bi';
            p[lang] = next;
            commit(path, composeTextValue(p), opts.label);
          }, { placeholder: label, class: opts.mono ? 'pan-input-mono' : null });
          rows.push({ input, lang });
          const row = fieldRow(label, input, { class: 'enc-subrow' });
          return row;
        };
        if (opts.multiline) {
          // 中英模式的多行欄位仍用單行輸入（避免高度失控），換行以 \n 輸入
        }
        body.appendChild(mk(T('insp.text.zh'), 'zh'));
        body.appendChild(mk(T('insp.text.en'), 'en'));
        body.appendChild(el('div', { class: 'pan-hint', text: T('insp.text.hint') }));
      } else {
        const input = opts.multiline
          ? el('textarea', { class: 'pan-input enc-textarea', rows: '3', spellcheck: 'false' })
          : textInput(parsed.single, null, { class: opts.mono ? 'pan-input-mono' : null });
        input.value = parsed.single;
        input.placeholder = opts.placeholder || '';
        input.addEventListener('change', () => {
          const cur = readAtPath(docOf(store) || {}, path);
          const p = parseTextValue(cur);
          p.mode = 'single';
          p.single = input.value;
          commit(path, composeTextValue(p), opts.label);
        });
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter' && !opts.multiline) {
            e.preventDefault();
            input.dispatchEvent(new Event('change'));
            input.blur();
          } else if (e.key === 'Escape') {
            input.value = parseTextValue(readAtPath(docOf(store) || {}, path)).single;
            input.blur();
          }
        });
        rows.push({ input, lang: 'single' });
        body.appendChild(input);
      }
    };

    const switchMode = (next) => {
      if (next === mode) return;
      const cur = readAtPath(docOf(store) || {}, path);
      const p = parseTextValue(cur);
      if (next === 'bi') {
        p.mode = 'bi';
        if (!p.zh) p.zh = p.single || '';
      } else {
        p.mode = 'single';
        p.single = p.zh || p.single || '';
      }
      mode = next;
      state.textModes.set(path, mode);
      renderBody();
      commit(path, composeTextValue(p), opts.label);
    };

    singleBtn.addEventListener('click', () => switchMode('single'));
    biBtn.addEventListener('click', () => switchMode('bi'));
    renderBody();

    state.bound.push({
      sync: (doc) => {
        const cur = readAtPath(doc, path);
        const curMode = isBilingualText(cur) ? 'bi' : 'single';
        if (curMode !== mode && !isEditingIn(wrap)) {
          mode = curMode;
          state.textModes.set(path, mode);
          renderBody();
          return;
        }
        const parsed = parseTextValue(cur);
        for (const row of rows) {
          if (document.activeElement === row.input) continue;
          row.input.value = row.lang === 'single' ? parsed.single : parsed[row.lang] || '';
        }
      },
    });
    return wrap;
  };

  /** 下拉：字串選項清單。 */
  const selectField = (path, value, options, opts = {}) => {
    const sel = selectEl(
      options,
      value,
      (next) => commit(path, next, opts.label),
      { allowNull: opts.allowNull, nullLabel: opts.nullLabel },
    );
    state.bound.push({
      sync: (doc) => {
        if (document.activeElement === sel) return;
        const v = readAtPath(doc, path);
        sel.value = v === null || v === undefined ? '' : String(v);
      },
    });
    return sel;
  };

  /** 核取方塊。 */
  const boolField = (path, value, label, opts = {}) => {
    const wrap = checkboxEl(value ?? opts.defaultValue, (next) => commit(path, next, opts.label), label || null);
    state.bound.push({
      sync: (doc) => wrap.setChecked(readAtPath(doc, path) ?? opts.defaultValue),
    });
    return wrap;
  };

  /** 演員 id 下拉（含 null 選項）。 */
  const actorSelect = (path, value, doc, opts = {}) => {
    const ids = Object.keys((doc && doc.actors) || {});
    const options = ids.map((id) => ({ value: id, label: id }));
    const sel = selectEl(options, value, (next) => commit(path, next, opts.label), {
      allowNull: true,
      nullLabel: T('insp.noneActor'),
    });
    state.bound.push({
      sync: (d) => {
        if (document.activeElement === sel) return;
        const v = readAtPath(d, path);
        sel.value = v === null || v === undefined ? '' : String(v);
      },
    });
    return sel;
  };

  /** 可增刪的清單區塊（統一外觀）。 */
  const listBlock = (opts) => {
    const wrap = el('div', { class: 'enc-list' });
    if (!opts.items.length) {
      wrap.appendChild(el('div', { class: 'pan-empty-sub', text: opts.emptyText || '' }));
    }
    opts.items.forEach((item, i) => {
      const row = el('div', { class: 'enc-list-item' });
      if (opts.renderItem) row.appendChild(opts.renderItem(item, i));
      const tools = el('div', { class: 'enc-list-tools' });
      if (opts.onSelect) tools.appendChild(button('↗', { small: true, title: T('btn.open'), onClick: () => opts.onSelect(item, i) }));
      if (opts.onDelete) tools.appendChild(button('✕', { small: true, variant: 'danger', title: T('btn.delete'), onClick: () => opts.onDelete(item, i) }));
      row.appendChild(tools);
      wrap.appendChild(row);
    });
    return wrap;
  };

  /* ---------------- 各節點表單 ---------------- */

  const formSettings = (doc, path) => {
    const out = el('div', { class: 'enc-form' });
    const metaSec = section(T('insp.settings.meta'), null, { stateMap: state.sections, stateKey: 'st:meta' });
    metaSec.body.appendChild(fieldRow(T('insp.settings.name'), textField(`${path}.meta.name`, readAtPath(doc, `${path}.meta.name`), {})));
    metaSec.body.appendChild(fieldRow(T('insp.settings.author'), textOf(`${path}.meta.author`, readAtPath(doc, `${path}.meta.author`), {})));
    out.appendChild(metaSec);

    const basic = section(T('insp.section.basic'), null, { stateMap: state.sections, stateKey: 'st:basic' });
    basic.body.appendChild(
      fieldRow(
        T('insp.settings.format'),
        el('span', { class: 'enc-ro', text: String(doc.format || '—') }),
      ),
    );
    basic.body.appendChild(
      fieldRow(T('insp.settings.seed'), numberInput(`${path}.seed`, readAtPath(doc, `${path}.seed`), { integer: true, min: 0, label: T('undo.edit') })),
    );
    basic.body.appendChild(
      fieldRow(T('insp.settings.bgm'), textOf(`${path}.bgm`, readAtPath(doc, `${path}.bgm`), { mono: true, placeholder: T('insp.settings.bgmPh') })),
    );
    basic.body.appendChild(
      fieldRow(
        T('insp.settings.background'),
        withError(`${path}.background`, spriteField({
          value: readAtPath(doc, `${path}.background`),
          onChange: (v) => commit(`${path}.background`, v, T('undo.edit')),
          assets,
          nullable: true,
          placeholder: T('insp.settings.backgroundPh'),
        })),
      ),
    );
    basic.body.appendChild(
      fieldRow(T('insp.settings.introText'), textField(`${path}.introText`, readAtPath(doc, `${path}.introText`), { multiline: true })),
    );
    basic.body.appendChild(fieldRow(T('insp.settings.canFlee'), boolField(`${path}.canFlee`, readAtPath(doc, `${path}.canFlee`), T('insp.settings.canFlee'))));
    out.appendChild(basic);

    const orderSec = section(T('insp.settings.turnOrder'), null, { stateMap: state.sections, stateKey: 'st:turnOrder' });
    orderSec.body.appendChild(fieldRow(T('insp.settings.turnOrder'), turnOrderSelect(path)));
    out.appendChild(orderSec);
    return out;
  };

  const turnOrderSelect = (path) => {
    const doc = docOf(store) || {};
    const options = [
      { value: 'sequential', label: T('insp.turnOrder.sequential') },
      { value: 'loop-last', label: T('insp.turnOrder.loopLast') },
      { value: 'random', label: T('insp.turnOrder.random') },
    ];
    const sel = selectField('turnOrder', readAtPath(doc, 'turnOrder'), options, { label: T('undo.edit') });
    return sel;
  };

  const formActor = (doc, path, id) => {
    const out = el('div', { class: 'enc-form' });
    const basic = section(T('insp.section.basic'), null, { stateMap: state.sections, stateKey: 'ac:basic' });
    basic.body.appendChild(
      fieldRow(
        T('insp.actor.kind'),
        selectField(`${path}.kind`, readAtPath(doc, `${path}.kind`), [
          { value: 'party', label: T('insp.actor.kindParty') },
          { value: 'enemy', label: T('insp.actor.kindEnemy') },
        ]),
      ),
    );
    basic.body.appendChild(fieldRow('X', numberInput(`${path}.x`, readAtPath(doc, `${path}.x`), { step: 1 })));
    basic.body.appendChild(fieldRow('Y', numberInput(`${path}.y`, readAtPath(doc, `${path}.y`), { step: 1 })));
    basic.body.appendChild(
      hintBox(T('insp.actor.animsHint')),
    );
    out.appendChild(basic);

    const refs = actorUsage(doc, id);
    out.appendChild(
      section(
        T('insp.actor.usedBy', { list: refs.length ? String(refs.length) : '0' }),
        el('div', {
          class: 'pan-hint',
          text: refs.length ? refs.map((r) => r.path).join('\n') : T('insp.actor.noRefs'),
        }),
        { stateMap: state.sections, stateKey: 'ac:refs', collapsed: !refs.length },
      ),
    );
    return out;
  };

  const formParty = (doc, path, index) => {
    const out = el('div', { class: 'enc-form' });
    const cur = readAtPath(doc, path) || {};
    const basic = section(T('insp.section.basic'), null, { stateMap: state.sections, stateKey: 'pa:basic' });
    basic.body.appendChild(fieldRow(T('insp.party.id'), el('span', { class: 'enc-ro', text: String(cur.id ?? '') })));
    basic.body.appendChild(hintBox(T('insp.readonlyId')));
    basic.body.appendChild(fieldRow(T('insp.party.actor'), withError(`${path}.actor`, actorSelect(`${path}.actor`, cur.actor, doc))));
    basic.body.appendChild(fieldRow(T('insp.party.name'), withError(`${path}.name`, textField(`${path}.name`, cur.name, {}))));
    basic.body.appendChild(
      fieldRow(
        T('insp.party.icon'),
        withError(`${path}.icon`, spriteField({
          value: cur.icon,
          onChange: (v) => commit(`${path}.icon`, v, T('undo.edit')),
          assets,
          nullable: true,
        })),
      ),
    );
    basic.body.appendChild(fieldRow(T('insp.party.hp'), withError(`${path}.hp`, numberInput(`${path}.hp`, cur.hp, { integer: true, min: 0 }))));
    basic.body.appendChild(fieldRow(T('insp.party.maxHp'), withError(`${path}.maxHp`, numberInput(`${path}.maxHp`, cur.maxHp, { integer: true, min: 0 }))));
    basic.body.appendChild(fieldRow(T('insp.party.atk'), withError(`${path}.atk`, numberInput(`${path}.atk`, cur.atk, { integer: true }))));
    basic.body.appendChild(fieldRow(T('insp.party.def'), withError(`${path}.def`, numberInput(`${path}.def`, cur.def, { integer: true }))));
    basic.body.appendChild(fieldRow(T('insp.party.magic'), withError(`${path}.magic`, numberInput(`${path}.magic`, cur.magic, { integer: true }))));
    basic.body.appendChild(
      fieldRow(
        T('insp.party.color'),
        colorField(cur.color, (v) => commit(`${path}.color`, v, T('undo.edit')), { nullable: false }),
      ),
    );
    out.appendChild(basic);

    const cmdSec = section(T('insp.party.commands'), null, { stateMap: state.sections, stateKey: 'pa:commands' });
    const cmdWrap = el('div', { class: 'enc-commands' });
    for (const cmd of COMMANDS) {
      const checked = Array.isArray(cur.commands) && cur.commands.includes(cmd);
      const box = checkboxEl(checked, (next) => {
        const docNow = docOf(store) || {};
        const list = readAtPath(docNow, `${path}.commands`);
        const arr = Array.isArray(list) ? list.slice() : [];
        const at = arr.indexOf(cmd);
        if (next && at < 0) arr.push(cmd);
        if (!next && at >= 0) arr.splice(at, 1);
        // 依固定順序排列
        arr.sort((a, b) => COMMANDS.indexOf(a) - COMMANDS.indexOf(b));
        commit(`${path}.commands`, arr, T('undo.edit'));
      }, T(`insp.command.${cmd}`));
      cmdWrap.appendChild(box);
    }
    cmdSec.body.appendChild(cmdWrap);
    out.appendChild(cmdSec);

    const spells = Array.isArray(cur.spells) ? cur.spells : [];
    const spellSec = section(T('insp.party.spells'), null, { stateMap: state.sections, stateKey: 'pa:spells' });
    spellSec.body.appendChild(
      listBlock({
        items: spells,
        emptyText: T('insp.party.noSpells'),
        renderItem: (spell, j) => {
          const row = el('div', { class: 'enc-list-main' });
          const btn = button(String(spell && spell.name ? displayAny(spell.name) : (spell && spell.id) || `#${j + 1}`), {
            small: true,
            title: T('insp.spell.title', { name: displayAny(spell && spell.name) || String(spell && spell.id) }),
            onClick: () => selectPart(KIND.spell, spell && spell.id, `${path}.spells[${j}]`),
          });
          row.appendChild(btn);
          row.appendChild(el('span', { class: 'enc-list-note', text: T('insp.turn.cueCount', { n: (spell && spell.cues && spell.cues.length) || 0 }) }));
          return row;
        },
        onDelete: (spell, j) => deleteAt(`${path}.spells[${j}]`, -1),
      }),
    );
    spellSec.body.appendChild(
      button(T('btn.add'), {
        small: true,
        onClick: () => {
          const id = uniqueLocal('spell', spells.map((s) => String((s && s.id) || '')));
          commit(`${path}.spells`, [...spells, { id, name: id, tp: 0, target: 'enemy', cues: [] }], T('undo.add'));
          selectPart(KIND.spell, id, `${path}.spells[${spells.length}]`);
        },
      }),
    );
    out.appendChild(spellSec);
    return out;
  };

  const formSpell = (doc, path) => {
    const cur = readAtPath(doc, path) || {};
    const out = el('div', { class: 'enc-form' });
    const basic = section(T('insp.section.basic'), null, { stateMap: state.sections, stateKey: 'sp:basic' });
    basic.body.appendChild(fieldRow(T('insp.spell.id'), el('span', { class: 'enc-ro', text: String(cur.id ?? '') })));
    basic.body.appendChild(fieldRow(T('insp.spell.name'), withError(`${path}.name`, textField(`${path}.name`, cur.name, {}))));
    basic.body.appendChild(fieldRow(T('insp.spell.tp'), withError(`${path}.tp`, numberInput(`${path}.tp`, cur.tp, { integer: true, min: 0 }))));
    basic.body.appendChild(
      fieldRow(
        T('insp.spell.target'),
        withError(
          `${path}.target`,
          selectField(`${path}.target`, cur.target, [
            { value: 'enemy', label: T('insp.target.enemy') },
            { value: 'party', label: T('insp.target.party') },
            { value: 'all', label: T('insp.target.all') },
          ]),
        ),
      ),
    );
    out.appendChild(basic);
    out.appendChild(cuesSection(`${path}.cues`));
    return out;
  };

  const formEnemy = (doc, path, index) => {
    const cur = readAtPath(doc, path) || {};
    const out = el('div', { class: 'enc-form' });
    const basic = section(T('insp.section.basic'), null, { stateMap: state.sections, stateKey: 'en:basic' });
    basic.body.appendChild(fieldRow(T('insp.enemy.id'), el('span', { class: 'enc-ro', text: String(cur.id ?? '') })));
    basic.body.appendChild(hintBox(T('insp.readonlyId')));
    basic.body.appendChild(fieldRow(T('insp.enemy.actor'), withError(`${path}.actor`, actorSelect(`${path}.actor`, cur.actor, doc))));
    basic.body.appendChild(fieldRow(T('insp.enemy.name'), withError(`${path}.name`, textField(`${path}.name`, cur.name, {}))));
    basic.body.appendChild(fieldRow(T('insp.enemy.hp'), withError(`${path}.hp`, numberInput(`${path}.hp`, cur.hp, { integer: true, min: 0 }))));
    basic.body.appendChild(fieldRow(T('insp.enemy.maxHp'), withError(`${path}.maxHp`, numberInput(`${path}.maxHp`, cur.maxHp, { integer: true, min: 0 }))));
    basic.body.appendChild(fieldRow(T('insp.enemy.atk'), withError(`${path}.atk`, numberInput(`${path}.atk`, cur.atk, { integer: true }))));
    basic.body.appendChild(fieldRow(T('insp.enemy.def'), withError(`${path}.def`, numberInput(`${path}.def`, cur.def, { integer: true }))));
    basic.body.appendChild(fieldRow(T('insp.enemy.mercy'), withError(`${path}.mercy`, numberInput(`${path}.mercy`, cur.mercy, { integer: true, min: 0 }))));
    basic.body.appendChild(fieldRow(T('insp.enemy.spareAt'), withError(`${path}.spareAt`, numberInput(`${path}.spareAt`, cur.spareAt, { integer: true, min: 0 }))));
    basic.body.appendChild(fieldRow(T('insp.enemy.tired'), boolField(`${path}.tired`, cur.tired, T('insp.enemy.tired'))));
    out.appendChild(basic);

    // ACT 列表（可在這裡直接編輯 name / party / mercy / text）
    const acts = Array.isArray(cur.acts) ? cur.acts : [];
    const actSec = section(T('insp.enemy.acts'), null, { stateMap: state.sections, stateKey: 'en:acts' });
    if (!acts.length) actSec.body.appendChild(el('div', { class: 'pan-empty-sub', text: T('insp.enemy.noActs') }));
    acts.forEach((act, j) => {
      const actPath = `${path}.acts[${j}]`;
      const box = el('div', { class: 'enc-subcard' });
      const head = el('div', { class: 'enc-subcard-head' });
      head.appendChild(
        button(String((act && act.name && displayAny(act.name)) || `ACT ${j + 1}`), {
          small: true,
          title: T('insp.act.title', { name: displayAny(act && act.name) || String(j + 1) }),
          onClick: () => selectPart(KIND.act, act && act.id, actPath),
        }),
      );
      head.appendChild(button('✕', { small: true, variant: 'danger', title: T('btn.delete'), onClick: () => deleteAt(actPath, -1) }));
      box.appendChild(head);
      box.appendChild(fieldRow(T('insp.act.name'), withError(`${actPath}.name`, textField(`${actPath}.name`, act && act.name, {}))));
      box.appendChild(fieldRow(T('insp.act.party'), actPartyField(actPath, act, doc)));
      box.appendChild(fieldRow(T('insp.act.autoAnim'), boolField(`${actPath}.autoAnim`, act?.autoAnim, null, { defaultValue: true })));
      box.appendChild(fieldRow(T('insp.act.mercy'), withError(`${actPath}.mercy`, numberInput(`${actPath}.mercy`, act && act.mercy, { integer: true, min: 0 }))));
      box.appendChild(fieldRow(T('insp.act.text'), withError(`${actPath}.text`, textField(`${actPath}.text`, act && act.text, { multiline: true }))));
      actSec.body.appendChild(box);
    });
    actSec.body.appendChild(
      button(T('btn.add'), {
        small: true,
        onClick: () => {
          const id = uniqueLocal('act', acts.map((a) => String((a && a.id) || '')));
          commit(`${path}.acts`, [...acts, { id, name: id, party: [], mercy: 0, text: '', cues: [] }], T('undo.add'));
        },
      }),
    );
    out.appendChild(actSec);

    const cueSec = section(T('insp.enemy.cues'), null, { stateMap: state.sections, stateKey: 'en:cues' });
    for (const key of ['onHurt', 'onSpare', 'onDefeat']) {
      const cpath = `${path}.${key}`;
      const cues = readAtPath(doc, cpath);
      cueSec.body.appendChild(
        fieldRow(
          T(`tree.${key}`),
          el('div', { class: 'enc-cuerow' }, [
            el('span', { class: 'enc-list-note', text: T('insp.turn.cueCount', { n: Array.isArray(cues) ? cues.length : 0 }) }),
            button(T('insp.hook.open'), { small: true, onClick: () => openCuePath(cpath) }),
          ]),
        ),
      );
    }
    out.appendChild(cueSec);
    return out;
  };

  const actPartyField = (actPath, act, doc) => {
    const members = Array.isArray(doc.party) ? doc.party : [];
    const wrap = el('div', { class: 'enc-multiselect' });
    const current = Array.isArray(act && act.party) ? act.party : [];
    for (const member of members) {
      const id = String((member && member.id) || '');
      if (!id) continue;
      const box = checkboxEl(
        current.includes(id),
        (next) => {
          const docNow = docOf(store) || {};
          const list = readAtPath(docNow, `${actPath}.party`);
          const arr = Array.isArray(list) ? list.slice() : [];
          const at = arr.indexOf(id);
          if (next && at < 0) arr.push(id);
          if (!next && at >= 0) arr.splice(at, 1);
          commit(`${actPath}.party`, arr, T('undo.edit'));
        },
        id,
      );
      wrap.appendChild(box);
    }
    if (!wrap.childNodes.length) wrap.appendChild(el('span', { class: 'pan-empty-sub', text: T('insp.act.partyHint') }));
    else wrap.appendChild(el('div', { class: 'pan-hint', text: T('insp.act.partyHint') }));
    return withError(`${actPath}.party`, wrap);
  };

  const formAct = (doc, path) => {
    const cur = readAtPath(doc, path) || {};
    const out = el('div', { class: 'enc-form' });
    const basic = section(T('insp.section.basic'), null, { stateMap: state.sections, stateKey: 'at:basic' });
    basic.body.appendChild(fieldRow(T('insp.act.id'), el('span', { class: 'enc-ro', text: String(cur.id ?? '') })));
    basic.body.appendChild(hintBox(T('insp.readonlyId')));
    basic.body.appendChild(fieldRow(T('insp.act.name'), withError(`${path}.name`, textField(`${path}.name`, cur.name, {}))));
    basic.body.appendChild(fieldRow(T('insp.act.party'), actPartyField(path, cur, doc)));
    basic.body.appendChild(fieldRow(T('insp.act.autoAnim'), boolField(`${path}.autoAnim`, cur.autoAnim, null, { defaultValue: true })));
    basic.body.appendChild(fieldRow(T('insp.act.mercy'), withError(`${path}.mercy`, numberInput(`${path}.mercy`, cur.mercy, { integer: true, min: 0 }))));
    basic.body.appendChild(fieldRow(T('insp.act.text'), withError(`${path}.text`, textField(`${path}.text`, cur.text, { multiline: true }))));
    out.appendChild(basic);
    out.appendChild(cuesSection(`${path}.cues`));
    return out;
  };

  const formItem = (doc, path) => {
    const cur = readAtPath(doc, path) || {};
    const out = el('div', { class: 'enc-form' });
    const basic = section(T('insp.section.basic'), null, { stateMap: state.sections, stateKey: 'it:basic' });
    basic.body.appendChild(fieldRow(T('insp.item.id'), el('span', { class: 'enc-ro', text: String(cur.id ?? '') })));
    basic.body.appendChild(hintBox(T('insp.readonlyId')));
    basic.body.appendChild(fieldRow(T('insp.item.name'), withError(`${path}.name`, textField(`${path}.name`, cur.name, {}))));
    basic.body.appendChild(fieldRow(T('insp.item.count'), withError(`${path}.count`, numberInput(`${path}.count`, cur.count, { integer: true, min: 0 }))));
    basic.body.appendChild(fieldRow(T('insp.item.heal'), withError(`${path}.heal`, numberInput(`${path}.heal`, cur.heal, { integer: true }))));
    basic.body.appendChild(
      fieldRow(
        T('insp.item.target'),
        withError(
          `${path}.target`,
          selectField(`${path}.target`, cur.target, [
            { value: 'party', label: T('insp.target.party') },
            { value: 'enemy', label: T('insp.target.enemy') },
            { value: 'all', label: T('insp.target.all') },
          ]),
        ),
      ),
    );
    basic.body.appendChild(fieldRow(T('insp.item.revive'), boolField(`${path}.revive`, cur.revive)));
    basic.body.appendChild(fieldRow(T('insp.item.text'), withError(`${path}.text`, textField(`${path}.text`, cur.text, { multiline: true }))));
    out.appendChild(basic);
    return out;
  };

  const formTurn = (doc, path, index) => {
    const cur = readAtPath(doc, path) || {};
    const out = el('div', { class: 'enc-form' });
    const basic = section(T('insp.section.basic'), null, { stateMap: state.sections, stateKey: 'tu:basic' });
    basic.body.appendChild(fieldRow(T('insp.turn.id'), el('span', { class: 'enc-ro', text: String(cur.id ?? '') })));
    basic.body.appendChild(hintBox(T('insp.readonlyId')));
    basic.body.appendChild(fieldRow(T('insp.turn.flavor'), withError(`${path}.flavor`, textField(`${path}.flavor`, cur.flavor, { multiline: true }))));
    basic.body.appendChild(fieldRow(T('insp.turn.attack'), withError(`${path}.attack`, attackField(`${path}.attack`, cur.attack))));
    out.appendChild(basic);

    const orderSec = section(T('insp.settings.turnOrder'), null, { stateMap: state.sections, stateKey: 'tu:order' });
    orderSec.body.appendChild(fieldRow(T('insp.settings.turnOrder'), turnOrderSelect('turnOrder')));
    out.appendChild(orderSec);

    const talk = Array.isArray(cur.talk) ? cur.talk : [];
    const talkSec = section(T('insp.turn.talk'), null, { stateMap: state.sections, stateKey: 'tu:talk' });
    if (!talk.length) talkSec.body.appendChild(el('div', { class: 'pan-empty-sub', text: T('insp.turn.noTalk') }));
    talk.forEach((bubble, k) => {
      const bpath = `${path}.talk[${k}]`;
      const box = el('div', { class: 'enc-subcard' });
      const head = el('div', { class: 'enc-subcard-head' });
      head.appendChild(el('span', { class: 'enc-list-note', text: String(k + 1) }));
      head.appendChild(button('✕', { small: true, variant: 'danger', title: T('btn.delete'), onClick: () => deleteAt(bpath, -1) }));
      box.appendChild(head);
      box.appendChild(fieldRow(T('insp.talk.actor'), withError(`${bpath}.actor`, actorSelect(`${bpath}.actor`, bubble && bubble.actor, doc))));
      box.appendChild(fieldRow(T('insp.talk.text'), withError(`${bpath}.text`, textField(`${bpath}.text`, bubble && bubble.text, { multiline: true }))));
      talkSec.body.appendChild(box);
    });
    talkSec.body.appendChild(
      button(T('btn.add'), {
        small: true,
        onClick: () => {
          const actors = Object.keys(doc.actors || {});
          commit(`${path}.talk`, [...talk, { actor: actors[0] || null, text: '' }], T('undo.add'));
        },
      }),
    );
    out.appendChild(talkSec);

    const cueSec = section(T('insp.section.list'), null, { stateMap: state.sections, stateKey: 'tu:cues' });
    for (const key of TURN_CUE_KEYS) {
      const cpath = `${path}.${key}`;
      const cues = readAtPath(doc, cpath);
      cueSec.body.appendChild(
        fieldRow(
          T(`insp.turn.${key}`),
          el('div', { class: 'enc-cuerow' }, [
            el('span', { class: 'enc-list-note', text: T('insp.turn.cueCount', { n: Array.isArray(cues) ? cues.length : 0 }) }),
            button(T('insp.hook.open'), { small: true, onClick: () => openCuePath(cpath) }),
          ]),
        ),
      );
    }
    out.appendChild(cueSec);
    return out;
  };

  const formTalk = (doc, path) => {
    const cur = readAtPath(doc, path) || {};
    const out = el('div', { class: 'enc-form' });
    const basic = section(T('insp.section.basic'), null, { stateMap: state.sections, stateKey: 'ta:basic' });
    basic.body.appendChild(fieldRow(T('insp.talk.actor'), withError(`${path}.actor`, actorSelect(`${path}.actor`, cur.actor, doc))));
    basic.body.appendChild(fieldRow(T('insp.talk.text'), withError(`${path}.text`, textField(`${path}.text`, cur.text, { multiline: true }))));
    out.appendChild(basic);
    return out;
  };

  const attackField = (path, value) => {
    const names = availableAttacks();
    if (names.length) {
      const options = names.map((n) => (n && typeof n === 'object' ? { value: n.value ?? n.name, label: n.label ?? n.name } : { value: n, label: String(n) }));
      return selectField(path, value, options, { allowNull: true, nullLabel: T('insp.turn.attackNone'), label: T('undo.edit') });
    }
    return textOf(path, value, { mono: true, placeholder: T('insp.turn.attackNone') });
  };

  const cuesSection = (path) => {
    const doc = docOf(store) || {};
    const cues = readAtPath(doc, path);
    const sec = section(T('insp.cues.title'), null, { stateMap: state.sections, stateKey: `cues:${path}` });
    sec.body.appendChild(el('div', { class: 'pan-hint', text: T('insp.cues.hint') }));
    const list = Array.isArray(cues) ? cues : [];
    if (!list.length) sec.body.appendChild(el('div', { class: 'pan-empty-sub', text: T('insp.cues.empty') }));
    const ul = el('div', { class: 'enc-cuelist' });
    list.forEach((cue) => {
      ul.appendChild(el('div', { class: 'enc-cueitem', text: String((cue && cue.cmd) || T('insp.cues.summary', { cmd: '?' })) }));
    });
    if (list.length) sec.body.appendChild(ul);
    sec.body.appendChild(button(T('insp.hook.open'), { small: true, onClick: () => openCuePath(path) }));
    return sec;
  };

  const formCues = (doc, path) => {
    const out = el('div', { class: 'enc-form' });
    const list = readAtPath(doc, path);
    const arr = Array.isArray(list) ? list : [];
    const sec = section(T('insp.cues.title'), null, { stateMap: state.sections, stateKey: `hook:${path}` });
    sec.body.appendChild(el('div', { class: 'pan-hint', text: T('insp.hook.hint') }));
    sec.body.appendChild(el('div', { class: 'enc-ro', text: T('insp.hook.cueCount', { n: arr.length }) }));
    if (!arr.length) sec.body.appendChild(el('div', { class: 'pan-empty-sub', text: T('insp.cues.empty') }));
    else {
      const ul = el('div', { class: 'enc-cuelist' });
      for (const cue of arr) {
        ul.appendChild(el('div', { class: 'enc-cueitem', text: String((cue && cue.cmd) || '?') }));
      }
      sec.body.appendChild(ul);
    }
    sec.body.appendChild(button(T('insp.hook.open'), { variant: 'primary', small: true, onClick: () => openCuePath(path) }));
    out.appendChild(sec);
    return out;
  };

  const formVar = (doc, path, name) => {
    const out = el('div', { class: 'enc-form' });
    const sec = section(T('insp.vars.title'), null, { stateMap: state.sections, stateKey: 'va:one' });
    sec.body.appendChild(fieldRow(T('insp.vars.key'), el('span', { class: 'enc-ro', text: String(name) })));
    sec.body.appendChild(fieldRow(T('insp.vars.value'), numberInput(path, readAtPath(doc, path), { step: 'any', label: T('undo.edit') })));
    sec.body.appendChild(hintBox(T('insp.vars.renameHint')));
    out.appendChild(sec);
    return out;
  };

  const formVars = (doc, path) => {
    const out = el('div', { class: 'enc-form' });
    const docNow = docOf(store) || {};
    const vars = (docNow && docNow.vars) || {};
    const names = Object.keys(vars);
    const sec = section(T('insp.vars.title'), null, { stateMap: state.sections, stateKey: 'va:all' });
    if (!names.length) sec.body.appendChild(el('div', { class: 'pan-empty-sub', text: T('insp.vars.empty') }));
    for (const name of names) {
      const row = el('div', { class: 'enc-varrow' });
      row.appendChild(el('span', { class: 'enc-varname', text: name }));
      row.appendChild(numberInput(`vars.${quoteKey(name)}`, vars[name], { step: 'any' }));
      row.appendChild(
        button('✕', {
          small: true,
          variant: 'danger',
          title: T('btn.delete'),
          onClick: () => {
            const d = docOf(store) || {};
            const copy = { ...(d.vars || {}) };
            delete copy[name];
            commit('vars', copy, T('undo.delete'));
          },
        }),
      );
      sec.body.appendChild(row);
    }
    sec.body.appendChild(
      button(T('btn.add'), {
        small: true,
        onClick: () => {
          const d = docOf(store) || {};
          const existing = Object.keys(d.vars || {});
          const name = uniqueLocal('newVar', existing);
          commit('vars', { ...(d.vars || {}), [name]: 0 }, T('undo.add'));
        },
      }),
    );
    out.appendChild(sec);
    return out;
  };

  /* ---------------- 小工具 ---------------- */

  const openCuePath = (path) => {
    writeCuePath(store, path, null);
    const doc = docOf(store);
    if (doc) render();
  };

  const selectPart = (kind, id, path) => {
    if (!store) return;
    try {
      if (typeof store.setSelection === 'function') store.setSelection({ kind, id, path });
      else store.select(kind, id, path);
    } catch (err) {
      console.warn('[encounter-inspector] 選取失敗：', err);
    }
  };

  const deleteAt = (path, _index) => {
    const doc = docOf(store) || {};
    const parentPath = path.replace(/\[(\d+)\]$/, '');
    const m = /\[(\d+)\]$/.exec(path);
    if (!m) return;
    const arr = readAtPath(doc, parentPath);
    if (!Array.isArray(arr)) return;
    const copy = arr.slice();
    copy.splice(Number(m[1]), 1);
    commit(parentPath, copy, T('undo.delete'));
  };

  const uniqueLocal = (base, taken) => {
    const used = new Set((taken || []).map(String));
    if (!used.has(base)) return base;
    let n = 2;
    while (used.has(`${base}${n}`)) n += 1;
    return `${base}${n}`;
  };

  const displayAny = (v) => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (isBilingualText(v)) {
      const lang = dataLang(getLocale());
      return String(v[lang] !== undefined && v[lang] !== null && v[lang] !== '' ? v[lang] : v.zh ?? v.en ?? '');
    }
    return '';
  };

  const availableAttacks = () => {
    try {
      if (typeof ctx.getAttacks === 'function') {
        const list = ctx.getAttacks();
        if (Array.isArray(list)) return list.map((it) => it);
      }
      if (Array.isArray(ctx.attacks)) return ctx.attacks;
    } catch (err) {
      console.warn('[encounter-inspector] getAttacks 失敗：', err);
    }
    return [];
  };

  /* ---------------- 主渲染 ---------------- */

  const errorsPanel = (path, errors) => {
    const { list } = errorsUnder(errors, path);
    if (!list.length) return null;
    const sec = section(T('insp.errors.title', { n: list.length }), null, { stateMap: state.sections, stateKey: 'errors', class: 'enc-errors' });
    const shown = list.slice(0, 20);
    for (const it of shown) {
      sec.body.appendChild(el('div', { class: 'enc-errrow', text: T('insp.errRow', { key: it.key, msg: it.msg }) }));
    }
    if (list.length > shown.length) {
      sec.body.appendChild(el('div', { class: 'pan-hint', text: T('insp.errors.more', { n: list.length - shown.length }) }));
    }
    return sec;
  };

  const header = (title, sub) => {
    const h = el('div', { class: 'enc-insp-header' });
    h.appendChild(el('div', { class: 'enc-insp-title', text: title }));
    if (sub) h.appendChild(el('div', { class: 'enc-insp-sub', text: sub }));
    return h;
  };

  const render = () => {
    if (state.destroyed) return;
    const scrollTop = host.scrollTop;
    clear(host);
    state.bound = [];

    const doc = docOf(store);
    const sel = readSelection(store);

    if (!doc) {
      host.appendChild(header(T('insp.none.title')));
      host.appendChild(emptyState(T('insp.none.title'), T('tip.noDoc')));
      return;
    }
    if (!sel.kind) {
      host.appendChild(header(T('insp.none.title')));
      host.appendChild(emptyState(T('insp.none.title'), T('insp.none.sub')));
      return;
    }

    const target = resolveTarget(doc, sel);
    if (!target.found) {
      host.appendChild(header(T('insp.none.title')));
      host.appendChild(emptyState(T('insp.missingNode'), sel.path || ''));
      state.shape = shapeSig(doc, sel);
      return;
    }

    const errors = store ? store.errors : null;
    const path = target.path;
    const cur = target.value;
    let title = T('insp.none.title');
    let sub = path || '';

    switch (target.kind) {
      case KIND.settings:
        title = T('insp.settings.title');
        sub = String((doc.meta && doc.meta.name) || '');
        host.appendChild(formSettings(doc, 'settings'));
        break;
      case KIND.actor: {
        const id = String(sel.id ?? '');
        const anims = cur && cur.anims ? Object.keys(cur.anims) : [];
        title = T('insp.actor.title', { id });
        sub = `${anims.length} anims`;
        host.appendChild(formActor(doc, path, id));
        break;
      }
      case KIND.party: {
        const name = displayAny(cur && cur.name);
        title = T('insp.party.title', { name: name || String((cur && cur.id) || '') });
        host.appendChild(formParty(doc, path, 0));
        break;
      }
      case KIND.enemy: {
        const name = displayAny(cur && cur.name);
        title = T('insp.enemy.title', { name: name || String((cur && cur.id) || '') });
        host.appendChild(formEnemy(doc, path, 0));
        break;
      }
      case KIND.act: {
        const name = displayAny(cur && cur.name);
        title = T('insp.act.title', { name: name || String((cur && cur.id) || '') });
        host.appendChild(formAct(doc, path));
        break;
      }
      case KIND.spell: {
        const name = displayAny(cur && cur.name);
        title = T('insp.spell.title', { name: name || String((cur && cur.id) || '') });
        host.appendChild(formSpell(doc, path));
        break;
      }
      case KIND.item: {
        const name = displayAny(cur && cur.name);
        title = T('insp.item.title', { name: name || String((cur && cur.id) || '') });
        host.appendChild(formItem(doc, path));
        break;
      }
      case KIND.turn: {
        const idx = (cur && cur.id ? String(cur.id) : '') || '#';
        title = T('insp.turn.title', { i: idx });
        host.appendChild(formTurn(doc, path, 0));
        break;
      }
      case KIND.talk:
        title = T('insp.turn.talk');
        host.appendChild(formTalk(doc, path));
        break;
      case KIND.cues: {
        const label = hookLabel(path);
        title = T('insp.hook.title', { name: label });
        host.appendChild(formCues(doc, path));
        break;
      }
      case KIND.var: {
        const name = String(sel.id ?? '');
        title = T('insp.vars.title');
        sub = name;
        host.appendChild(formVar(doc, path, name));
        break;
      }
      case KIND.vars:
        title = T('insp.vars.title');
        host.appendChild(formVars(doc, path));
        break;
      default:
        host.appendChild(header(title, sub));
        host.appendChild(emptyState(T('insp.none.sub')));
        break;
    }

    // 標題放在最前面（各表單已先 append，這裡用 insertBefore）
    const h = header(title, sub);
    host.insertBefore(h, host.firstChild);

    const errSec = errorsPanel(path, errors);
    if (errSec) host.appendChild(errSec);

    state.shape = shapeSig(doc, sel);
    state.lastErrorsSig = errorsSig();
    host.scrollTop = scrollTop;
    updateExternalLabel(title);
  };

  const updateExternalLabel = (title) => {
    if (typeof document === 'undefined') return;
    try {
      const label = document.getElementById('enc-selection-label');
      if (label) label.textContent = title;
    } catch {
      /* 忽略 */
    }
  };

  const hookLabel = (path) => {
    const m = /^hooks\.(\w+)$/.exec(path);
    if (m) return T(`insp.hook.${m[1]}`);
    const e = /^enemies\[(\d+)\]\.(\w+)$/.exec(path);
    if (e) return T(`tree.${e[2]}`);
    return path;
  };

  const errorsSig = () => {
    const errs = store ? store.errors : null;
    if (!errs) return '';
    const map = normalizeErrors(errs);
    const parts = [];
    for (const [k, v] of map) parts.push(`${k}=${v}`);
    parts.sort();
    return parts.join('\n');
  };

  /* ---------------- 變更處理 ---------------- */

  const sync = () => {
    if (state.destroyed) return;
    const doc = docOf(store) || {};
    for (const b of state.bound) {
      try {
        b.sync(doc);
      } catch (err) {
        console.warn('[encounter-inspector] 同步欄位失敗：', err);
      }
    }
  };

  const scheduleRender = () => {
    if (state.destroyed || state.renderTimer) return;
    state.renderTimer = setTimeout(() => {
      state.renderTimer = 0;
      if (state.destroyed) return;
      if (isEditingIn(host)) {
        scheduleRender();
        return;
      }
      render();
    }, 0);
  };

  const onStoreChange = (change) => {
    if (state.destroyed) return;
    const doc = docOf(store) || {};
    const sel = readSelection(store);
    const sig = shapeSig(doc, sel);
    if (sig !== state.shape) {
      render();
      return;
    }
    const es = errorsSig();
    if ((change && change.errors) || es !== state.lastErrorsSig) {
      state.lastErrorsSig = es;
      if (isEditingIn(host)) scheduleRender();
      else render();
      return;
    }
    sync();
  };

  /* ---------------- 生命週期 ---------------- */

  render();

  if (store && typeof store.subscribe === 'function') {
    const unsub = store.subscribe((_s, change) => onStoreChange(change));
    state.unsub = typeof unsub === 'function' ? unsub : null;
  }
  state.unsubLocale = onLocaleChange(() => {
    if (state.destroyed) return;
    render();
  });

  const controller = {
    destroy() {
      state.destroyed = true;
      if (state.renderTimer) clearTimeout(state.renderTimer);
      state.renderTimer = 0;
      if (typeof state.unsub === 'function') state.unsub();
      if (typeof state.unsubLocale === 'function') state.unsubLocale();
      clear(host);
      host.classList.remove('enc-inspector-pane');
      instances.delete(rootEl);
    },
    refresh: () => render(),
    get path() {
      const doc = docOf(store);
      return doc ? pathForSelection(doc, readSelection(store)) : null;
    },
  };
  instances.set(rootEl, controller);
  return controller;
}

/** 支援的指令按鈕順序（SPEC-P2 §1）。 */
export const COMMANDS = ['fight', 'act', 'magic', 'item', 'spare', 'defend'];

/** 列出某演員被誰引用（給 inspector 顯示）。 */
export function actorUsage(doc, actorId) {
  const out = [];
  if (!doc || !actorId) return out;
  const id = String(actorId);
  (Array.isArray(doc.party) ? doc.party : []).forEach((m, i) => {
    if (m && String(m.actor) === id) out.push({ path: `party[${i}].actor`, kind: 'party' });
  });
  (Array.isArray(doc.enemies) ? doc.enemies : []).forEach((m, i) => {
    if (m && String(m.actor) === id) out.push({ path: `enemies[${i}].actor`, kind: 'enemy' });
  });
  (Array.isArray(doc.turns) ? doc.turns : []).forEach((turn, i) => {
    (Array.isArray(turn && turn.talk) ? turn.talk : []).forEach((b, k) => {
      if (b && String(b.actor) === id) out.push({ path: `turns[${i}].talk[${k}].actor`, kind: 'talk' });
    });
  });
  return out;
}

/** 就地寫路徑（store.update 沒有 setAt 時的後備）。 */
export function writeAtPath(doc, path, value) {
  if (!doc || !path) return false;
  const tokens = [];
  const s = String(path);
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '.' || c === ' ') { i += 1; continue; }
    if (c === '[') {
      const j = s.indexOf(']', i);
      if (j < 0) return false;
      const inner = s.slice(i + 1, j).trim();
      if (/^\d+$/.test(inner)) tokens.push(Number(inner));
      else if (/^"(?:[^"\\]|\\.)*"$/.test(inner)) {
        try { tokens.push(JSON.parse(inner)); } catch { return false; }
      } else return false;
      i = j + 1;
      continue;
    }
    const m = /^[A-Za-z_$][\w$]*/.exec(s.slice(i));
    if (!m) return false;
    tokens.push(m[0]);
    i += m[0].length;
  }
  if (!tokens.length) return false;
  let cur = doc;
  for (let k = 0; k < tokens.length - 1; k += 1) {
    const tok = tokens[k];
    if (cur[tok] === null || typeof cur[tok] !== 'object') {
      cur[tok] = typeof tokens[k + 1] === 'number' ? [] : {};
    }
    cur = cur[tok];
  }
  cur[tokens[tokens.length - 1]] = value;
  return true;
}

export { ensureStructure };
export default { mount, resolveTarget, pathForSelection };
