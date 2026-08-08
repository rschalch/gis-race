import type { CarSpec, CarState, CarStatus, Incident, RaceEvent, Route, Weather, WindPreset } from './types';
import { computeAcceleration } from './physics';
import { interpolateAt, radiusAt, pointBearingsRad } from './route';
import { computeSpeedProfile, driverControl, evaluateLossOfControl, brakeFadeFactor } from './driver';
import { mulberry32 } from './rng';
import {
  DRAFT_MAX_GAP_M,
  DRAFT_MIN_FACTOR,
  BLOCK_GAP_M,
  BLOCK_MIN_GAP_M,
  BLOCK_FOLLOW_FACTOR,
  PASS_MIN_RADIUS_M,
  PASS_PATIENCE_S,
  PASS_COMMIT_RATE_PER_S,
  PASS_DURATION_S,
  OVERTAKE_COOLDOWN_S,
  CAUTION_DURATION_S,
  CAUTION_AHEAD_M,
  CAUTION_BEHIND_M,
  CAUTION_SPEED,
  WEATHER_GRIP,
  ENGINE_VERSION,
  TIRE_WEAR_BASE_PER_M,
  TIRE_WEAR_LOAD_PER_M,
  TIRE_WEAR_MOTORCYCLE_MULT,
  TIRE_WEAR_MAX_GRIP_LOSS,
  RELIABILITY_BASE_PER_S,
  RELIABILITY_LOAD_PER_S,
  MECHANICAL_COAST_BRAKE,
  ENGINE_LOAD_TAU_S,
  ENGINE_LOAD_NEUTRAL,
  ENGINE_STRESS_MULT,
  BRAKE_HEAT_TAU_S,
  BRAKE_HEAT_SPEED_REF,
  WIND_PRESET_SPEED,
} from './tuning';

const DT = 1 / 60;

/** F1: one car assigned to one route — cars can be on different alternatives
 * of the same course, or (today) all on the same single route. */
export interface CarAssignment {
  spec: CarSpec;
  route: Route;
}

/** §0.3 (Phase 2): start-of-step snapshot of a car's state, captured once
 * per DT step before any car that step is advanced. Once cars can see each
 * other (R4/R5/R6), a car stepped later in roster order would otherwise
 * read a mixture of this-step and last-step positions for other cars,
 * making results depend on roster order — every cross-car read goes through
 * this snapshot instead of a live `CarState`. */
export interface CarSnapshot {
  carId: string;
  route: Route;
  s: number;
  v: number;
  status: CarStatus;
}

/** R6: a recent loss-of-control site, active for CAUTION_DURATION_S before
 * marshals clear it. */
interface Hazard {
  route: Route;
  s: number;
  until: number; // simTime after which this hazard no longer applies
}

/** Owns all car states and steps the world. */
export interface Sim {
  cars: CarState[];
  simTime: number;
  accumulator: number;
  timeScale: number;
  paused: boolean;
  raceOver: boolean;
  // §0.1: retained (not just consumed to derive per-car seeds and
  // discarded) so a future summary/replay/share feature has the seed to
  // show — paired with engineVersion so a mismatched replay can be
  // detected instead of silently playing a different race.
  raceSeed: number;
  engineVersion: number;
  // F4: append-only log, written here, read incrementally by the UI and
  // available afterward (summary screen, replay seed + event list).
  events: RaceEvent[];
  // Fires synchronously whenever a car triggers a loss-of-control event
  // (§7.5). Replaces a `console.log` gated on `import.meta.env?.DEV` that
  // used to live in driver.ts (R5) — that coupled otherwise-pure simulation
  // code to the bundler and gave Node-based diagnostic scripts nothing to
  // hook. The UI incident feed (B10) consumes this the same way.
  onIncident?: (car: CarState, incident: Incident) => void;
  // §0.3: preallocated, reused every DT step — one entry per car, indices
  // matching `cars`. Populated at the start of each step, before any car
  // that step reads another's state.
  snapshot: CarSnapshot[];
  // R6: active hazards, pruned once per DT step (not per car).
  hazards: Hazard[];
  // R5: last simTime an 'overtake' fired for each unordered car-id pair,
  // keyed "idA|idB" (lexically sorted) — debounces the noise-driven
  // back-and-forth that two near-identically-paced cars produce (verified
  // empirically at ~2 swaps/second between two closely matched cars before
  // this existed).
  overtakeCooldowns: Map<string, number>;
  // R7: race-level condition, fixed for the whole race — see tuning.ts's
  // WEATHER_GRIP/WEATHER_ERROR_MULT.
  weather: Weather;
  /**
   * Seconds every car waits at a there-and-back course's turnaround
   * (`route.turnaroundS`). A race setting rather than baked into the route, so
   * it can be changed without re-baking — a bake is minutes of rate-limited
   * elevation fetching, and "how long is the stop" is exactly the kind of
   * thing worth trying three values of.
   *
   * 0, and on a one-way route, means nothing happens at all.
   */
  turnaroundPauseS: number;
  /** R16: race-level wind — the preset the race was configured with, its
   * speed in m/s, and the compass direction (radians) drawn from the race
   * seed. One vector for the whole race; the road turns under it. */
  wind: WindPreset;
  windSpeed: number;
  windDirRad: number;
  /** R16: per-route, per-point tailwind component (m/s, positive = pushing)
   * — windSpeed × cos(dir − bearing), precomputed once at createSim so the
   * per-step cost is one array read, like the speed profile. */
  windAlongByRoute: Map<Route, Float64Array>;
}

