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
 * Press duck once most of the target has scrolled past the dino — earlier than
 * a full trailing-edge clear — so a short still crosses the obstacle but lands
 * ready for the next one. A human mid-air duck uses the identical speed-drop.
 */
export const SHORT_DROP_WIDTH_RATIO = 0.55;

export function obstacleClearedForShortDrop({
  dinosaurX,
  obstacleX,
  obstacleWidth,
}: {
  dinosaurX: number;
  obstacleX: number;
  obstacleWidth: number;
  /** @deprecated Ignored; earlier duck is controlled by SHORT_DROP_WIDTH_RATIO. */
  marginPx?: number;
}): boolean {
  const width = Math.max(0, Number(obstacleWidth) || 0);
  // Trailing edge need not fully pass the dino — once this fraction of the
  // width is behind dinosaurX, the shared speed-drop can start.
  return (
    Number(obstacleX) + width * SHORT_DROP_WIDTH_RATIO < Number(dinosaurX)
  );
}
