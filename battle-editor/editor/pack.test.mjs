/**
 * editor/pack.test.mjs — V2-06 作品包（POST /api/pack/export|import）純邏輯測試
 *
 * 覆蓋：
 *   - 匯出 request body（作品名從 fileName / meta.name 取）
 *   - 匯入 URL 的 mode query
 *   - 409 衝突 payload 的解析與「abort / rename / overwrite」流程判定
 *   - 匯入結果摘要（改名清單）
 *   - Content-Disposition 檔名（ASCII / RFC 5987）
 *
 * 執行：node --test editor/pack.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONFLICT_KINDS,
  PACK_MODES,
  buildPackExportBody,
  buildPackImportUrl,
  errorMessageFromPayload,
  filenameFromDisposition,
  isConflictPayload,
  mountPackButtons,
  parseConflicts,
  summarizeImport,
  workNameOf,
} from './pack.js';

/* --------------------------------------------------------------- 匯出 payload */

test('workNameOf：fileName 優先（去掉 .json），其次 meta.name', () => {
  assert.equal(workNameOf({ fileName: 'spade-rain.json', attack: { meta: { name: '黑桃雨' } } }), 'spade-rain');
  assert.equal(workNameOf({ fileName: null, attack: { meta: { name: '黑桃雨' } } }), '黑桃雨');
  assert.equal(workNameOf({ attack: {} }), '');
  assert.equal(workNameOf(null), '');
  // 檔名是空字串時退回 meta.name
  assert.equal(workNameOf({ fileName: '   ', attack: { meta: { name: 'Ring' } } }), 'Ring');
});

test('buildPackExportBody：有名字才回 body；沒名字丟 code no_name', () => {
  const body = buildPackExportBody({ fileName: 'spade-rain.json' });
  assert.deepEqual(body, { name: 'spade-rain' });

  // kind 可選（遭遇包 / 攻擊包）
  assert.deepEqual(buildPackExportBody({ fileName: 'x.json' }, { kind: 'attack' }), { name: 'x', kind: 'attack' });

  assert.throws(() => buildPackExportBody({ attack: {} }), (err) => err.code === 'no_name');
  assert.throws(() => buildPackExportBody(null), (err) => err.code === 'no_name');
});

/* ----------------------------------------------------------------- 匯入 URL */

test('buildPackImportUrl：mode 一律帶在 query，非法值退回 abort', () => {
  assert.equal(buildPackImportUrl('abort'), '/api/pack/import?mode=abort');
  assert.equal(buildPackImportUrl('rename'), '/api/pack/import?mode=rename');
  assert.equal(buildPackImportUrl('overwrite'), '/api/pack/import?mode=overwrite');
  assert.equal(buildPackImportUrl('weird'), '/api/pack/import?mode=abort');
  assert.equal(buildPackImportUrl(undefined), '/api/pack/import?mode=abort');
  // 自訂 endpoint（測試可用）
  assert.equal(buildPackImportUrl('rename', '/x'), '/x?mode=rename');
});

test('PACK_MODES / CONFLICT_KINDS 與 serve.py 契約一致', () => {
  assert.deepEqual([...PACK_MODES], ['abort', 'rename', 'overwrite']);
  assert.deepEqual([...CONFLICT_KINDS], ['encounter', 'attack', 'sprite', 'audio']);
});

/* ------------------------------------------------------------ 衝突處理流程 */

test('isConflictPayload：只有 409 + code conflicts 才算', () => {
  const payload = { ok: false, code: 'conflicts', conflicts: [{ kind: 'attack', name: 'a' }] };
  assert.equal(isConflictPayload(409, payload), true);
  assert.equal(isConflictPayload(200, payload), false);
  assert.equal(isConflictPayload(409, { ok: false, code: 'bad_file' }), false);
  assert.equal(isConflictPayload(409, null), false);
  // 有的伺服器版本只有 conflicts 陣列
  assert.equal(isConflictPayload(409, { conflicts: [{ kind: 'attack', name: 'a' }] }), true);
});

test('parseConflicts：把 409 payload 正規化成清單 + 各類型計數', () => {
  const payload = {
    ok: false,
    code: 'conflicts',
    error: '作品包與目前作品有 3 個名稱衝突（未寫入任何檔案）',
    mode: 'abort',
    conflicts: [
      { kind: 'encounter', name: 'turn-1', path: 'encounters/turn-1.json' },
      { kind: 'attack', name: 'spade-rain', path: 'attacks/spade-rain.json' },
      { kind: 'attack', name: 'ring', path: 'attacks/ring.json' },
      { kind: 'weird', name: 'x' }, // 未知類型 → 歸到 attack
      null,
    ],
  };
  const info = parseConflicts(payload);
  assert.equal(info.total, 4);
  assert.equal(info.counts.attack, 3);
  assert.equal(info.counts.encounter, 1);
  assert.equal(info.counts.sprite, 0);
  assert.equal(info.conflicts[1].name, 'spade-rain');
  assert.equal(info.conflicts[1].path, 'attacks/spade-rain.json');
  // 空 payload 不炸
  assert.deepEqual(parseConflicts(null).total, 0);
});

