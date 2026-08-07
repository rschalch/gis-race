import type { CarSpec, VehicleType } from './types';
import { MOTORCYCLE_PITCH_LIMIT_G } from './tuning';

// F2: the roster lives in public/data/cars.json (raw, real-world units —
// crank power in W, top speed in km/h) rather than committed here as code,
// so adding a car needs no rebuild. Two things can't be "real stats" no
// matter the source (documented per-car in the JSON's `notes` field):
//   - crr, muLong, muLat: rolling resistance and grip are tire/road/condition
//     properties, not published vehicle specs — estimated from tire class
//     and vehicle dynamics (sport/performance vs. standard vs. truck tyres).
//   - aggression, limitTolerance, errorSigma: driver-behaviour parameters
//     (§7.3–7.4), not a property of the car at all — set per how a car in that
//     category is typically actually driven, not sourced from anywhere.
//
// power is at the wheels (§9's convention): crank power × 0.85 drivetrain
// loss, applied uniformly for consistency even though EVs lose less.

export const CRANK_TO_WHEEL = 0.85;
const KMH_TO_MS = 1 / 3.6;

interface RawCarSpec {
  id: string;
  name: string;
  /** M1: defaults to 'car' when omitted, so every pre-motorcycle entry in the
   * JSON keeps its exact meaning. */
  type?: VehicleType;
  /** M1: pitch-over ceiling in g. Motorcycles fall back to
   * MOTORCYCLE_PITCH_LIMIT_G; cars ignore it entirely (Infinity). */
  pitchLimitG?: number;
  make?: string; // manufacturer; defaults to the first word of `name` when omitted
  colour?: string; // optional (F2) — auto-assigned from a palette when omitted
  mass: number;
  crankPowerW: number;
  cdA: number;
  crr: number;
  muLong: number;
  muLat: number;
  vMaxKmh: number;
  aggression: number;
  errorSigma: number;
  lineQuality?: number; // R3: 1.00–1.15, defaults to 1.05 when omitted
  limitTolerance?: number; // R10: 0.95–1.10, defaults to 1.00 (obeys the signs)
                           // when omitted. Split out of `aggression` — see the
                           // note on CarSpec.limitTolerance in types.ts.
  induction?: 'na' | 'forced'; // R9: defaults to 'forced' (no altitude derate) when omitted
  peakPowerSpeed?: number; // R14: m/s, defaults to 5 (pre-R14 behaviour) when omitted
  notes?: string;
}

const LINE_QUALITY_DEFAULT = 1.05;
const LINE_QUALITY_MIN = 1.0;
const LINE_QUALITY_MAX = 1.15;
// Default 1.00 = drives exactly to the posted limit. The band is deliberately
// narrower than aggression's: on a mostly limit-tagged route this multiplier
// applies to nearly every point in the profile, so a wide spread here drowns
// out every actual car stat (which is precisely the bug that split it out of
// `aggression` — see types.ts).
const LIMIT_TOLERANCE_DEFAULT = 1.0;
const LIMIT_TOLERANCE_MIN = 0.95;
const LIMIT_TOLERANCE_MAX = 1.1;
const INDUCTION_DEFAULT = 'forced';
const PEAK_POWER_SPEED_DEFAULT = 5;

const REQUIRED_NUMERIC_FIELDS = [
  'mass',
  'crankPowerW',
  'cdA',
  'crr',
  'muLong',
  'muLat',
  'vMaxKmh',
  'aggression',
  'errorSigma',
] as const;

export class CarValidationError extends Error {}

/** A stale or hand-edited cars.json would otherwise produce NaNs deep in the
 * sim instead of a clear error (F2, same rationale as route.ts's
 * assertRoute — R7). */
