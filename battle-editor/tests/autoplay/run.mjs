/**
 * tests/autoplay/run.mjs — 自動演示（SPEC-AUTOPLAY）測試入口
 *
 * 執行：cd battle-editor && node tests/autoplay/run.mjs
 *
 * 範圍（AP1：攻擊層）：
 *   1) 輸入編碼 / 解碼往返（§2.1 行程長度編碼）
 *   2) 路徑跟隨：4 個攻擊範例的 demo.path 不越框、不瞬移、跑到終點附近
 *   3) 錄製 → 重播：用 bot 跑一段並錄製，用 demo.inputs 重播，逐幀座標與受傷數完全相同
 *   4) 沒有 demo 時引擎行為不變（demo 欄位對引擎 inert）
 *   5) 驗證錯誤路徑（demo.path[2].t 這種）
 *   6) createAutopilot / createRecorder 對外契約
 *
 * 風格比照 tests/engine/run.mjs：極簡 runner、無外部依賴。
 */

import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SAMPLES = ['spade-rain', 'ring-burst', 'box-shrink-aim', 'sine-wave'];

/* ------------------------------------------------------------ 小 runner */

const queue = [];
const results = { pass: 0, fail: 0, notes: 0, skipped: 0 };
const failures = [];
const started = Date.now();
let currentGroup = '（未分組）';

function group(name) {
  queue.push({ kind: 'group', name });
}

function test(name, fn) {
  queue.push({ kind: 'test', name, fn, group: currentGroup });
}

function skip(name, reason = '') {
  results.skipped += 1;
  console.log(`○ ${name}${reason ? ` — ${reason}` : ''}`);
}

function ok(cond, message = '條件不成立') {
  if (!cond) throw new Error(message);
}

function eq(actual, expected, message = '') {
  if (actual !== expected) {
    throw new Error(`${message || '值不相等'}（實際 ${JSON.stringify(actual)}，預期 ${JSON.stringify(expected)}）`);
  }
}

function approx(actual, expected, eps = 1e-6, message = '') {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > eps) {
    throw new Error(`${message || '數值差距過大'}（實際 ${actual}，預期 ${expected}，誤差上限 ${eps}）`);
  }
}

function isArray(value, message = '應為陣列') {
  if (!Array.isArray(value)) throw new Error(`${message}（實際 ${typeof value}）`);
}

function isObj(value, message = '應為物件') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${message}（實際 ${value}）`);
}

function deepEq(actual, expected, message = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message || '深度比較不相等'}\n    實際：${clip(a)}\n    預期：${clip(b)}`);
  }
}

function clip(text, max = 400) {
  return String(text).length > max ? `${String(text).slice(0, max)}…` : String(text);
}

function readSample(name) {
  return JSON.parse(readFileSync(join(ROOT, 'samples', `${name}.json`), 'utf8'));
}

/** 暫時目錄（路徑產生 / CLI 測試用；不寫 samples）。 */
let tempRoot = null;
function tempFile(name) {
  if (!tempRoot) tempRoot = mkdtempSync(join(tmpdir(), 'battle-editor-autoplay-'));
  return join(tempRoot, name);
}

/** 複製 sample 到暫存目錄（CLI 測試要在副本上 --write，不能動 samples/）。 */
function sampleCopy(name) {
  const file = tempFile(`${name}-copy.json`);
  copyFileSync(join(ROOT, 'samples', `${name}.json`), file);
  return { doc: readSample(name), file };
}

/** 複製一份攻擊檔並拿掉 demo（用來驗證 demo 對引擎 inert）。 */
function withoutDemo(doc) {
  const copy = JSON.parse(JSON.stringify(doc));
  delete copy.demo;
  return copy;
}

/**
 * V2-FIX1：拍點測試用的最小攻擊檔（空 timeline；bpm 120 → "16b" = 8 秒、1b = 0.5 秒）。
 * settings 可覆寫（例如刪掉 bpm 驗證退回舊行為）。
 */
function beatDoc(settings = {}) {
  return {
    format: 'dr-battle-attack/1',
    meta: { name: 'beat-probe' },
    settings: { bpm: 120, duration: '16b', seed: 1, damage: 1, ...settings },
    box: { x: 320, y: 190, w: 150, h: 165 },
    timeline: [],
    soul: { x: 320, y: 190 },
  };
}

/* ------------------------------------------------------------ 共用工具 */

const engine = await import('../../engine/index.js');
const botMod = await import('../../engine/autoplay/bot.js');
const soulMod = await import('../../engine/autoplay/soul.js');
const autoplay = await import('../../engine/autoplay/index.js');
const validateMod = await import('../../engine/autoplay/validate.js');
const traceMod = await import('../../engine/autoplay/trace.js');
const pathgenMod = await import('../../engine/autoplay/pathgen.js');

const { createBattle } = engine;
const { inputToDirection, clampToBox, createBot, directionToInput } = botMod;
const { createSoulPilot } = soulMod;
const { createAutopilot, createRecorder, encodeInputs, decodeInputs } = autoplay;
const { validateAttackDemo, validateEncounterDemo } = validateMod;
const { traceDemo, deviationStats, summarizeTrace } = traceMod;
const { generateDemoPath, createReplayEngine, replayPath, compactPath, expandPath } = pathgenMod;

/** 用 pilot 跑完一輪，回傳逐幀紀錄。 */
function runWithPilot(doc, { mode = 'demo', demo = doc.demo } = {}) {
  const battle = createBattle({ canvas: null, assets: null, mode: 'play' });
  battle.load(doc);
  const pilot = createSoulPilot({ demo, mode });
  const sim = battle.engine;
  const frames = [];
  let hits = 0;
  battle.on('hit', () => {
    hits += 1;
  });
  const total = sim.durationFrames();
  let frame = 0;
  for (; frame < total; frame += 1) {
    const state = battle.getState();
    frames.push({
      frame: state.frame,
      x: state.soul.x,
      y: state.soul.y,
      box: { x: state.box.x, y: state.box.y, w: state.box.w, h: state.box.h, rotation: state.box.rotation },
    });
    sim.stepFrame(inputToDirection(pilot.input(state, frame)));
    if (battle.getState().ended) break;
  }
  const lastState = battle.getState();
  battle.destroy();
  return { frames, hits, pilot, lastState, frame };
}

/** 用固定（或沒有）輸入跑完一輪，回傳每幀快照（驗證 inert 用）。 */
function runRaw(doc, input = { dx: 0, dy: 0, slow: false }) {
  const battle = createBattle({ canvas: null, assets: null, mode: 'play' });
  battle.load(doc);
  const sim = battle.engine;
  const snapshots = [];
  const total = sim.durationFrames();
  for (let frame = 0; frame < total; frame += 1) {
    const state = battle.getState();
    snapshots.push(snapshotOf(state));
    sim.stepFrame(input);
    if (battle.getState().ended) break;
  }
  snapshots.push(snapshotOf(battle.getState()));
  battle.destroy();
  return snapshots;
}

