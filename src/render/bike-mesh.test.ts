import { describe, it, expect } from 'vitest';
import { buildMotorcycleMesh, BIKE_LENGTH_M } from './bike-mesh';
import { buildCarMesh } from './car-mesh';

describe('buildMotorcycleMesh', () => {
  const mesh = buildMotorcycleMesh();
  const pos = mesh.attributes.POSITION.value;
  const nrm = mesh.attributes.NORMAL.value;
  const col = mesh.attributes.COLOR_0.value;
  const idx = mesh.indices.value;
  const vertexCount = pos.length / 3;

  const extent = (o: number) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = o; i < pos.length; i += 3) {
      lo = Math.min(lo, pos[i]!);
      hi = Math.max(hi, pos[i]!);
    }
    return hi - lo;
  };

  it('emits matching position/normal/colour attributes in the format deck.gl wants', () => {
    expect(nrm.length).toBe(pos.length);
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
    expect(vertexCount).toBeLessThan(65536);
  });

  it('is sized like a real motorcycle, in metres', () => {
    expect(extent(0)).toBeCloseTo(BIKE_LENGTH_M, 1); // length
    expect(extent(1)).toBeGreaterThan(0.5); // width, at the bars
    expect(extent(1)).toBeLessThan(0.95);
    expect(extent(2)).toBeGreaterThan(1.0); // height, over the rider
    expect(extent(2)).toBeLessThan(1.5);
  });

  it('is about half a car long and a third its width — the reason both share one scale', () => {
    const carPos = buildCarMesh().attributes.POSITION.value;
    const carExtent = (o: number) => {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = o; i < carPos.length; i += 3) {
        lo = Math.min(lo, carPos[i]!);
        hi = Math.max(hi, carPos[i]!);
      }
      return hi - lo;
    };
    expect(extent(0) / carExtent(0)).toBeGreaterThan(0.4);
    expect(extent(0) / carExtent(0)).toBeLessThan(0.6);
    expect(extent(1) / carExtent(1)).toBeLessThan(0.5);
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

  it('tints parts differently so the model does not read as a solid blade', () => {
    const tints = new Set<number>();
    for (let i = 0; i < col.length; i += 3) tints.add(col[i]!);
    expect(tints.size).toBeGreaterThanOrEqual(3);
    expect(Math.max(...tints)).toBe(1); // livery-coloured bodywork exists
    expect(Math.min(...tints)).toBeLessThan(0.25); // and near-black wheels
  });

  it('puts the widest part at the rider/bars, not the bodywork', () => {
    // This is what makes a bike visible from overhead at all — see the file's
    // own note. Bodywork spans y < 0.2; the bars and shoulders go wider.
    let bodyHalfWidth = 0;
    let maxHalfWidth = 0;
    for (let i = 0; i < pos.length; i += 3) {
      const z = pos[i + 2]!;
      const absY = Math.abs(pos[i + 1]!);
      maxHalfWidth = Math.max(maxHalfWidth, absY);
      if (z < 0.78) bodyHalfWidth = Math.max(bodyHalfWidth, absY);
    }
    expect(maxHalfWidth).toBeGreaterThan(0.3);
    expect(bodyHalfWidth).toBeLessThan(maxHalfWidth);
  });
});
