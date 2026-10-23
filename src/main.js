import { Simulation } from './sim/index.js';
import { World } from './render/world.js';
import { UI } from './ui/ui.js';

const params = new URLSearchParams(location.search);
const sim = new Simulation({ scenario: params.get('scenario') ?? 'urban' });

let world;
try {
  world = new World(document.getElementById('viewport'), sim);
} catch (err) {
  document.querySelector('#loader p').textContent = 'WebGL is not available in this browser, so the 3D view cannot start.';
  throw err;
}
const ui = new UI(sim, world);

let last = performance.now();
let frames = 0;
function frame(now) {
  const dt = Math.min(100, now - last);
  last = now;
  if (ui.running) sim.advance(dt * ui.speed);
  world.update(dt, now);
  ui.update(dt);
  if (++frames === 3) document.getElementById('loader').classList.add('done');
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Handy for poking at the model from the devtools console.
window.handoverLab = { sim, world, ui };
