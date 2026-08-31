import { describe as d, expect, it } from "vitest";
import { extractColors } from "../src/avatar/from-image";
import { drawBody, rowInsets } from "../src/render/body";
import { drawSpots } from "../src/render/patterns";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const N = 32;

function makeImage(
  paint: (x: number, y: number) => [number, number, number],
): ImageData {
  const data = new Uint8ClampedArray(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const [r, g, b] = paint(x, y);
      const i = (y * N + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width: N, height: N } as ImageData;
}

const RED: [number, number, number] = [220, 60, 60];
const BLUE: [number, number, number] = [60, 60, 220];

/** 上半红下半蓝（行聚集 → 条纹）。 */
function stripedImage(): ImageData {
  return makeImage((_x, y) => (y < N / 2 ? RED : BLUE));
}

/** 红底随机撒 20% 蓝点（分散 → 斑点）。 */
function spottedImage(): ImageData {
  const rng = mulberry32(7);
  return makeImage(() => (rng() < 0.2 ? BLUE : RED));
}

d("双主色与纹理判定", () => {
  it("单主色图：次色为 null、纹理 none", () => {
    const v = extractColors(makeImage(() => RED), null);
    expect(v.secondary).toBeNull();
    expect(v.pattern).toBe("none");
  });

  it("上下分色图 → 条纹，且两个主色都被提取", () => {
    const v = extractColors(stripedImage(), null);
    expect(v.secondary).not.toBeNull();
    expect(v.pattern).toBe("stripes");
    expect(Math.abs(v.primary.h - 0)).toBeLessThan(8);
    expect(Math.abs(v.secondary!.h - 240)).toBeLessThan(8);
  });

  it("随机散布 → 斑点", () => {
    const v = extractColors(spottedImage(), null);
    expect(v.secondary).not.toBeNull();
    expect(v.pattern).toBe("spots");
  });

  it("次色占比不足 15% 时不认定次色（零星噪点不算纹理）", () => {
    const rng = mulberry32(3);
    // 3% 的零星蓝点
    const img = makeImage(() => (rng() < 0.03 ? BLUE : RED));
    const v = extractColors(img, null);
    expect(v.secondary).toBeNull();
    expect(v.pattern).toBe("none");
  });

  it("纹理判定只统计前景像素（背景不污染条纹判定）", () => {
    // 黑底，中央圆内上半红下半蓝
    const img = makeImage((x, y) => {
      const inside = Math.hypot(x - 16, y - 16) <= 12;
      if (!inside) return [12, 12, 12];
      return y < 16 ? RED : BLUE;
    });
    // 全 1 mask 会把黑底算进来；传前景 mask 才是圆内
    const mask = new Uint8Array(N * N);
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        if (Math.hypot(x - 16, y - 16) <= 12) mask[y * N + x] = 1;
      }
    }
    const v = extractColors(img, mask);
    expect(v.pattern).toBe("stripes");
  });
});

interface Fill {
  x: number;
  y: number;
  w: number;
  h: number;
  style: string;
}

function makeStubCtx() {
  const fills: Fill[] = [];
  const state = { fillStyle: "" };
  const ctx = {
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    fillRect: (x: number, y: number, w: number, h: number) => {
      fills.push({ x, y, w, h, style: state.fillStyle });
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, fills };
}

d("纹理渲染", () => {
  const W2 = 96;
  const H2 = 96;

  it("stripes：行色带交替，行数不变", () => {
    const { ctx, fills } = makeStubCtx();
    drawBody(ctx, "box", 0, 0, W2, H2, "#AAAAAA", "#222222");
    expect(fills).toHaveLength(H2);
    const styles = fills.map((f) => f.style);
    expect(styles).toContain("#AAAAAA");
    expect(styles).toContain("#222222");
    // 相邻行带之间必有切换
    const switches = styles.filter((s, i) => i > 0 && s !== styles[i - 1]);
    expect(switches.length).toBeGreaterThanOrEqual(4);
  });

  it("不传次色时退化为纯色（回归现状）", () => {
    const { ctx, fills } = makeStubCtx();
    drawBody(ctx, "round", 0, 0, W2, H2, "#AAAAAA");
    for (const f of fills) expect(f.style).toBe("#AAAAAA");
  });

  it("spots：确定性伪随机（同参数两次位置一致）", () => {
    const a = makeStubCtx();
    drawBody(a.ctx, "round", 0, 0, W2, H2, "#AAAAAA");
    drawSpots(a.ctx, "round", { x: 0, y: 0, w: W2, h: H2 }, "#222222");
    const b = makeStubCtx();
    drawBody(b.ctx, "round", 0, 0, W2, H2, "#AAAAAA");
    drawSpots(b.ctx, "round", { x: 0, y: 0, w: W2, h: H2 }, "#222222");
    const spotsA = a.fills.filter((f) => f.style === "#222222");
    const spotsB = b.fills.filter((f) => f.style === "#222222");
    expect(spotsA.length).toBeGreaterThan(3);
    expect(spotsA).toEqual(spotsB);
  });

  it("spots：斑点全部落在身体轮廓内（不出形状边缘）", () => {
    const { ctx, fills } = makeStubCtx();
    drawBody(ctx, "round", 0, 0, W2, H2, "#AAAAAA");
    drawSpots(ctx, "round", { x: 0, y: 0, w: W2, h: H2 }, "#222222");
    const insets = rowInsets("round", W2, H2);
    for (const f of fills.filter((f) => f.style === "#222222")) {
      const row = Math.min(H2 - 1, Math.max(0, Math.round(f.y)));
      expect(f.x).toBeGreaterThanOrEqual(insets[row]);
      expect(f.x + f.w).toBeLessThanOrEqual(W2 - insets[row]);
    }
  });
});
