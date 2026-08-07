import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { buildCarSpecs } from './cars';
import { computeAcceleration } from './physics';
import { G } from './tuning';
import type { CarSpec } from './types';

/**
 * Data-integrity checks on the *shipped* roster, not on fixtures.
 *
 * Everything here caught a real error when it was written. The roster is
 * hand-authored from manufacturer figures, and the failure mode is not a typo
 * that blows up — it is a plausible-looking number that quietly contradicts
 * another one, e.g. a top speed the machine cannot reach on its own power and
 * drag. That produces no error and no NaN; it just means a spec sheet in the
 * config panel is lying, and it is invisible until someone works the physics
 * backwards. So the physics is worked backwards here, every run.
 */

const ROSTER: CarSpec[] = buildCarSpecs(JSON.parse(readFileSync('public/data/cars.json', 'utf-8')));
const BIKES = ROSTER.filter((v) => v.type === 'motorcycle');
const CARS = ROSTER.filter((v) => v.type === 'car');

/**
 * How far a quoted top speed may sit above what the force model reaches, in
 * km/h, before it counts as contradicting the rest of the entry.
 *
 * cdA is an estimate — nobody publishes drag areas for road vehicles — and a
 * ±5% error there moves terminal velocity by ~2%, which is 5-6 km/h at these
 * speeds. A tighter bound would be asserting precision the input doesn't have.
 */
const TOP_SPEED_TOLERANCE_KMH = 8;

/** Highest speed at which full throttle still produces positive acceleration —
 * the top speed this vehicle's own power, drag and rolling resistance allow. */
function dragLimitedTopSpeedKmh(spec: CarSpec): number {
  let lo = 5;
  let hi = 200;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (computeAcceleration({ spec, v: mid, grade: 0, throttle: 1, brake: 0 }).a > 0) lo = mid;
    else hi = mid;
  }
  return lo * 3.6;
}

/**
 * Cars whose quoted top speed the force model cannot reproduce.
 *
 * All seven are famous manufacturer claims from an era of optimistic
 * marketing, or figures set on a banked bowl with a modified car. They are
 * listed rather than quietly tolerated: a *new* entry must not join them
 * without someone deciding it should. (`vMax` is only ever a `min()` ceiling
 * in the sim, so an unreachable one is harmless — it is simply never the
 * binding constraint. It is still wrong data.)
 */
const CLAIMED_TOP_SPEED_ALLOWLIST = new Set([
  'diablosv',
  'countach',
  'mclarenf1',
  'veyron',
  'veyronss',
  'eb110',
  'cc8s',
]);

describe('shipped roster: top speeds are physically reachable', () => {
  it('every motorcycle can actually reach its quoted top speed', () => {
    // Motorcycles have no allowlist on purpose: the whole roster was audited
    // against measured figures rather than brochure claims, and 14 of 50
    // quoted speeds were corrected as a result (a Honda CB1000R measures
    // 230 km/h, not the 250 first entered; the Ninja H2R's real figure is
    // Kawasaki's 380, not the unverified 400 km/h speedometer run).
    const unreachable = BIKES.filter((b) => dragLimitedTopSpeedKmh(b) < b.vMax * 3.6 - TOP_SPEED_TOLERANCE_KMH).map(
      (b) => `${b.name}: quoted ${Math.round(b.vMax * 3.6)}, drag caps at ${Math.round(dragLimitedTopSpeedKmh(b))}`,
    );
    expect(unreachable).toEqual([]);
  });

  it('no new car joins the claimed-top-speed allowlist', () => {
    const unreachable = CARS.filter(
      (c) => !CLAIMED_TOP_SPEED_ALLOWLIST.has(c.id) && dragLimitedTopSpeedKmh(c) < c.vMax * 3.6 - TOP_SPEED_TOLERANCE_KMH,
    ).map((c) => c.name);
    expect(unreachable).toEqual([]);
  });
});

