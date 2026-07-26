import { describe, it, expect } from 'vitest';
import { mulberry32, valueNoise } from './rng';

describe('mulberry32', () => {
  it('is deterministic: same seed produces the same sequence', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = Array.from({ length: 20 }, () => a());
    const seqB = Array.from({ length: 20 }, () => b());
    expect(seqA).toEqual(seqB);
  });

  it('produces values in [0, 1)', () => {
    const next = mulberry32(7);
    for (let i = 0; i < 1000; i++) {
      const v = next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('different seeds diverge', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    expect(seqA).not.toEqual(seqB);
  });
});

describe('valueNoise', () => {
  it('is a pure function of (x, seed): same inputs, same output regardless of call order', () => {
    const a1 = valueNoise(3.7, 5);
    valueNoise(999, 1); // unrelated call in between
    const a2 = valueNoise(3.7, 5);
    expect(a1).toBe(a2);
  });

  it('stays within [-1, 1]', () => {
    for (let x = 0; x < 50; x += 0.37) {
      const v = valueNoise(x, 3);
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('is continuous at integer lattice points (no seams)', () => {
    const seed = 11;
    for (let i = 0; i < 10; i++) {
      const justBefore = valueNoise(i - 1e-6, seed);
      const at = valueNoise(i, seed);
      expect(Math.abs(justBefore - at)).toBeLessThan(1e-3);
    }
  });
});
