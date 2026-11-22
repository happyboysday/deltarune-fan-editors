import { BATTLE_AREA_BOTTOM, VIEW_W } from './encounter/layout.js';

export const ARENA_KINDS = ['box', 'stage', 'polygon'];
export const BOX_APPEARANCES = ['classic', 'outline', 'hidden'];
export const CLIP_TARGETS = ['none', 'box', 'arena', 'custom'];
export const ARENA_SOUL_RADIUS = 4;
export const STAGE_BOX = { x: VIEW_W / 2, y: BATTLE_AREA_BOTTOM / 2, w: VIEW_W, h: BATTLE_AREA_BOTTOM, rotation: 0 };
export const bulletClip = (bullet) => bullet.clipTo ?? (bullet.maskToBox ? 'box' : 'none');
const EPS = 1e-7;
const DEG = Math.PI / 180;
const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
const dot = (ax, ay, bx, by) => ax * bx + ay * by;
const cross = (a, b, p) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);

function onSegment(a, b, p) {
  return Math.abs(cross(a, b, p)) <= EPS
    && dot(p.x - a.x, p.y - a.y, p.x - b.x, p.y - b.y) <= EPS;
}

function intersects(a, b, c, d) {
  const ab1 = cross(a, b, c), ab2 = cross(a, b, d);
  const cd1 = cross(c, d, a), cd2 = cross(c, d, b);
  if (ab1 * ab2 < -EPS && cd1 * cd2 < -EPS) return true;
  return onSegment(a, b, c) || onSegment(a, b, d) || onSegment(c, d, a) || onSegment(c, d, b);
}

function edgeDistance2(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const u = clamp(dot(p.x - a.x, p.y - a.y, dx, dy) / (dx * dx + dy * dy), 0, 1);
  return (p.x - a.x - u * dx) ** 2 + (p.y - a.y - u * dy) ** 2;
}

export function pointInPolygon(p, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j], b = points[i];
    if (onSegment(a, b, p)) return true;
    if ((a.y > p.y) !== (b.y > p.y) && p.x < a.x + (p.y - a.y) * (b.x - a.x) / (b.y - a.y)) inside = !inside;
  }
  return inside;
}

function fits(p, points, radius) {
  if (!pointInPolygon(p, points)) return false;
  const r2 = radius ** 2 - EPS;
  for (let i = 0; i < points.length; i++) {
    if (edgeDistance2(p, points[i], points[(i + 1) % points.length]) < r2) return false;
  }
  return true;
}

function anchorIn(points, bounds, radius) {
  const rows = new Set([bounds.y, ...points.map((p) => p.y)]);
  const sorted = [...rows].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++) rows.add((sorted[i - 1] + sorted[i]) / 2);
  for (let y = Math.ceil(bounds.y - bounds.h / 2) + radius; y <= bounds.y + bounds.h / 2 - radius; y += 2) rows.add(y);
  for (const y of rows) {
    const xs = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i], b = points[(i + 1) % points.length];
      if ((a.y > y) !== (b.y > y)) xs.push(a.x + (y - a.y) * (b.x - a.x) / (b.y - a.y));
    }
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const p = { x: (xs[i] + xs[i + 1]) / 2, y };
      if (fits(p, points, radius)) return p;
    }
  }
  return null;
}

/** Validate authored geometry once; masks don't need room for the heart. */
export function compilePolygon(points, radius = 0) {
  if (!Array.isArray(points) || points.length < 3 || points.length > 64) return null;
  if (points.some((p) => !p || !Number.isFinite(p.x) || !Number.isFinite(p.y)
      || p.x < 0 || p.x > VIEW_W || p.y < 0 || p.y > BATTLE_AREA_BOTTOM)) return null;
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], prev = points[(i + points.length - 1) % points.length];
    if (Math.hypot(b.x - a.x, b.y - a.y) <= EPS || onSegment(prev, a, b) || onSegment(a, b, prev)) return null;
    area += a.x * b.y - a.y * b.x;
    for (let j = i + 2; j < points.length; j++) {
      if (i === 0 && j === points.length - 1) continue;
      if (intersects(a, b, points[j], points[(j + 1) % points.length])) return null;
    }
  }
  if (Math.abs(area) <= EPS) return null;
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const left = Math.min(...xs), right = Math.max(...xs), top = Math.min(...ys), bottom = Math.max(...ys);
  const bounds = { x: (left + right) / 2, y: (top + bottom) / 2, w: right - left, h: bottom - top, rotation: 0 };
  const anchor = radius ? anchorIn(points, bounds, radius) : null;
  return radius && !anchor ? null : { points, bounds, anchor };
}

