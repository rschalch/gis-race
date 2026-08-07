/**
 * Converts a glTF/GLB vehicle model into the flat attribute set the renderer
 * draws (`public/models/*.mesh`), run via `npm run bake-meshes`.
 *
 * See `assets/vehicles/README.md` for why the models are baked rather than
 * loaded at runtime. The short version: deck.gl's SimpleMeshLayer wants one
 * mesh, our vehicles want a per-car livery colour, and glTF gives neither —
 * it gives a scene graph of separately-transformed nodes painted from a shared
 * texture atlas. This flattens the first and converts the second into
 * per-vertex brightness, which is what the layer multiplies the livery by.
 *
 * Node-only (fs, zlib). Nothing here ships to the browser.
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';

// --- glTF reading ----------------------------------------------------------

interface Gltf {
  scenes?: Array<{ nodes?: number[] }>;
  scene?: number;
  nodes: Array<{
    name?: string;
    mesh?: number;
    children?: number[];
    matrix?: number[];
    translation?: number[];
    rotation?: number[];
    scale?: number[];
  }>;
  meshes: Array<{ name?: string; primitives: GltfPrimitive[] }>;
  materials?: Array<{
    name?: string;
    pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: { index: number } };
  }>;
  textures?: Array<{ source?: number }>;
  images?: Array<{ uri?: string }>;
  accessors: Array<{ bufferView: number; componentType: number; count: number; type: string; byteOffset?: number }>;
  bufferViews: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
}

interface GltfPrimitive {
  attributes: Record<string, number>;
  indices?: number;
  material?: number;
}

function parseGlb(file: string): { gltf: Gltf; bin: Buffer } {
  const data = readFileSync(file);
  const magic = data.readUInt32LE(0);
  if (magic !== 0x46546c67) throw new Error(`${file}: not a GLB (bad magic)`);
  const total = data.readUInt32LE(8);

  let offset = 12;
  let json: Gltf | null = null;
  let bin = Buffer.alloc(0);
  while (offset < total) {
    const length = data.readUInt32LE(offset);
    const type = data.readUInt32LE(offset + 4);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 0x4e4f534a) json = JSON.parse(body.toString('utf8')) as Gltf;
    else if (type === 0x004e4942) bin = body;
    offset += 8 + length;
  }
  if (!json) throw new Error(`${file}: no JSON chunk`);
  return { gltf: json, bin };
}

const COMPONENT_SIZE: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 };
const TYPE_COUNT: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Reads an accessor into a flat number[]. Handles interleaved byteStride,
 * which Kenney's exporter uses for some attributes. */
function readAccessor(gltf: Gltf, bin: Buffer, index: number): number[] {
  const accessor = gltf.accessors[index]!;
  const view = gltf.bufferViews[accessor.bufferView]!;
  const componentSize = COMPONENT_SIZE[accessor.componentType]!;
  const components = TYPE_COUNT[accessor.type]!;
  const stride = view.byteStride && view.byteStride > 0 ? view.byteStride : componentSize * components;
  const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);

  const out: number[] = [];
  for (let i = 0; i < accessor.count; i++) {
    for (let c = 0; c < components; c++) {
      const at = base + i * stride + c * componentSize;
      switch (accessor.componentType) {
        case 5126: out.push(bin.readFloatLE(at)); break;
        case 5125: out.push(bin.readUInt32LE(at)); break;
        case 5123: out.push(bin.readUInt16LE(at)); break;
        case 5121: out.push(bin.readUInt8(at)); break;
        case 5122: out.push(bin.readInt16LE(at)); break;
        case 5120: out.push(bin.readInt8(at)); break;
        default: throw new Error(`unsupported componentType ${accessor.componentType}`);
      }
    }
  }
  return out;
}

// --- PNG reading (8-bit RGB/RGBA, non-interlaced) --------------------------
//
// Only what these textures actually are. Anything else throws rather than
// silently sampling garbage — a wrong colour here becomes a wrong brightness
// on every car, which is exactly the kind of thing that looks "a bit off" and
// takes an hour to trace.

