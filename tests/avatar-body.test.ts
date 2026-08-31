import { describe as d, expect, it } from "vitest";
import { drawBody, rowInsets } from "../src/render/body";
import { BODY_SHAPES } from "../src/avatar/types";

interface Fill {
  x: number;
  y: number;
  w: number;
  h: number;
  style: string;
  alpha: number;
}

function makeStubCtx() {
  const fills: Fill[] = [];
  const state = { fillStyle: "", globalAlpha: 1 };
  const ctx = {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      fills.push({
        x,
        y,
        w,
        h,
        style: state.fillStyle,
        alpha: state.globalAlpha,
      });
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, fills };
}

const W = 96;
const H = 96;

d("形状轮廓表", () => {
  it("每个形状返回 h 行，行宽非负且最窄处仍可读", () => {
    for (const shape of BODY_SHAPES) {
      const insets = rowInsets(shape, W, H);
      expect(insets).toHaveLength(H);
      for (const inset of insets) {
        expect(inset).toBeGreaterThanOrEqual(0);
        // 最窄的行也要保住 4px，否则形状会「断开」
        expect(W - 2 * inset).toBeGreaterThanOrEqual(4);
      }
    }
  });

  it("box 每行内缩为 0（现状矩形的回归保护）", () => {
    const insets = rowInsets("box", W, H);
    expect(insets.every((v) => v === 0)).toBe(true);
  });

  it("round 四角内缩、中间行为 0", () => {
    const insets = rowInsets("round", W, H);
    expect(insets[0]).toBeGreaterThan(0);
    expect(insets[H - 1]).toBeGreaterThan(0);
    expect(insets[Math.floor(H / 2)]).toBe(0);
  });

  it("blob 头小身大：顶部内缩大于底部", () => {
    const insets = rowInsets("blob", W, H);
    expect(insets[0]).toBeGreaterThan(insets[H - 1]);
  });

  it("tall 端部收窄比 wide 更激进（竖瘦感）", () => {
    const tall = rowInsets("tall", W, H);
    const wide = rowInsets("wide", W, H);
    expect(tall[0]).toBeGreaterThan(wide[0]);
  });

  it("wide 中部保持饱满，tall 中部几乎不收（扁圆 vs 竖蛋）", () => {
    const tall = rowInsets("tall", W, H);
    const wide = rowInsets("wide", W, H);
    const mid = Math.floor(H / 2);
    expect(wide[mid]).toBeGreaterThan(tall[mid]);
  });

  it("shroom 底宽顶窄：底部内缩明显小于顶部", () => {
    const insets = rowInsets("shroom", W, H);
    expect(insets[H - 1]).toBeLessThan(insets[0]);
    // 顶部收窄要显著，否则与 round 分不清
    expect(insets[0]).toBeGreaterThan(W * 0.12);
  });

  it("drop 顶尖底圆：顶部最窄，底部比顶部饱满", () => {
    const insets = rowInsets("drop", W, H);
    const mid = Math.floor(H / 2);
    expect(insets[0]).toBeGreaterThan(insets[mid]);
    expect(insets[H - 1]).toBeLessThan(insets[0]);
  });

  it("shroom 与 drop 可区分：shroom 顶部没 drop 那么尖", () => {
    expect(rowInsets("shroom", W, H)[0]).toBeLessThan(rowInsets("drop", W, H)[0]);
  });

  it("轮廓是整数像素（像素艺术不允许亚像素边缘）", () => {
    for (const shape of BODY_SHAPES) {
      for (const inset of rowInsets(shape, W, H)) {
        expect(Number.isInteger(inset)).toBe(true);
      }
    }
  });

  it("同参数命中缓存返回同一引用（每帧重建会让 GC 抖动）", () => {
    const a = rowInsets("blob", W, H);
    const b = rowInsets("blob", W, H);
    expect(a).toBe(b);
  });
});

d("形状绘制", () => {
  it("逐行填充，行数等于高度，每行 1px 高", () => {
    const { ctx, fills } = makeStubCtx();
    drawBody(ctx, "round", 10, 20, W, H, "#AABBCC");
    expect(fills).toHaveLength(H);
    for (const f of fills) {
      expect(f.h).toBe(1);
    }
  });

  it("y 坐标逐行递增，x 与行宽符合轮廓表", () => {
    const { ctx, fills } = makeStubCtx();
    drawBody(ctx, "round", 10, 20, W, H, "#AABBCC");
    const insets = rowInsets("round", W, H);
    for (let row = 0; row < H; row++) {
      expect(fills[row].y).toBe(20 + row);
      expect(fills[row].x).toBe(10 + insets[row]);
      expect(fills[row].w).toBe(W - 2 * insets[row]);
    }
  });

  it("全程 alpha=1 且颜色为传入基色（穿透硬约束）", () => {
    const { ctx, fills } = makeStubCtx();
    drawBody(ctx, "blob", 0, 0, W, H, "#5CD4A8");
    for (const f of fills) {
      expect(f.alpha).toBe(1);
      expect(f.style).toBe("#5CD4A8");
    }
  });

  it("box 退化为单次整框填充（保持现状的 1 次 fillRect 开销）", () => {
    const { ctx, fills } = makeStubCtx();
    drawBody(ctx, "box", 10, 20, W, H, "#AABBCC");
    expect(fills).toHaveLength(1);
    expect(fills[0]).toMatchObject({ x: 10, y: 20, w: W, h: H });
  });
});
