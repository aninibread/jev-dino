import { useEffect, useRef, useState } from "react";
import { JevIoPanel } from "./JevIoPanel";
import { RaceGame, type RaceSnapshot, type Winner } from "./race";

export function RaceCanvas({
  onWinnerChange,
}: {
  onWinnerChange?: (winner: Winner) => void;
}) {
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
        onChange: (next) => {
          setSnapshot(next);
          if (next.phase === "ended" || next.phase === "spectating") {
            onWinnerChange?.(next.winner);
          } else {
            onWinnerChange?.(null);
          }
        },
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
  }, [onWinnerChange]);

  useEffect(() => {
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
  const spectateLeft = Math.ceil((snapshot?.spectateLeftMs ?? 0) / 1000);
  const raceLive =
    phase === "playing" || phase === "spectating" || phase === "ended";

  function onJumpPointer(event: React.PointerEvent) {
    event.preventDefault();
    gameRef.current?.pressJump();
  }

  function onDuckPointer(event: React.PointerEvent, down: boolean) {
    event.preventDefault();
    gameRef.current?.pressDuck(down);
  }

  function onRaceAgain(event: React.PointerEvent) {
    event.preventDefault();
    gameRef.current?.start();
  }

  return (
    <div className={`race-stage phase-${phase}`}>
      <div className="race-frame">
        <canvas
          ref={canvasRef}
          className="race-canvas"
          role="img"
          aria-label="Chrome dinosaur race against Jev. Tap to jump."
        />
        <div className="race-hud" aria-live="polite">
          <span>{((snapshot?.elapsedMs ?? 0) / 1000).toFixed(1)}s</span>
          <span>Speed {(snapshot?.speed ?? 0).toFixed(1)}</span>
        </div>
      </div>

      {!ready && !error && (
        <p className="race-status muted">Loading track...</p>
      )}
      {error && <p className="error-card">{error}</p>}

      <JevIoPanel
        ask={snapshot?.lastJevAsk ?? null}
        decision={snapshot?.lastJev ?? null}
        status={snapshot?.jevIoStatus ?? "idle"}
        profileStatus={snapshot?.jevProfileStatus ?? "idle"}
        error={snapshot?.jevIoError ?? null}
        profileError={snapshot?.jevProfileError ?? null}
        active={raceLive}
      />

      <div className="touch-controls" aria-label="Touch controls">
        {phase === "ended" ? (
          <div className="touch-ended">
            <button
              type="button"
              className="touch-btn touch-again"
              onPointerDown={onRaceAgain}
            >
              Race again
            </button>
          </div>
        ) : phase === "spectating" ? (
          <div className="touch-ended">
            <p className="touch-result">Watching Jev</p>
            <p className="touch-spectate-meta muted">
              {spectateLeft}s left · tap Race again anytime
            </p>
            <button
              type="button"
              className="touch-btn touch-again"
              onPointerDown={onRaceAgain}
            >
              Race again
            </button>
          </div>
        ) : (
          <>
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
          </>
        )}
      </div>

      <div className="race-actions">
        {phase === "idle" && (
          <button
            type="button"
            className="primary"
            onClick={() => gameRef.current?.start()}
          >
            Race Jev
          </button>
        )}
        {(phase === "ended" || phase === "spectating") && (
          <button
            type="button"
            className="primary"
            onClick={() => gameRef.current?.start()}
          >
            Race again
          </button>
        )}
      </div>
    </div>
  );
}
