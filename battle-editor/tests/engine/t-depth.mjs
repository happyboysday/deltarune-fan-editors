/**
 * tests/engine/t-depth.mjs — 偽 3D 欄位：pathScale / pathAlpha / pathZ / solidWhen
 */
import { group, test, eq, ok, approx, deepEq } from './harness.mjs';
import { createSimulation } from '../../engine/sim.js';
import { validateAttack } from '../../engine/attack.js';

function attack(timeline, extra = {}) {
  return {
    format: 'dr-battle-attack/1',
    settings: { duration: 5, seed: 1, damage: 10 },
    box: { x: 320, y: 171, w: 150, h: 150 },
    soul: { speed: 4, slowSpeed: 2, mode: 'red' },
    party: [{ name: 'Kris', hp: 90, maxHp: 90 }],
    bulletTypes: {
      dot: { sprite: null, hitbox: { shape: 'circle', r: 5 } },
      bar: { sprite: null, hitbox: { shape: 'rect', w: 10, h: 4 }, scale: 2 },
    },
    timeline,
    ...extra,
  };
}

function sim(doc, hits) {
  const s = createSimulation({ mode: 'preview', onEvent: (e) => hits && e.type === 'hit' && hits.push(e.payload) });
  s.load(doc);
  return s;
}

group('偽 3D：每幀縮放、透明度、深度與判定開關');

test('pathScale 乘在生成縮放（含型別縮放）上，判定框跟著縮放', () => {
  const s = sim(attack([{ id: 'a', at: 0, type: 'spawn', bullet: 'bar', x: 100, y: 100, scale: 1.5, pathScale: '1 + age' }]));
  s.advance(31, null);
  const b = s.getState().bullets[0];
  approx(b.scale, 2 * 1.5 * (1 + 1), 0.15, '型別 2 × 生成 1.5 × (1+age≈1)');
  approx(b.hitbox.w, 10 * 2, 0.5, '矩形寬跟著 pathScale 放大（不含生成縮放：判定以型別尺寸為準）');
  approx(b.hitbox.h, 4 * 2, 0.2);
});

test('pathAlpha 每幀覆蓋透明度並夾在 0–1', () => {
  const s = sim(attack([{ id: 'a', at: 0, type: 'spawn', bullet: 'dot', x: 100, y: 100, pathAlpha: 'age * 3' }]));
  s.advance(6, null);
  ok(s.getState().bullets[0].alpha < 1, '開頭半透明');
  s.advance(30, null);
  eq(s.getState().bullets[0].alpha, 1, '超過 1 夾成 1');
});

test('solidWhen 為 0 時不傷人，條件成立後才命中', () => {
  const hits = [];
  const s = sim(attack([{ id: 'a', at: 0, type: 'spawn', bullet: 'dot', x: 320, y: 171, solidWhen: 'age > 1' }]), hits);
  s.advance(20, null);
  eq(hits.length, 0, '第 1 秒前疊在靈魂上也不會受傷');
  eq(s.getState().bullets[0].solid, false, '狀態標出不判定');
  s.advance(20, null);
  eq(hits.length, 1, '之後命中一次');
});

test('pathZ：getState 的子彈由遠到近排序', () => {
  const s = sim(attack([
    { id: 'near', at: 0, type: 'spawn', bullet: 'dot', x: 100, y: 100, pathZ: '-5' },
    { id: 'far', at: 0, type: 'spawn', bullet: 'dot', x: 200, y: 100, pathZ: '8' },
    { id: 'flat', at: 0, type: 'spawn', bullet: 'dot', x: 300, y: 100 },
  ]));
  s.advance(3, null);
  deepEq(s.getState().bullets.map((b) => b.x), [200, 300, 100], 'z=8 先、z=0 次、z=-5 最後');
});

test('快照還原保留偽 3D 狀態，之後與不中斷的模擬一致', () => {
  const doc = attack([{ id: 'a', at: 0, type: 'spawn', bullet: 'bar', x: 100, y: 100, speed: 1,
    pathScale: '0.5 + sin(age*90)', pathZ: 'cos(age*90)*10', solidWhen: 'age > 0.5' }]);
  const a = sim(doc), b = sim(doc);
  a.advance(12, null);
  ok(b.restore(JSON.parse(JSON.stringify(a.snapshot()))));
  a.advance(20, null); b.advance(20, null);
  deepEq(b.getState().bullets, a.getState().bullets);
});

test('pathFrame：每幀求值的動畫幀取代 frameRate', () => {
  const s = sim(attack([{ id: 'a', at: 0, type: 'spawn', bullet: 'dot', x: 100, y: 100, pathFrame: 'age*10 + 0.5' }]));
  s.advance(16, null);
  eq(s.getState().bullets[0].frame, Math.floor(16 / 30 * 10 + 0.5), '依 age 換幀');
  const t = sim(attack([{ id: 'a', at: 0, type: 'spawn', bullet: 'dot', x: 100, y: 100, pathFrame: '3' }]));
  t.advance(5, null);
  ok(t.restore(JSON.parse(JSON.stringify(t.snapshot()))));
  eq(t.getState().bullets[0].frame, 3, '固定幀，快照還原後保留');
});

