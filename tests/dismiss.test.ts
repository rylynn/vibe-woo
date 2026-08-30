import { describe, expect, it } from "vitest";
import { DismissManager, type Dismissable } from "../src/overlay/dismiss";
import type { Box } from "../src/interact/hit-test";

function panel(box: Box): Dismissable & { hidden: number } {
  return {
    isOpen: true,
    hidden: 0,
    box,
    hide() {
      this.hidden++;
      this.isOpen = false;
    },
  };
}

const PANEL_BOX = { x: 300, y: 300, w: 200, h: 150 };
const PET_BOX = { x: 100, y: 100, w: 96, h: 96 };

describe("点外关闭", () => {
  it("点面板之外就关闭", () => {
    const m = new DismissManager();
    const p = panel(PANEL_BOX);
    m.register(p);
    m.handlePointerDown(600, 600);
    expect(p.hidden).toBe(1);
    expect(p.isOpen).toBe(false);
  });

  it("点面板内部不关闭", () => {
    const m = new DismissManager();
    const p = panel(PANEL_BOX);
    m.register(p);
    m.handlePointerDown(350, 350);
    expect(p.hidden).toBe(0);
    expect(p.isOpen).toBe(true);
  });

  it("点宠物身上不关闭（那是正常交互）", () => {
    const m = new DismissManager();
    const p = panel(PANEL_BOX);
    m.register(p);
    m.setPetBox(() => PET_BOX);
    m.handlePointerDown(140, 140);
    expect(p.hidden).toBe(0);
  });

  it("没有任何面板打开时不做任何事", () => {
    const m = new DismissManager();
    const p = panel(PANEL_BOX);
    p.isOpen = false;
    m.register(p);
    m.handlePointerDown(600, 600);
    expect(p.hidden).toBe(0);
  });

  it("多个面板同时打开时，点外部会全部关闭", () => {
    const m = new DismissManager();
    const a = panel({ x: 100, y: 100, w: 100, h: 100 });
    const b = panel({ x: 800, y: 600, w: 300, h: 200 });
    m.register(a);
    m.register(b);
    m.handlePointerDown(30, 30);
    expect(a.hidden).toBe(1);
    expect(b.hidden).toBe(1);
  });

  it("点在其中一个面板内时，其他面板关闭、这个保留", () => {
    const m = new DismissManager();
    const a = panel({ x: 100, y: 100, w: 100, h: 100 });
    const b = panel({ x: 800, y: 600, w: 300, h: 200 });
    m.register(a);
    m.register(b);
    m.handlePointerDown(150, 150);
    expect(a.hidden).toBe(0);
    expect(b.hidden).toBe(1);
  });

  it("面板已隐藏后不再重复触发", () => {
    const m = new DismissManager();
    const p = panel(PANEL_BOX);
    m.register(p);
    m.handlePointerDown(600, 600);
    expect(p.hidden).toBe(1);
    // 再点一次，不应重复计数
    m.handlePointerDown(600, 600);
    expect(p.hidden).toBe(1);
  });
});
