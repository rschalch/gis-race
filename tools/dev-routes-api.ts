// Vite dev-server plugin exposing the on-demand route-bake API. Runs inside
// the same Node process as `npm run dev`, so it's the only reason this app
// needs a "server" at all — deliberately not built as a standalone service
// or serverless functions, since the app is local-only for now (per user).
//
// Endpoints:
//   GET  /api/routes/search?q=...   autocomplete suggestions (Nominatim proxy)
//   POST /api/routes/bake           { from, to, via?, alternatives?, roundTrip? } -> bakes,
//                                    where from/to are place names or exact
//                                    "lat, lon" coordinates (src/coords.ts),
//                                    persists, returns the new
//                                    RouteIndexEntry variant(s) (or an error)
//   DELETE /api/routes/courses/<courseId>
//                                    removes every variant of a course (route
//                                    files + index entries, committed or
//                                    on-demand); refuses to delete the last
//                                    remaining course
//   PATCH  /api/routes/courses/<courseId>
//                                    { name } -> renames a course's display
//                                    name across all its variants (index
//                                    entries only — slugs/files untouched)
//   GET  /data/routes/index.json    merged committed + on-demand route index
//   GET  /data/routes/<slug>.json   an on-demand-baked route (falls through
//                                    to Vite's normal publicDir static
//                                    serving for committed routes)
//
// On-demand bakes are written to CUSTOM_ROUTES_DIR — a directory OUTSIDE
// publicDir — rather than into public/data/routes/ alongside the committed
// routes. Vite's dev server only learns about a publicDir file via its
// filesystem watcher; a file written there after the server has booted is
// otherwise unservable (confirmed by reproduction: `curl` on a freshly
// written public/ file 200s with index.html, not the file, until the
// watcher sees an add/change event for it). Ignoring that directory from
// the watcher (an earlier attempt at fixing the disruptive full-reload this
// used to cause) "fixed" the reload by making the watcher never see new
// bakes at all — so the very JSON just baked came back unservable. Writing
// on-demand bakes somewhere Vite's publicDir logic never touches sidesteps
// both problems at once, and the GET routes above stitch the two sources
// back into one virtual `/data/routes/` namespace for the client.

import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { bakeRoute, describeCourse, saveRoute, upsertRouteIndex, BakeError, searchPlaces } from './bakeRoute';
import type { Route, RouteIndexEntry } from '../src/types.ts';

const COMMITTED_ROUTES_DIR = path.resolve('public/data/routes');
const CUSTOM_ROUTES_DIR = path.resolve('data/routes');

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip combining accents (e.g. U+00E3 -> "a" after NFD)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function readIndex(dir: string): Promise<RouteIndexEntry[]> {
  try {
    return JSON.parse(await readFile(path.join(dir, 'index.json'), 'utf-8'));
  } catch {
    return [];
  }
}

/** Removes every variant of `courseId` from `dir`'s index + route files.
 * Returns the removed slugs (empty if the course doesn't live in this dir). */
async function removeCourseFromDir(dir: string, courseId: string): Promise<string[]> {
  const index = await readIndex(dir);
  const removed = index.filter((e) => e.courseId === courseId);
  if (removed.length === 0) return [];
  const kept = index.filter((e) => e.courseId !== courseId);
  await writeFile(path.join(dir, 'index.json'), JSON.stringify(kept, null, 2));
  for (const e of removed) {
    // Index entry is already gone — a missing file just means a previously
    // orphaned entry, not a failure worth surfacing.
    await unlink(path.join(dir, `${e.slug}.json`)).catch(() => undefined);
  }
  return removed.map((e) => e.slug);
}

/** Rewrites the display name of every variant of `courseId` in `dir`'s
 * index. Returns how many entries were renamed (0 if the course doesn't
 * live in this dir). */
async function renameCourseInDir(dir: string, courseId: string, name: string): Promise<number> {
  const index = await readIndex(dir);
  const matches = index.filter((e) => e.courseId === courseId);
  if (matches.length === 0) return 0;
  for (const e of matches) e.name = name;
  await writeFile(path.join(dir, 'index.json'), JSON.stringify(index, null, 2));
  return matches.length;
}

