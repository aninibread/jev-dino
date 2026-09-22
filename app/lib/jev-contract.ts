/**
 * Jev decision contract — raw window only.
 *
 * The browser sends what a player can see (speed, dino pose, nearby obstacles).
 * Jev answers jump_now / duck_now. Nothing else decides for Jev.
 */

export type ObstacleKind = "cactus-small" | "cactus-large" | "bird";

/** Obstacle as seen in the lane — geometry only, no recommended action. */
export type UpcomingObstacle = {
  type: ObstacleKind;
  /** Pixels from dino to obstacle left edge (negative = overlapping / past). */
  dx: number;
  width: number;
  height: number;
  /** Canvas y of obstacle top (lower y = higher on screen). */
  y: number;
  /** dx / scroll speed — same estimate a player makes from distance + pace. */
  time_to_impact: number;
};

export type DecideState = {
  t: number;
  speed: number;
  px_per_sec: number;
  dino: {
    y: number;
    vy: number;
    ducking: boolean;
    grounded: boolean;
    /** True when rising (vy < 0 in our coords). */
    ascending: boolean;
  };
  /** Hazards currently on-screen / approaching (nearest first). */
  upcoming: UpcomingObstacle[];
};

export type JevAction = "run" | "jump" | "duck";

export type DecideResponse = {
  action: JevAction;
  jump_now: number;
  duck_now: number;
  confidence: number;
  durationMs: number;
  source: "jev" | "none";
};

/** How far ahead (seconds) we include obstacles in the window. */
export const LOOKAHEAD_S = 2.2;
/** Cap on obstacles sent in one decide payload. */
export const LOOKAHEAD_COUNT = 6;

export function pickAction(jump_now: number, duck_now: number): JevAction {
  if (duck_now >= 0.55 && duck_now >= jump_now) return "duck";
  if (jump_now >= 0.5) return "jump";
  return "run";
}
