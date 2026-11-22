/**
 * tests/export/run.mjs — 單檔可遊玩 HTML 匯出（V2-09）單元＋整合測試
 *
 * 執行：cd battle-editor && node tests/export/run.mjs
 *
 * 範圍：
 *   1) 作品解析：自動判定 encounter/attack、遭遇底下的攻擊、not_found / invalid_name / bad_request
 *   2) demo 判定、素材表、字型選擇（zh 才有 @zh）
 *   3) 使用素材收集：文件引用＋引擎原始碼內硬編碼的 snd_* / spr_*
 *   4) 引擎模組圖：依 kind/autoplay 的入口、closure、import map（全 data: + 合成 URL）
 *   5) 模組改寫：相對匯入 → 合成 URL、import.meta.url → 合成 URL、不再有相對 specifier
 *   6) 素材打包：精簡索引形狀（data: 幀、glyphs JSON data:、音訊 data:）
 *   7) HTML 組裝：importmap、canvas、標題/結尾 DOM、設定/索引 script、title 轉義
 *   8) exportGame 端到端（en 攻擊＋en 遭遇，輸出到 %TEMP%。不寫 repo）
 *   9) CLI --json 子程序
 *
 * 不開瀏覽器；瀏覽器端驗收另見 tests/export/edge-acceptance.mjs。
 */

import { existsSync, mkdirSync, readFileSync, statSync, copyFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import {
  group,
  test,
  ok,
  eq,
  deepEq,
  hasKey,
  run,
  summary,
} from '../engine/harness.mjs';
import {
  EXPORT_FORMAT,
  TOOL_ID,
  exportPaths,
  hasDemoDoc,
  resolveWork,
  loadAssetTables,
  findAssetFile,
  collectUsedAssets,
  selectFonts,
  buildAssetBundle,
  collectModules,
  moduleEntries,
  rewriteModuleSource,
  buildImportMap,
  buildGameHtml,
  exportGame,
} from '../../tools/export-game.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..', '..');
const OUT_DIR = join(tmpdir(), 'V2-09', 'export-tests');
mkdirSync(OUT_DIR, { recursive: true });

const paths = exportPaths(ROOT, null);
const tables = loadAssetTables(paths);
const attackModules = collectModules(ROOT, moduleEntries('attack', true));
const encounterModules = collectModules(ROOT, moduleEntries('encounter', true));

function errCode(fn) {
  try {
    fn();
  } catch (err) {
    return err && err.code ? err.code : `NO_CODE:${err && err.message}`;
  }
  return null;
}

/* ------------------------------------------------------------ 作品解析 */

group('作品解析（resolveWork）');

test('rudinn 自動判定為 encounter，並帶入 3 個攻擊', () => {
  const work = resolveWork({ name: 'rudinn', paths });
  eq(work.kind, 'encounter');
  eq(work.name, 'rudinn');
  eq(String(work.title).length > 0, true, '標題不為空');
  deepEq(Object.keys(work.attacks).sort(), ['box-shrink-aim', 'ring-burst', 'spade-rain']);
  eq(work.documents.length, 4, '主文件＋3 個攻擊');
  eq(work.primary.format, 'dr-battle-encounter/1');
  deepEq(work.warnings, []);
});

test('spade-rain 自動判定為 attack', () => {
  const work = resolveWork({ name: 'spade-rain', paths });
  eq(work.kind, 'attack');
  eq(work.primary.format, 'dr-battle-attack/1');
  eq(work.documents.length, 1);
  deepEq(work.attacks, {});
});

test('kind 明示 encounter 但 attack 檔不算命中（not_found）', () => {
  eq(errCode(() => resolveWork({ name: 'spade-rain', kind: 'encounter', paths })), 'not_found');
});

test('未知 kind → bad_request；不存在 → not_found；非法名稱 → invalid_name', () => {
  eq(errCode(() => resolveWork({ name: 'rudinn', kind: 'battle', paths })), 'bad_request');
  eq(errCode(() => resolveWork({ name: 'no-such-work-xyz', paths })), 'not_found');
  eq(errCode(() => resolveWork({ name: '../evil', paths })), 'invalid_name');
  eq(errCode(() => resolveWork({ name: '   ', paths })), 'bad_request');
});

