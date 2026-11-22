#!/usr/bin/env node
/**
 * tools/check-encounters.mjs — 驗證 samples/encounters/ 的遭遇檔（SPEC-P2）。
 *
 * 兩個層次：
 *   1. **結構檢查（不依賴引擎）**：照 SPEC-P2 §1／§3 自己驗一遍。
 *      即使 engine/ 完全不存在也能跑，適合當編輯器與引擎的共同外部基準。
 *   2. **引擎檢查（若模組存在才跑）**：
 *      - `engine/encounter/schema.js` → 實跑 validateEncounter()，與本地規則互相對照
 *      - `engine/encounter/index.js`  → 無頭 createEncounter + 輸入腳本自動選指令，跑幾個回合
 *
 * 另外做跨檔引用檢查：
 *   * actor 動畫／portrait／內嵌攻擊的 bulletTypes 用到的 sprite 必須在 assets/index.json
 *   * sfx 必須在 audio 索引的 sfx 清單、bgm 必須在 music 清單
 *   * turn.attack 字串必須能在 samples/<x>.json、attacks/<x>.json 或 samples/encounters 內解析到
 *   * 只在 samples/ 找到、attacks/ 沒有的攻擊 → 印「注意」（B4：編輯器先查 /api/attacks 404
 *     再回退 samples；不影響通過判定）
 *
 * 用法：
 *   node tools/check-encounters.mjs                # 全部（含引擎檢查，若可用）
 *   node tools/check-encounters.mjs --no-engine    # 只做結構檢查
 *   node tools/check-encounters.mjs a.json b.json  # 只檢查指定檔
 *   node tools/check-encounters.mjs --verbose      # 印出通過的項目摘要
 */

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  ATTACKS_DIR,
  BATTLE_EDITOR,
  ROOT_ATTACKS_DIR,
  SAMPLES_DIR,
  applyCliPaths,
  assetsIndexFile,
  isFile,
  resolveInputFile,
  toPosix,
} from './agent/lib.mjs';

const sampleEncounterDir = () => join(SAMPLES_DIR, 'encounters');

/* ------------------------------------------------------------------ 常數 */

const ENCOUNTER_FORMAT = 'dr-battle-encounter/1';
const ATTACK_FORMAT = 'dr-battle-attack/1';
const TURN_ORDERS = ['sequential', 'loop-last', 'random'];
const HOOK_NAMES = ['intro', 'victory', 'spared', 'defeat', 'flee'];
const RESULT_TYPES = ['victory', 'spared', 'defeat', 'flee'];
const PARTY_COMMANDS = ['fight', 'act', 'magic', 'item', 'spare', 'defend'];
const PARTY_ANIM_STATES = [
  'idle', 'attack', 'act', 'magic', 'item', 'spare', 'defend', 'hurt', 'down', 'victory',
];
const ENEMY_ANIM_STATES = ['idle', 'hurt', 'spared', 'defeat'];
const EASES = ['linear', 'quadIn', 'quadOut', 'quadInOut', 'sineInOut', 'backOut'];
const SPRITE_TAGS = ['soul', 'bullet', 'battlebg', 'enemy', 'ui', 'party'];

const errors = [];
const warnings = [];
const info = [];
/** B4：只存在 samples/、attacks/ 沒有的攻擊參照（不影響通過判定，只提醒）。 */
const notes = [];
const notedAttackRefs = new Set();
/** 攻擊檔名 → 出現的來源（'samples' / 'attacks'）。 */
const attackSources = new Map();
const verbose = process.argv.includes('--verbose');

let currentFile = '';
function err(p, message) {
  errors.push(`${displayFile(currentFile)}: ${p}: ${message}`);
}
function warn(p, message) {
  warnings.push(`${displayFile(currentFile)}: ${p}: ${message}`);
}
function displayFile(file) {
  if (!file) return '(未知檔案)';
  if (file.startsWith(sampleEncounterDir())) return `samples/encounters/${basename(file)}`;
  const rel = relative(BATTLE_EDITOR, file);
  return rel.startsWith('..') ? basename(file) : toPosix(rel);
}

/* ------------------------------------------------------------- 小工具 */

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function isNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
function isTextValue(v) {
  if (typeof v === 'string') return true;
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  if (keys.length === 0) return false;
  return keys.every((k) => k === 'zh' || k === 'en') && typeof v[keys[0]] === 'string';
}
function isColor(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}

/* ------------------------------------------------ 表達式（詞法白名單） */

/**
 * 與 engine/expr.js 同構的最小檢查：
 * `var.x` 改成 `vars.x`（`var` 是保留字不能當參數），其餘照 SPEC 名稱當參數。
 * 只編譯不執行。
 */
