import {
  BASE_SPEED,
  TREX,
} from "./constants";
import {
  CONFIDENCE_THRESHOLD,
  birdAltitude,
  flightPathFor,
  maneuverToPresses,
  toGroup,
  toSemanticKind,
  type DecideResponse,
  type DinosaurMotion,
  type JumpProfile,
  type Maneuver,
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

export type JevControllerOptions = {
  getSnapshot: () => JevSnapshot | null;
  onDecision: (decision: DecideResponse) => void;
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
  status: PlanStatus;
  abort: AbortController;
  requestedAt: number;
  decision?: DecideResponse & { effectiveJumpProfile: JumpProfile };
};

/**
 * Per-obstacle planner (joshlarsen/jev-t-rex-runner style):
 * ask Jev once when an obstacle appears; code owns proximity timing + duck hold.
 */
export class JevController {
  private frameHook: number | null = null;
  private seen = new Set<string>();
  private plans = new Map<string, Plan>();
  private lastAction: "run" | "jump" | "duck" = "run";
  private lastDecision: DecideResponse | null = null;
  private pressJump = 0;
  private pressDuck = 0;
  private jumpProfile: JumpProfile = "full";
  private options: JevControllerOptions;
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

  get keys() {
    return {
      jump: this.pressJump,
      duck: this.pressDuck,
      jumpProfile: this.jumpProfile,
    };
  }

  start() {
    this.stop();
    this.running = true;
    this.seen.clear();
    this.plans.clear();
    this.lastAction = "run";
    this.lastDecision = null;
    this.pressJump = 0;
    this.pressDuck = 0;
    this.jumpProfile = "full";
    console.log(
      "%c[Jev]%c per-obstacle maneuvers — code owns timing (ref: jev-t-rex-runner)",
      "color:#0a7;font-weight:700",
      "color:inherit",
    );
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
    for (const plan of this.plans.values()) plan.abort.abort();
    this.plans.clear();
    this.seen.clear();
    this.pressJump = 0;
    this.pressDuck = 0;
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
      void this.requestDecision(obstacle, snapshot);
    }
  }

  private async requestDecision(obstacle: Obstacle, snapshot: JevSnapshot) {
    const abort = new AbortController();
    const plan: Plan = {
      obstacleId: obstacle.id,
      obstacle,
      status: "pending",
      abort,
      requestedAt: performance.now(),
    };
    this.plans.set(obstacle.id, plan);

    const type = obstacle.typeConfig.kind;
    const alt = type === "bird" ? birdAltitude(obstacle.yPos) : undefined;
    const body = {
      speed: snapshot.speed,
      dinosaur_motion: snapshot.dinosaurMotion,
      obstacle: {
        id: obstacle.id,
        type,
        size: obstacle.size,
        width: obstacle.width,
        y: obstacle.yPos,
        bird_altitude: alt,
        kind: toSemanticKind(type),
        group: toGroup(obstacle.size),
        flight_path: flightPathFor(type, alt),
        width_px: Math.round(obstacle.width),
      },
    };

    logJevAsk(body);

    try {
      const response = await fetch("/api/jev-decide", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2800)]),
      });
      if (!response.ok) throw new Error(`decide failed (${response.status})`);
      const decision = (await response.json()) as DecideResponse;
      if (!this.running) return;
      if (this.plans.get(obstacle.id) !== plan || plan.status !== "pending") {
        return;
      }

      const shortOk =
        body.obstacle.kind === "small_cactus" &&
        body.obstacle.group === "single";
      const effectiveJumpProfile: JumpProfile =
        decision.action === "jump" &&
        decision.jump_profile === "short" &&
        decision.confidence >= CONFIDENCE_THRESHOLD &&
        shortOk
          ? "short"
          : "full";

      const enriched = {
        ...decision,
        effectiveJumpProfile,
        durationMs: decision.durationMs ?? performance.now() - plan.requestedAt,
      };
      plan.decision = enriched;
      this.lastDecision = enriched;
      logJevReply(enriched, body);

      if (decision.source === "none" || decision.confidence < CONFIDENCE_THRESHOLD) {
        plan.status = "skipped";
        console.log(
          "%c[Jev]%c skipped (low confidence or error) %s",
          "color:#666;font-weight:600",
          "color:inherit",
          decision.action,
        );
        return;
      }

      plan.status = "ready";
      this.options.onDecision(enriched);
    } catch (error) {
      if ((error as Error)?.name === "AbortError") return;
      if (this.plans.get(obstacle.id) !== plan) return;
      plan.status = "error";
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
    let acted: Maneuver | "run" = "run";

    for (const [id, plan] of this.plans) {
      const obstacle = plan.obstacle;
      const passed =
        obstacle.remove ||
        obstacle.xPos + obstacle.width < snapshot.dinosaurX - 4;

      if (passed) {
        if (plan.status === "ducking") {
          wantDuck = false;
        }
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
        // Still too far — wait. Keep duck held if already ducking this one.
        if (plan.status === "ducking") {
          wantDuck = true;
          acted = "duck";
        }
        continue;
      }

      if (plan.status === "pending") {
        // Decision too late — abort and skip (no thrash fallback).
        plan.status = "late";
        plan.abort.abort();
        console.log(
          "%c[Jev]%c late — skipped %s",
          "color:#c60;font-weight:600",
          "color:inherit",
          id,
        );
        continue;
      }

      if (plan.status === "ducking") {
        wantDuck = true;
        acted = "duck";
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
        acted = "jump";
        plan.status = "executed";
        logJevAct(this.lastAction, "jump", plan.decision!, null);
      } else if (action === "duck") {
        if (snapshot.dinosaurMotion === "jumping") {
          // Speed-drop then duck on land.
          wantDuck = true;
          acted = "duck";
          continue;
        }
        wantDuck = true;
        acted = "duck";
        plan.status = "ducking";
        logJevAct(this.lastAction, "duck", plan.decision!, null);
      } else {
        // keep_running — clear the plan; code does nothing.
        plan.status = "executed";
      }
    }

    this.pressJump = wantJump ? 0.95 : 0;
    this.pressDuck = wantDuck ? 0.95 : 0;

    const ui = wantDuck ? "duck" : wantJump ? "jump" : "run";
    if (ui !== this.lastAction) {
      this.lastAction = ui;
      if (this.lastDecision) {
        const presses = maneuverToPresses(
          acted === "run" ? "keep_running" : acted,
        );
        this.options.onDecision({
          ...this.lastDecision,
          press_jump: presses.press_jump,
          press_duck: presses.press_duck,
        });
      }
    }
  }
}
