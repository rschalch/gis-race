/** Deterministic 32-bit PRNG (mulberry32) — stateful, advances one draw per call. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function latticeHash(i: number, seed: number): number {
  const x = Math.sin(i * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

/**
 * §7.4: seeded 1D value noise — hash the integer lattice points, cosine-
 * interpolate between them. Pure function of (x, seed): no internal state,
 * so the simulation stays reproducible regardless of call order.
 */
export function valueNoise(x: number, seed: number): number {
  const i0 = Math.floor(x);
  const t = x - i0;
  const v0 = latticeHash(i0, seed) * 2 - 1;
  const v1 = latticeHash(i0 + 1, seed) * 2 - 1;
  const ft = (1 - Math.cos(t * Math.PI)) / 2;
  return v0 * (1 - ft) + v1 * ft;
}