describe('shipped roster: motorcycle physics parameters', () => {
  it('muLat implies a lean angle the machine could physically reach', () => {
    // On two wheels the cornering coefficient IS tan(lean angle) — a bike
    // leans until gravity and centripetal force resolve through the contact
    // patch. So every muLat is a claim about lean angle, checkable against
    // what touches down first.
    for (const bike of BIKES) {
      const lean = (Math.atan(bike.muLat) * 180) / Math.PI;
      expect(lean, `${bike.name} leans ${lean.toFixed(1)}°`).toBeGreaterThan(28); // cruiser floorboards
      expect(lean, `${bike.name} leans ${lean.toFixed(1)}°`).toBeLessThan(55); // MotoGP territory
    }
  });

  it('keeps the pitch-over ceiling inside the range real geometry allows', () => {
    for (const bike of BIKES) {
      // Below ~0.9 g nothing would accelerate; above ~1.5 g the bike is long
      // and low enough that tyre grip binds first anyway.
      expect(bike.pitchLimitG, bike.name).toBeGreaterThanOrEqual(0.9);
      expect(bike.pitchLimitG, bike.name).toBeLessThanOrEqual(1.5);
    }
  });

  it('gives cars no pitch limit at all', () => {
    for (const car of CARS) expect(car.pitchLimitG, car.name).toBe(Infinity);
  });

  it('marks only the supercharged and electric machines as forced induction', () => {
    const forced = BIKES.filter((b) => b.induction === 'forced').map((b) => b.id).sort();
    // The three supercharged Kawasakis and the two electrics. Everything else
    // on the motorcycle roster is naturally aspirated, and R9's altitude
    // derate must apply to it.
    expect(forced).toEqual(['energicaego', 'ninjah2', 'ninjah2r', 'zerosrs', 'zh2']);
  });

  it('carries the rider in every motorcycle mass', () => {
    // The lightest thing here is a 140 kg track bike; with a rider aboard
    // nothing can be under 200 kg. A bike entered at its dry weight would
    // sail through every other check while being 30% too quick.
    for (const bike of BIKES) expect(bike.mass, bike.name).toBeGreaterThan(200);
  });
});

describe('shipped roster: identity', () => {
  it('gives every vehicle a distinct colour', () => {
    // Two cars sharing a colour is indistinguishable on the map and in the
    // leaderboard, and a 247-vehicle roster makes collisions easy to author.
    const byColour = new Map<string, string[]>();
    for (const v of ROSTER) byColour.set(v.colour, [...(byColour.get(v.colour) ?? []), v.name]);
    expect([...byColour.values()].filter((names) => names.length > 1)).toEqual([]);
  });

  it('states a make for every vehicle', () => {
    for (const v of ROSTER) expect(v.make.length, v.name).toBeGreaterThan(0);
  });

  it('documents where each vehicle came from', () => {
    // `notes` is where the estimated-vs-published distinction lives; an entry
    // without one is a spec nobody can check.
    const raw = JSON.parse(readFileSync('public/data/cars.json', 'utf-8')) as Array<{ id: string; notes?: string }>;
    const undocumented = raw.filter((r) => !r.notes || r.notes.length < 40).map((r) => r.id);
    expect(undocumented).toEqual([]);
  });
});

describe('shipped roster: acceleration', () => {
  it('is quicker on a superbike than on the supercars it races', () => {
    // The headline claim of M1, asserted rather than assumed. Power-to-weight
    // at the wheel, since the pitch ceiling is what stops a bike converting
    // all of it.
    const pw = (v: CarSpec) => v.power / v.mass;
    const superbike = BIKES.find((b) => b.id === 'panigalev4r')!;
    const supercar = CARS.find((c) => c.id === '911turbos')!;
    expect(pw(superbike)).toBeGreaterThan(pw(supercar) * 1.3);
  });

  it('still caps that advantage at the pitch-over limit', () => {
    const superbike = BIKES.find((b) => b.id === 'panigalev4r')!;
    const { aTire } = computeAcceleration({ spec: superbike, v: 5, grade: 0, throttle: 1, brake: 0 });
    expect(aTire).toBeCloseTo(superbike.pitchLimitG * G, 6);
  });

  it('makes the pitch ceiling the binding constraint on sport-tyred bikes, not tyre grip', () => {
    // This is the invariant the whole feature rests on, and it was violated on
    // first authoring: muLong was set to 1.05 against a 1.10 g pitch limit, so
    // grip bound first and `pitchLimitG` did nothing at all on exactly the
    // machines it exists for. Modern sport rubber is good for ~1.25 g; the bike
    // lifts a wheel at ~1.1 g. Long/low machines (Hayabusa, ZX-14R) and those
    // on cruiser or dual-purpose tyres are traction-limited instead, which is
    // correct — hence the check is on a named set rather than all bikes.
    const mustPitchLimit = ['panigalev4r', 'fireblade', 'm1000rr', 'rsv4factory', 'zx10r', 'yzfr6', 'superduker', 'rc8c'];
    for (const id of mustPitchLimit) {
      const bike = BIKES.find((b) => b.id === id)!;
      expect(bike.muLong, `${bike.name} tyre grip must exceed its pitch ceiling`).toBeGreaterThan(bike.pitchLimitG);
    }
  });

  it('leaves long, low and soft-tyred machines traction-limited', () => {
    for (const id of ['hayabusa', 'zx14r', 'goldwing', 'r18', 'rocket3r', 'africatwin']) {
      const bike = BIKES.find((b) => b.id === id)!;
      expect(bike.muLong, `${bike.name} should be grip-limited`).toBeLessThan(bike.pitchLimitG);
    }
  });
});
