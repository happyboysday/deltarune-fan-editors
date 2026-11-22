import { group, test, eq, ok, deepEq, approx } from './harness.mjs';
import { validateAttack } from '../../engine/attack.js';
import { createSimulation } from '../../engine/sim.js';
import { compilePolygon } from '../../engine/arena.js';
import { traceDemo } from '../../engine/autoplay/trace.js';

const points = (items) => items.map(([x, y]) => ({ x, y }));
const elbow = points([[80, 50], [540, 50], [540, 150], [310, 150], [310, 310], [80, 310]]);
const window = points([[110, 120], [260, 120], [260, 280], [110, 280]]);
const box = { x: 320, y: 180, w: 120, h: 120, appearance: 'hidden' };
const make = (fields) => ({
  format: 'dr-battle-attack/1',
  settings: { duration: 3, damage: 10 },
  box,
  ...fields,
});
function load(doc) {
  const sim = createSimulation({ mode: 'play' });
  sim.load(make(doc));
  return sim;
}
const tick = (sim, frames, input) => {
  for (let i = 0; i < frames; i++) sim.stepFrame(input);
};

group('Arena: movement and clipping are independent of box appearance');

test('a hidden legacy box still clamps, but a stage arena reaches the HUD boundary', () => {
  const regular = load({});
  const stage = load({ arena: { kind: 'stage' } });
  tick(regular, 72, { dx: 1, dy: 1 });
  tick(stage, 85, { dx: 1, dy: 1 });
  deepEq([regular.soul.x, regular.soul.y], [376, 236]);
  approx(stage.soul.x, 320 + 85 * 4 / Math.SQRT2, 0.001);
  eq(stage.soul.y, 358);
  eq(stage.getState().box.appearance, 'hidden');
});

test('concave edges stop diagonal movement and allow sliding along the wall', () => {
  const sim = load({ arena: { kind: 'polygon', points: elbow }, soul: { x: 470, y: 140, speed: 4 } });
  tick(sim, 18, { dx: -1, dy: 1 });
  ok(sim.soul.x < 435, 'the heart should slide left');
  approx(sim.soul.y, 146, 0.001);
  tick(sim, 36, { dx: -1, dy: 0 });
  tick(sim, 17, { dx: 0, dy: 1 });
  ok(sim.soul.y > 200, 'after the corner the lower part is reachable');
});

test('a single fast step cannot cross an excluded bay between legal endpoints', () => {
  const u = points([[70, 60], [550, 60], [550, 310], [420, 310], [420, 135], [200, 135], [200, 310], [70, 310]]);
  const sim = load({ arena: { kind: 'polygon', points: u }, soul: { x: 145, y: 240, speed: 340 } });
  sim.stepFrame({ dx: 1, dy: 0 });
  approx(sim.soul.x, 196, 0.002);
  eq(sim.soul.y, 240);
});

test('invalid geometry is reported and falls back without corrupting the attack', () => {
  const crossed = points([[50, 50], [150, 150], [50, 150], [150, 50]]);
  eq(compilePolygon(crossed), null);
  eq(compilePolygon(points([[30, 30], [40, 30], [50, 30], [50, 30.1], [30, 30.1]]), 4), null);
  const attack = make({ arena: { kind: 'polygon', points: crossed }, clipRegion: { points: crossed } });
  const errors = validateAttack(attack).map((e) => e.path);
  ok(errors.includes('arena.points') && errors.includes('clipRegion.points'));
  const sim = load(attack);
  eq(sim.getState().arena, undefined);
  tick(sim, 72, { dx: 1, dy: 0 });
  eq(sim.soul.x, 376);
});

test('the custom window can clip hazards without limiting player motion', () => {
  const collision = (clipTo, bulletX, soulX) => {
    const sim = load({
      arena: { kind: 'stage' },
      clipRegion: { points: window },
      soul: { x: soulX, y: 180 },
      bulletTypes: { test: { clipTo, hitbox: { shape: 'circle', r: 24 }, grazeable: false } },
      timeline: [{ id: 'hit', at: 0, type: 'spawn', bullet: 'test', x: bulletX, y: 180 }],
    });
    const hp = sim.getState().party[0].hp;
    sim.stepFrame({});
    return hp - sim.getState().party[0].hp;
  };
  eq(collision('custom', 267, 250), 0, 'a projectile with its center outside the window does no damage');
  eq(collision('custom', 250, 266), 0, 'a heart outside the window takes no damage');
  eq(collision('custom', 220, 220), 10);
  eq(collision('arena', 267, 267), 10);
  eq(collision('box', 220, 220), 0);
  eq(collision('none', 267, 267), 10);
});

