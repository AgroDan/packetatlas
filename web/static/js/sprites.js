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
const STONE = hexToRgb('#e8e0ce');
const IRON = hexToRgb('#2c2c33');
const WOOD = hexToRgb('#8a5a32');
const GOLD = hexToRgb('#d9b45a');
const GRASS = hexToRgb('#5f9a4a');
const SOLAR = hexToRgb('#2b3f6b');
const SHINGLES = ['#b5523b', '#4b5260', '#5b7050', '#7a5236'].map(hexToRgb);
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
  apartment: { a: 2.25, b: 1.75, floorH: 7, min: 1, max: 16, base: 3, perPod: 1, pad: 14 },
  house: { a: 1.75, b: 1.75, floorH: 8, min: 1, max: 3, base: 2, perPod: 1, pad: 24 },
  deco: { a: 2, b: 2, floorH: 6, min: 2, max: 22, base: 7, perPod: 1, pad: 24 },
  modern: { a: 2.5, b: 2, floorH: 6, min: 1, max: 18, base: 4, perPod: 1, pad: 10 },
  tower: { a: 1.5, b: 1.5, floorH: 6, min: 4, max: 26, base: 12, perPod: 2, pad: 20 },
  datacenter: { a: 2.5, b: 2.5, height: 19, pad: 10 },
  factory: { a: 2.5, b: 2, height: 16, pad: 30 },
  shop: { a: 2, b: 1.75, height: 16, pad: 8 },
  radio: { a: 1.25, b: 1.25, height: 9, pad: 50 },
  // Landmarks, for important services: each takes a whole block. height is
  // the main body (fire and smoke come from its roof); domes, spires and the
  // like rise into pad. floors only drive the lit windows.
  skyscraper: { a: 4.5, b: 4.5, height: 200, floorH: 6, floors: 33, pad: 44, landmark: true },
  twins: { a: 5.5, b: 5.5, height: 186, floorH: 6, floors: 30, pad: 40, landmark: true },
  capitol: { a: 5.5, b: 5.5, height: 36, floorH: 8, floors: 4, pad: 96, landmark: true },
  pylon: { a: 5, b: 5, height: 18, floorH: 12, floors: 14, pad: 214, landmark: true },
  fortress: { a: 5.5, b: 5.5, height: 30, floorH: 9, floors: 6, pad: 100, landmark: true },
  arcology: { a: 5.5, b: 5.5, height: 120, floorH: 6, floors: 20, pad: 60, landmark: true },
};

// Landmark styles for building "landmark" (and important services), picked
// from the target id like AUTO.
export const LANDMARKS = Object.keys(KINDS).filter((k) => KINDS[k].landmark);

/** Whether a target (or its status) is drawn as a landmark taking a whole block. */
export function isLandmark(t) {
  return !!t.important || t.building === 'landmark' || !!KINDS[t.building]?.landmark;
}

// Styles for building "auto" (the default for Kubernetes and Docker
// targets), picked from the target id so a workload always looks the same.
const AUTO = ['office', 'apartment', 'house', 'deco', 'modern'];

