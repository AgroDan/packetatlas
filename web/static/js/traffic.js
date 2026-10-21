// Car simulation. Each building spawns cars in proportion to its traffic
// intensity: inbound cars (rx) drive to its driveway and pull in, outbound
// cars (tx) pull out and drive away. Most trips are local to the
// neighbourhood; some come from or leave via the map edge ("the internet").

import { CAR_COLORS } from './sprites.js';

const MAX_CARS = 600;
const MAX_RATE = 2.2; // cars/sec per building at intensity 1
const LANE = 0.2; // lane offset from road centre, in tiles
const MIN_GAP = 0.45; // following distance, in tiles
const FADE = 0.5; // fade-in/out distance at trip ends, in tiles
const EDGE_TRIP_SHARE = 0.3;

export class Traffic {
  constructor(city) {
    this.city = city;
    this.cars = [];
    this.acc = new Map();
    this.nextId = 1;
  }

  update(dt, statusById) {
    for (const b of this.city.buildings) {
      const st = statusById.get(b.id);
      if (!st) continue;
      // Squaring-ish the intensity keeps quiet services visibly quieter than busy ones.
      const rate = Math.pow(st.intensity || 0, 1.6) * MAX_RATE;
      let acc = (this.acc.get(b.id) || Math.random()) + rate * dt;
      while (acc >= 1) {
        acc -= 1;
        // Thin out spawning smoothly as we approach the global cap.
        if (Math.random() > this.cars.length / MAX_CARS) this.spawn(b, st);
      }
      this.acc.set(b.id, acc);
    }
    this.move(dt);
  }

  spawn(b, st) {
    const city = this.city;
    const roads = city.roadsFrom(b);
    const total = (st.rxRate || 0) + (st.txRate || 0);
    const inbound = Math.random() < (total > 0 ? st.rxRate / total : 0.5);

    const pool = roads.edges.length && Math.random() < EDGE_TRIP_SHARE ? roads.edges : roads.local;
    if (!pool.length) return;
    let tiles = city.pathTo(b, pool[(Math.random() * pool.length) | 0]);
    if (!tiles || tiles.length < 2) return;
    if (!inbound) tiles = tiles.reverse();

    const pts = laneOffsetPath(tiles);
    // Pull into / out of the lot through the building's door.
    if (inbound) pts.push({ x: b.door[0], y: b.door[1] });
    else pts.unshift({ x: b.door[0], y: b.door[1] });

    const seglen = [];
    let len = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y);
      seglen.push(l);
      len += l;
    }

    const r = Math.random();
    const type = r < 0.5 ? 'sedan' : r < 0.75 ? 'hatch' : r < 0.92 ? 'van' : 'truck';
    const maxSpeed = (type === 'truck' ? 1.6 : 2.2) * (0.85 + Math.random() * 0.3);
    this.cars.push({
      id: this.nextId++,
      building: b.id,
      inbound,
      type,
      color: (Math.random() * CAR_COLORS.length) | 0,
      pts,
      seglen,
      len,
      seg: 0,
      d: 0, // distance along current segment
      s: 0, // distance along whole path
      speed: maxSpeed,
      maxSpeed,
      x: pts[0].x,
      y: pts[0].y,
      dx: 0,
      dy: 0,
      alpha: 0,
    });
  }

  move(dt) {
    // Bucket cars by tile and heading for cheap car-following checks.
    const buckets = new Map();
    const key = (tx, ty, hx, hy) => `${tx},${ty},${hx},${hy}`;
    for (const c of this.cars) {
      this.orient(c);
      const k = key(Math.floor(c.x), Math.floor(c.y), Math.sign(Math.round(c.dx)), Math.sign(Math.round(c.dy)));
      let arr = buckets.get(k);
      if (!arr) buckets.set(k, (arr = []));
      arr.push(c);
    }

    const alive = [];
    for (const c of this.cars) {
      const hx = Math.sign(Math.round(c.dx)), hy = Math.sign(Math.round(c.dy));
      const tx = Math.floor(c.x), ty = Math.floor(c.y);
      const myProj = c.x * hx + c.y * hy;
      let gap = Infinity;
      for (const k of [key(tx, ty, hx, hy), key(tx + hx, ty + hy, hx, hy)]) {
        const arr = buckets.get(k);
        if (!arr) continue;
        for (const o of arr) {
          if (o === c) continue;
          const p = o.x * hx + o.y * hy - myProj;
          // Ties broken by id so two overlapping cars never block each other.
          if (p > 0 || (p === 0 && o.id < c.id)) gap = Math.min(gap, p);
        }
      }
      c.speed = gap < MIN_GAP ? Math.max(0, c.speed - 12 * dt) : Math.min(c.maxSpeed, c.speed + 3 * dt);

      let step = c.speed * dt;
      while (step > 0 && c.seg < c.seglen.length) {
        const rem = c.seglen[c.seg] - c.d;
        if (step < rem) {
          c.d += step;
          c.s += step;
          step = 0;
        } else {
          step -= rem;
          c.s += rem;
          c.seg++;
          c.d = 0;
        }
      }
      if (c.seg >= c.seglen.length) continue; // arrived
      const a = c.pts[c.seg], b = c.pts[c.seg + 1];
      const t = c.seglen[c.seg] ? c.d / c.seglen[c.seg] : 0;
      c.x = a.x + (b.x - a.x) * t;
      c.y = a.y + (b.y - a.y) * t;
      c.alpha = Math.max(0, Math.min(1, c.s / FADE, (c.len - c.s) / FADE));
      alive.push(c);
    }
    this.cars = alive;
  }

  orient(c) {
    const i = Math.min(c.seg, c.pts.length - 2);
    const a = c.pts[i], b = c.pts[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const l = Math.hypot(dx, dy) || 1;
    c.dx = dx / l;
    c.dy = dy / l;
  }

  clear() {
    this.cars = [];
  }
}

/** Tile centres, shifted into the right-hand lane with mitred corners. */
function laneOffsetPath(tiles) {
  const n = tiles.length;
  const right = (i) => {
    // Right-hand normal of segment i → i+1 (tile space, y down): (-dy, dx).
    const [x0, y0] = tiles[i], [x1, y1] = tiles[i + 1];
    return [-(y1 - y0), x1 - x0];
  };
  const pts = [];
  for (let i = 0; i < n; i++) {
    const r1 = i > 0 ? right(i - 1) : right(0);
    const r2 = i < n - 1 ? right(i) : r1;
    const same = r1[0] === r2[0] && r1[1] === r2[1];
    const opposite = r1[0] === -r2[0] && r1[1] === -r2[1];
    const off = same || opposite ? r1 : [r1[0] + r2[0], r1[1] + r2[1]];
    pts.push({ x: tiles[i][0] + 0.5 + off[0] * LANE, y: tiles[i][1] + 0.5 + off[1] * LANE });
  }
  return pts;
}
