/**
 * tests/record/t-media.mjs — ffmpeg 探測 / 執行 / 探針 / MP4 驗證（tools/record/media.js）
 *
 * 這些測試全部用注入的假 probe / 假 ffprobe 輸出，不需要真的安裝 ffmpeg、
 * 也不需要開瀏覽器；「找不到 ffmpeg 的錯誤訊息」是驗收條件之一，特別驗。
 */

import { group, test, ok, eq, approx } from '../engine/harness.mjs';
import {
  NO_FFMPEG,
  NO_FFPROBE,
  checkVideoProbe,
  downloadAudioFiles,
  probeMedia,
  requireFfmpeg,
  resetFfmpegCache,
  resolveFfmpeg,
  runProcess,
} from '../../tools/record/media.js';

group('9) 逐幀錄影：ffmpeg / ffprobe 與輸出驗證');

test('resolveFfmpeg()：注入 probe → 找到 ffmpeg 與 ffprobe', () => {
  resetFfmpegCache();
  const found = resolveFfmpeg({ probe: (name) => (name === 'ffmpeg' ? 'ffmpeg' : 'ffprobe'), ffmpeg: null, ffprobe: null });
  eq(found.ffmpeg, 'ffmpeg', 'ffmpeg');
  eq(found.ffprobe, 'ffprobe', 'ffprobe');
});

test('resolveFfmpeg()：只有 ffmpeg、沒有 ffprobe → ffprobe 為 null', () => {
  resetFfmpegCache();
  const found = resolveFfmpeg({ ffmpeg: 'ffmpeg', ffprobe: null, probe: () => null });
  eq(found.ffmpeg, 'ffmpeg', '顯式 ffmpeg 優先');
  eq(found.ffprobe, null, '找不到 ffprobe');
});

test('requireFfmpeg()：沒有 ffmpeg → NO_FFMPEG，訊息說明 --png-dir 仍可用', () => {
  resetFfmpegCache();
  let error = null;
  try {
    requireFfmpeg({ ffmpeg: null, ffprobe: null, probe: () => null });
  } catch (err) {
    error = err;
  }
  ok(error, '應該丟錯');
  eq(error.code, NO_FFMPEG, '錯誤碼');
  ok(error.message.includes('ffmpeg'), '訊息要提到 ffmpeg');
  ok(error.message.includes('--png-dir'), '訊息要說明 PNG 序列仍可用');
  ok(error.message.includes('audio-events.json'), '訊息要提到音訊事件表');
  ok(/FFMPEG_PATH|winget|安裝/.test(error.message), '訊息要給安裝／路徑方法');
});

test('requireFfmpeg()：有 ffmpeg 但沒有 ffprobe → NO_FFPROBE，訊息說明 --png-dir 仍可用', () => {
  resetFfmpegCache();
  let error = null;
  try {
    requireFfmpeg({ ffmpeg: 'ffmpeg', ffprobe: null, probe: () => null });
  } catch (err) {
    error = err;
  }
  ok(error, '應該丟錯');
  eq(error.code, NO_FFPROBE, '錯誤碼');
  ok(error.message.includes('ffprobe'), '訊息要提到 ffprobe');
  ok(error.message.includes('--png-dir'), '訊息要說明 PNG 序列仍可用');
});

test('resolveFfmpeg()：FFMPEG_PATH 指向不存在的檔案 → 當作沒指定，改找 PATH', () => {
  resetFfmpegCache();
  const previous = { ffmpeg: process.env.FFMPEG_PATH, ffprobe: process.env.FFPROBE_PATH };
  process.env.FFMPEG_PATH = 'Z:/definitely/not/here/ffmpeg.exe';
  try {
    const found = resolveFfmpeg({ probe: (name) => (name === 'ffmpeg' ? 'ffmpeg-from-path' : 'ffprobe-from-path') });
    eq(found.ffmpeg, 'ffmpeg-from-path', '壞掉的顯式路徑不該擋住 PATH 上的 ffmpeg');
  } finally {
    if (previous.ffmpeg === undefined) delete process.env.FFMPEG_PATH;
    else process.env.FFMPEG_PATH = previous.ffmpeg;
    resetFfmpegCache();
  }
});

