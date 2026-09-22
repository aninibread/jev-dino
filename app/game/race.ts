import {
  BASE_SPEED,
  CLEAR_TIME_MS,
  DEFAULT_WIDTH,
  GAME_DURATION_MS,
  LANE_GAP,
  LANE_HEIGHT,
  SPECTATE_MS,
  TREX,
} from "./constants";
import { Dino } from "./dino";
import { CloudField, HorizonLine } from "./horizon";
import { JevController } from "./jevController";
import { ObstacleManager } from "./obstacles";
import { stepSpeed } from "./speedCurve";
import type {
  ActionEvent,
  DecideResponse,
  JevAction,
  PastDecision,
} from "../lib/jev-contract";
import {
  birdAltitude,
  obstacleRelation,
  VISIBLE_COUNT,
} from "../lib/jev-contract";

export type RacePhase = "idle" | "playing" | "spectating" | "ended";
export type Winner = "you" | "jev" | "tie" | null;

export type RaceSnapshot = {
  phase: RacePhase;
  elapsedMs: number;
  speed: number;
  youCrashed: boolean;
  jevCrashed: boolean;
  winner: Winner;
  youDistance: number;
  jevDistance: number;
  lastJev: DecideResponse | null;
  /** Seconds left in the watch-Jev window (spectating only). */
  spectateLeftMs: number;
};

export type RaceCallbacks = {
  onChange?: (snapshot: RaceSnapshot) => void;
};

export class RaceGame {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  sprite: HTMLImageElement;
  you: Dino;
  jev: Dino;
  obstacles = new ObstacleManager();
  horizonYou = new HorizonLine();
  horizonJev = new HorizonLine();
  cloudsYou = new CloudField();
  cloudsJev = new CloudField();
  jevController: JevController;

  phase: RacePhase = "idle";
  elapsedMs = 0;
  clearTimer = 0;
  speed = BASE_SPEED;
  youDistance = 0;
  jevDistance = 0;
  winner: Winner = null;
  lastJev: DecideResponse | null = null;
  private spectateElapsedMs = 0;
  /** Frozen bitmap of the YOU lane after crash (spectate / ended). */
  private youFreeze: HTMLCanvasElement | null = null;
  private raf = 0;
  private lastTime = 0;
  private keys = new Set<string>();
  private callbacks: RaceCallbacks;
  private duckHeld = false;

  /** Observational memory for Jev (not advice). */
  private prevAction: JevAction = "run";
  private currentAction: JevAction = "run";
  private recentActions: ActionEvent[] = [];
  private lastDecisions: PastDecision[] = [];
  private actionStartedAtMs = 0;
  private prevActionHeldForS = 0;
  private jumpedForIds = new Set<string>();
  private nearestIdWhenJumpStarted: string | null = null;
  private jumpStartedAtMs = 0;
  private landedAtMs = -1e9;
  private wasJevAirborne = false;
  private justLanded = false;

