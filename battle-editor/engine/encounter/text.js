/**
 * engine/encounter/text.js — 文字框 / 泡泡 / 打字機（SPEC-P2 §3 文字標記）
 *
 * 標記語法：
 *   \n        換行
 *   {w:N}     停 N 幀（N 可為小數，會累積到整幀）
 *   {s:N}     之後速度改為 N 字/幀（可小數，預設 1）
 *   {c:名稱}  之後文字上色；名稱可用 white/yellow/red/green/blue/cyan/magenta/orange/gray
 *             或 #rrggbb；{/c} 回復預設色
 *   {i}       立即顯示，直到下一個 {w}（跳過中間所有延遲）
 *
 * 行為：
 *   - 打字中按 Z = 立即顯示全部；打完全部後按 Z = 關閉 / 推進。
 *   - 泡泡可設定 `wait`：`"input"`（預設，等按鍵）或秒數（打完後自動關閉）。
 *
 * 本模組不碰 DOM，只產生 §5 需要的資料。
 */

import { isPlainObject, num } from './schema.js';

/** 預設文字顏色（DELTARUNE 風格白字） */
export const DEFAULT_COLOR = '#ffffff';

export const WIN_NARRATION = { zh: '* 你赢了！', en: '* YOU WON!' };

/** 確認勝利旁白後，讓最後一幀保留同一段文字（closing：掛鉤自己的勝利旁白；沒有時用「你赢了！」）。 */
export function winTextbox(lang, closing = null) {
  const text = typeof closing === 'string' && closing ? closing : WIN_NARRATION[lang] ?? WIN_NARRATION.zh;
  return {
    lines: [{ text, color: DEFAULT_COLOR }],
    visibleChars: text.length,
    totalChars: text.length,
    done: true,
    speaker: null,
    portrait: null,
  };
}

/** 顏色名稱表 */
const COLOR_NAMES = {
  white: '#ffffff',
  yellow: '#ffff00',
  red: '#ff0000',
  green: '#00ff00',
  blue: '#0000ff',
  cyan: '#00ffff',
  magenta: '#ff00ff',
  orange: '#ff8000',
  purple: '#c000ff',
  gray: '#808080',
  grey: '#808080',
  black: '#000000',
};

/** 解析顏色名（#rgb / #rrggbb / 名稱）；不合法回傳 null */
export function resolveColor(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  const s = raw.trim().toLowerCase();
  if (COLOR_NAMES[s]) return COLOR_NAMES[s];
  if (/^#[0-9a-f]{3}$/.test(s)) {
    return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  return null;
}

/**
 * 把一段文字（字串或 {zh,en}）解析成操作序列。
 *
 * op：
 *   { type:'char', ch, color, line }  顯示一個字元
 *   { type:'wait', frames }           停 N 幀
 *   { type:'instant', on:boolean }    切換「立即顯示」模式
 *
 * @param {string} text 已依語言取好的純文字
 * @param {string} [baseColor]
 */
export function parseText(text, baseColor = DEFAULT_COLOR) {
  const src = typeof text === 'string' ? text : '';
  const ops = [];
  let color = baseColor || DEFAULT_COLOR;
  let instant = false;
  let line = 0;
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      // 支援誤寫成字面 \n（JSON 已轉義的情況）
      if (src[i + 1] === 'n') {
        ops.push({ type: 'char', ch: '\n', color, line });
        line += 1;
        i += 2;
        continue;
      }
      ops.push({ type: 'char', ch, color, line });
      i += 1;
      continue;
    }
    if (ch === '\n') {
      ops.push({ type: 'char', ch: '\n', color, line });
      line += 1;
      i += 1;
      continue;
    }
    if (ch === '{') {
      const close = src.indexOf('}', i + 1);
      if (close < 0) {
        // 未閉合 → 當普通字元
        ops.push({ type: 'char', ch, color, line });
        i += 1;
        continue;
      }
      const body = src.slice(i + 1, close).trim();
      const colon = body.indexOf(':');
      const name = (colon < 0 ? body : body.slice(0, colon)).trim();
      const arg = colon < 0 ? '' : body.slice(colon + 1).trim();
      if (name === 'w') {
        ops.push({ type: 'wait', frames: Math.max(0, num(arg, 0)) });
      } else if (name === 's') {
        const v = num(arg, 1);
        ops.push({ type: 'speed', value: Math.max(0, v) });
      } else if (name === 'c') {
        const c = resolveColor(arg);
        if (c) {
          color = c;
          ops.push({ type: 'color', value: c });
        }
      } else if (name === '/c') {
        color = baseColor || DEFAULT_COLOR;
        ops.push({ type: 'color', value: color });
      } else if (name === 'i') {
        instant = true;
        ops.push({ type: 'instant', on: true });
      } else {
        // 未知標記 → 原樣顯示（避免吃掉作者想寫的大括號）
        for (const c2 of `{${body}}`) {
          ops.push({ type: 'char', ch: c2, color, line });
          if (c2 === '\n') line += 1;
        }
      }
      i = close + 1;
      continue;
    }
    ops.push({ type: 'char', ch, color, line });
    i += 1;
  }
  void instant;
  return ops;
}

