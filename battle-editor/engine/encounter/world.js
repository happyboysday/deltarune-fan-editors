/**
 * engine/encounter/world.js — 遭遇世界（SPEC-P2 §4）
 *
 * 這裡是「遭遇戰的資料層」：演員、文字框 / 泡泡、傷害數字、變數、
 * 隊伍 / 敵人 / 道具 / TP，以及一段彈幕回合（內部用 Phase 1 createSimulation）。
 *
 * 介面（SPEC-P2 §4，E1 ↔ FL 的接縫）：
 *   createWorld(encounter, { rng, fps, resolvedAttacks, onEvent }) → world
 *   world.actors.get(id) / setAnim(id, name) / list()
 *   world.text.say(opts) / bubble(opts) / clear()
 *   world.party / world.enemies / world.items / world.vars / world.tp
 *   world.startAttack(ref) → handle   // 同步隊伍 HP / TP；handle.done
 *   world.damageNumber(x, y, text, color)
 *   world.update(input)               // 每幀：演員補間、動畫、打字機、子彈回合
 *   world.snapshot()                  // §5 的大部分欄位
 *
 * 本模組與 Phase 1 一樣**完全不碰 DOM**，可 Node 無頭執行。
 */

import { createRng } from '../rng.js';
import { SoulConfigurationError } from '../soul-mechanics.js';
import { createSimulation } from '../sim.js';
import { normalizeFrameInput } from '../input.js';
import { createActorSystem } from './actors.js';
import { createTextSystem, resolveColor, DEFAULT_COLOR } from './text.js';
import { isPlainObject, num, bool, pickText, normalizeCueList, deepClone, RESULT_TYPES } from './schema.js';
import { evalNumber, createHelpers, makeContext, createLookup } from '../expr.js';
import { LAYOUT, partyFeetFor } from './layout.js';

/**
 * 戰鬥框展開 / 收起的補間幀數。
 * SPEC-LAYOUT §5：從中心旋轉+縮放展開，約 8–10 幀 → 取 9 幀。
 */
export const BOX_ANIM_FRAMES = LAYOUT.BOX_ANIM_FRAMES;

/** 戰鬥框展開時的最大旋轉角（度）：由 ±90 收斂到 0（SPEC-LAYOUT §5） */
export const BOX_ANIM_ROTATION = LAYOUT.BOX_ANIM_ROTATION;

/** 傷害數字的存活幀數（SPEC-LAYOUT §9：約 1 秒後淡出） */
export const NUMBER_LIFE = LAYOUT.NUMBER.life;

/** 傷害數字的堆疊行距（SPEC-LAYOUT §9） */
export const NUMBER_LINE_HEIGHT = LAYOUT.NUMBER.lineHeight;

/** 同一次結算的判定窗（幀）：這段期間內對同一目標的數字會往下堆疊 */
export const NUMBER_STACK_WINDOW = 4;

/** TP 上限（SPEC Phase 1：0..100） */
export const TP_MAX = 100;

/** 流程腳本使用 has()；模擬核心只接收逐幀輸入。 */
export function normalizeInput(input) {
  const frame = normalizeFrameInput(input);
  return {
    ...frame,
    has(key) {
      return frame.press.includes(key);
    },
  };
}

/**
 * 建立遭遇世界。
 *
 * @param {object} encounter normalizeEncounter() 的結果
 * @param {object} [opts]
 * @param {object} [opts.rng] 亂數流（不給就用 settings.seed 建立）
 * @param {number} [opts.fps]
 * @param {Map<string,object>|object} [opts.resolvedAttacks] 攻擊名 → 攻擊 JSON（index.load() 預先解析）
 * @param {(name:string)=>number} [opts.spriteFrames] 素材實際幀數查詢（非循環動畫長度／最後一幀用；省略 = 退回規則）
 * @param {(type:string, payload:any)=>void} [opts.onEvent]
 */
