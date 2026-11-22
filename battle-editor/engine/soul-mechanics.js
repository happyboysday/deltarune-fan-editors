const DEG = Math.PI / 180;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const number = (label, value, min, max, step = 1) => ({ label, default: value, min, max, step });
const empty = () => ({});
export const soulMechanisms = { movement: new Map(), ability: new Map() };

export function registerSoulMechanism(kind, definition) {
  const table = soulMechanisms[kind];
  const key = mechanismKey(definition);
  if (table.has(key)) throw new Error('Duplicate soul mechanism: ' + key);
  table.set(key, definition);
}

export function mechanismKey({ id, version }) {
  return id + '@' + version;
}

registerSoulMechanism('movement', {
  id: 'free', version: 1, label: ['普通移动', '普通移動', 'Free movement'],
  fields: {
    speed: number(['速度', '速度', 'Speed'], 4, 0, 32, 0.1),
    slowSpeed: number(['低速', '低速', 'Slow speed'], 2, 0, 32, 0.1),
  },
  init: empty,
  step(state, input, { params, heading }) {
    const speed = input.slow ? params.slowSpeed : params.speed;
    const { dx, dy } = input;
    const scale = dx && dy ? Math.SQRT1_2 : 1;
    return {
      state, dx: dx * scale * speed, dy: dy * scale * speed,
      heading: dx || dy ? Math.atan2(dy, dx) / DEG : heading,
    };
  },
});

registerSoulMechanism('movement', {
  id: 'inertia', version: 1, label: ['惯性赛车', '慣性賽車', 'Inertial car'],
  fields: {
    acceleration: number(['加速度', '加速度', 'Acceleration'], 0.65, 0.05, 8, 0.05),
    brake: number(['制动力', '制動力', 'Brake'], 1.2, 0.05, 16, 0.05),
    drag: number(['松油门减速', '鬆油門減速', 'Coasting drag'], 0.15, 0, 4, 0.05),
    maxSpeed: number(['最高速度', '最高速度', 'Top speed'], 9, 0.1, 32, 0.1),
    turn: number(['转向速度', '轉向速度', 'Turn rate'], 7, 0, 45, 0.5),
  },
  init: () => ({ vx: 0, vy: 0 }),
  step(state, input, { params, heading }) {
    heading += input.dx * params.turn;
    const speed = Math.hypot(state.vx, state.vy);
    const coast = Math.max(0, speed - (input.dy > 0 || input.slow ? params.brake : params.drag));
    const scale = speed ? coast / speed : 0;
    const throttle = input.dy < 0 && !input.slow ? params.acceleration : 0;
    let vx = state.vx * scale + Math.cos(heading * DEG) * throttle;
    let vy = state.vy * scale + Math.sin(heading * DEG) * throttle;
    const cap = Math.hypot(vx, vy);
    if (cap > params.maxSpeed) {
      vx *= params.maxSpeed / cap;
      vy *= params.maxSpeed / cap;
    }
    return { state: { vx, vy }, dx: vx, dy: vy, heading };
  },
  onResolved(state, { contacts, overridden }) {
    if (overridden) return { vx: 0, vy: 0 };
    let { vx, vy } = state;
    for (const n of contacts) {
      const toward = Math.min(0, vx * n.x + vy * n.y);
      vx -= toward * n.x;
      vy -= toward * n.y;
    }
    return { vx, vy };
  },
});

