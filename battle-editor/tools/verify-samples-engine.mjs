/**
 * tools/verify-samples-engine.mjs — 用真正的引擎驗證 samples/ 的攻擊檔。
 *
 * 和 check-samples.mjs 的分工：
 *   check-samples.mjs        只做 JSON 結構檢查（不需要引擎，W1 未完成時也能跑）
 *   verify-samples-engine.mjs 載入 engine/index.js，跑 validateAttack 與無頭模擬，
 *                             確認 normalize/step/seek 對我們的範例都不拋錯、無 error 事件。
 *
 * 用法：
 *   node tools/verify-samples-engine.mjs            # 檢查 samples/index.json 全部
 *   node tools/verify-samples-engine.mjs samples/x.json
 */

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BATTLE_EDITOR = resolve(HERE, '..');
const SAMPLES_DIR = join(BATTLE_EDITOR, 'samples');
const ENGINE_ENTRY = join(BATTLE_EDITOR, 'engine', 'index.js');

if (!existsSync(ENGINE_ENTRY)) {
  console.error(`找不到引擎：${ENGINE_ENTRY}（由 W1/E1 負責，尚未完成）`);
  process.exit(2);
}

const engine = await import(new URL('../engine/index.js', import.meta.url).href);
const { createBattle, normalizeAttack, validateAttack } = engine;

let failed = 0;
const warnings = [];

function loadJSON(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

function collectFiles() {
  const args = process.argv.slice(2);
  if (args.length) return args.map((a) => resolve(process.cwd(), a));
  const manifestPath = join(SAMPLES_DIR, 'index.json');
  if (!existsSync(manifestPath)) {
    console.error('缺少 samples/index.json');
    process.exit(2);
  }
  const manifest = loadJSON(manifestPath);
  return (manifest.samples || []).map((s) => join(SAMPLES_DIR, s.file));
}

const files = collectFiles();
if (!files.length) {
  console.error('沒有可驗證的檔案');
  process.exit(2);
}

for (const file of files) {
  const label = basename(file);
  let attack;
  try {
    attack = loadJSON(file);
  } catch (e) {
    console.error(`x ${label}: JSON 解析失敗：${e.message}`);
    failed += 1;
    continue;
  }

  // 1) validateAttack
  let issues = [];
  try {
    issues = validateAttack(attack) || [];
  } catch (e) {
    console.error(`x ${label}: validateAttack 拋錯：${e.message}`);
    failed += 1;
    continue;
  }
  const real = issues.filter((it) => it && it.message);
  if (real.length) {
    console.error(`x ${label}: validateAttack 回報 ${real.length} 個問題`);
    for (const it of real.slice(0, 12)) console.error(`    ${it.path || '?'}: ${it.message}`);
    failed += 1;
    continue;
  }

  // 2) normalizeAttack 不拋錯、關鍵欄位存在
  let normalized;
  try {
    normalized = normalizeAttack(attack);
  } catch (e) {
    console.error(`x ${label}: normalizeAttack 拋錯：${e.message}`);
    failed += 1;
    continue;
  }
  const duration = normalized && normalized.settings ? normalized.settings.duration : null;
  if (!Number.isFinite(duration) || duration <= 0) {
    console.error(`x ${label}: normalizeAttack 後沒有有效 duration`);
    failed += 1;
    continue;
  }

  // 3) 無頭模擬：preview 模式必須決定性；跑完整回合並抽查 seek
  const errors = [];
  let battle;
  try {
    battle = createBattle({ canvas: null, assets: null, mode: 'preview' });
    battle.on('error', (payload) => errors.push(payload));
    battle.load(attack);
    const fps = engine.FPS || 30;
    const totalFrames = Math.ceil(duration * fps);
    let last = null;
    let maxBullets = 0;
    for (let f = 0; f < totalFrames; f += 1) {
      battle.step(1);
      last = battle.getState();
      if (Array.isArray(last.bullets)) maxBullets = Math.max(maxBullets, last.bullets.length);
    }
    if (!last) throw new Error('getState 沒有回傳任何狀態');

    // seek 決定性：同一 frame 兩次 seek 的狀態應一致
    const targetFrame = Math.floor(totalFrames * 0.6);
    battle.seek(targetFrame);
    const s1 = battle.getState();
    battle.seek(targetFrame);
    const s2 = battle.getState();
    const sig = (s) =>
      JSON.stringify({
        f: s.frame,
        soul: s.soul && { x: s.soul.x, y: s.soul.y },
        bullets: (s.bullets || []).map((b) => [b.type, Math.round(b.x * 1000), Math.round(b.y * 1000)]),
      });
    const deterministic = sig(s1) === sig(s2);
    if (!deterministic) {
      console.error(`x ${label}: preview 模式 seek 不決定性（同一 frame 兩次結果不同）`);
      failed += 1;
      continue;
    }

    // 4) 生成欄位真的要生東西
    if (maxBullets === 0) {
      console.error(`x ${label}: 整回合都沒有子彈（棒讀 timeline 可能沒被消費）`);
      failed += 1;
      continue;
    }

    if (errors.length) {
      console.error(`x ${label}: 模擬期間發出 ${errors.length} 個 error 事件`);
      for (const e of errors.slice(0, 8)) console.error(`    ${JSON.stringify(e)}`);
      const texts = errors.map((e) => String((e && e.message) || ''));
      if (texts.some((m) => /is not a function|Cannot read properties of undefined/.test(m))) {
        console.error(
          '    提示：若錯誤集中在 rand / sin / cos / aim / box / soul 等「全部輔助函式都失效」，' +
            '多半是 engine/expr.js 的 new Function 參數表順序與呼叫實參順序不一致' +
            '（參數表先 SANDBOX_NAMES、呼叫先給 VAR/HELPER 實值）。這是 W1 的檔案，請回報 E1。',
        );
      }
      failed += 1;
      continue;
    }

    console.log(
      `OK ${label.padEnd(24)} duration=${duration}s frames=${totalFrames} 最大子彈數=${maxBullets} seek@${targetFrame} 決定性`,
    );
  } catch (e) {
    console.error(`x ${label}: 模擬失敗：${e.message}`);
    failed += 1;
  } finally {
    if (battle && typeof battle.destroy === 'function') {
      try {
        battle.destroy();
      } catch (_e) {
        /* 忽略 */
      }
    }
  }
}

const total = files.length;
if (warnings.length) {
  console.log(`\n警告 ${warnings.length} 則：`);
  for (const w of warnings) console.log(`  ! ${w}`);
}
console.log(`\n共 ${total} 個範例，失敗 ${failed} 個`);
process.exitCode = failed === 0 ? 0 : 1;