/** 框變形（移動 / 縮放 / 旋轉）時，框內座標最多被帶動多少（測試用容差）。 */
function boxCornerShift(a, b) {
  const halfA = Math.hypot(a.w / 2, a.h / 2);
  const halfB = Math.hypot(b.w / 2, b.h / 2);
  return Math.hypot(b.x - a.x, b.y - a.y) + Math.abs(halfB - halfA);
}

function snapshotOf(state) {  return {
    frame: state.frame,
    ended: state.ended,
    soul: [state.soul.x, state.soul.y, state.soul.mode],
    box: [state.box.x, state.box.y, state.box.w, state.box.h, state.box.rotation],
    hp: state.party.map((p) => p.hp),
    tp: state.tp,
    bullets: state.bullets.map((b) => [b.x, b.y, b.angle, b.speed]),
  };
}

/* ============================================================ 測試註冊 */

/* ---------------------------------------------- 1) 輸入編碼 / 解碼 */

group('1) 輸入編碼 / 解碼（SPEC §2.1 行程長度編碼）');

test('encodeInputs 產生 SPEC 範例的字串', () => {
  const text = encodeInputs([
    { frame: 0, hold: {} },
    { frame: 12, hold: { right: true } },
    { frame: 30, hold: { right: true, down: true } },
    { frame: 45, hold: {} },
  ]);
  eq(text, '0:;12:R;30:RD;45:');
  return text;
});

test('單次按下用 !z / !x / !c 表示', () => {
  eq(encodeInputs([{ frame: 120, hold: { right: true }, press: ['confirm'] }]), '120:R!z');
  eq(encodeInputs([{ frame: 5, hold: {}, press: ['cancel', 'menu'] }]), '5:!x!c');
  // 動作名稱接受 z/x/c 與 confirm/cancel/menu 兩種寫法
  eq(encodeInputs([{ frame: 7, hold: {}, press: ['z'] }]), '7:!z');
  return '!z / !x / !c';
});

test('slow 鍵是 S、鍵序固定 L R U D S', () => {
  eq(
    encodeInputs([{ frame: 3, hold: { down: true, left: true, slow: true, up: true, right: true } }]),
    '3:LRUDS',
  );
  return 'LRUDS';
});

test('重複的按住段落會被省略（行程長度編碼）', () => {
  eq(
    encodeInputs([
      { frame: 10, hold: { right: true } },
      { frame: 11, hold: { right: true } },
      { frame: 12, hold: { right: true } },
      { frame: 20, hold: {} },
    ]),
    '10:R;20:',
  );
  return '11、12 省略';
});

test('decodeInputs 解析出逐段輸入（幀遞增）', () => {
  const entries = decodeInputs('0:;12:R;30:RD!z;45:');
  eq(entries.length, 4);
  eq(entries[2].frame, 30);
  deepEq(entries[2].hold, { right: true, down: true });
  deepEq(entries[2].press, ['confirm']);
  deepEq(entries[0].hold, {});
  return '4 段';
});

test('編碼 → 解碼 → 編碼往返穩定', () => {
  const inputs = [
    '0:;12:R;30:RD;45:D;60:DS;90:',
    '120:R!z',
    '0:LU;9:RDS!x;17:',
    '5:LRUDS!z!x!c;6:',
  ];
  for (const text of inputs) {
    const once = encodeInputs(decodeInputs(text));
    eq(once, text, `往返不一致：${text}`);
    eq(encodeInputs(decodeInputs(once)), once, `二次往返不一致：${text}`);
  }
  return `${inputs.length} 組`;
});

test('寬鬆解析：壞段被記錄但不丟例外', () => {
  const { parseEncodedInputs } = soulMod;
  const parsed = parseEncodedInputs('0:;12:Q;30:RD;x:R;45');
  eq(parsed.entries.length, 2, '可解析的段數');
  ok(parsed.errors.length >= 3, `應回報多個錯誤（實際 ${parsed.errors.length}）`);
  ok(parsed.errors.some((e) => /未知的鍵字母/.test(e.message)), '應指出未知鍵字母');
  ok(parsed.errors.some((e) => /幀號/.test(e.message)), '應指出幀號問題');
  ok(parsed.errors.some((e) => /缺少「幀:」/.test(e.message)), '應指出缺少前綴');
  eq(decodeInputs('').length, 0, '空字串 → 0 段');
  eq(decodeInputs(null).length, 0, 'null → 0 段');
  return `${parsed.errors.length} 個錯誤`;
});

/* ---------------------------------------------- 2) 路徑跟隨 */

group('2) 靈魂路徑跟隨（4 個攻擊範例的 demo.path）');

for (const name of SAMPLES) {
  test(`${name}：path 模式跑完全程、不越框、不瞬移、最後接近終點`, () => {
    const doc = readSample(name);
    isObj(doc.demo, `${name} 應該有 demo`);
    eq(doc.demo.mode, 'path', `${name} demo.mode`);
    isArray(doc.demo.path, `${name} demo.path`);

    const run = runWithPilot(doc);
    eq(run.pilot.mode, 'path', '解析後的模式');
    eq(run.pilot.warnings.length, 0, `不該有警告：${run.pilot.warnings.join(' / ')}`);
    ok(run.frames.length > 100, `幀數太少：${run.frames.length}`);

    // 每幀都在框內（允許浮點誤差）且位移不超過一步速度
    // （框會移動/縮放 → 夾回框內時靈魂會被帶著走，所以容許再加上框四個角的位移）
    const speed = doc.soul.speed;
    let maxOut = 0;
    let maxStep = 0;
    let previous = null;
    for (const frame of run.frames) {
      const clamped = clampToBox(frame.x, frame.y, frame.box, 0);
      maxOut = Math.max(maxOut, Math.hypot(clamped.x - frame.x, clamped.y - frame.y));
      if (previous) {
        const step = Math.hypot(frame.x - previous.x, frame.y - previous.y);
        maxStep = Math.max(maxStep, step - boxCornerShift(previous.box, frame.box));
      }
      previous = frame;
    }
    ok(maxOut < 1e-6, `靈魂跑到框外（最大超出 ${maxOut.toFixed(3)}）`);
    ok(maxStep <= speed + 0.01, `單幀位移 ${maxStep.toFixed(3)} 超過速度 ${speed}（瞬移？）`);

    // 最後接近最後一個路徑點（夾回框內後的座標）
    const last = doc.demo.path[doc.demo.path.length - 1];
    const target = clampToBox(last.x, last.y, run.lastState.box, 4);
    const endDistance = Math.hypot(run.lastState.soul.x - target.x, run.lastState.soul.y - target.y);
    ok(endDistance < 12, `終點距離 ${endDistance.toFixed(2)} 太遠（最後一點 ${last.x},${last.y}）`);

    return `受傷 ${run.hits}、終點距離 ${endDistance.toFixed(1)}px、單幀位移 ≤ ${maxStep.toFixed(2)}`;
  });
}

test('4 個攻擊範例的 demo 都不受傷（≤ 1 次）', () => {
  const summary = [];
  for (const name of SAMPLES) {
    const doc = readSample(name);
    const run = runWithPilot(doc);
    ok(run.hits <= 1, `${name} 受傷 ${run.hits} 次（規格要求 ≤ 1）`);
    summary.push(`${name} ${run.hits}`);
  }
  return summary.join('、');
});

