/**
 * engine/autoplay/validate.js — 自動演示腳本驗證（SPEC-AUTOPLAY §2 / §3）
 *
 * 對外：
 *   validateAttackDemo(demo)                → [{ path, message }]（本檔實作，AP1）
 *   validateEncounterDemo(demo, encounter)  → [{ path, message }]
 *       ★ 佔位實作（回傳 []）。這個函式的「實作內容」屬 AP2（SPEC §3）：
 *         AP2 目前把實作放在 engine/autoplay/validate-encounter.js
 *         （同一支彙出 validateEncounterDemo）；接線由協調者在整合時處理。
 *         AP1 擁有本檔其餘部分，不改 encounter 相關檔案。
 *
 * 錯誤路徑格式與 engine/attack.js 一致（例如 `demo.path[2].t`、`demo.inputs`），
 * 由 engine/attack.js 的 validateAttack() 直接併入錯誤清單。
 * 這裡的函式「永不丟出例外」——壞資料一律轉成錯誤項目。
 */

import { DEMO_MODES, FALLBACK_MODES, parseEncodedInputs } from './soul.js';

/** 路徑點合法的欄位。 */
const PATH_POINT_FIELDS = ['t', 'x', 'y', 'slow', 'hold'];
/** 示範腳本合法的欄位。 */
const DEMO_FIELDS = ['mode', 'path', 'inputs', 'fallback'];

