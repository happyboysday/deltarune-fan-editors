#!/usr/bin/env node
/**
 * tools/pack.mjs — 作品包（`.drpack.json`）匯出／匯入。
 *
 * 作品包 = 一個遭遇（或單一攻擊）＋它引用到的所有攻擊檔＋用到的自訂素材
 * （索引條目 + PNG/音訊以 base64 內嵌）。用來在兩台機器／兩個工作目錄之間搬作品，
 * 不需要手動複製 attacks/、encounters/、assets/custom/。
 *
 * 用法：
 *   node tools/pack.mjs export <遭遇名|攻擊名> [--kind encounter|attack]
 *                              [--works <作品根>] [--out <檔案.drpack.json>]
 *                              [--json] [--allow-missing]
 *   node tools/pack.mjs import <檔案.drpack.json> [--works <作品根>]
 *                              [--mode abort|rename|overwrite]
 *                              [--rename-on-conflict] [--overwrite]
 *                              [--json]
 *   node tools/pack.mjs inspect <檔案.drpack.json> [--json]
 *
 * 作品根（--works，未給時讀環境變數 DR_WORKS）：
 *   * 有作品根： attacks/、encounters/、assets/custom/、history/、trash/ 都在作品根下。
 *   * 沒有作品根：使用 battle-editor/attacks/、battle-editor/encounters/（預設草稿區）。
 *   * 相對路徑以「執行時的工作目錄」解析（與 serve.py 一致）。
 *
 * 格式 `dr-battle-pack/1`：
 *   {
 *     "format": "dr-battle-pack/1",
 *     "meta":   { "name": "...", "kind": "encounter"|"attack",
 *                 "createdAt": "<ISO>", "tool": "dr-battle-editor/pack.mjs", "version": 1 },
 *     "encounters": { "<名稱>": { "source": "works"|"project"|"sample", "document": {...}, "text"?: "原始檔文字" } },
 *     "attacks":    { "<名稱>": { "source": "works"|"project"|"sample", "document": {...}, "text"?: "原始檔文字" } },
 *     （text：匯出時的原始檔文字。匯入時若與 document 語意相同就原樣寫回，避免手排版的
 *       JSON 被重新 stringify 造成整檔 diff；改名匯入或 text 被改壞時退回 canonical 排版。）
 *     "assets": { "sprites": {...}, "audio": {...} },   // 只放 custom:true 的索引條目
 *     "files":  { "custom/xxx.png": "<base64>", ... }   // 相對於 assets/ 的 posix 路徑
 *   }
 *
 * 匯入規則：
 *   * 預設 abort：任何名稱衝突（遭遇／攻擊／自訂素材同名）就中止，列出所有衝突。
 *   * rename：遭遇／攻擊改成 `名字_2`、`名字_3`…，並同步改寫遭遇裡對攻擊的引用
 *     （`turns[].attack`、`{cmd:"attack",attack:"…"}`）與自訂素材名（sprite/bgm/sound/track）；
 *     自訂素材的檔名／索引條目也一起改名。
 *   * overwrite：直接覆蓋同名檔與索引條目。
 *
 * 匯入後若含自訂素材，會提示重跑 `python tools/build_custom_assets.py`（本檔已先寫出一份
 * 可用的 custom.index.json，重跑只是重新掃描 PNG／原點，屬於保養動作）。
 *
 * 設計：作品包只有這一份實作（Node）。serve.py 的 `/api/pack/*` 直接以子程序呼叫本檔，
 * 不另外在 Python 端複製一套格式邏輯——避免兩份實作漂移，也讓 CLI 與伺服器行為必然一致。
 *
 * 零外部依賴（只用 Node 標準庫），Windows / macOS / Linux 皆可。
 */

import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, posix, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAttackRefs } from '../engine/encounter/attack-refs.js';
import { lstatIfPresent, stageOutput, writeOutput } from './file-output.mjs';

/* ------------------------------------------------------------------ 常數 */

export const PACK_FORMAT = 'dr-battle-pack/1';
export const ASSETS_FORMAT = 'dr-battle-assets/1';
export const TOOL_ID = 'dr-battle-editor/pack.mjs';
export const PACK_VERSION = 1;

