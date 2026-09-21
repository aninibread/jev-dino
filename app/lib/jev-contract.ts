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
/**
 * How to clear the hazard while grounded:
 * - jump: must jump (cacti, low birds)
 * - duck: must duck (mid-high birds that hit a standing dino)
 * - either: jump or duck both work (mid birds)
 * - clear: high birds that pass over a standing dino — do nothing
 */
export type Clearance = "jump" | "duck" | "either" | "clear";

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
  /** All hazards currently in the decision window (nearest first). */
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
/**
 * Only chain (speed-drop) when the next jumpable is closer than a full arc
 * minus a little react slack. Wider gaps: ride the natural landing.
 */
export const CHAIN_GAP_S = 0.5;
/** How far ahead (seconds) we include obstacles in Jev's window. */
export const LOOKAHEAD_S = 2.2;
/** Cap on obstacles sent in one decide payload. */
export const LOOKAHEAD_COUNT = 6;
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
  // Start early enough that the duck hitbox is active before the bird arrives.
  return Math.min(0.45, Math.max(0.24, 0.26 + speed / 90));
}

/** How long the bird (or duck hazard) overlaps the dino after impact. */
export function duckPassSeconds(width: number, speed: number): number {
  const pps = Math.max(speed, 0.1) * 60;
  // Ducking hitbox is wider (WIDTH_DUCK=59); pad so we don't stand into the bird.
  const duckBody = 59;
  return (duckBody * 0.75 + width) / pps;
}

/**
 * Chromium bird yPos: [100 low, 75 mid, 50 high].
 * High birds clear a standing dino; mid can jump or duck; low must jump.
 */
export function clearanceFor(
  type: ObstacleKind,
  y: number,
): Clearance {
  if (type !== "bird") return "jump";
  if (y <= 55) return "clear";
  if (y <= 80) return "either";
  return "jump";
}

export function needsJump(clearance: Clearance): boolean {
  return clearance === "jump" || clearance === "either";
}

export function needsAction(clearance: Clearance): boolean {
  return clearance !== "clear";
}

/** Nearest hazard that actually requires a response (skip overhead birds). */
export function nextActionable(
  upcoming: UpcomingObstacle[],
): UpcomingObstacle | null {
  return upcoming.find((o) => needsAction(o.clearance)) ?? null;
}

/**
 * High (clear) birds are safe while standing, but a jump arc rises into them.
 * Block jumps while a clear bird is still in the airspace.
 */
