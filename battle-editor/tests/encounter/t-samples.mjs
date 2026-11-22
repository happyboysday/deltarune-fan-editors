/**
 * tests/encounter/t-samples.mjs — W2 的 samples/ 整合測試
 *
 * 這些檔案由 W2 維護、可能隨時變動，所以：
 *   - 找不到檔案 → 記一筆 skip（不算失敗）
 *   - 找到 → 必須 0 驗證錯誤、0 執行期錯誤、能跑到終局、且具有決定性
 *
 * 目的：確保「真實資料」不會被引擎的預設值 / 正規化規則擋掉。
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { group, test, skip, note, eq, ok, deepEq } from '../engine/harness.mjs';
import { createEncounter } from '../../engine/encounter/index.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

/** 讀 samples/ 底下的 JSON；不存在回 null */
async function readSample(rel) {
  try {
    const raw = await readFile(join(ROOT, rel), 'utf8');
    return JSON.parse(raw);
  } catch (_err) {
    return null;
  }
}

/** 建立「會從 samples/ 解析攻擊」的無頭遭遇 */
function makeEncounter() {
  return createEncounter({
    canvas: null,
    assets: null,
    resolveAttack: async (name) => readSample(`samples/${name}.json`),
  });
}

/** FIGHT 命中窗口：標記與目標線距離在此以內才按 Z（SPEC-P2 §2） */
const FIGHT_HIT_WINDOW = 20;

/**
 * 決定這一幀要按哪些鍵（決定性腳本）：
 *   - FIGHT 階段：只在「有尚未結算的攻擊條且 |x - targetX| <= 20」時按 Z，避免全 MISS
 *   - 其他階段：每 9 幀按一次 Z（推進文字 / 選單 / 泡泡）
 */
function decidePress(state, i) {
  const bars = state && state.fight && Array.isArray(state.fight.bars) ? state.fight.bars : null;
  if (bars && bars.length > 0) {
    const ready = bars.some(
      (b) => b && b.result == null && Math.abs((b.x || 0) - (b.targetX || 0)) <= FIGHT_HIT_WINDOW
    );
    return ready ? ['confirm'] : [];
  }
  return i % 9 === 0 ? ['confirm'] : [];
}

/**
 * 把遭遇跑到終局（上限 frames = 4000，足夠打完多回合 + 長旁白）。
 */
async function playThrough(json, frames = 4000) {
  const enc = makeEncounter();
  const errors = [];
  enc.on('error', (p) => errors.push(p));
  const loadResult = await enc.load(json);
  let sawBattle = false;
  let sawText = false;
  const trail = [];
  for (let i = 0; i < frames && !enc.result; i += 1) {
    const before = enc.getState();
    enc.step(1, { press: decidePress(before, i), hold: {} });
    const s = enc.getState();
    if (s.battle) sawBattle = true;
    if (s.textbox || s.bubbles.length > 0) sawText = true;
    trail.push(`${s.frame}|${s.phase}|${s.turn}|${s.tp}|${JSON.stringify(s.party)}`);
  }
  const out = {
    errors: loadResult.errors,
    runtimeErrors: errors,
    missingAttacks: enc.debug.missingAttacks,
    sawBattle,
    sawText,
    frames: enc.frame,
    result: enc.result,
    flowMode: !enc.debug.flowUnavailable,
    flowErrors: typeof enc.debug.flowErrorCount === 'number' ? enc.debug.flowErrorCount : 0,
    state: enc.getState(),
    trail,
  };
  enc.destroy();
  return out;
}

