import {
  BASE_SPEED,
  JEV_CLIENT_TIMEOUT_MS,
} from "./constants";
import {
  CONFIDENCE_THRESHOLD,
  EMPTY_PROBABILITIES,
  birdAltitude,
  flightPathFor,
  toGroup,
  toSemanticKind,
  type DecideResponse,
  type DinosaurMotion,
  type JevAskView,
  type JumpProfile,
} from "../lib/jev-contract";
import { calculateActionProximityThreshold } from "../lib/timing";
import type { Obstacle } from "./obstacles";
import { logJevAct, logJevAsk, logJevReply } from "./jevLog";

export type JevSnapshot = {
  playing: boolean;
  crashed: boolean;
  speed: number;
  dinosaurMotion: DinosaurMotion;
  dinosaurX: number;
  obstacles: Obstacle[];
};

export type JevIoStatus =
  | "idle"
  | "thinking"
  | "ready"
  | "skipped"
  | "late"
  | "error";

export type JevIoView = {
  status: JevIoStatus;
  ask: JevAskView | null;
  decision: DecideResponse | null;
};

export type JevControllerOptions = {
  getSnapshot: () => JevSnapshot | null;
  onIo: (view: JevIoView) => void;
};

type PlanStatus =
  | "pending"
  | "ready"
  | "late"
  | "ducking"
  | "executed"
  | "skipped"
  | "error";

type Plan = {
  obstacleId: string;
  obstacle: Obstacle;
  ask: JevAskView;
  status: PlanStatus;
  abort: AbortController;
  requestedAt: number;
  decision?: DecideResponse & { effectiveJumpProfile: JumpProfile };
};

type DecideBody = {
  speed: number;
  dinosaur_motion: DinosaurMotion;
  obstacle: {
    id: string;
    type: string;
    size: number;
    width: number;
    y: number;
    bird_altitude?: string;
    kind: string;
    group: string;
    flight_path: string;
    width_px: number;
  };
};

/**
 * Per-obstacle planner (joshlarsen/jev-t-rex-runner style):
 * ask Jev once when an obstacle appears; code owns proximity timing + duck hold.
 * Decides are serialized so Workers AI is not stampeded.
 */
export class JevController {
  private frameHook: number | null = null;
  private seen = new Set<string>();
  private plans = new Map<string, Plan>();
  private lastAction: "run" | "jump" | "duck" = "run";
  private lastDecision: DecideResponse | null = null;
  private lastAsk: JevAskView | null = null;
  private lastStatus: JevIoStatus = "idle";
  private pressJump = 0;
  private pressDuck = 0;
  private jumpProfile: JumpProfile = "full";
  private options: JevControllerOptions;
  private decideQueue: Array<() => Promise<void>> = [];
  private decideBusy = false;
  running = false;

  constructor(options: JevControllerOptions) {
    this.options = options;
  }

  get action() {
    return this.lastAction;
  }

  get decision() {
    return this.lastDecision;
  }

  get ask() {
    return this.lastAsk;
  }

  get ioStatus() {
    return this.lastStatus;
  }

  get keys() {
    return {
      jump: this.pressJump,
      duck: this.pressDuck,
      jumpProfile: this.jumpProfile,
    };
  }

  private emitIo(
    status: JevIoStatus,
    ask = this.lastAsk,
    decision = this.lastDecision,
  ) {
    this.lastStatus = status;
    this.options.onIo({ status, ask, decision });
  }

  start() {
    this.stop();
    this.running = true;
    this.seen.clear();
    this.plans.clear();
    this.decideQueue = [];
    this.decideBusy = false;
    this.lastAction = "run";
    this.lastDecision = null;
    this.lastAsk = null;
    this.lastStatus = "idle";
    this.pressJump = 0;
    this.pressDuck = 0;
    this.jumpProfile = "full";
    console.log(
      "%c[Jev]%c per-obstacle maneuvers; serial decides; code owns timing",
      "color:#0a7;font-weight:700",
      "color:inherit",
    );
    this.emitIo("idle", null, null);
    const tick = () => {
      if (!this.running) return;
      this.onFrame();
      this.frameHook = requestAnimationFrame(tick);
    };
    this.frameHook = requestAnimationFrame(tick);
  }

