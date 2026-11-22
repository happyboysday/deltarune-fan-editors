/**
 * tests/record/t-audio.mjs — 事件表 → 混音計畫（tools/record/audio.js 純函式）
 *
 * 這裡驗的是「時間計算」本身：BGM 段落收束、loopStart/loopEnd 的循環切法、
 * 音效疊加時間、去重、ffmpeg 參數。全部不開 Edge、不跑 ffmpeg。
 */

import { group, test, ok, eq, notEq, approx } from '../engine/harness.mjs';
import {
  AUDIO_DEFAULTS,
  assetUrlPath,
  bgmInputSpecs,
  buildMixPlan,
  buildMp4Command,
  buildWavCommand,
  collectAudioFiles,
  dedupeSfx,
  outputSize,
  planBgmSegments,
  planDuration,
  planSfxEvents,
  pngName,
  pngPatternFor,
  seconds,
} from '../../tools/record/audio.js';

group('7) 逐幀錄影：事件表 → 混音時間');

/* ---------------------------------------------------------------- 基本 */

test('seconds() 固定 6 位小數、負數夾到 0', () => {
  eq(seconds(1.5), '1.500000', '1.5');
  eq(seconds(0), '0.000000', '0');
  eq(seconds(-3), '0.000000', '負數');
  eq(seconds(1 / 3), '0.333333', '1/3');
});

test('assetUrlPath() 把 assets 相對路徑轉成 /assets/…', () => {
  eq(assetUrlPath('audio/mus/battle.ogg'), '/assets/audio/mus/battle.ogg', '一般路徑');
  eq(assetUrlPath('audio\\snd\\snd_hurt1.wav'), '/assets/audio/snd/snd_hurt1.wav', '反斜線');
  eq(assetUrlPath('/audio/x.wav'), '/assets/audio/x.wav', '前導斜線');
  eq(assetUrlPath(''), '', '空字串');
});

test('planDuration()：幀數 / fps（+尾巴）', () => {
  eq(planDuration(300), 10, '300 幀 = 10 秒');
  eq(planDuration(298), 298 / 30, '298 幀');
  approx(planDuration(300, { tail: 0.5 }), 10.5, 1e-9, '尾巴');
  eq(planDuration(0), 0, '0 幀');
});

/* -------------------------------------------------------------- BGM 段 */

test('BGM：一筆 play → 延伸到錄影長度', () => {
  const segments = planBgmSegments([{ type: 'bgm', action: 'play', name: 'battle', file: 'audio/mus/battle.ogg', volume: 1, loop: true, frame: 0, t: 0 }], {
    totalSeconds: 33.9,
  });
  eq(segments.length, 1, '一段');
  eq(segments[0].start, 0, '起點 0');
  eq(segments[0].end, 33.9, '終點 = 總長');
  eq(segments[0].duration, 33.9, '長度');
  eq(segments[0].loop, true, '循環');
  eq(segments[0].fadeIn, AUDIO_DEFAULTS.defaultFade, '淡入用預設 0.35');
});

test('BGM：stop 收束段落，fade 由 stop 事件決定', () => {
  const segments = planBgmSegments(
    [
      { type: 'bgm', action: 'play', name: 'battle', file: 'a.ogg', t: 0, fade: 0.35 },
      { type: 'bgm', action: 'stop', name: 'battle', file: 'a.ogg', t: 10, fade: 1.5 },
    ],
    { totalSeconds: 30 },
  );
  eq(segments.length, 1, '一段');
  eq(segments[0].end, 10, 'stop 在 10 秒');
  eq(segments[0].fadeOut, 1.5, '淡出秒數來自 stop');
});

test('BGM：切歌 → 舊曲在切換點結束、新曲接上（淡出用新曲事件的 fade）', () => {
  const segments = planBgmSegments(
    [
      { type: 'bgm', action: 'play', name: 'battle', file: 'a.ogg', t: 0, fade: 0.35 },
      { type: 'bgm', action: 'play', name: 'boss', file: 'b.ogg', t: 12, fade: 0.8, previous: 'battle' },
    ],
    { totalSeconds: 20 },
  );
  eq(segments.length, 2, '兩段');
  eq(segments[0].name, 'battle', '第一段');
  eq(segments[0].end, 12, '第一段在 12 秒結束');
  eq(segments[0].fadeOut, 0.8, '淡出 0.8');
  eq(segments[1].name, 'boss', '第二段');
  eq(segments[1].start, 12, '第二段從 12 秒開始');
  eq(segments[1].switchedFrom, 'battle', '記下切換來源');
});

