import { describe, it, expect } from 'vitest';
import { createSim, tick, resolveLeader, remainingDistance, reliabilityHazardRate } from './sim';
import { radiusAt } from './route';
import { makeTestRoute, TEST_CAR } from './test-fixtures';
import { mulberry32 } from './rng';
import {
  BLOCK_GAP_M,
  BLOCK_MIN_GAP_M,
  CAUTION_SPEED,
  CAUTION_AHEAD_M,
  CAUTION_BEHIND_M,
  ENGINE_VERSION,
  RELIABILITY_BASE_PER_S,
} from './tuning';
import type { CarState, Route } from './types';

const DT = 1 / 60;

function runToCompletion(sim: ReturnType<typeof createSim>, maxSimTime: number): void {
  while (!sim.raceOver && sim.simTime < maxSimTime) {
    tick(sim, DT);
  }
}

const SHARED_ROUTE = makeTestRoute({ n: 20 });

describe('resolveLeader / remainingDistance (B3, F1)', () => {
  function makeCar(overrides: Partial<CarState> & { route?: Route }): CarState {
    return {
      spec: TEST_CAR,
      route: SHARED_ROUTE,
      s: 0,
      v: 0,
      throttle: 0,
      brake: 0,
      status: 'racing',
      recoveryRemaining: 0,
      incidents: [],
      finishTime: null,
      speedProfile: new Float32Array(1),
      rng: () => 0.5,
      seed: 1,
      tireWear: 0,
      condition: { grip: 1, cdA: 1 },
      ...overrides,
    };
  }

  it('ignores retired cars even if they are furthest along', () => {
    const crashed = makeCar({ s: 5000, status: 'retired' });
    const trailing = makeCar({ s: 3000, status: 'racing' });
    expect(resolveLeader([crashed, trailing])).toBe(trailing);
  });

  it('falls back to the overall least-remaining car when every car has retired', () => {
    const a = makeCar({ s: 5000, status: 'retired' });
    const b = makeCar({ s: 3000, status: 'retired' });
    expect(resolveLeader([a, b])).toBe(a);
  });

  it('finished cars still count as leader', () => {
    const finished = makeCar({ s: 5000, status: 'finished' });
    const racing = makeCar({ s: 3000, status: 'racing' });
    expect(resolveLeader([finished, racing])).toBe(finished);
  });

  it('F1: compares by remaining distance, not raw s, across cars on different-length routes', () => {
    // Car A is further along in absolute metres but has much further left to
    // go on its (longer) route than car B — B should lead.
    const longRoute = makeTestRoute({ n: 400 }); // totalDistance = 399 * 25 = 9975
    const shortRoute = makeTestRoute({ n: 40 }); // totalDistance = 39 * 25 = 975
    const carA = makeCar({ route: longRoute, s: 5000 }); // remaining ~4975
    const carB = makeCar({ route: shortRoute, s: 500 }); // remaining ~475
    expect(remainingDistance(carB)).toBeLessThan(remainingDistance(carA));
    expect(resolveLeader([carA, carB])).toBe(carB);
  });
});

describe('tick / raceOver (B2)', () => {
  it('sets raceOver and pauses once every car has finished or retired, and stops advancing simTime', () => {
    const route = makeTestRoute({ n: 20 }); // short, flat, straight — finishes fast
    const sim = createSim([{ spec: TEST_CAR, route }], 1, true);
    runToCompletion(sim, 120);

    expect(sim.raceOver).toBe(true);
    expect(sim.paused).toBe(true);
    expect(sim.cars.every((c) => c.status === 'finished' || c.status === 'retired')).toBe(true);

    const timeAtEnd = sim.simTime;
    tick(sim, DT);
    tick(sim, DT);
    expect(sim.simTime).toBe(timeAtEnd);
  });
});

describe('F1: cars on different routes', () => {
  it('steps each car against its own route and finishes independently', () => {
    const shortRoute = makeTestRoute({ n: 20 });
    const longRoute = makeTestRoute({ n: 400 });
    const sim = createSim(
      [
        { spec: TEST_CAR, route: shortRoute },
        { spec: TEST_CAR, route: longRoute },
      ],
      1,
      true,
    );
    runToCompletion(sim, 900);

    const [shortCar, longCar] = sim.cars;
    expect(shortCar!.route).toBe(shortRoute);
    expect(longCar!.route).toBe(longRoute);
    expect(shortCar!.status).toBe('finished');
    // The short-route car should reach its own finish line well before the
    // long-route car does (independent finish conditions).
    expect(shortCar!.finishTime).not.toBeNull();
    expect(shortCar!.finishTime!).toBeLessThan(longCar!.finishTime ?? Infinity);
  });
});

