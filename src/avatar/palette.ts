/**
 * 形象配色约束工具。
 *
 * 设计目标：在暗色面板（#10141E 系背景）上，随机生成的形象颜色必须
 * 「协调且不违和」——候选间色相拉开、饱和度/亮度收在可读域内、点缀色
 * 与主色保持互补或类似关系。
 *
 * 采样范围比对外承诺的协调域（见测试断言）略收紧，给 HSL→#RRGGBB 的
 * 8bit 量化留出往返误差余量，保证解析回去仍落在域内。
 */

export interface Hsl {
  /** 色相，0..360。 */
  h: number;
  /** 饱和度，0..1。 */
  s: number;
  /** 亮度，0..1。 */
  l: number;
}

/** 主色协调域（对外承诺）：S∈[0.35,0.75]，L∈[0.45,0.65]。 */
const BODY_S: [number, number] = [0.38, 0.72];
const BODY_L: [number, number] = [0.47, 0.63];

/** 色相环上的最短距离。 */
export function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

export function hslToHex({ h, s, l }: Hsl): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  const ch = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0")
      .toUpperCase();
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

/**
 * 采样 count 个两两间隔不小于 minGap 的色相。
 *
 * 拒绝采样足够收敛（3 候选 × 60° 在 360° 环上毫无压力）；极端 RNG 序列
 * 下兜底为均匀分布，均匀间隔本身也满足约束。
 */
export function harmoniousHues(
  rng: () => number,
  count: number,
  minGap: number,
): number[] {
  const hues: number[] = [];
  let guard = 0;
  while (hues.length < count && guard++ < 1000) {
    const h = rng() * 360;
    if (hues.every((e) => hueDistance(e, h) >= minGap)) {
      hues.push(h);
    }
  }
  while (hues.length < count) {
    hues.push((hues.length * 360) / count);
  }
  return hues;
}

/** 在给定色相上采样主色（饱和度/亮度落在协调域）。 */
export function bodyHslFor(hue: number, rng: () => number): Hsl {
  return {
    h: hue,
    s: BODY_S[0] + rng() * (BODY_S[1] - BODY_S[0]),
    l: BODY_L[0] + rng() * (BODY_L[1] - BODY_L[0]),
  };
}

/**
 * 由主色推导点缀色（高光/眉毛）。
 *
 * 随机走互补或类似路线，抖动收在 ±25°（量化往返后仍满足对外承诺的
 * ±30°/150°..210° 区间）；亮度显著抬高，保证在身体上可读。
 */
export function accentFor(body: Hsl, rng: () => number): Hsl {
  const complementary = rng() < 0.5;
  const jitter = rng() * 50 - 25;
  const h = (body.h + (complementary ? 180 : 0) + jitter + 360) % 360;
  return {
    h,
    s: Math.min(0.85, body.s + 0.05),
    l: Math.min(0.9, body.l + 0.2 + rng() * 0.1),
  };
}
