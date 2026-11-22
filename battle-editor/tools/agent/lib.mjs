/**
 * tools/agent/lib.mjs — AG（Agent 工具）共用小工具與路徑解析。
 *
 * 零外部依賴（只用 Node 標準庫），因為這批工具要能被 MCP 伺服器直接 spawn、
 * 也要能在地端純 `node` 執行，不需要 npm install。
 *
 * 路徑慣例（SPEC-AGENT §2，ROADMAP-V2 §1）：
 *   --root  程式根（battle-editor/，有 engine/、serve.py、samples/）。
 *           預設＝**本檔所在處往上兩層**，所以在 worktree 裡跑工具會自動用 worktree 的引擎。
 *   --works 作品根（含 attacks/、encounters/、assets/custom/）。預設＝程式根。
 *           作品名解析順序：作品根 → 程式根的 attacks/encounters → samples/。
 *   環境變數 DR_ROOT / DR_WORKS 與 --root / --works 等價（命令列優先）。
 *
 * 對外路徑（MCP 回傳、render 的 URL 參數）仍用「相對程式根的 POSIX 路徑」，
 * 因為 serve.py 的靜態根目錄就是程式根。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/* ------------------------------------------------------------------ 路徑 */

/** tools/agent/ */
export const HERE = dirname(fileURLToPath(import.meta.url));
/** battle-editor/ 的預設位置（工具所在的程式根）。 */
export const DEFAULT_BATTLE_EDITOR = resolve(HERE, '..', '..');

/** 程式根（battle-editor/；--root / DR_ROOT 可覆寫）。 */
export let BATTLE_EDITOR = DEFAULT_BATTLE_EDITOR;
/** 程式根的上一層（專案根）。 */
export let ROOT = resolve(BATTLE_EDITOR, '..');
/** 作品根（含 attacks/、encounters/；--works / DR_WORKS 可覆寫，預設＝程式根）。 */
export let WORKS_DIR = BATTLE_EDITOR;

export let ENGINE_DIR = join(BATTLE_EDITOR, 'engine');
export let SAMPLES_DIR = join(BATTLE_EDITOR, 'samples');
export let ATTACKS_DIR = join(WORKS_DIR, 'attacks');
export let ENCOUNTERS_DIR = join(WORKS_DIR, 'encounters');
export let GENERATED_DIR = join(BATTLE_EDITOR, 'generated');
export let SCHEMA_DIR = join(GENERATED_DIR, 'schema');
export let ASSETS_DIR = process.env.DR_ASSETS ? resolve(process.env.DR_ASSETS) : join(BATTLE_EDITOR, 'assets');
export let ASSETS_INDEX = join(ASSETS_DIR, 'index.json');
export let DOCS_DIR = join(BATTLE_EDITOR, 'docs');
/** 程式根自己的作品目錄（作品名解析順序的第二站）。 */
export let ROOT_ATTACKS_DIR = join(BATTLE_EDITOR, 'attacks');
export let ROOT_ENCOUNTERS_DIR = join(BATTLE_EDITOR, 'encounters');

/** 目前路徑設定的快照（給 CLI 輸出 / 測試用）。 */
export function pathsSnapshot() {
  return {
    root: BATTLE_EDITOR,
    works: WORKS_DIR,
    codeRoot: DEFAULT_BATTLE_EDITOR,
    attacks: ATTACKS_DIR,
    encounters: ENCOUNTERS_DIR,
    rootAttacks: ROOT_ATTACKS_DIR,
    rootEncounters: ROOT_ENCOUNTERS_DIR,
    samples: SAMPLES_DIR,
    engine: ENGINE_DIR,
    generated: GENERATED_DIR,
    schema: SCHEMA_DIR,
    assets: ASSETS_DIR,
    assetsIndex: ASSETS_INDEX,
    docs: DOCS_DIR,
  };
}

function looksLikeBattleEditor(dir) {
  if (!dir) return false;
  if (isFile(join(dir, 'engine', 'assets.js'))) return true;
  if (isFile(join(dir, 'serve.py'))) return true;
  return isFile(join(dir, 'play.html'));
}

/**
 * 套用程式根 / 作品根（所有 CLI 與 MCP 共用）。
 *
 * @param {{root?:string|null, works?:string|null}} [options]
 * @returns {ReturnType<typeof pathsSnapshot>}
 */