test('path 跟隨：到點後不按方向鍵（接近目標時可按住 slow 微調）', () => {
  const doc = readSample('spade-rain');
  const pilot = createSoulPilot({ demo: doc.demo, mode: 'path' });
  const state = {
    frame: 0,
    soul: { x: 320, y: 190 },
    box: { x: 320, y: 190, w: 150, h: 165, rotation: 0 },
    attack: doc,
    bullets: [],
  };
  // t = 0 時目標就是 (320,190)，距離 0 → 不按任何方向鍵。
  // 新跟隨器在接近目標時會用 slow（Shift）微調，所以只驗方向鍵為空。
  const input = pilot.input(state, 0);
  eq(input.hold.left, undefined, '距離 0 時不該按左');
  eq(input.hold.right, undefined, '距離 0 時不該按右');
  eq(input.hold.up, undefined, '距離 0 時不該按上');
  eq(input.hold.down, undefined, '距離 0 時不該按下');
  isArray(input.press, 'press 應為陣列');
  // slow 段（t=8.7 起的點標了 slow）→ 接近目標時要按 Shift 微調
  const slowFrame = Math.round(8.7 * 30) + 2;
  const slowState = {
    ...state,
    frame: slowFrame,
    soul: { x: 376, y: 260 },
  };
  const slowInput = pilot.input(slowState, slowFrame);
  eq(slowInput.hold.slow, true, 'slow 段接近目標時應按住 slow');
  return '距離 0 → 無方向鍵、slow 段 → S';
});

test('path 跟隨：落後時往目標方向追（8 方向）', () => {
  const doc = readSample('spade-rain');
  const pilot = createSoulPilot({ demo: doc.demo, mode: 'path' });
  // 在第 2 點附近（t≈4.2 目標 392,268），把靈魂放在框內左下角 → 應往右下按
  const state = {
    frame: Math.round(4.2 * 30),
    soul: { x: 260, y: 140 },
    box: { x: 320, y: 190, w: 150, h: 165, rotation: 0 },
    attack: doc,
    bullets: [],
  };
  const input = pilot.input(state, state.frame);
  eq(input.hold.right, true, '應往右');
  eq(input.hold.down, true, '應往下');
  eq(input.hold.left, undefined, '不該往左');
  eq(input.hold.up, undefined, '不該往上');
  return 'right + down';
});

/* ---------------------------------------------- 3) 錄製 → 重播決定性 */

group('3) 錄製 → 重播決定性');

test('bot 跑 spade-rain：錄製 → inputs 重播，逐幀座標與受傷數完全相同', () => {
  const doc = readSample('spade-rain');

  /* --- 錄製：bot 決策逐幀 push --- */
  const battle = createBattle({ canvas: null, assets: null, mode: 'play' });
  battle.load(doc);
  const bot = createBot({ bot: 'dodge', seed: 1, horizon: 14 });
  const recorder = createRecorder();
  const sim = battle.engine;
  const recorded = [];
  let recordedHits = 0;
  battle.on('hit', () => {
    recordedHits += 1;
  });
  const total = sim.durationFrames();
  for (let frame = 0; frame < total; frame += 1) {
    const state = battle.getState();
    recorded.push([state.soul.x, state.soul.y]);
    const dir = bot.decide(state);
    recorder.push(frame, directionToInput(dir));
    sim.stepFrame(dir);
    if (battle.getState().ended) break;
  }
  battle.destroy();
  ok(recorder.size > 20, `錄到的變化段太少：${recorder.size}`);
  const encoded = recorder.toString();
  ok(encoded.length > 0, '錄製結果不該是空字串');

  /* --- 重播：demo.inputs 驅動 --- */
  const replayBattle = createBattle({ canvas: null, assets: null, mode: 'play' });
  replayBattle.load(doc);
  const pilot = createSoulPilot({ demo: { mode: 'inputs', inputs: encoded }, mode: 'inputs' });
  eq(pilot.mode, 'inputs', '重播模式');
  const replaySim = replayBattle.engine;
  let replayHits = 0;
  replayBattle.on('hit', () => {
    replayHits += 1;
  });
  let mismatches = 0;
  let firstMismatch = null;
  for (let frame = 0; frame < recorded.length; frame += 1) {
    const state = replayBattle.getState();
    if (state.soul.x !== recorded[frame][0] || state.soul.y !== recorded[frame][1]) {
      mismatches += 1;
      if (firstMismatch === null) {
        firstMismatch = { frame, replay: [state.soul.x, state.soul.y], recorded: recorded[frame] };
      }
    }
    replaySim.stepFrame(inputToDirection(pilot.input(state, frame)));
    if (replayBattle.getState().ended) break;
  }
  replayBattle.destroy();

  eq(mismatches, 0, `重播座標不一致 ${mismatches} 幀（第一處 ${JSON.stringify(firstMismatch)}）`);
  eq(replayHits, recordedHits, `受傷數不同（錄製 ${recordedHits}、重播 ${replayHits}）`);
  return `錄製 ${recorder.size} 段、${recorded.length} 幀、受傷 ${recordedHits}`;
});

test('同一次錄製的 toString() 穩定（可重複呼叫）', () => {
  const recorder = createRecorder();
  recorder.push(0, { dx: 1, dy: 0 });
  recorder.push(1, { dx: 1, dy: 0 });
  recorder.push(2, { dx: 0, dy: 1, slow: true });
  const first = recorder.toString();
  const second = recorder.toString();
  eq(first, second, 'toString 應穩定');
  eq(first, '0:R;2:DS;3:', '內容（結尾補一段放開）');
  // 清掉後再錄，結果一致
  recorder.reset();
  recorder.push(0, { dx: 1, dy: 0 });
  recorder.push(1, { dx: 1, dy: 0 });
  recorder.push(2, { dx: 0, dy: 1, slow: true });
  eq(recorder.toString(), first, 'reset 後重錄應一致');
  return first;
});

test('錄製結尾若仍按住鍵，會補一段「放開」讓重播不黏鍵', () => {
  const recorder = createRecorder();
  recorder.push(0, { hold: { right: true } });
  recorder.push(1, { hold: { right: true } });
  const text = recorder.toString();
  eq(text, '0:R;2:', '結尾應補 2:');
  const entries = decodeInputs(text);
  deepEq(entries[entries.length - 1].hold, {}, '最後一段應為放開');
  return text;
});

/* ---------------------------------------------- 4) demo 對引擎 inert */

group('4) 沒有 demo 時引擎行為不變（demo 欄位對引擎 inert）');

