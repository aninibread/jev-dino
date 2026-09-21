import {
  BOTTOM_PAD,
  GRAVITY,
  LANE_HEIGHT,
  SPEED_DROP_COEFFICIENT,
  SPRITE_LDPI,
  TREX,
  TREX_BOXES,
  TREX_FRAMES,
  type Box,
} from "./constants";
import { boxesOverlap } from "./collision";

export type DinoStatus = "WAITING" | "RUNNING" | "JUMPING" | "DUCKING" | "CRASHED";

export class Dino {
  xPos = TREX.START_X;
  yPos = 0;
  groundYPos = 0;
  jumpVelocity = 0;
  jumping = false;
  ducking = false;
  speedDrop = false;
  reachedMinHeight = false;
  status: DinoStatus = "WAITING";
  crashed = false;
  currentFrame = 0;
  timer = 0;
  msPerFrame = TREX_FRAMES.WAITING.msPerFrame;
  animFrames: readonly number[] = TREX_FRAMES.WAITING.frames;
  minJumpHeight = 0;
  label: string;
  tint: string | null;

  constructor(label: string, tint: string | null = null) {
    this.label = label;
    this.tint = tint;
    this.groundYPos = LANE_HEIGHT - TREX.HEIGHT - BOTTOM_PAD;
    this.yPos = this.groundYPos;
    this.minJumpHeight = this.groundYPos - 30;
  }

  reset() {
    this.xPos = TREX.START_X;
    this.yPos = this.groundYPos;
    this.jumpVelocity = 0;
    this.jumping = false;
    this.ducking = false;
    this.speedDrop = false;
    this.reachedMinHeight = false;
    this.crashed = false;
    this.status = "WAITING";
    this.currentFrame = 0;
    this.timer = 0;
    this.setStatus("WAITING");
  }

  setStatus(status: DinoStatus) {
    this.status = status;
    this.currentFrame = 0;
    this.timer = 0;
    const config = TREX_FRAMES[status];
    this.animFrames = config.frames;
    this.msPerFrame = config.msPerFrame;
  }

  startRunning() {
    if (this.crashed) return;
    this.setStatus("RUNNING");
  }

  jump() {
    if (this.crashed || this.jumping) return;
    this.setStatus("JUMPING");
    this.jumpVelocity = TREX.INITIAL_JUMP_VELOCITY;
    this.jumping = true;
    this.reachedMinHeight = false;
    this.speedDrop = false;
    if (this.ducking) {
      this.ducking = false;
    }
  }

  endJump() {
    if (
      this.reachedMinHeight &&
      this.jumpVelocity < TREX.DROP_VELOCITY
    ) {
      this.jumpVelocity = TREX.DROP_VELOCITY;
    }
  }

  setDuck(isDucking: boolean) {
    if (this.crashed || this.jumping) {
      if (isDucking) this.speedDrop = true;
      return;
    }
    if (isDucking && this.status !== "DUCKING") {
      this.ducking = true;
      this.setStatus("DUCKING");
    } else if (!isDucking && this.status === "DUCKING") {
      this.ducking = false;
      this.setStatus("RUNNING");
    }
  }

  update(deltaTime: number) {
    this.timer += deltaTime;
    if (this.timer >= this.msPerFrame) {
      this.currentFrame =
        this.currentFrame === this.animFrames.length - 1
          ? 0
          : this.currentFrame + 1;
      this.timer = 0;
    }

    if (this.speedDrop) {
      this.yPos += Math.round(
        this.jumpVelocity * SPEED_DROP_COEFFICIENT * (deltaTime / (1000 / 60)),
      );
    } else if (this.jumping) {
      this.yPos += Math.round(this.jumpVelocity * (deltaTime / (1000 / 60)));
      this.jumpVelocity += GRAVITY * (deltaTime / (1000 / 60));
      if (this.yPos > this.minJumpHeight) {
        this.reachedMinHeight = true;
      }
    }

    if (this.yPos > this.groundYPos) {
      this.yPos = this.groundYPos;
      this.jumping = false;
      this.speedDrop = false;
      this.jumpVelocity = 0;
      if (!this.crashed) {
        if (this.ducking) this.setStatus("DUCKING");
        else this.setStatus("RUNNING");
      }
    }
  }

  crash() {
    this.crashed = true;
    this.jumping = false;
    this.ducking = false;
    this.setStatus("CRASHED");
  }

  collisionBoxes(): Box[] {
    const source = this.ducking ? TREX_BOXES.DUCKING : TREX_BOXES.RUNNING;
    return source.map((box) => ({
      x: this.xPos + box.x,
      y: this.yPos + box.y,
      width: box.width,
      height: box.height,
    }));
  }

  collides(obstacleBoxes: Box[]): boolean {
    const mine = this.collisionBoxes();
    for (const a of mine) {
      for (const b of obstacleBoxes) {
        if (boxesOverlap(a, b)) return true;
      }
    }
    return false;
  }

  draw(
    ctx: CanvasRenderingContext2D,
    sprite: HTMLImageElement,
    laneOffsetY: number,
  ) {
    const frame = this.animFrames[this.currentFrame] ?? 0;
    const ducking = this.status === "DUCKING";
    const sourceWidth = ducking ? TREX.WIDTH_DUCK : TREX.WIDTH;
    const sourceHeight = ducking ? TREX.HEIGHT_DUCK : TREX.HEIGHT;
    const sourceX = SPRITE_LDPI.TREX.x + frame;
    const sourceY = SPRITE_LDPI.TREX.y;
    const drawY =
      laneOffsetY +
      this.yPos +
      (ducking ? TREX.HEIGHT - TREX.HEIGHT_DUCK : 0);

    ctx.save();
    if (this.tint) {
      // Draw to offscreen-ish via globalComposite isn't trivial; use filter for distinction.
      ctx.filter = this.tint;
    }
    ctx.drawImage(
      sprite,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      this.xPos,
      drawY,
      sourceWidth,
      sourceHeight,
    );
    ctx.restore();

    ctx.save();
    ctx.fillStyle = "#535353";
    ctx.font = "600 10px Arial, Helvetica, sans-serif";
    ctx.fillText(this.label, this.xPos, laneOffsetY + this.yPos - 6);
    ctx.restore();
  }

  get grounded() {
    return !this.jumping && this.yPos >= this.groundYPos;
  }
}
