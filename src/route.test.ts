import { describe, it, expect } from 'vitest';
import { interpolateAt, radiusAt, surfaceAt, assertRoute, RouteValidationError } from './route';
import { makeTestRoute } from './test-fixtures';

describe('interpolateAt', () => {
  it('linearly interpolates lon/lat/ele/grade between neighbouring points', () => {
    const route = makeTestRoute({ n: 10 });
    const a = route.points[2]!;
    const b = route.points[3]!;
    const sample = interpolateAt(route, a.s + route.spacing / 2);
    expect(sample.lon).toBeCloseTo((a.lon + b.lon) / 2, 10);
  });

  it('clamps s to [0, totalDistance]', () => {
    const route = makeTestRoute({ n: 10 });
    const below = interpolateAt(route, -100);
    const above = interpolateAt(route, route.totalDistance + 1000);
    expect(below.lon).toBeCloseTo(route.points[0]!.lon, 10);
    expect(above.lon).toBeCloseTo(route.points[route.points.length - 1]!.lon, 10);
  });

  it('uses the conservative min-of-neighbours radius (not linear interpolation)', () => {
    const route = makeTestRoute({ n: 10, radiusAt: (i) => (i === 3 ? 30 : 3000) });
    // Halfway between point 2 (radius 3000) and point 3 (radius 30): min-of-
    // neighbours should read 30, not the linear midpoint ~1515.
    const sample = interpolateAt(route, route.points[2]!.s + route.spacing / 2);
    expect(sample.radius).toBe(30);
  });
});

describe('radiusAt', () => {
  it('linearly interpolates radius between neighbouring points (unlike interpolateAt)', () => {
    const route = makeTestRoute({ n: 10, radiusAt: (i) => (i === 2 ? 100 : i === 3 ? 300 : 3000) });
    const mid = radiusAt(route, route.points[2]!.s + route.spacing / 2);
    expect(mid).toBeCloseTo(200, 5);
  });

  it('clamps s to route bounds', () => {
    const route = makeTestRoute({ n: 10, radiusAt: () => 500 });
    expect(radiusAt(route, -50)).toBeCloseTo(500, 5);
    expect(radiusAt(route, route.totalDistance + 500)).toBeCloseTo(500, 5);
  });
});

describe('B12: non-uniform final segment', () => {
  // The baker appends a true endpoint (B12) which can leave the final
  // segment shorter than `spacing` — interpolateAt/radiusAt must use each
  // segment's own length, not `route.spacing`, or this case interpolates
  // incorrectly.
  function makeShortFinalSegmentRoute() {
    const route = makeTestRoute({ n: 5, radiusAt: () => 500 });
    const last = route.points[route.points.length - 1]!;
    // Shrink the final segment to 10 m (< 25 m spacing) and halve its radius.
    route.points[route.points.length - 1] = { ...last, s: last.s - 15, radius: 250 };
    route.totalDistance = route.points[route.points.length - 1]!.s;
    return route;
  }

  it('interpolateAt interpolates correctly across a shortened final segment', () => {
    const route = makeShortFinalSegmentRoute();
    const secondLast = route.points[route.points.length - 2]!;
    const last = route.points[route.points.length - 1]!;
    const mid = interpolateAt(route, (secondLast.s + last.s) / 2);
    expect(mid.lon).toBeCloseTo((secondLast.lon + last.lon) / 2, 10);
  });

  it('radiusAt interpolates correctly across a shortened final segment', () => {
    const route = makeShortFinalSegmentRoute();
    const secondLast = route.points[route.points.length - 2]!;
    const last = route.points[route.points.length - 1]!;
    const mid = radiusAt(route, (secondLast.s + last.s) / 2);
    expect(mid).toBeCloseTo((secondLast.radius + last.radius) / 2, 5);
  });
});

describe('R8: interpolateAt/surfaceAt surface field', () => {
  it('defaults to 1.0 for a legacy route with no surface field at all', () => {
    const route = makeTestRoute({ n: 10 });
    expect(interpolateAt(route, 50).surface).toBe(1);
    expect(surfaceAt(route, 50)).toBe(1);
  });

  it('linearly interpolates between two tagged points', () => {
    const route = makeTestRoute({ n: 10, surfaceAt: (i) => (i === 2 ? 0.6 : i === 3 ? 1.0 : undefined) });
    const mid = surfaceAt(route, route.points[2]!.s + route.spacing / 2);
    expect(mid).toBeCloseTo(0.8, 5);
  });

  it('treats a missing endpoint as 1.0 rather than propagating undefined', () => {
    const route = makeTestRoute({ n: 10, surfaceAt: (i) => (i === 2 ? 0.6 : undefined) });
    const mid = surfaceAt(route, route.points[2]!.s + route.spacing / 2);
    expect(mid).toBeCloseTo((0.6 + 1) / 2, 5);
  });
});

describe('assertRoute (R7)', () => {
  it('accepts a well-formed route', () => {
    const route = makeTestRoute({ n: 10 });
    expect(() => assertRoute(route, 'test')).not.toThrow();
  });

  it('rejects non-objects', () => {
    expect(() => assertRoute(null, 'test')).toThrow(RouteValidationError);
    expect(() => assertRoute('nope', 'test')).toThrow(RouteValidationError);
  });

  it('rejects fewer than 2 points', () => {
    const route = makeTestRoute({ n: 10 });
    expect(() => assertRoute({ ...route, points: [route.points[0]] }, 'test')).toThrow(RouteValidationError);
  });

  it('rejects non-monotonic s', () => {
    const route = makeTestRoute({ n: 10 });
    route.points[5]!.s = route.points[4]!.s;
    expect(() => assertRoute(route, 'test')).toThrow(/monotonically/);
  });

  it('rejects non-finite fields', () => {
    const route = makeTestRoute({ n: 10 });
    route.points[0]!.ele = NaN;
    expect(() => assertRoute(route, 'test')).toThrow(/non-finite/);
  });

  it('rejects a non-positive spacing or totalDistance', () => {
    const route = makeTestRoute({ n: 10 });
    expect(() => assertRoute({ ...route, spacing: 0 }, 'test')).toThrow(RouteValidationError);
    expect(() => assertRoute({ ...route, totalDistance: 0 }, 'test')).toThrow(RouteValidationError);
  });
});
