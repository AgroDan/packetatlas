// City layout: turns neighborhoods + targets into a tile map with a road grid,
// building lots, parks and trees, and renders the ground into one canvas.

import { PixBuf, rasterBox, hexToRgb, mix, shade, hash2, rng, strHash, AX } from './pixel.js';

export const BLOCK = 8; // road every BLOCK tiles; 7x7 block interior
const MARGIN = 5; // grass ring around the city
const LOT = 3; // lot size in tiles; 4 lots per block
const EDGE_H = 14; // depth of the dirt cliff under the map

export const T = { GRASS: 0, ROAD: 1, LOT: 2, PARK: 3, PLAZA: 4 };

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
  park: hexToRgb('#66a84c'),
  parkStripe: hexToRgb('#5d9f44'),
  asphalt: hexToRgb('#4a4c56'),
  asphaltDark: hexToRgb('#42444d'),
  curb: hexToRgb('#bdb7aa'),
  curbEdge: hexToRgb('#8e897e'),
  dash: hexToRgb('#e9d46c'),
  plaza: hexToRgb('#cdc8bb'),
  seam: hexToRgb('#b3ad9f'),
  dirt: hexToRgb('#8a5a36'),
  dirtDark: hexToRgb('#6b4228'),
  rock: hexToRgb('#5d4a3d'),
};

export class City {
  constructor(neighborhoods, targets) {
    this.neighborhoods = neighborhoods.map((d, i) => ({
      name: d.name,
      color: d.color || PALETTE[i % PALETTE.length],
      kind: d.kind,
      targets: targets.filter((t) => t.neighborhood === d.name),
    }));
    this.layout();
    this.buildTiles();
    this.placeBuildings();
    this.placeTrees();
    this.bfsCache = new Map();
  }

  // --- layout -------------------------------------------------------------

  layout() {
    for (const d of this.neighborhoods) {
      const nb = Math.max(1, Math.ceil(d.targets.length / 4));
      d.cols = Math.ceil(Math.sqrt(nb));
      d.rows = Math.ceil(nb / d.cols);
    }
    // Shelf-pack neighborhood rectangles (in blocks) into a roughly square city.
    const total = this.neighborhoods.reduce((s, d) => s + d.cols * d.rows, 0);
    const widest = Math.max(...this.neighborhoods.map((d) => d.cols));
    const maxW = Math.max(widest, Math.ceil(Math.sqrt(total) * 1.3));
    let x = 0, y = 0, shelf = 0, wb = 0;
    for (const d of this.neighborhoods) {
      if (x > 0 && x + d.cols > maxW) {
        x = 0;
        y += shelf;
        shelf = 0;
      }
      d.bx = x;
      d.by = y;
      x += d.cols;
      shelf = Math.max(shelf, d.rows);
      wb = Math.max(wb, x);
    }
    this.wb = wb;
    this.hb = y + shelf;
    this.cols = this.wb * BLOCK + 1 + MARGIN * 2;
    this.rows = this.hb * BLOCK + 1 + MARGIN * 2;

    this.blockOwner = new Array(this.wb * this.hb).fill(-1);
    this.neighborhoods.forEach((d, i) => {
      for (let j = 0; j < d.rows; j++)
        for (let k = 0; k < d.cols; k++) this.blockOwner[(d.by + j) * this.wb + d.bx + k] = i;
    });
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
    const roadLine = (v, nBlocks) => {
      const l = v - MARGIN;
      return l >= 0 && l <= nBlocks * BLOCK && l % BLOCK === 0;
    };

    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const i = this.idx(x, y);
        if (roadLine(x, this.wb) || roadLine(y, this.hb)) {
          this.tiles[i] = T.ROAD;
          continue;
        }
        const lx = x - MARGIN, ly = y - MARGIN;
        if (lx < 0 || ly < 0 || lx > this.wb * BLOCK || ly > this.hb * BLOCK) continue; // grass
        const bx = Math.floor(lx / BLOCK), by = Math.floor(ly / BLOCK);
        const owner = this.blockOwner[by * this.wb + bx];
        this.tileNeighborhood[i] = owner;
        const inLotX = lx % BLOCK !== 4, inLotY = ly % BLOCK !== 4;
        this.tiles[i] = owner < 0 ? T.PARK : inLotX && inLotY ? T.PARK : T.PLAZA;
      }
    }

    // Road entries where the grid meets the map edge.
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
        const block = Math.floor(n / 4), lot = n % 4;
        const bx = d.bx + (block % d.cols), by = d.by + Math.floor(block / d.cols);
        const col = lot % 2, row = Math.floor(lot / 2);
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

  placeTrees() {
    this.trees = [];
    const r = rng(strHash(this.neighborhoods.map((d) => d.name).join('|')));
    for (let y = 0; y < this.rows; y++) {
      for (let x = 0; x < this.cols; x++) {
        const t = this.tiles[this.idx(x, y)];
        let p = 0;
        if (t === T.PARK) p = 0.45;
        else if (t === T.GRASS) {
          // Fewer trees right next to the roads that cross the margin.
          const nearRoad = this.isRoad(x - 1, y) || this.isRoad(x + 1, y) || this.isRoad(x, y - 1) || this.isRoad(x, y + 1);
          p = nearRoad ? 0.03 : 0.16;
        }
        if (r() < p) {
          this.trees.push({
            x: x + 0.3 + r() * 0.4,
            y: y + 0.3 + r() * 0.4,
            variant: Math.floor(r() * 3),
          });
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
        // Cliff under the map: grass lip, dirt with strata, rock base.
        const n = hash2(Math.floor(u), Math.floor(v), 7);
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
          return this.paintRoad(masks[i], fu, fv, n);
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
        default:
          return n < 0.12 ? C.grassDark : n > 0.9 ? C.grassLight : C.grass;
      }
    });
    this.ground = buf.toCanvas();
    return this.ground;
  }

  paintRoad(mask, u, v, n) {
    const has = (d) => (mask >> d) & 1;
    const CURB = 0.15;
    // Sidewalk on sides without a connecting road.
    if ((!has(0) && v < CURB) || (!has(1) && u > 1 - CURB) || (!has(2) && v > 1 - CURB) || (!has(3) && u < CURB)) {
      return C.curb;
    }
    if ((!has(0) && v < CURB + 0.05) || (!has(1) && u > 0.95 - CURB) || (!has(2) && v > 0.95 - CURB) || (!has(3) && u < CURB + 0.05)) {
      return C.curbEdge;
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
    return JSON.stringify([neighborhoods.map((d) => [d.name, d.color, d.kind]), targets.map((t) => [t.id, t.neighborhood, t.building, t.color])]);
  }
}

export { DIRS };