group('作品根優先與 repo 退回（--works）');

test('works 根優先；作品根沒有的攻擊退回 repo samples', () => {
  const worksDir = join(OUT_DIR, 'works-fixture');
  const encDir = join(worksDir, 'encounters');
  mkdirSync(encDir, { recursive: true });
  const fixture = join(encDir, 'works-test.json');
  copyFileSync(join(ROOT, 'samples', 'encounters', 'rudinn.json'), fixture);
  try {
    const worksPaths = exportPaths(ROOT, worksDir);
    const rootPaths = exportPaths(ROOT, null);
    const work = resolveWork({ name: 'works-test', paths: worksPaths, fallbackPaths: rootPaths });
    eq(work.kind, 'encounter');
    eq(work.title, 'Rudinn遭遇');
    // 遭遇本身來自作品根；它引用的攻擊在作品根不存在 → 退回 repo samples。
    deepEq(Object.keys(work.attacks).sort(), ['box-shrink-aim', 'ring-burst', 'spade-rain']);

    const out = join(OUT_DIR, 'works-test.html');
    const payload = exportGame({
      works: worksDir,
      name: 'works-test',
      kind: 'encounter',
      lang: 'en',
      out,
    });
    eq(payload.ok, true);
    eq(payload.source.kind, 'encounter');
    deepEq(payload.source.attacks, ['box-shrink-aim', 'ring-burst', 'spade-rain']);
    ok(payload.bytes > 1024 * 1024, `作品根匯出大小 ${payload.bytes}`);
  } finally {
    try {
      unlinkSync(fixture);
    } catch (_err) {
      /* 清理失敗不影響測試 */
    }
  }
});

group('demo 判定（hasDemoDoc）');

test('rudinn / spade-rain 有 demo；空物件沒有', () => {
  eq(hasDemoDoc('encounter', { demo: { turns: [{}] } }), true);
  eq(hasDemoDoc('attack', { demo: { path: [{ t: 0, x: 1, y: 1 }] } }), true);
  eq(hasDemoDoc('attack', {}), false);
  eq(hasDemoDoc('attack', null), false);
  eq(hasDemoDoc('encounter', { demo: {} }), false);
});

/* ------------------------------------------------------------ 素材 */

group('素材表與字型');

test('素材索引：sprites/audio/fonts 都有內容', () => {
  eq(tables.format, 'dr-battle-assets/1');
  ok(Object.keys(tables.sprites).length > 1000, 'sprite 數量');
  ok(Object.keys(tables.audio).length > 100, 'audio 數量');
  eq(Object.keys(tables.fonts).length, 22);
  hasKey(tables.sprites, 'spr_heart');
  hasKey(tables.sprites, 'spr_battlebg_0');
  hasKey(tables.audio, 'battle');
  hasKey(tables.fonts, 'fnt_main');
});

test('findAssetFile 找得到主索引的檔案；不存在回 null', () => {
  const entry = tables.sprites.spr_heart;
  const file = findAssetFile(entry.frames[0], entry, paths);
  ok(file && existsSync(file), 'spr_heart 第一幀存在');
  eq(findAssetFile('no/such/file.png', { frames: [] }, paths), null);
});

test('selectFonts：zh 多包 @zh、en 不包；DTM 不包', () => {
  const zh = selectFonts(tables, 'zh');
  const en = selectFonts(tables, 'en');
  ok(zh.fonts.includes('fnt_main@zh'), 'zh 含 fnt_main@zh');
  ok(zh.fonts.includes('fnt_main_wide'), 'zh 含 fnt_main_wide');
  eq(en.fonts.includes('fnt_main@zh'), false, 'en 不含 @zh');
  ok(en.fonts.includes('fnt_main'), 'en 含 fnt_main');
  eq(zh.fonts.includes('DTM'), false, 'DTM（4.3MB）不包');
  deepEq(zh.missing, []);
  deepEq(en.missing, []);
});