/** battle-editor/（本檔在 tools/ 底下） */
export const BATTLE_EDITOR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const NAME_RE = /^[A-Za-z0-9_\-\u4e00-\u9fa5]+$/;
const KIND_FORMAT = {
  encounter: 'dr-battle-encounter/1',
  attack: 'dr-battle-attack/1',
};
const KIND_COLLECTION = {
  encounter: 'encounters',
  attack: 'attacks',
};
/** 文件裡「會用到素材」的欄位名稱（掃描用；多收不會壞，只是多打包） */
const SPRITE_KEYS = new Set(['sprite', 'background']);
const AUDIO_KEYS = new Set(['bgm', 'sound', 'track']);
const WINDOWS_DEVICE = /^(?:con|conin\$|conout\$|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i;
const PORTABLE_SEGMENT = /^[^<>:"/\\|?*\x00-\x1f]+$/u;

function validSegment(part) {
  return PORTABLE_SEGMENT.test(part) && !/[. ]$/.test(part) && !WINDOWS_DEVICE.test(part);
}

function validName(name) {
  return NAME_RE.test(name) && validSegment(name);
}
const MAX_PACK_FILES_BYTES = 512 * 1024 * 1024;

/* --------------------------------------------------------------- 小工具 */

export function toPosix(p) {
  return String(p).split('\\').join('/').split('/').join('/');
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch (_err) {
    return false;
  }
}

function parseFiniteJSON(text) {
  return JSON.parse(text, (key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) {
      throw new SyntaxError('JSON 數字超出範圍：' + key);
    }
    return item;
  });
}

function readJSON(file) {
  const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  return parseFiniteJSON(text);
}

function documentText(document, text) {
  if (typeof text === 'string' && text.trim()) {
    try {
      if (JSON.stringify(parseFiniteJSON(text.replace(/^\uFEFF/, ''))) === JSON.stringify(document)) {
        const body = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
        return body.endsWith('\n') ? body : body + '\n';
      }
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  return JSON.stringify(document, null, 2) + '\n';
}

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function displayPath(p) {
  const rel = relative(BATTLE_EDITOR, resolve(p));
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return toPosix(rel);
  return toPosix(resolve(p));
}

class PackError extends Error {
  constructor(message, { code = 'error', details = null } = {}) {
    super(message);
    this.name = 'PackError';
    this.code = code;
    this.details = details || {};
  }
}

/* ------------------------------------------------------------ 作品根路徑 */

/**
 * 解析作品根的可執行路徑。`explicit` 是命令列 --works；未給時讀 DR_WORKS。
 * 相對路徑以目前工作目錄解析（與 serve.py 的啟動行為一致）。
 * @returns {string|null} 絕對路徑；null 代表使用 battle-editor 預設草稿區。
 */
export function resolveWorks(explicit = null) {
  let raw = explicit;
  if (raw === undefined || raw === null || raw === '') raw = process.env.DR_WORKS || null;
  if (raw === undefined || raw === null || raw === '') return null;
  return resolve(process.cwd(), String(raw));
}

/**
 * 依作品根算出資料目錄。
 * @param {string|null} works
 */
export function dataPaths(works = null) {
  const worksRoot = works ? resolve(works) : null;
  const dataRoot = worksRoot || BATTLE_EDITOR;
  const assetsDir = join(dataRoot, 'assets');
  return {
    works: worksRoot,
    dataRoot,
    attacksDir: join(dataRoot, 'attacks'),
    encountersDir: join(dataRoot, 'encounters'),
    assetsDir,
    customAssetsDir: join(assetsDir, 'custom'),
    customIndexPath: join(assetsDir, 'custom.index.json'),
    battleEditor: BATTLE_EDITOR,
    samplesDir: join(BATTLE_EDITOR, 'samples'),
    sampleEncountersDir: join(BATTLE_EDITOR, 'samples', 'encounters'),
    sampleAttacksDir: join(BATTLE_EDITOR, 'samples', 'attacks'),
  };
}

/** 找一個作品檔；回傳 {document, source, file} 或 null。 */
export function findDocument(kind, name, paths) {
  if (kind !== 'encounter' && kind !== 'attack') {
    throw new PackError(`未知的作品種類：${kind}`, { code: 'bad_request' });
  }
  if (typeof name !== 'string' || !validName(name)) {
    throw new PackError(`檔名不合法（僅允許 A-Za-z0-9_、- 與中文）：${JSON.stringify(name)}`, {
      code: 'invalid_name',
    });
  }
  // 作品根（或預設草稿區）優先；找不到才退到 samples/（唯讀樣本）。
  const primary = kind === 'encounter' ? paths.encountersDir : paths.attacksDir;
  const sampleDirs =
    kind === 'encounter'
      ? [paths.sampleEncountersDir]
      : [paths.samplesDir, paths.sampleAttacksDir];
  const candidates = [
    { dir: primary, source: paths.works ? 'works' : 'project' },
    ...sampleDirs.map((dir) => ({ dir, source: 'sample' })),
  ];
  for (const candidate of candidates) {
    const file = join(candidate.dir, `${name}.json`);
    if (!isFile(file)) continue;
    let document;
    let text = null;
    try {
      text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
      document = parseFiniteJSON(text);
    } catch (err) {
      throw new PackError(`讀取 ${displayPath(file)} 失敗：${err.message}`, { code: 'bad_file' });
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new PackError(`${displayPath(file)} 的最外層必須是 JSON 物件`, { code: 'bad_file' });
    }
    const expected = KIND_FORMAT[kind];
    if (document.format !== undefined && document.format !== expected) {
      throw new PackError(
        `${displayPath(file)} 的 format 是 ${JSON.stringify(document.format)}，預期 ${expected}`,
        { code: 'bad_file' },
      );
    }
    return { document, source: candidate.source, file, text };
  }
  return null;
}

export { collectAttackRefs };

/* --------------------------------------------------------------- 素材掃描 */

/** 遞迴收集文件裡用到的自訂素材名稱（sprite/background 與 bgm/sound/track）。 */
function collectAssetRefs(node, acc) {
  if (Array.isArray(node)) {
    for (const item of node) collectAssetRefs(item, acc);
    return;
  }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (SPRITE_KEYS.has(key)) acc.sprites.add(value);
      else if (AUDIO_KEYS.has(key)) acc.audio.add(value);
    } else {
      collectAssetRefs(value, acc);
    }
  }
}

/** 找 index 條目指到的實際檔案；回傳絕對路徑或 null。 */
function findAssetFile(relPath, paths) {
  const clean = toPosix(relPath);
  const key = clean.startsWith('custom/') ? clean : 'custom/' + clean;
  return isCustomFileKey(key) && targetExists(paths.dataRoot, 'assets/' + key) ? join(paths.assetsDir, key) : null;
}

/**
 * 依文件內容收集「用到的自訂素材」。只認 custom.index.json 裡的條目
 * （官方素材體積太大且 repo 本來就有，不進作品包）。
 * @returns {{assets:{sprites:Object, audio:Object}, files:Object, missing:string[]}}
 */
export function gatherAssets(documents, paths) {
  const refs = { sprites: new Set(), audio: new Set() };
  for (const doc of documents) collectAssetRefs(doc, refs);

  const customIndex = readCustomIndex(paths);
  const spritesTable = customIndex.sprites || {};
  const audioTable = customIndex.audio || {};

  const assets = { sprites: Object.create(null), audio: Object.create(null) };
  const files = {};
  const missing = [];

  const addFile = (relPath) => {
    if (typeof relPath !== 'string' || !relPath) return;
    const file = findAssetFile(relPath, paths);
    if (!file) {
      missing.push(relPath);
      return;
    }
    const key = toPosix(relative(paths.assetsDir, file));
    if (!isCustomFileKey(key)) {
      missing.push(relPath);
      return;
    }
    if (files[key] !== undefined) return;
    files[key] = readFileSync(file).toString('base64');
  };

  for (const name of [...refs.sprites].sort()) {
    if (!Object.hasOwn(spritesTable, name)) continue;
    const entry = spritesTable[name];
    if (!entry || typeof entry !== 'object') continue;
    const copy = { ...entry, custom: true };
    assets.sprites[name] = copy;
    const frames = Array.isArray(copy.frames) ? copy.frames : [];
    for (const frame of frames) addFile(frame);
  }
  for (const name of [...refs.audio].sort()) {
    if (!Object.hasOwn(audioTable, name)) continue;
    const entry = audioTable[name];
    if (!entry || typeof entry !== 'object') continue;
    const copy = { ...entry, custom: true };
    assets.audio[name] = copy;
    if (typeof copy.file === 'string') addFile(copy.file);
  }
  return { assets, files, missing };
}

/* --------------------------------------------------------------- 匯出 */

/**
 * 產生作品包（記憶體物件）。找不到名稱時回 null；引用攻擊缺檔時丟 PackError。
 * @returns {{pack:object, warnings:string[], missingAttacks:string[]}}
 */
export function buildPack({ kind = null, name, works = null, allowMissing = false } = {}) {
  const paths = dataPaths(works);
  if (typeof name !== 'string' || !name) {
    throw new PackError('缺少作品名稱', { code: 'bad_request' });
  }
  if (kind !== null && kind !== undefined && !Object.hasOwn(KIND_FORMAT, kind)) {
    throw new PackError(`kind 必須是 encounter 或 attack（收到 ${JSON.stringify(kind)}）`, {
      code: 'bad_request',
    });
  }
  let resolvedKind = kind || null;
  let found = null;
  if (resolvedKind) {
    found = findDocument(resolvedKind, name, paths);
  } else {
    // 未指定 kind：先找遭遇、再找攻擊（遭遇包住攻擊，較常用）。
    found = findDocument('encounter', name, paths);
    if (found) resolvedKind = 'encounter';
    else {
      found = findDocument('attack', name, paths);
      if (found) resolvedKind = 'attack';
    }
  }
  if (!found) {
    throw new PackError(`找不到${resolvedKind === 'attack' ? '攻擊' : '遭遇'}檔：${name}`, {
      code: 'not_found',
      details: { kind: resolvedKind, name },
    });
  }

  const pack = {
    format: PACK_FORMAT,
    meta: {
      name,
      kind: resolvedKind,
      createdAt: new Date().toISOString(),
      tool: TOOL_ID,
      version: PACK_VERSION,
    },
    encounters: Object.create(null),
    attacks: Object.create(null),
    assets: { sprites: {}, audio: {} },
    files: {},
  };
  const warnings = [];
  const missingAttacks = [];
  const documents = [];
  const sourceFiles = [found.file, paths.customIndexPath];

  if (resolvedKind === 'encounter') {
    pack.encounters[name] = packEntry(found);
    documents.push(found.document);
    for (const ref of [...collectAttackRefs(found.document)].sort()) {
      const attack = findDocument('attack', ref, paths);
      if (!attack) {
        missingAttacks.push(ref);
        continue;
      }
      pack.attacks[ref] = packEntry(attack);
      documents.push(attack.document);
      sourceFiles.push(attack.file);
    }
    if (missingAttacks.length > 0) {
      const message =
        `遭遇 ${name} 引用了 ${missingAttacks.length} 個找不到的攻擊：` +
        missingAttacks.join('、') +
        '（作品根與 samples/ 都沒有）';
      if (!allowMissing) {
        throw new PackError(message, {
          code: 'missing_attacks',
          details: { kind: resolvedKind, name, missing: missingAttacks },
        });
      }
      warnings.push(message);
    }
  } else {
    pack.attacks[name] = packEntry(found);
    documents.push(found.document);
  }

  const gathered = gatherAssets(documents, paths);
  if (gathered.missing.length > 0) {
    throw new PackError(
      `自訂素材索引指到的檔案不存在：${gathered.missing.join('、')}`,
      { code: 'missing_assets', details: { missing: gathered.missing } },
    );
  }
  pack.assets = gathered.assets;
  pack.files = gathered.files;
  sourceFiles.push(...Object.keys(pack.files).map((key) => join(paths.assetsDir, key)));
  return { pack, warnings, missingAttacks, paths, sourceFiles };
}

/** 作品包條目：document（機器讀）＋ text（原始檔文字，匯入時用來保留排版）。 */
function packEntry(found) {
  const entry = { source: found.source, document: found.document };
  if (typeof found.text === 'string' && found.text) entry.text = found.text.replace(/\r\n/g, '\n');
  return entry;
}

export function packToText(pack) {
  return `${JSON.stringify(pack, null, 2)}\n`;
}

/* --------------------------------------------------------------- 匯入 */

function isCustomFileKey(key) {
  return key.startsWith('custom/') && key.split('/').every(validSegment);
}

function validateFileTree(keys) {
  const files = new Set(keys.map((key) => key.toLowerCase()));
  if (files.size !== keys.length) {
    throw new PackError('作品包有重複的檔案路徑（不區分大小寫）', { code: 'bad_pack' });
  }
  for (const key of files) {
    for (let parent = dirname(key); parent !== '.'; parent = dirname(parent)) {
      if (files.has(toPosix(parent))) {
        throw new PackError('作品包的檔案與目錄路徑重疊：' + key, { code: 'bad_pack' });
      }
    }
  }
}

function normalizePackEntries(map, kind) {
  const entries = [];
  if (map === undefined || map === null) return entries;
  if (typeof map !== 'object' || Array.isArray(map)) {
    throw new PackError(`作品包的 ${KIND_COLLECTION[kind]} 必須是物件`, { code: 'bad_pack' });
  }
  for (const [name, value] of Object.entries(map)) {
    if (!validName(name)) {
      throw new PackError(`作品包裡的${kind === 'encounter' ? '遭遇' : '攻擊'}名稱不合法：${JSON.stringify(name)}`, {
        code: 'bad_pack',
      });
    }
    let document = value;
    let source = 'pack';
    let text = null;
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      value.document &&
      typeof value.document === 'object' &&
      !Array.isArray(value.document)
    ) {
      document = value.document;
      source = typeof value.source === 'string' ? value.source : 'pack';
      text = typeof value.text === 'string' ? value.text : null;
    }
    if (!document || typeof document !== 'object' || Array.isArray(document)) {
      throw new PackError(`作品包裡的 ${name} 不是物件`, { code: 'bad_pack' });
    }
    const expected = KIND_FORMAT[kind];
    if (document.format !== undefined && document.format !== expected) {
      throw new PackError(`${name} 的 format 是 ${JSON.stringify(document.format)}，預期 ${expected}`, {
        code: 'bad_pack',
      });
    }
    entries.push({ name, document, source, text });
  }
  if (new Set(entries.map(({ name }) => name.toLowerCase())).size !== entries.length) {
    throw new PackError('作品包有重複的作品名稱（不區分大小寫）', { code: 'bad_pack' });
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function normalizePack(pack) {
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    throw new PackError('作品包的最外層必須是 JSON 物件', { code: 'bad_pack' });
  }
  if (pack.format !== PACK_FORMAT) {
    throw new PackError(`format 必須是 ${PACK_FORMAT}（收到 ${JSON.stringify(pack.format)}）`, {
      code: 'bad_pack',
    });
  }
  const encounters = normalizePackEntries(pack.encounters, 'encounter');
  const attacks = normalizePackEntries(pack.attacks, 'attack');
  if (encounters.length === 0 && attacks.length === 0) {
    throw new PackError('作品包裡沒有任何遭遇或攻擊', { code: 'bad_pack' });
  }
  const assetsIn = pack.assets && typeof pack.assets === 'object' ? pack.assets : {};
  const sprites = Object.create(null);
  const audio = Object.create(null);
  for (const [table, target, label] of [
    [assetsIn.sprites, sprites, 'sprite'],
    [assetsIn.audio, audio, 'audio'],
  ]) {
    if (table === undefined || table === null) continue;
    if (typeof table !== 'object' || Array.isArray(table)) {
      throw new PackError(`作品包的 assets.${label} 必須是物件`, { code: 'bad_pack' });
    }
    for (const [name, entry] of Object.entries(table)) {
      if (!name) {
        throw new PackError(`assets.${label} 有名稱不合法的條目`, { code: 'bad_pack' });
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new PackError(`assets.${label}.${name} 必須是物件`, { code: 'bad_pack' });
      }
      target[name] = { ...entry, custom: true };
    }
  }
  const files = Object.create(null);
  if (pack.files !== undefined && pack.files !== null) {
    if (typeof pack.files !== 'object' || Array.isArray(pack.files)) {
      throw new PackError('作品包的 files 必須是物件', { code: 'bad_pack' });
    }
    let total = 0;
    for (const [key, value] of Object.entries(pack.files)) {
      if (!isCustomFileKey(key)) {
        throw new PackError('作品包裡的檔案路徑不合法：' + JSON.stringify(key), { code: 'bad_pack' });
      }
      if (typeof value !== 'string') {
        throw new PackError('files.' + key + ' 必須是 base64 字串', { code: 'bad_pack' });
      }
      const buffer = Buffer.from(value, 'base64');
      if (buffer.toString('base64') !== value) {
        throw new PackError('files.' + key + ' 不是合法 base64', { code: 'bad_pack' });
      }
      total += buffer.length;
      if (total > MAX_PACK_FILES_BYTES) {
        throw new PackError('作品包內嵌檔案超過上限 ' + MAX_PACK_FILES_BYTES + ' bytes', { code: 'bad_pack' });
      }
      files[key] = buffer;
    }
  }
  validateFileTree(Object.keys(files));
  const referenced = new Set();
  for (const [table, field] of [[sprites, 'frames'], [audio, 'file']]) {
    for (const [name, entry] of Object.entries(table)) {
      const refs = field === 'frames' ? entry.frames : [entry.file];
      if (!Array.isArray(refs) || !refs.length) {
        throw new PackError('自訂素材缺少檔案：' + name, { code: 'bad_pack' });
      }
      const keys = refs.map((ref) => {
        const key = typeof ref === 'string' && (ref.startsWith('custom/') ? ref : 'custom/' + ref);
        if (!key || !Object.hasOwn(files, key)) {
          throw new PackError('自訂素材指向未打包的檔案：' + name + ' → ' + JSON.stringify(ref), { code: 'bad_pack' });
        }
        referenced.add(key);
        return key;
      });
      entry[field] = field === 'frames' ? keys : keys[0];
    }
  }
  if (referenced.size !== Object.keys(files).length) {
    throw new PackError('作品包含有未被自訂素材引用的檔案', { code: 'bad_pack' });
  }
  const meta = pack.meta && typeof pack.meta === 'object' ? pack.meta : {};
  return { meta, encounters, attacks, sprites, audio, files };
}

function uniqueName(base, taken) {
  if (!taken.has(base)) return base;
  let index = 2;
  while (taken.has(`${base}_${index}`)) index += 1;
  return `${base}_${index}`;
}

/** 把 `attack` 字串引用與素材名（sprite/background/bgm/sound/track）換成新名字。 */
function remapDocument(node, { attackMap, spriteMap, audioMap }) {
  if (Array.isArray(node)) return node.map((item) => remapDocument(item, { attackMap, spriteMap, audioMap }));
  if (!node || typeof node !== 'object') return node;
  const out = Object.create(null);
  for (const [key, value] of Object.entries(node)) {
    if (typeof value === 'string') {
      if (key === 'attack' && attackMap.has(value)) out[key] = attackMap.get(value);
      else if (SPRITE_KEYS.has(key) && spriteMap.has(value)) out[key] = spriteMap.get(value);
      else if (AUDIO_KEYS.has(key) && audioMap.has(value)) out[key] = audioMap.get(value);
      else out[key] = value;
    } else {
      out[key] = remapDocument(value, { attackMap, spriteMap, audioMap });
    }
  }
  return out;
}

/** 檢查既有路徑，不跟隨連結或 junction。 */
function targetExists(root, key) {
  let file = root;
  const parts = key.split('/');
  for (const [index, part] of parts.entries()) {
    file = join(file, part);
    const info = lstatIfPresent(file);
    if (!info) return false;
    const valid = index === parts.length - 1 ? info.isFile() : info.isDirectory();
    if (!valid || info.isSymbolicLink()) {
      throw new PackError('匯入目標不是一般檔案路徑：' + key, { code: 'bad_target' });
    }
  }
  return true;
}

function readCustomIndex(paths) {
  if (!targetExists(paths.dataRoot, 'assets/custom.index.json')) return {};
  try {
    const index = readJSON(paths.customIndexPath);
    if (!index || typeof index !== 'object' || Array.isArray(index)) throw new SyntaxError('需要 JSON 物件');
    for (const table of [index.sprites, index.audio]) {
      if (table !== undefined && (!table || typeof table !== 'object' || Array.isArray(table))) {
        throw new SyntaxError('素材索引表需要 JSON 物件');
      }
    }
    return index;
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    throw new PackError('無法讀取既有 custom.index.json：' + err.message, { code: 'bad_target' });
  }
}

function documentNames(paths, collection) {
  // 先檢查 collection 本身；缺少目錄可以在寫入時建立。
  const info = lstatIfPresent(paths[collection + 'Dir']);
  if (!info) return [];
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new PackError('作品目錄不是一般目錄：' + collection, { code: 'bad_target' });
  }
  return readdirSync(paths[collection + 'Dir'])
    .filter((file) => file.toLowerCase().endsWith('.json') && validName(file.slice(0, -5)));
}

