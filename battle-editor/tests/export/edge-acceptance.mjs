#!/usr/bin/env node
/**
 * tests/export/edge-acceptance.mjs — V2-09 可遊玩輸出的 headless Edge 驗收（手動 e2e，不屬於 run.mjs）。
 *
 * 用法：
 *   node tests/export/edge-acceptance.mjs --html <輸出的 .html> --out-dir <截圖/report 目錄> \
 *        [--label rudinn] [--expect-result spared] [--timeout 300000]
 *
 * 流程（file:// 開啟，headless Edge）：
 *   1. 等 window.__drExport.ready
 *   2. 截標題畫面 → 按 Z（呼叫 __drExport.start()）
 *   3. 切到自動演示（__drExport.setAutoplay('demo')）→ 等 frame > 30 截戰鬥中
 *   4. 等 phase === 'ended' → 記結果／幀數 → 截結束畫面
 *   5. 檢查：console error／page exception／Log error 皆 0；Network 只允許 data:/blob:（以及本身的 file:// 文件）
 *
 * 產物：<out-dir>/<label>-title.png、-battle.png、-end.png、<label>-report.json
 * 離開碼：0 = 全部通過；1 = 有失敗項目；2 = 啟動／通訊失敗。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = resolve(fileURLToPath(import.meta.url), '..');
const DEFAULT_EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const EDGE = process.env.MSEDGE || DEFAULT_EDGE;

const ALLOWED_SCHEMES = new Set(['data:', 'blob:', 'about:', 'devtools:', 'chrome-extension:', 'chrome-untrusted:']);

function parseArgs(argv) {
  const out = { label: 'export', timeout: 300000, expectResult: null, html: null, outDir: null, keepProfile: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--html') out.html = argv[++i];
    else if (arg === '--out-dir') out.outDir = argv[++i];
    else if (arg === '--label') out.label = argv[++i];
    else if (arg === '--timeout') out.timeout = Number(argv[++i]) || 300000;
    else if (arg === '--expect-result') out.expectResult = argv[++i];
    else if (arg === '--keep-profile') out.keepProfile = true;
    else throw new Error('未知參數：' + arg);
  }
  if (!out.html || !out.outDir) throw new Error('需要 --html 與 --out-dir');
  return out;
}

function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function waitFor(fn, { timeout = 15000, interval = 100, label = 'condition' } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastError = err;
    }
    await sleep(interval);
  }
  throw new Error('等待逾時：' + label + (lastError ? '（' + lastError.message + '）' : ''));
}

/* ------------------------------------------------------------------ CDP */

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Map();
    ws.addEventListener('message', (event) => {
      let message = null;
      try {
        message = JSON.parse(event.data);
      } catch (_err) {
        return;
      }
      if (message.id && this.pending.has(message.id)) {
        const { resolve: resolvePending, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message + '（' + message.error.code + '）'));
        else resolvePending(message.result);
        return;
      }
      if (message.method) {
        const list = this.handlers.get(message.method) || [];
        for (const handler of list) {
          try {
            handler(message.params, message.sessionId);
          } catch (_err) {
            /* 忽略事件處理錯誤 */
          }
        }
      }
    });
  }

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolveOpen, rejectOpen) => {
      ws.addEventListener('open', () => resolveOpen());
      ws.addEventListener('error', (event) => rejectOpen(new Error('WebSocket 連線失敗：' + (event && event.message ? event.message : ''))));
    });
    return new Cdp(ws);
  }

  on(method, handler) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(handler);
  }

  send(method, params = {}, sessionId = undefined) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolveSend, rejectSend) => {
      this.pending.set(id, { resolve: resolveSend, reject: rejectSend });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        rejectSend(err);
      }
    });
  }

  close() {
    try {
      this.ws.close();
    } catch (_err) {
      /* 忽略 */
    }
  }
}

function readDevToolsPort(profileDir, timeoutMs = 20000) {
  const portFile = join(profileDir, 'DevToolsActivePort');
  return waitFor(
    () => {
      if (!existsSync(portFile)) return null;
      const text = readFileSync(portFile, 'utf8').trim();
      const lines = text.split(/\r?\n/);
      if (lines.length < 2 || !lines[0]) return null;
      return { port: Number(lines[0]), path: lines[1] };
    },
    { timeout: timeoutMs, interval: 100, label: 'DevToolsActivePort' },
  );
}

function killTree(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch (_err) {
    /* 忽略 */
  }
}

/* -------------------------------------------------------------- 驗收主體 */

