import {
  EMPTY_PROBABILITIES,
  TIGHT_NEXT_SECONDS,
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
  if (status === "thinking") return "Asking Jev";
  if (status === "ready") return "Plan ready";
  if (status === "skipped") return "Skipped";
  if (status === "late") return "Too late";
  if (status === "error") return "Request failed";
  return "Waiting";
}

function StatusIcon({
  status,
  error,
}: {
  status: JevIoStatus;
  error?: string | null;
}) {
  const label =
    status === "error" && error?.trim()
      ? error.trim()
      : statusLabel(status);
  return (
    <span
      className={`jev-io-status status-${status}`}
      title={label}
      aria-label={label}
      role="img"
    >
      {status === "thinking" ? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle
            className="jev-io-spin"
            cx="8"
            cy="8"
            r="5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeDasharray="18 12"
          />
        </svg>
      ) : status === "ready" ? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M3.5 8.2 6.6 11.2 12.5 4.8"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : status === "skipped" || status === "late" ? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r="5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
          <path
            d="M5 8h6"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      ) : status === "error" ? (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <path
            d="M4.5 4.5 11.5 11.5M11.5 4.5 4.5 11.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.75"
            strokeLinecap="round"
          />
        </svg>
      ) : (
        <svg viewBox="0 0 16 16" aria-hidden="true">
          <circle
            cx="8"
            cy="8"
            r="5.5"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeDasharray="2.5 2"
          />
        </svg>
      )}
    </span>
  );
}

export function JevIoPanel({
  ask,
  decision,
  status,
  error,
  active,
}: {
  ask: JevAskView | null;
  decision: DecideResponse | null;
  status: JevIoStatus;
  error?: string | null;
  active: boolean;
}) {
  // Keep the last probabilities mounted so the right column does not flash away
  // while the next ask is in flight.
  const probs = decision?.probabilities ?? EMPTY_PROBABILITIES;
  const chosen = decision?.action;
  const next = ask?.next_obstacle ?? null;
  const nextLabel = next
    ? `${labelKind(next.kind)} ${labelGroup(next.group)}`
    : "–";
  const gapLabel = next
    ? `${next.gap_px}px / ${next.seconds_until_next.toFixed(2)}s${
        next.seconds_until_next <= TIGHT_NEXT_SECONDS ? " tight" : ""
      }`
    : "–";
  const profileLabel =
    decision?.action === "jump" ? decision.jump_profile : "–";

  return (
    <section
      className={`jev-io ${active ? "is-active" : ""}`}
      aria-live="polite"
      aria-label="Jev input and output"
    >
      <header className="jev-io-head">
        <h2>Jev</h2>
        <StatusIcon status={status} error={error} />
      </header>

      <div className="jev-io-grid">
        <div className="jev-io-col">
          <h3>Input</h3>
          <dl className="jev-io-facts">
            <div>
              <dt>Obstacle</dt>
              <dd>
                {ask
                  ? `${labelKind(ask.obstacle.kind)} ${labelGroup(ask.obstacle.group)}`
                  : "–"}
              </dd>
            </div>
            <div>
              <dt>Path</dt>
              <dd>{ask ? labelFlightPath(ask.obstacle.flight_path) : "–"}</dd>
            </div>
            <div>
              <dt>Width</dt>
              <dd>{ask ? `${ask.obstacle.width_px}px` : "–"}</dd>
            </div>
            <div>
              <dt>Speed</dt>
              <dd>{ask ? ask.speed.toFixed(1) : "–"}</dd>
            </div>
            <div>
              <dt>Motion at ask</dt>
              <dd>{ask ? labelMotion(ask.dinosaur_motion) : "–"}</dd>
            </div>
            <div>
              <dt>Next</dt>
              <dd>{nextLabel}</dd>
            </div>
            <div>
              <dt>Gap to next</dt>
              <dd>{gapLabel}</dd>
            </div>
          </dl>
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
          <dl className="jev-io-facts">
            <div>
              <dt>Jump profile</dt>
              <dd>{profileLabel}</dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
