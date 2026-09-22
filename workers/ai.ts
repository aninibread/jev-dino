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
 * Fair prompt: visible lane + memory of what you already did. Key holds out.
 */
export async function decideWithJev(
  ai: Ai,
  state: DecideState,
  signal?: AbortSignal,
): Promise<DecideResponse> {
  const start = performance.now();
  const obstacles = state.visible.map((o, i) => ({
    index: i + 1,
    id: o.id,
    type: o.type,
    distance_px: Math.round(o.dx),
    width_px: o.width,
    height_px: o.height,
    seconds_away: Number(o.seconds_away.toFixed(3)),
    relation: o.relation,
    already_jumped_for: o.already_jumped_for,
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
          how_high_in_jump: state.dino.jump_height_frac,
          seconds_aloft: state.dino.seconds_aloft,
          just_landed: state.dino.just_landed,
          seconds_since_landed: state.dino.seconds_since_landed,
        },
        /** What you are doing / just did — like remembering your own inputs. */
        memory: {
          current_action: state.controls.current_action,
          previous_action: state.controls.previous_action,
          jump_key_currently_held: state.controls.jump_key_held,
          duck_key_currently_held: state.controls.duck_key_held,
          your_last_press_jump_belief: state.controls.last_press_jump,
          your_last_press_duck_belief: state.controls.last_press_duck,
          nearest_obstacle_id_when_this_jump_started:
            state.controls.nearest_id_when_jump_started,
          recent_action_changes: state.recent_actions,
        },
        visible_obstacles: obstacles,
        gap_between_1st_and_2nd_px: gap_1_to_2_px,
        how_to_read: {
          already_jumped_for:
            "true means you already left the ground for that obstacle — don't try to jump it again mid-air; look at the NEXT one.",
          just_landed:
            "true means feet just hit the ground — good moment to jump again if another cactus is close.",
          cactus: "On the ground — jump over it.",
          bird_high: "Overhead — usually run under (don't jump into it).",
          bird_mid: "Head height — jump or duck.",
          bird_low: "Near ground — jump.",
          duck_in_air:
            "Holding duck in the air = fast fall so you can jump sooner for a close second obstacle.",
        },
      },
      questions: {
        press_jump: {
          type: "noul",
          instructions:
            "Hold the JUMP key? Use memory + visible_obstacles. If already_jumped_for is true on the nearest obstacle and you are still in the air, you cannot jump again — keep press_jump high only if you want to jump the NEXT obstacle the instant you land. If just_landed and a not-yet-jumped cactus is close, press_jump should be high. If previous_action was jump and you're still airborne over that same cactus, don't expect another jump yet. Think ahead for consecutive obstacles. Answers persist ~0.5–1s.",
          criteria: {
            true: "Hold jump.",
            false: "Release jump.",
          },
        },
        press_duck: {
          type: "noul",
          instructions:
            "Hold the DUCK key? High for birds you must crouch under, or mid-air when already_jumped_for on #1 and a close #2 still needs a landing+jump (slam down). Use memory.current_action / previous_action and seconds_aloft. Low when a single normal jump is enough. Answers persist ~0.5–1s.",
          criteria: {
            true: "Hold duck / mid-air slam.",
            false: "Release duck.",
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
