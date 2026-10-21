// Procedural 16-bit isometric sprites: buildings, cars, trees and map pins.
// Everything is drawn pixel-by-pixel into PixBufs and cached as canvases.

import { PixBuf, rasterBox, hexToRgb, mix, shade, hash2, strHash, rng, AX } from './pixel.js';

const GLASS = hexToRgb('#28344e');
const SHEEN = hexToRgb('#4d6a9c');
const LIT = hexToRgb('#ffd666');
const LIT_HI = hexToRgb('#fff0b0');
const CONCRETE = hexToRgb('#d6d0c4');
const ROOF = hexToRgb('#7d7a76');
const STEEL = hexToRgb('#9aa0a8');
const BRICK = hexToRgb('#a4553f');
const LED_ON = hexToRgb('#5cf08a');
const LED_ALT = hexToRgb('#59b7ff');
const LED_DOWN = hexToRgb('#ff4a4a');
const DARK = hexToRgb('#1d2230');
// Construction site.
const GIRDER = hexToRgb('#c9562c');
const POLE = hexToRgb('#a9aeb5');
const PLANK = hexToRgb('#d9a441');
const CRANE = hexToRgb('#f2c230');
const CRANE_D = hexToRgb('#a8821a');
// Fire.
const SOOT = hexToRgb('#2e2622');
const FIRE = hexToRgb('#ff8a1e');
const FIRE_HI = hexToRgb('#ffd45a');
const CHAR = hexToRgb('#140f0d');

/**
 * Per-kind geometry. a/b are footprint sizes in tiles; buildings with floors
 * grow one floor per pod (perPod) for kubernetes targets.
 */
export const KINDS = {
  office: { a: 2, b: 2, floorH: 7, min: 1, max: 16, base: 5, perPod: 1, pad: 10 },
  tower: { a: 1.5, b: 1.5, floorH: 6, min: 4, max: 26, base: 12, perPod: 2, pad: 20 },
  datacenter: { a: 2.5, b: 2.5, height: 19, pad: 10 },
  factory: { a: 2.5, b: 2, height: 16, pad: 30 },
  shop: { a: 2, b: 1.75, height: 16, pad: 8 },
  radio: { a: 1.25, b: 1.25, height: 9, pad: 50 },
};

