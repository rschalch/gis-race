import 'maplibre-gl/dist/maplibre-gl.css';
import { loadRoute, loadRouteIndex, interpolateAt } from './route';
import { initMap, updateCarPositions, setRouteData, fitToRoutes, followCar, onCarClick, onUserPan } from './render/map';
import { initHud, type CameraState } from './render/hud';
import { initRaceControls } from './render/race-controls';
import { initProfile } from './render/profile';
import { initConfigPanel, type ConfigApplyResult } from './render/config-panel';
import { initRoutesPanel } from './render/routes-panel';
import { createRouteStore } from './render/route-store';
import { createSim, tick, resolveLeader, type CarAssignment, type Sim } from './sim';
import type { CarState, Incident, Route, Weather } from './types';
import { loadCars } from './cars';

const HUD_INTERVAL_S = 0.1; // ~10 Hz (P2) — HUD text writes, not map markers

function resolveCameraTargetCar(cars: CarState[], target: string | 'leader' | null): CarState | null {
  if (target === null) return null;
  if (target === 'leader') return resolveLeader(cars);
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
  timeScale: number,
  onIncident: Sim['onIncident'],
): Sim {
  const sim = createSim(assignments, randomSeed(), globalCapEnabled, weather);
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
  if (!mapContainer) throw new Error('#map container not found');
  if (!hudContainerOrNull) throw new Error('#hud container not found');
  if (!raceControlsContainerOrNull) throw new Error('#race-controls container not found');
  if (!configTriggerOrNull) throw new Error('#config-trigger not found');
  if (!configPanelOrNull) throw new Error('#config-panel not found');
  if (!routesTriggerOrNull) throw new Error('#routes-trigger not found');
  if (!routesPanelOrNull) throw new Error('#routes-panel not found');
  if (!(profileCanvasOrNull instanceof HTMLCanvasElement)) throw new Error('#profile canvas not found');
  const hudContainer: HTMLElement = hudContainerOrNull;
  const raceControlsContainer: HTMLElement = raceControlsContainerOrNull;
  const profileCanvas: HTMLCanvasElement = profileCanvasOrNull;

  const routeStore = createRouteStore(routeIndex);
  const initialRouteSlug = routeIndex[0]!.slug;
  const initialRoute = await loadRoute(initialRouteSlug);
  const initialCarIds = new Set(CARS.map((c) => c.id)); // default: everyone races
  const initialRoutesBySlug = new Map([[initialRouteSlug, initialRoute]]);

  initMap(mapContainer, initialRoutesBySlug, (map) => {
    const hud = initHud(hudContainer, {
      onSelectCar: (carId) => {
        state.camera = { mode: 'follow', target: carId };
      },
      onFollowLeader: () => {
        state.camera = { mode: 'follow', target: 'leader' };
      },
      onOverview: () => {
        state.camera = { mode: 'overview', target: null };
        fitToRoutes(map, [...state.routesBySlug.values()]);
      },
      onFree: () => {
        state.camera = { mode: 'free', target: state.camera.target };
      },
    });

    const raceControls = initRaceControls(raceControlsContainer, {
      onSetTimeScale: (scale) => {
        state.sim.timeScale = scale;
      },
      onTogglePause: () => {
        state.sim.paused = !state.sim.paused;
      },
      onReset: () => {
        // Reset never changes routes or assignments, so it can rebuild
        // synchronously from what's already loaded — no network round-trip.
        state = rebuildRace({
          carAssignments: state.carAssignments,
          routesBySlug: state.routesBySlug,
          globalCapEnabled: state.globalCapEnabled,
          weather: state.weather,
          timeScale: state.sim.timeScale,
        });
        fitToRoutes(map, [...state.routesBySlug.values()]);
      },
    });

    const profile = initProfile(profileCanvas);

    function handleIncident(car: CarState, incident: Incident): void {
      hud.pushIncident(car, incident);
      if (import.meta.env.DEV) {
        console.log(
          `[incident] ${car.spec.name} ${incident.severity} at s=${incident.s.toFixed(0)}m ` +
            `t=${incident.time.toFixed(1)}s util=${incident.utilisation.toFixed(2)}`,
        );
      }
    }

    function rebuildRace(overrides: {
      carAssignments: Array<{ carId: string; routeSlug: string }>;
      routesBySlug: Map<string, Route>;
      globalCapEnabled: boolean;
      weather: Weather;
      timeScale: number;
    }): AppState {
      const assignments: CarAssignment[] = overrides.carAssignments.map(({ carId, routeSlug }) => {
        const spec = CARS.find((c) => c.id === carId)!;
        const route = overrides.routesBySlug.get(routeSlug)!;
        return { spec, route };
      });
      return {
        carAssignments: overrides.carAssignments,
        routesBySlug: overrides.routesBySlug,
        globalCapEnabled: overrides.globalCapEnabled,
        weather: overrides.weather,
        sim: createStandbySim(assignments, overrides.globalCapEnabled, overrides.weather, overrides.timeScale, handleIncident),
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
      timeScale: 1,
    });
    let lastTime: number | null = null;
    let hudAccumulator = HUD_INTERVAL_S; // render immediately on the first frame, then throttle
    let applyGeneration = 0;

    initRoutesPanel(routesTriggerOrNull, routesPanelOrNull, routeStore);

    const configPanel = initConfigPanel(
      configTriggerOrNull,
      configPanelOrNull,
      routeStore,
      CARS,
      initialRouteSlug,
      initialCarIds,
      state.globalCapEnabled,
      state.weather,
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
        timeScale: state.sim.timeScale,
      });
      setRouteData(map, state.routesBySlug);
      fitToRoutes(map, [...state.routesBySlug.values()]);
    }

    onCarClick(map, (carId) => {
      state.camera = { mode: 'follow', target: carId };
    });

    // F3: dragging the map while following should break out of follow mode
    // (the "grab to break follow" idiom every map app uses) — otherwise
    // followCar's per-frame jumpTo snaps the pan straight back next frame.
    onUserPan(map, () => {
      if (state.camera.mode === 'follow') {
        state.camera = { mode: 'free', target: state.camera.target };
      }
    });

    function frame(now: number) {
      const realDeltaSeconds = lastTime === null ? 0 : (now - lastTime) / 1000;
      lastTime = now;

      tick(state.sim, realDeltaSeconds);

      const selectedCar = resolveCameraTargetCar(state.sim.cars, state.camera.mode === 'follow' ? state.camera.target : null);

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
            lon: sample.lon,
            lat: sample.lat,
            colour: car.spec.colour,
            selected: car === selectedCar,
          };
        }),
      );

      if (state.camera.mode === 'follow' && selectedCar) {
        const sample = samples.get(selectedCar.spec.id)!;
        followCar(map, sample.lon, sample.lat);
      }

      // HUD text is ~8 cells × N cars of textContent writes — throttled to
      // ~10 Hz (P2), visually indistinguishable from 60 Hz for numbers this
      // is HUD text; map markers and profile dots stay at full frame rate.
      hudAccumulator += realDeltaSeconds;
      if (hudAccumulator >= HUD_INTERVAL_S) {
        hudAccumulator = 0;
        hud.render(state.sim.cars, state.camera, samples);
      }
      raceControls.render({
        simTime: state.sim.simTime,
        timeScale: state.sim.timeScale,
        paused: state.sim.paused,
        raceOver: state.sim.raceOver,
      });

      // F1: the elevation profile can only show one road at a time — the
      // followed car's route if we're following someone, else the leader's.
      const primaryCar = selectedCar ?? (state.sim.cars.length > 0 ? resolveLeader(state.sim.cars) : null);
      if (primaryCar) {
        const carsOnPrimaryRoute = state.sim.cars.filter((c) => c.route === primaryCar.route);
        profile.render(primaryCar.route, carsOnPrimaryRoute, samples);
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