registerSoulMechanism('movement', {
  id: 'slide', version: 1, label: ['冰面滑行', '冰面滑行', 'Ice slide'],
  fields: {
    acceleration: number(['加速度', '加速度', 'Acceleration'], 0.45, 0.05, 8, 0.05),
    maxSpeed: number(['最高速度', '最高速度', 'Top speed'], 5, 0.1, 32, 0.1),
    friction: number(['摩擦（每幀減速比例）', '摩擦（每幀減速比例）', 'Friction (per frame)'], 0.06, 0, 1, 0.01),
  },
  init: () => ({ vx: 0, vy: 0 }),
  // 方向鍵直接推動（不是賽車的油門＋轉向）；放開的軸依摩擦慢慢停下；低速鍵＝最高速減半
  step(state, input, { params, heading }) {
    const { dx, dy } = input;
    const k = dx && dy ? Math.SQRT1_2 : 1;
    let vx = state.vx + dx * k * params.acceleration;
    let vy = state.vy + dy * k * params.acceleration;
    if (!dx) vx *= 1 - params.friction;
    if (!dy) vy *= 1 - params.friction;
    const cap = input.slow ? params.maxSpeed / 2 : params.maxSpeed;
    const sp = Math.hypot(vx, vy);
    if (sp > cap) { vx *= cap / sp; vy *= cap / sp; }
    if (Math.abs(vx) < 0.01) vx = 0;
    if (Math.abs(vy) < 0.01) vy = 0;
    return { state: { vx, vy }, dx: vx, dy: vy, heading: vx || vy ? Math.atan2(vy, vx) / DEG : heading };
  },
});

/** 重力方向：0 下、1 上、2 左、3 右（重力向量） */
export const GRAVITY_DIRS = [[0, 1], [0, -1], [-1, 0], [1, 0]];

registerSoulMechanism('movement', {
  id: 'gravity', version: 1, label: ['重力跳跃', '重力跳躍', 'Gravity jump'],
  fields: {
    speed: number(['横向速度', '橫向速度', 'Run speed'], 4, 0, 32, 0.1),
    gravity: number(['重力', '重力', 'Gravity'], 0.5, 0.05, 4, 0.05),
    jump: number(['起跳速度', '起跳速度', 'Jump speed'], 7, 0, 32, 0.1),
    maxFall: number(['最大下落速度', '最大下落速度', 'Max fall speed'], 8, 0.5, 32, 0.5),
    airJumps: number(['空中跳跃次数', '空中跳躍次數', 'Air jumps'], 0, 0, 3, 1),
    direction: number(['重力方向（0下 1上 2左 3右）', '重力方向（0下 1上 2左 3右）', 'Gravity (0 down 1 up 2 left 3 right)'], 0, 0, 3, 1),
  },
  init: () => ({ v: 0, grounded: false, up: false, jumps: 0, on: null, ox: 0, oy: 0 }),
  // 「往重力反方向」按鍵＝跳（像藍色靈魂）；放開時還在上升就減半（按越久跳越高）。
  // 落地、撞頂與平台由 sim 依實際位移結算（settleGravity），這裡只算意圖位移。
  step(state, input, { params, heading }) {
    const [gx, gy] = GRAVITY_DIRS[clamp(Math.round(params.direction), 0, 3)];
    const lateral = gx === 0 ? input.dx : input.dy;
    const upHeld = gx * input.dx + gy * input.dy < 0;
    let { v, grounded, jumps } = state;
    if (upHeld && !state.up) {
      if (grounded) { v = -params.jump; grounded = false; jumps = params.airJumps; } else if (jumps > 0) { v = -params.jump; jumps -= 1; }
    }
    if (!upHeld && state.up && v < 0) v *= 0.5;
    v = Math.min(params.maxFall, v + params.gravity);
    const run = lateral * (input.slow ? params.speed / 2 : params.speed);
    const dx = gx * v + (gx === 0 ? run : 0);
    const dy = gy * v + (gx === 0 ? 0 : run);
    return { state: { ...state, v, grounded: false, up: upHeld, jumps }, dx, dy, heading: run ? (run > 0 ? 0 : 180) : heading };
  },
});

