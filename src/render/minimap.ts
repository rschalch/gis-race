import type { CarState, Route } from '../types';

/**
 * Route overview inset.
 *
 * The chase camera solves one problem and creates another: at zoom 15 with 75°
 * of pitch you can see the road surface and nothing else, so a 225 km route
 * becomes two hundred metres of tarmac with no sense of where on it you are.
 * This is the map you lose when you go down to the road.
 *
 * Deliberately a 2D canvas rather than a second MapLibre instance. A second map
 * means a second WebGL context, a second tile pipeline and a second set of
 * per-frame work, all to draw a static polyline and a dozen dots — and the
 * elevation strip next door already proves the canvas approach. The route path
 * is baked once into an offscreen layer and blitted, exactly as profile.ts does
 * with its elevation curve.
 */

export interface MinimapInstance {
  render(routes: Map<string, Route>, cars: CarState[], focus?: CarState): void;
}

interface RouteLayerCache {
  /** Identity of the route set this was drawn for. */
  key: string;
  width: number;
  height: number;
  dpr: number;
  /** Projection captured with the layer, so dots land on the drawn line. */
  project: (lon: number, lat: number) => [number, number];
  layer: HTMLCanvasElement;
}

const PADDING_PX = 10;

/** One casing colour per route variant, matching map.ts's line colours so the
 * inset and the map agree about which road is which. */
const VARIANT_COLOURS = ['#64748b', '#8b5cf6', '#14b8a6', '#f97316', '#06b6d4'];

function routeSetKey(routes: Map<string, Route>): string {
  return [...routes.keys()].join('|');
}

/**
 * Equirectangular fit of every route into the box.
 *
 * Longitude is scaled by cos(lat) so the shape isn't stretched sideways — at
 * 23° south that is an 8% error, which is the difference between a recognisable
 * route and a squashed one. A full Mercator projection would be overkill for a
 * few hundred kilometres.
 */
function buildProjection(
  routes: Map<string, Route>,
  width: number,
  height: number,
  dpr: number,
): (lon: number, lat: number) => [number, number] {
  let minLon = Infinity;
  let maxLon = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const route of routes.values()) {
    for (const p of route.points) {
      if (p.lon < minLon) minLon = p.lon;
      if (p.lon > maxLon) maxLon = p.lon;
      if (p.lat < minLat) minLat = p.lat;
      if (p.lat > maxLat) maxLat = p.lat;
    }
  }

  const midLat = ((minLat + maxLat) / 2) * (Math.PI / 180);
  const lonScale = Math.cos(midLat);
  const spanX = Math.max(1e-9, (maxLon - minLon) * lonScale);
  const spanY = Math.max(1e-9, maxLat - minLat);

  const boxW = width / dpr - PADDING_PX * 2;
  const boxH = height / dpr - PADDING_PX * 2;
  const scale = Math.min(boxW / spanX, boxH / spanY);
  // Centre whichever axis has slack, so a mostly-north-south route doesn't hug
  // one edge of the box.
  const offsetX = PADDING_PX + (boxW - spanX * scale) / 2;
  const offsetY = PADDING_PX + (boxH - spanY * scale) / 2;

  return (lon, lat) => [
    offsetX + (lon - minLon) * lonScale * scale,
    // Screen y grows downward; latitude grows upward.
    offsetY + (maxLat - lat) * scale,
  ];
}

function buildRouteLayer(routes: Map<string, Route>, width: number, height: number, dpr: number): RouteLayerCache {
  const project = buildProjection(routes, width, height, dpr);
  const layer = document.createElement('canvas');
  layer.width = width;
  layer.height = height;
  const ctx = layer.getContext('2d')!;
  ctx.scale(dpr, dpr);

  let variant = 0;
  for (const route of routes.values()) {
    // The 25 m simulation grid is far finer than this box can resolve — a
    // 9000-point route into 200 px is 45 points per pixel. Stride it.
    const stride = Math.max(1, Math.floor(route.points.length / 400));
    ctx.beginPath();
    for (let i = 0; i < route.points.length; i += stride) {
      const [x, y] = project(route.points[i]!.lon, route.points[i]!.lat);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    const last = route.points[route.points.length - 1]!;
    const [lx, ly] = project(last.lon, last.lat);
    ctx.lineTo(lx, ly);
    ctx.strokeStyle = VARIANT_COLOURS[variant % VARIANT_COLOURS.length]!;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke();
    variant += 1;
  }

  // Start and finish, drawn into the static layer — they move only when the
  // route set does.
  for (const route of routes.values()) {
    const first = route.points[0]!;
    const last = route.points[route.points.length - 1]!;
    for (const [point, colour] of [
      [first, '#22c55e'],
      [last, '#ef4444'],
    ] as const) {
      const [x, y] = project(point.lon, point.lat);
      ctx.beginPath();
      ctx.arc(x, y, 3.5, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.strokeStyle = '#0f172a';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
  }

  return { key: routeSetKey(routes), width, height, dpr, project, layer };
}

export function initMinimap(canvas: HTMLCanvasElement): MinimapInstance {
  let cache: RouteLayerCache | null = null;

  // Same reasoning as profile.ts: getBoundingClientRect forces layout, so the
  // size is observed rather than measured every frame.
  let cssWidth = canvas.getBoundingClientRect().width;
  let cssHeight = canvas.getBoundingClientRect().height;
  let dpr = window.devicePixelRatio || 1;
  new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (box) {
      cssWidth = box.width;
      cssHeight = box.height;
    }
    dpr = window.devicePixelRatio || 1;
  }).observe(canvas);

  return {
    render(routes: Map<string, Route>, cars: CarState[], focus?: CarState): void {
      if (routes.size === 0) return;
      const width = Math.max(1, Math.round(cssWidth * dpr));
      const height = Math.max(1, Math.round(cssHeight * dpr));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }

      const key = routeSetKey(routes);
      if (!cache || cache.key !== key || cache.width !== width || cache.height !== height || cache.dpr !== dpr) {
        cache = buildRouteLayer(routes, width, height, dpr);
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(cache.layer, 0, 0);

      ctx.save();
      ctx.scale(dpr, dpr);

      // Retired cars stay where they stopped — that is information, not clutter
      // — but they are drawn hollow so they don't read as part of the race.
      for (const car of cars) {
        if (car.status === 'staged') continue;
        const point = car.route.points[Math.min(Math.floor(car.s / car.route.spacing), car.route.points.length - 1)]!;
        const [x, y] = cache.project(point.lon, point.lat);
        const isFocus = focus !== undefined && car.spec.id === focus.spec.id;
        ctx.beginPath();
        ctx.arc(x, y, isFocus ? 4.5 : 3, 0, Math.PI * 2);
        if (car.status === 'retired') {
          ctx.strokeStyle = car.spec.colour;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        } else {
          ctx.fillStyle = car.spec.colour;
          ctx.fill();
          ctx.strokeStyle = isFocus ? '#ffffff' : 'rgba(15,23,42,0.8)';
          ctx.lineWidth = isFocus ? 2 : 1;
          ctx.stroke();
        }
      }

      ctx.restore();
    },
  };
}
