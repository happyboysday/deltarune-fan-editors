/**
 * engine/expr.js — 生成欄位表達式
 *
 * SPEC §5：
 *   - 每個生成欄位可為數字，或一段在生成時求值一次的表達式字串。
 *   - pathX/pathY 為每幀求值，可用 age。
 *   - 可用變數：t T i n k age box soul
 *   - 可用函式：sin cos tan atan2 sqrt abs min max floor ceil round PI rand pick aim lerp trailX trailY
 *     （sin/cos/tan 以度為單位）
 *   - 以 new Function 編譯並快取；用參數遮蔽 window/document/globalThis/fetch 等全域。
 *   - 編譯或求值錯誤 → 該值取 0 並回報（不中斷模擬）。
 *
 * 設計重點（三層沙箱）：
 *   第一層：**詞法白名單驗證** validateExprSyntax()。
 *     在任何程式碼被建立之前先掃描字串，只允許數字、空白、白名單運算子、
 *     白名單識別字（變數 / 函式 / PI / true / false），以及白名單屬性存取
 *     （`box.x`、`soul.y` 等）。字串字面量、方括號、大括號、分號、賦值、
 *     箭頭函式、反斜線、`new`/`this`/`constructor`/`__proto__`/`prototype`
 *     一律拒絕，因此完全無法取得原型鏈上的 Function 建構子。
 *   第二層：函式參數遮蔽全域（window/document/globalThis/fetch…）。
 *   第三層：編譯時加 "use strict"，this 在函式內為 undefined。
 *
 *   其他：
 *   1. 編譯結果以「原始字串」為 key 存在模組級 Map（跨 battle 共用，SPEC 要求的編譯快取）。
 *   2. 求值函式本身不 throw：evalNumber() 一律回傳 { value, error }。
 *   3. 不使用 with/eval。
 */

import { createRng } from './rng.js';

const DEG = Math.PI / 180;

/* ---------------------------------------------------------------- 沙箱 */

/**
 * 會被參數遮蔽成 undefined 的全域名稱。
 * 注意：'eval' 與 'arguments' 在 strict mode 不能當參數名，故不列入；
 * 'Math' 也不提供（只提供 SPEC 列出的函式），避免使用者誤用未定義行為。
 */
export const SANDBOX_NAMES = [
  'window',
  'document',
  'globalThis',
  'self',
  'top',
  'parent',
  'frames',
  'opener',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'Worker',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'navigator',
  'location',
  'history',
  'Function',
  'importScripts',
  'setTimeout',
  'setInterval',
  'requestAnimationFrame',
  'postMessage',
  'process',
  'require',
  'module',
  'exports',
  'console',
  'Math',
  'alert',
  'prompt',
  'confirm',
];

/**
 * 依求值順序排列的表達式變數（會被當成函式參數）
 *
 * SPEC §5 列出的是 t,T,i,n,k,age,box,soul。
 * 額外追加 x、y：本次生成「已求值的位置」（由 sim 在算完 x/y 後回填），
 * 讓 `angle: "aim(x, y)"` 這種寫法可用；未提供時退回 box 中心。
 * 這是向後相容的擴充，不影響 SPEC 既有變數。
 *
 * SPEC-EXPR-V2 §3 追加（唯讀）：
 *   spawnX / spawnY：本發子彈的生成座標（spawn 的 x/y 求值後固定）
 *   spawnT        ：本發子彈的生成時間（回合開始後的秒數；事件 at 已含 beatOffset，所以間接反映它）
 *   bpm / beat    ：settings.bpm 與一拍秒數（= 60/bpm；沒設 bpm 時兩者皆為 0）
 *   mem           ：每顆子彈的記憶物件（`mem.<name>`，memory 生成時求值一次後固定；
 *                   未定義的名字取 0）
 * i / n / k 原本就有（本次序號 / 本輪數量 / emitter 第幾輪），語意不變。
 */
