import 'maplibre-gl/dist/maplibre-gl.css';
import { loadRoute, loadRouteIndex, interpolateAt, headingAt, CAR_HEADING_WINDOW_M } from './route';
import {
  initMap,
  updateCarPositions,
  setRouteData,
  fitToRoutes,
  followCar,
  resetChaseCam,
  onCarClick,
  onUserPan,
  setIncidentMarkers,
  setCautionZones,
  setCameraPreset,
  setBasemap,
  setTerrainEnabled,
  setTerrainExaggeration,
  tvCar,
  CAMERA_PRESETS,
  BASEMAP_LABELS,
  type BasemapId,
  type IncidentMarker,
  type CameraPreset,
} from './render/map';
import { initHud, type CameraState } from './render/hud';
import { initRaceControls, TIME_SCALES } from './render/race-controls';
import { initKeyboard } from './render/keyboard';
import { initProfile } from './render/profile';
import { initMinimap } from './render/minimap';
import { initConfigPanel, type ConfigApplyResult } from './render/config-panel';
import { initRoutesPanel } from './render/routes-panel';
import { initSummary } from './render/summary';
import { createRouteStore } from './render/route-store';
import { createSim, tick, resolveLeader, raceRank, type CarAssignment, type Sim } from './sim';
import type { CarState, Incident, Route, Weather } from './types';
import { loadCars } from './cars';
import { MAX_FIELD_SIZE, buildFairField, tierOf } from './roster';
import { START_INTERVAL_S, CAUTION_AHEAD_M, CAUTION_BEHIND_M } from './tuning';

const HUD_INTERVAL_S = 0.1; // ~10 Hz (P2) — HUD text writes, not map markers

/**
 * How often the elevation strip is redrawn, in simulated-independent real
 * seconds (~20 Hz).
 *
 * Redrawing it is not free: it blits a full-width backing canvas (a 2800×240
 * bitmap on a Retina display), strokes the speed trace, and draws a marker per
 * incident and a dot per car. It was doing that every animation frame, on the
 * same main thread MapLibre uses to handle a drag gesture.
 *
 * 20 Hz is invisible here in a way it would not be on the map: the strip maps a
 * whole 225 km route onto ~1400 px, so a car at 30 m/s advances 0.2 pixels per
 * *second*. Even the fastest car on the shortest route cannot move a pixel
 * between redraws.
 */
const PROFILE_INTERVAL_S = 0.05;

function resolveCameraTargetCar(
  cars: CarState[],
  target: string | 'leader' | null,
  simTime: number,
): CarState | null {
  if (target === null) return null;
  if (target === 'leader') return resolveLeader(cars, simTime);
  return cars.find((c) => c.spec.id === target) ?? null;
}

// A freshly created race sits at the start line paused — loading a route,
// switching routes, resetting, or applying a new configuration shouldn't
// send the cars off immediately; the user starts the race explicitly via
// the Start/Resume button.
//
// createSim's raceSeed defaults to a fixed value (needed so a *specific*
// seed reproduces byte-identical results — AC#12), but that means every NEW
// race must be handed a freshly randomised seed here, or every single race
// (on load, after Reset, after applying config) replays identically down to
// the exact crash location, every time. Math.random() is fine here — this
// is app runtime code, not a deterministic-replay context.
function randomSeed(): number {
  return Math.floor(Math.random() * 0x7fffffff);
}

// `timeScale` carries the previously-selected speed across Reset/Apply (B9)
// — only the very first sim of the session should default to 1×.
function createStandbySim(
  assignments: CarAssignment[],
  globalCapEnabled: boolean,
  weather: Weather,
  startIntervalS: number,
  timeScale: number,
  onIncident: Sim['onIncident'],
  // Explicit seed replays a specific race (the summary's "Replay this seed");
  // omitted means a fresh random one, which is what every new race wants.
  seed: number = randomSeed(),
): Sim {
  const sim = createSim(assignments, seed, globalCapEnabled, weather, startIntervalS);
  sim.paused = true;
  sim.timeScale = timeScale;
  sim.onIncident = onIncident;
  return sim;
}

