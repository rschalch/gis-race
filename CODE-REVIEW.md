# Code Review — Bugs, Performance, Refactoring

Reviewed: entire `src/`, `tools/`, `index.html`, `vite.config.ts`, route data shape (2026-07-23).
Audience: implementing engineer. Each finding has an ID, severity, location, why it matters, and a suggested fix. Work top-to-bottom within each section; the Future-Proofing section exists because of the roadmap (per-car alternative routes to the same destination, many more cars, more spectator features) and should influence *how* the other fixes are made.

Baseline note: there is no `typecheck`/`lint`/`test` script in `package.json`. Add `"typecheck": "tsc --noEmit"` first and run it after every finding below.

---

## 1. Bugs

### B1 — Braking profile ignores grade: cars physically cannot honour the profile on descents · **High**
`src/driver.ts:41-46`

The backward pass uses a constant `aBrake = muLong * G * BRAKE_SAFETY_MARGIN` everywhere. On a descent, gravity subtracts from available deceleration (`g·sin(grade)` pushes the car forward), so the *real* achievable braking is lower than the profile assumes — exactly on the Mantiqueira-style descents where the tight corners are. The result: cars systematically arrive at downhill hairpins carrying more speed than the profile promised, producing crashes that are terrain-caused rather than aggression-caused (this skews the intended §7.3 caution-vs-speed trade-off, and it will get worse with more routes).

**Fix:** make the backward pass grade-aware, per segment:

```ts
for (let i = n - 2; i >= 0; i--) {
  const grade = route.points[i]!.grade;
  const aBrake = Math.max(
    0.5, // floor so the sqrt never collapses on absurd grades
    spec.muLong * G * Math.cos(grade) * BRAKE_SAFETY_MARGIN + G * Math.sin(grade),
    // grade > 0 (uphill) helps braking; grade < 0 (downhill) hurts it
  );
  const reachable = Math.sqrt(profile[i + 1]! ** 2 + 2 * aBrake * route.spacing);
  profile[i] = Math.min(vLimit[i]!, reachable);
}
```

While in there, note `physics.ts:23,27` uses `muLong * m * G` for traction/brake caps without the `cos(grade)` normal-load correction. It's a ≤2% error at real grades — fix it in the same pass or leave a comment saying it's deliberately ignored, but be consistent between profile and physics.

After changing this, re-tune nothing blindly: run ~30 seeded races and confirm incident rate still sits at the rare end (user preference: incidents rare, low end of §7.5's target). Braking-feasibility crashes on descents should drop; aggression-driven crashes in corners should remain.

### B2 — Simulation never ends: clock and tick loop run forever after the last car finishes/retires · **Medium**
`src/sim.ts:104-113`

Once every car is `finished`/`retired`, `tick` keeps accumulating `simTime` and looping over cars forever. The elapsed clock keeps counting up, and "race over" is never represented anywhere.

**Fix:** at the end of `tick` (or start), if every car's status is `finished` or `retired`, set `sim.paused = true` (or add an explicit `sim.raceOver = true` flag — better, since "paused" currently doubles as "not started"). Render layer can then show a final state. This also gives the future features roadmap a natural "race complete" hook (podium screen, stats, etc.).

### B3 — "Follow Leader" and the leaderboard's leader can be a retired (crashed-out) car · **Medium**
`src/main.ts:14`, `src/render/hud.ts:171-174`

Leader is defined as `max(s)` over all cars. A car that retires while leading remains "leader" forever: the follow-leader camera parks on a wreck for the rest of the race, and the P1 row is a retired car.

**Fix:** define leader as the car with greatest `s` among `status !== 'retired'` (falling back to overall max if all retired). Apply in both `resolveCameraTargetCar` and the HUD's `leaderId`/gap computation so map highlight and leaderboard agree. Decide explicitly whether `finished` cars count as leader (they should — they're ahead by definition until everyone finishes).

### B4 — Custom-route bake writes into `public/`, which triggers a Vite full page reload · **Medium — verify first**
`tools/bakeRoute.ts:391-397`, `tools/dev-routes-api.ts:90-96`, `vite.config.ts`

Vite watches `publicDir` and issues a **full-reload** when files there change. The bake endpoint writes `public/data/routes/<slug>.json` + `index.json` mid-session — so finishing a bake likely reloads the page, destroying the running race and the open config modal. (Prior e2e testing may have passed *because* the reload re-read the fresh index.)

