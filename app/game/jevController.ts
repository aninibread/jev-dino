import {
  duckLeadSeconds,
  heuristicDecide,
  jumpLeadSeconds,
  pickAction,
  type DecideResponse,
  type DecideState,
  type JevAction,
} from "../lib/jev-contract";

export type JevControllerOptions = {
  getState: () => DecideState | null;
  onDecision: (decision: DecideResponse) => void;
  intervalMs?: number;
};

/**
 * Jev answers "should I jump / duck for this hazard?" (noul probabilities).
 * The browser commits the actual jump/duck at the correct lead time so
 * 400–1200ms model latency cannot make Jev late every race.
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
    this.options = { intervalMs: 110, ...options };
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
    this.timer = setInterval(() => void this.askJev(), this.options.intervalMs);
    void this.askJev();
    const tick = () => {
      if (!this.running) return;
      this.executeTiming();
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

  private executeTiming() {
    const state = this.options.getState();
    if (!state) return;
    const next = state.upcoming[0];
    if (!next) {
      if (this.lastAction !== "run") this.emitAction("run", 0, 0, "heuristic");
      return;
    }

    const jumpLead = jumpLeadSeconds(next.width, state.speed);
    const duckLead = duckLeadSeconds(state.speed);
    const tti = next.time_to_impact;
    const local = heuristicDecide(state);
    const hasBelief = this.jumpBelief > 0.05 || this.duckBelief > 0.05;

    // Jev endorses the hazard; local physics picks the exact frame.
    // Weak Jev "yes" (~0.3) still counts — raw noul scores are often soft.
    let jump = this.jumpBelief;
    let duck = this.duckBelief;
    let source: DecideResponse["source"] = this.lastDecision?.source ?? "jev";

    if (!hasBelief) {
      jump = local.jump_now;
      duck = local.duck_now;
      source = "heuristic";
    } else {
      if (this.jumpBelief >= 0.28) jump = Math.max(jump, local.jump_now);
      if (this.duckBelief >= 0.28) duck = Math.max(duck, local.duck_now);
      // Imminent + in-flight request: don't wait to die.
      if (this.inflight && tti <= jumpLead + 0.05) {
        jump = Math.max(jump, local.jump_now);
        duck = Math.max(duck, local.duck_now);
      }
    }

    let action: JevAction = "run";
    if (next.clearance === "duck") {
      if (duck >= 0.45 && tti <= duckLead + 0.15 && tti > -0.02) action = "duck";
    } else if (state.dino.grounded) {
      if (jump >= 0.45 && tti <= jumpLead && tti > 0.02) action = "jump";
    }

    this.emitAction(action, jump, duck, source);
  }

  private emitAction(
    action: JevAction,
    jump_now: number,
    duck_now: number,
    source: DecideResponse["source"],
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
    this.lastAction = action;
    this.lastDecision = decision;
    if (changed) this.options.onDecision(decision);
  }

  private async askJev() {
    if (!this.running) return;
    const state = this.options.getState();
    if (!state) return;

    const next = state.upcoming[0];
    if (!next || next.time_to_impact > 1.35 || next.time_to_impact < 0) return;

    const askKey = `${next.type}:${next.clearance}:${Math.round(next.dx / 30)}`;
    if (this.inflight && askKey === this.lastAskKey) return;

    this.lastAskKey = askKey;
    this.inflight?.abort();
    const controller = new AbortController();
    this.inflight = controller;

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
      };
      // Surface that a live Jev answer arrived (HUD source badge).
      this.options.onDecision(this.lastDecision);
    } catch {
      /* timing loop covers gaps */
    } finally {
      if (this.inflight === controller) this.inflight = null;
    }
  }
}
