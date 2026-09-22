import { useEffect, useRef, useState, type ReactNode } from "react";
import { RaceCanvas } from "../game/RaceCanvas";
import type { Winner } from "../game/race";

export function meta() {
  return [
    { title: "Dino - Race Jev" },
    {
      name: "description",
      content: "Race the Chrome dinosaur against Jev. Sixty seconds. Don’t blink.",
    },
  ];
}

function Dialog({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      className="modal"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal-inner">
        <div className="modal-top">
          <h2>{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>
        {children}
      </div>
    </dialog>
  );
}

function Rules() {
  return (
    <div className="rules-content">
      <p>
        <b>You</b> control the top dinosaur. Desktop: Space / ↑ jump, ↓ duck.
        Phone: tap Jump; hold Duck for pterodactyls.
      </p>
      <p>
        <b>Jev</b> runs the bottom lane on the same course. It sees the Input
        panel, picks a <b>maneuver</b> (jump, duck, keep running) and a{" "}
        <b>profile</b> (short or full). The browser times presses.
      </p>
    </div>
  );
}

function titleFor(winner: Winner) {
  if (winner === "you") return "🥇 You win";
  if (winner === "jev") return "🥈 Jev wins";
  if (winner === "tie") return "Tie";
  return "Race Jev";
}

export default function Home() {
  const [dialog, setDialog] = useState<"rules" | null>(null);
  const [winner, setWinner] = useState<Winner>(null);

  return (
    <div className="app-shell">
      <header className="site-header">
        <button type="button" className="brand" onClick={() => window.location.reload()}>
          Dino
        </button>
        <nav>
          <button type="button" onClick={() => setDialog("rules")}>
            Rules
          </button>
        </nav>
      </header>

      <main className="page">
        <section className="intro">
          <h1>{titleFor(winner)}</h1>
        </section>

        <RaceCanvas onWinnerChange={setWinner} />
      </main>

      {dialog === "rules" && (
        <Dialog title="How to race" onClose={() => setDialog(null)}>
          <Rules />
        </Dialog>
      )}
    </div>
  );
}
