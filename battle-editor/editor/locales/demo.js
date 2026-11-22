/**
 * editor/locales/demo.js — ED1：攻擊編輯器「演示 demo」面板與自動播放字串
 *
 * SPEC-AUTOPLAY §4：攻擊編輯器 demo 區（模式 / 路徑點 / inputs / 錄製）與
 * 預覽工具列「自動」開關。命名空間：`demo`（檢查器）、`autoplay`（傳輸列）。
 * 三語（zh-Hant / zh-Hans / en）鍵集合必須一致（editor/demo.test.mjs 會檢查）。
 *
 * 不翻譯：JSON 欄位名（t、x、y、slow、hold、paths、inputs、mode、fallback）、
 *         模式識別字（path / inputs / bot / stay）、按鍵名稱（Esc、X、Shift）。
 */

import * as i18n from '../i18n.js';

const zhHant = {
  demo: {
    section: '演示 demo',
    sectionHint: 'demo 只影響「自動演示」；關閉自動時引擎行為完全不變。',

    mode: '模式',
    'mode.auto': '自動（依內容判斷）',
    'mode.path': '路徑 path',
    'mode.inputs': '輸入 inputs',
    'mode.bot': '機器人 bot',
    fallback: '備援 fallback',
    'fallback.bot': '機器人 bot',
    'fallback.stay': '原地 stay',

    path: '路徑點 path',
    pathInfo: '{count} 點 · 總長 {duration} 秒',
    pathEmpty: '尚未設定路徑點',
    pathEmptySub: '用下方按鈕新增第一個點，或改選 inputs / bot 模式。',
    addCursor: '＋ 游標位置',
    addCursorTitle: '在目前時間游標（及插值位置）新增路徑點',
    addSoul: '＋ 靈魂位置',
    addSoulTitle: '在目前靈魂位置（及目前時間）新增路徑點',
    moveUp: '上移',
    moveDown: '下移',
    remove: '刪除',
    removeTitle: '刪除此路徑點',
    pointIndex: '點 {i}',
    t: 't（秒）',
    x: 'x',
    y: 'y',
    slow: '低速 slow',
    hold: '停留 hold（秒）',
    /* §4-7 數值表格（表頭與提示；欄位名 t/x/y/slow/hold 是 JSON 欄位名，不翻譯） */
    'col.t': 't 秒',
    'col.x': 'x',
    'col.y': 'y',
    'col.slow': '低速 slow',
    'col.hold': '停留 hold 秒',
    tableHint: '每點一列；改數值即寫入（可 Ctrl+Z 復原）。↑↓ 微調，Shift＝10 倍；預覽上拖點會同步更新這裡。',
    tableModeWarn: '目前模式不是 path，這張表只在自動演示切到「腳本 path」時才生效。',

    inputs: '輸入 inputs',
    inputsInfo: '{segments} 段 · 約 {frames} 幀',
    inputsLength: '長度 {length} 字元',
    inputsEmpty: '尚未錄製輸入',
    clearInputs: '清除 inputs',
    clearInputsTitle: '刪除 demo.inputs（一筆可復原編輯）',
    record: '● 錄製演示',
    stopRecord: '■ 停止錄製',
    recordActive: '錄製中：方向鍵移動、X / Shift 低速；Esc 或再按一次停止',
    recordHint: '按「錄製演示」後在預覽中以方向鍵遊玩；停止時把這次操作寫入 demo.inputs（可 undo）。',

    errorHint: '修正下列 demo 欄位錯誤後，自動演示才會生效。',

    'undo.addPoint': '新增演示路徑點',
    'undo.removePoint': '刪除演示路徑點',
    'undo.movePoint': '移動演示路徑點',
    'undo.edit': '編輯演示',
    'undo.editCell': '修改演示路徑數值',
    'undo.dragPoint': '拖曳演示路徑點',
    'undo.record': '錄製演示',
    'undo.clearInputs': '清除演示輸入',
    'undo.genPath': '自動產生演示路徑',

    /* V2-06：自動產生路徑（generateDemoPath）＋實際軌跡疊圖（traceDemo） */
    'gen.title': '自動產生路徑',
    'gen.sub': '用引擎實跑驗證的搜尋',
    'gen.start': '自動產生路徑',
    'gen.startTitle': '以引擎實跑搜尋一條不會中彈的路徑（可取消；完成後可 Undo）',
    'gen.shortcutTitle': '展開下方的「演示」區塊並開始自動產生閃避路徑（可取消；完成後可 Undo）',
    'gen.running': '產生中…',
    'gen.cancel': '取消',
    'gen.cancelTitle': '停止產生（保留目前最佳結果丟棄）',
    'gen.starting': '準備中…',
    'gen.progress': '第 {sweep} 輪 · {phase} · 目前命中 {hits}',
    'gen.clearanceWarning': '淨空 {actual} px，未達 {target} px 目標。',
    'gen.done': '完成：{points} 個路徑點、命中 {hits} 次（{ms} ms）',
    'gen.failed': '產生失敗：{error}',
    'gen.empty': '產生結果沒有可用路徑點',
    'gen.pilotNotReady': '自動駕駛尚未就緒，實際軌跡可能不準；稍候重試即可。',
    'trace.title': '實際軌跡',
    'trace.none': '尚未計算',
    'trace.hits': '命中 {hits} 次',
    'trace.recompute': '重算軌跡',
    'trace.recomputeTitle': '用引擎實跑一次目前路徑，畫出跟隨器的實際軌跡與被擊中的幀',
    'trace.show': '顯示',
    'trace.showTitle': '顯示或隱藏「實際軌跡」圖層（預定路線 / 實際軌跡 / 命中幀）',
    'trace.frames': '追蹤 {frames} 幀',
    'trace.deviation': '偏差 平均 {avg}px · 最大 {max}px',
    'trace.hitFrames': '被擊中幀：{frames}',
    'trace.pilotNotReady': '自動駕駛尚未就緒：實際軌跡可能不完整（describe().ready === false）。',
  },

  autoplay: {
    label: '自動',
    title: '自動演示：關 / 腳本 / AI（只把輸入餵給引擎，不改狀態）· P＝切換 · R＝重來',
    off: '關',
    demo: '腳本',
    bot: 'AI',
    status: 'AUTO · {mode}',
    overlay: '路徑',
    overlayTitle: '顯示或隱藏演示路徑疊加層（只在編輯模式）',
    recording: 'REC',
    stop: '停止',
    record: '錄製',
  },
};

