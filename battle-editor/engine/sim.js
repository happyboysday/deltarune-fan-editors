/**
 * engine/sim.js — 模擬核心（純資料，不碰 DOM）
 *
 * 職責（SPEC §3–§5、§9）：
 *   - 固定 30 FPS 步進；preview 模式完全決定性（同 seed + 同輸入 = 同結果）。
 *   - 時間軸事件：spawn / emitter / box / soul / clear / shake / sfx / end。
 *   - 表達式生成欄位（expr.js 求值，錯誤不中斷並回報）。
 *   - 子彈池化、sprite 動畫索引、hitbox（circle/rect，rect 隨 rotation 旋轉）、
 *     faceVelocity、offscreen、maskToBox、life、alpha、pathX/pathY。
 *   - 靈魂：受輸入移動（play 模式）、限制在可旋轉戰鬥框內、受傷扣隊伍 HP、
 *     無敵幀、擦彈加 TP + 光暈。
 *   - 產出 getState()（SPEC §9 完整形狀），渲染器只讀這份資料。
 *
 * 本模組刻意不 import 任何渲染 / 輸入 / 音效模組，可於 Node 無頭執行。
 */

import { normalizeAttack, FPS } from './attack.js';
import { ARENA_SOUL_RADIUS, bulletClip, clipCorners, clipShape, compileArena, compilePolygon, moveInArena, placeInArena, pointInClip, resolveArenaMove } from './arena.js';
import { GRAVITY_DIRS } from './soul-mechanics.js';
import { compileSoulProfiles, LEGACY_MOVEMENT, mechanismKey, movementInput, SOUL_APPEARANCE, SoulConfigurationError } from './soul-mechanics.js';
import { clipContact, sweptHit } from './soul-collision.js';
import { createRng, noiseSigned } from './rng.js';
import { getEasing } from './easing.js';
import { createHelpers, makeContext, evalNumber, lookupFrom, EMPTY_MEM } from './expr.js';
// 官方擦彈遮罩（內嵌位元資料，執行期不讀 PNG；見 engine/graze-mask.js）
import { maskOverlapCircle, maskOverlapRect } from './graze-mask.js';

export const VIEW_W = 640;
export const VIEW_H = 480;
export const SOUL_RADIUS = ARENA_SOUL_RADIUS;
/**
 * 舊的擦彈外擴半徑（像素）。
 *
 * @deprecated FX-GRAZE 之後擦彈不再是「子彈 hitbox 外擴 + 與靈魂圓形距離」，
 * 而是「子彈 hitbox 與靈魂為中心的心形遮罩（engine/graze-mask.js）像素級重疊」。
 * 這個常數保留匯出只是為了不破壞外部 import；數值僅供舊工具 / 教學文件參考，
 * 引擎的任何判定都不再使用它（等效的判定範圍見 MASK_HALF_W / MASK_RADIUS）。
 */
export const GRAZE_PAD = 16;
export const TP_MAX = 100;
export const MAX_BULLETS = 4000;
const DEG = Math.PI / 180;
const OFFSCREEN_MARGIN = 32;
const MAX_TRIGGERS = 20000;
const MAX_PLAYER_SHOTS = 64;
const SHOT_RADIUS = 2;

/**
 * 預設音效名稱（SPEC §7：擦彈播 graze 音效、受傷有回饋）。
 * 音效索引缺少這些名稱時由 audio.js 靜默忽略，不影響模擬。
 */
const SFX_GRAZE = 'snd_graze';
const SFX_HURT = 'snd_hurt1';

