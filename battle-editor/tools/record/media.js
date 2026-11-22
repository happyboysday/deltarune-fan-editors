/**
 * tools/record/media.js — ffmpeg 探測、執行、探針與音檔抓取（V2-11 逐幀錄影）
 *
 * 為什麼自己找 ffmpeg：
 *   Windows 的 PATH 有時候只有 `ffmpeg.exe`（沒有 ffprobe）或反過來；工具要能
 *   明確說明「缺哪一個」，而不是丟一句 spawn ENOENT。找不到時回報的錯誤訊息會
 *   告訴使用者 PNG 序列仍可用（--png-dir），只有混音／合成需要 ffmpeg。
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** 找不到 ffmpeg 時的錯誤碼（測試與 MCP 都靠這個判斷）。 */
export const NO_FFMPEG = 'NO_FFMPEG';
export const NO_FFPROBE = 'NO_FFPROBE';

const COMMON_WINDOWS = [
  'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
  'C:/Program Files (x86)/ffmpeg/bin/ffmpeg.exe',
];

let cached = null;

/**
 * 找 ffmpeg / ffprobe。
 * @param {{ffmpeg?:string|null, ffprobe?:string|null, probe?:Function}} [options]
 *        probe 可注入（測試用）：回傳被找到的路徑或 null。
 * @returns {{ffmpeg:string, ffprobe:string|null, source:string}}
 */
export function resolveFfmpeg(options = {}) {
  if (cached && !options.ffmpeg && !options.ffprobe && !options.probe) return cached;
  const probe =
    typeof options.probe === 'function'
      ? options.probe
      : (name) => {
          const result = spawnSync(name, ['-version'], { stdio: 'ignore', windowsHide: true });
          return result && result.status === 0 ? name : null;
        };
  const fromEnv = (key) => {
    const value = process.env[key];
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  };
  // 顯式路徑（--ffmpeg / FFMPEG_PATH）若指向不存在的檔案，就當作「沒指定」再找 PATH：
  // 否則使用者會看到「混音失敗：無法執行 … ENOENT」，而不是「找不到 ffmpeg，仍可用 --png-dir」。
  const usable = (value) => {
    if (!value) return null;
    const looksLikePath = value.includes('/') || value.includes('\\');
    if (!looksLikePath) return value;
    return existsSync(value) ? value : null;
  };
  const ffmpeg =
    usable(options.ffmpeg) || usable(fromEnv('FFMPEG_PATH')) || probe('ffmpeg') || null;
  const ffprobe =
    usable(options.ffprobe) || usable(fromEnv('FFPROBE_PATH')) || probe('ffprobe') || null;
  const resolved = {
    ffmpeg: ffmpeg || null,
    ffprobe: ffprobe || null,
    source: ffmpeg && (options.ffmpeg || fromEnv('FFMPEG_PATH')) ? 'explicit' : 'path',
  };
  if (!options.ffmpeg && !options.ffprobe && !options.probe) cached = resolved;
  return resolved;
}

/** 測試 / 診斷用：清掉快取。 */
export function resetFfmpegCache() {
  cached = null;
}

/**
 * 需要 ffmpeg 的階段（--wav / --out）之前呼叫；沒有就丟明確錯誤。
 *
 * 訊息刻意提到 `--png-dir`：逐幀擷取不需要 ffmpeg，只有混音與合成需要。
 * @returns {{ffmpeg:string, ffprobe:string|null}}
 */
export function requireFfmpeg(options = {}) {
  const found = resolveFfmpeg(options);
  if (!found.ffmpeg) {
    const error = new Error(
      '找不到 ffmpeg：無法混音（--wav）或合成 MP4（--out）。\n' +
        '  · 仍可用的做法：加 --png-dir <dir> 只輸出 PNG 序列（逐幀擷取不需要 ffmpeg），' +
        '再把序列與音訊事件表（audio-events.json）交給剪輯軟體。\n' +
        '  · 需要 --wav / --out 時請安裝 ffmpeg（winget install Gyan.FFmpeg），' +
        '或用環境變數 FFMPEG_PATH / FFPROBE_PATH 指定路徑。',
    );
    error.code = NO_FFMPEG;
    throw error;
  }
  if (!found.ffprobe) {
    const error = new Error(
      '找不到 ffprobe：混音時要量測音檔長度（BGM 循環、SFX 對齊），做不到就無法保證音畫同步。\n' +
        '  · 仍可用的做法：加 --png-dir <dir> 只輸出 PNG 序列（不需要 ffprobe）。\n' +
        '  · 請安裝完整 ffmpeg（含 ffprobe：winget install Gyan.FFmpeg），' +
        '或用環境變數 FFPROBE_PATH 指定路徑。',
    );
    error.code = NO_FFPROBE;
    throw error;
  }
  return found;
}

