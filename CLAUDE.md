# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-based racing simulator: real-world cars **and motorcycles** race along real road geometry (baked from OSM routing/elevation APIs), rendered top-down on a MapLibre map. Vanilla TypeScript + Vite, no UI framework. The simulation is deliberately **one-dimensional** — every car's state is `(s, v)` (metres travelled along its route, current speed); lat/lon is *derived* from `s` only for drawing. Do not introduce 2D position/steering/heading as simulation state.

`plan.md` is the **original** spec — useful for the reasoning behind locked decisions, but its out-of-scope list and "no 3D library" rule have been partly superseded (3D car models, weather and a coarse gearbox approximation all exist now); the annotations in that file say which parts still hold. Its **guiding principle** — the simulation is one-dimensional, `(s, v)` only — is not stale and is still absolute. `REALISM-GUIDE.md` is a phased log of physics/driver-model improvements (R1–R14) with the invariants ("Ground rules," §0) that any new simulation work must keep obeying — read §0 before touching `sim.ts`/`driver.ts`/`physics.ts`. Note its §0.4 pass criteria are known to be mutually unsatisfiable on the roster those measurements were taken against (the 28 cars that are now the first entries of each make in `cars.json` — see `CORNER_UTILISATION_TARGET` in `tuning.ts` for the measurements and which criterion wins); those cars' specs are unchanged, but §0.4 now runs on a 20-car grid drawn from a ~200-car roster, so re-measure before trusting an old number. `CODE-REVIEW.md` is a past review pass, not living documentation.

## Commands

```
make run          # start the dev server AND open the app in the browser (most common)
make dev          # start the dev server only
make check        # typecheck + test — run before considering any change done
make typecheck    # tsc --noEmit
make test         # vitest run
make bake ARGS='--from "Origin, ST" --to "Destination, ST" --slug my-route-slug'
                   # bake a new route from OSM data (add --alternatives for route variants)
make sim-batch ARGS='--route sorocaba-campos --seeds 30'
                   # headless N-seed batch validation (incident/retirement rates) — see REALISM-GUIDE.md §0.4
                   # Runs seeds across worker threads (~4x faster); add --jobs 1 to run inline when debugging,
                   # and --startInterval 0 to measure a mass start instead of the shipped interval start.
                   # --cars picks the field out of the ~200-car roster: 'grid' (default — one fair
                   # 20-car grid, what the app races), 'all' (whole roster, slow and not a race),
                   # a tier id (economy/everyday/sport/performance/super/hyper), or a comma-separated id list.
```

Single test file: `npx vitest run src/driver.test.ts`. Tests are colocated (`foo.ts` / `foo.test.ts`), pure-function style against `src/test-fixtures.ts` synthetic routes — no DOM, no fetch/mocking.