/** Derive the style, floors and lit floors from a target status. */
export function buildingSpec(status, id = status.id) {
  let kind = KINDS[status.building] ? status.building : AUTO[strHash(id || '') % AUTO.length];
  if (isLandmark(status) && !KINDS[kind].landmark) kind = LANDMARKS[strHash(id || '') % LANDMARKS.length];
  // Kubernetes pods and Docker containers each get a floor.
  const hasInstances = status.replicas > 0;
  // A house that outgrows its floors becomes an apartment block.
  if (kind === 'house' && hasInstances && status.replicas * KINDS.house.perPod > KINDS.house.max) kind = 'apartment';
  const k = KINDS[kind];
  const healthFrac = status.state === 'up' ? 1 : status.state === 'degraded' ? 0.5 : 0;
  const frac = hasInstances ? status.ready / status.replicas : healthFrac;
  if (k.landmark) return { kind, floors: k.floors, lit: Math.round(k.floors * frac), frac, state: status.state };
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
  // Landmarks keep their silhouette; scaffolding and the crane say enough.
  const frameFloors = underConstruction && spec.floors > 1 && !k.landmark ? Math.max(1, Math.round(spec.floors * 0.35)) : 0;
  const frameH = frameFloors * (k.floorH || 0);
  const bodyFloors = spec.floors - frameFloors;
  const bodySpec = frameFloors ? { ...spec, floors: bodyFloors, lit: Math.min(spec.lit, bodyFloors) } : spec;

  const ctx = {
    buf, ox, oy: oy + frameH, ax, by, h: h - frameH, k, spec: bodySpec, seed, base, wall,
    dead: burning || spec.state === 'unknown', burning, unfinished: frameH > 0,
  };
  const meta = { beacon: null, smoke: null, fire: null };
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
    fire: burning ? meta.fire || fireEmitters(ctx) : [],
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

/** Small box sitting on the main roof at axis-pixel offset (du, dv), raised by lift. */
function roofBox(c, du, dv, w, d, hh, color, top, lift = 0) {
  const x = c.ox + (du - dv);
  const y = c.oy + Math.round((du + dv) / 2) - hh - lift;
  rasterBox(c.buf, x, y, w, d, hh, (face, u, v, fw, fh) => {
    if (face === 'top') return top || shade(color, 0.15);
    const fc = faceColor(color, face);
    return edge(face, u, v, fw, fh, fc) || fc;
  });
  return { x, y };
}

/**
 * Gable roof over the whole footprint, ridge along the a axis, built from
 * one-pixel slices that narrow as they rise.
 */
function gableRoof(c, rise, color, gable) {
  const half = c.by / 2;
  for (let i = 0; i < rise; i++) {
    const dv = Math.round((i * half) / rise);
    const d = c.by - 2 * dv;
    if (d < 1) break;
    const ridge = i === rise - 1;
    rasterBox(c.buf, c.ox - dv, c.oy + Math.round(dv / 2) - i - 1, c.ax, d, 1, (face, u, v) => {
      if (face === 'right') return faceColor(gable, face);
      if (face === 'left') return i % 2 ? color : shade(color, -0.12);
      if (ridge) return shade(color, 0.2);
      return v < d / 2 ? shade(color, -0.3) : shade(color, 0.1);
    });
  }
}

/** Lit, dark or burning window pane; side separates the two walls' patterns. */
function pane(spec, face, col, floor, topRow, seed, glass = GLASS) {
  const side = face === 'right' ? 50 : 0;
  if (spec.state === 'down') return fireWindow(col, floor + side, topRow, seed);
  const fromBottom = spec.floors - 1 - floor;
  if (fromBottom < spec.lit && hash2(col, floor + side, seed) > 0.14) return topRow ? LIT_HI : LIT;
  return faceColor(topRow ? SHEEN : glass, face);
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

  // Brick walk-up: sash windows with stone sills, a fire escape and a
  // water tower on the roof.
  apartment(c, meta) {
    const { ax, by, h, k, spec, seed, base } = c;
    const brick = mix(BRICK, base, c.dead ? 0.7 : 0.3);
    const trim = c.dead ? shade(brick, 0.15) : STONE;
    const roof = roofPaint(ax, by, shade(trim, -0.15), mix(ROOF, DARK, 0.3), seed);
    const fx = Math.round(by * 0.3);
    rasterBox(c.buf, c.ox, c.oy, ax, by, h, (face, u, v, fw, fh) => {
      if (face === 'top') return roof(u, v);
      const fc = faceColor(brick, face);
      const e = edge(face, u, v, fw, fh, fc);
      if (e) return e;
      if (v < 3) return faceColor(v === 2 ? shade(trim, -0.2) : trim, face);
      const fv = v - 3, floor = Math.floor(fv / k.floorH), r = fv % k.floorH;
      const fromBottom = spec.floors - 1 - floor;
      // Fire escape on the right wall: a landing and a ladder per floor.
      if (face === 'right' && fromBottom > 0 && u >= fx && u < fx + 9) {
        if (r === k.floorH - 1 || (r === k.floorH - 3 && (u - fx) % 2 === 0)) return IRON;
        if (u - fx === r + 1) return shade(IRON, 0.2);
      }
      if (fromBottom === 0 && face === 'left' && Math.abs(u - fw / 2) < 3 && r >= 1) return shade(DARK, 0.1);
      const wu = u % 6;
      if (u > 1 && u < fw - 2) {
        if (r >= 1 && r < 5 && (wu === 2 || wu === 3)) return pane(spec, face, Math.floor(u / 6), floor, r === 1, seed);
        if (r === 5 && wu >= 1 && wu <= 4) return faceColor(trim, face);
      }
      return v % 2 === 0 && hash2(u >> 1, v, seed) < 0.25 ? shade(fc, -0.07) : fc;
    });
    meta.smoke = roofPoint(c, ax / 2, by / 2);
    meta.beacon = { ...roofPoint(c, ax - 10, 10), y: roofPoint(c, ax - 10, 10).y - 18 };
    if (c.unfinished) return;
    roofBox(c, 5, by - 11, 6, 6, 4, shade(brick, -0.1));
    // Water tower: legs, a hooped barrel and a conical cap.
    const [du, dv, lift] = [ax - 14, 6, 5];
    for (const [lu, lv] of [[0, 0], [6, 0], [0, 6], [6, 6]]) {
      const p = roofPoint(c, du + lu, dv + lv);
      for (let i = 0; i < lift; i++) c.buf.set(p.x, p.y - i, IRON);
    }
    const wood = c.dead ? shade(WOOD, -0.4) : WOOD;
    const x = c.ox + (du - dv), y = c.oy + Math.round((du + dv) / 2) - 8 - lift;
    rasterBox(c.buf, x, y, 7, 7, 8, (face, u, v, fw, fh) => {
      if (face === 'top') return shade(wood, 0.1);
      const fc = faceColor(wood, face);
      return edge(face, u, v, fw, fh, fc) || (v % 3 === 1 ? shade(fc, -0.3) : fc);
    });
    for (let i = 0; i < 3; i++) roofBox(c, du + 1 + i, dv + 1 + i, 5 - 2 * i, 5 - 2 * i, 1, shade(wood, -0.25), null, lift + 8 + i);
  },

  // Small house: clapboard walls, shuttered windows and a pitched roof.
  house(c, meta) {
    const { ax, by, h, k, spec, seed, base } = c;
    const siding = mix(base, [244, 238, 226], c.dead ? 0.2 : 0.55);
    const shingle = c.dead ? shade(base, -0.35) : mix(SHINGLES[seed % SHINGLES.length], base, 0.15);
    const shutter = shade(base, -0.3);
    rasterBox(c.buf, c.ox, c.oy, ax, by, h, (face, u, v, fw, fh) => {
      if (face === 'top') return shingle;
      const fc = faceColor(siding, face);
      const e = edge(face, u, v, fw, fh, fc);
      if (e) return e;
      if (v < 3) return shade(fc, -0.25); // shadow under the eaves
      const fv = v - 3, floor = Math.floor(fv / k.floorH), r = fv % k.floorH;
      const fromBottom = spec.floors - 1 - floor;
      const centres = face === 'left' ? [fw * 0.27, fw * 0.7] : [fw * 0.5];
      for (const [i, cx] of centres.entries()) {
        const du = Math.floor(u - cx);
        if (fromBottom === 0 && face === 'left' && i === 1) {
          if (du >= -2 && du < 2 && r >= 2) return r === 2 ? shade(siding, 0.4) : shade(base, -0.45);
          continue;
        }
        if (r >= 2 && r < 6) {
          if (du >= -2 && du < 2) return pane(spec, face, i, floor, r === 2, seed);
          if (du === -3 || du === 2) return faceColor(shutter, face);
        }
      }
      return r % 2 ? shade(fc, -0.06) : fc;
    });
    const rise = Math.round((by / 2) * 0.85);
    const ridge = roofPoint(c, ax / 2, by / 2);
    meta.beacon = { x: ridge.x, y: ridge.y - rise - 4 };
    meta.smoke = ridge;
    if (c.unfinished) return;
    const chimney = roofBox(c, ax - 9, 5, 4, 4, rise + 3, shade(BRICK, c.dead ? -0.5 : -0.1), DARK);
    gableRoof(c, rise, shingle, siding);
    meta.smoke = chimney;
  },

  // Art deco: stone piers between window bays, a setback upper storey, a
  // crown and a spire.
  deco(c, meta) {
    const { ax, by, h, k, spec, seed, base } = c;
    const stone = mix(base, [226, 212, 182], c.dead ? 0.15 : 0.6);
    const pier = shade(stone, 0.12);
    const gold = c.dead ? shade(stone, -0.2) : GOLD;
    const wall = (floorOff, cap, roof) => (face, u, v, fw, fh) => {
      if (face === 'top') return roof(u, v);
      const fc = faceColor(stone, face);
      const e = edge(face, u, v, fw, fh, fc);
      if (e) return e;
      if (v < cap) return faceColor(v === 1 ? gold : pier, face);
      const fv = v - cap, floor = floorOff + Math.floor(fv / k.floorH), r = fv % k.floorH;
      const fromBottom = spec.floors - 1 - floor;
      if (fromBottom === 0 && face === 'left' && Math.abs(u - fw / 2) < 4 && r >= 1) return r === 1 ? gold : shade(DARK, 0.1);
      if (u % 5 === 0 || u < 2 || u > fw - 3) return faceColor(pier, face);
      if (r === 0) return faceColor(shade(stone, -0.25), face);
      return pane(spec, face, Math.floor(u / 5), floor, r === 1, seed);
    };
    const rim = shade(pier, 0.1), fill = mix(ROOF, stone, 0.3);
    // The top third of a tall building is set back from the walls below.
    const nUp = !c.unfinished && spec.floors >= 6 ? Math.round(spec.floors * 0.35) : 0;
    let top = { x: c.ox, y: c.oy, w: ax, d: by };
    if (nUp) {
      const hUp = 3 + nUp * k.floorH, inset = 5;
      rasterBox(c.buf, c.ox, c.oy + hUp, ax, by, h - hUp, wall(nUp, 0, roofPaint(ax, by, rim, fill, seed)));
      top = { x: c.ox, y: c.oy + inset, w: ax - 2 * inset, d: by - 2 * inset };
      rasterBox(c.buf, top.x, top.y, top.w, top.d, hUp, wall(0, 3, roofPaint(top.w, top.d, rim, fill, seed)));
    } else {
      rasterBox(c.buf, c.ox, c.oy, ax, by, h, wall(0, 3, roofPaint(ax, by, rim, fill, seed)));
    }
    const centre = { x: top.x + (top.w - top.d) / 2, y: top.y + Math.round((top.w + top.d) / 4) };
    meta.smoke = centre;
    meta.beacon = { x: centre.x, y: centre.y - 3 };
    if (c.unfinished) return;
    // Crown, then a spire with an aviation light.
    const cw = top.w - 8, cd = top.d - 8;
    rasterBox(c.buf, top.x, top.y + 4 - 5, cw, cd, 5, (face, u, v, fw, fh) => {
      if (face === 'top') return pier;
      const fc = faceColor(pier, face);
      return edge(face, u, v, fw, fh, fc) || (v === 2 || u % 3 === 1 ? faceColor(gold, face) : fc);
    });
    const sx = Math.round(centre.x), sy = centre.y - 5;
    for (let i = 0; i < 14; i++) {
      c.buf.set(sx, sy - i, i < 9 ? gold : STEEL);
      if (i < 4) {
        c.buf.set(sx - 1, sy - i, shade(gold, 0.2));
        c.buf.set(sx + 1, sy - i, shade(gold, -0.3));
      }
    }
    meta.beacon = { x: sx, y: sy - 14 };
  },

  // Modern block: concrete floor slabs between continuous glass ribbons;
  // a solar or garden roof, or a helipad when it's tall.
  modern(c, meta) {
    const { ax, by, h, k, spec, seed, base } = c;
    const band = mix(base, [240, 240, 236], c.dead ? 0.2 : 0.72);
    const glass = mix(GLASS, base, 0.2);
    const plain = roofPaint(ax, by, shade(band, -0.1), mix(ROOF, band, 0.4), seed);
    const style = c.dead || c.unfinished ? 'plain' : spec.floors >= 8 ? 'helipad' : seed % 2 ? 'garden' : 'solar';
    const roof = (u, v) => {
      if (u < 2 || v < 2 || u > ax - 2 || v > by - 2 || style === 'plain') return plain(u, v);
      if (style === 'solar') {
        return Math.floor(v) % 6 < 4 && u > 4 && u < ax - 4 ? (Math.floor(u) % 4 === 0 ? shade(SOLAR, 0.25) : SOLAR) : plain(u, v);
      }
      if (style === 'garden') return hash2(Math.floor(u / 2), Math.floor(v / 2), seed) < 0.3 ? shade(GRASS, -0.18) : GRASS;
      const du = u - ax / 2, dv = v - by / 2, R = Math.min(ax, by) / 2 - 4;
      const ring = Math.abs(Math.hypot(du, dv) - R) < 0.9;
      const H = Math.abs(du) <= 3 && Math.abs(dv) <= 4 && (Math.abs(du) >= 2 || Math.abs(dv) < 1);
      return ring || H ? [236, 236, 230] : shade(ROOF, -0.25);
    };
    rasterBox(c.buf, c.ox, c.oy, ax, by, h, (face, u, v, fw, fh) => {
      if (face === 'top') return roof(u, v);
      const fc = faceColor(band, face);
      const e = edge(face, u, v, fw, fh, fc);
      if (e) return e;
      if (v < 3) return fc;
      const fv = v - 3, floor = Math.floor(fv / k.floorH), r = fv % k.floorH;
      const fromBottom = spec.floors - 1 - floor;
      if (r < 2) return r === 0 ? shade(fc, -0.12) : fc;
      if (fromBottom === 0 && face === 'left' && Math.abs(u - fw / 2) < 3) return shade(DARK, 0.2);
      if (u % 6 === 0) return shade(fc, -0.1);
      return pane(spec, face, Math.floor(u / 6), floor, r === 2, seed, glass);
    });
    if (style === 'garden') {
      const r = rng(seed + 9);
      for (let i = 0; i < 4; i++) {
        roofBox(c, Math.round(4 + r() * (ax - 10)), Math.round(4 + r() * (by - 10)), 3, 3, 3, shade(GRASS, -0.1), shade(GRASS, 0.15));
      }
    }
    meta.smoke = roofPoint(c, ax / 2, by / 2);
    meta.beacon = { ...roofPoint(c, 4, 4), y: roofPoint(c, 4, 4).y - 3 };
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

// --- landmarks -------------------------------------------------------------

/**
 * A box standing on the footprint at axis-pixel offset (du, dv), raised by
 * lift above the ground. Returns its top vertex and a mapper from roof
 * coordinates to sprite pixels.
 */
function tier(c, du, dv, w, d, hh, lift, paint) {
  const x = c.ox + (du - dv);
  const y = c.oy + c.h + Math.round((du + dv) / 2) - hh - lift;
  rasterBox(c.buf, x, y, w, d, hh, paint);
  return { x, y, at: (u, v) => ({ x: x + (u - v), y: y + Math.round((u + v) / 2) }) };
}

/** Window pane on a landmark: lit at random in proportion to health. */
function landmarkPane(c, face, col, floor, topRow, glassFc) {
  const side = face === 'right' ? 50 : 0;
  if (c.burning) return fireWindow(col, floor + side, topRow, c.seed);
  if (hash2(col, floor + side, c.seed) < c.spec.frac * 0.6) return topRow ? LIT_HI : LIT;
  return topRow ? faceColor(SHEEN, face) : glassFc;
}

/** Glass curtain wall: mullions every `mull` px, a slab every floor. */
function curtain(c, glass, frame, lift, mull = 4) {
  const fh = c.k.floorH;
  return (face, u, v, fw, faceH) => {
    const fr = faceColor(frame, face);
    const e = edge(face, u, v, fw, faceH, fr);
    if (e) return e;
    const above = lift + faceH - 1 - v;
    const floor = Math.floor(above / fh), r = above % fh;
    if (r === 0 || u % mull === 0) return shade(fr, -0.05);
    return landmarkPane(c, face, Math.floor(u / mull), floor, r === fh - 1, faceColor(glass, face));
  };
}

/** Neon trim colour: electric cyan with a hint of the neighborhood colour; dark when the target is. */
function neon(c) {
  if (c.burning) return hexToRgb('#ff5a3a');
  if (c.dead) return shade(DARK, 0.2);
  return mix([80, 236, 255], c.base, 0.25);
}

/** Half-ellipsoid dome over the point (cx, cy): radius R across, Rv tall. */
function dome(buf, cx, cy, R, Rv, color, rib) {
  for (let py = -Rv; py <= Math.ceil(R / 2); py++)
    for (let px = -R; px <= R; px++) {
      const q = py <= 0 ? (px * px) / (R * R) + (py * py) / (Rv * Rv) : (px * px) / (R * R) + (py * py) / ((R * R) / 4);
      if (q > 1) continue;
      let col = shade(color, 0.28 - (0.55 * (px + R)) / (2 * R));
      if (py <= 0 && rib && px % 6 === 0) col = rib;
      if (py > 0) col = shade(col, -0.2);
      if (Math.hypot(px + R / 3, py + Rv / 2) < R / 6) col = shade(col, 0.35); // highlight
      buf.set(cx + px, cy + py, col);
    }
}

/** A thin mast from (x, y) upward, with a status beacon on top. */
function mast(c, meta, x, y, len, color = STEEL) {
  for (let i = 1; i <= len; i++) c.buf.set(x, y - i, i > len - 3 ? shade(color, 0.3) : shade(color, -0.25));
  meta.beacon = { x, y: y - len - 1 };
}

/** Crenellations along a box's top edges, back edges first. */
function merlons(c, du, dv, w, d, lift, color) {
  const box = (u, v) => tier(c, du + u, dv + v, 3, 3, 3, lift, (face, uu, vv, fw, fh) =>
    face === 'top' ? shade(color, 0.12) : edge(face, uu, vv, fw, fh, faceColor(color, face)) || faceColor(color, face));
  for (let u = 0; u + 3 <= w; u += 6) box(u, 0);
  for (let v = 6; v + 3 <= d; v += 6) box(0, v);
  for (let v = 6; v + 3 <= d; v += 6) box(w - 3, v);
  for (let u = 0; u + 3 <= w; u += 6) box(u, d - 3);
}

const LANDMARK_BUILDERS = {
  // A supertall glass tower in four setbacks, with a glowing crown and spire.
  skyscraper(c, meta) {
    const { ax, by, seed, base } = c;
    const frame = mix(base, CONCRETE, c.dead ? 0.2 : 0.55);
    const glass = mix(GLASS, base, 0.3);
    const glow = neon(c);
    const tiers = [[0, 0, 20], [10, 20, 120], [17, 140, 38], [23, 178, 22]];
    let top;
    for (const [inset, lift, hh] of tiers) {
      const w = ax - 2 * inset, d = by - 2 * inset;
      const roof = roofPaint(w, d, shade(frame, 0.12), mix(ROOF, frame, 0.3), seed);
      const wall = curtain(c, inset ? glass : shade(glass, 0.08), frame, lift, inset ? 4 : 6);
      const crown = lift === 178;
      top = tier(c, inset, inset, w, d, hh, lift, (face, u, v, fw, fh) => {
        if (face === 'top') return roof(u, v);
        if (crown && v >= 3 && v < 7 && !edge(face, u, v, fw, fh, frame)) return faceColor(glow, face);
        return wall(face, u, v, fw, fh);
      });
      top.w = w;
      top.d = d;
    }
    const peak = top.at(top.w / 2, top.d / 2);
    meta.smoke = peak;
    if (c.unfinished) return (meta.beacon = { x: peak.x, y: peak.y - 3 });
    roofBox({ ...c, ox: top.x, oy: top.y }, 6, 6, top.w - 12, top.d - 12, 6, frame, glow);
    mast(c, meta, peak.x, peak.y - 6, 32);
  },

  // Twin glass towers joined by a sky bridge.
  twins(c, meta) {
    const { ax, by, seed, base } = c;
    const frame = mix(base, CONCRETE, c.dead ? 0.2 : 0.5);
    const glass = mix(GLASS, base, 0.25);
    const paving = mix(CONCRETE, base, 0.1);
    tier(c, 0, 0, ax, by, 6, 0, (face, u, v, fw, fh) =>
      face === 'top' ? (Math.floor(u / 8) + Math.floor(v / 8)) % 2 ? paving : shade(paving, -0.06) : faceColor(shade(paving, -0.15), face));
    const tower = (du, tall) => {
      const hh = tall - 6, w = 30;
      const t = tier(c, du, 29, w, w, hh, 6, (face, u, v, fw, fh) =>
        face === 'top' ? roofPaint(w, w, shade(frame, 0.1), mix(ROOF, frame, 0.3), seed)(u, v) : curtain(c, glass, frame, 6)(face, u, v, fw, fh));
      const cap = tier(c, du + 6, 35, w - 12, w - 12, 10, tall, (face, u, v, fw, fh) =>
        face === 'top' ? shade(frame, 0.15) : edge(face, u, v, fw, fh, faceColor(frame, face)) || faceColor(u % 3 ? frame : shade(frame, -0.15), face));
      return { t, cap };
    };
    const a = tower(8, 186);
    // Sky bridge two thirds of the way up, between the towers' facing walls.
    tier(c, 38, 37, 12, 12, 8, 120, (face, u, v, fw, fh) => {
      if (face === 'top') return shade(frame, 0.1);
      const fc = faceColor(frame, face);
      return edge(face, u, v, fw, fh, fc) || (v >= 2 && v < 6 ? landmarkPane(c, face, u >> 1, 99, v === 2, faceColor(glass, face)) : fc);
    });
    const b = tower(50, 176);
    meta.smoke = a.t.at(15, 15);
    if (c.unfinished) return (meta.beacon = { ...a.cap.at(9, 9) });
    const pb = b.cap.at(9, 9);
    for (let i = 1; i <= 14; i++) c.buf.set(pb.x, pb.y - i, shade(STEEL, -0.25));
    const pa = a.cap.at(9, 9);
    mast(c, meta, pa.x, pa.y, 22);
  },

  // A domed, colonnaded hall with a portico, a drum and a gilded lantern.
  capitol(c, meta) {
    const { ax, by, seed, base } = c;
    const marble = mix([236, 230, 216], base, c.dead ? 0.35 : 0.08);
    const shadow = shade(marble, -0.38);
    const gold = c.dead ? shade(marble, -0.25) : GOLD;
    const colonnade = (lift) => (face, u, v, fw, fh) => {
      if (face === 'top') return roofPaint(fw, fh, shade(marble, 0.05), mix(ROOF, marble, 0.55), seed)(u, v);
      const fc = faceColor(marble, face);
      const e = edge(face, u, v, fw, fh, fc);
      if (e) return e;
      if (v < 5) return v === 2 ? faceColor(gold, face) : fc; // entablature
      if (v >= fh - 3) return shade(fc, -0.08); // plinth
      const r = u % 7;
      if (r === 0 || r === 6) return shade(fc, -0.1);
      if (r <= 2) return fc; // column
      // Tall windows in the shadows between the columns.
      if (v > 8 && v < fh - 6) return landmarkPane(c, face, Math.floor(u / 7), Math.floor((fh - v) / 12) + lift, v === 9, faceColor(shadow, face));
      return faceColor(shadow, face);
    };
    tier(c, 0, 0, ax, by, 4, 0, (face, u, v) => (face === 'top' ? shade(marble, -0.08) : faceColor(shade(marble, -0.2 - v * 0.04), face)));
    tier(c, 6, 6, ax - 12, by - 12, 32, 4, colonnade(0));
    // A portico projecting from the front-left wall.
    tier(c, 26, by - 6, 36, 6, 26, 4, colonnade(0));
    const drum = tier(c, 26, 26, 36, 36, 16, 36, colonnade(4));
    const top = drum.at(18, 18);
    meta.smoke = roofPoint(c, ax / 2, by / 2);
    const domeColor = c.burning ? SOOT : mix(base, [200, 214, 206], c.dead ? 0.6 : 0.25);
    dome(c.buf, top.x, top.y, 22, 28, domeColor, shade(domeColor, -0.18));
    // Lantern and flagpole.
    roofBox({ ...c, ox: top.x, oy: top.y - 28 + 3 }, -3, -3, 6, 6, 6, gold, shade(gold, 0.2));
    if (c.unfinished) return (meta.beacon = { x: top.x, y: top.y - 34 });
    const fy = top.y - 34;
    mast(c, meta, top.x, fy, 14);
    const flag = c.dead ? shade(base, -0.4) : base;
    for (let j = 0; j < 5; j++) for (let i = 1; i <= 7; i++) c.buf.set(top.x + i, fy - 13 + j + (i > 4 ? 1 : 0), shade(flag, j === 0 ? 0.2 : 0));
  },

  // A tapering obelisk of dark glass laced with neon, ringed by halos, with
  // an orb hovering over its tip.
  pylon(c, meta) {
    const { ax, by, seed, base } = c;
    const body = mix(DARK, base, 0.22);
    const glow = neon(c);
    const segs = 14, segH = 12;
    const cx = c.ox, cy0 = c.oy + c.h + Math.round((ax + by) / 4);
    // Plinth in two steps, a neon line round each.
    tier(c, 0, 0, ax, by, 8, 0, (face, u, v, fw, fh) => {
      if (face === 'top') return u < 2 || v < 2 || u > ax - 2 || v > by - 2 ? glow : hash2(u >> 3, v >> 3, seed) < 0.5 ? body : shade(body, 0.06);
      return v === 2 ? glow : faceColor(shade(body, -0.1), face);
    });
    tier(c, 14, 14, ax - 28, by - 28, 10, 8, (face, u, v, fw, fh) => (face === 'top' ? shade(body, 0.05) : v === 3 ? glow : faceColor(body, face)));
    const halo = (lift, rx, front) => {
      const y = cy0 - lift;
      for (let t = 0; t < 360; t += 1.5) {
        const a = (t * Math.PI) / 180;
        if (Math.sin(a) > 0 !== front) continue;
        c.buf.set(cx + Math.round(Math.cos(a) * rx), y + Math.round(Math.sin(a) * rx * 0.5), front ? glow : shade(glow, -0.35));
      }
    };
    const halos = c.unfinished ? [] : [[70, 30], [130, 22]];
    for (const [l, r] of halos) halo(l, r, false);
    meta.fire = [];
    for (let i = 0; i < segs; i++) {
      const w = Math.round(34 - i * 2), du = (ax - w) / 2, lift = 18 + i * segH;
      const lit = !c.dead && hash2(i, 7, seed) < c.spec.frac + 0.1;
      tier(c, du, du, w, w, segH, lift, (face, u, v, fw, fh) => {
        if (face === 'top') return shade(body, 0.1);
        const fc = faceColor(body, face);
        if (u === 0 || u === fw - 1) return shade(fc, face === 'left' && u === fw - 1 ? 0.25 : -0.3);
        if (v === 0 || Math.abs(u - fw / 2) < 1) return lit ? faceColor(glow, face) : shade(fc, 0.1);
        return hash2(u, v + i * segH, seed) < 0.04 ? shade(fc, 0.15) : fc;
      });
      if (i % 4 === 1) meta.fire.push({ x: cx + (i % 8 === 1 ? -6 : 6), y: cy0 - lift - 4, roof: i > 8 });
    }
    for (const [l, r] of halos) halo(l, r, true);
    // Tip, then the orb.
    const tipY = cy0 - 18 - segs * segH - Math.round((34 - segs * 2) / 2);
    for (let i = 0; i < 10; i++) for (let x = -Math.floor((10 - i) / 3); x <= Math.floor((10 - i) / 3); x++) c.buf.set(cx + x, tipY - i, x ? body : glow);
    meta.smoke = { x: cx, y: tipY };
    const oy = tipY - 22;
    if (!c.unfinished)
      for (let y = -7; y <= 7; y++)
        for (let x = -7; x <= 7; x++) {
          const r = Math.hypot(x, y);
          if (r <= 7) c.buf.set(cx + x, oy + y, r < 3 ? [255, 255, 255] : shade(glow, (r < 5 ? 0.3 : 0) - (x + 7) * 0.02));
        }
    meta.beacon = { x: cx, y: oy - 9 };
    meta.fire.push({ x: cx, y: tipY, roof: true });
  },

  // A castle: curtain walls with a gatehouse, corner towers with pointed
  // roofs in the neighborhood colour, and a keep flying a banner.
  fortress(c, meta) {
    const { ax, by, seed, base } = c;
    const stone = mix([150, 146, 138], base, c.dead ? 0.05 : 0.12);
    const roofCol = c.burning ? SOOT : c.dead ? shade(base, -0.45) : shade(base, -0.05);
    const block = (face, u, v, fw, fh, lift, slits) => {
      if (face === 'top') return hash2(u >> 2, v >> 2, seed) < 0.3 ? shade(stone, -0.04) : shade(stone, 0.06);
      const fc = faceColor(stone, face);
      const e = edge(face, u, v, fw, fh, fc);
      if (e) return e;
      const above = lift + fh - 1 - v;
      if (slits && Math.abs(u - fw / 2) < 1 && above % c.k.floorH >= 3 && above % c.k.floorH < 7 && above > 8)
        return landmarkPane(c, face, Math.round(u), Math.floor(above / c.k.floorH), above % c.k.floorH === 6, faceColor(DARK, face));
      // Courses of stone.
      if (above % 4 === 0) return shade(fc, -0.08);
      return (u + (Math.floor(above / 4) % 2) * 3) % 6 === 0 ? shade(fc, -0.06) : fc;
    };
    const wallH = 30, towerH = 52, T = 18, W = 6;
    const towerAt = (du, dv) => {
      tier(c, du, dv, T, T, towerH, 0, (f, u, v, fw, fh) => block(f, u, v, fw, fh, 0, true));
      // Pointed roof, in slices.
      for (let i = 0; i < 16; i++) {
        const inset = Math.round((i * (T + 4)) / 32) - 2;
        if (T - 2 * inset < 2) break;
        tier(c, du + inset, dv + inset, T - 2 * inset, T - 2 * inset, 1, towerH + i, (face, u, v) =>
          face === 'top' ? shade(roofCol, 0.15) : faceColor(i % 2 ? roofCol : shade(roofCol, -0.1), face));
      }
    };
    const wall = (du, dv, w, d, gate) =>
      tier(c, du, dv, w, d, wallH, 0, (f, u, v, fw, fh) => {
        if (gate && f === 'left' && Math.abs(u - fw / 2) < 6 && v > 10) {
          // Gatehouse arch with a portcullis.
          const r = Math.abs(u - fw / 2);
          if (v > 10 + Math.round(r * r / 9)) return (u + v) % 3 === 0 && !c.dead ? shade(IRON, 0.3) : DARK;
        }
        return block(f, u, v, fw, fh, 0, false);
      });
    towerAt(0, 0);
    wall(T, 2, ax - 2 * T, W);
    wall(2, T, W, by - 2 * T);
    merlons(c, T, 2, ax - 2 * T, W, wallH, stone);
    merlons(c, 2, T, W, by - 2 * T, wallH, stone);
    towerAt(ax - T, 0);
    towerAt(0, by - T);
    // The keep.
    const K = 36, kh = 70, kd = (ax - K) / 2;
    const keep = tier(c, kd, kd, K, K, kh, 0, (f, u, v, fw, fh) => block(f, u, v, fw, fh, 0, true));
    merlons(c, kd, kd, K, K, kh, stone);
    wall(T, by - W - 2, ax - 2 * T, W, true);
    wall(ax - W - 2, T, W, by - 2 * T);
    merlons(c, T, by - W - 2, ax - 2 * T, W, wallH, stone);
    merlons(c, ax - W - 2, T, W, by - 2 * T, wallH, stone);
    towerAt(ax - T, by - T);
    const kt = keep.at(K / 2, K / 2);
    meta.smoke = kt;
    meta.fire = [{ ...kt, roof: true }, { ...keep.at(8, 26), roof: true }, { ...roofPoint(c, ax / 2, by - 10), y: roofPoint(c, ax / 2, by - 10).y + 6, roof: false }];
    if (c.unfinished) return (meta.beacon = { x: kt.x, y: kt.y - 4 });
    mast(c, meta, kt.x, kt.y - 3, 24, WOOD);
    const flag = c.dead ? shade(base, -0.4) : base;
    for (let j = 0; j < 7; j++)
      for (let i = 1; i <= 12 - (j === 3 ? 0 : Math.abs(j - 3)); i++) c.buf.set(kt.x + i, kt.y - 26 + j + (i >> 2), shade(flag, j < 2 ? 0.15 : 0));
  },

  // A stepped megastructure: terraces of glass ribbon and roof gardens, a
  // greenhouse dome on top.
  arcology(c, meta) {
    const { ax, by, seed, base } = c;
    const band = mix(base, [240, 240, 236], c.dead ? 0.2 : 0.7);
    const glass = mix(GLASS, base, 0.2);
    const green = c.burning ? SOOT : c.dead ? mix(GRASS, [110, 110, 115], 0.5) : GRASS;
    const steps = 4, rise = 30, step = 10;
    const gardens = [];
    for (let i = 0; i < steps; i++) {
      const inset = i * step, w = ax - 2 * inset, d = by - 2 * inset, lift = i * rise;
      const t = tier(c, inset, inset, w, d, rise, lift, (face, u, v, fw, fh) => {
        if (face === 'top') {
          if (u < 1.5 || v < 1.5 || u > fw - 1.5 || v > fh - 1.5) return shade(band, -0.1);
          return hash2(u >> 1, v >> 1, seed + i) < 0.25 ? shade(green, -0.15) : green;
        }
        const fc = faceColor(band, face);
        const e = edge(face, u, v, fw, fh, fc);
        if (e) return e;
        const above = lift + fh - 1 - v, r = above % c.k.floorH;
        if (r < 2) return r === 0 ? shade(fc, -0.12) : fc;
        if (u % 7 === 0) return shade(fc, -0.1);
        return landmarkPane(c, face, Math.floor(u / 7), Math.floor(above / c.k.floorH), r === c.k.floorH - 1, faceColor(glass, face));
      });
      // Trees along the exposed front edges of this terrace's garden.
      if (i < steps - 1)
        for (let k = 0; k < 6; k++) {
          const along = Math.round(4 + hash2(k, i, seed) * (w - 10));
          gardens.push(k % 2 ? t.at(w - 5, along) : t.at(along, d - 5));
        }
    }
    for (const g of gardens.sort((p, q) => p.y - q.y)) {
      for (let y = -4; y <= 0; y++) for (let x = -2; x <= 2; x++) if (Math.abs(x) + Math.abs(y + 2) <= 3) c.buf.set(g.x + x, g.y + y, shade(green, -0.05 + (y + 4) * -0.05 + (x < 0 ? 0.1 : 0)));
    }
    const top = roofPoint(c, ax / 2, by / 2);
    meta.smoke = top;
    if (c.unfinished) return (meta.beacon = { x: top.x, y: top.y - 3 });
    const domeColor = c.dead ? shade(SHEEN, -0.3) : mix(SHEEN, [190, 240, 255], 0.35);
    dome(c.buf, top.x, top.y, 16, 18, domeColor, shade(domeColor, 0.3));
    mast(c, meta, top.x, top.y - 18, 12);
  },
};
Object.assign(BUILDERS, LANDMARK_BUILDERS);

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
  ][variant === 5 ? 2 : variant % 3];
  // Shadow on the ground.
  const sw = variant === 6 ? 4 : 5;
  for (let x = -sw; x <= sw; x++) for (let y = -1; y <= 1; y++) if (x * x / (sw * sw) + y * y / 2 <= 1) buf.set(8 + x + 2, 21 + y, [0, 0, 0], 60);
  const stem = () => {
    for (let y = 15; y < 22; y++) {
      buf.set(7, y, trunk);
      buf.set(8, y, shade(trunk, -0.25));
    }
  };
  if (variant === 2 || variant === 5) {
    // Pine: stacked triangles; the snowy one carries snow on each tier.
    stem();
    const snow = hexToRgb('#f4f8fb'), snowShade = hexToRgb('#cad8e4');
    for (let y = 0; y < 17; y++) {
      const w = Math.floor((y % 6) * 0.8 + y * 0.25) + 1;
      for (let x = -w; x <= w; x++) {
        let c = x < -w / 3 ? greens[2] : x > w / 3 ? greens[1] : greens[0];
        if (hash2(x, y, 3) < 0.15) c = greens[1];
        if (variant === 5 && (y % 6 < 2 || (x < 0 && hash2(x, y, 4) < 0.35))) c = x > w / 3 ? snowShade : snow;
        buf.set(8 + x, y + 1, c);
      }
    }
  } else if (variant === 3) {
    // Palm: a leaning, ringed trunk under a crown of drooping fronds.
    const bark = hexToRgb('#8a6a44');
    for (let y = 8; y < 22; y++) {
      const x = 8 + Math.round(((21 - y) / 13) ** 2 * 2.5);
      buf.set(x, y, y % 3 === 0 ? shade(bark, -0.3) : bark);
      buf.set(x + 1, y, shade(bark, -0.2));
    }
    const leaf = hexToRgb('#3f9a3a'), leafDark = hexToRgb('#2c7430'), leafLight = hexToRgb('#6cc24f');
    for (const [dx, lift] of [[-7, 2], [-4, 4], [0, 5], [4, 4], [7, 2], [-2, 3], [3, 3]]) {
      for (let k = 0; k <= 10; k++) {
        const t = k / 10;
        const x = 10.5 + dx * t, y = 7 - lift * Math.sin(t * Math.PI * 0.7) + t * t * 6;
        buf.set(Math.round(x), Math.round(y), t < 0.4 ? leafLight : dx > 0 ? leafDark : leaf);
        if (t > 0.2 && t < 0.8) buf.set(Math.round(x), Math.round(y) + 1, leafDark);
      }
    }
    buf.set(10, 8, hexToRgb('#5a3c22'));
    buf.set(11, 9, hexToRgb('#5a3c22'));
  } else if (variant === 4) {
    // Saguaro cactus with two arms.
    const g = hexToRgb('#4f8a3f'), gd = hexToRgb('#3b6e30'), gl = hexToRgb('#73ad57');
    const col = (x, y0, y1) => {
      for (let y = y0; y <= y1; y++) {
        buf.set(x - 1, y, gl);
        buf.set(x, y, g);
        buf.set(x + 1, y, gd);
      }
    };
    col(8, 5, 21);
    col(4, 9, 14);
    for (let x = 4; x <= 7; x++) for (const y of [14, 15]) buf.set(x, y, y === 14 ? g : gd);
    col(12, 7, 12);
    for (let x = 9; x <= 12; x++) for (const y of [12, 13]) buf.set(x, y, y === 12 ? g : gd);
    for (const [x, y] of [[8, 4], [4, 8], [12, 6]]) buf.set(x, y, g);
    for (let y = 7; y < 21; y += 3) buf.set(7, y, hexToRgb('#e8e2c0'));
  } else if (variant === 6) {
    // Dry desert shrub: a low tangle of olive and brown twigs.
    const cs = [hexToRgb('#8a7a45'), hexToRgb('#6f6236'), hexToRgb('#a8975a'), hexToRgb('#7a5a3a')];
    for (let y = 13; y < 22; y++)
      for (let x = -5; x <= 5; x++) {
        const dx = x / 5.5, dy = (y - 18) / 4.5;
        if (dx * dx + dy * dy > 1 - hash2(x, y, 6) * 0.35) continue;
        if (hash2(x, y, 8) < 0.2) continue;
        buf.set(8 + x, y, cs[(hash2(x, y, 7) * 4) | 0]);
      }
  } else {
    stem();
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

// --- mountains -------------------------------------------------------------

const mountainCache = new Map();
// Mountain styles. snowLine is the fraction of the height above which a
// peak at least snowMin pixels tall is white; mesas are flat-topped and banded.
const hex = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, typeof v === 'string' ? hexToRgb(v) : v]));
const MTN = {
  alpine: hex({ rock: '#857868', rockHi: '#a69885', snow: '#eef3f7', snowShade: '#bccbd9', veg: '#6a8a3f', vegDark: '#566f33', snowLine: 0.6, snowMin: 55 }),
  snowy: hex({ rock: '#868c97', rockHi: '#a7adb8', snow: '#f2f6fa', snowShade: '#c4d1de', veg: '#dfe7ef', vegDark: '#c6d2de', snowLine: 0.32, snowMin: 0 }),
  mesa: hex({ rock: '#b0623a', rockHi: '#cf7f4c', cap: '#c99059', veg: '#a85d37', vegDark: '#8f4c2c', snowLine: 2, snowMin: 999, flat: 0.8 }),
};