registerSoulMechanism('ability', {
  id: 'dash', version: 1, label: ['冲刺', '衝刺', 'Dash'],
  actions: [{ id: 'dash', code: 'KeyV', label: 'V' }], overridesMovement: true,
  fields: {
    speed: number(['冲刺速度', '衝刺速度', 'Dash speed'], 11, 1, 40, 0.5),
    durationFrames: number(['冲刺帧数', '衝刺影格數', 'Dash frames'], 6, 1, 30),
    cooldownFrames: number(['冷却帧数', '冷卻影格數', 'Cooldown frames'], 21, 1, 300),
  },
  init: () => ({ remaining: 0, cooldown: 0, heading: 0 }),
  beforeMove(state, input, { params, heading }) {
    let { remaining, cooldown } = state;
    let dir = state.heading;
    cooldown = Math.max(0, cooldown - 1);
    const triggered = !remaining && !cooldown && input.press.includes('dash');
    if (triggered) {
      remaining = params.durationFrames;
      cooldown = params.cooldownFrames;
      dir = heading;
    }
    if (!remaining) return { state: { remaining, cooldown, heading: dir } };
    return {
      state: { remaining: remaining - 1, cooldown, heading: dir },
      triggered,
      move: { dx: Math.cos(dir * DEG) * params.speed, dy: Math.sin(dir * DEG) * params.speed, heading: dir, stopAtWall: true },
    };
  },
  afterMove(state, input, { contacts }) {
    return { state: contacts.length ? { ...state, remaining: 0 } : state };
  },
});

registerSoulMechanism('ability', {
  id: 'shoot', version: 1, label: ['射击', '射擊', 'Shoot'],
  actions: [{ id: 'shoot', code: 'KeyB', label: 'B' }],
  fields: {
    speed: number(['玩家弹速度', '玩家彈速度', 'Shot speed'], 16, 1, 64, 0.5),
    cooldownFrames: number(['连发间隔', '連發間隔', 'Fire interval'], 8, 1, 120),
    lifeFrames: number(['玩家弹寿命', '玩家彈壽命', 'Shot lifetime'], 32, 1, 120),
  },
  init: () => ({ cooldown: 0 }),
  afterMove(state, input, { params, heading }) {
    const cooldown = Math.max(0, state.cooldown - 1);
    if (cooldown || !(input.hold.shoot || input.press.includes('shoot'))) return { state: { cooldown } };
    return {
      state: { cooldown: params.cooldownFrames },
      shot: { heading, speed: params.speed, life: params.lifeFrames },
    };
  },
});

export function soulActionBindings() {
  return [...new Map([...soulMechanisms.movement.values(), ...soulMechanisms.ability.values()].flatMap((def) =>
    (def.actions ?? []).map((action) => [action.code, action]))).values()];
}

export class SoulConfigurationError extends Error {
  constructor({ path, message }) {
    super(path + ': ' + message);
    this.path = path;
  }
}

export const LEGACY_MOVEMENT = soulMechanisms.movement.get('free@1');

export function movementInput(input) {
  const { hold = {}, press = [] } = input ?? {};
  const { dx, dy, slow } = input ?? {};
  const keyed = dx === undefined && dy === undefined && input?.hold;
  const axis = (v) => Number.isFinite(Number(v)) ? clamp(Math.round(Number(v)), -1, 1) : 0;
  return {
    dx: keyed ? Number(Boolean(hold.right)) - Number(Boolean(hold.left)) : axis(dx),
    dy: keyed ? Number(Boolean(hold.down)) - Number(Boolean(hold.up)) : axis(dy),
    slow: keyed ? Boolean(hold.slow) : Boolean(slow), hold, press,
  };
}

const isRecord = (o) => o && typeof o === 'object' && !Array.isArray(o);
const profileName = /^[a-zA-Z0-9_-]{1,40}$/;
const appearanceFields = {
  color: (v) => typeof v === 'string' && /^#[0-9a-f]{6}$/i.test(v),
  sprite: (v) => v === null || typeof v === 'string' && v.length > 0,
  rotate: (v) => typeof v === 'boolean',
  // 固定旋轉角度（度）；autoOrient：重力移動時心尖自動指向「地板」（向上重力＝180°），切換時約 0.15 秒轉過去
  rotation: (v) => Number.isFinite(v) && Math.abs(v) <= 360,
  autoOrient: (v) => typeof v === 'boolean',
  anchorX: (v) => Number.isFinite(v) && Math.abs(v) <= 128,
  anchorY: (v) => Number.isFinite(v) && Math.abs(v) <= 128,
};
export const SOUL_APPEARANCE = { color: '#ff0000', sprite: null, rotate: false, anchorX: 0, anchorY: 0 };

