/**
 * editor/demo-worker.js — 「自動產生演示路徑」的 Web Worker（V2-06）
 *
 * 只做一件事：收 {type:'generate', attack, options}，跑引擎的
 * `generateDemoPath`，把 onProgress 轉成 `{type:'progress'}` 訊息，
 * 最後回 `{type:'done', result}` 或 `{type:'error', message}`。
 *
 * 引擎的 generateDemoPath 是同步長跑，放在 Worker 才不會鎖住編輯器 UI。
 * 本檔不做任何 DOM 存取，也不 import 編輯器其他模組（Worker 是獨立執行環境）。
 */

import { generateDemoPath } from '../engine/autoplay/index.js';

self.onmessage = (event) => {
  const msg = event && event.data && typeof event.data === 'object' ? event.data : null;
  if (!msg || msg.type !== 'generate') return;
  const attack = msg.attack && typeof msg.attack === 'object' ? msg.attack : {};
  const options = msg.options && typeof msg.options === 'object' ? msg.options : {};
  let lastPost = 0;
  try {
    const result = generateDemoPath(attack, {
      seed: options.seed,
      step: options.step,
      timeBudgetMs: options.timeBudgetMs,
      onProgress: (payload) => {
        // 節流：Worker → 主執行緒的訊息也不要太密
        const now = Date.now();
        if (now - lastPost < 100) return;
        lastPost = now;
        try {
          self.postMessage({ type: 'progress', payload });
        } catch (_err) {
          /* 忽略 */
        }
      },
    });
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: String((err && err.message) || err) });
  }
};