// FNV-1a — cheap, well-distributed string hash.
function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Deterministic per-car seed derivation from a single race seed, so a race
// seed alone reproduces byte-identical results (AC#12) without cars sharing
// a PRNG stream. Keyed by the car's own id rather than its roster index (R6)
// — index-based seeding meant the same car with the same race seed behaved
// differently whenever the selected roster changed shape (its index shifts),
// which silently reshuffles every car's noise stream on a roster edit.
function deriveCarSeed(raceSeed: number, carId: string): number {
  let h = (raceSeed ^ hashString(carId)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  return (h ^ (h >>> 16)) >>> 0;
}

/** R16: the race's wind direction (radians, same compass convention as
 * pointBearingsRad), drawn from a throwaway PRNG stream keyed off the race
 * seed — deliberately NOT car.rng (§0.1: it would shift every car's draw
 * stream) and not an extra config knob (a direction picker is more UI than
 * the feature is worth; reroll the seed, reroll the wind). Exported for
 * tests. */
export function windDirectionRad(raceSeed: number): number {
  return mulberry32((raceSeed ^ 0x77696e64) >>> 0)() * 2 * Math.PI; // 0x77696e64 = 'wind'
}

export function createSim(
  assignments: CarAssignment[],
  raceSeed = 1,
  globalCapEnabled = true,
  weather: Weather = 'dry',
  // Defaults to 0 (mass start) rather than START_INTERVAL_S: the race format
  // is the application's choice, not something the engine should impose on
  // every caller. main.ts passes the configured value; unit tests that place
  // cars relative to each other get an unstaggered field for free.
  startIntervalS = 0,
  turnaroundPauseS = 0,
  wind: WindPreset = 'calm',
): Sim {
  const cars: CarState[] = assignments.map(({ spec, route }, index) => {
    const seed = deriveCarSeed(raceSeed, spec.id);
    // Release order is roster order — the order the config panel produced,
    // which is the only ordering the sim is given. Deliberately NOT derived
    // from the rng: a start order that reshuffles on reseed would make two
    // runs of the same roster incomparable for no gain.
    const startDelay = index * startIntervalS;
    return {
      spec,
      route,
      s: 0,
      v: 0,
      throttle: 0,
      brake: 0,
      status: startDelay > 0 ? 'staged' : 'racing',
      recoveryRemaining: 0,
      incidents: [],
      startDelay,
      heldUpFor: 0,
      passRemaining: 0,
      finishTime: null,
      speedProfile: computeSpeedProfile(route, spec, globalCapEnabled, weather),
      rng: mulberry32(seed),
      seed,
      tireWear: 0,
      engineLoad: 0,
      brakeHeat: 0,
      condition: { grip: 1, cdA: 1 },
      pauseRemaining: 0,
      turnaroundTaken: false,
    };
  });

  // §0.3: one snapshot slot per car, reused for the sim's lifetime — see the
  // per-step population in `tick`.
  const snapshot: CarSnapshot[] = cars.map((car) => ({
    carId: car.spec.id,
    route: car.route,
    s: car.s,
    v: car.v,
    status: car.status,
  }));

  // R16: one wind vector per race, projected onto each distinct route's
  // per-point bearings once — stepCar then pays one array read per step.
  const windSpeed = WIND_PRESET_SPEED[wind];
  const windDirRad = windDirectionRad(raceSeed);
  const windAlongByRoute = new Map<Route, Float64Array>();
  if (windSpeed > 0) {
    for (const { route } of assignments) {
      if (windAlongByRoute.has(route)) continue;
      const bearings = pointBearingsRad(route);
      const along = new Float64Array(bearings.length);
      for (let i = 0; i < bearings.length; i++) along[i] = windSpeed * Math.cos(windDirRad - bearings[i]!);
      windAlongByRoute.set(route, along);
    }
  }

  return {
    cars,
    simTime: 0,
    accumulator: 0,
    timeScale: 1,
    paused: false,
    raceOver: false,
    raceSeed,
    engineVersion: ENGINE_VERSION,
    events: [],
    snapshot,
    hazards: [],
    overtakeCooldowns: new Map(),
    weather,
    turnaroundPauseS,
    wind,
    windSpeed,
    windDirRad,
    windAlongByRoute,
  };
}

/** F1: `s` isn't comparable across cars on different routes — remaining
 * distance to each car's own finish line is. */
export function remainingDistance(car: CarState): number {
  return car.route.totalDistance - car.s;
}

/** Simulated seconds this car has been running: race clock minus its own
 * interval-start delay. Zero while staged. */
export function runningTime(car: CarState, simTime: number): number {
  return Math.max(0, simTime - car.startDelay);
}

/**
 * The score cars are *ranked* on: projected own-running-time for the full
 * route, in seconds. Lower is better.
 *
 * Under an interval start, position on the road is not position in the race —
 * a car two minutes up the road may simply have left the line two minutes
 * earlier. What decides a point-to-point road race is each car's own elapsed
 * time, so ranking extrapolates the time it has taken so far over the
 * distance it still has to cover. Finished cars score their actual time, so
 * they can never be displaced by an extrapolation.
 *
 * A finished car always outranks an unfinished one, and a car still at the
 * line (or retired, whose distance has stopped updating) scores Infinity.
 * Early-race extrapolations from a few hundred metres are noisy for the first
 * minute or so and then settle; that is inherent to any live rally timing
 * that isn't split-based, and the alternative — ranking by road position —
 * is not noisy, just wrong.
 */
export function projectedTime(car: CarState, simTime: number): number {
  if (car.status === 'finished' && car.finishTime !== null) return car.finishTime;
  if (car.status === 'retired' || car.status === 'staged') return Infinity;
  if (car.s <= 0) return Infinity;
  return runningTime(car, simTime) * (car.route.totalDistance / car.s);
}

/**
 * Field ordered best-to-worst by `projectedTime`, ties broken by distance
 * covered so the ordering is total and stable.
 */
export function raceRank(cars: CarState[], simTime: number): CarState[] {
  // Decorate-sort-undecorate. The obvious version calls projectedTime from
  // inside the comparator, which recomputes the same car's key O(log n) times
  // per sort — and this is on the render path, called for every HUD tick.
  const keyed = cars.map((car) => ({
    car,
    time: projectedTime(car, simTime),
    remaining: remainingDistance(car),
  }));
  keyed.sort((a, b) => (a.time !== b.time ? a.time - b.time : a.remaining - b.remaining));
  return keyed.map((k) => k.car);
}

// A retired (crashed-out) car should never be "the leader" — its distance
// stops updating, so it would otherwise stay P1/camera target forever.
// Finished cars still count: they're ahead by definition until every other
// car finishes too. Falls back to the overall best-ranked car only if every
// car has retired (no non-retired car exists to lead).
export function resolveLeader(cars: CarState[], simTime: number): CarState {
  // Only the best-ranked car is wanted, so this is a linear min-scan rather
  // than raceRank's sort — it runs once per animation frame while the camera
  // follows the leader, and previously allocated two arrays and sorted the
  // whole field to read one element. The ordering rule is raceRank's exactly,
  // including its tie-break and (via strict `<`) a stable sort's "earliest in
  // input order wins" among fully equal cars.
  const anyActive = cars.some((c) => c.status !== 'retired');
  let best: CarState | null = null;
  let bestTime = Infinity;
  let bestRemaining = Infinity;
  for (const car of cars) {
    if (anyActive && car.status === 'retired') continue;
    const time = projectedTime(car, simTime);
    const remaining = remainingDistance(car);
    if (best === null || time < bestTime || (time === bestTime && remaining < bestRemaining)) {
      best = car;
      bestTime = time;
      bestRemaining = remaining;
    }
  }
  return best!;
}

const DRAFT_STATUSES: readonly CarStatus[] = ['racing'];
const BLOCK_STATUSES: readonly CarStatus[] = ['racing', 'spinning'];

// R4/R5: nearest same-route car ahead (by the start-of-step snapshot) whose
// status is one of `statuses`, strictly within `maxGap` metres. Linear scan
// over the snapshot — cars-per-route is small (≤ ~14 today), so no spatial
// index.
function nearestAhead(
  snapshot: CarSnapshot[],
  selfIndex: number,
  route: Route,
  s: number,
  maxGap: number,
  statuses: readonly CarStatus[],
): CarSnapshot | undefined {
  let nearest: CarSnapshot | undefined;
  let nearestGap = Infinity;
  for (let i = 0; i < snapshot.length; i++) {
    if (i === selfIndex) continue;
    const other = snapshot[i]!;
    if (other.route !== route) continue;
    if (!statuses.includes(other.status)) continue;
    const gap = other.s - s;
    if (gap <= 0 || gap >= maxGap) continue;
    if (gap < nearestGap) {
      nearestGap = gap;
      nearest = other;
    }
  }
  return nearest;
}

// R6: does an active hazard on this route lie within the caution window
// around s (CAUTION_AHEAD_M ahead or CAUTION_BEHIND_M behind)?
function cautionCapAt(hazards: Hazard[], route: Route, s: number): number | undefined {
  for (const hazard of hazards) {
    if (hazard.route !== route) continue;
    if (hazard.s >= s - CAUTION_BEHIND_M && hazard.s <= s + CAUTION_AHEAD_M) return CAUTION_SPEED;
  }
  return undefined;
}

/** Per-DT-step context threaded into stepCar — allocated once per `tick()`
 * call and reused across cars and steps (only `.index` changes), matching
 * the existing per-frame garbage-consciousness (see the onCarIncident
 * closure in `tick`). */
interface StepContext {
  index: number;
  snapshot: CarSnapshot[];
  hazards: Hazard[];
  events: RaceEvent[];
  overtakeCooldowns: Map<string, number>;
  weather: Weather;
  turnaroundPauseS: number;
  windAlongByRoute: Map<Route, Float64Array>; // R16: empty map when calm
  onIncident?: (car: CarState, incident: Incident) => void;
}

function overtakePairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

// R13: hazard rate for mechanical failure — exported for direct testing of
// the analytic law (§0.4-style: expected failures over N draws vs. this
// formula), separate from the Monte-Carlo full-race batch check.
// R15: the load term scales with smoothed engine load — a machine held near
// wide open for minutes on end is progressively more likely to let go than
// one that just opened up. No penalty at or below ENGINE_LOAD_NEUTRAL.
export function reliabilityHazardRate(throttle: number, engineLoad: number): number {
  const stress = Math.max(0, engineLoad - ENGINE_LOAD_NEUTRAL) / (1 - ENGINE_LOAD_NEUTRAL);
  return RELIABILITY_BASE_PER_S + RELIABILITY_LOAD_PER_S * throttle * (1 + ENGINE_STRESS_MULT * stress);
}

// R13: a mechanically-retired car that hasn't yet reached v=0 keeps
// decelerating each step — a fixed, moderate brake, no throttle — until it
// rolls to a stop rather than teleport-stopping the way an off-road crash
// does (which zeroes v immediately in triggerIncident; only a mechanical
// retirement can have v>0 while status is already 'retired').
function coastToStop(car: CarState, dt: number): void {
  const { grade } = interpolateAt(car.route, car.s);
  const { a } = computeAcceleration({ spec: car.spec, v: car.v, grade, throttle: 0, brake: MECHANICAL_COAST_BRAKE });
  car.v = Math.max(0, car.v + a * dt);
  car.s = car.s + car.v * dt;
  car.throttle = 0;
  car.brake = MECHANICAL_COAST_BRAKE;
}

function stepCar(car: CarState, simTime: number, dt: number, ctx: StepContext): void {
  if (car.status === 'finished') return;

  // Interval start: sit at the line until this car's release time. Checked
  // before every other branch so a staged car runs no physics, draws no
  // hazard, and cannot be drafted or blocked against (its status is excluded
  // from DRAFT_STATUSES/BLOCK_STATUSES for the same reason).
  if (car.status === 'staged') {
    if (simTime < car.startDelay) return;
    car.status = 'racing';
    ctx.events.push({ time: simTime, type: 'start', carId: car.spec.id });
    // Fall through: the car is away this step, no step wasted at the line.
  }

  if (car.status === 'retired') {
    if (car.v === 0) return;
    coastToStop(car, dt);
    return;
  }

  if (car.status === 'paused') {
    // No physics at all: the car is stationary at the turnaround by
    // arrangement, not by dynamics.
    car.pauseRemaining = Math.max(0, car.pauseRemaining - dt);
    if (car.pauseRemaining === 0) {
      car.status = 'racing';
      car.v = 0;
    }
    return;
  }

  if (car.status === 'spinning') {
    // §7.5 Step 5: skip physics entirely while spinning.
    car.recoveryRemaining = Math.max(0, car.recoveryRemaining - dt);
    if (car.recoveryRemaining === 0) {
      car.status = 'racing';
      car.v = 0;
    }
    return;
  }

  // The scheduled stop at a there-and-back turnaround. Checked before this
  // step's physics so the car halts *at* the mark rather than a step past it,
  // and gated on `turnaroundTaken` because `s` stays beyond the mark for the
  // whole return leg.
  if (
    car.route.turnaroundS !== undefined &&
    !car.turnaroundTaken &&
    car.s >= car.route.turnaroundS &&
    ctx.turnaroundPauseS > 0
  ) {
    car.turnaroundTaken = true;
    car.status = 'paused';
    car.v = 0;
    car.throttle = 0;
    car.brake = 0;
    car.pauseRemaining = ctx.turnaroundPauseS;
    ctx.events.push({ time: simTime, type: 'turnaround', carId: car.spec.id, data: { pauseS: ctx.turnaroundPauseS } });
    return;
  }

  const throttleLockedOut = car.recoveryRemaining > 0; // post-slide "2s of no throttle"
  if (throttleLockedOut) {
    car.recoveryRemaining = Math.max(0, car.recoveryRemaining - dt);
  }

  // R11/R12: this car's own condition — wear-derived grip loss composes
  // with R12's permanent post-incident damage into one factor, read by
  // driverControl (for its sqrt-scaled target adaptation) and the physics
  // gripMultiplier below identically.
  const gripFromWear = 1 - TIRE_WEAR_MAX_GRIP_LOSS * car.tireWear;
  const conditionGrip = car.condition.grip * gripFromWear;

  // R6: cars near a fresh wreck on their own route lift, on top of whatever
  // R1's lookahead (which only reasons about the speed profile, not the
  // world) would otherwise command.
  const speedCap = cautionCapAt(ctx.hazards, car.route, car.s);
  // R19: the controller and physics read the same faded-brake factor,
  // computed from start-of-step heat (one-step lag, deterministic).
  const brakeFade = brakeFadeFactor(car.brakeHeat);
  const { throttle, brake } = driverControl(
    car.speedProfile,
    car.route,
    car.s,
    car.v,
    car.spec,
    car.seed,
    ctx.weather,
    speedCap,
    conditionGrip,
    brakeFade,
  );
  car.throttle = throttleLockedOut ? 0 : throttle;
  car.brake = brake;

  // R15: smoothed engine load, updated from this step's commanded throttle
  // before the reliability draw reads it. Pure state, no rng — safe here
  // without disturbing the §0.1 draw layout.
  car.engineLoad += ((car.throttle - car.engineLoad) * dt) / ENGINE_LOAD_TAU_S;
  // R19: brake heat — energy in scales with pedal × speed (a stop from
  // motorway speed heats what a town stop does not).
  const brakeEnergySignal = car.brake * Math.min(1, car.v / BRAKE_HEAT_SPEED_REF);
  car.brakeHeat += ((brakeEnergySignal - car.brakeHeat) * dt) / BRAKE_HEAT_TAU_S;

  // R13: mechanical reliability — drawn every step, unconditionally, for
  // every currently-racing car regardless of throttle magnitude (§0.1: an
  // unconditional draw keeps the rng stream layout stable regardless of
  // throttle history). On failure, override this step's own throttle/brake
  // so the physics below already reflects a dead engine + easing off,
  // rather than needing a separate code path for the first failed step.
  const hazardRate = reliabilityHazardRate(car.throttle, car.engineLoad);
  const pFailureThisStep = 1 - Math.exp(-hazardRate * dt);
  const mechanicalFailure = car.rng() < pFailureThisStep;

  // R5: the overtake-commitment draw, taken here — unconditionally, for every
  // racing car, immediately after the reliability draw — for the same §0.1
  // reason that one is unconditional. Whether the car is actually behind
  // anyone depends on float comparisons against gap thresholds; gating the
  // *draw* on those would let a last-ulp difference shift every subsequent
  // draw in the stream. Gating only the *use* of an already-drawn value is
  // safe, because the stream layout no longer depends on the outcome.
  const passDraw = car.rng();
  if (mechanicalFailure) {
    car.throttle = 0;
    car.brake = MECHANICAL_COAST_BRAKE;
  }

  // R4: reduced aero drag when closely following another racing car on the
  // same route (route reference equality — variants of a course are
  // different roads). Start-of-step snapshot only (§0.3), so drafting never
  // depends on roster processing order.
  const draftLeader = nearestAhead(ctx.snapshot, ctx.index, car.route, car.s, DRAFT_MAX_GAP_M, DRAFT_STATUSES);
  const dragFactor = draftLeader
    ? DRAFT_MIN_FACTOR + (1 - DRAFT_MIN_FACTOR) * ((draftLeader.s - car.s) / DRAFT_MAX_GAP_M)
    : 1;

  const { grade, ele, surface } = interpolateAt(car.route, car.s);
  // R16: tailwind component at this point of road (0 in calm races, where
  // the map is empty). Piecewise-constant per 25 m point — wind does not
  // need interpolation.
  const windAlongArr = ctx.windAlongByRoute.get(car.route);
  const windAlongHere = windAlongArr
    ? windAlongArr[Math.min(Math.floor(car.s / car.route.spacing), windAlongArr.length - 1)]!
    : 0;
  // R7/R8/R11/R12: weather × surface × condition grip scalar, same one
  // driverControl/evaluateLossOfControl use — plan, runtime, and crash
  // check all read off the same effective grip.
  const gripMultiplier = WEATHER_GRIP[ctx.weather] * surface * conditionGrip;
  const { a, aTire } = computeAcceleration({
    spec: car.spec,
    v: car.v,
    grade,
    throttle: car.throttle,
    brake: car.brake,
    dragFactor,
    ele,
    gripMultiplier,
    conditionCdA: car.condition.cdA,
    surface,
    engineLoad: car.engineLoad,
    brakeFade,
    windAlong: windAlongHere,
  });

  // §6.2: semi-implicit Euler — update v first, then s.
  car.v = Math.max(0, Math.min(car.v + a * dt, car.spec.vMax));

  // R5: blocking and overtaking — a slower same-route car ahead caps closing
  // speed unless the road opens up, or the driver commits to going around.
  // Deliberately between the v-update and the s-update, so the clamp affects
  // this step's distance travelled, not next step's. A spinning leader (off
  // at the roadside) is never blocked against — only tracked so the overtake
  // event below still fires for it.
  const blockLeader = nearestAhead(ctx.snapshot, ctx.index, car.route, car.s, BLOCK_GAP_M, BLOCK_STATUSES);

  if (car.passRemaining > 0) {
    // Mid-pass: committed, alongside, and explicitly NOT speed-capped by the
    // car being passed. The cost of being here is paid in the friction circle
    // (PASS_LINE_PENALTY, applied in evaluateLossOfControl), not in speed.
    car.passRemaining = Math.max(0, car.passRemaining - dt);
  } else if (blockLeader && blockLeader.status === 'racing') {
    const radius = radiusAt(car.route, car.s);
    // How fast this car WANTS to be going here — read off its own frozen
    // speed profile, not its current v. Using v would be self-defeating: the
    // blocking clamp below pins the follower to 0.98x the leader's speed, so
    // one step later it measures as *slower* than the car holding it up,
    // patience resets, and no driver ever becomes impatient enough to try
    // anything. (That is exactly what happened — heldUpFor oscillated between
    // 0 and one step's worth of dt for an entire race.)
    const profileIdx = Math.min(Math.floor(car.s / car.route.spacing), car.speedProfile.length - 1);
    const desiredSpeed = car.speedProfile[profileIdx]!;
    if (radius > PASS_MIN_RADIUS_M || desiredSpeed <= blockLeader.v) {
      // Road wide open (just drive by, unchanged), or the car ahead is not
      // actually in the way — either way there is nothing to be patient about.
      car.heldUpFor = 0;
    } else {
      car.heldUpFor += dt;
      // Impatience builds before anything is attempted: a driver who has been
      // behind for a moment is still assessing, not lunging.
      if (car.heldUpFor >= PASS_PATIENCE_S) {
        // Two things make a driver go: a clear speed advantage, and road
        // that is at least somewhat open. `openness` is 0 at a hairpin and 1
        // at the free-pass threshold, so commitment tails off to nothing in
        // the tightest corners rather than stopping at a hard edge.
        // Squared, not linear: linear openness made even a hairpin passable
        // inside ~20 s of following, which is not what a hairpin is. Squaring
        // keeps commitment quick just below the free-pass threshold (radius
        // 300 -> ~2 s of patience) and vanishingly rare in genuinely tight
        // corners (radius 30 -> minutes), without a second hard cutoff.
        const openness = Math.min(1, Math.max(0, radius / PASS_MIN_RADIUS_M)) ** 2;
        // Ramped to full effect by a 10% speed advantage: a car barely faster
        // than the one ahead has no reason to risk anything. Measured against
        // desiredSpeed for the same reason as above.
        const speedAdvantage = (desiredSpeed - blockLeader.v) / Math.max(blockLeader.v, 1);
        const rate = PASS_COMMIT_RATE_PER_S * openness * Math.min(1, speedAdvantage / 0.1);
        if (passDraw < 1 - Math.exp(-Math.max(0, rate) * dt)) {
          car.passRemaining = PASS_DURATION_S;
          car.heldUpFor = 0;
        }
      }
    }
    // The gap clamp reads *actual* speeds, outside the patience gate above:
    // desiredSpeed can sit at or below the leader's v (profile noise, the
    // leader briefly accelerating, braking down from a faster section) while
    // the follower still carries more real speed — patience should reset
    // then, but on road too tight to pass the car must not close through
    // BLOCK_MIN_GAP_M and drive over the one ahead.
    if (radius <= PASS_MIN_RADIUS_M && car.passRemaining === 0 && blockLeader.v < car.v) {
      const projectedGap = blockLeader.s - (car.s + car.v * dt);
      if (projectedGap < BLOCK_MIN_GAP_M) {
        car.v = blockLeader.v * BLOCK_FOLLOW_FACTOR;
      }
    }
  } else {
    car.heldUpFor = 0;
  }

  const sBeforeStep = car.s;
  car.s = car.s + car.v * dt;

  // R5: overtake — the step the follower's s passes the tracked leader's
  // (start-of-step) s. Debounced per pair (OVERTAKE_COOLDOWN_S): two cars
  // within a percent or two of each other's pace can otherwise trade the
  // lead multiple times a second purely from §7.4 noise — logging every
  // flip floods the event log with what is not a real racing event.
  if (blockLeader && sBeforeStep <= blockLeader.s && car.s > blockLeader.s) {
    const pairKey = overtakePairKey(car.spec.id, blockLeader.carId);
    const lastFired = ctx.overtakeCooldowns.get(pairKey) ?? -Infinity;
    if (simTime - lastFired >= OVERTAKE_COOLDOWN_S) {
      ctx.overtakeCooldowns.set(pairKey, simTime);
      ctx.events.push({ time: simTime, type: 'overtake', carId: car.spec.id, data: { passedId: blockLeader.carId } });
    }
  }

  if (car.s >= car.route.totalDistance) {
    car.s = car.route.totalDistance;
    car.status = 'finished';
    // Own running time, not absolute race clock — under an interval start a
    // late starter's absolute finish is later by construction, and scoring on
    // it would hand the win to whoever left the line first.
    car.finishTime = simTime - car.startDelay;
    ctx.events.push({ time: simTime, type: 'finish', carId: car.spec.id });
    return;
  }

  // R13: finalize a mechanical failure rolled above — status flips to
  // 'retired' now, but v is deliberately NOT zeroed (unlike an off-road
  // crash): the car already coasted/braked normally this step via the
  // throttle/brake override, and will keep decelerating over subsequent
  // steps via the 'retired'-but-moving branch at the top of this function,
  // rather than teleport-stopping.
  if (mechanicalFailure) {
    car.status = 'retired';
    const incident: Incident = { s: car.s, time: simTime, severity: 'mechanical', utilisation: 0, timeLost: Infinity };
    car.incidents.push(incident);
    ctx.hazards.push({ route: car.route, s: car.s, until: simTime + CAUTION_DURATION_S });
    ctx.onIncident?.(car, incident);
    return;
  }

  const incidentCountBefore = car.incidents.length;
  const utilisation = evaluateLossOfControl(car, car.route, aTire, simTime, dt, ctx.weather);

  // R11: tire wear accumulates per metre travelled this step — a base rate
  // plus a load-dependent term scaled by this step's friction-circle
  // utilisation (cornering/braking hard wears faster than cruising).
  // Deliberately after the crash check, using the load that actually
  // occurred this step, not next step's.
  // M1: two credit-card contact patches doing four tyres' work — a bike eats
  // its tyres faster, and R11 turns that into late-race grip loss.
  const wearMult = car.spec.type === 'motorcycle' ? TIRE_WEAR_MOTORCYCLE_MULT : 1;
  const wearRate = (TIRE_WEAR_BASE_PER_M + TIRE_WEAR_LOAD_PER_M * utilisation * utilisation) * wearMult;
  car.tireWear = Math.min(1, car.tireWear + wearRate * car.v * dt);

  if (car.incidents.length > incidentCountBefore) {
    const incident = car.incidents[car.incidents.length - 1]!;
    // R6: register a hazard for anything that leaves a car stopped or off
    // the road — a mere slide costs time but the car stays in the flow of
    // traffic, so it isn't cautioned around the same way.
    if (incident.severity === 'spin' || incident.severity === 'off-road') {
      ctx.hazards.push({ route: car.route, s: incident.s, until: simTime + CAUTION_DURATION_S });
    }
    ctx.onIncident?.(car, incident);
  }
}

/** §6.2: fixed-timestep accumulator, decoupled from render framerate. */
export function tick(sim: Sim, realDeltaSeconds: number): void {
  if (sim.paused || sim.raceOver) return;
  const clamped = Math.min(realDeltaSeconds, 0.1);
  sim.accumulator += clamped * sim.timeScale;

  // Hoisted out of the loops below: allocating a closure/context object per
  // car per step (up to 60 Hz × N cars) would be needless per-frame
  // garbage. Only ctx.index changes per car.
  const onCarIncident = (car: CarState, incident: Incident): void => {
    sim.events.push({ time: sim.simTime, type: 'incident', carId: car.spec.id, data: incident });
    sim.onIncident?.(car, incident);
  };
  const ctx: StepContext = {
    index: 0,
    snapshot: sim.snapshot,
    hazards: sim.hazards,
    events: sim.events,
    overtakeCooldowns: sim.overtakeCooldowns,
    weather: sim.weather,
    turnaroundPauseS: sim.turnaroundPauseS,
    windAlongByRoute: sim.windAlongByRoute,
    onIncident: onCarIncident,
  };

  while (sim.accumulator >= DT) {
    sim.simTime += DT;

    // §0.3: snapshot every car's start-of-step state before any car this
    // step reads another's — mutates the preallocated objects in place, no
    // per-step allocation.
    for (let i = 0; i < sim.cars.length; i++) {
      const car = sim.cars[i]!;
      const snap = sim.snapshot[i]!;
      snap.carId = car.spec.id;
      snap.route = car.route;
      snap.s = car.s;
      snap.v = car.v;
      snap.status = car.status;
    }

    for (let i = 0; i < sim.cars.length; i++) {
      ctx.index = i;
      stepCar(sim.cars[i]!, sim.simTime, DT, ctx);
    }

    // R6: prune expired hazards once per DT step, not per car.
    if (sim.hazards.length > 0) {
      let write = 0;
      for (let read = 0; read < sim.hazards.length; read++) {
        if (sim.hazards[read]!.until > sim.simTime) {
          sim.hazards[write++] = sim.hazards[read]!;
        }
      }
      sim.hazards.length = write;
    }

    sim.accumulator -= DT;
  }

  // R13: a mechanically-retired car can still have v > 0 (coasting to a
  // stop) — the race isn't over while one is still visibly rolling. A staged
  // car has not even started, so it also keeps the race alive (its status is
  // neither of the two terminal ones, so this is already handled).
  // A paused car is neither finished nor retired, so it already keeps the race
  // alive through this check — same as a staged one.
  if (sim.cars.every((c) => c.status === 'finished' || (c.status === 'retired' && c.v === 0))) {
    sim.raceOver = true;
    sim.paused = true;
  }
}
