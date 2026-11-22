/**
 * editor/locales/encounter-demo.js — 遭遇編輯器「演示」面板與自動播放字串（AP2）
 *
 * SPEC-AUTOPLAY §4：遭遇編輯器的「演示」面板（文字自動、menuDelay、每回合卡片、
 * default 卡片）與預覽工具列「自動」開關（腳本 / AI / 關）。
 *
 * 使用新命名空間，避免與其他人的字串表衝突：
 *   encdemo  ← 「演示」面板
 *   encauto  ← 預覽工具列「自動」開關與狀態
 *
 * 慣例同其他字串表：
 *   - 三語（zh-Hant / zh-Hans / en）鍵集合必須完全一致（本檔 findKeyMismatches 會檢查）
 *   - zh-Hans 使用大陸慣用詞，不得混入繁體專用字
 *   - en 不含中日韓字元
 *   - 不翻譯：JSON 欄位名（demo、turns、choices、menuDelay、fight、dodge…）、
 *             模式識別字（path / inputs / bot / none / perfect / good / ok / miss）、
 *             指令識別字（fight / act / magic / item / spare / defend）
 */

import * as i18n from '../i18n.js';

export const LOCALE_IDS = ['zh-Hant', 'zh-Hans', 'en'];
export const NAMESPACES = ['encdemo', 'encauto', 'encanim'];

const ZH_HANT = {
  encdemo: {
    tab: '演示',
    tabCues: '指令清單',
    title: '演示 demo',
    aria: '遭遇演示腳本',
    hint: 'demo 只影響預覽工具列的「自動」；關閉自動時完全等同手動遊玩。',

    /* ---- 文字與節奏 ---- */
    settingsTitle: '文字與節奏',
    auto: '文字自動前進',
    autoHint: '文字／泡泡打完後等 {delay} 秒按確認；關閉時不會自動按。',
    delay: '延遲（秒）',
    menuDelay: '選單間隔（幀）',
    menuDelayHint: '0 = 每幀都按（最快）；6 約 0.2 秒，看得到游標移動。',

    /* ---- 回合卡 ---- */
    turnsTitle: '回合腳本',
    addTurn: '＋ 新增回合卡',
    empty: '還沒有任何回合卡',
    emptySub: '沒有列在卡片裡的回合會使用下方的「預設卡片」。',
    cardTitle: '第 {n} 回合',
    scriptedRounds: '已設定 {n} 輪',
    turnNo: '回合',
    remove: '刪除此回合卡',
    up: '上移',
    down: '下移',
    member: '隊員',
    command: '指令',
    target: '對象',
    option: '選項',
    fight: '打擊條',
    dodge: '躲避',
    unset: '（未指定）',
    noTarget: '（不需要）',
    noOptions: '（沒有可用選項）',
    optionMissing: '找不到「{name}」',
    targetEnemy: '敵人',
    targetParty: '隊員',
    targetEither: '敵人／隊員',

    /* ---- 預設卡片 ---- */
    defaultCardTitle: '預設卡片',
    defaultHint: '沒列在回合卡裡的回合／隊員都用這張卡。',
    defaultChoices: '全員指令',
    defaultFight: '預設打擊條',
    defaultDodge: '預設躲避',
    defaultCustom: '自訂陣列（{n} 筆）',

    /* ---- 錯誤 ---- */
    errorsTitle: '演示錯誤',
    errorsCount: '{n} 項',
    errorsNone: '沒有演示錯誤',
    errorsHint: '呈現路徑與訊息；點一下可跳到該欄位。',
    jump: '定位',

    /* ---- 列舉標籤（F3：下拉改短標籤，完整說明放 title，三語都不截斷） ---- */
    'fight.perfect': 'perfect',
    'fight.good': 'good',
    'fight.ok': 'ok',
    'fight.miss': 'miss',
    'fight.full.perfect': 'perfect（正中最準）',
    'fight.full.good': 'good（不錯，稍偏但仍高分）',
    'fight.full.ok': 'ok（勉強命中）',
    'fight.full.miss': 'miss（故意失手）',
    'fight.full.number': '0..1：自己指定命中時機（0 = 最早、1 = 最晚）',
    'dodge.path': 'path',
    'dodge.inputs': 'inputs',
    'dodge.bot': 'bot',
    'dodge.none': 'none',
    'dodge.full.path': 'path（照攻擊檔錄好的路徑）',
    'dodge.full.inputs': 'inputs（照錄製的輸入閃避）',
    'dodge.full.bot': 'bot（讓機器人自動閃避）',
    'dodge.full.none': 'none（完全不動，站著挨打）',
    'command.fight': 'fight 戰鬥',
    'command.act': 'act 行動',
    'command.magic': 'magic 魔法',
    'command.item': 'item 道具',
    'command.spare': 'spare 饒恕',
    'command.defend': 'defend 防禦',

    /* ---- 復原標籤 ---- */
    undoAddTurn: '新增演示回合卡',
    undoRemoveTurn: '刪除演示回合卡',
    undoMoveTurn: '移動演示回合卡',
    undoChoice: '編輯演示選擇',
    undoCard: '編輯演示回合卡',
    undoDefault: '編輯演示預設卡片',
    undoSettings: '編輯演示設定',
  },

  encauto: {
    tab: '自動',
    title: '自動演示：關 / 腳本 / AI（只把輸入餵給引擎，不改狀態）',
    off: '關',
    demo: '腳本',
    bot: 'AI',
    status: 'AUTO · {mode}',
    statusDetail: 'T{turn} · {step}',
    stepIdle: '待命',
    stepMenu: '選單',
    stepText: '文字',
    stepFight: '打擊',
    stepDodge: '躲避',
    loading: '自動演示載入中…',
    failed: '自動演示無法啟動',
    warnings: '{n} 個提示',
    restartNotice: '自動已開：由開頭重播（維持決定性）',
    modeNotice: '自動模式：{mode}',
    waiting: '等待引擎就緒…',
  },

  encanim: {
    scale: '縮放 scale',
    scaleHint: '乘上演員本身的 scale；留空 = 1（不縮放）。',
    flip: '翻轉 flip',
    flipInherit: '（沿用演員）',
    flipOn: '翻轉',
    flipOff: '不翻轉',
    flipHint: '省略 = 沿用演員的 flip；只有這個狀態要鏡像時才設定。',
  },
};

