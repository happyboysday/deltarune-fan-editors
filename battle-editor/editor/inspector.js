// editor/inspector.js  (ED3)
//
// 屬性檢查器：掛在 #inspector（ED1 於 index.html 提供）。
//
// 依 store.selection 顯示：
//   - event      → 依 SPEC §4 型別顯示欄位；spawn / emitter.spawn 顯示 §5 生成欄位
//   - bulletType → 該子彈類型的全部欄位
//   - settings / 未選取 → 回合設定：settings、box、soul、party（可增刪）、enemies（可增刪）
// 表達式欄位：可切「數字 / 表達式」，表達式用等寬輸入框並附可用變數提示（§5）。
// 數字欄位：左右拖曳標籤調值（Blender 式），帶 coalesceKey。
// store.errors 中對應路徑（timeline[3].spawn.angle 或事件 id）標紅並顯示訊息。
//
// 只 export mount(rootEl, ctx)（SPEC §10 契約）；其餘為面板內部邏輯。
// 另額外 export fillDefaults / createEmptyAttack 供 ED1 或測試使用（不影響契約）。

import {
  EVENT_COMMON_FIELDS,
  SPAWN_FIELDS,
  BOX_TO_FIELDS,
  eventSpecOf,
  eventTypeLabel,
  defaultSpawnValues,
  getPath,
  setPath,
  lookupError,
  lookupErrorPrefix,
  fieldErrorKeys,
  numberField,
  timeField,
  musicField,
  textInput,
  selectEl,
  checkboxEl,
  coordinateField,
  colorField,
  spriteField,
  spriteNamesOf,
  button,
  el,
  clear,
  section,
  fieldRow,
  emptyState,
  panelHeader,
  hintBox,
  ensureStyles,
  EXPR_VARIABLES,
  EXPR_FUNCTIONS,
  domSig,
  loadSectionState,
  saveSectionState,
} from './fields.js';
import {
  addDemoPoint,
  buildDemoTimeline,
  clampDemoPoint,
  decodeDemoInputs,
  demoBoxFor,
  demoPathDuration,
  demoPathOf,
  demoPathTargetAt,
  demoShapeSignature,
  moveDemoPoint,
  removeDemoPoint,
  roundDemoValue,
  setDemoPointField,
  DEMO_MODES,
  DEMO_FALLBACK_MODES,
  DEMO_MARGIN,
  DEMO_POINT_FIELDS,
} from './demo-path.js';
import { t, registerStrings, onLocaleChange } from './i18n.js';
import PANELS from './locales/panels.js';
import { soulT, soulLabel } from './locales/soul.js';
import { mechanismKey, soulMechanisms } from '../engine/soul-mechanics.js';
// V2-06：自動產生演示路徑（Web Worker 優先，退化為分段同步）
import { GEN_DEFAULTS, createWorkerFactory, generatePathAsync, nextDemoForResult, summarizeGenResult } from './demo-gen.js';
// 拍點（SPEC-EXPR-V2 §2）：時間欄位顯示與時間軸共用同一套解析。
import { formatLike, formatSeconds, normalizeTiming, parseTime, timePointSeconds } from './beat.js';
// 戰鬥框／靈魂預設值一律取自引擎（SPEC-LAYOUT §5），不在編輯器複製數字。
import { BOX_DEFAULTS, SOUL_DEFAULTS } from '../engine/attack.js';
import { VIEW_W, BATTLE_AREA_BOTTOM } from '../engine/encounter/layout.js';

registerStrings('inspector', PANELS.inspector);

/** 本面板的取字串捷徑（動態解析，切換語系後會拿到新值）。 */
const T = (key, params) => t(`inspector.${key}`, params);

/** `fields` 命名空間（單位等共用字串）的取字串捷徑。 */
const F = (key, params) => t(`fields.${key}`, params);

/** `demo` 命名空間（AP4 演示面板；字串在 locales/demo.js）的取字串捷徑。 */
const D = (key, params) => t(`demo.${key}`, params);

const POINT_LIMITS = { x: VIEW_W, y: BATTLE_AREA_BOTTOM };
const MIN_POLYGON_POINTS = 3;
const MAX_POLYGON_POINTS = 64;
const pointsOf = (a, region) => Array.isArray(a[region]?.points) ? a[region].points : [];
const usesCustomClip = (a) => Object.values(a.bulletTypes ?? {}).some((bt) => bt?.clipTo === 'custom');
const clipModeOf = (bt) => bt?.clipTo ?? (bt?.maskToBox === true ? 'box' : 'none');
const optionsFor = (group, values) => values.map((value) => ({ value, label: T(`${group}.${value}`) }));

function polygonPreset(shape) {
  const { x, y, w, h } = BOX_DEFAULTS;
  const [left, right, top, bottom] = [x - w / 2, x + w / 2, y - h / 2, y + h / 2];
  const pairs = shape === 'diamond' ? [[x, top], [right, y], [x, bottom], [left, y]]
    : [[left, top], [right, top], [right, bottom], [left, bottom]];
  return pairs.map(([x, y]) => ({ x, y }));
}

function splitLongestEdge(points) {
  let edge = 0;
  let longest = 0;
  for (let i = 0; i < points.length; i += 1) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > longest) {
      edge = i;
      longest = length;
    }
  }
  const a = points[edge];
  const b = points[(edge + 1) % points.length];
  points.splice(edge + 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
}

/** 事件型別選單（SPEC §4 表格順序）：type → i18n 鍵尾碼。 */
const EVENT_TYPE_ORDER = {
  spawn: 'typeOption.spawn',
  emitter: 'typeOption.emitter',
  box: 'typeOption.box',
  soul: 'typeOption.soul',
  soulProfile: null,
  soulAppearance: null,
  soulTeleport: null,
  clear: 'typeOption.clear',
  shake: 'typeOption.shake',
  sfx: 'typeOption.sfx',
  anim: 'typeOption.anim',
  end: 'typeOption.end',
};

/** 事件型別下拉選項（[{ value, label }]，依目前語系）。 */
export function eventTypeOptions() {
  return Object.entries(EVENT_TYPE_ORDER).map(([value, key]) => ({ value, label: key ? t(`inspector.${key}`) : eventTypeLabel(value) }));
}

/** 同一節點只保留一個 inspector 實例。 */
const instances = new WeakMap();

/**
 * mount(rootEl, ctx)
 * ctx = { store, assets, preview }（SPEC §10）
 * 回傳 { destroy(), refresh() }。
 */
