import {
  buildManeuverQuestions,
  buildManeuverState,
  CONFIDENCE_THRESHOLD,
  maneuverToPresses,
  type DecideResponse,
  type DecideState,
  type JumpProfile,
  type Maneuver,
} from "../app/lib/jev-contract";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
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

function parseChoice(
  value: unknown,
  key: string,
  allowed: string[],
): { choice: string; confidence: number } | null {
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
  return { choice, confidence };
}

export function parseDecideResponse(
  value: unknown,
  state: DecideState,
): Omit<DecideResponse, "durationMs" | "source"> {
  const maneuver = parseChoice(value, "maneuver", MANEUVERS);
  if (!maneuver) {
    throw new ApiError(502, "Jev returned an unreadable maneuver.");
  }
  const profile =
    parseChoice(value, "jump_profile", PROFILES) ?? {
      choice: "full" as const,
      confidence: 0.5,
    };

  const action = maneuver.choice as Maneuver;
  let jump_profile = profile.choice as JumpProfile;
  // Only allow short jump for a lone small cactus (same rule as reference).
  const shortOk =
    state.obstacle.kind === "small_cactus" &&
    state.obstacle.group === "single";
  if (action !== "jump" || !shortOk || profile.confidence < CONFIDENCE_THRESHOLD) {
    jump_profile = "full";
  }

  const presses = maneuverToPresses(action);
  return {
    action,
    jump_profile,
    confidence: maneuver.confidence,
    press_jump: presses.press_jump,
    press_duck: presses.press_duck,
    obstacle_id: state.obstacle.id,
  };
}

export async function decideWithJev(
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
        AbortSignal.timeout(2500),
        ...(signal ? [signal] : []),
      ]),
    },
  );
  return {
    ...parseDecideResponse(result, state),
    durationMs: performance.now() - start,
    source: "jev",
  };
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