function compileExpr(p, expr) {
  if (typeof expr !== 'string') {
    err(p, `表達式必須是字串（收到 ${typeof expr}）`);
    return false;
  }
  if (expr.trim() === '') {
    err(p, '表達式為空字串');
    return false;
  }
  const src = expr.replace(/\bvar\s*\./g, 'vars.');
  try {
    // eslint-disable-next-line no-new-func
    new Function(
      't', 'T', 'i', 'n', 'k', 'age', 'box', 'soul', 'x', 'y', 'turn', 'tp',
      'vars', 'mercy', 'hp', 'maxHp', 'alive', 'actCount',
      'sin', 'cos', 'tan', 'atan2', 'sqrt', 'abs', 'min', 'max', 'floor', 'ceil', 'round', 'PI',
      'rand', 'pick', 'aim', 'lerp',
      `"use strict"; return (${src});`,
    );
  } catch (e) {
    err(p, `表達式無法編譯：${e.message}`);
    return false;
  }
  // 提醒：名稱用字串字面量會被白名單拒絕（SPEC-P2 §3 明確要求識別字形式）
  if (/\b(?:var|mercy|hp|maxHp|alive|actCount)\s*\.\s*['"]/.test(expr)) {
    err(p, '查表名稱要用識別字形式（例如 mercy.rudinn），不可用字串字面量');
  }
  return true;
}

/* ------------------------------------------------------------ 素材索引 */

function loadAssets() {
  const indexFile = assetsIndexFile();
  if (!existsSync(indexFile)) {
    warnings.push('缺少 assets/index.json（先跑 python tools/build_assets.py），略過 sprite 名稱檢查');
    return { sprites: null, sfx: null, music: null, fonts: null };
  }
  const data = JSON.parse(readFileSync(indexFile, 'utf8'));
  const sprites = new Set(Object.keys(data.sprites || {}));
  const audio = data.audio || {};
  const sfx = new Set();
  const music = new Set();
  for (const [name, entry] of Object.entries(audio)) {
    const kind = (entry && entry.kind) || '';
    if (kind === 'music') music.add(name);
    else sfx.add(name);
  }
  return { sprites, sfx, music, fonts: new Set(Object.keys(data.fonts || {})) };
}

function spriteExists(assets, p, name) {
  if (!name) return;
  if (typeof name !== 'string') {
    err(p, 'sprite 必須是字串');
    return;
  }
  if (assets.sprites && !assets.sprites.has(name)) err(p, `assets/index.json 沒有 sprite "${name}"`);
}

/* ------------------------------------------------------- 攻擊參照解析 */

/** 收集可用的攻擊檔名（samples/ 與 attacks/），同時記下來源（B4）。 */
function collectAttackNames() {
  const names = new Set();
  const addDir = (dir, label) => {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json') || f === 'index.json') continue;
      const name = basename(f, '.json');
      names.add(name);
      if (!attackSources.has(name)) attackSources.set(name, new Set());
      attackSources.get(name).add(label);
    }
  };
  addDir(SAMPLES_DIR, 'samples');
  addDir(ATTACKS_DIR, 'attacks');
  addDir(ROOT_ATTACKS_DIR, 'attacks');
  return names;
}

/** 檢查內嵌攻擊物件 */
function checkEmbeddedAttack(p, atk, assets, attackNames) {
  if (!isPlainObject(atk)) {
    err(p, '內嵌攻擊必須是物件');
    return;
  }
  if (atk.format !== undefined && atk.format !== ATTACK_FORMAT) {
    err(`${p}.format`, `必須是 ${ATTACK_FORMAT}`);
  }
  if (atk.settings !== undefined && !isPlainObject(atk.settings)) err(`${p}.settings`, '必須是物件');
  if (atk.box !== undefined && !isPlainObject(atk.box)) err(`${p}.box`, '必須是物件');
  if (atk.bulletTypes !== undefined) {
    if (!isPlainObject(atk.bulletTypes)) err(`${p}.bulletTypes`, '必須是物件');
    else {
      for (const [name, def] of Object.entries(atk.bulletTypes)) {
        if (!isPlainObject(def)) {
          err(`${p}.bulletTypes.${name}`, '必須是物件');
          continue;
        }
        spriteExists(assets, `${p}.bulletTypes.${name}.sprite`, def.sprite);
      }
    }
  }
  if (atk.timeline !== undefined && !Array.isArray(atk.timeline)) err(`${p}.timeline`, '必須是陣列');
  void attackNames;
}

/** 檢查 turn.attack / cue.attack 的參照 */
function checkAttackRef(p, ref, assets, attackNames) {
  if (ref === null || ref === undefined) return;
  if (typeof ref === 'string') {
    if (!ref) {
      err(p, '攻擊檔名不可為空字串');
      return;
    }
    if (!attackNames.has(ref)) {
      err(p, `找不到攻擊檔 "${ref}"（samples/*.json 或 attacks/*.json）`);
    } else if (!(attackSources.get(ref) || new Set()).has('attacks') && !notedAttackRefs.has(ref)) {
      // B4：只在 samples/ 找到 → 編輯器 / 試玩頁會先打 /api/attacks 拿到 404 才回退 samples。
      notedAttackRefs.add(ref);
      notes.push(`\`${ref}\` 只存在於 samples/，編輯器會先查 /api/attacks（404）再回退 samples`);
    }
    return;
  }
  if (isPlainObject(ref)) {
    checkEmbeddedAttack(p, ref, assets, attackNames);
    return;
  }
  err(p, '必須是檔名字串、內嵌攻擊物件或 null');
}

/* -------------------------------------------------------------- 演員 */