export const VAR_NAMES = [
  't',
  'T',
  'i',
  'n',
  'k',
  'age',
  'box',
  'soul',
  'x',
  'y',
  'turn',
  'tp',
  'spawnX',
  'spawnY',
  'spawnT',
  'bpm',
  'beat',
  'mem',
];

/**
 * 遭遇戰用的「查表物件」（SPEC-P2 §3）：
 *   mercy.rudinn、hp.kris、maxHp.kris、alive.rudinn、actCount.rudinn_compliment
 * 屬性名在詞法層允許任意識別字，求值時才查表；查不到為 0。
 *
 * `var.complimented` 的 `var` 是 JS 保留字，不能當函式參數，
 * 因此 compile 之前會先把 `var.` 改寫成 `vars.`（只改識別字 token，安全）。
 */
export const LOOKUP_NAMES = ['mercy', 'hp', 'maxHp', 'alive', 'actCount', 'vars'];

/** 查表物件禁止的屬性名（原型鏈防線的第二道保險） */
const FORBIDDEN_PROP_NAMES = new Set([
  'constructor',
  '__proto__',
  'prototype',
  'toString',
  'valueOf',
  'hasOwnProperty',
  'isPrototypeOf',
  'propertyIsEnumerable',
  'toLocaleString',
  '__defineGetter__',
  '__defineSetter__',
  '__lookupGetter__',
  '__lookupSetter__',
  'apply',
  'call',
  'bind',
]);

/** 依求值順序排列的函式名稱（值來自 createHelpers()） */
export const HELPER_NAMES = [
  'sin',
  'cos',
  'tan',
  'atan2',
  'sqrt',
  'abs',
  'min',
  'max',
  'floor',
  'ceil',
  'round',
  'PI',
  'rand',
  'pick',
  'aim',
  'lerp',
  'trailX',
  'trailY',
];

const SANDBOX_ARGS = SANDBOX_NAMES.map(() => undefined);

/* -------------------------------------------------- 第一層：詞法白名單 */

/**
 * 屬性存取白名單。
 *   - box / soul：固定欄位清單。
 *   - mem：`'*'` = 任意合法識別字屬性（SPEC-EXPR-V2 §3 的每顆子彈記憶；
 *     名稱另外過濾原型鏈危險名，見 FORBIDDEN_PROP_NAMES）。
 * （攻擊檔可被分享，若不限制，`(0).constructor.constructor("...")()` 之類的
 *   寫法可以沿著原型鏈拿到 Function 建構子並執行任意程式碼。）
 */
const ALLOWED_PROPERTIES = {
  box: ['x', 'y', 'w', 'h', 'left', 'right', 'top', 'bottom', 'rotation'],
  soul: ['x', 'y'],
  // `mem.<name>`：任意合法識別字（SPEC-EXPR-V2 §3）；名稱另行過濾原型鏈危險名。
  mem: '*',
};

/** 允許出現的裸識別字（變數、函式、布林字面量） */
const ALLOWED_IDENTIFIERS = new Set([...VAR_NAMES, ...HELPER_NAMES, 'true', 'false']);

/**
 * 允許「接一個任意識別字屬性」的查表名稱（SPEC-P2 §3）。
 * `var` 是保留字，compile 前會改寫成 `vars`。
 */
const LOOKUP_PREFIXES = new Set([...LOOKUP_NAMES, 'var']);

/** 表達式長度上限（防止病態輸入；正常攻擊檔遠低於此） */
const MAX_EXPR_LENGTH = 4000;

const ID_START = /[A-Za-z_$]/;
const ID_PART = /[A-Za-z0-9_$]/;
const NUMBER_RE = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

/**
 * 詞法白名單驗證。**不建立任何函式**，純字元掃描。
 *
 * @param {string} src
 * @returns {string|null} 錯誤訊息；合法時回傳 null
 */
