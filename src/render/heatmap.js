import * as THREE from 'three';
import { TECH } from '../sim/config.js';
import { medianRsrp, noisePerReDbm, sinrDb, loadFactor } from '../sim/radio.js';

const RES = 128;
const FRAME_BUDGET_MS = 5;
const BODY_LOSS = 3;

// Shared colour ramp for SINR and RSRP maps (poor → excellent).
export const RAMP = ['#c62828', '#ff7043', '#ffca28', '#9ccc65', '#26c6da', '#7c4dff'];
export const SCALES = {
  sinr: { min: -6, max: 30, unit: 'dB', title: 'SINR' },
  rsrp: { min: -125, max: -60, unit: 'dBm', title: 'RSRP' },
};

const rampRgb = RAMP.map((h) => {
  const c = new THREE.Color(h);
  return [c.r * 255, c.g * 255, c.b * 255];
});
const techRgb = Object.fromEntries(
  Object.values(TECH).map((t) => {
    const c = new THREE.Color(t.color);
    return [t.id, [c.r * 255, c.g * 255, c.b * 255]];
  }),
);

function ramp(t, out) {
  t = Math.max(0, Math.min(1, t)) * (rampRgb.length - 1);
  const i = Math.min(rampRgb.length - 2, Math.floor(t));
  const f = t - i;
  const a = rampRgb[i];
  const b = rampRgb[i + 1];
  out[0] = a[0] + (b[0] - a[0]) * f;
  out[1] = a[1] + (b[1] - a[1]) * f;
  out[2] = a[2] + (b[2] - a[2]) * f;
  return out;
}

// Ground-level coverage map computed progressively (a few rows per frame)
// so editing the network never freezes the view.
export class Heatmap {
  constructor(sim) {
    this.sim = sim;
    this.mode = 'off';
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = RES;
    this.ctx = this.canvas.getContext('2d');
    this.image = this.ctx.createImageData(RES, RES);
    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearFilter;
    // Darkened so the map stays below the bloom threshold and reads as a floor tint.
    this.material = new THREE.MeshBasicMaterial({ map: this.texture, color: 0x8c8c8c, transparent: true, opacity: 0, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.material);
    this.mesh.rotation.x = -Math.PI / 2;
    this.mesh.position.y = 0.35;
    this.mesh.renderOrder = 1;
    this.mesh.raycast = () => {};
    this.row = RES;
    this.refreshTimer = 0;
    this.resize();
  }

  resize() {
    const extent = this.sim.city.half + this.sim.city.blockPitch * 0.5;
    this.extent = extent;
    this.mesh.scale.set(extent * 2, extent * 2, 1);
  }

  setMode(mode) {
    this.mode = mode;
    this.invalidate();
  }

  invalidate() {
    if (this.mode === 'off') return;
    this.row = 0;
    this.towers = [...this.sim.towers.values()].filter((t) => t.enabled);
  }

  step(dtMs) {
    const target = this.mode === 'off' ? 0 : 0.7;
    this.material.opacity += (target - this.material.opacity) * Math.min(1, dtMs * 0.006);
    this.mesh.visible = this.material.opacity > 0.01;
    if (this.mode === 'off') return;

    // SINR depends on cell load, so refresh it periodically.
    if (this.mode === 'sinr') {
      this.refreshTimer += dtMs;
      if (this.refreshTimer > 4000 && this.row >= RES) {
        this.refreshTimer = 0;
        this.invalidate();
      }
    }
    if (this.row >= RES) return;

    const start = performance.now();
    while (this.row < RES && performance.now() - start < FRAME_BUDGET_MS) this.computeRow(this.row++);
    this.ctx.putImageData(this.image, 0, 0);
    this.texture.needsUpdate = true;
  }

  computeRow(j) {
    const { sim, extent, towers } = this;
    const city = sim.city;
    const p = sim.params;
    const data = this.image.data;
    const z = -extent + ((j + 0.5) / RES) * extent * 2;
    const rgb = [0, 0, 0];
    const rsrps = new Array(towers.length);

    for (let i = 0; i < RES; i++) {
      const x = -extent + ((i + 0.5) / RES) * extent * 2;
      const o = (j * RES + i) * 4;
      let best = -1;
      let bestScore = -Infinity;
      let bestRsrp = -Infinity;
      for (let k = 0; k < towers.length; k++) {
        const r = medianRsrp(towers[k], x, z, city).rsrp - BODY_LOSS;
        rsrps[k] = r;
        const score = r + sim.cio(towers[k]);
        if (r > bestRsrp) bestRsrp = r;
        if (r >= p.minRsrpDbm && score > bestScore) {
          bestScore = score;
          best = k;
        }
      }

      if (best < 0) {
        // Coverage hole
        data[o] = 120;
        data[o + 1] = 10;
        data[o + 2] = 20;
        data[o + 3] = 170;
        continue;
      }

      const bt = towers[best];
      let alpha = 200;
      if (this.mode === 'server') {
        const c = techRgb[bt.tech];
        const s = Math.max(0.25, Math.min(1, (rsrps[best] + 125) / 55));
        rgb[0] = c[0] * s;
        rgb[1] = c[1] * s;
        rgb[2] = c[2] * s;
        alpha = 110 + 110 * s;
      } else if (this.mode === 'rsrp') {
        const sc = SCALES.rsrp;
        ramp((bestRsrp - sc.min) / (sc.max - sc.min), rgb);
      } else {
        const tech = TECH[bt.tech];
        const interferers = [];
        for (let k = 0; k < towers.length; k++) {
          if (k !== best && towers[k].tech === bt.tech) interferers.push({ rsrp: rsrps[k], load: loadFactor(towers[k].users) });
        }
        if (p.externalInterference) interferers.push({ rsrp: tech.externalInterferenceDbm, load: 1 });
        const sinr = sinrDb(rsrps[best], interferers, noisePerReDbm(tech, p.noiseFigureDb), p.maxSinrDb);
        const sc = SCALES.sinr;
        ramp((sinr - sc.min) / (sc.max - sc.min), rgb);
      }
      data[o] = rgb[0];
      data[o + 1] = rgb[1];
      data[o + 2] = rgb[2];
      data[o + 3] = alpha;
    }
  }

  dispose() {
    this.texture.dispose();
    this.material.dispose();
    this.mesh.geometry.dispose();
  }
}
