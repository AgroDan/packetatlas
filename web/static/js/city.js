// City layout: grows neighborhoods into an organic cluster of blocks around a
// river and the odd lake or park, lays roads around the blocks, and renders
// the ground into one canvas.

import { PixBuf, rasterBox, hexToRgb, mix, shade, hash2, rng, strHash, AX } from './pixel.js';

export const BLOCK = 8; // road every BLOCK tiles; 7x7 block interior
const MARGIN = 5; // grass ring around the city
const LOT = 3; // lot size in tiles; 4 lots per block
// Neighborhoods smaller than this share blocks with others, one lot each,
// instead of each claiming a whole (mostly empty) block.
const SHARE_BELOW = 4;
// Lot sets (0 TL, 1 TR, 2 BL, 3 BR) a small neighborhood may take in a shared
// block, by size: always edge-connected, never diagonal.
const SHAPES = {
  1: [[0], [1], [2], [3]],
  2: [[0, 1], [2, 3], [0, 2], [1, 3]],
  3: [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]],
};
const EDGE_H = 14; // depth of the dirt cliff under the map
const WS = 2; // water field samples per tile

export const T = { GRASS: 0, ROAD: 1, LOT: 2, PARK: 3, PLAZA: 4, ROCK: 5 };
// What occupies a block-sized cell of the layout grid.
const K = { EMPTY: 0, LOTS: 1, PARK: 2, LAKE: 3, RIVER: 4, MOUNTAIN: 5 };

const DIRS = [
  [0, -1], // 0: -y (screen NE)
  [1, 0], //  1: +x (screen SE)
  [0, 1], //  2: +y (screen SW)
  [-1, 0], // 3: -x (screen NW)
];

const PALETTE = ['#4f7cc4', '#9a62c9', '#d08a3a', '#4fa36b', '#c95b6b', '#3fa6a6', '#b8a23a', '#7a7fd1'];

const C = {
  grass: hexToRgb('#5c9a45'),
  grassDark: hexToRgb('#4f8a3c'),
  grassLight: hexToRgb('#6dab52'),
  // Drier country across the river, where outside services live.
  farGrass: hexToRgb('#7f9a48'),
  farGrassDark: hexToRgb('#6e8a3d'),
  farGrassLight: hexToRgb('#94ad56'),
  scree: hexToRgb('#7a7268'),
  screeDark: hexToRgb('#625b53'),
  park: hexToRgb('#66a84c'),
  parkStripe: hexToRgb('#5d9f44'),
  asphalt: hexToRgb('#4a4c56'),
  asphaltDark: hexToRgb('#42444d'),
  curb: hexToRgb('#bdb7aa'),
  curbEdge: hexToRgb('#8e897e'),
  rail: hexToRgb('#d9d2c2'),
  railEdge: hexToRgb('#6e6458'),
  dash: hexToRgb('#e9d46c'),
  plaza: hexToRgb('#cdc8bb'),
  seam: hexToRgb('#b3ad9f'),
  dirt: hexToRgb('#8a5a36'),
  dirtDark: hexToRgb('#6b4228'),
  rock: hexToRgb('#5d4a3d'),
  bank: hexToRgb('#b9a874'),
  bankDark: hexToRgb('#9c8c5c'),
  shallow: hexToRgb('#5ea7d6'),
  water: hexToRgb('#3f87c2'),
  deep: hexToRgb('#336fa6'),
  glint: hexToRgb('#b4dcf3'),
  foam: hexToRgb('#e4f2fa'),
};

const key = (x, y) => `${x},${y}`;

export class City {
  constructor(neighborhoods, targets) {
    this.neighborhoods = neighborhoods.map((d, i) => ({
      name: d.name,
      color: d.color || PALETTE[i % PALETTE.length],
      kind: d.kind,
      outside: !!d.outside,
      targets: targets.filter((t) => t.neighborhood === d.name),
    }));
    // With services both inside and outside the environment (Docker host or
    // cluster), the river becomes a border: outside neighborhoods sit on the
    // far bank, behind a mountain ridge, reached by one road over a pass.
    this.split = this.neighborhoods.some((d) => d.outside) && this.neighborhoods.some((d) => !d.outside);
    // Seeded by neighborhood names only, so the river and lakes stay put as
    // targets come and go.
    this.seed = strHash(this.neighborhoods.map((d) => d.name).join('|'));
    this.layout();
    this.buildRoads();
    this.buildWater();
    this.buildTiles();
    this.placeBuildings();
    this.placeMountains();
    this.placeTrees();
    this.bfsCache = new Map();
  }

  // --- layout -------------------------------------------------------------

  layout() {
    const r = rng(this.seed);

    // Big neighborhoods get whole blocks; small ones are first-fit into
    // shared blocks. Inside and outside neighborhoods never share one.
    const pack = (hoods) => {
      const items = []; // { nb: blocks wanted, members: [neighborhood] }
      let shared = [];
      for (const d of hoods) {
        const n = Math.max(1, d.targets.length);
        if (n >= SHARE_BELOW) {
          items.push({ nb: Math.ceil(n / 4), members: [d] });
          continue;
        }
        const fits = (b) => SHAPES[n].find((shape) => shape.every((q) => !b.used.has(q)));
        let blk = shared.find(fits);
        if (!blk) {
          blk = { nb: 1, members: [], used: new Set() };
          shared.push(blk);
          items.push(blk);
        }
        d.shape = fits(blk);
        for (const q of d.shape) blk.used.add(q);
        blk.members.push(d);
        shared = shared.filter((b) => b.used.size < 4);
      }
      return items;
    };
    const split = this.split;
    const inner = pack(this.neighborhoods.filter((d) => !split || !d.outside));
    const outer = split ? pack(this.neighborhoods.filter((d) => d.outside)) : [];
    const items = [...inner, ...outer];
    const blocks = (list) => list.reduce((s, it) => s + it.nb, 0);

    // Everything below works on an unbounded grid of block-sized cells
    // centred on (0, 0), normalised to the map at the end. The city proper
    // (inside neighborhoods) grows around the centre.
    const total = blocks(inner);
    const R = Math.sqrt(total / Math.PI); // radius of a disc of `total` cells
    const span = Math.ceil(Math.max(R, Math.sqrt(blocks(outer) / Math.PI))) + 3;
    const reserved = new Map(); // key → K.RIVER | K.LAKE | K.PARK
    const nearKind = (x, y, kinds, diag = false) => {
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          if (!diag && dx && dy) continue;
          if (kinds.includes(reserved.get(key(x + dx, y + dy)))) return true;
        }
      return false;
    };

