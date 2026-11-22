/**
 * engine/index.js — 引擎公開 API（SPEC §6、§9）
 *
 * 本檔是 E1（模擬核心）與 E2（渲染 / 輸入 / 音效 / 素材）的接縫：
 *   - 模擬核心、正規化、驗證皆為靜態 import（Node 無頭可執行）。
 *   - render.js / audio.js / assets.js 由 E2 提供，透過「動態 import」載入，
 *     因此檔案尚未存在時也不會讓本模組載入失敗（無頭模式完全不需要它們）。
 *   - 有 canvas 才建立渲染器與輸入；無頭（canvas: null）只跑模擬。
 *
 * 對外：
 *   createBattle({ canvas, assets, mode }) → battle
 *   normalizeAttack(json) / validateAttack(json) / loadAssets(indexUrl)
 */

import { createSimulation, VIEW_W, VIEW_H } from './sim.js';
import { normalizeAttack, validateAttack, FPS } from './attack.js';
import { createInput, normalizeFrameInput } from './input.js';

export { normalizeAttack, validateAttack, FPS, VIEW_W, VIEW_H };
export { createRng } from './rng.js';
export { getEasing, EASING_NAMES } from './easing.js';
export { compile as compileExpression, clearExprCache } from './expr.js';

/* ------------------------------------------------------ E2 模組載入 */

/** 動態載入 E2 模組；檔案不存在或有錯時回傳 null（不丟例外）。 */
const moduleCache = new Map();

function loadE2Module(name) {
  if (moduleCache.has(name)) return moduleCache.get(name);
  const promise = (async () => {
    try {
      const url = new URL(`./${name}.js`, import.meta.url);
      return await import(url.href);
    } catch (err) {
      if (typeof console !== 'undefined' && console.warn) {
        console.warn(`[engine] 無法載入 engine/${name}.js（相關功能停用）：`, err && err.message ? err.message : err);
      }
      return null;
    }
  })();
  moduleCache.set(name, promise);
  return promise;
}

/**
 * 載入素材索引（實作在 E2 的 engine/assets.js）。
 * 找不到模組或載入失敗時回傳 null，呼叫端應以「無素材」繼續（洋紅佔位）。
 *
 * @param {string} indexUrl 例如 'assets/index.json'
 * @returns {Promise<{index:any, getImage:Function, sprite:Function}|null>}
 */
export async function loadAssets(indexUrl) {
  const mod = await loadE2Module('assets');
  if (!mod || typeof mod.loadAssets !== 'function') {
    return null;
  }
  try {
    return await mod.loadAssets(indexUrl);
  } catch (err) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[engine] loadAssets 失敗，改用無素材模式：', err && err.message ? err.message : err);
    }
    return null;
  }
}

/* -------------------------------------------------------------- battle */

/**
 * 建立一場戰鬥。
 *
 * @param {{
 *   canvas?: HTMLCanvasElement|null,
 *   assets?: any|null,
 *   mode?: 'play'|'preview',
 * }} [options]
 */
