/**
 * tools/agent/render.mjs — 無頭截圖（SPEC-AGENT §3）。
 *
 * 為什麼要有這支：
 *   Agent 寫完彈幕後看不到畫面。這裡用 headless Edge + CDP（Chrome DevTools Protocol）
 *   開真正的 play.html / encounter-play.html，在指定幀截 PNG，還能拼成一張聯絡表。
 *   完全零外部依賴：Node 內建的 WebSocket + fetch 就能講 CDP。
 *
 * 為什麼要自己起伺服器：
 *   play.html 需要 HTTP（ES module + fetch 素材）。若沒有現成伺服器，這裡會用
 *   `serve.py` 起在隨機埠，結束時關掉——不干擾協調者/編輯器正在用的 18900。
 *
 * 用法：
 *   node tools/agent/render.mjs samples/spade-rain.json --frames 0,60,150 --sheet
 *   node tools/agent/render.mjs samples/encounters/rudinn.json --frames 300,420,520
 *   node tools/agent/render.mjs attacks/xxx.json --lang en --scale 3 --out ./shots
 *   node tools/agent/render.mjs <檔> --json          # 只回報檔案與狀態，不印表格
 *
 * 輸出（--json）：{ file, kind, frames:[{frame,file,state}], sheet, server, edge, warnings[] }
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

import { once } from 'node:events';

import {
  BATTLE_EDITOR,
  WORKS_DIR,
  applyCliPaths,
  cliEntry,
  isFile,
  numArg,
  parseArgs,
  readJSON,
  resolveInputFile,
  round,
  toPosix,
} from './lib.mjs';
import { detectKind } from './sim.mjs';

/* ------------------------------------------------------------- 小工具 */

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 找一個沒人用的 TCP 埠。 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitFor(check, { timeoutMs = 20000, intervalMs = 100, label = '條件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(intervalMs);
  }
  throw new Error(`${label}逾時（${timeoutMs}ms）${lastError ? `：${lastError.message}` : ''}`);
}

/* --------------------------------------------------------------- CDP */

function decodeWsData(data) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

/** 極簡 CDP 客戶端（一條 WebSocket、JSON-RPC）。 */
export class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = null;
    this.closed = false;
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket 連線逾時')), 15000);
      this.ws.addEventListener(
        'open',
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
      this.ws.addEventListener(
        'error',
        () => {
          clearTimeout(timer);
          reject(new Error('WebSocket 連線失敗（Edge 的 debug 埠）'));
        },
        { once: true },
      );
    });
    this.ws.addEventListener('message', (event) => {
      let message = null;
      try {
        message = JSON.parse(decodeWsData(event.data));
      } catch (_err) {
        return;
      }
      this._dispatch(message);
    });
    this.ws.addEventListener('close', () => {
      this.closed = true;
      for (const entry of this.pending.values()) entry.reject(new Error('CDP 連線已關閉'));
      this.pending.clear();
    });
    return this;
  }

  _dispatch(message) {
    if (message.id && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`CDP ${message.error.message || '錯誤'}${message.error.code ? `（${message.error.code}）` : ''}`));
      else entry.resolve(message.result || {});
      return;
    }
    if (message.method) {
      const list = this.handlers.get(message.method);
      if (list) for (const cb of list) cb(message.params || {});
    }
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('CDP 已關閉'));
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 逾時：${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });
    this.ws.send(JSON.stringify({ id, method, params }));
    return promise;
  }

  on(method, cb) {
    const list = this.handlers.get(method) || [];
    list.push(cb);
    this.handlers.set(method, list);
    return () => {
      const current = this.handlers.get(method) || [];
      this.handlers.set(
        method,
        current.filter((item) => item !== cb),
      );
    };
  }

  waitForEvent(method, timeoutMs = 20000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`等待事件逾時：${method}`));
      }, timeoutMs);
      const off = this.on(method, (params) => {
        clearTimeout(timer);
        off();
        resolve(params);
      });
    });
  }

  /** 在頁面求值；預設回傳 JSON 值。 */
  async evaluate(expression, options = {}) {
    const result = await this.send(
      'Runtime.evaluate',
      {
        expression,
        returnByValue: options.returnByValue !== false,
        awaitPromise: Boolean(options.awaitPromise),
        userGesture: true,
        timeout: options.timeoutMs || 30000,
      },
      options.timeoutMs || 35000,
    );
    if (result.exceptionDetails) {
      const detail =
        (result.exceptionDetails.exception && result.exceptionDetails.exception.description) ||
        result.exceptionDetails.text ||
        '未知錯誤';
      throw new Error(`頁面執行錯誤：${detail}`);
    }
    return result.result ? result.result.value : undefined;
  }

  close() {
    try {
      this.ws.close();
    } catch (_err) {
      /* 已關 */
    }
  }
}

/* ------------------------------------------------------------ 伺服器 */

const PYTHON_CANDIDATES = ['python', 'python3', 'py'];

/**
 * 起一個本專案的 serve.py（隨機埠），回傳可關閉的控制物件。
 *
 * --works：作品根與程式根不同時傳給 serve.py（伺服器要從作品根提供 attacks/encounters/
 * assets/custom/）。舊版 serve.py 不認得 --works 會直接 argparse 失敗（exit 2）→ 這裡把
 * stderr 接起來，給「serve.py 太舊」的明確訊息，而不是只說「伺服器行程已結束」。
 */
