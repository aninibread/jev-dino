/**
 * Speed-aware action proximity (from joshlarsen/jev-t-rex-runner).
 * Converts a base pixel threshold into a constant-time approach window.
 */

export const REFERENCE_OBSTACLE_WIDTH = 17;
export const SHORT_JUMP_LEAD_RATIO = 0.82;
export const OBSTACLE_CENTERING_RATIO = 0.5;
/** Chromium-style base: act when obstacle reaches ~this x at base speed. */
export const BASE_ACTION_PROXIMITY_THRESHOLD = 140;

export function calculateActionProximityThreshold({
  baseThreshold = BASE_ACTION_PROXIMITY_THRESHOLD,
  baseSpeed,
  currentSpeed,
  dinosaurX,
  obstacleWidth = REFERENCE_OBSTACLE_WIDTH,
  action = "jump",
  jumpProfile = "full",
}: {
  baseThreshold?: number;
  baseSpeed: number;
  currentSpeed: number;
  dinosaurX: number;
  obstacleWidth?: number;
  action?: "jump" | "duck" | "keep_running";
  jumpProfile?: "short" | "full";
}): number {
  const safeBaseSpeed = Math.max(Number(baseSpeed) || 0, 0.1);
  const safeCurrentSpeed = Math.max(Number(currentSpeed) || 0, 0.1);
  const safeDinosaurX = Number(dinosaurX) || 0;
  const baseLeadDistance = Math.max(
    0,
    (Number(baseThreshold) || 0) - safeDinosaurX,
  );
  const profileRatio =
    action === "jump" && jumpProfile === "short" ? SHORT_JUMP_LEAD_RATIO : 1;
  const speedAdjustedLead =
    baseLeadDistance * (safeCurrentSpeed / safeBaseSpeed) * profileRatio;
  const obstacleWidthAdjustment =
    action === "jump"
      ? Math.max(
          0,
          ((Number(obstacleWidth) || REFERENCE_OBSTACLE_WIDTH) -
            REFERENCE_OBSTACLE_WIDTH) *
            OBSTACLE_CENTERING_RATIO,
        )
      : 0;

  return Math.max(
    safeDinosaurX,
    safeDinosaurX + speedAdjustedLead - obstacleWidthAdjustment,
  );
}

/**
 * Short-jump early drop is code-owned timing (same duck physics as the player).
 * Press duck slightly before the trailing edge fully clears the dino — enough
 * to recover sooner for a tight follow-up, not so early that a small cactus
 * triggers an instant slam at min-height. A human mid-air duck uses the
 * identical speed-drop.
 */
/** How many px early (trailing edge still overlapping the dino) we may duck. */
export const SHORT_DROP_EARLY_PX = 10;

export function obstacleClearedForShortDrop({
  dinosaurX,
  obstacleX,
  obstacleWidth,
}: {
  dinosaurX: number;
  obstacleX: number;
  obstacleWidth: number;
  /** @deprecated Ignored; earlier duck is controlled by SHORT_DROP_EARLY_PX. */
  marginPx?: number;
}): boolean {
  // Full clear is trailingEdge < dinosaurX. Allow a small overlap so shorts
  // start the shared speed-drop a touch early without jumping-then-slamming.
  return (
    Number(obstacleX) + Math.max(0, Number(obstacleWidth) || 0) <
    Number(dinosaurX) + SHORT_DROP_EARLY_PX
  );
}