function isObj(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * 驗證攻擊檔的 `demo` 欄位（SPEC-AUTOPLAY §2.1）。
 *
 * 規則：
 *   - demo 必須是物件；未知欄位只提示（不算錯，方便未來擴充）。
 *   - mode ∈ path | inputs | bot（省略 = 依內容自動判斷）。
 *   - path[]：至少一點；每點 t / x / y 必填且為有限數字；t 遞增（相等可，但建議嚴格遞增）；
 *     slow 布林；hold ≥ 0 的秒數。
 *   - inputs：字串且可解析（行程長度編碼，§2.1）；解析錯誤帶段號。
 *   - fallback ∈ bot | stay。
 *   - mode 指定的內容若不存在 → 錯誤（例如 mode=path 卻沒有 path）。
 *
 * @param {any} demo
 * @returns {{path: string, message: string}[]}
 */
export function validateAttackDemo(demo) {
  const errors = [];
  const add = (path, message) => {
    errors.push({ path, message });
  };

  if (demo === undefined || demo === null) return errors;
  if (!isObj(demo)) {
    add('demo', 'demo 必須是物件');
    return errors;
  }

  for (const key of Object.keys(demo)) {
    if (!DEMO_FIELDS.includes(key)) add(`demo.${key}`, `未知的 demo 欄位（可用：${DEMO_FIELDS.join(' / ')}）`);
  }

  /* --- mode --- */
  let mode = null;
  if (demo.mode !== undefined) {
    if (typeof demo.mode !== 'string' || !DEMO_MODES.includes(demo.mode)) {
      add('demo.mode', `mode 只能是 ${DEMO_MODES.map((m) => `"${m}"`).join(' / ')}（目前 ${JSON.stringify(demo.mode)}）`);
    } else {
      mode = demo.mode;
    }
  }

  /* --- path --- */
  let pathOk = false;
  if (demo.path !== undefined) {
    if (!Array.isArray(demo.path)) {
      add('demo.path', 'path 必須是陣列');
    } else if (demo.path.length === 0) {
      add('demo.path', 'path 至少需要一個路徑點');
    } else {
      let previousT = -Infinity;
      let first = true;
      demo.path.forEach((point, i) => {
        const base = `demo.path[${i}]`;
        if (!isObj(point)) {
          add(base, '路徑點必須是物件');
          return;
        }
        for (const key of Object.keys(point)) {
          if (!PATH_POINT_FIELDS.includes(key)) {
            add(`${base}.${key}`, `未知的路徑點欄位（可用：${PATH_POINT_FIELDS.join(' / ')}）`);
          }
        }
        if (point.t === undefined) {
          add(`${base}.t`, '路徑點需要 t（秒）');
        } else if (!isNum(point.t)) {
          add(`${base}.t`, 't 必須是數字（秒）');
        } else if (point.t < 0) {
          add(`${base}.t`, 't 不可為負數');
        } else {
          if (!first && point.t < previousT) {
            add(`${base}.t`, `t 必須遞增（上一點是 ${previousT}，這一 點是 ${point.t}）`);
          }
          previousT = point.t;
          first = false;
        }
        for (const key of ['x', 'y']) {
          if (point[key] === undefined) add(`${base}.${key}`, `路徑點需要 ${key}`);
          else if (!isNum(point[key])) add(`${base}.${key}`, `${key} 必須是數字（邏輯座標）`);
        }
        if (point.slow !== undefined && typeof point.slow !== 'boolean') {
          add(`${base}.slow`, 'slow 必須是布林值');
        }
        if (point.hold !== undefined) {
          if (!isNum(point.hold)) add(`${base}.hold`, 'hold 必須是秒數');
          else if (point.hold < 0) add(`${base}.hold`, 'hold 不可為負數');
        }
      });
      pathOk = errors.every((error) => !String(error.path).startsWith('demo.path'));
    }
  }

  /* --- inputs --- */
  let inputsOk = false;
  if (demo.inputs !== undefined && demo.inputs !== null) {
    if (typeof demo.inputs !== 'string') {
      add('demo.inputs', 'inputs 必須是字串（行程長度編碼，見 SPEC §2.1）');
    } else if (demo.inputs.trim() === '') {
      add('demo.inputs', 'inputs 不可為空字串（不需要錄製時請刪掉這個欄位）');
    } else {
      const parsed = parseEncodedInputs(demo.inputs);
      for (const err of parsed.errors) add('demo.inputs', err.message);
      if (parsed.errors.length === 0) inputsOk = true;
      // 幀號必須遞增（同一幀重複指定沒有意義 → 錯誤）
      for (let i = 1; i < parsed.entries.length; i += 1) {
        if (parsed.entries[i].frame === parsed.entries[i - 1].frame) {
          add('demo.inputs', `幀號 ${parsed.entries[i].frame} 重複出現（每段幀號必須不同）`);
          break;
        }
      }
    }
  }

  /* --- fallback --- */
  if (demo.fallback !== undefined) {
    if (typeof demo.fallback !== 'string' || !FALLBACK_MODES.includes(demo.fallback)) {
      add('demo.fallback', `fallback 只能是 "bot" 或 "stay"（目前 ${JSON.stringify(demo.fallback)}）`);
    }
  }

  /* --- mode 與內容的一致性 --- */
  const hasPath = Array.isArray(demo.path) && demo.path.length > 0;
  const hasInputs = typeof demo.inputs === 'string' && demo.inputs.trim() !== '';
  if (mode === 'path' && !hasPath) {
    add('demo.mode', 'mode 為 "path" 時需要 path 路徑點');
  } else if (mode === 'path' && !pathOk && demo.path !== undefined) {
    add('demo.path', 'path 有錯誤，無法作為示範路徑');
  }
  if (mode === 'inputs' && !hasInputs) {
    add('demo.mode', 'mode 為 "inputs" 時需要 inputs 字串');
  }
  if (mode === undefined && !hasPath && !hasInputs) {
    // 沒有 mode、path、inputs → 等同全程 bot，合法（只是 demo 沒作用）
  }

  return errors;
}

/**
 * 驗證遭遇檔的 `demo`（SPEC-AUTOPLAY §2.2）。
 *
 * ★ 佔位實作：實作內容屬 AP2。AP2 目前把實作放在
 *   engine/autoplay/validate-encounter.js（彙出同名函式）；整合時把本函式改成
 *   `export { validateEncounterDemo } from './validate-encounter.js'` 即可。
 *   在接線前這裡回傳空陣列（不誤報），避免 Phase 1（AP1）與 AP2 互改同檔。
 *
 * @param {any} demo
 * @param {any} [encounter] 正規化後的遭遇檔（提供 party / turns / enemies 供檢查）
 * @returns {{path: string, message: string}[]}
 */
export { validateEncounterDemo } from './validate-encounter.js';

export default validateAttackDemo;