export function mount(rootEl, ctx = {}) {
  if (!rootEl) return { destroy() {}, refresh() {} };
  ensureStyles();
  const prev = instances.get(rootEl);
  if (prev) prev.destroy();

  const store = ctx.store || null;
  const assets = ctx.assets || null;
  const preview = ctx.preview || null;

  /** 摺疊狀態存放處（沒有 localStorage 的環境回 null → 只記在記憶體）。 */
  const sectionStorage = () => {
    try {
      return typeof globalThis !== 'undefined' && globalThis.localStorage ? globalThis.localStorage : null;
    } catch (_err) {
      return null;
    }
  };

  const state = {
    destroyed: false,
    shape: '',
    unsub: null,
    fields: [],
    lastErrorSig: '',
    // 摺疊狀態：切換語系重繪時保留，並寫進 localStorage 跨次開啟記住（REALTEST-2 V13）
    sections: loadSectionState(sectionStorage()),
  };

  rootEl.classList.add('pan-inspector');
  rootEl.setAttribute('role', 'region');
  rootEl.setAttribute('aria-label', T('aria'));

  /* ---------------- 資料存取 ---------------- */

  const attack = () => (store && store.attack) || null;
  const selection = () => (store && store.selection) || { kind: null, id: null };

  const errorsMap = () => {
    const e = store && store.errors;
    if (!e) return new Map();
    if (e instanceof Map) return e;
    if (typeof e === 'object') return new Map(Object.entries(e));
    return new Map();
  };

  const errorsSig = () => {
    const errs = errorsMap();
    if (errs.size === 0) return '0';
    const parts = [];
    for (const [k, v] of errs) parts.push(`${k}=${v}`);
    parts.sort();
    return String(errs.size) + '|' + parts.join(';');
  };

  const timeline = () => {
    const a = attack();
    return a && Array.isArray(a.timeline) ? a.timeline : [];
  };

  const eventIndexOf = (id) => {
    const tl = timeline();
    for (let i = 0; i < tl.length; i += 1) if (tl[i] && tl[i].id === id) return i;
    return -1;
  };

  /** 目前文件的拍點設定（settings.bpm / beatOffset），時間欄位與 demo t 共用。 */
  const settingsTiming = () => {
    const a = attack();
    return normalizeTiming(a && a.settings ? a.settings : null);
  };

  const bulletTypeNames = () => {
    const a = attack();
    const bt = a && a.bulletTypes && typeof a.bulletTypes === 'object' ? a.bulletTypes : null;
    return bt ? Object.keys(bt) : [];
  };

  /* ---------------- 寫入 store ---------------- */

  const mutate = (fn, opts = {}) => {
    if (!store || typeof store.update !== 'function') return;
    store.update(fn, { label: opts.label || T('undo.edit'), coalesceKey: opts.coalesceKey });
  };

  const commit = (path, value, opts = {}) => {
    mutate((draft) => { setPath(draft, path, value); }, opts);
  };

  /** 可折疊區塊（帶穩定的 stateKey，切換語系或重繪時保留展開狀態）。 */
  const sec = (stateKey, titleText, children, opts = {}) =>
    section(titleText, children, {
      ...opts,
      stateMap: state.sections,
      stateKey,
      expandTitle: T('section.expandTip'),
      collapseTitle: T('section.collapseTip'),
      onToggle: () => saveSectionState(sectionStorage(), state.sections),
    });

  /* ---------------- 欄位綁定 / 同步 ---------------- */

  /** 綁定控制項；回傳其 DOM。 */
  const bind = (ctl, opts = {}) => {
    state.fields.push({
      ctl,
      path: opts.path || null,
      getValue: opts.getValue || null,
      errorKeys: opts.errorKeys || [],
      lastValue: opts.path ? getPath(attack(), opts.path) : undefined,
      holder: opts.holder || ctl.el,
    });
    return opts.dom || ctl.el;
  };

  const syncFields = () => {
    const a = attack();
    const errs = errorsMap();
    for (const f of state.fields) {
      const ctl = f.ctl;
      if (!ctl) continue;
      // 1) 值同步（正在編輯的輸入框不動，避免搶焦點）
      if (typeof ctl.setValue === 'function' && !(typeof ctl.isEditing === 'function' && ctl.isEditing())) {
        const next = f.getValue ? f.getValue(a) : getPath(a, f.path);
        if (!sameValue(next, f.lastValue)) {
          f.lastValue = next;
          ctl.setValue(next);
        }
      }
      // 2) 錯誤標示
      if (typeof ctl.setError === 'function') {
        const hit = lookupError(errs, f.errorKeys);
        ctl.setError(hit.hasError ? hit.message : '');
      }
    }
  };

  /* ---------------- 欄位工廠（回傳可直接 append 的 row） ---------------- */

  const numRow = (basePath, spec, key, eventId, label) => {
    const path = basePath ? `${basePath}.${key}` : key;
    const cur = getPath(attack(), path);
    const api = numberField({
      value: cur === undefined ? spec.def : cur,
      spec: { ...spec, key, label: label !== undefined ? label : spec.label },
      coalesceKey: `inspector:${path}`,
      onChange: (v) => commit(path, v, { label: T('undo.adjust', { field: label || spec.label || key }), coalesceKey: `inspector:${path}` }),
    });
    const keys = fieldErrorKeys(basePath, eventId, key);
    keys.push(path);
    bind(api, { path, errorKeys: keys });
    return fieldRow(null, api.el);
  };

  /** 時間欄位列（秒／拍點字串，SPEC-EXPR-V2 §2）。 */
  const timeRow = (basePath, spec, key, eventId, label) => {
    const path = basePath ? `${basePath}.${key}` : key;
    const cur = getPath(attack(), path);
    const api = timeField({
      value: cur === undefined ? spec.def : cur,
      spec: { ...spec, key, label: label !== undefined ? label : spec.label },
      coalesceKey: `inspector:${path}`,
      getTiming: () => {
        const a = attack();
        return a && a.settings ? a.settings : null;
      },
      onChange: (v) => commit(path, v, {
        label: T('undo.adjust', { field: label || spec.label || key }),
        coalesceKey: `inspector:${path}`,
      }),
    });
    const keys = fieldErrorKeys(basePath, eventId, key);
    keys.push(path);
    bind(api, { path, errorKeys: keys });
    return fieldRow(null, api.el);
  };

  /** BGM：可搜尋下拉（素材索引 audio 中 kind=music）＋仍可手打。 */
  const bgmRow = () => {
    const path = 'settings.bgm';
    const cur = getPath(attack(), path);
    const ctl = musicField({
      value: cur === undefined ? null : cur,
      assets,
      placeholder: T('placeholder.bgm'),
      onChange: (v) => commit(path, v, { label: T('undo.setBgm') }),
    });
    const keys = fieldErrorKeys('settings', null, 'bgm');
    keys.push(path);
    const row = fieldRow(T('label.bgm'), ctl.el);
    bind(ctl, { path, errorKeys: keys, holder: row });
    return row;
  };

  const textRow = (basePath, key, eventId, opts = {}) => {    const path = basePath ? `${basePath}.${key}` : key;
    const cur = getPath(attack(), path);
    const input = textInput(cur === null || cur === undefined ? '' : cur, (v) => {
      commit(path, v, { label: T('undo.editField', { field: opts.label || key }) });
    }, { mono: opts.mono, placeholder: opts.placeholder });
    const keys = fieldErrorKeys(basePath, eventId, key);
    keys.push(path);
    const row = fieldRow(opts.label || key, input);
    bind({
      el: row,
      getValue: () => input.value,
      setValue: (v) => { input.value = v === null || v === undefined ? '' : String(v); },
      setError: (msg) => { input.classList.toggle('has-error', !!msg); input.title = msg || ''; },
      isEditing: () => document.activeElement === input,
    }, { path, errorKeys: keys, dom: row });
    return row;
  };

  const selectRow = (basePath, key, eventId, options, opts = {}) => {
    const path = basePath ? `${basePath}.${key}` : key;
    const cur = opts.getValue ? opts.getValue(attack()) : getPath(attack(), path);
    const onChange = opts.onChange ?? ((v) => commit(path, v, { label: T('undo.select', { field: opts.label || key }) }));
    const sel = selectEl(options, cur, onChange, {
      allowNull: opts.allowNull, nullLabel: opts.nullLabel, number: opts.number,
    });
    sel.setAttribute('aria-label', opts.label || key);
    const keys = fieldErrorKeys(basePath, eventId, key);
    keys.push(path);
    const row = fieldRow(opts.label || key, sel);
    bind({
      el: row,
      getValue: () => sel.value,
      setValue: (v) => { sel.value = v === null || v === undefined ? '' : String(v); },
      setError: (msg) => { sel.classList.toggle('has-error', !!msg); sel.title = msg || ''; },
    }, { path, getValue: opts.getValue, errorKeys: keys, dom: row });
    return row;
  };

  const colorRow = (basePath, key, eventId, opts = {}) => {
    const path = basePath ? `${basePath}.${key}` : key;
    const cur = getPath(attack(), path);
    const ctl = colorField(cur, opts.onChange ?? ((v) => commit(path, v, { label: T('undo.setColor', { field: opts.label || key }) })), { nullable: opts.nullable });
    const keys = fieldErrorKeys(basePath, eventId, key);
    keys.push(path);
    const row = fieldRow(opts.label || key, ctl);
    bind(ctl, { path, errorKeys: keys, dom: row });
    return row;
  };

  const spriteRow = (basePath, key, eventId, opts = {}) => {
    const path = basePath ? `${basePath}.${key}` : key;
    const cur = getPath(attack(), path);
    const ctl = spriteField({
      value: cur === undefined ? null : cur,
      assets,
      nullable: opts.nullable !== false,
      placeholder: opts.placeholder,
      onChange: (v) => commit(path, v, { label: T('undo.setSprite', { label: opts.label || 'sprite' }) }),
    });
    const keys = fieldErrorKeys(basePath, eventId, key);
    keys.push(path);
    const row = fieldRow(opts.label || key, ctl);
    bind(ctl, { path, errorKeys: keys, dom: row });
    return row;
  };

  const checkRow = (basePath, key, eventId, label, def = false, onChange) => {
    const path = basePath ? `${basePath}.${key}` : key;
    const cur = getPath(attack(), path);
    const chk = checkboxEl(cur === undefined ? def : !!cur, onChange ?? ((v) => commit(path, v, { label })), label);
    const keys = fieldErrorKeys(basePath, eventId, key);
    keys.push(path);
    const row = fieldRow(null, chk);
    bind({
      el: row,
      setValue: (v) => chk.setChecked(v === undefined ? def : !!v),
      setError: (msg) => { chk.classList.toggle('has-error', !!msg); chk.title = msg || ''; },
    }, { path, errorKeys: keys, dom: row });
    return row;
  };

  /**
   * 子彈類型引用欄位（spawn.bullet / emitter.spawn.bullet）。
   * 文字輸入 + datalist（bulletTypes 鍵 & sprite 名）+ 挑選器 + 接受素材拖放。
   */
  const bulletRow = (basePath, key, eventId, label = T('label.bulletType')) => {
    const path = basePath ? `${basePath}.${key}` : key;
    const cur = getPath(attack(), path);
    const wrap = el('div', { class: 'pan-field pan-field-sprite' });
    const row = el('div', { class: 'pan-spritefield' });
    const input = el('input', {
      type: 'text', class: 'pan-input pan-input-mono', placeholder: T('placeholder.bulletType'),
      spellcheck: 'false', autocomplete: 'off',
    });
    input.value = cur === null || cur === undefined ? '' : String(cur);
    const datalist = el('datalist', { id: `bt-suggest-${nextUid()}` });
    const refreshDatalist = () => {
      clear(datalist);
      for (const n of bulletTypeNames()) datalist.appendChild(el('option', { value: n }));
      for (const n of spriteNamesOf(assets).slice(0, 500)) datalist.appendChild(el('option', { value: n }));
    };
    refreshDatalist();
    input.setAttribute('list', datalist.id);

    const pick = button(T('btn.pickBulletType'), {
      small: true,
      title: T('title.pickBulletType'),
      onClick: (e) => {
        e.stopPropagation();
        const existing = wrap.querySelector('.pan-sprite-picker');
        if (existing) { existing.remove(); return; }
        const pop = el('div', { class: 'pan-sprite-picker' });
        const names = bulletTypeNames();
        if (names.length === 0) pop.appendChild(el('div', { class: 'pan-empty-sub', text: T('empty.noBulletTypes') }));
        for (const n of names) {
          const b = el('button', { type: 'button', class: 'pan-sprite-item', text: n });
          b.addEventListener('click', () => {
            input.value = n;
            commit(path, n, { label: T('undo.selectBulletType') });
            pop.remove();
          });
          pop.appendChild(b);
        }
        wrap.appendChild(pop);
        const close = (ev) => {
          if (pop.contains(ev.target) || ev.target === pick) return;
          pop.remove();
          document.removeEventListener('pointerdown', close, true);
        };
        setTimeout(() => document.addEventListener('pointerdown', close, true), 0);
      },
    });
    const clr = button(T('btn.clear'), { small: true, title: T('title.clear'), onClick: () => { input.value = ''; commit(path, null, { label: T('undo.clearBulletType') }); } });
    row.appendChild(input);
    row.appendChild(pick);
    row.appendChild(clr);
    row.appendChild(datalist);

    const errEl = el('div', { class: 'pan-field-error' });
    wrap.appendChild(row);
    wrap.appendChild(errEl);

    const doCommit = () => {
      const v = input.value.trim();
      commit(path, v === '' ? null : v, { label: T('undo.setBulletType') });
    };
    input.addEventListener('change', doCommit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); doCommit(); input.blur(); }
      if (e.key === 'Escape') { input.value = cur ?? ''; input.blur(); }
    });
    row.addEventListener('dragover', (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      row.classList.add('drop-target');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drop-target'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop-target');
      const name = e.dataTransfer?.getData('text/plain') || '';
      if (!name) return;
      input.value = name;
      doCommit();
    });

    const keys = fieldErrorKeys(basePath, eventId, key);
    keys.push(path);
    const holder = fieldRow(label, wrap);
    bind({
      el: holder,
      setValue: (v) => { input.value = v === null || v === undefined ? '' : String(v); refreshDatalist(); },
      setError: (msg) => {
        errEl.textContent = msg || '';
        errEl.classList.toggle('show', !!msg);
        wrap.classList.toggle('has-error', !!msg);
      },
      isEditing: () => document.activeElement === input,
    }, { path, errorKeys: keys, dom: holder });
    return holder;
  };

  /** 通用：依 spec.fields 項目建立 row。 */
  const specRow = (f, basePath, eventId) => {
    switch (f.kind) {
      case 'num': return numRow(basePath, f, f.key, eventId);
      case 'time': return timeRow(basePath, f, f.key, eventId);
      case 'text': return textRow(basePath, f.key, eventId, { label: f.label, placeholder: f.placeholder });
      case 'select': {
        const opts = f.allowNull ? [null, ...f.options] : f.options;
        return selectRow(basePath, f.key, eventId, opts, {
          allowNull: !!f.allowNull, nullLabel: f.nullLabel || F('ev.soul.modeUnchanged'), label: f.label,
        });
      }
      case 'color': return colorRow(basePath, f.key, eventId, { nullable: true, label: f.label });
      case 'bullet': return bulletRow(basePath, f.key, eventId);
      default:
        return fieldRow(f.label || f.key, el('div', { class: 'pan-readonly', text: T('readonly.unsupported') }));
    }
  };

  /* ---------------- 主渲染 ---------------- */

  let editedSoul = null;
  const profileIds = (a) => Object.keys(a.soulProfiles ?? {}).filter((id) => /^[a-zA-Z0-9_-]{1,40}$/.test(id) && !Object.hasOwn(Object.prototype, id));
  const profileOptions = (a) => profileIds(a).map((id) => ({ value: id, label: id }));
  const shapeKey = () => {
    const a = attack();
    if (!a) return 'no-attack';
    const sel = selection();
    if (sel.kind === 'event' && sel.id) {
      const i = eventIndexOf(sel.id);
      const ev = i >= 0 ? timeline()[i] : null;
      return `event|${sel.id}|${ev ? ev.type : 'missing'}|${i}|${profileIds(a).join(',')}`;
    }
    if (sel.kind === 'bulletType' && sel.id) {
      const exists = !!(a.bulletTypes && Object.prototype.hasOwnProperty.call(a.bulletTypes, sel.id));
      return `bt|${sel.id}|${exists ? 'y' : 'n'}`;
    }
    return `settings|${(a.party || []).length}|${(a.enemies || []).length}|${demoShapeSignature(demoOf(a))}|`
      + `${a.arena?.kind}|${pointsOf(a, 'arena').length}|${a.clipRegion !== undefined}|`
      + `${pointsOf(a, 'clipRegion').length}|${usesCustomClip(a)}|${a.soul?.profile ?? ''}|`
      + JSON.stringify(profileIds(a).map((id) => [id, a.soulProfiles[id]?.movement?.id, a.soulProfiles[id]?.movement?.version,
        Array.isArray(a.soulProfiles[id]?.abilities) ? a.soulProfiles[id].abilities.map((def) => def && mechanismKey(def)) : null]));
  };

  /**
   * 重入保護：清空面板時移除「正在聚焦」的輸入框會同步派送 blur，
   * blur 處理常式可能立刻寫 store → onStoreChange → 又呼叫 render，
   * 造成外層 clear() 的 removeChild 拿到已被內層移除的節點（NotFoundError）。
   * 這裡把重入的 render 排到本輪結束後再跑一輪。
   */
  let rendering = false;
  let renderAgain = false;

  const render = () => {
    if (state.destroyed) return;
    if (rendering) { renderAgain = true; return; }
    rendering = true;
    try {
      do {
        renderAgain = false;
        renderOnce();
      } while (renderAgain && !state.destroyed);
    } finally {
      rendering = false;
    }
  };

  const renderOnce = () => {
    if (state.destroyed) return;
    const scrollTop = rootEl.scrollTop;
    clear(rootEl);
    state.fields = [];

    const a = attack();
    if (!a) {
      rootEl.appendChild(panelHeader(T('title.panel')));
      rootEl.appendChild(emptyState(T('empty.noAttack'), T('empty.noAttackSub')));
      state.shape = 'no-attack';
      return;
    }

    const sel = selection();
    let isSettings = false;
    if (sel.kind === 'event' && sel.id) renderEventPanel(sel.id);
    else if (sel.kind === 'bulletType' && sel.id) renderBulletTypePanel(sel.id);
    else { renderSettingsPanel(); isSettings = true; }

    // 全域驗證問題總覽：任何面板都看得到（違規欄位若在別處，仍可從這裡追）
    const errs = errorsMap();
    if (errs.size > 0) rootEl.appendChild(errorSummarySection(errs, { collapsed: !isSettings }));

    syncFields();
    state.shape = shapeKey();
    state.lastErrorSig = errorsSig();
    rootEl.scrollTop = scrollTop;
  };

  /* ---------------- 標題 ---------------- */

  const headerFor = (title, tools = null) => {
    const h = panelHeader(title, tools);
    h.appendChild(el('span', { class: 'pan-subtitle' }));
    return h;
  };

  const refreshSubtitle = () => {
    const sub = rootEl.querySelector('.pan-subtitle');
    const sel = selection();
    let label = '';
    if (sub) {
      if (sel.kind === 'event' && sel.id) {
        const i = eventIndexOf(sel.id);
        sub.textContent = i >= 0 ? `#${i} · ${sel.id}` : T('subtitle.missing');
      } else if (sel.kind === 'bulletType' && sel.id) {
        sub.textContent = sel.id;
      } else {
        // §4-6：沒有選取時明講「（未選取）· 回合設定」，避免看起來像選中了東西
        sub.textContent = T('subtitle.noSelection');
      }
      // 窄面板時副標題會以省略號截斷，滑過仍能看到完整內容
      sub.title = sub.textContent;
      label = sub.textContent;
    }
    updateSelectionLabel(sel, label);
  };

  /**
   * §4-6：把「目前選取」同步到面板標題右側的 #selection-label。
   * 攻擊編輯器先前完全沒有寫入這個元素，載入範例後它一直是空的。
   */
  const updateSelectionLabel = (sel, subtitleText) => {
    if (typeof document === 'undefined') return;
    const el = document.getElementById('selection-label');
    if (!el) return;
    let text = '';
    if (sel.kind === 'event' && sel.id) {
      const i = eventIndexOf(sel.id);
      const ev = i >= 0 ? timeline()[i] : null;
      text = ev ? T('selection.event', { id: String(ev.id) }) : T('subtitle.missing');
    } else if (sel.kind === 'bulletType' && sel.id) {
      text = T('selection.bulletType', { id: String(sel.id) });
    } else {
      text = T('selection.none');
    }
    el.textContent = text;
    el.title = subtitleText || text;
    el.classList.toggle('is-empty', !(sel.kind === 'event' || sel.kind === 'bulletType'));
  };

  /* ---------------- 事件面板 ---------------- */

  const renderEventPanel = (eventId) => {
    const a = attack();
    const index = eventIndexOf(eventId);
    const ev = index >= 0 ? timeline()[index] : null;
    const basePath = index >= 0 ? `timeline[${index}]` : null;

    rootEl.appendChild(headerFor(ev ? T('title.event', { type: eventTypeLabel(ev.type) }) : T('title.eventPlain')));

    if (!ev) {
      rootEl.appendChild(emptyState(T('empty.missingEvent'), T('empty.missingEventSub')));
      return;
    }

    // 型別切換 + 刪除
    const typeRow = el('div', { class: 'pan-event-type' });
    typeRow.appendChild(el('span', { class: 'pan-kicker', text: T('kicker.type') }));
    typeRow.appendChild(selectEl(
      eventTypeOptions(),
      ev.type,
      (v) => changeEventType(index, v),
      { class: 'pan-select-type' },
    ));
    typeRow.appendChild(button(T('btn.deleteEvent'), {
      small: true, variant: 'danger', title: T('title.deleteEvent'),
      onClick: () => removeEvent(index),
    }));
    rootEl.appendChild(typeRow);

    // 事件層級錯誤橫幅（key = 事件 id 或 timeline[i]）
    const errBanner = eventErrorBanner(eventId, basePath);
    if (errBanner) rootEl.appendChild(errBanner);

    // 共同欄位
    const common = el('div', { class: 'pan-grid' });
    common.appendChild(fieldRow('ID', el('div', { class: 'pan-readonly pan-mono', text: String(ev.id ?? '') })));
    for (const f of EVENT_COMMON_FIELDS) {
      if (f.kind === 'readonly') continue;
      common.appendChild(specRow(f, basePath, eventId));
    }
    rootEl.appendChild(sec('basic', T('section.basic'), common));

    const spec = eventSpecOf(ev.type);
    if (!spec) {
      rootEl.appendChild(hintBox(T('hint.unknownType', { type: ev.type })));
      rootEl.appendChild(sec('raw', T('section.raw'), el('pre', { class: 'pan-json', text: JSON.stringify(ev, null, 2) }), { collapsed: true }));
      return;
    }

    if (ev.type === 'soulProfile') {
      rootEl.appendChild(selectRow(basePath, 'profile', eventId, [null, ...profileOptions(a)], {
        label: soulT('profile'), allowNull: true, nullLabel: soulT('pick'),
        onChange: (id) => { if (id) commit(basePath + '.profile', id, { label: soulT('profile') }); },
      }));
    } else if (ev.type === 'soulAppearance') {
      rootEl.appendChild(appearancePanel(basePath + '.appearance', eventId));
    }

    if (spec.fields.length) {
      const own = el('div', { class: 'pan-grid' });
      for (const f of spec.fields) own.appendChild(specRow(f, basePath, eventId));
      rootEl.appendChild(sec(`fields:${ev.type}`, T('section.typedFields', { label: spec.label }), own));
    }

    for (const secSpec of spec.sections || []) {
      if (secSpec.kind === 'spawn') {
        const spawnBase = secSpec.prefix ? `${basePath}.${secSpec.prefix}` : basePath;
        const wrap = el('div', { class: 'pan-grid' });
        if (secSpec.prefix) wrap.appendChild(bulletRow(spawnBase, 'bullet', eventId));
        // 生成欄位：life 是時間欄位（可吃拍點字串），其餘走 specRow 分派
        for (const f of SPAWN_FIELDS) wrap.appendChild(specRow(f, spawnBase, eventId));
        rootEl.appendChild(sec(`${ev.type}:spawn`, secSpec.title, el('div', null, [
          hintBox(T('hint.spawnAngle')),
          wrap,
        ])));
      } else if (secSpec.kind === 'boxTo') {
        const toBase = `${basePath}.to`;
        const wrap = el('div', { class: 'pan-grid' });
        for (const f of BOX_TO_FIELDS) wrap.appendChild(numRow(toBase, f, f.key, eventId));
        rootEl.appendChild(sec(`${ev.type}:boxTo`, secSpec.title, el('div', null, [
          hintBox(T('hint.boxToSkip')),
          wrap,
        ])));
      }
    }

    rootEl.appendChild(sec('raw', T('section.raw'), el('pre', { class: 'pan-json', text: JSON.stringify(ev, null, 2) }), { collapsed: true }));

    // 表達式欄位可以參考的變數 / 函式清單（預設摺疊，不佔版面）
    rootEl.appendChild(exprHelpSection());
  };

  const eventErrorBanner = (eventId, basePath) => {
    const errs = errorsMap();
    if (errs.size === 0) return null;
    const hits = [];
    if (errs.has(eventId)) hits.push([eventId, errs.get(eventId)]);
    if (basePath && lookupErrorPrefix(errs, basePath).hasError) {
      const p = lookupErrorPrefix(errs, basePath);
      if (!hits.some(([k]) => k === p.key)) hits.push([p.key, p.message]);
    }
    if (hits.length === 0) return null;
    const box = el('div', { class: 'pan-error-banner' });
    for (const [k, msg] of hits.slice(0, 4)) {
      box.appendChild(el('div', { class: 'pan-error-row', text: T('errRow', { key: k, msg }) }));
    }
    return box;
  };

  const changeEventType = (index, newType) => {
    const ev = timeline()[index];
    if (!ev || ev.type === newType) return;
    mutate((draft) => {
      const e = draft.timeline && draft.timeline[index];
      if (!e) return;
      const oldType = e.type;
      e.type = newType;
      const spec = eventSpecOf(newType);
      for (const f of (spec && spec.fields) || []) {
        if (f.def === undefined) continue;
        if (e[f.key] === undefined) e[f.key] = f.def;
      }
      if (newType === 'spawn' || newType === 'emitter') {
        if (e.bullet === undefined) e.bullet = null;
        const target = newType === 'emitter' ? (e.spawn = e.spawn || {}) : e;
        for (const f of SPAWN_FIELDS) {
          if (target[f.key] === undefined && f.def !== null) target[f.key] = f.def;
        }
        if (newType === 'emitter' && e.spawn.bullet === undefined) e.spawn.bullet = null;
      }
      if (newType === 'box') {
        if (!e.to || typeof e.to !== 'object') e.to = {};
        if (e.ease === undefined) e.ease = 'linear';
        if (e.duration === undefined) e.duration = 0.5;
      }
      if (newType === 'soulProfile') e.profile ??= draft.soul?.profile ?? profileIds(draft)[0];
      if (newType === 'soulAppearance') e.appearance ??= {};
      if (newType === 'end') {
        // end 沒有欄位
        void oldType;
      }
    }, { label: T('undo.changeType') });
  };

  const removeEvent = (index) => {
    const ev = timeline()[index];
    if (!ev) return;
    if (!confirm(T('confirm.deleteEvent', { label: eventTypeLabel(ev.type), id: ev.id || '' }))) return;
    mutate((draft) => {
      if (Array.isArray(draft.timeline)) draft.timeline.splice(index, 1);
    }, { label: T('undo.deleteEvent') });
    if (store && typeof store.select === 'function') store.select(null, null);
  };

  /* ---------------- 子彈類型面板 ---------------- */

  const renderBulletTypePanel = (name) => {
    const a = attack();
    const types = a.bulletTypes && typeof a.bulletTypes === 'object' ? a.bulletTypes : {};
    const basePath = `bulletTypes.${name}`;
    rootEl.appendChild(headerFor(T('title.bulletType')));
    rootEl.appendChild(el('div', { class: 'pan-kicker-name pan-mono', text: name }));

    if (!Object.prototype.hasOwnProperty.call(types, name)) {
      rootEl.appendChild(emptyState(T('empty.missingBulletType'), T('empty.missingBulletTypeSub')));
      return;
    }
    const bt = types[name] && typeof types[name] === 'object' ? types[name] : {};

    const basic = el('div', { class: 'pan-grid' });
    basic.appendChild(spriteRow(basePath, 'sprite', null, { label: 'sprite' }));
    basic.appendChild(numRow(basePath, { key: 'frameRate', label: T('label.frameRate'), def: 0, step: 1, drag: 0.25, min: 0, max: 60, unit: 'fps' }, 'frameRate', null));
    basic.appendChild(numRow(basePath, { key: 'scale', label: T('label.scale'), def: 1, step: 0.05, drag: 0.02, min: 0, max: 20 }, 'scale', null));
    basic.appendChild(colorRow(basePath, 'color', null, { label: T('label.color'), nullable: true }));
    rootEl.appendChild(sec('bt:appearance', T('section.appearance'), basic));

    // hitbox
    const hb = el('div', { class: 'pan-grid' });
    const shape = bt.hitbox && bt.hitbox.shape ? bt.hitbox.shape : 'circle';
    hb.appendChild(fieldRow(T('label.hitboxShape'), selectEl(
      [{ value: 'circle', label: T('opt.circle') }, { value: 'rect', label: T('opt.rect') }],
      shape,
      (v) => changeHitboxShape(basePath, v),
      {},
    )));
    if (shape === 'circle') {
      hb.appendChild(numRow(`${basePath}.hitbox`, { key: 'r', label: T('label.radius'), def: 6, step: 0.5, drag: 0.25, min: 0, max: 512 }, 'r', null));
    } else {
      hb.appendChild(numRow(`${basePath}.hitbox`, { key: 'w', label: T('label.width'), def: 8, step: 1, drag: 0.5, min: 0, max: 1024 }, 'w', null));
      hb.appendChild(numRow(`${basePath}.hitbox`, { key: 'h', label: T('label.height'), def: 8, step: 1, drag: 0.5, min: 0, max: 1024 }, 'h', null));
    }
    rootEl.appendChild(sec('bt:hitbox', T('section.hitbox'), hb));

    // 行為
    const behavior = el('div', { class: 'pan-grid' });
    behavior.appendChild(numRow(basePath, {
      key: 'damage', label: T('label.damage'), def: null, step: 1, drag: 0.5, min: 0, nullable: true, nullLabel: T('null.damageDefault'), unit: 'hp',
    }, 'damage', null));
    behavior.appendChild(checkRow(basePath, 'decor', null, T('chk.decor'), false));
    behavior.appendChild(checkRow(basePath, 'shootable', null, soulT('shootable')));
    behavior.appendChild(checkRow(basePath, 'platform', null, T('chk.platform'), false));
    behavior.appendChild(numRow(basePath, {
      key: 'bounce', label: T('label.bounce'), def: null, step: 0.1, drag: 0.05, min: 0, max: 8, nullable: true, nullLabel: T('null.noBounce'),
    }, 'bounce', null));
    behavior.appendChild(numRow(basePath, {
      key: 'hp', label: T('label.shotHp'), def: null, step: 1, drag: 0.2, min: 1, max: 99, nullable: true, nullLabel: T('null.shotHpOne'),
    }, 'hp', null));
    behavior.appendChild(checkRow(basePath, 'grazeable', null, T('chk.grazeable'), true));
    behavior.appendChild(checkRow(basePath, 'destroyOnHit', null, T('chk.destroyOnHit'), true));
    behavior.appendChild(checkRow(basePath, 'faceVelocity', null, T('chk.faceVelocity'), false));
    behavior.appendChild(selectRow(basePath, 'clipTo', null,
      optionsFor('clip.mode', ['none', 'box', 'arena', 'custom']), {
        label: T('clip.label'),
        getValue: (doc) => clipModeOf(doc.bulletTypes[name]),
        onChange: (clipTo) => mutate((draft) => {
          if (clipTo === 'custom' && draft.clipRegion === undefined) {
            draft.clipRegion = { points: polygonPreset('rectangle') };
          }
          draft.bulletTypes[name].clipTo = clipTo;
        }, { label: T('undo.select', { field: T('clip.label') }) }),
      }));
    behavior.appendChild(selectRow(basePath, 'offscreen', null, ['destroy', 'keep'], { label: T('label.offscreen') }));
    rootEl.appendChild(sec('bt:behavior', T('section.behavior'), behavior));

    rootEl.appendChild(hintBox(T('hint.bulletTypePreview')));
    rootEl.appendChild(sec('raw', T('section.raw'), el('pre', { class: 'pan-json', text: JSON.stringify(bt, null, 2) }), { collapsed: true }));
  };

  const changeHitboxShape = (basePath, shape) => {
    mutate((draft) => {
      const cur = getPath(draft, `${basePath}.hitbox`);
      const next = { shape };
      if (shape === 'circle') next.r = cur && typeof cur.r === 'number' ? cur.r : 6;
      else {
        next.w = cur && typeof cur.w === 'number' ? cur.w : 8;
        next.h = cur && typeof cur.h === 'number' ? cur.h : 8;
      }
      setPath(draft, `${basePath}.hitbox`, next);
    }, { label: T('undo.hitboxShape') });
  };

  /* ---------------- 回合設定面板 ---------------- */

  const polygonError = (region) => {
    const error = lookupErrorPrefix(errorsMap(), `${region}.points`);
    return error.hasError ? el('div', { class: 'pan-field-error show', role: 'alert', text: error.message }) : null;
  };

  const polygonEditor = (region) => {
    const path = `${region}.points`;
    const points = pointsOf(attack(), region);
    const body = el('div', { class: 'pan-grid' });
    body.appendChild(hintBox(T('polygon.hint', { ...POINT_LIMITS, min: MIN_POLYGON_POINTS, max: MAX_POLYGON_POINTS })));
    const error = polygonError(region);
    if (error) body.appendChild(error);

    const actions = el('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px' } });
    for (const preset of ['rectangle', 'diamond']) {
      actions.appendChild(button(T(`polygon.${preset}`), {
        small: true,
        onClick: () => commit(path, polygonPreset(preset), { label: T('polygon.applyPreset') }),
      }));
    }
    if (points.length >= MIN_POLYGON_POINTS) {
      const add = button(T('polygon.add'), {
        small: true,
        title: T('polygon.addHint'),
        onClick: () => mutate((draft) => splitLongestEdge(draft[region].points), { label: T('polygon.add') }),
      });
      const setAddState = (list) => {
        add.disabled = list.length >= MAX_POLYGON_POINTS || !list.every((point) =>
          Object.entries(POINT_LIMITS).every(([axis, max]) =>
            Number.isFinite(point?.[axis]) && point[axis] >= 0 && point[axis] <= max));
      };
      setAddState(points);
      bind({ el: add, setValue: setAddState }, { path });
      actions.appendChild(add);
    }
    body.appendChild(actions);

    if (points.length === 0) return body;
    const table = el('table', { class: 'pan-demo-table' }, [
      el('thead', null, el('tr', null, ['#', 'X', 'Y', ''].map((label) => el('th', { scope: 'col', text: label })))),
    ]);
    const rows = el('tbody');
    for (let i = 0; i < points.length; i += 1) {
      const pointPath = `${path}[${i}]`;
      const row = el('tr', { class: 'pan-demo-tr' }, el('td', { class: 'pan-demo-td pan-demo-td-index', text: i + 1 }));
      for (const [axis, max] of Object.entries(POINT_LIMITS)) {
        const coordPath = `${pointPath}.${axis}`;
        const label = T('polygon.coordinate', { i: i + 1, axis: axis.toUpperCase() });
        const ctl = coordinateField({
          value: getPath(attack(), coordPath), max, label,
          onChange: (value) => commit(coordPath, value, { label: T('undo.adjust', { field: label }) }),
        });
        row.appendChild(el('td', { class: 'pan-demo-td' }, bind(ctl, { path: coordPath })));
      }
      const title = T('polygon.remove', { i: i + 1 });
      const remove = button('✕', {
        small: true, variant: 'danger', title, disabled: points.length <= MIN_POLYGON_POINTS,
        onClick: () => mutate((draft) => { draft[region].points.splice(i, 1); }, { label: title }),
      });
      remove.setAttribute('aria-label', title);
      row.appendChild(el('td', { class: 'pan-demo-td pan-demo-td-tools' }, el('div', { class: 'pan-demo-rowtools' }, remove)));
      rows.appendChild(row);
    }
    table.appendChild(rows);
    body.appendChild(el('div', { class: 'pan-demo-tablewrap' }, table));
    return body;
  };

  const appearancePanel = (path, eventId = null) => {
    const g = el('div', { class: 'pan-grid' });
    g.appendChild(colorRow(path, 'color', eventId, { label: soulT('color') }));
    g.appendChild(spriteRow(path, 'sprite', eventId, { label: soulT('sprite') }));
    g.appendChild(checkRow(path, 'rotate', eventId, soulT('rotate')));
    for (const axis of ['X', 'Y']) g.appendChild(numRow(path, {
      key: 'anchor' + axis, label: 'Anchor ' + axis, def: 0, min: -128, max: 128, step: 1, unit: 'px',
    }, 'anchor' + axis, eventId));
    return g;
  };

  const soulProfilesPanel = () => {
    const a = attack();
    const ids = profileIds(a);
    const g = el('div', { class: 'pan-grid' });
    g.appendChild(selectRow('soul', 'profile', null, [null, ...profileOptions(a)], {
      label: soulT('initial'), allowNull: true, nullLabel: soulT('legacy'),
      onChange: (id) => mutate((d) => {
        d.soul ??= {};
        if (id) { d.soul.profile = id; editedSoul = id; }
        else delete d.soul.profile;
      }, { label: soulT('initial') }),
    }));
    const bindingOf = ({ id, version }) => ({ id, version, params: {} });
    const choices = (kind) => [...soulMechanisms[kind]].map(([value, def]) => ({ value, label: soulLabel(def.label) + ' · v' + def.version }));
    const mkPreset = (preset) => ({
      appearance: preset === 'car' ? { color: '#4fe7db', sprite: 'builtin:soul-car', rotate: true }
        : { color: preset === 'pulse' ? '#ffce45' : '#ff0000' },
      movement: bindingOf(soulMechanisms.movement.get(preset === 'car' ? 'inertia@1' : 'free@1')),
      abilities: preset === 'pulse' ? ['dash@1', 'shoot@1'].map((key) => bindingOf(soulMechanisms.ability.get(key))) : [],
    });
    g.appendChild(fieldRow(soulT('preset'), selectEl([null, ...['free', 'pulse', 'car'].map((value) => ({ value, label: soulT(value) }))],
      null, (preset) => {
        if (!preset) return;
        mutate((d) => {
          d.soulProfiles ??= {};
          let id = preset;
          for (let n = 2; Object.hasOwn(d.soulProfiles, id); n++) id = preset + n;
          d.soulProfiles[id] = mkPreset(preset);
          d.soul ??= {};
          d.soul.profile ??= id;
          editedSoul = id;
        }, { label: soulT('preset') });
      }, { allowNull: true, nullLabel: '＋' })));
    g.appendChild(hintBox(soulT('hint')));
    if (!ids.length) return sec('soulProfiles', soulT('title'), g);
    if (!ids.includes(editedSoul)) editedSoul = ids.includes(a.soul?.profile) ? a.soul.profile : ids[0];
    const id = editedSoul, spec = a.soulProfiles[id], path = 'soulProfiles.' + id;
    g.appendChild(fieldRow(soulT('edit'), selectEl(profileOptions(a), id, (value) => {
      editedSoul = value;
      render();
    })));
    const referenced = (a.timeline ?? []).some((ev) => ev?.type === 'soulProfile' && ev.profile === id);
    g.appendChild(button(soulT('remove'), { small: true, variant: 'danger', disabled: referenced,
      title: referenced ? soulT('used') : soulT('remove'), onClick: () => mutate((d) => {
        if (d.soul?.profile === id) delete d.soul.profile;
        delete d.soulProfiles[id];
        if (Object.keys(d.soulProfiles).length === 0) delete d.soulProfiles;
      }, { label: soulT('remove') }) }));
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return sec('soulProfiles', soulT('title'), g);
    g.appendChild(appearancePanel(path + '.appearance'));
    const params = (base, def) => {
      if (!def) { g.appendChild(hintBox(soulT('missing'))); return; }
      if (def.actions?.length) g.appendChild(hintBox(def.actions.map((a) => a.label).join(' / ')));
      for (const [key, field] of Object.entries(def.fields)) g.appendChild(numRow(base + '.params', {
        key, label: soulLabel(field.label), def: field.default, min: field.min, max: field.max, step: field.step,
      }, key, null));
    };
    const moveKey = spec.movement ? mechanismKey(spec.movement) : '';
    const moveOptions = choices('movement');
    if (moveKey && !soulMechanisms.movement.has(moveKey)) moveOptions.unshift({ value: moveKey, label: moveKey });
    g.appendChild(fieldRow(soulT('movement'), selectEl(moveOptions, moveKey, (key) => {
      commit(path + '.movement', bindingOf(soulMechanisms.movement.get(key)), { label: soulT('movement') });
    })));
    params(path + '.movement', soulMechanisms.movement.get(moveKey));
    const abilities = Array.isArray(spec.abilities) ? spec.abilities : [];
    abilities.forEach((ability, i) => {
      const key = ability ? mechanismKey(ability) : '';
      const def = soulMechanisms.ability.get(key);
      g.appendChild(fieldRow(def ? soulLabel(def.label) : key || soulT('missing'), button(soulT('removeAbility'), {
        small: true, onClick: () => mutate((d) => d.soulProfiles[id].abilities.splice(i, 1), { label: soulT('removeAbility') }),
      })));
      params(path + '.abilities[' + i + ']', def);
    });
    const used = abilities.map((ability) => ability?.id);
    const hasOverride = abilities.some((ability) => ability && soulMechanisms.ability.get(mechanismKey(ability))?.overridesMovement);
    const offered = choices('ability').filter(({ value }) => {
      const def = soulMechanisms.ability.get(value);
      return !used.includes(def.id) && !(hasOverride && def.overridesMovement);
    });
    if (offered.length) g.appendChild(fieldRow(soulT('addAbility'), selectEl([null, ...offered], null, (key) => {
      if (key) mutate((d) => { d.soulProfiles[id].abilities = [...abilities, bindingOf(soulMechanisms.ability.get(key))]; }, { label: soulT('addAbility') });
    }, { allowNull: true, nullLabel: '＋' })));
    return sec('soulProfiles', soulT('title'), g);
  };

  const arenaSection = () => {
    const kind = attack().arena?.kind ?? 'box';
    const body = el('div', { class: 'pan-grid' });
    body.appendChild(selectRow('arena', 'kind', null, optionsFor('arena.kind', ['box', 'stage', 'polygon']), {
      label: T('arena.label'),
      getValue: (a) => a.arena?.kind ?? 'box',
      onChange: (kind) => mutate((draft) => {
        draft.arena = { ...draft.arena, kind };
        if (kind === 'polygon' && draft.arena.points === undefined) draft.arena.points = polygonPreset('rectangle');
      }, { label: T('undo.select', { field: T('arena.label') }) }),
    }));
    body.appendChild(hintBox(T('arena.hint')));
    const outlineLabel = T('arena.outline');
    body.appendChild(checkRow('arena', 'outline', null, outlineLabel, false, (outline) => {
      mutate((draft) => { draft.arena = { kind: 'box', ...draft.arena, outline }; }, { label: outlineLabel });
    }));
    body.appendChild(colorRow('arena', 'fill', null, { label: T('arena.fill'), nullable: true,
      onChange: (fill) => mutate((draft) => {
        draft.arena = { kind: 'box', ...draft.arena };
        if (fill === null) delete draft.arena.fill;
        else draft.arena.fill = fill;
      }, { label: T('arena.fill') }),
    }));
    body.appendChild(hintBox(T('arena.fillHint')));
    const alphaLabel = T('arena.fillAlpha');
    const alphaInput = el('input', { type: 'number', class: 'pan-input', min: 0, max: 1, step: 'any',
      placeholder: '1', 'aria-label': alphaLabel });
    const setAlpha = (value) => { alphaInput.value = value == null ? '' : String(value); };
    setAlpha(attack().arena?.fillAlpha);
    alphaInput.addEventListener('change', () => {
      if (!alphaInput.checkValidity()) { alphaInput.reportValidity(); return; }
      const value = alphaInput.value === '' ? null : alphaInput.valueAsNumber;
      mutate((draft) => {
        if (value === null) delete draft.arena?.fillAlpha;
        else draft.arena = { kind: 'box', ...draft.arena, fillAlpha: value };
      }, { label: alphaLabel });
    });
    alphaInput.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== 'Escape') return;
      event.preventDefault();
      if (event.key === 'Escape') setAlpha(attack().arena?.fillAlpha);
      alphaInput.blur();
    });
    body.appendChild(fieldRow(alphaLabel, bind({ el: alphaInput, setValue: setAlpha,
      setError: (message) => {
        alphaInput.classList.toggle('has-error', !!message);
        alphaInput.title = message || alphaLabel;
      },
    }, { path: 'arena.fillAlpha', errorKeys: ['arena.fillAlpha'] })));
    body.appendChild(hintBox(T('arena.fillAlphaHint')));
    const details = kind === 'polygon' ? polygonEditor('arena') : polygonError('arena');
    if (details) body.appendChild(details);
    return sec('arena', T('arena.section'), body);
  };

  // 區域動態：motion.x / y / rotation（數字或 t 的運算式）與 pivot（數字）。空值＝刪掉該欄位。
  const clipMotionRows = () => {
    const wrap = el('div', { class: 'pan-grid' });
    wrap.appendChild(hintBox(`${T('clip.motion')}：${T('clip.motionHint')}`));
    const exprRow = (key, labelKey) => {
      const label = T(labelKey);
      const input = el('input', { type: 'text', class: 'pan-input', placeholder: '0', 'aria-label': label });
      const read = () => attack().clipRegion?.motion?.[key];
      const setValue = (v) => { input.value = v == null ? '' : String(v); };
      setValue(read());
      input.addEventListener('change', () => {
        const text = input.value.trim();
        const value = text === '' ? null : (/^[-+]?(\d+\.?\d*|\.\d+)$/.test(text) ? Number(text) : text);
        mutate((draft) => {
          if (!draft.clipRegion) return;
          const motion = { ...(draft.clipRegion.motion || {}) };
          if (value === null) delete motion[key];
          else motion[key] = value;
          if (Object.keys(motion).length) draft.clipRegion.motion = motion;
          else delete draft.clipRegion.motion;
        }, { label });
      });
      input.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== 'Escape') return;
        event.preventDefault();
        if (event.key === 'Escape') setValue(read());
        input.blur();
      });
      return fieldRow(label, bind({ el: input, setValue,
        setError: (message) => { input.classList.toggle('has-error', !!message); input.title = message || label; },
      }, { path: `clipRegion.motion.${key}`, errorKeys: [`clipRegion.motion.${key}`] }));
    };
    wrap.appendChild(exprRow('x', 'clip.motionX'));
    wrap.appendChild(exprRow('y', 'clip.motionY'));
    wrap.appendChild(exprRow('rotation', 'clip.motionRotation'));
    const pivotRow = (axis, labelKey) => {
      const label = T(labelKey);
      const input = el('input', { type: 'number', class: 'pan-input', step: 'any', 'aria-label': label });
      const read = () => attack().clipRegion?.motion?.pivot?.[axis];
      const setValue = (v) => { input.value = v == null ? '' : String(v); };
      setValue(read());
      input.addEventListener('change', () => {
        mutate((draft) => {
          if (!draft.clipRegion) return;
          const motion = { ...(draft.clipRegion.motion || {}) };
          const pivot = { ...(motion.pivot || {}) };
          if (input.value === '') delete pivot[axis];
          else pivot[axis] = input.valueAsNumber;
          // pivot 必須 x、y 都有才有效；只填一個時用外框中心補另一個
          if (Number.isFinite(pivot.x) || Number.isFinite(pivot.y)) {
            const pts = draft.clipRegion.points || [];
            const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
            if (!Number.isFinite(pivot.x)) pivot.x = (Math.min(...xs) + Math.max(...xs)) / 2;
            if (!Number.isFinite(pivot.y)) pivot.y = (Math.min(...ys) + Math.max(...ys)) / 2;
            motion.pivot = pivot;
          } else delete motion.pivot;
          if (Object.keys(motion).length) draft.clipRegion.motion = motion;
          else delete draft.clipRegion.motion;
        }, { label });
      });
      return fieldRow(label, bind({ el: input, setValue,
        setError: (message) => { input.classList.toggle('has-error', !!message); input.title = message || label; },
      }, { path: 'clipRegion.motion.pivot', errorKeys: ['clipRegion.motion.pivot'] }));
    };
    wrap.appendChild(pivotRow('x', 'clip.pivotX'));
    wrap.appendChild(pivotRow('y', 'clip.pivotY'));
    wrap.appendChild(hintBox(T('clip.pivotHint')));
    return wrap;
  };

  const clipRegionSection = () => {
    const a = attack();
    const body = el('div', { class: 'pan-grid' });
    body.appendChild(hintBox(T('clip.hint')));
    if (a.clipRegion === undefined) {
      const error = polygonError('clipRegion');
      if (error) body.appendChild(error);
      body.appendChild(button(T('clip.create'), {
        small: true,
        onClick: () => commit('clipRegion', { points: polygonPreset('rectangle') }, { label: T('clip.create') }),
      }));
    } else {
      body.appendChild(polygonEditor('clipRegion'));
      body.appendChild(clipMotionRows());
      const inUse = usesCustomClip(a);
      body.appendChild(button(T('clip.remove'), {
        small: true, disabled: inUse, title: inUse ? T('clip.inUse') : null,
        onClick: () => mutate((draft) => { delete draft.clipRegion; }, { label: T('clip.remove') }),
      }));
      if (inUse) body.appendChild(hintBox(T('clip.inUse')));
    }
    return sec('clipRegion', T('clip.section'), body);
  };

  const renderSettingsPanel = () => {
    rootEl.appendChild(headerFor(T('title.settings'), [
      // 「產生路徑」捷徑：Demo 區塊在檢查器很下面（而且預設收合），從標題列一鍵展開＋開始產生
      button(demoGenState.running ? D('gen.running') : D('gen.start'), {
        small: true,
        class: 'pan-header-gen',
        title: D('gen.shortcutTitle'),
        disabled: demoGenState.running,
        onClick: () => {
          state.sections.demo = false;
          saveSectionState(sectionStorage(), state.sections);
          state.revealDemo = true;
          startDemoGeneration(null, null, null, null, null);
          scheduleRender();
        },
      }),
      button(T('btn.fillDefaults'), {
        small: true,
        title: T('title.fillDefaults'),
        onClick: () => mutate((draft) => { fillDefaults(draft); }, { label: T('undo.fillDefaults') }),
      }),
    ]));

    // meta
    {
      const g = el('div', { class: 'pan-grid' });
      g.appendChild(textRow('meta', 'name', null, { label: T('label.metaName') }));
      g.appendChild(textRow('meta', 'author', null, { label: T('label.metaAuthor') }));
      rootEl.appendChild(sec('meta', 'meta', g, { collapsed: true }));
    }

    // settings
    {
      const g = el('div', { class: 'pan-grid' });
      const fields = [
        { key: 'duration', label: T('label.duration'), def: 10, step: 0.5, drag: 0.1, min: 0.1, unit: F('unit.sec'), kind: 'time', timeMode: 'length' },
        { key: 'seed', label: T('label.seed'), def: 1, step: 1, drag: 1, min: 0 },
        { key: 'damage', label: T('label.damageDefault'), def: 10, step: 1, drag: 0.5, min: 0 },
        { key: 'invincibleFrames', label: T('label.invincibleFrames'), def: 30, step: 1, drag: 0.5, min: 0, unit: F('unit.frames') },
        { key: 'grazeTP', label: T('label.grazeTP'), def: 1, step: 0.1, drag: 0.02, min: 0, unit: F('unit.percentPerFrame') },
        { key: 'bpm', label: T('label.bpm'), def: null, step: 1, drag: 0.5, min: 0, max: 1000, nullable: true, nullLabel: T('label.bpmOff'), unit: T('label.bpmUnit'), hint: T('hint.bpm') },
        { key: 'beatOffset', label: T('label.beatOffset'), def: 0, step: 0.05, drag: 0.02, unit: F('unit.sec') },
      ];
      for (const f of fields) {
        g.appendChild(f.kind === 'time' ? timeRow('settings', { ...f, key: f.key }, f.key, null) : numRow('settings', f, f.key, null));
      }
      g.appendChild(spriteRow('settings', 'background', null, { label: T('label.background') }));
      g.appendChild(bgmRow());
      rootEl.appendChild(sec('settings', 'settings', g));
    }

    rootEl.appendChild(arenaSection());

    // box
    {
      const g = el('div', { class: 'pan-grid' });
      g.appendChild(selectRow('box', 'appearance', null, optionsFor('box.appearance', ['classic', 'outline', 'hidden']), {
        label: T('box.style'),
        getValue: (a) => a.box?.appearance ?? 'classic',
      }));
      const fields = [
        { key: 'x', label: 'X', def: BOX_DEFAULTS.x, step: 1, drag: 1 },
        { key: 'y', label: 'Y', def: BOX_DEFAULTS.y, step: 1, drag: 1 },
        { key: 'w', label: T('label.width'), def: BOX_DEFAULTS.w, step: 1, drag: 1, min: 1 },
        { key: 'h', label: T('label.height'), def: BOX_DEFAULTS.h, step: 1, drag: 1, min: 1 },
        { key: 'rotation', label: T('label.rotation'), def: BOX_DEFAULTS.rotation, step: 1, drag: 1, unit: F('unit.deg') },
        { key: 'border', label: T('label.border'), def: BOX_DEFAULTS.border, step: 1, drag: 0.5, min: 0, unit: 'px' },
      ];
      for (const f of fields) g.appendChild(numRow('box', f, f.key, null));
      g.appendChild(colorRow('box', 'color', null, { label: T('label.color') }));
      rootEl.appendChild(sec('box', T('section.box'), g));
    }

    rootEl.appendChild(clipRegionSection());

    // soul
    {
      const g = el('div', { class: 'pan-grid' });
      g.appendChild(selectRow('soul', 'mode', null, [SOUL_DEFAULTS.mode], { label: T('label.mode') }));
      g.appendChild(numRow('soul', { key: 'x', label: 'X', def: SOUL_DEFAULTS.x, step: 1, drag: 1, nullable: true, nullLabel: T('label.boxCenter') }, 'x', null));
      g.appendChild(numRow('soul', { key: 'y', label: 'Y', def: SOUL_DEFAULTS.y, step: 1, drag: 1, nullable: true, nullLabel: T('label.boxCenter') }, 'y', null));
      g.appendChild(numRow('soul', { key: 'speed', label: T('label.speed'), def: SOUL_DEFAULTS.speed, step: 0.5, drag: 0.1, min: 0, unit: F('unit.pxPerFrame') }, 'speed', null));
      g.appendChild(numRow('soul', { key: 'slowSpeed', label: T('label.slowSpeed'), def: SOUL_DEFAULTS.slowSpeed, step: 0.5, drag: 0.1, min: 0, unit: F('unit.pxPerFrame') }, 'slowSpeed', null));
      g.appendChild(colorRow('soul', 'color', null, { label: T('label.color') }));
      rootEl.appendChild(sec('soul', T('section.soul'), g));
    }

    rootEl.appendChild(soulProfilesPanel());

    // party
    rootEl.appendChild(sec('party', T('section.party'), listEditor({
      listKey: 'party',
      itemLabel: (m, i) => (m && m.name ? T('item.partyName', { i: i + 1, name: m.name }) : T('item.party', { i: i + 1 })),
      emptyText: T('empty.party'),
      addLabel: T('btn.addParty'),
      createItem: () => ({ name: 'New', hp: 90, maxHp: 90, color: '#00ffff', icon: null }),
      fields: [
        { key: 'name', kind: 'text', label: T('label.partyName') },
        { key: 'hp', kind: 'num', label: 'HP', step: 1, drag: 0.5, min: 0, def: 90 },
        { key: 'maxHp', kind: 'num', label: 'MaxHP', step: 1, drag: 0.5, min: 0, def: 90 },
        { key: 'color', kind: 'color', label: T('label.color') },
        { key: 'icon', kind: 'sprite', label: T('label.icon') },
      ],
    })));

    // enemies
    rootEl.appendChild(sec('enemies', T('section.enemies'), listEditor({
      listKey: 'enemies',
      itemLabel: (m, i) => (m && m.sprite ? T('item.enemySprite', { i: i + 1, sprite: m.sprite }) : T('item.enemy', { i: i + 1 })),
      emptyText: T('empty.enemies'),
      addLabel: T('btn.addEnemy'),
      createItem: () => ({ sprite: null, x: 520, y: 200, scale: 2, frameRate: 4 }),
      fields: [
        { key: 'sprite', kind: 'sprite', label: 'sprite' },
        { key: 'x', kind: 'num', label: 'X', step: 1, drag: 1, def: 520 },
        { key: 'y', kind: 'num', label: 'Y', step: 1, drag: 1, def: 200 },
        { key: 'scale', kind: 'num', label: T('label.scale'), step: 0.1, drag: 0.02, min: 0.01, max: 20, def: 2 },
        { key: 'frameRate', kind: 'num', label: T('label.enemyFps'), step: 1, drag: 0.25, min: 0, max: 60, def: 4 },
      ],
    })));

    const demoEl = demoSection();
    demoEl.id = 'pan-section-demo';
    rootEl.appendChild(demoEl);
    if (state.revealDemo) {
      // 從標題列的「產生路徑」過來：把 Demo 區塊捲進視野（進度條與結果在那裡）
      state.revealDemo = false;
      const reveal = () => {
        try {
          demoEl.scrollIntoView({ block: 'start', behavior: 'auto' });
        } catch (_err) {
          /* 測試環境沒有 scrollIntoView */
        }
      };
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(reveal);
      else reveal();
    }

    rootEl.appendChild(exprHelpSection());
  };

  const listEditor = (cfg) => {
    const wrap = el('div', { class: 'pan-list' });
    const a = attack();
    const list = Array.isArray(a[cfg.listKey]) ? a[cfg.listKey] : [];
    if (list.length === 0) wrap.appendChild(el('div', { class: 'pan-empty-sub', text: cfg.emptyText }));

    list.forEach((item, i) => {
      const basePath = `${cfg.listKey}[${i}]`;
      const box = el('div', { class: 'pan-list-item' });
      const head = el('div', { class: 'pan-list-head' });
      head.appendChild(el('span', { class: 'pan-list-title', text: cfg.itemLabel(item, i) }));
      head.appendChild(button(T('btn.delete'), {
        small: true, variant: 'danger', title: T('title.deleteItem', { i: i + 1 }),
        onClick: () => {
          if (!confirm(T('confirm.deleteItem', { name: cfg.itemLabel(item, i) }))) return;
          mutate((draft) => {
            if (Array.isArray(draft[cfg.listKey])) draft[cfg.listKey].splice(i, 1);
          }, { label: T('undo.deleteItem', { list: cfg.listKey }) });
        },
      }));
      box.appendChild(head);

      const g = el('div', { class: 'pan-grid pan-grid-tight' });
      for (const f of cfg.fields) {
        if (f.kind === 'num') g.appendChild(numRow(basePath, { ...f, def: f.def ?? 0 }, f.key, null));
        else if (f.kind === 'text') g.appendChild(textRow(basePath, f.key, null, { label: f.label }));
        else if (f.kind === 'color') g.appendChild(colorRow(basePath, f.key, null, { label: f.label }));
        else if (f.kind === 'sprite') g.appendChild(spriteRow(basePath, f.key, null, { label: f.label }));
      }
      box.appendChild(g);
      wrap.appendChild(box);
    });

    wrap.appendChild(button(cfg.addLabel, {
      small: true,
      onClick: () => mutate((draft) => {
        if (!Array.isArray(draft[cfg.listKey])) draft[cfg.listKey] = [];
        draft[cfg.listKey].push(cfg.createItem());
      }, { label: T('undo.addItem', { list: cfg.listKey }) }),
    }));
    return wrap;
  };

  /* ---------------- 演示 demo（SPEC-AUTOPLAY §4） ---------------- */

  /** 確保 draft.demo 是物件（就地）。 */
  const ensureDemoObject = (draft) => {
    if (!draft.demo || typeof draft.demo !== 'object') draft.demo = {};
    return draft.demo;
  };

  const demoOf = (a) => (a && a.demo && typeof a.demo === 'object' ? a.demo : {});

  /* --- §4-7 路徑點數值表格 ---
   *
   * 每個路徑點一列，t / x / y / slow / hold 可直接編輯，列尾有上移／下移／刪除。
   * 寫入一律走 store.update（可 undo）且只改單一欄位、不重排索引，
   * 因此預覽疊加層拖點（以 index 定址）與表格列永遠是同一個點；
   * 反向同步靠 bind() 的 setValue：store 變更 → syncFields() 就地更新輸入框
   * （正在編輯的那一格不動，避免搶焦點）。
   */

  const demoTablePath = (i, key) => `demo.path[${i}].${key}`;

  /**
   * 表格列「目前時間落點」狀態（-2 = 尚未計算，-1 = 沒有）。
   * tbody 快取由 demoTable() 在每次重繪時填入，避免每幀都 querySelector。
   */
  const demoRowState = { active: -2, tbody: null };

  /**
   * 依目前時間游標標出「正在使用的區段」那一列（預覽播放時跟著跑）。
   * 純 DOM 操作、不重建表格；同一列不重複寫入。
   */
  const highlightDemoRow = () => {
    if (state.destroyed) return;
    const body = demoRowState.tbody && demoRowState.tbody.isConnected
      ? demoRowState.tbody
      : rootEl.querySelector('.pan-demo-table tbody');
    demoRowState.tbody = body;
    if (!body) { demoRowState.active = -1; return; }
    const demo = demoOf(attack());
    const path = demoPathOf(demo);
    const timeline = buildDemoTimeline(path, { timing: settingsTiming() });
    let active = -1;
    if (timeline && preview && typeof preview.getFrame === 'function') {
      const time = (Number(preview.getFrame()) || 0) / 30;
      const starts = timeline.starts;
      for (let i = 0; i < starts.length; i += 1) {
        const nextStart = i + 1 < starts.length ? starts[i + 1] : timeline.end;
        if (time >= starts[i] && time < nextStart) { active = i; break; }
      }
      if (active < 0 && time >= timeline.end && starts.length > 0) active = starts.length - 1;
    }
    if (active === demoRowState.active) return;
    demoRowState.active = active;
    const rows = body.children;
    for (let i = 0; i < rows.length; i += 1) {
      rows[i].classList.toggle('is-active', i === active);
    }
  };

  /** 單一數值儲存格（t / x / y / hold）。t 可輸入拍點字串（`"2b"`，SPEC-EXPR-V2 §2）。 */
  const demoNumCell = (i, key) => {
    const path = demoTablePath(i, key);
    const isTime = key === 't';
    const input = el('input', {
      // t 可能是拍點字串 `"2b"`，用 text 才輸入得下去；其他欄位維持數字輸入框
      type: isTime ? 'text' : 'number',
      class: `pan-input pan-input-num pan-demo-cell${isTime ? ' pan-demo-cell-time' : ''}`,
      step: key === 't' || key === 'hold' ? '0.1' : '1',
      autocomplete: 'off',
      'aria-label': D(`col.${key}`),
      title: isTime ? F('time.dragTitle') : D(`col.${key}`),
    });
    if (isTime) input.placeholder = F('time.placeholder');

    const restore = () => {
      const cur = getPath(attack(), path);
      input.value = cur === null || cur === undefined ? '' : String(cur);
    };
    restore();

    const write = (value) => {
      mutate((draft) => {
        const demo = ensureDemoObject(draft);
        const next = setDemoPointField(demoPathOf(demo), i, key, value, { timing: settingsTiming() });
        if (next.length > 0) demo.path = next;
        else delete demo.path;
      }, { label: D('undo.editCell') });
      if (store && typeof store.endCoalesce === 'function') store.endCoalesce();
    };

    const commitCell = () => {
      const raw = input.value.trim();
      if (raw === '') {
        // t / x / y 必填（清空＝還原）；hold 清空＝移除 hold
        if (key === 'hold') write(null);
        else restore();
        return;
      }
      if (isTime) {
        // 秒數或拍點字串都可；非法值（含沒有 bpm 卻寫 "2b"）→ 還原
        const parsed = parseTime(raw, settingsTiming(), { addOffset: true, allowNegative: false });
        if (!parsed.ok || parsed.empty) { restore(); return; }
        write(raw);
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) { restore(); return; }
      write(n);
    };

    // 只在 change 提交：value 改了又失焦時 change 一定會觸發。
    // （不要再掛 blur → commit：面板重繪時 clear() 移除正在聚焦的輸入框會先觸發 blur，
    //   commit 又同步觸發 store 通知 → 遞迴重繪，導致 removeChild NotFoundError。）
    input.addEventListener('change', commitCell);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commitCell(); input.blur(); return; }
      if (e.key === 'Escape') { restore(); input.blur(); return; }
      // ↑／↓ 微調（Shift = 10 倍）；表格內用鍵盤也能改數值
      if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        const stepBase = key === 't' || key === 'hold' ? 0.1 : 1;
        const delta = (e.key === 'ArrowUp' ? 1 : -1) * stepBase * (e.shiftKey ? 10 : 1);
        if (isTime) {
          const base = timePointSeconds(input.value, settingsTiming(), 0);
          const timing = settingsTiming();
          const next = roundDemoValue(Math.max(0, base + delta), 2);
          // 原本寫拍點字串就延續拍點寫法（每次 ↑↓ 走 0.1 秒，不改寫使用者風格）
          const text = formatLike(next, input.value, timing, true);
          input.value = String(text);
          write(text);
          return;
        }
        const curNow = Number(input.value);
        const base = Number.isFinite(curNow) ? curNow : 0;
        const next = roundDemoValue(Math.max(0, base + delta), 2);
        input.value = String(next);
        write(next);
      }
    });

    const ctl = {
      el: input,
      setValue: (v) => { input.value = v === null || v === undefined ? '' : String(v); },
      setError: (msg) => { input.classList.toggle('has-error', !!msg); input.title = msg || D(`col.${key}`); },
      isEditing: () => document.activeElement === input,
    };
    bind(ctl, { path, getValue: (a) => getPath(a, path), errorKeys: [path] });
    return input;
  };

  /** 單一 slow 儲存格（勾選框）。 */
  const demoSlowCell = (i) => {
    const path = demoTablePath(i, 'slow');
    const chk = checkboxEl(getPath(attack(), path) === true, (v) => {
      mutate((draft) => {
        const demo = ensureDemoObject(draft);
        demo.path = setDemoPointField(demoPathOf(demo), i, 'slow', v === true);
      }, { label: D('undo.editCell') });
    }, null);
    chk.classList.add('pan-demo-slow');
    chk.title = D('col.slow');
    bind({
      el: chk,
      setValue: (v) => chk.setChecked(v === true),
      isEditing: () => chk.contains(document.activeElement),
    }, { path, getValue: (a) => getPath(a, path) === true, errorKeys: [path] });
    return chk;
  };

  /** 表格一列。 */
  const demoTableRow = (i, count) => {
    const tr = el('tr', { class: 'pan-demo-tr', 'data-index': String(i) });
    tr.appendChild(el('td', { class: 'pan-demo-td pan-demo-td-index', text: String(i + 1) }));
    tr.appendChild(el('td', { class: 'pan-demo-td' }, demoNumCell(i, 't')));
    tr.appendChild(el('td', { class: 'pan-demo-td' }, demoNumCell(i, 'x')));
    tr.appendChild(el('td', { class: 'pan-demo-td' }, demoNumCell(i, 'y')));
    tr.appendChild(el('td', { class: 'pan-demo-td pan-demo-td-center' }, demoSlowCell(i)));
    tr.appendChild(el('td', { class: 'pan-demo-td' }, demoNumCell(i, 'hold')));

    const tools = el('div', { class: 'pan-demo-rowtools' });
    tools.appendChild(button('↑', {
      small: true,
      title: D('moveUp'),
      disabled: i === 0,
      onClick: () => {
        mutate((draft) => {
          const demo = ensureDemoObject(draft);
          demo.path = moveDemoPoint(demoPathOf(demo), i, -1);
        }, { label: D('undo.movePoint') });
      },
    }));
    tools.appendChild(button('↓', {
      small: true,
      title: D('moveDown'),
      disabled: i >= count - 1,
      onClick: () => {
        mutate((draft) => {
          const demo = ensureDemoObject(draft);
          demo.path = moveDemoPoint(demoPathOf(demo), i, 1);
        }, { label: D('undo.movePoint') });
      },
    }));
    tools.appendChild(button('✕', {
      small: true,
      variant: 'danger',
      title: D('removeTitle'),
      onClick: () => {
        mutate((draft) => {
          const demo = ensureDemoObject(draft);
          const next = removeDemoPoint(demoPathOf(demo), i);
          if (next.length > 0) demo.path = next;
          else delete demo.path;
        }, { label: D('undo.removePoint') });
      },
    }));
    tr.appendChild(el('td', { class: 'pan-demo-td pan-demo-td-tools' }, tools));
    return tr;
  };

  /** 整個表格（表頭 + 每點一列）。 */
  const demoTable = (path) => {
    const wrap = el('div', { class: 'pan-demo-tablewrap' });
    const table = el('table', { class: 'pan-demo-table' });
    const thead = el('thead');
    const htr = el('tr');
    // 欄位順序取自 demo-path.js 的 DEMO_POINT_FIELDS（與列內容共用同一份定義，避免漂移）
    for (const key of ['index', ...DEMO_POINT_FIELDS, 'actions']) {
      const label = key === 'index' || key === 'actions' ? '' : D(`col.${key}`);
      htr.appendChild(el('th', {
        class: `pan-demo-th pan-demo-th-${key}`,
        text: key === 'index' ? '#' : label,
        title: label,
      }));
    }
    thead.appendChild(htr);
    table.appendChild(thead);
    const tbody = el('tbody');
    path.forEach((_pt, i) => tbody.appendChild(demoTableRow(i, path.length)));
    table.appendChild(tbody);
    demoRowState.tbody = tbody;
    demoRowState.active = -2; // 重繪後重新計算高亮列
    wrap.appendChild(table);
    return wrap;
  };

  const demoAddPoint = (source) => {
    const attackDoc = attack();
    if (!attackDoc) return;
    const frame = preview && typeof preview.getFrame === 'function' ? Number(preview.getFrame()) || 0 : 0;
    const t = roundDemoValue(frame / 30, 2);
    const box = demoBoxFor(attackDoc);
    let x = box.x;
    let y = box.y;
    if (source === 'soul') {
      const st = preview && typeof preview.getState === 'function' ? preview.getState() : null;
      if (st && st.soul && Number.isFinite(st.soul.x) && Number.isFinite(st.soul.y)) {
        x = st.soul.x;
        y = st.soul.y;
      }
    } else {
      const target = demoPathTargetAt(buildDemoTimeline(demoPathOf(demoOf(attackDoc)), { timing: settingsTiming() }), t);
      if (target) {
        x = target.x;
        y = target.y;
      }
    }
    const pt = clampDemoPoint(x, y, box, DEMO_MARGIN);
    mutate(
      (draft) => {
        const demo = ensureDemoObject(draft);
        demo.path = addDemoPoint(demoPathOf(demo), { t, x: pt.x, y: pt.y });
      },
      { label: D('undo.addPoint') },
    );
  };

  const demoInputsBlock = () => {
    const demo = demoOf(attack());
    const text = typeof demo.inputs === 'string' ? demo.inputs : '';
    const info = decodeDemoInputs(text);
    const wrap = el('div', { class: 'pan-demo-inputs' });
    if (text) {
      wrap.appendChild(el('div', { class: 'pan-readonly', text: D('inputsInfo', { segments: info.segments, frames: info.frames }) }));
      wrap.appendChild(el('div', { class: 'pan-readonly', text: D('inputsLength', { length: text.length }) }));
    } else {
      wrap.appendChild(el('div', { class: 'pan-empty-sub', text: D('inputsEmpty') }));
    }
    const inputErr = lookupError(errorsMap(), ['demo.inputs']);
    if (inputErr.hasError) wrap.appendChild(el('div', { class: 'pan-field-error', text: inputErr.message }));
    const actions = el('div', { class: 'pan-inline-actions' });
    const recording = !!(preview && typeof preview.isRecording === 'function' && preview.isRecording());
    actions.appendChild(
      button(recording ? D('stopRecord') : D('record'), {
        small: true,
        class: recording ? 'is-danger' : '',
        title: recording ? D('stopRecord') : D('recordHint'),
        onClick: () => {
          if (!preview) return;
          if (recording && typeof preview.stopRecording === 'function') preview.stopRecording();
          else if (typeof preview.startRecording === 'function') preview.startRecording();
          scheduleRender();
        },
      }),
    );
    actions.appendChild(
      button(D('clearInputs'), {
        small: true,
        title: D('clearInputsTitle'),
        disabled: !text,
        onClick: () => {
          mutate((draft) => {
            if (!draft.demo || typeof draft.demo !== 'object') return;
            delete draft.demo.inputs;
            if (draft.demo.mode === 'inputs') draft.demo.mode = 'bot';
          }, { label: D('undo.clearInputs') });
        },
      }),
    );
    wrap.appendChild(actions);
    wrap.appendChild(el('div', { class: 'pan-empty-sub', text: recording ? D('recordActive') : D('recordHint') }));
    return wrap;
  };

  /* --- V2-06：自動產生路徑（engine/autoplay/pathgen.js 的 generateDemoPath） --- */

  /** 產生工作的狀態（跨重繪保存；重繪時只更新 DOM，不重跑）。 */
  const demoGenState = {
    running: false,
    progress: null,
    result: null,
    error: null,
    controller: null,
  };

  /** 目前自動演示 pilot 是否就緒（describe().ready === false 時要提示）。 */
  const autopilotReady = () => {
    if (!preview || typeof preview.describeAutopilot !== 'function') return null;
    try {
      return preview.describeAutopilot();
    } catch (_err) {
      return null;
    }
  };

  const demoGenBlock = () => {
    const wrap = el('div', { class: 'pan-demogen' });
    const head = el('div', { class: 'pan-list-head' });
    head.appendChild(el('span', { class: 'pan-list-title', text: D('gen.title') }));
    head.appendChild(el('span', { class: 'pan-list-sub', text: D('gen.sub') }));
    wrap.appendChild(head);

    const status = el('div', { class: 'pan-demogen-status' });
    const progressBar = el('div', { class: 'pan-demogen-bar' });
    const progressFill = el('span', { class: 'pan-demogen-fill' });
    progressBar.appendChild(progressFill);
    progressBar.hidden = true;

    const actions = el('div', { class: 'pan-inline-actions' });
    const genBtn = button(demoGenState.running ? D('gen.running') : D('gen.start'), {
      small: true,
      title: D('gen.startTitle'),
      disabled: demoGenState.running,
      onClick: () => startDemoGeneration(genBtn, status, progressBar, progressFill, actions),
    });
    actions.appendChild(genBtn);
    const cancelBtn = button(D('gen.cancel'), {
      small: true,
      variant: 'danger',
      title: D('gen.cancelTitle'),
      disabled: !demoGenState.running,
      onClick: () => cancelDemoGeneration(),
    });
    actions.appendChild(cancelBtn);
    wrap.appendChild(actions);
    wrap.appendChild(progressBar);
    wrap.appendChild(status);

    const setStatus = (text, kind) => {
      status.textContent = text || '';
      status.classList.toggle('is-error', kind === 'error');
      status.classList.toggle('is-ok', kind === 'ok');
    };
    if (demoGenState.running) {
      const p = demoGenState.progress;
      progressBar.hidden = false;
      progressFill.style.width = p ? `${progressPercent(p)}%` : '8%';
      setStatus(p ? D('gen.progress', { phase: p.phase || '-', sweep: p.sweep, hits: p.hits }) : D('gen.starting'));
    } else if (demoGenState.error) {
      setStatus(D('gen.failed', { error: demoGenState.error }), 'error');
    } else if (demoGenState.result) {
      const r = demoGenState.result;
      const done = D('gen.done', { points: r.points, hits: r.hits, ms: Math.round(r.elapsedMs) });
      const clearance = r.clearanceMet || r.clearance === null ? '' : ` ${D('gen.clearanceWarning', { actual: r.clearance.toFixed(2), target: r.clearanceTarget })}`;
      setStatus(done + clearance, r.ok ? 'ok' : 'error');
    }

    // 自動駕駛未就緒（describe().ready === false）→ 提示（實際軌跡／AI 對照會不準）
    const desc = autopilotReady();
    if (desc && desc.ready === false) {
      wrap.appendChild(el('div', { class: 'pan-demogen-warn', text: D('gen.pilotNotReady') }));
    }
    return wrap;
  };

  /** 進度 → 百分比（引擎沒有總量百分比，用掃描輪數估）。 */
  const progressPercent = (p) => {
    if (!p) return 5;
    const sweeps = Number.isFinite(p.sweep) ? p.sweep : 0;
    return Math.max(5, Math.min(95, Math.round((sweeps / 8) * 100)));
  };

  const cancelDemoGeneration = () => {
    if (demoGenState.controller) {
      try {
        demoGenState.controller.abort();
      } catch (_err) {
        /* 忽略 */
      }
    }
    demoGenState.running = false;
    demoGenState.error = null;
    scheduleRender();
  };

  const startDemoGeneration = async (btn, status, progressBar, progressFill, actions) => {
    if (demoGenState.running) return;
    const attackDoc = store && store.attack ? deepCloneForWorker(store.attack) : null;
    if (!attackDoc) return;
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    demoGenState.running = true;
    demoGenState.error = null;
    demoGenState.progress = null;
    demoGenState.result = null;
    demoGenState.controller = controller;
    if (btn) { btn.disabled = true; btn.textContent = D('gen.running'); }
    if (progressBar) { progressBar.hidden = false; progressFill.style.width = '8%'; }
    if (status) { status.textContent = D('gen.starting'); status.classList.remove('is-error', 'is-ok'); }
    try {
      const { result, cancelled, error } = await generatePathAsync(attackDoc, {
        seed: GEN_DEFAULTS.seed,
        step: GEN_DEFAULTS.step,
        timeBudgetMs: GEN_DEFAULTS.timeBudgetMs,
        signal: controller ? controller.signal : null,
        workerFactory: createWorkerFactory(),
        onProgress: (p) => {
          demoGenState.progress = p;
          if (!demoGenState.running) return;
          // 從標題列捷徑啟動時沒有傳入節點（Demo 區塊是之後才重繪出來的）→ 即時從 DOM 找
          const fillEl = progressBar ? progressFill : rootEl.querySelector('.pan-demogen-fill');
          const statusEl = status || rootEl.querySelector('.pan-demogen-status');
          if (fillEl) fillEl.style.width = `${progressPercent(p)}%`;
          if (statusEl) statusEl.textContent = D('gen.progress', { phase: p.phase || '-', sweep: p.sweep, hits: p.hits });
        },
      });
      demoGenState.running = false;
      demoGenState.controller = null;
      if (cancelled) {
        demoGenState.result = null;
        scheduleRender();
        return;
      }
      if (error) {
        demoGenState.error = error;
        scheduleRender();
        return;
      }
      const summary = summarizeGenResult(result);
      const nextDemo = nextDemoForResult(result);
      if (!nextDemo) {
        demoGenState.error = D('gen.empty');
        scheduleRender();
        return;
      }
      demoGenState.result = summary;
      // 套用到 demo.path（一筆 store.update → 可 Undo）
      mutate((draft) => {
        const d = ensureDemoObject(draft);
        d.mode = nextDemo.mode;
        if (nextDemo.fallback) d.fallback = nextDemo.fallback;
        d.path = nextDemo.path;
        if (nextDemo.inputs) d.inputs = nextDemo.inputs;
        else delete d.inputs;
      }, { label: D('undo.genPath') });
      if (store && typeof store.endCoalesce === 'function') store.endCoalesce();
      if (preview && typeof preview.setAutoplayMode === 'function') {
        // 產生完直接看得到效果：切到「腳本」模式
        if (typeof preview.getAutoplayMode === 'function' && preview.getAutoplayMode() === 'off') {
          preview.setAutoplayMode('demo');
        }
      }
      if (preview && typeof preview.setDemoOverlayVisible === 'function') preview.setDemoOverlayVisible(true);
      if (preview && typeof preview.setTraceVisible === 'function') preview.setTraceVisible(true);
      if (preview && typeof preview.traceDemoPath === 'function') preview.traceDemoPath();
      scheduleRender();
    } catch (err) {
      demoGenState.running = false;
      demoGenState.controller = null;
      demoGenState.error = String((err && err.message) || err);
      scheduleRender();
    }
  };

  /** Worker 需要 structured-clone 得動的純資料；順手把函式欄位排除。 */
  const deepCloneForWorker = (doc) => {
    try {
      return JSON.parse(JSON.stringify(doc));
    } catch (_err) {
      return null;
    }
  };

  /* --- V2-06：實際軌跡疊圖（traceDemo） --- */

  const demoTraceBlock = () => {
    const wrap = el('div', { class: 'pan-demotrace' });
    const head = el('div', { class: 'pan-list-head' });
    head.appendChild(el('span', { class: 'pan-list-title', text: D('trace.title') }));
    const trace = preview && typeof preview.getTrace === 'function' ? preview.getTrace() : null;
    const shown = preview && typeof preview.isTraceVisible === 'function' ? preview.isTraceVisible() : false;
    head.appendChild(el('span', { class: 'pan-list-sub', text: trace ? D('trace.hits', { hits: trace.hits.length }) : D('trace.none') }));
    wrap.appendChild(head);

    const actions = el('div', { class: 'pan-inline-actions' });
    actions.appendChild(button(D('trace.recompute'), {
      small: true,
      title: D('trace.recomputeTitle'),
      onClick: () => {
        if (preview && typeof preview.traceDemoPath === 'function') preview.traceDemoPath();
        scheduleRender();
      },
    }));
    const chk = checkboxEl(shown, (v) => {
      if (preview && typeof preview.setTraceVisible === 'function') preview.setTraceVisible(v);
      scheduleRender();
    }, D('trace.show'));
    chk.title = D('trace.showTitle');
    actions.appendChild(chk);
    wrap.appendChild(actions);

    if (trace) {
      const dev = trace.deviation;
      const info = el('div', { class: 'pan-demotrace-info' });
      const frames = Array.isArray(trace.frames) ? trace.frames.length : 0;
      info.appendChild(el('span', { text: D('trace.frames', { frames }) }));
      if (dev && Number.isFinite(dev.avg)) {
        info.appendChild(el('span', { text: D('trace.deviation', { avg: dev.avg.toFixed(2), max: (dev.max || 0).toFixed(2) }) }));
      }
      if (Array.isArray(trace.hits) && trace.hits.length > 0) {
        const framesText = trace.hits.slice(0, 8).map((h) => h.frame).join(', ');
        info.appendChild(el('span', { class: 'pan-demotrace-hit', text: D('trace.hitFrames', { frames: framesText }) }));
      }
      wrap.appendChild(info);
    }

    const desc = autopilotReady();
    if (desc && desc.ready === false) {
      wrap.appendChild(el('div', { class: 'pan-demogen-warn', text: D('trace.pilotNotReady') }));
    }
    return wrap;
  };

  const demoSection = () => {
    const a = attack();
    const demo = demoOf(a);
    const path = demoPathOf(demo);
    const body = el('div', { class: 'pan-demo' });
    body.appendChild(el('div', { class: 'pan-empty-sub', text: D('sectionHint') }));

    // mode / fallback
    const top = el('div', { class: 'pan-grid pan-grid-tight' });
    const modeOptions = [
      { value: 'path', label: D('mode.path') },
      { value: 'inputs', label: D('mode.inputs') },
      { value: 'bot', label: D('mode.bot') },
    ];
    const modeSel = selectEl(modeOptions, demo.mode, (v) => {
      mutate((draft) => {
        const d = ensureDemoObject(draft);
        if (v === null || v === undefined || v === '') delete d.mode;
        else d.mode = v;
      }, { label: D('undo.edit') });
    }, { allowNull: true, nullLabel: D('mode.auto') });
    const modeError = lookupError(errorsMap(), ['demo.mode']);
    modeSel.classList.toggle('has-error', modeError.hasError);
    modeSel.title = modeError.hasError ? modeError.message : '';
    top.appendChild(fieldRow(D('mode'), modeSel));
    top.appendChild(
      selectRow('demo', 'fallback', null, [
        { value: 'bot', label: D('fallback.bot') },
        { value: 'stay', label: D('fallback.stay') },
      ], { label: D('fallback') }),
    );
    body.appendChild(top);

    // V2-06：自動產生路徑（Web Worker）＋實際軌跡疊圖開關＋自動駕駛未就緒提示
    body.appendChild(demoGenBlock());
    body.appendChild(demoTraceBlock());

    // path 清單（§4-7：數值表格，每點一列 t/x/y/slow/hold 可直接編輯）
    const pathHead = el('div', { class: 'pan-list-head' });
    pathHead.appendChild(el('span', { class: 'pan-list-title', text: D('path') }));
    pathHead.appendChild(
      el('span', { class: 'pan-list-sub', text: D('pathInfo', { count: path.length, duration: roundDemoValue(demoPathDuration(path, { timing: settingsTiming() }), 1) }) }),
    );
    body.appendChild(pathHead);
    if (path.length === 0) {
      body.appendChild(emptyState(D('pathEmpty'), D('pathEmptySub')));
    } else {
      const pathMode = demo.mode === 'path';
      const hint = el('div', { class: 'pan-demo-tablehint' });
      hint.appendChild(el('span', { text: D('tableHint') }));
      if (!pathMode) hint.appendChild(el('span', { class: 'pan-demo-tablewarn', text: D('tableModeWarn') }));
      body.appendChild(hint);
      body.appendChild(demoTable(path));
    }

    const addRow = el('div', { class: 'pan-inline-actions' });
    addRow.appendChild(button(D('addCursor'), { small: true, title: D('addCursorTitle'), onClick: () => demoAddPoint('cursor') }));
    addRow.appendChild(button(D('addSoul'), { small: true, title: D('addSoulTitle'), onClick: () => demoAddPoint('soul') }));
    body.appendChild(addRow);

    // inputs
    body.appendChild(el('div', { class: 'pan-list-title', text: D('inputs') }));
    body.appendChild(demoInputsBlock());

    // demo 錯誤總覽（validateAttackDemo 的路徑訊息）
    const demoErrors = [];
    for (const [key, msg] of errorsMap()) {
      if (String(key).startsWith('demo')) demoErrors.push([key, msg]);
    }
    if (demoErrors.length > 0) {
      const errBox = el('div', { class: 'pan-demo-errors' });
      errBox.appendChild(el('div', { class: 'pan-empty-sub', text: D('errorHint') }));
      for (const [key, msg] of demoErrors.slice(0, 8)) {
        const row = el('div', { class: 'pan-error-row' });
        row.appendChild(el('code', { class: 'pan-code', text: key }));
        row.appendChild(el('span', { class: 'pan-error-msg', text: String(msg) }));
        errBox.appendChild(row);
      }
      body.appendChild(errBox);
    }

    // 預設收合（區塊很長，會把後面的說明擠到很下面）；使用者展開後會被記住
    return sec('demo', D('section'), body, { collapsed: true });
  };

  const exprHelpSection = () => {
    const body = el('div', { class: 'pan-expr-help' });
    const cols = el('div', { class: 'pan-expr-cols' });
    const left = el('div', { class: 'pan-expr-col' });
    left.appendChild(el('div', { class: 'pan-expr-h', text: T('exprHelp.vars') }));
    for (const v of EXPR_VARIABLES) {
      const row = el('div', { class: 'pan-expr-row' });
      row.appendChild(el('code', { class: 'pan-code', text: v.name }));
      row.appendChild(el('span', { class: 'pan-expr-desc', text: v.desc }));
      left.appendChild(row);
    }
    const right = el('div', { class: 'pan-expr-col' });
    right.appendChild(el('div', { class: 'pan-expr-h', text: T('exprHelp.fns') }));
    for (const f of EXPR_FUNCTIONS) {
      const row = el('div', { class: 'pan-expr-row' });
      row.appendChild(el('code', { class: 'pan-code', text: f.name }));
      row.appendChild(el('span', { class: 'pan-expr-desc', text: f.desc }));
      right.appendChild(row);
    }
    cols.appendChild(left);
    cols.appendChild(right);
    body.appendChild(cols);
    body.appendChild(hintBox(T('exprHelp.hint')));
    return sec('exprHelp', T('section.exprHelp'), body, { collapsed: true });
  };

  const errorSummarySection = (errs, opts = {}) => {
    const body = el('div', { class: 'pan-error-list' });
    let n = 0;
    for (const [key, msg] of errs) {
      if (n >= 40) {
        body.appendChild(el('div', { class: 'pan-empty-sub', text: T('errors.more', { n: errs.size - n }) }));
        break;
      }
      const row = el('div', { class: 'pan-error-row' });
      row.appendChild(el('code', { class: 'pan-code', text: key }));
      row.appendChild(el('span', { class: 'pan-error-msg', text: String(msg) }));
      body.appendChild(row);
      n += 1;
    }
    return sec('errors', T('errors.title', { n: errs.size }), body, { collapsed: !!opts.collapsed });
  };

  /* ---------------- 更新排程 ---------------- */

  // 選取 / 形狀變更 → 立即重繪（同步）。值變更 → 就地同步欄位。
  // 錯誤變更可能來自非同步驗證（ED1 可能在 store.update 之後才填 errors），
  // 因此用 setTimeout 合併成一輪重繪；不用 rAF —— 無頭／背景分頁可能不觸發 rAF。
  let renderPending = false;
  const scheduleRender = () => {
    if (state.destroyed || renderPending) return;
    renderPending = true;
    const run = () => {
      renderPending = false;
      if (state.destroyed) return;
      render();
      refreshSubtitle();
    };
    setTimeout(run, 0);
  };

  const onStoreChange = (change) => {
    if (state.destroyed) return;
    const key = shapeKey();
    if (key !== state.shape) {
      render();
      refreshSubtitle();
      state.lastErrorSig = errorsSig();
      return;
    }
    // 錯誤集合變動（store 以 change.errors === true 通知）→ 需要重建橫幅／錯誤總覽；
    // 欄位紅框也會一起被重繪後的 syncFields() 更新。
    const sig = errorsSig();
    if ((change && change.errors) || sig !== state.lastErrorSig) {
      state.lastErrorSig = sig;
      scheduleRender();
      return;
    }
    syncFields();
    refreshSubtitle();
    // §4-7：拖曳預覽上的路徑點 → 表格數值就地跟著變（值同步），列高亮也一起更新
    highlightDemoRow();
  };

  /* ---------------- 生命週期 ---------------- */

  render();
  refreshSubtitle();

  /* ---------- 語系切換：整份重繪（保留選取 / 捲動 / 摺疊狀態） ---------- */

  const relabel = () => {
    if (state.destroyed) return;
    rootEl.setAttribute('aria-label', T('aria'));
    render();
    refreshSubtitle();
  };

  const unsubLocale = onLocaleChange(() => { if (!state.destroyed) relabel(); });

  if (store && typeof store.subscribe === 'function') {
    state.unsub = store.subscribe((_s, change) => onStoreChange(change));
  }

  const controller = {
    destroy() {
      state.destroyed = true;
      if (typeof state.unsub === 'function') state.unsub();
      if (typeof unsubLocale === 'function') unsubLocale();
      clear(rootEl);
      rootEl.classList.remove('pan-inspector');
      instances.delete(rootEl);
    },
    refresh: () => scheduleRender(),
    get usesStore() { return !!store; },
  };
  instances.set(rootEl, controller);
  return controller;
}

