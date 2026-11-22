/**
 * 即時同步（editor/live-sync.js）純函式測試。
 *   node --test editor/live-sync.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  normalizeEtag,
  etagEquals,
  buildSaveHeaders,
  decideRemoteAction,
  parseConflict,
  resolveMergeChoice,
  summarizeDiff,
  readClientId,
  createSyncClient,
} from './live-sync.js';
import { createStore } from './store.js';

/* ------------------------------------------------------------ ETag */

test('normalizeEtag 去掉 W/ 與引號', () => {
  assert.equal(normalizeEtag('W/"abc123"'), 'abc123');
  assert.equal(normalizeEtag('"abc123"'), 'abc123');
  assert.equal(normalizeEtag('abc123'), 'abc123');
  assert.equal(normalizeEtag(''), '');
  assert.equal(normalizeEtag(null), '');
  assert.equal(normalizeEtag(undefined), '');
});

test('etagEquals 有空值時不相等', () => {
  assert.equal(etagEquals('"abc"', 'abc'), true);
  assert.equal(etagEquals('W/"abc"', 'abc'), true);
  assert.equal(etagEquals('abc', 'abd'), false);
  assert.equal(etagEquals('', ''), false);
  assert.equal(etagEquals(null, null), false);
});

test('buildSaveHeaders：有 ETag 才帶 If-Match，永遠帶 X-Client', () => {
  const withEtag = buildSaveHeaders({ etag: 'W/"aa11"', clientId: 'c1' });
  assert.equal(withEtag['If-Match'], 'aa11');
  assert.equal(withEtag['X-Client'], 'c1');
  assert.match(withEtag['Content-Type'], /application\/json/);
  const without = buildSaveHeaders({ etag: '', clientId: 'c2' });
  assert.equal('If-Match' in without, false);
  assert.equal(without['X-Client'], 'c2');
});

/* ------------------------------------------------------ 遠端事件決策 */

const base = {
  kind: 'attack',
  selfKind: 'attack',
  name: 'spade-rain',
  fileName: 'spade-rain',
  selfId: 'cA',
  by: 'agent',
  remoteEtag: 'e2',
  baseEtag: 'e1',
  dirty: false,
};

test('decideRemoteAction：沒未存修改 → reload', () => {
  assert.equal(decideRemoteAction({ ...base }), 'reload');
});

test('decideRemoteAction：有未存修改 → conflict', () => {
  assert.equal(decideRemoteAction({ ...base, dirty: true }), 'conflict');
});

test('decideRemoteAction：同一個 ETag → ignore', () => {
  assert.equal(decideRemoteAction({ ...base, remoteEtag: '"e1"', baseEtag: 'e1' }), 'ignore');
});

test('decideRemoteAction：自己的事件 / 別的檔案 / 別的類型 → ignore', () => {
  assert.equal(decideRemoteAction({ ...base, by: 'cA' }), 'ignore');
  assert.equal(decideRemoteAction({ ...base, name: 'other', fileName: 'spade-rain' }), 'ignore');
  assert.equal(decideRemoteAction({ ...base, kind: 'encounter' }), 'ignore');
  assert.equal(decideRemoteAction({ ...base, fileName: null }), 'ignore');
});

test('decideRemoteAction：沒有 baseEtag（剛開檔）時仍會 reload', () => {
  assert.equal(decideRemoteAction({ ...base, baseEtag: '' }), 'reload');
});

/* ------------------------------------------------------------ 409 */

test('parseConflict：非 409 回 null', () => {
  assert.equal(parseConflict(200, { ok: true }), null);
  assert.equal(parseConflict(500, {}), null);
});

test('parseConflict：解析 409 body（etag + current）', () => {
  const res = parseConflict(409, { conflict: true, etag: '"zz"', current: { format: 'x' } }, '');
  assert.deepEqual(res, { conflict: true, etag: 'zz', current: { format: 'x' } });
});

test('parseConflict：只有 ETag 標頭時也能解析', () => {
  const res = parseConflict(409, {}, '"hdr"');
  assert.equal(res.conflict, true);
  assert.equal(res.etag, 'hdr');
  assert.equal(res.current, null);
});

/* ------------------------------------------------------------ 合併決策 */

