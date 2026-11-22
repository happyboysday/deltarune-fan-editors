/**
 * engine/encounter/cues.js — 演出指令執行器（SPEC-P2 §3）
 *
 * 指令清單 = 陣列；每條 `{ cmd, ...參數, async }`。
 * 預設**依序執行、阻塞到完成**；`async: true` 則啟動後立刻接下一條。
 *
 * 支援的指令（完整定義見 schema.js 的 CUE_COMMANDS）：
 *   say bubble move anim flip fade wait sfx bgm shake flash
 *   set mercy heal damage if parallel attack end
 *
 * 一次 `update(input)` 會：
 *   1. 推進所有進行中的指令（打字機、補間、計時器…）
 *   2. 完成的指令讓清單前進，並在同一幀就啟動下一條（可連續執行多條立即指令）
 *
 * 本模組不碰 DOM。
 */

import { defaultAnimLoop, isPlainObject, num, bool, pickText, normalizeCue, CUE_COMMANDS } from './schema.js';
import { resolveColor } from './text.js';

/**
 * 建立指令執行器（SPEC-P2 §4）。
 *
 * @param {object} world createWorld() 的結果
 * @param {object} [opts]
 * @param {(raw:any, report?:(m:string)=>void)=>number} [opts.evalExpr] 表達式求值（預設用 world.evalExpr）
 * @param {()=>void} [opts.beforeCue] 序列啟動下一條指令前執行
 * @param {number} [opts.fps]
 */
