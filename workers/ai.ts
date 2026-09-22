import {
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

/**
 * Ask Jev with raw lane state only — no tactics / clearance / planner hints.
 */
export async function decideWithJev(
  ai: Ai,
  state: DecideState,
  signal?: AbortSignal,
): Promise<DecideResponse> {
  const start = performance.now();
  const window = state.upcoming.slice(0, 6).map((o) => ({
    type: o.type,
    dx_px: Math.round(o.dx),
    width_px: o.width,
    height_px: o.height,
    y: o.y,
    seconds_until_reach: Number(o.time_to_impact.toFixed(3)),
  }));

  const result = await ai.run(
    "typesafe/jev",
    {
      state: {
        race_time_seconds: Number(state.t.toFixed(2)),
        speed: Number(state.speed.toFixed(2)),
        pixels_per_second: Number(state.px_per_sec.toFixed(1)),
        dino: {
          y: state.dino.y,
          vertical_velocity: state.dino.vy,
          grounded: state.dino.grounded,
          ducking: state.dino.ducking,
          ascending: state.dino.ascending,
        },
        /**
         * Same info a human has on screen: obstacles ahead, their size/height,
         * and how soon they arrive at the current scroll speed.
         * Bird y≈50 is high (often clear while standing), y≈75 mid, y≈100 low.
         * Cacti always sit on the ground — jump them.
         * Duck mid-air = fast-fall (speed-drop) like Chrome Dino.
         */
        obstacles_ahead: window,
        notes: {
          canvas_y_grows_downward: true,
          dino_ground_y_about: 93,
          standing_dino_height_px: 47,
          ducking_dino_height_px: 25,
          jump_airtime_about_seconds: 0.58,
        },
      },
      questions: {
        jump_now: {
          type: "noul",
          instructions:
            "You control the dinosaur. Looking only at obstacles_ahead and dino pose, should you JUMP RIGHT NOW? Jump for ground cacti and low birds when they are close enough to clear — not too early (you'll land on them) and not too late. Do not jump into a high bird that a standing dino would run under. If already airborne, usually near 0 (you cannot jump again until you land). Return a belief 0–1.",
          criteria: {
            true: "Jump this instant to clear the hazard.",
            false: "Do not jump now.",
          },
        },
        duck_now: {
          type: "noul",
          instructions:
            "Should you DUCK RIGHT NOW? Duck under birds that would hit a standing dino, and keep ducking until the bird has passed. Mid-air, duck means speed-drop (slam down) when you need to land sooner for a tight next obstacle. High birds that clear a standing runner → near 0. Return a belief 0–1.",
          criteria: {
            true: "Duck or speed-drop this instant.",
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

export { pickAction };
