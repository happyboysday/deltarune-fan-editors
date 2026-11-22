/**
 * engine/encounter/fight.js — FIGHT 攻擊條（SPEC-P2 §2 resolve 的 FIGHT 段 / §5 fight 形狀）
 *
 * 規則（§2）：
 *   - 每位選了 fight 的隊員一條攻擊條：標記由右向左移動，按 Z 命中。
 *   - 與目標線的距離決定倍率：perfect 150%、good / ok 較低、按得太差最低約 30%；
 *     完全沒按 = MISS（0 傷害）。
 *   - 傷害 = round(atk * 倍率 * 常數 - enemy.def * 3)，下限 1。
 *   - 命中：敵人播 hurt、跳傷害數字、執行 onHurt；HP ≤ 0 → 執行 onDefeat、
 *     演員淡出、敵人移除。
 *
 * 對 world / runner 的依賴全部透過 §4 列出的介面（fake world 只需實作用到的部分）：
 *   world.party / world.enemies / world.enemyById / world.actors.setAnim /
 *   world.applyDamage / world.damageNumber / world.positionOf / world.removeEnemy
 *   runner.run(cues, { label }) → handle
 *
 * 輸出（§5）：
 *   { bars: [ { member, color, x, targetX, result } ] }
 *   result ∈ null | 'perfect' | 'good' | 'ok' | 'miss'
 *
 * 本模組不碰 DOM、不 import E1 檔案（只用傳入的物件），可無頭測試。
 */

/** 攻擊條軌道長度（與渲染器的像素座標同一尺度） */
export const TRACK_W = 300;
const TARGET_X = 1; // 左框緣的三像素判定線中央

/** 標記每幀移動距離（30 FPS；300 / 6.5 ≈ 46 幀 ≈ 1.5 秒） */
export const MARKER_SPEED = 6.5;

/** 命中區距離門檻（像素；與 targetX 的差） */
export const HIT_PERFECT = 10;
export const HIT_GOOD = 26;
export const HIT_OK = 62;

/** 倍率 */
export const MULT = {
  perfect: 1.5,
  good: 1.15,
  ok: 0.8,
  miss: 0.3, // 按了但太遠
  none: 0, // 完全沒按
};

/** 傷害常數（SPEC-P2 §2「某常數」；調整手感只改這裡） */
export const DAMAGE_SCALE = 2;

/** 每次按鍵判定後停留的幀數（讓玩家看到結果） */
export const RESULT_HOLD_FRAMES = 22;

/** 開始下一條前的空檔幀數 */
export const NEXT_BAR_DELAY = 6;

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/**
 * 依距離取得判定結果。
 * @param {number} dist |x - targetX|
 * @param {boolean} pressed 是否按下確認鍵
 * @returns {'perfect'|'good'|'ok'|'miss'}
 */
export function judge(dist, pressed) {
  if (!pressed) return 'miss';
  const d = Math.abs(num(dist, 0));
  if (d <= HIT_PERFECT) return 'perfect';
  if (d <= HIT_GOOD) return 'good';
  if (d <= HIT_OK) return 'ok';
  return 'miss';
}

/**
 * 依判定與攻擊力算傷害。
 * @param {number} atk
 * @param {string} result
 * @param {number} def
 * @param {boolean} pressed
 * @returns {number} 傷害（未按 = 0）
 */
export function computeDamage(atk, result, def = 0, pressed = true) {
  if (!pressed) return 0;
  const mult = MULT[result] !== undefined ? MULT[result] : 0;
  if (mult <= 0) return 0;
  const raw = num(atk, 0) * mult * DAMAGE_SCALE - num(def, 0) * 3;
  return Math.max(1, Math.round(raw));
}

/**
 * 建立 FIGHT 攻擊條控制器。
 *
 * @param {object} options
 * @param {object} options.world 世界（§4 介面）
 * @param {object} options.runner 指令執行器（§4 介面）
 * @param {number} [options.fps]
 * @param {(x:number,y:number,text:string,color?:string)=>void} [options.onDamageNumber] 覆寫傷害數字
 * @returns {object} fight
 */
