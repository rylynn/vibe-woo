// tests/mc-project.test.ts
import { describe, expect, it } from "vitest";
import { PLAYER_MODEL } from "../src/mc/model";
import { projectModel } from "../src/mc/project";

const HALF_GRID = (n: number) => Number.isInteger(n * 2);

describe("projectModel", () => {
  const faces = projectModel(PLAYER_MODEL, {}, { m: 2, ox: 100, oy: 200 });

  it("玩家出 36 面（6 盒 × 3 基础 + 3 overlay）", () => {
    expect(faces).toHaveLength(36);
    expect(faces.filter((f) => f.overlay)).toHaveLength(18);
  });

  it("所有起点整数、u/v 在 0.5 网格（像素完美约束）", () => {
    for (const f of faces) {
      expect(Number.isInteger(f.o.x)).toBe(true);
      expect(Number.isInteger(f.o.y)).toBe(true);
      for (const v of [f.u.x, f.u.y, f.v.x, f.v.y]) {
        expect(HALF_GRID(v)).toBe(true);
      }
    }
  });

  it("m 为奇数时同样满足约束（0.5 网格兜底奇数倍率）", () => {
    const odd = projectModel(PLAYER_MODEL, {}, { m: 1, ox: 0, oy: 0 });
    for (const f of odd) {
      expect(Number.isInteger(f.o.x)).toBe(true);
      expect(Number.isInteger(f.o.y)).toBe(true);
      expect(HALF_GRID(f.u.x)).toBe(true);
      expect(HALF_GRID(f.v.y)).toBe(true);
    }
  });

  it("正面轴对齐零畸变：头正面 u=(3,0) v=(0,3)（m=2）", () => {
    const headFront = faces.find(
      (f) => !f.overlay && f.tex.sx === 8 && f.tex.sy === 8,
    );
    expect(headFront).toBeDefined();
    expect(headFront!.u).toEqual({ x: 3, y: 0 });
    expect(headFront!.v).toEqual({ x: 0, y: 3 });
    // o = P(−4, 32, 4) = (100 + 3×(−4) + 2×4, 200 − 3×32 + 1×4) = (96, 108)
    expect(headFront!.o).toEqual({ x: 96, y: 108 });
  });

  it("头正面 overlay 是最后一个面（最近 + 平手序在基础面之后）", () => {
    const last = faces[faces.length - 1];
    expect(last.overlay).toBe(true);
    expect(last.tex.sx).toBe(40);
    expect(last.tex.sy).toBe(8);
  });

  it("排序按 z 升序（远先画）", () => {
    for (let i = 1; i < faces.length; i++) {
      expect(faces[i].z).toBeGreaterThanOrEqual(faces[i - 1].z);
    }
  });
});
