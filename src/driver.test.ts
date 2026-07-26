import { describe, it, expect } from 'vitest';
import { computeSpeedProfile, driverControl, evaluateLossOfControl } from './driver';
import { computeAcceleration } from './physics';
import { mulberry32, valueNoise } from './rng';
import { makeTestRoute, TEST_CAR } from './test-fixtures';
import {
  BRAKE_SAFETY_MARGIN,
  WEATHER_GRIP,
  SLIDE_GRIP_DAMAGE,
  SPIN_GRIP_DAMAGE,
  SPIN_CDA_DAMAGE,
  CONDITION_GRIP_FLOOR,
} from './tuning';
import type { CarState } from './types';

describe('computeSpeedProfile', () => {
  it('never exceeds the cornering/aggression/vMax ceiling at any point', () => {
    const route = makeTestRoute({
      n: 200,
      radiusAt: (i) => (i > 90 && i < 110 ? 30 : 3000),
    });
    const profile = computeSpeedProfile(route, TEST_CAR, true, 'dry');
    for (let i = 0; i < route.points.length; i++) {
      const vCorner = Math.sqrt(TEST_CAR.muLat * 9.81 * route.points[i]!.radius * TEST_CAR.lineQuality);
      const uncapped = Math.min(vCorner * TEST_CAR.aggression, TEST_CAR.vMax);
      const vLimit = Math.min(uncapped, 36); // global cap enabled
      expect(profile[i]!).toBeLessThanOrEqual(vLimit + 1e-6);
    }
  });

  it('respects backward-pass reachability: profile[i] never exceeds what braking from profile[i+1] allows', () => {
    const route = makeTestRoute({
      n: 200,
      radiusAt: (i) => (i > 90 && i < 110 ? 30 : 3000),
    });
    const profile = computeSpeedProfile(route, TEST_CAR, true, 'dry');
    const G = 9.81;
    for (let i = 0; i < route.points.length - 1; i++) {
      const grade = route.points[i]!.grade;
      const aBrake = Math.max(0.5, TEST_CAR.muLong * G * Math.cos(grade) * BRAKE_SAFETY_MARGIN + G * Math.sin(grade));
      const reachable = Math.sqrt(profile[i + 1]! ** 2 + 2 * aBrake * route.spacing);
      expect(profile[i]!).toBeLessThanOrEqual(reachable + 1e-6);
    }
  });

  it('B1: downhill grade approaching a hairpin is more conservative than flat, uphill is less conservative', () => {
    // Long straight (radius 3000) leading into a tight hairpin (radius 30)
    // at index 150. Grade only applies to the approach (indices 100-149).
    const hairpinAt = 150;
    const radiusAt = (i: number) => (i >= hairpinAt && i < hairpinAt + 10 ? 30 : 3000);
    const n = 220;

    const flat = computeSpeedProfile(makeTestRoute({ n, radiusAt, gradeAt: () => 0 }), TEST_CAR, false, 'dry');
    const downhill = computeSpeedProfile(
      makeTestRoute({ n, radiusAt, gradeAt: (i) => (i >= 100 && i < hairpinAt ? -0.12 : 0) }),
      TEST_CAR,
      false,
      'dry',
    );
    const uphill = computeSpeedProfile(
      makeTestRoute({ n, radiusAt, gradeAt: (i) => (i >= 100 && i < hairpinAt ? 0.12 : 0) }),
      TEST_CAR,
      false,
      'dry',
    );

    // Sample a point close enough to the hairpin that the backward pass
    // hasn't yet saturated back to the straight's vLimit ceiling (at this
    // car's braking rate, full recovery to vMax takes ~590 m — pick a point
    // well inside that).
    const sampleIdx = 135;
    expect(downhill[sampleIdx]!).toBeLessThan(flat[sampleIdx]!);
    expect(uphill[sampleIdx]!).toBeGreaterThan(flat[sampleIdx]!);
  });

  it('global cap toggle changes only the ceiling, not braking-feasibility shape', () => {
    const route = makeTestRoute({ n: 100 });
    const capped = computeSpeedProfile(route, TEST_CAR, true, 'dry');
    const uncapped = computeSpeedProfile(route, TEST_CAR, false, 'dry');
    for (let i = 0; i < route.points.length; i++) {
      expect(capped[i]!).toBeLessThanOrEqual(uncapped[i]! + 1e-6);
    }
    // On this car (vMax 275 km/h converted), the cap does bind somewhere.
    expect(Math.max(...capped)).toBeLessThan(Math.max(...uncapped));
  });
});

