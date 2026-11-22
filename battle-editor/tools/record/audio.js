/**
 * tools/record/audio.js — 逐幀錄影（V2-11）的音訊規劃與 ffmpeg 混音
 *
 * 為什麼要放純函式：
 *   事件表 → 「哪個音檔、從第幾秒播到第幾秒、音量多少、怎麼循環」的計算最容易
 *   出錯，但完全不需要瀏覽器也能算。tools/record.mjs 只負責抓事件；這裡負責把
 *   事件表變成 ffmpeg 可吃的輸入（`-stream_loop` / `-ss` / `atrim` / `afade`），
 *   測試（tests/record/**）直接 import 這支，不必開 Edge。
 *
 * 音訊來源一律是伺服器上的實際音檔：事件表帶 `file`（相對 assets/ 的路徑，例如
 * `audio/mus/battle.ogg`），錄影工具用 HTTP 抓下來放進暫存目錄再交給 ffmpeg
 * （避免 ffmpeg 直接讀 repo 造成鎖檔／路徑編碼問題）。
 *
 * 為什麼不把整段音樂先 decode 成 PCM 自己算：
 *   ffmpeg 的 filter graph 已經處理 resample / 循環 / 淡入淡出 / 延遲，重寫一份
 *   PCM 混音器只會多一份會壞的實作；這裡的工作是「產生正確的參數」與「驗證」。
 */

/** 混音預設值（文件與測試共用）。 */
export const AUDIO_DEFAULTS = Object.freeze({
  sampleRate: 44100,
  channels: 2,
  /** 影片 / 音訊統一 30 fps（ROADMAP-V2 §1：逐幀錄影 30 fps）。 */
  fps: 30,
  /** BGM 沒標 loopStart 時的循環起點（秒）。 */
  loopStartFallback: 0,
  /** 淡入淡出最短秒數（避免 0 長度的 afade）。 */
  minFade: 0.01,
  /** BGM 預設淡入（audio.js playBgm 的 fade 預設 0.35）。 */
  defaultFade: 0.35,
  /** 解碼長度容忍值：ffprobe 量到的音檔長度與事件表估算差超過這個值只提醒。 */
  durationTolerance: 0.5,
});

/* ------------------------------------------------------------ 小工具 */

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value) {
  return Math.max(0, Math.min(1, num(value, 1)));
}

/** 秒 → ffmpeg 參數文字（固定 6 位小數，避免浮點誤差）。 */
export function seconds(value) {
  return Math.max(0, num(value, 0)).toFixed(6);
}

/** 音檔案從 assets/ 以來的相對路徑 → 伺服器 URL 路徑。 */
export function assetUrlPath(file) {
  const rel = String(file || '').replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) return '';
  return `/assets/${rel}`;
}