export function validateExprSyntax(src) {
  if (typeof src !== 'string') return '表達式必須是字串';
  if (src.length > MAX_EXPR_LENGTH) return `表達式過長（上限 ${MAX_EXPR_LENGTH} 字元）`;

  let i = 0;
  const n = src.length;
  while (i < n) {
    const ch = src[i];

    // 空白
    if (ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1;
      continue;
    }

    // 數字字面量（含小數與科學記號；不支援 0x / Infinity / NaN）
    if ((ch >= '0' && ch <= '9') || (ch === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      const m = NUMBER_RE.exec(src.slice(i));
      if (!m) return `數字格式不合法（位置 ${i}）`;
      i += m[0].length;
      continue;
    }

    // 識別字（變數 / 函式 / box / soul / true / false）
    if (ID_START.test(ch)) {
      const start = i;
      i += 1;
      while (i < n && ID_PART.test(src[i])) i += 1;
      const name = src.slice(start, i);

      if (Object.prototype.hasOwnProperty.call(ALLOWED_PROPERTIES, name)) {
        // box / soul / mem：只允許「.欄位」，且不接受其他形式
        if (src[i] !== '.') {
          // 單獨出現（如 `box`）語法上允許，求值時會得到物件 → 由上層回報非數字
          continue;
        }
        i += 1; // 吃掉 '.'
        const propStart = i;
        if (i >= n || !ID_START.test(src[i])) return `"${name}." 後面必須接欄位名稱`;
        i += 1;
        while (i < n && ID_PART.test(src[i])) i += 1;
        const prop = src.slice(propStart, i);
        const allowed = ALLOWED_PROPERTIES[name];
        if (allowed !== '*') {
          if (!allowed.includes(prop)) {
            return `不允許的屬性 "${name}.${prop}"（只允許 ${allowed.join(' / ')}）`;
          }
        } else if (FORBIDDEN_PROP_NAMES.has(prop)) {
          return `不允許的屬性名稱 "${prop}"`;
        }
        if (src[i] === '.') return '不允許串接多層屬性存取';
        continue;
      }

      if (LOOKUP_PREFIXES.has(name)) {
        // 遭遇戰查表：mercy.rudinn / hp.kris / alive.rudinn / actCount.x / var.foo
        if (src[i] !== '.') {
          return `"${name}" 後面必須接屬性名稱（例如 ${name}.某個 id）`;
        }
        i += 1;
        const propStart = i;
        if (i >= n || !ID_START.test(src[i])) return `"${name}." 後面必須接屬性名稱`;
        i += 1;
        while (i < n && ID_PART.test(src[i])) i += 1;
        const prop = src.slice(propStart, i);
        if (FORBIDDEN_PROP_NAMES.has(prop)) return `不允許的屬性名稱 "${prop}"`;
        if (src[i] === '.') return '不允許串接多層屬性存取';
        continue;
      }

      if (!ALLOWED_IDENTIFIERS.has(name)) {
        return `不允許的名稱 "${name}"`;
      }
      // 白名單識別字後面緊接 '.' → 想存取屬性 → 拒絕
      if (src[i] === '.') return `不允許對 "${name}" 做屬性存取`;
      continue;
    }

    // 運算子
    switch (ch) {
      case '(':
      case ')':
      case ',':
      case '?':
      case ':':
      case '+':
      case '-':
      case '%': {
        i += 1;
        continue;
      }
      case '*': {
        // '**' 次方；也拒絕 '*/' 結尾的註解殘留
        if (src[i + 1] === '*') i += 2;
        else i += 1;
        continue;
      }
      case '/': {
        // 拒絕註解語法（/* 或 //），其餘為除法
        if (src[i + 1] === '*' || src[i + 1] === '/') return '不允許註解';
        i += 1;
        continue;
      }
      case '!': {
        if (src[i + 1] === '=') {
          i += src[i + 2] === '=' ? 3 : 2; // '!==' 或 '!='
        } else {
          i += 1; // 邏輯 NOT
        }
        continue;
      }
      case '=': {
        // 只允許比較運算 '==' / '==='；'=' 本身（含 '=>'）一律拒絕
        if (src[i + 1] !== '=') return "不允許賦值運算子 '='";
        i += src[i + 2] === '=' ? 3 : 2;
        continue;
      }
      case '<':
      case '>': {
        i += src[i + 1] === '=' ? 2 : 1;
        continue;
      }
      case '&': {
        if (src[i + 1] !== '&') return "不允許位元運算 '&'";
        i += 2;
        continue;
      }
      case '|': {
        if (src[i + 1] !== '|') return "不允許位元運算 '|'";
        i += 2;
        continue;
      }
      case '"':
      case "'":
      case '`':
        return '不允許字串字面量';
      case '[':
      case ']':
        return '不允許方括號（陣列／成員存取）';
      case '{':
      case '}':
        return '不允許大括號（物件／區塊）';
      case ';':
        return "不允許分號 ';'";
      case '\\':
        return '不允許反斜線（可能是跳脫字元）';
      case '.':
        return '不允許孤立的小數點或屬性存取';
      default:
        return `不允許的字元 "${ch}"（位置 ${i}）`;
    }
  }

  // 粗略平衡檢查：括號數量一致（真正的語法仍由 new Function 驗證）
  let depth = 0;
  for (let k = 0; k < n; k += 1) {
    if (src[k] === '(') depth += 1;
    else if (src[k] === ')') {
      depth -= 1;
      if (depth < 0) return '括號不平衡：多了一個 ")"';
    }
  }
  if (depth !== 0) return '括號不平衡：缺少 ")"';

  return null;
}

/* ------------------------------------------------------------ 輔助函式 */

/**
 * 建立一組綁定到特定亂數流 / 靈魂位置的輔助函式。
 * 每個 battle 建立一次即可（rand 會消耗該 battle 的亂數流）。
 *
 * @param {{range:(a:number,b:number)=>number, pick:(...a:any[])=>any}} rng
 * @param {() => {x:number, y:number}} getSoul 取得目前靈魂位置
 */
export function createHelpers(rng, getSoul, getTrail) {
  // trailX/trailY(sec)：靈魂 sec 秒前的位置（模擬器提供軌跡緩衝；沒有就退回目前位置）
  const trail = (sec) => (typeof getTrail === 'function' ? getTrail(num(sec, 0)) : getSoul());
  const rand = (a, b) => rng.range(a, b);
  const pick = (...args) => rng.pick(...args);
  const aim = (x, y) => {
    const s = getSoul();
    const dx = s.x - num(x, 0);
    const dy = s.y - num(y, 0);
    return Math.atan2(dy, dx) / DEG;
  };
  return {
    sin: (deg) => Math.sin(deg * DEG),
    cos: (deg) => Math.cos(deg * DEG),
    tan: (deg) => Math.tan(deg * DEG),
    atan2: (y, x) => Math.atan2(y, x) / DEG,
    sqrt: (x) => Math.sqrt(x),
    abs: (x) => Math.abs(x),
    min: (...xs) => Math.min(...xs),
    max: (...xs) => Math.max(...xs),
    floor: (x) => Math.floor(x),
    ceil: (x) => Math.ceil(x),
    round: (x) => Math.round(x),
    PI: Math.PI,
    rand,
    pick,
    aim,
    lerp: (a, b, u) => num(a, 0) + (num(b, 0) - num(a, 0)) * num(u, 0),
    trailX: (sec) => trail(sec).x,
    trailY: (sec) => trail(sec).y,
  };
}

function num(v, def = 0) {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : def;
}

/* ------------------------------------------------ 查表物件（遭遇戰專用） */

/**
 * 產生一個「查不到就 0」的唯讀查表物件。
 * 用 Object.create(null) 當原型，即使屬性名怪異也拿不到 Object.prototype 的東西。
 *
 * @param {(name:string)=>number} getter
 * @returns {object}
 */
export function createLookup(getter) {
  const obj = Object.create(null);
  return new Proxy(obj, {
    get(_t, prop) {
      if (typeof prop !== 'string') return 0;
      if (Object.prototype.hasOwnProperty.call(obj, prop)) return obj[prop];
      const v = getter(prop);
      return Number.isFinite(v) ? v : 0;
    },
    // 不得透過查表物件寫入任何東西
    set() {
      return true;
    },
  });
}

/** 靜態查表：由一個普通物件（或 null）產生，查不到回 0 */
export function lookupFrom(obj) {
  const src = obj || Object.create(null);
  return createLookup((name) => src[name]);
}

/**
 * 空查表（Phase 1 攻擊表達式用；mercy.x 之類一律 0）
 */
export const EMPTY_LOOKUPS = (() => {
  const o = Object.create(null);
  for (const name of LOOKUP_NAMES) o[name] = lookupFrom(null);
  // `var` 在詞法層被改寫成 vars
  return o;
})();

/**
 * 空的每顆子彈記憶（SPEC-EXPR-V2 §3）：`mem.<name>` 一律 0、永不寫入。
 * 沒給 `memory` 的子彈共用這一個，避免每發都建立物件。
 */
export const EMPTY_MEM = lookupFrom(null);

/**
 * 記憶名稱是否合法（SPEC-EXPR-V2 §3）：
 *   - 必須是 JS 識別字（`mem.<name>` 在詞法層以識別字解析）；
 *   - 不得是原型鏈相關的危險名稱（constructor / __proto__ / …）。
 * @param {any} name
 * @returns {boolean}
 */
export function isValidMemoryName(name) {
  if (typeof name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)) return false;
  return !FORBIDDEN_PROP_NAMES.has(name);
}

