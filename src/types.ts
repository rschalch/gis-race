/** One sample along the route, at uniform 25 m spacing.
 *
 * `x`/`y` (local ENU metres, used internally by the baker's geometry) and
 * `bearing` (unused at runtime, and only ever meant for icon rotation) are
 * deliberately not part of this runtime-facing type (P5) — they inflated
 * every route file by roughly a third with data nothing in src/ reads. The
 * baker computes its own internal point shape and narrows to this one only
 * when writing the final route JSON. */
export interface RoutePoint {
  s: number;        // metres from start (0, 25, 50, ...)
  lon: number;
  lat: number;
  ele: number;      // metres above sea level, smoothed
  grade: number;    // radians; positive = uphill
  radius: number;   // metres; radius of curvature, clamped to [15, 5000]
  surface?: number; // R8: grip factor from OSM surface=* (asphalt 1.0 down to
                     // dirt/unpaved 0.6), smoothed like elevation. Optional —
                     // absent means unknown/untagged, treated as 1.0
                     // (schema-compatible with every route baked before R8).
  limit?: number;   // R10: legal speed limit in m/s, from OSM maxspeed=*.
                     // Optional — absent means untagged, falls back to
                     // GLOBAL_CAP at runtime.
}

export interface Route {
  origin: { lon: number; lat: number };  // ENU reference point
  totalDistance: number;                 // metres
  spacing: number;                       // 25
  points: RoutePoint[];
}

/** §5.9: one entry in public/data/routes/index.json. Shared between the
 * runtime (src/route.ts) and the Node-only baking tools (tools/bakeRoute.ts),
 * which can't import from src/route.ts itself (it does browser fetch()).
 *
 * F1: a "course" is one origin→destination bake request; it produces one or
 * more route *variants* (OSRM alternatives=true, when available) that share
 * a `courseId` and the same origin/destination. Cars can be assigned to
 * different variants of the same course (Waze-style). Single-variant bakes
 * (the common case) still get a `courseId` — just with exactly one member. */
export interface RouteIndexEntry {
  slug: string;
  name: string;
  distanceKm: number;
  elevationGainM: number;
  courseId: string;
  variantLabel: string; // e.g. "Route 1" — always present, even for a lone variant
}

export interface CarSpec {
  id: string;
  name: string;
  colour: string;       // hex, for map icon + leaderboard
  mass: number;         // kg, including driver
  power: number;        // W, peak at the wheels
  cdA: number;           // m², drag coefficient × frontal area
  crr: number;           // rolling resistance coefficient
  muLong: number;        // longitudinal grip (accel + braking)
  muLat: number;         // lateral grip (cornering)
  vMax: number;          // m/s, governed top speed
  aggression: number;    // 0.90–1.10 multiplier on the cornering speed profile.
                          // >1.00 means the driver targets speeds above the
                          // car's actual grip limit and can therefore crash.
  errorSigma: number;    // 0.00–0.06, magnitude of slow-varying misjudgement
                          // in the driver's speed estimate. See §7.4.
  lineQuality: number;   // 1.00–1.15, R3: how much a driver straightens a
                          // corner off the road centerline, as an effective-
                          // radius multiplier — applied identically wherever
                          // cornering radius is read (plan and crash check),
                          // never just one or the other.
  induction: 'na' | 'forced'; // R9: naturally-aspirated engines lose power
                          // with altitude (thinner intake air); turbo/hybrid/
                          // electric ('forced', the default) are treated as
                          // self-correcting/unaffected.
  peakPowerSpeed: number; // R14: m/s. Constant-torque below this road speed
                          // (force = P/peakPowerSpeed), constant-power above
                          // (force = P/v) — a per-gear approximation, not a
                          // real spec. Default 5 reproduces the pre-R14
                          // hardcoded floor exactly.
}

export type CarStatus = 'racing' | 'spinning' | 'retired' | 'finished';

/** R7: one race-level condition, fixed for the whole race — dynamic weather
 * (changing mid-race) is a later feature; the event-log architecture
 * already anticipates it. */
export type Weather = 'dry' | 'damp' | 'wet';

export interface CarState {
  spec: CarSpec;
  route: Route;         // F1: per-car, not per-race — cars can be on different alternatives
  s: number;            // metres along route
  v: number;            // m/s
  throttle: number;     // 0..1, for HUD/telemetry
  brake: number;        // 0..1
  status: CarStatus;
  recoveryRemaining: number;  // simulated seconds left immobilised after a spin,
                               // or throttle-locked-out after a slide — see §7.5
  incidents: Incident[];
  finishTime: number | null;  // simulated seconds
  speedProfile: Float32Array; // per-car, precomputed — see §7
  rng: () => number;          // seeded PRNG, one per car — see §7.5
  seed: number;                // fixed numeric seed for the pure valueNoise() misjudgement
                                // function, distinct from rng's stateful stream — see §7.4
  tireWear: number;            // R11: 0 (fresh) to 1 (fully worn), accumulates with distance/load
  condition: {                  // R11/R12: shared "effective condition" multipliers, both start at 1.
    grip: number;                // R12: permanently reduced a little by each slide/spin, floored at 0.9
    cdA: number;                  // R12: permanently increased a little by each spin (bodywork damage)
  };
}

export interface Incident {
  s: number;            // where it happened
  time: number;         // simulated seconds
  severity: 'slide' | 'spin' | 'off-road' | 'mechanical'; // R13: DNF unrelated to grip/crash
  utilisation: number;  // how far over the limit the car was, e.g. 1.14; 0 for 'mechanical' (not applicable)
  timeLost: number;     // seconds
}

/**
 * F4: append-only race event log. Incidents (B10), lead changes, finishes,
 * and future spectator events (fastest sector, weather change) all want the
 * same infrastructure — one array the sim writes to and the UI consumes
 * incrementally, plus a durable record available after the race (summary
 * screen, replay seed + event list = shareable race). Each `type` carries
 * its own `data` shape; the UI can ignore a `type` it doesn't render yet
 * without any of this breaking.
 */
export interface IncidentEvent {
  time: number; // simulated seconds
  type: 'incident';
  carId: string;
  data: Incident;
}

/** R5: pushed on the step a car's `s` passes a slower car ahead of it on the
 * same route. */
export interface OvertakeEvent {
  time: number;
  type: 'overtake';
  carId: string;
  data: { passedId: string };
}

/** Phase 2: pushed the step a car's status flips to 'finished' — nearly free
 * once cross-car events exist, and the summary screen wants it. */
export interface FinishEvent {
  time: number;
  type: 'finish';
  carId: string;
}

export type RaceEvent = IncidentEvent | OvertakeEvent | FinishEvent;
