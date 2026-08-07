/**
 * A low-poly car, generated rather than loaded.
 *
 * Deliberately not a glTF asset: a file would mean sourcing a model with a
 * compatible licence, committing a binary, and pulling in @loaders.gl/gltf to
 * parse it. `mesh` in cars-3d.ts is a single value to swap when a real model is
 * worth the dependency.
 *
 * Two things drive the shape, both learned from looking at it on the map:
 *
 * 1. The car is seen from above or from a steep chase angle, so the *plan*
 *    silhouette is what reads — not the side profile. Boxes render as
 *    featureless rectangles from overhead. The body and cabin are therefore
 *    extruded from tapered outlines, which gives a nose, shoulders and a
 *    visible roof step.
 * 2. Every part must differ in tone. deck.gl multiplies `COLOR_0` with the
 *    per-instance colour, so vertex colours here act as *multipliers* on the
 *    car's livery: 1.0 shows it as-is, lower values darken. Glass and wheels
 *    darken sharply, which is what stops the model reading as a solid slab.
 *    (Multipliers cannot brighten, so there are no white headlights — every
 *    part is a tint of the car's own colour.)
 *
 * Axes match deck.gl's mesh space: +X forward (nose), +Y left, +Z up, metres.
 */

export interface CarMeshData {
  attributes: {
    POSITION: { value: Float32Array; size: 3 };
    NORMAL: { value: Float32Array; size: 3 };
    COLOR_0: { value: Float32Array; size: 3 };
  };
  indices: { value: Uint16Array; size: 1 };
}

export type Point2 = [number, number];

/** Tapered plan outline of the lower body, counter-clockwise from the nose. */
const BODY_OUTLINE: Point2[] = [
  [2.1, 0.55],
  [1.85, 0.86],
  [-1.85, 0.9],
  [-2.1, 0.6],
  [-2.1, -0.6],
  [-1.85, -0.9],
  [1.85, -0.86],
  [2.1, -0.55],
];

/** Cabin/greenhouse, inset and set back — the step that reads as a roof. */
const CABIN_OUTLINE: Point2[] = [
  [0.75, 0.42],
  [0.55, 0.63],
  [-1.15, 0.66],
  [-1.35, 0.46],
  [-1.35, -0.46],
  [-1.15, -0.66],
  [0.55, -0.63],
  [0.75, -0.42],
];

const BODY_Z: [number, number] = [0.3, 0.8];
const CABIN_Z: [number, number] = [0.8, 1.32];

// Multipliers on the car's livery colour.
const BODY_TINT = 1.0;
const CABIN_TINT = 0.34; // glass — dark enough to separate from the body
const WHEEL_TINT = 0.1; // near-black

export interface Box {
  center: [number, number, number];
  half: [number, number, number];
  tint: number;
}

// Wheels sit slightly proud of the body sides so they stay visible in plan.
const WHEELS: Box[] = [
  { center: [1.32, 0.9, 0.17], half: [0.36, 0.13, 0.17], tint: WHEEL_TINT },
  { center: [1.32, -0.9, 0.17], half: [0.36, 0.13, 0.17], tint: WHEEL_TINT },
  { center: [-1.35, 0.9, 0.17], half: [0.36, 0.13, 0.17], tint: WHEEL_TINT },
  { center: [-1.35, -0.9, 0.17], half: [0.36, 0.13, 0.17], tint: WHEEL_TINT },
];

const BOX_FACES: Array<{ normal: [number, number, number]; corners: Point2Triple[] }> = [
  { normal: [1, 0, 0], corners: [[1, -1, -1], [1, 1, -1], [1, 1, 1], [1, -1, 1]] },
  { normal: [-1, 0, 0], corners: [[-1, 1, -1], [-1, -1, -1], [-1, -1, 1], [-1, 1, 1]] },
  { normal: [0, 1, 0], corners: [[1, 1, -1], [-1, 1, -1], [-1, 1, 1], [1, 1, 1]] },
  { normal: [0, -1, 0], corners: [[-1, -1, -1], [1, -1, -1], [1, -1, 1], [-1, -1, 1]] },
  { normal: [0, 0, 1], corners: [[1, -1, 1], [1, 1, 1], [-1, 1, 1], [-1, -1, 1]] },
  { normal: [0, 0, -1], corners: [[-1, -1, -1], [-1, 1, -1], [1, 1, -1], [1, -1, -1]] },
];
export type Point2Triple = [number, number, number];