describe('R7: weather as a grip multiplier', () => {
  it('wet profile is pointwise <= dry, and corner-limited points scale by sqrt(WEATHER_GRIP.wet)', () => {
    // Corner-limited throughout (small, uniform radius) so every point sits
    // well clear of both vMax and the backward-pass reachability ceiling —
    // isolates the sqrt(gripMultiplier) scaling this test checks.
    const route = makeTestRoute({ n: 50, radiusAt: () => 60 });
    const dry = computeSpeedProfile(route, TEST_CAR, false, 'dry');
    const wet = computeSpeedProfile(route, TEST_CAR, false, 'wet');
    const scale = Math.sqrt(WEATHER_GRIP.wet);
    for (let i = 0; i < route.points.length; i++) {
      expect(wet[i]!).toBeLessThanOrEqual(dry[i]! + 1e-6);
      expect(wet[i]!).toBeCloseTo(dry[i]! * scale, 3);
    }
  });

  it('wet braking distance to a hairpin is longer than dry, at the same arrival speed', () => {
    const hairpinIdx = 100;
    const route = makeTestRoute({ n: 150, radiusAt: (i) => (i >= hairpinIdx ? 30 : 3000) });
    const spec = { ...TEST_CAR, errorSigma: 0 };

    function brakingDistance(weather: 'dry' | 'wet'): number {
      const profile = computeSpeedProfile(route, spec, false, weather);
      const targetS = route.points[hairpinIdx]!.s;
      let s = 0;
      let v = profile[0]!;
      let brakeStartS: number | null = null;
      const dt = 1 / 60;
      while (s < targetS) {
        const { throttle, brake } = driverControl(profile, route, s, v, spec, 1, weather);
        if (brake > 0 && brakeStartS === null) brakeStartS = s;
        const { a } = computeAcceleration({ spec, v, grade: 0, throttle, brake });
        v = Math.max(0, v + a * dt);
        s += v * dt;
      }
      return targetS - (brakeStartS ?? targetS);
    }

    expect(brakingDistance('wet')).toBeGreaterThan(brakingDistance('dry'));
  });

  it('caches dry and wet profiles independently for the same route+car', () => {
    const route = makeTestRoute({ n: 50, radiusAt: () => 60 });
    const dry = computeSpeedProfile(route, TEST_CAR, false, 'dry');
    const wet = computeSpeedProfile(route, TEST_CAR, false, 'wet');
    // Re-fetching returns the exact same cached arrays, not freshly rebuilt
    // (nor did building wet evict dry's cache entry).
    expect(computeSpeedProfile(route, TEST_CAR, false, 'dry')).toBe(dry);
    expect(computeSpeedProfile(route, TEST_CAR, false, 'wet')).toBe(wet);
    expect(dry).not.toBe(wet);
  });
});

describe('R8: road surface grip', () => {
  it('a gravel-tagged corner gives a lower profile than the same corner on asphalt (untagged)', () => {
    const asphaltRoute = makeTestRoute({ n: 50, radiusAt: () => 60 });
    const gravelRoute = makeTestRoute({ n: 50, radiusAt: () => 60, surfaceAt: () => 0.7 });
    const asphalt = computeSpeedProfile(asphaltRoute, TEST_CAR, false, 'dry');
    const gravel = computeSpeedProfile(gravelRoute, TEST_CAR, false, 'dry');
    for (let i = 0; i < asphaltRoute.points.length; i++) {
      expect(gravel[i]!).toBeLessThan(asphalt[i]!);
    }
  });

  it('legacy routes (no surface field at all) produce an identical profile to an explicit surface: 1.0', () => {
    const legacyRoute = makeTestRoute({ n: 50, radiusAt: () => 60 });
    const explicitRoute = makeTestRoute({ n: 50, radiusAt: () => 60, surfaceAt: () => 1.0 });
    const legacy = computeSpeedProfile(legacyRoute, TEST_CAR, false, 'dry');
    const explicit = computeSpeedProfile(explicitRoute, TEST_CAR, false, 'dry');
    for (let i = 0; i < legacyRoute.points.length; i++) {
      expect(legacy[i]!).toBeCloseTo(explicit[i]!, 5);
    }
  });
});

