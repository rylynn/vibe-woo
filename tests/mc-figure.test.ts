// tests/mc-figure.test.ts
import { describe, expect, it } from "vitest";
import type { McAvatar } from "../src/avatar/types";
import { drawMcFigure, filterEmptyOverlays, mcScaleFor } from "../src/mc/figure";
import { PLAYER_MODEL } from "../src/mc/model";
import { projectModel } from "../src/mc/project";
import type { SkinData } from "../src/mc/skin";

const MC_AVATAR: McAvatar = { kind: "minecraft", form: "player", skinId: "t" };

/** 指定矩形全不透明的合成皮肤。 */
function makeSkin(rects: [number, number, number, number][]): SkinData {
  const data = new Uint8ClampedArray(64 * 64 * 4);
  for (const [x, y, w, h] of rects) {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const k = ((y + j) * 64 + x + i) * 4;
        data[k] = 255;
        data[k + 1] = 0;
        data[k + 2] = 0;
        data[k + 3] = 255;
      }
    }
  }
  return { w: 64, h: 64, data };
}

describe("mcScaleFor", () => {
  it("48 整数倍取倍率；奇尺寸向下取；最小 1", () => {
    expect(mcScaleFor(48)).toBe(1);
    expect(mcScaleFor(96)).toBe(2);
    expect(mcScaleFor(144)).toBe(3);
    expect(mcScaleFor(192)).toBe(4);
    expect(mcScaleFor(72)).toBe(1);
    expect(mcScaleFor(47)).toBe(1);
  });
});

describe("filterEmptyOverlays", () => {
  const faces = projectModel(PLAYER_MODEL, {}, { m: 1, ox: 0, oy: 0 });

  it("基础面永远保留；空 overlay 全跳过", () => {
    const out = filterEmptyOverlays(faces, makeSkin([[8, 8, 8, 8]]));
    expect(out).toHaveLength(18);
    expect(out.every((f) => !f.overlay)).toBe(true);
  });

  it("全不透明皮肤保留全部 36 面（最坏预算）", () => {
    expect(filterEmptyOverlays(faces, makeSkin([[0, 0, 64, 64]]))).toHaveLength(36);
  });
});

describe("drawMcFigure", () => {
  function probe() {
    let draws = 0;
    // 初始 true（TS 5.9 下 getter/setter 类型需一致）：若绘制未显式
    // 关闭平滑，断言 toBe(false) 会抓到，而不是被初值蒙混过关
    let smoothing = true;
    const ctx = {
      globalAlpha: 1,
      get imageSmoothingEnabled() {
        return smoothing;
      },
      set imageSmoothingEnabled(v: boolean) {
        smoothing = v;
      },
      save() {},
      restore() {},
      setTransform() {},
      drawImage() {
        draws++;
      },
    } as unknown as CanvasRenderingContext2D;
    return { ctx, draws: () => draws, smoothing: () => smoothing };
  }
  const frame = { shape: "round" as const, lid: 0, gazeX: 0, gazeY: 0 };

  it("96px 盒子（m=2）绘制 18 面（空 overlay）", () => {
    const p = probe();
    drawMcFigure(
      p.ctx,
      { bodyX: 0, bodyY: 0, w: 96, h: 96 },
      MC_AVATAR,
      frame,
      { skin: makeSkin([[8, 8, 8, 8]]), canvas: {} as CanvasImageSource },
    );
    expect(p.draws()).toBe(18);
    expect(p.smoothing()).toBe(false);
  });
});