/* ------------------------------------------------------------ 子程序 */

/**
 * 跑一個子程序並收完 stdout/stderr。
 * @param {string} command
 * @param {string[]} args
 * @param {{timeoutMs?:number, cwd?:string, onStderr?:Function}} [options]
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function runProcess(command, args, options = {}) {
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30 * 60 * 1000);
  return new Promise((resolve, reject) => {
    let child = null;
    try {
      child = spawn(command, args, {
        cwd: options.cwd || undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (err) {
      reject(new Error(`無法執行 ${command}：${err && err.message ? err.message : err}`));
      return;
    }
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch (_err) {
        /* 已死 */
      }
      reject(new Error(`${command} 逾時（${Math.round(timeoutMs / 1000)} 秒）`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      if (stderr.length > 200000) stderr = stderr.slice(-200000);
      if (typeof options.onStderr === 'function') options.onStderr(text);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      const wrapped = new Error(`無法執行 ${command}：${err && err.message ? err.message : err}`);
      wrapped.code = err && err.code;
      reject(wrapped);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, stdout, stderr });
    });
  });
}

/**
 * 跑 ffmpeg；非 0 結束就把 stderr 最後幾行塞進錯誤訊息。
 */
export async function runFfmpeg(ffmpeg, args, options = {}) {
  const result = await runProcess(ffmpeg, args, options);
  if (result.code !== 0) {
    const detail = result.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-6)
      .join(' / ');
    const error = new Error(`ffmpeg 失敗（exit ${result.code}）${detail ? `：${detail}` : ''}`);
    error.code = 'FFMPEG_FAILED';
    error.stderr = result.stderr;
    throw error;
  }
  return result;
}

/* -------------------------------------------------------------- 探針 */

/**
 * ffprobe 一個檔案（-print_format json），回傳整理後的摘要。
 * 沒有 ffprobe 時回 {error}（不丟錯；MP4 驗收才需要它）。
 */
export async function probeMedia(ffprobe, file, options = {}) {
  if (!ffprobe) return { file, error: '沒有 ffprobe' };
  const result = await runProcess(
    ffprobe,
    ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
    { timeoutMs: options.timeoutMs || 60000 },
  );
  if (result.code !== 0) {
    return { file, error: `ffprobe 失敗（exit ${result.code}）：${result.stderr.trim().split(/\r?\n/).slice(-2).join(' / ')}` };
  }
  let json = null;
  try {
    json = JSON.parse(result.stdout);
  } catch (_err) {
    return { file, error: 'ffprobe 輸出不是 JSON' };
  }
  const format = json.format || {};
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const video = streams.find((stream) => stream.codec_type === 'video') || null;
  const audio = streams.find((stream) => stream.codec_type === 'audio') || null;
  const parseRate = (text) => {
    const [a, b] = String(text || '').split('/').map(Number);
    if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return null;
    return a / b;
  };
  return {
    file,
    duration: Number(format.duration) || null,
    size: Number(format.size) || null,
    formatName: format.format_name || null,
    video: video
      ? {
          codec: video.codec_name || null,
          width: Number(video.width) || null,
          height: Number(video.height) || null,
          pixFmt: video.pix_fmt || null,
          fps: parseRate(video.r_frame_rate || video.avg_frame_rate),
          frames: Number(video.nb_frames) || null,
          duration: Number(video.duration) || null,
        }
      : null,
    audio: audio
      ? {
          codec: audio.codec_name || null,
          sampleRate: Number(audio.sample_rate) || null,
          channels: Number(audio.channels) || null,
          duration: Number(audio.duration) || null,
          bitRate: Number(audio.bit_rate) || null,
        }
      : null,
  };
}

/* ------------------------------------------------------- 音檔抓取 */

