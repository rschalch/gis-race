import type { CarState, Route } from '../types';
import type { RouteSample } from '../route';

interface RouteProfileCache {
  route: Route;
  width: number; // device pixels the static layer was rendered at
  height: number;
  dpr: number;
  minEle: number;
  maxEle: number;
  // Pre-rendered curve + fill (P3) — this was being restroked (600 line
  // segments) every frame just to move a handful of dots. Redrawn only when
  // the route or canvas size/DPR changes; every frame just drawImage()s it.
  staticLayer: HTMLCanvasElement;
}

export interface ProfileInstance {
  render(route: Route, cars: CarState[], samples: Map<string, RouteSample>): void;
}

function buildStaticLayer(route: Route, width: number, height: number, dpr: number): RouteProfileCache {
  let minEle = Infinity;
  let maxEle = -Infinity;
  for (const p of route.points) {
    if (p.ele < minEle) minEle = p.ele;
    if (p.ele > maxEle) maxEle = p.ele;
  }

  const STRIDE = Math.max(1, Math.floor(route.points.length / 600));
  const points: Array<{ s: number; ele: number }> = [];
  for (let i = 0; i < route.points.length; i += STRIDE) {
    points.push({ s: route.points[i]!.s, ele: route.points[i]!.ele });
  }
  const last = route.points[route.points.length - 1]!;
  points.push({ s: last.s, ele: last.ele });

  const staticLayer = document.createElement('canvas');
  staticLayer.width = width;
  staticLayer.height = height;
  const ctx = staticLayer.getContext('2d')!;
  ctx.scale(dpr, dpr);

  const w = width / dpr;
  const h = height / dpr;
  const padTop = 10;
  const padBottom = 4;
  const eleRange = Math.max(1, maxEle - minEle);
  const xFor = (s: number) => (s / route.totalDistance) * w;
  const yFor = (ele: number) => h - padBottom - ((ele - minEle) / eleRange) * (h - padTop - padBottom);

  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xFor(p.s);
    const y = yFor(p.ele);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.lineTo(xFor(points[points.length - 1]!.s), h);
  ctx.lineTo(xFor(points[0]!.s), h);
  ctx.closePath();
  ctx.fillStyle = 'rgba(148, 163, 184, 0.18)';
  ctx.fill();

  ctx.beginPath();
  points.forEach((p, i) => {
    const x = xFor(p.s);
    const y = yFor(p.ele);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = '#94a3b8';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  return { route, width, height, dpr, minEle, maxEle, staticLayer };
}

function ensureCanvasSize(canvas: HTMLCanvasElement): { width: number; height: number; dpr: number } {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width * dpr));
  const height = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  return { width, height, dpr };
}

/** §8.3: elevation strip with coloured dots showing each car's position.
 * Binds to `canvas` once and closes over its own cache (R1) instead of a
 * module-level singleton. */
export function initProfile(canvas: HTMLCanvasElement): ProfileInstance {
  let cache: RouteProfileCache | null = null;

  return {
    render(route: Route, cars: CarState[], samples: Map<string, RouteSample>): void {
      const { width, height, dpr } = ensureCanvasSize(canvas);

      if (!cache || cache.route !== route || cache.width !== width || cache.height !== height || cache.dpr !== dpr) {
        cache = buildStaticLayer(route, width, height, dpr);
      }
      const { minEle, maxEle, staticLayer } = cache;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(staticLayer, 0, 0);

      ctx.save();
      ctx.scale(dpr, dpr);

      const w = width / dpr;
      const h = height / dpr;
      const padTop = 10;
      const padBottom = 4;
      const eleRange = Math.max(1, maxEle - minEle);
      const xFor = (s: number) => (s / route.totalDistance) * w;
      const yFor = (ele: number) => h - padBottom - ((ele - minEle) / eleRange) * (h - padTop - padBottom);

      for (const car of cars) {
        const sample = samples.get(car.spec.id)!;
        const x = xFor(car.s);
        const y = yFor(sample.ele);
        ctx.beginPath();
        ctx.arc(x, y, 4, 0, Math.PI * 2);
        ctx.fillStyle = car.spec.colour;
        ctx.fill();
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      ctx.restore();
    },
  };
}