/**
 * A mountain over a round footprint of radius r tiles, peaking h pixels up.
 * Drawn as a heightfield, back to front, lit like the buildings (from the
 * front-left), with snow above the treeline on tall peaks. cx, cy is the
 * centre of the footprint. Its lowest band is left out so it rises straight
 * out of whatever ground it stands on.
 */
export function mountainSprite(r, h, seed, styleName = 'alpine') {
  const k = `${styleName}|${r.toFixed(2)}|${h}|${seed}`;
  const st = MTN[styleName] || MTN.alpine;
  if (mountainCache.has(k)) return mountainCache.get(k);
  const rx = r * AX * Math.SQRT2, ry = rx / 2;
  const W = Math.ceil(rx * 2) + 4, cx = W / 2, cy = h + 4;
  const buf = new PixBuf(W, Math.ceil(cy + ry) + 3);
  const rnd = rng(seed);
  // Value noise over the footprint, for ridges and a ragged outline.
  const noise = (x, y, s) => {
    const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j;
    const sm = (t) => t * t * (3 - 2 * t);
    const a = hash2(i, j, s), b = hash2(i + 1, j, s), c = hash2(i, j + 1, s), d = hash2(i + 1, j + 1, s);
    return (a + (b - a) * sm(u)) * (1 - sm(v)) + (c + (d - c) * sm(u)) * sm(v);
  };
  const s1 = (rnd() * 1e6) | 0, s2 = s1 + 1;
  const px = (rnd() - 0.5) * r * 0.4, py = (rnd() - 0.5) * r * 0.4; // summit, off-centre
  const height = (x, y) => {
    const ang = Math.atan2(y, x);
    const edge = r * (0.86 + 0.14 * noise(Math.cos(ang) * 2 + 5, Math.sin(ang) * 2 + 5, s2));
    if (Math.hypot(x, y) >= edge) return 0;
    // Distance to the summit, scaled so the slope still ends at the edge.
    const dx = x - px, dy = y - py;
    const reach = edge - (px * Math.cos(Math.atan2(dy, dx)) + py * Math.sin(Math.atan2(dy, dx)));
    const t = Math.min(1, Math.hypot(dx, dy) / Math.max(0.5, reach));
    const ridged = 1 - Math.abs(2 * noise(x * 1.3 + 9, y * 1.3 + 9, s1) - 1);
    // A mesa: steep sides cut off by a flat top.
    if (st.flat) return (h * Math.min(st.flat, Math.pow(1 - t, 0.45) * (0.92 + 0.12 * ridged))) / st.flat;
    return h * Math.pow(1 - t, 1.1) * (0.78 + 0.32 * ridged);
  };
  const L = [0.25, 0.75, 0.6];
  const Ln = Math.hypot(...L);
  const tall = h >= st.snowMin;
  const step = 1 / 24, N = Math.ceil((2 * r) / step);
  const filled = new Uint8Array(buf.w * buf.h);
  // Diagonals of the sample grid, back (small x + y) to front.
  for (let sum = 0; sum <= 2 * N; sum++) {
    for (let i = Math.max(0, sum - N); i <= Math.min(N, sum); i++) {
      const x = -r + i * step, y = -r + (sum - i) * step;
      const z = height(x, y);
      if (z <= 0) continue;
      const nx = height(x - step, y) - height(x + step, y), ny = height(x, y - step) - height(x, y + step);
      // Normal of the surface in pixel units (one tile is AX pixels across).
      const nz = 2 * step * AX;
      const lum = (nx * L[0] + ny * L[1] + nz * L[2]) / (Math.hypot(nx, ny, nz) * Ln);
      const f = z / h, wob = noise(x * 3, y * 3, s2) * 0.12;
      if (f < 0.05) continue;
      let c;
      if (tall && f > st.snowLine + wob) c = lum > 0.55 ? st.snow : st.snowShade;
      else if (st.flat && f > 0.98) c = st.cap;
      else if (f < 0.2 + wob) c = lum > 0.5 ? st.veg : st.vegDark;
      else c = lum > 0.75 ? st.rockHi : lum > 0.45 ? st.rock : shade(st.rock, lum > 0.25 ? -0.22 : -0.4);
      // Sandstone strata.
      if (st.flat && f < 0.98 && Math.floor(f * 7) % 2) c = shade(c, -0.12);
      const sx = Math.round(cx + (x - y) * AX), sy = Math.round(cy + (x + y) * (AX / 2) - z);
      // A short column under each sample closes the gaps between samples;
      // anything it covers is hidden behind this slope anyway.
      for (let dy = 0; dy < 5; dy++) {
        buf.set(sx, sy + dy, c);
        if (sy + dy >= 0 && sy + dy < buf.h) filled[(sy + dy) * buf.w + sx] = 1;
      }
    }
  }
  // Darken the skyline for a crisp 16-bit silhouette.
  for (let y = 1; y < buf.h; y++)
    for (let x = 0; x < buf.w; x++) {
      const i = (y * buf.w + x) * 4;
      if (filled[y * buf.w + x] && !filled[(y - 1) * buf.w + x] && y < cy) {
        const c = [buf.data[i], buf.data[i + 1], buf.data[i + 2]];
        buf.set(x, y, shade(c, -0.3));
      }
    }
  const s = { canvas: buf.toCanvas(), cx: Math.round(cx), cy };
  mountainCache.set(k, s);
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
