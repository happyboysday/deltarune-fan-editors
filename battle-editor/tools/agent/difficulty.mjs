/**
 * tools/agent/difficulty.mjs — 難度分析（SPEC-AGENT §3）。
 *
 * 為什麼要有這支：
 *   「這樣會不會太難？」不能靠感覺。這裡用同一個攻擊、換多個亂數種子、讓 bot 各跑
 *   一次，得到受傷次數的分佈、每個時段的危險程度，再給人話建議。Agent 可以用它
 *   自我校準（改完參數 → 重跑 → 看分佈有沒有變合理）。
 *
 * 用法：
 *   node tools/agent/difficulty.mjs samples/spade-rain.json
 *   node tools/agent/difficulty.mjs attacks/xxx.json --runs 20 --json
 *   node tools/agent/difficulty.mjs samples/encounters/rudinn.json --runs 8 --bot dodge
 *   node tools/agent/difficulty.mjs <檔> --compare      # 同時印 idle 基準線
 *
 * 判定標準（可調，見 THRESHOLDS）：
 *   可通過 = 中位數受傷 <= 3 次 且 至少 20% 的種子能 0 受傷、且沒有「必死」時段
 *   （必須有某個種子能過 = 有解）。
 *
 * 輸出（--json）：{ file, kind, runs, bot, hits{dist}, damage{dist}, grazes, tpGained,
 *                  clearRate, passable, difficulty:'easy|normal|hard|extreme',
 *                  danger[{second, hits, bulletDensity, peakDensity}],
 *                  suggestions[], details[] }
 */

import {
  applyCliPaths,
  cliEntry,
  isFile,
  mean,
  numArg,
  parseArgs,
  percentile,
  readJSON,
  resolveInputFile,
  round,
} from './lib.mjs';
import { detectKind, normalizeAutoplayMode, simulate } from './sim.mjs';

/** 判定門檻（集中管理，方便之後調）。 */
export const THRESHOLDS = {
  /** 中位數受傷次數：<= easy 算簡單，<= normal 算正常，<= hard 算偏難，超過 = 極難。 */
  easyHits: 1,
  normalHits: 3,
  hardHits: 6,
  /**
   * 攻擊的「可通過」（passable）：中位數受傷不超過 passableHits、且至少 passableClearRate 比例的種子
   * 能 0 受傷（＝零傷率 zeroHitRate，舊名 clearRate）。注意這是「有沒有無傷路線」，不是「能不能通關」。
   */
  passableHits: 6,
  passableClearRate: 0.15,
  /** 遭遇的「可通過」：bot 把整場打完（victory / spared）的比例至少這麼多（＝通關率 completionRate）。 */
  passableCompletionRate: 0.5,
  /** 子彈密度（同時存在數）超過這個就視為「密集」。 */
  denseBullets: 45,
  /** 單一時段受傷超過這個次數 → 可能是「必死時段」。 */
  deathWindowHits: 4,
};

function dist(values) {
  const list = values.filter((v) => Number.isFinite(v));
  if (list.length === 0) {
    return { count: 0, min: 0, p25: 0, median: 0, mean: 0, p75: 0, p90: 0, max: 0 };
  }
  return {
    count: list.length,
    min: Math.min(...list),
    p25: round(percentile(list, 25), 2),
    median: round(percentile(list, 50), 2),
    mean: round(mean(list), 2),
    p75: round(percentile(list, 75), 2),
    p90: round(percentile(list, 90), 2),
    max: Math.max(...list),
  };
}

/** 把單次模擬的 trace 疊成「每秒」曲線。 */
function foldTrace(aggregate, trace) {
  for (const row of trace || []) {
    const second = Math.floor(numArg(row.time, 0));
    let bucket = aggregate.get(second);
    if (!bucket) {
      bucket = { second, bullets: [], hitsCum: [], grazesCum: [], tp: [] };
      aggregate.set(second, bucket);
    }
    bucket.bullets.push(numArg(row.bullets, 0));
    bucket.hitsCum.push(numArg(row.hits, 0));
    bucket.grazesCum.push(numArg(row.grazes, 0));
    bucket.tp.push(numArg(row.tp, 0));
  }
}

/**
 * 遭遇戰專屬的「整場」統計：逐回合受傷分佈、最危險回合、勝/饒恕/敗比例、總時長。
 *
 * 為什麼不只看整場：整場的中位數會被「這局只跑到第 2 回合」拉偏；逐回合才看得出
 * 是第幾回合在吃傷害（例如第 3 回合的彈幕太密）。
 */
