// Offline route baker — Phase 1 (§5) CLI. Fetches route geometry + elevation
// once, derives grade/curvature, and emits a static route JSON file. Run via
// `npm run bake -- --from ... --to ... --slug ...` (add `--alternatives` to
// also bake the router's alternative paths as sibling variants of the same
// course — F1). Needs network access. Core logic lives in tools/bakeRoute.ts,
// shared with the dev-server on-demand bake API.
//
// `--from`/`--to`/`--via` take either a place name to geocode or exact
// "lat, lon" coordinates. `--via` may be repeated, and the stops are visited in
// the order given. Coordinates are the way to pin a race to a *specific point on a
// specific road*: geocoding "Sorocaba" returns the town centroid, and which
// road the router then picks up from there is not something the town name can
// express. Course naming still reads nicely — a coordinate endpoint is
// reverse-geocoded for its label only, never for its position.

import path from 'node:path';
import { bakeRoute, describeCourse, saveRoute, upsertRouteIndex } from './bakeRoute';

const OUT_DIR = path.resolve('public/data/routes'); // committed — ships in the production build

interface CliArgs {
  from: string;
  to: string;
  /** Intermediate stops, in the order they are driven through. */
  via: string[];
  slug: string;
  alternatives: boolean;
  /** Start → finish → start, as one route. */
  roundTrip: boolean;
  /** Overrides the derived "A → B" course name. */
  name?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const values: Record<string, string> = {};
  const via: string[] = [];
  let alternatives = false;
  let roundTrip = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--alternatives') {
      alternatives = true;
      continue;
    }
    if (arg === '--round-trip') {
      roundTrip = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for --${key}`);
      // --via is the one repeatable flag: each occurrence is another stop, and
      // the order they are typed in is the order they are driven through.
      if (key === 'via') via.push(value);
      else values[key] = value;
      i++;
    }
  }
  if (!values.from || !values.to || !values.slug) {
    throw new Error(
      'Usage: npm run bake -- --from <origin> --to <destination> --slug my-route-slug\n' +
        '                        [--via <stop>]... [--alternatives] [--round-trip] [--name "Course name"]\n' +
        '  <origin>/<destination>/<stop> is a place name ("Sorocaba, SP") or exact coordinates ("-23.50150, -47.45260").\n' +
        '  --via may be repeated; the stops are driven through in the order given, which is how you\n' +
        '  pin the race to the roads you actually want rather than whichever ones the router prefers.\n' +
        '  --round-trip bakes start -> finish -> start as one route; the way back is routed\n' +
        '  separately, so it follows the roads that are actually drivable in that direction.',
    );
  }
  return { from: values.from, to: values.to, via, slug: values.slug, alternatives, roundTrip, name: values.name };
}

async function main() {
  const { from, to, via, slug, alternatives, roundTrip, name } = parseArgs(process.argv.slice(2));

  const {
    variants,
    from: resolvedFrom,
    to: resolvedTo,
    via: resolvedVia,
  } = await bakeRoute({ from, to, via, alternatives, roundTrip });
  // Labels rather than the raw arguments: "-23.50150, -47.45260 → Monte Verde"
  // is a worse course name than "Sorocaba → Monte Verde", and the coordinates
  // are recorded in the baked geometry either way.
  const courseName = name ?? describeCourse(
    resolvedFrom.label,
    resolvedVia.map((v) => v.label),
    resolvedTo.label,
    roundTrip,
  );
  if (!name && !roundTrip && resolvedFrom.label === resolvedTo.label) {
    // Two coordinates inside one town reverse-geocode to the same settlement,
    // which makes a course called "Sorocaba → Sorocaba". Harmless, but say so
    // rather than let it look like a bug.
    console.log(`  note: both endpoints resolved to "${resolvedFrom.label}" — pass --name to title the course yourself.`);
  }

  for (let i = 0; i < variants.length; i++) {
    const { route, distanceKm, elevationGainM } = variants[i]!;
    const variantSlug = i === 0 ? slug : `${slug}-alt${i + 1}`;
    const variantLabel = `Route ${i + 1}`;
    await saveRoute(OUT_DIR, variantSlug, route);
    await upsertRouteIndex(OUT_DIR, {
      slug: variantSlug,
      name: courseName,
      distanceKm,
      elevationGainM,
      courseId: slug,
      variantLabel,
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
