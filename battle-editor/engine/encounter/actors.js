/**
 * engine/encounter/actors.js — 演員（位置 / 補間 / 動畫狀態）
 *
 * SPEC-P2 §1 `actors`、§3 演員動畫狀態、§5 state.actors。
 *
 * 演員 = 「位置 + 動畫狀態表」。每個演員的動畫狀態（anims）會由流程切換：
 *   隊員內建 idle attack act magic item spare defend hurt down victory
 *   敵人內建 idle hurt spared defeat（+ 自訂）
 * 未定義的狀態一律退回 idle（SPEC-P2 §3）。
 *
 * 這裡只維護資料，不畫任何東西；不碰 DOM。
 */

import { animDuration, animTotalFrames, isPlainObject, num, bool } from './schema.js';

/** 內建狀態名（渲染器 / 流程可參考；未定義時退回 idle） */
export const FALLBACK_ANIM = 'idle';

/** 受傷抖動的總幀數（hurtShake 從 1 衰減到 0） */
const HURT_SHAKE_FRAMES = 10;

/**
 * 形態動畫表 = 基礎 anims 疊上形態 anims（形態優先）。
 * 形態內沒有定義的動畫一律退回 actor.anims（SPEC-P2 §1 forms）。
 *
 * @param {object} baseAnims actor.anims（正規化後）
 * @param {object|null} formDef actor.forms[name]
 * @returns {object}
 */
export function mergeFormAnims(baseAnims, formDef) {
  const base = isPlainObject(baseAnims) ? baseAnims : {};
  const formAnims = formDef && isPlainObject(formDef.anims) ? formDef.anims : {};
  return { ...base, ...formAnims };
}

/** 形態的顯示縮放（>0；省略 = 1） */
function formScaleOf(formDef) {
  const v = formDef ? num(formDef.scale, 1) : 1;
  return Number.isFinite(v) && v > 0 ? v : 1;
}

/** 形態的顯示位移（只影響顯示與泡泡對齊，不改邏輯座標） */
function formOffsetOf(formDef) {
  const off = formDef && isPlainObject(formDef.offset) ? formDef.offset : null;
  return { x: num(off && off.x, 0), y: num(off && off.y, 0) };
}

/**
 * 建立演員系統。
 *
 * @param {object} actorDefs normalizeEncounter() 產生的 actors 物件（id → 定義）
 * @param {object} [opts]
 * @param {(name:string)=>number} [opts.spriteFrames] 素材幀數查詢（sprite 名 → 實際幀數）；
 *   非循環動畫省略 frames 時用它算長度與最後一幀；查不到回 0 → 沿用退回規則
 */
