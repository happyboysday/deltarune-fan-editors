// editor/encounter/actor-editor.js  (ED3, Phase 2)
//
// 演員動畫編輯器：掛在 ED1 提供的 #enc-actor-body（檢查器右側的「演員」分頁）。
//
// 內容（SPEC-P2 §1 actors.<id>）：
//   - 動畫狀態表：新增／刪除狀態，每個狀態可設 sprite（接受素材瀏覽器拖放）、
//     fps、loop、then，並有即時小動畫預覽。
//   - 「套用預設」：從 assets/actor-presets.json 匯入（A3 產生；不存在時停用並提示）。
//   - 初始位置 x / y，以及「在預覽中拖曳」的提示與呼叫（preview 若支援就交給它）。
//
// 純邏輯集中在檔案前段，可直接在 node 測試（不碰 DOM）。

import { t, registerStrings, onLocaleChange, getLocale } from '../i18n.js';
import STRINGS from '../locales/encounter-panels.js';
// 選填欄位（scale / flip）的字串在 encanim 命名空間 → 匯入即註冊
import '../locales/encounter-demo.js';
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
  normalizeErrors,
  lookupError,
  isEditingIn,
} from '../fields.js';
import { ensureEncounterStyles, docOf, readSelection, quoteKey, KIND } from './tree.js';
import { defaultAnimLoop } from '../../engine/encounter/schema.js';
import { LAYOUT } from '../../engine/encounter/layout.js';

registerStrings('encPanels', STRINGS);

const T = (key, params) => t(`encPanels.${key}`, params);
// 動畫狀態表的選填欄位字串放在 encanim 命名空間（見 editor/locales/encounter-demo.js）
const ta = (key, params) => t(key, params);

/* =========================================================================
 * 1. 純邏輯
 * ========================================================================= */

/**
 * 內建動畫狀態名（SPEC-P2 §3）：隊員與敵人各有自己的集合。
 * 這些名稱同時是引擎會主動播放的狀態，自訂名稱也可（由 anim 指令觸發）。
 */
export const PARTY_ANIM_STATES = ['idle', 'attack', 'act', 'magic', 'item', 'spare', 'defend', 'hurt', 'down', 'victory'];
export const ENEMY_ANIM_STATES = ['idle', 'hurt', 'spared', 'defeat'];

/** 依演員 kind 取得內建狀態名清單。 */
export function builtinStates(kind) {
  return kind === 'enemy' ? ENEMY_ANIM_STATES.slice() : PARTY_ANIM_STATES.slice();
}

/**
 * 正規化單一動畫狀態（缺欄位補預設）。
 * scale / flip 是選填（引擎：scale 乘上演員 scale；flip 省略＝沿用演員）——
 * 未設定時不寫出這兩個鍵，維持與舊資料完全相同的輸出面。
 */
export function normalizeAnim(anim, name) {
  const src = anim && typeof anim === 'object' ? anim : {};
  const fps = Number(src.fps);
  const out = {
    sprite: src.sprite === undefined || src.sprite === '' ? null : src.sprite,
    fps: Number.isFinite(fps) && fps > 0 ? fps : 5,
    loop: src.loop === undefined ? defaultAnimLoop(name) : !!src.loop,
    then: src.then === undefined || src.then === null || src.then === '' ? null : String(src.then),
  };
  const scale = Number(src.scale);
  if (src.scale !== undefined && src.scale !== null && src.scale !== '' && Number.isFinite(scale)) {
    out.scale = Math.max(0.01, scale);
  }
  if (src.flip !== undefined && src.flip !== null) out.flip = !!src.flip;
  return out;
}

/** 建立新動畫狀態。 */
export function createAnim(patch = {}) {
  return normalizeAnim({ sprite: null, fps: 5, loop: true, then: null, ...patch });
}

/**
 * 確保 actor.anims 是物件；不改傳入物件以外的东西。
 * @returns {Record<string, object>}
 */
export function animsOf(actor) {
  const out = {};
  const src = actor && actor.anims && typeof actor.anims === 'object' ? actor.anims : {};
  for (const [key, value] of Object.entries(src)) out[key] = normalizeAnim(value, key);
  return out;
}

/** 不衝突的狀態名：先找未用的內建名，否則 state2、state3… */
export function nextStateName(kind, taken) {
  const used = new Set((taken || []).map(String));
  for (const name of builtinStates(kind)) {
    if (!used.has(name)) return name;
  }
  let n = 2;
  while (used.has(`state${n}`)) n += 1;
  return `state${n}`;
}

/** 由選取解析要編輯的演員：{ actorId, actor, found }。 */
export function actorTarget(doc, selection) {
  const sel = selection || {};
  if (!doc) return { actorId: null, actor: null, found: false };
  const actors = doc.actors && typeof doc.actors === 'object' ? doc.actors : {};
  let id = null;
  if (sel.kind === KIND.actor && sel.id !== null && sel.id !== undefined) {
    id = String(sel.id);
  } else if (typeof sel.path === 'string') {
    const m = /^actors\.(.+)$/.exec(sel.path);
    if (m) {
      const raw = m[1];
      if (raw.startsWith('[')) {
        try {
          id = String(JSON.parse(raw.slice(1, raw.lastIndexOf(']'))));
        } catch {
          id = raw;
        }
      } else id = raw;
    }
  }
  if (!id || !Object.prototype.hasOwnProperty.call(actors, id)) {
    return { actorId: id, actor: null, found: false };
  }
  const actor = actors[id] || {};
  return { actorId: id, actor, found: !!(actor && actor.anims !== undefined ? true : true) };
}

/**
 * 由 actor-presets.json 取出可套用的預設。
 *
 * 檔案格式（A3）：
 *   { "actors": { "actorName": { "kind": "party"|"enemy", "anims": { idle:{sprite,fps,loop,then} } } } }
 * 也接受：{ "presets": { ... } }、或直接 { "actorName": { anims } }。
 *
 * @returns {{ id: string, kind: string, anims: Record<string, object> }[]}
 */