async function runAcceptance(options) {
  const htmlPath = resolve(options.html);
  if (!existsSync(htmlPath)) throw new Error('找不到 HTML：' + htmlPath);
  mkdirSync(resolve(options.outDir), { recursive: true });
  const outDir = resolve(options.outDir);
  const fileUrl = pathToFileURL(htmlPath).href;
  const profileDir = join(process.env.TEMP || process.env.TMP || outDir, 'V2-09', 'edge-profile-' + options.label + '-' + Date.now());
  mkdirSync(profileDir, { recursive: true });

  const args = [
    '--headless=new',
    '--mute-audio',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--autoplay-policy=no-user-gesture-required',
    '--remote-allow-origins=*',
    '--remote-debugging-port=0',
    '--user-data-dir=' + profileDir,
    fileUrl,
  ];
  const child = spawn(EDGE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderrText = '';
  child.stderr.on('data', (chunk) => {
    stderrText += String(chunk);
    if (stderrText.length > 40000) stderrText = stderrText.slice(-20000);
  });

  const report = {
    label: options.label,
    html: htmlPath,
    fileUrl,
    startedAt: new Date().toISOString(),
    consoleErrors: [],
    pageExceptions: [],
    logErrors: [],
    consoleWarnings: [],
    networkRequests: [],
    unexpectedNetwork: [],
    steps: {},
    screenshots: [],
    result: null,
    frame: 0,
    phase: null,
    pass: false,
    failures: [],
  };

  let cdp = null;
  try {
    const { port, path } = await readDevToolsPort(profileDir);
    cdp = await Cdp.connect('ws://127.0.0.1:' + port + path);

    let targetId = null;
    await waitFor(async () => {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const page = targetInfos.find((info) => info.type === 'page');
      if (!page) return null;
      targetId = page.targetId;
      return true;
    }, { timeout: 20000, label: 'page target' });

    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const send = (method, params) => cdp.send(method, params, sessionId);

    cdp.on('Runtime.consoleAPICalled', (params) => {
      const text = (params.args || [])
        .map((arg) => {
          if (arg.value !== undefined) return String(arg.value);
          if (arg.description !== undefined) return String(arg.description);
          return arg.type || '?';
        })
        .join(' ');
      if (params.type === 'error' || params.type === 'assert') report.consoleErrors.push(text);
      else if (params.type === 'warning') report.consoleWarnings.push(text);
    });
    cdp.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails || {};
      const text = details.exception && details.exception.description
        ? details.exception.description
        : details.text || 'unknown exception';
      report.pageExceptions.push(String(text));
    });
    cdp.on('Log.entryAdded', (params) => {
      const entry = params.entry || {};
      if (entry.level === 'error') report.logErrors.push(String(entry.text || entry.source || 'log error'));
    });
    cdp.on('Network.requestWillBeSent', (params) => {
      const url = params.request && params.request.url ? params.request.url : '';
      report.networkRequests.push(url);
    });

    await send('Page.enable');
    await send('Runtime.enable');
    await send('Log.enable');
    await send('Network.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });

    const evaluate = async (expression, { awaitPromise = false } = {}) => {
      const response = await send('Runtime.evaluate', {
        expression,
        awaitPromise,
        returnByValue: true,
        userGesture: true,
      });
      if (response.exceptionDetails) {
        const details = response.exceptionDetails;
        const text = details.exception && details.exception.description ? details.exception.description : details.text;
        throw new Error('evaluate 失敗：' + text);
      }
      return response.result ? response.result.value : undefined;
    };

    const getInfo = async () => {
      const text = await evaluate('JSON.stringify(window.__drExport.getInfo())');
      return JSON.parse(text);
    };

    const waitInfo = (predicate, { timeout = 30000, label = 'state' } = {}) =>
      waitFor(async () => {
        const info = await getInfo();
        return predicate(info) ? info : null;
      }, { timeout, interval: 120, label });

    const screenshot = async (name) => {
      const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
      const target = join(outDir, options.label + '-' + name + '.png');
      writeFileSync(target, Buffer.from(data, 'base64'));
      report.screenshots.push(target);
      return target;
    };

    await waitFor(async () => {
      const ready = await evaluate('Boolean(window.__drExport && window.__drExport.ready)');
      return ready === true;
    }, { timeout: 60000, label: 'game ready' });

    const initial = await getInfo();
    report.steps.title = initial;
    if (initial.phase !== 'title') report.failures.push('初始 Phase 不是 title：' + initial.phase);
    await screenshot('title');

    const started = await evaluate('window.__drExport.start()', { awaitPromise: true });
    report.steps.started = started;
    if (started !== true) report.failures.push('start() 沒有回傳 true');
    await waitInfo((info) => info.phase === 'playing' && info.frame > 5, { timeout: 30000, label: 'playing' });

    const autoMode = await evaluate("window.__drExport.setAutoplay('demo')", { awaitPromise: true });
    report.steps.autoplay = autoMode;
    if (autoMode !== 'demo') report.failures.push('setAutoplay(demo) 沒有生效：' + String(autoMode));

    const battleInfo = await waitInfo((info) => info.phase === 'playing' && info.frame > 45, {
      timeout: 60000,
      label: 'demo running',
    });
    report.steps.battle = battleInfo;
    await screenshot('battle');

    const finalInfo = await waitInfo((info) => info.phase === 'ended', {
      timeout: options.timeout,
      interval: 250,
      label: 'demo 跑到結束',
    });
    report.steps.end = finalInfo;
    report.result = finalInfo.result;
    report.frame = finalInfo.frame;
    report.phase = finalInfo.phase;
    await screenshot('end');

    if (options.expectResult && finalInfo.result !== options.expectResult) {
      report.failures.push('結果不符：預期 ' + options.expectResult + '，實際 ' + finalInfo.result);
    }
    if (!(finalInfo.frame > 60)) report.failures.push('結束時幀數太低：' + finalInfo.frame);
    if (finalInfo.result === 'spared' || finalInfo.result === 'victory') {
      const ending = await evaluate(`({
        overlayHidden: document.getElementById('end-screen').hidden,
        narration: window.__drExport.getState().textbox?.lines[0]?.text,
        hint: document.getElementById('hint').textContent,
      })`);
      report.steps.winNarration = ending;
      if (!ending.overlayHidden) report.failures.push('勝利時仍顯示結果覆蓋畫面');
      if (!['* 你赢了！', '* YOU WON!'].includes(ending.narration)) report.failures.push('勝利旁白缺失');
      if (!ending.hint.includes('Z / Enter')) report.failures.push('缺少重播提示');
      await evaluate("window.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyZ', key: 'z', cancelable: true }))");
      const replay = await waitInfo((info) => info.phase === 'playing' && info.result === null && info.frame > 5, {
        timeout: 15000, label: '按 Z 重來',
      });
      report.steps.replay = replay;
    }
  } catch (err) {
    report.failures.push('驗收流程失敗：' + (err && err.message ? err.message : String(err)));
    if (stderrText) report.edgeStderr = stderrText.slice(-4000);
  } finally {
    if (cdp) cdp.close();
    killTree(child.pid);
    await sleep(300);
    writeFileSync(join(outDir, options.label + '-edge-stderr.log'), stderrText.slice(-20000), 'utf8');
  }

  // 事後判定
  const mainFileUrl = fileUrl;
  for (const url of report.networkRequests) {
    let scheme = '';
    try {
      scheme = new URL(url).protocol;
    } catch (_err) {
      scheme = '<invalid>';
    }
    if (scheme === 'file:') {
      if (url !== mainFileUrl) report.unexpectedNetwork.push(url);
      continue;
    }
    if (!ALLOWED_SCHEMES.has(scheme)) report.unexpectedNetwork.push(url);
  }
  report.consoleErrorCount = report.consoleErrors.length;
  report.pageExceptionCount = report.pageExceptions.length;
  report.logErrorCount = report.logErrors.length;
  if (report.consoleErrorCount) report.failures.push('console error × ' + report.consoleErrorCount);
  if (report.pageExceptionCount) report.failures.push('page exception × ' + report.pageExceptionCount);
  if (report.logErrorCount) report.failures.push('log error × ' + report.logErrorCount);
  if (report.unexpectedNetwork.length) {
    report.failures.push('出現非 data:/blob: 的外部請求 × ' + report.unexpectedNetwork.length);
  }
  if (!report.result) report.failures.push('沒有取得結束結果');
  report.pass = report.failures.length === 0;
  report.finishedAt = new Date().toISOString();
  writeFileSync(join(outDir, options.label + '-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

  const summary = {
    label: report.label,
    pass: report.pass,
    result: report.result,
    frame: report.frame,
    consoleErrors: report.consoleErrorCount,
    pageExceptions: report.pageExceptionCount,
    logErrors: report.logErrorCount,
    networkRequests: report.networkRequests.length,
    unexpectedNetwork: report.unexpectedNetwork,
    screenshots: report.screenshots,
    report: join(outDir, options.label + '-report.json'),
    failures: report.failures,
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  return report.pass ? 0 : 1;
}

const args = parseArgs(process.argv.slice(2));
try {
  const code = await runAcceptance(args);
  process.exitCode = code;
} catch (err) {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exitCode = 2;
}
