import type { CarSpec, CarState, Incident, Route, Weather } from './types';
import { valueNoise } from './rng';
import { radiusAt, surfaceAt } from './route';
import {
  G,
  GLOBAL_CAP,
  BRAKE_SAFETY_MARGIN,
  LOOKAHEAD_MAX_M,
  BRAKE_TRIGGER_FRACTION,
  THROTTLE_CIRCLE_HEADROOM,
  BRAKE_BUDGET_FLOOR,
  WEATHER_GRIP,
  WEATHER_ERROR_MULT,
  CORNER_UTILISATION_TARGET,
  CRASH_K,
  CRASH_EXP,
  SLIDE_UTILISATION_THRESHOLD,
  SPIN_UTILISATION_THRESHOLD,
  OFFROAD_UTILISATION_THRESHOLD,
  SLIDE_TIME_LOST_S,
  SPIN_RECOVERY_MIN_S,
  SPIN_RECOVERY_MAX_S,
  TIRE_WEAR_MAX_GRIP_LOSS,
  SLIDE_GRIP_DAMAGE,
  SPIN_GRIP_DAMAGE,
  SPIN_CDA_DAMAGE,
  CONDITION_GRIP_FLOOR,
  PASS_LINE_PENALTY,
  MOTORCYCLE_WEATHER_GRIP,
  MOTORCYCLE_CORNER_UTILISATION_TARGET,
  MOTORCYCLE_SEVERITY_SHIFT,
  MOTORCYCLE_RECOVERY_MULT,
} from './tuning';

/**
 * M1: the weather grip multiplier this vehicle actually experiences.
 *
 * Motorcycles read their own (harsher) table — see MOTORCYCLE_WEATHER_GRIP.
 * Every site that composes grip goes through here, so the plan, the runtime
 * controller and the crash check cannot disagree about how wet the road is for
 * a given machine (the failure mode WEATHER_GRIP's own note warns about).
 */
export function weatherGripFor(spec: CarSpec, weather: Weather): number {
  return (spec.type === 'motorcycle' ? MOTORCYCLE_WEATHER_GRIP : WEATHER_GRIP)[weather];
}

/**
 * Usable braking deceleration, in m/s², at a point of given grade.
 *
 * Shared by the profile's backward pass and the runtime controller's `aCap` so
 * planning and execution agree on what the vehicle can actually do — they were
 * two copies of one formula, and M1 adds a second term to it: braking is
 * capped by the pitch-over (stoppie) ceiling as well as by tyre grip, which is
 * why a superbike with far better tyres than a hot hatch does not out-brake
 * one. `Infinity` for cars leaves the expression exactly as it was.
 *
 * The 0.5 floor: a steep-downhill point under low grip (wet × unpaved × worn
 * tyres) can otherwise push this to zero or negative, and a negative cap both
 * trips the brake trigger for any aReqMax and flips brake = aReqMax/aCap
 * negative — which survives the final clamp and reaches physics as thrust.
 */
function brakeCapability(spec: CarSpec, gripMultiplier: number, grade: number): number {
  const tyreLimited = spec.muLong * gripMultiplier * G * Math.cos(grade);
  return Math.max(
    0.5,
    Math.min(tyreLimited, spec.pitchLimitG * G) * BRAKE_SAFETY_MARGIN + G * Math.sin(grade),
  );
}

// Speed profiles are pure functions of (route, spec, globalCapEnabled) and
// immutable once built — safe to share the same Float32Array across cars
// with the same spec, and across Reset/Apply as long as the route object is
// unchanged (P4). Keyed on the route object itself so the cache for a route
// disappears once nothing else references that route.
const speedProfileCache = new WeakMap<Route, Map<string, Float32Array>>();

/**
 * §7.1: precompute the per-point target speed profile for a car.
 *
 * `globalCapEnabled` toggles the 130 km/h stand-in for legal limits (user
 * preference, config-panel setting) — with real cars whose actual top speeds
 * range 217-293 km/h, the cap otherwise makes that stat almost never the
 * binding constraint on open road.
 *
 * `weather` (R7) is race-level and fixed for the whole race — see tuning.ts's
 * WEATHER_GRIP. It must scale this build-time profile AND the runtime grip
 * reads in `driverControl`/`evaluateLossOfControl` identically: scaling only
 * the runtime side plans dry-fast speeds into a wet corner (every corner
 * becomes a crash site); scaling only the plan makes cars unrealistically
 * safe on a wet road.
 */