**Fix:** verify by baking while a race is running. If confirmed, either:
- add `server.watch: { ignored: ['**/public/data/routes/**'] }` in `vite.config.ts`, or
- serve routes from a non-public directory (e.g. `data/routes/`) via a tiny GET middleware in `dev-routes-api.ts`, which also removes 6.6 MB of committed data from the static-copy path at build time.

The first option is a two-line fix; take it unless the build story changes.

### B5 — Autocomplete responses can arrive out of order; no abort, no sequencing · **Medium**
`src/render/config-panel.ts:42-61`

The debounce limits request *starts*, but in-flight fetches are never cancelled or sequence-checked. Type "Curi", pause 400 ms (request A fires), continue "tiba" (request B fires); if A resolves after B, the list shows stale results for the wrong query. Also, when the query shrinks below 3 chars, an in-flight older request can still repopulate the list after it was hidden.

**Fix:** keep an `AbortController` per input; abort the previous request when a new one fires, and ignore `AbortError` in the catch. That single mechanism fixes both orderings.

### B6 — Selected suggestion's coordinates are thrown away; bake re-geocodes free text · **Medium**
`src/render/config-panel.ts:67-73`, `tools/dev-routes-api.ts:80-96`, `tools/bakeRoute.ts:413-419`

`searchPlaces` returns `{label, lon, lat}` but the mousedown handler only copies the label text into the input. The bake then geocodes that text again — two extra Nominatim round-trips at 1.1 s each (throttled), and `limit=1` re-geocoding of a long `display_name` is not guaranteed to resolve to the same place the user actually clicked.

**Fix:** stash the picked suggestion's `{lon, lat}` (e.g. on the input via a closure variable, invalidated on further typing), extend the bake API body to accept optional `fromCoord`/`toCoord`, and have `bakeRoute` skip `geocode()` when coords are provided. Faster bakes, and what you clicked is what gets baked.

### B7 — External/user strings injected via `innerHTML` · **Medium**
`src/render/config-panel.ts:56` (Nominatim `display_name`), `config-panel.ts:94-96` (route names from `index.json`, which contain user-typed origin/destination text)

`list.innerHTML = results.map(r => `<li>${r.label}</li>`)` interprets external data as HTML. Nominatim labels legitimately contain `&` (breaks rendering) and this is an injection vector in principle. Same pattern for `routeOptions`.

**Fix:** build these nodes with `document.createElement` + `textContent` (the bake-success path at `config-panel.ts:205-209` already does it correctly — match that). While there, drop the duplicated `car-dot` HTML snippet into a small helper shared with `hud.ts` (see R2).

### B8 — `applyConfig` is unguarded async: concurrent applies can interleave, and failures are silent · **Low**
`src/main.ts:76-90`

Two rapid Apply clicks (or Apply on a slow route load) run two `applyConfig`s concurrently; the slower `loadRoute` wins and overwrites the newer state with the older route. On failure (`loadRoute` throws) the panel has already closed and the user sees nothing — the old race keeps running with no explanation.

**Fix:** add a generation counter (`const gen = ++applyGeneration;` … after `await`, bail if `gen !== applyGeneration`), and surface load failures in the UI (simplest: reopen the config panel with an error line; the panel already has `config-error` styling).

### B9 — Reset / Apply silently discards the chosen time scale · **Low**
`src/main.ts:112-124`, `src/sim.ts:53`

`createSim` hardcodes `timeScale: 1`, so Reset and Apply&Restart drop the user's selected speed back to 1×. The buttons re-render consistently, so it *looks* deliberate, but it forgets a choice the user just made.

**Fix:** carry `sim.timeScale` from the previous sim into `createStandbySim` (pass it through), keeping 1× only for the very first sim.

### B10 — Incidents are recorded but never shown anywhere · **Low (spec gap §7.5/§8.2)**
`src/driver.ts:149`, `src/render/hud.ts`

The plan says "the HUD reports these and they are the most interesting thing that happens in a race", but `car.incidents` is write-only: the UI shows only the transient `Spinning (Ns)` status. A slide (2 s, no status change) is completely invisible; a retirement gives no explanation.

