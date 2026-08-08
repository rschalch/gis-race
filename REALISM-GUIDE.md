# Realism Guide — Race Engine Improvements

Audience: implementing engineer (Sonnet 5). Written 2026-07-23 after a full read of `src/physics.ts`, `src/driver.ts`, `src/sim.ts`, `src/route.ts`, `src/cars.ts`, `src/rng.ts`, `src/types.ts`, `src/tuning.ts`.

Each item has an ID (R1–R14), a priority, the files it touches, a design sketch, and acceptance criteria. Work **phase by phase, in order** — later phases build on machinery introduced by earlier ones. Within a phase, items are ordered by dependency. After every item: `make check` (typecheck + vitest), and after every phase: the batch-sim validation protocol in §0.4.

---

## 0. Ground rules — read before writing any code

These are invariants of the existing engine. Violating any of them is a regression even if the feature "works".

### 0.1 Determinism

A race seed must reproduce a byte-identical race (existing AC#12). Every source of randomness is either:

- `car.rng` — the per-car stateful mulberry32 stream (`sim.ts:deriveCarSeed`), or
- `valueNoise(x, car.seed)` — pure, stateless (`rng.ts`), used where reproducibility must be independent of call order.

Rules for new stochastic behaviour:

- **Never** use `Math.random()` or wall-clock time inside the sim.
- Per-step hazard draws (crash, reliability) use `car.rng`. Adding a new draw changes the stream consumed by *later* draws, so old seeds will produce different races after your change. That is acceptable — but each new draw must happen **unconditionally at a fixed point in the step order**, or gated on conditions that are themselves deterministic. Never gate an rng draw on floating-point state that could differ across platforms only in the last ulp *and* sits exactly on a threshold — keep gates simple and well away from representational noise.
- Per-driver static traits (e.g. R3's line quality) must be derived from `car.seed` or the spec, **not** drawn from `car.rng` at init (that would offset every subsequent draw and make trait count changes ripple through the whole race).
- Anything that varies smoothly over distance/time (noise-like) uses `valueNoise` with a decorrelated seed: `valueNoise(x, car.seed ^ 0xSOMECONST)` — see how §7.4 misjudgement does it, and pick a distinct XOR constant per new channel.

**On cross-version seed compatibility — decision made, do this:** a seed only reproduces a race on the exact engine version that ran it; nearly every item in this guide changes what a given seed produces. That is fine and expected — do NOT contort any design to keep old seeds replaying identically. What the game needs instead is *honesty about the mismatch*: add an `ENGINE_VERSION` integer constant to `tuning.ts` (start at 2 — the current engine is implicitly 1), bump it in any PR that changes sim behaviour for a given seed (each item's PR note per §6 already tracks this), and record it wherever a race's seed is stored or displayed for sharing/replay (the F4 event-log/summary path, `types.ts:89-97` — e.g. a `RaceRecord`-style header alongside the seed, and the summary screen shows `seed @ v2`). If a replay/shared seed is ever loaded with a non-matching version, the game should warn "recorded on a different engine version — results will differ" rather than silently playing a different race. This is a few lines of bookkeeping now that saves the shareable-replay feature from quietly lying later.

### 0.2 Shared-immutable data

- `speedProfileCache` (`driver.ts:23`) shares one `Float32Array` per `(route object, spec.id, globalCapEnabled)`. **Profiles are immutable.** Any new factor that changes target speeds at *build* time (weather §R7, speed limits §R10) must be added to the cache key string. Any factor that changes over a race (tire wear §R11, damage §R12) must **not** rebuild or mutate the profile — apply it as a runtime multiplier in `driverControl`/`evaluateLossOfControl`/`computeAcceleration` instead (each item below says exactly where).
- `CarSpec` objects are also treated as immutable after `buildCarSpecs`. Race-mutable quantities live on `CarState`, never on `spec`.

### 0.3 Step ordering and cross-car reads

`tick` (`sim.ts:173-177`) steps cars **in roster order** within each fixed `DT`. Once cars can see each other (Phase 2), a car stepped later would otherwise read a mixture of this-step and last-step positions, making results depend on roster order.

**Rule: all cross-car reads use a start-of-step snapshot.** Before the `for (const car of sim.cars)` loop in each `DT` iteration, capture the fields other cars need (`s`, `v`, `status`, `route` reference, and Phase-2's hazard registry) into a plain array, and pass that snapshot into `stepCar`. Cars never read another car's live `CarState` mid-step. Keep the snapshot allocation cheap: reuse a preallocated array on the `Sim` object, don't allocate per step (see the existing garbage-consciousness note at `sim.ts:166-171`).

### 0.4 Validation protocol (run after every phase)

The user's explicit preference: **incidents rare** — the low end of §7.5's "one or two incidents per five-car race" guidance. The existing constants (`CRASH_K = 0.03`, `CRASH_EXP = 1.6` in `tuning.ts`) were tuned for that. Several items below change how often cars approach the grip limit, which changes incident rates *without touching those constants*.

There is no batch harness in `tools/` today. **First task of Phase 1: write `tools/sim-batch.ts`** (tsx-runnable, mirroring how `tools/bake-route.ts` is wired) that:

1. Loads a baked route JSON straight from `public/data/routes/` with `fs` (do not use `src/route.ts`'s `loadRoute` — it fetches) and validates with `assertRoute`.
2. Loads `public/data/cars.json` through `buildCarSpecs`.
3. Runs N seeded races (default 30; seeds 1..N) headlessly by calling `createSim` + `tick` in a loop with a large `realDeltaSeconds` per call, until `sim.raceOver`.
4. Prints per-race and aggregate: incidents by severity, retirements, finish order, finish-time spread, and mean/min/max of peak friction-circle utilisation.

Pass criteria after each phase, on the primary long route:

- Aggregate slide+spin rate stays in the rare band (≈0.2–0.4 incidents per car per race); retirement (off-road) rate ≤ 2% of car-races.
- No car finishes with a time obviously broken relative to its spec (e.g. Chiron behind a Type R on a flat straight route).
- Zero NaN/Infinity in any `CarState` field at race end (add an assert to the harness).

If rates drift out of band, prefer fixing the *behaviour* (e.g. lookahead tuning) over re-tuning `CRASH_K` — the crash constants are calibrated to the user's preference and should be the last thing touched.

### 0.5 Housekeeping rules

- Every new tuning constant goes in `src/tuning.ts` with a comment in the existing style (what it is, why that value). No magic numbers in `driver.ts`/`sim.ts`/`physics.ts`.
- Every new event kind extends the `RaceEvent` union in `types.ts` (`type` currently only `'incident'`) and is pushed via `sim.events` — see the F4 design note at `types.ts:89-97`. The UI can ignore unknown types; don't block sim work on rendering.
- New per-point route fields (Phase 3) must be **optional with safe defaults** so all existing baked routes in `public/data/routes/` keep loading. Update `assertRoute` (`route.ts`) to validate them *only when present*, and update the baker's runtime-facing point narrowing (see the P5 note at `types.ts:1-8`) in `tools/bakeRoute.ts`.
- Tests: every item lists what to test. Follow the existing style — pure-function tests against `test-fixtures.ts` routes, no DOM, no fetch (see `driver.test.ts`, `sim.test.ts`).

---

### 0.6 Addendum — findings that postdate R1-R14

Added after a validation pass against the *shipped* content (28-car roster on
the 225 km Sorocaba-Monte Verde route) rather than the 14-car/sorocaba-campos
configuration the original constants were tuned on. Read alongside §0.4.

- **§0.4's two pass criteria cannot both be satisfied here.** It asks for
  slide+spin in 0.2-0.4 per car-race *and* off-road retirements ≤ 2%. Those are
  not independent: severity is decided by where one utilisation distribution
  falls across the slide/spin/off-road thresholds, so pushing slide+spin up to
  0.2 drags off-road to roughly 5-7%. The ≤2% ceiling wins (it is the criterion
  that removes cars from a race, and it matches the standing preference for
  rare incidents); slide+spin currently sits below the stated band. The 0.2-0.4
  figure also predates the roster doubling — per *race* it now means 5-11
  incidents across 28 cars, which is not "rare" on any reading.

- **The cornering plan had no risk margin at all.** `computeSpeedProfile`
  targeted exactly the grip limit, so an `aggression = 1.00` driver planned
  every binding corner at U = 1.000 — above `SLIDE_UTILISATION_THRESHOLD`
  (0.95) for the whole corner. `CORNER_UTILISATION_TARGET` now supplies that
  margin. See its comment in `tuning.ts` for the measured evidence and sweep.

- **`aggression` was doing two unrelated jobs.** It scaled both the cornering
  plan and the tolerance to posted speed limits. On a route that is ~90%
  limit-tagged the second use dominated finish times, so cornering bravery
  outweighed power, mass, drag and grip combined. Split into `limitTolerance`
  — keep them separate.

- **Validation is cheap now.** `tools/sim-batch.ts` runs seeds across worker
  threads (~4x). There is no longer a reason to skip the §0.4 protocol after a
  phase. `src/golden.test.ts` additionally pins one whole race end-to-end, so
  unintended behaviour drift fails `make check` rather than being discovered
  later.

---

## Phase 1 — Driver model (fix the two big fudges)

The current controller is purely reactive (`driver.ts:81-116`): it brakes only once `v` exceeds the interpolated target. Two consequences: `BRAKE_SAFETY_MARGIN = 0.5` throws away half the braking capability to compensate for zero anticipation (see the long comment in `tuning.ts:18-28`), and throttle is commanded with no knowledge of lateral load, so mid-corner throttle overshoot is a major *artificial* crash source. Fix the behaviour, then reclaim the margin.

### R1 — Lookahead braking · **High** · `driver.ts`, `tuning.ts`

Replace "brake when over target" with "brake when a *future* target requires it".

**Design.** In `driverControl`, scan the profile ahead of the car over a horizon of `LOOKAHEAD_MAX_M` (suggest 300 m, enough for ~36 m/s → hairpin from any speed in this sim). For each profile point `j` ahead at distance `d = route.points[j].s − s` with target `vj = profile[j]`:

```
aReq(j) = (v² − vj²) / (2·d)     // decel needed to hit vj at j, if vj < v
```

Let `aReqMax` be the max over the horizon (early-exit the scan once `d` is large enough that even `vj = 0` can't demand more than the current max — keeps it O(few) per step). The car's usable braking decel is `aCap = muLong·G·cos(grade)·BRAKE_EFFORT + G·sin(grade)` (same form as the backward pass, `driver.ts:67`).

Controller decision, replacing the current three-branch block:

1. If `aReqMax > BRAKE_TRIGGER_FRACTION · aCap` (suggest 0.9): brake with `brake = min(1, aReqMax / aCap)`. This produces late, firm, human-looking braking.
2. Else fall through to the existing proportional throttle/maintain logic against the *interpolated current* target (keep the §7.4 misjudgement noise exactly where it is — applied to the target, `driver.ts:105-106`).

**Reclaim the margin.** With anticipation in place, raise `BRAKE_SAFETY_MARGIN` from `0.5` toward `0.85` **in steps of 0.1**, running the §0.4 batch at each step. Stop at the highest value that keeps incident rates in band. Rewrite the `tuning.ts` comment to describe the new relationship (margin now covers noise + discretization, not the absence of anticipation). Expect overall pace to rise noticeably — that is the point (cars currently tiptoe into corners).

**Tests.** (a) On a fixture route with a straight into a tight corner: car begins braking *before* crossing the target-speed step, and arrival speed at the corner point is within 5% of the profile value. (b) `aReq` scan returns 0 demand on a uniform-target route (no phantom braking). (c) Determinism: two runs, same seed → identical `finishTime`.

### R2 — Friction-circle-aware throttle · **High** · `driver.ts`, `tuning.ts`

Drivers currently command up to full throttle regardless of cornering load; §7.5 then punishes them probabilistically. Give the controller the same friction-circle model the crash check uses, so staying inside the circle is *skill*, not luck.

**Design.** In `driverControl`, compute current lateral utilisation exactly as `evaluateLossOfControl` does (`driver.ts:131-134`): `U = (v²/radiusAt(route, s)) / (muLat·G)`. Longitudinal budget fraction: `budget = sqrt(max(0, 1 − U²))`. Then:

- Cap throttle: `throttle = min(throttleFromController, budget · THROTTLE_CIRCLE_HEADROOM)` (suggest headroom 0.95 — drivers leave a sliver).
- Cap brake the same way (`brake ≤ budget · headroom`) — trail-braking over the limit is exactly how the current model spins cars under braking into corners. R1's earlier braking is what makes this cap safe: demand should rarely exceed budget once anticipation exists. If batch runs show cars arriving hot *because* the brake cap bit, the bug is in R1's trigger fraction, not here.

Note the asymmetry with physics: the cap uses the *commanded* fraction, and `computeAcceleration` already converts commands to forces. Don't duplicate force math in the driver — work in utilisation fractions only.

**Interaction with aggression.** `spec.aggression > 1` drivers target corner speeds above the true limit (`types.ts:54-56`), i.e. they run `U ≥ 1` on purpose and `budget` hits 0. `budget = 0` must mean "no throttle, no *added* brake command", not a hard clamp fighting the profile — they coast through the apex at the edge, which is exactly the §7.3 risk trade-off working as intended. Make sure the crash probability path (`evaluateLossOfControl`) is untouched by this item.

**Tests.** (a) Mid-corner (small radius, high v) throttle is strictly less than straight-line throttle at same speed error. (b) `budget` math: U=0 → 1, U=1 → 0, monotone in between. (c) Batch check: slide-severity incidents drop vs. pre-R2 baseline with all constants equal (log both in the PR description).

### R3 — Racing line as an effective-radius factor · **Medium** · `types.ts`, `cars.ts`, `driver.ts`, `public/data/cars.json`

Cars track the road centerline; real drivers straighten corners. Full lateral dynamics is out of scope (deliberately — see §5). A per-driver scalar captures most of the visible effect.

**Design.** Add optional `lineQuality` to `RawCarSpec`/`CarSpec` (range 1.00–1.15, default 1.05; validate range in `assertCars`). It multiplies the radius the driver *plans and drives*: in `computeSpeedProfileUncached` step 1 use `radius · lineQuality` inside the sqrt, and in both `driverControl` (R2's `U`) and `evaluateLossOfControl` use `radiusAt(...) · lineQuality`. The crash check and the plan must use the **same** effective radius — if the check uses raw radius while the plan uses widened radius, every corner becomes a phantom crash zone.

Add `lineQuality` to the speed-profile cache key (it changes the profile). Set per-car values in `cars.json` with the same honest sourcing note style used there (it's a driver trait, like `aggression`). Suggested spread: precision cars/drivers (911, R8) 1.10; the heavy Chiron 1.03; keep the field *out* of any UI for now.

**Tests.** Profile with `lineQuality: 1.1` is pointwise ≥ profile with 1.0 on a curvy fixture; equal on a straight.

---

## Phase 2 — Cars exist for each other

Everything here depends on the §0.3 snapshot. Build that first (it's a refactor of `tick`/`stepCar` signatures with zero behaviour change — land it as its own commit with the batch confirming identical results for a given seed).

New event types for this phase: extend `RaceEvent['type']` to `'incident' | 'overtake' | 'finish'`. (`finish` is nearly free once you're in there: push it where `status` flips to `'finished'` in `stepCar` — the summary screen will want it.)

### R4 — Slipstream (drafting) · **High** · `physics.ts`, `sim.ts`, `tuning.ts`

**Design.** A car receives reduced aerodynamic drag when closely following another car **on the same route** (`route` reference equality — variants of a course are different roads; no drafting across them). From the snapshot, find the nearest car ahead (`other.s > car.s`, both `racing`), gap `g = other.s − car.s`. If `g < DRAFT_MAX_GAP_M` (suggest 30):

```
dragFactor = DRAFT_MIN_FACTOR + (1 − DRAFT_MIN_FACTOR) · (g / DRAFT_MAX_GAP_M)   // suggest MIN 0.65
```

Pass `dragFactor` into `computeAcceleration` as a new optional field on `ForceInputs` (default 1) multiplying `fDrag` (`physics.ts:26`). Only the *follower* benefits; ignore multi-car chains beyond nearest-ahead (good enough, cheap). Drag at these speeds is modest, so the effect is a nudge, not a slingshot — that's realistic for road cars. Nearest-ahead search: cars-per-route is small (≤ 14); a linear scan over the snapshot per car per step is fine — no spatial index.

**Tests.** (a) Two identical cars, one started 20 m behind: follower's net `a` at equal `v` exceeds leader's. (b) Different routes → no effect. (c) Batch: finish-time spread tightens slightly; incident rate unchanged (drafting must not push cars over corner limits — it only helps on straights where drag dominates; confirm slide locations don't shift into straights).

### R5 — Blocking and overtaking on the same route · **High** · `sim.ts`, `driver.ts` (small), `tuning.ts`, `types.ts`

Cars currently pass through each other. Model the *time cost* of traffic without lateral dynamics.

**Design.** After computing driver output but before integration, in `stepCar`: from the snapshot, nearest same-route car ahead within `BLOCK_GAP_M` (suggest 12 m) that is `racing` or `spinning` and slower (`other.v < car.v`).

- **Blocked state:** cap the follower's *target*: clamp `car.v` growth so it doesn't close inside `BLOCK_MIN_GAP_M` (suggest 6 m): if next-step `s` would come within the min gap, set `v` to the leader's snapshot `v · BLOCK_FOLLOW_FACTOR` (suggest 0.98) instead. Simple, stable, no oscillation because the gap re-opens slowly.
- **Passing:** allowed when the local road opens up: `radiusAt(route, car.s) > PASS_MIN_RADIUS_M` (suggest 350 — wide sweeper or straight). When allowed, drop the block cap entirely (the faster car simply drives by; they're on different imaginary lines for those seconds). On the step where follower's `s` passes leader's `s`, push a `RaceEvent { type: 'overtake', carId, data: { passedId } }` — define a small payload type; the HUD feed can render it later.
- A car passing a **spinning** car is always allowed (it's stationary at the roadside) — but see R6.

Ordering note: the pass/block decision reads only snapshot state; two cars mutually blocked (shouldn't happen — one is faster) must not deadlock: tie-break by roster order is fine and deterministic.

**Tests.** (a) Fast car behind slow car on a tight-radius fixture: gap never drops below min gap, and follower `v` ≈ leader `v`. (b) Same setup on a straight (radius 5000): overtake event fires, order swaps. (c) Determinism across runs.

### R6 — Incident awareness (local caution) · **Medium** · `sim.ts`, `driver.ts` (target clamp), `tuning.ts`

Cars blast past wrecks at racing speed. Real drivers lift.

**Design.** Maintain on `Sim` a per-route hazard list: when a car's incident of severity `spin` or `off-road` occurs, register `{ routeRef, s, until: simTime + CAUTION_DURATION_S }` (suggest 90 s; off-road wrecks *also* expire — assume marshals clear it). In `stepCar`, if any active hazard on the car's route lies ahead within `CAUTION_AHEAD_M` (suggest 150) or behind within `CAUTION_BEHIND_M` (suggest 30), cap the driver's target speed at `CAUTION_SPEED` (suggest 22 m/s ≈ 80 km/h): cheapest correct place is a clamp on the interpolated target inside `driverControl` — pass the cap in as an optional arg from `stepCar` rather than teaching `driverControl` about the world. Prune expired hazards once per tick, not per car.

The slowdown is itself a realism win *and* an emergent safety effect: cars arriving at a corner where someone just spun were probably candidates to spin there too.

**Tests.** (a) Car approaching a fresh spin site decelerates to ≤ cap before reaching it, resumes after passing + expiry. (b) Hazard on a *different* route variant: no effect. (c) Batch: expect a small drop in incident clustering (multiple cars crashing at the same corner in the same window) — report before/after.

---

## Phase 3 — Environment

### R7 — Weather as a grip multiplier · **High** (cheapest big win) · `tuning.ts`, `driver.ts`, `physics.ts`, `sim.ts`, config panel

**Design.** One race-level condition, fixed for the whole race (dynamic weather is a later feature; the event-log architecture already anticipates it — `types.ts:96`):

```ts
export type Weather = 'dry' | 'damp' | 'wet';
export const WEATHER_GRIP: Record<Weather, number> = { dry: 1.0, damp: 0.85, wet: 0.70 };
export const WEATHER_ERROR_MULT: Record<Weather, number> = { dry: 1.0, damp: 1.3, wet: 1.6 };
```

Grip multiplier applies to **both** `muLat` and `muLong` everywhere they're read: `computeSpeedProfileUncached` (corner limit + backward pass), `computeAcceleration` (traction/brake caps), `evaluateLossOfControl` (gripAvailable, longUsed denominator), and R1's `aCap`. Thread it as a parameter (`effectiveGrip` multiplier on the spec values at each site) — do **not** clone mutated specs (§0.2). Error multiplier scales `spec.errorSigma` at its single use site (`driver.ts:105`). Add weather to the speed-profile cache key.

Plumbing: `createSim` gains an options arg carrying `weather` (default `'dry'`); `Sim` stores it; config panel gets a three-way select next to the existing `globalCapEnabled` toggle, applied on race reset (mirror how `globalCapEnabled` flows today, `main.ts`). Store per-car effective multipliers once at car creation, not per step.

**Why profile *and* runtime must both scale:** if only runtime grip drops, drivers plan dry speeds on a wet road and every corner is a crash site; if only the profile drops, cars are unrealistically safe. Scaling both keeps drivers driving *to the conditions* with the same §7.3 risk margins — the batch (§0.4) should show wet incident rates only modestly above dry (drivers slow down; they don't all crash). Run the batch per weather setting.

**Tests.** (a) Wet profile pointwise ≤ dry profile; corner-limited points scale by `sqrt(0.70)`. (b) Wet braking distances lengthen (integration test on a fixture). (c) Cache: dry and wet profiles coexist without eviction.

### R8 — Road surface from OSM · **Medium** · `tools/bakeRoute.ts`, `types.ts`, `route.ts`, `driver.ts`, `physics.ts`

Route choice should matter physically — this is a GIS racer.

**Design.** Add optional `surface?: number` (grip factor, default 1.0) to `RoutePoint`. Sourcing: OSRM's route response does not carry OSM way tags; the baker must query **Overpass** for `surface=*` along the route corridor (bbox of the polyline, `way[highway][surface]`), then map each sampled point to the nearest tagged way within ~20 m. Mapping: `asphalt/paved/concrete → 1.0`, `paving_stones/compacted → 0.9`, `cobblestone/sett → 0.8`, `gravel/fine_gravel → 0.7`, `dirt/ground/unpaved → 0.6`, untagged → 1.0. Smooth with the same window the baker uses for elevation so grip doesn't step discontinuously.

Runtime: multiply grip exactly like weather (compose: `effective = weatherGrip · surfaceGrip(point)`), sampled via `interpolateAt` — add `surface` to `RouteSample` interpolation (default 1 when absent). Profile build reads per-point surface; runtime reads interpolated. **Schema compat per §0.5**: field optional, `assertRoute` validates finiteness only when present, old routes untouched. Bump nothing — absence means 1.0.

Baker resilience: Overpass is flaky — on query failure, warn and bake with all-1.0 surfaces rather than failing the bake (mirror however bakeRoute currently handles OSRM errors; check its retry/error style before writing new machinery).

**Tests.** Baker: mapping table unit test; point-to-way assignment on a synthetic fixture. Runtime: profile on a gravel-tagged fixture is slower than asphalt; `interpolateAt` defaults to 1.0 for legacy routes.

### R9 — Elevation-dependent air density (and drag) · **Low–Medium** · `physics.ts`, `tuning.ts`, `sim.ts`

`AIR_DENSITY` is a single constant chosen for ~800 m routes (`tuning.ts:10`) — wrong at both ends of a mountain route.

**Design.** `rho(ele) = 1.225 · exp(−ele / 8500)`. `stepCar` already interpolates the route point (`sim.ts:133`) — pass `ele` into `computeAcceleration` (new `ForceInputs` field) and compute `rho` there; delete `AIR_DENSITY`. Optionally derate engine power for altitude: naturally-aspirated power ≈ ∝ density, but the roster mixes NA/turbo/hybrid and `cars.json` doesn't record induction. Do the honest version: add optional `induction?: 'na' | 'forced'` to `RawCarSpec` (default `'forced'` = no derate, the conservative choice for this roster), NA cars get `power · (rho/1.225)`. Set the field for the cars where it's known (911 GT3 na, R8 na, Corvette Z06 na …) in the same verified-sourcing pass style used before (see cars.json `notes` conventions).

Drag differences also perturb the *profile*? No — the profile is grip/brake-limited, not drag-limited (drag doesn't appear in `computeSpeedProfileUncached`), so no cache-key change. State that in a comment where `rho` is computed.

**Tests.** `rho(0) = 1.225`, `rho(800) ≈ 1.116` (close to today's constant — behaviour change is small, deliberate); NA car's top speed on a 2000 m plateau fixture < same car at sea level.

### R10 — Per-way legal speed limits · **Low (stretch)** · `tools/bakeRoute.ts`, `types.ts`, `driver.ts`

`GLOBAL_CAP = 36 m/s` is a flat stand-in (`tuning.ts:12-16`). Real `maxspeed` data makes the cap local and meaningful.

**Design.** Same Overpass pass as R8 (do them together; one query can fetch both tags): optional `limit?: number` (m/s) per `RoutePoint`, absent where untagged. In `computeSpeedProfileUncached` step 2, when `globalCapEnabled` and the point has a limit, cap at `limit · LIMIT_TOLERANCE(spec)` where tolerance derives from aggression (e.g. `0.9 + 0.2·(aggression − 0.9)/0.2` → timid drivers under the limit, aggressive ones ~10% over); fall back to `GLOBAL_CAP` where untagged. Rename the config toggle's meaning accordingly ("obey speed limits"). Cache key: unchanged (`globalCapEnabled` already in it; limits are route data, and route identity keys the outer WeakMap).

Honest scope warning: `maxspeed` coverage on rural Brazilian roads is patchy; expect most points to fall back. Ship it data-tolerant or don't ship it — never fabricate limits from road class in v1.

**Tests.** Profile respects a tagged 60 km/h zone on a fixture; untagged fixture identical to today's output.

---

## Phase 4 — Attrition: tires, damage, reliability, powertrain

These give races a *narrative arc*. R11 and R12 share one mechanism — build it once.

### R11 — Tire degradation · **Medium** · `types.ts`, `sim.ts`, `driver.ts`, `physics.ts`, `tuning.ts`

**Design.** Add to `CarState`: `tireWear: number` (0 fresh → 1 fully worn) and `condition: { grip: number; cdA: number }` (the shared R11/R12 "effective condition" multipliers, both start 1). Per step, in `stepCar` after `evaluateLossOfControl`:

```
wearRate = TIRE_WEAR_BASE_PER_M + TIRE_WEAR_LOAD_PER_M · total²   // total = friction-circle utilisation, already computed
tireWear += wearRate · v · dt                                      // wear per metre, so pace costs rubber
gripFromWear = 1 − TIRE_WEAR_MAX_GRIP_LOSS · tireWear             // suggest max loss 0.06
```

Calibrate `TIRE_WEAR_BASE_PER_M` so a 265 km race at typical utilisation lands around `tireWear ≈ 0.7` — wear should *shape* the last third, not zero out. `evaluateLossOfControl` needs `total` surfaced — it already computes it; return it (change the function to return the utilisation instead of `void`; `stepCar` is its only caller outside tests).

**Where the multiplier applies — the critical design point.** `condition.grip · gripFromWear` composes with weather/surface into the same `effectiveGrip` channel from R7, at the same three runtime sites. The *profile* must NOT be rebuilt (§0.2). Instead the **driver adapts**: in `driverControl`, scale the interpolated target by `sqrt(effectiveGripRuntime / effectiveGripAtProfileBuild)` — cornering speed goes with the square root of grip, so this keeps planned utilisation ≈ constant as tires fade. That single line is what makes worn cars *slower* instead of *crashier*; without it every long race ends in a crash festival and the §0.4 gate fails.

**Tests.** (a) Wear monotonically increases, faster in a high-utilisation fixture than a cruise. (b) Late-race target speeds < early-race at the same `s` for a worn car. (c) Batch on the long route: incident rate in the final third stays in band (this is the test that catches getting the sqrt adaptation wrong).

### R12 — Persistent incident damage · **Low–Medium** · `driver.ts` (`triggerIncident`), `tuning.ts`

Slides and spins currently cost only time. Make contactless damage mild but permanent: in `triggerIncident`, on `slide`: `condition.grip ·= 0.995` (flat-spotted tires); on `spin`: `condition.grip ·= 0.98`, `condition.cdA ·= 1.02` (bodywork through the grass). Multipliers stack across incidents. `condition.cdA` multiplies `cdA` in `computeAcceleration`. Floor `condition.grip` at 0.9 — damage never makes the car undriveable, it makes it *slower* (the driver-adaptation line from R11 handles the rest automatically — same channel).

**Tests.** Post-spin car's effective grip and drag reflect the multipliers; two spins stack multiplicatively; floor holds.

### R13 — Mechanical reliability (DNFs) · **Low–Medium** · `sim.ts`, `driver.ts` or new `reliability.ts`, `tuning.ts`, `types.ts`

The only retirement today is crashing off-road. Add the other classic heartbreak.

**Design.** Per step, per racing car, hazard `λ = RELIABILITY_BASE_PER_S + RELIABILITY_LOAD_PER_S · throttle` (stress scales with sustained load). Draw `car.rng()` **every step, unconditionally** (§0.1 — an unconditional draw keeps the stream layout stable regardless of throttle state) against `1 − exp(−λ·dt)`. On failure: `status = 'retired'`, coast `v` to 0 over a few seconds rather than teleport-stopping (reuse the spinning-state decay pattern, or simply set throttle/brake 0 with status `'retired'` handled in the integrator — pick whichever needs less special-casing, but the car must visibly roll to a stop). Push a new `Incident`-like event; extend `Incident['severity']` with `'mechanical'` (check every `switch`/severity consumer in `src/render/` — the HUD styles severities).

Calibrate `RELIABILITY_*` so a 14-car, ~2 h race sees **0–1 mechanical DNFs typically** (say ~4% per car per race). This matches the user's rare-incident preference; mechanical DNFs must feel like events, not weather. Note in the PR: this adds an rng draw per step, so all seeds re-shuffle (§0.1, accepted).

**Tests.** (a) λ math: expected failures over N seeded races within ±50% of analytic value. (b) Zero throttle → hazard = base only. (c) A retired-mechanical car rolls to a stop (v strictly decreasing to 0) and never rejoins.

### R14 — Powertrain shape (optional polish) · **Low** · `physics.ts`, `cars.ts`, `types.ts`

`P / max(v, 5)` (`physics.ts:25`) means every car is a constant-power blob above 18 km/h; the grip cap handles launch. The 5 m/s floor is also a hidden physics knob. Minimal honest upgrade: per-car `peakPowerSpeed?: number` (m/s, default 5 to preserve behaviour) — force is `min(P / peakPowerSpeed, P / v)` capped by grip, i.e. constant-torque below the peak-power speed, constant-power above. Set real-ish values (a 911 GT3 revs to peak power at high road speed in each gear; approximating with ~15–20 m/s effective is fine — document the hand-wave in cars.json notes). Gear-step ripple is cosmetic; skip it.

**Tests.** Default value reproduces current acceleration exactly (regression fixture); higher `peakPowerSpeed` softens 0–100 km/h times plausibly.

---

## 5. Explicitly out of scope (do not attempt)

- **Full lateral/2D vehicle dynamics** (slip angles, yaw). It rewrites the sim core; R2+R3 capture most visible benefit. The bead-on-a-wire model is a feature, not a debt.
- **Dynamic weather mid-race** — R7 lays the data path; the event type (`types.ts:96` anticipates `'weather change'`) comes later.
- **Fuel load / pit stops** — point-to-point road races here have no pit lane.
- **Re-tuning `CRASH_K`/`CRASH_EXP`** except as a last resort per §0.4, and never without a before/after batch report.

## 6. Suggested landing order & commit shape

One commit (or PR) per item ID, each passing `make check` + the relevant §0.4 batch. Interleave nothing. The snapshot refactor (§0.3) is its own zero-behaviour-change commit before R4. Sequence:

`sim-batch harness` → R1 → R2 → R3 → *(snapshot refactor)* → R4 → R5 → R6 → R7 → R9 → R8+R10 (shared Overpass work) → R11 → R12 → R13 → R14.

Each PR description must include: batch incident-rate table (before/after, per severity), any constant changed and why, and — where §0.1 applies — an `ENGINE_VERSION` bump per the cross-version note in §0.1 (one bump per PR that changes seed outcomes; no bump for pure refactors like the §0.3 snapshot commit, which the batch must prove behaviour-identical).

---

## M1 — Motorcycles (added after R1-R14)

Motorcycles race the same one-dimensional `(s, v)` simulation as cars. Nothing
about the model changed to accommodate them: `CarSpec.type` selects between a
handful of type-gated branches, and every one of them falls back to the car
value for `type: 'car'`. `src/golden.test.ts` passes unchanged across this
work, which is the evidence that car races are bit-identical.

### The four differences

| Difference | Where | Why |
| --- | --- | --- |
| **Pitch-over ceiling** (`spec.pitchLimitG`) | `physics.ts`, and `brakeCapability` in `driver.ts` | A bike lifts a wheel before it slides one. Acceleration *and* braking are capped at a geometric limit (1.0–1.45 g by machine) that sits below what the tyres could give — which is why a 200 hp/280 kg superbike cannot deploy its power at low speed and cannot out-brake a good car. `Infinity` for cars makes both `Math.min` calls exact no-ops. |
| **Weather** (`MOTORCYCLE_WEATHER_GRIP`) | `weatherGripFor` in `driver.ts` | Cornering force comes from lean angle, and a wet road takes lean away with no fourth contact patch to catch the slide. 0.58 wet against a car's 0.70. |
| **Rider margin** (`MOTORCYCLE_CORNER_UTILISATION_TARGET`) | profile build | A rider plans to 0.88 of the grip limit where a driver plans to 0.93 — the consequences are not symmetric. This is also what makes wet racing survivable; see the calibration note on the constant. |
| **Consequences** (`MOTORCYCLE_SEVERITY_SHIFT`, `MOTORCYCLE_RECOVERY_MULT`, `TIRE_WEAR_MOTORCYCLE_MULT`) | `triggerIncident`, `stepCar` | One utilisation distribution still decides severity; a bike just reaches the worse band 0.03 sooner, stays down 1.6× longer, and wears its tyres 1.3× faster. |

### Measured outcome (shipped 225 km route, 12 seeds, four superbikes against four supercars)

- **Dry:** superbikes 8,614–8,626 s, supercars 8,713–8,724 s — the bikes win by
  about 95 s (1.1 %).
- **Wet:** the cars win by roughly 150 s, with far wider spread on the bikes.
- Incident rates over 30 seeds, dry: cars 0.096 crash-related per car-race,
  bikes 0.092. Retirements are dominated by R13 mechanical failures at ~4 % for
  both — a **pre-existing** rate on this route, not something M1 introduced, and
  above §0.4's ≤2 % criterion for cars just as much as for bikes.
- Wet bikes collect slides rather than retirements (1.4/race): at full step rate
  their utilisation distribution is *tighter* than a car's, but it dwells in the
  0.9–1.0 band where slides are drawn.

### Calibration history (things that did not work)

- `TIRE_WEAR_MOTORCYCLE_MULT = 1.7` pinned every bike's `tireWear` at exactly
  1.00 by the end of the route, including a Gold Wing — the model saturating
  instead of differentiating. 1.3 lands them near 0.85.
- `MOTORCYCLE_SEVERITY_SHIFT = 0.06` retired 83 % of the motorcycle field in the
  wet, almost all late-race at U just past the shifted ceiling, because R11 wear
  raises utilisation exactly when the ceiling is lowest.
- Rider `errorSigma` was first set at 0.040–0.045 against a car mean of 0.032,
  on no evidence. Riders are not sloppier than drivers about speed; ×1.6 wet
  amplification then made that noise alone the dominant crash source. Now
  0.026–0.035.

### Verification pass

The roster was audited a second time by working the physics backwards from
each entry rather than re-reading the spec sheets, and that found errors the
first pass could not have caught by inspection. `src/roster-data.test.ts` now
runs the whole audit on every `make check`, so none of it can silently return.

**The pitch ceiling was inert on the machines it was written for.** Superbikes
were authored with `muLong` 1.05 against a `pitchLimitG` of 1.10 — so tyre grip
bound first, and M1's headline constraint did nothing at all on any sportbike.
Real sport rubber is good for ~1.25 g while the bike lifts a wheel at ~1.1 g,
which is the entire point. Sport, naked, track and electric archetypes now
carry `muLong` 1.15–1.30, and 35 of 50 bikes are genuinely pitch-limited; the
other 15 (Hayabusa, ZX-14R, cruisers, adventure bikes) stay traction-limited,
which is correct for long, low or soft-tyred machines. Two tests pin which
group each machine belongs to.

**14 of 50 quoted top speeds were unreachable** on the bike's own power and
drag — brochure claims rather than measured figures. Corrected against tested
numbers: a Honda CB1000R measures 230 km/h, not 250 (its speedometer reads
154 mph where the bike is doing 143); a KTM 1290 Super Duke R is GPS-verified
around 268–280 against a 289 claim; the Ninja H2R's real figure is Kawasaki's
own 380 km/h with 326 hp on ram air — the famous 400 km/h was a speedometer
reading on a closed bridge, unverified, on a probably non-stock bike. Where the
machine really does hit its claim (MV Agusta Brutale 1000 RR), the drag area
was lowered instead, since that claim assumes a rider flat on the tank.

**`muLat` is `tan(lean angle)` on two wheels**, so every cornering coefficient
is a checkable claim about geometry. The implied angles came out at 48° for a
superbike and 41° for an adventure bike (both right), but 34° for a cruiser and
38° for a full tourer — more lean than either can carry before hard parts
touch down. Now 32° and 36°.

**The acceleration model is optimistic, and it is not a motorcycle problem.**
Modelled 0–100 km/h runs fast against published figures by a mean of 1.25 s
across 22 cars, worst at the slow end (Fiat Uno −6.8 s, Mobi −5.2 s, Camry
−3.1 s) — R14's constant-torque region has no clutch or gearing model. The
bikes sit inside that same band (Gold Wing −1.4 s, R6 −0.7 s), and superbikes
actually land closer to reality than the cars do (2.78–2.96 s modelled against
2.9–3.1 s published). Left alone deliberately: distorting motorcycle data to
compensate for a roster-wide property of R14 would hide it.

**The two rosters had never been cross-checked against each other.** The bike
grip bands above are physically audited; the car bands predate them and were
authored conservatively — so every sport bike out-braked every car in the game
(effective braking 1.08–1.15 g against a best car `muLong` of 0.98) and
out-cornered every car including an Aventador SVJ (`muLat` 1.12 vs 1.04),
inverting the intent stated in this section's table that a superbike "cannot
out-brake a good car". Fixed on the car side, since the bike numbers survive
their own audit: 95 modern performance-and-up cars re-rated to measured
carbon-ceramic / track-rubber levels — track specials (Senna, SVJ, GT2 RS,
Black Series…) `muLat`/`muLong` 1.08–1.15, modern supercars and hypercars
`muLong` 1.05–1.08, modern performance cars `muLong` ≈ 1.0, performance SUVs
0.95. Analog classics (F40, Countach, McLaren F1…) keep period grip on
purpose, and bikes legitimately still out-accelerate everything out of slow
corners — the pitch cap, not power, binds there. Data-only (each touched
entry's `notes` records the old → new values); no engine change, so no
ENGINE_VERSION bump.

## R15 — Engine heat-soak (added after M1)

R13's hazard reads *instantaneous* throttle, which is memoryless: a machine
held wide open for an hour was no more likely to let go in the next second
than one that had just opened up. With speed limits disabled that let a
380 km/h hyperbike sit at vMax for an entire course with only the flat load
term to answer for it — spotted by a user asking, reasonably, "wouldn't that
crash the motor?"

**Design.** Each car carries `engineLoad`, an exponential moving average of
throttle (`ENGINE_LOAD_TAU_S` = 45 s), updated in `stepCar` just before the
R13 draw reads it — pure state, no rng, so the §0.1 draw layout is
untouched. `reliabilityHazardRate` scales its load term by up to
`1 + ENGINE_STRESS_MULT` (4×) as the average rises from
`ENGINE_LOAD_NEUTRAL` (0.7) toward 1. At or below neutral there is no
penalty at all. Holding top speed *is* sustained full load — vMax is by
definition the full-power point — which is exactly the case this prices.
The HUD telemetry strip shows the smoothed load as an "Engine" bar.

**Measured** (10–40 seeds each): the shipped capped format is untouched
(mechanical DNFs 5.0% of car-races before and after — limit-bound cruising
runs single-digit throttle). Uncapped on a twisty 100 km course, mechanical
DNFs rose 4.5% → 6.5% of car-races: corners give the engine breathers, so
the average sits only intermittently above neutral, which is the intended
shape. The headline case — an H2R flat-out on a 150 km straight — settles at
`engineLoad` ≈ 0.86 and now blows up in 12.5% of 25-minute runs (~2.4%
before); held for a full 90-minute course that compounds to roughly a
one-in-four mechanical DNF. ENGINE_VERSION 6 → 7 (the golden race's draws
all miss the shifted thresholds, so its recorded constants survived).

## R16–R19 — the v8 batch (added after R15)

Four items landed together as ENGINE_VERSION 8, alongside one diagnosis that
changed a *metric* rather than the engine.

**The "late-race crash spike" was geometry, not a wear leak.** Uncapped
batches on the Serra routes showed crashes clustering in the final third
(e.g. 9/2/23), which read like R11's adaptation failing. Per-incident
diagnosis showed otherwise: the final third of sorocaba–monte verde holds
581 tight-corner (<120 m radius) points against 22/12 in the first two, and
per unit of that exposure the late-race crash rate is actually the *lowest*
of the three thirds (0.32/0.08/0.03 measured post-batch) — worn tyres cost
pace, not risk, exactly as designed. sim-batch now prints the exposure-
normalized ratio alongside the raw counts, and `sim.test.ts` pins the
adaptation on a uniform-risk route (100 km of constant cornering: the car
ends worn, measurably slower, and crash-free).

**R16 — wind.** One wind vector per race: a strength preset in race config
(calm/breezy/windy — 0/4/9 m/s, Beaufort anchors), a compass direction drawn
deterministically from the race seed (`windDirectionRad`, a throwaway PRNG
stream — not `car.rng`, which §0.1 forbids shifting). The road's per-point
bearing (`pointBearingsRad` — a route *property* like grade, not car state;
the sim stays 1D) is projected against it once at `createSim`, and physics
subtracts the tailwind component from ground speed before the drag term
(signed `vAir·|vAir|`). Measured on a 50 km straight: a windy tailwind saves
~13 s, a windy headwind costs ~50 s (asymmetric because drag is quadratic
and the top end is power-limited); on a twisty Serra course the components
largely cancel — which is what wind really does there.

**R15b — heat derates power.** The R15 stress fraction now also pulls up to
6% of power (`ENGINE_HEAT_POWER_FADE`), so a flat-out top-speed run sags
~2% rather than being purely a reliability roll. Same neutral point, so
fresh engines and capped cruising are untouched.

**R17 — surface rolling resistance.** A point's `surface` grip value now
also scales `crr` (1 + 5×grip-lost — gravel that costs 20% grip doubles
rolling resistance). Runtime-only; the grip-bound profile never reads crr.

**R18 — driveline launch loss.** R14's constant-torque region assumed every
watt reached the wheels from step-off; modelled 0–100 ran 1.25 s optimistic
roster-wide and 5–7 s on economy cars. The power term is now derated up to
50% at standstill, tapering to zero by 50 m/s (or 0.9·vMax if lower — top
gear doesn't shift), leaving top-speed equilibrium and traction/pitch-
limited launches untouched. Sweep against eight published 0–100 figures:
mean model error −2.08 s → −0.17 s (Uno 10.2 → 14.7 vs 16.5 published,
Camry 5.3 → 8.0 vs 7.8, GR86 4.3 → 6.5 vs 6.3, 911 Turbo S 2.7 → 3.0,
Fireblade/H2R unchanged — pitch-limited, as the audit found them accurate).

**R19 — brake fade.** `brakeHeat` (EMA of pedal × speed fraction, τ 20 s)
derates usable braking to at most −30% at full heat, in the runtime
controller's `aCap` and physics' brake force together — the driver brakes
earlier to compensate (R1's lookahead does this for free once aCap drops).
The profile still plans on fresh brakes (§0.2), which is safe because the
plan only ever demands `BRAKE_SAFETY_MARGIN` (0.6) of the fresh system:
`BRAKE_FADE_MAX` must stay strictly below 0.4, and the constant's comment
says so. Normal corner rhythm sits under the heat neutral point; held
mountain descents exceed it. HUD telemetry shows both new signals (Engine
load, Brake heat).

§0.4 on v8 (10 seeds, sorocaba–monte verde): capped crash rate
0.010/car-race, mechanical 6.0%, no NaN; uncapped crash 0.120/car-race,
off-road retirements 2.0% (at the ≤2% ceiling), per-exposure thirds
declining. Golden re-recorded (launch loss + surface crr both touch it).
