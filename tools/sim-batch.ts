// Headless batch race runner — §0.4 validation protocol. Runs N seeded races
// against a baked route and reports incident/retirement rates and finish-time
// spread, so every item in REALISM-GUIDE.md can be checked against the rare-
// incident target band without a browser. Run via `npm run sim-batch --
// --route sorocaba-campos --seeds 30`.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, workerData, parentPort } from 'node:worker_threads';
import { assertRoute, radiusAt, surfaceAt } from '../src/route';
import { buildCarSpecs } from '../src/cars';
import { MAX_FIELD_SIZE, PERFORMANCE_TIERS, buildFairField, tierOf } from '../src/roster';
import { createSim, tick, type CarAssignment } from '../src/sim';
import { G, WEATHER_GRIP, START_INTERVAL_S } from '../src/tuning';
import type { CarSpec, Route, Weather, WindPreset } from '../src/types';

// Both route homes, same precedence as the app: committed routes ship in
// public/data/routes/, while the in-app Routes panel bakes into data/routes/
// (outside publicDir — see dev-routes-api.ts, which stitches the two into one
// namespace). Round trips carrying turnaroundS are typically panel-baked, so
// --turnaroundPause is only exercisable if this tool reads both.
const ROUTES_DIRS = [path.resolve('public/data/routes'), path.resolve('data/routes')];
const CARS_PATH = path.resolve('public/data/cars.json');
const WEATHERS: readonly Weather[] = ['dry', 'damp', 'wet'];
const WINDS: readonly WindPreset[] = ['calm', 'breezy', 'windy'];

interface CliArgs {
  route: string;
  seeds: number;
  globalCap: boolean;
  weather: Weather;
  jobs: number;
  startIntervalS: number;
  /** Which slice of the ~200-car roster to race — see resolveField. */
  cars: string;
  /** Minutes held at a there-and-back course's turnaround; ignored on
   * one-way routes. */
  turnaroundPauseS: number;
  /** R16: race-level wind preset; direction derives from each seed. */
  wind: WindPreset;
}

/** What the main thread hands each worker. The route is passed by *slug*, not
 * as a parsed object: a 225 km route is ~9000 points, and structured-cloning
 * that to every worker costs more than each worker re-reading the file. */
interface WorkerInput {
  route: string;
  seeds: number[];
  globalCap: boolean;
  weather: Weather;
  startIntervalS: number;
  cars: string;
  turnaroundPauseS: number;
  wind: WindPreset;
}

/** Results are tagged with their seed so the main thread can restore seed
 * order — workers finish out of order, and while every statistic printed
 * below is order-independent, an ordered array keeps output reproducible. */
interface SeededResult {
  seed: number;
  result: RaceResult;
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
  const wind = values.wind ?? 'calm';
  if (!WINDS.includes(wind as WindPreset)) {
    throw new Error(`--wind must be one of ${WINDS.join('/')}, got "${wind}"`);
  }
  const seeds = values.seeds ? Number(values.seeds) : 30;
  // Leave a core for the OS and the main thread. Never more workers than
  // seeds — an idle worker still pays full route-parse startup.
  const defaultJobs = Math.max(1, Math.min(seeds, availableParallelism() - 1));
  const jobs = values.jobs ? Math.max(1, Math.min(seeds, Number(values.jobs))) : defaultJobs;
  return {
    route: values.route ?? 'sorocaba-campos',
    seeds,
    globalCap: values.globalCap ? values.globalCap !== 'false' : true,
    weather: weather as Weather,
    jobs,
    // Mirrors the app's shipped default so the validation protocol measures
    // the race format players actually get, not a mass start nothing uses.
    startIntervalS: values.startInterval !== undefined ? Number(values.startInterval) : START_INTERVAL_S,
    cars: values.cars ?? 'grid',
    turnaroundPauseS: values.turnaroundPause !== undefined ? Number(values.turnaroundPause) * 60 : 0,
    wind: wind as WindPreset,
  };
}

/**
 * Which cars race. The roster is ~200 strong now, and racing all of it per
 * seed is both far slower (cross-car reads are O(n²) per step) and less
 * meaningful — a field spanning a Fiat Uno to a Bugatti Bolide measures
 * nothing about racing. So the default matches what the app actually runs:
 * one fair, capped grid.
 *
 *   --cars grid          (default) a competitive MAX_FIELD_SIZE-car field
 *   --cars all           the entire roster, the pre-expansion behaviour
 *   --cars <tier>        a fair grid drawn from one performance tier
 *                        (economy/everyday/sport/performance/super/hyper)
 *   --cars id1,id2,...   exactly these car ids
 */
function resolveField(specs: CarSpec[], cars: string): CarSpec[] {
  if (cars === 'all') return specs;
  if (cars === 'grid') return buildFairField(specs, MAX_FIELD_SIZE);
  const tier = PERFORMANCE_TIERS.find((t) => t.id === cars);
  if (tier) {
    const pool = specs.filter((s) => tierOf(s).id === tier.id);
    if (pool.length === 0) throw new Error(`No cars in tier "${cars}"`);
    return buildFairField(pool, MAX_FIELD_SIZE);
  }
  const ids = cars.split(',').map((s) => s.trim());
  const picked = ids.map((id) => {
    const spec = specs.find((s) => s.id === id);
    if (!spec) throw new Error(`Unknown car id "${id}" in --cars`);
    return spec;
  });
  return picked;
}