**Fix:** add a compact incident feed to the HUD (car dot, severity, sim-time, km mark), appended incrementally like the finish board. This is also the seed of the future "spectator attractiveness" features (event feed / commentary), so build it as an append-only race-event list, not a per-frame rebuild — see F4.

### B11 — Bearing interpolation has a wraparound bug at ±π (latent) · **Low**
`src/route.ts:49`

`bearing` is lerped linearly; across the north crossing (e.g. 179° → −179°) the interpolated value swings through 0° instead of ±180°. Harmless today (cars are circles; bearing is unused at runtime), but it will bite the moment car icons rotate.

**Fix:** shortest-arc interpolation (`delta = ((b - a + 3π) % 2π) − π; result = a + t·delta`), or delete `bearing` from the runtime sample until it's needed (see P5).

### B12 — Baked route is truncated up to 25 m before the destination · **Low**
`tools/bakeRoute.ts:151-155`

`resample` generates points at `k·25` for `k = 0..floor(total/25)` and `totalDistance` becomes the last grid point — the final partial segment (and the true destination coordinate) is dropped. Races end up to 25 m short of the geocoded destination, and the reported distance is slightly under OSRM's.

**Fix:** append a final point at the true endpoint (`s = total`) when `total` isn't an exact multiple of spacing. Note the runtime already tolerates non-uniform final spacing only if `interpolateAt`'s `t` uses `(b.s − a.s)` instead of `route.spacing` — adjust `interpolateAt`/`radiusAt`/`driverControl` denominators accordingly (they currently divide by `route.spacing`), or keep the grid uniform and just accept a final short segment with correct `s` math.

### B13 — Concurrent bakes race on `index.json` (read-modify-write) · **Low (dev-only)**
`tools/bakeRoute.ts:375-389`, `tools/dev-routes-api.ts:47-60`

Two simultaneous POST `/api/routes/bake` calls both read the index, both write it — one route silently vanishes from the index (file remains on disk, orphaned). `uniqueSlug` has the same TOCTOU shape.

**Fix:** serialize bakes in the dev API with a simple promise-chain mutex (`bakeQueue = bakeQueue.then(doBake)`), and return 409/busy if you'd rather reject than queue. Given Nominatim/OpenTopoData rate limits are process-wide anyway, serializing is the honest behavior.

### B14 — Determinism caveat: `Math.sin`-based hash is engine-dependent · **Info**
`src/rng.ts:12-15`

