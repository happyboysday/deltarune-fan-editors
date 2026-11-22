#!/usr/bin/env node
/**
 * tools/check-samples.mjs — 用 Node 檢查 samples/ 的攻擊 JSON 是否符合 SPEC §3/§4/§5。
 *
 * 這是編輯器/引擎之外的**離線**驗證器，只做結構檢查（不跑模擬）：
 *   * format / meta / settings / box / soul / party / enemies / bulletTypes / timeline 必備欄位
 *   * 事件 id 唯一、at 為數字或拍點字串、type 合法、各 type 的必要欄位與型別
 *   * 事件引用的 bullet 類型必須存在；bulletTypes 引用的 sprite 必須在 assets/index.json
 *   * 表達式字串可用 `new Function` 編譯（不執行）
 *   * 生成欄位只能是 SPEC §5 列出的名稱（含 `memory`）
 *   * 拍點字串（`"2b"`，SPEC-EXPR-V2 §1）與 `memory`（§2.2）的規則直接向引擎借：
 *     `parseBeatString` / `timeToSeconds` / `beatTimingOf` / `isValidMemoryName`，
 *     不在這裡複製一份換算或保留名規則。
 *
 * 用法：
 *   node tools/check-samples.mjs                 # 檢查 samples/ 全部（含 index.json 清單）
 *   node tools/check-samples.mjs samples/x.json  # 只檢查指定檔
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

// 拍點與 memory 的規則來自引擎（SPEC-EXPR-V2 §1/§2），避免兩邊各寫一份而漂移。
import { beatTimingOf, parseBeatString, timeToSeconds } from '../engine/attack.js';
import { compile, isValidMemoryName } from '../engine/expr.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BATTLE_EDITOR = resolve(HERE, '..');
const SAMPLES_DIR = join(BATTLE_EDITOR, 'samples');
const ASSETS_INDEX = join(process.env.DR_ASSETS || join(BATTLE_EDITOR, 'assets'), 'index.json');

const EVENT_TYPES = ['spawn', 'emitter', 'box', 'soul', 'clear', 'shake', 'sfx', 'anim', 'end'];
const EASES = ['linear', 'quadIn', 'quadOut', 'quadInOut', 'sineInOut', 'backOut'];
const SPAWN_FIELDS = [
  'x', 'y', 'speed', 'angle', 'accel', 'angularVel', 'scale', 'rotation', 'life', 'alpha', 'pathX', 'pathY',
];
const EXTRA_SPAWN_FIELDS = ['bullet', 'memory'];
const HITBOX_SHAPES = ['circle', 'rect'];

const errors = [];
const warnings = [];

/** name -> 'sfx' | 'music'（由 assets/index.json 的 audio 段載入；null 表示無法檢查） */
let audioKinds = null;

function err(file, path, message) {
  errors.push(`${basename(file)}: ${path}: ${message}`);
}
function warn(file, path, message) {
  warnings.push(`${basename(file)}: ${path}: ${message}`);
}

function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function isNumberOrExpr(v) {
  return isNumber(v) || typeof v === 'string';
}

/** 該攻擊檔的拍點設定（settings.bpm / beatOffset），整個檔案共用（SPEC-EXPR-V2 §1）。 */
let currentTiming = beatTimingOf(null);

/**
 * 時間欄位檢查（SPEC-EXPR-V2 §1）：數字秒 / 拍點字串 `"2b"` / 舊檔的數字字串（`"1.5"`）。
 * 換算與錯誤訊息直接向引擎要（timeToSeconds），這裡只負責把錯誤塞進報告。
 * @returns {{ok:boolean, seconds:number|null}} seconds = 換算後的秒（非時間欄位或無 bpm 時為 null）
 */