const zhHans = {
  demo: {
    section: '演示 demo',
    sectionHint: 'demo 只影响「自动演示」；关闭自动时引擎行为完全不变。',

    mode: '模式',
    'mode.auto': '自动（依内容判断）',
    'mode.path': '路径 path',
    'mode.inputs': '输入 inputs',
    'mode.bot': '机器人 bot',
    fallback: '备用 fallback',
    'fallback.bot': '机器人 bot',
    'fallback.stay': '原地 stay',

    path: '路径点 path',
    pathInfo: '{count} 点 · 总长 {duration} 秒',
    pathEmpty: '尚未设置路径点',
    pathEmptySub: '用下方按钮新增第一个点，或改选 inputs / bot 模式。',
    addCursor: '＋ 光标位置',
    addCursorTitle: '在目前时间光标（及插值位置）新增路径点',
    addSoul: '＋ 灵魂位置',
    addSoulTitle: '在目前灵魂位置（及目前时间）新增路径点',
    moveUp: '上移',
    moveDown: '下移',
    remove: '删除',
    removeTitle: '删除此路径点',
    pointIndex: '点 {i}',
    t: 't（秒）',
    x: 'x',
    y: 'y',
    slow: '低速 slow',
    hold: '停留 hold（秒）',
    'col.t': 't 秒',
    'col.x': 'x',
    'col.y': 'y',
    'col.slow': '低速 slow',
    'col.hold': '停留 hold 秒',
    tableHint: '每点一行；改数值即写入（可 Ctrl+Z 复原）。↑↓ 微调，Shift＝10 倍；预览上拖点会同步更新这里。',
    tableModeWarn: '目前模式不是 path，这张表只在自动演示切到「脚本 path」时才生效。',

    inputs: '输入 inputs',
    inputsInfo: '{segments} 段 · 约 {frames} 帧',
    inputsLength: '长度 {length} 字符',
    inputsEmpty: '尚未录制输入',
    clearInputs: '清除 inputs',
    clearInputsTitle: '删除 demo.inputs（一笔可复原编辑）',
    record: '● 录制演示',
    stopRecord: '■ 停止录制',
    recordActive: '录制中：方向键移动、X / Shift 低速；Esc 或再按一次停止',
    recordHint: '按「录制演示」后在预览中以方向键游玩；停止时把这次操作写入 demo.inputs（可 undo）。',

    errorHint: '修正下列 demo 字段错误后，自动演示才会生效。',

    'undo.addPoint': '新增演示路径点',
    'undo.removePoint': '删除演示路径点',
    'undo.movePoint': '移动演示路径点',
    'undo.edit': '编辑演示',
    'undo.editCell': '修改演示路径数值',
    'undo.dragPoint': '拖曳演示路径点',
    'undo.record': '录制演示',
    'undo.clearInputs': '清除演示输入',
    'undo.genPath': '自动产生演示路径',

    'gen.title': '自动产生路径',
    'gen.sub': '用引擎实跑验证的搜索',
    'gen.start': '自动产生路径',
    'gen.startTitle': '以引擎实跑搜索一条不会中弹的路径（可取消；完成后可 Undo）',
    'gen.shortcutTitle': '展开下方的「演示」区块并开始自动产生闪避路径（可取消；完成后可 Undo）',
    'gen.running': '产生中…',
    'gen.cancel': '取消',
    'gen.cancelTitle': '停止产生（丢弃目前最佳结果）',
    'gen.starting': '准备中…',
    'gen.progress': '第 {sweep} 轮 · {phase} · 目前命中 {hits}',
    'gen.clearanceWarning': '净空 {actual} px，未达 {target} px 目标。',
    'gen.done': '完成：{points} 个路径点、命中 {hits} 次（{ms} ms）',
    'gen.failed': '产生失败：{error}',
    'gen.empty': '产生结果没有可用路径点',
    'gen.pilotNotReady': '自动驾驶尚未就绪，实际轨迹可能不准；稍候重试即可。',
    'trace.title': '实际轨迹',
    'trace.none': '尚未计算',
    'trace.hits': '命中 {hits} 次',
    'trace.recompute': '重算轨迹',
    'trace.recomputeTitle': '用引擎实跑一次目前路径，画出跟随器的实际轨迹与被击中的帧',
    'trace.show': '显示',
    'trace.showTitle': '显示或隐藏「实际轨迹」图层（预定路线 / 实际轨迹 / 命中帧）',
    'trace.frames': '追踪 {frames} 帧',
    'trace.deviation': '偏差 平均 {avg}px · 最大 {max}px',
    'trace.hitFrames': '被击中帧：{frames}',
    'trace.pilotNotReady': '自动驾驶尚未就绪：实际轨迹可能不完整（describe().ready === false）。',
  },

  autoplay: {
    label: '自动',
    title: '自动演示：关 / 脚本 / AI（只把输入喂给引擎，不改状态）· P＝切换 · R＝重来',
    off: '关',
    demo: '脚本',
    bot: 'AI',
    status: 'AUTO · {mode}',
    overlay: '路径',
    overlayTitle: '显示或隐藏演示路径叠加层（只在编辑模式）',
    recording: 'REC',
    stop: '停止',
    record: '录制',
  },
};