function checkAnimTable(assets, actorPath, anims) {
  if (!isPlainObject(anims)) {
    err(`${actorPath}.anims`, '必須是物件（狀態名 → 動畫）');
    return;
  }
  const keys = Object.keys(anims);
  if (keys.length === 0) warn(`${actorPath}.anims`, '空的動畫表（演員不會有畫面）');
  for (const st of keys) {
    const anim = anims[st];
    const p = `${actorPath}.anims.${st}`;
    if (!isPlainObject(anim)) {
      err(p, '動畫定義必須是物件');
      continue;
    }
    if (typeof anim.sprite !== 'string' || !anim.sprite) err(`${p}.sprite`, '必須是 sprite 名稱字串');
    else spriteExists(assets, `${p}.sprite`, anim.sprite);
    if (anim.fps !== undefined && !isNumber(anim.fps)) err(`${p}.fps`, '必須是數字');
    if (anim.loop !== undefined && typeof anim.loop !== 'boolean') err(`${p}.loop`, '必須是布林');
    if (anim.then !== undefined && typeof anim.then !== 'string') err(`${p}.then`, '必須是狀態名字串');
    else if (anim.then && !(anim.then in anims)) warn(`${p}.then`, `then 指向未定義的狀態 "${anim.then}"`);
  }
}

function checkActors(doc, assets) {
  const actors = doc.actors;
  if (!isPlainObject(actors)) {
    err('actors', '必須是物件（id → 演員定義）');
    return new Set();
  }
  const ids = new Set(Object.keys(actors));
  if (ids.size === 0) err('actors', '至少要有一個演員');
  for (const id of ids) {
    const a = actors[id];
    const p = `actors.${id}`;
    if (!isPlainObject(a)) {
      err(p, '演員定義必須是物件');
      continue;
    }
    if (a.kind !== undefined && !['party', 'enemy'].includes(a.kind)) err(`${p}.kind`, 'kind 必須是 party 或 enemy');
    if (a.x !== undefined && !isNumber(a.x)) err(`${p}.x`, '必須是數字');
    if (a.y !== undefined && !isNumber(a.y)) err(`${p}.y`, '必須是數字');
    if (a.anims === undefined) warn(p, '沒有 anims（會有洋紅佔位）');
    else checkAnimTable(assets, p, a.anims);
  }
  return ids;
}

/* ------------------------------------------------------------ 指令清單 */

function cueTextOk(p, value) {
  if (!isTextValue(value)) err(p, '必須是字串或 {zh,en}');
}

function checkCueList(cues, path, ctx) {
  if (cues === undefined || cues === null) return;
  if (!Array.isArray(cues)) {
    err(path, '指令清單必須是陣列');
    return;
  }
  cues.forEach((cue, i) => checkCue(cue, `${path}[${i}]`, ctx));
}

