/**
 * tools/web/record-e2e-lib.mjs — record-e2e.mjs 的最小 CDP 依賴
 *
 * 為什麼不直接 import tools/agent/render.mjs：
 *   那支會 import ./lib.mjs 與 ./sim.mjs（多載入一整包 agent 工具），而且它的
 *   launchEdge() 沒有 --autoplay-policy、也不會設定下載行為。錄影驗證需要
 *   「下載導向 + 真 rAF（不能凍結）」的專用啟動參數，所以在 tools/web 內自帶一份，
 *   只保留 CDP / findEdge / waitFor 三個小工具（零外部依賴）。
 */

import { existsSync } from 'node:fs';

/** 等一個條件成立（回傳值為真）；逾時丟錯。 */
export async function waitFor(check, { timeoutMs = 20000, intervalMs = 100, label = '條件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`${label}逾時（${timeoutMs}ms）${lastError ? `：${lastError.message}` : ''}`);
}

const EDGE_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge Beta/Application/msedge.exe',
];

/** 找 msedge.exe（可用 MSEDGE_PATH / EDGE_PATH 覆寫）。 */
export function findEdge() {
  const fromEnv = process.env.MSEDGE_PATH || process.env.EDGE_PATH;
  const candidates = fromEnv ? [fromEnv, ...EDGE_CANDIDATES] : EDGE_CANDIDATES;
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

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
      if (message.error) entry.reject(new Error(`CDP ${message.error.message || '錯誤'}`));
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

  /** 在頁面求值（returnByValue，預設回 JSON 值）。 */
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
      (options.timeoutMs || 30000) + 5000,
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