export function configurePaths(options = {}) {
  const rootInput =
    options.root === undefined || options.root === null || options.root === ''
      ? null
      : String(options.root);
  const root = rootInput ? resolve(process.cwd(), rootInput) : DEFAULT_BATTLE_EDITOR;
  if (rootInput && !looksLikeBattleEditor(root)) {
    throw new Error(
      `--root 看起來不是 battle-editor 程式根（找不到 engine/assets.js、serve.py 或 play.html）：${root}`,
    );
  }
  const worksInput =
    options.works === undefined || options.works === null || options.works === ''
      ? null
      : String(options.works);
  const works = worksInput ? resolve(process.cwd(), worksInput) : root;
  if (worksInput && !existsSync(works)) {
    throw new Error(`--works 作品根不存在：${works}`);
  }

  BATTLE_EDITOR = root;
  ROOT = resolve(root, '..');
  WORKS_DIR = works;
  ENGINE_DIR = join(root, 'engine');
  SAMPLES_DIR = join(root, 'samples');
  ATTACKS_DIR = join(works, 'attacks');
  ENCOUNTERS_DIR = join(works, 'encounters');
  ROOT_ATTACKS_DIR = join(root, 'attacks');
  ROOT_ENCOUNTERS_DIR = join(root, 'encounters');
  GENERATED_DIR = join(root, 'generated');
  SCHEMA_DIR = join(GENERATED_DIR, 'schema');
  ASSETS_DIR = process.env.DR_ASSETS ? resolve(process.env.DR_ASSETS) : join(root, 'assets');
  ASSETS_INDEX = join(ASSETS_DIR, 'index.json');
  DOCS_DIR = join(root, 'docs');
  return pathsSnapshot();
}

/**
 * 從命令列 / 環境變數取出 --root / --works（不做任何磁碟檢查）。
 *
 * @param {string[]} [argv]
 * @param {Record<string,string|undefined>} [env]
 * @returns {{root:string|null, works:string|null}}
 */
export function resolvePathOptions(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv, ['root', 'works']);
  const pick = (key, envName) => {
    const value = args[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
    const fromEnv = env && env[envName];
    if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim();
    return null;
  };
  return { root: pick('root', 'DR_ROOT'), works: pick('works', 'DR_WORKS') };
}

/**
 * CLI 進入點用：解析 --root/--works/DR_ROOT/DR_WORKS 並套用。
 * 沒有指定任何一項時維持預設（工具所在處），回傳目前設定。
 *
 * @param {string[]} [argv]
 * @param {Record<string,string|undefined>} [env]
 */
export function applyCliPaths(argv = process.argv.slice(2), env = process.env) {
  const options = resolvePathOptions(argv, env);
  if (!options.root && !options.works) return pathsSnapshot();
  return configurePaths(options);
}

/**
 * 素材索引檔：作品根有自己的 assets/index.json 時優先（作品可帶自訂素材），
 * 否則用程式根的 assets/index.json。
 */
export function assetsIndexFile() {
  if (WORKS_DIR !== BATTLE_EDITOR) {
    const worksIndex = join(WORKS_DIR, 'assets', 'index.json');
    if (isFile(worksIndex)) return worksIndex;
  }
  return ASSETS_INDEX;
}

/* -------------------------------------------------------------- 小工具 */

/** 是否被當成主程式執行（而不是被 import）。 */
export function isMain(metaUrl, entry = process.argv[1]) {
  if (!entry) return false;
  try {
    return resolve(fileURLToPath(metaUrl)) === resolve(entry);
  } catch (_err) {
    return false;
  }
}

export function readJSON(file) {
  return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

export function readJSONOrNull(file) {
  try {
    return readJSON(file);
  } catch (_err) {
    return null;
  }
}

/**
 * 寫 JSON（2 空白縮排 + 結尾換行）。內容與現有檔案完全相同時不寫、回傳 false
 * ——這是所有產生器的冪等基礎（重跑不會改 mtime，也不會製造 git 噪音）。
 */
export function writeJSON(file, data) {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    try {
      if (readFileSync(file, 'utf8') === text) return false;
    } catch (_err) {
      /* 讀不到就照寫 */
    }
  }
  writeFileSync(file, text, 'utf8');
  return true;
}

export function writeText(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  if (existsSync(file)) {
    try {
      if (readFileSync(file, 'utf8') === text) return false;
    } catch (_err) {
      /* 讀不到就照寫 */
    }
  }
  writeFileSync(file, text, 'utf8');
  return true;
}

/** Windows 路徑 → POSIX（給 URL 與 MCP 對外用）。 */
export function toPosix(p) {
  return String(p).split(sep).join('/');
}

/** 相對於程式根（battle-editor/）的 POSIX 路徑。 */
export function relToBattleEditor(p) {
  return toPosix(relative(BATTLE_EDITOR, resolve(p)));
}

export function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch (_err) {
    return false;
  }
}

export function listJSON(folder) {
  try {
    return readdirSync(folder)
      .filter((name) => name.toLowerCase().endsWith('.json'))
      .sort()
      .map((name) => join(folder, name));
  } catch (_err) {
    return [];
  }
}

