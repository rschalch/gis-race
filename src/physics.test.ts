import { describe, it, expect } from 'vitest';
import { computeAcceleration } from './physics';
import { TEST_CAR } from './test-fixtures';

describe('computeAcceleration', () => {
  it('accelerates forward under full throttle on the flat with no brake', () => {
    const { a } = computeAcceleration({ spec: TEST_CAR, v: 20, grade: 0, throttle: 1, brake: 0 });
    expect(a).toBeGreaterThan(0);
  });

  it('decelerates under full brake with no throttle', () => {
    const { a } = computeAcceleration({ spec: TEST_CAR, v: 20, grade: 0, throttle: 0, brake: 1 });
    expect(a).toBeLessThan(0);
  });

  it('grade reduces the normal-load-dependent caps consistently between traction and braking', () => {
    // Steep grade should reduce both fTraction's cap and fBrake vs flat, since
    // both now use the cos(grade)-corrected normal load (B1 consistency fix).
    const steep = computeAcceleration({ spec: TEST_CAR, v: 20, grade: 0.4, throttle: 1, brake: 0 });
    const flat = computeAcceleration({ spec: TEST_CAR, v: 20, grade: 0, throttle: 1, brake: 0 });
    // Uphill (positive grade) adds a gravity penalty on top of the reduced
    // traction cap, so net acceleration should be lower.
    expect(steep.a).toBeLessThan(flat.a);
  });

  it('aTire excludes drag/roll/grade — braking-only aTire matches -fBrake/m at low speed where traction cap does not bind', () => {
    const { aTire } = computeAcceleration({ spec: TEST_CAR, v: 20, grade: 0, throttle: 0, brake: 1 });
    const expected = -(TEST_CAR.muLong * TEST_CAR.mass * 9.81 * Math.cos(0)) / TEST_CAR.mass;
    expect(aTire).toBeCloseTo(expected, 5);
  });

  it('R4: a lower dragFactor (drafting) gives strictly more net acceleration at the same speed', () => {
    const solo = computeAcceleration({ spec: TEST_CAR, v: 40, grade: 0, throttle: 1, brake: 0 });
    const drafting = computeAcceleration({ spec: TEST_CAR, v: 40, grade: 0, throttle: 1, brake: 0, dragFactor: 0.65 });
    expect(drafting.a).toBeGreaterThan(solo.a);
  });

  it('R4: dragFactor defaults to 1 (no change) when omitted', () => {
    const withDefault = computeAcceleration({ spec: TEST_CAR, v: 40, grade: 0, throttle: 1, brake: 0 });
    const explicit1 = computeAcceleration({ spec: TEST_CAR, v: 40, grade: 0, throttle: 1, brake: 0, dragFactor: 1 });
    expect(withDefault.a).toBeCloseTo(explicit1.a, 10);
  });

  it('R9: rho(0) = 1.225 and rho(800) ≈ 1.116, matching the old flat stand-in closely by design', () => {
    const RHO_SEA_LEVEL = 1.225;
    const SCALE_HEIGHT_M = 8500;
    const rho = (ele: number) => RHO_SEA_LEVEL * Math.exp(-ele / SCALE_HEIGHT_M);
    expect(rho(0)).toBeCloseTo(1.225, 5);
    expect(rho(800)).toBeCloseTo(1.116, 2);
  });

  it('R9: higher elevation (thinner air) gives less drag — higher net acceleration for a forced-induction car', () => {
    const forcedCar = { ...TEST_CAR, induction: 'forced' as const };
    const seaLevel = computeAcceleration({ spec: forcedCar, v: 30, grade: 0, throttle: 1, brake: 0, ele: 0 });
    const plateau = computeAcceleration({ spec: forcedCar, v: 30, grade: 0, throttle: 1, brake: 0, ele: 2000 });
    expect(plateau.a).toBeGreaterThan(seaLevel.a);
  });

  it('R9: a naturally-aspirated car loses more from its own altitude-derated power than it gains from reduced drag', () => {
    const naCar = { ...TEST_CAR, induction: 'na' as const };
    // v=30, full throttle: fTraction is power-limited (P/v ≈ 6.7 kN) well
    // under the grip cap (≈13.5 kN) for this car, so the induction-based
    // power derate is directly visible in net a.
    const seaLevel = computeAcceleration({ spec: naCar, v: 30, grade: 0, throttle: 1, brake: 0, ele: 0 });
    const plateau = computeAcceleration({ spec: naCar, v: 30, grade: 0, throttle: 1, brake: 0, ele: 2000 });
    expect(plateau.a).toBeLessThan(seaLevel.a);
  });

  it('R9: ele defaults to 0 (sea level) when omitted', () => {
    const withDefault = computeAcceleration({ spec: TEST_CAR, v: 40, grade: 0, throttle: 1, brake: 0 });
    const explicit0 = computeAcceleration({ spec: TEST_CAR, v: 40, grade: 0, throttle: 1, brake: 0, ele: 0 });
    expect(withDefault.a).toBeCloseTo(explicit0.a, 10);
  });

  it('R14: a higher peakPowerSpeed softens acceleration below it (neither grip-clipped at v=16)', () => {
    const peaky = { ...TEST_CAR, peakPowerSpeed: 18 };
    const torquey = { ...TEST_CAR, peakPowerSpeed: 5 };
    const { a: aPeaky } = computeAcceleration({ spec: peaky, v: 16, grade: 0, throttle: 1, brake: 0 });
    const { a: aTorquey } = computeAcceleration({ spec: torquey, v: 16, grade: 0, throttle: 1, brake: 0 });
    expect(aPeaky).toBeLessThan(aTorquey);
  });

  it('R14: above both peakPowerSpeed values, acceleration is power-limited (P/v) regardless of peakPowerSpeed', () => {
    const peaky = { ...TEST_CAR, peakPowerSpeed: 18 };
    const torquey = { ...TEST_CAR, peakPowerSpeed: 5 };
    const { a: aPeaky } = computeAcceleration({ spec: peaky, v: 40, grade: 0, throttle: 1, brake: 0 });
    const { a: aTorquey } = computeAcceleration({ spec: torquey, v: 40, grade: 0, throttle: 1, brake: 0 });
    expect(aPeaky).toBeCloseTo(aTorquey, 10);
  });

  it('R14+R18: default peakPowerSpeed (5) reproduces the documented force law exactly, across speeds', () => {
    // The full traction formula (R14 constant-torque floor + R18's
    // speed-tapered driveline loss on the power term), reproduced
    // independently here — not by calling computeAcceleration — as the
    // regression fixture the guide asked for.
    const spec = { ...TEST_CAR, peakPowerSpeed: 5 };
    const G = 9.81;
    const RHO_SEA_LEVEL = 1.225; // matches physics.ts's constant at ele=0 (default)
    const fadeEnd = Math.min(50, 0.9 * spec.vMax); // DRIVELINE_LOSS_FADE_SPEED / _VMAX_FRACTION
    for (const v of [0, 2, 4.9, 5, 5.1, 8, 20, 40, 76]) {
      const grade = 0;
      const normalLoad = spec.mass * G * Math.cos(grade);
      const drivelineEff = 1 - 0.5 * Math.max(0, 1 - v / fadeEnd); // DRIVELINE_LOSS_MAX
      const fTraction = Math.min((drivelineEff * spec.power) / Math.max(v, 5), spec.muLong * normalLoad);
      const fDrag = 0.5 * RHO_SEA_LEVEL * spec.cdA * v * v;
      const fRoll = spec.crr * normalLoad;
      const wantA = (fTraction - fDrag - fRoll) / spec.mass;
      const { a } = computeAcceleration({ spec, v, grade, throttle: 1, brake: 0 });
      expect(a).toBeCloseTo(wantA, 8);
    }
  });
});

