import type {
  DecideResponse,
  DecideState,
  JevAction,
  UpcomingObstacle,
} from "../lib/jev-contract";

function pct(n: number): string {
  return `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`;
}

function fmtObstacle(o: UpcomingObstacle): string {
  const alt = o.bird_altitude ? ` ${o.bird_altitude}` : "";
  const jumped = o.already_jumped_for ? " jumped" : "";
  return `${o.type}${alt} ${o.relation} dx=${Math.round(o.dx)} ~${o.seconds_away.toFixed(2)}s${jumped}`;
}

function fmtWindow(visible: UpcomingObstacle[]): string {
  if (!visible.length) return "(empty)";
  return visible.map((o, i) => `${i + 1}.${fmtObstacle(o)}`).join(" · ");
}

function fmtDino(state: DecideState): string {
  const d = state.dino;
  if (d.just_landed) return "just-landed";
  if (d.grounded) return d.ducking ? "ducking" : "grounded";
  const dir = d.ascending ? "↑" : "↓";
  return `airborne ${dir} ${d.seconds_aloft.toFixed(2)}s h=${d.jump_height_frac.toFixed(2)}`;
}

function fmtMemory(state: DecideState): string {
  const c = state.controls;
  return `act=${c.previous_action}→${c.current_action} keys:j=${c.jump_key_held ? "1" : "0"}/d=${c.duck_key_held ? "1" : "0"} lastBelief j=${pct(c.last_press_jump)} d=${pct(c.last_press_duck)}`;
}

export function formatJevAsk(state: DecideState): string {
  const next = state.visible[0];
  return [
    `t=${state.t.toFixed(1)}s`,
    `spd=${state.speed.toFixed(1)}`,
    fmtDino(state),
    fmtMemory(state),
    next ? `nearest: ${fmtObstacle(next)}` : "nearest: none",
    `visible: ${fmtWindow(state.visible)}`,
  ].join(" | ");
}

export function formatJevReply(
  decision: DecideResponse,
  state: DecideState,
): string {
  const next = state.visible[0];
  return [
    decision.action.toUpperCase(),
    `jumpKey=${pct(decision.press_jump)}`,
    `duckKey=${pct(decision.press_duck)}`,
    `${Math.round(decision.durationMs)}ms`,
    decision.source,
    next ? `vs ${fmtObstacle(next)}` : "clear",
  ].join(" | ");
}

export function formatJevAct(
  from: JevAction,
  to: JevAction,
  decision: DecideResponse,
  state: DecideState | null,
): string {
  const next = state?.visible[0];
  return [
    `${from.toUpperCase()} → ${to.toUpperCase()}`,
    `jumpKey=${pct(decision.press_jump)} duckKey=${pct(decision.press_duck)}`,
    decision.source,
    next ? fmtObstacle(next) : "no hazard",
  ].join(" | ");
}

export function logJevAsk(state: DecideState): void {
  console.log(
    `%c[Jev ask]%c ${formatJevAsk(state)}`,
    "color:#0a7;font-weight:600",
    "color:inherit",
  );
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
