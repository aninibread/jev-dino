import {
  composeKeyHolds,
  emptyAtomic,
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
 * Fair control loop: poll Jev with the visible lane; apply key-hold beliefs.
 * Re-asks as soon as a reply lands (and on landing / nearest change) so
 * consecutive obstacles get a fresh look — still no local planner inventing moves.
 */
export class JevController {
  private timer: ReturnType<typeof setInterval> | null = null;
  private frameHook: number | null = null;
  private inflight: AbortController | null = null;
  private lastAction: JevAction = "run";
  private lastDecision: DecideResponse | null = null;
  private pressJump = 0;
  private pressDuck = 0;
  private wasAirborne = false;
  private lastNearestId: string | null = null;
  private options: Required<Pick<JevControllerOptions, "intervalMs">> &
    JevControllerOptions;
  running = false;

  constructor(options: JevControllerOptions) {
    // Poll often; actual rate is gated by in-flight (one ask at a time).
    this.options = { intervalMs: 50, ...options };
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
    this.pressJump = 0;
    this.pressDuck = 0;
    this.wasAirborne = false;
    this.lastNearestId = null;
    this.lastDecision = null;
    console.log(
      "%c[Jev]%c System One — atomic nouls in parallel, key holds composed in code",
      "color:#0a7;font-weight:700",
      "color:inherit",
    );
    this.timer = setInterval(() => void this.askJev(), this.options.intervalMs);
    void this.askJev();
    const tick = () => {
      if (!this.running) return;
      this.onFrame();
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

  private onFrame() {
    const state = this.options.getState();
    if (!state) return;

    const nearestId = state.visible[0]?.id ?? null;

    // Landing edge → ask immediately (second cactus often needs a fresh press).
    if (this.wasAirborne && state.dino.grounded) {
      void this.askJev();
    }
    // Nearest obstacle changed (first scrolled past) → remap needs a fresh ask.
    if (nearestId && nearestId !== this.lastNearestId && this.lastNearestId) {
      void this.askJev();
    }
    this.lastNearestId = nearestId;
    this.wasAirborne = state.dino.airborne;

    this.applyHolds(state);
  }

  private applyHolds(state: DecideState) {
    if (state.visible.length === 0) {
      this.pressJump = 0;
      this.pressDuck = 0;
      this.emitAction("run", 0, 0, "jev", state);
      return;
    }

    // Recompose every frame from the last atomic answers + current state.
    // Remaps second_needs_jump when the former #2 becomes nearest.
    const atomic = this.lastDecision?.atomic;
    if (atomic) {
      const composed = composeKeyHolds(atomic, state, {
        nearest_id: this.lastDecision?.ask_nearest_id ?? null,
        second_id: this.lastDecision?.ask_second_id ?? null,
      });
      this.pressJump = composed.press_jump;
      this.pressDuck = composed.press_duck;
    }

    const action = pickAction(
      this.pressJump,
      this.pressDuck,
      state.dino.airborne,
    );
    this.emitAction(action, this.pressJump, this.pressDuck, "jev", state);
  }

  private emitAction(
    action: JevAction,
    press_jump: number,
    press_duck: number,
    source: DecideResponse["source"],
    state: DecideState | null = null,
  ) {
    const decision: DecideResponse = {
      action,
      press_jump,
      press_duck,
      atomic: this.lastDecision?.atomic ?? emptyAtomic(),
      ask_nearest_id: this.lastDecision?.ask_nearest_id ?? null,
      ask_second_id: this.lastDecision?.ask_second_id ?? null,
      confidence: Math.max(press_jump, press_duck),
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
    if (this.inflight) return;

    const state = this.options.getState();
    if (!state) return;
    if (state.visible.length === 0) return;

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
      if (!response.ok) throw new Error(`decide failed (${response.status})`);
      const body = (await response.json()) as DecideResponse & {
        jump_now?: number;
        duck_now?: number;
      };
      if (!this.running) return;

      const askNearest = body.ask_nearest_id ?? state.visible[0]?.id ?? null;
      const askSecond = body.ask_second_id ?? state.visible[1]?.id ?? null;
      const atomic = body.atomic ?? emptyAtomic();

      // Prefer server-composed press_*; recompose with ask context if needed.
      let pressJump =
        typeof body.press_jump === "number"
          ? body.press_jump
          : typeof body.jump_now === "number"
            ? body.jump_now
            : body.action === "jump"
              ? 0.9
              : 0.05;
      let pressDuck =
        typeof body.press_duck === "number"
          ? body.press_duck
          : typeof body.duck_now === "number"
            ? body.duck_now
            : body.action === "duck"
              ? 0.9
              : 0.05;

      if (body.atomic) {
        const composed = composeKeyHolds(atomic, state, {
          nearest_id: askNearest,
          second_id: askSecond,
        });
        pressJump = composed.press_jump;
        pressDuck = composed.press_duck;
      }

      this.pressJump = pressJump;
      this.pressDuck = pressDuck;

      this.lastDecision = {
        action: pickAction(pressJump, pressDuck, state.dino.airborne),
        press_jump: pressJump,
        press_duck: pressDuck,
        atomic,
        ask_nearest_id: askNearest,
        ask_second_id: askSecond,
        confidence: Math.max(pressJump, pressDuck),
        durationMs: body.durationMs ?? 0,
        source: "jev",
      };
      logJevReply(this.lastDecision, state);
      this.options.onDecision(this.lastDecision);
      this.applyHolds(state);
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return;
      console.log(
        "%c[Jev reply]%c (request failed — holding last keys) %s",
        "color:#666;font-weight:600",
        "color:inherit",
        error instanceof Error ? error.message : "request failed",
      );
    } finally {
      if (this.inflight === controller) this.inflight = null;
      // Chain the next look as soon as we're free while hazards remain.
      if (this.running) void this.askJev();
    }
  }
}
