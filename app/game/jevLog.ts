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
  next_obstacles?: Array<{
    id: string;
    kind?: string;
    type?: string;
    width_px?: number;
    gap_px?: number;
    seconds_until_next?: number;
  }>;
  next_obstacle?: {
    id: string;
    kind?: string;
    type?: string;
    gap_px?: number;
    seconds_until_next?: number;
  } | null;
}): void {
  const o = body.obstacle;
  const nexts =
    body.next_obstacles ??
    (body.next_obstacle ? [body.next_obstacle] : []);
  const nextBit =
    nexts.length > 0
      ? ` next=${nexts
          .map(
            (n) =>
              `${n.kind ?? n.type}@${n.gap_px}px/${Number(n.seconds_until_next ?? 0).toFixed(2)}s`,
          )
          .join(",")}`
      : " next=none";
  console.log(
    `%c[Jev ask]%c ${o.id} ${o.kind ?? o.type} ${o.group ?? ""} ${o.flight_path ?? ""} w=${o.width_px ?? o.width} spd=${body.speed.toFixed(1)} motion=${body.dinosaur_motion}${nextBit}`,
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
    decision.action === "jump" || decision.action === "duck"
      ? ` ${decision.effectiveJumpProfile ?? decision.jump_profile}`
      : "";
  const profileBars =
    decision.action === "jump" || decision.action === "duck"
      ? ` short=${pct(decision.profile_probabilities?.short ?? 0)} full=${pct(decision.profile_probabilities?.full ?? 0)}`
      : "";
  console.log(
    `%c[Jev reply]%c ${decision.action}${profile} conf=${pct(decision.confidence)} jump=${pct(decision.probabilities?.jump ?? 0)} duck=${pct(decision.probabilities?.duck ?? 0)} run=${pct(decision.probabilities?.keep_running ?? 0)}${profileBars} ${Math.round(decision.durationMs)}ms vs ${body.obstacle.id}`,
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