test('pathRotation：每幀求值的朝向，矩形判定跟著轉', () => {
  const s = sim(attack([{ id: 'a', at: 0, type: 'spawn', bullet: 'bar', x: 100, y: 100, pathRotation: '90*age' }]));
  s.advance(31, null);
  approx(s.getState().bullets[0].rotation, 90, 4, '約 1 秒後轉到 90°');
  const t = sim(attack([{ id: 'a', at: 0, type: 'spawn', bullet: 'bar', x: 100, y: 100, pathRotation: '45' }]));
  t.advance(3, null);
  ok(t.restore(JSON.parse(JSON.stringify(t.snapshot()))));
  t.advance(3, null);
  eq(t.getState().bullets[0].rotation, 45);
});

test('validateAttack 接受新欄位的運算式並回報語法錯誤', () => {
  const ok1 = validateAttack(attack([{ id: 'a', at: 0, type: 'spawn', bullet: 'dot', x: 1, y: 1, pathScale: 'age*2', solidWhen: 'age>1' }]));
  eq(ok1.filter((e) => /path|solid/.test(e.path)).length, 0);
  const bad = validateAttack(attack([{ id: 'a', at: 0, type: 'spawn', bullet: 'dot', x: 1, y: 1, pathZ: 'age*(' }]));
  ok(bad.some((e) => /pathZ/.test(e.path)), '括號沒關會被指出');
});

group('靈魂機制：冰面滑行（slide）');

test('slide：放開方向鍵後繼續滑行並逐漸停下；快照還原一致', () => {
  const doc = {
    format: 'dr-battle-attack/1', settings: { duration: 4, seed: 3 }, arena: { kind: 'stage' },
    soul: { profile: 'ice', x: 100, y: 100 },
    soulProfiles: { ice: { movement: { id: 'slide', version: 1, params: { acceleration: 0.5, maxSpeed: 5, friction: 0.1 } } } },
  };
  const a = createSimulation({ mode: 'play' }); a.load(doc);
  for (let i = 0; i < 20; i++) a.stepFrame({ dx: 1, dy: 0 });
  const x20 = a.soul.x;
  ok(x20 > 100 + 40, '加速後跑得比普通移動的前幾幀遠');
  a.stepFrame(null);
  const x21 = a.soul.x;
  ok(x21 > x20, '放開後仍往前滑');
  const b = createSimulation({ mode: 'play' }); b.load(doc);
  ok(b.restore(JSON.parse(JSON.stringify(a.snapshot()))));
  for (let i = 0; i < 60; i++) { a.stepFrame(null); b.stepFrame(null); }
  eq(b.soul.x, a.soul.x, '還原後同步');
  const xEnd = a.soul.x; a.stepFrame(null);
  approx(a.soul.x, xEnd, 0.01, '最後停下');
});

group('靈魂機制：重力跳躍（gravity）與平台（platform / bounce）');

const gdoc = (timeline = [], params = {}, types = {}) => ({
  format: 'dr-battle-attack/1', settings: { duration: 6, seed: 4 },
  box: { x: 320, y: 171, w: 200, h: 150 },
  soul: { profile: 'blue', x: 320, y: 140 },
  soulProfiles: { blue: { movement: { id: 'gravity', version: 1, params: { speed: 4, gravity: 0.5, jump: 7, maxFall: 8, ...params } } } },
  bulletTypes: {
    plat: { sprite: null, hitbox: { shape: 'rect', w: 60, h: 8 }, decor: true, platform: true },
    spring: { sprite: null, hitbox: { shape: 'rect', w: 60, h: 8 }, decor: true, platform: true, bounce: 1.5 },
    ...types,
  },
  timeline,
});
const run = (doc, frames, input = null) => {
  const s = createSimulation({ mode: 'play' }); s.load(doc);
  for (let i = 0; i < frames; i++) s.stepFrame(typeof input === 'function' ? input(i) : input);
  return s;
};

test('gravity：落到框底停住；按「上」起跳、放開後落回同一高度', () => {
  const s = run(gdoc(), 60);
  const floorY = s.soul.y;
  s.stepFrame(null);
  eq(s.soul.y, floorY, '落地後不再下沉');
  for (let i = 0; i < 6; i++) s.stepFrame({ dx: 0, dy: -1 });
  ok(s.soul.y < floorY - 20, '起跳離地');
  for (let i = 0; i < 60; i++) s.stepFrame(null);
  eq(s.soul.y, floorY, '落回框底');
});