/* ------------------------------------------------------------ 編譯快取 */

/** @type {Map<string, {fn: Function|null, error: string|null}>} */
const CACHE = new Map();

/** 快取上限：超過就整批清掉（極端情況的保險，正常攻擊檔遠低於此） */
const CACHE_LIMIT = 2000;

/**
 * 編譯一段表達式（含快取）。永不 throw。
 * @param {string} src
 * @returns {{fn: Function|null, error: string|null}}
 */
export function compile(src) {
  if (typeof src !== 'string') {
    return { fn: null, error: '表達式必須是字串' };
  }
  const cached = CACHE.get(src);
  if (cached) return cached;

  let entry;
  // 第一層：詞法白名單。不通過就完全不建立函式（連 new Function 都不呼叫）。
  const lexicalError = validateExprSyntax(src);
  if (lexicalError) {
    entry = { fn: null, error: `表達式不合法：${lexicalError}` };
    if (CACHE.size >= CACHE_LIMIT) CACHE.clear();
    CACHE.set(src, entry);
    return entry;
  }

  // `var` 是 JS 保留字（不能當參數名）→ 詞法層允許 `var.x`，編譯前改寫成 `vars.x`。
  // 詞法驗證保證 `var` 只會以查表前綴的形式單獨出現。
  const compiledSrc = src.replace(/\bvar\b/g, 'vars');

  try {
    const params = expressionParams();
    // 用參數遮蔽全域；strict mode 讓 this 為 undefined
    // eslint-disable-next-line no-new-func
    const fn = new Function(...params, `"use strict";\nreturn (${compiledSrc}\n);`);
    entry = { fn, error: null };
  } catch (err) {
    entry = { fn: null, error: `表達式語法錯誤：${err && err.message ? err.message : String(err)}` };
  }
  if (CACHE.size >= CACHE_LIMIT) CACHE.clear();
  CACHE.set(src, entry);
  return entry;
}

