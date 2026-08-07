/** Shared formatting/DOM-building helpers used by multiple render modules
 * (previously duplicated in hud.ts and race-controls.ts — see R2). */

export function formatElapsed(simSeconds: number): string {
  const h = Math.floor(simSeconds / 3600);
  const m = Math.floor((simSeconds % 3600) / 60);
  const s = Math.floor(simSeconds % 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function formatDistance(metres: number): string {
  // Magnitude, not the raw value, picks the unit: a negative distance (the
  // leaderboard's signed gap can produce one) would otherwise always take the
  // metres branch and render as "-1500 m" instead of "-1.5 km".
  if (Math.abs(metres) < 1000) return `${metres.toFixed(0)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/** The colour-dot span used next to a car's name in the leaderboard, finish
 * board, and config panel car list. Built via createElement/textContent —
 * never innerHTML — since callers may be interpolating external strings
 * alongside it. */
export function carDot(colour: string): HTMLSpanElement {
  const dot = document.createElement('span');
  dot.className = 'car-dot';
  dot.style.background = colour;
  return dot;
}
