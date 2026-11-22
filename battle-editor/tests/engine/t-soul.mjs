import { group, test, ok, eq } from './harness.mjs';
import { createSimulation } from '../../engine/sim.js';
import { validateAttack } from '../../engine/attack.js';
import { registerSoulMechanism } from '../../engine/soul-mechanics.js';

const free = { id: 'free', version: 1 };
const drive = { id: 'inertia', version: 1 };
const ability = (id, params) => ({ id, version: 1, params });
const pulse = { appearance: { color: '#ffcc44' }, movement: free, abilities: [ability('dash', { speed: 34 }), ability('shoot', { speed: 64 })] };
const doc = (extra = {}) => ({
  format: 'dr-battle-attack/1',
  settings: { duration: 3, seed: 22, damage: 4 },
  arena: { kind: 'stage' },
  soul: { profile: 'pulse', x: 100, y: 100 },
  soulProfiles: { pulse, race: { movement: drive }, recolored: { movement: free, abilities: [ability('dash', { speed: 34 })] } },
  ...extra,
});
const spawn = (bullet, x, y = 100, extra = {}) => ({ type: 'spawn', at: 0, bullet, x, y, speed: 0, ...extra });
const session = (attack) => {
  const events = [];
  const sim = createSimulation({ mode: 'play', onEvent: (event) => events.push(event) });
  sim.load(attack);
  return { sim, events };
};

group('靈魂機制：相容、切換、掃掠與快照');
test('外觀切換不傳送；切配置保留仍啟用的能力狀態', () => {
  const { sim } = session(doc({ timeline: [
    { type: 'soulAppearance', at: 2 / 30, appearance: { color: '#44ffaa' } },
    { type: 'soulProfile', at: 3 / 30, profile: 'recolored' },
  ] }));
  sim.stepFrame({ press: ['dash'] });
  eq(sim.soul.x, 134);
  sim.stepFrame(null);
  eq(sim.soul.x, 168);
  eq(sim.soul.color, '#44ffaa');
  sim.stepFrame(null);
  eq(sim.soul.x, 202);
  eq(sim.getState().soul.abilities.length, 1);
  ok(sim.getState().soul.abilities[0].cooldown > 0);
});

test('高速衝刺按實際路徑命中而不是只看終點', () => {
  const { sim, events } = session(doc({ timeline: [spawn('solid', 117)] }));
  sim.stepFrame({ press: ['dash'] });
  eq(sim.soul.x, 134);
  eq(events.filter((e) => e.type === 'hit').length, 1);
});

test('顯式傳送不掃過中間的彈幕', () => {
  const { sim, events } = session(doc({ timeline: [spawn('solid', 117), { type: 'soulTeleport', at: 1 / 30, x: 150, y: 100 }] }));
  sim.stepFrame(null);
  eq(sim.soul.x, 150);
  eq(events.filter((e) => e.type === 'hit').length, 0);
  eq(sim.getState().soul.teleportSerial, 1);
});

test('射擊只命中可破壞的第一個有效目標，不會穿透裁剪牆', () => {
  const { sim, events } = session(doc({
    clipRegion: { points: [{ x: 150, y: 50 }, { x: 200, y: 50 }, { x: 200, y: 150 }, { x: 150, y: 150 }] },
    bulletTypes: {
      solid: { hitbox: { shape: 'circle', r: 3 } },
      glass: { shootable: true, hitbox: { shape: 'rect', w: 9, h: 4 } },
      masked: { shootable: true, clipTo: 'custom' },
    },
    timeline: [spawn('solid', 116), spawn('masked', 132), spawn('glass', 147, 100, { rotation: 30 }), spawn('glass', 160)],
  }));
  sim.stepFrame({ hold: { shoot: true } });
  eq(events.find((e) => e.type === 'bulletBroken').payload.bulletId, 3);
  eq(sim.getState().bullets.map((b) => b.id).join(','), '1,2,4');
});

test('衝刺撞牆會停，長按不重觸發', () => {
  const { sim, events } = session(doc({ soul: { x: 630, y: 100, profile: 'pulse' } }));
  sim.stepFrame({ press: ['dash'], hold: { dash: true } });
  eq(sim.soul.x, 636);
  eq(sim.getState().soul.abilities[0].active, false);
  sim.advance(35, { hold: { dash: true, left: true } });
  eq(events.filter((e) => e.type === 'soulAbility' && e.payload.id === 'dash').length, 1);
});

test('慣性滑行、煞車與異形牆，快照續跑與連續步進一致', () => {
  const attack = doc({
    soul: { x: 100, y: 240, profile: 'race' },
    arena: { kind: 'polygon', points: [{x:60,y:60},{x:310,y:60},{x:310,y:160},{x:225,y:160},{x:225,y:310},{x:60,y:310}] },
  });
  const { sim } = session(attack);
  sim.advance(10, { hold: { up: true } });
  const x0 = sim.soul.x;
  sim.stepFrame(null);
  ok(sim.soul.x > x0);
  const coast = sim.getState().soul.speed;
  sim.stepFrame({ hold: { down: true } });
  ok(sim.getState().soul.speed < coast);
  const snapshot = JSON.parse(JSON.stringify(sim.snapshot()));
  const input = { hold: { up: true } };
  sim.advance(35, input);
  ok(sim.soul.x <= 221.001 && sim.soul.x > 220.9);
  const copy = session(attack).sim;
  ok(copy.restore(snapshot));
  copy.advance(35, input);
  eq(JSON.stringify(copy.getState()), JSON.stringify(sim.getState()));
});