function planImport(normalized, paths, mode) {
  const existingIndex = Object.keys(normalized.files).length ? readCustomIndex(paths) : {};
  const conflicts = [];
  const blocked = [];
  const addConflict = (kind, name, path) => conflicts.push({ kind, name, path });
  const maps = {};
  const documents = [];
  const availableAttacks = new Set();
  for (const [kind, collection] of Object.entries(KIND_COLLECTION)) {
    const existingFiles = new Set(documentNames(paths, collection));
    const existingNames = [...existingFiles].map((file) => file.slice(0, -5));
    const existing = new Set(existingNames.map((name) => name.toLowerCase()));
    const incoming = normalized[collection];
    const taken = new Set([...existing, ...incoming.map(({ name }) => name.toLowerCase())]);
    const map = new Map();
    maps[kind + 'Map'] = map;
    if (kind === 'attack') for (const name of existingNames) availableAttacks.add(name);
    for (const entry of incoming) {
      const { name } = entry;
      const key = collection + '/' + name + '.json';
      let target = name;
      if (existing.has(name.toLowerCase())) {
        addConflict(kind, name, key);
        if (mode === 'rename') {
          let n = 2;
          while (taken.has((target = name + '_' + n++).toLowerCase())) {}
          taken.add(target.toLowerCase());
          map.set(name, target);
        } else if (mode === 'overwrite' && !existingFiles.has(name + '.json')) {
          blocked.push(key);
        }
      }
      const destination = collection + '/' + target + '.json';
      targetExists(paths.dataRoot, destination);
      documents.push({ ...entry, kind, collection, target, destination });
      if (kind === 'attack') availableAttacks.add(target);
    }
  }

  const assets = [
    ['sprite', 'sprites', 'frames'],
    ['audio', 'audio', 'file'],
  ];
  const nextIndex = { ...existingIndex, format: ASSETS_FORMAT };
  const owners = new Map();
  const importedAssets = {};
  for (const [kind, table, field] of assets) {
    const existing = existingIndex[table] || {};
    const incoming = normalized[table];
    const map = new Map();
    maps[kind + 'Map'] = map;
    const taken = new Set([...Object.keys(existing), ...Object.keys(incoming)]);
    for (const name of Object.keys(incoming)) {
      if (Object.hasOwn(existing, name)) {
        addConflict(kind, name, 'assets/custom.index.json#' + table + '.' + name);
        if (mode === 'rename') {
          const target = uniqueName(name + '_pack', taken);
          map.set(name, target);
          taken.add(target);
        }
      }
    }
    importedAssets[table] = Object.create(null);
    nextIndex[table] = { ...existing };
    for (const [name, entry] of Object.entries(existing)) {
      const refs = field === 'frames' ? entry?.frames : [entry?.file];
      if (!Array.isArray(refs)) continue;
      for (const ref of refs) {
        if (typeof ref !== 'string') continue;
        const clean = posix.normalize(toPosix(ref).replace(/^\/+/, ''));
        const key = (clean.startsWith('custom/') ? clean : 'custom/' + clean).toLowerCase();
        if (!owners.has(key)) owners.set(key, []);
        owners.get(key).push(Object.hasOwn(incoming, name));
      }
    }
  }

  const files = new Map();
  const takenFiles = new Set(Object.keys(normalized.files).map((key) => key.toLowerCase()));
  const relocated = new Map();
  function mapFile(key, renamed) {
    const currentOwners = owners.get(key.toLowerCase()) || [];
    const exists = targetExists(paths.dataRoot, 'assets/' + key);
    const ownedOverwrite = mode === 'overwrite' && currentOwners.length && currentOwners.every(Boolean);
    if (!renamed && ((!exists && !currentOwners.length) || ownedOverwrite)) {
      files.set(key, normalized.files[key]);
      return key;
    }
    if (mode !== 'rename') {
      if (!blocked.includes('assets/' + key)) {
        blocked.push('assets/' + key);
        addConflict('file', key, 'assets/' + key);
      }
      return key;
    }
    if (relocated.has(key)) return relocated.get(key);
    const extension = extname(key);
    const stem = key.slice(0, key.length - extension.length);
    let next;
    for (let i = 2; ; i += 1) {
      next = stem + '_' + i + extension;
      const folded = next.toLowerCase();
      if (!takenFiles.has(folded) && !owners.has(folded) && !targetExists(paths.dataRoot, 'assets/' + next)) break;
    }
    takenFiles.add(next.toLowerCase());
    relocated.set(key, next);
    files.set(next, normalized.files[key]);
    return next;
  }
  for (const [kind, table, field] of assets) {
    const map = maps[kind + 'Map'];
    for (const [name, entry] of Object.entries(normalized[table])) {
      const target = map.get(name) || name;
      const refs = field === 'frames' ? entry.frames : [entry.file];
      const keys = refs.map((key) => mapFile(key, target !== name));
      importedAssets[table][target] = { ...entry, [field]: field === 'frames' ? keys : keys[0] };
    }
    nextIndex[table] = { ...nextIndex[table], ...importedAssets[table] };
  }
  validateFileTree([...files.keys()]);
  return { conflicts, blocked, maps, documents, availableAttacks, files, importedAssets, nextIndex };
}

