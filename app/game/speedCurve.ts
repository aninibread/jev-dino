/**
 * Difficulty inspired by Chromium’s offline T-rex runner:
 * - Speed rises slowly each frame and caps (never an unfair spike)
 * - Gaps scale UP with speed (width×speed + minGap×coeff) so spacing stays fair
 * - Hardness comes from unlocks: clusters, birds, tighter coeff, nastier mixes
 *
 * @see https://chromium.googlesource.com/chromium/src/+/main/components/neterror/resources/offline.js
 */

/** Per-frame acceleration at 60fps (Chromium uses 0.001; a bit higher for a 60s race). */
export const ACCELERATION = 0.002;
/** Soft cap — Chrome uses 13; we allow a touch more late-race pressure. */
export const MAX_SPEED = 14;
/** Chromium Obstacle.MAX_GAP_COEFFICIENT */
export const MAX_GAP_COEFFICIENT = 1.5;

/** Advance speed the Chromium way: +ACCELERATION per frame, clamped. */
export function stepSpeed(current: number, deltaTime: number): number {
  const frames = deltaTime / (1000 / 60);
  return Math.min(MAX_SPEED, current + ACCELERATION * frames);
}

/**
 * Gap coefficient. Chromium keeps 0.6 constant; we ease it down so packing
 * gets meaner even after speed is near the cap.
 */
export function gapCoefficientFor(elapsedMs: number): number {
  const t = Math.min(Math.max(elapsedMs, 0) / 60_000, 1);
  // 0.6 early → ~0.42 late (still speed-scaled, not unfair teleport packs)
  return 0.6 - t * 0.18;
}

/**
 * Cluster size cap. Chromium allows up to 3; type.multipleSpeed still gates
 * which cactus can actually cluster at the current speed.
 */
export function maxObstacleSize(speed: number): number {
  if (speed < 5) return 1;
  if (speed < 8.5) return 2;
  return 3;
}

/** Chromium getGap — min gap widens with speed so reaction time stays sane. */
export function chromiumGapPixels(
  obstacleWidth: number,
  speed: number,
  gapCoefficient: number,
  typeMinGap: number,
): { minGap: number; maxGap: number } {
  const minGap = Math.round(
    obstacleWidth * speed + typeMinGap * gapCoefficient,
  );
  const maxGap = Math.round(minGap * MAX_GAP_COEFFICIENT);
  return { minGap, maxGap };
}

/**
 * Spawn weights by race phase. Early = readable singles; late = birds,
 * large cactus, and clusters (still subject to speed gates).
 */
export function obstacleWeights(elapsedMs: number, speed: number): {
  small: number;
  large: number;
  bird: number;
} {
  const t = elapsedMs / 1000;
  if (t < 8 || speed < 7) {
    return { small: 0.75, large: 0.25, bird: 0 };
  }
  if (t < 18) {
    return { small: 0.45, large: 0.35, bird: 0.2 };
  }
  if (t < 35) {
    return { small: 0.3, large: 0.35, bird: 0.35 };
  }
  // Endgame: birds + large clusters dominate — this is where Jev gets tested.
  return { small: 0.2, large: 0.35, bird: 0.45 };
}

/** Prefer low (must-duck) birds more often as the race goes on. */
export function birdHeightIndex(elapsedMs: number, optionCount: number): number {
  const t = Math.min(elapsedMs / 60_000, 1);
  // options typically [100 low, 75 mid, 50 high]
  const roll = Math.random();
  if (optionCount >= 3) {
    if (roll < 0.25 + t * 0.35) return 0; // low — duck
    if (roll < 0.65) return 1; // mid
    return 2; // high — jump
  }
  return Math.floor(Math.random() * optionCount);
}