/**
 * 編譯 / 求值共用的參數順序（兩邊必須完全一致）：
 *   [沙箱遮蔽名稱…, VAR_NAMES…, HELPER_NAMES…, LOOKUP_NAMES…]
 */
export function expressionParams() {
  return [...SANDBOX_NAMES, ...VAR_NAMES, ...HELPER_NAMES, ...LOOKUP_NAMES];
}

/** 清空編譯快取（測試用） */
export function clearExprCache() {
  CACHE.clear();
}

/** 目前快取條目數（測試用） */
export function exprCacheSize() {
  return CACHE.size;
}

/* -------------------------------------------------------------- 求值 */

/**
 * @typedef {Object} ExprContext
 * @property {number} t      事件經過秒數
 * @property {number} T      回合總秒數
 * @property {number} i      本次生成序號
 * @property {number} n      count
 * @property {number} k      emitter 第幾次觸發
 * @property {number} age    子彈存活秒數
 * @property {{x:number,y:number,w:number,h:number,left:number,right:number,top:number,bottom:number}} box
 * @property {{x:number,y:number}} soul
 * @property {number} [spawnX] 本發子彈的生成 x（未提供 → x）
 * @property {number} [spawnY] 本發子彈的生成 y（未提供 → y）
 * @property {number} [spawnT] 本發子彈的生成時間（秒；未提供 → t）
 * @property {number} [bpm]   攻擊的 BPM（未設定 → 0）
 * @property {number} [beat]  一拍秒數 = 60/bpm（未設定 → 0）
 * @property {object} [mem]   每顆子彈的記憶（未提供 → EMPTY_MEM，一律 0）
 */