function assertCars(value: unknown): asserts value is RawCarSpec[] {
  const fail = (msg: string): never => {
    throw new CarValidationError(`cars.json failed validation: ${msg}`);
  };

  if (!Array.isArray(value) || value.length === 0) fail('must be a non-empty array');
  const list = value as unknown[];
  const seenIds = new Set<string>();
  for (const [i, entry] of list.entries()) {
    if (typeof entry !== 'object' || entry === null) fail(`entry ${i} is not an object`);
    const car = entry as Record<string, unknown>;
    if (typeof car.id !== 'string' || car.id.length === 0) fail(`entry ${i} is missing a string id`);
    if (seenIds.has(car.id as string)) fail(`duplicate car id "${car.id}"`);
    seenIds.add(car.id as string);
    if (typeof car.name !== 'string' || car.name.length === 0) fail(`car "${car.id}" is missing a name`);
    if (car.make !== undefined && (typeof car.make !== 'string' || car.make.length === 0)) {
      fail(`car "${car.id}" has an empty make`);
    }
    for (const field of REQUIRED_NUMERIC_FIELDS) {
      if (!Number.isFinite(car[field])) fail(`car "${car.id}" has a non-finite ${field}`);
    }
    if (car.lineQuality !== undefined) {
      if (typeof car.lineQuality !== 'number' || car.lineQuality < LINE_QUALITY_MIN || car.lineQuality > LINE_QUALITY_MAX) {
        fail(`car "${car.id}" has lineQuality outside [${LINE_QUALITY_MIN}, ${LINE_QUALITY_MAX}]`);
      }
    }
    if (car.limitTolerance !== undefined) {
      if (
        typeof car.limitTolerance !== 'number' ||
        car.limitTolerance < LIMIT_TOLERANCE_MIN ||
        car.limitTolerance > LIMIT_TOLERANCE_MAX
      ) {
        fail(`car "${car.id}" has limitTolerance outside [${LIMIT_TOLERANCE_MIN}, ${LIMIT_TOLERANCE_MAX}]`);
      }
    }
    if (car.induction !== undefined && car.induction !== 'na' && car.induction !== 'forced') {
      fail(`car "${car.id}" has induction outside 'na'/'forced'`);
    }
    if (car.type !== undefined && car.type !== 'car' && car.type !== 'motorcycle') {
      fail(`car "${car.id}" has type outside 'car'/'motorcycle'`);
    }
    if (car.pitchLimitG !== undefined) {
      if (typeof car.pitchLimitG !== 'number' || !(car.pitchLimitG > 0)) {
        fail(`car "${car.id}" has a non-positive pitchLimitG`);
      }
      if (car.type !== 'motorcycle') {
        // Not merely unused — silently ignored. A car entry carrying one is
        // someone expecting it to do something, so say so rather than eat it.
        fail(`car "${car.id}" sets pitchLimitG but is not a motorcycle`);
      }
    }
    if (car.peakPowerSpeed !== undefined && (typeof car.peakPowerSpeed !== 'number' || car.peakPowerSpeed <= 0)) {
      fail(`car "${car.id}" has a non-positive peakPowerSpeed`);
    }
  }
}

// Assigned to any car whose JSON entry omits `colour` (F2) — cycling
// through a fixed palette keeps a growing roster from colliding by default;
// authors can still pin an exact colour per car in the data file.
const COLOUR_PALETTE = [
  '#f97316',
  '#ef4444',
  '#3b82f6',
  '#eab308',
  '#10b981',
  '#8b5cf6',
  '#06b6d4',
  '#ec4899',
  '#84cc16',
  '#f43f5e',
  '#0ea5e9',
  '#a855f7',
];

function colourFor(index: number, provided: string | undefined): string {
  return provided ?? COLOUR_PALETTE[index % COLOUR_PALETTE.length]!;
}

/** Validates and converts the raw JSON shape into runtime CarSpecs — split
 * out from loadCars so it's testable without mocking fetch. */
export function buildCarSpecs(raw: unknown): CarSpec[] {
  assertCars(raw);
  return raw.map((car, i) => ({
    id: car.id,
    name: car.name,
    type: car.type ?? 'car',
    // Cars have no pitch-over mode, and Infinity makes the cap in physics.ts
    // an exact no-op for them rather than an "effectively large" number.
    pitchLimitG:
      (car.type ?? 'car') === 'motorcycle' ? (car.pitchLimitG ?? MOTORCYCLE_PITCH_LIMIT_G) : Infinity,
    make: car.make ?? car.name.split(' ')[0]!,
    colour: colourFor(i, car.colour),
    mass: car.mass,
    power: car.crankPowerW * CRANK_TO_WHEEL,
    cdA: car.cdA,
    crr: car.crr,
    muLong: car.muLong,
    muLat: car.muLat,
    vMax: car.vMaxKmh * KMH_TO_MS,
    aggression: car.aggression,
    errorSigma: car.errorSigma,
    lineQuality: car.lineQuality ?? LINE_QUALITY_DEFAULT,
    limitTolerance: car.limitTolerance ?? LIMIT_TOLERANCE_DEFAULT,
    induction: car.induction ?? INDUCTION_DEFAULT,
    peakPowerSpeed: car.peakPowerSpeed ?? PEAK_POWER_SPEED_DEFAULT,
  }));
}

export async function loadCars(): Promise<CarSpec[]> {
  const res = await fetch('/data/cars.json');
  if (!res.ok) throw new Error(`Failed to load cars: ${res.status} ${res.statusText}`);
  const raw: unknown = await res.json();
  return buildCarSpecs(raw);
}
