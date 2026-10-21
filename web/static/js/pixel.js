// Pixel-art primitives: an RGBA buffer, colour helpers, deterministic noise,
// and an isometric box rasteriser that every sprite and the ground use.

export const TILE_W = 32; // diamond width in world pixels
export const TILE_H = 16; // diamond height
export const AX = TILE_W / 2; // pixels per tile along an iso axis (screen x component)

export function hexToRgb(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToCss([r, g, b], a = 1) {
  return a === 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}

export function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** f > 0 lightens towards white, f < 0 darkens towards black. */
export function shade(c, f) {
  return f >= 0 ? mix(c, [255, 255, 255], f) : mix(c, [0, 0, 0], -f);
}

/** Cheap integer hash → [0, 1). */
export function hash2(x, y, seed = 0) {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function strHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class PixBuf {
  constructor(w, h) {
    this.w = Math.ceil(w);
    this.h = Math.ceil(h);
    this.data = new Uint8ClampedArray(this.w * this.h * 4);
  }

  set(x, y, c, a = 255) {
    x |= 0;
    y |= 0;
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const d = this.data;
    if (a >= 255) {
      d[i] = c[0];
      d[i + 1] = c[1];
      d[i + 2] = c[2];
      d[i + 3] = 255;
      return;
    }
    const t = a / 255;
    const ia = d[i + 3] / 255;
    const oa = t + ia * (1 - t);
    for (let k = 0; k < 3; k++) d[i + k] = oa ? (c[k] * t + d[i + k] * ia * (1 - t)) / oa : 0;
    d[i + 3] = oa * 255;
  }

  alpha(x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.data[((y | 0) * this.w + (x | 0)) * 4 + 3];
  }

  rect(x, y, w, h, c, a = 255) {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.set(x + i, y + j, c, a);
  }

  toCanvas() {
    const cv = document.createElement('canvas');
    cv.width = this.w;
    cv.height = this.h;
    cv.getContext('2d').putImageData(new ImageData(this.data, this.w, this.h), 0, 0);
    return cv;
  }
}

/**
 * Rasterise an isometric box.
 *
 * (ox, oy) is the top vertex of the box's top face in buffer pixels.
 * ax / by are the footprint lengths along the iso x / y axes in axis pixels
 * (16 per tile), h the height in pixels.
 *
 * paint(face, u, v, faceW, faceH) returns an [r,g,b] colour or null to skip:
 *   face 'top':   u, v are axis-pixel coords on the roof (0..ax, 0..by)
 *   face 'left':  the +y facing wall (front-left), u along it 0..ax, v from top 0..h
 *   face 'right': the +x facing wall (front-right), u along it 0..by, v from top
 */
export function rasterBox(buf, ox, oy, ax, by, h, paint) {
  for (let c = -by; c < ax; c++) {
    const cc = c + 0.5;
    const yU = Math.round(Math.abs(cc) / 2);
    const leftSide = cc < ax - by;
    const yL = Math.round(leftSide ? by + cc / 2 : ax - cc / 2);
    for (let y = yU; y < yL; y++) {
      const yc = y + 0.5;
      const col = paint('top', cc / 2 + yc, yc - cc / 2, ax, by);
      if (col) buf.set(ox + c, oy + y, col);
    }
    for (let y = yL; y < yL + h; y++) {
      const col = leftSide
        ? paint('left', c + by, y - yL, ax, h)
        : paint('right', c - (ax - by), y - yL, by, h);
      if (col) buf.set(ox + c, oy + y, col);
    }
  }
}
