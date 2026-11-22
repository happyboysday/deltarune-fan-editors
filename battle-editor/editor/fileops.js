/**
 * editor/fileops.js — 檔案操作、工具列、通用對話框／提示、鍵盤快捷鍵（ED1）
 *
 * 職責：
 *   - 新建（含一個最小預設攻擊）、從伺服器開啟／儲存（W2 的 serve.py 提供
 *     GET /api/attacks、GET/PUT /api/attacks/<name>.json）
 *   - 匯入／匯出本機 JSON、開啟 samples/ 範例
 *   - 復原／重做按鈕與狀態、文件標題／未儲存標記、驗證錯誤數
 *   - 鍵盤：Ctrl+Z / Ctrl+Y(Ctrl+Shift+Z) / Ctrl+S / 空白鍵播放 / Home 回開頭 / Esc
 *   - 預覽播放控制列與 hitbox／格線開關的接線（工具列屬於 ED1 版面的一部分）
 *
 * 本模組只依賴 DOM 與 store/preview 的公開介面；唯一例外是 engine/attack.js 的常數
 * （BOX_DEFAULTS 等純資料，無 DOM 依賴），避免在編輯器複製戰鬥框預設數字。
 */

import { t, LOCALES, getLocale, setLocale, applyDom, onLocaleChange, battleLangFor } from './i18n.js';
import './locales/app.js'; // 註冊 app/toolbar/preview/fileops 字串（副作用）
import { createSyncClient, normalizeEtag } from './live-sync.js';
import './locales/live-sync.js'; // 註冊 sync.* 字串（副作用）
// 戰鬥框預設值一律取自引擎（SPEC-LAYOUT §5 實機量測），不在編輯器複製數字。
import { BOX_DEFAULTS } from '../engine/attack.js';
import { attackHasDemo, nextAutoplayMode } from './demo-path.js';
// V2-06：作品包匯出／匯入（V2-05 的 /api/pack/*）
import { mountPackButtons } from './pack.js';
// V2-06：匯出可遊玩 HTML 按鈕（V2-09 已完成；只 import，不改該模組）
import { mountExportButton } from '../tools/web/export-button.js';

const SERVER_LIST = '/api/attacks';
const SAMPLE_INDEX = 'samples/index.json';
const SAMPLE_FALLBACK = [
  { file: 'spade-rain.json', name: '黑桃雨', description: 'emitter + rand：黑桃持續落下' },
  { file: 'ring-burst.json', name: '環形彈幕', description: 'count + i 角度公式的環形彈幕' },
  { file: 'box-shrink-aim.json', name: '框縮放 + 瞄準彈', description: 'box 補間 + aim() 追蹤彈' },
  { file: 'sine-wave.json', name: '正弦波彈', description: 'pathX/pathY 每幀表達式' },
];

const els = {};
const state = {
  serverAvailable: null, // null=未知, true/false
  lastSavedName: null,
  sampleFile: null, // B19：從 ?sample= 載入的範例檔名（null = 不是範例）
  busy: false,
  modalOpen: false,
  menuOpen: false,
};

let store = null;
let preview = null;
let notify = null;
let toastSeq = 0;
let syncClient = null;

/* ======================================================================= 工具 */

function q(id) {
  return typeof document !== 'undefined' ? document.getElementById(id) : null;
}

function escapeHtml(text) {
  return String(text == null ? '' : text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isEditableTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = String(target.tagName).toUpperCase();
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}

/**
 * 正規化攻擊檔名。serve.py 的白名單是 `[A-Za-z0-9_\-\u4e00-\u9fa5]+`（不含空白與點），
 * 這裡先把非法字元換成底線，避免送出 400。
 */
function normalizeFileName(name) {
  let n = String(name == null ? '' : name).trim();
  if (!n) return '';
  n = n.replace(/\\/g, '/');
  n = n.split('/').pop() || '';
  n = n.replace(/\.json$/i, '');
  n = n.replace(/[^A-Za-z0-9_\-\u4e00-\u9fa5]+/g, '_');
  n = n.replace(/^_+|_+$/g, '');
  if (!n) return '';
  return `${n}.json`;
}

function stripJson(name) {
  return String(name || '').replace(/\.json$/i, '');
}

function slugify(text) {
  const base = String(text || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fff.-]/g, '');
  return base || '';
}

function pickDefaultName(metaName) {
  if (state.lastSavedName) return stripJson(state.lastSavedName);
  const slug = slugify(metaName || '');
  return slug || 'attack';
}

/* ======================================================================= 預設攻擊 */

