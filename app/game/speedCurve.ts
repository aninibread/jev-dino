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

/** Multiply min gaps: smaller = denser obstacles. Keep early race roomy. */
export function gapShrink(elapsedMs: number): number {
  const t = Math.min(elapsedMs / 1000, 60);
  if (t < 8) return 1.15;
  if (t < 20) return 1 - ((t - 8) / 12) * 0.25; // → 0.9
  return Math.max(0.4, 0.9 - (t - 20) / 80);
}

/** Cap cactus cluster size early so the opening is learnable. */
export function maxObstacleSize(elapsedMs: number, speed: number): number {
  const t = elapsedMs / 1000;
  if (t < 6) return 1;
  if (t < 15 || speed < 8) return 2;
  return 3;
}