export async function startServer(options = {}) {
  const script = join(BATTLE_EDITOR, 'serve.py');
  if (!isFile(script)) throw new Error(`找不到 serve.py：${script}`);
  const port = options.port || (await findFreePort());
  const host = options.host || '127.0.0.1';
  const python = options.python || process.env.DR_PYTHON || null;
  const candidates = python ? [python] : PYTHON_CANDIDATES;
  const works = options.works && options.works !== BATTLE_EDITOR ? options.works : null;

  let proc = null;
  let lastError = null;
  for (const candidate of candidates) {
    const argv = [script, '--host', host, '--port', String(port), '--quiet'];
    if (works) argv.push('--works', works);
    const child = spawn(candidate, argv, {
      cwd: BATTLE_EDITOR,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let exited = false;
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
      if (stderr.length > 4000) stderr = stderr.slice(-4000);
    });
    child.on('exit', () => {
      exited = true;
    });
    try {
      await once(child, 'spawn');
      await waitFor(
        async () => {
          if (exited) {
            const detail = stderr.trim();
            if (works && /unrecognized arguments|no such option|invalid choice/i.test(detail)) {
              throw new Error(
                `serve.py 不支援 --works（作品根 ${works}）。請更新 serve.py（V2-05）或改在程式根直接截圖。\n${detail.split('\n').slice(-3).join('\n')}`,
              );
            }
            throw new Error(`伺服器行程已結束${detail ? `：${detail.split('\n').slice(-2).join(' / ')}` : ''}`);
          }
          const response = await fetch(`http://${host}:${port}/play.html`, { method: 'GET' });
          return response.ok;
        },
        { timeoutMs: 15000, intervalMs: 150, label: `伺服器啟動（${candidate}）` },
      );
      proc = child;
      break;
    } catch (err) {
      lastError = err;
      try {
        child.kill();
      } catch (_err) {
        /* 已死 */
      }
    }
  }
  if (!proc) {
    throw new Error(`無法啟動 serve.py：${lastError ? lastError.message : '未知原因'}（可用 DR_PYTHON 指定 python 路徑）`);
  }

  return {
    url: `http://${host}:${port}`,
    host,
    port,
    started: true,
    async close() {
      try {
        proc.kill();
      } catch (_err) {
        /* 已死 */
      }
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } catch (_err) {
          /* 忽略 */
        }
      }
    },
  };
}

/* -------------------------------------------------------------- Edge */

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge Beta/Application/msedge.exe',
];

export function findEdge() {
  const fromEnv = process.env.MSEDGE_PATH || process.env.EDGE_PATH;
  const candidates = fromEnv ? [fromEnv, ...EDGE_CANDIDATES] : EDGE_CANDIDATES;
  for (const candidate of candidates) {
    if (isFile(candidate)) return candidate;
  }
  return null;
}

/** 啟動 headless Edge 並連上它的 page target。 */
export async function launchEdge(options = {}) {
  const exe = options.exe || findEdge();
  if (!exe) throw new Error('找不到 Edge（可用 MSEDGE_PATH 指定 msedge.exe 路徑）');
  const debugPort = options.debugPort || (await findFreePort());
  const profileDir = options.profileDir || mkdtempSync(join(tmpdir(), 'dr-edge-profile-'));
  const windowSize = options.windowSize || '1500,1100';
  const args = [
    '--headless=new',
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate,MediaRouter',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-device-scale-factor=1',
    `--window-size=${windowSize}`,
    'about:blank',
  ];
  const proc = spawn(exe, args, { stdio: 'ignore', windowsHide: true });

  const version = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
      if (!response.ok) return null;
      return response.json();
    },
    { timeoutMs: 25000, intervalMs: 200, label: 'Edge 啟動' },
  );

  const pageTarget = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const list = await response.json();
      return list.find((target) => target.type === 'page' && target.webSocketDebuggerUrl) || null;
    },
    { timeoutMs: 15000, intervalMs: 150, label: 'Edge page target' },
  );

  const cdp = await new CDP(pageTarget.webSocketDebuggerUrl).connect();

  return {
    cdp,
    exe,
    debugPort,
    profileDir,
    browser: version.Browser || 'Edge',
    async close() {
      // Windows can relaunch Edge under a different PID; close the actual browser over CDP.
      try {
        await cdp.send('Browser.close', {}, 5000);
      } catch (err) {
        if (!cdp.closed) throw err;
      }
      cdp.close();
      try {
        proc.kill();
      } catch (_err) {
        /* 已死 */
      }
      if (process.platform === 'win32') {
        try {
          spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
        } catch (_err) {
          /* 忽略 */
        }
      }
      await sleep(300);
      if (!options.keepProfile) {
        try {
          rmSync(profileDir, { recursive: true, force: true });
        } catch (_err) {
          /* Edge 可能還鎖著，留著也無害（在 TEMP） */
        }
      }
    },
  };
}

/* ------------------------------------------------------------ 頁面操作 */

/** 攻擊頁：凍結 rAF（決定性），用 __drPlay.tick 精準推進。 */
const FREEZE_RAF = `(() => {
  window.__drRafQueue = [];
  window.requestAnimationFrame = (cb) => { window.__drRafQueue.push(cb); return window.__drRafQueue.length; };
  window.cancelAnimationFrame = () => {};
})();`;

/*
 * 素材全部載入的訊號（engine/assets.js 2026-11 新增 pendingCount()/whenIdle()）。
 *
 * 頁面曝光順序：
 *   1. window.__drAssetsIdle（若頁面提供：function / {whenIdle} / 數字 pending）
 *   2. __drEncounterPlay.assets().whenIdle({timeoutMs})
 *   3. __drPlay.assets().whenIdle（若頁面之後補上）
 *   4. 都沒有 → 回 {unsupported:true}，呼叫端退回「畫兩次 + 小睡」的舊做法。
 * 回傳 {idle, timedOut, pending, unsupported}。
 */