export function computeSpeedProfile(
  route: Route,
  spec: CarSpec,
  globalCapEnabled: boolean,
  weather: Weather,
): Float32Array {
  let byKey = speedProfileCache.get(route);
  if (!byKey) {
    byKey = new Map();
    speedProfileCache.set(route, byKey);
  }
  const key = `${spec.id}:${globalCapEnabled}:${spec.lineQuality}:${spec.limitTolerance}:${weather}`;
  const cached = byKey.get(key);
  if (cached) return cached;

  const profile = computeSpeedProfileUncached(route, spec, globalCapEnabled, weather);
  byKey.set(key, profile);
  return profile;
}

function computeSpeedProfileUncached(
  route: Route,
  spec: CarSpec,
  globalCapEnabled: boolean,
  weather: Weather,
): Float32Array {
  const n = route.points.length;
  const weatherGrip = weatherGripFor(spec, weather);

  // Step 1 — cornering limit, Step 2 — aggression + (optional) global cap.
  // R3: lineQuality widens the radius the driver plans against (straightening
  // the corner off the road centerline) — must use the same effective radius
  // the crash check uses (evaluateLossOfControl), or corners become phantom
  // crash zones whenever the plan is more generous than the check. R8:
  // per-point surface grip composes with weather into the same channel R7
  // established — gravel under a dry sky drives like a wet asphalt corner,
  // physically the same effect (less usable friction), so one multiplier.
  const vLimit = new Float32Array(n);
  // M1: a rider plans with more margin than a driver — see
  // MOTORCYCLE_CORNER_UTILISATION_TARGET.
  const utilisationTarget =
    spec.type === 'motorcycle' ? MOTORCYCLE_CORNER_UTILISATION_TARGET : CORNER_UTILISATION_TARGET;
  for (let i = 0; i < n; i++) {
    const point = route.points[i]!;
    const gripMultiplier = weatherGrip * (point.surface ?? 1);
    // CORNER_UTILISATION_TARGET sits inside the sqrt because utilisation goes
    // as v²: planning for U = 0.90 means planning for sqrt(0.90) ≈ 0.949 of
    // the grip-limited speed. Without it the plan aimed at U = 1.000 exactly,
    // i.e. above the slide threshold for the whole of every binding corner —
    // see the constant's note in tuning.ts for the measured evidence.
    const vCorner = Math.sqrt(
      spec.muLat * gripMultiplier * G * point.radius * spec.lineQuality * utilisationTarget,
    );
    const uncapped = Math.min(vCorner * spec.aggression, spec.vMax);
    // R10: a tagged legal limit replaces the flat GLOBAL_CAP stand-in where
    // known, falling back to it where the road is untagged (real coverage
    // is patchy — never fabricate a limit from road class).
    //
    // Scaled by `limitTolerance`, NOT `aggression`. Reusing `aggression` here
    // (the original design) conflated two unrelated driver traits, and on a
    // route that is ~90% limit-tagged the limit term dominates the profile
    // almost everywhere — so cornering bravery silently became the single
    // biggest determinant of finish time, ahead of power, mass, drag and
    // grip combined. Measured over 15 seeds on the shipped 225 km route, that
    // put a Civic Type R (aggression 1.06) first by 6 minutes and the
    // 2000 hp U9 Xtreme (0.88) last of 28, behind a Ford F-150, while every
    // aggression-1.00 car from a GR86 to a 720S finished within 80 s of each
    // other. Tolerance now spans a deliberately narrow 0.98–1.06, so
    // limit-bound sections bunch the field (which is what really happens on a
    // speed-limited road) and the corners do the separating.
    //
    // The tolerance applies to the GLOBAL_CAP fallback too: that constant is
    // itself a stand-in for a posted limit, so a driver who runs 4% over the
    // signs should run 4% over the stand-in as well. Previously the fallback
    // branch applied no multiplier at all, making untagged road the one place
    // every driver behaved identically.
    const pointCap = (point.limit ?? GLOBAL_CAP) * spec.limitTolerance;
    vLimit[i] = globalCapEnabled ? Math.min(uncapped, pointCap) : uncapped;
  }

  // Step 3 — backward pass for braking feasibility, grade-aware: downhill
  // (grade < 0) reduces achievable braking (gravity pushes the car forward),
  // uphill (grade > 0) helps it. A floor keeps the sqrt from collapsing on
  // absurd grades.
  const profile = new Float32Array(n);
  profile[n - 1] = vLimit[n - 1]!;
  for (let i = n - 2; i >= 0; i--) {
    const point = route.points[i]!;
    const gripMultiplier = weatherGrip * (point.surface ?? 1);
    const aBrake = brakeCapability(spec, gripMultiplier, point.grade);
    const reachable = Math.sqrt(profile[i + 1]! * profile[i + 1]! + 2 * aBrake * route.spacing);
    profile[i] = Math.min(vLimit[i]!, reachable);
  }

  return profile;
}

