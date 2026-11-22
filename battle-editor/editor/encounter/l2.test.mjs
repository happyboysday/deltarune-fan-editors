// editor/encounter/g2.test.mjs — L2：REALTEST-2026-11-08 的 B19 / §4-10 / F3 下拉標籤 / B11 favicon
//
//   B19    encounter.html?file= / ?sample= 解析、候選網址、載入結果、replaceState 查詢字串
//   §4-10  預覽縮放吸附（整數倍或 0.5）、CSS→遊戲座標換算（含縮放後的一致性）
//   F3     demo 下拉：短標籤 + 完整 title、三語都有、option 也帶 title
//   B11    favicon.svg 存在且是純 SVG，三個頁面都掛了 <link rel="icon">
//
// 全部只測純函式與原始碼／檔案內容，不需要瀏覽器。
// 執行：node --test editor/encounter/g2.test.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  parseLoadQuery,
  buildLoadQueryString,
  resolveLoadQuery,
  sampleEncounterUrl,
  fileCandidateUrls,
  normalizeFileName,
} from './fileops.js';
import { previewToGame, gameToPreview, snapPreviewScale } from './preview.js';
import STRINGS, { LOCALE_IDS } from '../locales/encounter-demo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');

/* =========================================================== B19：?file= / ?sample= */

test('B19 parseLoadQuery：?sample= 只取檔名，容忍路徑與 .json', () => {
  assert.deepEqual(parseLoadQuery('?sample=rudinn'), { file: null, sample: 'rudinn' });
  assert.deepEqual(parseLoadQuery('?sample=rudinn.json'), { file: null, sample: 'rudinn' });
  assert.deepEqual(parseLoadQuery('?sample=samples/encounters/rudinn.json'), { file: null, sample: 'rudinn' });
  assert.deepEqual(parseLoadQuery('?sample=%20showcase%20'), { file: null, sample: 'showcase' });
});

test('B19 parseLoadQuery：?file= 接受 encounters/ 前綴與 .json，也吃反斜線', () => {
  assert.deepEqual(parseLoadQuery('?file=my-encounter'), { file: 'my-encounter', sample: null });
  assert.deepEqual(parseLoadQuery('?file=my-encounter.json'), { file: 'my-encounter', sample: null });
  assert.deepEqual(parseLoadQuery('?file=encounters/my-encounter.json'), { file: 'my-encounter', sample: null });
  assert.deepEqual(parseLoadQuery('?file=encounters\\my-encounter.json'), { file: 'my-encounter', sample: null });
  // 中文檔名保留（serve.py 白名單含中文）
  assert.equal(parseLoadQuery('?file=遭遇.json').file, '遭遇');
  // 非法字元換成底線（與 normalizeFileName 同一套規則）
  assert.equal(parseLoadQuery('?file=a b/c.json').file, 'c');
  assert.equal(parseLoadQuery('?file=a%20b.json').file, 'a_b');
});

test('B19 parseLoadQuery：沒有參數 / 空值都回 null（不亂載入）', () => {
  assert.deepEqual(parseLoadQuery(''), { file: null, sample: null });
  assert.deepEqual(parseLoadQuery('?'), { file: null, sample: null });
  assert.deepEqual(parseLoadQuery('?file=&sample='), { file: null, sample: null });
  assert.deepEqual(parseLoadQuery('?other=1'), { file: null, sample: null });
  assert.deepEqual(parseLoadQuery(null), { file: null, sample: null });
});

test('B19 parseLoadQuery 與 normalizeFileName 對同一輸入的結果一致', () => {
  for (const raw of ['rudinn', 'encounters/rudinn.json', 'samples\\encounters\\showcase.json', ' a b .json ']) {
    const viaQuery = parseLoadQuery(`?file=${encodeURIComponent(raw)}`).file;
    assert.equal(viaQuery, normalizeFileName(raw) || null, `輸入 ${JSON.stringify(raw)}`);
  }
});

test('B19 buildLoadQueryString：設定 / 清除 / 保留其他參數', () => {
  // 設定
  assert.equal(buildLoadQueryString('', { file: 'a.json' }), '?file=a.json');
  // 換成 sample 時清掉 file（避免兩個參數互搶）
  assert.equal(buildLoadQueryString('?file=a.json', { file: null, sample: 'rudinn.json' }), '?sample=rudinn.json');
  // 清除後沒有參數就不留 '?'
  assert.equal(buildLoadQueryString('?file=a.json', { file: null, sample: null }), '');
  // 其他參數（?lang=）保留
  assert.equal(buildLoadQueryString('?lang=zh', { file: 'a.json' }), '?lang=zh&file=a.json');
  // 同一個鍵覆蓋，不重複
  assert.equal(buildLoadQueryString('?file=a.json', { file: 'b.json' }), '?file=b.json');
  // undefined = 不動
  assert.equal(buildLoadQueryString('?file=a.json', { sample: 'x.json' }), '?file=a.json&sample=x.json');
});

