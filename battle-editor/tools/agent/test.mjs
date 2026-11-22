#!/usr/bin/env node
/**
 * tools/agent/test.mjs — AG（Agent 工具）自我測試（SPEC-AGENT §3/§4）。
 *
 * 零依賴、可重跑：`node tools/agent/test.mjs`
 *   --skip-render   跳過 headless Edge 截圖（沒有 Edge 時本來就會自動跳過）
 *   --skip-mcp      跳過 MCP 協定往返
 *   --verbose       印出每個測試的細節
 *
 * 測試內容：
 *   1) schema：generated/schema/*.json 是合法 JSON Schema、由引擎定義匯出、與磁碟一致
 *   2) 驗證：4 個 sample 攻擊 + 2 個 sample 遭遇都 0 錯誤
 *   3) 模擬：4 個攻擊 + 2 個遭遇都跑得完、統計合理（幀數/子彈/事件）
 *   4) bot：spade-rain 上 dodge 的受傷次數低於 idle
 *   5) 難度：多種子分析有分佈、有危險曲線、有建議
 *   6) MCP：spawn mcp-server → initialize / tools/list / tools/call（dr_validate、dr_read、dr_docs、dr_assets_search）
 *   7) 渲染：headless Edge 截 2 幀 + 聯絡表（Edge 不存在時跳過）
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

import {
  BATTLE_EDITOR,
  DEFAULT_BATTLE_EDITOR,
  DOCS_DIR,
  HERE,
  SAMPLES_DIR,
  SCHEMA_DIR,
  applyCliPaths,
  cliEntry,
  configurePaths,
  isFile,
  parseArgs,
  pathsSnapshot,
  readJSON,
  resolveInputFile,
  resolvePathOptions,
} from './lib.mjs';

/* ------------------------------------------------------------ 測試框架 */

const results = [];
const groupStack = [];
let verbose = false;
let currentGroup = '';

function group(name) {
  currentGroup = name;
  groupStack.push(name);
  console.log(`\n▸ ${name}`);
}

async function test(name, fn) {
  const started = Date.now();
  try {
    const note = await fn();
    const ms = Date.now() - started;
    results.push({ group: currentGroup, name, ok: true, note, ms });
    console.log(`  ✓ ${name}${note ? `（${note}）` : ''}${ms > 1500 ? ` [${ms}ms]` : ''}`);
    return true;
  } catch (err) {
    const ms = Date.now() - started;
    results.push({ group: currentGroup, name, ok: false, error: err && err.stack ? err.stack : String(err), ms });
    console.log(`  ✗ ${name}: ${err && err.message ? err.message : err}`);
    if (verbose && err && err.stack) console.log(err.stack.split('\n').slice(1, 4).join('\n'));
    return false;
  }
}

function skip(name, reason) {
  results.push({ group: currentGroup, name, ok: true, skipped: true, note: reason });
  console.log(`  - ${name}（跳過：${reason}）`);
}

function ok(condition, message) {
  if (!condition) throw new Error(message || '斷言失敗');
}

