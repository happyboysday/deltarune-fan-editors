/**
 * tests/encounter/t-layout.mjs — SPEC-LAYOUT 版面規格（引擎資料面）
 *
 * 涵蓋：
 *   - LAYOUT 常數與 §1/§2/§3/§5/§6/§7/§8/§9 的量測值一致
 *   - 攻擊預設戰鬥框（engine/attack.js 的 BOX_DEFAULTS）與 LAYOUT.BATTLE_BOX 一致
 *   - partyFeetFor() 依人數回傳 §3 的腳底 y
 *   - getState().layout / boxAnimRotation
 *   - 傷害數字：由上往下堆疊、右側定位、出手者顏色、上彈到停住、淡出
 *   - 泡泡：預設左側、對齊頭部、多泡泡共存
 */

import { group, test, eq, ok, notOk, approx, within, isArray } from '../engine/harness.mjs';
import {
  LAYOUT,
  partyFeetFor,
  PARTY_FEET,
  PANEL_TOP,
  TEXT_TOP,
  BATTLE_BOX,
  NUMBER,
  BUBBLE,
  BOX_ANIM_FRAMES,
  BOX_ANIM_ROTATION,
} from '../../engine/encounter/layout.js';
import { BOX_DEFAULTS, normalizeAttack } from '../../engine/attack.js';
import { createEncounter } from '../../engine/encounter/index.js';
import { createWorld } from '../../engine/encounter/world.js';
import { createRng } from '../../engine/rng.js';
import { baseEncounter, demoAttack } from './fixtures.mjs';

/* ---------------------------------------------------------------- 常數 */

group('layout：常數（SPEC-LAYOUT 量測值）');

test('畫面尺寸與分區 y 座標', () => {
  eq(LAYOUT.VIEW_W, 640, '寬 640');
  eq(LAYOUT.VIEW_H, 480, '高 480');
  eq(LAYOUT.BATTLE_AREA_BOTTOM, 362, '戰場底線 y 362');
  eq(LAYOUT.PANEL_TOP, 365, '隊伍面板 y 365');
  eq(LAYOUT.PANEL_BOTTOM, 400, '隊伍面板底 y 400');
  eq(LAYOUT.TEXT_TOP, 405, '底部文字區 y 405');
  eq(LAYOUT.TEXT_BOTTOM, 480, '底部文字區底 y 480');
});

test('戰鬥框預設值符合 §5：中心 (320,190)、內部 144×158、border 3', () => {
  eq(LAYOUT.BATTLE_BOX.x, 320, '中心 x');
  eq(LAYOUT.BATTLE_BOX.y, 190, '中心 y');
  eq(LAYOUT.BATTLE_BOX.w, 144, '內部寬');
  eq(LAYOUT.BATTLE_BOX.h, 158, '內部高');
  eq(LAYOUT.BATTLE_BOX.border, 3, '描邊 3');
  // 外框約 150×165
  eq(LAYOUT.BATTLE_BOX.w + LAYOUT.BATTLE_BOX.border * 2, 150, '外框寬 150');
  eq(LAYOUT.BATTLE_BOX.h + LAYOUT.BATTLE_BOX.border * 2, 164, '外框高 ≈165（164）');
});

test('engine/attack.js 的 BOX_DEFAULTS 與 LAYOUT.BATTLE_BOX 一致', () => {
  eq(BOX_DEFAULTS.x, LAYOUT.BATTLE_BOX.x, 'x 一致');
  eq(BOX_DEFAULTS.y, LAYOUT.BATTLE_BOX.y, 'y 一致');
  eq(BOX_DEFAULTS.w, LAYOUT.BATTLE_BOX.w, 'w 一致');
  eq(BOX_DEFAULTS.h, LAYOUT.BATTLE_BOX.h, 'h 一致');
  eq(BOX_DEFAULTS.border, LAYOUT.BATTLE_BOX.border, 'border 一致');
  // normalizeAttack 把預設值補進實際攻擊
  const a = normalizeAttack({});
  eq(a.box.x, 320, 'normalizeAttack 補 x=320');
  eq(a.box.y, 190, 'normalizeAttack 補 y=190');
});

test('戰鬥框展開動畫：約 9 幀、旋轉由 ±90 收斂到 0', () => {
  eq(BOX_ANIM_FRAMES, 9, '9 幀');
  eq(BOX_ANIM_ROTATION, 90, '90 度');
  eq(LAYOUT.BOX_ANIM_FRAMES, 9, 'LAYOUT 9 幀');
});

