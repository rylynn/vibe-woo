import { describe as d, expect, it } from "vitest";
import {
  analyzeImage,
  avatarFromAnalysis,
  avatarFromFeatures,
  extractFeatures,
} from "../src/avatar/from-image";
import { hexToHsl } from "../src/avatar/palette";

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

/** 构造 32×32 的 ImageData 形态对象（node 环境无 ImageData 构造器）。 */
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

const solid = (r: number, g: number, b: number) => makeImage(() => [r, g, b]);

/** 黑底中央白圆。 */
function circleImage(): ImageData {
  const c = N / 2;
  const radius = N * 0.38;
  return makeImage((x, y) => {
    const inside = Math.hypot(x - c + 0.5, y - c + 0.5) <= radius;
    return inside ? [235, 235, 235] : [15, 15, 15];
  });
}

/** 黑底中央大方块（几乎撑满）。 */
function squareImage(): ImageData {
  return makeImage((x, y) => {
    const inside = x >= 3 && x < N - 3 && y >= 3 && y < N - 3;
    return inside ? [235, 235, 235] : [15, 15, 15];
  });
}

/** 细密棋盘格（高边缘密度）。 */
function checkerImage(): ImageData {
  return makeImage((x, y) =>
    (x + y) % 2 === 0 ? [240, 240, 240] : [10, 10, 10],
  );
}

/** 黑底橙猫：圆身 + 双尖耳。 */
function catImage(): ImageData {
  const disk = (cx: number, cy: number, r: number) => (x: number, y: number) =>
    Math.hypot(x - cx, y - cy) <= r;
  const spike =
    (cx: number, baseY: number, halfW: number, tipY: number) =>
    (x: number, y: number) => {
      if (y < tipY || y > baseY) return false;
      const t = (y - tipY) / (baseY - tipY);
      return Math.abs(x - cx) <= Math.max(0.5, t * halfW);
    };
  const parts = [
    disk(16, 20, 9),
    spike(11, 14, 2.5, 7),
    spike(21, 14, 2.5, 7),
  ];
  return makeImage((x, y) =>
    parts.some((f) => f(x, y)) ? [222, 138, 60] : [14, 14, 16],
  );
}

/** 黑底圆内上半红下半蓝（条纹衫主体）。 */
function stripedCircleImage(): ImageData {
  return makeImage((x, y) => {
    const inside = Math.hypot(x - 16, y - 16) <= 12;
    if (!inside) return [12, 12, 12];
    return y < 16 ? [220, 60, 60] : [60, 60, 220];
  });
}

d("图像特征提取", () => {
  it("纯色图的主色接近该颜色的色相", () => {
    const f = extractFeatures(solid(220, 60, 60));
    expect(Math.abs(f.dominant.h - 0)).toBeLessThan(8);
    expect(f.dominant.s).toBeGreaterThan(0.5);
  });

  it("主色取前景而非背景（黑底白圆应取亮色）", () => {
    const f = extractFeatures(circleImage());
    expect(f.dominant.l).toBeGreaterThan(0.7);
  });

  it("圆形主体的圆形度明显高于方形", () => {
    const circle = extractFeatures(circleImage());
    const square = extractFeatures(squareImage());
    expect(circle.roundness).toBeGreaterThan(square.roundness + 0.2);
  });

  it("棋盘格的边缘密度远高于纯色", () => {
    const checker = extractFeatures(checkerImage());
    const plain = extractFeatures(solid(120, 120, 120));
    expect(checker.edgeDensity).toBeGreaterThan(plain.edgeDensity + 0.4);
  });

  it("源图宽高比透传（横长图 aspect > 1）", () => {
    const f = extractFeatures(solid(100, 100, 200), 2.2);
    expect(f.aspect).toBeCloseTo(2.2, 5);
  });

  it("明暗取前景平均亮度", () => {
    const dark = extractFeatures(solid(30, 30, 40));
    const bright = extractFeatures(solid(230, 230, 220));
    expect(bright.lightness).toBeGreaterThan(dark.lightness + 0.5);
  });
});