  stop() {
    this.running = false;
    if (this.frameHook) cancelAnimationFrame(this.frameHook);
    this.frameHook = null;
    this.decideQueue = [];
    this.decideBusy = false;
    for (const plan of this.plans.values()) plan.abort.abort();
    this.plans.clear();
    this.seen.clear();
    this.pressJump = 0;
    this.pressDuck = 0;
  }

  private enqueueDecide(task: () => Promise<void>) {
    this.decideQueue.push(task);
    void this.pumpDecideQueue();
  }

  private async pumpDecideQueue() {
    if (this.decideBusy) return;
    this.decideBusy = true;
    while (this.running && this.decideQueue.length > 0) {
      const task = this.decideQueue.shift();
      if (!task) break;
      try {
        await task();
      } catch {
        /* Individual tasks handle their own failures. */
      }
    }
    this.decideBusy = false;
  }

  private onFrame() {
    const snapshot = this.options.getSnapshot();
    if (!snapshot || !snapshot.playing || snapshot.crashed) {
      this.pressJump = 0;
      this.pressDuck = 0;
      return;
    }
    this.observeObstacles(snapshot);
    this.executePlans(snapshot);
  }

  private observeObstacles(snapshot: JevSnapshot) {
    for (const obstacle of snapshot.obstacles) {
      if (obstacle.remove || this.seen.has(obstacle.id)) continue;
      this.seen.add(obstacle.id);
      this.queueDecision(obstacle, snapshot);
    }
  }

  private queueDecision(obstacle: Obstacle, snapshot: JevSnapshot) {
    const abort = new AbortController();
    const type = obstacle.typeConfig.kind;
    const alt = type === "bird" ? birdAltitude(obstacle.yPos) : undefined;
    const ask: JevAskView = {
      speed: snapshot.speed,
      dinosaur_motion: snapshot.dinosaurMotion,
      obstacle: {
        id: obstacle.id,
        type,
        bird_altitude: alt,
        kind: toSemanticKind(type),
        group: toGroup(obstacle.size),
        flight_path: flightPathFor(type, alt),
        width_px: Math.round(obstacle.width),
      },
    };
    const plan: Plan = {
      obstacleId: obstacle.id,
      obstacle,
      ask,
      status: "pending",
      abort,
      requestedAt: performance.now(),
    };
    this.plans.set(obstacle.id, plan);
    this.lastAsk = ask;
    this.emitIo("thinking", ask, null);

    const body = {
      speed: ask.speed,
      dinosaur_motion: ask.dinosaur_motion,
      obstacle: {
        id: ask.obstacle.id,
        type,
        size: obstacle.size,
        width: obstacle.width,
        y: obstacle.yPos,
        bird_altitude: alt,
        kind: ask.obstacle.kind,
        group: ask.obstacle.group,
        flight_path: ask.obstacle.flight_path,
        width_px: ask.obstacle.width_px,
      },
    };

    this.enqueueDecide(async () => {
      if (!this.running || this.plans.get(obstacle.id) !== plan) return;
      if (plan.status !== "pending") return;
      logJevAsk(body);
      await this.fetchDecision(plan, ask, body);
    });
  }

