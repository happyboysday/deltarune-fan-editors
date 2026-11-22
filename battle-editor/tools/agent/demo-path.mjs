#!/usr/bin/env node
/**
 * tools/agent/demo-path.mjs — 自動產生並驗證 demo 路徑（SPEC-AUTOPLAY §2.1 / §3）
 *
 * 用法：
 *   node tools/agent/demo-path.mjs <attack.json> [--write] [--seed N] [--budget 60s]
 *
 * 行為：
 *   1. 讀攻擊檔，用 engine/autoplay/pathgen.js 的 generateDemoPath 產生 0 命中的
 *      `demo`（含 slow 慢速段），全程以引擎實跑驗證。
 *   2. 再用 engine/autoplay/validate.js 檢查 demo 格式（與編輯器同一支驗證器）。
 *   3. 不加 --write：只印結果 JSON（stdout 只有 JSON，進度/訊息走 stderr）。
 *      加 --write：把 demo 寫回檔案，**只換掉 "demo" 那一段文字**，其他欄位、
 *      排序、排版、換行都保留原樣（不動 samples 的其他內容）。
 *
 * 參數：
 *   --write          寫回檔案
 *   --seed N         亂數種子（預設 1；同 seed + 同攻擊檔 → 同一條路徑）
 *   --budget 60s     時間預算（也接受純毫秒數，例如 --budget 60000）
 *   --step 0.3       節點間隔秒數（預設 0.3）
 *   --sweeps N       最多幾輪座標下降（預設 8）
 *   --json           與不加 --write 相同（保留給習慣明示的呼叫端）
 *   --quiet          不在 stderr 印進度
 *
 * 離開碼：0 = 產生成功（0 命中）且驗證通過；1 = 沒能產生 0 命中或驗證失敗；
 *         2 = 參數 / 讀檔錯誤。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { cliEntry, numArg, parseArgs, readJSON, resolveInputFile } from './lib.mjs';
import { generateDemoPath } from '../../engine/autoplay/pathgen.js';
import { validateAttackDemo } from '../../engine/autoplay/validate.js';

const VALUE_FLAGS = ['seed', 'budget', 'step', 'sweeps', 'min-clearance', 'fallback'];

/** "60s" / "1.5m" / "60000" → 毫秒。 */
function parseBudget(value, fallback = 60000) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(50, Math.round(value));
  if (typeof value !== 'string' || value.trim() === '') return fallback;
  const text = value.trim().toLowerCase();
  const match = text.match(/^([0-9]*\.?[0-9]+)\s*(ms|s|m)?$/);
  if (!match) return fallback;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return fallback;
  const unit = match[2] || 'ms';
  const scale = unit === 's' ? 1000 : unit === 'm' ? 60000 : 1;
  return Math.max(50, Math.round(amount * scale));
}

/**
 * 找到原始 JSON 文字裡頂層 `"demo"` 的值區間 [start, end)。
 * 找不到（檔案裡沒有 demo）→ 回傳 null。
 *
 * 用字串/跳脫狀態機掃描，不是正則：demo.path 裡可能有任意字串內容。
 */
function findTopLevelMember(text, key) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let expectKey = false;
  let keyStart = -1;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') {
        inString = false;
        if (expectKey && depth === 1) {
          // 讀到一個頂層 key；看它是不是目標，是的話記下 value 起點
          const name = JSON.parse(text.slice(keyStart, i + 1));
          if (name === key) {
            let j = i + 1;
            while (j < text.length && /\s/.test(text[j])) j += 1;
            if (text[j] === ':') {
              j += 1;
              while (j < text.length && /\s/.test(text[j])) j += 1;
              // 從 value 起點掃到該 value 結束（物件/陣列/字串/純量）
              const valueStart = j;
              let valueEnd = j;
              if (text[j] === '{' || text[j] === '[') {
                let d = 0;
                let s = false;
                let e = false;
                for (let k = j; k < text.length; k += 1) {
                  const c = text[k];
                  if (s) {
                    if (e) e = false;
                    else if (c === '\\') e = true;
                    else if (c === '"') s = false;
                    continue;
                  }
                  if (c === '"') {
                    s = true;
                    continue;
                  }
                  if (c === '{' || c === '[') d += 1;
                  else if (c === '}' || c === ']') {
                    d -= 1;
                    if (d === 0) {
                      valueEnd = k + 1;
                      break;
                    }
                  }
                }
              } else if (text[j] === '"') {
                let s = false;
                let e = false;
                for (let k = j; k < text.length; k += 1) {
                  const c = text[k];
                  if (!s) {
                    if (c === '"') s = true;
                    continue;
                  }
                  if (e) e = false;
                  else if (c === '\\') e = true;
                  else if (c === '"') {
                    valueEnd = k + 1;
                    break;
                  }
                }
              } else {
                let k = j;
                while (k < text.length && !/[,\s}]/.test(text[k])) k += 1;
                valueEnd = k;
              }
              return { valueStart, valueEnd };
            }
          }
        }
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      keyStart = i;
      expectKey = depth === 1;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    else if (ch === ',') expectKey = depth === 1;
  }
  return null;
}

