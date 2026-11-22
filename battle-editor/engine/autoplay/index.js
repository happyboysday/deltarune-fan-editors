/**
 * engine/autoplay/index.js — 自動演示的組合入口（SPEC-AUTOPLAY §3）
 *
 * 對外：
 *   createAutopilot({ kind, doc, mode, resolveAttackDoc }) → pilot
 *       kind 'attack'    ：doc = 攻擊檔（demo 讀 doc.demo）
 *       kind 'encounter' ：doc = 遭遇檔（腳本由 engine/autoplay/encounter.js 的
 *                          createEncounterPilot 執行；該檔由 AP2 提供，動態 import，
 *                          檔案還不存在時退化為不按鍵並在 warnings 記一筆）
 *       mode 'demo'      ：用作品的 demo 腳本（缺省）
 *       mode 'bot'       ：忽略腳本，全程 AI
 *   createRecorder() → { push(frame, input), toString(), clear(), reset(), size, frames }
 *   encodeInputs(entries) / decodeInputs(text)   ← 實作在 ./soul.js（避免循環 import）
 *
 * pilot 介面（SPEC §3）：
 *   pilot.input(state, frame) → { press: [], hold: {} }
 *   pilot.reset()
 *   pilot.warnings   string[]
 *   pilot.describe() → { mode, dodge, turn, step, ready }
 *   pilot.ready      Promise（encounter 模組載入完成；attack 立即 resolve）
 *
 * 模組必須瀏覽器與 Node 都能用 → 本檔不得 import 任何 Node 專屬模組。
 */

import { createSoulPilot, encodeInputs, decodeInputs, canonicalInput, neutralInput, sameSustainedInput } from './soul.js';
import { usesSoulProfiles } from './bot.js';

export { encodeInputs, decodeInputs };
export { createSoulPilot } from './soul.js';
export { createBot, BOT_NAMES, bestClearance } from './bot.js';
export { validateAttackDemo, validateEncounterDemo } from './validate.js';

/* pathgen（V2-02）與 trace（V2-06）的公開介面統一從本檔匯出（V2-FIX1）：
 * 編輯器 / Worker 只 import 這裡，不直接摸模組檔（模組位置屬 engine 實作細節）。
 * 兩者都是純 ES module；export-game 的 collectModules 會沿 `export … from` 自動打包。 */
export {
  PATHGEN_DEFAULTS,
  botTrajectory,
  compactPath,
  createReplayEngine,
  expandPath,
  generateDemoPath,
  replayPath,
  validateDemoPath,
} from './pathgen.js';
export { deviationStats, summarizeTrace, traceDemo } from './trace.js';

/* ------------------------------------------------------------ 小工具 */

function isObj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/* ------------------------------------------------------------ recorder */

/**
 * 錄製器：每幀 push(frame, input)，最後 toString() 成 SPEC §2.1 的輸入字串。
 *
 * 只記錄「與上一幀不同」的變化點（行程長度編碼）；單次按下（press）另外保留。
 * 因此 decode(rec.toString()) 在每個被 push 過的幀上都能還原出原始輸入。
 */
export function createRecorder() {
  /** @type {Map<number, {press:string[], hold:object}>} */
  const frames = new Map();
  let lastFrame = -1;
  /** 最後一次 push 的幀與輸入（toString() 用它補一段「錄製結束」的收尾）。 */
  let lastPushedFrame = -1;
  let lastPushedInput = null;
  let dirty = true;
  let cached = '';

  const recorder = {
    /**
     * 記錄某一幀的輸入。
     * @param {number} frame 幀號（0 起算）
     * @param {{press?:string[], hold?:object}|{dx?:number,dy?:number,slow?:boolean}|null} input
     */
    push(frame, input) {
      const f = Math.max(0, Math.round(Number(frame) || 0));
      const normalized = canonicalInput(input);
      // 收尾段的幀號取決於「最後一次 push 的幀」→ 換幀就要讓快取失效
      if (f !== lastPushedFrame) dirty = true;
      lastPushedFrame = f;
      lastPushedInput = normalized;
      // 與「上一個被記錄的幀」相同就省略（宣告式：從上一段持續按住）
      const previous = frames.size > 0 ? frames.get(lastFrame) : null;
      const sameHold = previous && !normalized.press.length && sameSustainedInput(previous, normalized);
      if (!sameHold) {
        frames.set(f, normalized);
        lastFrame = f;
        dirty = true;
      } else if (frames.has(f)) {
        // 同一幀重複 push（後蓋前）
        frames.set(f, normalized);
        dirty = true;
      }
      return recorder;
    },

    /** 已記錄的幀數。 */
    get size() {
      return frames.size;
    },

    /** 最後一次 push 的幀號（-1 = 還沒 push 過）。 */
    get lastFrame() {
      return lastFrame;
    },

    /** 攤平成逐段輸入（供 encodeInputs / 測試用）。 */
    entries() {
      const list = [...frames.entries()]
        .map(([frame, { press, hold, ...axes }]) => ({ frame, press: press.slice(), hold: { ...hold }, ...axes }))
        .sort((a, b) => a.frame - b.frame);
      // 錄到最後一幀仍在按鍵 → 補一段「放開」當收尾，重播才會在錄製結束時放手
      // （否則最後一段會一路按住到回合結束，與錄製結果不同）。
      if (lastPushedInput && !sameSustainedInput(lastPushedInput, { hold: {} })) {
        list.push({ frame: lastPushedFrame + 1, press: [], hold: {} });
      } else if (lastPushedFrame > lastFrame) {
        // v2 也保存錄製末尾這段沒有按鍵的時間，避免提早切到 fallback。
        list.push({ frame: lastPushedFrame, press: [], hold: {} });
      }
      return list;
    },

    /** 轉成 SPEC §2.1 的輸入字串。 */
    toString() {
      if (dirty) {
        cached = encodeInputs(recorder.entries());
        dirty = false;
      }
      return cached;
    },

    /** 清空（保留可繼續錄製）。 */
    reset() {
      frames.clear();
      lastFrame = -1;
      lastPushedFrame = -1;
      lastPushedInput = null;
      dirty = true;
      cached = '';
      return recorder;
    },
    clear() {
      return recorder.reset();
    },
  };
  return recorder;
}