export function compileArena(spec) {
  const fill = typeof spec?.fill === 'string' && /^#[0-9a-f]{6}$/i.test(spec.fill) ? { fill: spec.fill } : {};
  if (Number.isFinite(spec?.fillAlpha)) fill.fillAlpha = clamp(spec.fillAlpha, 0, 1);
  if (spec?.kind === 'stage') return { kind: 'stage', outline: spec.outline === true, ...fill };
  if (spec?.kind === 'polygon') {
    const shape = compilePolygon(spec.points, ARENA_SOUL_RADIUS);
    if (shape) return { kind: 'polygon', outline: spec.outline === true, ...shape, ...fill };
  }
  return { kind: 'box', outline: spec?.kind === 'box' && spec.outline === true, ...fill };
}

export function movementBox(arena, box) {
  return arena?.kind === 'polygon' ? arena.bounds : arena?.kind === 'stage' ? STAGE_BOX : box;
}

function localPoint(p, box) {
  const rot = (Number(box.rotation) || 0) * DEG;
  const c = Math.cos(rot), s = Math.sin(rot);
  const x = p.x - box.x, y = p.y - box.y;
  return { x: x * c + y * s, y: -x * s + y * c, c, s };
}

export function pointInRect(p, box, margin = 0) {
  const local = localPoint(p, box);
  return Math.abs(local.x) <= box.w / 2 + margin && Math.abs(local.y) <= box.h / 2 + margin;
}

export function placeInArena(arena, box, point, radius = ARENA_SOUL_RADIUS) {
  if (arena?.kind === 'polygon') {
    if (fits(point, arena.points, radius)) return point;
    const { anchor, points } = arena;
    return travel(anchor, point.x - anchor.x, point.y - anchor.y, points, radius);
  }
  const bounds = movementBox(arena, box);
  const p = localPoint(point, bounds);
  const hw = Math.max(0, bounds.w / 2 - radius), hh = Math.max(0, bounds.h / 2 - radius);
  const x = clamp(p.x, -hw, hw), y = clamp(p.y, -hh, hh);
  return { x: bounds.x + (x * p.c - y * p.s), y: bounds.y + (x * p.s + y * p.c) };
}

function canTraverse(from, to, points, radius) {
  if (!pointInPolygon(to, points)) return false;
  const r2 = radius ** 2 - EPS;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    if (intersects(from, to, a, b) || Math.min(edgeDistance2(from, a, b), edgeDistance2(to, a, b),
      edgeDistance2(a, from, to), edgeDistance2(b, from, to)) < r2) return false;
  }
  return true;
}

function travel(from, dx, dy, points, radius) {
  const target = { x: from.x + dx, y: from.y + dy };
  if (dx === 0 && dy === 0 || canTraverse(from, target, points, radius)) return target;
  let lo = 0, hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (canTraverse(from, { x: from.x + dx * mid, y: from.y + dy * mid }, points, radius)) lo = mid;
    else hi = mid;
  }
  return { x: from.x + dx * lo, y: from.y + dy * lo };
}

export function moveInArena(arena, box, from, to, radius = ARENA_SOUL_RADIUS) {
  if (arena?.kind !== 'polygon') return placeInArena(arena, box, to, radius);
  const start = placeInArena(arena, box, from, radius);
  const points = arena.points;
  const p = travel(start, to.x - from.x, to.y - from.y, points, radius);
  const dx = start.x + to.x - from.x - p.x, dy = start.y + to.y - from.y - p.y;
  if (Math.hypot(dx, dy) <= EPS) return p;
  let nearest = Infinity, ex = 0, ey = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length];
    const d2 = edgeDistance2(p, a, b);
    if (d2 < nearest) {
      nearest = d2;
      ex = b.x - a.x;
      ey = b.y - a.y;
    }
  }
  const along = dot(dx, dy, ex, ey) / (ex * ex + ey * ey);
  return travel(p, along * ex, along * ey, points, radius);
}

