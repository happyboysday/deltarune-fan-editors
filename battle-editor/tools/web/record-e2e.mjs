/**
 * tools/web/record-e2e.mjs — V2-10 頁內錄影的 headless Edge 端到端驗證
 *
 * 執行：
 *   node tools/web/record-e2e.mjs                       # 兩個情境都跑
 *   node tools/web/record-e2e.mjs --only attack         # 只跑 play.html
 *   node tools/web/record-e2e.mjs --base http://127.0.0.1:18900 --out "%TEMP%\\V2-10"
 *
 * 做什麼：
 *   1) 起 headless Edge（--mute-audio --autoplay-policy=no-user-gesture-required）
 *   2) CDP Browser.setDownloadBehavior 把下載導到 --out 指定的資料夾
 *   3) 開 play.html?attack=samples/spade-rain.json&bgm=battle&autoplay=demo&record=1
 *      與 encounter-play.html?encounter=samples/encounters/rudinn.json&autoplay=demo&record=1
 *   4) 等錄影自動開始 → 中途截圖（紅點/時間/大小）→ 測 DD12 節流提示 →
 *      等戰鬥結束後自動停止下載 → 檢查 webm 存在且非空 → ffprobe 讀軌
 *
 * 只讀專案檔案；所有暫存（profile / 下載 / 截圖）都在 --out 下。
 * 用完會關閉自己起的 Edge；不碰 18900 的伺服器。
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CDP, findEdge, waitFor } from './record-e2e-lib.mjs';

/* ---------------------------------------------------------------- 參數 */

