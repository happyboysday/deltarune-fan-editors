/**
 * engine/encounter/flow.js — 遭遇戰回合流程狀態機（SPEC-P2 §2 / §4 / §5）
 *
 * 流程：
 *   intro(hooks.intro) → turnStart(turn.start) → menu → resolve → enemyTalk → beforeAttack
 *     → attack → turnEnd(turn.end) → 判定 → turnStart …（或 victory/spared/defeat/flee）
 *
 * 對外 API（§4）：
 *   export function createFlow(world, runner, encounter) → flow
 *   flow.update(input)      每幀推進（index.js 每幀：world.update → runner.update → flow.update）
 *   flow.snapshot()         { phase, turn, menu, fight, result }
 *   flow.on(evt, cb)        'phase' | 'end'
 *   另外提供 flow.start() / flow.reset() / flow.jumpToTurn(i)（index.js 會呼叫）
 *
 * 只透過 §4 列出的介面與世界互動：
 *   world.actors.get / setAnim / list、world.text.say / bubble / clear、
 *   world.party / world.enemies / world.items / world.vars / world.tp、
 *   world.startAttack(ref)、world.damageNumber(x, y, text, color)、world.snapshot()
 *   runner.run(cues, { label }) → handle（handle.done）
 * 另在部分地方「有就用、沒有就自行降級」地使用 E1 的便利方法
 *   （world.enemyById / removeEnemy / addMercy / recordAct / setTurn / boxAnim /
 *     world.text.confirm）——全部以 typeof 檢查，缺了仍可運作。
 *
 * 本模組不碰 DOM、不 import E1 的檔案。
 */

import { createMenu, MENU_MESSAGES, textOf } from './menu.js';
import { createFight } from './fight.js';
import { createRng } from '../rng.js';
import { WIN_NARRATION } from './text.js';

/** 遭遇層固定 30 FPS（與 index.js 一致） */
export const FLOW_FPS = 30;

/** 彈幕結束後等待戰鬥框收回的幀數（§2：框展開 / 收回約 10 幀） */
export const BOX_RETRACT_FRAMES = 12;

/** 回合結束後、進入下一階段前的緩衝幀數 */
export const PHASE_SETTLE_FRAMES = 2;

/** 法術 / 道具等結算的預設旁白（語言見 world.lang） */
export const FLOW_MESSAGES = {
  zh: {
    spareSuccess: (name) => `* 你饶恕了${name || '敌人'}。`,
    spareFail: MENU_MESSAGES.zh.spareFail,
    itemDefault: (name) => `* 你使用了${name || '道具'}。`,
    flee: MENU_MESSAGES.zh.flee,
    actFallback: (name) => `* 你对${name || '敌人'}行动了。`,
  },
  en: {
    spareSuccess: (name) => `* You spared ${name || 'the enemy'}.`,
    spareFail: MENU_MESSAGES.en.spareFail,
    itemDefault: (name) => `* You used ${name || 'the item'}.`,
    flee: MENU_MESSAGES.en.flee,
    actFallback: (name) => `* You acted on ${name || 'the enemy'}.`,
  },
};

/* -------------------------------------------------------------- 工具 */

