/** Central tuning constants (R3) — previously scattered across driver.ts,
 * physics.ts, and re-derived as a hardcoded string in config-panel.ts. Two
 * concrete wins from collecting them here: the UI can derive "130 km/h" from
 * GLOBAL_CAP instead of hoping a hardcoded string stays in sync, and future
 * features (weather multiplier, difficulty presets, per-route caps) become
 * data changes instead of code changes. */

import type { Weather } from './types';

// §0.1: a race seed only reproduces a race on the exact engine version that
// ran it — nearly every realism item changes what a given seed produces
// (new rng draws, changed driver behaviour), and that's fine. What matters
// is being honest about the mismatch rather than silently replaying a
// different race. The original (pre-realism-guide) engine is implicitly
// v1; bump this on any change that alters sim behaviour for a given seed,
// and record it alongside the seed wherever a race is shared/replayed (see
// Sim.raceSeed/engineVersion in sim.ts). Currently 3: v2 covered Phases 1-3
// (R1-R10) — driver model, cross-car interaction, environment; v3 covers
// Phase 4 (R11-R14) — R13's unconditional per-step reliability draw alone
// reshuffles every car's rng stream, so every seed produces a different
// race than it did on v2.
// v4 makes two changes, either of which alone would change every seed:
// (a) R10's speed-limit tolerance splits out of `aggression` into its own
//     `limitTolerance` spec field, changing every car's target speed on
//     limit-bound road (i.e. nearly the whole of a typical route); and
// (b) CORNER_UTILISATION_TARGET gives the cornering plan a risk margin it
//     never had, changing every car's target speed on corner-bound road.
// Between them, no seed replays the same race across the v3/v4 boundary.
// v5 adds R5's committed-pass model, whose per-step commitment draw is taken
// unconditionally for every racing car — that alone reshuffles every car's rng
// stream from the first step, on top of the changed passing behaviour itself.
// v6 gates the R5 follow-gap clamp on actual speeds rather than the profile:
// on tight road a follower whose desiredSpeed read at or below the leader's v
// while still carrying more real speed used to skip the clamp entirely and
// could close through BLOCK_MIN_GAP_M. No rng draw moved, so only seeds where
// that situation arises replay differently.
// v7 adds R15 engine heat-soak: the R13 reliability hazard now scales with a
// smoothed engine-load state, so sustained flat-out running fails more often.
// No rng draw moved, but the per-step failure threshold changes wherever
// smoothed load exceeds ENGINE_LOAD_NEUTRAL, which any uncapped race does.
// v8 lands the R15b-R19 batch, several of which alone would change every
// seed: R18's driveline launch loss reshapes every acceleration below
// 180 km/h (the largest effect — 0-100 times land on published figures);
// R17 scales rolling resistance on loose surfaces; R15b derates power on a
// heat-soaked engine; R19 fades brakes on sustained heavy braking; R16 adds
// seed-directed wind (calm races are untouched by it, but not by the rest).
// No rng draw moved.
export const ENGINE_VERSION = 8;

export const G = 9.81; // m/s²

// R9: elevation-dependent air density, replacing the flat 1.1 kg/m³ stand-in
// (chosen for ~800 m routes — wrong at both ends of a mountain route).
// rho(ele) = RHO_SEA_LEVEL * exp(-ele / AIR_DENSITY_SCALE_HEIGHT_M), computed
// in physics.ts from the route's interpolated elevation at each step.
export const RHO_SEA_LEVEL = 1.225; // kg/m³ at sea level, 15°C (ISA)
export const AIR_DENSITY_SCALE_HEIGHT_M = 8500; // atmospheric scale height

/** §7.1: stand-in for legal limits / self-preservation, m/s (~130 km/h). Real
 * cars' actual top speeds range 217-293 km/h — toggled off via the
 * config-panel's globalCapEnabled so that stat isn't always the binding
 * constraint on open road. */
export const GLOBAL_CAP = 36;

