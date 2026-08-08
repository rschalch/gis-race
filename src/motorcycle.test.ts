import { describe, it, expect } from 'vitest';
import { computeAcceleration } from './physics';
import { computeSpeedProfile, evaluateLossOfControl, weatherGripFor } from './driver';
import { buildCarSpecs } from './cars';
import { makeTestRoute, TEST_CAR } from './test-fixtures';
import {
  G,
  MOTORCYCLE_PITCH_LIMIT_G,
  MOTORCYCLE_SEVERITY_SHIFT,
  MOTORCYCLE_RECOVERY_MULT,
  MOTORCYCLE_WEATHER_GRIP,
  WEATHER_GRIP,
  SPIN_UTILISATION_THRESHOLD,
  OFFROAD_UTILISATION_THRESHOLD,
  SPIN_RECOVERY_MIN_S,
} from './tuning';
import type { CarSpec, CarState } from './types';

/**
 * M1 — motorcycles.
 *
 * The whole feature is expressed as four type-gated differences from a car, so
 * this file checks each one *and* checks that the car path is untouched — the
 * latter is what src/golden.test.ts also guards end-to-end.
 */

// A bike with the same tyres and power as TEST_CAR, so every assertion below
// isolates the type-gated behaviour rather than a difference in the numbers.
const TEST_BIKE: CarSpec = {
  ...TEST_CAR,
  id: 'test-bike',
  name: 'Test Bike',
  type: 'motorcycle',
  pitchLimitG: MOTORCYCLE_PITCH_LIMIT_G,
};

describe('M1: pitch-over ceiling (physics.ts)', () => {
  it('caps a motorcycleacceleration at pitchLimitG even when power and grip allow more', () => {
    // Absurd power at low speed: without the cap this is grip-limited at
    // muLong (0.95 g); with it, the wheelie ceiling (1.1 g) never binds and
    // grip still does — so raise grip too and check the cap takes over.
    const grippy = { ...TEST_BIKE, muLong: 3, power: 5_000_000 };
    const { aTire } = computeAcceleration({ spec: grippy, v: 10, grade: 0, throttle: 1, brake: 0 });
    expect(aTire).toBeCloseTo(MOTORCYCLE_PITCH_LIMIT_G * G, 6);
  });

  it('caps a motorcycle braking at pitchLimitG — a superbike cannot out-brake its own geometry', () => {
    const grippy = { ...TEST_BIKE, muLong: 3 };
    const { aTire } = computeAcceleration({ spec: grippy, v: 40, grade: 0, throttle: 0, brake: 1 });
    expect(aTire).toBeCloseTo(-MOTORCYCLE_PITCH_LIMIT_G * G, 6);
  });

  it('leaves grip as the only limit below the ceiling', () => {
    // muLong 0.8 g < 1.1 g ceiling, so the bike is tyre-limited exactly as a
    // car would be.
    const bike = { ...TEST_BIKE, muLong: 0.8 };
    const { aTire } = computeAcceleration({ spec: bike, v: 40, grade: 0, throttle: 0, brake: 1 });
    expect(aTire).toBeCloseTo(-0.8 * G, 6);
  });

  it('does not apply to cars at all (Infinity is an exact no-op)', () => {
    const grippy = { ...TEST_CAR, muLong: 3, power: 5_000_000 };
    const { aTire } = computeAcceleration({ spec: grippy, v: 10, grade: 0, throttle: 1, brake: 0 });
    expect(aTire).toBeGreaterThan(MOTORCYCLE_PITCH_LIMIT_G * G * 2);
  });
});

describe('M1: weather', () => {
  it('gives motorcycles their own, harsher table', () => {
    expect(weatherGripFor(TEST_CAR, 'wet')).toBe(WEATHER_GRIP.wet);
    expect(weatherGripFor(TEST_BIKE, 'wet')).toBe(MOTORCYCLE_WEATHER_GRIP.wet);
    expect(weatherGripFor(TEST_BIKE, 'wet')).toBeLessThan(weatherGripFor(TEST_CAR, 'wet'));
  });

  it('is identical to a car in the dry', () => {
    expect(weatherGripFor(TEST_BIKE, 'dry')).toBe(weatherGripFor(TEST_CAR, 'dry'));
  });

  it('costs a bike more cornering speed in the wet than the same machine on four wheels', () => {
    const route = makeTestRoute({ n: 40, radiusAt: () => 80 });
    const dryBike = computeSpeedProfile(route, TEST_BIKE, false, 'dry');
    const wetBike = computeSpeedProfile(route, TEST_BIKE, false, 'wet');
    const dryCar = computeSpeedProfile(route, TEST_CAR, false, 'dry');
    const wetCar = computeSpeedProfile(route, TEST_CAR, false, 'wet');

    const bikeLoss = 1 - wetBike[10]! / dryBike[10]!;
    const carLoss = 1 - wetCar[10]! / dryCar[10]!;
    expect(bikeLoss).toBeGreaterThan(carLoss);
  });
});

