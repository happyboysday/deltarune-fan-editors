/**
 * editor/i18n.js — 編輯器介面多語系（協調者擁有；改動前先通知協調者）
 *
 * 語系：'zh-Hant'（繁中）、'zh-Hans'（簡中）、'en'（English）。預設依 localStorage，
 * 其次依瀏覽器語言（zh-CN/zh-SG → zh-Hans；其他 zh → zh-Hant；其餘 → en）。
 *
 * 用法：
 *   import { t, registerStrings, setLocale, getLocale, onLocaleChange, applyDom, LOCALES } from './i18n.js';
 *   registerStrings('timeline', { 'zh-Hant': { add: '新增事件' }, 'zh-Hans': { add: '新增事件' }, en: { add: 'Add event' } });
 *   t('timeline.add')                     // → 依目前語系
 *   t('timeline.count', { n: 3 })         // 字串內 {n} 會被替換
 *   onLocaleChange(() => rerender())      // 回傳取消函式
 *   applyDom(rootEl)                      // 套用 data-i18n / data-i18n-title / data-i18n-placeholder / data-i18n-aria-label
 *
 * 退回順序：目前語系 → zh-Hant → en → key 本身（並在 console 警告一次）。
 * 鍵名格式：'<命名空間>.<鍵>'；命名空間＝模組名（toolbar、preview、timeline、inspector、assets、bulletTypes、fileops、common…）。
 */

export const LOCALES = [
  { id: 'zh-Hant', label: '繁中' },
  { id: 'zh-Hans', label: '简中' },
  { id: 'en', label: 'English' },
];

const STORAGE_KEY = 'drbe.locale';
const bundles = new Map(); // ns -> { [locale]: { key: string } }
const listeners = new Set();
const warned = new Set();

function detectLocale() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (saved && LOCALES.some((l) => l.id === saved)) return saved;
  } catch { /* 無 localStorage */ }
  const nav = (globalThis.navigator?.language || '').toLowerCase();
  if (/^zh-(cn|sg|hans)/.test(nav)) return 'zh-Hans';
  if (nav.startsWith('zh')) return 'zh-Hant';
  return 'en';
}

let current = detectLocale();
if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = current;

export function getLocale() {
  return current;
}

export function setLocale(id) {
  if (!LOCALES.some((l) => l.id === id) || id === current) return;
  current = id;
  try { globalThis.localStorage?.setItem(STORAGE_KEY, id); } catch { /* 忽略 */ }
  if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = id;
  for (const fn of [...listeners]) {
    try { fn(id); } catch (err) { console.error('[i18n] listener error', err); }
  }
}

export function onLocaleChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** 註冊（或合併）一個命名空間的字串表。可多次呼叫。 */
export function registerStrings(ns, table) {
  const cur = bundles.get(ns) || {};
  for (const [loc, strings] of Object.entries(table || {})) {
    cur[loc] = { ...(cur[loc] || {}), ...strings };
  }
  bundles.set(ns, cur);
}

function lookup(ns, key, loc) {
  const b = bundles.get(ns);
  const v = b && b[loc] && b[loc][key];
  return typeof v === 'string' ? v : undefined;
}

export function t(fullKey, params) {
  const dot = fullKey.indexOf('.');
  const ns = dot < 0 ? 'common' : fullKey.slice(0, dot);
  const key = dot < 0 ? fullKey : fullKey.slice(dot + 1);
  let s = lookup(ns, key, current) ?? lookup(ns, key, 'zh-Hant') ?? lookup(ns, key, 'en');
  if (s === undefined) {
    if (!warned.has(fullKey)) { warned.add(fullKey); console.warn('[i18n] 缺少字串：', fullKey); }
    s = fullKey;
  }
  if (params) s = s.replace(/\{(\w+)\}/g, (m, p) => (p in params ? String(params[p]) : m));
  return s;
}

/** 套用 DOM 上的 data-i18n 屬性（靜態 HTML 用）。 */
export function applyDom(root = globalThis.document) {
  if (!root?.querySelectorAll) return;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const [attr, prop] of [['i18nTitle', 'title'], ['i18nPlaceholder', 'placeholder'], ['i18nAriaLabel', 'aria-label']]) {
    const sel = '[data-' + attr.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()) + ']';
    for (const el of root.querySelectorAll(sel)) el.setAttribute(prop, t(el.dataset[attr]));
  }
}

/** 戰鬥畫面語言預設值：編輯器語系 en → 'en'，其餘 → 'zh'（簡體）。 */
export function battleLangFor(locale = current) {
  return locale === 'en' ? 'en' : 'zh';
}
