import type { Route, RouteIndexEntry } from './types';

export class RouteValidationError extends Error {}

const FINITE_POINT_FIELDS = ['s', 'lon', 'lat', 'ele', 'grade', 'radius'] as const;

/**
 * A stale or hand-edited route file (old schema, missing fields, non-uniform
 * spacing) would otherwise produce NaNs deep in the sim instead of a clear
 * error (R7) — this converts a bad-data bug into one readable message at
 * load time. Checks structure, monotone `s`, and finiteness on the first,
 * last, and middle points (not every point — cheap, and enough to catch a
 * genuinely malformed file without an O(n) scan on every load).
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

  for (let i = 1; i < route.points.length; i++) {
    if (!(route.points[i]!.s > route.points[i - 1]!.s)) fail(`s is not monotonically increasing at index ${i}`);
  }

  const sampleIndices = new Set([0, Math.floor(route.points.length / 2), route.points.length - 1]);
  for (const i of sampleIndices) {
    const point = route.points[i]!;
    for (const field of FINITE_POINT_FIELDS) {
      if (!Number.isFinite(point[field])) fail(`non-finite ${field} at index ${i}`);
    }
    // R8/R10: optional fields, absent on every route baked before they
    // existed — validate finiteness only when present (P5/§0.5 schema
    // compatibility).
    if (point.surface !== undefined && !Number.isFinite(point.surface)) fail(`non-finite surface at index ${i}`);
    if (point.limit !== undefined && !Number.isFinite(point.limit)) fail(`non-finite limit at index ${i}`);
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