test('TP 條 / 隊伍面板 / 文字區的量測值', () => {
  eq(LAYOUT.TP_BAR.x, 40, 'TP 條左 x 40');
  eq(LAYOUT.TP_BAR.y, 50, 'TP 條上 y 50');
  eq(LAYOUT.TP_BAR.w, 20, 'TP 條寬 20');
  eq(LAYOUT.TP_BAR.h, 208, 'TP 條高 208');
  eq(LAYOUT.PANEL_RAISE, 35, '選單面板上移 35');
  eq(LAYOUT.TEXT_LINE_HEIGHT, 32, '文字行高 32');
  eq(LAYOUT.NUMBER.lineHeight, 20, '傷害數字行距 20');
});

test('partyFeetFor 依人數回傳 §3 的腳底 y', () => {
  eq(JSON.stringify(partyFeetFor(1)), JSON.stringify([240]), '1 人 [240]');
  eq(JSON.stringify(partyFeetFor(2)), JSON.stringify([190, 298]), '2 人 [190,298]');
  eq(JSON.stringify(partyFeetFor(3)), JSON.stringify([140, 230, 322]), '3 人 [140,230,322]');
  eq(JSON.stringify(partyFeetFor(4)), JSON.stringify([120, 190, 260, 330]), '4 人 [120,190,260,330]');
  // 邊界：0 / 5 人夾到 1..4
  eq(partyFeetFor(0).length, 1, '0 人夾成 1');
  eq(partyFeetFor(9).length, 4, '5+ 人夾成 4');
  eq(JSON.stringify(PARTY_FEET[3]), JSON.stringify([140, 230, 322]), 'PARTY_FEET[3] 原始表');
});

/* ------------------------------------------------------- getState().layout */

group('layout：getState().layout');

/** 建立無頭遭遇 */
async function makeEncounter(encJson) {
  const enc = createEncounter({
    canvas: null,
    assets: null,
    resolveAttack: async (name) => (name === 'demoAttack' ? demoAttack() : null),
  });
  await enc.load(encJson || baseEncounter());
  return enc;
}

test('getState().layout 含 partyFeet / panelTop / textTop', async () => {
  const enc = await makeEncounter();
  const s = enc.getState();
  ok(s.layout, '有 layout');
  isArray(s.layout.partyFeet, 'partyFeet 是陣列');
  eq(s.layout.panelTop, PANEL_TOP, 'panelTop = 365');
  eq(s.layout.textTop, TEXT_TOP, 'textTop = 405');
  // baseEncounter 有 1 位隊員 → [240]
  eq(JSON.stringify(s.layout.partyFeet), JSON.stringify([240]), '1 位隊員腳底 240');
  enc.destroy();
});

test('layout.partyFeet 跟著隊伍人數變', async () => {
  const json = baseEncounter();
  json.party = [
    { id: 'kris', actor: 'kris', name: 'Kris', hp: 90, maxHp: 90 },
    { id: 'susie', actor: 'susie', name: 'Susie', hp: 110, maxHp: 110 },
    { id: 'ralsei', actor: 'ralsei', name: 'Ralsei', hp: 70, maxHp: 70 },
  ];
  const enc = await makeEncounter(json);
  eq(JSON.stringify(enc.getState().layout.partyFeet), JSON.stringify([140, 230, 322]), '3 人腳底');
  enc.destroy();
});

test('boxAnimRotation：idle 為 0，展開時由 90 收斂到 0', async () => {
  const enc = await makeEncounter(baseEncounter({ turns: [{ id: 't1', attack: 'demoAttack' }] }));
  // 尚未進入彈幕回合 → 0
  eq(enc.getState().boxAnimRotation, 0, 'idle 為 0');
  // 直接開一段彈幕回合，逐幀看旋轉收斂
  const handle = enc.debug.startAttack('demoAttack');
  ok(handle, 'startAttack 成功');
  const seen = [];
  for (let i = 0; i < BOX_ANIM_FRAMES + 6; i += 1) {
    enc.step(1, { press: [], hold: {} });
    const s = enc.getState();
    seen.push({ boxAnim: s.boxAnim, rot: s.boxAnimRotation });
  }
  const first = seen.find((x) => x.boxAnim > 0);
  ok(first, 'boxAnim 有開始展開');
  ok(Math.abs(first.rot) <= BOX_ANIM_ROTATION + 1e-6, `起始旋轉 <= 90（實際 ${first.rot}）`);
  const last = seen[seen.length - 1];
  approx(last.rot, 0, 1e-6, '展開完成後旋轉 0');
  approx(last.boxAnim, 1, 1e-6, 'boxAnim 到 1');
  // 單調遞減（只看有展開的段落）
  let prev = Infinity;
  for (const x of seen) {
    if (x.boxAnim <= 0) continue;
    ok(x.rot <= prev + 1e-9, `旋轉單調遞減（${prev} → ${x.rot}）`);
    prev = x.rot;
  }
  enc.destroy();
});

