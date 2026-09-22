/**
 * Jev decide contract — fair, player-visible I/O + memory.
 *
 * INPUT: what a human sees AND remembers (pose, speed, visible obstacles,
 *        current/previous keys & actions, whether this jump already started).
 * OUTPUT: key-hold beliefs only. No recommended tactics from the game.
 */

export type ObstacleKind = "cactus-small" | "cactus-large" | "bird";
export type BirdAltitude = "high" | "mid" | "low";
export type ObstacleRelation = "ahead" | "overlapping" | "passing";

export type UpcomingObstacle = {
  id: string;
  type: ObstacleKind;
  dx: number;
  width: number;
  height: number;
  y: number;
  seconds_away: number;
  bird_altitude?: BirdAltitude;
  /** Where it sits relative to the dino body right now. */
  relation: ObstacleRelation;
  /**
   * True if we already left the ground while this obstacle was the nearest
   * threat (i.e. we already committed a jump for it). Observational — not advice.
   */
  already_jumped_for: boolean;
};

export type ActionEvent = {
  action: JevAction;
  /** Race time (seconds) when this action became active. */
  at_t: number;
};

export type DecideState = {
  t: number;
  speed: number;
  px_per_sec: number;
  dino: {
    grounded: boolean;
    ducking: boolean;
    airborne: boolean;
    ascending: boolean;
    jump_height_frac: number;
    /** Seconds since this jump left the ground (0 if grounded). */
    seconds_aloft: number;
    /** True for a short moment after feet touch down. */
    just_landed: boolean;
    /** Seconds since last landing (large if never / long ago). */
    seconds_since_landed: number;
  };
  /** What keys/actions are in effect — same self-awareness a player has. */
  controls: {
    current_action: JevAction;
    previous_action: JevAction;
    jump_key_held: boolean;
    duck_key_held: boolean;
    /** Last beliefs Jev itself returned (so it can stay consistent). */
    last_press_jump: number;
    last_press_duck: number;
    /** Obstacle id that was nearest when the current/last jump started. */
    nearest_id_when_jump_started: string | null;
  };
  /** Recent action changes, oldest→newest (short working memory). */
  recent_actions: ActionEvent[];
  visible: UpcomingObstacle[];
};

export type JevAction = "run" | "jump" | "duck";

export type DecideResponse = {
  action: JevAction;
  press_jump: number;
  press_duck: number;
  confidence: number;
  durationMs: number;
  source: "jev" | "none";
};

export const VISIBLE_COUNT = 5;

export function pickAction(
  press_jump: number,
  press_duck: number,
  airborne: boolean,
): JevAction {
  if (airborne) {
    if (press_duck >= 0.45) return "duck";
    return "run";
  }
  if (press_duck >= 0.5 && press_duck >= press_jump) return "duck";
  if (press_jump >= 0.45) return "jump";
  return "run";
}

export function birdAltitude(y: number): BirdAltitude {
  if (y <= 55) return "high";
  if (y <= 80) return "mid";
  return "low";
}

export function obstacleRelation(dx: number, width: number): ObstacleRelation {
  if (dx > 0) return "ahead";
  if (dx + width > 0) return "overlapping";
  return "passing";
}
