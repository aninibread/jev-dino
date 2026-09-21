import {
  DEFAULT_WIDTH,
  FPS,
  OBSTACLE_TYPES,
  SPRITE_LDPI,
  type Box,
  type ObstacleTypeConfig,
} from "./constants";
import { gapShrink, maxObstacleSize } from "./speedCurve";

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

export class Obstacle {
  typeConfig: ObstacleTypeConfig;
  size: number;
  xPos: number;
  yPos: number;
  width: number;
  gap: number;
  remove = false;
  collisionBoxes: Box[] = [];
  currentFrame = 0;
  timer = 0;
  speedOffset = 0;

  constructor(
    typeConfig: ObstacleTypeConfig,
    speed: number,
    gapCoefficient: number,
    elapsedMs: number,
    xOffset = 0,
  ) {
    this.typeConfig = typeConfig;
    this.size = rand(1, maxObstacleSize(elapsedMs, speed));
    if (this.size > 1 && typeConfig.multipleSpeed > speed) this.size = 1;
    this.width = typeConfig.width * this.size;
    this.xPos = DEFAULT_WIDTH + xOffset;

    if (Array.isArray(typeConfig.yPos)) {
      this.yPos = typeConfig.yPos[rand(0, typeConfig.yPos.length - 1)]!;
    } else {
      this.yPos = typeConfig.yPos;
    }

    this.collisionBoxes = typeConfig.collisionBoxes.map((b) => ({ ...b }));
    if (this.size > 1) {
      this.collisionBoxes[1]!.width =
        this.width -
        this.collisionBoxes[0]!.width -
        this.collisionBoxes[2]!.width;
      this.collisionBoxes[2]!.x = this.width - this.collisionBoxes[2]!.width;
    }

    if (typeConfig.speedOffset) {
      this.speedOffset =
        Math.random() > 0.5 ? typeConfig.speedOffset : -typeConfig.speedOffset;
    }

    const shrink = gapShrink(elapsedMs);
    const minGap = Math.round(
      this.width * speed + typeConfig.minGap * gapCoefficient * shrink,
    );
    const maxGap = Math.round(minGap * 1.5);
    this.gap = rand(minGap, maxGap);
  }

  update(deltaTime: number, speed: number) {
    this.step(deltaTime, speed);
  }

  step(deltaTime: number, speed: number) {
    let s = speed;
    if (this.speedOffset) s += this.speedOffset;
    this.xPos -= (s * FPS * deltaTime) / 1000;

    if (this.typeConfig.numFrames && this.typeConfig.frameRate) {
      this.timer += deltaTime;
      if (this.timer >= this.typeConfig.frameRate) {
        this.currentFrame =
          this.currentFrame === this.typeConfig.numFrames - 1
            ? 0
            : this.currentFrame + 1;
        this.timer = 0;
      }
    }

    if (this.xPos + this.width < 0) this.remove = true;
  }

  boxes(): Box[] {
    return this.collisionBoxes.map((box) => ({
      x: this.xPos + box.x,
      y: this.yPos + box.y,
      width: box.width,
      height: box.height,
    }));
  }

  draw(
    ctx: CanvasRenderingContext2D,
    sprite: HTMLImageElement,
    laneOffsetY: number,
  ) {
    const sourceWidth = this.typeConfig.width;
    const sourceHeight = this.typeConfig.height;
    const spritePos =
      this.typeConfig.type === "CACTUS_SMALL"
        ? SPRITE_LDPI.CACTUS_SMALL
        : this.typeConfig.type === "CACTUS_LARGE"
          ? SPRITE_LDPI.CACTUS_LARGE
          : SPRITE_LDPI.PTERODACTYL;

    let sourceX =
      sourceWidth * this.size * (0.5 * (this.size - 1)) + spritePos.x;
    if (this.currentFrame > 0) sourceX += sourceWidth * this.currentFrame;

    ctx.drawImage(
      sprite,
      sourceX,
      spritePos.y,
      sourceWidth * this.size,
      sourceHeight,
      this.xPos,
      laneOffsetY + this.yPos,
      this.typeConfig.width * this.size,
      this.typeConfig.height,
    );
  }
}

export class ObstacleManager {
  obstacles: Obstacle[] = [];
  gapCoefficient = 0.6;
  followingObstacleCreated = false;

  reset() {
    this.obstacles = [];
    this.followingObstacleCreated = false;
  }

  update(deltaTime: number, speed: number, elapsedMs: number) {
    for (const obstacle of this.obstacles) {
      obstacle.step(deltaTime, speed);
    }
    this.obstacles = this.obstacles.filter((o) => !o.remove);

    if (this.obstacles.length > 0) {
      const last = this.obstacles[this.obstacles.length - 1]!;
      if (
        last.xPos + last.width + last.gap < DEFAULT_WIDTH &&
        !this.followingObstacleCreated
      ) {
        this.addNewObstacle(speed, elapsedMs);
        this.followingObstacleCreated = true;
      } else if (last.xPos + last.width + last.gap >= DEFAULT_WIDTH) {
        this.followingObstacleCreated = false;
      }
    } else {
      this.addNewObstacle(speed, elapsedMs);
    }
  }

  addNewObstacle(speed: number, elapsedMs: number) {
    const candidates = OBSTACLE_TYPES.filter((t) => speed >= t.minSpeed);
    const type = candidates[rand(0, candidates.length - 1)]!;
    // Avoid too many duplicate birds early
    this.obstacles.push(
      new Obstacle(type, speed, this.gapCoefficient, elapsedMs),
    );
  }

  draw(
    ctx: CanvasRenderingContext2D,
    sprite: HTMLImageElement,
    laneOffsetY: number,
  ) {
    for (const obstacle of this.obstacles) {
      obstacle.draw(ctx, sprite, laneOffsetY);
    }
  }

  /** Snapshot for Jev — relative to a dino at TREX.START_X. */
  upcomingFor(dinoX: number, limit = 3) {
    return this.obstacles
      .filter((o) => o.xPos + o.width > dinoX)
      .slice(0, limit)
      .map((o) => ({
        type: o.typeConfig.kind,
        dx: o.xPos - dinoX,
        width: o.width,
        height: o.typeConfig.height,
        y: o.yPos,
      }));
  }
}