/* =========================================================================
 * 模組層級小工具 / 額外 export
 * ========================================================================= */

let uidCounter = 0;
function nextUid() {
  uidCounter += 1;
  return `${Date.now().toString(36)}-${uidCounter}`;
}

function sameValue(a, b) {
  if (a === b) return true;
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) || Math.abs(a - b) < 1e-9;
  if (a && b && typeof a === 'object' && typeof b === 'object') return domSig(a) === domSig(b);
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return false;
}

/**
 * 為 settings / box / soul / 陣列欄位補上缺漏的預設值（不覆寫既有值）。
 * 就地修改 draft；回傳 draft。
 */
export function fillDefaults(draft) {
  if (!draft || typeof draft !== 'object') return draft;
  if (draft.format === undefined) draft.format = 'dr-battle-attack/1';
  if (!draft.meta || typeof draft.meta !== 'object') draft.meta = { name: '', author: '' };
  if (draft.meta.name === undefined) draft.meta.name = '';
  if (draft.meta.author === undefined) draft.meta.author = '';

  draft.settings = draft.settings && typeof draft.settings === 'object' ? draft.settings : {};
  const s = draft.settings;
  if (s.duration === undefined) s.duration = 10;
  if (s.seed === undefined) s.seed = 1;
  if (s.damage === undefined) s.damage = 10;
  if (s.invincibleFrames === undefined) s.invincibleFrames = 30;
  if (s.grazeTP === undefined) s.grazeTP = 1;
  if (s.background === undefined) s.background = null;
  if (s.bgm === undefined) s.bgm = null;

  draft.box = draft.box && typeof draft.box === 'object' ? draft.box : {};
  const b = draft.box;
  if (b.x === undefined) b.x = BOX_DEFAULTS.x;
  if (b.y === undefined) b.y = BOX_DEFAULTS.y;
  if (b.w === undefined) b.w = BOX_DEFAULTS.w;
  if (b.h === undefined) b.h = BOX_DEFAULTS.h;
  if (b.rotation === undefined) b.rotation = BOX_DEFAULTS.rotation;
  if (b.border === undefined) b.border = BOX_DEFAULTS.border;
  if (b.color === undefined) b.color = BOX_DEFAULTS.color;

  draft.soul = draft.soul && typeof draft.soul === 'object' ? draft.soul : {};
  const so = draft.soul;
  if (so.x === undefined) so.x = SOUL_DEFAULTS.x;
  if (so.y === undefined) so.y = SOUL_DEFAULTS.y;
  if (so.speed === undefined) so.speed = SOUL_DEFAULTS.speed;
  if (so.slowSpeed === undefined) so.slowSpeed = SOUL_DEFAULTS.slowSpeed;
  if (so.mode === undefined) so.mode = SOUL_DEFAULTS.mode;
  if (so.color === undefined) so.color = SOUL_DEFAULTS.color;

  if (!Array.isArray(draft.party)) draft.party = [];
  if (!Array.isArray(draft.enemies)) draft.enemies = [];
  if (!Array.isArray(draft.timeline)) draft.timeline = [];
  if (!draft.bulletTypes || typeof draft.bulletTypes !== 'object') draft.bulletTypes = {};
  return draft;
}

/**
 * 預設空攻擊（開發／測試用；ED1「新建」也可用）。
 * 注意：`meta.name` 是資料（會寫進 JSON 檔），不是介面字串，因此固定繁中，
 * 不隨語系變動；顯示端（ED1 工具列／標題）會自行處理未命名項目。
 */
export function createEmptyAttack() {
  return fillDefaults({
    format: 'dr-battle-attack/1',
    meta: { name: '未命名', author: '' },
    bulletTypes: {
      default: {
        sprite: null,
        frameRate: 0,
        scale: 1,
        color: null,
        hitbox: { shape: 'circle', r: 6 },
        damage: null,
        grazeable: true,
        destroyOnHit: true,
        faceVelocity: true,
        offscreen: 'destroy',
        maskToBox: false,
      },
    },
    timeline: [],
  });
}

export { defaultSpawnValues, EVENT_TYPE_ORDER };