// R1: shared braking-capability derate, used both when building the profile
// (backward pass, driver.ts computeSpeedProfileUncached) and at runtime as
// the lookahead controller's aCap (driver.ts driverControl) — the two must
// agree, or the plan and the runtime disagree about what the car can do.
// Originally 0.5, covering the *entire* absence of anticipation (a purely
// reactive controller only starts braking once already over target, so half
// its nominal capability was thrown away to compensate). Now that
// driverControl scans ahead and brakes before the target is reached, the
// margin only needs to cover discretization (finite lookahead grid, 25 m
// profile buckets) and the deliberate §7.4 misjudgement noise — a much
// smaller residual, hence the higher value.
//
// Reclaimed in 0.1 steps per tools/sim-batch.ts (sorocaba-campos, 30 seeds,
// 14-car roster): 0.6 → 0% retirements; 0.7 → 1.90% (right at the ≤2%
// ceiling); 0.8 → 5.71%. Stopped at 0.6, not the highest technically-in-band
// value (0.7), per the explicit user preference for the rare end of the
// incident-rate range rather than the edge of the acceptable band.
export const BRAKE_SAFETY_MARGIN = 0.6;

// R1: how far ahead (metres) the lookahead controller scans the speed
// profile for an upcoming point it can't reach in time at the current speed.
// 300 m covers braking from any speed reachable in this sim (vMax ~86 m/s)
// down to a hairpin, at the shallowest realistic aCap.
export const LOOKAHEAD_MAX_M = 300;

// R1: fraction of aCap the lookahead demand must reach before the controller
// commits to braking (vs. still throttling/coasting toward a target that's
// merely approaching). Below this the controller falls through to the
// reactive proportional logic against the interpolated current target.
export const BRAKE_TRIGGER_FRACTION = 0.9;

// R2: sliver of the friction circle left unused on top of the commanded
// throttle/brake cap (budget · headroom, not budget straight) — drivers
// leave a small margin rather than driving exactly on the limit.
export const THROTTLE_CIRCLE_HEADROOM = 0.95;

// R2: floor under the brake-side friction-circle cap. A pure
// sqrt(1-U²) budget hits exactly 0 the instant lateral utilisation reaches
// 1 — fine for throttle (adding power while already at the limit should be
// near-zero), but wrong for brake: U is current-speed-based and a
// tightening corner can push it past 1 *before* the car has finished
// shedding speed, not only once it has, and braking is the only thing that
// reduces v. A hard-zero cap there is a lockout with no recovery path (v
// stays put, U stays put, brake stays capped at 0 for the rest of the
// corner — verified by tracing an actual hairpin where it pinned a car at
// 30 m/s against an 18.85 m/s target). Real ABS/tyres also don't fall off a
// cliff at the limit — kinetic friction keeps producing meaningful
// deceleration even while sliding. A floor keeps a car that's arrived hot
// clawing back toward the profile instead of coasting through the corner
// at whatever speed it happened to hit U=1 at.
export const BRAKE_BUDGET_FLOOR = 0.3;

// §7.5: loss-of-control tuning. Tuned toward the low end of "roughly one or
// two incidents per five-car race" (§7.5's own guidance) per explicit user
// preference for rare crashes.
export const CRASH_K = 0.03;
export const CRASH_EXP = 1.6;

