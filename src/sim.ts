import type { CarSpec, CarState, CarStatus, Incident, RaceEvent, Route, Weather } from './types';
import { computeAcceleration } from './physics';
import { interpolateAt, radiusAt } from './route';
import { computeSpeedProfile, driverControl, evaluateLossOfControl } from './driver';
import { mulberry32 } from './rng';
import {
  DRAFT_MAX_GAP_M,
  DRAFT_MIN_FACTOR,
  BLOCK_GAP_M,
  BLOCK_MIN_GAP_M,
  BLOCK_FOLLOW_FACTOR,
  PASS_MIN_RADIUS_M,
  OVERTAKE_COOLDOWN_S,
  CAUTION_DURATION_S,
  CAUTION_AHEAD_M,
  CAUTION_BEHIND_M,
  CAUTION_SPEED,
  WEATHER_GRIP,
  ENGINE_VERSION,
  TIRE_WEAR_BASE_PER_M,
  TIRE_WEAR_LOAD_PER_M,
  TIRE_WEAR_MAX_GRIP_LOSS,
  RELIABILITY_BASE_PER_S,
  RELIABILITY_LOAD_PER_S,
  MECHANICAL_COAST_BRAKE,
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

export function createSim(
  assignments: CarAssignment[],
  raceSeed = 1,
  globalCapEnabled = true,
  weather: Weather = 'dry',
): Sim {
  const cars: CarState[] = assignments.map(({ spec, route }) => {
    const seed = deriveCarSeed(raceSeed, spec.id);
    return {
      spec,
      route,
      s: 0,
      v: 0,
      throttle: 0,
      brake: 0,
      status: 'racing',
      recoveryRemaining: 0,
      incidents: [],
      finishTime: null,
      speedProfile: computeSpeedProfile(route, spec, globalCapEnabled, weather),
      rng: mulberry32(seed),
      seed,
      tireWear: 0,
      condition: { grip: 1, cdA: 1 },
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
  };
}

/** F1: `s` isn't comparable across cars on different routes — remaining
 * distance to each car's own finish line is. */
export function remainingDistance(car: CarState): number {
  return car.route.totalDistance - car.s;
}

// A retired (crashed-out) car should never be "the leader" — its distance
// stops updating, so it would otherwise stay P1/camera target forever.
// Finished cars still count: they're ahead by definition until every other
// car finishes too. Falls back to the overall least-remaining car only if
// every car has retired (no non-retired car exists to lead).
export function resolveLeader(cars: CarState[]): CarState {
  const active = cars.filter((c) => c.status !== 'retired');
  const pool = active.length > 0 ? active : cars;
  return pool.reduce((a, b) => (remainingDistance(b) < remainingDistance(a) ? b : a));
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
  onIncident?: (car: CarState, incident: Incident) => void;
}

function overtakePairKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

// R13: hazard rate for mechanical failure — exported for direct testing of
// the analytic law (§0.4-style: expected failures over N draws vs. this
// formula), separate from the Monte-Carlo full-race batch check.
export function reliabilityHazardRate(throttle: number): number {
  return RELIABILITY_BASE_PER_S + RELIABILITY_LOAD_PER_S * throttle;
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

  if (car.status === 'retired') {
    if (car.v === 0) return;
    coastToStop(car, dt);
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
  );
  car.throttle = throttleLockedOut ? 0 : throttle;
  car.brake = brake;

  // R13: mechanical reliability — drawn every step, unconditionally, for
  // every currently-racing car regardless of throttle magnitude (§0.1: an
  // unconditional draw keeps the rng stream layout stable regardless of
  // throttle history). On failure, override this step's own throttle/brake
  // so the physics below already reflects a dead engine + easing off,
  // rather than needing a separate code path for the first failed step.
  const hazardRate = reliabilityHazardRate(car.throttle);
  const pFailureThisStep = 1 - Math.exp(-hazardRate * dt);
  const mechanicalFailure = car.rng() < pFailureThisStep;
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
  });

  // §6.2: semi-implicit Euler — update v first, then s.
  car.v = Math.max(0, Math.min(car.v + a * dt, car.spec.vMax));

  // R5: blocking — a slower same-route car ahead caps closing speed unless
  // the road opens up enough to pass. Deliberately between the v-update and
  // the s-update, so the clamp affects this step's distance travelled, not
  // next step's. A spinning leader (off at the roadside) is never blocked
  // against — only tracked so the overtake event below still fires for it.
  const blockLeader = nearestAhead(ctx.snapshot, ctx.index, car.route, car.s, BLOCK_GAP_M, BLOCK_STATUSES);
  if (blockLeader && blockLeader.status === 'racing' && blockLeader.v < car.v) {
    const canPass = radiusAt(car.route, car.s) > PASS_MIN_RADIUS_M;
    if (!canPass) {
      const projectedGap = blockLeader.s - (car.s + car.v * dt);
      if (projectedGap < BLOCK_MIN_GAP_M) {
        car.v = blockLeader.v * BLOCK_FOLLOW_FACTOR;
      }
    }
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
    car.finishTime = simTime;
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
  const wearRate = TIRE_WEAR_BASE_PER_M + TIRE_WEAR_LOAD_PER_M * utilisation * utilisation;
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
  // stop) — the race isn't over while one is still visibly rolling.
  if (sim.cars.every((c) => c.status === 'finished' || (c.status === 'retired' && c.v === 0))) {
    sim.raceOver = true;
    sim.paused = true;
  }
}