const en = {
  demo: {
    section: 'Demo',
    sectionHint: 'demo only affects autoplay; with autoplay off the engine behaves exactly as before.',

    mode: 'Mode',
    'mode.auto': 'Auto (infer from contents)',
    'mode.path': 'path',
    'mode.inputs': 'inputs',
    'mode.bot': 'bot',
    fallback: 'Fallback',
    'fallback.bot': 'bot',
    'fallback.stay': 'stay',

    path: 'Path points',
    pathInfo: '{count} points · {duration}s long',
    pathEmpty: 'No path points yet',
    pathEmptySub: 'Add the first point below, or switch to inputs / bot mode.',
    addCursor: '+ Cursor position',
    addCursorTitle: 'Add a path point at the current timeline cursor (interpolated position)',
    addSoul: '+ SOUL position',
    addSoulTitle: 'Add a path point at the current SOUL position (current time)',
    moveUp: 'Up',
    moveDown: 'Down',
    remove: 'Delete',
    removeTitle: 'Delete this path point',
    pointIndex: 'Point {i}',
    t: 't (s)',
    x: 'x',
    y: 'y',
    slow: 'slow',
    hold: 'hold (s)',
    'col.t': 't (s)',
    'col.x': 'x',
    'col.y': 'y',
    'col.slow': 'slow',
    'col.hold': 'hold (s)',
    tableHint: 'One row per point; edits are written immediately (Ctrl+Z to undo). ↑↓ = fine tune, Shift = ×10; dragging points in the preview updates this table.',
    tableModeWarn: 'Mode is not "path" — this table only takes effect when autoplay runs the scripted path.',

    inputs: 'Inputs',
    inputsInfo: '{segments} segments · ~{frames} frames',
    inputsLength: '{length} chars',
    inputsEmpty: 'No recorded inputs',
    clearInputs: 'Clear inputs',
    clearInputsTitle: 'Delete demo.inputs (one undoable edit)',
    record: '● Record demo',
    stopRecord: '■ Stop recording',
    recordActive: 'Recording: arrow keys to move, X / Shift to slow; Esc or press again to stop',
    recordHint: 'Press "Record demo", play with the arrow keys in the preview; stopping writes demo.inputs (undoable).',

    errorHint: 'Fix the demo field errors below to make autoplay take effect.',

    'undo.addPoint': 'Add demo path point',
    'undo.removePoint': 'Delete demo path point',
    'undo.movePoint': 'Move demo path point',
    'undo.edit': 'Edit demo',
    'undo.editCell': 'Edit demo path value',
    'undo.dragPoint': 'Drag demo path point',
    'undo.record': 'Record demo',
    'undo.clearInputs': 'Clear demo inputs',
    'undo.genPath': 'Generate demo path',

    'gen.title': 'Generate path',
    'gen.sub': 'Engine-verified search',
    'gen.start': 'Generate path',
    'gen.startTitle': 'Search for a hit-free path by actually running the engine (cancellable; undoable)',
    'gen.shortcutTitle': 'Expand the Demo section below and start generating a dodge path (cancellable; undoable)',
    'gen.running': 'Generating…',
    'gen.cancel': 'Cancel',
    'gen.cancelTitle': 'Stop generating (discard the best result so far)',
    'gen.starting': 'Preparing…',
    'gen.progress': 'sweep {sweep} · {phase} · hits {hits}',
    'gen.clearanceWarning': 'Clearance {actual} px is below the {target} px target.',
    'gen.done': 'Done: {points} path points, {hits} hits ({ms} ms)',
    'gen.failed': 'Generation failed: {error}',
    'gen.empty': 'The generator returned no usable path points',
    'gen.pilotNotReady': 'The autopilot is not ready yet; the traced path may be inaccurate. Try again in a moment.',
    'trace.title': 'Actual trace',
    'trace.none': 'Not computed yet',
    'trace.hits': '{hits} hits',
    'trace.recompute': 'Recompute trace',
    'trace.recomputeTitle': 'Run the current path through the engine and draw the follower trace plus hit frames',
    'trace.show': 'Show',
    'trace.showTitle': 'Show or hide the actual-trace layer (planned path / actual trace / hit frames)',
    'trace.frames': '{frames} frames traced',
    'trace.deviation': 'deviation avg {avg}px · max {max}px',
    'trace.hitFrames': 'Hit frames: {frames}',
    'trace.pilotNotReady': 'Autopilot not ready: the actual trace may be incomplete (describe().ready === false).',
  },

  autoplay: {
    label: 'Auto',
    title: 'Autoplay: off / script / AI (feeds input only, never mutates state) · P = cycle · R = restart',
    off: 'Off',
    demo: 'Script',
    bot: 'AI',
    status: 'AUTO · {mode}',
    overlay: 'Path',
    overlayTitle: 'Show or hide the demo path overlay (edit mode only)',
    recording: 'REC',
    stop: 'Stop',
    record: 'Record',
  },
};

const strings = { 'zh-Hant': zhHant, 'zh-Hans': zhHans, en };

export default strings;

export const LOCALE_IDS = ['zh-Hant', 'zh-Hans', 'en'];
export const NAMESPACES = ['demo', 'autoplay'];

/** 把本檔字串註冊進 editor/i18n.js（可重複呼叫）。 */
export function registerDemoStrings(target = i18n) {
  const reg = target && typeof target.registerStrings === 'function' ? target.registerStrings : null;
  if (!reg) return false;
  for (const [locale, nsMap] of Object.entries(strings)) {
    for (const ns of NAMESPACES) reg(ns, { [locale]: nsMap[ns] });
  }
  return true;
}

/**
 * 檢查三語鍵集合是否一致（測試用；與 locales/panels.js 的 findKeyMismatches 同語意）。
 * @returns {string[]} 問題描述（空陣列＝通過）
 */
export function findKeyMismatches(table = strings, locales = LOCALE_IDS) {
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
registerDemoStrings(i18n);
