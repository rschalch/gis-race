# GIS Racing Simulator — Implementation Plan

**Deliverable:** a browser-based racing simulation in which 5 cars with distinct
real-world specifications race along the real road network from Sorocaba, SP to
Campos do Jordão, SP, viewed top-down on a MapLibre map.

**Audience:** the implementing engineer. This document is the specification —
follow it top to bottom. Where it says *locked*, do not substitute an
alternative without flagging it first.

---

## 1. Scope

### In scope

- One fixed route: Sorocaba (SP) → Campos do Jordão (SP), derived from real OSM
  road data.
- 5 cars, each with distinct mass, power, drag, and grip characteristics.
- Longitudinal vehicle dynamics driven by real road grade and real road
  curvature sampled from GIS data.
- **Loss of control and crashes**: a car carrying too much speed into a corner
  can spin or leave the road, costing time or retiring from the race.
- Top-down MapLibre view with live car positions, a leaderboard, and a
  time-scaled clock.
- **Camera can follow any car at any moment**, not just the leader.
- **Route is a runtime parameter**: any city pair can be baked and raced
  without code changes.
- Deterministic simulation: same seed → same race result.

### Explicitly out of scope

> **Historical — parts of this list have been superseded.** This document is
> the *original* spec, kept as a record of the decisions the project started
> from. Several items below were later implemented deliberately, and the list
> is annotated rather than rewritten so the original intent stays legible.
> Where this section and the code disagree, the code and `REALISM-GUIDE.md`
> are authoritative. The **guiding principle** immediately below this list is
> the one thing here that has NOT changed and must not be treated as stale.

- ~~3D rendering, car models, textures.~~ **Superseded.** Cars are drawn as 3D
  meshes via deck.gl's `SimpleMeshLayer`, interleaved into MapLibre's own
  WebGL context, with a chase camera and 3D terrain. See `src/render/cars-3d.ts`,
  `car-mesh.ts`, `chase-camera.ts`. The simulation stayed 1D throughout — this
  is a rendering change only, which is exactly why it was safe to make.
- Player-controlled driving. All cars are AI-driven. (Adding a human
  throttle/brake later is a small change — see §11.)
- ~~Gearboxes, engine RPM curves,~~ tyre temperature, ~~fuel, weather.~~
  **Partly superseded.** R14 added a constant-torque/constant-power split
  (`peakPowerSpeed`) as a coarse per-gear approximation — not an RPM curve.
  R7 added weather as a race-level grip multiplier. Tyre *temperature* and
  fuel remain out of scope; tyre **wear** was added by R11.
- Traffic, junctions, traffic lights, other road users.
- Multiplayer, persistence, accounts.

### Guiding principle

The race is **one-dimensional**. Every car's state is `(s, v)` — metres
travelled along the route and current speed. Latitude/longitude is *derived*
from `s` purely for drawing. Do not model 2D position, steering, or heading as
simulation state. This single decision is what keeps the project small.

---

## 2. Tech stack — locked

| Concern | Choice | Notes |
|---|---|---|
| Build | Vite + TypeScript, no UI framework | Vanilla DOM is sufficient. Do **not** add React. |
| Map rendering | MapLibre GL JS v5 (pinned) | v5 specifically: it added the `sky` style property, and v6 removes the internal `map.transform` that `@deck.gl/mapbox` reads. See the pin note at the top of `src/render/map.ts`. |
| 3D car models | `@deck.gl/mesh-layers`, interleaved | Added after the original spec — see the amendment below the table. |
| Basemap | OpenFreeMap `liberty` style | `https://tiles.openfreemap.org/styles/liberty` — free, no API key, no signup. |
| Routing (build-time only) | Valhalla primary, OSRM demo fallback | See `tools/bakeRoute.ts`. |
| Elevation (build-time only) | OpenTopoData public API, SRTM 30m | `api.opentopodata.org` — free, rate-limited to 1 req/s, 100 points/req. |
| Geometry maths | Hand-written, ~150 lines | Turf.js is optional and probably unnecessary. |

**No game engine.** Unity, Godot, Unreal and Phaser are all inappropriate
here — the cars never leave the road, and the entire "engine" is a
fixed-timestep integrator.