/* ===================================================================== */
/* 工具                                                                   */
/* ===================================================================== */

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function clampStats(v, def = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function makeBullet() {
  return {
    id: 0,
    type: '',
    sprite: null,
    hitbox: { shape: 'circle', r: 6 },
    color: null,
    damage: null,
    grazeable: true,
    decor: false,
    destroyOnHit: true,
    faceVelocity: true,
    offscreen: 'destroy',
    maskToBox: false,
    frameRate: 0,
    x: 0,
    y: 0,
    spawnX: 0,
    spawnY: 0,
    spawnT: 0,
    mem: null,
    speed: 0,
    angle: 0,
    accel: 0,
    angularVel: 0,
    scale: 1,
    rotation: 0,
    rotationOffset: 0,
    alpha: 1,
    fadeAlpha: 1,
    life: null,
    age: 0,
    i: 0,
    n: 1,
    k: 0,
    eventAt: 0,
    pathX: null,
    pathY: null,
    hasPathX: false,
    hasPathY: false,
    pathScale: null,
    pathAlpha: null,
    pathZ: null,
    pathFrame: null,
    frameIdx: null,
    pathRotation: null,
    solidWhen: null,
    baseScale: 1,
    hitbox0: null,
    z: 0,
    solid: true,
    faded: false,
    fadeDur: 0,
    fadeElapsed: 0,
    wasInside: false,
    justSpawned: true,
    grazed: false,
    dead: false,
  };
}

/* ===================================================================== */
/* 模擬                                                                   */
/* ===================================================================== */

/**
 * @param {{mode?:'play'|'preview', onEvent?:(evt:{type:string, payload:any})=>void}} [options]
 */
export function createSimulation(options = {}) {
  const mode = options.mode === 'play' ? 'play' : 'preview';
  const onEvent = typeof options.onEvent === 'function' ? options.onEvent : null;

  /** @type {object} 正規化後的攻擊 */
  let attack = normalizeAttack({});
  let soulConfig = compileSoulProfiles(attack);
  let activeProfile = null, profileId = null, movementState = {}, abilityStates = {}, look = null;
  let heading = 0, soulSpeed = 0, teleportSerial = 0, soulPath = null;
  // soulDrift：{dx, dy, startFrame} 或 null；orient：靈魂圖目前的旋轉角（autoOrient 時朝目標角度轉過去）
  let drift = null, orient = 0;
  let playerShots = [], nextShotId = 1, shotBursts = [];
  const contactClips = new Map();
  let rng = createRng(1);
  // 靈魂軌跡（trailX/trailY 用）：最近 TRAIL_FRAMES 幀的位置，環狀緩衝
  const TRAIL_FRAMES = 300;
  let trail = new Float64Array(TRAIL_FRAMES * 2);
  let trailHead = 0;
  let trailCount = 0;
  const trailAt = (sec) => {
    if (!trailCount) return { x: soul.x, y: soul.y };
    const k = Math.max(0, Math.min(trailCount - 1, Math.round(sec * FPS)));
    const idx = (trailHead - 1 - k + TRAIL_FRAMES * 2) % TRAIL_FRAMES;
    return { x: trail[idx * 2], y: trail[idx * 2 + 1] };
  };
  const trailPush = () => {
    trail[trailHead * 2] = soul.x;
    trail[trailHead * 2 + 1] = soul.y;
    trailHead = (trailHead + 1) % TRAIL_FRAMES;
    trailCount = Math.min(TRAIL_FRAMES, trailCount + 1);
  };
  let helpers = createHelpers(rng, () => ({ x: soul.x, y: soul.y }), trailAt);

  /* --- 模擬狀態 --- */
  let frame = 0;
  let ended = false;
  let endEmitted = false;

  /** @type {object[]} 存活子彈 */
  let bullets = [];
  /** @type {object[]} 回收池 */
  let pool = [];
  let nextBulletId = 1;

  const box = { ...attack.box };
  let arena = compileArena();
  let clipRegion = null;
  /** 自訂裁剪區的原始多邊形與動態設定（clipRegion.motion：x / y / rotation 是時間的運算式） */
  let clipBase = null;
  let clipMotion = null;
  const soul = { x: 0, y: 0, mode: 'red', color: '#ff0000', invFrames: 0, grazing: false, visible: true };
  let party = [];
  let tp = 0;

  let schedule = []; // [{frame, index, ev}]
  let scheduleCursor = 0;
  /** @type {object[]} 進行中的 emitter */
  let emitters = [];
  /** @type {object[]} 進行中的 box 補間 */
  let boxAnims = [];
  /** @type {object[]} 進行中的 shake */
  let shakes = [];

  let sfxQueue = [];
  let grazeFlash = 0;
  let hurtFlash = 0;
  let shakeState = { x: 0, y: 0 };

  /** 已回報的錯誤 key（避免每幀重複洗版） */
  const reportedErrors = new Set();

  /**
   * 子彈 memory 的「底層數值表」。
   *
   * `b.mem` 是 expr.js 的唯讀 Proxy（沒有 ownKeys，列舉不到東西），
   * 所以這裡額外記住它背後那份 name → value 表，snapshot 才存得到 memory。
   * @type {WeakMap<object, object>}
   */
  const memoryStore = new WeakMap();

  /* ------------------------------------------------------------ 事件 */

  function emit(type, payload) {
    if (onEvent) {
      try {
        onEvent({ type, payload });
      } catch (_err) {
        /* 訂閱者錯誤不影響模擬 */
      }
    }
  }

  /** 回報表達式 / 資料錯誤（同一 key 只回報一次） */
  function reportError(eventIndex, field, message, eventId) {
    const key = `${eventIndex}|${field}|${message}`;
    if (reportedErrors.has(key)) return;
    if (reportedErrors.size > 500) return;
    reportedErrors.add(key);
    const path = `timeline[${eventIndex}]${field ? `.${field}` : ''}`;
    emit('error', {
      id: eventId === undefined ? undefined : eventId,
      eventId,
      eventIndex,
      field,
      path,
      message,
    });
  }

  function frameOf(seconds) {
    return Math.max(0, Math.ceil(seconds * FPS - 1e-9));
  }

  /* -------------------------------------------------------- 生成欄位 */

  /** 目前戰鬥框的幾何（含旋轉所需資訊） */
  function boxSnapshot() {
    return {
      x: box.x,
      y: box.y,
      w: box.w,
      h: box.h,
      rotation: box.rotation,
      border: box.border,
      color: box.color,
      ...(box.appearance === 'classic' || !box.appearance ? {} : { appearance: box.appearance }),
    };
  }

  /** 建立表達式 context */
  function exprContext(extra) {
    const e = extra || {};
    const bpm = Number(attack.settings.bpm);
    const ctx = makeContext({
      t: e.t,
      T: e.T,
      i: e.i,
      n: e.n,
      k: e.k,
      age: e.age,
      box,
      soul,
      // SPEC-EXPR-V2 §3：生成座標 / 生成時間 / 拍點常數
      spawnX: e.spawnX,
      spawnY: e.spawnY,
      spawnT: e.spawnT === undefined ? frame / FPS : e.spawnT,
      bpm: bpm > 0 ? bpm : 0,
      beat: bpm > 0 ? 60 / bpm : 0,
      mem: e.mem,
    });
    // x / y 預設為戰鬥框中心；spawn 求值順序中會回填實際生成點
    ctx.x = box.x;
    ctx.y = box.y;
    return ctx;
  }

  /**
   * 求值生成欄位；raw 為 null 時回傳 fallback。
   * @returns {{value:number, present:boolean}}
   */
  function fieldValue(raw, fallback, ctx, eventIndex, eventId, fieldName) {
    if (raw === null || raw === undefined || raw === '') {
      return { value: fallback, present: false };
    }
    const r = evalNumber(raw, ctx, helpers);
    if (r.error) {
      reportError(eventIndex, fieldName, r.error, eventId);
      return { value: 0, present: true };
    }
    return { value: r.value, present: true };
  }

  /**
   * 求值 spawn 的 `memory`（SPEC-EXPR-V2 §3）：每個名字在生成時求值一次，
   * 之後固定在子彈上（`mem.<name>` 於每幀運算式只讀）。
   * 求值順序依物件鍵順序；先算出的名字可以給後面用（`mem` 已指向同一個查表）。
   * @returns {object} 唯讀查表物件（查不到回 0）；沒有 memory 時回 EMPTY_MEM
   */
  function evalMemory(memory, ctx, eventIndex, eventId) {
    if (!memory || typeof memory !== 'object') return EMPTY_MEM;
    const names = Object.keys(memory);
    if (names.length === 0) return EMPTY_MEM;
    const values = Object.create(null);
    const mem = lookupFrom(values);
    // V2-08：記住 Proxy 背後那份數值表，snapshot() 才存得到 memory
    memoryStore.set(mem, values);
    // 讓同一發子彈的 memory / 後續生成欄位都能讀 mem.*
    ctx.mem = mem;
    for (const name of names) {
      const r = evalNumber(memory[name], ctx, helpers);
      if (r.error) {
        reportError(eventIndex, 'memory', r.error, eventId);
        values[name] = 0;
      } else {
        values[name] = r.value;
      }
    }
    return mem;
  }

  /* ---------------------------------------------------------- 子彈池 */

  function acquireBullet() {
    if (pool.length > 0) return pool.pop();
    return makeBullet();
  }

  function releaseBullet(b) {
    b.dead = false;
    b.type = '';
    b.sprite = null;
    b.hitbox = { shape: 'circle', r: 6 };
    b.color = null;
    b.damage = null;
    b.grazeable = true;
    b.decor = false;
    b.destroyOnHit = true;
    b.faceVelocity = true;
    b.offscreen = 'destroy';
    b.maskToBox = false;
    b.clipTo = undefined;
    b.shootable = false;
    b.platform = false;
    b.bounce = 0;
    b.frameRate = 0;
    b.spawnT = 0;
    b.mem = null;
    b.pathX = null;
    b.pathY = null;
    b.hasPathX = false;
    b.hasPathY = false;
    b.pathScale = null;
    b.pathAlpha = null;
    b.pathZ = null;
    b.pathFrame = null;
    b.frameIdx = null;
    b.pathRotation = null;
    b.solidWhen = null;
    b.baseScale = 1;
    b.hitbox0 = null;
    b.z = 0;
    b.solid = true;
    b.faded = false;
    b.fadeAlpha = 1;
    b.grazed = false;
    b.justSpawned = true;
    b.wasInside = false;
    if (pool.length < MAX_BULLETS) pool.push(b);
  }

  /* ------------------------------------------------------------ 生成 */

  /**
   * 生成一發子彈。
   * @param {object} spawnSpec 生成欄位來源（spawn 事件本身，或 emitter.spawn）
   * @param {object} type 正規化後 bulletTypes[name]
   */
  function spawnOne(spawnSpec, typeName, type, ctxBase, eventIndex, eventId) {
    if (bullets.length >= MAX_BULLETS) return;
    const typeInfo = type || null;
    if (!typeInfo) {
      reportError(eventIndex, 'bullet', `找不到子彈類型 "${typeName}"`, eventId);
    }
    const ctx = exprContext({ ...ctxBase, box, soul });
    const x0 = fieldValue(spawnSpec.x, box.x, ctx, eventIndex, eventId, 'x').value;
    const y0 = fieldValue(spawnSpec.y, box.y, ctx, eventIndex, eventId, 'y').value;
    // 後續欄位可用 x / y（例如 angle: "aim(x, y)"）
    ctx.x = x0;
    ctx.y = y0;
    // SPEC-EXPR-V2 §3：spawnX / spawnY / spawnT 在生成時固定，
    // 之後 pathX/pathY/angle/speed 等每幀運算式讀到的都是這個固定值。
    // spawnT 是「回合時間」（frame / FPS），和 t（事件相對時間）不同。
    const spawnT = frame / FPS;
    ctx.spawnX = x0;
    ctx.spawnY = y0;
    ctx.spawnT = spawnT;
    // memory：生成時求值一次並固定在子彈上（之後每幀只讀，不再求值）
    const mem = evalMemory(spawnSpec.memory, ctx, eventIndex, eventId);
    // 讓同一發子彈的後續生成欄位（angle/speed/...）也能讀 mem.<name>
    ctx.mem = mem;
    const speed = fieldValue(spawnSpec.speed, 0, ctx, eventIndex, eventId, 'speed').value;
    const angle = fieldValue(spawnSpec.angle, 0, ctx, eventIndex, eventId, 'angle').value;
    const accel = fieldValue(spawnSpec.accel, 0, ctx, eventIndex, eventId, 'accel').value;
    const angularVel = fieldValue(spawnSpec.angularVel, 0, ctx, eventIndex, eventId, 'angularVel').value;
    const scale = fieldValue(spawnSpec.scale, 1, ctx, eventIndex, eventId, 'scale').value;
    const rotation = fieldValue(spawnSpec.rotation, 0, ctx, eventIndex, eventId, 'rotation').value;
    const alpha = clamp(fieldValue(spawnSpec.alpha, 1, ctx, eventIndex, eventId, 'alpha').value, 0, 1);

    let life = null;
    if (spawnSpec.life !== null && spawnSpec.life !== undefined && spawnSpec.life !== '') {
      const lr = fieldValue(spawnSpec.life, 0, ctx, eventIndex, eventId, 'life');
      life = lr.value > 0 ? lr.value : 0;
    }

    const hasPathX = spawnSpec.pathX !== null && spawnSpec.pathX !== undefined && spawnSpec.pathX !== '';
    const hasPathY = spawnSpec.pathY !== null && spawnSpec.pathY !== undefined && spawnSpec.pathY !== '';

    const b = acquireBullet();
    b.id = nextBulletId++;
    b.type = typeof typeName === 'string' ? typeName : '';
    if (typeInfo) {
      b.sprite = typeInfo.sprite;
      b.hitbox = typeInfo.hitbox;
      b.color = typeInfo.color;
      b.damage = typeInfo.damage;
      b.grazeable = typeInfo.grazeable;
      b.decor = typeInfo.decor === true;
      b.destroyOnHit = typeInfo.destroyOnHit;
      b.faceVelocity = typeInfo.faceVelocity;
      b.offscreen = typeInfo.offscreen;
      b.maskToBox = typeInfo.maskToBox;
      b.clipTo = typeInfo.clipTo;
      b.frameRate = typeInfo.frameRate;
      b.scale = scale * (Number.isFinite(typeInfo.scale) ? typeInfo.scale : 1);
    } else {
      b.sprite = null;
      b.hitbox = { shape: 'circle', r: 6 };
      b.color = null;
      b.damage = null;
      b.grazeable = true;
      b.destroyOnHit = true;
      b.faceVelocity = true;
      b.offscreen = 'destroy';
      b.maskToBox = false;
      b.frameRate = 0;
      b.scale = scale;
    }

    b.x = x0;
    b.y = y0;
    b.shootable = type?.shootable === true;
    // 血量：要被射中幾下才碎（型別 hp，預設 1）；剩餘值同步在 mem.hp，運算式可讀（例：pathFrame "3 - mem.hp"）
    b.hp = Number.isFinite(type?.hp) && type.hp > 1 ? Math.round(type.hp) : 1;
    // 平台（重力跳躍時可以站的上緣）與彈簧床係數
    b.platform = type?.platform === true;
    b.bounce = Number.isFinite(type?.bounce) && type.bounce > 0 ? type.bounce : 0;
    b.spawnX = x0;
    b.spawnY = y0;
    b.spawnT = spawnT;
    b.mem = b.hp > 1 ? memoryFromValues({ ...(memoryValues(mem) || {}), hp: b.hp }) : mem;
    b.speed = speed;
    b.angle = angle;
    b.accel = accel;
    b.angularVel = angularVel;
    b.rotationOffset = rotation;
    // faceVelocity 時 rotation 作為「相對速度方向的額外角度」；
    // 否則 rotation 就是絕對角度，並受 angularVel 累加。
    b.rotation = b.faceVelocity ? b.angle + rotation : rotation;
    b.alpha = alpha;
    b.age = 0;
    b.i = ctxBase.i;
    b.n = ctxBase.n;
    b.k = ctxBase.k;
    b.eventAt = ctxBase.eventAt;
    b.life = life;
    b.pathX = hasPathX ? spawnSpec.pathX : null;
    b.pathY = hasPathY ? spawnSpec.pathY : null;
    b.hasPathX = hasPathX;
    b.hasPathY = hasPathY;
    // 偽 3D（每幀求值）：pathScale 乘在生成縮放上、判定框跟著縮放；pathAlpha 取代透明度；
    // pathZ 是深度（大＝遠，繪製順序由遠到近）；solidWhen 為 0 時不判定（仍顯示）。
    const perFrame = (v) => (v === null || v === undefined || v === '' ? null : v);
    b.pathScale = perFrame(spawnSpec.pathScale);
    b.pathAlpha = perFrame(spawnSpec.pathAlpha);
    b.pathZ = perFrame(spawnSpec.pathZ);
    // pathFrame：每幀求值的動畫幀（取整；renderer 對幀數取餘數）——立體旋轉時依角度挑對應的那張圖
    b.pathFrame = perFrame(spawnSpec.pathFrame);
    // pathRotation：每幀求值的朝向（度）；有值時取代 rotation／angularVel／faceVelocity 的結果，矩形判定跟著轉
    b.pathRotation = perFrame(spawnSpec.pathRotation);
    b.frameIdx = null;
    b.solidWhen = perFrame(spawnSpec.solidWhen);
    b.baseScale = b.scale;
    b.hitbox0 = b.pathScale !== null ? hitboxCopy(b.hitbox) : null;
    b.z = 0;
    b.solid = true;
    b.faded = false;
    b.fadeAlpha = 1;
    b.fadeElapsed = 0;
    b.fadeDur = 0;
    b.wasInside = false;
    b.justSpawned = true;
    b.grazed = false;
    b.dead = false;
    bullets.push(b);
  }

  /** 生成 count 發 */
  function spawnBatch(spawnSpec, count, ctxBase, eventIndex, eventId) {
    const total = Math.max(1, Math.round(count));
    const types = attack.bulletTypes || {};
    for (let i = 0; i < total; i += 1) {
      const typeName = typeof spawnSpec.bullet === 'string' ? spawnSpec.bullet : '';
      const type = Object.prototype.hasOwnProperty.call(types, typeName) ? types[typeName] : null;
      spawnOne(spawnSpec, typeName, type, { ...ctxBase, i, n: total }, eventIndex, eventId);
    }
  }

  /* ------------------------------------------------------ 時間軸事件 */

  /** 預先計算事件觸發幀（依 at、穩定排序） */
  function buildSchedule() {
    const timeline = Array.isArray(attack.timeline) ? attack.timeline : [];
    const list = timeline.map((ev, index) => ({ frame: frameOf(ev.at), index, ev }));
    list.sort((a, b) => (a.frame === b.frame ? a.index - b.index : a.frame - b.frame));
    schedule = list;
    scheduleCursor = 0;
  }

  function fireEvent(entry) {
    const { ev, index } = entry;
    const time = frame / FPS;
    const t = Math.max(0, time - ev.at);
    const T = attack.settings.duration;
    switch (ev.type) {
      case 'spawn': {
        spawnBatch(
          ev,
          ev.count,
          { t, T, k: 0, eventAt: ev.at },
          index,
          ev.id,
        );
        break;
      }
      case 'emitter': {
        startEmitter(ev, index, t, T);
        break;
      }
      case 'box': {
        startBoxAnim(ev, index);
        break;
      }
      case 'soul': {
        // SPEC §4：Phase 1 只有 red 模式；其他值原樣保留在 state 供編輯器顯示，
        // 但行為一律以 red 執行（updateSoul 不看 mode）。
        if (ev.mode !== undefined && ev.mode !== null) soul.mode = ev.mode;
        if (ev.color !== undefined && ev.color !== null) {
          soul.color = ev.color;
          if (look) look = { ...look, color: ev.color };
        }
        teleportSerial += 1;
        const hasX = ev.x !== undefined && ev.x !== null && Number.isFinite(Number(ev.x));
        const hasY = ev.y !== undefined && ev.y !== null && Number.isFinite(Number(ev.y));
        if (hasX) soul.x = Number(ev.x);
        if (hasY) soul.y = Number(ev.y);
        if (!hasX && !hasY) {
          // 只給 mode/color 時把靈魂重置到框中心
          soul.x = box.x;
          soul.y = box.y;
        }
        placeSoul();
        break;
      }
      case 'soulProfile':
        if (soulConfig.profiles.has(ev.profile)) {
          selectSoulProfile(ev.profile);
          emit('soulProfile', { id: profileId, frame });
        }
        break;
      case 'soulAppearance':
        look = { ...(look ?? { ...SOUL_APPEARANCE, color: soul.color }), ...soulConfig.appearances.get(index) };
        soul.color = look.color;
        break;
      case 'soulDrift':
        drift = (ev.dx === 0 || ev.dx === '0') && (ev.dy === 0 || ev.dy === '0') ? null
          : { dx: ev.dx, dy: ev.dy, startFrame: frame };
        break;
      case 'soulTeleport':
        if (Number.isFinite(ev.x) && Number.isFinite(ev.y)) {
          soul.x = ev.x;
          soul.y = ev.y;
          teleportSerial += 1;
          placeSoul();
          emit('soulTeleport', { x: soul.x, y: soul.y, frame });
        }
        break;
      case 'clear': {
        clearBullets(ev.fade);
        playerShots = [];
        shotBursts = [];
        break;
      }
      case 'shake': {
        const durationFrames = Math.max(1, Math.round(ev.duration * FPS));
        shakes.push({ startFrame: frame, durationFrames, amount: ev.amount });
        break;
      }
      case 'anim': {
        emit('anim', { actor: ev.actor, anim: ev.anim, frame });
        break;
      }
      case 'sfx': {
        if (ev.sound) sfxQueue.push(ev.sound);
        break;
      }
      case 'end': {
        endRound();
        break;
      }
      default: {
        reportError(index, 'type', `未知事件類型 "${ev.type}"`, ev.id);
        break;
      }
    }
  }

  /** 建立 emitter 執行期（預先算好每次觸發的幀） */
  function startEmitter(ev, index, t0, T) {
    const interval = Math.max(1 / FPS, Number(ev.interval) || 0);
    const duration = Math.max(0, Number(ev.duration) || 0);
    if (!(duration > 0)) {
      reportError(index, 'duration', 'emitter duration 必須大於 0', ev.id);
      return;
    }
    const triggers = [];
    const startFrame = frameOf(ev.at);
    for (let j = 0; ; j += 1) {
      const at = ev.at + j * interval;
      if (at >= ev.at + duration - 1e-9) break;
      if (triggers.length >= MAX_TRIGGERS) break;
      const f = Math.max(startFrame, frameOf(at));
      triggers.push(f);
      if (j > MAX_TRIGGERS) break;
    }
    if (triggers.length === 0) return;
    emitters.push({
      ev,
      index,
      t0,
      T,
      triggers,
      next: 0,
      spawn: ev.spawn && typeof ev.spawn === 'object' ? ev.spawn : { bullet: '' },
      count: Math.max(1, Math.round(Number(ev.count) || 1)),
    });
  }

  function updateEmitters() {
    if (emitters.length === 0) return;
    const alive = [];
    for (const em of emitters) {
      let fired = false;
      while (em.next < em.triggers.length && em.triggers[em.next] <= frame) {
        const k = em.next;
        em.next += 1;
        fired = true;
        const time = frame / FPS;
        const t = Math.max(0, time - em.ev.at);
        spawnBatch(
          em.spawn,
          em.count,
          { t, T: em.T, k, eventAt: em.ev.at },
          em.index,
          em.ev.id,
        );
      }
      if (fired || em.next < em.triggers.length) alive.push(em);
    }
    emitters = alive;
  }

  /* -------------------------------------------------------- 戰鬥框補間 */

  function startBoxAnim(ev, index) {
    const to = ev.to && typeof ev.to === 'object' ? ev.to : {};
    const keys = ['x', 'y', 'w', 'h', 'rotation'].filter((k) => Number.isFinite(Number(to[k])));
    if (keys.length === 0) {
      reportError(index, 'to', 'box 事件缺少有效目標值', ev.id);
      return;
    }
    const from = {};
    for (const key of keys) from[key] = box[key];
    boxAnims.push({
      keys,
      from,
      to,
      ease: ev.ease,
      startFrame: frame,
      durationFrames: Math.max(1, Math.round(ev.duration * FPS)),
    });
  }

  function updateBoxAnims() {
    if (boxAnims.length === 0) return;
    const alive = [];
    for (const anim of boxAnims) {
      const elapsed = frame - anim.startFrame;
      const u = clamp(elapsed / anim.durationFrames, 0, 1);
      const fn = getEasing(anim.ease);
      const e = u >= 1 ? 1 : fn(u);
      for (const key of anim.keys) {
        const target = Number(anim.to[key]);
        box[key] = anim.from[key] + (target - anim.from[key]) * e;
        if (u >= 1) box[key] = target;
      }
      if (u < 1) alive.push(anim);
    }
    // 寬高不得為負
    box.w = Math.max(1, box.w);
    box.h = Math.max(1, box.h);
    boxAnims = alive;
  }

  /* ------------------------------------------------------------ 震動 */

  function updateShake() {
    let total = 0;
    if (shakes.length > 0) {
      const alive = [];
      for (const s of shakes) {
        const elapsed = frame - s.startFrame;
        const u = s.durationFrames > 0 ? clamp(elapsed / s.durationFrames, 0, 1) : 1;
        if (u < 1) {
          total += s.amount * (1 - u);
          alive.push(s);
        }
      }
      shakes = alive;
    }
    if (total > 0.001) {
      shakeState.x = Math.round(noiseSigned(attack.settings.seed, frame, 1) * total);
      shakeState.y = Math.round(noiseSigned(attack.settings.seed, frame, 2) * total);
    } else {
      shakeState.x = 0;
      shakeState.y = 0;
    }
  }

  /* ------------------------------------------------------------ 靈魂 */

  function placeSoul() {
    const point = placeInArena(arena, box, soul, SOUL_RADIUS);
    soul.x = point.x;
    soul.y = point.y;
  }

  function selectSoulProfile(id) {
    const next = soulConfig.profiles.get(id);
    if (next.movement.def !== activeProfile?.movement.def) {
      movementState = next.movement.def.init(next.movement.params);
      soulSpeed = 0;
    }
    abilityStates = Object.fromEntries(next.abilities.map(({ def, params }) => {
      const key = mechanismKey(def);
      return [key, Object.hasOwn(abilityStates, key) ? abilityStates[key] : def.init(params)];
    }));
    profileId = id;
    activeProfile = next;
    look = next.appearance;
    soul.color = look.color;
  }

  function soulFrameContext(params) {
    return { frame, x: soul.x, y: soul.y, heading, params, random: rng.next };
  }

  function stepSoulProfile(input) {
    const { movement, abilities } = activeProfile;
    const gravity = movement.def.id === 'gravity';
    if (gravity) carryOnPlatform();
    const from = { x: soul.x, y: soul.y };
    const intent = movement.def.step(movementState, input, soulFrameContext(movement.params));
    movementState = intent.state;
    heading = intent.heading;
    let move = intent;
    for (const { def, params } of abilities) {
      if (!def.beforeMove) continue;
      const key = mechanismKey(def);
      const out = def.beforeMove(abilityStates[key], input, soulFrameContext(params));
      abilityStates[key] = out.state;
      if (out.move) move = out.move;
      if (out.triggered) emit('soulAbility', { id: def.id, frame, x: soul.x, y: soul.y });
    }
    heading = move.heading;
    const resolved = resolveArenaMove(arena, box, from, move.dx, move.dy, move.stopAtWall);
    soulPath = resolved.path;
    soul.x = resolved.point.x;
    soul.y = resolved.point.y;
    if (gravity) settleGravity(from, move, movement.params);
    soulSpeed = resolved.path.reduce((sum, { from, to }) => sum + Math.hypot(to.x - from.x, to.y - from.y), 0);
    const result = { ...resolved, overridden: move !== intent };
    if (movement.def.onResolved) movementState = movement.def.onResolved(movementState, result);
    for (const { def, params } of abilities) {
      if (!def.afterMove) continue;
      const key = mechanismKey(def);
      const out = def.afterMove(abilityStates[key], input, { ...soulFrameContext(params), ...result });
      abilityStates[key] = out.state;
      if (!out.shot || playerShots.length >= MAX_PLAYER_SHOTS) continue;
      const dir = out.shot.heading * DEG;
      playerShots.push({
        id: nextShotId++, x: soul.x, y: soul.y,
        dx: Math.cos(dir) * out.shot.speed, dy: Math.sin(dir) * out.shot.speed,
        life: out.shot.life, color: soul.color,
      });
      emit('soulAbility', { id: def.id, frame, x: soul.x, y: soul.y });
    }
  }

  /* ------------------------------------------------ 重力跳躍：地板、天花板、平台 */

  /** 站在平台上：平台上一幀移動多少，靈魂就跟著移動多少 */
  function carryOnPlatform() {
    const st = movementState;
    if (st.on === null || st.on === undefined) return;
    const b = bullets.find((x) => x.id === st.on && !x.dead && !x.faded);
    if (!b) { st.on = null; return; }
    const point = moveInArena(arena, box, soul, { x: soul.x + b.x - st.ox, y: soul.y + b.y - st.oy }, SOUL_RADIUS);
    soul.x = point.x;
    soul.y = point.y;
    st.ox = b.x; st.oy = b.y;
  }

  /**
   * 依實際位移結算：往重力方向被擋住＝落地；往反方向被擋＝撞頂。
   * 平台：只擋「從上方落下」——上一幀腳在平台上緣之上、這一幀穿過上緣，就站上去（彈簧床則彈起）。
   */
  function settleGravity(from, move, params) {
    const st = movementState;
    const [gx, gy] = GRAVITY_DIRS[Math.max(0, Math.min(3, Math.round(params.direction)))];
    const wanted = move.dx * gx + move.dy * gy;
    const got = (soul.x - from.x) * gx + (soul.y - from.y) * gy;
    st.on = null;
    if (wanted > 0 && got < wanted - 0.01) { st.v = 0; st.grounded = true; }
    else if (wanted < 0 && got > wanted + 0.01) st.v = 0;
    if (st.v < 0) return;
    const sG = soul.x * gx + soul.y * gy, fromG = from.x * gx + from.y * gy;
    const sL = gx === 0 ? soul.x : soul.y;
    let best = null, bestTop = Infinity;
    for (const b of bullets) {
      if (!b.platform || b.dead || b.faded || b.justSpawned || b.solid === false) continue;
      const hb = b.hitbox || { shape: 'circle', r: 6 };
      const halfW = hb.shape === 'rect' ? hb.w / 2 : Number(hb.r) || 0;
      const halfH = hb.shape === 'rect' ? hb.h / 2 : Number(hb.r) || 0;
      const halfG = gx === 0 ? halfH : halfW, halfL = gx === 0 ? halfW : halfH;
      const top = b.x * gx + b.y * gy - halfG;                 // 平台朝上的那一面（沿重力軸）
      const bL = gx === 0 ? b.x : b.y;
      if (Math.abs(sL - bL) > halfL + SOUL_RADIUS * 0.5) continue;
      if (fromG + SOUL_RADIUS > top + 1.5 || sG + SOUL_RADIUS < top) continue;
      if (top < bestTop) { best = b; bestTop = top; }
    }
    if (!best) return;
    const fix = bestTop - SOUL_RADIUS - sG;                    // 把腳放回平台上緣
    const point = moveInArena(arena, box, soul, { x: soul.x + gx * fix, y: soul.y + gy * fix }, SOUL_RADIUS);
    soul.x = point.x;
    soul.y = point.y;
    if (best.bounce > 0) {
      st.v = -params.jump * best.bounce;
      st.grounded = false;
      emit('soulBounce', { bulletId: best.id, frame });
      return;
    }
    st.v = 0;
    st.grounded = true;
    st.on = best.id; st.ox = best.x; st.oy = best.y;
  }

  /** soulDrift：每幀把靈魂推一點（例如站在旋轉的轉盤上），經過框／arena 碰撞 */
  function applyDrift() {
    if (!drift || ended) return;
    const ctx = makeContext({ t: (frame - drift.startFrame) / FPS, T: attack.settings.duration, box, soul });
    const val = (v, key) => {
      if (typeof v === 'number') return v;
      const r = evalNumber(v, ctx, helpers);
      if (r.error) {
        reportError(-1, 'soulDrift.' + key, r.error, 'soulDrift');
        return 0;
      }
      return Number.isFinite(r.value) ? r.value : 0;
    };
    const dx = val(drift.dx, 'dx'), dy = val(drift.dy, 'dy');
    if (!dx && !dy) return;
    const point = moveInArena(arena, box, soul, { x: soul.x + dx, y: soul.y + dy }, SOUL_RADIUS);
    soul.x = point.x;
    soul.y = point.y;
  }

  /** 靈魂圖的旋轉：appearance.rotation 固定角度；autoOrient＋重力移動時心尖指向重力方向，每幀最多轉 36° */
  function updateOrient() {
    let target = Number(look?.rotation) || 0;
    if (look?.autoOrient && activeProfile?.movement.def.id === 'gravity') {
      const dir = Math.max(0, Math.min(3, Math.round(Number(activeProfile.movement.params.direction) || 0)));
      const [gx, gy] = GRAVITY_DIRS[dir];
      target += Math.atan2(gy, gx) / DEG - 90;
    }
    let diff = ((target - orient) % 360 + 540) % 360 - 180;
    if (Math.abs(diff) <= 36) orient = target;
    else orient += Math.sign(diff) * 36;
  }

  function updateSoul(raw) {
    const input = movementInput(mode === 'play' ? raw : null);
    soulPath = null;
    applyDrift();
    updateOrient();
    if (activeProfile && !ended) stepSoulProfile(input);
    else if (input.dx || input.dy) {
      const intent = LEGACY_MOVEMENT.step(null, input, { params: attack.soul, heading });
      heading = intent.heading;
      const point = moveInArena(arena, box, soul, { x: soul.x + intent.dx, y: soul.y + intent.dy }, SOUL_RADIUS);
      soul.x = point.x;
      soul.y = point.y;
    } else placeSoul();

    if (soul.invFrames > 0) {
      soul.invFrames -= 1;
      soul.visible = Math.floor(soul.invFrames / 3) % 2 === 0;
    } else {
      soul.visible = true;
    }
  }

  /* ------------------------------------------------------------ 子彈 */

  /** 為子彈建立 path 表達式 context */
  function pathContext(b) {
    const time = frame / FPS;
    const bpm = Number(attack.settings.bpm);
    return makeContext({
      t: Math.max(0, time - (Number(b.eventAt) || 0)),
      T: attack.settings.duration,
      i: b.i,
      n: b.n,
      k: b.k,
      age: b.age,
      box,
      soul,
      // SPEC-EXPR-V2 §3：生成時固定下來的值，每幀可讀（唯讀）
      spawnX: b.spawnX,
      spawnY: b.spawnY,
      spawnT: b.spawnT,
      bpm: bpm > 0 ? bpm : 0,
      beat: bpm > 0 ? 60 / bpm : 0,
      mem: b.mem,
    });
  }

  /** pathX/pathY：以 age 每幀求值，位移相對於生成點 */
  function applyPath(b) {
    if (b.hasPathX) {
      const r = evalNumber(b.pathX, pathContext(b), helpers);
      if (r.error) {
        // path 每幀求值，錯誤只回報一次（key 依子彈類型固定）
        reportError(-1, 'pathX', r.error, b.type);
      } else {
        b.x = b.spawnX + r.value;
      }
    }
    if (b.hasPathY) {
      const r = evalNumber(b.pathY, pathContext(b), helpers);
      if (r.error) {
        reportError(-1, 'pathY', r.error, b.type);
      } else {
        b.y = b.spawnY + r.value;
      }
    }
    if (b.pathScale !== null || b.pathAlpha !== null || b.pathZ !== null || b.pathFrame !== null || b.solidWhen !== null) applyDepth(b);
  }

  /** pathRotation：每幀求值的朝向（度），在位移與 faceVelocity 之後套用 */
  function applyPathRotation(b) {
    if (typeof b.pathRotation === 'number') {
      if (Number.isFinite(b.pathRotation)) b.rotation = b.pathRotation;
      return;
    }
    const r = evalNumber(b.pathRotation, pathContext(b), helpers);
    if (r.error) reportError(-1, 'pathRotation', r.error, b.type);
    else b.rotation = r.value;
  }

  /** 偽 3D 欄位（pathScale / pathAlpha / pathZ / solidWhen），與 pathX/pathY 同一個求值脈絡 */
  function applyDepth(b) {
    const ctx = pathContext(b);
    const value = (expr, key) => {
      if (typeof expr === 'number') return Number.isFinite(expr) ? expr : null;
      const r = evalNumber(expr, ctx, helpers);
      if (r.error) {
        reportError(-1, key, r.error, b.type);
        return null;
      }
      return r.value;
    };
    if (b.pathScale !== null) {
      const k = value(b.pathScale, 'pathScale');
      if (k !== null) {
        const f = Math.max(0, k);
        b.scale = b.baseScale * f;
        const h0 = b.hitbox0 || { shape: 'circle', r: 6 };
        b.hitbox = h0.shape === 'rect'
          ? { shape: 'rect', w: h0.w * f, h: h0.h * f }
          : { shape: 'circle', r: (Number(h0.r) || 0) * f };
      }
    }
    if (b.pathAlpha !== null) {
      const a = value(b.pathAlpha, 'pathAlpha');
      if (a !== null) b.alpha = clamp(a, 0, 1);
    }
    if (b.pathZ !== null) {
      const z = value(b.pathZ, 'pathZ');
      if (z !== null) b.z = z;
    }
    if (b.pathFrame !== null) {
      const f = value(b.pathFrame, 'pathFrame');
      b.frameIdx = f === null ? null : Math.max(0, Math.floor(f));
    }
    if (b.solidWhen !== null) {
      const v = value(b.solidWhen, 'solidWhen');
      b.solid = v === null ? true : v !== 0;
    }
  }

  function updateBullets() {
    const dt = 1 / FPS;
    const fps = FPS;
    for (let idx = 0; idx < bullets.length; idx += 1) {
      const b = bullets[idx];
      if (b.dead) continue;
      if (soulPath || playerShots.length) b.previous = { x: b.x, y: b.y, rotation: b.rotation };

      if (b.faded) {
        b.fadeElapsed += dt;
        if (b.fadeDur <= 0 || b.fadeElapsed >= b.fadeDur) {
          b.dead = true;
          continue;
        }
        b.fadeAlpha = clamp(1 - b.fadeElapsed / b.fadeDur, 0, 1);
      }

      if (b.justSpawned) {
        // 生成當幀：不移動、不判定命中，但仍要先套用 path 位移，
        // 讓子彈第一幀就出現在 pathX/pathY(age=0) 的位置（避免1幀跳動）。
        b.justSpawned = false;
        applyPath(b);
        if (soulPath || playerShots.length) b.previous = { x: b.x, y: b.y, rotation: b.rotation };
        continue;
      }

      const previousX = b.x;
      const previousY = b.y;
      b.age += dt;

      // 速度運動（pathX/pathY 會覆蓋對應軸）
      const rad = b.angle * DEG;
      const dx = Math.cos(rad) * b.speed;
      const dy = Math.sin(rad) * b.speed;
      if (!b.hasPathX) b.x += dx;
      if (!b.hasPathY) b.y += dy;
      b.speed += b.accel;
      b.angle += b.angularVel;
      // pathX / pathY：以 age 每幀求值，位移相對於生成點
      applyPath(b);
      // 路徑會覆蓋速度分量；朝向必須使用覆蓋後的實際位移。
      if (b.faceVelocity && (b.hasPathX || b.hasPathY)) {
        const moveX = b.x - previousX;
        const moveY = b.y - previousY;
        if (moveX !== 0 || moveY !== 0) b.rotation = Math.atan2(moveY, moveX) / DEG + b.rotationOffset;
      } else if (b.faceVelocity) b.rotation = b.angle + b.rotationOffset;
      else b.rotation += b.angularVel;
      if (b.pathRotation !== null) applyPathRotation(b);
      // life（秒）
      if (b.life !== null && b.age >= b.life) {
        b.dead = true;
        continue;
      }

      // offscreen 回收
      if (b.offscreen === 'destroy') {
        const inside =
          b.x >= -OFFSCREEN_MARGIN &&
          b.x <= VIEW_W + OFFSCREEN_MARGIN &&
          b.y >= -OFFSCREEN_MARGIN &&
          b.y <= VIEW_H + OFFSCREEN_MARGIN;
        if (inside) {
          b.wasInside = true;
        } else if (b.wasInside || b.age > 2) {
          b.dead = true;
          continue;
        }
      }

      // 動畫幀索引（renderer 再依實際幀數取餘數）
      if (fps <= 0) b.frameRate = 0;
    }
  }

  /* ------------------------------------------------------------ 碰撞 */

  /**
   * 子彈 hitbox 與靈魂的距離是否在 pad 內（**只用於命中判定**，pad 一律 0）。
   *
   * 擦彈不走這裡：擦彈是「子彈 hitbox 與以靈魂為中心的心形遮罩」像素級重疊，
   * 見 grazeMaskTest() 與 engine/graze-mask.js。
   */
  function hitTest(b, pad) {
    const dx = soul.x - b.x;
    const dy = soul.y - b.y;
    const hb = b.hitbox || { shape: 'circle', r: 6 };
    if (hb.shape === 'rect') {
      const rot = (Number(b.rotation) || 0) * DEG;
      const cosR = Math.cos(rot);
      const sinR = Math.sin(rot);
      // 世界 → 子彈本地座標
      const lx = dx * cosR + dy * sinR;
      const ly = -dx * sinR + dy * cosR;
      const hw = hb.w / 2 + pad;
      const hh = hb.h / 2 + pad;
      const qx = clamp(lx, -hw, hw);
      const qy = clamp(ly, -hh, hh);
      const ddx = lx - qx;
      const ddy = ly - qy;
      return ddx * ddx + ddy * ddy <= SOUL_RADIUS * SOUL_RADIUS;
    }
    const r = Math.max(0, Number(hb.r) || 0) + pad + SOUL_RADIUS;
    return dx * dx + dy * dy <= r * r;
  }

  /**
   * 擦彈判定：子彈 hitbox 是否與「以靈魂為中心的心形遮罩」（官方 spr_grazemask，
   * 25×25、半尺寸）有任何像素重疊。hitbox 是幾何、遮罩是像素；只要遮罩的某個
   * 像素中心落在 hitbox 內就算擦到（像素級判定，不因靈魂微小移動而抖動）。
   *
   * 座標系：以靈魂為原點。子彈中心相對靈魂是 (b.x - soul.x, b.y - soul.y)，
   * 遮罩像素相對靈魂是整數格 (dx, dy)。效能靠 graze-mask.js 的外接框粗篩 +
   * 每列 span；一般子彈在遮罩外時只做一次框相交比較。
   */
  function grazeMaskTest(b) {
    const hb = b.hitbox || { shape: 'circle', r: 6 };
    const cx = b.x - soul.x;
    const cy = b.y - soul.y;
    if (hb.shape === 'rect') {
      const rot = (Number(b.rotation) || 0) * DEG;
      return maskOverlapRect(cx, cy, Math.max(0, hb.w / 2), Math.max(0, hb.h / 2), Math.cos(rot), Math.sin(rot));
    }
    return maskOverlapCircle(cx, cy, Math.max(0, Number(hb.r) || 0));
  }

  function admitInClip(clip) {
    if (!clip) return null;
    if (!contactClips.has(clip)) {
      const points = clipCorners(clip);
      const inside = (p) => pointInClip(p, clip);
      contactClips.set(clip, (p0, p1, b0, b1, range) => clipContact(p0, p1, b0, b1, range, points, inside));
    }
    return contactClips.get(clip);
  }

  function updatePlayerShots() {
    shotBursts = shotBursts.filter((burst) => frame - burst.frame < 8);
    if (!playerShots.length) return;
    const live = [];
    for (const shot of playerShots) {
      const end = { x: shot.x + shot.dx, y: shot.y + shot.dy };
      const path = [{ from: shot, to: end, start: 0, end: 1 }];
      let target = null, best = Infinity;
      for (const b of bullets) {
        if (!b.shootable || b.dead || b.decor || b.faded || b.solid === false) continue;
        const clip = clipShape(bulletClip(b), box, arena, clipRegion);
        const t = sweptHit(path, SHOT_RADIUS, b.previous, b, admitInClip(clip));
        if (Number.isFinite(t) && (t < best || t === best && b.id < target.id)) {
          best = t;
          target = b;
        }
      }
      if (target) {
        shotBursts.push({ x: shot.x + shot.dx * best, y: shot.y + shot.dy * best, frame, color: shot.color });
        if ((target.hp ?? 1) > 1) {
          target.hp -= 1;
          target.mem = memoryFromValues({ ...(memoryValues(target.mem) || {}), hp: target.hp });
          emit('bulletHit', { bulletId: target.id, type: target.type, shotId: shot.id, hp: target.hp, x: target.x, y: target.y, frame });
        } else {
          target.dead = true;
          emit('bulletBroken', { bulletId: target.id, type: target.type, shotId: shot.id, x: target.x, y: target.y, frame });
        }
      } else if (shot.life > 1 && end.x >= 0 && end.x <= VIEW_W && end.y >= 0 && end.y <= VIEW_H) {
        live.push({ ...shot, ...end, life: shot.life - 1 });
      }
    }
    playerShots = live;
  }

  function updateCollisions() {
    if (ended) return;
    if (soul.invFrames > 0) {
      // 無敵幀中仍可擦彈，但不吃傷害
    }
    let grazing = false;
    for (let idx = 0; idx < bullets.length; idx += 1) {
      const b = bullets[idx];
      if (b.decor || b.dead || b.justSpawned || b.faded || b.solid === false) continue;
      const clip = clipShape(bulletClip(b), box, arena, clipRegion);
      const atEnd = !clip || pointInClip(b, clip) && pointInClip(soul, clip);
      if (!soulPath && !atEnd) continue;

      const actual = soulPath
        ? Number.isFinite(sweptHit(soulPath, SOUL_RADIUS, b.previous, b, admitInClip(clip)))
        : hitTest(b, 0);
      if (actual && soul.invFrames <= 0) {
        applyHit(b);
        if (b.dead) continue;
      }
      if (!atEnd || !b.grazeable) continue;
      const graze = grazeMaskTest(b);
      if (graze && !actual) {
        grazing = true;
        if (!b.grazed) {
          b.grazed = true;
          grazeFlash = 1;
          // TP 只在「首次擦到這一發」時增加，避免同一發子彈每幀灌 TP
          tp = clamp(tp + attack.settings.grazeTP, 0, TP_MAX);
          sfxQueue.push(SFX_GRAZE);
          emit('graze', {
            bulletId: b.id,
            type: b.type,
            x: b.x,
            y: b.y,
            frame,
          });
        }
      }
    }
    soul.grazing = grazing;
  }

  /** 命中一發子彈 */
  function applyHit(b) {
    const damage = b.damage === null || b.damage === undefined ? attack.settings.damage : b.damage;
    // Phase 1：扣第一位活著的隊員
    let target = null;
    for (const p of party) {
      if (p.hp > 0) {
        target = p;
        break;
      }
    }
    if (target) target.hp = Math.max(0, target.hp - damage);
    soul.invFrames = Math.max(0, attack.settings.invincibleFrames);
    hurtFlash = 1;
    sfxQueue.push(SFX_HURT);
    emit('hit', {
      bulletId: b.id,
      type: b.type,
      damage,
      frame,
      soul: { x: soul.x, y: soul.y },
      party: party.map((p) => ({ name: p.name, hp: p.hp, maxHp: p.maxHp })),
    });
    if (b.destroyOnHit) b.dead = true;
  }

  /* ------------------------------------------------------------ 清場 */

  function clearBullets(fadeSeconds) {
    const fade = Math.max(0, Number(fadeSeconds) || 0);
    for (const b of bullets) {
      if (b.dead) continue;
      if (fade <= 0) {
        b.dead = true;
      } else {
        b.faded = true;
        b.fadeDur = fade;
        b.fadeElapsed = 0;
        b.fadeAlpha = 1;
      }
    }
  }

  /* ------------------------------------------------------------ 結束 */

  function endRound() {
    if (ended) return;
    ended = true;
    if (!endEmitted) {
      endEmitted = true;
      emit('end', { frame, time: frame / FPS });
    }
  }

  /* -------------------------------------------------------- 重置/載入 */

  function reset() {
    frame = 0;
    ended = false;
    endEmitted = false;
    // 回收所有子彈
    for (const b of bullets) releaseBullet(b);
    bullets = [];
    pool = pool.slice(0, MAX_BULLETS);
    nextBulletId = 1;
    playerShots = [];
    shotBursts = [];
    nextShotId = 1;
    activeProfile = null;
    profileId = null;
    movementState = {};
    abilityStates = {};
    look = null;
    heading = 0;
    soulSpeed = 0;
    teleportSerial = 0;
    soulPath = null;
    emitters = [];
    boxAnims = [];
    shakes = [];
    sfxQueue = [];
    grazeFlash = 0;
    hurtFlash = 0;
    shakeState = { x: 0, y: 0 };
    reportedErrors.clear();

    const seed = Number(attack.settings.seed);
    rng = createRng(Number.isFinite(seed) ? seed : 1);
    helpers = createHelpers(rng, () => ({ x: soul.x, y: soul.y }), trailAt);
    trailHead = 0;
    trailCount = 0;

    Object.assign(box, attack.box);
    box.appearance = attack.box.appearance ?? 'classic';
    box.w = Math.max(1, box.w);
    box.h = Math.max(1, box.h);

    soul.mode = attack.soul.mode;
    soul.color = attack.soul.color;
    soul.invFrames = 0;
    soul.grazing = false;
    soul.visible = true;
    soul.x = attack.soul.x === null || attack.soul.x === undefined ? box.x : Number(attack.soul.x);
    soul.y = attack.soul.y === null || attack.soul.y === undefined ? box.y : Number(attack.soul.y);
    placeSoul();
    if (soulConfig.profiles.has(attack.soul.profile)) selectSoulProfile(attack.soul.profile);

    party = attack.party.map((p) => ({ name: p.name, hp: p.hp, maxHp: p.maxHp, color: p.color, icon: p.icon }));
    tp = 0;

    buildSchedule();
    updateClipRegion();
    primeFrameZero();
  }

  /**
   * 處理落在第 0 幀（at = 0）的事件。
   * 這樣 seek(0) / 剛載入時就能看到 at=0 的彈幕，且 step 與 seek 的結果一致。
   */
  function primeFrameZero() {
    while (scheduleCursor < schedule.length && schedule[scheduleCursor].frame <= 0) {
      const entry = schedule[scheduleCursor];
      scheduleCursor += 1;
      fireEvent(entry);
      if (ended) break;
    }
    if (!ended) updateEmitters();
    // 第 0 幀不執行 updateBullets（畫面直接顯示生成位置），
    // 因此把「生成當幀不移動」的旗標清掉，讓第 1 幀起正常運動，
    // 否則第 0 幀生成的一批子彈會少動一幀。
    for (const b of bullets) b.justSpawned = false;
    // 第 0 幀不套用震動位移，避免殘留
    shakeState.x = 0;
    shakeState.y = 0;
  }

  function load(attackJson) {
    const config = compileSoulProfiles(attackJson ?? {});
    if (mode === 'play' && config.errors.length) {
      throw new SoulConfigurationError(config.errors[0]);
    }
    attack = normalizeAttack(attackJson);
    soulConfig = config;
    arena = compileArena(attack.arena);
    clipBase = compilePolygon(attack.clipRegion?.points);
    const motion = attack.clipRegion?.motion;
    clipMotion = clipBase && motion && typeof motion === 'object' && !Array.isArray(motion) ? motion : null;
    clipRegion = clipBase;
    reset();
  }

  /**
   * 動態裁剪區（「掃到才出現」）：clipRegion.motion 的 x / y / rotation 以「回合時間 t（秒）」每幀求值，
   * 多邊形先繞 pivot（預設＝多邊形外框中心）旋轉 rotation 度、再平移 (x, y)。
   * 碰撞判定與畫面裁剪共用這個結果，所以 clipTo: "custom" 的子彈只有被這個區域掃到時才看得見、才會傷人。
   */
  function updateClipRegion() {
    if (!clipBase || !clipMotion) {
      clipRegion = clipBase;
      return;
    }
    const bpm = Number(attack.settings.bpm);
    const ctx = makeContext({
      t: frame / FPS,
      T: attack.settings.duration,
      box,
      soul,
      bpm: bpm > 0 ? bpm : 0,
      beat: bpm > 0 ? 60 / bpm : 0,
    });
    const value = (key) => {
      const raw = clipMotion[key];
      if (raw === undefined || raw === null || raw === '') return 0;
      if (typeof raw === 'number') return Number.isFinite(raw) ? raw : 0;
      const r = evalNumber(raw, ctx, helpers);
      if (r.error) {
        reportError(-1, `clipRegion.motion.${key}`, r.error, 'clipRegion');
        return 0;
      }
      return r.value;
    };
    const dx = value('x');
    const dy = value('y');
    const rot = value('rotation') * DEG;
    const pivot = clipMotion.pivot && Number.isFinite(clipMotion.pivot.x) && Number.isFinite(clipMotion.pivot.y)
      ? clipMotion.pivot : { x: clipBase.bounds.x, y: clipBase.bounds.y };
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    const points = clipBase.points.map((p) => {
      const x = p.x - pivot.x;
      const y = p.y - pivot.y;
      return { x: pivot.x + x * c - y * sn + dx, y: pivot.y + x * sn + y * c + dy };
    });
    const xs = points.map((p) => p.x);
    const ys = points.map((p) => p.y);
    const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
    clipRegion = {
      points,
      bounds: { x: (left + right) / 2, y: (top + bottom) / 2, w: right - left, h: bottom - top, rotation: 0 },
      anchor: null,
      moving: true,
    };
  }

  /* ------------------------------------------------------------ 步進 */

  /**
   * 前進一幀。
   * @param {{dx:number,dy:number,slow:boolean}|null} input
   * @returns {boolean} 是否實際推進了
   */
  function stepFrame(input) {
    if (ended) return false;
    frame += 1;
    const time = frame / FPS;

    // 1) 時間軸事件（一次性事件）
    while (scheduleCursor < schedule.length && schedule[scheduleCursor].frame <= frame) {
      const entry = schedule[scheduleCursor];
      scheduleCursor += 1;
      fireEvent(entry);
      if (ended) break;
    }

    // 1b) 動態裁剪區跟著時間移動（之後的生成、命中、擦彈都用這一幀的位置）
    updateClipRegion();

    // 2) emitter 觸發
    if (!ended) updateEmitters();

    // 3) 戰鬥框補間 → 靈魂夾框
    updateBoxAnims();

    // 4) 靈魂移動
    updateSoul(input);
    trailPush();

    // 5) 子彈運動
    updateBullets();
    contactClips.clear();
    if (!ended) updatePlayerShots();

    // 6) 碰撞 / 擦彈
    updateCollisions();

    // 7) 震動、衰減
    updateShake();
    if (grazeFlash > 0) grazeFlash = Math.max(0, grazeFlash - 1 / 8);
    if (hurtFlash > 0) hurtFlash = Math.max(0, hurtFlash - 1 / 12);

    // 8) 清除已死亡子彈（回收進池）
    compactBullets();

    // 9) 回合時間到
    if (!ended && time >= attack.settings.duration - 1e-9) {
      endRound();
    }

    return true;
  }

  function compactBullets() {
    let write = 0;
    for (let read = 0; read < bullets.length; read += 1) {
      const b = bullets[read];
      if (b.dead) {
        releaseBullet(b);
      } else {
        bullets[write] = b;
        write += 1;
      }
    }
    bullets.length = write;
  }

  /**
   * 前進 n 幀。
   * @param {number} n
   * @param {{dx:number,dy:number,slow:boolean}|null} input 每幀相同的輸入
   * @param {()=>{dx:number,dy:number,slow:boolean}|null} [inputFn] 每幀取輸入（優先）
   */
  function advance(n, input, inputFn) {
    const count = Math.max(0, Math.round(Number(n) || 0));
    for (let i = 0; i < count; i += 1) {
      const frameInput = typeof inputFn === 'function' ? inputFn() : input;
      const moved = stepFrame(frameInput);
      if (!moved) break;
    }
  }

  /**
   * 從 0 重新模擬到指定幀（決定性；preview 模式用）。
   *
   * 語意與 `step(n)` 完全一致：若回合在抵達目標前就結束（`end` 事件，
   * 或時間到達 duration），會停在結束的那一幀。因此
   * `seek(n).frame === step(n).frame`（n 不超過回合長度時兩者狀態必定相同）。
   */
  function seekTo(targetFrame, inputFn) {
    const target = Math.max(0, Math.round(Number(targetFrame) || 0));
    reset();
    advance(target, null, inputFn);
  }

  /** 回合最後一幀的編號（供編輯器把游標夾在有效範圍） */
  function lastFrame() {
    return Math.max(0, Math.min(durationFrames(), frame));
  }

  /* ------------------------------------------------------------ 輸出 */

  /** 有 z 的子彈由遠到近排序（z 大＝遠，先畫）；沒有 z 時保持原順序 */
  function depthSorted(list) {
    if (!list.some((b) => b.z)) return list;
    return list.map((b, i) => [b, i]).sort((a, c) => (c[0].z || 0) - (a[0].z || 0) || a[1] - c[1]).map(([b]) => b);
  }

  /** 子彈動畫幀索引（renderer 會再對幀數取餘數） */
  function bulletAnimFrame(b) {
    if (b.frameIdx !== null && b.frameIdx !== undefined) return b.frameIdx;
    if (!(b.frameRate > 0)) return 0;
    const f = Math.floor(b.age * b.frameRate);
    return f < 0 ? 0 : f;
  }

  function bulletState(b) {
    return {
      id: b.id,
      type: b.type,
      sprite: b.sprite,
      frame: bulletAnimFrame(b),
      x: b.x,
      y: b.y,
      rotation: b.rotation,
      scale: b.scale,
      ...(b.z ? { z: b.z } : {}),
      ...(b.solid === false ? { solid: false } : {}),
      alpha: clamp(b.alpha * b.fadeAlpha, 0, 1),
      color: b.color,
      maskToBox: b.maskToBox,
      ...(b.clipTo === undefined ? {} : { clipTo: b.clipTo }),
      ...(b.shootable ? { shootable: true } : {}),
      ...(b.platform ? { platform: true } : {}),
      decor: b.decor,
      hitbox: b.hitbox,
      age: b.age,
      life: b.life,
      speed: b.speed,
      angle: b.angle,
      spawnX: b.spawnX,
      spawnY: b.spawnY,
    };
  }

  function getState() {
    const time = frame / FPS;
    const enemies = attack.enemies.map((e, i) => {
      const floatY = Math.sin(time * 2 + i * 1.3) * 3;
      const anim = e.frameRate > 0 ? Math.floor(time * e.frameRate) : 0;
      return { sprite: e.sprite, x: e.x, y: e.y + floatY, scale: e.scale, frame: anim };
    });

    const state = {
      frame,
      time,
      running: false, // index.js 會覆寫成實際播放狀態
      ended,
      attack,
      shake: { x: shakeState.x, y: shakeState.y },
      box: boxSnapshot(),
      ...(arena.kind === 'box' && !arena.outline && !arena.fill ? {} : { arena }),
      ...(clipRegion ? { clipRegion } : {}),
      soul: {
        x: soul.x,
        y: soul.y,
        mode: soul.mode,
        color: soul.color,
        invFrames: soul.invFrames,
        grazing: soul.grazing,
        visible: soul.visible,
        ...(look ? { appearance: { ...look }, heading } : {}),
        ...(orient ? { orient } : {}),
        ...(profileId !== null ? {
          profile: profileId, speed: soulSpeed,
          movement: activeProfile.movement.def.id,
          abilities: activeProfile.abilities.map(({ def }) => ({
            id: def.id, actions: def.actions ?? [], cooldown: abilityStates[mechanismKey(def)].cooldown ?? 0,
            active: Boolean(abilityStates[mechanismKey(def)].remaining),
          })),
        } : {}),
        ...(teleportSerial ? { teleportSerial } : {}),
      },
      ...(playerShots.length ? { playerShots: playerShots.map(({ id, x, y, dx, dy, color }) => ({ id, x, y, dx, dy, color })) } : {}),
      ...(shotBursts.length ? { shotBursts: shotBursts.map((burst) => ({ ...burst })) } : {}),
      bullets: depthSorted(bullets.map(bulletState)),
      party: party.map((p) => ({
        name: p.name,
        hp: p.hp,
        maxHp: p.maxHp,
        color: p.color,
        icon: p.icon,
      })),
      tp,
      enemies,
      sfxQueue: sfxQueue.slice(),
      grazeFlash,
      hurtFlash,
      mode,
    };
    return state;
  }

  /* ------------------------------------------------------------ 快照 */

  /**
   * 快照格式版本（V2-08）。restore() 只接受這個版本。
   * @type {number}
   */
  const SNAPSHOT_VERSION = 1;

  /**
   * 子彈的完整執行期欄位（V2-08 snapshot 用）。
   *
   * 刻意不含 pool / 共用物件參照：全部是 primitive 或純物件，可直接
   * structuredClone / JSON 序列化（`mem` 另外攤平成純物件，見 memoryValues）。
   */
  const BULLET_SNAP_FIELDS = [
    'id', 'type', 'sprite', 'color', 'damage', 'grazeable', 'decor', 'destroyOnHit',
    'faceVelocity', 'offscreen', 'maskToBox', 'clipTo', 'frameRate',
    'x', 'y', 'spawnX', 'spawnY', 'spawnT',
    'speed', 'angle', 'accel', 'angularVel', 'scale', 'rotation', 'rotationOffset',
    'alpha', 'fadeAlpha', 'life', 'age', 'i', 'n', 'k', 'eventAt',
    'pathX', 'pathY', 'hasPathX', 'hasPathY',
    'pathScale', 'pathAlpha', 'pathZ', 'pathFrame', 'frameIdx', 'pathRotation', 'solidWhen', 'baseScale', 'z', 'solid', 'hp',
    'faded', 'fadeDur', 'fadeElapsed', 'wasInside', 'justSpawned', 'grazed', 'dead',
  ];

  /**
   * 深拷貝成「純資料」（保留 undefined 欄位語意；循環參照不存在）。
   * @param {any} value
   */
  function plainClone(value) {
    if (Array.isArray(value)) return value.map(plainClone);
    if (value && typeof value === 'object') {
      const out = {};
      for (const key of Object.keys(value)) out[key] = plainClone(value[key]);
      return out;
    }
    return value;
  }

  /** hitbox 複本（不與子彈型別共用同一個物件） */
  function hitboxCopy(hb) {
    const src = hb && typeof hb === 'object' ? hb : { shape: 'circle', r: 6 };
    if (src.shape === 'rect') {
      const w = Number(src.w);
      const h = Number(src.h);
      return { shape: 'rect', w: Number.isFinite(w) ? w : 6, h: Number.isFinite(h) ? h : 6 };
    }
    const r = Number(src.r);
    return { shape: 'circle', r: Number.isFinite(r) ? r : 6 };
  }

  /**
   * 子彈 memory 是 expr.js 的 Proxy 查表（lookupFrom）——不能直接序列化。
   * 這裡攤平成「名字 → 數值」的純物件；沒有 memory 的子彈回 null。
   * @param {object|null} mem
   */
  function memoryValues(mem) {
    if (!mem || mem === EMPTY_MEM) return null;
    const values = memoryStore.get(mem);
    if (!values) return null;
    const out = {};
    for (const name of Object.keys(values)) out[name] = values[name];
    return out;
  }

  /** 純物件 → 唯讀查表（沒名字時共用 EMPTY_MEM） */
  function memoryFromValues(values) {
    if (!values || typeof values !== 'object') return EMPTY_MEM;
    const names = Object.keys(values);
    if (names.length === 0) return EMPTY_MEM;
    const store = Object.create(null);
    for (const name of names) store[name] = values[name];
    const mem = lookupFrom(store);
    memoryStore.set(mem, store);
    return mem;
  }

  /**
   * 一發子彈的完整快照（含 mem 數值、grazed、faded / fadeElapsed、wasInside…）。
   * @param {object} b
   */
  function bulletSnapshot(b) {
    const out = {};
    for (const key of BULLET_SNAP_FIELDS) out[key] = b[key];
    if (b.shootable) out.shootable = true;
    if (b.platform) { out.platform = true; out.bounce = b.bounce; }
    out.hitbox = hitboxCopy(b.hitbox);
    if (b.hitbox0) out.hitbox0 = hitboxCopy(b.hitbox0);
    out.mem = memoryValues(b.mem);
    return out;
  }

  /** 從快照重建一發子彈（新物件，不進 pool） */
  function bulletFromSnapshot(src) {
    const b = makeBullet();
    for (const key of BULLET_SNAP_FIELDS) {
      if (src[key] !== undefined) b[key] = src[key];
    }
    b.shootable = src.shootable === true;
    b.platform = src.platform === true;
    b.bounce = Number(src.bounce) || 0;
    b.hitbox = hitboxCopy(src.hitbox);
    b.hitbox0 = src.hitbox0 ? hitboxCopy(src.hitbox0) : null;
    b.mem = memoryFromValues(src.mem);
    return b;
  }

  /**
   * 完整狀態快照（V2-08）：足以讓另一個 createSimulation 實例「接著跑」，
   * 逐幀結果與原本的實例完全相同（見 tests/snapshot/）。
   *
   * 內容：幀號 / 結束旗標 / RNG 狀態 / 戰鬥框 / 靈魂 / 隊伍 / TP /
   * 子彈（全部執行期欄位 + memory 數值 + 已擦過旗標）/ 事件游標 /
   * emitter 游標與觸發表 / 框補間 / 震動 / 音效佇列 / 擦彈與受傷閃光 /
   * 震動位移 / 已回報錯誤（避免還原後重複洗版）。
   *
   * 不回傳 pool（回收快取只影響效能，不影響任何可觀察狀態）。
   * @returns {object} 可直接 structuredClone / JSON 序列化的純資料
   */
  function snapshot() {
    return {
      kind: 'sim',
      version: SNAPSHOT_VERSION,
      mode,
      attackSeed: Number(attack.settings.seed),
      frame,
      trail: Array.from({ length: trailCount }, (_, k) => {
        const p = trailAt((trailCount - 1 - k) / FPS);
        return [p.x, p.y];
      }),
      ended,
      endEmitted,
      rng: typeof rng.getState === 'function' ? rng.getState() : null,
      box: { ...box },
      soul: { ...soul },
      soulRuntime: { profileId, look, heading, soulSpeed, teleportSerial, drift: drift && { ...drift }, orient,
        movementState: plainClone(movementState),
        abilityStates: plainClone(abilityStates), playerShots: plainClone(playerShots), shotBursts: plainClone(shotBursts), nextShotId },
      party: party.map((p) => ({ ...p })),
      tp,
      scheduleCursor,
      nextBulletId,
      bullets: bullets.map(bulletSnapshot),
      emitters: emitters.map((em) => ({
        index: em.index,
        t0: em.t0,
        T: em.T,
        triggers: em.triggers.slice(),
        next: em.next,
        spawn: plainClone(em.spawn),
        count: em.count,
      })),
      boxAnims: boxAnims.map((anim) => ({
        keys: anim.keys.slice(),
        from: { ...anim.from },
        to: { ...anim.to },
        ease: anim.ease,
        startFrame: anim.startFrame,
        durationFrames: anim.durationFrames,
      })),
      shakes: shakes.map((s) => ({ ...s })),
      sfxQueue: sfxQueue.slice(),
      grazeFlash,
      hurtFlash,
      shakeState: { ...shakeState },
      reportedErrors: Array.from(reportedErrors),
    };
  }

  /**
   * 還原快照（V2-08）。必須先 load() 同一個攻擊檔（子彈的型別 / path / 事件
   * 參照都靠攻擊檔解析；事件游標只還原索引）。
   *
   * @param {object} snap snapshot() 的結果（或 JSON.parse 後的值）
   * @returns {boolean} 是否還原成功
   */
  function restore(snap) {
    const s = snap && typeof snap === 'object' ? snap : null;
    if (!s || !Array.isArray(s.bullets) || !Number.isFinite(Number(s.frame))) return false;
    if (s.version !== undefined && s.version !== SNAPSHOT_VERSION) return false;

    frame = Math.max(0, Math.round(Number(s.frame)));
    ended = s.ended === true;
    endEmitted = s.endEmitted === true;

    // RNG：helpers 綁在同一個 rng 物件上（只有 reset() 會換掉），所以只還原內部狀態
    if (s.rng && typeof rng.setState === 'function') rng.setState(s.rng);

    if (s.box && typeof s.box === 'object') Object.assign(box, s.box);
    if (s.soul && typeof s.soul === 'object') Object.assign(soul, s.soul);
    trail = new Float64Array(TRAIL_FRAMES * 2);
    trailHead = 0;
    trailCount = 0;
    for (const p of Array.isArray(s.trail) ? s.trail.slice(-TRAIL_FRAMES) : []) {
      trail[trailHead * 2] = Number(p[0]) || 0;
      trail[trailHead * 2 + 1] = Number(p[1]) || 0;
      trailHead = (trailHead + 1) % TRAIL_FRAMES;
      trailCount += 1;
    }
    const runtime = s.soulRuntime;
    profileId = runtime?.profileId ?? null;
    activeProfile = soulConfig.profiles.get(profileId) ?? null;
    look = runtime?.look ?? null;
    heading = runtime?.heading ?? 0;
    drift = runtime?.drift ? { ...runtime.drift } : null;
    orient = runtime?.orient ?? 0;
    soulSpeed = runtime?.soulSpeed ?? 0;
    teleportSerial = runtime?.teleportSerial ?? 0;
    movementState = plainClone(runtime?.movementState ?? {});
    abilityStates = plainClone(runtime?.abilityStates ?? {});
    playerShots = (runtime?.playerShots ?? []).map((shot) => ({ ...shot }));
    nextShotId = runtime?.nextShotId ?? 1;
    shotBursts = plainClone(runtime?.shotBursts ?? []);
    soulPath = null;
    party = Array.isArray(s.party) ? s.party.map((p) => ({ ...p })) : [];
    tp = Math.max(0, Math.min(TP_MAX, Number(s.tp) || 0));

    // 時間軸：schedule 由攻擊檔決定 → 重建後只還原游標
    buildSchedule();
    scheduleCursor = Math.max(0, Math.min(schedule.length, Math.round(Number(s.scheduleCursor) || 0)));

    nextBulletId = Math.max(1, Math.round(Number(s.nextBulletId) || 1));
    bullets = (Array.isArray(s.bullets) ? s.bullets : []).map(bulletFromSnapshot);

    const timeline = Array.isArray(attack.timeline) ? attack.timeline : [];
    emitters = [];
    for (const src of Array.isArray(s.emitters) ? s.emitters : []) {
      const index = Math.round(Number(src.index));
      const ev = timeline[index];
      if (!ev) continue; // 攻擊檔換過 → 這個 emitter 不可能存在，略過
      emitters.push({
        ev,
        index,
        t0: Number(src.t0) || 0,
        T: Number(src.T) || 0,
        triggers: Array.isArray(src.triggers) ? src.triggers.slice() : [],
        next: Math.max(0, Math.round(Number(src.next) || 0)),
        spawn: src.spawn && typeof src.spawn === 'object' ? plainClone(src.spawn) : { bullet: '' },
        count: Math.max(1, Math.round(Number(src.count) || 1)),
      });
    }

    boxAnims = (Array.isArray(s.boxAnims) ? s.boxAnims : []).map((anim) => ({
      keys: Array.isArray(anim.keys) ? anim.keys.slice() : [],
      from: { ...(anim.from || {}) },
      to: { ...(anim.to || {}) },
      ease: anim.ease,
      startFrame: Number(anim.startFrame) || 0,
      durationFrames: Math.max(1, Math.round(Number(anim.durationFrames) || 1)),
    }));

    shakes = (Array.isArray(s.shakes) ? s.shakes : []).map((sh) => ({
      startFrame: Number(sh.startFrame) || 0,
      durationFrames: Math.max(0, Math.round(Number(sh.durationFrames) || 0)),
      amount: Number(sh.amount) || 0,
    }));

    sfxQueue = Array.isArray(s.sfxQueue) ? s.sfxQueue.slice() : [];
    grazeFlash = Math.max(0, Number(s.grazeFlash) || 0);
    hurtFlash = Math.max(0, Number(s.hurtFlash) || 0);
    shakeState = {
      x: Number(s.shakeState && s.shakeState.x) || 0,
      y: Number(s.shakeState && s.shakeState.y) || 0,
    };
    reportedErrors.clear();
    for (const key of Array.isArray(s.reportedErrors) ? s.reportedErrors : []) {
      reportedErrors.add(String(key));
    }
    updateClipRegion();
    return true;
  }

  function drainSfx() {
    if (sfxQueue.length === 0) return [];
    const out = sfxQueue;
    sfxQueue = [];
    return out;
  }

  /* ------------------------------------------------------------ 啟動 */

  reset();

  return {
    // 狀態查詢
    get frame() {
      return frame;
    },
    get time() {
      return frame / FPS;
    },
    get ended() {
      return ended;
    },
    get mode() {
      return mode;
    },
    get attack() {
      return attack;
    },
    get tp() {
      return tp;
    },
    get soul() {
      return soul;
    },
    get box() {
      return box;
    },
    get arena() {
      return arena.kind === 'box' && !arena.outline && !arena.fill ? undefined : arena;
    },
    get clipRegion() {
      return clipRegion;
    },
    get bulletCount() {
      return bullets.length;
    },
    get poolSize() {
      return pool.length;
    },
    durationFrames() {
      return Math.max(1, Math.round(attack.settings.duration * FPS));
    },
    // 操作
    load,
    reset,
    stepFrame,
    advance,
    seekTo,
    getState,
    drainSfx,
    // V2-08：完整狀態快照 / 還原（決定性測試與重跑加速用）
    snapshot,
    restore,
    // 給測試 / 除錯
    _state: () => ({ bullets, pool, emitters, boxAnims, shakes, reportedErrors }),
  };
}

export default createSimulation;