export function listPresets(presetsDoc) {
  if (!presetsDoc || typeof presetsDoc !== 'object') return [];
  const table =
    presetsDoc.actors && typeof presetsDoc.actors === 'object'
      ? presetsDoc.actors
      : presetsDoc.presets && typeof presetsDoc.presets === 'object'
        ? presetsDoc.presets
        : presetsDoc;
  const out = [];
  for (const [id, value] of Object.entries(table)) {
    if (!value || typeof value !== 'object') continue;
    if (!value.anims || typeof value.anims !== 'object') continue;
    out.push({ id, kind: value.kind === 'enemy' ? 'enemy' : value.kind === 'party' ? 'party' : null, anims: animsOf(value) });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return out;
}

/** 依戲服 kind 過濾預設（kind 未標示的也保留）。 */
export function presetsForKind(presets, kind) {
  const list = Array.isArray(presets) ? presets : [];
  return list.filter((p) => !p.kind || !kind || p.kind === kind);
}

/** 合併預設的動畫到既有 anims（預設優先，其餘保留）。 */
export function mergeAnims(base, presetAnims) {
  const out = {};
  for (const [key, value] of Object.entries(base || {})) out[key] = normalizeAnim(value, key);
  for (const [key, value] of Object.entries(presetAnims || {})) out[key] = normalizeAnim(value, key);
  return out;
}

/**
 * 動畫預覽的影格索引。
 * @param {number} elapsedMs 已播放時間（毫秒）
 * @param {number} fps 每秒影格
 * @param {number} frameCount sprite 的影格數（≥1）
 * @param {boolean} loop 是否循環
 * @returns {number} 0..frameCount-1
 */
export function previewFrame(elapsedMs, fps, frameCount, loop = true) {
  const n = Math.max(1, Math.floor(frameCount || 1));
  const f = Number(fps) > 0 ? Number(fps) : 5;
  const raw = Math.floor((Math.max(0, elapsedMs) / 1000) * f);
  if (loop) return raw % n;
  return Math.min(raw, n - 1);
}

/** sprite 幀數（assets 索引項 → 影格數）。 */
export function frameCountOf(meta) {
  if (!meta || typeof meta !== 'object') return 1;
  if (Array.isArray(meta.frames)) return Math.max(1, meta.frames.length);
  if (Number.isFinite(Number(meta.frameCount))) return Math.max(1, Number(meta.frameCount));
  return 1;
}

/** 該演員目前有哪些動畫狀態名（排序：內建在前，其餘照字母）。 */
export function stateNames(actor) {
  const anims = animsOf(actor);
  const names = Object.keys(anims);
  const order = builtinStates(actor && actor.kind);
  names.sort((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  return names;
}

/** 演員位置是否有效（0..640 × 0..480）。 */
export function clampPosition(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.round(n), 0), max);
}

/* ---------------- 形態（SPEC-P2 §1 forms） ---------------- */

/** actor.forms 物件（沒有回 null）。 */
export function formsOf(actor) {
  return actor && actor.forms && typeof actor.forms === 'object' && !Array.isArray(actor.forms) ? actor.forms : null;
}

/** 形態名清單（宣告順序）。 */
export function formNamesOf(actor) {
  const forms = formsOf(actor);
  return forms ? Object.keys(forms) : [];
}

/** 某個形態的動畫組（formName 省略 / 不存在 → 基礎 actor.anims）。 */
export function animsOfGroup(actor, formName) {
  const forms = formsOf(actor);
  if (formName && forms && forms[formName]) {
    const src = forms[formName].anims && typeof forms[formName].anims === 'object' ? forms[formName].anims : {};
    const out = {};
    for (const [key, value] of Object.entries(src)) out[key] = normalizeAnim(value, key);
    return out;
  }
  return animsOf(actor);
}

/** 動畫欄位路徑（基礎 / 形態共用；給 setAt 與錯誤標紅）。 */
export function animPathOf(actorId, formName, animName) {
  const base = `actors.${quoteKey(actorId)}`;
  const group = formName ? `${base}.forms.${quoteKey(formName)}` : base;
  return `${group}.anims.${quoteKey(animName)}`;
}

/** 不衝突的形態名：form1、form2…（先避開既有；_copy 後綴用於複製）。 */
export function nextFormName(taken, base = 'form') {
  const used = new Set((taken || []).map(String));
  let n = 1;
  while (used.has(`${base}${n}`)) n += 1;
  return `${base}${n}`;
}

/** 複製形態時的不衝突名字：name-copy、name-copy2… */
export function copyFormName(taken, name) {
  const used = new Set((taken || []).map(String));
  let candidate = `${name}-copy`;
  let n = 2;
  while (used.has(candidate)) {
    candidate = `${name}-copy${n}`;
    n += 1;
  }
  return candidate;
}

/* =========================================================================
 * 2. 掛載層
 * ========================================================================= */

/* 邏輯畫面尺寸（唯一來源：engine/encounter/layout.js，與遊戲渲染共用） */
const VIEW_W = LAYOUT.VIEW_W;
const VIEW_H = LAYOUT.VIEW_H;

const instances = new WeakMap();

/** 取得真正的內容容器（#enc-actor → #enc-actor-body）。 */
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
 * 掛載演員編輯器。
 * @param {HTMLElement} rootEl #enc-actor-body
 * @param {{store:object, assets?:object|null, preview?:object|null}} ctx
 */
export function mount(rootEl, ctx = {}) {
  if (!rootEl) return { destroy() {} };
  const previous = instances.get(rootEl);
  if (previous && typeof previous.destroy === 'function') previous.destroy();

  ensureEncounterStyles();

  const store = ctx.store || null;
  const assets = ctx.assets || null;
  const preview = ctx.preview || null;
  const host = contentHost(rootEl);

  const state = {
    destroyed: false,
    sections: {},
    presets: null, // null = 尚未載入；[] = 載入失敗或空的
    presetsError: '',
    presetsLoading: false,
    presetDisplayNames: {},
    renders: [], // 每個狀態列的預覽 API
    timer: 0,
    startedAt: Date.now(),
    shape: '',
    lastErrorsSig: '',
    unsub: null,
    unsubLocale: null,
    // 形態：目前編輯動畫組（null = 基礎 actor.anims；字串 = forms[name]）
    editForm: null,
    lastActorId: null,
  };

  host.classList.add('enc-actor-pane');

  const commit = (fn, label, coalesceKey) => {
    if (!store || typeof store.update !== 'function') return false;
    try {
      return store.update(fn, { label: label || T('undo.edit'), coalesceKey });
    } catch (err) {
      console.error('[actor-editor] 寫入失敗：', err);
      return false;
    }
  };

  const setAt = (path, value, label) => {
    if (!store) return false;
    try {
      if (typeof store.setAt === 'function') return store.setAt(path, value, { label: label || T('undo.edit') });
    } catch (err) {
      console.error('[actor-editor] 寫入失敗：', err);
    }
    return commit((draft) => writeAtPath(draft, path, value), label);
  };

  /* ---------------- 預設檔 ---------------- */

  /** 預設顯示名（A3 的 actor-presets.json 有 displayNames）。 */
  const presetLabel = (id) => {
    const names = state.presetDisplayNames || {};
    const dn = names[id];
    if (typeof dn === 'string' && dn) return `${dn}（${id}）`;
    if (dn && typeof dn === 'object') {
      const text = dn.zh || dn['zh-Hant'] || dn.en;
      if (text) return `${text}（${id}）`;
    }
    return id;
  };

  const presetsUrl = () => {
    try {
      return new URL('../../assets/actor-presets.json', import.meta.url).href;
    } catch {
      return 'assets/actor-presets.json';
    }
  };

  const loadPresets = async () => {
    if (state.presetsLoading || state.presets) return;
    state.presetsLoading = true;
    try {
      // ED1 在 boot 時已載入（ctx.api.actorPresets）；優先使用，避免重複 fetch。
      const preloaded = ctx && ctx.api ? ctx.api.actorPresets : null;
      let data = preloaded;
      if (!data) {
        if (typeof fetch !== 'function') throw new Error('no fetch');
        const res = await fetch(presetsUrl(), { cache: 'no-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        data = await res.json();
      }
      state.presetDisplayNames = (data && data.displayNames) || {};
      state.presets = listPresets(data);
      state.presetsError = state.presets.length ? '' : T('ae.presetsEmpty');
    } catch (err) {
      state.presets = [];
      state.presetsError = T('ae.presetsMissing');
    } finally {
      state.presetsLoading = false;
      if (!state.destroyed) render();
    }
  };

  /* ---------------- 預覽動畫 ---------------- */

  const startTimer = () => {
    if (state.timer) return;
    state.startedAt = Date.now();
    state.timer = setInterval(() => {
      if (state.destroyed) return;
      const elapsed = Date.now() - state.startedAt;
      for (const r of state.renders) {
        try {
          r.paint(elapsed);
        } catch (err) {
          /* 單一預覽失敗不影響其他 */
        }
      }
    }, 80);
  };

  const stopTimer = () => {
    if (state.timer) clearInterval(state.timer);
    state.timer = 0;
  };

  /** 建立一個動畫小預覽（canvas + 尺寸資訊）。 */
  const animPreview = (actorId, animName, anim) => {
    const size = 72;
    const wrap = el('div', { class: 'enc-animpreview' });
    const canvas = el('canvas', { class: 'enc-animcanvas', width: String(size), height: String(size) });
    wrap.appendChild(canvas);
    const meta = el('div', { class: 'enc-animmeta' });
    wrap.appendChild(meta);
    const ctx2d = canvas.getContext ? canvas.getContext('2d') : null;

    const api = {
      paint(elapsed) {
        const spriteName = anim.sprite;
        const info = spriteName && assets && typeof assets.sprite === 'function' ? assets.sprite(spriteName) : null;
        const frames = frameCountOf(info);
        const idx = previewFrame(elapsed, anim.fps, frames, anim.loop);
        if (ctx2d) {
          ctx2d.clearRect(0, 0, size, size);
          const img = spriteName && assets && typeof assets.getImage === 'function' ? assets.getImage(spriteName, idx) : null;
          if (img && img.width) {
            const scale = Math.min(size / img.width, size / img.height);
            const w = Math.max(1, Math.round(img.width * scale));
            const h = Math.max(1, Math.round(img.height * scale));
            ctx2d.imageSmoothingEnabled = false;
            ctx2d.drawImage(img, Math.round((size - w) / 2), Math.round((size - h) / 2), w, h);
          } else {
            ctx2d.fillStyle = 'rgba(255,255,255,0.08)';
            ctx2d.fillRect(0, 0, size, size);
          }
        }
        const label = spriteName
          ? T('ae.previewMeta', { w: info ? info.w : '?', h: info ? info.h : '?', frames })
          : T('ae.spriteMissing');
        if (meta.textContent !== label) meta.textContent = label;
      },
    };
    api.paint(0);
    state.renders.push(api);
    return wrap;
  };

  /* ---------------- 動作 ---------------- */

  const applyPreset = (actorId, preset) => {
    const doc = docOf(store) || {};
    const actor = (doc.actors || {})[actorId];
    if (!actor || !preset) return;
    const merged = mergeAnims(animsOf(actor), preset.anims);
    commit(
      (draft) => {
        const a = draft.actors && draft.actors[actorId];
        if (!a) return;
        a.anims = merged;
      },
      T('ae.presetsApplied', { name: preset.id }),
    );
    if (!state.destroyed) render();
  };

  /* ---------------- 形態（actor.forms） ---------------- */

  /** 表單提示改名（瀏覽器 prompt；沒有 prompt 就直接回傳預設值）。 */
  const askName = (title, fallback) => {
    const draft = typeof prompt === 'function' ? prompt(title, fallback) : fallback;
    if (draft === null) return null;
    return String(draft || '').trim();
  };

  /** 把 cue 內指向舊形態名的 ref 一起改名（深走訪 turns / hooks / acts，不影響其他欄位）。 */
  const renameFormRefs = (doc, actorId, oldName, newName) => {
    const walk = (node) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) walk(item);
        return;
      }
      const ref = node.form;
      if (ref && typeof ref === 'object' && !Array.isArray(ref) && ref.actor === actorId && ref.name === oldName) {
        ref.name = newName;
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === 'object') walk(value);
      }
    };
    walk(doc);
  };

  const addForm = (actorId, actor) => {
    const names = formNamesOf(actor);
    const suggested = nextFormName(names);
    const name = askName(T('ae.formPrompt'), suggested);
    if (name === null) return;
    if (!name) return;
    if (names.includes(name)) {
      toastLocal(T('ae.dupForm', { name }));
      return;
    }
    commit((draft) => {
      const a = draft.actors && draft.actors[actorId];
      if (!a) return;
      if (!a.forms || typeof a.forms !== 'object' || Array.isArray(a.forms)) a.forms = {};
      a.forms[name] = { anims: {} };
    }, T('ae.addForm'));
    state.editForm = name;
    render();
  };

  const renameForm = (actorId, actor, oldName, newNameRaw) => {
    const newName = String(newNameRaw || '').trim();
    if (!newName || newName === oldName) return;
    if (formNamesOf(actor).includes(newName)) {
      toastLocal(T('ae.dupForm', { name: newName }));
      return;
    }
    commit((draft) => {
      const a = draft.actors && draft.actors[actorId];
      if (!a || !a.forms || !a.forms[oldName]) return;
      // 保留鍵順序
      const entries = Object.entries(a.forms).map(([k, v]) => [k === oldName ? newName : k, v]);
      for (const k of Object.keys(a.forms)) delete a.forms[k];
      for (const [k, v] of entries) a.forms[k] = v;
      if (a.form === oldName) a.form = newName;
      renameFormRefs(draft, actorId, oldName, newName);
    }, T('btn.rename'));
    if (state.editForm === oldName) state.editForm = newName;
    render();
  };

  const duplicateForm = (actorId, actor, name) => {
    const forms = formsOf(actor);
    if (!forms || !forms[name]) return;
    const clone = JSON.parse(JSON.stringify(forms[name]));
    const newName = copyFormName(Object.keys(forms), name);
    commit((draft) => {
      const a = draft.actors && draft.actors[actorId];
      if (!a) return;
      if (!a.forms || typeof a.forms !== 'object') a.forms = {};
      a.forms[newName] = clone;
    }, T('ae.duplicateForm'));
    state.editForm = newName;
    render();
  };

  const deleteForm = (actorId, name) => {
    commit((draft) => {
      const a = draft.actors && draft.actors[actorId];
      if (!a || !a.forms || !a.forms[name]) return;
      delete a.forms[name];
      if (a.form === name) delete a.form;
      if (Object.keys(a.forms).length === 0) delete a.forms;
    }, T('ae.deleteForm'));
    if (state.editForm === name) state.editForm = null;
    render();
  };

  /** 設定初始形態（actor.form；空字串 = 省略）。 */
  const setInitialForm = (actorId, name) => {
    setAt(`actors.${quoteKey(actorId)}.form`, name ? name : undefined, T('ae.formInitial'));
  };

  /** 在預覽中即時切換形態（走 cue:form，與遊戲同一條路徑）。 */
  const previewFormInStage = (actorId, name) => {
    if (preview && typeof preview.runCues === 'function') {
      try {
        const ok = preview.runCues([{ cmd: 'form', actor: actorId, name }]);
        toastLocal(ok === false ? T('ae.formPreviewFail') : T('ae.formPreviewOk', { name }));
        return;
      } catch (err) {
        console.warn('[actor-editor] 預覽切換形態失敗：', err);
      }
    }
    toastLocal(T('ae.formPreviewFail'));
  };

  /** 切換目前編輯的動畫組（null = 基礎）。 */
  const setEditForm = (actorId, formName) => {
    state.editForm = formName || null;
    render();
  };

  const addState = (actorId, actor, formName = null) => {
    const group = formName ? animsOfGroup(actor, formName) : animsOf(actor);
    const existing = Object.keys(group);
    let name = nextStateName(actor && actor.kind, existing);
    if (typeof prompt === 'function') {
      const input = prompt(T('ae.statePrompt'), name);
      if (input === null) return;
      const clean = String(input).trim();
      if (clean === '') return;
      if (Object.prototype.hasOwnProperty.call(group, clean)) {
        toastLocal(T('ae.dupState', { name: clean }));
        return;
      }
      name = clean;
    }
    // 形態新增狀態：基礎有同名動畫時先複製它的設定（sprite/fps/loop…）
    const baseAnim = formName ? animsOf(actor)[name] : null;
    const created = baseAnim ? normalizeAnim(baseAnim, name) : createAnim({ loop: defaultAnimLoop(name) });
    commit((draft) => {
      const a = draft.actors && draft.actors[actorId];
      if (!a) return;
      if (formName) {
        if (!a.forms || typeof a.forms !== 'object' || Array.isArray(a.forms)) a.forms = {};
        if (!a.forms[formName] || typeof a.forms[formName] !== 'object') a.forms[formName] = {};
        const f = a.forms[formName];
        if (!f.anims || typeof f.anims !== 'object') f.anims = {};
        f.anims[name] = created;
      } else {
        if (!a.anims || typeof a.anims !== 'object') a.anims = {};
        a.anims[name] = created;
      }
    }, T('ae.addState'));
    render();
  };

  const deleteState = (actorId, name, formName = null) => {
    commit((draft) => {
      const a = draft.actors && draft.actors[actorId];
      if (!a) return;
      const anims = formName
        ? a.forms && a.forms[formName] && a.forms[formName].anims
        : a.anims;
      if (!anims) return;
      delete anims[name];
    }, T('ae.deleteState'));
    render();
  };

  const renameState = (actorId, oldName, newNameRaw, formName = null) => {
    const newName = String(newNameRaw || '').trim();
    if (!newName || newName === oldName) return;
    const doc = docOf(store) || {};
    const actor = (doc.actors || {})[actorId];
    const group = formName ? animsOfGroup(actor, formName) : animsOf(actor);
    if (Object.prototype.hasOwnProperty.call(group, newName)) {
      toastLocal(T('ae.dupState', { name: newName }));
      return;
    }
    commit((draft) => {
      const a = draft.actors && draft.actors[actorId];
      if (!a) return;
      const anims = formName ? a.forms && a.forms[formName] && a.forms[formName].anims : a.anims;
      if (!anims || !anims[oldName]) return;
      // 保留鍵順序
      const entries = Object.entries(anims).map(([k, v]) => [k === oldName ? newName : k, v]);
      for (const k of Object.keys(anims)) delete anims[k];
      for (const [k, v] of entries) anims[k] = v;
      // then 指向舊名時一併更新（同一組內）
      for (const anim of Object.values(anims)) {
        if (anim && anim.then === oldName) anim.then = newName;
      }
    }, T('btn.rename'));
    render();
  };

  const startDragInPreview = (actorId) => {
    // ED1 的 preview.js 本身已支援在替代模式圖層拖曳演員並寫回 x/y。
    // 若 ED1 之後提供更明確的 API，這裡優先使用它。
    if (preview) {
      for (const fn of ['beginActorDrag', 'startActorDrag', 'enableActorDrag']) {
        if (typeof preview[fn] === 'function') {
          try {
            preview[fn](actorId);
            toastLocal(T('ae.dragStart'));
            return;
          } catch (err) {
            console.warn('[actor-editor] preview 拖曳 API 失敗：', err);
          }
        }
      }
    }
    // 後備：preview.js 的替代模式圖層（.fb-actor）本身可拖；把目標演員閃一下提示位置。
    if (typeof document !== 'undefined' && actorId) {
      const sel = `#enc-actor-layer .fb-actor[data-actor="${String(actorId).replace(/"/g, '\\"')}"]`;
      let node = null;
      try {
        node = document.querySelector(sel);
      } catch {
        node = null;
      }
      if (node) {
        node.classList.add('enc-actor-flash');
        setTimeout(() => {
          try {
            node.classList.remove('enc-actor-flash');
          } catch {
            /* 節點可能已被移除 */
          }
        }, 1200);
        toastLocal(T('ae.dragHint'));
        return;
      }
    }
    toastLocal(T('ae.dragHint'));
  };

  const toastLocal = (message) => {
    // ED1 的 ctx.report(text, kind) 統一 toast；沒有時用本地後備。
    if (ctx && typeof ctx.report === 'function') {
      try {
        ctx.report(message, 'info');
        return;
      } catch {
        /* 落回本地 */
      }
    }
    if (typeof document === 'undefined') return;
    try {
      const root = document.getElementById('toast-root');
      if (!root) return;
      const node = document.createElement('div');
      node.className = 'toast';
      node.textContent = message;
      root.appendChild(node);
      setTimeout(() => {
        try {
          node.remove();
        } catch {
          /* 忽略 */
        }
      }, 2600);
    } catch {
      /* 忽略 */
    }
  };

  /* ---------------- 渲染 ---------------- */

  const header = (title, sub) => {
    const h = el('div', { class: 'enc-insp-header' });
    h.appendChild(el('div', { class: 'enc-insp-title', text: title }));
    if (sub) h.appendChild(el('div', { class: 'enc-insp-sub', text: sub }));
    return h;
  };

  const spriteFor = (actorId, name, anim, formName = null) => {
    const path = `${animPathOf(actorId, formName, name)}.sprite`;
    const field = spriteFieldLocal(path, anim.sprite, actorId, name);
    return field;
  };

  /** sprite 欄位（沿用 Phase 1 的 fields.spriteField，含拖放與挑選器）。 */
  const spriteFieldLocal = (path, value, _actorId, _name) => {
    // 動態 import 以避免循環：fields.spriteField 不依賴本檔
    const holder = el('div', { class: 'enc-field' });
    const errEl = el('div', { class: 'pan-field-error' });
    let api = null;
    import('../fields.js')
      .then((mod) => {
        if (state.destroyed) return;
        // fields.spriteField 回傳的是「元素本身」（帶 setValue/setError/openPicker 屬性），
        // 不是 { el } 包裝。
        api = mod.spriteField({
          value,
          assets,
          nullable: true,
          placeholder: T('ae.spriteMissing'),
          onChange: (v) => setAt(path, v, T('undo.edit')),
        });
        clear(holder);
        holder.appendChild(api);
        holder.appendChild(errEl);
        syncError();
      })
      .catch((err) => {
        console.warn('[actor-editor] sprite 欄位載入失敗：', err);
        holder.appendChild(textInput(value === null || value === undefined ? '' : String(value), (v) => setAt(path, v || null, T('undo.edit')), { mono: true }));
      });
    const syncError = () => {
      const errs = store ? store.errors : null;
      const hit = lookupError(normalizeErrors(errs), [path]);
      const msg = hit.hasError ? String(hit.message || '') : '';
      errEl.textContent = msg;
      errEl.classList.toggle('show', !!msg);
      holder.classList.toggle('has-error', !!msg);
      if (api && typeof api.setError === 'function') api.setError(msg);
    };
    return holder;
  };

  const numberAt = (path, value, opts = {}) => {
    const input = el('input', {
      type: 'number',
      class: 'pan-input pan-input-num enc-input-num',
      step: opts.step === undefined ? '1' : String(opts.step),
      min: opts.min === undefined ? null : String(opts.min),
      max: opts.max === undefined ? null : String(opts.max),
    });
    input.value = value === null || value === undefined ? '' : String(value);
    const commitNum = () => {
      const raw = input.value.trim();
      if (raw === '') {
        input.value = value === null || value === undefined ? '' : String(value);
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        input.value = String(value ?? '');
        return;
      }
      const out = opts.integer ? Math.round(n) : n;
      setAt(path, out, T('undo.edit'));
    };
    input.addEventListener('change', commitNum);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitNum();
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = String(value ?? '');
        input.blur();
      }
    });
    return input;
  };

  /** 選填數字欄位（留空 = 移除該鍵；給形態 scale / offset 用）。 */
  const optionalNumberAt = (path, value, opts = {}) => {
    const input = el('input', {
      type: 'number',
      class: 'pan-input pan-input-num enc-input-num',
      step: opts.step === undefined ? '1' : String(opts.step),
      min: opts.min === undefined ? null : String(opts.min),
      max: opts.max === undefined ? null : String(opts.max),
    });
    input.value = value === null || value === undefined ? '' : String(value);
    input.title = opts.title || '';
    const commitNum = () => {
      const raw = input.value.trim();
      if (raw === '') {
        input.value = '';
        setAt(path, undefined, T('undo.edit'));
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n)) {
        input.value = value === null || value === undefined ? '' : String(value);
        return;
      }
      const out = opts.integer ? Math.round(n) : n;
      if (typeof opts.positive === 'number' && out <= opts.positive) {
        input.value = value === null || value === undefined ? '' : String(value);
        return;
      }
      setAt(path, out, T('undo.edit'));
    };
    input.addEventListener('change', commitNum);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitNum();
        input.blur();
      } else if (e.key === 'Escape') {
        input.value = value === null || value === undefined ? '' : String(value);
        input.blur();
      }
    });
    return input;
  };

  const animRow = (actorId, actor, name, anim, allNames, formName = null) => {
    const path = animPathOf(actorId, formName, name);
    const box = el('div', { class: 'enc-animrow' });
    // 形態動畫組：沒直接定義的動畫顯示基礎值（繼承；編輯任一欄位就會寫成覆蓋）
    const isInherited = Boolean(formName) && !Object.prototype.hasOwnProperty.call(animsOfGroup(actor, formName), name);

    const head = el('div', { class: 'enc-animrow-head' });
    const nameInput = textInput(name, (v) => renameState(actorId, name, v, formName), { mono: true, class: 'enc-animname' });
    nameInput.title = T('ae.stateName');
    head.appendChild(nameInput);
    if (builtinStates(actor && actor.kind).includes(name)) {
      head.appendChild(el('span', { class: 'enc-tag', text: 'builtin' }));
    }
    if (isInherited) head.appendChild(el('span', { class: 'enc-tag enc-tag-inherited', text: T('ae.formInherited') }));
    if (!isInherited) {
      head.appendChild(
        button('✕', {
          small: true,
          variant: 'danger',
          title: T('ae.deleteState'),
          onClick: () => {
            if (typeof confirm === 'function' && !confirm(T('confirm.delete', { name }))) return;
            deleteState(actorId, name, formName);
          },
        }),
      );
    }
    box.appendChild(head);

    const previewWrap = animPreview(actorId, name, anim);
    box.appendChild(previewWrap);

    box.appendChild(fieldRow(T('ae.sprite'), spriteFor(actorId, name, anim, formName)));
    box.appendChild(fieldRow(T('ae.fps'), numberAt(`${path}.fps`, anim.fps, { step: '0.5', min: 0.1, max: 60 })));
    box.appendChild(fieldRow(T('ae.loop'), checkboxEl(anim.loop, (next) => setAt(`${path}.loop`, next, T('undo.edit')), T('ae.loop'))));
    const thenOptions = [{ value: '', label: T('ae.thenNone') }].concat(
      allNames.filter((n) => n !== name).map((n) => ({ value: n, label: n })),
    );
    const thenSel = selectEl(thenOptions, anim.then || '', (v) => setAt(`${path}.then`, v || null, T('undo.edit')));
    box.appendChild(fieldRow(T('ae.then'), thenSel));

    /* 選填：scale（乘上演員 scale；留空 = 不縮放） */
    const scaleInput = el('input', {
      type: 'number',
      class: 'pan-input pan-input-num enc-input-num',
      step: '0.05',
      min: '0.01',
      max: '4',
    });
    scaleInput.value = anim.scale === undefined || anim.scale === null ? '' : String(anim.scale);
    scaleInput.title = ta('encanim.scaleHint');
    const commitScale = () => {
      const raw = scaleInput.value.trim();
      if (raw === '') {
        scaleInput.value = '';
        if (anim.scale !== undefined) setAt(`${path}.scale`, undefined, T('undo.edit'));
        return;
      }
      const n = Number(raw);
      if (!Number.isFinite(n) || n <= 0) {
        scaleInput.value = anim.scale === undefined ? '' : String(anim.scale);
        return;
      }
      const out = Math.max(0.01, n);
      if (out !== n) scaleInput.value = String(out);
      setAt(`${path}.scale`, out, T('undo.edit'));
    };
    scaleInput.addEventListener('change', commitScale);
    scaleInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitScale();
        scaleInput.blur();
      } else if (e.key === 'Escape') {
        scaleInput.value = anim.scale === undefined ? '' : String(anim.scale);
        scaleInput.blur();
      }
    });
    box.appendChild(fieldRow(ta('encanim.scale'), scaleInput, { title: ta('encanim.scaleHint'), class: 'enc-inline-row' }));

    /* 選填：flip（省略 = 沿用演員；true / false 才寫出） */
    const flipOptions = [
      { value: '', label: ta('encanim.flipInherit') },
      { value: 'true', label: ta('encanim.flipOn') },
      { value: 'false', label: ta('encanim.flipOff') },
    ];
    const flipValue = anim.flip === undefined ? '' : anim.flip ? 'true' : 'false';
    const flipSel = selectEl(flipOptions, flipValue, (v) => {
      if (v === '') setAt(`${path}.flip`, undefined, T('undo.edit'));
      else setAt(`${path}.flip`, v === 'true', T('undo.edit'));
    });
    flipSel.title = ta('encanim.flipHint');
    box.appendChild(fieldRow(ta('encanim.flip'), flipSel, { title: ta('encanim.flipHint') }));
    return box;
  };

  const actorBody = (doc, actorId, actor) => {
    const out = el('div', { class: 'enc-form' });
    const baseAnims = animsOf(actor);
    const formNames = formNamesOf(actor);
    // 目前編輯的動畫組（形態被刪掉時退回基礎）
    const editForm = state.editForm && formNames.includes(state.editForm) ? state.editForm : null;
    state.editForm = editForm;
    const directAnims = editForm ? animsOfGroup(actor, editForm) : baseAnims;
    // 形態：未定義的動畫沿用基礎（列表顯示繼承值；編輯後寫成覆蓋）
    const anims = editForm ? { ...baseAnims, ...directAnims } : baseAnims;
    const names = stateNames({ kind: actor.kind, anims });

    /* 位置 */
    const posPath = `actors.${quoteKey(actorId)}`;
    const posSec = section(T('ae.position'), null, { stateMap: state.sections, stateKey: 'ae:pos' });
    posSec.body.appendChild(fieldRow('X', numberAt(`${posPath}.x`, actor.x === undefined ? 0 : actor.x, { min: 0, max: VIEW_W })));
    posSec.body.appendChild(fieldRow('Y', numberAt(`${posPath}.y`, actor.y === undefined ? 0 : actor.y, { min: 0, max: VIEW_H })));
    posSec.body.appendChild(hintBox(T('ae.dragHint')));
    posSec.body.appendChild(
      button(T('ae.dragStart'), {
        small: true,
        onClick: () => startDragInPreview(actorId),
      }),
    );
    out.appendChild(posSec);

    /* 套用預設 */
    const presetSec = section(T('ae.applyPresets'), null, { stateMap: state.sections, stateKey: 'ae:presets' });
    const presets = presetsForKind(state.presets || [], actor.kind);
    if (!state.presets) {
      presetSec.body.appendChild(
        el('div', {
          class: 'pan-hint',
          text: state.presetsLoading ? T('ae.presetsLoading') : T('ae.presetsMissing'),
        }),
      );
      presetSec.body.appendChild(
        button(T('ae.applyPresets'), {
          small: true,
          disabled: true,
          title: T('ae.presetsMissing'),
          onClick: () => loadPresets(),
        }),
      );
    } else if (!presets.length) {
      presetSec.body.appendChild(el('div', { class: 'pan-hint', text: state.presetsError || T('ae.presetsNoActor') }));
      presetSec.body.appendChild(
        button(T('ae.applyPresets'), {
          small: true,
          disabled: true,
          title: T('ae.presetsNoActor'),
        }),
      );
    } else {
      const sel = selectEl(
        presets.map((p) => ({ value: p.id, label: presetLabel(p.id) })),
        presets[0] ? presets[0].id : '',
        () => {},
      );
      presetSec.body.appendChild(
        fieldRow(
          T('ae.presetsPick'),
          el('div', { class: 'enc-presetrow' }, [
            sel,
            button(T('ae.applyPresets'), {
              small: true,
              variant: 'primary',
              onClick: () => {
                const hit = presets.find((p) => p.id === sel.value);
                if (hit) applyPreset(actorId, hit);
              },
            }),
          ]),
        ),
      );
      presetSec.body.appendChild(el('div', { class: 'pan-hint', text: T('ae.presetsHint') }));
    }
    out.appendChild(presetSec);

    /* 形態（SPEC-P2 §1 forms） */
    const formsSec = section(T('ae.forms'), null, { stateMap: state.sections, stateKey: 'ae:forms' });
    formsSec.body.appendChild(hintBox(T('ae.formsHint')));
    const initialSel = selectEl(
      [{ value: '', label: T('ae.formNone') }].concat(formNames.map((n) => ({ value: n, label: n }))),
      actor.form && formNames.includes(actor.form) ? actor.form : '',
      (v) => setInitialForm(actorId, v),
    );
    initialSel.title = T('ae.formInitialHint');
    formsSec.body.appendChild(fieldRow(T('ae.formInitial'), initialSel, { title: T('ae.formInitialHint') }));
    if (!formNames.length) {
      formsSec.body.appendChild(el('div', { class: 'pan-hint', text: T('ae.formsEmpty') }));
    } else {
      const formList = el('div', { class: 'enc-formlist' });
      for (const name of formNames) {
        const row = el('div', { class: 'enc-formrow' + (editForm === name ? ' is-active' : '') });
        const label = button(name, {
          small: true,
          variant: editForm === name ? 'primary' : undefined,
          title: T('ae.formEditTip', { name }),
          onClick: () => setEditForm(actorId, name),
        });
        label.classList.add('enc-formname');
        row.appendChild(label);
        if ((actor.form || null) === name) row.appendChild(el('span', { class: 'enc-tag', text: T('ae.formInitialTag') }));
        const tools = el('div', { class: 'enc-formtools' });
        tools.appendChild(
          button('⚡', { small: true, title: T('ae.formPreview'), onClick: () => previewFormInStage(actorId, name) }),
        );
        tools.appendChild(
          button('⧉', { small: true, title: T('ae.duplicateForm'), onClick: () => duplicateForm(actorId, actor, name) }),
        );
        tools.appendChild(
          button('✎', {
            small: true,
            title: T('btn.rename'),
            onClick: () => {
              const next = askName(T('ae.formRenamePrompt'), name);
              if (next !== null) renameForm(actorId, actor, name, next);
            },
          }),
        );
        tools.appendChild(
          button('✕', {
            small: true,
            variant: 'danger',
            title: T('ae.deleteForm'),
            onClick: () => {
              if (typeof confirm === 'function' && !confirm(T('ae.confirmDeleteForm', { name }))) return;
              deleteForm(actorId, name);
            },
          }),
        );
        row.appendChild(tools);
        formList.appendChild(row);
      }
      formsSec.body.appendChild(formList);
    }
    formsSec.body.appendChild(button(T('ae.addForm'), { small: true, onClick: () => addForm(actorId, actor) }));
    out.appendChild(formsSec);

    /* 動畫狀態表 */
    const listSec = section(
      editForm ? T('ae.formAnims', { name: editForm }) : T('ae.title'),
      null,
      { stateMap: state.sections, stateKey: editForm ? `ae:states:${editForm}` : 'ae:states' },
    );
    // 動畫組切換（基礎 / 各形態）
    if (formNames.length) {
      const groupBar = el('div', { class: 'enc-formgroups' });
      const mkGroup = (label, value) =>
        button(label, {
          small: true,
          variant: (editForm || '') === (value || '') ? 'primary' : undefined,
          onClick: () => setEditForm(actorId, value),
        });
      groupBar.appendChild(mkGroup(T('ae.formBase'), null));
      for (const name of formNames) groupBar.appendChild(mkGroup(name, name));
      listSec.body.appendChild(groupBar);
    }
    if (editForm) {
      const formPath = `actors.${quoteKey(actorId)}.forms.${quoteKey(editForm)}`;
      const formsTable = formsOf(actor) || {};
      const formDef = formsTable[editForm] || {};
      listSec.body.appendChild(
        fieldRow(
          T('ae.formScale'),
          optionalNumberAt(`${formPath}.scale`, formDef.scale, {
            step: '0.05',
            min: 0.01,
            positive: 0.01,
            title: T('ae.formScaleHint'),
          }),
          { title: T('ae.formScaleHint') },
        ),
      );
      const offRow = el('div', { class: 'enc-formoffset' });
      offRow.appendChild(
        fieldRow(
          'offset.x',
          optionalNumberAt(`${formPath}.offset.x`, formDef.offset && formDef.offset.x, {
            integer: true,
            title: T('ae.formOffsetHint'),
          }),
        ),
      );
      offRow.appendChild(
        fieldRow(
          'offset.y',
          optionalNumberAt(`${formPath}.offset.y`, formDef.offset && formDef.offset.y, {
            integer: true,
            title: T('ae.formOffsetHint'),
          }),
        ),
      );
      listSec.body.appendChild(offRow);
      listSec.body.appendChild(hintBox(T('ae.formFallbackHint')));
    }
    if (!names.length) listSec.body.appendChild(el('div', { class: 'pan-empty-sub', text: T('ae.empty') }));
    for (const name of names) {
      listSec.body.appendChild(animRow(actorId, actor, name, anims[name], names, editForm));
    }
    listSec.body.appendChild(
      button(T('ae.addState'), {
        small: true,
        onClick: () => addState(actorId, doc.actors[actorId], editForm),
      }),
    );
    out.appendChild(listSec);
    return out;
  };

  const render = () => {
    if (state.destroyed) return;
    const scrollTop = host.scrollTop;
    stopTimer();
    state.renders = [];
    clear(host);

    const doc = docOf(store);
    const sel = readSelection(store);

    if (!doc) {
      host.appendChild(header(T('ae.title')));
      host.appendChild(emptyState(T('ae.title'), T('tip.noDoc')));
      return;
    }

    const target = actorTarget(doc, sel);
    if (!target.found) {
      host.appendChild(header(T('ae.title')));
      host.appendChild(emptyState(T('ae.missingActor'), T('ae.missingActorSub')));
      // 列出所有演員供快速跳轉
      const ids = Object.keys(doc.actors || {});
      if (ids.length) {
        const sec = section(T('tree.actors'), null, { stateMap: state.sections, stateKey: 'ae:all' });
        for (const id of ids) {
          sec.body.appendChild(
            button(id, {
              small: true,
              onClick: () => {
                try {
                  if (typeof store.setSelection === 'function') store.setSelection({ kind: KIND.actor, id, path: `actors.${quoteKey(id)}` });
                  else store.select(KIND.actor, id, `actors.${quoteKey(id)}`);
                } catch (err) {
                  console.warn('[actor-editor] 選取失敗：', err);
                }
              },
            }),
          );
        }
        host.appendChild(sec);
      }
      state.shape = shapeSig(doc, sel);
      host.scrollTop = scrollTop;
      return;
    }

    const title = T('insp.actor.title', { id: target.actorId });
    const names = stateNames(target.actor);
    host.appendChild(header(title, `${names.length} anims`));
    host.appendChild(actorBody(doc, target.actorId, target.actor));

    // 錯誤（整份演員子樹）
    const errs = store ? store.errors : null;
    const path = `actors.${quoteKey(target.actorId)}`;
    const list = errorsUnder(errs, path);
    if (list.length) {
      const sec = section(T('insp.errors.title', { n: list.length }), null, { stateMap: state.sections, stateKey: 'ae:errors', class: 'enc-errors' });
      for (const it of list.slice(0, 20)) sec.body.appendChild(el('div', { class: 'enc-errrow', text: T('insp.errRow', { key: it.key, msg: it.msg }) }));
      host.appendChild(sec);
    }

    state.shape = shapeSig(doc, sel);
    state.lastErrorsSig = errorsSig();
    host.scrollTop = scrollTop;
    startTimer();
    if (!state.presets && !state.presetsLoading) loadPresets();
  };

  const errorsUnder = (errors, path) => {
    const map = normalizeErrors(errors);
    const out = [];
    if (!path) return out;
    for (const [key, msg] of map) {
      if (key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[`)) out.push({ key, msg });
    }
    return out;
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

  const shapeSig = (doc, sel) => {
    const target = actorTarget(doc, sel);
    if (!target.found) return `none|${sel.kind || ''}|${sel.id || ''}`;
    const anims = animsOf(target.actor);
    const parts = Object.keys(anims).map((k) => `${k}:${anims[k].sprite || ''}:${anims[k].fps}:${anims[k].loop ? 1 : 0}:${anims[k].then || ''}`);
    // 形態也要進簽名，否則新增/改名/刪除形態時面板不會重建
    const forms = formsOf(target.actor) || {};
    const formParts = Object.entries(forms).map(([formName, formDef]) => {
      const fa = formDef && formDef.anims && typeof formDef.anims === 'object' ? formDef.anims : {};
      const faParts = Object.keys(fa).map((k) => `${k}:${(fa[k] && fa[k].sprite) || ''}:${(fa[k] && fa[k].fps) || ''}`);
      const scale = formDef && formDef.scale !== undefined ? formDef.scale : '';
      const off = formDef && formDef.offset ? `${formDef.offset.x},${formDef.offset.y}` : '';
      return `${formName}(${scale},${off}){${faParts.join('|')}}`;
    });
    return `${target.actorId}|form=${target.actor.form || ''}|${parts.join(',')}|forms=${formParts.join(';')}`;
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
      render();
    }
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
      stopTimer();
      if (typeof state.unsub === 'function') state.unsub();
      if (typeof state.unsubLocale === 'function') state.unsubLocale();
      clear(host);
      host.classList.remove('enc-actor-pane');
      instances.delete(rootEl);
    },
    refresh: () => render(),
    reloadPresets: () => {
      state.presets = null;
      state.presetsError = '';
      return loadPresets();
    },
  };
  instances.set(rootEl, controller);
  return controller;
}

/** 就地寫路徑（store 沒有 setAt 時的後備）。 */
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

export { writeAtPath as writeAnimPath };
export default { mount, animsOf, previewFrame };