test('collectUsedAssets：文件引用＋引擎硬編碼 snd_*', () => {
  const work = resolveWork({ name: 'rudinn', paths });
  const used = collectUsedAssets({
    documents: [work.primary, ...Object.values(work.attacks)],
    tables,
    moduleSources: [
      'if (sfx === "snd_graze") {}',
      'spr_fake_not_in_index',
      '// spr_grazemask spr_grazemask_small spr_grazeappear spr_grazeappear_small spr_grazeappear_yellow',
      'onSfx("snd_cancel"); onSfx("snd_move"); onSfx("snd_nosound"); onSfx("snd_fake_not_in_index");',
    ],
  });
  for (const sprite of ['spr_heart', 'spr_headkris', 'spr_diamondm_idle', 'spr_krisb_idle', 'spr_battlebg_0']) {
    ok(used.sprites.has(sprite), `應收集 sprite ${sprite}`);
  }
  for (const audio of ['battle', 'snd_battleenter', 'snd_hurt1', 'snd_graze']) {
    ok(used.audio.has(audio), `應收集音訊 ${audio}`);
  }
  eq(used.sprites.has('spr_fake_not_in_index'), false, '不存在的名字只進 warning');
  ok(used.missing.sprites.includes('spr_fake_not_in_index'), '缺素材應警告');
  ok(used.missing.audio.includes('snd_fake_not_in_index'), '缺音訊應警告');
  // REALTEST-2 V5：引擎內建素材（索引沒有也正常）不算缺素材
  for (const name of ['spr_grazemask', 'spr_grazemask_small', 'spr_grazeappear', 'spr_grazeappear_small', 'spr_grazeappear_yellow']) {
    if (tables.sprites[name]) continue;
    eq(used.missing.sprites.includes(name), false, `${name} 不該列為缺素材`);
    ok(used.builtin.sprites.includes(name), `${name} 應列為引擎內建`);
  }
  for (const name of ['snd_cancel', 'snd_move', 'snd_nosound']) {
    if (tables.audio[name]) continue;
    eq(used.missing.audio.includes(name), false, `${name} 不該列為缺音訊`);
    ok(used.builtin.audio.includes(name), `${name} 應列為引擎內建`);
  }
});

test('buildAssetBundle：精簡索引形狀正確（全部 data: URL）', () => {
  const used = {
    sprites: new Set(['spr_heart', 'spr_battlebg_0']),
    audio: new Set(['snd_hurt1']),
    missing: { sprites: [], audio: [] },
  };
  const bundle = buildAssetBundle({
    tables,
    used,
    fonts: ['fnt_main', 'fnt_main@zh'],
    paths,
  });
  eq(bundle.index.format, 'dr-battle-assets/1');
  for (const name of ['spr_heart', 'spr_battlebg_0']) {
    const entry = bundle.index.sprites[name];
    ok(Array.isArray(entry.frames) && entry.frames.length > 0, `${name} 有幀`);
    for (const frame of entry.frames) ok(frame.startsWith('data:image/'), `${name} 幀是 data:image`);
    eq(typeof entry.w, 'number');
    eq(typeof entry.h, 'number');
  }
  const audio = bundle.index.audio.snd_hurt1;
  ok(audio.file.startsWith('data:audio/'), '音訊是 data:audio');
  for (const font of ['fnt_main', 'fnt_main@zh']) {
    const entry = bundle.index.fonts[font];
    ok(entry.image.startsWith('data:image/'), `${font} image 是 data:`);
    ok(entry.glyphs.startsWith('data:application/json'), `${font} glyphs 是 data: JSON`);
    eq(typeof entry.size, 'number');
    eq(typeof entry.lineHeight, 'number');
  }
  eq(bundle.stats.sprites, 2);
  eq(bundle.stats.audio, 1);
  eq(bundle.stats.fonts, 2);
  ok(bundle.stats.frames >= 3);
  ok(bundle.stats.bytes > 1000);
});

/* ------------------------------------------------------------ 模組圖 */