    // River: a meandering chain of cells across the whole grid. Big cities
    // get it through the middle; small ones have it flowing alongside.
    const axis = r() < 0.5 ? 0 : 1; // 0 flows along +y, 1 along +x
    const side = r() < 0.5 ? -1 : 1;
    const at = (a, c) => (axis === 0 ? [c, a] : [a, c]);
    // Cells from one end of the grid to the other, wandering between
    // cross-axis positions lo..hi starting at c.
    const meander = (lo, hi, c) => {
      const out = [];
      for (let a = -span; a <= span; a++) {
        out.push(at(a, c));
        if (a < span && r() < 0.4) {
          let s = r() < 0.5 ? -1 : 1;
          if (c + s < lo || c + s > hi) s = -s;
          if (c + s >= lo && c + s <= hi) {
            c += s;
            out.push(at(a, c));
          }
        }
      }
      for (const [x, y] of out) reserved.set(key(x, y), K.RIVER);
      return out;
    };
    const mid = Math.max(1, Math.floor(R * 0.6));
    let river = total >= 6 && !split ? meander(-mid, mid, Math.round((r() - 0.5) * 2 * mid)) : [];

    // A lake (two cells in big cities) and a park, part way out from the
    // centre so the city grows around them.
    const spot = (kind, d0, d1) => {
      for (let tries = 0; tries < 40; tries++) {
        const ang = r() * Math.PI * 2, dist = R * (d0 + r() * (d1 - d0));
        const x = Math.round(Math.cos(ang) * dist), y = Math.round(Math.sin(ang) * dist);
        if (reserved.has(key(x, y)) || nearKind(x, y, [K.RIVER, K.LAKE], true)) continue;
        reserved.set(key(x, y), kind);
        return [x, y];
      }
      return null;
    };
    const lake = total >= 4 ? spot(K.LAKE, 0.45, 0.85) : null;
    if (lake && total >= 14) {
      const [dx, dy] = DIRS[(r() * 4) | 0];
      const [x, y] = [lake[0] + dx, lake[1] + dy];
      if (!reserved.has(key(x, y)) && !nearKind(x, y, [K.RIVER], true)) reserved.set(key(x, y), K.LAKE);
    }
    if (total >= 10) spot(K.PARK, 0.2, 0.7);

    // Grow the city: each item starts from the free cell nearest the centre
    // (cx, cy) (with some jitter, preferring cells touching the city), then
    // grows its cluster into free neighbouring cells, favouring compact
    // shapes. ok() limits where a group may grow.
    const taken = new Map(); // key → item
    const touches = (x, y, pred) => DIRS.some(([dx, dy]) => pred(key(x + dx, y + dy)));
    const grow = (list, cx, cy, ok) => {
      const free = (x, y) => !reserved.has(key(x, y)) && !taken.has(key(x, y)) && ok(x, y);
      for (const it of list) {
        it.cells = [];
        for (let k = 0; k < it.nb; k++) {
          let cands = [];
          let score;
          if (k > 0) {
            for (const [x, y] of it.cells) for (const [dx, dy] of DIRS) if (free(x + dx, y + dy)) cands.push([x + dx, y + dy]);
            const own = (x, y) => DIRS.filter(([dx, dy]) => taken.get(key(x + dx, y + dy)) === it).length;
            score = ([x, y]) => Math.hypot(x - cx, y - cy) - 0.9 * own(x, y) + 0.8 * r();
          }
          if (!cands.length) {
            for (let rad = span + Math.ceil(Math.hypot(cx, cy)); !cands.length; rad += 2)
              for (let y = -rad; y <= rad; y++) for (let x = -rad; x <= rad; x++) if (free(x, y)) cands.push([x, y]);
            // Across the river (or a lake) still counts as touching the city,
            // so it spreads over both banks instead of along one.
            const near = (q) => {
              if (taken.has(q)) return true;
              const [qx, qy] = q.split(',').map(Number);
              return reserved.has(q) && reserved.get(q) !== K.PARK && touches(qx, qy, (q2) => taken.has(q2));
            };
            score = ([x, y]) => Math.hypot(x - cx, y - cy) + 0.9 * r() + (taken.size && !touches(x, y, near) ? 2 : 0);
          }
          let best = null, bs = Infinity;
          for (const cell of cands) {
            const s = score(cell);
            if (s < bs) [bs, best] = [s, cell];
          }
          taken.set(key(...best), it);
          it.cells.push(best);
        }
      }
    };
    grow(inner, 0, 0, () => true);

    const cross = (x, y) => (axis === 0 ? x : y);
    const along = (x, y) => (axis === 0 ? y : x);
    if (split) {
      // The river runs alongside the city on one side; past it, a ridge of
      // mountains, and past that the outside neighborhoods. The ridge spans
      // the outside cluster plus a cell either end.
      const near = [...taken.keys(), ...[...reserved].filter(([, k]) => k !== K.RIVER).map(([q]) => q)];
      const crosses = near.map((q) => cross(...q.split(',').map(Number)));
      const edge = side < 0 ? Math.min(...crosses) - 1 : Math.max(...crosses) + 1;
      river = meander(Math.min(edge, edge + side), Math.max(edge, edge + side), edge);
      const ridge = edge + 2 * side;
      const inA = [...taken.keys()].map((q) => along(...q.split(',').map(Number)));
      const a0 = Math.round((Math.min(...inA) + Math.max(...inA)) / 2);
      const depth = Math.max(1, Math.round(Math.sqrt(blocks(outer) / Math.PI)));
      grow(outer, ...at(a0, ridge + side * depth), (x, y) => (cross(x, y) - ridge) * side > 0);
      const outA = outer.flatMap((it) => it.cells.map((c) => along(...c)));
      for (let a = Math.min(...outA) - 1; a <= Math.max(...outA) + 1; a++) reserved.set(key(...at(a, ridge)), K.MOUNTAIN);
    } else if (total && total < 6) {
      // Small city: the river runs right alongside, once we know its edge.
      const cross = [...taken.keys()].map((q) => Number(q.split(',')[axis]));
      const edge = side < 0 ? Math.min(...cross) - 1 : Math.max(...cross) + 1;
      river = meander(Math.min(edge, edge + side), Math.max(edge, edge + side), edge);
    }