/**
 * 求值單一生成欄位。永不 throw。
 *
 * @param {number|string|null|undefined} raw 欄位原值
 * @param {ExprContext} ctx
 * @param {Object} helpers createHelpers() 的結果
 * @param {Object} [lookups] 遭遇戰查表物件（mercy/hp/maxHp/alive/actCount/vars）
 * @returns {{value:number, error:string|null}}
 */
export function evalNumber(raw, ctx, helpers, lookups) {
  if (raw === null || raw === undefined || raw === '') {
    return { value: 0, error: null };
  }
  if (typeof raw === 'number') {
    return Number.isFinite(raw)
      ? { value: raw, error: null }
      : { value: 0, error: `數值不是有限數：${raw}` };
  }
  if (typeof raw === 'boolean') {
    return { value: raw ? 1 : 0, error: null };
  }
  if (typeof raw !== 'string') {
    return { value: 0, error: `欄位型別不支援（${typeof raw}）` };
  }

  const entry = compile(raw);
  if (!entry.fn) {
    return { value: 0, error: entry.error || '表達式編譯失敗' };
  }

  const box = ctx.box;
  const soul = ctx.soul;
  const h = helpers;
  // x / y：本次生成已求值的位置（sim 會回填），未提供時用戰鬥框中心
  const x = num(ctx.x, num(box && box.x, 0));
  const y = num(ctx.y, num(box && box.y, 0));
  const lk = lookups || ctx.lookups || EMPTY_LOOKUPS;
  let result;
  try {
    // 參數順序必須與 expressionParams() 完全一致：沙箱 → 變數 → 函式 → 查表
    result = entry.fn(
      ...SANDBOX_ARGS,
      num(ctx.t, 0),
      num(ctx.T, 0),
      num(ctx.i, 0),
      num(ctx.n, 1),
      num(ctx.k, 0),
      num(ctx.age, 0),
      box,
      soul,
      num(ctx.x, x),
      num(ctx.y, y),
      num(ctx.turn, 0),
      num(ctx.tp, 0),
      num(ctx.spawnX, num(ctx.x, x)),
      num(ctx.spawnY, num(ctx.y, y)),
      num(ctx.spawnT, num(ctx.t, 0)),
      num(ctx.bpm, 0),
      num(ctx.beat, 0),
      ctx.mem || EMPTY_MEM,
      h.sin,
      h.cos,
      h.tan,
      h.atan2,
      h.sqrt,
      h.abs,
      h.min,
      h.max,
      h.floor,
      h.ceil,
      h.round,
      h.PI,
      h.rand,
      h.pick,
      h.aim,
      h.lerp,
      h.trailX,
      h.trailY,
      lk.mercy || EMPTY_LOOKUPS.mercy,
      lk.hp || EMPTY_LOOKUPS.hp,
      lk.maxHp || EMPTY_LOOKUPS.maxHp,
      lk.alive || EMPTY_LOOKUPS.alive,
      lk.actCount || EMPTY_LOOKUPS.actCount,
      lk.vars || EMPTY_LOOKUPS.vars,
    );
  } catch (err) {
    return { value: 0, error: `表達式求值錯誤：${err && err.message ? err.message : String(err)}` };
  }

  if (typeof result === 'number') {
    if (!Number.isFinite(result)) {
      return { value: 0, error: `表達式結果不是有限數（${result}）` };
    }
    return { value: result, error: null };
  }
  if (typeof result === 'boolean') {
    return { value: result ? 1 : 0, error: null };
  }
  return { value: 0, error: `表達式結果不是數字（${typeof result}）` };
}

