import { describe, expect, it } from "vitest";
import { breatheScale } from "../src/anim/breathe";

describe("breatheScale", () => {
  const period = 2000;
  const amp = 0.05;

  it("在周期起点返回基准比例 1", () => {
    expect(breatheScale(0, period, amp)).toBeCloseTo(1, 6);
  });

  it("在四分之一周期达到最大", () => {
    expect(breatheScale(period / 4, period, amp)).toBeCloseTo(1 + amp, 6);
  });

  it("在四分之三周期达到最小", () => {
    expect(breatheScale((period * 3) / 4, period, amp)).toBeCloseTo(1 - amp, 6);
  });

  it("跨周期后回到起点值（可无限运行不漂移）", () => {
    expect(breatheScale(period * 7, period, amp)).toBeCloseTo(1, 6);
  });

  it("振幅为 0 时恒定不变", () => {
    expect(breatheScale(1234, period, 0)).toBe(1);
  });
});
