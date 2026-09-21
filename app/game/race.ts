import {
  BASE_SPEED,
  CLEAR_TIME_MS,
  DEFAULT_WIDTH,
  GAME_DURATION_MS,
  LANE_GAP,
  LANE_HEIGHT,
  TREX,
} from "./constants";
import { Dino } from "./dino";
import { CloudField, HorizonLine } from "./horizon";
import { JevController } from "./jevController";
import { ObstacleManager } from "./obstacles";
import { speedMultiplier } from "./speedCurve";
import type { DecideResponse, JevAction } from "../lib/jev-contract";

export type RacePhase = "idle" | "playing" | "ended";
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
    this.jev = new Dino("JEV", "sepia(0.35) hue-rotate(160deg) saturate(1.4)");
    this.jevController = new JevController({
      getState: () => this.buildJevState(),
      onDecision: (decision) => {
        this.lastJev = decision;
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

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = DEFAULT_WIDTH * dpr;
    this.canvas.height = this.height * dpr;
    this.canvas.style.width = `${DEFAULT_WIDTH}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private bindInput() {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
  }

  destroy() {
    this.stopLoop();
    this.jevController.stop();
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
  }

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
    if (this.phase !== "playing") return;
    this.duckHeld = down;
    this.you.setDuck(down);
  }

  start() {
    this.resetWorld();
    this.phase = "playing";
    this.elapsedMs = 0;
    this.clearTimer = 0;
    this.speed = BASE_SPEED;
    this.winner = null;
    this.youDistance = 0;
    this.jevDistance = 0;
    this.lastJev = null;
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

  private startLoop() {
    this.stopLoop();
    this.lastTime = performance.now();
    const frame = (now: number) => {
      const delta = Math.min(now - this.lastTime, 50);
      this.lastTime = now;
      this.update(delta);
      this.draw();
      if (this.phase === "playing") {
        this.raf = requestAnimationFrame(frame);
      }
    };
    this.raf = requestAnimationFrame(frame);
  }

  private stopLoop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private buildJevState() {
    if (this.phase !== "playing" || this.jev.crashed) return null;
    return {
      t: this.elapsedMs / 1000,
      speed: this.speed,
      dino: {
        y: this.jev.yPos,
        vy: this.jev.jumpVelocity,
        ducking: this.jev.ducking,
        grounded: this.jev.grounded,
      },
      upcoming: this.obstacles.upcomingFor(TREX.START_X),
    };
  }

  private applyJevAction(action: JevAction) {
    if (this.jev.crashed || this.phase !== "playing") return;
    if (action === "jump") {
      this.jev.setDuck(false);
      this.jev.jump();
    } else if (action === "duck") {
      this.jev.setDuck(true);
    } else {
      this.jev.setDuck(false);
      this.jev.endJump();
    }
  }

  private update(deltaTime: number) {
    if (this.phase !== "playing") return;

    this.elapsedMs += deltaTime;
    this.clearTimer += deltaTime;
    this.speed = BASE_SPEED * speedMultiplier(this.elapsedMs);

    if (this.clearTimer > CLEAR_TIME_MS) {
      this.obstacles.update(deltaTime, this.speed, this.elapsedMs);
    }

    this.horizonYou.update(deltaTime, this.speed);
    this.horizonJev.update(deltaTime, this.speed);
    this.cloudsYou.update(deltaTime, this.speed);
    this.cloudsJev.update(deltaTime, this.speed);

    if (!this.you.crashed) {
      this.you.update(deltaTime);
      if (this.duckHeld) this.you.setDuck(true);
      this.youDistance += this.speed * deltaTime * 0.1;
    }
    if (!this.jev.crashed) {
      this.jev.update(deltaTime);
      // Re-apply duck if last action was duck and still needed
      if (this.jevController.action === "duck" && this.jev.grounded) {
        this.jev.setDuck(true);
      }
      this.jevDistance += this.speed * deltaTime * 0.1;
    }

    // Collisions against shared obstacle geometry
    for (const obstacle of this.obstacles.obstacles) {
      const boxes = obstacle.boxes();
      if (!this.you.crashed && this.you.collides(boxes)) this.you.crash();
      if (!this.jev.crashed && this.jev.collides(boxes)) this.jev.crash();
    }

    this.resolveEnd();
    this.emit();
  }

  private resolveEnd() {
    if (this.phase !== "playing") return;

    if (this.you.crashed && !this.jev.crashed) {
      this.finish("jev");
      return;
    }
    if (this.jev.crashed && !this.you.crashed) {
      this.finish("you");
      return;
    }
    if (this.you.crashed && this.jev.crashed) {
      // Same-frame double crash → tie
      this.finish("tie");
      return;
    }
    if (this.elapsedMs >= GAME_DURATION_MS) {
      if (this.youDistance === this.jevDistance) this.finish("tie");
      else this.finish(this.youDistance > this.jevDistance ? "you" : "jev");
    }
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
    this.drawLane(0, this.you, this.horizonYou, this.cloudsYou);
    this.drawLane(LANE_HEIGHT + LANE_GAP, this.jev, this.horizonJev, this.cloudsJev);

    // Divider
    this.ctx.fillStyle = "#e4e1db";
    this.ctx.fillRect(0, LANE_HEIGHT, DEFAULT_WIDTH, LANE_GAP);

    if (this.phase === "idle") {
      this.ctx.fillStyle = "rgba(247,247,247,0.72)";
      this.ctx.fillRect(0, 0, DEFAULT_WIDTH, this.height);
      this.ctx.fillStyle = "#191919";
      this.ctx.font = "600 16px Arial, Helvetica, sans-serif";
      this.ctx.textAlign = "center";
      this.ctx.fillText("Press space to race Jev", DEFAULT_WIDTH / 2, this.height / 2);
      this.ctx.textAlign = "start";
    }
  }
}