function checkTimeField(file, path, value, timing, opts = {}) {
  if (value === undefined || value === null) return { ok: true, seconds: null };
  const tm = timing || currentTiming;
  const label = opts.label || String(path).split('.').pop();
  const beats = parseBeatString(value);
  if (beats !== null) {
    // 拍點字串：引擎負責「沒 bpm」的錯誤訊息與換算（時間點加 beatOffset、長度不加）
    const r = timeToSeconds(value, tm);
    if (r.error) {
      err(file, path, r.error);
      return { ok: false, seconds: null };
    }
    if (!opts.allowNegative && beats * tm.beatSec < 0) {
      err(file, path, `${label} 不可為負數`);
      return { ok: false, seconds: null };
    }
    return { ok: true, seconds: r.value };
  }
  if (isNumber(value)) {
    if (!opts.allowNegative && value < 0) {
      err(file, path, `${label} 不可為負數`);
      return { ok: false, seconds: null };
    }
    return { ok: true, seconds: value };
  }
  if (typeof value === 'string') {
    // 向後相容：舊檔把秒數寫成字串（"1.5"、"2"）——引擎也接受，視為秒
    const n = Number(value);
    if (value.trim() !== '' && Number.isFinite(n)) {
      if (!opts.allowNegative && n < 0) {
        err(file, path, `${label} 不可為負數`);
        return { ok: false, seconds: null };
      }
      return { ok: true, seconds: n };
    }
  }
  err(file, path, `${label} 必須是秒數或拍點字串（例如 1.5 或 "2b"）`);
  return { ok: false, seconds: null };
}

function compileExpr(file, path, expr) {
  if (typeof expr !== 'string') {
    err(file, path, `表達式必須是字串（收到 ${typeof expr}）`);
    return;
  }
  if (expr.trim() === '') {
    err(file, path, '表達式為空字串');
    return;
  }
  // 直接用引擎的沙箱編譯器：變數白名單（含 spawnX/spawnY/spawnT/bpm/beat/mem）與
  // 保留名規則都和實際執行時一致，不在這裡另寫一份。
  const compiled = compile(expr);
  if (compiled.error) err(file, path, `表達式無法編譯：${compiled.error}`);
}

function checkSpawnFields(file, path, spawn, bulletTypes) {
  if (!spawn || typeof spawn !== 'object' || Array.isArray(spawn)) {
    err(file, path, '缺少生成欄位物件');
    return;
  }
  if (typeof spawn.bullet !== 'string' || !spawn.bullet) {
    err(file, `${path}.bullet`, '必須指定子彈類型名稱');
  } else if (!Object.prototype.hasOwnProperty.call(bulletTypes, spawn.bullet)) {
    err(file, `${path}.bullet`, `引用了不存在的 bulletTypes.${spawn.bullet}`);
  }
  for (const [key, value] of Object.entries(spawn)) {
    if (EXTRA_SPAWN_FIELDS.includes(key)) continue;
    if (!SPAWN_FIELDS.includes(key)) {
      warn(file, `${path}.${key}`, '不是 SPEC §5 的生成欄位（引擎可能忽略）');
      continue;
    }
    if (value === null) continue;
    if (key === 'life') {
      // life 是時間長度欄位：數字秒 / 拍點字串（需 bpm）/ 表達式字串（生成時求值）
      if (typeof value === 'string' && parseBeatString(value) !== null) {
        checkTimeField(file, `${path}.life`, value, currentTiming, { label: 'life' });
      } else if (!isNumberOrExpr(value)) {
        err(file, `${path}.life`, `必須是數字、拍點字串或表達式字串（收到 ${JSON.stringify(value)}）`);
      } else if (typeof value === 'string') {
        compileExpr(file, `${path}.life`, value);
      }
      continue;
    }
    if (!isNumberOrExpr(value)) {
      err(file, `${path}.${key}`, `必須是數字或表達式字串（收到 ${JSON.stringify(value)}）`);
      continue;
    }
    if (typeof value === 'string') {
      // 只有 pathX/pathY 每幀求值；其餘在生成時求值，全部都要能編譯
      compileExpr(file, `${path}.${key}`, value);
      if (key !== 'pathX' && key !== 'pathY' && /\bage\b/.test(value)) {
        warn(file, `${path}.${key}`, 'age 只在 pathX/pathY 可用');
      }
    }
  }
  // memory（SPEC-EXPR-V2 §2.2）：生成時求值一次、固定在每顆子彈上的變數
  checkMemory(file, `${path}.memory`, spawn.memory);
}

