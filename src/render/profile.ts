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
  render(
    route: Route,
    cars: CarState[],
    samples: Map<string, RouteSample>,
    /** Car whose speed trace is drawn, if any — normally the followed car. */
    focus?: CarState,
  ): void;
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

/**
 * Canvas backing-store size, re-measured only when the element actually
 * changes size.
 *
 * `getBoundingClientRect` forces a synchronous style+layout pass, and this was
 * being called once per animation frame — measured as the single most expensive
 * JS call in a CPU profile of the running app, and the worst possible one to
 * make while MapLibre is handling a drag, since every forced layout lands in
 * the middle of the gesture's own frame. A ResizeObserver reports the same
 * numbers from layout the browser has already done.
 */
function watchCanvasSize(canvas: HTMLCanvasElement): () => { width: number; height: number; dpr: number } {
  let cssWidth = 0;
  let cssHeight = 0;
  let dpr = window.devicePixelRatio || 1;

  const measure = (): void => {
    const rect = canvas.getBoundingClientRect();
    cssWidth = rect.width;
    cssHeight = rect.height;
    dpr = window.devicePixelRatio || 1;
  };
  measure();

  const observer = new ResizeObserver((entries) => {
    const box = entries[0]?.contentRect;
    if (box) {
      cssWidth = box.width;
      cssHeight = box.height;
    }
    // Dragging a window between displays changes DPR without changing the CSS
    // box, so it is re-read here rather than only at construction.
    dpr = window.devicePixelRatio || 1;
  });
  observer.observe(canvas);

  return () => {
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    return { width, height, dpr };
  };
}

/** §8.3: elevation strip with coloured dots showing each car's position.
 * Binds to `canvas` once and closes over its own cache (R1) instead of a
 * module-level singleton. */
export function initProfile(canvas: HTMLCanvasElement): ProfileInstance {
  let cache: RouteProfileCache | null = null;
  // The followed car's speed trace, pre-built as a Path2D. `speedProfile` is
  // immutable for a car's whole race (see driver.ts), so the trace is fixed
  // geometry — it was being re-derived every frame, including a full scan of
  // the profile array (~9000 floats on a 225 km route) just to find its
  // maximum. Rebuilt only when the followed car or the canvas geometry
  // changes.
  let traceCache: { carId: string; route: Route; width: number; height: number; path: Path2D } | null = null;
  const canvasSize = watchCanvasSize(canvas);

  return {
    render(route: Route, cars: CarState[], samples: Map<string, RouteSample>, focus?: CarState): void {
      const { width, height, dpr } = canvasSize();

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

      // Speed trace for the followed car: its own target-speed profile drawn
      // across the strip, so the elevation chart also shows *why* the car is
      // slow where it is slow. The profile is a frozen Float32Array on
      // CarState, already indexed on the same 25 m grid as route.points —
      // nothing has to be recomputed to draw it.
      if (focus && focus.route === route && focus.speedProfile.length > 1) {
        const stale =
          traceCache === null ||
          traceCache.carId !== focus.spec.id ||
          traceCache.route !== route ||
          traceCache.width !== width ||
          traceCache.height !== height;
        if (stale) {
          const profileArr = focus.speedProfile;
          let vMaxSeen = 0;
          for (let i = 0; i < profileArr.length; i++) if (profileArr[i]! > vMaxSeen) vMaxSeen = profileArr[i]!;
          const path = new Path2D();
          if (vMaxSeen > 0) {
            const STRIDE = Math.max(1, Math.floor(profileArr.length / 600));
            let started = false;
            for (let i = 0; i < profileArr.length; i += STRIDE) {
              const point = route.points[i];
              if (!point) break;
              const x = xFor(point.s);
              // Independent vertical scale from elevation — this is a second
              // series sharing an axis, so it is drawn as a light overlay
              // rather than pretending to be in metres.
              const y = h - padBottom - (profileArr[i]! / vMaxSeen) * (h - padTop - padBottom);
              if (!started) {
                path.moveTo(x, y);
                started = true;
              } else path.lineTo(x, y);
            }
          }
          traceCache = { carId: focus.spec.id, route, width, height, path };
        }
        ctx.strokeStyle = 'rgba(56, 189, 248, 0.55)';
        ctx.lineWidth = 1;
        ctx.stroke(traceCache!.path);
      }

      // Incident markers: every incident that has happened on this route so
      // far, at the distance it happened. Retirements are drawn larger — a
      // race-ending moment should not look like a two-second slide.
      for (const car of cars) {
        if (car.route !== route) continue;
        for (const incident of car.incidents) {
          const x = xFor(incident.s);
          const terminal = incident.severity === 'off-road' || incident.severity === 'mechanical';
          ctx.beginPath();
          ctx.moveTo(x, padTop - 6);
          ctx.lineTo(x - (terminal ? 4 : 3), padTop + (terminal ? 3 : 1));
          ctx.lineTo(x + (terminal ? 4 : 3), padTop + (terminal ? 3 : 1));
          ctx.closePath();
          ctx.fillStyle = terminal ? '#ef4444' : '#f59e0b';
          ctx.fill();
        }
      }

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