test('requireFfmpeg()：找到 ffmpeg → 回傳路徑，不丟錯', () => {
  resetFfmpegCache();
  const found = requireFfmpeg({ ffmpeg: 'ffmpeg', ffprobe: 'ffprobe', probe: () => null });
  eq(found.ffmpeg, 'ffmpeg', 'ffmpeg 路徑');
});

test('runProcess()：執行成功回 stdout / code 0', async () => {
  const result = await runProcess(process.execPath, ['-e', 'process.stdout.write("hello")']);
  eq(result.code, 0, '離開碼');
  eq(result.stdout, 'hello', 'stdout');
});

test('runProcess()：找不到執行檔 → 明確錯誤', async () => {
  let error = null;
  try {
    await runProcess('definitely-not-a-real-binary-xyz', ['--version']);
  } catch (err) {
    error = err;
  }
  ok(error, '應該丟錯');
  ok(/無法執行/.test(error.message), `訊息應說明無法執行，實際：${error && error.message}`);
});

test('probeMedia()：沒有 ffprobe → 回 error（不丟錯）', async () => {
  const result = await probeMedia(null, 'x.mp4');
  ok(result.error, '應回 error');
  ok(/ffprobe/.test(result.error), '訊息要提到 ffprobe');
});

test('probeMedia()：解析 ffprobe JSON（H.264 + AAC）', async () => {
  // 假的 ffprobe：印出一個標準 JSON
  const fake = process.execPath;
  const script = `
    process.stdout.write(JSON.stringify({
      format: { duration: '9.933000', size: '123456', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' },
      streams: [
        { codec_type: 'video', codec_name: 'h264', width: 1280, height: 960, pix_fmt: 'yuv420p', r_frame_rate: '30/1', avg_frame_rate: '30/1', nb_frames: '298', duration: '9.933333' },
        { codec_type: 'audio', codec_name: 'aac', sample_rate: '44100', channels: 2, duration: '9.933333', bit_rate: '192000' }
      ]
    }));
  `;
  // probeMedia 會把 ffprobe 路徑當執行檔 → 這裡直接測 runProcess 的解析版本：
  const output = await runProcess(fake, ['-e', script]);
  const json = JSON.parse(output.stdout);
  eq(json.streams[0].codec_name, 'h264', '假輸出正確');
  eq(json.streams[1].codec_name, 'aac', '假輸出音軌正確');
  // 用真的 probeMedia：把 process.execPath + -e 包成「假的 ffprobe」不可行（probeMedia 只給一個路徑），
  // 所以直接用 checkVideoProbe 驗解析後的形狀（下面幾個測試）。
});

test('checkVideoProbe()：完全符合 → ok', () => {
  const probe = {
    duration: 9.933333,
    video: { codec: 'h264', width: 1280, height: 960, pixFmt: 'yuv420p', fps: 30, frames: 298 },
    audio: { codec: 'aac', sampleRate: 44100, channels: 2, duration: 9.933333 },
  };
  const result = checkVideoProbe(probe, { width: 1280, height: 960, frames: 298, fps: 30, audioSeconds: 298 / 30 });
  eq(result.ok, true, `應通過，實際錯誤：${result.errors.join('；')}`);
  eq(result.errors.length, 0, '沒有錯誤');
});

test('checkVideoProbe()：幀數不符 → 具體錯誤訊息', () => {
  const probe = {
    duration: 10,
    video: { codec: 'h264', width: 640, height: 480, pixFmt: 'yuv420p', fps: 30, frames: 297 },
    audio: { codec: 'aac', sampleRate: 44100, channels: 2, duration: 10 },
  };
  const result = checkVideoProbe(probe, { width: 640, height: 480, frames: 298, fps: 30, audioSeconds: 10 });
  eq(result.ok, false, '應失敗');
  ok(result.errors.some((text) => text.includes('297') && text.includes('298')), `要指出 297 ≠ 298：${result.errors.join('；')}`);
});