function eq(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message || '值不相等'}：期望 ${JSON.stringify(expected)}，實際 ${JSON.stringify(actual)}`);
}

function isArray(value, message) {
  if (!Array.isArray(value)) throw new Error(`${message || '不是陣列'}（實際 ${typeof value}）`);
}

function within(value, min, max, message) {
  ok(Number.isFinite(value), `${message || '不是有限數'}（實際 ${value}）`);
  ok(value >= min && value <= max, `${message || '超出範圍'}：${value} 不在 ${min}..${max}`);
}

const SAMPLES = ['spade-rain', 'ring-burst', 'box-shrink-aim', 'sine-wave'];
const SAMPLE_ENCOUNTERS = ['rudinn', 'showcase'];

/* ---------------------------------------------------------------- 1) schema */

async function testSchema() {
  group('1) JSON Schema（export-schema.mjs）');

  const { buildAllSchemas } = await import('./export-schema.mjs');
  const schemas = buildAllSchemas();

  await test('generated/schema 三個檔案都存在且是合法 JSON', () => {
    for (const name of ['attack', 'encounter', 'cues']) {
      const file = join(SCHEMA_DIR, `${name}.json`);
      ok(isFile(file), `缺少 ${file}（請先 node tools/agent/export-schema.mjs）`);
      const parsed = readJSON(file);
      ok(parsed && typeof parsed === 'object', `${name}.json 不是物件`);
    }
    return 'attack / encounter / cues';
  });

  await test('使用 draft 2020-12 且有標題與中文說明', () => {
    for (const name of ['attack', 'encounter']) {
      const schema = readJSON(join(SCHEMA_DIR, `${name}.json`));
      eq(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', `${name}.$schema`);
      ok(schema.title && schema.title.length > 0, `${name} 缺 title`);
      ok(typeof schema.description === 'string' && /[\u4e00-\u9fa5]/.test(schema.description), `${name}.description 應為中文`);
      ok(schema.$defs && Object.keys(schema.$defs).length > 5, `${name}.$defs 太少`);
    }
    return 'ok';
  });

  await test('攻擊 schema 的事件型別與引擎 EVENT_TYPES 一致', async () => {
    const { EVENT_TYPES } = await import('../../engine/attack.js');
    const schema = readJSON(join(SCHEMA_DIR, 'attack.json'));
    const fromSchema = schema['x-eventTypes'];
    eq(JSON.stringify(fromSchema), JSON.stringify(EVENT_TYPES), 'x-eventTypes 與引擎不一致');
    for (const type of EVENT_TYPES) {
      ok(schema.$defs[`event_${type}`], `缺少 $defs.event_${type}`);
      const required = schema.$defs[`event_${type}`].required || [];
      ok(required.includes('type'), `event_${type} 缺 required type`);
      ok(required.includes('at'), `event_${type} 缺 required at`);
      ok(schema.$defs[`event_${type}`].properties.type.enum.includes(type), `event_${type}.type enum 不含自己`);
    }
    return `${EVENT_TYPES.length} 種事件`;
  });

  await test('遭遇 schema 的 cue 指令與引擎 CUE_COMMANDS 一致', async () => {
    const { CUE_COMMANDS } = await import('../../engine/encounter/schema.js');
    const schema = readJSON(join(SCHEMA_DIR, 'encounter.json'));
    const commands = Object.keys(CUE_COMMANDS);
    eq(JSON.stringify(schema['x-cueCommands']), JSON.stringify(commands), 'x-cueCommands 與引擎不一致');
    for (const cmd of commands) {
      const def = schema.$defs[`cue_${cmd}`];
      ok(def, `缺少 $defs.cue_${cmd}`);
      ok((def.required || []).includes('cmd'), `cue_${cmd} 缺 required cmd`);
      for (const paramName of Object.keys(CUE_COMMANDS[cmd].params)) {
        ok(def.properties[paramName], `cue_${cmd} 缺參數 ${paramName}`);
      }
      ok(def.description && def.description.length > 2, `cue_${cmd} 缺中文說明`);
    }
    return `${commands.length} 條指令`;
  });

  await test('cues.json 有指令字典、表達式參考與配方', () => {
    const cues = readJSON(join(SCHEMA_DIR, 'cues.json'));
    eq(cues.format, 'dr-battle-cues/1', 'format');
    ok(Object.keys(cues.commands).length === Object.keys(cues.commandNames).length, 'commands 與 commandNames 數量不一致');
    for (const cmd of cues.commandNames) {
      const entry = cues.commands[cmd];
      ok(entry.desc && entry.desc.length > 2, `${cmd} 缺說明`);
      ok(entry.example && entry.example.cmd === cmd, `${cmd} 的範例 cmd 不符`);
      ok(Array.isArray(cues.categories) && cues.categories.some((c) => c.id === entry.category), `${cmd} 的分類 ${entry.category} 不存在`);
    }
    ok(Array.isArray(cues.expressions.variables) && cues.expressions.variables.length > 5, '缺表達式變數');
    ok(Array.isArray(cues.expressions.helpers) && cues.expressions.helpers.length > 5, '缺表達式函式');
    ok(Array.isArray(cues.recipes) && cues.recipes.length >= 3, '缺配方');
    return `${cues.commandNames.length} 指令、${cues.expressions.variables.length} 變數、${cues.expressions.helpers.length} 函式、${cues.recipes.length} 配方`;
  });

  await test('磁碟上的 schema 與重新產生的內容一致（冪等）', () => {
    for (const name of ['attack', 'encounter', 'cues']) {
      const onDisk = readJSON(join(SCHEMA_DIR, `${name}.json`));
      const fresh = schemas[name];
      eq(JSON.stringify(onDisk), JSON.stringify(fresh), `${name}.json 不是最新（重跑 node tools/agent/export-schema.mjs）`);
    }
    return '一致';
  });

  await test('schema 內的預設值與引擎常數一致', async () => {
    const attack = await import('../../engine/attack.js');
    const schema = readJSON(join(SCHEMA_DIR, 'attack.json'));
    eq(schema['x-defaults'].box.color, attack.BOX_DEFAULTS.color, 'box.color 預設');
    eq(schema['x-defaults'].settings.damage, attack.SETTINGS_DEFAULTS.damage, 'settings.damage 預設');
    eq(schema['x-defaults'].bullet.hitbox.shape, attack.BULLET_DEFAULTS.hitbox.shape, 'bullet.hitbox.shape');
    eq(schema['x-engine-fps'], attack.FPS, 'FPS');
    return '預設值同步';
  });

  await test('attack / encounter schema 都含 demo 欄位（SPEC-AUTOPLAY §2）', () => {
    const attack = readJSON(join(SCHEMA_DIR, 'attack.json'));
    const encounter = readJSON(join(SCHEMA_DIR, 'encounter.json'));
    eq(JSON.stringify(attack.properties.demo.properties.mode.enum), JSON.stringify(['path', 'inputs', 'bot']), 'attack.demo.mode');
    eq(attack.properties.demo.properties.path.items.required.join(','), 't,x,y', 'attack.demo.path 必填欄位');
    eq(JSON.stringify(attack.properties.demo.properties.fallback.enum), JSON.stringify(['bot', 'stay']), 'attack.demo.fallback');
    ok(attack.properties.demo.properties.inputs.description.includes('行程長度編碼'), 'attack.demo.inputs 說明');
    eq(JSON.stringify(encounter.properties.demo.properties.turns.items.properties.dodge.enum), JSON.stringify(['path', 'inputs', 'bot', 'none']), 'encounter.demo.dodge');
    ok(encounter.properties.demo.properties.menuDelay, 'encounter.demo.menuDelay');
    ok(encounter.properties.demo.properties.default, 'encounter.demo.default');
    return '兩份 schema 都有 demo';
  });

  await test('encounter actor 的 form / forms 已納入 schema（SPEC-P2 §1，V2-FIX1）', () => {
    const encounter = readJSON(join(SCHEMA_DIR, 'encounter.json'));
    const actor = encounter.properties.actors.additionalProperties.properties;
    ok(actor.form, '缺少 actor.form');
    eq(JSON.stringify(actor.form.type), JSON.stringify(['string', 'null']), 'form 應接受字串或 null');
    eq(actor.form.default, null, 'form 預設應為 null');
    ok(/SPEC-P2/.test(actor.form.description || ''), 'form 說明應指向 SPEC-P2 §1');
    ok(actor.forms, '缺少 actor.forms');
    const form = actor.forms.additionalProperties.properties;
    ok(form.anims, 'forms.<name>.anims 不存在');
    eq(form.anims.additionalProperties.title, '動畫', 'forms.anims 應沿用動畫 schema');
    eq(form.anims.description.includes('退回'), true, 'forms.anims 應說明退回基礎動畫');
    eq(form.offset.properties.x.type, 'number', 'forms.offset.x 型別');
    eq(form.offset.properties.y.type, 'number', 'forms.offset.y 型別');
    eq(form.offset.additionalProperties, false, 'forms.offset 不應接受額外欄位');
    ok(form.scale.minimum > 0, 'forms.scale 應有最小值');
    return 'form/forms 已納入 actor schema';
  });
}

/* -------------------------------------------------------------- 2) 驗證 */

async function testValidate() {
  group('2) 驗證（validateAttack / validateEncounter）');
  const { validateAttack } = await import('../../engine/attack.js');
  const { validateEncounter } = await import('../../engine/encounter/schema.js');

  await test('4 個 sample 攻擊都 0 錯誤', () => {
    for (const name of SAMPLES) {
      const file = join(SAMPLES_DIR, `${name}.json`);
      ok(isFile(file), `找不到 sample：${file}`);
      const errors = validateAttack(readJSON(file));
      eq(errors.length, 0, `${name} 有錯誤：${JSON.stringify(errors.slice(0, 3))}`);
    }
    return SAMPLES.join(', ');
  });

  await test('2 個 sample 遭遇都 0 錯誤', () => {
    for (const name of SAMPLE_ENCOUNTERS) {
      const file = join(SAMPLES_DIR, 'encounters', `${name}.json`);
      ok(isFile(file), `找不到 sample 遭遇：${file}`);
      const errors = validateEncounter(readJSON(file));
      eq(errors.length, 0, `${name} 有錯誤：${JSON.stringify(errors.slice(0, 3))}`);
    }
    return SAMPLE_ENCOUNTERS.join(', ');
  });

  await test('validateAttack 抓得到壞資料（負向測試）', () => {
    const bad = { format: 'dr-battle-attack/1', settings: { duration: -1 }, timeline: [{ at: -5, type: 'nope' }] };
    const errors = validateAttack(bad);
    ok(errors.length >= 2, `應該回報多個錯誤，實際 ${errors.length}`);
    ok(errors.some((e) => /duration/i.test(e.path || e.message || '')), '應指出 duration 問題');
    return `${errors.length} 個錯誤`;
  });
}

/* -------------------------------------------------------------- 3) 模擬 */

async function testSimulate() {
  group('3) 無頭模擬（sim.mjs）');
  const { simulate } = await import('./sim.mjs');

  for (const name of SAMPLES) {
    await test(`攻擊 ${name} 跑得完且統計合理`, async () => {
      const result = await simulate(join(SAMPLES_DIR, `${name}.json`), { bot: 'idle' });
      eq(result.kind, 'attack', 'kind');
      ok(result.frames > 0, '幀數應 > 0');
      ok(result.totalFrames >= 100, `總幀數太小：${result.totalFrames}`);
      ok(result.maxBullets > 0, '整段都沒子彈？');
      ok(result.avgBullets >= 0, 'avgBullets');
      eq(result.errors.length, 0, `引擎錯誤：${JSON.stringify(result.errors.slice(0, 3))}`);
      isArray(result.perTurn, 'perTurn');
      isArray(result.events, 'events');
      ok(result.events.length > 0, '沒有任何事件（hit/graze/end）？');
      return `${result.frames}/${result.totalFrames} 幀、彈峰值 ${result.maxBullets}、受傷 ${result.hits}`;
    });
  }

  for (const name of SAMPLE_ENCOUNTERS) {
    await test(`遭遇 ${name} 跑得完且回合統計合理`, async () => {
      const result = await simulate(join(SAMPLES_DIR, 'encounters', `${name}.json`), {
        bot: 'dodge',
        frames: 1200,
      });
      eq(result.kind, 'encounter', 'kind');
      ok(result.frames > 0, '幀數應 > 0');
      eq(result.errors.length, 0, `錯誤：${JSON.stringify(result.errors.slice(0, 3))}`);
      isArray(result.perTurn, 'perTurn');
      ok(result.perTurn.length >= 1, '至少要有一回合統計');
      ok(result.perTurn.some((turn) => turn.frames > 0), '回合沒有幀數');
      ok(result.perTurn.every((turn) => typeof turn.turn === 'number'), '回合編號格式錯誤');
      return `${result.frames} 幀、${result.perTurn.length} 回合、受傷 ${result.hits}、phase=${result.phase}`;
    });
  }

  await test('--frames 上限有作用（不會超跑）', async () => {
    const result = await simulate(join(SAMPLES_DIR, 'spade-rain.json'), { bot: 'idle', frames: 45 });
    within(result.frames, 1, 45, 'frames 應被限制在 45 以內');
    return `frames=${result.frames}`;
  });

  await test('相同 seed 兩次結果一致（決定性）', async () => {
    const first = await simulate(join(SAMPLES_DIR, 'ring-burst.json'), { bot: 'idle', seed: 7 });
    const second = await simulate(join(SAMPLES_DIR, 'ring-burst.json'), { bot: 'idle', seed: 7 });
    eq(first.hits, second.hits, 'hits 不一致');
    eq(first.grazes, second.grazes, 'grazes 不一致');
    eq(first.maxBullets, second.maxBullets, 'maxBullets 不一致');
    return `hits=${first.hits} grazes=${first.grazes}`;
  });

  await test('攻擊 --autoplay demo：4 個 samples 都 0 受傷（demo.path 能過）', async () => {
    for (const name of SAMPLES) {
      const result = await simulate(join(SAMPLES_DIR, `${name}.json`), { autoplay: 'demo' });
      eq(result.kind, 'attack', `${name} kind`);
      eq(result.autoplay.mode, 'demo', `${name} autoplay.mode`);
      eq(result.autoplay.warnings.length, 0, `${name} 不該有腳本警告：${JSON.stringify(result.autoplay.warnings)}`);
      eq(result.errors.length, 0, `${name} 引擎錯誤：${JSON.stringify(result.errors.slice(0, 2))}`);
      eq(result.hits, 0, `${name} 應 0 受傷，實際 ${result.hits}`);
    }
    return `${SAMPLES.length} 個 samples 全 0 受傷`;
  });

  await test('攻擊 --autoplay bot：spade-rain 能跑完（AI 模式）', async () => {
    const result = await simulate(join(SAMPLES_DIR, 'spade-rain.json'), { autoplay: 'bot' });
    eq(result.autoplay.mode, 'bot', 'autoplay.mode');
    ok(result.autoplay.describe && result.autoplay.describe.dodge, 'describe 應有 dodge');
    eq(result.errors.length, 0, `引擎錯誤：${JSON.stringify(result.errors.slice(0, 2))}`);
    ok(result.ended, 'AI 應跑完');
    return `hits=${result.hits}`;
  });

  await test('遭遇 rudinn：autoplay demo → spared、autoplay bot → victory', async () => {
    const demo = await simulate(join(SAMPLES_DIR, 'encounters', 'rudinn.json'), { autoplay: 'demo', frames: 1800 });
    eq(demo.kind, 'encounter', 'kind');
    eq(demo.autoplay.mode, 'demo', 'autoplay.mode');
    eq(demo.errors.length, 0, `demo 錯誤：${JSON.stringify(demo.errors.slice(0, 3))}`);
    eq(demo.result, 'spared', `demo 應 spared，實際 ${demo.result}`);
    const bot = await simulate(join(SAMPLES_DIR, 'encounters', 'rudinn.json'), { autoplay: 'bot', frames: 1800 });
    eq(bot.autoplay.mode, 'bot', 'bot autoplay.mode');
    eq(bot.result, 'victory', `bot 應 victory，實際 ${bot.result}`);
    return `demo=${demo.result}、bot=${bot.result}`;
  });

  /* ------------------------------------------------ 遭遇事件（V2-04 §2） */

  await test('遭遇事件：回合起訖、指令、ACT、mercy/TP/HP、台詞、攻擊、結果', async () => {
    const result = await simulate(join(SAMPLES_DIR, 'encounters', 'rudinn.json'), { autoplay: 'demo', frames: 1800 });
    isArray(result.events, 'events');
    ok(result.events.length > 20, `事件太少：${result.events.length}`);
    const counts = result.eventCounts || {};
    for (const type of ['turnStart', 'turnEnd', 'actions', 'act', 'actDone', 'mercy', 'tp', 'say', 'bubble', 'attackStart', 'attackEnd', 'end']) {
      ok(counts[type] > 0, `缺少 ${type} 事件（eventCounts=${JSON.stringify(counts)}）`);
    }
    ok(counts.turnStart === counts.turnEnd, `turnStart(${counts.turnStart}) 應等於 turnEnd(${counts.turnEnd})`);
    for (const event of result.events) {
      ok(typeof event.type === 'string' && event.type.length > 0, '每個事件都要有 type');
      ok(typeof event.frame === 'number' && event.frame >= 0, `${event.type} 缺 frame`);
      ok(typeof event.turn === 'number', `${event.type} 缺 turn`);
    }
    // 台詞要有 speaker 與文字
    const say = result.events.find((event) => event.type === 'say');
    ok(say && typeof say.text === 'string' && say.text.length > 0, 'say 事件要有文字');
    ok('speaker' in say, 'say 事件要有 speaker 欄位');
    // ACT：actId + 目標敵人
    const act = result.events.find((event) => event.type === 'act');
    ok(act && typeof act.actId === 'string' && act.enemy, `act 事件缺 actId/enemy：${JSON.stringify(act)}`);
    // mercy 要有前後值
    const mercy = result.events.find((event) => event.type === 'mercy');
    ok(mercy && typeof mercy.before === 'number' && typeof mercy.after === 'number' && mercy.after !== mercy.before, 'mercy 要有前後值');
    // TP 要有前後值
    const tp = result.events.find((event) => event.type === 'tp');
    ok(tp && typeof tp.before === 'number' && typeof tp.after === 'number' && typeof tp.cause === 'string', 'tp 要有前後值與原因');
    // 攻擊起訖 + hits
    const attackEnd = result.events.find((event) => event.type === 'attackEnd');
    ok(attackEnd && typeof attackEnd.ref === 'string' && typeof attackEnd.hits === 'number' && typeof attackEnd.grazes === 'number', 'attackEnd 要有 ref/hits/grazes');
    // 結果
    const end = result.events.find((event) => event.type === 'end');
    eq(end && end.result, 'spared', 'end.result');
    eq(result.eventCounts.end, 1, '只該有一個 end');
    return `${result.events.length} 筆事件、${Object.keys(counts).length} 種`;
  });

  await test('遭遇事件：perTurn 有指令與回合起訖幀', async () => {
    const result = await simulate(join(SAMPLES_DIR, 'encounters', 'rudinn.json'), { autoplay: 'demo', frames: 1800 });
    ok(result.perTurn.length >= 2, `回合太少：${result.perTurn.length}`);
    for (const turn of result.perTurn) {
      isArray(turn.commands, `第 ${turn.turn} 回合 commands`);
      ok(turn.commands.length > 0, `第 ${turn.turn} 回合沒有指令`);
      for (const command of turn.commands) {
        ok(['fight', 'act', 'magic', 'item', 'spare', 'defend'].includes(command), `未知指令 ${command}`);
      }
      ok(typeof turn.startedFrame === 'number', `第 ${turn.turn} 回合缺 startedFrame`);
      ok(turn.endedFrame === null || typeof turn.endedFrame === 'number', `第 ${turn.turn} 回合 endedFrame 格式`);
      if (turn.endedFrame !== null) ok(turn.endedFrame >= turn.startedFrame, `第 ${turn.turn} 回合結束早於開始`);
    }
    ok(
      result.perTurn.every((turn, i, list) => i === 0 || turn.startedFrame >= list[i - 1].startedFrame),
      '回合起幀應遞增',
    );
    return result.perTurn.map((turn) => `T${turn.turn}:${turn.commands.join('/')}`).join(' ');
  });

  await test('遭遇事件：HP 變化有前後值（showcase bot 打得到敵人）', async () => {
    const result = await simulate(join(SAMPLES_DIR, 'encounters', 'showcase.json'), { autoplay: 'bot', frames: 1800 });
    const hp = result.events.filter((event) => event.type === 'hp');
    ok(hp.length > 0, '沒有任何 HP 變化事件');
    for (const event of hp) {
      ok(typeof event.from === 'number' && typeof event.to === 'number', `${String(event.id)} 缺 from/to`);
      ok(event.from !== event.to, `${String(event.id)} from===to 不該發事件`);
      ok(event.cause === 'damage' || event.cause === 'heal', `未知 cause：${event.cause}`);
      ok(typeof event.kind === 'string', 'hp 事件要有 kind（party/enemy）');
    }
    return `${hp.length} 筆 HP 變化`;
  });

  await test('遭遇事件：--json 的 events 可序列化且順序單調', async () => {
    const result = await simulate(join(SAMPLES_DIR, 'encounters', 'rudinn.json'), { autoplay: 'demo', frames: 900 });
    const text = JSON.stringify(result);
    ok(text.length > 0, '序列化失敗');
    const frames = result.events.map((event) => event.frame);
    ok(frames.every((frame, i) => i === 0 || frame >= frames[i - 1]), '事件幀應單調不減');
    return `可序列化（${(text.length / 1024).toFixed(1)}KB）`;
  });
}

/* ----------------------------------------------------------------- 4) bot */

async function testBot() {
  group('4) 自動閃避 bot（bot.mjs）');
  const { simulate } = await import('./sim.mjs');
  const { createBot, BOT_NAMES } = await import('./bot.mjs');

  await test('bot 決策只依賴 getState 且輸出合法方向', async () => {
    const { createBattle } = await import('../../engine/index.js');
    const battle = createBattle({ canvas: null, assets: null, mode: 'play' });
    battle.load(readJSON(join(SAMPLES_DIR, 'spade-rain.json')));
    const bot = createBot({ bot: 'dodge', seed: 3 });
    let decisions = 0;
    for (let frame = 0; frame < 120; frame += 1) {
      const state = battle.getState();
      const input = bot.decide(state);
      decisions += 1;
      ok(input && typeof input === 'object', 'decide 應回傳物件');
      ok([-1, 0, 1].includes(input.dx), `dx 不合法：${input.dx}`);
      ok([-1, 0, 1].includes(input.dy), `dy 不合法：${input.dy}`);
      ok(typeof input.slow === 'boolean', 'slow 應為布林');
      battle.engine.stepFrame(input);
    }
    battle.destroy();
    return `${decisions} 次決策`;
  });

  await test('三種 bot 都能跑（idle/random/dodge）', () => {
    eq(JSON.stringify(BOT_NAMES), JSON.stringify(['dodge', 'idle', 'random']), 'BOT_NAMES');
    for (const kind of BOT_NAMES) {
      const bot = createBot({ bot: kind });
      const input = bot.decide({ box: { x: 320, y: 171, w: 150, h: 150, rotation: 0 }, soul: { x: 320, y: 171 }, bullets: [] });
      ok(input && typeof input.dx === 'number', `${kind} 回傳不合法`);
    }
    return BOT_NAMES.join(', ');
  });

  await test('spade-rain 上 dodge 受傷次數低於 idle', async () => {
    const file = join(SAMPLES_DIR, 'spade-rain.json');
    const idle = await simulate(file, { bot: 'idle', seed: 1 });
    const dodge = await simulate(file, { bot: 'dodge', seed: 1 });
    const random = await simulate(file, { bot: 'random', seed: 1 });
    if (idle.hits === 0) {
      return `攻擊太溫和（idle 也沒受傷），dodge=${dodge.hits} random=${random.hits}`;
    }
    ok(
      dodge.hits < idle.hits,
      `dodge（${dodge.hits}）應少於 idle（${idle.hits}）`,
    );
    const reduction = ((1 - dodge.hits / idle.hits) * 100).toFixed(0);
    return `idle ${idle.hits} → dodge ${dodge.hits}（-${reduction}%），random ${random.hits}`;
  });
}

/* ------------------------------------------------------------ 5) 難度 */

async function testDifficulty() {
  group('5) 難度分析（difficulty.mjs）');
  const { analyzeDifficulty, THRESHOLDS, turnAttackLabel } = await import('./difficulty.mjs');

  await test('spade-rain 多種子分析：分佈、危險曲線、建議', async () => {
    const report = await analyzeDifficulty(join(SAMPLES_DIR, 'spade-rain.json'), { runs: 5, bot: 'dodge' });
    eq(report.runs, 5, 'runs');
    eq(report.details.length, 5, 'details 數量');
    within(report.hits.median, 0, 40, '中位數受傷');
    within(report.hits.min, 0, report.hits.max, 'min/max');
    ok(['easy', 'normal', 'hard', 'extreme'].includes(report.difficulty), `難度分類不合法：${report.difficulty}`);
    ok(typeof report.passable === 'boolean', 'passable 應為布林');
    isArray(report.danger, 'danger');
    ok(report.danger.length >= 5, `危險曲線太短：${report.danger.length}`);
    ok(report.danger.every((row) => typeof row.second === 'number' && typeof row.bulletDensity === 'number'), 'danger 欄位格式');
    isArray(report.suggestions, 'suggestions');
    ok(report.suggestions.length >= 2, '建議太少');
    eq(report.errors.length, 0, `錯誤：${JSON.stringify(report.errors.slice(0, 2))}`);
    ok(THRESHOLDS.passableHits > 0, '門檻設定');
    return `${report.difficulty}、中位數 ${report.hits.median}、0 傷 ${report.clearRuns}/${report.runs}、${report.danger.length} 秒曲線、${report.suggestions.length} 條建議`;
  });

  await test('遭遇難度：整場報告（逐回合分佈、最危險回合、勝/饒恕/敗、總時長）', async () => {
    const report = await analyzeDifficulty(join(SAMPLES_DIR, 'encounters', 'rudinn.json'), { runs: 3, frames: 2400 });
    eq(report.kind, 'encounter', 'kind');
    eq(report.runs, 3, 'runs');
    eq(report.autoplay, 'bot', '遭遇預設走 autoplay bot');
    eq(report.bot, null, 'autoplay 時 bot 應為 null');
    const encounter = report.encounter;
    ok(encounter && typeof encounter === 'object', '遭遇應有 encounter 欄位');
    isArray(encounter.turns, 'encounter.turns');
    ok(encounter.turns.length >= 2, `逐回合資料太少：${encounter.turns.length}`);
    for (const turn of encounter.turns) {
      ok(typeof turn.turn === 'number', 'turn 編號');
      ok(turn.hits && typeof turn.hits.mean === 'number' && typeof turn.hits.max === 'number', `第 ${turn.turn} 回合缺受傷分佈`);
      ok(typeof turn.noHitRate === 'number' && turn.noHitRate >= 0 && turn.noHitRate <= 1, `第 ${turn.turn} 回合無傷率格式`);
      ok(turn.damage && typeof turn.damage.mean === 'number', `第 ${turn.turn} 回合缺傷害分佈`);
      isArray(turn.commands, `第 ${turn.turn} 回合 commands`);
    }
    ok('mostDangerous' in encounter, '缺 mostDangerous');
    const outcome = encounter.outcome;
    ok(outcome && outcome.counts && outcome.rates, '缺 outcome');
    const total = Object.values(outcome.counts).reduce((sum, n) => sum + n, 0);
    eq(total, 3, 'outcome 總數應等於 runs');
    const defeated = outcome.counts.victory + outcome.counts.spared + outcome.counts.defeat + outcome.counts.flee;
    eq(defeated, 3, `3 次模擬都該打完（victory/spared/defeat/flee），實際 ${JSON.stringify(outcome.counts)}`);
    const duration = encounter.duration;
    ok(duration && typeof duration.seconds.mean === 'number' && duration.seconds.mean > 0, '缺總時長');
    ok(duration.frames && typeof duration.frames.median === 'number', '缺幀數分佈');
    // details 每筆也要帶逐回合
    ok(report.details.every((row) => Array.isArray(row.turns)), 'details 應帶逐回合');
    return `${encounter.turns.length} 回合、${Object.entries(outcome.counts).filter(([, n]) => n > 0).map(([k, n]) => `${k}${n}`).join('/')}、平均 ${duration.seconds.mean}s`;
  });

  await test('遭遇難度：回合內 attack cue 的攻擊有名字；passable 看通關率、零傷率另外命名（REALTEST-2 V3）', async () => {
    const doc = JSON.parse(readFileSync(join(SAMPLES_DIR, 'encounters', 'rudinn.json'), 'utf8'));
    // 所有回合都改成「turn.attack = null ＋ start 的 attack cue」
    for (const turn of doc.turns) {
      const name = turn.attack;
      turn.attack = null;
      turn.start = [...(turn.start || []), { cmd: 'attack', attack: name }];
    }
    const { simulate } = await import('./sim.mjs');
    const one = await simulate(doc, { autoplay: 'bot', frames: 2400 });
    eq(one.errors.length, 0, `模擬錯誤：${JSON.stringify(one.errors.slice(0, 2))}`);
    const played = one.perTurn.filter((t) => t.attacks.length > 0);
    ok(played.length >= 1, 'perTurn[].attacks 應記到 attack cue 播的攻擊');
    for (const t of played) {
      eq(t.attack, t.attacks[0].name, 'turn.attack 為 null 時用實際播出的攻擊補名字');
      ok(typeof t.attacks[0].startFrame === 'number', 'attacks[].startFrame');
      ok(t.attacks[0].endFrame === null || t.attacks[0].frames === t.attacks[0].endFrame - t.attacks[0].startFrame, 'attacks[].frames');
    }
    eq(one.perTurn[0].attack, 'spade-rain', '第 1 回合的攻擊名');

    const report = await analyzeDifficulty(doc, { runs: 3, frames: 2400 });
    const enc = report.encounter;
    ok(enc.turns.every((t) => t.attack && t.attacks.length > 0), `每回合都該有攻擊名：${JSON.stringify(enc.turns.map((t) => t.attack))}`);
    ok(!report.suggestions.some((tip) => tip.includes('無攻擊')), `建議不該出現「無攻擊」：${report.suggestions.join(' | ')}`);
    eq(report.zeroHitRate, report.clearRate, 'zeroHitRate 是 clearRate 的新名字');
    eq(report.zeroHitRuns, report.clearRuns, 'zeroHitRuns');
    ok(typeof enc.completionRate === 'number', 'encounter.completionRate');
    eq(report.completionRate, enc.completionRate, 'completionRate 提到頂層');
    const rate = (enc.outcome.counts.victory + enc.outcome.counts.spared) / 3;
    within(enc.completionRate, rate - 0.01, rate + 0.01, 'completionRate = (victory+spared)/runs');
    eq(report.passable, enc.completionRate >= THRESHOLDS.passableCompletionRate, '遭遇的 passable 依通關率判定');
    ok(typeof report.passableReason === 'string' && report.passableReason.includes('通關率'), `passableReason：${report.passableReason}`);
    eq(turnAttackLabel({ attack: null, attacks: [], hits: { max: 2 } }), '攻擊名稱不明', '有受傷不能說無攻擊');
    eq(turnAttackLabel({ attack: null, attacks: [], hits: { max: 0 } }), '無攻擊', '真的沒攻擊');
    eq(turnAttackLabel({ attack: 'a', attacks: ['a', 'b'], hits: { max: 0 } }), 'a、b', '多支攻擊');
    return `passable=${report.passable}（${report.passableReason}）`;
  });

  await test('攻擊難度：passableReason 說明零傷率門檻；completionRate 為 null', async () => {
    const report = await analyzeDifficulty(join(SAMPLES_DIR, 'spade-rain.json'), { runs: 2, bot: 'dodge' });
    eq(report.completionRate, null, '攻擊沒有通關率');
    ok(report.passableReason.includes('零傷率'), report.passableReason);
    eq(report.zeroHitRate, report.clearRate, 'zeroHitRate');
    return report.passableReason;
  });

  await test('遭遇難度：--autoplay demo 也會記錄（demo 路線）', async () => {
    const report = await analyzeDifficulty(join(SAMPLES_DIR, 'encounters', 'rudinn.json'), {
      runs: 2,
      frames: 2400,
      autoplay: 'demo',
    });
    eq(report.autoplay, 'demo', 'autoplay');
    ok(report.encounter.outcome.counts.spared >= 1, 'demo 至少一次饒恕成功');
    ok(report.suggestions.length > 0, '缺建議');
    return `spared=${report.encounter.outcome.counts.spared}`;
  });
}

/* -------------------------------------------------- 9) 路徑（--root/--works） */

async function testPaths() {
  group('9) 路徑解析（--root / --works / DR_ROOT / DR_WORKS）');

  await test('預設：程式根＝工具所在處、作品根＝程式根', () => {
    const paths = applyCliPaths([]);
    eq(paths.root, DEFAULT_BATTLE_EDITOR, 'root');
    eq(paths.works, paths.root, 'works 預設＝root');
    eq(paths.attacks, join(paths.works, 'attacks'), 'attacks 在作品根下');
    eq(paths.encounters, join(paths.works, 'encounters'), 'encounters 在作品根下');
    eq(paths.samples, join(paths.root, 'samples'), 'samples 永遠在程式根');
    return `${paths.root}（作品根同）`;
  });

  await test('--works 指定作品根：attacks/encounters 換目錄、作品名優先解析', () => {
    const works = mkdtempSync(join(tmpdir(), 'dr-agent-works-'));
    const encDir = join(works, 'encounters');
    mkdirSync(encDir, { recursive: true });
    const file = join(encDir, 'my-enc.json');
    writeFileSync(file, JSON.stringify({ format: 'dr-battle-encounter/1' }), 'utf8');
    try {
      const paths = applyCliPaths(['--works', works]);
      eq(paths.works, works, 'works');
      eq(paths.root, DEFAULT_BATTLE_EDITOR, 'root 不變');
      eq(paths.encounters, encDir, 'encounters 在作品根下');
      eq(resolveInputFile('my-enc'), file, '作品名解析順序：作品根優先');
      return `作品根 ${paths.works}`;
    } finally {
      applyCliPaths([]);
      unlinkSync(file);
      rmdirSync(encDir);
      rmdirSync(works);
    }
  });

  await test('--root 指定程式根（worktree 情境）：引擎路徑跟著換', () => {
    // 用程式根自己當 --root：驗證接受合法程式根，且 samples/engine 都在它下面。
    const paths = applyCliPaths(['--root', DEFAULT_BATTLE_EDITOR]);
    eq(paths.root, DEFAULT_BATTLE_EDITOR, 'root');
    eq(paths.engine, join(DEFAULT_BATTLE_EDITOR, 'engine'), 'engine 跟著 root');
    ok(isFile(join(paths.engine, 'assets.js')), '引擎檔案應存在');
    return 'root 驗證通過（engine/assets.js 存在）';
  });

  await test('DR_ROOT / DR_WORKS 環境變數等價；命令列優先', () => {
    const envOnly = resolvePathOptions([], { DR_ROOT: 'R2', DR_WORKS: 'W2' });
    eq(envOnly.root, 'R2', 'DR_ROOT');
    eq(envOnly.works, 'W2', 'DR_WORKS');
    const cliWins = resolvePathOptions(['--works', 'W1', '--root', 'R1'], { DR_ROOT: 'R2', DR_WORKS: 'W2' });
    eq(cliWins.works, 'W1', '命令列 --works 優先');
    eq(cliWins.root, 'R1', '命令列 --root 優先');
    const empty = resolvePathOptions([], {});
    eq(empty.root, null, '沒有指定時不覆寫');
    eq(empty.works, null, '沒有指定時不覆寫');
    return 'env 與命令列都吃';
  });

  await test('--root 不是程式根 → 明確錯誤（不是靜默用錯引擎）', () => {
    let error = null;
    try {
      configurePaths({ root: join(DEFAULT_BATTLE_EDITOR, '..') });
    } catch (err) {
      error = err;
    } finally {
      applyCliPaths([]);
    }
    ok(error, '應該丟錯');
    ok(/--root/.test(error.message), `錯誤應提到 --root：${error.message}`);
    ok(/engine\/assets\.js|serve\.py|play\.html/.test(error.message), `錯誤應說缺什麼：${error.message}`);
    return '有明確修正指引';
  });

  await test('--works 不存在 → 明確錯誤', () => {
    let error = null;
    try {
      configurePaths({ works: join(tmpdir(), 'dr-agent-works-definitely-missing') });
    } catch (err) {
      error = err;
    } finally {
      applyCliPaths([]);
    }
    ok(error, '應該丟錯');
    ok(/--works/.test(error.message) && /不存在/.test(error.message), `錯誤訊息不清楚：${error.message}`);
    return error.message.slice(0, 48) + '…';
  });
}

/* ------------------------------------------- 10) 素材全部載入訊號（whenIdle） */

async function testAssets() {
  group('10) 素材全部載入訊號（engine/assets.js pendingCount / whenIdle）');
  const { loadAssets } = await import('../../engine/assets.js');

  const dataIndex = (index) => `data:application/json;base64,${Buffer.from(JSON.stringify(index)).toString('base64')}`;

  await test('索引載入失敗：pending=0，whenIdle 立刻 resolve（不會卡住）', async () => {
    const store = await loadAssets('http://127.0.0.1:1/missing-index.json');
    ok(store.error, '應該有 error（拿不到索引）');
    eq(store.pendingCount(), 0, 'pendingCount');
    const idle = await store.whenIdle({ timeoutMs: 500 });
    eq(idle.idle, true, 'idle');
    eq(idle.timedOut, false, 'timedOut');
    ok(idle.snapshot && typeof idle.snapshot.pending === 'number', 'snapshot');
    return `idle、${idle.elapsedMs}ms`;
  });

  await test('preload 後 pending 歸零，whenIdle 回傳統計快照', async () => {
    const index = {
      format: 'dr-battle-assets/1',
      sprites: { a: { path: 'a.png' }, b: { frames: ['b0.png', 'b1.png'] } },
      audio: {},
      fonts: {},
    };
    const store = await loadAssets(dataIndex(index));
    eq(store.error, null, 'data URL 索引不該有 error');
    const images = await store.preload();
    eq(images.length, 3, '3 張影格');
    eq(store.pendingCount(), 0, 'pendingCount 應歸零');
    const stats = store.stats();
    eq(stats.loaded + stats.failed, 3, '每張都要有結果（Node 沒 Image 時全部 failed）');
    const idle = await store.whenIdle({ timeoutMs: 1000 });
    eq(idle.idle, true, 'idle');
    eq(idle.timedOut, false, 'timedOut');
    return `3 張（Node 無 Image → failed）、pending=0`;
  });

  await test('還有載入中時 whenIdle 會等；timeout 到就回 timedOut（永不 reject）', async () => {
    const original = globalThis.Image;
    class NeverImage {
      constructor() {
        this.onload = null;
        this.onerror = null;
      }
      set src(_value) {
        /* 故意永不完成 */
      }
    }
    globalThis.Image = NeverImage;
    try {
      const index = { format: 'dr-battle-assets/1', sprites: { slow: { path: 'slow.png' } }, audio: {}, fonts: {} };
      const store = await loadAssets(dataIndex(index));
      store.preload(); // 不 await：這個 Promise 永遠不會完成
      ok(store.pendingCount() > 0, `preload 後應該仍有 pending，實際 ${store.pendingCount()}`);
      const idle = await store.whenIdle({ timeoutMs: 150 });
      eq(idle.timedOut, true, 'timedOut');
      eq(idle.idle, false, 'idle 應為 false');
      ok(idle.snapshot.pending > 0, 'snapshot.pending 應 > 0');
      return `timeout ${idle.elapsedMs}ms、仍 pending ${idle.snapshot.pending}`;
    } finally {
      globalThis.Image = original;
    }
  });

  await test('whenIdle 可以被連續呼叫（第二次立即回 idle）', async () => {
    const store = await loadAssets(dataIndex({ format: 'dr-battle-assets/1', sprites: {}, audio: {}, fonts: {} }));
    const first = await store.whenIdle({ timeoutMs: 300 });
    const second = await store.whenIdle({ timeoutMs: 300 });
    eq(first.idle, true, '第一次');
    eq(second.idle, true, '第二次');
    eq(second.timedOut, false, 'timedOut');
    return '冪等';
  });
}

/* ------------------------- 11) SPEC-EXPR-V2 同步（拍點 / memory / 新變數） */

/** 把 docs/SPEC-EXPR-V2.md §3 的三個範例寫成暫存攻擊檔（補 meta/party/enemies 與真實 sprite 名）。 */
function writeExprV2Fixtures(dir) {
  const common = {
    format: 'dr-battle-attack/1',
    meta: { name: 'SPEC-EXPR-V2 範例', author: 'V2-03' },
    box: { x: 320, y: 190, w: 150, h: 165 },
    soul: { x: null, y: null, speed: 4, slowSpeed: 2 },
    party: [{ name: 'Kris', hp: 90, maxHp: 90, color: '#00ffff', icon: null }],
    enemies: [{ sprite: 'spr_hathyx_idle', x: 505, y: 196, scale: 2, frameRate: 4 }],
  };
  const rain = {
    ...common,
    settings: { bpm: 120, beatOffset: 0, duration: 8, seed: 1, damage: 8 },
    bulletTypes: { drop: { sprite: 'spr_spadebullet', frameRate: 0, scale: 1, hitbox: { shape: 'circle', r: 5 } } },
    timeline: [
      {
        id: 'ev_rain', at: '0b', type: 'emitter', duration: '16b', interval: '1b', count: 2,
        spawn: {
          bullet: 'drop', x: 'rand(box.left + 8, box.right - 8)', y: 'box.top - 12',
          angle: 90, speed: '2.2 + i*0.5', life: '4b',
        },
      },
      {
        id: 'ev_offbeat', at: '0.5b', type: 'emitter', duration: '15b', interval: '1b', count: 1,
        spawn: {
          bullet: 'drop', x: 'rand(box.left + 8, box.right - 8)', y: 'box.top - 12',
          angle: 90, speed: 3, life: '3b',
        },
      },
    ],
  };
  const mirror = {
    ...common,
    settings: { bpm: 100, beatOffset: 0.1, duration: 6, seed: 2 },
    bulletTypes: {
      bomb: { sprite: 'spr_smallbullet', frameRate: 0, scale: 1.2, hitbox: { shape: 'circle', r: 6 }, faceVelocity: false },
    },
    timeline: [
      {
        id: 'ev_mirror', at: '2b', type: 'spawn', count: 2, bullet: 'bomb',
        x: 'box.x + (i*2 - 1)*70', y: 'box.top + 24', speed: 0, life: '6b',
        pathX: '(soul.x - spawnX) * min(age, 1)',
      },
      {
        id: 'ev_mirror2', at: '4b', type: 'spawn', count: 2, bullet: 'bomb',
        x: 'box.x + (i*2 - 1)*40', y: 'box.bottom - 24', speed: 0, life: '4b',
        pathX: '(soul.x - spawnX) * min(age, 1)',
      },
    ],
  };
  const spin = {
    ...common,
    settings: { bpm: 140, duration: 8, seed: 3, damage: 9 },
    bulletTypes: { orb: { sprite: 'spr_heartbullet', frameRate: 0, scale: 1, hitbox: { shape: 'circle', r: 4 } } },
    timeline: [
      {
        id: 'ev_spin', at: '1b', type: 'emitter', duration: '12b', interval: '3b', count: 4,
        spawn: {
          bullet: 'orb', x: 'box.x', y: 'box.y',
          memory: { a0: 'i*90 + k*20' },
          speed: 1.2, angle: 'mem.a0', angularVel: 6, life: '6b',
          pathX: 'sin(age*200 + mem.a0) * 46',
          pathY: 'cos(age*200 + mem.a0) * 46',
        },
      },
    ],
  };
  const noBpm = {
    ...common,
    settings: { duration: 8, seed: 1 },
    bulletTypes: { drop: { sprite: 'spr_spadebullet', frameRate: 0, scale: 1, hitbox: { shape: 'circle', r: 5 } } },
    timeline: [{ id: 'ev', at: '2b', type: 'spawn', count: 1, bullet: 'drop', speed: 2, life: '4b' }],
  };
  const badMem = {
    ...common,
    settings: { duration: 8, seed: 1, bpm: 120 },
    bulletTypes: { drop: { sprite: 'spr_spadebullet', frameRate: 0, scale: 1, hitbox: { shape: 'circle', r: 5 } } },
    timeline: [
      { id: 'ev', at: 1, type: 'spawn', count: 1, bullet: 'drop', speed: 2, memory: { constructor: '1', a0: 'i*90' } },
    ],
  };
  const files = {};
  for (const [name, data] of Object.entries({ rain, mirror, spin, noBpm, badMem })) {
    const file = join(dir, `${name}.json`);
    writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    files[name] = file;
  }
  return files;
}

async function testExprV2() {
  group('11) SPEC-EXPR-V2 同步（拍點 "2b" / memory / spawnX.spawnT.bpm.beat.mem）');

  const attackSchema = () => readJSON(join(SCHEMA_DIR, 'attack.json'));
  const { validateAttack, normalizeAttack } = await import('../../engine/attack.js');

  await test('schema：settings 有 bpm（number|null、exclusiveMinimum 0）與 beatOffset', () => {
    const schema = attackSchema();
    const settings = schema.properties.settings.properties;
    ok(settings.bpm, '缺 settings.bpm');
    eq(JSON.stringify(settings.bpm.type), JSON.stringify(['number', 'null']), 'bpm.type');
    eq(settings.bpm.exclusiveMinimum, 0, 'bpm.exclusiveMinimum');
    ok('default' in settings.bpm, 'bpm 要有 default');
    ok(settings.beatOffset, '缺 settings.beatOffset');
    ok(settings.beatOffset.type === 'number', 'beatOffset.type');
    eq(settings.beatOffset.default, 0, 'beatOffset.default');
    return 'bpm / beatOffset 都在';
  });

  await test('schema：時間欄位都接受拍點字串（at/duration/interval/life/fade/demo t/settings.duration）', async () => {
    const schema = attackSchema();
    const { parseBeatString } = await import('../../engine/attack.js');
    const hasBeat = (node) => {
      if (!node || !Array.isArray(node.oneOf)) return false;
      return node.oneOf.some((branch) => typeof branch.pattern === 'string' && /b/i.test(branch.pattern));
    };
    const where = {
      'settings.duration': schema.properties.settings.properties.duration,
      'spawn.at': schema.$defs.event_spawn.properties.at,
      'emitter.at': schema.$defs.event_emitter.properties.at,
      'emitter.duration': schema.$defs.event_emitter.properties.duration,
      'emitter.interval': schema.$defs.event_emitter.properties.interval,
      'box.duration': schema.$defs.event_box.properties.duration,
      'clear.fade': schema.$defs.event_clear.properties.fade,
      'shake.duration': schema.$defs.event_shake.properties.duration,
      'spawnFields.life': schema.$defs.spawnFields.properties.life,
      'demo.path[].t': schema.properties.demo.properties.path.items.properties.t,
    };
    const missing = Object.entries(where).filter(([, node]) => !hasBeat(node)).map(([path]) => path);
    eq(missing.length, 0, `這些時間欄位沒放行拍點字串：${missing.join('、')}`);
    // schema 的 pattern 要跟引擎的拍點解析一致（引擎是唯一規則來源）
    const pattern = new RegExp(schema.$defs.event_spawn.properties.at.oneOf.find((b) => b.pattern).pattern);
    for (const sample of ['2b', '1.5b', '.5b', '-0.5b', '2B']) {
      ok(pattern.test(sample), `pattern 應接受 ${sample}`);
      eq(parseBeatString(sample), Number(sample.replace(/b$/i, '')), `引擎 parseBeatString(${sample}) 與 pattern 不一致`);
    }
    for (const sample of ['2', 'beat*4', '2 b', 'b']) ok(!pattern.test(sample), `pattern 不該接受 ${sample}`);
    return `${Object.keys(where).length} 個時間欄位`;
  });

  await test('schema：生成欄位有 memory（物件，值可為數字或運算式）', () => {
    const schema = attackSchema();
    const memory = schema.$defs.spawnFields.properties.memory;
    ok(memory, '缺 spawnFields.memory');
    eq(memory.type, 'object', 'memory.type');
    ok(memory.additionalProperties && Array.isArray(memory.additionalProperties.oneOf), 'memory 的值要允許多種型別');
    const types = memory.additionalProperties.oneOf.map((branch) => branch.type);
    ok(types.includes('number') && types.includes('string'), `memory 值型別：${types.join('/')}`);
    ok(memory.propertyNames && memory.propertyNames.pattern, 'memory 名稱要有 pattern');
    // spawn / emitter.spawn 都看得到 memory（用同一份 spawnProperties）
    ok(schema.$defs.event_spawn.properties.memory, 'spawn 事件缺 memory');
    ok(schema.$defs.event_emitter.properties.spawn.properties.memory, 'emitter.spawn 缺 memory');
    return 'spawn / emitter.spawn 都有';
  });

  await test('schema：6 個新表達式變數都有中文說明（x-expressions 與 cues.json）', () => {
    const names = ['spawnX', 'spawnY', 'spawnT', 'bpm', 'beat', 'mem'];
    const attack = attackSchema();
    const fromAttack = new Map(attack['x-expressions'].variables.map((v) => [v.name, v.desc]));
    const cues = readJSON(join(SCHEMA_DIR, 'cues.json'));
    const fromCues = new Map(cues.expressions.variables.map((v) => [v.name, v.desc]));
    for (const name of names) {
      ok(fromAttack.has(name), `attack schema 缺變數 ${name}`);
      ok(fromAttack.get(name) && fromAttack.get(name).length > 8, `${name} 的說明太短（attack）`);
      ok(fromCues.has(name), `cues.json 缺變數 ${name}`);
      ok(fromCues.get(name) && fromCues.get(name).length > 8, `${name} 的說明太短（cues）`);
    }
    const empty = attack['x-expressions'].variables.filter((v) => !v.desc || v.desc.length === 0).map((v) => v.name);
    eq(empty.length, 0, `這些變數沒有說明：${empty.join('、')}`);
    return `${names.join('/')}，共 ${attack['x-expressions'].variables.length} 個變數`;
  });

  await test('schema：x-defaults.settings 與引擎 SETTINGS_DEFAULTS 的拍點欄位一致', async () => {
    const { SETTINGS_DEFAULTS } = await import('../../engine/attack.js');
    const schema = attackSchema();
    eq(schema['x-defaults'].settings.bpm, SETTINGS_DEFAULTS.bpm, 'x-defaults.settings.bpm');
    eq(schema['x-defaults'].settings.beatOffset, SETTINGS_DEFAULTS.beatOffset, 'x-defaults.settings.beatOffset');
    const settings = schema.properties.settings.properties;
    eq(settings.bpm.default, SETTINGS_DEFAULTS.bpm, 'schema bpm default');
    eq(settings.beatOffset.default, SETTINGS_DEFAULTS.beatOffset, 'schema beatOffset default');
    return `bpm=${SETTINGS_DEFAULTS.bpm}、beatOffset=${SETTINGS_DEFAULTS.beatOffset}`;
  });

  const dir = mkdtempSync(join(tmpdir(), 'dr-agent-exprv2-'));
  const files = writeExprV2Fixtures(dir);
  const checkSamples = join(HERE, '..', 'check-samples.mjs');
  const runCheck = (paths) =>
    spawnSync(process.execPath, [checkSamples, ...paths], { cwd: BATTLE_EDITOR, encoding: 'utf8' });

  try {
    await test('SPEC §3 三個範例：check-samples 不再誤報拍點與 memory', () => {
      const run = runCheck([files.rain, files.mirror, files.spin]);
      eq(run.status, 0, `check-samples 應通過，實際 exit ${run.status}：\n${run.stdout}\n${run.stderr}`);
      ok(/全部通過/.test(run.stdout), `輸出沒有「全部通過」：${run.stdout}`);
      ok(!/警告/.test(run.stdout), `不該有警告：${run.stdout}`);
      return '3 個範例 0 錯誤 0 警告';
    });

    await test('SPEC §3 三個範例：validateAttack 0 錯誤、normalize 給出正確秒數', () => {
      const expect = {
        rain: { at: [0, 0.25], life: [2, 1.5], bpm: 120 }, // bpm 120 → 0.5s/拍；"4b"=2s、"3b"=1.5s
        mirror: { at: [1.3, 2.5], bpm: 100 }, // "2b"=2 × 0.6 + 0.1
        spin: { bpm: 140 },
      };
      for (const [key, want] of Object.entries(expect)) {
        const json = readJSON(files[key]);
        const errors = validateAttack(json);
        eq(errors.length, 0, `${key} 有錯誤：${JSON.stringify(errors.slice(0, 3))}`);
        const runnable = normalizeAttack(json);
        eq(runnable.settings.bpm, want.bpm, `${key} bpm`);
        if (want.at) {
          eq(runnable.timeline.length, want.at.length, `${key} 事件數`);
          runnable.timeline.forEach((ev, i) => {
            within(ev.at, want.at[i] - 1e-9, want.at[i] + 1e-9, `${key} timeline[${i}].at`);
          });
        }
        if (want.life) {
          runnable.timeline.forEach((ev, i) => within(ev.spawn.life, want.life[i] - 1e-9, want.life[i] + 1e-9, `${key} life[${i}]`));
        }
      }
      return '拍點 → 秒、beatOffset 只加在 at';
    });

    await test('SPEC §3 範例：原始 JSON 不被改寫（拍點寫法保留）', () => {
      const text = readFileSync(files.rain, 'utf8');
      const json = JSON.parse(text);
      normalizeAttack(json);
      eq(json.timeline[0].at, '0b', 'normalize 不該改原始 at');
      eq(json.timeline[0].duration, '16b', 'normalize 不該改原始 duration');
      eq(json.timeline[0].spawn.life, '4b', 'normalize 不該改原始 life');
      eq(text, `${JSON.stringify(json, null, 2)}\n`, '原始檔案內容被動到');
      return '原始 JSON 保持 "0b" / "16b" / "4b"';
    });

    await test('負向：沒 bpm 用拍點字串、memory 名稱非法 → check-samples 都抓得到', () => {
      const run = runCheck([files.noBpm, files.badMem]);
      eq(run.status, 1, `應該 exit 1，實際 ${run.status}`);
      const output = `${run.stdout}\n${run.stderr}`;
      ok(/timeline\[0\]\.at.*bpm 未設定/.test(output), `沒抓到沒 bpm 的 at：${output}`);
      ok(/timeline\[0\]\.life.*bpm 未設定/.test(output), `沒抓到沒 bpm 的 life：${output}`);
      ok(/memory\.constructor/.test(output), `沒抓到非法 memory 名稱：${output}`);
      return '3 則錯誤都正確';
    });

    await test('回歸：samples/ 4 個攻擊檔仍然 0 錯誤 0 警告', () => {
      const run = runCheck([]);
      eq(run.status, 0, `check-samples 應通過：\n${run.stdout}\n${run.stderr}`);
      ok(/檢查 4 個攻擊檔/.test(run.stdout), `檢查數量不符：${run.stdout}`);
      ok(!/警告/.test(run.stdout), `不該有警告：${run.stdout}`);
      return '4 個攻擊檔綠';
    });
  } finally {
    for (const file of Object.values(files)) {
      try {
        unlinkSync(file);
      } catch (_err) {
        /* 已不存在 */
      }
    }
    try {
      rmdirSync(dir);
    } catch (_err) {
      /* 目錄非空就留著（TEMP 無害） */
    }
  }
}

/* -------------------------------------------------------------- 6) MCP */

class McpClient {
  constructor(child) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    this.lines.on('line', (line) => {
      const text = line.trim();
      if (!text) return;
      let message = null;
      try {
        message = JSON.parse(text);
      } catch (_err) {
        return;
      }
      if (message.id !== undefined && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(`MCP 錯誤 ${message.error.code}: ${message.error.message}`));
        else entry.resolve(message.result);
      }
    });
    this.stderr = '';
    child.stderr.on('data', (chunk) => {
      this.stderr += chunk.toString('utf8');
    });
  }

  request(method, params, timeoutMs = 60000) {
    const id = this.nextId;
    this.nextId += 1;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP 請求逾時：${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return promise;
  }

  notify(method, params) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async callTool(name, args = {}, timeoutMs = 120000) {
    const result = await this.request('tools/call', { name, arguments: args }, timeoutMs);
    const text = (result.content || [])
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n');
    return { result, text, isError: Boolean(result.isError) };
  }
}

function startMcp(config = {}) {
  const child = spawn(process.execPath, [join(HERE, 'mcp-server.mjs')], {
    cwd: BATTLE_EDITOR,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      DR_MCP_QUIET: config.quiet ? '1' : process.env.DR_MCP_QUIET || '',
      ...(config.offline ? { DR_SERVER_OFFLINE: '1' } : {}),
    },
  });
  return new McpClient(child);
}

async function testMcp() {
  group('6) MCP 伺服器（mcp-server.mjs）');

  let client = null;
  try {
    client = startMcp({ quiet: true });

    await test('initialize 握手', async () => {
      const result = await client.request('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'dr-agent-test', version: '1.0.0' },
      });
      eq(result.protocolVersion, '2024-11-05', 'protocolVersion');
      eq(result.serverInfo.name, 'dr-battle-agent', 'serverInfo.name');
      ok(result.capabilities.tools, '應宣告 tools 能力');
      client.notify('notifications/initialized', {});
      return `${result.serverInfo.name} v${result.serverInfo.version}`;
    });

    await test('tools/list 回傳 16 個工具（SPEC-AGENT §4 全部 + V2-11 dr_record）', async () => {
      const result = await client.request('tools/list', {});
      isArray(result.tools, 'tools');
      const names = result.tools.map((tool) => tool.name);
      const expected = [
        'dr_docs',
        'dr_assets_search',
        'dr_list',
        'dr_read',
        'dr_write',
        'dr_patch',
        'dr_delete',
        'dr_validate',
        'dr_simulate',
        'dr_render',
        'dr_record',
        'dr_difficulty',
        'dr_editor_state',
        'dr_editor_focus',
        'dr_history',
        'dr_restore',
      ];
      for (const name of expected) ok(names.includes(name), `缺少工具 ${name}`);
      eq(names.length, expected.length, '工具數量');
      for (const tool of result.tools) {
        ok(tool.description && tool.description.length > 10, `${tool.name} 缺描述`);
        ok(tool.inputSchema && tool.inputSchema.type === 'object', `${tool.name} 的 inputSchema 不是 object`);
      }
      const record = result.tools.find((tool) => tool.name === 'dr_record');
      for (const key of ['kind', 'name', 'doc', 'autoplay', 'scale', 'out', 'pngDir', 'wav', 'lang', 'seed', 'maxFrames']) {
        ok(record.inputSchema.properties[key], `dr_record 缺少參數 ${key}`);
      }
      return `${names.length} 個`;
    });

    await test('ping', async () => {
      const result = await client.request('ping', {});
      ok(result && typeof result === 'object', 'ping 應回傳物件');
      return 'ok';
    });

    await test('tools/call dr_docs（自我說明）', async () => {
      const listed = await client.callTool('dr_docs', {});
      ok(listed.text.includes('schema-attack'), '文件清單應含 schema-attack');
      const spec = await client.callTool('dr_docs', { doc: 'agent', section: '3' });
      ok(/sim\.mjs|無頭工具/.test(spec.text), 'SPEC-AGENT §3 內容不符');
      const cues = await client.callTool('dr_docs', { schema: 'cues' });
      ok(cues.text.includes('dr-battle-cues/1'), 'cues schema 內容不符');
      return 'list / section / schema 三種模式';
    });

    await test('tools/call dr_validate（sample 攻擊）', async () => {
      const doc = readJSON(join(SAMPLES_DIR, 'spade-rain.json'));
      const { result, text } = await client.callTool('dr_validate', { doc });
      ok(!result.isError, `不應報錯：${text.slice(0, 200)}`);
      const parsed = JSON.parse(text);
      eq(parsed.ok, true, 'validate 應通過');
      eq(parsed.errorCount, 0, '錯誤數應為 0');
      return `ok、${parsed.warningCount} 個警告`;
    });

    await test('tools/call dr_read（sample 檔案）', async () => {
      const { result, text } = await client.callTool('dr_read', { name: 'spade-rain', path: 'samples/spade-rain.json' });
      ok(!result.isError, 'dr_read 不應報錯');
      const parsed = JSON.parse(text);
      ok(parsed.document && parsed.document.timeline, '應回傳完整文件');
      ok(parsed.etag && parsed.etag.length === 64, 'etag 應為 sha256');
      return `timeline ${parsed.document.timeline.length} 個事件`;
    });

    await test('tools/call dr_assets_search（音效）', async () => {
      const { result, text } = await client.callTool('dr_assets_search', { q: 'hurt', kind: 'sfx', limit: 5 });
      ok(!result.isError, '搜尋不應報錯');
      const parsed = JSON.parse(text);
      ok(parsed.count > 0, `應該找到 hurt 相關音效，實際 ${parsed.count}`);
      ok(parsed.items.some((item) => /hurt/i.test(item.name)), '結果沒有 hurt 音效');
      return `${parsed.source === 'api' ? '經 API' : '讀磁碟'}找到 ${parsed.count} 筆`;
    });

    await test('tools/call dr_list', async () => {
      const { result, text } = await client.callTool('dr_list', { kind: 'attack' });
      ok(!result.isError, 'dr_list 不應報錯');
      const parsed = JSON.parse(text);
      ok(parsed.count >= SAMPLES.length, `至少要列出 ${SAMPLES.length} 個範例，實際 ${parsed.count}`);
      return `${parsed.count} 個攻擊`;
    });

    await test('tools/call dr_simulate 帶 autoplay=demo（demo 腳本有效）', async () => {
      const { result, text } = await client.callTool('dr_simulate', { name: 'spade-rain', autoplay: 'demo' });
      ok(!result.isError, `不應報錯：${text.slice(0, 200)}`);
      const parsed = JSON.parse(text);
      eq(parsed.kind, 'attack', 'kind');
      eq(parsed.autoplay.mode, 'demo', 'autoplay.mode');
      eq(parsed.hits, 0, `autoplay demo 應 0 受傷，實際 ${parsed.hits}`);
      return `autoplay demo、hits=${parsed.hits}、${parsed.frames} 幀`;
    });

    await test('tools/call dr_simulate 舊 bot 參數仍相容', async () => {
      const { result, text } = await client.callTool('dr_simulate', { name: 'spade-rain', bot: 'idle' });
      ok(!result.isError, `不應報錯：${text.slice(0, 200)}`);
      const parsed = JSON.parse(text);
      eq(parsed.autoplay.mode, null, '沒有 autoplay 時 autoplay.mode 應為 null');
      ok(parsed.hits > 0, 'idle 基準線應被打（證明舊 bot 路徑還在）');
      return `idle hits=${parsed.hits}`;
    });

    await test('tools/call dr_record 參數缺漏 → 明確錯誤（不開瀏覽器）', async () => {
      const missing = await client.callTool('dr_record', {});
      ok(missing.isError, '沒給 name/doc 應回 isError');
      ok(/name/.test(missing.text) && /doc/.test(missing.text), `錯誤訊息要說明需要 name 或 doc：${missing.text.slice(0, 160)}`);
      const unknown = await client.callTool('dr_record', { name: 'definitely-not-a-work-xyz' });
      ok(unknown.isError, '找不到作品應回 isError');
      ok(/找不到作品/.test(unknown.text), `錯誤訊息應說明找不到作品：${unknown.text.slice(0, 160)}`);
      return '缺參數 / 找不到作品 兩種錯誤都有說明';
    });

    await test('未知工具與未知方法都有正確錯誤處理', async () => {
      const unknownTool = await client.callTool('dr_not_exist', {});
      ok(unknownTool.isError, '未知工具應回 isError');
      let methodError = null;
      try {
        await client.request('nonexistent/method', {});
      } catch (err) {
        methodError = err;
      }
      ok(methodError && /32601/.test(methodError.message), `未知方法應回 -32601，實際 ${methodError ? methodError.message : '沒有錯誤'}`);
      return 'ok';
    });
  } finally {
    if (client) {
      try {
        client.child.stdin.end();
      } catch (_err) {
        /* 已關 */
      }
      setTimeout(() => {
        try {
          client.child.kill();
        } catch (_err) {
          /* 已死 */
        }
      }, 500).unref();
    }
  }
}

/* ------------------------------------------------------- 7) 離線降級 */

async function testOfflineFallback() {
  group('7) 離線降級（伺服器未啟動時直接讀寫磁碟）');

  const name = `ag-selftest-${Date.now().toString(36)}`;
  let client = null;
  try {
    client = startMcp({ quiet: true, offline: true });

    await test('initialize 仍可握手（工具不需要伺服器才能啟動）', async () => {
      const result = await client.request('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'offline-test' } });
      eq(result.serverInfo.name, 'dr-battle-agent', 'serverInfo.name');
      client.notify('notifications/initialized', {});
      return 'ok';
    });

    await test('dr_list 改列磁碟（含 samples/）', async () => {
      const { text } = await client.callTool('dr_list', { kind: 'attack' });
      const parsed = JSON.parse(text);
      eq(parsed.source, 'disk', 'source 應為 disk');
      ok(parsed.count >= SAMPLES.length, `至少要 ${SAMPLES.length} 個，實際 ${parsed.count}`);
      ok(parsed.items.some((item) => item.source === 'sample'), '應標記 sample 來源');
      return `${parsed.count} 個（${parsed.samples} 個範例）`;
    });

    await test('dr_read 讀 sample', async () => {
      const { result, text } = await client.callTool('dr_read', { name: 'spade-rain' });
      ok(!result.isError, 'dr_read 不應報錯');
      const parsed = JSON.parse(text);
      eq(parsed.source, 'disk', 'source');
      ok(parsed.document.format === 'dr-battle-attack/1', 'format');
      eq(parsed.etag.length, 64, 'etag 長度');
      return `etag ${parsed.etag.slice(0, 8)}…`;
    });

    await test('dr_assets_search 改讀 assets/index.json', async () => {
      const { text } = await client.callTool('dr_assets_search', { q: 'graze', kind: 'sfx' });
      const parsed = JSON.parse(text);
      eq(parsed.source, 'disk', 'source');
      ok(parsed.count > 0, '應找到 snd_graze 相關音效');
      return `${parsed.count} 筆`;
    });

    await test('dr_write → dr_read → dr_patch → dr_delete 往返', async () => {
      const doc = {
        format: 'dr-battle-attack/1',
        meta: { name: `自我測試 ${name}`, author: 'test.mjs' },
        settings: { duration: 2, seed: 1, damage: 5 },
        bulletTypes: { dot: { sprite: null, hitbox: { shape: 'circle', r: 4 }, scale: 1 } },
        timeline: [
          { id: 'e1', at: 0.2, type: 'spawn', bullet: 'dot', count: 3, speed: 2, angle: 'i / n * 360' },
          { id: 'e2', at: 1.9, type: 'end' },
        ],
      };
      const written = await client.callTool('dr_write', { kind: 'attack', name, doc });
      ok(!written.isError, `寫入失敗：${written.text.slice(0, 200)}`);
      const writeResult = JSON.parse(written.text);
      eq(writeResult.source, 'disk', 'source');
      ok(writeResult.etag && writeResult.etag.length === 64, '應回傳 etag');

      const readBack = JSON.parse((await client.callTool('dr_read', { kind: 'attack', name })).text);
      eq(readBack.document.settings.duration, 2, '讀回內容不符');

      const patched = await client.callTool('dr_patch', {
        kind: 'attack',
        name,
        patch: [{ op: 'replace', path: '/settings/duration', value: 3 }],
      });
      ok(!patched.isError, `patch 失敗：${patched.text.slice(0, 200)}`);
      const afterPatch = JSON.parse((await client.callTool('dr_read', { kind: 'attack', name })).text);
      eq(afterPatch.document.settings.duration, 3, 'patch 沒生效');

      // 用錯誤的 etag 寫入 → 應回 409
      const conflict = await client.callTool('dr_write', {
        kind: 'attack',
        name,
        doc: { ...doc, settings: { ...doc.settings, duration: 4 } },
        ifMatch: '0'.repeat(64),
      });
      ok(conflict.isError, '錯誤 etag 應回衝突');
      ok(/衝突/.test(conflict.text), `衝突訊息應含「衝突」：${conflict.text.slice(0, 120)}`);

      const deleted = await client.callTool('dr_delete', { kind: 'attack', name });
      ok(!deleted.isError, `刪除失敗：${deleted.text.slice(0, 200)}`);
      const gone = await client.callTool('dr_read', { kind: 'attack', name });
      ok(gone.isError, '刪除後不應讀得到');
      return 'write/read/patch/409/delete 全通';
    });
  } finally {
    if (client) {
      try {
        client.child.stdin.end();
      } catch (_err) {
        /* 已關 */
      }
      setTimeout(() => {
        try {
          client.child.kill();
        } catch (_err) {
          /* 已死 */
        }
      }, 300).unref();
    }
  }
}

/* -------------------------------------------------------------- 8) 渲染 */

async function testRender() {
  group('8) 無頭截圖（render.mjs）');
  const { buildPageUrl, findEdge, framePrecisionWarning, parseFrameList, renderFrames, summarizeFrames } = await import('./render.mjs');

  await test('幀清單解析：逗號、區間（每 30 幀）、去重排序', () => {
    eq(JSON.stringify(parseFrameList('0,60,30')), JSON.stringify([0, 30, 60]), '逗號');
    eq(JSON.stringify(parseFrameList('0-120')), JSON.stringify([0, 30, 60, 90, 120]), '區間');
    eq(JSON.stringify(parseFrameList('90,0,90')), JSON.stringify([0, 90]), '去重排序');
    eq(JSON.stringify(parseFrameList(undefined)), JSON.stringify([0, 30, 60, 90]), '預設值');
    eq(JSON.stringify(parseFrameList('abc')), JSON.stringify([0]), '沒有合法幀時退回 0');
    return 'a-b 每 30 幀';
  });

  await test('幀精確：requested/actual 一致時不警告，結束時報「已結束於第 M 幀」', () => {
    eq(framePrecisionWarning('encounter', 120, 120, { frame: 120 }), null, '一致時不該有警告');
    eq(framePrecisionWarning('attack', 0, 0, { frame: 0, ended: false }), null, '第 0 幀一致');
    const spared = framePrecisionWarning('encounter', 1400, 1016, { frame: 1016, result: 'spared' });
    ok(/已結束於第 1016 幀/.test(spared), `遭遇結束警告：${spared}`);
    ok(/spared/.test(spared), '警告要帶結果');
    const attackEnded = framePrecisionWarning('attack', 200, 150, { frame: 150, ended: true });
    ok(/攻擊已結束於第 150 幀/.test(attackEnded), `攻擊結束警告：${attackEnded}`);
    const stuck = framePrecisionWarning('encounter', 300, 200, { frame: 200, result: null });
    ok(/停止前進/.test(stuck), `卡住警告：${stuck}`);
    const overshoot = framePrecisionWarning('attack', 30, 45, { frame: 45 });
    ok(/實際截到第 45 幀/.test(overshoot), `超過警告：${overshoot}`);
    return '一致 / 結束 / 停止 / 超過 四種情況';
  });

  await test('幀摘要：actualFrames / frameMismatches / duplicateFrames（REALTEST-2 V11）', () => {
    const summary = summarizeFrames([
      { frame: 0, requested: 0, actualFrame: 0 },
      { frame: 100, requested: 100, actualFrame: 100 },
      { frame: 200, requested: 200, actualFrame: 123 },
      { frame: 300, requested: 300, actualFrame: 123 },
    ]);
    eq(JSON.stringify(summary.requestedFrames), '[0,100,200,300]', 'requestedFrames');
    eq(JSON.stringify(summary.actualFrames), '[0,100,123,123]', 'actualFrames');
    eq(JSON.stringify(summary.frameMismatches), '[{"requested":200,"actual":123},{"requested":300,"actual":123}]', 'frameMismatches');
    eq(JSON.stringify(summary.duplicateFrames), '[123]', 'duplicateFrames');
    eq(summarizeFrames(null).actualFrames.length, 0, '空輸入');
    return 'requested [0,100,200,300] → actual [0,100,123,123]';
  });

  await test('parseArgs：未知長旗標會警告（REALTEST-2 V7）；沒給 known 時行為不變', async () => {
    const { parseArgs: parse, unknownFlagMessage } = await import('./lib.mjs');
    const seen = [];
    const args = parse(['work', '--kind', 'encounter', '--scale', '2', '--verify', '--json'], ['scale'], {
      booleanFlags: ['verify'],
      onUnknown: (text) => seen.push(text),
    });
    eq(args.scale, '2', '值旗標');
    eq(args.verify, true, '布林旗標');
    eq(args.kind, true, '未知旗標仍照舊解析成 true');
    eq(JSON.stringify(args._), '["work","encounter"]', '未知旗標的值落到位置參數');
    eq(JSON.stringify(args.__unknown), '["kind"]', '__unknown');
    eq(Object.keys(args).includes('__unknown'), false, '__unknown 不可列舉');
    eq(seen.length, 1, '只警告一次');
    ok(seen[0].includes('--kind'), seen[0]);
    ok(unknownFlagMessage('frame', ['frames', 'out']).includes('--frames'), '相近旗標提示');
    const legacy = parse(['--whatever', 'x']);
    eq(legacy.__unknown, undefined, '沒給 known 不檢查');
    const { VALUE_FLAGS, BOOLEAN_FLAGS, parseRecordArgs } = await import('../record/cli.js');
    ok(VALUE_FLAGS.includes('kind'), 'record.mjs 接受 --kind');
    const rec = [];
    const recArgs = parse(['boss', '--kind', 'encounter', '--bogus'], VALUE_FLAGS, { booleanFlags: BOOLEAN_FLAGS, onUnknown: (t) => rec.push(t) });
    eq(parseRecordArgs(recArgs).kind, 'encounter', 'parseRecordArgs.kind');
    eq(JSON.stringify(recArgs._), '["boss"]', '--kind 會吃掉它的值');
    eq(rec.length, 1, '--bogus 警告');
    return seen[0];
  });

  await test('render URL：遭遇頁也帶 autoplay、攻擊頁帶 owner=page（B20）', () => {
    const params = (url) => new URL(url).searchParams;
    const encounter = buildPageUrl({
      root: 'http://127.0.0.1:1',
      kind: 'encounter',
      targetRel: 'samples/encounters/rudinn.json',
      autoplay: 'demo',
    });
    ok(encounter.startsWith('http://127.0.0.1:1/encounter-play.html?'), `遭遇頁路徑：${encounter}`);
    eq(params(encounter).get('autoplay'), 'demo', '遭遇頁 autoplay');
    eq(params(encounter).get('encounter'), 'samples/encounters/rudinn.json', 'encounter 參數');
    const attack = buildPageUrl({
      root: 'http://127.0.0.1:1',
      kind: 'attack',
      targetRel: 'samples/spade-rain.json',
      autoplay: 'bot',
    });
    eq(params(attack).get('autoplay'), 'bot', '攻擊頁 autoplay');
    eq(params(attack).get('owner'), 'page', '攻擊頁 owner');
    ok(
      !params(buildPageUrl({ root: 'http://127.0.0.1:1', kind: 'encounter', targetRel: 'x.json', autoplay: null })).has('autoplay'),
      '沒開自動演示時不帶 autoplay',
    );
    return 'encounter-play 也帶 ?autoplay=demo|bot';
  });

  const edge = findEdge();
  if (!edge) {
    skip('render 截圖', '找不到 Edge（可用 MSEDGE_PATH 指定）');
    return;
  }

  let outDir = null;
  try {
    await test('攻擊截 2 幀 + 聯絡表（headless Edge + CDP）', async () => {
      const result = await renderFrames(join(SAMPLES_DIR, 'spade-rain.json'), {
        frames: [0, 60],
        scale: 2,
        sheet: true,
        lang: 'zh',
      });
      outDir = result.outDir;
      eq(result.kind, 'attack', 'kind');
      eq(result.frames.length, 2, '截圖數量');
      for (const shot of result.frames) {
        ok(isFile(shot.file), `截圖不存在：${shot.file}`);
        within(statSync(shot.file).size, 5000, 8 * 1024 * 1024, 'PNG 大小');
        eq(shot.size.width, 1280, '寬度應為 640×2');
        eq(shot.size.height, 960, '高度應為 480×2');
      }
      ok(result.frames[1].state.bullets >= 0, '應能讀到引擎狀態');
      ok(isFile(result.sheet), `聯絡表不存在：${result.sheet}`);
      within(statSync(result.sheet).size, 10000, 32 * 1024 * 1024, '聯絡表大小');
      return `2 幀 1280×960、聯絡表 ${result.sheetSize.width}×${result.sheetSize.height}`;
    });

    await test('截圖內容不是全黑（真的畫了東西）', () => {
      const shot = readFileSync(join(outDir, readdirSync(outDir).find((name) => /f0060\.png$/.test(name))));
      ok(shot.length > 20000, `第 60 幀 PNG 太小（${shot.length} bytes），可能沒畫到內容`);
      return `${(shot.length / 1024).toFixed(0)} KB`;
    });

    await test('記憶體中的 doc 也會被真的渲染（不是內建示範攻擊）', async () => {
      // 回歸測試：曾把未存檔的 doc 傳給 renderFrames 時沒落成暫存檔，頁面收到空的 ?attack=
      // → 偷偷渲染 play.html 的內建示範攻擊，Agent 看到的畫面就不是自己的作品。
      const doc = readJSON(join(SAMPLES_DIR, 'spade-rain.json'));
      doc.settings = { ...(doc.settings || {}), duration: 0.5 };
      const result = await renderFrames(doc, { frames: [30], scale: 1, sheet: false });
      try {
        eq(result.kind, 'attack', 'kind');
        eq(result.frames.length, 1, '截圖數量');
        const state = result.frames[0].state || {};
        eq(state.ended, true, '0.5 秒的作品在第 30 幀(1 秒)應該已結束 → 證明渲染的是這份 doc');
        const pageWarning = (result.warnings || []).find((w) => /未指定 \?attack=/.test(w));
        ok(!pageWarning, `頁面退回了內建示範攻擊：${pageWarning}`);
        return 'doc → 暫存檔 → 頁面載入正確';
      } finally {
        try {
          rmSync(result.outDir, { recursive: true, force: true });
        } catch (_err) {
          /* TEMP 留著也無害 */
        }
      }
    });
  } finally {
    if (outDir) {
      try {
        rmSync(outDir, { recursive: true, force: true });
      } catch (_err) {
        /* TEMP 留著也無害 */
      }
    }
  }
}

/* ---------------------------------------------------------------- 主流程 */

async function main() {
  const args = parseArgs(process.argv.slice(2), []);
  verbose = Boolean(args.verbose);
  const skipRender = Boolean(args['skip-render']);
  const skipMcp = Boolean(args['skip-mcp']);

  console.log('DR Battle Editor — Agent 工具自我測試');
  console.log(`專案：${BATTLE_EDITOR}`);
  console.log(`Node：${process.version}`);

  const started = Date.now();

  await testSchema();
  await testValidate();
  await testSimulate();
  await testBot();
  await testDifficulty();
  await testPaths();
  await testAssets();
  await testExprV2();
  if (skipMcp) skip('MCP 協定往返', '--skip-mcp');
  else await testMcp();
  if (skipMcp) skip('離線降級', '--skip-mcp');
  else await testOfflineFallback();
  if (skipRender) skip('render 截圖', '--skip-render');
  else await testRender();

  const passed = results.filter((item) => item.ok && !item.skipped).length;
  const skipped = results.filter((item) => item.skipped).length;
  const failed = results.filter((item) => !item.ok);
  const ms = Date.now() - started;

  console.log(`\n${'─'.repeat(56)}`);
  console.log(`結果：${passed} 通過、${failed.length} 失敗、${skipped} 跳過（${(ms / 1000).toFixed(1)}s）`);
  if (failed.length > 0) {
    console.log('\n失敗項目：');
    for (const item of failed) {
      console.log(`  ✗ [${item.group}] ${item.name}`);
      console.log(`    ${String(item.error).split('\n').slice(0, 4).join('\n    ')}`);
    }
    process.exitCode = 1;
  } else {
    console.log('全部通過 ✓');
  }
  if (skipped > 0) {
    console.log(`跳過：${results.filter((item) => item.skipped).map((item) => item.name).join('、')}`);
  }
}

if (cliEntry(import.meta.url)) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}

export default main;