export interface DriverOutput {
  throttle: number;
  brake: number;
}

/** §7.2 + §7.4: runtime controller, target speed perturbed by slow-varying
 * misjudgement noise. `speedCap` (R6) is an optional external ceiling on the
 * *reactive* target — e.g. a caution zone near a fresh incident — passed in
 * by the caller (stepCar) rather than teaching this function about the
 * world; it leaves R1's lookahead braking (which reasons about the profile,
 * not the world) untouched. `conditionGrip` (R11/R12) is the car's current
 * car.condition.grip × its wear-derived grip factor, likewise resolved by
 * the caller from CarState — this function only ever sees CarSpec. */
export function driverControl(
  profile: Float32Array,
  route: Route,
  s: number,
  v: number,
  spec: CarSpec,
  seed: number,
  weather: Weather,
  speedCap?: number,
  conditionGrip = 1,
): DriverOutput {
  // R7/R8/R11/R12: weather × road-surface × condition grip, composed the
  // same way the profile build (weather/surface only — condition can't
  // rebuild a cached profile, §0.2) and evaluateLossOfControl compose it.
  const gripMultiplier = weatherGripFor(spec, weather) * surfaceAt(route, s) * conditionGrip;

  // R11: the profile was built assuming conditionGrip = 1 (fresh tyres,
  // undamaged). Weather and surface are identical between build-time and
  // now (both fixed for the race), so the ratio effectiveGripRuntime /
  // effectiveGripAtProfileBuild reduces to conditionGrip alone. Cornering
  // speed scales with sqrt(mu), so scaling every target read from the
  // frozen profile by sqrt(conditionGrip) keeps planned utilisation
  // roughly constant as tyres fade — the one line that makes worn/damaged
  // tyres cost pace instead of causing a late-race crash spike (nothing
  // else here knows the profile itself has gone optimistic).
  const speedAdaptation = Math.sqrt(conditionGrip);

  // A flat per-bucket lookup holds a constant target for the whole 25 m
  // bucket. That's harmless on its own, but combined with the ±0.5 m/s
  // "maintain" deadband it lets the car settle just outside the deadband
  // (e.g. 0.48 m/s over) and cruise there for the entire bucket without
  // ever closing the gap — then the next bucket's target can drop sharply
  // in a single step while v hasn't moved at all. Interpolating the profile
  // continuously (same technique as route.ts's radiusAt) makes the target
  // itself decrease smoothly as the car approaches the tighter bucket.
  const idx = Math.min(Math.floor(s / route.spacing), profile.length - 2);
  // Segment length, not route.spacing (B12): the baker's final segment can
  // be shorter than `spacing` when it appends the true destination point.
  const segStart = route.points[idx]!.s;
  const segEnd = route.points[idx + 1]!.s;
  const bucketT = (s - segStart) / (segEnd - segStart);
  const interpolatedProfile = (profile[idx]! + bucketT * (profile[idx + 1]! - profile[idx]!)) * speedAdaptation;

  // R1: lookahead braking — scan the profile ahead for the point that
  // demands the hardest braking to reach at the current speed, rather than
  // waiting until the car is already over the *current* target. aReqMax(j)
  // is the constant deceleration that would hit profile[j] exactly at
  // distance d; the early-exit is safe because further points (larger d)
  // can never demand more than a full stop (vj=0) would at that distance,
  // so once even that hypothetical ceiling drops below the current max, no
  // later point can beat it.
  let aReqMax = 0;
  for (let j = idx + 1; j < profile.length; j++) {
    const d = route.points[j]!.s - s;
    if (d <= 0) continue;
    if (d > LOOKAHEAD_MAX_M) break;
    if ((v * v) / (2 * d) <= aReqMax) break;
    const vj = profile[j]! * speedAdaptation; // R11/R12: same adaptation as interpolatedProfile
    if (vj < v) {
      const aReq = (v * v - vj * vj) / (2 * d);
      if (aReq > aReqMax) aReqMax = aReq;
    }
  }

  // Grade-corrected usable braking decel — the same brakeCapability the
  // profile's backward pass used, so planning and runtime agree on what the
  // vehicle can actually do. R7: gripMultiplier derates it the same way the
  // profile build does.
  const grade = route.points[idx]!.grade;
  const aCap = brakeCapability(spec, gripMultiplier, grade);

  let raw: DriverOutput;
  if (aReqMax > BRAKE_TRIGGER_FRACTION * aCap) {
    raw = { throttle: 0, brake: Math.min(1, aReqMax / aCap) };
  } else {
    // Fall through to the reactive proportional logic against the
    // interpolated *current* target — no upcoming point demands hard
    // braking yet, so throttle/maintain against where the car is right now.
    // R7: wet/damp roads also make the driver's own speed estimate noisier.
    const err = 1 + spec.errorSigma * WEATHER_ERROR_MULT[weather] * valueNoise(s / 4000, seed);
    const target = speedCap === undefined ? interpolatedProfile * err : Math.min(interpolatedProfile * err, speedCap);
    const error = target - v;

    if (error > 0.5) {
      raw = { throttle: Math.min(1, error / 3), brake: 0 };
    } else if (error < -0.5) {
      raw = { throttle: 0, brake: Math.min(1, -error / 3) };
    } else {
      raw = { throttle: 0.3, brake: 0 }; // maintain
    }
  }

  // R2: friction-circle-aware throttle/brake cap. Staying inside the tyre's
  // combined grip budget is a driver skill, not a probability roll left
  // entirely to evaluateLossOfControl — commanding full throttle mid-corner
  // regardless of lateral load is the "major artificial crash source" this
  // item exists to fix, and uncapped trail-braking mid-corner is the other
  // side of the same coin. `budget` is the longitudinal headroom left once
  // U's share of the friction circle is spent, computed the same way
  // evaluateLossOfControl computes it, so planning and the crash check read
  // off the same circle.
  //
  // Throttle uses the raw budget: adding power while already at the
  // cornering limit should approach zero, with no floor. Brake uses a
  // floored version (BRAKE_BUDGET_FLOOR) instead of the same hard cap:
  // U is current-speed-based, and a tightening corner can push it past 1
  // *before* the car has finished shedding speed, not only once it has —
  // braking is the only thing that reduces v, so a hard-zero cap there is a
  // lockout with no recovery path (verified by tracing an actual hairpin
  // where it pinned a car at 30 m/s against an 18.85 m/s target: U crossed
  // 1, brake capped to 0, v never came down, U never came back under 1).
  // Real ABS/tyres don't fall off a cliff at the limit either — kinetic
  // friction keeps producing meaningful deceleration even while sliding.
  // R3: same effective (lineQuality-widened) radius the profile was built
  // against, so the driver's own sense of "how much grip is left" agrees
  // with the plan. R7: same gripMultiplier too.
  const radius = radiusAt(route, s) * spec.lineQuality;
  const U = (v * v) / radius / (spec.muLat * gripMultiplier * G);
  const budget = Math.sqrt(Math.max(0, 1 - U * U));
  const throttleCap = budget * THROTTLE_CIRCLE_HEADROOM;
  const brakeCap = Math.max(BRAKE_BUDGET_FLOOR, budget) * THROTTLE_CIRCLE_HEADROOM;

  return { throttle: Math.min(raw.throttle, throttleCap), brake: Math.min(raw.brake, brakeCap) };
}