function summarizeEncounter(results, runs) {
  const turnMap = new Map();
  for (const result of results) {
    for (const record of result.perTurn || []) {
      const key = numArg(record.turn, 0);
      let bucket = turnMap.get(key);
      if (!bucket) {
        bucket = { turn: key, attack: null, attacks: [], hits: [], damage: [], frames: [], commands: null };
        turnMap.set(key, bucket);
      }
      if (!bucket.attack && record.attack) bucket.attack = record.attack;
      // 這一回合實際播出的攻擊名稱（含回合內 attack cue；sim 的 perTurn[].attacks）
      for (const played of Array.isArray(record.attacks) ? record.attacks : []) {
        if (played && played.name && !bucket.attacks.includes(played.name)) bucket.attacks.push(played.name);
      }
      if (!bucket.attack && bucket.attacks.length > 0) bucket.attack = bucket.attacks[0];
      bucket.hits.push(numArg(record.hits, 0));
      bucket.damage.push(numArg(record.damageTaken, 0));
      bucket.frames.push(numArg(record.frames, 0));
      if (!bucket.commands && Array.isArray(record.commands) && record.commands.length > 0) {
        bucket.commands = record.commands.slice();
      }
    }
  }

  const turns = [...turnMap.values()]
    .sort((a, b) => a.turn - b.turn)
    .filter((bucket) => bucket.hits.length > 0)
    .map((bucket) => {
      const noHit = bucket.hits.filter((h) => h === 0).length;
      return {
        turn: bucket.turn,
        attack: bucket.attack,
        /** 這一回合實際播出的所有攻擊（含 attack cue）。 */
        attacks: bucket.attacks.slice(),
        runs: bucket.hits.length,
        hits: dist(bucket.hits),
        damage: dist(bucket.damage),
        /** 這一回合完全沒受傷的比例（0–1）。 */
        noHitRate: round(noHit / bucket.hits.length, 3),
        frames: round(mean(bucket.frames), 1),
        commands: bucket.commands,
      };
    });

  const rankedTurns = [...turns]
    .sort((a, b) => b.hits.mean - a.hits.mean || b.hits.max - a.hits.max || b.damage.mean - a.damage.mean)
    .slice(0, 3);
  // 「最危險回合」只在真的有受傷時才指名，否則整場偏安全（避免 0 傷也報第 1 回合最危險）。
  const mostDangerous = rankedTurns.find((row) => row.hits.max > 0) || null;

  const counts = { victory: 0, spared: 0, defeat: 0, flee: 0, timeout: 0 };
  for (const result of results) {
    const key = result.ended ? String(result.result || 'unknown') : 'timeout';
    if (counts[key] === undefined) counts[key] = 0;
    counts[key] += 1;
  }
  const rates = {};
  for (const [key, count] of Object.entries(counts)) rates[key] = round(count / runs, 3);

  const framesValues = results.map((r) => numArg(r.frames, 0));
  const duration = {
    frames: dist(framesValues),
    /** 換算成秒（30 FPS）。 */
    seconds: {
      mean: round(mean(framesValues) / 30, 2),
      max: round(Math.max(0, ...framesValues) / 30, 2),
    },
    timeoutRuns: counts.timeout || 0,
  };

  /** 通關率：bot 把整場打完（victory / spared）的比例。與「零傷率」是兩回事。 */
  const completionRate = round(((counts.victory || 0) + (counts.spared || 0)) / Math.max(1, runs), 3);

  return { turns, dangerTurns: rankedTurns, mostDangerous, outcome: { counts, rates }, completionRate, duration };
}

/** 回合的攻擊標籤：有名字用名字；有受傷卻查不到名字時不要寫成自相矛盾的「無攻擊」。 */
export function turnAttackLabel(row) {
  if (!row) return '';
  const names = Array.isArray(row.attacks) && row.attacks.length > 0 ? row.attacks : row.attack ? [row.attack] : [];
  const text = names.map((n) => (typeof n === 'string' ? n : '(inline)')).join('、');
  if (text) return text;
  return row.hits && row.hits.max > 0 ? '攻擊名稱不明' : '無攻擊';
}

