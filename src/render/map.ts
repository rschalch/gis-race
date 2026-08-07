// maplibre-gl is pinned to v5, deliberately, not v6. v5 is where the `sky`
// style property landed, and v6 removes the internal `map.transform` that
// @deck.gl/mapbox reads (`transform.height`, `transform._nearZ`) to sync its
// camera — so on v6 the 3D car models throw on every rendered frame. v5 gives
// both sky and working deck.gl interleaving. Revisit only once deck.gl
// supports v6.
//
// Imported by name rather than via the default export, and @types/geojson is a
// direct devDependency: both keep this file honest about what it actually uses.
import {
  Map as MapLibreMap,
  NavigationControl,
  type ExpressionSpecification,
  type GeoJSONSource,
  type LngLatBoundsLike,
} from 'maplibre-gl';
// Imported by name rather than relying on the ambient `GeoJSON` namespace:
// tsconfig pins an explicit `types` array, so a bare @types/geojson install
// contributes no globals.
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import type { Route, VehicleType } from '../types';

import { buildBasemapStyle, demSource, HOSTED_BASEMAPS, TERRAIN_SOURCE_ID } from './basemap';
import { createCarOverlay, updateCars3D, resetModelCulling } from './cars-3d';
import { updateChaseCamera, resetChaseCamera, setClearPitch, isCarBlocked } from './chase-camera';
import { updateTvCamera, resetTvCamera } from './tv-camera';
import type { MapboxOverlay } from '@deck.gl/mapbox';

const CARS_SOURCE_ID = 'cars';
const CARS_LAYER_ID = 'cars-circle';

// True-scale relief reads as almost flat from a chase camera at street zoom:
// at zoom 14 the viewport spans ~2 km, over which even hilly ground rises only
// tens of metres. Exaggeration is the one lever here that is free — it
// displaces existing mesh vertices and pulls in no additional tiles — so it
// carries more of the load than the honest 1.0 would suggest.
const TERRAIN_EXAGGERATION = 1.8;


/**
 * Procedural sky (v5+ style property, the reason for the v6 upgrade). Without
 * it a pitched camera renders flat page-background above the horizon line,
 * which is what made the chase view read as "tilted map" rather than
 * "landscape".
 *
 * `fog-*` needs 3D terrain to have any effect, so those values only do
 * anything once the terrain toggle is on — harmless, and it means the sky
 * doesn't have to be re-set when terrain flips. The fog doubles as a cheap
 * answer to the pitched camera's far plane: haze at the horizon hides the
 * point where terrain tiles stop resolving.
 */
const SKY: NonNullable<Parameters<MapLibreMap['setSky']>[0]> = {
  'sky-color': '#8ab6e8',
  'horizon-color': '#dfeaf5',
  'fog-color': '#e8eef5',
  // How far up from the ground the fog reaches, and how wide the sky/horizon
  // and horizon/fog gradients are. Tuned narrow: a wide blend washes the
  // whole upper screen pale and flattens the depth cue it is meant to give.
  'fog-ground-blend': 0.6,
  'horizon-fog-blend': 0.4,
  'sky-horizon-blend': 0.6,
  // Only meaningful under globe projection, which this map never uses — left
  // at 0 so nothing is spent blending an atmosphere that can't be seen.
  'atmosphere-blend': 0,
};

export interface CarMarker {
  id: string;
  /** M1: which 3D mesh draws it (cars-3d.ts). The circle layer is type-blind. */
  type: VehicleType;
  lon: number;
  lat: number;
  /** Metres above sea level — positions the 3D model on the terrain. */
  ele: number;
  /** Compass bearing of travel in degrees, for orienting the 3D model. */
  heading: number;
  colour: string;
  selected: boolean;
}

// F1: cars can be on different route variants at once — one source/layer
// pair per distinct route slug instead of a single shared one.
function routeSourceId(slug: string): string {
  return `route-${slug}`;
}
function routeLineLayerId(slug: string): string {
  return `route-line-${slug}`;
}
function routeCurvatureLayerId(slug: string): string {
  return `route-curvature-${slug}`;
}

// Tracks which route slugs are currently rendered on a given map instance,
// so setRouteData can add/remove exactly the sources/layers that changed
// (keyed on the map, not global, in case more than one map instance exists).
const trackedSlugs = new WeakMap<MapLibreMap, Set<string>>();

// The deck.gl overlay drawing the 3D car models, per map instance.
const carOverlayByMap = new WeakMap<MapLibreMap, MapboxOverlay>();

// Click handler for the 3D car models, registered via onCarClick.
const carClickByMap = new WeakMap<MapLibreMap, (carId: string) => void>();

// F3: the zoom level followCar should use — starts at a sane default and is
// kept in sync with whatever the user last chose (wheel/pinch/±buttons)
// while following, instead of hardcoding it forever.
//
// 14 rather than the original 13: the basemap's `building-3d` fill-extrusion
// layer is gated at minzoom 14, so below that town sections render flat no
// matter the pitch. Not higher — a pitched camera renders all the way to the
// horizon, and tile count grows sharply with zoom once tilted (15 was
// measurably painful in practice).
const DEFAULT_FOLLOW_ZOOM = 14;
const followZoomByMap = new WeakMap<MapLibreMap, number>();

