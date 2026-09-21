import {
  duckLeadSeconds,
  heuristicDecide,
  jumpLeadSeconds,
  pickAction,
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

export function parseDecideResponse(
  value: unknown,
): Omit<DecideResponse, "durationMs" | "source"> {
  const jump_now = findNoul(value, "jump_now");
  const duck_now = findNoul(value, "duck_now");
  if (jump_now === null || duck_now === null) {
    throw new ApiError(502, "Jev returned an unreadable answer.");
  }
  const action = pickAction(jump_now, duck_now);
  return {
    action,
    jump_now,
    duck_now,
    confidence: Math.max(jump_now, duck_now, 1 - Math.max(jump_now, duck_now)),
  };
}

export async function decideWithJev(
  ai: Ai,
  state: DecideState,
  signal?: AbortSignal,
): Promise<DecideResponse> {
  const start = performance.now();
  const next = state.upcoming[0];
  const result = await ai.run(
    "typesafe/jev",
    {
      state: {
        ...state,
        decision_hint: next
          ? {
              nearest: next.type,
              clearance: next.clearance,
              time_to_impact_seconds: Number(next.time_to_impact.toFixed(3)),
              jump_lead_seconds: Number(
                jumpLeadSeconds(next.width, state.speed).toFixed(3),
              ),
              duck_lead_seconds: Number(
                duckLeadSeconds(state.speed).toFixed(3),
              ),
              grounded: state.dino.grounded,
            }
          : null,
      },
      questions: {
        jump_now: {
          type: "noul",
          instructions:
            "Should the dinosaur JUMP RIGHT NOW to survive? True only if clearance is jump or either, the dino is grounded, and time_to_impact_seconds is inside (or extremely close to) jump_lead_seconds — waiting longer will be too late. False if the hazard is still far, already passed, the dino is airborne, or a duck is required instead.",
          criteria: {
            true: "Jump this instant — cactus/low bird is in the jump window.",
            false:
              "Do not jump now — too early, too late, airborne, or duck instead.",
          },
        },
        duck_now: {
          type: "noul",
          instructions:
            "Should the dinosaur DUCK RIGHT NOW? True only if clearance is duck (high bird) and time_to_impact_seconds is inside duck_lead_seconds. False for cacti, low birds, far hazards, or when jumping is correct.",
          criteria: {
            true: "Duck this instant — a high bird is in the duck window.",
            false: "Do not duck now.",
          },
        },
      },
    },
    {
      signal: AbortSignal.any([
        AbortSignal.timeout(2500),
        ...(signal ? [signal] : []),
      ]),
    },
  );
  const durationMs = performance.now() - start;
  return { ...parseDecideResponse(result), durationMs, source: "jev" };
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

export { heuristicDecide, pickAction };
