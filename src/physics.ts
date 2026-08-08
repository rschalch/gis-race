import type { CarSpec } from './types';
import {
  G,
  RHO_SEA_LEVEL,
  AIR_DENSITY_SCALE_HEIGHT_M,
  SURFACE_CRR_PER_GRIP_LOSS,
  ENGINE_LOAD_NEUTRAL,
  ENGINE_HEAT_POWER_FADE,
  DRIVELINE_LOSS_MAX,
  DRIVELINE_LOSS_FADE_SPEED,
  DRIVELINE_LOSS_VMAX_FRACTION,
} from './tuning';

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
  surface?: number; // R17: per-point surface grip value on its own (not folded into gripMultiplier), for rolling resistance; default 1 (asphalt)
  engineLoad?: number; // R15b: smoothed engine load (CarState.engineLoad) — heat derates power above ENGINE_LOAD_NEUTRAL; default 0 (fresh)
  brakeFade?: number; // R19: usable-braking multiplier (driver.ts brakeFadeFactor) — hot pads deliver less force for the same pedal; default 1 (cold)
  windAlong?: number; // R16: tailwind component along the road here, m/s (negative = headwind); default 0 (calm)
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
  surface = 1,
  engineLoad = 0,
  brakeFade = 1,
  windAlong = 0,
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
  // R15b: heat-soaked engines pull power (protective derate), using the same
  // stress fraction the reliability hazard reads — see ENGINE_HEAT_POWER_FADE.
  const heatStress = Math.max(0, engineLoad - ENGINE_LOAD_NEUTRAL) / (1 - ENGINE_LOAD_NEUTRAL);
  const heatFactor = 1 - ENGINE_HEAT_POWER_FADE * heatStress;
  const effectivePower = (induction === 'na' ? P * altitudeFactor : P) * heatFactor;

  // muLong caps use the grade-corrected normal load (m·G·cos(grade)), matching
  // the speed profile's backward pass (driver.ts) so traction/braking
  // feasibility agree between planning and runtime. gripMultiplier (R7
  // weather, R8 surface) derates the same effective muLong the plan uses —
  // see driver.ts's computeSpeedProfileUncached and driverControl.
  const muLongEff = muLong * gripMultiplier;
  const normalLoad = m * G * Math.cos(grade);
  // M1: pitch-over ceiling — a motorcycle lifts a wheel before it slides one,
  // in both directions (wheelie under power, stoppie under brakes). Note this
  // is a force ceiling from *geometry*, so unlike the traction term it does
  // not scale with gripMultiplier: a wet road does not make a bike wheelie at
  // a lower acceleration, it just runs out of grip first instead. `Infinity`
  // for cars, which makes both Math.min calls below exact no-ops.
  const pitchCap = spec.pitchLimitG * m * G;
  // R14: constant torque (force = P/peakPowerSpeed) below peakPowerSpeed,
  // constant power (force = P/v) above it — a per-gear approximation.
  // peakPowerSpeed defaults to 5, reproducing the pre-R14 hardcoded floor.
  // R18: the power term is derated by a speed-tapered driveline loss (clutch
  // slip, shift interruptions, per-gear torque dips) — zero again by the
  // taper end, so top-speed equilibrium is untouched. Traction- and
  // pitch-limited launches never feel it: their cap already binds below the
  // power term. See DRIVELINE_LOSS_MAX in tuning.ts for the calibration.
  const fadeEnd = Math.min(DRIVELINE_LOSS_FADE_SPEED, DRIVELINE_LOSS_VMAX_FRACTION * spec.vMax);
  const drivelineEff = 1 - DRIVELINE_LOSS_MAX * Math.max(0, 1 - v / fadeEnd);
  const fTraction =
    throttle *
    Math.min((drivelineEff * effectivePower) / Math.max(v, peakPowerSpeed), muLongEff * normalLoad, pitchCap);
  // R16: drag works on airspeed, not ground speed — a headwind raises it, a
  // tailwind lowers it. Signed (vAir·|vAir|): a tailwind faster than the car
  // genuinely pushes, though at racing speeds vAir is effectively always
  // positive.
  const vAir = v - windAlong;
  const fDrag = 0.5 * rho * cdA * conditionCdA * vAir * Math.abs(vAir) * dragFactor;
  // R17: loose surface roughly doubles rolling resistance as well as cutting
  // grip — same per-point value, second physical effect.
  const fRoll = crr * (1 + SURFACE_CRR_PER_GRIP_LOSS * (1 - surface)) * normalLoad;
  const fGrade = m * G * Math.sin(grade);
  // R19: fade scales what the system can deliver for a given pedal command —
  // the same factor the controller's aCap used, so planning and physics agree.
  const fBrake = brake * Math.min(muLongEff * normalLoad, pitchCap) * brakeFade;

  return {
    a: (fTraction - fBrake - fDrag - fRoll - fGrade) / m,
    aTire: (fTraction - fBrake) / m,
  };
}
