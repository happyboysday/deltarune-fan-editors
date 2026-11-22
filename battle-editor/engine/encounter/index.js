/**
 * engine/encounter/index.js — 遭遇戰入口（SPEC-P2 §4）
 *
 * 對外 API（§4）：
 *   import { createEncounter, normalizeEncounter, validateEncounter, CUE_COMMANDS }
 *     from './engine/encounter/index.js';
 *
 *   const enc = createEncounter({ canvas, assets, resolveAttack: async (name) => json });
 *   await enc.load(encounterJson);   // 預先 resolve 所有 attack 參照
 *   enc.play(); enc.pause(); enc.reset();
 *   enc.step(n = 1, input?);         // 無頭 / 測試：input = { press:[], hold:{} }
 *   enc.getState();                  // SPEC-P2 §5
 *   enc.setOptions({ lang, showHitboxes, muted, scale });
 *   enc.on('phase'|'end'|'error'|'frame', cb);
 *   enc.debug.jumpToTurn(i); enc.debug.runCues(cues); enc.debug.setVar(name, v);
 *   enc.destroy();
 *
 * 分層（§8 歸屬）：
 *   E1（本檔）世界 + 指令 + 資料；FL 寫 flow.js 狀態機（選單 / 行動結算 / 回合推進）。
 *   flow.js 用**動態 import**載入：檔案還不存在時降級成「只跑 hooks 與指令」，
 *   不會讓 import 失敗拖垮整個引擎（FL 平行開發中）。
 *
 * 渲染：canvas 存在時動態 import E2 的 render-encounter.js；
 *       檔案不存在就退回 Phase 1 的 render.js（只畫彈幕那層）。
 */

import {
  normalizeEncounter,
  validateEncounter,
  CUE_COMMANDS,
  CUE_COMMAND_NAMES,
  ENCOUNTER_FORMAT,
  LANGS,
  PHASES,
  RESULT_TYPES,
  isPlainObject,
  num,
  pickText,
} from './schema.js';
import { collectAttackRefs } from './attack-refs.js';
import { createWorld, normalizeInput } from './world.js';
import { createCueRunner } from './cues.js';
import { winTextbox } from './text.js';
import { LAYOUT, partyFeetFor } from './layout.js';
import { createRng } from '../rng.js';
import { createInput } from '../input.js';

export { normalizeEncounter, validateEncounter, CUE_COMMANDS, CUE_COMMAND_NAMES, ENCOUNTER_FORMAT };
export { LAYOUT };
export { partyFeetFor };

/** 遭遇層固定 30 FPS */
export const FPS = 30;

/** 邏輯解析度（與 Phase 1 相同） */
export const VIEW_W = 640;
export const VIEW_H = 480;

/** 動態載入模組（失敗回 null，永不 throw） */
async function loadModule(path) {
  try {
    const mod = await import(new URL(path, import.meta.url).href);
    return mod || null;
  } catch (_err) {
    return null;
  }
}

/**
 * 由素材索引建立「sprite 名 → 實際幀數」查詢。
 * 非循環動畫省略 frames 時用它決定長度與最後一幀；無素材（headless）回 null，
 * 讓演員系統沿用 frames / duration / 1 秒 的退回規則。
 *
 * @param {object|null} assets loadAssets() 的結果
 * @returns {((name:string)=>number)|null}
 */
function spriteFramesFromAssets(assets) {
  if (!assets || typeof assets.sprite !== 'function') return null;
  return (name) => {
    try {
      const entry = assets.sprite(name);
      if (!entry || typeof entry !== 'object') return 0;
      return Array.isArray(entry.frames) && entry.frames.length ? entry.frames.length : 1;
    } catch (_err) {
      return 0;
    }
  };
}

/**
 * 建立遭遇戰實例。
 *
 * @param {object} [options]
 * @param {HTMLCanvasElement|null} [options.canvas] null = 無頭（Node / 測試）
 * @param {object} [options.audio] 呼叫端共用的音效播放器；由呼叫端釋放。
 * @param {object|null} [options.assets] loadAssets() 的結果
 * @param {(name:string)=>number} [options.spriteFrames] 素材實際幀數查詢（省略時由 assets 自動提供）
 * @param {'play'|'preview'} [options.mode]
 * @param {(name:string)=>Promise<object|null>} [options.resolveAttack] 依檔名載入攻擊 JSON
 * @param {boolean} [options.showFlowWarnings]
 */
