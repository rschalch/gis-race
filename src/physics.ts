import type { CarSpec } from './types';
import { G, RHO_SEA_LEVEL, AIR_DENSITY_SCALE_HEIGHT_M } from './tuning';

export interface ForceInputs {
  spec: CarSpec;
  v: number;
  grade: number;
  throttle: number;
  brake: number;
  dragFactor?: number; // R4: slipstream aero-drag multiplier, default 1 (no draft)
  gripMultiplier?: number; // R7/R8/R11/R12: weather × surface × condition grip scalar, default 1 (dry asphalt, undamaged)
  ele?: number; // R9: metres above sea level, for air density; default 0 (sea level)
  conditionCdA?: number; // R12: permanent post-spin drag multiplier, default 1 (undamaged)
}

export interface AccelerationResult {
  a: number; // m/s² — net acceleration from all forces, for the §6.2 integrator
  aTire: number; // m/s² — traction/brake only, excluding drag/roll/grade; for §7.5's friction circle
}

/** §6.1: longitudinal force model. */
export function computeAcceleration({
  spec,
  v,
  grade,
  throttle,
  brake,
  dragFactor = 1,
  gripMultiplier = 1,
  ele = 0,
  conditionCdA = 1,
}: ForceInputs): AccelerationResult {
  const { mass: m, power: P, cdA, crr, muLong, induction, peakPowerSpeed } = spec;

  // R9: elevation-dependent air density — thinner air both reduces drag and
  // (for a naturally-aspirated engine only; a turbo's compressor largely
  // corrects for it, so `induction: 'forced'` — the default — skips this)
  // reduces peak power roughly in proportion to density. This only affects
  // the runtime drag/power terms, not the speed profile: the profile is
  // grip/brake-limited (driver.ts's computeSpeedProfileUncached never reads
  // power or drag), so no cache-key change is needed for it.
  const altitudeFactor = Math.exp(-ele / AIR_DENSITY_SCALE_HEIGHT_M);
  const rho = RHO_SEA_LEVEL * altitudeFactor;
  const effectivePower = induction === 'na' ? P * altitudeFactor : P;

  // muLong caps use the grade-corrected normal load (m·G·cos(grade)), matching
  // the speed profile's backward pass (driver.ts) so traction/braking
  // feasibility agree between planning and runtime. gripMultiplier (R7
  // weather, R8 surface) derates the same effective muLong the plan uses —
  // see driver.ts's computeSpeedProfileUncached and driverControl.
  const muLongEff = muLong * gripMultiplier;
  const normalLoad = m * G * Math.cos(grade);
  // R14: constant torque (force = P/peakPowerSpeed) below peakPowerSpeed,
  // constant power (force = P/v) above it — a per-gear approximation.
  // peakPowerSpeed defaults to 5, reproducing the pre-R14 hardcoded floor.
  const fTraction = throttle * Math.min(effectivePower / Math.max(v, peakPowerSpeed), muLongEff * normalLoad);
  const fDrag = 0.5 * rho * cdA * conditionCdA * v * v * dragFactor;
  const fRoll = crr * normalLoad;
  const fGrade = m * G * Math.sin(grade);
  const fBrake = brake * muLongEff * normalLoad;

  return {
    a: (fTraction - fBrake - fDrag - fRoll - fGrade) / m,
    aTire: (fTraction - fBrake) / m,
  };
}
