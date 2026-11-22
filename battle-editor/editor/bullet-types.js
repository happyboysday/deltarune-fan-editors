// editor/bullet-types.js  (ED3)
//
// 子彈類型管理：掛在 ED1 提供的 #bullet-types。
//   - 列出 attack.bulletTypes
//   - 新增 / 重新命名（同步更新 timeline 中引用該名稱的事件）/ 刪除（有引用時警告）
//   - 選中 → store.select('bulletType', name)，讓 inspector 編輯
//   - 面板內建 4 倍放大 sprite + hitbox 可視化預覽；可直接拖曳調整 circle 半徑或 rect 寬高
//
// 只 export mount(rootEl, ctx)；純邏輯函式另外 export 供 node 測試。

import {
  el,
  clear,
  button,
  section,
  emptyState,
  panelHeader,
  ensureStyles,
  numberField,
  checkboxEl,
  selectEl,
  getPath,
  setPath,
  findBulletTypeRefs,
  applyBulletTypeRename,
  canRenameBulletType,
  roundNice,
} from './fields.js';
import { t, registerStrings, onLocaleChange } from './i18n.js';
import PANELS from './locales/panels.js';

registerStrings('bulletTypes', PANELS.bulletTypes);

/** 本面板的取字串捷徑（動態解析，切換語系後會拿到新值）。 */
const T = (key, params) => t(`bulletTypes.${key}`, params);

/* =========================================================================
 * 1. 純邏輯（可測試）
 * ========================================================================= */

/** 取得 bulletTypes 物件（防禦性）。 */
export function bulletTypesOf(attack) {
  const bt = attack && attack.bulletTypes;
  return bt && typeof bt === 'object' && !Array.isArray(bt) ? bt : {};
}

/** 列出 [{ name, type, refs }]（依原順序）。 */
export function listBulletTypes(attack) {
  const types = bulletTypesOf(attack);
  return Object.keys(types).map((name) => ({
    name,
    type: types[name] && typeof types[name] === 'object' ? types[name] : {},
    refs: findBulletTypeRefs(attack, name).length,
  }));
}

/** 產生未被佔用的名稱：base、base2、base3… */
export function uniqueBulletTypeName(attack, base = 'bullet') {
  const types = bulletTypesOf(attack);
  if (!Object.prototype.hasOwnProperty.call(types, base)) return base;
  let i = 2;
  while (Object.prototype.hasOwnProperty.call(types, `${base}${i}`)) i += 1;
  return `${base}${i}`;
}

/** 新子彈類型的預設內容（SPEC §3）。 */
export function defaultBulletType(sprite = null) {
  return {
    sprite,
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
  };
}

/** hitbox 正規化：回傳 { shape:'circle', r } 或 { shape:'rect', w, h }。 */
export function normalizeHitboxValue(hb) {
  if (hb && typeof hb === 'object') {
    if (hb.shape === 'rect') {
      return { shape: 'rect', w: numOr(hb.w, 8), h: numOr(hb.h, 8) };
    }
    return { shape: 'circle', r: numOr(hb.r, 6) };
  }
  return { shape: 'circle', r: 6 };
}