/**
 * 解析相對 cwd / 作品根 / 程式根 / 各作品目錄的檔案參照。
 *
 * 順序（ROADMAP-V2 §1）：
 *   cwd → 作品根 → 作品根/attacks → 作品根/encounters →
 *   程式根 → 程式根/attacks → 程式根/encounters → samples → samples/encounters
 * 沒有斜線的參照再各目錄試一次「加 .json」。
 */
export function resolveInputFile(input, { mustExist = true } = {}) {
  if (typeof input !== 'string' || !input) return null;
  const searchDirs = [
    WORKS_DIR,
    ATTACKS_DIR,
    ENCOUNTERS_DIR,
    BATTLE_EDITOR,
    ROOT_ATTACKS_DIR,
    ROOT_ENCOUNTERS_DIR,
    SAMPLES_DIR,
    join(SAMPLES_DIR, 'encounters'),
  ];
  const candidates = [];
  if (isAbsolute(input)) candidates.push(input);
  else {
    candidates.push(resolve(process.cwd(), input));
    const withJson = !/[\\/]/.test(input);
    for (const dir of searchDirs) {
      candidates.push(resolve(dir, input));
      if (withJson) candidates.push(resolve(dir, `${input}.json`));
    }
  }
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return mustExist ? null : candidates[0] || null;
}

/* ------------------------------------------------------------ 命令列參數 */

/**
 * 極簡命令列解析：
 *   --key=value / --key value（值型別旗標需列在 valueFlags）/ --flag（布林）
 *   位置參數收在 `_`。
 *
 * 第三個參數 `known`（可省略）：給了就會檢查「不認得的長旗標」（REALTEST-2 V7）——
 *   known.booleanFlags：這支工具支援的布林旗標；valueFlags ＋ booleanFlags ＋ 共用的
 *   root / works / json / help 以外的 `--xxx` 都算未知。
 *   未知旗標仍照舊解析（不擋），但會收在不可列舉的 `out.__unknown`，並呼叫
 *   known.onUnknown(訊息)（預設印到 stderr）。沒給 `known` 時行為與以前完全相同。
 */
export function parseArgs(argv = process.argv.slice(2), valueFlags = [], known = null) {
  const out = { _: [] };
  const valueSet = new Set(valueFlags);
  const knownSet = known
    ? new Set([...valueFlags, ...(known.booleanFlags || []), 'root', 'works', 'json', 'help'])
    : null;
  const unknown = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (typeof arg !== 'string') continue;
    if (arg === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let value = true;
    const eq = key.indexOf('=');
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else if (valueSet.has(key) && i + 1 < argv.length) {
      value = argv[i + 1];
      i += 1;
    }
    out[key] = value;
    if (knownSet && !knownSet.has(key)) unknown.push(key);
  }
  if (knownSet) {
    Object.defineProperty(out, '__unknown', { value: unknown, enumerable: false });
    const report = typeof known.onUnknown === 'function' ? known.onUnknown : (text) => console.error(text);
    for (const key of unknown) report(unknownFlagMessage(key, [...knownSet]));
  }
  return out;
}

/** 未知旗標的警告文字（含「你是不是想打 --xxx」）。 */
export function unknownFlagMessage(key, knownFlags = []) {
  const near = knownFlags.find((name) => name !== key && (name.startsWith(key) || key.startsWith(name)));
  return (
    `警告：不認得的旗標 --${key}（這支工具不支援，已忽略；它後面的值會被當成位置參數）` +
    (near ? `。你是不是想打 --${near}？` : '')
  );
}

export function numArg(value, fallback) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

export function boolArg(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null) return fallback;
  const s = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return fallback;
}

/* -------------------------------------------------------------- 統計 */

export function mean(values) {
  if (!values || values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

export function percentile(values, p) {
  if (!values || values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(((p / 100) * (sorted.length - 1)))));
  return sorted[idx];
}

export function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round((Number(value) || 0) * factor) / factor;
}

/** 把多行字串排成簡單表格（等寬對齊，中文以終端寬度近似）。 */
export function formatTable(headers, rows) {
  const width = (s) => {
    let w = 0;
    for (const ch of String(s)) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1;
    return w;
  };
  const pad = (s, n) => {
    const text = String(s);
    return text + ' '.repeat(Math.max(0, n - width(text)));
  };
  const cols = headers.map((h, i) => Math.max(width(h), ...rows.map((r) => width(r[i] ?? ''))));
  const lines = [headers.map((h, i) => pad(h, cols[i])).join('  ')];
  lines.push(cols.map((n) => '-'.repeat(n)).join('  '));
  for (const row of rows) lines.push(cols.map((n, i) => pad(row[i] ?? '', n)).join('  '));
  return lines.join('\n');
}

/** 是否為「使用者直接執行」這個 CLI（用於 CLI 入口判斷）。 */
export function cliEntry(metaUrl) {
  return isMain(metaUrl);
}