const ZH_HANS = {
  encdemo: {
    tab: '演示',
    tabCues: '指令清单',
    title: '演示 demo',
    aria: '遭遇演示脚本',
    hint: 'demo 只影响预览工具栏的「自动」；关闭自动时完全等同手动游玩。',

    settingsTitle: '文字与节奏',
    auto: '文字自动前进',
    autoHint: '文字／气泡打完后等 {delay} 秒按确认；关闭时不会自动按。',
    delay: '延迟（秒）',
    menuDelay: '菜单间隔（帧）',
    menuDelayHint: '0 = 每帧都按（最快）；6 约 0.2 秒，看得到光标移动。',

    turnsTitle: '回合脚本',
    addTurn: '＋ 新增回合卡',
    empty: '还没有任何回合卡',
    emptySub: '没有列在卡片里的回合会使用下方的「默认卡片」。',
    cardTitle: '第 {n} 回合',
    scriptedRounds: '已设置 {n} 轮',
    turnNo: '回合',
    remove: '删除此回合卡',
    up: '上移',
    down: '下移',
    member: '队员',
    command: '指令',
    target: '对象',
    option: '选项',
    fight: '打击条',
    dodge: '躲避',
    unset: '（未指定）',
    noTarget: '（不需要）',
    noOptions: '（没有可用选项）',
    optionMissing: '找不到「{name}」',
    targetEnemy: '敌人',
    targetParty: '队员',
    targetEither: '敌人／队员',

    defaultCardTitle: '默认卡片',
    defaultHint: '没列在回合卡里的回合／队员都用这张卡。',
    defaultChoices: '全员指令',
    defaultFight: '默认打击条',
    defaultDodge: '默认躲避',
    defaultCustom: '自定义数组（{n} 笔）',

    errorsTitle: '演示错误',
    errorsCount: '{n} 项',
    errorsNone: '没有演示错误',
    errorsHint: '显示路径与消息；点一下可跳到该字段。',
    jump: '定位',

    'fight.perfect': 'perfect',
    'fight.good': 'good',
    'fight.ok': 'ok',
    'fight.miss': 'miss',
    'fight.full.perfect': 'perfect（正中最准）',
    'fight.full.good': 'good（不错，稍偏但仍高分）',
    'fight.full.ok': 'ok（勉强命中）',
    'fight.full.miss': 'miss（故意失手）',
    'fight.full.number': '0..1：自己指定命中时机（0 = 最早、1 = 最晚）',
    'dodge.path': 'path',
    'dodge.inputs': 'inputs',
    'dodge.bot': 'bot',
    'dodge.none': 'none',
    'dodge.full.path': 'path（照攻击文件录好的路径）',
    'dodge.full.inputs': 'inputs（照录制的输入闪避）',
    'dodge.full.bot': 'bot（让机器人自动闪避）',
    'dodge.full.none': 'none（完全不动，站着挨打）',
    'command.fight': 'fight 战斗',
    'command.act': 'act 行动',
    'command.magic': 'magic 魔法',
    'command.item': 'item 道具',
    'command.spare': 'spare 饶恕',
    'command.defend': 'defend 防御',

    undoAddTurn: '新增演示回合卡',
    undoRemoveTurn: '删除演示回合卡',
    undoMoveTurn: '移动演示回合卡',
    undoChoice: '编辑演示选择',
    undoCard: '编辑演示回合卡',
    undoDefault: '编辑演示默认卡片',
    undoSettings: '编辑演示设置',
  },

  encauto: {
    tab: '自动',
    title: '自动演示：关闭 / 脚本 / AI（只把输入喂给引擎，不改状态）',
    off: '关闭',
    demo: '脚本',
    bot: 'AI',
    status: 'AUTO · {mode}',
    statusDetail: 'T{turn} · {step}',
    stepIdle: '待命',
    stepMenu: '菜单',
    stepText: '文字',
    stepFight: '打击',
    stepDodge: '躲避',
    loading: '自动演示加载中…',
    failed: '自动演示无法启动',
    warnings: '{n} 个提示',
    restartNotice: '自动已开启：从开头重播（保持确定性）',
    modeNotice: '自动模式：{mode}',
    waiting: '等待引擎就绪…',
  },

  encanim: {
    scale: '缩放 scale',
    scaleHint: '乘上演员本身的 scale；留空 = 1（不缩放）。',
    flip: '翻转 flip',
    flipInherit: '（沿用演员）',
    flipOn: '翻转',
    flipOff: '不翻转',
    flipHint: '省略 = 沿用演员的 flip；只有这个状态要镜像时才设置。',
  },
};

