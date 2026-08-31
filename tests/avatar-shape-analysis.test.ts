import { describe as d, expect, it } from "vitest";
import {
  classifyShape,
  type MaskGeom,
} from "../src/avatar/shape-analysis";

const N = 32;

/** 构造 32×32 前景 mask 并给出包围盒几何。 */
function makeMask(paint: (x: number, y: number) => boolean): {
  mask: Uint8Array;
  geom: MaskGeom;
} {
  const mask = new Uint8Array(N * N);
  let minX = N;
  let maxX = -1;
  let minY = N;
  let maxY = -1;
  let count = 0;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      if (!paint(x, y)) continue;
      mask[y * N + x] = 1;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return { mask, geom: { width: N, height: N, minX, maxX, minY, maxY, count } };
}

/** 圆盘。 */
function disk(cx: number, cy: number, r: number) {
  return (x: number, y: number) => Math.hypot(x - cx, y - cy) <= r;
}

/** 实心三角（顶点在上）。 */
function spike(cx: number, baseY: number, halfW: number, tipY: number) {
  return (x: number, y: number) => {
    if (y < tipY || y > baseY) return false;
    const t = (y - tipY) / (baseY - tipY); // 0 尖 → 1 底
    return Math.abs(x - cx) <= Math.max(0.5, t * halfW);
  };
}

function combine(...fns: ((x: number, y: number) => boolean)[]) {
  return (x: number, y: number) => fns.some((f) => f(x, y));
}

d("形状分类决策树", () => {
  it("圆盘 → round", () => {
    const { mask, geom } = makeMask(disk(16, 18, 11));
    expect(classifyShape(mask, geom).shape).toBe("round");
  });

  it("横长条 → wide", () => {
    const { mask, geom } = makeMask(
      (x, y) => x >= 3 && x <= 28 && y >= 12 && y <= 19,
    );
    expect(classifyShape(mask, geom).shape).toBe("wide");
  });

  it("竖长条 → tall", () => {
    const { mask, geom } = makeMask(
      (x, y) => x >= 12 && x <= 19 && y >= 3 && y <= 28,
    );
    expect(classifyShape(mask, geom).shape).toBe("tall");
  });

  it("底宽顶窄的梯形 → shroom", () => {
    const { mask, geom } = makeMask((x, y) => {
      if (y < 8 || y > 29) return false;
      const t = (y - 8) / 21; // 顶 0 → 底 1
      const half = 6 + t * 7; // 半宽 6 → 13
      return Math.abs(x - 16) <= half;
    });
    expect(classifyShape(mask, geom).shape).toBe("shroom");
  });

  it("满幅方块 → box（凸性满分，不能被误判成 blob）", () => {
    const { mask, geom } = makeMask((x, y) => x >= 6 && x <= 25 && y >= 6 && y <= 25);
    expect(classifyShape(mask, geom).shape).toBe("box");
  });

  it("史莱姆（头小身大的不规则圆顶）→ blob", () => {
    const { mask, geom } = makeMask(
      combine(
        disk(16, 22, 9), // 底部大圆
        disk(16, 13, 5), // 顶部小圆肩
      ),
    );
    expect(classifyShape(mask, geom).shape).toBe("blob");
  });

  it("水滴（顶尖底圆）→ drop", () => {
    const { mask, geom } = makeMask(
      combine(disk(16, 24, 9), spike(16, 21, 6, 8)),
    );
    expect(classifyShape(mask, geom).shape).toBe("drop");
  });
});

d("顶部凸起的特征件识别", () => {
  it("圆身 + 双尖耳 → pointy-ears（猫）", () => {
    const { mask, geom } = makeMask(
      combine(
        disk(16, 20, 9),
        spike(11, 14, 2.5, 7), // 左尖耳
        spike(21, 14, 2.5, 7), // 右尖耳
      ),
    );
    const v = classifyShape(mask, geom);
    expect(v.attachment).toBe("pointy-ears");
    expect(v.shape).toBe("round");
  });

  it("圆身 + 双矮宽耳 → ears（熊/鼠）", () => {
    const { mask, geom } = makeMask(
      combine(
        disk(16, 20, 9),
        disk(10, 12, 3), // 左圆耳
        disk(22, 12, 3), // 右圆耳
      ),
    );
    expect(classifyShape(mask, geom).attachment).toBe("ears");
  });

  it("两侧贴边的窄尖 → horns", () => {
    const { mask, geom } = makeMask(
      combine(
        disk(16, 20, 9),
        spike(8, 15, 1.5, 6), // 左角，贴 bbox 左缘
        spike(24, 15, 1.5, 6), // 右角，贴 bbox 右缘
      ),
    );
    expect(classifyShape(mask, geom).attachment).toBe("horns");
  });

  it("居中孤立细杆 → antenna", () => {
    const { mask, geom } = makeMask(
      combine(
        disk(16, 21, 9),
        // 细杆：宽 2，从头顶向上伸出，两侧无像素
        (x, y) => x >= 15 && x <= 16 && y >= 6 && y <= 13,
      ),
    );
    expect(classifyShape(mask, geom).attachment).toBe("antenna");
  });

  it("水滴的尖顶不是触角（与身体连续过渡）", () => {
    const { mask, geom } = makeMask(
      combine(disk(16, 24, 9), spike(16, 21, 6, 8)),
    );
    expect(classifyShape(mask, geom).attachment).toBe("none");
  });

  it("无凸起的圆盘 → none", () => {
    const { mask, geom } = makeMask(disk(16, 18, 11));
    expect(classifyShape(mask, geom).attachment).toBe("none");
  });
});