`latticeHash` relies on `Math.sin`, whose exact bits are implementation-defined. Same-browser replays are byte-identical (AC#12 holds locally), but a seed shared across different engines/devices may not reproduce. Also, at large seeds (`seed * 78.233` ≈ 1.7e11) the argument's fractional precision degrades.

**Fix (when it matters):** replace `latticeHash` with an integer hash (e.g. the same mulberry32-style avalanche used in `sim.ts:deriveCarSeed`, keyed by `(i, seed)`), which is exact in every engine. Do it before any feature that shares seeds between users.

---

## 2. Performance

None of these are problems at 8 cars / 10.6k points — they're ordered by how hard they bite as car count and route count grow.

### P1 — `interpolateAt` is called 3–4× per car per frame across independent render modules · **Do with F2**
`src/main.ts:137,149`, `src/render/hud.ts:178`, `src/render/profile.ts:85`

Map markers, follow camera, HUD elevation, and profile dots each re-interpolate the same car's position every frame. At N cars that's ~4N interpolations plus 4N transient objects per frame.

**Fix:** compute one `RouteSample` per car per frame in `main.ts`'s `frame()` and pass the samples down to `updateCarPositions` / `renderHud` / `renderProfile`. This is also the natural seam for per-car routes later (F1): the sample, not the route, becomes the render input.

### P2 — HUD writes every cell's `textContent` at 60 Hz · 
`src/render/hud.ts:176-199`

Eight cells × N cars × 60 Hz of `textContent` assignments (each producing a new string, most identical to the previous frame). At 8 cars it's noise; at 50+ cars it's the first thing a profiler will show.

**Fix:** throttle HUD updates to ~10 Hz (accumulate time in `frame()`), or cache last-written strings per cell and skip identical writes. Throttling is simpler and visually indistinguishable for text. Keep map markers at full 60 Hz.

### P3 — Elevation profile redraws the full static curve every frame ·
`src/render/profile.ts:60-82`

The route curve + fill (600 line segments) is stroked every frame just to move N dots.

**Fix:** render the static curve once into an offscreen canvas per (route, canvas size), `drawImage` it each frame, then draw dots. Invalidate on route change or resize (cache key already exists — extend `RouteProfileCache`).

### P4 — Speed profiles are recomputed per car on every reset/apply ·
`src/sim.ts:42`, `src/driver.ts:28-49`

`computeSpeedProfile` is O(route points) per car and allocates two Float32Arrays. Every Reset and every Apply recomputes all of them, and cars sharing a spec duplicate work. Trivial today; at 100 cars × 40k-point routes it's ~8M ops + 32 MB churn per reset.

**Fix:** memoize by `(spec.id, route, globalCapEnabled)` in a `Map` (WeakMap keyed on route object holding an inner map). Profiles are immutable — sharing one Float32Array across cars with the same spec is safe.

### P5 — Route JSON carries dead weight: `x`/`y` are never read at runtime · 
`tools/bakeRoute.ts:528-538`, `src/route.ts`, route files (6.6 MB total in `public/data`)

The ENU `x`/`y` fields exist only for the baker's internal geometry; nothing in `src/` reads them (`bearing` is emitted but also unused at runtime today — see B11). They inflate every route file by roughly a third and every route load/parse with them.

**Fix:** stop emitting `x`/`y` (drop them from `RoutePoint` or split a `BakedRoutePoint` type for the tool). Keep `bearing` only if car-icon rotation is on the near-term roadmap. Re-bake or write a one-off strip script for existing files. (Longer term with many/longer routes, consider Float32Array-of-columns binary format, but JSON is fine for now.)

### P6 — Curvature-gradient expression stops scale with route length ·
`src/render/map.ts:44-62`

Fixed `STRIDE = 8` yields ~1.3k stops for 265 km; a 1000 km bake (`MAX_DISTANCE_KM`) would produce ~5k stops in a single `interpolate` expression, which MapLibre evaluates per-pixel on the GPU-prep path and re-parses on every `setPaintProperty`.

**Fix:** target a stop *count* instead of a stride: `STRIDE = Math.max(1, Math.ceil(points.length / 1200))`.

### P7 — `tick` catch-up burst after tab-switch is fine, but headroom shrinks linearly with cars ·
`src/sim.ts:104-113`

Worst case per frame is `0.1 s × timeScale / DT` = 60 steps at 10×; each step is `stepCar × N` with two `Math.sin` calls (valueNoise) plus an `interpolateAt` per car. At 100 cars that's 6k stepCar calls in one frame after a background-tab return — likely still <10 ms, but measure when the roster grows. Cheap wins if needed: hoist `valueNoise`'s two lattice hashes into a per-bucket cache (noise input only changes every ~4 km of `s`), and inline `interpolateAt`'s grade-only variant for `stepCar` (it needs `grade` only).

---

## 3. Refactoring

### R1 — Module-level render singletons block multiple instances and tests
`src/render/hud.ts:92`, `src/render/race-controls.ts:32`, `src/render/profile.ts:11`

`let dom: HudDom | null = null` / `let cache: RouteProfileCache | null = null` at module scope means exactly one HUD/controls/profile can ever exist, and unit-testing render logic requires module resets. It also hides an assumption: `renderHud`'s `dom` is implicitly bound to whatever container was passed last.

**Fix:** have each `init*` return an instance object (`{ render(...) }`) closing over its own DOM refs; `main.ts` holds the instances. Mechanical change, no behavior difference — do it before the render layer grows more panels (mini-map per route, incident feed, etc.).

### R2 — Duplicated code and constants
- `formatElapsed` exists twice, identical: `hud.ts:36-41` and `race-controls.ts:15-20`.
- `CRANK_TO_WHEEL = 0.85` defined in `cars.ts:17` and re-derived in `config-panel.ts:16`.
- `car-dot` colored-span HTML template appears in `hud.ts:134`, `hud.ts:209`, `config-panel.ts:107`.
- `RouteIndexEntry` is declared in both `src/route.ts:12-17` and `tools/bakeRoute.ts:368-373` (the tool can't import from `src/route.ts` because of the fetch code, but the *type* should live in `src/types.ts`, imported by both).

**Fix:** create `src/format.ts` (or `src/render/ui-util.ts`) for `formatElapsed`/`formatDistance`/car-dot element builder; export `CRANK_TO_WHEEL` from `cars.ts`; move `RouteIndexEntry` to `types.ts`.

### R3 — Tuning constants scattered across files
`driver.ts` holds `GLOBAL_CAP = 36`, `BRAKE_SAFETY_MARGIN = 0.5`, `CRASH_K = 0.03`, `CRASH_EXP = 1.6`, plus inline slide/spin thresholds (0.95 / 1.05 / 1.2) and recovery range (15–40 s) in `triggerIncident`; `physics.ts` holds `G`, `AIR_DENSITY`; the config-panel hardcodes the "130 km/h" copy that must match `GLOBAL_CAP`.

**Fix:** a single `src/tuning.ts` exporting a named, commented constants object. Two concrete benefits: (a) the UI can derive "130 km/h" from `GLOBAL_CAP * 3.6` instead of hoping the strings stay in sync; (b) future features (weather multiplier, difficulty presets, per-route caps) become data changes. Keep the crash constants' "rare incidents" bias documented there (it's an explicit user preference, not a spec default).

### R4 — `main.ts` app state is a bag of closure `let`s
`src/main.ts:67-73`

`routeSlug/route/selectedCars/globalCapEnabled/sim/camera` as loose closure variables works at this size, but every roadmap feature (per-car routes, race events, replay) adds more of them, and `applyConfig`/`onReset` already duplicate "rebuild world" logic.

**Fix:** extract an `AppState` object plus a single `rebuildRace(overrides)` function used by initial load, Apply, and Reset. This is deliberately *not* a framework — just one object and one function — but it's the seam F1/F2 need.

### R5 — Sim layer has a Vite-ism in it
`src/driver.ts:151` uses `import.meta.env?.DEV` for incident logging inside otherwise pure simulation code, coupling the sim to the bundler (the `?.` is there precisely because Node scripts break otherwise).

**Fix:** replace with an optional `onIncident?: (car, incident) => void` callback on `Sim` (set by `main.ts` to console.log in dev). This simultaneously deletes the bundler coupling, gives Node-based diagnostic scripts a clean hook, and is the delivery mechanism for B10's incident feed and F4's event log.

### R6 — Roster-index-based seeds make car behavior depend on who else is racing
`src/sim.ts:22-27`

`deriveCarSeed(raceSeed, index)` means the same car with the same race seed behaves differently when the selection set changes (its index shifts). Determinism per exact config holds, but "same seed, same car, different roster" comparisons — which you'll want when tuning a bigger roster — silently change every car's noise stream.

**Fix:** hash `spec.id` (string hash, e.g. FNV-1a) with `raceSeed` instead of the index.

### R7 — No route-file validation at load
`src/route.ts:3-9` casts `res.json()` straight to `Route`. A stale or hand-edited route file (old schema, missing `radius`, non-uniform spacing) produces NaNs deep in the sim instead of a clear error.

**Fix:** a small `assertRoute(route)` — check `points.length >= 2`, `spacing > 0`, monotone `s`, finite fields on first/last/sampled points. Cheap, and it converts data bugs into one readable message. Matters more once routes come from the in-app baker rather than curated commits.

### R8 — No automated tests, and the pure core is extremely testable
`computeSpeedProfile`, `driverControl`, `computeAcceleration`, `evaluateLossOfControl`, `interpolateAt`/`radiusAt`, `valueNoise`, and the whole bake pipeline (given fixture inputs) are pure functions. B1's fix in particular should land with tests (profile respects vLimit; backward-pass reachability; downhill vs uphill braking asymmetry; determinism: same seed → identical incident list).

**Fix:** add `vitest` (zero-config with Vite), a `test` script, and start with driver/physics/route units plus one 30-seed statistical smoke test asserting incident-rate bounds (rare-crash preference) and "incidents only where radius < 300 m" (AC#8).

---

## 4. Future-Proofing (roadmap-driven design prep)

These aren't defects; they're the architectural moves that make the roadmap cheap. Recommended order: F4 → F1 → F2 (F4 is small and B10/R5 already half-build it).

### F1 — Per-car alternative routes (same destination, Waze-style)
Current hard assumptions to remove, all consequences of "one `Route` per `Sim`":
- `Sim.route` is global (`sim.ts:11`); `stepCar` takes the shared route. → Move to `car.route` (a reference; cars on the same alternative share the object). `createSim` takes `(assignments: Array<{spec, route}>, seed, cap)`.
- **Ranking/gap breaks**: `s` is not comparable across different routes. Leaderboard sort (`hud.ts:170`), gap-to-leader, and `resolveCameraTargetCar`'s leader must switch to **remaining distance** (`car.route.totalDistance − car.s`) — which is comparable across alternatives to a shared destination — with gap shown as `remaining(car) − remaining(leader)`. The "Traveled" column stays per-car.
- **Finish** already per-route (`s >= route.totalDistance`) — fine as-is once route is per-car.
- **Map** (`map.ts`): one route source/layer pair → one per distinct route (or one source with a `route` feature property and data-driven color); `setRouteData`/`fitToRoute` take the route set; bounds = union.
- **Profile strip** (`profile.ts`): a single elevation curve can't represent two roads. Simplest good answer: draw the followed car's route (or the first route as default), show only cars on that route as dots, and normalize the x-axis by *fraction of that route's distance*. Redesign later if needed.
- **Speed profile cache** (P4) becomes essential — keyed by (spec, route, cap).
- **Baking**: OSRM supports `alternatives=true`; extend `bakeRoute` to optionally emit N alternatives sharing origin/destination as sibling route files plus a "course" grouping in the index (`{ courseId, routes: [slugA, slugB] }`). Keep single-route files exactly as they are so existing data stays valid.

The one decision to make *before* coding: leader/gap semantics = remaining-distance (recommended, simple, monotone) vs. ETA-based (needs speed-profile integration; fancier, do later).

### F2 — Many more cars
- **Roster as data**: move `CARS` from TS to `public/data/cars.json` (validated on load like R7) so adding cars needs no rebuild; keep `CarSpec` as the schema. Colour collisions at scale → assign from a palette generator when `colour` is omitted.
- **Seeds**: R6 (id-hash seeds) becomes mandatory — index-based seeds reshuffle everything each roster edit.
- **HUD**: rows per car scale poorly past ~30. Plan: show top N + selected car (pinned) + a count, or make the panel scroll with P2's throttled updates. The `rows: Map<string, RowDom>` structure already supports partial rendering.
- **Config panel**: checkbox list → grouped/searchable list; `MIN_CARS = 2` stays, but add "select all / none".
- **Render**: the single-source `circle` layer approach is exactly right for hundreds of cars — keep it; avoid per-car DOM/markers forever. P1 (single sample per car per frame) is the main CPU guard.

### F3 — Follow-camera interaction (spectator quality-of-life)
`map.ts:188-190`'s `jumpTo` every frame means the user cannot pan or zoom while following — any gesture is snapped back next frame. Small fixes with outsized feel: track the user's chosen zoom (listen for `wheel`/`zoomend` while following and reuse `map.getZoom()` instead of hardcoded 13), and switch to `mode: 'free'` on `dragstart` (the "grab to break follow" idiom every map app uses).

### F4 — Race event log (foundation for "more attractive simulation")
Incidents (B10), lead changes, finishes, and future events (fastest sector, weather change) all want the same infrastructure: an append-only `sim.events: RaceEvent[]` (`{ time, type, carId, data }`) written by the sim (via R5's callback or directly), consumed incrementally by UI (feed panel, toasts) and available post-race (summary screen, replay seed + event list = shareable race). Build the array + one consumer (incident feed) now; every subsequent spectator feature becomes a new event type plus a renderer.

---

## Suggested implementation order

| Phase | Items | Rationale |
|---|---|---|
| 1 | typecheck script, B1, B2, B3, R8 (tests for B1) | Correctness of the core race; test harness while touching driver.ts |
| 2 | B4 (verify+fix), B5, B6, B7, B8, B13 | Custom-route baking UX/robustness cluster — one sitting, all in config-panel/dev-api |
| 3 | R2, R3, R5+B10, B9, R6 | Cleanups that later phases build on; incident feed |
| 4 | P1, P2, P3, P4, P5, P6 | Performance pass, mostly mechanical after R1/R4 |
| 5 | R1, R4, R7, B12 | Structural prep |
| 6 | F4 → F1 → F2 → F3 | Roadmap features |

Items B11/B14/P7 are "when relevant" — tied to icon rotation, cross-device seed sharing, and 100+ car rosters respectively.
