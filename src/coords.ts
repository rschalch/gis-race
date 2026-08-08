/**
 * Parsing of typed-in geographic coordinates.
 *
 * Lives in `src/` rather than `tools/` because all three entry points need the
 * same answer: the CLI baker, the dev-server bake API, and the browser's
 * Routes panel. A place *name* is ambiguous by nature — geocoding "Sorocaba"
 * lands you at the town's centroid, which may be a car park two streets from
 * the road you meant — so an exact pair of coordinates is the only way to say
 * precisely where a race starts.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

/**
 * Ceiling on intermediate stops for a baked course.
 *
 * Not a router limit — both Valhalla and OSRM take many more. It is an
 * elevation-sampling one: every stop lengthens the road, and the 30 m SRTM
 * sampler is the slow part of a bake by a wide margin. Eight is enough to pin
 * a course to the roads you meant without turning "Create course" into a
 * ten-minute wait.
 *
 * Lives here (the module every entry point shares) because the bake pipeline
 * enforces it, not just the panel UI: a bake holds the dev server's bake mutex
 * for its whole rate-limited run, so an over-long chain from ANY caller — the
 * API, the CLI — has to be rejected before it starts.
 */
export const MAX_VIA_STOPS = 8;

/**
 * What a typed endpoint turned out to be.
 *
 * `invalid` is deliberately distinct from `place`: "-23.5, -470" is obviously
 * an attempt at coordinates, and geocoding it as a place name would fail with
 * "couldn't find a place matching" — an error that sends you looking in
 * entirely the wrong direction.
 */
export type EndpointText =
  | { kind: 'coords'; value: LatLon }
  | { kind: 'place'; query: string }
  | { kind: 'invalid'; reason: string };

const LAT_MAX = 90;
const LON_MAX = 180;

/**
 * Accepts what people actually paste, which is "lat, lon" — the order Google
 * Maps, Apple Maps and OSM all display, and the order a coordinate is spoken
 * in. A leading `@` is tolerated because that is how a Google Maps URL carries
 * the pair, so pasting a fragment of one works.
 *
 * Not accepted: lon,lat. Supporting both orders means guessing, and the guess
 * is only ever wrong somewhere in the ±90° band where both readings are
 * valid — which is most of the inhabited world.
 */
export function parseEndpointText(text: string): EndpointText {
  const trimmed = text.trim().replace(/^@/, '');
  if (trimmed.length === 0) return { kind: 'invalid', reason: 'Enter a place name or "lat, lon" coordinates.' };

  // Two numbers separated by a comma and/or whitespace, and nothing else.
  const match = /^(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed);
  if (!match) return { kind: 'place', query: trimmed };

  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return { kind: 'place', query: trimmed };

  if (Math.abs(lat) > LAT_MAX) {
    // The most common mistake by far, and worth naming explicitly: a pair
    // copied out of GeoJSON, WKT or a Mapbox URL, all of which are lon-first.
    const swappedWouldWork = Math.abs(lat) <= LON_MAX && Math.abs(lon) <= LAT_MAX;
    return {
      kind: 'invalid',
      reason: swappedWouldWork
        ? `Latitude ${lat} is out of range — coordinates go lat first, so did you mean "${lon}, ${lat}"?`
        : `Latitude must be between -${LAT_MAX} and ${LAT_MAX} (got ${lat}).`,
    };
  }
  if (Math.abs(lon) > LON_MAX) {
    return { kind: 'invalid', reason: `Longitude must be between -${LON_MAX} and ${LON_MAX} (got ${lon}).` };
  }

  return { kind: 'coords', value: { lat, lon } };
}

/**
 * Five decimal places is about a metre — finer than the 25 m grid the
 * simulation runs on, and finer than the router's snap-to-road, so nothing is
 * lost by rounding here and a label stays readable.
 */
export function formatLatLon({ lat, lon }: LatLon, decimals = 5): string {
  return `${lat.toFixed(decimals)}, ${lon.toFixed(decimals)}`;
}
