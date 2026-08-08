// Shared route-baking logic (§5), used by both the `npm run bake` CLI
// (tools/bake-route.ts) and the live dev-server bake API
// (tools/dev-routes-api.ts) for on-demand custom routes. Node-only — relies
// on server-side fetch to reach Valhalla/OSRM/Nominatim/OpenTopoData, which
// the browser can't do directly (Nominatim needs a User-Agent JS can't set,
// and OpenTopoData sends no CORS headers at all).

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Route, RoutePoint, RouteIndexEntry } from '../src/types.ts';
import { parseEndpointText, formatLatLon, MAX_VIA_STOPS } from '../src/coords';

export const SPACING = 25; // metres — §5.3
export const MAX_DISTANCE_KM = 1000; // practical cap for an interactive, user-is-waiting bake

const OPENTOPODATA_URL = 'https://api.opentopodata.org/v1/srtm30m';
const NOMINATIM_URL = 'https://nominatim.openstreetmap.org';
const BAKER_USER_AGENT = 'gis-racer-route-baker/1.0 (local dev tool, offline route baking)';
const NOMINATIM_MIN_INTERVAL_MS = 1100; // Nominatim policy: max 1 req/s

interface OsrmResponse {
  code: string;
  routes: Array<{
    distance: number;
    geometry: { coordinates: [number, number][] };
  }>;
}

// F1: FOSSGIS's public Valhalla instance — primary geometry source because
// its alternate-route generation actually returns alternates far more often
// than OSRM's demo server does (verified on Petrópolis→Teresópolis: Valhalla
// 3 routes, OSRM demo 1). OSRM remains the fallback when Valhalla is down.
const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';

interface ValhallaTrip {
  legs: Array<{ shape: string }>;
  summary: { length: number }; // kilometres (we request units explicitly)
}

interface ValhallaResponse {
  trip?: ValhallaTrip;
  alternates?: Array<{ trip: ValhallaTrip }>;
  error?: string;
  error_code?: number;
}

interface OpenTopoDataResponse {
  status: string;
  results: Array<{ elevation: number | null }>;
}

interface NominatimResult {
  lon: string;
  lat: string;
  display_name: string;
}

export class BakeError extends Error {}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// --- shared Nominatim throttle: at most 1 req/s across geocoding AND
// autocomplete search, however many callers there are (single dev-server
// process, so a module-level timestamp is enough). ---
let lastNominatimCall = 0;

async function nominatimFetch(url: string): Promise<Response> {
  const wait = NOMINATIM_MIN_INTERVAL_MS - (Date.now() - lastNominatimCall);
  if (wait > 0) await sleep(wait);
  lastNominatimCall = Date.now();
  return fetch(url, { headers: { 'User-Agent': BAKER_USER_AGENT } });
}

/** Autocomplete-as-you-type suggestions, server-proxied (browser can't call
 * Nominatim directly and comply with its User-Agent requirement). */
export async function searchPlaces(query: string): Promise<Array<{ label: string; lon: number; lat: number }>> {
  if (query.trim().length < 3) return [];
  const url = `${NOMINATIM_URL}/search?format=json&q=${encodeURIComponent(query)}&limit=5`;
  const res = await nominatimFetch(url);
  if (!res.ok) throw new BakeError(`Nominatim search failed: ${res.status} ${res.statusText}`);
  const results = (await res.json()) as NominatimResult[];
  return results.map((r) => ({ label: r.display_name, lon: parseFloat(r.lon), lat: parseFloat(r.lat) }));
}

/**
 * Nominatim reverse lookup, used only to *name* an endpoint given as
 * coordinates. Never to place one: the coordinates are the truth, and this is
 * cosmetic — so a failure falls back to the formatted pair rather than
 * aborting a bake that is otherwise perfectly well specified.
 */
async function reverseGeocode(lon: number, lat: number): Promise<string | null> {
  try {
    const url = `${NOMINATIM_URL}/reverse?format=json&lon=${lon}&lat=${lat}&zoom=14`;
    const res = await nominatimFetch(url);
    if (!res.ok) return null;
    const result = (await res.json()) as { display_name?: string; address?: Record<string, string> };
    const address = result.address ?? {};
    // The full display_name is a postal address ("R. Ten. ..., Sorocaba, São
    // Paulo, Região Sudeste, 18000-000, Brasil") — far too long for a course
    // name. Prefer the settlement.
    const place =
      address.city ?? address.town ?? address.village ?? address.municipality ?? address.county ?? address.state;
    return place ?? result.display_name?.split(',')[0]?.trim() ?? null;
  } catch {
    return null;
  }
}

async function geocode(query: string): Promise<[number, number]> {
  const url = `${NOMINATIM_URL}/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
  const res = await nominatimFetch(url);
  if (!res.ok) throw new BakeError(`Nominatim request failed: ${res.status} ${res.statusText}`);
  const results = (await res.json()) as NominatimResult[];
  if (results.length === 0) throw new BakeError(`Couldn't find a place matching "${query}".`);
  const r = results[0]!;
  console.log(`  geocoded "${query}" -> ${r.display_name} (lon=${r.lon}, lat=${r.lat})`);
  return [parseFloat(r.lon), parseFloat(r.lat)];
}

export const MAX_ALTERNATIVES = 3; // bounds worst-case bake time — each variant repeats the full elevation fetch

export interface GeometryCandidate {
  coords: [number, number][];
  distanceM: number;
}

/** Decodes Google's encoded-polyline format at 1e-6 precision (Valhalla's
 * shape encoding — note OSRM and Google default to 1e-5) into [lon, lat]
 * pairs, matching the GeoJSON coordinate order the rest of the baker uses. */
export function decodePolyline6(encoded: string): [number, number][] {
  const coords: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lon = 0;
  while (index < encoded.length) {
    for (const axis of [0, 1] as const) {
      let result = 0;
      let shift = 0;
      let byte;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lon += delta;
    }
    coords.push([lon / 1e6, lat / 1e6]);
  }
  return coords;
}

// F1: Valhalla's `alternates` is the number of EXTRA routes on top of the
// primary. Unlike OSRM's demo server it returns them readily where a
// competing road exists; like OSRM, asking is still not a guarantee.
async function fetchValhallaGeometries(
  locations: [number, number][],
  alternatives: boolean,
): Promise<GeometryCandidate[]> {
  const request = {
    locations: locations.map(([lon, lat]) => ({ lon, lat })),
    costing: 'auto',
    // Alternatives are a two-point idea: with intermediate stops the path is
    // already pinned, and Valhalla rejects the combination rather than
    // ignoring it. Suppressed rather than refused — the route is still bakeable
    // and the caller is told (see fetchRouteGeometries).
    alternates: alternatives && locations.length === 2 ? MAX_ALTERNATIVES - 1 : 0,
    directions_type: 'none', // skip turn-by-turn maneuvers — only the shape is used
    units: 'kilometers',
  };
  console.log(`Fetching route${alternatives ? 's' : ''} from Valhalla: ${VALHALLA_URL}`);
  const res = await fetch(VALHALLA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': BAKER_USER_AGENT },
    body: JSON.stringify(request),
  });
  const body = (await res.json().catch(() => null)) as ValhallaResponse | null;
  if (!res.ok || !body?.trip) {
    throw new BakeError(
      `Valhalla request failed: ${body?.error ?? `${res.status} ${res.statusText}`}` +
        (body?.error_code !== undefined ? ` (error_code=${body.error_code})` : ''),
    );
  }

  // One leg per consecutive pair of locations, so a route through stops
  // arrives as several — flatMap stitches them back into one polyline.
  // summary.length is km (units requested explicitly above).
  const trips = [body.trip, ...(body.alternates ?? []).map((a) => a.trip)].slice(0, MAX_ALTERNATIVES);
  return trips.map((trip) => ({
    coords: trip.legs.flatMap((leg) => decodePolyline6(leg.shape)),
    distanceM: trip.summary.length * 1000,
  }));
}

