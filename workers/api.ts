import {
  type DecideState,
  type ObstacleKind,
} from "../app/lib/jev-contract";
import {
  ApiError,
  decideWithJev,
  heuristicDecide,
  publicError,
} from "./ai";

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
  const upcoming = raw.upcoming;
  if (
    typeof raw.t !== "number" ||
    typeof raw.speed !== "number" ||
    !dino ||
    typeof dino !== "object" ||
    Array.isArray(dino) ||
    !Array.isArray(upcoming)
  ) {
    throw new ApiError(400, "Invalid game state.");
  }
  const d = dino as Record<string, unknown>;
  if (
    typeof d.y !== "number" ||
    typeof d.vy !== "number" ||
    typeof d.ducking !== "boolean" ||
    typeof d.grounded !== "boolean"
  ) {
    throw new ApiError(400, "Invalid dino state.");
  }
  if (upcoming.length > 3) throw new ApiError(400, "Too many obstacles.");
  const parsedUpcoming: DecideState["upcoming"] = [];
  for (const item of upcoming) {
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
    parsedUpcoming.push({
      type: o.type as ObstacleKind,
      dx: o.dx,
      width: o.width,
      height: o.height,
      y: o.y,
    });
  }
  return {
    t: raw.t,
    speed: raw.speed,
    dino: {
      y: d.y,
      vy: d.vy,
      ducking: d.ducking,
      grounded: d.grounded,
    },
    upcoming: parsedUpcoming,
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
        new TextDecoder().decode(await limitedBody(request, 4096)),
      );
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ApiError(400, "Please send JSON.");
      }
      const state = parseState(value as Record<string, unknown>);
      try {
        const decision = await decideWithJev(env.AI, state);
        return json(decision);
      } catch (error) {
        // Keep the race alive if AI is down or rate-limited.
        console.error("jev decide failed", error);
        const fallback = heuristicDecide(state);
        return json({ ...fallback, durationMs: 0 });
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