function checkCue(cue, p, ctx) {
  if (!isPlainObject(cue)) {
    err(p, '指令必須是物件');
    return;
  }
  const cmd = cue.cmd;
  if (typeof cmd !== 'string' || !cmd) {
    err(`${p}.cmd`, '必須是指令名稱');
    return;
  }
  const spec = Object.hasOwn(ctx.cueCommands, cmd) ? ctx.cueCommands[cmd] : null;
  if (!spec) {
    err(`${p}.cmd`, `未知的指令 "${cmd}"（合法：${Object.keys(ctx.cueCommands).join(', ')}）`);
    return;
  }
  // async 開關
  if (cue.async !== undefined && typeof cue.async !== 'boolean') err(`${p}.async`, '必須是布林');

  // 必填
  for (const [name, param] of Object.entries(spec.params)) {
    const v = cue[name];
    if (param.required && (v === undefined || (v === null && !param.nullable) || v === '')) {
      err(`${p}.${name}`, `指令 "${cmd}" 缺少必填參數 ${name}`);
    }
  }
  // 未定義欄位（只警告）
  const allowed = new Set([...Object.keys(spec.params), 'cmd', 'async']);
  for (const key of Object.keys(cue)) {
    if (!allowed.has(key)) warn(`${p}.${key}`, `不是 "${cmd}" 的參數（引擎可能忽略）`);
  }
  // 逐指令細部檢查
  switch (cmd) {
    case 'say':
      if (cue.text !== undefined) cueTextOk(`${p}.text`, cue.text);
      if (cue.speaker !== undefined) cueTextOk(`${p}.speaker`, cue.speaker);
      if (cue.portrait !== undefined) spriteExists(ctx.assets, `${p}.portrait`, cue.portrait);
      if (cue.speed !== undefined && !isNumber(cue.speed)) err(`${p}.speed`, '必須是數字');
      if (cue.voice !== undefined && ctx.assets.sfx && !ctx.assets.sfx.has(cue.voice)) {
        err(`${p}.voice`, `audio 索引沒有音效 "${cue.voice}"`);
      }
      break;
    case 'bubble':
      checkActorRef(`${p}.actor`, cue.actor, ctx);
      if (cue.text !== undefined) cueTextOk(`${p}.text`, cue.text);
      if (cue.side !== undefined && !['left', 'right', 'auto'].includes(cue.side)) {
        err(`${p}.side`, '必須是 left / right / auto');
      }
      if (cue.wait !== undefined && cue.wait !== 'input' && !isNumber(cue.wait)) {
        err(`${p}.wait`, '必須是 "input" 或秒數');
      }
      break;
    case 'move':
      checkActorRef(`${p}.actor`, cue.actor, ctx);
      for (const key of ['x', 'y']) {
        if (cue[key] !== undefined && !isNumber(cue[key])) err(`${p}.${key}`, '必須是數字');
      }
      if (cue.relative !== undefined && typeof cue.relative !== 'boolean') err(`${p}.relative`, '必須是布林');
      if (cue.duration !== undefined && !isNumber(cue.duration)) err(`${p}.duration`, '必須是數字');
      if (cue.ease !== undefined && !EASES.includes(cue.ease)) err(`${p}.ease`, `必須是 ${EASES.join('/')}`);
      if (cue.x === undefined && cue.y === undefined) warn(p, 'move 沒有指定 x/y，不會移動');
      break;
    case 'anim':
      checkActorRef(`${p}.actor`, cue.actor, ctx);
      if (cue.anim === undefined && cue.sprite === undefined) err(p, 'anim 需要 anim 狀態名或 sprite');
      if (cue.anim !== undefined && typeof cue.anim !== 'string') err(`${p}.anim`, '必須是字串');
      if (cue.sprite !== undefined) spriteExists(ctx.assets, `${p}.sprite`, cue.sprite);
      if (cue.fps !== undefined && !isNumber(cue.fps)) err(`${p}.fps`, '必須是數字');
      if (cue.loop !== undefined && typeof cue.loop !== 'boolean') err(`${p}.loop`, '必須是布林');
      if (cue.waitEnd !== undefined && typeof cue.waitEnd !== 'boolean') err(`${p}.waitEnd`, '必須是布林');
      break;
    case 'form': {
      const actor = Object.hasOwn(ctx.actors, cue.actor) ? ctx.actors[cue.actor] : null;
      if (!actor) err(`${p}.actor`, `找不到演員 "${cue.actor}"`);
      if (cue.name !== undefined && cue.name !== null &&
        (typeof cue.name !== 'string' || (actor && !Object.hasOwn(actor.forms || {}, cue.name)))) {
        err(`${p}.name`, `找不到形態 "${cue.name}"`);
      }
      break;
    }
    case 'flip':
      checkActorRef(`${p}.actor`, cue.actor, ctx);
      if (cue.value !== undefined && typeof cue.value !== 'boolean') err(`${p}.value`, '必須是布林');
      break;
    case 'fade':
      checkActorRef(`${p}.actor`, cue.actor, ctx);
      if (cue.alpha !== undefined) {
        if (!isNumber(cue.alpha)) err(`${p}.alpha`, '必須是數字');
        else if (cue.alpha < 0 || cue.alpha > 1) err(`${p}.alpha`, '必須在 0..1');
      }
      if (cue.duration !== undefined && !isNumber(cue.duration)) err(`${p}.duration`, '必須是數字');
      break;
    case 'wait':
      if (cue.seconds !== undefined) {
        if (!isNumber(cue.seconds)) err(`${p}.seconds`, '必須是數字');
        else if (cue.seconds < 0) err(`${p}.seconds`, '不可為負');
      }
      break;
    case 'sfx':
      if (typeof cue.sound === 'string' && ctx.assets.sfx && !ctx.assets.sfx.has(cue.sound)) {
        err(`${p}.sound`, `audio 索引沒有音效 "${cue.sound}"`);
      }
      break;
    case 'bgm':
      if (cue.track !== undefined && cue.track !== null) {
        if (typeof cue.track !== 'string') err(`${p}.track`, '必須是字串或 null');
        else if (ctx.assets.music && !ctx.assets.music.has(cue.track)) {
          err(`${p}.track`, `audio 索引沒有音樂 "${cue.track}"`);
        }
      }
      if (cue.fade !== undefined && !isNumber(cue.fade)) err(`${p}.fade`, '必須是數字');
      break;
    case 'shake':
      if (cue.amount !== undefined && !isNumber(cue.amount)) err(`${p}.amount`, '必須是數字');
      if (cue.duration !== undefined && !isNumber(cue.duration)) err(`${p}.duration`, '必須是數字');
      break;
    case 'flash':
      if (cue.color !== undefined && !isColor(cue.color)) err(`${p}.color`, '顏色必須是 #rrggbb');
      if (cue.duration !== undefined && !isNumber(cue.duration)) err(`${p}.duration`, '必須是數字');
      break;
    case 'set':
      if (typeof cue.var !== 'string' || !cue.var) err(`${p}.var`, '必須是變數名字串');
      else if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(cue.var)) err(`${p}.var`, '變數名只能用英數字與底線');
      if (cue.value !== undefined) {
        if (isNumber(cue.value)) break;
        if (typeof cue.value === 'string') compileExpr(`${p}.value`, cue.value);
        else err(`${p}.value`, '必須是數字或表達式字串');
      }
      if (cue.op !== undefined && !['set', 'add'].includes(cue.op)) err(`${p}.op`, '必須是 set 或 add');
      break;
    case 'mercy':
      checkActorRef(`${p}.enemy`, cue.enemy, ctx);
      if (cue.amount !== undefined && !isNumber(cue.amount)) err(`${p}.amount`, '必須是數字');
      break;
    case 'heal':
    case 'damage':
      checkTargetRef(`${p}.target`, cue.target, ctx);
      if (cue.amount !== undefined && !isNumber(cue.amount)) err(`${p}.amount`, '必須是數字或數值表達式字串');
      break;
    case 'if':
      if (cue.cond !== undefined) compileExpr(`${p}.cond`, cue.cond);
      checkCueList(cue.then, `${p}.then`, ctx);
      checkCueList(cue.else, `${p}.else`, ctx);
      break;
    case 'parallel':
      checkCueList(cue.cues, `${p}.cues`, ctx);
      break;
    case 'attack':
      checkAttackRef(`${p}.attack`, cue.attack, ctx.assets, ctx.attackNames);
      break;
    case 'end':
      if (cue.result !== undefined && !RESULT_TYPES.includes(cue.result)) {
        err(`${p}.result`, `必須是 ${RESULT_TYPES.join('/')}`);
      }
      break;
    default:
      break;
  }
}

