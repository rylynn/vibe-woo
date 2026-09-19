import { describe, expect, it } from "vitest";
import { formatAwayText } from "../src/overlay/away-text";

describe("formatAwayText", () => {
  it("串门显示剩余分钟", () => {
    expect(formatAwayText("visit", "汤圆", 480)).toBe("🐾 在 汤圆 家 · 还剩 8 分钟");
    expect(formatAwayText("visit", "汤圆", 361)).toBe("🐾 在 汤圆 家 · 还剩 7 分钟");
  });

  it("串门不足一分钟显示马上回来", () => {
    expect(formatAwayText("visit", "汤圆", 59)).toBe("🐾 在 汤圆 家 · 马上回来");
    expect(formatAwayText("visit", "汤圆", 0)).toBe("🐾 在 汤圆 家 · 马上回来");
  });

  it("碰一碰固定文案", () => {
    expect(formatAwayText("bump", "汤圆", 45)).toBe("🐾 碰了碰 汤圆，马上回来");
    expect(formatAwayText("bump", "汤圆", 1)).toBe("🐾 碰了碰 汤圆，马上回来");
  });

  it("旧版事件无 kind 时兜底", () => {
    expect(formatAwayText(undefined, "汤圆", 480)).toBe("🐾 不在家");
    expect(formatAwayText(undefined, undefined, 0)).toBe("🐾 不在家");
  });

  it("visit 缺昵称兜底", () => {
    expect(formatAwayText("visit", undefined, 480)).toBe("🐾 不在家");
  });
});
