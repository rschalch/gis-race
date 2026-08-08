import { describe, it, expect } from 'vitest';
import { createSim, tick } from './sim';
import { evaluateLossOfControl } from './driver';
import { makeTestRoute, TEST_CAR } from './test-fixtures';
import { ENGINE_VERSION } from './tuning';
import type { CarState, Route } from './types';

/**
 * Golden-race regression test.
 *
 * Determinism — same seed reproduces the same race (AC#12, §0.1) — is this
 * project's hardest invariant, and until this file existed nothing guarded it.
 * Every other test checks a property in isolation ("wet is slower than dry"),
 * which a change to the driver model, the rng draw order, or a tuning constant
 * can satisfy perfectly while still silently producing a completely different
 * race for every existing seed.
 *
 * What this pins is the *whole engine end to end*: one fixed seed over a fixed
 * route with a fixed roster, asserted down to finish times and the exact
 * sequence of incidents.
 *
 * ## When this test fails
 *
 * It is doing its job. A failure means the engine now produces a different
 * race for the same seed, which is a legitimate thing to do — most items in
 * REALISM-GUIDE.md do it — but it must be a *decision*, not a surprise. So:
 *
 *   1. Confirm the change to sim/driver/physics/tuning was intentional.
 *   2. Bump ENGINE_VERSION in tuning.ts and add a line to its comment saying
 *      what changed (§0.1 requires this so a shared seed cannot silently
 *      replay a different race on a newer engine).
 *   3. Re-record the constants below by running:
 *        npx vitest run src/golden.test.ts --reporter=verbose
 *      and reading the actual values out of the failure diff.
 *
 * If you did NOT change sim behaviour and this failed anyway, that is a real
 * bug — something has made the engine order-dependent or non-reproducible.
 */

// Recorded on this engine version. Bumping ENGINE_VERSION without re-recording
// the values below is exactly the mistake this pairing is here to catch.
// (v5 → v6 re-recorded nothing: the golden race has no tight-road blocking
// moment where the v6 clamp-gate fix bites, so its constants are unchanged.
// v6 → v7 likewise: R15 raises per-step failure probabilities by parts in a
// million, and no draw in this short race lands inside the shifted band.
// v7 → v8 re-recorded everything below: R18's driveline launch loss slows
// every getaway, and R17's surface rolling resistance touches the fixture's
// 0.8-surface stretch.)
const GOLDEN_ENGINE_VERSION = 8;

/** A deliberately varied fixture: straights, a tight section, gradient, a
 * surface change and a speed-limit zone, so the golden exercises the corner
 * planner, the lookahead brake, R8 surface grip and R10 limits rather than a
 * single flat straight. */
function goldenRoute(): Route {
  return makeTestRoute({
    n: 400, // ~10 km at 25 m spacing — long enough to diverge, short enough to be fast
    radiusAt: (i) => (i > 150 && i < 200 ? 45 : i > 260 && i < 300 ? 140 : 2500),
    gradeAt: (i) => (i > 100 && i < 180 ? 0.05 : i > 300 ? -0.04 : 0),
    surfaceAt: (i) => (i > 320 && i < 360 ? 0.8 : 1),
    limitAt: (i) => (i > 60 && i < 120 ? 25 : undefined),
  });
}

const GOLDEN_ROSTER = [
  { ...TEST_CAR, id: 'alpha', aggression: 1.04, limitTolerance: 1.05, errorSigma: 0.03 },
  { ...TEST_CAR, id: 'bravo', aggression: 0.94, limitTolerance: 0.99, errorSigma: 0.02, muLat: 0.9 },
  { ...TEST_CAR, id: 'charlie', aggression: 1.0, limitTolerance: 1.02, errorSigma: 0.04, mass: 1800, power: 120_000 },
];

const GOLDEN_SEED = 4242;
const GOLDEN_START_INTERVAL_S = 20;

interface CarSnapshot {
  id: string;
  status: string;
  finishTime: number | null;
  s: number;
  tireWear: number;
  incidents: string[];
}

function runGolden(): { simTime: number; cars: CarSnapshot[]; overtakes: number; starts: number } {
  const route = goldenRoute();
  const sim = createSim(
    GOLDEN_ROSTER.map((spec) => ({ spec, route })),
    GOLDEN_SEED,
    true,
    'damp',
    GOLDEN_START_INTERVAL_S,
  );
  // Fixed real-delta feed: tick's own accumulator does the fixed-DT stepping,
  // but the leftover-accumulator carry means the *feed* has to be fixed too
  // for the run to be reproducible.
  let guard = 0;
  while (!sim.raceOver && guard++ < 200_000) tick(sim, 1 / 60);

  return {
    simTime: sim.simTime,
    overtakes: sim.events.filter((e) => e.type === 'overtake').length,
    starts: sim.events.filter((e) => e.type === 'start').length,
    cars: sim.cars.map(
      (c: CarState): CarSnapshot => ({
        id: c.spec.id,
        status: c.status,
        finishTime: c.finishTime,
        s: c.s,
        tireWear: c.tireWear,
        incidents: c.incidents.map((i) => `${i.severity}@${i.s.toFixed(1)}`),
      }),
    ),
  };
}

