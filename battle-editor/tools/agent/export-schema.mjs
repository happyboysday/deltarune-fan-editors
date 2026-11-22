/**
 * tools/agent/export-schema.mjs — 由引擎匯出 JSON Schema（SPEC-AGENT §1.4「自我說明」）。
 *
 * 為什麼要有這支：
 *   Agent 不該讀原始碼才能知道格式。這裡直接把引擎的**真實定義**（normalize 的預設值、
 *   EVENT_TYPES、CUE_COMMANDS、VAR/HELPER 名單）匯出成 JSON Schema draft 2020-12，附中文
 *   欄位說明與範例，寫到 generated/schema/。
 *
 * 產出（generated/schema/）：
 *   attack.json     攻擊檔 dr-battle-attack/1
 *   encounter.json  遭遇檔 dr-battle-encounter/1
 *   cues.json       演出指令（cue）字典 + 文字值 + 表達式參考
 *
 * 冪等：內容沒變就不寫檔（不更新 mtime）。
 *
 * 用法：
 *   node tools/agent/export-schema.mjs            # 匯出到 generated/schema/
 *   node tools/agent/export-schema.mjs --out DIR  # 自訂輸出目錄
 *   node tools/agent/export-schema.mjs --check    # 只驗證現有檔案是否最新（CI 用）
 */

import { join } from 'node:path';
import { soulMechanisms } from '../../engine/soul-mechanics.js';
import { ARENA_KINDS, BOX_APPEARANCES, CLIP_TARGETS, STAGE_BOX } from '../../engine/arena.js';

import {
  ATTACK_FORMAT,
  BOX_DEFAULTS,
  BULLET_DEFAULTS,
  EVENT_TYPES,
  FPS,
  SETTINGS_DEFAULTS,
  SOUL_DEFAULTS,
  SPAWN_DEFAULTS,
  SPAWN_FIELDS,
  SPAWN_NUMERIC_FIELDS,
  SPAWN_PATH_FIELDS,
} from '../../engine/attack.js';
import { EASING_NAMES } from '../../engine/easing.js';
import {
  HELPER_NAMES,
  LOOKUP_NAMES,
  SANDBOX_NAMES,
  VAR_NAMES,
} from '../../engine/expr.js';
import {
  CUE_CATEGORIES,
  CUE_COMMANDS,
  ENCOUNTER_FORMAT,
  ENEMY_ANIM_STATES,
  HOOK_NAMES,
  LANGS,
  PARTY_ANIM_STATES,
  PARTY_COMMANDS,
  PHASES,
  RESULT_TYPES,
  TURN_ORDERS,
} from '../../engine/encounter/schema.js';
import {
  GENERATED_DIR,
  SCHEMA_DIR,
  applyCliPaths,
  cliEntry,
  parseArgs,
  readJSON,
  writeJSON,
} from './lib.mjs';

const SCHEMA_VERSION = 'dr-battle-schema/1';

/* ==================================================================== */
/* 中文說明字典                                                          */
/* ==================================================================== */

const T = {
  attackMeta:
    '攻擊檔（dr-battle-attack/1）：一段時間軸上的彈幕演出。人與 Agent 用同一個 JSON。',
  encounterMeta:
    '遭遇檔（dr-battle-encounter/1）：敵人、隊伍、回合與演出指令。回合的彈幕以 attack 參照。',
};

const CMD_DESC = {
  say: '在下方文字框說一句話；打完字等玩家按 Z（打字中按 Z = 立即顯示全文）。',
  bubble: '在某個演員旁邊冒出對話泡泡；預設等玩家按 Z 或逾時。',
  move: '把演員平滑移動到指定座標（可相對）。',
  anim: '切換演員的動畫狀態（anims 的 key）或直接指定 sprite。',
  form: '切換演員形態（actor.forms 的 key）；形態內未定義的動畫退回基礎 anims（SPEC-P2 §1）。',
  flip: '水平翻轉演員（面朝左 / 右）。',
  fade: '把演員淡入淡出到指定透明度。',
  wait: '暫停指定秒數。',
  sfx: '播放一次音效（音效名見 assets/index.json 的 audio 或 /api/assets/search）。',
  bgm: '切換背景音樂；track 為 null 表示停止，fade 為淡出秒數。',
  shake: '畫面震動。',
  flash: '畫面閃光。',
  set: '設定或累加一個自訂變數（Agent 常用來記錄 ACT 分支）。',
  mercy: '增加敵人饒恕值（夾在 0..100）。',
  heal: '回復目標 HP 並跳數字（"party" 代表全隊）。',
  item: '增減這場遭遇的道具數量（戰鬥獎勵或消耗；減到 0 為止）。場景編輯器在戰後把剩餘數量帶回場景。',
  damage: '對目標造成傷害並跳數字（"party" 代表全隊）。',
  if: '條件分支：cond 非 0 走 then，否則走 else。',
  parallel: '同時執行多條子指令，全部完成才繼續。',
  attack: '在腳本中插入一段彈幕（回合的攻擊也可用 turns[].attack）。',
  end: '立即以指定結果結束遭遇。',
};

const PARAM_EXTRA_DESC = {
  'say.text': '台詞；可用 \\n 換行。',
  'say.speaker': '說話者名稱（顯示在文字框上方；省略則不顯示）。',
  'say.portrait': '頭像 sprite 名（assets/index.json 的 sprite key）。',
  'say.speed': '打字速度，每秒幾個字（1 = 原始速度）。',
  'say.voice': '每個字播放的音效名（打字音）。',
  'bubble.side': '泡泡在演員的哪一側；auto = 依演員位置自動。',
  'bubble.wait': '"input" 等玩家按 Z；或給秒數逾時自動關閉。',
  'move.ease': `補間曲線：${EASING_NAMES.join(' / ')}。`,
  'anim.anim': '動畫狀態名（actors.<id>.anims 的 key），例如 idle / attack / hurt。',
  'anim.sprite': '直接指定 sprite（覆寫狀態），適合一次性特效。',
  'anim.waitEnd': 'true 時等「非循環動畫」播完才繼續（適合攻擊動作）。',
  'set.var': '變數名（之後用 var.<name> 或 vars.<name> 讀取）。',
  'set.value': '數字或表達式字串，例如 "var.praised + 1"。',
  'mercy.enemy': '敵人 id（enemies[].id）。',
  'heal.target': '隊員 id / 敵人 id / "party"（全隊）。',
  'item.id': '道具 id（這場遭遇 items[].id）。',
  'item.delta': '增減數量；負數為消耗。可寫表達式。',
  'if.cond': '表達式；非 0 為真。例如 "mercy.rudinn >= 100"。',
  'attack.attack': '攻擊檔名（attacks/ 或 samples/ 下的檔名，不含 .json）或內嵌攻擊物件。',
  'end.result': '終局結果：victory / spared / defeat / flee。',
};

const VAR_DESC = {
  t: '本發子彈生成後經過的秒數（spawn 時為 0；pathX/pathY 每幀求值時很有用）。',
  T: '整段攻擊的總長秒數（settings.duration）。',
  i: '本次生成批次中的索引（0 起算）——做扇形、環形彈幕的角度公式。',
  n: '本次生成批次的總數量（與 i 搭配算出均分角度）。',
  k: '生成批次編號（第幾波）。',
  age: '子彈年齡（秒），與 t 類似但從出生開始累加。',
  box: '戰鬥框 {x,y,w,h,left,right,top,bottom,rotation}；邊界座標不含旋轉，rotation 為角度（度）。',
  soul: '靈魂（紅心）{x,y}。',
  x: '本次生成「已求值」的 x 座標（讓 angle 可用 aim(x, y)）。',
  y: '本次生成「已求值」的 y 座標。',
  turn: '目前回合編號（遭遇戰用）。',
  tp: '目前 TP 值（0..100）。',
  spawnX: '本發子彈的生成 x（spawn.x 求值後；省略時為戰鬥框中心）。生成欄位與 pathX/pathY 都讀得到，用來寫「相對生成點」的位移。',
  spawnY: '本發子彈的生成 y（與 spawnX 同時固定）；生成欄位與 pathX/pathY 都讀得到。',
  spawnT: '本發子彈的生成時間（秒）＝生成該幀的回合時間 frame / 30；與 t（事件開始後的相對秒數）不同。',
  bpm: 'settings.bpm（每分鐘拍數）；沒設定 bpm 時為 0。例：speed: "bpm/60"。',
  beat: '一拍秒數＝60 / bpm；沒設定 bpm 時為 0。例：life: "beat*4"。',
  mem: '每顆子彈的記憶物件：mem.<name>，由 spawn.memory 於生成時求值一次後固定；未定義的名字讀到 0。',
};