function checkActorRef(p, value, ctx) {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    err(p, '必須是演員 id 字串');
    return;
  }
  if (!ctx.actorIds.has(value) && !ctx.enemyIds.has(value) && !ctx.partyIds.has(value)) {
    err(p, `找不到演員 / 敵人 / 隊員 "${value}"`);
  }
}

function checkTargetRef(p, value, ctx) {
  if (value === undefined) return;
  if (typeof value !== 'string') {
    err(p, '必須是目標 id 字串');
    return;
  }
  if (value === 'party' || value === 'all') return;
  if (!ctx.partyIds.has(value) && !ctx.enemyIds.has(value)) err(p, `找不到目標 "${value}"`);
}

/* -------------------------------------------------------------- 主結構 */

function checkEncounter(doc, assets, attackNames, schema) {
  if (!isPlainObject(doc)) {
    err('', '遭遇檔根節點必須是物件');
    return;
  }
  if (doc.format !== ENCOUNTER_FORMAT) {
    err('format', `必須是 ${ENCOUNTER_FORMAT}（收到 ${JSON.stringify(doc.format)}）`);
  }
  if (!isPlainObject(doc.meta)) err('meta', '必須是物件');
  else if (!isTextValue(doc.meta.name)) err('meta.name', '必須是非空字串或 {zh,en}');

  const settings = doc.settings;
  if (settings !== undefined) {
    if (!isPlainObject(settings)) err('settings', '必須是物件');
    else {
      if (settings.seed !== undefined && !isNumber(settings.seed)) err('settings.seed', '必須是數字');
      if (settings.bgm !== undefined && settings.bgm !== null && typeof settings.bgm !== 'string') {
        err('settings.bgm', '必須是字串或 null');
      } else if (typeof settings.bgm === 'string' && assets.music && !assets.music.has(settings.bgm)) {
        err('settings.bgm', `audio 索引沒有音樂 "${settings.bgm}"`);
      }
      if (settings.background !== undefined && settings.background !== null) {
        spriteExists(assets, 'settings.background', settings.background);
      }
      if (settings.introText !== undefined && !isTextValue(settings.introText)) {
        err('settings.introText', '必須是字串或 {zh,en}');
      }
      if (settings.canFlee !== undefined && typeof settings.canFlee !== 'boolean') {
        err('settings.canFlee', '必須是布林');
      }
    }
  }

  const actorIds = checkActors(doc, assets);

  /* --- 隊伍 --- */
  const partyIds = new Set();
  if (!Array.isArray(doc.party) || doc.party.length === 0) {
    err('party', '必須是非空陣列');
  } else {
    doc.party.forEach((p, i) => {
      const path = `party[${i}]`;
      if (!isPlainObject(p)) {
        err(path, '隊員必須是物件');
        return;
      }
      if (typeof p.id !== 'string' || !p.id) err(`${path}.id`, '必須是非空字串');
      else if (partyIds.has(p.id)) err(`${path}.id`, `隊員 id 重複 "${p.id}"`);
      else partyIds.add(p.id);
      if (p.actor !== undefined && p.actor !== null && !actorIds.has(p.actor)) {
        err(`${path}.actor`, `找不到演員 "${p.actor}"`);
      }
      for (const key of ['hp', 'maxHp', 'atk', 'def', 'magic']) {
        if (p[key] !== undefined && !isNumber(p[key])) err(`${path}.${key}`, '必須是數字');
      }
      if (isNumber(p.hp) && isNumber(p.maxHp) && p.hp > p.maxHp) err(`${path}.hp`, 'hp 不可大於 maxHp');
      if (isNumber(p.maxHp) && p.maxHp <= 0) err(`${path}.maxHp`, 'maxHp 必須大於 0');
      if (p.commands !== undefined) {
        if (!Array.isArray(p.commands)) err(`${path}.commands`, '必須是陣列');
        else {
          for (const c of p.commands) {
            if (!PARTY_COMMANDS.includes(c)) err(`${path}.commands`, `未知的指令 "${c}"`);
          }
        }
      }
      if (p.color !== undefined && !isColor(p.color)) err(`${path}.color`, '顏色必須是 #rrggbb');
      if (p.spells !== undefined) {
        if (!Array.isArray(p.spells)) err(`${path}.spells`, '必須是陣列');
        else {
          p.spells.forEach((s, si) => {
            const sp = `${path}.spells[${si}]`;
            if (!isPlainObject(s)) {
              err(sp, '法術必須是物件');
              return;
            }
            if (typeof s.id !== 'string' || !s.id) err(`${sp}.id`, '必須是非空字串');
            if (s.name !== undefined) cueTextOk(`${sp}.name`, s.name);
            if (s.tp !== undefined && !isNumber(s.tp)) err(`${sp}.tp`, '必須是數字');
            if (s.target !== undefined && !['enemy', 'party', 'all'].includes(s.target)) {
              err(`${sp}.target`, '必須是 enemy / party / all');
            }
          });
        }
      }
      void PARTY_ANIM_STATES;
    });
  }

  /* --- 敵人 --- */
  const enemyIds = new Set();
  const ctx = { actorIds, partyIds, enemyIds, assets, attackNames, actors: doc.actors || {}, cueCommands: schema.CUE_COMMANDS };
  if (doc.enemies !== undefined) {
    if (!Array.isArray(doc.enemies)) err('enemies', '必須是陣列');
    else {
      doc.enemies.forEach((e, i) => {
        const path = `enemies[${i}]`;
        if (!isPlainObject(e)) {
          err(path, '敵人必須是物件');
          return;
        }
        if (typeof e.id !== 'string' || !e.id) err(`${path}.id`, '必須是非空字串');
        else if (enemyIds.has(e.id)) err(`${path}.id`, `敵人 id 重複 "${e.id}"`);
        else enemyIds.add(e.id);
        if (e.actor !== undefined && e.actor !== null && !actorIds.has(e.actor)) {
          err(`${path}.actor`, `找不到演員 "${e.actor}"`);
        }
        if (e.name !== undefined) cueTextOk(`${path}.name`, e.name);
        for (const key of ['hp', 'maxHp', 'atk', 'def']) {
          if (e[key] !== undefined && !isNumber(e[key])) err(`${path}.${key}`, '必須是數字');
        }
        if (isNumber(e.maxHp) && e.maxHp <= 0) err(`${path}.maxHp`, 'maxHp 必須大於 0');
        if (isNumber(e.hp) && isNumber(e.maxHp) && e.hp > e.maxHp) err(`${path}.hp`, 'hp 不可大於 maxHp');
        if (e.mercy !== undefined && (!isNumber(e.mercy) || e.mercy < 0 || e.mercy > 100)) {
          err(`${path}.mercy`, '必須是 0..100 的數字');
        }
        if (e.spareAt !== undefined && (!isNumber(e.spareAt) || e.spareAt < 0 || e.spareAt > 100)) {
          err(`${path}.spareAt`, '必須是 0..100 的數字');
        }
        if (e.acts !== undefined) {
          if (!Array.isArray(e.acts)) err(`${path}.acts`, '必須是陣列');
          else {
            const actIds = new Set();
            e.acts.forEach((a, ai) => {
              const ap = `${path}.acts[${ai}]`;
              if (!isPlainObject(a)) {
                err(ap, 'ACT 必須是物件');
                return;
              }
              if (typeof a.id !== 'string' || !a.id) err(`${ap}.id`, '必須是非空字串');
              else if (actIds.has(a.id)) err(`${ap}.id`, `ACT id 重複 "${a.id}"`);
              else actIds.add(a.id);
              if (a.name !== undefined) cueTextOk(`${ap}.name`, a.name);
              if (a.text !== undefined && a.text !== null) cueTextOk(`${ap}.text`, a.text);
              if (a.mercy !== undefined && (!isNumber(a.mercy) || a.mercy < 0 || a.mercy > 100)) {
                err(`${ap}.mercy`, '必須是 0..100 的數字');
              }
              if (a.party !== undefined) {
                if (!Array.isArray(a.party)) err(`${ap}.party`, '必須是隊員 id 陣列');
                else
                  for (const pid of a.party) {
                    if (!partyIds.has(pid)) err(`${ap}.party`, `找不到隊員 "${pid}"`);
                  }
              }
              checkCueList(a.cues, `${ap}.cues`, ctx);
            });
          }
        }
        for (const hook of ['onHurt', 'onSpare', 'onDefeat']) checkCueList(e[hook], `${path}.${hook}`, ctx);
        void ENEMY_ANIM_STATES;
      });
    }
  }

  /* --- 道具 --- */
  if (doc.items !== undefined) {
    if (!Array.isArray(doc.items)) err('items', '必須是陣列');
    else {
      doc.items.forEach((it, i) => {
        const path = `items[${i}]`;
        if (!isPlainObject(it)) {
          err(path, '道具必須是物件');
          return;
        }
        if (typeof it.id !== 'string' || !it.id) err(`${path}.id`, '必須是非空字串');
        if (it.name !== undefined) cueTextOk(`${path}.name`, it.name);
        if (it.count !== undefined && (!isNumber(it.count) || it.count < 0)) err(`${path}.count`, '必須是非負數');
        if (it.heal !== undefined && !isNumber(it.heal)) err(`${path}.heal`, '必須是數字');
        if (it.target !== undefined && typeof it.target !== 'string') err(`${path}.target`, '必須是字串');
        if (it.text !== undefined && it.text !== null) cueTextOk(`${path}.text`, it.text);
      });
    }
  }

  /* --- 回合 --- */
  if (!Array.isArray(doc.turns) || doc.turns.length === 0) {
    err('turns', '必須是非空陣列');
  } else {
    const turnIds = new Set();
    doc.turns.forEach((t, i) => {
      const path = `turns[${i}]`;
      if (!isPlainObject(t)) {
        err(path, '回合必須是物件');
        return;
      }
      if (typeof t.id !== 'string' || !t.id) err(`${path}.id`, '必須是非空字串');
      else if (turnIds.has(t.id)) err(`${path}.id`, `回合 id 重複 "${t.id}"`);
      else turnIds.add(t.id);
      if (t.flavor !== undefined && t.flavor !== null) cueTextOk(`${path}.flavor`, t.flavor);
      if (t.attack !== undefined) checkAttackRef(`${path}.attack`, t.attack, assets, attackNames);
      if (t.talk !== undefined) {
        if (!Array.isArray(t.talk)) err(`${path}.talk`, '必須是陣列');
        else {
          t.talk.forEach((tk, ti) => {
            const tp = `${path}.talk[${ti}]`;
            if (!isPlainObject(tk)) {
              err(tp, '台詞必須是物件');
              return;
            }
            if (typeof tk.actor !== 'string' || !tk.actor) err(`${tp}.actor`, '必須是演員 id');
            else if (!actorIds.has(tk.actor)) err(`${tp}.actor`, `找不到演員 "${tk.actor}"`);
            if (tk.text === undefined) err(`${tp}.text`, '缺少台詞');
            else cueTextOk(`${tp}.text`, tk.text);
            if (tk.parallel !== undefined && typeof tk.parallel !== 'boolean') err(`${tp}.parallel`, '必須是布林');
            if (tk.wait !== undefined && typeof tk.wait !== 'number') err(`${tp}.wait`, '必須是數字（秒）');
          });
        }
      }
      for (const key of schema.TURN_CUE_KEYS || ['start', 'beforeAttack', 'end']) {
        checkCueList(t[key], `${path}.${key}`, ctx);
      }
    });
  }

  if (doc.turnOrder !== undefined && !TURN_ORDERS.includes(doc.turnOrder)) {
    err('turnOrder', `必須是 ${TURN_ORDERS.join(' / ')}`);
  }

  /* --- hooks / vars --- */
  if (doc.hooks !== undefined) {
    if (!isPlainObject(doc.hooks)) err('hooks', '必須是物件');
    else {
      for (const name of Object.keys(doc.hooks)) {
        if (!HOOK_NAMES.includes(name)) {
          err(`hooks.${name}`, `未知的時機掛鉤（可用：${HOOK_NAMES.join(' / ')}）`);
          continue;
        }
        checkCueList(doc.hooks[name], `hooks.${name}`, ctx);
      }
    }
  }
  if (doc.vars !== undefined) {
    if (!isPlainObject(doc.vars)) err('vars', '必須是物件');
    else {
      for (const k of Object.keys(doc.vars)) {
        if (!isNumber(doc.vars[k])) err(`vars.${k}`, '變數初值必須是數字');
      }
    }
  }
}

