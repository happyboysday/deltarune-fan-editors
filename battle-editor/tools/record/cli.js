/**
 * tools/record/cli.js — `node tools/record.mjs` 的參數解析（純函式，測試用）
 *
 * 為什麼把解析拆出來：CLI 參數 → 錄影選項的對應是「使用者文件」的一部分
 * （docs/RECORD.md 的每個旗標都要能解析、預設值要能被測試），而真正錄影要開
 * Edge／ffmpeg，測試不該為了驗證預設值去開瀏覽器。
 */

import { numArg } from '../agent/lib.mjs';

/** 支援的旗標（值型別；布林旗標不列在這裡）。 */
export const VALUE_FLAGS = [
  'autoplay',
  'scale',
  'out',
  'png-dir',
  'wav',
  'lang',
  'seed',
  'max-frames',
  'fps',
  'works',
  'root',
  'ffmpeg',
  'ffprobe',
  'preset',
  'crf',
  'port',
  'name',
  'capture',
  // --kind attack|encounter：與 pack.mjs / export-game.mjs 一致；錄影會自動判定類型，
  // 這個旗標只用來「確認」（與實際類型不符時給警告），不會改變行為。
  'kind',
];

/** 布林旗標。 */
export const BOOLEAN_FLAGS = ['json', 'help', 'keep-frames', 'no-audio', 'quiet', 'verify', 'hud'];

/** 影片固定 30 fps（ROADMAP-V2 §1：逐幀錄影 30 fps）。 */
export const RECORD_FPS = 30;

export const DEFAULTS = Object.freeze({
  autoplay: null,
  scale: 2,
  lang: 'zh',
  fps: RECORD_FPS,
  /** 攻擊預設最多錄 30 秒；遭遇預設最多 120 秒（都會在結果畫面提早結束）。 */
  attackMaxFrames: 900,
  encounterMaxFrames: 3600,
  preset: 'medium',
  crf: 18,
});

/**
 * 解析錄影相關旗標。
 *
 * @param {Record<string, any>} args lib.mjs parseArgs() 的結果
 * @param {{kind?:'attack'|'encounter'}} [context] 已判定作品類型時可給，決定 max-frames 預設
 * @returns {{input:string|null, autoplay:'demo'|'bot'|null, scale:1|2|3, out:string|null,
 *   pngDir:string|null, wav:string|null, lang:'zh'|'en', seed:number|null,
 *   maxFrames:number, fps:number, json:boolean, keepFrames:boolean, noAudio:boolean,
 *   quiet:boolean, verify:boolean, preset:string, crf:number, ffmpeg:string|null,
 *   ffprobe:string|null, port:number}}
 */
export function parseRecordArgs(args = {}, context = {}) {
  const kind = context.kind === 'encounter' ? 'encounter' : context.kind === 'attack' ? 'attack' : null;
  const input = Array.isArray(args._) && args._.length > 0 ? String(args._[0]) : null;

  let autoplay = null;
  if (args.autoplay === 'demo' || args.autoplay === 'bot') autoplay = args.autoplay;
  else if (args.autoplay === 'off' || args.autoplay === 'none' || args.autoplay === false) autoplay = null;

  const rawScale = Math.round(numArg(args.scale, DEFAULTS.scale));
  const scale = Math.max(1, Math.min(3, Number.isFinite(rawScale) ? rawScale : DEFAULTS.scale));

  const fallbackMax = kind === 'encounter' ? DEFAULTS.encounterMaxFrames : DEFAULTS.attackMaxFrames;
  const maxFramesRaw = Math.round(numArg(args['max-frames'], fallbackMax));
  // 作品類型未知且沒指定 --max-frames → 留 null，由 record() 判定類型後套攻擊 900／遭遇 3600
  const maxFrames = (kind === null && (args['max-frames'] === undefined || args['max-frames'] === null))
    ? null
    : Math.max(1, Math.min(100000, Number.isFinite(maxFramesRaw) ? maxFramesRaw : fallbackMax));

  const fpsRaw = numArg(args.fps, DEFAULTS.fps);
  // 逐幀錄影只支援 30 fps（引擎固定步進＝1/30 秒）；其他值直接報錯，免得輸出時間軸錯。
  const fps = Math.round(fpsRaw);

  const seedNum = args.seed === undefined ? null : numArg(args.seed, null);

  return {
    input,
    kind: args.kind === 'attack' || args.kind === 'encounter' ? args.kind : null,
    autoplay,
    scale,
    out: typeof args.out === 'string' && args.out.trim() ? args.out.trim() : null,
    pngDir: typeof args['png-dir'] === 'string' && args['png-dir'].trim() ? args['png-dir'].trim() : null,
    wav: typeof args.wav === 'string' && args.wav.trim() ? args.wav.trim() : null,
    lang: args.lang === 'en' ? 'en' : 'zh',
    seed: seedNum !== null && Number.isFinite(seedNum) ? seedNum : null,
    maxFrames,
    fps,
    /**
     * 擷取方式：
     *   canvas（預設）= canvas.toDataURL，純遊戲畫面（不含 HUD／banner 疊層）
     *   screenshot    = CDP Page.captureScreenshot 對 canvas 區域截圖，與 tools/agent/render.mjs
     *                   逐像素一致（驗收比對用；代價是每幀多約 50ms）
     */
    capture: parseCapture(args.capture),
    json: Boolean(args.json),
    keepFrames: Boolean(args['keep-frames']),
    hud: Boolean(args['hud']),
    noAudio: Boolean(args['no-audio']),
    quiet: Boolean(args.quiet),
    verify: Boolean(args.verify),
    preset: typeof args.preset === 'string' && args.preset.trim() ? args.preset.trim() : DEFAULTS.preset,
    crf: Math.max(0, Math.min(51, Math.round(numArg(args.crf, DEFAULTS.crf)))),
    ffmpeg: typeof args.ffmpeg === 'string' && args.ffmpeg.trim() ? args.ffmpeg.trim() : null,
    ffprobe: typeof args.ffprobe === 'string' && args.ffprobe.trim() ? args.ffprobe.trim() : null,
    port: Math.round(numArg(args.port, 0)) || 0,
  };
}

