/**
 * tools/web/record-e2e-extra.mjs — 補充驗證（V2-10）
 *
 * 驗證「同一個頁面連續錄兩次」：
 *   按 V 錄 1.5 秒 → V 停（下載第 1 段）→ 再按 V 錄 1.5 秒 → V 停（下載第 2 段）
 *   兩段都要是有效 webm（ffprobe 有影像+音訊軌），檔名時間不同。
 *
 * 執行：node tools/web/record-e2e-extra.mjs [--base URL] [--out DIR]
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CDP, findEdge, waitFor } from './record-e2e-lib.mjs';

const args = process.argv.slice(2);
function argOf(name, fallback) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
}
const BASE = argOf('--base', 'http://127.0.0.1:18900').replace(/\/$/, '');
const OUT = argOf('--out', join(tmpdir(), 'V2-10'));
const FFPROBE = argOf(
  '--ffprobe',
  // WinGet's FFmpeg package location for the current user; pass --ffprobe to use another copy.
  join(process.env.LOCALAPPDATA || '', 'Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0.2-full_build/bin/ffprobe.exe'),
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function probe(file) {
  return new Promise((resolve) => {
    const child = spawn(FFPROBE, ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    child.stdout.on('data', (d) => (stdout += d.toString('utf8')));
    child.on('close', (code) => {
      if (code !== 0) return resolve({ error: 'ffprobe exit ' + code });
      try {
        const json = JSON.parse(stdout);
        const streams = json.streams || [];
        resolve({
          video: streams.find((s) => s.codec_type === 'video') || null,
          audio: streams.find((s) => s.codec_type === 'audio') || null,
          size: Number((json.format || {}).size) || 0,
        });
      } catch (err) {
        resolve({ error: String(err.message || err) });
      }
    });
  });
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const downloadDir = join(OUT, 'extra');
  mkdirSync(downloadDir, { recursive: true });
  const port = await freePort();
  const profileDir = join(OUT, 'edge-profile-extra');
  const edge = spawn(
    findEdge(),
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1500,1100',
      'about:blank',
    ],
    { stdio: 'ignore', windowsHide: true },
  );
  let cdp = null;
  try {
    const version = await waitFor(
      async () => {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        return r.ok ? r.json() : null;
      },
      { timeoutMs: 30000, intervalMs: 200, label: 'Edge' },
    );
    console.log('瀏覽器：', version.Browser);
    const target = await waitFor(
      async () => {
        const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
        return list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) || null;
      },
      { timeoutMs: 15000, intervalMs: 150, label: 'page target' },
    );
    cdp = await new CDP(target.webSocketDebuggerUrl).connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Browser.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: downloadDir,
      eventsEnabled: true,
    });

    const url = `${BASE}/play.html?attack=samples/spade-rain.json&bgm=battle&autoplay=demo&lang=zh`;
    console.log('開頁：', url);
    const loaded = cdp.waitForEvent('Page.loadEventFired', 45000).catch(() => null);
    await cdp.send('Page.navigate', { url });
    await loaded;
    await waitFor(
      () => cdp.evaluate('!!(window.__drPlay && window.__drPlay.video && window.__drPlay.getState())'),
      { timeoutMs: 60000, intervalMs: 150, label: '頁面就緒' },
    );

    const pressV = async () => {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86 });
    };
    const snap = () => cdp.evaluate('window.__drPlay.video.snapshot()');
    const results = () => cdp.evaluate('window.__drPlay.video.results()');

    const rounds = [];
    for (let i = 0; i < 2; i += 1) {
      await pressV();
      await waitFor(async () => ((await snap()) || {}).recording === true, {
        timeoutMs: 15000,
        intervalMs: 100,
        label: `第 ${i + 1} 段開錄`,
      });
      const started = await snap();
      await sleep(1500);
      await pressV();
      const count = i + 1;
      await waitFor(async () => (await results()).length >= count, {
        timeoutMs: 30000,
        intervalMs: 150,
        label: `第 ${i + 1} 段完成`,
      });
      await sleep(1000);
      const list = await results();
      rounds.push({ index: i + 1, filename: list[i].filename, bytes: list[i].bytes, started: started.filename });
    }

    const files = readdirSync(downloadDir).filter((n) => /\.webm$/i.test(n));
    console.log('下載檔：', files.join(' | '));
    const report = { rounds, files: [] };
    for (const name of files) {
      const file = join(downloadDir, name);
      const info = await probe(file);
      report.files.push({
        name,
        size: statSync(file).size,
        video: info.video ? { codec: info.video.codec_name, w: info.video.width, h: info.video.height } : null,
        audio: info.audio ? { codec: info.audio.codec_name, ch: info.audio.channels } : null,
        error: info.error || null,
      });
      console.log(
        `  ${name}  ${statSync(file).size} bytes  影像 ${info.video ? info.video.codec_name + ' ' + info.video.width + 'x' + info.video.height : '無'}  音訊 ${info.audio ? info.audio.codec_name + ' ' + info.audio.channels + 'ch' : '無'}`,
      );
    }
    // 兩段檔名必須不同（時間戳）
    const distinct = new Set(rounds.map((r) => r.filename)).size === rounds.length;
    console.log(`連續兩段：${rounds.length} 段，檔名互異：${distinct}`);
    report.ok = files.length >= 2 && report.files.every((f) => f.video && f.audio) && distinct;
    const outPath = join(OUT, 'extra-report.json');
    writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n');
    console.log(report.ok ? '通過' : '失敗');
    console.log('報告：', outPath);
    if (!report.ok) process.exitCode = 1;
  } finally {
    if (cdp) cdp.close();
    await sleep(300);
    try {
      spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch (_err) {
      /* 忽略 */
    }
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : String(err));
  process.exitCode = 1;
});
