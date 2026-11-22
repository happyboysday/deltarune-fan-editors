/**
 * 即時同步（SPEC-AGENT §5）介面字串：三語。
 * 命名空間：sync
 */

import * as i18n from '../i18n.js';

export const NAMESPACES = ['sync'];

export const strings = {
  'zh-Hant': {
    'sync.chip.connected': 'Agent 已連線',
    'sync.chip.idle': 'Agent 未連線',
    'sync.chip.offline': '同步不可用（伺服器未提供）',
    'sync.chip.lastAction': '最近的 Agent 動作：{action}',
    'sync.chip.title': '即時同步狀態（SPEC-AGENT）：Agent 可看到你正在編輯什麼',
    'sync.label.agent': 'Agent 修改',
    'sync.label.by': '{by} 修改',
    'sync.action.changed': '{name} 已被修改',
    'sync.action.deleted': '{name} 已被刪除',
    'sync.action.focus': '{by} 要求切換檢視',
    'sync.message.reloaded': '已載入對方版本：{name}（可按 Ctrl+Z 復原）',
    'sync.message.deleted': '{name} 已被其他人刪除',
    'sync.message.saved': '已儲存（ETag {etag}）',
    'sync.message.conflict': '檔案已被其他人改動：請選擇要保留的版本',
    'sync.message.unavailable': '這個伺服器沒有即時同步 API（/api/events），同步功能關閉',
    'sync.merge.title': '檔案有衝突',
    'sync.merge.body': '這個檔案在你開啟後被其他人（或 Agent）改過，而你還有未儲存的修改。',
    'sync.merge.by': '對方的版本由 {by} 儲存。',
    'sync.merge.viewDiff': '檢視差異',
    'sync.merge.mine': '保留我的',
    'sync.merge.theirs': '採用對方',
    'sync.merge.cancel': '稍後決定',
    'sync.merge.mineShort': '我的',
    'sync.merge.theirsShort': '對方',
    'sync.merge.keepMineNote': '已保留你的版本；下次儲存會覆蓋對方的版本',
    'sync.merge.doneTheirs': '已採用對方的版本',
    'sync.focus.fileSwitched': '已切換到 {name}',
    'sync.focus.frame': '已跳到第 {frame} 幀',
  },
  'zh-Hans': {
    'sync.chip.connected': 'Agent 已连接',
    'sync.chip.idle': 'Agent 未连接',
    'sync.chip.offline': '同步不可用（服务器未提供）',
    'sync.chip.lastAction': '最近的 Agent 动作：{action}',
    'sync.chip.title': '实时同步状态（SPEC-AGENT）：Agent 可以看到你正在编辑什么',
    'sync.label.agent': 'Agent 修改',
    'sync.label.by': '{by} 修改',
    'sync.action.changed': '{name} 已被修改',
    'sync.action.deleted': '{name} 已被删除',
    'sync.action.focus': '{by} 要求切换视图',
    'sync.message.reloaded': '已载入对方版本：{name}（可按 Ctrl+Z 还原）',
    'sync.message.deleted': '{name} 已被其他人删除',
    'sync.message.saved': '已保存（ETag {etag}）',
    'sync.message.conflict': '文件已被其他人改动：请选择要保留的版本',
    'sync.message.unavailable': '这个服务器没有实时同步 API（/api/events），同步功能关闭',
    'sync.merge.title': '文件有冲突',
    'sync.merge.body': '这个文件在你打开后被其他人（或 Agent）改过，而你还有未保存的修改。',
    'sync.merge.by': '对方的版本由 {by} 保存。',
    'sync.merge.viewDiff': '查看差异',
    'sync.merge.mine': '保留我的',
    'sync.merge.theirs': '采用对方',
    'sync.merge.cancel': '稍后决定',
    'sync.merge.mineShort': '我的',
    'sync.merge.theirsShort': '对方',
    'sync.merge.keepMineNote': '已保留你的版本；下次保存会覆盖对方的版本',
    'sync.merge.doneTheirs': '已采用对方的版本',
    'sync.focus.fileSwitched': '已切换到 {name}',
    'sync.focus.frame': '已跳到第 {frame} 帧',
  },
  en: {
    'sync.chip.connected': 'Agent connected',
    'sync.chip.idle': 'Agent offline',
    'sync.chip.offline': 'Sync unavailable (server lacks API)',
    'sync.chip.lastAction': 'Last agent action: {action}',
    'sync.chip.title': 'Live sync status (SPEC-AGENT): agents can see what you are editing',
    'sync.label.agent': 'Agent change',
    'sync.label.by': 'Change by {by}',
    'sync.action.changed': '{name} was changed',
    'sync.action.deleted': '{name} was deleted',
    'sync.action.focus': '{by} asked to switch view',
    'sync.message.reloaded': 'Loaded the other version of {name} (Ctrl+Z to undo)',
    'sync.message.deleted': '{name} was deleted by someone else',
    'sync.message.saved': 'Saved (ETag {etag})',
    'sync.message.conflict': 'The file changed elsewhere — choose which version to keep',
    'sync.message.unavailable': 'This server has no live-sync API (/api/events); sync is off',
    'sync.merge.title': 'File conflict',
    'sync.merge.body': 'This file was changed by someone else (or an agent) after you opened it, and you have unsaved edits.',
    'sync.merge.by': 'Their version was saved by {by}.',
    'sync.merge.viewDiff': 'View diff',
    'sync.merge.mine': 'Keep mine',
    'sync.merge.theirs': 'Take theirs',
    'sync.merge.cancel': 'Decide later',
    'sync.merge.mineShort': 'mine',
    'sync.merge.theirsShort': 'theirs',
    'sync.merge.keepMineNote': 'Kept your version; the next save overwrites theirs',
    'sync.merge.doneTheirs': 'Took their version',
    'sync.focus.fileSwitched': 'Switched to {name}',
    'sync.focus.frame': 'Jumped to frame {frame}',
  },
};

export function registerSyncStrings(i18nModule) {
  const mod = i18nModule || i18n;
  if (mod && typeof mod.registerStrings === 'function') {
    for (const ns of NAMESPACES) {
      const table = {};
      for (const locale of Object.keys(strings)) {
        table[locale] = {};
        for (const key of Object.keys(strings[locale])) {
          if (key.startsWith(`${ns}.`)) table[locale][key.slice(ns.length + 1)] = strings[locale][key];
        }
      }
      mod.registerStrings(ns, table);
    }
  }
  return strings;
}

registerSyncStrings(i18n);

export default strings;