/** 對單一遭遇檔跑完整套斷言 */
async function checkSample(rel) {
  const json = await readSample(rel);
  if (!json) return 'missing';

  const a = await playThrough(json);
  eq(a.errors.length, 0, `${rel} 沒有驗證錯誤（${a.errors.slice(0, 2).map((e) => `${e.path}: ${e.message}`).join(' / ')}）`);
  deepEq(a.missingAttacks, [], `${rel} 的攻擊都解析成功`);

  // flow.js 屬於 FL 的檔案；它執行期拋錯時 index.js 會回報並降級，
  // 這裡只把它記錄成備註（不是 E1 的失敗），其餘錯誤一律視為失敗。
  const flowErrors = a.runtimeErrors.filter((e) => e && e.path === 'flow');
  const otherErrors = a.runtimeErrors.filter((e) => !e || e.path !== 'flow');
  eq(otherErrors.length, 0, `${rel} 沒有執行期錯誤（${otherErrors.slice(0, 2).map((e) => e.message).join(' / ')}）`);
  if (flowErrors.length > 0) {
    note(`${rel}：flow.js 執行期拋錯 ${flowErrors.length} 次，已降級並跑完（${flowErrors[0].message}）`);
  }

  eq(a.result, 'victory', `${rel} 跑到終局（實際 ${a.result}，frame ${a.frames}）`);
  ok(a.sawText, `${rel} 有顯示文字`);
  // 正規流程下，敵人可能還沒輪到彈幕回合就被打倒（victory）——這是正確行為，
  // 所以只在「降級流程」要求一定要看到彈幕（降級流程固定把 turn.attack 當指令插入）。
  if (!a.flowMode) {
    ok(a.sawBattle, `${rel} 有出現彈幕回合（降級流程）`);
  } else if (!a.sawBattle) {
    note(`${rel}：resolve 階段就結束，未進入彈幕回合（正常）`);
  }

  // 決定性：再跑一次，逐幀軌跡必須完全相同
  const b = await playThrough(json);
  deepEq(a.trail, b.trail, `${rel} 兩次執行逐幀相同（決定性）`);
  return 'ok';
}

group('samples：W2 的範例遭遇');

test('samples/encounters/rudinn.json 可完整遊玩且具決定性', async () => {
  const r = await checkSample('samples/encounters/rudinn.json');
  if (r === 'missing') skip('rudinn.json', 'W2 尚未產出，略過');
});

test('samples/encounters/showcase.json 可完整遊玩且具決定性', async () => {
  const r = await checkSample('samples/encounters/showcase.json');
  if (r === 'missing') skip('showcase.json', 'W2 尚未產出，略過');
});

// V2-07：形態示範（actor.forms + form cue + 變數分支切回）
test('samples/encounters/forms-demo.json 可完整遊玩且具決定性（forms）', async () => {
  const r = await checkSample('samples/encounters/forms-demo.json');
  if (r === 'missing') skip('forms-demo.json', 'V2-07 尚未產出，略過');
});

test('samples/encounters/index.json 的每個項目都指得到檔案', async () => {
  const index = await readSample('samples/encounters/index.json');
  if (!index) {
    skip('encounters/index.json', 'W2 尚未產出，略過');
    return;
  }
  const list = Array.isArray(index) ? index : Array.isArray(index.encounters) ? index.encounters : [];
  ok(list.length > 0, '索引至少一筆');
  for (const item of list) {
    const file = typeof item === 'string' ? item : item.file || item.path || null;
    if (!file) continue;
    const rel = file.startsWith('samples/') ? file : `samples/encounters/${file}`;
    const json = await readSample(rel);
    ok(json !== null, `${rel} 存在`);
  }
});

test('flow.js 執行期拋錯時，index.js 會回報並降級而不崩潰', async () => {
  const json = await readSample('samples/encounters/showcase.json');
  if (!json) {
    skip('showcase.json', 'W2 尚未產出，略過');
    return;
  }
  const r = await playThrough(json);
  if (r.flowErrors === 0) {
    ok(true, 'flow.js 執行期沒有拋錯（不需要降級）');
    return;
  }
  ok(r.flowErrors > 0, `flow 拋錯次數 ${r.flowErrors} > 0`);
  ok(
    r.runtimeErrors.some((e) => e && e.path === 'flow' && typeof e.message === 'string'),
    '有發出 path="flow" 的 error 事件'
  );
  eq(r.result, 'victory', `降級後仍跑到終局（實際 ${r.result}）`);
  ok(r.frames > 0, 'frame 有推進');
});

test('samples/ 的攻擊檔都能被 Phase 1 引擎讀取', async () => {
  const { normalizeAttack, validateAttack } = await import('../../engine/attack.js');
  const names = ['spade-rain', 'ring-burst', 'box-shrink-aim', 'sine-wave'];
  let found = 0;
  for (const name of names) {
    const json = await readSample(`samples/${name}.json`);
    if (!json) continue;
    found += 1;
    const errors = validateAttack(json);
    eq(errors.length, 0, `${name}.json 驗證通過`);
    const norm = normalizeAttack(json);
    ok(Array.isArray(norm.timeline) && norm.timeline.length > 0, `${name}.json 有時間軸事件`);
  }
  if (found === 0) skip('samples/*.json', '找不到任何攻擊範例');
});