// Node-only route load (not src/route.ts's loadRoute — that fetches).
function loadRouteSync(slug: string): Route {
  for (const dir of ROUTES_DIRS) {
    const file = path.join(dir, `${slug}.json`);
    if (!existsSync(file)) continue;
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    assertRoute(raw, slug);
    return raw;
  }
  throw new Error(`Route "${slug}" not found in ${ROUTES_DIRS.map((d) => path.relative('.', d)).join(' or ')}`);
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
// Safety valve. Generous enough to cover an interval start's tail: the last
// car is released (N-1) x interval into the race and then still has to run it.
const MAX_SIM_SECONDS = 12 * 3600;

function runRace(
  route: Route,
  specs: CarSpec[],
  seed: number,
  globalCapEnabled: boolean,
  weather: Weather,
  startIntervalS: number,
  turnaroundPauseS: number,
  wind: WindPreset,
): RaceResult {
  const assignments: CarAssignment[] = specs.map((spec) => ({ spec, route }));
  const sim = createSim(assignments, seed, globalCapEnabled, weather, startIntervalS, turnaroundPauseS, wind);

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

/** Runs `seeds` in this thread. Used by every worker, and by the main thread
 * when --jobs 1 (worker startup isn't worth it for a single shard, and an
 * inline run keeps stack traces readable while debugging the sim). */
function runSeeds(input: WorkerInput): SeededResult[] {
  const route = loadRouteSync(input.route);
  const specs = resolveField(loadCarsSync(), input.cars);
  return input.seeds.map((seed) => ({
    seed,
    result: runRace(
      route,
      specs,
      seed,
      input.globalCap,
      input.weather,
      input.startIntervalS,
      input.turnaroundPauseS,
      input.wind,
    ),
  }));
}

/** Round-robin rather than contiguous blocks: race cost varies with how early
 * cars retire, so interleaving keeps the shards evenly sized in wall-clock
 * terms even when one stretch of seeds happens to run long. */
function shardSeeds(total: number, jobs: number): number[][] {
  const shards: number[][] = Array.from({ length: jobs }, () => []);
  for (let seed = 1; seed <= total; seed++) shards[(seed - 1) % jobs]!.push(seed);
  return shards.filter((s) => s.length > 0);
}

function runShardInWorker(input: WorkerInput): Promise<SeededResult[]> {
  return new Promise((resolve, reject) => {
    // `new URL(import.meta.url)` re-enters *this* file in the worker, where
    // the isMainThread guard at the bottom routes to runSeeds instead of
    // main. tsx's loader is inherited by workers, so no build step is needed.
    const worker = new Worker(new URL(import.meta.url), { workerData: input });
    worker.once('message', resolve);
    worker.once('error', reject);
    worker.once('exit', (code) => {
      if (code !== 0) reject(new Error(`sim-batch worker exited with code ${code}`));
    });
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const route = loadRouteSync(args.route);
  const specs = resolveField(loadCarsSync(), args.cars);

  console.log(
    `sim-batch: route=${args.route} (${(route.totalDistance / 1000).toFixed(1)} km), ` +
      `cars=${specs.length} (--cars ${args.cars}), seeds=${args.seeds}, globalCap=${args.globalCap}, weather=${args.weather}, ` +
      `jobs=${args.jobs}, startInterval=${args.startIntervalS}s, turnaroundPause=${args.turnaroundPauseS}s, wind=${args.wind}`,
  );

  const startedAt = Date.now();
  const shards = shardSeeds(args.seeds, args.jobs);
  const base = {
    route: args.route,
    globalCap: args.globalCap,
    weather: args.weather,
    startIntervalS: args.startIntervalS,
    cars: args.cars,
    turnaroundPauseS: args.turnaroundPauseS,
    wind: args.wind,
  };
  const seeded =
    args.jobs === 1
      ? shards.flatMap((seeds) => runSeeds({ ...base, seeds }))
      : (await Promise.all(shards.map((seeds) => runShardInWorker({ ...base, seeds })))).flat();

  seeded.sort((a, b) => a.seed - b.seed);
  const results: RaceResult[] = seeded.map((s) => s.result);
  console.log(`Ran ${results.length} races in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);

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
  // Crash counts by third only mean something against how much crashable road
  // each third holds. On the shipped Serra routes the twisty section IS the
  // final third (581 tight points vs 22/12 on sorocaba-monte verde), so a raw
  // late-third majority is geometry, not the R11 adaptation failing — verified
  // by per-incident diagnosis: late crashes sit at the same U ≈ 1.0 transients
  // as early ones, at a LOWER rate per tight corner. Wear adaptation failing
  // looks like the per-exposure ratio climbing, not the raw count.
  const TIGHT_CORNER_RADIUS_M = 120; // the radius band where this field's transient crashes actually happen
  const exposure: [number, number, number] = [0, 0, 0];
  for (const p of route.points) {
    if (radiusAt(route, p.s) < TIGHT_CORNER_RADIUS_M) {
      const third = Math.min(2, Math.floor((p.s / route.totalDistance) * 3));
      exposure[third] = exposure[third]! + 1;
    }
  }
  const perExposure = totalCrashByThird.map((n, i) => (exposure[i]! > 0 ? (n / exposure[i]!).toFixed(2) : '—'));
  console.log(
    `Crash incidents by race-distance third: early=${totalCrashByThird[0]} mid=${totalCrashByThird[1]} late=${totalCrashByThird[2]} ` +
      `over tight-corner exposure ${exposure[0]}/${exposure[1]}/${exposure[2]} points (<${TIGHT_CORNER_RADIUS_M} m radius) ` +
      `→ per-exposure ${perExposure[0]}/${perExposure[1]}/${perExposure[2]} ` +
      `(R11's adaptation check — the per-exposure rate should not CLIMB toward the late thirds; ` +
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

if (isMainThread) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
} else {
  parentPort!.postMessage(runSeeds(workerData as WorkerInput));
}