const ASSETS_IDLE_EXPR = `(async () => {
  const idleHandle = window.__drAssetsIdle;
  if (idleHandle) {
    try {
      if (typeof idleHandle === 'function') {
        const r = await idleHandle({ timeoutMs: 8000 });
        if (r && typeof r === 'object') return { idle: r.idle !== false, timedOut: !!r.timedOut, pending: r.pendingCount !== undefined ? r.pendingCount : null };
        return { idle: true, timedOut: false, pending: null };
      }
      if (typeof idleHandle.whenIdle === 'function') {
        const r = await idleHandle.whenIdle({ timeoutMs: 8000 });
        return { idle: !!(r && r.idle), timedOut: !!(r && r.timedOut), pending: typeof idleHandle.pendingCount === 'function' ? idleHandle.pendingCount() : null };
      }
      if (typeof idleHandle === 'number') return { idle: idleHandle <= 0, timedOut: false, pending: idleHandle };
    } catch (_err) {
      /* 落回下面的 store 路徑 */
    }
  }
  const store = (() => {
    try {
      if (window.__drEncounterPlay && typeof window.__drEncounterPlay.assets === 'function') return window.__drEncounterPlay.assets();
      if (window.__drPlay && typeof window.__drPlay.assets === 'function') return window.__drPlay.assets();
    } catch (_err) {
      return null;
    }
    return null;
  })();
  if (store) {
    if (typeof store.whenIdle === 'function') {
      const r = await store.whenIdle({ timeoutMs: 8000 });
      return { idle: !!(r && r.idle), timedOut: !!(r && r.timedOut), pending: typeof store.pendingCount === 'function' ? store.pendingCount() : null };
    }
    if (typeof store.stats === 'function') {
      const s = store.stats() || {};
      const pending = (Number(s.pending) || 0) + (s.fonts && Number(s.fonts.pending) ? Number(s.fonts.pending) : 0);
      return { idle: pending === 0, timedOut: false, pending };
    }
  }
  return { idle: true, timedOut: false, pending: null, unsupported: true };
})()`;

/** 重畫「目前這一幀」：引擎自己在 step 內畫，但之後才載入的圖要再畫一次才不會留洋紅方塊。 */
function redrawExpression(lang) {
  return `(() => {
    const lang = ${JSON.stringify(lang)};
    const h = window.__drEncounterPlay;
    if (h) {
      try {
        if (typeof h.draw === 'function') h.draw();
        const state = typeof h.getState === 'function' ? h.getState() : null;
        const renderer = typeof h.renderer === 'function' ? h.renderer() : null;
        const scale = typeof h.scale === 'function' ? h.scale() : 2;
        const background = typeof h.background === 'function' ? h.background() : null;
        if (state && renderer && typeof renderer.draw === 'function') renderer.draw(state, { showHitboxes: false, scale, lang, background });
      } catch (_err) {
        return false;
      }
      return true;
    }
    if (window.__drPlay && typeof window.__drPlay.draw === 'function') {
      window.__drPlay.draw();
      return true;
    }
    return false;
  })()`;
}

/**
 * 等所有已請求素材載入完成或失敗。
 * 頁面若沒有曝露訊號（舊頁面）→ 回 unsupported，呼叫端用舊的「小睡 + 重畫」。
 */
async function waitAssetsIdle(cdp, warnings, label = '素材載入', { warn = true } = {}) {
  let info = null;
  try {
    info = await cdp.evaluate(ASSETS_IDLE_EXPR, { awaitPromise: true, timeoutMs: 20000 });
  } catch (err) {
    if (warn) warnings.push(`等待${label}時頁面求值失敗：${err && err.message ? err.message : err}`);
    return null;
  }
  if (info && info.timedOut && warn) {
    warnings.push(`等待${label}逾時（仍有 ${info.pending === null || info.pending === undefined ? '?' : info.pending} 個未完成）`);
  }
  return info;
}

/**
 * 截圖前把這一幀「畫到所有素材都到位」：等 idle → 重畫 → 再等（新出現的 sprite 會觸發新載入）。
 * 回傳最後一次 idle 結果；重畫不會推進幀數，所以 requested/actual 不受影響。
 */
async function settleFrame(cdp, warnings, lang, label = '素材載入') {
  const idle = await waitAssetsIdle(cdp, warnings, label, { warn: true });
  if (idle && idle.unsupported) {
    // 頁面沒有曝露素材訊號（例如 play.html）→ 沿用舊做法：小睡後重畫兩次。
    await sleep(250);
    await cdp.evaluate(redrawExpression(lang)).catch(() => {});
    await sleep(120);
    await cdp.evaluate(redrawExpression(lang)).catch(() => {});
    return idle;
  }
  if (idle && idle.idle) {
    // 已載入完仍要重畫一次（最後一次 step 之後才載入的圖）
    await cdp.evaluate(redrawExpression(lang)).catch(() => {});
    return idle;
  }
  let last = idle;
  for (let pass = 0; pass < 3; pass += 1) {
    await sleep(pass === 0 ? 60 : 40);
    await cdp.evaluate(redrawExpression(lang)).catch(() => {});
    last = await waitAssetsIdle(cdp, warnings, label, { warn: false });
    if (last && (last.idle || last.unsupported)) break;
  }
  await cdp.evaluate(redrawExpression(lang)).catch(() => {});
  return last;
}

/** 組一筆截圖結果：requested = 使用者要求的幀，actual = 真的截到的幀（結局後會 < requested）。 */
function renderShot(requested, actual, shot, state) {
  return {
    /** 要求第幾帧（向下相容：舊欄位名） */
    frame: requested,
    requested,
    /** 實際截到的幀（= 引擎 getState().frame） */
    actual,
    actualFrame: actual,
    file: shot.file,
    size: { width: shot.width, height: shot.height },
    state,
  };
}

