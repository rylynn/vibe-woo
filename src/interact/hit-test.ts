export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 半开区间判定：含左上边界、不含右下边界，避免相邻格子重叠命中。 */
export function isInsideBox(px: number, py: number, b: Box): boolean {
  return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
}