export class MeshBuilder {
  readonly positions: number[] = [];
  readonly normals: number[] = [];
  readonly colors: number[] = [];
  readonly indices: number[] = [];

  private vertex(p: Point2Triple, n: Point2Triple, tint: number): number {
    const index = this.positions.length / 3;
    this.positions.push(...p);
    this.normals.push(...n);
    // Float 0-1, size 3, matching the shader's `in vec3 colors` exactly
    // (float32x3). Bytes are a trap here twice over: luma.gl has no `unorm8x3`
    // format so a size-3 Uint8Array fails layer init outright, and a size-4 one
    // arrives un-normalised as 0-255, which the shader's
    // `colors * instanceColors.rgb` multiply blows straight past white.
    const c = Math.max(0, Math.min(1, tint));
    this.colors.push(c, c, c);
    return index;
  }

  /** Flat-shaded quad — its own four vertices, so edges stay hard. */
  quad(a: Point2Triple, b: Point2Triple, c: Point2Triple, d: Point2Triple, n: Point2Triple, tint: number): void {
    const i0 = this.vertex(a, n, tint);
    const i1 = this.vertex(b, n, tint);
    const i2 = this.vertex(c, n, tint);
    const i3 = this.vertex(d, n, tint);
    this.indices.push(i0, i1, i2, i0, i2, i3);
  }

  /** Extrudes a convex plan outline into a prism with flat caps. */
  extrude(outline: Point2[], [z0, z1]: [number, number], tint: number): void {
    const n = outline.length;

    for (let i = 0; i < n; i++) {
      const [x0, y0] = outline[i]!;
      const [x1, y1] = outline[(i + 1) % n]!;
      // Outward normal of this wall: the edge direction rotated -90°. The
      // outline is counter-clockwise, so this points away from the interior.
      const ex = x1 - x0;
      const ey = y1 - y0;
      const len = Math.hypot(ex, ey) || 1;
      const normal: Point2Triple = [ey / len, -ex / len, 0];
      this.quad([x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z1], normal, tint);
    }

    // Caps as triangle fans from vertex 0 — valid because both outlines are
    // convex, which is also why extrude() is not a general-purpose helper.
    const topStart = this.positions.length / 3;
    for (const [x, y] of outline) this.vertex([x, y, z1], [0, 0, 1], tint);
    for (let i = 1; i < n - 1; i++) this.indices.push(topStart, topStart + i, topStart + i + 1);

    const botStart = this.positions.length / 3;
    for (const [x, y] of outline) this.vertex([x, y, z0], [0, 0, -1], tint);
    for (let i = 1; i < n - 1; i++) this.indices.push(botStart, botStart + i + 1, botStart + i);
  }

  box({ center, half, tint }: Box): void {
    for (const face of BOX_FACES) {
      const corners = face.corners.map(
        ([sx, sy, sz]) =>
          [center[0] + sx * half[0], center[1] + sy * half[1], center[2] + sz * half[2]] as Point2Triple,
      );
      this.quad(corners[0]!, corners[1]!, corners[2]!, corners[3]!, face.normal, tint);
    }
  }
}

/** Packs a finished builder into the attribute layout deck.gl wants. Shared
 * with bike-mesh.ts — the two vehicle meshes differ in shape, not in format. */
export function toMeshData(b: MeshBuilder): CarMeshData {
  return {
    attributes: {
      POSITION: { value: new Float32Array(b.positions), size: 3 },
      NORMAL: { value: new Float32Array(b.normals), size: 3 },
      COLOR_0: { value: new Float32Array(b.colors), size: 3 },
    },
    indices: { value: new Uint16Array(b.indices), size: 1 },
  };
}

export function buildCarMesh(): CarMeshData {
  const b = new MeshBuilder();
  b.extrude(BODY_OUTLINE, BODY_Z, BODY_TINT);
  b.extrude(CABIN_OUTLINE, CABIN_Z, CABIN_TINT);
  for (const wheel of WHEELS) b.box(wheel);
  return toMeshData(b);
}
