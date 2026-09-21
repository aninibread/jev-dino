import type {
  DecideResponse,
  DecideState,
  JevAction,
  UpcomingObstacle,
} from "../lib/jev-contract";
import { nextActionable } from "../lib/jev-contract";

function pct(n: number): string {
  return `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`;
}

function fmtObstacle(o: UpcomingObstacle): string {
  const chain = o.chain_with_next ? " chain" : "";
  const gap =
    o.gap_to_next_s > 0 ? ` gap→${o.gap_to_next_s.toFixed(2)}s` : "";
  return `${o.type} ${o.clearance} tti=${o.time_to_impact.toFixed(2)}s${gap}${chain}`;
}

function fmtWindow(upcoming: UpcomingObstacle[]): string {
  if (!upcoming.length) return "(empty)";
  return upcoming.map((o, i) => `${i + 1}.${fmtObstacle(o)}`).join(" · ");
}

function fmtDino(state: DecideState): string {
  const d = state.dino;
  if (d.grounded) return d.ducking ? "ducking" : "grounded";
  const dir = d.ascending ? "↑" : "↓";
  return `airborne ${dir} land~${d.est_landing_s.toFixed(2)}s`;
}

/** One-line snapshot of what we're asking Jev. */
export function formatJevAsk(state: DecideState): string {
  const next = nextActionable(state.upcoming);
  const focus = next ? fmtObstacle(next) : "no actionable hazard";
  return [
    `t=${state.t.toFixed(1)}s`,
    `spd=${state.speed.toFixed(1)}`,
    fmtDino(state),
    `focus: ${focus}`,
    `tactics: ${state.tactics.recommended}${state.tactics.chain_active ? " (chain)" : ""} — ${state.tactics.reason}`,
    `window: ${fmtWindow(state.upcoming)}`,
  ].join(" | ");
}

/** One-line snapshot of Jev's noul reply. */
export function formatJevReply(
  decision: DecideResponse,
  state: DecideState,
): string {
  const next = nextActionable(state.upcoming);
  return [
    decision.action.toUpperCase(),
    `jump=${pct(decision.jump_now)}`,
    `duck=${pct(decision.duck_now)}`,
    `${Math.round(decision.durationMs)}ms`,
    decision.source,
    next ? `vs ${fmtObstacle(next)}` : "clear",
  ].join(" | ");
}

/** One-line when the committed action changes. */
export function formatJevAct(
  from: JevAction,
  to: JevAction,
  decision: DecideResponse,
  state: DecideState | null,
): string {
  const next = state ? nextActionable(state.upcoming) : null;
  return [
    `${from.toUpperCase()} → ${to.toUpperCase()}`,
    `jump=${pct(decision.jump_now)} duck=${pct(decision.duck_now)}`,
    decision.source,
    next ? fmtObstacle(next) : "no hazard",
    state?.tactics.reason ? `· ${state.tactics.reason}` : "",
  ]
    .filter(Boolean)
    .join(" | ");
}

export function logJevAsk(state: DecideState): void {
  console.log(`%c[Jev ask]%c ${formatJevAsk(state)}`, "color:#0a7;font-weight:600", "color:inherit");
}

export function logJevReply(
  decision: DecideResponse,
  state: DecideState,
): void {
  const color =
    decision.action === "jump"
      ? "#c60"
      : decision.action === "duck"
        ? "#06c"
        : "#666";
  console.log(
    `%c[Jev reply]%c ${formatJevReply(decision, state)}`,
    `color:${color};font-weight:600`,
    "color:inherit",
  );
}

export function logJevAct(
  from: JevAction,
  to: JevAction,
  decision: DecideResponse,
  state: DecideState | null,
): void {
  if (from === to) return;
  const color =
    to === "jump" ? "#c60" : to === "duck" ? "#06c" : "#666";
  console.log(
    `%c[Jev act]%c ${formatJevAct(from, to, decision, state)}`,
    `color:${color};font-weight:700`,
    "color:inherit",
  );
}
