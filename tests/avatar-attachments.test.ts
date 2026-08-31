import { describe as d, expect, it } from "vitest";
import { drawAttachments, splitBodyBox } from "../src/render/attachments";
import type { EyeLayout } from "../src/render/eyes";
import type { Attachment } from "../src/avatar/types";

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

const LAYOUT: EyeLayout = { bodyX: 10, bodyY: 20, w: 96, h: 96 };

d("身体/附件分框", () => {
  it("无附件时身体占满 bbox、无附件区", () => {
    const { body, cap } = splitBodyBox(LAYOUT, "none");
    expect(body).toEqual({ x: 10, y: 20, w: 96, h: 96 });
    expect(cap).toBeNull();
  });

  it("有附件时身体压缩、底部对齐、附件区在顶部", () => {
    const { body, cap } = splitBodyBox(LAYOUT, "ears");
    expect(body.y + body.h).toBe(LAYOUT.bodyY + LAYOUT.h);
    expect(body.h).toBeLessThan(LAYOUT.h);
    expect(cap).not.toBeNull();
    expect(cap!.y).toBe(LAYOUT.bodyY);
    expect(cap!.y + cap!.h).toBe(body.y);
  });
});

d("特征件渲染", () => {
  it("none 零绘制", () => {
    const { ctx, fills } = makeStubCtx();
    drawAttachments(ctx, LAYOUT, "none", "#FFF");
    expect(fills).toHaveLength(0);
  });

  const inBBox = (f: Fill) =>
    f.x >= LAYOUT.bodyX &&
    f.x + f.w <= LAYOUT.bodyX + LAYOUT.w &&
    f.y >= LAYOUT.bodyY &&
    f.y + f.h <= LAYOUT.bodyY + LAYOUT.h;

  it("ears：左右两块，镜像对称，全部在 bbox 内", () => {
    const { ctx, fills } = makeStubCtx();
    drawAttachments(ctx, LAYOUT, "ears", "#FFE066");
    expect(fills.length).toBe(2);
    for (const f of fills) {
      expect(inBBox(f)).toBe(true);
      expect(f.style).toBe("#FFE066");
    }
    const [a, b] = fills;
    // 相对身体中线镜像
    const mid = LAYOUT.bodyX + LAYOUT.w / 2;
    expect(a.x + a.w / 2 + (b.x + b.w / 2)).toBeCloseTo(mid * 2, 5);
  });

  it("pointy-ears：每侧逐行收窄（顶段窄于底段）", () => {
    const { ctx, fills } = makeStubCtx();
    drawAttachments(ctx, LAYOUT, "pointy-ears", "#FFF");
    expect(fills.length).toBeGreaterThanOrEqual(4);
    const left = fills.filter((f) => f.x + f.w / 2 < LAYOUT.bodyX + LAYOUT.w / 2);
    const sorted = [...left].sort((a, b) => a.y - b.y);
    expect(sorted[0].w).toBeLessThan(sorted[sorted.length - 1].w);
  });

  it("horns：触及 bbox 两侧边缘", () => {
    const { ctx, fills } = makeStubCtx();
    drawAttachments(ctx, LAYOUT, "horns", "#FFF");
    expect(fills.some((f) => f.x <= LAYOUT.bodyX + 2)).toBe(true);
    expect(fills.some((f) => f.x + f.w >= LAYOUT.bodyX + LAYOUT.w - 2)).toBe(true);
  });

  it("antenna：居中细杆 + 顶端珠子", () => {
    const { ctx, fills } = makeStubCtx();
    drawAttachments(ctx, LAYOUT, "antenna", "#FFF");
    expect(fills.length).toBeGreaterThanOrEqual(2);
    const mid = LAYOUT.bodyX + LAYOUT.w / 2;
    for (const f of fills) {
      // 所有件都跨中线（居中）
      expect(f.x).toBeLessThanOrEqual(mid);
      expect(f.x + f.w).toBeGreaterThanOrEqual(mid);
    }
    // 珠子在最上方且比杆宽
    const sorted = [...fills].sort((a, b) => a.y - b.y);
    expect(sorted[0].w).toBeGreaterThan(sorted[sorted.length - 1].w);
  });

  it("所有附件 alpha 无关地实心填充且量化到整数像素", () => {
    for (const a of ["ears", "pointy-ears", "horns", "antenna"] as Attachment[]) {
      const { ctx, fills } = makeStubCtx();
      drawAttachments(ctx, LAYOUT, a, "#FFF");
      for (const f of fills) {
        expect(Number.isInteger(f.x)).toBe(true);
        expect(Number.isInteger(f.y)).toBe(true);
        expect(Number.isInteger(f.w)).toBe(true);
        expect(Number.isInteger(f.h)).toBe(true);
      }
    }
  });
});