export function compileSoulProfiles(doc) {
  const profiles = new Map(), errors = [];
  const report = (path, message) => errors.push({ path, message });
  function appearance(input, path) {
    if (!isRecord(input)) {
      report(path, 'Appearance must be an object');
      return {};
    }
    const result = {};
    for (const [key, value] of Object.entries(input)) {
      if (!Object.hasOwn(appearanceFields, key) || !appearanceFields[key](value)) report(path + '.' + key, 'Invalid appearance value');
      else result[key] = value;
    }
    return result;
  }
  function binding(kind, input, path) {
    const def = isRecord(input) && soulMechanisms[kind].get(mechanismKey(input));
    if (!def) {
      report(path, 'Missing ' + kind + ' mechanism: ' + (isRecord(input) ? mechanismKey(input) : '(not configured)'));
      return null;
    }
    const authored = input.params === undefined ? {} : input.params;
    if (!isRecord(authored)) {
      report(path + '.params', 'Parameters must be an object');
      return null;
    }
    const params = {};
    for (const [key, field] of Object.entries(def.fields)) {
      const value = Object.hasOwn(authored, key) ? authored[key] : field.default;
      if (!Number.isFinite(value) || value < field.min || value > field.max || field.step === 1 && !Number.isInteger(value)) {
        report(path + '.params.' + key, 'Expected ' + field.min + '–' + field.max + (field.step === 1 ? ' (integer)' : ''));
      }
      params[key] = value;
    }
    for (const key of Object.keys(authored)) {
      if (!Object.hasOwn(params, key)) report(path + '.params.' + key, 'Unknown parameter');
    }
    return { def, params };
  }
  if (doc.soulProfiles !== undefined && !isRecord(doc.soulProfiles)) report('soulProfiles', 'Profiles must be an object');
  for (const [id, spec] of Object.entries(isRecord(doc.soulProfiles) ? doc.soulProfiles : {})) {
    const path = 'soulProfiles.' + id;
    const start = errors.length;
    if (!profileName.test(id) || Object.hasOwn(Object.prototype, id) || !isRecord(spec)) {
      report(path, 'Invalid profile name or profile object');
      continue;
    }
    const look = spec.appearance === undefined ? {} : appearance(spec.appearance, path + '.appearance');
    const movement = binding('movement', spec.movement, path + '.movement');
    const abilities = [];
    const seen = new Set();
    let overrides = 0;
    if (spec.abilities !== undefined && !Array.isArray(spec.abilities)) report(path + '.abilities', 'Abilities must be an array');
    for (const [i, source] of (Array.isArray(spec.abilities) ? spec.abilities : []).entries()) {
      const ability = binding('ability', source, path + '.abilities.' + i);
      if (!ability) continue;
      if (seen.has(ability.def.id)) report(path + '.abilities.' + i, 'Ability already selected');
      if (ability.def.overridesMovement && ++overrides > 1) report(path + '.abilities.' + i, 'Only one movement override is allowed');
      seen.add(ability.def.id);
      abilities.push(ability);
    }
    if (errors.length === start) profiles.set(id, { appearance: { ...SOUL_APPEARANCE, ...look }, movement, abilities });
  }
  function reference(id, path) {
    if (typeof id !== 'string' || !profiles.has(id)) report(path, 'Unknown or invalid soul profile: ' + String(id));
  }
  if (doc.soul?.profile !== undefined) reference(doc.soul.profile, 'soul.profile');
  const appearances = new Map();
  if (Array.isArray(doc.timeline)) doc.timeline.forEach((ev, i) => {
    if (ev?.type === 'soulProfile') reference(ev.profile, 'timeline[' + i + '].profile');
    if (ev?.type === 'soulAppearance') appearances.set(i, appearance(ev.appearance, 'timeline[' + i + '].appearance'));
    if (ev?.type === 'soulTeleport') {
      if (!Number.isFinite(ev.x)) report('timeline[' + i + '].x', 'Teleport requires an X coordinate');
      if (!Number.isFinite(ev.y)) report('timeline[' + i + '].y', 'Teleport requires a Y coordinate');
    }
  });
  return { profiles, appearances, errors };
}
