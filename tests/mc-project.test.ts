// tests/mc-project.test.ts
import { describe, expect, it } from "vitest";
import { PLAYER_MODEL } from "../src/mc/model";
import { projectModel } from "../src/mc/project";
import { mcRestPose } from "../src/mc/pose";
import type { McPose } from "../src/mc/pose";

const HALF_GRID = (n: number) => Number.isInteger(n * 2);

describe("projectModel", () => {
  const faces = projectModel(PLAYER_MODEL, mcRestPose(), { m: 2, ox: 100, oy: 200 });

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
    const odd = projectModel(PLAYER_MODEL, mcRestPose(), { m: 1, ox: 0, oy: 0 });
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

describe("projectModel 姿态驱动（M2）", () => {
  const VIEW = { m: 2, ox: 100, oy: 200 };
  const pose = (over: Partial<McPose>): McPose => ({ ...mcRestPose(), ...over });

  it("walk：limbPhase=2 时右臂 dz=+2（m=2 下前移 4px/下移 2px）", () => {
    const faces = projectModel(PLAYER_MODEL, pose({ limbPhase: 2 }), VIEW);
    const arm = faces.find((f) => f.box === "right-arm" && f.face === "front" && !f.overlay);
    // 右臂 yTop=24、dz=+2 → zFront=4：P(−8, 24, 4) = (84, 132)
    expect(arm!.o).toEqual({ x: 84, y: 132 });
    // 同相腿（左腿 swing(2)=+2，与右臂同相）：zFront = 4 → P(0, 12, 4) = (108, 168)
    const leg = faces.find((f) => f.box === "left-leg" && f.face === "front" && !f.overlay);
    expect(leg!.o).toEqual({ x: 108, y: 168 });
  });

  it("镜像：数组与未镜像逐位平行（z 不变、o.x 互补、u/v.x 取反）", () => {
    const a = projectModel(PLAYER_MODEL, mcRestPose(), VIEW);
    const b = projectModel(PLAYER_MODEL, pose({ mirrored: true }), VIEW);
    expect(b).toHaveLength(a.length);
    for (let i = 0; i < a.length; i++) {
      expect(b[i].z).toBe(a[i].z);
      expect(b[i].box).toBe(a[i].box);
      expect(b[i].face).toBe(a[i].face);
      expect(b[i].overlay).toBe(a[i].overlay);
      expect(b[i].o.x + a[i].o.x).toBe(2 * VIEW.ox);
      expect(b[i].u.x).toBe(-a[i].u.x);
      expect(b[i].v.x).toBe(-a[i].v.x);
    }
  });

  it("躺平：锚点补偿后包围盒恰为 x∈[ox−22m, ox+22m]、y∈[oy−25m, oy]", () => {
    const faces = projectModel(PLAYER_MODEL, pose({ lying: true }), VIEW);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const f of faces) {
      for (const [c, r] of [[0, 0], [f.tex.sw, 0], [0, f.tex.sh], [f.tex.sw, f.tex.sh]] as const) {
        const x = f.o.x + f.u.x * c + f.v.x * r;
        const y = f.o.y + f.u.y * c + f.v.y * r;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x);
        minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      }
    }
    expect(minX).toBe(100 - 44);
    expect(maxX).toBe(100 + 44);
    expect(minY).toBe(200 - 50);
    expect(maxY).toBe(200);
  });

  it("举臂：臂盒上移 12、正面 180° 翻转（u 反向）、顶面改 bottom 贴图", () => {
    const faces = projectModel(PLAYER_MODEL, pose({ armsUp: true }), VIEW);
    const armFront = faces.find((f) => f.box === "right-arm" && f.face === "front" && !f.overlay);
    // o = P(−4, 24, 2) = (92, 130)，u 反向 (−3, 0)、v 朝上 (0, −3)
    expect(armFront!.o).toEqual({ x: 92, y: 130 });
    expect(armFront!.u).toEqual({ x: -3, y: 0 });
    expect(armFront!.v).toEqual({ x: 0, y: -3 });
    const armTop = faces.find((f) => f.box === "right-arm" && f.face === "top" && !f.overlay);
    expect(armTop!.tex).toEqual({ sx: 48, sy: 16, sw: 4, sh: 4 });
    const leftTop = faces.find((f) => f.box === "left-arm" && f.face === "top" && !f.overlay);
    expect(leftTop!.tex).toEqual({ sx: 40, sy: 48, sw: 4, sh: 4 });
  });

  it("头部窗口位移：yaw=+2 时头正面 tex.sx=10、帽层 42，其余面不动", () => {
    const faces = projectModel(PLAYER_MODEL, pose({ headYaw: 2 }), VIEW);
    const front = faces.find((f) => f.box === "head" && f.face === "front" && !f.overlay);
    const hat = faces.find((f) => f.box === "head" && f.face === "front" && f.overlay);
    expect(front!.tex.sx).toBe(10);
    expect(hat!.tex.sx).toBe(42);
    const top = faces.find((f) => f.box === "head" && f.face === "top" && !f.overlay);
    expect(top!.tex.sx).toBe(8);
  });
});