test('B19 候選網址：API → encounters/ 靜態 → samples/', () => {
  assert.equal(sampleEncounterUrl('rudinn'), 'samples/encounters/rudinn.json');
  const urls = fileCandidateUrls('rudinn').map((c) => c.url);
  assert.deepEqual(urls, [
    '/api/encounters/rudinn.json',
    'encounters/rudinn.json',
    'samples/encounters/rudinn.json',
  ]);
  // 中文檔名要 encode（serve.py 收到的是 decode 後的中文）
  assert.equal(sampleEncounterUrl('遭遇'), `samples/encounters/${encodeURIComponent('遭遇')}.json`);
});

/** 假 fetch：urls 內的回應表 */
function fakeFetch(table) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const hit = table[url];
    if (!hit) return { ok: false, status: 404, json: async () => null };
    if (hit === 'bad-json') return { ok: true, status: 200, json: async () => { throw new Error('Unexpected token'); } };
    return { ok: true, status: 200, json: async () => hit };
  };
  fn.calls = calls;
  return fn;
}

test('B19 resolveLoadQuery：?sample= 只打一個網址，成功回傳文件', async () => {
  const doc = { format: 'dr-battle-encounter/1', meta: { name: 'Rudinn遭遇' } };
  const fetchImpl = fakeFetch({ 'samples/encounters/rudinn.json': doc });
  const out = await resolveLoadQuery({ file: null, sample: 'rudinn' }, { fetchImpl });
  assert.equal(out.ok, true);
  assert.equal(out.source, 'sample');
  assert.equal(out.name, 'rudinn');
  assert.equal(out.doc, doc);
  assert.deepEqual(fetchImpl.calls, ['samples/encounters/rudinn.json']);
});

test('B19 resolveLoadQuery：?file= 依序退回，找到就停（不用全部 404）', async () => {
  const doc = { format: 'dr-battle-encounter/1' };
  const first = fakeFetch({ 'encounters/a.json': doc });
  const out = await resolveLoadQuery({ file: 'a', sample: null }, { fetchImpl: first });
  assert.equal(out.ok, true);
  assert.deepEqual(first.calls, ['/api/encounters/a.json', 'encounters/a.json']);
  assert.equal(out.url, 'encounters/a.json');

  // 全部找不到 → ok:false，tried 記錄三次嘗試
  const none = fakeFetch({});
  const miss = await resolveLoadQuery({ file: 'nope', sample: null }, { fetchImpl: none });
  assert.equal(miss.ok, false);
  assert.equal(miss.name, 'nope');
  assert.equal(miss.tried.length, 3);
  assert.match(miss.error, /HTTP 404/);
});

test('B19 resolveLoadQuery：沒有參數就不抓任何東西', async () => {
  const fetchImpl = fakeFetch({});
  const out = await resolveLoadQuery({ file: null, sample: null }, { fetchImpl });
  assert.equal(out.ok, false);
  assert.equal(out.skipped, true);
  assert.deepEqual(fetchImpl.calls, []);
});

test('opening an encounter from its URL preserves the revision needed for its first save', async () => {
  const fetchImpl = async () => ({
    ok: true,
    headers: new Headers({ ETag: '"opened-revision"' }),
    json: async () => ({ format: 'dr-battle-encounter/1' }),
  });
  const opened = await resolveLoadQuery({ file: 'doppeldoll', sample: null }, { fetchImpl });
  assert.equal(opened.etag, 'opened-revision');
});

test('B19 resolveLoadQuery：JSON 壞掉不會拋出，回 ok:false', async () => {
  const fetchImpl = fakeFetch({ 'samples/encounters/broken.json': 'bad-json' });
  const out = await resolveLoadQuery({ file: null, sample: 'broken' }, { fetchImpl });
  assert.equal(out.ok, false);
  assert.ok(out.tried.length >= 1);
});

