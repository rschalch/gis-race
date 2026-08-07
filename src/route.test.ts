import { describe, it, expect } from 'vitest';
import {
  interpolateAt,
  radiusAt,
  surfaceAt,
  headingAt,
  assertRoute,
  RouteValidationError,
  CAR_HEADING_WINDOW_M,
  CAMERA_HEADING_WINDOW_M,
} from './route';
import { makeTestRoute } from './test-fixtures';

/** makeTestRoute runs due east along the equator; these cover other headings. */
function makeOrientedRoute(dLon: number, dLat: number, n = 40) {
  const base = makeTestRoute({ n });
  return {
    ...base,
    points: base.points.map((p, i) => ({ ...p, lon: i * dLon, lat: i * dLat })),
  };
}

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

  // Validation used to sample only the first, middle and last points, so a
  // corrupt interior point loaded cleanly and then propagated NaN through the
  // speed profile into every car — no error, no obvious symptom.
  it('rejects a non-finite field at an interior index, not just the sampled ones', () => {
    for (const field of ['radius', 'grade', 'ele', 'lon', 'lat'] as const) {
      const route = makeTestRoute({ n: 101 });
      route.points[37]![field] = NaN;
      expect(() => assertRoute(route, 'test')).toThrow(new RegExp(`non-finite ${field} at index 37`));
    }
  });

  it('rejects a non-finite optional surface/limit at an interior index', () => {
    const withSurface = makeTestRoute({ n: 101, surfaceAt: () => 1 });
    withSurface.points[42]!.surface = NaN;
    expect(() => assertRoute(withSurface, 'test')).toThrow(/non-finite surface at index 42/);

    const withLimit = makeTestRoute({ n: 101, limitAt: () => 25 });
    withLimit.points[42]!.limit = Infinity;
    expect(() => assertRoute(withLimit, 'test')).toThrow(/non-finite limit at index 42/);
  });

  it('rejects a bad shape coordinate at an interior index', () => {
    const route = makeTestRoute({ n: 10 });
    const shape: Array<[number, number]> = Array.from({ length: 101 }, (_, i) => [i / 1000, 0]);
    shape[57] = [0.057, NaN];
    expect(() => assertRoute({ ...route, shape }, 'test')).toThrow(/shape\[57\]/);
  });
});

describe('headingAt', () => {
  it('reads due east on the eastward test route', () => {
    const route = makeTestRoute({ n: 40 });
    expect(headingAt(route, 200)).toBeCloseTo(90, 4);
  });

  it('reads the cardinal directions', () => {
    expect(headingAt(makeOrientedRoute(0, 0.001), 200)).toBeCloseTo(0, 4); // north
    expect(headingAt(makeOrientedRoute(0, -0.001), 200)).toBeCloseTo(180, 4); // south
    expect(headingAt(makeOrientedRoute(-0.001, 0), 200)).toBeCloseTo(-90, 4); // west
    expect(headingAt(makeOrientedRoute(0.001, 0.001), 200)).toBeCloseTo(45, 1); // north-east
  });

  it('stays on-heading at the finish instead of collapsing to due north', () => {
    // The lookahead window would otherwise clamp both samples onto the final
    // point, leaving atan2(0, 0) to pin the camera north on every finish.
    const route = makeTestRoute({ n: 40 });
    expect(headingAt(route, route.totalDistance)).toBeCloseTo(90, 4);
  });

  it('stays finite past both ends of the route', () => {
    const route = makeTestRoute({ n: 40 });
    expect(Number.isFinite(headingAt(route, -500))).toBe(true);
    expect(Number.isFinite(headingAt(route, route.totalDistance + 500))).toBe(true);
  });

  it('handles a route shorter than the lookahead window', () => {
    const route = makeTestRoute({ n: 2 }); // 25 m total, vs a 75 m window
    expect(headingAt(route, 0)).toBeCloseTo(90, 4);
  });
});

describe('Route.shape (render-only full-resolution geometry)', () => {
  it('accepts a route with no shape at all (pre-existing bakes)', () => {
    const route = makeTestRoute({ n: 10 });
    expect(route.shape).toBeUndefined();
    expect(() => assertRoute(route, 'test')).not.toThrow();
  });

  it('accepts a well-formed shape', () => {
    const route = { ...makeTestRoute({ n: 10 }), shape: [[0, 0], [0.1, 0.1]] };
    expect(() => assertRoute(route, 'test')).not.toThrow();
  });

  it('rejects a malformed shape rather than letting it reach the renderer', () => {
    const base = makeTestRoute({ n: 10 });
    expect(() => assertRoute({ ...base, shape: [] }, 'test')).toThrow(/shape/);
    expect(() => assertRoute({ ...base, shape: [[0, 0]] }, 'test')).toThrow(/shape/);
    expect(() => assertRoute({ ...base, shape: [[0, 0], [NaN, 1]] }, 'test')).toThrow(/shape/);
    expect(() => assertRoute({ ...base, shape: [[0, 0], [1]] }, 'test')).toThrow(/shape/);
  });
});

describe('headingAt window is centred on the car (not forward-looking)', () => {
  // L-shaped route: 200 m due east, then 200 m due north. The corner is at
  // s = 200. Built at the equator so 25 m is a constant step in both axes.
  function makeCornerRoute() {
    const d = 25 / 111_320;
    const base = makeTestRoute({ n: 17 });
    const points = base.points.map((p, i) => {
      if (i <= 8) return { ...p, lon: i * d, lat: 0 };
      return { ...p, lon: 8 * d, lat: (i - 8) * d };
    });
    return { ...base, points };
  }

  const route = makeCornerRoute();

  it('still points along the straight 50 m before the corner', () => {
    // The regression this guards: a forward-only window (s .. s+75) reported
    // the road's direction up to 75 m ahead, so a car at s=150 already read as
    // part-way round a corner it had not reached — which looked like the car
    // sliding sideways down the road.
    expect(headingAt(route, 150, 30)).toBeCloseTo(90, 1); // due east
    expect(headingAt(route, 150)).toBeCloseTo(90, 1); // camera window too
  });

  it('reads the corner only while on it', () => {
    // Halfway through the turn the centred window straddles both legs.
    expect(headingAt(route, 200, 30)).toBeCloseTo(45, 1);
  });

  it('has settled onto the new heading past the corner', () => {
    expect(headingAt(route, 250, 30)).toBeCloseTo(0, 1); // due north
  });

  it('turns symmetrically about the corner', () => {
    // Equal distances either side should sit equally far from the 45° apex —
    // an off-centre window makes the approach and exit asymmetric.
    const before = headingAt(route, 175, 30);
    const after = headingAt(route, 225, 30);
    expect(90 - before).toBeCloseTo(after - 0, 1);
  });

  it('turns over a shorter distance with the tighter car window', () => {
    // The car window must commit to the corner later than the camera's, or the
    // models lead the camera into the turn.
    const carLead = 90 - headingAt(route, 180, CAR_HEADING_WINDOW_M);
    const cameraLead = 90 - headingAt(route, 180, CAMERA_HEADING_WINDOW_M);
    expect(carLead).toBeLessThan(cameraLead);
  });
});
