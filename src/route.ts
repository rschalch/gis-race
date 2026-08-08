import type { Route, RouteIndexEntry } from './types';

export class RouteValidationError extends Error {}

const FINITE_POINT_FIELDS = ['s', 'lon', 'lat', 'ele', 'grade', 'radius'] as const;

/**
 * A stale or hand-edited route file (old schema, missing fields, non-uniform
 * spacing) would otherwise produce NaNs deep in the sim instead of a clear
 * error (R7) — this converts a bad-data bug into one readable message at
 * load time.
 *
 * Every point is checked, not a first/middle/last sample. Sampling was chosen
 * to avoid an O(n) scan per load, but the `s`-monotonicity check below was
 * already O(n), so the sampling bought nothing while leaving the actual
 * failure mode wide open: a single non-finite `radius` or `grade` anywhere in
 * the interior passed validation and then propagated NaN through
 * `computeSpeedProfile` into every downstream car state, with no error and no
 * obvious symptom beyond cars that silently stop moving. A full scan of a
 * ~9000-point route is a few hundred microseconds, once, against a `fetch`
 * that just took orders of magnitude longer.
 */
export function assertRoute(value: unknown, slug: string): asserts value is Route {
  const fail = (msg: string): never => {
    throw new RouteValidationError(`Route "${slug}" failed validation: ${msg}`);
  };

  if (typeof value !== 'object' || value === null) fail('not an object');
  const route = value as Route;

  if (!Array.isArray(route.points) || route.points.length < 2) fail('points must be an array of at least 2 entries');
  if (!(route.spacing > 0)) fail('spacing must be a positive number');
  if (!Number.isFinite(route.totalDistance) || route.totalDistance <= 0) fail('totalDistance must be a positive number');

  // One pass over every point: finiteness of the required fields, the
  // optional R8/R10 fields when present, and monotone `s`.
  for (let i = 0; i < route.points.length; i++) {
    const point = route.points[i]!;
    if (typeof point !== 'object' || point === null) fail(`point ${i} is not an object`);
    for (const field of FINITE_POINT_FIELDS) {
      if (!Number.isFinite(point[field])) fail(`non-finite ${field} at index ${i}`);
    }
    // R8/R10: optional fields, absent on every route baked before they
    // existed — validate finiteness only when present (P5/§0.5 schema
    // compatibility).
    if (point.surface !== undefined && !Number.isFinite(point.surface)) fail(`non-finite surface at index ${i}`);
    if (point.limit !== undefined && !Number.isFinite(point.limit)) fail(`non-finite limit at index ${i}`);
    // A zero-length segment divides by zero in interpolateAt/radiusAt, so
    // strict increase (not merely non-decreasing) is what the interpolators
    // actually require.
    if (i > 0 && !(point.s > route.points[i - 1]!.s)) fail(`s is not monotonically increasing at index ${i}`);
  }

  // Render-only full-resolution geometry — optional (§0.5), so validate
  // structure only when present. Scanned in full for the same reason as the
  // points above: one bad coordinate mid-array draws a line across the map to
  // (NaN, NaN) and silently drops the rest of the road.
  if (route.turnaroundS !== undefined) {
    if (!Number.isFinite(route.turnaroundS) || route.turnaroundS <= 0 || route.turnaroundS >= route.totalDistance) {
      fail('turnaroundS must be a finite distance strictly inside the route');
    }
  }
  if (route.shape !== undefined) {
    if (!Array.isArray(route.shape) || route.shape.length < 2) fail('shape must be an array of at least 2 coordinates');
    for (let i = 0; i < route.shape.length; i++) {
      const coord = route.shape[i];
      if (!Array.isArray(coord) || coord.length !== 2 || !Number.isFinite(coord[0]) || !Number.isFinite(coord[1])) {
        fail(`shape[${i}] is not a finite [lon, lat] pair`);
      }
    }
  }
}

export async function loadRoute(slug: string): Promise<Route> {
  const res = await fetch(`/data/routes/${slug}.json`);
  if (!res.ok) {
    throw new Error(`Failed to load route "${slug}": ${res.status} ${res.statusText}`);
  }
  const data: unknown = await res.json();
  assertRoute(data, slug);
  return data;
}