async function fetchOsrmGeometries(
  locations: [number, number][],
  alternatives: boolean,
): Promise<GeometryCandidate[]> {
  const osrmUrl =
    `https://router.project-osrm.org/route/v1/driving/` +
    locations.map(([lon, lat]) => `${lon},${lat}`).join(';') +
    `?overview=full&geometries=geojson${alternatives && locations.length === 2 ? '&alternatives=true' : ''}`;
  console.log(`Fetching route${alternatives ? 's' : ''} from OSRM: ${osrmUrl}`);
  const res = await fetch(osrmUrl);
  if (!res.ok) {
    throw new BakeError(`OSRM request failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as OsrmResponse;
  if (body.code !== 'Ok' || body.routes.length === 0) {
    throw new BakeError(
      body.code === 'NoRoute'
        ? 'No drivable route found through those places — check the order, and that each one is on a road.'
        : `OSRM returned no route (code=${body.code})`,
    );
  }
  return body.routes
    .slice(0, MAX_ALTERNATIVES)
    .map((r) => ({ coords: r.geometry.coordinates, distanceM: r.distance }));
}

// --- §5.1 / F1: fetch route geometry, optionally with alternatives ---
// Valhalla (FOSSGIS public instance) is the primary source; OSRM's demo
// server is the fallback when Valhalla is down or errors — same resilience
// posture as the Overpass pass (degrade, don't fail the bake), except a
// routing failure on BOTH engines is fatal (there's nothing to bake).
export async function fetchRouteGeometries(
  locations: [number, number][],
  alternatives: boolean,
): Promise<GeometryCandidate[]> {
  if (locations.length < 2) throw new BakeError('A route needs at least a start and a finish.');
  if (alternatives && locations.length > 2) {
    console.log('  (alternatives skipped: a route through intermediate stops has only one shape)');
  }
  let candidates: GeometryCandidate[];
  let source = 'Valhalla';
  try {
    candidates = await fetchValhallaGeometries(locations, alternatives);
  } catch (err) {
    console.warn(`  WARNING: Valhalla failed (${String(err)}) — falling back to OSRM.`);
    source = 'OSRM';
    candidates = await fetchOsrmGeometries(locations, alternatives);
  }

  const valid = candidates.filter((c) => {
    const distanceKm = c.distanceM / 1000;
    return distanceKm >= 1 && distanceKm <= MAX_DISTANCE_KM; // see the primary-route checks below
  });

  const primary = candidates[0]!;
  const primaryDistanceKm = primary.distanceM / 1000;
  console.log(`${source} route distance: ${primaryDistanceKm.toFixed(1)} km (${valid.length} variant(s) usable)`);
  if (primaryDistanceKm < 1) {
    throw new BakeError(
      `${source} distance ${primaryDistanceKm.toFixed(1)} km looks implausible — check that both endpoints geocoded correctly.`,
    );
  }
  if (primaryDistanceKm > MAX_DISTANCE_KM) {
    throw new BakeError(
      `That route is ${primaryDistanceKm.toFixed(0)} km — over the ${MAX_DISTANCE_KM} km cap for an on-demand bake ` +
        `(elevation fetching is rate-limited to ~1 req/s, so longer routes take too long for an interactive wait).`,
    );
  }
  if (valid.length === 0) {
    // The primary route passed its own checks above but got filtered by the
    // generic loop (shouldn't happen — kept as a defensive fallback).
    valid.push(primary);
  }
  return valid;
}

// --- §5.2: project to local ENU metres ---
const R_EARTH = 6378137;

export function makeProjection(lon0: number, lat0: number) {
  const cosLat0 = Math.cos((lat0 * Math.PI) / 180);
  return {
    project(lon: number, lat: number): { x: number; y: number } {
      const x = (R_EARTH * ((lon - lon0) * Math.PI)) / 180 * cosLat0;
      const y = (R_EARTH * ((lat - lat0) * Math.PI)) / 180;
      return { x, y };
    },
    unproject(x: number, y: number): { lon: number; lat: number } {
      const lon = lon0 + (x / (R_EARTH * cosLat0)) * (180 / Math.PI);
      const lat = lat0 + (y / R_EARTH) * (180 / Math.PI);
      return { lon, lat };
    },
  };
}

function dist2D(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

// --- §5.3: resample to uniform 25 m spacing ---
export function resample(
  projected: Array<{ x: number; y: number }>,
  spacing: number,
): Array<{ s: number; x: number; y: number }> {
  const cum: number[] = [0];
  for (let i = 1; i < projected.length; i++) {
    cum.push(cum[i - 1]! + dist2D(projected[i - 1]!, projected[i]!));
  }
  const total = cum[cum.length - 1]!;
  const n = Math.floor(total / spacing);

  const result: Array<{ s: number; x: number; y: number }> = [];
  let segIdx = 0;
  const sampleAt = (s: number): { s: number; x: number; y: number } => {
    while (segIdx < cum.length - 2 && cum[segIdx + 1]! < s) segIdx++;
    const segStart = cum[segIdx]!;
    const segEnd = cum[segIdx + 1]!;
    const t = segEnd > segStart ? (s - segStart) / (segEnd - segStart) : 0;
    const a = projected[segIdx]!;
    const b = projected[segIdx + 1]!;
    return { s, x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
  };

  for (let k = 0; k <= n; k++) result.push(sampleAt(k * spacing));
  // §5.3 grid lands on k·spacing, so whenever `total` isn't an exact
  // multiple the final partial segment (and the true destination
  // coordinate) was silently dropped — the route ended up to `spacing`
  // metres short of the geocoded destination (B12). Appending the true
  // endpoint here means the last segment can be shorter than `spacing`;
  // route.ts's interpolateAt/radiusAt and driver.ts's driverControl are
  // written to use each segment's own length rather than assuming uniform
  // spacing, so this doesn't need special-casing downstream.
  if (n * spacing < total) result.push(sampleAt(total));
  return result;
}

// --- render-only full-resolution shape (see Route.shape) ---

/**
 * Douglas-Peucker tolerance, in metres, for the render shape stored alongside
 * the 25 m grid.
 *
 * Storing the routing engine's raw polyline verbatim would roughly double
 * every route file (they are already 0.5-1.5 MB and committed to git) mostly
 * to record vertices strung along dead-straight motorway. DP drops exactly
 * those and keeps the ones that carry the corner shape, which is the entire
 * point of the field. 0.5 m is well under a lane width, so nothing visible at
 * any zoom the game uses survives the simplification.
 */
export const SHAPE_SIMPLIFY_TOLERANCE_M = 0.5;

/**
 * Indices of the vertices Douglas-Peucker keeps at `tolerance` (metres, so
 * this wants projected not lon/lat input).
 *
 * Iterative rather than recursive on purpose: a 1000 km bake
 * (MAX_DISTANCE_KM) can arrive as a six-figure vertex count, and the
 * recursive formulation blows the stack on near-degenerate inputs.
 */
export function simplifyIndices(pts: Array<{ x: number; y: number }>, tolerance: number): number[] {
  const n = pts.length;
  if (n <= 2) return pts.map((_, i) => i);

  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;

  const stack: Array<[number, number]> = [[0, n - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const a = pts[first]!;
    const b = pts[last]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLen2 = dx * dx + dy * dy;

    let maxDist = -1;
    let maxIdx = -1;
    for (let i = first + 1; i < last; i++) {
      const p = pts[i]!;
      let d: number;
      if (segLen2 === 0) {
        // Degenerate segment (a duplicated vertex): fall back to point distance.
        d = Math.hypot(p.x - a.x, p.y - a.y);
      } else {
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / segLen2));
        d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
      }
      if (d > maxDist) {
        maxDist = d;
        maxIdx = i;
      }
    }

    if (maxDist > tolerance && maxIdx > 0) {
      keep[maxIdx] = 1;
      stack.push([first, maxIdx], [maxIdx, last]);
    }
  }

  const kept: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) kept.push(i);
  return kept;
}

// --- §5.4: sample elevation at 100 m intervals, interpolate onto 25 m grid ---
async function fetchElevations(
  points: Array<{ lon: number; lat: number }>,
  onProgress?: (done: number, total: number) => void,
): Promise<number[]> {
  const BATCH = 100;
  const elevations: number[] = [];
  const totalBatches = Math.ceil(points.length / BATCH);

  for (let b = 0; b < totalBatches; b++) {
    const batch = points.slice(b * BATCH, (b + 1) * BATCH);
    const locations = batch.map((p) => `${p.lat},${p.lon}`).join('|');
    const url = `${OPENTOPODATA_URL}?locations=${locations}`;

    let attempt = 0;
    let lastError: unknown = null;
    let ok = false;
    while (attempt < 2 && !ok) {
      attempt++;
      try {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`OpenTopoData request failed: ${res.status}`);
        const body = (await res.json()) as OpenTopoDataResponse;
        if (body.status !== 'OK') throw new Error(`OpenTopoData status: ${body.status}`);
        for (const r of body.results) {
          if (r.elevation === null) throw new Error('OpenTopoData returned null elevation');
          elevations.push(r.elevation);
        }
        ok = true;
      } catch (err) {
        lastError = err;
        if (attempt < 2) {
          console.warn(`  batch ${b + 1}/${totalBatches} failed (${String(err)}), retrying once...`);
          await sleep(1100);
        }
      }
    }
    if (!ok) {
      throw new BakeError(`OpenTopoData batch ${b + 1}/${totalBatches} failed twice: ${String(lastError)}`);
    }

    console.log(`  elevation batch ${b + 1}/${totalBatches} (${batch.length} points)`);
    onProgress?.(b + 1, totalBatches);
    if (b < totalBatches - 1) await sleep(1100);
  }

  return elevations;
}

// --- §5.5: smooth elevation, centred moving average, 200 m window (±4 samples) ---
export function smoothElevation(ele: number[], halfWindow: number): number[] {
  const n = ele.length;
  const smoothed = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWindow);
    const hi = Math.min(n - 1, i + halfWindow);
    let sum = 0;
    for (let j = lo; j <= hi; j++) sum += ele[j]!;
    smoothed[i] = sum / (hi - lo + 1);
  }
  return smoothed;
}

// --- §5.6: compute grade, central difference over 100 m baseline (±2 samples) ---
export function computeGrade(ele: number[], spacing: number, half: number): number[] {
  const n = ele.length;
  const grade = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    if (hi === lo) {
      grade[i] = 0;
      continue;
    }
    grade[i] = Math.atan2(ele[hi]! - ele[lo]!, (hi - lo) * spacing);
  }
  return grade;
}

// --- §5.7: compute curvature via Menger curvature, points 50 m apart (±2 samples) ---
export function computeRadius(pts: Array<{ x: number; y: number }>, half: number): number[] {
  const n = pts.length;
  const radius = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const lo = i - half;
    const hi = i + half;
    if (lo < 0 || hi > n - 1) {
      radius[i] = 5000; // not enough context near route endpoints — treat as straight
      continue;
    }
    const A = pts[lo]!;
    const B = pts[i]!;
    const C = pts[hi]!;
    const a = dist2D(B, C);
    const b = dist2D(A, C);
    const c = dist2D(A, B);
    const area = Math.abs((B.x - A.x) * (C.y - A.y) - (C.x - A.x) * (B.y - A.y)) / 2;
    const r = area < 1e-6 ? Infinity : (a * b * c) / (4 * area);
    radius[i] = clamp(r, 15, 5000);
  }
  return radius;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Cornering radius written over the point where a there-and-back course
 * reverses, in metres.
 *
 * This has to be imposed rather than measured, because the measurement is
 * confidently wrong. Menger curvature reads three points 50 m apart, and where
 * a route doubles back along the same road the outer two land on top of each
 * other: the triangle has no area, the formula returns Infinity, and the
 * tightest manoeuvre on the whole course is recorded as a 5 km-radius
 * straight. Cars would take the reversal at the speed limit.
 *
 * 15 m is the floor computeRadius already clamps to — the tightest thing this
 * model represents, and about what a road-width U-turn actually is. It plans
 * out at roughly 45 km/h through the turn, which is generous for a three-point
 * turn and about right for a roundabout or a junction loop, which is what a
 * router usually returns here anyway.
 */
const TURNAROUND_RADIUS_M = 15;

/** How far either side of the reversal that radius applies. A U-turn occupies
 * a couple of car lengths; this is deliberately wider than the 25 m sampling
 * grid so the constraint cannot fall between two samples. */
const TURNAROUND_WINDOW_M = 40;

/** Stamps a U-turn onto the curvature profile. Applied to the *raw* radius,
 * before the forward-looking min filter, so the approach inherits it and cars
 * brake for the turn instead of arriving at it. */
function applyTurnaroundRadius(radius: number[], pts: Array<{ s: number }>, turnaroundS: number): void {
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(pts[i]!.s - turnaroundS) <= TURNAROUND_WINDOW_M) {
      radius[i] = Math.min(radius[i]!, TURNAROUND_RADIUS_M);
    }
  }
}

/**
 * How sharply the path has to double back to count as a reversal, as the
 * cosine of the angle between the incoming and outgoing directions. -0.8 is
 * about 143°: sharper than any junction turn, and comfortably reached by a
 * genuine about-face.
 */
const REVERSAL_COS_THRESHOLD = -0.8;

/** Samples either side used to measure that angle — 2 × 25 m, the same span
 * the Menger curvature uses, so the two agree about what a "turn" is. */
const REVERSAL_WINDOW_SAMPLES = 2;

/**
 * Finds every point where the route doubles back on itself.
 *
 * Menger curvature cannot see these: it reads three points 50 m apart, and on
 * an exact about-face the outer two land on top of each other, giving a
 * zero-area triangle and therefore infinite radius — the tightest manoeuvre on
 * the course recorded as a straight. Round trips hit it at their join, but so
 * does any route with an intermediate stop that requires turning round (a
 * dead-end village, a spur off a main road, a stop on the far carriageway), so
 * this is measured from the geometry rather than assumed at one known index.
 *
 * Exported for testing: the failure mode is silent and the fix is invisible in
 * the output, so it is worth pinning directly.
 */
export function detectReversals(pts: Array<{ x: number; y: number }>, window = REVERSAL_WINDOW_SAMPLES): number[] {
  const found: number[] = [];
  for (let i = window; i < pts.length - window; i++) {
    const before = pts[i - window]!;
    const here = pts[i]!;
    const after = pts[i + window]!;
    const inX = here.x - before.x;
    const inY = here.y - before.y;
    const outX = after.x - here.x;
    const outY = after.y - here.y;
    const inLen = Math.hypot(inX, inY);
    const outLen = Math.hypot(outX, outY);
    if (inLen < 1e-6 || outLen < 1e-6) continue;
    const cos = (inX * outX + inY * outY) / (inLen * outLen);
    if (cos <= REVERSAL_COS_THRESHOLD) found.push(i);
  }
  return found;
}

// --- R8/R10: road surface + speed limit tags from Overpass ---

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
const OVERPASS_TIMEOUT_S = 60;
// Only classes OSRM would actually route a car on — fetching every
// highway=* (footways, cycleways, paths...) in a route's bounding box would
// multiply the response size for no benefit here.
const DRIVEABLE_HIGHWAY_CLASSES =
  'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|' +
  'motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
const ROAD_MATCH_MAX_M = 20; // §R8: "nearest tagged way within ~20 m"

/** §R8's mapping table: OSM surface=* value -> grip factor. Untagged (or a
 * value not in this table) is handled by the caller as "no data", not as
 * 0 — this table only covers values worth actively derating. */
export const SURFACE_GRIP: Record<string, number> = {
  asphalt: 1.0,
  paved: 1.0,
  concrete: 1.0,
  'concrete:plates': 1.0,
  paving_stones: 0.9,
  compacted: 0.9,
  cobblestone: 0.8,
  sett: 0.8,
  gravel: 0.7,
  fine_gravel: 0.7,
  dirt: 0.6,
  ground: 0.6,
  unpaved: 0.6,
};

/** OSM maxspeed=* -> m/s. Handles the plain-km/h numeric form ("60"), an
 * explicit unit suffix ("60 km/h", "35 mph"), and returns undefined for
 * anything else (`none`, `signals`, `walk`, implicit-limit codes like
 * `BR:urban`, missing) — R10's own guidance is to never fabricate a limit,
 * so an unparseable tag is exactly equivalent to no tag at all. */
export function parseMaxspeedToMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  const mph = /^(\d+(?:\.\d+)?)\s*mph$/i.exec(trimmed);
  if (mph) return parseFloat(mph[1]!) * 0.44704;
  const kmh = /^(\d+(?:\.\d+)?)(\s*km\/h)?$/i.exec(trimmed);
  if (kmh) return parseFloat(kmh[1]!) / 3.6;
  return undefined;
}

interface OverpassWay {
  type: 'way';
  tags?: Record<string, string>;
  geometry?: Array<{ lat: number; lon: number }>;
}

interface OverpassResponse {
  elements: OverpassWay[];
}

interface RoadSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  surfaceGrip?: number;
  limitMs?: number;
}

interface RoadIndex {
  segments: RoadSegment[];
  grid: Map<string, number[]>;
  cellSize: number;
}

function pointToSegmentDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-9) return Math.hypot(px - ax, py - ay);
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / lenSq, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Builds a uniform-grid spatial index over Overpass way geometries,
 * projected into the same local ENU frame as the route (`proj`) so distance
 * checks are plain metres — cars-per-route-style linear scans don't apply
 * here (a real road network can have tens of thousands of segments), but a
 * grid keyed by (cellSize m) cells keeps each lookup to its own 3x3
 * neighbourhood instead of the whole way set. */
export function buildRoadIndex(
  ways: OverpassWay[],
  project: (lon: number, lat: number) => { x: number; y: number },
  cellSize = 50,
): RoadIndex {
  const segments: RoadSegment[] = [];
  const grid = new Map<string, number[]>();

  for (const way of ways) {
    if (!way.geometry || way.geometry.length < 2) continue;
    const tags = way.tags ?? {};
    const surfaceGrip = tags.surface !== undefined ? SURFACE_GRIP[tags.surface] : undefined;
    const limitMs = parseMaxspeedToMs(tags.maxspeed);
    if (surfaceGrip === undefined && limitMs === undefined) continue; // nothing this baker uses

    const pts = way.geometry.map((g) => project(g.lon, g.lat));
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i]!;
      const b = pts[i + 1]!;
      const idx = segments.length;
      segments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, surfaceGrip, limitMs });

      const minCx = Math.floor(Math.min(a.x, b.x) / cellSize);
      const maxCx = Math.floor(Math.max(a.x, b.x) / cellSize);
      const minCy = Math.floor(Math.min(a.y, b.y) / cellSize);
      const maxCy = Math.floor(Math.max(a.y, b.y) / cellSize);
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          const key = `${cx},${cy}`;
          let bucket = grid.get(key);
          if (!bucket) {
            bucket = [];
            grid.set(key, bucket);
          }
          bucket.push(idx);
        }
      }
    }
  }

  return { segments, grid, cellSize };
}

/** Nearest road segment to (x, y) within `maxDist` metres — checks the
 * point's own grid cell plus its 8 neighbours, which covers every segment
 * within `maxDist` as long as `maxDist < cellSize` (true here: 20 m vs the
 * default 50 m cell). */
export function nearestRoad(index: RoadIndex, x: number, y: number, maxDist: number): RoadSegment | undefined {
  const cx = Math.floor(x / index.cellSize);
  const cy = Math.floor(y / index.cellSize);
  let best: RoadSegment | undefined;
  let bestDist = maxDist;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const bucket = index.grid.get(`${cx + dx},${cy + dy}`);
      if (!bucket) continue;
      for (const idx of bucket) {
        const seg = index.segments[idx]!;
        const d = pointToSegmentDist(x, y, seg.ax, seg.ay, seg.bx, seg.by);
        if (d < bestDist) {
          bestDist = d;
          best = seg;
        }
      }
    }
  }
  return best;
}

/** Fetches surface/maxspeed tags for driveable ways in the route's bounding
 * box (padded), in one query (R8+R10 share it). Overpass is flaky and the
 * bbox for a long, diagonal route can be large — on any failure this warns
 * and returns null so the caller bakes with all-default (1.0 grip, no
 * limit) rather than failing the whole bake. */
async function fetchRoadTags(lonLat: Array<{ lon: number; lat: number }>): Promise<OverpassWay[] | null> {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const p of lonLat) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  const pad = 0.01; // ~1 km
  const bbox = `${minLat - pad},${minLon - pad},${maxLat + pad},${maxLon + pad}`;
  const query =
    `[out:json][timeout:${OVERPASS_TIMEOUT_S}];` +
    `way[highway~"^(${DRIVEABLE_HIGHWAY_CLASSES})$"](${bbox});` +
    `out geom tags;`;

  try {
    // overpass-api.de's Apache frontend 406s a request with no User-Agent
    // (or Node's default one) — confirmed by reproduction: identical query,
    // curl succeeds, node fetch() 406s until given an explicit UA.
    const res = await fetch(OVERPASS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': BAKER_USER_AGENT },
      body: `data=${encodeURIComponent(query)}`,
    });
    if (!res.ok) throw new Error(`Overpass request failed: ${res.status} ${res.statusText}`);
    const body = (await res.json()) as OverpassResponse;
    return body.elements;
  } catch (err) {
    console.warn(`  WARNING: Overpass query failed (${String(err)}) — baking with default surface/speed-limit values.`);
    return null;
  }
}

/** Orchestrates the R8/R10 Overpass pass: fetch tagged ways, spatially join
 * each resampled route point to the nearest one within ROAD_MATCH_MAX_M.
 * Returns raw (unsmoothed) per-point surface grip (1.0 where no match —
 * smoothed by the caller like elevation) and limit in m/s (undefined where
 * no match — R10 never smooths a legal limit, it's a discrete zone, not a
 * gradient). */
async function computeSurfaceAndLimit(
  resampled: Array<{ x: number; y: number }>,
  lonLat: Array<{ lon: number; lat: number }>,
  project: (lon: number, lat: number) => { x: number; y: number },
): Promise<{ rawSurfaceGrip: number[]; limitMs: Array<number | undefined>; warning: string | null }> {
  const ways = await fetchRoadTags(lonLat);
  const n = resampled.length;
  if (ways === null) {
    return {
      rawSurfaceGrip: new Array(n).fill(1),
      limitMs: new Array(n).fill(undefined),
      warning: 'Overpass query failed — surface/speed-limit data unavailable for this bake.',
    };
  }

  const index = buildRoadIndex(ways, project);
  const rawSurfaceGrip = new Array<number>(n);
  const limitMs = new Array<number | undefined>(n);
  let matched = 0;
  for (let i = 0; i < n; i++) {
    const road = nearestRoad(index, resampled[i]!.x, resampled[i]!.y, ROAD_MATCH_MAX_M);
    rawSurfaceGrip[i] = road?.surfaceGrip ?? 1;
    limitMs[i] = road?.limitMs;
    if (road) matched++;
  }

  const matchPct = ((matched / n) * 100).toFixed(0);
  console.log(`  Overpass: ${ways.length} way(s) fetched, ${matchPct}% of points matched within ${ROAD_MATCH_MAX_M} m`);
  const warning =
    matched === 0
      ? 'No OSM surface/maxspeed tags matched this route — coverage may be patchy here.'
      : null;
  return { rawSurfaceGrip, limitMs, warning };
}

// Forward-looking-only min-filter over a 75 m window (3 samples at 25 m
// spacing): index i takes the min of raw radius from i to i+lookahead, never
// i-lookahead to i. This is what actually implements "a corner's tightest
// point should influence the approach" (§5.7) — a driver needs advance
// warning of an UPCOMING tight corner, which requires points BEFORE it to
// reflect its tightness. A symmetric window also let a corner's tightness
// linger for 75 m of road *after* the apex, even once the real geometry had
// already opened back up — nearly doubling how long the speed profile (and
// the crash-risk check, which reads this same baked radius) treats a car as
// still being in a dangerous corner. Confirmed empirically: a genuinely
// tight point produced a 150 m plateau of identical filtered radius instead
// of the correct radius shape, roughly doubling sustained crash exposure at
// that spot versus what the real road geometry justified.
export function minFilter(values: number[], lookahead: number): number[] {
  const n = values.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const hi = Math.min(n - 1, i + lookahead);
    let m = Infinity;
    for (let j = i; j <= hi; j++) if (values[j]! < m) m = values[j]!;
    out[i] = m;
  }
  return out;
}

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

export function logRadiusHistogram(radii: number[]): void {
  const buckets: Array<[string, number, number]> = [
    ['15-30 m', 15, 30],
    ['30-60 m', 30, 60],
    ['60-100 m', 60, 100],
    ['100-200 m', 100, 200],
    ['200-500 m', 200, 500],
    ['500-1000 m', 500, 1000],
    ['1000-2000 m', 1000, 2000],
    ['2000-4999 m', 2000, 4999],
    ['5000 m (clamp)', 4999, 5000.0001],
  ];
  const counts = buckets.map(() => 0);
  for (const r of radii) {
    for (let i = 0; i < buckets.length; i++) {
      const [, lo, hi] = buckets[i]!;
      if (r >= lo && r < hi) {
        counts[i]!++;
        break;
      }
    }
  }
  const max = Math.max(...counts);
  console.log('\nCurvature radius distribution:');
  for (let i = 0; i < buckets.length; i++) {
    const [label] = buckets[i]!;
    const count = counts[i]!;
    const barLen = max > 0 ? Math.round((count / max) * 50) : 0;
    const pct = ((count / radii.length) * 100).toFixed(1);
    console.log(`  ${label.padEnd(16)} ${'#'.repeat(barLen).padEnd(50)} ${count.toString().padStart(6)} (${pct}%)`);
  }
  console.log('');
}

function computeElevationGain(ele: number[]): number {
  let gain = 0;
  for (let i = 1; i < ele.length; i++) {
    const delta = ele[i]! - ele[i - 1]!;
    if (delta > 0) gain += delta;
  }
  return gain;
}

// `outDir` is caller-supplied rather than hardcoded to `public/data/routes`
// (B4 follow-up): the CLI (tools/bake-route.ts) writes there so committed
// routes ship in the production build, but the dev-server's on-demand bake
// API writes to a non-public directory instead — see dev-routes-api.ts for
// why (Vite's dev server never learns about files written into publicDir
// after it boots, so anything baked mid-session there is unservable).
export async function upsertRouteIndex(outDir: string, entry: RouteIndexEntry): Promise<RouteIndexEntry[]> {
  const indexPath = path.join(outDir, 'index.json');
  let index: RouteIndexEntry[] = [];
  try {
    index = JSON.parse(await readFile(indexPath, 'utf-8'));
  } catch {
    // no index yet — starting fresh
  }
  const existingIdx = index.findIndex((e) => e.slug === entry.slug);
  if (existingIdx >= 0) index[existingIdx] = entry;
  else index.push(entry);
  await mkdir(outDir, { recursive: true });
  await writeFile(indexPath, JSON.stringify(index, null, 2));
  console.log(`Updated ${indexPath} (${index.length} route(s))`);
  return index;
}

export async function saveRoute(outDir: string, slug: string, route: Route): Promise<void> {
  await mkdir(outDir, { recursive: true });
  const outPath = path.join(outDir, `${slug}.json`);
  await writeFile(outPath, JSON.stringify(route));
  console.log(`Wrote ${outPath} (${route.points.length} points, ${(route.totalDistance / 1000).toFixed(1)} km)`);
}

export interface BakeVariantResult {
  route: Route;
  distanceKm: number;
  elevationGainM: number;
  warnings: string[];
}

export interface BakeResult {
  variants: BakeVariantResult[];
  /** Every stop between start and finish, resolved, in order. */
  via: ResolvedEndpoint[];
  /** How each endpoint was actually resolved — the caller needs the labels to
   * name the course, and with a coordinate endpoint there is no input text
   * worth showing. */
  from: ResolvedEndpoint;
  to: ResolvedEndpoint;
}

export interface ResolvedEndpoint {
  coord: [number, number];
  /** Human-readable, for the route index: the place name as typed, the
   * settlement a coordinate reverse-geocodes to, or the coordinates
   * themselves if the lookup came back empty. */
  label: string;
  /** True when the caller gave coordinates rather than a place to look up. */
  exact: boolean;
}

export interface BakeOptions {
  /** A place name to geocode, or "lat, lon" coordinates — see
   * src/coords.ts. Coordinates skip geocoding entirely, which is the only way
   * to start a race at a specific point on a specific road rather than at
   * whatever a town name resolves to. */
  from: string;
  to: string;
  /** Coordinates already known (e.g. the autocomplete suggestion the user
   * clicked) — skips re-geocoding that endpoint's free text (B6): faster,
   * and guaranteed to bake the place actually picked rather than whatever
   * `limit=1` re-geocoding of the display text happens to resolve to. */
  fromCoord?: [number, number];
  toCoord?: [number, number];
  /**
   * Ordered intermediate stops between `from` and `to`, each a place name or
   * "lat, lon" like the endpoints.
   *
   * This is the lever that actually decides *which roads* a race uses. Exact
   * endpoints pin where it starts and ends, but everything between them is the
   * router's choice of fastest path; a stop partway forces it through a
   * specific pass, bypass or coast road. The router visits them in the order
   * given — they are waypoints, not a set.
   */
  via?: string[];
  /** Coordinates already known for the corresponding `via` entry (an
   * autocomplete pick), same precedence rule as fromCoord/toCoord. */
  viaCoords?: Array<[number, number] | undefined>;
  /**
   * Bake there *and back*: start → finish → start, as one continuous route.
   *
   * The return leg is routed separately rather than mirrored, because it
   * genuinely can differ — one-way systems, turn restrictions and time-of-day
   * costs all mean B→A is not always A→B reversed, and mirroring would quietly
   * invent a road that cannot be driven in that direction.
   */
  roundTrip?: boolean;
  /** F1: also request routing alternatives (Valhalla `alternates`, or OSRM
   * `alternatives=true` on fallback) and bake every usable one, sharing a
   * courseId — Waze-style routes cars can be individually assigned to.
   * Multiplies bake time by however many variants come back (each repeats
   * the full elevation fetch), so this stays opt-in. */
  alternatives?: boolean;
  onElevationProgress?: (variantIndex: number, done: number, total: number) => void;
}

/** Core bake pipeline (§5.1-§5.8) for one already-fetched geometry, shared
 * across every variant of a course (F1) as well as the single-route case. */
async function bakeGeometry(
  coords: [number, number][],
  distanceM: number,
  onElevationProgress?: (done: number, total: number) => void,
  /** Index into `coords` where a round trip reverses, if it is one. */
  turnaroundIndex?: number,
): Promise<BakeVariantResult> {
  const warnings: string[] = [];

  const [lon0, lat0] = coords[0]!;
  const proj = makeProjection(lon0, lat0);
  const projected = coords.map(([lon, lat]) => proj.project(lon, lat));

  console.log(`Resampling to ${SPACING} m spacing...`);
  const resampled = resample(projected, SPACING);
  const n = resampled.length;
  const totalDistance = resampled[n - 1]!.s;
  console.log(
    `Resampled polyline length: ${(totalDistance / 1000).toFixed(1)} km ` +
      `(OSRM reported ${(distanceM / 1000).toFixed(1)} km), ${n} points`,
  );

  const lonLat = resampled.map((p) => proj.unproject(p.x, p.y));

  console.log(`Sampling elevation at 100 m intervals (rate-limited to 1 req/s)...`);
  const sparseStep = 100 / SPACING; // 4
  const sparseIndices: number[] = [];
  for (let i = 0; i < n; i += sparseStep) sparseIndices.push(i);
  if (sparseIndices[sparseIndices.length - 1] !== n - 1) sparseIndices.push(n - 1);
  const sparsePoints = sparseIndices.map((i) => lonLat[i]!);

  const sparseEle = await fetchElevations(sparsePoints, onElevationProgress);

  // handle the final odd-length tail separately rather than assuming perfect
  // regularity in the sparse index spacing
  const eleAtSparse = new Map<number, number>();
  sparseIndices.forEach((idx, k) => eleAtSparse.set(idx, sparseEle[k]!));
  const rawEle = new Array<number>(n);
  {
    let lastIdx = 0;
    for (const idx of sparseIndices) {
      if (idx > lastIdx) {
        const e0 = eleAtSparse.get(lastIdx)!;
        const e1 = eleAtSparse.get(idx)!;
        for (let i = lastIdx; i <= idx; i++) {
          const t = (i - lastIdx) / (idx - lastIdx);
          rawEle[i] = e0 + t * (e1 - e0);
        }
      }
      lastIdx = idx;
    }
    rawEle[n - 1] = eleAtSparse.get(sparseIndices[sparseIndices.length - 1]!)!;
  }

  console.log('Smoothing elevation (200 m centred moving average)...');
  const smoothedEle = smoothElevation(rawEle, 4);

  console.log('Computing grade (100 m central difference)...');
  const grade = computeGrade(smoothedEle, SPACING, 2);
  let maxAbsGrade = 0;
  let maxAbsGradeIdx = -1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(grade[i]!) > maxAbsGrade) {
      maxAbsGrade = Math.abs(grade[i]!);
      maxAbsGradeIdx = i;
    }
  }
  console.log(`  max |grade| = ${maxAbsGrade.toFixed(4)} rad at s=${resampled[maxAbsGradeIdx]!.s} m`);

  // §5.6 sanity ceiling — logged, not fatal (see step 1's grade-exception
  // finding: real switchbacks can genuinely exceed this, confirmed against
  // two independent DEMs). Surfaced to the caller as a warning instead.
  const GRADE_WARN_THRESHOLD = 0.2;
  if (maxAbsGrade >= GRADE_WARN_THRESHOLD) {
    const violations: number[] = [];
    for (let i = 0; i < n; i++) if (Math.abs(grade[i]!) >= GRADE_WARN_THRESHOLD) violations.push(i);
    const runs: Array<{ start: number; end: number }> = [];
    for (const i of violations) {
      const last = runs[runs.length - 1];
      if (last && i <= last.end + 1) last.end = i;
      else runs.push({ start: i, end: i });
    }
    const msg = `${violations.length} sample(s) exceed |grade| >= ${GRADE_WARN_THRESHOLD} rad in ${runs.length} spot(s) — likely a genuine steep section, not a data error.`;
    console.warn(`  WARNING: ${msg}`);
    warnings.push(msg);
  }

  console.log('Computing curvature (Menger curvature, 50 m spacing, 75 m forward-looking min-filter)...');
  const rawRadius = computeRadius(resampled, 2);

  // Any about-face, wherever it came from — a round trip's join, or a stop
  // that can only be reached by turning round.
  const reversals = detectReversals(resampled);
  if (reversals.length > 0) {
    const at = reversals.map((i) => (resampled[i]!.s / 1000).toFixed(1)).join(', ');
    console.log(`  ${reversals.length} reversal(s) detected at ${at} km — forcing a ${TURNAROUND_RADIUS_M} m radius`);
    for (const i of reversals) applyTurnaroundRadius(rawRadius, resampled, resampled[i]!.s);
  }

  let turnaroundS: number | undefined;
  if (turnaroundIndex !== undefined) {
    // Distance to the reversal measured along the projected polyline, not
    // taken from the router's leg distance: the two disagree by a few metres
    // and the window has to sit on the actual geometry.
    turnaroundS = 0;
    for (let i = 1; i <= turnaroundIndex && i < projected.length; i++) {
      turnaroundS += Math.hypot(projected[i]!.x - projected[i - 1]!.x, projected[i]!.y - projected[i - 1]!.y);
    }
    console.log(`  round trip: forcing a ${TURNAROUND_RADIUS_M} m turnaround at ${(turnaroundS / 1000).toFixed(1)} km`);
    applyTurnaroundRadius(rawRadius, resampled, turnaroundS);
  }
  const radius = minFilter(rawRadius, 3);

  logRadiusHistogram(radius);

  console.log('Fetching road surface + speed limit tags from Overpass...');
  const { rawSurfaceGrip, limitMs, warning: surfaceWarning } = await computeSurfaceAndLimit(
    resampled,
    lonLat,
    proj.project,
  );
  if (surfaceWarning) warnings.push(surfaceWarning);
  // R8: smoothed the same way elevation is (200 m centred moving average) so
  // grip doesn't step discontinuously right at a tag boundary. R10's limit
  // is deliberately NOT smoothed here — a legal speed zone is a discrete
  // step, not a gradient.
  const smoothedSurfaceGrip = smoothElevation(rawSurfaceGrip, 4);

  console.log('Validating output...');
  for (let i = 0; i < n; i++) {
    if (i > 0 && resampled[i]!.s <= resampled[i - 1]!.s) {
      throw new BakeError(`s is not monotonically increasing at index ${i}`);
    }
    // x/y are checked here even though they're not part of the output
    // RoutePoint (P5) — they're the geometry the rest of this pipeline
    // (curvature, elevation projection) is built on, so a non-finite value
    // here means the bake itself is broken, not just an unused field.
    const fields = [
      lonLat[i]!.lon,
      lonLat[i]!.lat,
      resampled[i]!.x,
      resampled[i]!.y,
      smoothedEle[i]!,
      grade[i]!,
      radius[i]!,
    ];
    if (fields.some((f) => !Number.isFinite(f))) {
      throw new BakeError(`Non-finite field at index ${i}: ${JSON.stringify(fields)}`);
    }
  }

  // R8: only write `surface` where it actually differs from the neutral
  // 1.0 default (post-smoothing) — keeps untagged/undertagged stretches
  // (most rural Brazilian roads, per R10's own honest-coverage warning)
  // from bloating every route file with a field that means nothing there.
  const SURFACE_NEUTRAL_EPSILON = 0.001;

  const points: RoutePoint[] = resampled.map((p, i) => ({
    s: round(p.s, 2),
    lon: round(lonLat[i]!.lon, 6),
    lat: round(lonLat[i]!.lat, 6),
    ele: round(smoothedEle[i]!, 2),
    grade: round(grade[i]!, 4),
    radius: round(radius[i]!, 2),
    ...(Math.abs(smoothedSurfaceGrip[i]! - 1) > SURFACE_NEUTRAL_EPSILON
      ? { surface: round(smoothedSurfaceGrip[i]!, 3) }
      : {}),
    ...(limitMs[i] !== undefined ? { limit: round(limitMs[i]!, 2) } : {}),
  }));

  // Render-only: the source geometry before §5.3 resampling flattens every
  // sub-25 m turn into a chord. Simplified only enough to drop redundant
  // straight-line vertices — see SHAPE_SIMPLIFY_TOLERANCE_M.
  const shapeIndices = simplifyIndices(projected, SHAPE_SIMPLIFY_TOLERANCE_M);
  const shape = shapeIndices.map(
    (i) => [round(coords[i]![0], 6), round(coords[i]![1], 6)] as [number, number],
  );
  console.log(
    `Render shape: ${shape.length} vertices ` +
      `(from ${coords.length} source, simplified at ${SHAPE_SIMPLIFY_TOLERANCE_M} m; ${n} grid points)`,
  );

  const route: Route = {
    origin: { lon: lon0, lat: lat0 },
    totalDistance: round(totalDistance, 2),
    spacing: SPACING,
    points,
    shape,
    ...(turnaroundS !== undefined ? { turnaroundS: round(turnaroundS, 2) } : {}),
  };

  return {
    route,
    distanceKm: round(totalDistance / 1000, 1),
    elevationGainM: round(computeElevationGain(smoothedEle), 0),
    warnings,
  };
}

interface RoundTripGeometry extends GeometryCandidate {
  /** Index into `coords` of the reversal — see applyTurnaroundRadius. */
  turnaroundIndex: number;
}

// Same-road verdict: OSM maps a two-way road as one shared centreline, so a
// return leg down the outbound road sits at near-zero offset from it, while
// even a parallel dual carriageway is tens of metres out.
const SAME_ROAD_TOLERANCE_M = 30;
const SAME_ROAD_SAMPLES = 25;

/**
 * Log-only verdict for buildRoundTrips: does the return leg run back down the
 * outbound road? Judged geometrically — vertex counts say nothing (two
 * different roads can tie, and the same road re-densified can differ). A
 * spread of return-leg points is measured against the outbound polyline, and
 * the median offset decides, so a shared first and last kilometre out of town
 * doesn't tip the verdict either way.
 */
function sameRoadBack(out: [number, number][], back: [number, number][]): boolean {
  const { project } = makeProjection(out[0]![0], out[0]![1]);
  const outXY = out.map(([lon, lat]) => project(lon, lat));
  const offsets: number[] = [];
  for (let i = 0; i < SAME_ROAD_SAMPLES; i++) {
    const idx = Math.round((i * (back.length - 1)) / Math.max(1, SAME_ROAD_SAMPLES - 1));
    const [lon, lat] = back[idx]!;
    const p = project(lon, lat);
    let best = Infinity;
    for (let j = 0; j < outXY.length - 1; j++) {
      const a = outXY[j]!;
      const b = outXY[j + 1]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const len2 = dx * dx + dy * dy;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
      best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)));
    }
    offsets.push(best);
  }
  offsets.sort((a, b) => a - b);
  return offsets[Math.floor(offsets.length / 2)]! <= SAME_ROAD_TOLERANCE_M;
}

/**
 * Joins each outbound variant to a return leg routed in the other direction.
 *
 * Variants are paired by index (outbound alternative 1 with return alternative
 * 1, and so on) so a course's variants stay genuinely distinct *loops* rather
 * than every one of them sharing a return road. Where the router offers fewer
 * ways back than out, the extras reuse the primary return.
 */
async function buildRoundTrips(
  outbound: GeometryCandidate[],
  fromCoord: [number, number],
  toCoord: [number, number],
  alternatives: boolean,
): Promise<RoundTripGeometry[]> {
  // The way home is routed finish → start with no intermediate stops: the
  // stops describe how to get *there*, and forcing the same ones in reverse
  // would guarantee the return mirrors the outward leg, which is the one thing
  // a separately-routed return exists to avoid. To pin the way back too, list
  // the whole loop explicitly instead (…--via <finish> --via <return stop>
  // --to <start>).
  console.log('Round trip: routing the return leg separately...');
  const inbound = await fetchRouteGeometries([toCoord, fromCoord], alternatives);

  return outbound.map((out, i) => {
    const back = inbound[i] ?? inbound[0]!;
    // The join is one point in two geometries — drop the duplicate, or the
    // resampler sees a zero-length segment at exactly the place the course is
    // most sensitive.
    const coords = [...out.coords, ...back.coords.slice(1)];
    const distanceM = out.distanceM + back.distanceM;
    if (distanceM / 1000 > MAX_DISTANCE_KM) {
      throw new BakeError(
        `That round trip is ${(distanceM / 1000).toFixed(0)} km — over the ${MAX_DISTANCE_KM} km cap. ` +
          `Halve it, or bake the one-way route instead.`,
      );
    }
    console.log(
      `  variant ${i + 1}: ${(out.distanceM / 1000).toFixed(1)} km out + ${(back.distanceM / 1000).toFixed(1)} km back` +
        `${sameRoadBack(out.coords, back.coords) ? ' (same road)' : ' (different road back)'}`,
    );
    return { coords, distanceM, turnaroundIndex: out.coords.length - 1 };
  });
}

/**
 * "A → B", "A → V → B", or "A → V → B → A" for a round trip.
 *
 * The stops are part of the name because they are the whole point of listing
 * them: a course through Monte Verde is a different race from the one that
 * takes the motorway, and the two would otherwise be indistinguishable in the
 * picker. Long chains are elided in the middle rather than truncated, so both
 * ends — the bit that identifies the course — always survive.
 */
export function describeCourse(from: string, via: string[], to: string, roundTrip: boolean): string {
  const MAX_STOPS_SHOWN = 3;
  // Shown: the first MAX_STOPS_SHOWN - 1 stops plus the last one. The "more"
  // count is what's actually hidden between them — the always-shown last stop
  // is not part of it.
  const stops =
    via.length > MAX_STOPS_SHOWN
      ? [...via.slice(0, MAX_STOPS_SHOWN - 1), `…${via.length - MAX_STOPS_SHOWN} more…`, via[via.length - 1]!]
      : via;
  const legs = [from, ...stops, to];
  if (roundTrip) legs.push(from);
  return legs.join(' → ');
}

/**
 * Turns one endpoint into a coordinate plus a label.
 *
 * Three ways in, in order of precedence: a coordinate the caller already knows
 * (the autocomplete suggestion that was clicked), coordinates typed into the
 * text itself, or a place name to geocode.
 */
export async function resolveEndpoint(text: string, known?: [number, number]): Promise<ResolvedEndpoint> {
  if (known) return { coord: known, label: text, exact: true };

  const parsed = parseEndpointText(text);
  if (parsed.kind === 'invalid') throw new BakeError(parsed.reason);
  if (parsed.kind === 'place') return { coord: await geocode(text), label: text, exact: false };

  const { lat, lon } = parsed.value;
  const name = await reverseGeocode(lon, lat);
  console.log(`  using exact coordinates ${formatLatLon(parsed.value)}${name ? ` (near ${name})` : ''}`);
  return { coord: [lon, lat], label: name ?? formatLatLon(parsed.value), exact: true };
}

/** Resolves endpoints, fetches one or more route geometries (F1's
 * `alternatives`), and bakes each into its own variant — shared by the CLI and
 * the dev-server API. */
export async function bakeRoute({
  from,
  to,
  fromCoord,
  toCoord,
  via,
  viaCoords,
  alternatives,
  roundTrip,
  onElevationProgress,
}: BakeOptions): Promise<BakeResult> {
  // Enforced here, not only in the panel UI: a bake holds the dev server's
  // bake mutex for its whole rate-limited run, so an over-long stop chain from
  // any caller (API, CLI) must be rejected before it starts fetching.
  if ((via ?? []).length > MAX_VIA_STOPS) {
    throw new BakeError(
      `${via!.length} intermediate stops — the cap is ${MAX_VIA_STOPS}. ` +
        `Elevation sampling is rate-limited, so longer chains take too long to bake.`,
    );
  }
  const needsLookup = [
    { text: from, coord: fromCoord },
    { text: to, coord: toCoord },
    ...(via ?? []).map((text, i) => ({ text, coord: viaCoords?.[i] })),
  ].some(({ text, coord }) => !coord && parseEndpointText(text).kind === 'place');
  if (needsLookup) console.log(`Geocoding endpoints (rate-limited to 1 req/s)...`);
  const resolvedFrom = await resolveEndpoint(from, fromCoord);
  // Sequentially, not in parallel: geocoding is rate-limited to 1 req/s and
  // nominatimFetch serialises anyway, so Promise.all would only queue.
  const resolvedVia: ResolvedEndpoint[] = [];
  for (const [i, text] of (via ?? []).entries()) {
    resolvedVia.push(await resolveEndpoint(text, viaCoords?.[i]));
  }
  const resolvedTo = await resolveEndpoint(to, toCoord);

  const outward: [number, number][] = [resolvedFrom.coord, ...resolvedVia.map((v) => v.coord), resolvedTo.coord];
  if (resolvedVia.length > 0) {
    console.log(`Routing through ${resolvedVia.length} stop(s): ${resolvedVia.map((v) => v.label).join(' → ')}`);
  }

  const outbound = await fetchRouteGeometries(outward, alternatives ?? false);
  const geometries = roundTrip
    ? await buildRoundTrips(outbound, resolvedFrom.coord, resolvedTo.coord, alternatives ?? false)
    : outbound.map((g) => ({ ...g, turnaroundIndex: undefined as number | undefined }));

  const variants: BakeVariantResult[] = [];
  for (let i = 0; i < geometries.length; i++) {
    const { coords, distanceM, turnaroundIndex } = geometries[i]!;
    if (geometries.length > 1) console.log(`\n--- Baking variant ${i + 1}/${geometries.length} ---`);
    variants.push(
      await bakeGeometry(coords, distanceM, (done, total) => onElevationProgress?.(i, done, total), turnaroundIndex),
    );
  }
  return { variants, from: resolvedFrom, to: resolvedTo, via: resolvedVia };
}
