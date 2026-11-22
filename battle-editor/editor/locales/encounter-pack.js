/**
 * editor/locales/encounter-pack.js  (V2-07)
 *
 * 遭遇編輯器「作品包匯出／匯入＋可遊玩輸出」工具列的介面字串。
 * 命名空間：encPack。三語鍵集合必須一致（editor/encounter/pack-toolbar.test.mjs 會檢查）。
 */

export const LOCALE_IDS = ['zh-Hant', 'zh-Hans', 'en'];

export const NAMESPACES = ['encPack'];

const ZH_HANT = {
  packGroup: '作品包',
  packMenu: '作品包 ▾',
  packMenuTitle: '作品包：匯出／匯入 .drpack.json，或輸出可遊玩 HTML',
  packExportSub: '下載 .drpack.json（含引用的攻擊與素材）',
  packImportSub: '讀取 .drpack.json（同名衝突可選重新命名／覆蓋）',
  playableSub: '單一 HTML：遭遇＋攻擊＋素材全部內嵌',
  playableExported: '可遊玩 HTML 已下載：{name}',
  packExport: '作品包匯出',
  packExportTip: '把目前遭遇與其引用的攻擊、素材打包成 .drpack.json 下載',
  packImport: '作品包匯入',
  packImportTip: '從本機讀取 .drpack.json；同名衝突時可選重新命名或覆蓋',
  playableGroup: '可遊玩輸出',
  playableTip: '匯出單一可遊玩 HTML（遭遇＋攻擊＋素材全部內嵌）',
  saveFirst: '請先儲存遭遇（儲存／另存新檔），才能匯出作品包或可遊玩 HTML。',
  exportingPack: '正在打包…',
  packExported: '作品包已下載：{name}',
  packExportFailed: '作品包匯出失敗：{error}',
  importTitle: '匯入作品包',
  importIntro: '要匯入檔案「{file}」。若作品包內的遭遇／攻擊／素材與現有檔案同名，要怎麼處理？',
  importModeAbort: '遇到衝突就取消',
  importModeRename: '重新命名（建議）',
  importModeOverwrite: '覆蓋現有檔案',
  importCancel: '取消',
  importingPack: '正在匯入…',
  importDone: '匯入完成：遭遇 {encounters}、攻擊 {attacks}、素材 {assets}',
  importDoneRenamed: '匯入完成：遭遇 {encounters}、攻擊 {attacks}、素材 {assets}（{renamed} 項重新命名）',
  importConflicts: '有 {n} 項同名衝突，沒有匯入任何檔案。',
  importFailed: '作品包匯入失敗：{error}',
  badPackJson: '不是合法的 JSON：{error}',
  emptyPackFile: '作品包檔案是空的。',
  readFailed: '讀取檔案失敗：{error}',
  filePicker: '選擇作品包檔案',
};

const ZH_HANS = {
  packGroup: '作品包',
  packMenu: '作品包 ▾',
  packMenuTitle: '作品包：导出／导入 .drpack.json，或输出可游玩 HTML',
  packExportSub: '下载 .drpack.json（含引用的攻击与素材）',
  packImportSub: '读取 .drpack.json（同名冲突可选重命名／覆盖）',
  playableSub: '单一 HTML：遭遇＋攻击＋素材全部内嵌',
  playableExported: '可游玩 HTML 已下载：{name}',
  packExport: '作品包导出',
  packExportTip: '把当前遭遇与其引用的攻击、素材打包成 .drpack.json 下载',
  packImport: '作品包导入',
  packImportTip: '从本机读取 .drpack.json；同名冲突时可选重命名或覆盖',
  playableGroup: '可游玩输出',
  playableTip: '导出单一可游玩 HTML（遭遇＋攻击＋素材全部内嵌）',
  saveFirst: '请先储存遭遇（储存／另存新档），才能导出作品包或可游玩 HTML。',
  exportingPack: '正在打包…',
  packExported: '作品包已下载：{name}',
  packExportFailed: '作品包导出失败：{error}',
  importTitle: '导入作品包',
  importIntro: '要导入文件「{file}」。若作品包内的遭遇／攻击／素材与现有文件同名，要怎么处理？',
  importModeAbort: '遇到冲突就取消',
  importModeRename: '重命名（建议）',
  importModeOverwrite: '覆盖现有文件',
  importCancel: '取消',
  importingPack: '正在导入…',
  importDone: '导入完成：遭遇 {encounters}、攻击 {attacks}、素材 {assets}',
  importDoneRenamed: '导入完成：遭遇 {encounters}、攻击 {attacks}、素材 {assets}（{renamed} 项重命名）',
  importConflicts: '有 {n} 项同名冲突，没有导入任何文件。',
  importFailed: '作品包导入失败：{error}',
  badPackJson: '不是合法的 JSON：{error}',
  emptyPackFile: '作品包文件是空的。',
  readFailed: '读取文件失败：{error}',
  filePicker: '选择作品包文件',
};

const EN = {
  packGroup: 'Pack',
  packMenu: 'Pack ▾',
  packMenuTitle: 'Pack: export/import .drpack.json, or export a playable HTML',
  packExportSub: 'Download .drpack.json (with referenced attacks and assets)',
  packImportSub: 'Read .drpack.json (rename/overwrite on name conflicts)',
  playableSub: 'Single HTML with encounter + attacks + assets embedded',
  playableExported: 'Playable HTML downloaded: {name}',
  packExport: 'Export pack',
  packExportTip: 'Bundle this encounter with the attacks and assets it references into a .drpack.json download',
  packImport: 'Import pack',
  packImportTip: 'Read a .drpack.json from disk; on name conflicts choose rename or overwrite',
  playableGroup: 'Playable export',
  playableTip: 'Export a single playable HTML (encounter + attacks + assets embedded)',
  saveFirst: 'Save the encounter first (Save / Save As) before exporting a pack or a playable HTML.',
  exportingPack: 'Packing…',
  packExported: 'Pack downloaded: {name}',
  packExportFailed: 'Pack export failed: {error}',
  importTitle: 'Import pack',
  importIntro: 'Import the file “{file}”. If its encounters / attacks / assets collide with existing files, what should happen?',
  importModeAbort: 'Cancel on conflict',
  importModeRename: 'Rename (recommended)',
  importModeOverwrite: 'Overwrite existing files',
  importCancel: 'Cancel',
  importingPack: 'Importing…',
  importDone: 'Imported: {encounters} encounter(s), {attacks} attack(s), {assets} asset(s)',
  importDoneRenamed: 'Imported: {encounters} encounter(s), {attacks} attack(s), {assets} asset(s) ({renamed} renamed)',
  importConflicts: 'There are {n} name conflict(s); nothing was imported.',
  importFailed: 'Pack import failed: {error}',
  badPackJson: 'Not valid JSON: {error}',
  emptyPackFile: 'The pack file is empty.',
  readFailed: 'Could not read the file: {error}',
  filePicker: 'Choose a pack file',
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