function num(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

/** 從 input 取「剛按下的鍵」清單（相容 §4 的 normalized input 與原始物件） */
export function pressList(input) {
  if (!input || typeof input !== 'object') return [];
  if (Array.isArray(input.press)) return input.press;
  if (typeof input.has === 'function') {
    return ['confirm', 'cancel', 'up', 'down', 'left', 'right'].filter((k) => input.has(k));
  }
  return [];
}

function isDone(handle) {
  return !handle || handle.done === true;
}

/**
 * 建立回合流程。
 *
 * @param {object} world   §4 的世界（fake 亦可）
 * @param {object} runner  §4 的指令執行器（fake 亦可）
 * @param {object} encounter 正規化後的遭遇
 * @returns {object} flow
 */
export function createFlow(world, runner, encounter) {
  const w = world || {};
  const r = runner || {};
  const enc = encounter || {};
  const settings = enc.settings || {};
  const seed = num(settings.seed, 1);

  /* ------------------------------------------------------------ 事件 */

  const listeners = new Map();

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
      } catch (_err) {
        /* 訂閱者錯誤不影響流程 */
      }
    }
  }

  /* ------------------------------------------------------------ 狀態 */

  /** 目前階段 */
  let phase = 'intro';
  /** 目前回合索引（0 起算） */
  let turnIndex = 0;
  let turnNumber = 0; // 1 起算，獨立於回合定義索引，重複時繼續累加
  /** 終局結果（hook 跑完後才設定，避免 index 提早停止） */
  let result = null;
  /** 是否已啟動 */
  let started = false;
  /** 是否已進入終局（避免重複觸發 hook） */
  let finishing = false;
  /** 是否完全結束 */
  let ended = false;

  /** 目前選單控制器 */
  let menu = null;
  /** 目前 FIGHT 攻擊條控制器 */
  let fight = null;

  /** 目前等待中的 handle（runner 或自訂） */
  let pending = null;
  /** 通用計時器 */
  let timer = 0;

  /** resolve 階段的排程 */
  let resolve = null;

  /** attack 階段的 handle */
  let attackHandle = null;
  /** attack 結束後的收框計時 */
  let attackSettle = 0;

  /** 決定性亂數（turnOrder=random / 攻擊條目標線） */
  let rng = createRng(seed);

  /** 本場曾擊倒 / 曾饒恕的敵人 id */
  const defeatedEnemies = new Set();
  const sparedEnemies = new Set();


  /* ================================================================= */
  /* 快照 / 還原（V2-08）                                                */
  /* ================================================================= */

  /** 快照格式版本 */
  const SNAPSHOT_VERSION = 1;

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

  /** RNG 狀態（flow.rng 給 turnOrder=random 與攻擊條目標線用） */
  function rngState() {
    return typeof rng.getState === 'function' ? rng.getState() : null;
  }

  /**
   * 把「等待中的 handle」變成可序列化的描述。
   *
   * runner 的 handle 用 chainId 認（還原時再從 runner 接回來）；
   * waitThen 包裝的 handle 另外存「完成後要執行的動作」描述（否則收尾
   * 動作——加 mercy、記 act、移除敵人——會在還原後消失）。
   */
  /**
   * 包裝「完成後才執行」的 handle，並記下要做的事（快照用）。
   *
   * 動作以描述物件保存（見 runDeferredAction），還原時重建同樣的
   * waitThen 包裝，收尾行為（加 mercy / 記 ACT / 移除敵人 / 事件）才不會掉。
   */
  function waitThenRecorded(inner, actions) {
    const list = Array.isArray(actions) ? actions : [];
    let fired = false;
    const handle = {
      deferred: list,
      get done() {
        if (inner && inner.done !== true) return false;
        if (!fired) {
          fired = true;
          for (const action of list) runDeferredAction(action);
        }
        return true;
      },
    };
    return handle;
  }

  function pendingSnapshot(handle) {
    if (!handle) return null;
    const out = { done: handle.done === true };
    if (handle.chainId) {
      out.key = 'chain';
      out.chainId = handle.chainId;
    } else if (handle.seq && handle.seq.chainId) {
      out.key = 'chain';
      out.chainId = handle.seq.chainId;
    } else if (handle.worldHandle) {
      out.key = 'attack';
      out.attackDone = handle.done === true;
    } else {
      out.key = 'raw';
    }
    if (Array.isArray(handle.deferred) && handle.deferred.length > 0) {
      out.actions = plainClone(handle.deferred);
    }
    return out;
  }

  /** 由描述重建等待中的 handle（runner 的 chain 或攻擊 handle） */
  function pendingFromSnapshot(snap) {
    if (!snap) return null;
    const actions = Array.isArray(snap.actions) ? snap.actions : [];
    let inner = null;
    if (snap.key === 'chain' && typeof r.byChainId === 'function') {
      inner = r.byChainId(snap.chainId);
    } else if (snap.key === 'attack') {
      const live = w && w.battle ? w.battle.handle : null;
      inner = {
        done: snap.attackDone === true || !live || live.done === true,
        worldHandle: live || null,
      };
    }
    if (!inner && snap.done) inner = { done: true };
    if (!inner) return null;
    if (actions.length === 0) return inner;
    return waitThenRecorded(inner, actions);
  }

  /** 已延後執行的小動作（resolve 的收尾與補償） */
  function runDeferredAction(action) {
    if (!action || typeof action !== 'object') return;
    switch (action.kind) {
      case 'removeEnemy': {
        const enemy = findEnemy(action.enemyId);
        if (enemy) removeEnemy(enemy);
        break;
      }
      case 'addMercy': {
        const enemy = findEnemy(action.enemyId);
        if (enemy) addMercy(enemy, action.amount);
        break;
      }
      case 'recordAct': {
        const enemy = findEnemy(action.enemyId);
        if (enemy) recordAct(enemy.id, action.actId);
        break;
      }
      case 'note':
        note(action.event || 'log', action.payload || null);
        break;
      default:
        break;
    }
  }

  /**
   * 流程完整執行期狀態（V2-08）。
   *
   * @returns {object} 可直接 structuredClone / JSON 序列化的純資料
   */
  function snapshotState() {
    return {
      kind: 'flow',
      version: SNAPSHOT_VERSION,
      phase,
      turn: turnIndex,
      turnNumber,
      result,
      started,
      finishing,
      ended,
      timer,
      attackSettle,
      rng: rngState(),
      defeatedEnemies: Array.from(defeatedEnemies),
      sparedEnemies: Array.from(sparedEnemies),
      menu: menu && typeof menu.snapshotState === 'function' ? menu.snapshotState() : null,
      fight: fight && typeof fight.snapshotState === 'function' ? fight.snapshotState() : null,
      resolve: resolve
        ? {
            queue: plainClone(resolve.queue || []),
            fights: plainClone(resolve.fights || []),
            idx: resolve.idx,
            stage: resolve.stage,
            pending: pendingSnapshot(resolve.pending),
          }
        : null,
      pending: pendingSnapshot(pending),
      attackHandle: attackHandle
        ? { ref: attackHandle.ref === undefined ? null : attackHandle.ref, done: attackHandle.done === true }
        : null,
    };
  }

  /** 還原流程狀態（V2-08）。必須先還原 world 與 runner。 */
  function restoreState(snap) {
    const s = snap && typeof snap === 'object' ? snap : null;
    if (!s || s.kind !== 'flow' || s.version !== SNAPSHOT_VERSION) return false;

    phase = typeof s.phase === 'string' ? s.phase : 'intro';
    turnIndex = Math.max(0, Math.round(num(s.turn, 0)));
    turnNumber = Math.max(0, Math.round(num(s.turnNumber, phase === 'intro' ? 0 : turnIndex + 1)));
    result = s.result === undefined ? null : s.result;
    started = s.started === true;
    finishing = s.finishing === true;
    ended = s.ended === true;
    timer = num(s.timer, 0);
    attackSettle = Math.max(0, Math.round(num(s.attackSettle, 0)));
    if (s.rng && typeof rng.setState === 'function') rng.setState(s.rng);

    defeatedEnemies.clear();
    for (const id of Array.isArray(s.defeatedEnemies) ? s.defeatedEnemies : []) {
      defeatedEnemies.add(String(id));
    }
    sparedEnemies.clear();
    for (const id of Array.isArray(s.sparedEnemies) ? s.sparedEnemies : []) {
      sparedEnemies.add(String(id));
    }

    menu = null;
    if (s.menu && typeof createMenu === 'function') {
      menu = createMenu({
        encounter: enc,
        party: () => partyList(),
        enemies: () => enemyList(),
        items: () => itemList(),
        tp: () => num(w.tp, 0),
        lang,
        onSfx: (name) => {
          if (w.pushSfx) w.pushSfx(name);
        },
        onAction: (entry) => {
          const p = partyList().find((x) => x && x.id === entry.memberId);
          if (p) p.action = entry.command;
        },
      });
      if (typeof menu.start === 'function') menu.start();
      if (typeof menu.restoreState === 'function') menu.restoreState(s.menu);
    }

    fight = null;
    if (s.fight && typeof createFight === 'function') {
      fight = createFight({ world: w, runner: r, fps: FLOW_FPS });
      if (typeof fight.restoreState === 'function') fight.restoreState(s.fight);
    }

    resolve = null;
    if (s.resolve) {
      resolve = {
        queue: plainClone(s.resolve.queue || []),
        fights: plainClone(s.resolve.fights || []),
        idx: Math.max(0, Math.round(num(s.resolve.idx, 0))),
        stage: s.resolve.stage === 'fight' ? 'fight' : 'actions',
        pending: pendingFromSnapshot(s.resolve.pending),
      };
    }

    pending = pendingFromSnapshot(s.pending);

    attackHandle = null;
    if (s.attackHandle) {
      attackHandle = w && w.battle ? w.battle.handle : null;
      if (attackHandle && s.attackHandle.done === true) attackHandle.done = true;
    }
    return true;
  }

  /* --------------------------------------------------------- 小工具 */

  const m = () => (w.lang === 'en' ? FLOW_MESSAGES.en : FLOW_MESSAGES.zh);
  const lang = () => (w.lang === 'en' ? 'en' : 'zh');

  function partyList() {
    return Array.isArray(w.party) ? w.party : [];
  }
  function enemyList() {
    return Array.isArray(w.enemies) ? w.enemies : [];
  }
  function itemList() {
    return Array.isArray(w.items) ? w.items : [];
  }

  function getTp() {
    return num(w.tp, 0);
  }
  function addTp(amount) {
    try {
      // world.setTp 會夾範圍並發 'tp' 事件；沒有就退回直接賦值（fake world）
      if (typeof w.setTp === 'function') {
        w.setTp(getTp() + num(amount, 0), 'defend');
        return;
      }
      w.tp = Math.max(0, Math.min(100, getTp() + num(amount, 0)));
    } catch (_e) {
      /* 唯讀 world 時忽略 */
    }
  }
  function spendTp(amount) {
    try {
      if (typeof w.setTp === 'function') {
        w.setTp(getTp() - Math.max(0, num(amount, 0)), 'magic');
        return;
      }
      w.tp = Math.max(0, Math.min(100, getTp() - Math.max(0, num(amount, 0))));
    } catch (_e) {
      /* 忽略 */
    }
  }

  function findParty(id) {
    for (const p of partyList()) if (p && p.id === id) return p;
    return null;
  }
  function findEnemy(id) {
    if (typeof w.enemyById === 'function') {
      try {
        const e = w.enemyById(id);
        if (e) return e;
      } catch (_e) {
        /* 忽略 */
      }
    }
    for (const e of enemyList()) if (e && e.id === id) return e;
    return null;
  }
  function livingEnemies() {
    return enemyList().filter((e) => e && !e.removed && num(e.hp, 0) > 0);
  }
  function aliveParty() {
    return partyList().filter((p) => p && num(p.hp, 0) > 0);
  }

  function partyAt(index) {
    return partyList()[index] || null;
  }

  /** 隊員 / 敵人對應的演員 id */
  function actorOfParty(index) {
    const p = partyAt(index);
    return p ? p.actor || p.id : null;
  }
  function actorOfEnemy(enemy) {
    return enemy ? enemy.actor || enemy.id : null;
  }

  function setAnim(actorId, animName, opts) {
    if (!actorId || !animName) return;
    const actors = w.actors;
    if (!actors || typeof actors.setAnim !== 'function') return;
    try {
      actors.setAnim(actorId, animName, { loop: false, ...opts });
    } catch (_e) {
      /* 缺演員不影響流程 */
    }
  }

  /** 演員（或隊員備用座標）位置，供傷害數字定位 */
  function posOfParty(index) {
    const p = partyAt(index);
    const actorId = actorOfParty(index);
    const actors = w.actors;
    if (actors && typeof actors.get === 'function' && actorId) {
      try {
        const a = actors.get(actorId);
        if (a) return { x: num(a.x, 320), y: num(a.y, 200) };
      } catch (_e) {
        /* 忽略 */
      }
    }
    return { x: num(p && p.x, 160), y: num(p && p.y, 200) };
  }

  function posOfEnemy(enemy) {
    const actorId = actorOfEnemy(enemy);
    const actors = w.actors;
    if (actors && typeof actors.get === 'function' && actorId) {
      try {
        const a = actors.get(actorId);
        if (a) return { x: num(a.x, 520), y: num(a.y, 170) };
      } catch (_e) {
        /* 忽略 */
      }
    }
    return { x: 520, y: 170 };
  }

  function damageNumber(x, y, text, color) {
    if (typeof w.damageNumber !== 'function') return;
    try {
      w.damageNumber(x, y, text, color);
    } catch (_e) {
      /* 忽略 */
    }
  }

  function clearText() {
    if (w.text && typeof w.text.clear === 'function') {
      try {
        w.text.clear();
      } catch (_e) {
        /* 忽略 */
      }
    }
  }

  /** 執行一段指令清單；空清單回 null（代表立刻完成） */
  function runCues(cues, label) {
    if (!Array.isArray(cues) || cues.length === 0) return null;
    if (typeof r.run !== 'function') return null;
    try {
      return r.run(cues, { label: label || '' });
    } catch (_e) {
      return null;
    }
  }

  /** 目前的回合資料（沒有 turns 時給一個空回合，讓流程仍可跑） */
  function currentTurn() {
    const turns = Array.isArray(enc.turns) ? enc.turns : [];
    if (turns.length === 0) return null;
    return turns[Math.max(0, Math.min(turns.length - 1, turnIndex))] || null;
  }

  function setPhase(next) {
    if (phase === next) return;
    phase = next;
    emit('phase', { phase, turn: turnIndex });
  }

  /* ------------------------------------------------------------ 事件 */
  /* 只加「觀察用」事件：不改任何流程判斷，模擬器與難度報告靠它們記錄過程。 */

  /** 發出觀察事件（訂閱者錯誤不影響流程）。 */
  function note(type, payload) {
    // 1) 轉給 world.emit → index.onWorldEvent → enc.on(type)（模擬器主要走這條）
    if (typeof w.emit === 'function') {
      try {
        w.emit(type, payload);
      } catch (_e) {
        /* 忽略 */
      }
    }
    // 2) flow 自己的訂閱者（tests/encounter-flow 直接掛 flow.on）
    emit(type, payload);
  }

  /** 回合開始（beginTurn 的最後一行；turn 從 0 起算）。 */
  function noteTurnStart() {
    note('turnStart', { turn: turnIndex, phase });
  }

  /** 回合結束（beginTurnEnd 的最後一行）。 */
  function noteTurnEnd() {
    note('turnEnd', { turn: turnIndex, phase });
  }

  function setWorldTurn(i) {
    if (typeof w.setTurn === 'function') {
      try {
        w.setTurn(i);
      } catch (_e) {
        /* 忽略 */
      }
    }
  }

  /* ============================================================ 階段 */

  /**
   * 每幀推進。
   * @param {object} [input] { press: [...], hold: {} } 或 normalized input
   */
  function update(input) {
    if (ended) return;

    switch (phase) {
      case 'intro':
        tickIntro();
        break;
      case 'turnStart':
        tickTurnStart();
        break;
      case 'menu':
        tickMenu(input);
        break;
      case 'resolve':
        tickResolve(input);
        break;
      case 'enemyTalk':
        tickEnemyTalk();
        break;
      case 'beforeAttack':
        tickBeforeAttack();
        break;
      case 'attack':
        tickAttack();
        break;
      case 'turnEnd':
        tickTurnEnd();
        break;
      case 'victory':
      case 'spared':
      case 'defeat':
      case 'flee':
        tickResult();
        break;
      default:
        break;
    }
  }

  /* ------------------------------------------------------------ intro */

  function start() {
    if (started) return;
    started = true;
    phase = 'intro';
    setPhase('intro');
    pending = runCues(enc.hooks && enc.hooks.intro, 'hooks.intro');
    if (isDone(pending)) {
      pending = null;
      beginTurn(0);
    }
  }

  function tickIntro() {
    if (!isDone(pending)) return;
    pending = null;
    beginTurn(0);
  }

  /* -------------------------------------------------------- turnStart */

  function beginTurn(index) {
    const turns = Array.isArray(enc.turns) ? enc.turns : [];
    turnIndex = turns.length === 0 ? 0 : Math.max(0, Math.min(turns.length - 1, Math.round(num(index, 0))));
    turnNumber += 1;
    setWorldTurn(turnIndex);
    // 回合開始：清除上回合的防禦 / 行動標記
    for (const p of partyList()) {
      if (!p) continue;
      p.defending = false;
      p.action = null;
    }
    pending = null;
    timer = 0;
    menu = null;
    fight = null;
    resolve = null;
    attackHandle = null;
    setPhase('turnStart');
    noteTurnStart();
    const t = currentTurn();
    pending = runCues(t && t.start, `turns[${turnIndex}].start`);
    if (isDone(pending)) {
      pending = null;
      openMenu();
    }
  }

  function tickTurnStart() {
    if (!isDone(pending)) return;
    pending = null;
    openMenu();
  }

  /* ------------------------------------------------------------- menu */

  function openMenu() {
    const t = currentTurn();
    menu = createMenu({
      encounter: enc,
      party: () => partyList(),
      enemies: () => enemyList(),
      items: () => itemList(),
      tp: () => getTp(),
      lang: () => lang(),
      onSfx: (name) => {
        if (typeof w.pushSfx === 'function') w.pushSfx(name);
      },
      onAction: (entry) => {
        const p = partyAt(entry.member);
        if (p) p.action = entry.command;
      },
    });
    menu.start();
    setPhase('menu');

    // 旁白：turn.flavor，否則 settings.introText（§2）
    const flavor = (t && t.flavor) || settings.introText || '';
    if (flavor && w.text && typeof w.text.say === 'function') {
      try {
        w.text.say({ text: flavor });
      } catch (_e) {
        /* 忽略 */
      }
    }
  }

  function tickMenu(input) {
    if (!menu) {
      openMenu();
      return;
    }
    const res = menu.update(input);
    if (res && res.event && res.event.type === 'cancelFirst') {
      // 第一位隊員按 X：只有 canFlee 時才當成逃跑
      if (settings.canFlee) {
        menu = null;
        clearText();
        finish('flee');
      }
      return;
    }
    if (!res || !res.done) return;
    const actions = typeof menu.actions === 'function' ? menu.actions() : [];
    menu = null;
    beginResolveOrder(actions);
  }

  /* ---------------------------------------------------------- resolve */

  /**
   * 依 §2 的順序安排 resolve：
   *   spare / act / magic / item 依隊伍順序演出 → 最後處理所有 fight
   *   defend 在結算開始時立即生效（TP +16、本回合受傷減半）。
   */
  function beginResolveOrder(actions) {
    clearText();
    const ordered = (Array.isArray(actions) ? actions : [])
      .slice()
      .sort((a, b) => num(a.member, 0) - num(b.member, 0));

    // 記錄每位隊員的行動；被 ACT 佔用者標記為 act
    for (const entry of ordered) {
      const p = partyAt(entry.member);
      if (!p) continue;
      p.action = entry.occupied ? 'act' : entry.command || null;
    }

    // 只加事件：本回合所有指令選擇（fight/act/magic/item/spare/defend + 目標/選項）
    note('actions', {
      turn: turnIndex,
      actions: ordered.map((entry) => {
        const p = partyAt(entry.member);
        return {
          member: num(entry.member, 0),
          memberId: entry.memberId || (p && p.id) || null,
          command: entry.occupied ? 'act' : entry.command || null,
          occupied: Boolean(entry.occupied),
          target: entry.target === undefined ? null : entry.target,
          actId: entry.actId === undefined ? null : entry.actId,
          spellId: entry.spellId === undefined ? null : entry.spellId,
          itemIndex: entry.itemIndex === undefined ? null : entry.itemIndex,
          itemId: entry.itemId === undefined ? null : entry.itemId,
          targetMember: entry.targetMember === undefined ? null : entry.targetMember,
        };
      }),
    });

    // DEFEND：立即生效
    for (const entry of ordered) {
      if (entry.command !== 'defend') continue;
      const p = partyAt(entry.member);
      if (!p) continue;
      p.defending = true;
      p.action = 'defend';
      addTp(16);
      setAnim(actorOfParty(entry.member), 'defend');
      // 只加事件：防禦（TP +16 已在 world.setTp 發 'tp' 事件）
      note('defend', { turn: turnIndex, member: num(entry.member, 0), memberId: p.id || null });
    }

    // 被 ACT 佔用的隊員：一起播 act 動作（不另外結算）
    for (const entry of ordered) {
      if (!entry.occupied) continue;
      const leader = ordered.find((action) => action.occupiedMembers?.includes(entry.member));
      if (leader && findAct(findEnemy(leader.target), leader.actId)?.autoAnim === false) continue;
      setAnim(actorOfParty(entry.member), 'act');
    }

    const nonFight = ordered.filter(
      (e) => !e.occupied && e.command && e.command !== 'fight' && e.command !== 'defend',
    );
    const fights = ordered.filter((e) => !e.occupied && e.command === 'fight');

    resolve = {
      queue: nonFight,
      fights,
      idx: 0,
      stage: 'actions',
      pending: null,
    };
    setPhase('resolve');

    if (nonFight.length === 0) {
      afterResolveActions();
      return;
    }
    nextResolveAction();
  }

  function nextResolveAction() {
    if (!resolve) return;
    if (resolve.idx >= resolve.queue.length) {
      afterResolveActions();
      return;
    }
    const entry = resolve.queue[resolve.idx];
    resolve.idx += 1;
    let handle = null;
    switch (entry.command) {
      case 'spare':
        handle = resolveSpare(entry);
        break;
      case 'act':
        handle = resolveAct(entry);
        break;
      case 'magic':
        handle = resolveMagic(entry);
        break;
      case 'item':
        handle = resolveItem(entry);
        break;
      default:
        handle = null;
        break;
    }
    resolve.pending = handle;
    if (isDone(handle)) {
      resolve.pending = null;
      nextResolveAction();
    }
  }

  function tickResolve(input) {
    if (!resolve) {
      afterResolveActions();
      return;
    }
    if (resolve.stage === 'actions') {
      if (!isDone(resolve.pending)) return;
      resolve.pending = null;
      nextResolveAction();
      return;
    }
    if (resolve.stage === 'fight') {
      tickFight(input);
      return;
    }
  }

  /** 非 fight 行動跑完 → 判斷是否要打 FIGHT 或直接下一階段 */
  function afterResolveActions() {
    if (!resolve) return;
    if (livingEnemies().length === 0 || aliveParty().length === 0) {
      resolve = null;
      beginTurnEnd();
      return;
    }
    if (resolve.fights.length > 0) {
      startFightStage();
      return;
    }
    resolve = null;
    beginEnemyTalk();
  }

  /**
   * fight 全部結算完 → 下一階段。
   * 只會往前推進（絕不再回頭開 fight），避免 startFightStage ⇄ afterFightStage 互呼叫。
   */
  function afterFightStage() {
    resolve = null;
    fight = null;
    if (livingEnemies().length === 0 || aliveParty().length === 0) {
      beginTurnEnd();
      return;
    }
    beginEnemyTalk();
  }

  /* ------------------------------------------------------ resolve 各行動 */

  /** SPARE：mercy ≥ spareAt → onSpare + 移除；否則失敗旁白 */
  function resolveSpare(entry) {
    const enemy = findEnemy(entry.target);
    if (!enemy || enemy.removed) return null;
    setAnim(actorOfParty(entry.member), 'spare', { keepIfMissing: true });
    const spareAt = num(enemy.spareAt, 100);
    const ok = num(enemy.mercy, 0) >= spareAt;
    // 只加事件：饒恕嘗試（成功與否都記）
    note('spare', {
      turn: turnIndex,
      member: num(entry.member, 0),
      memberId: entry.memberId || (partyAt(entry.member) && partyAt(entry.member).id) || null,
      enemy: enemy.id,
      ok,
      mercy: num(enemy.mercy, 0),
      spareAt,
    });
    if (!ok) {
      return runCues([{ cmd: 'say', text: m().spareFail }], `spareFail:${enemy.id}`);
    }
    sparedEnemies.add(enemy.id);
    setAnim(actorOfEnemy(enemy), 'spared');
    const cues = Array.isArray(enemy.onSpare) ? enemy.onSpare.slice() : [];
    if (cues.length === 0) {
      cues.push({ cmd: 'say', text: m().spareSuccess(textOf(enemy.name, lang())) });
    }
    const handle = runCues(cues, `onSpare:${enemy.id}`);
    return waitThenRecorded(handle, [{ kind: 'removeEnemy', enemyId: enemy.id }]);
  }

  function findAct(enemy, id) {
    return enemy?.acts?.find((act) => act.id === id);
  }

  /** ACT：顯示 text → 執行 cues → mercy（上限 100）+ 記錄使用次數 */
  function resolveAct(entry) {
    const enemy = findEnemy(entry.target);
    if (!enemy || enemy.removed) return null;
    const act = findAct(enemy, entry.actId);
    if (!act) return null;

    if (act.autoAnim !== false) {
      setAnim(actorOfParty(entry.member), 'act');
      if (Array.isArray(act.party)) {
        for (const memberId of act.party) {
          const p = findParty(memberId);
          if (p && p.actor) setAnim(p.actor, 'act');
        }
      }
    }

    // 只加事件：ACT 執行（誰對誰用了哪個 ACT、文字與 mercy 增量）
    note('act', {
      turn: turnIndex,
      member: num(entry.member, 0),
      memberId: entry.memberId || (partyAt(entry.member) && partyAt(entry.member).id) || null,
      enemy: enemy.id,
      actId: act.id,
      text: act.text === undefined ? null : act.text,
      mercy: num(act.mercy, 0),
    });

    const cues = [];
    if (act.text) cues.push({ cmd: 'say', text: act.text });
    if (Array.isArray(act.cues)) cues.push(...act.cues);
    const handle = runCues(cues, `act:${enemy.id}.${act.id}`);
    const deferred = [
      {
        kind: 'note',
        event: 'actDone',
        payload: { enemy: enemy.id, actId: act.id },
      },
    ];
    if (num(act.mercy, 0) > 0) {
      deferred.push({ kind: 'addMercy', enemyId: enemy.id, amount: num(act.mercy, 0) });
    }
    deferred.push({ kind: 'recordAct', enemyId: enemy.id, actId: act.id });
    return waitThenRecorded(handle, deferred);
  }

  /** MAGIC：扣 TP → 執行 spell.cues */
  function resolveMagic(entry) {
    const p = partyAt(entry.member);
    if (!p) return null;
    const spells = Array.isArray(p.spells) ? p.spells : [];
    const spell = spells.find((s) => s && s.id === entry.spellId);
    if (!spell) return null;
    const cost = Math.max(0, num(spell.tp, 0));
    spendTp(cost);
    setAnim(actorOfParty(entry.member), 'magic');
    // 只加事件：魔法（TP 花費由 world 的 'tp' 事件另行記錄）
    note('magic', {
      turn: turnIndex,
      member: num(entry.member, 0),
      memberId: p.id || null,
      spellId: spell.id,
      cost,
    });
    return runCues(spell.cues, `spell:${spell.id}`);
  }

  /** ITEM：回復 HP → 顯示 text → count 減 1（0 時選單自然不再列出） */
  function resolveItem(entry) {
    const p = partyAt(entry.member);
    if (!p) return null;
    const items = itemList();
    const item = items[num(entry.itemIndex, -1)];
    if (!item || num(item.count, 0) <= 0) return null;

    setAnim(actorOfParty(entry.member), 'item');

    const targetIndex =
      entry.targetMember === undefined || entry.targetMember === null
        ? entry.member
        : num(entry.targetMember, entry.member);
    const target = partyAt(targetIndex);
    const heal = Math.max(0, Math.round(num(item.heal, 0)));
    if (target && heal > 0) {
      const from = Math.max(0, num(target.hp, 0));
      const to = Math.min(num(target.maxHp, 9999), from + heal);
      target.hp = to;
      if (to > 0) {
        target.down = false;
        if (from <= 0) setAnim(actorOfParty(targetIndex), 'idle', { loop: true });
      }
      const pos = posOfParty(targetIndex);
      damageNumber(pos.x, pos.y, `+${to - from}`, '#40ff80');
    }
    item.count = Math.max(0, num(item.count, 1) - 1);

    // 只加事件：道具使用（HP 變化由 world 的 'hp' 事件另行記錄）
    note('item', {
      turn: turnIndex,
      member: num(entry.member, 0),
      memberId: p.id || null,
      itemId: item.id || null,
      itemIndex: num(entry.itemIndex, -1),
      targetMember: targetIndex,
      heal,
      countLeft: item.count,
    });

    const text = item.text || m().itemDefault(textOf(item.name, lang()));
    return runCues([{ cmd: 'say', text }], `item:${item.id}`);
  }

  /** 移除敵人（演員淡出；HP ≤ 0 時播 defeat） */
  function removeEnemy(enemy) {
    if (!enemy) return;
    if (num(enemy.hp, 0) > 0) setAnim(actorOfEnemy(enemy), 'spared');
    enemy.removed = true;
    if (typeof w.removeEnemy === 'function') {
      try {
        w.removeEnemy(enemy.id, { duration: 0.4 });
        return;
      } catch (_e) {
        /* 落到下面的自行處理 */
      }
    }
    const actors = w.actors;
    const actorId = actorOfEnemy(enemy);
    if (actors && typeof actors.setAlpha === 'function' && actorId) {
      try {
        actors.setAlpha(actorId, 0, 0.4);
      } catch (_e) {
        /* 忽略 */
      }
    }
  }

  /** 敵人 mercy 增加（優先走 world.addMercy，否則自行夾範圍） */
  function addMercy(enemy, amount) {
    if (!enemy) return;
    if (typeof w.addMercy === 'function') {
      try {
        w.addMercy(enemy.id, amount);
        return;
      } catch (_e) {
        /* 落到下面 */
      }
    }
    enemy.mercy = Math.max(0, Math.min(100, num(enemy.mercy, 0) + num(amount, 0)));
  }

  /** 記錄 ACT 使用次數（actCount 表達式用） */
  function recordAct(enemyId, actId) {
    if (typeof w.recordAct === 'function') {
      try {
        w.recordAct(enemyId, actId);
        return;
      } catch (_e) {
        /* 忽略 */
      }
    }
    if (w.vars && typeof w.vars === 'object') {
      const key = `__act_${enemyId}_${actId}`;
      w.vars[key] = num(w.vars[key], 0) + 1;
    }
  }

  /* ------------------------------------------------------------ FIGHT */

  function startFightStage() {
    if (!resolve) return;
    const entries = [];
    for (const entry of resolve.fights) {
      const enemy = findEnemy(entry.target);
      if (!enemy || enemy.removed || num(enemy.hp, 0) <= 0) continue;
      const p = partyAt(entry.member);
      entries.push({
        member: entry.member,
        memberId: entry.memberId || (p && p.id),
        color: (p && p.color) || '#ffffff',
        atk: p ? p.atk : 10,
        target: enemy.id,
        targetName: textOf(enemy.name, lang()),
        def: enemy.def,
      });
    }
    if (entries.length === 0) {
      // 沒有可打擊的目標（全部已倒下 / 已逃離）→ 直接進下一階段，不重開 fight
      resolve.fights = [];
      afterFightStage();
      return;
    }
    fight = createFight({ world: w, runner: r });
    fight.start(entries);
    resolve.stage = 'fight';
    timer = 0;
  }

  function tickFight(input) {
    if (!fight) {
      afterFightStage();
      return;
    }
    fight.update(input);
    if (!fight.done) return;
    // 收集結果（誰被打倒）
    const results = typeof fight.results !== 'undefined' ? fight.results : [];
    for (const res of results) {
      if (res && res.defeated && res.target) defeatedEnemies.add(res.target);
    }
    fight = null;
    afterFightStage();
  }

  /* -------------------------------------------------------- enemyTalk */

  function beginEnemyTalk() {
    setPhase('enemyTalk');
    pending = null;
    timer = 0;
    const t = currentTurn();
    const talk = t && Array.isArray(t.talk) ? t.talk : [];
    if (talk.length === 0) {
      beginBeforeAttack();
      return;
    }
    const parallel = talk.some((x) => x && x.parallel === true);
    const cues = talk.map((x) => ({
      cmd: 'bubble',
      actor: x && x.actor ? x.actor : '',
      text: x && x.text !== undefined ? x.text : '',
      side: x && x.side,
      speed: num(x && x.speed, 1),
      wait: 'input',
    }));
    pending = runCues(
      parallel ? [{ cmd: 'parallel', cues }] : cues,
      `turns[${turnIndex}].talk`,
    );
    if (isDone(pending)) {
      pending = null;
      beginBeforeAttack();
    }
  }

  function tickEnemyTalk() {
    if (!isDone(pending)) return;
    pending = null;
    beginBeforeAttack();
  }

  function beginBeforeAttack() {
    const cues = currentTurn()?.beforeAttack;
    if (!Array.isArray(cues) || cues.length === 0) {
      beginAttack();
      return;
    }
    setPhase('beforeAttack');
    pending = runCues(cues, `turns[${turnIndex}].beforeAttack`);
    tickBeforeAttack();
  }

  function tickBeforeAttack() {
    if (!isDone(pending) || finishing) return;
    pending = null;
    beginAttack();
  }

  /* ------------------------------------------------------------ attack */

  function beginAttack() {
    setPhase('attack');
    note('attackBegin', { turn: turnIndex, ref: currentTurn() ? currentTurn().attack || null : null });
    pending = null;
    attackSettle = 0;
    const t = currentTurn();
    const ref = t ? t.attack : null;
    if (!ref) {
      beginTurnEnd();
      return;
    }
    let handle = null;
    try {
      handle = w.startAttack ? w.startAttack(ref) : null;
    } catch (_e) {
      handle = null;
    }
    attackHandle = handle;
    if (isDone(handle)) {
      // 找不到攻擊檔等同步失敗 → 短暫收框後進 turnEnd
      attackHandle = null;
      attackSettle = 0;
    }
  }

  function tickAttack() {
    if (attackHandle) {
      if (!isDone(attackHandle)) return;
      attackHandle = null;
      attackSettle = 0;
      return;
    }
    // 等戰鬥框收回（有 world.boxAnim 就用它，否則用固定幀數）
    attackSettle += 1;
    const boxAnim = num(w.boxAnim, 0);
    if (boxAnim > 0 && attackSettle < BOX_RETRACT_FRAMES * 3) return;
    if (attackSettle < BOX_RETRACT_FRAMES && boxAnim === 0) {
      // 框已收回，稍微停一下讓玩家回神
      if (attackSettle < 4) return;
    }
    beginTurnEnd();
  }

  /* ----------------------------------------------------------- turnEnd */

  // turn.end 可能還有彈幕；最後一段結束後、下一條 cue 啟動前才收防禦。
  function settleDefense() {
    if (phase !== 'turnEnd' || w.attackActive?.() || r.hasPendingAttack?.()) return false;
    for (const p of partyList()) {
      if (!p.defending) continue;
      p.defending = false;
      if (p.hp <= 0 || p.down) continue;
      const actorId = p.actor || p.id;
      if (w.actors.get(actorId)?.animName === 'defend') w.actors.setAnim(actorId, 'idle');
    }
    return true;
  }

  function beginTurnEnd() {
    setPhase('turnEnd');
    noteTurnEnd();
    pending = null;
    fight = null;
    const t = currentTurn();
    pending = runCues(t && t.end, `turns[${turnIndex}].end`);
    tickTurnEnd();
  }

  function tickTurnEnd() {
    if (!settleDefense() || !isDone(pending)) return;
    pending = null;
    judge();
  }

  /* ------------------------------------------------------------- 判定 */

  /** 下一個回合索引（turnOrder 三種模式） */
  function nextTurnIndex(current) {
    const turns = Array.isArray(enc.turns) ? enc.turns : [];
    const n = turns.length;
    if (n === 0) return 0;
    const order = enc.turnOrder || 'loop-last';
    if (order === 'sequential') return (current + 1) % n;
    if (order === 'random') return rng.int(0, n - 1);
    // loop-last
    return Math.min(current + 1, n - 1);
  }

  function judge() {
    if (finishing) return;
    const living = livingEnemies();
    const alive = aliveParty();

    if (living.length === 0) {
      finish(defeatedEnemies.size > 0 ? 'victory' : 'spared');
      return;
    }
    if (alive.length === 0) {
      finish('defeat');
      return;
    }
    beginTurn(nextTurnIndex(turnIndex));
  }

  function finish(kind) {
    if (finishing) return;
    finishing = true;
    ended = false; // 讓終局 hook 還能跑
    menu = null;
    fight = null;
    resolve = null;
    attackHandle = null;
    const resultPhase = ['victory', 'spared', 'defeat', 'flee'].includes(kind) ? kind : 'victory';
    setPhase(resultPhase);
    const hooks = (enc.hooks && enc.hooks[resultPhase]) || [];
    // 結尾補一句「你赢了！」；掛鉤裡真的執行過勝利旁白（say win:true）時，runner 會跳過這一句。
    // 用執行時判斷而不是掃描掛鉤：寫在條件不成立的 if 分支裡的勝利旁白不會讓結尾少一句。
    if (typeof runner.resetWinSay === 'function') runner.resetWinSay();
    const cues = resultPhase === 'spared' || resultPhase === 'victory'
      ? [...hooks, { cmd: 'say', text: WIN_NARRATION, defaultWin: true }]
      : hooks;
    pending = runCues(cues, `hooks.${resultPhase}`);
    if (isDone(pending)) {
      pending = null;
      completeResult(resultPhase);
    }
  }

  function tickResult() {
    if (result) return;
    if (!isDone(pending)) return;
    pending = null;
    completeResult(phase);
  }

  function completeResult(kind) {
    if (result) return;
    result = ['victory', 'spared', 'defeat', 'flee'].includes(kind) ? kind : 'victory';
    ended = true;
    emit('end', { result, turn: turnIndex });
  }

  /* --------------------------------------------------------- snapshot */

  function snapshot() {
    return {
      phase,
      turn: turnIndex,
      turnNumber,
      menu: menu && typeof menu.snapshot === 'function' ? menu.snapshot() : null,
      fight: fight && typeof fight.snapshot === 'function' ? fight.snapshot() : null,
      result,
    };
  }

  /* ------------------------------------------------------- 生命週期 */

  function reset() {
    phase = 'intro';
    turnIndex = 0;
    turnNumber = 0;
    result = null;
    started = false;
    finishing = false;
    ended = false;
    menu = null;
    fight = null;
    pending = null;
    timer = 0;
    resolve = null;
    attackHandle = null;
    attackSettle = 0;
    rng = createRng(seed);
    defeatedEnemies.clear();
    sparedEnemies.clear();
  }

  /** 跳到第 N 回合（編輯器預覽用；不跑 intro） */
  function jumpToTurn(index) {
    const turns = Array.isArray(enc.turns) ? enc.turns : [];
    const i = turns.length === 0 ? 0 : Math.max(0, Math.min(turns.length - 1, Math.round(num(index, 0))));
    reset();
    started = true;
    turnNumber = i;
    beginTurn(i);
  }

  return {
    start,
    update,
    settleDefense,
    snapshot,
    reset,
    jumpToTurn,
    on,
    off,
    // V2-08：完整執行期狀態（serialization 用；不改行為）
    snapshotState,
    restoreState,
    /* --- 除錯 / 測試用 getter --- */
    get phase() {
      return phase;
    },
    get turn() {
      return turnIndex;
    },
    get result() {
      return result;
    },
    get menu() {
      return menu;
    },
    get fight() {
      return fight;
    },
    get paused() {
      return false;
    },
    /** 本場曾擊倒 / 曾饒恕的敵人（判定依據） */
    get defeatedEnemies() {
      return Array.from(defeatedEnemies);
    },
    get sparedEnemies() {
      return Array.from(sparedEnemies);
    },
    /** 測試 / 除錯：目前等待中的 handle */
    get pending() {
      return pending;
    },
  };
}

export default createFlow;