test('platform：從上方落下會站在平台上，並被移動的平台帶著走', () => {
  const doc = gdoc([{ id: 'p', at: 0, type: 'spawn', bullet: 'plat', x: 320, y: 200, pathX: '20*age' }]);
  const s = run(doc, 40);
  approx(s.soul.y, 200 - 4 - 4, 1.5, '腳踩在平台上緣（上緣 196 − 靈魂半徑 4）');
  const x0 = s.soul.x;
  for (let i = 0; i < 30; i++) s.stepFrame(null);
  ok(s.soul.x > x0 + 15, '平台往右移，靈魂跟著走');
});

test('platform 只擋從上方落下：從下方往上跳會穿過去', () => {
  const doc = gdoc([{ id: 'p', at: 0, type: 'spawn', bullet: 'plat', x: 320, y: 215 }], { jump: 9 });
  const s = run(doc, 3);
  for (let i = 0; i < 40; i++) s.stepFrame(null);               // 站在平台上（上緣 211）
  ok(Math.abs(s.soul.y - 207) < 2, '先站上平台（' + s.soul.y + '）');
  const doc2 = gdoc([{ id: 'p', at: 0, type: 'spawn', bullet: 'plat', x: 320, y: 190 }], { jump: 9 });
  const s2 = createSimulation({ mode: 'play' }); s2.load({ ...doc2, soul: { ...doc2.soul, y: 230 } });
  for (let i = 0; i < 40; i++) s2.stepFrame(null);
  const floor = s2.soul.y;
  for (let i = 0; i < 12; i++) s2.stepFrame({ dx: 0, dy: -1 });
  ok(s2.soul.y < 186, '跳穿平台到上方（' + s2.soul.y + '）');
  for (let i = 0; i < 40; i++) s2.stepFrame(null);
  ok(s2.soul.y < floor - 30, '落回時站在平台上，而不是掉回地板');
});

test('bounce：彈簧床把靈魂彈得比普通跳躍更高', () => {
  const doc = gdoc([{ id: 'p', at: 0, type: 'spawn', bullet: 'spring', x: 320, y: 220 }]);
  const s = createSimulation({ mode: 'play' }); s.load(doc);
  let minY = Infinity, bounced = 0;
  const s2 = createSimulation({ mode: 'play', onEvent: (e) => { if (e.type === 'soulBounce') bounced += 1; } }); s2.load(doc);
  for (let i = 0; i < 90; i++) { s2.stepFrame(null); minY = Math.min(minY, s2.soul.y); }
  ok(bounced >= 1, '發出 soulBounce 事件');
  ok(minY < 140, '彈起超過起始高度（' + minY.toFixed(1) + '）');
});

test('direction=1：重力向上，靈魂落向框頂', () => {
  const s = run(gdoc([], { direction: 1 }), 60);
  ok(s.soul.y < 120, '貼在框頂附近（' + s.soul.y + '）');
});

test('gravity 快照還原：站在移動平台上的狀態一致', () => {
  const doc = gdoc([{ id: 'p', at: 0, type: 'spawn', bullet: 'plat', x: 320, y: 200, pathX: '30*sin(age*90)' }]);
  const a = run(doc, 45, (i) => ({ dx: i % 20 < 10 ? 1 : 0, dy: 0 }));
  const b = createSimulation({ mode: 'play' }); b.load(doc);
  ok(b.restore(JSON.parse(JSON.stringify(a.snapshot()))));
  for (let i = 0; i < 40; i++) { const inp = { dx: 0, dy: i === 5 ? -1 : 0 }; a.stepFrame(inp); b.stepFrame(inp); }
  eq(b.soul.x, a.soul.x); eq(b.soul.y, a.soul.y);
});

group('運算式：trailX / trailY（靈魂幾秒前的位置）');

test('trailX(1) 追著靈魂 1 秒前的位置；快照還原後一致', () => {
  const doc = attack([{ id: 'a', at: 0, type: 'spawn', bullet: 'ghost', x: 320, y: 171,
    pathX: 'trailX(1) - spawnX', pathY: 'trailY(1) - spawnY' }], { soul: { x: 320, y: 171, speed: 4, slowSpeed: 2, mode: 'red' } });
  doc.bulletTypes.ghost = { sprite: null, hitbox: { shape: 'circle', r: 3 }, decor: true, offscreen: 'keep' };
  const s = createSimulation({ mode: 'play' }); s.load(doc);
  for (let i = 0; i < 30; i++) s.stepFrame({ dx: 1, dy: 0 });
  const xNow = s.soul.x;
  for (let i = 0; i < 30; i++) s.stepFrame(null);
  const b = s.getState().bullets[0];
  approx(b.x, xNow, 4.5, '停下 1 秒後，子彈到達 1 秒前靈魂的位置');
  const t = createSimulation({ mode: 'play' }); t.load(doc);
  ok(t.restore(JSON.parse(JSON.stringify(s.snapshot()))));
  for (let i = 0; i < 20; i++) { s.stepFrame({ dx: 0, dy: 1 }); t.stepFrame({ dx: 0, dy: 1 }); }
  deepEq(t.getState().bullets, s.getState().bullets, '還原後軌跡相同');
});