/**
 * 從本機伺服器把事件表用到的音檔抓到暫存目錄（保留相對路徑）。
 *
 * 為什麼走 HTTP 而不是直接讀檔：作品根（--works）的自訂音訊由 serve.py 從
 * 不同位置提供（assets/custom/ 會落回主 repo），走 HTTP 才會與頁面實際聽到的
 * 是同一份檔案。
 *
 * @param {{baseUrl:string, files:string[], outDir:string, resolveUrl?:Function, fetchImpl?:Function}} options
 * @returns {Promise<{files:Record<string,string>, bytes:number, warnings:string[]}>}
 */
export async function downloadAudioFiles(options) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const outDir = String(options.outDir || '');
  const files = Array.isArray(options.files) ? options.files : [];
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : fetch;
  const resolveUrl =
    typeof options.resolveUrl === 'function'
      ? options.resolveUrl
      : (file) => `${baseUrl}/assets/${String(file).replace(/\\/g, '/').replace(/^\/+/, '')}`;
  const downloaded = {};
  const warnings = [];
  let bytes = 0;
  for (const file of files) {
    const url = resolveUrl(file);
    const target = join(outDir, ...String(file).replace(/\\/g, '/').split('/'));
    try {
      const response = await fetchImpl(url);
      if (!response || !response.ok) throw new Error(`HTTP ${response ? response.status : '?'}`);
      const buffer = Buffer.from(await response.arrayBuffer());
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, buffer);
      downloaded[file] = target;
      bytes += buffer.length;
    } catch (err) {
      warnings.push(`音檔抓取失敗：${file}（${url}）：${err && err.message ? err.message : err}`);
    }
  }
  return { files: downloaded, bytes, warnings, outDir };
}

/* ---------------------------------------------------------- 驗收輔助 */

/**
 * 驗證 MP4：幀數、fps、尺寸、音軌、長度。回傳 {ok, errors[], probe}。
 * 這是 `--verify` 與 tests/record 的共用邏輯（純函式 + probe 結果）。
 */
export function checkVideoProbe(probeResult, expected, tolerance = {}) {
  const errors = [];
  const warnings = [];
  if (!probeResult || probeResult.error) {
    return { ok: false, errors: [probeResult && probeResult.error ? probeResult.error : '沒有 probe 結果'], warnings, probe: probeResult || null };
  }
  const fpsTolerance = Number(tolerance.fps) || 0.01;
  const durationTolerance = Number(tolerance.duration) || 0.08;
  const video = probeResult.video;
  const audio = probeResult.audio;
  if (!video) {
    errors.push('沒有影像軌');
  } else {
    if (expected.width && video.width !== expected.width) errors.push(`寬度 ${video.width} ≠ ${expected.width}`);
    if (expected.height && video.height !== expected.height) errors.push(`高度 ${video.height} ≠ ${expected.height}`);
    if (video.pixFmt !== 'yuv420p') errors.push(`pix_fmt ${video.pixFmt} ≠ yuv420p`);
    if (video.codec !== 'h264') errors.push(`影像編碼 ${video.codec} ≠ h264`);
    if (expected.frames && video.frames !== expected.frames) {
      errors.push(`幀數 ${video.frames} ≠ ${expected.frames}`);
    }
    if (expected.fps && Math.abs((video.fps || 0) - expected.fps) > fpsTolerance) {
      errors.push(`fps ${video.fps} ≠ ${expected.fps}`);
    }
  }
  if (!audio) {
    // --no-audio 時本來就沒有音軌；只有「要求音軌」時才算錯
    if (expected.requireAudio !== false) errors.push('沒有音軌');
  } else {
    if (audio.codec !== 'aac') errors.push(`音訊編碼 ${audio.codec} ≠ aac`);
    if (expected.audioSeconds) {
      const actual = audio.duration || probeResult.duration || 0;
      if (Math.abs(actual - expected.audioSeconds) > durationTolerance) {
        errors.push(`音訊長度 ${actual.toFixed(3)}s ≠ ${expected.audioSeconds.toFixed(3)}s`);
      }
    }
  }
  if (expected.seconds && probeResult.duration) {
    if (Math.abs(probeResult.duration - expected.seconds) > durationTolerance) {
      warnings.push(`容器長度 ${probeResult.duration.toFixed(3)}s ≠ 預期 ${expected.seconds.toFixed(3)}s`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, probe: probeResult };
}

export { COMMON_WINDOWS };