> **Amended.** The "top-down, so no 3D library" reasoning no longer holds: the
> view is now a pitched chase camera, and `@deck.gl/mesh-layers` draws the car
> models. deck.gl was chosen precisely because it is *not* a game engine — it
> renders into MapLibre's existing WebGL context and depth buffer, so cars are
> occluded correctly by terrain and buildings without a second scene graph. The
> rule this line was really protecting — no engine owning the game loop, no
> second source of truth for state — still stands: the fixed-timestep
> integrator in `sim.ts` remains the only simulation, and deck.gl only draws.

### The critical build-time / runtime split

Routing and elevation lookups happen **once, offline, in a Node script**, and
are committed to the repo as a static JSON file. The running game makes zero
network calls other than basemap tiles.

This matters because it makes the game deterministic, instant to load, and
immune to those public APIs being slow, rate-limited, or down.

---

## 3. Repository structure

```
gis-racer/
├─ package.json
├─ tsconfig.json
├─ vite.config.ts
├─ index.html
├─ tools/
│  └─ bake-route.ts        # offline: fetch route + elevation, emit route.json
├─ public/
│  └─ data/
│     └─ route.json        # ~10k points, committed to the repo
└─ src/
   ├─ main.ts              # bootstrap, animation loop
   ├─ types.ts             # shared interfaces (§4)
   ├─ route.ts             # load route.json, interpolate position at distance s
   ├─ physics.ts           # force model + integrator
   ├─ driver.ts            # speed profile + throttle/brake controller
   ├─ cars.ts              # the 5 car specifications
   ├─ sim.ts               # owns all car states, steps the world
   ├─ render/
   │  ├─ map.ts            # MapLibre setup, route layer, car layer
   │  ├─ hud.ts            # leaderboard, clock, controls
   │  └─ profile.ts        # elevation strip with car markers
   └─ style.css
```

---

## 4. Data contracts

Define these in `src/types.ts` first. Everything else depends on them.

```ts
/** One sample along the route, at uniform 25 m spacing. */
interface RoutePoint {
  s: number;        // metres from start (0, 25, 50, ...)
  lon: number;
  lat: number;
  x: number;        // local ENU metres east of origin
  y: number;        // local ENU metres north of origin
  ele: number;      // metres above sea level, smoothed
  grade: number;    // radians; positive = uphill
  radius: number;   // metres; radius of curvature, clamped to [15, 5000]
  bearing: number;  // radians, clockwise from north — for icon rotation
}

interface Route {
  origin: { lon: number; lat: number };  // ENU reference point
  totalDistance: number;                 // metres
  spacing: number;                       // 25
  points: RoutePoint[];
}

interface CarSpec {
  id: string;
  name: string;
  colour: string;       // hex, for map icon + leaderboard
  mass: number;         // kg, including driver
  power: number;        // W, peak at the wheels
  cdA: number;          // m², drag coefficient × frontal area
  crr: number;          // rolling resistance coefficient
  muLong: number;       // longitudinal grip (accel + braking)
  muLat: number;        // lateral grip (cornering)
  vMax: number;         // m/s, governed top speed
  aggression: number;   // 0.90–1.10 multiplier on the cornering speed profile.
                        // >1.00 means the driver targets speeds above the
                        // car's actual grip limit and can therefore crash.
  errorSigma: number;   // 0.00–0.06, magnitude of slow-varying misjudgement
                        // in the driver's speed estimate. See §7.4.
}

type CarStatus = 'racing' | 'spinning' | 'retired' | 'finished';

interface CarState {
  spec: CarSpec;
  s: number;            // metres along route
  v: number;            // m/s
  throttle: number;     // 0..1, for HUD/telemetry
  brake: number;        // 0..1
  status: CarStatus;
  recoveryRemaining: number;  // simulated seconds left immobilised after a spin
  incidents: Incident[];
  finishTime: number | null;  // simulated seconds
  speedProfile: Float32Array; // per-car, precomputed — see §7
  rng: () => number;          // seeded PRNG, one per car — see §7.5
}

interface Incident {
  s: number;            // where it happened
  time: number;         // simulated seconds
  severity: 'spin' | 'off-road';
  utilisation: number;  // how far over the limit the car was, e.g. 1.14
  timeLost: number;     // seconds
}
```

