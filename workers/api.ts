import {
  birdAltitude,
  flightPathFor,
  toGroup,
  toSemanticKind,
  type DecideResponse,
  type DecideState,
  type DinosaurMotion,
  type ObstacleKind,
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
const motions: DinosaurMotion[] = ["running", "jumping", "ducking"];

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
  const obstacle = raw.obstacle;
  if (
    typeof raw.speed !== "number" ||
    !obstacle ||
    typeof obstacle !== "object" ||
    Array.isArray(obstacle)
  ) {
    throw new ApiError(400, "Invalid game state.");
  }
  const o = obstacle as Record<string, unknown>;
  const type =
    o.type === "cactus-small" ||
    o.type === "cactus-large" ||
    o.type === "bird"
      ? (o.type as ObstacleKind)
      : o.kind === "small_cactus"
        ? "cactus-small"
        : o.kind === "large_cactus"
          ? "cactus-large"
          : o.kind === "pterodactyl"
            ? "bird"
            : null;
  if (!type || !kinds.includes(type)) {
    throw new ApiError(400, "Invalid obstacle type.");
  }
  if (typeof o.id !== "string" || !o.id) {
    throw new ApiError(400, "Obstacle needs an id.");
  }
  const size = typeof o.size === "number" ? o.size : 1;
  const width =
    typeof o.width_px === "number"
      ? o.width_px
      : typeof o.width === "number"
        ? o.width
        : 17;
  const y = typeof o.y === "number" ? o.y : 100;
  const alt =
    type === "bird"
      ? o.bird_altitude === "high" ||
        o.bird_altitude === "mid" ||
        o.bird_altitude === "low"
        ? o.bird_altitude
        : birdAltitude(y)
      : undefined;

  const motion =
    typeof raw.dinosaur_motion === "string" &&
    motions.includes(raw.dinosaur_motion as DinosaurMotion)
      ? (raw.dinosaur_motion as DinosaurMotion)
      : "running";

  return {
    speed: raw.speed,
    dinosaur_motion: motion,
    obstacle: {
      id: o.id,
      kind: toSemanticKind(type),
      group: toGroup(size),
      flight_path: flightPathFor(type, alt),
      width_px: Math.round(width),
    },
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
        new TextDecoder().decode(await limitedBody(request, 8_192)),
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
            action: "keep_running" as const,
            jump_profile: "full" as const,
            confidence: 0,
            press_jump: 0,
            press_duck: 0,
            durationMs: 0,
            source: "none" as const,
            obstacle_id: state.obstacle.id,
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
