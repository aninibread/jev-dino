import {
  JUMP_AIRTIME_S,
  duckLeadSeconds,
  heuristicDecide,
  jumpEarliestSeconds,
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
  const second = state.upcoming[1];
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
              gap_to_next_seconds: Number(next.gap_to_next_s.toFixed(3)),
              chain_with_next: next.chain_with_next,
              follow_up: second
                ? {
                    type: second.type,
                    clearance: second.clearance,
                    time_to_impact_seconds: Number(
                      second.time_to_impact.toFixed(3),
                    ),
                  }
                : null,
              jump_lead_seconds: Number(
                jumpLeadSeconds(next.width, state.speed).toFixed(3),
              ),
              jump_earliest_seconds: Number(
                jumpEarliestSeconds(next.width, state.speed).toFixed(3),
              ),
              jump_airtime_seconds: JUMP_AIRTIME_S,
              duck_lead_seconds: Number(
                duckLeadSeconds(state.speed).toFixed(3),
              ),
              grounded: state.dino.grounded,
              ascending: state.dino.ascending,
              est_landing_seconds: state.dino.est_landing_s,
              tactics_recommended: state.tactics.recommended,
              tactics_reason: state.tactics.reason,
              chain_active: state.tactics.chain_active,
            }
          : null,
      },
      questions: {
        jump_now: {
          type: "noul",
          instructions:
            "Should the dinosaur JUMP RIGHT NOW? Prefer decision_hint.tactics_recommended when present. Jump only if grounded and time_to_impact_seconds is in the LATE window (roughly 0 < tti <= jump_lead_seconds). Never jump early (tti near jump_earliest_seconds) — airtime is ~jump_airtime_seconds and early jumps land on cacti. If clearance is duck, return near 0. If airborne, return near 0 (cannot jump). If chain_with_next is true, still jump in the late window for the nearest cactus — the browser will speed-drop after.",
          criteria: {
            true: "Grounded and inside the late jump window — jump now.",
            false: "Too early, airborne, must duck, or not a jump hazard.",
          },
        },
        duck_now: {
          type: "noul",
          instructions:
            "Should the dinosaur DUCK or SPEED-DROP RIGHT NOW? Two valid cases: (1) Grounded + clearance duck + tti within duck_lead_seconds BEFORE impact through a short NEGATIVE tti AFTER impact (hold crouch until the bird fully passes — standing early hits it). (2) Airborne chaining: ascending is false, and either tactics_reason mentions speed-drop / chain, or chain_with_next with tti small, or nearest jumpable is 0.2–0.65s away while still airborne → duck to slam down (speed-drop) so the next jump can happen sooner. Otherwise near 0. Prefer decision_hint.tactics_recommended === duck.",
          criteria: {
            true: "Duck under a bird and KEEP ducking through the pass, OR mid-air speed-drop to chain the next jump.",
            false: "Do not duck or speed-drop.",
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