const EN = {
  encdemo: {
    tab: 'Demo',
    tabCues: 'Cue list',
    title: 'Demo script',
    aria: 'Encounter demo script',
    hint: 'The demo only affects the "Auto" toggle; with Auto off, play is exactly manual.',

    settingsTitle: 'Text & pacing',
    auto: 'Advance text automatically',
    autoHint: 'Press confirm {delay}s after a line finishes typing; never presses while typing.',
    delay: 'Delay (s)',
    menuDelay: 'Menu step (frames)',
    menuDelayHint: '0 = press every frame (fastest); 6 ≈ 0.2s so the cursor is visible.',

    turnsTitle: 'Turn script',
    addTurn: '+ Add turn card',
    empty: 'No turn cards yet',
    emptySub: 'Turns not listed on a card use the default card below.',
    cardTitle: 'Turn {n}',
    scriptedRounds: '{n} scripted rounds',
    turnNo: 'Turn',
    remove: 'Delete this turn card',
    up: 'Move up',
    down: 'Move down',
    member: 'Member',
    command: 'Command',
    target: 'Target',
    option: 'Option',
    fight: 'Fight timing',
    dodge: 'Dodge',
    unset: '(unset)',
    noTarget: '(not needed)',
    noOptions: '(no options)',
    optionMissing: 'Not found: "{name}"',
    targetEnemy: 'Enemy',
    targetParty: 'Party',
    targetEither: 'Enemy / party',

    defaultCardTitle: 'Default card',
    defaultHint: 'Turns and members without a card entry fall back to this card.',
    defaultChoices: 'All-member command',
    defaultFight: 'Default fight timing',
    defaultDodge: 'Default dodge',
    defaultCustom: 'Custom array ({n})',

    errorsTitle: 'Demo errors',
    errorsCount: '{n}',
    errorsNone: 'No demo errors',
    errorsHint: 'Shows the path and message; click to jump to the field.',
    jump: 'Go to',

    'fight.perfect': 'perfect',
    'fight.good': 'good',
    'fight.ok': 'ok',
    'fight.miss': 'miss',
    'fight.full.perfect': 'perfect (dead centre)',
    'fight.full.good': 'good (a bit off, still high score)',
    'fight.full.ok': 'ok (barely hits)',
    'fight.full.miss': 'miss (whiff on purpose)',
    'fight.full.number': '0..1: pick the hit timing yourself (0 = earliest, 1 = latest)',
    'dodge.path': 'path',
    'dodge.inputs': 'inputs',
    'dodge.bot': 'bot',
    'dodge.none': 'none',
    'dodge.full.path': 'path (follow the path recorded in the attack file)',
    'dodge.full.inputs': 'inputs (dodge with the recorded inputs)',
    'dodge.full.bot': 'bot (let the bot dodge automatically)',
    'dodge.full.none': 'none (stand still and take the hits)',
    'command.fight': 'fight',
    'command.act': 'act',
    'command.magic': 'magic',
    'command.item': 'item',
    'command.spare': 'spare',
    'command.defend': 'defend',

    undoAddTurn: 'Add demo turn card',
    undoRemoveTurn: 'Delete demo turn card',
    undoMoveTurn: 'Move demo turn card',
    undoChoice: 'Edit demo choice',
    undoCard: 'Edit demo turn card',
    undoDefault: 'Edit demo default card',
    undoSettings: 'Edit demo settings',
  },

  encauto: {
    tab: 'Auto',
    title: 'Autoplay: off / script / AI (feeds input only, never mutates state)',
    off: 'Off',
    demo: 'Script',
    bot: 'AI',
    status: 'AUTO · {mode}',
    statusDetail: 'T{turn} · {step}',
    stepIdle: 'idle',
    stepMenu: 'menu',
    stepText: 'text',
    stepFight: 'fight',
    stepDodge: 'dodge',
    loading: 'Loading autoplay…',
    failed: 'Autoplay could not start',
    warnings: '{n} warning(s)',
    restartNotice: 'Auto on: replaying from the start (deterministic)',
    modeNotice: 'Auto mode: {mode}',
    waiting: 'Waiting for the engine…',
  },

  encanim: {
    scale: 'Scale',
    scaleHint: 'Multiplies the actor scale; blank = 1 (no change).',
    flip: 'Flip',
    flipInherit: '(inherit)',
    flipOn: 'Flipped',
    flipOff: 'Not flipped',
    flipHint: 'Omitted = inherit the actor flip; set only when this state must mirror.',
  },
};

