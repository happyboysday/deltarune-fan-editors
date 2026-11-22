import { getLocale, registerStrings, t } from '../i18n.js';
const labels = {
  "title": [
    "灵魂配置",
    "靈魂配置",
    "Soul profiles"
  ],
  "initial": [
    "初始配置",
    "初始配置",
    "Starting profile"
  ],
  "legacy": [
    "经典红心",
    "經典紅心",
    "Classic red soul"
  ],
  "edit": [
    "编辑配置",
    "編輯配置",
    "Edit profile"
  ],
  "preset": [
    "新增预设",
    "新增預設",
    "Add preset"
  ],
  "free": [
    "普通红心",
    "普通紅心",
    "Free soul"
  ],
  "pulse": [
    "冲刺射击",
    "衝刺射擊",
    "Dash and shoot"
  ],
  "car": [
    "惯性赛车",
    "慣性賽車",
    "Inertial car"
  ],
  "remove": [
    "移除配置",
    "移除配置",
    "Remove profile"
  ],
  "used": [
    "此配置在时间轴中使用",
    "此配置在時間軸中使用",
    "Referenced on the timeline"
  ],
  "movement": [
    "移动规则",
    "移動規則",
    "Movement"
  ],
  "addAbility": [
    "添加能力",
    "新增能力",
    "Add ability"
  ],
  "removeAbility": [
    "移除能力",
    "移除能力",
    "Remove ability"
  ],
  "sprite": [
    "外观贴图",
    "外觀貼圖",
    "Appearance sprite"
  ],
  "rotate": [
    "跟随朝向旋转",
    "跟隨朝向旋轉",
    "Rotate with heading"
  ],
  "color": [
    "颜色",
    "顏色",
    "Color"
  ],
  "profile": [
    "切换灵魂配置",
    "切換靈魂配置",
    "Switch soul profile"
  ],
  "appearance": [
    "调整灵魂外观",
    "調整靈魂外觀",
    "Change soul appearance"
  ],
  "teleport": [
    "传送灵魂",
    "傳送靈魂",
    "Teleport soul"
  ],
  "pick": [
    "选择配置",
    "選擇配置",
    "Select profile"
  ],
  "shootable": [
    "可被玩家弹击破",
    "可被玩家彈擊破",
    "Breakable by player shots"
  ],
  "hint": [
    "配置分别控制外观、移动和能力。试打时开启判定显示可查看速度和冷却。",
    "配置分別控制外觀、移動和能力。試打時開啟判定顯示可查看速度和冷卻。",
    "Configure appearance, movement and abilities separately. Enable hitboxes in playtest to see speed and cooldowns."
  ],
  "missing": [
    "缺少机制",
    "缺少機制",
    "Missing mechanism"
  ]
};
const languages = ['zh-Hans', 'zh-Hant', 'en'];
registerStrings('soul', Object.fromEntries(languages.map((locale, i) =>
  [locale, Object.fromEntries(Object.entries(labels).map(([key, values]) => [key, values[i]]))])));
export const soulT = (key) => t('soul.' + key);
export const soulLabel = (labels) => labels[languages.indexOf(getLocale())];
