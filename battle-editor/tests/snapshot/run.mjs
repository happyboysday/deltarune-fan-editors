/**
 * tests/snapshot/run.mjs — V2-08 快照 / 還原測試入口
 *
 * 執行：cd battle-editor && node tests/snapshot/run.mjs
 *
 * 測試分檔：
 *   t-sim.mjs         攻擊模擬（engine/sim.js + engine/rng.js）
 *   t-encounter.mjs   遭遇戰（engine/encounter/{world,cues,flow,text,actors}.js + index.js）
 *   t-integration.mjs 端到端：pathgen 重跑器改用 snapshot 後的行為與耗時、跨入口一致性
 *
 * 驗收重點（ROADMAP-V2 §2 V2-08）：
 *   - snapshot() 回傳可 structuredClone / JSON 序列化的完整狀態
 *   - restore(snap) 還原後「續跑逐幀 == 直跑」
 *   - 還原後再 snapshot() == 原快照
 *   - 四個攻擊範例 + 三個遭遇範例都成立
 */

import { group, test, ok, run, summary, isObj } from '../engine/harness.mjs';

group('環境檢查');

test('Node 環境可載入快照 API（無 DOM 依賴）', async () => {
  ok(typeof structuredClone === 'function', 'Node 應有 structuredClone');
  const sim = await import('../../engine/sim.js');
  ok(typeof sim.createSimulation === 'function', 'sim.js 應匯出 createSimulation');
  const enc = await import('../../engine/encounter/index.js');
  ok(typeof enc.createEncounter === 'function', 'encounter/index.js 應匯出 createEncounter');
});

test('createSimulation() 實例有 snapshot / restore', async () => {
  const { createSimulation } = await import('../../engine/sim.js');
  const sim = createSimulation({ mode: 'play' });
  ok(typeof sim.snapshot === 'function', '應有 snapshot()');
  ok(typeof sim.restore === 'function', '應有 restore()');
  isObj(sim.snapshot(), 'snapshot() 應回物件');
});

test('createEncounter() 實例有 snapshot / restore', async () => {
  const { createEncounter } = await import('../../engine/encounter/index.js');
  const enc = createEncounter({ canvas: null, assets: null });
  ok(typeof enc.snapshot === 'function', '應有 snapshot()');
  ok(typeof enc.restore === 'function', '應有 restore()');
});

await import('./t-sim.mjs');
await import('./t-encounter.mjs');
await import('./t-integration.mjs');

const result = await run();
summary();
if (result.fail > 0) process.exitCode = 1;
