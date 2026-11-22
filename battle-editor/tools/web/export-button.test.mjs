/**
 * tools/web/export-button.test.mjs — 匯出按鈕（V2-09）純邏輯＋DOM 黏著測試
 *
 * 執行：cd battle-editor && node tools/web/export-button.test.mjs
 *       （或 node --test tools/web/export-button.test.mjs）
 *
 * 範圍（不開瀏覽器；用假的 document / URL / fetch）：
 *   1) buildExportRequest：name 去空白、kind 白名單、lang、空目標丟錯
 *   2) filenameFromDisposition：filename* / filename / fallback / 壞編碼
 *   3) errorMessageFromPayload：JSON error → 一行文字
 *   4) mountExportButton：建立按鈕、成功時 fetch 內容正確並觸發 <a download>
 *   5) 伺服器 404 / 沒選作品：只顯示錯誤、不下載
 *   6) destroy 移除按鈕；en 語系文字；setLang 即時換語系（V2-FIX1）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  EXPORT_ENDPOINT,
  EXPORT_LABELS,
  doneStatusText,
  buildExportRequest,
  filenameFromDisposition,
  errorMessageFromPayload,
  downloadBlob,
  mountExportButton,
} from './export-button.js';

/* ---------------------------------------------------------- 假瀏覽器 */

class FakeClassList {
  constructor() { this.set = new Set(); }
  add(name) { this.set.add(name); }
  remove(name) { this.set.delete(name); }
  contains(name) { return this.set.has(name); }
  toggle(name, force) {
    const on = force === undefined ? !this.set.has(name) : Boolean(force);
    if (on) this.set.add(name); else this.set.delete(name);
    return on;
  }
}