const HELPER_DESC = {
  sin: 'sin(角度弧度)。例：sin(t * 6)',
  cos: 'cos(角度弧度)。',
  tan: 'tan(角度弧度)。',
  atan2: 'atan2(y, x) → 弧度。',
  sqrt: '平方根。',
  abs: '絕對值。',
  min: 'min(a, b)。',
  max: 'max(a, b)。',
  floor: '向下取整。',
  ceil: '向上取整。',
  round: '四捨五入。',
  PI: '圓周率常數（用法：PI）。',
  rand: 'rand(min, max) → [min, max) 的亂數（決定性，受 settings.seed 控制）。',
  pick: 'pick(a, b, ...) → 隨機挑一個參數。',
  aim: 'aim(x, y) → 從「生成本次子彈的位置」指到 (x, y) 的角度（度）。常用 aim(soul.x, soul.y)。',
  lerp: 'lerp(a, b, u) → 線性插值。',
};

const LOOKUP_DESC = {
  mercy: 'merc.<id> 之前要寫 mercy.<enemyId> —— 敵人饒恕值 0..100。',
  hp: 'hp.<id> —— 隊員或敵人目前 HP。',
  maxHp: 'maxHp.<id> —— 隊員或敵人最大 HP。',
  alive: 'alive.<id> —— 存活為 1，否則 0。',
  actCount: 'actCount.<enemyId>_<actId> —— 某個 ACT 被使用過幾次。',
  vars: 'vars.<name> 或 var.<name> —— 自訂變數（set 指令寫入）。',
};

const TEXT_VALUE_DESC =
  '文字欄位：可給字串（兩種語言共用），或 { "zh": "簡體中文", "en": "English" } 由語言選項取用。';

/* ==================================================================== */
/* 共用 schema 片段                                                      */
/* ==================================================================== */

const TEXT_VALUE = {
  $ref: '#/$defs/textValue',
};

function textValueDef() {
  return {
    title: '文字值',
    description: TEXT_VALUE_DESC,
    oneOf: [
      { type: 'string', examples: ['* 魯丁擋住了去路！'] },
      {
        type: 'object',
        description: '{ zh, en } 雙語物件；未知語言鍵會被忽略。',
        properties: {
          zh: { type: 'string', description: '簡體中文（遊戲畫面預設語言）。' },
          en: { type: 'string', description: '英文。' },
        },
        additionalProperties: false,
        examples: [{ zh: '* 魯丁擋住了去路！', en: '* Rudinn blocks the way!' }],
      },
    ],
  };
}

function colorDef() {
  return {
    type: 'string',
    pattern: '^#[0-9a-fA-F]{3,8}$',
    description: '顏色：#rrggbb（也接受 #rgb / #rrggbbaa）。',
    examples: ['#00c000', '#ff0000', '#ffffff'],
  };
}

function numberDef(description, extra = {}) {
  return { type: 'number', description, ...extra };
}

function exprDef(description) {
  return {
    description: `${description}（可給數字，或字串形式的白名單表達式，例如 "rand(2, 4)"、"aim(soul.x, soul.y)"）`,
    oneOf: [{ type: 'number' }, { type: 'string', examples: ['rand(2.2, 3.6)'] }],
  };
}

/* ------------------------------------------------- 拍點時間欄位（SPEC-EXPR-V2 §1） */

/** 拍點字串語法（與 engine/attack.js 的 BEAT_RE 一致；b 大小寫不敏感）。 */
const BEAT_STRING_PATTERN = '^[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)[bB]$';

const BEAT_HINT =
  '也接受拍點字串（例如 "2b"、"0.5b"、"1.5b"），換算為拍數 × 60 / settings.bpm；' +
  '時間點欄位（at、demo.path[].t）會再加上 settings.beatOffset，長度欄位不會。用拍點字串需要 settings.bpm。';

/**
 * 時間欄位：秒（數字）或拍點字串 `"2b"`（SPEC-EXPR-V2 §1）。
 * @param {string} description
 * @param {object} extra 數字分支的限制（minimum / exclusiveMinimum / maximum / default / examples）
 */
function timeDef(description, extra = {}) {
  const { default: dflt, examples, ...numeric } = extra;
  const def = {
    description: `${description}${BEAT_HINT}`,
    oneOf: [
      { type: 'number', ...numeric },
      {
        type: 'string',
        pattern: BEAT_STRING_PATTERN,
        description: '拍點字串：拍數 + b，例如 "2b"、"1.5b"、".5b"（需 settings.bpm）。',
        examples: ['2b', '0.5b'],
      },
    ],
  };
  if (dflt !== undefined) def.default = dflt;
  if (examples !== undefined) def.examples = examples;
  return def;
}

/** 生成欄位 `memory`（SPEC-EXPR-V2 §2.2）：生成時求值一次的每顆子彈變數。 */
function memoryDef() {
  return {
    title: '子彈記憶',
    type: 'object',
    description:
      '每顆子彈的記憶（SPEC-EXPR-V2 §2.2）：生成時依 JSON 鍵順序求值一次後固定，之後用 mem.<name> 在生成欄位與 pathX/pathY 讀取。' +
      '名稱需為合法識別字（不可用 constructor / __proto__ 等保留名），值為數字或表達式字串；沒定義的名字讀到 0。',
    propertyNames: { pattern: '^[A-Za-z_$][A-Za-z0-9_$]*$' },
    additionalProperties: {
      description: '數字，或白名單表達式字串（可引用先算出的 mem.<name>）。',
      oneOf: [{ type: 'number' }, { type: 'string', examples: ['i*90 + k*20'] }],
    },
    examples: [{ a0: 'i*90 + k*20', dir: 'rand(0, 360)' }],
  };
}

/* ==================================================================== */
/* 自動演示 demo（SPEC-AUTOPLAY §2）                                     */
/* ==================================================================== */

const DEMO_FALLBACK_VALUES = ['bot', 'stay'];
const DEMO_DODGE_VALUES = ['path', 'inputs', 'bot', 'none'];
const DEMO_COMMAND_VALUES = ['fight', 'act', 'magic', 'item', 'spare', 'defend'];
const DEMO_FIGHT_VALUES = ['perfect', 'good', 'miss'];

function demoPathPointSchema() {
  return {
    title: '路徑點',
    type: 'object',
    required: ['t', 'x', 'y'],
    properties: {
      t: timeDef('時間（秒；同一數值允許，需遞增）。', { minimum: 0, examples: [1.2] }),
      x: numberDef('目標 x（640×480 邏輯座標；跟隨時會夾在戰鬥框內）。', { examples: [304] }),
      y: numberDef('目標 y（會夾在戰鬥框內）。', { examples: [254] }),
      slow: { type: 'boolean', description: '這一段改用低速移動（按住 X/Shift）。', default: false },
      hold: numberDef('抵達後停留秒數（下一個點的時間會自動往後推）。', { minimum: 0, examples: [0.4] }),
    },
    additionalProperties: true,
  };
}

function demoFightSchema() {
  return {
    description: 'FIGHT 打擊條的時機：perfect / good / miss，或 0..1（0 = 判定點正中、1 = 最邊緣）。',
    oneOf: [{ type: 'string', enum: DEMO_FIGHT_VALUES }, { type: 'number', minimum: 0, maximum: 1 }],
  };
}

function demoDodgeSchema() {
  return {
    type: 'string',
    enum: DEMO_DODGE_VALUES,
    description:
      '該回合的躲避方式：path / inputs 讀該回合攻擊檔的 demo；bot = AI；none = 不躲避。省略 = 攻擊檔 demo.mode，再省略 = bot。',
  };
}

function demoEncounterChoiceSchema() {
  return {
    title: '隊員選擇',
    type: 'object',
    required: ['member', 'command'],
    properties: {
      member: { type: 'string', description: '隊員 id（encounter.party[].id）。', examples: ['kris'] },
      command: { type: 'string', enum: DEMO_COMMAND_VALUES, description: '指令。' },
      target: { type: 'string', description: '敵人 id 或隊員 id（item / magic 的對象）。', examples: ['rudinn'] },
      option: { type: 'string', description: 'ACT 名稱 / 法術名 / 道具名（比對 en 名或 id）。', examples: ['Check'] },
    },
    additionalProperties: true,
  };
}