describe('R10: per-way speed limits', () => {
  it('a tagged 15 m/s zone caps the profile there, below what the corner/vMax alone would allow', () => {
    const uncappedRoute = makeTestRoute({ n: 50 }); // wide-open straight, radius 3000 default
    const zoneRoute = makeTestRoute({ n: 50, limitAt: (i) => (i >= 20 && i < 30 ? 15 : undefined) });
    const uncapped = computeSpeedProfile(uncappedRoute, TEST_CAR, true, 'dry');
    const zoned = computeSpeedProfile(zoneRoute, TEST_CAR, true, 'dry');
    // Well inside the zone, away from the backward-pass transition at its edges.
    expect(zoned[25]!).toBeLessThan(uncapped[25]!);
    expect(zoned[25]!).toBeLessThanOrEqual(15 * TEST_CAR.aggression + 1e-6);
  });

  it('an untagged fixture is identical to today\'s flat-GLOBAL_CAP output', () => {
    const route = makeTestRoute({ n: 50 });
    const withLimitField = makeTestRoute({ n: 50, limitAt: () => undefined });
    const a = computeSpeedProfile(route, TEST_CAR, true, 'dry');
    const b = computeSpeedProfile(withLimitField, TEST_CAR, true, 'dry');
    for (let i = 0; i < route.points.length; i++) {
      expect(a[i]!).toBeCloseTo(b[i]!, 6);
    }
  });

  it('globalCapEnabled=false ignores a tagged limit entirely (real top speed on open road)', () => {
    const route = makeTestRoute({ n: 50, limitAt: () => 10 });
    const profile = computeSpeedProfile(route, TEST_CAR, false, 'dry');
    // Straight, wide-open radius: uncapped speed should sit near vMax, far
    // above the tagged 10 m/s limit, since the toggle is off.
    expect(profile[25]!).toBeGreaterThan(20);
  });
});

describe('driverControl', () => {
  it('throttles up when far below target, brakes when far above, maintains near target', () => {
    const route = makeTestRoute({ n: 100 });
    const profile = new Float32Array(100).fill(30);

    const accelerating = driverControl(profile, route, 0, 10, TEST_CAR, 1, 'dry');
    expect(accelerating.throttle).toBeGreaterThan(0);
    expect(accelerating.brake).toBe(0);

    const braking = driverControl(profile, route, 0, 40, TEST_CAR, 1, 'dry');
    expect(braking.brake).toBeGreaterThan(0);
    expect(braking.throttle).toBe(0);

    // driverControl perturbs the target by errorSigma*valueNoise(s/4000, seed)
    // — replicate that here so v lands exactly on the noisy target rather
    // than assuming the noise is zero.
    const err = 1 + TEST_CAR.errorSigma * valueNoise(0, 1);
    const maintaining = driverControl(profile, route, 0, 30 * err, TEST_CAR, 1, 'dry');
    expect(maintaining.brake).toBe(0);
    expect(maintaining.throttle).toBeCloseTo(0.3, 10);
  });

  it('is deterministic for a fixed (s, v, seed)', () => {
    const route = makeTestRoute({ n: 100 });
    const profile = new Float32Array(100).fill(30);
    const a = driverControl(profile, route, 500, 25, TEST_CAR, 42, 'dry');
    const b = driverControl(profile, route, 500, 25, TEST_CAR, 42, 'dry');
    expect(a).toEqual(b);
  });
});