    // Keep lakes, parks and river cells only where they touch the city, and
    // fit the map to those plus the city.
    const isTaken = (q) => taken.has(q);
    const adj8 = (x, y) => {
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (taken.has(key(x + dx, y + dy))) return true;
      return false;
    };
    const cells = [...taken.keys()].map((q) => [...q.split(',').map(Number), K.LOTS]);
    const alongs = [...taken.keys(), ...[...reserved].filter(([, k]) => k === K.MOUNTAIN).map(([q]) => q)].map((q) => along(...q.split(',').map(Number)));
    for (const [q, kind] of reserved) {
      const [x, y] = q.split(',').map(Number);
      if (split && kind === K.RIVER) {
        // The border river runs the full length of the map.
        if (along(x, y) >= Math.min(...alongs) && along(x, y) <= Math.max(...alongs)) cells.push([x, y, kind]);
      } else if (kind === K.MOUNTAIN || (kind === K.PARK ? touches(x, y, isTaken) : adj8(x, y))) cells.push([x, y, kind]);
    }
    if (total && !cells.some((p) => p[2] === K.RIVER)) {
      // A river running alongside a small city: bring the stretch beside
      // it onto the map.
      const along = [...taken.keys()].map((q) => Number(q.split(',')[1 - axis]));
      const a0 = Math.min(...along), a1 = Math.max(...along);
      for (const p of river) if (p[1 - axis] >= a0 && p[1 - axis] <= a1) cells.push([...p, K.RIVER]);
    }
    let x0 = 0, y0 = 0, x1 = -1, y1 = -1;
    if (cells.length) {
      x0 = Math.min(...cells.map((p) => p[0]));
      y0 = Math.min(...cells.map((p) => p[1]));
      x1 = Math.max(...cells.map((p) => p[0]));
      y1 = Math.max(...cells.map((p) => p[1]));
    }
    this.wb = x1 - x0 + 1;
    this.hb = y1 - y0 + 1;
    this.cols = this.wb * BLOCK + 1 + MARGIN * 2;
    this.rows = this.hb * BLOCK + 1 + MARGIN * 2;
    this.cellKind = new Uint8Array(this.wb * this.hb);
    for (const [x, y, kind] of cells) this.cellKind[(y - y0) * this.wb + (x - x0)] = kind;
    this.river = total ? river.map(([x, y]) => [x - x0, y - y0]) : [];
    this.riverAxis = axis;
    this.riverSide = side; // which side of the river the outside neighborhoods are on

