import { isInsideBox, type Box } from "./hit-test";

export interface DragState {
  dragging: boolean;
  offsetX: number;
  offsetY: number;
}

export interface Pointer {
  px: number;
  py: number;
}

export function createDragState(): DragState {
  return { dragging: false, offsetX: 0, offsetY: 0 };
}

/**
 * 按下时记录鼠标相对宠物原点的偏移。
 * 这个偏移是拖动手感的关键：没有它，宠物会在按下瞬间「跳」到鼠标位置。
 */
export function onPointerDown(
  _s: DragState,
  p: Pointer,
  body: Box,
): DragState {
  if (!isInsideBox(p.px, p.py, body)) return createDragState();
  return { dragging: true, offsetX: p.px - body.x, offsetY: p.py - body.y };
}

/** 返回宠物的新原点坐标；未处于拖动中时返回 null。 */
export function onPointerMove(
  s: DragState,
  p: Pointer,
): { x: number; y: number } | null {
  if (!s.dragging) return null;
  return { x: p.px - s.offsetX, y: p.py - s.offsetY };
}

export function onPointerUp(_s: DragState): DragState {
  return createDragState();
}
