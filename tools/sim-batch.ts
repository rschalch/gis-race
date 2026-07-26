// Headless batch race runner — §0.4 validation protocol. Runs N seeded races
// against a baked route and reports incident/retirement rates and finish-time
// spread, so every item in REALISM-GUIDE.md can be checked against the rare-
// incident target band without a browser. Run via `npm run sim-batch --
// --route sorocaba-campos --seeds 30`.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { assertRoute, radiusAt, surfaceAt } from '../src/route';
import { buildCarSpecs } from '../src/cars';
import { createSim, tick, type CarAssignment } from '../src/sim';
import { G, WEATHER_GRIP } from '../src/tuning';
import type { CarSpec, Route, Weather } from '../src/types';

const ROUTES_DIR = path.resolve('public/data/routes');
const CARS_PATH = path.resolve('public/data/cars.json');
const WEATHERS: readonly Weather[] = ['dry', 'damp', 'wet'];

interface CliArgs {
  route: string;
  seeds: number;
  globalCap: boolean;
  weather: Weather;
}

function parseArgs(argv: string[]): CliArgs {
  const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for --${key}`);
      values[key] = value;
      i++;
    }
  }
  const weather = values.weather ?? 'dry';
  if (!WEATHERS.includes(weather as Weather)) {
    throw new Error(`--weather must be one of ${WEATHERS.join('/')}, got "${weather}"`);
  }
  return {
    route: values.route ?? 'sorocaba-campos',
    seeds: values.seeds ? Number(values.seeds) : 30,
    globalCap: values.globalCap ? values.globalCap !== 'false' : true,
    weather: weather as Weather,
  };
}

// Node-only route load (not src/route.ts's loadRoute — that fetches).
function loadRouteSync(slug: string): Route {
  const raw: unknown = JSON.parse(readFileSync(path.join(ROUTES_DIR, `${slug}.json`), 'utf-8'));
  assertRoute(raw, slug);
  return raw;
}

function loadCarsSync(): CarSpec[] {
  const raw: unknown = JSON.parse(readFileSync(CARS_PATH, 'utf-8'));
  return buildCarSpecs(raw);
}

interface RaceResult {
  incidentsBySeverity: Record<string, number>;
  crashIncidentsByThird: [number, number, number]; // R11: crash-only incident count by race-distance third (early/mid/late)
  retirements: number;
  mechanicalRetirements: number; // R13: subset of retirements caused by a mechanical DNF
  finishTimes: Record<string, number>; // carId -> finishTime, only for finishers
  peakUtilisationByCarMean: number; // mean across cars of each car's peak U this race
  overtakes: number; // R5
  finalTireWearMean: number; // R11: mean across cars of each car's tireWear at race end
  nanOrInfinite: boolean;
}

// One real second per call keeps the number of JS call-boundary crossings
// manageable on a 265 km / multi-hour race while still sampling peak
// friction-circle utilisation at a reasonably fine (1 Hz) grain — the sim's
// own fixed-DT accumulator still steps physics at 1/60 s underneath.
const SAMPLE_DT_S = 1;
const MAX_SIM_SECONDS = 6 * 3600; // safety valve — no route here takes anywhere near 6h

function runRace(route: Route, specs: CarSpec[], seed: number, globalCapEnabled: boolean, weather: Weather): RaceResult {
  const assignments: CarAssignment[] = specs.map((spec) => ({ spec, route }));
  const sim = createSim(assignments, seed, globalCapEnabled, weather);

  const peakU = new Map<string, number>(specs.map((s) => [s.id, 0]));
  let nanOrInfinite = false;

  while (!sim.raceOver && sim.simTime < MAX_SIM_SECONDS) {
    tick(sim, SAMPLE_DT_S);
    for (const car of sim.cars) {
      if (!Number.isFinite(car.s) || !Number.isFinite(car.v)) nanOrInfinite = true;
      if (car.status !== 'racing') continue;
      const radius = radiusAt(car.route, car.s) * car.spec.lineQuality; // R3: same effective radius as the sim
      const gripMultiplier = WEATHER_GRIP[weather] * surfaceAt(car.route, car.s); // R7/R8: same effective grip
      const U = (car.v * car.v) / radius / (car.spec.muLat * gripMultiplier * G);
      if (U > peakU.get(car.spec.id)!) peakU.set(car.spec.id, U);
    }
  }

  const incidentsBySeverity: Record<string, number> = {};
  // R11's late-third check cares about crash-related incidents (which
  // depend on friction-circle utilisation, hence tire condition) — R13's
  // mechanical DNFs are throttle-driven and independent of tire wear, so
  // mixing them into the same distance-third histogram would confound it.
  const crashIncidentsByThird: [number, number, number] = [0, 0, 0];
  let retirements = 0;
  let mechanicalRetirements = 0;
  const finishTimes: Record<string, number> = {};
  let tireWearSum = 0;
  for (const car of sim.cars) {
    for (const inc of car.incidents) {
      incidentsBySeverity[inc.severity] = (incidentsBySeverity[inc.severity] ?? 0) + 1;
      if (inc.severity === 'mechanical') continue;
      // R11: which third of ITS OWN route the incident happened in — thirds
      // are by distance, not time, so this stays meaningful across cars
      // finishing at different times.
      const thirdIdx = Math.min(2, Math.floor((inc.s / route.totalDistance) * 3));
      crashIncidentsByThird[thirdIdx] = crashIncidentsByThird[thirdIdx]! + 1;
    }
    if (car.status === 'retired') {
      retirements++;
      if (car.incidents.some((inc) => inc.severity === 'mechanical')) mechanicalRetirements++;
    }
    if (car.finishTime !== null) finishTimes[car.spec.id] = car.finishTime;
    tireWearSum += car.tireWear;
    if (!Number.isFinite(car.s) || !Number.isFinite(car.v)) nanOrInfinite = true;
  }

  const peaks = [...peakU.values()];
  const peakUtilisationByCarMean = peaks.reduce((a, b) => a + b, 0) / peaks.length;
  const overtakes = sim.events.filter((e) => e.type === 'overtake').length;
  const finalTireWearMean = tireWearSum / sim.cars.length;

  return {
    incidentsBySeverity,
    crashIncidentsByThird,
    retirements,
    mechanicalRetirements,
    finishTimes,
    peakUtilisationByCarMean,
    overtakes,
    finalTireWearMean,
    nanOrInfinite,
  };
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const route = loadRouteSync(args.route);
  const specs = loadCarsSync();

  console.log(
    `sim-batch: route=${args.route} (${(route.totalDistance / 1000).toFixed(1)} km), ` +
      `cars=${specs.length}, seeds=${args.seeds}, globalCap=${args.globalCap}, weather=${args.weather}`,
  );

  const results: RaceResult[] = [];
  for (let seed = 1; seed <= args.seeds; seed++) {
    results.push(runRace(route, specs, seed, args.globalCap, args.weather));
  }

  const totalCarRaces = args.seeds * specs.length;
  const totalBySeverity: Record<string, number> = {};
  const totalCrashByThird: [number, number, number] = [0, 0, 0];
  let totalRetirements = 0;
  let totalMechanicalRetirements = 0;
  let anyNaN = false;
  const finishTimesByCar: Record<string, number[]> = {};
  const peakMeans: number[] = [];
  let totalOvertakes = 0;
  const tireWearMeans: number[] = [];

  for (const r of results) {
    for (const [sev, count] of Object.entries(r.incidentsBySeverity)) {
      totalBySeverity[sev] = (totalBySeverity[sev] ?? 0) + count;
    }
    for (let i = 0; i < 3; i++) totalCrashByThird[i] = totalCrashByThird[i]! + r.crashIncidentsByThird[i]!;
    totalRetirements += r.retirements;
    totalMechanicalRetirements += r.mechanicalRetirements;
    if (r.nanOrInfinite) anyNaN = true;
    peakMeans.push(r.peakUtilisationByCarMean);
    totalOvertakes += r.overtakes;
    tireWearMeans.push(r.finalTireWearMean);
    for (const [carId, time] of Object.entries(r.finishTimes)) {
      (finishTimesByCar[carId] ??= []).push(time);
    }
  }

  const totalIncidents = Object.values(totalBySeverity).reduce((a, b) => a + b, 0);
  const totalCrashIncidents = totalIncidents - (totalBySeverity.mechanical ?? 0);

  console.log(`\n=== Aggregate over ${args.seeds} races (${totalCarRaces} car-races) ===`);
  console.log('Incidents by severity:', totalBySeverity);
  console.log(
    `Total incidents: ${totalIncidents} (${(totalIncidents / totalCarRaces).toFixed(3)} per car-race) — ` +
      `crash-related: ${totalCrashIncidents} (${(totalCrashIncidents / totalCarRaces).toFixed(3)}/car-race), ` +
      `mechanical (R13): ${totalBySeverity.mechanical ?? 0} (${((totalBySeverity.mechanical ?? 0) / totalCarRaces).toFixed(3)}/car-race)`,
  );
  console.log(
    `Retirements: ${totalRetirements} (${((totalRetirements / totalCarRaces) * 100).toFixed(2)}% of car-races) — ` +
      `off-road: ${totalRetirements - totalMechanicalRetirements} ` +
      `(${(((totalRetirements - totalMechanicalRetirements) / totalCarRaces) * 100).toFixed(2)}%), ` +
      `mechanical: ${totalMechanicalRetirements} (${((totalMechanicalRetirements / totalCarRaces) * 100).toFixed(2)}%)`,
  );
  console.log(
    `Peak friction-circle utilisation (mean-per-race, across cars): ` +
      `mean=${(peakMeans.reduce((a, b) => a + b, 0) / peakMeans.length).toFixed(3)} ` +
      `min=${Math.min(...peakMeans).toFixed(3)} max=${Math.max(...peakMeans).toFixed(3)}`,
  );
  console.log(`NaN/Infinity detected in any CarState: ${anyNaN}`);
  console.log(`Overtakes: ${totalOvertakes} (${(totalOvertakes / args.seeds).toFixed(2)} per race)`);
  console.log(
    `Crash incidents by race-distance third: early=${totalCrashByThird[0]} mid=${totalCrashByThird[1]} late=${totalCrashByThird[2]} ` +
      `(R11's adaptation check — late should stay in the same ballpark as early/mid, not spike; ` +
      `mechanical DNFs excluded — they're throttle-driven, not utilisation-driven, and would confound this)`,
  );
  console.log(
    `R11 final tireWear (mean-per-race, across cars): ` +
      `mean=${(tireWearMeans.reduce((a, b) => a + b, 0) / tireWearMeans.length).toFixed(3)} ` +
      `min=${Math.min(...tireWearMeans).toFixed(3)} max=${Math.max(...tireWearMeans).toFixed(3)}`,
  );

  console.log('\n=== Finish time by car (s), mean/min/max, finish rate ===');
  for (const spec of specs) {
    const times = finishTimesByCar[spec.id] ?? [];
    if (times.length === 0) {
      console.log(`  ${spec.id}: 0/${args.seeds} finishes`);
      continue;
    }
    const mean = times.reduce((a, b) => a + b, 0) / times.length;
    console.log(
      `  ${spec.id}: ${times.length}/${args.seeds} mean=${mean.toFixed(1)} min=${Math.min(...times).toFixed(1)} max=${Math.max(...times).toFixed(1)}`,
    );
  }

  if (anyNaN) {
    console.error('\nFAIL: NaN/Infinity found in CarState at some point during a race.');
    process.exit(1);
  }
}

main();
