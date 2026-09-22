export const FPS = 60;
export const DEFAULT_WIDTH = 600;
export const LANE_HEIGHT = 150;
export const LANE_GAP = 18;
export const BOTTOM_PAD = 10;

export const GAME_DURATION_MS = 60_000;
/**
 * After the player crashes, keep Jev running this long (wall-clock).
 * Spectate uses a boosted speed ramp + difficulty clock so the level
 * packs a late-race stretch into a short watch window.
 */
export const SPECTATE_MS = 12_000;
/** Floor speed once you're watching — skip the slow early crawl. */
export const SPECTATE_MIN_SPEED = 10;
/** How much faster speed accelerates during spectate (vs normal race). */
export const SPECTATE_ACCEL_MULT = 14;
/** How much faster the difficulty/elapsed clock runs while spectating. */
export const SPECTATE_ELAPSED_MULT = 3;

/** Base Chromium speed; acceleration lives in speedCurve.ts. */
export const BASE_SPEED = 6;
export const GRAVITY = 0.6;
export const INITIAL_JUMP_VELOCITY = 12;
export const SPEED_DROP_COEFFICIENT = 3;

export const CLEAR_TIME_MS = 4000;

export const SPRITE_LDPI = {
  CACTUS_LARGE: { x: 332, y: 2 },
  CACTUS_SMALL: { x: 228, y: 2 },
  CLOUD: { x: 86, y: 2 },
  HORIZON: { x: 2, y: 54 },
  PTERODACTYL: { x: 134, y: 2 },
  RESTART: { x: 2, y: 2 },
  TEXT_SPRITE: { x: 655, y: 2 },
  TREX: { x: 848, y: 2 },
} as const;

export const TREX = {
  DROP_VELOCITY: -5,
  HEIGHT: 47,
  HEIGHT_DUCK: 25,
  INITIAL_JUMP_VELOCITY: -10,
  WIDTH: 44,
  WIDTH_DUCK: 59,
  START_X: 50,
} as const;

export const TREX_FRAMES = {
  WAITING: { frames: [44, 0], msPerFrame: 1000 / 3 },
  RUNNING: { frames: [88, 132], msPerFrame: 1000 / 12 },
  CRASHED: { frames: [220], msPerFrame: 1000 / 60 },
  JUMPING: { frames: [0], msPerFrame: 1000 / 60 },
  DUCKING: { frames: [264, 323], msPerFrame: 1000 / 12 },
} as const;

export type Box = { x: number; y: number; width: number; height: number };

export const TREX_BOXES = {
  DUCKING: [{ x: 1, y: 18, width: 55, height: 25 }] as Box[],
  RUNNING: [
    { x: 22, y: 0, width: 17, height: 16 },
    { x: 1, y: 18, width: 30, height: 9 },
    { x: 10, y: 35, width: 14, height: 8 },
    { x: 1, y: 24, width: 29, height: 5 },
    { x: 5, y: 30, width: 21, height: 4 },
    { x: 9, y: 34, width: 15, height: 4 },
  ] as Box[],
};

export type ObstacleTypeConfig = {
  type: "CACTUS_SMALL" | "CACTUS_LARGE" | "PTERODACTYL";
  kind: "cactus-small" | "cactus-large" | "bird";
  width: number;
  height: number;
  yPos: number | number[];
  multipleSpeed: number;
  minGap: number;
  minSpeed: number;
  collisionBoxes: Box[];
  numFrames?: number;
  frameRate?: number;
  speedOffset?: number;
};

export const OBSTACLE_TYPES: ObstacleTypeConfig[] = [
  {
    type: "CACTUS_SMALL",
    kind: "cactus-small",
    width: 17,
    height: 35,
    // Chromium uses 105; +3 plants the art on the ground line (sprite bottom pad).
    yPos: 108,
    multipleSpeed: 4,
    minGap: 120,
    minSpeed: 0,
    collisionBoxes: [
      { x: 0, y: 7, width: 5, height: 27 },
      { x: 4, y: 0, width: 6, height: 34 },
      { x: 10, y: 4, width: 7, height: 14 },
    ],
  },
  {
    type: "CACTUS_LARGE",
    kind: "cactus-large",
    width: 25,
    height: 50,
    // Chromium uses 90; +3 matches small-cactus plant offset.
    yPos: 93,
    multipleSpeed: 7,
    minGap: 120,
    minSpeed: 0,
    collisionBoxes: [
      { x: 0, y: 12, width: 7, height: 38 },
      { x: 8, y: 0, width: 7, height: 49 },
      { x: 13, y: 10, width: 10, height: 38 },
    ],
  },
  {
    type: "PTERODACTYL",
    kind: "bird",
    width: 46,
    height: 40,
    yPos: [100, 75, 50],
    multipleSpeed: 999,
    minSpeed: 8.5,
    minGap: 150,
    collisionBoxes: [
      { x: 15, y: 15, width: 16, height: 5 },
      { x: 18, y: 21, width: 24, height: 6 },
      { x: 2, y: 14, width: 4, height: 3 },
      { x: 6, y: 10, width: 4, height: 7 },
      { x: 10, y: 8, width: 6, height: 9 },
    ],
    numFrames: 2,
    frameRate: 1000 / 6,
    speedOffset: 0.8,
  },
];