function attackDemoSchema() {
  return {
    title: '自動演示',
    type: 'object',
    description:
      '攻擊的自動演示腳本（SPEC-AUTOPLAY §2.1）：path = 跟隨路徑、inputs = 重播錄製輸入、bot = 全程 AI。省略 mode 時依序看 path → inputs → bot。',
    properties: {
      mode: {
        type: 'string',
        enum: ['path', 'inputs', 'bot'],
        description:
          '預設模式：path = 路徑點；inputs = 錄製的輸入；bot = 全程 AI。省略 = 有 path 用 path、否則有 inputs 用 inputs、否則 bot。',
      },
      path: {
        type: 'array',
        description: '路徑點（t 秒遞增、x/y 邏輯座標、選填 slow/hold）。照時間插值目標點並按方向鍵跟隨，不瞬移。',
        items: demoPathPointSchema(),
        examples: [
          [
            { t: 0, x: 320, y: 190 },
            { t: 1.2, x: 280, y: 240 },
            { t: 2.0, x: 360, y: 240, slow: true },
            { t: 3.5, x: 320, y: 160, hold: 0.4 },
          ],
        ],
      },
      inputs: {
        type: 'string',
        description:
          '錄製的輸入（行程長度編碼）：`幀:鍵` 以 ; 分隔，代表從該幀起按住直到下一段；鍵 L/R/U/D/S（S = slow），單次按下 !z（確認）!x（取消）!c（選單）附在鍵後，空鍵 = 放開。例："0:;12:R;30:RD;45:D;60:DS;90:"',
        examples: ['0:;12:R;30:RD;45:D;60:DS;90:'],
      },
      fallback: {
        type: 'string',
        enum: DEMO_FALLBACK_VALUES,
        description: '腳本用完（路徑最後一點之後 / inputs 結束）後的行為：bot = 交給 AI；stay = 不再按鍵（預設）。',
        default: 'stay',
      },
    },
    additionalProperties: true,
    examples: [
      {
        mode: 'path',
        fallback: 'bot',
        path: [
          { t: 0, x: 320, y: 190 },
          { t: 3.3, x: 304, y: 254, slow: true },
        ],
      },
    ],
  };
}