export function importPack({ pack, works = null, mode = 'abort' } = {}) {
  if (!['abort', 'rename', 'overwrite'].includes(mode)) {
    throw new PackError('mode 必須是 abort、rename 或 overwrite', { code: 'bad_request' });
  }
  const normalized = normalizePack(pack);
  const paths = dataPaths(works);
  mkdirSync(paths.dataRoot, { recursive: true });
  const lock = join(paths.dataRoot, '.drpack-import.lock');
  try {
    mkdirSync(lock);
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    throw new PackError('另一個作品包正在匯入：' + paths.dataRoot, { code: 'import_busy' });
  }
  try {
    return writeImport(normalized, paths, mode);
  } finally {
    rmdirSync(lock);
  }
}

function publishImportFiles(writes, warnings) {
  const staged = [];
  const rollbackFailures = [];
  const cleanupFailures = [];
  let published = 0;
  let publishing = false;
  let target;
  let failure;
  try {
    for (const [file, data] of writes) {
      target = file;
      const output = stageOutput(file);
      const entry = { file, output, original: null };
      staged.push(entry);
      if (lstatIfPresent(file)) {
        const name = basename(file).toLowerCase() === 'original' ? 'previous' : 'original';
        entry.original = join(dirname(output.temp), name);
        copyFileSync(file, entry.original);
      }
      writeFileSync(output.temp, data);
      entry.identity = lstatSync(output.temp, { bigint: true });
    }
    publishing = true;
    for (const { file, output } of staged) {
      target = file;
      output.publish();
      published += 1;
    }
  } catch (err) {
    failure = err;
    while (published > 0) {
      const entry = staged[--published];
      try {
        const live = lstatSync(entry.file, { bigint: true });
        const expected = entry.identity;
        if (live.dev !== expected.dev || live.ino !== expected.ino ||
            live.size !== expected.size || live.mtimeNs !== expected.mtimeNs) {
          throw new Error('檔案在匯入後已被其他程序修改');
        }
        if (entry.original) renameSync(entry.original, entry.file);
        else unlinkSync(entry.file);
      } catch (rollbackError) {
        entry.keepOriginal = true;
        rollbackFailures.push({ path: entry.file, backup: entry.original, error: rollbackError.message });
      }
    }
  }

  for (const { original, keepOriginal, output } of staged) {
    if (keepOriginal && original) continue;
    try {
      if (original && lstatIfPresent(original)) unlinkSync(original);
      output.close();
    } catch (err) {
      cleanupFailures.push({ path: dirname(output.temp), error: err.message });
    }
  }

  if (failure) {
    const details = { path: target, ...(cleanupFailures.length ? { cleanupFailures } : {}) };
    const reason = target + '：' + failure.message;
    if (rollbackFailures.length) {
      const recovery = rollbackFailures.map(({ path, backup, error }) =>
        path + '：' + error + (backup ? '；原始檔保留於 ' + backup : '；無原始檔')).join('\n');
      throw new PackError('匯入發布失敗且未能完整復原：' + reason + '\n' + recovery, {
        code: 'rollback_failed',
        details: { ...details, rollbackFailures },
      });
    }
    throw new PackError(
      (publishing ? '匯入發布失敗，已復原先前寫入的檔案：' : '匯入準備失敗，未更動目的檔案：') + reason,
      { code: publishing ? 'publish_failed' : 'stage_failed', details },
    );
  }
  for (const { path, error } of cleanupFailures) warnings.push('無法清理匯入暫存 ' + path + '：' + error);
}

