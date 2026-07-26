import { describe, it, expect } from 'vitest';
import {
  resample,
  smoothElevation,
  computeGrade,
  computeRadius,
  minFilter,
  SURFACE_GRIP,
  parseMaxspeedToMs,
  buildRoadIndex,
  nearestRoad,
  decodePolyline6,
} from './bakeRoute';

/** Reference encoder for the round-trip test below — the inverse of
 * decodePolyline6 (Google's encoded-polyline algorithm at 1e-6 precision,
 * Valhalla's shape format). Coordinates go in as [lon, lat] but the format
 * itself encodes lat-first — the decoder must undo both. */
function encodePolyline6(coords: [number, number][]): string {
  let out = '';
  let prevLat = 0;
  let prevLon = 0;
  for (const [lon, lat] of coords) {
    const latE6 = Math.round(lat * 1e6);
    const lonE6 = Math.round(lon * 1e6);
    for (const delta of [latE6 - prevLat, lonE6 - prevLon]) {
      let value = delta < 0 ? ~(delta << 1) : delta << 1;
      while (value >= 0x20) {
        out += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
        value >>= 5;
      }
      out += String.fromCharCode(value + 63);
    }
    prevLat = latE6;
    prevLon = lonE6;
  }
  return out;
}

describe('decodePolyline6 (Valhalla shape format)', () => {
  it('decodes an empty shape to no coordinates', () => {
    expect(decodePolyline6('')).toEqual([]);
  });

  it('round-trips southern-hemisphere coordinates at 1e-6 precision, in [lon, lat] order', () => {
    const coords: [number, number][] = [
      [-47.458286, -23.500345], // Sorocaba — negative lon AND lat, the local common case
      [-47.4501, -23.4987],
      [-45.590377, -22.738299],
      [0, 0], // sign-flip crossing the origin exercises the zig-zag encoding both ways
      [151.20733, -33.867487], // positive lon, negative lat
    ];
    const decoded = decodePolyline6(encodePolyline6(coords));
    expect(decoded.length).toBe(coords.length);
    for (let i = 0; i < coords.length; i++) {
      expect(decoded[i]![0]).toBeCloseTo(coords[i]![0], 6);
      expect(decoded[i]![1]).toBeCloseTo(coords[i]![1], 6);
    }
  });
});

describe('resample', () => {
  it('produces uniformly-spaced points starting at s=0', () => {
    const projected = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 200, y: 0 },
    ];
    const result = resample(projected, 25);
    expect(result[0]!.s).toBe(0);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.s - result[i - 1]!.s).toBeCloseTo(25, 5);
    }
  });

  it('interpolates x/y linearly along each segment', () => {
    const projected = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const result = resample(projected, 25);
    const at50 = result.find((p) => p.s === 50)!;
    expect(at50.x).toBeCloseTo(50, 5);
  });
});

describe('smoothElevation', () => {
  it('is a no-op on constant input', () => {
    const ele = new Array(20).fill(100);
    expect(smoothElevation(ele, 4)).toEqual(ele);
  });

  it('smooths a spike toward its neighbours', () => {
    const ele = new Array(11).fill(100);
    ele[5] = 200;
    const smoothed = smoothElevation(ele, 4);
    expect(smoothed[5]!).toBeLessThan(200);
    expect(smoothed[5]!).toBeGreaterThan(100);
  });
});

describe('computeGrade', () => {
  it('is zero on flat ground', () => {
    const ele = new Array(20).fill(50);
    const grade = computeGrade(ele, 25, 2);
    expect(grade.every((g) => g === 0)).toBe(true);
  });

  it('is positive uphill and negative downhill, symmetric in magnitude', () => {
    const n = 20;
    const half = 2;
    const spacing = 25;
    const rise = 10;
    const uphill = Array.from({ length: n }, (_, i) => i * (rise / n));
    const downhill = Array.from({ length: n }, (_, i) => -i * (rise / n));
    const gUp = computeGrade(uphill, spacing, half);
    const gDown = computeGrade(downhill, spacing, half);
    expect(gUp[10]!).toBeGreaterThan(0);
    expect(gDown[10]!).toBeLessThan(0);
    expect(gUp[10]!).toBeCloseTo(-gDown[10]!, 10);
  });
});

describe('computeRadius', () => {
  it('reports a large (straight) radius for collinear points', () => {
    const pts = Array.from({ length: 10 }, (_, i) => ({ x: i * 25, y: 0 }));
    const radius = computeRadius(pts, 2);
    expect(radius[5]!).toBe(5000); // clamped ceiling
  });

  it('reports a small radius for a tight arc', () => {
    const R = 20;
    const pts = Array.from({ length: 10 }, (_, i) => {
      const theta = (i / 9) * (Math.PI / 2);
      return { x: R * Math.sin(theta), y: R * (1 - Math.cos(theta)) };
    });
    const radius = computeRadius(pts, 2);
    expect(radius[5]!).toBeCloseTo(R, 0);
  });
});