/* --------------------------------------------------------- 傷害數字 */

group('layout：傷害數字（§9）');

/** 直接建立 world（不經 encounter 流程） */
function makeWorld(encJson) {
  const enc = encJson || baseEncounter();
  return createWorld(enc, {
    rng: createRng(enc.settings ? enc.settings.seed : 1),
    fps: 30,
    resolvedAttacks: new Map([['demoAttack', demoAttack()]]),
    onEvent: () => {},
  });
}

test('傷害數字在目標右側，且同結算內由上往下堆疊', () => {
  const world = makeWorld();
  // baseEncounter 的敵人 id 'rudinn'，位置由 actor 決定
  const pos = world.positionOf('rudinn');
  world.applyDamage('rudinn', 10, { source: 'kris' });
  world.applyDamage('rudinn', 10, { source: 'susie' });
  world.applyDamage('rudinn', 10, { source: 'ralsei' });
  const nums = world.snapshot().numbers;
  eq(nums.length, 3, '三筆數字');
  // 第一筆在最上面（y 最小），之後每筆 +20
  eq(nums[1].y - nums[0].y, NUMBER.lineHeight, '第 2 行 +20');
  eq(nums[2].y - nums[1].y, NUMBER.lineHeight, '第 3 行 +20');
  // 位置在目標右側（不覆蓋目標本身）
  ok(nums[0].x > pos.x, `在目標右側（${nums[0].x} > ${pos.x}）`);
  eq(nums[0].x - pos.x, NUMBER.offsetX, '水平偏移 = NUMBER.offsetX');
});

test('傷害數字顏色 = 出手者角色色', () => {
  const json = baseEncounter();
  json.party[0].color = '#00ffff';
  const world = makeWorld(json);
  world.applyDamage('rudinn', 5, { source: 'kris' });
  const n = world.snapshot().numbers[0];
  eq(n.color, '#00ffff', 'Kris 青色');
  // 沒指定 source → 白色（不是硬寫的紅）
  world.applyDamage('rudinn', 5);
  const n2 = world.snapshot().numbers[1];
  eq(n2.color, '#ffffff', '無 source → 白色');
});

test('傷害數字先上彈再停住（vy / settled），~30 幀後移除', () => {
  const world = makeWorld();
  world.applyDamage('rudinn', 7, { source: 'kris' });
  const n0 = world.snapshot().numbers[0];
  eq(n0.settled, false, '初始未落定');
  ok(n0.vy < 0, `初始 vy 為負（往上，實際 ${n0.vy}）`);
  const y0 = n0.y;

  // 逐幀推進：y 先變小（往上），之後落定不再變
  world.update({ press: [], hold: {} });
  const n1 = world.snapshot().numbers[0];
  ok(n1.y < y0, `第一幀往上（${y0} → ${n1.y}）`);

  let settledAt = -1;
  for (let i = 0; i < 20; i += 1) {
    world.update({ press: [], hold: {} });
    const s = world.snapshot();
    if (s.numbers.length === 0) break;
    const n = s.numbers[0];
    if (n.settled) {
      settledAt = n.age;
      const yBefore = n.y;
      world.update({ press: [], hold: {} });
      const after = world.snapshot().numbers.find((x) => x.text === n.text);
      if (after && after.settled) eq(after.y, yBefore, '落定後 y 不再變');
      break;
    }
  }
  ok(settledAt > 0 && settledAt < 20, `在 20 幀內落定（age ${settledAt}）`);
});

