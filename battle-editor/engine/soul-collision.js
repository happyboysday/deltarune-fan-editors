const DEG = Math.PI / 180;
const point = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
const angle = (a, b) => ((b - a) % 360 + 540) % 360 - 180;

function circleInterval(a, b, r) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const q = dx * dx + dy * dy, c = a.x * a.x + a.y * a.y - r * r;
  if (!q) return c <= 0 ? [0, 1] : null;
  const v = a.x * dx + a.y * dy;
  const d = v * v - q * c;
  if (d < 0) return null;
  const lo = Math.max(0, (-v - Math.sqrt(d)) / q), hi = Math.min(1, (-v + Math.sqrt(d)) / q);
  return lo <= hi ? [lo, hi] : null;
}

function rectInterval(a, b, w, h) {
  let lo = 0, hi = 1;
  for (const [key, limit] of [['x', w], ['y', h]]) {
    const d = b[key] - a[key];
    if (!d) {
      if (Math.abs(a[key]) > limit) return null;
      continue;
    }
    const t0 = (-limit - a[key]) / d, t1 = (limit - a[key]) / d;
    lo = Math.max(lo, Math.min(t0, t1));
    hi = Math.min(hi, Math.max(t0, t1));
  }
  return lo <= hi ? [lo, hi] : null;
}

function roundedIntervals(a, b, hitbox, radius) {
  const w = hitbox.w / 2, h = hitbox.h / 2;
  const ranges = [rectInterval(a, b, w + radius, h), rectInterval(a, b, w, h + radius)];
  for (const x of [-w, w]) for (const y of [-h, h]) {
    ranges.push(circleInterval({ x: a.x - x, y: a.y - y }, { x: b.x - x, y: b.y - y }, radius));
  }
  return ranges.filter(Boolean);
}

function relative(a, b, deg) {
  const x = a.x - b.x, y = a.y - b.y;
  const c = Math.cos(deg * DEG), s = Math.sin(deg * DEG);
  return { x: c * x + s * y, y: -s * x + c * y };
}

/** Sweep a moving circle against a translating hitbox. Turning boxes are evaluated in fixed angular slices. */
export function sweptHit(path, radius, previous, bullet, admit) {
  const hb = bullet.hitbox;
  let earliest = Infinity;
  const pad = radius + (hb.shape === 'rect' ? Math.hypot(hb.w, hb.h) / 2 : hb.r);
  const minX = Math.min(previous.x, bullet.x) - pad, maxX = Math.max(previous.x, bullet.x) + pad;
  const minY = Math.min(previous.y, bullet.y) - pad, maxY = Math.max(previous.y, bullet.y) + pad;
  const turn = hb.shape === 'rect' ? angle(previous.rotation, bullet.rotation) : 0;
  for (const { from, to, start, end } of path) {
    if (Math.max(from.x, to.x) < minX || Math.min(from.x, to.x) > maxX
      || Math.max(from.y, to.y) < minY || Math.min(from.y, to.y) > maxY) continue;
    const slices = Math.max(1, Math.ceil(Math.abs(turn * (end - start)) / 8));
    for (let i = 0; i < slices; i++) {
      const t0 = start + (end - start) * i / slices;
      if (t0 >= earliest) break;
      const t1 = start + (end - start) * (i + 1) / slices;
      const p0 = point(from, to, i / slices), p1 = point(from, to, (i + 1) / slices);
      const b0 = point(previous, bullet, t0), b1 = point(previous, bullet, t1);
      const rot = hb.shape === 'rect' ? previous.rotation + turn * (t0 + t1) / 2 : 0;
      const a = relative(p0, b0, rot), b = relative(p1, b1, rot);
      const ranges = hb.shape === 'rect' ? roundedIntervals(a, b, hb, radius) : [circleInterval(a, b, hb.r + radius)];
      for (const range of ranges) {
        if (!range) continue;
        const u = admit ? admit(p0, p1, b0, b1, range) : range[0];
        if (u !== null) earliest = Math.min(earliest, t0 + (t1 - t0) * u);
      }
    }
  }
  return earliest;
}

/** Clip a possible collision interval to the portions where both centers are visible. */
export function clipContact(p0, p1, b0, b1, range, points, inside) {
  const [lo, hi] = range;
  const both = (t) => inside(point(p0, p1, t)) && inside(point(b0, b1, t));
  if (both(lo)) return lo;
  const cuts = [lo, hi];
  for (const [a, b] of [[p0, p1], [b0, b1]]) {
    const dx = b.x - a.x, dy = b.y - a.y;
    for (let i = 0; i < points.length; i++) {
      const u = points[i], v = points[(i + 1) % points.length];
      const ex = v.x - u.x, ey = v.y - u.y;
      const den = dx * ey - dy * ex;
      if (!den) continue;
      const x = u.x - a.x, y = u.y - a.y;
      const t = (x * ey - y * ex) / den;
      const edge = (x * dy - y * dx) / den;
      if (t > lo && t < hi && edge >= 0 && edge <= 1) cuts.push(t);
    }
  }
  cuts.sort((a, b) => a - b);
  for (let i = 1; i < cuts.length; i++) {
    if (both(cuts[i - 1]) || both((cuts[i - 1] + cuts[i]) / 2)) return cuts[i - 1];
  }
  return both(hi) ? hi : null;
}