test('resolveMergeChoice', () => {
  const mine = { a: 1 };
  const theirs = { a: 2 };
  assert.deepEqual(resolveMergeChoice('theirs', { mine, theirs }), { apply: 'theirs', doc: theirs });
  assert.deepEqual(resolveMergeChoice('mine', { mine, theirs }), { apply: 'mine', doc: mine });
  assert.deepEqual(resolveMergeChoice('cancel', { mine, theirs }), { apply: 'cancel', doc: null });
  assert.deepEqual(resolveMergeChoice(undefined, { mine, theirs }), { apply: 'cancel', doc: null });
});

/* ------------------------------------------------------------ 差異摘要 */

test('summarizeDiff：列出不同路徑', () => {
  const mine = { meta: { name: 'A' }, box: { x: 320, w: 150 }, timeline: [{ at: 0 }] };
  const theirs = { meta: { name: 'B' }, box: { x: 320, w: 200 }, timeline: [{ at: 0 }, { at: 30 }] };
  const diff = summarizeDiff(mine, theirs);
  const paths = diff.map((row) => row.path);
  assert.ok(paths.includes('meta.name'), paths.join(','));
  assert.ok(paths.includes('box.w'), paths.join(','));
  assert.ok(paths.includes('timeline[1]'), paths.join(','));
  assert.equal(diff.some((row) => row.path === 'box.x'), false);
});

test('summarizeDiff：型別改變時直接回報該路徑', () => {
  const diff = summarizeDiff({ a: 1 }, { a: 'one' });
  assert.deepEqual(diff, [{ path: 'a', mine: '1', theirs: 'one' }]);
});

test('summarizeDiff：相同文件回空陣列；上限生效', () => {
  assert.deepEqual(summarizeDiff({ a: 1 }, { a: 1 }), []);
  const big1 = {};
  const big2 = {};
  for (let i = 0; i < 100; i += 1) {
    big1[`k${i}`] = i;
    big2[`k${i}`] = i + 1;
  }
  const diff = summarizeDiff(big1, big2, 10);
  assert.equal(diff.length, 10);
});

/* ------------------------------------------------------------ clientId */

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
  };
}

test('readClientId：第一次產生、之後穩定', () => {
  const storage = fakeStorage();
  const a = readClientId(storage, 'k');
  const b = readClientId(storage, 'k');
  assert.equal(a, b);
  assert.match(a, /^c[0-9a-z]+$/);
  const other = readClientId(fakeStorage(), 'k');
  assert.notEqual(a, other);
});

/* ------------------------------------------------------- applyRemote */

function makeDoc(name = 'A') {
  return {
    format: 'dr-battle-attack/1',
    meta: { name, author: '' },
    box: { x: 320, y: 190, w: 144, h: 158, rotation: 0 },
    timeline: [],
  };
}

test('store.applyRemote：可復原、dirty=false、通知帶 remote', () => {
  const events = [];
  const store = createStore(makeDoc('A'), { storage: fakeStorage() });
  store.update((draft) => {
    draft.meta.name = 'B';
  });
  assert.equal(store.isDirty(), true);
  const unsubscribe = store.subscribe((_s, change) => events.push(change));

  const applied = store.applyRemote({ ...makeDoc('C') }, 'Agent 修改');
  assert.equal(applied, true);
  assert.equal(store.doc.meta.name, 'C');
  assert.equal(store.isDirty(), false);

  const remoteEvent = events.find((e) => e.remote);
  assert.ok(remoteEvent, '要有 remote 通知');
  assert.equal(remoteEvent.reset, true);
  assert.equal(remoteEvent.document, true);
  assert.equal(remoteEvent.label, 'Agent 修改');

  // 一筆可復原
  assert.ok(store.historySize().undo >= 2);
  store.undo();
  assert.equal(store.doc.meta.name, 'B');
  store.undo();
  assert.equal(store.doc.meta.name, 'A');
  unsubscribe();
});

test('store.applyRemote：內容相同時不推 undo、只清 dirty', () => {
  const store = createStore(makeDoc('A'), { storage: fakeStorage() });
  store.applyRemote(makeDoc('C'), 'Agent 修改');
  const before = store.historySize().undo;
  const applied = store.applyRemote(makeDoc('C'), '一樣的版本');
  assert.equal(applied, false);
  assert.equal(store.historySize().undo, before);
});

/* ------------------------------------------------------------ SSE 事件接線 */

