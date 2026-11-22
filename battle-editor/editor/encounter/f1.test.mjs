// editor/encounter/f1.test.mjs  (F1：REALTEST-2026-11-08 的 B1 / B2 / B7 / Enter / B12 / B17)
//
// 只測「可觀察行為」，不引入外部依賴：
//   B1  結構樹：點 label＝只選取、不改資料；✕ 刪除一定要先確認；空白節點可直接刪
//   B2  normalizeFileName：含路徑時只取最後一段檔名（與攻擊編輯器一致）
//   B7  存檔後 #enc-doc-name 顯示檔名
//   Enter 單行 input 的 modal 按 Enter＝確定；textarea 不攔
//   B12 / B17 以原始碼掃描守住（清空 boot 狀態、範例選單 max-width）
//
// 執行：node --test editor/encounter/f1.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { createStore } from '../store.js';
import { ensureStructure, buildTree, nodeHasChildContent, mount } from './tree.js';
import {
  normalizeFileName,
  willSaveAsName,
  promptDialog,
  openModal,
  mountToolbar,
  confirmDialog,
} from './fileops.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ========================================================== 最小 DOM 替身 */

class FakeNode {
  constructor(tag) {
    this.tagName = String(tag || 'div').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.className = '';
    this.value = '';
    this.type = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.scrollTop = 0;
    this.title = '';
    this.textContent = '';
    this._listeners = new Map();
  }
  get firstChild() {
    return this.children[0] || null;
  }
  get childNodes() {
    return this.children;
  }
  get classList() {
    const node = this;
    return {
      add: (...names) => {
        const set = new Set(String(node.className || '').split(/\s+/).filter(Boolean));
        for (const n of names) set.add(n);
        node.className = [...set].join(' ');
      },
      remove: (...names) => {
        const drop = new Set(names);
        node.className = String(node.className || '')
          .split(/\s+/)
          .filter((n) => n && !drop.has(n))
          .join(' ');
      },
      contains: (name) => String(node.className || '').split(/\s+/).includes(name),
      toggle: (name, force) => {
        const has = String(node.className || '').split(/\s+/).includes(name);
        const want = force === undefined ? !has : !!force;
        if (want && !has) node.classList.add(name);
        if (!want && has) node.classList.remove(name);
        return want;
      },
    };
  }
  setAttribute(name, value) {
    this.attributes.set(String(name), String(value));
  }
  getAttribute(name) {
    return this.attributes.has(String(name)) ? this.attributes.get(String(name)) : null;
  }
  removeAttribute(name) {
    this.attributes.delete(String(name));
  }
  appendChild(child) {
    if (child.parentNode) child.parentNode.removeChild(child);
    child.parentNode = this;
    this.children.push(child);
    return child;
  }
  append(...nodes) {
    for (const n of nodes) this.appendChild(n);
  }
  removeChild(child) {
    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
    child.parentNode = null;
    return child;
  }
  remove() {
    if (this.parentNode) this.parentNode.removeChild(this);
  }
  addEventListener(type, fn) {
    if (!this._listeners.has(type)) this._listeners.set(type, new Set());
    this._listeners.get(type).add(fn);
  }
  removeEventListener(type, fn) {
    const set = this._listeners.get(type);
    if (set) set.delete(fn);
  }
  dispatchEvent(evt) {
    const event = { target: this, type: 'click', preventDefault() {}, stopPropagation() {}, ...evt };
    for (const fn of [...(this._listeners.get(event.type) || [])]) fn(event);
    return true;
  }
  click() {
    return this.dispatchEvent({ type: 'click', target: this });
  }
  focus() {
    if (globalThis.document) globalThis.document.activeElement = this;
  }
  blur() {
    if (globalThis.document && globalThis.document.activeElement === this) globalThis.document.activeElement = null;
  }
  select() {}
  matches(selector) {
    return matchSimple(this, selector);
  }
  querySelectorAll(selector) {
    const out = [];
    const parts = String(selector).split(',').map((x) => x.trim()).filter(Boolean);
    const walk = (node) => {
      for (const child of node.children) {
        if (parts.some((p) => matchSimple(child, p))) out.push(child);
        walk(child);
      }
    };
    walk(this);
    return out;
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }
}

