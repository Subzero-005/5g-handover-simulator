// Small seeded PRNG (mulberry32) so every run of a scenario is reproducible.
export function createRng(seed = 1) {
  let state = seed >>> 0;
  let spare = null;

  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => Math.floor(min + (max - min + 1) * next()),
    pick: (arr) => arr[Math.floor(next() * arr.length)],
    chance: (p) => next() < p,
    // Standard normal sample (Marsaglia polar method).
    gauss() {
      if (spare !== null) {
        const v = spare;
        spare = null;
        return v;
      }
      let u, v, r;
      do {
        u = next() * 2 - 1;
        v = next() * 2 - 1;
        r = u * u + v * v;
      } while (r === 0 || r >= 1);
      const m = Math.sqrt((-2 * Math.log(r)) / r);
      spare = v * m;
      return u * m;
    },
  };
}
