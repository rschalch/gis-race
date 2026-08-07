import { describe, it, expect } from 'vitest';
import {
  MAX_FIELD_SIZE,
  PERFORMANCE_TIERS,
  buildFairField,
  fieldLike,
  groupByMake,
  paceIndex,
  sortByPace,
  tierOf,
} from './roster';
import type { CarSpec } from './types';

function car(id: string, over: Partial<CarSpec> = {}): CarSpec {
  return {
    id,
    name: id,
    type: 'car',
    make: 'Make',
    colour: '#ffffff',
    mass: 1500,
    power: 150_000,
    cdA: 0.6,
    crr: 0.011,
    muLong: 0.9,
    muLat: 0.9,
    vMax: 55.6,
    aggression: 1,
    limitTolerance: 1,
    errorSigma: 0.03,
    lineQuality: 1.05,
    induction: 'forced',
    pitchLimitG: Infinity,
    peakPowerSpeed: 8,
    ...over,
  };
}

describe('paceIndex', () => {
  it('is anchored so 100 W/kg at 200 km/h and mu 0.9 scores 100', () => {
    expect(paceIndex(car('a', { power: 150_000, mass: 1500 }))).toBeCloseTo(100, 1);
  });

  it('rises with power-to-weight, top speed and lateral grip', () => {
    const base = paceIndex(car('base'));
    expect(paceIndex(car('a', { power: 300_000 }))).toBeGreaterThan(base);
    expect(paceIndex(car('b', { mass: 1000 }))).toBeGreaterThan(base);
    expect(paceIndex(car('c', { vMax: 90 }))).toBeGreaterThan(base);
    expect(paceIndex(car('d', { muLat: 1.05 }))).toBeGreaterThan(base);
  });

  it('ranks a hypercar far above a hatchback', () => {
    const hatch = car('hatch', { power: 55_000, mass: 1074, vMax: 45, muLat: 0.78 });
    const hyper = car('hyper', { power: 1_200_000, mass: 1900, vMax: 115, muLat: 0.95 });
    expect(paceIndex(hyper)).toBeGreaterThan(paceIndex(hatch) * 5);
  });
});

describe('tierOf', () => {
  it('places a car in the band whose lower bound it clears', () => {
    // Bands are absolute, so these assertions pin the actual boundaries.
    expect(tierOf(car('slow', { power: 40_000, mass: 1500 })).id).toBe('economy');
    expect(tierOf(car('mid', { power: 150_000, mass: 1500 })).id).toBe('everyday'); // index 100
    expect(tierOf(car('quick', { power: 210_000, mass: 1500 })).id).toBe('sport'); // index 140
    expect(tierOf(car('fast', { power: 800_000, mass: 1400, vMax: 95, muLat: 1.0 })).id).toBe('hyper');
  });

  it('is exactly at-or-above the bound, never below', () => {
    for (const tier of PERFORMANCE_TIERS) {
      if (tier.min === 0) continue;
      // paceIndex == mass-scaled power at the reference speed/grip, so power
      // can be solved directly for an index either side of the bound.
      const at = car('at', { power: tier.min * 1500, mass: 1500 });
      const below = car('below', { power: (tier.min - 1) * 1500, mass: 1500 });
      expect(paceIndex(at)).toBeCloseTo(tier.min, 6);
      expect(tierOf(at).min).toBe(tier.min);
      expect(tierOf(below).min).toBeLessThan(tier.min);
    }
  });
});

describe('groupByMake', () => {
  it('keeps makes and cars in roster order', () => {
    const groups = groupByMake([
      car('a', { make: 'Toyota' }),
      car('b', { make: 'Ford' }),
      car('c', { make: 'Toyota' }),
    ]);
    expect([...groups.keys()]).toEqual(['Toyota', 'Ford']);
    expect(groups.get('Toyota')!.map((c) => c.id)).toEqual(['a', 'c']);
  });
});

describe('buildFairField', () => {
  const wide = [
    car('hatch', { make: 'Fiat', power: 47_000, mass: 1074, vMax: 45, muLat: 0.78 }),
    car('truck', { make: 'Ford', power: 200_000, mass: 2134, vMax: 45, muLat: 0.72 }),
    car('sport1', { make: 'Toyota', power: 145_000, mass: 1275, vMax: 62, muLat: 0.92 }),
    car('sport2', { make: 'Subaru', power: 150_000, mass: 1290, vMax: 63, muLat: 0.92 }),
    car('sport3', { make: 'Toyota', power: 155_000, mass: 1300, vMax: 62, muLat: 0.92 }),
    car('hyper', { make: 'Bugatti', power: 1_200_000, mass: 1900, vMax: 115, muLat: 0.95 }),
  ];

  it('returns everything (fastest first) when the pool already fits', () => {
    const field = buildFairField(wide, 10);
    expect(field).toHaveLength(wide.length);
    expect(field[0]!.id).toBe('hyper');
  });

  it('drops the outliers, not the cars around the median pace', () => {
    const field = buildFairField(wide, 3).map((c) => c.id);
    expect(field).not.toContain('hyper');
    expect(field).not.toContain('hatch');
  });

  it('spreads across makes before taking a second car from one make', () => {
    const oneMakeHeavy = [
      ...Array.from({ length: 6 }, (_, i) => car(`f${i}`, { make: 'Ferrari', power: 500_000 + i * 1000 })),
      car('mc', { make: 'McLaren', power: 505_000 }),
      car('lam', { make: 'Lamborghini', power: 503_000 }),
    ];
    const makes = new Set(buildFairField(oneMakeHeavy, 3).map((c) => c.make));
    expect(makes).toEqual(new Set(['Ferrari', 'McLaren', 'Lamborghini']));
  });

  it('never exceeds the requested size and is deterministic', () => {
    const pool = Array.from({ length: 60 }, (_, i) =>
      car(`c${i}`, { make: `Make${i % 7}`, power: 100_000 + i * 5000 }),
    );
    const a = buildFairField(pool, MAX_FIELD_SIZE);
    const b = buildFairField([...pool].reverse(), MAX_FIELD_SIZE);
    expect(a).toHaveLength(MAX_FIELD_SIZE);
    expect(a.map((c) => c.id)).toEqual(b.map((c) => c.id));
  });
});

describe('fieldLike', () => {
  it('returns the anchor plus its nearest rivals in pace', () => {
    const pool = [
      car('slow', { power: 50_000 }),
      car('anchor', { power: 400_000 }),
      car('near', { power: 410_000 }),
      car('far', { power: 1_200_000 }),
    ];
    const field = fieldLike(pool[1]!, pool, 2).map((c) => c.id);
    expect(field).toEqual(['near', 'anchor']);
  });
});

describe('sortByPace', () => {
  it('is fastest-first and stable on ties', () => {
    const sorted = sortByPace([car('b'), car('a'), car('fast', { power: 900_000 })]);
    expect(sorted.map((c) => c.id)).toEqual(['fast', 'a', 'b']);
  });
});