    // Each neighborhood owns a list of lots (quarter blocks), in global lot
    // coordinates; building n goes on lots[n]. Lots in a block are taken in
    // a shuffled order so part-filled blocks don't all fill the same corner.
    this.qw = this.wb * 2;
    this.lotOwner = new Int16Array(this.qw * this.hb * 2).fill(-1);
    const index = new Map(this.neighborhoods.map((d, i) => [d, i]));
    const lotAt = ([bx, by], q) => [(bx - x0) * 2 + (q % 2), (by - y0) * 2 + Math.floor(q / 2)];
    for (const it of items) {
      for (const d of it.members) {
        d.lots = [];
        if (!d.shape) {
          for (const cell of it.cells) {
            const qs = [0, 1, 2, 3];
            for (let i = 3; i > 0; i--) {
              const j = Math.floor(r() * (i + 1));
              [qs[i], qs[j]] = [qs[j], qs[i]];
            }
            for (const q of qs) d.lots.push(lotAt(cell, q));
          }
        } else {
          for (const q of d.shape) d.lots.push(lotAt(it.cells[0], q));
        }
        for (const [qx, qy] of d.lots) this.lotOwner[qy * this.qw + qx] = index.get(d);
      }
    }
  }

  kindAt(bx, by) {
    return bx < 0 || by < 0 || bx >= this.wb || by >= this.hb ? K.EMPTY : this.cellKind[by * this.wb + bx];
  }

  /**
   * Roads run along the edges of the block grid. Every built-up block and
   * park is ringed by road; gaps between road networks are then bridged by
   * the cheapest path over the grid, a few extra bridges cross the river,
   * and four highways run from the city out to the map edges.
   */
  buildRoads() {
    const r = rng(this.seed ^ 0x5bd1e995);
    const NW = this.wb + 1, NH = this.hb + 1;
    this.nw = NW;
    // Edge id: node (i, j) * 2, +0 for the edge to (i+1, j), +1 for (i, j+1).
    const eid = (i, j, v) => (j * NW + i) * 2 + v;
    const roads = new Set();
    for (let by = 0; by < this.hb; by++)
      for (let bx = 0; bx < this.wb; bx++) {
        const k = this.kindAt(bx, by);
        if (k !== K.LOTS && k !== K.PARK) continue;
        roads.add(eid(bx, by, 0)).add(eid(bx, by + 1, 0)).add(eid(bx, by, 1)).add(eid(bx + 1, by, 1));
      }

    const links = (i, j) => {
      const out = [];
      if (i + 1 < NW) out.push([i + 1, j, eid(i, j, 0)]);
      if (i > 0) out.push([i - 1, j, eid(i - 1, j, 0)]);
      if (j + 1 < NH) out.push([i, j + 1, eid(i, j, 1)]);
      if (j > 0) out.push([i, j - 1, eid(i, j - 1, 1)]);
      return out;
    };
    const degree = (i, j) => links(i, j).filter(([, , e]) => roads.has(e)).length;
    // Cells either side of an edge.
    const sides = (e) => {
      const n = e >> 1, i = n % NW, j = (n / NW) | 0;
      return e & 1 ? [[i - 1, j], [i, j]] : [[i, j - 1], [i, j]];
    };
    const cost = (e) => {
      if (roads.has(e)) return 0;
      const [a, b] = sides(e).map(([x, y]) => this.kindAt(x, y));
      if (a === K.LAKE && b === K.LAKE) return 30;
      // Over the ridge by a pass between two peaks, rather than around it.
      return a === K.MOUNTAIN && b === K.MOUNTAIN ? 2 : a === K.MOUNTAIN || b === K.MOUNTAIN ? 1.5 : 1;
    };

    for (let guard = 0; guard < 100; guard++) {
      const comp = new Int32Array(NW * NH).fill(-1);
      let ncomp = 0;
      for (let s = 0; s < NW * NH; s++) {
        if (comp[s] >= 0 || !degree(s % NW, (s / NW) | 0)) continue;
        const stack = [s];
        comp[s] = ncomp;
        while (stack.length) {
          const u = stack.pop();
          for (const [x, y, e] of links(u % NW, (u / NW) | 0)) {
            const v = y * NW + x;
            if (roads.has(e) && comp[v] < 0) {
              comp[v] = ncomp;
              stack.push(v);
            }
          }
        }
        ncomp++;
      }
      if (ncomp <= 1) break;
      // Dijkstra from component 0 to the nearest node of any other.
      const dist = new Float64Array(NW * NH).fill(Infinity);
      const via = new Int32Array(NW * NH).fill(-1);
      const done = new Uint8Array(NW * NH);
      for (let s = 0; s < NW * NH; s++) if (comp[s] === 0) dist[s] = 0;
      let hit = -1;
      for (;;) {
        let u = -1;
        for (let s = 0; s < NW * NH; s++) if (!done[s] && dist[s] < Infinity && (u < 0 || dist[s] < dist[u])) u = s;
        if (u < 0) break;
        if (comp[u] > 0) {
          hit = u;
          break;
        }
        done[u] = 1;
        for (const [x, y, e] of links(u % NW, (u / NW) | 0)) {
          const v = y * NW + x, d = dist[u] + cost(e);
          if (d < dist[v]) {
            dist[v] = d;
            via[v] = e;
          }
        }
      }
      if (hit < 0) break;
      for (let u = hit; comp[u] !== 0; ) {
        const e = via[u];
        roads.add(e);
        const n = e >> 1;
        u = n === u ? (e & 1 ? n + NW : n + 1) : n;
      }
    }

    // Extra bridges where the river passes between two cells and both
    // banks already have a road.
    for (let i = 0; i + 1 < this.river.length; i++) {
      const [ax, ay] = this.river[i], [bx, by] = this.river[i + 1];
      const [ni, nj, v] = ax === bx ? [ax, Math.max(ay, by), 0] : [Math.max(ax, bx), ay, 1];
      const [mi, mj] = v ? [ni, nj + 1] : [ni + 1, nj];
      if (ni < 0 || nj < 0 || mi >= NW || mj >= NH) continue;
      if (degree(ni, nj) && degree(mi, mj) && r() < 0.7) roads.add(eid(ni, nj, v));
    }
    this.roadEdges = roads;

    // Highways: from the outermost intersection on each side, preferring
    // ones near the middle, straight out to the map edge.
    const nodeT = (n) => MARGIN + n * BLOCK;
    this.highways = [];
    const blocked = (p) => this.kindAt(...p) === K.LAKE || this.kindAt(...p) === K.MOUNTAIN;
    const lakeBoth = (cellsA, cellsB) => cellsA.some((p, k) => blocked(p) && blocked(cellsB[k]));
    for (const [vertical, toFar] of [[false, false], [false, true], [true, false], [true, true]]) {
      // vertical: highway runs along y (north/south); toFar: toward +x / +y.
      const lines = vertical ? NW : NH, len = vertical ? NH : NW;
      let best = null, bs = Infinity;
      for (let l = 0; l < lines; l++) {
        let end = -1;
        for (let k = 0; k < len; k++) {
          const kk = toFar ? len - 1 - k : k;
          if (vertical ? degree(l, kk) : degree(kk, l)) {
            end = kk;
            break;
          }
        }
        if (end < 0) continue;
        const run = toFar ? [...Array(len - 1 - end).keys()].map((k) => end + k) : [...Array(end).keys()];
        // Skip lines that would run straight through a lake or the ridge.
        const a = run.map((k) => (vertical ? [l - 1, k] : [k, l - 1]));
        const b = run.map((k) => (vertical ? [l, k] : [k, l]));
        if (lakeBoth(a, b)) continue;
        const s = Math.abs(l - (lines - 1) / 2) + r() * 1.5;
        if (s < bs) [bs, best] = [s, [l, end]];
      }
      if (!best) continue;
      const [l, end] = best;
      const fixed = nodeT(l), from = nodeT(end), to = toFar ? (vertical ? this.rows : this.cols) - 1 : 0;
      const [a, b] = [Math.min(from, to), Math.max(from, to)];
      this.highways.push(vertical ? [fixed, a, fixed, b] : [a, fixed, b, fixed]);
    }
  }

  /**
   * Water as a smooth field sampled WS times per tile: > 0 is water, and
   * the value is roughly the distance in from the shore. The river follows
   * its chain of cells through their centres; lakes are wobbly blobs.
   */
  buildWater() {
    const r = rng(this.seed ^ 0x27d4eb2f);
    const W = this.cols * WS + 1, H = this.rows * WS + 1;
    const f = new Float32Array(W * H).fill(-9);
    this.water = f;
    this.waterW = W;
    const centre = ([bx, by]) => [MARGIN + bx * BLOCK + 4.5, MARGIN + by * BLOCK + 4.5];
    // Raise the field to fn(tx, ty) over a tile-space box.
    const stamp = (tx0, ty0, tx1, ty1, fn) => {
      const i0 = Math.max(0, Math.floor(tx0 * WS)), i1 = Math.min(W - 1, Math.ceil(tx1 * WS));
      const j0 = Math.max(0, Math.floor(ty0 * WS)), j1 = Math.min(H - 1, Math.ceil(ty1 * WS));
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const v = fn(i / WS, j / WS);
          if (v > f[j * W + i]) f[j * W + i] = v;
        }
    };

    if (this.river.length) {
      // Wobble the centres across the flow, run the river well past both
      // map edges, then round off the corners.
      const ax = this.riverAxis === 0 ? 1 : 0; // index of the coordinate it flows along
      let pts = this.river.map((cell) => {
        const p = centre(cell);
        p[1 - ax] += (r() - 0.5) * 1.2;
        return p;
      });
      const first = [...pts[0]], last = [...pts[pts.length - 1]];
      first[ax] -= 40;
      last[ax] += 40;
      pts = chaikin([first, ...pts, last], 3);
      if (this.split) {
        // Where the river's centre line crosses each row of tiles along it,
        // so the ground can tell which bank a tile is on.
        const n = ax === 1 ? this.rows : this.cols;
        this.riverLine = new Float32Array(n + 1);
        for (let i = 0, k = 0; i <= n; i++) {
          while (k + 2 < pts.length && pts[k + 1][ax] < i) k++;
          const [a, b] = [pts[k], pts[k + 1]];
          const t = Math.max(0, Math.min(1, (i - a[ax]) / (b[ax] - a[ax] || 1)));
          this.riverLine[i] = a[1 - ax] + (b[1 - ax] - a[1 - ax]) * t;
        }
      }
      const p1 = r() * 6, p2 = r() * 6;
      let s = 0;
      const rad = pts.map((p, i) => {
        if (i) s += Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]);
        return 1.7 + 0.35 * Math.sin(s * 0.23 + p1) + 0.2 * Math.sin(s * 0.61 + p2);
      });
      for (let i = 0; i + 1 < pts.length; i++) {
        const [ax0, ay0] = pts[i], [bx0, by0] = pts[i + 1];
        const ra = rad[i], rb = rad[i + 1], m = Math.max(ra, rb) + 0.5;
        const dx = bx0 - ax0, dy = by0 - ay0, l2 = dx * dx + dy * dy || 1;
        stamp(Math.min(ax0, bx0) - m, Math.min(ay0, by0) - m, Math.max(ax0, bx0) + m, Math.max(ay0, by0) + m, (x, y) => {
          const t = Math.max(0, Math.min(1, ((x - ax0) * dx + (y - ay0) * dy) / l2));
          return ra + (rb - ra) * t - Math.hypot(x - ax0 - dx * t, y - ay0 - dy * t);
        });
      }
    }

    // Lakes: a lobed blob per cell, joined by a channel when two touch.
    const lakes = [];
    for (let by = 0; by < this.hb; by++) for (let bx = 0; bx < this.wb; bx++) if (this.kindAt(bx, by) === K.LAKE) lakes.push([bx, by]);
    for (const cell of lakes) {
      const [cx, cy] = centre(cell);
      const a1 = r() * 6, a2 = r() * 6, R = 2.3 + r() * 0.3;
      stamp(cx - 4, cy - 4, cx + 4, cy + 4, (x, y) => {
        const th = Math.atan2(y - cy, x - cx);
        return R * (1 + 0.16 * Math.sin(2 * th + a1) + 0.1 * Math.sin(3 * th + a2)) - Math.hypot(x - cx, y - cy);
      });
      for (const other of lakes) {
        if (Math.abs(other[0] - cell[0]) + Math.abs(other[1] - cell[1]) !== 1) continue;
        const [ox, oy] = centre(other);
        stamp(Math.min(cx, ox) - 3, Math.min(cy, oy) - 3, Math.max(cx, ox) + 3, Math.max(cy, oy) + 3, (x, y) => {
          const t = Math.max(0, Math.min(1, ((x - cx) * (ox - cx) + (y - cy) * (oy - cy)) / 64));
          return 2 - Math.hypot(x - cx - (ox - cx) * t, y - cy - (oy - cy) * t);
        });
      }
    }
  }

  /** Water field at continuous tile coords: > 0 is water. */
  waterAt(tx, ty) {
    const W = this.waterW, f = this.water;
    const sx = Math.max(0, Math.min(W - 1.001, tx * WS)), sy = Math.max(0, Math.min(f.length / W - 1.001, ty * WS));
    const i = Math.floor(sx), j = Math.floor(sy), u = sx - i, v = sy - j;
    const a = f[j * W + i], b = f[j * W + i + 1], c = f[(j + 1) * W + i], d = f[(j + 1) * W + i + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  /** True for tile coords on the outside neighborhoods' bank of the river. */
  farSide(tx, ty) {
    if (!this.riverLine) return false;
    const [a, c] = this.riverAxis === 0 ? [ty, tx] : [tx, ty];
    const i = Math.max(0, Math.min(this.riverLine.length - 1, Math.round(a)));
    return (c - this.riverLine[i]) * this.riverSide > 0;
  }

  /** Owner of global lot (qx, qy), or -1. */
  ownerOfLot(qx, qy) {
    return qx < 0 || qy < 0 || qx >= this.qw || qy >= this.hb * 2 ? -1 : this.lotOwner[qy * this.qw + qx];
  }

  /** Tile position for a neighborhood's label: below the front edge of its lots. */
  labelAnchor(d) {
    const y1 = Math.max(...d.lots.map(([, qy]) => qy + 1));
    // Centre on the frontmost row of lots, so odd shapes still label their own block.
    const front = d.lots.filter(([, qy]) => qy + 1 === y1);
    const x0 = Math.min(...front.map(([qx]) => qx)), x1 = Math.max(...front.map(([qx]) => qx + 1));
    // Lot q spans tiles MARGIN + q*4 .. +4 (a road or plaza line follows).
    return [MARGIN + ((x0 + x1) / 2) * 4, MARGIN + y1 * 4 + 0.5];
  }

  idx(x, y) {
    return y * this.cols + x;
  }

  inBounds(x, y) {
    return x >= 0 && y >= 0 && x < this.cols && y < this.rows;
  }

  isRoad(x, y) {
    return this.inBounds(x, y) && this.tiles[this.idx(x, y)] === T.ROAD;
  }

  buildTiles() {
    const { cols, rows } = this;
    this.tiles = new Uint8Array(cols * rows);
    this.tileNeighborhood = new Int16Array(cols * rows).fill(-1);
    const road = (x, y) => {
      if (this.inBounds(x, y)) this.tiles[this.idx(x, y)] = T.ROAD;
    };
    for (const e of this.roadEdges) {
      const n = e >> 1;
      const x = MARGIN + (n % this.nw) * BLOCK, y = MARGIN + ((n / this.nw) | 0) * BLOCK;
      for (let k = 0; k <= BLOCK; k++) e & 1 ? road(x, y + k) : road(x + k, y);
    }
    for (const [x0, y0, x1, y1] of this.highways) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) road(x, y);

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = this.idx(x, y);
        if (this.tiles[i] === T.ROAD) continue;
        const lx = x - MARGIN, ly = y - MARGIN;
        if (lx < 0 || ly < 0 || lx > this.wb * BLOCK || ly > this.hb * BLOCK) continue; // grass
        const ox = lx % BLOCK, oy = ly % BLOCK;
        if (ox === 0 || oy === 0) continue; // grass between unbuilt cells
        const kind = this.kindAt((lx / BLOCK) | 0, (ly / BLOCK) | 0);
        if (kind === K.PARK) this.tiles[i] = T.PARK;
        // Scree under the mountains, ragged where it meets the grass.
        if (kind === K.MOUNTAIN && (Math.min(ox, oy, BLOCK - ox, BLOCK - oy) > 1 || hash2(x, y, 11) < 0.5)) this.tiles[i] = T.ROCK;
        if (kind !== K.LOTS) continue;
        // Within a block, offsets 1-3 and 5-7 are lots; 4 is a plaza line.
        // A plaza tile touches 1 (inside a lot row), 2 or 4 (the centre) lots.
        const qxs = ox === 4 ? [-1, 0] : [0];
        const qys = oy === 4 ? [-1, 0] : [0];
        const qx = Math.floor((lx + (ox === 4 ? 1 : 0)) / 4), qy = Math.floor((ly + (oy === 4 ? 1 : 0)) / 4);
        const owners = new Set();
        for (const dx of qxs) for (const dy of qys) {
          const o = this.ownerOfLot(qx + dx, qy + dy);
          if (o >= 0) owners.add(o);
        }
        if (owners.size === 0) {
          this.tiles[i] = T.PARK;
        } else if (ox !== 4 && oy !== 4) {
          // Inside a lot: park until a building is placed on it.
          this.tiles[i] = T.PARK;
          this.tileNeighborhood[i] = [...owners][0];
        } else {
          // Plaza paths are tinted by their neighborhood; paths between two
          // neighborhoods stay plain paving, marking the boundary.
          this.tiles[i] = T.PLAZA;
          this.tileNeighborhood[i] = owners.size === 1 ? [...owners][0] : -1;
        }
      }
    }

    // Road tiles over (or right at the edge of) water are bridges.
    this.bridge = new Uint8Array(cols * rows);
    for (let y = 0; y < rows; y++)
      for (let x = 0; x < cols; x++) {
        if (this.tiles[this.idx(x, y)] !== T.ROAD) continue;
        let w = -Infinity;
        for (const [u, v] of [[0.5, 0.5], [0.1, 0.1], [0.9, 0.1], [0.1, 0.9], [0.9, 0.9]]) w = Math.max(w, this.waterAt(x + u, y + v));
        if (w > -0.1) this.bridge[this.idx(x, y)] = 1;
      }

    // Road entries where the network meets the map edge.
    this.entries = [];
    for (let x = 0; x < cols; x++) {
      if (this.isRoad(x, 0) && !this.isRoad(x - 1, 0)) this.entries.push([x, 0]);
      if (this.isRoad(x, rows - 1) && !this.isRoad(x - 1, rows - 1)) this.entries.push([x, rows - 1]);
    }
    for (let y = 1; y < rows - 1; y++) {
      if (this.isRoad(0, y)) this.entries.push([0, y]);
      if (this.isRoad(cols - 1, y)) this.entries.push([cols - 1, y]);
    }
  }

  placeBuildings() {
    this.buildings = [];
    this.neighborhoods.forEach((d, di) => {
      d.targets.forEach((t, n) => {
        const [qx, qy] = d.lots[n];
        const bx = qx >> 1, by = qy >> 1;
        const col = qx % 2, row = qy % 2;
        const ox = MARGIN + bx * BLOCK, oy = MARGIN + by * BLOCK;
        const x0 = ox + 1 + col * 4, y0 = oy + 1 + row * 4;

        for (let j = 0; j < LOT; j++)
          for (let i = 0; i < LOT; i++) this.tiles[this.idx(x0 + i, y0 + j)] = T.LOT;

        // Driveway: the road tile the lot's entrance faces. Prefer the
        // camera-facing (+x / +y) roads so cars arriving are visible.
        let drive, door;
        if (col === 1) {
          drive = [ox + BLOCK, y0 + 1];
          door = [x0 + LOT - 0.4, y0 + 1.5];
        } else if (row === 1) {
          drive = [x0 + 1, oy + BLOCK];
          door = [x0 + 1.5, y0 + LOT - 0.4];
        } else {
          drive = [ox, y0 + 1];
          door = [x0 + 0.4, y0 + 1.5];
        }
        this.buildings.push({
          id: t.id,
          target: t,
          neighborhood: di,
          color: t.color || d.color,
          lot: [x0, y0],
          center: [x0 + LOT / 2, y0 + LOT / 2],
          drive,
          door,
        });
      });
    });
    this.byId = new Map(this.buildings.map((b) => [b.id, b]));
  }

  /**
   * Peaks for each ridge cell: one big mountain, snow-capped when tall
   * enough, and a couple of foothills. Each stays inside its cell, clear of
   * the roads (and the pass) around it.
   */
  placeMountains() {
    this.mountains = [];
    const r = rng(this.seed ^ 0x165667b1);
    for (let by = 0; by < this.hb; by++)
      for (let bx = 0; bx < this.wb; bx++) {
        if (this.kindAt(bx, by) !== K.MOUNTAIN) continue;
        // Centre of the cell's 7x7 interior.
        const cx = MARGIN + bx * BLOCK + 4.5, cy = MARGIN + by * BLOCK + 4.5;
        const ang = r() * Math.PI * 2;
        for (let k = 0; k < 3; k++) {
          const big = k === 0;
          const rad = big ? 2.5 + r() * 0.4 : 1.3 + r() * 0.4;
          const off = big ? r() * 0.4 : 3.3 - rad;
          const a = ang + k * 2.2 + r() * 0.6;
          this.mountains.push({
            x: cx + Math.cos(a) * off,
            y: cy + Math.sin(a) * off,
            r: rad,
            h: Math.round(big ? 62 + r() * 34 : 22 + r() * 16),
            seed: (r() * 1e9) | 0,
          });
        }
      }
  }

  placeTrees() {
    this.trees = [];
    const r = rng(this.seed);
    const underPeak = (tx, ty) => this.mountains.some((m) => Math.hypot(tx - m.x, ty - m.y) < m.r + 0.4);
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const t = this.tiles[this.idx(x, y)];
        let p = 0;
        if (t === T.PARK) p = 0.45;
        else if (t === T.ROCK) p = 0.12;
        else if (t === T.GRASS) {
          // Fewer trees right next to the roads that cross the margin.
          const nearRoad = this.isRoad(x - 1, y) || this.isRoad(x + 1, y) || this.isRoad(x, y - 1) || this.isRoad(x, y + 1);
          p = nearRoad ? 0.03 : 0.16;
        }
        if (r() < p) {
          const tx = x + 0.3 + r() * 0.4, ty = y + 0.3 + r() * 0.4;
          let variant = Math.floor(r() * 3);
          // Pines on the slopes, and mostly pines in the wilder far country.
          if (t === T.ROCK || (t === T.GRASS && this.farSide(tx, ty) && variant < 2 && r() < 0.6)) variant = 2;
          // Keep trees off the water and out of the shallows.
          if (this.waterAt(tx, ty) < -0.5 && !underPeak(tx, ty)) this.trees.push({ x: tx, y: ty, variant });
        }
      }
    }
  }

  // --- projection ---------------------------------------------------------

  /** Tile coords → world pixel coords (the ground canvas's pixel space). */
  project(tx, ty) {
    return { x: (tx - ty) * AX + this.rows * AX, y: (tx + ty) * (AX / 2) };
  }

  /** World pixel coords → continuous tile coords. */
  unproject(wx, wy) {
    const sx = (wx - this.rows * AX) / AX;
    const sy = wy / (AX / 2);
    return { x: (sx + sy) / 2, y: (sy - sx) / 2 };
  }

  get worldWidth() {
    return (this.cols + this.rows) * AX;
  }

  get worldHeight() {
    return ((this.cols + this.rows) * AX) / 2 + EDGE_H;
  }

  // --- pathfinding --------------------------------------------------------

  /**
   * BFS over the road grid from a building's driveway. Cached per building.
   * Returns { parent, dist, local, edges } where local lists nearby road
   * tiles to spawn "neighbourhood" traffic from and edges lists map-edge
   * entries reachable from here.
   */
  roadsFrom(b) {
    let r = this.bfsCache.get(b.id);
    if (r) return r;
    const n = this.cols * this.rows;
    const parent = new Int32Array(n).fill(-1);
    const dist = new Int32Array(n).fill(-1);
    const start = this.idx(b.drive[0], b.drive[1]);
    const queue = [start];
    dist[start] = 0;
    parent[start] = start;
    const local = [];
    for (let qi = 0; qi < queue.length; qi++) {
      const cur = queue[qi];
      const cx = cur % this.cols, cy = (cur / this.cols) | 0;
      const d = dist[cur];
      if (d >= 6 && d <= 20) local.push(cur);
      for (const [dx, dy] of DIRS) {
        const nx = cx + dx, ny = cy + dy;
        if (!this.isRoad(nx, ny)) continue;
        const ni = this.idx(nx, ny);
        if (dist[ni] >= 0) continue;
        dist[ni] = d + 1;
        parent[ni] = cur;
        queue.push(ni);
      }
    }
    const edges = this.entries.map(([x, y]) => this.idx(x, y)).filter((i) => dist[i] >= 0);
    r = { parent, dist, local, edges };
    this.bfsCache.set(b.id, r);
    return r;
  }

  /** Tile path from road tile index `from` to building b's driveway. */
  pathTo(b, from) {
    const { parent } = this.roadsFrom(b);
    if (parent[from] < 0) return null;
    const path = [];
    let cur = from;
    for (let guard = 0; guard < 10000; guard++) {
      path.push([cur % this.cols, (cur / this.cols) | 0]);
      if (parent[cur] === cur) return path;
      cur = parent[cur];
    }
    return null;
  }

  // --- ground rendering ---------------------------------------------------

  roadMask(x, y) {
    let m = 0;
    DIRS.forEach(([dx, dy], i) => {
      if (this.isRoad(x + dx, y + dy)) m |= 1 << i;
    });
    return m;
  }

  renderGround() {
    const { cols, rows } = this;
    const buf = new PixBuf(this.worldWidth, this.worldHeight);
    const ax = cols * AX, by = rows * AX;
    const masks = new Uint8Array(cols * rows);
    for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) masks[this.idx(x, y)] = this.roadMask(x, y);
    const dColors = this.neighborhoods.map((d) => mix(hexToRgb(d.color), C.plaza, 0.6));

    rasterBox(buf, by, 0, ax, by, EDGE_H, (face, u, v) => {
      if (face !== 'top') {
        // Cliff under the map: grass lip, dirt with strata, rock base, and
        // a waterfall where the river runs off the edge.
        const n = hash2(Math.floor(u), Math.floor(v), 7);
        const fall = face === 'left' ? this.waterAt(u / AX, rows - 0.01) : this.waterAt(cols - 0.01, rows - u / AX);
        if (fall > 0) {
          const streak = hash2(Math.floor(u / 2), Math.floor(v / 3 + u), 5);
          const c = v > EDGE_H - 3 ? C.foam : streak < 0.2 ? C.glint : streak < 0.6 ? C.water : C.shallow;
          return face === 'left' ? c : shade(c, -0.12);
        }
        let c = v < 2 ? C.grassDark : v < 9 ? C.dirt : C.rock;
        if (v >= 2 && v < 9 && (v === 5 || n < 0.1)) c = C.dirtDark;
        return face === 'left' ? c : shade(c, -0.18);
      }
      const tx = u / AX, ty = v / AX;
      const x = Math.floor(tx), y = Math.floor(ty);
      if (x >= cols || y >= rows) return null;
      const fu = tx - x, fv = ty - y;
      const i = this.idx(x, y);
      // Screen-ish pixel hash for 16-bit style dithering noise.
      const n = hash2(Math.floor(u - v), Math.floor((u + v) / 2), 1);

      switch (this.tiles[i]) {
        case T.ROAD:
          return this.paintRoad(masks[i], fu, fv, n, this.bridge[i]);
        case T.LOT: {
          const base = dColors[this.tileNeighborhood[i]] || C.plaza;
          const seam = fu < 0.05 || fv < 0.05;
          return seam ? shade(base, -0.08) : n < 0.08 ? shade(base, -0.03) : base;
        }
        case T.PLAZA: {
          const base = dColors[this.tileNeighborhood[i]] || C.plaza;
          return (fu * 2) % 1 < 0.06 || (fv * 2) % 1 < 0.06 ? shade(base, -0.06) : base;
        }
        case T.PARK: {
          const stripe = Math.floor((fu + fv) * 3) % 2 === 0;
          const c = stripe ? C.park : C.parkStripe;
          return n < 0.06 ? C.grassDark : n > 0.96 ? C.grassLight : c;
        }
        case T.ROCK:
          return n < 0.25 ? C.screeDark : n > 0.85 ? C.farGrassDark : C.scree;
        default: {
          // Dither the shoreline a little so it doesn't look traced.
          const w = this.waterAt(tx, ty) + (n - 0.5) * 0.14;
          if (w > 0) {
            const glint = hash2(Math.floor((u - v) / 5), Math.floor((u + v) / 2), 3) < 0.025;
            return glint ? C.glint : w < 0.35 ? C.shallow : w < 1.1 ? C.water : C.deep;
          }
          if (w > -0.3) return n < 0.3 ? C.bankDark : C.bank;
          if (this.split && this.farSide(tx, ty)) return n < 0.12 ? C.farGrassDark : n > 0.9 ? C.farGrassLight : C.farGrass;
          return n < 0.12 ? C.grassDark : n > 0.9 ? C.grassLight : C.grass;
        }
      }
    });
    this.ground = buf.toCanvas();
    return this.ground;
  }

  paintRoad(mask, u, v, n, bridge) {
    const has = (d) => (mask >> d) & 1;
    const CURB = 0.15;
    // Sidewalk (railing, on a bridge) on sides without a connecting road.
    if ((!has(0) && v < CURB) || (!has(1) && u > 1 - CURB) || (!has(2) && v > 1 - CURB) || (!has(3) && u < CURB)) {
      return bridge ? C.rail : C.curb;
    }
    if ((!has(0) && v < CURB + 0.05) || (!has(1) && u > 0.95 - CURB) || (!has(2) && v > 0.95 - CURB) || (!has(3) && u < CURB + 0.05)) {
      return bridge ? C.railEdge : C.curbEdge;
    }
    // Sidewalk corners at intersections.
    const corner = (cu, cv) => Math.abs(u - cu) < CURB && Math.abs(v - cv) < CURB;
    if (corner(0, 0) || corner(1, 0) || corner(0, 1) || corner(1, 1)) return C.curb;

    const alongX = (has(1) || has(3)) && !has(0) && !has(2);
    const alongY = (has(0) || has(2)) && !has(1) && !has(3);
    if (alongX && Math.abs(v - 0.5) < 0.035 && (u * 2) % 1 < 0.5) return C.dash;
    if (alongY && Math.abs(u - 0.5) < 0.035 && (v * 2) % 1 < 0.5) return C.dash;
    // Crosswalk stripes across the mouths of intersections.
    const cross = mask === 15;
    if (cross) {
      const zebra = (t) => Math.floor(t * 10) % 2 === 0;
      if ((v < 0.27 || v > 0.73) && u > 0.2 && u < 0.8 && zebra(u)) return C.curb;
      if ((u < 0.27 || u > 0.73) && v > 0.2 && v < 0.8 && zebra(v)) return C.curb;
    }
    return n < 0.15 ? C.asphaltDark : C.asphalt;
  }

  /** Small overview image for the minimap. */
  renderMinimap(maxW) {
    const scale = maxW / this.worldWidth;
    const cv = document.createElement('canvas');
    cv.width = Math.round(this.worldWidth * scale);
    cv.height = Math.round(this.worldHeight * scale);
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.ground, 0, 0, cv.width, cv.height);
    return { canvas: cv, scale };
  }

  /** Signature used to decide when the layout must be rebuilt. */
  static signature(neighborhoods, targets) {
    return JSON.stringify([neighborhoods.map((d) => [d.name, d.color, d.kind, !!d.outside]), targets.map((t) => [t.id, t.neighborhood, t.building, t.color])]);
  }
}

/** Chaikin corner cutting: rounds a polyline off, keeping its endpoints. */
function chaikin(pts, iters) {
  for (let k = 0; k < iters; k++) {
    const out = [pts[0]];
    for (let i = 0; i + 1 < pts.length; i++) {
      const [ax, ay] = pts[i], [bx, by] = pts[i + 1];
      out.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

export { DIRS };