test('Save As sends create-only for a different filename and keeps the original file revision on conflict', async () => {
  const calls = [];
  const client = createSyncClient({
    kind: 'encounter',
    getFileName: () => 'original.json',
    sessionStorage: fakeStorage(),
    fetchImpl: async (_url, { headers }) => {
      calls.push(headers);
      return { ok: false, status: 409, headers: { get: () => 'destination-etag' }, json: async () => ({ conflict: true }) };
    },
  });
  client.setEtag('source-etag');
  await client.save('other.json', makeDoc('copy'));
  assert.equal(calls[0]['If-None-Match'], '*');
  assert.equal(calls[0]['If-Match'], undefined);
  assert.equal(client.getEtag(), 'source-etag');
  await client.save('original.json', makeDoc('edit'));
  assert.equal(calls[1]['If-Match'], 'source-etag');
  assert.equal(calls[1]['If-None-Match'], undefined);
  client.destroy();
});

test('SSE：serve.py 用「具名事件」送 changed/deleted/focus，client 必須三種都監聽', async () => {
  const listeners = Object.create(null);
  class FakeEventSource {
    constructor(url) {
      this.url = url;
      this.closed = false;
    }
    addEventListener(type, fn) {
      (listeners[type] = listeners[type] || []).push(fn);
    }
    close() {
      this.closed = true;
    }
  }

  const applied = [];
  const store = {
    doc: makeDoc('A'),
    selection: null,
    isDirty: () => false,
    applyRemote(doc, label) {
      applied.push([doc.meta.name, label]);
      this.doc = doc;
    },
  };
  const fetchUrls = [];
  const fileEvents = [];
  let delayNextRead = false;
  let deliverRead;
  const fetchImpl = async (url) => {
    fetchUrls.push(url);
    if (url.startsWith('/api/editor/state')) {
      return { ok: true, status: 200, headers: { get: () => '' }, json: async () => ({ ok: true }) };
    }
    if (delayNextRead) {
      return new Promise((resolve) => { deliverRead = resolve; });
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => '"etag-2"' },
      json: async () => makeDoc('B'),
    };
  };
  const client = createSyncClient({
    kind: 'attack',
    store,
    getFileName: () => 'x.json',
    fetchImpl,
    EventSourceImpl: FakeEventSource,
    sessionStorage: fakeStorage(),
    onStatus: () => {},
    onMessage: () => {},
    onFocus: () => {},
    onFileEvent: (event) => fileEvents.push(event),
  });

  client.start();
  try {
    // serve.py 的 SSE 對 changed / deleted / focus 會加 `event: <type>`，
    // 只靠 'message' 收不到 → 必須有具名監聽。
    for (const type of ['changed', 'deleted', 'focus']) {
      assert.ok(listeners[type] && listeners[type].length, `要有 ${type} 具名事件監聽`);
    }
    assert.ok(listeners.message && listeners.message.length, '仍要保留 message 監聽（hello 等未具名事件）');

    // 具名 changed（別人寫的、etag 不同）→ 自動載入遠端版本
    const onChanged = listeners.changed[0];
    onChanged({ data: JSON.stringify({ type: 'changed', kind: 'encounter', name: 'x.json', etag: 'other', by: 'agent' }) });
    assert.equal(fetchUrls.some((url) => url.startsWith('/api/attacks/')), false, 'same name in another resource type must not reload');
    assert.equal(fileEvents[0].kind, 'encounter');
    await onChanged({ data: JSON.stringify({ type: 'changed', kind: 'attack', name: 'x.json', etag: 'etag-2', by: 'agent' }) });
    // dispatch 是非同步的（handleChanged 內會 fetch 遠端版本），等它完成
    for (let i = 0; i < 60 && applied.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(applied.length, 1, '具名 changed 應觸發 applyRemote');
    assert.equal(applied[0][0], 'B', '應套用遠端版本');
    assert.match(applied[0][1], /agent/i, 'label 應可辨識是 Agent 修改');

    // 自己（同 by）寫的不應重載
    const before = applied.length;
    await onChanged({ data: JSON.stringify({ type: 'changed', kind: 'attack', name: 'x.json', etag: 'etag-3', by: client.clientId }) });
    assert.equal(applied.length, before, '自己寫入的 changed 不應重載');

    delayNextRead = true;
    onChanged({ data: JSON.stringify({ type: 'changed', kind: 'attack', name: 'x.json', etag: 'etag-4', by: 'agent' }) });
    store.doc = makeDoc('local draft');
    store.isDirty = () => true;
    deliverRead({
      ok: true,
      headers: { get: () => '"etag-4"' },
      json: async () => makeDoc('remote revision'),
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.doc.meta.name, 'local draft', 'a reload already in flight must not replace newly edited text');
  } finally {
    client.destroy();
  }
});
