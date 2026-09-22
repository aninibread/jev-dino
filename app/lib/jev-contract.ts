/**
 * Jev decide contract — fair, player-visible I/O.
 *
 * INPUT: only what a human sees on the lane (pose, speed, visible obstacles).
 * OUTPUT: key-hold beliefs (press jump / press duck), like a human holding keys.
 * The browser never invents an action for Jev — it only applies those holds.
 */

export type ObstacleKind = "cactus-small" | "cactus-large" | "bird";

/** What your eyes can tell about a bird's altitude (not a recommended move). */
export type BirdAltitude = "high" | "mid" | "low";

export type UpcomingObstacle = {
  type: ObstacleKind;
  /** Pixels from dino nose to obstacle (negative = overlapping). */
  dx: number;
  width: number;
  height: number;
  /** Canvas y of top (smaller = higher on screen). */
  y: number;
  /** Rough "how soon" from distance ÷ current scroll — same mental math a player does. */
  seconds_away: number;
  /** Only for birds — visible altitude band. */
  bird_altitude?: BirdAltitude;
};

export type DecideState = {
  t: number;
  /** Shown on the HUD. */
  speed: number;
  px_per_sec: number;
  dino: {
    /** True when feet on the ground. */
    grounded: boolean;
    ducking: boolean;
    /** In a jump arc. */
    airborne: boolean;
    /** Rising vs falling — visible from the arc. */
    ascending: boolean;
    /** How high in the jump, roughly (0 = ground, 1 ≈ peak). */
    jump_height_frac: number;
  };
  /** Obstacles currently on the visible runway (nearest first). */
  visible: UpcomingObstacle[];
};

export type JevAction = "run" | "jump" | "duck";

export type DecideResponse = {
  action: JevAction;
  /** Belief that the JUMP key is held (space). */
  press_jump: number;
  /** Belief that the DUCK key is held (down) — mid-air = speed-drop. */
  press_duck: number;
  confidence: number;
  durationMs: number;
  source: "jev" | "none";
};

/** Max obstacles a player can reasonably track on the 600px lane. */
export const VISIBLE_COUNT = 5;

/**
 * Map key-hold beliefs → committed action.
 * Airborne: duck wins when held (speed-drop). Grounded: stronger hold wins.
 */
export function pickAction(press_jump: number, press_duck: number, airborne: boolean): JevAction {
  if (airborne) {
    if (press_duck >= 0.45) return "duck";
    return "run"; // can't jump mid-air; holding jump does nothing until land
  }
  if (press_duck >= 0.5 && press_duck >= press_jump) return "duck";
  if (press_jump >= 0.45) return "jump";
  return "run";
}

/** Visible altitude band for pterodactyls — matches Chromium yPos [100, 75, 50]. */
export function birdAltitude(y: number): BirdAltitude {
  if (y <= 55) return "high";
  if (y <= 80) return "mid";
  return "low";
}
