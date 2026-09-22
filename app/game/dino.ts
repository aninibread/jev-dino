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

/**
 * Chromium T-rex duck behavior (offline.js):
 * - Grounded: switch to DUCKING sprite/hitbox immediately.
 * - Mid-air: setSpeedDrop() — jumpVelocity = 1, fall 3× fast, then duck on land.
 */
export type JumpProfile = "short" | "full";

export class Dino {
  xPos = TREX.START_X;
  yPos = 0;
  groundYPos = 0;
  jumpVelocity = 0;
  jumping = false;
  ducking = false;
  speedDrop = false;
  reachedMinHeight = false;
  /** short = cut ascent at min height (jev-t-rex-runner); full = full arc. */
  jumpProfile: JumpProfile = "full";
  status: DinoStatus = "WAITING";
  crashed = false;
  currentFrame = 0;
  timer = 0;
  msPerFrame = TREX_FRAMES.WAITING.msPerFrame;
  animFrames: readonly number[] = TREX_FRAMES.WAITING.frames;
  minJumpHeight = 0;
  label: string;
  /** Fill used to recolor the sprite (null = original grey). */
  tint: string | null;
  private tintCanvas: HTMLCanvasElement | null = null;
  private tintCtx: CanvasRenderingContext2D | null = null;

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
    this.jumpProfile = "full";
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

  jump(profile: JumpProfile = "full") {
    if (this.crashed || this.jumping) return false;
    this.setStatus("JUMPING");
    this.jumpVelocity = TREX.INITIAL_JUMP_VELOCITY; // -10, airtime ~0.58s
    this.jumping = true;
    this.reachedMinHeight = false;
    this.jumpProfile = profile === "short" ? "short" : "full";
    this.speedDrop = false;
    if (this.ducking) {
      this.ducking = false;
    }
    return true;
  }

  endJump() {
    if (
      this.reachedMinHeight &&
      this.jumpVelocity < TREX.DROP_VELOCITY
    ) {
      this.jumpVelocity = TREX.DROP_VELOCITY;
    }
  }

  /** Immediately cancel jump and slam down — no hover / slow-fall before crouch. */
  setSpeedDrop() {
    this.speedDrop = true;
    // Chromium uses 1; that feels like a pause mid-air. Push harder so the
    // body drops in a few frames, then crouch on land.
    this.jumpVelocity = 8;
    this.reachedMinHeight = true;
  }

  setDuck(isDucking: boolean) {
    if (this.crashed) return;

    // Mid-air duck = fast fall, not crouch pose (still airborne).
    if (this.jumping) {
      if (isDucking) this.setSpeedDrop();
      else this.speedDrop = false;
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

    if (this.jumping) {
      this.updateJump(deltaTime);
    }

    // After a speed-drop landing, crouch if duck is still held (race re-applies).
    if (this.speedDrop && this.yPos === this.groundYPos) {
      this.speedDrop = false;
      this.setDuck(true);
    }
  }

  /** Chromium Trex.updateJump — gravity always; speedDrop multiplies fall. */
  private updateJump(deltaTime: number) {
    const framesElapsed = deltaTime / (1000 / 60);

    if (this.speedDrop) {
      // Fall only — never re-apply endJump/-5 which can fight the slam.
      this.yPos += Math.round(
        this.jumpVelocity * SPEED_DROP_COEFFICIENT * framesElapsed,
      );
      this.jumpVelocity += GRAVITY * 1.5 * framesElapsed;
      this.reachedMinHeight = true;
    } else {
      this.yPos += Math.round(this.jumpVelocity * framesElapsed);
      this.jumpVelocity += GRAVITY * framesElapsed;
      if (this.yPos < this.minJumpHeight) {
        this.reachedMinHeight = true;
      }
      // Short profile: cut ascent once min height is cleared (ref: jev-t-rex-runner).
      if (this.jumpProfile === "short" && this.reachedMinHeight) {
        this.endJump();
      }
    }

    if (this.yPos > this.groundYPos) {
      this.yPos = this.groundYPos;
      this.jumping = false;
      this.jumpVelocity = 0;
      this.jumpProfile = "full";
      if (!this.crashed) {
        if (this.ducking) this.setStatus("DUCKING");
        else this.setStatus("RUNNING");
      }
      // Leave speedDrop set so the grounded check can crouch this frame.
    }
  }

  crash() {
    this.crashed = true;
    this.jumping = false;
    this.ducking = false;
    this.speedDrop = false;
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
    const mine = this.collisionBoxes().map((box) => ({
      x: box.x + 2,
      y: box.y + 2,
      width: Math.max(2, box.width - 4),
      height: Math.max(2, box.height - 4),
    }));
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
    // Chromium: duck uses WIDTH_DUCK × HEIGHT (full cell; crouch is at the bottom).
    const sourceWidth = ducking ? TREX.WIDTH_DUCK : TREX.WIDTH;
    const sourceHeight = TREX.HEIGHT;
    const sourceX = SPRITE_LDPI.TREX.x + frame;
    const sourceY = SPRITE_LDPI.TREX.y;
    const drawY = laneOffsetY + this.yPos;

    if (this.tint) {
      this.drawTinted(
        ctx,
        sprite,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        this.xPos,
        drawY,
      );
    } else {
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
    }

    ctx.save();
    ctx.fillStyle = this.tint ?? "#535353";
    ctx.font = "600 10px Arial, Helvetica, sans-serif";
    ctx.fillText(this.label, this.xPos, laneOffsetY + this.yPos - 6);
    ctx.restore();
  }

  /** Fill the dino body with tint; keep the same sprite silhouette. */
  private drawTinted(
    ctx: CanvasRenderingContext2D,
    sprite: HTMLImageElement,
    sourceX: number,
    sourceY: number,
    sourceWidth: number,
    sourceHeight: number,
    destX: number,
    destY: number,
  ) {
    if (!this.tintCanvas || !this.tintCtx) {
      this.tintCanvas = document.createElement("canvas");
      this.tintCtx = this.tintCanvas.getContext("2d");
    }
    const tctx = this.tintCtx;
    if (!tctx || !this.tint) {
      ctx.drawImage(
        sprite,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        destX,
        destY,
        sourceWidth,
        sourceHeight,
      );
      return;
    }

    this.tintCanvas.width = sourceWidth;
    this.tintCanvas.height = sourceHeight;
    tctx.clearRect(0, 0, sourceWidth, sourceHeight);
    tctx.globalCompositeOperation = "source-over";
    tctx.drawImage(
      sprite,
      sourceX,
      sourceY,
      sourceWidth,
      sourceHeight,
      0,
      0,
      sourceWidth,
      sourceHeight,
    );
    // Paint the opaque pixels green (body fill, not an outline).
    tctx.globalCompositeOperation = "source-in";
    tctx.fillStyle = this.tint;
    tctx.fillRect(0, 0, sourceWidth, sourceHeight);
    tctx.globalCompositeOperation = "source-over";
    ctx.drawImage(this.tintCanvas, destX, destY);
  }

  get grounded() {
    return !this.jumping && this.yPos >= this.groundYPos;
  }
}
