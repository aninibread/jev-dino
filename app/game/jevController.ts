import type { DecideResponse, DecideState, JevAction } from "../lib/jev-contract";

export type JevControllerOptions = {
  getState: () => DecideState | null;
  onDecision: (decision: DecideResponse) => void;
  intervalMs?: number;
};

/**
 * Periodic Jev decisions — never blocks the game loop.
 * Falls back client-side if the network fails (server also has a heuristic).
 */
export class JevController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflight: AbortController | null = null;
  private lastAction: JevAction = "run";
  private lastDecision: DecideResponse | null = null;
  private options: Required<Pick<JevControllerOptions, "intervalMs">> &
    JevControllerOptions;
  running = false;

  constructor(options: JevControllerOptions) {
    this.options = { intervalMs: 180, ...options };
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
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs);
    void this.tick();
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.inflight?.abort();
    this.inflight = null;
  }

  private async tick() {
    if (!this.running) return;
    const state = this.options.getState();
    if (!state) return;
    if (this.inflight) return; // skip if still waiting

    const controller = new AbortController();
    this.inflight = controller;
    try {
      const response = await fetch("/api/jev-decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(state),
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(9000),
        ]),
      });
      if (!response.ok) throw new Error("decide failed");
      const body = (await response.json()) as DecideResponse;
      if (!this.running) return;
      this.lastAction = body.action;
      this.lastDecision = body;
      this.options.onDecision(body);
    } catch {
      // Keep last action; server/heuristic will recover on next tick.
    } finally {
      if (this.inflight === controller) this.inflight = null;
    }
  }
}