/** 遭遇戰的建議（在共用建議之外補幾條）。 */
function buildEncounterSuggestions(encounter) {
  const tips = [];
  if (!encounter) return tips;
  const { turns, mostDangerous, outcome, duration } = encounter;
  if (mostDangerous && mostDangerous.hits.mean > 0.5) {
    tips.push(
      `最危險回合：第 ${mostDangerous.turn} 回合（${turnAttackLabel(mostDangerous)}）——` +
        `平均受傷 ${mostDangerous.hits.mean} 次、最多 ${mostDangerous.hits.max} 次、無傷率 ${round(mostDangerous.noHitRate * 100, 0)}%。`,
    );
  } else if (turns.length > 0) {
    tips.push('所有回合的平均受傷都 <= 0.5 次 → 以 bot 的判定整場偏安全。');
  }
  const hardTurns = turns.filter((row) => row.noHitRate === 0 && row.runs >= 2);
  if (hardTurns.length > 0) {
    tips.push(`完全沒有無傷紀錄的回合：${hardTurns.map((row) => `第 ${row.turn} 回合`).join('、')} → 這幾回的彈幕可能太密。`);
  }
  if (outcome.counts.timeout > 0) {
    tips.push(`有 ${outcome.counts.timeout} 次模擬在 ${round(duration.seconds.max, 1)} 秒內沒結束 → 可能卡在文字、選單或攻擊沒有收尾。`);
  }
  const total = Object.values(outcome.counts).reduce((sum, n) => sum + n, 0) || 1;
  const finishRate = (outcome.counts.victory + outcome.counts.spared + outcome.counts.defeat + outcome.counts.flee) / total;
  if (finishRate < 1) {
    tips.push(`只有 ${round(finishRate * 100, 0)}% 的模擬把整場打完；其餘逾時，建議檢查回合流程是否會卡住。`);
  }
  if (outcome.counts.defeat > 0) {
    tips.push(`有 ${outcome.counts.defeat}/${total} 次打到全滅 → 這樣對 bot 來說偏難（或 ATK 太高）。`);
  }
  return tips;
}


/** 依統計結果給建議（中文，直接可讀）。 */
function buildSuggestions(summary, dangerWindows, denseWindows = []) {
  const tips = [];
  const { hits, damage, clearRate, passable, difficulty, maxBullets, kind } = summary;

  if (difficulty === 'extreme') {
    tips.push(`中位數受傷 ${hits.median} 次、最多 ${hits.max} 次 → 對一般玩家過難。建議降低同時存在的子彈數、拉長發射間隔，或把傷害調低。`);
  } else if (difficulty === 'hard') {
    tips.push(`中位數受傷 ${hits.median} 次 → 偏難但可接受；若目標是「普通戰鬥」建議再放寬一點（例如每波少 1–2 發）。`);
  } else if (difficulty === 'easy') {
    tips.push(`中位數受傷 ${hits.median} 次 → 偏簡單；如果想要張力，可增加一波齊射或縮短間隔。`);
  } else {
    tips.push(`中位數受傷 ${hits.median} 次 → 落在正常區間。`);
  }

  if (clearRate >= 0.5) {
    tips.push(`${round(clearRate * 100, 0)}% 的種子可以完全不受傷（${Math.round(clearRate * summary.runs)}/${summary.runs}）→ 有明確的「完美閃避」路線，很好。`);
  } else if (clearRate > 0) {
    tips.push(`只有 ${round(clearRate * 100, 0)}% 的種子能 0 受傷 → 有解但很窄，可以考慮多留一條安全路線。`);
  } else if (kind === 'encounter') {
    tips.push('沒有任何種子能整場 0 受傷（零傷率 0%）→ 這只代表沒有「全程無傷」路線，與能不能通關無關（通關率見 encounter.completionRate）。');
  } else {
    tips.push('沒有任何種子能 0 受傷 → 目前沒有「完美閃避」路線；若是刻意設計的必中演出可忽略，否則建議檢查子彈密度或生成位置。');
  }

  if (!passable && kind !== 'encounter') {
    tips.push('以 bot 的判定，這段攻擊偏向「不可通過」（幾乎沒有無傷路線）：建議把傷害或密度調低一階，或延長無敵幀。');
  } else if (!passable) {
    tips.push('bot 多數種子沒辦法把整場打完（通關率偏低）：建議降低敵人 ATK／彈幕密度，或檢查流程是否卡住。');
  }

  if (maxBullets > THRESHOLDS.denseBullets) {
    tips.push(`同時存在子彈峰值 ${maxBullets} 發（超過建議的 ${THRESHOLDS.denseBullets}）→ 容易在低階裝置掉幀，也讓畫面擁擠。`);
  }

  for (const window of dangerWindows) {
    tips.push(
      `危險時段：第 ${window.second} 秒附近（該秒最多新增受傷 ${window.hits} 次、子彈密度 ${window.bulletDensity}）——` +
        '可考慮在這一波前後加 `clear` 事件或縮短持續時間。',
    );
  }

  for (const window of denseWindows) {
    tips.push(
      `畫面最擁擠：第 ${window.second} 秒（同時存在 ${window.bulletDensity} 發）——` +
        '若非刻意設計，可減少同時存在的數量以維持 30 FPS。',
    );
  }

  if (kind === 'encounter') {
    tips.push('提示：遭遇戰的難度也受回合長度與敵人 ATK 影響，這些數字只反映彈幕部分。');
  }

  return tips;
}