describe('R3: racing line (lineQuality) effective radius', () => {
  it('gives a higher (or equal) profile on a curvy route for better line quality, equal on a straight', () => {
    const curvyRoute = makeTestRoute({ n: 100, radiusAt: (i) => (i > 40 && i < 60 ? 35 : 3000) });
    const straightRoute = makeTestRoute({ n: 100 });
    const base = { ...TEST_CAR, lineQuality: 1.0 };
    const better = { ...TEST_CAR, lineQuality: 1.1 };

    const curvyBase = computeSpeedProfile(curvyRoute, base, false, 'dry');
    const curvyBetter = computeSpeedProfile(curvyRoute, better, false, 'dry');
    for (let i = 0; i < curvyRoute.points.length; i++) {
      expect(curvyBetter[i]!).toBeGreaterThanOrEqual(curvyBase[i]! - 1e-6);
    }
    // Meaningfully higher right at the tight section, not just non-strictly.
    expect(curvyBetter[50]!).toBeGreaterThan(curvyBase[50]!);

    const straightBase = computeSpeedProfile(straightRoute, base, false, 'dry');
    const straightBetter = computeSpeedProfile(straightRoute, better, false, 'dry');
    for (let i = 0; i < straightRoute.points.length; i++) {
      expect(straightBetter[i]!).toBeCloseTo(straightBase[i]!, 5);
    }
  });
});

describe('R1: lookahead braking', () => {
  it('brakes before crossing the current target, arriving within 5% of the profile speed at a tight corner', () => {
    const hairpinIdx = 100;
    const route = makeTestRoute({ n: 150, radiusAt: (i) => (i >= hairpinIdx ? 30 : 3000) });
    const spec = { ...TEST_CAR, errorSigma: 0 }; // isolate from §7.4 misjudgement noise
    const profile = computeSpeedProfile(route, spec, false, 'dry');
    const targetS = route.points[hairpinIdx]!.s;

    let s = 0;
    let v = profile[0]!;
    let brakedBeforeTarget = false;
    let vAtTarget: number | null = null;
    const dt = 1 / 60;
    while (s < targetS + 25) {
      const { throttle, brake } = driverControl(profile, route, s, v, spec, 1, 'dry');
      if (brake > 0 && s < targetS) brakedBeforeTarget = true;
      const { a } = computeAcceleration({ spec, v, grade: 0, throttle, brake });
      v = Math.max(0, v + a * dt);
      s += v * dt;
      if (vAtTarget === null && s >= targetS) vAtTarget = v;
    }

    expect(brakedBeforeTarget).toBe(true);
    expect(vAtTarget).not.toBeNull();
    expect(vAtTarget!).toBeLessThanOrEqual(profile[hairpinIdx]! * 1.05);
  });

  it('demands no braking ahead of a uniform-target route (no phantom braking)', () => {
    const route = makeTestRoute({ n: 100 });
    const profile = new Float32Array(100).fill(30);
    const spec = { ...TEST_CAR, errorSigma: 0 };
    // At/below the flat target, R1's aReqMax scan should never find a
    // future point demanding a speed drop, so the lookahead branch never
    // engages — brake stays 0 exactly like the plain reactive controller.
    const { brake } = driverControl(profile, route, 0, 30, spec, 1, 'dry');
    expect(brake).toBe(0);
  });

  it('is deterministic for a fixed (s, v, seed)', () => {
    const route = makeTestRoute({ n: 100, radiusAt: (i) => (i > 40 && i < 60 ? 35 : 3000) });
    const profile = new Float32Array(100).fill(30);
    const a = driverControl(profile, route, 500, 25, TEST_CAR, 42, 'dry');
    const b = driverControl(profile, route, 500, 25, TEST_CAR, 42, 'dry');
    expect(a).toEqual(b);
  });
});