test('JSON snapshot restore keeps the polygon and active clip selection deterministic', () => {
  const doc = {
    arena: { kind: 'polygon', points: elbow },
    clipRegion: { points: window },
    soul: { x: 155, y: 210 },
    bulletTypes: { test: { clipTo: 'custom', decor: true } },
    timeline: [{ id: 'clip', at: 0, type: 'spawn', bullet: 'test', x: 120, y: 140, speed: 2, angle: 0 }],
  };
  const a = load(doc);
  tick(a, 8, { dx: 1, dy: 1 });
  const b = load(doc);
  ok(b.restore(JSON.parse(JSON.stringify(a.snapshot()))));
  tick(a, 15, { dx: 1, dy: 1 });
  tick(b, 15, { dx: 1, dy: 1 });
  deepEq(a.getState(), b.getState());
  eq(b.getState().bullets[0].clipTo, 'custom');
});

test('autoplay trace follows a target beyond the old battle box in stage mode', () => {
  const trace = traceDemo(make({
    arena: { kind: 'stage' },
    soul: { x: 130, y: 180 },
    demo: { mode: 'path', path: [{ t: 0, x: 130, y: 180 }, { t: 2, x: 310, y: 180 }] },
  }));
  ok(trace.frames[0].actual.x < 200);
  ok(trace.frames.at(-1).actual.x > 290);
});

test('moving clip region (clipRegion.motion) reveals a static bullet field only where it sweeps', () => {
  // 一條 40px 寬的直立光帶，從 x=100 每秒往右 120px 掃過；靈魂停在 x=220，一排靜止子彈鋪滿整列
  const doc = {
    arena: { kind: 'stage' },
    soul: { x: 220, y: 200 },
    clipRegion: { points: points([[80, 40], [120, 40], [120, 340], [80, 340]]), motion: { x: '120*t' } },
    bulletTypes: { field: { clipTo: 'custom', hitbox: { shape: 'circle', r: 6 }, destroyOnHit: false } },
    timeline: [{ id: 'row', at: 0, type: 'spawn', bullet: 'field', count: 11, x: '120 + i*20', y: 200, speed: 0 }],
  };
  const sim = load(doc);
  const hits = [];
  const s2 = createSimulation({ mode: 'play', onEvent: (e) => { if (e.type === 'hit') hits.push(e.payload.frame); } });
  s2.load(make({ ...doc, settings: { duration: 3, damage: 10, invincibleFrames: 0 } }));
  tick(sim, 15, { dx: 0, dy: 0 });
  // t=0.5：光帶在 x 140–180，還沒到靈魂（220）
  const st = sim.getState();
  ok(st.clipRegion.points[0].x > 139 && st.clipRegion.points[0].x < 141, 'region moved by motion.x');
  tick(s2, 90, { dx: 0, dy: 0 });
  ok(hits.length > 0, 'the soul is hit once the band sweeps over it');
  // 光帶 [80+120t, 120+120t] 蓋到 x=220 的時段是 t≈0.83–1.17 秒（第 25–35 幀）
  ok(hits.every((f) => f >= 24 && f <= 36), `hits only while the band covers x=220 (frames ${hits.join(',')})`);
});

test('moving clip region rotates about its pivot and survives snapshot restore', () => {
  const doc = {
    clipRegion: { points: points([[300, 100], [340, 100], [340, 260], [300, 260]]),
      motion: { rotation: 't*90', pivot: { x: 320, y: 180 } } },
    bulletTypes: { field: { clipTo: 'custom', decor: true } },
    timeline: [],
  };
  const a = load(doc);
  tick(a, 30, { dx: 0, dy: 0 });   // t=1 → 轉 90°：直立的長條變成水平
  const pts = a.getState().clipRegion.points;
  const ys = pts.map((p) => p.y);
  ok(Math.max(...ys) - Math.min(...ys) < 41, 'band is horizontal after 90°');
  const b = load(doc);
  ok(b.restore(JSON.parse(JSON.stringify(a.snapshot()))));
  deepEq(b.getState().clipRegion.points, pts);
  eq(validateAttack(make({ ...doc, clipRegion: { ...doc.clipRegion, motion: { x: 'nope(' } } }))
    .some((e) => e.path === 'clipRegion.motion.x'), true);
});