interface Image {
  width: number;
  height: number;
  channels: number;
  data: Buffer;
}

function decodePng(file: string): Image {
  const data = readFileSync(file);
  if (data.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file}: not a PNG`);

  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colourType = 0;
  const idat: Buffer[] = [];
  while (offset < data.length) {
    const length = data.readUInt32BE(offset);
    const type = data.toString('ascii', offset + 4, offset + 8);
    const body = data.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8]!;
      colourType = body[9]!;
      if (body[12] !== 0) throw new Error(`${file}: interlaced PNGs unsupported`);
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colourType !== 2 && colourType !== 6)) {
    throw new Error(`${file}: only 8-bit RGB/RGBA supported (got depth ${bitDepth}, type ${colourType})`);
  }

  const channels = colourType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);

  // Undo the per-scanline filters (PNG spec §9.2).
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? out[y * stride + x - channels]! : 0; // left
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0; // above
      const c = x >= channels && y > 0 ? out[(y - 1) * stride + x - channels]! : 0; // upper-left
      let value = line[x]!;
      switch (filter) {
        case 0: break;
        case 1: value += a; break;
        case 2: value += b; break;
        case 3: value += (a + b) >> 1; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          value += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          break;
        }
        default: throw new Error(`${file}: unknown PNG filter ${filter}`);
      }
      out[y * stride + x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function sample(image: Image, u: number, v: number): [number, number, number] {
  // Nearest neighbour, and deliberately so: these are palette atlases of flat
  // colour blocks, and bilinear filtering across a block boundary would invent
  // a colour that belongs to neither part.
  const x = Math.min(image.width - 1, Math.max(0, Math.round(u * (image.width - 1))));
  // V is flipped. glTF puts the UV origin top-left and PNG rows run top-down,
  // so the unflipped read looks correct on paper — but it samples the atlas's
  // grey band for every vertex on the model, which is how it was caught:
  // sampling without the flip gave rgb(54,54,58) for 804 of the body's
  // vertices, and with it gives rgb(252,225,194) — the cream paint, plus the
  // oranges and greens the rest of the kit is painted from.
  const y = Math.min(image.height - 1, Math.max(0, Math.round((1 - v) * (image.height - 1))));
  const at = (y * image.width + x) * image.channels;
  return [image.data[at]! / 255, image.data[at + 1]! / 255, image.data[at + 2]! / 255];
}

// --- scene flattening ------------------------------------------------------

type Mat4 = number[];

function identity(): Mat4 {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += a[k * 4 + r]! * b[c * 4 + k]!;
      out[c * 4 + r] = sum;
    }
  }
  return out;
}

/** Column-major TRS composition, matching glTF's own convention. */
function nodeMatrix(node: Gltf['nodes'][number]): Mat4 {
  if (node.matrix) return node.matrix;
  const [tx, ty, tz] = node.translation ?? [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];

  const x2 = qx! + qx!;
  const y2 = qy! + qy!;
  const z2 = qz! + qz!;
  const xx = qx! * x2;
  const xy = qx! * y2;
  const xz = qx! * z2;
  const yy = qy! * y2;
  const yz = qy! * z2;
  const zz = qz! * z2;
  const wx = qw! * x2;
  const wy = qw! * y2;
  const wz = qw! * z2;

  return [
    (1 - (yy + zz)) * sx!, (xy + wz) * sx!, (xz - wy) * sx!, 0,
    (xy - wz) * sy!, (1 - (xx + zz)) * sy!, (yz + wx) * sy!, 0,
    (xz + wy) * sz!, (yz - wx) * sz!, (1 - (xx + yy)) * sz!, 0,
    tx!, ty!, tz!, 1,
  ];
}

function transformPoint(m: Mat4, p: [number, number, number]): [number, number, number] {
  return [
    m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
    m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
    m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
  ];
}

/** Normals ignore translation; non-uniform scale is absent from these models,
 * so the rotation part is enough (no inverse-transpose needed). */
function transformDirection(m: Mat4, d: [number, number, number]): [number, number, number] {
  const out: [number, number, number] = [
    m[0]! * d[0] + m[4]! * d[1] + m[8]! * d[2],
    m[1]! * d[0] + m[5]! * d[1] + m[9]! * d[2],
    m[2]! * d[0] + m[6]! * d[1] + m[10]! * d[2],
  ];
  const length = Math.hypot(...out) || 1;
  return [out[0] / length, out[1] / length, out[2] / length];
}

interface Baked {
  positions: number[];
  normals: number[];
  colours: number[];
  indices: number[];
}

function flatten(gltf: Gltf, bin: Buffer, texture: Image | null): Baked {
  const out: Baked = { positions: [], normals: [], colours: [], indices: [] };

  const walk = (nodeIndex: number, parent: Mat4): void => {
    const node = gltf.nodes[nodeIndex]!;
    const world = multiply(parent, nodeMatrix(node));

    if (node.mesh !== undefined) {
      for (const primitive of gltf.meshes[node.mesh]!.primitives) {
        const positions = readAccessor(gltf, bin, primitive.attributes.POSITION!);
        const normals = primitive.attributes.NORMAL !== undefined
          ? readAccessor(gltf, bin, primitive.attributes.NORMAL)
          : null;
        const uvs = primitive.attributes.TEXCOORD_0 !== undefined
          ? readAccessor(gltf, bin, primitive.attributes.TEXCOORD_0)
          : null;
        const material = primitive.material !== undefined ? gltf.materials?.[primitive.material] : undefined;
        const factor = material?.pbrMetallicRoughness?.baseColorFactor;
        const textured = Boolean(material?.pbrMetallicRoughness?.baseColorTexture) && texture !== null;

        const base = out.positions.length / 3;
        const count = positions.length / 3;
        for (let i = 0; i < count; i++) {
          const p = transformPoint(world, [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!]);
          out.positions.push(p[0], p[1], p[2]);

          const n = normals
            ? transformDirection(world, [normals[i * 3]!, normals[i * 3 + 1]!, normals[i * 3 + 2]!])
            : ([0, 1, 0] as [number, number, number]);
          out.normals.push(n[0], n[1], n[2]);

          // The model's own colour, from whichever place it lives.
          let rgb: [number, number, number] = [1, 1, 1];
          if (textured && uvs) rgb = sample(texture!, uvs[i * 2]!, uvs[i * 2 + 1]!);
          else if (factor) rgb = [factor[0]!, factor[1]!, factor[2]!];
          out.colours.push(rgb[0], rgb[1], rgb[2]);
        }

        const indices = primitive.indices !== undefined
          ? readAccessor(gltf, bin, primitive.indices)
          : Array.from({ length: count }, (_, i) => i);
        for (const i of indices) out.indices.push(base + i);
      }
    }

    for (const child of node.children ?? []) walk(child, world);
  };

  const scene = gltf.scenes?.[gltf.scene ?? 0];
  const roots = scene?.nodes ?? gltf.nodes.map((_, i) => i);
  for (const root of roots) walk(root, identity());
  return out;
}

// --- livery conversion, orientation, scale ---------------------------------

/**
 * Turns the model's own colours into livery multipliers.
 *
 * COLOR_0 is multiplied by the per-instance colour in the shader, so what is
 * wanted is *relative brightness*, not hue: the body should come through as
 * the car's own colour (multiplier 1) and everything darker than it — glass,
 * tyres, grille — should stay proportionally darker. Perceptual luminance
 * weights, then normalised so the *bodywork* lands at 1.
 *
 * Normalising against the single brightest vertex is the obvious version and
 * it is wrong: the motorcycle's brightest surface is a ten-vertex yellow
 * headlamp, which pushed the entire machine to roughly half brightness and
 * rendered every bike on the grid muddy. A high percentile of the
 * vertex-weighted distribution ignores small bright details while still
 * landing on the largest bright surface, which is what bodywork is.
 *
 * The floor matters too: a pure black tyre in the source would otherwise
 * multiply to invisible, and at these sizes a car with no visible wheels reads
 * as a floating wedge.
 */
const MIN_TINT = 0.12;
/** A colour has to cover at least this share of the model's vertices to count
 * as a surface rather than a detail. */
const BODY_MIN_SHARE = 0.15;

function toLiveryTints(colours: number[]): number[] {
  const luminance: number[] = [];
  for (let i = 0; i < colours.length; i += 3) {
    luminance.push(0.2126 * colours[i]! + 0.7152 * colours[i + 1]! + 0.0722 * colours[i + 2]!);
  }

  // Bucket by luminance and keep only the big surfaces, then take the
  // brightest of those as "bodywork". Both halves of that rule are load-
  // bearing, and each was learned from a model that broke the other:
  //
  //   - brightest overall  → the motorcycle's ten-vertex yellow headlamp wins,
  //                          and every bike renders at half brightness;
  //   - largest overall    → the car's dark window glass and tyres outvote its
  //                          paint, and every car renders blown out.
  const buckets = new Map<string, { luminance: number; count: number }>();
  for (const l of luminance) {
    const key = l.toFixed(2);
    const bucket = buckets.get(key);
    if (bucket) bucket.count += 1;
    else buckets.set(key, { luminance: l, count: 1 });
  }
  const surfaces = [...buckets.values()].filter((b) => b.count >= luminance.length * BODY_MIN_SHARE);
  const reference = Math.max(
    surfaces.length > 0 ? Math.max(...surfaces.map((b) => b.luminance)) : Math.max(...luminance),
    1e-6,
  );

  const out: number[] = [];
  for (const l of luminance) {
    const tint = Math.max(MIN_TINT, Math.min(1, l / reference));
    out.push(tint, tint, tint);
  }
  return out;
}

export interface BakeOptions {
  /** Metres, nose to tail, after reorientation. */
  targetLength: number;
  /**
   * Which source axis is up, and which way the vehicle faces. glTF is
   * Y-up by convention but "forward" is whatever the modeller chose, so it is
   * stated per model rather than guessed — the wheels-forward test that would
   * infer it only works on models with named wheel nodes.
   */
  up: 'y' | 'z';
  forward: '+x' | '-x' | '+z' | '-z';
}

/**
 * Reorients into the renderer's convention (+X forward, +Y left, +Z up, metres,
 * sitting on z = 0) and scales to a true-to-life length.
 */
function orient(baked: Baked, options: BakeOptions): void {
  const remap = (v: [number, number, number]): [number, number, number] => {
    // First bring the model into Z-up.
    const [x, y, z] = options.up === 'y' ? [v[0], -v[2], v[1]] : [v[0], v[1], v[2]];
    // Then rotate about Z so the nose points +X.
    switch (options.forward) {
      case '+x': return [x!, y!, z!];
      case '-x': return [-x!, -y!, z!];
      // After the up-swap a model facing source +Z faces intermediate -Y, and
      // one facing source -Z faces +Y. Rotating each onto +X is therefore a
      // quarter turn in opposite directions. (These two were swapped on the
      // first pass, which pointed every car backwards down the road — the
      // wheel-node translations in the source glTF are what caught it.)
      case '+z': return [-y!, x!, z!];
      case '-z': return [y!, -x!, z!];
    }
  };

  for (let i = 0; i < baked.positions.length; i += 3) {
    const p = remap([baked.positions[i]!, baked.positions[i + 1]!, baked.positions[i + 2]!]);
    baked.positions[i] = p[0];
    baked.positions[i + 1] = p[1];
    baked.positions[i + 2] = p[2];
    const n = remap([baked.normals[i]!, baked.normals[i + 1]!, baked.normals[i + 2]!]);
    baked.normals[i] = n[0];
    baked.normals[i + 1] = n[1];
    baked.normals[i + 2] = n[2];
  }

  // Scale to the target length and drop it onto the ground plane, centred
  // left-to-right and front-to-back so rotation happens about the vehicle.
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity;
  for (let i = 0; i < baked.positions.length; i += 3) {
    minX = Math.min(minX, baked.positions[i]!);
    maxX = Math.max(maxX, baked.positions[i]!);
    minY = Math.min(minY, baked.positions[i + 1]!);
    maxY = Math.max(maxY, baked.positions[i + 1]!);
    minZ = Math.min(minZ, baked.positions[i + 2]!);
  }
  const scale = options.targetLength / (maxX - minX);
  const centreX = (minX + maxX) / 2;
  const centreY = (minY + maxY) / 2;
  for (let i = 0; i < baked.positions.length; i += 3) {
    baked.positions[i] = (baked.positions[i]! - centreX) * scale;
    baked.positions[i + 1] = (baked.positions[i + 1]! - centreY) * scale;
    baked.positions[i + 2] = (baked.positions[i + 2]! - minZ) * scale;
  }
}

// --- output ----------------------------------------------------------------
//
// A flat binary rather than JSON: the browser turns it into Float32Arrays with
// no parsing at all, and JSON of the same data is roughly four times the size
// and has to be walked number by number.
//
//   magic 'GRMESH1' (8 bytes, NUL-padded) | u32 vertexCount | u32 indexCount
//   f32 positions[3n] | f32 normals[3n] | f32 colours[3n] | u32 indices[m]

const MAGIC = 'GRMESH1\0';

function write(file: string, baked: Baked): void {
  const vertices = baked.positions.length / 3;
  const header = Buffer.alloc(16);
  header.write(MAGIC, 0, 'ascii');
  header.writeUInt32LE(vertices, 8);
  header.writeUInt32LE(baked.indices.length, 12);

  const floats = new Float32Array([...baked.positions, ...baked.normals, ...baked.colours]);
  const indices = new Uint32Array(baked.indices);

  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, Buffer.concat([header, Buffer.from(floats.buffer), Buffer.from(indices.buffer)]));

  const extent = (offset: number) => {
    let lo = Infinity;
    let hi = -Infinity;
    for (let i = offset; i < baked.positions.length; i += 3) {
      lo = Math.min(lo, baked.positions[i]!);
      hi = Math.max(hi, baked.positions[i]!);
    }
    return (hi - lo).toFixed(2);
  };
  console.log(
    `${path.basename(file)}: ${vertices} vertices, ${baked.indices.length / 3} triangles, ` +
      `${(header.length + floats.byteLength + indices.byteLength) / 1024 | 0} KB — ` +
      `${extent(0)} x ${extent(1)} x ${extent(2)} m`,
  );
}

// --- the models ------------------------------------------------------------

const ROOT = process.cwd();
const SOURCES: Array<{ glb: string; texture?: string; out: string; options: BakeOptions }> = [
  {
    // Kenney's Car Kit is modelled Y-up facing +Z — read off the source's own
    // node names, whose front wheels sit at +0.66 z and rear at -0.66.
    glb: 'assets/vehicles/car-sedan-sports.glb',
    texture: 'assets/vehicles/car-colormap.png',
    out: 'public/models/car.mesh',
    options: { targetLength: 4.2, up: 'y', forward: '+z' },
  },
  {
    glb: 'assets/vehicles/motorcycle.glb',
    out: 'public/models/motorcycle.mesh',
    options: { targetLength: 2.1, up: 'y', forward: '-z' },
  },
];

for (const source of SOURCES) {
  const { gltf, bin } = parseGlb(path.join(ROOT, source.glb));
  const texture = source.texture ? decodePng(path.join(ROOT, source.texture)) : null;
  const baked = flatten(gltf, bin, texture);
  baked.colours = toLiveryTints(baked.colours);
  orient(baked, source.options);
  write(path.join(ROOT, source.out), baked);
}
