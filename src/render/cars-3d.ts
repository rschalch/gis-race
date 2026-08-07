import { MapboxOverlay } from '@deck.gl/mapbox';
import { SimpleMeshLayer } from '@deck.gl/mesh-layers';
import type { Map as MapLibreMap } from 'maplibre-gl';
import { buildCarMesh } from './car-mesh';
import { buildMotorcycleMesh } from './bike-mesh';
import type { VehicleType } from '../types';

/**
 * 3D car models, drawn with deck.gl over the MapLibre scene.
 *
 * `interleaved: true` renders into MapLibre's own WebGL2 context and depth
 * buffer, which is the whole reason for using it: a car behind a building or
 * over a ridge is occluded correctly. The overlay mode would paint every car
 * flat on top of the scene, which at a 75° chase pitch looks obviously wrong.
 * Interleaving needs WebGL2 and maplibre-gl > 3, both satisfied on v5. Note it
 * is NOT satisfied on v6: @deck.gl/mapbox reads the internal `map.transform`
 * that v6 removed, and throws on every frame there. See the pin note in map.ts.
 */

const CAR_MESH = buildCarMesh();
const BIKE_MESH = buildMotorcycleMesh();
const CARS_LAYER_ID = 'cars-3d';
const BIKES_LAYER_ID = 'bikes-3d';

/** Nose-to-tail length of the mesh in car-mesh.ts, metres. */
const CAR_LENGTH_M = 4.2;

/**
 * How long a car should appear on screen, in pixels.
 *
 * A life-size car is invisible on a map and this is not a close call: Web
 * Mercator at zoom 14 is ~8.8 m/pixel, so a 4.2 m car measures **0.91 pixels**
 * (measured, not estimated). Drawing cars at true scale would need zoom ~19-20
 * to see them, by which point the viewport is one block of road and there is no
 * race to watch.
 *
 * So cars are drawn oversized, like map markers, at a roughly constant screen
 * size across zooms. There is no setting that makes them both visible and
 * correctly proportioned to the road — a 4 m object on a map spanning
 * kilometres is either invisible or exaggerated. 20 px was picked by looking at
 * the result: 36 px put a car across two lanes and most of a city block.
 */
const TARGET_CAR_PIXELS = 20;

/**
 * Bounds on the exaggeration. The floor of 1 stops cars shrinking below life
 * size when zoomed right in — past ~zoom 20 they should simply be real. The
 * ceiling stops them ballooning across whole neighbourhoods at overview zoom,
 * where the circle markers take over anyway.
 */
const MIN_SIZE_SCALE = 1;
const MAX_SIZE_SCALE = 45;

