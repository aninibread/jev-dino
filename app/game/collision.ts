import type { Box } from "./constants";

export function boxesOverlap(a: Box, b: Box): boolean {
  return !(
    a.x + a.width < b.x ||
    a.x > b.x + b.width ||
    a.y + a.height < b.y ||
    a.y > b.y + b.height
  );
}

export function createCollisionBox(
  box: Box,
  adjustment: Box | null,
): Box {
  return adjustment
    ? {
        x: box.x - adjustment.x,
        y: box.y - adjustment.y,
        width: box.width,
        height: box.height,
      }
    : { ...box };
}