export function createFight(options = {}) {
  const world = options.world || {};
  const runner = options.runner || null;
  const onDamageNumber =
    typeof options.onDamageNumber === 'function' ? options.onDamageNumber : null;

  /** 目前攻擊條狀態 */
  const state = {
    active: false,
    /** @type {object[]} 每條的執行期狀態 */
    bars: [],
    index: 0,
    /** 'idle' | 'moving' | 'show' | 'gap' | 'done' */
    step: 'idle',
    timer: 0,
    /** @type {object[]} 每條的結算結果 */
    results: [],
    /** @type {{cues: object[], label: string}[]} 等待執行的掛鉤清單（onHurt / onDefeat，依命中順序排隊） */
    hookQueue: [],
    /** 執行中的掛鉤 handle（null = 沒有） */
    hookHandle: null,
    ended: false,
  };

  /* ------------------------------------------------------------ 工具 */

  function actors() {
    return world.actors && typeof world.actors.setAnim === 'function' ? world.actors : null;
  }

  function setAnim(actorId, name, opts) {
    const a = actors();
    if (!a || !actorId) return;
    try {
      a.setAnim(actorId, name, { ...opts, loop: false });
    } catch (_e) {
      /* 缺演員不影響結算 */
    }
  }

  function findEnemy(id) {
    if (typeof world.enemyById === 'function') {
      const e = world.enemyById(id);
      if (e) return e;
    }
    const list = Array.isArray(world.enemies) ? world.enemies : [];
    for (const e of list) if (e && e.id === id) return e;
    return null;
  }

  function findParty(index, memberId) {
    const list = Array.isArray(world.party) ? world.party : [];
    if (memberId !== undefined && memberId !== null) {
      for (let i = 0; i < list.length; i += 1) {
        if (list[i] && list[i].id === memberId) return list[i];
      }
    }
    return list[index] || null;
  }

  function damageNumber(enemyId, text, color) {
    const pos =
      typeof world.positionOf === 'function' ? world.positionOf(enemyId) : { x: 520, y: 170 };
    const x = num(pos && pos.x, 520);
    const y = num(pos && pos.y, 170);
    if (onDamageNumber) {
      onDamageNumber(x, y, text, color);
      return;
    }
    if (typeof world.damageNumber === 'function') {
      try {
        world.damageNumber(x, y, text, color);
      } catch (_e) {
        /* 缺實作時靜默 */
      }
    }
  }

  function runCues(cues, label) {
    if (!runner || typeof runner.run !== 'function') return null;
    if (!Array.isArray(cues) || cues.length === 0) return null;
    try {
      return runner.run(cues, { label });
    } catch (_e) {
      return null;
    }
  }

  /**
   * 把掛鉤指令排進佇列（依命中順序排隊；上一條跑完才開始下一條）。
   * 不直接 runner.run，避免後續流程指令（text.clear 等）把還沒跑到的 wait / say 打斷。
   * @param {object[]} cues
   * @param {string} label
   */
  function enqueueHooks(cues, label) {
    if (!runner || typeof runner.run !== 'function') return;
    if (!Array.isArray(cues) || cues.length === 0) return;
    state.hookQueue.push({ cues: cues.slice(), label });
  }

  /** 是否有掛鉤在執行或排隊中 */
  function hooksPending() {
    return state.hookHandle !== null || state.hookQueue.length > 0;
  }

  /** 取消執行中的掛鉤並清空佇列（reset / cancel 用） */
  function clearHooks() {
    state.hookQueue.length = 0;
    const handle = state.hookHandle;
    state.hookHandle = null;
    if (!handle) return;
    try {
      if (typeof handle.cancel === 'function') handle.cancel();
    } catch (_e) {
      /* 忽略 */
    }
  }

  /**
   * 推進掛鉤佇列：一次只跑一條，等 handle.done 才開始下一條。
   * wait / say 等 cue 由 runner 自己的 update 推進；這裡只負責排隊與接續。
   */
  function updateHooks() {
    // 先看執行中的那條是否跑完（handle 被外部取消 → 視為完成，避免卡住）
    if (state.hookHandle) {
      let finished = false;
      try {
        finished = state.hookHandle.done === true;
      } catch (_e) {
        finished = true;
      }
      if (!finished) return;
      state.hookHandle = null;
    }
    while (state.hookQueue.length > 0) {
      const job = state.hookQueue.shift();
      const handle = runCues(job.cues, job.label);
      if (!handle) continue;
      let doneNow = false;
      try {
        doneNow = handle.done === true;
      } catch (_e) {
        doneNow = false;
      }
      if (!doneNow) {
        state.hookHandle = handle;
        return;
      }
    }
  }

  /* ---------------------------------------------------------- 結算 */

  /**
   * 套用一次命中的結果（HP、數字、動畫、onHurt / onDefeat）。
   * @param {object} bar
   * @param {string} result
   * @param {number} damage
   */
  function applyHit(bar, result, damage) {
    bar.result = result;
    bar.damage = damage;
    const enemy = findEnemy(bar.target);
    if (!enemy) return;
    const enemyActor = enemy.actor || bar.target;

    if (damage > 0) {
      const before = Math.max(0, num(enemy.hp, 0));
      // 優先走 world.applyDamage（會同步 hp / 動畫 / 數字）
      let applied = false;
      if (typeof world.applyDamage === 'function') {
        try {
          world.applyDamage(bar.target, damage);
          applied = true;
        } catch (_e) {
          applied = false;
        }
      }
      if (!applied) {
        enemy.hp = Math.max(0, before - damage);
        damageNumber(bar.target, `-${damage}`, '#ff4040');
        // 敵人沒定義 hurt 動畫時沿用目前動畫（不要退回 idle）
        setAnim(enemyActor, 'hurt', { keepIfMissing: true });
      }
      bar.damage = Math.max(0, before - Math.max(0, num(enemy.hp, 0)));
      bar.hpAfter = Math.max(0, num(enemy.hp, 0));
      enqueueHooks(enemy.onHurt, `onHurt:${bar.target}`);
    }

    // HP ≤ 0 → onDefeat、演員淡出、移除
    if (num(enemy.hp, 0) <= 0 && !enemy.removed) {
      enqueueHooks(enemy.onDefeat, `onDefeat:${bar.target}`);
      setAnim(enemyActor, 'defeat');
      if (typeof world.removeEnemy === 'function') {
        try {
          world.removeEnemy(bar.target, { duration: 0.4 });
        } catch (_e) {
          /* 忽略 */
        }
      } else {
        enemy.removed = true;
      }
      bar.defeated = true;
    }
  }

  /* ---------------------------------------------------------- 生命週期 */

  /**
   * 開始一段 FIGHT 結算。
   * @param {object[]} entries [{ member, memberId, color, atk, target, def? }]
   */
  function start(entries) {
    const list = Array.isArray(entries) ? entries : [];
    state.active = true;
    state.ended = false;
    state.bars = [];
    state.results = [];
    state.index = 0;
    state.step = 'idle';
    state.timer = 0;

    for (let i = 0; i < list.length; i += 1) {
      const src = list[i] || {};
      const memberIndex = Math.max(0, Math.round(num(src.member, i)));
      const member = findParty(memberIndex, src.memberId);
      const enemy = findEnemy(src.target);
      state.bars.push({
        member: memberIndex,
        memberId: src.memberId || (member && member.id) || String(memberIndex),
        actor: (member && member.actor) || src.actor || null,
        color: src.color || (member && member.color) || '#ffffff',
        atk: num(src.atk, member ? member.atk : 10),
        target: src.target || (enemy && enemy.id) || null,
        targetName: src.targetName || (enemy && enemy.name) || '',
        def: num(src.def, enemy ? enemy.def : 0),
        x: TRACK_W,
        targetX: TARGET_X,
        result: null,
        damage: 0,
        defeated: false,
      });
    }

    if (state.bars.length === 0) {
      state.step = 'done';
      state.ended = true;
      state.active = false;
      return state.bars;
    }
    // 第一條：稍等 NEXT_BAR_DELAY 幀後開始移動
    state.step = 'gap';
    state.timer = 0;
    return state.bars;
  }

  /** 開始第 index 條 */
  function beginBar(index) {
    const bar = state.bars[index];
    if (!bar) {
      finish();
      return;
    }
    state.index = index;
    bar.x = TRACK_W;
    bar.result = null;
    state.step = 'moving';
    state.timer = 0;
  }

  function resolveBar(pressed) {
    const bar = state.bars[state.index];
    if (!bar) return;
    const dist = Math.abs(bar.x - bar.targetX);
    const result = judge(dist, pressed);
    const damage = computeDamage(bar.atk, result, bar.def, pressed);
    if (pressed) setAnim(bar.actor, 'attack');
    applyHit(bar, result, damage);
    state.results.push({
      member: bar.member,
      memberId: bar.memberId,
      target: bar.target,
      result,
      damage,
      defeated: bar.defeated === true,
      dist: Math.round(dist),
    });
    state.step = 'show';
    state.timer = 0;
  }

  function finish() {
    state.step = 'done';
    state.ended = true;
    state.active = false;
  }

  /**
   * 每幀推進。
   * @param {{press?:string[], has?:(k:string)=>boolean}} [input]
   */
  function update(input) {
    // 掛鉤（onHurt / onDefeat）可能排隊或執行中；就算攻擊條已全部結算完，
    // 也要持續推進，全部跑完才算 done（flow 才會進下一階段）。
    if (hooksPending()) updateHooks();

    if (!state.active && state.step !== 'show' && state.step !== 'gap') return;
    if (state.ended) return;
    const press = input && Array.isArray(input.press) ? input.press : [];
    const confirm = press.includes('confirm');

    switch (state.step) {
      case 'gap': {
        state.timer += 1;
        if (state.timer >= (state.index === 0 ? NEXT_BAR_DELAY : NEXT_BAR_DELAY)) {
          beginBar(state.index);
        }
        break;
      }
      case 'moving': {
        const bar = state.bars[state.index];
        if (!bar) {
          finish();
          break;
        }
        if (confirm) {
          resolveBar(true);
          break;
        }
        bar.x = Math.max(0, bar.x - MARKER_SPEED);
        if (bar.x <= 0) resolveBar(false);
        break;
      }
      case 'show': {
        state.timer += 1;
        if (state.timer >= RESULT_HOLD_FRAMES) {
          const next = state.index + 1;
          if (next >= state.bars.length) finish();
          else {
            state.index = next;
            state.step = 'gap';
            state.timer = 0;
          }
        }
        break;
      }
      default:
        break;
    }
  }


  /* --------------------------------------------------------- 快照 */

  /** 深拷貝成純資料 */
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
   * FIGHT 完整執行期狀態（V2-08）。
   *
   * 含攻擊條進度、結算結果、掛鉤佇列與「執行中的掛鉤」的 chainId
   * （還原時從 runner 接回同一條指令鏈，才不會重播 onHurt / onDefeat）。
   */
  function snapshotState() {
    return {
      active: state.active === true,
      ended: state.ended === true,
      step: state.step,
      index: state.index,
      timer: state.timer,
      bars: state.bars.map((bar) => ({ ...bar })),
      results: state.results.map((r) => ({ ...r })),
      hookQueue: state.hookQueue.map((job) => ({
        cues: plainClone(job.cues),
        label: job.label,
      })),
      hookChainId: state.hookHandle && state.hookHandle.chainId ? state.hookHandle.chainId : 0,
    };
  }

  /** 還原 snapshotState()（必須在 runner 還原之後） */
  function restoreState(snap) {
    const s = snap && typeof snap === 'object' ? snap : null;
    if (!s) return false;
    state.active = s.active === true;
    state.ended = s.ended === true;
    state.step = typeof s.step === 'string' ? s.step : 'idle';
    state.index = Math.max(0, Math.round(num(s.index, 0)));
    state.timer = Math.max(0, Math.round(num(s.timer, 0)));
    state.bars = (Array.isArray(s.bars) ? s.bars : []).map((bar) => ({ ...bar }));
    state.results = (Array.isArray(s.results) ? s.results : []).map((r) => ({ ...r }));
    state.hookQueue = (Array.isArray(s.hookQueue) ? s.hookQueue : []).map((job) => ({
      cues: plainClone(job.cues || []),
      label: job.label,
    }));
    state.hookHandle = null;
    if (s.hookChainId && runner && typeof runner.byChainId === 'function') {
      state.hookHandle = runner.byChainId(s.hookChainId);
    }
    return true;
  }

  /* --------------------------------------------------------- 快照 */

  /** §5 的 fight 形狀；未開始時回 null */
  function snapshot() {
    if (state.step === 'idle' || state.step === 'done') return null;
    return {
      bars: state.bars.map((bar) => ({
        member: bar.member,
        color: bar.color,
        x: Math.max(0, Math.min(TRACK_W, bar.x)),
        targetX: bar.targetX,
        result: bar.result,
        ...(bar.target ? { target: bar.target } : {}),
      })),
    };
  }

  /** 重置（新一回合 / flow reset） */
  function reset() {
    clearHooks();
    state.active = false;
    state.bars = [];
    state.results = [];
    state.index = 0;
    state.step = 'idle';
    state.timer = 0;
    state.ended = false;
  }

  function cancel() {
    reset();
  }

  return {
    start,
    update,
    snapshot,
    reset,
    cancel,
    // V2-08：完整執行期狀態（serialization 用；不改行為）
    snapshotState,
    restoreState,
    /** 攻擊條是否全部結算完（含 onHurt / onDefeat 掛鉤清單都跑完） */
    get done() {
      return state.ended && !hooksPending();
    },
    /** 是否正在進行（含收尾顯示） */
    get active() {
      return state.active || state.step === 'show' || state.step === 'gap';
    },
    /** 每條結果（依序） */
    get results() {
      return state.results.slice();
    },
    /** 目前處理到的索引 */
    get index() {
      return state.index;
    },
    /** 內部狀態（除錯 / 測試用） */
    get state() {
      return state;
    },
  };
}

export default createFight;