/** Resolve an actual, timed path for stateful mechanics. Legacy movement keeps its original clamp. */
export function resolveArenaMove(arena, box, from, dx, dy, stopAtWall = false, radius = ARENA_SOUL_RADIUS) {
  let p = placeInArena(arena, box, from, radius);
  const path = [], contacts = [];
  let t = 0;
  const rect = arena.kind !== 'polygon' ? movementBox(arena, box) : null;
  for (let pass = 0; pass < 2 && Math.hypot(dx, dy) > EPS; pass++) {
    let fraction = 1, normal = null;
    if (rect) {
      const local = localPoint(p, rect);
      const lx = dx * local.c + dy * local.s, ly = -dx * local.s + dy * local.c;
      const hw = Math.max(0, rect.w / 2 - radius), hh = Math.max(0, rect.h / 2 - radius);
      const tx = Math.abs(lx) > EPS ? ((lx > 0 ? hw : -hw) - local.x) / lx : Infinity;
      const ty = Math.abs(ly) > EPS ? ((ly > 0 ? hh : -hh) - local.y) / ly : Infinity;
      fraction = clamp(Math.min(tx, ty), 0, 1);
      if (fraction < 1) {
        const sign = tx <= ty ? Math.sign(lx) : Math.sign(ly);
        normal = tx <= ty ? { x: -sign * local.c, y: -sign * local.s } : { x: sign * local.s, y: -sign * local.c };
      }
    } else {
      const points = arena.points;
      const edge = travel(p, dx, dy, points, radius);
      fraction = clamp(dot(edge.x - p.x, edge.y - p.y, dx, dy) / (dx * dx + dy * dy), 0, 1);
      if (fraction < 1 - EPS) {
        let nearest = Infinity;
        for (let i = 0; i < points.length; i++) {
          const a = points[i], b = points[(i + 1) % points.length];
          const ex = b.x - a.x, ey = b.y - a.y;
          const u = clamp(dot(edge.x - a.x, edge.y - a.y, ex, ey) / (ex * ex + ey * ey), 0, 1);
          const nx = edge.x - a.x - ex * u, ny = edge.y - a.y - ey * u;
          const d = Math.hypot(nx, ny);
          if (d < nearest) {
            nearest = d;
            normal = { x: nx / d, y: ny / d };
          }
        }
      }
    }
    const q = { x: p.x + dx * fraction, y: p.y + dy * fraction };
    const next = t + (1 - t) * fraction;
    if (next > t) path.push({ from: p, to: q, start: t, end: next });
    p = q;
    t = next;
    if (!normal) break;
    contacts.push(normal);
    if (stopAtWall) break;
    const toward = Math.min(0, dot(dx, dy, normal.x, normal.y));
    dx = (dx - toward * normal.x) * (1 - fraction);
    dy = (dy - toward * normal.y) * (1 - fraction);
  }
  if (t < 1) path.push({ from: p, to: p, start: t, end: 1 });
  return { point: p, contacts, path };
}

export function clipCorners(shape) {
  if (shape.points) return shape.points;
  const rot = (Number(shape.rotation) || 0) * DEG;
  const c = Math.cos(rot), s = Math.sin(rot);
  const w = shape.w / 2, h = shape.h / 2;
  return [[-w, -h], [w, -h], [w, h], [-w, h]].map(([x, y]) => ({
    x: shape.x + x * c - y * s, y: shape.y + x * s + y * c,
  }));
}

/** Resolve the same clip geometry for Canvas and hazard admission. */
export function clipShape(target, box, arena, custom) {
  if (target === 'none' || !target) return null;
  if (target === 'custom') return custom || box;
  if (target === 'arena' && arena?.kind === 'polygon') return arena;
  return target === 'arena' ? movementBox(arena, box) : box;
}

export function pointInClip(point, shape) {
  return !shape || (shape.points ? pointInPolygon(point, shape.points) : pointInRect(point, shape));
}