test('BGM：同名重播不產生第二段（playBgm 對同名不重啟）', () => {
  const segments = planBgmSegments(
    [
      { type: 'bgm', action: 'play', name: 'battle', file: 'a.ogg', t: 0 },
      { type: 'bgm', action: 'play', name: 'battle', file: 'a.ogg', t: 5, restart: true },
    ],
    { totalSeconds: 10 },
  );
  eq(segments.length, 1, '只有一段');
  eq(segments[0].start, 0, '仍是原本的段落');
});

test('BGM：0 長度段落丟掉（同幀 stop）', () => {
  const segments = planBgmSegments(
    [
      { type: 'bgm', action: 'play', name: 'a', file: 'a.ogg', t: 5 },
      { type: 'bgm', action: 'stop', name: 'a', file: 'a.ogg', t: 5, fade: 0 },
    ],
    { totalSeconds: 10 },
  );
  eq(segments.length, 0, '沒有可播段落');
});

test('BGM：事件用 frame 換算秒（fps=30）', () => {
  const segments = planBgmSegments(
    [
      { type: 'bgm', action: 'play', name: 'a', file: 'a.ogg', frame: 60 },
      { type: 'bgm', action: 'stop', name: 'a', file: 'a.ogg', frame: 150 },
    ],
    { totalSeconds: 10 },
  );
  eq(segments.length, 1, '一段');
  approx(segments[0].start, 2, 1e-9, '60 幀 = 2 秒');
  approx(segments[0].end, 5, 1e-9, '150 幀 = 5 秒');
  approx(segments[0].duration, 3, 1e-9, '長度 3 秒');
});

/* ------------------------------------------------------------ 循環切法 */

test('bgmInputSpecs()：沒有 loopEnd → 整首 -stream_loop -1', () => {
  const specs = bgmInputSpecs({ file: 'a.ogg', duration: 26, loop: true }, 0);
  eq(specs.length, 1, '一路輸入');
  eq(specs[0].role, 'loop', '角色 loop');
  eq(specs[0].args.join(' '), '-stream_loop -1', 'ffmpeg 參數');
  eq(specs[0].duration, 26, '長度');
});

test('bgmInputSpecs()：loopStart/loopEnd → 前奏一次 + 區段循環', () => {
  const specs = bgmInputSpecs(
    { file: 'a.ogg', duration: 100, loop: true, loopStart: 30, loopEnd: 40, fileDuration: 75 },
    0,
  );
  eq(specs.length, 2, '前奏 + 循環');
  eq(specs[0].role, 'intro', '前奏');
  eq(specs[0].args.join(' '), '-t 30.000000', '前奏長度 = loopStart');
  eq(specs[0].duration, 30, '前奏 30 秒');
  eq(specs[1].role, 'loop-region', '循環段');
  eq(specs[1].args.join(' '), '-ss 30.000000 -t 10.000000', '只讀區段（循環交給 aloop 濾鏡）');
  eq(specs[1].loopLen, 10, '區段長度 10 秒（aloop 的 size 靠它算）');
  eq(specs[1].duration, 70, '循環段長度 = 100 - 30');
  eq(specs[1].offset, 30, '循環段在段落內 30 秒後才開始');
});

test('bgmInputSpecs()：loopEnd 超過音檔長度 → 退回整首循環', () => {
  const specs = bgmInputSpecs(
    { file: 'a.ogg', duration: 10, loop: true, loopStart: 0, loopEnd: 99, fileDuration: 75 },
    0,
  );
  eq(specs.length, 1, '一路');
  eq(specs[0].role, 'loop', '整首循環');
});

test('bgmInputSpecs()：loop=false → 只播一次', () => {
  const specs = bgmInputSpecs({ file: 'a.ogg', duration: 5, loop: false }, 0);
  eq(specs.length, 1, '一路');
  eq(specs[0].role, 'once', '一次');
  eq(specs[0].args.length, 0, '沒有額外參數');
});

/* -------------------------------------------------------------- 音效 */

test('planSfxEvents()：依時間排序、保留音量、丟掉沒 file 的事件', () => {
  const events = [
    { type: 'sfx', name: 'hurt', file: 'audio/snd/hurt.wav', frame: 60, t: 2, volume: 0.8 },
    { type: 'sfx', name: 'graze', file: 'audio/snd/graze.wav', frame: 30, t: 1, volume: 0.5 },
    { type: 'sfx', name: 'broken' },
    { type: 'mute', value: false, t: 0 },
  ];
  const plan = planSfxEvents(events, { totalSeconds: 10 });
  eq(plan.length, 2, '兩筆音效');
  eq(plan[0].name, 'graze', '較早的在前面');
  eq(plan[1].name, 'hurt', '較晚的在後面');
  eq(plan[1].start, 2, '時間');
  approx(plan[1].volume, 0.8, 1e-9, '音量');
});