function writeImport(normalized, paths, mode) {
  const { conflicts, blocked, maps, documents, availableAttacks, files, importedAssets, nextIndex } =
    planImport(normalized, paths, mode);
  if (blocked.length || (conflicts.length && mode === 'abort')) {
    return {
      status: 2,
      result: {
        ok: false,
        code: 'conflicts',
        error: '作品包與目前作品有 ' + conflicts.length + ' 個衝突（未寫入任何檔案）',
        mode,
        conflicts,
        hint: blocked.length ? '部分路徑不可覆蓋；請改用 --mode rename' : '改用 --mode rename 或 --mode overwrite',
      },
    };
  }

  const imported = { encounters: [], attacks: [], files: files.size };
  for (const table of ['sprites', 'audio']) imported[table] = Object.keys(importedAssets[table]);
  const warnings = [];
  const writes = [];
  for (const [key, buffer] of files) writes.push([join(paths.assetsDir, key), buffer]);
  if (files.size) writes.push([paths.customIndexPath, JSON.stringify(nextIndex, null, 2) + '\n']);
  for (const { kind, collection, name, target, destination, document, source, text } of documents) {
    const mapped = remapDocument(document, maps);
    writes.push([join(paths.dataRoot, destination), documentText(mapped, text)]);
    imported[collection].push({ name: target, source, ...(target !== name ? { renamedFrom: name } : {}) });
    if (kind === 'encounter') {
      const missing = [...collectAttackRefs(mapped)].filter((ref) => !availableAttacks.has(ref));
      if (missing.length) warnings.push('遭遇 ' + target + ' 引用了作品裡沒有的攻擊：' + missing.join('、'));
    }
  }
  publishImportFiles(writes, warnings);
  if (mode === 'overwrite' && conflicts.length) warnings.push('已覆蓋 ' + conflicts.length + ' 個同名項目');

  return {
    status: 0,
    result: {
      ok: true,
      format: PACK_FORMAT,
      mode,
      works: paths.works,
      imported,
      renamed: Object.fromEntries(
        Object.entries(KIND_COLLECTION).concat([['sprite', 'sprites'], ['audio', 'audio']])
          .map(([kind, collection]) => [collection, Object.fromEntries(maps[kind + 'Map'])]),
      ),
      needsCustomBuild: files.size > 0,
      hint: files.size ? '若自訂素材有變動，可重跑：python tools/build_custom_assets.py --root ' +
        displayPath(paths.assetsDir) + '（本次匯入已先寫好一份可用的索引）' : null,
      warnings,
    },
  };
}