/** Derive floors / lit floors from a target status. */
export function buildingSpec(status) {
  const kind = KINDS[status.building] ? status.building : 'office';
  const k = KINDS[kind];
  // Kubernetes pods and Docker containers each get a floor.
  const hasInstances = status.replicas > 0;
  const healthFrac = status.state === 'up' ? 1 : status.state === 'degraded' ? 0.5 : 0;
  const frac = hasInstances ? status.ready / status.replicas : healthFrac;
  if (k.height) return { kind, floors: 0, lit: 0, frac, state: status.state };
  const floors = clamp(hasInstances ? status.replicas * k.perPod : k.base, k.min, k.max);
  const lit = hasInstances ? Math.min(floors, status.ready * k.perPod) : Math.ceil(floors * healthFrac);
  return { kind, floors, lit, frac, state: status.state };
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

const cache = new Map();

export function buildingSprite(spec, colorHex, seedStr) {
  const key = `${spec.kind}|${spec.floors}|${spec.lit}|${spec.frac.toFixed(2)}|${spec.state}|${colorHex}|${seedStr}`;
  let s = cache.get(key);
  if (!s) {
    s = drawBuilding(spec, colorHex, strHash(seedStr) % 997);
    cache.set(key, s);
  }
  return s;
}

function drawBuilding(spec, colorHex, seed) {
  const k = KINDS[spec.kind];
  const ax = k.a * AX, by = k.b * AX;
  const h = k.height || 3 + spec.floors * k.floorH;
  const pad = k.pad;
  const buf = new PixBuf(ax + by, pad + (ax + by) / 2 + h + 1);
  const ox = by, oy = pad;

  const burning = spec.state === 'down';
  const underConstruction = spec.state === 'degraded';
  let base = hexToRgb(colorHex);
  if (spec.state === 'unknown') base = mix(base, [110, 110, 115], 0.45);
  if (burning) base = mix(base, SOOT, 0.55); // scorched
  const wall = mix(base, CONCRETE, burning ? 0.15 : 0.4);

  // Under construction: the top floors are still a bare steel frame, and the
  // builder only draws the finished floors beneath it.
  const frameFloors = underConstruction && spec.floors > 1 ? Math.max(1, Math.round(spec.floors * 0.35)) : 0;
  const frameH = frameFloors * (k.floorH || 0);
  const bodyFloors = spec.floors - frameFloors;
  const bodySpec = frameFloors ? { ...spec, floors: bodyFloors, lit: Math.min(spec.lit, bodyFloors) } : spec;

  const ctx = {
    buf, ox, oy: oy + frameH, ax, by, h: h - frameH, k, spec: bodySpec, seed, base, wall,
    dead: burning || spec.state === 'unknown', burning, unfinished: frameH > 0,
  };
  const meta = { beacon: null, smoke: null };
  BUILDERS[spec.kind](ctx, meta);
  if (frameH) {
    steelFrame(ctx, oy, frameH, k.floorH);
    meta.beacon = { x: ox, y: oy - 3 };
  }
  if (underConstruction) scaffolding(ctx);

  return {
    canvas: buf.toCanvas(),
    buf,
    // Offset from the sprite's top-left to the footprint's top vertex on the ground.
    anchorX: ox,
    anchorY: oy + h,
    height: h,
    beacon: meta.beacon,
    smoke: meta.smoke,
    // Points (sprite pixels) where flames come out of a burning building.
    fire: burning ? fireEmitters(ctx) : [],
    footprint: [k.a, k.b],
  };
}

/** Bare girders for the unfinished top floors, drawn above the finished body. */
function steelFrame(c, top, frameH, floorH) {
  const { buf, ox, ax, by } = c;
  // The faces below only cover the front; add the back corner column.
  for (let y = 0; y < frameH; y++) buf.set(ox, top + y, shade(GIRDER, -0.35));
  rasterBox(buf, ox, top, ax, by, frameH, (face, u, v, fw) => {
    if (face === 'top') return u < 1.5 || v < 1.5 || u > ax - 1.5 || v > by - 1.5 ? shade(GIRDER, 0.15) : null;
    const column = u % 8 === 0 || u === fw - 1;
    const beam = v % floorH === 0;
    const brace = (u % 8) === (v % floorH) && v % floorH !== 0;
    return column || beam || brace ? faceColor(brace ? shade(GIRDER, -0.15) : GIRDER, face) : null;
  });
}

/** Scaffolding (poles, planks, braces) over the finished walls. */
function scaffolding(c) {
  const { buf, ox, oy, ax, by, h } = c;
  rasterBox(buf, ox, oy, ax, by, h, (face, u, v) => {
    if (face === 'top') return null;
    if (v % 7 === 6 && v > 2) return faceColor(PLANK, face);
    if (u % 6 === 3) return faceColor(POLE, face);
    if ((u + v) % 12 === 0) return faceColor(shade(POLE, -0.25), face);
    return null;
  });
}

/** Window colour for a burning building: flames inside, or burnt out. */
function fireWindow(i, j, topRow, seed) {
  if (hash2(i, j, seed + 77) < 0.6) return topRow ? FIRE_HI : FIRE;
  return CHAR;
}

function fireEmitters(c) {
  const { ox, oy, ax, by, h, seed } = c;
  const pts = [];
  for (const [fu, fv] of [[0.3, 0.35], [0.65, 0.5], [0.4, 0.75]]) {
    pts.push({ ...roofPoint(c, Math.round(ax * fu), Math.round(by * fv)), roof: true });
  }
  // A few flames licking out of windows on the visible walls.
  const r = rng(seed + 5);
  const n = Math.min(5, 1 + Math.floor(h / 14));
  for (let i = 0; i < n; i++) {
    const v = Math.round(4 + r() * Math.max(1, h - 10));
    if (r() < 0.55) {
      const u = Math.round(3 + r() * (ax - 6));
      pts.push({ x: ox - by + u, y: oy + Math.round(by + (u - by + 0.5) / 2) + v, roof: false });
    } else {
      const col = ax - by + Math.round(3 + r() * (by - 6));
      pts.push({ x: ox + col, y: oy + Math.round(ax - (col + 0.5) / 2) + v, roof: false });
    }
  }
  return pts;
}

// --- shared painters -------------------------------------------------------

function faceColor(c, face) {
  return face === 'right' ? shade(c, -0.24) : c;
}

/** Edge outline / highlight common to all walls; returns null if not an edge. */
function edge(face, u, v, fw, fh, c) {
  if (face === 'left' && u === 0) return shade(c, -0.35);
  if (face === 'right' && u === fw - 1) return shade(c, -0.35);
  if (face === 'left' && u === fw - 1) return shade(c, 0.22);
  if (v === fh - 1) return shade(c, -0.3);
  return null;
}

function roofPaint(ax, by, rim, fill, seed) {
  return (u, v) => {
    if (u < 1.5 || v < 1.5 || u > ax - 1.5 || v > by - 1.5) return rim;
    return hash2(Math.floor(u), Math.floor(v), seed) < 0.1 ? shade(fill, -0.06) : fill;
  };
}

/** Small box sitting on the main roof at axis-pixel offset (du, dv). */
function roofBox(c, du, dv, w, d, hh, color, top) {
  const x = c.ox + (du - dv);
  const y = c.oy + Math.round((du + dv) / 2) - hh;
  rasterBox(c.buf, x, y, w, d, hh, (face, u, v, fw, fh) => {
    if (face === 'top') return top || shade(color, 0.15);
    const fc = faceColor(color, face);
    return edge(face, u, v, fw, fh, fc) || fc;
  });
  return { x, y };
}

/** Screen position of the roof's centre (axis offset du, dv) in sprite pixels. */
function roofPoint(c, du, dv) {
  return { x: c.ox + (du - dv), y: c.oy + Math.round((du + dv) / 2) };
}

// --- building types --------------------------------------------------------

const BUILDERS = {
  office(c, meta) {
    const { ax, by, h, k, spec, seed, wall, base } = c;
    const rim = shade(wall, 0.15);
    const roof = roofPaint(ax, by, rim, mix(ROOF, base, 0.2), seed);
    rasterBox(c.buf, c.ox, c.oy, ax, by, h, (face, u, v, fw, fh) => {
      if (face === 'top') return roof(u, v);
      return windowedWall(face, u, v, fw, fh, wall, k.floorH, spec, seed);
    });
    if (!c.unfinished) {
      roofBox(c, 6, 6, 8, 6, 4, STEEL);
      if (spec.floors >= 4) roofBox(c, ax - 12, by - 12, 6, 6, 3, STEEL);
    }
    meta.smoke = roofPoint(c, ax / 2, by / 2);
    meta.beacon = { ...roofPoint(c, 9, 8), y: roofPoint(c, 9, 8).y - 6 };
  },

  tower(c, meta) {
    const { ax, by, h, k, spec, seed, wall, base } = c;
    const glassWall = mix(base, GLASS, 0.35);
    const rim = shade(wall, 0.2);
    const roof = roofPaint(ax, by, rim, mix(ROOF, base, 0.15), seed);
    rasterBox(c.buf, c.ox, c.oy, ax, by, h, (face, u, v, fw, fh) => {
      if (face === 'top') return roof(u, v);
      // Curtain-wall tower: vertical mullions, every floor glazed.
      const fc = faceColor(glassWall, face);
      const e = edge(face, u, v, fw, fh, fc);
      if (e) return e;
      if (v < 3) return shade(faceColor(wall, face), v === 0 ? 0.15 : 0);
      const fv = v - 3, floor = Math.floor(fv / k.floorH), r = fv % k.floorH;
      if (r === 0 || u % 3 === 0) return faceColor(shade(wall, -0.05), face);
      if (c.burning) return fireWindow(Math.floor(u / 3) + (face === 'right' ? 50 : 0), floor, r === 1, seed);
      const fromBottom = spec.floors - 1 - floor;
      const on = fromBottom < spec.lit && hash2(Math.floor(u / 3), floor, seed) > 0.18;
      if (on) return r === 1 ? LIT_HI : LIT;
      return r === 1 ? faceColor(SHEEN, face) : fc;
    });
    // Antenna with a status beacon on top.
    const top = roofPoint(c, ax / 2, by / 2);
    meta.beacon = { x: top.x, y: top.y - 16 };
    meta.smoke = top;
    if (c.unfinished) return;
    for (let i = 1; i <= 15; i++) c.buf.set(top.x, top.y - i, i > 12 ? STEEL : shade(STEEL, -0.3));
    c.buf.set(top.x - 1, top.y - 6, STEEL);
    c.buf.set(top.x + 1, top.y - 6, STEEL);
  },

  datacenter(c, meta) {
    const { ax, by, h, spec, seed, wall, base } = c;
    const panel = mix(wall, STEEL, 0.5);
    const stripe = shade(base, -0.05);
    const roof = roofPaint(ax, by, shade(panel, 0.2), mix(ROOF, panel, 0.3), seed);
    rasterBox(c.buf, c.ox, c.oy, ax, by, h, (face, u, v, fw, fh) => {
      if (face === 'top') {
        // Vent grid on the roof.
        const vent = Math.floor(u) % 8 < 5 && Math.floor(v) % 8 < 5 && u > 4 && v > 4 && u < ax - 4 && v < by - 4;
        return vent ? shade(DARK, 0.25) : roof(u, v);
      }
      const fc = faceColor(panel, face);
      const e = edge(face, u, v, fw, fh, fc);
      if (e) return e;
      if (v >= 2 && v < 5) return faceColor(stripe, face);
      // Rows of rack LEDs; they go red when the target is down.
      if (v >= 8 && v < fh - 3 && (v - 8) % 4 === 0 && u % 3 === 1 && u > 2 && u < fw - 3) {
        if (c.dead) return LED_DOWN;
        const on = hash2(u, v, seed) < spec.frac + 0.05;
        return on ? (hash2(u, v, seed + 1) < 0.3 ? LED_ALT : LED_ON) : DARK;
      }
      return u % 6 === 0 ? shade(fc, -0.06) : fc;
    });
    roofBox(c, 8, 26, 8, 8, 5, STEEL, shade(DARK, 0.4));
    roofBox(c, 22, 26, 8, 8, 5, STEEL, shade(DARK, 0.4));
    meta.smoke = roofPoint(c, ax / 2, by / 2);
    meta.beacon = { ...roofPoint(c, 4, 4), y: roofPoint(c, 4, 4).y - 2 };
  },

  factory(c, meta) {
    const { ax, by, h, spec, seed, base } = c;
    const brick = mix(BRICK, base, 0.25);
    const roof = roofPaint(ax, by, shade(brick, 0.1), mix(ROOF, brick, 0.15), seed);
    rasterBox(c.buf, c.ox, c.oy, ax, by, h, (face, u, v, fw, fh) => {
      if (face === 'top') {
        // Saw-tooth skylights.
        return Math.floor(u) % 10 < 3 && v > 3 && v < by - 3 ? (c.dead ? DARK : SHEEN) : roof(u, v);
      }
      const fc = faceColor(brick, face);
      const e = edge(face, u, v, fw, fh, fc);
      if (e) return e;
      // Roller door on the front-left wall.
      if (face === 'left' && u > fw * 0.35 && u < fw * 0.65 && v > fh - 10) {
        return v % 2 ? shade(STEEL, -0.25) : STEEL;
      }
      // High clerestory windows.
      if (v >= 3 && v < 6 && u % 5 > 1 && u > 2 && u < fw - 2) {
        if (c.burning) return fireWindow(u, 0, false, seed);
        return hash2(u, 0, seed) < spec.frac ? LIT : GLASS;
      }
      const mortar = v % 3 === 0 || (u + (Math.floor(v / 3) % 2) * 2) % 4 === 0;
      return mortar ? shade(fc, -0.08) : fc;
    });
    // Chimney at the back corner.
    const ch = roofBox(c, 6, 6, 6, 6, 24, shade(BRICK, -0.1), DARK);
    meta.smoke = { x: ch.x, y: ch.y };
    meta.beacon = { x: ch.x, y: ch.y - 3 };
  },

  shop(c, meta) {
    const { ax, by, h, spec, seed, wall, base } = c;
    const roof = roofPaint(ax, by, shade(wall, 0.2), mix(ROOF, wall, 0.3), seed);
    const lit = spec.frac > 0;
    rasterBox(c.buf, c.ox, c.oy, ax, by, h, (face, u, v, fw, fh) => {
      if (face === 'top') return roof(u, v);
      const fc = faceColor(wall, face);
      const e = edge(face, u, v, fw, fh, fc);
      if (e) return e;
      if (v < 2) return shade(fc, 0.1);
      // Striped awning.
      if (v >= 4 && v < 7) return faceColor(Math.floor(u / 3) % 2 ? base : [245, 242, 235], face);
      if (v === 7) return shade(faceColor(base, face), -0.3);
      // Shop window and door.
      if (v >= 8 && v < fh - 1 && u > 2 && u < fw - 3) {
        const door = face === 'left' && u > fw / 2 - 2 && u < fw / 2 + 2;
        if (door) return shade(DARK, 0.15);
        if (u % 8 === 0) return fc;
        if (c.burning) return fireWindow(u >> 2, face === 'right' ? 1 : 0, v === 8, seed);
        return lit ? (v === 8 ? LIT_HI : mix(LIT, GLASS, 0.35)) : faceColor(GLASS, face);
      }
      return fc;
    });
    // Rooftop sign.
    const p = roofPoint(c, ax / 2, by / 2);
    for (let i = -5; i <= 5; i++) {
      for (let j = 0; j < 4; j++) c.buf.set(p.x + i, p.y - 6 - j + Math.round(i / 2), j === 0 || j === 3 ? DARK : lit ? LIT : shade(base, -0.2));
    }
    c.buf.set(p.x - 4, p.y - 2 - 2, STEEL);
    c.buf.set(p.x + 4, p.y - 2 + 2, STEEL);
    meta.smoke = p;
    meta.beacon = { x: p.x, y: p.y - 12 };
  },

  radio(c, meta) {
    const { ax, by, h, seed, wall } = c;
    const roof = roofPaint(ax, by, shade(wall, 0.2), ROOF, seed);
    rasterBox(c.buf, c.ox, c.oy, ax, by, h, (face, u, v, fw, fh) => {
      if (face === 'top') return roof(u, v);
      const fc = faceColor(wall, face);
      const e = edge(face, u, v, fw, fh, fc);
      if (e) return e;
      if (face === 'left' && u > fw / 2 - 2 && u < fw / 2 + 2 && v > 2) return DARK;
      return fc;
    });
    // Lattice mast: red/white segments with cross bracing.
    const top = roofPoint(c, ax / 2, by / 2);
    const H = 42;
    const red = hexToRgb('#d8463c'), white = hexToRgb('#eeeeee');
    for (let i = 0; i < H; i++) {
      const y = top.y - i;
      const spread = Math.round(((H - i) / H) * 3);
      const col = Math.floor(i / 6) % 2 ? white : red;
      c.buf.set(top.x - spread, y, col);
      c.buf.set(top.x + spread, y, shade(col, -0.2));
      if (i % 6 === 0) for (let x = -spread; x <= spread; x++) c.buf.set(top.x + x, y, shade(col, -0.1));
    }
    c.buf.set(top.x - 2, top.y - 30, STEEL);
    c.buf.set(top.x + 2, top.y - 30, STEEL);
    meta.beacon = { x: top.x, y: top.y - H - 1 };
    meta.smoke = top;
  },
};

function windowedWall(face, u, v, fw, fh, wall, floorH, spec, seed) {
  const fc = faceColor(wall, face);
  const e = edge(face, u, v, fw, fh, fc);
  if (e) return e;
  if (v < 3) return shade(fc, v === 0 ? 0.15 : 0.05);
  const fv = v - 3, floor = Math.floor(fv / floorH), r = fv % floorH;
  const fromBottom = spec.floors - 1 - floor;
  // Ground floor entrance on the front-left wall.
  if (fromBottom === 0 && face === 'left' && u > fw / 2 - 3 && u < fw / 2 + 3 && r >= 2) return DARK;
  if (r >= 2 && r < 5 && u % 4 >= 1 && u % 4 < 3 && u > 1 && u < fw - 2) {
    if (spec.state === 'down') return fireWindow(u >> 2, floor + (face === 'right' ? 50 : 0), r === 2, seed);
    const on = fromBottom < spec.lit && hash2(u >> 2, floor + (face === 'right' ? 50 : 0), seed) > 0.12;
    if (on) return r === 2 ? LIT_HI : LIT;
    return r === 2 ? faceColor(SHEEN, face) : faceColor(GLASS, face);
  }
  if (r === 0) return shade(fc, -0.07);
  return fc;
}

// --- vehicles --------------------------------------------------------------

export const CAR_COLORS = ['#d94f4f', '#3b7dd8', '#f2c94c', '#ececec', '#3a3a40', '#56b870', '#e08a3c', '#8e6bd6', '#5fc0c8'];

export const VEHICLES = {
  sedan: { len: 9, wid: 5, h: 3, cab: [5, 4, 2] },
  hatch: { len: 7, wid: 5, h: 3, cab: [4, 4, 2] },
  van: { len: 10, wid: 5, h: 6, cab: null },
  truck: { len: 13, wid: 6, h: 7, cab: null },
};

const carCache = new Map();

/** axis 'x' or 'y'; forward true when moving in the + direction. */
export function carSprite(type, colorIdx, axis, forward) {
  const key = `${type}|${colorIdx}|${axis}|${forward}`;
  let s = carCache.get(key);
  if (s) return s;
  const v = VEHICLES[type];
  const body = hexToRgb(CAR_COLORS[colorIdx % CAR_COLORS.length]);
  const ax = axis === 'x' ? v.len : v.wid;
  const by = axis === 'x' ? v.wid : v.len;
  const cabH = v.cab ? v.cab[2] : 0;
  const pad = cabH + 1;
  const buf = new PixBuf(ax + by, pad + Math.ceil((ax + by) / 2) + v.h + 1);
  const ox = by, oy = pad;
  // Which visible face is the end of the vehicle, and is it the front?
  const endFace = axis === 'x' ? 'right' : 'left';
  const light = forward ? hexToRgb('#fff4c8') : hexToRgb('#e0322c');
  const box = type === 'truck' ? hexToRgb('#e6e2d8') : body;

  rasterBox(buf, ox, oy, ax, by, v.h, (face, u, vv, fw, fh) => {
    if (face === 'top') return shade(box, 0.18);
    const fc = faceColor(box, face);
    if (vv === fh - 1) return DARK; // tyres / shadow line
    if (face === endFace && vv === 1 && (u === 0 || u === fw - 1)) return light;
    if (face !== endFace && type === 'van' && vv === 1 && u > 1 && u < fw - 2) return GLASS;
    if (face !== endFace && type === 'truck' && vv < fh - 3) {
      // Cab at the front, coloured, cargo box behind.
      // Left face runs +x from u=0; right face runs -y from u=0.
      const highEnd = axis === 'x' ? forward : !forward;
      const front = highEnd ? u > fw - 4 : u < 3;
      if (front) return vv === 1 ? GLASS : faceColor(body, face);
    }
    return fc;
  });
  if (v.cab) {
    const [cl, cw, chh] = v.cab;
    const cax = axis === 'x' ? cl : cw;
    const cby = axis === 'x' ? cw : cl;
    const du = (ax - cax) / 2, dv = (by - cby) / 2;
    rasterBox(buf, ox + Math.round(du - dv), oy + Math.round((du + dv) / 2) - chh, cax, cby, chh, (face) =>
      face === 'top' ? shade(body, 0.25) : faceColor(GLASS, face),
    );
  }
  s = {
    canvas: buf.toCanvas(),
    // Offset from sprite top-left to the footprint centre on the ground.
    cx: ox + (ax - by) / 2,
    cy: oy + v.h + (ax + by) / 4,
  };
  carCache.set(key, s);
  return s;
}

// --- trees -----------------------------------------------------------------

const treeCache = [];

export function treeSprite(variant) {
  if (treeCache[variant]) return treeCache[variant];
  const buf = new PixBuf(16, 24);
  const trunk = hexToRgb('#6b4a2e');
  const greens = [
    [hexToRgb('#3f8a3a'), hexToRgb('#2f6e2e'), hexToRgb('#62b04f')],
    [hexToRgb('#4c9440'), hexToRgb('#376f30'), hexToRgb('#79bd55')],
    [hexToRgb('#2f7046'), hexToRgb('#235536'), hexToRgb('#4a9363')],
  ][variant % 3];
  // Shadow on the ground.
  for (let x = -5; x <= 5; x++) for (let y = -1; y <= 1; y++) if (x * x / 25 + y * y / 2 <= 1) buf.set(8 + x + 2, 21 + y, [0, 0, 0], 60);
  for (let y = 15; y < 22; y++) {
    buf.set(7, y, trunk);
    buf.set(8, y, shade(trunk, -0.25));
  }
  if (variant === 2) {
    // Pine: stacked triangles.
    for (let y = 0; y < 17; y++) {
      const w = Math.floor((y % 6) * 0.8 + y * 0.25) + 1;
      for (let x = -w; x <= w; x++) {
        const c = x < -w / 3 ? greens[2] : x > w / 3 ? greens[1] : greens[0];
        buf.set(8 + x, y + 1, hash2(x, y, 3) < 0.15 ? greens[1] : c);
      }
    }
  } else {
    for (let y = 0; y < 16; y++) {
      for (let x = -7; x <= 7; x++) {
        const dx = x / 6.8, dy = (y - 8) / 7.5;
        const d = dx * dx + dy * dy;
        if (d > 1 - hash2(x, y, variant) * 0.15) continue;
        const lightness = -dx * 0.6 - dy * 0.8 + (hash2(x, y, 9) - 0.5) * 0.6;
        const c = lightness > 0.45 ? greens[2] : lightness < -0.35 ? greens[1] : greens[0];
        buf.set(8 + x, y, c);
      }
    }
  }
  const s = { canvas: buf.toCanvas(), cx: 8, cy: 21 };
  treeCache[variant] = s;
  return s;
}

// --- map pins ---------------------------------------------------------------

export const STATE_COLORS = {
  up: '#3fbf6a',
  degraded: '#f0b429',
  down: '#e5484d',
  unknown: '#8b93a1',
};

const pinCache = new Map();

/** Google-Maps-style teardrop pin, 11x16 logical pixels. */
export function pinSprite(state) {
  if (pinCache.has(state)) return pinCache.get(state);
  const W = 11, H = 16;
  const body = hexToRgb(STATE_COLORS[state] || STATE_COLORS.unknown);
  const inside = (x, y) => {
    const dx = x - 5, dy = y - 5;
    if (dx * dx + dy * dy <= 25.5) return true;
    return y >= 6 && y <= 15 && Math.abs(dx) <= (15 - y) * 0.5;
  };
  const buf = new PixBuf(W, H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (!inside(x, y)) continue;
      const border = !inside(x - 1, y) || !inside(x + 1, y) || !inside(x, y - 1) || !inside(x, y + 1);
      const dx = x - 5, dy = y - 5;
      let c = border ? shade(body, -0.45) : dx + dy < -3 ? shade(body, 0.25) : body;
      if (dx * dx + dy * dy <= 2) c = [255, 255, 255];
      buf.set(x, y, c);
    }
  }
  const s = { canvas: buf.toCanvas(), w: W, h: H };
  pinCache.set(state, s);
  return s;
}

