// Slab test of the segment (x0,z0)->(x1,z1) against an axis-aligned box.
// Writes the entry/exit parameters into `out` and returns true on a hit.
export function segmentAabb(x0, z0, x1, z1, minX, minZ, maxX, maxZ, out) {
  let t0 = 0;
  let t1 = 1;
  const dx = x1 - x0;
  const dz = z1 - z0;

  if (Math.abs(dx) < 1e-9) {
    if (x0 < minX || x0 > maxX) return false;
  } else {
    let a = (minX - x0) / dx;
    let b = (maxX - x0) / dx;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }

  if (Math.abs(dz) < 1e-9) {
    if (z0 < minZ || z0 > maxZ) return false;
  } else {
    let a = (minZ - z0) / dz;
    let b = (maxZ - z0) / dz;
    if (a > b) [a, b] = [b, a];
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    if (t0 > t1) return false;
  }

  out[0] = t0;
  out[1] = t1;
  return true;
}

export function pointInRect(x, z, r, pad = 0) {
  return x >= r.minX - pad && x <= r.maxX + pad && z >= r.minZ - pad && z <= r.maxZ + pad;
}

export const clamp = (v, min, max) => (v < min ? min : v > max ? max : v);
export const lerp = (a, b, t) => a + (b - a) * t;