/* --------------------------------------------------------------- 命令列 */

function parseArgs(argv) {
  const options = { _: [] };
  const booleanFlags = new Set(['json', 'allow-missing', 'overwrite', 'rename-on-conflict', 'help']);
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      options._.push(token);
      continue;
    }
    let name = token.slice(2);
    let value = null;
    const equals = name.indexOf('=');
    if (equals >= 0) {
      value = name.slice(equals + 1);
      name = name.slice(0, equals);
    }
    if (booleanFlags.has(name)) {
      options[name] = true;
      continue;
    }
    if (value === null) {
      value = argv[index + 1];
      index += 1;
    }
    if (value === undefined || String(value).startsWith('--')) {
      throw new PackError(`--${name} 需要一個值`, { code: 'bad_request' });
    }
    options[name] = value;
  }
  return options;
}

function modeFromOptions(options) {
  if (options['rename-on-conflict']) return 'rename';
  if (options.overwrite) return 'overwrite';
  const mode = options.mode || 'abort';
  if (!['abort', 'rename', 'overwrite'].includes(mode)) {
    throw new PackError(`--mode 必須是 abort、rename 或 overwrite（收到 ${JSON.stringify(mode)}）`, {
      code: 'bad_request',
    });
  }
  return mode;
}

function printHuman(lines) {
  for (const line of lines) process.stdout.write(`${line}\n`);
}