// --- site props: cranes, cones, fire trucks ---------------------------------

function line(buf, x0, y0, x1, y1, c) {
  const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) || 1;
  for (let i = 0; i <= n; i++) buf.set(Math.round(x0 + ((x1 - x0) * i) / n), Math.round(y0 + ((y1 - y0) * i) / n), c);
}

const craneCache = new Map();

/**
 * Tower crane whose mast is mastH pixels tall. The jib runs along the iso +x
 * axis. Returns the mast base (baseX, baseY), the jib track the trolley
 * runs along (jib0 → jib1) and the warning light, all in sprite pixels.
 */
export function craneSprite(mastH) {
  mastH = Math.round(mastH);
  if (craneCache.has(mastH)) return craneCache.get(mastH);
  const JIB = 46, CJ = 18, APEX = 9;
  const bx = CJ + 4, top = APEX + CJ / 2 + 4;
  const buf = new PixBuf(CJ + JIB + 10, top + mastH + 4);
  const base = top + mastH;

  // Concrete footing and lattice mast.
  buf.rect(bx - 4, base - 1, 8, 3, hexToRgb('#8d8a84'));
  for (let y = top; y < base; y++) {
    buf.set(bx - 2, y, CRANE);
    buf.set(bx + 1, y, CRANE_D);
    const k = (y - top) % 4;
    if (k === 0) {
      buf.set(bx - 1, y, CRANE_D);
      buf.set(bx, y, CRANE_D);
    } else if (k === 2) buf.set((y - top) % 8 < 4 ? bx - 1 : bx, y, CRANE_D);
  }
  // Jib (two chords with lattice) and counter-jib with its counterweight.
  for (let t = 0; t <= JIB; t++) {
    const y = top + Math.round(t / 2);
    buf.set(bx + t, y, CRANE);
    buf.set(bx + t, y + 3, CRANE_D);
    if (t % 4 === 0) for (let j = 1; j < 3; j++) buf.set(bx + t, y + j, CRANE_D);
    else if (t % 4 === 2) buf.set(bx + t, y + (t % 8 < 4 ? 1 : 2), CRANE_D);
  }
  for (let t = 0; t <= CJ; t++) {
    const y = top - Math.round(t / 2);
    buf.set(bx - t, y, CRANE);
    buf.set(bx - t, y + 2, CRANE_D);
  }
  buf.rect(bx - CJ - 1, top - CJ / 2 + 1, 6, 5, hexToRgb('#7b7873'));
  buf.rect(bx - CJ - 1, top - CJ / 2 + 1, 6, 1, hexToRgb('#a19d96'));
  // Apex and tie lines.
  for (let y = top - APEX; y < top; y++) {
    buf.set(bx - 1, y, CRANE);
    buf.set(bx, y, CRANE_D);
  }
  const tie = hexToRgb('#5c5446');
  line(buf, bx, top - APEX, bx + JIB * 0.7, top + Math.round((JIB * 0.7) / 2), tie);
  line(buf, bx - 1, top - APEX, bx - CJ + 2, top - CJ / 2 + 1, tie);
  // Operator cab.
  buf.rect(bx + 2, top + 3, 4, 4, CRANE);
  buf.rect(bx + 3, top + 4, 2, 2, GLASS);

  const s = {
    canvas: buf.toCanvas(),
    baseX: bx,
    baseY: base,
    jib0: { x: bx + 8, y: top + 3 + 4 },
    jib1: { x: bx + JIB - 2, y: top + 3 + Math.round((JIB - 2) / 2) },
    light: { x: bx - 1, y: top - APEX - 1 },
  };
  craneCache.set(mastH, s);
  return s;
}

