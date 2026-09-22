import {
  BASE_SPEED,
  JEV_CLIENT_TIMEOUT_MS,
  JEV_MAX_IN_FLIGHT,
} from "./constants";
import {
  CONFIDENCE_THRESHOLD,
  EMPTY_PROBABILITIES,
  EMPTY_PROFILE_PROBABILITIES,
  birdAltitude,
  flightPathFor,
  toGroup,
  toSemanticKind,
  type BirdAltitude,
  type DecideResponse,
  type DinosaurMotion,
  type FlightPath,
  type JevAskView,
  type JumpProfile,
  type JumpProfileProbabilities,
  type ObstacleGroup,
  type ObstacleKind,
  type SemanticKind,
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
  error?: string | null;
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
  /** Maneuver body; next_obstacle may be refreshed for the profile call. */
  body: DecideBody;
  decision?: DecideResponse & { effectiveJumpProfile: JumpProfile };
  /** Profile fetch already queued / finished for this plan. */
  profileQueued?: boolean;
};

type DescribedObstacle = {
  id: string;
  type: ObstacleKind;
  size: number;
  width: number;
  y: number;
  bird_altitude?: BirdAltitude;
  kind: SemanticKind;
  group: ObstacleGroup;
  flight_path: FlightPath;
  width_px: number;
};

type DecideBody = {
  speed: number;
  dinosaur_motion: DinosaurMotion;
  obstacle: DescribedObstacle;
  next_obstacle: (DescribedObstacle & {
    gap_px: number;
    seconds_until_next: number;
  }) | null;
};

/**
 * Per-obstacle planner:
 * - Maneuver asks fire as soon as obstacles appear (prefetch queue).
 * - Up to JEV_MAX_IN_FLIGHT Worker fetches run concurrently.
 * - Jump plans become ready on the first call; profile fills in if it lands
 *   before execute (otherwise default full).
 */