/**
 * `memory`：{ 名稱: 數字或表達式 }（SPEC-EXPR-V2 §2.2）。
 * 名稱合法性與保留名由引擎的 isValidMemoryName 判斷；值必須可編譯。
 */
function checkMemory(file, path, memory) {
  if (memory === undefined || memory === null) return;
  if (typeof memory !== 'object' || Array.isArray(memory)) {
    err(file, path, 'memory 必須是物件（{ 名稱: 數字或表達式 }）');
    return;
  }
  for (const [name, value] of Object.entries(memory)) {
    if (!isValidMemoryName(name)) {
      err(file, `${path}.${name}`, '不是合法的記憶名稱（需為合法識別字，且不可用 constructor / __proto__ 等保留名）');
      continue;
    }
    if (value === null || value === undefined) continue;
    if (isNumber(value)) continue;
    if (typeof value !== 'string') {
      err(file, `${path}.${name}`, `必須是數字或表達式字串（收到 ${JSON.stringify(value)}）`);
      continue;
    }
    if (value.trim() === '') {
      err(file, `${path}.${name}`, '表達式為空字串');
      continue;
    }
    compileExpr(file, `${path}.${name}`, value);
  }
}

function checkBulletTypes(file, attack, assetSprites) {
  const types = attack.bulletTypes;
  if (!types || typeof types !== 'object' || Array.isArray(types)) {
    err(file, 'bulletTypes', '必須是物件');
    return {};
  }
  for (const [name, def] of Object.entries(types)) {
    const p = `bulletTypes.${name}`;
    if (!def || typeof def !== 'object') {
      err(file, p, '必須是物件');
      continue;
    }
    if (typeof def.sprite !== 'string' || !def.sprite) {
      err(file, `${p}.sprite`, '必須指定 sprite 名稱');
    } else if (assetSprites && !assetSprites.has(def.sprite)) {
      err(file, `${p}.sprite`, `assets/index.json 沒有 ${def.sprite}`);
    }
    if (def.hitbox) {
      const hb = def.hitbox;
      if (!HITBOX_SHAPES.includes(hb.shape)) {
        err(file, `${p}.hitbox.shape`, `必須是 circle 或 rect（收到 ${JSON.stringify(hb.shape)}）`);
      } else if (hb.shape === 'circle' && !isNumber(hb.r)) {
        err(file, `${p}.hitbox.r`, 'circle 需要數字 r');
      } else if (hb.shape === 'rect' && !(isNumber(hb.w) && isNumber(hb.h))) {
        err(file, `${p}.hitbox`, 'rect 需要數字 w 與 h');
      }
    }
    for (const key of ['frameRate', 'scale']) {
      if (def[key] !== undefined && !isNumber(def[key])) {
        err(file, `${p}.${key}`, '必須是數字');
      }
    }
    for (const key of ['color', 'damage']) {
      if (def[key] !== undefined && def[key] !== null) {
        if (key === 'color' && !/^#[0-9a-fA-F]{6}$/.test(def[key])) {
          err(file, `${p}.color`, '顏色必須是 #rrggbb');
        }
        if (key === 'damage' && !isNumber(def[key])) {
          err(file, `${p}.damage`, '必須是數字或 null');
        }
      }
    }
    for (const key of ['grazeable', 'decor', 'destroyOnHit', 'faceVelocity', 'maskToBox']) {
      if (def[key] !== undefined && typeof def[key] !== 'boolean') {
        err(file, `${p}.${key}`, '必須是布林值');
      }
    }
    if (def.offscreen !== undefined && !['destroy', 'keep'].includes(def.offscreen)) {
      err(file, `${p}.offscreen`, '必須是 destroy 或 keep');
    }
  }
  return types;
}

