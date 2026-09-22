/**
 * Jev decide contract — System One style.
 *
 * INPUT: structured, player-visible state + physics constraints (code).
 * QUESTIONS: many narrow parallel nouls (Jev judges each).
 * OUTPUT: code composes press_jump / press_duck from atomic answers — no tactics.
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
  relation: ObstacleRelation;
  already_jumped_for: boolean;
};

export type ActionEvent = {
  action: JevAction;
  at_t: number;
};

/** Deterministic physics the player also knows — not tactical advice. */
export type PhysicsConstraints = {
  can_jump_this_frame: boolean;
  can_duck_this_frame: boolean;
  mid_air_duck_means_speed_drop: boolean;
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
    seconds_aloft: number;
    just_landed: boolean;
    seconds_since_landed: number;
  };
  controls: {
    current_action: JevAction;
    previous_action: JevAction;
    jump_key_held: boolean;
    duck_key_held: boolean;
    last_press_jump: number;
    last_press_duck: number;
    nearest_id_when_jump_started: string | null;
  };
  recent_actions: ActionEvent[];
  visible: UpcomingObstacle[];
  constraints: PhysicsConstraints;
  /** Pixel gap between 1st and 2nd visible obstacle (null if <2). */
  gap_px: number | null;
};

export type JevAction = "run" | "jump" | "duck";

/** Atomic parallel nouls — each is one narrow judgment from Jev. */
export type AtomicAnswers = {
  nearest_needs_jump: number;
  nearest_needs_duck: number;
  nearest_run_under: number;
  second_needs_jump: number;
  gap_is_tight: number;
  hold_jump_until_land: number;
  speed_drop_now: number;
};

export type DecideResponse = {
  action: JevAction;
  press_jump: number;
  press_duck: number;
  /** Raw parallel judgments (for console / tuning). */
  atomic: AtomicAnswers;
  confidence: number;
  durationMs: number;
  source: "jev" | "none";
};

export const VISIBLE_COUNT = 5;

export const ATOMIC_KEYS = [
  "nearest_needs_jump",
  "nearest_needs_duck",
  "nearest_run_under",
  "second_needs_jump",
  "gap_is_tight",
  "hold_jump_until_land",
  "speed_drop_now",
] as const;

export function emptyAtomic(): AtomicAnswers {
  return {
    nearest_needs_jump: 0,
    nearest_needs_duck: 0,
    nearest_run_under: 0,
    second_needs_jump: 0,
    gap_is_tight: 0,
    hold_jump_until_land: 0,
    speed_drop_now: 0,
  };
}

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

/**
 * Compose key holds from atomic nouls + physics constraints (Typesafe pattern:
 * narrow parallel questions → deterministic composition in code).
 */
