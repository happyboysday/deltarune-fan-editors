/**
 * engine/input.js — 鍵盤輸入（SPEC §8 / §9 + SPEC-P2 §2 選單，E2 擁有）
 *
 * export function createInput(target = window) → {
 *   read(): { dx, dy, slow },   // dx/dy ∈ {-1, 0, 1}；slow = 是否按住低速鍵
 *   readFrame(): { dx, dy, slow, press, hold },
 *   pressed(...): boolean,      // 便利查詢，例如 pressed('escape')
 *   anyPressed(): boolean,
 *   justPressed(action): boolean,
 *   destroy(),
 * }
 *
 * 方向鍵 / WASD 移動；X 或 Shift 低速（同時也是「取消」）；Z / Enter 為「確認」。
 * 視窗失焦（blur / visibilitychange）時清空所有按鍵，
 * 避免「按住方向鍵切到別的視窗再回來」造成靈魂持續飄移。
 *
 * 只用 DOM 事件，不依賴 sim；也不自行呼叫 preventDefault 之外的任何引擎邏輯。
 * 方向同時按相反鍵時該軸為 0（不互相抵銷後相加）。
 */

/** 預設的機制按鍵；呼叫端也可以傳入登錄表的動作清單。 */
import { soulActionBindings } from './soul-mechanics.js';

/** code → 動作；同時支援 KeyboardEvent.code 與（必要時）key 值 */
const CODE_MAP = {
  ArrowLeft: 'left',
  ArrowRight: 'right',
  ArrowUp: 'up',
  ArrowDown: 'down',
  KeyA: 'left',
  KeyD: 'right',
  KeyW: 'up',
  KeyS: 'down',
  KeyX: 'slow',
  ShiftLeft: 'slow',
  ShiftRight: 'slow',
  // SPEC-P2 §2：選單確認/取消（同一個實體鍵可對應多個動作，見 EXTRA_ACTIONS）
  KeyZ: 'confirm',
  Enter: 'confirm',
  NumpadEnter: 'confirm',
  Space: 'confirm',
  Escape: 'cancel',
};

/** 舊瀏覽器/特殊鍵盤配置的 key 值備援（code 可為空字串） */
const KEY_MAP = {
  arrowleft: 'left',
  arrowright: 'right',
  arrowup: 'up',
  arrowdown: 'down',
  a: 'left',
  d: 'right',
  w: 'up',
  s: 'down',
  x: 'slow',
  shift: 'slow',
  z: 'confirm',
  enter: 'confirm',
  ' ': 'confirm',
  escape: 'cancel',
};

/**
 * 一個實體鍵對應多個動作（X/Shift 既是 slow 也是 cancel）。
 * @type {Record<string, string[]>}
 */
const EXTRA_ACTIONS = {
  // X / Shift：低速（Phase 1 §9）+ 取消（SPEC-P2 §2 選單）
  slow: ['cancel'],
};

const ACTIONS = ['left', 'right', 'up', 'down', 'slow', 'cancel', 'confirm'];

/** 不該觸發瀏覽器預設捲動/快速搜尋的鍵 */
const PREVENT_CODES = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'Space',
  'Tab',
]);

function isEditableTarget(el) {
  if (!el || typeof el !== 'object') return false;
  const tag = typeof el.tagName === 'string' ? el.tagName.toUpperCase() : '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return el.isContentEditable === true;
}

/** 相容只有方向或只有 hold 的舊呼叫端；明確給出的方向優先。 */
export function normalizeFrameInput(input) {
  const src = input ?? {};
  const hold = src.hold && typeof src.hold === 'object' && !Array.isArray(src.hold) ? src.hold : {};
  return {
    dx: Number.isFinite(src.dx) ? Math.sign(src.dx) || 0 : Number(!!hold.right) - Number(!!hold.left),
    dy: Number.isFinite(src.dy) ? Math.sign(src.dy) || 0 : Number(!!hold.down) - Number(!!hold.up),
    slow: typeof src.slow === 'boolean' ? src.slow : !!hold.slow,
    press: Array.isArray(src.press) ? [...new Set(src.press.filter((key) => typeof key === 'string'))] : [],
    hold,
  };
}

