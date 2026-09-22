import {
  EMPTY_PROBABILITIES,
  labelFlightPath,
  labelGroup,
  labelKind,
  labelManeuver,
  labelMotion,
  type DecideResponse,
  type JevAskView,
  type Maneuver,
} from "../lib/jev-contract";
import type { JevIoStatus } from "./jevController";

const MANEUVERS: Maneuver[] = ["jump", "duck", "keep_running"];

function pct(n: number): string {
  return `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`;
}

function statusLabel(status: JevIoStatus): string {
  if (status === "thinking") return "Asking Jev...";
  if (status === "ready") return "Plan ready";
  if (status === "skipped") return "Skipped (low confidence)";
  if (status === "late") return "Too late, skipped";
  if (status === "error") return "Request failed";
  return "Waiting for obstacles";
}

export function JevIoPanel({
  ask,
  decision,
  status,
  active,
}: {
  ask: JevAskView | null;
  decision: DecideResponse | null;
  status: JevIoStatus;
  active: boolean;
}) {
  // Keep the last probabilities mounted so the right column does not flash away
  // while the next ask is in flight.
  const probs = decision?.probabilities ?? EMPTY_PROBABILITIES;
  const chosen = decision?.action;

  return (
    <section
      className={`jev-io ${active ? "is-active" : ""}`}
      aria-live="polite"
      aria-label="Jev input and output"
    >
      <header className="jev-io-head">
        <h2>Jev</h2>
        <span className={`jev-io-status status-${status}`}>
          {statusLabel(status)}
        </span>
      </header>

      <div className="jev-io-grid">
        <div className="jev-io-col">
          <h3>Input</h3>
          {ask ? (
            <dl className="jev-io-facts">
              <div>
                <dt>Obstacle</dt>
                <dd>
                  {labelKind(ask.obstacle.kind)} {labelGroup(ask.obstacle.group)}
                </dd>
              </div>
              <div>
                <dt>Path</dt>
                <dd>{labelFlightPath(ask.obstacle.flight_path)}</dd>
              </div>
              <div>
                <dt>Width</dt>
                <dd>{ask.obstacle.width_px}px</dd>
              </div>
              <div>
                <dt>Speed</dt>
                <dd>{ask.speed.toFixed(1)}</dd>
              </div>
              <div>
                <dt>Motion at ask</dt>
                <dd>{labelMotion(ask.dinosaur_motion)}</dd>
              </div>
              <div>
                <dt>Id</dt>
                <dd className="mono">{ask.obstacle.id}</dd>
              </div>
            </dl>
          ) : (
            <p className="jev-io-empty">No ask yet. Start a race.</p>
          )}
        </div>

        <div className="jev-io-col">
          <h3>Output</h3>
          <ul className="jev-probs">
            {MANEUVERS.map((key) => {
              const value = probs[key] ?? 0;
              return (
                <li
                  key={key}
                  className={chosen === key ? "is-chosen" : undefined}
                >
                  <div className="jev-prob-label">
                    <span>{labelManeuver(key)}</span>
                    <strong>{pct(value)}</strong>
                  </div>
                  <div
                    className="jev-prob-track"
                    role="presentation"
                    aria-hidden="true"
                  >
                    <div
                      className="jev-prob-fill"
                      style={{ width: pct(value) }}
                    />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </section>
  );
}