/**
 * 截圖結果的幀摘要（REALTEST-2 V11）：一眼看出「要求了哪些幀、實際截到哪些幀、哪幾張不一致」。
 * - requestedFrames：使用者要求的幀（依截圖順序）
 * - actualFrames：每張實際截到的幀（與 requestedFrames 逐項對應）
 * - frameMismatches：[{ requested, actual }]，只列不一致的（作品已結束時 actual < requested）
 * - duplicateFrames：實際幀重複的幀號（多張其實是同一個畫面）
 */
export function summarizeFrames(shots) {
  const list = Array.isArray(shots) ? shots.filter(Boolean) : [];
  const requestedFrames = list.map((shot) => (shot.requested !== undefined ? shot.requested : shot.frame));
  const actualFrames = list.map((shot) => (shot.actualFrame !== undefined ? shot.actualFrame : shot.frame));
  const frameMismatches = [];
  for (let i = 0; i < list.length; i += 1) {
    if (requestedFrames[i] !== actualFrames[i]) frameMismatches.push({ requested: requestedFrames[i], actual: actualFrames[i] });
  }
  const seen = new Set();
  const duplicateFrames = [];
  for (const frame of actualFrames) {
    if (seen.has(frame) && !duplicateFrames.includes(frame)) duplicateFrames.push(frame);
    seen.add(frame);
  }
  return { requestedFrames, actualFrames, frameMismatches, duplicateFrames };
}

/**
 * 幀精確：要求第 `requested` 幀、實際停在 `actual` 時的中文警告（純函式，測試用）。
 *
 * - 作品已經結束（遭遇 state.result / 攻擊 state.ended）→ 明確報「已結束於第 M 幀」。
 * - 其他情況（頁面卡住、tick 被截斷）→ 報「停止前進」或「實際截到第 M 幀」。
 *
 * 完全一致（requested === actual）時回 null，呼叫端不必自己比對。
 */
export function framePrecisionWarning(kind, requested, actual, state) {
  const label = kind === 'encounter' ? '戰鬥' : '攻擊';
  if (typeof actual !== 'number' || !Number.isFinite(actual)) return null;
  if (actual === requested) return null;
  if (actual < requested) {
    const ended = kind === 'encounter' ? Boolean(state && state.result) : Boolean(state && state.ended);
    if (ended) {
      const result = kind === 'encounter' && state && state.result ? `（${state.result}）` : '';
      return `要求第 ${requested} 幀，但${label}已結束於第 ${actual} 幀${result}`;
    }
    return `${kind === 'encounter' ? '遭遇戰' : '攻擊'}在第 ${requested} 幀前停止前進（實際 ${actual}）`;
  }
  return `要求第 ${requested} 幀，實際截到第 ${actual} 幀`;
}


async function preparePage(cdp) {
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable').catch(() => {});
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1500,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  }).catch(() => {});
}

async function navigate(cdp, url) {
  const loaded = cdp.waitForEvent('Page.loadEventFired', 30000).catch(() => null);
  await cdp.send('Page.navigate', { url });
  await loaded;
}

/**
 * 把任意 JSON 檔轉成「伺服器能提供的相對路徑」。
 *
 * 注意：serve.py 的靜態檔案一律從**程式根**（app.root）提供，作品根只影響
 * /api/* 與 /assets/custom/ —— 所以頁面要靠 ?encounter=<相對程式根路徑> 載入時，
 * 檔案必須落在程式根之內；不在裡面就複製到 tools/agent/.tmp（AG 自己的範圍）。
 */
const serverRoot = () => BATTLE_EDITOR;
const relToServer = (target) => toPosix(relative(serverRoot(), resolve(target)));