for (const name of SAMPLES) {
  test(`${name}：有 demo / 沒有 demo 的逐步快照完全相同`, () => {
    const doc = readSample(name);
    const withDemo = runRaw(doc);
    const noDemo = runRaw(withoutDemo(doc));
    eq(noDemo.length, withDemo.length, '幀數應相同');
    for (let i = 0; i < withDemo.length; i += 1) {
      deepEq(noDemo[i], withDemo[i], `第 ${i} 幀不同`);
    }
    // 沒有 demo 也不會多出任何狀態欄位
    const state = withDemo[0];
    ok(!('demo' in state), 'getState() 不該有 demo 欄位');
    return `${withDemo.length} 幀相同`;
  });
}

test('demo 裡的壞路徑不會影響引擎（只有驗證器會抱怨）', () => {
  const doc = readSample('ring-burst');
  doc.demo = { mode: 'path', path: [] };
  const run = runRaw(doc);
  ok(run.length > 50, '引擎仍應照常跑完');
  ok(run[0].soul.length === 3, '狀態形狀不變');
  return `${run.length} 幀`;
});

/* ---------------------------------------------- 5) 驗證錯誤路徑 */

group('5) demo 驗證（validateAttackDemo / validateAttack 接線）');

test('沒有 demo / 合法 demo → 0 錯誤', () => {
  eq(validateAttackDemo(undefined).length, 0, 'undefined');
  eq(validateAttackDemo(null).length, 0, 'null');
  for (const name of SAMPLES) {
    const doc = readSample(name);
    const errors = validateAttackDemo(doc.demo);
    eq(errors.length, 0, `${name} demo 應合法：${JSON.stringify(errors.slice(0, 3))}`);
  }
  return '4 個範例';
});

test('錯誤路徑格式與 attack.js 一致（demo.path[2].t）', () => {
  const demo = {
    mode: 'path',
    path: [
      { t: 0, x: 320, y: 190 },
      { t: 1, x: 300, y: 200 },
      { t: -1, x: 'x', y: 210 },
    ],
  };
  const errors = validateAttackDemo(demo);
  ok(errors.length >= 2, `應回報多個錯誤（實際 ${errors.length}）`);
  const byPath = new Map(errors.map((e) => [e.path, e.message]));
  ok(byPath.has('demo.path[2].t'), `應有 demo.path[2].t（實際 ${[...byPath.keys()].join(', ')}）`);
  ok(byPath.has('demo.path[2].x'), '應有 demo.path[2].x');
  ok(/負數/.test(byPath.get('demo.path[2].t')), 't 錯誤訊息應提到負數');
  return [...byPath.keys()].join(', ');
});

test('mode / fallback / inputs / 未知欄位都有正確路徑', () => {
  const cases = [
    [{ mode: 'nope' }, 'demo.mode'],
    [{ fallback: 'wait' }, 'demo.fallback'],
    [{ inputs: 42 }, 'demo.inputs'],
    [{ inputs: '12:Q' }, 'demo.inputs'],
    [{ path: 'not-array' }, 'demo.path'],
    [{ path: [] }, 'demo.path'],
    [{ path: [{ t: 0, x: 1, y: 2, speed: 3 }] }, 'demo.path[0].speed'],
    [{ trippy: true }, 'demo.trippy'],
  ];
  for (const [demo, expectedPath] of cases) {
    const errors = validateAttackDemo(demo);
    ok(
      errors.some((e) => e.path === expectedPath),
      `期待路徑 ${expectedPath}，實際 ${JSON.stringify(errors.map((e) => e.path))}`,
    );
  }
  // mode 指 path 但沒有 path → 錯誤落在 demo.mode
  ok(
    validateAttackDemo({ mode: 'path' }).some((e) => e.path === 'demo.mode'),
    'mode=path 但沒有 path 應報錯',
  );
  // 非物件
  eq(validateAttackDemo('x')[0].path, 'demo', '非物件 → demo');
  return `${cases.length} 種`;
});

test('validateAttack 併入 demo 錯誤（實際接線）', async () => {
  const { validateAttack } = await import('../../engine/attack.js');
  const doc = readSample('spade-rain');
  doc.demo = { mode: 'path', path: [{ t: 0, x: 320, y: 190 }, { t: 2, x: 300, y: 'bad' }] };
  const errors = validateAttack(doc);
  ok(
    errors.some((e) => e.path === 'demo.path[1].y'),
    `validateAttack 應帶出 demo.path[1].y（實際 ${JSON.stringify(errors.filter((e) => e.path.startsWith('demo')).slice(0, 3))}）`,
  );
  // 驗證器自己丟例外時也不能讓 validateAttack 拋
  const weird = readSample('spade-rain');
  weird.demo = {
    get mode() {
      throw new Error('boom');
    },
  };
  const thrown = validateAttack(weird);
  ok(Array.isArray(thrown), '仍應回傳陣列');
  ok(thrown.some((e) => e.path === 'demo'), '例外應轉成 demo 錯誤');
  return 'demo.path[1].y';
});

test('validateEncounterDemo 佔位匯出存在（AP2 補實作）', () => {
  ok(typeof validateEncounterDemo === 'function', '應匯出函式（AP2 會補實作）');
  const out = validateEncounterDemo(undefined, undefined);
  isArray(out, '回傳陣列');
  return '函式存在';
});

/* ---------------------------------------------- 6) 對外契約 */

group('6) createAutopilot / createRecorder 對外契約（SPEC §3）');

test('createAutopilot({kind:"attack"}) 用作品 demo，describe() 形狀正確', () => {
  const doc = readSample('spade-rain');
  const pilot = createAutopilot({ kind: 'attack', doc, mode: 'demo' });
  eq(pilot.mode, 'demo');
  isArray(pilot.warnings);
  const described = pilot.describe();
  isObj(described, 'describe 應回傳物件');
  eq(described.mode, 'demo');
  eq(described.dodge, 'path');
  eq(described.turn, null);
  eq(typeof described.step, 'number');

  const battle = createBattle({ canvas: null, assets: null, mode: 'play' });
  battle.load(doc);
  const input = pilot.input(battle.getState(), 0);
  // 引擎輸入格式：{ press: string[], hold: object }
  isArray(input.press, 'press 應為陣列');
  isObj(input.hold, 'hold 應為物件');
  for (const key of Object.keys(input.hold)) {
    ok(['left', 'right', 'up', 'down', 'slow'].includes(key), `hold 有未知鍵 ${key}`);
  }
  battle.destroy();
  pilot.reset();
  eq(pilot.describe().step, 0, 'reset 後 step 歸零');
  return `dodge=${described.dodge}`;
});

test('mode:"bot" 忽略腳本、全程 AI', () => {
  const doc = readSample('spade-rain');
  const pilot = createAutopilot({ kind: 'attack', doc, mode: 'bot' });
  eq(pilot.mode, 'bot');
  eq(pilot.describe().dodge, 'bot');
  eq(pilot.describe().mode, 'bot');
  const state = {
    frame: 0,
    soul: { x: 320, y: 190 },
    box: { x: 320, y: 190, w: 150, h: 165, rotation: 0 },
    attack: doc,
    bullets: [{ x: 330, y: 200, speed: 2, angle: 180, accel: 0, angularVel: 0, hitbox: { shape: 'circle', r: 5 }, pathX: null }],
  };
  const input = pilot.input(state, 0);
  isArray(input.press, 'press 應為陣列');
  isObj(input.hold, 'hold 應為物件');
  return 'bot';
});