---

## 5. Phase 1 — Bake the route (`tools/bake-route.ts`)

This is the highest-risk phase and the one with the most subtle maths. Get it
right before touching anything else. It runs once via `npm run bake` and needs
network access.

### 5.1 Fetch the route geometry

Endpoints (Sorocaba → Campos do Jordão, note OSRM takes **lon,lat** order):

```
https://router.project-osrm.org/route/v1/driving/
  -47.4526,-23.5015;-45.5914,-22.7392
  ?overview=full&geometries=geojson
```

Expect roughly 250–290 km depending on the corridor OSRM picks (typically
Castello Branco / Ayrton Senna / Dutra to the Paraíba valley, then the SP-123
climb into the Serra da Mantiqueira). **Log the returned distance and assert it
falls in 200–350 km** — if it doesn't, something is wrong with the coordinate
order.

### 5.2 Project to local metres

Working in degrees will produce wrong curvature and wrong distances. Convert to
a local East-North-Up plane using the first point as origin:

```ts
const R = 6378137;
const x = R * (lon - lon0) * Math.PI/180 * Math.cos(lat0 * Math.PI/180);
const y = R * (lat - lat0) * Math.PI/180;
```

Over a 300 km span this is accurate to well under a metre, which is far below
anything the simulation cares about. Do all geometry in `(x, y)`.

### 5.3 Resample to uniform spacing

OSRM returns points at irregular intervals (a few metres on curves, hundreds on
straights). Resample by linear interpolation to **exactly 25 m spacing**.
Uniform spacing makes every downstream step — curvature, the speed profile
backward pass, position lookup — an O(1) array index instead of a search.

### 5.4 Sample elevation

Query OpenTopoData at **100 m intervals** (not 25 m — that's 4× the requests
for no benefit), then linearly interpolate onto the 25 m grid.

```
https://api.opentopodata.org/v1/srtm30m?locations=lat1,lon1|lat2,lon2|...
```

Constraints: max 100 locations per request, 1 request per second. For a 270 km
route that's ~2,700 points → ~27 requests → ~30 seconds. **Implement a 1100 ms
sleep between requests** and retry once on failure.

### 5.5 Smooth the elevation — do not skip this

Raw SRTM has vertical noise on the order of several metres. Differentiating
noisy elevation over 25 m baselines produces grade spikes of ±20%, which will
make cars brake and accelerate violently on flat motorway.

Apply a centred moving average with a **200 m window** (±4 samples on the 25 m
grid) before computing grade.

### 5.6 Compute grade

Central difference over a 100 m baseline (±2 samples):

```ts
grade[i] = Math.atan2(ele[i+2] - ele[i-2], 4 * spacing);
```

Sanity check: real motorway grades rarely exceed 6%; mountain roads reach about
10–12%. **Assert `|grade| < 0.20 rad` everywhere.** A violation means the
smoothing failed.

### 5.7 Compute curvature — the most important step

Curvature is what creates the racing. Use the Menger curvature of three points
spaced **50 m apart** (i.e. samples `i-2`, `i`, `i+2`). Do **not** use adjacent
points — at 25 m spacing, GPS/OSM digitisation noise dominates and you'll get
nonsense radii on dead-straight roads.

```ts
// side lengths of triangle ABC
const a = dist(B, C), b = dist(A, C), c = dist(A, B);
const area = Math.abs((B.x-A.x)*(C.y-A.y) - (C.x-A.x)*(B.y-A.y)) / 2;
const radius = area < 1e-6 ? Infinity : (a * b * c) / (4 * area);
```

Then:
1. Clamp to `[15, 5000]` metres. Below 15 m is a digitisation artefact; above
   5000 m is functionally straight.
2. Apply a **min-filter over a ±75 m window**. A corner's tightest point should
   influence the approach, and this is cheaper and more stable than smoothing.

Sanity check: log the distribution of radii. You should see a large mass at the
5000 m clamp (motorway) and a distinct cluster in the 20–60 m range
corresponding to the Mantiqueira switchbacks. **If you don't see that second
cluster, the curvature calculation is broken** — stop and fix it, because
without it every car will finish within seconds of every other and the race
will be boring.