export function createEncounter(options = {}) {
  const canvas = options && options.canvas ? options.canvas : null;
  const assets = (options && options.assets) || null;
  const spriteFrames =
    typeof options.spriteFrames === 'function' ? options.spriteFrames : spriteFramesFromAssets(assets);
  const mode = options && options.mode === 'preview' ? 'preview' : 'play';
  const resolveAttack =
    typeof options.resolveAttack === 'function' ? options.resolveAttack : null;

  /* ------------------------------------------------------------ 狀態 */

  /** 事件訂閱表 */
  const listeners = new Map();

  /** 選項 */
  const renderOptions = {
    lang: 'zh',
    showHitboxes: false,
    muted: false,
    scale: 1,
    showGrid: true,
  };

  /** @type {object} 正規化後的遭遇 */
  let encounter = normalizeEncounter({});

  /** 預先解析好的攻擊：name → attack json */
  const resolvedAttacks = new Map();

  /** @type {object|null} 世界 */
  let world = null;
  /** @type {object|null} 指令執行器 */
  let runner = null;
  /** @type {object|null} 流程（FL 的 flow.js；可能不存在） */
  let flow = null;
  /** 流程模組是否載入失敗（降級模式） */
  let flowUnavailable = false;
  /** 流程模組執行期拋錯次數（>0 表示 flow.js 有 bug，已降級） */
  let flowErrorCount = 0;
  /** 最後一次流程模組錯誤訊息（除錯面板顯示用） */
  let flowErrorMessage = '';
  /** @type {object|null} 降級模式的替代狀態機 */
  let fallbackFlow = null;

  let running = false;
  let destroyed = false;
  let rafId = 0;
  let lastTime = 0;
  let accumulator = 0;
  let frame = 0;
  let phase = 'intro';
  let turn = 0;
  let result = null;
  let endEmitted = false;
  let loaded = false;
  let loadVersion = 0;

  /** E2 渲染器 */
  let renderer = null;
  let rendererPending = null;
  let rendererKind = null; // 'encounter' | 'battle'
  // externalInput：由宿主（例如場景編輯器）在 step() 傳入按鍵，引擎不自己監聽鍵盤，避免同一個按鍵被讀兩次
  const input = canvas && !options.externalInput ? createInput() : null;
  let audio = options.audio || null;

  /** 待執行的 hook 名（載入後第一幀觸發） */
  let pendingIntro = false;

  /* ------------------------------------------------------------ 事件 */

  function on(evt, cb) {
    if (typeof cb !== 'function') return () => {};
    const name = String(evt);
    if (!listeners.has(name)) listeners.set(name, new Set());
    listeners.get(name).add(cb);
    return () => off(name, cb);
  }

  function off(evt, cb) {
    const set = listeners.get(String(evt));
    if (!set) return;
    if (cb) set.delete(cb);
    else set.clear();
  }

  function emit(evt, payload) {
    const set = listeners.get(evt);
    if (!set || set.size === 0) return;
    for (const cb of [...set]) {
      try {
        cb(payload);
      } catch (err) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(`[encounter] '${evt}' 訂閱回呼錯誤：`, err);
        }
      }
    }
  }

  function setPhase(next) {
    if (!PHASES.includes(next) || phase === next) return;
    phase = next;
    emit('phase', { phase, turn, frame });
  }

  function endEncounter(kind) {
    result = RESULT_TYPES.includes(kind) ? kind : 'victory';
    setPhase(result);
    if (!endEmitted) {
      endEmitted = true;
      emit('end', { result, turn, frame });
    }
    running = false;
    stopLoop();
  }

  /* ------------------------------------------------------------ 世界 */

  /** 建立 world / runner，並把 hook 事件接起來 */
  function buildWorld() {
    world = createWorld(encounter, {
      rng: createRng(num(encounter.settings.seed, 1)),
      fps: FPS,
      resolvedAttacks,
      spriteFrames,
      lang: renderOptions.lang,
      onEvent: onWorldEvent,
    });
    runner = createCueRunner(world, {
      fps: FPS,
      beforeCue: () => flow?.settleDefense(),
      onError: (message, cue) => {
        emit('error', {
          path: cue && typeof cue === 'object' ? cue.cmd || '' : '',
          message,
          cue: cue || null,
        });
      },
    });
  }

  /** world 的事件轉發成遭遇層事件 */
  function onWorldEvent(type, payload) {
    switch (type) {
      case 'attackStart':
        setPhase('attack');
        // 只加轉發（行為不變）：模擬器要能看到攻擊開始與長度
        emit('attackStart', payload);
        break;
      case 'attackEnd':
        emit('attackEnd', payload);
        break;
      case 'attackClose':
        if (phase === 'attack') setPhase('turnEnd');
        break;
      case 'endRequest':
        if (payload && payload.result) endEncounter(payload.result);
        break;
      case 'error':
        emit('error', payload);
        break;
      case 'hurt':
        emit('hurt', payload);
        break;
      case 'graze':
        emit('graze', payload);
        break;
      case 'enemyRemoved':
        emit('enemyRemoved', payload);
        break;
      case 'bgm':
        applyBgm(payload);
        break;
      // 只觀察用的事件（不影響任何狀態轉移）
      case 'hp':
      case 'mercy':
      case 'tp':
      case 'say':
      case 'bubble':
      case 'turnStart':
      case 'turnEnd':
      case 'actions':
      case 'act':
      case 'actDone':
      case 'defend':
      case 'spare':
      case 'magic':
      case 'item':
      case 'attackBegin':
      case 'form':
        emit(type, payload);
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------ 載入 */

  /**
   * 載入遭遇檔。會先正規化、驗證、預先解析所有攻擊參照。
   * @param {object} json
   * @returns {Promise<{errors:{path:string,message:string}[]}>}
   */
  async function load(json) {
    const version = ++loadVersion;
    const validationErrors = validateEncounter(json);
    const next = normalizeEncounter(json);

    // 只在整組依賴到齊後切換文件，避免較慢的舊載入覆蓋新文件。
    const [flowMod, resolved] = await Promise.all([
      loadModule('./flow.js'),
      Promise.all([...collectAttackRefs(next)].map(async (name) => {
        try {
          return [name, await resolveAttack?.(name)];
        } catch {
          return [name, null];
        }
      })),
    ]);
    if (destroyed || version !== loadVersion) return { errors: validationErrors, superseded: true };
    encounter = next;
    resolvedAttacks.clear();
    const missing = [];
    for (const [name, attackJson] of resolved) {
      if (isPlainObject(attackJson)) resolvedAttacks.set(name, attackJson);
      else missing.push(name);
    }

    // 重置狀態
    running = false;
    stopLoop();
    frame = 0;
    turn = 0;
    result = null;
    endEmitted = false;
    flowErrorCount = 0;
    phase = 'intro';
    accumulator = 0;
    lastTime = 0;

    buildWorld();

    // 流程模組（FL）。若不存在 → 降級
    if (flowMod && typeof flowMod.createFlow === 'function') {
      try {
        flow = flowMod.createFlow(world, runner, encounter);
        flowUnavailable = false;
        if (flow && typeof flow.on === 'function') {
          flow.on('phase', (payload) => {
            const p = payload && payload.phase ? payload.phase : payload;
            if (typeof p === 'string') {
              turn = payload && typeof payload.turn === 'number' ? payload.turn : turn;
              setPhase(p);
            }
          });
          flow.on('end', (payload) => {
            const r = payload && payload.result ? payload.result : payload;
            endEncounter(typeof r === 'string' ? r : 'victory');
          });
        }
      } catch (err) {
        flow = null;
        flowUnavailable = true;
        emit('error', { path: 'flow', message: `流程模組建立失敗：${err && err.message ? err.message : String(err)}` });
      }
    } else {
      flow = null;
      flowUnavailable = true;
    }

    if (flowUnavailable) {
      fallbackFlow = createFallbackFlow();
    } else {
      fallbackFlow = null;
    }

    loaded = true;
    pendingIntro = true;
    emit('load', {
      name: pickText(encounter.meta.name, renderOptions.lang),
      errors: validationErrors,
      missingAttacks: missing,
      flow: flowUnavailable ? 'fallback' : 'flow',
    });

    // 初始化渲染器（有 canvas 才建立）
    if (canvas && !renderer && !rendererPending) {
      rendererPending = initRenderer().finally(() => {
        rendererPending = null;
        draw();
      });
    }
    // 外部驅動時宿主會馬上要 entryPositions / drawEntry，先等畫面模組就緒
    if (options.externalInput && rendererPending) await rendererPending;
    draw();
    return { errors: validationErrors };
  }

  /* ------------------------------------------------------ 降級流程 */

  /**
   * 沒有 flow.js 時的替代狀態機：
   *   intro（hooks.intro）→ 每回合 turnStart（start 指令）→ turnEnd（end 指令）→ 下一回合
   * 只跑 hook 與指令，不做選單 / 行動結算（那是 FL 的職責）。
   * 指令完全由玩家按 Z 推進（與正式流程一致）。
   */
  function createFallbackFlow() {
    const state = {
      step: 'idle', // idle → intro → turnStart → turnEnd → turnStart …
      turnIndex: 0,
      handle: null,
      done: false,
    };

    /** 執行一段指令清單；空清單回傳 null（代表「不用等」） */
    function runList(cues, label) {
      if (!Array.isArray(cues) || cues.length === 0) return null;
      return runner.run(cues, { label });
    }

    function beginIntro() {
      state.step = 'intro';
      setPhase('intro');
      turn = 0;
      world.setTurn(0);
      state.handle = runList(encounter.hooks.intro, 'hooks.intro');
      if (!state.handle) state.step = 'introDone';
    }

    function beginTurn(i) {
      state.turnIndex = i;
      turn = i;
      world.setTurn(i);
      setPhase('turnStart');
      const t = encounter.turns[i];
      // 降級模式仍然把 turn.attack 當成一條 attack 指令插入（SPEC-P2 §3 的指令，
      // 不涉及選單 / 行動結算），這樣沒有 flow.js 也看得到彈幕。
      const cues = [];
      if (t && Array.isArray(t.start)) cues.push(...t.start);
      if (t && Array.isArray(t.beforeAttack)) cues.push(...t.beforeAttack);
      if (t && t.attack) cues.push({ cmd: 'attack', attack: t.attack });
      state.handle = cues.length > 0 ? runner.run(cues, { label: `turns[${i}].start` }) : null;
      state.step = 'turnStart';
      if (!state.handle) state.step = 'turnStartDone';
    }

    function update() {
      if (state.done || result) return;
      const busy = runner.busy();
      switch (state.step) {
        case 'idle':
          beginIntro();
          break;
        case 'intro':
          if (!busy) {
            state.handle = null;
            state.step = 'introDone';
          }
          break;
        case 'introDone':
          beginTurn(0);
          break;
        case 'turnStart':
          if (!busy) state.step = 'turnStartDone';
          break;
        case 'turnStartDone': {
          const t = encounter.turns[state.turnIndex];
          setPhase('turnEnd');
          state.handle = t ? runList(t.end, `turns[${state.turnIndex}].end`) : null;
          state.step = 'turnEnd';
          break;
        }
        case 'turnEnd':
          if (!busy) {
            state.handle = null;
            const next = state.turnIndex + 1;
            if (next >= encounter.turns.length) {
              state.done = true;
              endEncounter('victory');
              break;
            }
            beginTurn(next);
          }
          break;
        default:
          break;
      }
    }

    return {
      start() {
        state.done = false;
        state.step = 'idle';
        state.turnIndex = 0;
        setPhase('intro');
        update();
      },
      update,
      /** 從指定回合接手（flow.js 執行期崩潰時降級用：不重跑 intro） */
      startAt(i) {
        state.done = false;
        state.handle = null;
        const last = Math.max(0, encounter.turns.length - 1);
        beginTurn(Math.max(0, Math.min(last, Math.round(num(i, 0)))));
        update();
      },
      snapshot() {
        return { phase, turn, menu: null, fight: null, result };
      },
      get done() {
        return state.done;
      },
      reset() {
        state.done = false;
        state.step = 'idle';
        state.turnIndex = 0;
      },
    };
  }

  /* ------------------------------------------------------------ 步進 */

  /** 取得本幀輸入（無頭時用外部傳入） */
  function readInput(external) {
    const live = external === undefined ? input?.snapshot() : null;
    input?.clearPresses();
    const frame = external === undefined
      ? { ...live, press: [...pendingPresses, ...(live?.press ?? [])] }
      : external;
    pendingPresses.length = 0;
    return normalizeInput(frame);
  }

  /** @type {string[]} 還原快照時尚未消費的按下事件 */
  let pendingPresses = [];

  /**
   * 推進一幀。
   * @param {object} [externalInput] { press:[], hold:{} }
   */
  function stepFrame(externalInput) {
    if (destroyed || !world) return false;
    // 第一次 step 才啟動 intro（與 play() 等價；無頭測試可直接 step）
    startIntroIfNeeded();
    const inp = readInput(externalInput);
    frame += 1;

    // 1) 世界（演員 / 文字 / 彈幕回合 / 特效）
    world.update(inp);

    // 2) 指令
    runner.update(inp);

    // 3) 流程
    if (flow && typeof flow.update === 'function') {
      try {
        flow.update(inp);
        syncFromFlow();
      } catch (err) {
        // 外部流程模組（FL 的 flow.js）執行期拋錯時，不能讓整個遭遇戰崩掉：
        // 回報錯誤後降級到內建流程，從當前回合繼續。
        degradeToFallback(err);
      }
    }
    if (!flow && fallbackFlow) fallbackFlow.update(inp);

    // 4) world 的 end 請求（cue: end）
    const endReq = world.consumeEndRequest();
    if (endReq) endEncounter(endReq);

    // 5) 音效
    flushSfx();
    applyPendingBgm();

    // 6) 文字確認（Z）：say / bubble 由 runner 的 handle 吃掉；
    //    若文字是 flow 直接呼叫 world.text 建立的（沒有指令在等），
    //    這裡補上 Z 的「全顯示 → 關閉」兩段行為。
    if (inp && typeof inp.has === 'function' && inp.has('confirm')) {
      if (!runner.busy() && world.text.busy()) world.text.confirm();
    }

    if (world.frame % 1 === 0) emit('frame', { frame, phase, turn, result });
    draw();
    return !result;
  }

  /**
   * 外部流程模組拋錯時的降級處理：
   * 發 error 事件、丟掉 flow、改用內建 fallback 流程並從當前回合接手。
   * 這樣 FL 的 flow.js 有 bug 時，遭遇戰仍可推進（編輯器預覽不會整個卡死）。
   */
  function degradeToFallback(err) {
    flowErrorCount += 1;
    flowErrorMessage = err && err.message ? String(err.message) : String(err);
    emit('error', { path: 'flow', message: `流程執行錯誤：${flowErrorMessage}` });
    if (flowErrorCount > 3) {
      // 已經反覆失敗就不要再重試，直接停用流程模組
      flow = null;
      flowUnavailable = true;
      return;
    }
    const resumeTurn = num(turn, 0);
    flow = null;
    flowUnavailable = true;
    fallbackFlow = createFallbackFlow();
    try {
      fallbackFlow.startAt(resumeTurn);
    } catch (_e) {
      /* 降級失敗就算了，至少不會崩潰 */
    }
  }

  /** 從 flow.snapshot() 同步 phase / turn / result（flow 若沒發事件） */
  function syncFromFlow() {
    if (!flow || typeof flow.snapshot !== 'function') return;
    let snap = null;
    try {
      snap = flow.snapshot();
    } catch (_e) {
      return;
    }
    if (!snap || typeof snap !== 'object') return;
    if (typeof snap.turn === 'number') turn = snap.turn;
    if (typeof snap.phase === 'string' && PHASES.includes(snap.phase)) setPhase(snap.phase);
    if (snap.result && !result) endEncounter(snap.result);
  }

  /**
   * 推進 n 幀（對外 API）。
   * @param {number} [n]
   * @param {object} [externalInput]
   */
  function step(n = 1, externalInput) {
    if (!loaded) return;
    const count = Math.max(0, Math.round(num(n, 1)));
    for (let i = 0; i < count && !result; i += 1) {
      const frameInput = i > 0 && externalInput ? { ...externalInput, press: [] } : externalInput;
      stepFrame(frameInput);
    }
  }

  /* ------------------------------------------------------------ 音效 */

  const bgmState = { track: null, fade: 0, pending: null, seq: 0 };

  function applyBgm(payload) {
    if (!payload) return;
    bgmState.track = payload.track === undefined ? null : payload.track;
    bgmState.fade = num(payload.fade, 0);
    bgmState.seq += 1;
    bgmState.pending = { track: bgmState.track, fade: bgmState.fade };
  }

  function applyPendingBgm() {
    if (!bgmState.pending) return;
    const next = bgmState.pending;
    bgmState.pending = null;
    if (audio && typeof audio.playBgm === 'function') {
      try {
        audio.playBgm(next.track, { fade: next.fade });
      } catch (_err) {
        /* 音效缺失靜默 */
      }
    }
  }

  function flushSfx() {
    const queue = world ? world.drainSfx() : [];
    if (!queue || queue.length === 0) return;
    if (renderOptions.muted) return;
    for (const name of queue) {
      if (audio && typeof audio.play === 'function') {
        try {
          audio.play(name);
        } catch (_err) {
          /* 音效缺失靜默 */
        }
      }
    }
  }

  /* ------------------------------------------------------------ 渲染 */

  async function initRenderer() {
    if (!canvas) return;
    // 優先 E2 的遭遇渲染器
    const encMod = await loadModule('../render-encounter.js');
    if (destroyed) return;
    if (encMod && typeof encMod.createEncounterRenderer === 'function') {
      try {
        renderer = encMod.createEncounterRenderer(canvas, assets);
        rendererKind = 'encounter';
        if (renderer && typeof renderer.resize === 'function') renderer.resize(renderOptions.scale);
        return;
      } catch (err) {
        emit('error', { path: 'render', message: `遭遇渲染器建立失敗：${err && err.message ? err.message : String(err)}` });
        renderer = null;
      }
    }
    // 退回 Phase 1 渲染器（只畫彈幕那層）
    const battleMod = await loadModule('../render.js');
    if (destroyed) return;
    if (battleMod && typeof battleMod.createRenderer === 'function') {
      try {
        renderer = battleMod.createRenderer(canvas, assets);
        rendererKind = 'battle';
        if (renderer && typeof renderer.resize === 'function') renderer.resize(renderOptions.scale);
      } catch (_err) {
        renderer = null;
      }
    }
  }

  function draw() {
    if (!renderer || destroyed) return;
    const state = getState();
    try {
      if (rendererKind === 'encounter' && typeof renderer.draw === 'function') {
        renderer.draw(state, {
          showHitboxes: renderOptions.showHitboxes,
          showGrid: renderOptions.showGrid !== false,
          lang: renderOptions.lang,
          scale: renderOptions.scale,
          // E2 的渲染器會從 options.background 決定背景（state.background 是備援）
          background: state.background,
        });
      } else if (typeof renderer.draw === 'function') {
        // Phase 1 渲染器只認得彈幕層：沒有彈幕回合時畫靜態畫面
        const battle = state.battle;
        renderer.draw(
          battle
            ? { ...battle, party: state.party, tp: state.tp, attack: encounter.turns[turn] ? null : null }
            : {
                frame,
                time: frame / FPS,
                box: { x: 320, y: 240, w: 320, h: 160, rotation: 0, border: 5, color: '#00c000' },
                soul: { x: 320, y: 240, mode: 'red', color: '#ff0000', invFrames: 0, grazing: false, visible: true },
                bullets: [],
                party: state.party,
                tp: state.tp,
                enemies: [],
                shake: { x: 0, y: 0 },
                sfxQueue: [],
                grazeFlash: 0,
                hurtFlash: 0,
                attack: null,
              },
          {
            showHitboxes: renderOptions.showHitboxes,
            showGrid: renderOptions.showGrid !== false,
            lang: renderOptions.lang,
            scale: renderOptions.scale,
          },
        );
      }
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) console.warn('[encounter] 渲染失敗：', err);
    }
  }

  /* ------------------------------------------------------------ 迴圈 */

  function hasRaf() {
    return typeof requestAnimationFrame === 'function';
  }

  function now() {
    return typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function tick() {
    if (!running || destroyed) return;
    const t = now();
    const dt = Math.min(0.25, Math.max(0, (t - lastTime) / 1000));
    lastTime = t;
    accumulator += dt;
    const stepSec = 1 / FPS;
    let guard = 0;
    while (accumulator >= stepSec && guard < 6 && running) {
      accumulator -= stepSec;
      stepFrame();
      guard += 1;
      if (result) break;
    }
    if (result) {
      running = false;
      return;
    }
    rafId = requestAnimationFrame(tick);
  }

  function startLoop() {
    if (!hasRaf() || running || destroyed) return;
    running = true;
    lastTime = now();
    accumulator = 0;
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId && hasRaf()) {
      try {
        cancelAnimationFrame(rafId);
      } catch (_e) {
        /* 忽略 */
      }
    }
    rafId = 0;
  }

  /* ------------------------------------------------------------ API */

  /** 載入後第一幀觸發 intro hook（由 play() 或第一次 step 觸發） */
  function startIntroIfNeeded() {
    if (!pendingIntro || !world) return;
    pendingIntro = false;
    world.playBgm(encounter.settings.bgm);
    if (flowUnavailable && fallbackFlow) {
      fallbackFlow.start();
    } else if (flow && typeof flow.start === 'function') {
      try {
        flow.start();
      } catch (err) {
        emit('error', { path: 'flow', message: `流程啟動失敗：${err && err.message ? err.message : String(err)}` });
      }
    }
    setPhase('intro');
  }

  function play() {
    if (destroyed || !loaded) return;
    startIntroIfNeeded();
    if (result) return;
    startLoop();
    if (!hasRaf()) running = true;
  }

  function pause() {
    running = false;
    stopLoop();
  }

  function reset() {
    if (!world) return;
    pause();
    frame = 0;
    turn = 0;
    result = null;
    endEmitted = false;
    phase = 'intro';
    accumulator = 0;
    lastTime = 0;
    pendingPresses = [];
    input?.clearPresses();
    world.reset();
    runner.clear();
    if (flow && typeof flow.reset === 'function') {
      try {
        flow.reset();
      } catch (_e) {
        /* 忽略 */
      }
    }
    if (fallbackFlow) fallbackFlow = createFallbackFlow();
    pendingIntro = true;
    draw();
  }

  /** 跳到第 N 回合（編輯器預覽用） */
  function jumpToTurn(index) {
    if (!world) return;
    const i = Math.max(0, Math.min(encounter.turns.length - 1, Math.round(num(index, 0))));
    reset();
    turn = i;
    world.setTurn(i);
    setPhase('turnStart');
    pendingIntro = false;
    world.playBgm(encounter.settings.bgm);
    if (flowUnavailable && fallbackFlow) {
      // 降級模式：直接跑該回合的 start 指令
      const t = encounter.turns[i];
      if (t && Array.isArray(t.start) && t.start.length > 0) {
        runner.run(t.start, { label: `turns[${i}].start` });
      }
    } else if (flow && typeof flow.jumpToTurn === 'function') {
      try {
        flow.jumpToTurn(i);
      } catch (err) {
        emit('error', { path: 'flow', message: `jumpToTurn 失敗：${err && err.message ? err.message : String(err)}` });
      }
    }
    draw();
  }

  /** 取 §5 狀態 */
  function getState() {
    const base = world ? world.snapshot() : emptyWorldSnapshot();
    const flowSnap = flow && typeof flow.snapshot === 'function' ? safeFlowSnapshot() : fallbackFlow ? fallbackFlow.snapshot() : null;
    const outcome = result || flowSnap?.result || null;
    const state = {
      frame,
      lang: renderOptions.lang,
      phase,
      turn,
      turnNumber: flowSnap?.turnNumber || turn + 1,
      actors: base.actors,
      party: base.party,
      enemies: base.enemies,
      tp: base.tp,
      textbox: outcome === 'victory' || outcome === 'spared'
        ? winTextbox(renderOptions.lang, runner && typeof runner.winSay === 'function' ? runner.winSay().closing : null)
        : base.textbox,
      bubbles: base.bubbles,
      menu: flowSnap && flowSnap.menu !== undefined ? flowSnap.menu : null,
      fight: flowSnap && flowSnap.fight !== undefined ? flowSnap.fight : null,
      numbers: base.numbers,
      battle: base.battle,
      boxAnim: base.boxAnim,
      // SPEC-LAYOUT §5：戰鬥框展開時由 ±90 度收斂到 0（渲染器據此旋轉框）
      boxAnimRotation: typeof base.boxAnimRotation === 'number' ? base.boxAnimRotation : 0,
      // SPEC-LAYOUT §1/§3/§7：版面常數（渲染與編輯器共用同一份，見 layout.js）
      layout: {
        partyFeet: world ? world.partyFeet() : partyFeetFor((encounter.party || []).length),
        partyX: world ? world.partyX() : LAYOUT.PARTY_CENTER_X,
        partyStagger: world ? world.partyStagger() : LAYOUT.PARTY_STAGGER_X,
        panelTop: LAYOUT.PANEL_TOP,
        textTop: LAYOUT.TEXT_TOP,
      },
      fade: base.fade,
      flash: base.flash,
      shake: base.shake,
      result: outcome,
      vars: base.vars || {},
      // 渲染便利欄位（E2 的 render-encounter.js 會讀；SPEC-P2 §5 未列，屬相容擴充）
      background: (encounter.settings && encounter.settings.background) || null,
      attack: world && world.battle ? world.battle.attack : null,
      mode,
      running,
      loaded,
    };
    return state;
  }

  function safeFlowSnapshot() {
    try {
      const s = flow.snapshot();
      return s && typeof s === 'object' ? s : null;
    } catch (_e) {
      return null;
    }
  }

  function emptyWorldSnapshot() {
    return {
      frame: 0,
      lang: renderOptions.lang,
      actors: [],
      party: [],
      enemies: [],
      tp: 0,
      textbox: null,
      bubbles: [],
      numbers: [],
      battle: null,
      boxAnim: 0,
      boxAnimRotation: 0,
      layout: {
        partyFeet: partyFeetFor((encounter.party || []).length),
        panelTop: LAYOUT.PANEL_TOP,
        textTop: LAYOUT.TEXT_TOP,
      },
      fade: { color: '#000000', alpha: 0 },
      flash: { color: '#ffffff', alpha: 0 },
      shake: { x: 0, y: 0 },
      vars: {},
    };
  }

  function setOptions(next) {
    if (!next || typeof next !== 'object') return;
    if (typeof next.lang === 'string' && LANGS.includes(next.lang)) {
      renderOptions.lang = next.lang;
      if (world) world.setLang(next.lang);
    }
    if (next.showHitboxes !== undefined) renderOptions.showHitboxes = next.showHitboxes === true;
    if (next.showGrid !== undefined) renderOptions.showGrid = next.showGrid !== false;
    if (next.muted !== undefined) {
      renderOptions.muted = next.muted === true;
      if (audio && typeof audio.setMuted === 'function') audio.setMuted(renderOptions.muted);
    }
    if (typeof next.scale === 'number' && Number.isFinite(next.scale)) {
      renderOptions.scale = next.scale;
      if (renderer && typeof renderer.resize === 'function') renderer.resize(next.scale);
    }
    draw();
  }

  function getOptions() {
    return { ...renderOptions };
  }

  /** 建立音效模組（有 assets 才建；失敗靜默） */
  async function initAudio() {
    if (audio || !assets) return;
    const mod = await loadModule('../audio.js');
    if (destroyed || !mod || typeof mod.createAudio !== 'function') return;
    try {
      audio = mod.createAudio(assets);
      if (audio && typeof audio.setMuted === 'function') audio.setMuted(renderOptions.muted);
    } catch (_err) {
      audio = null;
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    running = false;
    stopLoop();
    input?.destroy();
    if (renderer && typeof renderer.destroy === 'function') {
      try {
        renderer.destroy();
      } catch (_e) {
        /* 忽略 */
      }
    }
    renderer = null;
    if (!options.audio) audio?.destroy();
    if (world) {
      try {
        world.text.clear();
      } catch (_e) {
        /* 忽略 */
      }
    }
    runner = null;
    flow = null;
    fallbackFlow = null;
    listeners.clear();
  }

  /* ------------------------------------------------------ 非同步初始化 */

  const ready = (async () => {
    if (!canvas) return;
    await initAudio();
  })();


  /* ================================================================= */
  /* 快照 / 還原（V2-08）                                                */
  /* ================================================================= */

  /** 快照格式版本 */
  const SNAPSHOT_VERSION = 1;

  /**
   * 遭遇戰完整狀態快照（V2-08）。
   *
   * 內容：遭遇層自己的狀態（frame / phase / turn / result / pendingIntro /
   * 待按鍵 / BGM / 選項）＋ 世界的完整快照 ＋ 流程的完整快照 ＋
   * 指令執行器（cue runner）的完整快照。三者都是純資料，可直接
   * structuredClone / JSON 序列化。
   *
   * 還原前提：同一個 encounter 檔（相同的演員 / 回合 / 指令清單）。
   *
   * @returns {object|null}
   */
  function snapshot() {
    if (!loaded) return null;
    return {
      kind: 'encounter',
      version: SNAPSHOT_VERSION,
      frame,
      phase,
      turn,
      result,
      endEmitted,
      pendingIntro,
      pendingPresses: [...pendingPresses, ...(input?.snapshot().press ?? [])],
      fallback: Boolean(fallbackFlow),
      flowUnavailable,
      options: { ...renderOptions },
      bgmState: {
        track: bgmState.track === undefined ? null : bgmState.track,
        fade: bgmState.fade,
        seq: bgmState.seq,
      },
      world: world && typeof world.snapshotState === 'function' ? world.snapshotState() : null,
      runner: runner && typeof runner.snapshotState === 'function' ? runner.snapshotState() : null,
      flow: flow && typeof flow.snapshotState === 'function' ? flow.snapshotState() : null,
    };
  }

  /**
   * 還原快照（V2-08）。
   *
   * 必須先 await load() 同一個 encounter 檔（buildWorld 會建立新的
   * world / runner / flow 實例）；之後把三個子系統的狀態灌回去。
   *
   * @param {object} snap snapshot() 的結果（或 JSON.parse 後的值）
   * @returns {boolean} 是否還原成功
   */
  function restore(snap) {
    const s = snap && typeof snap === 'object' ? snap : null;
    if (!s || s.kind !== 'encounter' || s.version !== SNAPSHOT_VERSION) return false;
    if (!loaded || !world || !runner) return false;

    frame = Math.max(0, Math.round(num(s.frame, 0)));
    phase = PHASES.includes(s.phase) ? s.phase : 'intro';
    turn = Math.max(0, Math.round(num(s.turn, 0)));
    result = s.result && RESULT_TYPES.includes(s.result) ? s.result : null;
    endEmitted = s.endEmitted === true;
    pendingIntro = s.pendingIntro === true;
    input?.clearPresses();
    pendingPresses = Array.isArray(s.pendingPresses) ? s.pendingPresses.slice() : [];
    if (s.options && typeof s.options === 'object') {
      renderOptions.lang = s.options.lang === 'en' ? 'en' : 'zh';
      renderOptions.showHitboxes = s.options.showHitboxes === true;
      renderOptions.muted = s.options.muted === true;
      renderOptions.scale = num(s.options.scale, 1);
      renderOptions.showGrid = s.options.showGrid !== false;
    }
    if (s.bgmState && typeof s.bgmState === 'object') {
      bgmState.track = s.bgmState.track === undefined ? null : s.bgmState.track;
      bgmState.fade = num(s.bgmState.fade, 0);
      bgmState.seq = Math.max(0, Math.round(num(s.bgmState.seq, 0)));
      bgmState.pending = null;
    }

    // 順序：world（含演員 / 文字 / 彈幕 sim）→ runner（cue 進度）
    //       → flow（選單 / 攻擊條 / 待執行動作）
    if (s.world && typeof world.restoreState === 'function' && !world.restoreState(s.world)) {
      return false;
    }
    if (s.runner && typeof runner.restoreState === 'function' && !runner.restoreState(s.runner)) {
      return false;
    }
    if (s.flow && flow && typeof flow.restoreState === 'function' && !flow.restoreState(s.flow)) {
      return false;
    }
    // 降級流程：只還原階段（fallback 自己會從 turn 接手）
    if (fallbackFlow && typeof fallbackFlow.reset === 'function') {
      fallbackFlow.reset();
      fallbackFlow.startAt(turn);
    }
    draw();
    return true;
  }

  /* ------------------------------------------------------------ 除錯 */

  const debug = {
    jumpToTurn,
    /** 執行一段指令（編輯器「執行所選指令清單」用） */
    runCues(cues, opts) {
      if (!runner) return { done: true, cancel() {} };
      return runner.run(cues, opts || { label: 'debug' });
    },
    setVar(name, value, op) {
      if (!world) return 0;
      return world.setVar(name, value, op);
    },
    getVar(name) {
      return world ? world.getVar(name) : 0;
    },
    setPhase(p) {
      if (PHASES.includes(p)) setPhase(p);
    },
    end(resultName) {
      endEncounter(resultName || 'victory');
    },
    /** 直接跑一回合的攻擊（跳過流程） */
    startAttack(ref) {
      return world ? world.startAttack(ref) : null;
    },
    /** 內部物件（編輯器除錯面板用） */
    get world() {
      return world;
    },
    get runner() {
      return runner;
    },
    get flow() {
      return flow;
    },
    get encounter() {
      return encounter;
    },
    get flowUnavailable() {
      return flowUnavailable;
    },
    /** flow.js 執行期拋錯次數（>0 = 已降級到內建流程） */
    get flowErrorCount() {
      return flowErrorCount;
    },
    /** 最後一次 flow.js 錯誤訊息（空字串 = 沒發生過） */
    get flowErrorMessage() {
      return flowErrorMessage;
    },
    get missingAttacks() {
      return Array.from(collectAttackRefs(encounter)).filter((n) => !resolvedAttacks.has(n));
    },
    /** 等待非同步初始化（音效 / 渲染器）完成 */
    ready,
  };

  return {
    /* --- §4 API --- */
    load,
    play,
    pause,
    reset,
    step,
    getState,
    setOptions,
    getOptions,
    on,
    off,
    destroy,
    // V2-08：完整狀態快照 / 還原（決定性測試與重跑加速用）
    snapshot,
    restore,
    // 場景編輯器整合：入戰轉場的演員位置與分層繪製、戰鬥結束時帶回場景的 HP 與道具
    entryPositions() {
      return renderer?.entryPositions?.(getState()) ?? [];
    },
    drawEntry(positions, drawOptions) {
      renderer?.drawEntry?.(getState(), positions, drawOptions);
    },
    partyState() {
      return {
        party: (world?.party ?? []).map(({ id, hp, maxHp }) => ({ id, hp, maxHp })),
        items: (world?.items ?? []).map(({ id, count }) => ({ id, count })),
      };
    },
    debug,
    /* --- getter --- */
    get phase() {
      return phase;
    },
    get turn() {
      return turn;
    },
    get result() {
      return result;
    },
    get running() {
      return running;
    },
    get frame() {
      return frame;
    },
    get lang() {
      return renderOptions.lang;
    },
    get loaded() {
      return loaded;
    },
    get mode() {
      return mode;
    },
    get encounter() {
      return encounter;
    },
    get world() {
      return world;
    },
    get runner() {
      return runner;
    },
    get flow() {
      return flow;
    },
    get options() {
      return { ...renderOptions };
    },
  };
}

export default createEncounter;