describe('R8: SURFACE_GRIP mapping table', () => {
  it('maps paved surfaces to 1.0, progressively rougher surfaces lower', () => {
    expect(SURFACE_GRIP.asphalt).toBe(1.0);
    expect(SURFACE_GRIP.concrete).toBe(1.0);
    expect(SURFACE_GRIP.paving_stones).toBeLessThan(SURFACE_GRIP.asphalt!);
    expect(SURFACE_GRIP.cobblestone).toBeLessThan(SURFACE_GRIP.paving_stones!);
    expect(SURFACE_GRIP.gravel).toBeLessThan(SURFACE_GRIP.cobblestone!);
    expect(SURFACE_GRIP.dirt).toBeLessThanOrEqual(SURFACE_GRIP.gravel!);
  });

  it('has no entry for an untagged/unknown surface (caller treats as 1.0 itself)', () => {
    expect(SURFACE_GRIP.made_up_surface_value).toBeUndefined();
  });
});

describe('R10: parseMaxspeedToMs', () => {
  it('parses a bare numeric km/h value', () => {
    expect(parseMaxspeedToMs('60')).toBeCloseTo(60 / 3.6, 5);
  });

  it('parses an explicit km/h suffix', () => {
    expect(parseMaxspeedToMs('80 km/h')).toBeCloseTo(80 / 3.6, 5);
  });

  it('parses an mph value', () => {
    expect(parseMaxspeedToMs('35 mph')).toBeCloseTo(35 * 0.44704, 5);
  });

  it('returns undefined for non-numeric / implicit-limit tags rather than guessing', () => {
    expect(parseMaxspeedToMs('none')).toBeUndefined();
    expect(parseMaxspeedToMs('signals')).toBeUndefined();
    expect(parseMaxspeedToMs('BR:urban')).toBeUndefined();
    expect(parseMaxspeedToMs(undefined)).toBeUndefined();
  });
});

describe('R8/R10: buildRoadIndex + nearestRoad (point-to-way assignment)', () => {
  // Identity projection — the synthetic "way" geometry is authored directly
  // in local ENU metres, so lon/lat round-trip unchanged.
  const identityProject = (lon: number, lat: number) => ({ x: lon, y: lat });

  it('assigns a nearby point the tags of the nearest tagged way, within the match threshold', () => {
    const ways = [
      {
        type: 'way' as const,
        tags: { highway: 'unclassified', surface: 'gravel', maxspeed: '60' },
        geometry: [
          { lat: 0, lon: 0 },
          { lat: 0, lon: 100 },
        ],
      },
    ];
    const index = buildRoadIndex(ways, identityProject);

    const onRoad = nearestRoad(index, 50, 5, 20); // 5 m off the line, well within 20 m
    expect(onRoad).toBeDefined();
    expect(onRoad!.surfaceGrip).toBeCloseTo(SURFACE_GRIP.gravel!, 10);
    expect(onRoad!.limitMs).toBeCloseTo(60 / 3.6, 5);
  });

  it('finds nothing beyond the match threshold', () => {
    const ways = [
      {
        type: 'way' as const,
        tags: { highway: 'unclassified', surface: 'gravel' },
        geometry: [
          { lat: 0, lon: 0 },
          { lat: 0, lon: 100 },
        ],
      },
    ];
    const index = buildRoadIndex(ways, identityProject);
    expect(nearestRoad(index, 50, 100, 20)).toBeUndefined(); // 100 m off the line
  });

  it('ignores a way with neither a surface nor a maxspeed tag', () => {
    const ways = [
      {
        type: 'way' as const,
        tags: { highway: 'unclassified' },
        geometry: [
          { lat: 0, lon: 0 },
          { lat: 0, lon: 100 },
        ],
      },
    ];
    const index = buildRoadIndex(ways, identityProject);
    expect(nearestRoad(index, 50, 5, 20)).toBeUndefined();
  });
});

describe('minFilter (forward-looking)', () => {
  it('takes the min over [i, i+lookahead], never looking backward', () => {
    const values = [10, 10, 10, 1, 10, 10, 10];
    const out = minFilter(values, 2);
    // index 1 looks at [1,2,3] -> min 1; index 4 (past the dip, lookahead
    // can't see index 3) stays at its own neighbourhood, unaffected.
    expect(out[1]).toBe(1);
    expect(out[4]).toBe(10);
  });

  it('does not let a tight point linger past its own lookahead window', () => {
    const values = new Array(20).fill(1000);
    values[10] = 10;
    const out = minFilter(values, 3);
    expect(out[10]).toBe(10);
    expect(out[7]).toBe(10); // within lookahead before the tight point
    expect(out[11]).toBe(1000); // just after — no backward smearing
  });
});