// Pitch and bearing now live in chase-camera.ts, which owns the follow
// camera's dynamics. Zoom stays here because it is user state (F3), not
// camera behaviour.
const MAX_PITCH = 85;

// The chase camera's current bearing, eased toward the route heading rather
// than snapped to it. Even with headingAt's 75 m averaging window, hard-
// setting bearing every frame makes tight switchbacks whip the whole world
// around; easing turns that into a car-like lean into the corner.
//
// A fixed per-frame factor, not a dt-scaled one: followCar's contract is
// already "call once per animation frame" (see below), and the visible
// difference across plausible frame rates is far smaller than the difference
// between eased and snapped.
const BEARING_EASING = 0.1;
const followBearingByMap = new WeakMap<MapLibreMap, number>();

/** Signed degrees from `from` to `to`, taking the short way around the circle. */
function shortestAngleDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

// Quantized colour scale by radius of curvature — tight turns read as hot
// colours, gentle/straight sections as cool ones. Makes the mountain section
// visually obvious per §8.1.
function curvatureColor(radius: number): string {
  if (radius < 60) return '#dc2626'; // red — tight switchback
  if (radius < 150) return '#f97316'; // orange
  if (radius < 400) return '#eab308'; // yellow
  if (radius < 1000) return '#84cc16'; // yellow-green
  return '#3b82f6'; // blue — straight / motorway
}

function routeToLineString(route: Route): Feature<LineString> {
  // Prefer the full-resolution shape: `points` is on the 25 m simulation grid,
  // which chords any turn tighter than that and draws a visible corner cut at
  // junctions. Falls back to `points` for routes baked before `shape` existed,
  // which then look exactly as they always did.
  const coordinates: number[][] = route.shape
    ? route.shape.map(([lon, lat]) => [lon, lat])
    : route.points.map((p) => [p.lon, p.lat]);

  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'LineString', coordinates },
  };
}

// Build the stops for a `line-gradient` expression from a subset of route
// points (line-gradient interpolates along normalised line-progress, 0..1).
const CURVATURE_GRADIENT_TARGET_STOPS = 1200;

function buildCurvatureGradientExpression(route: Route): ExpressionSpecification {
  // A fixed stride scales stop count linearly with route length — a 1000 km
  // bake (MAX_DISTANCE_KM) would produce ~5k stops in a single `interpolate`
  // expression, which MapLibre re-parses on every setPaintProperty (P6).
  // Targeting a stop *count* instead keeps this bounded regardless of route length.
  const STRIDE = Math.max(1, Math.ceil(route.points.length / CURVATURE_GRADIENT_TARGET_STOPS));
  const total = route.totalDistance;
  const stops: (number | string)[] = [];
  let lastProgress = -1;
  const pushStop = (p: (typeof route.points)[number]) => {
    const progress = p.s / total;
    // `interpolate` requires strictly ascending input values — when the
    // point count lands on a stride boundary, the final explicit point can
    // duplicate the stride loop's last entry (both at progress 1.0).
    if (progress <= lastProgress) return;
    stops.push(progress, curvatureColor(p.radius));
    lastProgress = progress;
  };
  for (let i = 0; i < route.points.length; i += STRIDE) pushStop(route.points[i]!);
  pushStop(route.points[route.points.length - 1]!);

  return ['interpolate', ['linear'], ['line-progress'], ...stops] as ExpressionSpecification;
}

function routeBounds(route: Route): { minLon: number; minLat: number; maxLon: number; maxLat: number } {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const p of route.points) {
    if (p.lon < minLon) minLon = p.lon;
    if (p.lon > maxLon) maxLon = p.lon;
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
  }
  return { minLon, minLat, maxLon, maxLat };
}

/** F1: union of every route's bounds — needed once more than one distinct
 * route can be on screen at once. */
function unionBounds(routes: Route[]): LngLatBoundsLike {
  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;
  for (const route of routes) {
    const b = routeBounds(route);
    if (b.minLon < minLon) minLon = b.minLon;
    if (b.maxLon > maxLon) maxLon = b.maxLon;
    if (b.minLat < minLat) minLat = b.minLat;
    if (b.maxLat > maxLat) maxLat = b.maxLat;
  }
  return [
    [minLon, minLat],
    [maxLon, maxLat],
  ];
}

/**
 * Casing colours, one per route variant in play (F1).
 *
 * The curvature gradient carries the *information*, so the variant identity
 * goes on the casing underneath it — with three alternates of one course on
 * screen at once, an all-grey casing gives no way to tell which road a car is
 * actually on.
 */
const VARIANT_CASINGS = ['#334155', '#4c1d95', '#134e4a', '#7c2d12', '#164e63'];

function casingColour(index: number): string {
  return VARIANT_CASINGS[index % VARIANT_CASINGS.length]!;
}

/**
 * Route line width, in pixels, interpolated over zoom.
 *
 * A fixed width cannot serve both ends: 4 px is a thread over a 225 km
 * overview and a stripe wider than the actual carriageway at chase zoom, where
 * it hides the road it is describing. Thin far out, and near-transparent
 * hairlines up close so the satellite imagery shows through.
 */