export function composeKeyHolds(
  atomic: AtomicAnswers,
  state: DecideState,
): { press_jump: number; press_duck: number } {
  const { dino, constraints, visible } = state;
  const nearest = visible[0];

  let press_jump = 0;
  let press_duck = 0;

  if (dino.airborne) {
    // In air: jump key = intent to jump on landing; duck = speed-drop.
    press_jump = atomic.hold_jump_until_land;
    if (constraints.mid_air_duck_means_speed_drop) {
      press_duck = Math.max(atomic.speed_drop_now, atomic.nearest_needs_duck);
    }
  } else {
    press_jump = atomic.nearest_needs_jump;
    if (atomic.second_needs_jump >= 0.55 && atomic.gap_is_tight >= 0.55) {
      press_jump = Math.max(press_jump, atomic.hold_jump_until_land);
    }
    press_duck = atomic.nearest_needs_duck;
  }

  // High bird you can run under — don't jump into it.
  if (nearest?.bird_altitude === "high" || atomic.nearest_run_under >= 0.65) {
    press_jump = Math.min(press_jump, 0.12);
  }

  // Already jumped for this one while still clearing it — look at second.
  if (nearest?.already_jumped_for && dino.airborne) {
    press_jump = Math.max(
      atomic.hold_jump_until_land,
      atomic.second_needs_jump,
    );
  }

  if (!constraints.can_jump_this_frame) {
    press_jump = dino.airborne
      ? Math.max(atomic.hold_jump_until_land, atomic.second_needs_jump)
      : 0;
  }

  return {
    press_jump: clamp01(press_jump),
    press_duck: clamp01(press_duck),
  };
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
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

/** Build structured state payload for System One (nested, backtick-friendly). */
export function buildSystemOneState(state: DecideState) {
  const obstacles = state.visible.map((o, i) => ({
    index: i + 1,
    id: o.id,
    type: o.type,
    distance_px: Math.round(o.dx),
    width_px: o.width,
    height_px: o.height,
    seconds_away: Number(o.seconds_away.toFixed(3)),
    relation: o.relation,
    already_jumped_for: o.already_jumped_for,
    ...(o.bird_altitude ? { bird_altitude: o.bird_altitude } : {}),
  }));

  return {
    race_time_seconds: Number(state.t.toFixed(2)),
    speed: Number(state.speed.toFixed(2)),
    dino: {
      on_ground: state.dino.grounded,
      ducking: state.dino.ducking,
      in_the_air: state.dino.airborne,
      rising: state.dino.ascending,
      how_high_in_jump: state.dino.jump_height_frac,
      seconds_aloft: state.dino.seconds_aloft,
      just_landed: state.dino.just_landed,
      seconds_since_landed: state.dino.seconds_since_landed,
    },
    memory: {
      current_action: state.controls.current_action,
      previous_action: state.controls.previous_action,
      jump_key_held: state.controls.jump_key_held,
      duck_key_held: state.controls.duck_key_held,
      last_press_jump: state.controls.last_press_jump,
      last_press_duck: state.controls.last_press_duck,
      nearest_obstacle_id_when_jump_started:
        state.controls.nearest_id_when_jump_started,
      recent_action_changes: state.recent_actions,
    },
    visible_obstacles: obstacles,
    gap_between_1st_and_2nd_px: state.gap_px,
    constraints: state.constraints,
  };
}

/** Structured atomic questions — parallel fan-out per Typesafe guide. */
export function buildSystemOneQuestions(hasSecond: boolean) {
  const noulCriteria = (
    trueWhat: string,
    falseWhat: string,
    trueEx?: string[],
    falseEx?: string[],
  ) => ({
    true: {
      what: trueWhat,
      ...(trueEx ? { examples: trueEx } : {}),
    },
    false: {
      what: falseWhat,
      ...(falseEx ? { examples: falseEx } : {}),
    },
  });

  const questions: Record<string, unknown> = {
    nearest_needs_jump: {
      type: "noul",
      instructions: {
        question:
          "Does the nearest visible obstacle require a jump to clear?",
        inspect: "`visible_obstacles[0]`",
        also_check: [
          "`dino.on_ground`",
          "`visible_obstacles[0].already_jumped_for`",
        ],
        focus:
          "Cactus or low bird, close enough to act. False if already_jumped_for and you are still clearing it, or high bird you run under.",
      },
      criteria: noulCriteria(
        "Must jump this obstacle (cactus or low bird) now or on landing.",
        "No jump needed for nearest (high bird, too far, or already clearing).",
        ["Cactus 0.2s away on ground", "Low bird at feet height"],
        ["High bird overhead", "Already jumped, still in air over it"],
      ),
    },
    nearest_needs_duck: {
      type: "noul",
      instructions: {
        question:
          "Does the nearest obstacle require ducking (and holding duck while it passes)?",
        inspect: "`visible_obstacles[0]`",
        focus:
          "Mid-height bird that hits a standing dino. Keep high through overlap if already ducking.",
      },
      criteria: noulCriteria(
        "Duck under the nearest bird and hold until it passes.",
        "No duck needed for nearest.",
        ["Mid bird at head height approaching"],
        ["High bird — run under", "Cactus — jump instead"],
      ),
    },
    nearest_run_under: {
      type: "noul",
      instructions: {
        question:
          "Can you safely run under the nearest obstacle without jumping or ducking?",
        inspect: "`visible_obstacles[0].bird_altitude`",
        focus: "Usually high birds. False for cacti and low birds.",
      },
      criteria: noulCriteria(
        "High bird clears a standing runner — stay on ground.",
        "Must jump or duck — not a run-under.",
        ["bird_altitude high"],
        ["Cactus on ground", "Low bird"],
      ),
    },
    hold_jump_until_land: {
      type: "noul",
      instructions: {
        question:
          "Should the JUMP key stay held while in the air so you jump again the instant you land?",
        compare: [
          "`dino.in_the_air`",
          "`memory.previous_action`",
          "`visible_obstacles[1]`",
        ],
        focus:
          "True when a second cactus/bird still needs a jump soon after this arc. Uses memory of already jumping for the first.",
      },
      criteria: noulCriteria(
        "Keep jump held through landing for a follow-up jump.",
        "Release jump — single obstacle or comfortable gap.",
        ["Airborne after first of two close cacti", "just_landed with next cactus close"],
        ["Single cactus with wide gap", "High bird — don't jump"],
      ),
    },
    speed_drop_now: {
      type: "noul",
      instructions: {
        question:
          "Should DUCK be held mid-air to slam down fast (speed-drop) for a tight next obstacle?",
        compare: [
          "`dino.in_the_air`",
          "`constraints.mid_air_duck_means_speed_drop`",
          "`gap_between_1st_and_2nd_px`",
        ],
        focus:
          "Only when airborne, first obstacle already_jumped_for, second jumpable is tight.",
      },
      criteria: noulCriteria(
        "Slam down now to land in time for the next jump.",
        "Ride the normal arc — gap is comfortable.",
        ["Two cacti with small gap, past apex"],
        ["Single obstacle", "Still rising toward first hazard"],
      ),
    },
  };

  if (hasSecond) {
    questions.second_needs_jump = {
      type: "noul",
      instructions: {
        question:
          "Will the second visible obstacle require a jump soon after the first?",
        inspect: "`visible_obstacles[1]`",
        focus: "Ground cactus or low bird — not high birds you run under.",
      },
      criteria: noulCriteria(
        "Second obstacle needs a jump after clearing the first.",
        "Second does not need a jump (high bird, far, or bird to duck).",
        ["Second cactus 0.3s after first"],
        ["Second is high bird", "Second very far away"],
      ),
    };
    questions.gap_is_tight = {
      type: "noul",
      instructions: {
        question:
          "Is the gap between the first and second jumpable obstacles too tight for a normal landing before the next jump?",
        compare: [
          "`gap_between_1st_and_2nd_px`",
          "`speed`",
        ],
        focus:
          "Small pixel gap at current speed — needs speed-drop or holding jump through landing.",
      },
      criteria: noulCriteria(
        "Gap is tight — need chain (speed-drop or jump-on-land).",
        "Comfortable gap — normal single jump is fine.",
        ["Two cacti ~120px apart at speed 9+"],
        ["Wide spacing", "Only one obstacle"],
      ),
    };
  } else {
    questions.second_needs_jump = {
      type: "noul",
      instructions: { question: "No second obstacle visible.", inspect: "none" },
      criteria: noulCriteria("N/A", "No second obstacle."),
    };
    questions.gap_is_tight = {
      type: "noul",
      instructions: { question: "No second obstacle visible.", inspect: "none" },
      criteria: noulCriteria("N/A", "No second obstacle."),
    };
  }

  return questions;
}