/** 命令列的結束碼：emit() 會更新它，main() 最後回傳它。 */
let pendingExitCode = 0;

function emit(payload, { json, exitCode = 0 }) {
  if (json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
  pendingExitCode = exitCode;
}

function cmdExport(options) {
  const name = options._[0];
  if (!name) throw new PackError('用法：pack.mjs export <遭遇名|攻擊名> [--kind ...] [--works ...] [--out ...]', {
    code: 'bad_request',
  });
  const kind = options.kind ? String(options.kind) : null;
  const works = resolveWorks(options.works ?? null);
  const { pack, warnings, sourceFiles } = buildPack({
    kind,
    name,
    works,
    allowMissing: Boolean(options['allow-missing']),
  });
  const text = packToText(pack);
  const outOption = options.out;
  if (outOption === '-') {
    if (options.json) throw new PackError('--out - 不能與 --json 同時使用', { code: 'bad_request' });
    process.stdout.write(text);
    return emit({ ok: true, out: '-' }, { json: false });
  }
  const out = outOption ? resolve(process.cwd(), String(outOption)) : resolve(process.cwd(), `${name}.drpack.json`);
  if (lstatIfPresent(out)) {
    const target = realpathSync(out);
    if (sourceFiles.some((file) => isFile(file) && realpathSync(file) === target)) {
      throw new PackError('匯出檔不能覆蓋來源檔：' + out, { code: 'bad_request' });
    }
  }
  writeOutput(out, text);
  const summary = {
    ok: true,
    out,
    format: PACK_FORMAT,
    name,
    kind: pack.meta.kind,
    counts: {
      encounters: Object.keys(pack.encounters).length,
      attacks: Object.keys(pack.attacks).length,
      sprites: Object.keys(pack.assets.sprites).length,
      audio: Object.keys(pack.assets.audio).length,
      files: Object.keys(pack.files).length,
    },
    bytes: statSync(out).size,
    sources: {
      encounters: Object.fromEntries(Object.entries(pack.encounters).map(([key, value]) => [key, value.source])),
      attacks: Object.fromEntries(Object.entries(pack.attacks).map(([key, value]) => [key, value.source])),
    },
    warnings,
  };
  if (options.json) {
    emit(summary, { json: true });
  } else {
    const counts = summary.counts;
    printHuman([
      `已匯出作品包：${out}`,
      `  名稱：${name}（${summary.kind}）`,
      `  遭遇 ${counts.encounters}、攻擊 ${counts.attacks}、自訂 sprite ${counts.sprites}、自訂音訊 ${counts.audio}、內嵌檔案 ${counts.files}`,
      `  大小：${summary.bytes} bytes`,
      ...warnings.map((warning) => `  [警告] ${warning}`),
    ]);
    emit(summary, { json: false });
  }
}

function readPack(file) {
  let bytes;
  try {
    bytes = readFileSync(file === '-' ? 0 : file);
  } catch (err) {
    throw new PackError('讀取作品包失敗：' + err.message, { code: 'bad_file' });
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const value = parseFiniteJSON(text);
    return value?.format !== PACK_FORMAT && value?.pack && typeof value.pack === 'object' ? value.pack : value;
  } catch (err) {
    if (!(err instanceof SyntaxError || err instanceof TypeError)) throw err;
    throw new PackError('作品包必須是合法的 UTF-8 JSON：' + err.message, { code: 'bad_pack' });
  }
}

function cmdImport(options) {
  const file = options._[0];
  if (!file) throw new PackError('用法：pack.mjs import <檔案.drpack.json> [--works ...] [--mode ...]', {
    code: 'bad_request',
  });
  const pack = readPack(file);
  const mode = modeFromOptions(options);
  const { status, result } = importPack({ pack, works: resolveWorks(options.works), mode });
  if (options.json) {
    emit(result, { json: true, exitCode: status });
    return;
  }
  if (status !== 0) {
    process.stderr.write(`${result.error}\n`);
    for (const conflict of result.conflicts || []) {
      process.stderr.write(`  x ${conflict.kind}: ${conflict.name}\n`);
    }
    if (result.hint) process.stderr.write(`  ${result.hint}\n`);
    emit(result, { json: false, exitCode: status });
    return;
  }
  const imported = result.imported;
  printHuman([
    `已匯入作品包（mode=${mode}）`,
    `  遭遇 ${imported.encounters.length}、攻擊 ${imported.attacks.length}、自訂 sprite ${imported.sprites.length}、自訂音訊 ${imported.audio.length}、內嵌檔案 ${imported.files}`,
    ...imported.encounters.map(
      (item) => `  + 遭遇 ${item.name}${item.renamedFrom ? `（原名 ${item.renamedFrom}）` : ''}`,
    ),
    ...imported.attacks.map(
      (item) => `  + 攻擊 ${item.name}${item.renamedFrom ? `（原名 ${item.renamedFrom}）` : ''}`,
    ),
    ...result.warnings.map((warning) => `  [警告] ${warning}`),
    ...(result.hint ? [`  [提示] ${result.hint}`] : []),
  ]);
  emit(result, { json: false, exitCode: 0 });
}

function cmdInspect(options) {
  const file = options._[0];
  if (!file) throw new PackError('用法：pack.mjs inspect <檔案.drpack.json>', { code: 'bad_request' });
  const pack = readPack(file);
  const normalized = normalizePack(pack);
  const summary = {
    ok: true,
    format: pack.format,
    meta: normalized.meta,
    counts: {
      encounters: normalized.encounters.length,
      attacks: normalized.attacks.length,
      sprites: Object.keys(normalized.sprites).length,
      audio: Object.keys(normalized.audio).length,
      files: Object.keys(normalized.files).length,
      fileBytes: Object.values(normalized.files).reduce((sum, buffer) => sum + buffer.length, 0),
    },
    sources: {
      encounters: Object.fromEntries(normalized.encounters.map((item) => [item.name, item.source])),
      attacks: Object.fromEntries(normalized.attacks.map((item) => [item.name, item.source])),
    },
    sprites: Object.keys(normalized.sprites),
    audio: Object.keys(normalized.audio),
    fileKeys: Object.keys(normalized.files),
    sha256: sha256(JSON.stringify(pack)),
  };
  if (options.json) {
    emit(summary, { json: true });
    return;
  }
  printHuman([
    `作品包：${file}`,
    `  format：${summary.format}`,
    `  內容：${summary.meta.name || '(未命名)'}（${summary.meta.kind || '?'}）建立於 ${summary.meta.createdAt || '?'}`,
    `  遭遇 ${summary.counts.encounters}、攻擊 ${summary.counts.attacks}、自訂 sprite ${summary.counts.sprites}、自訂音訊 ${summary.counts.audio}、檔案 ${summary.counts.files}（${summary.counts.fileBytes} bytes）`,
    ...normalized.attacks.map((item) => `  攻擊 ${item.name} ← ${item.source}`),
    ...normalized.encounters.map((item) => `  遭遇 ${item.name} ← ${item.source}`),
  ]);
  emit(summary, { json: false });
}

function usage() {
  process.stderr.write(
    [
      '用法：',
      '  node tools/pack.mjs export <遭遇名|攻擊名> [--kind encounter|attack] [--works <作品根>] [--out <檔案>] [--json]',
      '  node tools/pack.mjs import <檔案.drpack.json> [--works <作品根>] [--mode abort|rename|overwrite] [--rename-on-conflict] [--overwrite] [--json]',
      '  node tools/pack.mjs inspect <檔案.drpack.json> [--json]',
      '',
      '--works 預設讀環境變數 DR_WORKS；相對路徑以目前工作目錄解析。',
    ].join('\n') + '\n',
  );
}

export function main(argv = process.argv.slice(2)) {
  pendingExitCode = 0;
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    usage();
    return 0;
  }
  let options = { json: false, _: [] };
  try {
    options = parseArgs(rest);
    if (options.help) {
      usage();
      return 0;
    }
    if (command === 'export') {
      cmdExport(options);
      return pendingExitCode;
    }
    if (command === 'import') {
      cmdImport(options);
      return pendingExitCode;
    }
    if (command === 'inspect') {
      cmdInspect(options);
      return pendingExitCode;
    }
    usage();
    return 1;
  } catch (err) {
    const payload =
      err instanceof PackError
        ? { ok: false, code: err.code, error: err.message, ...err.details }
        : { ok: false, code: 'error', error: String((err && err.stack) || err) };
    if (options.json) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    else process.stderr.write(`${payload.error}\n`);
    return 1;
  }
}

/* 只有被當主程式執行時才跑命令列（serve.py 以子程序呼叫）。 */
const invokedDirectly = (() => {
  try {
    return resolve(process.argv[1] || '') === resolve(fileURLToPath(import.meta.url));
  } catch (_err) {
    return false;
  }
})();

if (invokedDirectly) {
  process.exitCode = main();
}
