import { describe, it, expect } from 'vitest';
import { createSim, tick } from './sim';
import { makeTestRoute, TEST_CAR } from './test-fixtures';
import { assertRoute } from './route';
import type { Route } from './types';

/**
 * The scheduled stop at a there-and-back course's turnaround.
 *
 * Nothing here touches the rng, so the whole feature is deterministic by
 * construction — what these check is that it happens exactly once, costs
 * exactly what it should, and stays completely inert on a one-way route (which
 * is what keeps every existing seed reproducible, and is guarded end-to-end by
 * golden.test.ts).
 */

/** A straight test route with a turnaround at its midpoint. */
function roundTripRoute(): Route {
  const route = makeTestRoute({ n: 400 }); // 400 x 25 m = ~10 km
  return { ...route, turnaroundS: route.totalDistance / 2 };
}

function runUntil(sim: ReturnType<typeof createSim>, predicate: () => boolean, maxSeconds = 4000): boolean {
  while (sim.simTime < maxSeconds) {
    tick(sim, 0.25);
    if (predicate()) return true;
  }
  return false;
}

describe('turnaround pause', () => {
  it('stops the car at the turnaround and releases it after the configured time', () => {
    const route = roundTripRoute();
    const pauseS = 120;
    const sim = createSim([{ spec: TEST_CAR, route }], 1, true, 'dry', 0, pauseS);
    const car = sim.cars[0]!;

    expect(runUntil(sim, () => car.status === 'paused'), 'car never reached the turnaround').toBe(true);
    const stoppedAt = sim.simTime;
    expect(car.v).toBe(0);
    expect(car.s).toBeGreaterThanOrEqual(route.turnaroundS!);
    // Stopped *at* the mark, not a long way past it.
    expect(car.s - route.turnaroundS!).toBeLessThan(route.spacing * 2);

    expect(runUntil(sim, () => car.status === 'racing'), 'car never resumed').toBe(true);
    expect(sim.simTime - stoppedAt).toBeGreaterThanOrEqual(pauseS);
    expect(sim.simTime - stoppedAt).toBeLessThan(pauseS + 2);
  });

  it('takes the stop exactly once, not for the whole return leg', () => {
    const route = roundTripRoute();
    const sim = createSim([{ spec: TEST_CAR, route }], 1, true, 'dry', 0, 30);
    const car = sim.cars[0]!;

    let pauses = 0;
    let wasPaused = false;
    while (sim.simTime < 4000 && car.status !== 'finished') {
      tick(sim, 0.25);
      if (car.status === 'paused' && !wasPaused) pauses += 1;
      wasPaused = car.status === 'paused';
    }
    expect(pauses).toBe(1);
    expect(car.turnaroundTaken).toBe(true);
  });

  it('logs the stop so a four-minute gap in the results has an explanation', () => {
    const route = roundTripRoute();
    const sim = createSim([{ spec: TEST_CAR, route }], 1, true, 'dry', 0, 90);
    runUntil(sim, () => sim.cars[0]!.status === 'paused');

    const event = sim.events.find((e) => e.type === 'turnaround');
    expect(event).toBeDefined();
    expect(event?.type === 'turnaround' && event.data.pauseS).toBe(90);
  });

  it('charges the pause, plus the cost of getting going again, to the finishing time', () => {
    const route = roundTripRoute();
    const without = createSim([{ spec: TEST_CAR, route }], 1, true, 'dry', 0, 0);
    const with180 = createSim([{ spec: TEST_CAR, route }], 1, true, 'dry', 0, 180);
    for (const sim of [without, with180]) {
      while (!sim.raceOver && sim.simTime < 6000) tick(sim, 0.5);
    }
    const a = without.cars[0]!.finishTime;
    const b = with180.cars[0]!.finishTime;
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    // Strictly more than the pause, and correctly so: a car that stops has to
    // accelerate from rest afterwards, where one driving through carries its
    // cornering speed out of the turn. Measured at ~2.5 s for this car; the
    // bound is loose enough not to pin an arbitrary number, tight enough to
    // catch the stop being charged twice.
    expect(b! - a!).toBeGreaterThanOrEqual(180);
    expect(b! - a!).toBeLessThan(180 + 15);
  });

  it('does nothing at all on a one-way route, whatever the pause is set to', () => {
    const route = makeTestRoute({ n: 400 }); // no turnaroundS
    const sim = createSim([{ spec: TEST_CAR, route }], 1, true, 'dry', 0, 600);
    const car = sim.cars[0]!;
    while (!sim.raceOver && sim.simTime < 4000) {
      tick(sim, 0.5);
      expect(car.status).not.toBe('paused');
    }
    expect(sim.events.some((e) => e.type === 'turnaround')).toBe(false);
  });

  it('does nothing when the pause is zero, even on a round-trip route', () => {
    const route = roundTripRoute();
    const sim = createSim([{ spec: TEST_CAR, route }], 1, true, 'dry', 0, 0);
    const car = sim.cars[0]!;
    while (!sim.raceOver && sim.simTime < 4000) {
      tick(sim, 0.5);
      expect(car.status).not.toBe('paused');
    }
  });

  it('holds every car in the field, not just the leader', () => {
    const route = roundTripRoute();
    const specs = [TEST_CAR, { ...TEST_CAR, id: 'b' }, { ...TEST_CAR, id: 'c' }];
    const sim = createSim(specs.map((spec) => ({ spec, route })), 1, true, 'dry', 0, 60);
    while (!sim.raceOver && sim.simTime < 6000) tick(sim, 0.5);
    expect(sim.cars.every((c) => c.turnaroundTaken)).toBe(true);
    expect(sim.events.filter((e) => e.type === 'turnaround')).toHaveLength(specs.length);
  });
});

describe('turnaroundS validation', () => {
  const base = makeTestRoute({ n: 20 });

  it('accepts a distance inside the route', () => {
    expect(() => assertRoute({ ...base, turnaroundS: base.totalDistance / 2 }, 'r')).not.toThrow();
  });

  it('accepts a route without one', () => {
    expect(() => assertRoute({ ...base }, 'r')).not.toThrow();
  });

  it('rejects a turnaround at or beyond the finish', () => {
    expect(() => assertRoute({ ...base, turnaroundS: base.totalDistance }, 'r')).toThrow(/turnaroundS/);
    expect(() => assertRoute({ ...base, turnaroundS: 0 }, 'r')).toThrow(/turnaroundS/);
    expect(() => assertRoute({ ...base, turnaroundS: Number.NaN }, 'r')).toThrow(/turnaroundS/);
  });
});