group('引擎模組圖（collectModules / moduleEntries）');

test('入口：attack 5 個、autoplay 多 1 個、encounter 多 3 個＋autoplay 2 個', () => {
  const attackBase = moduleEntries('attack', false);
  const attackAuto = moduleEntries('attack', true);
  const encounterBase = moduleEntries('encounter', false);
  const encounterAuto = moduleEntries('encounter', true);
  eq(attackBase.length, 5);
  eq(attackAuto.length, attackBase.length + 1);
  ok(attackAuto.includes('engine/autoplay/index.js'));
  ok(encounterBase.includes('engine/encounter/index.js'));
  ok(encounterBase.includes('engine/encounter/flow.js'));
  ok(encounterBase.includes('engine/render-encounter.js'));
  ok(encounterAuto.includes('engine/autoplay/encounter.js'));
  eq(encounterAuto.length, attackAuto.length + 4);
});

test('closure 含動態載入目標與渲染器，且沒有重複／超出根目錄的路徑', () => {
  eq(attackModules.size, 25);
  for (const rel of ['engine/autoplay/pathgen.js', 'engine/autoplay/trace.js', 'engine/rng.js']) ok(attackModules.has(rel), rel);
  ok(encounterModules.size >= 28, `encounter closure 大小 ${encounterModules.size}`);
  for (const rel of [
    'engine/index.js',
    'engine/assets.js',
    'engine/arena.js',
    'engine/soul-mechanics.js',
    'engine/soul-collision.js',
    'engine/render.js',
    'engine/render-hud.js',
    'engine/autoplay/index.js',
    'engine/autoplay/soul.js',
    'engine/autoplay/bot.js',
    'engine/autoplay/validate.js',
    'engine/autoplay/encounter.js',
  ]) {
    ok(attackModules.has(rel), `attack closure 應含 ${rel}`);
  }
  for (const rel of ['engine/arena.js', 'engine/soul-mechanics.js', 'engine/soul-collision.js', 'engine/encounter/index.js', 'engine/encounter/flow.js', 'engine/render-encounter.js']) {
    ok(encounterModules.has(rel), `encounter closure 應含 ${rel}`);
  }
  for (const rel of attackModules.keys()) {
    ok(!rel.startsWith('..') && !rel.includes('\\'), `路徑乾淨：${rel}`);
    ok(existsSync(join(ROOT, rel)), `檔案存在：${rel}`);
  }
});

test('rewriteModuleSource：import.meta.url 與相對 specifier 全改成合成 URL', () => {
  const rel = 'engine/fake.js';
  const source = [
    "import { a } from './a.js';",
    "export * from './b.js';",
    "const m = await import('./c.js');",
    "const u = new URL('./d.js', import.meta.url).href;",
  ].join('\n');
  const out = rewriteModuleSource(rel, source);
  eq(out.includes('import.meta.url'), false);
  eq(out.includes("'./a.js'"), false);
  ok(out.includes('http://dr.local/engine/a.js'), 'a.js → 合成 URL');
  ok(out.includes('http://dr.local/engine/b.js'), 'b.js → 合成 URL');
  ok(out.includes('http://dr.local/engine/c.js'), 'c.js → 合成 URL');
  // new URL(相對路徑, import.meta.url) 不直接改寫字串：把 import.meta.url 換成模組自身的
  // 合成 URL 後，瀏覽器端 new URL() 會解析成 http://dr.local/engine/d.js，再走 import map。
  ok(
    out.includes("new URL('./d.js', \"http://dr.local/engine/fake.js\")"),
    'import.meta.url → 模組自身合成 URL，供 new URL() 執行期解析',
  );
});

test('buildImportMap：鍵是合成 URL、值是 data:text/javascript base64；模組內無相對 specifier', () => {
  const importMap = buildImportMap(attackModules);
  eq(Object.keys(importMap).length, attackModules.size);
  for (const [key, value] of Object.entries(importMap)) {
    ok(key.startsWith('http://dr.local/'), `合成 URL 鍵：${key}`);
    ok(value.startsWith('data:text/javascript;base64,'), `data: 模組值：${key}`);
  }
  for (const rel of attackModules.keys()) {
    const out = rewriteModuleSource(rel, attackModules.get(rel));
    eq(out.includes('import.meta.url'), false, `${rel} 不應有 import.meta.url`);
  }
});