describe('M1: incident severity', () => {
  const RADIUS = 80;

  // lineQuality widens the radius the crash check reads (R3), so it has to be
  // in here or every target utilisation lands ~5% low.
  function vForUtilisation(targetU: number): number {
    return Math.sqrt(targetU * RADIUS * TEST_CAR.lineQuality * TEST_CAR.muLat * G);
  }

  function makeState(spec: CarSpec, v: number): CarState {
    return {
      spec,
      route: makeTestRoute({ n: 2 }),
      s: 0,
      v,
      throttle: 0,
      brake: 0,
      status: 'racing',
      recoveryRemaining: 0,
      incidents: [],
      startDelay: 0,
      heldUpFor: 0,
      passRemaining: 0,
      finishTime: null,
      speedProfile: new Float32Array(1),
      rng: () => 0, // any above-threshold incident actually fires
      seed: 1,
      tireWear: 0,
      engineLoad: 0,
      brakeHeat: 0,
    pauseRemaining: 0,
    turnaroundTaken: false,
      condition: { grip: 1, cdA: 1 },
    };
  }

  it('turns a car spin into a motorcycle retirement in the shifted band', () => {
    // Just inside the car's spin band but past the bike's shifted off-road
    // threshold.
    const u = OFFROAD_UTILISATION_THRESHOLD - MOTORCYCLE_SEVERITY_SHIFT / 2;
    const route = makeTestRoute({ n: 10, radiusAt: () => RADIUS });

    const car = makeState(TEST_CAR, vForUtilisation(u));
    evaluateLossOfControl(car, route, 0, 0, 1 / 60, 'dry');
    expect(car.incidents[0]?.severity).toBe('spin');

    const bike = makeState(TEST_BIKE, vForUtilisation(u));
    evaluateLossOfControl(bike, route, 0, 0, 1 / 60, 'dry');
    expect(bike.incidents[0]?.severity).toBe('off-road');
    expect(bike.status).toBe('retired');
  });

  it('turns a car slide into a motorcycle spin in the shifted band', () => {
    const u = SPIN_UTILISATION_THRESHOLD - MOTORCYCLE_SEVERITY_SHIFT / 2;
    const route = makeTestRoute({ n: 10, radiusAt: () => RADIUS });

    const car = makeState(TEST_CAR, vForUtilisation(u));
    evaluateLossOfControl(car, route, 0, 0, 1 / 60, 'dry');
    expect(car.incidents[0]?.severity).toBe('slide');

    const bike = makeState(TEST_BIKE, vForUtilisation(u));
    evaluateLossOfControl(bike, route, 0, 0, 1 / 60, 'dry');
    expect(bike.incidents[0]?.severity).toBe('spin');
  });

  it('leaves a downed rider off the road longer than a spun car', () => {
    const u = (SPIN_UTILISATION_THRESHOLD + OFFROAD_UTILISATION_THRESHOLD) / 2;
    const route = makeTestRoute({ n: 10, radiusAt: () => RADIUS });
    // rng() = 0 makes the recovery draw land on SPIN_RECOVERY_MIN_S exactly.
    const bike = makeState({ ...TEST_BIKE, muLat: TEST_CAR.muLat }, vForUtilisation(u - MOTORCYCLE_SEVERITY_SHIFT));
    evaluateLossOfControl(bike, route, 0, 0, 1 / 60, 'dry');
    expect(bike.incidents[0]?.severity).toBe('spin');
    expect(bike.recoveryRemaining).toBeCloseTo(SPIN_RECOVERY_MIN_S * MOTORCYCLE_RECOVERY_MULT, 6);
  });
});

describe('M1: schema', () => {
  const raw = {
    id: 'b',
    name: 'Bike',
    mass: 250,
    crankPowerW: 150_000,
    cdA: 0.35,
    crr: 0.015,
    muLong: 1.0,
    muLat: 1.05,
    vMaxKmh: 299,
    aggression: 1,
    errorSigma: 0.04,
  };

  it('defaults an entry with no type to a car with no pitch limit', () => {
    const [spec] = buildCarSpecs([raw]);
    expect(spec!.type).toBe('car');
    expect(spec!.pitchLimitG).toBe(Infinity);
  });

  it('defaults a motorcycle to MOTORCYCLE_PITCH_LIMIT_G', () => {
    const [spec] = buildCarSpecs([{ ...raw, type: 'motorcycle' }]);
    expect(spec!.type).toBe('motorcycle');
    expect(spec!.pitchLimitG).toBe(MOTORCYCLE_PITCH_LIMIT_G);
  });

  it('keeps an explicit pitchLimitG', () => {
    const [spec] = buildCarSpecs([{ ...raw, type: 'motorcycle', pitchLimitG: 1.35 }]);
    expect(spec!.pitchLimitG).toBe(1.35);
  });

  it('rejects an unknown type', () => {
    expect(() => buildCarSpecs([{ ...raw, type: 'truck' }])).toThrow(/type/);
  });

  it('rejects a non-positive pitchLimitG', () => {
    expect(() => buildCarSpecs([{ ...raw, type: 'motorcycle', pitchLimitG: 0 }])).toThrow(/pitchLimitG/);
  });

  it('rejects pitchLimitG on a car rather than silently ignoring it', () => {
    expect(() => buildCarSpecs([{ ...raw, pitchLimitG: 1.2 }])).toThrow(/not a motorcycle/);
  });
});
