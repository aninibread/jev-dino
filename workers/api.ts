import {
  birdAltitude,
  pickAction,
  type DecideResponse,
  type DecideState,
  type ObstacleKind,
  VISIBLE_COUNT,
} from "../app/lib/jev-contract";
import { ApiError, decideWithJev, publicError } from "./ai";

const json = (body: unknown, status = 200) =>
  Response.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });

const kinds: ObstacleKind[] = ["cactus-small", "cactus-large", "bird"];

async function limitedBody(request: Request, limit: number): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > limit) {
    throw new ApiError(413, "That request is too large.");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "Please include a request body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new ApiError(413, "That request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function parseState(raw: Record<string, unknown>): DecideState {
  const dino = raw.dino;
  const visible = raw.visible ?? raw.upcoming;
  if (
    typeof raw.t !== "number" ||
    typeof raw.speed !== "number" ||
    !dino ||
    typeof dino !== "object" ||
    Array.isArray(dino) ||
    !Array.isArray(visible)
  ) {
    throw new ApiError(400, "Invalid game state.");
  }
  const d = dino as Record<string, unknown>;
  const grounded = typeof d.grounded === "boolean" ? d.grounded : true;
  const ducking = typeof d.ducking === "boolean" ? d.ducking : false;
  const airborne =
    typeof d.airborne === "boolean" ? d.airborne : !grounded;
  const ascending =
    typeof d.ascending === "boolean" ? d.ascending : false;
  const jump_height_frac =
    typeof d.jump_height_frac === "number" ? d.jump_height_frac : 0;

  if (visible.length > VISIBLE_COUNT) {
    throw new ApiError(400, "Too many obstacles.");
  }

  const px_per_sec =
    typeof raw.px_per_sec === "number" && raw.px_per_sec > 0
      ? raw.px_per_sec
      : Math.max(raw.speed, 0.1) * 60;

  const parsed: DecideState["visible"] = [];
  for (const item of visible) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new ApiError(400, "Invalid obstacle.");
    }
    const o = item as Record<string, unknown>;
    if (
      !kinds.includes(o.type as ObstacleKind) ||
      typeof o.dx !== "number" ||
      typeof o.width !== "number" ||
      typeof o.height !== "number" ||
      typeof o.y !== "number"
    ) {
      throw new ApiError(400, "Invalid obstacle fields.");
    }
    const type = o.type as ObstacleKind;
    const seconds_away =
      typeof o.seconds_away === "number"
        ? o.seconds_away
        : typeof o.time_to_impact === "number"
          ? o.time_to_impact
          : o.dx / px_per_sec;
    parsed.push({
      type,
      dx: o.dx,
      width: o.width,
      height: o.height,
      y: o.y,
      seconds_away,
      bird_altitude:
        type === "bird"
          ? o.bird_altitude === "high" ||
            o.bird_altitude === "mid" ||
            o.bird_altitude === "low"
            ? o.bird_altitude
            : birdAltitude(o.y)
          : undefined,
    });
  }

  return {
    t: raw.t,
    speed: raw.speed,
    px_per_sec,
    dino: {
      grounded,
      ducking,
      airborne,
      ascending,
      jump_height_frac,
    },
    visible: parsed,
  };
}

export async function handleApi(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  try {
    if (url.pathname === "/api/jev-decide" && request.method === "POST") {
      const value: unknown = JSON.parse(
        new TextDecoder().decode(await limitedBody(request, 12_288)),
      );
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ApiError(400, "Please send JSON.");
      }
      const state = parseState(value as Record<string, unknown>);
      try {
        const decision = await decideWithJev(env.AI, state);
        return json(decision);
      } catch (error) {
        console.error("jev decide failed", error);
        const { status, message } = publicError(error);
        return json(
          {
            action: "run" as const,
            press_jump: 0,
            press_duck: 0,
            confidence: 0,
            durationMs: 0,
            source: "none" as const,
            error: message,
          } satisfies DecideResponse & { error: string },
          status >= 500 ? 502 : status,
        );
      }
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return json({ ok: true });
    }

    return json({ error: "Not found." }, 404);
  } catch (error) {
    const { status, message } = publicError(error);
    return json({ error: message }, status);
  }
}

export { pickAction };
