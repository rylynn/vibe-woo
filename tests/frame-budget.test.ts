import { describe, expect, it } from "vitest";
import { frameIntervalMs, shouldRender } from "../src/anim/frame-budget";

describe("frameIntervalMs", () => {
  it("睡眠态最省电（2fps）", () => {
    expect(frameIntervalMs("sleep")).toBeCloseTo(500, 6);
  });

  it("待机态中等（8fps）", () => {
    expect(frameIntervalMs("idle")).toBeCloseTo(1000 / 8, 6);
  });

  it("活跃态最流畅（30fps）", () => {
    expect(frameIntervalMs("active")).toBeCloseTo(1000 / 30, 6);
  });

  it("越活跃间隔越短", () => {
    expect(frameIntervalMs("active")).toBeLessThan(frameIntervalMs("idle"));
    expect(frameIntervalMs("idle")).toBeLessThan(frameIntervalMs("sleep"));
  });
});

describe("shouldRender", () => {
  it("未达间隔时跳过绘制", () => {
    expect(shouldRender(100, 0, "sleep")).toBe(false);
  });

  it("刚好达到间隔时绘制", () => {
    expect(shouldRender(500, 0, "sleep")).toBe(true);
  });

  it("超过间隔时绘制", () => {
    expect(shouldRender(999, 0, "sleep")).toBe(true);
  });

  it("同一时刻重复调用不重复绘制", () => {
    expect(shouldRender(500, 500, "active")).toBe(false);
  });
});
