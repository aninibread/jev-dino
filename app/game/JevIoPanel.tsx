import { useEffect, useId, useRef, useState } from "react";
import {
  EMPTY_PROBABILITIES,
  EMPTY_PROFILE_PROBABILITIES,
  TIGHT_NEXT_SECONDS,
  labelFlightPath,
  labelGroup,
  labelKind,
  labelManeuver,
  labelMotion,
  type DecideResponse,
  type JevAskView,
  type JumpProfile,
  type Maneuver,
} from "../lib/jev-contract";
import type { JevIoStatus } from "./jevController";

const MANEUVERS: Maneuver[] = ["jump", "duck", "keep_running"];
const PROFILES: JumpProfile[] = ["short", "full"];

function pct(n: number): string {
  return `${Math.round(Math.min(1, Math.max(0, n)) * 100)}%`;
}

function labelProfile(profile: JumpProfile): string {
  return profile === "short" ? "Short" : "Full";
}

function statusLabel(status: JevIoStatus, kind: "maneuver" | "profile"): string {
  const noun = kind === "maneuver" ? "Maneuver" : "Profile";
  if (status === "thinking") return `Asking ${noun.toLowerCase()}`;
  if (status === "ready") return `${noun} ready`;
  if (status === "skipped") return `${noun} skipped`;
  if (status === "late") return `${noun} too late`;
  if (status === "error") return `${noun} failed`;
  return `${noun} waiting`;
}

function StatusIcon({
  status,
  error,
  kind,
}: {
  status: JevIoStatus;
  error?: string | null;
  kind: "maneuver" | "profile";
}) {
  const tipId = useId();
  const rootRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const base = statusLabel(status, kind);
  const detail =
    status === "error" && error?.trim() ? error.trim() : null;
  const label = detail ?? base;

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="jev-io-status-wrap">
      <button
        ref={rootRef}
        type="button"
        className={`jev-io-status status-${status}`}
        title={label}
        aria-label={label}
        aria-expanded={open}
        aria-describedby={open ? tipId : undefined}
        onClick={() => setOpen((value) => !value)}
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
      </button>
      {open ? (
        <span id={tipId} className="jev-io-tooltip" role="tooltip">
          {label}
        </span>
      ) : null}
    </span>
  );
}

export function JevIoPanel({
  ask,
  decision,
  status,
  profileStatus = "idle",
  error,
  profileError,
  active,
}: {
  ask: JevAskView | null;
  decision: DecideResponse | null;
  status: JevIoStatus;
  profileStatus?: JevIoStatus;
  error?: string | null;
  profileError?: string | null;
  active: boolean;
}) {
  // Sticky bars so output never flashes empty between asks / while profile loads.
  const stickyProbs = useRef({ ...EMPTY_PROBABILITIES });
  const stickyProfileProbs = useRef({ ...EMPTY_PROFILE_PROBABILITIES });
  const stickyChosen = useRef<Maneuver | null>(null);
  const stickyChosenProfile = useRef<JumpProfile | null>(null);

  const incomingProbs = decision?.probabilities;
  if (
    incomingProbs &&
    (incomingProbs.jump ?? 0) +
      (incomingProbs.duck ?? 0) +
      (incomingProbs.keep_running ?? 0) >
      0.01
  ) {
    stickyProbs.current = incomingProbs;
    stickyChosen.current = decision?.action ?? null;
  }

  const incomingProfile = decision?.profile_probabilities;
  if (
    incomingProfile &&
    (incomingProfile.short ?? 0) + (incomingProfile.full ?? 0) > 0.01
  ) {
    stickyProfileProbs.current = incomingProfile;
    stickyChosenProfile.current =
      decision?.action === "jump" || decision?.action === "duck"
        ? decision.jump_profile
        : stickyChosenProfile.current;
  } else if (
    decision?.action === "jump" ||
    decision?.action === "duck"
  ) {
    stickyChosenProfile.current = decision.jump_profile;
  }

  const probs = stickyProbs.current;
  const chosen = stickyChosen.current;
  const profileProbs = stickyProfileProbs.current;
  const chosenProfile = stickyChosenProfile.current;
  const next = ask?.next_obstacle ?? null;
  const nextLabel = next
    ? `${labelKind(next.kind)} ${labelGroup(next.group)}`
    : "–";
  const gapLabel = next
    ? `${next.gap_px}px / ${next.seconds_until_next.toFixed(2)}s${
        next.seconds_until_next <= TIGHT_NEXT_SECONDS ? " tight" : ""
      }`
    : "–";

  return (
    <section
      className={`jev-io ${active ? "is-active" : ""}`}
      aria-live="polite"
      aria-label="Jev input and output"
    >
      <header className="jev-io-head">
        <h2>Jev</h2>
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

          <div className="jev-io-section-head">
            <span>Maneuver</span>
            <StatusIcon status={status} error={error} kind="maneuver" />
          </div>
          <ul className="jev-probs" aria-label="Maneuver">
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

          <div className="jev-io-section-head jev-io-section-head-profile">
            <span>Profile</span>
            <StatusIcon
              status={profileStatus}
              error={profileError}
              kind="profile"
            />
          </div>
          <ul className="jev-probs jev-probs-profile" aria-label="Jump profile">
            {PROFILES.map((key) => {
              const value = profileProbs[key] ?? 0;
              return (
                <li
                  key={key}
                  className={chosenProfile === key ? "is-chosen" : undefined}
                >
                  <div className="jev-prob-label">
                    <span>{labelProfile(key)}</span>
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