export async function loadRouteIndex(): Promise<RouteIndexEntry[]> {
  const res = await fetch('/data/routes/index.json');
  if (!res.ok) {
    throw new Error(`Failed to load route index: ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as RouteIndexEntry[];
}

export interface RouteSample {
  lon: number;
  lat: number;
  ele: number;
  grade: number;
  radius: number;
  surface: number; // R8: always resolved (missing endpoint(s) default to 1.0), never optional here
}

/** §6.3: interpolate route data at an arbitrary distance along the route. */
export function interpolateAt(route: Route, s: number): RouteSample {
  const clamped = Math.max(0, Math.min(s, route.totalDistance));
  const i = Math.min(Math.floor(clamped / route.spacing), route.points.length - 2);
  const a = route.points[i]!;
  const b = route.points[i + 1]!;
  // (b.s - a.s), not route.spacing (B12): the baker appends a true final
  // point at the destination, whose segment can be shorter than `spacing`
  // when totalDistance isn't an exact multiple of it.
  const t = (clamped - a.s) / (b.s - a.s);

  return {
    lon: a.lon + t * (b.lon - a.lon),
    lat: a.lat + t * (b.lat - a.lat),
    ele: a.ele + t * (b.ele - a.ele),
    grade: a.grade + t * (b.grade - a.grade),
    radius: Math.min(a.radius, b.radius),
    // R8: untagged (either endpoint) defaults to 1.0 (neutral) rather than
    // omitting the field — callers always need a usable multiplier.
    surface: (a.surface ?? 1) + t * ((b.surface ?? 1) - (a.surface ?? 1)),
  };
}

/**
 * Linearly-interpolated radius, distinct from interpolateAt's conservative
 * min-of-neighbours (§6.3, intended for rendering/position lookups). The
 * min convention creates a step discontinuity at every 25 m bucket boundary
 * — the instant `s` crosses into a bucket, the *entire* bucket reads as
 * having the tighter of its two endpoints' radius, even 25 m before the
 * car is anywhere near that point. §7.5's grip-utilisation check needs the
 * radius the car is actually experiencing right now, which is what this
 * gives — a smooth interpolation matching how a real corner tightens.
 */
export function radiusAt(route: Route, s: number): number {
  const clamped = Math.max(0, Math.min(s, route.totalDistance));
  const i = Math.min(Math.floor(clamped / route.spacing), route.points.length - 2);
  const a = route.points[i]!;
  const b = route.points[i + 1]!;
  const t = (clamped - a.s) / (b.s - a.s); // see interpolateAt's B12 note
  return a.radius + t * (b.radius - a.radius);
}

/**
 * Default span headingAt averages over, centred on the car.
 *
 * Wide enough to smooth the 25 m grid's quantisation, and used for the chase
 * camera where a little extra smoothing is welcome — the camera has its own
 * easing on top.
 */
export const CAMERA_HEADING_WINDOW_M = 75;

/**
 * Span used to orient the car models.
 *
 * Much tighter than the camera's: a model must point along the road it is on
 * *now*. Roughly one route segment either side is enough to smooth the 25 m
 * quantisation without smearing the corner across the approach to it.
 */
export const CAR_HEADING_WINDOW_M = 30;

/**
 * Compass bearing (degrees, 0 = north, positive clockwise) of the route at
 * distance `s`.
 *
 * Derived purely from baked geometry for *rendering* — exactly like lon/lat
 * in interpolateAt, and subject to the same rule: this is not simulation
 * state, and nothing in sim.ts/driver.ts/physics.ts may read it. The sim
 * stays one-dimensional (§0 ground rules). (R16's wind reads road bearing
 * too, but as a per-point route *property* via pointBearingsRad below —
 * like grade or radius, an input the 1D sim samples at `s`, never car
 * state. This function stays render-only: its centred smoothing window is
 * a camera nicety, not geometry.)
 */
export function headingAt(route: Route, s: number, windowM: number = CAMERA_HEADING_WINDOW_M): number {
  // CENTRED on s — half the window behind, half ahead. This originally sampled
  // forward only (s to s + window), which meant the reported heading was the
  // road's direction up to 75 m *ahead* of the car: every car began rotating
  // three-quarters of a corner before reaching it, and read as sliding
  // sideways down the road. A centred window gives the tangent where the car
  // actually is.
  const half = windowM / 2;
  let start = s - half;
  let end = s + half;
  // Slide (don't shrink) the window at the route ends, so it never collapses
  // to zero length — atan2(0, 0) would otherwise pin the heading due north.
  if (start < 0) {
    start = 0;
    end = Math.min(windowM, route.totalDistance);
  } else if (end > route.totalDistance) {
    end = route.totalDistance;
    start = Math.max(0, route.totalDistance - windowM);
  }
  const a = interpolateAt(route, start);
  const b = interpolateAt(route, end);

  // Equirectangular approximation: over a window this short the convergence of
  // the meridians is the only correction that matters, and cos(lat) covers it.
  const meanLat = (((a.lat + b.lat) / 2) * Math.PI) / 180;
  const dx = (b.lon - a.lon) * Math.cos(meanLat);
  const dy = b.lat - a.lat;
  if (dx === 0 && dy === 0) return 0;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

/**
 * R16: per-point road bearing in radians (0 = north, clockwise), one entry
 * per route point — the segment direction from each point to the next, last
 * point repeating its predecessor.
 *
 * This is the physics-facing sibling of headingAt: bearing consumed as a
 * per-point route *property* (like grade or radius) so the sim can project
 * a race-level wind vector onto the road. Computed once per route — callers
 * cache the result (createSim does) rather than re-deriving per step. The
 * sim still holds no heading state; it samples this exactly the way it
 * samples grade.
 */
export function pointBearingsRad(route: Route): Float64Array {
  const n = route.points.length;
  const bearings = new Float64Array(n);
  for (let i = 0; i < n - 1; i++) {
    const a = route.points[i]!;
    const b = route.points[i + 1]!;
    const meanLat = (((a.lat + b.lat) / 2) * Math.PI) / 180;
    const dx = (b.lon - a.lon) * Math.cos(meanLat);
    const dy = b.lat - a.lat;
    bearings[i] = dx === 0 && dy === 0 ? (i > 0 ? bearings[i - 1]! : 0) : Math.atan2(dx, dy);
  }
  if (n > 1) bearings[n - 1] = bearings[n - 2]!;
  return bearings;
}

/**
 * R8: linearly-interpolated surface grip multiplier, structured exactly like
 * radiusAt — a lean dedicated helper for driver.ts's per-step
 * driverControl/evaluateLossOfControl, which need the grip composition but
 * not interpolateAt's full lon/lat/ele/grade bundle.
 */
export function surfaceAt(route: Route, s: number): number {
  const clamped = Math.max(0, Math.min(s, route.totalDistance));
  const i = Math.min(Math.floor(clamped / route.spacing), route.points.length - 2);
  const a = route.points[i]!;
  const b = route.points[i + 1]!;
  const t = (clamped - a.s) / (b.s - a.s);
  const sa = a.surface ?? 1;
  const sb = b.surface ?? 1;
  return sa + t * (sb - sa);
}
