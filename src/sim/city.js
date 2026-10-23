import { createRng } from './rng.js';
import { segmentAabb } from './geometry.js';

const scratch = [0, 0];

// Procedural Manhattan-style city: a grid of streets, blocks split into lots
// with buildings, and a few parks. The street grid doubles as the road graph
// that UEs travel on, and the buildings drive line-of-sight blockage.
export function generateCity({ seed = 7, blocks = 7, blockPitch = 150, streetWidth = 20, parks = [], clearings = [] } = {}) {
  const rng = createRng(seed * 7919 + 13);
  const n = blocks + 1;
  const half = (blocks * blockPitch) / 2;
  const lines = Array.from({ length: n }, (_, i) => -half + i * blockPitch);
  const size = blocks * blockPitch + 2 * blockPitch;

  const parkSet = new Set(parks.map(([i, j]) => `${i},${j}`));
  for (let i = 0; i < blocks; i++) {
    for (let j = 0; j < blocks; j++) {
      if (!parkSet.has(`${i},${j}`) && rng.chance(0.08)) parkSet.add(`${i},${j}`);
    }
  }

  const buildings = [];
  const parkRects = [];
  const inset = streetWidth / 2;
  for (let i = 0; i < blocks; i++) {
    for (let j = 0; j < blocks; j++) {
      const minX = lines[i] + inset;
      const maxX = lines[i + 1] - inset;
      const minZ = lines[j] + inset;
      const maxZ = lines[j + 1] - inset;
      if (parkSet.has(`${i},${j}`)) {
        parkRects.push({ minX, minZ, maxX, maxZ, i, j });
        continue;
      }
      const lot = (maxX - minX) / 2;
      for (let a = 0; a < 2; a++) {
        for (let b = 0; b < 2; b++) {
          const lx = minX + a * lot;
          const lz = minZ + b * lot;
          const m1 = rng.range(3, 9);
          const m2 = rng.range(3, 9);
          const m3 = rng.range(3, 9);
          const m4 = rng.range(3, 9);
          const cx = lx + lot / 2;
          const cz = lz + lot / 2;
          const r = Math.hypot(cx, cz);
          const hMax = 22 + 78 * Math.pow(Math.max(0, 1 - r / 720), 1.4);
          const h = Math.max(10, rng.range(0.35, 1) * hMax);
          buildings.push({ minX: lx + m1, maxX: lx + lot - m2, minZ: lz + m3, maxZ: lz + lot - m4, h });
        }
      }
    }
  }

  // Remove buildings sitting on top of predefined tower sites.
  const kept = buildings.filter(
    (b) => !clearings.some(([x, z, r = 16]) => x > b.minX - r && x < b.maxX + r && z > b.minZ - r && z < b.maxZ + r),
  );
  kept.forEach((b, idx) => {
    b.id = idx;
    b.cx = (b.minX + b.maxX) / 2;
    b.cz = (b.minZ + b.maxZ) / 2;
    b.w = b.maxX - b.minX;
    b.d = b.maxZ - b.minZ;
  });

  // Road graph: one node per intersection.
  const nodes = [];
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const id = j * n + i;
      const neighbors = [];
      if (i > 0) neighbors.push(id - 1);
      if (i < n - 1) neighbors.push(id + 1);
      if (j > 0) neighbors.push(id - n);
      if (j < n - 1) neighbors.push(id + n);
      nodes.push({ id, i, j, x: lines[i], z: lines[j], neighbors });
    }
  }

  // Perimeter loop, clockwise, used as the ring road.
  const ring = [];
  for (let i = 0; i < n; i++) ring.push(i);
  for (let j = 1; j < n; j++) ring.push(j * n + (n - 1));
  for (let i = n - 2; i >= 0; i--) ring.push((n - 1) * n + i);
  for (let j = n - 2; j > 0; j--) ring.push(j * n);

  return {
    seed,
    blocks,
    blockPitch,
    streetWidth,
    lines,
    half,
    size,
    buildings: kept,
    parks: parkRects,
    nodes,
    ring,

    buildingAt(x, z) {
      for (const b of kept) if (x >= b.minX && x <= b.maxX && z >= b.minZ && z <= b.maxZ) return b;
      return null;
    },

    // Number of buildings blocking the 3D ray from (x0,h0,z0) to (x1,h1,z1).
    // A building blocks when it is taller than the ray where the ray crosses it.
    blockers(x0, z0, h0, x1, z1, h1, skipId = -1) {
      const minX = x0 < x1 ? x0 : x1;
      const maxX = x0 < x1 ? x1 : x0;
      const minZ = z0 < z1 ? z0 : z1;
      const maxZ = z0 < z1 ? z1 : z0;
      let count = 0;
      for (let k = 0; k < kept.length; k++) {
        const b = kept[k];
        if (b.maxX < minX || b.minX > maxX || b.maxZ < minZ || b.minZ > maxZ || b.id === skipId) continue;
        if (!segmentAabb(x0, z0, x1, z1, b.minX, b.minZ, b.maxX, b.maxZ, scratch)) continue;
        const ha = h0 + (h1 - h0) * scratch[0];
        const hb = h0 + (h1 - h0) * scratch[1];
        if (b.h > (ha < hb ? ha : hb)) count++;
      }
      return count;
    },
  };
}