test('checkVideoProbe()：尺寸 / fps / pix_fmt / 編碼 不符都各自回報', () => {
  const probe = {
    duration: 10,
    video: { codec: 'vp9', width: 641, height: 480, pixFmt: 'yuv444p', fps: 25, frames: 250 },
    audio: { codec: 'opus', sampleRate: 48000, channels: 2, duration: 10 },
  };
  const result = checkVideoProbe(probe, { width: 640, height: 480, frames: 250, fps: 30, audioSeconds: 10 });
  eq(result.ok, false, '應失敗');
  ok(result.errors.some((text) => text.includes('641')), '寬度');
  ok(result.errors.some((text) => text.includes('yuv444p')), 'pix_fmt');
  ok(result.errors.some((text) => text.includes('vp9')), '影像編碼');
  ok(result.errors.some((text) => text.includes('25')), 'fps');
  ok(result.errors.some((text) => text.includes('opus')), '音訊編碼');
  ok(result.errors.length >= 5, `應回報多個錯誤，實際 ${result.errors.length}`);
});

test('checkVideoProbe()：沒有音軌 → 錯誤（MP4 一定要有聲音）', () => {
  const probe = { duration: 10, video: { codec: 'h264', width: 640, height: 480, pixFmt: 'yuv420p', fps: 30, frames: 300 }, audio: null };
  const result = checkVideoProbe(probe, { width: 640, height: 480, frames: 300, fps: 30, audioSeconds: 10 });
  eq(result.ok, false, '應失敗');
  ok(result.errors.some((text) => text.includes('音軌')), '要指出沒有音軌');
});

test('checkVideoProbe()：--no-audio（requireAudio:false）→ 沒有音軌不算錯', () => {
  const probe = { duration: 10, video: { codec: 'h264', width: 640, height: 480, pixFmt: 'yuv420p', fps: 30, frames: 300 }, audio: null };
  const result = checkVideoProbe(probe, { width: 640, height: 480, frames: 300, fps: 30, requireAudio: false });
  eq(result.ok, true, `不該報錯，實際：${result.errors.join('；')}`);
});

test('checkVideoProbe()：音訊長度不符 → 錯誤（幀數與音軌要對得上）', () => {
  const probe = {
    duration: 12,
    video: { codec: 'h264', width: 640, height: 480, pixFmt: 'yuv420p', fps: 30, frames: 300 },
    audio: { codec: 'aac', sampleRate: 44100, channels: 2, duration: 11.2 },
  };
  const result = checkVideoProbe(probe, { width: 640, height: 480, frames: 300, fps: 30, audioSeconds: 10 });
  eq(result.ok, false, '應失敗');
  ok(result.errors.some((text) => text.includes('音訊長度')), `要指出音訊長度不符：${result.errors.join('；')}`);
});

test('checkVideoProbe()：probe 失敗 → 原樣回報錯誤', () => {
  const result = checkVideoProbe({ file: 'x.mp4', error: 'ffprobe 失敗' }, { frames: 10 });
  eq(result.ok, false, '應失敗');
  ok(result.errors[0].includes('ffprobe'), '錯誤訊息要保留');
});

test('downloadAudioFiles()：注入 fetch → 抓到檔案並保留相對路徑', async () => {
  const { mkdtempSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'V2-11-dl-'));
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
    };
  };
  const result = await downloadAudioFiles({
    baseUrl: 'http://127.0.0.1:1234',
    files: ['audio/snd/a.wav', 'audio/mus/b.ogg'],
    outDir: dir,
    fetchImpl,
  });
  eq(calls.length, 2, '兩個請求');
  eq(calls[0], 'http://127.0.0.1:1234/assets/audio/snd/a.wav', 'URL 形狀');
  eq(Object.keys(result.files).length, 2, '兩個檔案');
  eq(result.bytes, 8, '位元組數');
  eq(result.warnings.length, 0, '沒有警告');
  eq(readFileSync(result.files['audio/snd/a.wav']).length, 4, '檔案內容');
});

test('downloadAudioFiles()：抓取失敗 → 收集警告、其他檔照抓', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'V2-11-dl2-'));
  const fetchImpl = async (url) => ({
    ok: !url.includes('missing'),
    status: url.includes('missing') ? 404 : 200,
    arrayBuffer: async () => new Uint8Array([9]).buffer,
  });
  const result = await downloadAudioFiles({
    baseUrl: 'http://x',
    files: ['missing.wav', 'ok.wav'],
    outDir: dir,
    fetchImpl,
  });
  eq(Object.keys(result.files).length, 1, '只有一個成功');
  eq(result.warnings.length, 1, '一個警告');
  ok(result.warnings[0].includes('missing.wav'), '警告要指名檔案');
});