/** Everything that changes on Apply/Reset, held as one object (R4) instead
 * of a bag of closure `let`s — every roadmap feature (per-car routes, race
 * events, replay) would otherwise add another loose variable, and
 * Apply/Reset already duplicated "rebuild the race" logic.
 *
 * F1: cars can be assigned to different route variants of the same course —
 * `routesBySlug` holds every distinct route currently in play, and each
 * car's own `.route` (in `sim.cars`) points into it. */
interface AppState {
  carAssignments: Array<{ carId: string; routeSlug: string }>;
  routesBySlug: Map<string, Route>;
  globalCapEnabled: boolean;
  weather: Weather;
  /** Seconds between cars leaving the line; 0 is a mass start. */
  startIntervalS: number;
  sim: Sim;
  camera: CameraState;
}

async function bootstrap() {
  const [routeIndex, CARS] = await Promise.all([loadRouteIndex(), loadCars()]);
  if (routeIndex.length === 0) throw new Error('public/data/routes/index.json is empty — bake a route first');

  const mapContainer = document.getElementById('map');
  const hudContainerOrNull = document.getElementById('hud');
  const raceControlsContainerOrNull = document.getElementById('race-controls');
  const configTriggerOrNull = document.getElementById('config-trigger');
  const configPanelOrNull = document.getElementById('config-panel');
  const routesTriggerOrNull = document.getElementById('routes-trigger');
  const routesPanelOrNull = document.getElementById('routes-panel');
  const profileCanvasOrNull = document.getElementById('profile');
  const minimapCanvasOrNull = document.getElementById('minimap');
  const summaryContainerOrNull = document.getElementById('summary');
  if (!mapContainer) throw new Error('#map container not found');
  if (!hudContainerOrNull) throw new Error('#hud container not found');
  if (!raceControlsContainerOrNull) throw new Error('#race-controls container not found');
  if (!configTriggerOrNull) throw new Error('#config-trigger not found');
  if (!configPanelOrNull) throw new Error('#config-panel not found');
  if (!routesTriggerOrNull) throw new Error('#routes-trigger not found');
  if (!routesPanelOrNull) throw new Error('#routes-panel not found');
  if (!(profileCanvasOrNull instanceof HTMLCanvasElement)) throw new Error('#profile canvas not found');
  if (!(minimapCanvasOrNull instanceof HTMLCanvasElement)) throw new Error('#minimap canvas not found');
  if (!summaryContainerOrNull) throw new Error('#summary container not found');
  const summaryContainer: HTMLElement = summaryContainerOrNull;
  const hudContainer: HTMLElement = hudContainerOrNull;
  const raceControlsContainer: HTMLElement = raceControlsContainerOrNull;
  const profileCanvas: HTMLCanvasElement = profileCanvasOrNull;
  const minimapCanvas: HTMLCanvasElement = minimapCanvasOrNull;

  const routeStore = createRouteStore(routeIndex);
  const initialRouteSlug = routeIndex[0]!.slug;
  const initialRoute = await loadRoute(initialRouteSlug);
  // Default grid: the roster spans ~200 cars from a Fiat Uno to a Bugatti
  // Bolide, so "everyone races" would be neither readable nor a contest.
  // Start with a competitive Sport-class field instead — the config panel's
  // class filter and grid actions are how you get anything else.
  const defaultTier = CARS.filter((c) => tierOf(c).id === 'sport');
  const initialCarIds = new Set(
    buildFairField(defaultTier.length >= MAX_FIELD_SIZE ? defaultTier : CARS, MAX_FIELD_SIZE).map((c) => c.id),
  );
  const initialRoutesBySlug = new Map([[initialRouteSlug, initialRoute]]);

  initMap(mapContainer, initialRoutesBySlug, (map) => {
    const hud = initHud(hudContainer, {
      onSelectCar: (carId) => {
        state.camera = { mode: 'follow', target: carId };
        resetChaseCam(map);
      },
      onFollowLeader: () => {
        state.camera = { mode: 'follow', target: 'leader' };
        resetChaseCam(map);
      },
      onOverview: () => {
        state.camera = { mode: 'overview', target: null };
        fitToRoutes(map, [...state.routesBySlug.values()]);
      },
      onFree: () => {
        state.camera = { mode: 'free', target: state.camera.target };
      },
      onTv: () => {
        // TV mode needs someone to point at; falls back to the leader, which
        // is what a director would do anyway.
        state.camera = { mode: 'tv', target: state.camera.target ?? 'leader' };
        resetChaseCam(map);
      },
      onCameraPreset: (preset) => {
        if (!(preset in CAMERA_PRESETS)) return;
        setCameraPreset(map, preset as CameraPreset);
        // A preset is a request to look at something, so it also drops you
        // into a mode where the camera is actually pointed at a car.
        if (state.camera.mode === 'overview' || state.camera.mode === 'free') {
          state.camera = { mode: 'follow', target: state.camera.target ?? 'leader' };
        }
      },
    });

    const raceControls = initRaceControls(raceControlsContainer, {
      onSetTimeScale: (scale) => {
        state.sim.timeScale = scale;
      },
      onTogglePause: () => {
        state.sim.paused = !state.sim.paused;
      },
      onReset: () => resetRace(),
    });

    // Hoisted so both the Reset button and the keyboard shortcut go through
    // exactly one implementation.
    function resetRace(): void {
      {
        // Reset never changes routes or assignments, so it can rebuild
        // synchronously from what's already loaded — no network round-trip.
        state = rebuildRace({
          carAssignments: state.carAssignments,
          routesBySlug: state.routesBySlug,
          globalCapEnabled: state.globalCapEnabled,
          weather: state.weather,
          startIntervalS: state.startIntervalS,
          timeScale: state.sim.timeScale,
        });
        fitToRoutes(map, [...state.routesBySlug.values()]);
      }
    }

    // Map-view controls (basemap, relief). Live settings: they change what you
    // are looking at right now, so they deliberately do not go through the
    // race-config modal's Apply & Restart.
    const basemapSelect = document.getElementById('basemap-select') as HTMLSelectElement | null;
    const reliefEnabled = document.getElementById('relief-enabled') as HTMLInputElement | null;
    const reliefExaggeration = document.getElementById('relief-exaggeration') as HTMLInputElement | null;
    if (basemapSelect && reliefEnabled && reliefExaggeration) {
      for (const [id, label] of Object.entries(BASEMAP_LABELS)) {
        const option = document.createElement('option');
        option.value = id;
        option.textContent = label;
        basemapSelect.appendChild(option);
      }
      basemapSelect.addEventListener('change', () => {
        // Disabled rather than queued: a style swap takes a second or two and
        // stacking them upsets MapLibre's symbol buckets (see setBasemap).
        basemapSelect.disabled = true;
        setBasemap(map, basemapSelect.value as BasemapId, state.routesBySlug).finally(() => {
          basemapSelect.disabled = false;
        });
      });
      reliefEnabled.addEventListener('change', () => {
        setTerrainEnabled(map, reliefEnabled.checked, Number(reliefExaggeration.value));
      });
      reliefExaggeration.addEventListener('input', () => {
        setTerrainExaggeration(map, Number(reliefExaggeration.value));
      });
    }

    const profile = initProfile(profileCanvas);
    // Shares the elevation strip's cadence: both show a whole route at once,
    // where a car covers a fraction of a pixel per second.
    const minimap = initMinimap(minimapCanvas);

    const summary = initSummary(summaryContainer, {
      onReplaySeed: (seed) => {
        state = rebuildRace({
          carAssignments: state.carAssignments,
          routesBySlug: state.routesBySlug,
          globalCapEnabled: state.globalCapEnabled,
          weather: state.weather,
          startIntervalS: state.startIntervalS,
          timeScale: state.sim.timeScale,
          seed,
        });
        fitToRoutes(map, [...state.routesBySlug.values()]);
      },
      onClose: () => {},
    });

    // Where every incident this race happened, in map coordinates. Append-only
    // within a race and cleared by rebuildRace — the map should mark the crash
    // sites of the race you are watching, not the last one.
    let incidentMarkers: IncidentMarker[] = [];

    function handleIncident(car: CarState, incident: Incident): void {
      hud.pushIncident(car, incident);
      const at = interpolateAt(car.route, incident.s);
      incidentMarkers = [
        ...incidentMarkers,
        {
          lon: at.lon,
          lat: at.lat,
          terminal: incident.severity === 'off-road' || incident.severity === 'mechanical',
        },
      ];
      setIncidentMarkers(map, incidentMarkers);
      if (import.meta.env.DEV) {
        console.log(
          `[incident] ${car.spec.name} ${incident.severity} at s=${incident.s.toFixed(0)}m ` +
            `t=${incident.time.toFixed(1)}s util=${incident.utilisation.toFixed(2)}`,
        );
      }
    }

    // Bumped by rebuildRace so the frame loop's render key changes even when
    // the new race starts at the same simTime the old one was sitting at.
    // Declared above rebuildRace, not beside the other loop state below it:
    // rebuildRace runs once during setup, before that point in the function
    // body, and a `let` read from inside it would hit the temporal dead zone.
    let simGeneration = 0;

    function rebuildRace(overrides: {
      carAssignments: Array<{ carId: string; routeSlug: string }>;
      routesBySlug: Map<string, Route>;
      globalCapEnabled: boolean;
      weather: Weather;
      startIntervalS: number;
      timeScale: number;
      seed?: number;
    }): AppState {
      const assignments: CarAssignment[] = overrides.carAssignments.map(({ carId, routeSlug }) => {
        const spec = CARS.find((c) => c.id === carId)!;
        const route = overrides.routesBySlug.get(routeSlug)!;
        return { spec, route };
      });
      // A new race must clear the summary, or the "already shown for this
      // race" latch would suppress it for every subsequent race.
      summary.reset();
      simGeneration += 1;
      incidentMarkers = [];
      setIncidentMarkers(map, incidentMarkers);
      return {
        carAssignments: overrides.carAssignments,
        routesBySlug: overrides.routesBySlug,
        globalCapEnabled: overrides.globalCapEnabled,
        weather: overrides.weather,
        startIntervalS: overrides.startIntervalS,
        sim: createStandbySim(
          assignments,
          overrides.globalCapEnabled,
          overrides.weather,
          overrides.startIntervalS,
          overrides.timeScale,
          handleIncident,
          overrides.seed,
        ),
        camera: { mode: 'overview', target: null },
      };
    }

    // §5.9 / F1: routes are runtime parameters — swapping them reassigns
    // `state` instead of recreating the map/animation loop, so the picker
    // can switch races (or per-car route variants) with no page reload.
    let state: AppState = rebuildRace({
      carAssignments: [...initialCarIds].map((carId) => ({ carId, routeSlug: initialRouteSlug })),
      routesBySlug: initialRoutesBySlug,
      globalCapEnabled: true, // §7.1's default — matches the spec's own stand-in for legal limits
      weather: 'dry', // R7's default — matches the spec's own baseline condition
      startIntervalS: START_INTERVAL_S,
      timeScale: 1,
    });
    let lastTime: number | null = null;
    let hudAccumulator = HUD_INTERVAL_S; // render immediately on the first frame, then throttle
    let profileAccumulator = PROFILE_INTERVAL_S;
    let applyGeneration = 0;

    initRoutesPanel(routesTriggerOrNull, routesPanelOrNull, routeStore);

    initKeyboard({
      onTogglePause: () => {
        // Matches the button exactly, including its no-op on a finished race.
        if (!state.sim.raceOver) state.sim.paused = !state.sim.paused;
      },
      onStepTimeScale: (direction) => {
        const i = TIME_SCALES.indexOf(state.sim.timeScale);
        // An unrecognised current scale (only reachable via the dev console)
        // falls back to the slowest rather than throwing off the indexing.
        const next = i === -1 ? 0 : Math.min(TIME_SCALES.length - 1, Math.max(0, i + direction));
        state.sim.timeScale = TIME_SCALES[next]!;
      },
      onReset: () => resetRace(),
      onOverview: () => {
        state.camera = { mode: 'overview', target: null };
        fitToRoutes(map, [...state.routesBySlug.values()]);
      },
      onFollowLeader: () => {
        state.camera = { mode: 'follow', target: 'leader' };
        resetChaseCam(map);
      },
      onFree: () => {
        state.camera = { mode: 'free', target: state.camera.target };
      },
      onCycleCar: (direction) => {
        // Steps through the field in current race order, so left/right means
        // "the car ahead of / behind this one" rather than roster order.
        const ranked = raceRank(state.sim.cars, state.sim.simTime);
        if (ranked.length === 0) return;
        const current = resolveCameraTargetCar(
          state.sim.cars,
          state.camera.mode === 'follow' ? state.camera.target : null,
          state.sim.simTime,
        );
        const currentIndex = current ? ranked.findIndex((c) => c === current) : -1;
        // Wraps, so holding one direction cycles the whole field.
        const nextIndex = (currentIndex + direction + ranked.length) % ranked.length;
        state.camera = { mode: 'follow', target: ranked[nextIndex]!.spec.id };
        resetChaseCam(map);
      },
    });

    const configPanel = initConfigPanel(
      configTriggerOrNull,
      configPanelOrNull,
      routeStore,
      CARS,
      initialRouteSlug,
      initialCarIds,
      state.globalCapEnabled,
      state.weather,
      state.startIntervalS,
      {
        onApply: (result) => {
          applyConfig(result).catch((err: unknown) => {
            console.error(err);
            configPanel.showError(err instanceof Error ? err.message : 'Failed to apply configuration.');
          });
        },
      },
    );

    async function applyConfig(result: ConfigApplyResult) {
      // Two rapid Apply clicks (or a slow loadRoute) can otherwise run two
      // applyConfigs concurrently, and whichever resolves last wins even if
      // it started first — a generation counter makes the later call a
      // no-op instead (B8).
      const gen = ++applyGeneration;
      const distinctSlugs = [...new Set(result.carAssignments.map((a) => a.routeSlug))];
      const loadedRoutes = await Promise.all(distinctSlugs.map((slug) => loadRoute(slug)));
      if (gen !== applyGeneration) return;

      const routesBySlug = new Map(distinctSlugs.map((slug, i) => [slug, loadedRoutes[i]!]));
      state = rebuildRace({
        carAssignments: result.carAssignments,
        routesBySlug,
        globalCapEnabled: result.globalCapEnabled,
        weather: result.weather,
        startIntervalS: result.startIntervalS,
        timeScale: state.sim.timeScale,
      });
      setRouteData(map, state.routesBySlug);
      fitToRoutes(map, [...state.routesBySlug.values()]);
    }

    onCarClick(map, (carId) => {
      state.camera = { mode: 'follow', target: carId };
      resetChaseCam(map);
    });

    // F3: dragging the map while following should break out of follow mode
    // (the "grab to break follow" idiom every map app uses) — otherwise
    // followCar's per-frame jumpTo snaps the pan straight back next frame.
    onUserPan(map, () => {
      if (state.camera.mode === 'follow') {
        state.camera = { mode: 'free', target: state.camera.target };
      }
    });

    // Everything the per-frame render output depends on, as one cheap value.
    // A paused race (config panel open, post-race summary, the standby state
    // before Start) otherwise still re-uploaded the car source, rebuilt the
    // deck.gl layer and redrew the elevation strip sixty times a second to
    // produce a pixel-identical frame — which also kept MapLibre repainting
    // continuously instead of going idle. The key is derived, not a dirty flag
    // set by hand at each of the eight places the camera can change: a flag
    // someone forgets to set is a stale screen.
    let lastRenderKey = '';
    function renderKey(): string {
      return [
        state.sim.simTime,
        state.sim.cars.length,
        state.camera.mode,
        state.camera.target,
        // The terrain toggle moves every car vertically; a window resize
        // changes the profile canvas geometry. Both can happen while paused.
        map.getTerrain() ? 1 : 0,
        window.innerWidth,
        window.innerHeight,
      ].join('|');
    }

    function frame(now: number) {
      const realDeltaSeconds = lastTime === null ? 0 : (now - lastTime) / 1000;
      lastTime = now;

      tick(state.sim, realDeltaSeconds);

      // `sim` identity, not just its clock: Reset builds a new race that also
      // starts at simTime 0, and the HUD has to rebuild for the new car set.
      const key = `${renderKey()}|${simGeneration}`;
      if (key === lastRenderKey) {
        requestAnimationFrame(frame);
        return;
      }
      lastRenderKey = key;

      const cameraFollowsACar = state.camera.mode === 'follow' || state.camera.mode === 'tv';
      const selectedCar = resolveCameraTargetCar(
        state.sim.cars,
        cameraFollowsACar ? state.camera.target : null,
        state.sim.simTime,
      );

      // One interpolateAt per car per frame (P1) — map markers, follow
      // camera, HUD elevation, and profile dots all read from this instead
      // of each re-interpolating the same car's position independently.
      // F1: each car interpolates against its OWN route.
      const samples = new Map(state.sim.cars.map((car) => [car.spec.id, interpolateAt(car.route, car.s)] as const));

      updateCarPositions(
        map,
        state.sim.cars.map((car) => {
          const sample = samples.get(car.spec.id)!;
          return {
            id: car.spec.id,
            type: car.spec.type,
            lon: sample.lon,
            lat: sample.lat,
            // Both are render-only, derived from route geometry at the car's
            // `s` — they place and orient the 3D model. The sim knows neither.
            ele: sample.ele,
            heading: headingAt(car.route, car.s, CAR_HEADING_WINDOW_M),
            colour: car.spec.colour,
            selected: car === selectedCar,
          };
        }),
        now,
      );

      if (state.camera.mode === 'tv' && selectedCar) {
        const sample = samples.get(selectedCar.spec.id)!;
        tvCar(map, sample.lon, sample.lat, headingAt(selectedCar.route, selectedCar.s), now);
      } else if (state.camera.mode === 'follow' && selectedCar) {
        const sample = samples.get(selectedCar.spec.id)!;
        // Heading comes straight from route geometry at the car's `s` — the
        // sim has no notion of it, same as lon/lat. The camera's window is
        // wider than the car models' (CAMERA_HEADING_WINDOW_M is headingAt's
        // default), so this is a second, genuinely different lookup — not a
        // repeat of the one above.
        followCar(map, sample.lon, sample.lat, headingAt(selectedCar.route, selectedCar.s));
      }

      // HUD text is ~8 cells × N cars of textContent writes — throttled to
      // ~10 Hz (P2), visually indistinguishable from 60 Hz for numbers this
      // is HUD text; map markers and profile dots stay at full frame rate.
      hudAccumulator += realDeltaSeconds;
      if (hudAccumulator >= HUD_INTERVAL_S) {
        hudAccumulator = 0;
        hud.render(state.sim.cars, state.camera, samples, state.sim.simTime);
      }
      summary.update(state.sim);
      raceControls.render({
        simTime: state.sim.simTime,
        timeScale: state.sim.timeScale,
        paused: state.sim.paused,
        raceOver: state.sim.raceOver,
      });

      // F1: the elevation profile can only show one road at a time — the
      // followed car's route if we're following someone, else the leader's.
      profileAccumulator += realDeltaSeconds;
      if (profileAccumulator >= PROFILE_INTERVAL_S) {
        profileAccumulator = 0;

        // R6 caution zones. Hazards expire on their own clock, so this has to
        // be re-read rather than pushed on incident — but it is a handful of
        // entries and it shares the elevation strip's cadence, not the frame's.
        setCautionZones(
          map,
          state.sim.hazards.map((h) => ({
            route: h.route,
            s: h.s,
            behindM: CAUTION_BEHIND_M,
            aheadM: CAUTION_AHEAD_M,
          })),
        );
        const primaryCar =
          selectedCar ?? (state.sim.cars.length > 0 ? resolveLeader(state.sim.cars, state.sim.simTime) : null);
        if (primaryCar) {
          const carsOnPrimaryRoute = state.sim.cars.filter((c) => c.route === primaryCar.route);
          profile.render(primaryCar.route, carsOnPrimaryRoute, samples, selectedCar ?? undefined);
        }
        minimap.render(state.routesBySlug, state.sim.cars, selectedCar ?? undefined);
      }

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);

    if (import.meta.env.DEV) {
      (window as unknown as { __debug: unknown }).__debug = {
        map,
        get sim() {
          return state.sim;
        },
        get routesBySlug() {
          return state.routesBySlug;
        },
        get globalCapEnabled() {
          return state.globalCapEnabled;
        },
        get weather() {
          return state.weather;
        },
        get camera() {
          return state.camera;
        },
      };
    }
  });
}

bootstrap().catch((err) => {
  console.error(err);
});
