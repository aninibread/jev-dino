export const actions = ["run", "jump", "duck"] as const;
export type JevAction = (typeof actions)[number];

export type ObstacleKind = "cactus-small" | "cactus-large" | "bird";

export type DecideState = {
  t: number;
  speed: number;
  dino: {
    y: number;
    vy: number;
    ducking: boolean;
    grounded: boolean;
  };
  upcoming: Array<{
    type: ObstacleKind;
    dx: number;
    width: number;
    height: number;
    y: number;
  }>;
};

export type DecideResponse = {
  action: JevAction;
  probabilities: Record<JevAction, number>;
  confidence: number;
  durationMs: number;
  source: "jev" | "heuristic";
};

export const actionCriteria = {
  run: "Stay running on the ground; no jump or duck is needed yet because the next hazard is still far or already cleared.",
  jump: "Jump now to clear a cactus or other ground-level obstacle that is about to hit the dinosaur.",
  duck: "Duck now to pass under a high bird; jumping would hit it.",
} as const;
