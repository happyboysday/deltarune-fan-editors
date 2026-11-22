/**
 * tests/record/run.mjs — 逐幀錄影（V2-11）單元測試入口
 *
 * 執行：cd battle-editor && node tests/record/run.mjs
 *
 * 這裡只跑「不需要 Edge、不需要 ffmpeg」的純函式測試：
 *   t-audio.mjs  事件表 → 混音時間計算、BGM 循環、ffmpeg 參數、檔名/尺寸
 *   t-cli.mjs    命令列參數解析、預設值、驗證訊息、--help 內容
 *   t-media.mjs  ffmpeg/ffprobe 探測、無 ffmpeg 的錯誤訊息、MP4 驗證
 *   t-e2e.mjs    （可選）真的錄一段短片並用 ffprobe 驗證；沒 Edge/ffmpeg 會 skip
 */

import { group, test, ok, run, summary } from '../engine/harness.mjs';

group('環境檢查');

test('Node 環境可載入錄影模組（無 DOM 依賴）', async () => {
  const audio = await import('../../tools/record/audio.js');
  const cli = await import('../../tools/record/cli.js');
  const media = await import('../../tools/record/media.js');
  ok(typeof audio.buildMixPlan === 'function', 'audio.buildMixPlan');
  ok(typeof cli.parseRecordArgs === 'function', 'cli.parseRecordArgs');
  ok(typeof media.requireFfmpeg === 'function', 'media.requireFfmpeg');
  ok(typeof globalThis.document === 'undefined', '純函式模組不該需要 document');
});

await import('./t-audio.mjs');
await import('./t-cli.mjs');
await import('./t-media.mjs');
await import('./t-engine-log.mjs');

const result = await run();
summary();
if (result.fail > 0) process.exitCode = 1;
