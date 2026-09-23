// src/mc/figure.ts
/**
 * MC 形态完整绘制（与参数形象 drawAvatarFigure 同地位的入口）。
 *
 * 倍率取 48px 整数倍（对齐 SIZE_STEPS 档位）；锚点在盒底中心。
 * M1 姿态为静态站立，frame 暂不参与绘制——M2 的眼部表情覆盖
 * 画在头正面上（正面零畸变是其前提）。
 */
import type { EyeFrame } from "../anim/expression";
import type { Box } from "../interact/hit-test";
import type { McAvatar } from "../avatar/types";
import { modelForForm } from "./model";
import { projectModel, type McFace } from "./project";
import { mcRestPose } from "./pose";
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
  _frame: EyeFrame,
  res: McSkinResources,
): void {
  const m = mcScaleFor(full.h);
  const ox = Math.round(full.bodyX + full.w / 2);
  const oy = Math.round(full.bodyY + full.h);
  const faces = filterEmptyOverlays(
    projectModel(modelForForm(avatar.form), mcRestPose(), { m, ox, oy }),
    res.skin,
  );
  drawMcFaces(ctx, faces, res.canvases.normal);
}

/**
 * MC 形态屏幕外接盒（脏矩形）：宽 32m（±16m），高 51m
 * （顶面剪切上浮 2m + 身高 48m + 脚部下探 1m），各留 1px 余量。
 */
export function mcDirtyBounds(ox: number, oy: number, m: number): Box {
  return {
    x: ox - 16 * m - 1,
    y: oy - 50 * m - 1,
    w: 32 * m + 2,
    h: 51 * m + 2,
  };
}
