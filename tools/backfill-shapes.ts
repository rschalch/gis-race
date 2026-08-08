// One-shot migration: add the render-only `Route.shape` (full-resolution road
// geometry) to routes baked before that field existed.
//
// Why this exists at all: `shape` fixes a *drawing* defect — §5.3's 25 m
// resampling chords any turn tighter than that, so the map visibly cuts
// corners at junctions. New bakes get the field for free, but re-baking the
// existing routes to obtain it would be wrong twice over: it re-runs the
// elevation and Overpass fetches (slow, rate-limited, and dependent on
// upstream data that has moved on since), and any drift in those inputs
// changes what a given race seed produces. This tool re-fetches ONLY the
// routing geometry and injects `shape`; every simulation-relevant field is
// passed through byte-for-byte, so determinism is preserved and
// ENGINE_VERSION does not move.
//
// Run: npm run backfill-shapes [-- --dry-run]

import { readFile, writeFile } from 'node:fs/promises';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import type { Route } from '../src/types';
import {
  fetchRouteGeometries,
  makeProjection,
  simplifyIndices,
  SHAPE_SIMPLIFY_TOLERANCE_M,
  type GeometryCandidate,
} from './bakeRoute';

const ROUTE_DIRS = ['public/data/routes', 'data/routes'];

/**
 * How far a re-fetched candidate may sit from the baked polyline and still be
 * accepted as "the same road".
 *
 * The discrimination here is not subtle: the corner-cutting this whole change
 * addresses is a few metres, while a routing engine that has since decided on
 * a different road diverges by hundreds. 25 m sits in the empty space between
 * those, so a wrong match is rejected rather than silently drawn.
 */
const ACCEPT_MAX_DEVIATION_M = 25;

/** Baked points checked against each candidate. Every ~40th is plenty to
 * catch a divergent route, and keeps this brute-force O(samples × segments)
 * comparison to a few million operations instead of a few billion. */
const DEVIATION_SAMPLE_STRIDE = 40;

interface XY {
  x: number;
  y: number;
}

function pointToSegmentDistance(p: XY, a: XY, b: XY): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const segLen2 = dx * dx + dy * dy;
  if (segLen2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / segLen2));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Worst distance from any sampled baked point to the candidate polyline. */
function maxDeviation(baked: XY[], candidate: XY[]): number {
  let worst = 0;
  for (let i = 0; i < baked.length; i += DEVIATION_SAMPLE_STRIDE) {
    const p = baked[i]!;
    let best = Infinity;
    for (let j = 0; j < candidate.length - 1; j++) {
      const d = pointToSegmentDistance(p, candidate[j]!, candidate[j + 1]!);
      if (d < best) best = d;
      if (best === 0) break;
    }
    if (best > worst) worst = best;
  }
  return worst;
}

function round(value: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(value * f) / f;
}

async function backfillFile(filePath: string, dryRun: boolean): Promise<'skipped' | 'updated' | 'failed'> {
  const raw = await readFile(filePath, 'utf8');
  const route = JSON.parse(raw) as Route;
  const name = path.basename(filePath);

  if (!Array.isArray(route.points) || route.points.length < 2) {
    console.log(`  ${name}: not a route file, skipping`);
    return 'skipped';
  }
  if (route.shape) {
    console.log(`  ${name}: already has shape (${route.shape.length} vertices), skipping`);
    return 'skipped';
  }

  const first = route.points[0]!;
  const last = route.points[route.points.length - 1]!;
  const proj = makeProjection(route.origin.lon, route.origin.lat);
  const bakedXY = route.points.map((p) => proj.project(p.lon, p.lat));

  // Ask for alternates: 8 of the existing routes are `-alt2`/`-alt3` variants,
  // and the primary result would not be the road they were baked from.
  let candidates: GeometryCandidate[];
  try {
    candidates = await fetchRouteGeometries([[first.lon, first.lat], [last.lon, last.lat]], true);
  } catch (err) {
    console.log(`  ${name}: geometry fetch failed (${(err as Error).message}), skipping`);
    return 'failed';
  }

  let best: { candidate: GeometryCandidate; deviation: number } | undefined;
  for (const candidate of candidates) {
    const candidateXY = candidate.coords.map(([lon, lat]) => proj.project(lon, lat));
    const deviation = maxDeviation(bakedXY, candidateXY);
    if (!best || deviation < best.deviation) best = { candidate, deviation };
  }

  if (!best || best.deviation > ACCEPT_MAX_DEVIATION_M) {
    console.log(
      `  ${name}: no candidate matches the baked polyline ` +
        `(best deviation ${best ? best.deviation.toFixed(0) : '?'} m > ${ACCEPT_MAX_DEVIATION_M} m) — ` +
        `the router no longer returns this road. Skipping; it keeps drawing from its 25 m grid.`,
    );
    return 'failed';
  }

  const coords = best.candidate.coords;
  const projected = coords.map(([lon, lat]) => proj.project(lon, lat));
  const kept = simplifyIndices(projected, SHAPE_SIMPLIFY_TOLERANCE_M);
  const shape = kept.map((i) => [round(coords[i]![0], 6), round(coords[i]![1], 6)] as [number, number]);

  console.log(
    `  ${name}: matched (deviation ${best.deviation.toFixed(1)} m), ` +
      `${shape.length} shape vertices from ${coords.length} source, ${route.points.length} grid points`,
  );

  if (dryRun) return 'updated';

  // Re-stringify the parsed object with `shape` appended. Every other value
  // round-trips through JSON.parse/stringify unchanged (they were written by
  // JSON.stringify in the first place), so no simulation input shifts.
  await writeFile(filePath, JSON.stringify({ ...route, shape }));
  return 'updated';
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  if (dryRun) console.log('DRY RUN — no files will be written\n');

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const dir of ROUTE_DIRS) {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue; // data/routes/ is optional — it only exists once a route has been baked in-app
    }
    const files = entries.filter((f) => f.endsWith('.json') && f !== 'index.json').sort();
    if (files.length === 0) continue;

    console.log(`${dir}/ (${files.length} routes)`);
    for (const file of files) {
      const result = await backfillFile(path.join(dir, file), dryRun);
      if (result === 'updated') updated++;
      else if (result === 'skipped') skipped++;
      else failed++;
    }
    console.log('');
  }

  console.log(`Done: ${updated} updated, ${skipped} skipped, ${failed} unmatched.`);
  if (failed > 0) {
    console.log('Unmatched routes still render from their 25 m grid — correct, just not corner-accurate.');
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
