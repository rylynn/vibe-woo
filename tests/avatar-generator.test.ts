import { describe as d, expect, it } from "vitest";
import { generateCandidates } from "../src/avatar/generator";

/** 确定性 RNG（mulberry32），测试可复现。 */
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

function hexToHsl(hex: string): { h: number; s: number; l: number } {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  if (max === r) {
    h = (g - b) / delta + (g < b ? 6 : 0);
  } else if (max === g) {
    h = (b - r) / delta + 2;
  } else {
    h = (r - g) / delta + 4;
  }
  return { h: h * 60, s, l };
}

/** 色相环上的最短距离。 */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

/** 多个种子各生成一遍，覆盖随机路径。 */
function batches(seeds: number[], count?: number) {
  return seeds.map((s) => generateCandidates(mulberry32(s), count));
}

const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);

d("形象候选生成器", () => {
  it("默认产出 3 个候选", () => {
    expect(generateCandidates(mulberry32(1))).toHaveLength(3);
  });

  it("同一 RNG 序列产出完全相同的候选（可复现）", () => {
    const a = generateCandidates(mulberry32(42));
    const b = generateCandidates(mulberry32(42));
    expect(a).toEqual(b);
  });

  it("候选间形状或眼睛风格至少一项不同（肉眼可辨的差异化）", () => {
    for (const batch of batches(SEEDS)) {
      for (let i = 0; i < batch.length; i++) {
        for (let j = i + 1; j < batch.length; j++) {
          const same =
            batch[i].shape === batch[j].shape &&
            batch[i].eyeStyle === batch[j].eyeStyle;
          expect(same).toBe(false);
        }
      }
    }
  });

  it("候选间主色色相间隔不小于 60°，避免撞色", () => {
    for (const batch of batches(SEEDS)) {
      const hues = batch.map((c) => hexToHsl(c.bodyColor).h);
      for (let i = 0; i < hues.length; i++) {
        for (let j = i + 1; j < hues.length; j++) {
          expect(hueDistance(hues[i], hues[j])).toBeGreaterThanOrEqual(60);
        }
      }
    }
  });

  it("主色饱和度/亮度落在暗色面板可读的协调域", () => {
    for (const batch of batches(SEEDS)) {
      for (const c of batch) {
        const { s, l } = hexToHsl(c.bodyColor);
        expect(s).toBeGreaterThanOrEqual(0.35);
        expect(s).toBeLessThanOrEqual(0.75);
        expect(l).toBeGreaterThanOrEqual(0.45);
        expect(l).toBeLessThanOrEqual(0.65);
      }
    }
  });

  it("点缀色与主色为互补或类似色关系", () => {
    for (const batch of batches(SEEDS)) {
      for (const c of batch) {
        const body = hexToHsl(c.bodyColor);
        const accent = hexToHsl(c.accentColor);
        const dist = hueDistance(body.h, accent.h);
        const analogous = dist <= 30;
        const complementary = dist >= 150 && dist <= 210;
        expect(analogous || complementary).toBe(true);
      }
    }
  });

  it("点缀色亮于主色（高光/眉毛在身体上可读）", () => {
    for (const batch of batches(SEEDS)) {
      for (const c of batch) {
        const body = hexToHsl(c.bodyColor);
        const accent = hexToHsl(c.accentColor);
        expect(accent.l).toBeGreaterThan(body.l);
      }
    }
  });

  it("颜色为 #RRGGBB 大写格式", () => {
    for (const batch of batches(SEEDS)) {
      for (const c of batch) {
        expect(c.bodyColor).toMatch(/^#[0-9A-F]{6}$/);
        expect(c.accentColor).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });

  it("count 参数可改变候选数量", () => {
    expect(generateCandidates(mulberry32(7), 5)).toHaveLength(5);
    expect(generateCandidates(mulberry32(7), 1)).toHaveLength(1);
  });

  it("随机池以低概率纳入特征件与纹理（不喧宾夺主）", () => {
    const all = batches(SEEDS).flat();
    const withAttachment = all.filter((c) => c.attachment !== "none");
    const withPattern = all.filter((c) => c.pattern !== "none");
    // 60 个候选里至少出现一些，但不占多数
    expect(withAttachment.length).toBeGreaterThan(2);
    expect(withAttachment.length).toBeLessThan(all.length / 2);
    expect(withPattern.length).toBeGreaterThan(1);
    expect(withPattern.length).toBeLessThan(all.length / 2);
  });

  it("带纹理的候选必有合法次色", () => {
    for (const c of batches(SEEDS).flat()) {
      if (c.pattern === "none") {
        expect(c.secondaryColor).toBe("");
      } else {
        expect(c.secondaryColor).toMatch(/^#[0-9A-F]{6}$/);
      }
    }
  });
});