const ROUTE_CASING_WIDTH: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 8, 3, 12, 5, 15, 7, 18, 9];
const ROUTE_CURVATURE_WIDTH: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 8, 1.5, 12, 3, 15, 4, 18, 5];
// At chase zoom the line stops being a map symbol and starts covering the road
// surface, so it fades to a hint rather than a paint stripe.
const ROUTE_OPACITY: ExpressionSpecification = ['interpolate', ['linear'], ['zoom'], 13, 1, 16, 0.35];

function addRouteLayers(map: MapLibreMap, slug: string, route: Route, variantIndex: number): void {
  // Route layers added after load (setRouteData on Apply) would otherwise be
  // appended above the cars layer, hiding the car dots under the route lines
  // — insert them beneath it whenever it already exists.
  const beforeId = map.getLayer(CARS_LAYER_ID) ? CARS_LAYER_ID : undefined;

  map.addSource(routeSourceId(slug), {
    type: 'geojson',
    data: routeToLineString(route),
    lineMetrics: true,
  });

  map.addLayer(
    {
      id: routeLineLayerId(slug),
      type: 'line',
      source: routeSourceId(slug),
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': casingColour(variantIndex),
        'line-width': ROUTE_CASING_WIDTH,
        'line-opacity': ROUTE_OPACITY,
      },
    },
    beforeId,
  );

  map.addLayer(
    {
      id: routeCurvatureLayerId(slug),
      type: 'line',
      source: routeSourceId(slug),
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-width': ROUTE_CURVATURE_WIDTH,
        'line-opacity': ROUTE_OPACITY,
        'line-gradient': buildCurvatureGradientExpression(route),
      },
    },
    beforeId,
  );
}

// --- race information the simulation already knows -------------------------
//
// Everything below draws something the sim computes and the map used to keep
// to itself: where the route starts and ends, where a car actually crashed,
// and which stretch of road is under caution. The elevation strip and the
// incident feed had all of it; the map — the thing you are looking at — had
// none of it.

const MARKERS_SOURCE_ID = 'route-markers';
const MARKERS_CIRCLE_LAYER_ID = 'route-markers-circle';
const MARKERS_LABEL_LAYER_ID = 'route-markers-label';
const INCIDENTS_SOURCE_ID = 'incidents';
const INCIDENTS_LAYER_ID = 'incidents-circle';
const CAUTION_SOURCE_ID = 'caution-zones';
const CAUTION_LAYER_ID = 'caution-line';

/** Distance-marker spacing along a route, metres. */
const DISTANCE_MARKER_INTERVAL_M = 10_000;

const EMPTY_POINTS: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };
const EMPTY_LINES: FeatureCollection<LineString> = { type: 'FeatureCollection', features: [] };

function pointFeature(lon: number, lat: number, properties: Record<string, unknown>): Feature<Point> {
  return { type: 'Feature', properties, geometry: { type: 'Point', coordinates: [lon, lat] } };
}