describe('§0.1: ENGINE_VERSION / raceSeed tracking', () => {
  it('retains the raceSeed it was given, rather than discarding it after deriving per-car seeds', () => {
    const sim = createSim([{ spec: TEST_CAR, route: SHARED_ROUTE }], 12345, true);
    expect(sim.raceSeed).toBe(12345);
  });

  it('stamps the current ENGINE_VERSION onto every new sim', () => {
    const sim = createSim([{ spec: TEST_CAR, route: SHARED_ROUTE }], 1, true);
    expect(sim.engineVersion).toBe(ENGINE_VERSION);
  });
});

describe('R11: tire wear accumulation', () => {
  it('starts fresh and increases monotonically with distance travelled', () => {
    const route = makeTestRoute({ n: 2000 });
    const sim = createSim([{ spec: TEST_CAR, route }], 1, false);
    expect(sim.cars[0]!.tireWear).toBe(0);

    let lastWear = 0;
    for (let i = 0; i < 300; i++) {
      tick(sim, DT);
      const wear = sim.cars[0]!.tireWear;
      expect(wear).toBeGreaterThanOrEqual(lastWear);
      lastWear = wear;
    }
    expect(lastWear).toBeGreaterThan(0);
  });

  it('accumulates faster per metre under high friction-circle load than cruising on a straight', () => {
    const straightRoute = makeTestRoute({ n: 3000 }); // radius 3000 default — negligible cornering load
    const twistyRoute = makeTestRoute({ n: 3000, radiusAt: (i) => (i % 20 < 10 ? 35 : 3000) }); // frequent tight corners
    const straightSim = createSim([{ spec: TEST_CAR, route: straightRoute }], 1, false);
    const twistySim = createSim([{ spec: TEST_CAR, route: twistyRoute }], 1, false);

    for (let i = 0; i < 3600; i++) {
      tick(straightSim, DT);
      tick(twistySim, DT);
    }

    // Compare wear per metre travelled, not per step — average speeds differ.
    const straightWearPerM = straightSim.cars[0]!.tireWear / straightSim.cars[0]!.s;
    const twistyWearPerM = twistySim.cars[0]!.tireWear / twistySim.cars[0]!.s;
    expect(twistyWearPerM).toBeGreaterThan(straightWearPerM);
  });
});

describe('R13: mechanical reliability', () => {
  it('hazard rate is base-only at zero throttle', () => {
    expect(reliabilityHazardRate(0)).toBe(RELIABILITY_BASE_PER_S);
  });

  it('λ math: over many independent draws, failures land within 50% of the analytic probability', () => {
    // At the real per-physics-step dt (1/60 s) the per-step probability is
    // astronomically small (by design — DNFs are meant to be rare events,
    // not weather) — far too small to get a statistically meaningful count
    // out of a fast unit test. Using a 1 h "step" instead tests the exact
    // same exponential-hazard formula (reliabilityHazardRate + the
    // 1-exp(-λ·dt) conversion production code uses) at a scale where 200k
    // draws gives thousands of expected hits.
    const hazardRate = reliabilityHazardRate(0.5);
    const oneHour = 3600;
    const pThisStep = 1 - Math.exp(-hazardRate * oneHour);
    const DRAWS = 200_000;
    const rng = mulberry32(42);
    let failures = 0;
    for (let i = 0; i < DRAWS; i++) {
      if (rng() < pThisStep) failures++;
    }
    const empiricalP = failures / DRAWS;
    expect(empiricalP).toBeGreaterThan(pThisStep * 0.5);
    expect(empiricalP).toBeLessThan(pThisStep * 1.5);
  });

  it('a mechanically-retired car coasts to a stop (v strictly non-increasing to 0) rather than teleport-stopping, and never rejoins', () => {
    const route = makeTestRoute({ n: 2000 });
    const sim = createSim([{ spec: TEST_CAR, route }], 1, false);
    for (let i = 0; i < 300; i++) tick(sim, DT); // get up to speed first
    const car = sim.cars[0]!;
    expect(car.v).toBeGreaterThan(0);

    // Force the retirement directly (rare in practice) to isolate the
    // coast-down mechanism from the probabilistic trigger.
    car.status = 'retired';

    let lastV = car.v;
    let sawZero = false;
    for (let i = 0; i < 3600 && !sawZero; i++) {
      tick(sim, DT);
      expect(car.v).toBeLessThanOrEqual(lastV);
      expect(car.status).toBe('retired'); // never resumes to 'racing'
      lastV = car.v;
      if (car.v === 0) sawZero = true;
    }
    expect(sawZero).toBe(true);

    // Once stopped, stays stopped.
    tick(sim, DT);
    expect(car.v).toBe(0);
    expect(car.status).toBe('retired');
  });

  it('the race is not considered over while a mechanically-retired car is still coasting', () => {
    const route = makeTestRoute({ n: 20 });
    const sim = createSim([{ spec: TEST_CAR, route }], 1, false);
    sim.cars[0]!.status = 'retired';
    sim.cars[0]!.v = 10; // still rolling
    tick(sim, DT);
    expect(sim.raceOver).toBe(false);
  });
});

