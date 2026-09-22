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
export type JevAction = "run" | "jump" | "duck";

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

/** One past key-hold change — observational memory, not advice. */
export type ActionEvent = {
  action: JevAction;
  /** Race time when this action started. */
  at_t: number;
  /** How long this action was held before the next change. */
  held_for_s: number;
  /** Nearest obstacle id when this action began (if any). */
  nearest_obstacle_id: string | null;
  nearest_obstacle_type: ObstacleKind | null;
  nearest_width_px: number | null;
  nearest_height_px: number | null;
};

/** Snapshot of a prior decide / key-hold application. */
export type PastDecision = {
  action: JevAction;
  press_jump: number;
  press_duck: number;
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
    /** Seconds the current action has been held so far. */
    current_action_held_for_s: number;
    /** Seconds the previous action was held. */
    previous_action_held_for_s: number;
    jump_key_held: boolean;
    duck_key_held: boolean;
    last_press_jump: number;
    last_press_duck: number;
    nearest_id_when_jump_started: string | null;
  };
  recent_actions: ActionEvent[];
  /** Last 2–3 applied decisions (newest last) — continuity for Jev. */
  last_decisions: PastDecision[];
  visible: UpcomingObstacle[];
  constraints: PhysicsConstraints;
  /** Pixel gap between 1st and 2nd visible obstacle (null if <2). */
  gap_px: number | null;
};

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
    // Keep "jump" visible while the jump key is held mid-air so memory
    // doesn't flip jump→run every takeoff (that wiped action context).
    if (press_duck >= 0.45) return "duck";
    if (press_jump >= 0.45) return "jump";
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
  } else if (nearest?.already_jumped_for) {
    // Already committed a jump to the nearest hazard — do not re-jump it.
    // Only press jump again for a tight second obstacle.
    const chain =
      atomic.second_needs_jump >= 0.55 && atomic.gap_is_tight >= 0.55;
    press_jump = chain
      ? Math.max(atomic.second_needs_jump, atomic.hold_jump_until_land)
      : 0;
    press_duck = atomic.nearest_needs_duck;
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

  if (!constraints.can_jump_this_frame) {
    press_jump = dino.airborne ? atomic.hold_jump_until_land : 0;
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

/** Standing dino hitbox (Chromium TREX). */
const DINO_STANDING_HEIGHT = 47;
const DINO_WIDTH = 44;

function sizeLabel(type: ObstacleKind, width: number): string {
  if (type === "cactus-small") return "small_cactus";
  if (type === "cactus-large") return "large_cactus";
  if (width >= 40) return "wide_bird";
  return "bird";
}

function heightVsDino(
  height: number,
): "shorter_than_dino" | "about_dino_tall" | "taller_than_dino" {
  if (height < DINO_STANDING_HEIGHT - 8) return "shorter_than_dino";
  if (height > DINO_STANDING_HEIGHT + 2) return "taller_than_dino";
  return "about_dino_tall";
}

function widthVsDino(
  width: number,
): "narrower_than_dino" | "about_dino_wide" | "wider_than_dino" {
  if (width < DINO_WIDTH - 10) return "narrower_than_dino";
  if (width > DINO_WIDTH + 5) return "wider_than_dino";
  return "about_dino_wide";
}

function describeObstacleSize(
  o: UpcomingObstacle,
  px_per_sec: number,
): Record<string, unknown> {
  const seconds_to_fully_clear =
    px_per_sec > 0 ? Number((o.width / px_per_sec).toFixed(3)) : 0;
  return {
    width_px: Math.round(o.width),
    height_px: Math.round(o.height),
    size_label: sizeLabel(o.type, o.width),
    how_big: `${o.type} is ${Math.round(o.width)}px wide × ${Math.round(o.height)}px tall`,
    height_vs_standing_dino: heightVsDino(o.height),
    width_vs_dino: widthVsDino(o.width),
    /** Time for the whole obstacle body to scroll past the dino at current speed. */
    seconds_to_fully_clear,
  };
}

/** Build structured state payload for System One (nested, backtick-friendly). */
export function buildSystemOneState(state: DecideState) {
  const obstacles = state.visible.map((o, i) => ({
    index: i + 1,
    id: o.id,
    type: o.type,
    distance_px: Math.round(o.dx),
    seconds_until_front_edge: Number(o.seconds_away.toFixed(3)),
    relation: o.relation,
    already_jumped_for: o.already_jumped_for,
    size: describeObstacleSize(o, state.px_per_sec),
    ...(o.bird_altitude ? { bird_altitude: o.bird_altitude } : {}),
  }));

  const recent = state.recent_actions.map((ev) => ({
    action: ev.action,
    started_at_race_t: Number(ev.at_t.toFixed(3)),
    held_for_seconds: Number(ev.held_for_s.toFixed(3)),
    seconds_ago: Number(Math.max(0, state.t - ev.at_t).toFixed(3)),
    nearest_obstacle_then: ev.nearest_obstacle_id
      ? {
          id: ev.nearest_obstacle_id,
          type: ev.nearest_obstacle_type,
          width_px: ev.nearest_width_px,
          height_px: ev.nearest_height_px,
        }
      : null,
  }));

  // Explicit last-couple view so Jev always sees continuity (even if list is short).
  const chron = recent;
  const last_couple_of_actions = {
    most_recent: chron.length
      ? chron[chron.length - 1]
      : {
          action: state.controls.current_action,
          held_for_seconds: state.controls.current_action_held_for_s,
          seconds_ago: 0,
          nearest_obstacle_then: null,
        },
    before_that:
      chron.length >= 2
        ? chron[chron.length - 2]
        : {
            action: state.controls.previous_action,
            held_for_seconds: state.controls.previous_action_held_for_s,
            seconds_ago: state.controls.current_action_held_for_s,
            nearest_obstacle_then: null,
          },
    before_that_2: chron.length >= 3 ? chron[chron.length - 3] : null,
  };

  const last_couple_of_decisions = state.last_decisions.slice(-3).map((d) => ({
    action: d.action,
    press_jump: d.press_jump,
    press_duck: d.press_duck,
    at_race_t: d.at_t,
    seconds_ago: Number(Math.max(0, state.t - d.at_t).toFixed(3)),
  }));

  const sequence = [
    ...state.recent_actions.map((e) => e.action),
    state.controls.current_action,
  ];
  const action_sequence = sequence
    .filter((a, i) => i === 0 || a !== sequence[i - 1])
    .join(" → ");

  return {
    race_time_seconds: Number(state.t.toFixed(2)),
    speed: Number(state.speed.toFixed(2)),
    pixels_per_second: Math.round(state.px_per_sec),
    dino: {
      on_ground: state.dino.grounded,
      ducking: state.dino.ducking,
      in_the_air: state.dino.airborne,
      rising: state.dino.ascending,
      how_high_in_jump: state.dino.jump_height_frac,
      seconds_aloft: state.dino.seconds_aloft,
      just_landed: state.dino.just_landed,
      seconds_since_landed: state.dino.seconds_since_landed,
      standing_height_px: DINO_STANDING_HEIGHT,
      standing_width_px: DINO_WIDTH,
    },
    memory: {
      current_action: state.controls.current_action,
      current_action_held_for_seconds: Number(
        state.controls.current_action_held_for_s.toFixed(3),
      ),
      previous_action: state.controls.previous_action,
      previous_action_held_for_seconds: Number(
        state.controls.previous_action_held_for_s.toFixed(3),
      ),
      /** Always present — the last 2–3 key-hold episodes. */
      last_couple_of_actions,
      /** Last decide outputs (what keys we pressed after each reply). */
      last_couple_of_decisions,
      action_sequence,
      jump_key_held: state.controls.jump_key_held,
      duck_key_held: state.controls.duck_key_held,
      last_press_jump: state.controls.last_press_jump,
      last_press_duck: state.controls.last_press_duck,
      nearest_obstacle_id_when_jump_started:
        state.controls.nearest_id_when_jump_started,
      recent_actions: recent,
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
          "`visible_obstacles[0].size`",
          "`visible_obstacles[0].size.height_vs_standing_dino`",
          "`visible_obstacles[0].size.width_px`",
          "`visible_obstacles[0].size.how_big`",
          "`dino.on_ground`",
          "`visible_obstacles[0].already_jumped_for`",
          "`memory.last_couple_of_actions`",
          "`memory.last_couple_of_decisions`",
          "`memory.action_sequence`",
          "`memory.recent_actions`",
        ],
        focus:
          "Close enough to need a jump NOW. False if already_jumped_for, if last_couple_of_actions.most_recent was jump for this obstacle, if still airborne over it, if high bird, or if still far away. Do not answer true just because a cactus exists somewhere ahead.",
      },
      criteria: noulCriteria(
        "Must jump this obstacle (cactus or low bird) now or on landing.",
        "No jump needed for nearest (already jumped, too far, high bird, or still clearing).",
        [
          "Large cactus taller_than_dino, ~0.2–0.3s away, not already jumped",
          "Low bird at feet height approaching",
        ],
        [
          "already_jumped_for true",
          "most_recent action was jump for this id",
          "High bird overhead",
          "Obstacle >0.6s away",
        ],
      ),
    },
    nearest_needs_duck: {
      type: "noul",
      instructions: {
        question:
          "Does the nearest obstacle require ducking (and holding duck while it passes)?",
        inspect: "`visible_obstacles[0]`",
        also_check: [
          "`visible_obstacles[0].size.width_px`",
          "`visible_obstacles[0].size.height_px`",
          "`visible_obstacles[0].size.seconds_to_fully_clear`",
          "`memory.current_action`",
          "`memory.current_action_held_for_seconds`",
          "`memory.recent_actions`",
        ],
        focus:
          "Mid-height bird that hits a standing dino. Wider birds need a longer duck hold (see seconds_to_fully_clear). Keep ducking through overlap if already ducking.",
      },
      criteria: noulCriteria(
        "Duck under the nearest bird and hold until it passes.",
        "No duck needed for nearest.",
        ["Mid bird at head height approaching", "Already ducking under a wide bird"],
        ["High bird — run under", "Cactus — jump instead"],
      ),
    },
    nearest_run_under: {
      type: "noul",
      instructions: {
        question:
          "Can you safely run under the nearest obstacle without jumping or ducking?",
        inspect: "`visible_obstacles[0].bird_altitude`",
        also_check: [
          "`visible_obstacles[0].size`",
          "`visible_obstacles[0].size.height_vs_standing_dino`",
        ],
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
          "`memory.previous_action_held_for_seconds`",
          "`memory.last_couple_of_actions`",
          "`memory.last_couple_of_decisions`",
          "`memory.action_sequence`",
          "`memory.recent_actions`",
          "`visible_obstacles[1]`",
          "`visible_obstacles[1].size`",
        ],
        focus:
          "True ONLY when a second cactus/bird still needs a jump soon after this arc. If last_couple_of_actions shows a single jump with a comfortable gap ahead, answer false — do not keep the jump key stuck on.",
      },
      criteria: noulCriteria(
        "Keep jump held through landing for a follow-up jump.",
        "Release jump — single obstacle or comfortable gap.",
        [
          "Airborne after first of two close cacti",
          "just_landed with next large cactus close",
        ],
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
          "`visible_obstacles[0].size.width_px`",
          "`visible_obstacles[0].size.seconds_to_fully_clear`",
          "`memory.recent_actions`",
          "`memory.action_sequence`",
        ],
        focus:
          "Only when airborne, first obstacle already_jumped_for, second jumpable is tight. Wide first obstacles leave less airtime after clearing.",
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
        also_check: [
          "`visible_obstacles[1].size`",
          "`visible_obstacles[1].size.height_vs_standing_dino`",
          "`visible_obstacles[1].size.how_big`",
        ],
        focus:
          "Ground cactus or low bird — not high birds you run under. Large/tall second cacti still need a jump.",
      },
      criteria: noulCriteria(
        "Second obstacle needs a jump after clearing the first.",
        "Second does not need a jump (high bird, far, or bird to duck).",
        ["Second large cactus 0.3s after first"],
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
          "`visible_obstacles[0].size.width_px`",
          "`visible_obstacles[0].size.seconds_to_fully_clear`",
          "`visible_obstacles[1].size`",
          "`memory.action_sequence`",
          "`memory.recent_actions`",
        ],
        focus:
          "Small pixel gap at current speed — especially after a wide first cactus. Needs speed-drop or holding jump through landing.",
      },
      criteria: noulCriteria(
        "Gap is tight — need chain (speed-drop or jump-on-land).",
        "Comfortable gap — normal single jump is fine.",
        ["Two cacti ~120px apart at speed 9+", "Wide first cactus then small gap"],
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