/**
 * §7.1/§7.3: the friction-circle utilisation an `aggression = 1.00` driver
 * *plans* to corner at. Applied inside the sqrt in computeSpeedProfileUncached
 * (U ∝ v², so the speed scales by sqrt of this).
 *
 * Without it, the planned cornering speed was exactly the grip limit — i.e.
 * U = 1.000 — which sits ABOVE SLIDE_UTILISATION_THRESHOLD (0.95). A neutral
 * 1.00-aggression driver therefore spent the entire duration of every
 * corner inside the crash-probability region, and one sigma of the ordinary
 * §7.4 misjudgement noise pushed a 1.06-aggression driver to U = 1.204 —
 * over OFFROAD_UTILISATION_THRESHOLD, i.e. an instant retirement roll.
 *
 * Diagnosed from real incident data rather than inferred: over 6 seeds on the
 * shipped 225 km route, 23 of 24 crash incidents landed in a single 9 km
 * mountain stretch (km 198-207), and the measured utilisation cluster
 * (1.19-1.23) reproduces `aggression 1.06 × 1σ noise` to three digits. Only
 * 1 of 24 involved a sharp radius change across a grid cell, ruling out the
 * 25 m route sampling as the cause.
 *
 * Any value below SLIDE_UTILISATION_THRESHOLD puts a neutral driver under the
 * threshold while leaving `aggression > 1` doing exactly what types.ts
 * documents it to do — targeting speeds above what the tyres can hold, and
 * therefore crashing sometimes. This is the "risk margin" §7.3 always
 * described; it just had no constant, so the margin was zero.
 *
 * Swept per §0.4 (30 seeds, 28-car roster, shipped 225 km route, dry):
 *
 *   T     slide+spin/car-race   off-road retirements   mean peak U
 *   0.90  0.033                 0.12%                  1.021
 *   0.93  0.050                 1.43%                  1.078
 *   0.95  0.055                 1.31%                  1.110
 *   (pre-fix, no constant at all: 0.117 and 3.81%, peak U 1.192)
 *
 * IMPORTANT — §0.4's two pass criteria cannot both be met on this content.
 * It asks for slide+spin in 0.2-0.4 per car-race AND off-road ≤ 2%. Those
 * rates are not independent: severity is decided by where a single
 * utilisation distribution falls across the slide/spin/off-road thresholds,
 * so reaching 0.2 slide+spin requires ~4x the probability mass that gives
 * 0.055 here, which drags off-road to roughly 5-7% — three times its own
 * ceiling. The 0.2-0.4 band was also written for a 14-car roster; per *race*
 * it now lands 5-11 incidents across 28 cars, which is not "rare" by any
 * reading.
 *
 * 0.93 resolves that in favour of the ≤2% off-road ceiling (the criterion
 * that actually removes cars from a race) and the standing user preference
 * for rare incidents, accepting slide+spin below the stale band. It is chosen
 * over 0.90 because 0.90 makes a crash-caused retirement essentially never
 * happen (1 in 840 car-races — roughly one per thirty races), which is not
 * "rare", it is absent. 0.93 gives ~1.4 incidents and ~0.4 crash retirements
 * per 28-car race: notable when they happen, not weather.
 */
export const CORNER_UTILISATION_TARGET = 0.93;

/** Friction-circle utilisation thresholds (§7.5) separating a harmless
 * moment of grip loss from a spin from a full off-road retirement. */
export const SLIDE_UTILISATION_THRESHOLD = 0.95;
export const SPIN_UTILISATION_THRESHOLD = 1.05;
export const OFFROAD_UTILISATION_THRESHOLD = 1.2;

export const SLIDE_TIME_LOST_S = 2; // seconds of no throttle; car stays 'racing'
export const SPIN_RECOVERY_MIN_S = 15;
export const SPIN_RECOVERY_MAX_S = 40;

/**
 * Interval start: simulated seconds between successive cars leaving the line
 * (0 = mass start, everyone away together).
 *
 * A mass start puts the entire roster on the same point of road at s=0, v=0.
 * With a 28-car field that is not a grid, it is a pile: every car is inside
 * every other car's blocking and drafting radius from the first step, and the
 * event log filled with ~423 logged overtakes per race that were position
 * swaps inside one clump rather than racing.
 *
 * A rally-style interval start is also the format that actually matches this
 * simulation: the race is a point-to-point run down a public road, and the 1D
 * model has no lateral dimension in which a grid could exist. It costs no new
 * simulation state beyond a per-car release time — see CarState.startDelay.
 *
 * 30 s spreads a 28-car field over 13.5 minutes of a ~2.5 h race. Because
 * results are scored on each car's OWN running time (see CarState.finishTime),
 * the stagger does not advantage an early starter.
 */
export const START_INTERVAL_S = 30;

// R4: slipstream (drafting) — reduced aero drag when closely following
// another racing car on the same route. Drag at road-car speeds is modest,
// so this is a nudge (tightens finish gaps a little), not a slingshot.
export const DRAFT_MAX_GAP_M = 30;
export const DRAFT_MIN_FACTOR = 0.65; // drag multiplier at zero gap

// R5: blocking/overtaking — the time cost of traffic without full lateral
// dynamics. A slower same-route car ahead caps the follower's speed unless
// the road opens up enough to pass.
export const BLOCK_GAP_M = 12; // start checking for a blocking leader within this gap
export const BLOCK_MIN_GAP_M = 6; // never let the gap close tighter than this
export const BLOCK_FOLLOW_FACTOR = 0.98; // follower's speed relative to the leader's while blocked
export const PASS_MIN_RADIUS_M = 350; // road this open lets the follower simply drive by