/** 由 ffprobe / 事件表取音檔長度（秒）；未知回 null。 */
export function fileDuration(entry) {
  const value = Number(entry && entry.duration);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/* ------------------------------------------------------ 事件表 → BGM 段 */

/**
 * BGM 事件配對成段落：
 *   [{ name, file, start, end, duration, volume, loop, loopStart, loopEnd,
 *      fadeIn, fadeOut, switchedFrom, fileDuration }]
 *
 * `start` / `end` 是秒（= frame / fps）。收束規則：
 *   - `action:'stop'` → 目前曲在該秒結束（淡出 = 該筆 fade）。
 *   - `action:'play'` 且曲名不同 → 舊曲在同一刻結束（淡出 = 該筆 fade）。
 *   - 沒收到結束事件的段落延伸到 `totalSeconds`（錄影長度）。
 *   - `end <= start` 的段落丟掉（0 長度沒有聲音）。
 */
export function planBgmSegments(events, options = {}) {
  const totalSeconds = Math.max(0, num(options.totalSeconds, 0));
  const durations = options.fileDurations && typeof options.fileDurations === 'object' ? options.fileDurations : {};
  const segments = [];
  let active = null;

  const closeSegment = (atSeconds, fadeOut) => {
    if (!active) return;
    const end = Math.max(active.start, num(atSeconds, active.start));
    if (end - active.start > 0.0005) {
      segments.push({ ...active, end, duration: end - active.start, fadeOut: Math.max(0, num(fadeOut, 0)) });
    }
    active = null;
  };

  const sorted = (Array.isArray(events) ? events : [])
    .filter((event) => event && event.type === 'bgm')
    .map((event, index) => ({ event, index, t: Math.max(0, num(event.t, num(event.frame, 0) / AUDIO_DEFAULTS.fps)) }))
    .sort((a, b) => (a.t === b.t ? a.index - b.index : a.t - b.t));

  for (const { event, t } of sorted) {
    if (event.action === 'stop') {
      closeSegment(t, num(event.fade, 0));
      continue;
    }
    // play（含切歌）：先把上一首收掉（淡出用同一筆的 fade）
    if (active && active.name !== event.name) closeSegment(t, num(event.fade, AUDIO_DEFAULTS.defaultFade));
    if (active && active.name === event.name) continue;
    const fade = Math.max(0, num(event.fade, AUDIO_DEFAULTS.defaultFade));
    active = {
      name: typeof event.name === 'string' ? event.name : null,
      file: typeof event.file === 'string' ? event.file : null,
      start: t,
      volume: clamp01(event.volume),
      loop: event.loop !== false,
      loopStart: Number.isFinite(Number(event.loopStart)) ? Math.max(0, Number(event.loopStart)) : null,
      loopEnd: Number.isFinite(Number(event.loopEnd)) ? Math.max(0, Number(event.loopEnd)) : null,
      fadeIn: fade,
      fadeOut: 0,
      switchedFrom: typeof event.previous === 'string' && event.previous ? event.previous : null,
      fileDuration: durations[event.file] !== undefined ? Number(durations[event.file]) : null,
    };
  }
  closeSegment(totalSeconds, 0);
  return segments.filter((segment) => segment.file && segment.duration > 0.0005);
}

/* ------------------------------------------------------ 事件表 → SFX 段 */

/**
 * 音效事件 → 播放段：[{ name, file, start, volume, loop }]
 * 0 長度 / 缺 file 的事件丟掉（缺素材時 audio.js 本來就不發事件，這裡只是防禦）。
 */
export function planSfxEvents(events, options = {}) {
  const totalSeconds = Math.max(0, num(options.totalSeconds, 0));
  const out = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (!event || event.type !== 'sfx') continue;
    if (typeof event.file !== 'string' || !event.file) continue;
    const start = Math.max(0, num(event.t, num(event.frame, 0) / AUDIO_DEFAULTS.fps));
    if (totalSeconds > 0 && start >= totalSeconds) continue;
    out.push({
      name: typeof event.name === 'string' ? event.name : null,
      file: event.file,
      start,
      volume: clamp01(event.volume),
      loop: event.loop === true,
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

/**
 * 「極短時間內重複的 sfx」去重（頁面與引擎各有一個 createAudio 實例，可能同一顆
 * 音效各播一次 → 混音會變成兩倍音量）。同一檔案、同一時間窗內只留第一筆。
 */
export function dedupeSfx(plan, windowSeconds = 0.02) {
  const seen = new Set();
  const out = [];
  const span = Math.max(0.0001, num(windowSeconds, 0.02));
  for (const item of Array.isArray(plan) ? plan : []) {
    const key = `${item.file}@${Math.round(item.start / span)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/* ---------------------------------------------------------------- 長度 */

/**
 * 音訊總長（秒）：預設 = frames / fps（逐幀錄影的長度就是影片長度）。
 * `tail` 可多留尾巴（例如 MP4 最後一幀要顯示到下一幀為止）。
 */
export function planDuration(frames, options = {}) {
  const fps = num(options.fps, AUDIO_DEFAULTS.fps) || AUDIO_DEFAULTS.fps;
  const tail = Math.max(0, num(options.tail, 0));
  return Math.max(0, Math.round(num(frames, 0))) / fps + tail;
}

/* -------------------------------------------------------------- ffmpeg */

/**
 * BGM 段的一路輸入怎麼切：
 *   - 沒有 loopEnd（或 loopEnd 超過音檔長度）→ 整首循環（`-stream_loop -1`）
 *   - loopStart < loopEnd → 前奏一次 + [loopStart, loopEnd) 循環：
 *       前奏輸入：`-t loopStart`；循環輸入：`-ss loopStart -t loopLen -stream_loop -1`
 *   - !loop → 只播一次（不 loop；時長不足時 apad 補靜音）
 *
 * 回傳 [{ args, chain, duration }]：args 是「這個輸入的 ffmpeg 前置參數」。
 */
export function bgmInputSpecs(segment, index) {
  const file = segment.file;
  const duration = Math.max(0.001, num(segment.duration, 0));
  const loop = segment.loop !== false;
  const loopStart = Number.isFinite(Number(segment.loopStart)) ? Math.max(0, Number(segment.loopStart)) : 0;
  const loopEnd = Number.isFinite(Number(segment.loopEnd)) ? Number(segment.loopEnd) : null;
  const known = Number.isFinite(Number(segment.fileDuration)) ? Number(segment.fileDuration) : null;
  const hasLoopRegion = loop && loopEnd !== null && loopEnd > loopStart + 0.0001;

  if (!loop) {
    return [{ role: 'once', file, args: [], duration }];
  }
  if (!hasLoopRegion || (known !== null && loopEnd > known + 0.0001)) {
    // 整首循環
    return [{ role: 'loop', file, args: ['-stream_loop', '-1'], duration }];
  }
  const introLen = loopStart;
  const loopLen = Math.max(0.001, loopEnd - loopStart);
  const specs = [];
  if (introLen > 0.0005) {
    specs.push({ role: 'intro', file, args: ['-t', seconds(introLen)], duration: Math.min(introLen, duration) });
  }
  specs.push({
    role: 'loop-region',
    file,
    // 只把「區段」讀進來（-ss/-t 是輸入選項，讀完就結束），再用 aloop 在濾鏡裡
    // 無限重播。不能寫成 `-t loopLen -stream_loop -1`：-t 會限制「總讀取長度」，
    // 結果只拿到一個區段就停了（後面整段是靜音）。
    args: ['-ss', seconds(loopStart), '-t', seconds(loopLen)],
    duration: Math.max(0, duration - introLen),
    loopLen,
    loop: true,
  });
  // 循環段的起點在 segment 內是 introLen 之後
  specs[specs.length - 1].offset = Math.min(introLen, duration);
  return specs;
}

/**
 * 把「BGM 段 + SFX 段」組成 ffmpeg 輸入與 filter_complex（純函式，測試用）。
 *
 * 為什麼用 filter 而不是 concat：每段都要能從任意時間開始播（loopStart）、
 * 淡入淡出、音量不同、可循環，用 `-stream_loop` + `atrim` + `volume` + `afade`
 * 逐段生成、再 `amix` 疊起來、最後 `apad` 補到總長，行為最可預測。
 *
 * @param {object} input
 * @param {Array} input.bgmSegments planBgmSegments 的結果
 * @param {Array} input.sfxEvents planSfxEvents（可先去重）的結果
 * @param {string} input.bgmDir BGM 檔所在目錄（抓下來的暫存檔）
 * @param {string} input.sfxDir SFX 檔所在目錄
 * @param {number} input.totalSeconds
 * @param {(file:string)=>string} [input.resolve] 自訂檔案路徑解析
 * @returns {{inputArgs:string[], filter:string, inputs:Array<{path,kind,file}>, duration:number, warnings:string[]}}
 */
export function buildMixPlan(input) {
  const bgmSegments = Array.isArray(input && input.bgmSegments) ? input.bgmSegments : [];
  const sfxEvents = Array.isArray(input && input.sfxEvents) ? input.sfxEvents : [];
  const totalSeconds = Math.max(0.001, num(input && input.totalSeconds, 0));
  const sampleRate = num(input && input.sampleRate, AUDIO_DEFAULTS.sampleRate);
  const channels = num(input && input.channels, AUDIO_DEFAULTS.channels);
  const bgmDir = String((input && input.bgmDir) || '');
  const sfxDir = String((input && input.sfxDir) || '');
  const resolvePath =
    typeof (input && input.resolve) === 'function'
      ? input.resolve
      : (kind) => (file) => {
          const base = kind === 'bgm' ? bgmDir : sfxDir;
          const rel = String(file || '').replace(/\\/g, '/');
          return base ? `${base}/${rel}` : rel;
        };
  const bgmPath = typeof resolvePath === 'function' ? (file) => String(resolvePath('bgm')(file)) : null;
  const sfxPath = typeof resolvePath === 'function' ? (file) => String(resolvePath('sfx')(file)) : null;

  if (bgmSegments.length === 0 && sfxEvents.length === 0) {
    throw new Error('沒有任何音訊事件可混音');
  }

  const inputArgs = [];
  const inputs = [];
  const filters = [];
  const labels = [];
  const warnings = [];
  const sources = new Map();
  // shareKey：同一個 key 共用一路輸入（asplit）。BGM 每段各開一路——同一首曲子停了又重播時，
  // 兩段共用輸入會讓第二段（帶長延遲、前奏＋循環兩路）在完整混音裡整段消失（第 6 章大魔術秀 v3）。
  const addInput = (path, extraArgs, kind, file, shareKey = '') => {
    const key = JSON.stringify([path, extraArgs, shareKey]);
    let source = sources.get(key);
    if (!source) {
      const index = inputs.length;
      inputArgs.push(...extraArgs, '-i', path);
      inputs.push({ path, kind, file, index });
      source = { index, labels: [] };
      sources.set(key, source);
    }
    const label = `[src${source.index}_${source.labels.length}]`;
    source.labels.push(label);
    return label;
  };
  const channelLayout = channels === 1 ? 'mono' : 'stereo';
  const tail = `aresample=${sampleRate},aformat=sample_fmts=fltp:channel_layouts=${channelLayout}`;

  /* ------------------------------- BGM：每段一到兩路輸入 → amix 成一段 ------------------------------- */
  bgmSegments.forEach((segment, segmentIndex) => {
    const specs = bgmInputSpecs(segment, segmentIndex);
    const segmentLabels = [];
    const volume = clamp01(segment.volume);
    const fadeIn = Math.max(0, num(segment.fadeIn, 0));
    const fadeOut = Math.max(0, num(segment.fadeOut, 0));
    let offset = 0;
    specs.forEach((spec, specIndex) => {
      const source = addInput(bgmPath(spec.file), spec.args, 'bgm', spec.file, `seg${segmentIndex}`);
      const label = `b${segmentIndex}_${specIndex}`;
      const parts = ['asetpts=PTS-STARTPTS', tail];
      // loopStart/loopEnd 的循環段：輸入只有一個「區段」，在濾鏡裡用 aloop 無限重播。
      // size 是每個聲道的樣本數（區段長度 × 取樣率），必須在 aresample 之後算才準。
      if (spec.role === 'loop-region' && spec.loop) {
        const loopSamples = Math.max(1, Math.round(num(spec.loopLen, 0) * sampleRate));
        parts.push(`aloop=loop=-1:size=${loopSamples}`);
      }
      if (volume !== 1) parts.push(`volume=${volume.toFixed(4)}`);
      // 每段先裁到需要的長度（intro 較短；循環段吃滿剩餘長度）。
      // 注意順序：先 atrim／apad 再 adelay —— adelay 會在開頭補靜音，若先 delay 再
      // atrim，被裁掉的是「真正有聲音」的尾段（循環段＝10s 靜音 + 15s 音樂就沒了）。
      const wanted = spec.role === 'intro' ? Math.min(spec.duration, num(segment.duration, 0)) : Math.max(0, num(segment.duration, 0) - offset);
      parts.push(`atrim=duration=${seconds(Math.max(0.001, wanted))}`);
      parts.push(`apad=whole_dur=${seconds(Math.max(0.001, wanted))}`);
      // 前奏與循環段用 concat 首尾相接（不再「循環段 adelay＝前奏長度、再 amix」：
      // 那樣組成的段落再整段 adelay 到很晚的時間點時，ffmpeg 會把整段吃掉——
      // 同一首曲子停了又重播的第二段完全無聲，第 6 章大魔術秀 v3 第 10 幕）。
      filters.push(`${source}${parts.join(',')}[${label}]`);
      segmentLabels.push(`[${label}]`);
      offset += Math.min(spec.duration || 0, num(segment.duration, 0));
    });
    // 把段內各路混起來 → 這一段的成品
    const segLabel = `bg${segmentIndex}`;
    if (segmentLabels.length === 1) {
      // 只有一路：直接改名（避免多餘的 amix）
      const source = segmentLabels[0].slice(1, -1);
      filters.push(`[${source}]anull[${segLabel}]`);
    } else {
      filters.push(`${segmentLabels.join('')}concat=n=${segmentLabels.length}:v=0:a=1[${segLabel}_mix]`);
      filters.push(`[${segLabel}_mix]anull[${segLabel}]`);
    }
    const segFx = [`[${segLabel}]`];
    const segParts = [];
    if (fadeIn > 0) segParts.push(`afade=t=in:st=0:d=${seconds(Math.max(AUDIO_DEFAULTS.minFade, fadeIn))}`);
    if (fadeOut > 0) {
      const start = Math.max(0, num(segment.duration, 0) - fadeOut);
      segParts.push(`afade=t=out:st=${seconds(start)}:d=${seconds(Math.max(AUDIO_DEFAULTS.minFade, fadeOut))}`);
    }
    const startMs = Math.max(0, Math.round(num(segment.start, 0) * 1000));
    if (startMs > 0) segParts.push(`adelay=${startMs}|${startMs}`);
    segParts.push(`apad=whole_dur=${seconds(totalSeconds)}`, `atrim=duration=${seconds(totalSeconds)}`, tail);
    const outLabel = `bgm${segmentIndex}`;
    filters.push(`${segFx[0]}${segParts.join(',')}[${outLabel}]`);
    labels.push(`[${outLabel}]`);
  });

  /* ----------------------------------------- SFX：每個事件一路，直接疊上 -------------------------------- */
  sfxEvents.forEach((event, eventIndex) => {
    const source = addInput(sfxPath(event.file), [], 'sfx', event.file);
    const label = `x${eventIndex}`;
    const volume = clamp01(event.volume);
    const parts = ['asetpts=PTS-STARTPTS', tail];
    if (volume !== 1) parts.push(`volume=${volume.toFixed(4)}`);
    const startMs = Math.max(0, Math.round(num(event.start, 0) * 1000));
    if (startMs > 0) parts.push(`adelay=${startMs}|${startMs}`);
    parts.push(`atrim=duration=${seconds(totalSeconds)}`);
    filters.push(`${source}${parts.join(',')}[${label}]`);
    labels.push(`[${label}]`);
  });

  if (labels.length === 0) throw new Error('沒有任何可混音的音訊輸入');
  // A recording may contain only intermittent SFX. Give the mix a continuous
  // sample clock from frame zero instead of inheriting one from an effect.
  const samples = Math.round(totalSeconds * sampleRate);
  const clock = `anullsrc=r=${sampleRate}:cl=${channelLayout}:d=${seconds(totalSeconds)},aformat=sample_fmts=fltp[clock]`;
  const mix = `[clock]${labels.join('')}amix=inputs=${labels.length + 1}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.95:latency=1,apad=whole_len=${samples},atrim=end_sample=${samples},asetpts=N/SR/TB[aout]`;
  const inputFilters = Array.from(sources.values(), ({ index, labels }) => {
    const split = labels.length === 1 ? 'anull' : `asplit=${labels.length}`;
    return `[${index}:a]${split}${labels.join('')}`;
  });
  const filter = [...inputFilters, ...filters, clock, mix].join(';\n');

  return { inputArgs, filter, inputs, duration: totalSeconds, warnings };
}

/** 把混音計畫組成「轉成 WAV」的 ffmpeg 參數（不執行；runFfmpeg 負責跑）。 */
export function buildWavCommand(plan, outputWav, options = {}) {
  const sampleRate = num(options.sampleRate, AUDIO_DEFAULTS.sampleRate);
  const channels = num(options.channels, AUDIO_DEFAULTS.channels);
  if (!plan || !plan.filter) throw new Error('混音計畫不完整');
  if (!outputWav) throw new Error('缺少 WAV 輸出路徑');
  if (!options.filterFile) throw new Error('缺少混音濾鏡腳本路徑');
  return {
    args: [
      '-hide_banner',
      '-loglevel',
      'error',
      '-y',
      ...plan.inputArgs,
      options.legacyFilterOption ? '-filter_complex_script' : '-/filter_complex',
      options.filterFile,
      '-map',
      '[aout]',
      '-ac',
      String(channels),
      '-ar',
      String(sampleRate),
      '-c:a',
      'pcm_s16le',
      outputWav,
    ],
    duration: plan.duration,
  };
}

/**
 * PNG 序列 + WAV → MP4（H.264 yuv420p + AAC）。
 * 影像輸入用 `-framerate` 固定 30，輸出 `-r` 也固定 30（ffprobe 幀數才會等於幀數）。
 */
export function buildMp4Command(input) {
  const fps = num(input && input.fps, AUDIO_DEFAULTS.fps) || AUDIO_DEFAULTS.fps;
  const pngPattern = String((input && input.pngPattern) || '');
  const wav = String((input && input.wav) || '');
  const output = String((input && input.output) || '');
  if (!pngPattern) throw new Error('缺少 PNG 序列樣式（例如 f%04d.png）');
  if (!output) throw new Error('缺少 MP4 輸出路徑');
  const args = ['-hide_banner', '-loglevel', 'error', '-y', '-framerate', String(fps), '-i', pngPattern];
  if (wav) args.push('-i', wav);
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    String(input && input.preset ? input.preset : 'medium'),
    '-crf',
    String(input && input.crf !== undefined ? input.crf : 18),
    // yuv420p：剪輯軟體 / 瀏覽器都能吃（寬高必須是偶數 → 640/1280/1920 都可以）
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
  );
  if (wav) {
    args.push('-c:a', 'aac', '-b:a', String(input && input.audioBitrate ? input.audioBitrate : '192k'));
  }
  args.push('-movflags', '+faststart', output);
  return { args, fps, output, hasAudio: Boolean(wav) };
}

/** 影片尺寸（最近鄰放大後的實際 canvas 大小）。 */
export function outputSize(scale) {
  const s = Math.max(1, Math.min(3, Math.round(num(scale, 1))));
  return { width: 640 * s, height: 480 * s, scale: s };
}

/** PNG 序列檔名（%04d 從 0 起算；ffmpeg 的 image2 序列就是這個格式）。 */
export function pngName(index) {
  return `f${String(Math.max(0, Math.round(num(index, 0)))).padStart(4, '0')}.png`;
}

/** ffmpeg image2 的序列樣式。 */
export function pngPatternFor(dir) {
  return `${String(dir || '.').replace(/[\\/]+$/, '')}/f%04d.png`;
}

/* ------------------------------------------------------- 檔案清單 / 命名 */

/** 依事件順序列出「需要抓的音檔」（去重、保序）。 */
export function collectAudioFiles(bgmSegments, sfxEvents) {
  const files = [];
  const seen = new Set();
  for (const item of [...(Array.isArray(bgmSegments) ? bgmSegments : []), ...(Array.isArray(sfxEvents) ? sfxEvents : [])]) {
    if (!item || !item.file || seen.has(item.file)) continue;
    seen.add(item.file);
    files.push(item.file);
  }
  return files;
}
