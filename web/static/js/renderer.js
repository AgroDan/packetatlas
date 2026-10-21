// Map renderer: camera, depth-sorted sprite drawing, map pins and labels,
// status effects, hit-testing and the minimap.

import {
  buildingSpec, buildingSprite, carSprite, treeSprite, pinSprite, craneSprite, coneSprite, fireTruckSprite, STATE_COLORS,
} from './sprites.js';

const KIND_SUBTITLE = { namespace: 'k8s namespace', compose: 'compose app' };

export const ZOOMS = [0.5, 1, 1.5, 2, 3, 4, 6];
const BG = '#1b2633';
const MAX_PARTICLES = 5000;

export class Renderer {
  constructor(canvas, minimap) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.mini = minimap;
    this.miniCtx = minimap.getContext('2d');
    this.cam = { x: 0, y: 0, z: 1 };
    this.goal = { x: 0, y: 0, z: 1 };
    this.statuses = new Map();
    this.particles = [];
    this.hover = null;
    this.selected = null;
    this.pinRects = [];
    this.time = 0;
    this.onSelect = () => {};
    this.onHover = () => {};
    this.bindInput();
  }

  setCity(city, traffic) {
    // Fit on the first real map, including after an empty one (discovery
    // that hasn't found anything yet).
    const first = !this.city || this.city.buildings.length === 0;
    this.city = city;
    this.traffic = traffic;
    this.ground = city.renderGround();
    this.minimap = city.renderMinimap(220);
    this.mini.width = this.minimap.canvas.width;
    this.mini.height = this.minimap.canvas.height;
    this.refreshBuildings();
    if (first) this.fit(true);
  }

  setStatuses(statuses) {
    this.statuses = statuses;
    this.refreshBuildings();
  }

  refreshBuildings() {
    if (!this.city) return;
    for (const b of this.city.buildings) {
      const st = this.statuses.get(b.id) || { ...b.target, state: 'unknown' };
      const spec = buildingSpec(st, b.id);
      const sprite = buildingSprite(spec, b.color, b.id);
      const [a, bb] = sprite.footprint;
      const p = this.city.project(b.lot[0] + (3 - a) / 2, b.lot[1] + (3 - bb) / 2);
      b.spec = spec;
      b.sprite = sprite;
      b.state = st.state;
      b.drawX = Math.round(p.x - sprite.anchorX);
      b.drawY = Math.round(p.y - sprite.anchorY);
      b.depth = b.lot[0] + b.lot[1] + 3;
      b.props = this.siteProps(b, sprite);
    }
  }

  // --- camera -------------------------------------------------------------

  get dpr() {
    return window.devicePixelRatio || 1;
  }

  viewSize() {
    return { w: this.canvas.clientWidth, h: this.canvas.clientHeight };
  }

  fit(instant = false) {
    const { w, h } = this.viewSize();
    const zFit = Math.min(w / this.city.worldWidth, h / this.city.worldHeight) * 0.92;
    const z = [...ZOOMS].reverse().find((v) => v <= zFit) || ZOOMS[0];
    this.goal = { x: this.city.worldWidth / 2, y: this.city.worldHeight / 2, z };
    if (instant) this.cam = { ...this.goal };
  }

  /** Centre the camera on a building; leftInset (CSS px) is covered by UI. */
  flyTo(id, z = 3, leftInset = 0) {
    const b = this.city.byId.get(id);
    if (!b) return;
    const p = this.city.project(b.center[0], b.center[1]);
    const nz = Math.max(this.goal.z, z);
    this.goal = { x: p.x - leftInset / 2 / nz, y: p.y - 20, z: nz };
  }

  zoomStep(dir, sx, sy) {
    const { w, h } = this.viewSize();
    if (sx === undefined) [sx, sy] = [w / 2, h / 2];
    const i = ZOOMS.findIndex((v) => v >= this.goal.z - 1e-6);
    const ni = Math.max(0, Math.min(ZOOMS.length - 1, (i < 0 ? ZOOMS.length - 1 : i) + dir));
    const nz = ZOOMS[ni];
    // Keep the world point under the cursor fixed.
    const wx = this.goal.x + (sx - w / 2) / this.goal.z;
    const wy = this.goal.y + (sy - h / 2) / this.goal.z;
    this.goal = { x: wx - (sx - w / 2) / nz, y: wy - (sy - h / 2) / nz, z: nz };
    this.clampGoal();
  }

  panBy(dx, dy) {
    this.goal.x -= dx / this.goal.z;
    this.goal.y -= dy / this.goal.z;
    this.clampGoal();
    this.cam.x = this.goal.x;
    this.cam.y = this.goal.y;
  }

  clampGoal() {
    if (!this.city) return;
    this.goal.x = Math.max(0, Math.min(this.city.worldWidth, this.goal.x));
    this.goal.y = Math.max(-60, Math.min(this.city.worldHeight, this.goal.y));
  }

  stepCamera(dt) {
    const k = 1 - Math.exp(-dt * 9);
    for (const f of ['x', 'y', 'z']) {
      this.cam[f] += (this.goal[f] - this.cam[f]) * k;
      if (Math.abs(this.goal[f] - this.cam[f]) < (f === 'z' ? 0.002 : 0.05)) this.cam[f] = this.goal[f];
    }
  }

  /** Device-pixel transform for the current camera. */
  transform() {
    const dpr = this.dpr;
    const s = this.cam.z * dpr;
    const ox = Math.round(this.canvas.width / 2 - this.cam.x * s);
    const oy = Math.round(this.canvas.height / 2 - this.cam.y * s);
    return { s, ox, oy };
  }

  screenToWorld(sx, sy) {
    const { s, ox, oy } = this.transform();
    return { x: (sx * this.dpr - ox) / s, y: (sy * this.dpr - oy) / s };
  }

  // --- input --------------------------------------------------------------

  bindInput() {
    const cv = this.canvas;
    let drag = null;
    cv.addEventListener('pointerdown', (e) => {
      cv.setPointerCapture(e.pointerId);
      drag = { x: e.clientX, y: e.clientY, moved: 0 };
    });
    cv.addEventListener('pointermove', (e) => {
      const r = cv.getBoundingClientRect();
      if (drag) {
        const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
        drag.moved += Math.abs(dx) + Math.abs(dy);
        drag.x = e.clientX;
        drag.y = e.clientY;
        if (drag.moved > 3) {
          this.panBy(dx, dy);
          cv.classList.add('dragging');
        }
        return;
      }
      const hit = this.pick(e.clientX - r.left, e.clientY - r.top);
      if (hit !== this.hover) {
        this.hover = hit;
        cv.classList.toggle('hovering', !!hit);
        this.onHover(hit);
      }
    });
    const end = (e) => {
      if (!drag) return;
      const r = cv.getBoundingClientRect();
      if (drag.moved <= 3) this.onSelect(this.pick(e.clientX - r.left, e.clientY - r.top));
      drag = null;
      cv.classList.remove('dragging');
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', () => {
      drag = null;
      cv.classList.remove('dragging');
    });
    cv.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        const r = cv.getBoundingClientRect();
        this.wheelAcc = (this.wheelAcc || 0) + e.deltaY;
        if (Math.abs(this.wheelAcc) >= 40) {
          this.zoomStep(this.wheelAcc < 0 ? 1 : -1, e.clientX - r.left, e.clientY - r.top);
          this.wheelAcc = 0;
        }
      },
      { passive: false },
    );

    let miniDrag = false;
    const miniMove = (e) => {
      const r = this.mini.getBoundingClientRect();
      const sx = ((e.clientX - r.left) / r.width) * this.mini.width;
      const sy = ((e.clientY - r.top) / r.height) * this.mini.height;
      this.goal.x = sx / this.minimap.scale;
      this.goal.y = sy / this.minimap.scale;
      this.clampGoal();
    };
    this.mini.addEventListener('pointerdown', (e) => {
      miniDrag = true;
      this.mini.setPointerCapture(e.pointerId);
      miniMove(e);
    });
    this.mini.addEventListener('pointermove', (e) => miniDrag && miniMove(e));
    this.mini.addEventListener('pointerup', () => (miniDrag = false));
  }

  /** Returns the building id under a CSS-pixel screen point, or null. */
  pick(sx, sy) {
    if (!this.city) return null;
    for (let i = this.pinRects.length - 1; i >= 0; i--) {
      const p = this.pinRects[i];
      if (sx >= p.x && sx <= p.x + p.w && sy >= p.y && sy <= p.y + p.h) return p.id;
    }
    const w = this.screenToWorld(sx, sy);
    const sorted = [...this.city.buildings].sort((a, b) => b.depth - a.depth);
    for (const b of sorted) {
      const lx = Math.floor(w.x - b.drawX), ly = Math.floor(w.y - b.drawY);
      if (b.sprite.buf.alpha(lx, ly) > 0) return b.id;
    }
    return null;
  }

  // --- drawing ------------------------------------------------------------

  frame(dt) {
    if (!this.city) return;
    this.time += dt;
    this.stepCamera(dt);
    this.traffic.update(dt, this.statuses);
    this.updateParticles(dt);

    const cv = this.canvas;
    const dpr = this.dpr;
    const W = Math.round(cv.clientWidth * dpr), H = Math.round(cv.clientHeight * dpr);
    if (cv.width !== W || cv.height !== H) {
      cv.width = W;
      cv.height = H;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = BG;
    ctx.fillRect(0, 0, W, H);

    const { s, ox, oy } = this.transform();
    ctx.setTransform(s, 0, 0, s, ox, oy);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.ground, 0, 0);

    const view = { x0: -ox / s - 64, y0: -oy / s - 64, x1: (W - ox) / s + 64, y1: (H - oy) / s + 96 };
    const visible = (x, y, w, h) => x + w > view.x0 && x < view.x1 && y + h > view.y0 && y < view.y1;

    this.drawSelection(ctx);

    const items = [];
    for (const t of this.city.trees) {
      const p = this.city.project(t.x, t.y);
      const sp = treeSprite(t.variant);
      const x = Math.round(p.x - sp.cx), y = Math.round(p.y - sp.cy);
      if (visible(x, y, 16, 24)) items.push({ depth: t.x + t.y, img: sp.canvas, x, y, a: 1 });
    }
    for (const b of this.city.buildings) {
      const c = b.sprite.canvas;
      if (visible(b.drawX, b.drawY, c.width, c.height)) items.push({ depth: b.depth, img: c, x: b.drawX, y: b.drawY, a: 1 });
      const { crane, cones, truck } = b.props;
      if (crane) items.push({ depth: crane.depth, img: crane.sprite.canvas, x: crane.x, y: crane.y, a: 1 });
      for (const cone of cones || []) items.push({ ...cone, a: 1 });
      if (truck) items.push({ depth: truck.depth, img: truck.sprite.canvas, x: truck.x, y: truck.y, a: 1 });
    }
    for (const car of this.traffic.cars) {
      const axis = Math.abs(car.dx) >= Math.abs(car.dy) ? 'x' : 'y';
      const fwd = axis === 'x' ? car.dx > 0 : car.dy > 0;
      const sp = carSprite(car.type, car.color, axis, fwd);
      const p = this.city.project(car.x, car.y);
      const x = Math.round(p.x - sp.cx), y = Math.round(p.y - sp.cy);
      if (visible(x, y, 20, 20)) items.push({ depth: car.x + car.y, img: sp.canvas, x, y, a: car.alpha });
    }
    items.sort((a, b) => a.depth - b.depth);
    for (const it of items) {
      ctx.globalAlpha = it.a;
      ctx.drawImage(it.img, it.x, it.y);
    }
    ctx.globalAlpha = 1;

    this.drawEffects(ctx);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.drawNeighborhoodLabels(ctx, s, ox, oy);
    this.drawPins(ctx, s, ox, oy);
    this.drawMinimap();
  }

  drawSelection(ctx) {
    const id = this.selected;
    const b = id && this.city.byId.get(id);
    if (!b) return;
    const [x0, y0] = b.lot;
    const pts = [
      this.city.project(x0 - 0.15, y0 - 0.15),
      this.city.project(x0 + 3.15, y0 - 0.15),
      this.city.project(x0 + 3.15, y0 + 3.15),
      this.city.project(x0 - 0.15, y0 + 3.15),
    ];
    const pulse = 0.5 + 0.5 * Math.sin(this.time * 4);
    ctx.beginPath();
    pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = `rgba(80,170,255,${0.15 + pulse * 0.15})`;
    ctx.fill();
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(120,200,255,${0.6 + pulse * 0.4})`;
    ctx.stroke();
  }

  drawEffects(ctx) {
    const t = this.time;
    // Fire glow around burning buildings.
    ctx.globalCompositeOperation = 'lighter';
    for (const b of this.city.buildings) {
      if (b.state !== 'down') continue;
      const c = b.sprite.canvas;
      const cx = b.drawX + c.width / 2, cy = b.drawY + c.height * 0.6;
      const r = Math.max(c.width, c.height * 0.6) * 0.85;
      const flicker = 0.34 + 0.08 * Math.sin(t * 13 + b.depth) + 0.05 * Math.sin(t * 31 + b.depth * 3);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      g.addColorStop(0, `rgba(255,140,40,${flicker})`);
      g.addColorStop(1, 'rgba(255,70,20,0)');
      ctx.fillStyle = g;
      ctx.fillRect(cx - r, cy - r, r * 2, r * 2);
    }
    ctx.globalCompositeOperation = 'source-over';

    // Beacons: aviation lights on masts, amber flashers on construction sites.
    for (const b of this.city.buildings) {
      const bc = b.sprite.beacon;
      if (!bc) continue;
      let color = null, on = false;
      if (b.state === 'degraded') {
        color = '#ffb020';
        on = Math.sin(t * 4) > 0;
      } else if (b.state === 'up' && (b.spec.kind === 'tower' || b.spec.kind === 'radio' || b.spec.kind === 'deco')) {
        color = '#ff4d4d';
        on = (t + b.depth * 0.37) % 2 < 0.25;
      }
      if (on) this.light(ctx, b.drawX + bc.x, b.drawY + bc.y, color);
    }

    for (const b of this.city.buildings) {
      const { crane, truck } = b.props || {};
      if (crane) {
        // Trolley rides along the jib; the hook and its load bob on the cable.
        const sp = crane.sprite, ph = b.depth * 1.7;
        const k = 0.5 + 0.5 * Math.sin(t * 0.45 + ph);
        const tx = crane.x + sp.jib0.x + (sp.jib1.x - sp.jib0.x) * k;
        const ty = crane.y + sp.jib0.y + (sp.jib1.y - sp.jib0.y) * k;
        const len = Math.round(16 + 9 * Math.sin(t * 0.6 + ph));
        const sway = Math.round(Math.sin(t * 1.3 + ph));
        const x = Math.round(tx), y = Math.round(ty);
        ctx.fillStyle = '#3d3a35';
        ctx.fillRect(x - 1, y, 3, 2);
        ctx.fillRect(x, y + 2, 1, len);
        ctx.fillRect(x - 1 + sway, y + 2 + len, 2, 2);
        ctx.fillStyle = '#c9562c';
        ctx.fillRect(x - 4 + sway, y + 4 + len, 8, 2);
        ctx.fillStyle = '#8f3a1c';
        ctx.fillRect(x - 4 + sway, y + 5 + len, 8, 1);
        if (Math.sin(t * 3 + ph) > 0.3) this.light(ctx, crane.x + sp.light.x, crane.y + sp.light.y, '#ff4d4d');
      }
      if (truck) {
        const red = Math.sin(t * 14) > 0;
        truck.sprite.lights.forEach((l, i) => {
          const on = i === 0 ? red : !red;
          if (on) this.light(ctx, Math.round(truck.wx + l.x), Math.round(truck.wy + l.y), i === 0 ? '#ff2a2a' : '#3a7bff');
        });
      }
    }

    // Particles: smoke and water normally, flames and embers additively.
    for (const pass of ['normal', 'glow']) {
      ctx.globalCompositeOperation = pass === 'glow' ? 'lighter' : 'source-over';
      for (const p of this.particles) {
        const glow = p.kind === 'flame' || p.kind === 'ember';
        if (glow !== (pass === 'glow')) continue;
        const f = p.life / p.max;
        let color = p.color, a = p.a0 * (1 - f);
        if (p.kind === 'flame') {
          color = f < 0.2 ? '#ffe27a' : f < 0.45 ? '#ffb52e' : f < 0.7 ? '#ff7a18' : '#d8401a';
          a = 0.8 - f * 0.45;
        }
        ctx.globalAlpha = Math.max(0, a);
        ctx.fillStyle = color;
        const r = Math.max(1, Math.round(p.r0 + p.grow * p.life));
        ctx.fillRect(Math.round(p.x - r / 2), Math.round(p.y - r / 2), r, r);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  light(ctx, x, y, color) {
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x + 0.5, y + 0.5, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.fillRect(x - 1, y - 1, 2, 2);
  }

  updateParticles(dt) {
    const room = this.particles.length < MAX_PARTICLES;
    const spawn = (rate) => {
      const n = rate * dt;
      return Math.floor(n) + (Math.random() < n % 1 ? 1 : 0);
    };
    const rand = (a, b) => a + Math.random() * (b - a);
    for (const b of this.city.buildings) {
      if (!room) break;
      if (b.state === 'down') {
        for (const e of b.sprite.fire) {
          const x = b.drawX + e.x, y = b.drawY + e.y;
          for (let i = spawn(e.roof ? 28 : 10); i > 0; i--) {
            this.particles.push({
              kind: 'flame', x: x + rand(-4, 4) * (e.roof ? 1.5 : 0.6), y,
              vx: rand(-4, 4), vy: -rand(18, 38) * (e.roof ? 1 : 0.7),
              r0: e.roof ? 5.5 : 3.5, grow: -5, life: 0, max: rand(0.5, 0.95),
            });
          }
          if (!e.roof) continue;
          for (let i = spawn(6); i > 0; i--) {
            this.particles.push({
              kind: 'smoke', x: x + rand(-3, 3), y: y - 12, vx: rand(2, 6), vy: -rand(10, 17),
              r0: 4, grow: 4, life: 0, max: rand(3, 4.5), a0: 0.75,
              color: Math.random() < 0.5 ? '#2c2a2b' : '#4a4748',
            });
          }
          for (let i = spawn(2); i > 0; i--) {
            this.particles.push({
              kind: 'ember', x: x + rand(-4, 4), y: y - 2, vx: rand(-7, 7), vy: -rand(25, 45),
              r0: 1, grow: 0, life: 0, max: rand(0.8, 1.6), a0: 1, color: '#ffd27a',
            });
          }
        }
        // The fire crew's hose arcs from the truck onto the roof.
        const truck = b.props?.truck;
        const target = b.sprite.fire[0];
        if (truck && target) {
          const sx = truck.wx, sy = truck.wy - 8;
          const tx = b.drawX + target.x, ty = b.drawY + target.y;
          const T = 0.9, g = 70;
          for (let i = spawn(20); i > 0; i--) {
            this.particles.push({
              kind: 'water', x: sx, y: sy, vx: (tx - sx) / T + rand(-4, 4), vy: (ty - sy) / T - 0.5 * g * T + rand(-4, 4),
              g, r0: 2, grow: 0, life: 0, max: T, a0: 1, color: '#9fd8ff',
            });
          }
        }
      } else if (b.state === 'up' && (b.spec.kind === 'factory' || b.spec.kind === 'house') && b.sprite.smoke) {
        const sm = b.sprite.smoke;
        for (let i = spawn(b.spec.kind === 'house' ? 0.8 : 3); i > 0; i--) {
          this.particles.push({
            kind: 'smoke', x: b.drawX + sm.x + rand(-2, 2), y: b.drawY + sm.y - 2, vx: rand(2, 5), vy: -rand(7, 13),
            r0: 2, grow: 2.2, life: 0, max: 2, a0: 0.8, color: '#e8ecef',
          });
        }
      }
    }
    for (const p of this.particles) {
      p.life += dt;
      if (p.g) p.vy += p.g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.particles = this.particles.filter((p) => p.life < p.max);
  }

  /** Props around a building that depend on its state. */
  siteProps(b, sprite) {
    const city = this.city;
    const [x0, y0] = b.lot;
    if (b.state === 'degraded') {
      // Crane on the lot's front-left edge, cones on the front corner.
      const crane = craneSprite(sprite.height + 22);
      const p = city.project(x0 + 0.25, y0 + 2.88);
      const cone = coneSprite();
      const cones = [[2.88, 2.3], [2.88, 2.88], [2.3, 2.88]].map(([dx, dy]) => {
        const q = city.project(x0 + dx, y0 + dy);
        return { x: Math.round(q.x - cone.cx), y: Math.round(q.y - cone.cy), depth: x0 + y0 + dx + dy, img: cone.canvas };
      });
      return {
        crane: { sprite: crane, x: Math.round(p.x - crane.baseX), y: Math.round(p.y - crane.baseY), depth: x0 + y0 + 3.13 },
        cones,
      };
    }
    if (b.state === 'down') {
      // Fire engine pulled half onto the lot by the driveway.
      const [dx, dy] = b.drive;
      const alongY = city.isRoad(dx, dy - 1) || city.isRoad(dx, dy + 1);
      const tx = dx + 0.5 + (b.door[0] - dx - 0.5) * 0.55;
      const ty = dy + 0.5 + (b.door[1] - dy - 0.5) * 0.55;
      const sp = fireTruckSprite(alongY ? 'y' : 'x');
      const p = city.project(tx, ty);
      return { truck: { sprite: sp, x: Math.round(p.x - sp.cx), y: Math.round(p.y - sp.cy), wx: p.x, wy: p.y, depth: tx + ty } };
    }
    return {};
  }

  drawPins(ctx, s, ox, oy) {
    const dpr = this.dpr;
    const ps = Math.max(2, Math.round(1.5 * dpr)); // device px per pin pixel
    const showLabels = this.cam.z >= 1.5;
    const fontPx = Math.round(12 * dpr);
    ctx.font = `600 ${fontPx}px "Pixelify Sans", ui-monospace, monospace`;
    ctx.textBaseline = 'middle';
    ctx.imageSmoothingEnabled = false;
    this.pinRects = [];

    const order = [...this.city.buildings].sort((a, b) => a.depth - b.depth);
    for (const b of order) {
      const pin = pinSprite(b.state || 'unknown');
      const bc = b.sprite.beacon || { x: b.sprite.anchorX, y: 0 };
      const tipX = Math.round((b.drawX + bc.x) * s + ox);
      let tipY = Math.round((b.drawY + bc.y - 3) * s + oy);
      const active = b.id === this.selected || b.id === this.hover;
      if (b.id === this.selected) tipY -= Math.round(Math.abs(Math.sin(this.time * 5)) * 6 * dpr);
      const scale = active ? ps + 1 : ps;
      const w = pin.w * scale, h = pin.h * scale;
      const x = tipX - Math.round(w / 2), y = tipY - h;
      if (x + w < 0 || y + h < 0 || x > this.canvas.width || y > this.canvas.height) continue;
      ctx.drawImage(pin.canvas, x, y, w, h);
      this.pinRects.push({ id: b.id, x: x / dpr, y: y / dpr, w: w / dpr, h: h / dpr });

      if (showLabels || active) {
        const label = b.target.name;
        const lx = x + w + 4 * dpr, ly = y + h * 0.35;
        ctx.lineWidth = 3 * dpr;
        ctx.strokeStyle = 'rgba(15,20,28,0.9)';
        ctx.strokeText(label, lx, ly);
        ctx.fillStyle = active ? '#ffffff' : '#e8edf3';
        ctx.fillText(label, lx, ly);
      }
    }
  }

  drawNeighborhoodLabels(ctx, s, ox, oy) {
    // Building names take over from 1.5x (see drawPins).
    if (this.cam.z >= 1.5) return;
    const dpr = this.dpr;
    const fontPx = Math.round(15 * dpr);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // Bigger neighborhoods claim their spot first; a label that would
    // overlap one already drawn waits until the user zooms in.
    const placed = [];
    const order = [...this.city.neighborhoods].sort((a, b) => b.targets.length - a.targets.length);
    for (const d of order) {
      // Label sits on the neighborhood's front (bottom) street corner.
      const p = this.city.project(...this.city.labelAnchor(d));
      const x = p.x * s + ox, y = p.y * s + oy + 14 * dpr;
      const name = d.name.toUpperCase();
      const sub = KIND_SUBTITLE[d.kind];
      ctx.font = `700 ${fontPx}px "Pixelify Sans", ui-monospace, monospace`;
      // Pad the box so neighbours keep a visible gap, not just no overlap.
      const w = ctx.measureText(name).width + 28 * dpr;
      const box = { x0: x - w / 2, x1: x + w / 2, y0: y - fontPx, y1: y + fontPx * (sub ? 1.9 : 1) };
      if (placed.some((o) => box.x0 < o.x1 && o.x0 < box.x1 && box.y0 < o.y1 && o.y0 < box.y1)) continue;
      placed.push(box);

      ctx.lineWidth = 4 * dpr;
      ctx.strokeStyle = 'rgba(15,20,28,0.85)';
      ctx.strokeText(name, x, y);
      ctx.fillStyle = d.color;
      ctx.fillText(name, x, y);
      if (sub) {
        ctx.font = `600 ${Math.round(10 * dpr)}px "Pixelify Sans", ui-monospace, monospace`;
        ctx.lineWidth = 3 * dpr;
        ctx.strokeText(sub, x, y + fontPx);
        ctx.fillStyle = '#d5dce6';
        ctx.fillText(sub, x, y + fontPx);
      }
    }
    ctx.textAlign = 'left';
  }

  drawMinimap() {
    const m = this.miniCtx;
    const mm = this.minimap;
    m.setTransform(1, 0, 0, 1, 0, 0);
    m.clearRect(0, 0, this.mini.width, this.mini.height);
    m.drawImage(mm.canvas, 0, 0);
    for (const b of this.city.buildings) {
      const p = this.city.project(b.center[0], b.center[1]);
      m.fillStyle = STATE_COLORS[b.state] || STATE_COLORS.unknown;
      m.fillRect(Math.round(p.x * mm.scale) - 2, Math.round(p.y * mm.scale) - 2, 4, 4);
    }
    const { w, h } = this.viewSize();
    const z = this.cam.z;
    const vx = (this.cam.x - w / 2 / z) * mm.scale, vy = (this.cam.y - h / 2 / z) * mm.scale;
    m.strokeStyle = '#ffffff';
    m.lineWidth = 1.5;
    m.strokeRect(vx, vy, (w / z) * mm.scale, (h / z) * mm.scale);
  }
}

