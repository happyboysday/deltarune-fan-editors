/**
 * editor/locales/encounter-timeline.js  (V2-07)
 *
 * 遭遇編輯器「時間軸總覽」分頁的介面字串。命名空間：encTimeline。
 * 三語鍵集合必須一致（editor/encounter/timeline.test.mjs 會檢查）。
 */

export const LOCALE_IDS = ['zh-Hant', 'zh-Hans', 'en'];

export const NAMESPACES = ['encTimeline'];

const ZH_HANT = {
  tab: '時間軸',
  mode: '模式',
  modeDemo: 'demo（照 demo 腳本）',
  modeBot: 'bot（全 FIGHT＋AI 閃避）',
  modeHint: '跑一次 headless 模擬取得實際時間；demo 需要 demo 腳本，bot 忽略 demo。',
  refresh: '重新模擬',
  legendSay: '台詞',
  legendAttack: '彈幕',
  legendCue: 'cue',
  loading: '正在跑 headless 模擬……',
  noDoc: '尚未載入遭遇資料',
  empty: '這個遭遇還沒有回合。',
  noTurns: '沒有可顯示的回合',
  turnsShort: '{n} 回合',
  badgeSim: '實際模擬',
  stale: '資料已變更——按「重新模擬」更新時間軸',
  totals: '合計：{turns} 回合 · {frames} 幀 · {time}',
  statusSim: '實際模擬 {frames} 幀 · 結果 {result}',
  statusIncomplete: '已模擬 {frames} 幀 · 尚未到達結局',
  statusEst: '估算（模擬不可用）· {turns} 回合',
  attack: '彈幕',
  say: '台詞',
  noCues: '（沒有 cue 標記）',
  bpm: '{bpm} BPM',
  missingAttack: '找不到攻擊檔（長度用估算）',
  warnPilot: '自動操作不可用：{reason}',
  warnAttack: '找不到攻擊檔 {name}（第 {turn} 回合）',
  warnPartial: '模擬只跑到 {have}/{want} 回合',
  warnLoad: '載入問題：{reason}',
  warnEngine: '模擬時引擎回報錯誤：{reason}',
  scrollHint: '↕ 可捲動 · 拖曳上緣調整高度',
  jumpHint: '跳到第 {turn} 回合',
  jumped: '已跳到第 {turn} 回合',
};

const ZH_HANS = {
  tab: '时间轴',
  mode: '模式',
  modeDemo: 'demo（照 demo 脚本）',
  modeBot: 'bot（全 FIGHT＋AI 闪避）',
  modeHint: '跑一次 headless 模拟取得实际时间；demo 需要 demo 脚本，bot 忽略 demo。',
  refresh: '重新模拟',
  legendSay: '台词',
  legendAttack: '弹幕',
  legendCue: 'cue',
  loading: '正在跑 headless 模拟……',
  noDoc: '尚未载入遭遇数据',
  empty: '这个遭遇还没有回合。',
  noTurns: '没有可显示的回合',
  turnsShort: '{n} 回合',
  badgeSim: '实际模拟',
  stale: '数据已变更——按「重新模拟」更新时间轴',
  totals: '合计：{turns} 回合 · {frames} 帧 · {time}',
  statusSim: '实际模拟 {frames} 帧 · 结果 {result}',
  statusIncomplete: '已模拟 {frames} 帧 · 尚未到达结局',
  statusEst: '估算（模拟不可用）· {turns} 回合',
  attack: '弹幕',
  say: '台词',
  noCues: '（没有 cue 标记）',
  bpm: '{bpm} BPM',
  missingAttack: '找不到攻击文件（长度用估算）',
  warnPilot: '自动操作不可用：{reason}',
  warnAttack: '找不到攻击文件 {name}（第 {turn} 回合）',
  warnPartial: '模拟只跑到 {have}/{want} 回合',
  warnLoad: '载入问题：{reason}',
  warnEngine: '模拟时引擎报告错误：{reason}',
  scrollHint: '↕ 可滚动 · 拖动上缘调整高度',
  jumpHint: '跳到第 {turn} 回合',
  jumped: '已跳到第 {turn} 回合',
};

const EN = {
  tab: 'Timeline',
  mode: 'Mode',
  modeDemo: 'demo (follow demo script)',
  modeBot: 'bot (all FIGHT + AI dodge)',
  modeHint: 'Runs one headless simulation for real timings; demo needs a demo script, bot ignores it.',
  refresh: 'Re-simulate',
  legendSay: 'Dialogue',
  legendAttack: 'Attack',
  legendCue: 'cue',
  loading: 'Running headless simulation…',
  noDoc: 'No encounter loaded',
  empty: 'This encounter has no turns yet.',
  noTurns: 'No turns to show',
  turnsShort: '{n} turns',
  badgeSim: 'simulated',
  stale: 'Data changed — press "Re-simulate" to update the timeline',
  totals: 'Total: {turns} turns · {frames} frames · {time}',
  statusSim: 'Simulated {frames} frames · result {result}',
  statusIncomplete: 'Simulated {frames} frames · no ending reached',
  statusEst: 'Estimated (simulation unavailable) · {turns} turns',
  attack: 'Attack',
  say: 'Dialogue',
  noCues: '(no cue markers)',
  bpm: '{bpm} BPM',
  missingAttack: 'Attack file not found (duration estimated)',
  warnPilot: 'Autopilot unavailable: {reason}',
  warnAttack: 'Attack file {name} not found (turn {turn})',
  warnPartial: 'Simulation reached only {have}/{want} turns',
  warnLoad: 'Load problem: {reason}',
  warnEngine: 'Engine error during simulation: {reason}',
  scrollHint: '↕ Scrollable · drag the top edge to resize',
  jumpHint: 'Jump to turn {turn}',
  jumped: 'Jumped to turn {turn}',
};

export const STRINGS = {
  'zh-Hant': ZH_HANT,
  'zh-Hans': ZH_HANS,
  en: EN,
};

export default STRINGS;

/** 三語鍵集合一致性檢查（測試用）。 */
export function findKeyMismatches(strings = STRINGS) {
  const out = [];
  const ids = Object.keys(strings);
  const union = new Set();
  for (const id of ids) for (const key of Object.keys(strings[id] || {})) union.add(key);
  for (const key of union) {
    for (const id of ids) {
      if (!(key in (strings[id] || {}))) out.push({ lang: id, key, reason: 'missing' });
    }
  }
  return out;
}