/**
 * 求值並在錯誤時透過 report 回報；供 sim 內部使用（避免每處都處理 error）。
 * @param {number|string|null|undefined} raw
 * @param {ExprContext} ctx
 * @param {Object} helpers
 * @param {(message:string)=>void} [report]
 * @returns {number}
 */
export function value(raw, ctx, helpers, report, lookups) {
  const r = evalNumber(raw, ctx, helpers, lookups);
  if (r.error && typeof report === 'function') report(r.error);
  return r.value;
}

/** 建立一份標準表達式 context（欄位齊全，缺值補 0/中心） */
export function makeContext(partial) {
  const p = partial || {};
  const box = p.box || {};
  const x = num(box.x, 0);
  const y = num(box.y, 0);
  const w = num(box.w, 0);
  const h = num(box.h, 0);
  const left = Number.isFinite(box.left) ? box.left : x - w / 2;
  const top = Number.isFinite(box.top) ? box.top : y - h / 2;
  return {
    t: num(p.t, 0),
    T: num(p.T, 0),
    i: num(p.i, 0),
    n: num(p.n, 1),
    k: num(p.k, 0),
    age: num(p.age, 0),
    box: {
      x,
      y,
      w,
      h,
      left,
      right: Number.isFinite(box.right) ? box.right : left + w,
      top,
      bottom: Number.isFinite(box.bottom) ? box.bottom : top + h,
      rotation: num(box.rotation, 0),
    },
    soul: { x: num(p.soul && p.soul.x, x), y: num(p.soul && p.soul.y, y) },
    // 本次生成已求值的位置（供 angle: "aim(x, y)" 之類的寫法）
    x: num(p.x, x),
    y: num(p.y, y),
    // 遭遇戰變數（SPEC-P2 §3）：turn / tp
    turn: num(p.turn, 0),
    tp: num(p.tp, 0),
    // 子彈運算式新變數（SPEC-EXPR-V2 §3）：沒給時退化成 x / y / t / 0
    spawnX: num(p.spawnX, num(p.x, x)),
    spawnY: num(p.spawnY, num(p.y, y)),
    spawnT: num(p.spawnT, num(p.t, 0)),
    bpm: num(p.bpm, 0),
    beat: num(p.beat, num(p.bpm, 0) > 0 ? 60 / num(p.bpm, 0) : 0),
    // 每顆子彈的記憶物件（mem.<name>；未提供 → 一律 0）
    mem: p.mem || null,
    // 查表物件（mercy/hp/maxHp/alive/actCount/vars）
    lookups: p.lookups || EMPTY_LOOKUPS,
  };
}

/** 建立本模組預設的亂數流（給沒有 battle 的場合，例如驗證器測試） */
export const fallbackRng = createRng(1);

export default evalNumber;