/**
 * R5 (revised): committed overtaking on road that is NOT simply open.
 *
 * The original model was binary — radius > PASS_MIN_RADIUS_M meant a pass
 * happened instantly and for free, anything tighter meant it could never
 * happen at all, so a quicker car sat behind a slower one indefinitely with
 * no way through and no decision ever being made. Real overtaking on a road
 * is a *commitment*: you sit behind, you get impatient, you pick a moment,
 * and for a few seconds you are somewhere you would rather not be.
 *
 * The model: once held up for PASS_PATIENCE_S, the follower draws each step
 * against a hazard rate that scales with how much faster it is and how open
 * the road is. On committing it gets PASS_DURATION_S of not being held
 * back — and, for exactly that long, a reduced effective cornering radius
 * (PASS_LINE_PENALTY), because it is off the good line. That penalty feeds
 * the ordinary friction-circle check, so a pass committed into a tightening
 * corner carries a real risk of ending badly, with no separate crash path.
 */
export const PASS_PATIENCE_S = 4; // held up this long before the driver starts looking for a way by
export const PASS_COMMIT_RATE_PER_S = 0.6; // base hazard rate once impatient, on road at PASS_MIN_RADIUS_M
export const PASS_DURATION_S = 6; // how long a committed pass takes to complete
export const PASS_LINE_PENALTY = 0.85; // effective cornering radius multiplier while off the line

// R5: two cars within a few percent of each other's pace can trade the
// lead many times a second purely from §7.4 noise (verified empirically:
// two closely-matched cars swapped position ~2x/second, sustained, over a
// 5-minute sample — clearly not a "spectator event", a numerical artifact
// of comparing bare position with no hysteresis). A per-pair cooldown
// means only a pass that actually sticks for a while gets logged.
export const OVERTAKE_COOLDOWN_S = 5;

// R6: incident awareness (local caution) — cars lift near a fresh wreck,
// which also reads as an emergent safety effect (a corner that just claimed
// one car was probably a candidate to claim the next one too).
export const CAUTION_DURATION_S = 90; // how long a hazard stays active before marshals clear it
export const CAUTION_AHEAD_M = 150; // hazard within this far ahead of the car triggers the cap
export const CAUTION_BEHIND_M = 30; // ...or this far behind (still passing the wreck site)
export const CAUTION_SPEED = 22; // m/s ≈ 80 km/h, capped target speed near a hazard

// R7: weather as a grip multiplier. Applied to BOTH muLat and muLong at
// every site that reads them (profile build, runtime accel, crash check,
// R1's aCap) — scaling only the runtime side would make every corner a
// crash site on a wet road the driver planned dry-fast; scaling only the
// plan would make cars unrealistically safe. Scaling both keeps drivers
// driving *to the conditions* with the same §7.3 risk margins.
export const WEATHER_GRIP: Record<Weather, number> = { dry: 1.0, damp: 0.85, wet: 0.7 };

// R7: wet/damp roads also make a driver's own speed estimate noisier
// (spray, reduced visibility, less confident feedback through the wheel) —
// scales spec.errorSigma at its one use site in driverControl.
export const WEATHER_ERROR_MULT: Record<Weather, number> = { dry: 1.0, damp: 1.3, wet: 1.6 };

// --- M1: motorcycles ------------------------------------------------------
//
// Everything in this block applies only to `spec.type === 'motorcycle'`, and
// every use site falls back to the car value above for cars — so adding
// motorcycles to the roster does not change what any existing seed produces
// for a field of cars (guarded by src/golden.test.ts).

/**
 * A motorcycle's own weather-grip table, replacing WEATHER_GRIP for bikes.
 *
 * Rain costs a motorcycle far more than a car, and the reason is geometric
 * rather than a question of tyre compound: cornering force on two wheels comes
 * from lean angle, a wet surface reduces the lean the rider dares carry, and
 * there is no fourth-contact-patch margin for a slide to be caught in. Riders
 * respond by backing off much harder than drivers do — which this table
 * models directly, since the same multiplier scales both the plan and the
 * crash check (see WEATHER_GRIP's note).
 */