test('B19 原始碼：afterOpen / doSave 會同步網址列（history.replaceState）', () => {
  const src = readFileSync(path.join(HERE, 'fileops.js'), 'utf8');
  assert.match(src, /history\.replaceState/, '要用 replaceState 同步網址（不新增歷史紀錄）');
  // afterOpen 內要有 syncLoadQuery
  const afterOpen = src.slice(src.indexOf('function afterOpen('), src.indexOf('function afterOpen(') + 1600);
  assert.match(afterOpen, /syncLoadQuery\(/, '開檔成功後要同步 ?file=');
  // doSave 內也要同步
  const doSave = src.slice(src.indexOf('async function doSave('), src.indexOf('async function doSave(') + 1400);
  assert.match(doSave, /syncLoadQuery\(/, '儲存／另存成功後要同步 ?file=');
  // mountToolbar 要啟動查詢載入
  const mount = src.slice(src.indexOf('export function mountToolbar('));
  assert.match(mount, /startQueryLoad\(\)|loadFromQuery\(/, '掛載時要套用 ?file= / ?sample=');
});

test('B19 原始碼：找不到檔案會 toast 錯誤（不是只寫 console）', () => {
  const src = readFileSync(path.join(HERE, 'fileops.js'), 'utf8');
  const body = src.slice(src.indexOf('export async function loadFromQuery('));
  const head = body.slice(0, 2200);
  assert.match(head, /encfileops\.load\.failed/, '要找得到 load.failed 字串');
  assert.match(head, /toast\(/, '失敗要 toast 給使用者看');
});

/* ==================================================== §4-10：縮放與座標換算 */

test('§4-10 snapPreviewScale：1× 以上只回整數倍（像素寬度不會在 1～2px 之間跳）', () => {
  assert.equal(snapPreviewScale(1), 1);
  assert.equal(snapPreviewScale(1.4), 1);
  assert.equal(snapPreviewScale(1.5), 1);
  assert.equal(snapPreviewScale(1.99), 1);
  assert.equal(snapPreviewScale(2), 2);
  assert.equal(snapPreviewScale(2.7), 2);
  assert.equal(snapPreviewScale(3.99), 3);
  assert.equal(snapPreviewScale(4), 4);
  assert.equal(snapPreviewScale(9.5), 9);
});

test('§4-10 snapPreviewScale：小於 1× 吸附到 0.25 步進（不再有 0.975 這種倍率）', () => {
  assert.equal(snapPreviewScale(0.975), 0.75);
  assert.equal(snapPreviewScale(0.9), 0.75);
  assert.equal(snapPreviewScale(0.74), 0.5);
  assert.equal(snapPreviewScale(0.5), 0.5);
  assert.equal(snapPreviewScale(0.4), 0.25);
  assert.equal(snapPreviewScale(0.01), 0.25);
});

test('§4-10 snapPreviewScale：壞輸入退回 1（1:1，最安全），上限 16', () => {
  assert.equal(snapPreviewScale(Number.NaN), 1);
  assert.equal(snapPreviewScale(0), 1);
  assert.equal(snapPreviewScale(-3), 1);
  assert.equal(snapPreviewScale(undefined), 1);
  assert.equal(snapPreviewScale(100), 16);
  // 回傳值一定是 0.5 或整數（像素清晰的必要條件）
  for (const v of [0.1, 0.6, 0.975, 1.2, 1.4, 1.5, 2.4, 3.6, 16, 40]) {
    const s = snapPreviewScale(v);
    assert.ok(Number.isInteger(s * 4), `snapPreviewScale(${v}) = ${s} 不是 0.25 的倍數`);
    assert.ok(s >= 0.25 && s <= 16, `snapPreviewScale(${v}) = ${s} 超出範圍`);
  }
});

test('§4-10 previewToGame：1×（640×480 顯示）就是 1:1', () => {
  assert.deepEqual(previewToGame({ x: 0, y: 0 }, { width: 640, height: 480 }), { x: 0, y: 0 });
  assert.deepEqual(previewToGame({ x: 320, y: 240 }, { width: 640, height: 480 }), { x: 320, y: 240 });
  assert.deepEqual(previewToGame({ x: 639, y: 479 }, { width: 640, height: 480 }), { x: 639, y: 479 });
});

test('§4-10 previewToGame：2× 與 0.5× 都正確換算', () => {
  assert.deepEqual(previewToGame({ x: 640, y: 480 }, { width: 1280, height: 960 }), { x: 320, y: 240 });
  assert.deepEqual(previewToGame({ x: 320, y: 240 }, { width: 320, height: 240 }), { x: 640, y: 480 });
  // 左上角 / 右下角不因取整跑掉
  assert.deepEqual(previewToGame({ x: 1280, y: 960 }, { width: 1280, height: 960 }), { x: 640, y: 480 });
});

test('§4-10 previewToGame：四角與中心點對整數倍都對得剛剛好', () => {
  for (const s of [0.5, 1, 2, 3, 4]) {
    const box = { width: 640 * s, height: 480 * s };
    assert.deepEqual(previewToGame({ x: 0, y: 0 }, box), { x: 0, y: 0 }, `${s}× 左上`);
    assert.deepEqual(previewToGame({ x: 640 * s, y: 480 * s }, box), { x: 640, y: 480 }, `${s}× 右下`);
    assert.deepEqual(previewToGame({ x: 320 * s, y: 240 * s }, box), { x: 320, y: 240 }, `${s}× 中心`);
  }
});

test('§4-10 previewToGame：預設夾在畫面內，clamp:false 可取得越界值', () => {
  const box = { width: 640, height: 480 };
  assert.deepEqual(previewToGame({ x: -50, y: -20 }, box), { x: 0, y: 0 });
  assert.deepEqual(previewToGame({ x: 900, y: 700 }, box), { x: 640, y: 480 });
  assert.deepEqual(previewToGame({ x: -50, y: 700 }, box, { clamp: false }), { x: -50, y: 700 });
});

test('§4-10 gameToPreview / previewToGame 互為反函式（整數倍無誤差）', () => {
  for (const s of [1, 2, 3]) {
    const box = { width: 640 * s, height: 480 * s };
    for (const p of [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 160, y: 240 }, { x: 320, y: 190 }, { x: 639, y: 479 }]) {
      const css = gameToPreview(p, box);
      assert.deepEqual(previewToGame(css, box), p, `${s}× ${JSON.stringify(p)}`);
    }
  }
});

test('§4-10 previewToGame：視窗非整數大小（例如 624×468）也不再造成 0.975× 漂移', () => {
  // 624×468 是報告裡實際量到的舊尺寸（0.975×）。吸附後不會再出現，
  // 但換算函式對任何尺寸都必須正確（防禦性測試）。
  const box = { width: 624, height: 468 };
  assert.deepEqual(previewToGame({ x: 312, y: 234 }, box), { x: 320, y: 240 });
  assert.deepEqual(previewToGame({ x: 624, y: 468 }, box), { x: 640, y: 480 });
});

test('§4-10 previewToGame：接受 clientWidth/clientHeight 形式的框（不需先轉成 rect）', () => {
  assert.deepEqual(previewToGame({ x: 160, y: 120 }, { clientWidth: 320, clientHeight: 240 }), { x: 320, y: 240 });
});

test('§4-10 原始碼：computeScale 走 snapPreviewScale；拖曳用 previewToGame 換算', () => {
  const src = readFileSync(path.join(HERE, 'preview.js'), 'utf8');
  const compute = src.slice(src.indexOf('function computeScale()'), src.indexOf('function computeScale()') + 600);
  assert.match(compute, /snapPreviewScale\(/, 'computeScale 要吸附到像素清晰倍率');
  assert.equal(/Math\.round\(s \* 40\)/.test(compute), false, '不應再留 0.025 步進的舊算法');
  const drag = src.slice(src.indexOf('function onActorDragMove('), src.indexOf('function onActorDragMove(') + 1200);
  assert.match(drag, /previewToGame\(/, '拖曳位移要用同一套座標換算');
});

/* ======================================================== F3：演示面板下拉標籤 */

test('F3 demo 下拉：fight / dodge 顯示短標籤（不會被欄寬截斷）', () => {
  const modes = { fight: ['perfect', 'good', 'ok', 'miss'], dodge: ['path', 'inputs', 'bot', 'none'] };
  for (const loc of LOCALE_IDS) {
    for (const [group, list] of Object.entries(modes)) {
      for (const mode of list) {
        const short = STRINGS[loc].encdemo[`${group}.${mode}`];
        assert.equal(typeof short, 'string', `${loc} 缺少 ${group}.${mode}`);
        assert.ok(short.length <= 8, `${loc} ${group}.${mode} 標籤太長（${short}，${short.length} 字）`);
        assert.equal(/[（(]/.test(short), false, `${loc} ${group}.${mode} 標籤不該含括號說明：${short}`);
      }
    }
  }
});

test('F3 demo 下拉：完整說明在 title 用的 *.full.* 鍵，三語都非空且比短標籤長', () => {
  const modes = { fight: ['perfect', 'good', 'ok', 'miss'], dodge: ['path', 'inputs', 'bot', 'none'] };
  for (const loc of LOCALE_IDS) {
    for (const [group, list] of Object.entries(modes)) {
      for (const mode of list) {
        const short = STRINGS[loc].encdemo[`${group}.${mode}`];
        const full = STRINGS[loc].encdemo[`${group}.full.${mode}`];
        assert.equal(typeof full, 'string', `${loc} 缺少 ${group}.full.${mode}`);
        assert.ok(full.trim().length > 0, `${loc} ${group}.full.${mode} 是空的`);
        assert.ok(full.length > short.length, `${loc} ${group}.full.${mode} 應比短標籤長（才有說明價值）`);
      }
    }
  }
  // 0..1 的自訂命中時機也要有說明
  for (const loc of LOCALE_IDS) {
    assert.equal(typeof STRINGS[loc].encdemo['fight.full.number'], 'string');
    assert.ok(STRINGS[loc].encdemo['fight.full.number'].trim().length > 0);
  }
});

test('F3 demo 下拉：三語鍵集合一致（新增的 full.* 三語齊備）', () => {
  const base = Object.keys(STRINGS['zh-Hant'].encdemo).sort();
  for (const loc of LOCALE_IDS) {
    const keys = Object.keys(STRINGS[loc].encdemo).sort();
    assert.deepEqual(keys, base, `${loc} 的 encdemo 鍵集合不一致`);
  }
});

test('F3 demo-panel.js：選項帶 title、select/option 都掛上完整說明', () => {
  const src = readFileSync(path.join(HERE, 'demo-panel.js'), 'utf8');
  assert.match(src, /FIGHT_HELP/, '要有 fight 的完整說明對照');
  assert.match(src, /DODGE_HELP/, '要有 dodge 的完整說明對照');
  const demoSelect = src.slice(src.indexOf('function demoSelect('), src.indexOf('function demoSelect(') + 1600);
  assert.match(demoSelect, /\.title\s*=/, 'select 要設 title');
  assert.match(demoSelect, /optNode\.title|option.*title/, '每個 option 也要帶 title');
  // 「完整說明」不是硬編碼字串，而是走字串表（三語）
  assert.equal(/完美|正中最準|自動閃避/.test(demoSelect), false, '不應在程式裡硬編碼中文說明');
});

/* ============================================================= B11：favicon */

test('B11 favicon.svg 存在、是純 SVG、16×16 viewBox', () => {
  const file = path.join(ROOT, 'favicon.svg');
  assert.equal(existsSync(file), true, 'battle-editor/favicon.svg 不存在');
  const svg = readFileSync(file, 'utf8');
  assert.match(svg, /^<svg\b/, '必須以 <svg 開頭');
  assert.match(svg, /xmlns="http:\/\/www\.w3\.org\/2000\/svg"/, '缺少 xmlns（直接開檔會渲染失敗）');
  assert.match(svg, /viewBox="0 0 16 16"/, 'viewBox 應為 16×16');
  assert.match(svg, /width="16"/, 'width 應為 16');
  assert.match(svg, /height="16"/, 'height 應為 16');
  assert.equal(/<image\b/.test(svg), false, '不可嵌入點陣圖（要純 SVG）');
  assert.equal(/<script\b/i.test(svg), false, '不可含 script');
  assert.equal(/href="[^"]*\.(png|jpg|gif)"/i.test(svg), false, '不可外連點陣圖');
  // 像素風格：只用 rect，不用 path/circle 之類的平滑圖形
  assert.match(svg, /<rect\b/, '像素風格應以 <rect> 組成');
  assert.equal(/<circle\b|<ellipse\b|<path\b/.test(svg), false, '像素風格不用曲線圖形');
  // 紅心或黃星：至少一個暖色
  assert.match(svg, /#(ff3b5c|ffd84a|e83b4f|ff5470)/i, '應是紅心或黃星配色');
});

test('B11 三個頁面的 <head> 都掛了 favicon link', () => {
  for (const file of ['encounter.html', 'encounter-play.html', 'play.html']) {
    const html = readFileSync(path.join(ROOT, file), 'utf8');
    const head = html.slice(0, html.indexOf('</head>'));
    assert.match(head, /<link rel="icon" href="favicon\.svg"/, `${file} 的 <head> 缺少 favicon link`);
    // 一定要在 head（不能塞在 body 尾端）
    assert.ok(head.indexOf('favicon.svg') < html.length, `${file} favicon link 不在 head`);
  }
  // index.html 由另一位工人處理，這裡不動它（只確認我們沒改壞）
  assert.equal(existsSync(path.join(ROOT, 'index.html')), true);
});
