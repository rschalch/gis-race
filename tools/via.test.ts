import { describe, it, expect } from 'vitest';
import { detectReversals, describeCourse, computeRadius } from './bakeRoute';

/**
 * Multiple endpoints — routing a course through intermediate stops.
 *
 * The routing itself is the router's job and not testable without a network,
 * so what is pinned here are the two pure pieces that carry the feature: the
 * reversal detector (which is what stops a stop-that-needs-a-U-turn from being
 * baked as a straight) and the course naming.
 */

/** Points every `step` metres along a heading, in the projected metre space
 * `resample` produces. */
function leg(from: { x: number; y: number }, headingRad: number, count: number, step = 25) {
  const pts = [];
  for (let i = 1; i <= count; i++) {
    pts.push({
      x: from.x + Math.cos(headingRad) * step * i,
      y: from.y + Math.sin(headingRad) * step * i,
    });
  }
  return pts;
}

describe('detectReversals', () => {
  it('finds nothing on a straight road', () => {
    const pts = [{ x: 0, y: 0 }, ...leg({ x: 0, y: 0 }, 0, 40)];
    expect(detectReversals(pts)).toEqual([]);
  });

  it('finds nothing on an ordinary bend', () => {
    // A 90° turn spread over 20 samples — a sweeping corner, not an about-face.
    const pts = [{ x: 0, y: 0 }];
    for (let i = 1; i <= 20; i++) {
      const a = (Math.PI / 2) * (i / 20);
      pts.push({ x: Math.sin(a) * 300, y: (1 - Math.cos(a)) * 300 });
    }
    expect(detectReversals(pts)).toEqual([]);
  });

  it('finds the point where a route doubles back on itself', () => {
    // Out 1 km, then straight back down the same road.
    const out = [{ x: 0, y: 0 }, ...leg({ x: 0, y: 0 }, 0, 40)];
    const turn = out[out.length - 1]!;
    const back = leg(turn, Math.PI, 40);
    const found = detectReversals([...out, ...back]);

    expect(found.length).toBeGreaterThan(0);
    // Every hit is at the join, give or take the ±2-sample window.
    for (const i of found) expect(Math.abs(i - (out.length - 1))).toBeLessThanOrEqual(2);
  });

  it('catches exactly the about-face Menger curvature is blind to', () => {
    // The reason this detector exists: on an exact reversal the ±2-sample
    // outer points land on top of each other, so the triangle has no area,
    // the radius comes back infinite, and the tightest manoeuvre on the
    // course is recorded as a straight.
    const out = [{ x: 0, y: 0 }, ...leg({ x: 0, y: 0 }, 0, 10)];
    const turn = out[out.length - 1]!;
    const pts = [...out, ...leg(turn, Math.PI, 10)];

    const radius = computeRadius(pts, 2);
    expect(radius[out.length - 1]).toBeGreaterThan(1000); // "straight", wrongly
    expect(detectReversals(pts)).toContain(out.length - 1); // caught anyway
  });

  it('ignores a stop that is merely a sharp junction turn', () => {
    // 90° at a crossroads — sharp, but the road genuinely continues.
    const out = [{ x: 0, y: 0 }, ...leg({ x: 0, y: 0 }, 0, 20)];
    const corner = out[out.length - 1]!;
    expect(detectReversals([...out, ...leg(corner, Math.PI / 2, 20)])).toEqual([]);
  });

  it('finds every reversal, not just the first — a route can visit two dead ends', () => {
    // Out to a dead end, back past the start to a second one, then out again:
    // two about-faces, which is what a course with two spur stops looks like.
    const first = [{ x: 0, y: 0 }, ...leg({ x: 0, y: 0 }, 0, 20)];
    const a = first[first.length - 1]!;
    const backPastStart = leg(a, Math.PI, 20);
    const b = backPastStart[backPastStart.length - 1]!;
    const secondSpur = leg(b, 0, 20);

    const found = detectReversals([...first, ...backPastStart, ...secondSpur]);
    // One cluster at each turn — check they are far apart rather than counting
    // hits, since each about-face spans the detector's window.
    const clusters = found.filter((i, n) => n === 0 || i - found[n - 1]! > 5);
    expect(clusters).toHaveLength(2);
  });

  it('survives duplicated points without dividing by zero', () => {
    const pts = Array.from({ length: 20 }, () => ({ x: 5, y: 5 }));
    expect(detectReversals(pts)).toEqual([]);
  });
});

describe('describeCourse', () => {
  it('names a plain A to B course', () => {
    expect(describeCourse('Sorocaba', [], 'Ubatuba', false)).toBe('Sorocaba → Ubatuba');
  });

  it('spells out the stops, in order', () => {
    expect(describeCourse('Sorocaba', ['Tapiraí', 'Juquiá'], 'Ubatuba', false)).toBe(
      'Sorocaba → Tapiraí → Juquiá → Ubatuba',
    );
  });

  it('returns to the start on a round trip, stops and all', () => {
    expect(describeCourse('Sorocaba', ['Tapiraí'], 'Ubatuba', true)).toBe(
      'Sorocaba → Tapiraí → Ubatuba → Sorocaba',
    );
  });

  it('elides the middle of a long chain, keeping both ends', () => {
    const name = describeCourse('A', ['V1', 'V2', 'V3', 'V4', 'V5'], 'B', false);
    // V1, V2 and V5 are shown, so V3 and V4 are the hidden ones — the count
    // excludes the always-shown last stop.
    expect(name).toBe('A → V1 → V2 → …2 more… → V5 → B');
    expect(name.startsWith('A → V1')).toBe(true);
    expect(name.endsWith('V5 → B')).toBe(true);
  });
});