### 5.8 Emit

Write `public/data/routes/<slug>.json`. Round coordinates to 6 decimal places
and other floats to 2 — this cuts file size by more than half. Expect ~2–4 MB
per route, which is fine to commit and fine to load.

### 5.9 Multiple routes — core requirement, not an extension

The baker must take origin and destination as CLI arguments and geocode them,
so that adding a route requires no code changes:

```bash
npm run bake -- --from "Sorocaba, SP" --to "Campos do Jordão, SP" --slug sorocaba-campos
npm run bake -- --from "Santos, SP"   --to "São Paulo, SP"        --slug santos-sp
```

Use Nominatim (`nominatim.openstreetmap.org/search?format=json&q=...`) for
geocoding. It requires a descriptive `User-Agent` header and permits 1 request
per second — respect both.

Maintain `public/data/routes/index.json` listing every baked route with its
slug, display name, distance, and total elevation gain. The app reads this at
startup and presents a route picker; selecting a route reloads the simulation
with no page refresh.

Bake at least three routes so the picker is exercised properly. Contrasting
profiles are worth choosing deliberately — a mountain route, a flat motorway
route, and a short twisty one will each produce a visibly different race and a
different winner.

---

## 6. Phase 2 — Physics (`src/physics.ts`)

### 6.1 Force model

Standard longitudinal vehicle dynamics. All forces in newtons, `g = 9.81`,
air density `ρ = 1.10` kg/m³ (the route averages ~800 m altitude, so use a
slightly reduced value rather than the sea-level 1.225).

```
F_traction = throttle × min(P / max(v, 5), μ_long × m × g)
F_drag     = 0.5 × ρ × cdA × v²
F_roll     = crr × m × g × cos(grade)
F_grade    = m × g × sin(grade)
F_brake    = brake × μ_long × m × g

a = (F_traction − F_brake − F_drag − F_roll − F_grade) / m
```

The `max(v, 5)` floor on the power-limited term prevents a division blow-up at
standstill and stands in for a clutch. Below about 30 km/h the `μ×m×g` term
binds instead — that's the grip limit, and it's why the heavy pickup is not
actually slow off the line, only slow at speed.

### 6.2 Integration

Semi-implicit Euler at a **fixed 60 Hz simulation timestep**, decoupled from
render framerate via an accumulator:

```ts
const DT = 1 / 60;
accumulator += realDeltaSeconds * timeScale;
while (accumulator >= DT) {
  stepSimulation(DT);
  accumulator -= DT;
}
```

Update `v` first, then `s`:

```ts
v = Math.max(0, Math.min(v + a * DT, spec.vMax));
s = s + v * DT;
```

`timeScale` default **60** — a ~3 hour drive becomes a ~3 minute race. Expose
1× / 30× / 60× / 120× buttons. Because the timestep is fixed, changing the time
scale does not change the physics; it only changes how many steps run per
frame. Guard against the browser tab being backgrounded by clamping
`realDeltaSeconds` to 0.1 s.

### 6.3 Route lookup

Given `s`, the point index is `Math.floor(s / 25)`. Linearly interpolate `lon`,
`lat`, `ele`, `grade`, and `bearing` between index `i` and `i+1`. For `radius`,
take the minimum of the two rather than interpolating — conservative is
correct here.

---

## 7. Phase 3 — Driver model and crashes (`src/driver.ts`)

### 7.1 The static speed profile

This is the elegant part, and it replaces what would otherwise be a fiddly
runtime lookahead search.

**Step 1 — cornering limit.** For each route point, the maximum speed at which
the car can hold the corner:

```ts
vCorner[i] = Math.sqrt(spec.muLat * 9.81 * route.points[i].radius);
```

**Step 2 — apply aggression and global cap:**

```ts
vLimit[i] = Math.min(vCorner[i] * spec.aggression, spec.vMax, GLOBAL_CAP);
```

Use `GLOBAL_CAP = 36` m/s (~130 km/h) as a stand-in for legal limits and
self-preservation.

**Step 3 — backward pass for braking feasibility.** A car doing 130 km/h cannot
be at 40 km/h by the time it reaches a hairpin unless it started braking a long
way back. Propagate the constraint backwards from the finish:

```ts
const aBrake = spec.muLong * 9.81;   // m/s², available deceleration
profile[N-1] = vLimit[N-1];
for (let i = N - 2; i >= 0; i--) {
  const reachable = Math.sqrt(profile[i+1]**2 + 2 * aBrake * spacing);
  profile[i] = Math.min(vLimit[i], reachable);
}
```

From `v² = u² + 2as`. The resulting `profile` is the fastest speed at each point
from which the car can still slow down in time for everything ahead of it. It
is computed once per car at init, costs a single pass over ~10k floats, and
completely removes the need for runtime lookahead.

### 7.2 Runtime controller

Trivially simple, given the profile:

```ts
const target = profile[Math.floor(s / spacing)];
const error = target - v;
if (error > 0.5)       { throttle = Math.min(1, error / 3); brake = 0; }
else if (error < -0.5) { throttle = 0; brake = Math.min(1, -error / 3); }
else                   { throttle = 0.3; brake = 0; }   // maintain
```

The `0.3` maintenance throttle is a placeholder; a small PI controller holding
speed against drag and grade would be smoother, and is worth doing if the cars
visibly oscillate.

### 7.3 Differentiating the drivers

The `aggression` field is the primary lever and it does double duty: it sets
how fast a driver corners *and* how likely they are to crash, because the
speed profile is built from the driver's `aggression` while the crash check in
§7.5 is evaluated against the car's true physical grip. A driver at 0.92 leaves
an 8% safety margin and will essentially never crash. A driver at 1.06 is
routinely asking for 6% more grip than exists.

This is the intended design: caution and speed are genuinely traded off against
each other, and neither strategy is guaranteed to win.

### 7.4 Driver misjudgement

A constant `aggression` makes each driver perfectly consistent, which is
unrealistic and makes crashes fully predictable. Add a slowly-varying error
term so drivers have better and worse stretches:

```ts
// value noise with ~4 km wavelength, seeded per car
const err = 1 + spec.errorSigma * valueNoise(s / 4000, car.seed);
const target = profile[idx] * err;
```

`valueNoise` is a standard seeded 1D noise function: hash the integer lattice
points, cosine-interpolate between them. Roughly 20 lines. It must be a pure
function of `(s, seed)` so the simulation stays reproducible.

The effect: a driver who is 4% optimistic entering the one corner where they
were already at the limit will crash, and the same driver may sail through that
corner cleanly on a different seed. That is exactly the drama you want.

### 7.5 Loss of control

Evaluated every simulation step, for every car with `status === 'racing'`.

**Step 1 — grip utilisation.** Compare the lateral acceleration the corner
demands against what the tyres can actually deliver:

```ts
const aLat = (v * v) / route.radiusAt(s);
const gripAvailable = spec.muLat * 9.81;
const U = aLat / gripAvailable;
```

**Step 2 — combined loading.** Cornering and braking share the same friction
budget, so a car braking hard mid-corner is closer to the edge than `U` alone
suggests. Use the friction circle:

```ts
const longUsed = Math.abs(a) / (spec.muLong * 9.81);   // a from §6.1
const total = Math.sqrt(U * U + longUsed * longUsed);
```

**Step 3 — probabilistic failure.** Below 0.95 the car is safe. Above it,
failure probability per second rises steeply:

```ts
let pPerSecond = 0;
if (total > 0.95) {
  pPerSecond = Math.min(1, 12 * Math.pow(total - 0.95, 1.6));
}
const pThisStep = 1 - Math.pow(1 - pPerSecond, DT);
if (car.rng() < pThisStep) triggerIncident(car, total);
```

Converting a per-second rate into a per-step probability via
`1 − (1−p)^DT` is important — without it the crash rate would change if you
ever alter the timestep.

**Step 4 — consequences.** Severity scales with how far over the limit the car
was:

| `total` | Outcome | Effect |
|---|---|---|
| 0.95 – 1.05 | Slide, caught | Speed cut to 60%, 2 s of no throttle |
| 1.05 – 1.20 | Spin | `status = 'spinning'`, v → 0, immobilised 15–40 s, then resumes |
| > 1.20 | Off-road | `status = 'retired'`, car stops permanently |

