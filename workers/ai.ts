import {
  JUMP_AIRTIME_S,
  duckLeadSeconds,
  heuristicDecide,
  jumpEarliestSeconds,
  jumpLeadSeconds,
  nextActionable,
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
  const next = nextActionable(state.upcoming);
  const window = state.upcoming.slice(0, 6).map((o) => ({
    type: o.type,
    clearance: o.clearance,
    time_to_impact_seconds: Number(o.time_to_impact.toFixed(3)),
    gap_to_next_seconds: Number(o.gap_to_next_s.toFixed(3)),
    chain_with_next: o.chain_with_next,
    y: o.y,
  }));
  const result = await ai.run(
    "typesafe/jev",
    {
      state: {
        ...state,
        decision_hint: next
          ? {
              nearest_actionable: {
                type: next.type,
                clearance: next.clearance,
                time_to_impact_seconds: Number(next.time_to_impact.toFixed(3)),
                gap_to_next_seconds: Number(next.gap_to_next_s.toFixed(3)),
                chain_with_next: next.chain_with_next,
              },
              /** Every obstacle in the current lookahead window (nearest first). */
              obstacles_in_window: window,
              clearance_guide: {
                jump: "Must jump (cactus or low bird).",
                duck: "Must duck and hold through the pass.",
                either: "Jump or duck both work — prefer jump.",
                clear: "High bird — run; no jump/duck needed.",
              },
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
              chain_note:
                "chain_with_next is ONLY true when the next jumpable is closer than ~0.5s — do not speed-drop for comfortable gaps.",
            }
          : {
              nearest_actionable: null,
              obstacles_in_window: window,
              tactics_recommended: "run",
              tactics_reason: "no actionable hazard",
            },
      },
      questions: {
        jump_now: {
          type: "noul",
          instructions:
            "Should the dinosaur JUMP RIGHT NOW? Prefer decision_hint.tactics_recommended. Jump only if grounded and nearest_actionable clearance is jump/either and tti is in the LATE window (0 < tti <= jump_lead_seconds). Never jump early. If clearance is duck or clear, return near 0. If airborne, return near 0. Use obstacles_in_window to see what comes after — only set up a chain when chain_with_next is true on the current jumpable.",
          criteria: {
            true: "Grounded and inside the late jump window for a jump/either hazard.",
            false: "Too early, airborne, must duck, clear overhead bird, or not a jump hazard.",
          },
        },
        duck_now: {
          type: "noul",
          instructions:
            "Should the dinosaur DUCK or SPEED-DROP RIGHT NOW? Valid cases: (1) Grounded + clearance duck — duck and HOLD through negative tti until the bird passes. (2) Grounded + clearance either — duck is optional vs jump. (3) Airborne speed-drop ONLY when chain_active / chain_with_next is true or tactics_reason mentions speed-drop for a tight gap — never slam every consecutive obstacle. Clearance clear → near 0. Prefer tactics_recommended.",
          criteria: {
            true: "Duck under a must-duck bird (hold through pass), OR mid-air speed-drop for a TIGHT chain only.",
            false: "Do not duck or speed-drop (including clear overhead birds and comfortable gaps).",
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