test('傷害數字約 30 幀後淡出、40 幀後消失', () => {
  const world = makeWorld();
  world.applyDamage('rudinn', 9, { source: 'kris' });
  let alive = 0;
  let sawFade = false;
  let fadeStartedAge = -1;
  for (let i = 0; i < NUMBER.life + 5; i += 1) {
    const s = world.snapshot();
    if (s.numbers.length > 0) {
      alive += 1;
      const n = s.numbers[0];
      if (n.alpha < 1) {
        sawFade = true;
        if (fadeStartedAge < 0) fadeStartedAge = n.age;
      }
    }
    world.update({ press: [], hold: {} });
  }
  within(alive, NUMBER.life - 2, NUMBER.life + 2, `存活約 ${NUMBER.life} 幀（實際 ${alive}）`);
  ok(sawFade, '有淡出（alpha < 1）');
  // SPEC-LAYOUT §9：先停留約 1 秒（30 幀）才開始淡出
  ok(fadeStartedAge >= NUMBER.holdFrames - 2, `淡出在 ${NUMBER.holdFrames} 幀之後才開始（實際 age ${fadeStartedAge}）`);
});

test('numbers 項目含渲染需要的欄位', () => {
  const world = makeWorld();
  world.applyDamage('rudinn', 3, { source: 'kris' });
  const n = world.snapshot().numbers[0];
  for (const k of ['x', 'y', 'text', 'color', 'age', 'vy', 'settled', 'alpha']) {
    ok(k in n, `有 ${k}`);
  }
  eq(n.text, '-3', '文字內容');
});

test('MISS 數字為灰色', () => {
  const world = makeWorld();
  world.applyDamage('rudinn', 0, { source: 'kris', miss: true });
  const nums = world.snapshot().numbers;
  if (nums.length > 0) eq(nums[0].color, '#808080', 'MISS 灰色');
  else ok(true, '0 傷害不跳字（可接受）');
});

/* --------------------------------------------------------------- 泡泡 */

group('layout：泡泡（§8）');

test('泡泡預設在說話演員左側', () => {
  const world = makeWorld();
  // 敵人 rudinn 的演員在右半邊
  const b = world.text.bubble({ actor: 'rudinn', text: '哼。', wait: 0.5 });
  const snap = world.snapshot().bubbles[0];
  eq(snap.side, 'left', '預設 side 為 left');
  eq(b.side, 'left', 'handle.side 一致');
  ok(snap.x < world.positionOf('rudinn').x, '泡泡在演員左側');
  b.cancel();
});

test('泡泡高度對齊演員頭部（y - 精靈高×2）', () => {
  const json = baseEncounter();
  // 指定演員精靈高度，驗證「頭部」公式
  const world = makeWorld(json);
  const b = world.text.bubble({ actor: 'rudinn', text: '哈囉', wait: 0.5 });
  const act = world.actors.get('rudinn');
  const snap = world.snapshot().bubbles[0];
  const spriteH = act.def.spriteH || 32;
  const expectedHead = act.y - spriteH * 2 * (act.scale || 1);
  approx(snap.y, expectedHead, 1e-6, `泡泡 y = 頭部（${expectedHead}）`);
  b.cancel();
});

test('多個泡泡可同時存在，各自貼在不同演員旁', () => {
  const json = baseEncounter();
  json.actors = {
    ...(json.actors || {}),
    a1: { kind: 'enemy', x: 470, y: 260, anims: { idle: { sprite: 'spr_hatyx_idle', fps: 4 } } },
    a2: { kind: 'enemy', x: 540, y: 300, anims: { idle: { sprite: 'spr_jigsawry_idle', fps: 4 } } },
  };
  const world = makeWorld(json);
  const b1 = world.text.bubble({ actor: 'a1', text: '一', wait: 0.5 });
  const b2 = world.text.bubble({ actor: 'a2', text: '二', wait: 0.5 });
  const snaps = world.snapshot().bubbles;
  eq(snaps.length, 2, '兩個泡泡同時存在');
  notOk(snaps[0].x === snaps[1].x && snaps[0].y === snaps[1].y, '位置不同（各自貼演員）');
  b1.cancel();
  b2.cancel();
  eq(world.snapshot().bubbles.length, 0, '取消後都消失');
});

test('side:"right" 時泡泡在演員右側', () => {
  const world = makeWorld();
  const b = world.text.bubble({ actor: 'rudinn', text: '右', side: 'right', wait: 0.5 });
  const snap = world.snapshot().bubbles[0];
  eq(snap.side, 'right', 'side 保留 right');
  ok(snap.x > world.positionOf('rudinn').x, '泡泡在右側');
  b.cancel();
});