d("主体识别与轮廓分析", () => {
  it("纯色/抽象图无明确主体", () => {
    expect(analyzeImage(solid(120, 120, 120)).hasSubject).toBe(false);
    expect(analyzeImage(checkerImage()).hasSubject).toBe(false);
  });

  it("黑底白圆有明确主体", () => {
    expect(analyzeImage(circleImage()).hasSubject).toBe(true);
  });

  it("猫图 → round 身 + pointy-ears（形状与核心特征都被像素化）", () => {
    const [first] = avatarFromAnalysis(analyzeImage(catImage()), mulberry32(1));
    expect(first.shape).toBe("round");
    expect(first.attachment).toBe("pointy-ears");
    // 主色取猫的橙色
    expect(first.bodyColor).toMatch(/^#/);
    const h = hexToHsl(first.bodyColor).h;
    expect(h).toBeGreaterThan(15);
    expect(h).toBeLessThan(50);
  });

  it("条纹主体 → stripes 纹理与次色", () => {
    const [first] = avatarFromAnalysis(
      analyzeImage(stripedCircleImage()),
      mulberry32(1),
    );
    expect(first.pattern).toBe("stripes");
    expect(first.secondaryColor).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("棋盘格（无主体、高边缘密度）不再落入史莱姆垄断", () => {
    const [first] = avatarFromAnalysis(
      analyzeImage(checkerImage()),
      mulberry32(1),
    );
    expect(first.shape).not.toBe("blob");
    // 但眉毛仍保留「复杂图」的信号
    expect(first.browStyle).toBe("bushy");
    // 双主色被识别为斑点纹理
    expect(first.pattern).toBe("spots");
  });
});

d("无主体退回与特征映射", () => {
  it("横长源图 → wide 形状", () => {
    const f = extractFeatures(solid(200, 100, 80), 2.4);
    const [first] = avatarFromFeatures(f, mulberry32(1));
    expect(first.shape).toBe("wide");
  });

  it("竖长源图 → tall 形状", () => {
    const f = extractFeatures(solid(200, 100, 80), 0.4);
    const [first] = avatarFromFeatures(f, mulberry32(1));
    expect(first.shape).toBe("tall");
  });

  it("深沉的图 → sleepy 眼风；明快的图 → big 眼风", () => {
    const dark = avatarFromFeatures(
      extractFeatures(solid(25, 25, 35)),
      mulberry32(1),
    )[0];
    const bright = avatarFromFeatures(
      extractFeatures(solid(240, 235, 210)),
      mulberry32(1),
    )[0];
    expect(dark.eyeStyle).toBe("sleepy");
    expect(bright.eyeStyle).toBe("big");
  });
});

d("形象输出约束", () => {
  it("产出 3 个候选", () => {
    expect(avatarFromAnalysis(analyzeImage(circleImage()), mulberry32(1))).toHaveLength(3);
  });

  it("所有候选的主色都来自图片主色（色相偏差 ≤32°）", () => {
    const a = analyzeImage(solid(210, 80, 60));
    const expectedHue = a.colors.primary.h;
    for (const c of avatarFromAnalysis(a, mulberry32(1))) {
      const h = hexToHsl(c.bodyColor).h;
      const dist = Math.min(
        Math.abs(h - expectedHue),
        360 - Math.abs(h - expectedHue),
      );
      expect(dist).toBeLessThanOrEqual(32);
    }
  });

  it("主色被钳制到协调域（过饱和/过暗的图不会生成刺眼形象）", () => {
    const a = analyzeImage(solid(255, 0, 0));
    for (const c of avatarFromAnalysis(a, mulberry32(1))) {
      const { s, l } = hexToHsl(c.bodyColor);
      expect(s).toBeLessThanOrEqual(0.76);
      expect(l).toBeGreaterThanOrEqual(0.44);
      expect(l).toBeLessThanOrEqual(0.66);
    }
  });

  it("候选间形状或眼睛风格不同（差异化与随机生成器一致）", () => {
    const list = avatarFromAnalysis(analyzeImage(circleImage()), mulberry32(1));
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const same =
          list[i].shape === list[j].shape &&
          list[i].eyeStyle === list[j].eyeStyle;
        expect(same).toBe(false);
      }
    }
  });

  it("同一分析 + 同一 RNG 产出相同候选（可复现）", () => {
    const a = analyzeImage(circleImage());
    expect(avatarFromAnalysis(a, mulberry32(7))).toEqual(
      avatarFromAnalysis(a, mulberry32(7)),
    );
  });

  it("特征件的次色为点缀色系（accent 更亮）", () => {
    const list = avatarFromAnalysis(analyzeImage(catImage()), mulberry32(1));
    for (const c of list) {
      const body = hexToHsl(c.bodyColor);
      const accent = hexToHsl(c.accentColor);
      expect(accent.l).toBeGreaterThan(body.l);
    }
  });
});