describe('R17: surface rolling resistance', () => {
  it('a loose surface adds rolling drag on top of its grip cost', () => {
    // Coasting (no traction/brake in play), so the only difference is fRoll.
    const asphalt = computeAcceleration({ spec: TEST_CAR, v: 30, grade: 0, throttle: 0, brake: 0, surface: 1 });
    const gravel = computeAcceleration({ spec: TEST_CAR, v: 30, grade: 0, throttle: 0, brake: 0, surface: 0.8 });
    expect(gravel.a).toBeLessThan(asphalt.a);
    // surface 0.8 → crr scaled by 1 + 5·0.2 = 2: the added deceleration is
    // exactly one extra crr·G.
    expect(asphalt.a - gravel.a).toBeCloseTo(TEST_CAR.crr * 9.81, 6);
  });

  it('default surface (asphalt) changes nothing', () => {
    const implicit = computeAcceleration({ spec: TEST_CAR, v: 30, grade: 0, throttle: 1, brake: 0 });
    const explicit = computeAcceleration({ spec: TEST_CAR, v: 30, grade: 0, throttle: 1, brake: 0, surface: 1 });
    expect(implicit.a).toBe(explicit.a);
  });
});

describe('R15b: engine heat power derate', () => {
  // v = 40 is power-limited for TEST_CAR (traction cap far above P/v there),
  // so any change in `a` is the power derate and nothing else.
  it('a heat-soaked engine pulls less than a fresh one, by the tuned fraction', () => {
    const fresh = computeAcceleration({ spec: TEST_CAR, v: 40, grade: 0, throttle: 1, brake: 0, engineLoad: 0 });
    const atNeutral = computeAcceleration({ spec: TEST_CAR, v: 40, grade: 0, throttle: 1, brake: 0, engineLoad: 0.7 });
    const soaked = computeAcceleration({ spec: TEST_CAR, v: 40, grade: 0, throttle: 1, brake: 0, engineLoad: 1 });
    expect(atNeutral.a).toBe(fresh.a); // no penalty at or below the neutral point
    expect(soaked.a).toBeLessThan(fresh.a);
    // Traction force dropped by exactly the fade fraction of the (R18
    // driveline-derated) power term.
    const drivelineEff = 1 - 0.5 * Math.max(0, 1 - 40 / Math.min(50, 0.9 * TEST_CAR.vMax));
    expect(fresh.aTire - soaked.aTire).toBeCloseTo((0.06 * drivelineEff * TEST_CAR.power) / 40 / TEST_CAR.mass, 8);
  });
});