describe('R2: friction-circle-aware throttle/brake cap', () => {
  it('caps throttle more aggressively in a tight corner than on a straight, for the same speed error', () => {
    const profile = new Float32Array(50).fill(100); // far above v -> full-throttle reactive branch
    const spec = { ...TEST_CAR, errorSigma: 0 };
    const straightRoute = makeTestRoute({ n: 50, radiusAt: () => 3000 });
    const cornerRoute = makeTestRoute({ n: 50, radiusAt: () => 40 });

    const straight = driverControl(profile, straightRoute, 0, 25, spec, 1, 'dry');
    const corner = driverControl(profile, cornerRoute, 0, 25, spec, 1, 'dry');

    expect(corner.throttle).toBeLessThan(straight.throttle);
  });

  it('shrinks the throttle budget monotonically as lateral utilisation rises, to ~0 at the limit', () => {
    const profile = new Float32Array(50).fill(100);
    const spec = { ...TEST_CAR, errorSigma: 0 };
    const radii = [5000, 200, 100, 50, 34]; // decreasing radius -> rising U at fixed v
    const throttles = radii.map(
      (r) => driverControl(profile, makeTestRoute({ n: 50, radiusAt: () => r }), 0, 30, spec, 1, 'dry').throttle,
    );
    for (let i = 1; i < throttles.length; i++) {
      expect(throttles[i]!).toBeLessThanOrEqual(throttles[i - 1]! + 1e-9);
    }
    expect(throttles[throttles.length - 1]!).toBeCloseTo(0, 5);
  });

  it('retains a brake floor when lateral utilisation is far over the limit (no lockout)', () => {
    // v=30 at radius 34 puts U well over 1 for this car's muLat — the exact
    // trap that pinned a real car at 30 m/s against an 18.85 m/s target
    // before BRAKE_BUDGET_FLOOR was added: a hard sqrt(1-U²) cap collapses
    // to 0 here and brake never recovers because braking is the only thing
    // that reduces v (which is what would bring U back down).
    const route = makeTestRoute({ n: 50, radiusAt: () => 34 });
    const profile = new Float32Array(50).fill(5); // far below v -> full-brake reactive branch
    const spec = { ...TEST_CAR, errorSigma: 0 };
    const { brake } = driverControl(profile, route, 0, 30, spec, 1, 'dry');
    expect(brake).toBeGreaterThan(0);
  });
});

describe('R11: tire-wear driver adaptation', () => {
  it('a worn/damaged car targets a lower speed than a fresh one at the same point (sqrt scaling)', () => {
    const route = makeTestRoute({ n: 50, radiusAt: () => 60 });
    const profile = new Float32Array(50).fill(30);
    const spec = { ...TEST_CAR, errorSigma: 0 };
    // v sits exactly on the fresh car's target (maintain, no braking) —
    // conditionGrip < 1 lowers the worn car's own target below v, so it
    // should read as over target and brake, with nothing else changed.
    const fresh = driverControl(profile, route, 0, 30, spec, 1, 'dry', undefined, 1);
    const worn = driverControl(profile, route, 0, 30, spec, 1, 'dry', undefined, 0.7);
    expect(fresh.brake).toBe(0);
    expect(worn.brake).toBeGreaterThan(0);
  });

  it('conditionGrip defaults to 1 (no adaptation) when omitted', () => {
    const route = makeTestRoute({ n: 50, radiusAt: () => 60 });
    const profile = new Float32Array(50).fill(30);
    const withDefault = driverControl(profile, route, 0, 30, TEST_CAR, 1, 'dry');
    const explicit1 = driverControl(profile, route, 0, 30, TEST_CAR, 1, 'dry', undefined, 1);
    expect(withDefault).toEqual(explicit1);
  });
});

describe('evaluateLossOfControl', () => {
  function makeCar(overrides: Partial<CarState> = {}): CarState {
    return {
      spec: TEST_CAR,
      route: makeTestRoute({ n: 2 }), // unused by evaluateLossOfControl (route is passed separately)
      s: 0,
      v: 0,
      throttle: 0,
      brake: 0,
      status: 'racing',
      recoveryRemaining: 0,
      incidents: [],
      finishTime: null,
      speedProfile: new Float32Array(1),
      rng: mulberry32(1),
      seed: 1,
      tireWear: 0,
      condition: { grip: 1, cdA: 1 },
      ...overrides,
    };
  }

  it('never triggers an incident when comfortably under the friction circle', () => {
    const route = makeTestRoute({ n: 10, radiusAt: () => 3000 });
    const car = makeCar({ v: 10 }); // tiny lateral accel at 3000 m radius
    evaluateLossOfControl(car, route, 0, 0, 1 / 60, 'dry');
    expect(car.incidents.length).toBe(0);
    expect(car.status).toBe('racing');
  });

  it('is a no-op for cars not currently racing', () => {
    const route = makeTestRoute({ n: 10, radiusAt: () => 15 });
    const car = makeCar({ v: 100, status: 'retired' });
    evaluateLossOfControl(car, route, 1000, 0, 1 / 60, 'dry');
    expect(car.incidents.length).toBe(0);
  });

  it('returns the friction-circle utilisation even when comfortably under threshold', () => {
    const route = makeTestRoute({ n: 10, radiusAt: () => 3000 });
    const car = makeCar({ v: 10 });
    const total = evaluateLossOfControl(car, route, 0, 0, 1 / 60, 'dry');
    expect(total).toBeGreaterThan(0);
    expect(total).toBeLessThan(1);
  });
});

