import {
  LOOKAHEAD_COUNT,
  LOOKAHEAD_S,
  pickAction,
  type DecideResponse,
  type DecideState,
  type JevAction,
} from "../lib/jev-contract";
import { logJevAct, logJevAsk, logJevReply } from "./jevLog";

export type JevControllerOptions = {
  getState: () => DecideState | null;
  onDecision: (decision: DecideResponse) => void;
  intervalMs?: number;
};

/**
 * Pure Jev control: raw window in → jump_now / duck_now out → action.
 * No local planner, tactics, or physics override.
 */
export class JevController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameHook: number | null = null;
  private inflight: AbortController | null = null;
  private lastAction: JevAction = "run";
  private lastDecision: DecideResponse | null = null;
  private jumpBelief = 0;
  private duckBelief = 0;
  private lastAskKey = "";
  private options: Required<Pick<JevControllerOptions, "intervalMs">> &
    JevControllerOptions;
  running = false;

  constructor(options: JevControllerOptions) {
    this.options = { intervalMs: 90, ...options };
  }

  get action() {
    return this.lastAction;
  }

  get decision() {
    return this.lastDecision;
  }

  start() {
    this.stop();
    this.running = true;
    this.lastAction = "run";
    this.jumpBelief = 0;
    this.duckBelief = 0;
    this.lastAskKey = "";
    this.lastDecision = null;
    console.log(
      "%c[Jev]%c raw-window mode — Jev owns jump/duck (no local tactics)",
      "color:#0a7;font-weight:700",
      "color:inherit",
    );
    this.timer = setInterval(() => void this.askJev(), this.options.intervalMs);
    void this.askJev();
    const tick = () => {
      if (!this.running) return;
      this.applyBeliefs();
      this.frameHook = requestAnimationFrame(tick);
    };
    this.frameHook = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.frameHook) cancelAnimationFrame(this.frameHook);
    this.frameHook = null;
    this.inflight?.abort();
    this.inflight = null;
  }

  /** Map current nouls → run / jump / duck. Nothing else votes. */
  private applyBeliefs() {
    const state = this.options.getState();
    if (!state) return;

    const next = state.upcoming[0];
    // No hazard in view — release held actions; don't act on stale beliefs.
    if (!next || next.time_to_impact > LOOKAHEAD_S) {
      this.jumpBelief = 0;
      this.duckBelief = 0;
      this.emitAction("run", 0, 0, "jev", state);
      return;
    }

    const action = pickAction(this.jumpBelief, this.duckBelief);
    this.emitAction(action, this.jumpBelief, this.duckBelief, "jev", state);
  }

  private emitAction(
    action: JevAction,
    jump_now: number,
    duck_now: number,
    source: DecideResponse["source"],
    state: DecideState | null = null,
  ) {
    const decision: DecideResponse = {
      action,
      jump_now,
      duck_now,
      confidence: Math.max(jump_now, duck_now),
      durationMs: this.lastDecision?.durationMs ?? 0,
      source,
    };
    const changed = action !== this.lastAction;
    const from = this.lastAction;
    this.lastAction = action;
    this.lastDecision = decision;
    if (changed) {
      logJevAct(from, action, decision, state ?? this.options.getState());
      this.options.onDecision(decision);
    }
  }

  private async askJev() {
    if (!this.running) return;
    const state = this.options.getState();
    if (!state) return;

    const next = state.upcoming[0];
    // Only bother the model when something is in the visible approach window.
    if (!next || next.time_to_impact > LOOKAHEAD_S) return;

    const askKey = `${next.type}:${Math.round(next.dx / 30)}:${Math.round(next.y / 10)}`;
    if (this.inflight && askKey === this.lastAskKey) return;

    this.lastAskKey = askKey;
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;

    logJevAsk(state);

    try {
      const response = await fetch("/api/jev-decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(2800),
        ]),
      });
      if (!response.ok) throw new Error("decide failed");
      const body = (await response.json()) as DecideResponse;
      if (!this.running) return;

      this.jumpBelief =
        typeof body.jump_now === "number"
          ? body.jump_now
          : body.action === "jump"
            ? 0.9
            : 0.05;
      this.duckBelief =
        typeof body.duck_now === "number"
          ? body.duck_now
          : body.action === "duck"
            ? 0.9
            : 0.05;

      this.lastDecision = {
        ...body,
        jump_now: this.jumpBelief,
        duck_now: this.duckBelief,
        action: pickAction(this.jumpBelief, this.duckBelief),
        source: "jev",
      };
      logJevReply(this.lastDecision, state);
      this.options.onDecision(this.lastDecision);
      this.applyBeliefs();
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return;
      // No heuristic fallback — Jev owns decisions; on failure we keep last beliefs.
      console.log(
        "%c[Jev reply]%c (request failed — holding last beliefs) %s",
        "color:#666;font-weight:600",
        "color:inherit",
        error instanceof Error ? error.message : "request failed",
      );
    } finally {
      if (this.inflight === controller) this.inflight = null;
    }
  }
}