export class JevController {
  private frameHook: number | null = null;
  private seen = new Set<string>();
  private plans = new Map<string, Plan>();
  private lastAction: "run" | "jump" | "duck" = "run";
  private lastDecision: DecideResponse | null = null;
  private lastAsk: JevAskView | null = null;
  private lastStatus: JevIoStatus = "idle";
  private lastError: string | null = null;
  private pressJump = 0;
  private pressDuck = 0;
  private jumpProfile: JumpProfile = "full";
  private options: JevControllerOptions;
  private decideQueue: Array<() => Promise<void>> = [];
  private inFlight = 0;
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
    error: string | null = null,
  ) {
    this.lastStatus = status;
    this.lastError = status === "error" ? error : null;
    this.options.onIo({
      status,
      ask,
      decision,
      error: this.lastError,
    });
  }

  start() {
    this.stop();
    this.running = true;
    this.seen.clear();
    this.plans.clear();
    this.decideQueue = [];
    this.inFlight = 0;
    this.lastAction = "run";
    this.lastDecision = null;
    this.lastAsk = null;
    this.lastStatus = "idle";
    this.lastError = null;
    this.pressJump = 0;
    this.pressDuck = 0;
    this.jumpProfile = "full";
    console.log(
      `%c[Jev]%c prefetch maneuvers (max ${JEV_MAX_IN_FLIGHT} in flight); profile is non-blocking`,
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
    this.inFlight = 0;
    for (const plan of this.plans.values()) plan.abort.abort();
    this.plans.clear();
    this.seen.clear();
    this.pressJump = 0;
    this.pressDuck = 0;
  }

  /** Queue a Worker fetch; pump keeps up to JEV_MAX_IN_FLIGHT running. */
  private enqueueFetch(task: () => Promise<void>) {
    this.decideQueue.push(task);
    this.pumpFetchQueue();
  }

  private pumpFetchQueue() {
    while (
      this.running &&
      this.inFlight < JEV_MAX_IN_FLIGHT &&
      this.decideQueue.length > 0
    ) {
      const task = this.decideQueue.shift();
      if (!task) break;
      this.inFlight += 1;
      void task()
        .catch(() => {
          /* Tasks handle their own failures. */
        })
        .finally(() => {
          this.inFlight = Math.max(0, this.inFlight - 1);
          this.pumpFetchQueue();
        });
    }
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
    // Ask as soon as each obstacle appears — do not wait for next_obstacle.
    // Profile calls refresh next from the live snapshot when they run.
    for (const obstacle of snapshot.obstacles) {
      if (obstacle.remove || this.seen.has(obstacle.id)) continue;
      this.seen.add(obstacle.id);
      this.queueDecision(obstacle, snapshot);
    }
  }

  private describeObstacle(obstacle: Obstacle): DescribedObstacle {
    const type = obstacle.typeConfig.kind;
    const alt = type === "bird" ? birdAltitude(obstacle.yPos) : undefined;
    return {
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
    };
  }

  private findNextObstacle(
    obstacle: Obstacle,
    snapshot: JevSnapshot,
  ): {
    obstacle: Obstacle;
    gap_px: number;
    seconds_until_next: number;
  } | null {
    const ahead = snapshot.obstacles
      .filter((o) => !o.remove && o.xPos > obstacle.xPos)
      .sort((a, b) => a.xPos - b.xPos);
    const next = ahead[0];
    if (!next) return null;
    const gap_px = Math.max(
      0,
      Math.round(next.xPos - (obstacle.xPos + obstacle.width)),
    );
    const pxPerSec = Math.max(snapshot.speed, 0.1) * 60;
    return {
      obstacle: next,
      gap_px,
      seconds_until_next: gap_px / pxPerSec,
    };
  }

  private buildNextDescribed(
    obstacle: Obstacle,
    snapshot: JevSnapshot,
  ): DecideBody["next_obstacle"] {
    const next = this.findNextObstacle(obstacle, snapshot);
    if (!next) return null;
    return {
      ...this.describeObstacle(next.obstacle),
      gap_px: next.gap_px,
      seconds_until_next: next.seconds_until_next,
    };
  }

  private queueDecision(obstacle: Obstacle, snapshot: JevSnapshot) {
    const abort = new AbortController();
    const described = this.describeObstacle(obstacle);
    const nextDescribed = this.buildNextDescribed(obstacle, snapshot);

    const ask: JevAskView = {
      speed: snapshot.speed,
      dinosaur_motion: snapshot.dinosaurMotion,
      obstacle: {
        id: described.id,
        type: described.type,
        bird_altitude: described.bird_altitude,
        kind: described.kind,
        group: described.group,
        flight_path: described.flight_path,
        width_px: described.width_px,
      },
      next_obstacle: nextDescribed
        ? {
            id: nextDescribed.id,
            type: nextDescribed.type,
            bird_altitude: nextDescribed.bird_altitude,
            kind: nextDescribed.kind,
            group: nextDescribed.group,
            flight_path: nextDescribed.flight_path,
            width_px: nextDescribed.width_px,
            gap_px: nextDescribed.gap_px,
            seconds_until_next: nextDescribed.seconds_until_next,
          }
        : null,
    };
    const body: DecideBody = {
      speed: ask.speed,
      dinosaur_motion: ask.dinosaur_motion,
      obstacle: described,
      next_obstacle: nextDescribed,
    };
    const plan: Plan = {
      obstacleId: obstacle.id,
      obstacle,
      ask,
      body,
      status: "pending",
      abort,
      requestedAt: performance.now(),
    };
    this.plans.set(obstacle.id, plan);
    this.lastAsk = ask;
    this.emitIo("thinking", ask, null);

    this.enqueueFetch(async () => {
      if (!this.running || this.plans.get(obstacle.id) !== plan) return;
      if (plan.status !== "pending") return;
      logJevAsk(body);
      await this.fetchManeuver(plan, ask, body);
    });
  }

  private async fetchManeuver(
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

      const enriched: DecideResponse & { effectiveJumpProfile: JumpProfile } = {
        ...decision,
        jump_profile: "full",
        profile_probabilities: { ...EMPTY_PROFILE_PROBABILITIES },
        probabilities: decision.probabilities ?? {
          ...EMPTY_PROBABILITIES,
          [decision.action]: decision.confidence,
        },
        effectiveJumpProfile: "full",
        durationMs: decision.durationMs ?? performance.now() - plan.requestedAt,
      };
      plan.decision = enriched;
      this.lastAsk = ask;
      this.lastDecision = enriched;

      if (
        decision.source === "none" ||
        decision.confidence < CONFIDENCE_THRESHOLD
      ) {
        plan.status = "skipped";
        logJevReply(enriched, body);
        this.emitIo("skipped", ask, enriched);
        console.log(
          "%c[Jev]%c skipped (low confidence or error) %s",
          "color:#666;font-weight:600",
          "color:inherit",
          decision.action,
        );
        return;
      }

      // Maneuver is enough to act. Profile never blocks the jump.
      plan.status = "ready";
      logJevReply(enriched, body);
      this.emitIo("ready", ask, enriched);

      if (decision.action === "jump") {
        this.queueJumpProfile(plan);
      }
    } catch (error) {
      if (!this.running) return;
      if (this.plans.get(plan.obstacleId) !== plan) return;
      if (plan.status !== "pending") return;
      if (plan.abort.signal.aborted) return;

      if (attempt < 1) {
        console.log(
          "%c[Jev]%c retrying maneuver %s (%s)",
          "color:#c60;font-weight:600",
          "color:inherit",
          plan.obstacleId,
          error instanceof Error ? error.message : "request failed",
        );
        await this.fetchManeuver(plan, ask, body, attempt + 1);
        return;
      }

      plan.status = "error";
      const message =
        error instanceof Error ? error.message : "request failed";
      this.emitIo("error", ask, this.lastDecision, message);
      console.log(
        "%c[Jev reply]%c (request failed) %s",
        "color:#666;font-weight:600",
        "color:inherit",
        message,
      );
    }
  }

  private queueJumpProfile(plan: Plan) {
    if (plan.profileQueued) return;
    plan.profileQueued = true;
    this.enqueueFetch(async () => {
      if (!this.running || this.plans.get(plan.obstacleId) !== plan) return;
      // Still useful for UI / upcoming hop if not executed yet.
      if (plan.status === "late" || plan.status === "skipped" || plan.status === "error") {
        return;
      }
      await this.fetchJumpProfile(plan);
    });
  }

  private async fetchJumpProfile(plan: Plan, attempt = 0): Promise<void> {
    // Refresh next_obstacle from the live world so tight chains get context
    // even when the maneuver asked before the follow-on existed.
    const snapshot = this.options.getSnapshot();
    const body: DecideBody = {
      ...plan.body,
      next_obstacle: snapshot
        ? this.buildNextDescribed(plan.obstacle, snapshot)
        : plan.body.next_obstacle,
    };
    if (body.next_obstacle) {
      const n = body.next_obstacle;
      plan.ask = {
        ...plan.ask,
        next_obstacle: {
          id: n.id,
          type: n.type,
          bird_altitude: n.bird_altitude,
          kind: n.kind,
          group: n.group,
          flight_path: n.flight_path,
          width_px: n.width_px,
          gap_px: n.gap_px,
          seconds_until_next: n.seconds_until_next,
        },
      };
    }

    try {
      const response = await fetch("/api/jev-jump-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          plan.abort.signal,
          AbortSignal.timeout(JEV_CLIENT_TIMEOUT_MS),
        ]),
      });
      if (!response.ok) {
        throw new Error(`jump profile failed (${response.status})`);
      }
      const result = (await response.json()) as {
        jump_profile?: JumpProfile;
        profile_probabilities?: JumpProfileProbabilities;
        durationMs?: number;
      };
      if (!this.running) return;
      if (this.plans.get(plan.obstacleId) !== plan) return;

      const shortOk =
        plan.ask.obstacle.kind === "small_cactus" &&
        plan.ask.obstacle.group === "single";
      const rawProfile = result.jump_profile === "short" ? "short" : "full";
      const effectiveJumpProfile: JumpProfile =
        rawProfile === "short" && shortOk ? "short" : "full";
      const profile_probabilities = result.profile_probabilities ?? {
        short: 0,
        full: 1,
      };

      // Apply only if we have not already left the ground / skipped.
      if (plan.status === "ready" && plan.decision) {
        const updated: DecideResponse & { effectiveJumpProfile: JumpProfile } = {
          ...plan.decision,
          jump_profile: effectiveJumpProfile,
          profile_probabilities,
          effectiveJumpProfile,
          durationMs:
            plan.decision.durationMs + (result.durationMs ?? 0),
        };
        plan.decision = updated;
        this.lastAsk = plan.ask;
        this.lastDecision = updated;
        this.emitIo("ready", plan.ask, updated);
        console.log(
          `%c[Jev profile]%c ${effectiveJumpProfile} short=${Math.round((profile_probabilities.short ?? 0) * 100)}% full=${Math.round((profile_probabilities.full ?? 0) * 100)}% vs ${plan.obstacleId}`,
          "color:#0a7;font-weight:600",
          "color:inherit",
        );
      } else if (plan.decision) {
        // Already jumped (or ducking elsewhere): still update UI bars.
        const updated: DecideResponse & { effectiveJumpProfile: JumpProfile } = {
          ...plan.decision,
          jump_profile: plan.decision.effectiveJumpProfile,
          profile_probabilities,
          effectiveJumpProfile: plan.decision.effectiveJumpProfile,
        };
        plan.decision = updated;
        if (this.lastDecision?.obstacle_id === plan.obstacleId) {
          this.lastDecision = updated;
          this.emitIo(this.lastStatus, plan.ask, updated);
        }
      }
    } catch (error) {
      if (plan.abort.signal.aborted) return;
      if (attempt < 1) {
        console.log(
          "%c[Jev]%c retrying jump profile %s (%s)",
          "color:#c60;font-weight:600",
          "color:inherit",
          plan.obstacleId,
          error instanceof Error ? error.message : "request failed",
        );
        await this.fetchJumpProfile(plan, attempt + 1);
        return;
      }
      console.log(
        "%c[Jev]%c jump profile missed, keeping full (%s)",
        "color:#666;font-weight:600",
        "color:inherit",
        error instanceof Error ? error.message : "request failed",
      );
      // Leave plan ready with full — never demote to error/late for profile.
      if (plan.status === "ready" && plan.decision) {
        const updated: DecideResponse & { effectiveJumpProfile: JumpProfile } = {
          ...plan.decision,
          profile_probabilities: { short: 0, full: 1 },
        };
        plan.decision = updated;
        this.lastDecision = updated;
        this.emitIo("ready", plan.ask, updated);
      }
    }
  }

  private executePlans(snapshot: JevSnapshot) {
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
        if (plan.status === "ducking") {
          wantDuck = true;
        }
        continue;
      }

      if (plan.status === "pending") {
        // Maneuver itself arrived too late — abort this obstacle only.
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
        if (snapshot.dinosaurMotion === "jumping") {
          continue;
        }
        if (snapshot.dinosaurMotion === "ducking") {
          wantDuck = false;
          continue;
        }
        wantJump = true;
        this.jumpProfile = jumpProfile;
        plan.status = "executed";
        logJevAct(this.lastAction, "jump", plan.decision!, null);
      } else if (action === "duck") {
        if (snapshot.dinosaurMotion === "jumping") {
          wantDuck = true;
          continue;
        }
        wantDuck = true;
        plan.status = "ducking";
        logJevAct(this.lastAction, "duck", plan.decision!, null);
      } else {
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