// §7.5: loss of control ------------------------------------------------------

/**
 * §7.5: evaluated every step, for every car currently racing.
 *
 * `aTire` is the traction/brake-only acceleration component (excluding
 * drag/roll/grade — see physics.ts) — the friction circle measures tire
 * grip usage, not net vehicle deceleration, so aero drag and gravity don't
 * count against the tire's budget the way they would for §6.2's integrator.
 *
 * Returns the friction-circle utilisation (`total`) regardless of whether
 * an incident actually fired — R11's tire-wear accumulation in stepCar
 * needs this step's load even when it stayed safely under the threshold.
 */
export function evaluateLossOfControl(
  car: CarState,
  route: Route,
  aTire: number,
  simTime: number,
  dt: number,
  weather: Weather,
): number {
  if (car.status !== 'racing') return 0;

  // R3: same effective (lineQuality-widened) radius the plan and the
  // throttle/brake cap use — the crash check and the driver's own sense of
  // grip must agree, or corners become phantom crash zones. R7/R8/R11/R12:
  // same weather × surface × condition gripMultiplier too — car.condition.grip
  // (R12's permanent damage) composes with tireWear's own grip loss (R11).
  const gripFromWear = 1 - TIRE_WEAR_MAX_GRIP_LOSS * car.tireWear;
  const gripMultiplier =
    weatherGripFor(car.spec, weather) * surfaceAt(route, car.s) * car.condition.grip * gripFromWear;
  // R5: a car mid-overtake is off the line it would otherwise take — around
  // the outside, or squared off on the inside — so the radius it is actually
  // driving is tighter than the one it plans against. Applied here and only
  // here: the *plan* (computeSpeedProfile) is built for the good line, which
  // is exactly the point. Committing to a pass into a tightening corner
  // therefore costs friction-circle margin through the ordinary §7.5 check,
  // with no separate crash path bolted on.
  const passPenalty = car.passRemaining > 0 ? PASS_LINE_PENALTY : 1;
  const radius = radiusAt(route, car.s) * car.spec.lineQuality * passPenalty;
  const aLat = (car.v * car.v) / radius;
  const gripAvailable = car.spec.muLat * gripMultiplier * G;
  const U = aLat / gripAvailable;

  const longUsed = Math.abs(aTire) / (car.spec.muLong * gripMultiplier * G);
  const total = Math.sqrt(U * U + longUsed * longUsed);

  if (total <= SLIDE_UTILISATION_THRESHOLD) return total;

  const pPerSecond = Math.min(1, CRASH_K * Math.pow(total - SLIDE_UTILISATION_THRESHOLD, CRASH_EXP));
  const pThisStep = 1 - Math.pow(1 - pPerSecond, dt);
  if (car.rng() >= pThisStep) return total;

  triggerIncident(car, total, simTime);
  return total;
}

