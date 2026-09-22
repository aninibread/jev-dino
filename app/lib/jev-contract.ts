/**
 * Jev decide contract — per-obstacle maneuvers (joshlarsen/jev-t-rex-runner style).
 *
 * Jev chooses WHAT: jump | duck | keep_running (+ jump profile).
 * Code chooses WHEN (proximity) and HOW LONG (hold duck until clear).
 * Optional next_obstacles (up to two) are context for jump_profile only.
 */

export type JevAction = "run" | "jump" | "duck";
export type Maneuver = "jump" | "duck" | "keep_running";
export type JumpProfile = "short" | "full";
export type ObstacleKind = "cactus-small" | "cactus-large" | "bird";
export type SemanticKind = "small_cactus" | "large_cactus" | "pterodactyl";
export type ObstacleGroup = "single" | "double" | "triple";
export type FlightPath =
  | "ground_hazard"
  | "blocks_running_and_ducking"
  | "blocks_running_only"
  | "clears_running_dinosaur";
export type BirdAltitude = "high" | "mid" | "low";
export type DinosaurMotion = "running" | "jumping" | "ducking";

export type ObstacleDecisionState = {
  id: string;
  kind: SemanticKind;
  group: ObstacleGroup;
  flight_path: FlightPath;
  width_px: number;
};

/** Follow-up hazard used only to shape jump_profile for the target. */
export type NextObstacleContext = ObstacleDecisionState & {
  /** Gap from the previous obstacle's trailing edge to this one's leading edge. */
  gap_px: number;
  seconds_until_next: number;
};

/** Minimal state sent to Jev for one obstacle. */
export type DecideState = {
  speed: number;
  dinosaur_motion: DinosaurMotion;
  obstacle: ObstacleDecisionState;
  /** Up to two upcoming obstacles after the target (profile ask). */
  next_obstacles: NextObstacleContext[];
  /** Maneuver already chosen for this obstacle (profile ask only). */
  maneuver?: Maneuver | null;
};

/** Soft scores over the three maneuvers (from Jev choice probabilities). */
export type ManeuverProbabilities = Record<Maneuver, number>;

/** Soft scores over short vs full (from the second Jev call when action is jump). */
export type JumpProfileProbabilities = Record<JumpProfile, number>;

export type DecideResponse = {
  action: Maneuver;
  jump_profile: JumpProfile;
  confidence: number;
  probabilities: ManeuverProbabilities;
  /** Present after the jump_profile call; zeros when the maneuver is not jump. */
  profile_probabilities: JumpProfileProbabilities;
  /** Derived key-hold view for HUD / logging. */
  press_jump: number;
  press_duck: number;
  durationMs: number;
  source: "jev" | "none";
  obstacle_id: string;
  /** Billable usage for this ask when source is jev. */
  usage?: {
    input_tokens: number;
    cost_usd: number;
  };
};

export type ObstacleAskView = ObstacleDecisionState & {
  type?: ObstacleKind;
  bird_altitude?: BirdAltitude;
};

/** What the browser asked Jev — kept for on-screen I/O analysis. */
export type JevAskView = {
  speed: number;
  dinosaur_motion: DinosaurMotion;
  obstacle: ObstacleAskView;
  next_obstacles: Array<
    ObstacleAskView & {
      gap_px: number;
      seconds_until_next: number;
    }
  >;
};

export const EMPTY_PROBABILITIES: ManeuverProbabilities = {
  jump: 0,
  duck: 0,
  keep_running: 0,
};

export const EMPTY_PROFILE_PROBABILITIES: JumpProfileProbabilities = {
  short: 0,
  full: 0,
};

export function labelManeuver(action: Maneuver): string {
  if (action === "keep_running") return "Keep running";
  if (action === "jump") return "Jump";
  return "Duck";
}

export function labelFlightPath(path: FlightPath): string {
  if (path === "ground_hazard") return "Ground hazard";
  if (path === "blocks_running_and_ducking") return "Blocks run + duck";
  if (path === "blocks_running_only") return "Blocks running only";
  return "Clears running dino";
}

export function labelKind(kind: SemanticKind): string {
  if (kind === "small_cactus") return "Small cactus";
  if (kind === "large_cactus") return "Large cactus";
  return "Pterodactyl";
}

export function labelGroup(group: ObstacleGroup): string {
  if (group === "triple") return "×3";
  if (group === "double") return "×2";
  return "×1";
}

export function labelMotion(motion: DinosaurMotion): string {
  if (motion === "jumping") return "Jumping";
  if (motion === "ducking") return "Ducking";
  return "Running";
}

export const CONFIDENCE_THRESHOLD = 0.5;
export const VISIBLE_COUNT = 5;

export function toSemanticKind(type: ObstacleKind): SemanticKind {
  if (type === "cactus-small") return "small_cactus";
  if (type === "cactus-large") return "large_cactus";
  return "pterodactyl";
}

export function toGroup(size: number): ObstacleGroup {
  if (size >= 3) return "triple";
  if (size >= 2) return "double";
  return "single";
}

