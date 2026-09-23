// tests/mc-face.test.ts
import { describe, expect, it } from "vitest";
import type { EyeFrame } from "../src/anim/expression";
import type { McFace } from "../src/mc/project";
import { mcRestPose } from "../src/mc/pose";
import { EYE_COLOR } from "../src/render/eyes";
import { drawMcEyes, mcEyePixels, EYE_LIGHT, EYEBAG } from "../src/mc/face";

const EYE = (over: Partial<EyeFrame> = {}): EyeFrame => ({
  shape: "round", lid: 0, gazeX: 0, gazeY: 0, ...over,
});
const pose = (over = {}) => ({ ...mcRestPose(), ...over });

describe("mcEyePixels", () => {
  it("round 静止：两眼各 2×2，窗口局部列 {2,3}/{5,6}、行 4-5", () => {
    const px = mcEyePixels(EYE(), pose());
    expect(px).toHaveLength(8);
    // 7 颗瞳色 + 左眼最上左 1 颗高光（catchlight 用例细断言）
    expect(px.filter((p) => p.color === EYE_COLOR)).toHaveLength(7);
    expect(px.filter((p) => p.c <= 3).map((p) => p.c).sort()).toEqual([2, 2, 3, 3]);
    expect(px.filter((p) => p.c >= 5).map((p) => p.c).sort()).toEqual([5, 5, 6, 6]);
    expect(px.every((p) => p.r === 4 || p.r === 5)).toBe(true);
  });

  it("关键不变量：yaw=1 且 gx=1 时窗口列与静止相同（窗口位移被 −yaw 抵消）", () => {
    const moved = mcEyePixels(EYE({ gazeX: 0.6 }), pose({ headYaw: 1 }));
    expect(moved.map((p) => `${p.c},${p.r}`).sort()).toEqual(
      mcEyePixels(EYE(), pose()).map((p) => `${p.c},${p.r}`).sort(),
    );
  });

  it("视线单独移动：gx=+1 列右移一格；镜像取反", () => {
    const right = mcEyePixels(EYE({ gazeX: 0.6 }), pose());
    expect(right.some((p) => p.c === 4)).toBe(true); // 右眼 2,3 → 3,4
    const mirrored = mcEyePixels(EYE({ gazeX: 0.6 }), pose({ mirrored: true }));
    expect(mirrored.some((p) => p.c === 1)).toBe(true); // 取反 → 1,2
  });

  it("纵向：gazeY=0.6 → gy=1 行下移；headPitch 叠加", () => {
    const down = mcEyePixels(EYE({ gazeY: 0.6 }), pose());
    expect(down.every((p) => p.r === 5 || p.r === 6)).toBe(true);
    const pitch = mcEyePixels(EYE({ gazeY: 0.6 }), pose({ headPitch: 1 }));
    expect(pitch.every((p) => p.r === 6 || p.r === 7)).toBe(true);
  });

  it("眨眼：round lid=0.6 只保最底 1 行；closed 恒为一条线", () => {
    const blink = mcEyePixels(EYE({ lid: 0.6 }), pose());
    expect(blink).toHaveLength(4);
    expect(blink.every((p) => p.r === 5)).toBe(true);
    const closed = mcEyePixels(EYE({ shape: "closed", lid: 1 }), pose());
    expect(closed).toHaveLength(4);
    expect(closed.every((p) => p.r === 5)).toBe(true);
  });

  it("帧指纹不变量：同 1/16 桶内的相邻 lid 产出完全相同像素", () => {
    // round(lid·16) 同为 8：对齐前 visible 是 2 vs 1（曾违反同指纹同像素）
    expect(Math.round(0.4999 * 16)).toBe(8);
    expect(Math.round(0.5 * 16)).toBe(8);
    expect(mcEyePixels(EYE({ lid: 0.4999 }), pose())).toEqual(
      mcEyePixels(EYE({ lid: 0.5 }), pose()),
    );
    // 桶边界对：round(·16) 同为 7
    expect(Math.round(0.4374 * 16)).toBe(7);
    expect(Math.round(0.4375 * 16)).toBe(7);
    expect(mcEyePixels(EYE({ lid: 0.4374 }), pose())).toEqual(
      mcEyePixels(EYE({ lid: 0.4375 }), pose()),
    );
  });

  it("catchlight：左眼最上左一颗 EYE_LIGHT；happy/worried 不点", () => {
    const px = mcEyePixels(EYE(), pose());
    const lights = px.filter((p) => p.color === EYE_LIGHT);
    expect(lights).toEqual([{ c: 5, r: 4, color: EYE_LIGHT }]);
    expect(mcEyePixels(EYE({ shape: "happy" }), pose()).some((p) => p.color === EYE_LIGHT)).toBe(false);
    expect(mcEyePixels(EYE({ shape: "worried" }), pose()).some((p) => p.color === EYE_LIGHT)).toBe(false);
  });

  it("tired：眼下 EYEBAG 各 2 颗（r=6，随 −yaw 不随 gx）", () => {
    const px = mcEyePixels(EYE({ gazeX: 0.6 }), pose({ tired: true, headYaw: 1 }));
    const bags = px.filter((p) => p.color === EYEBAG);
    expect(bags).toHaveLength(4);
    expect(bags.every((p) => p.r === 6)).toBe(true);
    // 基准列 2/5 各 2 颗，−yaw=1 → {1,2} 与 {4,5}
    expect(bags.map((p) => p.c).sort()).toEqual([1, 2, 4, 5]);
  });

  it("越窗丢弃：wide + gx=+1 时左眼 dx=2 列 8 被丢弃", () => {
    const px = mcEyePixels(EYE({ shape: "wide", gazeX: 0.6 }), pose());
    expect(px.every((p) => p.c >= 0 && p.c <= 7 && p.r >= 0 && p.r <= 7)).toBe(true);
    expect(px.some((p) => p.c === 7)).toBe(true);
    expect(px.some((p) => p.c === 8)).toBe(false);
  });
});

