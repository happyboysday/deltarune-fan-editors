/**
 * tests/record/t-cli.mjs — tools/record/cli.js 的參數解析 / 驗證 / 用法
 *
 * 這裡不開 Edge、不跑 ffmpeg：只驗「命令列 → 選項」的對應與預設值，
 * 以及文件（--help）與實作是否一致。
 */

import { group, test, ok, eq } from '../engine/harness.mjs';
import { parseArgs } from '../../tools/agent/lib.mjs';
import {
  BOOLEAN_FLAGS,
  DEFAULTS,
  RECORD_FPS,
  USAGE,
  VALUE_FLAGS,
  parseCapture,
  parseRecordArgs,
  validateRecordOptions,
} from '../../tools/record/cli.js';

/** 模擬 CLI：parseArgs(argv, valueFlags) → parseRecordArgs()
 *  只傳值型別旗標：布林旗標若也列進 valueFlags，parseArgs 會把下一個參數當成它的值
 *  （`--verify --json` 會讓 verify = '--json'、json 消失），與 tools/record.mjs 一致。 */
function parseArgv(argv, context = {}) {
  return parseRecordArgs(parseArgs(argv, VALUE_FLAGS), context);
}

group('8) 逐幀錄影：命令列參數');

test('parseRecordArgs()：全部旗標 → 選項', () => {
  const options = parseArgv([
    'samples/spade-rain.json',
    '--autoplay',
    'demo',
    '--scale',
    '2',
    '--out',
    'out/x.mp4',
    '--png-dir',
    'frames',
    '--wav',
    'out/x.wav',
    '--lang',
    'en',
    '--seed',
    '42',
    '--max-frames',
    '120',
    '--preset',
    'slow',
    '--crf',
    '20',
    '--verify',
    '--json',
  ]);
  eq(options.input, 'samples/spade-rain.json', '位置參數 = 作品檔');
  eq(options.autoplay, 'demo', 'autoplay');
  eq(options.scale, 2, 'scale');
  eq(options.out, 'out/x.mp4', 'out');
  eq(options.pngDir, 'frames', 'pngDir');
  eq(options.wav, 'out/x.wav', 'wav');
  eq(options.lang, 'en', 'lang');
  eq(options.seed, 42, 'seed');
  eq(options.maxFrames, 120, 'maxFrames');
  eq(options.preset, 'slow', 'preset');
  eq(options.crf, 20, 'crf');
  eq(options.verify, true, 'verify');
  eq(options.json, true, 'json');
  eq(options.fps, RECORD_FPS, 'fps 固定 30');
});

test('parseRecordArgs()：--k=v 形式等價 --k v', () => {
  const options = parseArgv(['a.json', '--autoplay=bot', '--scale=3', '--max-frames=90']);
  eq(options.autoplay, 'bot', 'autoplay');
  eq(options.scale, 3, 'scale');
  eq(options.maxFrames, 90, 'maxFrames');
});

test('parseRecordArgs()：預設值（攻擊）', () => {
  const options = parseArgv(['a.json', '--out', 'x.mp4']);
  eq(options.autoplay, null, '預設不自動演示');
  eq(options.scale, DEFAULTS.scale, '預設 scale 2');
  eq(options.lang, 'zh', '預設中文');
  eq(options.maxFrames, null, '類型未知 → null，由 record() 依類型套 900／3600');
  eq(parseRecordArgs({ _: ['a.json'] }, { kind: 'attack' }).maxFrames, DEFAULTS.attackMaxFrames, '攻擊預設 maxFrames');
  eq(parseRecordArgs({ _: ['a.json'] }, { kind: 'encounter' }).maxFrames, DEFAULTS.encounterMaxFrames, '遭遇預設 maxFrames');
  eq(options.preset, DEFAULTS.preset, '預設 preset');
  eq(options.crf, DEFAULTS.crf, '預設 crf');
  eq(options.seed, null, '預設不改 seed');
  eq(options.capture, 'screenshot', '預設擷取方式：screenshot（與 render.mjs 同路徑）');
});

test('parseRecordArgs()：遭遇的 maxFrames 預設較大', () => {
  const options = parseArgv(['enc.json', '--out', 'x.mp4'], { kind: 'encounter' });
  eq(options.maxFrames, DEFAULTS.encounterMaxFrames, '遭遇預設 maxFrames');
  ok(options.maxFrames > DEFAULTS.attackMaxFrames, '遭遇比攻擊長');
});

test('parseRecordArgs()：scale 夾在 1–3、maxFrames 至少 1', () => {
  eq(parseArgv(['a.json', '--out', 'x.mp4', '--scale', '9']).scale, 3, 'scale 上限');
  eq(parseArgv(['a.json', '--out', 'x.mp4', '--scale', '0']).scale, 1, 'scale 下限');
  eq(parseArgv(['a.json', '--out', 'x.mp4', '--max-frames', '0']).maxFrames, 1, 'maxFrames 下限');
  eq(parseArgv(['a.json', '--out', 'x.mp4', '--crf', '99']).crf, 51, 'crf 上限');
  eq(parseArgv(['a.json', '--out', 'x.mp4', '--crf', '-5']).crf, 0, 'crf 下限');
});

