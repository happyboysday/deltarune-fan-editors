/**
 * engine/encounter/layout.js — 戰鬥版面常數（依 SPEC-LAYOUT 實機量測）
 *
 * 這裡是**唯一**的版面數字來源：渲染器（E2）、編輯器、引擎共用同一份，
 * 避免各處各自寫死座標而對不上參考幀。
 *
 * 座標系：640×480 邏輯像素，原點左上。
 * 參考：battle-editor/docs/SPEC-LAYOUT.md（來源為實機錄影量測，誤差約 ±3px）。
 *
 * 本檔純資料，不碰 DOM。
 */

/** 邏輯畫面尺寸 */
export const VIEW_W = 640;
export const VIEW_H = 480;

/** 戰場（背景）與隊伍面板的分界線（SPEC-LAYOUT §1） */
export const BATTLE_AREA_BOTTOM = 362;

/** 隊伍面板列（y 365–400）：每格顯示頭像 / 名字 / HP 數字與 HP 條（§6） */
export const PANEL_TOP = 365;
export const PANEL_BOTTOM = 400;
export const PANEL_HEIGHT = PANEL_BOTTOM - PANEL_TOP;
export const PANEL_MARGIN = 107;
export const PANEL_GAP = 22;
export const PANEL_AVATAR_SIZE = 16;
export const PANEL_AVATAR_SCALE = 2;
export const PANEL_HP_BAR = { dx: 128, w: 77, h: 8 };
/** 選單中該隊員的面板整格上移量（§6） */
export const PANEL_RAISE = 35;

/** 底部文字區（y 405–480）：旁白 / 對話 / 選單清單 / FIGHT 條（§7） */
export const TEXT_TOP = 405;
export const TEXT_BOTTOM = 480;
export const TEXT_LEFT = 30;
export const TEXT_INDENT = 58;
export const TEXT_LINE_HEIGHT = 32;

/** TP 條（左上，§2） */
export const TP_BAR = { x: 40, y: 50, w: 20, h: 208 };

/**
 * 隊員腳底 y（§3，依人數套用；精靈以腳底為錨點、放大 2 倍、水平置中約 x=100）。
 * 索引 i 對應「第 i 位隊員」。
 */
export const PARTY_FEET = {
  1: [240],
  2: [190, 298],
  3: [140, 230, 322],
  4: [120, 190, 260, 330],
};

/** 隊員水平基準 x 與前後錯開量（§3：各人 ±8） */
export const PARTY_CENTER_X = 128;
export const PARTY_STAGGER_X = 8;

/** 敵人錨點（§4：中心 x 約 470–540、腳底 y 約 240–300） */
export const ENEMY_CENTER_X = 505;
export const ENEMY_FEET_Y = 270;
export const ENEMY_STAGGER = { x: 25, y: 45 };

/**
 * 戰鬥框預設值（§5）：外框約 150×165 → 中心 (320,190)，
 * 內部尺寸 144×158、綠描邊 3px。
 * 注意：SPEC-LAYOUT 量測中心 x 為 321（±3px）；這裡與攻擊層 BOX_DEFAULTS 統一取 320，
 *       避免兩層預設值不一致。攻擊檔的 BOX_DEFAULTS（engine/attack.js）必須與此相同。
 */
export const BATTLE_BOX = {
  x: 320,
  y: 190,
  w: 144,
  h: 158,
  border: 3,
  color: '#00c000',
};

/** 戰鬥框展開動畫：約 9 幀（§5：從中心旋轉+縮放展開） */
export const BOX_ANIM_FRAMES = 9;
/** 展開時的最大旋轉角（度）：由 ±90 收斂到 0 */
export const BOX_ANIM_ROTATION = 90;
/** 展開時的起始縮放（0 → 1） */
export const BOX_ANIM_SCALE_FROM = 0;

/** 敵人台詞泡泡（§8：白底圓角矩形、位於說話者左側、高度對齊頭部） */
export const BUBBLE = {
  width: 168,
  lineHeight: 14,
  /** 泡泡與演員的水平間距 */
  gap: 46,
  /** 泡泡底邊相對演員「頭部」的位移（頭部 = 演員 y - 精靈高 × 2） */
  headOffset: 0,
  /** 未知精靈高度時的預設值（邏輯像素） */
  defaultSpriteHeight: 32,
};

/** 傷害數字（§9：目標右側、由上往下堆疊、行距 20、約 1 秒後淡出） */
export const NUMBER = {
  /** 堆疊行距 */
  lineHeight: 20,
  /** 出現位置：目標中心往右的偏移 */
  offsetX: 24,
  /** 出現位置：目標中心往上的偏移 */
  offsetY: 10,
  /** 完全不透明的停留幀數（約 1 秒，SPEC-LAYOUT §9「約 1 秒後淡出」） */
  holdFrames: 30,
  /** 淡出所需幀數 */
  fadeFrames: 10,
  /** 總存活幀數 = 停留 + 淡出 */
  life: 40,
  /** 淡出開始的 age 比例（30/40 = 0.75） */
  fadeStart: 0.75,
  /** 上彈的初始速度（px/幀） */
  bounceVy: -2.4,
  /** 上彈重力（px/幀²），讓數字彈一下後停住 */
  bounceGravity: 0.35,
  /** 允許同時存在的數字上限 */
  max: 64,
};

/**
 * 依隊伍人數取得腳底 y 陣列（§3）。
 * @param {number} count
 * @returns {number[]}
 */
export function partyFeetFor(count) {
  const n = Math.max(1, Math.min(4, Math.round(Number(count) || 1)));
  const feet = PARTY_FEET[n];
  return feet.slice(0, n);
}

/** 整份常數物件（給渲染 / 編輯器一次拿） */
export const LAYOUT = {
  VIEW_W,
  VIEW_H,
  BATTLE_AREA_BOTTOM,
  PANEL_TOP,
  PANEL_BOTTOM,
  PANEL_HEIGHT,
  PANEL_MARGIN,
  PANEL_GAP,
  PANEL_AVATAR_SIZE,
  PANEL_AVATAR_SCALE,
  PANEL_HP_BAR,
  PANEL_RAISE,
  TEXT_TOP,
  TEXT_BOTTOM,
  TEXT_LEFT,
  TEXT_INDENT,
  TEXT_LINE_HEIGHT,
  TP_BAR,
  PARTY_FEET,
  PARTY_CENTER_X,
  PARTY_STAGGER_X,
  ENEMY_CENTER_X,
  ENEMY_FEET_Y,
  ENEMY_STAGGER,
  BATTLE_BOX,
  BOX_ANIM_FRAMES,
  BOX_ANIM_ROTATION,
  BOX_ANIM_SCALE_FROM,
  BUBBLE,
  NUMBER,
  partyFeetFor,
};

export default LAYOUT;