Roll the recovery duration from the car's seeded RNG. Push an `Incident` onto
`car.incidents` in every case — the HUD reports these and they are the most
interesting thing that happens in a race.

**Step 5 — recovery.** While `status === 'spinning'`, decrement
`recoveryRemaining` by `DT` and skip physics entirely. On reaching zero, set
`status = 'racing'` with `v = 0`. The car must then climb back up to speed
under its own power, which on a mountain gradient is a substantial further
penalty — correctly so.

Tune the `12` and `1.6` constants until roughly one or two incidents occur per
five-car race. Log every incident to the console during tuning.

---

## 8. Phase 4 — Rendering

### 8.1 Map (`src/render/map.ts`)

- Initialise MapLibre with the OpenFreeMap Liberty style.
- Add the route as a GeoJSON `line` layer, width 4, colour `#334155`.
- Add a second line layer above it coloured by gradient or curvature — this
  makes the mountain section visually obvious and is worth the small effort.
- Cars: a single GeoJSON `FeatureCollection` source with 5 point features,
  rendered as a `circle` layer (radius 7, `circle-color` from a feature
  property) with a `symbol` layer above for labels. Call `setData()` once per
  animation frame with all 5 updated positions — do **not** create 5 separate
  sources or use HTML markers, both of which will stutter.

Camera modes, selectable in the HUD:
1. **Overview** — `fitBounds` on the whole route, static.
2. **Follow a specific car** — the user selects *any* of the five, either by
   clicking its dot on the map or clicking its row in the leaderboard. The
   camera `easeTo`s that car every frame at zoom 13. The selected car is
   highlighted in both the map layer and the leaderboard, and switching between
   cars must work at any point in the race, including while the selected car is
   spinning or retired.
3. **Follow leader** — as above, but the target is recomputed each frame as the
   car with the greatest `s`, so the camera changes car on every lead change.
4. **Free** — user pans and zooms; selection is retained but the camera does
   not move.

Implement 2 as the general case and treat 3 as a special case of it. Add a
`cameraTarget: string | 'leader' | null` field to the app state.

### 8.2 HUD (`src/render/hud.ts`)

A fixed panel showing, sorted by `s` descending:

| Pos | Car | Speed | Gap to leader | Distance remaining | Elevation |
|---|---|---|---|---|---|

Plus: simulated elapsed time, time-scale buttons, pause/reset, and a finish
board that fills in as cars complete.

### 8.3 Elevation profile strip (`src/render/profile.ts`)

A ~120 px canvas across the bottom of the screen plotting elevation against
distance, with 5 coloured dots showing each car's current position. This is the
single most informative view in the whole application — it makes the
Mantiqueira climb legible and shows exactly where cars gain and lose time.

---

## 9. Car roster (`src/cars.ts`)

These five are chosen so that no single car dominates: the light hot hatch wins
the twisty section, the sedan wins the flat motorway, and the heavy vehicles
lose badly on the climb.

```ts
export const CARS: CarSpec[] = [
  { id: 'hatch',  name: 'Compact Hatch', colour: '#ef4444',
    mass: 1150, power:  66000, cdA: 0.62, crr: 0.012,
    muLong: 0.85, muLat: 0.85, vMax: 45,
    aggression: 0.94, errorSigma: 0.03 },

  { id: 'sedan',  name: 'Family Sedan',  colour: '#3b82f6',
    mass: 1400, power: 110000, cdA: 0.68, crr: 0.012,
    muLong: 0.90, muLat: 0.90, vMax: 55,
    aggression: 0.99, errorSigma: 0.025 },

  { id: 'hot',    name: 'Hot Hatch',     colour: '#f59e0b',
    mass: 1250, power: 150000, cdA: 0.66, crr: 0.011,
    muLong: 1.00, muLat: 1.00, vMax: 62,
    aggression: 1.06, errorSigma: 0.05 },   // fastest, and by far the likeliest to crash

  { id: 'suv',    name: 'Midsize SUV',   colour: '#10b981',
    mass: 1750, power: 130000, cdA: 0.92, crr: 0.014,
    muLong: 0.85, muLat: 0.80, vMax: 52,
    aggression: 1.02, errorSigma: 0.04 },   // overconfident in a tall, low-grip vehicle

  { id: 'pickup', name: 'Pickup Truck',  colour: '#8b5cf6',
    mass: 2000, power: 120000, cdA: 1.05, crr: 0.016,
    muLong: 0.80, muLat: 0.75, vMax: 48,
    aggression: 0.90, errorSigma: 0.02 },   // slow but will almost certainly finish
];
```

