/**
 * Jev decision contract + local physics planner.
 *
 * Architecture:
 * 1) Browser sends enriched state to Workers AI (typesafe/jev).
 * 2) Jev answers noul probs: jump_now / duck_now (duck also = mid-air speed-drop).
 * 3) Local planner commits the exact frame — including jump→duck→jump chains —
 *    so model latency cannot miss tight consecutive cacti.
 */

export type ObstacleKind = "cactus-small" | "cactus-large" | "bird";
export type Clearance = "jump" | "duck" | "either";

export type UpcomingObstacle = {
  type: ObstacleKind;
  dx: number;
  width: number;
  height: number;
  y: number;
  /** Seconds until the obstacle reaches the dino at current speed. */
  time_to_impact: number;
  clearance: Clearance;
  /** Seconds from this obstacle's impact to the next one's (0 if none). */
  gap_to_next_s: number;
  /**
   * True when a follow-up jumpable arrives before a full natural landing
   * would leave us ready — needs jump → speed-drop → jump.
   */
  chain_with_next: boolean;
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
    /** Rough seconds until landing if still airborne. */
    est_landing_s: number;
  };
  upcoming: UpcomingObstacle[];
  /** Precomputed tactics for Jev + the local planner. */
  tactics: {
    recommended: JevAction;
    reason: string;
    chain_active: boolean;
    jump_lead_seconds: number;
    duck_lead_seconds: number;
    jump_airtime_seconds: number;
  };
};

export type JevAction = "run" | "jump" | "duck";

export type DecideResponse = {
  action: JevAction;
  jump_now: number;
  duck_now: number;
  confidence: number;
  durationMs: number;
  source: "jev" | "heuristic";
};

/** Matching Trex jump with v0=-10, gravity=0.6 at 60fps (see dino.ts). */
export const JUMP_AIRTIME_S = 0.58;
export const JUMP_TIME_TO_CLEAR_S = 0.05;
/** Natural landing leaves ~this much slack before the next jumpable feels tight. */
export const CHAIN_GAP_S = 0.62;
const DINO_BODY_WIDTH = 44;
const GRAVITY = 0.6;

/**
 * When to start a jump, in seconds before impact.
 * Biased LATE: jumping too early lands on the cactus after airtime ends.
 */
export function jumpLeadSeconds(width: number, speed: number): number {
  const pps = Math.max(speed, 0.1) * 60;
  const passTime = (DINO_BODY_WIDTH * 0.55 + width) / pps;
  const latest = JUMP_TIME_TO_CLEAR_S + 0.03;
  const earliest = Math.max(latest, JUMP_AIRTIME_S - passTime - 0.05);
  return latest + (earliest - latest) * 0.15;
}

export function jumpEarliestSeconds(width: number, speed: number): number {
  const pps = Math.max(speed, 0.1) * 60;
  const passTime = (DINO_BODY_WIDTH * 0.55 + width) / pps;
  const latest = JUMP_TIME_TO_CLEAR_S + 0.03;
  return Math.max(latest, JUMP_AIRTIME_S - passTime - 0.05);
}

export function duckLeadSeconds(speed: number): number {
  return Math.min(0.28, Math.max(0.14, 0.16 + speed / 120));
}

export function clearanceFor(
  type: ObstacleKind,
  y: number,
): Clearance {
  if (type === "bird" && y < 85) return "duck";
  if (type === "bird") return "either";
  return "jump";
}

export function pickAction(jump_now: number, duck_now: number): JevAction {
  if (duck_now >= 0.55 && duck_now >= jump_now) return "duck";
  if (jump_now >= 0.5) return "jump";
  return "run";
}

export function inJumpWindow(
  timeToImpact: number,
  width: number,
  speed: number,
): boolean {
  const lead = jumpLeadSeconds(width, speed);
  const earliest = jumpEarliestSeconds(width, speed);
  const maxTti = Math.min(earliest, lead + 0.04);
  return timeToImpact > 0.02 && timeToImpact <= maxTti;
}

export function inDuckWindow(timeToImpact: number, speed: number): boolean {
  const lead = duckLeadSeconds(speed);
  return timeToImpact > -0.02 && timeToImpact <= lead + 0.08;
}

/** Estimate seconds until ground from current jump velocity / height. */
export function estimateLandingSeconds(
  y: number,
  vy: number,
  groundY: number,
): number {
  if (y >= groundY - 0.5) return 0;
  // Discrete 60fps simulation matching dino.ts
  let pos = y;
  let vel = vy;
  let frames = 0;
  while (pos < groundY && frames < 90) {
    pos += Math.round(vel);
    vel += GRAVITY;
    frames++;
  }
  return frames / 60;
}

/**
 * Mid-air speed-drop: we've cleared (or nearly cleared) the current jumpable
 * and the next jumpable is close enough that a full arc would make us late.
 */