/** 最小可玩預設攻擊（新建用），符合 SPEC §3 格式 */
export function createDefaultAttack() {
  return {
    format: 'dr-battle-attack/1',
    meta: { name: t('app.untitledAttack'), author: '' },
    settings: {
      duration: 8.0,
      seed: 1,
      damage: 10,
      invincibleFrames: 30,
      grazeTP: 1.0,
      background: null,
      bgm: null,
    },
    box: { ...BOX_DEFAULTS },
    soul: { x: null, y: null, speed: 4, slowSpeed: 2, mode: 'red', color: '#ff0000' },
    party: [
      { name: 'Kris', hp: 90, maxHp: 90, color: '#00ffff', icon: null },
      { name: 'Susie', hp: 110, maxHp: 110, color: '#c000c0', icon: null },
      { name: 'Ralsei', hp: 70, maxHp: 70, color: '#00ff00', icon: null },
    ],
    enemies: [],
    bulletTypes: {
      basic: {
        sprite: 'spr_smallbullet',
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
    timeline: [
      {
        id: 'ev_intro',
        at: 0.5,
        type: 'emitter',
        label: t('app.defaultAttack.sampleLabel'),
        duration: 5.0,
        interval: 0.35,
        count: 2,
        spawn: {
          bullet: 'basic',
          x: 'rand(box.left + 10, box.right - 10)',
          y: 'box.top - 16',
          speed: 2.6,
          angle: '90 + rand(-10, 10)',
          rotation: 0,
          scale: 1,
          alpha: 1,
        },
      },
      { id: 'ev_end', at: 7.5, type: 'end', label: t('app.defaultAttack.endLabel') },
    ],
  };
}

/* ======================================================================= 提示 */

/** 顯示一條短暫提示 */
export function toast(message, kind = '') {
  const root = q('toast-root');
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast${kind ? ` is-${kind}` : ''}`;
  el.textContent = String(message == null ? '' : message);
  root.appendChild(el);
  toastSeq += 1;
  const seq = toastSeq;
  setTimeout(() => {
    if (seq !== toastSeq) {
      /* 仍保留，最舊的會被移除，避免堆積 */
    }
    el.classList.add('is-out');
    setTimeout(() => el.remove(), 220);
  }, kind === 'error' ? 4200 : 2200);
  while (root.children.length > 4) root.firstElementChild.remove();
}

/** §4-5：#toolbar-msg 訊息停留 4 秒後淡出清空（避免舊訊息一直掛著誤導後續操作） */
const TOOLBAR_MSG_TTL = 4000;
const TOOLBAR_MSG_FADE = 320;
let toolbarMsgTimers = [];

function clearToolbarMsgTimers() {
  for (const timer of toolbarMsgTimers) clearTimeout(timer);
  toolbarMsgTimers = [];
}

/**
 * 寫入工具列訊息並排定淡出。
 * 空字串＝立刻清空（不排淡出）。連續呼叫會重置計時，只留最後一則。
 * @param {string} text
 * @param {string} kind '' | 'ok' | 'error' | 'warn'
 */
export function setToolbarMessage(text, kind = '') {
  const el = q('toolbar-msg');
  clearToolbarMsgTimers();
  if (!el) return;
  const value = String(text == null ? '' : text);
  el.textContent = value;
  el.className = `tb-msg${kind ? ` is-${kind}` : ''}`;
  if (!value) return;
  if (typeof setTimeout !== 'function') return;
  toolbarMsgTimers.push(setTimeout(() => {
    const node = q('toolbar-msg');
    if (!node) return;
    node.classList.add('is-fading');
    toolbarMsgTimers.push(setTimeout(() => {
      const target = q('toolbar-msg');
      if (!target) return;
      // 期間若被新訊息接手，就不要清掉別人的字（比對文字最保險）
      if (target.textContent !== value) return;
      target.textContent = '';
      target.classList.remove('is-fading');
    }, TOOLBAR_MSG_FADE));
  }, TOOLBAR_MSG_TTL));
}

function setStatusMessage(text, kind = '') {
  if (notify) {
    try {
      notify(text, kind);
      return;
    } catch (_err) {
      /* 忽略：退回直接寫工具列 */
    }
  }
  setToolbarMessage(text, kind);
}

/* ======================================================================= 對話框 */

function closeModal() {
  const root = q('modal-root');
  if (!root) return;
  root.hidden = true;
  root.innerHTML = '';
  state.modalOpen = false;
  if (typeof document !== 'undefined') {
    const active = document.activeElement;
    if (active && active.blur) active.blur();
  }
}

/**
 * 通用對話框。
 * @param {{ title:string, body:string|HTMLElement, buttons?:{label:string,kind?:string,value?:any,onClick?:Function,disabled?:boolean}[], wide?:boolean, onClose?:Function }} cfg
 * @returns {Promise<any>} 按鈕的 value（關閉＝undefined）
 */
export function openModal(cfg) {
  const root = q('modal-root');
  if (!root) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    const config = cfg || {};
    root.innerHTML = '';
    const modal = document.createElement('div');
    modal.className = `modal${config.wide ? ' is-wide' : ''}`;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');

    const head = document.createElement('div');
    head.className = 'modal-head';
    const title = document.createElement('span');
    title.className = 'modal-title';
    title.textContent = config.title || '';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'modal-close';
    closeBtn.textContent = '✕';
    closeBtn.title = t('fileops.closeEsc');
    head.append(title, closeBtn);

    const body = document.createElement('div');
    body.className = 'modal-body';
    if (config.body instanceof Node) body.appendChild(config.body);
    else body.innerHTML = config.body || '';

    modal.append(head, body);

    const finish = (value) => {
      const onClose = config.onClose;
      closeModal();
      if (typeof onClose === 'function') {
        try {
          onClose(value);
        } catch (err) {
          console.warn('[fileops] onClose 錯誤：', err);
        }
      }
      resolve(value);
    };

    const buttons = Array.isArray(config.buttons) ? config.buttons : [];
    if (buttons.length) {
      const foot = document.createElement('div');
      foot.className = 'modal-foot';
      for (const b of buttons) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `btn${b.kind ? ` btn-${b.kind}` : ''}`;
        btn.textContent = b.label;
        btn.disabled = Boolean(b.disabled);
        btn.addEventListener('click', () => {
          if (typeof b.onClick === 'function') {
            const r = b.onClick(modal);
            if (r === false) return;
          }
          finish(b.value);
        });
        foot.appendChild(btn);
      }
      modal.appendChild(foot);
    }

    closeBtn.addEventListener('click', () => finish(undefined));
    root.appendChild(modal);
    root.hidden = false;
    state.modalOpen = true;

    root.onclick = (ev) => {
      if (ev.target === root) finish(undefined);
    };

    // 自動聚焦第一個輸入框，否則主按鈕（含危險確認），最後才是 modal 本身
    requestAnimationFrame(() => {
      const input = modal.querySelector('input[type="text"], input[type="number"], textarea');
      if (input) {
        input.focus();
        if (input.select) input.select();
        return;
      }
      const primary = modal.querySelector('.modal-foot .btn-primary, .modal-foot .btn-danger');
      if (primary) {
        primary.focus();
        return;
      }
      modal.setAttribute('tabindex', '-1');
      modal.focus();
    });
  });
}

/** 確認對話框；回傳 true/false */
export function confirmDialog(
  message,
  { title = t('fileops.confirm.title'), okLabel = t('fileops.confirm.ok'), cancelLabel = t('fileops.confirm.cancel'), danger = false, detail = '' } = {},
) {
  const body =
    `<p>${escapeHtml(message)}</p>` + (detail ? `<p style="color:#8a8a99;font-size:11.5px">${escapeHtml(detail)}</p>` : '');
  return openModal({
    title,
    body,
    buttons: [
      { label: cancelLabel, value: false },
      { label: okLabel, value: true, kind: danger ? 'danger' : 'primary' },
    ],
  }).then((v) => v === true);
}

/** 文字輸入對話框；回傳字串或 null */
export function promptDialog(
  message,
  { title = t('fileops.prompt.title'), value = '', okLabel = t('fileops.prompt.ok'), placeholder = '', hint = '' } = {},
) {
  const wrap = document.createElement('div');
  const p = document.createElement('p');
  p.textContent = message;
  const field = document.createElement('div');
  field.className = 'field';
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  field.appendChild(input);
  if (hint) {
    const h = document.createElement('div');
    h.className = 'hint';
    h.textContent = hint;
    field.appendChild(h);
  }
  wrap.append(p, field);

  return openModal({
    title,
    body: wrap,
    buttons: [
      { label: t('fileops.prompt.cancel'), value: null },
      {
        label: okLabel,
        value: '__ok__',
        kind: 'primary',
        onClick: () => {
          const v = input.value;
          if (input.dataset.invalid === '1') return false;
          wrap.dataset.result = v;
          return true;
        },
      },
    ],
  }).then((v) => (v === '__ok__' ? input.value : null));
}

/** 從清單挑一個項目；items=[{label, sub, value}]；回傳 value 或 null */
export function pickDialog(title, items, { emptyText = t('fileops.noItems'), wide = false } = {}) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    const list = document.createElement('div');
    list.className = 'pick-list';

    let settled = false;
    const choose = (value) => {
      if (settled) return;
      settled = true;
      closeModal();
      resolve(value ?? null);
    };

    if (!items || items.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'pick-empty';
      empty.textContent = emptyText;
      list.appendChild(empty);
    } else {
      for (const item of items) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'pick-item';
        const label = document.createElement('span');
        label.textContent = item.label;
        btn.appendChild(label);
        if (item.sub) {
          const sub = document.createElement('span');
          sub.className = 'pick-sub';
          sub.textContent = item.sub;
          btn.appendChild(sub);
        }
        btn.addEventListener('click', () => {
          if (item.onClick) {
            item.onClick();
            choose(null);
            return;
          }
          choose(item.value);
        });
        list.appendChild(btn);
      }
    }
    wrap.appendChild(list);
    openModal({ title, body: wrap, wide, buttons: [{ label: t('fileops.confirm.cancel'), value: null }] }).then((v) => {
      if (!settled) {
        settled = true;
        resolve(v ?? null);
      }
    });
  });
}

/* ======================================================================= 下拉選單 */

export function closeMenu() {
  const root = q('menu-root');
  if (!root) return;
  root.hidden = true;
  root.innerHTML = '';
  state.menuOpen = false;
}

/**
 * 在 anchor 元素下方顯示下拉選單。
 * @param {HTMLElement} anchor
 * @param {{label:string, sub?:string, onClick?:Function, disabled?:boolean, sep?:boolean, note?:string}[]} items
 */
export function openMenu(anchor, items) {
  const root = q('menu-root');
  if (!root || !anchor) return;
  closeMenu();
  root.innerHTML = '';
  for (const item of items) {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.className = 'menu-sep';
      root.appendChild(sep);
      continue;
    }
    if (item.note) {
      const note = document.createElement('div');
      note.className = 'menu-note';
      note.textContent = item.note;
      root.appendChild(note);
      continue;
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `menu-item${item.disabled ? ' is-disabled' : ''}`;
    btn.disabled = Boolean(item.disabled);
    const label = document.createElement('span');
    label.textContent = item.label || '';
    btn.appendChild(label);
    if (item.sub) {
      const sub = document.createElement('span');
      sub.className = 'mi-sub';
      sub.textContent = item.sub;
      btn.appendChild(sub);
    }
    btn.addEventListener('click', () => {
      closeMenu();
      if (typeof item.onClick === 'function') item.onClick();
    });
    root.appendChild(btn);
  }
  // 先顯示才能量測
  root.hidden = false;
  state.menuOpen = true;
  const rect = anchor.getBoundingClientRect();
  const mw = root.offsetWidth;
  const mh = root.offsetHeight;
  let left = rect.left;
  let top = rect.bottom + 4;
  if (left + mw > window.innerWidth - 8) left = Math.max(8, window.innerWidth - mw - 8);
  if (top + mh > window.innerHeight - 8) top = Math.max(8, rect.top - mh - 4);
  root.style.left = `${Math.round(left)}px`;
  root.style.top = `${Math.round(top)}px`;
  anchor.setAttribute('aria-expanded', 'true');
  const closer = (ev) => {
    if (root.contains(ev.target) || anchor.contains(ev.target)) return;
    document.removeEventListener('pointerdown', closer, true);
    anchor.setAttribute('aria-expanded', 'false');
    closeMenu();
  };
  setTimeout(() => document.addEventListener('pointerdown', closer, true), 0);
}

/* ======================================================================= 伺服器 API */

function apiUnavailableMessage(reason) {
  return t('fileops.api.unreachable', { reason });
}

async function serverList() {
  try {
    const res = await fetch(SERVER_LIST, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    let raw = [];
    if (Array.isArray(data)) raw = data;
    else if (data && Array.isArray(data.attacks)) raw = data.attacks;
    else if (data && Array.isArray(data.files)) raw = data.files;

    const items = [];
    const seen = new Set();
    for (const entry of raw) {
      const rawName = typeof entry === 'string' ? entry : entry && (entry.file || entry.name);
      if (typeof rawName !== 'string' || !rawName) continue;
      const fileName = normalizeFileName(rawName);
      if (!fileName || seen.has(fileName)) continue;
      seen.add(fileName);
      items.push({
        file: fileName,
        metaName: entry && typeof entry === 'object' ? entry.metaName || '' : '',
        duration: entry && typeof entry === 'object' && Number.isFinite(Number(entry.duration)) ? Number(entry.duration) : null,
        modified: entry && typeof entry === 'object' && Number.isFinite(Number(entry.modified)) ? Number(entry.modified) : null,
        size: entry && typeof entry === 'object' && Number.isFinite(Number(entry.size)) ? Number(entry.size) : null,
      });
    }
    state.serverAvailable = true;
    return { ok: true, files: items };
  } catch (err) {
    state.serverAvailable = false;
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function serverLoad(fileName) {
  const name = normalizeFileName(fileName);
  const url = `${SERVER_LIST}/${encodeURIComponent(name)}`;
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(t('fileops.api.httpError', { status: res.status, name }));
  const etag = res.headers ? res.headers.get('ETag') || res.headers.get('X-Etag') || '' : '';
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(t('fileops.api.badJson', { name, msg: err.message }));
  }
  return { data, name, etag: normalizeEtag(etag) };
}

async function serverSave(fileName, attack) {
  const name = normalizeFileName(fileName);
  // 有即時同步客戶端時走 ETag + If-Match（SPEC-AGENT §5）；衝突以 conflict 丟出
  if (syncClient) {
    const result = await syncClient.save(name, attack);
    if (result && result.ok) return result.name || name;
    if (result && result.conflict) {
      const err = new Error(t('sync.message.conflict'));
      err.conflict = true;
      err.etag = result.etag || '';
      err.current = result.current || null;
      err.name = name;
      throw err;
    }
    throw new Error((result && result.error) || t('fileops.api.httpError', { status: 0, name }));
  }
  const url = `${SERVER_LIST}/${encodeURIComponent(name)}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(attack, null, 2),
  });
  if (!res.ok) throw new Error(t('fileops.api.httpError', { status: res.status, name }));
  return name;
}

