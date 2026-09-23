// tests/mc-figure.test.ts
import { describe, expect, it } from "vitest";
import type { McAvatar } from "../src/avatar/types";
import { drawMcFigure, filterEmptyOverlays, mcDirtyBounds, mcScaleFor } from "../src/mc/figure";
import { PLAYER_MODEL } from "../src/mc/model";
import { projectModel } from "../src/mc/project";
import { mcRestPose } from "../src/mc/pose";
import type { McTint } from "../src/mc/pose";
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

function stubRes(skin: SkinData) {
  const c = {} as CanvasImageSource;
  return { skin, canvases: { normal: c, focused: c, dim: c } as Record<McTint, CanvasImageSource> };
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
  const faces = projectModel(PLAYER_MODEL, mcRestPose(), { m: 1, ox: 0, oy: 0 });

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
    // 初值 0.5 同理：绘制必须把 alpha 拉回恒 1，漏掉赋值时断言才抓得住
    let alpha = 0.5;
    const ctx = {
      get globalAlpha() {
        return alpha;
      },
      set globalAlpha(v: number) {
        alpha = v;
      },
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
    return {
      ctx,
      draws: () => draws,
      smoothing: () => smoothing,
      alpha: () => alpha,
    };
  }
  const frame = { shape: "round" as const, lid: 0, gazeX: 0, gazeY: 0 };

  it("96px 盒子（m=2）绘制 18 面（空 overlay）", () => {
    const p = probe();
    drawMcFigure(
      p.ctx,
      { bodyX: 0, bodyY: 0, w: 96, h: 96 },
      MC_AVATAR,
      frame,
      stubRes(makeSkin([[8, 8, 8, 8]])),
    );
    expect(p.draws()).toBe(18);
    expect(p.smoothing()).toBe(false);
    // 绘制结束 alpha 必须恒 1（零半透明红线明文要求的探针断言）
    expect(p.alpha()).toBe(1);
  });
});

describe("mcDirtyBounds ⊇ 投影极值", () => {
  /**
   * 78fb0e0 修过的残影 bug 类的不变量护栏：脏矩形必须盖住全部投影顶点。
   * M2 加姿态、M3 加体型不同的猫狗时，手推导的 ±16m / 51m 常数一旦失配
   * 这里立刻红。不 filter overlay——全 overlay 皮肤是最坏情形（全 36 面）。
   */
  it("m=1..4 全 36 面四角都落在脏矩形内", () => {
    for (const m of [1, 2, 3, 4]) {
      const faces = projectModel(PLAYER_MODEL, mcRestPose(), { m, ox: 100, oy: 200 });
      expect(faces).toHaveLength(36);
      const d = mcDirtyBounds(100, 200, m);
      for (const f of faces) {
        const { o, u, v, tex } = f;
        // 平行四边形四角；顶点可能是 x.5（奇数 m），直接数值比较
        const corners = [
          o,
          { x: o.x + u.x * tex.sw, y: o.y + u.y * tex.sw },
          { x: o.x + v.x * tex.sh, y: o.y + v.y * tex.sh },
          {
            x: o.x + u.x * tex.sw + v.x * tex.sh,
            y: o.y + u.y * tex.sw + v.y * tex.sh,
          },
        ];
        for (const c of corners) {
          expect(c.x).toBeGreaterThanOrEqual(d.x);
          expect(c.x).toBeLessThanOrEqual(d.x + d.w);
          expect(c.y).toBeGreaterThanOrEqual(d.y);
          expect(c.y).toBeLessThanOrEqual(d.y + d.h);
        }
      }
    }
  });
});
