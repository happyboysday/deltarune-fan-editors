// editor/encounter/pack-toolbar.test.mjs  (V2-07)
//
// 工具列「作品包匯出／匯入＋可遊玩輸出」的純資料測試（不碰 DOM）：
//   檔名／請求內容、匯入 mode、回應解析、數量摘要、三語字串、來源接線。
//
// 執行：node --test editor/encounter/pack-toolbar.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  IMPORT_MODES,
  PACK_EXPORT_ENDPOINT,
  PACK_IMPORT_ENDPOINT,
  packNameFromFileName,
  importMode,
  buildImportUrl,
  buildPackExportBody,
  packDownloadName,
  importCounts,
  importRenamedCount,
  parseImportResponse,
} from './pack-toolbar.js';
import STRINGS, { LOCALE_IDS, findKeyMismatches } from '../locales/encounter-pack.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(join(HERE, rel), 'utf8');

const CJK = /[\u3400-\u9fff]/;

test('IMPORT_MODES 固定為 abort / rename / overwrite', () => {
  assert.deepEqual(IMPORT_MODES, ['abort', 'rename', 'overwrite']);
});

test('packNameFromFileName：去目錄、去 .json、容忍 null/空值', () => {
  assert.equal(packNameFromFileName('rudinn.json'), 'rudinn');
  assert.equal(packNameFromFileName('attacks/spade-rain.json'), 'spade-rain');
  assert.equal(packNameFromFileName('C:\\works\\x.json'), 'x');
  assert.equal(packNameFromFileName('a.b.json'), 'a.b');
  assert.equal(packNameFromFileName('noext'), 'noext');
  assert.equal(packNameFromFileName('.json'), '');
  assert.equal(packNameFromFileName(''), '');
  assert.equal(packNameFromFileName(null), '');
  assert.equal(packNameFromFileName(undefined), '');
  assert.equal(packNameFromFileName(42), '');
});

test('importMode：合法值原樣、其他退回 abort（與伺服器預設一致）', () => {
  for (const mode of IMPORT_MODES) assert.equal(importMode(mode), mode);
  for (const bogus of [null, undefined, '', 'RENAME', 'overwrite ', 1, {}]) {
    assert.equal(importMode(bogus), 'abort');
  }
});

test('buildImportUrl：mode 放 query，非法值退回 abort', () => {
  assert.equal(buildImportUrl('rename'), '/api/pack/import?mode=rename');
  assert.equal(buildImportUrl('overwrite', '/x'), '/x?mode=overwrite');
  assert.equal(buildImportUrl('bogus'), '/api/pack/import?mode=abort');
  assert.equal(buildImportUrl(null), '/api/pack/import?mode=abort');
});

test('buildPackExportBody：trim、預設 kind=encounter、空名稱回 null', () => {
  assert.deepEqual(buildPackExportBody('  rudinn  '), { kind: 'encounter', name: 'rudinn' });
  assert.deepEqual(buildPackExportBody('rudinn', 'attack'), { kind: 'attack', name: 'rudinn' });
  assert.equal(buildPackExportBody(''), null);
  assert.equal(buildPackExportBody('   '), null);
  assert.equal(buildPackExportBody(null), null);
  assert.equal(buildPackExportBody(undefined), null);
});

test('packDownloadName：優先 Content-Disposition，退回 <name>.drpack.json', () => {
  assert.equal(packDownloadName('attachment; filename="boss.drpack.json"', 'x'), 'boss.drpack.json');
  assert.equal(
    packDownloadName('attachment; filename="ignored"; filename*=UTF-8\'\'%E5%8C%85.drpack.json', 'x'),
    '包.drpack.json',
  );
  assert.equal(packDownloadName('', 'rudinn'), 'rudinn.drpack.json');
  assert.equal(packDownloadName(null, ''), 'encounter.drpack.json');
  assert.equal(packDownloadName(undefined, '  '), 'encounter.drpack.json');
});

test('importCounts：陣列長度、數字容忍、缺欄位為 0', () => {
  assert.deepEqual(
    importCounts({ encounters: [{ name: 'a' }], attacks: [{}, {}], sprites: ['s1'], audio: ['a1', 'a2'] }),
    { encounters: 1, attacks: 2, assets: 3 },
  );
  assert.deepEqual(importCounts({ encounters: 2, attacks: 1, sprites: 4, audio: 1 }), {
    encounters: 2,
    attacks: 1,
    assets: 5,
  });
  assert.deepEqual(importCounts({}), { encounters: 0, attacks: 0, assets: 0 });
  assert.deepEqual(importCounts(null), { encounters: 0, attacks: 0, assets: 0 });
});

