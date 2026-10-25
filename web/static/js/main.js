import { City } from './city.js';
import { Traffic } from './traffic.js';
import { Renderer } from './renderer.js';
import { UI } from './ui.js';

const renderer = new Renderer(document.getElementById('map'), document.getElementById('minimap'));
const ui = new UI(renderer);
let signature = null;

// ?environment=islands previews another environment without touching config.
const envOverride = new URLSearchParams(location.search).get('environment');

function apply(snap) {
  const env = envOverride || snap.environment;
  const sig = City.signature(snap.neighborhoods, snap.targets, env);
  if (sig !== signature) {
    signature = sig;
    const city = new City(snap.neighborhoods, snap.targets, env);
    renderer.setCity(city, new Traffic(city));
  }
  const empty = document.getElementById('empty');
  empty.hidden = snap.targets.length > 0;
  empty.textContent = snap.discovery ? 'Discovering… no workloads found yet.' : 'No targets configured.';
  const byId = new Map(snap.targets.map((t) => [t.id, t]));
  renderer.setStatuses(byId);
  ui.update(snap, byId);
}

function connect() {
  const es = new EventSource('api/stream');
  es.onopen = () => ui.setConnected(true);
  es.onmessage = (e) => apply(JSON.parse(e.data));
  es.onerror = () => ui.setConnected(false); // EventSource reconnects on its own
}

let last = performance.now();
function loop(now) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  renderer.frame(dt);
  requestAnimationFrame(loop);
}

// Labels are drawn on the canvas, so wait briefly for the pixel font.
Promise.race([document.fonts.load('600 12px "Pixelify Sans"'), new Promise((r) => setTimeout(r, 1500))]).finally(() => {
  connect();
  requestAnimationFrame(loop);
});