function encounterDemoSchema() {
  return {
    title: '自動演示（遭遇）',
    type: 'object',
    description:
      '遭遇的自動演示腳本（SPEC-AUTOPLAY §2.2）：自動按掉文字、導航選單、指定 FIGHT 時機與每回合躲避方式；找不到的選項會退回 default 並記 warnings。',
    properties: {
      text: {
        title: '文字',
        type: 'object',
        description: '文字框 / 泡泡的自動推進。',
        properties: {
          auto: { type: 'boolean', description: '打完字後自動按確認（預設 true）。', default: true },
          delay: numberDef('自動確認前等待秒數（預設 0.5）。', { minimum: 0, default: 0.5 }),
        },
        additionalProperties: true,
      },
      menuDelay: numberDef('選單中每次游標移動 / 確認之間的幀數（預設 6，讓觀眾看得到；0 = 最快）。', {
        minimum: 0,
        default: 6,
      }),
      turns: {
        title: '回合腳本',
        type: 'array',
        description: '依實際進行的回合（turn 1 起算，重複回合繼續累計）指定隊員選擇、FIGHT 時機與躲避方式；未列出的回合用 default。',
        items: {
          type: 'object',
          properties: {
            turn: { type: 'integer', minimum: 1, description: '回合編號（1 起算）。', examples: [1] },
            choices: {
              type: 'array',
              description: '每位隊員的選擇；未列出的隊員用 default。',
              items: demoEncounterChoiceSchema(),
              examples: [
                [
                  { member: 'kris', command: 'act', target: 'rudinn', option: 'Check' },
                  { member: 'susie', command: 'fight', target: 'rudinn' },
                  { member: 'ralsei', command: 'magic', option: 'Pacify', target: 'rudinn' },
                ],
              ],
            },
            fight: demoFightSchema(),
            dodge: demoDodgeSchema(),
          },
          additionalProperties: true,
        },
      },
      default: {
        title: '預設規則',
        type: 'object',
        description: '沒在 turns 列出的回合（或隊員）使用；choices 可省略。',
        properties: {
          choices: {
            description: '預設選擇：指令字串（例如 "fight" / "defend"）或與 turns[].choices 相同的陣列。',
            oneOf: [
              { type: 'string', enum: DEMO_COMMAND_VALUES },
              { type: 'array', items: demoEncounterChoiceSchema() },
            ],
          },
          fight: demoFightSchema(),
          dodge: demoDodgeSchema(),
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
    examples: [
      {
        text: { auto: true, delay: 0.5 },
        menuDelay: 6,
        turns: [
          {
            turn: 1,
            choices: [
              { member: 'kris', command: 'act', target: 'rudinn', option: 'Compliment' },
              { member: 'susie', command: 'defend' },
            ],
            fight: 'perfect',
            dodge: 'path',
          },
        ],
        default: { choices: 'fight', fight: 'good', dodge: 'bot' },
      },
    ],
  };
}

/* ==================================================================== */
/* attack.json                                                          */
/* ==================================================================== */

function buildAttackSchema() {
  const polygonPoints = {
    type: 'array',
    minItems: 3,
    maxItems: 64,
    description: '按邊界順序排列的舞台座標，可內凹但不可自交；末點會自動接回首點。',
    items: {
      type: 'object',
      required: ['x', 'y'],
      properties: {
        x: numberDef('舞台 X。', { minimum: 0, maximum: STAGE_BOX.w }),
        y: numberDef('舞台 Y。', { minimum: 0, maximum: STAGE_BOX.h }),
      },
    },
  };
  const spawnProperties = {};
  const spawnDescriptions = {
    x: '生成點 x（像素，640×480 邏輯座標）。省略 = 戰鬥框中心。例："rand(box.left + 8, box.right - 8)"',
    y: '生成點 y。省略 = 戰鬥框中心。例："box.top - 18"',
    speed: '初速（像素/幀）。例："rand(2.2, 3.6)"',
    angle: '初速方向（度；0 = 向右、90 = 向下、180 = 向左、270 = 向上）。例："aim(soul.x, soul.y)"',
    accel: '每幀加速度（沿速度方向；負值 = 減速）。',
    angularVel: '每幀角度增量（度），讓子彈轉彎。',
    scale: '繪製縮放（1 = 原始大小）。',
    rotation: '初始旋轉（度）；bulletType.faceVelocity 為 true 時會被速度方向覆寫。',
    life: '存活秒數；null = 一直存在（直到離開畫面）。',
    alpha: '不透明度 0..1。',
    pathX: '每幀求值的 x 位移表達式（相對生成點）。與 speed 並用時 pathX 會覆寫 x 軸運動。',
    pathY: '每幀求值的 y 位移表達式（相對生成點）。',
  };
  for (const key of SPAWN_FIELDS) {
    const def = SPAWN_DEFAULTS[key];
    if (key === 'life') {
      // life 是時間長度欄位：數字秒 / 拍點字串（需 bpm）/ 表達式字串（SPEC-EXPR-V2 §1.3）
      spawnProperties.life = {
        description:
          '存活秒數；null = 一直存在（直到離開畫面）。可給數字（秒）、拍點字串（"4b"，需 settings.bpm），' +
          '或白名單表達式字串（例如 "beat*4"，生成時求值）。',
        oneOf: [
          { type: 'number', minimum: 0, examples: [2.5] },
          { type: 'string', pattern: BEAT_STRING_PATTERN, description: '拍點字串，例如 "4b"。', examples: ['4b'] },
          { type: 'string', description: '白名單表達式字串（生成時求值）。', examples: ['beat*4'] },
        ],
        'x-default': def,
        default: null,
        examples: [2.5, '4b', 'beat*4'],
      };
      continue;
    }
    spawnProperties[key] = {
      ...exprDef(spawnDescriptions[key] || '生成欄位'),
      'x-default': def,
      examples: typeof def === 'number' ? [def] : ['rand(0, 360)'],
    };
  }
  // memory（SPEC-EXPR-V2 §2.2）：生成時求值一次、固定在每顆子彈上的變數
  spawnProperties.memory = memoryDef();

  const bulletTypeSchema = {
    title: '子彈類型',
    description: '定義一種子彈的外觀與碰撞。timeline 的 spawn/emitter 用 bullet 名稱參照。',
    type: 'object',
    properties: {
      sprite: {
        type: ['string', 'null'],
        description: 'sprite 名（assets/index.json 的 key）。null = 用純色方塊（洋紅佔位）。',
        examples: ['spr_spadebullet', null],
      },
      frameRate: numberDef('動畫每秒幀數（0 = 靜止單幀）。', { minimum: 0, default: BULLET_DEFAULTS.frameRate }),
      scale: numberDef('繪製縮放。', { default: BULLET_DEFAULTS.scale }),
      color: {
        type: ['string', 'null'],
        description: '染色（null = 原色）。',
        examples: ['#ff00ff', null],
      },
      hitbox: {
        title: '碰撞盒',
        description: '碰撞判定形狀。子彈的判定是與靈魂（紅心半徑 4px）的距離。',
        oneOf: [
          {
            type: 'object',
            required: ['shape', 'r'],
            properties: {
              shape: { const: 'circle', description: '圓形判定。' },
              r: numberDef('半徑（像素）。', { minimum: 0, default: 6 }),
            },
            additionalProperties: false,
          },
          {
            type: 'object',
            required: ['shape', 'w', 'h'],
            properties: {
              shape: { const: 'rect', description: '矩形判定（會隨子彈 rotation 旋轉）。' },
              w: numberDef('寬（像素）。', { minimum: 0, default: 8 }),
              h: numberDef('高（像素）。', { minimum: 0, default: 8 }),
            },
            additionalProperties: false,
          },
        ],
      },
      damage: numberDef('這一種子彈的傷害；null = 用 settings.damage。', { minimum: 0 }),
      decor: { type: 'boolean', default: false, description: '純裝飾子彈，不命中、不擦彈，不納入 AI 或難度密度。' },
      grazeable: {
        type: 'boolean',
        description: '是否可擦彈（擦到 +grazeTP TP）。false 用於純裝飾或無法擦的危險彈。',
        default: BULLET_DEFAULTS.grazeable,
      },
      destroyOnHit: { type: 'boolean', description: '命中後是否消失。', default: BULLET_DEFAULTS.destroyOnHit },
      faceVelocity: {
        type: 'boolean',
        description: 'true = sprite 朝向速度方向（rotation 自動跟隨）。',
        default: BULLET_DEFAULTS.faceVelocity,
      },
      offscreen: {
        enum: ['destroy', 'keep'],
        description: '離開畫面（含 200px 邊界）後的行為：destroy = 回收，keep = 保留。',
        default: BULLET_DEFAULTS.offscreen,
      },
      shootable: { type: 'boolean', default: false, description: '可被玩家彈擊破。' },
      maskToBox: {
        type: 'boolean',
        description: '舊版裁剪設定：未指定 clipTo 時，true 相當於 box。',
        default: BULLET_DEFAULTS.maskToBox,
      },
      clipTo: {
        enum: CLIP_TARGETS,
        description: '子彈的裁剪與碰撞範圍：none 不裁剪、box 戰鬥框、arena 玩家活動區、custom 獨立多邊形。',
      },
    },
    additionalProperties: true,
    examples: [
      {
        sprite: 'spr_spadebullet',
        frameRate: 0,
        scale: 0.55,
        hitbox: { shape: 'circle', r: 6 },
        damage: null,
        grazeable: true,
        destroyOnHit: true,
        faceVelocity: true,
        offscreen: 'destroy',
        maskToBox: false,
      },
    ],
  };

  const eventCommon = {
    id: { type: 'string', description: '事件 id（同一檔案不可重複；編輯器用來識別）。' },
    at: timeDef('觸發時間（秒，30 FPS 對齊）。', { minimum: 0, examples: [0.4] }),
    label: { type: 'string', description: '給人看的中文標籤（不影響模擬）。' },
    type: { type: 'string', enum: EVENT_TYPES, description: '事件類型。' },
  };

  const events = {};
  const soulProfileId = { type: 'string', pattern: '^[a-zA-Z0-9_-]{1,40}$' };
  const soulAppearance = {
    type: 'object', additionalProperties: false,
    properties: {
      color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$' },
      sprite: { type: ['string', 'null'], minLength: 1, examples: ['builtin:soul-car'] },
      rotate: { type: 'boolean' },
      anchorX: { type: 'number', minimum: -128, maximum: 128 },
      anchorY: { type: 'number', minimum: -128, maximum: 128 },
    },
  };
  const mechanismSchema = (kind) => ({ oneOf: [...soulMechanisms[kind].values()].map((def) => ({
    type: 'object', required: ['id', 'version'],
    properties: {
      id: { const: def.id }, version: { const: def.version },
      params: { type: 'object', additionalProperties: false,
        properties: Object.fromEntries(Object.entries(def.fields).map(([key, field]) => [key, {
          type: field.step === 1 ? 'integer' : 'number', description: field.label[1],
          default: field.default, minimum: field.min, maximum: field.max,
        }])),
      },
    },
  })) });

  events.spawn = {
    title: '一次性生成',
    description: '在 at 時刻一次生成 count 發子彈（搭配變數 i / n 做扇形、環形）。',
    type: 'object',
    required: ['type', 'at', 'bullet'],
    properties: {
      ...eventCommon,
      bullet: { type: 'string', description: 'bulletTypes 的 key。' },
      count: { type: 'integer', minimum: 1, default: 1, description: '一次生成幾發。' },
      ...spawnProperties,
    },
    additionalProperties: true,
    examples: [
      {
        id: 'ev_ring',
        at: 1.0,
        type: 'spawn',
        bullet: 'spade',
        count: 16,
        x: 'box.x',
        y: 'box.y',
        speed: 2.4,
        angle: 'i / n * 360',
      },
    ],
  };

  events.emitter = {
    title: '持續發射器',
    description: '從 at 起持續 duration 秒，每 interval 秒生成 count 發。',
    type: 'object',
    required: ['type', 'at', 'duration', 'interval', 'spawn'],
    properties: {
      ...eventCommon,
      duration: timeDef('持續秒數。', { minimum: 0, exclusiveMinimum: 0, examples: [8.4, '16b'] }),
      interval: timeDef('每幾秒發一次。', { exclusiveMinimum: 0, default: 0.25, examples: [0.16, '1b'] }),
      count: { type: 'integer', minimum: 1, default: 1, description: '每批幾發。' },
      spawn: {
        title: '生成規格',
        type: 'object',
        required: ['bullet'],
        properties: {
          bullet: { type: 'string', description: 'bulletTypes 的 key。' },
          ...spawnProperties,
        },
        additionalProperties: true,
      },
    },
    additionalProperties: true,
    examples: [
      {
        id: 'ev_rain_a',
        at: 0.4,
        type: 'emitter',
        duration: 8.4,
        interval: 0.16,
        count: 2,
        spawn: {
          bullet: 'spade',
          x: 'rand(box.left + 8, box.right - 8)',
          y: 'box.top - 18',
          speed: 'rand(2.2, 3.6)',
          angle: '90 + rand(-12, 12)',
        },
      },
    ],
  };

  events.box = {
    title: '戰鬥框補間',
    description: '把戰鬥框（含靈魂可行走範圍）從目前值補間到 to；未給的欄位保持不變。',
    type: 'object',
    required: ['type', 'at', 'to'],
    properties: {
      ...eventCommon,
      duration: timeDef('補間秒數。', { exclusiveMinimum: 0, default: 0.5 }),
      ease: { type: 'string', enum: EASING_NAMES, default: 'linear', description: '補間曲線。' },
      to: {
        type: 'object',
        description: '目標框（中心點 x/y、寬高、旋轉）。',
        properties: {
          x: numberDef('中心 x。', { default: BOX_DEFAULTS.x }),
          y: numberDef('中心 y。', { default: BOX_DEFAULTS.y }),
          w: numberDef('寬。', { exclusiveMinimum: 0, default: BOX_DEFAULTS.w }),
          h: numberDef('高。', { exclusiveMinimum: 0, default: BOX_DEFAULTS.h }),
          rotation: numberDef('旋轉角度。', { default: 0 }),
        },
        additionalProperties: false,
        examples: [{ w: 120, h: 200 }],
      },
    },
    additionalProperties: true,
  };

  events.soul = {
    title: '靈魂設定',
    description: '改變靈魂模式/位置/顏色。Phase 1 只有 red 模式（自由移動）。',
    type: 'object',
    required: ['type', 'at'],
    properties: {
      ...eventCommon,
      mode: { type: 'string', enum: ['red'], description: '靈魂模式（目前只支援 red）。' },
      x: { type: ['number', 'null'], description: '把靈魂傳送到 x；null = 不動。' },
      y: { type: ['number', 'null'], description: '把靈魂傳送到 y；null = 不動。' },
      color: { ...colorDef(), description: '靈魂顏色。' },
    },
    additionalProperties: true,
  };

  events.soulProfile = {
    title: '切換靈魂配置', type: 'object', required: ['type', 'at', 'profile'],
    properties: { ...eventCommon, profile: soulProfileId },
  };
  events.soulAppearance = {
    title: '調整靈魂外觀', type: 'object', required: ['type', 'at', 'appearance'],
    properties: { ...eventCommon, appearance: soulAppearance },
  };
  events.soulTeleport = {
    title: '傳送靈魂', type: 'object', required: ['type', 'at', 'x', 'y'],
    properties: { ...eventCommon, x: { type: 'number' }, y: { type: 'number' } },
  };
  events.soulDrift = {
    title: '持續推動靈魂',
    description: '每幀把靈魂推 (dx, dy) 像素，一直生效到下一個 soulDrift 事件；dx、dy 都是 0 就停止。可寫運算式（soul、box、t＝事件開始後的秒數）。',
    type: 'object', required: ['type', 'at'],
    properties: {
      ...eventCommon,
      dx: { type: ['number', 'string'], description: '每幀水平位移（像素，可為運算式）。', default: 0 },
      dy: { type: ['number', 'string'], description: '每幀垂直位移（像素，可為運算式）。', default: 0 },
    },
    additionalProperties: true,
  };

  events.clear = {
    title: '清場',
    description: '清除畫面上所有子彈（可淡出）。',
    type: 'object',
    required: ['type', 'at'],
    properties: {
      ...eventCommon,
      fade: timeDef('淡出秒數（0 = 立刻消失）。', { minimum: 0, default: 0.3 }),
    },
    additionalProperties: true,
  };

  events.shake = {
    title: '震動',
    description: '畫面震動。',
    type: 'object',
    required: ['type', 'at'],
    properties: {
      ...eventCommon,
      duration: timeDef('持續秒數。', { minimum: 0, default: 0.4 }),
      amount: numberDef('震動像素。', { minimum: 0, default: 4 }),
    },
    additionalProperties: true,
  };

  events.sfx = {
    type: 'object',
    title: '播放音效',
    description: '播放一次音效（音效名見 assets/index.json 的 audio；缺檔會靜默）。',
    required: ['type', 'at', 'sound'],
    properties: {
      ...eventCommon,
      sound: {
        type: 'string',
        description: '音效名（例如 snd_hurt1、snd_graze、snd_menumove）。',
        examples: ['snd_hurt1'],
      },
    },
    additionalProperties: true,
  };

  events.anim = {
    title: '播放演員動畫',
    description: '遭遇戰中切換演員的動畫。獨立彈幕試玩沒有遭遇演員。',
    type: 'object',
    required: ['type', 'at', 'actor', 'anim'],
    properties: {
      ...eventCommon,
      actor: { type: 'string', minLength: 1, description: '遭遇演員 ID。' },
      anim: { type: 'string', minLength: 1, description: '目前形態的動畫名稱。' },
    },
    additionalProperties: true,
  };

  events.end = {
    title: '結束回合',
    description: '提前結束回合（通常最後一個事件）。',
    type: 'object',
    required: ['type', 'at'],
    properties: { ...eventCommon },
    additionalProperties: true,
  };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://deltaruneworks.local/schema/attack.json',
    title: 'DR Battle Editor — 攻擊檔',
    description: T.attackMeta,
    'x-format': ATTACK_FORMAT,
    'x-schema-version': SCHEMA_VERSION,
    'x-engine-fps': FPS,
    type: 'object',
    required: [],
    properties: {
      format: {
        const: ATTACK_FORMAT,
        description: '格式代號（固定值）。',
      },
      meta: {
        title: '中繼資料',
        type: 'object',
        description: '給人看的資訊；不影響模擬。',
        properties: {
          name: { type: 'string', description: '攻擊名稱（中文可）。', examples: ['黑桃雨'] },
          author: { type: 'string', description: '作者。', examples: ['DR Battle Editor'] },
        },
        additionalProperties: true,
      },
      settings: {
        title: '回合設定',
        type: 'object',
        description: '長度、亂數種子、傷害等。',
        properties: {
          duration: timeDef(
            `回合長度（秒）。省略時由時間軸自動推算（最大事件結束 + 0.5 秒，上限 600）。`,
            { exclusiveMinimum: 0, maximum: 600, default: SETTINGS_DEFAULTS.duration },
          ),
          seed: numberDef('亂數種子（決定性；同 seed + 同輸入 = 同結果）。', {
            default: SETTINGS_DEFAULTS.seed,
          }),
          damage: numberDef('子彈預設傷害。', { minimum: 0, default: SETTINGS_DEFAULTS.damage }),
          invincibleFrames: {
            type: 'integer',
            minimum: 0,
            description: '受傷後無敵幀數（30 = 1 秒）。',
            default: SETTINGS_DEFAULTS.invincibleFrames,
          },
          grazeTP: numberDef('每擦到一發子彈增加的 TP。', { minimum: 0, default: SETTINGS_DEFAULTS.grazeTP }),
          background: {
            type: ['string', 'null'],
            description: '背景 sprite 名（例如 spr_battlebg_0）；null = 黑底。',
            examples: ['spr_battlebg_0', null],
          },
          bgm: {
            type: ['string', 'null'],
            description: '背景音樂名（assets/index.json 的 audio 且 kind=music）；null = 不播。',
            examples: ['battle', null],
          },
          bpm: {
            type: ['number', 'null'],
            description:
              '每分鐘拍數（SPEC-EXPR-V2 §1）。設定後時間欄位才可以用拍點字串（"2b"）與表達式常數 bpm / beat；null = 沒拍點。',
            exclusiveMinimum: 0,
            default: SETTINGS_DEFAULTS.bpm,
            examples: [120, null],
          },
          beatOffset: numberDef(
            '拍點位移（秒）。只加在「時間點」欄位（at、demo.path[].t），長度類欄位不加；可為負（換算後夾到 ≥ 0）。',
            { default: SETTINGS_DEFAULTS.beatOffset, examples: [0, 0.25] },
          ),
        },
        additionalProperties: true,
      },
      box: {
        title: '戰鬥框',
        type: 'object',
        description: '可移動的原戰鬥框（x/y 為中心）。arena 為 box 或省略時也是玩家活動區。',
        properties: {
          x: numberDef('中心 x。', { default: BOX_DEFAULTS.x }),
          y: numberDef('中心 y。', { default: BOX_DEFAULTS.y }),
          w: numberDef('寬。', { exclusiveMinimum: 0, default: BOX_DEFAULTS.w }),
          h: numberDef('高。', { exclusiveMinimum: 0, default: BOX_DEFAULTS.h }),
          rotation: numberDef('旋轉角度。', { default: BOX_DEFAULTS.rotation }),
          border: numberDef('邊框粗細。', { minimum: 0, default: BOX_DEFAULTS.border }),
          color: { ...colorDef(), default: BOX_DEFAULTS.color, description: '邊框顏色。' },
          appearance: { enum: BOX_APPEARANCES, default: 'classic', description: '傳統黑底綠框、只畫框線、或隱藏。只影響畫面。' },
        },
        additionalProperties: true,
      },
      arena: {
        type: 'object',
        required: ['kind'],
        description: '玩家活動區。省略時跟隨原戰鬥框。',
        properties: {
          kind: { enum: ARENA_KINDS, default: 'box' },
          outline: { type: 'boolean', default: false, description: '額外繪製活動區邊界。' },
          points: polygonPoints,
        },
        if: { properties: { kind: { const: 'polygon' } }, required: ['kind'] },
        then: { required: ['points'] },
      },
      clipRegion: {
        type: 'object',
        required: ['points'],
        description: '供 clipTo: custom 使用的獨立裁剪區，不限制靈魂移動。',
        properties: { points: polygonPoints },
      },
      soulProfiles: {
        type: 'object', propertyNames: soulProfileId,
        additionalProperties: {
          type: 'object', required: ['movement'],
          properties: { appearance: soulAppearance, movement: mechanismSchema('movement'),
            abilities: { type: 'array', items: mechanismSchema('ability') } },
        },
      },
      soul: {
        title: '靈魂',
        type: 'object',
        description: '紅心（16×16 sprite，碰撞半徑 4px）。',
        properties: {
          profile: soulProfileId,
          x: { type: ['number', 'null'], description: '初始 x；null = 框中心。', default: SOUL_DEFAULTS.x },
          y: { type: ['number', 'null'], description: '初始 y；null = 框中心。', default: SOUL_DEFAULTS.y },
          speed: numberDef('移動速度（像素/幀）。', { minimum: 0, default: SOUL_DEFAULTS.speed }),
          slowSpeed: numberDef('低速（按住 X/Shift）移動速度。', { minimum: 0, default: SOUL_DEFAULTS.slowSpeed }),
          mode: { type: 'string', enum: ['red'], description: '靈魂模式（目前只支援 red）。', default: 'red' },
          color: { ...colorDef(), default: SOUL_DEFAULTS.color, description: '靈魂顏色。' },
        },
        additionalProperties: true,
      },
      party: {
        title: '隊伍',
        type: 'array',
        description: '戰鬥中顯示的隊員（HP 條）。省略時為單一 Kris（90 HP）。',
        items: {
          type: 'object',
          required: ['name'],
          properties: {
            name: { type: 'string', description: '隊員名。', examples: ['Kris'] },
            hp: { type: 'integer', minimum: 0, description: '目前 HP。' },
            maxHp: { type: 'integer', minimum: 1, description: '最大 HP。' },
            color: { ...colorDef(), description: 'HP 條 / 名字顏色。' },
            icon: { type: ['string', 'null'], description: '頭像 sprite 名。' },
          },
          additionalProperties: true,
        },
        examples: [[{ name: 'Kris', hp: 90, maxHp: 90, color: '#00ffff', icon: null }]],
      },
      enemies: {
        title: '敵人',
        type: 'array',
        description: '畫在右側的敵人（會輕輕上下浮動）。',
        items: {
          type: 'object',
          properties: {
            sprite: { type: ['string', 'null'], description: 'sprite 名。', examples: ['spr_hathyx_idle'] },
            x: numberDef('x 座標。', { default: 520 }),
            y: numberDef('y 座標。', { default: 200 }),
            scale: numberDef('縮放。', { default: 1 }),
            frameRate: numberDef('動畫每秒幀數。', { minimum: 0, default: 4 }),
          },
          additionalProperties: true,
        },
      },
      bulletTypes: {
        title: '子彈類型',
        type: 'object',
        description: '子彈類型表：key 是名稱，timeline 用 bullet 參照。',
        additionalProperties: bulletTypeSchema,
        examples: [
          {
            spade: {
              sprite: 'spr_spadebullet',
              hitbox: { shape: 'circle', r: 6 },
              scale: 0.55,
            },
          },
        ],
      },
      timeline: {
        title: '時間軸',
        type: 'array',
        description:
          '依 at 秒排序的事件。同一時間的事件依陣列順序執行。事件型別：' + EVENT_TYPES.join(' / ') + '。',
        items: {
          oneOf: EVENT_TYPES.map((name) => ({
            $ref: `#/$defs/event_${name}`,
          })),
        },
        examples: [
          [
            { id: 'ev_end', at: 9.9, type: 'end', label: '回合結束' },
          ],
        ],
      },
      demo: attackDemoSchema(),
    },
    additionalProperties: true,
    $defs: {
      textValue: textValueDef(),
      bulletType: bulletTypeSchema,
      spawnFields: {
        title: '生成欄位',
        type: 'object',
        description: '數值欄位可用白名單表達式字串，於生成時求值一次（pathX/pathY 例外：每幀求值）。',
        properties: spawnProperties,
        additionalProperties: true,
      },
      ...Object.fromEntries(EVENT_TYPES.map((name) => [`event_${name}`, events[name]])),
    },
    'x-expressions': {
      variables: VAR_NAMES.map((name) => ({ name, desc: VAR_DESC[name] || '' })),
      helpers: HELPER_NAMES.map((name) => ({ name, desc: HELPER_DESC[name] || '' })),
      lookups: LOOKUP_NAMES.map((name) => ({ name, desc: LOOKUP_DESC[name] || '' })),
      proxied: ['box.left', 'box.right', 'box.top', 'box.bottom', 'soul.x', 'soul.y'],
      blocked: SANDBOX_NAMES,
      note: '表達式在詞法白名單沙箱內求值：只用上面列的變數/函式與 + - * / % 括號。禁止屬性或函式呼叫以外的 JS。',
    },
    'x-defaults': {
      settings: SETTINGS_DEFAULTS,
      box: BOX_DEFAULTS,
      soul: SOUL_DEFAULTS,
      bullet: BULLET_DEFAULTS,
      spawn: SPAWN_DEFAULTS,
      spawnNumericFields: SPAWN_NUMERIC_FIELDS,
      spawnPathFields: SPAWN_PATH_FIELDS,
    },
    'x-easingNames': EASING_NAMES,
    'x-eventTypes': EVENT_TYPES,
  };
}

/* ==================================================================== */
/* encounter.json                                                       */
/* ==================================================================== */

function cueParamsSchema(cmd, params) {
  const properties = {};
  for (const name of Object.keys(params)) {
    const p = params[name] || {};
    const extra = PARAM_EXTRA_DESC[`${cmd}.${name}`];
    const entry = {
      description: (extra || [p.desc || '', p.type ? `（型別：${p.type}）` : ''].join('')).trim(),
      'x-param-type': p.type || 'any',
    };
    if (p.required) entry['x-required'] = true;
    if (p.default !== undefined) {
      entry.default = p.default;
      entry.description += ` 預設：${JSON.stringify(p.default)}。`;
    }
    if (Array.isArray(p.values)) {
      entry.enum = p.values;
      entry.description += ` 可選：${p.values.join(' / ')}。`;
    }
    if (p.nullable) entry.type = p.type === 'string' ? ['string', 'null'] : ['string', 'number', 'boolean', 'object', 'null'];
    else if (p.type === 'number') entry.type = 'number';
    else if (p.type === 'bool') entry.type = 'boolean';
    else if (p.type === 'cues') {
      entry.type = 'array';
      entry.items = { $ref: '#/$defs/cue' };
    } else if (p.type === 'text') entry.type = ['string', 'object'];
    else entry.type = ['string', 'number', 'object'];
    if (p.type === 'text') entry.description += ' 可給字串或 {zh,en}。';
    if (extra && p.required) entry.description = `（必填）${entry.description}`;
    properties[name] = entry;
  }
  return properties;
}

function buildCueDefs() {
  const defs = {};
  for (const cmd of Object.keys(CUE_COMMANDS)) {
    const spec = CUE_COMMANDS[cmd];
    defs[`cue_${cmd}`] = {
      title: `cue: ${cmd}`,
      description: CMD_DESC[cmd] || '',
      type: 'object',
      required: ['cmd', ...Object.keys(spec.params).filter((n) => spec.params[n].required)],
      properties: {
        cmd: { const: cmd, description: `指令名稱（固定 "${cmd}"）。` },
        async: {
          type: 'boolean',
          description: 'true = 不阻塞後續指令（parallel 外的另一種並行寫法）。',
          default: false,
        },
        ...cueParamsSchema(cmd, spec.params),
      },
      additionalProperties: true,
      examples: [[cueExample(cmd)]],
      'x-blocking': spec.blocking,
      'x-category': spec.category,
    };
  }
  return defs;
}

function cueExample(cmd) {
  switch (cmd) {
    case 'say':
      return { cmd: 'say', speaker: 'Susie', text: '* 喂，你這顆亮晶晶的石頭。', speed: 1 };
    case 'bubble':
      return { cmd: 'bubble', actor: 'rudinn', text: '嘿嘿，\n準備好接招了嗎？', side: 'right', wait: 2.0 };
    case 'move':
      return { cmd: 'move', actor: 'rudinn', x: 520, y: 190, duration: 0.6, ease: 'quadOut' };
    case 'anim':
      return { cmd: 'anim', actor: 'rudinn', anim: 'hurt', waitEnd: true };
    case 'flip':
      return { cmd: 'flip', actor: 'susie', value: true };
    case 'fade':
      return { cmd: 'fade', actor: 'rudinn', alpha: 0, duration: 0.8 };
    case 'wait':
      return { cmd: 'wait', seconds: 0.5 };
    case 'sfx':
      return { cmd: 'sfx', sound: 'snd_hurt1' };
    case 'bgm':
      return { cmd: 'bgm', track: 'battle', fade: 0.35 };
    case 'shake':
      return { cmd: 'shake', amount: 4, duration: 0.3 };
    case 'flash':
      return { cmd: 'flash', color: '#ffffff', duration: 0.2 };
    case 'set':
      return { cmd: 'set', var: 'praised', value: 'var.praised + 1', op: 'add' };
    case 'mercy':
      return { cmd: 'mercy', enemy: 'rudinn', amount: 40 };
    case 'heal':
      return { cmd: 'heal', target: 'party', amount: 40 };
    case 'item':
      return { cmd: 'item', id: 'tonic', delta: 1 };
    case 'damage':
      return { cmd: 'damage', target: 'kris', amount: 10 };
    case 'if':
      return {
        cmd: 'if',
        cond: 'mercy.rudinn >= 100',
        then: [{ cmd: 'anim', actor: 'rudinn', anim: 'spared' }],
        else: [{ cmd: 'say', text: '* 牠還沒準備好原諒你。' }],
      };
    case 'parallel':
      return {
        cmd: 'parallel',
        cues: [
          { cmd: 'shake', amount: 3, duration: 0.4 },
          { cmd: 'sfx', sound: 'snd_noise' },
        ],
      };
    case 'attack':
      return { cmd: 'attack', attack: 'spade-rain' };
    case 'end':
      return { cmd: 'end', result: 'victory' };
    default:
      return { cmd };
  }
}

function buildEncounterSchema() {
  const cueDefs = buildCueDefs();
  const cueList = {
    type: 'array',
    description: '指令清單，依序執行（async:true 的指令不阻塞）。',
    items: { $ref: '#/$defs/cue' },
  };

  const animSchema = {
    title: '動畫',
    type: 'object',
    description: '一個動畫狀態：換哪張 sprite、每秒幾幀、是否循環。',
    properties: {
      sprite: { type: 'string', description: 'sprite 名（assets/index.json 的 key）。' },
      fps: numberDef('每秒幀數。', { minimum: 0, default: 10 }),
      loop: { type: 'boolean', description: '是否循環播放。', default: true },
      then: { type: ['string', 'null'], description: '非循環動畫播完後接哪個狀態（null = 停在最後一格）。' },
      frames: { type: 'integer', minimum: 0, description: '總幀數（有素材時可省略）。' },
      duration: numberDef('秒數（frames 未提供時的長度）。', { minimum: 0 }),
    },
    additionalProperties: true,
  };

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://deltaruneworks.local/schema/encounter.json',
    title: 'DR Battle Editor — 遭遇檔',
    description: T.encounterMeta,
    'x-format': ENCOUNTER_FORMAT,
    'x-schema-version': SCHEMA_VERSION,
    'x-engine-fps': 30,
    type: 'object',
    required: [],
    properties: {
      format: { const: ENCOUNTER_FORMAT, description: '格式代號（固定值）。' },
      meta: {
        title: '中繼資料',
        type: 'object',
        properties: {
          name: { ...TEXT_VALUE, description: '遭遇名稱（可給 {zh,en}）。' },
          author: { type: 'string', description: '作者。' },
        },
        additionalProperties: true,
      },
      settings: {
        title: '設定',
        type: 'object',
        properties: {
          seed: numberDef('亂數種子（決定性）。', { default: 1 }),
          bgm: { type: ['string', 'null'], description: '背景音樂名（kind=music）。' },
          background: { type: ['string', 'null'], description: '背景 sprite 名。' },
          introText: { ...TEXT_VALUE, description: '開場文字（顯示在文字框）。' },
          canFlee: { type: 'boolean', description: '是否允許逃跑。', default: false },
        },
        additionalProperties: true,
      },
      actors: {
        title: '演員',
        type: 'object',
        description: '畫面上的角色（隊伍與敵人共用）。key 是演員 id，指令用 actor 參照。',
        additionalProperties: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '演員 id（預設 = key）。' },
            kind: { enum: ['party', 'enemy'], description: '隊伍或敵人。' },
            x: numberDef('x 座標。', { default: 120 }),
            y: numberDef('y 座標。', { default: 200 }),
            flip: { type: 'boolean', description: '是否水平翻轉。', default: false },
            alpha: numberDef('不透明度 0..1。', { minimum: 0, maximum: 1, default: 1 }),
            scale: numberDef('縮放。', { default: 1 }),
            layer: numberDef('繪製層級（大 = 上層）。', { default: 0 }),
            visible: { type: 'boolean', description: '是否顯示。', default: true },
            initialAnim: { type: 'string', description: '初始動畫狀態。', default: 'idle' },
            anims: {
              type: 'object',
              description: `動畫狀態表。隊伍內建狀態：${PARTY_ANIM_STATES.join(' / ')}；敵人：${ENEMY_ANIM_STATES.join(' / ')}。`,
              additionalProperties: animSchema,
            },
            form: {
              type: ['string', 'null'],
              description:
                '初始形態名（SPEC-P2 §1）；省略或 null = 不使用 forms。有 forms 時必須是 forms 的鍵，否則正規化為 null、validateEncounter() 回報未知形態。',
              default: null,
            },
            forms: {
              type: 'object',
              description:
                '形態表（SPEC-P2 §1，選用）：key 是形態名，可用 cue form 切換（也可用 if + set 決定）。形態內沒定義的動畫退回演員基礎 anims。',
              additionalProperties: {
                type: 'object',
                properties: {
                  scale: numberDef('此形態的縮放（會乘上演員本身 scale）。', { minimum: 0.01, default: 1 }),
                  offset: {
                    type: 'object',
                    description: '此形態的繪製位移（只影響繪製位置，世界內部座標不變）。',
                    properties: {
                      x: numberDef('x 位移。', { default: 0 }),
                      y: numberDef('y 位移。', { default: 0 }),
                    },
                    additionalProperties: false,
                  },
                  anims: {
                    type: 'object',
                    description: '此形態的動畫覆寫表（格式同 actor.anims）；未定義的狀態退回 actor.anims。',
                    additionalProperties: animSchema,
                  },
                },
                additionalProperties: true,
              },
            },
          },
          additionalProperties: true,
        },
      },
      party: {
        title: '隊伍',
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '隊員 id（指令與表達式用 hp.<id> 參照）。' },
            actor: { type: ['string', 'null'], description: '對應的演員 id。' },
            name: { ...TEXT_VALUE, description: '顯示名稱。' },
            hp: { type: 'integer', minimum: 0, description: '目前 HP。' },
            maxHp: { type: 'integer', minimum: 1, description: '最大 HP。' },
            atk: numberDef('攻擊力。', { default: 10 }),
            def: numberDef('防禦力（受傷減免）。', { default: 0 }),
            magic: numberDef('魔法值。', { default: 0 }),
            color: { ...colorDef(), description: '名字 / HP 條顏色。' },
            icon: { type: ['string', 'null'], minLength: 1, default: null, description: '戰鬥頭像 sprite 名；null 使用預設頭像。' },
            commands: {
              type: 'array',
              description: `可用指令（子集）：${PARTY_COMMANDS.join(' / ')}。`,
              items: { enum: PARTY_COMMANDS },
            },
            spells: {
              type: 'array',
              description: '法術（消耗 TP）。',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: '法術 id。' },
                  name: { ...TEXT_VALUE, description: '法術名。' },
                  tp: numberDef('消耗 TP。', { minimum: 0, default: 0 }),
                  target: { enum: ['enemy', 'party', 'all'], description: '目標類型。', default: 'enemy' },
                  cues: { ...cueList, description: '施放時執行的指令。' },
                },
                additionalProperties: true,
              },
            },
          },
          additionalProperties: true,
        },
      },
      enemies: {
        title: '敵人',
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '敵人 id（hp.<id> / mercy.<id> 參照）。' },
            actor: { type: ['string', 'null'], description: '對應的演員 id。' },
            name: { ...TEXT_VALUE, description: '敵人顯示名稱。' },
            hp: { type: 'integer', minimum: 0, description: '目前 HP。' },
            maxHp: { type: 'integer', minimum: 1, description: '最大 HP。' },
            atk: numberDef('攻擊力（決定彈幕傷害）。', { default: 5 }),
            def: numberDef('防禦力。', { default: 0 }),
            mercy: numberDef('目前饒恕值 0..100。', { minimum: 0, maximum: 100, default: 0 }),
            spareAt: numberDef('可饒恕門檻。', { minimum: 0, maximum: 100, default: 100 }),
            tired: { type: 'boolean', description: '是否已疲勞（可饒恕提示）。', default: false },
            acts: {
              type: 'array',
              description: 'ACT 選項（玩家在 ACT 選單可選）。',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'ACT id（actCount.<enemyId>_<actId> 會累計）。' },
                  name: { ...TEXT_VALUE, description: '選單顯示名稱。' },
                  text: { ...TEXT_VALUE, description: '選單下方的調查文字。' },
                  party: {
                    type: 'array',
                    description: '哪些隊員可以用（空 = 全員）。',
                    items: { type: 'string' },
                  },
                  mercy: numberDef('使用後增加的饒恕值。', { minimum: 0, maximum: 100, default: 0 }),
                  autoAnim: { type: 'boolean', default: true, description: '自動播放隊員的 ACT 動作。關閉時由 cues 安排動作。' },
                  cues: { ...cueList, description: '使用時執行的演出。' },
                },
                additionalProperties: true,
                examples: [
                  {
                    id: 'compliment',
                    name: 'Compliment',
                    party: ['kris'],
                    mercy: 40,
                    cues: [{ cmd: 'say', text: '* 你稱讚了魯丁的光澤。' }],
                  },
                ],
              },
            },
            onHurt: { ...cueList, description: '敵人受傷時執行。' },
            onSpare: { ...cueList, description: '敵人被饒恕時執行。' },
            onDefeat: { ...cueList, description: '敵人被擊倒時執行。' },
          },
          additionalProperties: true,
        },
      },
      items: {
        title: '道具',
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '道具 id。' },
            name: { ...TEXT_VALUE, description: '道具名。' },
            count: { type: 'integer', minimum: 0, description: '數量。', default: 1 },
            heal: numberDef('回復量。', { default: 0 }),
            revive: { type: 'boolean', default: false, description: '可選擇 HP 為 0 的隊員。' },
            target: { enum: ['party', 'enemy', 'all'], description: '目標。', default: 'party' },
            text: { ...TEXT_VALUE, description: '使用時的訊息。' },
          },
          additionalProperties: true,
        },
      },
      turns: {
        title: '回合',
        type: 'array',
        description: '依 turnOrder 依序進行的回合；每回合可先演戲再放彈幕。',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '回合 id。' },
            flavor: { ...TEXT_VALUE, description: '回合開始的文字（文字框）。' },
            talk: {
              type: 'array',
              description: '敵人對話泡泡。',
              items: {
                type: 'object',
                properties: {
                  actor: { type: 'string', description: '說話的演員 id。' },
                  text: { ...TEXT_VALUE, description: '台詞。' },
                  parallel: { type: 'boolean', description: '是否與下一句同時。', default: false },
                  speed: numberDef('打字速度。', { default: 1 }),
                },
                additionalProperties: true,
              },
            },
            attack: {
              description: '這回合的彈幕：攻擊檔名（attacks/ 或 samples/，不含 .json），或直接內嵌攻擊物件。',
              oneOf: [
                { type: 'string', examples: ['spade-rain'] },
                { type: 'object', description: '內嵌攻擊（格式同 attack.json）。' },
                { type: 'null' },
              ],
            },
            start: { ...cueList, description: '回合開始（選單前）的演出。' },
            beforeAttack: { ...cueList, description: '玩家行動與敵人台詞之後、彈幕開始前的演出。' },
            end: { ...cueList, description: '回合結束的演出。' },
          },
          additionalProperties: true,
        },
      },
      turnOrder: {
        enum: TURN_ORDERS,
        description: '回合順序：sequential = 依序循環；loop-last = 最後一回合重複；random = 隨機。',
        default: 'loop-last',
      },
      hooks: {
        title: '時機掛鉤',
        type: 'object',
        description: `各階段的演出指令：${HOOK_NAMES.join(' / ')}。`,
        properties: Object.fromEntries(HOOK_NAMES.map((name) => [name, { ...cueList, description: `${name} 時執行。` }])),
        additionalProperties: true,
      },
      vars: {
        title: '自訂變數',
        type: 'object',
        description: '初始變數值（數字）。之後用 set 指令改、用 var.<name> 讀。',
        additionalProperties: { type: 'number' },
        examples: [{ praised: 0 }],
      },
      demo: encounterDemoSchema(),
    },
    additionalProperties: true,
    $defs: {
      textValue: textValueDef(),
      anim: animSchema,
      cueList,
      cue: {
        title: '演出指令',
        description: '以 cmd 區分的聯集；見 cues.json 的完整參數表。',
        oneOf: Object.keys(CUE_COMMANDS).map((cmd) => ({ $ref: `#/$defs/cue_${cmd}` })),
      },
      ...cueDefs,
    },
    'x-cueCommands': Object.keys(CUE_COMMANDS),
    'x-resultTypes': RESULT_TYPES,
    'x-turnOrders': TURN_ORDERS,
    'x-phases': PHASES,
    'x-hookNames': HOOK_NAMES,
    'x-langs': LANGS,
    'x-partyCommands': PARTY_COMMANDS,
    'x-partyAnimStates': PARTY_ANIM_STATES,
    'x-enemyAnimStates': ENEMY_ANIM_STATES,
  };
}

