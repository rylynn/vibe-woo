import { describe as d, expect, it } from "vitest";
import { eyeGeoms, type EyeLayout } from "../src/render/eyes";
import { drawBrows } from "../src/render/brows";
import type { EyeFrame } from "../src/anim/expression";

interface Fill {
  x: number;
  y: number;
  w: number;
  h: number;
  style: string;
}

function makeStubCtx() {
  const fills: Fill[] = [];
  const state = { fillStyle: "" };
  const ctx = {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      fills.push({ x, y, w, h, style: state.fillStyle });
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, fills };
}

const LAYOUT: EyeLayout = { bodyX: 0, bodyY: 0, w: 96, h: 96 };
const ROUND_FRAME: EyeFrame = { shape: "round", lid: 0, gazeX: 0, gazeY: 0 };

d("眼睛风格布局", () => {
  it("classic 保持现状比例（回归保护）", () => {
    const { left } = eyeGeoms(LAYOUT, "classic");
    expect(left.w).toBe(Math.round(96 * 0.22));
    expect(left.h).toBe(Math.round(96 * 0.28));
    expect(left.centerY).toBe(Math.round(96 * 0.44));
  });

  it("big 比 classic 明显更大", () => {
    const c = eyeGeoms(LAYOUT, "classic").left;
    const b = eyeGeoms(LAYOUT, "big").left;
    expect(b.w * b.h).toBeGreaterThan(c.w * c.h * 1.3);
  });

  it("dot 是小豆眼：宽高都明显小于 classic", () => {
    const c = eyeGeoms(LAYOUT, "classic").left;
    const d2 = eyeGeoms(LAYOUT, "dot").left;
    expect(d2.w).toBeLessThan(c.w * 0.7);
    expect(d2.h).toBeLessThan(c.h * 0.7);
  });

  it("almond 扁长：更宽更矮", () => {
    const c = eyeGeoms(LAYOUT, "classic").left;
    const a = eyeGeoms(LAYOUT, "almond").left;
    expect(a.w).toBeGreaterThan(c.w);
    expect(a.h).toBeLessThan(c.h);
  });

  it("sleepy 眼睛位置比 classic 略低", () => {
    const c = eyeGeoms(LAYOUT, "classic").left;
    const s = eyeGeoms(LAYOUT, "sleepy").left;
    expect(s.centerY).toBeGreaterThan(c.centerY);
  });

  it("任意风格下左右眼相对身体中线镜像对称", () => {
    for (const style of ["classic", "big", "dot", "almond", "sleepy"] as const) {
      const { left, right } = eyeGeoms(LAYOUT, style);
      const leftCenter = left.x + left.w / 2;
      const rightCenter = right.x + right.w / 2;
      expect(leftCenter + rightCenter).toBeCloseTo(LAYOUT.w, 5);
    }
  });
});

d("眉毛渲染", () => {
  it("none 不画任何矩形", () => {
    const { ctx, fills } = makeStubCtx();
    drawBrows(ctx, LAYOUT, "none", ROUND_FRAME, "#FFFFFF", "classic");
    expect(fills).toHaveLength(0);
  });

  it("flat 左右各一条，位于眼睛上方且使用点缀色", () => {
    const { ctx, fills } = makeStubCtx();
    drawBrows(ctx, LAYOUT, "flat", ROUND_FRAME, "#FFE066", "classic");
    expect(fills).toHaveLength(2);
    const { left } = eyeGeoms(LAYOUT, "classic");
    const eyeTop = left.centerY - left.h / 2;
    for (const f of fills) {
      expect(f.y + f.h).toBeLessThanOrEqual(Math.round(eyeTop));
      expect(f.style).toBe("#FFE066");
    }
  });

  it("左右眉相对身体中线水平镜像", () => {
    const { ctx, fills } = makeStubCtx();
    drawBrows(ctx, LAYOUT, "flat", ROUND_FRAME, "#FFF", "classic");
    const [l, r] = fills;
    expect(l.x + l.w + r.x).toBe(LAYOUT.w);
  });

  it("bushy 比 flat 更厚", () => {
    const flat = makeStubCtx();
    drawBrows(flat.ctx, LAYOUT, "flat", ROUND_FRAME, "#FFF", "classic");
    const bushy = makeStubCtx();
    drawBrows(bushy.ctx, LAYOUT, "bushy", ROUND_FRAME, "#FFF", "classic");
    expect(bushy.fills[0].h).toBeGreaterThan(flat.fills[0].h);
  });

  it("arched 每侧三段拼出拱形", () => {
    const { ctx, fills } = makeStubCtx();
    drawBrows(ctx, LAYOUT, "arched", ROUND_FRAME, "#FFF", "classic");
    expect(fills).toHaveLength(6);
  });

  it("slanted 左眉外段高于内段，右眉相反（严肃眉的八字感）", () => {
    const { ctx, fills } = makeStubCtx();
    drawBrows(ctx, LAYOUT, "slanted", ROUND_FRAME, "#FFF", "classic");
    expect(fills).toHaveLength(4);
    const leftSegs = fills.filter((f) => f.x < LAYOUT.w / 2);
    const rightSegs = fills.filter((f) => f.x >= LAYOUT.w / 2);
    const leftOuter = leftSegs.reduce((a, b) => (a.x < b.x ? a : b));
    const leftInner = leftSegs.reduce((a, b) => (a.x > b.x ? a : b));
    const rightInner = rightSegs.reduce((a, b) => (a.x < b.x ? a : b));
    const rightOuter = rightSegs.reduce((a, b) => (a.x > b.x ? a : b));
    expect(leftOuter.y).toBeLessThan(leftInner.y);
    expect(rightInner.y).toBeGreaterThan(rightOuter.y);
  });

  it("烦躁表情时眉毛下压（与微表情引擎的 worried 联动）", () => {
    const calm = makeStubCtx();
    drawBrows(calm.ctx, LAYOUT, "flat", ROUND_FRAME, "#FFF", "classic");
    const worried = makeStubCtx();
    drawBrows(
      worried.ctx,
      LAYOUT,
      "flat",
      { ...ROUND_FRAME, shape: "worried" },
      "#FFF",
      "classic",
    );
    expect(worried.fills[0].y).toBeGreaterThan(calm.fills[0].y);
  });

  it("眼睛风格变化时眉毛跟随眼睛位置（big 的眉毛比 dot 更宽）", () => {
    const big = makeStubCtx();
    drawBrows(big.ctx, LAYOUT, "flat", ROUND_FRAME, "#FFF", "big");
    const dot = makeStubCtx();
    drawBrows(dot.ctx, LAYOUT, "flat", ROUND_FRAME, "#FFF", "dot");
    expect(big.fills[0].w).toBeGreaterThan(dot.fills[0].w);
  });
});
