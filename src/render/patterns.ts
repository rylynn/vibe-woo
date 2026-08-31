import type { BodyShape } from "../avatar/types";
import type { Box } from "../interact/hit-test";
import { rowInsets } from "./body";

/**
 * 颜色纹理渲染（斑点）。
 *
 * 条纹不需要独立模块：drawBody 逐行填充时按行带交替行色即可（零额外
 * 绘制调用）。斑点在这里：逐行按确定性伪随机决定是否放一块斑点，
 * 位置用轮廓表钳制在身体内。
 *
 * 确定性是硬要求：斑点若每帧重摇，身体会像电视机雪花一样闪。
 */

/** 整数 → 0..1 的确定性伪随机（与 pet.ts 的 pseudoRandom 同一构造）。 */
function hash01(seed: number): number {
  let x = Math.imul(seed | 0, 2654435761);
  x ^= x >>> 13;
  x = Math.imul(x, 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/** 每行出现斑点的概率。 */
const SPOT_ROW_CHANCE = 0.32;

/**
 * 在身体上叠加斑点。种子混入颜色值，不同形象的斑点分布不同；
 * 同参数多次调用结果完全一致（测试与每帧渲染都依赖这一点）。
 */
export function drawSpots(
  ctx: CanvasRenderingContext2D,
  shape: BodyShape,
  box: Box,
  color: string,
): void {
  const insets = rowInsets(shape, box.w, box.h);
  let seedBase = 0;
  for (let i = 0; i < color.length; i++) {
    seedBase += color.charCodeAt(i) * (i + 1);
  }

  ctx.fillStyle = color;
  // 上下各留 2 行：斑点贴边会弄脏轮廓的读形
  for (let row = 2; row < box.h - 2; row++) {
    if (hash01(seedBase + row * 7919) >= SPOT_ROW_CHANCE) continue;
    const inset = insets[row];
    const innerW = box.w - 2 * inset;
    if (innerW < 8) continue;
    const spotW = 2 + Math.floor(hash01(seedBase + row * 104729) * 3);
    const spotX =
      inset + Math.floor(hash01(seedBase + row * 15485863) * (innerW - spotW));
    ctx.fillRect(box.x + spotX, box.y + row, spotW, 2);
  }
}