/* ------------------------------------------------------------ HTML */

group('HTML 組裝（buildGameHtml）');

const sampleImportMap = buildImportMap(attackModules);
const sampleHtml = buildGameHtml({
  config: {
    format: EXPORT_FORMAT,
    kind: 'attack',
    name: 'spade-rain',
    title: '黑桃雨 <測試>',
    lang: 'zh',
    auto: true,
    hasDemo: true,
    fonts: ['fnt_main'],
    doc: { format: 'dr-battle-attack/1' },
  },
  assetIndexText: '{"format":"dr-battle-assets/1","sprites":{},"audio":{},"fonts":{}}',
  importMap: sampleImportMap,
  title: '黑桃雨 <測試>',
  lang: 'zh',
});

test('canvas 640×480、importmap、索引/設定 script 都在', () => {
  ok(sampleHtml.startsWith('<!doctype html>'));
  ok(sampleHtml.includes('width="640"'));
  ok(sampleHtml.includes('height="480"'));
  ok(sampleHtml.includes('<script type="importmap">'));
  ok(sampleHtml.includes('id="dr-asset-index"'));
  ok(sampleHtml.includes('id="dr-game-config"'));
  ok(sampleHtml.includes('id="title-text"'));
  ok(sampleHtml.includes('id="end-text"'));
  ok(sampleHtml.includes('id="auto-btn"'));
  ok(sampleHtml.includes('http://dr.local/engine/index.js'));
});

test('標題會做 HTML 轉義；索引 JSON 的 < 被跳脫（避免 </script>）', () => {
  ok(sampleHtml.includes('黑桃雨 &lt;測試&gt;'), '<title> 已轉義');
  eq(sampleHtml.includes('黑桃雨 <測試>'), false, '不應出現未轉義標題');
  const indexBlock = /<script type="application\/json" id="dr-asset-index">([\s\S]*?)<\/script>/.exec(sampleHtml);
  ok(indexBlock, '索引 script 存在');
  eq(indexBlock[1].includes('<'), false, 'JSON 內不含裸 <');
});

