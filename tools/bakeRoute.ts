// Shared route-baking logic (§5), used by both the `npm run bake` CLI
// (tools/bake-route.ts) and the live dev-server bake API
// (tools/dev-routes-api.ts) for on-demand custom routes. Node-only — relies
// on server-side fetch to reach Valhalla/OSRM/Nominatim/OpenTopoData, which
// the browser can't do directly (Nominatim needs a User-Agent JS can't set,
// and OpenTopoData sends no CORS headers at all).

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Route, RoutePoint, RouteIndexEntry } from '../src/types.ts';

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

interface GeometryCandidate {
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
  from: [number, number],
  to: [number, number],
  alternatives: boolean,
): Promise<GeometryCandidate[]> {
  const request = {
    locations: [
      { lon: from[0], lat: from[1] },
      { lon: to[0], lat: to[1] },
    ],
    costing: 'auto',
    alternates: alternatives ? MAX_ALTERNATIVES - 1 : 0,
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

  // Two locations → one leg per trip; flatMap tolerates a multi-leg response
  // anyway. summary.length is km (units requested explicitly above).
  const trips = [body.trip, ...(body.alternates ?? []).map((a) => a.trip)].slice(0, MAX_ALTERNATIVES);
  return trips.map((trip) => ({
    coords: trip.legs.flatMap((leg) => decodePolyline6(leg.shape)),
    distanceM: trip.summary.length * 1000,
  }));
}

async function fetchOsrmGeometries(
  from: [number, number],
  to: [number, number],
  alternatives: boolean,
): Promise<GeometryCandidate[]> {
  const osrmUrl =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${from[0]},${from[1]};${to[0]},${to[1]}` +
    `?overview=full&geometries=geojson${alternatives ? '&alternatives=true' : ''}`;
  console.log(`Fetching route${alternatives ? 's' : ''} from OSRM: ${osrmUrl}`);
  const res = await fetch(osrmUrl);
  if (!res.ok) {
    throw new BakeError(`OSRM request failed: ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as OsrmResponse;
  if (body.code !== 'Ok' || body.routes.length === 0) {
    throw new BakeError(
      body.code === 'NoRoute'
        ? "No drivable route found between those two places — they may not be connected by road."
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
async function fetchRouteGeometries(
  from: [number, number],
  to: [number, number],
  alternatives: boolean,
): Promise<GeometryCandidate[]> {
  let candidates: GeometryCandidate[];
  let source = 'Valhalla';
  try {
    candidates = await fetchValhallaGeometries(from, to, alternatives);
  } catch (err) {
    console.warn(`  WARNING: Valhalla failed (${String(err)}) — falling back to OSRM.`);
    source = 'OSRM';
    candidates = await fetchOsrmGeometries(from, to, alternatives);
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

function makeProjection(lon0: number, lat0: number) {
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
}

export interface BakeOptions {
  from: string;
  to: string;
  /** Coordinates already known (e.g. the autocomplete suggestion the user
   * clicked) — skips re-geocoding that endpoint's free text (B6): faster,
   * and guaranteed to bake the place actually picked rather than whatever
   * `limit=1` re-geocoding of the display text happens to resolve to. */
  fromCoord?: [number, number];
  toCoord?: [number, number];
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

  const route: Route = {
    origin: { lon: lon0, lat: lat0 },
    totalDistance: round(totalDistance, 2),
    spacing: SPACING,
    points,
  };

  return {
    route,
    distanceKm: round(totalDistance / 1000, 1),
    elevationGainM: round(computeElevationGain(smoothedEle), 0),
    warnings,
  };
}

/** Geocodes, fetches one or more OSRM geometries (F1's `alternatives`), and
 * bakes each into its own variant — shared by the CLI and the dev-server API. */
export async function bakeRoute({ from, to, fromCoord, toCoord, alternatives, onElevationProgress }: BakeOptions): Promise<BakeResult> {
  if (!fromCoord || !toCoord) console.log(`Geocoding endpoints (rate-limited to 1 req/s)...`);
  const resolvedFromCoord = fromCoord ?? (await geocode(from));
  const resolvedToCoord = toCoord ?? (await geocode(to));

  const geometries = await fetchRouteGeometries(resolvedFromCoord, resolvedToCoord, alternatives ?? false);

  const variants: BakeVariantResult[] = [];
  for (let i = 0; i < geometries.length; i++) {
    const { coords, distanceM } = geometries[i]!;
    if (geometries.length > 1) console.log(`\n--- Baking variant ${i + 1}/${geometries.length} ---`);
    variants.push(await bakeGeometry(coords, distanceM, (done, total) => onElevationProgress?.(i, done, total)));
  }
  return { variants };
}