export const MOTORCYCLE_WEATHER_GRIP: Record<Weather, number> = { dry: 1.0, damp: 0.78, wet: 0.58 };

/**
 * Default pitch-over ceiling (see CarSpec.pitchLimitG) for a motorcycle whose
 * JSON entry doesn't state one, in g.
 *
 * 1.1 g is the usual quoted braking (stoppie) threshold for a modern
 * sportbike; long, low machines (Hayabusa, cruisers, tourers) carry more and
 * override it per bike. Note this sits *below* what the tyres could deliver —
 * that is the point of the constant.
 */
export const MOTORCYCLE_PITCH_LIMIT_G = 1.1;

/**
 * CORNER_UTILISATION_TARGET's motorcycle counterpart — how much of the
 * available cornering grip a rider actually plans to use.
 *
 * Lower than a car's 0.93 because the consequences are not symmetric: a driver
 * who overcooks a corner scrubs wide, a rider who does the same is on the
 * ground. Riders carry visibly more margin on a public road, and modelling it
 * here rather than only in the crash check matters — with bikes planning to a
 * car's margin, a wet race retired 44% of the motorcycle field (measured, 12
 * seeds), which is not "riskier in the rain", it is unraceable. At 0.88 a bike
 * is a little slower through every corner in exchange for staying on the road,
 * which is the trade a real rider makes.
 */
export const MOTORCYCLE_CORNER_UTILISATION_TARGET = 0.88;

/**
 * How far a motorcycle's incident-severity thresholds shift down (in
 * friction-circle utilisation) relative to a car's.
 *
 * The same loss of grip has a categorically worse outcome on two wheels: a car
 * that steps out is usually a moment and a lost second, whereas a bike that
 * loses the front is on the ground. Shifting SPIN/OFFROAD down rather than
 * adding a separate crash path means one utilisation distribution still
 * decides everything — a bike simply falls into the worse band sooner.
 *
 * Calibrated against the sim-batch protocol (§0.4), and the first value tried
 * (0.06) was far too harsh: combined with R11 wear — a bike ends a 225 km race
 * with ~0.85 tyre wear against a car's ~0.65, and worn tyres raise utilisation
 * for the same speed — it retired 83% of the motorcycle field in the wet. The
 * failures were all late-race, at U just past the shifted threshold (measured:
 * off-road at 203 km, U = 1.16 against a 1.14 ceiling). 0.03 keeps the
 * qualitative difference (a car's spin is a bike's retirement across that
 * band) without making the last third of a wet race a lottery.
 */
export const MOTORCYCLE_SEVERITY_SHIFT = 0.03;

/** A downed rider is not back up in the seconds a spun car needs — a
 * motorcycle's spin recovery is scaled by this. */
export const MOTORCYCLE_RECOVERY_MULT = 1.6;

/**
 * R11 tyre wear multiplier for motorcycles.
 *
 * Two contact patches the size of a credit card each, carrying the same job
 * four much larger ones do on a car, and a sport tyre run at racing lean
 * angles is a consumable measured in hundreds of kilometres. Wear costs grip
 * through the same R11 channel, so this shows up as a bike fading late in a
 * long race — the counterweight to its acceleration advantage.
 *
 * 1.3, not the 1.7 first tried: at 1.7 every motorcycle on the shipped 225 km
 * route finished with tireWear pinned at exactly 1.00 (measured — a Gold Wing
 * included), which is the model saturating rather than differentiating. Cars
 * finish that route around 0.65; 1.3 puts bikes near 0.85 — clearly worse off,
 * still on the part of the curve where how hard they were ridden matters.
 */
export const TIRE_WEAR_MOTORCYCLE_MULT = 1.3;

// R11: tire degradation. Wear accumulates per metre travelled — a base rate
// (rolling scrub, present even cruising) plus a load-dependent term scaled
// by the friction-circle utilisation squared (cornering/braking hard wears
// faster). Calibrated via tools/sim-batch.ts on the long (265 km) route so
// tireWear lands around ~0.7 at typical race-long utilisation — meant to
// shape the last third of a long race, not zero out grip entirely.
export const TIRE_WEAR_BASE_PER_M = 1.8e-6;
export const TIRE_WEAR_LOAD_PER_M = 6e-6;
export const TIRE_WEAR_MAX_GRIP_LOSS = 0.06; // grip lost at tireWear = 1 (fully worn)

