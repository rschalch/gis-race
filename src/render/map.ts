import maplibregl, { Map as MapLibreMap } from 'maplibre-gl';
import type { Route } from '../types';

const BASEMAP_STYLE = 'https://tiles.openfreemap.org/styles/liberty';

const CARS_SOURCE_ID = 'cars';
const CARS_LAYER_ID = 'cars-circle';

export interface CarMarker {
  id: string;
  lon: number;
  lat: number;
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

// F3: the zoom level followCar should use — starts at a sane default and is
// kept in sync with whatever the user last chose (wheel/pinch/±buttons)
// while following, instead of hardcoding 13 forever.
const DEFAULT_FOLLOW_ZOOM = 13;
const followZoomByMap = new WeakMap<MapLibreMap, number>();

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

function routeToLineString(route: Route): GeoJSON.Feature<GeoJSON.LineString> {
  return {
    type: 'Feature',
    properties: {},
    geometry: {
      type: 'LineString',
      coordinates: route.points.map((p) => [p.lon, p.lat]),
    },
  };
}

// Build the stops for a `line-gradient` expression from a subset of route
// points (line-gradient interpolates along normalised line-progress, 0..1).
const CURVATURE_GRADIENT_TARGET_STOPS = 1200;

function buildCurvatureGradientExpression(route: Route): maplibregl.ExpressionSpecification {
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

  return ['interpolate', ['linear'], ['line-progress'], ...stops] as maplibregl.ExpressionSpecification;
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
function unionBounds(routes: Route[]): maplibregl.LngLatBoundsLike {
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

function addRouteLayers(map: MapLibreMap, slug: string, route: Route): void {
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
        'line-color': '#334155',
        'line-width': 4,
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
        'line-width': 2,
        'line-gradient': buildCurvatureGradientExpression(route),
      },
    },
    beforeId,
  );
}

function removeRouteLayers(map: MapLibreMap, slug: string): void {
  if (map.getLayer(routeCurvatureLayerId(slug))) map.removeLayer(routeCurvatureLayerId(slug));
  if (map.getLayer(routeLineLayerId(slug))) map.removeLayer(routeLineLayerId(slug));
  if (map.getSource(routeSourceId(slug))) map.removeSource(routeSourceId(slug));
}

export function initMap(
  container: HTMLElement,
  routes: Map<string, Route>,
  onReady: (map: MapLibreMap) => void,
): MapLibreMap {
  const map = new maplibregl.Map({
    container,
    style: BASEMAP_STYLE,
    bounds: unionBounds([...routes.values()]),
    fitBoundsOptions: { padding: 40 },
  });

  followZoomByMap.set(map, DEFAULT_FOLLOW_ZOOM);
  // 'zoom' (not just 'zoomend') fires continuously during a gesture, so the
  // tracked value stays current with minimal lag against followCar's own
  // per-frame jumpTo — jumpTo re-applying the same zoom is a no-op and
  // doesn't re-fire this, so only genuine user zoom changes update it (F3).
  map.on('zoom', () => {
    followZoomByMap.set(map, map.getZoom());
  });

  map.on('load', () => {
    for (const [slug, route] of routes) addRouteLayers(map, slug, route);
    trackedSlugs.set(map, new Set(routes.keys()));

    map.addSource(CARS_SOURCE_ID, {
      type: 'geojson',
      data: { type: 'FeatureCollection', features: [] },
    });

    map.addLayer({
      id: CARS_LAYER_ID,
      type: 'circle',
      source: CARS_SOURCE_ID,
      paint: {
        'circle-radius': ['case', ['get', 'selected'], 10, 7],
        'circle-color': ['get', 'colour'],
        'circle-stroke-width': ['case', ['get', 'selected'], 3, 2],
        'circle-stroke-color': '#ffffff',
      },
    });

    map.on('mouseenter', CARS_LAYER_ID, () => {
      map.getCanvas().style.cursor = 'pointer';
    });
    map.on('mouseleave', CARS_LAYER_ID, () => {
      map.getCanvas().style.cursor = '';
    });

    onReady(map);
  });

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
  for (const [slug, route] of routes) {
    if (previous.has(slug)) {
      const source = map.getSource(routeSourceId(slug)) as maplibregl.GeoJSONSource;
      source.setData(routeToLineString(route));
      map.setPaintProperty(routeCurvatureLayerId(slug), 'line-gradient', buildCurvatureGradientExpression(route));
    } else {
      addRouteLayers(map, slug, route);
    }
  }
  trackedSlugs.set(map, new Set(routes.keys()));
}

/** Call once per animation frame with all cars' current positions. */
export function updateCarPositions(map: MapLibreMap, cars: CarMarker[]): void {
  const source = map.getSource(CARS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
  if (!source) return;
  const data: GeoJSON.FeatureCollection<GeoJSON.Point> = {
    type: 'FeatureCollection',
    features: cars.map((car) => ({
      type: 'Feature',
      properties: { id: car.id, colour: car.colour, selected: car.selected },
      geometry: { type: 'Point', coordinates: [car.lon, car.lat] },
    })),
  };
  source.setData(data);
}

/** §8.1 camera mode 1: static overview of every route in play. */
export function fitToRoutes(map: MapLibreMap, routes: Route[]): void {
  map.fitBounds(unionBounds(routes), { padding: 40 });
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
 * hardcoded 13 — see the 'zoom' listener in initMap.
 */
export function followCar(map: MapLibreMap, lon: number, lat: number): void {
  const zoom = followZoomByMap.get(map) ?? DEFAULT_FOLLOW_ZOOM;
  map.jumpTo({ center: [lon, lat], zoom });
}

/** Fires with a car's id whenever the user clicks its dot on the map. */
export function onCarClick(map: MapLibreMap, callback: (carId: string) => void): void {
  map.on('click', CARS_LAYER_ID, (e) => {
    const feature = e.features?.[0];
    const id = feature?.properties?.id;
    if (typeof id === 'string') callback(id);
  });
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
 */
export function onUserPan(map: MapLibreMap, callback: () => void): void {
  map.on('mousedown', callback);
  map.on('touchstart', callback);
}