export function clearBirdBlocksJump(upcoming: UpcomingObstacle[]): boolean {
  return upcoming.some(
    (o) =>
      o.clearance === "clear" &&
      o.time_to_impact > -0.25 &&
      o.time_to_impact < JUMP_AIRTIME_S + 0.05,
  );
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

/**
 * Duck from lead before impact until the bird has fully cleared the body.
 * Old window ended at tti > -0.02 and stood up into the bird.
 */
export function inDuckWindow(
  timeToImpact: number,
  width: number,
  speed: number,
): boolean {
  const lead = duckLeadSeconds(speed);
  const holdAfter = duckPassSeconds(width, speed) + 0.1;
  return timeToImpact > -holdAfter && timeToImpact <= lead;
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
 * Mid-air speed-drop: only when the next jumpable is genuinely too close
 * for a full natural landing.
 */
export function shouldSpeedDrop(state: DecideState): boolean {
  if (state.dino.grounded) return false;
  const next = nextActionable(state.upcoming);
  if (!next) return false;

  // Still rising into the hazard — don't cancel the jump.
  if (state.dino.ascending && next.time_to_impact > 0.12) return false;

  // Case A: nearest is still the cactus we're clearing — drop once past apex
  // if a chained follow-up is tight.
  if (
    needsJump(next.clearance) &&
    next.chain_with_next &&
    !state.dino.ascending &&
    next.time_to_impact < 0.2
  ) {
    return true;
  }

  // Case B: nearest is already the FOLLOW-UP (previous cleared). Only slam
  // when that follow-up itself is in the tight chain band — not every gap.
  if (
    needsJump(next.clearance) &&
    !state.dino.ascending &&
    next.time_to_impact > 0.15 &&
    next.time_to_impact < CHAIN_GAP_S
  ) {
    return true;
  }

  // Case C: must-duck bird while airborne from a prior jump.
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
  const next = nextActionable(state.upcoming);
  if (!next) {
    return {
      action: "run",
      jump_now: 0,
      duck_now: state.dino.ducking ? 0.5 : 0,
      reason: "no hazard (overhead birds clear)",
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
          : "speed-drop — next jumpable too close",
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

  // --- Grounded: duck birds that require duck ---
  if (next.clearance === "duck") {
    const duck = inDuckWindow(
      next.time_to_impact,
      next.width,
      state.speed,
    );
    return {
      action: duck ? "duck" : "run",
      jump_now: 0.05,
      duck_now: duck ? 0.95 : 0.05,
      reason: duck
        ? next.time_to_impact < 0
          ? "hold duck through bird pass"
          : "duck bird"
        : "wait for duck window",
      chain_active: false,
    };
  }

  // --- Grounded: either (mid bird) — jump or duck; prefer jump ---
  if (next.clearance === "either") {
    const birdBlocks = clearBirdBlocksJump(state.upcoming);
    const jump =
      !birdBlocks &&
      inJumpWindow(next.time_to_impact, next.width, state.speed);
    const duck = inDuckWindow(
      next.time_to_impact,
      next.width,
      state.speed,
    );
    // Prefer jump; duck is a valid backup inside the duck window.
    if (jump) {
      return {
        action: "jump",
        jump_now: 0.9,
        duck_now: 0.15,
        reason: "mid bird — jump (either)",
        chain_active: Boolean(next.chain_with_next),
      };
    }
    if (duck) {
      return {
        action: "duck",
        jump_now: 0.1,
        duck_now: 0.9,
        reason: "mid bird — duck (either)",
        chain_active: false,
      };
    }
    return {
      action: "run",
      jump_now: 0.05,
      duck_now: 0.05,
      reason: birdBlocks
        ? "wait — overhead bird blocks jump"
        : "wait for mid-bird window",
      chain_active: Boolean(next.chain_with_next),
    };
  }

  // --- Grounded: jump cacti / low birds (late window) ---
  if (clearBirdBlocksJump(state.upcoming)) {
    return {
      action: "run",
      jump_now: 0.05,
      duck_now: 0.05,
      reason: "wait — overhead bird blocks jump",
      chain_active: Boolean(next.chain_with_next),
    };
  }
  const jump = inJumpWindow(next.time_to_impact, next.width, state.speed);
  return {
    action: jump ? "jump" : "run",
    jump_now: jump ? 0.95 : 0.05,
    duck_now: 0.05,
    reason: jump
      ? next.chain_with_next
        ? "jump (tight chain setup)"
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
    // Gap to the next obstacle that actually needs a jump response.
    let gap_to_next_s = 0;
    let chain_with_next = false;
    for (let j = i + 1; j < raw.length; j++) {
      const f = raw[j]!;
      if (!needsJump(f.clearance)) continue;
      gap_to_next_s = Math.max(0, f.time_to_impact - o.time_to_impact);
      // Only mark chain when THIS obstacle also needs a jump AND the gap is
      // tighter than a full natural airtime (wider gaps: land normally).
      chain_with_next =
        needsJump(o.clearance) &&
        gap_to_next_s > 0 &&
        gap_to_next_s < CHAIN_GAP_S;
      break;
    }
    // Still record gap to immediate next for Jev context (even if clear).
    if (following && gap_to_next_s === 0 && !chain_with_next) {
      gap_to_next_s = Math.max(0, following.time_to_impact - o.time_to_impact);
    }
    return { ...o, gap_to_next_s, chain_with_next };
  });
}

export function buildTactics(state: Omit<DecideState, "tactics">): DecideState["tactics"] {
  const next = nextActionable(state.upcoming);
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