/* ==================================================================== */
/* cues.json                                                             */
/* ==================================================================== */

function buildCuesSchema() {
  const commands = {};
  for (const cmd of Object.keys(CUE_COMMANDS)) {
    const spec = CUE_COMMANDS[cmd];
    const params = {};
    for (const name of Object.keys(spec.params)) {
      const p = spec.params[name] || {};
      const key = `cue.${name}`;
      let desc = p.desc || '';
      if (PARAM_EXTRA_DESC[`${cmd}.${name}`]) desc = PARAM_EXTRA_DESC[`${cmd}.${name}`];
      if (p.required) desc += '（必填）';
      if (p.default !== undefined) desc += ` 預設：${JSON.stringify(p.default)}。`;
      if (Array.isArray(p.values)) desc += ` 可選：${p.values.join(' / ')}。`;
      if (p.type === 'text') desc += ' 可給字串或 {zh,en}。';
      params[name] = {
        type: p.type || 'any',
        required: Boolean(p.required),
        default: p.default === undefined ? null : p.default,
        values: Array.isArray(p.values) ? p.values : null,
        nullable: Boolean(p.nullable),
        desc: desc.trim(),
        'x-source-key': key,
      };
    }
    commands[cmd] = {
      cmd,
      desc: CMD_DESC[cmd] || '',
      category: spec.category,
      blocking: Boolean(spec.blocking),
      params,
      example: cueExample(cmd),
    };
  }

  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'https://deltaruneworks.local/schema/cues.json',
    title: 'DR Battle Editor — 演出指令字典',
    description:
      '遭遇戰的演出指令（cue）完整參考：參數、預設值、是否阻塞、分類、範例，加上文字值格式與表達式可用名稱。' +
      '這是「給 Agent 讀的說明書」，cues 的 JSON Schema 在 encounter.json 的 $defs 內。',
    'x-schema-version': SCHEMA_VERSION,
    'x-encounter-format': ENCOUNTER_FORMAT,
    format: 'dr-battle-cues/1',
    categories: CUE_CATEGORIES,
    commands,
    commandNames: Object.keys(CUE_COMMANDS),
    blockingDefaults: Object.fromEntries(
      Object.keys(CUE_COMMANDS).map((cmd) => [cmd, Boolean(CUE_COMMANDS[cmd].blocking)]),
    ),
    textValue: {
      description: TEXT_VALUE_DESC,
      examples: ['* 魯丁擋住了去路！', { zh: '* 魯丁擋住了去路！', en: '* Rudinn blocks the way!' }],
      note: 'zh 是簡體中文（遊戲畫面預設語言）；en 是英文。未知語言鍵會被忽略。',
    },
    expressions: {
      note: '所有數值欄位都可用表達式字串；求值在詞法白名單沙箱內（無副作用、不能執行任意程式）。',
      variables: VAR_NAMES.map((name) => ({ name, desc: VAR_DESC[name] || '' })),
      helpers: HELPER_NAMES.map((name) => ({ name, desc: HELPER_DESC[name] || '' })),
      lookups: LOOKUP_NAMES.map((name) => ({ name, desc: LOOKUP_DESC[name] || '' })),
      operators: ['+', '-', '*', '/', '%', '(', ')', '?', ':'],
      forbidden: SANDBOX_NAMES,
      examples: [
        'rand(box.left + 8, box.right - 8)',
        'aim(soul.x, soul.y)',
        '90 + rand(-12, 12)',
        'i / n * 360',
        'box.x + sin(t * 6) * 40',
        'sin(age * 4) * 30',
        'mercy.rudinn >= 100',
        'var.praised >= 1',
        'hp.kris < maxHp.kris * 0.5',
      ],
    },
    recipes: [
      {
        title: '走位進場 + 開場台詞',
        cues: [
          { cmd: 'move', actor: 'rudinn', x: -80, y: 190, duration: 0 },
          { cmd: 'move', actor: 'rudinn', x: 520, y: 190, duration: 0.8, ease: 'quadOut' },
          { cmd: 'say', text: '* 魯丁擋住了去路！', speed: 2 },
          { cmd: 'bubble', actor: 'rudinn', text: '嘿嘿，\n準備好接招了嗎？', side: 'right', wait: 2.0 },
        ],
      },
      {
        title: 'ACT 分支（依變數）',
        cues: [
          {
            cmd: 'if',
            cond: 'var.praised >= 1',
            then: [
              { cmd: 'mercy', enemy: 'rudinn', amount: 10 },
              { cmd: 'say', text: '* 魯丁開心地轉了一圈！' },
            ],
            else: [{ cmd: 'say', text: '* 魯丁有點困惑。' }],
          },
        ],
      },
      {
        title: '饒恕路線（打滿 mercy 後 end）',
        cues: [
          { cmd: 'if', cond: 'mercy.rudinn >= 100', then: [{ cmd: 'end', result: 'spared' }] },
        ],
      },
      {
        title: '回合演出：震動 + 插入彈幕',
        cues: [
          { cmd: 'shake', amount: 4, duration: 0.3 },
          { cmd: 'sfx', sound: 'snd_noise' },
          { cmd: 'attack', attack: 'spade-rain' },
        ],
      },
    ],
    docs: {
      schemaAttack: 'generated/schema/attack.json',
      schemaEncounter: 'generated/schema/encounter.json',
      api: '/api/schema/attack | /api/schema/encounter | /api/schema/cues',
      guide: 'docs/AGENT-GUIDE.md',
    },
  };
}

