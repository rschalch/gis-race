import type { Map as MapLibreMap } from 'maplibre-gl';

/**
 * The follow-the-leader camera.
 *
 * Three behaviours live here, all of which exist because a rigid chase camera
 * behind a car on real terrain is genuinely unpleasant to watch:
 *
 * - **Bearing lags the car.** Locking the camera exactly behind the direction
 *   of travel means every corner swings the entire world around the screen.
 *   The bearing eases toward the road's heading instead, so the camera swings
 *   wide through a bend and settles after it, and a dead band stops the last
 *   degree of heading noise from producing constant micro-rotation.
 * - **Pitch gets out of its own way.** At a cinematic 75° the camera sits low
 *   and behind, which is exactly where a hillside goes when the road drops into
 *   a valley — the car disappears behind the terrain. The camera tests its own
 *   line of sight and rises (lower pitch) when something is in the way, sinking
 *   back down when the view is clear again.
 * - **The user keeps control of zoom.** Adjusting zoom while following must
 *   survive the per-frame camera update rather than being overwritten by it.
 */

/** Metres per pixel in Web Mercator at a given zoom and latitude. */
export function metresPerPixel(zoom: number, lat: number): number {
  return (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom;
}

/**
 * Ground distance from the map centre to the point directly beneath the camera,
 * and the camera's height above the centre — both in metres.
 *
 * MapLibre exposes no camera position in v5 (`getFreeCameraOptions` is Mapbox
 * only), so this reconstructs it from the view frustum: the camera sits far
 * enough back that the vertical field of view spans the viewport height at the
 * centre, then is swung up by `pitch` about that centre point.
 */
export function cameraOffset(
  zoom: number,
  lat: number,
  pitchDeg: number,
  viewportHeightPx: number,
  fovDeg: number,
): { groundDistanceM: number; heightM: number } {
  const fov = (fovDeg * Math.PI) / 180;
  const pitch = (pitchDeg * Math.PI) / 180;
  const cameraToCentrePx = (0.5 * viewportHeightPx) / Math.tan(fov / 2);
  const distanceM = cameraToCentrePx * metresPerPixel(zoom, lat);
  return {
    groundDistanceM: distanceM * Math.sin(pitch),
    heightM: distanceM * Math.cos(pitch),
  };
}

/** Moves a lon/lat by `distanceM` along a compass `bearingDeg`. */
export function offsetLngLat(
  lon: number,
  lat: number,
  bearingDeg: number,
  distanceM: number,
): [number, number] {
  const b = (bearingDeg * Math.PI) / 180;
  const dNorth = distanceM * Math.cos(b);
  const dEast = distanceM * Math.sin(b);
  const latOut = lat + dNorth / 111_320;
  const lonOut = lon + dEast / (111_320 * Math.cos((lat * Math.PI) / 180));
  return [lonOut, latOut];
}

/**
 * Whether terrain blocks the straight line from camera to car.
 *
 * `samples` are ground elevations at evenly spaced fractions along that line,
 * ordered camera → car and excluding both endpoints. The line of sight is
 * interpolated over the same span, so a sample is blocking when the ground
 * stands above the sightline by more than `clearanceM`.
 *
 * Pure and endpoint-driven so it can be tested without a map: the whole point
 * is the geometry, not the sampling.
 */
export function lineOfSightBlocked(
  cameraAltM: number,
  targetAltM: number,
  samples: number[],
  clearanceM: number,
): boolean {
  const n = samples.length;
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / (n + 1);
    const sightline = cameraAltM + (targetAltM - cameraAltM) * t;
    if (samples[i]! > sightline + clearanceM) return true;
  }
  return false;
}

/** Signed degrees from `from` to `to`, taking the short way around the circle. */
export function shortestAngleDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

// --- tuning -------------------------------------------------------------

/**
 * Bearing lag. Lower is smoother and swings wider through corners; the previous
 * 0.1 tracked the road tightly enough that the camera felt bolted to the car's
 * tail, which is what made switchbacks disorienting.
 */
const BEARING_EASING = 0.045;

/**
 * Heading changes below this are ignored outright. Route headings carry a
 * degree or so of noise even after headingAt's 75 m averaging, and easing
 * toward that noise is a constant sub-degree wobble — small, but it is the
 * component of the motion the eye locks onto on a straight.
 */
const BEARING_DEAD_BAND_DEG = 1.2;

/** Cinematic pitch when nothing is in the way. Above the ~71.6° horizon
 * threshold, so the sky stays in frame — see DEFAULT_FOLLOW_PITCH in map.ts. */
const CLEAR_PITCH = 75;

/** Highest the camera climbs (lowest pitch) to see over an obstruction. */
const BLOCKED_PITCH = 42;

/** Degrees per frame the pitch may move. Slow enough that terrain flicking in
 * and out of the sightline reads as a drift, not a jolt. */
const PITCH_STEP_DEG = 0.9;

/** Terrain samples between camera and car per occlusion test. */
const OCCLUSION_SAMPLES = 8;

/** Occlusion is retested every Nth frame: queryTerrainElevation costs ~0.09 ms
 * a call, terrain does not change between frames, and the pitch response is
 * rate-limited anyway. */
const OCCLUSION_TEST_INTERVAL = 5;

/** How far the sightline must clear the ground to count as unobstructed. */
const SIGHTLINE_CLEARANCE_M = 8;

interface ChaseState {
  bearing: number | null;
  pitch: number;
  frame: number;
  blocked: boolean;
  /** Cleared after the first frame, which is the only one that sets zoom. */
  needsInitialZoom: boolean;
}