export function createActorSystem(actorDefs, opts = {}) {
  /** 素材幀數查詢（可能為 null） */
  const spriteFramesOf =
    opts && typeof opts.spriteFrames === 'function' ? opts.spriteFrames : null;

  /** 動畫總幀數：anim.frames 優先，否則查素材實際幀數；0 = 未知 */
  function totalFramesOf(anim) {
    if (!anim) return 0;
    let fromSprite = 0;
    if (spriteFramesOf) {
      try {
        fromSprite = num(spriteFramesOf(anim.sprite), 0);
      } catch (_err) {
        fromSprite = 0;
      }
    }
    return animTotalFrames(anim, fromSprite);
  }
  /** @type {Map<string, object>} id → 執行期演員 */
  const actors = new Map();

  for (const id of Object.keys(actorDefs || {})) {
    const def = actorDefs[id];
    const baseAnims = isPlainObject(def.anims) ? def.anims : {};
    // 形態（SPEC-P2 §1 forms）：actor.form 指定初始形態；省略 = 不用 forms
    const forms = isPlainObject(def.forms) ? def.forms : {};
    const formInitial = typeof def.form === 'string' && forms[def.form] ? def.form : null;
    const formDef = formInitial ? forms[formInitial] : null;
    const anims = formInitial ? mergeFormAnims(baseAnims, formDef) : baseAnims;
    const initial = typeof def.initialAnim === 'string' ? def.initialAnim : FALLBACK_ANIM;
    const animName = resolveAnimName(anims, initial);
    const act = {
      id,
      kind: def.kind === 'party' ? 'party' : 'enemy',
      def,
      // 形態：baseAnims 永遠保留，anims 是「目前形態」的有效動畫表
      baseAnims,
      forms,
      formInitial,
      form: formInitial,
      formScale: formScaleOf(formDef),
      formOffset: formOffsetOf(formDef),
      anims,
      // 位置
      x: num(def.x, 120),
      y: num(def.y, 200),
      move: null, // { fx, fy, tx, ty, elapsed, dur, ease }
      // 動畫
      animName,
      anim: anims[animName] || null,
      animElapsed: 0,
      animFinished: false,
      // 顯示
      flip: bool(def.flip, false),
      alpha: Math.max(0, Math.min(1, num(def.alpha, 1))),
      alphaTween: null, // { from, to, elapsed, dur }
      scale: num(def.scale, 1),
      layer: num(def.layer, 0),
      visible: def.visible !== false,
      hurtShake: 0,
    };
    actors.set(id, act);
  }

  /** 取動畫狀態；找不到就退回 idle，再找不到就 null */
  function resolveAnimName(anims, name) {
    if (name && anims[name]) return name;
    if (anims[FALLBACK_ANIM]) return FALLBACK_ANIM;
    const first = Object.keys(anims)[0];
    return first || FALLBACK_ANIM;
  }

  function get(id) {
    return actors.get(id) || null;
  }

  /** 依 id 排序後的演員清單（決定性；輸出 §5 state.actors） */
  function list() {
    return Array.from(actors.values()).sort((a, b) => {
      if (a.layer !== b.layer) return a.layer - b.layer;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
  }

  /**
   * 切換動畫狀態。未定義的狀態退回 idle（SPEC-P2 §3）。
   *
   * opts.keepIfMissing = true 時改成「狀態未定義就沿用目前動畫」，
   * 供受擊用：敵人沒做 hurt 動畫時維持現在的形態（例如變形中），不要閃回 idle；
   * 有定義 hurt 動畫時行為不變。
   *
   * @param {string} id
   * @param {string} name
   * @param {{keepIfMissing?: boolean, loop?:boolean, fps?:number}} [opts]
   * @returns {boolean} 是否真的切換
   */
  function setAnim(id, name, opts = {}) {
    const act = actors.get(id);
    if (!act) return false;
    if (opts && opts.keepIfMissing === true && !(name && act.anims[name])) return false;
    const resolved = resolveAnimName(act.anims, name);
    const base = act.anims[resolved] || null;
    let anim = base;
    if (base && resolved === name) {
      const loop = bool(opts?.loop, base.loop);
      const fps = Math.max(0, num(opts?.fps, base.fps));
      if (loop !== base.loop || fps !== base.fps) anim = { ...base, loop, fps };
    }
    if (act.animName === resolved && anim && act.anim?.loop === anim.loop &&
      act.anim?.fps === anim.fps && !act.animFinished) return true;
    act.animName = resolved;
    act.anim = anim;
    act.animElapsed = 0;
    act.animFinished = false;
    return true;
  }

  /** 套用形態（只改資料表 / 縮放 / 顯示位移；不動動畫進度） */
  function applyFormState(act, name) {
    const wants = typeof name === 'string' && name && act.forms[name] ? name : null;
    const formDef = wants ? act.forms[wants] : null;
    act.form = wants;
    act.anims = wants ? mergeFormAnims(act.baseAnims, formDef) : act.baseAnims;
    act.formScale = formScaleOf(formDef);
    act.formOffset = formOffsetOf(formDef);
    return wants;
  }

  /**
   * 切換形態（cue: form；SPEC-P2 §1 forms）。
   *
   * 切換後沿用目前動畫名：新形態（含基礎退回）有同名動畫就用它，
   * 沒有就退回 idle；opts.anim 可指定新形態中的動畫名。
   * name 給 null / 空字串 = 回到基礎形態。
   *
   * @param {string} id
   * @param {string|null} name
   * @param {{anim?:string}} [opts]
   * @returns {boolean} 形態是否存在並切換
   */
  function setForm(id, name, opts = {}) {
    const act = actors.get(id);
    if (!act) return false;
    const wants = name === undefined || name === null || name === '' ? null : String(name);
    if (wants !== null && !(act.forms && act.forms[wants])) return false;
    const explicit = opts && typeof opts.anim === 'string' && opts.anim ? opts.anim : null;
    if (act.form === wants && !explicit) return true;
    const target = explicit || act.animName || FALLBACK_ANIM;
    applyFormState(act, wants);
    const resolved = resolveAnimName(act.anims, target);
    act.animName = resolved;
    act.anim = act.anims[resolved] || null;
    act.animElapsed = 0;
    act.animFinished = false;
    return true;
  }

  /** 目前形態名（null = 基礎） */
  function getForm(id) {
    const act = actors.get(id);
    return act ? act.form : null;
  }

  /** 演員的形態名清單（宣告順序，決定性） */
  function formNames(id) {
    const act = actors.get(id);
    return act ? Object.keys(act.forms || {}) : [];
  }

  /** 顯示位置 / 高度 / 縮放（含形態 offset / scale；泡泡對齊用） */
  function displayPos(id) {
    const act = actors.get(id);
    if (!act) return null;
    return {
      x: act.x + act.formOffset.x,
      y: act.y + act.formOffset.y,
      h: num(act.def && act.def.spriteH, 32),
      scale: act.scale * act.formScale,
    };
  }

  /** 直接指定 sprite（不經 anims 表；給 anim 指令的 sprite 參數用） */
  function setSprite(id, sprite, opts = {}) {
    const act = actors.get(id);
    if (!act) return false;
    act.animName = null;
    act.anim = {
      sprite: typeof sprite === 'string' ? sprite : '',
      fps: Math.max(0, num(opts.fps, 10)),
      loop: opts.loop === undefined ? true : bool(opts.loop, true),
      then: null,
    };
    act.animElapsed = 0;
    act.animFinished = false;
    return true;
  }

  /** 目前動畫是否已播完（非循環動畫；循環動畫永遠 false） */
  function animDone(id) {
    const act = actors.get(id);
    if (!act) return true;
    return Boolean(act.animFinished);
  }

  /**
   * 移動到目標位置（補間）。
   * @param {string} id
   * @param {{x?:number, y?:number, relative?:boolean, duration?:number, ease?:string}} opts
   */
  function moveTo(id, opts = {}) {
    const act = actors.get(id);
    if (!act) return;
    const rel = bool(opts.relative, false);
    const dur = Math.max(0, num(opts.duration, 0.5)) * 30;
    // relative 時 x/y 是位移量；否則是絕對座標；沒給的軸不動
    const hasX = opts.x !== undefined && opts.x !== null;
    const hasY = opts.y !== undefined && opts.y !== null;
    const toX = !hasX ? act.x : rel ? act.x + num(opts.x, 0) : num(opts.x, act.x);
    const toY = !hasY ? act.y : rel ? act.y + num(opts.y, 0) : num(opts.y, act.y);
    const to = {
      fromX: act.x,
      fromY: act.y,
      toX,
      toY,
      elapsed: 0,
      dur,
      ease: typeof opts.ease === 'string' ? opts.ease : 'quadOut',
    };
    act.move = to;
    if (dur <= 0) {
      act.x = to.toX;
      act.y = to.toY;
      act.move = null;
    }
  }

  /** 是否正在補間移動 */
  function isMoving(id) {
    const act = actors.get(id);
    return Boolean(act && act.move);
  }

  /** 是否正在補間透明度（fade 指令用） */
  function isTweening(id) {
    const act = actors.get(id);
    return Boolean(act && act.alphaTween);
  }

  /** 設定透明度（duration 秒補間；0 = 立即） */
  function setAlpha(id, alpha, duration = 0) {
    const act = actors.get(id);
    if (!act) return;
    const target = Math.max(0, Math.min(1, num(alpha, 1)));
    const dur = Math.max(0, num(duration, 0)) * 30;
    if (dur <= 0) {
      act.alpha = target;
      act.alphaTween = null;
      return;
    }
    act.alphaTween = { from: act.alpha, to: target, elapsed: 0, dur };
  }

  /** 水平翻轉 */
  function setFlip(id, value) {
    const act = actors.get(id);
    if (!act) return;
    act.flip = bool(value, true);
  }

  /** 顯示 / 隱藏 */
  function setVisible(id, value) {
    const act = actors.get(id);
    if (!act) return;
    act.visible = value !== false;
  }

  /** 觸發受傷抖動（傷害數字一起用） */
  function hurt(id) {
    const act = actors.get(id);
    if (!act) return;
    act.hurtShake = 1;
  }

  /** 由流程直接設定位置（不補間；jumpToTurn 或初始化用） */
  function setPosition(id, x, y) {
    const act = actors.get(id);
    if (!act) return;
    if (x !== undefined && x !== null) act.x = num(x, act.x);
    if (y !== undefined && y !== null) act.y = num(y, act.y);
    act.move = null;
  }

  /** 每幀更新（1 幀 = 1/30 秒；tick 單位為幀） */
  function update() {
    for (const act of actors.values()) {
      // 位置補間
      if (act.move) {
        const m = act.move;
        m.elapsed += 1;
        const u = m.dur <= 0 ? 1 : Math.min(1, m.elapsed / m.dur);
        const k = easeValue(m.ease, u);
        act.x = m.fromX + (m.toX - m.fromX) * k;
        act.y = m.fromY + (m.toY - m.fromY) * k;
        if (u >= 1) {
          act.x = m.toX;
          act.y = m.toY;
          act.move = null;
        }
      }
      // 透明度補間
      if (act.alphaTween) {
        const t = act.alphaTween;
        t.elapsed += 1;
        const u = t.dur <= 0 ? 1 : Math.min(1, t.elapsed / t.dur);
        act.alpha = t.from + (t.to - t.from) * u;
        if (u >= 1) {
          act.alpha = t.to;
          act.alphaTween = null;
        }
      }
      // 受傷抖動衰減（小於一格就歸零，避免浮點殘值）
      if (act.hurtShake > 0) {
        act.hurtShake -= 1 / HURT_SHAKE_FRAMES;
        if (act.hurtShake < 1e-6) act.hurtShake = 0;
      }
      // 動畫推進（animElapsed 單位：秒；每幀 +1/30）
      if (act.anim && !act.animFinished) {
        const anim = act.anim;
        act.animElapsed += 1 / 30;
        if (!anim.loop) {
          if (act.animElapsed >= animDuration(anim, totalFramesOf(anim)) - 1e-9) {
            act.animFinished = true;
            // 有 then 就自動接下一段（例如 attack → idle）
            if (typeof anim.then === 'string' && anim.then) {
              const nextName = resolveAnimName(act.anims, anim.then);
              if (nextName !== act.animName && act.anims[nextName]) {
                act.animName = nextName;
                act.anim = act.anims[nextName];
                act.animElapsed = 0;
                act.animFinished = false;
              }
            }
          }
        }
      }
    }
  }

  /**
   * 目前動畫的顯示幀（renderer 可直接用）。
   * 非循環動畫永遠夾在最後一幀（絕不取模）；幀數完全未知時回 raw，
   * 由 renderer 用素材實際幀數夾住。循環動畫由 renderer 對素材幀數取模。
   */
  function animFrame(act) {
    if (!act.anim) return 0;
    const fps = Math.max(0, num(act.anim.fps, 10));
    if (fps <= 0) return 0;
    const raw = Math.max(0, Math.floor(act.animElapsed * fps));
    const total = totalFramesOf(act.anim);
    if (total > 0) return act.anim.loop ? raw % total : Math.min(raw, total - 1);
    return raw;
  }

  /** 產生 §5 state.actors */
  function snapshot() {
    const out = [];
    for (const act of list()) {
      out.push({
        id: act.id,
        kind: act.kind,
        sprite: act.anim ? act.anim.sprite : '',
        idleSprite: act.anims.idle?.sprite,
        // 腳下陰影跟著 idle 的尺寸（動作圖畫布較寬時陰影不會跟著變大）
        idleScale:
          act.scale *
          act.formScale *
          (Number.isFinite(act.anims.idle?.scale) && act.anims.idle.scale > 0 ? act.anims.idle.scale : 1),
        idleOrigin: act.anims.idle?.spriteOrigin === true,
        frame: animFrame(act),
        anim: act.animName,
        // 非循環動畫（loop:false）：顯示端要把 frame 夾在素材最後一幀，不取模
        animLoop: act.anim ? act.anim.loop !== false : true,
        // 動畫總幀數（anim.frames 或素材實際幀數；0 = 未知）
        animFrames: totalFramesOf(act.anim),
        // 目前形態（null = 基礎演員動畫；SPEC-P2 §1 forms）
        form: act.form,
        // 顯示位置含形態 offset（邏輯座標仍以 act.x / act.y 為準）
        x: act.x + act.formOffset.x,
        y: act.y + act.formOffset.y,
        // 動畫狀態可選填 flip / scale（同一演員不同形態朝向、像素倍率不同時用）
        flip: act.anim && typeof act.anim.flip === 'boolean' ? act.anim.flip : act.flip,
        alpha: act.alpha,
        scale:
          act.scale *
          act.formScale *
          (act.anim && Number.isFinite(act.anim.scale) && act.anim.scale > 0 ? act.anim.scale : 1),
        // 精靈原始高度（給泡泡對齊頭部用；SPEC-LAYOUT §8）
        spriteH: num(act.def.spriteH, 32),
        ...(act.anim?.spriteOrigin === true ? { spriteOrigin: true } : {}),
        layer: act.layer,
        visible: act.visible,
        hurtShake: act.hurtShake,
      });
    }
    return out;
  }

  /* --------------------------------------------------------- 快照 */

  /**
   * 演員的完整執行期狀態（V2-08 snapshot 用）。
   *
   * 只存 primitive / 純物件；`anims` 等由 actor 定義推導的欄位不存，
   * restore 時用 form + animName 重建（見 restoreState）。
   * @returns {object[]}
   */
  function snapshotState() {
    const out = [];
    for (const act of actors.values()) {
      out.push({
        id: act.id,
        x: act.x,
        y: act.y,
        move: act.move ? { ...act.move } : null,
        animName: act.animName,
        anim: act.anim ? { ...act.anim } : null,
        animElapsed: act.animElapsed,
        animFinished: act.animFinished,
        form: act.form,
        flip: act.flip,
        alpha: act.alpha,
        alphaTween: act.alphaTween ? { ...act.alphaTween } : null,
        scale: act.scale,
        layer: act.layer,
        visible: act.visible,
        hurtShake: act.hurtShake,
      });
    }
    return out;
  }

  /**
   * 還原 snapshotState()。
   *
   * form（形態）先套用（重建 anims / formScale / formOffset），再放回
   * animName + anim 參照；因此形態動畫表與自訂 sprite（setSprite）都能還原。
   *
   * @param {object[]} list
   * @returns {boolean}
   */
  function restoreState(list) {
    if (!Array.isArray(list)) return false;
    for (const src of list) {
      const act = actors.get(src && src.id);
      if (!act) continue;
      applyFormState(act, src.form === undefined ? null : src.form);
      act.x = num(src.x, act.x);
      act.y = num(src.y, act.y);
      act.move = src.move ? { ...src.move } : null;
      act.animName = src.animName === undefined ? null : src.animName;
      act.animElapsed = Math.max(0, num(src.animElapsed, 0));
      act.animFinished = src.animFinished === true;
      if (src.anim && typeof src.anim === 'object') act.anim = { ...src.anim };
      else act.anim = act.animName ? act.anims[act.animName] || null : null;
      act.flip = src.flip === true;
      act.alpha = Math.max(0, Math.min(1, num(src.alpha, 1)));
      act.alphaTween = src.alphaTween ? { ...src.alphaTween } : null;
      act.scale = num(src.scale, 1);
      act.layer = num(src.layer, 0);
      act.visible = src.visible !== false;
      act.hurtShake = Math.max(0, num(src.hurtShake, 0));
    }
    return true;
  }

  /** 重置到初始狀態（reset / jumpToTurn 用） */
  function reset() {
    for (const act of actors.values()) {
      act.x = num(act.def.x, 120);
      act.y = num(act.def.y, 200);
      act.move = null;
      act.alpha = Math.max(0, Math.min(1, num(act.def.alpha, 1)));
      act.alphaTween = null;
      act.flip = bool(act.def.flip, false);
      act.visible = act.def.visible !== false;
      act.hurtShake = 0;
      // 回到初始形態（actor.form；省略 = 基礎動畫）
      applyFormState(act, act.formInitial);
      const initialName = typeof act.def.initialAnim === 'string' ? act.def.initialAnim : FALLBACK_ANIM;
      const resolved = resolveAnimName(act.anims, initialName);
      act.animName = resolved;
      act.anim = act.anims[resolved] || null;
      act.animElapsed = 0;
      act.animFinished = false;
    }
  }

  return {
    get,
    list,
    setAnim,
    setForm,
    getForm,
    formNames,
    displayPos,
    setSprite,
    animDone,
    moveTo,
    isMoving,
    isTweening,
    setAlpha,
    setFlip,
    setVisible,
    hurt,
    setPosition,
    update,
    animFrame,
    snapshot,
    // V2-08：完整執行期狀態的快照 / 還原（serialization 用；不改行為）
    snapshotState,
    restoreState,
    reset,
    get size() {
      return actors.size;
    },
  };
}

/* ------------------------------------------------------------ 補間 */

/**
 * 取得 easing 函式（避免循環依賴，直接內建；與 engine/easing.js 同名同義）。
 * @param {string} name
 * @param {number} u 0..1
 */
export function easeValue(name, u) {
  const t = u < 0 ? 0 : u > 1 ? 1 : u;
  switch (name) {
    case 'linear':
      return t;
    case 'quadIn':
      return t * t;
    case 'quadOut':
      return 1 - (1 - t) * (1 - t);
    case 'quadInOut':
      return t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t);
    case 'sineInOut':
      return 0.5 - 0.5 * Math.cos(Math.PI * t);
    case 'backOut': {
      const c1 = 1.70158;
      const c3 = c1 + 1;
      return 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2;
    }
    default:
      return t;
  }
}

export default createActorSystem;
