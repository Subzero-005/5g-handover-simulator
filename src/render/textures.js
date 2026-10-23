import * as THREE from 'three';
import { createRng } from '../sim/rng.js';

function canvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')];
}

function finish(c, { srgb = true, repeat = false } = {}) {
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  return t;
}

let glow = null;
export function glowTexture() {
  if (glow) return glow;
  const [c, g] = canvas(128, 128);
  const grad = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.18, 'rgba(255,255,255,0.85)');
  grad.addColorStop(0.45, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 128, 128);
  glow = finish(c);
  return glow;
}

// Facade textures: a diffuse map and an emissive map of lit windows.
export function windowTextures(variants = 4, seed = 3) {
  const rng = createRng(seed);
  const out = [];
  const palettes = [
    ['#ffd9a0', '#ffe8c4', '#ffc77a'],
    ['#a8dcff', '#d6efff', '#7cc8ff'],
    ['#ffffff', '#e6f0ff', '#cfe3ff'],
    ['#ffd9a0', '#a8dcff', '#ffffff'],
  ];
  for (let v = 0; v < variants; v++) {
    const cols = 8;
    const rows = 16;
    const cw = 16;
    const ch = 16;
    const [dc, dg] = canvas(cols * cw, rows * ch);
    const [ec, eg] = canvas(cols * cw, rows * ch);
    dg.fillStyle = v % 2 ? '#152033' : '#18233a';
    dg.fillRect(0, 0, dc.width, dc.height);
    eg.fillStyle = '#000';
    eg.fillRect(0, 0, ec.width, ec.height);
    const pal = palettes[v % palettes.length];
    const litRatio = rng.range(0.18, 0.42);
    for (let r = 0; r < rows; r++) {
      const floorLit = rng.chance(0.15) ? 0.8 : litRatio;
      for (let k = 0; k < cols; k++) {
        const x = k * cw + 3;
        const y = r * ch + 4;
        const w = cw - 6;
        const h = ch - 7;
        dg.fillStyle = '#0c1424';
        dg.fillRect(x, y, w, h);
        if (rng.chance(floorLit)) {
          const col = rng.pick(pal);
          eg.globalAlpha = rng.range(0.35, 1);
          eg.fillStyle = col;
          eg.fillRect(x, y, w, h);
          dg.fillStyle = col;
          dg.globalAlpha = 0.25;
          dg.fillRect(x, y, w, h);
          dg.globalAlpha = 1;
        }
      }
    }
    eg.globalAlpha = 1;
    out.push({ map: finish(dc, { repeat: true }), emissive: finish(ec, { repeat: true }) });
  }
  return out;
}

// Ground: streets with lane markings and crossings, sidewalks and parks.
export function groundTexture(city, px = 2048) {
  const [c, g] = canvas(px, px);
  const size = city.size;
  const s = px / size;
  const X = (x) => (x + size / 2) * s;
  const half = city.half;
  const sw = city.streetWidth;

  g.fillStyle = '#070c15';
  g.fillRect(0, 0, px, px);

  // City footprint (sidewalk level)
  g.fillStyle = '#101826';
  g.fillRect(X(-half - sw), X(-half - sw), (2 * half + 2 * sw) * s, (2 * half + 2 * sw) * s);

  // Blocks
  for (let i = 0; i < city.blocks; i++) {
    for (let j = 0; j < city.blocks; j++) {
      const x0 = city.lines[i] + sw / 2;
      const z0 = city.lines[j] + sw / 2;
      const w = city.blockPitch - sw;
      g.fillStyle = '#141e2f';
      g.fillRect(X(x0), X(z0), w * s, w * s);
      g.fillStyle = '#0f1724';
      g.fillRect(X(x0 + 3), X(z0 + 3), (w - 6) * s, (w - 6) * s);
    }
  }

  // Parks
  for (const p of city.parks) {
    g.fillStyle = '#0b2421';
    g.fillRect(X(p.minX + 3), X(p.minZ + 3), (p.maxX - p.minX - 6) * s, (p.maxZ - p.minZ - 6) * s);
    g.strokeStyle = 'rgba(126,226,184,0.10)';
    g.lineWidth = 1;
    for (let k = p.minX + 12; k < p.maxX; k += 12) {
      g.beginPath();
      g.moveTo(X(k), X(p.minZ + 3));
      g.lineTo(X(k), X(p.maxZ - 3));
      g.stroke();
    }
    // Footpaths
    g.strokeStyle = 'rgba(160,190,210,0.18)';
    g.lineWidth = 2.2 * s;
    g.beginPath();
    g.moveTo(X(p.minX), X(p.minZ));
    g.lineTo(X(p.maxX), X(p.maxZ));
    g.moveTo(X(p.maxX), X(p.minZ));
    g.lineTo(X(p.minX), X(p.maxZ));
    g.stroke();
  }

  // Streets
  const ringIdx = new Set([0, city.lines.length - 1]);
  city.lines.forEach((l, idx) => {
    const ring = ringIdx.has(idx);
    g.fillStyle = ring ? '#0b1220' : '#0a101b';
    g.fillRect(X(-half - sw / 2), X(l - sw / 2), (2 * half + sw) * s, sw * s);
    g.fillRect(X(l - sw / 2), X(-half - sw / 2), sw * s, (2 * half + sw) * s);
  });

  // Lane markings
  g.setLineDash([6 * s, 6 * s]);
  city.lines.forEach((l, idx) => {
    const ring = ringIdx.has(idx);
    g.strokeStyle = ring ? 'rgba(255,209,128,0.45)' : 'rgba(170,190,220,0.28)';
    g.lineWidth = (ring ? 0.8 : 0.6) * s;
    for (let k = 0; k < city.lines.length - 1; k++) {
      const a = city.lines[k] + sw / 2 + 2;
      const b = city.lines[k + 1] - sw / 2 - 2;
      g.beginPath();
      g.moveTo(X(a), X(l));
      g.lineTo(X(b), X(l));
      g.moveTo(X(l), X(a));
      g.lineTo(X(l), X(b));
      g.stroke();
    }
  });
  g.setLineDash([]);

  // Zebra crossings
  g.fillStyle = 'rgba(200,215,235,0.22)';
  for (const nx of city.lines) {
    for (const nz of city.lines) {
      for (let k = -sw / 2 + 2; k < sw / 2 - 1; k += 3) {
        g.fillRect(X(nx + k), X(nz - sw / 2 - 4), 1.5 * s, 3 * s);
        g.fillRect(X(nx + k), X(nz + sw / 2 + 1), 1.5 * s, 3 * s);
        g.fillRect(X(nx - sw / 2 - 4), X(nz + k), 3 * s, 1.5 * s);
        g.fillRect(X(nx + sw / 2 + 1), X(nz + k), 3 * s, 1.5 * s);
      }
    }
  }

  // Ring-road edge glow
  g.strokeStyle = 'rgba(77,208,225,0.25)';
  g.lineWidth = 1.2 * s;
  g.strokeRect(X(-half - sw / 2), X(-half - sw / 2), (2 * half + sw) * s, (2 * half + sw) * s);
  g.strokeRect(X(-half + sw / 2), X(-half + sw / 2), (2 * half - sw) * s, (2 * half - sw) * s);

  return finish(c);
}
