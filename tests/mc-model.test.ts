// tests/mc-model.test.ts
import { describe, expect, it } from "vitest";
import { MC_SKIN_SIZE, PLAYER_MODEL, modelForForm } from "../src/mc/model";

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
});

describe("modelForForm", () => {
  it("player 返回 PLAYER_MODEL", () => {
    expect(modelForForm("player")).toBe(PLAYER_MODEL);
  });
});