function checkTimeline(file, attack, bulletTypes) {
  const timeline = attack.timeline;
  if (!Array.isArray(timeline)) {
    err(file, 'timeline', '必須是陣列');
    return;
  }
  const ids = new Set();
  timeline.forEach((ev, index) => {
    const p = `timeline[${index}]`;
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) {
      err(file, p, '必須是物件');
      return;
    }
    if (typeof ev.id !== 'string' || !ev.id) {
      err(file, `${p}.id`, '必須是唯一字串');
    } else if (ids.has(ev.id)) {
      err(file, `${p}.id`, `重複的事件 id：${ev.id}`);
    } else {
      ids.add(ev.id);
    }
    // at：時間點（拍點字串會加 beatOffset；沒 bpm 要用拍點字串會被引擎擋下）
    if (ev.at === undefined || ev.at === null) {
      err(file, `${p}.at`, '必須是秒數或拍點字串（例如 1.5 或 "2b"）');
    } else {
      checkTimeField(file, `${p}.at`, ev.at, currentTiming, { label: 'at' });
    }
    if (!EVENT_TYPES.includes(ev.type)) {
      err(file, `${p}.type`, `未知類型 ${JSON.stringify(ev.type)}（合法：${EVENT_TYPES.join(', ')}）`);
      return;
    }
    if (ev.label !== undefined && typeof ev.label !== 'string') {
      err(file, `${p}.label`, '必須是字串');
    }
    switch (ev.type) {
      case 'spawn': {
        if (!isNumberOrExpr(ev.count) && ev.count !== undefined) {
          err(file, `${p}.count`, '必須是數字或表達式');
        }
        const spawn = {};
        for (const key of [...SPAWN_FIELDS, ...EXTRA_SPAWN_FIELDS]) {
          if (ev[key] !== undefined) spawn[key] = ev[key];
        }
        checkSpawnFields(file, p, spawn, bulletTypes);
        break;
      }
      case 'emitter': {
        // duration / interval：秒數或拍點字串（長度類：不加 beatOffset，且必須 > 0）
        for (const key of ['duration', 'interval']) {
          if (ev[key] === undefined) {
            err(file, `${p}.${key}`, '必須是秒數或拍點字串');
            continue;
          }
          const t = checkTimeField(file, `${p}.${key}`, ev[key], currentTiming, { label: key });
          if (t.ok && t.seconds !== null && !(t.seconds > 0)) {
            err(file, `${p}.${key}`, `emitter 需要大於 0 的 ${key}`);
          }
        }
        if (ev.count !== undefined && !isNumberOrExpr(ev.count)) {
          err(file, `${p}.count`, '必須是數字或表達式');
        }
        checkSpawnFields(file, `${p}.spawn`, ev.spawn, bulletTypes);
        break;
      }
      case 'box': {
        if (ev.duration !== undefined) {
          const t = checkTimeField(file, `${p}.duration`, ev.duration, currentTiming, { label: 'duration' });
          if (t.ok && t.seconds !== null && !(t.seconds > 0)) {
            err(file, `${p}.duration`, 'box 事件需要大於 0 的 duration');
          }
        }
        if (ev.ease !== undefined && !EASES.includes(ev.ease)) {
          err(file, `${p}.ease`, `必須是 ${EASES.join('/')}`);
        }
        if (!ev.to || typeof ev.to !== 'object') {
          err(file, `${p}.to`, '必須是物件');
        } else {
          const allowed = ['x', 'y', 'w', 'h', 'rotation'];
          for (const [k, v] of Object.entries(ev.to)) {
            if (!allowed.includes(k)) err(file, `${p}.to.${k}`, '不是 box 可補間的欄位');
            else if (!isNumber(v)) err(file, `${p}.to.${k}`, '必須是數字');
          }
          if (Object.keys(ev.to).length === 0) err(file, `${p}.to`, '至少要指定一個欄位');
        }
        break;
      }
      case 'soul': {
        for (const key of ['x', 'y']) {
          if (ev[key] !== undefined && ev[key] !== null && !isNumber(ev[key])) {
            err(file, `${p}.${key}`, '必須是數字或 null');
          }
        }
        if (ev.color !== undefined && ev.color !== null && !/^#[0-9a-fA-F]{6}$/.test(ev.color)) {
          err(file, `${p}.color`, '顏色必須是 #rrggbb');
        }
        break;
      }
      case 'clear': {
        if (ev.fade !== undefined) {
          const t = checkTimeField(file, `${p}.fade`, ev.fade, currentTiming, { label: 'fade' });
          if (t.ok && t.seconds !== null && t.seconds < 0) err(file, `${p}.fade`, 'fade 必須大於等於 0');
        }
        break;
      }
      case 'shake': {
        if (ev.duration !== undefined) {
          const t = checkTimeField(file, `${p}.duration`, ev.duration, currentTiming, { label: 'duration' });
          if (t.ok && t.seconds !== null && t.seconds < 0) {
            err(file, `${p}.duration`, 'duration 必須大於等於 0');
          }
        }
        if (ev.amount !== undefined && !isNumber(ev.amount)) err(file, `${p}.amount`, '必須是數字');
        break;
      }
      case 'sfx': {
        if (typeof ev.sound !== 'string' || !ev.sound) err(file, `${p}.sound`, '必須是字串');
        else checkAudioName(file, `${p}.sound`, ev.sound, 'sfx');
        break;
      }
      case 'end':
        break;
      default:
        break;
    }
  });
}