test('planSfxEvents()：超過錄影長度的事件丟掉', () => {
  const plan = planSfxEvents([{ type: 'sfx', name: 'late', file: 'a.wav', t: 12 }], { totalSeconds: 10 });
  eq(plan.length, 0, '不混');
});

test('dedupeSfx()：同檔同時間窗只留第一筆（頁面＋引擎各播一次時）', () => {
  const plan = [
    { name: 'hurt', file: 'a.wav', start: 1.0 },
    { name: 'hurt', file: 'a.wav', start: 1.005 },
    { name: 'hurt', file: 'a.wav', start: 1.4 },
    { name: 'graze', file: 'b.wav', start: 1.005 },
  ];
  const out = dedupeSfx(plan, 0.02);
  eq(out.length, 3, '1.005 的重複被去掉');
  eq(out[0].start, 1.0, '留第一筆');
  eq(out[2].file, 'b.wav', '不同檔案不去重');
});

/* ---------------------------------------------------------- 混音計畫 */

test('buildMixPlan()：一段 BGM + 一筆音效 → 兩路輸入、amix 後 alimiter', () => {
  const plan = buildMixPlan({
    bgmSegments: [{ name: 'battle', file: 'mus/battle.ogg', start: 0, end: 10, duration: 10, volume: 1, loop: true, fadeIn: 0.35, fadeOut: 0 }],
    sfxEvents: [{ name: 'hurt', file: 'snd/hurt.wav', start: 2, volume: 1 }],
    bgmDir: 'AUDIO',
    sfxDir: 'AUDIO',
    totalSeconds: 10,
  });
  eq(plan.inputs.length, 2, '兩個輸入');
  eq(plan.inputs[0].kind, 'bgm', '第一個是 BGM');
  eq(plan.inputs[1].kind, 'sfx', '第二個是音效');
  ok(plan.inputArgs.join(' ').includes('-stream_loop -1'), 'BGM 用 -stream_loop -1 循環');
  ok(plan.filter.includes('adelay=2000|2000'), '音效延遲 2 秒（2000ms）');
  ok(plan.filter.includes('afade=t=in'), 'BGM 淡入');
  ok(plan.filter.includes('amix=inputs=3:duration=first'), '兩路混音以全長靜音軌為基準');
  ok(plan.filter.includes('alimiter'), '限幅避免破音');
  ok(plan.filter.endsWith('[aout]'), '輸出標籤 aout');
  eq(plan.duration, 10, '長度');
});

test('buildMixPlan()：只有音效也能混（沒有 BGM）', () => {
  const plan = buildMixPlan({
    bgmSegments: [],
    sfxEvents: [
      { name: 'a', file: 'snd/a.wav', start: 0.5, volume: 1 },
      { name: 'b', file: 'snd/b.wav', start: 1.5, volume: 0.5 },
    ],
    bgmDir: 'AUDIO',
    sfxDir: 'AUDIO',
    totalSeconds: 3,
  });
  eq(plan.inputs.length, 2, '兩路');
  eq(plan.inputs.every((item) => item.kind === 'sfx'), true, '都是音效');
  ok(plan.filter.includes('volume=0.5000'), '第二筆音量 0.5');
});

test('buildMixPlan()：沒有任何事件 → 丟錯（呼叫端改出靜音軌）', () => {
  let error = null;
  try {
    buildMixPlan({ bgmSegments: [], sfxEvents: [], totalSeconds: 5 });
  } catch (err) {
    error = err;
  }
  ok(error, '應該丟錯');
  ok(/沒有任何音訊事件/.test(error.message), `錯誤訊息應說明沒有事件，實際：${error && error.message}`);
});

