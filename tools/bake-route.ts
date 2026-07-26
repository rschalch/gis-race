// Offline route baker — Phase 1 (§5) CLI. Fetches route geometry + elevation
// once, derives grade/curvature, and emits a static route JSON file. Run via
// `npm run bake -- --from ... --to ... --slug ...` (add `--alternatives` to
// also bake the router's alternative paths as sibling variants of the same
// course — F1). Needs network access. Core logic lives in tools/bakeRoute.ts,
// shared with the dev-server on-demand bake API.

import path from 'node:path';
import { bakeRoute, saveRoute, upsertRouteIndex } from './bakeRoute';

const OUT_DIR = path.resolve('public/data/routes'); // committed — ships in the production build

interface CliArgs {
  from: string;
  to: string;
  slug: string;
  alternatives: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const values: Record<string, string> = {};
  let alternatives = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--alternatives') {
      alternatives = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for --${key}`);
      values[key] = value;
      i++;
    }
  }
  if (!values.from || !values.to || !values.slug) {
    throw new Error(
      'Usage: npm run bake -- --from "Origin, ST" --to "Destination, ST" --slug my-route-slug [--alternatives]',
    );
  }
  return { from: values.from, to: values.to, slug: values.slug, alternatives };
}

async function main() {
  const { from, to, slug, alternatives } = parseArgs(process.argv.slice(2));

  const { variants } = await bakeRoute({ from, to, alternatives });

  for (let i = 0; i < variants.length; i++) {
    const { route, distanceKm, elevationGainM } = variants[i]!;
    const variantSlug = i === 0 ? slug : `${slug}-alt${i + 1}`;
    const variantLabel = `Route ${i + 1}`;
    await saveRoute(OUT_DIR, variantSlug, route);
    await upsertRouteIndex(OUT_DIR, {
      slug: variantSlug,
      name: `${from} → ${to}`,
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