test('HTML 不含對外 URL（http(s):// 只出現在合成 import map 鍵）', () => {
  const stripped = sampleHtml.replace(/https?:\/\/dr\.local\/[A-Za-z0-9_./-]+/g, '');
  eq(/https?:\/\//.test(stripped), false, '除了 dr.local 合成鍵之外不應有外部網址');
});

/* ------------------------------------------------------------ 端到端 */

group('exportGame 端到端（輸出到 %TEMP%，不寫 repo）');

test('attack（en）：檔案存在、大小與統計合理、無外部 URL', () => {
  const out = join(OUT_DIR, 'spade-rain-en.html');
  const payload = exportGame({ name: 'spade-rain', kind: 'attack', lang: 'en', out });
  eq(payload.ok, true);
  eq(payload.tool, TOOL_ID);
  eq(payload.format, EXPORT_FORMAT);
  eq(payload.kind, 'attack');
  eq(payload.lang, 'en');
  eq(payload.autoplay, true, 'spade-rain 有 demo → 預設開自動演示');
  eq(existsSync(out), true);
  eq(payload.bytes, statSync(out).size);
  ok(payload.bytes > 500 * 1024, `檔案大小 ${payload.bytes}`);
  ok(payload.modules >= 15, `模組數 ${payload.modules}`);
  ok(payload.assets.sprites >= 14, `sprite 數 ${payload.assets.sprites}`);
  ok(payload.assets.frames >= 30, `幀數 ${payload.assets.frames}`);
  ok(payload.assets.audio >= 1);
  ok(payload.assets.fonts >= 6);
  deepEq(payload.source.attacks, []);
  const html = readFileSync(out, 'utf8');
  ok(html.includes('<!doctype html>'));
  ok(html.includes('id="dr-game-config"'));
  eq(/rel="stylesheet"|src="http/.test(html), false, '不引用外部資源');
});

test('encounter（en）：一起打包 3 個攻擊、自動演示開、sprites/audio 更多', () => {
  const out = join(OUT_DIR, 'rudinn-en.html');
  const payload = exportGame({ name: 'rudinn', kind: 'encounter', lang: 'en', out });
  eq(payload.ok, true);
  eq(payload.kind, 'encounter');
  deepEq(payload.source.attacks, ['box-shrink-aim', 'ring-burst', 'spade-rain']);
  eq(payload.autoplay, true);
  ok(payload.bytes > 1024 * 1024, `遭遇檔大小 ${payload.bytes}`);
  ok(payload.assets.sprites > 30, `sprite 數 ${payload.assets.sprites}`);
  ok(payload.assets.audio >= 5, `音訊數 ${payload.assets.audio}`);
  const html = readFileSync(out, 'utf8');
  ok(html.includes('"kind":"encounter"'));
  ok(html.includes('"rudinn"'));
  ok(html.includes('"box-shrink-aim"'));
});

test('--no-autoplay-toggle：仍可匯出但沒有自動演示切換', () => {
  const out = join(OUT_DIR, 'spade-rain-noauto.html');
  const payload = exportGame({
    name: 'spade-rain',
    kind: 'attack',
    lang: 'en',
    autoplayToggle: false,
    out,
  });
  eq(payload.autoplay, false);
  eq(payload.hasDemo, true);
  const html = readFileSync(out, 'utf8');
  ok(html.includes('"auto":false'));
});

test('title 覆寫＋轉義', () => {
  const out = join(OUT_DIR, 'titled.html');
  const payload = exportGame({
    name: 'spade-rain',
    kind: 'attack',
    lang: 'en',
    title: 'A & B <C>',
    out,
  });
  eq(payload.title, 'A & B <C>');
  const html = readFileSync(out, 'utf8');
  ok(html.includes('A &amp; B &lt;C&gt;'), '<title> 轉義');
});

test('錯誤碼：not_found / bad_request（語言）/ invalid_name', () => {
  eq(errCode(() => exportGame({ name: 'no-such-work-xyz', out: join(OUT_DIR, 'x.html') })), 'not_found');
  eq(errCode(() => exportGame({ name: 'spade-rain', lang: 'fr', out: join(OUT_DIR, 'x.html') })), 'bad_request');
  eq(errCode(() => exportGame({ name: '../evil', out: join(OUT_DIR, 'x.html') })), 'invalid_name');
});

/* ------------------------------------------------------------ CLI */

group('CLI（node tools/export-game.mjs --json）');

test('--json 回傳合法 payload，且檔案真的寫出', () => {
  const out = join(OUT_DIR, 'cli-spade.html');
  const result = spawnSync(
    process.execPath,
    ['tools/export-game.mjs', 'spade-rain', '--kind', 'attack', '--lang', 'en', '--out', out, '--json'],
    { cwd: ROOT, encoding: 'utf8', timeout: 120000 },
  );
  eq(result.status, 0, `exit 0（stderr: ${(result.stderr || '').slice(0, 400)}）`);
  const payload = JSON.parse(result.stdout);
  eq(payload.ok, true);
  eq(payload.kind, 'attack');
  eq(payload.lang, 'en');
  eq(resolve(payload.out), resolve(out));
  eq(existsSync(out), true);
});

test('CLI 錯誤時 exit 1、JSON 帶 code', () => {
  const result = spawnSync(
    process.execPath,
    ['tools/export-game.mjs', 'no-such-work-xyz', '--json'],
    { cwd: ROOT, encoding: 'utf8', timeout: 60000 },
  );
  eq(result.status, 1);
  const payload = JSON.parse(result.stdout);
  eq(payload.ok, false);
  eq(payload.code, 'not_found');
});

/* ------------------------------------------------------------ 結果 */

const result = await run();
summary();
if (result.fail > 0) process.exitCode = 1;
