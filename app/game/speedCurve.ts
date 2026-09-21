/** Aggressive speed multiplier over a 60s race. Humans should usually lose late. */
export function speedMultiplier(elapsedMs: number): number {
  const t = Math.min(Math.max(elapsedMs, 0) / 1000, 60);
  // Piecewise ease: playable early, brutal late.
  if (t < 10) return 1 + (t / 10) * 0.8; // → 1.8
  if (t < 20) return 1.8 + ((t - 10) / 10) * 0.8; // → 2.6
  if (t < 30) return 2.6 + ((t - 20) / 10) * 0.9; // → 3.5
  if (t < 45) return 3.5 + ((t - 30) / 15) * 1.5; // → 5.0
  return 5 + ((t - 45) / 15) * 2.5; // → 7.5 at 60s
}

export function gapShrink(elapsedMs: number): number {
  const t = Math.min(elapsedMs / 1000, 60);
  // Multiply min gaps: smaller = denser obstacles
  return Math.max(0.35, 1 - t / 90);
}
