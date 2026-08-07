import type { CarSpec, Route, RoutePoint } from './types';

export const TEST_SPACING = 25;

interface RouteShape {
  n: number; // number of points
  radiusAt?: (i: number) => number;
  gradeAt?: (i: number) => number;
  surfaceAt?: (i: number) => number | undefined; // R8: omit for a legacy (untagged) route
  limitAt?: (i: number) => number | undefined; // R10: omit for a legacy (untagged) route
}

/** Synthetic route for unit tests — a straight ENU line, spaced 25 m apart,
 * with caller-supplied radius/grade profiles per index. Avoids depending on
 * real (multi-MB) baked route fixtures for pure-function tests. */
export function makeTestRoute({ n, radiusAt = () => 3000, gradeAt = () => 0, surfaceAt, limitAt }: RouteShape): Route {
  const points: RoutePoint[] = [];
  for (let i = 0; i < n; i++) {
    const s = i * TEST_SPACING;
    const surface = surfaceAt?.(i);
    const limit = limitAt?.(i);
    points.push({
      s,
      lon: s / 111_000, // arbitrary but monotone
      lat: 0,
      ele: 0,
      grade: gradeAt(i),
      radius: radiusAt(i),
      ...(surface !== undefined ? { surface } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
  }
  return {
    origin: { lon: 0, lat: 0 },
    totalDistance: points[points.length - 1]!.s,
    spacing: TEST_SPACING,
    points,
  };
}

export const TEST_CAR: CarSpec = {
  id: 'test-car',
  name: 'Test Car',
  type: 'car',
  make: 'Test',
  colour: '#ffffff',
  mass: 1450,
  power: 200_000,
  cdA: 0.7,
  crr: 0.01,
  muLong: 0.95,
  muLat: 0.98,
  vMax: 275 / 3.6,
  aggression: 1.06,
  limitTolerance: 1.0,
  errorSigma: 0.05,
  lineQuality: 1.05,
  induction: 'forced',
  pitchLimitG: Infinity,
  peakPowerSpeed: 5,
};
