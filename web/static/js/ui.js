// DOM chrome around the map: search, info panel, status summary, tooltip.

import { STATE_COLORS } from './sprites.js';

const $ = (sel, root = document) => root.querySelector(sel);

export function fmtRate(v, unit = 'B/s') {
  if (!isFinite(v)) return '—';
  if (unit !== 'B/s') return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${unit}`;
  const units = ['B/s', 'kB/s', 'MB/s', 'GB/s', 'TB/s'];
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${v >= 100 || i === 0 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function ago(iso) {
  const t = Date.parse(iso);
  if (!t || t < 0) return 'never';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
}

const TYPE_LABEL = { kubernetes: 'Kubernetes', docker: 'Docker', ping: 'Ping', http: 'HTTP', tcp: 'TCP' };
const KIND_LABEL = { namespace: 'namespace', compose: 'compose app' };

export class UI {
  constructor(renderer) {
    this.r = renderer;
    this.snap = null;
    this.byId = new Map();
    this.selected = null;
    this.downCursor = 0;

    this.panel = $('#panel');
    this.search = $('#search');
    this.results = $('#results');
    this.summary = $('#summary');
    this.tooltip = $('#tooltip');

    renderer.onSelect = (id) => this.select(id, false);
    renderer.onHover = (id) => this.showTooltip(id);

    $('#zin').onclick = () => renderer.zoomStep(1);
    $('#zout').onclick = () => renderer.zoomStep(-1);
    $('#zfit').onclick = () => renderer.fit();
    $('.close', this.panel).onclick = () => this.select(null);

    this.search.addEventListener('input', () => this.renderResults());
    this.search.addEventListener('focus', () => this.renderResults());
    this.search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const first = this.results.querySelector('li[data-id]');
        if (first) this.pickResult(first.dataset.id);
      } else if (e.key === 'Escape') {
        this.search.blur();
        this.results.hidden = true;
      }
    });
    document.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('.searchbar')) this.results.hidden = true;
    });
    window.addEventListener('keydown', (e) => {
      if (e.target === this.search) return;
      const pan = 60;
      const keys = {
        ArrowLeft: () => renderer.panBy(pan, 0),
        ArrowRight: () => renderer.panBy(-pan, 0),
        ArrowUp: () => renderer.panBy(0, pan),
        ArrowDown: () => renderer.panBy(0, -pan),
        '+': () => renderer.zoomStep(1),
        '=': () => renderer.zoomStep(1),
        '-': () => renderer.zoomStep(-1),
        Escape: () => this.select(null),
        '/': () => this.search.focus(),
      };
      if (keys[e.key]) {
        e.preventDefault();
        keys[e.key]();
      }
    });
    document.addEventListener('pointermove', (e) => {
      this.tooltip.style.transform = `translate(${e.clientX + 14}px, ${e.clientY + 14}px)`;
    });
  }

  update(snap, byId) {
    this.snap = snap;
    this.byId = byId;
    $('#demo').hidden = !snap.demo;
    this.renderSummary();
    if (this.selected) this.renderPanel();
    if (!this.results.hidden) this.renderResults();
    if (this.r.hover) this.showTooltip(this.r.hover);

    if (!this.initialHash) {
      this.initialHash = true;
      const id = decodeURIComponent(location.hash.replace(/^#/, ''));
      if (id && byId.has(id)) this.select(id, true);
    }
  }

  setConnected(ok) {
    $('#conn').hidden = ok;
  }

  // --- selection & panel --------------------------------------------------

  select(id, fly = true) {
    this.selected = id;
    this.r.selected = id;
    this.panel.classList.toggle('open', !!id);
    history.replaceState(null, '', id ? `#${encodeURIComponent(id)}` : location.pathname);
    if (!id) return;
    // Keep the building clear of the side panel on wide screens.
    if (fly) this.r.flyTo(id, 3, window.innerWidth > 720 ? this.panel.offsetWidth : 0);
    this.renderPanel();
  }

  renderPanel() {
    const t = this.byId.get(this.selected);
    if (!t) return;
    const body = $('.panel-body', this.panel);
    const neighborhood = this.snap.neighborhoods.find((d) => d.name === t.neighborhood);
    // The map assigns palette colours to neighborhoods the config doesn't colour.
    const color = this.r.city?.neighborhoods.find((d) => d.name === t.neighborhood)?.color || '#888';
    const kind = KIND_LABEL[neighborhood?.kind];

    body.innerHTML = `
      <h2>${esc(t.name)}</h2>
      <div class="sub">
        <span class="swatch" style="background:${esc(color)}"></span>${esc(t.neighborhood)}${kind ? ` <span class="kind">${kind}</span>` : ''}
        · ${TYPE_LABEL[t.type] || esc(t.type)} · ${esc(t.building)}${t.discovered ? ' <span class="kind" title="Found by discovery, not declared in config">discovered</span>' : ''}${t.cluster ? ` <span class="kind" title="Reported by this cluster's agent">cluster ${esc(t.cluster)}</span>` : ''}
      </div>
      <div class="state-row">
        <span class="pill" style="--c:${STATE_COLORS[t.state] || STATE_COLORS.unknown}">${esc(t.state)}</span>
        <span class="detail">${esc(t.detail || '')}</span>
      </div>
      ${t.error ? `<div class="error">${esc(t.error)}</div>` : ''}
      <div class="stats">
        <div><label>Uptime</label><b>${t.checks ? t.uptime.toFixed(2) + '%' : '—'}</b><small>${t.checks} checks</small></div>
        <div><label>Latency</label><b>${t.checks ? t.latencyMs.toFixed(1) + ' ms' : '—'}</b><small>last check</small></div>
        <div><label>Inbound</label><b>${t.hasTraffic ? fmtRate(t.rxRate, t.trafficUnit) : '—'}</b><small>rx · cars arriving</small></div>
        <div><label>Outbound</label><b>${t.hasTraffic ? fmtRate(t.txRate, t.trafficUnit) : '—'}</b><small>tx · cars leaving</small></div>
      </div>
      <h3>Traffic</h3>
      ${t.hasTraffic ? '<canvas class="spark"></canvas>' : '<p class="muted">No traffic data for this target — streets show light ambient traffic while it is up.</p>'}
      <h3>Status history</h3>
      <div class="strip">${t.history.map((h) => `<i style="background:${STATE_COLORS[h.state]}" title="${esc(h.state)} · ${new Date(h.t).toLocaleTimeString()}"></i>`).join('')}</div>
      ${t.pods?.length ? this.podsTable(t) : ''}
      <p class="muted small">Last checked ${ago(t.lastCheck)} · <code>${esc(t.id)}</code></p>
    `;
    if (t.hasTraffic) this.drawSpark($('.spark', body), t);
    this.drawThumb(t);
  }

  podsTable(t) {
    // Docker containers have no node or restart count in the list API; show status instead.
    const docker = t.type === 'docker';
    const noun = docker ? 'container' : 'pod';
    const rows = t.pods
      .map(
        (p) => `<tr>
          <td><span class="dot" style="background:${p.ready ? STATE_COLORS.up : STATE_COLORS.down}"></span>${esc(p.name)}</td>
          <td>${esc((docker ? p.phase : p.node) || '—')}</td>
          ${docker ? '' : `<td class="num">${p.restarts}</td>`}
          <td class="num">${fmtRate(p.rxRate + p.txRate)}</td>
        </tr>`,
      )
      .join('');
    return `<h3>${noun}s <span class="muted">${t.ready}/${t.replicas} ready · 1 floor = 1 ${noun}</span></h3>
      <table class="pods"><thead><tr><th>${docker ? 'Container' : 'Pod'}</th><th>${docker ? 'Status' : 'Node'}</th>${docker ? '' : '<th class="num">Restarts</th>'}<th class="num">Traffic</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  drawSpark(cv, t) {
    const dpr = window.devicePixelRatio || 1;
    const w = cv.clientWidth, h = 70;
    cv.width = w * dpr;
    cv.height = h * dpr;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    const hist = t.history;
    if (hist.length < 2) {
      ctx.fillStyle = getComputedStyle(cv).color;
      ctx.font = '12px "Pixelify Sans", monospace';
      ctx.fillText('collecting samples…', 4, h / 2);
      return;
    }
    const max = Math.max(1, ...hist.map((s) => s.rx + s.tx));
    const x = (i) => (i / (hist.length - 1)) * (w - 2) + 1;
    const y = (v) => h - 4 - (v / max) * (h - 16);
    const series = [
      { key: (s) => s.rx + s.tx, color: '#5aa9ff', fill: 'rgba(90,169,255,0.18)' },
      { key: (s) => s.rx, color: '#3fbf6a', fill: null },
    ];
    for (const { key, color, fill } of series) {
      ctx.beginPath();
      hist.forEach((s, i) => (i ? ctx.lineTo(x(i), y(key(s))) : ctx.moveTo(x(i), y(key(s)))));
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      if (fill) {
        ctx.lineTo(x(hist.length - 1), h);
        ctx.lineTo(x(0), h);
        ctx.fillStyle = fill;
        ctx.fill();
      }
    }
    ctx.fillStyle = getComputedStyle(cv).color;
    ctx.font = '11px "Pixelify Sans", monospace';
    ctx.fillText(`peak ${fmtRate(max, t.trafficUnit)}`, 4, 10);
    ctx.textAlign = 'right';
    ctx.fillStyle = '#5aa9ff';
    ctx.fillText('total', w - 44, 10);
    ctx.fillStyle = '#3fbf6a';
    ctx.fillText('rx', w - 4, 10);
  }

  drawThumb(t) {
    const b = this.r.city?.byId.get(t.id);
    const cv = $('.thumb', this.panel);
    if (!b?.sprite) return;
    const src = b.sprite.canvas;
    const scale = Math.max(2, Math.floor(Math.min(300 / src.width, 190 / src.height)));
    cv.width = src.width * scale;
    cv.height = src.height * scale;
    const ctx = cv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, cv.width, cv.height);
  }

  // --- search -------------------------------------------------------------

  renderResults() {
    if (!this.snap) return;
    const q = this.search.value.trim().toLowerCase();
    const matches = this.snap.targets
      .filter((t) => !q || `${t.name} ${t.neighborhood} ${TYPE_LABEL[t.type] || t.type} ${t.state}`.toLowerCase().includes(q))
      .slice(0, 12);
    this.results.innerHTML = matches.length
      ? matches
          .map(
            (t) => `<li data-id="${esc(t.id)}">
              <span class="dot" style="background:${STATE_COLORS[t.state] || STATE_COLORS.unknown}"></span>
              <span class="name">${esc(t.name)}</span>
              <span class="where">${esc(t.neighborhood)} · ${TYPE_LABEL[t.type] || esc(t.type)}</span>
            </li>`,
          )
          .join('')
      : '<li class="muted">No matches</li>';
    this.results.hidden = false;
    for (const li of this.results.querySelectorAll('li[data-id]')) {
      li.onclick = () => this.pickResult(li.dataset.id);
    }
  }

  pickResult(id) {
    this.results.hidden = true;
    this.search.value = '';
    this.search.blur();
    this.select(id, true);
  }

  // --- summary & tooltip --------------------------------------------------

  renderSummary() {
    const counts = { up: 0, degraded: 0, down: 0, unknown: 0 };
    for (const t of this.snap.targets) counts[t.state] = (counts[t.state] || 0) + 1;
    const totalTraffic = this.snap.targets.reduce((s, t) => s + (t.trafficUnit === 'B/s' ? t.rxRate + t.txRate : 0), 0);
    this.summary.innerHTML =
      ['up', 'degraded', 'down', 'unknown']
        .filter((s) => counts[s] || s === 'up')
        .map((s) => `<button class="chip" data-state="${s}" title="Jump to ${s} services"><span class="dot" style="background:${STATE_COLORS[s]}"></span>${counts[s]} ${s}</button>`)
        .join('') + `<span class="chip static">⇅ ${fmtRate(totalTraffic)}</span>`;
    for (const btn of this.summary.querySelectorAll('button.chip')) {
      btn.onclick = () => this.cycleState(btn.dataset.state);
    }
  }

  cycleState(state) {
    const list = this.snap.targets.filter((t) => t.state === state);
    if (!list.length) return;
    this.downCursor = (this.downCursor + 1) % list.length;
    this.select(list[this.downCursor].id, true);
  }

  showTooltip(id) {
    const t = id && this.byId.get(id);
    if (!t) {
      this.tooltip.hidden = true;
      return;
    }
    this.tooltip.hidden = false;
    this.tooltip.innerHTML = `
      <b>${esc(t.name)}</b>
      <span class="pill sm" style="--c:${STATE_COLORS[t.state] || STATE_COLORS.unknown}">${esc(t.state)}</span><br>
      <span class="muted">${esc(t.detail || t.error || '')}</span><br>
      ${t.hasTraffic ? `↓ ${fmtRate(t.rxRate, t.trafficUnit)} · ↑ ${fmtRate(t.txRate, t.trafficUnit)}` : `${t.latencyMs.toFixed(1)} ms`}
    `;
  }
}