/** 依語言取文字（與 schema.pickText 相同語意，這裡避免循環 import 只做必要處理） */
function toText(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  if (isPlainObject(value)) {
    for (const k of ['zh', 'en']) {
      if (typeof value[k] === 'string') return value[k];
    }
  }
  return '';
}

/* ===================================================================== */
/* 打字機                                                                */
/* ===================================================================== */

/**
 * 一個打字機實例（文字框或泡泡共用）。
 *
 * @param {object} opts
 * @param {string} opts.text 純文字（已解析語言）
 * @param {number} [opts.speed] 字/幀
 * @param {string} [opts.color] 預設顏色
 * @param {number} [opts.fps]
 * @param {(evt:{type:string})=>void} [opts.onEvent] 'char' 事件（播語音用）
 */
export function createTypewriter(opts = {}) {
  const ops = parseText(opts.text, opts.color || DEFAULT_COLOR);
  const baseSpeed = Math.max(0, num(opts.speed, 1));
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;

  let pos = 0; // 下一個要處理的 op
  let revealed = 0; // 已顯示字元數
  let acc = 0; // 速度累積
  let pendingWait = 0; // 剩餘等待幀
  let instant = false;
  let speed = baseSpeed;
  let done = false;
  let closed = false;

  // 統計：總字元數、最後一行的索引
  let totalChars = 0;
  let lastLine = 0;
  for (const op of ops) {
    if (op.type === 'char') {
      totalChars += 1;
      lastLine = Math.max(lastLine, op.line);
    }
  }

  function emit(evt) {
    if (!onEvent) return;
    try {
      onEvent(evt);
    } catch (_e) {
      /* 訂閱者錯誤不影響打字 */
    }
  }

  /**
   * 套用目前位置的操作（不顯示字元）。
   *
   * @returns {'char'|'wait'|'ok'} 'char' = 這個 op 是字元（尚未消耗）、
   *   'wait' = 進入等待、'ok' = 已套用
   */
  function applyOp(op) {
    if (op.type === 'char') return 'char';
    if (op.type === 'wait') {
      pos += 1;
      // {i} 立即模式只持續到下一個 {w}，等待結束後回到一般模式
      instant = false;
      const frames = Math.max(0, Math.round(op.frames));
      if (frames > 0) {
        pendingWait = frames;
        return 'wait';
      }
      return 'ok';
    }
    if (op.type === 'speed') {
      // 速度自「下一幀」起生效（本幀的字元預算已在 update 開頭決定）
      speed = Math.max(0, num(op.value, baseSpeed));
      pos += 1;
      return 'ok';
    }
    if (op.type === 'color') {
      pos += 1;
      return 'ok';
    }
    if (op.type === 'instant') {
      instant = op.on !== false;
      pos += 1;
      return 'ok';
    }
    pos += 1;
    return 'ok';
  }

  /** 顯示下一個字元（沿途套用非字元操作）；遇到 {w} 或結尾回傳 false */
  function revealNext() {
    while (pos < ops.length) {
      const op = ops[pos];
      const r = applyOp(op);
      if (r === 'char') {
        pos += 1;
        revealed += 1;
        emit({ type: 'char', ch: op.ch, color: op.color });
        if (pos >= ops.length) done = true;
        return true;
      }
      if (r === 'wait') return false;
    }
    done = true;
    return false;
  }

  /**
   * 把剩下的「零成本」操作（{s} / {c} / {i}）套用完，遇到字元或 {w} 就停。
   * 這樣 {i} 或 {s} 就算剛好落在字元預算用完的同一幀也能立刻生效。
   */
  function flushNonChars() {
    while (pos < ops.length) {
      const op = ops[pos];
      if (op.type === 'char') return;
      const r = applyOp(op);
      if (r === 'wait') return;
    }
    done = true;
  }

  /** {i} 立即模式：把剩下的字全部顯示，直到下一個 {w} */
  function drainInstant() {
    let guard = 0;
    while (pos < ops.length && guard < 100000) {
      guard += 1;
      if (!revealNext()) {
        // 本幀算作等待的第一幀
        if (pendingWait > 0) pendingWait -= 1;
        return;
      }
    }
    done = true;
  }

  /** 立即顯示全部（Z 的第一段行為） */
  function revealAll() {
    while (pos < ops.length) {
      const op = ops[pos];
      if (op.type === 'char') revealed += 1;
      pos += 1;
    }
    pendingWait = 0;
    acc = 0;
    done = true;
  }

  /** 每幀推進 */
  function update() {
    if (closed || done) return;
    if (pendingWait > 0) {
      pendingWait -= 1;
      return;
    }
    // 先套用還沒生效的 {s} / {c} / {i}
    flushNonChars();
    if (done) return;
    if (instant) {
      drainInstant();
      return;
    }
    if (speed <= 0) return;
    acc += speed;
    let budget = 10000; // 保險：避免極大速度時卡住
    while (acc >= 1 && !done && budget > 0) {
      budget -= 1;
      if (!revealNext()) break;
      acc -= 1;
      // 途中遇到 {s} 改速：本幀剩下的字元沿用原本的預算（不重算 acc）
      flushNonChars();
    }
    // 同一幀內遇到 {i}：立刻把剩下的字全部顯示（直到下一個 {w}）
    if (!done && instant) drainInstant();
  }

  /** 目前可見的文字（依行切分，含每段顏色） */
  function visibleLines(defaultColor) {
    const lines = [];
    let current = { runs: [], text: '', color: defaultColor || DEFAULT_COLOR };
    let seen = 0;
    for (const op of ops) {
      if (op.type !== 'char') continue;
      if (seen >= revealed) break;
      seen += 1;
      if (op.ch === '\n') {
        lines.push(current);
        current = { runs: [], text: '', color: defaultColor || DEFAULT_COLOR };
        continue;
      }
      if (current.text === '' && op.color) current.color = op.color;
      const last = current.runs[current.runs.length - 1];
      if (last && last.color === op.color) last.text += op.ch;
      else current.runs.push({ text: op.ch, color: op.color });
      current.text += op.ch;
    }
    lines.push(current);
    return lines;
  }

  return {
    update,
    revealAll,
    visibleLines,
    get done() {
      return done;
    },
    get closed() {
      return closed;
    },
    get visibleChars() {
      return revealed;
    },
    get totalChars() {
      return totalChars;
    },
    get lineCount() {
      return lastLine + 1;
    },
    /** 是否已全部顯示（含被 Z 跳過） */
    get finished() {
      return done || pos >= ops.length;
    },
    markClosed() {
      closed = true;
    },
    /** V2-08：內部進度（給 snapshot/restore 用；ops 由 text 決定，不必存） */
    snapshotState() {
      return {
        pos,
        revealed,
        acc,
        pendingWait,
        instant,
        speed,
        done,
        closed,
      };
    },
    /** V2-08：還原內部進度 */
    restoreState(st) {
      if (!st || typeof st !== 'object') return false;
      pos = Math.max(0, Math.min(ops.length, Math.round(Number(st.pos) || 0)));
      revealed = Math.max(0, Math.round(Number(st.revealed) || 0));
      acc = Number.isFinite(Number(st.acc)) ? Number(st.acc) : 0;
      pendingWait = Math.max(0, Math.round(Number(st.pendingWait) || 0));
      instant = st.instant === true;
      speed = Number.isFinite(Number(st.speed)) ? Number(st.speed) : baseSpeed;
      done = st.done === true;
      closed = st.closed === true;
      return true;
    },
    /** 剩餘等待幀（測試 / 除錯用） */
    get pendingWait() {
      return pendingWait;
    },
  };
}