test('parseRecordArgs()：--autoplay off / 非法值 → 不自動演示', () => {
  eq(parseArgv(['a.json', '--out', 'x.mp4', '--autoplay', 'off']).autoplay, null, 'off');
  eq(parseArgv(['a.json', '--out', 'x.mp4', '--autoplay', 'weird']).autoplay, null, '非法值');
  eq(parseArgv(['a.json', '--out', 'x.mp4']).autoplay, null, '未指定');
});

test('parseRecordArgs()：--lang 非 en 一律 zh', () => {
  eq(parseArgv(['a.json', '--out', 'x.mp4', '--lang', 'en']).lang, 'en', 'en');
  eq(parseArgv(['a.json', '--out', 'x.mp4', '--lang', 'zh']).lang, 'zh', 'zh');
  eq(parseArgv(['a.json', '--out', 'x.mp4', '--lang', 'fr']).lang, 'zh', '其他 → zh');
});

test('parseRecordArgs()：--no-audio / --keep-frames / --quiet 布林旗標', () => {
  const options = parseArgv(['a.json', '--out', 'x.mp4', '--no-audio', '--keep-frames', '--quiet']);
  eq(options.noAudio, true, 'noAudio');
  eq(options.keepFrames, true, 'keepFrames');
  eq(options.quiet, true, 'quiet');
});

test('parseCapture()：screenshot / canvas 兩種模式與別名', () => {
  eq(parseCapture('screenshot'), 'screenshot', 'screenshot');
  eq(parseCapture('shot'), 'screenshot', 'shot');
  eq(parseCapture('cdp'), 'screenshot', 'cdp');
  eq(parseCapture('render'), 'screenshot', 'render');
  eq(parseCapture('canvas'), 'canvas', 'canvas');
  eq(parseCapture('dataurl'), 'canvas', 'dataurl');
  eq(parseCapture(undefined), 'screenshot', '未指定 → 預設 screenshot');
  eq(parseCapture('weird'), 'screenshot', '未知值 → 預設');
  eq(parseCapture('weird', 'canvas'), 'canvas', '未知值 → 自訂 fallback');
});

test('validateRecordOptions()：合法組合回 null', () => {
  eq(validateRecordOptions({ input: 'a.json', out: 'x.mp4', fps: 30, scale: 2 }), null, 'mp4');
  eq(validateRecordOptions({ input: 'a.json', pngDir: 'frames', fps: 30 }), null, 'png 序列');
  eq(validateRecordOptions({ input: 'a.json', wav: 'x.wav', fps: 30 }), null, 'wav');
});

test('validateRecordOptions()：沒有輸出 → 明確要求至少一種', () => {
  const message = validateRecordOptions({ input: 'a.json', out: null, pngDir: null, wav: null, fps: 30 });
  ok(message && /至少/.test(message), `應提示至少一種輸出，實際：${message}`);
  ok(message.includes('--out') && message.includes('--png-dir') && message.includes('--wav'), '要列出三種輸出旗標');
});

test('validateRecordOptions()：fps 不是 30 → 明確拒絕（逐幀錄影固定 30）', () => {
  const message = validateRecordOptions({ input: 'a.json', out: 'x.mp4', fps: 60 });
  ok(message && message.includes('30'), `應說明固定 30fps，實際：${message}`);
  ok(/1\/30|固定 30/.test(message), '要說明原因（引擎步進 1/30 秒）');
});

test('validateRecordOptions()：副檔名錯誤 → 明確訊息', () => {
  ok(/mp4/.test(validateRecordOptions({ input: 'a.json', out: 'x.mkv', fps: 30 }) || ''), 'out 要 .mp4');
  ok(/wav/.test(validateRecordOptions({ input: 'a.json', wav: 'x.mp3', fps: 30 }) || ''), 'wav 要 .wav');
});

test('VALUE_FLAGS / BOOLEAN_FLAGS：涵蓋文件列出的所有旗標', () => {
  const flags = new Set([...VALUE_FLAGS, ...BOOLEAN_FLAGS]);
  for (const name of ['autoplay', 'scale', 'out', 'png-dir', 'wav', 'lang', 'seed', 'max-frames', 'works', 'root', 'verify', 'json', 'help', 'capture']) {
    ok(flags.has(name), `缺少旗標 ${name}`);
  }
  // 值型別旗標不能同時是布林旗標（parseArgs 會吃掉下一個參數）
  for (const name of BOOLEAN_FLAGS) {
    ok(!VALUE_FLAGS.includes(name), `${name} 同時列在 valueFlags 與 booleanFlags`);
  }
});

test('USAGE：列出所有旗標與兩個範例', () => {
  for (const name of ['--autoplay', '--scale', '--out', '--png-dir', '--wav', '--lang', '--seed', '--max-frames', '--capture', '--works', '--root']) {
    ok(USAGE.includes(name), `用法文字缺少 ${name}`);
  }
  ok(USAGE.includes('node tools/record.mjs samples/spade-rain.json'), '缺少攻擊範例');
  ok(USAGE.includes('node tools/record.mjs samples/encounters/rudinn.json'), '缺少遭遇範例');
  ok(USAGE.includes('docs/RECORD.md') || USAGE.includes('逐幀錄影'), '缺少用途說明');
});
