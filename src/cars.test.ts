import { describe, it, expect } from 'vitest';
import { buildCarSpecs, CarValidationError, CRANK_TO_WHEEL } from './cars';

function validRawCar(overrides: Record<string, unknown> = {}) {
  return {
    id: 'test-car',
    name: 'Test Car',
    colour: '#ffffff',
    mass: 1500,
    crankPowerW: 200000,
    cdA: 0.6,
    crr: 0.01,
    muLong: 0.9,
    muLat: 0.9,
    vMaxKmh: 250,
    aggression: 1.0,
    errorSigma: 0.03,
    ...overrides,
  };
}

describe('buildCarSpecs (F2)', () => {
  it('converts crank power (W) and top speed (km/h) into wheel power and m/s', () => {
    const [spec] = buildCarSpecs([validRawCar({ crankPowerW: 200000, vMaxKmh: 250 })]);
    expect(spec!.power).toBeCloseTo(200000 * CRANK_TO_WHEEL, 5);
    expect(spec!.vMax).toBeCloseTo(250 / 3.6, 5);
  });

  it('keeps an explicit colour', () => {
    const [spec] = buildCarSpecs([validRawCar({ colour: '#123456' })]);
    expect(spec!.colour).toBe('#123456');
  });

  it('assigns a palette colour when omitted, distinct across cars', () => {
    const { colour: _a, ...a } = validRawCar({ id: 'a' });
    const { colour: _b, ...b } = validRawCar({ id: 'b' });
    const specs = buildCarSpecs([a, b]);
    expect(specs[0]!.colour).toMatch(/^#[0-9a-f]{6}$/);
    expect(specs[0]!.colour).not.toBe(specs[1]!.colour);
  });

  it('rejects a non-array', () => {
    expect(() => buildCarSpecs({})).toThrow(CarValidationError);
    expect(() => buildCarSpecs([])).toThrow(CarValidationError);
  });

  it('rejects duplicate ids', () => {
    expect(() => buildCarSpecs([validRawCar({ id: 'dup' }), validRawCar({ id: 'dup' })])).toThrow(/duplicate/);
  });

  it('rejects a missing/non-finite required numeric field', () => {
    expect(() => buildCarSpecs([validRawCar({ mass: 'heavy' })])).toThrow(/non-finite/);
    expect(() => buildCarSpecs([validRawCar({ vMaxKmh: NaN })])).toThrow(/non-finite/);
  });

  it('rejects a missing name', () => {
    expect(() => buildCarSpecs([validRawCar({ name: '' })])).toThrow(/name/);
  });

  it('R3: defaults lineQuality to 1.05 when omitted', () => {
    const [spec] = buildCarSpecs([validRawCar()]);
    expect(spec!.lineQuality).toBeCloseTo(1.05, 10);
  });

  it('R3: keeps an explicit lineQuality within range', () => {
    const [spec] = buildCarSpecs([validRawCar({ lineQuality: 1.1 })]);
    expect(spec!.lineQuality).toBeCloseTo(1.1, 10);
  });

  it('R3: rejects lineQuality outside [1.00, 1.15]', () => {
    expect(() => buildCarSpecs([validRawCar({ lineQuality: 0.9 })])).toThrow(/lineQuality/);
    expect(() => buildCarSpecs([validRawCar({ lineQuality: 1.2 })])).toThrow(/lineQuality/);
  });

  it('R9: defaults induction to "forced" (no altitude derate) when omitted', () => {
    const [spec] = buildCarSpecs([validRawCar()]);
    expect(spec!.induction).toBe('forced');
  });

  it('R9: keeps an explicit induction value', () => {
    const [spec] = buildCarSpecs([validRawCar({ induction: 'na' })]);
    expect(spec!.induction).toBe('na');
  });

  it('R9: rejects an induction value outside "na"/"forced"', () => {
    expect(() => buildCarSpecs([validRawCar({ induction: 'turbo' })])).toThrow(/induction/);
  });

  it('R14: defaults peakPowerSpeed to 5 (pre-R14 behaviour) when omitted', () => {
    const [spec] = buildCarSpecs([validRawCar()]);
    expect(spec!.peakPowerSpeed).toBe(5);
  });

  it('R14: keeps an explicit peakPowerSpeed', () => {
    const [spec] = buildCarSpecs([validRawCar({ peakPowerSpeed: 18 })]);
    expect(spec!.peakPowerSpeed).toBe(18);
  });

  it('R14: rejects a non-positive peakPowerSpeed', () => {
    expect(() => buildCarSpecs([validRawCar({ peakPowerSpeed: 0 })])).toThrow(/peakPowerSpeed/);
    expect(() => buildCarSpecs([validRawCar({ peakPowerSpeed: -5 })])).toThrow(/peakPowerSpeed/);
  });
});