export function createWorld(encounter, opts = {}) {
  const fps = num(opts.fps, 30) || 30;
  const enc = encounter || {};
  const settings = enc.settings || {};
  const onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : () => {};
  const rng = opts.rng && typeof opts.rng.next === 'function' ? opts.rng : createRng(num(settings.seed, 1));
  const resolved = opts.resolvedAttacks || new Map();

  /** 戰鬥語言（'zh' | 'en'）；由 index.setOptions 設定 */
  let lang = opts.lang === 'en' ? 'en' : 'zh';

  /* ------------------------------------------------------------ 演員 */

  const actors = createActorSystem(enc.actors || {}, { spriteFrames: opts.spriteFrames });

  /* ------------------------------------------------------------ 隊伍 */

  /** @type {object[]} 隊伍執行期狀態（順序 = 遭遇檔順序） */
  let party = (enc.party || []).map((p, i) => ({
    id: p.id,
    actor: p.actor,
    icon: p.icon,
    nameRaw: p.name,
    // FL 的 menu.js / fight.js 直接讀 `.name` 再交給 textOf() 本地化，
    // 所以這裡放原始字串或 {zh,en} 物件（與 nameRaw 相同）；對外 snapshot 才是本地化字串。
    name: p.name,
    hp: p.hp,
    maxHp: p.maxHp,
    atk: p.atk,
    def: p.def,
    magic: p.magic,
    color: p.color,
    commands: p.commands.slice(),
    spells: p.spells,
    index: i,
    x: 120 + i * 90,
    y: 200,
    defending: false,
    action: null,
    down: p.hp <= 0,
    lastHurtFrame: -999,
  }));

  /** @type {object[]} 敵人執行期狀態 */
  let enemies = (enc.enemies || []).map((e) => ({
    id: e.id,
    actor: e.actor,
    nameRaw: e.name,
    // 同上：FL 直接讀 `.name`（原始字串或 {zh,en}），snapshot 才本地化
    name: e.name,
    hp: e.hp,
    maxHp: e.maxHp,
    atk: e.atk,
    def: e.def,
    mercy: e.mercy,
    spareAt: e.spareAt,
    tired: e.tired,
    acts: e.acts,
    onHurt: e.onHurt,
    onSpare: e.onSpare,
    onDefeat: e.onDefeat,
    removed: false,
    downed: false,
  }));

  /** @type {object[]} 道具（count 0 視為用完） */
  let items = (enc.items || []).map((it) => ({ ...it }));

  /** 自訂變數 */
  const vars = { ...(enc.vars || {}) };

  /** 本場各 ACT 已使用次數：key = `${enemyId}_${actId}` */
  const actCounts = new Map();

  /** 目前回合索引（0 起算；flow 透過 setTurn 更新，供表達式 turn 用） */
  let turnIndex = 0;

  /** 遭遇 TP（0..100） */
  let tp = 0;

  /**
   * 改 TP 並發事件（只觀察用，行為與直接賦值相同）。
   * @param {number} value
   * @param {string} [cause] 'set' | 'graze' | 'defend' | 'magic' | ...
   */
  function setTp(value, cause = 'set') {
    const before = tp;
    const next = Math.max(0, Math.min(TP_MAX, num(value, 0)));
    if (next === before) return tp;
    tp = next;
    emit('tp', { before, after: tp, amount: tp - before, cause, frame });
    return tp;
  }

  /* ------------------------------------------------------------ 文字 */

  const text = createTextSystem({
    fps,
    getLang: () => lang,
    onSfx: (name) => {
      sfxQueue.push(name);
    },
    getActorPos: (id) => {
      const a = actors.get(id);
      if (!a) return null;
      // 形態 offset / scale 會影響顯示位置（SPEC-P2 §1 forms）
      if (typeof actors.displayPos === 'function') {
        const p = actors.displayPos(id);
        if (p) return p;
      }
      // 回傳頭部對齊所需資訊（精靈原始高度 × 演員縮放；SPEC-LAYOUT §8）
      return { x: a.x, y: a.y, h: num(a.def && a.def.spriteH, 32), scale: num(a.scale, 1) };
    },
    // 台詞事件（只轉發，不影響演出）：say / bubble 建立時通知遭遇層
    onEvent: (type, payload) => emit(type, payload),
  });

  /* ------------------------------------------------------------ 暫態 */

  /** @type {object[]} 傷害 / 回復數字 */
  let numbers = [];
  /** @type {{color:string, alpha:number}|null} 閃光 */
  let flash = null;
  /** @type {{color:string, alpha:number, target:number, speed:number}|null} 淡出（黑幕） */
  let fade = null;
  /** 螢幕震動（cue 的 shake；與彈幕回合的 shake 分開） */
  let shake = { amount: 0, elapsed: 0, duration: 0, x: 0, y: 0 };
  /** 戰鬥框展開進度 0..1 */
  let boxAnim = 0;
  /** 音效佇列（本幀要播的） */
  let sfxQueue = [];
  /** 本幀 frame 計數（world 自己的） */
  let frame = 0;

  /** @type {object|null} 進行中的彈幕回合 */
  let battle = null;

  /* ------------------------------------------------------- 查表物件 */

  function partyById(id) {
    for (const p of party) if (p.id === id) return p;
    return null;
  }
  function enemyById(id) {
    for (const e of enemies) if (e.id === id) return e;
    return null;
  }

  /** ACT 次數查表：先試 `${enemyId}_${actId}`，再逐一比對（id 含底線時的保險） */
  function lookupActCount(key) {
    if (actCounts.has(key)) return actCounts.get(key);
    for (const e of enemies) {
      for (const a of e.acts) {
        if (`${e.id}_${a.id}` === key) return actCounts.get(key) || 0;
      }
    }
    return 0;
  }

  const lookups = {
    mercy: createLookup((name) => {
      const e = enemyById(name);
      return e ? e.mercy : 0;
    }),
    hp: createLookup((name) => {
      const p = partyById(name);
      if (p) return p.hp;
      const e = enemyById(name);
      return e ? e.hp : 0;
    }),
    maxHp: createLookup((name) => {
      const p = partyById(name);
      if (p) return p.maxHp;
      const e = enemyById(name);
      return e ? e.maxHp : 0;
    }),
    alive: createLookup((name) => {
      const p = partyById(name);
      if (p) return p.hp > 0 ? 1 : 0;
      const e = enemyById(name);
      if (e) return !e.removed && e.hp > 0 ? 1 : 0;
      return 0;
    }),
    actCount: createLookup((name) => lookupActCount(name)),
    vars: createLookup((name) => num(vars[name], 0)),
  };

  /* ------------------------------------------------------------ 表達式 */

  /** 目前靈魂位置（沒有彈幕回合時用畫面中心，僅供 aim() 之類使用） */
  function soulPos() {
    if (battle && battle.sim) {
      const s = battle.sim.soul;
      if (s) return { x: s.x, y: s.y };
    }
    return { x: 320, y: 240 };
  }

  const helpers = createHelpers(rng, soulPos);

  /** 目前的表達式 context（戰鬥框用畫面中央的預設值；彈幕回合由 sim 自己算） */
  function exprContext(extra) {
    const e = extra || {};
    const box = battle && battle.sim ? battle.sim.box : { x: 320, y: 240, w: 320, h: 160 };
    return makeContext({
      t: num(e.t, 0),
      T: num(e.T, 0),
      i: num(e.i, 0),
      n: num(e.n, 1),
      k: num(e.k, 0),
      age: num(e.age, 0),
      box,
      soul: soulPos(),
      turn: turnIndex,
      tp,
      lookups,
    });
  }

  /**
   * 求值一個遭遇層表達式。永不 throw。
   * @param {number|string|boolean|null|undefined} raw
   * @returns {{value:number, error:string|null}}
   */
  function evalExprDetailed(raw) {
    const ctx = exprContext();
    return evalNumber(raw, ctx, helpers, lookups);
  }

  /**
   * 求值並回傳數字（錯誤 → 0）。
   * @param {number|string|boolean|null|undefined} raw
   * @param {(message:string)=>void} [report] 錯誤回報
   */
  function evalExpr(raw, report) {
    const r = evalExprDetailed(raw);
    if (r.error && typeof report === 'function') report(r.error);
    return r.value;
  }

  /* ------------------------------------------------------------ 事件 */

  function emit(type, payload) {
    try {
      onEvent(type, payload);
    } catch (_e) {
      /* 訂閱者錯誤不影響模擬 */
    }
  }

  /** 回報錯誤（cue 執行器 / 表達式用；不中斷演出） */
  function emitError(message, cue) {
    emit('error', {
      path: cue && typeof cue === 'object' ? cue.cmd || '' : '',
      message: String(message === undefined ? '' : message),
      cue: cue || null,
      frame,
    });
  }

  /**
   * 請求結束遭遇（cue: end）。實際狀態轉移由 flow 處理；
   * 沒有 flow 時（降級模式）由 index 直接收尾。
   */
  let pendingEnd = null;
  function requestEnd(result) {
    pendingEnd = RESULT_TYPES.includes(result) ? result : 'victory';
    emit('endRequest', { result: pendingEnd });
  }
  function consumeEndRequest() {
    const r = pendingEnd;
    pendingEnd = null;
    return r;
  }

  /** 背景音樂（沒有 audio 模組時只記錄，由 index 轉發） */
  let bgmState = { track: settings.bgm || null, fade: 0, seq: 0 };
  function playBgm(track, fade = 0) {
    bgmState = {
      track: typeof track === 'string' && track ? track : null,
      fade: Math.max(0, num(fade, 0)),
      seq: bgmState.seq + 1,
    };
    emit('bgm', { track: bgmState.track, fade: bgmState.fade });
  }
  function getBgm() {
    return bgmState;
  }

  function pushSfx(name) {
    if (typeof name !== 'string' || !name) return;
    sfxQueue.push(name);
  }

  /* ------------------------------------------------------------ 數值 */

  /**
   * 傷害 / 回復數字（SPEC-LAYOUT §9）。
   *
   * 追加語意（相對 Phase 2 初版）：
   *   - `opts.stackKey`（目標 id）在同一次結算（NUMBER_STACK_WINDOW 幀內）重複出現時，
   *     由**上往下**堆疊：第 2 個 +20、第 3 個 +40…（行距 20）。
   *   - 位置預設在目標演員**身體右側**（用 opts.target 自動定位）。
   *   - 顏色預設為 `opts.color`（出手者角色色）；沒給才用系統預設。
   *   - 回傳 number 物件（可用來改欄位），並附 `vy` / `settled` 供渲染做「先上彈後停」。
   *
   * @param {number} x
   * @param {number} y
   * @param {string|number} label
   * @param {string} [color]
   * @param {object} [opts] { target?, source?, stackKey?, index? }
   */
  function damageNumber(x, y, label, color, opts = {}) {
    const o = isPlainObject(opts) ? opts : {};
    const text2 = typeof label === 'number' ? String(Math.round(label)) : String(label === undefined ? '' : label);
    if (!text2) return null;

    // 顏色：明確給的 → 出手者角色色 → 白色
    let col = null;
    if (typeof color === 'string' && color) col = resolveColor(color) || color;
    if (!col && typeof o.source === 'string') {
      const src = partyById(o.source);
      if (src && typeof src.color === 'string') col = resolveColor(src.color) || src.color;
    }
    if (!col) col = '#ffffff';

    // 堆疊：同一 target 在短時間內連續跳字 → 由上往下
    const key = o.stackKey === undefined || o.stackKey === null ? o.target : o.stackKey;
    let row = 0;
    let px = num(x, 320);
    let py = num(y, 200);
    if (key !== undefined && key !== null && key !== '') {
      let used = 0;
      for (let i = numbers.length - 1; i >= 0; i -= 1) {
        const prev = numbers[i];
        if (prev.stackKey !== key) continue;
        if (o.resetStack) break;
        if (frame - prev.startFrame > NUMBER_STACK_WINDOW) break;
        used = Math.max(used, (prev.row === undefined ? 0 : prev.row) + 1);
        if (used >= 6) break;
      }
      row = used;
      if (o.target && positionOf(o.target)) {
        const pos = positionOf(o.target);
        px = pos.x + LAYOUT.NUMBER.offsetX;
        py = pos.y + LAYOUT.NUMBER.offsetY + row * LAYOUT.NUMBER.lineHeight;
      } else {
        py += row * LAYOUT.NUMBER.lineHeight;
      }
    }

    const entry = {
      x: px,
      y: py,
      baseX: px,
      baseY: py,
      text: text2,
      color: col,
      age: 0,
      life: LAYOUT.NUMBER.life,
      startFrame: frame,
      stackKey: key === undefined ? null : key,
      row,
      /** 上彈速度（px/幀）；負值 = 往上 */
      vy: LAYOUT.NUMBER.bounceVy,
      /** 是否已落定（停住不動） */
      settled: false,
      /** MISS 等用灰色顯示 */
      miss: Boolean(o.miss),
    };
    if (o.miss) entry.color = '#808080';
    numbers.push(entry);
    if (numbers.length > LAYOUT.NUMBER.max) numbers.shift();
    return entry;
  }

  /** 隊員 / 敵人的螢幕位置（給數字與特效定位） */
  function actorDisplayPos(actorId) {
    if (!actorId) return null;
    const a = actors.get(actorId);
    if (!a) return null;
    // 形態 offset 會影響顯示位置（SPEC-P2 §1 forms）
    if (typeof actors.displayPos === 'function') return actors.displayPos(actorId);
    return { x: a.x, y: a.y };
  }

  function positionOf(id) {
    const member = partyById(id);
    if (member) {
      const p = actorDisplayPos(member.actor);
      return p ? { x: p.x, y: p.y - 30 } : { x: member.x, y: member.y - 30 };
    }
    const enemy = enemyById(id);
    if (enemy) {
      const p = actorDisplayPos(enemy.actor);
      return p ? { x: p.x, y: p.y - 30 } : { x: 520, y: 170 };
    }
    return { x: 320, y: 200 };
  }

  /**
   * 對一個目標造成傷害。
   * @param {string} target 隊員 id / 敵人 id / "party" / "all"
   * @param {number} amount
   * @param {{silent?:boolean}} [opts]
   * @returns {{id:string, kind:string, from:number, to:number, amount:number}[]}
   */
  function applyDamage(target, amount, opts = {}) {
    const dmg = Math.max(0, Math.round(num(amount, 0)));
    const out = [];
    const targets = [];
    if (target === 'party' || target === 'all') {
      for (const p of party) if (p.hp > 0) targets.push({ kind: 'party', obj: p });
      if (target === 'all') for (const e of enemies) if (!e.removed && e.hp > 0) targets.push({ kind: 'enemy', obj: e });
    } else {
      const p = partyById(target);
      if (p) targets.push({ kind: 'party', obj: p });
      else {
        const e = enemyById(target);
        if (e) targets.push({ kind: 'enemy', obj: e });
      }
    }
    for (const t of targets) {
      const from = t.obj.hp;
      const to = Math.max(0, from - dmg);
      t.obj.hp = to;
      if (t.kind === 'party') {
        t.obj.lastHurtFrame = frame;
        if (to <= 0) {
          t.obj.down = true;
          if (t.obj.actor) actors.setAnim(t.obj.actor, 'down', { loop: false });
        } else if (t.obj.actor) {
          actors.hurt(t.obj.actor);
          // 沒有 hurt 動畫的演員（例如變形中的敵人）沿用目前動畫，不要退回 idle
          actors.setAnim(t.obj.actor, 'hurt', { keepIfMissing: true, loop: false });
        }
      } else {
        if (to <= 0) t.obj.downed = true;
        if (t.obj.actor) {
          actors.hurt(t.obj.actor);
          // 沒有 hurt 動畫的演員（例如變形中的敵人）沿用目前動畫，不要退回 idle
          actors.setAnim(t.obj.actor, 'hurt', { keepIfMissing: true, loop: false });
        }
      }
      if (!opts.silent) {
        // SPEC-LAYOUT §9：數字在目標右側、由出手者顏色、同結算內往下堆疊
        damageNumber(0, 0, `-${from - to}`, null, {
          target: t.obj.id,
          stackKey: t.obj.id,
          source: opts.source,
          miss: opts.miss === true,
        });
      }
      out.push({ id: t.obj.id, kind: t.kind, from, to, amount: from - to });
      // 只加事件（不影響行為）：HP 變化，damage / heal 共用
      // 已經 0 HP 的目標再吃傷害不會有任何變化 → 不發事件（避免 amount:0 的雜訊）
      if (from !== to) {
        emit('hp', {
          id: t.obj.id,
          kind: t.kind,
          from,
          to,
          amount: from - to,
          cause: 'damage',
          source: opts.source === undefined ? null : opts.source,
          frame,
        });
      }
    }
    return out;
  }

  /**
   * 回復。
   * @param {string} target
   * @param {number} amount
   * @param {{silent?:boolean}} [opts]
   */
  function applyHeal(target, amount, opts = {}) {
    const heal = Math.max(0, Math.round(num(amount, 0)));
    if (heal <= 0) return [];
    const out = [];
    const targets = [];
    if (target === 'party' || target === 'all') {
      for (const p of party) if (p.hp > 0 || target === 'all') targets.push({ kind: 'party', obj: p });
      if (target === 'all') for (const e of enemies) if (!e.removed) targets.push({ kind: 'enemy', obj: e });
    } else {
      const p = partyById(target);
      if (p) targets.push({ kind: 'party', obj: p });
      else {
        const e = enemyById(target);
        if (e) targets.push({ kind: 'enemy', obj: e });
      }
    }
    for (const t of targets) {
      const from = t.obj.hp;
      const to = Math.min(t.obj.maxHp, from + heal);
      t.obj.hp = to;
      if (t.kind === 'party' && to > 0) t.obj.down = false;
      if (!opts.silent) {
        damageNumber(0, 0, `+${to - from}`, '#40ff80', {
          target: t.obj.id,
          stackKey: t.obj.id,
          source: opts.source,
        });
      }
      out.push({ id: t.obj.id, kind: t.kind, from, to, amount: to - from });
      // 只加事件（不影響行為）：HP 變化（沒變就不發）
      if (from !== to) {
        emit('hp', {
          id: t.obj.id,
          kind: t.kind,
          from,
          to,
          amount: to - from,
          cause: 'heal',
          source: opts.source === undefined ? null : opts.source,
          frame,
        });
      }
    }
    return out;
  }

  /** 調整敵人 mercy（夾 0..100） */
  function addMercy(enemyId, amount) {
    const e = enemyById(enemyId);
    if (!e) return 0;
    const before = e.mercy;
    e.mercy = Math.max(0, Math.min(100, before + num(amount, 0)));
    // 只加事件（不影響行為）：mercy 前後值（沒變就不發）
    if (e.mercy !== before) {
      emit('mercy', { id: enemyId, before, after: e.mercy, amount: e.mercy - before, frame });
    }
    return e.mercy;
  }

  /** 移除敵人（演員淡出） */
  function removeEnemy(enemyId, opts = {}) {
    const e = enemyById(enemyId);
    if (!e) return false;
    e.removed = true;
    if (e.actor) {
      if (opts.fade === false) actors.setVisible(e.actor, false);
      else actors.setAlpha(e.actor, 0, num(opts.duration, 0.4));
    }
    emit('enemyRemoved', { id: enemyId });
    return true;
  }

  /** 記錄一次 ACT 使用（供 actCount.xxx 表達式） */
  function recordAct(enemyId, actId) {
    const key = `${enemyId}_${actId}`;
    actCounts.set(key, (actCounts.get(key) || 0) + 1);
    return actCounts.get(key);
  }

  /** 讀取自訂變數 */
  function getVar(name) {
    return num(vars[name], 0);
  }

  /** 設定自訂變數（op: 'set' | 'add'） */
  function setVar(name, value, op = 'set') {
    if (typeof name !== 'string' || !name) return 0;
    const v = num(value, 0);
    vars[name] = op === 'add' ? num(vars[name], 0) + v : v;
    return vars[name];
  }

  /* ------------------------------------------------------- 彈幕回合 */

  /** 從 resolvedAttacks（Map 或物件）取攻擊 JSON */
  function resolveAttackRef(ref) {
    if (isPlainObject(ref)) return deepClone(ref);
    if (typeof ref !== 'string' || !ref) return null;
    if (resolved instanceof Map) {
      const v = resolved.get(ref);
      return isPlainObject(v) ? deepClone(v) : null;
    }
    if (isPlainObject(resolved) && isPlainObject(resolved[ref])) return deepClone(resolved[ref]);
    return null;
  }

  /**
   * 開始一段彈幕回合。內部建立 Phase 1 createSimulation。
   * @param {string|object} ref 攻擊檔名或內嵌攻擊
   * @returns {{done:boolean, cancel:()=>void, attack:object|null, sim:object|null}}
   */
  function startAttack(ref) {
    // 已有回合時先收掉（避免重疊）
    if (battle) closeBattle(true);

    const src = resolveAttackRef(ref);
    const handle = {
      done: false,
      attack: null,
      sim: null,
      ref: typeof ref === 'string' ? ref : null,
      cancel() {
        if (!battle || battle.handle !== handle) {
          handle.done = true;
          return;
        }
        closeBattle(true);
        handle.done = true;
      },
    };

    if (!src) {
      pushSfx('snd_nosound');
      emit('error', {
        path: 'attack',
        message: typeof ref === 'string' ? `找不到攻擊檔 "${ref}"` : '攻擊參照不合法',
      });
      handle.done = true;
      return handle;
    }

    // 把遭遇隊伍塞進攻擊檔（彈幕受傷由 world 依 hit 事件結算，這裡僅供顯示 / 碰撞用）
    src.party = party.map((p) => ({
      name: p.id,
      hp: Math.max(1, p.hp > 0 ? p.hp : 1),
      maxHp: p.maxHp,
      color: p.color,
      icon: null,
    }));

    const sim = createSimulation({
      mode: 'play',
      onEvent: (evt) => onBattleEvent(handle, evt),
    });
    try {
      sim.load(src);
    } catch (error) {
      if (!(error instanceof SoulConfigurationError)) throw error;
      emit('error', { path: 'attack.' + error.path, message: (handle.ref ?? 'inline') + ': ' + error.message });
      handle.done = true;
      return handle;
    }

    battle = {
      sim,
      handle,
      attack: sim.attack,
      tpBase: 0,
      hitCount: 0,
      grazeCount: 0,
      closing: false,
    };
    handle.attack = sim.attack;
    handle.sim = sim;
    boxAnim = Math.max(boxAnim, 0.01);
    emit('attackStart', { ref: handle.ref, duration: sim.durationFrames() });
    return handle;
  }

  /** 彈幕回合的事件轉接（命中 / 擦彈 / 錯誤 / 結束） */
  function onBattleEvent(handle, evt) {
    if (!evt || !evt.type) return;
    if (evt.type === 'anim') {
      const { actor, anim } = evt.payload;
      actors.setAnim(actor, anim, { keepIfMissing: true });
      return;
    }
    if (evt.type === 'hit') {
      const payload = evt.payload || {};
      const raw = num(payload.damage, 0);
      // Phase 2：隨機一位存活隊員（以 seed）；defend 減半
      const alive = party.filter((p) => p.hp > 0);
      if (alive.length > 0) {
        const pick = alive[rng.int(0, alive.length - 1)];
        const halved = pick.defending ? Math.round(raw / 2) : raw;
        const dmg = raw > 0 ? Math.max(1, halved) : 0;
        pick.hp = Math.max(0, pick.hp - dmg);
        pick.lastHurtFrame = frame;
        if (pick.hp <= 0) {
          pick.down = true;
          if (pick.actor) actors.setAnim(pick.actor, 'down', { loop: false });
        } else if (pick.actor) {
          actors.hurt(pick.actor);
          // 隊員正常都有 hurt；沿用目前動畫的語意與敵人一致（避免缺動畫時閃回 idle）
          actors.setAnim(pick.actor, 'hurt', { keepIfMissing: true, loop: false });
        }
        // SPEC-LAYOUT §9：受傷數字在隊員右側（party 沒有「出手者」，用隊員自身顏色）
        damageNumber(0, 0, `-${dmg}`, null, {
          target: pick.id,
          stackKey: pick.id,
          source: pick.id,
        });
        if (battle) battle.hitCount += 1;
        emit('hurt', {
          member: pick.id,
          damage: dmg,
          hp: pick.hp,
          frame,
          bulletType: payload.type || null,
        });
      }
      return;
    }
    if (evt.type === 'graze') {
      if (battle) battle.grazeCount += 1;
      emit('graze', evt.payload);
      return;
    }
    if (evt.type === 'error') {
      emit('error', evt.payload);
      return;
    }
    if (evt.type === 'end') {
      // 只加欄位（行為不變）：攻擊結束時附上本回合命中 / 擦彈次數，模擬器要統計
      emit('attackEnd', {
        ref: handle ? handle.ref : null,
        frame,
        hits: battle ? battle.hitCount : 0,
        grazes: battle ? battle.grazeCount : 0,
      });
    }
  }

  /** 收掉目前彈幕回合（cancel 也走這裡） */
  function closeBattle(canceled) {
    if (!battle) return;
    const b = battle;
    battle = null;
    if (canceled) {
      const st = b.sim.getState();
      sfxQueue = [];
      void st;
    }
    b.handle.done = true;
    emit('attackClose', { ref: b.handle.ref, canceled: Boolean(canceled) });
  }

  /** 目前是否有彈幕回合在跑 */
  function attackActive() {
    return Boolean(battle && !battle.closing);
  }

  /* ------------------------------------------------------------ 更新 */

  /** 螢幕震動 */
  function applyShake() {
    if (shake.duration <= 0) {
      shake.x = 0;
      shake.y = 0;
      return;
    }
    shake.elapsed += 1;
    const u = Math.min(1, shake.elapsed / shake.duration);
    const amount = shake.amount * (1 - u);
    // 以 frame 為種子的確定性抖動
    shake.x = Math.sin((frame + 1) * 12.9898) * amount;
    shake.y = Math.cos((frame + 1) * 78.233) * amount;
    if (u >= 1) {
      shake.duration = 0;
      shake.amount = 0;
      shake.x = 0;
      shake.y = 0;
    }
  }

  /**
   * 每幀更新。
   * @param {object} [rawInput] { press:[], hold:{} }
   */
  function update(rawInput) {
    const input = normalizeFrameInput(rawInput);
    frame += 1;

    // 1) 演員（位置補間、動畫、透明度）
    actors.update();

    // 2) 文字（打字機）
    text.update();

    // 3) 彈幕回合
    if (battle) {
      const sim = battle.sim;
      if (!sim.ended) {
        sim.stepFrame(input);
        // TP 同步：擦彈累積到遭遇 TP
        const st = sim.getState();
        const delta = st.tp - battle.tpBase;
        if (delta > 0) setTp(tp + delta, 'graze');
        battle.tpBase = st.tp;
        // 音效轉發
        for (const s of sim.drainSfx()) pushSfx(s);
      } else if (battle.closing) {
        // 已經結束一幀：收掉回合（戰鬥框接著收回）
        closeBattle(false);
      } else {
        // 讓 handle.done 在「結束那一幀」就成立，cue runner 同幀可續跑
        battle.handle.done = true;
        battle.closing = true;
        for (const s of sim.drainSfx()) pushSfx(s);
      }
    } else if (boxAnim > 0) {
      boxAnim = Math.max(0, boxAnim - 1 / BOX_ANIM_FRAMES);
    }

    // 4) 戰鬥框展開進度
    if (battle) {
      boxAnim = Math.min(1, boxAnim + 1 / BOX_ANIM_FRAMES);
    }

    // 5) 數字老化（SPEC-LAYOUT §9：先上彈再停住，約 30 幀後淡出）
    for (let i = numbers.length - 1; i >= 0; i -= 1) {
      const n = numbers[i];
      n.age += 1;
      if (!n.settled) {
        // 上彈：套重力，速度反轉（往下）時落定
        n.y += n.vy;
        n.vy += LAYOUT.NUMBER.bounceGravity;
        if (n.vy >= 0) {
          n.vy = 0;
          n.settled = true;
        }
      }
      if (n.age >= n.life) numbers.splice(i, 1);
    }

    // 6) 閃光 / 淡出衰減
    if (flash) {
      flash.alpha = Math.max(0, flash.alpha - (flash.speed || 0.08));
      if (flash.alpha <= 0) flash = null;
    }
    if (fade) {
      const d = fade;
      if (Math.abs(d.alpha - d.target) <= d.speed) d.alpha = d.target;
      else d.alpha += Math.sign(d.target - d.alpha) * d.speed;
    }

    // 7) 螢幕震動
    applyShake();

    // 8) 敵人被打倒：演員淡出（實際移除由 flow 判定）
    for (const e of enemies) {
      if (e.removed || !e.actor) continue;
      if (e.hp <= 0 && !e.downed) e.downed = true;
    }
  }


  /* ================================================================= */
  /* 快照 / 還原（V2-08）                                                */
  /* ================================================================= */

  /** 快照格式版本 */
  const SNAPSHOT_VERSION = 1;

  /** 深拷貝成純資料（不保留函式 / Proxy） */
  function plainClone(value) {
    if (Array.isArray(value)) return value.map(plainClone);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) out[key] = plainClone(value[key]);
      return out;
    }
    return value;
  }

  /**
   * 戰鬥世界完整執行期狀態（V2-08）。
   *
   * 與 snapshot() 的差別：snapshot() 是給 UI / 測試看的「對外狀態」，
   * 這裡是「足以讓另一個 world 實例接著跑」的完整狀態——含 RNG 狀態、
   * 每位隊員 / 敵人的執行期欄位、傷害數字、閃光 / 淡出 / 震動、TP、
   * 變數、actCounts、BGM、以及內嵌的彈幕回合快照。
   *
   * @returns {object} 可直接 structuredClone / JSON 序列化的純資料
   */
  function snapshotState() {
    return {
      kind: 'world',
      version: SNAPSHOT_VERSION,
      frame,
      lang,
      turn: turnIndex,
      tp,
      vars: { ...vars },
      actCounts: Array.from(actCounts.entries()),
      party: party.map((p) => ({
        id: p.id,
        actor: p.actor,
        nameRaw: p.nameRaw,
        name: p.name,
        hp: p.hp,
        maxHp: p.maxHp,
        atk: p.atk,
        def: p.def,
        magic: p.magic,
        color: p.color,
        commands: Array.isArray(p.commands) ? p.commands.slice() : [],
        spells: Array.isArray(p.spells) ? plainClone(p.spells) : [],
        index: p.index,
        x: p.x,
        y: p.y,
        defending: p.defending === true,
        action: p.action,
        down: p.down === true,
        lastHurtFrame: p.lastHurtFrame,
      })),
      enemies: enemies.map((e) => ({
        id: e.id,
        actor: e.actor,
        nameRaw: e.nameRaw,
        name: e.name,
        hp: e.hp,
        maxHp: e.maxHp,
        atk: e.atk,
        def: e.def,
        mercy: e.mercy,
        spareAt: e.spareAt,
        tired: e.tired === true,
        acts: Array.isArray(e.acts) ? plainClone(e.acts) : [],
        onHurt: plainClone(e.onHurt || []),
        onSpare: plainClone(e.onSpare || []),
        onDefeat: plainClone(e.onDefeat || []),
        removed: e.removed === true,
        downed: e.downed === true,
      })),
      items: items.map((it) => plainClone(it)),
      numbers: numbers.map((n) => ({ ...n })),
      flash: flash ? { ...flash } : null,
      fade: fade ? { ...fade } : null,
      shake: { ...shake },
      boxAnim,
      sfxQueue: sfxQueue.slice(),
      bgmState: {
        track: bgmState.track === undefined ? null : bgmState.track,
        fade: bgmState.fade,
        seq: bgmState.seq,
      },
      pendingEnd: pendingEnd ? plainClone(pendingEnd) : null,
      rng: typeof rng.getState === 'function' ? rng.getState() : null,
      actors: typeof actors.snapshotState === 'function' ? actors.snapshotState() : null,
      text: typeof text.snapshotState === 'function' ? text.snapshotState() : null,
      battle: battle ? battleSnapshotState() : null,
    };
  }

  /** 內嵌彈幕回合的完整快照（含 sim 的完整快照與 handle 關係） */
  function battleSnapshotState() {
    if (!battle) return null;
    const sim = battle.sim;
    return {
      // ref 只用來核對：還原時必須是同一段攻擊
      ref: battle.handle ? battle.handle.ref : null,
      attackName: battle.attack && battle.attack.meta ? battle.attack.meta.name : null,
      attack: plainClone(battle.attack),
      tpBase: battle.tpBase,
      hitCount: battle.hitCount,
      grazeCount: battle.grazeCount,
      closing: battle.closing === true,
      handleDone: battle.handle ? battle.handle.done === true : true,
      // 歸一化後的攻擊檔（還原時用來重建 sim；同一個 encounter 內不變）
      sim: sim && typeof sim.snapshot === 'function' ? sim.snapshot() : null,
    };
  }

  /** 由快照還原內嵌彈幕回合 */
  function restoreBattleState(snap) {
    if (!snap || !snap.sim) {
      battle = null;
      return false;
    }
    // 舊回合先收掉（不發事件，避免還原時多發 attackClose / attackEnd）
    battle = null;
    const src = snap.attack;
    if (!src) return false;
    const partyChars = party.map((p) => ({
      name: p.id,
      hp: Math.max(1, p.hp > 0 ? p.hp : 1),
      maxHp: p.maxHp,
      color: p.color,
      icon: null,
    }));
    const attackDoc = plainClone(src);
    attackDoc.party = partyChars;
    const handle = {
      done: snap.handleDone === true,
      attack: null,
      sim: null,
      ref: snap.ref === undefined ? null : snap.ref,
      cancel() {
        if (!battle || battle.handle !== handle) {
          handle.done = true;
          return;
        }
        closeBattle(true);
        handle.done = true;
      },
    };
    const sim = createSimulation({
      mode: 'play',
      onEvent: (evt) => onBattleEvent(handle, evt),
    });
    sim.load(attackDoc);
    if (!sim.restore(snap.sim)) return false;
    battle = {
      sim,
      handle,
      attack: sim.attack,
      tpBase: Number(snap.tpBase) || 0,
      hitCount: Math.max(0, Math.round(Number(snap.hitCount) || 0)),
      grazeCount: Math.max(0, Math.round(Number(snap.grazeCount) || 0)),
      closing: snap.closing === true,
    };
    handle.attack = sim.attack;
    handle.sim = sim;
    return true;
  }

  /**
   * 還原世界狀態（V2-08）。
   *
   * 前提：實例是同一個遭遇檔建立出來的（演員定義 / 清單順序一致）。
   * 順序很重要：演員 → 隊員 / 敵人 / 道具 → 文字 → 彈幕回合 → 執行器 → 特效。
   *
   * @param {object} snap snapshotState() 的結果（或 JSON.parse 後的值）
   * @returns {boolean}
   */
  function restoreState(snap) {
    const s = snap && typeof snap === 'object' ? snap : null;
    if (!s || s.version !== SNAPSHOT_VERSION) return false;
    if (s.kind !== 'world') return false;

    frame = Math.max(0, Math.round(Number(s.frame) || 0));
    lang = s.lang === 'en' ? 'en' : 'zh';
    turnIndex = Math.max(0, Math.round(Number(s.turn) || 0));
    tp = Math.max(0, Math.min(TP_MAX, Number(s.tp) || 0));

    // RNG：helpers / lookups 都綁在同一個 rng 物件上（reset() 才會換掉）→ 只還原內部狀態
    if (s.rng && typeof rng.setState === 'function') rng.setState(s.rng);

    // 變數 / actCounts（vars 是 const 物件 → 原地更新）
    for (const key of Object.keys(vars)) delete vars[key];
    for (const key of Object.keys(s.vars || {})) vars[key] = num(s.vars[key], 0);
    actCounts.clear();
    for (const pair of Array.isArray(s.actCounts) ? s.actCounts : []) {
      if (!Array.isArray(pair) || pair.length < 2) continue;
      actCounts.set(String(pair[0]), num(pair[1], 0));
    }

    // 隊員
    for (const src of Array.isArray(s.party) ? s.party : []) {
      const p = partyById(src.id);
      if (!p) continue;
      p.hp = Math.max(0, Math.min(p.maxHp, num(src.hp, p.hp)));
      p.defending = src.defending === true;
      p.action = src.action === undefined ? null : src.action;
      p.down = src.down === true;
      p.lastHurtFrame = Number.isFinite(Number(src.lastHurtFrame)) ? Number(src.lastHurtFrame) : -999;
      if (Number.isFinite(Number(src.x))) p.x = Number(src.x);
      if (Number.isFinite(Number(src.y))) p.y = Number(src.y);
    }

    // 敵人
    for (const src of Array.isArray(s.enemies) ? s.enemies : []) {
      const e = enemyById(src.id);
      if (!e) continue;
      e.hp = Math.max(0, Math.min(e.maxHp, num(src.hp, e.hp)));
      e.mercy = Math.max(0, Math.min(100, num(src.mercy, e.mercy)));
      e.tired = src.tired === true;
      e.removed = src.removed === true;
      e.downed = src.downed === true;
    }

    // 道具
    for (const src of Array.isArray(s.items) ? s.items : []) {
      const it = items.find((x) => x && src && x.id !== undefined && x.id === src.id);
      if (!it) continue;
      if (src.count !== undefined) it.count = Math.max(0, Math.round(num(src.count, it.count)));
    }

    // 演員（先還原，位置 / 動畫 / 形態都在這裡）
    if (Array.isArray(s.actors) && typeof actors.restoreState === 'function') {
      actors.restoreState(s.actors);
    }

    // 文字（含打字機進度、文字 handle 的 slot）
    if (s.text && typeof text.restoreState === 'function') text.restoreState(s.text);

    // 傷害數字 / 特效 / 音效 / BGM / 待結束請求
    numbers = (Array.isArray(s.numbers) ? s.numbers : []).map((n) => ({ ...n }));
    flash = s.flash ? { ...s.flash } : null;
    fade = s.fade ? { ...s.fade } : null;
    shake = {
      amount: num(s.shake && s.shake.amount, 0),
      elapsed: num(s.shake && s.shake.elapsed, 0),
      duration: num(s.shake && s.shake.duration, 0),
      x: num(s.shake && s.shake.x, 0),
      y: num(s.shake && s.shake.y, 0),
    };
    boxAnim = Math.max(0, Math.min(1, num(s.boxAnim, 0)));
    sfxQueue = Array.isArray(s.sfxQueue) ? s.sfxQueue.slice() : [];
    if (s.bgmState && typeof s.bgmState === 'object') {
      bgmState.track = s.bgmState.track === undefined ? null : s.bgmState.track;
      bgmState.fade = num(s.bgmState.fade, 0);
      bgmState.seq = Math.max(0, Math.round(num(s.bgmState.seq, 0)));
    }
    pendingEnd = s.pendingEnd ? plainClone(s.pendingEnd) : null;

    // 彈幕回合（最後才還原：需要隊員 HP 等前置狀態）
    restoreBattleState(s.battle);

    return true;
  }

  /* ------------------------------------------------------------ 快照 */

  /** 目前語言 */
  function setLang(next) {
    lang = next === 'en' ? 'en' : 'zh';
  }

  function setTurn(i) {
    turnIndex = Math.max(0, Math.round(num(i, 0)));
  }

  /** 戰鬥框展開進度（flow 也可覆寫） */
  function setBoxAnim(v) {
    boxAnim = Math.max(0, Math.min(1, num(v, boxAnim)));
  }

  /** 螢幕震動（cue: shake） */
  function startShake(amount, duration) {
    shake.amount = num(amount, 4);
    shake.elapsed = 0;
    shake.duration = Math.max(0.01, num(duration, 0.3) * fps);
  }

  /** 閃光（cue: flash） */
  function startFlash(color, duration) {
    flash = {
      color: resolveColor(color) || '#ffffff',
      alpha: 1,
      speed: 1 / Math.max(1, num(duration, 0.2) * fps),
    };
  }

  /** 黑幕淡出 / 淡入 */
  function startFade(color, alpha, duration) {
    fade = {
      color: resolveColor(color) || '#000000',
      alpha: fade ? fade.alpha : 0,
      target: Math.max(0, Math.min(1, num(alpha, 1))),
      speed: 1 / Math.max(0.5, num(duration, 0.5) * fps),
    };
  }

  /** 本幀音效（並清空） */
  function drainSfx() {
    if (sfxQueue.length === 0) return [];
    const out = sfxQueue;
    sfxQueue = [];
    return out;
  }

  /** 目前語言取文字 */
  function localize(value) {
    return pickText(value, lang);
  }

  /** 敵人是否可饒恕 */
  function isSpareable(e) {
    return Boolean(e) && !e.removed && e.mercy >= e.spareAt;
  }

  /** §5 的 party 陣列 */
  function partySnapshot() {
    return party.map((p) => ({
      id: p.id,
      actor: p.actor,
      icon: p.icon,
      name: localize(p.nameRaw),
      hp: p.hp,
      maxHp: p.maxHp,
      color: p.color,
      down: p.hp <= 0,
      defending: p.defending,
      action: p.action,
    }));
  }

  /** §5 的 enemies 陣列 */
  function enemiesSnapshot() {
    return enemies.map((e) => ({
      id: e.id,
      name: localize(e.nameRaw),
      hp: e.hp,
      maxHp: e.maxHp,
      mercy: e.mercy,
      spareable: isSpareable(e),
      removed: e.removed,
    }));
  }

  /**
   * 彈幕回合的 §5 battle 欄位。
   *
   * 形狀與 Phase 1 單獨攻擊的 getState() 一致（至少 bot / 渲染器用到的欄位都在）：
   * 之前只給 box / soul / bullets，缺 attack（soul.speed / slowSpeed）等設定，
   * 導致 tools/agent/bot.mjs 在遭遇裡只能用猜的預設值、閃避比單跑攻擊差。
   */
  function battleSnapshot() {
    if (!battle) return null;
    const st = battle.sim.getState();
    return {
      mode: st.mode,
      frame: st.frame,
      time: st.time,
      running: st.running,
      ended: st.ended,
      attack: st.attack,
      box: st.box,
      ...(st.arena ? { arena: st.arena } : {}),
      ...(st.clipRegion ? { clipRegion: st.clipRegion } : {}),
      soul: st.soul,
      ...(st.playerShots ? { playerShots: st.playerShots } : {}),
      ...(st.shotBursts ? { shotBursts: st.shotBursts } : {}),
      bullets: st.bullets,
      party: st.party,
      enemies: st.enemies,
      tp: st.tp,
      shake: st.shake,
      sfxQueue: st.sfxQueue.slice(),
      grazeFlash: st.grazeFlash,
      hurtFlash: st.hurtFlash,
    };
  }

  /** 數字的淡出透明度（最後 40% 淡出） */
  function numberAlpha(n) {
    const u = n.age / Math.max(1, n.life);
    if (u <= LAYOUT.NUMBER.fadeStart) return 1;
    const k = (u - LAYOUT.NUMBER.fadeStart) / (1 - LAYOUT.NUMBER.fadeStart);
    return Math.max(0, 1 - k);
  }

  /**
   * 戰鬥框展開旋轉角（度）。
   * SPEC-LAYOUT §5：從中心「旋轉 + 縮放」展開 → 展開時由 ±90 收斂到 0。
   *   - 沒有彈幕回合且 boxAnim = 0（框不存在）→ 0
   *   - 有彈幕回合時，隨 boxAnim 0→1 由 90 收斂到 0（尾端減速）
   * 收框時 boxAnim 反向遞減，角度會反向增大（框轉著收回）。
   */
  function boxAnimRotation() {
    if (!battle && boxAnim <= 0) return 0;
    const t = Math.max(0, Math.min(1, boxAnim));
    // easeOutQuad：旋轉在後段明顯減速
    const u = 1 - (1 - t) * (1 - t);
    const angle = LAYOUT.BOX_ANIM_ROTATION * (1 - u);
    return Math.round(angle * 1000) / 1000;
  }

  /**
   * §5 state（不含 flow 的 phase / menu / fight / result）。
   */
  function snapshot() {
    return {
      frame,
      lang,
      actors: actors.snapshot(),
      party: partySnapshot(),
      enemies: enemiesSnapshot(),
      tp,
      textbox: text.snapshotTextbox(),
      bubbles: text.snapshotBubbles(),
      numbers: numbers.map((n) => ({
        x: n.x,
        y: n.y,
        text: n.text,
        color: n.color,
        age: n.age,
        // SPEC-LAYOUT §9：先上彈後停（渲染用）
        vy: n.vy,
        settled: n.settled,
        alpha: numberAlpha(n),
        row: n.row,
        miss: n.miss,
      })),
      battle: battleSnapshot(),
      boxAnim,
      boxAnimRotation: boxAnimRotation(),
      fade: fade ? { color: fade.color, alpha: fade.alpha } : { color: '#000000', alpha: 0 },
      flash: flash ? { color: flash.color, alpha: flash.alpha } : { color: '#ffffff', alpha: 0 },
      shake: { x: shake.x, y: shake.y },
      vars: { ...vars },
      turn: turnIndex,
    };
  }

  /** 重置整場遭遇（流程回到開頭時用） */
  function reset() {
    frame = 0;
    numbers = [];
    flash = null;
    fade = null;
    shake = { amount: 0, elapsed: 0, duration: 0, x: 0, y: 0 };
    boxAnim = 0;
    sfxQueue = [];
    tp = 0;
    turnIndex = 0;
    if (battle) closeBattle(true);
    battle = null;
    text.reset();
    actors.reset();
    let i = 0;
    for (const p of (enc.party || [])) {
      const src = party[i];
      if (src) {
        src.hp = Math.max(0, Math.min(src.maxHp, num(p.hp, src.maxHp)));
        src.defending = false;
        src.action = null;
        src.down = src.hp <= 0;
      }
      i += 1;
    }
    let j = 0;
    for (const e of (enc.enemies || [])) {
      const src = enemies[j];
      if (src) {
        src.hp = Math.max(0, Math.min(src.maxHp, num(e.hp, src.maxHp)));
        src.mercy = Math.max(0, Math.min(100, num(e.mercy, 0)));
        src.removed = false;
        src.downed = false;
        src.tired = Boolean(e.tired);
      }
      j += 1;
    }
    items = (enc.items || []).map((it) => ({ ...it }));
    for (const k of Object.keys(vars)) delete vars[k];
    Object.assign(vars, enc.vars || {});
    actCounts.clear();
  }

  return {
    /* --- 子系統 --- */
    actors,
    text,
    /* --- 資料 --- */
    party,
    enemies,
    items,
    vars,
    get tp() {
      return tp;
    },
    set tp(v) {
      tp = Math.max(0, Math.min(TP_MAX, num(v, 0)));
    },
    /** 帶事件的 TP 設定（flow / cues / 測試用；行為與直接賦值相同） */
    setTp,
    get frame() {
      return frame;
    },
    get lang() {
      return lang;
    },
    get turn() {
      return turnIndex;
    },
    get boxAnim() {
      return boxAnim;
    },
    /** 戰鬥框展開的旋轉角（度，展開時由 ±90 收斂到 0；SPEC-LAYOUT §5） */
    get boxAnimRotation() {
      return boxAnimRotation();
    },
    /** 版面常數（與渲染 / 編輯器共用；SPEC-LAYOUT） */
    layout: LAYOUT,
    /** 依目前隊伍人數的腳底 y 陣列（SPEC-LAYOUT §3） */
    partyFeet: () => {
      const pl = settings.partyLayout;
      const base = partyFeetFor(party.length);
      return pl && Array.isArray(pl.feet) && pl.feet.length ? base.map((v, i) => num(pl.feet[i], v)) : base;
    },
    partyX: () => (settings.partyLayout && Number.isFinite(Number(settings.partyLayout.x)) ? Number(settings.partyLayout.x) : LAYOUT.PARTY_CENTER_X),
    partyStagger: () => (settings.partyLayout && Number.isFinite(Number(settings.partyLayout.stagger)) ? Number(settings.partyLayout.stagger) : LAYOUT.PARTY_STAGGER_X),
    get battle() {
      return battle;
    },
    /* --- 查詢 --- */
    partyById,
    enemyById,
    positionOf,
    isSpareable,
    attackActive,
    /* --- 操作 --- */
    startAttack,
    closeBattle,
    applyDamage,
    applyHeal,
    addMercy,
    removeEnemy,
    recordAct,
    getVar,
    setVar,
    damageNumber,
    /* --- 表達式 --- */
    evalExpr,
    evalExprDetailed,
    lookups,
    helpers,
    rng,
    /* --- 演出 --- */
    startShake,
    startFlash,
    startFade,
    setBoxAnim,
    setLang,
    setTurn,
    pushSfx,
    drainSfx,
    localize,
    /* --- 事件 --- */
    emit,
    emitError,
    requestEnd,
    consumeEndRequest,
    playBgm,
    getBgm,
    /* --- 生命週期 --- */
    update,
    snapshot,
    // V2-08：完整執行期狀態（serialization 用；不改行為）
    snapshotState,
    restoreState,
    reset,
  };
}

export default createWorld;