function triggerIncident(car: CarState, total: number, simTime: number): void {
  let severity: Incident['severity'];
  let timeLost: number;

  // M1: the same loss of grip is worse on two wheels — a moment that a car
  // catches puts a bike on the ground. Both thresholds move down together, so
  // one utilisation distribution still decides severity; a motorcycle just
  // reaches the worse band sooner. (Cars: shift is 0, thresholds unchanged.)
  const shift = car.spec.type === 'motorcycle' ? MOTORCYCLE_SEVERITY_SHIFT : 0;
  const spinThreshold = SPIN_UTILISATION_THRESHOLD - shift;
  const offroadThreshold = OFFROAD_UTILISATION_THRESHOLD - shift;
  const recoveryMult = car.spec.type === 'motorcycle' ? MOTORCYCLE_RECOVERY_MULT : 1;

  if (total <= spinThreshold) {
    severity = 'slide';
    car.v *= 0.6;
    car.recoveryRemaining = SLIDE_TIME_LOST_S; // seconds of no throttle, car stays 'racing'
    timeLost = SLIDE_TIME_LOST_S;
    // R12: flat-spotted tyres — mild, permanent, stacks across incidents.
    car.condition.grip = Math.max(CONDITION_GRIP_FLOOR, car.condition.grip * SLIDE_GRIP_DAMAGE);
  } else if (total <= offroadThreshold) {
    severity = 'spin';
    // The rng draw stays in the same place in the stream whatever the vehicle
    // is; only the seconds it buys differ (§0.1).
    const recovery =
      (SPIN_RECOVERY_MIN_S + car.rng() * (SPIN_RECOVERY_MAX_S - SPIN_RECOVERY_MIN_S)) * recoveryMult;
    car.status = 'spinning';
    car.v = 0;
    car.recoveryRemaining = recovery;
    timeLost = recovery;
    // R12: bodywork/aero through the grass — grip hit plus a drag penalty.
    car.condition.grip = Math.max(CONDITION_GRIP_FLOOR, car.condition.grip * SPIN_GRIP_DAMAGE);
    car.condition.cdA *= SPIN_CDA_DAMAGE;
  } else {
    severity = 'off-road';
    car.status = 'retired';
    car.v = 0;
    car.recoveryRemaining = 0;
    timeLost = Infinity; // never rejoins
  }

  car.incidents.push({ s: car.s, time: simTime, severity, utilisation: total, timeLost });
}
