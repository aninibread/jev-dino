import {
  DEFAULT_WIDTH,
  FPS,
  OBSTACLE_TYPES,
  SPRITE_LDPI,
  type Box,
  type ObstacleTypeConfig,
} from "./constants";
import {
  birdHeightIndex,
  chromiumGapPixels,
  gapCoefficientFor,
  maxObstacleSize,
  obstacleWeights,
} from "./speedCurve";

function rand(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

let nextObstacleId = 1;

export class Obstacle {
  /** Stable id for the lifetime of this obstacle (for Jev memory). */
  id: string;
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
    this.id = `obs-${nextObstacleId++}`;
    this.typeConfig = typeConfig;
    this.size = rand(1, maxObstacleSize(speed));
    if (this.size > 1 && typeConfig.multipleSpeed > speed) this.size = 1;
    this.width = typeConfig.width * this.size;
    this.xPos = DEFAULT_WIDTH + xOffset;

    if (Array.isArray(typeConfig.yPos)) {
      const idx = birdHeightIndex(elapsedMs, typeConfig.yPos.length);
      this.yPos = typeConfig.yPos[idx]!;
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

    const { minGap, maxGap } = chromiumGapPixels(
      this.width,
      speed,
      gapCoefficient,
      typeConfig.minGap,
    );
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

/** Chromium MAX_OBSTACLE_DUPLICATION — avoid three identical types in a row. */
const MAX_OBSTACLE_DUPLICATION = 2;

export class ObstacleManager {
  obstacles: Obstacle[] = [];
  followingObstacleCreated = false;
  private history: string[] = [];

  reset() {
    this.obstacles = [];
    this.followingObstacleCreated = false;
    this.history = [];
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

  private duplicateCheck(type: string): boolean {
    let dup = 0;
    for (const prev of this.history) {
      dup = prev === type ? dup + 1 : 0;
    }
    return dup >= MAX_OBSTACLE_DUPLICATION;
  }

  private pickType(speed: number, elapsedMs: number): ObstacleTypeConfig {
    const weights = obstacleWeights(elapsedMs, speed);
    const small = OBSTACLE_TYPES.find((t) => t.type === "CACTUS_SMALL")!;
    const large = OBSTACLE_TYPES.find((t) => t.type === "CACTUS_LARGE")!;
    const bird = OBSTACLE_TYPES.find((t) => t.type === "PTERODACTYL")!;

    const options: { type: ObstacleTypeConfig; w: number }[] = [
      { type: small, w: weights.small },
      { type: large, w: weights.large },
    ];
    if (speed >= bird.minSpeed && weights.bird > 0) {
      options.push({ type: bird, w: weights.bird });
    }

    // Retry a few times to avoid duplicate streaks (Chromium does the same).
    for (let attempt = 0; attempt < 6; attempt++) {
      const total = options.reduce((s, o) => s + o.w, 0);
      let roll = Math.random() * total;
      let picked = options[0]!.type;
      for (const opt of options) {
        roll -= opt.w;
        if (roll <= 0) {
          picked = opt.type;
          break;
        }
      }
      if (!this.duplicateCheck(picked.type)) return picked;
    }
    return small;
  }

  addNewObstacle(speed: number, elapsedMs: number) {
    const type = this.pickType(speed, elapsedMs);
    const coeff = gapCoefficientFor(elapsedMs);
    // Extra runway for the very first obstacle of a race.
    const xOffset = this.obstacles.length === 0 ? 280 : 0;
    this.obstacles.push(new Obstacle(type, speed, coeff, elapsedMs, xOffset));
    this.history.unshift(type.type);
    if (this.history.length > MAX_OBSTACLE_DUPLICATION) {
      this.history.length = MAX_OBSTACLE_DUPLICATION;
    }
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
  upcomingFor(dinoX: number, limit = 6) {
    return this.obstacles
      .filter((o) => o.xPos + o.width > dinoX)
      .slice(0, limit)
      .map((o) => ({
        id: o.id,
        type: o.typeConfig.kind,
        dx: o.xPos - dinoX,
        width: o.width,
        height: o.typeConfig.height,
        y: o.yPos,
      }));
  }
}
