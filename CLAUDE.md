# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A browser-based racing simulator: real-world cars race along real road geometry (baked from OSM routing/elevation APIs), rendered top-down on a MapLibre map. Vanilla TypeScript + Vite, no UI framework. The simulation is deliberately **one-dimensional** — every car's state is `(s, v)` (metres travelled along its route, current speed); lat/lon is *derived* from `s` only for drawing. Do not introduce 2D position/steering/heading as simulation state.

`plan.md` is the original spec (locked tech-stack decisions, out-of-scope list). `REALISM-GUIDE.md` is a phased log of physics/driver-model improvements (R1–R14, engine versions 1–3) with the invariants ("Ground rules," §0) that any new simulation work must keep obeying — read §0 before touching `sim.ts`/`driver.ts`/`physics.ts`. `CODE-REVIEW.md` is a past review pass, not living documentation.

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
```

Single test file: `npx vitest run src/driver.test.ts`. Tests are colocated (`foo.ts` / `foo.test.ts`), pure-function style against `src/test-fixtures.ts` synthetic routes — no DOM, no fetch/mocking.

Routes can also be created live in-app (a route picker UI hits the dev-server's bake API) instead of via the CLI — see `tools/dev-routes-api.ts`.

## Architecture

### Simulation core (`src/`)

- **`types.ts`** — all shared types: `Route`/`RoutePoint` (baked GIS data), `CarSpec` (static vehicle spec), `CarState` (per-race mutable state), `Incident`/`RaceEvent` (append-only event log).
- **`sim.ts`** — owns `Sim` (all cars + race clock) and `tick()`, a fixed-timestep (`DT = 1/60`) accumulator decoupled from render framerate. Each step: snapshot every car's start-of-step state (so cross-car reads — drafting, blocking, hazards — never depend on roster processing order), then advance each car via `stepCar`. Handles drafting, blocking/overtaking, caution hazards, mechanical reliability, tire wear.
- **`driver.ts`** — the AI driver: `computeSpeedProfile` precomputes a per-point target-speed profile per car (cached, keyed on route+spec+globalCap+weather — profiles are immutable, see §0.2 of REALISM-GUIDE.md), `driverControl` is the per-step lookahead-braking + friction-circle-aware throttle/brake controller, `evaluateLossOfControl` is the crash/spin/slide probability model.
- **`physics.ts`** — `computeAcceleration`: longitudinal force balance (traction, drag, rolling resistance, grade, braking), altitude-aware air density.
- **`route.ts`** — loads/validates baked route JSON (`fetch`-based, browser-only) and interpolates position/radius/surface at an arbitrary distance `s`.
- **`cars.ts`** — loads/validates `public/data/cars.json` (raw real-world units: crank power in W, top speed in km/h) and converts to runtime `CarSpec` (wheel power, m/s). Grip/tire coefficients and driver-behavior params (`aggression`, `errorSigma`) are *not* real specs — they're estimated/tuned, documented per-car in the JSON's `notes` field.
- **`tuning.ts`** — every tuning constant lives here, each with a comment explaining what it is and why that value (never add a magic number directly in `driver.ts`/`sim.ts`/`physics.ts`). Includes `ENGINE_VERSION`, bumped whenever a change alters what a given race seed produces.
- **`rng.ts`** — `mulberry32` (seeded per-car stateful PRNG) and `valueNoise` (pure, stateless 1D noise) — the only two permitted randomness sources in sim code. **Never use `Math.random()` or wall-clock time inside the simulation** — determinism (same seed → byte-identical race) is a hard invariant.

### Determinism rules (critical — see REALISM-GUIDE.md §0.1 for full detail)

- Per-step hazard draws (crash, mechanical failure) use `car.rng`, drawn *unconditionally* at a fixed point in step order.
- Anything noise-like over distance uses `valueNoise(x, car.seed ^ 0xSOMECONST)` with a decorrelated seed per channel.
- Per-driver static traits derive from `car.seed`/spec, never from an extra `car.rng()` draw at init.
- `main.ts`'s `randomSeed()` (real `Math.random()`) is the one sanctioned exception — it's app-runtime code picking a *fresh* seed for a new race, not simulation code consuming one.

### Rendering (`src/render/`)

Vanilla DOM, no framework. `map.ts` wraps MapLibre (per-route-slug sources/layers, since F1 lets different cars run different route variants of the same course simultaneously). `hud.ts`, `race-controls.ts`, `profile.ts` (elevation/speed chart), `config-panel.ts` (car/route/weather selection, sortable table), `routes-panel.ts` (create/rename/delete baked routes), `route-store.ts` (shared mutable route-index state the config and routes panels both subscribe to).

`main.ts` wires everything: it holds one `AppState` object (car assignments, loaded routes, sim, camera) that gets fully rebuilt on Reset/Apply rather than mutated piecemeal — see the `rebuildRace`/`AppState` comment for why.

### Route baking (`tools/`, Node-only)

- **`bakeRoute.ts`** — shared baking logic: fetches geometry (Valhalla primary, OSRM demo-server fallback) + elevation (OpenTopoData SRTM 30m), derives grade/curvature/surface/speed-limit per 25 m point, used by both the CLI and the dev-server API. Server-side only because Nominatim/OpenTopoData don't allow direct browser calls (User-Agent / CORS).
- **`bake-route.ts`** — CLI entry point (`npm run bake`), writes into `public/data/routes/` (committed, ships in the production build).
- **`dev-routes-api.ts`** — a Vite dev-server plugin (wired in `vite.config.ts`) exposing a live bake/search/rename/delete API used by the in-app Routes panel. On-demand bakes are written to `data/routes/` (a directory *outside* `public/`, not `public/data/routes/`) — writing into `publicDir` after the dev server has booted makes that file unservable until Vite's watcher notices it (confirmed by reproduction). The plugin stitches committed (`public/data/routes/`) and on-demand (`data/routes/`) routes into one virtual `/data/routes/` namespace for the client. A promise-chain mutex (`enqueueBake`) serializes concurrent bake/rename/delete calls since they read-modify-write the same `index.json`.
- **`sim-batch.ts`** — headless N-seed race runner (`npm run sim-batch`) for the §0.4 validation protocol: reports incident/retirement rates and finish-time spread without a browser.

### Data (not code)

- `public/data/cars.json` — the car roster (F2: data file, not committed TS, so adding a car needs no rebuild).
- `public/data/routes/` — committed baked routes + `index.json`.
- `data/routes/` — on-demand-baked routes from the dev-server API (gitignored-adjacent working set, outside `publicDir`).

## Working conventions specific to this repo

- Every acceptance-criteria-driven decision (`AC#N`), bug reference (`B#N`), or realism item (`R#N`/`§#`) cited in a comment refers to `plan.md` or `REALISM-GUIDE.md` — check those docs before assuming a comment reference is stale.
- Crash/incident tuning constants in `tuning.ts` (`CRASH_K`, `CRASH_EXP`, reliability hazard rates) are calibrated toward the *rare* end of the target incident-rate band per explicit product preference — prefer fixing controller behaviour over re-tuning these when incident rates drift.
- New route-point fields must be optional with safe defaults (so every already-baked route JSON keeps loading) — update `assertRoute` in `route.ts` to validate only when present, and update the baker's point-narrowing in `tools/bakeRoute.ts`.
- New `RaceEvent` variants extend the union in `types.ts` and are pushed via `sim.events`; the UI is expected to ignore event types it doesn't render yet.
