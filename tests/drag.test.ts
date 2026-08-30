import { describe, expect, it } from "vitest";
import {
  createDragState,
  onPointerDown,
  onPointerMove,
  onPointerUp,
} from "../src/interact/drag";

describe("拖动状态机", () => {
  it("初始不处于拖动中", () => {
    expect(createDragState().dragging).toBe(false);
  });

  it("按下宠物身体进入拖动，并记录偏移", () => {
    const s = createDragState();
    const next = onPointerDown(
      s,
      { px: 130, py: 140 },
      { x: 100, y: 100, w: 96, h: 96 },
    );
    expect(next.dragging).toBe(true);
    expect(next.offsetX).toBe(30);
    expect(next.offsetY).toBe(40);
  });

  it("按在宠物之外不进入拖动", () => {
    const s = createDragState();
    const next = onPointerDown(
      s,
      { px: 10, py: 10 },
      { x: 100, y: 100, w: 96, h: 96 },
    );
    expect(next.dragging).toBe(false);
  });

  it("拖动时保持按下瞬间的相对偏移，宠物不跳到鼠标中心", () => {
    let s = createDragState();
    s = onPointerDown(s, { px: 130, py: 140 }, { x: 100, y: 100, w: 96, h: 96 });
    const pos = onPointerMove(s, { px: 500, py: 400 });
    expect(pos).toEqual({ x: 470, y: 360 });
  });

  it("未拖动时移动不产生新位置", () => {
    expect(onPointerMove(createDragState(), { px: 500, py: 400 })).toBeNull();
  });

  it("松手结束拖动", () => {
    let s = createDragState();
    s = onPointerDown(s, { px: 130, py: 140 }, { x: 100, y: 100, w: 96, h: 96 });
    expect(onPointerUp(s).dragging).toBe(false);
  });
});
