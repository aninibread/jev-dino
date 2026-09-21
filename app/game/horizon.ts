import { DEFAULT_WIDTH, LANE_HEIGHT, SPRITE_LDPI } from "./constants";

export class HorizonLine {
  xPos = [0, DEFAULT_WIDTH] as [number, number];
  yPos = LANE_HEIGHT - 12;
  sourceX = SPRITE_LDPI.HORIZON.x;
  sourceY = SPRITE_LDPI.HORIZON.y;
  width = 600;
  height = 12;

  reset() {
    this.xPos = [0, this.width];
  }

  update(deltaTime: number, speed: number) {
    const increment = (speed * 60 * deltaTime) / 1000;
    this.xPos[0] -= increment;
    this.xPos[1] = this.xPos[0] + this.width;
    if (this.xPos[0] <= -this.width) {
      this.xPos[0] += this.width;
      this.xPos[1] = this.xPos[0] + this.width;
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    sprite: HTMLImageElement,
    laneOffsetY: number,
  ) {
    for (const x of this.xPos) {
      ctx.drawImage(
        sprite,
        this.sourceX,
        this.sourceY,
        this.width,
        this.height,
        x,
        laneOffsetY + this.yPos,
        this.width,
        this.height,
      );
    }
  }
}

type Cloud = { x: number; y: number };

export class CloudField {
  clouds: Cloud[] = [];
  cloudSpeed = 0.2;

  reset() {
    this.clouds = [];
    for (let i = 0; i < 3; i++) {
      this.clouds.push({
        x: 100 + i * 200,
        y: 20 + Math.random() * 40,
      });
    }
  }

  update(deltaTime: number, speed: number) {
    const move = this.cloudSpeed * speed * (deltaTime / (1000 / 60));
    for (const cloud of this.clouds) {
      cloud.x -= move;
      if (cloud.x < -46) {
        cloud.x = DEFAULT_WIDTH + Math.random() * 200;
        cloud.y = 15 + Math.random() * 50;
      }
    }
  }

  draw(
    ctx: CanvasRenderingContext2D,
    sprite: HTMLImageElement,
    laneOffsetY: number,
  ) {
    for (const cloud of this.clouds) {
      ctx.drawImage(
        sprite,
        SPRITE_LDPI.CLOUD.x,
        SPRITE_LDPI.CLOUD.y,
        46,
        14,
        cloud.x,
        laneOffsetY + cloud.y,
        46,
        14,
      );
    }
  }
}
