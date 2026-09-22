// src/mc/render.ts
/**
 * 面列表 → Canvas 绘制序列。
 *
 * 每个面是一个「起点 + u/v 双向量」的平行四边形：setTransform 把
 * 贴图单位正交坐标系映射到该平行四边形，drawImage 按源矩形贴图。
 * 变换系数全在 0.5 网格（project.ts 保证）、smoothing 关闭
 * （最近邻采样，硬边像素）、globalAlpha 恒 1——运行时零半透明像素。
 */
import type { McFace } from "./project";

export function drawMcFaces(
  ctx: CanvasRenderingContext2D,
  faces: McFace[],
  skin: CanvasImageSource,
): void {
  ctx.imageSmoothingEnabled = false;
  ctx.globalAlpha = 1;
  for (const f of faces) {
    ctx.save();
    ctx.setTransform(f.u.x, f.u.y, f.v.x, f.v.y, f.o.x, f.o.y);
    ctx.drawImage(
      skin,
      f.tex.sx,
      f.tex.sy,
      f.tex.sw,
      f.tex.sh,
      0,
      0,
      f.tex.sw,
      f.tex.sh,
    );
    ctx.restore();
  }
}