describe('R12: persistent incident damage', () => {
  const G = 9.81;
  const RADIUS = 40;

  // Exact speed for a target lateral utilisation at RADIUS, aTire=0 (so
  // total === U exactly) — keeps these tests independent of TEST_CAR's
  // exact muLat rather than relying on approximate hardcoded speeds.
  // `gripMultiplier` must match whatever car.condition.grip the test sets
  // (default fresh/undamaged, 1) — evaluateLossOfControl folds condition
  // into the same denominator, so a pre-damaged car needs the true total
  // computed against ITS grip, not the fresh-car assumption.
  function vForUtilisation(targetU: number, gripMultiplier = 1): number {
    return Math.sqrt(targetU * RADIUS * TEST_CAR.muLat * gripMultiplier * G);
  }

  function makeCarForIncident(overrides: Partial<CarState> = {}): CarState {
    return {
      spec: TEST_CAR,
      route: makeTestRoute({ n: 2 }),
      s: 0,
      v: 0,
      throttle: 0,
      brake: 0,
      status: 'racing',
      recoveryRemaining: 0,
      incidents: [],
      finishTime: null,
      speedProfile: new Float32Array(1),
      rng: () => 0, // forces any above-threshold incident to actually fire
      seed: 1,
      tireWear: 0,
      condition: { grip: 1, cdA: 1 },
      ...overrides,
    };
  }

  it('a slide permanently reduces grip by SLIDE_GRIP_DAMAGE', () => {
    const route = makeTestRoute({ n: 10, radiusAt: () => RADIUS });
    const car = makeCarForIncident({ v: vForUtilisation(1.0) }); // slide range: (0.95, 1.05]
    evaluateLossOfControl(car, route, 0, 0, 1 / 60, 'dry');
    expect(car.incidents[0]?.severity).toBe('slide');
    expect(car.condition.grip).toBeCloseTo(SLIDE_GRIP_DAMAGE, 5);
    expect(car.condition.cdA).toBe(1); // slides don't touch drag, only spins do
  });

  it('a spin permanently reduces grip by SPIN_GRIP_DAMAGE and increases drag by SPIN_CDA_DAMAGE', () => {
    const route = makeTestRoute({ n: 10, radiusAt: () => RADIUS });
    const car = makeCarForIncident({ v: vForUtilisation(1.15) }); // spin range: (1.05, 1.2]
    evaluateLossOfControl(car, route, 0, 0, 1 / 60, 'dry');
    expect(car.incidents[0]?.severity).toBe('spin');
    expect(car.condition.grip).toBeCloseTo(SPIN_GRIP_DAMAGE, 5);
    expect(car.condition.cdA).toBeCloseTo(SPIN_CDA_DAMAGE, 5);
  });

  it('stacks multiplicatively across incidents rather than resetting each time', () => {
    const route = makeTestRoute({ n: 10, radiusAt: () => RADIUS });
    const v = vForUtilisation(1.0); // slide range — leaves status 'racing' so it can recur
    const car = makeCarForIncident({ v });
    evaluateLossOfControl(car, route, 0, 0, 1 / 60, 'dry');
    expect(car.condition.grip).toBeCloseTo(SLIDE_GRIP_DAMAGE, 5);

    car.v = v; // triggerIncident's slide effect (v *= 0.6) would change U — reset for a clean second hit
    evaluateLossOfControl(car, route, 0, 0, 1 / 60, 'dry');
    expect(car.condition.grip).toBeCloseTo(SLIDE_GRIP_DAMAGE * SLIDE_GRIP_DAMAGE, 5);
  });

  it('floors grip at CONDITION_GRIP_FLOOR rather than degrading indefinitely', () => {
    const route = makeTestRoute({ n: 10, radiusAt: () => RADIUS });
    const car = makeCarForIncident({ v: vForUtilisation(1.15, 0.905), condition: { grip: 0.905, cdA: 1 } });
    evaluateLossOfControl(car, route, 0, 0, 1 / 60, 'dry');
    expect(car.condition.grip).toBe(CONDITION_GRIP_FLOOR);
  });
});