test('importRenamedCount：renamedFrom 條目與 payload.renamed', () => {
  assert.equal(
    importRenamedCount({
      imported: {
        encounters: [{ name: 'a', renamedFrom: 'old' }],
        attacks: [{ name: 'b' }, { name: 'c', renamedFrom: 'old-c' }],
        sprites: ['s'],
      },
    }),
    2,
  );
  assert.equal(importRenamedCount({ imported: {}, renamed: 3 }), 3);
  // payload.renamed 只會放大計數，不會縮小已數到的條目
  assert.equal(importRenamedCount({ imported: { attacks: [{ renamedFrom: 'x' }, { renamedFrom: 'y' }] }, renamed: 1 }), 2);
  assert.equal(importRenamedCount({}), 0);
  assert.equal(importRenamedCount(null), 0);
});

test('parseImportResponse：200 成功（含改名）', () => {
  const result = parseImportResponse(200, {
    ok: true,
    mode: 'rename',
    imported: {
      encounters: [{ name: 'rudinn-2', renamedFrom: 'rudinn' }],
      attacks: [{ name: 'spade-rain' }],
      sprites: ['spr_a'],
      audio: [],
    },
    renamed: 1,
  });
  assert.equal(result.ok, true);
  assert.equal(result.code, 'ok');
  assert.deepEqual(result.counts, { encounters: 1, attacks: 1, assets: 1 });
  assert.equal(result.renamed, 1);
});

test('parseImportResponse：409 衝突帶清單與錯誤訊息', () => {
  const result = parseImportResponse(409, {
    ok: false,
    code: 'conflicts',
    error: '有同名檔案',
    mode: 'abort',
    conflicts: [{ kind: 'encounter', name: 'rudinn', path: 'encounters/rudinn.json' }],
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'conflicts');
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.message, '有同名檔案');
});

test('parseImportResponse：400 壞檔／空 body／ok:false 都不算成功', () => {
  const bad = parseImportResponse(400, { ok: false, code: 'bad_pack', error: '不是合法的作品包' });
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'bad_pack');
  assert.equal(bad.message, '不是合法的作品包');

  const empty = parseImportResponse(0, null);
  assert.equal(empty.ok, false);
  assert.equal(empty.message, 'HTTP 0');

  const notOk = parseImportResponse(200, { ok: false, code: 'internal', error: 'x' });
  assert.equal(notOk.ok, false);
  assert.equal(notOk.code, 'internal');
});

test('parseImportResponse：錯誤 payload 沒有 code 時用狀態碼判斷 conflicts', () => {
  const result = parseImportResponse(409, { ok: false });
  assert.equal(result.code, 'conflicts');
  assert.deepEqual(result.conflicts, []);
});

test('三語字串鍵集合一致，英文不含中文', () => {
  assert.deepEqual(Object.keys(STRINGS), LOCALE_IDS);
  assert.deepEqual(findKeyMismatches(), []);
  const en = STRINGS.en;
  for (const [key, value] of Object.entries(en)) {
    assert.equal(typeof value, 'string', `en.${key} 必須是字串`);
    assert.ok(value.trim().length > 0, `en.${key} 不可為空`);
    assert.ok(!CJK.test(value), `en.${key} 不應含中文：${value}`);
  }
  for (const lang of ['zh-Hant', 'zh-Hans']) {
    assert.ok(CJK.test(STRINGS[lang].packExport), `${lang} 應為中文`);
  }
});

test('原始碼用到的字串鍵都存在於三語表', () => {
  const source = read('./pack-toolbar.js');
  const keys = new Set();
  const re = /\bT\('([A-Za-z][A-Za-z0-9]*)'/g;
  let match;
  while ((match = re.exec(source))) keys.add(match[1]);
  assert.ok(keys.size >= 20, `T() 鍵太少：${keys.size}`);
  for (const key of keys) {
    for (const lang of LOCALE_IDS) {
      assert.ok(key in STRINGS[lang], `${lang} 缺少字串鍵 ${key}`);
    }
  }
});

test('來源接線：端點、mountExportButton、main.js 掛載、v2.css 連結', () => {
  const source = read('./pack-toolbar.js');
  assert.ok(source.includes('/api/pack/export'));
  assert.ok(source.includes('/api/pack/import'));
  assert.ok(source.includes('mountExportButton'));
  assert.ok(source.includes("kind: 'encounter'"));
  assert.ok(source.includes("registerStrings('encPack'"));
  assert.ok(source.includes('importMode'));
  assert.ok(source.includes('openModal'));

  const main = read('./main.js');
  assert.ok(main.includes('mountPackToolbar'));
  assert.ok(main.includes("'./pack-toolbar.js'"));

  const html = read('../../encounter.html');
  assert.ok(html.includes('editor/encounter/v2.css'));
});

test('匯出／匯入端點常數與伺服器路由一致', () => {
  assert.equal(PACK_EXPORT_ENDPOINT, '/api/pack/export');
  assert.equal(PACK_IMPORT_ENDPOINT, '/api/pack/import');
});