describe('R16: wind', () => {
  it('headwind adds drag, tailwind sheds it, traction is untouched', () => {
    const calm = computeAcceleration({ spec: TEST_CAR, v: 50, grade: 0, throttle: 1, brake: 0 });
    const head = computeAcceleration({ spec: TEST_CAR, v: 50, grade: 0, throttle: 1, brake: 0, windAlong: -9 });
    const tail = computeAcceleration({ spec: TEST_CAR, v: 50, grade: 0, throttle: 1, brake: 0, windAlong: 9 });
    expect(head.a).toBeLessThan(calm.a);
    expect(tail.a).toBeGreaterThan(calm.a);
    // Wind lives purely in the drag term — the tyre-force channel (§7.5's
    // friction circle input) must not see it.
    expect(head.aTire).toBe(calm.aTire);
    expect(tail.aTire).toBe(calm.aTire);
  });
});

describe('R19: brake fade', () => {
  it('hot brakes deliver proportionally less force for the same pedal', () => {
    const cold = computeAcceleration({ spec: TEST_CAR, v: 40, grade: 0, throttle: 0, brake: 1, brakeFade: 1 });
    const faded = computeAcceleration({ spec: TEST_CAR, v: 40, grade: 0, throttle: 0, brake: 1, brakeFade: 0.7 });
    expect(faded.a).toBeGreaterThan(cold.a); // less deceleration
    // aTire here is pure brake force, so the ratio is exactly the fade factor.
    expect(faded.aTire / cold.aTire).toBeCloseTo(0.7, 8);
  });
});
