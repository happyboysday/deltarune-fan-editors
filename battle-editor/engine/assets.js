/**
 * engine/assets.js — 素材索引（assets/index.json）與圖片懶載入快取
 * SPEC §2 / §9（E2 擁有）
 *
 * export async function loadAssets(indexUrl) → {
 *   index,                  // 解析後的 index.json（sprites / audio / fonts）
 *   baseUrl,                // index.json 所在目錄（絕對 URL；素材路徑相對於此）
 *   indexUrl,               // index.json 的絕對 URL
 *   error,                  // 載入失敗時的 Error，否則 null
 *   getImage(name, frame),  // → HTMLImageElement | null（未載入完成一律 null，不等待）
 *   sprite(name),           // → 索引項 | null
 *   audio(name),            // → { name, url, volume, loop } | null（缺素材回 null）
 *   resolveUrl(rel),        // 相對路徑 → 絕對 URL
 *   preload(names?),        // → Promise（names 省略時預載全部 sprite；每項 resolve 成 image|null）
 *   stats(),                // → { loaded, failed, pending, total }
 *   onProgress(fn),         // 圖片載入進度通知，回傳取消函式
 *   imageState(name, frame),// 'idle' | 'loading' | 'ready' | 'failed' | 'missing'
 * }
 *
 * 設計約定（SPEC §2）：
 * - 渲染器不得等待素材：getImage 未完成時回 null，渲染器畫洋紅佔位方塊。
 * - index.json 讀取失敗「不丟例外」：回傳空索引 + error。引擎、編輯器、渲染器都能安全降級，
 *   避免六個平行開發的模組因為 W2 尚未產出索引而整個 App 崩潰。
 */

const DEFAULT_INDEX_PATH = 'assets/index.json';
const DEFAULT_SPRITE_SIZE = 16;
/** 遊戲畫面預設點陣字體（SPEC §7） */
const DEFAULT_FONT_NAME = 'fnt_main';

/* ------------------------------------------------------------------ 工具 */

function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampInt(value, min, max) {
  const n = Math.floor(numOr(value, min));
  return Math.max(min, Math.min(max, n));
}

function emptyIndex() {
  return { format: 'dr-battle-assets/1', sprites: {}, audio: {}, fonts: {} };
}

function normalizeIndex(raw) {
  const index = emptyIndex();
  if (!raw || typeof raw !== 'object') return index;
  if (typeof raw.format === 'string') index.format = raw.format;
  if (raw.sprites && typeof raw.sprites === 'object') index.sprites = raw.sprites;
  if (raw.audio && typeof raw.audio === 'object') index.audio = raw.audio;
  if (raw.fonts && typeof raw.fonts === 'object') index.fonts = raw.fonts;
  return index;
}

/** sprite 索引項 → 影格路徑陣列（容錯：也接受 path/file 單張寫法） */
function frameList(entry) {
  if (!entry || typeof entry !== 'object') return [];
  if (Array.isArray(entry.frames)) {
    return entry.frames.filter((f) => typeof f === 'string' && f.length > 0);
  }
  if (typeof entry.path === 'string' && entry.path) return [entry.path];
  if (typeof entry.file === 'string' && entry.file) return [entry.file];
  return [];
}

function pickFrameIndex(count, frameIndex) {
  if (count <= 0) return -1;
  const n = numOr(frameIndex, 0);
  let i = Math.floor(n) % count;
  if (i < 0) i += count;
  return i;
}

function documentBase() {
  try {
    if (typeof document !== 'undefined' && document && document.baseURI) return document.baseURI;
  } catch (_err) {
    /* 無 document（例如 Node 無頭） */
  }
  return null;
}

/** 單調時鐘（瀏覽器／Node 都可用）。 */
function now() {
  try {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now();
    }
  } catch (_err) {
    /* 沒有 performance */
  }
  return Date.now();
}

