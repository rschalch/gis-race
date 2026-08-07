import type { CarSpec } from './types';

/**
 * Roster classification — which cars can plausibly race each other.
 *
 * None of this is simulation input: nothing in sim.ts/driver.ts/physics.ts
 * reads a pace index or a tier. It exists because the roster now spans a Fiat
 * Mobi and a Bugatti Bolide, and a grid drawn at random from that range isn't
 * a race — the field is strung out from the first corner. The config panel
 * uses it to offer fields that are actually competitive.
 */

/** Hard cap on grid size. Above ~20 the leaderboard stops being readable and
 * a start interval stretches the race clock out for no benefit. */
export const MAX_FIELD_SIZE = 20;

/**
 * A single "how fast is this car, roughly" number, in W/kg-equivalent.
 *
 * Over a real road route finish time is set by three things: power-to-weight
 * (out of corners and up grades), top speed (open sections), and lateral grip
 * (corner speed). This blends them into one scalar, anchored so that a car
 * with 100 W/kg at the wheels, a 200 km/h top speed and µ=0.9 scores 100:
 *
 *   index = (power / mass) × √(vMax / 55.6) × (muLat / 0.9)
 *
 * The square root on top speed is deliberate — doubling a car's terminal
 * velocity does not halve its lap time on a road with corners, whereas
 * power-to-weight scales roughly linearly with the pace it can carry.
 */
export function paceIndex(spec: CarSpec): number {
  const powerToWeight = spec.power / spec.mass;
  return powerToWeight * Math.sqrt(spec.vMax / 55.6) * (spec.muLat / 0.9);
}

export type PerformanceTierId = 'economy' | 'everyday' | 'sport' | 'performance' | 'super' | 'hyper';

export interface PerformanceTier {
  id: PerformanceTierId;
  label: string;
  /** Inclusive lower bound on paceIndex. The top tier has no upper bound. */
  min: number;
}

/**
 * Tier bands, in ascending order. The bounds are absolute (not percentiles of
 * the current roster) so that adding cars never silently re-labels the ones
 * already there. They were picked off the shipped 197-car roster's index
 * distribution so every band holds 27–39 genuinely comparable cars — enough
 * for a full 20-car grid with room to choose, in every tier.
 */
export const PERFORMANCE_TIERS: readonly PerformanceTier[] = [
  { id: 'economy', label: 'Economy', min: 0 },
  { id: 'everyday', label: 'Everyday', min: 70 },
  { id: 'sport', label: 'Sport', min: 120 },
  { id: 'performance', label: 'Performance', min: 190 },
  { id: 'super', label: 'Supercar', min: 300 },
  { id: 'hyper', label: 'Hypercar', min: 500 },
];

export function tierOf(spec: CarSpec): PerformanceTier {
  let tier = PERFORMANCE_TIERS[0]!;
  const index = paceIndex(spec);
  for (const candidate of PERFORMANCE_TIERS) {
    if (index >= candidate.min) tier = candidate;
  }
  return tier;
}

/** Makes, in roster order, each with its cars in roster order. */
export function groupByMake(cars: CarSpec[]): Map<string, CarSpec[]> {
  const groups = new Map<string, CarSpec[]>();
  for (const car of cars) {
    const existing = groups.get(car.make);
    if (existing) existing.push(car);
    else groups.set(car.make, [car]);
  }
  return groups;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

/**
 * Picks a grid of up to `max` cars from `candidates` that can actually race
 * each other.
 *
 * Two rules, in order:
 *   1. Closeness — cars nearest the candidate pool's *median* pace come first,
 *      so a pool that happens to include one outlier hypercar drops it rather
 *      than building the whole field around it.
 *   2. Make diversity — among cars of comparable pace, take one per make
 *      before taking a second from any make, so "everything" doesn't yield
 *      twenty Ferraris.
 *
 * Deterministic: same input, same grid. Anchoring on a specific car (as the
 * per-row "cars like this one" action does) is just this function over a pool
 * pre-filtered to that car's neighbourhood.
 */
export function buildFairField(candidates: CarSpec[], max: number = MAX_FIELD_SIZE): CarSpec[] {
  if (candidates.length <= max) return sortByPace(candidates);

  const indices = new Map(candidates.map((c) => [c.id, paceIndex(c)]));
  const centre = median([...indices.values()]);

  // Closest to the pool's centre of pace first; id breaks ties so the result
  // never depends on input ordering.
  const ranked = [...candidates].sort((a, b) => {
    const d = Math.abs(indices.get(a.id)! - centre) - Math.abs(indices.get(b.id)! - centre);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });

  const byMake = new Map<string, CarSpec[]>();
  for (const car of ranked) {
    const bucket = byMake.get(car.make);
    if (bucket) bucket.push(car);
    else byMake.set(car.make, [car]);
  }

  // Round-robin over makes, in order of each make's closest car.
  const picked: CarSpec[] = [];
  const buckets = [...byMake.values()];
  let round = 0;
  while (picked.length < max) {
    let tookAny = false;
    for (const bucket of buckets) {
      const car = bucket[round];
      if (!car) continue;
      picked.push(car);
      tookAny = true;
      if (picked.length === max) break;
    }
    if (!tookAny) break; // every bucket exhausted
    round += 1;
  }

  return sortByPace(picked);
}

/** Fastest first — the order a grid is most naturally read in. */
export function sortByPace(cars: CarSpec[]): CarSpec[] {
  return [...cars].sort((a, b) => {
    const d = paceIndex(b) - paceIndex(a);
    return d !== 0 ? d : a.id.localeCompare(b.id);
  });
}

/**
 * The cars closest in pace to `anchor`, including it — the "who could actually
 * race this car" query behind the per-row action in the config panel.
 */
export function fieldLike(anchor: CarSpec, cars: CarSpec[], max: number = MAX_FIELD_SIZE): CarSpec[] {
  const anchorIndex = paceIndex(anchor);
  const neighbours = [...cars]
    .sort((a, b) => {
      const d = Math.abs(paceIndex(a) - anchorIndex) - Math.abs(paceIndex(b) - anchorIndex);
      return d !== 0 ? d : a.id.localeCompare(b.id);
    })
    .slice(0, max);
  return sortByPace(neighbours);
}
