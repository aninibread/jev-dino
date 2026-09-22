import {
  ATOMIC_KEYS,
  buildSystemOneQuestions,
  buildSystemOneState,
  composeKeyHolds,
  emptyAtomic,
  pickAction,
  type AtomicAnswers,
  type DecideResponse,
  type DecideState,
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

function findNoul(value: unknown, key: string): number | null {
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
      const answer = candidate.answers[key] as Record<string, unknown>;
      if (typeof answer.noul === "number" && Number.isFinite(answer.noul)) {
        return Math.min(1, Math.max(0, answer.noul));
      }
    }
    for (const nested of ["result", "response", "output", "data"]) {
      if (nested in candidate) queue.push(candidate[nested]);
    }
  }
  return null;
}

function parseAtomicAnswers(value: unknown): AtomicAnswers {
  const atomic = emptyAtomic();
  for (const key of ATOMIC_KEYS) {
    const noul = findNoul(value, key);
    if (noul !== null) atomic[key] = noul;
  }
  return atomic;
}

export function parseDecideResponse(
  value: unknown,
  state: DecideState,
): Omit<DecideResponse, "durationMs" | "source"> {
  const atomic = parseAtomicAnswers(value);
  const hasAtomic = ATOMIC_KEYS.some((key) => findNoul(value, key) !== null);

  let press_jump: number;
  let press_duck: number;

  if (hasAtomic) {
    ({ press_jump, press_duck } = composeKeyHolds(atomic, state));
  } else {
    // Legacy broad nouls (older deployments / proxies).
    const legacyJump =
      findNoul(value, "press_jump") ?? findNoul(value, "jump_now");
    const legacyDuck =
      findNoul(value, "press_duck") ?? findNoul(value, "duck_now");
    if (legacyJump === null || legacyDuck === null) {
      throw new ApiError(502, "Jev returned an unreadable answer.");
    }
    press_jump = legacyJump;
    press_duck = legacyDuck;
  }

  const action = pickAction(press_jump, press_duck, state.dino.airborne);
  return {
    action,
    press_jump,
    press_duck,
    atomic,
    confidence: Math.max(
      press_jump,
      press_duck,
      ...ATOMIC_KEYS.map((key) => atomic[key]),
    ),
  };
}

/**
 * System One: structured state + many narrow parallel nouls → compose in code.
 */
export async function decideWithJev(
  ai: Ai,
  state: DecideState,
  signal?: AbortSignal,
): Promise<DecideResponse> {
  const start = performance.now();
  const hasSecond = state.visible.length >= 2;

  const result = await ai.run(
    "typesafe/jev",
    {
      state: buildSystemOneState(state),
      questions: buildSystemOneQuestions(hasSecond),
    },
    {
      signal: AbortSignal.any([
        AbortSignal.timeout(2500),
        ...(signal ? [signal] : []),
      ]),
    },
  );
  const durationMs = performance.now() - start;
  return {
    ...parseDecideResponse(result, state),
    durationMs,
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

export { pickAction };