/* ---------------------------------------------------------- 引擎檢查 */

async function tryImport(relPath) {
  const abs = join(BATTLE_EDITOR, relPath);
  if (!existsSync(abs)) return null;
  try {
    return await import(pathToFileURL(abs).href);
  } catch (e) {
    warnings.push(`載入 ${relPath} 失敗：${e.message}`);
    return null;
  }
}

/** 載入攻擊（供 createEncounter 的 resolveAttack 使用）：作品根/attacks → 程式根/attacks → samples */
function resolveAttackLoader() {
  return async (ref) => {
    if (ref && typeof ref === 'object') return ref;
    if (typeof ref !== 'string' || !ref) return null;
    for (const dir of [ATTACKS_DIR, ROOT_ATTACKS_DIR, SAMPLES_DIR]) {
      const p = join(dir, `${ref}.json`);
      if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
    }
    return null;
  };
}

/**
 * 無頭跑一場遭遇：自動推進選單（一律選游標所在項），回傳跑到的階段與回合。
 * 這是「引擎能不能真的跑起來」的煙霧測試，不驗證戰鬥數值。
 */
async function simulateEncounter(createEncounter, doc, label, turnsToPlay) {
  const result = { label, phases: new Set(), turns: 0, frames: 0, ok: false, error: null };
  let enc = null;
  try {
    enc = createEncounter({
      canvas: null,
      assets: null,
      resolveAttack: resolveAttackLoader(),
    });
    if (typeof enc.load === 'function') await enc.load(doc);
    if (typeof enc.play === 'function') enc.play();
    const maxFrames = 30 * 60 * 3; // 最多模擬 3 分鐘遊戲時間
    for (let frame = 0; frame < maxFrames; frame += 1) {
      const st = typeof enc.getState === 'function' ? enc.getState() : null;
      if (!st) break;
      result.phases.add(st.phase);
      result.turns = Math.max(result.turns, (st.turn || 0) + 1);
      if (['victory', 'spared', 'defeat', 'flee'].includes(st.phase)) break;
      if (result.turns > turnsToPlay) break;
      let input = {};
      if (st.phase === 'menu' && st.menu) input = { press: ['confirm'] };
      else if (st.fight) input = { press: ['confirm'] };
      else if (st.textbox || (st.bubbles && st.bubbles.length)) input = { press: ['confirm'] };
      enc.step(1, input);
      result.frames += 1;
    }
    result.ok = true;
  } catch (e) {
    result.error = e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e);
  } finally {
    try {
      if (enc && typeof enc.destroy === 'function') enc.destroy();
    } catch {
      /* ignore */
    }
  }
  return result;
}