export function createBattle(options = {}) {
  const canvas = options && options.canvas ? options.canvas : null;
  const assets = (options && options.assets) || null;
  const mode = options && options.mode === 'play' ? 'play' : 'preview';

  /** 事件訂閱表 */
  const listeners = new Map();

  /** 選項（渲染 / 音效共用） */
  const renderOptions = {
    showHitboxes: false,
    showGrid: true,
    muted: false,
    scale: 1,
    // SPEC §7：遊戲畫面語言（檢視偏好，不影響模擬與決定性）；預設繁中
    lang: 'zh',
  };

  let running = false;
  let destroyed = false;
  let rafId = 0;
  let lastTime = 0;
  let accumulator = 0;
  let endEmitted = false;

  let renderer = null;
  let input = canvas ? createInput() : null;
  let audio = null;

  const simulation = createSimulation({
    mode,
    onEvent: (evt) => {
      if (evt && evt.type === 'error') emit('error', evt.payload);
      else if (evt && evt.type === 'hit') emit('hit', evt.payload);
      else if (evt && evt.type === 'graze') emit('graze', evt.payload);
      else if (evt && evt.type === 'end') {
        if (!endEmitted) {
          endEmitted = true;
          emit('end', evt.payload);
        }
      }
    },
  });

  /* ------------------------------------------------------ 事件系統 */

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
          console.warn(`[engine] '${evt}' 訂閱回呼錯誤：`, err);
        }
      }
    }
  }

  /* ------------------------------------------- E2 模組非同步建立 */

  function initE2Modules() {
    if (!canvas) return;
    loadE2Module('render').then((mod) => {
      if (destroyed || !mod || typeof mod.createRenderer !== 'function') return;
      try {
        renderer = mod.createRenderer(canvas, assets);
        if (renderer && typeof renderer.resize === 'function') {
          renderer.resize(renderOptions.scale);
        }
        draw();
      } catch (err) {
        console.warn('[engine] 建立渲染器失敗：', err);
        renderer = null;
      }
    });
    loadE2Module('audio').then((mod) => {
      if (destroyed || !mod || typeof mod.createAudio !== 'function') return;
      try {
        audio = mod.createAudio(assets);
        if (audio && typeof audio.setMuted === 'function') audio.setMuted(renderOptions.muted);
      } catch (err) {
        console.warn('[engine] 建立音效失敗：', err);
        audio = null;
      }
    });
  }

  /* ------------------------------------------------------------ 音效 */

  /** 把模擬產生的 sfx 佇列交給音效模組（沒有音效模組時靜默清空） */
  function flushSfx() {
    const queue = simulation.drainSfx();
    if (!queue || queue.length === 0) return;
    if (!audio || renderOptions.muted) return;
    for (const name of queue) {
      try {
        audio.play(name);
      } catch (_err) {
        /* 缺素材時靜默 */
      }
    }
  }

  /** 丟棄 sfx（seek 重模擬時不該發聲） */
  function discardSfx() {
    simulation.drainSfx();
  }

  /* ------------------------------------------------------------ 繪製 */

  function draw() {
    if (!renderer || typeof renderer.draw !== 'function') return;
    try {
      renderer.draw(simulation.getState(), {
        showHitboxes: renderOptions.showHitboxes,
        showGrid: renderOptions.showGrid,
        scale: renderOptions.scale,
        // SPEC §7：語言原樣交給渲染器決定字串表（zh / en）
        lang: renderOptions.lang,
      });
    } catch (err) {
      // 渲染錯誤不得中斷模擬；只警告一次
      if (!drawWarned) {
        drawWarned = true;
        console.warn('[engine] 渲染錯誤（後續只警告一次）：', err);
      }
    }
  }
  let drawWarned = false;

  /* ------------------------------------------------------------ 步進 */

  /** 前進一幀並處理 frame 事件 / 音效 */
  function stepOnce(externalInput) {
    const frameInput = externalInput === undefined
      ? mode === 'play' && input ? input.readFrame() : null
      : externalInput;
    const moved = simulation.stepFrame(frameInput);
    flushSfx();
    if (moved) {
      const payload = { frame: simulation.frame, time: simulation.time, ended: simulation.ended };
      emit('frame', payload);
    }
    return moved;
  }

  /* ---------------------------------------------------------- rAF 迴圈 */

  function hasRaf() {
    return typeof requestAnimationFrame === 'function';
  }

  function now() {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') return performance.now();
    return Date.now();
  }

  function tick() {
    if (destroyed) return;
    rafId = requestAnimationFrame(tick);
    const t = now();
    let dt = (t - lastTime) / 1000;
    lastTime = t;
    if (!Number.isFinite(dt) || dt < 0) dt = 0;
    // 避免分頁切回時的暴衝
    if (dt > 0.25) dt = 0.25;
    if (running) {
      accumulator += dt * FPS;
      let guard = 0;
      while (accumulator >= 1 && guard < 6 && !destroyed) {
        accumulator -= 1;
        guard += 1;
        const moved = stepOnce();
        if (!moved) {
          // 回合已結束：停止自動前進
          running = false;
          accumulator = 0;
          break;
        }
      }
    } else {
      accumulator = 0;
    }
    draw();
  }

  function startLoop() {
    if (!canvas || !hasRaf() || destroyed) return;
    if (rafId) return;
    lastTime = now();
    accumulator = 0;
    rafId = requestAnimationFrame(tick);
  }

  function stopLoop() {
    if (rafId && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(rafId);
    rafId = 0;
  }

  /* ------------------------------------------------------------ API */

  function load(attackJson) {
    input?.clearPresses();
    endEmitted = false;
    simulation.load(attackJson);
    running = false;
    accumulator = 0;
    discardSfx();
    draw();
    return getState();
  }

  function play() {
    if (destroyed) return;
    if (simulation.ended) {
      // 已結束時再按播放：從頭開始
      seek(0);
    }
    running = true;
    accumulator = 0;
    lastTime = now();
    startLoop();
    draw();
  }

  function pause() {
    running = false;
    accumulator = 0;
  }

  function reset() {
    input?.clearPresses();
    simulation.reset();
    running = false;
    accumulator = 0;
    endEmitted = false;
    discardSfx();
    draw();
  }

  /**
   * 手動前進 n 幀（不依賴 rAF；測試與編輯器逐格用）。
   * n = 0 只重繪。
   */
  function step(n = 1, externalInput) {
    const count = Math.max(0, Math.round(Number(n) || 0));
    if (count === 0) {
      draw();
      return;
    }
    const frameInput = externalInput === undefined ? undefined : normalizeFrameInput(externalInput);
    if (frameInput) input?.clearPresses();
    for (let i = 0; i < count; i += 1) {
      const moved = stepOnce(i > 0 && frameInput ? { ...frameInput, press: [] } : frameInput);
      if (!moved) break;
    }
    draw();
  }

  /**
   * 從 0 重新模擬至 frame（preview 決定性）。
   * 重模擬期間不播音效，事件（error/hit/graze/end）仍會正常發出。
   */
  function seek(frame) {
    const target = Math.max(0, Math.round(Number(frame) || 0));
    endEmitted = false;
    simulation.seekTo(target);
    discardSfx();
    if (simulation.ended && !endEmitted) {
      endEmitted = true;
      emit('end', { frame: simulation.frame, time: simulation.time, seek: true });
    }
    draw();
    emit('frame', { frame: simulation.frame, time: simulation.time, ended: simulation.ended, seek: true });
    return getState();
  }

  function getState() {
    const state = simulation.getState();
    state.running = running;
    return state;
  }

  function setOptions(next) {
    if (!next || typeof next !== 'object') return;
    let scaleChanged = false;
    if ('showHitboxes' in next) renderOptions.showHitboxes = Boolean(next.showHitboxes);
    if ('showGrid' in next) renderOptions.showGrid = Boolean(next.showGrid);
    if ('muted' in next) {
      renderOptions.muted = Boolean(next.muted);
      if (audio && typeof audio.setMuted === 'function') {
        try {
          audio.setMuted(renderOptions.muted);
        } catch (_err) {
          /* 忽略 */
        }
      }
    }
    if ('scale' in next) {
      const s = Number(next.scale);
      if (Number.isFinite(s) && s > 0) {
        if (s !== renderOptions.scale) scaleChanged = true;
        renderOptions.scale = s;
      }
    }
    // 語言（SPEC §7）：只接受 'zh' / 'en'，其他值忽略；純檢視偏好，不進模擬
    if ('lang' in next) {
      const lang = next.lang;
      if (lang === 'zh' || lang === 'en') renderOptions.lang = lang;
    }
    if (scaleChanged && renderer && typeof renderer.resize === 'function') {
      try {
        renderer.resize(renderOptions.scale);
      } catch (err) {
        console.warn('[engine] renderer.resize 失敗：', err);
      }
    }
    draw();
  }

  function getOptions() {
    return { ...renderOptions };
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    running = false;
    stopLoop();
    if (renderer && typeof renderer.destroy === 'function') {
      try {
        renderer.destroy();
      } catch (_err) {
        /* 忽略 */
      }
    }
    renderer = null;
    if (input && typeof input.destroy === 'function') {
      try {
        input.destroy();
      } catch (_err) {
        /* 忽略 */
      }
    }
    input = null;
    if (audio && typeof audio.destroy === 'function') {
      try {
        audio.destroy();
      } catch (_err) {
        /* 忽略 */
      }
    }
    audio = null;
    for (const set of listeners.values()) set.clear();
    listeners.clear();
  }

  /* ------------------------------------------------------------ 啟動 */

  initE2Modules();
  if (canvas) startLoop();

  return {
    load,
    play,
    pause,
    reset,
    step,
    seek,
    getState,
    setOptions,
    getOptions,
    on,
    off,
    destroy,
    // 便利屬性（非 SPEC 必要，但對除錯與試玩頁有用）
    get mode() {
      return mode;
    },
    get running() {
      return running;
    },
    get frame() {
      return simulation.frame;
    },
    get time() {
      return simulation.time;
    },
    get durationFrames() {
      return simulation.durationFrames();
    },
    get attack() {
      return simulation.attack;
    },
    get engine() {
      return simulation;
    },
  };
}

export default createBattle;