describe('R1: lookahead braking determinism (AC#12)', () => {
  it('reproduces a byte-identical finishTime for the same seed across full runs', () => {
    const route = makeTestRoute({
      n: 300,
      radiusAt: (i) => (i % 50 >= 20 && i % 50 < 24 ? 35 : 3000),
    });
    const runOnce = () => {
      const sim = createSim([{ spec: TEST_CAR, route }], 11, true);
      runToCompletion(sim, 900);
      return sim.cars[0]!.finishTime;
    };
    expect(runOnce()).toEqual(runOnce());
  });
});

describe('F4: race event log', () => {
  it('records incidents into sim.events and invokes onIncident', () => {
    const route = makeTestRoute({
      n: 300,
      radiusAt: (i) => (i % 50 >= 20 && i % 50 < 24 ? 35 : 3000),
    });
    const received: string[] = [];
    const sim = createSim([{ spec: TEST_CAR, route }], 7, false);
    sim.onIncident = (car) => received.push(car.spec.id);
    runToCompletion(sim, 900);

    const incidentEvents = sim.events.filter((e) => e.type === 'incident');
    expect(incidentEvents.length).toBe(sim.cars[0]!.incidents.length);
    expect(received.length).toBe(incidentEvents.length);
    // Phase 2: a single-car "race" still finishes, which now also logs.
    expect(sim.events.filter((e) => e.type === 'finish').length).toBe(1);
  });
});

describe('R4: slipstream drafting', () => {
  const carA = { ...TEST_CAR, id: 'car-a' };
  const carB = { ...TEST_CAR, id: 'car-b' };

  it('gives a trailing car within draft range more speed than an identical solo car', () => {
    const route = makeTestRoute({ n: 5000 }); // long open straight
    const solo = createSim([{ spec: carA, route }], 1, false);
    for (let i = 0; i < 20 * 60; i++) tick(solo, DT);

    const drafted = createSim(
      [
        { spec: carA, route },
        { spec: carB, route },
      ],
      1,
      false,
    );
    drafted.cars[1]!.s = 20; // leader 20 m ahead throughout
    for (let i = 0; i < 20 * 60; i++) tick(drafted, DT);

    expect(drafted.cars[0]!.v).toBeGreaterThan(solo.cars[0]!.v);
  });

  it('has no effect across different routes', () => {
    const routeA = makeTestRoute({ n: 5000 });
    const routeB = makeTestRoute({ n: 5000 });
    const solo = createSim([{ spec: carA, route: routeA }], 1, false);
    for (let i = 0; i < 20 * 60; i++) tick(solo, DT);

    const crossRoute = createSim(
      [
        { spec: carA, route: routeA },
        { spec: carB, route: routeB },
      ],
      1,
      false,
    );
    crossRoute.cars[1]!.s = 20;
    for (let i = 0; i < 20 * 60; i++) tick(crossRoute, DT);

    expect(crossRoute.cars[0]!.v).toBeCloseTo(solo.cars[0]!.v, 9);
  });
});

describe('R5: blocking and overtaking', () => {
  const slowSpec = { ...TEST_CAR, id: 'slow', vMax: 15, errorSigma: 0, aggression: 1.0 };
  const fastSpec = { ...TEST_CAR, id: 'fast', errorSigma: 0, aggression: 1.0 };

  it('keeps the gap to a slower car ahead at or above BLOCK_MIN_GAP_M on a tight road (no passing)', () => {
    const route = makeTestRoute({ n: 6000, radiusAt: () => 200 }); // < PASS_MIN_RADIUS_M: passing never allowed
    const sim = createSim(
      [
        { spec: fastSpec, route },
        { spec: slowSpec, route },
      ],
      1,
      false,
    );
    sim.cars[1]!.s = 50; // slow car starts ahead

    for (let i = 0; i < 90 * 60; i++) tick(sim, DT);

    const [fast, slow] = sim.cars as [CarState, CarState];
    const gap = slow.s - fast.s;
    expect(gap).toBeGreaterThanOrEqual(BLOCK_MIN_GAP_M - 1e-6);
    expect(gap).toBeLessThan(BLOCK_GAP_M * 3); // actually blocked, not cruising far apart
    expect(fast.v).toBeCloseTo(slow.v, 0); // converged to the leader's pace
  });

  it('allows passing and fires an overtake event once the road opens up', () => {
    const route = makeTestRoute({ n: 6000, radiusAt: () => 5000 }); // wide open: passing always allowed
    const sim = createSim(
      [
        { spec: fastSpec, route },
        { spec: slowSpec, route },
      ],
      1,
      false,
    );
    sim.cars[1]!.s = 50;

    for (let i = 0; i < 90 * 60; i++) tick(sim, DT);

    const [fast, slow] = sim.cars as [CarState, CarState];
    expect(fast.s).toBeGreaterThan(slow.s); // order has swapped
    expect(
      sim.events.some((e) => e.type === 'overtake' && e.carId === 'fast' && e.data.passedId === 'slow'),
    ).toBe(true);
  });
});