function numOr(v, d) {
  if (v === null || v === undefined || v === '') return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

/** 圓形半徑：以拖曳點到中心的距離計算（世界像素）。 */
export function circleRadiusFromPoint(px, py) {
  return Math.max(0, roundNice(Math.hypot(px, py), 1));
}

/** 矩形尺寸：拖曳點到中心的距離 → 全寬 / 全高（世界像素）。 */
export function rectSizeFromPoint(px, py) {
  return { w: Math.max(0, roundNice(Math.abs(px) * 2, 1)), h: Math.max(0, roundNice(Math.abs(py) * 2, 1)) };
}

/** hitbox 摘要文字。 */
export function hitboxSummary(bt) {
  const hb = normalizeHitboxValue(bt && bt.hitbox);
  // 技術字串（rect/circle 是欄位識別字），不翻譯。
  return hb.shape === 'rect' ? `rect ${hb.w}×${hb.h}` : `circle r=${hb.r}`;
}

/** 列表列的副標題：sprite / hitbox / 傷害。 */
export function bulletTypeSubtitle(bt) {
  const b = bt && typeof bt === 'object' ? bt : {};
  const sprite = b.sprite ? String(b.sprite) : T('subtitle.noSprite');
  const dmg = b.damage === null || b.damage === undefined ? T('subtitle.defaultDamage') : T('subtitle.damage', { n: b.damage });
  return `${sprite} · ${hitboxSummary(b)} · ${dmg}`;
}

/**
 * 新增一個 bulletType 到 draft；回傳新名稱（就地修改）。
 * 若同名已存在則自動編號。
 */
export function addBulletType(draft, opts = {}) {
  if (!draft || typeof draft !== 'object') return null;
  if (!draft.bulletTypes || typeof draft.bulletTypes !== 'object' || Array.isArray(draft.bulletTypes)) draft.bulletTypes = {};
  const base = opts.name || 'bullet';
  const name = Object.prototype.hasOwnProperty.call(draft.bulletTypes, base) ? uniqueBulletTypeName(draft, base) : base;
  draft.bulletTypes[name] = defaultBulletType(opts.sprite || null);
  return name;
}

/**
 * 刪除 bulletType（就地修改）；回傳 { ok, refs, reason }。
 * 有引用時呼叫端應先警告使用者。
 */
export function removeBulletType(draft, name) {
  const types = bulletTypesOf(draft);
  if (!Object.prototype.hasOwnProperty.call(types, name)) return { ok: false, refs: 0, reason: T('err.notFound'), code: 'notFound' };
  const refs = findBulletTypeRefs(draft, name).length;
  delete draft.bulletTypes[name];
  return { ok: true, refs, reason: '', code: '' };
}

/** 重新命名（就地修改 draft）；見 fields.applyBulletTypeRename。 */
export function renameBulletType(draft, oldName, newName) {
  return applyBulletTypeRename(draft, oldName, newName);
}

/** 預覽縮放倍率選項。 */
export const PREVIEW_ZOOMS = [2, 4, 8];

/* =========================================================================
 * 2. DOM
 * ========================================================================= */

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

  const state = {
    destroyed: false,
    unsub: null,
    shape: '',
    zoom: 4,
    frame: 0,
    frameAcc: 0,
    raf: 0,
    lastTs: 0,
    renaming: null, // { name }
    drag: null,     // { name, kind }
    canvas: null,
    ctx2d: null,
    sections: {}, // 摺疊狀態：切換語系重繪時保留
    dpr: 1,
    size: 240,
  };

  rootEl.classList.add('pan-bt');
  rootEl.setAttribute('role', 'region');
  rootEl.setAttribute('aria-label', T('aria'));

  const attack = () => (store && store.attack) || null;
  const selection = () => (store && store.selection) || { kind: null, id: null };
  const types = () => bulletTypesOf(attack());
  const selectedName = () => {
    const sel = selection();
    return sel.kind === 'bulletType' ? sel.id : null;
  };

  /* ---------- 寫入 ---------- */

  const mutate = (fn, opts = {}) => {
    if (!store || typeof store.update !== 'function') return;
    store.update(fn, { label: opts.label || T('undo.edit'), coalesceKey: opts.coalesceKey });
  };

  const select = (name) => {
    if (!store || typeof store.select !== 'function') return;
    try { store.select('bulletType', name); } catch { /* ED1 若未實作 */ }
  };

  /* ---------- 骨架 ---------- */

  const header = panelHeader(T('title'), [
    button(T('btn.add'), { small: true, title: T('title.add'), onClick: () => doAdd() }),
  ]);
  const titleEl = header.querySelector('.pan-title');
  const addBtn = header.querySelector('button');
  const countBadge = el('span', { class: 'pan-badge' });
  header.appendChild(countBadge);
  rootEl.appendChild(header);

  const listEl = el('div', { class: 'pan-bt-list' });
  rootEl.appendChild(listEl);

  const previewHost = el('div', { class: 'pan-bt-preview-host' });
  rootEl.appendChild(previewHost);

  const footerHint = el('div', { class: 'pan-hint' });
  rootEl.appendChild(footerHint);

  /* ---------- 操作 ---------- */

  function doAdd() {
    const name = uniqueBulletTypeName(attack(), 'bullet');
    mutate((draft) => { addBulletType(draft, { name }); }, { label: T('undo.add') });
    select(name);
  }

  function doRename(oldName, newName) {
    const a = attack();
    const check = canRenameBulletType(a, oldName, newName);
    if (!check.ok) {
      if (check.code === 'unchanged') return; // 「名稱未改變」不算錯誤
      flash(check.reason);
      return;
    }
    let renamedRefs = 0;
    mutate((draft) => {
      const r = renameBulletType(draft, oldName, newName);
      if (r.ok) renamedRefs = r.renamedRefs;
    }, { label: T('undo.rename') });
    select(newName.trim());
    flash(T('toast.renamed', { name: newName.trim() }) + (renamedRefs ? T('toast.renamedRefs', { n: renamedRefs }) : ''));
  }

  function doDelete(name) {
    const refs = findBulletTypeRefs(attack(), name).length;
    const msg = refs > 0
      ? T('confirm.deleteRefs', { name, refs })
      : T('confirm.delete', { name });
    if (!confirm(msg)) return;
    mutate((draft) => { removeBulletType(draft, name); }, { label: T('undo.delete') });
    if (selectedName() === name && store && typeof store.select === 'function') {
      const rest = Object.keys(types());
      try {
        if (rest.length) store.select('bulletType', rest[0]);
        else store.select(null, null);
      } catch { /* ED1 若未實作 select */ }
    }
    flash(T('toast.deleted', { name }));
  }

  let toastEl = null;
  let toastTimer = null;
  const flash = (msg) => {
    if (!toastEl) {
      toastEl = el('div', { class: 'pan-toast' });
      rootEl.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { if (toastEl) toastEl.classList.remove('show'); }, 2000);
  };

  /* ---------- 清單渲染 ---------- */

  const renderList = () => {
    clear(listEl);
    const a = attack();
    if (!a) {
      listEl.appendChild(emptyState(T('empty.noAttack'), T('empty.noAttackSub')));
      return;
    }
    const items = listBulletTypes(a);
    countBadge.textContent = String(items.length);
    if (items.length === 0) {
      listEl.appendChild(emptyState(T('empty.none'), T('empty.noneSub')));
      return;
    }
    const sel = selectedName();
    for (const item of items) {
      const row = el('div', { class: `pan-bt-item${sel === item.name ? ' selected' : ''}` });
      row.dataset.name = item.name;

      // 名稱列
      const nameRow = el('div', { class: 'pan-bt-namerow' });
      if (state.renaming && state.renaming.name === item.name) {
        const inp = el('input', { type: 'text', class: 'pan-input pan-input-small pan-bt-rename', value: item.name });
        inp.value = item.name;
        const commit = () => {
          const v = inp.value.trim();
          state.renaming = null;
          if (v && v !== item.name) doRename(item.name, v);
          else renderList();
        };
        inp.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          if (e.key === 'Escape') { state.renaming = null; renderList(); }
        });
        inp.addEventListener('blur', () => { if (state.renaming) commit(); });
        nameRow.appendChild(inp);
        row.appendChild(nameRow);
        listEl.appendChild(row);
        setTimeout(() => { inp.focus(); inp.select(); }, 0);
        continue;
      }

      const nameBtn = el('button', { type: 'button', class: 'pan-bt-name', text: item.name, title: T('nameTitle') });
      nameBtn.addEventListener('click', () => select(item.name));
      nameRow.appendChild(nameBtn);
      if (item.refs > 0) nameRow.appendChild(el('span', { class: 'pan-bt-refs', text: T('refs', { n: item.refs }), title: T('title.refs') }));
      const ren = button(T('btn.rename'), { small: true, title: T('title.rename'), onClick: (e) => { e.stopPropagation(); state.renaming = { name: item.name }; renderList(); } });
      const del = button(T('btn.delete'), { small: true, variant: 'danger', title: T('title.delete'), onClick: (e) => { e.stopPropagation(); doDelete(item.name); } });
      nameRow.appendChild(ren);
      nameRow.appendChild(del);
      row.appendChild(nameRow);

      // 副標題
      row.appendChild(el('div', { class: 'pan-bt-sub', text: bulletTypeSubtitle(item.type) }));
      nameRow.addEventListener('click', (e) => {
        if (e.target === nameRow) select(item.name);
      });
      listEl.appendChild(row);
    }
  };

  /* ---------- 預覽 ---------- */

  const renderPreview = () => {
    clear(previewHost);
    const a = attack();
    const name = selectedName();
    const bt = name ? types()[name] : null;
    if (!a || !name || !bt) {
      state.canvas = null;
      state.ctx2d = null;
      previewHost.appendChild(emptyState(T('empty.noSelection'), T('empty.noSelectionSub')));
      return;
    }
    const box = section(T('section.preview'), null, { stateMap: state.sections, stateKey: 'bulletTypePreview' });
    const body = box.body;

    // 工具列
    const bar = el('div', { class: 'pan-bt-previewbar' });
    for (const z of PREVIEW_ZOOMS) {
      const b = button(`×${z}`, { small: true, class: state.zoom === z ? 'active' : '', title: T('title.zoom', { z }) });
      b.addEventListener('click', () => { state.zoom = z; renderPreview(); });
      bar.appendChild(b);
    }
    const frameInfo = el('span', { class: 'pan-bt-frameinfo pan-mono' });
    bar.appendChild(frameInfo);
    body.appendChild(bar);

    // canvas
    const canvas = el('canvas', { class: 'pan-bt-canvas', width: state.size, height: state.size });
    canvas.style.width = `${state.size}px`;
    canvas.style.height = `${state.size}px`;
    body.appendChild(canvas);

    // 拖曳提示
    const hb = normalizeHitboxValue(bt.hitbox);
    const hbInfo = el('div', { class: 'pan-bt-hbinfo pan-mono', text: T('hbInfo', { summary: hitboxSummary(bt) }) });
    body.appendChild(hbInfo);

    // 快速數值（與 inspector 同步）
    const quick = el('div', { class: 'pan-grid pan-grid-tight' });
    const frameRateCtl = numberField({
      value: bt.frameRate ?? 0,
      spec: { key: 'frameRate', get label() { return T('label.frameRate'); }, def: 0, step: 1, drag: 0.25, min: 0, max: 60, unit: 'fps' },
      coalesceKey: `bt:${name}:frameRate`,
      onChange: (v) => mutate((draft) => { setPath(draft, `bulletTypes.${name}.frameRate`, v); }, { label: T('undo.frameRate'), coalesceKey: `bt:${name}:frameRate` }),
    });
    quick.appendChild(el('div', { class: 'pan-row' }, [el('div', { class: 'pan-row-control', style: { flex: '1' } }, frameRateCtl.el)]));
    const shapeCtl = selectEl([{ value: 'circle', label: T('opt.circle') }, { value: 'rect', label: T('opt.rect') }], hb.shape, (v) => {
      mutate((draft) => {
        const cur = getPath(draft, `bulletTypes.${name}.hitbox`);
        const next = { shape: v };
        if (v === 'circle') next.r = cur && typeof cur.r === 'number' ? cur.r : 6;
        else { next.w = cur && typeof cur.w === 'number' ? cur.w : 8; next.h = cur && typeof cur.h === 'number' ? cur.h : 8; }
        setPath(draft, `bulletTypes.${name}.hitbox`, next);
      }, { label: T('undo.hitboxShape') });
    }, {});
    quick.appendChild(el('div', { class: 'pan-row' }, [el('div', { class: 'pan-row-control', style: { flex: '1' } }, shapeCtl)]));
    body.appendChild(quick);

    // 顯示選項
    const opts = el('div', { class: 'pan-bt-previewopts' });
    const showSprite = checkboxEl(true, () => { drawPreview(); }, T('opt.showSprite'));
    const showCenter = checkboxEl(true, () => { drawPreview(); }, T('opt.showCenter'));
    const useOrigin = checkboxEl(false, () => { drawPreview(); }, T('opt.useOrigin'));
    opts.appendChild(showSprite);
    opts.appendChild(showCenter);
    opts.appendChild(useOrigin);
    body.appendChild(opts);

    previewHost.appendChild(box);

    // 初始化 2D context
    state.canvas = canvas;
    state.ctx2d = canvas.getContext('2d');
    state.dpr = Math.min(2, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    canvas.width = Math.round(state.size * state.dpr);
    canvas.height = Math.round(state.size * state.dpr);
    canvas.style.width = `${state.size}px`;
    canvas.style.height = `${state.size}px`;
    state.previewFlags = { showSprite: true, showCenter: true, useOrigin: false };
    showSprite.input.addEventListener('change', () => { state.previewFlags.showSprite = showSprite.input.checked; drawPreview(); });
    showCenter.input.addEventListener('change', () => { state.previewFlags.showCenter = showCenter.input.checked; drawPreview(); });
    useOrigin.input.addEventListener('change', () => { state.previewFlags.useOrigin = useOrigin.input.checked; drawPreview(); });
    void frameInfo;
    void frameRateCtl;

    // 拖曳：左鍵按住 = 調整 hitbox
    const toWorld = (ev) => {
      const rect = canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      return { x: (ev.clientX - cx) / state.zoom, y: (ev.clientY - cy) / state.zoom };
    };
    const applyDrag = (ev) => {
      const p = toWorld(ev);
      const hb2 = normalizeHitboxValue(types()[name]?.hitbox);
      if (hb2.shape === 'circle') {
        const r = circleRadiusFromPoint(p.x, p.y);
        mutate((draft) => { setPath(draft, `bulletTypes.${name}.hitbox`, { shape: 'circle', r }); },
          { label: T('undo.hitboxRadius'), coalesceKey: `bt:${name}:hitbox` });
      } else {
        const s = rectSizeFromPoint(p.x, p.y);
        mutate((draft) => { setPath(draft, `bulletTypes.${name}.hitbox`, { shape: 'rect', w: s.w, h: s.h }); },
          { label: T('undo.hitboxSize'), coalesceKey: `bt:${name}:hitbox` });
      }
      drawPreview();
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      state.drag = { name };
      try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 合成事件無真實指標 */ }
      canvas.classList.add('dragging');
      applyDrag(e);
      e.preventDefault();
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!state.drag || state.drag.name !== name) return;
      applyDrag(e);
      e.preventDefault();
    });
    const endDrag = () => { state.drag = null; canvas.classList.remove('dragging'); };
    canvas.addEventListener('pointerup', endDrag);
    canvas.addEventListener('pointercancel', endDrag);

    drawPreview();
    frameInfo.textContent = '';
    // 動畫
    if ((bt.frameRate || 0) > 0) startAnim();
    else stopAnim();
  };

  /* ---------- 繪製 ---------- */

  const drawPreview = () => {
    const canvas = state.canvas;
    const c = state.ctx2d;
    if (!canvas || !c) return;
    const a = attack();
    const name = selectedName();
    const bt = name && a ? types()[name] : null;
    if (!bt) return;
    const { size, dpr, zoom } = state;
    const flags = state.previewFlags || { showSprite: true, showCenter: true, useOrigin: false };

    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.imageSmoothingEnabled = false;
    // 背景棋盤
    c.fillStyle = '#101018';
    c.fillRect(0, 0, size, size);
    const cell = 8 * Math.max(1, Math.round(zoom / 2));
    for (let y = 0; y < size; y += cell) {
      for (let x = 0; x < size; x += cell) {
        if (((x / cell) + (y / cell)) % 2 === 0) {
          c.fillStyle = '#16161f';
          c.fillRect(x, y, cell, cell);
        }
      }
    }
    const cx = size / 2;
    const cy = size / 2;

    // sprite
    const meta = (assets && typeof assets.sprite === 'function') ? assets.sprite(bt.sprite) : null;
    let frameCount = 1;
    if (meta && Array.isArray(meta.frames) && meta.frames.length > 0) frameCount = meta.frames.length;
    const frame = frameCount > 1 ? state.frame % frameCount : 0;
    if (flags.showSprite && bt.sprite) {
      const img = assets && typeof assets.getImage === 'function' ? assets.getImage(bt.sprite, frame) : null;
      if (img) {
        const w = (meta && meta.w) || img.naturalWidth || img.width || 16;
        const h = (meta && meta.h) || img.naturalHeight || img.height || 16;
        const sw = w * zoom;
        const sh = h * zoom;
        let dx = cx - sw / 2;
        let dy = cy - sh / 2;
        if (flags.useOrigin && meta) {
          dx = cx - (Number(meta.ox) || 0) * zoom;
          dy = cy - (Number(meta.oy) || 0) * zoom;
        }
        try { c.drawImage(img, dx, dy, sw, sh); } catch { /* 圖未載入 */ }
        // 外框
        c.strokeStyle = 'rgba(120,160,255,0.25)';
        c.lineWidth = 1;
        c.strokeRect(Math.round(dx) + 0.5, Math.round(dy) + 0.5, Math.round(sw) - 1, Math.round(sh) - 1);
      }
    } else if (flags.showSprite && !bt.sprite) {
      c.fillStyle = 'rgba(255,0,255,0.35)';
      c.fillRect(cx - 8 * zoom / 2, cy - 8 * zoom / 2, 8 * zoom, 8 * zoom);
    }

    // hitbox
    const hb = normalizeHitboxValue(bt.hitbox);
    c.save();
    c.strokeStyle = '#00e0a0';
    c.fillStyle = 'rgba(0,224,160,0.12)';
    c.lineWidth = 2;
    if (hb.shape === 'circle') {
      const r = hb.r * zoom;
      c.beginPath();
      c.arc(cx, cy, r, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      // 半徑線
      c.strokeStyle = 'rgba(0,224,160,0.5)';
      c.beginPath();
      c.moveTo(cx, cy);
      c.lineTo(cx + r, cy);
      c.stroke();
      // 文字
      c.fillStyle = '#9ff5d8';
      c.font = '12px "Courier New", monospace';
      c.fillText(`r=${hb.r}`, cx + 6, cy - 6);
    } else {
      const w = hb.w * zoom;
      const h = hb.h * zoom;
      c.fillRect(cx - w / 2, cy - h / 2, w, h);
      c.strokeRect(cx - w / 2, cy - h / 2, w, h);
      c.fillStyle = '#9ff5d8';
      c.font = '12px "Courier New", monospace';
      c.fillText(`${hb.w}×${hb.h}`, cx + 6, cy - 6);
    }
    c.restore();

    // 中心十字
    if (flags.showCenter) {
      c.strokeStyle = 'rgba(255,80,80,0.9)';
      c.lineWidth = 1;
      c.beginPath();
      c.moveTo(cx - 8, cy);
      c.lineTo(cx + 8, cy);
      c.moveTo(cx, cy - 8);
      c.lineTo(cx, cy + 8);
      c.stroke();
    }

    // 尺寸標示
    c.fillStyle = 'rgba(200,200,220,0.65)';
    c.font = '11px "Courier New", monospace';
    c.fillText(`${bt.sprite || T('draw.noSprite')}`, 6, size - 18);
    c.fillText(T('draw.frame', { i: frame + 1, n: frameCount }), 6, size - 6);
  };

  const startAnim = () => {
    if (state.raf) return;
    state.lastTs = 0;
    state.frameAcc = 0;
    const tick = (ts) => {
      if (state.destroyed) { state.raf = 0; return; }
      const a = attack();
      const name = selectedName();
      const bt = name && a ? types()[name] : null;
      if (!bt || !state.canvas || !(bt.frameRate > 0)) { state.raf = 0; return; }
      const dt = state.lastTs ? (ts - state.lastTs) / 1000 : 0;
      state.lastTs = ts;
      state.frameAcc += dt;
      const fr = Math.max(0.0001, bt.frameRate);
      if (state.frameAcc >= 1 / fr) {
        const steps = Math.floor(state.frameAcc * fr);
        state.frameAcc -= steps / fr;
        state.frame += steps;
        drawPreview();
        // 更新外部幀標示
        const fi = rootEl.querySelector('.pan-bt-frameinfo');
        const meta = (assets && typeof assets.sprite === 'function') ? assets.sprite(bt.sprite) : null;
        const n = meta && Array.isArray(meta.frames) && meta.frames.length ? meta.frames.length : 1;
        if (fi) fi.textContent = T('frameInfo', { i: ((state.frame % n) + 1), n, fps: bt.frameRate });
      }
      state.raf = requestAnimationFrame(tick);
    };
    state.raf = requestAnimationFrame(tick);
  };

  const stopAnim = () => {
    if (state.raf) cancelAnimationFrame(state.raf);
    state.raf = 0;
    state.lastTs = 0;
    state.frame = 0;
  };

  /* ---------- 主渲染 ---------- */

  const shapeKey = () => {
    const a = attack();
    if (!a) return 'no-attack';
    const sel = selectedName();
    return `${JSON.stringify(Object.keys(types()))}|${sel || ''}|${state.renaming ? state.renaming.name : ''}|${state.zoom}`;
  };

  const render = () => {
    if (state.destroyed) return;
    stopAnim();
    const scrollTop = rootEl.scrollTop;
    renderList();
    renderPreview();
    footerHint.textContent = T('footerHint');
    rootEl.scrollTop = scrollTop;
    state.shape = shapeKey();
  };

  let rafPending = false;
  let pendingRender = false;
  const scheduleRender = (full = false) => {
    if (full) pendingRender = true;
    if (state.destroyed || rafPending) return;
    rafPending = true;
    const run = () => {
      rafPending = false;
      if (state.destroyed) return;
      if (pendingRender || shapeKey() !== state.shape) {
        pendingRender = false;
        render();
      } else {
        // 數值變更：只重畫預覽
        stopAnim();
        drawPreview();
        if (selectedName() && (types()[selectedName()]?.frameRate || 0) > 0) startAnim();
      }
    };
    if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(run);
    else setTimeout(run, 0);
  };

  /* ---------- 生命週期 ---------- */

  render();

  /* ---------- 語系切換：整份重繪，保留選取 / 捲動 / 摺疊狀態 ---------- */

  const relabel = () => {
    if (state.destroyed) return;
    rootEl.setAttribute('aria-label', T('aria'));
    if (titleEl) titleEl.textContent = T('title');
    if (addBtn) { addBtn.textContent = T('btn.add'); addBtn.title = T('title.add'); }
    // 重新命名輸入框中的文字是使用者資料，保留 state.renaming 與輸入內容
    render();
  };

  const unsubLocale = onLocaleChange(() => { if (!state.destroyed) relabel(); });

  if (store && typeof store.subscribe === 'function') {
    state.unsub = store.subscribe(() => {
      if (state.destroyed) return;
      // 結構變更（選取切換、清單變動、改名狀態）→ 同步重繪；
      // 純數值變更 → 走 rAF 合併，只重畫預覽以省成本。
      if (shapeKey() !== state.shape) { render(); return; }
      scheduleRender(false);
    });
  }

  const controller = {
    destroy() {
      state.destroyed = true;
      stopAnim();
      if (typeof state.unsub === 'function') state.unsub();
      if (typeof unsubLocale === 'function') unsubLocale();
      if (toastTimer) clearTimeout(toastTimer);
      clear(rootEl);
      rootEl.classList.remove('pan-bt');
      instances.delete(rootEl);
    },
    refresh: () => scheduleRender(true),
    /** 測試用。 */
    getNameList: () => Object.keys(types()),
  };
  instances.set(rootEl, controller);
  return controller;
}