// R12: persistent incident damage — contactless, mild, permanent. Slides
// flat-spot the tyres a little; spins add bodywork/aero damage too (drag)
// on top of the same grip hit. Multipliers stack across incidents.
export const SLIDE_GRIP_DAMAGE = 0.995;
export const SPIN_GRIP_DAMAGE = 0.98;
export const SPIN_CDA_DAMAGE = 1.02;
// R11/R12 share this floor: damage/wear never make a car undriveable, only
// slower — the driver-adaptation line in driverControl (sqrt(conditionGrip)
// target scaling) handles the rest automatically via the same channel.
export const CONDITION_GRIP_FLOOR = 0.9;

// R13: mechanical reliability. Hazard rate λ = BASE + LOAD·throttle (stress
// scales with sustained load), drawn every step unconditionally against
// 1 - exp(-λ·dt) so the rng stream layout never depends on throttle history
// (§0.1). Calibrated for ~4% chance of a DNF per car over a ~2h/265 km race
// at a representative mixed-throttle average — "0-1 mechanical DNFs
// typically" across a 14-car field, matching the rare-incident preference;
// these should read as an event, not weather.
export const RELIABILITY_BASE_PER_S = 1e-6;
export const RELIABILITY_LOAD_PER_S = 1.5e-5;

// R13: once mechanically retired, the driver eases off rather than the car
// teleport-stopping — a fixed, moderate brake (not panic-braking) coasts it
// down over a few seconds, matching the spinning-state's "still visible"
// principle.
export const MECHANICAL_COAST_BRAKE = 0.3;

// R15: engine heat-soak. R13's hazard reads *instantaneous* throttle, which
// is memoryless — a machine held wide open for an hour was no more likely to
// let go in the next second than one that just opened up, so a 380 km/h
// hyperbike could sit at vMax for an entire uncapped course with only the
// flat load term to answer for it. Each car now carries a smoothed load (an
// exponential moving average of throttle, time constant ENGINE_LOAD_TAU_S),
// and the hazard's load term scales up to (1 + ENGINE_STRESS_MULT) as that
// average rises from ENGINE_LOAD_NEUTRAL toward 1. Below the neutral point
// there is no penalty at all: limit-capped cruising and corner-brake-corner
// rhythm both keep the average well under it, so shipped default races are
// essentially untouched — this is a tax on *sustained* full load, not on
// using the engine. Holding top speed IS sustained full load (top speed is
// by definition the full-power point), which is exactly the case it exists
// to price.
export const ENGINE_LOAD_TAU_S = 45; // EMA time constant — stress builds over ~1-2 min flat out, cools on the same scale after lifting
export const ENGINE_LOAD_NEUTRAL = 0.7; // no extra hazard at or below this smoothed load; hard road driving averages under it
export const ENGINE_STRESS_MULT = 3; // load-term multiplier at full soak (4x R13): ~25% DNF over a 90 min flat-out run vs ~8% before
// R15b: heat also derates power, so sustained flat-out is self-limiting
// rather than only a reliability roll. 6% at full soak ≈ a hot intake and a
// protective ECU pulling timing; via the drag equilibrium (v ∝ P^⅓) it sags
// a top-speed run by ~2% — an H2R holding 380 km/h drifts back to ~372 —
// without making any car undriveable. Applies at the same stress fraction
// the hazard uses, so the two effects always agree on how cooked the engine
// is. Fresh engines (engineLoad ≤ neutral) are entirely unaffected, which
// keeps the roster-data top-speed reachability audit meaningful as-is.
export const ENGINE_HEAT_POWER_FADE = 0.06;

// R17: rough surface raises rolling resistance, not just lowering grip. A
// point's `surface` value is authored as a grip multiplier (1 asphalt, ~0.8
// gravel), and until now that was its only physical effect — but loose
// surfaces also roughly double crr for a road tyre. Expressed off the same
// per-point value so the baker needs no new field: crr is scaled by
// 1 + THIS × (1 − surface), i.e. a surface that costs 20% grip costs 2x
// rolling resistance. Runtime-only (the speed profile is grip/brake-bound
// and never reads crr), so no profile cache-key change.
export const SURFACE_CRR_PER_GRIP_LOSS = 5;

