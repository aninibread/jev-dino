import {
  inDuckWindow,
  inJumpWindow,
  jumpLeadSeconds,
  nextActionable,
  pickAction,
  planAction,
  shouldSpeedDrop,
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
 * Jev answers jump_now / duck_now (noul). Duck mid-air = speed-drop for chains.
 * Local planAction() commits the exact frame, including jump→duck→jump.
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
      "%c[Jev]%c decision log on — watch [ask] / [reply] / [act]",
      "color:#0a7;font-weight:700",
      "color:inherit",
    );
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
    const next = nextActionable(state.upcoming);
    if (!next) {
      if (this.lastAction !== "run") {
        this.emitAction("run", 0, 0, "heuristic", state);
      }
      return;
    }

    const jumpLead = jumpLeadSeconds(next.width, state.speed);
    const tti = next.time_to_impact;
    const local = planAction(state);
    const hasBelief = this.jumpBelief > 0.05 || this.duckBelief > 0.05;

    let jump = this.jumpBelief;
    let duck = this.duckBelief;
    let source: DecideResponse["source"] = this.lastDecision?.source ?? "jev";

    if (!hasBelief) {
      jump = local.jump_now;
      duck = local.duck_now;
      source = "heuristic";
    } else {
      // Soft nouls still blend; local planner wins on chains / physics.
      if (this.jumpBelief >= 0.28) jump = Math.max(jump, local.jump_now);
      if (this.duckBelief >= 0.28) duck = Math.max(duck, local.duck_now);
      if (local.chain_active) {
        jump = Math.max(jump, local.jump_now);
        duck = Math.max(duck, local.duck_now);
      }
      if (this.inflight && tti <= jumpLead + 0.05) {
        jump = Math.max(jump, local.jump_now);
        duck = Math.max(duck, local.duck_now);
      }
    }

    let action: JevAction = "run";

    // Mid-air speed-drop for chaining (duck while airborne).
    if (!state.dino.grounded && (duck >= 0.45 || local.action === "duck")) {
      if (shouldSpeedDrop(state) || local.action === "duck") {
        action = "duck";
      }
    } else if (next.clearance === "duck") {
      // Local physics owns bird ducks — re-asks must not stand us up mid-pass.
      duck = Math.max(duck, local.duck_now);
      if (
        local.action === "duck" ||
        (duck >= 0.45 && inDuckWindow(tti, next.width, state.speed))
      ) {
        action = "duck";
      }
    } else if (state.dino.grounded) {
      if (jump >= 0.45 && inJumpWindow(tti, next.width, state.speed)) {
        action = "jump";
      } else if (
        next.clearance === "either" &&
        duck >= 0.45 &&
        inDuckWindow(tti, next.width, state.speed)
      ) {
        action = "duck";
      }
    }

    // Prefer local plan for chains, bird holds, or when beliefs are cold.
    if (
      local.action !== "run" &&
      (local.chain_active ||
        next.clearance === "duck" ||
        !hasBelief)
    ) {
      action = local.action;
      jump = Math.max(jump, local.jump_now);
      duck = Math.max(duck, local.duck_now);
      source = hasBelief ? source : "heuristic";
    }

    this.emitAction(action, jump, duck, source, state);
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

    const next = nextActionable(state.upcoming);
    // Ask earlier when a chain is coming — need belief before the first jump.
    const askHorizon = state.tactics.chain_active ? 1.6 : 1.35;
    if (!next || next.time_to_impact > askHorizon || next.time_to_impact < 0) {
      return;
    }

    const askKey = `${next.type}:${next.clearance}:${next.chain_with_next ? "c" : "n"}:${Math.round(next.dx / 25)}`;
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
      };
      logJevReply(this.lastDecision, state);
      this.options.onDecision(this.lastDecision);
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return;
      console.log(
        "%c[Jev reply]%c (fallback — local planner) %s",
        "color:#666;font-weight:600",
        "color:inherit",
        error instanceof Error ? error.message : "request failed",
      );
    } finally {
      if (this.inflight === controller) this.inflight = null;
    }
  }
}