/** 路徑點排成一行（與 samples 的寫法一致），減少 diff 噪音。 */
function formatPathPoint(point) {
  const parts = [`"t": ${JSON.stringify(point.t)}`, `"x": ${JSON.stringify(point.x)}`, `"y": ${JSON.stringify(point.y)}`];
  if (point.slow) parts.push('"slow": true');
  if (point.hold !== undefined) parts.push(`"hold": ${JSON.stringify(point.hold)}`);
  return `{ ${parts.join(', ')} }`;
}

/** 把 demo 物件排成檔案裡的縮排（頂層成員 2 空白、路徑點一行一點）。 */
function formatDemo(demo) {
  const lines = ['{'];
  const keys = Object.keys(demo);
  keys.forEach((key, index) => {
    const comma = index === keys.length - 1 ? '' : ',';
    if (key === 'path' && Array.isArray(demo.path)) {
      lines.push('  "path": [');
      demo.path.forEach((point, i) => {
        lines.push(`    ${formatPathPoint(point)}${i === demo.path.length - 1 ? '' : ','}`);
      });
      lines.push(`  ]${comma}`);
      return;
    }
    const value = JSON.stringify(demo[key]);
    lines.push(`  ${JSON.stringify(key)}: ${value}${comma}`);
  });
  lines.push('}');
  return lines
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join('\n');
}

/** 只換掉原始文字裡的 demo 段，其餘原樣保留。 */
function replaceDemoText(text, demo) {
  const found = findTopLevelMember(text, 'demo');
  const formatted = formatDemo(demo);
  if (found) return `${text.slice(0, found.valueStart)}${formatted}${text.slice(found.valueEnd)}`;

  // 檔案裡沒有 demo：插在 "soul" 之後（格式慣例）；找不到就插在結尾大括號前。
  const soul = findTopLevelMember(text, 'soul');
  if (soul) {
    // soul 之後的逗號（如果有）現在屬於 demo 之後——插在中間就不必動它。
    return `${text.slice(0, soul.valueEnd)},\n  "demo": ${formatted}${text.slice(soul.valueEnd)}`;
  }
  const close = text.lastIndexOf('}');
  if (close < 0) return text;
  const before = text.slice(0, close).replace(/\s*$/, '');
  const needsComma = before.trim() !== '{' && !before.trimEnd().endsWith(',');
  return `${before}${needsComma ? ',' : ''}\n  "demo": ${formatted}\n${text.slice(close)}`;
}

function parseCli(argv) {
  const args = parseArgs(argv, VALUE_FLAGS, { booleanFlags: ['write', 'w', 'quiet', 'q', 'h'] });
  if (args.help || args.h) return { help: true };
  const fileArg = Array.isArray(args._) && args._.length > 0 ? args._[0] : null;
  return {
    fileArg,
    write: Boolean(args.write || args.w),
    seed: numArg(args.seed, 1),
    budgetMs: parseBudget(args.budget, 60000),
    step: numArg(args.step, 0.3),
    maxSweeps: numArg(args.sweeps, 8),
    minClearance: args['min-clearance'] === undefined ? undefined : Number(args['min-clearance']),
    fallback: args.fallback ?? 'bot',
    quiet: Boolean(args.quiet || args.q),
  };
}

const HELP = `用法：node tools/agent/demo-path.mjs <attack.json> [--write] [--seed N] [--budget 60s]

  --write          把產生的 demo 寫回檔案（只換 "demo" 段，其他欄位與排序不動）
  --seed N         亂數種子（預設 1）
  --budget 60s     時間預算（也接受 60000 這種毫秒數）
  --step 0.3       路徑節點間隔秒數
  --sweeps N       最多幾輪座標下降（預設 8）
  --min-clearance N  最小淨空目標（px，預設 4）
  --fallback MODE   腳本結束後用 bot（預設）或 stay
  --quiet          不印進度
`;