/** Ground resolution of Web Mercator at a given zoom and latitude, m/pixel. */
function metresPerPixel(zoom: number, lat: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/**
 * How far a car may travel before its terrain height is looked up again.
 *
 * `map.queryTerrainElevation` raycasts into MapLibre's DEM mesh, and it was
 * being called once per car per frame — measured at ~0.18 ms a call, so a
 * 28-car field spent ~5 ms of every frame on it, about a third of a 60 fps
 * budget, purely to re-derive heights that had barely changed.
 *
 * Road elevation varies smoothly along a route (the baker smooths it, and the
 * DEM is 30 m SRTM to begin with), so re-sampling every 8 m of travel is
 * indistinguishable from every frame — at 30 m/s that is roughly 4 lookups a
 * second per car instead of 60.
 */
const TERRAIN_REQUERY_DISTANCE_M = 8;

interface TerrainSample {
  lon: number;
  lat: number;
  z: number;
  /** True when the lookup fell back to baked elevation because DEM tiles for
   * that spot had not loaded. Those must be retried every frame — otherwise a
   * car that happened to be sampled during tile load keeps a wrong height for
   * the next 8 m, which on a hillside is visibly wrong. */
  provisional: boolean;
}

const terrainCacheByMap = new WeakMap<MapLibreMap, Map<string, TerrainSample>>();

/** Approximate metres between two nearby lon/lat pairs — equirectangular is
 * ample over the few metres this is ever asked about. */
function roughMetresBetween(aLon: number, aLat: number, bLon: number, bLat: number): number {
  const meanLat = ((aLat + bLat) / 2) * (Math.PI / 180);
  const dx = (bLon - aLon) * Math.cos(meanLat) * 111_320;
  const dy = (bLat - aLat) * 110_540;
  return Math.hypot(dx, dy);
}

function carSizeScale(map: MapLibreMap): number {
  const mpp = metresPerPixel(map.getZoom(), map.getCenter().lat);
  const scale = (TARGET_CAR_PIXELS * mpp) / CAR_LENGTH_M;
  return Math.min(MAX_SIZE_SCALE, Math.max(MIN_SIZE_SCALE, scale));
}

export interface Car3D {
  id: string;
  /** M1: picks which mesh draws this vehicle. */
  type: VehicleType;
  lon: number;
  lat: number;
  /** Metres above sea level, from the route's baked elevation. */
  ele: number;
  /** Compass bearing of travel, degrees clockwise from north. */
  heading: number;
  colour: string;
  selected: boolean;
}

/**
 * Zoom below which the models are not drawn at all.
 *
 * At overview zoom a car is drawn at MAX_SIZE_SCALE and still measures well
 * under a pixel (at zoom 10 it is ~1.2 px long) — the circle layer is what
 * actually makes a car visible there, which is exactly why the two hand over.
 * Feeding deck.gl twenty invisible meshes every frame costs a layer update, an
 * attribute re-upload and a draw call per frame for nothing. Set below the
 * circle layer's fade-out so the two overlap rather than leaving a gap where
 * neither is drawn.
 */
const MODEL_MIN_ZOOM = 13.5;

/** '#rrggbb' → deck.gl's [r, g, b] 0-255. */
function hexToRgb(hex: string): [number, number, number] {
  const v = parseInt(hex.replace('#', ''), 16);
  return [(v >> 16) & 255, (v >> 8) & 255, v & 255];
}

// Props that never vary, hoisted out of the per-frame layer construction.
// deck.gl compares props by reference: a fresh accessor closure or material
// object each frame reads as "this prop changed", which re-runs the accessor
// over every car and re-uploads that attribute buffer. Colour and orientation
// only actually change when the data does.
//
// deck.gl wants [pitch, yaw, roll]. Yaw is counter-clockwise from +X (east)
// while `heading` is a compass bearing — clockwise from north — hence
// 90 - heading rather than the heading itself.
const getOrientation = (d: Car3D): [number, number, number] => [0, 90 - d.heading, 0];

const getColor = (d: Car3D): [number, number, number, number] => {
  const [r, g, b] = hexToRgb(d.colour);
  return [r, g, b, 255];
};

// Budgeted against deck.gl's default lighting rather than picked by feel: that
// default is one ambient light plus TWO directional lights (intensity 1.0 and
// 0.9), so the diffuse term is multiplied by ~1.9. ambient + 1.9 x diffuse must
// stay under 1.0 or every upward-facing face saturates and the whole car
// renders white — which is exactly what ambient 0.45 / diffuse 0.7 did.
// 0.5 + 1.9 x 0.25 = 0.98 keeps the livery colour readable while still shading
// the faces apart.
const CAR_MATERIAL = {
  ambient: 0.5,
  diffuse: 0.25,
  shininess: 12,
  // Near-black specular: a white highlight on a small, mostly flat roof reads
  // as another blown-out patch, not as gloss.
  specularColor: [15, 15, 15] as [number, number, number],
};

/** Set once the layer list has been emptied for being below MODEL_MIN_ZOOM, so
 * the empty update is pushed exactly once per crossing instead of per frame. */
const modelsClearedByMap = new WeakMap<MapLibreMap, boolean>();

/**
 * Forget that latch.
 *
 * A basemap swap rebuilds the deck.gl overlay from scratch, so the new one has
 * no layers — but the latch would still say "already cleared" and skip the
 * update that puts the models back. Called by map.ts after it recreates the
 * overlay.
 */
export function resetModelCulling(map: MapLibreMap): void {
  modelsClearedByMap.delete(map);
}

export function createCarOverlay(map: MapLibreMap): MapboxOverlay {
  const overlay = new MapboxOverlay({ interleaved: true, layers: [] });
  map.addControl(overlay);
  // Dev-only handle, same reasoning as __map in map.ts: deck.gl groups its
  // layers into a single opaque MapLibre custom layer, so there is no way from
  // the outside to tell "rendering correctly" from "silently drawing nothing".
  if (import.meta.env.DEV) {
    (window as unknown as { __carOverlay?: MapboxOverlay }).__carOverlay = overlay;
  }
  return overlay;
}

export function updateCars3D(
  map: MapLibreMap,
  overlay: MapboxOverlay,
  cars: Car3D[],
  onCarClick?: (carId: string) => void,
): void {
  // Sub-pixel models: hand the view over to the circle layer entirely.
  if (map.getZoom() < MODEL_MIN_ZOOM) {
    if (!modelsClearedByMap.get(map)) {
      overlay.setProps({ layers: [] });
      modelsClearedByMap.set(map, true);
    }
    return;
  }
  modelsClearedByMap.set(map, false);

  // deck.gl positions are absolute metres, and it knows nothing about
  // MapLibre's terrain. With terrain off the world is drawn at z=0, so a car at
  // its true 600 m elevation would hang in the sky; with terrain on it has to
  // sit on the mesh, which getPosition below resolves per car.
  const terrainOn = Boolean(map.getTerrain());
  const sizeScale = carSizeScale(map);

  let terrainCache = terrainCacheByMap.get(map);
  if (!terrainCache) {
    terrainCache = new Map();
    terrainCacheByMap.set(map, terrainCache);
  }
  const cache = terrainCache;

  /** Terrain height under a car, re-sampled only when it has moved far enough
   * to matter (see TERRAIN_REQUERY_DISTANCE_M). */
  function terrainHeightFor(car: Car3D): number {
    const cached = cache.get(car.id);
    if (
      cached &&
      !cached.provisional &&
      roughMetresBetween(cached.lon, cached.lat, car.lon, car.lat) < TERRAIN_REQUERY_DISTANCE_M
    ) {
      return cached.z;
    }
    const queried = map.queryTerrainElevation([car.lon, car.lat]);
    const sample: TerrainSample = {
      lon: car.lon,
      lat: car.lat,
      z: queried ?? car.ele,
      provisional: queried === null || queried === undefined,
    };
    cache.set(car.id, sample);
    return sample.z;
  }

  const getPosition = (d: Car3D): [number, number, number] => {
    if (!terrainOn) return [d.lon, d.lat, 0];
    // Ask MapLibre where its own terrain mesh actually is, rather than
    // scaling the route's baked elevation. The two disagree: the route is
    // baked from SRTM via OpenTopoData, the terrain is Mapterhorn capped at
    // zoom 12, and any difference gets multiplied by the exaggeration —
    // enough to bury a car inside a hillside. Falls back to the baked
    // elevation before DEM tiles for that spot have loaded. Cached per
    // vehicle by distance travelled — see terrainHeightFor.
    return [d.lon, d.lat, terrainHeightFor(d)];
  };

  // M1: one layer per mesh, because a SimpleMeshLayer draws exactly one mesh.
  // Both are given the SAME sizeScale on purpose — the two meshes are modelled
  // at true metres (4.2 m car, 2.1 m bike), so sharing the multiplier is what
  // makes a motorcycle render half the length of a car instead of looming the
  // same size as one.
  const partition = (type: VehicleType): Car3D[] => cars.filter((c) => c.type === type);

  const layerFor = (id: string, mesh: typeof CAR_MESH, data: Car3D[]) =>
    new SimpleMeshLayer<Car3D>({
      id,
      data,
      mesh,
      // Makes the models themselves hit-testable. The circle layer still owns
      // click-to-select, but at chase zoom the circle is a 3 px dot under a
      // 4 m car, so the model is what the pointer is actually over.
      pickable: true,
      onClick: onCarClick ? (info) => (info.object ? onCarClick(info.object.id) : false) : undefined,
      sizeScale,
      getPosition,
      getOrientation,
      getColor,
      material: CAR_MATERIAL,
      // `data` is a fresh array each frame so attributes re-upload anyway;
      // this covers the case where the terrain toggle flips without the
      // positions themselves changing (paused race).
      updateTriggers: {
        getPosition: [terrainOn],
      },
    });

  overlay.setProps({
    layers: [
      layerFor(CARS_LAYER_ID, CAR_MESH, partition('car')),
      layerFor(BIKES_LAYER_ID, BIKE_MESH, partition('motorcycle')),
    ],
  });
}