/* -------------------------------------------------------- encounter */

/** 動態載入 encounter pilot（AP2 擁有 engine/autoplay/encounter.js）。 */
let encounterModulePromise = null;
function loadEncounterModule() {
  if (!encounterModulePromise) {
    // 檔案還不存在（AP2 進行中）時 import() 會 reject；這裡吞掉並回 null，
    // 由呼叫端在 warnings 記一筆（不寫 console，避免自動演示在瀏覽器留下噪音）。
    encounterModulePromise = import(new URL('./encounter.js', import.meta.url).href).catch(() => null);
  }
  return encounterModulePromise;
}

/** 依 demo.turns / demo.default 找某一回合的設定（turn 1 起算）。 */
function turnDemoFor(demo, turn) {
  if (!isObj(demo)) return null;
  const turns = Array.isArray(demo.turns) ? demo.turns : [];
  for (let i = 0; i < turns.length; i += 1) {
    const entry = turns[i];
    if (!isObj(entry)) continue;
    if (Number(entry.turn) === Number(turn)) return entry;
    if (entry.turn === undefined && i + 1 === Number(turn)) return entry;
  }
  return null;
}

/**
 * 建立遭遇模式的 pilot（內部用）。
 * 只有在 encounter.js 載入成功後才會被呼叫。
 */
function makeEncounterPilot(createEncounterPilot, options, warnings) {
  const { doc, mode, resolveAttackDoc, botOptions } = options;
  // mode 'bot' = 忽略作品腳本：選單走 default 規則（全員 FIGHT），躲避全程 AI
  const demo = mode !== 'bot' && isObj(doc) && isObj(doc.demo) ? doc.demo : null;
  const menuDelay = isObj(demo) && Number.isFinite(Number(demo.menuDelay)) ? Number(demo.menuDelay) : 6;

  /**
   * 這一回合的靈魂 pilot。
   * 規則（SPEC §2.2）：turn.dodge 優先；省略 → 該回合攻擊檔的 demo.mode；再省略 → bot。
   */
  function dodgePilotFor(turn, attackDoc) {
    const turnDemo = turnDemoFor(demo, turn);
    const defaultDemo = isObj(demo) && isObj(demo.default) ? demo.default : null;
    let dodge = turnDemo && typeof turnDemo.dodge === 'string' ? turnDemo.dodge : null;
    if (dodge === null && defaultDemo && typeof defaultDemo.dodge === 'string') dodge = defaultDemo.dodge;

    const attackDemo = isObj(attackDoc) && isObj(attackDoc.demo) ? attackDoc.demo : null;
    let soulMode = mode === 'bot' ? 'bot' : 'demo';
    if (dodge === 'none') soulMode = 'none';
    else if (dodge === 'path' || dodge === 'inputs' || dodge === 'bot') soulMode = dodge;
    else if (mode !== 'bot' && attackDemo && typeof attackDemo.mode === 'string') soulMode = attackDemo.mode;

    const pilot = createSoulPilot({ attack: attackDoc, demo: attackDemo, mode: soulMode, botOptions });
    if (dodge === 'path' && !usesSoulProfiles(attackDoc) && !(attackDemo && Array.isArray(attackDemo.path) && attackDemo.path.length > 0)) {
      warnings.push(`第 ${turn} 回合 dodge 為 "path" 但攻擊檔沒有 demo.path，改用 bot`);
    }
    return pilot;
  }

  try {
    const pilot = createEncounterPilot({ demo, menuDelay, dodgePilotFor, resolveAttackDoc, mode, doc });
    return pilot && typeof pilot === 'object' ? pilot : null;
  } catch (err) {
    warnings.push(`建立遭遇 pilot 失敗：${err && err.message ? err.message : err}`);
    return null;
  }
}

/* ---------------------------------------------------------- autopilot */

