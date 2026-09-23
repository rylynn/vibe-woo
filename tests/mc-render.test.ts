// tests/mc-render.test.ts
import { describe, expect, it } from "vitest";
import { PLAYER_MODEL } from "../src/mc/model";
import { projectModel } from "../src/mc/project";
import { mcRestPose } from "../src/mc/pose";
import { drawMcFaces } from "../src/mc/render";

interface Probe {
  transforms: number[][];
  draws: number;
  saves: number;
  restores: number;
}

function probeCtx() {
  const p: Probe = { transforms: [], draws: 0, saves: 0, restores: 0 };
  const ctx = {
    // 初值 0.5 而非 1：若渲染漏掉「恒 1」赋值，下面的断言才会红，
    // 而不是被初值 1 空转放过（零半透明是渲染红线）
    globalAlpha: 0.5,
    imageSmoothingEnabled: true,
    save: () => {
      p.saves++;
    },
    restore: () => {
      p.restores++;
    },
    setTransform: (...a: number[]) => {
      p.transforms.push(a);
    },
    drawImage: () => {
      p.draws++;
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, p };
}

const HALF_GRID = (n: number) => Number.isInteger(n * 2);

describe("drawMcFaces", () => {
  it("每个面恰好一次 drawImage，次数不超过预算 36", () => {
    const faces = projectModel(PLAYER_MODEL, mcRestPose(), { m: 2, ox: 0, oy: 0 });
    const { ctx, p } = probeCtx();
    drawMcFaces(ctx, faces, {} as CanvasImageSource);
    expect(p.draws).toBe(faces.length);
    expect(p.draws).toBeLessThanOrEqual(36);
  });

  it("save/restore 严格配对", () => {
    const faces = projectModel(PLAYER_MODEL, mcRestPose(), { m: 1, ox: 0, oy: 0 });
    const { ctx, p } = probeCtx();
    drawMcFaces(ctx, faces, {} as CanvasImageSource);
    expect(p.saves).toBe(faces.length);
    expect(p.restores).toBe(faces.length);
  });

  it("关闭平滑、alpha 恒 1（零半透明红线）", () => {
    const { ctx } = probeCtx();
    drawMcFaces(ctx, [], {} as CanvasImageSource);
    expect((ctx as unknown as { imageSmoothingEnabled: boolean }).imageSmoothingEnabled).toBe(false);
    expect((ctx as unknown as { globalAlpha: number }).globalAlpha).toBe(1);
  });

  it("所有变换系数在 0.5 网格、平移整数（m=1 奇数倍率）", () => {
    const faces = projectModel(PLAYER_MODEL, mcRestPose(), { m: 1, ox: 7, oy: 13 });
    const { ctx, p } = probeCtx();
    drawMcFaces(ctx, faces, {} as CanvasImageSource);
    expect(p.transforms.length).toBe(faces.length);
    for (const [a, b, c, d, e, f] of p.transforms) {
      expect(HALF_GRID(a)).toBe(true);
      expect(HALF_GRID(b)).toBe(true);
      expect(HALF_GRID(c)).toBe(true);
      expect(HALF_GRID(d)).toBe(true);
      expect(Number.isInteger(e)).toBe(true);
      expect(Number.isInteger(f)).toBe(true);
    }
  });
});
