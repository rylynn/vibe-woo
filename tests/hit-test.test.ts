import { describe, expect, it } from "vitest";
import { isInsideBox } from "../src/interact/hit-test";

const box = { x: 100, y: 100, w: 96, h: 96 };

describe("isInsideBox", () => {
  it("命中中心", () => {
    expect(isInsideBox(148, 148, box)).toBe(true);
  });

  it("命中左上角（含边界）", () => {
    expect(isInsideBox(100, 100, box)).toBe(true);
  });

  it("右下角边界不含（半开区间，避免相邻格重叠）", () => {
    expect(isInsideBox(196, 196, box)).toBe(false);
  });

  it("四个方向外侧均未命中", () => {
    expect(isInsideBox(99, 148, box)).toBe(false);
    expect(isInsideBox(148, 99, box)).toBe(false);
    expect(isInsideBox(197, 148, box)).toBe(false);
    expect(isInsideBox(148, 197, box)).toBe(false);
  });
});