/* ===================================================================== */
/* 文字系統                                                              */
/* ===================================================================== */

/** 底部文字區在畫面中的位置（依 SPEC-LAYOUT §7：y 405–480） */
export const TEXTBOX_RECT = { x: 30, y: 405, w: 580, h: 75 };

/** 泡泡尺寸（渲染器可用） */
export const BUBBLE_W = 168;

/** 還原快照時抑制 'say' / 'bubble' 事件（避免重播時多發一次） */
let restoringText = false;

/** 泡泡版面常數（SPEC-LAYOUT §8） */
export const BUBBLE_LAYOUT = {
  width: BUBBLE_W,
  gap: 46,
  /** 未知精靈高度時的預設值（邏輯像素，精靈原始尺寸） */
  defaultSpriteHeight: 32,
};

/**
 * 建立文字系統：底部文字框（一次一個）+ 可多個泡泡。
 *
 * @param {object} deps
 * @param {(text:string)=>string} [deps.getLang] 目前語言
 * @param {(name:string)=>void} [deps.onSfx] 音效（語音 / 打字聲）
 * @param {(actorId:string)=>{x:number,y:number}|null} [deps.getActorPos] 泡泡跟隨演員
 * @param {number} [deps.fps]
 */
export function createTextSystem(deps = {}) {
  const fps = num(deps.fps, 30) || 30;
  const getLang = typeof deps.getLang === 'function' ? deps.getLang : () => 'zh';
  const onSfx = typeof deps.onSfx === 'function' ? deps.onSfx : () => {};
  const getActorPos = typeof deps.getActorPos === 'function' ? deps.getActorPos : () => null;
  /** 事件轉發（只觀察，不影響演出）：'say' / 'bubble' */
  const onEvent = typeof deps.onEvent === 'function' ? deps.onEvent : () => {};

  function emitTextEvent(type, payload) {
    try {
      onEvent(type, payload);
    } catch (_err) {
      /* 訂閱者錯誤不影響文字系統 */
    }
  }

  /** @type {object|null} 目前底部文字框 */
  let textbox = null;
  /** @type {object[]} 目前顯示中的泡泡 */
  let bubbles = [];

  /* V2-08：文字 handle 的穩定 id（快照 / 還原時用來把 cue 的 handle 接回來） */
  let slotSeq = 0;
  function nextSlot() {
    slotSeq += 1;
    return slotSeq;
  }

  /** 依 slot 取目前有效的文字 handle（已關閉的回 null） */
  function bySlot(slot) {
    if (!slot) return null;
    if (textbox && textbox.slot === slot && !textbox.closed) return textbox;
    for (const b of bubbles) if (b.slot === slot && !b.closed) return b;
    return null;
  }

  /**
   * 底部文字框（旁白 / 台詞）。
   * @param {object} opts { text, speaker?, portrait?, speed?, voice?, color? }
   * @returns {{done:boolean, cancel:()=>void, revealAll:()=>void, confirm:()=>void}}
   */
  function say(opts = {}) {
    const o = isPlainObject(opts) ? opts : {};
    const raw = o.text === undefined ? '' : o.text;
    const lang = getLang();
    const text = toText(isPlainObject(raw) ? raw[lang] ?? raw.zh ?? raw.en : raw);
    const tw = createTypewriter({
      text,
      speed: o.speed,
      color: o.color,
      fps,
      onEvent(evt) {
        if (evt.type === 'char' && o.voice) onSfx(o.voice);
      },
    });
    const handle = {
      kind: 'say',
      typewriter: tw,
      speaker: o.speaker === undefined ? null : toText(isPlainObject(o.speaker) ? o.speaker[lang] ?? o.speaker.zh : o.speaker),
      portrait: typeof o.portrait === 'string' ? o.portrait : null,
      color: typeof o.color === 'string' ? o.color : DEFAULT_COLOR,
      // V2-08：還原快照時用來重播同一段文字（rawText = 已本地化的純文字）
      rawText: text,
      speed: o.speed,
      slot: 0,
      done: false,
      closed: false,
      revealAll() {
        tw.revealAll();
      },
      /** Z：打字中 → 全顯示；已打完 → 關閉 */
      confirm() {
        if (handle.closed) return;
        if (!tw.finished) {
          tw.revealAll();
          return;
        }
        handle.closed = true;
        tw.markClosed();
        if (textbox === handle) textbox = null;
      },
      cancel() {
        handle.closed = true;
        tw.markClosed();
        if (textbox === handle) textbox = null;
        handle.done = true;
      },
      update() {
        tw.update();
        if (tw.done) handle.done = true;
      },
      snapshot() {
        const lines = tw.visibleLines(handle.color);
        return {
          lines: lines.map((l) => ({ text: l.text, color: l.color, runs: l.runs })),
          visibleChars: tw.visibleChars,
          totalChars: tw.totalChars,
          done: tw.finished,
          speaker: handle.speaker,
          portrait: handle.portrait,
        };
      },
    };
    handle.slot = nextSlot();
    textbox = handle;
    if (!restoringText) emitTextEvent('say', {
      speaker: handle.speaker,
      text,
      portrait: handle.portrait,
      color: handle.color,
    });
    return handle;
  }

  /**
   * 泡泡（掛在演員上）。
   * @param {object} opts { actor, text, side?, speed?, wait?, color? }
   */
  function bubble(opts = {}) {
    const o = isPlainObject(opts) ? opts : {};
    const actorId = typeof o.actor === 'string' ? o.actor : '';
    const raw = o.text === undefined ? '' : o.text;
    const lang = getLang();
    const text = toText(isPlainObject(raw) ? raw[lang] ?? raw.zh ?? raw.en : raw);
    const tw = createTypewriter({
      text,
      speed: o.speed,
      color: o.color,
      fps,
      onEvent(evt) {
        if (evt.type === 'char' && o.voice) onSfx(o.voice);
      },
    });
    const waitRaw = o.wait === undefined ? 'input' : o.wait;
    const waitInput = waitRaw === 'input' || waitRaw === null || waitRaw === undefined;
    const timeoutFrames = waitInput ? 0 : Math.max(0, Math.round(num(waitRaw, 0) * fps));

    const handle = {
      kind: 'bubble',
      actor: actorId,
      // SPEC-LAYOUT §8：預設在說話演員左側
      side: o.side === 'right' || o.side === 'auto' ? o.side : 'left',
      typewriter: tw,
      // V2-08：還原快照時用來重播同一段文字 / 同一個等待模式
      rawText: text,
      speed: o.speed,
      waitRaw: waitRaw,
      color: o.color,
      slot: 0,
      x: 0,
      y: 0,
      w: BUBBLE_LAYOUT.width,
      done: false,
      closed: false,
      afterFrames: 0,
      revealAll() {
        tw.revealAll();
      },
      confirm() {
        if (handle.closed) return;
        if (!tw.finished) {
          tw.revealAll();
          return;
        }
        close();
      },
      cancel() {
        close();
      },
      update() {
        tw.update();
        if (tw.done) handle.done = true;
        // 打完後計時（wait:秒數）
        if (waitInput) return;
        if (tw.finished) {
          handle.afterFrames += 1;
          if (handle.afterFrames >= timeoutFrames) close();
        }
      },
      snapshot() {
        const lines = tw.visibleLines(typeof o.color === 'string' ? o.color : DEFAULT_COLOR);
        return {
          actor: handle.actor,
          x: handle.x,
          y: handle.y,
          w: handle.w,
          side: handle.side,
          lines: lines.map((l) => ({ text: l.text, color: l.color, runs: l.runs })),
          visibleChars: tw.visibleChars,
          totalChars: tw.totalChars,
          done: tw.finished,
        };
      },
    };

    function close() {
      if (handle.closed) return;
      handle.closed = true;
      handle.done = true;
      tw.markClosed();
      const i = bubbles.indexOf(handle);
      if (i >= 0) bubbles.splice(i, 1);
    }

    handle.slot = nextSlot();
    bubbles.push(handle);
    updateBubblePosition(handle);
    if (!restoringText) emitTextEvent('bubble', {
      actor: handle.actor,
      text,
      side: handle.side,
      x: handle.x,
      y: handle.y,
    });
    return handle;
  }

  /**
   * 依演員位置計算泡泡座標（SPEC-LAYOUT §8）。
   *
   * 規則：
   *   - **預設在說話者左側**（`side:'left'`）；`side:'auto'` 時演員在左半邊才放右側。
   *   - 高度對齊**頭部**：演員 y 是腳底錨點，頭部 ≈ y - 精靈高 × 2（精靈放大 2 倍）。
   *     `getActorPos` 可回傳 `{x, y, h}`，h 為精靈原始高度；沒有就用預設值。
   *   - `handle.x` 是「泡泡靠演員那一側的邊」，由 side 決定方向。
   */
  function updateBubblePosition(handle) {
    const pos = getActorPos(handle.actor);
    if (!pos) return;
    let side = handle.side === 'auto' ? 'auto' : handle.side;
    if (side === 'auto') side = pos.x < 320 ? 'right' : 'left';
    handle.side = side;
    const gap = BUBBLE_LAYOUT.gap;
    handle.x = side === 'right' ? pos.x + gap : pos.x - gap;

    // 高度對齊頭部：腳底 y - 精靈高 × 2（SPEC-LAYOUT §8）
    const spriteH = num(pos.h, BUBBLE_LAYOUT.defaultSpriteHeight);
    const scale = num(pos.scale, 1);
    const headY = pos.y - spriteH * 2 * scale;
    // 泡泡底邊對齊頭部（泡泡本身由渲染器往上畫）
    handle.y = headY;
    handle.w = BUBBLE_LAYOUT.width;
  }

  /** 每幀更新 */
  function update() {
    if (textbox) textbox.update();
    // 泡泡位置跟隨演員
    for (const b of bubbles) {
      updateBubblePosition(b);
      b.update();
    }
    // 已關閉的泡泡移除
    for (let i = bubbles.length - 1; i >= 0; i -= 1) {
      if (bubbles[i].closed) bubbles.splice(i, 1);
    }
  }

  /** 處理確認鍵（Z）：優先文字框，其次泡泡 */
  function confirm() {
    if (textbox && !textbox.closed) {
      textbox.confirm();
      return textbox;
    }
    for (const b of bubbles) {
      if (!b.closed) {
        b.confirm();
        return b;
      }
    }
    return null;
  }

  /** 關閉所有文字 */
  function clear() {
    if (textbox) textbox.cancel();
    textbox = null;
    for (const b of bubbles) b.cancel();
    bubbles = [];
  }

  /** 是否有進行中的文字（文字框或泡泡） */
  function busy() {
    const boxBusy = Boolean(textbox && !textbox.closed);
    const bubbleBusy = bubbles.some((b) => !b.closed);
    return boxBusy || bubbleBusy;
  }

  /** §5 state.textbox（沒有時為 null） */
  function snapshotTextbox() {
    if (!textbox || textbox.closed) return null;
    return textbox.snapshot();
  }

  /** §5 state.bubbles */
  function snapshotBubbles() {
    return bubbles.filter((b) => !b.closed).map((b) => b.snapshot());
  }

  function reset() {
    textbox = null;
    bubbles = [];
  }

  /* --------------------------------------------------------- 快照 */

  /**
   * V2-08：文字系統的完整執行期狀態。
   *
   * 文字框 / 泡泡的「文字內容」來自原始 cue（台詞是 cue 的一部分），
   * 所以只存足以重建 handle 的欄位：種類、講者、顏色、位置、
   * 以及打字機的內部進度與計時器。
   *
   * @returns {{textbox:object|null, bubbles:object[]}}
   */
  function snapshotState() {
    const box = textbox && !textbox.closed
      ? {
          kind: 'say',
          slot: textbox.slot,
          speakerRaw: textbox.speaker,
          portrait: textbox.portrait,
          color: textbox.color,
          rawText: textbox.rawText,
          speed: textbox.speed,
          done: textbox.done === true,
          typewriter: textbox.typewriter.snapshotState(),
        }
      : null;
    const bs = [];
    for (const b of bubbles) {
      if (b.closed) continue;
      bs.push({
        kind: 'bubble',
        slot: b.slot,
        actor: b.actor,
        side: b.side,
        waitRaw: b.waitRaw,
        color: b.color,
        rawText: b.rawText,
        speed: b.speed,
        x: b.x,
        y: b.y,
        w: b.w,
        afterFrames: b.afterFrames,
        done: b.done === true,
        typewriter: b.typewriter.snapshotState(),
      });
    }
    return { textbox: box, bubbles: bs, slotSeq };
  }

  /**
   * V2-08：還原 snapshotState()。
   *
   * 文字內容直接由快照裡的 rawText（已本地化的純文字）重播，所以不需要
   * cue 或台詞原文；重播期間抑制 'say' / 'bubble' 事件（不然會多發一次）。
   * slot 一併還原，讓 cue runner 的 say/bubble handle 能接回正確的文字 handle。
   *
   * @returns {boolean}
   */
  function restoreState(st) {
    const s = st && typeof st === 'object' ? st : {};
    textbox = null;
    bubbles = [];
    restoringText = true;
    try {
      if (s.textbox && typeof s.textbox.rawText === 'string') {
        const tb = s.textbox;
        const handle = say({
          text: tb.rawText,
          // speakerRaw 是「已本地化的字串或 null」；null 要傳 undefined，
          // 否則 toText(null) 會得到 ''（與原本的 null 不同）
          speaker: tb.speakerRaw === undefined || tb.speakerRaw === null ? undefined : tb.speakerRaw,
          portrait: tb.portrait === undefined ? undefined : tb.portrait,
          color: tb.color,
          speed: tb.speed,
        });
        handle.typewriter.restoreState(tb.typewriter);
        handle.done = tb.done === true;
        handle.slot = Math.max(0, Math.round(Number(tb.slot) || 0));
        textbox = handle;
      }
      for (const src of Array.isArray(s.bubbles) ? s.bubbles : []) {
        if (typeof src.rawText !== 'string') continue;
        const handle = bubble({
          actor: src.actor,
          text: src.rawText,
          side: src.side,
          speed: src.speed,
          wait: src.waitRaw,
          color: src.color,
        });
        handle.typewriter.restoreState(src.typewriter);
        handle.x = Number(src.x) || 0;
        handle.y = Number(src.y) || 0;
        handle.w = Number(src.w) || BUBBLE_LAYOUT.width;
        handle.afterFrames = Math.max(0, Math.round(Number(src.afterFrames) || 0));
        handle.done = src.done === true;
        handle.slot = Math.max(0, Math.round(Number(src.slot) || 0));
        // bubble() 已經把 handle 放進 bubbles（這裡不再 push，否則會多一個）
      }
    } finally {
      restoringText = false;
    }
    slotSeq = Math.max(slotSeq, Math.round(Number(s.slotSeq) || 0));
    return true;
  }

  return {
    say,
    bubble,
    confirm,
    clear,
    update,
    busy,
    snapshotTextbox,
    snapshotBubbles,
    reset,
    // V2-08：完整執行期狀態（serialization 用；不改行為）
    snapshotState,
    restoreState,
    /** 依 slot 取目前有效的文字 handle（cue runner 快照 / 還原用） */
    bySlot,
    get textbox() {
      return textbox;
    },
    get bubbles() {
      return bubbles;
    },
  };
}

export default createTextSystem;