test('衝刺、冷卻與玩家彈從 JSON 快照可續跑', () => {
  const attack = doc({ soul: { x: 100, y: 100, profile: 'pulse' }, timeline: [spawn('solid', 360)] });
  const first = session(attack).sim;
  first.stepFrame({ press: ['dash', 'shoot'] });
  const state = JSON.parse(JSON.stringify(first.snapshot()));
  const second = session(attack).sim;
  ok(second.restore(state));
  first.advance(8, { hold: { shoot: true } });
  second.advance(8, { hold: { shoot: true } });
  eq(JSON.stringify(second.snapshot()), JSON.stringify(first.snapshot()));
});

test('新移動規則從註冊表接入，不改模擬器或場地', () => {
  registerSoulMechanism('movement', {
    id: 'test-rail', version: 1, label: ['轨道','軌道','Rail'], fields: {},
    init: () => ({}), step: (state, input, ctx) => ({
      state, dx: input.dx * 3, dy: 0, heading: ctx.heading,
    }),
  });
  const attack = doc({ soulProfiles: { pulse: { movement: { id: 'test-rail', version: 1 } } } });
  const { sim } = session(attack);
  sim.stepFrame({ dx: 1, dy: 1 });
  eq(sim.soul.x, 103);
  eq(sim.soul.y, 100);
  attack.soulProfiles.pulse.movement.version = 2;
  ok(validateAttack(attack).some(({ message }) => message.includes('test-rail@2')));
  let message;
  try { session(attack); } catch (e) { message = e.message; }
  ok(message.includes('test-rail@2'));
});

group('v3：子彈血量、靈魂漂移、靈魂朝向');
test('hp：要射中幾下才碎；mem.hp 遞減、pathFrame 讀得到；快照保留', () => {
  const { sim, events } = session(doc({
    bulletTypes: { wall: { shootable: true, hp: 3, hitbox: { shape: 'rect', w: 10, h: 30 }, offscreen: 'keep' } },
    timeline: [spawn('wall', 160, 100, { pathFrame: '3 - mem.hp' })],
  }));
  ok(validateAttack(doc({ bulletTypes: { w: { hp: 3, hitbox: { shape: 'circle', r: 3 } } } })).length === 0, '型別 hp 合法');
  ok(validateAttack(doc({ bulletTypes: { w: { hp: 0.5, hitbox: { shape: 'circle', r: 3 } } } })).length > 0, 'hp 必須是整數');
  for (let k = 0; k < 2; k++) {
    sim.stepFrame({ press: ['shoot'], hold: { shoot: true } });
    sim.advance(12, null);
  }
  eq(events.filter((e) => e.type === 'bulletHit').length, 2, '前兩下只扣血');
  eq(sim.snapshot().bullets[0].mem.hp, 1, 'mem.hp 剩 1');
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  const copy = session(doc({
    bulletTypes: { wall: { shootable: true, hp: 3, hitbox: { shape: 'rect', w: 10, h: 30 }, offscreen: 'keep' } },
    timeline: [spawn('wall', 160, 100, { pathFrame: '3 - mem.hp' })],
  }));
  ok(copy.sim.restore(snap));
  for (const s of [sim, copy.sim]) {
    s.stepFrame({ press: ['shoot'], hold: { shoot: true } });
    s.advance(12, null);
  }
  eq(events.filter((e) => e.type === 'bulletBroken').length, 1, '第三下才碎');
  eq(copy.events.filter((e) => e.type === 'bulletBroken').length, 1, '還原後一樣第三下才碎');
});

test('soulDrift：每幀推靈魂（運算式讀 soul／t），被框擋住；dx dy 為 0 停止；快照保留', () => {
  const attack = doc({ timeline: [
    { type: 'soulDrift', at: 0, dx: '1', dy: 't < 0.5 ? 0 : -0.5' },
    { type: 'soulDrift', at: 1, dx: 0, dy: 0 },
  ] });
  ok(validateAttack(attack).length === 0);
  const { sim } = session(attack);
  sim.advance(10, null);
  ok(Math.abs(sim.soul.x - 110) < 1.01, '每幀往右 1');
  const snap = JSON.parse(JSON.stringify(sim.snapshot()));
  sim.advance(20, null);
  const copy = session(attack).sim;
  ok(copy.restore(snap));
  copy.advance(20, null);
  eq(copy.soul.x, sim.soul.x, '還原後漂移一致');
  eq(copy.soul.y, sim.soul.y);
  ok(sim.soul.y < 100, '0.5 秒後往上漂');
  const x1 = sim.soul.x;
  sim.advance(10, null);
  eq(sim.soul.x, x1, '停止事件之後不再漂');
});

test('appearance.autoOrient：重力向上時靈魂圖轉 180°（每幀最多 36°）；rotation 固定角度', () => {
  const grav = (direction) => ({ appearance: { color: '#3060ff', autoOrient: true },
    movement: { id: 'gravity', version: 1, params: { direction } } });
  const attack = doc({ soul: { profile: 'down', x: 100, y: 100 },
    soulProfiles: { down: grav(0), up: grav(1), tilt: { appearance: { rotation: 45 }, movement: free } },
    timeline: [{ type: 'soulProfile', at: 5 / 30, profile: 'up' }, { type: 'soulProfile', at: 20 / 30, profile: 'tilt' }] });
  ok(validateAttack(attack).length === 0);
  const { sim } = session(attack);
  sim.advance(4, null);
  eq(sim.getState().soul.orient ?? 0, 0, '向下重力：不轉');
  sim.advance(3, null);
  const mid = sim.getState().soul.orient;
  ok(Math.abs(mid) > 0 && Math.abs(mid) < 180, '轉到一半');
  sim.advance(6, null);
  eq(Math.abs(sim.getState().soul.orient), 180, '轉完＝180°');
  sim.advance(10, null);
  eq(sim.getState().soul.orient, 45, '固定角度');
});
