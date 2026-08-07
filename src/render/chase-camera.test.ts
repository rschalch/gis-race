import { describe, it, expect } from 'vitest';
import { cameraOffset, offsetLngLat, lineOfSightBlocked, shortestAngleDelta, metresPerPixel } from './chase-camera';

describe('metresPerPixel', () => {
  it('halves with each zoom level', () => {
    expect(metresPerPixel(15, 0) / metresPerPixel(14, 0)).toBeCloseTo(0.5, 10);
  });

  it('shrinks toward the poles', () => {
    expect(metresPerPixel(14, 60)).toBeLessThan(metresPerPixel(14, 0));
  });
});

describe('cameraOffset', () => {
  const FOV = 36.87;
  const H = 800;

  it('sits directly overhead at zero pitch', () => {
    const { groundDistanceM, heightM } = cameraOffset(14, 0, 0, H, FOV);
    expect(groundDistanceM).toBeCloseTo(0, 6);
    expect(heightM).toBeGreaterThan(0);
  });

  it('moves back and drops as pitch increases', () => {
    const low = cameraOffset(14, 0, 30, H, FOV);
    const high = cameraOffset(14, 0, 75, H, FOV);
    // Higher pitch = camera swung further behind and closer to the ground.
    expect(high.groundDistanceM).toBeGreaterThan(low.groundDistanceM);
    expect(high.heightM).toBeLessThan(low.heightM);
  });

  it('keeps total camera distance independent of pitch', () => {
    const a = cameraOffset(14, 0, 20, H, FOV);
    const b = cameraOffset(14, 0, 70, H, FOV);
    // Pitch rotates the camera about the centre; it does not dolly it.
    expect(Math.hypot(a.groundDistanceM, a.heightM)).toBeCloseTo(Math.hypot(b.groundDistanceM, b.heightM), 5);
  });

  it('scales distance with ground resolution', () => {
    const near = cameraOffset(15, 0, 60, H, FOV);
    const far = cameraOffset(14, 0, 60, H, FOV);
    expect(far.groundDistanceM / near.groundDistanceM).toBeCloseTo(2, 6);
  });
});

describe('offsetLngLat', () => {
  it('moves north for bearing 0 and east for bearing 90', () => {
    const [lonN, latN] = offsetLngLat(0, 0, 0, 1000);
    expect(latN).toBeGreaterThan(0);
    expect(lonN).toBeCloseTo(0, 10);

    const [lonE, latE] = offsetLngLat(0, 0, 90, 1000);
    expect(lonE).toBeGreaterThan(0);
    expect(latE).toBeCloseTo(0, 10);
  });

  it('is reversible through opposite bearings', () => {
    const [lon1, lat1] = offsetLngLat(-47.4, -23.5, 137, 800);
    const [lon2, lat2] = offsetLngLat(lon1, lat1, 137 + 180, 800);
    expect(lon2).toBeCloseTo(-47.4, 6);
    expect(lat2).toBeCloseTo(-23.5, 6);
  });

  it('needs more longitude per metre away from the equator', () => {
    const [lonEq] = offsetLngLat(0, 0, 90, 1000);
    const [lonHigh] = offsetLngLat(0, 60, 90, 1000);
    expect(Math.abs(lonHigh)).toBeGreaterThan(Math.abs(lonEq));
  });
});

describe('lineOfSightBlocked', () => {
  it('is clear over flat ground below the sightline', () => {
    // Camera 100 m up, car on the deck, ground flat at 0.
    expect(lineOfSightBlocked(100, 0, [0, 0, 0, 0], 8)).toBe(false);
  });

  it('is blocked by a ridge standing above the sightline', () => {
    // Sightline runs 100 -> 0; at the midpoint it is ~50. A 90 m ridge blocks.
    expect(lineOfSightBlocked(100, 0, [10, 90, 10, 10], 8)).toBe(true);
  });

  it('respects the clearance margin', () => {
    // Sightline at the single sample (t=0.5) is 50 m. Ground at 55 m is only
    // 5 m proud — inside a 8 m clearance, so not yet blocking.
    expect(lineOfSightBlocked(100, 0, [55], 8)).toBe(false);
    expect(lineOfSightBlocked(100, 0, [61], 8)).toBe(true);
  });

  it('accounts for the sightline sloping down toward the car', () => {
    // Ground rising to 70 m near the camera end (t=0.25, sightline 75) is
    // clear, but the same 70 m near the car end (t=0.75, sightline 25) is not.
    expect(lineOfSightBlocked(100, 0, [70, 0, 0], 8)).toBe(false);
    expect(lineOfSightBlocked(100, 0, [0, 0, 70], 8)).toBe(true);
  });

  it('reports clear when there is nothing between', () => {
    expect(lineOfSightBlocked(100, 0, [], 8)).toBe(false);
  });
});

describe('shortestAngleDelta', () => {
  it('takes the short way across the 0/360 seam', () => {
    expect(shortestAngleDelta(350, 10)).toBeCloseTo(20, 10);
    expect(shortestAngleDelta(10, 350)).toBeCloseTo(-20, 10);
  });

  it('is zero for equal angles', () => {
    expect(shortestAngleDelta(137, 137)).toBeCloseTo(0, 10);
  });

  it('never exceeds half a turn', () => {
    for (let a = 0; a < 360; a += 17) {
      for (let b = 0; b < 360; b += 23) {
        expect(Math.abs(shortestAngleDelta(a, b))).toBeLessThanOrEqual(180.0001);
      }
    }
  });
});
