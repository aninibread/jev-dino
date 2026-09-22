import {
  birdAltitude,
  flightPathFor,
  toGroup,
  toSemanticKind,
  type DecideResponse,
  type DecideState,
  type DinosaurMotion,
  type NextObstacleContext,
  type ObstacleDecisionState,
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

function parseObstacle(
  raw: Record<string, unknown>,
  label: string,
): ObstacleDecisionState & {
  type: ObstacleKind;
  size: number;
  y: number;
  bird_altitude?: "high" | "mid" | "low";
} {
  const type =
    raw.type === "cactus-small" ||
    raw.type === "cactus-large" ||
    raw.type === "bird"
      ? (raw.type as ObstacleKind)
      : raw.kind === "small_cactus"
        ? "cactus-small"
        : raw.kind === "large_cactus"
          ? "cactus-large"
          : raw.kind === "pterodactyl"
            ? "bird"
            : null;
  if (!type || !kinds.includes(type)) {
    throw new ApiError(400, `Invalid ${label} type.`);
  }
  if (typeof raw.id !== "string" || !raw.id) {
    throw new ApiError(400, `${label} needs an id.`);
  }
  const size = typeof raw.size === "number" ? raw.size : 1;
  const width =
    typeof raw.width_px === "number"
      ? raw.width_px
      : typeof raw.width === "number"
        ? raw.width
        : 17;
  const y = typeof raw.y === "number" ? raw.y : 100;
  const alt =
    type === "bird"
      ? raw.bird_altitude === "high" ||
        raw.bird_altitude === "mid" ||
        raw.bird_altitude === "low"
        ? raw.bird_altitude
        : birdAltitude(y)
      : undefined;

  return {
    id: raw.id,
    type,
    size,
    y,
    bird_altitude: alt,
    kind: toSemanticKind(type),
    group: toGroup(size),
    flight_path: flightPathFor(type, alt),
    width_px: Math.round(width),
  };
}

function parseNextObstacle(
  raw: unknown,
  speed: number,
): NextObstacleContext | null {
  if (raw == null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new ApiError(400, "Invalid next_obstacle.");
  }
  const value = raw as Record<string, unknown>;
  const parsed = parseObstacle(value, "next_obstacle");
  const gap_px =
    typeof value.gap_px === "number" && Number.isFinite(value.gap_px)
      ? Math.max(0, Math.round(value.gap_px))
      : 0;
  const seconds_until_next =
    typeof value.seconds_until_next === "number" &&
    Number.isFinite(value.seconds_until_next)
      ? Math.max(0, value.seconds_until_next)
      : gap_px / Math.max(speed * 60, 0.1);

  return {
    id: parsed.id,
    kind: parsed.kind,
    group: parsed.group,
    flight_path: parsed.flight_path,
    width_px: parsed.width_px,
    gap_px,
    seconds_until_next,
  };
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

  const motion =
    typeof raw.dinosaur_motion === "string" &&
    motions.includes(raw.dinosaur_motion as DinosaurMotion)
      ? (raw.dinosaur_motion as DinosaurMotion)
      : "running";

  const parsed = parseObstacle(obstacle as Record<string, unknown>, "obstacle");

  return {
    speed: raw.speed,
    dinosaur_motion: motion,
    obstacle: {
      id: parsed.id,
      kind: parsed.kind,
      group: parsed.group,
      flight_path: parsed.flight_path,
      width_px: parsed.width_px,
    },
    next_obstacle: parseNextObstacle(raw.next_obstacle, raw.speed),
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
            probabilities: {
              jump: 0,
              duck: 0,
              keep_running: 0,
            },
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