function toAbsoluteUrl(url) {
  const raw = typeof url === 'string' ? url.trim() : '';
  if (!raw) return '';
  try {
    return new URL(raw, documentBase() || 'http://localhost/').href;
  } catch (_err) {
    return raw;
  }
}

/* -------------------------------------------------------- 素材倉庫工廠 */

function createAssetStore(rawIndex, baseUrl, indexUrl, error) {
  const index = normalizeIndex(rawIndex);

  /** @type {Map<string, {name:string, frame:number, url:string, state:'loading'|'ready'|'failed', img:any, done:Promise<any>}>} */
  const records = new Map();
  /** @type {Map<string, any>} 字體記錄（key = 'font:<name>'） */
  const fontRecords = new Map();
  /** @type {Map<string, any>} OTF 字體記錄（key = 'otf:<name>'） */
  const otfRecords = new Map();
  /** @type {Set<(stats:any)=>void>} */
  const progressSubs = new Set();
  /** @type {Set<string>} 已警告過的網址（避免每幀洗版） */
  const warned = new Set();

  const stats = { loaded: 0, failed: 0, pending: 0, total: 0 };
  const fontStats = { loaded: 0, failed: 0, pending: 0, total: 0 };

  resetCounters();

  function resetCounters() {
    stats.loaded = 0;
    stats.failed = 0;
    stats.pending = 0;
    stats.total = 0;
    for (const name of Object.keys(index.sprites || {})) {
      stats.total += frameList(index.sprites[name]).length;
    }
    fontStats.loaded = 0;
    fontStats.failed = 0;
    fontStats.pending = 0;
    fontStats.total = Object.keys(index.fonts || {}).length;
  }

  function notifyProgress() {
    if (!progressSubs.size) return;
    const snapshot = {
      loaded: stats.loaded,
      failed: stats.failed,
      pending: stats.pending,
      total: stats.total,
      fonts: {
        loaded: fontStats.loaded,
        failed: fontStats.failed,
        pending: fontStats.pending,
        total: fontStats.total,
      },
    };
    for (const fn of [...progressSubs]) {
      try {
        fn(snapshot);
      } catch (_err) {
        /* 訂閱者出錯不影響載入 */
      }
    }
  }

  function resolveUrl(rel) {
    if (typeof rel !== 'string' || !rel) return '';
    if (/^(?:[a-z]+:)?\/\//i.test(rel) || /^data:/i.test(rel)) return toAbsoluteUrl(rel);
    const base = baseUrl || documentBase() || '';
    try {
      return new URL(rel, base || undefined).href;
    } catch (_err) {
      return base ? base.replace(/\/?$/, '/') + rel.replace(/^\/+/, '') : rel;
    }
  }

  function sprite(name) {
    if (!name || typeof name !== 'string') return null;
    const list = index.sprites;
    if (!list || typeof list !== 'object') return null;
    const entry = list[name];
    return entry && typeof entry === 'object' ? entry : null;
  }

  function imageSize(entry, img) {
    const w = numOr(img && (img.naturalWidth || img.width), 0) || numOr(entry && entry.w, DEFAULT_SPRITE_SIZE);
    const h = numOr(img && (img.naturalHeight || img.height), 0) || numOr(entry && entry.h, DEFAULT_SPRITE_SIZE);
    return { w: w > 0 ? w : DEFAULT_SPRITE_SIZE, h: h > 0 ? h : DEFAULT_SPRITE_SIZE };
  }

  function recordKey(name, frame) {
    return name + '\u0000' + frame;
  }

  function startLoad(rec) {
    let img = null;
    try {
      img = new Image();
    } catch (_err) {
      img = null;
    }
    if (!img) {
      rec.state = 'failed';
      stats.pending = Math.max(0, stats.pending - 1);
      stats.failed += 1;
      rec.doneResolve(null);
      notifyProgress();
      return;
    }
    rec.img = img;
    try {
      img.decoding = 'async';
    } catch (_err) {
      /* 舊瀏覽器忽略 */
    }
    img.onload = () => {
      if (rec.state !== 'loading') return;
      if (numOr(img.naturalWidth, 0) > 0) {
        rec.state = 'ready';
        stats.loaded += 1;
      } else {
        rec.state = 'failed';
        stats.failed += 1;
        warnOnce(rec.url, '圖片解碼失敗（0 寬）');
      }
      stats.pending = Math.max(0, stats.pending - 1);
      rec.doneResolve(rec.state === 'ready' ? img : null);
      notifyProgress();
    };
    img.onerror = () => {
      if (rec.state !== 'loading') return;
      rec.state = 'failed';
      stats.failed += 1;
      stats.pending = Math.max(0, stats.pending - 1);
      rec.doneResolve(null);
      warnOnce(rec.url, '圖片載入失敗');
      notifyProgress();
    };
    try {
      img.src = rec.url;
    } catch (_err) {
      rec.state = 'failed';
      stats.failed += 1;
      stats.pending = Math.max(0, stats.pending - 1);
      rec.doneResolve(null);
      notifyProgress();
    }
  }

  function warnOnce(url, message) {
    if (!url || warned.has(url)) return;
    warned.add(url);
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[assets] ' + message + '：' + url + '（渲染器改用洋紅佔位方塊）');
    }
  }

  function ensureRecord(name, entry, frames, frameIndex) {
    const fi = pickFrameIndex(frames.length, frameIndex);
    if (fi < 0) return null;
    const key = recordKey(name, fi);
    const existing = records.get(key);
    if (existing) return existing;

    let doneResolve = null;
    const done = new Promise((resolve) => {
      doneResolve = resolve;
    });
    const rec = {
      name,
      frame: fi,
      url: resolveUrl(frames[fi]),
      state: 'loading',
      img: null,
      done,
      doneResolve,
    };
    records.set(key, rec);
    stats.pending += 1;
    notifyProgress();
    startLoad(rec);
    return rec;
  }

  /**
   * 取圖。未載入完成時回 null（渲染器畫佔位方塊，不等待）。
   * @param {string} name
   * @param {number} [frameIndex]
   * @returns {any|null}
   */
  function getImage(name, frameIndex) {
    const entry = sprite(name);
    if (!entry) return null;
    const frames = frameList(entry);
    if (!frames.length) return null;
    const rec = ensureRecord(name, entry, frames, frameIndex);
    if (!rec) return null;
    if (rec.state !== 'ready') return null;
    const img = rec.img;
    if (!img) return null;
    const w = numOr(img.naturalWidth, 0);
    if (w <= 0) return null;
    return img;
  }

  function imageState(name, frameIndex) {
    const entry = sprite(name);
    if (!entry) return 'missing';
    const frames = frameList(entry);
    if (!frames.length) return 'missing';
    const fi = pickFrameIndex(frames.length, frameIndex);
    const rec = records.get(recordKey(name, fi));
    return rec ? rec.state : 'idle';
  }

  function waitRecord(name, frameIndex) {
    const entry = sprite(name);
    if (!entry) return Promise.resolve(null);
    const frames = frameList(entry);
    if (!frames.length) return Promise.resolve(null);
    const rec = ensureRecord(name, entry, frames, frameIndex);
    if (!rec) return Promise.resolve(null);
    return rec.done;
  }

  /**
   * 預載。names 省略時預載全部 sprite。
   * @param {string[]} [names]
   * @returns {Promise<Array<any>>}
   */
  function preload(names) {
    let list;
    if (Array.isArray(names) && names.length) list = names;
    else list = Object.keys(index.sprites);
    const tasks = [];
    for (const name of list) {
      const entry = sprite(name);
      if (!entry) continue;
      const frames = frameList(entry);
      for (let i = 0; i < frames.length; i += 1) tasks.push(waitRecord(name, i));
    }
    return Promise.all(tasks);
  }

  /** 音效索引項 → { name, url, volume, loop }；缺失回 null（audio.js 靜默） */
  function audio(name) {
    if (!name || typeof name !== 'string') return null;
    const list = index.audio;
    if (!list || typeof list !== 'object') return null;
    const entry = list[name];
    if (!entry) return null;

    let rel = null;
    let volume = 1;
    let loop = false;
    if (typeof entry === 'string') {
      rel = entry;
    } else if (Array.isArray(entry)) {
      rel = entry.find((v) => typeof v === 'string') || null;
    } else if (typeof entry === 'object') {
      // 注意：官方索引的 `src` 是「來源資料檔群組名」（如 audiogroup1），不是路徑，
      // 真實路徑在 `file`。因此先取明確路徑欄位，再退回看起來像音檔的候選。
      const candidates = [entry.file, entry.path, entry.ogg, entry.wav, entry.mp3, entry.url, entry.src];
      if (Array.isArray(entry.frames)) candidates.push(entry.frames[0]);
      if (Array.isArray(entry.files)) candidates.push(entry.files[0]);
      const looksLikePath = (v) =>
        typeof v === 'string' &&
        v.length > 0 &&
        (/\.(ogg|wav|mp3|m4a|flac|opus)$/i.test(v) || v.includes('/'));
      const fromPathFields = candidates.slice(0, 6).find(looksLikePath);
      rel =
        fromPathFields ||
        candidates.find((v) => typeof v === 'string' && v.length > 0) ||
        null;
      // 若只有群組名（無副檔名、無斜線），視為缺失（audio.js 靜默）
      if (rel && !looksLikePath(rel)) rel = null;
      volume = numOr(entry.volume, 1);
      loop = entry.loop === true;
    }
    if (!rel) return null;
    return { name, url: resolveUrl(rel), volume, loop };
  }

  /* ------------------------------------------------------------- 字體 */

  /**
   * 字體索引項（assets.index.fonts[name]）→ 正規化描述。
   * 支援兩種 kind：
   *   - 點陣 `dr-battle-font/1`：{ image, glyphs, size, lineHeight, lang?, base? }
   *   - OTF/TTF：{ kind:'otf', file:'fonts/DTM.otf', lang:'zh', family? }
   * 也容忍 { png, json } / 單一字串等寫法。
   */
  function fontEntry(name) {
    if (!name || typeof name !== 'string') return null;
    const list = index.fonts;
    if (!list || typeof list !== 'object') return null;
    const entry = list[name];
    if (!entry || typeof entry !== 'object') return null;
    const imageRel =
      [entry.image, entry.png, entry.glyphs_png, entry.atlas].find((v) => typeof v === 'string' && v) || null;
    const metaRel =
      [entry.glyphs, entry.json, entry.glyphs_json, entry.meta].find((v) => typeof v === 'string' && v) || null;
    const fileRel =
      [entry.file, entry.otf, entry.fontFile, entry.src, entry.url].find((v) => typeof v === 'string' && v) || null;
    const kind = entry.kind === 'otf' || (!imageRel && fileRel) ? 'otf' : 'bitmap';
    const lang = entry.lang === 'zh' ? 'zh' : entry.lang === 'en' ? 'en' : null;
    const base = typeof entry.base === 'string' && entry.base ? entry.base : null;
    const family =
      typeof entry.family === 'string' && entry.family
        ? entry.family
        : kind === 'otf'
          ? name.replace(/(?:@zh|@en)$/i, '')
          : null;
    const size = numOr(entry.size, numOr(entry.emSize, 12));
    return {
      name,
      kind,
      imageRel,
      metaRel,
      fileRel,
      family,
      lang,
      base,
      size,
      lineHeight: numOr(entry.lineHeight, 0) || size + 4,
      entry,
    };
  }

  /** 移除 @zh / @en 後綴，取得基底字體名（SPEC §7 退回鏈用） */
  function fontBaseName(name) {
    return typeof name === 'string' && name ? name.replace(/(?:@zh|@en)$/i, '') : '';
  }

  /** 索引中是否有此字體 */
  function hasFont(name) {
    return !!fontEntry(name);
  }

  /** 列出索引內字體名稱 */
  function fontNames() {
    return Object.keys(index.fonts || {});
  }

  /* ------------------------------------------------ OTF 字體（DTM.otf） */

  /**
   * 懶載入 OTF（用 FontFace）；檔案缺失或環境不支援時標記 failed，不丟例外。
   * @returns {{name:string, kind:'otf', family:string, state:string, done:Promise<any>}}
   */
  function ensureOtfRecord(name, desc) {
    const key = 'otf:' + name;
    const existing = otfRecords.get(key);
    if (existing) return existing;

    let doneResolve = null;
    const done = new Promise((resolve) => {
      doneResolve = resolve;
    });
    const family = desc.family || name.replace(/(?:@zh|@en)$/i, '');
    const rec = { name, desc, kind: 'otf', family, state: 'loading', face: null, done, doneResolve };
    otfRecords.set(key, rec);
    fontStats.pending += 1;

    const finish = (ok) => {
      if (rec.state !== 'loading') return;
      rec.state = ok ? 'ready' : 'failed';
      if (ok) fontStats.loaded += 1;
      else fontStats.failed += 1;
      fontStats.pending = Math.max(0, fontStats.pending - 1);
      rec.doneResolve(ok ? rec : null);
      notifyProgress();
    };
    const failLater = () => {
      try {
        setTimeout(() => finish(false), 0);
      } catch (_err) {
        finish(false);
      }
    };

    if (!desc.fileRel) {
      failLater();
      return rec;
    }
    if (
      typeof FontFace !== 'function' ||
      typeof document === 'undefined' ||
      !document ||
      !document.fonts ||
      typeof document.fonts.add !== 'function'
    ) {
      failLater();
      return rec;
    }

    const url = resolveUrl(desc.fileRel);
    try {
      const face = new FontFace(family, 'url("' + url + '")');
      face.load().then(
        (loaded) => {
          rec.face = loaded || face;
          try {
            document.fonts.add(rec.face);
          } catch (err) {
            if (typeof console !== 'undefined' && console.warn) {
              console.warn('[assets] 無法註冊字體 ' + family + '：', err && err.message ? err.message : err);
            }
          }
          finish(true);
        },
        () => {
          warnOnce(url, '字體檔載入失敗');
          finish(false);
        },
      );
    } catch (_err) {
      failLater();
    }
    return rec;
  }


  function makeFontRecord(name, desc) {
    const key = 'font:' + name;
    const existing = fontRecords.get(key);
    if (existing) return existing;

    // OTF 字型走 FontFace 路徑
    if (desc.kind === 'otf') return ensureOtfRecord(name, desc);

    let doneResolve = null;
    const done = new Promise((resolve) => {
      doneResolve = resolve;
    });
    const rec = {
      name,
      desc,
      state: 'loading',
      image: null,
      meta: null,
      glyphs: null,
      glyphMap: new Map(),
      done,
      doneResolve,
      pending: 0,
    };
    fontRecords.set(key, rec);
    fontStats.pending += 1;

    const finish = () => {
      rec.pending -= 1;
      if (rec.pending > 0) return;
      if (rec.image && rec.meta) {
        rec.state = 'ready';
        fontStats.loaded += 1;
      } else {
        rec.state = 'failed';
        fontStats.failed += 1;
      }
      fontStats.pending = Math.max(0, fontStats.pending - 1);
      rec.doneResolve(rec.state === 'ready' ? rec : null);
      notifyProgress();
    };

    // 圖集（Image）
    if (!desc.imageRel || typeof Image !== 'function') {
      rec.pending += 1;
      setTimeout(finish, 0);
    } else {
      rec.pending += 1;
      let img = null;
      try {
        img = new Image();
      } catch (_err) {
        img = null;
      }
      if (!img) {
        setTimeout(finish, 0);
      } else {
        const url = resolveUrl(desc.imageRel);
        img.onload = () => {
          if (numOr(img.naturalWidth, 0) > 0) rec.image = img;
          finish();
        };
        img.onerror = () => {
          warnOnce(url, '字體圖集載入失敗');
          finish();
        };
        try {
          img.src = url;
        } catch (_err) {
          finish();
        }
      }
    }

    // 字形 JSON
    if (!desc.metaRel || typeof fetch !== 'function') {
      rec.pending += 1;
      setTimeout(finish, 0);
    } else {
      rec.pending += 1;
      const url = resolveUrl(desc.metaRel);
      fetch(url, { cache: 'no-cache' })
        .then((response) => {
          if (!response || !response.ok) throw new Error('HTTP ' + (response ? response.status : '?'));
          return response.json();
        })
        .then(
          (data) => {
            if (data && typeof data === 'object') {
              rec.meta = data;
              rec.glyphs = data.glyphs && typeof data.glyphs === 'object' ? data.glyphs : {};
              rec.glyphMap = new Map();
              for (const key of Object.keys(rec.glyphs)) {
                const code = Number(key);
                const glyph = rec.glyphs[key];
                if (!Number.isFinite(code) || !glyph || typeof glyph !== 'object') continue;
                // 前進量為 0 的字形視為「無字」；寬高為 0 者仍保留前進量，
                // 但 missingChar 會把它當缺字（例如 fnt_small 的 % # & 等）。
                if (numOr(glyph.shift, 0) > 0) rec.glyphMap.set(code, glyph);
              }
            }
            finish();
          },
          () => {
            warnOnce(url, '字體字形檔載入失敗');
            finish();
          },
        );
    }

    return rec;
  }

  /**
   * 取字體（懶載入）。SPEC §7：「fnt_main」等為點陣字；「DTM」等 kind:'otf' 走 FontFace。
   * @param {string} [name='fnt_main']
   * @returns {any|null} 點陣：{name, image, meta, glyphs, glyphMap, size, lineHeight, glyph, measure, missingChar}
   *                    OTF：{name, kind:'otf', family, face, glyph:()=>null, measure, missingChar:()=>null}
   *                    未載入完成 / 缺索引 → null（渲染器自動退回下一層）
   */
  function getFont(name) {
    const fontName = typeof name === 'string' && name ? name : DEFAULT_FONT_NAME;
    const desc = fontEntry(fontName);
    if (!desc) return null;
    const rec = makeFontRecord(fontName, desc);
    if (!rec || rec.state !== 'ready') return null;

    // OTF 字體：給渲染器一個通用的「系統字」介面
    if (rec.kind === 'otf') {
      if (!rec.facade) {
        rec.facade = {
          name: fontName,
          kind: 'otf',
          family: rec.family,
          face: rec.face,
          image: null,
          glyph: () => null,
          missingChar: () => null,
          size: desc.size,
          lineHeight: desc.lineHeight,
          measure() {
            return 0; // 由渲染器用 canvas measureText 量測
          },
        };
      }
      return rec.facade;
    }

    if (!rec.facade) {
      const meta = rec.meta || {};
      const size = numOr(meta.size, numOr(meta.emSize, desc.size));
      rec.facade = {
        name: fontName,
        image: rec.image,
        meta,
        glyphs: rec.glyphs || {},
        glyphMap: rec.glyphMap,
        size,
        lineHeight: numOr(meta.lineHeight, desc.lineHeight),
        imageW: numOr(meta.imageW, numOr(rec.image && rec.image.naturalWidth, 0)),
        imageH: numOr(meta.imageH, numOr(rec.image && rec.image.naturalHeight, 0)),
        glyph(char) {
          if (typeof char !== 'string' || !char) return null;
          const code = char.codePointAt(0);
          const glyph = rec.glyphMap.get(code) || null;
          if (!glyph) return null;
          // 空字形（w/h 皆 0）→ 視為缺字，由呼叫端退回系統字
          if (numOr(glyph.w, 0) <= 0 && numOr(glyph.h, 0) <= 0) return null;
          return glyph;
        },
        /** 寬度（不含換行；\n 視為換行，取最寬一行） */
        measure(text) {
          if (typeof text !== 'string' || !text) return 0;
          let maxW = 0;
          let cur = 0;
          for (const ch of text) {
            if (ch === '\n') {
              if (cur > maxW) maxW = cur;
              cur = 0;
              continue;
            }
            const glyph = rec.glyphMap.get(ch.codePointAt(0));
            cur += glyph ? numOr(glyph.shift, 0) : 0;
          }
          return Math.max(maxW, cur);
        },
        /** 缺字檢查：回傳第一個沒有字形的字（空白除外），全部有則 null */
        missingChar(text) {
          if (typeof text !== 'string') return '';
          for (const ch of text) {
            if (ch === '\n' || ch === ' ') continue;
            if (!rec.glyphMap.has(ch.codePointAt(0))) return ch;
          }
          return null;
        },
      };
    }
    return rec.facade;
  }

  function fontState(name) {
    const fontName = typeof name === 'string' && name ? name : DEFAULT_FONT_NAME;
    const desc = fontEntry(fontName);
    if (!desc) return 'missing';
    const rec = fontRecords.get('font:' + fontName) || otfRecords.get('otf:' + fontName);
    return rec ? rec.state : 'idle';
  }

  /** 預載字體；省略 names 時預載索引內全部字體 */
  function preloadFonts(names) {
    let list;
    if (Array.isArray(names) && names.length) list = names;
    else list = Object.keys(index.fonts || {});
    const tasks = [];
    for (const name of list) {
      const desc = fontEntry(name);
      if (!desc) continue;
      const rec = makeFontRecord(name, desc);
      tasks.push(rec.done);
    }
    return Promise.all(tasks);
  }

  function font(name) {
    const desc = fontEntry(name);
    return desc ? desc.entry : null;
  }

  function statsSnapshot() {
    return {
      loaded: stats.loaded,
      failed: stats.failed,
      pending: stats.pending,
      total: stats.total,
      fonts: {
        loaded: fontStats.loaded,
        failed: fontStats.failed,
        pending: fontStats.pending,
        total: fontStats.total,
      },
    };
  }

  function onProgress(fn) {
    if (typeof fn !== 'function') return () => {};
    progressSubs.add(fn);
    try {
      fn(statsSnapshot());
    } catch (_err) {
      /* 忽略 */
    }
    return () => progressSubs.delete(fn);
  }

  /* ------------------------------------------------------- 全部載入訊號 */

  /**
   * 還沒載入完成（或失敗）的請求數：圖片 + 字體。
   * 0 代表「目前所有已請求的素材都已經有結果」，渲染器可以放心截圖
   * （不會再畫到洋紅佔位方塊）。
   */
  function pendingCount() {
    return Math.max(0, stats.pending) + Math.max(0, fontStats.pending);
  }

  /**
   * 等所有已請求的素材載入完成或失敗。
   *
   * - 目前沒有 pending 時立刻 resolve（不會拖到下一幀）。
   * - 等待期間新發起的請求也算在內（例如第一次繪製才懶載入的精靈）。
   * - `timeoutMs` > 0 時最多等這麼久，逾時 resolve `{ idle:false, timedOut:true }`。
   * - 永不 reject；回傳 `{ idle, timedOut, snapshot, elapsedMs }`。
   *
   * @param {{timeoutMs?:number}} [options]
   * @returns {Promise<{idle:boolean, timedOut:boolean, snapshot:any, elapsedMs:number}>}
   */
  function whenIdle(options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const timeoutMs = Math.max(0, numOr(opts.timeoutMs, 0) || 0);
    const started = now();
    const result = (timedOut) => ({
      idle: pendingCount() === 0,
      timedOut: Boolean(timedOut),
      snapshot: statsSnapshot(),
      elapsedMs: Math.max(0, Math.round(now() - started)),
    });
    if (pendingCount() === 0) return Promise.resolve(result(false));

    return new Promise((resolvePromise) => {
      let settled = false;
      let unsubscribe = null;
      let timer = null;
      let poll = null;
      const finish = (timedOut) => {
        if (settled) return;
        settled = true;
        if (unsubscribe) unsubscribe();
        if (timer) clearTimeout(timer);
        if (poll) clearInterval(poll);
        resolvePromise(result(timedOut));
      };
      // 主動輪詢：載入完成不一定會通知（例如索引失敗 / 環境沒有 Image），
      // 有輪詢才能保證「有結果就 resolve」而不是死等。
      // （刻意不 unref：有人在等這個 Promise，process 就不該提前結束；
      //   不想等的人請給 timeoutMs。）
      poll = setInterval(() => {
        if (pendingCount() === 0) finish(false);
      }, 50);
      unsubscribe = onProgress(() => {
        if (pendingCount() === 0) finish(false);
      });
      if (timeoutMs > 0) {
        timer = setTimeout(() => finish(true), timeoutMs);
      }
    });
  }

  return {
    index,
    baseUrl,
    indexUrl,
    error: error || null,
    getImage,
    sprite,
    audio,
    resolveUrl,
    preload,
    stats: statsSnapshot,
    onProgress,
    /** 還沒載入完成的請求數（圖片＋字體）；0 = 全部都有結果。 */
    pendingCount,
    /** 等所有已請求素材載入完成或失敗（永不 reject）。 */
    whenIdle,
    imageState,
    // 字體（SPEC §7 2026-11-07 更新：zh/en 語言、中文字庫、DTM.otf）
    getFont,
    font,
    fontState,
    preloadFonts,
    hasFont,
    fontNames,
    fontBaseName,
    /** 索引項原樣（除錯/編輯器素材面板用） */
    fontEntry,
    /** 便利：回傳已載入的圖片大小（未載入時用索引 w/h） */
    spriteSize(name) {
      const entry = sprite(name);
      if (!entry) return null;
      const rec = records.get(recordKey(name, pickFrameIndex(frameList(entry).length, 0)));
      return imageSize(entry, rec && rec.state === 'ready' ? rec.img : null);
    },
  };
}

