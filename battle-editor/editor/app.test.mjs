/**
 * editor/app.test.mjs — ED1 檢查：locales/app.js 三語鍵集合一致（命名空間 app/toolbar/preview/fileops）
 *
 * 執行：node --test editor/app.test.mjs
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import strings, { NAMESPACES } from './locales/app.js';
import syncStrings from './locales/live-sync.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const LOCALES = ['zh-Hant', 'zh-Hans', 'en'];
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Phase 1 檔案也會用到共用命名空間（sync），所以解析時要多查幾張表
const TABLES = [strings, syncStrings];

function resolveKey(loc, key) {
  const dot = key.indexOf('.');
  if (dot < 0) return undefined;
  const ns = key.slice(0, dot);
  const rest = key.slice(dot + 1);
  for (const table of TABLES) {
    const locTable = table[loc] || {};
    if (typeof locTable[key] === 'string') return locTable[key]; // 扁平全鍵（sync.*）
    if (locTable[ns] && typeof locTable[ns][rest] === 'string') return locTable[ns][rest];
  }
  return undefined;
}

test('locales/app.js 有三個語系與四個命名空間', () => {
  assert.deepEqual(Object.keys(strings).sort(), [...LOCALES].sort());
  assert.deepEqual([...NAMESPACES].sort(), ['app', 'fileops', 'preview', 'toolbar']);
  for (const loc of LOCALES) {
    for (const ns of NAMESPACES) {
      assert.ok(strings[loc] && strings[loc][ns], `${loc} 缺少命名空間 ${ns}`);
      assert.equal(typeof strings[loc][ns], 'object');
    }
  }
});

test('三語鍵集合完全一致（每個命名空間）', () => {
  for (const ns of NAMESPACES) {
    const base = Object.keys(strings['zh-Hant'][ns]).sort();
    assert.ok(base.length > 0, `${ns} 沒有任何字串`);
    for (const loc of LOCALES) {
      const keys = Object.keys(strings[loc][ns]).sort();
      const missing = base.filter((k) => !keys.includes(k));
      const extra = keys.filter((k) => !base.includes(k));
      assert.deepEqual(missing, [], `${loc}.${ns} 缺少鍵：${missing.join('、')}`);
      assert.deepEqual(extra, [], `${loc}.${ns} 多了鍵：${extra.join('、')}`);
    }
  }
});

test('每個字串都是非空字串', () => {
  for (const loc of LOCALES) {
    for (const ns of NAMESPACES) {
      for (const [key, value] of Object.entries(strings[loc][ns])) {
        assert.equal(typeof value, 'string', `${loc}.${ns}.${key} 不是字串`);
        assert.ok(value.length > 0, `${loc}.${ns}.${key} 是空字串`);
      }
    }
  }
});

test('佔位符（{name} 之類）在三語之間一致', () => {
  const placeholders = (s) => (String(s).match(/\{(\w+)\}/g) || []).sort().join(',');
  for (const ns of NAMESPACES) {
    for (const key of Object.keys(strings['zh-Hant'][ns])) {
      const ref = placeholders(strings['zh-Hant'][ns][key]);
      for (const loc of ['zh-Hans', 'en']) {
        assert.equal(
          placeholders(strings[loc][ns][key]),
          ref,
          `${loc}.${ns}.${key} 的佔位符與繁中不一致`,
        );
      }
    }
  }
});

test('英文語系不含中日韓字元（品牌名與 CJK 專有名詞除外）', () => {
  const cjk = /[\u4e00-\u9fff]/;
  const allow = new Set(['box.tag']); // 無
  for (const ns of NAMESPACES) {
    for (const [key, value] of Object.entries(strings.en[ns])) {
      if (allow.has(key)) continue;
      assert.equal(cjk.test(value), false, `en.${ns}.${key} 仍含中文字：${value}`);
    }
  }
});

test('簡中語系不使用繁體常用字（抽樣）', () => {
  const joined = Object.values(strings['zh-Hans'])
    .map((ns) => Object.values(ns).join('\n'))
    .join('\n');
  assert.equal(joined.includes('儲存'), false, '簡中不應出現「儲存」');
  assert.equal(joined.includes('復原'), false, '簡中不應出現「復原」');
  assert.equal(joined.includes('時間軸'), false, '簡中不應出現「時間軸」');
  assert.equal(joined.includes('編輯器'), false, '簡中不應出現「編輯器」');
});

test('index.html 用到的 data-i18n 鍵都存在（三語齊備）', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));
  const html = readFileSync(path.join(here, '..', 'index.html'), 'utf8');

  const keys = new Set();
  for (const m of html.matchAll(/data-i18n(?:-title|-aria-label)?="([^"]+)"/g)) keys.add(m[1]);
  assert.ok(keys.size > 20, `index.html 的 data-i18n 鍵太少（${keys.size}）`);

  const resolve = resolveKey;
  const missing = [];
  for (const key of keys) {
    for (const loc of LOCALES) {
      if (typeof resolve(loc, key) !== 'string') missing.push(`${loc}:${key}`);
    }
  }
  assert.deepEqual(missing, [], `index.html 用到但字串表缺少的鍵：${missing.join('、')}`);
});

test('ED1 的 JS 檔案裡所有 t(…) 鍵都存在', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  const here = path.dirname(fileURLToPath(import.meta.url));

  const files = ['main.js', 'fileops.js', 'preview.js', 'store.js'];
  const resolve = resolveKey;

  const missing = [];
  const used = new Set();
  for (const file of files) {
    const src = readFileSync(path.join(here, file), 'utf8');
    // 只抓真正的 t( 呼叫（排除 createElement('div') 這種結尾巧合）
    for (const m of src.matchAll(/(?:^|[^\w$.])t\(\s*'([A-Za-z][A-Za-z0-9_.]*)'/g)) {
      const key = m[1];
      if (!key.includes('.')) continue;
      used.add(key);
      for (const loc of LOCALES) {
        if (typeof resolve(loc, key) !== 'string') missing.push(`${file} → ${loc}:${key}`);
      }
    }
  }
  assert.ok(used.size > 30, `t() 使用量太少（${used.size}），掃描可能失效`);
  assert.deepEqual(missing, [], `JS 用到但字串表缺少的鍵：${[...new Set(missing)].join('、')}`);
});