The `aggression` spread is deliberately set so that two cars sit above 1.00 and
are therefore genuinely at risk, while the pickup's 0.90 makes it the tortoise
that occasionally wins because everyone quicker put it in a ditch.

Power figures are **at the wheels**, already net of drivetrain losses. If you
prefer to quote crank power, multiply by 0.85 in the physics rather than
editing these numbers.

---

## 10. Acceptance criteria

The implementation is done when all of these hold:

1. `npm run bake` produces a `route.json` of 200–350 km with monotonically
   increasing `s` and no `NaN` in any field.
2. The curvature histogram shows a distinct cluster below 60 m radius. (§5.7)
3. All grades satisfy `|grade| < 0.20 rad`.
4. At 60× time scale, the race completes in 2–4 minutes of wall-clock time,
   corresponding to a plausible 2.5–4 simulated hours.
5. Cars visibly and smoothly decelerate on approach to the mountain
   switchbacks, without oscillating between full throttle and full brake.
6. The finishing order is **not** simply the power-to-weight ranking. If it is,
   the curvature data is not influencing the result and §5.7 needs revisiting.
7. Across 20 races on 20 different seeds, incidents occur in the majority of
   them, the hot hatch and SUV account for most of them, and the pickup crashes
   rarely or never. At least one race is won by a car that was not leading at
   the halfway point.
8. Every incident occurs in a corner, never on a straight. Log `radius` at the
   moment of each incident and confirm it is below ~300 m in all cases.
9. A spinning car visibly stops, the HUD shows its status and recovery
   countdown, and it rejoins from a standstill.
10. The camera can be switched to any of the five cars at any point in the
    race, including a retired one, both by clicking the map dot and by clicking
    the leaderboard row.
11. At least three routes appear in the picker and can be swapped without a
    page reload; each produces a different winner distribution.
12. Re-running with the same seed produces byte-identical finish times and an
    identical incident list.
13. Sustained 60 fps with all five cars and the map in follow mode.

---

## 11. Deliberate extension points

Build the core first. These are all small additions afterwards, and the
architecture above already accommodates them:

- **Human-driven car** — replace one `CarState`'s driver call with keyboard
  input into `throttle`/`brake`. The physics needs no changes at all.
- **Overtaking with lateral offset** — cars currently share a 1D line and pass
  through each other. Give each car a lateral offset in metres, perpendicular
  to `bearing`, and add a rule: a faster car within 30 m of a slower one
  offsets by 3.5 m, but only where `radius > 200` (no overtaking in the
  switchbacks). Apply the offset at render time only.
- **Friction circle** — reduce available longitudinal force when cornering:
  `F_long_max = m*g*sqrt(μ_long² − (v²/(R*g))²)`. More realistic corner exits.
- **Weather** — a global multiplier on `muLong` and `muLat` is a one-line
  change that meaningfully reshuffles the field.

---

## 12. Suggested build order

| Step | Outcome | Checkpoint |
|---|---|---|
| 1 | `bake-route.ts` produces valid `route.json` | Curvature histogram looks right |
| 2 | MapLibre renders the basemap and route line | Route visibly follows real roads |
| 3 | One car moves at constant speed along the route | Dot tracks the road correctly |
| 4 | Physics model replaces constant speed | Speed rises and falls with grade |
| 5 | Speed profile + driver controller | Car brakes for corners |
| 6 | All 5 cars, leaderboard | Positions change over the race |
| 7 | Misjudgement noise + crash model (§7.4–7.5) | Incidents fire, only in corners |
| 8 | Car selection, camera follows any car | Click any dot or row mid-race |
| 9 | Multi-route baking + route picker | Three routes, three different races |
| 10 | Elevation strip, time controls, polish | Full acceptance criteria pass |

Do not proceed past step 1 until the curvature check in §5.7 passes. Every
interesting behaviour in this simulation is downstream of that data being
correct.
