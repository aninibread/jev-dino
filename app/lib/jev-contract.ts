export type ObstacleKind = "cactus-small" | "cactus-large" | "bird";

export type DecideState = {
  t: number;
  speed: number;
  /** Pixels scrolled per second at current speed. */
  px_per_sec: number;
  dino: {
    y: number;
    vy: number;
    ducking: boolean;
    grounded: boolean;
  };
  upcoming: Array<{
    type: ObstacleKind;
    dx: number;
    width: number;
    height: number;
    y: number;
    /** Seconds until the obstacle reaches the dino at current speed. */
    time_to_impact: number;
    /** What clearance this obstacle needs. */
    clearance: "jump" | "duck" | "either";
  }>;
};

export type JevAction = "run" | "jump" | "duck";

export type DecideResponse = {
  action: JevAction;
  /** Calibrated P(jump now). */
  jump_now: number;
  /** Calibrated P(duck now). */
  duck_now: number;
  confidence: number;
  durationMs: number;
  source: "jev" | "heuristic";
};

/** Matching Trex jump with v0=-10, gravity=0.6 at 60fps (see dino.ts). */
export const JUMP_AIRTIME_S = 0.58;
/** Frames until body is above a typical cactus top after jump starts. */
export const JUMP_TIME_TO_CLEAR_S = 0.05;
const DINO_BODY_WIDTH = 44;

/**
 * When to start a jump, in seconds before impact.
 * Biased LATE: jumping too early lands on the cactus after airtime ends.
 *
 * Safe window is roughly:
 *   [time_to_clear, airtime - pass_time]
 * We pick near the late end of that window.
 */
export function jumpLeadSeconds(width: number, speed: number): number {
  const pps = Math.max(speed, 0.1) * 60;
  const passTime = (DINO_BODY_WIDTH * 0.55 + width) / pps;
  const latest = JUMP_TIME_TO_CLEAR_S + 0.03; // ~0.08s — almost on top of it
  const earliest = Math.max(latest, JUMP_AIRTIME_S - passTime - 0.05);
  // 15% toward earliest from latest → stay late, only widen a bit for fat clusters.
  return latest + (earliest - latest) * 0.15;
}

/** Earliest still-safe tti — used so we don't fire jumps while hazard is still far. */
export function jumpEarliestSeconds(width: number, speed: number): number {
  const pps = Math.max(speed, 0.1) * 60;
  const passTime = (DINO_BODY_WIDTH * 0.55 + width) / pps;
  const latest = JUMP_TIME_TO_CLEAR_S + 0.03;
  return Math.max(latest, JUMP_AIRTIME_S - passTime - 0.05);
}

export function duckLeadSeconds(speed: number): number {
  // Duck only needs a short lead — hold through the bird.
  return Math.min(0.28, Math.max(0.14, 0.16 + speed / 120));
}

export function clearanceFor(
  type: ObstacleKind,
  y: number,
): "jump" | "duck" | "either" {
  if (type === "bird" && y < 85) return "duck";
  if (type === "bird") return "either";
  return "jump";
}

export function pickAction(jump_now: number, duck_now: number): JevAction {
  if (duck_now >= 0.55 && duck_now >= jump_now) return "duck";
  if (jump_now >= 0.5) return "jump";
  return "run";
}

/** True when time-to-impact is inside the late jump window. */
export function inJumpWindow(
  timeToImpact: number,
  width: number,
  speed: number,
): boolean {
  const lead = jumpLeadSeconds(width, speed);
  const earliest = jumpEarliestSeconds(width, speed);
  // Accept from lead up to a little before earliest — never fire while still far.
  const maxTti = Math.min(earliest, lead + 0.04);
  return timeToImpact > 0.02 && timeToImpact <= maxTti;
}

export function inDuckWindow(timeToImpact: number, speed: number): boolean {
  const lead = duckLeadSeconds(speed);
  return timeToImpact > -0.02 && timeToImpact <= lead + 0.08;
}

/** Local timing fallback used by the Worker and the browser controller. */
export function heuristicDecide(state: DecideState): Omit<
  DecideResponse,
  "durationMs"
> {
  const next = state.upcoming[0];
  if (!next || !state.dino.grounded) {
    return {
      action: "run",
      jump_now: 0,
      duck_now: state.dino.ducking ? 0.6 : 0,
      confidence: 1,
      source: "heuristic",
    };
  }

  const tti = next.time_to_impact;

  if (next.clearance === "duck") {
    const duck_now = inDuckWindow(tti, state.speed) ? 0.92 : 0.05;
    return {
      action: pickAction(0.05, duck_now),
      jump_now: 0.05,
      duck_now,
      confidence: 0.9,
      source: "heuristic",
    };
  }

  const jump_now = inJumpWindow(tti, next.width, state.speed) ? 0.95 : 0.05;

  return {
    action: pickAction(jump_now, 0.05),
    jump_now,
    duck_now: 0.05,
    confidence: 0.9,
    source: "heuristic",
  };
}