test('buildMixPlan()：loopStart/loopEnd 的音檔會產生前奏與循環兩路', () => {
  const plan = buildMixPlan({
    bgmSegments: [
      {
        name: 'boss',
        file: 'mus/boss.ogg',
        start: 0,
        end: 20,
        duration: 20,
        volume: 1,
        loop: true,
        loopStart: 5,
        loopEnd: 15,
        fileDuration: 40,
        fadeIn: 0,
        fadeOut: 0,
      },
    ],
    sfxEvents: [],
    bgmDir: 'AUDIO',
    sfxDir: 'AUDIO',
    totalSeconds: 20,
  });
  eq(plan.inputs.length, 2, '前奏 + 循環兩路');
  const args = plan.inputArgs.join(' ');
  ok(args.includes('-t 5.000000'), '前奏 5 秒');
  ok(args.includes('-ss 5.000000'), '循環從 5 秒開始');
  ok(args.includes('-t 10.000000'), '循環段 10 秒');
  // 區段無限重播靠 aloop 濾鏡（-t 會限制總讀取長度，不能配 -stream_loop）
  ok(plan.filter.includes('aloop=loop=-1:size='), '循環段用 aloop 無限重播');
  // 循環區段長度 = loopEnd - loopStart = 10 秒 → 10 × 44100 個樣本
  ok(plan.filter.includes(`aloop=loop=-1:size=${Math.round(10 * 44100)}`), 'aloop size = 循環區段樣本數（10s × 44100）');
  ok(plan.filter.includes('concat=n=2:v=0:a=1'), '前奏與循環段用 concat 首尾相接（循環段自然在 5 秒後接上）');
  ok(!plan.filter.includes('adelay=5000|5000'), '不再用 adelay 等前奏（整段延後到很晚時會被 ffmpeg 吃掉）');
});

test('buildMixPlan()：同一首有前奏的曲子停了又重播 → 第二段各自開輸入、concat 後才整段延後', () => {
  const seg = (start, end) => ({ name: 'm', file: 'm.ogg', start, end, duration: end - start, volume: 1, loop: true,
    loopStart: 5, loopEnd: 15, fadeIn: 1, fadeOut: 0, fileDuration: 20 });
  const plan = buildMixPlan({ bgmSegments: [seg(0, 100), seg(825, 875)], sfxEvents: [], bgmDir: 'AUDIO', sfxDir: 'AUDIO',
    totalSeconds: 900 });
  eq(plan.inputs.length, 4, '兩段 × 前奏＋循環 = 4 路輸入（不共用 asplit）');
  ok(!plan.filter.includes('asplit'), '沒有 asplit');
  ok(/\[b1_0\]\[b1_1\]concat=n=2:v=0:a=1\[bg1_mix\]/.test(plan.filter), '第二段先 concat');
  ok(plan.filter.includes('adelay=825000|825000'), '第二段整段延後到 825 秒');
});

/* ------------------------------------------------------------ ffmpeg 參數 */

test('buildWavCommand()：pcm_s16le、指定取樣率與聲道', () => {
  const plan = { inputArgs: ['-i', 'x.ogg'], filter: '[0:a]anull[aout]', duration: 5 };
  const command = buildWavCommand(plan, 'out.wav', { sampleRate: 44100, channels: 2, filterFile: 'mix.ffgraph' });
  const text = command.args.join(' ');
  ok(text.includes('-/filter_complex mix.ffgraph'), '從檔案載入濾鏡');
  ok(text.includes('-map [aout]'), '映射混音結果');
  ok(text.includes('-c:a pcm_s16le'), '16-bit PCM');
  ok(text.includes('-ar 44100'), '取樣率');
  ok(text.includes('-ac 2'), '聲道');
  eq(command.duration, 5, '長度');
});

test('repeated SFX do not increase the ffmpeg command line', () => {
  const events = Array.from({ length: 2000 }, (_, i) => ({ file: 'voice.wav', start: i / 15, volume: 1 }));
  const build = (sfxEvents) => buildMixPlan({ sfxEvents, totalSeconds: 148.4 });
  const options = { filterFile: 'mix.ffgraph' };
  const long = build(events);
  eq(long.inputs.length, 1);
  ok(long.filter.length > 32767);
  eq(buildWavCommand(long, 'out.wav', options).args.join(' '),
    buildWavCommand(build(events.slice(0, 1)), 'out.wav', options).args.join(' '));
});

test('buildWavCommand()：缺計畫 / 缺輸出 → 丟錯', () => {
  let a = null;
  let b = null;
  try {
    buildWavCommand(null, 'x.wav');
  } catch (err) {
    a = err;
  }
  try {
    buildWavCommand({ filter: 'x' }, '');
  } catch (err) {
    b = err;
  }
  ok(a && /混音計畫/.test(a.message), '缺計畫要有訊息');
  ok(b && /WAV 輸出路徑/.test(b.message), '缺輸出路徑要有訊息');
});