Routes can also be created live in-app (a route picker UI hits the dev-server's bake API) instead of via the CLI — see `tools/dev-routes-api.ts`.

## Architecture

### Simulation core (`src/`)

- **`types.ts`** — all shared types: `Route`/`RoutePoint` (baked GIS data), `CarSpec` (static vehicle spec), `CarState` (per-race mutable state), `Incident`/`RaceEvent` (append-only event log).
- **`sim.ts`** — owns `Sim` (all cars + race clock) and `tick()`, a fixed-timestep (`DT = 1/60`) accumulator decoupled from render framerate. Each step: snapshot every car's start-of-step state (so cross-car reads — drafting, blocking, hazards — never depend on roster processing order), then advance each car via `stepCar`. Handles interval starts, drafting, blocking/committed overtaking, caution hazards, mechanical reliability, tire wear.
- **`driver.ts`** — the AI driver: `computeSpeedProfile` precomputes a per-point target-speed profile per car (cached, keyed on route+spec+globalCap+lineQuality+limitTolerance+weather — profiles are immutable, see §0.2 of REALISM-GUIDE.md), `driverControl` is the per-step lookahead-braking + friction-circle-aware throttle/brake controller, `evaluateLossOfControl` is the crash/spin/slide probability model.
- **`physics.ts`** — `computeAcceleration`: longitudinal force balance (traction, drag, rolling resistance, grade, braking), altitude-aware air density.
- **`route.ts`** — loads/validates baked route JSON (`fetch`-based, browser-only) and interpolates position/radius/surface at an arbitrary distance `s`.
- **`physics.ts`/`driver.ts` motorcycle branches** — M1: `spec.type` selects a handful of type-gated differences (pitch-over ceiling, weather table, rider margin, incident severity, tyre wear). Every one falls back to the car value for `type: 'car'`, which is why the golden race is unchanged. See REALISM-GUIDE.md §M1 before touching them.
- **`cars.ts`** — loads/validates `public/data/cars.json` (raw real-world units: crank power in W, top speed in km/h) and converts to runtime `CarSpec` (wheel power, m/s). Grip/tire coefficients and driver-behavior params (`aggression`, `limitTolerance`, `errorSigma`, `lineQuality`) are *not* real specs — they're estimated/tuned, documented per-car in the JSON's `notes` field.
- **`roster.ts`** — roster *classification*, not simulation: `paceIndex` (one W/kg-equivalent number blending power-to-weight, top speed and lateral grip), the absolute `PERFORMANCE_TIERS` bands it feeds, `groupByMake`, and the grid builders (`buildFairField`, `fieldLike`) plus `MAX_FIELD_SIZE`. It exists because the roster spans a Fiat Uno to a Bugatti Bolide and a random 20 out of that is a procession, not a race. Nothing in `sim.ts`/`driver.ts`/`physics.ts` reads any of it.
- **`tuning.ts`** — every tuning constant lives here, each with a comment explaining what it is and why that value (never add a magic number directly in `driver.ts`/`sim.ts`/`physics.ts`). Includes `ENGINE_VERSION`, bumped whenever a change alters what a given race seed produces (currently 5).
- **`rng.ts`** — `mulberry32` (seeded per-car stateful PRNG) and `valueNoise` (pure, stateless 1D noise) — the only two permitted randomness sources in sim code. **Never use `Math.random()` or wall-clock time inside the simulation** — determinism (same seed → byte-identical race) is a hard invariant.

### Determinism rules (critical — see REALISM-GUIDE.md §0.1 for full detail)

- Per-step hazard draws (crash, mechanical failure) use `car.rng`, drawn *unconditionally* at a fixed point in step order.
- Anything noise-like over distance uses `valueNoise(x, car.seed ^ 0xSOMECONST)` with a decorrelated seed per channel.
- Per-driver static traits derive from `car.seed`/spec, never from an extra `car.rng()` draw at init.
- `main.ts`'s `randomSeed()` (real `Math.random()`) is the one sanctioned exception — it's app-runtime code picking a *fresh* seed for a new race, not simulation code consuming one.

### Rendering (`src/render/`)

Vanilla DOM, no framework. `map.ts` wraps MapLibre (per-route-slug sources/layers, since F1 lets different cars run different route variants of the same course simultaneously; MapLibre is pinned to v5 — see the note at the top of that file). `hud.ts` (leaderboard, incident feed, per-car telemetry strip), `race-controls.ts`, `profile.ts` (elevation chart, plus the followed car's speed trace and incident markers), `config-panel.ts` (grid/route/weather/start-format selection, laid out as **two side-by-side panes** — the roster on the left, filtered to one manufacturer by the chip strip above it, and the grid being built on the right, where the per-car route pickers live. Only those two lists scroll: with ~200 cars the panel must never become one long column. Search and the performance-class filter narrow the left pane; "Fill grid" and the per-row class chip build competitive fields via `roster.ts`; everything is capped at `MAX_FIELD_SIZE`), `routes-panel.ts` (create/rename/delete baked routes), `route-store.ts` (shared mutable route-index state the config and routes panels both subscribe to), `summary.ts` (post-race results + event log + seed, the consumer of `sim.events`), `keyboard.ts` (shortcuts; `KEYBOARD_HELP` is the single source both the handler and the on-screen hint read), `cars-3d.ts`/`car-mesh.ts`/`chase-camera.ts`/`basemap.ts` (3D car models and the chase view).

**Map layers** (`map.ts`) are, bottom to top: route casing (one colour per variant in play) → curvature gradient → caution zones → start/finish + 10 km markers → incident sites → car circles → deck.gl models. Anything the app owns is added by `addAppLayers`, which runs both at first load *and* after every basemap swap — `setStyle` discards every source and layer, so a second copy of that logic would drift. Two traps worth knowing: a `zoom` expression is only legal at the **top level** of a paint property (nest one inside a `case` and MapLibre drops the whole layer, logging to the console and rendering nothing — it looks exactly like a layer that was never added), and starting a style swap while one is in flight upsets MapLibre's symbol buckets, which is why `setBasemap` returns a promise the caller uses to disable the control.

`minimap.ts` draws the route overview inset on a 2D canvas rather than a second MapLibre instance — a second GL context and tile pipeline to draw a polyline and a dozen dots would be absurd, and `profile.ts` already proves the approach.

`chase-camera.ts` owns pitch and bearing; `tv-camera.ts` is the broadcast mode, which cuts between framings on a fixed (not random) shot cycle so a replayed seed looks the same twice.

`main.ts` wires everything: it holds one `AppState` object (car assignments, loaded routes, sim, camera) that gets fully rebuilt on Reset/Apply rather than mutated piecemeal — see the `rebuildRace`/`AppState` comment for why.

#### Render cadences (don't collapse these back to "every frame")

The frame loop shares one main thread with MapLibre's own gesture handling, so what runs at 60 Hz is a deliberate, measured choice — not a default. Each of these was costing a per-frame GPU upload, worker round-trip or forced layout:

| Work | Cadence | Why |
| --- | --- | --- |
| Chase camera (`followCar`) | every frame | it *is* the motion |
| 3D car models (`updateCars3D`) | every frame ≥ zoom 13.5, not drawn below | a car moves several px/frame up close; below that it is sub-pixel and the circles take over |
| Car circle layer (`setData`) | 20 Hz, suspended during a drag | GeoJSON re-parse + worker re-tile; only visible at zooms where a car moves a few px/*second* |
| Elevation strip (`profile.render`) | 20 Hz | full-canvas blit; a car crosses 0.2 px/s on that strip |
| HUD text | 10 Hz | text, and every cell write is compared first |
| Everything above | skipped entirely when the derived render key is unchanged | a paused race was re-rendering identical frames forever |

Rules that follow from it: never assign `textContent`/`style.*` in a per-frame path without comparing first (assignment replaces the node either way); never call `getBoundingClientRect` in the loop (use the `ResizeObserver` in `profile.ts`); and keep deck.gl accessors/material hoisted to module constants, since deck compares props by reference and a fresh closure re-uploads that attribute for every car.

### Route baking (`tools/`, Node-only)

- **`bakeRoute.ts`** — shared baking logic: fetches geometry (Valhalla primary, OSRM demo-server fallback) + elevation (OpenTopoData SRTM 30m), derives grade/curvature/surface/speed-limit per 25 m point, used by both the CLI and the dev-server API. Server-side only because Nominatim/OpenTopoData don't allow direct browser calls (User-Agent / CORS).
- **`bake-route.ts`** — CLI entry point (`npm run bake`), writes into `public/data/routes/` (committed, ships in the production build).
- **`dev-routes-api.ts`** — a Vite dev-server plugin (wired in `vite.config.ts`) exposing a live bake/search/rename/delete API used by the in-app Routes panel. On-demand bakes are written to `data/routes/` (a directory *outside* `public/`, not `public/data/routes/`) — writing into `publicDir` after the dev server has booted makes that file unservable until Vite's watcher notices it (confirmed by reproduction). The plugin stitches committed (`public/data/routes/`) and on-demand (`data/routes/`) routes into one virtual `/data/routes/` namespace for the client. A promise-chain mutex (`enqueueBake`) serializes concurrent bake/rename/delete calls since they read-modify-write the same `index.json`.
- **`sim-batch.ts`** — headless N-seed race runner (`npm run sim-batch`) for the §0.4 validation protocol: reports incident/retirement rates and finish-time spread without a browser.

### Data (not code)

- `public/data/cars.json` — the vehicle roster (F2: data file, not committed TS, so adding a car needs no rebuild). ~197 cars across 22 manufacturers. Every mainstream make carries **at least ten** models; the small-volume specialists (Rimac, Yangwang, Aspark) are deliberately exempt because they don't have ten real cars to list. Each entry carries a `make` (the config panel's grouping key — omitted, it falls back to the first word of `name`). Plus **50 motorcycles** (M1) across 13 makes — Honda, BMW, Suzuki and Kawasaki groups therefore hold both cars and bikes, which is correct. The ten-models-per-make rule is a *car* convention; motorcycle makes are bounded by the top-50 list instead.
- `public/data/routes/` — committed baked routes + `index.json`.
- `data/routes/` — on-demand-baked routes from the dev-server API (gitignored-adjacent working set, outside `publicDir`).

## Working conventions specific to this repo

- Every acceptance-criteria-driven decision (`AC#N`), bug reference (`B#N`), or realism item (`R#N`/`§#`) cited in a comment refers to `plan.md` or `REALISM-GUIDE.md` — check those docs before assuming a comment reference is stale.
- Crash/incident tuning constants in `tuning.ts` (`CRASH_K`, `CRASH_EXP`, reliability hazard rates) are calibrated toward the *rare* end of the target incident-rate band per explicit product preference — prefer fixing controller behaviour over re-tuning these when incident rates drift.
- New route-point fields must be optional with safe defaults (so every already-baked route JSON keeps loading) — update `assertRoute` in `route.ts` to validate only when present, and update the baker's point-narrowing in `tools/bakeRoute.ts`.
- New `RaceEvent` variants extend the union in `types.ts` and are pushed via `sim.events`; the UI is expected to ignore event types it doesn't render yet. `render/summary.ts` is the main consumer — add a case to its `describeEvent` if the new event is worth showing in the race log.
- **Ranking is by time, not road position.** Cars start at staggered intervals and are classified on their own elapsed running time, so `CarState.finishTime` is own-clock (not absolute race clock) and live order comes from `raceRank`/`projectedTime` in `sim.ts`. Never rank by `remainingDistance` — that is road position, which under an interval start is a different thing.
- `src/roster-data.test.ts` audits the **shipped** `cars.json` rather than fixtures: it works the physics backwards from each entry (is the quoted top speed reachable on that vehicle's own power and drag? does `muLat` imply a lean angle the machine can carry? is the pitch ceiling actually the binding constraint on the bikes it should be?). Every check in it caught a real authoring error. Adding a vehicle whose numbers contradict each other fails here, which is the only place it would ever surface — bad-but-plausible data produces no error and no NaN.
- `src/golden.test.ts` pins one whole race end-to-end. If it fails, the engine now produces a different race for a given seed: confirm that was intended, bump `ENGINE_VERSION`, and re-record the constants (the file explains how). Do not "fix" it by loosening the assertions.
- Two driver traits are deliberately separate and must stay that way: `aggression` (how far past the *grip* limit a driver corners) and `limitTolerance` (how far past a *posted speed limit* they drive). They were once one field, which made cornering bravery the dominant determinant of finish time on limit-bound roads and inverted the field.
- **A race is at most `MAX_FIELD_SIZE` (20) cars, and the roster is far bigger than that.** Nothing may default to "race the whole roster" again — pick a field through `roster.ts` (`buildFairField`/`fieldLike`) so the grid is competitive, or the race is decided before the first corner. The config panel enforces the cap on every selection path; `main.ts` seeds the default grid the same way.
- **Motorcycles must stay a data + type-gated-branch feature.** A bike is a `CarSpec` with `type: 'motorcycle'`; the simulation stays one-dimensional `(s, v)` and knows nothing about lean, steering or wheelies beyond the single `pitchLimitG` force ceiling. If a change needs a car branch and a bike branch in the same expression, put the difference in a tuning constant keyed by type — never fork the step function.
- Adding cars is a data-only change (no rebuild), but keep the shape of the roster: give a new mainstream make ten models or don't add the make. `paceIndex` tier bands in `roster.ts` are **absolute**, so new cars slot into existing classes without re-labelling the ones already there — don't convert them to percentiles.
