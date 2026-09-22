import {
  BASE_SPEED,
  CLEAR_TIME_MS,
  DEFAULT_WIDTH,
  GAME_DURATION_MS,
  LANE_GAP,
  LANE_HEIGHT,
  SPECTATE_ACCEL_MULT,
  SPECTATE_ELAPSED_MULT,
  SPECTATE_MIN_SPEED,
  SPECTATE_MS,
} from "./constants";
import { Dino } from "./dino";
import { CloudField, HorizonLine } from "./horizon";
import { JevController, type JevSnapshot } from "./jevController";
import { ObstacleManager } from "./obstacles";
import { MAX_SPEED, stepSpeed } from "./speedCurve";
import type { DecideResponse, DinosaurMotion } from "../lib/jev-contract";

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
      getSnapshot: () => this.buildJevSnapshot(),
      onDecision: (decision) => {
        this.lastJev = decision;
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
  }

  /** Snapshot for per-obstacle Jev planning (ref: jev-t-rex-runner). */
  private buildJevSnapshot(): JevSnapshot | null {
    if (!this.live || this.jev.crashed) return null;
    const dinosaurMotion: DinosaurMotion = this.jev.jumping
      ? "jumping"
      : this.jev.ducking
        ? "ducking"
        : "running";
    return {
      playing: this.live,
      crashed: this.jev.crashed,
      speed: this.speed,
      dinosaurMotion,
      dinosaurX: this.jev.xPos,
      obstacles: this.obstacles.obstacles,
    };
  }

  private update(deltaTime: number) {
    if (!this.live) return;

    const spectating = this.phase === "spectating";
    // After you crash, pack late-race difficulty into a short watch window.
    // Boost speed + difficulty clock only — dino physics stay on real deltaTime
    // so jump arcs still look right; proximity timing uses the higher speed.
    const difficultyDt = spectating
      ? deltaTime * SPECTATE_ELAPSED_MULT
      : deltaTime;
    const speedDt = spectating ? deltaTime * SPECTATE_ACCEL_MULT : deltaTime;

    this.elapsedMs += difficultyDt;
    this.clearTimer += deltaTime;
    if (spectating) this.spectateElapsedMs += deltaTime;
    // Chromium-style: nudge speed every frame toward MAX_SPEED.
    this.speed = stepSpeed(this.speed, speedDt);
    if (spectating) {
      this.speed = Math.min(MAX_SPEED, Math.max(this.speed, SPECTATE_MIN_SPEED));
    }

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
      // Controller owns one maneuver per obstacle + proximity timing.
      // Jump / duck are independent keys (Chromium-style).
      const { jump: jumpKey, duck: duckKey, jumpProfile } =
        this.jevController.keys;
      const jumpHeld = jumpKey >= 0.45;
      const duckHeld = duckKey >= 0.45;

      if (this.jev.jumping) {
        this.jev.setDuck(duckHeld);
      } else if (duckHeld) {
        this.jev.setDuck(true);
      } else {
        this.jev.setDuck(false);
        if (jumpHeld) this.jev.jump(jumpProfile);
      }

      this.jev.update(deltaTime);
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
    // Skip the early crawl — jump straight into a fast showcase stretch.
    this.speed = Math.min(MAX_SPEED, Math.max(this.speed, SPECTATE_MIN_SPEED));
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