/**
 * 建立自動駕駛（SPEC-AUTOPLAY §3）。
 *
 * @param {object} [options]
 * @param {'attack'|'encounter'} [options.kind='attack']
 * @param {any}    [options.doc] 攻擊檔 / 遭遇檔（可為 null）
 * @param {'demo'|'bot'} [options.mode='demo']  'demo' = 用作品腳本；'bot' = 全程 AI
 * @param {(name:string)=>any} [options.resolveAttackDoc] 遭遇用：取每回合攻擊檔（同步）
 */
export function createAutopilot(options = {}) {
  const opts = isObj(options) ? options : {};
  const kind = opts.kind === 'encounter' ? 'encounter' : 'attack';
  const mode = opts.mode === 'bot' ? 'bot' : 'demo';
  const doc = isObj(opts.doc) ? opts.doc : null;
  const resolveAttackDoc = typeof opts.resolveAttackDoc === 'function' ? opts.resolveAttackDoc : null;
  const warnings = [];

  let inner = null; // 實際的 pilot（soul pilot 或 encounter pilot）
  let innerReady = false;
  /** 尚未就緒就被呼叫 input() 的警告只記一次。 */
  let notReadyWarned = false;

  if (kind === 'attack') {
    const demo = mode === 'demo' && isObj(doc) && isObj(doc.demo) ? doc.demo : null;
    inner = createSoulPilot({ attack: doc, demo, mode: mode === 'bot' ? 'bot' : 'demo', botOptions: opts.botOptions });
    for (const message of inner.warnings) warnings.push(message);
    innerReady = true;
  }

  /** encounter 模式的載入（失敗時退化為不按鍵） */
  const ready = (async () => {
    if (kind !== 'encounter') return true;
    const mod = await loadEncounterModule();
    const factory = mod && typeof mod.createEncounterPilot === 'function' ? mod.createEncounterPilot : null;
    if (!factory) {
      warnings.push('engine/autoplay/encounter.js 尚未提供 createEncounterPilot，遭遇自動演示退化為不按鍵');
      innerReady = true;
      return false;
    }
    const pilot = makeEncounterPilot(factory, { doc, mode, resolveAttackDoc, botOptions: opts.botOptions }, warnings);
    inner = pilot;
    innerReady = true;
    return Boolean(pilot);
  })();

  const pilot = {
    kind,
    /** 'demo' | 'bot'（依建構參數，不是解析後的躲避模式）。 */
    get mode() {
      return mode;
    },
    /** 解析／載入期的提示訊息（永不丟例外）。 */
    get warnings() {
      return warnings;
    },
    /** encounter 模組載入完成（attack 立即 resolve）。 */
    get ready() {
      return ready;
    },
    /** inner pilot 是否就緒（encounter 在載入完成前為 false）。 */
    get readySync() {
      return innerReady;
    },

    /**
     * 決定這一幀的引擎輸入。
     * @param {object} state 引擎 getState()（遭遇模式傳遭遇狀態，內含 battle 快照）
     * @param {number} [frame] 幀號；省略時由 inner pilot 依 state.frame 推斷
     * @returns {{press: string[], hold: object}}
     */
    input(state, frame) {
      if (!inner) {
        // encounter 模組還在載入（或載入失敗）→ 不按鍵；只記一次警告
        if (!innerReady && !notReadyWarned) {
          notReadyWarned = true;
          warnings.push('自動演示尚未就緒（encounter pilot 還在載入）就收到 input()，這一幀回中性輸入');
        }
        return neutralInput();
      }
      try {
        if (typeof inner.input === 'function') return canonicalInput(inner.input(state, frame));
        if (typeof inner.decide === 'function') return canonicalInput(inner.decide(state));
      } catch (err) {
        warnings.push(`pilot.input 失敗：${err && err.message ? err.message : err}`);
      } finally {
        for (const message of inner.warnings) if (!warnings.includes(message)) warnings.push(message);
      }
      return neutralInput();
    },

    /** 重設到開頭。 */
    reset() {
      if (inner && typeof inner.reset === 'function') {
        try {
          inner.reset();
        } catch (err) {
          warnings.push(`pilot.reset 失敗：${err && err.message ? err.message : err}`);
        }
      }
    },

    /** 給 UI 顯示的摘要：{ mode, dodge, turn, step, ready }。 */
    describe() {
      const ready = innerReady;
      const base = {
        mode,
        dodge: inner ? (typeof inner.mode === 'string' ? inner.mode : 'bot') : null,
        turn: null,
        step: 0,
        ready,
      };
      if (inner && typeof inner.describe === 'function') {
        try {
          const described = inner.describe();
          if (isObj(described)) {
            return {
              mode: described.mode !== undefined ? described.mode : base.mode,
              dodge: described.dodge !== undefined ? described.dodge : base.dodge,
              turn: described.turn !== undefined ? described.turn : null,
              step: described.step !== undefined ? described.step : 0,
              ready,
            };
          }
        } catch (err) {
          warnings.push(`pilot.describe 失敗：${err && err.message ? err.message : err}`);
        }
      }
      return base;
    },
  };

  return pilot;
}

/** 依 demo 判定預設模式（提供給 UI / 編輯器；實作在 soul.js）。 */
export { resolveDemoMode } from './soul.js';

export default createAutopilot;
