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

/** Lead time (seconds) before impact when a grounded jump should start. */
export function jumpLeadSeconds(width: number, speed: number): number {
  return Math.min(0.48, Math.max(0.22, 0.24 + width / 260 + speed / 80));
}

export function duckLeadSeconds(speed: number): number {
  return Math.min(0.42, Math.max(0.2, 0.28 + speed / 100));
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
  const jumpLead = jumpLeadSeconds(next.width, state.speed);
  const duckLead = duckLeadSeconds(state.speed);

  if (next.clearance === "duck") {
    const duck_now =
      tti > 0.04 && tti < duckLead ? 0.92 : tti < duckLead + 0.15 ? 0.35 : 0.05;
    return {
      action: pickAction(0.05, duck_now),
      jump_now: 0.05,
      duck_now,
      confidence: 0.9,
      source: "heuristic",
    };
  }

  const jump_now =
    tti > 0.03 && tti <= jumpLead
      ? 0.95
      : tti <= jumpLead + 0.12
        ? 0.4
        : 0.05;

  return {
    action: pickAction(jump_now, 0.05),
    jump_now,
    duck_now: 0.05,
    confidence: 0.9,
    source: "heuristic",
  };
}