class FakeElement {
  constructor(tagName) {
    this.tagName = String(tagName || '').toUpperCase();
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.className = '';
    this.classList = new FakeClassList();
    this.textContent = '';
    this.attributes = {};
    this.listeners = {};
    this.clickCount = 0;
  }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  removeChild(child) {
    const index = this.children.indexOf(child);
    if (index >= 0) this.children.splice(index, 1);
    child.parentNode = null;
    return child;
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  removeEventListener(type, fn) {
    const list = this.listeners[type] || [];
    const index = list.indexOf(fn);
    if (index >= 0) list.splice(index, 1);
  }
  dispatch(type) {
    for (const fn of [...(this.listeners[type] || [])]) fn({ type, target: this });
  }
  click() {
    this.clickCount += 1;
    this.dispatch('click');
  }
}

class FakeDocument {
  constructor() {
    this.body = new FakeElement('body');
    this.head = new FakeElement('head');
    this.documentElement = new FakeElement('html');
    this.created = [];
  }
  createElement(tag) {
    const element = new FakeElement(tag);
    this.created.push(element);
    return element;
  }
}

class FakeURL {
  constructor() { this.created = []; this.revoked = []; this.counter = 0; }
  createObjectURL(blob) {
    this.counter += 1;
    const href = `blob:fake/${this.counter}`;
    this.created.push({ href, blob });
    return href;
  }
  revokeObjectURL(href) { this.revoked.push(href); }
}

function fakeResponse({ ok = true, status = 200, body = 'html', headers = {}, jsonError = null } = {}) {
  return {
    ok,
    status,
    headers: { get: (name) => headers[String(name).toLowerCase()] || null },
    blob: async () => ({ size: body.length, text: async () => body }),
    json: async () => {
      if (jsonError) return jsonError;
      return {};
    },
  };
}

function wait(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ---------------------------------------------------------- 純函式 */

describe('buildExportRequest', () => {
  test('預設 zh、name 去空白、未指定 kind 就不送', () => {
    const { body, request } = buildExportRequest({ name: '  spade-rain  ' });
    assert.deepEqual(body, { name: 'spade-rain', lang: 'zh' });
    assert.equal(request.method, 'POST');
    assert.equal(request.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(request.body), body);
  });

  test('kind 白名單與 en', () => {
    assert.equal(buildExportRequest({ name: 'rudinn', kind: 'encounter' }, 'en').body.kind, 'encounter');
    const body = buildExportRequest({ name: 'x', kind: 'bogus' }, 'en').body;
    assert.equal('kind' in body, false);
    assert.equal(body.lang, 'en');
  });

  test('空目標丟 no_target', () => {
    for (const target of [null, {}, { name: '   ' }]) {
      assert.throws(() => buildExportRequest(target), (err) => err.code === 'no_target');
    }
  });
});

describe('filenameFromDisposition', () => {
  test('filename*（UTF-8）優先', () => {
    const header = 'attachment; filename="rudinn.html"; filename*=UTF-8\'\'%E9%81%AD%E9%81%87.html';
    assert.equal(filenameFromDisposition(header, 'fallback.html'), '遭遇.html');
  });

  test('一般 filename 與 fallback', () => {
    assert.equal(filenameFromDisposition('attachment; filename="a.html"'), 'a.html');
    assert.equal(filenameFromDisposition('', 'b.html'), 'b.html');
    assert.equal(filenameFromDisposition(null, 'c.html'), 'c.html');
  });

  test('filename* 壞編碼時退回 filename', () => {
    const header = 'attachment; filename="ok.html"; filename*=UTF-8\'\'%E0%A4%A';
    assert.equal(filenameFromDisposition(header, 'x.html'), 'ok.html');
  });
});

describe('errorMessageFromPayload', () => {
  test('JSON error / message / 字串 / 狀態碼', () => {
    assert.equal(errorMessageFromPayload({ error: '找不到遭遇或攻擊' }, 404), '找不到遭遇或攻擊');
    assert.equal(errorMessageFromPayload({ message: '參數錯' }, 400), '參數錯');
    assert.equal(errorMessageFromPayload('純文字', 500), '純文字');
    assert.equal(errorMessageFromPayload(null, 502), 'HTTP 502');
  });
});

/* ---------------------------------------------------------- DOM 黏著 */

describe('mountExportButton', () => {
  test('按鈕成功匯出：POST 內容、下載檔名、狀態文字', async () => {
    const doc = new FakeDocument();
    const url = new FakeURL();
    const container = doc.createElement('div');
    const calls = [];
    const fetchImpl = async (endpoint, request) => {
      calls.push({ endpoint, request });
      return fakeResponse({
        headers: { 'content-disposition': 'attachment; filename="spade-rain.html"' },
      });
    };
    const mounted = mountExportButton({
      container,
      getTarget: () => ({ name: 'spade-rain', kind: 'attack' }),
      lang: 'zh',
      fetchImpl,
      documentRef: doc,
      urlRef: url,
    });

    assert.equal(container.children.length, 1);
    assert.equal(mounted.button.textContent, EXPORT_LABELS.zh.idle);
    assert.equal(calls.length, 0);

    mounted.button.dispatch('click');
    await wait(5);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].endpoint, EXPORT_ENDPOINT);
    assert.equal(calls[0].request.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0].request.body), {
      name: 'spade-rain',
      kind: 'attack',
      lang: 'zh',
    });
    assert.equal(url.created.length, 1);
    const anchor = doc.created.find((element) => element.tagName === 'A' && element.download);
    assert.ok(anchor, '應該建立 <a download>');
    assert.equal(anchor.download, 'spade-rain.html');
    assert.equal(anchor.clickCount, 1);
    // REALTEST-2 V10：狀態列出實際檔名與大小，並可由 lastExport() 取回
    assert.equal(mounted.status.textContent, doneStatusText('zh', 'spade-rain.html', 4));
    assert.ok(mounted.status.textContent.includes('spade-rain.html'));
    assert.equal(mounted.lastExport().filename, 'spade-rain.html');
    assert.equal(mounted.lastExport().bytes, 4);
    assert.equal(mounted.isBusy(), false);
    assert.equal(mounted.button.disabled, false);
  });

  test('伺服器 404：顯示錯誤、不下載', async () => {
    const doc = new FakeDocument();
    const url = new FakeURL();
    const container = doc.createElement('div');
    const mounted = mountExportButton({
      container,
      getTarget: () => ({ name: 'ghost' }),
      fetchImpl: async () =>
        fakeResponse({ ok: false, status: 404, jsonError: { error: '找不到遭遇或攻擊：ghost' } }),
      documentRef: doc,
      urlRef: url,
    });

    mounted.button.dispatch('click');
    await wait(5);

    assert.equal(url.created.length, 0);
    assert.equal(mounted.status.textContent, '找不到遭遇或攻擊：ghost');
    assert.equal(mounted.status.classList.contains('is-error'), true);
  });

  test('沒選作品：顯示錯誤、完全不 fetch', async () => {
    const doc = new FakeDocument();
    const container = doc.createElement('div');
    let fetchCalls = 0;
    const mounted = mountExportButton({
      container,
      getTarget: () => null,
      fetchImpl: async () => { fetchCalls += 1; return fakeResponse(); },
      documentRef: doc,
      urlRef: new FakeURL(),
    });

    mounted.button.dispatch('click');
    await wait(5);

    assert.equal(fetchCalls, 0);
    assert.equal(mounted.status.classList.contains('is-error'), true);
    assert.ok(mounted.status.textContent.length > 0);
  });

  test('en 語系文字；destroy 移除按鈕', () => {
    const doc = new FakeDocument();
    const container = doc.createElement('div');
    const mounted = mountExportButton({
      container,
      getTarget: () => ({ name: 'x' }),
      lang: 'en',
      fetchImpl: async () => fakeResponse(),
      documentRef: doc,
      urlRef: new FakeURL(),
    });

    assert.equal(mounted.button.textContent, EXPORT_LABELS.en.idle);
    assert.equal(container.children.length, 1);
    mounted.destroy();
    assert.equal(container.children.length, 0);
  });

  test('setLang：即時換文字/提示（不用 destroy 重建），後續請求帶新語系', async () => {
    const doc = new FakeDocument();
    const container = doc.createElement('div');
    const calls = [];
    const mounted = mountExportButton({
      container,
      getTarget: () => ({ name: 'spade-rain', kind: 'attack' }),
      lang: 'zh',
      fetchImpl: async (endpoint, request) => {
        calls.push({ endpoint, request });
        return fakeResponse();
      },
      documentRef: doc,
      urlRef: new FakeURL(),
    });

    assert.equal(typeof mounted.setLang, 'function');
    assert.equal(mounted.setLang('en'), true);
    assert.equal(mounted.button.textContent, EXPORT_LABELS.en.idle);
    assert.equal(mounted.button.title, 'Download a single playable HTML file');
    assert.equal(mounted.setLang('en'), false, '同一語系不重複變更');
    assert.equal(container.children.length, 1, '不應重建按鈕');

    mounted.button.dispatch('click');
    await wait(5);
    assert.equal(calls.length, 1);
    assert.deepEqual(JSON.parse(calls[0].request.body), {
      name: 'spade-rain',
      kind: 'attack',
      lang: 'en',
    });
    assert.equal(mounted.status.textContent, doneStatusText('en', 'spade-rain.html', 4));
    assert.match(mounted.status.textContent, /^Downloaded: spade-rain\.html \(1 KB\)$/);

    // 非法語系退回 zh；已下載的狀態文字跟著換
    assert.equal(mounted.setLang('bogus'), true);
    assert.equal(mounted.button.textContent, EXPORT_LABELS.zh.idle);
    assert.equal(mounted.button.title, '下載單一可遊玩 HTML 檔');
    assert.equal(mounted.status.textContent, doneStatusText('zh', 'spade-rain.html', 4));
    mounted.destroy();
    assert.equal(container.children.length, 0);
  });
});

describe('downloadBlob', () => {
  test('建立、點擊、移除 <a>，並延後釋放 URL', async () => {
    const doc = new FakeDocument();
    const url = new FakeURL();
    const href = downloadBlob({ size: 3 }, 'x.html', { documentRef: doc, urlRef: url });
    assert.equal(href, 'blob:fake/1');
    const anchor = doc.created.find((element) => element.tagName === 'A');
    assert.equal(anchor.download, 'x.html');
    assert.equal(anchor.clickCount, 1);
    assert.equal(anchor.parentNode, null);
    await wait(5);
    assert.equal(url.revoked.length, 0, '30 秒後才釋放，測試期間不應釋放');
  });
});