describe('golden race (§0.1 determinism)', () => {
  it('is bit-for-bit reproducible from the same seed', () => {
    // The invariant itself, and the only assertion here that is guaranteed
    // identical on every platform — it compares the engine against itself.
    expect(runGolden()).toEqual(runGolden());
  });

  it('still produces the recorded race for the recorded engine version', () => {
    expect(ENGINE_VERSION).toBe(GOLDEN_ENGINE_VERSION);

    const actual = runGolden();

    // Discrete outcomes are asserted exactly: these cannot drift by a rounding
    // difference, only by a behaviour change.
    expect(actual.cars.map((c) => c.id)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(actual.cars.map((c) => c.status)).toEqual(['finished', 'finished', 'finished']);
    expect(actual.cars.map((c) => c.incidents)).toEqual([[], [], []]);
    expect(actual.starts).toBe(2); // two cars released after the flag, one away at t=0
    expect(actual.overtakes).toBe(0);

    // Continuous quantities are asserted to 3 dp rather than exactly. Math.exp,
    // Math.pow, Math.sin and Math.cos are not required by IEEE-754 to be
    // correctly rounded, so their last ulp may legitimately differ between
    // JS engines and platforms — but any real change to sim behaviour moves
    // these by whole seconds, not by 1e-12.
    const byId = new Map(actual.cars.map((c) => [c.id, c]));
    expect(byId.get('alpha')!.finishTime!).toBeCloseTo(319.85000000003777, 3);
    expect(byId.get('bravo')!.finishTime!).toBeCloseTo(344.88333333333014, 3);
    expect(byId.get('charlie')!.finishTime!).toBeCloseTo(334.7666666666545, 3);
    expect(actual.simTime).toBeCloseTo(374.7666666666545, 3);

    expect(byId.get('alpha')!.tireWear).toBeCloseTo(0.034893273097778184, 6);
    expect(byId.get('bravo')!.tireWear).toBeCloseTo(0.03113701677183978, 6);
    expect(byId.get('charlie')!.tireWear).toBeCloseTo(0.03168524141532022, 6);
  });

  // The race above deliberately contains no incidents, and that is not an
  // oversight in the fixture — it is R2 working. The friction-circle throttle
  // cap means a car can never *sustain* an over-limit cornering speed: as U
  // rises the longitudinal budget collapses, throttle goes to zero and the car
  // settles just under the limit. Crashes come from transients (a corner that
  // tightens faster than the lookahead can shed speed), which is exactly what
  // the real-route incident data showed — 23 of 24 in one mountain stretch.
  // Verified while writing this: a car at aggression 1.20 held in a radius-35
  // corner for 5 km had an incident in 0 of 20 seeds.
  //
  // So the §7.5 machinery is pinned directly instead, which is both more
  // reliable and more legible than contriving a race that happens to crash.
  it('pins the loss-of-control law: utilisation, thresholds and severities', () => {
    expect(ENGINE_VERSION).toBe(GOLDEN_ENGINE_VERSION);
    const route = makeTestRoute({ n: 50, radiusAt: () => 60 });

    // rng always returns 0, so the incident roll always fires — severity is
    // then a pure function of utilisation, which pins the threshold constants.
    const atSpeed = (v: number) => {
      const car: CarState = {
        spec: TEST_CAR,
        route,
        s: 500,
        v,
        throttle: 0,
        brake: 0,
        status: 'racing',
        recoveryRemaining: 0,
        incidents: [],
        startDelay: 0,
        heldUpFor: 0,
        passRemaining: 0,
        finishTime: null,
        speedProfile: new Float32Array(1),
        rng: () => 0,
        seed: 1,
        tireWear: 0,
        engineLoad: 0,
        brakeHeat: 0,
    pauseRemaining: 0,
    turnaroundTaken: false,
        condition: { grip: 1, cdA: 1 },
      };
      const u = evaluateLossOfControl(car, route, 0, 0, 1 / 60, 'dry');
      return { u, severity: car.incidents[0]?.severity ?? null };
    };

    // Below the slide threshold: no incident, and utilisation is reported for
    // R11's wear accumulation regardless.
    expect(atSpeed(20).u).toBeCloseTo(0.6606, 3);
    expect(atSpeed(20).severity).toBeNull();
    // Each band of the severity ladder, in order.
    expect(atSpeed(24.5).u).toBeCloseTo(0.9911, 3);
    expect(atSpeed(24.5).severity).toBe('slide');
    expect(atSpeed(25.5).u).toBeCloseTo(1.0736, 3);
    expect(atSpeed(25.5).severity).toBe('spin');
    expect(atSpeed(28).u).toBeCloseTo(1.2948, 3);
    expect(atSpeed(28).severity).toBe('off-road');
  });

  it('classifies on own running time, so the interval start does not decide the result', () => {
    const actual = runGolden();
    const byId = new Map(actual.cars.map((c) => [c.id, c]));
    // charlie is released 40 s after alpha and is the heavy, underpowered car;
    // it must be scored on its own clock, so its finishTime is its own elapsed
    // run, strictly less than the absolute race duration.
    expect(byId.get('charlie')!.finishTime!).toBeLessThan(actual.simTime);
    expect(byId.get('alpha')!.finishTime!).toBeLessThan(byId.get('bravo')!.finishTime!);
  });
});