describe("drawMcEyes", () => {
  /** 头正面的最小替身（m=2：u/v = (3,0)/(0,3)）。 */
  const HEAD_FRONT: McFace = {
    o: { x: 10, y: 20 },
    u: { x: 3, y: 0 },
    v: { x: 0, y: 3 },
    tex: { sx: 8, sy: 8, sw: 8, sh: 8 },
    z: 99, overlay: false, box: "head", face: "front",
  };

  function probeCtx() {
    const rects: number[][] = [];
    let transforms = 0;
    const ctx = {
      globalAlpha: 1,
      fillStyle: "",
      setTransform: () => { transforms++; },
      fillRect: (...a: number[]) => { rects.push(a); },
    } as unknown as CanvasRenderingContext2D;
    return { ctx, rects, transforms: () => transforms };
  }

  it("每像素一个整数 fillRect；预算 ≤30；绝不用 setTransform（AA 红线）", () => {
    const { ctx, rects, transforms } = probeCtx();
    drawMcEyes(ctx, [HEAD_FRONT], pose(), EYE());
    expect(rects).toHaveLength(8);
    expect(transforms()).toBe(0);
    expect(rects.length).toBeLessThanOrEqual(30);
    for (const [x, y, w, h] of rects) {
      expect(Number.isInteger(x)).toBe(true);
      expect(Number.isInteger(y)).toBe(true);
      expect(Number.isInteger(w)).toBe(true);
      expect(Number.isInteger(h)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(1);
      expect(h).toBeGreaterThanOrEqual(1);
    }
    // 像素 (c=2,r=4)：a=(16,32)、b=(19,35) → 3×3
    expect(rects.some((r) => r[0] === 16 && r[1] === 32 && r[2] === 3 && r[3] === 3)).toBe(true);
  });

  it("镜像面（u.x 为负）同样落整数矩形：取 min/max 角", () => {
    const { ctx, rects } = probeCtx();
    const flipped: McFace = { ...HEAD_FRONT, o: { x: 40, y: 20 }, u: { x: -3, y: 0 } };
    drawMcEyes(ctx, [flipped], pose(), EYE());
    // 像素 (c=2,r=4)：a=(34,32)、b=(31,35) → x 取 [31,34)
    expect(rects.some((r) => r[0] === 31 && r[1] === 32 && r[2] === 3 && r[3] === 3)).toBe(true);
  });

  it("奇数 m（u.x=1.5）圆角后仍是相邻整数矩形，无半透明缝隙", () => {
    const { ctx, rects } = probeCtx();
    const odd: McFace = { ...HEAD_FRONT, o: { x: 10, y: 20 }, u: { x: 1.5, y: 0 }, v: { x: 0, y: 1.5 } };
    drawMcEyes(ctx, [odd], pose(), EYE());
    // 列 2 与列 3 的矩形相邻（2 → x∈[13,16)，3 → x∈[14.5,17.5)→[15,18)）
    const xs = rects.map((r) => r[0]).sort((a, b) => a - b);
    for (const x of xs) expect(Number.isInteger(x)).toBe(true);
    expect(rects.some((r) => r[0] === 13)).toBe(true);
    expect(rects.some((r) => r[0] === 15)).toBe(true);
  });

  it("找不到头正面时安静返回", () => {
    const { ctx, rects } = probeCtx();
    drawMcEyes(ctx, [], pose(), EYE());
    expect(rects).toHaveLength(0);
  });
});