  constructor(
    canvas: HTMLCanvasElement,
    sprite: HTMLImageElement,
    callbacks: RaceCallbacks = {},
  ) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas unsupported");
    this.ctx = ctx;
    this.sprite = sprite;
    this.callbacks = callbacks;
    this.you = new Dino("YOU");
    this.jev = new Dino("JEV");
    this.jevController = new JevController({
      getState: () => this.buildJevState(),
      onDecision: (decision) => {
        this.lastJev = decision;
        this.recordDecision(decision);
        this.noteAction(decision.action);
        this.applyJevAction(decision.action);
        this.emit();
      },
    });
    this.resize();
    this.bindInput();
    this.resetWorld();
    this.draw();
  }

  get height() {
    return LANE_HEIGHT * 2 + LANE_GAP;
  }

  private get live() {
    return this.phase === "playing" || this.phase === "spectating";
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = DEFAULT_WIDTH * dpr;
    this.canvas.height = this.height * dpr;
    // Let CSS control display size so the canvas can shrink on phones.
    this.canvas.style.width = "100%";
    this.canvas.style.height = "auto";
    this.canvas.style.aspectRatio = `${DEFAULT_WIDTH} / ${this.height}`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private bindInput() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("resize", this.onResize);
    this.canvas.addEventListener("pointerdown", this.onCanvasPointerDown);
  }

  destroy() {
    this.stopLoop();
    this.jevController.stop();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("resize", this.onResize);
    this.canvas.removeEventListener("pointerdown", this.onCanvasPointerDown);
  }

  private onResize = () => {
    this.resize();
    this.draw();
  };

  private onCanvasPointerDown = (event: PointerEvent) => {
    // Tap / click the track to jump (or start). Ignore right-click.
    if (event.button !== 0) return;
    event.preventDefault();
    this.pressJump();
  };

  private onKeyDown = (event: KeyboardEvent) => {
    if (["Space", "ArrowUp", "ArrowDown", "Enter"].includes(event.code)) {
      event.preventDefault();
    }
    if (this.keys.has(event.code)) return;
    this.keys.add(event.code);

    if (
      (this.phase === "idle" || this.phase === "ended") &&
      (event.code === "Enter" || event.code === "Space")
    ) {
      this.start();
      return;
    }
    // Spectating: Space/Enter skips to the result screen.
    if (this.phase === "spectating" && (event.code === "Enter" || event.code === "Space")) {
      this.finish(this.winner ?? "jev");
      return;
    }
    if (this.phase !== "playing") return;

    if (event.code === "Space" || event.code === "ArrowUp") {
      this.you.jump();
    }
    if (event.code === "ArrowDown") {
      this.duckHeld = true;
      this.you.setDuck(true);
    }
  };

  private onKeyUp = (event: KeyboardEvent) => {
    this.keys.delete(event.code);
    if (event.code === "ArrowDown") {
      this.duckHeld = false;
      this.you.setDuck(false);
    }
    if (event.code === "Space" || event.code === "ArrowUp") {
      this.you.endJump();
    }
  };

  /** Touch / button helpers for mobile. */
  pressJump() {
    if (this.phase === "idle" || this.phase === "ended") {
      this.start();
      return;
    }
    if (this.phase === "playing") this.you.jump();
  }

  pressDuck(down: boolean) {
    if (this.phase === "idle" || this.phase === "ended") {
      if (down) this.start();
      return;
    }
    if (this.phase !== "playing") return;
    this.duckHeld = down;
    this.you.setDuck(down);
  }

  start() {
    this.resetWorld();
    this.phase = "playing";
    this.elapsedMs = 0;
    this.clearTimer = 0;
    this.spectateElapsedMs = 0;
    this.youFreeze = null;
    this.speed = BASE_SPEED;
    this.winner = null;
    this.youDistance = 0;
    this.jevDistance = 0;
    this.lastJev = null;
    this.duckHeld = false;
    this.you.startRunning();
    this.jev.startRunning();
    this.jevController.start();
    this.emit();
    this.startLoop();
  }

  private resetWorld() {
    this.you.reset();
    this.jev.reset();
    this.obstacles.reset();
    this.horizonYou.reset();
    this.horizonJev.reset();
    this.cloudsYou.reset();
    this.cloudsJev.reset();
    this.prevAction = "run";
    this.currentAction = "run";
    this.recentActions = [
      {
        action: "run",
        at_t: 0,
        held_for_s: 0,
        nearest_obstacle_id: null,
        nearest_obstacle_type: null,
        nearest_width_px: null,
        nearest_height_px: null,
      },
    ];
    this.lastDecisions = [];
    this.actionStartedAtMs = 0;
    this.prevActionHeldForS = 0;
    this.jumpedForIds.clear();
    this.nearestIdWhenJumpStarted = null;
    this.jumpStartedAtMs = 0;
    this.landedAtMs = -1e9;
    this.wasJevAirborne = false;
    this.justLanded = false;
  }

  private recordDecision(decision: DecideResponse) {
    this.lastDecisions.push({
      action: decision.action,
      press_jump: decision.press_jump,
      press_duck: decision.press_duck,
      at_t: Number((this.elapsedMs / 1000).toFixed(3)),
    });
    if (this.lastDecisions.length > 4) this.lastDecisions.shift();
  }

  private noteAction(action: JevAction) {
    if (action === this.currentAction) return;
    const nowMs = this.elapsedMs;
    const heldForS = Number(
      Math.max(0, (nowMs - this.actionStartedAtMs) / 1000).toFixed(3),
    );

    // Close out the previous key-hold with how long it lasted + what was nearest.
    if (this.recentActions.length > 0) {
      const last = this.recentActions[this.recentActions.length - 1]!;
      last.held_for_s = heldForS;
    }
    this.prevActionHeldForS = heldForS;
    this.prevAction = this.currentAction;
    this.currentAction = action;
    this.actionStartedAtMs = nowMs;

    const nearest = this.obstacles.upcomingFor(TREX.START_X, 1)[0];
    this.recentActions.push({
      action,
      at_t: Number((nowMs / 1000).toFixed(3)),
      held_for_s: 0,
      nearest_obstacle_id: nearest?.id ?? null,
      nearest_obstacle_type: nearest?.type ?? null,
      nearest_width_px: nearest ? Math.round(nearest.width) : null,
      nearest_height_px: nearest ? Math.round(nearest.height) : null,
    });
    if (this.recentActions.length > 8) this.recentActions.shift();
  }

  /** Track jump/land edges and which obstacle a jump was for. */
  private trackJevMemory() {
    const airborne = !this.jev.grounded;
    // Keep "just landed" true briefly so the next Jev ask still sees it.
    this.justLanded = this.elapsedMs - this.landedAtMs < 150;

    if (airborne && !this.wasJevAirborne) {
      // Jump just started — remember nearest visible threat.
      this.jumpStartedAtMs = this.elapsedMs;
      const nearest = this.obstacles.upcomingFor(TREX.START_X, 1)[0];
      this.nearestIdWhenJumpStarted = nearest?.id ?? null;
      if (nearest) this.jumpedForIds.add(nearest.id);
    }

    if (!airborne && this.wasJevAirborne) {
      this.landedAtMs = this.elapsedMs;
      this.justLanded = true;
    }

    // Drop memory for obstacles that have fully scrolled past.
    for (const o of this.obstacles.obstacles) {
      if (o.xPos + o.width < TREX.START_X - 10) {
        this.jumpedForIds.delete(o.id);
      }
    }

    this.wasJevAirborne = airborne;
  }

  private buildJevState() {
    if (!this.live || this.jev.crashed) return null;
    const px_per_sec = Math.max(this.speed, 0.1) * 60;
    const visibleLimitPx = DEFAULT_WIDTH - TREX.START_X;
    const groundY = this.jev.groundYPos;
    const airborne = !this.jev.grounded;
    const jumpHeightFrac = airborne
      ? Math.min(1, Math.max(0, (groundY - this.jev.yPos) / 55))
      : 0;
    const secondsAloft = airborne
      ? Math.max(0, (this.elapsedMs - this.jumpStartedAtMs) / 1000)
      : 0;
    const secondsSinceLanded = Math.max(
      0,
      (this.elapsedMs - this.landedAtMs) / 1000,
    );

    const decision = this.jevController.decision;
    const pressJump = decision?.press_jump ?? 0;
    const pressDuck = decision?.press_duck ?? 0;

    const visible = this.obstacles
      .upcomingFor(TREX.START_X, VISIBLE_COUNT)
      .filter((o) => o.dx < visibleLimitPx && o.dx + o.width > -30)
      .map((o) => ({
        id: o.id,
        type: o.type,
        dx: o.dx,
        width: o.width,
        height: o.height,
        y: o.y,
        seconds_away: o.dx / px_per_sec,
        relation: obstacleRelation(o.dx, o.width),
        already_jumped_for: this.jumpedForIds.has(o.id),
        ...(o.type === "bird" ? { bird_altitude: birdAltitude(o.y) } : {}),
      }));

    const gap_px =
      visible.length >= 2
        ? Math.round(
            visible[1]!.dx - (visible[0]!.dx + visible[0]!.width),
          )
        : null;

    return {
      t: this.elapsedMs / 1000,
      speed: this.speed,
      px_per_sec,
      dino: {
        grounded: this.jev.grounded,
        ducking: this.jev.ducking,
        airborne,
        ascending: this.jev.jumping && this.jev.jumpVelocity < 0,
        jump_height_frac: Number(jumpHeightFrac.toFixed(2)),
        seconds_aloft: Number(secondsAloft.toFixed(3)),
        just_landed: this.justLanded,
        seconds_since_landed: Number(
          Math.min(secondsSinceLanded, 30).toFixed(3),
        ),
      },
      controls: {
        current_action: this.currentAction,
        previous_action: this.prevAction,
        current_action_held_for_s: Number(
          Math.max(0, (this.elapsedMs - this.actionStartedAtMs) / 1000).toFixed(
            3,
          ),
        ),
        previous_action_held_for_s: this.prevActionHeldForS,
        jump_key_held: pressJump >= 0.45,
        duck_key_held: pressDuck >= 0.45,
        last_press_jump: Number(pressJump.toFixed(3)),
        last_press_duck: Number(pressDuck.toFixed(3)),
        nearest_id_when_jump_started: this.nearestIdWhenJumpStarted,
      },
      recent_actions: this.recentActions.slice(-6).map((ev) => ({
        ...ev,
        // Live duration for the still-open current hold.
        held_for_s:
          ev === this.recentActions[this.recentActions.length - 1] &&
          ev.action === this.currentAction
            ? Number(
                Math.max(
                  0,
                  (this.elapsedMs - this.actionStartedAtMs) / 1000,
                ).toFixed(3),
              )
            : ev.held_for_s,
      })),
      last_decisions: this.lastDecisions.slice(-3),
      visible,
      constraints: {
        can_jump_this_frame: this.jev.grounded && !this.jev.jumping,
        can_duck_this_frame: true,
        mid_air_duck_means_speed_drop: airborne,
      },
      gap_px,
    };
  }

  private applyJevAction(action: JevAction) {
    if (this.jev.crashed || !this.live) return;
    if (action === "jump") {
      this.jev.setDuck(false);
      this.jev.jump();
    } else if (action === "duck") {
      this.jev.setDuck(true);
    } else {
      // Release duck only — don't chop a jump arc with endJump.
      this.jev.setDuck(false);
    }
  }

  private update(deltaTime: number) {
    if (!this.live) return;

    this.elapsedMs += deltaTime;
    this.clearTimer += deltaTime;
    if (this.phase === "spectating") this.spectateElapsedMs += deltaTime;
    // Chromium-style: nudge speed every frame toward MAX_SPEED.
    this.speed = stepSpeed(this.speed, deltaTime);

    if (this.clearTimer > CLEAR_TIME_MS) {
      this.obstacles.update(deltaTime, this.speed, this.elapsedMs);
    }

    // YOU lane freezes on crash; only Jev's world keeps scrolling.
    if (this.phase === "playing") {
      this.horizonYou.update(deltaTime, this.speed);
      this.cloudsYou.update(deltaTime, this.speed);
    }
    this.horizonJev.update(deltaTime, this.speed);
    this.cloudsJev.update(deltaTime, this.speed);

    if (this.phase === "playing" && !this.you.crashed) {
      // Apply duck before physics so mid-air slam starts this frame.
      if (this.duckHeld) this.you.setDuck(true);
      this.you.update(deltaTime);
      this.youDistance += this.speed * deltaTime * 0.1;
    }

    if (!this.jev.crashed) {
      // Apply Jev's key holds every frame (same as a human holding keys).
      const act = this.jevController.action;
      this.noteAction(act);
      if (act === "duck") {
        this.jev.setDuck(true);
      } else if (act === "jump") {
        this.jev.setDuck(false);
        this.jev.jump();
      } else {
        this.jev.setDuck(false);
      }
      this.jev.update(deltaTime);
      this.trackJevMemory();
      this.jevDistance += this.speed * deltaTime * 0.1;
    } else {
      this.jev.update(deltaTime);
    }

    // Collisions against shared obstacle geometry
    for (const obstacle of this.obstacles.obstacles) {
      const boxes = obstacle.boxes();
      if (
        this.phase === "playing" &&
        !this.you.crashed &&
        this.you.collides(boxes)
      ) {
        this.you.crash();
      }
      if (!this.jev.crashed && this.jev.collides(boxes)) this.jev.crash();
    }

    this.resolveEnd();
    this.emit();
  }

  private beginSpectate() {
    this.phase = "spectating";
    this.winner = "jev";
    this.spectateElapsedMs = 0;
    this.duckHeld = false;
    this.captureYouLane();
    this.emit();
  }

  /** Snapshot the YOU lane so it stays a still frame while Jev keeps running. */
  private captureYouLane() {
    const freeze = document.createElement("canvas");
    freeze.width = DEFAULT_WIDTH;
    freeze.height = LANE_HEIGHT;
    const ctx = freeze.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#f7f7f7";
    ctx.fillRect(0, 0, DEFAULT_WIDTH, LANE_HEIGHT);
    this.cloudsYou.draw(ctx, this.sprite, 0);
    this.horizonYou.draw(ctx, this.sprite, 0);
    this.obstacles.draw(ctx, this.sprite, 0);
    this.you.draw(ctx, this.sprite, 0);
    this.youFreeze = freeze;
  }

  private resolveEnd() {
    if (this.phase === "spectating") {
      if (this.jev.crashed || this.spectateElapsedMs >= SPECTATE_MS) {
        this.finish("jev");
      }
      return;
    }

    if (this.phase !== "playing") return;

    if (this.you.crashed && !this.jev.crashed) {
      // You lost — keep the camera on Jev for a showcase stretch.
      this.beginSpectate();
      return;
    }
    if (this.jev.crashed && !this.you.crashed) {
      this.finish("you");
      return;
    }
    if (this.you.crashed && this.jev.crashed) {
      this.finish("tie");
      return;
    }
    if (this.elapsedMs >= GAME_DURATION_MS) {
      if (this.youDistance === this.jevDistance) this.finish("tie");
      else this.finish(this.youDistance > this.jevDistance ? "you" : "jev");
    }
  }

  private startLoop() {
    this.stopLoop();
    this.lastTime = performance.now();
    const tick = (now: number) => {
      const delta = Math.min(50, now - this.lastTime);
      this.lastTime = now;
      this.update(delta);
      this.draw();
      if (this.live) this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLoop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private finish(winner: Winner) {
    this.phase = "ended";
    this.winner = winner;
    this.jevController.stop();
    this.stopLoop();
    this.draw();
    this.emit();
  }

  private emit() {
    this.callbacks.onChange?.({
      phase: this.phase,
      elapsedMs: this.elapsedMs,
      speed: this.speed,
      youCrashed: this.you.crashed,
      jevCrashed: this.jev.crashed,
      winner: this.winner,
      youDistance: this.youDistance,
      jevDistance: this.jevDistance,
      lastJev: this.lastJev,
      spectateLeftMs:
        this.phase === "spectating"
          ? Math.max(0, SPECTATE_MS - this.spectateElapsedMs)
          : 0,
    });
  }

  private drawLane(
    laneOffsetY: number,
    dino: Dino,
    horizon: HorizonLine,
    clouds: CloudField,
  ) {
    this.ctx.fillStyle = "#f7f7f7";
    this.ctx.fillRect(0, laneOffsetY, DEFAULT_WIDTH, LANE_HEIGHT);
    clouds.draw(this.ctx, this.sprite, laneOffsetY);
    horizon.draw(this.ctx, this.sprite, laneOffsetY);
    this.obstacles.draw(this.ctx, this.sprite, laneOffsetY);
    dino.draw(this.ctx, this.sprite, laneOffsetY);
  }

  draw() {
    this.ctx.clearRect(0, 0, DEFAULT_WIDTH, this.height);
    if (this.youFreeze) {
      this.ctx.drawImage(this.youFreeze, 0, 0);
    } else {
      this.drawLane(0, this.you, this.horizonYou, this.cloudsYou);
    }
    this.drawLane(LANE_HEIGHT + LANE_GAP, this.jev, this.horizonJev, this.cloudsJev);

    // Divider
    this.ctx.fillStyle = "#e4e1db";
    this.ctx.fillRect(0, LANE_HEIGHT, DEFAULT_WIDTH, LANE_GAP);
  }
}