function loadAssetNames() {
  if (!existsSync(ASSETS_INDEX)) {
    warnings.push('缺少 assets/index.json（先跑 python tools/build_assets.py），略過 sprite/音效名稱檢查');
    return null;
  }
  const data = JSON.parse(readFileSync(ASSETS_INDEX, 'utf8'));
  const names = new Set(Object.keys(data.sprites || {}));
  if (data.audio && typeof data.audio === 'object') {
    audioKinds = new Map();
    for (const [name, entry] of Object.entries(data.audio)) {
      const kind = entry && typeof entry.kind === 'string' ? entry.kind : null;
      if (kind === 'sfx' || kind === 'music') audioKinds.set(name, kind);
    }
  }
  return names;
}

/** 檢查音效名稱是否存在（找不到只警告，因為引擎缺音效時是靜默的） */
function checkAudioName(file, path, name, wantKind) {
  if (!audioKinds) return;
  const kind = audioKinds.get(name);
  if (!kind) {
    err(file, path, `assets/index.json 沒有音效「${name}」`);
    return;
  }
  if (wantKind && kind !== wantKind) {
    err(file, path, `「${name}」是 ${kind}，這裡需要 ${wantKind}`);
  }
}

function checkAttack(file, attack, assetSprites) {
  if (attack.format !== 'dr-battle-attack/1') {
    err(file, 'format', `必須是 dr-battle-attack/1（收到 ${JSON.stringify(attack.format)}）`);
  }
  if (!attack.meta || typeof attack.meta !== 'object') {
    err(file, 'meta', '必須是物件');
  } else if (typeof attack.meta.name !== 'string' || !attack.meta.name) {
    err(file, 'meta.name', '必須是非空字串');
  }
  const settings = attack.settings;
  if (!settings || typeof settings !== 'object') {
    err(file, 'settings', '必須是物件');
  } else {
    // 拍點設定（SPEC-EXPR-V2 §1）：後面所有時間欄位都用這份 timing
    currentTiming = beatTimingOf(settings);
    if (settings.bpm !== undefined && settings.bpm !== null && !(isNumber(settings.bpm) && settings.bpm > 0)) {
      err(file, 'settings.bpm', 'bpm 必須是大於 0 的數字（例如 120）或 null');
    }
    if (settings.beatOffset !== undefined && settings.beatOffset !== null && !isNumber(settings.beatOffset)) {
      err(file, 'settings.beatOffset', 'beatOffset 必須是數字（秒）');
    }
    if (settings.duration === undefined || settings.duration === null) {
      err(file, 'settings.duration', '必須是正數秒數或拍點字串');
    } else {
      const t = checkTimeField(file, 'settings.duration', settings.duration, currentTiming, { label: 'duration' });
      if (t.ok && t.seconds !== null && !(t.seconds > 0)) {
        err(file, 'settings.duration', '必須是正數（秒）');
      }
    }
    if (settings.seed !== undefined && !isNumber(settings.seed)) err(file, 'settings.seed', '必須是數字');
    if (settings.damage !== undefined && !isNumber(settings.damage)) err(file, 'settings.damage', '必須是數字');
    if (settings.invincibleFrames !== undefined && !isNumber(settings.invincibleFrames)) {
      err(file, 'settings.invincibleFrames', '必須是數字');
    }
    if (settings.grazeTP !== undefined && !isNumber(settings.grazeTP)) err(file, 'settings.grazeTP', '必須是數字');
    if (settings.background !== null && settings.background !== undefined) {
      if (typeof settings.background !== 'string') err(file, 'settings.background', '必須是字串或 null');
      else if (assetSprites && !assetSprites.has(settings.background)) {
        err(file, 'settings.background', `assets/index.json 沒有 ${settings.background}`);
      }
    }
    if (settings.bgm !== null && settings.bgm !== undefined && typeof settings.bgm !== 'string') {
      err(file, 'settings.bgm', '必須是字串或 null');
    } else if (typeof settings.bgm === 'string' && settings.bgm) {
      checkAudioName(file, 'settings.bgm', settings.bgm, 'music');
    }
  }
  const box = attack.box;
  if (!box || typeof box !== 'object') {
    err(file, 'box', '必須是物件');
  } else {
    for (const key of ['x', 'y', 'w', 'h']) {
      if (!isNumber(box[key])) err(file, `box.${key}`, '必須是數字');
    }
    if (isNumber(box.w) && box.w <= 0) err(file, 'box.w', '必須是正數');
    if (isNumber(box.h) && box.h <= 0) err(file, 'box.h', '必須是正數');
    if (box.rotation !== undefined && !isNumber(box.rotation)) err(file, 'box.rotation', '必須是數字');
    if (box.border !== undefined && !isNumber(box.border)) err(file, 'box.border', '必須是數字');
    if (box.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(box.color)) err(file, 'box.color', '顏色必須是 #rrggbb');
  }
  const soul = attack.soul;
  if (!soul || typeof soul !== 'object') {
    err(file, 'soul', '必須是物件');
  } else {
    for (const key of ['x', 'y']) {
      if (soul[key] !== null && soul[key] !== undefined && !isNumber(soul[key])) {
        err(file, `soul.${key}`, '必須是數字或 null');
      }
    }
    for (const key of ['speed', 'slowSpeed']) {
      if (soul[key] !== undefined && !isNumber(soul[key])) err(file, `soul.${key}`, '必須是數字');
    }
    if (soul.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(soul.color)) err(file, 'soul.color', '顏色必須是 #rrggbb');
  }
  if (!Array.isArray(attack.party) || attack.party.length === 0) {
    err(file, 'party', '必須是非空陣列');
  } else {
    attack.party.forEach((p, i) => {
      if (!p || typeof p.name !== 'string' || !p.name) err(file, `party[${i}].name`, '必須是非空字串');
      for (const key of ['hp', 'maxHp']) {
        if (!isNumber(p[key])) err(file, `party[${i}].${key}`, '必須是數字');
      }
      if (p.hp > p.maxHp) err(file, `party[${i}].hp`, 'hp 不可大於 maxHp');
      if (p.color !== undefined && !/^#[0-9a-fA-F]{6}$/.test(p.color)) err(file, `party[${i}].color`, '顏色必須是 #rrggbb');
    });
  }
  if (!Array.isArray(attack.enemies)) {
    err(file, 'enemies', '必須是陣列');
  } else {
    attack.enemies.forEach((e, i) => {
      if (typeof e.sprite !== 'string' || !e.sprite) err(file, `enemies[${i}].sprite`, '必須是字串');
      else if (assetSprites && !assetSprites.has(e.sprite)) {
        err(file, `enemies[${i}].sprite`, `assets/index.json 沒有 ${e.sprite}`);
      }
      for (const key of ['x', 'y']) {
        if (!isNumber(e[key])) err(file, `enemies[${i}].${key}`, '必須是數字');
      }
      if (e.scale !== undefined && !isNumber(e.scale)) err(file, `enemies[${i}].scale`, '必須是數字');
      if (e.frameRate !== undefined && !isNumber(e.frameRate)) err(file, `enemies[${i}].frameRate`, '必須是數字');
    });
  }
  const bulletTypes = checkBulletTypes(file, attack, assetSprites);
  checkTimeline(file, attack, bulletTypes);

  // 額外：事件時間不應超過 duration（end 事件本身可以等於）。
  // 兩邊都先換算成秒，拍點字串（"2b"）與數字才能比較。
  const duration = secondsOf(attack.settings && attack.settings.duration, currentTiming);
  if (duration !== null && Array.isArray(attack.timeline)) {
    attack.timeline.forEach((ev, i) => {
      const at = secondsOf(ev.at, currentTiming);
      if (at !== null && at > duration) {
        warn(file, `timeline[${i}].at`, `事件時間 ${round2(at)}s 超過 settings.duration ${round2(duration)}s`);
      }
      if (ev.type === 'emitter') {
        const evDuration = secondsOf(ev.duration, currentTiming);
        if (at !== null && evDuration !== null && at + evDuration > duration) {
          warn(file, `timeline[${i}]`, `emitter 執行到 ${round2(at + evDuration)}s，超過 duration ${round2(duration)}s`);
        }
      }
    });
  }

  // demo.path[].t 是時間點（加 beatOffset）；只檢查型別，不檢查遞增（引擎的 validateAttackDemo 管）
  const demoPath = attack.demo && Array.isArray(attack.demo.path) ? attack.demo.path : [];
  demoPath.forEach((point, i) => {
    if (!point || typeof point !== 'object') return;
    if (point.t === undefined) return;
    checkTimeField(file, `demo.path[${i}].t`, point.t, currentTiming, { label: 't' });
  });
}

/** 時間欄位 → 秒（給「超過 duration」這類比較用）；不是可解析的時間就回 null。 */
function secondsOf(value, timing) {
  if (value === undefined || value === null || value === '') return null;
  if (isNumber(value)) return value;
  if (typeof value !== 'string') return null;
  if (parseBeatString(value) !== null) {
    const r = timeToSeconds(value, timing || currentTiming);
    return r.error ? null : r.value;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

// --------------------------------------------------------------------------

function main() {
  const assetSprites = loadAssetNames();
  const args = process.argv.slice(2);
  let files = [];

  if (args.length > 0) {
    files = args.map((a) => resolve(process.cwd(), a));
  } else {
    if (!existsSync(SAMPLES_DIR)) {
      console.error(`找不到 samples 目錄：${SAMPLES_DIR}`);
      process.exit(2);
    }
    // 優先從 index.json 清單讀，其次掃目錄
    const manifestPath = join(SAMPLES_DIR, 'index.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.format !== 'dr-battle-samples/1') {
        errors.push(`samples/index.json: format 必須是 dr-battle-samples/1（收到 ${JSON.stringify(manifest.format)}）`);
      }
      if (!Array.isArray(manifest.samples) || manifest.samples.length === 0) {
        errors.push('samples/index.json: samples 必須是非空陣列');
      } else {
        for (const entry of manifest.samples) {
          if (!entry || typeof entry.file !== 'string') {
            errors.push('samples/index.json: 每筆樣本都需要 file 字串');
            continue;
          }
          const p = join(SAMPLES_DIR, entry.file);
          if (!existsSync(p)) {
            errors.push(`samples/index.json: 找不到檔案 ${entry.file}`);
            continue;
          }
          files.push(p);
        }
      }
    } else {
      errors.push('samples/index.json: 不存在');
    }
  }

  if (files.length === 0) {
    console.error('沒有可檢查的檔案');
    process.exit(2);
  }

  let checked = 0;
  for (const file of files) {
    let attack;
    try {
      attack = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      errors.push(`${basename(file)}: JSON 解析失敗：${e.message}`);
      continue;
    }
    if (!attack || typeof attack !== 'object' || Array.isArray(attack)) {
      errors.push(`${basename(file)}: 根節點必須是物件`);
      continue;
    }
    checkAttack(file, attack, assetSprites);
    checked += 1;
  }

  console.log(`檢查 ${checked} 個攻擊檔（${files.length} 個指定檔案）`);
  if (warnings.length) {
    console.log(`\n警告 ${warnings.length} 則：`);
    for (const w of warnings) console.log(`  ! ${w}`);
  }
  if (errors.length) {
    console.error(`\n錯誤 ${errors.length} 則：`);
    for (const e of errors) console.error(`  x ${e}`);
    process.exitCode = 1;
    return;
  }
  console.log('\n全部通過（結構符合 SPEC §3/§4/§5）');
}

main();
