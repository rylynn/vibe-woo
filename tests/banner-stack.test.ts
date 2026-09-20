import { describe, expect, it } from "vitest";
import { bannerStackPos } from "../src/overlay/bubble";

const size = { w: 200, h: 40 };
const screen = { w: 1440, h: 900 };
const pet = { x: 100, y: 800, w: 64, h: 64 };

describe("通知条锚链定位", () => {
  it("宠物不在家 → null（走右上角）", () => {
    expect(bannerStackPos(null, null, size, screen)).toBeNull();
  });

  it("无主气泡：贴宠物头顶（间隙 TAIL_GAP=10）", () => {
    expect(bannerStackPos(pet, null, size, screen)).toEqual({ x: 32, y: 750 });
  });

  it("主气泡在头顶：让到主气泡上方（再留 10 间隙）", () => {
    const bub = { x: 40, y: 640, w: 180, h: 50 };
    expect(bannerStackPos(pet, bub, size, screen)?.y).toBe(640 - 10 - 40);
  });

  it("宠物贴屏幕顶：整体翻到脚下", () => {
    const topPet = { x: 100, y: 8, w: 64, h: 64 };
    expect(bannerStackPos(topPet, null, size, screen)?.y).toBe(8 + 64 + 10);
  });

  it("宠物贴顶且主气泡在脚下：叠到主气泡下面", () => {
    const topPet = { x: 100, y: 8, w: 64, h: 64 };
    const bubBelow = { x: 40, y: 82, w: 180, h: 50 };
    expect(bannerStackPos(topPet, bubBelow, size, screen)?.y).toBe(82 + 50 + 10);
  });

  it("水平方向贴边钳制（不飘出屏幕）", () => {
    const edgePet = { x: 0, y: 800, w: 64, h: 64 };
    expect(bannerStackPos(edgePet, null, size, screen)?.x).toBe(4);
    const rightPet = { x: 1376, y: 800, w: 64, h: 64 };
    expect(bannerStackPos(rightPet, null, size, screen)?.x).toBe(1440 - 200 - 4);
  });

  it("主气泡在头顶但头顶叠不下：翻到脚下", () => {
    const highPet = { x: 100, y: 120, w: 64, h: 64 };
    const bubHigh = { x: 40, y: 4, w: 180, h: 50 };
    // 头顶放 banner：120-40-10=70 放得下，但叠到气泡上方 4-10-40<4 放不下
    expect(bannerStackPos(highPet, bubHigh, size, screen)?.y).toBe(120 + 64 + 10);
  });
});
