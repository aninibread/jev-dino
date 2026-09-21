import { useEffect, useRef, useState, type ReactNode } from "react";
import { RaceCanvas } from "../game/RaceCanvas";

export function meta() {
  return [
    { title: "Dino — Race Jev" },
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
        <b>You</b> control the top dinosaur. On desktop: Space / ↑ jump, ↓ duck.
        On phones: tap the track or Jump; hold Duck for birds.
      </p>
      <p>
        <b>Jev</b> runs the bottom lane on the same obstacles, deciding jump,
        duck, or run through Workers AI.
      </p>
      <p>
        The track gets much faster over <b>60 seconds</b>. First crash loses.
        Survive the minute and distance decides.
      </p>
      <p className="muted">
        Late race is intentionally brutal. Losing is part of the sport.
      </p>
    </div>
  );
}

export default function Home() {
  const [dialog, setDialog] = useState<"rules" | "credits" | null>(null);

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
          <h1>Race Jev</h1>
          <p>Same obstacles. Faster every second. Tap or press Space to race.</p>
        </section>

        <RaceCanvas />
      </main>

      <footer className="site-footer">
        <button type="button" onClick={() => setDialog("credits")}>
          Credits
        </button>
        <a
          href="https://developers.cloudflare.com/ai/models/typesafe/jev/"
          target="_blank"
          rel="noreferrer"
        >
          Powered by Jev
        </a>
      </footer>

      {dialog === "rules" && (
        <Dialog title="How to race" onClose={() => setDialog(null)}>
          <Rules />
        </Dialog>
      )}
      {dialog === "credits" && (
        <Dialog title="Credits" onClose={() => setDialog(null)}>
          <div className="rules-content">
            <p>
              Dinosaur sprites and gameplay inspiration from Chromium’s offline
              T-Rex runner (
              <a
                href="https://github.com/wayou/t-rex-runner"
                target="_blank"
                rel="noreferrer"
              >
                wayou/t-rex-runner
              </a>
              , BSD-3-Clause).
            </p>
            <p>
              Decisions by{" "}
              <a
                href="https://developers.cloudflare.com/ai/models/typesafe/jev/"
                target="_blank"
                rel="noreferrer"
              >
                TypeSafe Jev
              </a>{" "}
              on Cloudflare Workers AI.
            </p>
          </div>
        </Dialog>
      )}
    </div>
  );
}