async function runEngineChecks(files, assetMap) {
  const schema = await tryImport('engine/encounter/schema.js');
  const index = await tryImport('engine/encounter/index.js');
  if (!schema && !index) {
    info.push('engine/encounter/ 尚未就緒，略過引擎檢查（結構檢查已完成）');
    return;
  }
  const only = globalThis.__onlyFiles;

  // 1) validateEncounter 交叉比對
  if (schema && typeof schema.validateEncounter === 'function') {
    for (const { file, doc } of files) {
      if (only && !only.has(file)) continue;
      let engineErrors = [];
      try {
        engineErrors = schema.validateEncounter(doc) || [];
      } catch (e) {
        errors.push(`engine validateEncounter 拋錯（${displayFile(file)}）：${e.message}`);
        continue;
      }
      for (const e of engineErrors) {
        const where = e && e.path ? e.path : '';
        errors.push(`[engine] ${displayFile(file)}: ${where}: ${e && e.message}`);
      }
      if (verbose) info.push(`engine validateEncounter：${displayFile(file)} → ${engineErrors.length} 個問題`);
    }
  }

  // 無頭模擬
  if (index && typeof index.createEncounter === 'function') {
    for (const { file, doc } of files) {
      if (only && !only.has(file)) continue;
      const labels = [file];
      for (const f of labels) {
        const sim = await simulateEncounter(index.createEncounter, doc, displayFile(f), 2);
        const phases = [...sim.phases].join('→') || '(無)';
        if (sim.error) {
          errors.push(`[engine] 無頭模擬失敗（${displayFile(f)}）：${sim.error}`);
        } else if (sim.phases.size <= 1) {
          errors.push(`[engine] 無頭模擬只停在單一階段（${phases}），狀態機可能沒推進`);
        } else {
          info.push(
            `engine 模擬 ${displayFile(f)}：${sim.frames} 幀，回合 ${sim.turns}，階段 ${phases}`,
          );
          if (![...sim.phases].some((p) => ['attack', 'enemyTalk', 'resolve'].includes(p))) {
            warnings.push(`[engine] ${displayFile(f)}：模擬沒有進入 resolve/enemyTalk/attack 階段`);
          }
        }
      }
    }
  } else if (verbose) {
    info.push('engine/encounter/index.js 尚未提供 createEncounter，略過無頭模擬');
  }
  void assetMap;
}

