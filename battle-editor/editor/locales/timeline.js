/**
 * editor/locales/timeline.js — ED2：時間軸面板介面字串（命名空間 `timeline`）
 *
 * SPEC §10.1：三語鍵集合必須一致（`editor/timeline.test.mjs` 會檢查）。
 * 不翻譯：JSON 欄位名、表達式變數/函式名、sprite/音效名（那些直接顯示原字串）。
 *
 * 佔位符用 `{name}`，由 `t('timeline.xxx', { name })` 替換。
 */

export default {
  'zh-Hant': {
    /* 軌道類型名（左側類型欄、新增事件選單） */
    'track.spawn': '生成',
    'track.emitter': '發射器',
    'track.box': '戰鬥框',
    'track.soul': '靈魂',
    'track.clear': '清除',
    'track.shake': '震動',
    'track.sfx': '音效',
    'track.anim': '演員動畫',
    'track.end': '結束',
    'track.other': '其他',

    /* 新增事件選單：類型說明 */
    'menu.spawn': '一次性生成子彈',
    'menu.emitter': '持續發射子彈',
    'menu.box': '戰鬥框補間',
    'menu.soul': '設定靈魂',
    'menu.clear': '清除所有子彈',
    'menu.shake': '畫面震動',
    'menu.sfx': '播放音效',
    'menu.end': '立即結束回合',
    'menu.aria': '新增事件',
    /* B10：選單項目 = 名稱（已翻譯）+ 事件類型 id（原字串，小字）+ 說明；hover 顯示完整組合 */
    'menu.idTitle': '事件類型 id：{type}',
    'menu.itemTitle': '{name}（{type}）— {desc}',

    /* 工具列 */
    'btn.fit': '適合全部',
    'btn.fitTitle': '縮放成全部可見',
    'btn.zoomIn': '放大',
    'btn.zoomInTitle': '放大（Ctrl+滾輪）',
    'btn.zoomOut': '縮小',
    'btn.zoomOutTitle': '縮小（Ctrl+滾輪）',
    'hint': '空白處雙擊＝新增事件 · 雙擊事件＝在檢查器中聚焦 · Ctrl+滾輪＝縮放 · Shift＝吸附 0.1s · Alt 拖曳＝複製 · Delete/Backspace＝刪除選取事件 · P＝自動演示 · R＝預覽重來',
    'readout': '{sec}s / {dur}s · 幀 {frame}',
    'readoutBeats': '{sec}s / {dur}s · 幀 {frame} · 第 {beat} 拍{beatFrac}',
    'beatUnit': '拍',
    'hintBeats': '有 BPM：預設吸附拍線（按住 Shift 暫時關閉吸附）· Ctrl+滾輪＝縮放 · 空白處雙擊＝新增事件',
    'empty': '尚無事件 — 在空白處雙擊即可新增',

    /* 時間尺 */
    'ruler.secondsFrames': '秒 / 幀',
    'ruler.frames': '{n} 幀',
    'ruler.frameTick': '幀{n}',

    /* 事件摘要 */
    'summary.mode': '模式 {mode}',
    'summary.soul': '靈魂',
    'summary.fade': '淡出 {fade}s',
    'summary.clear': '清除',
    'summary.noSound': '(未指定音效)',
    'summary.end': '回合結束',

    /* 復原步驟名稱（store.update 的 label） */
    'undo.duration': '修改回合長度',
    'undo.duplicate': '複製事件',
    'undo.move': '移動事件',
    'undo.resize': '調整事件長度',
    'undo.delete': '刪除事件',
    'undo.add': '新增 {type} 事件',
  },

  'zh-Hans': {
    'track.spawn': '生成',
    'track.emitter': '发射器',
    'track.box': '战斗框',
    'track.soul': '灵魂',
    'track.clear': '清除',
    'track.shake': '震动',
    'track.sfx': '音效',
    'track.anim': '演员动画',
    'track.end': '结束',
    'track.other': '其他',

    'menu.spawn': '一次性生成子弹',
    'menu.emitter': '持续发射子弹',
    'menu.box': '战斗框补间',
    'menu.soul': '设定灵魂',
    'menu.clear': '清除所有子弹',
    'menu.shake': '画面震动',
    'menu.sfx': '播放音效',
    'menu.end': '立即结束回合',
    'menu.aria': '新增事件',
    'menu.idTitle': '事件类型 id：{type}',
    'menu.itemTitle': '{name}（{type}）— {desc}',

    'btn.fit': '适合全部',
    'btn.fitTitle': '缩放成全部可见',
    'btn.zoomIn': '放大',
    'btn.zoomInTitle': '放大（Ctrl+滚轮）',
    'btn.zoomOut': '缩小',
    'btn.zoomOutTitle': '缩小（Ctrl+滚轮）',
    'hint': '空白处双击＝新增事件 · 双击事件＝在检查器中聚焦 · Ctrl+滚轮＝缩放 · Shift＝吸附 0.1s · Alt 拖拽＝复制 · Delete/Backspace＝删除选取事件 · P＝自动演示 · R＝预览重来',
    'readout': '{sec}s / {dur}s · 帧 {frame}',
    'readoutBeats': '{sec}s / {dur}s · 帧 {frame} · 第 {beat} 拍{beatFrac}',
    'beatUnit': '拍',
    'hintBeats': '有 BPM：默认吸附拍线（按住 Shift 暂时关闭吸附）· Ctrl+滚轮＝缩放 · 空白处双击＝新增事件',
    'empty': '尚无事件 — 在空白处双击即可新增',

    'ruler.secondsFrames': '秒 / 帧',
    'ruler.frames': '{n} 帧',
    'ruler.frameTick': '帧{n}',

    'summary.mode': '模式 {mode}',
    'summary.soul': '灵魂',
    'summary.fade': '淡出 {fade}s',
    'summary.clear': '清除',
    'summary.noSound': '(未指定音效)',
    'summary.end': '回合结束',

    'undo.duration': '修改回合长度',
    'undo.duplicate': '复制事件',
    'undo.move': '移动事件',
    'undo.resize': '调整事件长度',
    'undo.delete': '删除事件',
    'undo.add': '新增 {type} 事件',
  },

  en: {
    'track.spawn': 'Spawn',
    'track.emitter': 'Emitter',
    'track.box': 'Box',
    'track.soul': 'Soul',
    'track.clear': 'Clear',
    'track.shake': 'Shake',
    'track.sfx': 'SFX',
    'track.anim': 'Actor animation',
    'track.end': 'End',
    'track.other': 'Other',

    'menu.spawn': 'Spawn bullets once',
    'menu.emitter': 'Fire bullets over time',
    'menu.box': 'Tween the battle box',
    'menu.soul': 'Set the soul',
    'menu.clear': 'Clear all bullets',
    'menu.shake': 'Shake the screen',
    'menu.sfx': 'Play a sound',
    'menu.end': 'End the turn immediately',
    'menu.aria': 'Add event',
    'menu.idTitle': 'Event type id: {type}',
    'menu.itemTitle': '{name} ({type}) — {desc}',

    'btn.fit': 'Fit all',
    'btn.fitTitle': 'Zoom so everything is visible',
    'btn.zoomIn': 'Zoom in',
    'btn.zoomInTitle': 'Zoom in (Ctrl+wheel)',
    'btn.zoomOut': 'Zoom out',
    'btn.zoomOutTitle': 'Zoom out (Ctrl+wheel)',
    'hint': 'double-click empty = add event · double-click event = focus inspector · Ctrl+wheel = zoom · Shift = snap 0.1s · Alt-drag = duplicate · Delete/Backspace = delete selection · P = autoplay · R = restart preview',
    'readout': '{sec}s / {dur}s · frame {frame}',
    'readoutBeats': '{sec}s / {dur}s · frame {frame} · beat {beat}{beatFrac}',
    'beatUnit': 'beats',
    'hintBeats': 'With BPM: snaps to beat lines by default (hold Shift to disable snapping) · Ctrl+wheel = zoom · double-click empty = add event',
    'empty': 'No events yet — double-click an empty area to add one',

    'ruler.secondsFrames': 's / f',
    'ruler.frames': '{n} f',
    'ruler.frameTick': 'f{n}',

    'summary.mode': 'mode {mode}',
    'summary.soul': 'soul',
    'summary.fade': 'fade {fade}s',
    'summary.clear': 'clear',
    'summary.noSound': '(no sound)',
    'summary.end': 'end turn',

    'undo.duration': 'Change turn length',
    'undo.duplicate': 'Duplicate event',
    'undo.move': 'Move event',
    'undo.resize': 'Resize event',
    'undo.delete': 'Delete event',
    'undo.add': 'Add {type} event',
  },
};
