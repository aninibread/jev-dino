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
  airborne: boolean,
): Omit<DecideResponse, "durationMs" | "source"> {
  // Prefer press_*; fall back to legacy jump_now/duck_now names.
  const press_jump =
    findNoul(value, "press_jump") ?? findNoul(value, "jump_now");
  const press_duck =
    findNoul(value, "press_duck") ?? findNoul(value, "duck_now");
  if (press_jump === null || press_duck === null) {
    throw new ApiError(502, "Jev returned an unreadable answer.");
  }
  const action = pickAction(press_jump, press_duck, airborne);
  return {
    action,
    press_jump,
    press_duck,
    confidence: Math.max(
      press_jump,
      press_duck,
      1 - Math.max(press_jump, press_duck),
    ),
  };
}

/**
 * Fair prompt: visible lane + key holds. No tactics / clearance / engine cheats.
 */
export async function decideWithJev(
  ai: Ai,
  state: DecideState,
  signal?: AbortSignal,
): Promise<DecideResponse> {
  const start = performance.now();
  const obstacles = state.visible.map((o, i) => ({
    index: i + 1,
    type: o.type,
    distance_px: Math.round(o.dx),
    width_px: o.width,
    height_px: o.height,
    seconds_away: Number(o.seconds_away.toFixed(3)),
    ...(o.bird_altitude ? { bird_altitude: o.bird_altitude } : {}),
  }));

  const gap_1_to_2_px =
    state.visible.length >= 2
      ? Math.round(state.visible[1]!.dx - state.visible[0]!.dx)
      : null;

  const result = await ai.run(
    "typesafe/jev",
    {
      state: {
        race_time_seconds: Number(state.t.toFixed(2)),
        speed: Number(state.speed.toFixed(2)),
        dino: {
          on_ground: state.dino.grounded,
          ducking: state.dino.ducking,
          in_the_air: state.dino.airborne,
          rising: state.dino.ascending,
          how_high_in_jump: Number(state.dino.jump_height_frac.toFixed(2)),
        },
        /** Everything currently on the runway ahead of you (nearest first). */
        visible_obstacles: obstacles,
        gap_between_1st_and_2nd_px: gap_1_to_2_px,
        how_to_read: {
          cactus: "On the ground — you must jump over it.",
          bird_high: "Flies overhead — usually run under it (don't jump into it).",
          bird_mid: "Around head height — jump or duck.",
          bird_low: "Near the ground — jump over it.",
          duck_in_air:
            "Holding duck while airborne makes you fall fast (like Chrome Dino) so you can jump again sooner for a close second obstacle.",
        },
      },
      questions: {
        press_jump: {
          type: "noul",
          instructions:
            "You play like a human holding the JUMP key. Look at ALL visible_obstacles, not just the first. Return high if you want the jump key HELD now: e.g. a cactus (or low bird) is close enough to clear, or you just landed and the next cactus still needs a jump. Return low if you should release jump (too early, already clearing by running under a high bird, or you need to duck instead). If you are in the air you cannot jump again — press_jump can stay high to jump the moment you land for a second obstacle. Answers are held until the next update (~0.5–1s), so think a step ahead.",
          criteria: {
            true: "Hold the jump key.",
            false: "Do not hold jump.",
          },
        },
        press_duck: {
          type: "noul",
          instructions:
            "You play like a human holding the DUCK key. High when: (1) a mid/low-ish bird needs crouching under, keep held until it passes; or (2) you are IN THE AIR after jumping the first of two CLOSE obstacles (small gap_between_1st_and_2nd_px / second still soon) and should slam down to land in time for the next jump. Low for high birds you can run under, and low when a normal single jump is enough. Mid-air duck = fast fall. Answers are held until the next update.",
          criteria: {
            true: "Hold the duck key (or mid-air slam).",
            false: "Do not hold duck.",
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
  return {
    ...parseDecideResponse(result, state.dino.airborne),
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