async function uniqueSlug(base: string): Promise<string> {
  const [committed, custom] = await Promise.all([readIndex(COMMITTED_ROUTES_DIR), readIndex(CUSTOM_ROUTES_DIR)]);
  const taken = new Set([...committed, ...custom].map((e) => e.slug));
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base}-${i}`)) i++;
  return `${base}-${i}`;
}

// Two concurrent POST /api/routes/bake calls would both read-modify-write
// index.json — one entry silently disappears (file stays on disk, orphaned)
// and uniqueSlug has the same TOCTOU shape (B13). A promise-chain mutex
// serializes bakes; given Nominatim/OpenTopoData are rate-limited to ~1
// req/s process-wide anyway, queueing rather than rejecting is the honest
// behavior — a second bake was never going to be fast regardless.
let bakeQueue: Promise<unknown> = Promise.resolve();

function enqueueBake<T>(job: () => Promise<T>): Promise<T> {
  const result = bakeQueue.then(job, job);
  bakeQueue = result.catch(() => undefined);
  return result;
}

export function routesApiPlugin(): Plugin {
  return {
    name: 'gis-racer-routes-api',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');

        if (req.method === 'GET' && url.pathname === '/api/routes/search') {
          try {
            const q = url.searchParams.get('q') ?? '';
            const results = await searchPlaces(q);
            sendJson(res, 200, results);
          } catch (err) {
            sendJson(res, err instanceof BakeError ? 400 : 500, { error: String(err instanceof Error ? err.message : err) });
          }
          return;
        }

        if (req.method === 'GET' && url.pathname === '/data/routes/index.json') {
          const [committed, custom] = await Promise.all([readIndex(COMMITTED_ROUTES_DIR), readIndex(CUSTOM_ROUTES_DIR)]);
          sendJson(res, 200, [...committed, ...custom]);
          return;
        }

        const routeFileMatch = /^\/data\/routes\/([^/]+)\.json$/.exec(url.pathname);
        if (req.method === 'GET' && routeFileMatch) {
          try {
            const route: Route = JSON.parse(
              await readFile(path.join(CUSTOM_ROUTES_DIR, `${routeFileMatch[1]}.json`), 'utf-8'),
            );
            sendJson(res, 200, route);
          } catch {
            next(); // not an on-demand bake — let Vite serve it from publicDir if it's a committed route
          }
          return;
        }

        const courseMatch = /^\/api\/routes\/courses\/([^/]+)$/.exec(url.pathname);

        if (req.method === 'PATCH' && courseMatch) {
          const courseId = courseMatch[1]!;
          if (!/^[a-z0-9-]+$/.test(courseId)) {
            sendJson(res, 400, { error: 'Invalid course id.' });
            return;
          }
          try {
            const body = (await readJsonBody(req)) as { name?: unknown };
            const name = typeof body.name === 'string' ? body.name.trim() : '';
            if (!name || name.length > 120) {
              sendJson(res, 400, { error: 'Name must be 1–120 characters.' });
              return;
            }
            // Same mutex as bakes/deletes — renaming is a read-modify-write
            // on the same index.json files.
            await enqueueBake(async () => {
              const renamed =
                (await renameCourseInDir(COMMITTED_ROUTES_DIR, courseId, name)) +
                (await renameCourseInDir(CUSTOM_ROUTES_DIR, courseId, name));
              if (renamed === 0) throw new BakeError('Course not found.');
            });
            sendJson(res, 200, { name });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            sendJson(res, err instanceof BakeError ? 400 : 500, { error: message });
          }
          return;
        }

        if (req.method === 'DELETE' && courseMatch) {
          const courseId = courseMatch[1]!;
          // Slugs are produced by slugify() — anything outside this alphabet
          // is at best a stale client, at worst a path-traversal attempt.
          if (!/^[a-z0-9-]+$/.test(courseId)) {
            sendJson(res, 400, { error: 'Invalid course id.' });
            return;
          }
          try {
            // Same mutex as bakes — deletion is a read-modify-write on the
            // same index.json files.
            const removedSlugs = await enqueueBake(async () => {
              const [committed, custom] = await Promise.all([
                readIndex(COMMITTED_ROUTES_DIR),
                readIndex(CUSTOM_ROUTES_DIR),
              ]);
              const merged = [...committed, ...custom];
              if (!merged.some((e) => e.courseId === courseId)) {
                throw new BakeError('Course not found.');
              }
              if (merged.every((e) => e.courseId === courseId)) {
                throw new BakeError('Cannot delete the last remaining course.');
              }
              const removed = [
                ...(await removeCourseFromDir(COMMITTED_ROUTES_DIR, courseId)),
                ...(await removeCourseFromDir(CUSTOM_ROUTES_DIR, courseId)),
              ];
              return removed;
            });
            sendJson(res, 200, { removedSlugs });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            sendJson(res, err instanceof BakeError ? 400 : 500, { error: message });
          }
          return;
        }

        if (req.method === 'POST' && url.pathname === '/api/routes/bake') {
          try {
            const body = (await readJsonBody(req)) as {
              from?: string;
              to?: string;
              fromCoord?: { lon: number; lat: number };
              toCoord?: { lon: number; lat: number };
              /** Intermediate stops, in the order they are driven through.
               * Each carries its own optional coordinate for the same reason
               * the endpoints do: a clicked autocomplete suggestion already
               * knows exactly where it is, so re-geocoding its label would be
               * both slower and less precise. */
              via?: Array<{ text?: string; coord?: { lon: number; lat: number } }>;
              alternatives?: boolean;
              roundTrip?: boolean;
            };
            const from = body.from?.trim();
            const to = body.to?.trim();
            if (!from || !to) {
              sendJson(res, 400, { error: 'Both "from" and "to" are required.' });
              return;
            }
            const fromCoord: [number, number] | undefined = body.fromCoord
              ? [body.fromCoord.lon, body.fromCoord.lat]
              : undefined;
            const toCoord: [number, number] | undefined = body.toCoord
              ? [body.toCoord.lon, body.toCoord.lat]
              : undefined;
            // Blank stops are dropped rather than rejected: the panel keeps an
            // empty field around for the next one to be typed into, and an
            // empty box is a stop the user has not filled in yet, not an error.
            const stops = (body.via ?? [])
              .map((v) => ({ text: v.text?.trim() ?? '', coord: v.coord }))
              .filter((v) => v.text.length > 0);

            const { entries, warnings } = await enqueueBake(async () => {
              const {
                variants,
                from: resolvedFrom,
                to: resolvedTo,
                via: resolvedVia,
              } = await bakeRoute({
                from,
                to,
                fromCoord,
                toCoord,
                via: stops.map((v) => v.text),
                viaCoords: stops.map((v) => (v.coord ? [v.coord.lon, v.coord.lat] : undefined)),
                alternatives: body.alternatives,
                roundTrip: body.roundTrip,
              });
              // Name and slug come from the *resolved* endpoints: a course
              // started from typed coordinates would otherwise be called
              // "-23.50150, -47.45260 → ..." and slugged to match.
              const courseName = describeCourse(
                resolvedFrom.label,
                resolvedVia.map((v) => v.label),
                resolvedTo.label,
                body.roundTrip ?? false,
              );
              // The slug names the two ends and *counts* the stops rather than
              // listing them: a chain of four labels makes a filename nobody
              // can read, and the stops are already spelled out in the name.
              const viaPart = resolvedVia.length > 0 ? `-via-${resolvedVia.length}` : '';
              const courseId = await uniqueSlug(
                `${slugify(resolvedFrom.label)}-${slugify(resolvedTo.label)}${viaPart}` +
                  `${body.roundTrip ? '-round-trip' : ''}`,
              );

              const entries: RouteIndexEntry[] = [];
              const warnings: string[] = [];
              for (let i = 0; i < variants.length; i++) {
                const variant = variants[i]!;
                const slug = i === 0 ? courseId : `${courseId}-alt${i + 1}`;
                const entry: RouteIndexEntry = {
                  slug,
                  name: courseName,
                  distanceKm: variant.distanceKm,
                  elevationGainM: variant.elevationGainM,
                  courseId,
                  variantLabel: `Route ${i + 1}`,
                };
                await saveRoute(CUSTOM_ROUTES_DIR, slug, variant.route);
                await upsertRouteIndex(CUSTOM_ROUTES_DIR, entry);
                entries.push(entry);
                warnings.push(...variant.warnings);
              }
              return { entries, warnings };
            });

            sendJson(res, 200, { entries, warnings });
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            sendJson(res, err instanceof BakeError ? 400 : 500, { error: message });
          }
          return;
        }

        next();
      });
    },
  };
}
