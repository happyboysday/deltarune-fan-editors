// editor/assets-panel.js  (ED3)
//
// 素材瀏覽器：掛在 ED1 提供的 #assets-browser。
//   - 讀 ctx.assets.index.sprites（SPEC §2）
//   - tag 篩選按鈕、名稱搜尋
//   - 虛擬捲動縮圖網格（上千張也順）
//   - 點選顯示尺寸 / 原點 / 幀數（含逐幀預覽）
//   - 拖曳 tile 到檢查器的 sprite 欄位（dataTransfer text/plain = sprite 名）
//   - ctx.assets 為 null 時顯示說明
//
// 只 export mount(rootEl, ctx)；純邏輯函式也 export 供 node 測試。

import {
  el,
  clear,
  button,
  section,
  emptyState,
  panelHeader,
  ensureStyles,
  spriteNamesOf,
  dragState,
} from './fields.js';
import { t, registerStrings, onLocaleChange } from './i18n.js';
import PANELS from './locales/panels.js';

registerStrings('assets', PANELS.assets);

/** 本面板的取字串捷徑（動態解析，切換語系後會拿到新值）。 */
const T = (key, params) => t(`assets.${key}`, params);

/* =========================================================================
 * 純邏輯（可測試）
 * ========================================================================= */

/** SPEC §2 定義的 tag 集合（用於排序顯示）。 */
export const KNOWN_TAGS = ['soul', 'bullet', 'battlebg', 'enemy', 'ui', 'party'];

/** 已知 tag 的顯示字串鍵（未知 tag 直接顯示原字串；tag 本身不翻譯）。 */
export const TAG_LABEL_KEYS = {
  soul: 'tag.soul',
  bullet: 'tag.bullet',
  battlebg: 'tag.battlebg',
  enemy: 'tag.enemy',
  ui: 'tag.ui',
  party: 'tag.party',
};

/** tag → 顯示文字（tag 名本身不翻譯，只加中文說明）。 */
export function tagLabel(tag) {
  switch (tag) {
    case 'soul': return T('tag.soul');
    case 'bullet': return T('tag.bullet');
    case 'battlebg': return T('tag.battlebg');
    case 'enemy': return T('tag.enemy');
    case 'ui': return T('tag.ui');
    case 'party': return T('tag.party');
    default: return String(tag);
  }
}

/** 把 index.sprites 正規化成陣列（含衍生欄位）。 */
export function normalizeSpriteEntries(sprites) {
  if (!sprites || typeof sprites !== 'object') return [];
  const out = [];
  for (const name of Object.keys(sprites)) {
    const meta = sprites[name];
    if (!meta || typeof meta !== 'object') {
      out.push({ name, meta: {}, frames: [], count: 0, w: 0, h: 0, ox: 0, oy: 0, tags: [], chapter: null, custom: false });
      continue;
    }
    const frames = Array.isArray(meta.frames) ? meta.frames : [];
    const count = frames.length || (meta.w ? 1 : 0);
    out.push({
      name,
      meta,
      frames,
      count,
      w: Number(meta.w) || 0,
      h: Number(meta.h) || 0,
      ox: Number(meta.ox) || 0,
      oy: Number(meta.oy) || 0,
      tags: Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string') : [],
      chapter: typeof meta.chapter === 'string' ? meta.chapter : null,
      // §4-13「自訂」篩選：外部使用者放進 assets/ 的素材會標 custom: true
      custom: meta.custom === true,
    });
  }
  return out;
}