/**
 * 對單一檔案做難度分析。
 *
 * @param {string|object} target 檔案路徑或 JSON
 * @param {object} [options] { runs, bot, frames, seed, horizon, grazeBias, quiet }
 */
export async function analyzeDifficulty(target, options = {}) {
  let json = target;
  let file = null;
  if (typeof target === 'string') {
    file = resolveInputFile(target);
    if (!file) throw new Error(`找不到檔案：${target}`);
    json = readJSON(file);
  }
  const kind = detectKind(json);
  // 遭遇戰預設用自動演示的 bot（engine/autopilot 全 AI：會打選單、會躲彈幕）；
  // 攻擊維持舊的 dodge bot。明確給 --bot 或 --autoplay 時以使用者為準。
  const defaultBot = 'dodge';
  const runs = Math.max(1, Math.round(numArg(options.runs, 20)));
  const botKind = options.bot || defaultBot;
  // --autoplay demo|bot：遭遇到自動演示（demo 播作品錄好的輸入）。攻擊頁沒有 demo 輸入時
  // createAutopilot 會自己降級，這裡照樣傳進去即可。
  let autoplay = null;
  if (options.autoplay !== undefined && options.autoplay !== null && options.autoplay !== false) {
    autoplay = normalizeAutoplayMode(options.autoplay);
  } else if (kind === 'encounter' && !options.bot) {
    // 沒指定 --bot：遭遇預設走 autopilot bot（舊的 --bot 啟發式只會亂按，不適合整場分析）。
    autoplay = 'bot';
  }
  const variation = autoplay === 'bot' || (!autoplay && botKind === 'dodge') ? 2 : 0;
  const results = [];

  for (let run = 0; run < runs; run += 1) {
    // 換攻擊的亂數種子（決定子彈時序），bot 種子也跟著換（避免只擅長某一條路線）
    const seed = (numArg(options.seed, 1) + run) % 100000;
    const attempt = json && typeof json === 'object'
      ? { ...json, settings: { ...json.settings, seed } }
      : json;
    const result = await simulate(attempt, {
      frames: options.frames,
      bot: autoplay ? null : botKind,
      autoplay,
      seed,
      horizon: options.horizon,
      grazeBias: options.grazeBias,
      variation,
      inputs: options.inputs,
    });
    results.push(result);
    if (typeof options.onRun === 'function') options.onRun(run, result);
  }

  const hitsValues = results.map((r) => r.hits);
  const damageValues = results.map((r) => r.damageTaken);
  const grazeValues = results.map((r) => r.grazes);
  const tpValues = results.map((r) => r.tpGained);
  const bulletPeaks = results.map((r) => r.maxBullets);
  const clearRuns = hitsValues.filter((h) => h === 0).length;
  const clearRate = clearRuns / runs;

  const hits = dist(hitsValues);
  const damage = dist(damageValues);
  const grazes = dist(grazeValues);
  const tpGained = dist(tpValues);
  const maxBullets = Math.max(0, ...bulletPeaks);

  let difficulty = 'extreme';
  if (hits.median <= THRESHOLDS.easyHits && clearRate >= 0.5) difficulty = 'easy';
  else if (hits.median <= THRESHOLDS.normalHits) difficulty = 'normal';
  else if (hits.median <= THRESHOLDS.hardHits) difficulty = 'hard';

  // passable 的定義依種類不同（REALTEST-2 V3）：
  //   攻擊：中位數受傷 <= passableHits 且零傷率 >= passableClearRate（有沒有無傷路線）
  //   遭遇：通關率（victory + spared）>= passableCompletionRate（bot 能不能把整場打完）
  const zeroHitPct = round(clearRate * 100, 0);
  let passable = hits.median <= THRESHOLDS.passableHits && clearRate >= THRESHOLDS.passableClearRate;
  let passableReason =
    `攻擊判定：中位數受傷 ${hits.median}（門檻 <= ${THRESHOLDS.passableHits}）` +
    `、零傷率 ${zeroHitPct}%（門檻 >= ${round(THRESHOLDS.passableClearRate * 100, 0)}%）`;

  // 每秒曲線
  const aggregate = new Map();
  let maxSecond = 0;
  for (const result of results) {
    foldTrace(aggregate, result.trace);
    for (const row of result.trace || []) maxSecond = Math.max(maxSecond, Math.floor(numArg(row.time, 0)));
  }
  const danger = [];
  for (let s = 0; s <= maxSecond; s += 1) {
    const bucket = aggregate.get(s);
    if (!bucket) continue;
    const previous = aggregate.get(s - 1);
    // trace 的 hits 是「累計」，這裡換算成該秒新增（跨 run 取最大值）
    let hitsThisSecond = 0;
    for (let i = 0; i < bucket.hitsCum.length; i += 1) {
      const prevCum = previous && previous.hitsCum[i] !== undefined ? previous.hitsCum[i] : 0;
      hitsThisSecond = Math.max(hitsThisSecond, bucket.hitsCum[i] - prevCum);
    }
    const averageBullets = round(mean(bucket.bullets), 1);
    danger.push({
      second: s,
      hits: Math.max(0, hitsThisSecond),
      bulletDensity: averageBullets,
      peakDensity: Math.max(0, ...bucket.bullets),
    });
  }

  // 危險時段：該秒受傷次數最多（且 >= 2）的前 3 名
  const ranked = [...danger]
    .filter((row) => row.hits >= 2)
    .sort((a, b) => b.hits - a.hits || b.bulletDensity - a.bulletDensity)
    .slice(0, 3);
  const denseWindows = [...danger]
    .sort((a, b) => b.bulletDensity - a.bulletDensity)
    .slice(0, 3)
    .filter((row) => row.bulletDensity >= THRESHOLDS.denseBullets * 0.8 && !ranked.includes(row));

  // ---------------------------------------------------------- 遭遇戰整場統計
  // 遭遇不是「一段彈幕」而是「一整場戰鬥」：除了總傷害，還要看逐回合分佈、
  // 勝/饒恕/敗比例與總時長。
  const encounter = kind === 'encounter' ? summarizeEncounter(results, runs) : null;
  if (encounter) {
    passable = encounter.completionRate >= THRESHOLDS.passableCompletionRate;
    passableReason =
      `遭遇判定：通關率 ${round(encounter.completionRate * 100, 0)}%（victory＋spared，門檻 >= ${round(THRESHOLDS.passableCompletionRate * 100, 0)}%）` +
      `；零傷率 ${zeroHitPct}%、中位數受傷 ${hits.median} 僅供參考`;
  }

  const summary = {
    kind: results[0] ? results[0].kind : 'attack',
    name: results[0] ? results[0].name : null,
    runs,
    bot: autoplay ? null : botKind,
    autoplay: autoplay || null,
    botVariation: variation > 0 ? { horizonFrames: 2, scoreRange: variation } : null,
    hits,
    damage,
    grazes,
    tpGained,
    maxBullets,
    /** 零傷率：整段（整場）完全沒受傷的種子數／比例。 */
    zeroHitRuns: clearRuns,
    zeroHitRate: round(clearRate, 3),
    /** 舊名（= zeroHitRuns / zeroHitRate）；不是「通關率」——遭遇的通關率在 encounter.completionRate。 */
    clearRuns,
    clearRate: round(clearRate, 3),
    /** 遭遇才有：bot 把整場打完（victory / spared）的比例；攻擊為 null。 */
    completionRate: encounter ? encounter.completionRate : null,
    passable,
    /** passable 是怎麼判的（一句話，含實際數字與門檻）。 */
    passableReason,
    difficulty,
    frames: results[0] ? results[0].frames : 0,
  };

  const suggestions = buildSuggestions(summary, ranked, denseWindows);
  if (encounter) suggestions.push(...buildEncounterSuggestions(encounter));
  const errors = [];
  for (const result of results) {
    for (const err of result.errors || []) if (!errors.includes(err)) errors.push(err);
  }

  return {
    file,
    ...summary,
    errors,
    danger,
    dangerWindows: ranked,
    denseWindows,
    /** 僅遭遇戰：逐回合受傷分佈、最危險回合、勝/饒恕/敗比例、總時長。 */
    encounter,
    suggestions,
    details: results.map((r, index) => ({
      run: index + 1,
      seed: (numArg(options.seed, 1) + index) % 100000,
      frames: r.frames,
      ended: r.ended,
      result: r.result,
      hits: r.hits,
      grazes: r.grazes,
      damageTaken: r.damageTaken,
      tpGained: r.tpGained,
      maxBullets: r.maxBullets,
      avgBullets: r.avgBullets,
      party: r.party,
      ...(kind === 'encounter'
        ? {
            turns: (r.perTurn || []).map((record) => ({
              turn: record.turn,
              attack: record.attack,
              attacks: (record.attacks || []).map((a) => a.name),
              hits: record.hits,
              damageTaken: record.damageTaken,
              frames: record.frames,
              commands: record.commands,
            })),
          }
        : {}),
    })),
  };
}

