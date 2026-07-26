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
export const ENGINE_VERSION = 3;

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

/** Friction-circle utilisation thresholds (§7.5) separating a harmless
 * moment of grip loss from a spin from a full off-road retirement. */
export const SLIDE_UTILISATION_THRESHOLD = 0.95;
export const SPIN_UTILISATION_THRESHOLD = 1.05;
export const OFFROAD_UTILISATION_THRESHOLD = 1.2;

export const SLIDE_TIME_LOST_S = 2; // seconds of no throttle; car stays 'racing'
export const SPIN_RECOVERY_MIN_S = 15;
export const SPIN_RECOVERY_MAX_S = 40;

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
