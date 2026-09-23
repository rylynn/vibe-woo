// src/mc/figure.ts
/**
 * MC 形态完整绘制（与参数形象 drawAvatarFigure 同地位的入口）。
 *
 * 倍率取 48px 整数倍（对齐 SIZE_STEPS 档位）；锚点在盒底中心。
 * 姿态缺省 rest（证件照 / 未传时）；皮肤按 pose.tint 查三画布之一，
 * 眼部覆盖画在头正面上。脏矩形改为投影推导——任何姿态（摆动/
 * 举臂/躺平/镜像）都是同一套面角点外接盒，不再维护常量表。
 */
import type { EyeFrame } from "../anim/expression";
import type { Box } from "../interact/hit-test";
import type { McAvatar } from "../avatar/types";
import { drawMcEyes } from "./face";
import { modelForForm, PLAYER_MODEL } from "./model";
import { mcRestPose, type McPose } from "./pose";
import { projectModel, type McFace } from "./project";
import { drawMcFaces } from "./render";
import type { McSkinResources } from "./skin-registry";
import { hasOpaquePixels, type SkinData } from "./skin";

/** 尺寸倍率：48 的整数倍向下取，最小 1（预览等奇尺寸会略小于槽位）。 */
export function mcScaleFor(boxH: number): number {
  return Math.max(1, Math.floor(boxH / 48 + 0.001));
}

/** 跳过空 overlay 面：典型皮肤袖/裤层全空，省出绘制预算。 */
export function filterEmptyOverlays(faces: McFace[], skin: SkinData): McFace[] {
  return faces.filter((f) => !f.overlay || hasOpaquePixels(skin, f.tex));
}

export function drawMcFigure(
  ctx: CanvasRenderingContext2D,
  full: { bodyX: number; bodyY: number; w: number; h: number },
  avatar: McAvatar,
  frame: EyeFrame,
  res: McSkinResources,
  pose: McPose = mcRestPose(),
): void {
  const m = mcScaleFor(full.h);
  const ox = Math.round(full.bodyX + full.w / 2);
  const oy = Math.round(full.bodyY + full.h);
  const faces = filterEmptyOverlays(
    projectModel(modelForForm(avatar.form), pose, { m, ox, oy }),
    res.skin,
  );
  drawMcFaces(ctx, faces, res.canvases[pose.tint]);
  drawMcEyes(ctx, faces, pose, frame);
}

/**
 * MC 形态屏幕外接盒（脏矩形）：投影全部面角点取 min/max，各留
 * 1px 余量。呼吸/摆动/举臂/躺平/镜像都由同一推导覆盖——比 M1
 * 常量表多花的几次乘加远小于一次多余的整块重绘。
 */
export function mcDirtyBounds(ox: number, oy: number, m: number, pose: McPose = mcRestPose()): Box {
  // M3 约束：这里硬编码 PLAYER_MODEL（当前唯一模型，而 drawMcFigure 走
  // modelForForm）。M3 引入第二个模型后必须改为按 form 取模型（两处
  // 同源），否则脏矩形按错误模型的投影推导。
  const faces = projectModel(PLAYER_MODEL, pose, { m, ox, oy });
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const f of faces) {
    for (const [c, r] of [[0, 0], [f.tex.sw, 0], [0, f.tex.sh], [f.tex.sw, f.tex.sh]] as const) {
      const x = f.o.x + f.u.x * c + f.v.x * r;
      const y = f.o.y + f.u.y * c + f.v.y * r;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const x0 = Math.floor(minX) - 1;
  const y0 = Math.floor(minY) - 1;
  return { x: x0, y: y0, w: Math.ceil(maxX) + 1 - x0, h: Math.ceil(maxY) + 1 - y0 };
}