export function flightPathFor(
  type: ObstacleKind,
  birdAltitude?: BirdAltitude,
): FlightPath {
  if (type !== "bird") return "ground_hazard";
  if (birdAltitude === "high") return "clears_running_dinosaur";
  if (birdAltitude === "mid") return "blocks_running_only";
  return "blocks_running_and_ducking";
}

export function birdAltitude(y: number): BirdAltitude {
  if (y <= 55) return "high";
  if (y <= 80) return "mid";
  return "low";
}

export function obstacleRelation(
  dx: number,
  width: number,
): "ahead" | "overlapping" | "passing" {
  if (dx > 0) return "ahead";
  if (dx + width > 0) return "overlapping";
  return "passing";
}

/** Map a maneuver decision into key-hold beliefs for HUD. */
export function maneuverToPresses(action: Maneuver): {
  press_jump: number;
  press_duck: number;
  uiAction: JevAction;
} {
  if (action === "jump") {
    return { press_jump: 0.9, press_duck: 0.05, uiAction: "jump" };
  }
  if (action === "duck") {
    return { press_jump: 0.05, press_duck: 0.9, uiAction: "duck" };
  }
  return { press_jump: 0.05, press_duck: 0.05, uiAction: "run" };
}

export function buildManeuverState(state: DecideState) {
  return {
    objective: "Avoid the target obstacle and keep the dinosaur alive.",
    dinosaur_motion_when_observed: state.dinosaur_motion,
    target_obstacle: {
      kind: state.obstacle.kind,
      group_size: state.obstacle.group,
      flight_path: state.obstacle.flight_path,
      width_px: state.obstacle.width_px,
    },
    timing_policy: "Browser code times the maneuver.",
  };
}

/** Profile ask: speed, maneuver taken, target, and up to two next obstacles. */
export function buildJumpProfileState(state: DecideState) {
  return {
    objective: "Choose short or full recovery for the maneuver just taken.",
    current_speed: Number(state.speed.toFixed(2)),
    maneuver: state.maneuver ?? null,
    target_obstacle: {
      kind: state.obstacle.kind,
      group_size: state.obstacle.group,
      flight_path: state.obstacle.flight_path,
      width_px: state.obstacle.width_px,
    },
    next_obstacles: state.next_obstacles.slice(0, 2).map((next) => ({
      kind: next.kind,
      group_size: next.group,
      flight_path: next.flight_path,
      width_px: next.width_px,
      gap_px: next.gap_px,
      seconds_until_next: Number(next.seconds_until_next.toFixed(3)),
    })),
    timing_policy:
      "Browser code times any short-jump duck-after-clear. You only pick short vs full.",
  };
}

/** Maneuver call (profile waits until this returns). */
export function buildManeuverQuestions() {
  return {
    maneuver: {
      type: "choice",
      instructions: [
        "Choose jump, duck, or keep_running for target_obstacle.",
        "Read target_obstacle.kind, group_size, flight_path, and width_px.",
        "dinosaur_motion_when_observed is only what the dinosaur was doing when",
        "the obstacle was first seen; do not assume it is still true at action.",
        "timing_policy: browser code times the maneuver; you only choose which.",
      ].join(" "),
      criteria: {
        jump: {
          what: [
            "flight_path is ground_hazard, or flight_path is",
            "blocks_running_and_ducking (low pterodactyl).",
          ].join(" "),
        },
        duck: {
          what: [
            "flight_path is blocks_running_only (mid pterodactyl): ducking is",
            "safe, running is not.",
          ].join(" "),
        },
        keep_running: {
          what: [
            "flight_path is clears_running_dinosaur (high pterodactyl): neither",
            "jump nor duck; keep running.",
          ].join(" "),
        },
      },
    },
  };
}

/**
 * Recovery profile after a maneuver is chosen.
 * Soft guidance aligned to next_obstacles fields in state.
 */
export function buildJumpProfileQuestions() {
  return {
    jump_profile: {
      type: "choice",
      instructions: [
        "Choose short or full recovery for maneuver on target_obstacle.",
        "Read current_speed, maneuver, target_obstacle, and next_obstacles",
        "(up to two entries with kind, group_size, flight_path, width_px,",
        "gap_px, seconds_until_next).",
        "Lean short when next_obstacles[0] is close (small gap_px /",
        "seconds_until_next) so you can land and jump again,",
        "including when next_obstacles[1] leaves a workable gap,",
        "or when next_obstacles[0].flight_path is",
        "clears_running_dinosaur so you should land before it.",
        "Lean full when next_obstacles is empty or the first gap is comfortable.",
        "Clearing two obstacles in one full jump is rare: only lean that way when",
        "target_obstacle.width_px + gap_px + next_obstacles[0].width_px is small",
        "enough that one full jump can actually cover both at current_speed.",
        "Prefer full when unsure. timing_policy: browser times short duck-after-clear.",
      ].join(" "),
      criteria: {
        short: {
          what: [
            "next_obstacles[0] is close enough (gap_px / seconds_until_next)",
            "that landing early lets you take the next obstacle separately.",
          ].join(" "),
        },
        full: {
          what: [
            "next_obstacles is empty or far, or (rarely) one full jump can cover",
            "both the target and next_obstacles[0] widths plus gap_px.",
          ].join(" "),
        },
      },
    },
  };
}
