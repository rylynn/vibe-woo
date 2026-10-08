// tests/mc-model.test.ts
import { describe, expect, it } from "vitest";
import {
  CAT_MODEL,
  DOG_MODEL,
  MC_SKIN_SIZE,
  PLAYER_MODEL,
  modelForForm,
  type McBox,
  type McModel,
  type McTexRect,
} from "../src/mc/model";

describe("PLAYER_MODEL", () => {
  it("form 为 player，6 个盒", () => {
    expect(PLAYER_MODEL.form).toBe("player");
    expect(PLAYER_MODEL.boxes).toHaveLength(6);
  });

  it("头是最后一个盒（painter 平手序）", () => {
    expect(PLAYER_MODEL.boxes[PLAYER_MODEL.boxes.length - 1].name).toBe("head");
  });

  it("全部盒坐标与尺寸为偶数（整数投影的前提）", () => {
    for (const b of PLAYER_MODEL.boxes) {
      for (const v of [...b.min, ...b.size]) {
        // 不用 toBe(0)：负偶数 % 2 是 -0，Object.is 区分 ±0 会误报
        expect(v % 2 === 0).toBe(true);
      }
    }
  });

  it("所有 UV 矩形都在 64×64 皮肤内", () => {
    for (const b of PLAYER_MODEL.boxes) {
      const rects = [
        b.faces.front, b.faces.top, b.faces.left,
        ...(b.faces.overlay ? [b.faces.overlay.front, b.faces.overlay.top, b.faces.overlay.left] : []),
      ];
      for (const r of rects) {
        expect(r.sx).toBeGreaterThanOrEqual(0);
        expect(r.sy).toBeGreaterThanOrEqual(0);
        expect(r.sx + r.sw).toBeLessThanOrEqual(MC_SKIN_SIZE);
        expect(r.sy + r.sh).toBeLessThanOrEqual(MC_SKIN_SIZE);
      }
    }
  });

  it("贴图尺寸与盒几何一致：front=宽×高、top=宽×深、left=深×高", () => {
    for (const b of PLAYER_MODEL.boxes) {
      const [w, h, d] = b.size;
      const f = b.faces;
      expect([f.front.sw, f.front.sh]).toEqual([w, h]);
      expect([f.top.sw, f.top.sh]).toEqual([w, d]);
      expect([f.left.sw, f.left.sh]).toEqual([d, h]);
      const ov = f.overlay;
      if (ov) {
        expect([ov.front.sw, ov.front.sh]).toEqual([w, h]);
        expect([ov.top.sw, ov.top.sh]).toEqual([w, d]);
        expect([ov.left.sw, ov.left.sh]).toEqual([d, h]);
      }
    }
  });

  it("每个盒都声明了 overlay（空贴图由运行时按像素跳过）", () => {
    for (const b of PLAYER_MODEL.boxes) {
      expect(b.faces.overlay).toBeDefined();
    }
  });

  it("bottom 贴图仅双臂声明，尺寸 = 宽×深（举臂顶面用）", () => {
    for (const b of PLAYER_MODEL.boxes) {
      const isArm = b.name === "right-arm" || b.name === "left-arm";
      expect(b.faces.bottom !== undefined).toBe(isArm);
      if (b.faces.bottom) {
        const [w, , d] = b.size;
        expect([b.faces.bottom.sw, b.faces.bottom.sh]).toEqual([w, d]);
      }
    }
    expect(PLAYER_MODEL.boxes[0].faces.bottom).toEqual({ sx: 48, sy: 16, sw: 4, sh: 4 });
    expect(PLAYER_MODEL.boxes[1].faces.bottom).toEqual({ sx: 40, sy: 48, sw: 4, sh: 4 });
  });
});

describe("modelForForm", () => {
  it("player 返回 PLAYER_MODEL", () => {
    expect(modelForForm("player")).toBe(PLAYER_MODEL);
  });
});