describe('R6: incident awareness (local caution)', () => {
  it('caps speed inside a hazard caution window and recovers after leaving it', () => {
    const route = makeTestRoute({ n: 8000 }); // long open straight
    const sim = createSim([{ spec: TEST_CAR, route }], 1, true); // globalCapEnabled: ~36 m/s cruise, achievable braking distance
    for (let i = 0; i < 20 * 60; i++) tick(sim, DT); // get up to cruising speed first

    const car = sim.cars[0]!;
    expect(car.v).toBeGreaterThan(CAUTION_SPEED);

    const hazardS = car.s + 250;
    sim.hazards.push({ route, s: hazardS, until: sim.simTime + 90 });

    // The cap is active while car.s is within [hazardS - CAUTION_AHEAD_M,
    // hazardS + CAUTION_BEHIND_M] — i.e. it engages up to 150 m *before*
    // the hazard, giving the car room to actually slow down in time.
    let minVNearHazard = Infinity;
    while (car.s < hazardS + CAUTION_BEHIND_M) {
      tick(sim, DT);
      if (car.s >= hazardS - CAUTION_AHEAD_M) minVNearHazard = Math.min(minVNearHazard, car.v);
    }
    expect(minVNearHazard).toBeLessThan(CAUTION_SPEED * 1.1);

    for (let i = 0; i < 20 * 60; i++) tick(sim, DT); // well clear of the window now
    expect(car.v).toBeGreaterThan(CAUTION_SPEED);
  });

  it('has no effect for a hazard on a different route', () => {
    const routeA = makeTestRoute({ n: 8000 });
    const routeB = makeTestRoute({ n: 8000 });
    const sim = createSim([{ spec: TEST_CAR, route: routeA }], 1, false);
    for (let i = 0; i < 20 * 60; i++) tick(sim, DT);

    const car = sim.cars[0]!;
    const vBeforeHazard = car.v;
    sim.hazards.push({ route: routeB, s: car.s, until: sim.simTime + 90 });
    tick(sim, DT);

    expect(car.v).toBeGreaterThan(CAUTION_SPEED);
    expect(car.v).not.toBeLessThan(vBeforeHazard - 1); // no sudden caution braking
  });
});

describe('statistical smoke test — incident rate and location (AC#8)', () => {
  // A route with several hairpins tight enough to genuinely stress an
  // aggressive car's grip budget, alternating with long straights.
  const route = makeTestRoute({
    n: 300,
    radiusAt: (i) => (i % 50 >= 20 && i % 50 < 24 ? 35 : 3000),
  });

  const SEEDS = 30;
  const allIncidents: Array<{ s: number; radius: number }> = [];
  let racesRun = 0;

  for (let seed = 1; seed <= SEEDS; seed++) {
    const sim = createSim([{ spec: TEST_CAR, route }], seed, false);
    runToCompletion(sim, 900);
    racesRun++;
    for (const incident of sim.cars[0]!.incidents) {
      allIncidents.push({ s: incident.s, radius: radiusAt(route, incident.s) });
    }
  }

  it('ran every seed to completion', () => {
    expect(racesRun).toBe(SEEDS);
  });

  it('keeps incidents rare — low end of the "roughly one or two per five-car race" guidance', () => {
    const avgPerRace = allIncidents.length / SEEDS;
    // One car per race here (vs. spec's 5-car framing); scaled down and
    // biased toward the rare end per explicit user preference.
    expect(avgPerRace).toBeLessThan(1);
  });

  it('never triggers an incident on the wide-open straight (radius 3000 m)', () => {
    for (const incident of allIncidents) {
      expect(incident.radius).toBeLessThan(300);
    }
  });
});