/** Start/finish flags plus a tick every 10 km, for every route in play. */
function buildRouteMarkers(routes: Map<string, Route>): FeatureCollection<Point> {
  const features: Feature<Point>[] = [];
  for (const route of routes.values()) {
    const first = route.points[0]!;
    const last = route.points[route.points.length - 1]!;
    features.push(pointFeature(first.lon, first.lat, { kind: 'start', label: 'START' }));
    features.push(pointFeature(last.lon, last.lat, { kind: 'finish', label: 'FINISH' }));

    for (let d = DISTANCE_MARKER_INTERVAL_M; d < route.totalDistance - 500; d += DISTANCE_MARKER_INTERVAL_M) {
      // Nearest baked point rather than an interpolation: these are decorative
      // ticks, and 25 m of placement error is invisible at any zoom they show.
      const point = route.points[Math.min(Math.round(d / route.spacing), route.points.length - 1)]!;
      features.push(pointFeature(point.lon, point.lat, { kind: 'distance', label: `${Math.round(d / 1000)} km` }));
    }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Circle radius, in pixels, that approximates a fixed size on the *ground*.
 * Web Mercator halves metres-per-pixel with every zoom level, so an
 * exponential-base-2 interpolation is exact rather than approximate.
 */
function groundRadius(metresAtZoom14: number): ExpressionSpecification {
  return ['interpolate', ['exponential', 2], ['zoom'], 10, metresAtZoom14 / 16, 18, metresAtZoom14 * 16];
}

function addRaceInfoLayers(map: MapLibreMap): void {
  map.addSource(MARKERS_SOURCE_ID, { type: 'geojson', data: EMPTY_POINTS });
  map.addSource(INCIDENTS_SOURCE_ID, { type: 'geojson', data: EMPTY_POINTS });
  map.addSource(CAUTION_SOURCE_ID, { type: 'geojson', data: EMPTY_LINES });

  // Caution first, so it sits under the markers and cars rather than over them.
  map.addLayer({
    id: CAUTION_LAYER_ID,
    type: 'line',
    source: CAUTION_SOURCE_ID,
    layout: { 'line-join': 'round', 'line-cap': 'round' },
    paint: {
      'line-color': '#fbbf24',
      'line-width': ['interpolate', ['linear'], ['zoom'], 8, 4, 12, 8, 16, 14],
      'line-opacity': 0.55,
      'line-blur': 2,
    },
  });

  map.addLayer({
    id: MARKERS_CIRCLE_LAYER_ID,
    type: 'circle',
    source: MARKERS_SOURCE_ID,
    paint: {
      'circle-radius': ['case', ['==', ['get', 'kind'], 'distance'], 3, 6],
      'circle-color': [
        'match',
        ['get', 'kind'],
        'start',
        '#22c55e',
        'finish',
        '#ef4444',
        /* distance */ '#e2e8f0',
      ],
      'circle-stroke-width': ['case', ['==', ['get', 'kind'], 'distance'], 1, 2],
      'circle-stroke-color': '#0f172a',
      // Distance ticks are clutter on an overview of a 400 km route; the
      // start/finish flags never are.
      //
      // Note the nesting: `zoom` is only legal at the TOP level of a paint
      // property, so the interpolation goes outside and the per-kind choice
      // becomes the output of each stop. The natural-looking inverse (a `case`
      // wrapping an `interpolate`) is rejected outright by the style
      // validator, and MapLibre's response is to drop the whole layer — it
      // logs to the console and renders nothing, which looks exactly like a
      // layer that was never added.
      'circle-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        9,
        ['case', ['==', ['get', 'kind'], 'distance'], 0, 1],
        10.5,
        ['case', ['==', ['get', 'kind'], 'distance'], 0.9, 1],
      ],
    },
  });

  map.addLayer({
    id: MARKERS_LABEL_LAYER_ID,
    type: 'symbol',
    source: MARKERS_SOURCE_ID,
    layout: {
      'text-field': ['get', 'label'],
      'text-font': ['Noto Sans Regular'],
      'text-size': ['case', ['==', ['get', 'kind'], 'distance'], 10, 12],
      'text-offset': [0, 1.2],
      'text-anchor': 'top',
      // Let MapLibre drop labels rather than stack them — a 40-tick route
      // zoomed out would otherwise be a wall of text.
      'text-allow-overlap': false,
      'text-optional': true,
    },
    paint: {
      'text-color': '#ffffff',
      'text-halo-color': 'rgba(0,0,0,0.8)',
      'text-halo-width': 1.4,
      // Same top-level-zoom rule as the circle layer above.
      'text-opacity': [
        'interpolate',
        ['linear'],
        ['zoom'],
        10.5,
        ['case', ['==', ['get', 'kind'], 'distance'], 0, 1],
        11.5,
        1,
      ],
    },
  });

  map.addLayer({
    id: INCIDENTS_LAYER_ID,
    type: 'circle',
    source: INCIDENTS_SOURCE_ID,
    paint: {
      // Sized on the ground, not in pixels: an incident is a place on the road,
      // and it should grow as you zoom toward it like everything else does.
      'circle-radius': groundRadius(7),
      'circle-color': ['case', ['get', 'terminal'], '#ef4444', '#f59e0b'],
      'circle-opacity': 0.45,
      'circle-stroke-width': 1.5,
      'circle-stroke-color': ['case', ['get', 'terminal'], '#fecaca', '#fde68a'],
      'circle-stroke-opacity': 0.9,
    },
  });
}

/** Where a car lost it, and whether that ended its race. Append-only within a
 * race; main.ts rebuilds the whole set when a new race starts. */
export interface IncidentMarker {
  lon: number;
  lat: number;
  terminal: boolean;
}

export function setIncidentMarkers(map: MapLibreMap, incidents: IncidentMarker[]): void {
  incidentsByMap.set(map, incidents);
  const source = map.getSource(INCIDENTS_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;
  source.setData({
    type: 'FeatureCollection',
    features: incidents.map((i) => pointFeature(i.lon, i.lat, { terminal: i.terminal })),
  });
}

/** R6 caution zones — the stretch of road cars are lifting for, drawn as the
 * stretch it actually is rather than a radius around a point. */
export function setCautionZones(
  map: MapLibreMap,
  zones: Array<{ route: Route; s: number; behindM: number; aheadM: number }>,
): void {
  const source = map.getSource(CAUTION_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;

  const features: Feature<LineString>[] = zones.map(({ route, s, behindM, aheadM }) => {
    const from = Math.max(0, Math.floor((s - behindM) / route.spacing));
    const to = Math.min(route.points.length - 1, Math.ceil((s + aheadM) / route.spacing));
    const coordinates: number[][] = [];
    for (let i = from; i <= to; i++) coordinates.push([route.points[i]!.lon, route.points[i]!.lat]);
    // A zone at the very last point would otherwise be a zero-length line,
    // which renders as nothing at all.
    if (coordinates.length < 2) coordinates.push(coordinates[0] ?? [0, 0]);
    return { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } };
  });

  source.setData({ type: 'FeatureCollection', features });
}

function removeRouteLayers(map: MapLibreMap, slug: string): void {
  if (map.getLayer(routeCurvatureLayerId(slug))) map.removeLayer(routeCurvatureLayerId(slug));
  if (map.getLayer(routeLineLayerId(slug))) map.removeLayer(routeLineLayerId(slug));
  if (map.getSource(routeSourceId(slug))) map.removeSource(routeSourceId(slug));
}

/**
 * Everything the app itself puts on the map, in the order it has to go on.
 *
 * Called once at load and again after every basemap swap: `setStyle` discards
 * all sources and layers, ours included, so a switcher that did not replay this
 * exactly would leave a race with no route, no cars, or its markers stacked
 * above the vehicles. One function, two callers, no second copy to forget.
 *
 * Order matters and is not alphabetical: race-information layers go on before
 * the car circles so cars draw over their own crash markers, and the route
 * lines go on first of all so `addRouteLayers`'s `beforeId` has something to
 * aim at.
 */
function addAppLayers(map: MapLibreMap, routes: Map<string, Route>): void {
  map.setSky(SKY);

  // A hosted style has no DEM source of its own — without this the relief
  // toggle silently does nothing after a swap.
  if (!map.getSource(TERRAIN_SOURCE_ID)) map.addSource(TERRAIN_SOURCE_ID, demSource());

  let variantIndex = 0;
  for (const [slug, route] of routes) addRouteLayers(map, slug, route, variantIndex++);
  trackedSlugs.set(map, new Set(routes.keys()));

  addRaceInfoLayers(map);
  setRouteMarkers(map, routes);
  // Crash sites belong to the race, not to the basemap: re-apply whatever was
  // showing before the swap.
  setIncidentMarkers(map, incidentsByMap.get(map) ?? []);

  map.addSource(CARS_SOURCE_ID, {
    type: 'geojson',
    data: { type: 'FeatureCollection', features: [] },
  });

  map.addLayer({
    id: CARS_LAYER_ID,
    type: 'circle',
    source: CARS_SOURCE_ID,
    paint: {
      // Two representations of the same car hand over at zoom ~14: dots own
      // the overview (where a model is sub-pixel), models own the close view.
      //
      // Shrinking the dot is not enough to hide it — that was tried and the
      // white stroke still showed as a crescent under the car. A circle is
      // drawn flat on the ground, so at 75° pitch it projects to an ellipse
      // wider than the model's footprint however small the radius. It has to
      // fade out entirely.
      'circle-radius': [
        'interpolate',
        ['linear'],
        ['zoom'],
        12,
        ['case', ['get', 'selected'], 10, 7],
        15,
        ['case', ['get', 'selected'], 6, 4],
      ],
      'circle-color': ['get', 'colour'],
      // Fill always goes: at close zoom the model is the car, and a coloured
      // disc behind it just muddies the livery.
      'circle-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 1, 14.5, 0],
      'circle-stroke-width': ['case', ['get', 'selected'], 3, 2],
      'circle-stroke-color': '#ffffff',
      // Nothing survives the handover, selected included: a flat ring around
      // a 3D car at 75° pitch projects to an ellipse that never lines up with
      // the model. Selection is shown by the HUD row, not on the map.
      'circle-stroke-opacity': ['interpolate', ['linear'], ['zoom'], 13.5, 1, 14.5, 0],
    },
  });

  // deck.gl's interleaved layers live inside the style too, so the overlay has
  // to be rebuilt rather than reused — the old control is detached first or
  // MapLibre keeps a dead one in its control list forever.
  const previousOverlay = carOverlayByMap.get(map);
  if (previousOverlay) map.removeControl(previousOverlay);
  carOverlayByMap.set(map, createCarOverlay(map));
  // A fresh overlay has no layers until the next frame's updateCars3D, and the
  // zoom-culling latch would otherwise think it had already cleared them.
  resetModelCulling(map);
}

/** Last incident set handed to setIncidentMarkers, so a basemap swap can put
 * them back. */
const incidentsByMap = new WeakMap<MapLibreMap, IncidentMarker[]>();

export type BasemapId = 'satellite' | keyof typeof HOSTED_BASEMAPS;

export const BASEMAP_LABELS: Record<BasemapId, string> = {
  satellite: 'Satellite',
  road: HOSTED_BASEMAPS.road.label,
  minimal: HOSTED_BASEMAPS.minimal.label,
  dark: HOSTED_BASEMAPS.dark.label,
};

/**
 * Swap the basemap under a running race.
 *
 * `setStyle` is a demolition: sources, layers, terrain and deck.gl's
 * interleaved layers all go. Terrain state is captured and restored around it
 * because a relief toggle that silently switches itself off is a bug, not a
 * side effect of changing the map's colour scheme.
 */
export function setBasemap(map: MapLibreMap, id: BasemapId, routes: Map<string, Route>): Promise<void> {
  const terrain = map.getTerrain();
  const exaggeration = terrain?.exaggeration ?? TERRAIN_EXAGGERATION;
  const terrainWasOn = Boolean(terrain);

  map.setStyle(id === 'satellite' ? buildBasemapStyle() : HOSTED_BASEMAPS[id].url, { diff: false });

  // Resolves when the new style is live and everything has been put back, so
  // the caller can keep the control disabled until then. Starting a second
  // swap while the first is still loading its sprite is what produced
  // MapLibre's `bucket.icon.opacityVertexArray.length !== ...` assertion in
  // testing — swapping four styles in four seconds. One at a time is both the
  // fix and what a person would do anyway.
  return new Promise((resolve) => {
    map.once('style.load', () => {
      addAppLayers(map, routes);
      if (terrainWasOn) map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
      resolve();
    });
  });
}

/** Relief on/off and how much of it, driven from the app's own control rather
 * than MapLibre's TerrainControl — the built-in one owns the exaggeration it
 * was constructed with, which makes a separate slider fight it. */
export function setTerrainEnabled(map: MapLibreMap, enabled: boolean, exaggeration: number): void {
  map.setTerrain(enabled ? { source: TERRAIN_SOURCE_ID, exaggeration } : null);
}

export function setTerrainExaggeration(map: MapLibreMap, exaggeration: number): void {
  if (map.getTerrain()) map.setTerrain({ source: TERRAIN_SOURCE_ID, exaggeration });
}

export function initMap(
  container: HTMLElement,
  routes: Map<string, Route>,
  onReady: (map: MapLibreMap) => void,
): MapLibreMap {
  const map = new MapLibreMap({
    container,
    style: buildBasemapStyle(),
    bounds: unionBounds([...routes.values()]),
    fitBoundsOptions: { padding: 40 },
    maxPitch: MAX_PITCH,
  });

  followZoomByMap.set(map, DEFAULT_FOLLOW_ZOOM);
  // 'zoom' (not just 'zoomend') fires continuously during a gesture, so the
  // tracked value stays current with minimal lag against followCar's own
  // per-frame jumpTo — jumpTo re-applying the same zoom is a no-op and
  // doesn't re-fire this, so only genuine user zoom changes update it (F3).
  map.on('zoom', () => {
    followZoomByMap.set(map, map.getZoom());
  });

  // 'dragstart'/'dragend' rather than 'movestart'/'moveend': the latter also
  // fire for the chase camera's own per-frame jumpTo, which would leave the
  // circles suspended for the entire time follow mode is active.
  map.on('dragstart', () => panningByMap.add(map));
  map.on('dragend', () => {
    panningByMap.delete(map);
    circlesUpdatedAtByMap.delete(map); // refresh on the very next frame
  });

  map.on('load', () => {
    // bottom-right, not the MapLibre default top-right: the entire top strip
    // is already spoken for (#hud left, #race-controls centre, #panel-triggers
    // right at top/right: 12px). Controls placed top-right land *underneath*
    // the Config/Routes buttons — confirmed in the browser, where only the
    // second-stacked control peeked out below them.
    map.addControl(new NavigationControl({ visualizePitch: true }), 'bottom-right');

    addAppLayers(map, routes);

    map.on('mouseenter', CARS_LAYER_ID, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', CARS_LAYER_ID, () => {
      map.getCanvas().style.cursor = '';
    });

    onReady(map);
  });

  // Dev-only handle on the map. Camera bugs here are all of the form "the
  // number is not what you think" (pitch pinned to 0, zoom stuck, bearing not
  // tracking), and they are invisible in a screenshot but obvious the moment
  // you can read getPitch()/getBearing() from the console. `import.meta.env.DEV`
  // is statically replaced, so this whole branch is dropped from the build.
  if (import.meta.env.DEV) {
    const w = window as unknown as { __map?: MapLibreMap; __isCarBlocked?: typeof isCarBlocked };
    w.__map = map;
    w.__isCarBlocked = isCarBlocked;
  }

  return map;
}

/** §5.9 / F1: swap the displayed route set (line + curvature gradient per
 * distinct route, no page reload). Adds/removes exactly the sources/layers
 * whose slug set changed since the last call. */
export function setRouteData(map: MapLibreMap, routes: Map<string, Route>): void {
  const previous = trackedSlugs.get(map);
  if (!previous) return; // map not loaded yet

  for (const slug of previous) {
    if (!routes.has(slug)) removeRouteLayers(map, slug);
  }
  let variantIndex = 0;
  for (const [slug, route] of routes) {
    const index = variantIndex++;
    if (previous.has(slug)) {
      const source = map.getSource(routeSourceId(slug)) as GeoJSONSource;
      source.setData(routeToLineString(route));
      map.setPaintProperty(routeCurvatureLayerId(slug), 'line-gradient', buildCurvatureGradientExpression(route));
      // Casing colour is positional (which variant is this, of the ones on
      // screen), so it has to be re-asserted when the set changes.
      map.setPaintProperty(routeLineLayerId(slug), 'line-color', casingColour(index));
    } else {
      addRouteLayers(map, slug, route, index);
    }
  }
  trackedSlugs.set(map, new Set(routes.keys()));
  setRouteMarkers(map, routes);
  // A new race has no incidents and no cautions; leaving the old ones up would
  // mark crash sites from a race that is over.
  setIncidentMarkers(map, []);
  setCautionZones(map, []);
}

/** Start/finish flags and distance ticks for the routes now in play. */
export function setRouteMarkers(map: MapLibreMap, routes: Map<string, Route>): void {
  const source = map.getSource(MARKERS_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;
  source.setData(buildRouteMarkers(routes));
}

// Zoom at which `circle-opacity` has interpolated all the way to 0 (see the
// CARS_LAYER_ID paint spec). Above this the circles contribute literally
// nothing to the frame.
const CIRCLE_FADE_OUT_ZOOM = 14.5;

/**
 * How often the circle layer's GeoJSON is rebuilt, in milliseconds.
 *
 * `setData` is not a cheap assignment: MapLibre re-parses the collection,
 * re-tiles it on the worker thread and re-uploads the result, then repaints.
 * Doing that 60 times a second was measured (call counts, not wall clock) and
 * it is pure waste at the only zooms where these circles are visible — the
 * layer fades out by zoom 14.5, and below that a car at 30 m/s crosses a
 * handful of *pixels per second*. 20 Hz is indistinguishable and cuts the
 * worker round-trips by two thirds.
 *
 * The 3D models are deliberately NOT throttled with it: they own the close-up
 * view, where a car really does move several pixels per frame and stepping
 * would read as judder against a camera that moves smoothly.
 */
const CIRCLE_UPDATE_INTERVAL_MS = 50;

const circlesUpdatedAtByMap = new WeakMap<MapLibreMap, number>();

/**
 * Maps the user is mid-pan on.
 *
 * A drag is the one moment the main thread must be left alone: MapLibre is
 * re-projecting and repainting the whole scene per pointer move, and every
 * `setData` in that window adds a GeoJSON re-parse, a worker round-trip and a
 * re-tile on top of it. The circles are suspended outright for the duration —
 * at the zooms where they are visible a car covers a few pixels per second, so
 * a gesture-length pause is invisible, and the layer refreshes the instant the
 * gesture ends. The 3D models are NOT suspended: they own the close view where
 * a car really does move, and freezing them would read as a stutter.
 */
const panningByMap = new WeakSet<MapLibreMap>();

// Whether the circle source has already been emptied for this map because the
// camera went above the fade-out zoom — so the emptying happens exactly once
// per crossing rather than every frame.
const circlesClearedByMap = new WeakMap<MapLibreMap, boolean>();

const EMPTY_CARS: FeatureCollection<Point> = { type: 'FeatureCollection', features: [] };

/** Call once per animation frame with all cars' current positions. */
export function updateCarPositions(map: MapLibreMap, cars: CarMarker[], now: number = performance.now()): void {
  const overlay = carOverlayByMap.get(map);
  if (overlay) updateCars3D(map, overlay, cars, carClickByMap.get(map));

  // The circle layer is still drawn, and still carries the click handling and
  // selection ring — but `circle-radius` shrinks it to a dot at chase-camera
  // zoom, where it disappears under the 3D model. At overview zoom the model is
  // sub-pixel and the circle is the only thing that makes a car visible at all,
  // so the two representations hand over rather than compete.
  const source = map.getSource(CARS_SOURCE_ID) as GeoJSONSource | undefined;
  if (!source) return;

  // Rebuilding a FeatureCollection and handing it to setData makes MapLibre
  // re-parse and re-upload the whole source every frame. Above the fade-out
  // zoom the circles are fully transparent, so that entire cost buys an
  // invisible layer — skip it, and refresh once on the way back down.
  //
  // The source is emptied once on the way up rather than simply left alone:
  // MapLibre still hit-tests fully transparent features, so leaving stale
  // circles behind would let a click at chase zoom select whichever car
  // happened to be there when updates stopped, instead of the car actually
  // under the pointer (which the 3D model picks up — see onCarClick).
  if (map.getZoom() >= CIRCLE_FADE_OUT_ZOOM) {
    if (!circlesClearedByMap.get(map)) {
      source.setData(EMPTY_CARS);
      circlesClearedByMap.set(map, true);
    }
    return;
  }

  // Below the fade-out zoom the circles are what makes a car visible, but they
  // do not need rebuilding every frame — see CIRCLE_UPDATE_INTERVAL_MS. Coming
  // back down from above the fade zoom refills immediately (the source is
  // empty up there, so waiting out the throttle would blink the cars away).
  if (panningByMap.has(map)) return;
  const refilling = circlesClearedByMap.get(map) === true;
  const lastUpdate = circlesUpdatedAtByMap.get(map);
  if (!refilling && lastUpdate !== undefined && now - lastUpdate < CIRCLE_UPDATE_INTERVAL_MS) return;
  circlesUpdatedAtByMap.set(map, now);

  const data: FeatureCollection<Point> = {
    type: 'FeatureCollection',
    features: cars.map((car) => ({
      type: 'Feature',
      properties: { id: car.id, colour: car.colour, selected: car.selected },
      geometry: { type: 'Point', coordinates: [car.lon, car.lat] },
    })),
  };
  source.setData(data);
  circlesClearedByMap.set(map, false);
}

/**
 * §8.1 camera mode 1: static overview of every route in play.
 *
 * Explicitly flattens pitch and bearing — an overview is a map-reading view,
 * and leaving it at the chase camera's 60° tilt after switching out of follow
 * both hides the far end of the route behind the horizon and leaves the whole
 * route rotated to whatever heading the car happened to be on.
 */
export function fitToRoutes(map: MapLibreMap, routes: Route[]): void {
  map.fitBounds(unionBounds(routes), { padding: 40, pitch: 0, bearing: 0 });
}

/**
 * §8.1 camera mode 2/3: track a car's current position, every frame.
 *
 * The spec calls for easeTo here, but restarting an easeTo animation every
 * ~16ms (once per animation frame) converges far too slowly in practice —
 * confirmed empirically with both the default ease-in-out curve and linear
 * easing (measured zoom crawling from 9 toward 13 over several seconds
 * instead of converging in a few frames). jumpTo puts the camera exactly on
 * target every single frame; since that's already 60 updates/second, the
 * result is still visually smooth — the only loss is easeTo's deliberate
 * trailing-lag feel, which no acceptance criterion depends on.
 *
 * Zoom is whatever the user last chose while following (F3), not a
 * hardcoded value — see the 'zoom' listener in initMap.
 *
 * `heading` is the route's compass bearing at the car's current `s`
 * (routeAt/headingAt) — the camera swings behind the car to look along the
 * road, which is what turns a top-down dot into a chase view. It stays a
 * *rendering* input: the sim never computes or consumes a heading.
 */
export function followCar(map: MapLibreMap, lon: number, lat: number, heading: number): void {
  // Zoom is read here and handed to the camera, which never writes it back —
  // that is what keeps scroll/pinch/± working while following (F3).
  const zoom = followZoomByMap.get(map) ?? DEFAULT_FOLLOW_ZOOM;
  updateChaseCamera(map, lon, lat, heading, zoom);
}

/**
 * Drops the camera's eased bearing/pitch so the next frame snaps instead of
 * sweeping. Called when follow mode is (re-)entered — otherwise picking a car
 * heading the other way rotates the entire map through 180° over a second,
 * which reads as the world spinning rather than a cut to a new car.
 */
export function resetChaseCam(map: MapLibreMap): void {
  resetChaseCamera(map);
  resetTvCamera(map);
}

/**
 * Camera presets: how far back the follow camera sits, and how far it looks
 * down from there.
 *
 * Zoom was already user state (F3) — the wheel and the ± buttons set it and
 * the camera reads it. These are shortcuts to useful values, plus the matching
 * pitch, because the two are not independent: a helicopter view that keeps the
 * chase camera's 75° pitch is looking at the horizon from 3 km up, and an
 * onboard view flattened to 45° is looking at the bonnet.
 */
export const CAMERA_PRESETS = {
  onboard: { zoom: 16.5, pitch: 80, label: 'Onboard' },
  close: { zoom: 15, pitch: 75, label: 'Close' },
  wide: { zoom: 13.5, pitch: 62, label: 'Wide' },
  heli: { zoom: 11.5, pitch: 35, label: 'Helicopter' },
} as const;

export type CameraPreset = keyof typeof CAMERA_PRESETS;

export function setCameraPreset(map: MapLibreMap, preset: CameraPreset): void {
  const { zoom, pitch } = CAMERA_PRESETS[preset];
  followZoomByMap.set(map, zoom);
  setClearPitch(map, pitch);
  // The chase camera only writes zoom on its first frame after a reset (that
  // is what keeps the wheel working), so a preset has to reset it to be
  // applied at all — which also gives the change the intro ease for free.
  resetChaseCamera(map);
  resetTvCamera(map);
}

/**
 * §8.1 camera mode 4: broadcast coverage — see tv-camera.ts. Shares the follow
 * camera's zoom so the presets above still mean something here.
 */
export function tvCar(map: MapLibreMap, lon: number, lat: number, heading: number, now: number): void {
  const zoom = followZoomByMap.get(map) ?? DEFAULT_FOLLOW_ZOOM;
  updateTvCamera(map, lon, lat, heading, zoom, now);
}

/** Fires with a car's id whenever the user clicks its dot on the map. */
export function onCarClick(map: MapLibreMap, callback: (carId: string) => void): void {
  map.on('click', CARS_LAYER_ID, (e) => {
    const feature = e.features?.[0];
    const id = feature?.properties?.id;
    if (typeof id === 'string') callback(id);
  });
  // The circle is invisible at close zoom and only a few pixels wide, so on its
  // own it would leave the car effectively unclickable exactly where the car is
  // biggest on screen. The 3D model picks up the click there.
  carClickByMap.set(map, callback);
}

/**
 * F3: the "grab to break follow" idiom every map app uses — followCar's
 * per-frame jumpTo otherwise snaps any manual pan straight back next frame,
 * making the map feel unresponsive to touch while following a car. The
 * caller decides whether that should actually drop out of follow mode
 * (only meaningful if it was active).
 *
 * Listens for raw 'mousedown'/'touchstart' rather than the higher-level
 * 'dragstart' — confirmed by reproduction that 'dragstart' never fires
 * while actively following: followCar's jumpTo recenters the map every
 * ~16ms, which resets MapLibre's drag-gesture recognizer before it ever
 * finishes classifying the gesture as a drag. Raw pointer-down events fire
 * immediately and unconditionally, so they aren't subject to that race.
 *
 * Right-button and ctrl-held drags are deliberately exempt: those are
 * MapLibre's tilt/rotate gesture, not a pan, and treating them as "user
 * wants out of follow" made the chase camera's pitch impossible to adjust
 * without first leaving follow mode. Rotation during follow is still
 * overridden by followCar's bearing on the next frame — the chase camera
 * owns bearing, the user owns pitch.
 */
export function onUserPan(map: MapLibreMap, callback: () => void): void {
  map.on('mousedown', (e) => {
    const original = e.originalEvent;
    if (original.button === 2 || original.ctrlKey) return;
    callback();
  });
  map.on('touchstart', (e) => {
    // Two-finger gestures are pitch/rotate/zoom, not a pan.
    if (e.originalEvent.touches.length > 1) return;
    callback();
  });
}