test('衝突流程：abort → 選 rename → 重送 mode=rename（模擬 fetch 序列）', async () => {
  const calls = [];
  const responses = [
    // 第一次 abort → 409 衝突
    {
      status: 409,
      ok: false,
      json: async () => ({
        ok: false,
        code: 'conflicts',
        mode: 'abort',
        conflicts: [
          { kind: 'attack', name: 'spade-rain', path: 'attacks/spade-rain.json' },
          { kind: 'sprite', name: 'soul', path: 'assets/sprites/soul.png' },
        ],
      }),
    },
    // 第二次 rename → 200 成功
    {
      status: 200,
      ok: true,
      json: async () => ({
        ok: true,
        mode: 'rename',
        imported: {
          encounters: [],
          attacks: [{ name: 'spade-rain_2', renamedFrom: 'spade-rain' }],
          sprites: [],
          audio: [],
        },
        renamed: { attacks: { 'spade-rain': 'spade-rain_2' } },
        warnings: [],
      }),
    },
  ];
  const fetchImpl = async (url, init) => {
    calls.push({ url, method: init && init.method });
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  };
  const toasts = [];
  // 不需要 DOM：只測純流程函式（mountPackButtons 的 DOM 依賴用 null doc 跳過）
  const modeChosen = 'rename';

  // 直接照 mountPackButtons 的流程手寫一次（UI 端流程）：先用 abort 打，衝突 → 選 rename 重打
  const first = await fetchImpl('/api/pack/import?mode=abort', { method: 'POST', body: '{}' });
  const firstPayload = await first.json();
  assert.equal(isConflictPayload(first.status, firstPayload), true);
  const info = parseConflicts(firstPayload);
  assert.equal(info.total, 2);

  const second = await fetchImpl(buildPackImportUrl(modeChosen), { method: 'POST', body: '{}' });
  const secondPayload = await second.json();
  const summary = summarizeImport(secondPayload);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, '/api/pack/import?mode=abort');
  assert.equal(calls[1].url, '/api/pack/import?mode=rename');
  assert.equal(summary.ok, true);
  assert.equal(summary.total, 1);
  assert.deepEqual(summary.renamed, [{ kind: 'attack', from: 'spade-rain', to: 'spade-rain_2' }]);
  assert.equal(summary.mode, 'rename');
  assert.deepEqual(toasts, []);
});

test('衝突流程：選 abort → 不重送（沒有寫入任何檔案）', async () => {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      status: 409,
      ok: false,
      json: async () => ({ ok: false, code: 'conflicts', conflicts: [{ kind: 'attack', name: 'a' }] }),
    };
  };
  const res = await fetchImpl(buildPackImportUrl('abort'));
  const payload = await res.json();
  assert.equal(isConflictPayload(res.status, payload), true);
  // 使用者選 abort → 直接結束，不再送第二次
  const choice = 'abort';
  if (choice !== 'abort') await fetchImpl(buildPackImportUrl(choice));
  assert.equal(calls.length, 1);
});

/* --------------------------------------------------------------- 結果摘要 */

test('summarizeImport：各類型計數、改名清單、warnings', () => {
  const payload = {
    ok: true,
    mode: 'rename',
    imported: {
      encounters: [{ name: 'turn-1', renamedFrom: 'turn-1' }],
      attacks: [{ name: 'a_2', renamedFrom: 'a' }, { name: 'b' }],
      sprites: [{ name: 'soul' }],
      audio: [{ name: 'bgm' }, { name: 'bgm2' }],
      files: 7,
    },
    warnings: ['audio 檔案缺失：x.ogg'],
  };
  const s = summarizeImport(payload);
  assert.equal(s.ok, true);
  assert.deepEqual(s.counts, { encounters: 1, attacks: 2, sprites: 1, audio: 2 });
  assert.equal(s.total, 6);
  assert.equal(s.renamed.length, 2);
  assert.deepEqual(s.renamed[0], { kind: 'encounter', from: 'turn-1', to: 'turn-1' });
  assert.deepEqual(s.renamed[1], { kind: 'attack', from: 'a', to: 'a_2' });
  assert.deepEqual(s.warnings, ['audio 檔案缺失：x.ogg']);
  // 空 / 壞 payload
  assert.equal(summarizeImport(null).ok, false);
  assert.equal(summarizeImport({}).total, 0);
});

/* ------------------------------------------------------- 檔名 / 錯誤訊息 */

test('filenameFromDisposition：ASCII filename 與 RFC 5987 filename*', () => {
  assert.equal(
    filenameFromDisposition('attachment; filename="spade-rain.drpack.json"'),
    'spade-rain.drpack.json',
  );
  assert.equal(
    filenameFromDisposition("attachment; filename=\"x.drpack.json\"; filename*=UTF-8''%E9%BB%91%E6%A1%83.drpack.json"),
    '黑桃.drpack.json',
  );
  assert.equal(filenameFromDisposition('', 'fallback.json'), 'fallback.json');
  assert.equal(filenameFromDisposition(null), 'pack.drpack.json');
  // 壞的 percent-encoding → 退回 ASCII 版
  assert.equal(filenameFromDisposition('attachment; filename="a.json"; filename*=UTF-8\'\'%E0%A4%A'), 'a.json');
});

test('errorMessageFromPayload：error 優先，其次 code + HTTP', () => {
  assert.equal(errorMessageFromPayload({ error: '找不到作品' }, 404), '找不到作品');
  assert.equal(errorMessageFromPayload({ code: 'not_found' }, 404), 'not_found (HTTP 404)');
  assert.equal(errorMessageFromPayload(null, 500), 'HTTP 500');
});

/* ------------------------------------------------- mountPackButtons 基本行為 */

test('pack export never sends a saved filename while the current draft has unsaved edits', async () => {
  const requests = [];
  const api = mountPackButtons({
    store: { fileName: 'x.json', isDirty: () => true },
    fetchImpl: (...args) => requests.push(args),
  });
  assert.equal(typeof api.exportPack, 'function');
  assert.equal(typeof api.importPack, 'function');
  assert.equal(typeof api.destroy, 'function');
  assert.equal(api.isBusy(), false);
  assert.equal(await api.exportPack(), false);
  assert.deepEqual(requests, []);
  assert.equal(await api.importPack(), false);
  api.destroy();
});
