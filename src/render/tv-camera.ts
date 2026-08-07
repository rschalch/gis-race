import type { Map as MapLibreMap } from 'maplibre-gl';

/**
 * TV-director camera.
 *
 * The chase camera answers "what does the driver see". This answers "what would
 * a broadcast look like", which is a different question: a race on television is
 * a sequence of *shots*, and what makes it read as coverage rather than
 * telemetry is that the angle changes and then holds.
 *
 * So this cuts. Every few seconds it picks the next shot from a fixed cycle —
 * a bearing offset from the car's direction of travel, a pitch and a zoom — and
 * holds that framing while the car drives through it. Because the bearing is
 * captured *at the cut* and then frozen, the world stops rotating with the car:
 * the camera tracks alongside like a helicopter or a long lens on a stand, instead
 * of swinging round every corner the way the chase camera does.
 *
 * The cycle is fixed rather than random. A race is watched more than once (same
 * seed, replay), and a shot list that reshuffles on every viewing makes two
 * runs of the same race incomparable — the same reason the simulation itself
 * never calls Math.random.
 */

export interface TvShot {
  /** Degrees added to the car's heading at the moment of the cut. 0 looks
   * along the road from behind; ±90 is side-on; 180 is head-on. */
  bearingOffset: number;
  pitch: number;
  /** Added to the follow zoom, so a preset that pulls back pulls every shot
   * back with it. */
  zoomDelta: number;
  /** Seconds this shot holds before the director cuts away. */
  holdS: number;
}

/**
 * The shot list. Ordered to alternate near and far, and to avoid two
 * consecutive shots from the same side — a cut between similar framings reads
 * as a glitch rather than an edit.
 */
const SHOTS: readonly TvShot[] = [
  { bearingOffset: 0, pitch: 72, zoomDelta: 0.4, holdS: 7 }, // low chase
  { bearingOffset: 78, pitch: 62, zoomDelta: 0.2, holdS: 6 }, // side-on, tracking
  { bearingOffset: 200, pitch: 68, zoomDelta: 0.6, holdS: 5 }, // ahead, looking back
  { bearingOffset: -70, pitch: 55, zoomDelta: -0.6, holdS: 7 }, // wide, other side
  { bearingOffset: 25, pitch: 78, zoomDelta: 0.8, holdS: 5 }, // tight three-quarter
  { bearingOffset: -140, pitch: 45, zoomDelta: -1.2, holdS: 8 }, // high and wide
];

interface TvState {
  shotIndex: number;
  /** Wall-clock ms at which the current shot started. */
  startedAt: number;
  /** World bearing frozen at the cut — see the note above. */
  bearing: number;
}

const stateByMap = new WeakMap<MapLibreMap, TvState>();

/** Drops the shot state so the next update cuts immediately, used when TV mode
 * is entered or the followed car changes. */
export function resetTvCamera(map: MapLibreMap): void {
  stateByMap.delete(map);
}

/** Exposed for tests: which shot a given elapsed time lands on. */
export function shotAt(index: number): TvShot {
  return SHOTS[((index % SHOTS.length) + SHOTS.length) % SHOTS.length]!;
}

export function shotCount(): number {
  return SHOTS.length;
}

/**
 * Positions the camera for one frame of TV mode.
 *
 * `now` is passed in rather than read here so the caller controls the clock —
 * the frame loop already has the animation timestamp, and a camera that reads
 * its own wall clock is untestable.
 */
export function updateTvCamera(
  map: MapLibreMap,
  lon: number,
  lat: number,
  heading: number,
  zoom: number,
  now: number,
): void {
  let state = stateByMap.get(map);
  if (!state) {
    state = { shotIndex: 0, startedAt: now, bearing: heading + shotAt(0).bearingOffset };
    stateByMap.set(map, state);
  }

  const shot = shotAt(state.shotIndex);
  if (now - state.startedAt >= shot.holdS * 1000) {
    state.shotIndex += 1;
    state.startedAt = now;
    // The new bearing is captured once, from the car's heading at the cut, and
    // then held for the whole shot.
    state.bearing = heading + shotAt(state.shotIndex).bearingOffset;
  }

  const active = shotAt(state.shotIndex);
  map.jumpTo({
    center: [lon, lat],
    zoom: zoom + active.zoomDelta,
    pitch: active.pitch,
    bearing: state.bearing,
  });
}