export function shouldSpeedDrop(state: DecideState): boolean {
  if (state.dino.grounded) return false;
  const next = state.upcoming[0];
  if (!next) return false;

  // Still rising into the hazard — don't cancel the jump.
  if (state.dino.ascending && next.time_to_impact > 0.12) return false;

  // Case A: nearest is still the cactus we're clearing — drop once past apex
  // if a chained follow-up is tight.
  if (
    next.clearance !== "duck" &&
    next.chain_with_next &&
    !state.dino.ascending &&
    next.time_to_impact < 0.2
  ) {
    return true;
  }

  // Case B: nearest is already the FOLLOW-UP (previous cleared). We're airborne
  // with a jumpable 0.2–0.65s out — slam down so we can jump again.
  if (
    next.clearance !== "duck" &&
    !state.dino.ascending &&
    next.time_to_impact > 0.2 &&
    next.time_to_impact < CHAIN_GAP_S
  ) {
    return true;
  }

  // Case C: low bird while airborne from a prior jump — duck/speed-drop to pose.
  if (next.clearance === "duck" && next.time_to_impact < 0.35) {
    return true;
  }

  return false;
}

/** Authoritative local planner — physics-first, including chains. */
export function planAction(state: DecideState): {
  action: JevAction;
  jump_now: number;
  duck_now: number;
  reason: string;
  chain_active: boolean;
} {
  const next = state.upcoming[0];
  if (!next) {
    return {
      action: "run",
      jump_now: 0,
      duck_now: state.dino.ducking ? 0.5 : 0,
      reason: "no hazard",
      chain_active: false,
    };
  }

  // --- Airborne: maybe speed-drop to chain ---
  if (!state.dino.grounded) {
    if (shouldSpeedDrop(state)) {
      return {
        action: "duck",
        jump_now: 0.05,
        duck_now: 0.95,
        reason: next.chain_with_next
          ? "speed-drop to chain next jump"
          : "speed-drop to land for next hazard",
        chain_active: true,
      };
    }
    return {
      action: "run",
      jump_now: 0,
      duck_now: 0,
      reason: "airborne holding arc",
      chain_active: Boolean(next.chain_with_next),
    };
  }

  // --- Grounded: duck birds ---
  if (next.clearance === "duck") {
    const duck = inDuckWindow(next.time_to_impact, state.speed);
    return {
      action: duck ? "duck" : "run",
      jump_now: 0.05,
      duck_now: duck ? 0.95 : 0.05,
      reason: duck ? "duck bird" : "wait for duck window",
      chain_active: false,
    };
  }

  // --- Grounded: jump cacti / high birds (late window) ---
  const jump = inJumpWindow(next.time_to_impact, next.width, state.speed);
  return {
    action: jump ? "jump" : "run",
    jump_now: jump ? 0.95 : 0.05,
    duck_now: 0.05,
    reason: jump
      ? next.chain_with_next
        ? "jump (chain setup)"
        : "jump"
      : "wait for jump window",
    chain_active: Boolean(next.chain_with_next),
  };
}

/** Enrich raw upcoming list with gap / chain flags. */
export function enrichUpcoming(
  raw: Array<{
    type: ObstacleKind;
    dx: number;
    width: number;
    height: number;
    y: number;
    time_to_impact: number;
    clearance: Clearance;
  }>,
): UpcomingObstacle[] {
  return raw.map((o, i) => {
    const following = raw[i + 1];
    const gap_to_next_s = following
      ? Math.max(0, following.time_to_impact - o.time_to_impact)
      : 0;
    const followNeedsJump =
      following != null && following.clearance !== "duck";
    // Tight if follow-up arrives before we'd finish a full jump arc + tiny react.
    const chain_with_next =
      followNeedsJump &&
      gap_to_next_s > 0 &&
      gap_to_next_s < JUMP_AIRTIME_S + 0.08;
    return { ...o, gap_to_next_s, chain_with_next };
  });
}

export function buildTactics(state: Omit<DecideState, "tactics">): DecideState["tactics"] {
  const next = state.upcoming[0];
  const plan = planAction({
    ...state,
    tactics: {
      recommended: "run",
      reason: "",
      chain_active: false,
      jump_lead_seconds: 0,
      duck_lead_seconds: 0,
      jump_airtime_seconds: JUMP_AIRTIME_S,
    },
  });
  return {
    recommended: plan.action,
    reason: plan.reason,
    chain_active: plan.chain_active,
    jump_lead_seconds: next
      ? jumpLeadSeconds(next.width, state.speed)
      : 0.1,
    duck_lead_seconds: duckLeadSeconds(state.speed),
    jump_airtime_seconds: JUMP_AIRTIME_S,
  };
}

/** Local timing fallback / blend source used by Worker + browser. */
export function heuristicDecide(state: DecideState): Omit<
  DecideResponse,
  "durationMs"
> {
  const plan = planAction(state);
  return {
    action: plan.action,
    jump_now: plan.jump_now,
    duck_now: plan.duck_now,
    confidence: 0.92,
    source: "heuristic",
  };
}
