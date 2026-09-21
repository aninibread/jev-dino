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

  useEffect(() => {
    // If duck is held and the pointer ends anywhere, release it.
    function releaseDuck() {
      gameRef.current?.pressDuck(false);
    }
    window.addEventListener("pointerup", releaseDuck);
    window.addEventListener("pointercancel", releaseDuck);
    window.addEventListener("blur", releaseDuck);
    return () => {
      window.removeEventListener("pointerup", releaseDuck);
      window.removeEventListener("pointercancel", releaseDuck);
      window.removeEventListener("blur", releaseDuck);
    };
  }, []);

  const phase = snapshot?.phase ?? "idle";
  const lastJev: DecideResponse | null = snapshot?.lastJev ?? null;

  function onJumpPointer(event: React.PointerEvent) {
    event.preventDefault();
    gameRef.current?.pressJump();
  }

  function onDuckPointer(event: React.PointerEvent, down: boolean) {
    event.preventDefault();
    gameRef.current?.pressDuck(down);
  }

  return (
    <div className="race-stage">
      <canvas
        ref={canvasRef}
        className="race-canvas"
        role="img"
        aria-label="Chrome dinosaur race against Jev. Tap to jump."
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
            {typeof lastJev.jump_now === "number"
              ? ` · j${Math.round(lastJev.jump_now * 100)}`
              : ""}
            {lastJev.source === "heuristic" ? " · backup" : ""}
          </span>
        )}
      </div>

      <div className="touch-controls" aria-label="Touch controls">
        <button
          type="button"
          className="touch-btn touch-jump"
          onPointerDown={onJumpPointer}
        >
          Jump
        </button>
        <button
          type="button"
          className="touch-btn touch-duck"
          onPointerDown={(event) => onDuckPointer(event, true)}
          onPointerUp={(event) => onDuckPointer(event, false)}
          onPointerLeave={(event) => onDuckPointer(event, false)}
          onPointerCancel={(event) => onDuckPointer(event, false)}
        >
          Duck
        </button>
      </div>

      <p className="touch-hint muted">Tap the track or Jump. Hold Duck for birds.</p>

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
