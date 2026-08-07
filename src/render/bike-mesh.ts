/**
 * A low-poly motorcycle, generated the same way car-mesh.ts generates the car
 * — same builder, same axes (+X forward, +Y left, +Z up, metres), same rule
 * that every part must differ in tone because COLOR_0 multiplies the livery.
 *
 * Three things about a bike make it a different modelling problem from a car,
 * all learned from looking at it on the map:
 *
 * 1. **It is nearly invisible in plan.** A car is a 1.8 m-wide slab; a bike is
 *    a 0.3 m-wide blade. Seen from overhead it would be a scratch. What gives
 *    it a readable silhouette is the *rider* — shoulders and helmet are the
 *    widest, tallest part of the whole machine, so they are modelled rather
 *    than skipped, and the handlebars are widened to roughly real width to put
 *    something recognisable across the direction of travel.
 * 2. **It leans, and this model cannot.** The simulation is one-dimensional;
 *    there is no lean angle to draw. The mesh is built upright, which is the
 *    honest choice — a permanently-leaning bike would look wrong on a straight
 *    for exactly as long as it looked right in a corner.
 * 3. **Wheels are a much bigger fraction of it.** On a car they are trim; on a
 *    bike they are most of the side profile, so they are drawn at true
 *    relative size (~0.62 m diameter against a 2.1 m machine).
 *
 * Scale is deliberately shared with the car (see cars-3d.ts): both meshes are
 * modelled at true metres and drawn with the same size multiplier, so a bike
 * renders about half the length of a car on screen — which is the truth.
 */

import { MeshBuilder, toMeshData, type Box, type CarMeshData, type Point2 } from './car-mesh';

/** Nose-to-tail length of this mesh, in metres — cars-3d.ts uses it to keep
 * the two vehicle types in proportion to one another. */
export const BIKE_LENGTH_M = 2.1;

/** Fairing/tank/tail, tapered in plan so the nose reads as the front. Narrow:
 * a real sportbike is ~0.35 m across the fairing. */
const BODY_OUTLINE: Point2[] = [
  [1.05, 0.1],
  [0.72, 0.19],
  [-0.35, 0.18],
  [-0.95, 0.11],
  [-0.95, -0.11],
  [-0.35, -0.18],
  [0.72, -0.19],
  [1.05, -0.1],
];

/** The rider: the widest and tallest part of the machine, and the reason the
 * thing is visible from above at all. Shoulders forward of the hips, as a
 * rider sits — which also gives the plan view a direction. */
const RIDER_OUTLINE: Point2[] = [
  [0.34, 0.14],
  [0.16, 0.26],
  [-0.3, 0.24],
  [-0.46, 0.13],
  [-0.46, -0.13],
  [-0.3, -0.24],
  [0.16, -0.26],
  [0.34, -0.14],
];

const BODY_Z: [number, number] = [0.42, 0.78];
const RIDER_Z: [number, number] = [0.78, 1.28];

// Multipliers on the vehicle's livery colour (they cannot brighten, only
// darken — see car-mesh.ts).
const BODY_TINT = 1.0;
const RIDER_TINT = 0.28; // leathers and helmet — dark, like the car's glass
const WHEEL_TINT = 0.1; // near-black
const BAR_TINT = 0.45;

const PARTS: Box[] = [
  // Wheels — thin, tall, and most of the side profile. 0.62 m diameter.
  { center: [0.78, 0, 0.31], half: [0.31, 0.055, 0.31], tint: WHEEL_TINT },
  { center: [-0.72, 0, 0.31], half: [0.31, 0.075, 0.31], tint: WHEEL_TINT },
  // Handlebars: the one crosswise line on the whole machine, and what stops a
  // bike reading as a stray dash from directly overhead.
  { center: [0.42, 0, 0.86], half: [0.05, 0.36, 0.035], tint: BAR_TINT },
  // Engine/exhaust block slung under the tank, filling the gap between wheels.
  { center: [0.05, 0, 0.34], half: [0.36, 0.13, 0.14], tint: BAR_TINT },
  // Screen/nose, forward and low — reads as the front from a chase camera.
  { center: [0.95, 0, 0.8], half: [0.14, 0.11, 0.09], tint: RIDER_TINT },
];

export function buildMotorcycleMesh(): CarMeshData {
  const b = new MeshBuilder();
  b.extrude(BODY_OUTLINE, BODY_Z, BODY_TINT);
  b.extrude(RIDER_OUTLINE, RIDER_Z, RIDER_TINT);
  for (const part of PARTS) b.box(part);
  return toMeshData(b);
}