/** 四足共用的结构性约束（与 PLAYER_MODEL 既有用例同口径）。 */
function expectQuadrupedInvariants(model: McModel): void {
  for (const b of model.boxes) {
    for (const v of [...b.min, ...b.size]) {
      // 负偶数 % 2 是 -0，Object.is 区分 ±0 会误报——与玩家用例同写法
      expect(v % 2 === 0).toBe(true);
    }
    const rects = [b.faces.front, b.faces.top, b.faces.left];
    for (const r of rects) {
      expect(r.sx).toBeGreaterThanOrEqual(0);
      expect(r.sy).toBeGreaterThanOrEqual(0);
      expect(r.sx + r.sw).toBeLessThanOrEqual(MC_SKIN_SIZE);
      expect(r.sy + r.sh).toBeLessThanOrEqual(MC_SKIN_SIZE);
    }
    const [w, h, d] = b.size;
    const f = b.faces;
    expect([f.front.sw, f.front.sh]).toEqual([w, h]);
    expect([f.top.sw, f.top.sh]).toEqual([w, d]);
    expect([f.left.sw, f.left.sh]).toEqual([d, h]);
    expect(f.overlay).toBeUndefined(); // 四足无 overlay 层
  }
}

/** 全部基础面 UV 两两不重叠（自定义布局的硬约束）。 */
function expectNoUvOverlap(boxes: McBox[]): void {
  const all: McTexRect[] = [];
  for (const b of boxes) {
    all.push(b.faces.front, b.faces.top, b.faces.left);
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const a = all[i];
      const c = all[j];
      const overlap =
        a.sx < c.sx + c.sw && c.sx < a.sx + a.sw &&
        a.sy < c.sy + c.sh && c.sy < a.sy + a.sh;
      expect(overlap).toBe(false);
    }
  }
}

/** 插入序 = 盒深度中点升序（painter 稳定平手序的前提）。 */
function expectZMidAscending(model: McModel): void {
  const mids = model.boxes.map((b) => b.min[2] + b.size[2] / 2);
  expect(mids).toEqual([...mids].sort((a, b) => a - b));
}

describe("CAT_MODEL", () => {
  it("form 为 cat，10 个盒，头正面窗口 (8,8) 8×8", () => {
    expect(CAT_MODEL.form).toBe("cat");
    expect(CAT_MODEL.boxes).toHaveLength(10);
    const head = CAT_MODEL.boxes.find((b) => b.name === "head");
    expect(head?.faces.front).toEqual({ sx: 8, sy: 8, sw: 8, sh: 8 });
  });

  it("坐标偶数、UV 界内、贴图与几何一致、无 overlay", () => {
    expectQuadrupedInvariants(CAT_MODEL);
  });

  it("插入序 = 深度中点升序；耳画在头之后（头顶不被盖）", () => {
    expectZMidAscending(CAT_MODEL);
    const names = CAT_MODEL.boxes.map((b) => b.name);
    expect(names.indexOf("right-ear")).toBeGreaterThan(names.indexOf("head"));
    expect(names.indexOf("left-ear")).toBeGreaterThan(names.indexOf("head"));
  });

  it("全部 UV 矩形两两不重叠", () => {
    expectNoUvOverlap(CAT_MODEL.boxes);
  });
});

describe("DOG_MODEL", () => {
  it("form 为 dog，7 个盒（无耳、一节尾），头正面窗口 (8,8) 8×8", () => {
    expect(DOG_MODEL.form).toBe("dog");
    expect(DOG_MODEL.boxes).toHaveLength(7);
    const head = DOG_MODEL.boxes.find((b) => b.name === "head");
    expect(head?.faces.front).toEqual({ sx: 8, sy: 8, sw: 8, sh: 8 });
  });

  it("坐标偶数、UV 界内、贴图与几何一致、无 overlay", () => {
    expectQuadrupedInvariants(DOG_MODEL);
  });

  it("插入序 = 深度中点升序；UV 两两不重叠", () => {
    expectZMidAscending(DOG_MODEL);
    expectNoUvOverlap(DOG_MODEL.boxes);
  });
});

describe("modelForForm 三路", () => {
  it("cat/dog 返回各自模型", () => {
    expect(modelForForm("cat")).toBe(CAT_MODEL);
    expect(modelForForm("dog")).toBe(DOG_MODEL);
  });
});
