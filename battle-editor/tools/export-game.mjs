#!/usr/bin/env node
/**
 * tools/export-game.mjs — 把一個遭遇／攻擊匯出成「單一 HTML、file:// 雙擊即可玩」的可遊玩檔。
 *
 * 用法：
 *   node tools/export-game.mjs <遭遇名或攻擊名> [選項]
 *
 * 選項：
 *   --kind encounter|attack  指定作品種類（省略時先找遭遇、再找攻擊）
 *   --out <檔案>             輸出路徑（預設 <名字>.html）
 *   --lang zh|en             介面／字型語言（預設 zh）
 *   --title "..."            標題畫面與 <title> 用的標題（預設作品 meta.name）
 *   --no-autoplay-toggle     不提供「自動演示」切換（也不打包 autoplay 模組）
 *   --root <battle-editor>   引擎／素材根目錄（預設本 repo）
 *   --works <作品根>         作品根（優先於 --root；預設讀 DR_WORKS）
 *   --json                   以 JSON 印出結果（給 serve.py / 測試用）
 *   --help                   說明
 *
 * 設計：
 * - 零外部依賴，只用 Node 標準庫。
 * - 引擎以 ES module 內嵌：每個模組改寫成 data: URL，放進 <script type="importmap">；
 *   模組內的靜態相對匯入改寫成合成絕對 URL（http://dr.local/<repo 相對路徑>），
 *   import.meta.url 換成同一合成基址，於是動態載入（engine/index.js 的 loadE2Module、
 *   encounter 的 loadModule）也能通過 import map 解析。整份 HTML 不需要任何對外請求。
 * - 素材索引直接內嵌為 <script type="application/json">，開機時轉成 Blob URL 交給
 *   engine/assets.js 的 loadAssets()（fetch(blob:) 在 file:// 可用，且函式庫不必修改）。
 *   索引裡的每個檔案（sprite 幀／音訊／字型圖與 glyphs JSON）都換成 data: URL。
 * - 資料讀取順序沿用 tools/pack.mjs（--works 優先，找不到退 samples/）。
 *
 * 產物只依賴瀏覽器：file://、無網路、無 fetch 外部檔案。
 */

import { readFileSync, realpathSync, statSync } from 'node:fs';
import { lstatIfPresent, writeOutput } from './file-output.mjs';
import { dirname, extname, join, resolve, relative, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compileSoulProfiles } from '../engine/soul-mechanics.js';

import {
  ASSETS_FORMAT,
  BATTLE_EDITOR,
  collectAttackRefs,
  dataPaths,
  findDocument,
  resolveWorks,
} from './pack.mjs';

/* ------------------------------------------------------------------ 常數 */

export const EXPORT_FORMAT = 'dr-battle-export/1';
export const TOOL_ID = 'dr-battle-editor/export-game.mjs';
export const DEFAULT_LANG = 'zh';
const LANGS = ['zh', 'en'];
const KINDS = ['encounter', 'attack'];

/** 引擎模組的合成基址（import map 的 key 前綴）。 */
const MODULE_BASE = 'http://dr.local/';

/** 依語言決定打包哪些字型（DTM.otf 4.34MB 不打包；缺 DTM 時渲染器退回系統字型，不是錯誤）。 */
const FONT_BASE = ['fnt_main', 'fnt_mainbig', 'fnt_small', 'fnt_tinynoelle', 'fnt_dotumche', 'fnt_main_wide'];
const FONT_ZH = ['fnt_main@zh', 'fnt_mainbig@zh', 'fnt_dotumche@zh', 'fnt_tinynoelle@zh'];

/**
 * 引擎內建、素材索引沒有也沒關係的名稱（REALTEST-2 V5）：
 * - spr_graze*：擦彈遮罩與外框由 engine/graze-mask.js 內建的點陣資料畫，名稱只出現在註解；
 * - snd_cancel / snd_move / snd_nosound：選單 UI 音效，缺素材時靜默（SPEC：缺音效不報錯）。
 * 這些不算「作品缺素材」，不列入 warnings，只在 info 提一行。
 */
export const ENGINE_BUILTIN_ASSETS = {
  sprites: /^spr_graze(appear|mask)(_[a-z0-9]+)?$/,
  audio: new Set(['snd_cancel', 'snd_move', 'snd_nosound']),
};

/** 渲染器寫死、資料檔不一定會提到的 sprite（缺檔只會畫洋紅佔位方塊，不會拋錯，但畫面會壞）。 */
const ESSENTIAL_SPRITES = [
  'spr_heart',
  'spr_tplogo',
  'spr_headkris',
  'spr_headsusie',
  'spr_headralsei',
  'spr_btfight',
  'spr_btact',
  'spr_bttech',
  'spr_btitem',
  'spr_btspare',
  'spr_btdefend',
  'spr_btitem_grey',
  'spr_krisb_idle',
  'spr_susieb_idle',
  'spr_ralseib_idle',
  'spr_noelleb_idle',
  'spr_battlebg_0',
];

/** 文件裡「值是音訊名稱」的欄位（其餘用通用字串掃描＋引擎原始碼掃描補漏）。 */
const AUDIO_KEYS = new Set(['bgm', 'sound', 'track', 'music', 'sfx', 'voice', 'audio']);

/** 渲染器原始碼（掃寫死的 sprite 名；這些檔案本身也會進模組圖）。 */
const RENDERER_SOURCES = ['engine/render.js', 'engine/render-hud.js', 'engine/render-encounter.js'];

const MIME_TYPES = {
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.opus': 'audio/ogg',
  '.otf': 'font/otf',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json',
  '.txt': 'text/plain',
};

/* ------------------------------------------------------------------ 錯誤 */

export class ExportError extends Error {
  constructor(message, { code = 'error', details = null } = {}) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
    this.details = details || {};
  }
}

function asExportError(err) {
  if (err instanceof ExportError) return err;
  if (err && typeof err === 'object' && typeof err.code === 'string') {
    return new ExportError(err.message || String(err), { code: err.code, details: err.details });
  }
  return new ExportError(err && err.message ? err.message : String(err), { code: 'error' });
}

/* ------------------------------------------------------------------ 小工具 */

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch (_err) {
    return false;
  }
}

function readJsonFile(file) {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return JSON.parse(text);
}