/** 收集所有 tag 及數量（依 KNOWN_TAGS 排序，其餘字母序）。 */
export function collectTags(entries) {
  const counts = new Map();
  for (const e of entries) {
    for (const t of e.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const known = KNOWN_TAGS.filter((t) => counts.has(t));
  const other = Array.from(counts.keys()).filter((t) => !KNOWN_TAGS.includes(t)).sort();
  return [...known, ...other].map((tag) => ({ tag, count: counts.get(tag) }));
}

/**
 * 篩選：query 為名稱子字串（不分大小寫）；tagMode 'any' = 任一 tag；'all' = 全部 tag。
 * §4-13：`custom: true` 只留 `meta.custom === true` 的素材（其餘值 = 不篩）。
 */
export function filterSprites(entries, opts = {}) {
  const query = (opts.query || '').trim().toLowerCase();
  const tags = Array.isArray(opts.tags) ? opts.tags : [];
  const mode = opts.tagMode === 'all' ? 'all' : 'any';
  const customOnly = opts.custom === true;
  return entries.filter((e) => {
    if (query && !e.name.toLowerCase().includes(query)) return false;
    if (customOnly && e.custom !== true) return false;
    if (tags.length === 0) return true;
    if (mode === 'all') return tags.every((t) => e.tags.includes(t));
    return tags.some((t) => e.tags.includes(t));
  });
}

/** §4-13：`custom: true` 的素材數量（給「自訂」chip 顯示，0 也照樣回 0）。 */
export function countCustomSprites(entries) {
  let n = 0;
  for (const e of Array.isArray(entries) ? entries : []) if (e && e.custom === true) n += 1;
  return n;
}

/** 依容器寬度算欄數與每格邊長。 */
export function gridMetrics(containerWidth, opts = {}) {
  const tile = opts.tile || 64;
  const gap = opts.gap === undefined ? 6 : opts.gap;
  const pad = opts.pad === undefined ? 8 : opts.pad;
  const usable = Math.max(0, containerWidth - pad * 2);
  const cols = Math.max(1, Math.floor((usable + gap) / (tile + gap)));
  return { cols, tile, gap, pad, cellW: tile + gap, cellH: tile + gap + 14 };
}

/**
 * 虛擬捲動可見列範圍。
 * 回傳 { startRow, endRow, startIndex, endIndex, offsetY }
 */
export function virtualRange(scrollTop, viewportHeight, rowHeight, rowCount, overscan = 2) {
  const h = Math.max(1, rowHeight);
  const vh = Math.max(0, viewportHeight);
  const first = Math.floor(Math.max(0, scrollTop) / h);
  const visible = Math.ceil(vh / h) + 1;
  const startRow = Math.max(0, first - overscan);
  const endRow = Math.min(Math.max(0, rowCount), first + visible + overscan);
  return {
    startRow,
    endRow,
    startIndex: startRow, // 以「列」為單位時另乘 cols
    endIndex: endRow,
    offsetY: startRow * h,
  };
}

/** 由列範圍換算 item 索引範圍。 */
export function itemRange(startRow, endRow, cols, total) {
  const from = Math.max(0, startRow * cols);
  const to = Math.min(total, endRow * cols);
  return { from, to };
}

/**
 * 詳細資料的文字行（供 UI 與測試）。
 * 回傳 [{ key, label, value }]；label 依語系翻譯，key 穩定供程式與測試比對。
 */
export function spriteInfoLines(entry) {
  if (!entry) return [];
  const lines = [];
  lines.push({ key: 'name', label: T('info.name'), value: entry.name });
  lines.push({ key: 'size', label: T('info.size'), value: entry.w && entry.h ? `${entry.w} × ${entry.h}` : T('info.sizeUnknown') });
  lines.push({ key: 'origin', label: T('info.origin'), value: `(${entry.ox}, ${entry.oy})` });
  lines.push({ key: 'frames', label: T('info.frames'), value: String(entry.count || 1) });
  if (entry.chapter) lines.push({ key: 'chapter', label: T('info.chapter'), value: entry.chapter });
  lines.push({ key: 'tags', label: T('info.tags'), value: entry.tags.length ? entry.tags.join(T('listSeparator')) : T('info.noTags') });
  return lines;
}

/* =========================================================================
 * DOM
 * ========================================================================= */

const instances = new WeakMap();

/** 縮圖 <img> 快取（key = 絕對 URL）：避免每次重繪都重建 Image 物件。 */
const thumbCache = new Map();

/**
 * mount(rootEl, ctx)
 * ctx = { store, assets, preview }（SPEC §10）
 * 回傳 { destroy(), select(name), getSelected() }
 */
export function mount(rootEl, ctx = {}) {
  if (!rootEl) return { destroy() {} };
  ensureStyles();
  const prev = instances.get(rootEl);
  if (prev) prev.destroy();

  const store = ctx.store || null;
  const assets = ctx.assets || null;
  const sprites = assets && assets.index ? assets.index.sprites : null;
  const hasAssets = !!sprites && typeof sprites === 'object';

  const state = {
    destroyed: false,
    all: hasAssets ? normalizeSpriteEntries(sprites) : [],
    filtered: [],
    tags: new Set(),
    tagMode: 'any',
    customOnly: false, // §4-13：「自訂」篩選 chip 是否開啟
    query: '',
    selected: null,
    scrollTop: 0,
    rafPending: false,
    linkEl: null,
    colWidth: 0,
    cols: 4,
    pool: [],
  };

  rootEl.classList.add('pan-assets');
  rootEl.setAttribute('role', 'region');
  rootEl.setAttribute('aria-label', T('aria'));

  /* ---------- 骨架 ---------- */

  const header = panelHeader(T('title'), null);
  const titleEl = header.querySelector('.pan-title');
  const countBadge = el('span', { class: 'pan-badge', text: '' });
  header.appendChild(countBadge);
  rootEl.appendChild(header);

  if (!hasAssets) {
    /** 無素材時的說明區塊（可重繪，供切換語系用）。 */
    const paintNoAssets = () => {
      clear(rootEl);
      rootEl.setAttribute('aria-label', T('aria'));
      rootEl.appendChild(header);
      rootEl.appendChild(emptyState(T('empty.title'), T('empty.sub')));
      const tip = el('div', { class: 'pan-hint' });
      tip.appendChild(el('div', { text: T('hint.indexFormat') }));
      tip.appendChild(el('pre', {
        class: 'pan-json',
        text: '{\n  "format": "dr-battle-assets/1",\n  "sprites": {\n    "spr_heart": { "frames": ["sprites/spr_heart/0.png"], "w": 16, "h": 16, "ox": 0, "oy": 0, "tags": ["soul"] }\n  }\n}',
      }));
      rootEl.appendChild(tip);
    };
    paintNoAssets();
    const unsubLocaleEmpty = onLocaleChange(() => {
      if (state.destroyed) return;
      titleEl.textContent = T('title');
      paintNoAssets();
    });
    const ctl = {
      destroy() {
        state.destroyed = true;
        if (typeof unsubLocaleEmpty === 'function') unsubLocaleEmpty();
        clear(rootEl);
        rootEl.classList.remove('pan-assets');
        instances.delete(rootEl);
      },
      select() {},
      getSelected: () => null,
    };
    instances.set(rootEl, ctl);
    return ctl;
  }

  /* ---------- 工具列 ---------- */

  const toolbar = el('div', { class: 'pan-assets-toolbar' });
  const search = el('input', {
    type: 'search',
    class: 'pan-input pan-input-search',
    placeholder: T('placeholder.search'),
    spellcheck: 'false',
    autocomplete: 'off',
  });
  search.addEventListener('input', () => { state.query = search.value; applyFilter(); });
  toolbar.appendChild(search);

  const modeBtn = button(state.tagMode === 'any' ? T('btn.modeAny') : T('btn.modeAll'), { small: true, title: T('title.modeToggle'), onClick: () => {
    state.tagMode = state.tagMode === 'any' ? 'all' : 'any';
    modeBtn.textContent = state.tagMode === 'any' ? T('btn.modeAny') : T('btn.modeAll');
    applyFilter();
  } });
  toolbar.appendChild(modeBtn);

  const tagBar = el('div', { class: 'pan-tagbar' });
  toolbar.appendChild(tagBar);

  const clearTags = button(T('btn.clearFilters'), { small: true, onClick: () => {
    state.tags.clear();
    state.query = '';
    search.value = '';
    applyFilter();
  } });
  toolbar.appendChild(clearTags);
  rootEl.appendChild(toolbar);

  /* ---------- 主區（網格 + 詳細） ---------- */

  const main = el('div', { class: 'pan-assets-main' });
  const scroller = el('div', { class: 'pan-assets-scroll' });
  scroller.tabIndex = 0;
  const spacer = el('div', { class: 'pan-assets-spacer' });
  const grid = el('div', { class: 'pan-assets-grid' });
  spacer.appendChild(grid);
  scroller.appendChild(spacer);
  main.appendChild(scroller);

  const detail = el('div', { class: 'pan-assets-detail' });
  main.appendChild(detail);
  rootEl.appendChild(main);

  /* ---------- tag 按鈕列 ---------- */

  const buildTagBar = () => {
    clear(tagBar);
    const tags = collectTags(state.all);
    const allBtn = el('button', {
      type: 'button',
      class: `pan-tag${state.tags.size === 0 ? ' active' : ''}`,
      text: T('tag.all', { count: state.all.length }),
    });
    allBtn.addEventListener('click', () => {
      state.tags.clear();
      state.customOnly = false;
      applyFilter();
    });
    tagBar.appendChild(allBtn);

    // §4-13：「自訂」chip —— 數量 0 也要顯示、也要能點（點起來看到空清單是預期行為）
    const customCount = countCustomSprites(state.all);
    const customBtn = el('button', {
      type: 'button',
      class: `pan-tag pan-tag-custom${state.customOnly ? ' active' : ''}`,
      text: `${T('tag.custom')} ${customCount}`,
      title: T('tag.customTitle', { count: customCount }),
    });
    customBtn.addEventListener('click', () => {
      state.customOnly = !state.customOnly;
      applyFilter();
    });
    tagBar.appendChild(customBtn);
    for (const { tag, count } of tags) {
      const b = el('button', {
        type: 'button',
        class: `pan-tag${state.tags.has(tag) ? ' active' : ''}`,
        text: `${tagLabel(tag)} ${count}`,
      });
      b.addEventListener('click', () => {
        if (state.tags.has(tag)) state.tags.delete(tag);
        else state.tags.add(tag);
        applyFilter();
      });
      tagBar.appendChild(b);
    }
  };

  /* ---------- 縮圖來源 ---------- */

  /**
   * 取得 sprite 某幀可用的圖片元素。
   * engine 的 getImage() 在圖片尚未載入完成時會回 null，因此這裡另外準備
   * resolveUrl + Image 的後備路徑，讓瀏覽器自己快取，縮圖才不會整片空白。
   */
  const thumbEl = (name, frame = 0) => {
    try {
      const img = assets && typeof assets.getImage === 'function' ? assets.getImage(name, frame) : null;
      if (img && typeof img.src === 'string' && img.src) return img;
    } catch { /* 忽略 */ }
    // 後備：自行組 URL（assets.resolveUrl / index.frames 相對路徑）
    const url = frameUrl(name, frame);
    if (!url) return null;
    let el2 = thumbCache.get(url);
    if (!el2) {
      el2 = new Image();
      el2.decoding = 'async';
      el2.src = url;
      thumbCache.set(url, el2);
      if (thumbCache.size > 600) {
        const firstKey = thumbCache.keys().next().value;
        if (firstKey) thumbCache.delete(firstKey);
      }
    }
    return el2;
  };

  /** 取得 sprite 第 N 幀圖片的 src；沒有則 null。 */
  const thumbSrc = (name, frame = 0) => {
    const img = thumbEl(name, frame);
    return img && typeof img.src === 'string' && img.src ? img.src : null;
  };

  /** 把 index 中的相對路徑解析成絕對 URL（同 engine/assets.js 的做法）。 */
  const frameUrl = (name, frame = 0) => {
    const meta = spriteMeta(name);
    if (!meta) return null;
    const frames = Array.isArray(meta.frames) ? meta.frames : [];
    if (frames.length === 0) return null;
    const raw = frames[((frame % frames.length) + frames.length) % frames.length];
    if (typeof raw !== 'string' || !raw) return null;
    const resolved = resolveFramePath(raw);
    return resolved;
  };

  const spriteMeta = (name) => {
    if (!sprites) return null;
    return Object.prototype.hasOwnProperty.call(sprites, name) ? sprites[name] : null;
  };

  const resolveFramePath = (raw) => {
    if (/^(data:|blob:|https?:|\/)/i.test(raw)) return raw;
    try {
      if (assets && typeof assets.resolveUrl === 'function') {
        const u = assets.resolveUrl(raw);
        if (u) return u;
      }
    } catch { /* 忽略 */ }
    try {
      if (typeof assets.indexUrl === 'string' && assets.indexUrl) {
        return new URL(raw, new URL(assets.indexUrl, document.baseURI)).href;
      }
    } catch { /* 忽略 */ }
    try {
      // main.js 用 'assets/index.json' 載入 → 幀路徑相對於 assets/
      return new URL(`assets/${raw}`, document.baseURI).href;
    } catch { return raw; }
  };

  /** 素材瀏覽器與檢查器之間的拖放：dataTransfer text/plain = sprite 名。 */
  const wireDrag = (node, getter) => {
    node.draggable = true;
    node.addEventListener('dragstart', (e) => {
      const name = typeof getter === 'function' ? getter() : getter;
      if (!name) { e.preventDefault(); return; }
      // 模組層後備：無頭／部分環境的 drop 事件拿不到 dataTransfer 內容
      dragState.sprite = name;
      const dt = e.dataTransfer;
      node.classList.add('dragging');
      if (!dt) return;
      dt.effectAllowed = 'copy';
      try { dt.setData('text/plain', name); } catch { /* 忽略 */ }
      try { dt.setData('application/x-dr-sprite', name); } catch { /* 部分瀏覽器限制 */ }
    });
    node.addEventListener('dragend', () => node.classList.remove('dragging'));
  };

  /* ---------- 虛擬網格 ---------- */

  const metrics = () => gridMetrics(state.colWidth || scroller.clientWidth || 320, { tile: 64, gap: 6, pad: 8 });

  const makeTile = () => {
    const tile = el('div', { class: 'pan-asset-tile', tabIndex: -1 });
    const thumb = el('div', { class: 'pan-asset-thumb' });
    const img = el('img', { class: 'pan-asset-img', alt: '', draggable: 'false' });
    img.style.display = 'none';
    const ph = el('div', { class: 'pan-asset-ph', text: '?' });
    thumb.appendChild(img);
    thumb.appendChild(ph);
    const label = el('div', { class: 'pan-asset-name' });
    tile.appendChild(thumb);
    tile.appendChild(label);
    tile._img = img;
    tile._ph = ph;
    tile._thumb = thumb;
    tile._label = label;
    tile._bound = null;
    return tile;
  };

  const paintTile = (tile, entry) => {
    if (tile._bound === entry.name) return;
    tile._bound = entry.name;
    tile.dataset.name = entry.name;
    tile._label.textContent = entry.name;
    tile.title = `${T('tile.title', { name: entry.name, w: entry.w, h: entry.h, count: entry.count || 1 })}${entry.tags.length ? `\n${entry.tags.join(', ')}` : ''}`;
    const src = thumbSrc(entry.name, 0);
    if (src) {
      tile._img.src = src;
      tile._img.style.display = '';
      tile._ph.style.display = 'none';
    } else {
      tile._img.removeAttribute('src');
      tile._img.style.display = 'none';
      tile._ph.style.display = '';
      tile._ph.textContent = entry.w && entry.h ? `${entry.w}×${entry.h}` : T('tile.noImage');
    }
    // 依尺寸縮放（保持像素銳利）
    if (entry.w > 0 && entry.h > 0) {
      const scale = Math.min(3, 48 / Math.max(entry.w, entry.h));
      tile._img.style.width = `${Math.max(1, Math.round(entry.w * scale))}px`;
      tile._img.style.height = `${Math.max(1, Math.round(entry.h * scale))}px`;
      tile._thumb.style.width = `${Math.max(1, Math.round(entry.w * scale))}px`;
      tile._thumb.style.height = `${Math.max(1, Math.round(entry.h * scale))}px`;
    } else {
      tile._img.style.width = '';
      tile._img.style.height = '';
      tile._thumb.style.width = '';
      tile._thumb.style.height = '';
    }
    tile.classList.toggle('selected', state.selected === entry.name);
    if (!tile._wired) {
      tile._wired = true;
      wireDrag(tile, () => tile.dataset.name || null);
      tile.addEventListener('click', () => { if (tile.dataset.name) selectByName(tile.dataset.name); });
      tile.addEventListener('dblclick', () => { if (tile.dataset.name) copyName(tile.dataset.name); });
      tile.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && tile.dataset.name) { e.preventDefault(); selectByName(tile.dataset.name); }
      });
    }
  };

  const rebuildGrid = () => {
    const m = metrics();
    state.cols = m.cols;
    const total = state.filtered.length;
    const rowCount = Math.ceil(total / m.cols);
    spacer.style.height = `${Math.max(0, rowCount * m.cellH + m.pad * 2)}px`;
    spacer.style.width = '100%';
    grid.style.position = 'absolute';
    grid.style.left = `${m.pad}px`;
    grid.style.top = '0';
    grid.style.right = `${m.pad}px`;
    layoutVisible();
  };

  /**
   * 可用視窗高度。scroller 被外層 grid/flex 撐開（`1fr` 的 auto 最小值）時
   * clientHeight 會等於全部內容高度，此時虛擬捲動會退化成全部渲染；
   * 以 window.innerHeight 當上限可避免上千 tile 同時進 DOM。
   */
  const viewportHeight = () => {
    const raw = scroller.clientHeight || 0;
    const winH = (typeof window !== 'undefined' && window.innerHeight) || 600;
    const max = Math.max(200, winH);
    if (raw > max) return max;
    return raw || Math.min(300, max);
  };

  const layoutVisible = () => {
    const m = metrics();
    state.cols = m.cols;
    const total = state.filtered.length;
    if (total === 0) {
      clear(grid);
      grid.style.transform = 'translateY(0px)';
      if (!grid.querySelector('.pan-empty')) grid.appendChild(el('div', { class: 'pan-assets-empty pan-empty-sub', text: T('empty.noMatch') }));
      return;
    }
    const rowCount = Math.ceil(total / m.cols);
    const rowH = m.cellH;
    const vr = virtualRange(state.scrollTop, viewportHeight(), rowH, rowCount, 3);
    const { from, to } = itemRange(vr.startRow, vr.endRow, m.cols, total);
    const need = to - from;
    // 擴充池
    while (state.pool.length < need) state.pool.push(makeTile());
    // 回收多餘
    while (state.pool.length > Math.max(need, 24)) state.pool.pop();
    const y = m.pad + vr.startRow * rowH;
    grid.style.transform = `translateY(${y}px)`;
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = `repeat(${m.cols}, ${m.tile}px)`;
    grid.style.gap = `${m.gap}px`;
    // 重建子節點（只掛需要的 tiles）
    const frag = document.createDocumentFragment();
    for (let k = 0; k < need; k += 1) {
      const tile = state.pool[k];
      paintTile(tile, state.filtered[from + k]);
      frag.appendChild(tile);
    }
    // 移除不在 frag 的其餘子節點
    clear(grid);
    grid.appendChild(frag);
  };

  /* ---------- 選取 / 詳細資料 ---------- */

  const selectByName = (name) => {
    state.selected = name;
    for (const tile of state.pool) tile.classList.toggle('selected', tile.dataset.name === name);
    renderDetail();
  };

  const copyName = async (name) => {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(name);
        flashToast(T('toast.copied', { name }));
        return;
      }
    } catch { /* fallthrough */ }
    flashToast(T('toast.name', { name }));
  };

  let toastEl = null;
  let toastTimer = null;
  const flashToast = (msg) => {
    if (!toastEl) {
      toastEl = el('div', { class: 'pan-toast' });
      rootEl.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('show'), 1600);
  };

  const renderDetail = () => {
    clear(detail);
    const entry = state.all.find((e) => e.name === state.selected);
    if (!entry) {
      detail.appendChild(emptyState(T('detail.empty'), T('detail.emptySub')));
      return;
    }
    detail.appendChild(el('div', { class: 'pan-detail-title pan-mono', text: entry.name }));

    // 放大預覽（依尺寸縮放到 ~96px）
    const preview = el('div', { class: 'pan-detail-preview' });
    const img = el('img', { alt: entry.name, draggable: 'false' });
    const src = thumbSrc(entry.name, 0);
    if (src) {
      img.src = src;
      const scale = Math.max(1, Math.min(6, Math.floor(96 / Math.max(1, entry.w || 16, entry.h || 16))));
      img.style.width = `${(entry.w || 16) * scale}px`;
      img.style.height = `${(entry.h || 16) * scale}px`;
      img.style.imageRendering = 'pixelated';
      preview.appendChild(img);
    } else {
      preview.appendChild(el('div', { class: 'pan-empty-sub', text: T('detail.imageMissing') }));
    }
    detail.appendChild(preview);

    // 欄位
    const info = el('div', { class: 'pan-detail-info' });
    for (const line of spriteInfoLines(entry)) {
      const row = el('div', { class: 'pan-detail-row' });
      row.appendChild(el('span', { class: 'pan-detail-label', text: line.label }));
      row.appendChild(el('span', { class: 'pan-detail-value pan-mono', text: line.value }));
      info.appendChild(row);
    }
    detail.appendChild(info);

    // 幀數 > 1 → 幀選擇列
    if (entry.count > 1) {
      const frames = el('div', { class: 'pan-detail-frames' });
      const maxShow = Math.min(entry.count, 64);
      for (let f = 0; f < maxShow; f += 1) {
        const fi = el('img', { class: 'pan-frame-thumb', alt: T('frame.alt', { name: entry.name, i: f }), draggable: 'false' });
        const fs = thumbSrc(entry.name, f);
        if (fs) fi.src = fs;
        fi.title = T('frame.title', { i: f });
        fi.style.imageRendering = 'pixelated';
        frames.appendChild(fi);
      }
      if (entry.count > maxShow) frames.appendChild(el('span', { class: 'pan-empty-sub', text: T('frames.more', { count: entry.count }) }));
      detail.appendChild(section(T('section.frames'), frames, { collapsed: false }));
    }

    // 拖曳提示 + 複製
    const actions = el('div', { class: 'pan-detail-actions' });
    actions.appendChild(button(T('btn.copyName'), { small: true, onClick: () => copyName(entry.name) }));
    actions.appendChild(button(T('btn.dragToField'), {
      small: true,
      title: T('title.dragToField'),
      onClick: () => flashToast(T('toast.dragHint')),
    }));
    detail.appendChild(actions);

    // 讓這顆按鈕本身也可拖
    const dragBtn = actions.lastChild;
    dragBtn.draggable = true;
    dragBtn.addEventListener('dragstart', (e) => {
      const dt = e.dataTransfer;
      if (!dt) return;
      dt.effectAllowed = 'copy';
      dt.setData('text/plain', entry.name);
      try { dt.setData('application/x-dr-sprite', entry.name); } catch { /* ignore */ }
    });

    detail.appendChild(el('div', { class: 'pan-hint', text: T('hint.drag') }));
  };

  /* ---------- 篩選 ---------- */

  const applyFilter = () => {
    state.filtered = filterSprites(state.all, {
      query: state.query,
      tags: Array.from(state.tags),
      tagMode: state.tagMode,
      custom: state.customOnly,
    });
    countBadge.textContent = state.filtered.length === state.all.length
      ? String(state.all.length)
      : `${state.filtered.length}/${state.all.length}`;
    // tag bar 重建（維持 active 狀態）
    buildTagBar();
    renderDetail();
    rebuildGrid();
  };

  /* ---------- 尺寸監聽 / 捲動 ---------- */

  const onScroll = () => {
    state.scrollTop = scroller.scrollTop;
    scheduleLayout();
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });

  let layoutRaf = 0;
  const scheduleLayout = () => {
    if (state.destroyed || state.rafPending) return;
    state.rafPending = true;
    const run = () => {
      state.rafPending = false;
      if (state.destroyed) return;
      layoutVisible();
    };
    if (typeof requestAnimationFrame === 'function') layoutRaf = requestAnimationFrame(run);
    else setTimeout(run, 0);
  };

  let ro = null;
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(() => {
      const w = scroller.clientWidth || rootEl.clientWidth;
      if (w !== state.colWidth) {
        state.colWidth = w;
        rebuildGrid();
      }
    });
    ro.observe(scroller);
  }
  state.colWidth = scroller.clientWidth || rootEl.clientWidth || 320;

  /* ---------- 鍵盤 ---------- */

  const onKeyDown = (e) => {
    if (!state.selected) return;
    const idx = state.filtered.findIndex((x) => x.name === state.selected);
    if (idx < 0) return;
    let next = idx;
    const m = metrics();
    if (e.key === 'ArrowRight') next = Math.min(state.filtered.length - 1, idx + 1);
    else if (e.key === 'ArrowLeft') next = Math.max(0, idx - 1);
    else if (e.key === 'ArrowDown') next = Math.min(state.filtered.length - 1, idx + m.cols);
    else if (e.key === 'ArrowUp') next = Math.max(0, idx - m.cols);
    else if (e.key === 'Enter') { copyName(state.selected); return; }
    else return;
    e.preventDefault();
    const target = state.filtered[next];
    if (!target) return;
    selectByName(target.name);
    // 確保可見
    const row = Math.floor(next / m.cols);
    const top = row * m.cellH;
    const bottom = top + m.cellH;
    if (top < scroller.scrollTop) scroller.scrollTop = top;
    else if (bottom > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = bottom - scroller.clientHeight;
  };
  rootEl.addEventListener('keydown', onKeyDown);

  /* ---------- 語系切換：重繪文字，保留篩選 / 選取 / 捲動 ---------- */

  const relabel = () => {
    if (state.destroyed) return;
    const keepScroll = scroller.scrollTop;
    rootEl.setAttribute('aria-label', T('aria'));
    if (titleEl) titleEl.textContent = T('title');
    search.placeholder = T('placeholder.search');
    modeBtn.textContent = state.tagMode === 'any' ? T('btn.modeAny') : T('btn.modeAll');
    modeBtn.title = T('title.modeToggle');
    clearTags.textContent = T('btn.clearFilters');
    if (toastEl) toastEl.classList.remove('show');
    // 讓 tile 重新套用 title（_bound 是 sprite 名，換語系後要強制刷新）
    for (const tile of state.pool) { tile._bound = null; }
    applyFilter();
    renderDetail();
    rebuildGrid();
    scroller.scrollTop = keepScroll;
  };

  const unsubLocale = onLocaleChange(() => { if (!state.destroyed) relabel(); });

  /* ---------- 啟動 ---------- */

  applyFilter();
  renderDetail();
  if (state.all.length > 0) {
    // 預設選第一個 soul tag 的素材，沒有就第一個
    const first = state.all.find((e) => e.tags.includes('soul')) || state.all[0];
    selectByName(first.name);
  }

  const controller = {
    destroy() {
      state.destroyed = true;
      if (layoutRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(layoutRaf);
      if (ro && typeof ro.disconnect === 'function') ro.disconnect();
      if (toastTimer) clearTimeout(toastTimer);
      if (typeof unsubLocale === 'function') unsubLocale();
      rootEl.removeEventListener('keydown', onKeyDown);
      clear(rootEl);
      rootEl.classList.remove('pan-assets');
      instances.delete(rootEl);
    },
    select(name) { if (state.all.some((e) => e.name === name)) selectByName(name); },
    getSelected: () => state.selected,
    /** 測試用：目前篩選結果名稱。 */
    getFilteredNames: () => state.filtered.map((e) => e.name),
    setQuery(q) { state.query = q; search.value = q; applyFilter(); },
    setTags(tags) { state.tags = new Set(tags); applyFilter(); },
  };
  instances.set(rootEl, controller);
  return controller;
}

export { spriteNamesOf };
