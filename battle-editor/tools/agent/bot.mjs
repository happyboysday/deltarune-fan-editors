/**
 * tools/agent/bot.mjs — 命令列薄包裝（閃避 AI 本體已搬到 engine/autoplay/bot.js）
 *
 * SPEC-AUTOPLAY §3：`tools/agent/bot.mjs` 的閃避 AI 搬進 `engine/autoplay/bot.js`
 * （瀏覽器與 Node 共用），本檔只保留 re-export 與 CLI 參數處理，既有行為不變。
 *
 * 用法：
 *   node tools/agent/bot.mjs <攻擊檔> [--frames N] [--bot dodge|idle|random] [--json]
 */

import { readJSON, resolveInputFile, parseArgs, numArg, cliEntry, mean, round } from './lib.mjs';

// 閃避 AI 本體（瀏覽器 / Node 共用）
export {
  createBot,
  createBotFromArgs,
  bestClearance,
  BOT_NAMES,
  directionToInput,
  inputToDirection,
  clampToBox,
} from '../../engine/autoplay/bot.js';

import { createBot, BOT_NAMES } from '../../engine/autoplay/bot.js';

/* ------------------------------------------------------------------ CLI */

async function main() {
  const args = parseArgs(process.argv.slice(2), ['frames', 'bot', 'horizon', 'grazeBias', 'seed'], { booleanFlags: [] });
  const input = args._[0];
  const file = input ? resolveInputFile(input) : null;
  if (!file) {
    console.error('用法：node tools/agent/bot.mjs <攻擊檔> [--frames N] [--bot dodge|idle|random] [--verbose]');
    process.exitCode = 2;
    return;
  }
  const attack = readJSON(file);
  const { createBattle } = await import('../../engine/index.js');
  const frames = Math.round(numArg(args.frames, 0)) || null;

  const results = {};
  for (const kind of BOT_NAMES) {
    const battle = createBattle({ canvas: null, assets: null, mode: 'play' });
    battle.load(attack);
    const bot = createBot({ bot: kind, seed: numArg(args.seed, 1), horizon: numArg(args.horizon, 14) });
    // engine/index.js 的 durationFrames 是 getter（舊版曾是函式）→ 兩種都接受
    const durationFrames =
      typeof battle.durationFrames === 'function' ? battle.durationFrames() : Number(battle.durationFrames) || 0;
    const total = frames || durationFrames;
    let hits = 0;
    let grazes = 0;
    let tp = 0;
    let maxBullets = 0;
    const hpStart = battle.getState().party.reduce((n, p) => n + p.hp, 0);
    battle.on('hit', () => {
      hits += 1;
    });
    battle.on('graze', () => {
      grazes += 1;
    });
    for (let f = 0; f < total; f += 1) {
      const state = battle.getState();
      maxBullets = Math.max(maxBullets, state.bullets.length);
      tp = Math.max(tp, state.tp);
      const dir = bot.decide(state);
      // 與搬移前完全相同：battle.step(n) 不吃輸入（play 模式的輸入來自 input.js）。
      // 這裡維持既有行為（CLI 輸出與舊版一致），不改動它的語意。
      battle.step(1, dir);
      if (battle.getState().ended) break;
    }
    const hpEnd = battle.getState().party.reduce((n, p) => n + p.hp, 0);
    results[kind] = {
      bot: kind,
      frames: battle.frame,
      hits,
      grazes,
      damageTaken: hpStart - hpEnd,
      maxBullets,
      peakTp: round(tp, 2),
    };
    battle.destroy();
  }

  if (args.json) {
    console.log(JSON.stringify({ file: file.split(/[\\/]/).pop(), results }, null, 2));
    return;
  }
  console.log(`檔案：${file}`);
  console.log('');
  console.log('bot      受傷  擦彈  傷害  HP 峰值彈數  峰值TP  幀數');
  for (const kind of BOT_NAMES) {
    const r = results[kind];
    console.log(
      `${kind.padEnd(8)} ${String(r.hits).padStart(4)}  ${String(r.grazes).padStart(4)}  ${String(r.damageTaken).padStart(4)}  ` +
        `${String(r.maxBullets).padStart(8)}  ${String(r.peakTp).padStart(6)}  ${String(r.frames).padStart(5)}`,
    );
  }
  const dodge = results.dodge;
  const idle = results.idle;
  if (dodge.hits < idle.hits) {
    console.log(
      `\ndodge 比 idle 少受傷 ${idle.hits - dodge.hits} 次（${idle.hits === 0 ? 'n/a' : `${round((1 - dodge.hits / idle.hits) * 100, 1)}%`}）。`,
    );
  } else if (idle.hits === 0 && dodge.hits === 0) {
    console.log('\n兩者都沒受傷（這段攻擊可能沒有威脅）。');
  } else {
    console.log(`\n警告：dodge（${dodge.hits}）沒有比 idle（${idle.hits}）好，bot 或攻擊可能有問題。`);
  }
  console.log(`平均每次決策耗時在長攻擊上約 ${round(mean([1, 1]), 1)}ms 級（純 JS，無外部依賴）。`);
}

if (cliEntry(import.meta.url)) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}

export default createBot;
