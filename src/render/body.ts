import type { BodyShape } from "../avatar/types";

/**
 * 身体形状渲染。
 *
 * 每种形状预计算「逐行内缩表」：第 row 行左右各内缩 inset 像素。
 * 绘制时按行 fillRect(x+inset, y+row, w-2*inset, 1) —— 全部为整数像素
 * 的实心矩形，alpha 恒为 1，边缘不会因重采样而抖动。
 *
 * 刻意不用 offscreen canvas + drawImage：每帧重采样会让像素边缘持续
 * 抖动（见 pet.ts 关于精灵图的注释）。逐行填充的 fillRect 是 GPU 矩形
 * 填充，96px 档最多 96 次调用，开销可忽略。
 *
 * bounding box 恒为 w×h → 现有脏矩形与 glowBounds 逻辑零改动。
 */

/** 单侧内缩的最大值：保证最窄的行仍有几像素宽，形状不会「断开」。 */
function clampInset(inset: number, w: number): number {
  return Math.min(Math.max(0, Math.round(inset)), Math.floor((w - 4) / 2));
}

/**
 * 单位化轮廓函数：t = row/(h-1) ∈ [0,1]，返回单侧内缩占 w 的比例。
 *
 * 形状的辨识度靠轮廓差异，而不是颜色或装饰：
 * - box    矩形（现状）
 * - round  圆角矩形，四角按圆弧过渡
 * - blob   史莱姆：头小身大，顶部快速收窄、底部微收
 * - tall   竖蛋形：端部激进收窄、中部不收，视觉修长
 * - wide   扁圆：整体带弧度、中部保持饱满，视觉敦实
 */
function insetRatio(shape: BodyShape, t: number): number {
  switch (shape) {
    case "box":
      return 0;
    case "round": {
      // 圆角区占两端各 20%，区内按圆方程过渡
      const R = 0.2;
      if (t >= R && t <= 1 - R) return 0;
      const v = t < R ? (R - t) / R : (t - (1 - R)) / R;
      return R * (1 - Math.sqrt(Math.max(0, 1 - v * v)));
    }
    case "blob": {
      if (t < 0.35) {
        const u = t / 0.35;
        return 0.26 * (1 - Math.sin((u * Math.PI) / 2));
      }
      if (t > 0.85) {
        return 0.08 * ((t - 0.85) / 0.15);
      }
      return 0;
    }
    case "tall": {
      const d = Math.abs(2 * t - 1);
      return 0.26 * Math.pow(d, 1.8);
    }
    case "wide": {
      const d = Math.abs(2 * t - 1);
      return 0.06 + 0.14 * d * d;
    }
    case "shroom": {
      // 蘑菇：底宽顶窄，顶部平缓收窄（伞盖感），向下单调展开
      return 0.16 * Math.pow(1 - t, 1.3);
    }
    case "drop": {
      // 水滴：顶部快速收窄成尖，中下部饱满，底部微收
      if (t < 0.3) {
        return 0.3 * Math.pow(1 - t / 0.3, 1.5);
      }
      if (t > 0.8) {
        return 0.08 * ((t - 0.8) / 0.2);
      }
      return 0;
    }
  }
}

/** 轮廓表缓存：同 (shape,w,h) 直接复用，避免每帧重建数组。 */
const cache = new Map<string, number[]>();

/** 计算形状在 w×h 框内的逐行单侧内缩表（长度 h，整数像素）。 */
export function rowInsets(shape: BodyShape, w: number, h: number): number[] {
  const key = `${shape}:${w}:${h}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const rows: number[] = new Array(h);
  for (let row = 0; row < h; row++) {
    const t = h <= 1 ? 0 : row / (h - 1);
    rows[row] = clampInset(insetRatio(shape, t) * w, w);
  }
  cache.set(key, rows);
  return rows;
}

/** 条纹行带高度占比（每带行数 = max(2, h/8)）。 */
const STRIPE_BANDS = 8;

/**
 * 绘制形状身体。纯色 box 退化为单次整框填充，与现状开销一致。
 *
 * stripeColor 存在时按行带交替两色（条纹纹理）：条纹在逐行填充环节
 * 实现，零额外绘制调用；行带高度随身体尺寸缩放，小尺寸下不至于糊成
 * 渐变。斑点纹理由 patterns.ts 的 drawSpots 在本函数之后叠加。
 */
export function drawBody(
  ctx: CanvasRenderingContext2D,
  shape: BodyShape,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  stripeColor?: string,
): void {
  if (shape === "box" && !stripeColor) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    return;
  }
  const bandH = Math.max(2, Math.round(h / STRIPE_BANDS));
  const insets = rowInsets(shape, w, h);
  for (let row = 0; row < h; row++) {
    const inset = insets[row];
    ctx.fillStyle =
      stripeColor && Math.floor(row / bandH) % 2 === 1 ? stripeColor : color;
    ctx.fillRect(x + inset, y + row, w - 2 * inset, 1);
  }
}
