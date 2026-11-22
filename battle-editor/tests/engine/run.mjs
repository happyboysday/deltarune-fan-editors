/**
 * tests/engine/run.mjs — 引擎測試入口
 *
 * 執行：cd battle-editor && node tests/engine/run.mjs
 *
 * 測試分檔（皆為 E1 擁有的 tests/engine/**）：
 *   t-attack.mjs    normalizeAttack / validateAttack
 *   t-expr.mjs      表達式編譯、沙箱、錯誤不中斷、快取
 *   t-sim.mjs       決定性、seek 與 step 一致、事件、子彈、靈魂、碰撞
 *   t-graze.mjs     FX-GRAZE：官方心形擦彈判定（遮罩形狀、圓/旋轉矩形邊界、命中不變）
 *   t-api.mjs       createBattle 公開 API 與 getState 形狀（SPEC §6 / §9）
 */

import { group, test, ok, run, summary } from './harness.mjs';

// 先註冊收尾檢查（輸出順序由註冊順序決定）
group('環境檢查');

test('Node 環境可載入引擎（無 DOM 依賴）', () => {
  ok(typeof process !== 'undefined', '在 Node 中執行');
  ok(typeof globalThis.document === 'undefined', '模擬核心不需要 document');
  ok(typeof globalThis.window === 'undefined', '模擬核心不需要 window');
});

// 載入測試檔（import 時即註冊測試）
await import('./t-attack.mjs');
await import('./t-expr.mjs');
await import('./t-expr-v2.mjs');
await import('./t-sim.mjs');
await import('./t-graze.mjs');
await import('./t-arena.mjs');
await import('./t-soul.mjs');
await import('./t-depth.mjs');
await import('./t-api.mjs');

const result = await run();
summary();
if (result.fail > 0) process.exitCode = 1;
