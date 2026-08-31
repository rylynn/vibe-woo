import { describe as d, expect, it } from "vitest";
import { applyTint, hslToHex, hexToHsl } from "../src/avatar/palette";

d("形象基色的状态色调变换", () => {
  const BASE = "#7CF5C4";

  it("normal 原样返回", () => {
    expect(applyTint(BASE, "normal")).toBe(BASE);
  });

  it("focused 提亮但保持色相（进入状态的兴奋感）", () => {
    const out = applyTint(BASE, "focused");
    const base = hexToHsl(BASE);
    const tinted = hexToHsl(out);
    expect(tinted.l).toBeGreaterThan(base.l);
    expect(Math.abs(tinted.h - base.h)).toBeLessThan(3);
  });

  it("dim 压暗且显著降饱和（睡眠时安静下来）", () => {
    const out = applyTint(BASE, "dim");
    const base = hexToHsl(BASE);
    const tinted = hexToHsl(out);
    expect(tinted.l).toBeLessThan(base.l * 0.75);
    expect(tinted.s).toBeLessThan(base.s * 0.6);
  });

  it("极暗基色 dim 后仍有亮度下限，不会黑成一团", () => {
    const dark = hslToHex({ h: 200, s: 0.5, l: 0.2 });
    const out = hexToHsl(applyTint(dark, "dim"));
    expect(out.l).toBeGreaterThanOrEqual(0.15);
  });

  it("极亮基色 focused 后不溢出", () => {
    const light = hslToHex({ h: 100, s: 0.6, l: 0.82 });
    const out = hexToHsl(applyTint(light, "focused"));
    expect(out.l).toBeLessThanOrEqual(0.9);
  });

  it("任意变换输出都是 #RRGGBB 大写格式", () => {
    for (const tint of ["normal", "focused", "dim"] as const) {
      expect(applyTint("#5CD4A8", tint)).toMatch(/^#[0-9A-F]{6}$/);
    }
  });

  it("旧常量等价性：默认青绿变换后接近旧 FOCUSED/DIM 色", () => {
    // 旧实现 FOCUSED_COLOR=#9dffd8、DIM_COLOR=#4a8f78 的亮度水平
    const focused = hexToHsl(applyTint(BASE, "focused"));
    const dim = hexToHsl(applyTint(BASE, "dim"));
    expect(focused.l).toBeGreaterThan(0.74);
    expect(dim.l).toBeLessThan(0.5);
    expect(dim.l).toBeGreaterThan(0.3);
  });
});