let coneCache = null;

export function coneSprite() {
  if (coneCache) return coneCache;
  const buf = new PixBuf(5, 7);
  const orange = hexToRgb('#ff7a1a'), white = hexToRgb('#f4f1ea');
  const rows = [[2, 2], [2, 2], [1, 3], [1, 3], [1, 3], [0, 4]];
  rows.forEach(([a, b], y) => {
    for (let x = a; x <= b; x++) buf.set(x, y, y === 3 ? white : x > 2 ? shade(orange, -0.25) : orange);
  });
  buf.rect(0, 6, 5, 1, shade(orange, -0.45));
  coneCache = { canvas: buf.toCanvas(), cx: 2, cy: 6 };
  return coneCache;
}

const truckCache = new Map();

/** Fire engine parked along `axis` ('x' or 'y'); lights are drawn live. */
export function fireTruckSprite(axis) {
  if (truckCache.has(axis)) return truckCache.get(axis);
  const LEN = 15, WID = 6, H = 6;
  const red = hexToRgb('#d42a1f'), silver = hexToRgb('#c9ced6');
  const ax = axis === 'x' ? LEN : WID, by = axis === 'x' ? WID : LEN;
  const buf = new PixBuf(ax + by, 3 + Math.ceil((ax + by) / 2) + H + 1);
  const ox = by, oy = 3;
  rasterBox(buf, ox, oy, ax, by, H, (face, u, v, fw, fh) => {
    if (face === 'top') {
      // Ladder: two rails along the length with rungs across.
      const along = axis === 'x' ? u : v, across = axis === 'x' ? v : u;
      if (across < 1.5 || across > WID - 1.5) return silver;
      return Math.floor(along) % 3 === 0 ? shade(silver, -0.15) : shade(red, -0.1);
    }
    const fc = faceColor(red, face);
    if (v === fh - 1) return DARK;
    if (v === 2) return faceColor([240, 236, 228], face); // white stripe
    if (v === 1 && face === (axis === 'x' ? 'left' : 'right') && u % 4 === 1) return faceColor(GLASS, face);
    return fc;
  });
  const s = {
    canvas: buf.toCanvas(),
    cx: ox + (ax - by) / 2,
    cy: oy + H + (ax + by) / 4,
    // Roof light bar, relative to the footprint centre.
    lights: [{ x: -2, y: -H - 1 }, { x: 2, y: -H - 1 }],
  };
  truckCache.set(axis, s);
  return s;
}