/* --------------------------------------------------------------- 主流程 */

async function main() {
  // --root / --works（或 DR_ROOT / DR_WORKS）：所有路徑都改由 tools/agent/lib.mjs 解析，
  // 這樣在 worktree 裡執行會自動用 worktree 的引擎與作品根。
  try {
    applyCliPaths(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(2);
  }
  const valueFlags = new Set(['root', 'works']);
  const positional = [];
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const name = token.slice(2).split('=')[0];
      // --root X / --works X：跳過值，避免它被當成檔名
      if (valueFlags.has(name) && !token.includes('=') && i + 1 < argv.length) i += 1;
      continue;
    }
    positional.push(token);
  }
  const noEngine = process.argv.includes('--no-engine');
  const schema = await tryImport('engine/encounter/schema.js');
  if (!schema?.CUE_COMMANDS) throw new Error('無法載入引擎指令表 engine/encounter/schema.js');

  const assets = loadAssets();
  const attackNames = collectAttackNames();

  let files = [];
  if (positional.length > 0) {
    files = positional.map((a) => {
      const resolved = resolveInputFile(a);
      if (!resolved) {
        console.error(`找不到檔案：${a}`);
        process.exit(2);
      }
      return resolved;
    });
  } else {
    const encDir = sampleEncounterDir();
    if (!existsSync(encDir)) {
      console.error(`找不到遭遇範例目錄：${encDir}`);
      process.exit(2);
    }
    const manifestPath = join(encDir, 'index.json');
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.format !== 'dr-battle-encounters/1') {
        errors.push(`samples/encounters/index.json: format 必須是 dr-battle-encounters/1（收到 ${JSON.stringify(manifest.format)}）`);
      }
      if (!Array.isArray(manifest.encounters) || manifest.encounters.length === 0) {
        errors.push('samples/encounters/index.json: encounters 必須是非空陣列');
      } else {
        for (const entry of manifest.encounters) {
          if (!entry || typeof entry.file !== 'string') {
            errors.push('samples/encounters/index.json: 每筆都需要 file 字串');
            continue;
          }
          const p = join(encDir, entry.file);
          if (!existsSync(p)) {
            errors.push(`samples/encounters/index.json: 找不到檔案 ${entry.file}`);
            continue;
          }
          files.push(p);
        }
      }
    } else {
      errors.push('samples/encounters/index.json: 不存在');
    }
  }

  if (files.length === 0) {
    console.error('沒有可檢查的檔案');
    process.exit(2);
  }

  const loaded = [];
  let checked = 0;
  for (const file of files) {
    currentFile = file;
    let doc;
    try {
      doc = JSON.parse(readFileSync(file, 'utf8'));
    } catch (e) {
      errors.push(`${displayFile(file)}: JSON 解析失敗：${e.message}`);
      continue;
    }
    loaded.push({ file, doc });
    checkEncounter(doc, assets, attackNames, schema);
    checked += 1;
  }
  currentFile = '';

  if (!noEngine) {
    globalThis.__onlyFiles = null;
    await runEngineChecks(loaded, assets);
  }

  // ---------------------------------------------------------- 輸出
  console.log(`檢查 ${checked} 個遭遇檔（${files.length} 個指定檔案）`);
  if (assets.sprites) {
    console.log(
      `素材索引：${assets.sprites.size} sprites / ${assets.sfx.size} sfx / ${assets.music.size} music` +
        `；可用攻擊檔：${attackNames.size} 個`,
    );
  }
  if (info.length) {
    console.log('\n資訊：');
    for (const i of info) console.log(`  - ${i}`);
  }
  if (notes.length) {
    console.log(`\n注意 ${notes.length} 則：`);
    for (const n of notes) console.log(`  * ${n}`);
  }
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
  console.log('\n全部通過（結構符合 SPEC-P2 §1/§3；引用素材與攻擊皆存在）');
}

main().catch((e) => {
  console.error('未預期錯誤：', e && e.stack ? e.stack : e);
  process.exit(2);
});