// R18: driveline/launch loss. R14's constant-torque region assumed every
// watt reaches the wheels from step-off, so modelled 0-100 km/h ran ~1.25 s
// optimistic roster-wide and 5-7 s optimistic on economy cars (the guide's
// own audit) — real cars lose launch force to clutch slip, shift
// interruptions and per-gear torque dips, and the weaker the car the larger
// the slice of its 0-100 run those eat. The power term is derated by up to
// DRIVELINE_LOSS_MAX at standstill, tapering linearly to zero by
// DRIVELINE_LOSS_FADE_SPEED — or by DRIVELINE_LOSS_VMAX_FRACTION x vMax for
// machines slower than that, because near top speed the box is in top gear
// and not shifting. Top-speed equilibrium is therefore untouched (the
// roster reachability audit stays meaningful), traction- and pitch-limited
// launches (supercars, superbikes — the machines the audit found accurate)
// are untouched because their force cap binds below the power term, and the
// power-limited middle drops onto published figures: sweep against eight
// published 0-100 times took the mean model error from -2.08 s to -0.17 s
// (Uno 10.2 -> 14.7 vs 16.5 published, Camry 5.3 -> 8.0 vs 7.8, GR86
// 4.3 -> 6.5 vs 6.3, 911 Turbo S 2.7 -> 3.0 vs 2.7, Fireblade unchanged).
export const DRIVELINE_LOSS_MAX = 0.5;
export const DRIVELINE_LOSS_FADE_SPEED = 50; // m/s (180 km/h) — shift losses are per-gear events; above this they are noise
export const DRIVELINE_LOSS_VMAX_FRACTION = 0.9; // taper end for machines whose vMax is below the fade speed

// R19: brake fade. Sustained heavy braking (a mountain descent) heats pads
// and fluid and costs stopping power; a lap of ordinary corner-brake-corner
// rhythm does not. Each car carries `brakeHeat`, an EMA (BRAKE_HEAT_TAU_S)
// of brake command × speed fraction (energy into the brakes scales with
// both; town-speed braking barely warms them, BRAKE_HEAT_SPEED_REF). Above
// BRAKE_HEAT_NEUTRAL, usable braking derates linearly to BRAKE_FADE_MAX at
// full heat — in both the runtime controller's aCap AND physics' brake
// force, so the driver knows exactly what the faded system can give and
// brakes earlier to compensate (R1's lookahead does that automatically once
// aCap drops). The profile keeps planning with fresh brakes (§0.2 — it
// cannot rebuild mid-race), which stays SAFE because the plan only ever
// demands BRAKE_SAFETY_MARGIN (0.6) of the fresh system: BRAKE_FADE_MAX
// must therefore stay strictly below 1 − BRAKE_SAFETY_MARGIN = 0.4, or a
// fully faded car could physically fail to make a planned braking ramp.
export const BRAKE_HEAT_TAU_S = 20; // brakes heat and cool over tens of seconds, much faster than engine soak
export const BRAKE_HEAT_SPEED_REF = 40; // m/s — full heat credit only for braking from motorway speed and above
export const BRAKE_HEAT_NEUTRAL = 0.25; // normal racing rhythm (~15-20% braking duty) sits under this; a held descent exceeds it
export const BRAKE_FADE_MAX = 0.3; // stopping power lost at full heat; MUST stay < 1 - BRAKE_SAFETY_MARGIN (see above)

// R16: wind. One wind vector per race — a strength preset chosen in race
// config, a compass direction drawn deterministically from the race seed —
// projected onto the road's bearing at the car's s and subtracted from the
// car's speed before the drag term (physics.ts windAlong). Headwind raises
// effective airspeed, tailwind lowers it, and a route that doubles back
// (the round-trip courses) gets the asymmetry for free. Speeds are Beaufort
// anchors: 4 m/s is a gentle breeze you'd barely note in a car; 9 m/s is a
// fresh breeze — at 250 km/h it swings drag by ±25%, which is why "windy"
// visibly reshapes uncapped racing while leaving town-speed sections alone.
export const WIND_PRESET_SPEED: Record<import('./types').WindPreset, number> = { calm: 0, breezy: 4, windy: 9 };