test('沒有 demo 的攻擊檔 → 退化為 bot（不丟例外）', () => {
  const doc = withoutDemo(readSample('sine-wave'));
  const pilot = createAutopilot({ kind: 'attack', doc, mode: 'demo' });
  eq(pilot.describe().dodge, 'bot');
  eq(pilot.warnings.length, 0, '沒有 demo 不該有警告');
  const state = {
    frame: 0,
    soul: { x: 320, y: 190 },
    box: { x: 320, y: 190, w: 150, h: 165, rotation: 0 },
    attack: doc,
    bullets: [],
  };
  const input = pilot.input(state, 0);
  isObj(input.hold, 'hold 應為物件');
  return 'bot';
});

test('createAutopilot({kind:"encounter"}) 永不丟例外（encounter.js 由 AP2 提供）', async () => {
  const pilot = createAutopilot({ kind: 'encounter', doc: { demo: { turns: [] } }, mode: 'demo' });
  eq(pilot.kind, 'encounter');
  const ready = await pilot.ready;
  ok(typeof ready === 'boolean', `ready 應解析成布林（實際 ${typeof ready}）`);
  const described = pilot.describe();
  isObj(described, 'describe 應回傳物件');
  const input = pilot.input({}, 0);
  isArray(input.press, 'press 應為陣列');
  isObj(input.hold, 'hold 應為物件');
  return ready ? 'encounter pilot 就緒' : `退化（${pilot.warnings.length} 個警告）`;
});

test('pilot.input 對壞 state 不丟例外（回中性輸入）', () => {
  const doc = readSample('spade-rain');
  const pilot = createAutopilot({ kind: 'attack', doc });
  for (const state of [null, undefined, {}, { soul: null }]) {
    const input = pilot.input(state, 5);
    isArray(input.press, 'press 應為陣列');
    isObj(input.hold, 'hold 應為物件');
  }
  return '4 種壞 state';
});