test('buildMp4Command()：H.264 yuv420p + AAC + 30fps', () => {
  const command = buildMp4Command({ pngPattern: 'frames/f%04d.png', wav: 'audio.wav', output: 'out.mp4', fps: 30 });
  const text = command.args.join(' ');
  ok(text.includes('-framerate 30'), '輸入 30fps');
  ok(text.includes('-i frames/f%04d.png'), 'PNG 序列');
  ok(text.includes('-i audio.wav'), '音軌');
  ok(text.includes('-c:v libx264'), 'H.264');
  ok(text.includes('-pix_fmt yuv420p'), 'yuv420p');
  ok(text.includes('-r 30'), '輸出 30fps');
  ok(text.includes('-c:a aac'), 'AAC');
  ok(text.includes('-movflags +faststart'), 'faststart');
  eq(command.hasAudio, true, '有音軌');
});

test('buildMp4Command()：沒有 WAV 也能合成（無音軌）', () => {
  const command = buildMp4Command({ pngPattern: 'f%04d.png', output: 'out.mp4' });
  eq(command.hasAudio, false, '無音軌');
  ok(!command.args.join(' ').includes('-c:a'), '不該有音訊編碼參數');
});

/* ------------------------------------------------------- 檔名 / 尺寸 */

test('outputSize()：1×/2×/3× 是 640×480 的整數倍，超出範圍夾住', () => {
  eq(outputSize(1).width, 640, '1× 寬');
  eq(outputSize(1).height, 480, '1× 高');
  eq(outputSize(2).width, 1280, '2× 寬');
  eq(outputSize(2).height, 960, '2× 高');
  eq(outputSize(3).width, 1920, '3× 寬');
  eq(outputSize(3).height, 1440, '3× 高');
  eq(outputSize(9).scale, 3, '上限 3');
  eq(outputSize(0).scale, 1, '下限 1');
});

test('pngName() / pngPatternFor()：ffmpeg image2 序列命名', () => {
  eq(pngName(0), 'f0000.png', '第 0 幀');
  eq(pngName(7), 'f0007.png', '補零');
  eq(pngName(1234), 'f1234.png', '四位數');
  eq(pngPatternFor('C:/tmp/frames'), 'C:/tmp/frames/f%04d.png', '序列樣式');
  eq(pngPatternFor('C:/tmp/frames/'), 'C:/tmp/frames/f%04d.png', '去掉尾斜線');
});

test('collectAudioFiles()：BGM + 音效去重、保序', () => {
  const files = collectAudioFiles(
    [
      { file: 'mus/battle.ogg' },
      { file: 'mus/boss.ogg' },
    ],
    [
      { file: 'snd/hurt.wav' },
      { file: 'mus/battle.ogg' },
      { file: 'snd/hurt.wav' },
    ],
  );
  eq(files.join(','), 'mus/battle.ogg,mus/boss.ogg,snd/hurt.wav', '去重且保序');
});

test('整合：rudinn 風格事件表（1 BGM + 36 音效）→ 時間與路數正確', () => {
  const events = [{ type: 'bgm', action: 'play', name: 'battle', file: 'audio/mus/battle.ogg', frame: 0, t: 0, volume: 1, loop: true, fade: 0.35 }];
  for (let i = 0; i < 36; i += 1) {
    events.push({ type: 'sfx', name: `snd_${i}`, file: `audio/snd/snd_${i}.wav`, frame: i * 30, t: i, volume: 1 });
  }
  const totalSeconds = 33.9;
  const bgmSegments = planBgmSegments(events, { totalSeconds, fileDurations: { 'audio/mus/battle.ogg': 75.43 } });
  const sfxEvents = dedupeSfx(planSfxEvents(events, { totalSeconds }));
  eq(bgmSegments.length, 1, '一段 BGM');
  eq(bgmSegments[0].end, totalSeconds, 'BGM 撐滿全長');
  // t = 0..35 秒，錄影 33.9 秒 → t ≤ 33.9 的 34 筆留著，34/35 兩筆在片尾之後丟掉
  eq(sfxEvents.length, 34, '36 筆中 t>33.9 的 2 筆被丟掉');
  const plan = buildMixPlan({
    bgmSegments,
    sfxEvents,
    bgmDir: 'A',
    sfxDir: 'A',
    totalSeconds,
  });
  eq(plan.inputs.length, 35, '1 + 34 路輸入');
  eq(plan.inputs.filter((item) => item.kind === 'bgm').length, 1, '一路 BGM');
  ok(plan.filter.includes('amix=inputs=36:duration=first'), '35 路混音加上固定長度的靜音基準');
});