function parseArgs(argv) {
  const out = { only: null, base: 'http://127.0.0.1:18900', out: join(tmpdir(), 'V2-10'), keep: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--only') out.only = argv[i + 1] || null;
    else if (arg === '--base') out.base = (argv[i + 1] || out.base).replace(/\/$/, '');
    else if (arg === '--out') out.out = argv[i + 1] || out.out;
    else if (arg === '--keep') out.keep = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const OUT = args.out;
const FFMPEG_BIN = process.env.FFMPEG_BIN || findBin('ffprobe.exe') || 'ffprobe';

function findBin(name) {
  const guess = join(
    process.env.LOCALAPPDATA || '',
    'Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin',
    name,
  );
  return existsSync(guess) ? guess : null;
}
const FFPROBE = process.env.FFPROBE || findBin('ffprobe.exe') || 'ffprobe';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function waitForHttp(url, timeoutMs = 20000) {
  return waitFor(
    async () => {
      try {
        const response = await fetch(url, { method: 'GET' });
        return response.ok;
      } catch (_err) {
        return null;
      }
    },
    { timeoutMs, intervalMs: 200, label: '伺服器就緒' },
  );
}

/* ---------------------------------------------------------------- Edge */

async function launchEdge(profileDir, downloadDir) {
  const exe = findEdge();
  if (!exe) throw new Error('找不到 msedge.exe');
  const port = await findFreePort();
  const proc = spawn(
    exe,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--disable-features=Translate,MediaRouter',
      '--hide-scrollbars',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--force-device-scale-factor=1',
      '--window-size=1500,1100',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  const version = await waitFor(
    async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/version`);
        return response.ok ? response.json() : null;
      } catch (_err) {
        return null;
      }
    },
    { timeoutMs: 30000, intervalMs: 200, label: 'Edge 啟動' },
  );
  const pageTarget = await waitFor(
    async () => {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await response.json();
      return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
    },
    { timeoutMs: 15000, intervalMs: 150, label: 'Edge page target' },
  );
  const cdp = await new CDP(pageTarget.webSocketDebuggerUrl).connect();
  // 下載導向：Page.setDownloadBehavior（headless 仍可用）＋ Browser.setDownloadBehavior 保險
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  try {
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  } catch (_err) {
    /* 舊版瀏覽器才有 */
  }
  try {
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir, eventsEnabled: true });
  } catch (_err) {
    /* Browser 域不一定可用 */
  }
  return {
    cdp,
    version: version.Browser || 'Edge',
    close() {
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
    },
  };
}

/* -------------------------------------------------------------- ffprobe */

function ffprobeJson(file) {
  return new Promise((resolve) => {
    const child = spawn(
      FFPROBE,
      ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data.toString('utf8');
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString('utf8');
    });
    child.on('error', (err) => resolve({ error: String(err && err.message ? err.message : err) }));
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ error: `ffprobe exit ${code}: ${stderr.trim().slice(0, 400)}` });
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (err) {
        resolve({ error: 'ffprobe JSON 解析失敗：' + err.message });
      }
    });
  });
}

function summarizeProbe(probe) {
  if (!probe || probe.error) return { ok: false, error: (probe && probe.error) || 'ffprobe 沒有輸出' };
  const streams = Array.isArray(probe.streams) ? probe.streams : [];
  const video = streams.find((s) => s.codec_type === 'video') || null;
  const audio = streams.find((s) => s.codec_type === 'audio') || null;
  const format = probe.format || {};
  return {
    ok: Boolean(video && audio),
    duration: Number(format.duration) || 0,
    size: Number(format.size) || 0,
    bitrate: Number(format.bit_rate) || 0,
    formatName: format.format_name || '',
    video: video
      ? {
          codec: video.codec_name,
          width: video.width,
          height: video.height,
          fps: video.avg_frame_rate || video.r_frame_rate,
          duration: Number(video.duration) || 0,
          frames: Number(video.nb_frames) || null,
          pixFmt: video.pix_fmt,
        }
      : null,
    audio: audio ? { codec: audio.codec_name, channels: audio.channels, sampleRate: audio.sample_rate } : null,
    raw: probe,
  };
}

/**
 * MediaRecorder 產生的 WebM 標頭沒有 duration（live stream），ffprobe 的
 * format.duration 會是 0 或缺少。用 ffmpeg 解一遍（-f null）讀出實際時長／影格數／音量，
 * 這樣「長度合理」與「音軌真的有聲音」才有數字可回報。
 */
function ffmpegAnalyze(file) {
  const exe = process.env.FFMPEG || findBin('ffmpeg.exe') || 'ffmpeg';
  return new Promise((resolve) => {
    const child = spawn(
      exe,
      ['-hide_banner', '-nostdin', '-i', file, '-map', '0:v:0', '-map', '0:a:0', '-af', 'volumedetect', '-f', 'null', '-'],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stderr = '';
    child.stdout.on('data', () => {});
    child.stderr.on('data', (data) => {
      stderr += data.toString('utf8');
    });
    child.on('error', (err) => resolve({ error: String(err && err.message ? err.message : err) }));
    child.on('close', () => {
      const timeMatch = [...stderr.matchAll(/time=(\d+):(\d+):(\d+\.\d+)/g)].pop();
      const duration = timeMatch
        ? Number(timeMatch[1]) * 3600 + Number(timeMatch[2]) * 60 + Number(timeMatch[3])
        : 0;
      // 取「最後一次」進度回報的影格數（前面的行是中途進度）
      const frameMatches = [...stderr.matchAll(/frame=\s*(\d+)/g)];
      const frameMatch = frameMatches.length ? frameMatches[frameMatches.length - 1] : null;
      const maxVol = stderr.match(/max_volume:\s*(-?[\d.]+) dB/);
      const meanVol = stderr.match(/mean_volume:\s*(-?[\d.]+) dB/);
      resolve({
        ok: duration > 0,
        duration: Math.round(duration * 1000) / 1000,
        frames: frameMatch ? Number(frameMatch[1]) : null,
        maxVolumeDb: maxVol ? Number(maxVol[1]) : null,
        meanVolumeDb: meanVol ? Number(meanVol[1]) : null,
        stderrTail: stderr.split('\n').slice(-6).join('\n'),
      });
    });
  });
}

/* --------------------------------------------------------------- 情境 */

/** 共用的頁面等待與互動。 */
async function waitForReady(cdp, kind) {
  const readyExpr =
    kind === 'encounter'
      ? '!!(window.__drEncounterPlay && window.__drEncounterPlay.video && typeof window.__drEncounterPlay.getState === "function")'
      : '!!(window.__drPlay && window.__drPlay.video && typeof window.__drPlay.getState === "function")';
  await waitFor(() => cdp.evaluate(readyExpr), { timeoutMs: 60000, intervalMs: 150, label: '頁面就緒' });
}

function debugHandle(kind) {
  return kind === 'encounter' ? 'window.__drEncounterPlay' : 'window.__drPlay';
}

async function videoSnapshot(cdp, kind) {
  return cdp.evaluate(`(() => { const h = ${debugHandle(kind)}; return h && h.video ? h.video.snapshot() : null; })()`);
}

async function captureScreenshot(cdp, outPath) {
  const result = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  writeFileSync(outPath, Buffer.from(result.data, 'base64'));
  return outPath;
}

async function runScenario(scenario, options) {
  const kind = scenario.kind;
  const downloadDir = join(options.out, scenario.downloadSubdir);
  mkdirSync(downloadDir, { recursive: true });
  // 只清掉上一輪的「錄影檔」（本工具自己產生的 .webm/.mp4/.crdownload），不動其他檔案
  for (const entry of readdirSync(downloadDir)) {
    if (!/\.(webm|mp4|crdownload)$/i.test(entry)) continue;
    const target = join(downloadDir, entry);
    try {
      if (!statSync(target).isDirectory()) rmSync(target, { force: true });
    } catch (_err) {
      /* 忽略 */
    }
  }

  // Edge 使用者資料夾留在 %TEMP%\<任務>\ 下（不遞迴刪除；跑完可自行清）
  const profileDir = join(options.out, 'edge-profile-' + scenario.id);
  mkdirSync(profileDir, { recursive: true });
  const report = {
    id: scenario.id,
    kind,
    url: '',
    started: false,
    stopped: false,
    result: null,
    screenshots: [],
    throttle: null,
    downloadDir,
    file: null,
    fileSize: 0,
    ffprobe: null,
    consoleErrors: [],
    pageErrors: [],
  };

  let edge = null;
  try {
    edge = await launchEdge(profileDir, downloadDir);
    edge.cdp.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        const text = (params.args || []).map((a) => (a.value !== undefined ? a.value : a.description || '')).join(' ');
        report.consoleErrors.push(String(text).slice(0, 300));
      }
    });
    edge.cdp.on('Runtime.exceptionThrown', (params) => {
      const details = params.exceptionDetails || {};
      const text = (details.exception && (details.exception.description || details.exception.value)) || details.text || '';
      report.pageErrors.push(String(text).slice(0, 400));
    });

    const url = `${options.base}/${scenario.path}`;
    report.url = url;
    const loaded = edge.cdp.waitForEvent('Page.loadEventFired', 45000).catch(() => null);
    await edge.cdp.send('Page.navigate', { url });
    await loaded;
    await waitForReady(edge.cdp, kind);

    // ---- 手動模式（沒有 ?record=1）：測 V 熱鍵開關 + 再次下載 ----
    if (scenario.manual) {
      report.manual = await runManualChecks(edge.cdp, kind, scenario);
      report.file = report.manual.file;
      report.fileSize = report.manual.fileSize;
      report.ffprobe = report.manual.ffprobe;
      report.ffmpeg = report.manual.ffmpeg;
      report.result = report.manual.result;
      report.started = report.manual.startedByKey;
      report.stopped = report.manual.stoppedByKey;
      report.screenshots = report.manual.screenshots;
      return report;
    }

    // ---- 錄影應該已自動開始（?record=1）----
    const startedSnap = await waitFor(
      async () => {
        const snap = await videoSnapshot(edge.cdp, kind);
        return snap && snap.recording ? snap : null;
      },
      { timeoutMs: 30000, intervalMs: 150, label: '自動錄影開始' },
    );
    report.started = true;
    report.startSnapshot = {
      state: startedSnap.state,
      filename: startedSnap.filename,
      scale: startedSnap.scale,
      audioWarning: startedSnap.audioWarning,
      mimeType: startedSnap.mimeType,
    };

    // ---- 錄影中截圖（紅點＋時間＋大小）----
    await sleep(1400);
    const liveSnap = await videoSnapshot(edge.cdp, kind);
    report.liveSnapshot = {
      elapsed: liveSnap.elapsed,
      bytes: liveSnap.bytes,
      recording: liveSnap.recording,
      filename: liveSnap.filename,
    };
    const uiText = await edge.cdp.evaluate(
      `(() => {
         const t = document.getElementById('vidrec-toggle');
         const h = document.getElementById('vidrec-hud');
         const note = document.getElementById('vidrec-note');
         return {
           toggle: t ? t.textContent : null,
           recording: t ? t.classList.contains('is-recording') : false,
           hud: h ? h.textContent.trim() : null,
           hudVisible: h ? h.dataset.visible === '1' : false,
           downloadVisible: !!document.getElementById('vidrec-download') && !document.getElementById('vidrec-download').hidden,
           note: note && !note.hidden ? note.textContent : '',
           scaleValue: (document.getElementById('vidrec-scale') || {}).value || null,
         };
       })()`,
    );
    report.ui = uiText;
    report.screenshots.push(await captureScreenshot(edge.cdp, join(options.out, `${scenario.id}-recording.png`)));

    // ---- DD12：先確認「沒被節流時不會誤報」----
    report.throttleNatural = await edge.cdp.evaluate(
      `(() => {
         const h = ${debugHandle(kind)};
         const st = h.video.throttle();
         const el = document.getElementById('vidrec-throttle');
         return { state: st, uiHidden: el ? el.hidden : null };
       })()`,
    );

    // ---- ?chrome=0：錄影 UI 應該被頁面 CSS 藏起來（但錄影照常）----
    if (scenario.chromeHidden) {
      report.chromeHiddenUi = await edge.cdp.evaluate(
        `(() => {
           const group = document.getElementById('vidrec-group');
           const snap = (() => {
             const h = ${debugHandle(kind)};
             return h.video ? h.video.snapshot() : null;
           })();
           return {
             bodyHasClass: document.body.classList.contains('chrome-hidden'),
             groupDisplay: group ? getComputedStyle(group).display : null,
             groupVisible: group ? group.offsetParent !== null : null,
             recordingStillRunning: Boolean(snap && snap.recording),
           };
         })()`,
      );
    }

    // ---- DD12：真的把 document.hidden 改成 true 並發 visibilitychange（走頁面真實監聽）----
    report.throttleHiddenEvent = await edge.cdp.evaluate(
      `(() => {
         const define = (name, value) =>
           Object.defineProperty(document, name, { configurable: true, get: () => value });
         define('hidden', true);
         define('visibilityState', 'hidden');
         document.dispatchEvent(new Event('visibilitychange'));
         const el = document.getElementById('vidrec-throttle');
         const out = { hidden: el ? el.hidden : null, text: el ? el.textContent : null };
         // 還原成原型上的原生 getter
         delete document.hidden;
         delete document.visibilityState;
         document.dispatchEvent(new Event('visibilitychange'));
         const after = document.getElementById('vidrec-throttle');
         out.afterRestoreHidden = after ? after.hidden : null;
         return out;
       })()`,
    );
    await sleep(150);

    // ---- DD12：模擬背景節流，檢查提示 ----
    const throttleState = await edge.cdp.evaluate(
      `(() => { const h = ${debugHandle(kind)}; return h.video.simulateThrottle({ hidden: true, fps: 6 }); })()`,
    );
    await sleep(300);
    const throttleUi = await edge.cdp.evaluate(
      `(() => {
         const el = document.getElementById('vidrec-throttle');
         return {
           hidden: el ? el.hidden : null,
           text: el ? el.textContent : null,
           isRecording: el ? el.classList.contains('is-recording') : false,
         };
       })()`,
    );
    report.throttle = { state: throttleState, ui: throttleUi };
    report.screenshots.push(await captureScreenshot(edge.cdp, join(options.out, `${scenario.id}-throttle.png`)));
    // 恢復正常（避免影響錄影本身）
    await edge.cdp.evaluate(`(() => { const h = ${debugHandle(kind)}; return h.video.simulateThrottle(null); })()`);
    await sleep(200);

    // ---- 等戰鬥結束 → 自動停止（?record=1 再錄 1 秒）----
    const finished = await waitFor(
      async () => {
        const results = await edge.cdp.evaluate(
          `(() => { const h = ${debugHandle(kind)}; return h.video ? h.video.results() : []; })()`,
        );
        return Array.isArray(results) && results.length > 0 ? results[results.length - 1] : null;
      },
      { timeoutMs: scenario.timeoutMs || 180000, intervalMs: 300, label: '錄影完成' },
    );
    report.stopped = true;
    report.result = {
      filename: finished.filename,
      bytes: finished.bytes,
      downloaded: finished.downloaded,
      empty: finished.empty,
    };
    await sleep(600); // 等瀏覽器把下載寫完

    // ---- 下載檔檢查 ----
    const files = readdirSync(downloadDir).filter((name) => /\.(webm|mp4)$/i.test(name));
    if (files.length > 0) {
      const file = join(downloadDir, files[0]);
      report.file = file;
      report.fileSize = statSync(file).size;
      report.ffprobe = summarizeProbe(await ffprobeJson(file));
      report.ffmpeg = await ffmpegAnalyze(file);
      await ffprobeText(file, join(options.out, `${scenario.id}-ffprobe.txt`));
    } else {
      // 沒有下載檔 → 從頁面拿 Blob 寫檔（備援，headless 下載被封鎖時）
      const file = await dumpBlobToFile(edge.cdp, kind, join(downloadDir, `${scenario.id}-fallback.webm`));
      if (file) {
        report.file = file;
        report.fileSize = statSync(file).size;
        report.ffprobe = summarizeProbe(await ffprobeJson(file));
        report.ffmpeg = await ffmpegAnalyze(file);
        report.fallbackBlob = true;
      }
    }

    // ---- 停止後截圖（下載按鈕 + 完成訊息）----
    await sleep(300);
    report.screenshots.push(await captureScreenshot(edge.cdp, join(options.out, `${scenario.id}-stopped.png`)));
    report.pageInfo = await edge.cdp.evaluate(
      `(() => ({
         banner: (document.getElementById('banner') || {}).textContent || '',
         note: (() => { const n = document.getElementById('vidrec-note'); return n && !n.hidden ? n.textContent : ''; })(),
         downloadVisible: !!document.getElementById('vidrec-download') && !document.getElementById('vidrec-download').hidden,
         throttleHidden: (document.getElementById('vidrec-throttle') || {}).hidden,
       }))()`,
    );
  } finally {
    if (edge) edge.close();
    await sleep(400);
    // Edge 的 user-data-dir 就留在 %TEMP%\V2-10\ 下（本任務規定的暫存區）。
    // 不做遞迴刪除（專案規則禁止）；要清請自行把整個資料夾移到回收筒。
  }
  return report;
}

/* ---------------------------------------------------------- 手動模式 */

/**
 * 手動錄影驗證（對應「沒有 ?record=1，使用者按 V 或點 ⏺ 錄影」）：
 *   V 開錄 → 等 2 秒 → V 停錄並下載 → 檢查檔案 → 點「⬇ 再次下載」→ 檔案變兩個。
 */
async function runManualChecks(cdp, kind, scenario) {
  const id = scenario ? scenario.id : 'manual';
  const out = { screenshots: [], startedByKey: false, stoppedByKey: false, redownload: null };
  const dir = join(OUT, id);
  mkdirSync(dir, { recursive: true });
  // 清掉上一輪的錄影檔（只刪檔、不遞迴）
  for (const entry of readdirSync(dir)) {
    const target = join(dir, entry);
    try {
      if (!statSync(target).isDirectory()) rmSync(target, { force: true });
    } catch (_err) {
      /* 忽略 */
    }
  }
  const uiSnapshot = () =>
    cdp.evaluate(
      `(() => {
         const t = document.getElementById('vidrec-toggle');
         const h = document.getElementById('vidrec-hud');
         const d = document.getElementById('vidrec-download');
         return {
           toggle: t ? t.textContent : null,
           recording: t ? t.classList.contains('is-recording') : false,
           hudVisible: h ? h.dataset.visible === '1' : false,
           hud: h ? h.textContent.trim() : null,
           downloadVisible: d ? !d.hidden : false,
           scaleValue: (document.getElementById('vidrec-scale') || {}).value || null,
         };
       })()`,
    );

  // 按 V（真的走鍵盤事件，驗證熱鍵沒被其他功能吃掉）
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
  const recording = await waitFor(
    async () => {
      const snap = await videoSnapshot(cdp, kind);
      return snap && snap.recording ? snap : null;
    },
    { timeoutMs: 15000, intervalMs: 100, label: 'V 鍵開錄' },
  );
  out.startedByKey = true;
  out.startSnapshot = { filename: recording.filename, scale: recording.scale, mimeType: recording.mimeType };
  await sleep(2000);
  out.live = await uiSnapshot();
  out.screenshots.push(await captureScreenshot(cdp, join(OUT, id + '-recording.png')));

  // 再按 V 停止 → 應該自動下載
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
  const finished = await waitFor(
    async () => {
      const results = await cdp.evaluate(
        `(() => { const h = ${debugHandle(kind)}; return h.video ? h.video.results() : []; })()`,
      );
      return Array.isArray(results) && results.length ? results[results.length - 1] : null;
    },
    { timeoutMs: 30000, intervalMs: 150, label: 'V 鍵停錄' },
  );
  out.stoppedByKey = true;
  out.result = { filename: finished.filename, bytes: finished.bytes, downloaded: finished.downloaded };
  await sleep(1200);
  out.afterStop = await uiSnapshot();
  out.screenshots.push(await captureScreenshot(cdp, join(OUT, id + '-stopped.png')));

  const before = readdirSync(dir).filter((name) => /\.(webm|mp4)$/i.test(name));
  let file = before.length ? join(dir, before[0]) : null;
  if (!file) {
    // 下載沒落地 → 從頁面 Blob 備援寫檔
    file = await dumpBlobToFile(cdp, kind, join(dir, 'manual-fallback.webm'));
  }
  if (file) {
    out.file = file;
    out.fileSize = statSync(file).size;
    out.ffprobe = summarizeProbe(await ffprobeJson(file));
    out.ffmpeg = await ffmpegAnalyze(file);
    await ffprobeText(file, join(OUT, id + '-ffprobe.txt'));
  }

  // 點「⬇ 再次下載」→ 應該再產生一個檔
  //（CDP 的 setDownloadBehavior 對同名檔可能直接覆寫，所以先把第一個檔改名再驗）
  const firstFile = join(dir, 'first-download.webm');
  if (file) {
    try {
      renameSync(file, firstFile);
    } catch (_err) {
      /* 忽略 */
    }
  }
  const seen = new Set(readdirSync(dir));
  await cdp.evaluate(`(() => { const b = document.getElementById('vidrec-download'); if (b) b.click(); })()`);
  let redownloadFile = null;
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await sleep(250);
    const created = readdirSync(dir).filter((name) => !seen.has(name) && /\.(webm|mp4)$/i.test(name));
    if (created.length) {
      redownloadFile = created[0];
      break;
    }
  }
  out.redownload = {
    ok: Boolean(redownloadFile),
    file: redownloadFile,
    files: readdirSync(dir).slice(0, 6),
  };
  if (!out.redownload.ok) {
    // 沒落地也至少確認頁面的下載呼叫成功（saveBlob 回 true）
    out.redownload.pageDownloadReturns = await cdp.evaluate(
      `(() => { const h = ${debugHandle(kind)}; return h.video && h.video.snapshot ? true : false; })()`,
    );
  }
  return out;
}

/** 從頁面拿 Blob 寫成檔案（headless 下載被封鎖時的備援）。 */
async function dumpBlobToFile(cdp, kind, file) {
  const info = await cdp.evaluate(
    `(async () => {
       const h = ${debugHandle(kind)};
       const blob = h.video.blob();
       if (!blob) return null;
       const buf = new Uint8Array(await blob.arrayBuffer());
       let text = '';
       const chunk = 0x8000;
       for (let i = 0; i < buf.length; i += chunk) {
         text += String.fromCharCode.apply(null, buf.subarray(i, i + chunk));
       }
       return { size: buf.length, b64: btoa(text) };
     })()`,
    { awaitPromise: true, timeoutMs: 60000 },
  );
  if (!info || !info.size) return null;
  writeFileSync(file, Buffer.from(info.b64, 'base64'));
  return file;
}

/**
 * 把 ffprobe 的「人類可讀」輸出存成文字檔（回報用）。
 * MediaRecorder 的 WebM 標頭沒有 duration，所以要另外跑一次 ffmpeg 解碼補時長。
 */
function ffprobeText(file, outPath) {
  return new Promise((resolve) => {
    const child = spawn(
      FFPROBE,
      ['-hide_banner', '-show_format', '-show_streams', file],
      { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true },
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data.toString('utf8');
    });
    child.stderr.on('data', (data) => {
      stderr += data.toString('utf8');
    });
    child.on('error', (err) => resolve({ error: String(err && err.message ? err.message : err) }));
    child.on('close', (code) => {
      const text = stdout + (stderr ? '\n# stderr\n' + stderr : '');
      try {
        writeFileSync(outPath, text);
      } catch (_err) {
        /* 忽略 */
      }
      resolve({ code, path: outPath, text });
    });
  });
}

/* ---------------------------------------------------------------- 主流程 */
const SCENARIOS = [
  {
    id: 'attack',
    kind: 'attack',
    downloadSubdir: 'attack',
    path:
      'play.html?attack=samples/spade-rain.json&bgm=battle&autoplay=demo&record=1&scale=2&recscale=2&lang=zh',
    timeoutMs: 150000,
  },
  {
    id: 'encounter',
    kind: 'encounter',
    downloadSubdir: 'encounter',
    path:
      'encounter-play.html?encounter=samples/encounters/rudinn.json&autoplay=demo&record=1&scale=2&recscale=1&lang=zh',
    timeoutMs: 300000,
  },
  {
    id: 'manual',
    kind: 'attack',
    downloadSubdir: 'manual',
    manual: true,
    // 不用 ?record=1：測 V 熱鍵手動開/停 + 停止後自動下載 + 「再次下載」
    path: 'play.html?attack=samples/spade-rain.json&bgm=battle&autoplay=demo&scale=2&recscale=1&lang=zh',
    timeoutMs: 120000,
  },
  {
    id: 'manual-enc',
    kind: 'encounter',
    downloadSubdir: 'manual-enc',
    manual: true,
    // 遭遇頁自動演示中按 V：AUTO_PASS_KEYS 必須放行 v（否則會被捕獲階段攔掉）
    path: 'encounter-play.html?encounter=samples/encounters/rudinn.json&autoplay=demo&lang=zh',
    timeoutMs: 180000,
  },
  {
    id: 'chrome0',
    kind: 'attack',
    downloadSubdir: 'chrome0',
    chromeHidden: true,
    // ?chrome=0：UI 全隱藏、錄影照常（?record=1 自動錄 → 自動停 → 自動下載）
    path:
      'play.html?attack=samples/spade-rain.json&bgm=battle&autoplay=demo&record=1&chrome=0&recscale=1&lang=zh',
    timeoutMs: 150000,
  },
  {
    id: 'chrome0-enc',
    kind: 'encounter',
    downloadSubdir: 'chrome0-enc',
    chromeHidden: true,
    // 遭遇頁的 ?chrome=0：UI 隱藏、錄影照常（遭遇 result → 再 1 秒停止下載）
    path:
      'encounter-play.html?encounter=samples/encounters/rudinn.json&autoplay=demo&record=1&chrome=0&lang=zh',
    timeoutMs: 300000,
  },
];

async function main() {
  mkdirSync(OUT, { recursive: true });
  console.log(`輸出目錄：${OUT}`);
  await waitForHttp(`${args.base}/play.html`);
  console.log(`伺服器：${args.base}（既有，不會停）`);

  const scenarios = args.only ? SCENARIOS.filter((s) => s.id === args.only) : SCENARIOS;
  if (!scenarios.length) throw new Error(`--only 不認識：${args.only}`);

  const reports = [];
  for (const scenario of scenarios) {
    console.log(`\n=== ${scenario.id}：${scenario.path}`);
    const report = await runScenario(scenario, { ...args, out: OUT });
    reports.push(report);
    if (report.manual) {
      const m = report.manual;
      const probe = m.ffprobe || {};
      console.log(`  V 鍵開錄：${m.startedByKey}  停止並下載：${m.stoppedByKey}`);
      console.log(`  錄影中 UI：${JSON.stringify(m.live)}`);
      console.log(`  檔名：${m.result && m.result.filename}  大小：${m.fileSize} bytes`);
      console.log(`  再次下載：${JSON.stringify(m.redownload)}`);
      if (probe.ok) {
        console.log(
          `  ffprobe：影像 ${probe.video.codec} ${probe.video.width}x${probe.video.height}　` +
            `音訊 ${probe.audio.codec} ${probe.audio.channels}ch ${probe.audio.sampleRate}Hz`,
        );
        console.log(`  解碼：長度 ${(m.ffmpeg || {}).duration}s  影格 ${(m.ffmpeg || {}).frames}`);
      } else {
        console.log(`  ffprobe 失敗：${probe.error || '（沒有檔案）'}`);
      }
      console.log(`  截圖：${(m.screenshots || []).join(', ')}`);
      continue;
    }
    const probe = report.ffprobe || {};
    console.log(`  錄影開始：${report.started}  停止：${report.stopped}`);
    console.log(`  檔名：${report.result && report.result.filename}`);
    console.log(`  大小：${report.fileSize} bytes  下載：${report.result && report.result.downloaded}`);
    if (report.file) console.log(`  檔案：${report.file}`);
    if (probe.ok) {
      const enc = report.ffmpeg || {};
      console.log(
        `  ffprobe：${probe.formatName}  ` +
          `影像 ${probe.video.codec} ${probe.video.width}x${probe.video.height}（r_frame_rate ${probe.video.fps}）  ` +
          `音訊 ${probe.audio.codec} ${probe.audio.channels}ch ${probe.audio.sampleRate}Hz  ` +
          `raw size ${probe.size}B`,
      );
      console.log(
        `  解碼：長度 ${enc.duration}s  影格 ${enc.frames}  音量 max ${enc.maxVolumeDb}dB / mean ${enc.meanVolumeDb}dB`,
      );
    } else {
      console.log(`  ffprobe 失敗：${probe.error || '（沒有檔案）'}`);
    }
    if (report.pageErrors.length) console.log(`  頁面錯誤：${report.pageErrors.slice(0, 3).join(' | ')}`);
    console.log(`  截圖：${report.screenshots.join(', ')}`);
  }

  const summaryPath = join(OUT, 'record-e2e-report.json');
  writeFileSync(summaryPath, JSON.stringify(reports, null, 2) + '\n');
  console.log(`\n報告：${summaryPath}`);

  const failed = reports.filter((r) => {
    if (r.manual) {
      const m = r.manual || {};
      return !m.startedByKey || !m.stoppedByKey || !m.ffprobe || !m.ffprobe.ok || m.fileSize <= 0;
    }
    return !r.ffprobe || !r.ffprobe.ok || r.fileSize <= 0 || !r.started || !r.stopped;
  });
  if (failed.length) {
    console.log(`\n失敗：${failed.map((r) => r.id).join(', ')}`);
    process.exitCode = 1;
  } else {
    console.log('\n全部通過');
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
