import type { DecideResponse } from "../lib/jev-contract";

function pct(n: number): string {
  return `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`;
}

export function logJevAsk(body: {
  speed: number;
  dinosaur_motion: string;
  obstacle: {
    id: string;
    kind?: string;
    type?: string;
    group?: string;
    flight_path?: string;
    width_px?: number;
    width?: number;
  };
}): void {
  const o = body.obstacle;
  console.log(
    `%c[Jev ask]%c ${o.id} ${o.kind ?? o.type} ${o.group ?? ""} ${o.flight_path ?? ""} w=${o.width_px ?? o.width} spd=${body.speed.toFixed(1)} motion=${body.dinosaur_motion}`,
    "color:#0a7;font-weight:600",
    "color:inherit",
  );
}

export function logJevReply(
  decision: DecideResponse & { effectiveJumpProfile?: string },
  body: { obstacle: { id: string } },
): void {
  const color =
    decision.action === "jump"
      ? "#c60"
      : decision.action === "duck"
        ? "#06c"
        : "#666";
  const profile =
    decision.action === "jump"
      ? ` ${decision.effectiveJumpProfile ?? decision.jump_profile}`
      : "";
  console.log(
    `%c[Jev reply]%c ${decision.action}${profile} conf=${pct(decision.confidence)} ${Math.round(decision.durationMs)}ms vs ${body.obstacle.id}`,
    `color:${color};font-weight:600`,
    "color:inherit",
  );
}

export function logJevAct(
  from: string,
  to: string,
  decision: DecideResponse,
  _state: unknown,
): void {
  if (from === to) return;
  const color = to === "jump" ? "#c60" : to === "duck" ? "#06c" : "#666";
  console.log(
    `%c[Jev act]%c ${from.toUpperCase()} → ${to.toUpperCase()} (${decision.obstacle_id})`,
    `color:${color};font-weight:700`,
    "color:inherit",
  );
}
