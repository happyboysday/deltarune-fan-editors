/**
 * tests/encounter/run.mjs — 遭遇核心（E1）測試入口
 *
 * 執行：node tests/encounter/run.mjs
 *
 * 測試檔在 import 時註冊 test()，這裡最後統一 await run()。
 */

import { run, summary, group, test, note } from '../engine/harness.mjs';
import { CUE_COMMAND_NAMES } from '../../engine/encounter/schema.js';

group('環境檢查');

test('Node 可執行且為 22 以上（ESM / Proxy / structuredClone 可用）', () => {
  const major = Number(process.versions.node.split('.')[0]);
  if (!(major >= 22)) throw new Error(`Node 版本過舊：${process.versions.node}`);
  if (typeof Proxy !== 'function') throw new Error('缺少 Proxy');
});

test('CUE_COMMANDS 覆蓋 SPEC-P2 §3 全部 20 條指令', () => {
  const expected = [
    'say', 'bubble', 'move', 'anim', 'form', 'flip', 'fade', 'wait', 'sfx', 'bgm', 'shake',
    'flash', 'set', 'mercy', 'heal', 'damage', 'if', 'parallel', 'attack', 'end',
  ];
  for (const cmd of expected) {
    if (!CUE_COMMAND_NAMES.includes(cmd)) throw new Error(`CUE_COMMANDS 缺少 "${cmd}"`);
  }
  note(`共 ${CUE_COMMAND_NAMES.length} 條指令：${CUE_COMMAND_NAMES.join(' / ')}`);
});

/* 依序載入測試檔（只註冊，不執行） */
await import('./t-schema.mjs');
await import('./t-expr-p2.mjs');
await import('./t-actors-text.mjs');
await import('./t-anim.mjs');
await import('./t-forms.mjs');
await import('./t-cues.mjs');
await import('./t-world.mjs');
await import('./t-encounter.mjs');
await import('./t-layout.mjs');
await import('./t-samples.mjs');

await run();
summary();