/* ======================================================================= 開檔共用流程 */

/**
 * B19：解析 `index.html?file=…` / `?sample=…` 的查詢參數（純函式，可測試）。
 *
 * 接受的寫法（都很常見，全部要吃得下）：
 *   ?file=spade-rain
 *   ?file=spade-rain.json
 *   ?file=attacks%2Fspade-rain.json
 *   ?file=/attacks/spade-rain.json
 *   ?sample=spade-rain        ?sample=spade-rain.json
 * `file` 優先於 `sample`；都沒有或值為空 → null。
 *
 * @param {string} search location.search 或 '?file=…'
 * @returns {{kind:'file'|'sample', name:string, raw:string}|null}
 */
export function parseOpenQuery(search) {
  const raw = String(search == null ? '' : search).trim();
  const q = raw.startsWith('?') ? raw.slice(1) : raw;
  if (!q) return null;
  let params;
  try {
    params = new URLSearchParams(q);
  } catch (_err) {
    return null;
  }
  // `?attack=` 是早期文件用的寫法，一併接受（file 優先）
  const file = (params.get('file') || params.get('attack') || '').trim();
  if (file) {
    const name = stripJson(file.replace(/\\/g, '/').split('/').pop() || '');
    if (name) return { kind: 'file', name, raw: file };
  }
  const sample = (params.get('sample') || '').trim();
  if (sample) {
    const name = stripJson(sample.replace(/\\/g, '/').split('/').pop() || '');
    if (name) return { kind: 'sample', name, raw: sample };
  }
  return null;
}

/**
 * B19：把目前檔案同步到網址（`?file=<name>.json`），方便分享／重新整理。
 * 用 replaceState 不動歷史紀錄；只改 file/sample 兩個參數，其餘保留。
 * @param {string|null} fileName 例如 "spade-rain.json"；null = 移除 ?file=
 * @param {string|null} [sampleName] 範例名（例如 "spade-rain"）；給了就寫 ?sample=，
 *        沒給則清掉（範例沒有可寫回的檔名，重新整理時靠 ?sample= 還原）
 */
export function syncUrlFile(fileName, sampleName) {
  if (typeof window === 'undefined' || !window.history || !window.location) return false;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('attack');
    if (fileName) {
      // 統一帶 .json（parseOpenQuery 兩種都吃，但分享出去的網址要明確）
      const clean = stripJson(String(fileName).replace(/\\/g, '/').split('/').pop() || '');
      if (clean) url.searchParams.set('file', `${clean}.json`);
      else url.searchParams.delete('file');
    } else {
      url.searchParams.delete('file');
    }
    const sampleClean = sampleName
      ? stripJson(String(sampleName).replace(/\\/g, '/').split('/').pop() || '')
      : '';
    if (sampleClean && !fileName) url.searchParams.set('sample', sampleClean);
    else url.searchParams.delete('sample');
    const next = url.pathname + url.search + url.hash;
    const cur = window.location.pathname + window.location.search + window.location.hash;
    if (next === cur) return false;
    window.history.replaceState(window.history.state, '', next);
    return true;
  } catch (_err) {
    return false;
  }
}

/**
 * B19：啟動時依 query 自動載入（`?file=` 開攻擊、`?sample=` 開範例）。
 * 找不到時 toast 錯誤並維持目前的空白文件（不丟例外、不擋啟動）。
 * @returns {Promise<boolean>} 是否成功載入
 */