const stateByMap = new WeakMap<MapLibreMap, ChaseState>();

/**
 * Maps whose zoom guard is installed. Kept separate from ChaseState because
 * resetChaseCamera drops the state on every follow re-entry, and re-running
 * map.on() each time would stack duplicate listeners for the life of the map.
 */
const zoomGuardInstalled = new WeakSet<MapLibreMap>();

/** Maps the user is actively zooming right now. */
const userZooming = new WeakSet<MapLibreMap>();

/**
 * Suspends the camera while the user zooms.
 *
 * `jumpTo` calls `stop()` internally, so a per-frame camera update cancels any
 * in-flight camera animation — and both the scroll wheel and the ± buttons zoom
 * by animation. The camera was therefore killing the user's zoom ~60 times a
 * second before it could advance a single frame: measured, wheel and button
 * both left zoom pinned at its starting value.
 *
 * The guard is safe because the camera no longer writes zoom itself, so a
 * zoomstart can only have come from the user.
 */
function installZoomGuard(map: MapLibreMap): void {
  if (zoomGuardInstalled.has(map)) return;
  zoomGuardInstalled.add(map);
  map.on('zoomstart', () => userZooming.add(map));
  map.on('zoomend', () => userZooming.delete(map));
}

function getState(map: MapLibreMap): ChaseState {
  installZoomGuard(map);
  let s = stateByMap.get(map);
  if (!s) {
    s = { bearing: null, pitch: CLEAR_PITCH, frame: 0, blocked: false, needsInitialZoom: true };
    stateByMap.set(map, s);
  }
  return s;
}

/** Drops eased state so the next update snaps — used when follow is (re)entered
 * or the followed car changes, where easing would sweep the world instead. */
export function resetChaseCamera(map: MapLibreMap): void {
  stateByMap.delete(map);
}

/**
 * Tests whether the car is visible from where the camera currently is, by
 * sampling MapLibre's own terrain between the two.
 *
 * Exported so it can be exercised against real terrain: the pure geometry is
 * unit-tested, but whether those numbers line up with MapLibre's actual DEM can
 * only be checked with a live map.
 */
export function isCarBlocked(map: MapLibreMap, lon: number, lat: number, bearing: number, pitch: number): boolean {
  if (!map.getTerrain()) return false; // flat world — nothing to hide behind

  const carGround = map.queryTerrainElevation([lon, lat]);
  if (carGround === null) return false;

  const { groundDistanceM, heightM } = cameraOffset(
    map.getZoom(),
    lat,
    pitch,
    map.getCanvas().clientHeight,
    map.getVerticalFieldOfView(),
  );

  // The camera sits behind the car, opposite the way it is facing.
  const [camLon, camLat] = offsetLngLat(lon, lat, bearing + 180, groundDistanceM);
  const camGround = map.queryTerrainElevation([camLon, camLat]) ?? carGround;
  const cameraAlt = camGround + heightM;

  const samples: number[] = [];
  for (let i = 1; i <= OCCLUSION_SAMPLES; i++) {
    const t = i / (OCCLUSION_SAMPLES + 1);
    const sLon = camLon + (lon - camLon) * t;
    const sLat = camLat + (lat - camLat) * t;
    samples.push(map.queryTerrainElevation([sLon, sLat]) ?? carGround);
  }

  return lineOfSightBlocked(cameraAlt, carGround, samples, SIGHTLINE_CLEARANCE_M);
}

/**
 * Positions the camera for one frame of follow mode.
 *
 * Zoom is applied on the first frame of a follow and then never again. Writing
 * it every frame is what made zooming impossible while following: `jumpTo`
 * stops any in-flight camera animation, so each frame cancelled the smooth
 * zoom the wheel or the ± buttons had just started, and re-asserted the old
 * value. Measured before the fix — wheel and button both left zoom pinned at
 * 14. Leaving zoom out of the per-frame update hands it back to the user.
 */
export function updateChaseCamera(
  map: MapLibreMap,
  lon: number,
  lat: number,
  heading: number,
  zoom: number,
): void {
  const state = getState(map);

  // --- bearing: ease toward the road, ignoring sub-dead-band noise ---
  if (state.bearing === null) {
    state.bearing = heading; // first frame snaps; easing from a stale bearing spins the world
  } else {
    const delta = shortestAngleDelta(state.bearing, heading);
    if (Math.abs(delta) > BEARING_DEAD_BAND_DEG) {
      state.bearing += delta * BEARING_EASING;
    }
  }

  // --- pitch: rise over obstructions, sink back when clear ---
  state.frame++;
  if (state.frame % OCCLUSION_TEST_INTERVAL === 0) {
    state.blocked = isCarBlocked(map, lon, lat, state.bearing, state.pitch);
  }
  const targetPitch = state.blocked ? BLOCKED_PITCH : CLEAR_PITCH;
  const pitchDelta = targetPitch - state.pitch;
  state.pitch += Math.sign(pitchDelta) * Math.min(Math.abs(pitchDelta), PITCH_STEP_DEG);

  // Stand down entirely mid-gesture: even a zoom-less jumpTo would stop() the
  // user's zoom animation. The car keeps moving for those few hundred
  // milliseconds and the camera catches up afterwards, which is far less
  // jarring than a zoom control that silently does nothing.
  if (userZooming.has(map)) return;

  if (state.needsInitialZoom) {
    state.needsInitialZoom = false;
    map.jumpTo({ center: [lon, lat], zoom, pitch: state.pitch, bearing: state.bearing });
    return;
  }
  map.jumpTo({ center: [lon, lat], pitch: state.pitch, bearing: state.bearing });
}
