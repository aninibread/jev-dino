import {
  BASE_SPEED,
  JEV_ASK_DEADLINE_SECONDS,
  JEV_ATTEMPT_TIMEOUT_MS,
  JEV_MAX_ATTEMPTS,
  JEV_MAX_IN_FLIGHT,
} from "./constants";
import {
  CONFIDENCE_THRESHOLD,
  EMPTY_PROBABILITIES,
  EMPTY_PROFILE_PROBABILITIES,
  birdAltitude,
  flightPathFor,
  shortRecoveryAllowed,
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
import { calculateActionProximityThreshold, obstacleClearedForShortDrop } from "../lib/timing";
import type { Obstacle } from "./obstacles";
import { logJevAct, logJevAsk, logJevReply } from "./jevLog";

export type JevSnapshot = {
  playing: boolean;
  crashed: boolean;
  speed: number;
  dinosaurMotion: DinosaurMotion;
  dinosaurX: number;
  /** True once the current jump has cleared min height (needed before short drop). */
  reachedMinHeight: boolean;
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
  profileStatus: JevIoStatus;
  ask: JevAskView | null;
  decision: DecideResponse | null;
  error?: string | null;
  profileError?: string | null;
};

export type JevRoundCost = {
  asks: number;
  inputTokens: number;
  costUsd: number;
};

export type JevControllerOptions = {
  getSnapshot: () => JevSnapshot | null;
  onIo: (view: JevIoView) => void;
  onCost?: (cost: JevRoundCost) => void;
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
  /** Maneuver body; next_obstacles may be refreshed for the profile call. */
  body: DecideBody;
  decision?: DecideResponse & { effectiveJumpProfile: JumpProfile };
  maneuverDurationMs?: number;
  maneuverError?: string | null;
  /** Profile result if it arrived before (or after) the maneuver. */
  profileResult?: {
    jump_profile: JumpProfile;
    profile_probabilities: JumpProfileProbabilities;
    durationMs: number;
  };
  profileError?: string | null;
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
  next_obstacles: Array<
    DescribedObstacle & {
      gap_px: number;
      seconds_until_next: number;
    }
  >;
  /** Maneuver already taken for this obstacle (profile ask). */
  maneuver?: DecideResponse["action"] | null;
};

/**
 * Per-obstacle planner with a FIFO plan queue:
 * - Each obstacle gets a plan that holds its ask + replies until that obstacle
 *   is cleared (then it is popped).
 * - Completing a later request never replaces the active (head) plan's I/O.
 * - Execution always reads the decision stored on that obstacle's plan.
 */
export class JevController {
  private frameHook: number | null = null;
  private seen = new Set<string>();
  /** Seen; waiting to fire profile once maneuver + next (or deadline) are known. */
  private awaitingProfile = new Set<string>();
  private plans = new Map<string, Plan>();
  /** Spawn order — head is the obstacle Jev is currently working. */
  private planOrder: string[] = [];
  private lastAction: "run" | "jump" | "duck" = "run";
  private lastDecision: DecideResponse | null = null;
  private lastAsk: JevAskView | null = null;
  private lastStatus: JevIoStatus = "idle";
  private lastError: string | null = null;
  private lastProfileStatus: JevIoStatus = "idle";
  private lastProfileError: string | null = null;
  private pressJump = 0;
  private pressDuck = 0;
  private jumpProfile: JumpProfile = "full";
  /**
   * Short jump: stay airborne until this obstacle's width has scrolled past,
   * then duck (speed-drop). Code-owned; not a Jev parameter.
   */
  private shortHopObstacle: Obstacle | null = null;
  private options: JevControllerOptions;
  private decideQueue: Array<() => Promise<void>> = [];
  private inFlight = 0;
  private roundAsks = 0;
  private roundInputTokens = 0;
  private roundCostUsd = 0;
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

  get roundCost(): JevRoundCost {
    return {
      asks: this.roundAsks,
      inputTokens: this.roundInputTokens,
      costUsd: this.roundCostUsd,
    };
  }

  private recordUsage(usage?: {
    input_tokens?: number;
    cost_usd?: number;
  } | null) {
    const tokens =
      typeof usage?.input_tokens === "number" &&
      Number.isFinite(usage.input_tokens)
        ? Math.max(0, usage.input_tokens)
        : 400;
    const cost =
      typeof usage?.cost_usd === "number" && Number.isFinite(usage.cost_usd)
        ? Math.max(0, usage.cost_usd)
        : (tokens / 1_000_000) * 0.042;
    this.roundAsks += 1;
    this.roundInputTokens += tokens;
    this.roundCostUsd += cost;
    this.options.onCost?.(this.roundCost);
  }

  private emitIo(
    status: JevIoStatus,
    ask = this.lastAsk,
    decision = this.lastDecision,
    error: string | null = null,
    profileStatus = this.lastProfileStatus,
    profileError: string | null = this.lastProfileError,
  ) {
    this.lastStatus = status;
    this.lastError = status === "error" ? error : null;
    this.lastProfileStatus = profileStatus;
    this.lastProfileError =
      profileStatus === "error" ? profileError : null;
    if (ask) this.lastAsk = ask;
    if (decision) this.lastDecision = decision;
    this.options.onIo({
      status,
      profileStatus,
      ask,
      decision,
      error: this.lastError,
      profileError: this.lastProfileError,
    });
  }

  /** Front of the FIFO plan queue (next obstacle still in play). */
  private activePlan(): Plan | null {
    while (this.planOrder.length > 0) {
      const id = this.planOrder[0]!;
      const plan = this.plans.get(id);
      if (!plan) {
        this.planOrder.shift();
        continue;
      }
      return plan;
    }
    return null;
  }

  /**
   * Publish I/O for the queue head only. Later replies stay on their plan
   * until that plan becomes the head.
   */
  private publishActiveIo() {
    const plan = this.activePlan();
    if (!plan) {
      this.emitIo("idle", this.lastAsk, this.lastDecision, null, "idle", null);
      return;
    }

    let status: JevIoStatus = "idle";
    if (plan.status === "pending") status = "thinking";
    else if (
      plan.status === "ready" ||
      plan.status === "ducking" ||
      plan.status === "executed"
    ) {
      status = "ready";
    } else if (plan.status === "skipped") status = "skipped";
    else if (plan.status === "late") status = "late";
    else if (plan.status === "error") status = "error";

    let profileStatus: JevIoStatus = "idle";
    if (plan.profileError) {
      profileStatus = "error";
    } else if (plan.profileResult) {
      profileStatus = "ready";
    } else if (
      plan.profileQueued &&
      plan.status !== "late" &&
      plan.status !== "skipped" &&
      plan.status !== "error"
    ) {
      profileStatus = "thinking";
    }

    this.emitIo(
      status,
      plan.ask,
      plan.decision ?? this.lastDecision,
      plan.maneuverError ?? null,
      profileStatus,
      plan.profileError ?? null,
    );
  }

  /** Obstacle cleared — drop its plan and surface the next queued one. */
  private retirePlan(id: string) {
    const plan = this.plans.get(id);
    if (plan && plan.status === "pending") plan.abort.abort();
    this.plans.delete(id);
    this.awaitingProfile.delete(id);
    const idx = this.planOrder.indexOf(id);
    if (idx >= 0) this.planOrder.splice(idx, 1);
    this.publishActiveIo();
  }

  start() {
    this.stop();
    this.running = true;
    this.seen.clear();
    this.awaitingProfile.clear();
    this.plans.clear();
    this.planOrder = [];
    this.decideQueue = [];
    this.inFlight = 0;
    this.lastAction = "run";
    this.lastDecision = null;
    this.lastAsk = null;
    this.lastStatus = "idle";
    this.lastError = null;
    this.lastProfileStatus = "idle";
    this.lastProfileError = null;
    this.pressJump = 0;
    this.pressDuck = 0;
    this.jumpProfile = "full";
    this.shortHopObstacle = null;
    this.roundAsks = 0;
    this.roundInputTokens = 0;
    this.roundCostUsd = 0;
    this.options.onCost?.(this.roundCost);
    console.log(
      `%c[Jev]%c FIFO plan queue; max ${JEV_MAX_IN_FLIGHT} fetches in flight`,
      "color:#0a7;font-weight:700",
      "color:inherit",
    );
    this.emitIo("idle", null, null, null, "idle", null);
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
    this.planOrder = [];
    this.seen.clear();
    this.awaitingProfile.clear();
    this.pressJump = 0;
    this.pressDuck = 0;
    this.shortHopObstacle = null;
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
    this.flushProfileAsks(snapshot);
    this.executePlans(snapshot);
  }

  private observeObstacles(snapshot: JevSnapshot) {
    // Maneuver asks fire immediately. Profile waits for next context.
    for (const obstacle of snapshot.obstacles) {
      if (obstacle.remove || this.seen.has(obstacle.id)) continue;
      this.seen.add(obstacle.id);
      this.queueDecision(obstacle, snapshot);
    }
  }

  /**
   * Fire profile once the maneuver is known and at least one follow-up is
   * available (or the ask deadline hits).
   */
  private flushProfileAsks(snapshot: JevSnapshot) {
    for (const id of [...this.awaitingProfile]) {
      const plan = this.plans.get(id);
      if (!plan || plan.profileQueued) {
        this.awaitingProfile.delete(id);
        continue;
      }
      if (
        plan.status === "late" ||
        plan.status === "skipped" ||
        plan.status === "error" ||
        plan.status === "executed"
      ) {
        this.awaitingProfile.delete(id);
        continue;
      }

      // Need the maneuver we just took before asking for recovery profile.
      if (!plan.decision) continue;

      const obstacle = snapshot.obstacles.find((o) => o.id === id) ?? plan.obstacle;
      const nexts = this.findNextObstacles(obstacle, snapshot, 2);
      const threshold = calculateActionProximityThreshold({
        baseSpeed: BASE_SPEED,
        currentSpeed: snapshot.speed,
        dinosaurX: snapshot.dinosaurX,
        obstacleWidth: obstacle.width,
        action: plan.decision.action,
        jumpProfile: "full",
      });
      const pxPerSec = Math.max(snapshot.speed, 0.1) * 60;
      const secondsToAct = Math.max(0, (obstacle.xPos - threshold) / pxPerSec);
      // Prefer waiting for a follow-up; fire anyway near the action deadline.
      if (nexts.length === 0 && secondsToAct > JEV_ASK_DEADLINE_SECONDS) {
        continue;
      }

      this.awaitingProfile.delete(id);
      this.queueJumpProfile(plan);
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

  private findNextObstacles(
    obstacle: Obstacle,
    snapshot: JevSnapshot,
    limit = 2,
  ): Array<{
    obstacle: Obstacle;
    gap_px: number;
    seconds_until_next: number;
  }> {
    const ahead = snapshot.obstacles
      .filter((o) => !o.remove && o.xPos > obstacle.xPos)
      .sort((a, b) => a.xPos - b.xPos)
      .slice(0, Math.max(0, limit));
    const pxPerSec = Math.max(snapshot.speed, 0.1) * 60;
    const out: Array<{
      obstacle: Obstacle;
      gap_px: number;
      seconds_until_next: number;
    }> = [];
    let prev = obstacle;
    for (const next of ahead) {
      const gap_px = Math.max(
        0,
        Math.round(next.xPos - (prev.xPos + prev.width)),
      );
      out.push({
        obstacle: next,
        gap_px,
        seconds_until_next: gap_px / pxPerSec,
      });
      prev = next;
    }
    return out;
  }

  private buildNextDescribed(
    obstacle: Obstacle,
    snapshot: JevSnapshot,
  ): DecideBody["next_obstacles"] {
    return this.findNextObstacles(obstacle, snapshot, 2).map((next) => ({
      ...this.describeObstacle(next.obstacle),
      gap_px: next.gap_px,
      seconds_until_next: next.seconds_until_next,
    }));
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
      next_obstacles: nextDescribed.map((n) => ({
        id: n.id,
        type: n.type,
        bird_altitude: n.bird_altitude,
        kind: n.kind,
        group: n.group,
        flight_path: n.flight_path,
        width_px: n.width_px,
        gap_px: n.gap_px,
        seconds_until_next: n.seconds_until_next,
      })),
    };
    const body: DecideBody = {
      speed: ask.speed,
      dinosaur_motion: ask.dinosaur_motion,
      obstacle: described,
      next_obstacles: nextDescribed,
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
    this.planOrder.push(obstacle.id);
    this.awaitingProfile.add(obstacle.id);
    // Head of queue drives the panel — later asks stay parked on their plan.
    this.publishActiveIo();
    console.log(
      `%c[Jev]%c enqueue ${obstacle.id} (queue ${this.planOrder.length})`,
      "color:#0a7;font-weight:600",
      "color:inherit",
    );

    // Maneuver immediately; profile flushes once next (or deadline) is ready.
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
          AbortSignal.timeout(JEV_ATTEMPT_TIMEOUT_MS),
        ]),
      });
      if (!response.ok) throw new Error(`decide failed (${response.status})`);
      const decision = (await response.json()) as DecideResponse;
      if (!this.running) return;
      if (this.plans.get(plan.obstacleId) !== plan || plan.status !== "pending") {
        return;
      }

      if (decision.source === "jev") {
        this.recordUsage(decision.usage);
      }

      // Soft server failure — retry while attempts remain instead of skipping.
      if (
        (decision.source === "none" ||
          decision.confidence < CONFIDENCE_THRESHOLD) &&
        attempt + 1 < JEV_MAX_ATTEMPTS
      ) {
        throw new Error(
          decision.source === "none"
            ? "empty Jev response"
            : "low confidence",
        );
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
      plan.maneuverDurationMs = enriched.durationMs;
      plan.maneuverError = null;

      if (
        decision.source === "none" ||
        decision.confidence < CONFIDENCE_THRESHOLD
      ) {
        plan.status = "skipped";
        logJevReply(enriched, body);
        this.publishActiveIo();
        console.log(
          "%c[Jev]%c skipped (low confidence or error) %s",
          "color:#666;font-weight:600",
          "color:inherit",
          decision.action,
        );
        return;
      }

      // Maneuver is enough to act. Merge profile if it already returned.
      plan.status = "ready";
      this.mergeProfileIntoDecision(plan);
      logJevReply(plan.decision!, body);
      this.publishActiveIo();
    } catch (error) {
      if (!this.running) return;
      if (this.plans.get(plan.obstacleId) !== plan) return;
      if (plan.status !== "pending") return;
      // Plan cancelled (late / race end) — do not retry.
      if (plan.abort.signal.aborted) return;

      if (attempt + 1 < JEV_MAX_ATTEMPTS) {
        console.log(
          `%c[Jev]%c retry maneuver ${attempt + 2}/${JEV_MAX_ATTEMPTS} %s (%s)`,
          "color:#c60;font-weight:600",
          "color:inherit",
          plan.obstacleId,
          error instanceof Error ? error.message : "request failed",
        );
        await this.fetchManeuver(plan, ask, body, attempt + 1);
        return;
      }

      plan.status = "error";
      plan.maneuverError =
        error instanceof Error ? error.message : "request failed";
      this.publishActiveIo();
      console.log(
        "%c[Jev reply]%c (request failed after retries) %s",
        "color:#666;font-weight:600",
        "color:inherit",
        plan.maneuverError,
      );
    }
  }

  private queueJumpProfile(plan: Plan) {
    if (plan.profileQueued) return;
    plan.profileQueued = true;
    plan.profileError = null;
    this.publishActiveIo();
    this.enqueueFetch(async () => {
      if (!this.running || this.plans.get(plan.obstacleId) !== plan) return;
      if (
        plan.status === "late" ||
        plan.status === "skipped" ||
        plan.status === "error"
      ) {
        this.publishActiveIo();
        return;
      }
      await this.fetchJumpProfile(plan);
    });
  }

  private effectiveProfileFor(
    action: DecideResponse["action"],
    ask: JevAskView,
    raw: JumpProfile,
  ): JumpProfile {
    if (raw !== "short") return "full";
    if (!shortRecoveryAllowed(action, ask.obstacle)) return "full";
    return "short";
  }

  private mergeProfileIntoDecision(plan: Plan): void {
    if (!plan.decision) return;
    const action = plan.decision.action;
    if (action === "keep_running") {
      plan.decision = {
        ...plan.decision,
        jump_profile: "full",
        profile_probabilities: { ...EMPTY_PROFILE_PROBABILITIES },
        effectiveJumpProfile: "full",
      };
      return;
    }

    const raw = plan.profileResult;
    if (!raw) {
      // Still waiting — default full so we never under-clear before Jev answers.
      plan.decision = {
        ...plan.decision,
        jump_profile: "full",
        profile_probabilities: { ...EMPTY_PROFILE_PROBABILITIES },
        effectiveJumpProfile: "full",
      };
      return;
    }

    const effectiveJumpProfile = this.effectiveProfileFor(
      action,
      plan.ask,
      raw.jump_profile,
    );
    plan.decision = {
      ...plan.decision,
      jump_profile: effectiveJumpProfile,
      profile_probabilities: raw.profile_probabilities,
      effectiveJumpProfile,
      durationMs:
        (plan.maneuverDurationMs ?? plan.decision.durationMs) + raw.durationMs,
    };
  }

  private async fetchJumpProfile(plan: Plan, attempt = 0): Promise<void> {
    // Refresh next two + pass the maneuver just taken for recovery sizing.
    const snapshot = this.options.getSnapshot();
    const nextDescribed = snapshot
      ? this.buildNextDescribed(plan.obstacle, snapshot)
      : plan.body.next_obstacles;
    const liveSpeed = snapshot?.speed ?? plan.body.speed;
    const body: DecideBody = {
      ...plan.body,
      speed: liveSpeed,
      next_obstacles: nextDescribed,
      maneuver: plan.decision?.action ?? null,
    };
    plan.ask = {
      ...plan.ask,
      speed: liveSpeed,
      next_obstacles: nextDescribed.map((n) => ({
        id: n.id,
        type: n.type,
        bird_altitude: n.bird_altitude,
        kind: n.kind,
        group: n.group,
        flight_path: n.flight_path,
        width_px: n.width_px,
        gap_px: n.gap_px,
        seconds_until_next: n.seconds_until_next,
      })),
    };

    try {
      const response = await fetch("/api/jev-jump-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.any([
          plan.abort.signal,
          AbortSignal.timeout(JEV_ATTEMPT_TIMEOUT_MS),
        ]),
      });
      if (!response.ok) {
        throw new Error(`jump profile failed (${response.status})`);
      }
      const result = (await response.json()) as {
        jump_profile?: JumpProfile;
        profile_probabilities?: JumpProfileProbabilities;
        durationMs?: number;
        source?: string;
        usage?: {
          input_tokens?: number;
          cost_usd?: number;
        };
      };
      if (!this.running) return;
      if (this.plans.get(plan.obstacleId) !== plan) return;

      if (result.source === "jev") {
        this.recordUsage(result.usage);
      }

      if (result.source === "none" && attempt + 1 < JEV_MAX_ATTEMPTS) {
        throw new Error("empty profile response");
      }

      plan.profileResult = {
        jump_profile: result.jump_profile === "short" ? "short" : "full",
        profile_probabilities: result.profile_probabilities ?? {
          short: 0,
          full: 1,
        },
        durationMs: result.durationMs ?? 0,
      };
      plan.profileError = null;

      if (plan.decision) {
        this.mergeProfileIntoDecision(plan);
        if (
          plan.status === "ready" ||
          plan.status === "ducking" ||
          plan.status === "executed"
        ) {
          console.log(
            `%c[Jev profile]%c ${plan.decision.effectiveJumpProfile} short=${Math.round((plan.decision.profile_probabilities.short ?? 0) * 100)}% full=${Math.round((plan.decision.profile_probabilities.full ?? 0) * 100)}% vs ${plan.obstacleId}`,
            "color:#0a7;font-weight:600",
            "color:inherit",
          );
        }
      }
      // Only the queue head is published — later profiles wait their turn.
      this.publishActiveIo();
    } catch (error) {
      if (plan.abort.signal.aborted) return;
      if (attempt + 1 < JEV_MAX_ATTEMPTS) {
        console.log(
          `%c[Jev]%c retry profile ${attempt + 2}/${JEV_MAX_ATTEMPTS} %s (%s)`,
          "color:#c60;font-weight:600",
          "color:inherit",
          plan.obstacleId,
          error instanceof Error ? error.message : "request failed",
        );
        await this.fetchJumpProfile(plan, attempt + 1);
        return;
      }
      const message =
        error instanceof Error ? error.message : "request failed";
      console.log(
        "%c[Jev]%c jump profile missed after retries, keeping full (%s)",
        "color:#666;font-weight:600",
        "color:inherit",
        message,
      );
      plan.profileResult = {
        jump_profile: "full",
        profile_probabilities: { short: 0, full: 1 },
        durationMs: 0,
      };
      plan.profileError = message;
      if (plan.decision) this.mergeProfileIntoDecision(plan);
      this.publishActiveIo();
    }
  }

  private executePlans(snapshot: JevSnapshot) {
    let wantJump = false;
    let wantDuck = false;

    // Short hop: same duck physics as the player; press duck a touch early once
    // the trailing edge is nearly past (see obstacleClearedForShortDrop).
    if (this.shortHopObstacle) {
      if (snapshot.dinosaurMotion === "jumping") {
        if (
          snapshot.reachedMinHeight &&
          obstacleClearedForShortDrop({
            dinosaurX: snapshot.dinosaurX,
            obstacleX: this.shortHopObstacle.xPos,
            obstacleWidth: this.shortHopObstacle.width,
          })
        ) {
          wantDuck = true;
        }
      } else {
        this.shortHopObstacle = null;
      }
    }

    // Act in spawn order so a later reply cannot jump the queue.
    for (const id of [...this.planOrder]) {
      const plan = this.plans.get(id);
      if (!plan) {
        this.retirePlan(id);
        continue;
      }
      const obstacle = plan.obstacle;
      const passed =
        obstacle.remove ||
        obstacle.xPos + obstacle.width < snapshot.dinosaurX - 4;

      if (passed) {
        this.retirePlan(id);
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
          // Short duck: stand up once the bird's leading body has cleared,
          // so we can jump/duck the next obstacle from a neutral run.
          if (jumpProfile === "short") {
            const earlyClear =
              obstacle.xPos + Math.min(obstacle.width * 0.4, 16) <
              snapshot.dinosaurX;
            if (earlyClear) {
              plan.status = "executed";
              continue;
            }
          }
          wantDuck = true;
        }
        continue;
      }

      if (plan.status === "pending") {
        // Maneuver itself arrived too late — abort this obstacle only.
        plan.status = "late";
        plan.abort.abort();
        this.publishActiveIo();
        console.log(
          "%c[Jev]%c late, skipped %s",
          "color:#c60;font-weight:600",
          "color:inherit",
          id,
        );
        continue;
      }

      if (plan.status === "ducking") {
        if (jumpProfile === "short") {
          const earlyClear =
            obstacle.xPos + Math.min(obstacle.width * 0.4, 16) <
            snapshot.dinosaurX;
          if (earlyClear) {
            plan.status = "executed";
            continue;
          }
        }
        wantDuck = true;
        continue;
      }

      if (plan.status !== "ready") continue;

      if (action === "jump") {
        if (snapshot.dinosaurMotion === "jumping") {
          continue;
        }
        if (snapshot.dinosaurMotion === "ducking") {
          // Stand up first so the next hop starts from neutral.
          wantDuck = false;
          continue;
        }
        wantJump = true;
        this.jumpProfile = jumpProfile;
        this.shortHopObstacle =
          jumpProfile === "short" ? obstacle : null;
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