test('engine/autoplay 的模組沒有 Node 專屬 import（瀏覽器可用）', () => {
  const files = ['bot.js', 'soul.js', 'index.js', 'validate.js', 'follow.js', 'trace.js', 'pathgen.js'].map(
    (name) => join(ROOT, 'engine', 'autoplay', name),
  );
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    ok(!/from\s+['"]node:/.test(text), `${file} 不該 import node: 模組`);
    ok(!/\brequire\s*\(/.test(text), `${file} 不該用 require()`);
    ok(!/process\./.test(text), `${file} 不該用 process`);
  }
  return `${files.length} 個模組`;
});

/* ---------------------------------------------- 7) 就緒警告（ready） */

group('7) createAutopilot 就緒警告（ready 未完成時的 input()）');

test('encounter 模式：未就緒時 input() 回中性輸入、只記一次警告、describe().ready === false', async () => {
  const pilot = createAutopilot({ kind: 'encounter', doc: { demo: { turns: [] } }, mode: 'demo' });
  eq(pilot.kind, 'encounter');
  const before = pilot.describe();
  isObj(before, 'describe 應回傳物件');
  eq(before.ready, false, 'encounter 模組載入前 describe().ready 應為 false');
  const warningsBefore = pilot.warnings.length;

  // 連呼叫三次，只該記一筆「尚未就緒」警告
  for (const frame of [0, 1, 2]) {
    const input = pilot.input({}, frame);
    isArray(input.press, 'press 應為陣列');
    isObj(input.hold, 'hold 應為物件');
    eq(Object.keys(input.hold).length, 0, `未就緒時回中性輸入（不該按鍵），第 ${frame} 次`);
    eq(input.press.length, 0, `未就緒時 press 應為空，第 ${frame} 次`);
  }
  const added = pilot.warnings.slice(warningsBefore).filter((message) => /尚未就緒/.test(message));
  eq(added.length, 1, `未就緒警告只該記一次（實際 ${added.length} 筆：${JSON.stringify(pilot.warnings)}）`);

  const ready = await pilot.ready;
  ok(typeof ready === 'boolean', `ready 應解析成布林（實際 ${typeof ready}）`);
  eq(pilot.describe().ready, true, '就緒後 describe().ready 應為 true');
  return `未就緒警告 1 筆、ready=${ready}`;
});

test('attack 模式：一開始就 ready，不會有「尚未就緒」警告', async () => {
  const doc = readSample('spade-rain');
  const pilot = createAutopilot({ kind: 'attack', doc, mode: 'demo' });
  eq(pilot.describe().ready, true, 'attack 模式建立後應立即 ready');
  const battle = createBattle({ canvas: null, assets: null, mode: 'play' });
  battle.load(doc);
  pilot.input(battle.getState(), 0);
  battle.destroy();
  ok(
    !pilot.warnings.some((message) => /尚未就緒/.test(message)),
    `attack 模式不該有未就緒警告：${JSON.stringify(pilot.warnings)}`,
  );
  const ready = await pilot.ready;
  eq(ready, true, 'attack 模式的 ready 應解析成 true');
  return 'ready 立即為 true';
});

/* ---------------------------------------------- 8) 跟隨器精度 + trace */

group('8) 跟隨器精度（實際 vs 插值目標）與 traceDemo');

test('traceDemo：4 個範例的既有 demo 都是 0 命中，且回報逐幀預定/實際座標', () => {
  const summary = [];
  for (const name of SAMPLES) {
    const doc = readSample(name);
    const trace = traceDemo(doc);
    isObj(trace, 'traceDemo 應回傳物件');
    isArray(trace.frames, 'frames 應為陣列');
    isArray(trace.hits, 'hits 應為陣列');
    isObj(trace.summary, 'summary 應為物件');
    eq(trace.hits.length, 0, `${name} 既有 demo 應 0 命中（實際 ${trace.hits.length}）`);
    ok(trace.frames.length > 100, `${name} 幀數太少：${trace.frames.length}`);

    const first = trace.frames[0];
    eq(first.frame, 0, '第一幀 frame 應為 0');
    isObj(first.target, '每幀要有 target');
    isObj(first.actual, '每幀要有 actual');
    for (const key of ['x', 'y']) {
      ok(Number.isFinite(first.target[key]), `target.${key} 應為數字`);
      ok(Number.isFinite(first.actual[key]), `actual.${key} 應為數字`);
    }
    eq(typeof first.hit, 'boolean', 'hit 應為布林');

    const stats = deviationStats(trace.frames);
    ok(stats.frames > 100, `${name} 有效幀太少：${stats.frames}`);
    ok(stats.avg < 3, `${name} 平均偏差 ${stats.avg.toFixed(2)}px 過大（規格：跟隨器要貼著插值目標）`);
    summary.push(`${name} ${stats.avg.toFixed(2)}/${stats.max.toFixed(2)}`);
  }
  return summary.join('、');
});

test('traceDemo：站著不動會被打中（hits 與 summary 正確）', () => {
  const doc = readSample('ring-burst');
  // ring-burst 的環形彈幕從框中心生成：站在中心必中
  const trace = traceDemo(doc, { path: [{ t: 0, x: 320, y: 190 }] });
  ok(trace.hits.length >= 3, `站在中心應該被打中（實際 ${trace.hits.length} 次）`);
  eq(trace.summary.hits, trace.hits.length, 'summary.hits 應等於 hits.length');
  eq(trace.summary.firstHitFrame, trace.hits[0].frame, 'summary.firstHitFrame 應等於第一次命中的幀');
  isObj(trace.summary.origin, 'summary.origin 應有第一次命中的座標');
  ok(Number.isFinite(trace.summary.origin.x), 'origin.x 應為數字');
  const hitFrames = new Set(trace.hits.map((hit) => hit.frame));
  const flagged = trace.frames.filter((frame) => frame.hit);
  eq(flagged.length, hitFrames.size, '每幀 hit 標記的數量應與 hits 一致');
  for (const frame of flagged) ok(hitFrames.has(frame.frame), `第 ${frame.frame} 幀的 hit 標記應對應一筆命中`);
  return `${trace.hits.length} 次命中，首次在第 ${trace.summary.firstHitFrame} 幀`;
});

test('traceDemo：可用 path 覆寫、keepGoing=false / stopAfterHits 會提早停', () => {
  const doc = readSample('ring-burst');
  const stay = [{ t: 0, x: 320, y: 190 }];
  const full = traceDemo(doc, { path: stay });
  const stopped = traceDemo(doc, { path: stay, keepGoing: false });
  eq(stopped.hits.length, 1, 'keepGoing=false 應在第一次命中後就停');
  ok(stopped.frames.length < full.frames.length, 'keepGoing=false 的幀數應較少');
  eq(stopped.frames[stopped.frames.length - 1].hit, true, '最後一幀應是命中幀');
  const limited = traceDemo(doc, { path: stay, stopAfterHits: 2 });
  eq(limited.hits.length, 2, 'stopAfterHits=2 應停在 2 次命中');
  // 空 path / null 攻擊檔不該丟例外（空 path 會退化成 bot，命中數不保證）
  const empty = traceDemo(doc, { path: [] });
  isArray(empty.frames, '空 path 仍應回傳 frames');
  ok(empty.frames.length > 0, '空 path 仍應跑出幀');
  isArray(traceDemo(null).frames, 'null 攻擊檔仍應回傳 frames');
  return `全跑 ${full.frames.length} 幀 / 一命中即停 ${stopped.frames.length} 幀 / 兩命中 ${limited.frames.length} 幀`;
});

test('跟隨器：框旋轉時往框外目標移動仍留在框內（以實際 soul 位置為準）', () => {
  const doc = readSample('spade-rain');
  const rotated = JSON.parse(JSON.stringify(doc));
  rotated.box = { ...rotated.box, w: 120, h: 120, rotation: 30 };
  rotated.soul = { ...rotated.soul, x: 320, y: 190, speed: 4, slowSpeed: 2 };
  // 目標故意放在框外（旋轉 30°、半寬 56 的框，右上角世界座標約 (368.5, 238.5)）
  rotated.demo = { mode: 'path', fallback: 'stay', path: [{ t: 0, x: 430, y: 300 }, { t: 10, x: 430, y: 300 }] };

  const battle = createBattle({ canvas: null, assets: null, mode: 'play' });
  battle.load(rotated);
  const pilot = createSoulPilot({ demo: rotated.demo, mode: 'path' });
  const sim = battle.engine;
  let maxOut = 0;
  for (let frame = 0; frame < 60; frame += 1) {
    const state = battle.getState();
    const clamped = clampToBox(state.soul.x, state.soul.y, state.box, 0);
    maxOut = Math.max(maxOut, Math.hypot(clamped.x - state.soul.x, clamped.y - state.soul.y));
    const input = pilot.input(state, frame);
    const hold = input.hold || {};
    sim.stepFrame({
      dx: (hold.right ? 1 : 0) - (hold.left ? 1 : 0),
      dy: (hold.down ? 1 : 0) - (hold.up ? 1 : 0),
      slow: Boolean(hold.slow),
    });
  }
  const end = battle.getState();
  battle.destroy();
  ok(maxOut < 1e-6, `靈魂不該跑到旋轉框外（最大超出 ${maxOut.toFixed(3)}）`);
  // 應該往目標方向（右下）靠近
  ok(end.soul.x > 320 + 10, `應往右靠近目標（實際 x=${end.soul.x.toFixed(1)}）`);
  ok(end.soul.y > 190 + 10, `應往下靠近目標（實際 y=${end.soul.y.toFixed(1)}）`);
  return `終點 (${end.soul.x.toFixed(1)}, ${end.soul.y.toFixed(1)})`;
});

/* ---------------------------------------------- 9) pathgen（自動產生路徑） */

group('9) generateDemoPath（以引擎實跑驗證的搜尋）');

test('compactPath / expandPath：只做時間軸等價的壓縮', () => {
  const path = [
    { t: 0, x: 320, y: 190 },
    { t: 0.3, x: 320, y: 190 },
    { t: 0.6, x: 320, y: 190 },
    { t: 0.9, x: 330, y: 190 },
    { t: 1.2, x: 340, y: 190 },
  ];
  const compacted = compactPath(path, 2);
  // 連續同點只留頭尾（不能併成 hold：hold 會把移動攤平，時間軸就變了）
  eq(compacted.length, 4, `應保留 4 點（實際 ${JSON.stringify(compacted)}）`);
  eq(compacted[0].t, 0, '第一點 t');
  eq(compacted[1].t, 0.6, '停留段的尾點 t 應保留（之後才開始移動）');
  eq(compacted[2].t, 0.9, '移動段的第一點 t');
  eq(compacted[3].t, 1.2, '最後一點 t');
  eq(compacted[3].hold, 0.8, '最後一點應補上到 endT 的 hold');
  eq(compacted[0].hold, undefined, '中間點不該有 hold（會改變插值時間軸）');
  eq(compacted[1].hold, undefined, '中間點不該有 hold（會改變插值時間軸）');
  const expanded = expandPath(compacted, 0.3);
  ok(expanded.length >= 3, 'expandPath 應展開出至少 3 點');
  eq(compactPath([], 1).length, 0, '空路徑 → 空');
  return `5 → ${compacted.length} 點`;
});

test('createReplayEngine：同一條路徑重跑結果完全相同（決定性）', () => {
  const doc = readSample('spade-rain');
  const engineRun = createReplayEngine(doc);
  try {
    const path = doc.demo.path;
    const a = engineRun.run(path, { stopOnHit: false });
    const b = engineRun.run(path, { stopOnHit: false });
    eq(a.hits, b.hits, '兩次重跑的命中數應相同');
    eq(a.framesRun, b.framesRun, '兩次重跑的幀數應相同');
    approx(a.endSoul.x, b.endSoul.x, 1e-9, '終點 x 應相同');
    approx(a.endSoul.y, b.endSoul.y, 1e-9, '終點 y 應相同');
    eq(typeof engineRun.durationFrames(), 'number', 'durationFrames 應回傳數字');
  } finally {
    engineRun.destroy();
  }
  // 一次性 replayPath 也要與重用引擎一致
  const oneOff = replayPath(doc, doc.demo.path, { stopOnHit: false });
  eq(oneOff.hits, 0, 'spade-rain 既有 demo 應 0 命中');
  return `0 命中、${oneOff.framesRun} 幀`;
});

test('generateDemoPath：產生 0 命中且通過 validateAttackDemo 的 demo', () => {
  const doc = readSample('box-shrink-aim'); // 這一個最快（約 1.5 秒）
  const result = generateDemoPath(doc, { seed: 1, timeBudgetMs: 60000 });
  isObj(result, 'generateDemoPath 應回傳物件');
  eq(result.ok, true, `應產生 0 命中路徑（hits=${result.hits}, reason=${result.reason}）`);
  eq(result.hits, 0, 'hits 應為 0');
  isObj(result.demo, '應回傳 demo 物件');
  eq(result.demo.mode, 'path', 'demo.mode 應為 path');
  isArray(result.demo.path, 'demo.path 應為陣列');
  ok(result.demo.path.length >= 2, `路徑點太少：${result.demo.path.length}`);
  for (const point of result.demo.path) {
    ok(Number.isFinite(point.t), '每個點都要有 t');
    ok(Number.isFinite(point.x), '每個點都要有 x');
    ok(Number.isFinite(point.y), '每個點都要有 y');
  }
  const errors = validateAttackDemo(result.demo);
  eq(errors.length, 0, `產生的 demo 應通過驗證：${JSON.stringify(errors.slice(0, 3))}`);
  ok(result.elapsedMs <= 60000 + 5000, `應在時間預算內完成（實際 ${result.elapsedMs}ms）`);

  // 用 trace 獨立再驗一次（不同入口、同一引擎）
  const trace = traceDemo(doc, { demo: result.demo, mode: 'path' });
  eq(trace.hits.length, 0, `trace 驗證也該 0 命中（實際 ${trace.hits.length}）`);
  return `${result.demo.path.length} 點、${result.elapsedMs}ms、${result.attempts} 次實跑`;
});

test('generateDemoPath：同一個 seed 產生同一條路徑（決定性）', () => {
  const doc = readSample('box-shrink-aim');
  const wide = { seed: 7, timeBudgetMs: 20000, maxSweeps: 1 };
  const a = generateDemoPath(doc, wide);
  const b = generateDemoPath(doc, wide);
  eq(JSON.stringify(a.path), JSON.stringify(b.path), '同 seed + 同選項應產生完全相同的路徑');
  eq(a.hits, b.hits, '命中數也應相同');
  const c = generateDemoPath(doc, { ...wide, seed: 8 });
  ok(Array.isArray(c.path), '換 seed 也應產生路徑');
  return `${a.path.length} 點、0 命中`;
});

test('generateDemoPath：AbortSignal 取消時回傳目前最佳結果', () => {
  const doc = readSample('spade-rain');
  const controller = new AbortController();
  controller.abort();
  const result = generateDemoPath(doc, { signal: controller.signal, timeBudgetMs: 60000 });
  eq(result.aborted, true, 'aborted 應為 true');
  eq(result.reason, 'aborted', `reason 應為 aborted（實際 ${result.reason}）`);
  isArray(result.path, '取消時仍應回傳目前最佳路徑');
  ok(result.path.length >= 1, '取消時不該回傳空路徑');

  // 跑到最佳化階段再取消
  const controller2 = new AbortController();
  let cancelled = false;
  const result2 = generateDemoPath(doc, {
    timeBudgetMs: 60000,
    signal: controller2.signal,
    onProgress: (payload) => {
      if (!cancelled && payload.phase === 'optimize' && payload.index >= 2) {
        cancelled = true;
        controller2.abort();
      }
    },
  });
  eq(result2.aborted, true, '中途取消也應標記 aborted');
  ok(result2.elapsedMs < 60000, '中途取消應該比時間預算早結束');
  return `立即取消 ${result.elapsedMs}ms、中途取消 ${result2.elapsedMs}ms`;
});

test('generateDemoPath：會回報進度（onProgress 的 phase 序列）', () => {
  const doc = readSample('box-shrink-aim');
  const phases = [];
  const indexes = [];
  generateDemoPath(doc, {
    seed: 1,
    timeBudgetMs: 20000,
    onProgress: (payload) => {
      isObj(payload, 'onProgress 應收到物件');
      ok(typeof payload.phase === 'string', 'onProgress 應有 phase');
      phases.push(payload.phase);
      if (payload.phase === 'optimize') indexes.push(payload.index);
    },
  });
  ok(phases.includes('seed'), `應有 seed 階段（實際 ${JSON.stringify([...new Set(phases)])}）`);
  ok(phases.includes('optimize') || phases.includes('validate'), '應有 optimize 或 validate 階段');
  ok(phases.includes('validate'), '最後應有 validate 階段');
  const unique = [...new Set(phases)];
  return unique.join(' → ');
});

test('4 個範例都能用 generateDemoPath 產生 0 命中路徑（每個 ≤ 60 秒）', () => {
  const summary = [];
  let withoutSlow = 0;
  for (const name of SAMPLES) {
    const doc = readSample(name);
    const startedAt = Date.now();
    const result = generateDemoPath(doc, { seed: 1, timeBudgetMs: 60000 });
    const elapsed = Date.now() - startedAt;
    ok(result.ok === true, `${name} 應產生 0 命中路徑（hits=${result.hits}, reason=${result.reason}）`);
    eq(result.hits, 0, `${name} 命中數應為 0`);
    ok(elapsed <= 60000 + 5000, `${name} 用時 ${elapsed}ms 超過 60 秒預算`);
    eq(validateAttackDemo(result.demo).length, 0, `${name} 產生的 demo 應通過驗證`);
    if (!result.path.some((point) => point.slow)) withoutSlow += 1;
    summary.push(`${name} ${result.path.length}點/${result.attempts}次/${elapsed}ms`);
  }
  ok(withoutSlow <= 2, `至少 2 個範例的產生路徑應含 slow 段（實際 ${4 - withoutSlow}/4 有）`);
  return summary.join('、');
});

test('pathgen 產生的 demo 存回檔案後仍能 0 命中（模擬 CLI --write）', () => {
  const { doc } = sampleCopy('spade-rain');
  const generated = generateDemoPath(doc, { seed: 2, timeBudgetMs: 30000 });
  eq(generated.ok, true, '應產生 0 命中路徑');
  // 模擬 --write：只換掉 demo 欄位
  const nextDoc = JSON.parse(JSON.stringify(doc));
  nextDoc.demo = generated.demo;
  eq(validateAttackDemo(nextDoc.demo).length, 0, '寫回的 demo 應通過驗證');
  const trace = traceDemo(nextDoc);
  eq(trace.hits.length, 0, `寫回檔案後實跑仍應 0 命中（實際 ${trace.hits.length}）`);
  return `${generated.demo.path.length} 點`;
});

/* ------------------------------------------- V2-FIX1：re-export 與拍點時間 */

group('10) V2-FIX1：autoplay/index.js re-export 與拍點時間（"2b"）');

test('autoplay/index.js re-export pathgen / trace 的公開 API', () => {
  const names = [
    'PATHGEN_DEFAULTS',
    'botTrajectory',
    'compactPath',
    'createReplayEngine',
    'expandPath',
    'generateDemoPath',
    'replayPath',
    'validateDemoPath',
    'deviationStats',
    'summarizeTrace',
    'traceDemo',
  ];
  for (const name of names) ok(name in autoplay, `autoplay/index.js 缺 re-export：${name}`);
  eq(autoplay.generateDemoPath, pathgenMod.generateDemoPath, 'generateDemoPath 應是同一個函式');
  eq(autoplay.createReplayEngine, pathgenMod.createReplayEngine, 'createReplayEngine 應是同一個函式');
  eq(autoplay.PATHGEN_DEFAULTS, pathgenMod.PATHGEN_DEFAULTS, 'PATHGEN_DEFAULTS 應是同一個物件');
  eq(autoplay.traceDemo, traceMod.traceDemo, 'traceDemo 應是同一個函式');
  eq(autoplay.deviationStats, traceMod.deviationStats, 'deviationStats 應是同一個函式');
  eq(autoplay.summarizeTrace, traceMod.summarizeTrace, 'summarizeTrace 應是同一個函式');
  for (const name of ['botTrajectory', 'compactPath', 'expandPath', 'replayPath', 'validateDemoPath']) {
    eq(typeof autoplay[name], 'function', `${name} 應為函式`);
  }
  return `${names.length} 個名稱`;
});

test('pathgen：duration 寫 "16b" 等於 8 秒；無 bpm 時退回舊行為', () => {
  const beat = generateDemoPath(beatDoc(), { seed: 1, timeBudgetMs: 20000 });
  const seconds = generateDemoPath(beatDoc({ duration: 8 }), { seed: 1, timeBudgetMs: 20000 });
  eq(beat.ok, true, `拍點 duration 應產生 0 命中路徑（hits=${beat.hits}）`);
  eq(beat.hits, 0, '拍點 duration 應 0 命中');
  deepEq(beat.path, seconds.path, 'duration "16b"（bpm 120）應等於 8 秒');
  // 無 bpm：拍點字串無法換算 → 回退舊的 num("16b", 10) = 10 秒行為
  const noBpmBeat = generateDemoPath(beatDoc({ bpm: null, duration: '16b' }), { seed: 1, timeBudgetMs: 20000 });
  const noBpmTen = generateDemoPath(beatDoc({ bpm: null, duration: 10 }), { seed: 1, timeBudgetMs: 20000 });
  eq(noBpmBeat.ok, true, '無 bpm 時仍應能產生路徑');
  deepEq(noBpmBeat.path, noBpmTen.path, '無 bpm 時 "16b" 應退回舊 num() 行為（等於 10 秒）');
  return `${beat.path.length} 點、${beat.attempts} 次嘗試`;
});

test('createReplayEngine：demo.path[].t 可寫拍點（"0b"/"1b"/"3b"）', () => {
  const engineForBeats = createReplayEngine(beatDoc());
  const beatPath = [
    { t: '0b', x: 304, y: 254 },
    { t: '1b', x: 320, y: 190 },
    { t: '3b', x: 304, y: 254 },
  ];
  const secondsPath = [
    { t: 0, x: 304, y: 254 },
    { t: 0.5, x: 320, y: 190 },
    { t: 1.5, x: 304, y: 254 },
  ];
  const beats = engineForBeats.run(beatPath, { collectFrames: true, stopOnHit: false });
  const seconds = engineForBeats.run(secondsPath, { collectFrames: true, stopOnHit: false });
  engineForBeats.destroy();
  isArray(beats.frames, '應收集逐幀軌跡');
  deepEq(beats.frames, seconds.frames, '拍點 t 與秒數 t 的逐幀軌跡應相同');
  eq(beats.framesRun, seconds.framesRun, '幀數應相同');
  eq(beats.hits, seconds.hits, '命中數應相同');
  return `${beats.framesRun} 幀、${beats.frames.length} 筆軌跡`;
});

test('traceDemo：demo.path[].t 可寫拍點；無 bpm 時維持舊行為（忽略）', () => {
  const sample = [
    { t: '0b', x: 304, y: 254 },
    { t: '1b', x: 320, y: 190 },
    { t: '3b', x: 304, y: 254 },
  ];
  const beats = traceDemo(beatDoc(), { path: sample });
  const seconds = traceDemo(beatDoc(), {
    path: [
      { t: 0, x: 304, y: 254 },
      { t: 0.5, x: 320, y: 190 },
      { t: 1.5, x: 304, y: 254 },
    ],
  });
  const pick = (frames) =>
    frames.map((frame) => [frame.frame, frame.target, frame.actual, frame.hit, frame.pathActive, frame.slow]);
  deepEq(pick(beats.frames), pick(seconds.frames), '拍點 t 與秒數 t 的逐幀目標/實際應相同');
  eq(beats.summary.frames, seconds.summary.frames, '幀數應相同');
  ok(beats.frames.some((frame) => frame.pathActive), '拍點路徑應有作用（pathActive）');
  // 舊行為：沒有 bpm 時 "2b" 不是有限數字 → buildPathTimeline 直接丟掉 → 等於沒有路徑
  const noBpm = traceDemo(beatDoc({ bpm: null, duration: 8 }), { path: sample });
  eq(noBpm.frames.filter((frame) => frame.pathActive).length, 0, '無 bpm 時拍點字串應如同舊版被忽略');
  return `${beats.frames.length} 幀、hits ${beats.summary.hits}`;
});



/* ------------------------------------------------------------ 執行 */

for (const item of queue) {
  if (item.kind === 'group') {
    currentGroup = item.name;
    console.log(`\n=== ${item.name} ===`);
    continue;
  }
  try {
    // eslint-disable-next-line no-await-in-loop
    const detail = await item.fn();
    results.pass += 1;
    console.log(`✔ ${item.name}${typeof detail === 'string' && detail ? `（${detail}）` : ''}`);
  } catch (err) {
    results.fail += 1;
    failures.push({ group: item.group, name: item.name, message: err && err.message ? err.message : String(err) });
    console.log(`✘ ${item.name} — ${err && err.message ? err.message : err}`);
  }
}

const ms = Date.now() - started;
console.log('');
console.log('────────────────────────────────────────────');
console.log(
  `通過 ${results.pass}・失敗 ${results.fail}・略過 ${results.skipped}・備註 ${results.notes}（${ms} ms）`,
);
if (results.fail > 0) {
  console.log('\n失敗清單：');
  for (const f of failures) {
    console.log(`  ✘ [${f.group}] ${f.name}`);
    console.log(`    ${f.message}`);
  }
  console.log('\n結果：失敗');
  process.exitCode = 1;
} else {
  console.log('結果：全部通過');
}

export { group, test, ok, eq, results };
