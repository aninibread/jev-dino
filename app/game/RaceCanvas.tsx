import { useEffect, useRef, useState } from "react";
import type { DecideResponse } from "../lib/jev-contract";
import { RaceGame, type RaceSnapshot, type Winner } from "./race";

function winnerCopy(winner: Winner) {
  if (winner === "you") return "You win.";
  if (winner === "jev") return "Jev wins.";
  if (winner === "tie") return "Tie.";
  return "";
}

export function RaceCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<RaceGame | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");
  const [snapshot, setSnapshot] = useState<RaceSnapshot | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    const sprite = new Image();
    sprite.src = "/offline-sprite.png";
    sprite.onload = () => {
      if (cancelled) return;
      const game = new RaceGame(canvas, sprite, {
        onChange: (next) => setSnapshot(next),
      });
      gameRef.current = game;
      setReady(true);
    };
    sprite.onerror = () => setError("Couldn’t load the dino sprites.");

    return () => {
      cancelled = true;
      gameRef.current?.destroy();
      gameRef.current = null;
    };
  }, []);

  const phase = snapshot?.phase ?? "idle";
  const lastJev: DecideResponse | null = snapshot?.lastJev ?? null;

  return (
    <div className="race-stage">
      <canvas
        ref={canvasRef}
        className="race-canvas"
        role="img"
        aria-label="Chrome dinosaur race against Jev"
      />
      {!ready && !error && (
        <p className="race-status muted">Loading track…</p>
      )}
      {error && <p className="error-card">{error}</p>}

      <div className="race-hud" aria-live="polite">
        <span>{((snapshot?.elapsedMs ?? 0) / 1000).toFixed(1)}s</span>
        <span>Speed {(snapshot?.speed ?? 0).toFixed(1)}</span>
        {lastJev && (
          <span className="jev-action">
            Jev: {lastJev.action}
            {lastJev.source === "heuristic" ? " · backup" : ""}
          </span>
        )}
      </div>

      <div className="touch-controls">
        <button
          type="button"
          onPointerDown={() => gameRef.current?.pressJump()}
        >
          Jump
        </button>
        <button
          type="button"
          onPointerDown={() => gameRef.current?.pressDuck(true)}
          onPointerUp={() => gameRef.current?.pressDuck(false)}
          onPointerLeave={() => gameRef.current?.pressDuck(false)}
          onPointerCancel={() => gameRef.current?.pressDuck(false)}
        >
          Duck
        </button>
      </div>

      <div className="race-actions">
        {phase !== "playing" && (
          <button
            type="button"
            className="primary"
            onClick={() => gameRef.current?.start()}
          >
            {phase === "ended" ? "Race again" : "Race Jev"}
          </button>
        )}
        {phase === "ended" && (
          <p className="result-line">{winnerCopy(snapshot?.winner ?? null)}</p>
        )}
      </div>
    </div>
  );
}
