import { describe, it, expect } from 'vitest';
import { buildCarMesh } from './car-mesh';

describe('buildCarMesh', () => {
  const mesh = buildCarMesh();
  const pos = mesh.attributes.POSITION.value;
  const nrm = mesh.attributes.NORMAL.value;
  const col = mesh.attributes.COLOR_0.value;
  const idx = mesh.indices.value;
  const vertexCount = pos.length / 3;

  it('emits matching position/normal/colour attributes', () => {
    expect(nrm.length).toBe(pos.length);
    // COLOR_0 must be float32x3 in 0-1: the shader declares `in vec3 colors`
    // and multiplies by the instance colour. Bytes fail two different ways —
    // size 3 won't initialise (no unorm8x3 format), size 4 arrives as raw
    // 0-255 and saturates every car to white.
    expect(mesh.attributes.COLOR_0.size).toBe(3);
    expect(col.length).toBe(vertexCount * 3);
    for (const c of col) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
    expect(vertexCount).toBeGreaterThan(0);
  });

  it('keeps every index inside the vertex range', () => {
    for (const i of idx) expect(i).toBeLessThan(vertexCount);
    expect(idx.length % 3).toBe(0);
    // Uint16 indices — the mesh must not silently overflow if it grows.
    expect(vertexCount).toBeLessThan(65536);
  });

  it('is sized like a real car, in metres', () => {
    const extent = (o: number) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = o; i < pos.length; i += 3) {
        lo = Math.min(lo, pos[i]!);
        hi = Math.max(hi, pos[i]!);
      }
      return hi - lo;
    };
    expect(extent(0)).toBeGreaterThan(3.5); // length
    expect(extent(0)).toBeLessThan(5.0);
    expect(extent(1)).toBeGreaterThan(1.5); // width
    expect(extent(1)).toBeLessThan(2.2);
    expect(extent(2)).toBeGreaterThan(1.2); // height
    expect(extent(2)).toBeLessThan(1.8);
  });

  it('sits on the ground plane rather than straddling it', () => {
    let minZ = Infinity;
    for (let i = 2; i < pos.length; i += 3) minZ = Math.min(minZ, pos[i]!);
    expect(minZ).toBeCloseTo(0, 5);
  });

  it('has unit-length normals', () => {
    for (let i = 0; i < nrm.length; i += 3) {
      expect(Math.hypot(nrm[i]!, nrm[i + 1]!, nrm[i + 2]!)).toBeCloseTo(1, 4);
    }
  });

  it('tints parts differently so the model does not read as a solid slab', () => {
    // COLOR_0 multiplies the per-car livery colour, so distinct tints are the
    // only thing separating glass and wheels from bodywork.
    const tints = new Set<number>();
    for (let i = 0; i < col.length; i += 3) tints.add(col[i]!);
    expect(tints.size).toBeGreaterThanOrEqual(3);
    // Full-brightness bodywork must exist, or every car renders darkened.
    expect(Math.max(...tints)).toBe(1);
    // And something must be near-black (the wheels).
    expect(Math.min(...tints)).toBeLessThan(0.25);
  });

  it('tapers toward the nose so the plan view has a facing direction', () => {
    // Widest point should be behind the nose — a plain box reads as a
    // featureless rectangle from directly overhead.
    let noseHalfWidth = 0;
    let maxHalfWidth = 0;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i]!;
      const absY = Math.abs(pos[i + 1]!);
      maxHalfWidth = Math.max(maxHalfWidth, absY);
      if (x > 2.0) noseHalfWidth = Math.max(noseHalfWidth, absY);
    }
    expect(noseHalfWidth).toBeLessThan(maxHalfWidth * 0.8);
  });
});
