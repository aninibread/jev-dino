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
 * Fair control loop with sticky key holds.
 * Duck/jump thrash came from recomposing noisy nouls every frame and
 * re-asking Jev as fast as possible — hold decisions until the hazard clears.
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
  /** Sticky duck until this obstacle id has passed (or timeout). */
  private duckStickyId: string | null = null;
  private duckStickyUntilMs = 0;
  /** Sticky jump-through-landing until we leave the ground or timeout. */
  private jumpStickyUntilMs = 0;
  private nowMs = 0;
  private lastAskAtMs = 0;
  private options: Required<Pick<JevControllerOptions, "intervalMs">> &
    JevControllerOptions;
  running = false;

  constructor(options: JevControllerOptions) {
    // Ask less often — atomics persist; spam caused thrash.
    this.options = { intervalMs: 220, ...options };
  }

  get action() {
    return this.lastAction;
  }

  get decision() {
    return this.lastDecision;
  }

  /** Raw key-hold beliefs — apply both independently (jump + mid-air duck). */
  get keys() {
    return { jump: this.pressJump, duck: this.pressDuck };
  }

  start() {
    this.stop();
    this.running = true;
    this.lastAction = "run";
    this.pressJump = 0;
    this.pressDuck = 0;
    this.wasAirborne = false;
    this.lastNearestId = null;
    this.duckStickyId = null;
    this.duckStickyUntilMs = 0;
    this.jumpStickyUntilMs = 0;
    this.nowMs = 0;
    this.lastAskAtMs = 0;
    this.lastDecision = null;
    console.log(
      "%c[Jev]%c System One — sticky key holds, calmer asks",
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

    this.nowMs = state.t * 1000;
    const nearestId = state.visible[0]?.id ?? null;

    if (this.wasAirborne && state.dino.grounded) {
      // Landing: allow a fresh ask, keep jump sticky briefly for chains.
      if (this.pressJump >= 0.4) {
        this.jumpStickyUntilMs = this.nowMs + 180;
      }
      void this.askJev(true);
    }
    if (nearestId && nearestId !== this.lastNearestId && this.lastNearestId) {
      void this.askJev(true);
    }
    this.lastNearestId = nearestId;
    this.wasAirborne = state.dino.airborne;

    this.applyHolds(state);
  }

  private applyHolds(state: DecideState) {
    if (state.visible.length === 0) {
      this.pressJump = 0;
      this.pressDuck = 0;
      this.duckStickyId = null;
      this.emitAction("run", 0, 0, "jev", state);
      return;
    }

    const nearest = state.visible[0]!;
    const atomic = this.lastDecision?.atomic;
    if (atomic) {
      const composed = composeKeyHolds(atomic, state, {
        nearest_id: this.lastDecision?.ask_nearest_id ?? null,
        second_id: this.lastDecision?.ask_second_id ?? null,
      });
      this.pressJump = composed.press_jump;
      this.pressDuck = composed.press_duck;
    }

    // --- Sticky duck: hold crouch through a mid bird until it passes ---
    const birdNeedsDuck =
      nearest.type === "bird" &&
      nearest.bird_altitude === "mid" &&
      nearest.relation !== "passing";

    if (this.pressDuck >= 0.5 && birdNeedsDuck) {
      this.duckStickyId = nearest.id;
      // Hold at least through estimated clear time, min 280ms.
      const clearMs = Math.max(280, (nearest.seconds_away + 0.2) * 1000);
      this.duckStickyUntilMs = this.nowMs + Math.min(clearMs, 900);
    }

    if (this.duckStickyId) {
      const sticky = state.visible.find((o) => o.id === this.duckStickyId);
      const stillRelevant =
        sticky &&
        sticky.relation !== "passing" &&
        sticky.dx + sticky.width > -8;
      if (stillRelevant || this.nowMs < this.duckStickyUntilMs) {
        this.pressDuck = Math.max(this.pressDuck, 0.85);
        // Don't jump into a bird we're ducking under.
        if (!state.dino.airborne) this.pressJump = Math.min(this.pressJump, 0.15);
      } else {
        this.duckStickyId = null;
      }
    }

    // --- Sticky jump: keep jump held briefly through landing for chains ---
    if (this.pressJump >= 0.55 && (state.dino.airborne || state.dino.just_landed)) {
      this.jumpStickyUntilMs = Math.max(this.jumpStickyUntilMs, this.nowMs + 200);
    }
    if (this.nowMs < this.jumpStickyUntilMs && !this.duckStickyId) {
      this.pressJump = Math.max(this.pressJump, 0.7);
    }

    // Grounded + duck sticky wins over jump.
    if (!state.dino.airborne && this.pressDuck >= 0.55) {
      this.pressJump = Math.min(this.pressJump, 0.2);
    }

    const action = pickAction(
      this.pressJump,
      this.pressDuck,
      state.dino.airborne,
      this.lastAction,
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

  private async askJev(force = false) {
    if (!this.running) return;
    if (this.inflight) return;
    // Rate-limit non-forced asks so atomics can settle.
    if (!force && this.nowMs - this.lastAskAtMs < this.options.intervalMs - 20) {
      return;
    }

    const state = this.options.getState();
    if (!state) return;
    if (state.visible.length === 0) return;

    const controller = new AbortController();
    this.inflight = controller;
    this.lastAskAtMs = this.nowMs;
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

      const live = this.options.getState() ?? state;
      const composed = composeKeyHolds(atomic, live, {
        nearest_id: askNearest,
        second_id: askSecond,
      });

      this.pressJump = composed.press_jump;
      this.pressDuck = composed.press_duck;

      this.lastDecision = {
        action: pickAction(
          this.pressJump,
          this.pressDuck,
          live.dino.airborne,
          this.lastAction,
        ),
        press_jump: this.pressJump,
        press_duck: this.pressDuck,
        atomic,
        ask_nearest_id: askNearest,
        ask_second_id: askSecond,
        confidence: Math.max(this.pressJump, this.pressDuck),
        durationMs: body.durationMs ?? 0,
        source: "jev",
      };
      logJevReply(this.lastDecision, live);
      this.options.onDecision(this.lastDecision);
      this.applyHolds(live);
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
      // Do NOT immediately chain another ask — that thrashed duck/jump.
    }
  }
}