export function createCueRunner(world, opts = {}) {
  const fps = num(opts.fps, 30) || 30;
  const evalExpr =
    typeof opts.evalExpr === 'function'
      ? opts.evalExpr
      : (raw, report) => world.evalExpr(raw, report);

  /** 回報錯誤（不中斷腳本） */
  function reportError(message, cue) {
    world.emitError
      ? world.emitError(message, cue)
      : void 0;
    if (typeof opts.onError === 'function') {
      try {
        opts.onError(message, cue);
      } catch (_e) {
        /* 忽略 */
      }
    }
  }

  /* ================================================================= */
  /* 單一指令的 handle                                                  */
  /* ================================================================= */

  /** 立即完成的 handle */
  function immediateHandle(extra) {
    return { kind: 'immediate', done: true, cancel() {}, update() {}, ...extra };
  }

  /**
   * 依指令種類建立 handle。
   * @returns {{done:boolean, update?:(input:any)=>void, cancel?:()=>void}}
   */
  function startCue(cue) {
    const c = isPlainObject(cue) ? cue : normalizeCue(cue);
    const cmd = c.cmd;
    const def = CUE_COMMANDS[cmd];
    if (!def) {
      reportError(`未知的指令 "${cmd}"`, c);
      return immediateHandle();
    }
    switch (cmd) {
      case 'say':
        return startSay(c);
      case 'bubble':
        return startBubble(c);
      case 'move':
        return startMove(c);
      case 'anim':
        return startAnim(c);
      case 'form':
        return startForm(c);
      case 'flip':
        return startFlip(c);
      case 'fade':
        return startFade(c);
      case 'wait':
        return startWait(c);
      case 'sfx':
        return startSfx(c);
      case 'bgm':
        return startBgm(c);
      case 'shake':
        return startShake(c);
      case 'flash':
        return startFlash(c);
      case 'set':
        return startSet(c);
      case 'mercy':
        return startMercy(c);
      case 'heal':
        return startHeal(c);
      case 'item':
        return startItem(c);
      case 'damage':
        return startDamage(c);
      case 'if':
        return startIf(c);
      case 'parallel':
        return startParallel(c);
      case 'attack':
        return startAttack(c);
      case 'end':
        return startEnd(c);
      default:
        reportError(`未實作的指令 "${cmd}"`, c);
        return immediateHandle();
    }
  }

  /* ---------------------------------------------------------- 文字 */

  /** 取語言後的字串（cue 的文字欄位） */
  function cueText(value) {
    const lang = world.lang || 'zh';
    if (isPlainObject(value)) return pickText(value, lang);
    return pickText(value, lang);
  }

  /** say / bubble 共用的「按 Z」處理 */
  function makeTextHandle(textHandle) {
    return {
      kind: 'text',
      textHandle,
      /** V2-08：穩定 slot（快照 / 還原時把 handle 接回同一個文字） */
      get slot() {
        return textHandle && textHandle.slot ? textHandle.slot : 0;
      },
      get done() {
        return !textHandle || textHandle.closed === true;
      },
      update(input) {
        if (!textHandle || textHandle.closed) return;
        if (input && typeof input.has === 'function' && input.has('confirm')) {
          textHandle.confirm();
        }
      },
      cancel() {
        if (textHandle) textHandle.cancel();
      },
    };
  }

  // 勝利旁白：victory / spared 掛鉤裡真正執行過的 say win:true 才算數（寫在沒走到的 if 分支裡不算）。
  // flow 會在掛鉤最後排一句 defaultWin 的「你赢了！」，前面已經說過勝利旁白就跳過它。
  // closing 記下最後一句結尾旁白，戰鬥結束後的最後一幀停在這句（場景編輯器轉場時看到的就是它）。
  let winState = { said: false, closing: null };
  function startSay(c) {
    if (c.defaultWin === true && winState.said) return immediateHandle();
    const text = cueText(c.text);
    if (c.win === true || c.defaultWin === true) {
      if (c.win === true) winState.said = true;
      winState.closing = text;
    }
    const handle = world.text.say({
      text,
      speaker: c.speaker === undefined ? undefined : cueText(c.speaker),
      portrait: c.portrait,
      speed: num(c.speed, 1),
      voice: c.voice,
    });
    return makeTextHandle(handle);
  }

  function startBubble(c) {
    const handle = world.text.bubble({
      actor: c.actor,
      text: cueText(c.text),
      side: c.side,
      speed: num(c.speed, 1),
      wait: c.wait,
      voice: c.voice,
    });
    return makeTextHandle(handle);
  }

  /* ---------------------------------------------------------- 演員 */

  function startMove(c) {
    const actor = world.actors.get(c.actor);
    if (!actor) {
      reportError(`找不到演員 "${c.actor}"`, c);
      return immediateHandle();
    }
    world.actors.moveTo(c.actor, {
      x: c.x,
      y: c.y,
      relative: c.relative,
      duration: num(c.duration, 0.5),
      ease: c.ease,
    });
    if (!world.actors.isMoving(c.actor)) {
      // 補間時間 0 → 設定位置後立即完成
      return immediateHandle();
    }
    return {
      kind: 'move',
      actor: c.actor,
      get done() {
        return !world.actors.isMoving(c.actor);
      },
      update() {},
    };
  }

  function startAnim(c) {
    const actor = world.actors.get(c.actor);
    if (!actor) {
      reportError(`找不到演員 "${c.actor}"`, c);
      return immediateHandle();
    }
    const waitEnd = bool(c.waitEnd, false);
    if (typeof c.sprite === 'string' && c.sprite) {
      world.actors.setSprite(c.actor, c.sprite, { fps: c.fps, loop: c.loop ?? false });
    } else if (typeof c.anim === 'string' && c.anim) {
      const once = waitEnd || !defaultAnimLoop(c.anim);
      world.actors.setAnim(c.actor, c.anim, { fps: c.fps, loop: c.loop ?? (once ? false : undefined) });
    } else {
      reportError('anim 指令需要 anim 或 sprite 參數', c);
      return immediateHandle();
    }
    const current = world.actors.get(c.actor);
    if (!waitEnd || !current.anim || current.anim.loop) return immediateHandle();
    const targetName = current.animName;
    return {
      kind: 'anim',
      actor: c.actor,
      targetName,
      get done() {
        const a = world.actors.get(c.actor);
        if (!a) return true;
        // 狀態被換掉（含 then 自動接續）或已播完 → 完成
        return a.animName !== targetName || a.animFinished === true;
      },
      update() {},
    };
  }

  function startForm(c) {
    const actor = world.actors.get(c.actor);
    if (!actor) {
      reportError(`找不到演員 "${c.actor}"`, c);
      return immediateHandle();
    }
    const ok = world.actors.setForm(c.actor, c.name, { anim: c.anim });
    if (!ok) {
      const names = typeof world.actors.formNames === 'function' ? world.actors.formNames(c.actor) : [];
      reportError(
        `找不到形態 "${c.name}"（演員 "${c.actor}"` + (names.length ? ` 可用：${names.join(' / ')}` : ' 沒有 forms') + '）',
        c,
      );
      return immediateHandle();
    }
    // 只觀察：切換形態事件（timeline / 模擬器用；不影響演出）
    if (typeof world.emit === 'function') {
      world.emit('form', {
        actor: c.actor,
        form: c.name,
        anim: c.anim === undefined || c.anim === null ? null : c.anim,
        frame: typeof world.frame === 'number' ? world.frame : null,
      });
    }
    return immediateHandle();
  }

  function startFlip(c) {
    if (!world.actors.get(c.actor)) {
      reportError(`找不到演員 "${c.actor}"`, c);
      return immediateHandle();
    }
    world.actors.setFlip(c.actor, c.value);
    return immediateHandle();
  }

  function startFade(c) {
    if (!world.actors.get(c.actor)) {
      reportError(`找不到演員 "${c.actor}"`, c);
      return immediateHandle();
    }
    const duration = num(c.duration, 0.5);
    world.actors.setAlpha(c.actor, num(c.alpha, 1), duration);
    if (duration <= 0) return immediateHandle();
    return {
      kind: 'fade',
      actor: c.actor,
      get done() {
        return !world.actors.isTweening(c.actor);
      },
      update() {},
    };
  }

  /* ---------------------------------------------------------- 時間 */

  function startWait(c) {
    const frames = Math.max(0, Math.round(num(c.seconds, 0.5) * fps));
    let elapsed = 0;
    if (frames <= 0) return immediateHandle();
    return {
      kind: 'wait',
      frames,
      done: false,
      update() {
        elapsed += 1;
        if (elapsed >= frames) this.done = true;
      },
      /** V2-08：計時器進度（快照 / 還原用） */
      snapshotState() {
        return { elapsed };
      },
      restoreState(st) {
        elapsed = Math.max(0, Math.round(num(st && st.elapsed, 0)));
        return true;
      },
    };
  }

  /* ---------------------------------------------------------- 音效 */

  function startSfx(c) {
    if (typeof c.sound === 'string' && c.sound) world.pushSfx(c.sound);
    return immediateHandle();
  }

  function startBgm(c) {
    world.playBgm(c.track === undefined ? null : c.track, num(c.fade, 0));
    return immediateHandle();
  }

  /* ---------------------------------------------------------- 鏡頭 */

  function startShake(c) {
    const duration = Math.max(0, num(c.duration, 0.3));
    world.startShake(num(c.amount, 4), duration);
    const frames = Math.max(0, Math.round(duration * fps));
    let elapsed = 0;
    if (frames <= 0) return immediateHandle();
    return {
      kind: 'shake',
      frames,
      done: false,
      update() {
        elapsed += 1;
        if (elapsed >= frames) this.done = true;
      },
      snapshotState() {
        return { elapsed };
      },
      restoreState(st) {
        elapsed = Math.max(0, Math.round(num(st && st.elapsed, 0)));
        return true;
      },
    };
  }

  function startFlash(c) {
    const duration = Math.max(0, num(c.duration, 0.2));
    world.startFlash(c.color, duration);
    const frames = Math.max(0, Math.round(duration * fps));
    let elapsed = 0;
    if (frames <= 0) return immediateHandle();
    return {
      kind: 'flash',
      frames,
      done: false,
      update() {
        elapsed += 1;
        if (elapsed >= frames) this.done = true;
      },
      snapshotState() {
        return { elapsed };
      },
      restoreState(st) {
        elapsed = Math.max(0, Math.round(num(st && st.elapsed, 0)));
        return true;
      },
    };
  }

  /* ---------------------------------------------------------- 數值 */

  function startSet(c) {
    if (typeof c.var !== 'string' || !c.var) {
      reportError('set 指令需要 var 參數', c);
      return immediateHandle();
    }
    const v = evalExpr(c.value, (m) => reportError(`set ${c.var}：${m}`, c));
    world.setVar(c.var, v, c.op === 'add' ? 'add' : 'set');
    return immediateHandle();
  }

  function startMercy(c) {
    if (typeof c.enemy !== 'string' || !c.enemy) {
      reportError('mercy 指令需要 enemy 參數', c);
      return immediateHandle();
    }
    // amount 可為數字或表達式（SPEC-P2 §3 的 expr 型別）
    const amount = evalExpr(c.amount, (m) => reportError(`mercy：${m}`, c));
    world.addMercy(c.enemy, amount);
    return immediateHandle();
  }

  /** heal / damage 共用的目標解析與結算 */
  function applyAmount(c, isDamage) {
    if (typeof c.target !== 'string' || !c.target) {
      reportError(`${isDamage ? 'damage' : 'heal'} 指令需要 target 參數`, c);
      return;
    }
    const amount = evalExpr(c.amount, (m) => reportError(`${isDamage ? 'damage' : 'heal'}：${m}`, c));
    if (isDamage) world.applyDamage(c.target, amount);
    else world.applyHeal(c.target, amount);
  }

  function startHeal(c) {
    applyAmount(c, false);
    return immediateHandle();
  }

  function startDamage(c) {
    applyAmount(c, true);
    return immediateHandle();
  }

  /** item：增減這場遭遇的道具數量（場景編輯器的戰鬥獎勵／消耗用；減到 0 為止） */
  function startItem(c) {
    const list = Array.isArray(world.items) ? world.items : [];
    const it = list.find((x) => x && x.id === c.id);
    if (!it) {
      reportError(`item：這場遭遇沒有道具 "${c.id}"`, c);
      return immediateHandle();
    }
    const delta = Math.round(evalExpr(c.delta, (m) => reportError(`item：${m}`, c)));
    it.count = Math.max(0, Math.round(num(it.count, 0)) + (Number.isFinite(delta) ? delta : 0));
    return immediateHandle();
  }

  /* ---------------------------------------------------------- 流程 */

  function startIf(c) {
    const cond = evalExpr(c.cond, (m) => reportError(`if 條件：${m}`, c));
    const branch = cond !== 0 ? c.then : c.else;
    const list = Array.isArray(branch) ? branch : [];
    if (list.length === 0) return immediateHandle();
    return makeSeqHandle(list, 'if');
  }

  function startParallel(c) {
    const list = Array.isArray(c.cues) ? c.cues : [];
    if (list.length === 0) return immediateHandle();
    const seqs = list.map((sub) => makeSeq([sub], 'parallel'));
    // 巢狀 parallel（cues 內再放 parallel）由 Seq 自己處理
    return {
      kind: 'parallel',
      seqs,
      get done() {
        return this.seqs.every((s) => s.done);
      },
      update(input) {
        for (const s of this.seqs) if (!s.done) s.update(input);
      },
      cancel() {
        for (const s of this.seqs) s.cancel();
      },
    };
  }

  function startAttack(c) {
    const ref = c.attack;
    const handle = world.startAttack(ref);
    // world 的 handle.done 會在彈幕結束時成立
    return {
      kind: 'attack',
      worldHandle: handle,
      get done() {
        return handle.done === true;
      },
      update() {},
      cancel() {
        if (typeof handle.cancel === 'function') handle.cancel();
      },
    };
  }

  function startEnd(c) {
    const result = ['victory', 'spared', 'defeat', 'flee'].includes(c.result) ? c.result : 'victory';
    world.requestEnd(result);
    return immediateHandle();
  }

  /* ================================================================= */
  /* 序列（可巢狀）                                                     */
  /* ================================================================= */

  /**
   * 建立一個「依序執行」的序列。
   * @param {object[]} cues
   * @param {string} label
   */
  function makeSeq(cues, label) {
    /** @type {object[]} 展開後的指令（parallel 以 handle 形式掛上） */
    const list = Array.isArray(cues) ? cues : [];
    const state = {
      cues: list,
      index: 0,
      current: null,
      parallel: null,
      done: list.length === 0,
      canceled: false,
      label: label || '',
    };
    const seq = {
      /** V2-08：頂層序列的穩定 id（flow 的快照用；巢狀序列為 0） */
      chainId: 0,
      get done() {
        return state.done;
      },
      get label() {
        return state.label;
      },
      /** V2-08：內部狀態（快照 / 還原用） */
      get _state() {
        return state;
      },
      get cues() {
        return state.cues;
      },
      cancel() {
        state.canceled = true;
        state.done = true;
        if (state.current && typeof state.current.cancel === 'function') state.current.cancel();
        if (state.parallel) state.parallel.cancel();
        world.text.clear();
      },
      update(input) {
        if (state.done) return;
        let guard = 0;
        while (!state.done && guard < 2000) {
          guard += 1;
          // 1) 目前有阻塞指令 → 推進它
          if (state.current) {
            const h = state.current;
            if (typeof h.update === 'function') h.update(input);
            if (!h.done) return;
            state.current = null;
            state.index += 1;
            continue;
          }
          // 2) 全部跑完
          if (state.index >= state.cues.length) {
            state.done = true;
            return;
          }
          // 3) 啟動下一條
          const raw = state.cues[state.index];
          const cue = isPlainObject(raw) ? raw : normalizeCue(raw);
          opts.beforeCue?.();
          let handle;
          try {
            handle = startCue(cue);
          } catch (err) {
            reportError(`指令執行失敗：${err && err.message ? err.message : String(err)}`, cue);
            handle = immediateHandle();
          }
          if (!handle || handle.done) {
            // 立即完成（或 async 的立即指令）
            state.index += 1;
            continue;
          }
          if (cue.async) {
            // 非阻塞：交給 runner 統一追蹤，序列立刻前進
            trackAsync(handle, cue);
            state.index += 1;
            continue;
          }
          state.current = handle;
          // 同一幀再跑一次 update，讓「等待類」指令立刻開始計時
          if (typeof handle.update === 'function') handle.update(input);
          if (!handle.done) return;
          state.current = null;
          state.index += 1;
        }
      },
    };
    return seq;
  }

  /** 由序列內部建立 handle（給 if / parallel 用） */
  function seqHandleOf(seq) {
    return {
      kind: 'seq',
      seq,
      get done() {
        return seq.done;
      },
      update(input) {
        seq.update(input);
      },
      cancel() {
        seq.cancel();
      },
    };
  }

  function makeSeqHandle(cues, label) {
    return seqHandleOf(makeSeq(cues, label));
  }

  /* ================================================================= */
  /* 執行器                                                            */
  /* ================================================================= */

  /** @type {object[]} 頂層序列 */
  let chains = [];
  /** @type {object[]} async 啟動、不阻塞的 handle */
  let asyncHandles = [];

  function cueHasAttack(cue) {
    switch (cue?.cmd) {
      case 'attack': return true;
      case 'if': return cue.then?.some(cueHasAttack) || cue.else?.some(cueHasAttack);
      case 'parallel': return cue.cues?.some(cueHasAttack);
      default: return false;
    }
  }

  function seqHasAttack(seq) {
    const { done, current, cues, index } = seq._state;
    // 已啟動的 if / parallel 看實際執行中的分支，不再掃原始指令。
    return !done && (handleHasAttack(current) || cues.slice(index + (current ? 1 : 0)).some(cueHasAttack));
  }

  function handleHasAttack(handle) {
    if (!handle || handle.done) return false;
    switch (handle.kind) {
      case 'attack': return true;
      case 'seq': return seqHasAttack(handle.seq);
      case 'parallel': return handle.seqs.some(seqHasAttack);
      default: return false;
    }
  }

  function hasPendingAttack() {
    return chains.some(seqHasAttack) || asyncHandles.some(({ handle }) => handleHasAttack(handle));
  }

  function trackAsync(handle, cue) {
    if (handle && handle.done) return;
    asyncHandles.push({ handle, cue, elapsed: 0 });
    // 保險上限：避免大量 async 指令累積
    if (asyncHandles.length > 256) asyncHandles.shift();
  }

  /**
   * 執行一段指令清單。
   * @param {object[]} cues
   * @param {{label?:string, replace?:boolean}} [options] replace:true 會先取消現有清單
   * @returns {{done:boolean, cancel:()=>void, seq:object}}
   */
  function chainHandleOf(seq) {
    return {
      chainId: seq.chainId,
      seq,
      get done() {
        return seq.done;
      },
      cancel() {
        seq.cancel();
        const i = chains.indexOf(seq);
        if (i >= 0) chains.splice(i, 1);
      },
    };
  }

  let chainSeq = 0;

  function run(cues, options = {}) {
    if (options.replace) clear();
    const seq = makeSeq(cues, options.label || '');
    chainSeq += 1;
    seq.chainId = chainSeq;
    chains.push(seq);
    return chainHandleOf(seq);
  }

  /** 每幀推進（在 world.update 之後呼叫） */
  function update(input) {
    // 1) async handle
    for (let i = asyncHandles.length - 1; i >= 0; i -= 1) {
      const item = asyncHandles[i];
      item.elapsed += 1;
      if (typeof item.handle.update === 'function') item.handle.update(input);
      if (item.handle.done) asyncHandles.splice(i, 1);
    }
    // 2) 頂層序列
    for (let i = chains.length - 1; i >= 0; i -= 1) {
      const seq = chains[i];
      if (seq.done) {
        chains.splice(i, 1);
        continue;
      }
      seq.update(input);
      if (seq.done) chains.splice(i, 1);
    }
  }

  /** 是否有指令在跑 */
  function busy() {
    return chains.length > 0;
  }

  /** 是否有任何進行中的 async 指令 */
  function busyAsync() {
    return asyncHandles.length > 0;
  }

  /** 取消所有指令 */
  function clear() {
    for (const seq of chains) seq.cancel();
    chains = [];
    for (const item of asyncHandles) {
      if (item.handle && typeof item.handle.cancel === 'function') item.handle.cancel();
    }
    asyncHandles = [];
  }


  /* ================================================================= */
  /* 快照 / 還原（V2-08）                                               */
  /* ================================================================= */

  /** 純資料深拷貝（cue 清單是 encounter 檔的資料，可安全複製） */
  function plainClone(value) {
    if (Array.isArray(value)) return value.map(plainClone);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) out[key] = plainClone(value[key]);
      return out;
    }
    return value;
  }

  /** 由 slot 取文字 handle（restore 時把 say/bubble 接回文字系統的同一個 handle） */
  function textHandleOfSlot(slot) {
    const text = world && world.text;
    if (!text || typeof text.bySlot !== 'function') return null;
    return text.bySlot(slot) || null;
  }

  /** 只觀察演員補間的 handle（不重播 moveTo，避免還原時把補間重設） */
  function watchMoveHandle(actorId) {
    return {
      kind: 'move',
      actor: actorId,
      get done() {
        return !world.actors.isMoving(actorId);
      },
      update() {},
    };
  }

  function watchFadeHandle(actorId) {
    return {
      kind: 'fade',
      actor: actorId,
      get done() {
        return !world.actors.isTweening(actorId);
      },
      update() {},
    };
  }

  function watchAnimHandle(actorId, targetName) {
    return {
      kind: 'anim',
      actor: actorId,
      targetName,
      get done() {
        const a = world.actors.get(actorId);
        if (!a) return true;
        return a.animName !== targetName || a.animFinished === true;
      },
      update() {},
    };
  }

  function parallelHandleOf(seqs) {
    return {
      kind: 'parallel',
      seqs,
      get done() {
        return this.seqs.every((s) => s.done);
      },
      update(input) {
        for (const s of this.seqs) if (!s.done) s.update(input);
      },
      cancel() {
        for (const s of this.seqs) s.cancel();
      },
    };
  }

  /** 攻擊 handle：接回 world 目前的彈幕回合 handle */
  function attackHandleOf(prevDone) {
    const current = world && world.battle ? world.battle.handle : null;
    if (current) {
      if (prevDone === true) current.done = true;
      return {
        kind: 'attack',
        worldHandle: current,
        get done() {
          return current.done === true;
        },
        update() {},
        cancel() {
          if (typeof current.cancel === 'function') current.cancel();
        },
      };
    }
    return {
      kind: 'attack',
      worldHandle: null,
      done: prevDone === true,
      update() {},
      cancel() {},
    };
  }

  /** 序列快照（巢狀：if 分支 / parallel 的每個子序列） */
  function seqSnapshot(seq) {
    const state = seq && seq._state ? seq._state : null;
    if (!state) return null;
    return {
      label: state.label,
      cues: plainClone(state.cues),
      index: state.index,
      done: state.done === true,
      canceled: state.canceled === true,
      current: handleSnapshot(state.current),
    };
  }

  /** 從快照重建序列（不執行任何指令，只還原進度） */
  function seqFromSnapshot(snap) {
    if (!snap || !Array.isArray(snap.cues)) return null;
    const seq = makeSeq(snap.cues, snap.label || '');
    const state = seq._state;
    state.index = Math.max(0, Math.min(snap.cues.length, Math.round(num(snap.index, 0))));
    state.done = snap.done === true;
    state.canceled = snap.canceled === true;
    state.current = handleFromSnapshot(snap.current);
    return seq;
  }

  /**
   * 單一 handle 的快照。
   *
   * 只存「還原需要的識別與計時器」：文字用 slot、演員指令用 actor id、
   * wait/shake/flash 用 elapsed、巢狀序列遞迴、attack 只存 done。
   * @param {object|null} h
   */
  function handleSnapshot(h) {
    if (!h) return null;
    switch (h.kind) {
      case 'immediate':
        return { kind: 'immediate' };
      case 'text':
        return { kind: 'text', slot: num(h.slot, 0) };
      case 'move':
        return { kind: 'move', actor: h.actor };
      case 'anim':
        return { kind: 'anim', actor: h.actor, targetName: h.targetName };
      case 'fade':
        return { kind: 'fade', actor: h.actor };
      case 'wait':
      case 'shake':
      case 'flash': {
        const own = typeof h.snapshotState === 'function' ? h.snapshotState() : null;
        return { kind: h.kind, frames: num(h.frames, 0), state: own };
      }
      case 'seq':
        return { kind: 'seq', seq: seqSnapshot(h.seq) };
      case 'parallel':
        return { kind: 'parallel', seqs: (h.seqs || []).map(seqSnapshot) };
      case 'attack':
        return { kind: 'attack', done: h.done === true };
      default:
        return { kind: 'unknown', done: h.done === true };
    }
  }

  /** 從快照重建 handle（副作用一律不重播） */
  function handleFromSnapshot(snap) {
    if (!snap || typeof snap !== 'object') return null;
    switch (snap.kind) {
      case 'immediate':
        return immediateHandle();
      case 'text': {
        const textHandle = textHandleOfSlot(snap.slot);
        if (!textHandle) {
          // 文字已經不在（被關閉）→ 視為已完成
          return immediateHandle();
        }
        return makeTextHandle(textHandle);
      }
      case 'move':
        return watchMoveHandle(snap.actor);
      case 'anim':
        return watchAnimHandle(snap.actor, snap.targetName);
      case 'fade':
        return watchFadeHandle(snap.actor);
      case 'wait':
      case 'shake':
      case 'flash': {
        const frames = Math.max(0, Math.round(num(snap.frames, 0)));
        let elapsed = 0;
        let done = false;
        const handle = {
          kind: snap.kind,
          frames,
          done,
          update() {
            elapsed += 1;
            if (elapsed >= frames) handle.done = true;
          },
          snapshotState() {
            return { elapsed };
          },
          restoreState(st) {
            elapsed = Math.max(0, Math.round(num(st && st.elapsed, 0)));
            if (frames > 0 && elapsed >= frames) handle.done = true;
            return true;
          },
        };
        if (snap.state) handle.restoreState(snap.state);
        if (frames <= 0) handle.done = true;
        return handle;
      }
      case 'seq': {
        const seq = seqFromSnapshot(snap.seq);
        return seq ? seqHandleOf(seq) : immediateHandle();
      }
      case 'parallel': {
        const seqs = (Array.isArray(snap.seqs) ? snap.seqs : [])
          .map(seqFromSnapshot)
          .filter(Boolean);
        return parallelHandleOf(seqs);
      }
      case 'attack':
        return attackHandleOf(snap.done);
      default:
        return immediateHandle();
    }
  }

  /**
   * 執行器完整狀態（V2-08 snapshot 用）。
   *
   * 內容：進行中的頂層序列（含目前指令的進度、巢狀 if / parallel 的進度、
   * 文字 handle 的 slot、wait / shake / flash 的計時器）與 async 指令清單。
   * 序列的「指令清單」本身也一併存（runner 沒有別的來源可以重建它）。
   */
  function snapshotState() {
    return {
      winState: { ...winState },
      chainSeq,
      chains: chains.map((seq) => ({
        chainId: seq.chainId || 0,
        ...seqSnapshot(seq),
      })),
      asyncHandles: asyncHandles.map((item) => ({
        cue: plainClone(item.cue),
        elapsed: item.elapsed,
        handle: handleSnapshot(item.handle),
      })),
    };
  }

  /**
   * 還原 snapshotState()。
   *
   * 注意：必須在 world 的文字 / 演員 / 彈幕回合都還原之後再呼叫，
   * 文字 handle 才能依 slot 接回來。
   * @param {object} snap
   * @returns {boolean}
   */
  function restoreState(snap) {
    const s = snap && typeof snap === 'object' ? snap : null;
    if (!s) return false;
    chains = [];
    asyncHandles = [];
    winState = {
      said: s.winState?.said === true,
      closing: typeof s.winState?.closing === 'string' ? s.winState.closing : null,
    };
    chainSeq = Math.max(0, Math.round(num(s.chainSeq, 0)));
    for (const item of Array.isArray(s.chains) ? s.chains : []) {
      const seq = seqFromSnapshot(item);
      if (!seq) continue;
      if (item.chainId) seq.chainId = item.chainId;
      chainSeq = Math.max(chainSeq, seq.chainId || 0);
      chains.push(seq);
    }
    for (const item of Array.isArray(s.asyncHandles) ? s.asyncHandles : []) {
      const handle = handleFromSnapshot(item.handle);
      if (!handle || handle.done) continue;
      asyncHandles.push({
        handle,
        cue: item.cue ? plainClone(item.cue) : {},
        elapsed: Math.max(0, Math.round(num(item.elapsed, 0))),
      });
    }
    return true;
  }

  /** 依 chainId 取目前的 chain handle（flow / fight 還原 pending 用） */
  function byChainId(id) {
    const wanted = Math.round(num(id, 0));
    if (!wanted) return null;
    for (const seq of chains) {
      if (seq.chainId === wanted) return chainHandleOf(seq);
    }
    return null;
  }

  /** 目前頂層序列數量（除錯 / 測試用） */
  function activeCount() {
    return chains.length;
  }

  return {
    run,
    update,
    busy,
    busyAsync,
    clear,
    activeCount,
    startCue,
    hasPendingAttack,
    /** 目前所有進行中指令的標籤（除錯面板用） */
    labels() {
      return chains.map((s) => s.label).filter(Boolean);
    },
    // V2-08：完整執行期狀態（serialization 用）
    snapshotState,
    restoreState,
    byChainId,
    /** 勝利旁白狀態：{said, closing}（見 startSay） */
    winSay() {
      return { ...winState };
    },
    resetWinSay() {
      winState = { said: false, closing: null };
    },
  };
}

export default createCueRunner;