/* --------------------------------------------------------------- CLI */

function printBar(value, max, width = 20) {
  if (max <= 0) return '';
  const n = Math.round((value / max) * width);
  return '█'.repeat(Math.max(0, n));
}

async function main() {
  try {
    applyCliPaths(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  const args = parseArgs(process.argv.slice(2), [
    'runs',
    'bot',
    'autoplay',
    'frames',
    'seed',
    'horizon',
    'graze-bias',
    'compare',
    'root',
    'works',
  ], { booleanFlags: ['compare'] });
  const input = args._[0];
  if (!input) {
    console.error(
      '用法：node tools/agent/difficulty.mjs <攻擊檔|遭遇檔> [--runs 20] [--bot dodge] [--autoplay demo|bot] [--root DIR] [--works DIR] [--json] [--compare]',
    );
    process.exitCode = 2;
    return;
  }
  const runs = Math.max(1, Math.round(numArg(args.runs, 20)));
  const isJson = Boolean(args.json);
  const progress = (run, result) => {
    if (!isJson && runs >= 5 && process.stderr.isTTY && (run + 1) % Math.ceil(runs / 10) === 0) {
      process.stderr.write(`\r模擬中 ${run + 1}/${runs}`);
    }
    void result;
  };
  const options = {
    runs,
    // 遭遇戰預設走 bot（全 AI）；攻擊維持 dodge（analyzeDifficulty 內自動判斷）。
    bot: args.bot === true ? 'dodge' : args.bot || undefined,
    autoplay: args.autoplay === undefined ? null : args.autoplay === true ? 'bot' : args.autoplay,
    frames: args.frames !== undefined ? Math.max(1, Math.round(numArg(args.frames, 0))) : 0,
    seed: numArg(args.seed, 1),
    horizon: numArg(args.horizon, 14),
    grazeBias: numArg(args['graze-bias'], 0),
    onRun: progress,
  };
  const started = Date.now();
  const report = await analyzeDifficulty(input, options);
  if (!isJson && runs >= 5) process.stderr.write('\r'.padEnd(24) + '\r');

  let baseline = null;
  if (args.compare) {
    baseline = await analyzeDifficulty(input, { ...options, bot: 'idle', autoplay: null, onRun: null });
  }

  if (isJson) {
    console.log(JSON.stringify({ ...report, baseline }, null, 2));
    return;
  }

  const icon = { easy: '🟢', normal: '🔵', hard: '🟠', extreme: '🔴' }[report.difficulty] || '⚪';
  console.log(`難度分析：${report.file ? report.file.split(/[\\/]/).pop() : input}${report.name ? `（${report.name}）` : ''}`);
  const driver = report.autoplay ? `autoplay=${report.autoplay}` : `bot=${report.bot}`;
  console.log(`跑 ${report.runs} 次（${driver}，每次換亂數種子）× ${report.frames} 幀，耗時 ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (report.botVariation) {
    const { horizonFrames, scoreRange } = report.botVariation;
    console.log(`AI 變異：前瞻 ±${horizonFrames} 幀、決策評分 ±${scoreRange / 2}`);
  }
  console.log('');
  console.log(`${icon} 難度：${report.difficulty}　可通過：${report.passable ? '是' : '否'}（${report.passableReason}）`);
  console.log(`受傷次數：中位數 ${report.hits.median}、平均 ${report.hits.mean}、範圍 ${report.hits.min}–${report.hits.max}（p90 ${report.hits.p90}）`);
  console.log(`零傷率（0 受傷）：${report.zeroHitRuns}/${report.runs}（${round(report.zeroHitRate * 100, 0)}%）`);
  if (report.completionRate !== null) console.log(`通關率（victory＋spared）：${round(report.completionRate * 100, 0)}%`);
  console.log(`傷害：中位數 ${report.damage.median}、最大 ${report.damage.max}`);
  console.log(`擦彈：中位數 ${report.grazes.median}　TP：中位數 +${report.tpGained.median}`);
  if (baseline) {
    console.log(`基準線（idle 不動）：受傷中位數 ${baseline.hits.median} → bot 減少 ${baseline.hits.median - report.hits.median} 次`);
  }

  if (report.encounter) {
    printEncounterReport(report);
  } else {
    console.log('');
    console.log('每秒危險曲線（受傷=該秒新增，密度=同時存在子彈）：');
    const peakDensity = Math.max(1, ...report.danger.map((d) => d.bulletDensity));
    const peakHits = Math.max(1, ...report.danger.map((d) => d.hits));
    for (const row of report.danger) {
      const flag = row.hits >= 2 ? ' ⚠' : '';
      console.log(
        `  ${String(row.second).padStart(2)}s  ${String(row.hits).padStart(2)} 傷 ${printBar(row.hits, peakHits, 8).padEnd(8)}  ` +
          `密度 ${String(row.bulletDensity).padStart(5)} ${printBar(row.bulletDensity, peakDensity, 14)}${flag}`,
      );
    }
  }

  console.log('');
  console.log('建議：');
  for (const tip of report.suggestions) console.log(`  - ${tip}`);
  if (report.errors.length > 0) {
    console.log('');
    console.log(`錯誤 ${report.errors.length} 筆：`);
    for (const err of report.errors.slice(0, 10)) console.log(`  - ${err}`);
  }
}

/** 遭遇戰的整場報告（逐回合分佈、結局比例、總時長）。 */
function printEncounterReport(report) {
  const encounter = report.encounter;
  const outcome = encounter.outcome;
  const total = Object.values(outcome.counts).reduce((sum, n) => sum + n, 0) || 1;
  const rate = (key) => `${outcome.counts[key] || 0}/${total}（${round((outcome.rates[key] || 0) * 100, 0)}%）`;
  console.log('');
  console.log('整場：');
  console.log(
    `  結局：勝利 ${rate('victory')}　饒恕 ${rate('spared')}　敗北 ${rate('defeat')}　逃走 ${rate('flee')}　逾時 ${rate('timeout')}`,
  );
  console.log(
    `  總時長：平均 ${encounter.duration.seconds.mean}s、最長 ${encounter.duration.seconds.max}s（上限 ${report.frames} 幀）`,
  );
  if (encounter.mostDangerous) {
    const d = encounter.mostDangerous;
    console.log(
      `  最危險回合：第 ${d.turn} 回合（${turnAttackLabel(d)}）——平均受傷 ${d.hits.mean}、最多 ${d.hits.max}、無傷率 ${round(d.noHitRate * 100, 0)}%`,
    );
  }

  console.log('');
  console.log('逐回合（受傷=平均/最大，無傷=完全沒受傷的比例）：');
  console.log('  回合  攻擊              受傷(平/大)  傷害(平/大)  無傷率  平均幀數');
  for (const row of encounter.turns) {
    console.log(
      `  ${String(row.turn).padStart(4)}  ${String(turnAttackLabel(row) === '無攻擊' ? '-' : turnAttackLabel(row)).padEnd(16)}  ` +
        `${`${row.hits.mean}/${row.hits.max}`.padStart(11)}  ${`${row.damage.mean}/${row.damage.max}`.padStart(11)}  ` +
        `${`${round(row.noHitRate * 100, 0)}%`.padStart(6)}  ${String(row.frames).padStart(8)}`,
    );
  }
}

if (cliEntry(import.meta.url)) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : String(err));
    process.exitCode = 1;
  });
}

export default analyzeDifficulty;
