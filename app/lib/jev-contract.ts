/**
 * Jev decide contract — per-obstacle maneuvers (joshlarsen/jev-t-rex-runner style).
 *
 * Jev chooses WHAT: jump | duck | keep_running (+ jump profile).
 * Code chooses WHEN (proximity) and HOW LONG (hold duck until clear).
 * Optional next_obstacle is context for jump_profile only (tight chains).
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
  gap_px: number;
  seconds_until_next: number;
};

/** Minimal state sent to Jev for one obstacle. */
export type DecideState = {
  speed: number;
  dinosaur_motion: DinosaurMotion;
  obstacle: ObstacleDecisionState;
  next_obstacle: NextObstacleContext | null;
};

/** Soft scores over the three maneuvers (from Jev choice probabilities). */
export type ManeuverProbabilities = Record<Maneuver, number>;

export type DecideResponse = {
  action: Maneuver;
  jump_profile: JumpProfile;
  confidence: number;
  probabilities: ManeuverProbabilities;
  /** Derived key-hold view for HUD / logging. */
  press_jump: number;
  press_duck: number;
  durationMs: number;
  source: "jev" | "none";
  obstacle_id: string;
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
  next_obstacle: (ObstacleAskView & {
    gap_px: number;
    seconds_until_next: number;
  }) | null;
};

export const EMPTY_PROBABILITIES: ManeuverProbabilities = {
  jump: 0,
  duck: 0,
  keep_running: 0,
};

/** Gaps at or below this (seconds) count as a tight follow-up for short jumps. */
export const TIGHT_NEXT_SECONDS = 0.55;

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
    current_speed: Number(state.speed.toFixed(2)),
    dinosaur_motion_when_observed: state.dinosaur_motion,
    target_obstacle: {
      kind: state.obstacle.kind,
      group_size: state.obstacle.group,
      flight_path: state.obstacle.flight_path,
      width_px: state.obstacle.width_px,
    },
    next_obstacle: state.next_obstacle
      ? {
          kind: state.next_obstacle.kind,
          group_size: state.next_obstacle.group,
          flight_path: state.next_obstacle.flight_path,
          width_px: state.next_obstacle.width_px,
          gap_px: state.next_obstacle.gap_px,
          seconds_until_next: Number(
            state.next_obstacle.seconds_until_next.toFixed(3),
          ),
          is_tight_follow_up:
            state.next_obstacle.seconds_until_next <= TIGHT_NEXT_SECONDS,
        }
      : null,
    timing_policy: [
      "The current motion is transient. Browser code will finish it and",
      "execute the chosen maneuver at the safe proximity for the current speed.",
      "Choose only the maneuver for the target obstacle. next_obstacle is",
      "context for jump height only, not a second action to plan.",
    ].join(" "),
  };
}

export function buildManeuverQuestions() {
  return {
    maneuver: {
      type: "choice",
      instructions: [
        "Choose the single safest maneuver for the dinosaur to avoid",
        "the target obstacle and continue running.",
        "The dinosaur motion in the state is only what it was doing when the",
        "distant obstacle was first observed; do not assume that motion will",
        "still be active when the obstacle arrives.",
        "Choose only the maneuver type for the target. Browser code will handle",
        "timing and any later obstacle separately.",
      ].join(" "),
      criteria: {
        jump: {
          what: [
            "Jump over a ground hazard or an airborne obstacle whose path blocks",
            "both a running and ducking dinosaur.",
          ].join(" "),
        },
        duck: {
          what: [
            "Duck under an airborne obstacle whose path blocks a running dinosaur",
            "but leaves safe space for a ducking dinosaur.",
          ].join(" "),
        },
        keep_running: {
          what: [
            "Keep running without jumping or ducking when the obstacle safely clears",
            "the running dinosaur.",
          ].join(" "),
        },
      },
    },
    jump_profile: {
      type: "choice",
      instructions: [
        "Assume the safest maneuver is to jump the target obstacle.",
        "Choose the jump trajectory that best clears it and still leaves the",
        "dinosaur ready for whatever comes next.",
        "If next_obstacle.is_tight_follow_up is true and the next hazard also",
        "needs a jump or duck soon, prefer a short hop when the target is a",
        "single small cactus so the dinosaur lands earlier.",
        "Browser code will calculate the exact launch time from the game speed.",
      ].join(" "),
      criteria: {
        short: {
          what: [
            "Use only for one small cactus.",
            "Prefer short when a tight next_obstacle follows that will need",
            "another jump or duck soon after landing.",
            "Do not use for a large cactus, grouped cacti, or a pterodactyl.",
          ].join(" "),
        },
        full: {
          what: [
            "Use maximum safe airtime for every large cactus, grouped cactus,",
            "pterodactyl, uncertain obstacle, or when the next hazard is far",
            "or null.",
          ].join(" "),
        },
      },
    },
  };
}