export const STRINGS = { 'zh-Hant': ZH_HANT, 'zh-Hans': ZH_HANS, en: EN };

export default STRINGS;

/** 把本檔字串註冊進 editor/i18n.js（可重複呼叫）。 */
export function registerEncounterDemoStrings(target = i18n) {
  const reg = target && typeof target.registerStrings === 'function' ? target.registerStrings : null;
  if (!reg) return false;
  for (const [locale, nsMap] of Object.entries(STRINGS)) {
    for (const ns of NAMESPACES) reg(ns, { [locale]: nsMap[ns] });
  }
  return true;
}

/**
 * 檢查三語鍵集合是否一致（測試用；與 locales/demo.js 的 findKeyMismatches 同語意）。
 * @returns {string[]} 問題描述（空陣列＝通過）
 */
export function findKeyMismatches(table = STRINGS, locales = LOCALE_IDS) {
  const problems = [];
  for (const ns of NAMESPACES) {
    const keysByLocale = new Map();
    for (const locale of locales) {
      const nsMap = table[locale] && table[locale][ns];
      if (!nsMap || typeof nsMap !== 'object') {
        problems.push(`${locale}.${ns}: 缺少命名空間`);
        continue;
      }
      const keys = new Set(Object.keys(nsMap));
      keysByLocale.set(locale, keys);
      for (const key of keys) {
        if (typeof nsMap[key] !== 'string') problems.push(`${locale}.${ns}.${key}: 不是字串`);
        else if (nsMap[key].trim() === '') problems.push(`${locale}.${ns}.${key}: 空字串`);
      }
    }
    const ids = [...keysByLocale.keys()];
    if (ids.length < 2) continue;
    const base = ids[0];
    for (const other of ids.slice(1)) {
      for (const key of keysByLocale.get(base)) {
        if (!keysByLocale.get(other).has(key)) problems.push(`${other}.${ns}.${key}: 缺少鍵（${base} 有）`);
      }
      for (const key of keysByLocale.get(other)) {
        if (!keysByLocale.get(base).has(key)) problems.push(`${base}.${ns}.${key}: 缺少鍵（${other} 有）`);
      }
    }
  }
  return problems;
}

// 模組載入即註冊（registerStrings 可合併，重複 import 不會出問題）。
registerEncounterDemoStrings(i18n);