export async function openFromQuery(search) {
  const want = parseOpenQuery(search === undefined ? (typeof window !== 'undefined' && window.location ? window.location.search : '') : search);
  if (!want) return false;

  if (want.kind === 'sample') {
    const file = want.raw.toLowerCase().endsWith('.json') ? want.raw : `${want.name}.json`;
    setStatusMessage(t('fileops.samples.loading', { file }));
    try {
      const res = await fetch(`samples/${encodeURIComponent(file)}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      afterOpen(data, t('fileops.samples.loadTip', { file }), null);
      state.sampleFile = file;
      syncUrlFile(null, file); // 範例沒有檔名 → 用 ?sample= 讓重新整理可回到同一份
      setStatusMessage(t('fileops.samples.loaded', { name: stripJson(file) }), 'ok');
      toast(t('fileops.samples.loaded', { name: stripJson(file) }), 'ok');
      return true;
    } catch (err) {
      const msg = t('fileops.autoLoad.sampleMissing', { name: want.name, msg: err && err.message ? err.message : String(err) });
      setStatusMessage(msg, 'error');
      toast(msg, 'error');
      return false;
    }
  }

  // kind === 'file'：先試伺服器 API，失敗再退回直接讀 attacks/ 靜態檔（純靜態伺服器也能分享）
  const fileName = `${want.name}.json`;
  setStatusMessage(t('fileops.autoLoad.opening', { name: fileName }));
  try {
    const { data, name, etag } = await serverLoad(fileName);
    afterOpen(data, t('fileops.open.opened', { name }), name, etag);
    setStatusMessage(t('fileops.open.opened', { name }), 'ok');
    toast(t('fileops.open.opened', { name }), 'ok');
    return true;
  } catch (apiErr) {
    try {
      const res = await fetch(`attacks/${encodeURIComponent(fileName)}`, { headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      afterOpen(data, t('fileops.open.opened', { name: fileName }), null);
      setStatusMessage(t('fileops.open.opened', { name: fileName }), 'ok');
      toast(t('fileops.open.opened', { name: fileName }), 'ok');
      return true;
    } catch (_staticErr) {
      const msg = t('fileops.autoLoad.fileMissing', { name: fileName });
      setStatusMessage(msg, 'error');
      toast(msg, 'error');
      // 維持空白文件：不改 store，只讓網址回到乾淨狀態
      syncUrlFile(null);
      return false;
    }
  }
}

async function confirmDiscard(actionLabel) {
  if (state.busy) return false;
  if (!store || !store.isDirty()) return true;
  return confirmDialog(t('fileops.discard.busyMessage', { action: actionLabel }), {
    title: t('fileops.discard.title'),
    okLabel: t('fileops.discard.ok'),
    cancelLabel: t('fileops.discard.cancel'),
    danger: true,
  });
}

function afterOpen(attack, label, fileName, etag = '') {
  store.replace(attack, label);
  store.fileName = fileName || null;
  state.lastSavedName = fileName || null;
  // 範例沒有可寫回的檔名；由 loadSample / openFromQuery 之後自己標記。
  state.sampleFile = null;
  // B19：把目前檔案同步進網址；沒有檔名（新建／匯入）就清掉舊的 ?file= / ?sample=
  syncUrlFile(fileName || null);
  // 開檔時記住伺服器版本；之後存檔帶 If-Match，被別人改過就會 409
  if (syncClient) syncClient.setEtag(etag || '');
  if (preview && preview.isReady && preview.isReady()) {
    try {
      preview.seek(0);
    } catch (_err) {
      /* 忽略 */
    }
  }
  refreshToolbarState();
  updateDocumentTitle();
}

/** 新建 */
export async function newAttack() {
  if (!(await confirmDiscard(t('fileops.new.label')))) return false;
  const attack = createDefaultAttack();
  afterOpen(attack, t('fileops.new.title'), null);
  setStatusMessage(t('fileops.new.done'));
  toast(t('fileops.new.done'), 'ok');
  return true;
}

/** 開啟伺服器上的檔案（清單對話框） */
export async function openFromServer() {
  if (!(await confirmDiscard(t('fileops.open.title')))) return false;
  setStatusMessage(t('fileops.open.loading'));
  const res = await serverList();
  if (!res.ok) {
    setStatusMessage(t('fileops.open.failedTitle'), 'error');
    await openModal({
      title: t('fileops.open.noServer'),
      body: `<p>${escapeHtml(apiUnavailableMessage(res.error))}</p>`,
      buttons: [{ label: t('fileops.ack'), value: true, kind: 'primary' }],
    });
    return false;
  }
  if (res.files.length === 0) {
    await openModal({
      title: t('fileops.open.emptyTitle'),
      body: t('fileops.open.emptyBody'),
      buttons: [{ label: t('fileops.ack'), value: true, kind: 'primary' }],
    });
    return false;
  }
  const items = res.files.map((f) => {
    const label = f.metaName || stripJson(f.file);
    const bits = [];
    // 有顯示名稱時仍要看到實際檔名，否則同名攻擊分不出來
    if (f.metaName) bits.push(f.file);
    if (f.duration) bits.push(`${f.duration}s`);
    if (f.modified) {
      try {
        bits.push(new Date(f.modified).toLocaleString('zh-TW', { hour12: false }));
      } catch (_err) {
        /* 忽略 */
      }
    }
    return { label, sub: bits.length ? bits.join('・') : f.file, value: f.file };
  });
  const picked = await pickDialog(t('fileops.open.dialogTitle'), items, { wide: true });
  if (!picked) return false;
  setStatusMessage(t('fileops.open.opening', { name: picked }));
  try {
    const { data, name, etag } = await serverLoad(picked);
    afterOpen(data, t('fileops.open.opened', { name }), name, etag);
    setStatusMessage(t('fileops.open.opened', { name }), 'ok');
    toast(t('fileops.open.opened', { name }), 'ok');
    return true;
  } catch (err) {
    setStatusMessage(t('fileops.open.failedTitle2'), 'error');
    toast(t('fileops.open.failed', { msg: err.message || err }), 'error');
    return false;
  }
}

/** 儲存（有檔名直接存，否則另存） */
export async function saveAttack() {
  if (!store) return false;
  // §4-8：範例（samples/*.json）不可覆寫，第一次存檔一定要走「另存為」，
  // 並預填 `<範例名>-copy`，避免覆蓋到範例或存成無檔名的新檔。
  if (state.sampleFile && !store.fileName) return saveAttackAs();
  const fileName = store.fileName || state.lastSavedName;
  if (!fileName) return saveAttackAs();
  return doSave(fileName);
}

/** 另存新檔 */
export async function saveAttackAs() {
  if (!store) return false;
  const fromSample = state.sampleFile ? stripJson(state.sampleFile) : '';
  const suggested = fromSample
    ? `${fromSample}-copy`
    : pickDefaultName(store.attack && store.attack.meta ? store.attack.meta.name : '');
  const name = await promptDialog(t('fileops.save.dialogTitle'), {
    title: t('fileops.save.asTitle'),
    value: suggested,
    placeholder: 'attack',
    // §4-8：從範例來的存檔要講清楚「範例不可覆寫，會另存到 attacks/」
    hint: fromSample ? t('fileops.save.sampleHint', { sample: fromSample }) : t('fileops.save.hint'),
  });
  if (name === null) return false;
  const clean = normalizeFileName(name);
  if (!clean) {
    toast(t('fileops.save.emptyName'), 'error');
    return false;
  }
  return doSave(clean);
}

async function doSave(fileName, { retry = false } = {}) {
  if (!store || state.busy) return false;
  state.busy = true;
  refreshToolbarState();
  setStatusMessage(t('fileops.save.saving', { name: fileName }));
  try {
    const snapshot = store.attack;
    const saved = await serverSave(fileName, snapshot);
    // 伺服器回傳的 name 可能不帶 .json（live-sync 用 payload.name），
    // 這裡統一正規化，store.fileName 與網址上的 ?file= 才會一致帶副檔名。
    const savedName = normalizeFileName(saved) || saved;
    const clean = store.markSaved(savedName, snapshot);
    state.lastSavedName = savedName;
    state.sampleFile = null; // 存檔後就是一般攻擊檔了
    syncUrlFile(savedName);
    updateDocumentTitle();
    const message = clean ? t('fileops.save.saved', { name: stripJson(savedName) }) : t('fileops.save.pendingEdits');
    setStatusMessage(message, clean ? 'ok' : 'warn');
    toast(message, clean ? 'ok' : 'warn');
    return true;
  } catch (err) {
    // 409：別人改過這個檔案 → 合併提示（保留我的 / 採用對方 / 檢視差異）
    if (err && err.conflict && syncClient && !retry) {
      setStatusMessage(t('sync.message.conflict'), 'warn');
      const choice = await syncClient.resolveConflict({
        name: normalizeFileName(fileName),
        current: err.current,
        etag: err.etag,
      });
      if (choice === 'theirs') {
        const clean = normalizeFileName(fileName);
        store.markSaved(clean);
        state.lastSavedName = clean;
        updateDocumentTitle();
        setStatusMessage(t('sync.merge.doneTheirs'), 'ok');
        toast(t('sync.merge.doneTheirs'), 'ok');
        return true;
      }
      if (choice === 'mine') {
        state.busy = false;
        refreshToolbarState();
        return doSave(fileName, { retry: true });
      }
      setStatusMessage(t('fileops.save.failedTitle'), 'warn');
      return false;
    }
    setStatusMessage(t('fileops.save.failedTitle'), 'error');
    await openModal({
      title: t('fileops.save.failedTitle'),
      body:
        `<p>${escapeHtml(err && err.message ? err.message : String(err))}</p>` +
        `<p style="color:#8a8a99">${escapeHtml(t('fileops.save.failed', { msg: err && err.message ? err.message : String(err) }))}</p>` +
        t('fileops.save.fallbackHint'),
      buttons: [
        { label: t('fileops.confirm.cancel'), value: null },
        {
          label: t('fileops.save.exportInstead'),
          value: 'export',
          kind: 'primary',
        },
      ],
    }).then((v) => {
      if (v === 'export') exportAttack();
    });
    return false;
  } finally {
    state.busy = false;
    refreshToolbarState();
  }
}

/** 匯入本機 JSON */
export async function importAttack() {
  if (!(await confirmDiscard(t('fileops.import.title')))) return false;
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) {
        resolve(false);
        return;
      }
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        afterOpen(data, t('fileops.import.loading', { name: file.name }), null);
        setStatusMessage(t('fileops.import.done', { name: file.name }), 'ok');
        toast(t('fileops.import.done', { name: file.name }), 'ok');
        resolve(true);
      } catch (err) {
        toast(t('fileops.import.failed', { msg: err.message || err }), 'error');
        await openModal({
          title: t('fileops.import.failedTitle'),
          body: `<p>無法解析 <code>${escapeHtml(file.name)}</code>。</p><p style="color:#ff8f99">${escapeHtml(
            err && err.message ? err.message : String(err),
          )}</p>`,
          buttons: [{ label: t('fileops.ack'), value: true, kind: 'primary' }],
        });
        resolve(false);
      }
    });
    input.addEventListener('cancel', () => {
      input.remove();
      resolve(false);
    });
    document.body.appendChild(input);
    input.click();
  });
}

/** 匯出本機 JSON */
export function exportAttack() {
  if (!store) return false;
  const attack = store.attack || {};
  const metaName = attack.meta && attack.meta.name ? String(attack.meta.name) : '';
  const base = store.fileName ? stripJson(store.fileName) : slugify(metaName) || 'attack';
  const name = normalizeFileName(base);
  try {
    const blob = new Blob([JSON.stringify(attack, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      a.remove();
    }, 0);
    setStatusMessage(t('fileops.export.done', { name }), 'ok');
    toast(t('fileops.export.done', { name }), 'ok');
    return true;
  } catch (err) {
    toast(t('fileops.export.failed', { msg: err.message || err }), 'error');
    return false;
  }
}

/** 開啟 samples/ 範例 */
export async function openSampleMenu(anchorEl) {
  let samples = SAMPLE_FALLBACK.slice();
  try {
    const res = await fetch(SAMPLE_INDEX, { headers: { Accept: 'application/json' } });
    if (res.ok) {
      const data = await res.json();
      const list = Array.isArray(data) ? data : data && Array.isArray(data.samples) ? data.samples : null;
      if (list && list.length) {
        samples = list
          .map((s) => (typeof s === 'string' ? { file: s, name: stripJson(s) } : s))
          .filter((s) => s && s.file);
      }
    }
  } catch (_err) {
    /* 用 fallback */
  }
  const items = samples.map((s) => ({
    label: s.name || stripJson(s.file),
    sub: s.duration ? `${s.duration}s` : stripJson(s.file),
    onClick: () => loadSample(s.file),
  }));
  if (items.length === 0) items.push({ label: t('fileops.samples.empty'), disabled: true });
  openMenu(anchorEl || els.btnSamples, [
    { note: t('fileops.samples.menu') },
    ...items,
  ]);
}

async function loadSample(file) {
  if (!(await confirmDiscard(t('fileops.samples.loadTip', { file })))) return false;
  setStatusMessage(t('fileops.samples.loading', { file }));
  try {
    const res = await fetch(`samples/${encodeURIComponent(file)}`, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    afterOpen(data, t('fileops.samples.loadTip', { file }), null);
    state.sampleFile = file;
    syncUrlFile(null, file); // ?sample=<name>：重新整理可回到同一份範例
    setStatusMessage(t('fileops.samples.loaded', { name: stripJson(file) }), 'ok');
    toast(t('fileops.samples.loaded', { name: stripJson(file) }), 'ok');
    return true;
  } catch (err) {
    setStatusMessage(t('fileops.samples.failedTitle'), 'error');
    toast(t('fileops.samples.failed', { msg: err.message || err }), 'error');
    return false;
  }
}

/* ======================================================================= 工具列狀態 */

export function refreshToolbarState() {
  if (!store) return;
  if (els.btnUndo) {
    const can = typeof store.canUndo === 'function' ? store.canUndo() : false;
    els.btnUndo.disabled = !can;
    els.btnUndo.title = can ? t('toolbar.tip.undo') : t('fileops.undo.none');
  }
  if (els.btnRedo) {
    const can = typeof store.canRedo === 'function' ? store.canRedo() : false;
    els.btnRedo.disabled = !can;
    els.btnRedo.title = can ? t('toolbar.tip.redo') : t('fileops.redo.none');
  }
  const errCount = store.errors instanceof Map ? store.errors.size : 0;
  if (els.errorCount) {
    els.errorCount.hidden = errCount === 0;
    els.errorCount.textContent = t('toolbar.errorChip', { n: errCount });
    els.errorCount.title = errCount ? t('toolbar.errorChipHint') : '';
  }
  updateDocumentTitle();
  updatePreviewButtons();
}

function updatePreviewButtons() {
  const ready = Boolean(preview && typeof preview.isReady === 'function' && preview.isReady());
  for (const btn of [els.btnPlay, els.btnTry, els.btnPlayPause, els.btnGotoStart, els.btnStepBack, els.btnStepFwd]) {
    if (btn) btn.disabled = !ready;
  }
  if (els.btnTry) {
    const trying = Boolean(preview && preview.isTrying && preview.isTrying());
    els.btnTry.classList.toggle('is-active', trying);
    els.btnTry.textContent = trying ? t('fileops.try.exit') : t('toolbar.try');
    els.btnTry.title = trying ? t('fileops.try.tipExit') : t('fileops.try.tipEnter');
  }
}

export function updateDocumentTitle() {
  if (!store) return;
  const attack = store.attack || {};
  const metaName = attack.meta && attack.meta.name ? String(attack.meta.name) : '';
  const fileName = store.fileName || state.lastSavedName || '';
  const label = fileName ? stripJson(fileName) : metaName || t('app.untitled');
  if (els.docName) {
    els.docName.textContent = label;
    els.docName.title = fileName
      ? t('fileops.doc.fileInfo', { name: fileName })
      : t('fileops.doc.metaInfo', { name: metaName || t('app.untitled') });
  }
  const dirty = typeof store.isDirty === 'function' ? store.isDirty() : false;
  if (els.docDirty) els.docDirty.hidden = !dirty;
  if (typeof document !== 'undefined') {
    const suffix = dirty ? ' •' : '';
    document.title = t('app.docTitle', { name: `${fileName || metaName || t('app.untitled')}${suffix}` });
  }
}

function showErrorList() {
  if (!store) return;
  const errors = store.errors instanceof Map ? [...store.errors.entries()] : [];
  if (errors.length === 0) {
    openModal({
      title: t('fileops.errors.none'),
      body: t('fileops.errors.noneBody'),
      buttons: [{ label: t('fileops.ok'), value: true, kind: 'primary' }],
    });
    return;
  }
  const rows = errors
    .map(
      ([path, message]) =>
        `<div style="padding:4px 0;border-bottom:1px solid #1e1e26">` +
        `<code style="color:#ffd84a;font-family:var(--font-mono);font-size:11.5px">${escapeHtml(path)}</code>` +
        `<div style="color:#ffb3ba;margin-top:2px">${escapeHtml(message)}</div></div>`,
    )
    .join('');
  openModal({
    title: t('fileops.errors.title', { n: errors.length }),
    wide: true,
    body: t('fileops.errors.hint', { rows }),
    buttons: [{ label: t('fileops.close'), value: true, kind: 'primary' }],
  });
}

/* ======================================================================= 試玩 */

export function toggleTryMode() {
  if (!preview || !preview.isReady || !preview.isReady()) return false;
  if (preview.isTrying()) {
    preview.exitTry();
    document.body.classList.remove('is-try');
    setTryHint(false);
    setStatusMessage(t('fileops.try.exited'));
  } else {
    preview.enterTry();
    if (preview.isTrying()) {
      document.body.classList.add('is-try');
      setTryHint(true);
      setStatusMessage(t('fileops.try.started'));
    }
  }
  updatePreviewButtons();
  return preview.isTrying();
}

function setTryHint(show) {
  const stageEl = q('preview-stage');
  if (!stageEl) return;
  let hint = stageEl.querySelector('.try-hint');
  if (show) {
    if (!hint) {
      hint = document.createElement('div');
      hint.className = 'try-hint';
      hint.textContent = t('preview.tryHint');
      stageEl.appendChild(hint);
    }
    hint.hidden = false;
  } else if (hint) {
    hint.remove();
  }
}

function exitTryMode() {
  if (!preview || !preview.isTrying || !preview.isTrying()) return false;
  const frame = preview.getFrame();
  preview.exitTry();
  document.body.classList.remove('is-try');
  setTryHint(false);
  if (preview.isReady && preview.isReady()) {
    try {
      preview.seek(frame);
    } catch (_err) {
      /* 忽略 */
    }
  }
  updatePreviewButtons();
  setStatusMessage(t('fileops.try.exited'));
  return true;
}

export function togglePlay() {
  if (!preview || !preview.isReady || !preview.isReady()) return false;
  if (preview.isTrying && preview.isTrying()) return false;
  const playing = preview.togglePlay();
  updatePreviewButtons();
  return playing;
}

/* ======================================================================= 鍵盤 */

/**
 * B6：Modal 按 Enter 的判定（純函式，方便測試）。
 * 回傳：
 *   'primary'     → 觸發主按鈕（單行 input、或焦點就在 modal／非互動容器上）
 *   'passthrough' → 不攔截，交給瀏覽器預設（按鈕／下拉／連結自己會處理 Enter）
 *   'ignore'      → 不攔截也不動作（textarea 要能換行、contenteditable 也是）
 * @param {any} el document.activeElement（或事件 target）
 * @param {boolean} insideModal 事件焦點是否在 modal 內（預設 true）
 */
export function modalEnterIntent(el, insideModal = true) {
  // 對話框是 modal：焦點跑到外面（工具列按鈕…）時，Enter 仍然要確定
  if (insideModal === false) return 'primary';
  if (!el) return 'primary';
  if (el.isContentEditable) return 'ignore';
  const tag = String(el.tagName || '').toUpperCase();
  if (!tag) return 'primary';            // 焦點不在任何元素（例如 modal 本身）→ 確定
  if (tag === 'TEXTAREA') return 'ignore'; // 多行輸入：Enter 是換行，不是確定
  if (tag === 'BUTTON' || tag === 'SELECT' || tag === 'A') return 'passthrough';
  if (tag === 'INPUT') {
    const type = String(el.type || 'text').toLowerCase();
    if (type === 'textarea') return 'ignore';
    // 這些控制項的 Enter 有原生語意（勾選、選色、拉桿…），不要搶
    if (['checkbox', 'radio', 'file', 'color', 'range', 'button', 'submit', 'reset'].includes(type)) {
      return 'passthrough';
    }
    return 'primary'; // 單行輸入框：Enter ＝確定（檔案對話框通用慣例）
  }
  return 'primary'; // div / body / modal 容器…
}

/**
 * B6：找出目前 modal 的主按鈕。
 * 優先 `.btn-primary`，其次 `.btn-danger`（「未儲存 → 放棄變更」這類危險確認），
 * 最後才退回按鈕列的最後一顆（慣例上確定在右側）。
 */
function findModalPrimary() {
  const root = q('modal-root');
  if (!root || root.hidden) return null;
  const candidates = ['.modal .modal-foot .btn-primary', '.modal .modal-foot .btn-danger'];
  for (const sel of candidates) {
    const btn = root.querySelector(sel);
    if (btn && !btn.disabled) return btn;
  }
  const all = root.querySelectorAll('.modal .modal-foot .btn');
  for (let i = all.length - 1; i >= 0; i--) {
    const btn = all[i];
    if (btn && !btn.disabled) return btn;
  }
  return null;
}

/** B6：Enter 觸發主按鈕；回傳是否攔截了事件 */
export function activateModalPrimary(ev) {
  const root = q('modal-root');
  const target = ev && ev.target;
  const insideModal = !!(root && target && typeof root.contains === 'function' && root.contains(target));
  const intent = modalEnterIntent(target, insideModal);
  if (intent !== 'primary') return false;
  const primary = findModalPrimary();
  if (!primary) return false;
  if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
  primary.click();
  return true;
}

function onKeyDown(ev) {
  if (!ev) return;
  const key = ev.key || '';
  const mod = ev.ctrlKey || ev.metaKey;

  // 對話框開啟時處理 Esc（關閉）與 Enter（確定）
  if (state.modalOpen) {
    if (key === 'Escape') {
      const root = q('modal-root');
      const closeBtn = root ? root.querySelector('.modal-close') : null;
      if (closeBtn) closeBtn.click();
      ev.preventDefault();
      return;
    }
    if (key === 'Enter' || key === 'NumpadEnter') {
      // B6：焦點在單行 input 或 modal 本身時，Enter ＝確定；textarea 不攔截
      activateModalPrimary(ev);
      return;
    }
    return;
  }

  if (key === 'Escape') {
    if (state.menuOpen) {
      closeMenu();
      ev.preventDefault();
      return;
    }
    if (preview && preview.isTrying && preview.isTrying()) {
      exitTryMode();
      ev.preventDefault();
      return;
    }
  }

  if (mod) {
    const k = key.toLowerCase();
    if (k === 'z' && !ev.shiftKey) {
      ev.preventDefault();
      doUndo();
      return;
    }
    if ((k === 'z' && ev.shiftKey) || k === 'y') {
      ev.preventDefault();
      doRedo();
      return;
    }
    if (k === 's') {
      ev.preventDefault();
      saveAttack();
      return;
    }
  }

  if (isEditableTarget(ev.target)) return;

  // B13：P ＝ 切換預覽自動演示（關→腳本→AI→關；沒有 demo 時 關↔AI）
  //      R ＝ 預覽重來（回到第 0 幀並重建 pilot）
  //      輸入框／下拉／modal 有焦點時不搶鍵（上面 isEditableTarget 與 modalOpen 已先返回）；
  //      事件選單開著時也不搶（P 留給選單操作，避免邊選事件邊跳模式）。
  if (state.menuOpen) return;
  const plainKey = String(key || '').toLowerCase();
  if (!ev.shiftKey && !ev.altKey && (plainKey === 'p' || plainKey === 'r')) {
    if (plainKey === 'p') {
      if (toggleAutoplayPreview()) {
        ev.preventDefault();
        return;
      }
    } else if (restartPreview()) {
      ev.preventDefault();
      return;
    }
  }

  if (key === ' ' || key === 'Spacebar') {
    ev.preventDefault();
    togglePlay();
    return;
  }
  if (key === 'Home') {
    ev.preventDefault();
    if (preview && preview.isReady && preview.isReady()) preview.gotoStart();
    return;
  }
  // 單幀前後（按鈕提示寫的就是 ←／→）
  if (key === 'ArrowRight' && !ev.shiftKey) {
    ev.preventDefault();
    if (preview && preview.isReady && preview.isReady()) preview.step(1);
    return;
  }
  if (key === 'ArrowLeft' && !ev.shiftKey) {
    ev.preventDefault();
    if (preview && preview.isReady && preview.isReady()) preview.step(-1);
    return;
  }
}

/* ======================================================================= 自動演示快捷鍵（B13） */

/** 上次開啟過的自動演示模式（P 鍵關掉後再按一次要回到它）。 */
let lastAutoplayMode = 'demo';

/** 這份攻擊有沒有可用的 demo 內容（決定 P 鍵是幾態循環）。 */
export function hasDemoContent() {
  return attackHasDemo(store ? store.attack : null);
}

/**
 * P 鍵：把預覽的自動演示往下一個模式推進（關 → 腳本 → AI → 關）。
 * 沒有 demo 內容時只在「關 ⇄ AI」之間切換（腳本模式沒東西可跑）。
 * @returns {boolean} 是否真的切換了（false = 預覽尚未就緒）
 */
export function toggleAutoplayPreview() {
  if (!preview || typeof preview.setAutoplayMode !== 'function') return false;
  const current = typeof preview.getAutoplayMode === 'function' ? preview.getAutoplayMode() : 'off';
  const next = nextAutoplayMode(current, hasDemoContent());
  if (current !== 'off') lastAutoplayMode = current;
  const applied = preview.setAutoplayMode(next) || next;
  const label = autoplayLabel(applied);
  setStatusMessage(t('fileops.autoplay.switched', { mode: label }), applied === 'off' ? '' : 'ok');
  toast(t('fileops.autoplay.switched', { mode: label }), applied === 'off' ? '' : 'ok');
  updatePreviewButtons();
  return true;
}

/**
 * R 鍵：預覽重來（回到第 0 幀、重建 pilot）。自動演示關閉時仍然有效
 * （等同 Home），方便 R 鍵行為一致。
 * @returns {boolean}
 */
export function restartPreview() {
  if (!preview) return false;
  const run = typeof preview.restart === 'function' ? preview.restart : null;
  if (!run) return false;
  try {
    if (run.call(preview) === false) return false;
  } catch (err) {
    console.warn('[fileops] 預覽重來失敗：', err);
    return false;
  }
  setStatusMessage(t('fileops.autoplay.restarted'));
  return true;
}

/** 自動演示模式的顯示文字（off / 腳本 / AI）。 */
function autoplayLabel(mode) {
  const key = mode === 'demo' || mode === 'bot' ? mode : 'off';
  return t(`autoplay.${key}`);
}

export function doUndo() {
  if (!store) return false;
  if (!store.canUndo()) {
    setStatusMessage(t('fileops.undo.none'));
    return false;
  }
  const ok = store.undo();
  refreshToolbarState();
  if (ok) setStatusMessage(t('fileops.undo.done'));
  return ok;
}

export function doRedo() {
  if (!store) return false;
  if (!store.canRedo()) {
    setStatusMessage(t('fileops.redo.none'));
    return false;
  }
  const ok = store.redo();
  refreshToolbarState();
  if (ok) setStatusMessage(t('fileops.redo.done'));
  return ok;
}

/* ======================================================================= 接線 */

function cacheElements() {
  els.btnNew = q('btn-new');
  els.btnOpen = q('btn-open');
  els.btnSave = q('btn-save');
  els.btnSaveAs = q('btn-save-as');
  els.btnImport = q('btn-import');
  els.btnExport = q('btn-export');
  els.btnSamples = q('btn-samples');
  els.btnUndo = q('btn-undo');
  els.btnRedo = q('btn-redo');
  els.btnPlay = q('btn-play');
  els.btnTry = q('btn-try');
  els.btnGotoStart = q('btn-goto-start');
  els.btnStepBack = q('btn-step-back');
  els.btnPlayPause = q('btn-play-pause');
  els.btnStepFwd = q('btn-step-fwd');
  els.docName = q('doc-name');
  els.docDirty = q('doc-dirty');
  els.errorCount = q('error-count');
  els.optGrid = q('opt-grid');
  els.optHitbox = q('opt-hitbox');
  els.btnBattleLang = q('btn-battle-lang');
  els.syncChip = q('sync-chip');
  els.agentNote = q('agent-note');
}

function wireButtons() {
  const on = (el, evt, fn) => {
    if (!el) return;
    el.addEventListener(evt, (ev) => {
      ev.preventDefault();
      fn(ev);
    });
  };

  on(els.btnNew, 'click', () => newAttack());
  on(els.btnOpen, 'click', () => openFromServer());
  on(els.btnSave, 'click', () => saveAttack());
  on(els.btnSaveAs, 'click', () => saveAttackAs());
  on(els.btnImport, 'click', () => importAttack());
  on(els.btnExport, 'click', () => exportAttack());
  on(els.btnSamples, 'click', () => openSampleMenu(els.btnSamples));
  on(els.btnUndo, 'click', () => doUndo());
  on(els.btnRedo, 'click', () => doRedo());
  on(els.btnPlay, 'click', () => togglePlay());
  on(els.btnTry, 'click', () => toggleTryMode());
  on(els.btnGotoStart, 'click', () => preview && preview.gotoStart && preview.gotoStart());
  on(els.btnStepBack, 'click', () => preview && preview.step && preview.step(-1));
  on(els.btnPlayPause, 'click', () => togglePlay());
  on(els.btnStepFwd, 'click', () => preview && preview.step && preview.step(1));

  if (els.optGrid) {
    els.optGrid.checked = true;
    els.optGrid.addEventListener('change', () => {
      if (preview && preview.setShowGrid) preview.setShowGrid(els.optGrid.checked);
    });
  }
  if (els.optHitbox) {
    els.optHitbox.checked = false;
    els.optHitbox.addEventListener('change', () => {
      if (preview && preview.setShowHitboxes) preview.setShowHitboxes(els.optHitbox.checked);
    });
  }
  if (els.errorCount) {
    els.errorCount.addEventListener('click', () => showErrorList());
    els.errorCount.style.pointerEvents = 'auto';
  }
  // 戰鬥畫面語言（中 / EN）：預覽工具列的切換鈕
  if (els.btnBattleLang) {
    els.btnBattleLang.addEventListener('click', () => {
      if (preview && typeof preview.setBattleLang === 'function') {
        const lang = preview.setBattleLang();
        setStatusMessage(t('preview.battleLang.tip', { lang: lang === 'en' ? t('preview.battleLang.en') : t('preview.battleLang.zh') }));
      }
    });
    // 雙擊＝回到跟隨介面語系
    els.btnBattleLang.addEventListener('dblclick', (ev) => {
      ev.preventDefault();
      if (preview && typeof preview.followLocaleBattleLang === 'function') preview.followLocaleBattleLang();
    });
  }
}

/**
 * 掛上工具列與快捷鍵。
 * @param {{ store:any, preview:any, onMessage?:(text:string, kind?:string)=>void }} ctx
 */
/* ======================================================================= 即時同步（SPEC-AGENT §5） */

function renderSyncStatus(status) {
  const s = status || {};
  const chip = els.syncChip || q('sync-chip');
  const note = els.agentNote || q('agent-note');
  if (chip) {
    if (!s.available && !s.connected) {
      chip.hidden = true;
    } else {
      chip.hidden = false;
      chip.dataset.state = s.connected ? 'online' : 'offline';
      chip.textContent = s.connected ? t('sync.chip.connected') : t('sync.chip.idle');
      chip.title = s.lastAgentAction ? t('sync.chip.lastAction', { action: s.lastAgentAction }) : t('sync.chip.title');
    }
  }
  if (note) {
    if (s.lastAgentAction) {
      note.hidden = false;
      note.textContent = s.lastAgentAction;
    } else {
      note.hidden = true;
      note.textContent = '';
    }
  }
}

/** 在文件裡找出 id 對應的 JSON 路徑（focus 事件的 eventId 用） */
function findPathById(node, id, path = '') {
  if (!node || typeof node !== 'object' || id === undefined || id === null) return null;
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i += 1) {
      const found = findPathById(node[i], id, `${path}[${i}]`);
      if (found) return found;
    }
    return null;
  }
  if (String(node.id) === String(id) && path) return path;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (value && typeof value === 'object') {
      const found = findPathById(value, id, path ? `${path}.${key}` : key);
      if (found) return found;
    }
  }
  return null;
}

/** 套用 focus 的「選取事件 + 跳幀」部分（可能重複呼叫，必須冪等） */
function applyFocusView(focus) {
  if (!focus) return;
  if (focus.eventId !== undefined && focus.eventId !== null) {
    const path = findPathById(store.doc, focus.eventId);
    if (path) {
      const head = path.split(/[.[]/).filter(Boolean)[0] || '';
      const kind = head === 'timeline' ? 'event' : head || 'event';
      store.setSelection({ kind, id: focus.eventId, path });
    }
  }
  if (focus.frame !== undefined && focus.frame !== null && preview && typeof preview.seek === 'function') {
    try {
      preview.seek(Math.max(0, Math.round(Number(focus.frame) || 0)));
    } catch (_err) {
      /* 忽略 */
    }
  }
}

/**
 * 剛換檔時 preview 會 debounce 重載並把 frame 歸零，
 * 直接 seek 會被蓋掉 → 等重載穩定後再套用（最多 ~1.6 秒）。
 */
async function applyFocusViewAfterSwitch(focus) {
  const target = Number(focus && focus.frame);
  for (let i = 0; i < 16; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    applyFocusView(focus);
    if (!Number.isFinite(target)) break;
    const frame = preview && typeof preview.getFrame === 'function' ? preview.getFrame() : null;
    if (typeof frame === 'number' && Math.abs(frame - target) <= 1) break;
  }
}

async function handleFocusEvent(focus, by = '') {
  if (!focus || !store) return;
  const target = focus.name ? normalizeFileName(focus.name) : null;
  const current = store.fileName || state.lastSavedName;
  let switched = false;
  if (target && target !== current) {
    if (!(await confirmDiscard(t('sync.action.focus', { by: by || 'agent' })))) return;
    try {
      const loaded = await serverLoad(target);
      afterOpen(loaded.data, t('sync.focus.fileSwitched', { name: target }), target, loaded.etag);
      toast(t('sync.focus.fileSwitched', { name: target }), 'ok');
      switched = true;
    } catch (err) {
      toast(err && err.message ? err.message : String(err), 'error');
      return;
    }
  }
  if (switched) await applyFocusViewAfterSwitch(focus);
  else applyFocusView(focus);
  if (focus.frame !== undefined && focus.frame !== null) {
    toast(t('sync.focus.frame', { frame: Math.round(Number(focus.frame) || 0) }), 'ok');
  }
}

function startSyncClient() {
  if (syncClient || typeof window === 'undefined') return;
  try {
    let sessionStore = null;
    try {
      sessionStore = window.sessionStorage;
    } catch (_err) {
      sessionStore = null;
    }
    syncClient = createSyncClient({
      kind: 'attack',
      store,
      preview,
      getFileName: () => store.fileName || state.lastSavedName,
      onMessage: (text, kind) => {
        const level = kind === 'error' ? 'error' : 'ok';
        setStatusMessage(text, level);
        if (level === 'error') toast(text, 'error');
      },
      onStatus: renderSyncStatus,
      onFocus: (focus, by) => handleFocusEvent(focus, by),
      sessionStorage: sessionStore,
    });
    syncClient.start();
    renderSyncStatus(syncClient.getStatus());
  } catch (err) {
    console.warn('[fileops] 即時同步初始化失敗：', err);
  }
}

export function mountToolbar(ctx) {
  store = ctx.store;
  preview = ctx.preview || null;
  notify = ctx.onMessage || null;
  cacheElements();
  wireButtons();

  /* V2-06：作品包匯出／匯入（serve.py 的 /api/pack/export|import）。
   * 按鈕在 index.html 的 #btn-pack-export / #btn-pack-import；掛載在這裡，
   * 才能重用本模組的 toast / openModal 與 fileops.* 字串。 */
  let packApi = null;
  try {
    packApi = mountPackButtons({
      store,
      toast,
      openModal,
      t: (key, params) => t(`fileops.${key}`, params),
      // fileops 的 pack.* 字串放在 fileops 命名空間下
      documentRef: typeof document !== 'undefined' ? document : null,
    });
  } catch (err) {
    console.warn('[fileops] 作品包按鈕掛載失敗：', err);
    packApi = null;
  }

  /* V2-06：匯出可遊玩 HTML（V2-09 的 tools/web/export-button.js）。
   * 只 import 使用、不改那個模組；作品名優先取伺服器檔名（伺服器用 name 找檔案）。
   * 按鈕掛在自己的 .tb-group 裡，插在 .tb-spacer 之前，避免擠到右側狀態列。 */
  let gameExport = null;
  // 匯出按鈕支援 setLang()（V2-FIX1）：語系變更時直接換文字/提示，不必 destroy 重建一顆。
  const mountGameExport = () => {
    try {
      const toolbar = q('toolbar');
      let host = q('tb-group-export-game');
      if (!host && toolbar) {
        host = document.createElement('div');
        host.id = 'tb-group-export-game';
        host.className = 'tb-group';
        const spacer = toolbar.querySelector('.tb-spacer');
        if (spacer && spacer.parentNode === toolbar) toolbar.insertBefore(host, spacer);
        else toolbar.appendChild(host);
      }
      return mountExportButton({
        container: host || toolbar,
        getTarget: () => {
          if (!store.fileName || store.isDirty()) throw new Error(t('fileops.export.saveFirst'));
          return { name: store.fileName.replace(/\.json$/i, ''), kind: 'attack' };
        },
        lang: battleLangFor(getLocale()),
      });
    } catch (err) {
      console.warn('[fileops] 匯出可遊玩 HTML 按鈕掛載失敗：', err);
      return null;
    }
  };
  gameExport = mountGameExport();

  if (store && typeof store.subscribe === 'function') {
    store.subscribe((_s, change) => {
      refreshToolbarState();
      if (syncClient) syncClient.reportState(false);
      if (change && change.saved) return;
    });
  }
  startSyncClient();
  if (preview && typeof preview.onStatus === 'function') {
    preview.onStatus(() => updatePreviewButtons());
  }
  // 初始狀態
  if (preview && preview.isReady && preview.isReady()) {
    if (els.optGrid) els.optGrid.checked = Boolean(preview.getOptions && preview.getOptions().showGrid);
    if (els.optHitbox) els.optHitbox.checked = Boolean(preview.getOptions && preview.getOptions().showHitboxes);
  } else {
    if (els.optGrid) els.optGrid.checked = Boolean(preview && preview.getOptions && preview.getOptions().showGrid);
    if (els.optHitbox) els.optHitbox.checked = false;
  }
  refreshToolbarState();

  // 介面語系變更：重新套用靜態 DOM 文字，並重建動態字串（按鈕 title、文件標題…）
  const unsubscribeLocale = onLocaleChange(() => {
    try {
      applyDom(document);
    } catch (_err) {
      /* 忽略 */
    }
    refreshToolbarState();
    if (els.btnTry && els.btnTry.textContent) updatePreviewButtons();
    // 作品包按鈕的字串是動態寫的，語系變更要重新套用
    if (packApi) {
      try {
        packApi.localize();
      } catch (_err) {
        /* 忽略 */
      }
    }
    // 匯出可遊玩 HTML 的標籤要跟著換語系：有 setLang() 就地更新，舊版才重建
    if (gameExport) {
      try {
        if (typeof gameExport.setLang === 'function') {
          gameExport.setLang(battleLangFor(getLocale()));
        } else {
          gameExport.destroy();
          gameExport = mountGameExport();
        }
      } catch (_err) {
        /* 忽略 */
      }
    }
  });

  window.addEventListener('keydown', onKeyDown, false);

  // 視窗關閉前提醒未儲存
  window.addEventListener('beforeunload', (ev) => {
    if (store && store.isDirty && store.isDirty()) {
      ev.preventDefault();
      ev.returnValue = '';
      return '';
    }
    return undefined;
  });

  // 點空白處關閉選單
  document.addEventListener('pointerdown', (ev) => {
    if (!state.menuOpen) return;
    const root = q('menu-root');
    if (root && root.contains(ev.target)) return;
    if (els.btnSamples && els.btnSamples.contains(ev.target)) return;
    closeMenu();
  });

  return {
    refresh: refreshToolbarState,
    updateDocumentTitle,
    toast,
    openModal,
    confirmDialog,
    promptDialog,
    packApi,
    gameExport,
    destroy() {
      window.removeEventListener('keydown', onKeyDown, false);
      try {
        unsubscribeLocale();
      } catch (_err) {
        /* 忽略 */
      }
      if (packApi) {
        try {
          packApi.destroy();
        } catch (_err) {
          /* 忽略 */
        }
        packApi = null;
      }
      if (gameExport) {
        try {
          gameExport.destroy();
        } catch (_err) {
          /* 忽略 */
        }
        gameExport = null;
      }
      if (syncClient) {
        try {
          syncClient.destroy();
        } catch (_err) {
          /* 忽略 */
        }
        syncClient = null;
      }
    },
  };
}

export default mountToolbar;