  private async fetchDecision(
    plan: Plan,
    ask: JevAskView,
    body: DecideBody,
    attempt = 0,
  ): Promise<void> {
    try {
      const response = await fetch("/api/jev-decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          plan.abort.signal,
          AbortSignal.timeout(JEV_CLIENT_TIMEOUT_MS),
        ]),
      });
      if (!response.ok) throw new Error(`decide failed (${response.status})`);
      const decision = (await response.json()) as DecideResponse;
      if (!this.running) return;
      if (this.plans.get(plan.obstacleId) !== plan || plan.status !== "pending") {
        return;
      }

      const shortOk =
        ask.obstacle.kind === "small_cactus" &&
        ask.obstacle.group === "single";
      const effectiveJumpProfile: JumpProfile =
        decision.action === "jump" &&
        decision.jump_profile === "short" &&
        decision.confidence >= CONFIDENCE_THRESHOLD &&
        shortOk
          ? "short"
          : "full";

      const enriched: DecideResponse & { effectiveJumpProfile: JumpProfile } = {
        ...decision,
        probabilities: decision.probabilities ?? {
          ...EMPTY_PROBABILITIES,
          [decision.action]: decision.confidence,
        },
        effectiveJumpProfile,
        durationMs: decision.durationMs ?? performance.now() - plan.requestedAt,
      };
      plan.decision = enriched;
      this.lastAsk = ask;
      this.lastDecision = enriched;
      logJevReply(enriched, body);

      if (
        decision.source === "none" ||
        decision.confidence < CONFIDENCE_THRESHOLD
      ) {
        plan.status = "skipped";
        this.emitIo("skipped", ask, enriched);
        console.log(
          "%c[Jev]%c skipped (low confidence or error) %s",
          "color:#666;font-weight:600",
          "color:inherit",
          decision.action,
        );
        return;
      }

      plan.status = "ready";
      this.emitIo("ready", ask, enriched);
    } catch (error) {
      if (!this.running) return;
      if (this.plans.get(plan.obstacleId) !== plan) return;
      if (plan.status !== "pending") return;

      // Plan was cancelled because the obstacle arrived (late) or race ended.
      if (plan.abort.signal.aborted) return;

      const canRetry = attempt < 1;
      if (canRetry) {
        console.log(
          "%c[Jev]%c retrying %s (%s)",
          "color:#c60;font-weight:600",
          "color:inherit",
          plan.obstacleId,
          error instanceof Error ? error.message : "request failed",
        );
        await this.fetchDecision(plan, ask, body, attempt + 1);
        return;
      }

      plan.status = "error";
      this.emitIo("error", ask, this.lastDecision);
      console.log(
        "%c[Jev reply]%c (request failed) %s",
        "color:#666;font-weight:600",
        "color:inherit",
        error instanceof Error ? error.message : "request failed",
      );
    }
  }

  private executePlans(snapshot: JevSnapshot) {
    // Default: release keys unless a plan is actively ducking / about to jump.
    let wantJump = false;
    let wantDuck = false;

    for (const [id, plan] of this.plans) {
      const obstacle = plan.obstacle;
      const passed =
        obstacle.remove ||
        obstacle.xPos + obstacle.width < snapshot.dinosaurX - 4;

      if (passed) {
        this.plans.delete(id);
        continue;
      }

      const action = plan.decision?.action ?? "jump";
      const jumpProfile = plan.decision?.effectiveJumpProfile ?? "full";
      const threshold = calculateActionProximityThreshold({
        baseSpeed: BASE_SPEED,
        currentSpeed: snapshot.speed,
        dinosaurX: snapshot.dinosaurX,
        obstacleWidth: obstacle.width,
        action,
        jumpProfile,
      });

      if (obstacle.xPos > threshold) {
        // Still too far. Keep duck held if already ducking this one.
        if (plan.status === "ducking") {
          wantDuck = true;
        }
        continue;
      }

      if (plan.status === "pending") {
        // Decision too late: abort and skip (no thrash fallback).
        plan.status = "late";
        plan.abort.abort();
        this.emitIo("late", plan.ask, plan.decision ?? null);
        console.log(
          "%c[Jev]%c late, skipped %s",
          "color:#c60;font-weight:600",
          "color:inherit",
          id,
        );
        continue;
      }

      if (plan.status === "ducking") {
        wantDuck = true;
        continue;
      }

      if (plan.status !== "ready") continue;

      if (action === "jump") {
        // Only jump when grounded; otherwise wait (don't spam).
        if (snapshot.dinosaurMotion === "jumping") {
          continue;
        }
        if (snapshot.dinosaurMotion === "ducking") {
          // Stand up first next frames.
          wantDuck = false;
          continue;
        }
        wantJump = true;
        this.jumpProfile = jumpProfile;
        plan.status = "executed";
        logJevAct(this.lastAction, "jump", plan.decision!, null);
      } else if (action === "duck") {
        if (snapshot.dinosaurMotion === "jumping") {
          // Speed-drop then duck on land.
          wantDuck = true;
          continue;
        }
        wantDuck = true;
        plan.status = "ducking";
        logJevAct(this.lastAction, "duck", plan.decision!, null);
      } else {
        // keep_running: clear the plan; code does nothing.
        plan.status = "executed";
      }
    }

    this.pressJump = wantJump ? 0.95 : 0;
    this.pressDuck = wantDuck ? 0.95 : 0;

    const ui = wantDuck ? "duck" : wantJump ? "jump" : "run";
    if (ui !== this.lastAction) {
      this.lastAction = ui;
    }
  }
}