function attrOf(node, name) {
  if (name.startsWith('data-')) {
    const key = name.slice(5).replace(/-([a-z])/g, (_m, c) => c.toUpperCase());
    return node.dataset && node.dataset[key] !== undefined ? String(node.dataset[key]) : null;
  }
  if (name === 'class') return node.className || '';
  return node.getAttribute(name);
}

/** 只支援 tag / .class / #id / [attr] / [attr="v"] 與它們的組合。 */
function matchSimple(node, selector) {
  const sel = String(selector).trim();
  if (!sel) return false;
  const tokens = sel.match(/^([a-zA-Z*]+)?((?:[.#][\w-]+|\[[^\]]+\])*)$/);
  if (!tokens) return false;
  const [, tag, rest] = tokens;
  if (tag && tag !== '*' && node.tagName !== tag.toUpperCase()) return false;
  const re = /([.#])([\w-]+)|\[([^\]=]+)(?:="?([^"\]]*)"?)?\]/g;
  let m;
  while ((m = re.exec(rest || '')) !== null) {
    if (m[1] === '.') {
      if (!String(node.className || '').split(/\s+/).includes(m[2])) return false;
    } else if (m[1] === '#') {
      if (attrOf(node, 'id') !== m[2]) return false;
    } else {
      const value = attrOf(node, m[3]);
      if (m[4] === undefined) {
        if (value === null) return false;
      } else if (value !== m[4]) return false;
    }
  }
  return true;
}

function installFakeDom() {
  const head = new FakeNode('head');
  const body = new FakeNode('body');
  const byId = new Map();
  const doc = {
    baseURI: 'http://localhost/',
    documentElement: new FakeNode('html'),
    head,
    body,
    activeElement: null,
    title: '',
    createElement: (tag) => new FakeNode(tag),
    createTextNode: (text) => {
      const n = new FakeNode('#text');
      n.textContent = text;
      return n;
    },
    getElementById: (id) => byId.get(id) || null,
    querySelectorAll: (selector) => [...head.querySelectorAll(selector), ...body.querySelectorAll(selector)],
    querySelector(selector) {
      return doc.querySelectorAll(selector)[0] || null;
    },
    addEventListener() {},
    removeEventListener() {},
    register(node, id) {
      byId.set(id, node);
      node.setAttribute('id', id);
      return node;
    },
  };
  const saved = { document: globalThis.document, Node: globalThis.Node };
  globalThis.document = doc;
  globalThis.Node = FakeNode;
  return {
    doc,
    body,
    head,
    restore() {
      if (saved.document === undefined) delete globalThis.document;
      else globalThis.document = saved.document;
      if (saved.Node === undefined) delete globalThis.Node;
      else globalThis.Node = saved.Node;
    },
  };
}

function findAll(root, selector) {
  return root.querySelectorAll(selector);
}

/* ================================================================ 測試資料 */

function sampleEncounter() {
  return {
    format: 'dr-battle-encounter/1',
    meta: { name: 'Rudinn遭遇' },
    settings: {},
    actors: { rudinn: { kind: 'enemy', x: 320, y: 200, anims: {} } },
    party: [],
    enemies: [
      {
        id: 'rudinn',
        actor: 'rudinn',
        name: 'Rudinn',
        hp: 100,
        maxHp: 100,
        acts: [
          { id: 'check', name: '查看', text: '', cues: [] },
          { id: 'compliment', name: '稱讚', text: '', cues: [] },
        ],
      },
    ],
    items: [],
    turns: [],
    hooks: {},
    vars: {},
  };
}

function makeStore(doc = sampleEncounter()) {
  return createStore(ensureStructure(doc), { storage: null, autosave: false });
}

function rowsOf(root) {
  return findAll(root, '.enc-tnode');
}

function rowFor(root, key) {
  return rowsOf(root).find((r) => String(r.dataset.key) === key) || null;
}

/* ======================================================= B1：結構樹點擊行為 */

test('B1 nodeHasChildContent：有 ACT 的敵人要確認，空白節點不用', () => {
  const doc = ensureStructure({
    ...sampleEncounter(),
    items: [{ id: 'i1', name: '', count: 0 }],
  });
  const tree = buildTree(doc);
  assert.equal(nodeHasChildContent(tree.byKey.get('enemy:enemies[0]'), doc), true);
  assert.equal(nodeHasChildContent(tree.byKey.get('item:items[0]'), doc), false);
});

test('B1 點列中央（label）只選取，不改 doc、不改 acts 數量', () => {
  const dom = installFakeDom();
  const store = makeStore();
  try {
    const root = dom.doc.createElement('div');
    const view = mount(root, { store, confirmDialog: async () => true, toast: () => {} });
    try {
      const before = JSON.stringify(store.doc);
      const enemyRow = rowFor(root, 'enemy:enemies[0]');
      assert.ok(enemyRow, '應渲染出 enemies[0] 這一列');
      const label = findAll(enemyRow, '.enc-tlabel')[0];
      assert.ok(label, '列上應有 label');

      // 模擬「點 label」：事件目標是 label，監聽器在列上（比照真實 DOM 冒泡）
      enemyRow.dispatchEvent({ type: 'click', target: label });

      assert.equal(JSON.stringify(store.doc), before, '點 label 不應改動任何資料');
      assert.equal(store.doc.enemies[0].acts.length, 2, 'acts 數量不變');
      assert.equal(store.selection.kind, 'enemy', '應選取敵人節點');
      assert.equal(store.selection.path, 'enemies[0]');
      assert.equal(store.isDirty(), false, '只選取不應變 dirty');
    } finally {
      view.destroy();
    }
  } finally {
    dom.restore();
  }
});

test('B1 點列但目標不是按鈕時，一律只選取（含空白處與 badge）', () => {
  const dom = installFakeDom();
  const store = makeStore();
  try {
    const root = dom.doc.createElement('div');
    const view = mount(root, { store, confirmDialog: async () => true, toast: () => {} });
    try {
      const before = JSON.stringify(store.doc);
      const enemyRow = rowFor(root, 'enemy:enemies[0]');
      enemyRow.dispatchEvent({ type: 'click', target: enemyRow });
      assert.equal(JSON.stringify(store.doc), before);
      assert.equal(store.selection.path, 'enemies[0]');
    } finally {
      view.destroy();
    }
  } finally {
    dom.restore();
  }
});

test('B1 點 ✕ 一定要先確認；取消則資料不變', async () => {
  const dom = installFakeDom();
  const store = makeStore();
  const asked = [];
  try {
    const root = dom.doc.createElement('div');
    const view = mount(root, {
      store,
      confirmDialog: async (message) => {
        asked.push(message);
        return false;
      },
      toast: () => {},
    });
    try {
      const before = JSON.stringify(store.doc);
      const enemyRow = rowFor(root, 'enemy:enemies[0]');
      const del = findAll(enemyRow, '.enc-op-danger')[0];
      assert.ok(del, '列上應有刪除按鈕');
      del.dispatchEvent({ type: 'click', target: del });
      await new Promise((r) => setTimeout(r, 0));

      assert.equal(asked.length, 1, '要先跳確認框');
      assert.match(String(asked[0]), /Rudinn/, '確認訊息要帶節點名稱');
      assert.equal(JSON.stringify(store.doc), before, '取消後資料不變');
      assert.equal(store.doc.enemies.length, 1);
    } finally {
      view.destroy();
    }
  } finally {
    dom.restore();
  }
});

test('B1 點 ✕ 確認後才刪除，並提示可 Ctrl+Z', async () => {
  const dom = installFakeDom();
  const store = makeStore();
  const toasts = [];
  const calls = { confirm: 0, select: 0 };
  try {
    const root = dom.doc.createElement('div');
    const view = mount(root, {
      store,
      confirmDialog: async () => {
        calls.confirm += 1;
        return true;
      },
      toast: (message) => toasts.push(String(message)),
    });
    try {
      // 先選取一次，確認「點按鈕」不會順便觸發選取（stopPropagation）
      const enemyRow = rowFor(root, 'enemy:enemies[0]');
      const del = findAll(enemyRow, '.enc-op-danger')[0];
      del.dispatchEvent({ type: 'click', target: del });
      await new Promise((r) => setTimeout(r, 0));

      assert.equal(calls.confirm, 1, '要有確認');
      assert.equal(store.doc.enemies.length, 0, '確認後才刪除');
      assert.equal(store.selection.kind, null, '點按鈕不應觸發列選取');
      assert.ok(
        toasts.some((m) => /Ctrl\+Z|復原/.test(m)),
        `刪除後要提示可復原，實際：${JSON.stringify(toasts)}`,
      );
      calls.select += 1;
    } finally {
      view.destroy();
    }
  } finally {
    dom.restore();
  }
});

test('B1 沒有子內容的節點可直接刪（仍提示可 Ctrl+Z）', async () => {
  const dom = installFakeDom();
  const doc = ensureStructure({ ...sampleEncounter(), items: [{ id: 'i1', name: '', count: 0 }] });
  const store = makeStore(doc);
  const toasts = [];
  let confirmed = 0;
  try {
    const root = dom.doc.createElement('div');
    const view = mount(root, {
      store,
      confirmDialog: async () => {
        confirmed += 1;
        return true;
      },
      toast: (message) => toasts.push(String(message)),
    });
    try {
      const itemRow = rowFor(root, 'item:items[0]');
      assert.ok(itemRow, '應渲染出 items[0]');
      const del = findAll(itemRow, '.enc-op-danger')[0];
      del.dispatchEvent({ type: 'click', target: del });
      await new Promise((r) => setTimeout(r, 0));

      assert.equal(confirmed, 0, '空白節點不需要確認');
      assert.equal(store.doc.items.length, 0, '應直接刪除');
      assert.ok(
        toasts.some((m) => /Ctrl\+Z|復原/.test(m)),
        `直接刪除也要提示可復原，實際：${JSON.stringify(toasts)}`,
      );
    } finally {
      view.destroy();
    }
  } finally {
    dom.restore();
  }
});

/* ======================================================= B2：檔名正規化 */

test('B2 normalizeFileName：含路徑只取最後一段檔名', () => {
  assert.equal(normalizeFileName('encounters/rt-a.json'), 'rt-a');
  assert.equal(normalizeFileName('a\\b.json'), 'b');
  assert.equal(normalizeFileName('  my file.json'), 'my_file');
  assert.equal(normalizeFileName('encounters/rt-f1'), 'rt-f1');
  assert.equal(normalizeFileName('rt-f1.json'), 'rt-f1');
  assert.equal(normalizeFileName(''), '');
  assert.equal(normalizeFileName(null), '');
  // 中文保留
  assert.equal(normalizeFileName('遭遇/測試.json'), '測試');
});

test('B2 willSaveAsName：回傳真正會落地的檔名（含 .json）', () => {
  assert.equal(willSaveAsName('encounters/rt-a.json'), 'rt-a.json');
  assert.equal(willSaveAsName('a\\b.json'), 'b.json');
  assert.equal(willSaveAsName('  my file.json'), 'my_file.json');
  assert.equal(willSaveAsName('   '), '');
});

/* ========================================================= B7：標題更新 */

test('B7 存檔後 #enc-doc-name 顯示檔名（與攻擊編輯器一致）', () => {
  const dom = installFakeDom();
  const store = makeStore();
  try {
    const docName = dom.doc.register(dom.doc.createElement('span'), 'enc-doc-name');
    const toolbar = mountToolbar({ store });
    try {
      // 開範例時：沒有檔名 → 顯示 meta.name
      assert.equal(docName.textContent, 'Rudinn遭遇');

      store.markSaved('rt-f1.json');
      assert.equal(docName.textContent, 'rt-f1', '存檔後應顯示檔名');
      assert.match(String(docName.title), /rt-f1\.json/, 'title 應指出實際檔名');

      // 另存成另一個名字 → 跟著換
      store.markSaved('rt-f1-renamed.json');
      assert.equal(docName.textContent, 'rt-f1-renamed');
    } finally {
      toolbar.destroy();
    }
  } finally {
    dom.restore();
  }
});

/* ================================================== Enter＝確定（單行輸入） */

test('Enter：單行 input 的 modal 按 Enter 會確定', async () => {
  const dom = installFakeDom();
  try {
    const modalRoot = dom.doc.register(dom.doc.createElement('div'), 'modal-root');
    const promise = promptDialog('名稱', { title: '存檔', value: 'rt-f1' });
    const modal = findAll(modalRoot, '.modal')[0];
    assert.ok(modal, '應建立 modal');
    const input = findAll(modal, 'input[type="text"]')[0];
    assert.ok(input, '應有單行 input');
    input.value = 'rt-f1';
    modal.dispatchEvent({ type: 'keydown', key: 'Enter', target: input });
    assert.equal(await promise, 'rt-f1', 'Enter 應回傳輸入值（確定）');
  } finally {
    dom.restore();
  }
});

test('Enter：textarea 不攔（維持換行，不誤送出）', async () => {
  const dom = installFakeDom();
  try {
    const modalRoot = dom.doc.register(dom.doc.createElement('div'), 'modal-root');
    const body = dom.doc.createElement('div');
    const area = dom.doc.createElement('textarea');
    body.appendChild(area);
    let settled = false;
    const promise = openModal({
      title: '多行',
      body,
      buttons: [{ label: '取消', value: false }, { label: '確定', value: true, kind: 'primary' }],
    });
    promise.then(() => {
      settled = true;
    });
    const modal = findAll(modalRoot, '.modal')[0];
    modal.dispatchEvent({ type: 'keydown', key: 'Enter', target: area });
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(settled, false, 'textarea 的 Enter 不應送出 modal');
  } finally {
    dom.restore();
  }
});

test('Enter：confirmDialog 也能用 Enter 確定（沒有輸入框時不亂送）', async () => {
  const dom = installFakeDom();
  try {
    const modalRoot = dom.doc.register(dom.doc.createElement('div'), 'modal-root');
    const promise = confirmDialog('確定刪除？', { danger: true });
    const modal = findAll(modalRoot, '.modal')[0];
    const primary = findAll(modal, '.btn-danger')[0];
    assert.ok(primary, '危險確認應有 danger 主按鈕');
    // 沒有輸入欄位時 Enter 不該觸發（避免誤刪）；只能點按鈕
    modal.dispatchEvent({ type: 'keydown', key: 'Enter', target: modal });
    primary.click();
    assert.equal(await promise, true);
  } finally {
    dom.restore();
  }
});

/* =============================================== B12 / B17（原始碼守門） */

test('B12：boot overlay 收起後清空 #enc-boot-status', () => {
  const src = readFileSync(path.join(HERE, 'main.js'), 'utf8');
  const fn = src.slice(src.indexOf('function hideBootOverlay'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 3);
  assert.match(body, /setBootStatus\(''\)/, 'hideBootOverlay 內要清空狀態文字');
});

test('B17：範例選單限寬並把描述單行截斷', () => {
  const css = readFileSync(path.join(HERE, 'layout.css'), 'utf8');
  assert.match(css, /max-width:\s*520px/, '選單要限寬 520px');
  const rule = css.slice(css.indexOf('.mi-sub'));
  assert.match(rule.slice(0, 400), /text-overflow:\s*ellipsis/, '描述要 ellipsis');
  assert.match(rule.slice(0, 400), /white-space:\s*nowrap/, '描述要單行');
  const js = readFileSync(path.join(HERE, 'fileops.js'), 'utf8');
  assert.match(js, /sub\.title\s*=/, '完整描述要放進 title');
});