function main() {
  const cli = parseCli(process.argv.slice(2));
  if (cli.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!cli.fileArg) {
    process.stderr.write(HELP);
    return 2;
  }
  if ((cli.minClearance !== undefined && (!Number.isFinite(cli.minClearance) || cli.minClearance < 0)) ||
    !['bot', 'stay'].includes(cli.fallback)) {
    process.stderr.write('--min-clearance 須為非負數，--fallback 須為 bot 或 stay\n');
    return 2;
  }
  const file = resolveInputFile(cli.fileArg, { mustExist: false });
  if (!file) {
    process.stderr.write(`找不到檔案：${cli.fileArg}\n`);
    return 2;
  }

  let doc;
  let rawText;
  try {
    rawText = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    doc = readJSON(file);
  } catch (err) {
    process.stderr.write(`讀檔失敗：${err && err.message ? err.message : err}\n`);
    return 2;
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    process.stderr.write(`不是合法的攻擊檔（最外層應為物件）：${file}\n`);
    return 2;
  }
  if (doc.format && doc.format !== 'dr-battle-attack/1') {
    process.stderr.write(`警告：format 是 ${doc.format}，不是 dr-battle-attack/1（仍會嘗試產生）\n`);
  }

  const started = Date.now();
  let lastPrint = 0;
  const result = generateDemoPath(doc, {
    seed: cli.seed,
    step: cli.step,
    maxSweeps: cli.maxSweeps,
    minClearance: cli.minClearance,
    fallback: cli.fallback,
    timeBudgetMs: cli.budgetMs,
    onProgress: (payload) => {
      if (cli.quiet) return;
      const now = Date.now();
      if (payload && payload.phase === 'seed') {
        process.stderr.write(
          `  候選 ${String(payload.label).padEnd(7)} 命中 ${payload.hits} 淨空 ${payload.clearance}\n`,
        );
        lastPrint = now;
        return;
      }
      // 最佳化階段最多每 1 秒印一次，避免洗版
      if (now - lastPrint < 1000) return;
      lastPrint = now;
      const elapsed = ((now - started) / 1000).toFixed(1);
      process.stderr.write(
        `  ${String(payload.phase).padEnd(8)} 命中 ${payload.hits} 淨空 ${payload.clearance ?? '?'} 用時 ${elapsed}s\n`,
      );
    },
  });

  const demo = result.demo;
  const errors = validateAttackDemo(demo);
  const written = Boolean(cli.write) && result.ok && errors.length === 0;
  if (written) {
    try {
      writeFileSync(file, replaceDemoText(rawText, demo), 'utf8');
    } catch (err) {
      process.stderr.write(`寫檔失敗：${err && err.message ? err.message : err}\n`);
      return 2;
    }
  } else if (cli.write && errors.length > 0) {
    process.stderr.write(`demo 驗證失敗，未寫回檔案：${JSON.stringify(errors.slice(0, 5))}\n`);
  }

  if (!result.clearanceMet) {
    process.stderr.write(`淨空未達 ${result.clearanceTarget} px；最佳路線為 ${result.best.minClearance.toFixed(2)} px\n`);
  }
  if (cli.write && !result.ok) process.stderr.write('路線仍會中彈，未覆寫原演示\n');
  const output = {
    file,
    ok: result.ok,
    hits: result.hits,
    hitFrames: result.hitFrames,
    reason: result.reason,
    aborted: result.aborted,
    elapsedMs: result.elapsedMs,
    attempts: result.attempts,
    nodes: result.path.length,
    minClearance: result.best.minClearance,
    clearanceTarget: result.clearanceTarget,
    clearanceMet: result.clearanceMet,
    validation: {
      ok: errors.length === 0,
      errors,
      replayHits: result.validation ? result.validation.hits : null,
    },
    written,
    demo,
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);

  if (!result.ok) return 1;
  if (errors.length > 0) return 1;
  return 0;
}

if (cliEntry(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`未預期的錯誤：${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 2;
  }
}

export { findTopLevelMember, formatDemo, parseBudget, replaceDemoText };