export function createInput(target, { bindings = soulActionBindings(), capture = false } = {}) {
  const host = target || (typeof window !== 'undefined' ? window : null);
  if (!host || typeof host.addEventListener !== 'function') {
    // 無 DOM 環境（Node 無頭測試）：回傳永遠中性的輸入
    return {
      read: () => ({ dx: 0, dy: 0, slow: false }),
      readFrame: () => normalizeFrameInput(),
      snapshot: () => ({ press: [], hold: {} }),
      clearPresses: () => {},
      pressed: () => false,
      anyPressed: () => false,
      justPressed: () => false,
      destroy: () => {},
    };
  }

  /** @type {Map<string, Set<string>>} action → 按住的 code 集合 */
  const heldCodes = new Map([...ACTIONS, ...bindings.map(({ id }) => id)].map((id) => [id, new Set()]));
  const byCode = new Map(Object.entries(CODE_MAP));
  const byKey = new Map(Object.entries(KEY_MAP));
  for (const { id, code } of bindings) {
    byCode.set(code, id);
    if (/^Key[A-Z]$/.test(code)) byKey.set(code.slice(3).toLowerCase(), id);
  }
  /** 本幀內按下的動作（read() 後清空；供選單/快捷鍵使用，不影響 dx/dy） */
  const justPressed = new Set();
  let destroyed = false;

  function releaseAll() {
    for (const set of heldCodes.values()) set.clear();
    justPressed.clear();
  }

  /** 動作清單（含同鍵多重對應，例如 slow → cancel） */
  function actionsFor(action) {
    const extra = EXTRA_ACTIONS[action];
    return extra ? [action, ...extra] : [action];
  }

  function actionFor(event) {
    return byCode.get(event.code) || byKey.get(event.key?.toLowerCase());
  }

  function keyId(event) {
    return event.code || event.key?.toLowerCase();
  }

  function onKeyDown(event) {
    if (destroyed || !event) return;
    if (isEditableTarget(event.target)) return;
    const action = actionFor(event);
    if (!action) return;
    // 已被別的模組處理掉的事件不要搶（例如編輯器輸入框的快捷鍵）；
    // 但「我們自己」為了擋瀏覽器捲動而 preventDefault 的事件要繼續記錄，
    // 否則同一頁有兩個 createInput 實例時，後建立的那個會完全收不到方向鍵。
    if (event.defaultPrevented && event.__drInputOwned !== true) return;
    if (PREVENT_CODES.has(event.code)) {
      try {
        event.preventDefault();
        event.__drInputOwned = true;
      } catch (_err) {
        /* 忽略 */
      }
    }
    const id = keyId(event);
    for (const name of actionsFor(action)) {
      const set = heldCodes.get(name);
      if (id && !set.has(id)) {
        if (set.size === 0 && !event.repeat) justPressed.add(name);
        set.add(id);
      }
    }
  }

  function onKeyUp(event) {
    if (destroyed || !event) return;
    const action = actionFor(event);
    if (!action) return;
    // 放開鍵永遠要處理：若 keydown 被記錄而 keyup 被別的模組 preventDefault，
    // 這裡若跟著跳過就會出現「按鍵卡住、靈魂持續飄移」。
    const id = keyId(event);
    for (const name of actionsFor(action)) {
      const set = heldCodes.get(name);
      if (id) {
        set.delete(id);
      } else {
        set.clear();
      }
    }
  }

  function onBlur() {
    releaseAll();
  }

  function onVisibility() {
    if (typeof document !== 'undefined' && document && document.hidden) releaseAll();
  }

  function isHeld(action) {
    const set = heldCodes.get(action);
    return !!(set && set.size > 0);
  }

  host.addEventListener('keydown', onKeyDown, { passive: false, capture });
  host.addEventListener('keyup', onKeyUp, { passive: false, capture });
  host.addEventListener('blur', onBlur, { passive: true });
  if (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', onVisibility, { passive: true });
  }

  function snapshot() {
    const press = [];
    const hold = {};
    for (const [action, set] of heldCodes) {
      if (justPressed.has(action)) press.push(action);
      hold[action] = set.size > 0;
    }
    return { press, hold };
  }

  function readFrame(opts) {
    const frame = normalizeFrameInput(snapshot());
    if (opts?.consumePresses !== false) justPressed.clear();
    return frame;
  }

  return {
    /**
     * 取本幀輸入。dx/dy ∈ {-1, 0, 1}；slow 為 X / Shift 是否按住。
     * 呼叫後清空 justPressed（dx/dy 仍反映目前按住的鍵）。
     * @param {{ consumePresses?: boolean }} [opts]
     */
    read(opts) {
      const { dx, dy, slow } = readFrame(opts);
      return { dx, dy, slow };
    },
    readFrame,

    /** 便利查詢（不受 read 影響）：action ∈ left/right/up/down/slow */
    pressed(action) {
      return typeof action === 'string' ? isHeld(action) : false;
    },

    /** 本幀內是否剛按下任何方向/低速鍵 */
    anyPressed() {
      return justPressed.size > 0;
    },

    /** 是否剛按下某動作（本幀）：left/right/up/down/slow/cancel/confirm */
    justPressed(action) {
      return justPressed.has(action);
    },

    /**
     * SPEC-P2 §4 的無頭輸入形狀：{ press: string[], hold: {left,...} }。
     * 給 createEncounter().step(n, input) 使用；不消耗 justPressed（可重複讀）。
     * @returns {{ press: string[], hold: Record<string, boolean> }}
     */
    snapshot,

    /** 清空 justPressed（snapshot 用完後呼叫，避免同一鍵連兩幀觸發） */
    clearPresses() {
      justPressed.clear();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      host.removeEventListener('keydown', onKeyDown, capture);
      host.removeEventListener('keyup', onKeyUp, capture);
      host.removeEventListener('blur', onBlur);
      if (
        typeof document !== 'undefined' &&
        document &&
        typeof document.removeEventListener === 'function'
      ) {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      releaseAll();
    },
  };
}

export default createInput;