/* ------------------------------------------------------------ 對外 API */

/**
 * 讀取素材索引並建立素材倉庫。
 * @param {string} [indexUrl='assets/index.json'] 相對於目前頁面
 * @returns {Promise<any>} 永不 reject；失敗時 error 有值、index 為空。
 */
export async function loadAssets(indexUrl) {
  const requested = typeof indexUrl === 'string' && indexUrl.trim() ? indexUrl.trim() : DEFAULT_INDEX_PATH;
  const absUrl = toAbsoluteUrl(requested);
  let baseUrl = '';
  try {
    baseUrl = new URL('.', absUrl || requested).href;
  } catch (_err) {
    baseUrl = '';
  }

  let index = null;
  let error = null;

  if (typeof fetch !== 'function') {
    error = new Error('此環境不支援 fetch（無法載入素材索引）');
  } else {
    try {
      const response = await fetch(absUrl || requested, { cache: 'no-cache' });
      if (!response || !response.ok) {
        throw new Error('HTTP ' + (response ? response.status : '?') + '（' + (absUrl || requested) + '）');
      }
      const data = await response.json();
      if (!data || typeof data !== 'object') throw new Error('索引格式錯誤：不是 JSON 物件');
      index = data;
    } catch (err) {
      error = err instanceof Error ? err : new Error(String(err));
    }
  }

  const store = createAssetStore(index, baseUrl, absUrl || requested, error);
  if (error && typeof console !== 'undefined' && console.warn) {
    console.warn('[assets] 無法載入素材索引，改用空索引（全部畫洋紅佔位方塊）：' + error.message);
  }
  return store;
}

export default loadAssets;