/**
 * 正規化 --capture。
 *
 * `screenshot`（預設）：CDP `Page.captureScreenshot` 對 canvas 區域截圖 —— 與
 *   tools/agent/render.mjs 走**完全相同的擷取路徑**，所以「同幀號畫面」可以逐像素一致
 *   （HUD／banner 這些 HTML 疊層也會一起入鏡，跟 render.mjs 的參考畫面一樣）。
 *   代價是每幀多約 50ms（640×480 約 17 幀/秒）。
 * `canvas`：改用 `canvas.toDataURL` —— 只有遊戲畫面本身（不含 HUD／banner），
 *   快 5 倍以上（約 130 幀/秒），適合長片；但畫面不會與 render.mjs 逐像素相同。
 */
export function parseCapture(value, fallback = 'screenshot') {
  const text = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (text === 'screenshot' || text === 'shot' || text === 'cdp' || text === 'render') return 'screenshot';
  if (text === 'canvas' || text === 'dataurl' || text === 'pure') return 'canvas';
  return fallback;
}

/**
 * 驗證解析後的選項；不合法時回錯誤訊息（CLI 印出、回 exit code 2）。
 * @returns {string|null}
 */
export function validateRecordOptions(options = {}) {
  if (!options.input) return null; // 由呼叫端印用法
  if (options.fps !== RECORD_FPS) {
    return `逐幀錄影固定 ${RECORD_FPS} fps（引擎步進是 1/${RECORD_FPS} 秒），不支援 --fps ${options.fps}。`;
  }
  if (!options.out && !options.pngDir && !options.wav) {
    return '至少要指定一種輸出：--out <x.mp4>、--png-dir <dir> 或 --wav <x.wav>（可同時指定）。';
  }
  if (options.out && !/\.mp4$/i.test(options.out)) {
    return `--out 必須是 .mp4：${options.out}`;
  }
  if (options.wav && !/\.wav$/i.test(options.wav)) {
    return `--wav 必須是 .wav：${options.wav}`;
  }
  return null;
}

/** 用法文字（--help 與參數錯誤時共用）。 */
export const USAGE = `用法：node tools/record.mjs <攻擊檔|遭遇檔> [選項]

離線逐幀錄影：headless Edge 固定步進（每幀一 tick、素材 whenIdle 後擷取 canvas），
再用 ffmpeg 把引擎音訊事件表混成 WAV，與 PNG 序列合成 MP4。

選項：
  --autoplay demo|bot   自動演示（預設不自動演示，畫面停在原地）
  --scale 1|2|3         輸出倍率（最近鄰放大；預設 2 → 1280×960）
  --out x.mp4           輸出 MP4（H.264 yuv420p + AAC）
  --png-dir dir         PNG 序列輸出目錄（f0000.png…；只給剪輯軟體時可單獨使用）
  --wav x.wav           混音後的 WAV 輸出
  --lang zh|en          介面語言（預設 zh）
  --seed n              覆寫作品 settings.seed（錄影可重現）
  --max-frames n        最多錄幾幀（攻擊預設 900、遭遇預設 3600）
  --capture screenshot|canvas
                        擷取方式：screenshot（預設，與 tools/agent/render.mjs
                        逐像素一致，含 HUD／banner 疊層）或 canvas（純遊戲
                        畫面、快 5 倍以上，適合長片；不會與 render.mjs 相同）
  --keep-frames         保留暫存的 PNG 序列（預設保留在 %TEMP%\\V2-11\\records\\…）
  --hud                 錄進頁面 HUD／提示列（預設只錄乾淨畫布，?chrome=0）
  --port N              自訂伺服器埠（預設自動挑一個沒人用的；不影響 18900）
  --no-audio            不混音、不掛音軌（只驗畫面時用）
  --verify              相容舊命令；MP4 一律在通過 ffprobe 驗證後寫入指定位置
  --json                以 JSON 印出結果（給 MCP / 腳本用）
  --root DIR            程式根（battle-editor/）
  --works DIR           作品根（含 attacks/、encounters/、assets/custom/）
  --ffmpeg PATH / --ffprobe PATH   指定執行檔（也可用 FFMPEG_PATH / FFPROBE_PATH）
  --help                顯示這份說明

範例：
  node tools/record.mjs samples/spade-rain.json --autoplay demo --scale 2 --out out/spade-rain-2x.mp4
  node tools/record.mjs samples/encounters/rudinn.json --autoplay demo --scale 1 --out out/rudinn-1x.mp4
  node tools/record.mjs samples/encounters/rudinn.json --autoplay demo --png-dir frames/rudinn --wav frames/rudinn.wav
`;