/* ==================================================================== */
/* 主流程                                                                */
/* ==================================================================== */

export function buildAllSchemas() {
  return {
    attack: buildAttackSchema(),
    encounter: buildEncounterSchema(),
    cues: buildCuesSchema(),
  };
}

function main() {
  // --root / --works（或 DR_ROOT / DR_WORKS）：schema 輸出位置跟著程式根/作品根走。
  try {
    applyCliPaths(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 2;
    return;
  }
  const args = parseArgs(process.argv.slice(2), ['out', 'root', 'works']);
  const outDir = typeof args.out === 'string' && args.out ? args.out : SCHEMA_DIR;
  const schemas = buildAllSchemas();

  if (args.check) {
    let stale = 0;
    for (const name of Object.keys(schemas)) {
      const file = join(outDir, `${name}.json`);
      const current = readJSON(file);
      const same = JSON.stringify(current) === JSON.stringify(schemas[name]);
      console.log(`${same ? 'OK  ' : '過期'} ${name}.json  ${file}`);
      if (!same) stale += 1;
    }
    if (stale > 0) {
      console.error(`\n${stale} 個 schema 不是最新，請執行：node tools/agent/export-schema.mjs`);
      process.exitCode = 1;
      return;
    }
    console.log('\n全部 schema 都是最新。');
    return;
  }

  let written = 0;
  for (const name of Object.keys(schemas)) {
    const file = join(outDir, `${name}.json`);
    const changed = writeJSON(file, schemas[name]);
    if (changed) written += 1;
    console.log(`${changed ? '寫入' : '未變'} ${file}`);
  }
  const attack = schemas.attack;
  const encounter = schemas.encounter;
  console.log(
    `\n攻擊事件型別 ${attack['x-eventTypes'].length} 種、子彈欄位 ${SPAWN_FIELDS.length} 個、` +
      `遭遇指令 ${encounter['x-cueCommands'].length} 個、表達式變數 ${VAR_NAMES.length} / 函式 ${HELPER_NAMES.length} 個。`,
  );
  console.log(written > 0 ? `共寫入 ${written} 個檔案。` : '內容皆未變（冪等）。');
}

if (cliEntry(import.meta.url)) {
  main();
}

export default buildAllSchemas;