function toPosix(p) {
  return String(p).split('\\').join('/');
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** JSON 塞進 <script> 時把 '<' 換成 \u003c（合法 JSON，且不會提前結束 script）。 */
function scriptJsonText(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function resolveRel(fromRel, spec) {
  const dir = posix.dirname(toPosix(fromRel));
  const target = posix.normalize(posix.join(dir === '.' ? '' : dir, spec));
  if (target.startsWith('..')) {
    throw new ExportError(`模組匯入路徑超出根目錄：${fromRel} → ${spec}`, {
      code: 'bad_module_path',
      details: { from: fromRel, spec },
    });
  }
  return target.replace(/^\/+/, '');
}

/* ------------------------------------------------------------ 作品檔解析 */

/** 建立（可被 --root 覆寫的）資料路徑；其餘欄位沿用 pack.mjs 的定義。 */
export function exportPaths(rootAbs, works = null) {
  const root = resolve(rootAbs || BATTLE_EDITOR);
  const base = dataPaths(works || null);
  return {
    ...base,
    battleEditor: root,
    // locations 會隨 works 改變（dataPaths 已處理）；這裡只固定 repo 層級的樣本與引擎素材。
    samplesDir: join(root, 'samples'),
    sampleEncountersDir: join(root, 'samples', 'encounters'),
    sampleAttacksDir: join(root, 'samples', 'attacks'),
    assetsDir: process.env.DR_ASSETS ? resolve(process.env.DR_ASSETS) : join(root, 'assets'),
  };
}

/** 判斷作品是否含有可用的 demo 腳本（決定要不要提供自動演示切換）。 */
export function hasDemoDoc(kind, doc) {
  if (!doc || typeof doc !== 'object') return false;
  const demo = doc.demo;
  if (!demo || typeof demo !== 'object' || Array.isArray(demo)) return false;
  if (Object.keys(demo).length === 0) return false;
  if (kind === 'encounter') {
    return Array.isArray(demo.turns) && demo.turns.length > 0 ? true : Object.keys(demo).length > 0;
  }
  return true;
}

/**
 * 依序在作品根（paths）與 repo 根（fallbackPaths）找文件：
 * 作品根優先，找不到再退回 repo 的 attacks/encounters/ 與 samples/。
 * @returns {{document:object, source:string, file:string}|null}
 */
export function lookupDocument(kind, name, paths, fallbackPaths = null) {
  const hit = findDocument(kind, name, paths);
  if (hit || !fallbackPaths) return hit;
  return findDocument(kind, name, fallbackPaths);
}

/**
 * 找出作品與（遭遇時的）所有攻擊檔。
 * @returns {{kind:string, name:string, title:string, primary:object, documents:object[], attacks:Object<string,object>, warnings:string[]}}
 */
export function resolveWork({ name, kind = null, paths, fallbackPaths = null }) {
  if (typeof name !== 'string' || !name.trim()) {
    throw new ExportError('缺少作品名稱', { code: 'bad_request' });
  }
  if (kind !== null && !KINDS.includes(kind)) {
    throw new ExportError(`未知的作品種類：${JSON.stringify(kind)}（只接受 encounter / attack）`, {
      code: 'bad_request',
      details: { allowed: KINDS },
    });
  }
  const cleanName = name.trim();
  const warnings = [];

  let resolvedKind = kind;
  let found = null;
  if (resolvedKind) {
    found = findDocument(resolvedKind, cleanName, paths);
    if (!found) {
      throw new ExportError(`找不到${resolvedKind === 'encounter' ? '遭遇' : '攻擊'}：${cleanName}`, {
        code: 'not_found',
        details: { kind: resolvedKind, name: cleanName },
      });
    }
  } else {
    for (const candidate of ['encounter', 'attack']) {
      const hit = lookupDocument(candidate, cleanName, paths, fallbackPaths);
      if (hit) {
        resolvedKind = candidate;
        found = hit;
        break;
      }
    }
    if (!found) {
      throw new ExportError(`找不到遭遇或攻擊：${cleanName}`, {
        code: 'not_found',
        details: { name: cleanName },
      });
    }
  }

  const primary = found.document;
  const meta = primary && typeof primary.meta === 'object' && primary.meta ? primary.meta : {};
  const title = typeof meta.name === 'string' && meta.name.trim() ? meta.name.trim() : cleanName;
  const documents = [primary];
  const sourceFiles = [found.file];
  const attacks = Object.create(null);
  if (resolvedKind === 'encounter') {
    const refs = [...collectAttackRefs(primary)].sort();
    const missing = [];
    for (const ref of refs) {
      const hit = lookupDocument('attack', ref, paths, fallbackPaths);
      if (!hit) {
        missing.push(ref);
        continue;
      }
      attacks[ref] = hit.document;
      documents.push(hit.document);
      sourceFiles.push(hit.file);
    }
    if (missing.length) {
      throw new ExportError(`遭遇引用的攻擊檔不存在：${missing.join('、')}`, {
        code: 'missing_attacks',
        details: { missing },
      });
    }
  }

  return { kind: resolvedKind, name: cleanName, title, primary, documents, attacks, warnings, sourceFiles };
}

/* --------------------------------------------------------------- 素材表 */

/** 讀主 assets/index.json，並在作品根有 custom.index.json 時合併自訂素材（比照 serve.py）。 */
export function loadAssetTables(paths) {
  const indexPath = join(paths.assetsDir || join(paths.battleEditor, 'assets'), 'index.json');
  if (!isFile(indexPath)) {
    throw new ExportError(`找不到素材索引：${toPosix(indexPath)}`, {
      code: 'missing_assets',
      details: { path: toPosix(indexPath) },
    });
  }
  let index;
  try {
    index = readJsonFile(indexPath);
  } catch (err) {
    throw new ExportError(`素材索引不是合法 JSON：${err.message}`, { code: 'missing_assets' });
  }
  const tables = {
    format: typeof index.format === 'string' ? index.format : ASSETS_FORMAT,
    sprites: { ...(index.sprites || {}) },
    audio: { ...(index.audio || {}) },
    fonts: { ...(index.fonts || {}) },
    customIndexPath: null,
  };
  if (paths.works) {
    const customPath = join(paths.works, 'assets', 'custom.index.json');
    if (isFile(customPath)) {
      let custom = null;
      try {
        custom = readJsonFile(customPath);
      } catch (_err) {
        custom = null;
      }
      if (custom && typeof custom === 'object') {
        for (const section of ['sprites', 'audio']) {
          const entries = custom[section];
          if (!entries || typeof entries !== 'object') continue;
          for (const [key, value] of Object.entries(entries)) {
            if (!value || typeof value !== 'object') continue;
            tables[section][key] = { ...value, custom: true };
          }
        }
        tables.customIndexPath = customPath;
      }
    }
  }
  return tables;
}

/** 找到素材條目指向的實際檔案（主索引相對 assets/、自訂素材可落在 assets/custom/）。 */
export function findAssetFile(relPath, entry, paths) {
  const clean = toPosix(relPath).replace(/^\/+/, '');
  if (!clean) return null;
  const parts = clean.split('/');
  if (parts.some((part) => part === '..' || part === '')) return null;
  const candidates = [];
  const pushDir = (dir) => {
    if (!dir) return;
    candidates.push(join(dir, clean));
    if (!clean.startsWith('custom/')) candidates.push(join(dir, 'custom', clean));
  };
  if (entry && entry.custom) {
    if (paths.works) pushDir(join(paths.works, 'assets'));
    pushDir(paths.assetsDir || join(paths.battleEditor, 'assets'));
  } else {
    pushDir(paths.assetsDir || join(paths.battleEditor, 'assets'));
    if (paths.works) pushDir(join(paths.works, 'assets'));
  }
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

function fileToDataUrl(file) {
  const ext = extname(file).toLowerCase();
  const mime = MIME_TYPES[ext] || 'application/octet-stream';
  const bytes = readFileSync(file);
  return { dataUrl: `data:${mime};base64,${bytes.toString('base64')}`, bytes: bytes.length };
}

function assetDataUrl(relPath, entry, paths, missing) {
  const file = findAssetFile(relPath, entry, paths);
  if (!file) {
    missing.push(toPosix(relPath));
    return null;
  }
  return fileToDataUrl(file);
}

/* ------------------------------------------------------------ 素材收集 */

function walkDocStrings(node, visit, key = '') {
  if (Array.isArray(node)) {
    for (const item of node) walkDocStrings(item, visit, key);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [childKey, value] of Object.entries(node)) {
    if (typeof value === 'string') visit(value, childKey);
    else walkDocStrings(value, visit, childKey);
  }
}

function scanNamed(sources, pattern) {
  const names = new Set();
  for (const src of sources) {
    if (typeof src !== 'string') continue;
    for (const match of src.matchAll(pattern)) names.add(match[0]);
  }
  return names;
}

/**
 * 收集實際會用到的 sprite / audio。
 * - 文件裡任何等於索引 key 的字串 → sprite；bgm/sound/track… 的值 → audio。
 * - 引擎／渲染器原始碼裡寫死的 spr_* / snd_* → 有索引才收（渲染器硬需求）。
 */
export function collectUsedAssets({ documents = [], tables, moduleSources = [] }) {
  const sprites = new Set();
  const audio = new Set();
  const missing = { sprites: new Set(), audio: new Set() };
  /** 引擎內建（索引沒有也正常）的名稱：不算缺素材。 */
  const builtin = { sprites: new Set(), audio: new Set() };

  for (const name of ESSENTIAL_SPRITES) {
    if (tables.sprites[name]) sprites.add(name);
  }

  const addSprite = (value) => {
    if (typeof value !== 'string' || !value) return;
    if (tables.sprites[value]) sprites.add(value);
    else if (ENGINE_BUILTIN_ASSETS.sprites.test(value)) builtin.sprites.add(value);
    else if (/^spr_[A-Za-z0-9_]+$/.test(value) && !value.endsWith('_')) missing.sprites.add(value);
  };
  const addAudio = (value) => {
    if (typeof value !== 'string' || !value) return;
    if (tables.audio[value]) audio.add(value);
    else if (ENGINE_BUILTIN_ASSETS.audio.has(value)) builtin.audio.add(value);
    else if (/^snd_[A-Za-z0-9_]+$/.test(value) || /\.(ogg|wav|mp3|m4a)$/i.test(value)) {
      missing.audio.add(value);
    }
  };

  for (const doc of documents) {
    walkDocStrings(doc, (value, key) => {
      if (tables.sprites[value]) sprites.add(value);
      if (AUDIO_KEYS.has(key)) addAudio(value);
    });
  }

  for (const name of scanNamed(moduleSources, /\bspr_[A-Za-z0-9_]+/g)) addSprite(name);
  for (const name of scanNamed(moduleSources, /\bsnd_[A-Za-z0-9_]+/g)) addAudio(name);

  return {
    sprites,
    audio,
    missing: {
      sprites: [...missing.sprites].sort(),
      audio: [...missing.audio].sort(),
    },
    builtin: {
      sprites: [...builtin.sprites].sort(),
      audio: [...builtin.audio].sort(),
    },
  };
}

/** 依語言選字型；缺字型只警告（渲染器會退回），不是錯誤。 */
export function selectFonts(tables, lang) {
  const wanted = lang === 'zh' ? [...FONT_BASE, ...FONT_ZH] : [...FONT_BASE];
  const fonts = [];
  const missing = [];
  for (const name of wanted) {
    if (tables.fonts[name]) fonts.push(name);
    else missing.push(name);
  }
  return { fonts, missing };
}

/**
 * 產生精簡版素材索引（保持 assets/index.json 形狀，engine/assets.js 不必修改）。
 * @returns {{index:object, stats:object, missing:string[], warnings:string[]}}
 */
export function buildAssetBundle({ tables, used, fonts, paths }) {
  const missing = [];
  const warnings = [];
  const stats = { sprites: 0, frames: 0, audio: 0, fonts: 0, bytes: 0 };
  const embeddedBytes = { sprites: 0, bgm: 0, sfx: 0, fonts: 0 };

  const out = {
    format: tables.format || ASSETS_FORMAT,
    sprites: {},
    audio: {},
    fonts: {},
  };

  for (const name of [...used.sprites].sort()) {
    const entry = tables.sprites[name];
    const frameList = Array.isArray(entry.frames) ? entry.frames : [];
    const frames = [];
    for (const relPath of frameList) {
      const data = assetDataUrl(relPath, entry, paths, missing);
      if (data) {
        frames.push(data.dataUrl);
        embeddedBytes.sprites += data.dataUrl.length;
        stats.bytes += data.bytes;
      }
    }
    if (!frames.length) continue;
    const compact = { frames };
    for (const key of ['w', 'h', 'ox', 'oy']) {
      if (Number.isFinite(Number(entry[key]))) compact[key] = Number(entry[key]);
    }
    out.sprites[name] = compact;
    stats.sprites += 1;
    stats.frames += frames.length;
  }

  for (const name of [...used.audio].sort()) {
    const entry = tables.audio[name];
    const relPath = typeof entry.file === 'string' ? entry.file : entry.path;
    if (typeof relPath !== 'string' || !relPath) {
      warnings.push(`音訊條目缺少檔案路徑：${name}`);
      continue;
    }
    const data = assetDataUrl(relPath, entry, paths, missing);
    if (!data) continue;
    const compact = { file: data.dataUrl };
    if (entry.loop === true) compact.loop = true;
    if (Number.isFinite(Number(entry.volume))) compact.volume = Number(entry.volume);
    if (typeof entry.kind === 'string') compact.kind = entry.kind;
    for (const key of ['loopStart', 'loopEnd']) {
      if (Number.isFinite(entry[key])) compact[key] = entry[key];
    }
    out.audio[name] = compact;
    embeddedBytes[entry.kind === 'music' || entry.loop === true ? 'bgm' : 'sfx'] += data.dataUrl.length;
    stats.bytes += data.bytes;
    stats.audio += 1;
  }

  for (const name of fonts) {
    const entry = tables.fonts[name];
    if (!entry || typeof entry !== 'object') {
      warnings.push(`字型條目不存在：${name}`);
      continue;
    }
    if (entry.kind === 'otf') {
      const data = assetDataUrl(entry.file, entry, paths, missing);
      if (!data) continue;
      out.fonts[name] = { kind: 'otf', file: data.dataUrl };
      embeddedBytes.fonts += data.dataUrl.length;
      if (typeof entry.family === 'string') out.fonts[name].family = entry.family;
      stats.bytes += data.bytes;
      stats.fonts += 1;
      continue;
    }
    if (typeof entry.image !== 'string' || typeof entry.glyphs !== 'string') {
      warnings.push(`點陣字型條目缺少 image/glyphs：${name}`);
      continue;
    }
    const image = assetDataUrl(entry.image, entry, paths, missing);
    const glyphs = assetDataUrl(entry.glyphs, entry, paths, missing);
    if (!image || !glyphs) continue;
    const compact = { image: image.dataUrl, glyphs: glyphs.dataUrl };
    for (const key of ['size', 'lineHeight', 'emSize']) {
      if (Number.isFinite(Number(entry[key]))) compact[key] = Number(entry[key]);
    }
    if (typeof entry.lang === 'string') compact.lang = entry.lang;
    if (typeof entry.base === 'string') compact.base = entry.base;
    out.fonts[name] = compact;
    stats.bytes += image.bytes + glyphs.bytes;
    embeddedBytes.fonts += image.dataUrl.length + glyphs.dataUrl.length;
    stats.fonts += 1;
  }

  if (missing.length) {
    throw new ExportError(`素材檔案不存在：${missing.slice(0, 8).join('、')}`, {
      code: 'missing_assets',
      details: { missing },
    });
  }

  return { index: out, stats, embeddedBytes, missing, warnings };
}

/* ------------------------------------------------------------- 模組圖 */

const MODULE_IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])(\.{1,2}\/[^'"\n]+)\1/g;
const MODULE_LITERAL_RE = /(['"])(\.{1,2}\/[^'"\n]+?\.(?:js|mjs))\1/g;

/**
 * 把註解（// 與 /* *\/）換成空白，長度與換行保持不變。
 * 掃描／改寫 import 前先跑這個：引擎原始碼的 JSDoc 範例裡也會出現 `from './x.js'`，
 * 不先遮掉會被誤認成真的匯入。
 */
export function blankComments(source) {
  const text = String(source);
  const out = text.split('');
  const blank = (index) => {
    if (text[index] !== '\n' && text[index] !== '\r') out[index] = ' ';
  };
  let state = 'code';
  let depth = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    const next = text[i + 1];
    if (state === 'code' || state === 'expr') {
      if (ch === '/' && next === '/') {
        blank(i);
        blank(i + 1);
        i += 2;
        state = state === 'expr' ? 'exprLine' : 'line';
        continue;
      }
      if (ch === '/' && next === '*') {
        blank(i);
        blank(i + 1);
        i += 2;
        state = state === 'expr' ? 'exprBlock' : 'block';
        continue;
      }
      if (ch === "'") {
        state = state === 'expr' ? 'exprSingle' : 'single';
        i += 1;
        continue;
      }
      if (ch === '"') {
        state = state === 'expr' ? 'exprDouble' : 'double';
        i += 1;
        continue;
      }
      if (ch === '`') {
        state = 'template';
        i += 1;
        continue;
      }
      if (state === 'expr') {
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth <= 0) state = 'template';
        }
      }
      i += 1;
      continue;
    }
    if (state === 'line' || state === 'exprLine') {
      if (ch === '\n') {
        state = state === 'line' ? 'code' : 'expr';
        i += 1;
        continue;
      }
      blank(i);
      i += 1;
      continue;
    }
    if (state === 'block' || state === 'exprBlock') {
      if (ch === '*' && next === '/') {
        blank(i);
        blank(i + 1);
        i += 2;
        state = state === 'block' ? 'code' : 'expr';
        continue;
      }
      blank(i);
      i += 1;
      continue;
    }
    if (state === 'single' || state === 'double' || state === 'exprSingle' || state === 'exprDouble') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      const quote = state === 'single' || state === 'exprSingle' ? "'" : '"';
      if (ch === quote) {
        state = state === 'exprSingle' ? 'expr' : state === 'exprDouble' ? 'expr' : 'code';
        i += 1;
        continue;
      }
      if (ch === '\n') {
        state = state === 'exprSingle' || state === 'exprDouble' ? 'expr' : 'code';
      }
      i += 1;
      continue;
    }
    if (state === 'template') {
      if (ch === '\\') {
        i += 2;
        continue;
      }
      if (ch === '`') {
        state = 'code';
        i += 1;
        continue;
      }
      if (ch === '$' && next === '{') {
        state = 'expr';
        depth = 1;
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

/** 找出「真的在程式碼裡」的相對匯入（回傳 {spec,start,end}，start/end 指 spec 本身）。 */
function importSpecifiers(blanked) {
  const found = [];
  for (const match of blanked.matchAll(MODULE_IMPORT_RE)) {
    const spec = match[2];
    const start = match.index + match[0].length - 1 - spec.length;
    found.push({ spec, start, end: start + spec.length });
  }
  return found;
}

function moduleDeps(rel, src, rootAbs) {
  const blanked = blankComments(src);
  const deps = new Set();
  for (const { spec } of importSpecifiers(blanked)) {
    deps.add(resolveRel(rel, spec));
  }
  // 動態載入常把路徑當一般字串（loadModule('./flow.js')）→ 存在的模組也一併打包。
  for (const match of blanked.matchAll(MODULE_LITERAL_RE)) {
    const dep = resolveRel(rel, match[2]);
    if (isFile(join(rootAbs, dep))) deps.add(dep);
  }
  return deps;
}

/** 從進入點遞迴收集相對匯入的模組（Map<repo 相對路徑, 原始碼>）。 */
export function collectModules(rootAbs, entryRels) {
  const modules = new Map();
  const queue = [...entryRels];
  while (queue.length) {
    const rel = queue.shift();
    if (modules.has(rel)) continue;
    const abs = join(rootAbs, rel);
    if (!isFile(abs)) {
      throw new ExportError(`找不到引擎模組：${toPosix(rel)}`, {
        code: 'missing_module',
        details: { module: toPosix(rel) },
      });
    }
    const src = readFileSync(abs, 'utf8');
    modules.set(rel, src);
    for (const dep of moduleDeps(rel, src, rootAbs)) queue.push(dep);
  }
  return modules;
}

/** 決定要打包哪些引擎模組。 */
export function moduleEntries(kind, autoplay) {
  const entries = [
    'engine/index.js',
    'engine/assets.js',
    'engine/render.js',
    'engine/input.js',
    'engine/audio.js',
  ];
  if (kind === 'encounter') {
    entries.push(
      'engine/encounter/index.js',
      'engine/encounter/flow.js',
      'engine/render-encounter.js',
    );
  }
  if (autoplay) {
    entries.push('engine/autoplay/index.js');
    if (kind === 'encounter') entries.push('engine/autoplay/encounter.js');
  }
  return [...new Set(entries)];
}

function moduleUrl(rel) {
  return MODULE_BASE + toPosix(rel);
}

/** 把模組原始碼改寫成可內嵌版本（相對匯入 → 合成絕對 URL、import.meta.url → 合成基址）。 */
export function rewriteModuleSource(rel, src) {
  const text = String(src);
  const blanked = blankComments(text);
  const base = moduleUrl(rel);
  const edits = [];
  for (const { spec, start, end } of importSpecifiers(blanked)) {
    edits.push({ start, end, text: moduleUrl(resolveRel(rel, spec)) });
  }
  const token = 'import.meta.url';
  let from = 0;
  for (;;) {
    const at = blanked.indexOf(token, from);
    if (at < 0) break;
    edits.push({ start: at, end: at + token.length, text: JSON.stringify(base) });
    from = at + token.length;
  }
  edits.sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  for (const edit of edits) {
    if (edit.start < cursor) continue;
    out += text.slice(cursor, edit.start) + edit.text;
    cursor = edit.end;
  }
  out += text.slice(cursor);
  return out;
}

/** 產生 import map（key：合成 URL；value：模組的 data: URL）。 */
export function buildImportMap(modules) {
  const imports = {};
  const rels = [...modules.keys()].sort();
  for (const rel of rels) {
    const source = rewriteModuleSource(rel, modules.get(rel));
    imports[moduleUrl(rel)] = `data:text/javascript;base64,${Buffer.from(source, 'utf8').toString('base64')}`;
  }
  return imports;
}

/* ------------------------------------------------------------- 應用程式 */

/**
 * 內嵌在 HTML 的遊戲應用（單一 inline module）。
 * 只依賴 import map 裡的合成 URL 與 DOM；所有設定從 #dr-game-config 讀取。
 */
const APP_SOURCE = `
import { normalizeFrameInput } from 'http://dr.local/engine/input.js';

const cfg = JSON.parse(document.getElementById('dr-game-config').textContent);
const L = cfg.lang === 'en'
  ? {
      start: 'Press Z / Enter to start',
      restart: 'Press Z / Enter to play again',
      controls: 'Arrows / WASD move · Z / Enter confirm · X / Shift cancel · C debug · F fullscreen · M mute',
      auto: 'Autoplay',
      autoOff: 'off',
      autoDemo: 'demo',
      autoBot: 'AI',
      mutedOn: 'muted',
      loadError: 'The game failed to start',
      results: { defeat: 'Defeat', flee: 'Fled', survived: 'Survived' },
    }
  : {
      start: '按 Z / Enter 開始',
      restart: '按 Z / Enter 重來',
      controls: '方向鍵 / WASD 移動 · Z / Enter 確認 · X / Shift 取消 · C 除錯 · F 全螢幕 · M 靜音',
      auto: '自動演示',
      autoOff: '關閉',
      autoDemo: '示範',
      autoBot: 'AI',
      mutedOn: '靜音',
      loadError: '遊戲啟動失敗',
      results: { defeat: '失敗', flee: '逃離', survived: '生還' },
    };

const els = {
  stage: document.getElementById('stage'),
  canvas: document.getElementById('game'),
  title: document.getElementById('title-screen'),
  titleText: document.getElementById('title-text'),
  titleHint: document.getElementById('title-hint'),
  end: document.getElementById('end-screen'),
  endText: document.getElementById('end-text'),
  endHint: document.getElementById('end-hint'),
  hint: document.getElementById('hint'),
  autoBtn: document.getElementById('auto-btn'),
};

const warnings = [];
let assets = null;
let audio = null;
let battle = null;
let encounter = null;
let pilot = null;
let factory = null;
let makeAutopilot = null;
let phase = 'title';
let resultCode = null;
let autoMode = 'off';
let muted = false;
let debug = false;
let antialias = false;
let pageRaf = 0;
let pageLast = 0;
let pageAcc = 0;

const DR = {
  ready: false,
  error: null,
  start: start,
  restart: restart,
  setAutoplay: setAutoplay,
  getAutoplay: function () { return autoMode; },
  getInfo: getInfo,
  getState: getState,
  getWarnings: function () { return warnings.slice(0, 12); },
  getConfig: function () { return cfg; },
};
window.__drExport = DR;

document.title = cfg.title;
els.titleText.textContent = cfg.title;
els.titleHint.textContent = L.start;
els.endHint.textContent = L.restart;
els.hint.textContent = L.controls;
if (cfg.auto) {
  els.autoBtn.hidden = false;
  els.autoBtn.addEventListener('click', function () { cycleAuto(); });
}
fitStage();
window.addEventListener('resize', fitStage);
document.addEventListener('fullscreenchange', fitStage);
window.addEventListener('keydown', onKeyDown);
main().catch(function (err) {
  DR.error = err && err.message ? err.message : String(err);
  console.error('[game] 啟動失敗：', err);
  els.titleText.textContent = L.loadError;
  els.titleHint.textContent = String(DR.error);
});

function fitStage() {
  const availW = Math.max(320, window.innerWidth - 16);
  const availH = Math.max(240, window.innerHeight - 84);
  let scale = Math.min(Math.floor(availW / 640), Math.floor(availH / 480));
  if (!Number.isFinite(scale) || scale < 1) scale = 1;
  if (!antialias) scale = Math.max(1, scale);
  const w = 640 * scale;
  const h = 480 * scale;
  els.canvas.style.width = w + 'px';
  els.canvas.style.height = h + 'px';
  els.stage.style.width = w + 'px';
  els.stage.style.height = h + 'px';
}

function autoLabel() {
  if (autoMode === 'demo') return L.autoDemo;
  if (autoMode === 'bot') return L.autoBot;
  return L.autoOff;
}

function syncChrome() {
  if (cfg.auto) els.autoBtn.textContent = L.auto + '：' + autoLabel();
  const hint = phase === 'ended' && els.end.hidden ? L.restart : L.controls;
  els.hint.textContent = hint + (muted ? ' · ' + L.mutedOn : '');
}

async function main() {
  const assetsMod = await import('http://dr.local/engine/assets.js');
  const indexText = document.getElementById('dr-asset-index').textContent;
  const indexUrl = URL.createObjectURL(new Blob([indexText], { type: 'application/json' }));
  assets = await assetsMod.loadAssets(indexUrl);
  if (assets && assets.error) warnings.push('素材索引：' + assets.error.message);
  try { await assets.preloadFonts(cfg.fonts || []); } catch (err) { warnings.push('字型預載：' + String(err)); }
  try { await assets.preload(); } catch (err) { warnings.push('素材預載：' + String(err)); }
  DR.assets = assets;
  const audioMod = await import('http://dr.local/engine/audio.js');
  audio = audioMod.createAudio(assets);
  if (audio && typeof audio.setMuted === 'function') audio.setMuted(muted);
  if (cfg.auto) {
    const apMod = await import('http://dr.local/engine/autoplay/index.js');
    makeAutopilot = apMod.createAutopilot;
  }
  if (cfg.kind === 'encounter') {
    const encMod = await import('http://dr.local/engine/encounter/index.js');
    factory = encMod.createEncounter;
  } else {
    const battleMod = await import('http://dr.local/engine/index.js');
    factory = battleMod.createBattle;
  }
  syncChrome();
  DR.ready = true;
}

async function ensureEngine() {
  if (cfg.kind === 'encounter') {
    if (encounter) return encounter;
    encounter = factory({
      canvas: els.canvas,
      assets: assets,
      audio: audio,
      mode: 'play',
      resolveAttack: function (name) {
        const docs = cfg.attacks || {};
        return Promise.resolve(Object.prototype.hasOwnProperty.call(docs, name) ? docs[name] : null);
      },
    });
    encounter.on('end', function (payload) { finishEncounter(payload); });
    encounter.setOptions({ lang: cfg.lang, scale: 1, muted: muted, showHitboxes: debug, showGrid: debug });
    await encounter.load(cfg.doc);
    return encounter;
  }
  if (battle) return battle;
  battle = factory({ canvas: els.canvas, assets: assets, mode: 'play' });
  battle.on('end', function () { finishAttack(); });
  battle.setOptions({ lang: cfg.lang, scale: 1, muted: muted, showHitboxes: debug, showGrid: debug });
  battle.load(cfg.doc);
  return battle;
}

function resetEngine() {
  if (battle && typeof battle.reset === 'function') battle.reset();
  if (encounter && typeof encounter.reset === 'function') encounter.reset();
}

function applyHandles() {
  if (battle) battle.setOptions({ muted: muted, showHitboxes: debug, showGrid: debug });
  if (encounter) encounter.setOptions({ muted: muted, showHitboxes: debug, showGrid: debug });
  if (audio && typeof audio.setMuted === 'function') audio.setMuted(muted);
}

function startAttackBgm() {
  if (!audio || cfg.kind === 'encounter') return;
  const settings = cfg.doc && cfg.doc.settings;
  const track = settings && settings.bgm;
  if (!track) return;
  try { audio.playBgm(track, { fade: 0.35 }); } catch (_err) { /* 缺素材時靜默 */ }
}

function applyAutoplay() {
  stopPageLoop();
  if (cfg.kind === 'encounter') {
    if (autoMode === 'off') {
      if (encounter) encounter.play();
    } else if (encounter) {
      encounter.pause();
      armAuto();
    }
    return;
  }
  if (autoMode === 'off') {
    if (battle) battle.play();
    startAttackBgm();
  } else if (battle) {
    battle.pause();
    armAuto();
  }
}

function armAuto() {
  stopPageLoop();
  pilot = null;
  if (!makeAutopilot || autoMode === 'off') return;
  if (cfg.kind === 'encounter') {
    const next = makeAutopilot({
      kind: 'encounter',
      doc: cfg.doc,
      mode: autoMode,
      resolveAttackDoc: function (name) {
        const docs = cfg.attacks || {};
        return Object.prototype.hasOwnProperty.call(docs, name) ? docs[name] : null;
      },
    });
    pilot = next;
    next.ready.then(function () {
      if (pilot !== next || phase !== 'playing') return;
      collectWarnings(next);
      try { next.reset(); } catch (_err) { /* 忽略 */ }
      startPageLoop();
    }).catch(function (err) {
      warnings.push('自動演示載入失敗：' + String(err));
      startPageLoop();
    });
    return;
  }
  const next = makeAutopilot({ kind: 'attack', doc: cfg.doc, mode: autoMode });
  pilot = next;
  collectWarnings(next);
  startPageLoop();
}

function collectWarnings(source) {
  const list = source && Array.isArray(source.warnings) ? source.warnings : [];
  for (const message of list) {
    if (!warnings.includes(message)) warnings.push(message);
  }
}

async function start() {
  if (!DR.ready || phase !== 'title') return false;
  phase = 'playing';
  els.title.hidden = true;
  els.end.hidden = true;
  syncChrome();
  await ensureEngine();
  applyHandles();
  resetEngine();
  applyAutoplay();
  return true;
}

async function restart() {
  if (!DR.ready || phase === 'title') return false;
  phase = 'playing';
  els.end.hidden = true;
  els.title.hidden = true;
  resultCode = null;
  syncChrome();
  await ensureEngine();
  applyHandles();
  resetEngine();
  applyAutoplay();
  return true;
}

async function setAutoplay(next) {
  if (!cfg.auto) return 'off';
  const mode = next === 'demo' || next === 'bot' ? next : 'off';
  autoMode = mode;
  syncChrome();
  if (phase === 'title') return autoMode;
  await ensureEngine();
  applyHandles();
  resetEngine();
  applyAutoplay();
  syncChrome();
  return autoMode;
}

function cycleAuto() {
  const order = ['off', 'demo', 'bot'];
  const index = order.indexOf(autoMode);
  setAutoplay(order[(index + 1) % order.length]);
}

function startPageLoop() {
  stopPageLoop();
  pageLast = 0;
  pageAcc = 0;
  const stepMs = 1000 / 30;
  const tick = function (now) {
    pageRaf = 0;
    if (phase !== 'playing' || !pilot) return;
    if (!pageLast) pageLast = now;
    let dt = now - pageLast;
    pageLast = now;
    if (!Number.isFinite(dt) || dt < 0) dt = stepMs;
    if (dt > 250) dt = 250;
    pageAcc += dt;
    let guard = 0;
    while (pageAcc >= stepMs && guard < 6) {
      pageAcc -= stepMs;
      guard += 1;
      try {
        if (!stepAuto()) return;
      } catch (err) {
        const message = '自動演示錯誤：' + (err && err.message ? err.message : String(err));
        if (!warnings.includes(message)) warnings.push(message);
        stopPageLoop();
        return;
      }
    }
    pageRaf = requestAnimationFrame(tick);
  };
  pageRaf = requestAnimationFrame(tick);
}

function stopPageLoop() {
  if (pageRaf) {
    try { cancelAnimationFrame(pageRaf); } catch (_err) { /* 忽略 */ }
  }
  pageRaf = 0;
  pageLast = 0;
  pageAcc = 0;
}

function stepAuto() {
  if (phase !== 'playing' || !pilot) return false;
  if (cfg.kind === 'encounter') {
    if (!encounter) return false;
    let state = encounter.getState();
    const formatted = pilot.input(state, state.frame);
    collectWarnings(pilot);
    // encounter.step(n, input) 沒有回傳值：結束與否要看 state.result / encounter.result。
    encounter.step(1, formatted);
    state = encounter.getState();
    if (encounter.result || (state && state.result)) {
      finishEncounter({ result: (state && state.result) || (encounter && encounter.result), frame: state && state.frame });
      return false;
    }
    return true;
  }
  if (!battle) return false;
  const sim = battle.engine;
  const state = battle.getState();
  const raw = pilot.input(state, state.frame);
  collectWarnings(pilot);
  try {
    const queue = sim && typeof sim.drainSfx === 'function' ? sim.drainSfx() : [];
    if (audio && queue && queue.length) audio.playAll(queue);
  } catch (_err) { /* 忽略 */ }
  if (sim && typeof sim.stepFrame === 'function') sim.stepFrame(normalizeFrameInput(raw));
  const after = battle.getState();
  if (after && after.ended) {
    finishAttack();
    return false;
  }
  return true;
}

function finishAttack() {
  if (phase !== 'playing') return;
  stopPageLoop();
  pilot = null;
  const state = battle && typeof battle.getState === 'function' ? battle.getState() : null;
  const party = state && Array.isArray(state.party) ? state.party : [];
  const dead = party.some(function (member) { return member && typeof member.hp === 'number' && member.hp <= 0; });
  showResult(dead ? 'defeat' : 'survived', state ? state.frame : 0);
}

function finishEncounter(payload) {
  if (phase !== 'playing') return;
  stopPageLoop();
  pilot = null;
  const state = encounter && typeof encounter.getState === 'function' ? encounter.getState() : null;
  const code = (payload && payload.result) || (state && state.result) || (encounter && encounter.result) || 'victory';
  showResult(code, (payload && payload.frame) || (state && state.frame) || 0);
}

function showResult(code, frame) {
  phase = 'ended';
  resultCode = code;
  els.end.hidden = code === 'victory' || code === 'spared';
  if (!els.end.hidden) els.endText.textContent = L.results[code] || String(code);
  DR.resultFrame = frame;
  syncChrome();
}

function currentFrame() {
  if (cfg.kind === 'encounter') {
    if (!encounter) return 0;
    try {
      const state = encounter.getState();
      return state && typeof state.frame === 'number' ? state.frame : 0;
    } catch (_err) { return 0; }
  }
  return battle && typeof battle.frame === 'number' ? battle.frame : 0;
}

function getInfo() {
  return {
    ready: DR.ready,
    error: DR.error,
    kind: cfg.kind,
    title: cfg.title,
    lang: cfg.lang,
    phase: phase,
    state: phase,
    result: resultCode,
    frame: currentFrame(),
    auto: autoMode,
    autoplay: Boolean(cfg.auto),
    hasDemo: Boolean(cfg.hasDemo),
    muted: muted,
    debug: debug,
    warnings: warnings.slice(0, 12),
    // 自動演示的除錯欄位（CDP 驗收用；不影響遊戲）
    autoPilot: Boolean(pilot),
    pageLoop: Boolean(pageRaf),
    pilotInfo: pilot && typeof pilot.describe === 'function'
      ? (function () { try { return pilot.describe(); } catch (err) { return String(err); } })()
      : null,
  };
}

function getState() {
  if (battle && typeof battle.getState === 'function') return battle.getState();
  if (encounter && typeof encounter.getState === 'function') return encounter.getState();
  return null;
}

function onKeyDown(event) {
  if (!event || event.defaultPrevented) return;
  const code = event.code || '';
  const confirm = code === 'KeyZ' || code === 'Enter' || code === 'NumpadEnter' || code === 'Space';
  if (confirm && (phase === 'title' || phase === 'ended')) {
    event.preventDefault();
    if (event.repeat) return;
    if (phase === 'title') start();
    else restart();
    return;
  }
  if (code === 'KeyF') {
    event.preventDefault();
    toggleFullscreen();
    return;
  }
  if (code === 'KeyM') {
    toggleMute();
    return;
  }
  if (code === 'KeyC') {
    toggleDebug();
    return;
  }
  if (code === 'KeyP' && cfg.auto) {
    cycleAuto();
  }
}

function toggleFullscreen() {
  try {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
  } catch (_err) { /* 忽略 */ }
  fitStage();
}

function toggleMute() {
  muted = !muted;
  applyHandles();
  syncChrome();
}

function toggleDebug() {
  debug = !debug;
  applyHandles();
}
`;

/* ------------------------------------------------------------- HTML 組裝 */

export const APP_SCRIPT = APP_SOURCE;

const STYLE_TEXT = `
html,body{margin:0;height:100%;background:#000;color:#e8e8e8;font-family:'Microsoft JhengHei','Noto Sans TC',system-ui,sans-serif;overflow:hidden}
body{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
#stage{position:relative;line-height:0;background:#000;box-shadow:0 0 0 1px #222,0 8px 32px rgba(0,0,0,.6)}
#game{display:block;image-rendering:pixelated;image-rendering:crisp-edges;image-rendering:-moz-crisp-edges;background:#000}
.overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:rgba(0,0,0,.74);line-height:1.35;padding:16px;box-sizing:border-box}
.overlay h1{margin:0 0 14px;font-size:clamp(22px,4.6vmin,46px);letter-spacing:.08em;text-shadow:0 0 14px rgba(96,176,255,.75),0 0 3px #fff}
.overlay p{margin:0;font-size:clamp(12px,2vmin,19px);opacity:.86;max-width:36em}
#toolbar{display:flex;align-items:center;gap:12px;font-size:12px;opacity:.72;user-select:none;max-width:96vw;flex-wrap:wrap;justify-content:center}
#auto-btn{font:inherit;color:#dfe8ff;background:#1a2340;border:1px solid #3c558f;border-radius:999px;padding:4px 12px;cursor:pointer}
#auto-btn:hover{background:#24305a}
[hidden]{display:none!important}
`;

/** 只有繁體中文語系時才替 <html lang> 用 zh-Hant，其餘 en。 */
function htmlLang(lang) {
  return lang === 'en' ? 'en' : 'zh-Hant';
}

function localizedDefaults(lang) {
  if (lang === 'en') {
    return {
      start: 'Press Z / Enter to start',
      restart: 'Press Z / Enter to play again',
      controls: 'Arrows / WASD move · Z / Enter confirm · X / Shift cancel · C debug · F fullscreen · M mute',
      auto: 'Autoplay',
    };
  }
  return {
    start: '按 Z / Enter 開始',
    restart: '按 Z / Enter 重來',
    controls: '方向鍵 / WASD 移動 · Z / Enter 確認 · X / Shift 取消 · C 除錯 · F 全螢幕 · M 靜音',
    auto: '自動演示',
  };
}

/**
 * 組出最終 HTML。
 * @param {{config:object, assetIndexText:string, importMap:object, title:string, lang:string}} parts
 */
export function buildGameHtml({ config, assetIndexText, importMap, title, lang }) {
  const texts = localizedDefaults(lang);
  const autoButton = config.auto
    ? `<button id="auto-btn" type="button" hidden>${escapeHtml(texts.auto)}</button>`
    : '';
  return `<!doctype html>
<html lang="${htmlLang(lang)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${STYLE_TEXT}</style>
<script type="importmap">${scriptJsonText({ imports: importMap })}</script>
</head>
<body>
<div id="stage">
<canvas id="game" width="640" height="480"></canvas>
<div id="title-screen" class="overlay">
<h1 id="title-text">${escapeHtml(title)}</h1>
<p id="title-hint">${escapeHtml(texts.start)}</p>
</div>
<div id="end-screen" class="overlay" hidden>
<h1 id="end-text">—</h1>
<p id="end-hint">${escapeHtml(texts.restart)}</p>
</div>
</div>
<div id="toolbar">
<span id="hint">${escapeHtml(texts.controls)}</span>
${autoButton}
</div>
<script type="application/json" id="dr-asset-index">${assetIndexText}</script>
<script type="application/json" id="dr-game-config">${scriptJsonText(config)}</script>
<script type="module">${APP_SOURCE}
</script>
</body>
</html>
`;
}

/* ------------------------------------------------------------- 匯出主流程 */

/**
 * 執行匯出。
 * @param {object} options {name, kind, lang, title, autoplayToggle, root, works, out, cwd}
 * @returns {object} 摘要（JSON 可序列化）
 */
export function exportGame(options = {}) {
  const opts = options || {};
  try {
    const rootAbs = resolve(opts.root ? String(opts.root) : BATTLE_EDITOR);
    // sampleOnly：場景編輯器引用 samples/ 的遭遇時只讀範例，不碰作品根
    const works = opts.sampleOnly ? null : resolveWorks(opts.works === undefined ? null : opts.works);
    const lang = opts.lang === undefined || opts.lang === null || opts.lang === '' ? DEFAULT_LANG : String(opts.lang);
    if (!LANGS.includes(lang)) {
      throw new ExportError(`不支援的語言：${JSON.stringify(lang)}（只接受 zh / en）`, {
        code: 'bad_request',
        details: { allowed: LANGS },
      });
    }
    const paths = exportPaths(rootAbs, works);
    // 作品根優先；找不到再退回 repo 的 attacks/encounters/ 與 samples/（比照 serve.py 的可見範圍）。
    const fallbackPaths = works || opts.sampleOnly ? exportPaths(rootAbs, null) : null;
    const work = resolveWork({
      name: opts.name,
      kind: opts.kind === undefined ? null : opts.kind,
      paths: opts.sampleOnly ? { ...paths, encountersDir: paths.sampleEncountersDir, attacksDir: paths.sampleAttacksDir } : paths,
      fallbackPaths,
    });
    const attacks = work.kind === 'attack' ? { [work.name]: work.primary } : work.attacks;
    for (const [name, attack] of Object.entries(attacks)) {
      const { errors } = compileSoulProfiles(attack);
      if (errors.length) {
        const { path, message } = errors[0];
        throw new ExportError(name + ': ' + path + ': ' + message, { code: 'bad_request', details: { name, errors } });
      }
    }
    const cwd = opts.cwd ? resolve(String(opts.cwd)) : process.cwd();
    // bundleOnly：場景編輯器要的是遭遇資料與素材表，不寫 HTML 檔
    const outPath = opts.bundleOnly ? null : opts.out ? resolve(cwd, String(opts.out)) : join(cwd, `${work.name}.html`);
    if (outPath && lstatIfPresent(outPath)) {
      const target = realpathSync(outPath);
      if (work.sourceFiles.some((file) => realpathSync(file) === target)) {
        throw new ExportError('匯出檔不能覆蓋來源檔：' + outPath, { code: 'bad_request' });
      }
    }
    const title =
      typeof opts.title === 'string' && opts.title.trim() ? opts.title.trim() : work.title;

    const demoAvailable = hasDemoDoc(work.kind, work.primary);
    const autoplay = opts.autoplayToggle === false ? false : demoAvailable;

    const tables = loadAssetTables(paths);
    const entries = moduleEntries(work.kind, autoplay);
    const modules = collectModules(rootAbs, entries);
    const moduleSources = [...modules.values()];
    // 渲染器原始碼即使不在 graph 也要掃（正常情況下都在）。
    for (const rel of RENDERER_SOURCES) {
      if (modules.has(rel)) continue;
      const abs = join(rootAbs, rel);
      if (isFile(abs)) moduleSources.push(readFileSync(abs, 'utf8'));
    }

    const allDocs = [work.primary, ...Object.values(work.attacks || {})];
    const used = collectUsedAssets({ documents: allDocs, tables, moduleSources });
    const fontSel = selectFonts(tables, lang);
    const warnings = [...work.warnings];
    for (const name of fontSel.missing) warnings.push(`字型未打包（渲染器將退回）：${name}`);
    for (const name of used.missing.sprites) warnings.push(`作品或引擎引用但索引沒有的 sprite：${name}`);
    for (const name of used.missing.audio) warnings.push(`作品或引擎引用但索引沒有的音訊：${name}`);
    // 引擎內建素材（索引沒有也正常）不是作品缺素材 → 只留一行 info，不進 warnings
    const info = [];
    const builtinNames = [...((used.builtin && used.builtin.sprites) || []), ...((used.builtin && used.builtin.audio) || [])];
    if (builtinNames.length) {
      info.push(`引擎內建素材未打包（索引沒有，執行時由引擎內建資料或靜默處理，可忽略）：${builtinNames.join('、')}`);
    }

    // 場景的入戰轉場（classic）會播這兩個音效
    if (opts.entryAudio) {
      for (const name of ['snd_impact', 'snd_weaponpull_fast'])
        if (Object.hasOwn(tables.audio, name)) used.audio.add(name);
    }
    const bundle = buildAssetBundle({ tables, used, fonts: fontSel.fonts, paths });
    warnings.push(...bundle.warnings);

    const importMap = opts.bundleOnly && opts.includeModules === false ? {} : buildImportMap(modules);
    const config = {
      format: EXPORT_FORMAT,
      kind: work.kind,
      name: work.name,
      title,
      lang,
      auto: autoplay,
      hasDemo: demoAvailable,
      fonts: fontSel.fonts,
      doc: work.primary,
    };
    if (work.kind === 'encounter') config.attacks = work.attacks;
    if (opts.bundleOnly) return { config, assets: bundle.index, imports: importMap, warnings };

    const assetIndexText = scriptJsonText(bundle.index);
    const html = buildGameHtml({ config, assetIndexText, importMap, title, lang });

    writeOutput(outPath, html);

    const moduleBytes = Object.values(importMap).reduce((sum, url) => sum + url.length, 0);
    return {
      ok: true,
      tool: TOOL_ID,
      format: EXPORT_FORMAT,
      kind: work.kind,
      name: work.name,
      title,
      lang,
      autoplay,
      hasDemo: demoAvailable,
      out: outPath,
      bytes: Buffer.byteLength(html, 'utf8'),
      modules: modules.size,
      moduleBytes,
      sizeBreakdown: { ...bundle.embeddedBytes, engine: moduleBytes },
      assets: {
        sprites: bundle.stats.sprites,
        frames: bundle.stats.frames,
        audio: bundle.stats.audio,
        fonts: bundle.stats.fonts,
        bytes: bundle.stats.bytes,
      },
      warnings,
      info,
      source: {
        kind: work.kind,
        name: work.name,
        attacks: Object.keys(work.attacks || {}).sort(),
      },
    };
  } catch (err) {
    throw asExportError(err);
  }
}

/* ------------------------------------------------------------------ CLI */

function parseArgs(argv) {
  const boolFlags = new Set(['json', 'no-autoplay-toggle', 'help']);
  const valueFlags = new Set(['kind', 'out', 'lang', 'title', 'root', 'works']);
  const flags = {};
  const positional = [];
  const args = Array.isArray(argv) ? argv.slice() : [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== 'string') continue;
    if (arg === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      let name = arg.slice(2);
      let value = null;
      const eq = name.indexOf('=');
      if (eq >= 0) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (boolFlags.has(name)) {
        flags[name] = true;
        continue;
      }
      if (!valueFlags.has(name)) {
        throw new ExportError(`未知的選項：--${name}`, { code: 'bad_request', details: { option: name } });
      }
      if (value === null) {
        const next = args[i + 1];
        if (next === undefined || (typeof next === 'string' && next.startsWith('--'))) {
          throw new ExportError(`選項 --${name} 缺少值`, { code: 'bad_request', details: { option: name } });
        }
        value = next;
        i += 1;
      }
      flags[name] = value;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

const USAGE_TEXT = `用法：node tools/export-game.mjs <遭遇名或攻擊名> [選項]

選項：
  --kind encounter|attack  指定作品種類（省略時先找遭遇、再找攻擊）
  --out <檔案>             輸出路徑（預設 <名字>.html）
  --lang zh|en             介面／字型語言（預設 zh）
  --title "..."            標題畫面的標題（預設作品 meta.name）
  --no-autoplay-toggle     不提供自動演示切換
  --root <battle-editor>   引擎／素材根目錄
  --works <作品根>         作品根（優先於 --root；預設讀 DR_WORKS）
  --json                   以 JSON 印出結果
  --help                   顯示本說明
`;

function printHuman(summary) {
  const mb = (summary.bytes / (1024 * 1024)).toFixed(2);
  const assets = summary.assets;
  const size = summary.sizeBreakdown;
  const lines = [
    `已匯出可遊玩 HTML：${summary.out}`,
    `  大小：${summary.bytes} bytes（${mb} MiB）`,
    `  內嵌大小（bytes）：BGM ${size.bgm}、音效 ${size.sfx}、sprite ${size.sprites}、字型 ${size.fonts}、引擎 ${size.engine}`,
    `  內嵌：${summary.modules} 個引擎模組、${assets.sprites} 張 sprite（${assets.frames} 幀）、${assets.audio} 個音訊、${assets.fonts} 個字型`,
    `  作品：${summary.name}（${summary.kind}）／語言 ${summary.lang}／自動演示 ${summary.autoplay ? '開' : '關'}`,
  ];
  if (summary.warnings.length) {
    lines.push(`  警告（${summary.warnings.length}）：`);
    for (const message of summary.warnings) lines.push(`    - ${message}`);
  }
  for (const message of summary.info || []) lines.push(`  備註：${message}`);
  return lines.join('\n');
}

function emit(payload, { json = false, code = 0 } = {}) {
  if (json) {
    process.stdout.write(JSON.stringify(payload) + '\n');
  } else if (payload.ok) {
    process.stdout.write(printHuman(payload) + '\n');
  } else {
    process.stderr.write(`錯誤（${payload.code}）：${payload.error}\n`);
  }
  return code;
}

export function main(argv = process.argv.slice(2)) {
  let json = false;
  try {
    const { flags, positional } = parseArgs(argv);
    json = Boolean(flags.json);
    if (flags.help) {
      process.stdout.write(USAGE_TEXT);
      return 0;
    }
    if (positional.length !== 1) {
      throw new ExportError(
        positional.length === 0 ? '缺少作品名稱' : `只接受一個作品名稱（收到 ${positional.length} 個）`,
        { code: 'bad_request' },
      );
    }
    const summary = exportGame({
      name: positional[0],
      kind: flags.kind === undefined ? null : flags.kind,
      out: flags.out === undefined ? null : flags.out,
      lang: flags.lang === undefined ? DEFAULT_LANG : flags.lang,
      title: flags.title === undefined ? null : flags.title,
      autoplayToggle: flags['no-autoplay-toggle'] ? false : true,
      root: flags.root === undefined ? null : flags.root,
      works: flags.works === undefined ? null : flags.works,
    });
    return emit(summary, { json, code: 0 });
  } catch (err) {
    const error = asExportError(err);
    return emit(
      {
        ok: false,
        tool: TOOL_ID,
        code: error.code,
        error: error.message,
        ...(error.details || {}),
      },
      { json, code: 1 },
    );
  }
}

const invokedDirectly = (() => {
  try {
    return resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url));
  } catch (_err) {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2));
}