function ensureServable(file, tmpDir) {
  const rel = relToServer(file);
  if (!rel.startsWith('..')) return { rel, cleanup: null };
  // 不在伺服器根之下 → 複製到 tools/agent/.tmp（AG 自己的範圍）
  mkdirSync(tmpDir, { recursive: true });
  const name = `render-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;
  const target = join(tmpDir, name);
  writeFileSync(target, readFileSync(file));
  return { rel: relToServer(target), cleanup: target };
}

/**
 * 把「記憶體裡的 JSON」寫成可被伺服器取用的暫存檔。
 * MCP 的 dr_render 常常收到 doc 物件（還沒存檔的草稿），但頁面只能吃 URL → 一定要落成檔案。
 */
function materializeJson(json, tmpDir) {
  mkdirSync(tmpDir, { recursive: true });
  const name = `render-doc-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`;
  const target = join(tmpDir, name);
  writeFileSync(target, `${JSON.stringify(json, null, 2)}\n`);
  return { rel: relToServer(target), cleanup: target };
}

function canvasClipScript() {
  return `(() => {
    const c = document.querySelector('canvas');
    if (!c) return null;
    const r = c.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), iw: c.width, ih: c.height };
  })()`;
}

async function captureCanvas(cdp, outPath) {
  const clip = await cdp.evaluate(canvasClipScript());
  if (!clip) throw new Error('找不到 canvas（頁面沒有載入成功？）');
  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: clip.x, y: clip.y, width: clip.width, height: clip.height, scale: 1 },
  });
  writeFileSync(outPath, Buffer.from(result.data, 'base64'));
  return { file: outPath, width: clip.width, height: clip.height, canvas: { width: clip.iw, height: clip.ih } };
}

/* -------------------------------------------------------------- 主流程 */

export function parseFrameList(value) {
  if (value === undefined || value === null || value === true) return [0, 30, 60, 90];
  const text = String(value);
  const frames = [];
  for (const part of text.split(',')) {
    const piece = part.trim();
    if (!piece) continue;
    if (piece.includes('-')) {
      const [a, b] = piece.split('-').map((n) => Math.round(Number(n)));
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) {
        for (let f = a; f <= b; f += 30) frames.push(f);
      }
    } else {
      const n = Math.round(Number(piece));
      if (Number.isFinite(n)) frames.push(n);
    }
  }
  const unique = [...new Set(frames)].sort((a, b) => a - b);
  return unique.length > 0 ? unique : [0];
}

/** 組頁面 URL（純函式；renderFrames 與測試共用，B20）。 */
export function buildPageUrl({
  root,
  kind,
  targetRel,
  scale = 2,
  lang = 'zh',
  preFrames = 0,
  autoplay = null,
  hitboxes = false,
  phase = null,
  bgm = null,
  chrome = true,
}) {
  const basePath = kind === 'encounter' ? 'encounter-play.html' : 'play.html';
  const paramName = kind === 'encounter' ? 'encounter' : 'attack';
  const params = new URLSearchParams();
  params.set(paramName, targetRel);
  params.set('scale', String(scale));
  params.set('lang', lang);
  params.set('frames', String(preFrames));
  // 攻擊頁：讓頁面的 tickSim 真的推引擎（否則引擎自己持有 rAF 迴圈，tick 不會動）
  if (kind !== 'encounter') params.set('owner', 'page');
  // SPEC-AUTOPLAY §4：?autoplay=demo|bot 開頁即啟用。兩頁都支援：
  // 攻擊頁由 __drPlay.tick、遭遇頁由 __drEncounterPlay.tick 逐幀餵 pilot 輸入。
  if (autoplay) params.set('autoplay', autoplay);
  if (hitboxes) params.set('hit', '1');
  if (kind === 'encounter' && phase) params.set('phase', String(phase));
  if (bgm) params.set('bgm', String(bgm));
  // ?chrome=0：隱藏頁面 HUD／提示列，只留畫布（V2-11 錄影預設）
  if (chrome === false) params.set('chrome', '0');
  return `${root}/${basePath}?${params.toString()}`;
}

/** 截圖主函式。 */
export async function renderFrames(target, options = {}) {
  const warnings = [];
  let file = null;
  let json = null;
  if (typeof target === 'string') {
    file = resolveInputFile(target);
    if (!file) throw new Error(`找不到檔案：${target}`);
    json = readJSON(file);
  } else {
    json = target;
  }
  const kind = detectKind(json);
  const frames = (options.frames && options.frames.length ? options.frames : [0, 30, 60, 90])
    .map((n) => Math.max(0, Math.round(numArg(n, 0))))
    .sort((a, b) => a - b);
  const scale = Math.max(1, Math.min(6, Math.round(numArg(options.scale, 2))));
  const lang = options.lang === 'en' ? 'en' : 'zh';
  const name = (json && json.meta && (typeof json.meta.name === 'string' ? json.meta.name : json.meta.name && json.meta.name.zh)) || 'render';
  const safeName = String(name).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'render';
  const outDir = options.out || join(tmpdir(), 'dr-agent-render', `${safeName}-${Date.now()}`);
  mkdirSync(outDir, { recursive: true });

  const tmpDir = join(BATTLE_EDITOR, 'tools', 'agent', '.tmp');
  // 檔案 → 直接服務（在 battle-editor 外就先複製）；記憶體 JSON → 落成暫存檔才能被頁面載入
  const servable = file ? ensureServable(file, tmpDir) : materializeJson(json, tmpDir);

  const autoplay = options.autoplay === 'demo' || options.autoplay === 'bot' ? options.autoplay : null;
  // --works（或 DR_WORKS）：作品根不是程式根時要把工作根傳給 serve.py。
  // CLI 會自己給，但 MCP 的 dr_render 只給 frames/scale…，所以這裡補預設值。
  const works = options.works === undefined ? (WORKS_DIR !== BATTLE_EDITOR ? WORKS_DIR : null) : options.works;
  let server = options.server || null;
  let edge = null;
  const results = [];
  let autoplayInfo = null;
  try {
    if (!server) server = await startServer({ ...options, works });
    edge = await launchEdge({ ...options, exe: options.edgePath });
    await preparePage(edge.cdp);

    // 凍結 rAF：兩種頁面都只靠 tick() 精準推進（決定性），不讓真實時間影響幀數。
    // 遭遇頁的引擎與頁面迴圈都吃 requestAnimationFrame，凍結後 __drEncounterPlay.tick(n)
    // 就是唯一的步進來源 → 「要求第 N 幀」就一定是第 N 幀。
    await edge.cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: FREEZE_RAF }).catch(() => {});

    const root = server.url;
    const targetRel = servable ? servable.rel : '';
    const buildUrl = (preFrames) =>
      buildPageUrl({
        root,
        kind,
        targetRel,
        scale,
        lang,
        preFrames,
        autoplay,
        hitboxes: options.hitboxes,
        phase: options.phase,
        bgm: options.bgm,
      });

    const readyExpression =
      kind === 'encounter'
        ? '!!(window.__drEncounterPlay && typeof window.__drEncounterPlay.getState === "function")'
        : '!!(window.__drPlay && typeof window.__drPlay.getState === "function")';

    /** 遭遇頁載入失敗（encounter-play.html 停在錯誤畫面）→ 直接丟錯，不要截一張黑畫面。 */
    const assertEncounterLoaded = async () => {
      const failure = await edge.cdp.evaluate(
        '(() => { const p = window.__drEncounterPlay; const e = p && typeof p.loadError === "function" ? p.loadError() : null; return e ? JSON.stringify(e) : null; })()',
      );
      if (failure) throw new Error(`遭遇頁載入失敗：${failure}`);
    };

    if (kind === 'encounter' && autoplay) {
      /* ---------------- 遭遇（自動演示）：tick 精準推進 ---------------- */
      // encounter-play.html 支援 ?autoplay=demo|bot；__drEncounterPlay.tick(n) 在自動演示時
      // 逐幀餵 pilot.input（advancedEncounterFrame），與攻擊頁的 __drPlay.tick 一樣是決定性的。
      await navigate(edge.cdp, buildUrl(0));
      await waitFor(() => edge.cdp.evaluate(readyExpression), { timeoutMs: 45000, intervalMs: 150, label: '頁面就緒' });
      await assertEncounterLoaded();
      await waitFor(
        () =>
          edge.cdp.evaluate(
            '!!(window.__drEncounterPlay.autoplay && typeof window.__drEncounterPlay.autoplay.describe === "function" && window.__drEncounterPlay.autoplay.get() !== "off")',
          ),
        { timeoutMs: 30000, intervalMs: 120, label: '遭遇自動演示就緒' },
      );
      const mode = await edge.cdp.evaluate('window.__drEncounterPlay.autoplay.get()');
      const describe = await edge.cdp.evaluate('window.__drEncounterPlay.autoplay.describe()');
      const warnText = String((await edge.cdp.evaluate('window.__drEncounterPlay.autoplay.warnings()')) || '');
      autoplayInfo = {
        mode: mode || autoplay,
        describe: describe || null,
        warnings: warnText
          ? warnText
              .split(/[；;]\s*/)
              .map((text) => text.trim())
              .filter(Boolean)
          : [],
      };
      if (warnText) warnings.push(`自動演示警告：${warnText}`);

      // 自動演示時頁面自己暫停引擎（pageOwnsSteps → syncEngineRunning），用 tick 推進即可。
      // 精靈仍是 lazy 載入 → 每幀 tick 後等 assets.whenIdle() 再重畫（避免洋紅佔位）。
      let currentFrame = 0;
      const byFrame = new Map();
      const readEncounterState = () =>
        edge.cdp.evaluate(
          `(() => { const s = window.__drEncounterPlay.getState(); if (!s) return null; return { frame: s.frame, phase: s.phase, turn: s.turn, battle: !!s.battle, bullets: s.battle ? (s.battle.bullets || []).length : 0, result: s.result }; })()`,
        );
      for (const targetFrame of frames) {
        const delta = Math.max(0, targetFrame - currentFrame);
        if (delta > 0) {
          // 長遭遇（例如 2.8 萬幀）一次 tick 會超過 CDP 逾時 → 分段推進。
          for (let left = delta; left > 0; left -= 2000) {
            await edge.cdp.evaluate(`window.__drEncounterPlay.tick(${Math.min(2000, left)})`, { timeoutMs: 120000 });
          }
          const after = await readEncounterState();
          currentFrame = after && typeof after.frame === 'number' ? after.frame : targetFrame;
        }
        const idle = await settleFrame(edge.cdp, warnings, lang, '遭遇素材載入');
        const outPath = join(outDir, `${safeName}-f${String(targetFrame).padStart(4, '0')}.png`);
        const shot = await captureCanvas(edge.cdp, outPath);
        const state = await readEncounterState();
        const actual = state && typeof state.frame === 'number' ? state.frame : currentFrame;
        // 戰鬥已結束（victory / spared / defeat / flee）時，頁面停在結算幀是正確行為：
        // 明確回報「已結束於第 M 幀」，而不是籠統的「停止前進」。
        const precision = framePrecisionWarning('encounter', targetFrame, actual, state);
        if (precision) warnings.push(precision);
        if (idle && idle.timedOut) warnings.push(`第 ${targetFrame} 幀截圖前素材仍未全部載入（畫面可能含洋紅佔位）`);
        byFrame.set(targetFrame, renderShot(targetFrame, actual, shot, state));
      }
      for (const targetFrame of frames) results.push(byFrame.get(targetFrame));
    } else if (kind !== 'encounter') {
      /* ---------------- 攻擊：一次載入，逐幀 tick ---------------- */
      await navigate(edge.cdp, buildUrl(0));
      await waitFor(() => edge.cdp.evaluate(readyExpression), { timeoutMs: 40000, intervalMs: 120, label: '頁面就緒' });
      const banner = await edge.cdp.evaluate(
        `(() => { const el = document.getElementById('banner'); return el && !el.hidden ? el.textContent.slice(0, 300) : null; })()`,
      );
      if (banner) warnings.push(`頁面提示：${banner}`);

      if (autoplay) {
        try {
          await waitFor(
            () => edge.cdp.evaluate('!!(window.__drPlay.autoplay && typeof window.__drPlay.autoplay.describe === "function")'),
            { timeoutMs: 10000, intervalMs: 100, label: '自動演示就緒' },
          );
          const mode = await edge.cdp.evaluate('window.__drPlay.autoplay.get()');
          const describe = await edge.cdp.evaluate('window.__drPlay.autoplay.describe()');
          const warnText = String((await edge.cdp.evaluate('window.__drPlay.autoplay.warnings()')) || '');
          autoplayInfo = {
            mode: mode || autoplay,
            describe: describe || null,
            warnings: warnText
              ? warnText
                  .split(/[；;]\s*/)
                  .map((text) => text.trim())
                  .filter(Boolean)
              : [],
          };
          if (warnText) warnings.push(`自動演示警告：${warnText}`);
        } catch (err) {
          warnings.push(`自動演示初始化失敗：${err && err.message ? err.message : err}`);
        }
      }

      let currentFrame = 0;
      const byFrame = new Map();
      for (const targetFrame of frames) {
        const delta = Math.max(0, targetFrame - currentFrame);
        if (delta > 0) {
          await edge.cdp.evaluate(`window.__drPlay.tick(${delta})`, { timeoutMs: 120000 });
          const after = await edge.cdp.evaluate('(() => { const s = window.__drPlay.getState(); return s && typeof s.frame === "number" ? s.frame : null; })()');
          currentFrame = typeof after === 'number' ? after : targetFrame;
        }
        // sprite 圖片是第一次繪製時才懶載入 → 等素材全部到位再重畫一次，避免洋紅佔位
        const idle = await settleFrame(edge.cdp, warnings, lang, '攻擊素材載入');
        const outPath = join(outDir, `${safeName}-f${String(targetFrame).padStart(4, '0')}.png`);
        const shot = await captureCanvas(edge.cdp, outPath);
        const state = await edge.cdp.evaluate(
          `(() => { const s = window.__drPlay.getState(); if (!s) return null; return { frame: s.frame, ended: !!s.ended, bullets: (s.bullets || []).length, tp: Math.round((s.tp || 0) * 100) / 100, party: (s.party || []).map((p) => ({ name: p.name, hp: p.hp, maxHp: p.maxHp })) }; })()`,
        );
        const actual = state && typeof state.frame === 'number' ? state.frame : currentFrame;
        // 攻擊結束後 tick 會停在結束幀：明確回報「已結束於第 M 幀」。
        const precision = framePrecisionWarning('attack', targetFrame, actual, state);
        if (precision) warnings.push(precision);
        if (idle && idle.timedOut) warnings.push(`第 ${targetFrame} 幀截圖前素材仍未全部載入（畫面可能含洋紅佔位）`);
        byFrame.set(targetFrame, renderShot(targetFrame, actual, shot, state));
      }
      for (const targetFrame of frames) results.push(byFrame.get(targetFrame));
    } else {
      /* ---------------- 遭遇（無自動演示）：固定步進，不靠真實時間 ---------------- */
      // 舊做法是「真實時間輪詢 + 送 Z 鍵」→ 幀數會飄。現在 rAF 已在載入前被凍結，
      // __drEncounterPlay.tick(n) 在非自動演示模式下就是逐幀 enc.step(1)（決定性），
      // 所以「要求第 N 幀」一定停在第 N 幀；戰鬥先結束時則停在結束幀並回報實際幀。
      await navigate(edge.cdp, buildUrl(0));
      await waitFor(() => edge.cdp.evaluate(readyExpression), { timeoutMs: 45000, intervalMs: 150, label: '頁面就緒' });
      await assertEncounterLoaded();
      // 等引擎載入完成（getState 有值且 frame 可讀）
      await waitFor(
        () =>
          edge.cdp.evaluate(
            `(() => {
               const h = window.__drEncounterPlay;
               if (!h) return false;
               const s = typeof h.getState === 'function' ? h.getState() : null;
               return !!s && typeof s.frame === 'number';
             })()`,
          ),
        { timeoutMs: 30000, intervalMs: 120, label: '遭遇引擎就緒' },
      );

      const readState = () =>
        edge.cdp.evaluate(
          `(() => { const s = window.__drEncounterPlay.getState(); if (!s) return null; return { frame: s.frame, phase: s.phase, turn: s.turn, battle: !!s.battle, bullets: s.battle ? (s.battle.bullets || []).length : 0, result: s.result }; })()`,
        );

      let currentFrame = 0;
      for (const targetFrame of frames) {
        const delta = Math.max(0, targetFrame - currentFrame);
        if (delta > 0) {
          await edge.cdp.evaluate(`window.__drEncounterPlay.tick(${delta})`, { timeoutMs: 120000 });
          const after = await readState();
          currentFrame = after && typeof after.frame === 'number' ? after.frame : targetFrame;
        }
        await settleFrame(edge.cdp, warnings, lang, '遭遇素材載入');
        const state = await readState();
        const actual = state && typeof state.frame === 'number' ? state.frame : currentFrame;
        // 戰鬥結束後頁面停在結算幀（正確行為）：明確回報「已結束於第 M 幀」。
        const precision = framePrecisionWarning('encounter', targetFrame, actual, state);
        if (precision) warnings.push(precision);
        const outPath = join(outDir, `${safeName}-f${String(targetFrame).padStart(4, '0')}.png`);
        const shot = await captureCanvas(edge.cdp, outPath);
        results.push(renderShot(targetFrame, actual, shot, state));
      }
    }

    /* ------------------------------ 聯絡表 ------------------------------ */
    let sheet = null;
    if (options.sheet && results.length > 0) {
      sheet = await buildSheet(edge.cdp, results, join(outDir, `${safeName}-sheet.png`), {
        title: `${safeName}（${kind === 'encounter' ? '遭遇' : '攻擊'}）`,
        cols: Math.min(4, results.length),
      });
      if (!sheet) warnings.push('聯絡表建立失敗（已保留個別截圖）');
    }

    return {
      kind,
      file,
      frames: results,
      // 幀摘要：requestedFrames / actualFrames / frameMismatches / duplicateFrames
      ...summarizeFrames(results),
      sheet: sheet ? sheet.file : null,
      sheetSize: sheet ? sheet.size : null,
      outDir,
      autoplay: autoplayInfo,
      server: { url: server.url, started: Boolean(server.started) },
      edge: edge ? { browser: edge.browser, exe: edge.exe } : null,
      warnings,
    };
  } finally {
    if (edge) await edge.close();
    if (server && !options.server && server.close) await server.close();
    if (servable && servable.cleanup) {
      try {
        rmSync(servable.cleanup, { force: true });
      } catch (_err) {
        /* 忽略 */
      }
    }
  }
}

/* ------------------------------------------------------------ 聯絡表 */

/** 在空白頁用 canvas 把多張截圖拼成一張（不引入任何影像函式庫）。 */
async function buildSheet(cdp, shots, outPath, options = {}) {
  const images = [];
  const labels = [];
  for (const shot of shots) {
    try {
      const data = readFileSync(shot.file).toString('base64');
      images.push(`data:image/png;base64,${data}`);
      const state = shot.state || {};
      const bits = [`f=${shot.actualFrame !== undefined ? shot.actualFrame : shot.frame}`];
      if (state.phase) bits.push(String(state.phase));
      if (state.bullets !== undefined) bits.push(`${state.bullets} 彈`);
      if (state.tp !== undefined) bits.push(`TP ${state.tp}`);
      labels.push(bits.join('  '));
    } catch (_err) {
      /* 跳過壞檔 */
    }
  }
  if (images.length === 0) return null;

  const page = await cdp.send('Target.getTargets').catch(() => null);
  void page;
  await navigate(cdp, 'about:blank');
  const size = await cdp.evaluate(
    `(async () => {
      const images = ${JSON.stringify(images)};
      const labels = ${JSON.stringify(labels)};
      const cols = ${Math.max(1, Math.min(6, Math.round(options.cols || 4)))};
      const gap = 10;
      const labelH = 22;
      const titleH = ${options.title ? 30 : 0};
      const loaded = await Promise.all(images.map((src) => new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('圖片載入失敗'));
        img.src = src;
      })));
      const w = loaded[0].naturalWidth;
      const h = loaded[0].naturalHeight;
      const rows = Math.ceil(loaded.length / cols);
      const canvasW = cols * w + (cols + 1) * gap;
      const canvasH = titleH + rows * (h + labelH + gap) + gap;
      const canvas = document.createElement('canvas');
      canvas.width = canvasW;
      canvas.height = canvasH;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#101014';
      ctx.fillRect(0, 0, canvasW, canvasH);
      ctx.font = 'bold 18px monospace';
      ctx.fillStyle = '#e8e8f0';
      ${options.title ? `ctx.fillText(${JSON.stringify(String(options.title).slice(0, 120))}, gap, 22);` : ''}
      loaded.forEach((img, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        const x = gap + col * (w + gap);
        const y = titleH + gap + row * (h + labelH + gap);
        ctx.font = '14px monospace';
        ctx.fillStyle = '#9fd8ff';
        ctx.fillText(labels[index] || '', x, y + 16);
        ctx.drawImage(img, x, y + labelH);
        ctx.strokeStyle = '#2a2a38';
        ctx.strokeRect(x + 0.5, y + labelH + 0.5, w - 1, h - 1);
      });
      document.body.style.margin = '0';
      document.body.style.background = '#101014';
      document.body.innerHTML = '';
      document.body.appendChild(canvas);
      return { width: canvasW, height: canvasH };
    })()`,
    { awaitPromise: true, timeoutMs: 60000 },
  );

  const result = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 },
  });
  writeFileSync(outPath, Buffer.from(result.data, 'base64'));
  return { file: outPath, size };
}

/* --------------------------------------------------------------- CLI */

async function main() {
  try {
    applyCliPaths(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  const args = parseArgs(process.argv.slice(2), [
    'frames',
    'out',
    'scale',
    'lang',
    'phase',
    'bgm',
    'port',
    'autoplay',
    'root',
    'works',
  ], { booleanFlags: ['keep', 'sheet', 'hitboxes'] });
  const input = args._[0];
  if (!input) {
    console.error(
      '用法：node tools/agent/render.mjs <攻擊檔|遭遇檔> [--frames 0,30,90] [--autoplay demo|bot] [--lang zh|en] [--scale 2] [--out DIR] [--root DIR] [--works DIR] [--sheet] [--hitboxes] [--json]',
    );
    process.exitCode = 2;
    return;
  }
  const options = {
    frames: parseFrameList(args.frames),
    out: typeof args.out === 'string' ? args.out : null,
    scale: numArg(args.scale, 2),
    lang: args.lang === 'en' ? 'en' : 'zh',
    sheet: Boolean(args.sheet),
    hitboxes: Boolean(args.hitboxes),
    phase: typeof args.phase === 'string' ? args.phase : null,
    bgm: typeof args.bgm === 'string' ? args.bgm : null,
    autoplay: args.autoplay === 'demo' || args.autoplay === 'bot' ? args.autoplay : null,
    port: args.port !== undefined ? Math.round(numArg(args.port, 0)) : 0,
    keep: Boolean(args.keep),
    /** 作品根與程式根不同時傳給 serve.py（作品根的 attacks/encounters/assets/custom/）。 */
    works: WORKS_DIR !== BATTLE_EDITOR ? WORKS_DIR : null,
  };

  const result = await renderFrames(input, options);
  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`截圖：${input}（${result.kind === 'encounter' ? '遭遇' : '攻擊'}）`);
  console.log(`輸出：${result.outDir}`);
  if (result.autoplay) {
    const live = result.autoplay.describe || {};
    console.log(
      `自動演示：${result.autoplay.mode}${live.dodge ? `（${live.dodge}）` : ''}` +
        (result.autoplay.warnings.length ? `　警告 ${result.autoplay.warnings.length} 筆` : ''),
    );
  }
  for (const shot of result.frames) {
    const state = shot.state || {};
    const extra = [state.phase ? `phase=${state.phase}` : '', state.bullets !== undefined ? `彈=${state.bullets}` : '', state.tp !== undefined ? `TP=${state.tp}` : '']
      .filter(Boolean)
      .join(' ');
    // 幀精確：要求幀與實際幀都印；不一致時用 → 標出來。
    const requested = shot.requested !== undefined ? shot.requested : shot.frame;
    const actual = shot.actualFrame !== undefined ? shot.actualFrame : shot.frame;
    const frameLabel = requested === actual ? `f=${String(requested).padStart(4)}` : `f=${requested}→${actual}`;
    console.log(`  ${frameLabel}  ${shot.file.split(/[\\/]/).pop()}  ${shot.size.width}×${shot.size.height}  ${extra}`);
  }
  if (result.sheet) console.log(`聯絡表：${result.sheet}（${result.sheetSize.width}×${result.sheetSize.height}）`);
  if (result.warnings.length > 0) {
    console.log('');
    console.log('警告：');
    for (const warning of result.warnings) console.log(`  - ${warning}`);
  }
}

if (cliEntry(import.meta.url)) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}

export default renderFrames;
