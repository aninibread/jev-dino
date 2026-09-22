import {
  buildJumpProfileQuestions,
  buildManeuverQuestions,
  buildManeuverState,
  EMPTY_PROFILE_PROBABILITIES,
  maneuverToPresses,
  type DecideResponse,
  type DecideState,
  type JumpProfile,
  type JumpProfileProbabilities,
  type Maneuver,
  type ManeuverProbabilities,
} from "../app/lib/jev-contract";
import { JEV_SERVER_TIMEOUT_MS } from "../app/game/constants";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const object = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const MANEUVERS: Maneuver[] = ["jump", "duck", "keep_running"];
const PROFILES: JumpProfile[] = ["short", "full"];

function findAnswerBlock(
  value: unknown,
  key: string,
): Record<string, unknown> | null {
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();
  for (let depth = 0; queue.length && depth < 12; depth++) {
    const candidate = queue.shift();
    if (typeof candidate === "string") {
      try {
        queue.push(JSON.parse(candidate));
      } catch {
        /* Not JSON. */
      }
      continue;
    }
    if (!object(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    if (object(candidate.answers) && object(candidate.answers[key])) {
      return candidate.answers[key] as Record<string, unknown>;
    }
    for (const nested of ["result", "response", "output", "data"]) {
      if (nested in candidate) queue.push(candidate[nested]);
    }
  }
  return null;
}

function parseDistribution(
  block: Record<string, unknown> | null,
  allowed: string[],
  chosen: string,
  confidence: number,
): Record<string, number> {
  const probs: Record<string, number> = {};
  for (const key of allowed) probs[key] = 0;
  const raw = block && object(block.probabilities) ? block.probabilities : null;
  let sum = 0;
  if (raw) {
    for (const key of allowed) {
      const value = raw[key];
      if (typeof value === "number" && Number.isFinite(value)) {
        const clamped = Math.min(1, Math.max(0, value));
        probs[key] = clamped;
        sum += clamped;
      }
    }
  }
  if (sum < 0.01) {
    for (const key of allowed) probs[key] = 0;
    probs[chosen] = confidence;
    return probs;
  }
  for (const key of allowed) {
    probs[key] = probs[key] / sum;
  }
  return probs;
}

function parseChoice(
  value: unknown,
  key: string,
  allowed: string[],
): {
  choice: string;
  confidence: number;
  block: Record<string, unknown>;
} | null {
  const block = findAnswerBlock(value, key);
  if (!block) return null;
  const choice =
    typeof block.choice === "string"
      ? block.choice
      : typeof block.answer === "string"
        ? block.answer
        : null;
  if (!choice || !allowed.includes(choice)) return null;
  const confidence =
    typeof block.confidence === "number" && Number.isFinite(block.confidence)
      ? Math.min(1, Math.max(0, block.confidence))
      : typeof block.noul === "number"
        ? Math.min(1, Math.max(0, block.noul))
        : 0.5;
  return { choice, confidence, block };
}

export function parseManeuverResponse(
  value: unknown,
  state: DecideState,
): Omit<
  DecideResponse,
  "durationMs" | "source" | "jump_profile" | "profile_probabilities"
> & {
  jump_profile: JumpProfile;
  profile_probabilities: JumpProfileProbabilities;
} {
  const maneuver = parseChoice(value, "maneuver", MANEUVERS);
  if (!maneuver) {
    throw new ApiError(502, "Jev returned an unreadable maneuver.");
  }

  const action = maneuver.choice as Maneuver;
  const probabilities = parseDistribution(
    maneuver.block,
    MANEUVERS,
    action,
    maneuver.confidence,
  ) as ManeuverProbabilities;
  const presses = maneuverToPresses(action);
  return {
    action,
    // Profile filled by the second call when action is jump.
    jump_profile: "full",
    confidence: maneuver.confidence,
    probabilities,
    profile_probabilities: { ...EMPTY_PROFILE_PROBABILITIES },
    press_jump: presses.press_jump,
    press_duck: presses.press_duck,
    obstacle_id: state.obstacle.id,
  };
}

export function parseJumpProfileResponse(
  value: unknown,
  _state: DecideState,
): {
  jump_profile: JumpProfile;
  profile_probabilities: JumpProfileProbabilities;
  confidence: number;
} {
  const profile =
    parseChoice(value, "jump_profile", PROFILES) ?? {
      choice: "full" as const,
      confidence: 0.5,
      block: {},
    };

  const jump_profile = profile.choice as JumpProfile;
  // Client applies maneuver-aware clamps (short hop only on single small cactus;
  // short duck is allowed for brief stand-up before the next move).
  const profile_probabilities = parseDistribution(
    profile.block,
    PROFILES,
    jump_profile,
    profile.confidence,
  ) as JumpProfileProbabilities;

  return {
    jump_profile,
    profile_probabilities,
    confidence: profile.confidence,
  };
}

/** @deprecated Prefer parseManeuverResponse + parseJumpProfileResponse. */
export function parseDecideResponse(
  value: unknown,
  state: DecideState,
): Omit<DecideResponse, "durationMs" | "source"> {
  return parseManeuverResponse(value, state);
}

export async function decideManeuverWithJev(
  ai: Ai,
  state: DecideState,
  signal?: AbortSignal,
): Promise<DecideResponse> {
  const start = performance.now();
  const result = await ai.run(
    "typesafe/jev",
    {
      state: buildManeuverState(state),
      questions: buildManeuverQuestions(),
    },
    {
      signal: AbortSignal.any([
        AbortSignal.timeout(JEV_SERVER_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ]),
    },
  );
  return {
    ...parseManeuverResponse(result, state),
    durationMs: performance.now() - start,
    source: "jev",
  };
}

export async function decideJumpProfileWithJev(
  ai: Ai,
  state: DecideState,
  signal?: AbortSignal,
): Promise<{
  jump_profile: JumpProfile;
  profile_probabilities: JumpProfileProbabilities;
  confidence: number;
  durationMs: number;
  source: "jev" | "none";
  obstacle_id: string;
}> {
  const start = performance.now();
  const result = await ai.run(
    "typesafe/jev",
    {
      state: buildManeuverState(state),
      questions: buildJumpProfileQuestions(),
    },
    {
      signal: AbortSignal.any([
        AbortSignal.timeout(JEV_SERVER_TIMEOUT_MS),
        ...(signal ? [signal] : []),
      ]),
    },
  );
  return {
    ...parseJumpProfileResponse(result, state),
    durationMs: performance.now() - start,
    source: "jev",
    obstacle_id: state.obstacle.id,
  };
}

/** Maneuver-only decide (first call). */
export async function decideWithJev(
  ai: Ai,
  state: DecideState,
  signal?: AbortSignal,
): Promise<DecideResponse> {
  return decideManeuverWithJev(ai, state, signal);
}

export function publicError(error: unknown): {
  status: number;
  message: string;
} {
  if (error instanceof ApiError) {
    return { status: error.status, message: error.message };
  }
  return { status: 500, message: "Something went wrong. Try again." };
}
