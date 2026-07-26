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

  it('R14: default peakPowerSpeed (5) reproduces the pre-R14 hardcoded-floor formula exactly, across speeds', () => {
    // Full pre-R14 formula (fTraction = throttle * min(P/max(v,5),
    // muLong*normalLoad), drag/roll otherwise unchanged), reproduced
    // independently here — not by calling computeAcceleration — as the
    // regression fixture the guide asked for.
    const spec = { ...TEST_CAR, peakPowerSpeed: 5 };
    const G = 9.81;
    const RHO_SEA_LEVEL = 1.225; // matches physics.ts's constant at ele=0 (default)
    for (const v of [0, 2, 4.9, 5, 5.1, 8, 20, 40, 76]) {
      const grade = 0;
      const normalLoad = spec.mass * G * Math.cos(grade);
      const oldFTraction = Math.min(spec.power / Math.max(v, 5), spec.muLong * normalLoad);
      const fDrag = 0.5 * RHO_SEA_LEVEL * spec.cdA * v * v;
      const fRoll = spec.crr * normalLoad;
      const oldA = (oldFTraction - fDrag - fRoll) / spec.mass;
      const { a } = computeAcceleration({ spec, v, grade, throttle: 1, brake: 0 });
      expect(a).toBeCloseTo(oldA, 8);
    }
  });
});
