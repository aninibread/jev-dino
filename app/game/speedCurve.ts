/** Aggressive speed multiplier over a 60s race. Hard late, but still physically clearable. */
export function speedMultiplier(elapsedMs: number): number {
  const t = Math.min(Math.max(elapsedMs, 0) / 1000, 60);
  // Piecewise ease: learnable early, tough late — capped so gaps stay feasible.
  if (t < 10) return 1 + (t / 10) * 0.7; // → 1.7
  if (t < 20) return 1.7 + ((t - 10) / 10) * 0.7; // → 2.4
  if (t < 30) return 2.4 + ((t - 20) / 10) * 0.8; // → 3.2
  if (t < 45) return 3.2 + ((t - 30) / 15) * 1.2; // → 4.4
  return 4.4 + ((t - 45) / 15) * 1.6; // → 6.0 at 60s (~36 pps base*6)
}

/**
 * Gap shrink factor. Floor kept high enough that consecutive obstacles
 * leave landing room given ~0.58s jump airtime.
 */
export function gapShrink(elapsedMs: number): number {
  const t = Math.min(elapsedMs / 1000, 60);
  if (t < 8) return 1.2;
  if (t < 20) return 1.2 - ((t - 8) / 12) * 0.2; // → 1.0
  if (t < 40) return 1.0 - ((t - 20) / 20) * 0.15; // → 0.85
  return Math.max(0.8, 0.85 - (t - 40) / 100);
}

/** Cap cactus cluster size so jump distance can clear the body. */
export function maxObstacleSize(elapsedMs: number, speed: number): number {
  const t = elapsedMs / 1000;
  if (t < 8) return 1;
  if (t < 18 || speed < 10) return 2;
  // Triple clusters only briefly mid-race; late race stays doubles.
  if (t < 35 && speed < 16) return 3;
  return 2;
}

/**
 * Minimum empty pixels after an obstacle so a jump can land before the next.
 * Jump airtime ≈ 0.58s; require ~0.5s of gap time (land + tiny react).
 */
export function minGapPixels(
  obstacleWidth: number,
  speed: number,
  gapCoefficient: number,
  elapsedMs: number,
  typeMinGap: number,
): number {
  const shrink = gapShrink(elapsedMs);
  const chromium = Math.round(
    obstacleWidth * speed + typeMinGap * gapCoefficient * shrink,
  );
  const pps = Math.max(speed, 0.1) * 60;
  // Must land between consecutive jumpables — 0.5s ≈ airtime − pass + margin.
  const landingGap = Math.round(pps * 0.5);
  return Math.max(chromium, landingGap);
}
