import type { EyeFrame } from "../anim/expression";
import type { EyeStyle } from "../avatar/types";

/**
 * 眼球深色。所有形象通用：深底浅睛才有对比度，让高光与视线可读。
 * 定义在这里而非 pet.ts：形象选择弹窗的预览渲染也需要它。
 */
export const EYE_COLOR = "#0b1020";

/** 一双眼睛的绘制参数，全部为 CSS 像素。 */
export interface EyeLayout {
  /** 宠物身体左上角。 */
  bodyX: number;
  bodyY: number;
  /** 身体宽高（形变后，可能不相等）。 */
  w: number;
  h: number;
}

export interface EyePalette {
  iris: string;
  /** 高光点颜色，让眼睛有神。 */
  catchlight: string;
  /** 黑眼圈颜色，null 表示不画。 */
  eyebag: string | null;
}

/**
 * 眼睛风格的比例参数（相对身体宽高）。
 *
 * 刻意做得很大（NOMI 取向）：眼睛是唯一的情绪载体，小眼睛表达不了任何
 * 细微变化。原实现只有 side/12，形变根本看不见。
 *
 * 风格是「长相」维度，与 EyeShape「表情」维度正交：风格定基础比例，
 * 表情形变（drawOneEye 里的 switch）照旧在其上叠加。
 */
interface EyeSpec {
  /** 眼宽 / 身体宽。 */
  wR: number;
  /** 眼高 / 身体高。 */
  hR: number;
  /** 两眼内侧间距 / 身体宽。 */
  gapR: number;
  /** 眼睛中心垂直位置 / 身体高。 */
  cyR: number;
  /** 眼球可移动范围 / 眼睛尺寸。 */
  gaze: number;
}

const EYE_SPECS: Record<EyeStyle, EyeSpec> = {
  classic: { wR: 0.22, hR: 0.28, gapR: 0.16, cyR: 0.44, gaze: 0.22 },
  big: { wR: 0.27, hR: 0.34, gapR: 0.13, cyR: 0.44, gaze: 0.2 },
  dot: { wR: 0.13, hR: 0.15, gapR: 0.22, cyR: 0.44, gaze: 0.3 },
  almond: { wR: 0.29, hR: 0.17, gapR: 0.15, cyR: 0.44, gaze: 0.18 },
  sleepy: { wR: 0.22, hR: 0.2, gapR: 0.16, cyR: 0.46, gaze: 0.22 },
};

/** 单只眼睛的几何：左上角 x、宽高、中心 y。 */
export interface EyeGeom {
  x: number;
  w: number;
  centerY: number;
  h: number;
}

/**
 * 计算一双眼睛的几何布局。
 *
 * 抽成独立纯函数的原因：眉毛（brows.ts）必须与眼睛共用同一份布局结果，
 * 各算各的会在风格切换时错位。
 */
export function eyeGeoms(
  layout: EyeLayout,
  style: EyeStyle,
): { left: EyeGeom; right: EyeGeom } {
  const { bodyX, bodyY, w: bodyW, h: bodyH } = layout;
  const px = (v: number) => Math.round(v);
  const spec = EYE_SPECS[style];

  // 眼睛尺寸跟随身体形变：身体被压扁时眼睛也该压扁，否则会「戳出来」
  const w = Math.max(3, px(bodyW * spec.wR));
  const h = Math.max(3, px(bodyH * spec.hR));
  const gap = Math.max(2, px(bodyW * spec.gapR));
  const centerY = bodyY + px(bodyH * spec.cyR);
  const centerX = bodyX + px(bodyW / 2);

  // 右眼由左眼严格镜像得出，避免 gap/2 的取整破坏对称（画在脸上会歪）
  const leftX = px(centerX - gap / 2 - w);
  return {
    left: { x: leftX, w, centerY, h },
    right: { x: bodyX * 2 + bodyW - leftX - w, w, centerY, h },
  };
}

/**
 * 绘制一双像素眼。
 *
 * 全部用 fillRect 拼接，保证每个像素 alpha 为 1（见设计文档 3.1.4），
 * 且不产生任何模糊边缘。
 */
export function drawEyes(
  ctx: CanvasRenderingContext2D,
  layout: EyeLayout,
  frame: EyeFrame,
  palette: EyePalette,
  style: EyeStyle = "classic",
): void {
  const px = (v: number) => Math.round(v);
  const spec = EYE_SPECS[style];
  const { left, right } = eyeGeoms(layout, style);

  const travelX = px(left.w * spec.gaze);
  const travelY = px(left.h * spec.gaze);
  const dx = px(frame.gazeX * travelX);
  const dy = px(frame.gazeY * travelY);

  for (const eye of [left, right]) {
    drawOneEye(ctx, eye.x + dx, eye.centerY + dy, eye.w, eye.h, frame, palette);
  }
}

function drawOneEye(
  ctx: CanvasRenderingContext2D,
  x: number,
  centerY: number,
  w: number,
  h: number,
  frame: EyeFrame,
  palette: EyePalette,
): void {
  const px = (v: number) => Math.round(v);

  // 眼型决定基础尺寸与形状
  let ew = w;
  let eh = h;
  switch (frame.shape) {
    case "wide":
      ew = px(w * 1.15);
      eh = px(h * 1.3);
      break;
    case "squint":
      eh = px(h * 0.52);
      break;
    case "half":
      eh = px(h * 0.46);
      break;
    case "closed":
      eh = Math.max(1, px(h * 0.14));
      break;
    case "happy":
      // 月牙：高度不变，渲染时拼出弧形
      break;
    case "worried":
      // 烦躁：略扁，渲染时向内倾
      eh = px(h * 0.72);
      break;
    case "droopy":
      // 无聊：眼皮耷拉下来
      eh = px(h * 0.5);
      break;
    default:
      break;
  }

  // 眨眼：眼皮从上往下压，眼睛下沿固定
  const lidH = px(eh * frame.lid);
  const visibleH = Math.max(frame.shape === "closed" ? 1 : 0, eh - lidH);

  const bottom = centerY + px(eh / 2);
  const top = bottom - visibleH;

  if (palette.eyebag) {
    const bagH = Math.max(1, px(h * 0.14));
    ctx.fillStyle = palette.eyebag;
    ctx.fillRect(x, bottom + bagH, ew, bagH);
  }

  if (visibleH <= 0) return;

  ctx.fillStyle = palette.iris;

  if (frame.shape === "happy" && frame.lid < 0.5) {
    // 月牙眼：中间低、两侧高，用三段矩形拼出 ∪
    const seg = Math.max(1, px(ew / 3));
    const step = Math.max(1, px(visibleH * 0.35));
    ctx.fillRect(x, top + step, seg, visibleH - step);
    ctx.fillRect(x + seg, top + step * 2, ew - seg * 2, visibleH - step * 2);
    ctx.fillRect(x + ew - seg, top + step, seg, visibleH - step);
    return;
  }

  if (frame.shape === "worried" && frame.lid < 0.5) {
    // 烦躁眼：外侧低、内侧高，用两段矩形拼出 / 形（皱眉感）
    const seg = Math.max(1, px(ew / 2));
    const step = Math.max(1, px(visibleH * 0.3));
    ctx.fillRect(x, top + step, seg, visibleH - step);
    ctx.fillRect(x + seg, top, ew - seg, visibleH);
    return;
  }

  if (frame.shape === "droopy" && frame.lid < 0.5) {
    // 无聊眼：眼皮从上方耷拉下来，只露下缘一截
    const lid = Math.max(1, px(visibleH * 0.55));
    ctx.fillRect(x, top + lid, ew, visibleH - lid);
    return;
  }

  ctx.fillRect(x, top, ew, visibleH);

  // 高光点：眼睛有神的关键。只在睁得够开时显示，否则会糊成一团。
  const showCatchlight =
    visibleH >= Math.max(4, px(eh * 0.6)) &&
    frame.shape !== "closed" &&
    frame.shape !== "half";
  if (!showCatchlight) return;

  const cw = Math.max(1, px(ew * 0.28));
  const chh = Math.max(1, px(visibleH * 0.26));
  ctx.fillStyle = palette.catchlight;
  ctx.fillRect(x + px(ew * 0.18), top + px(visibleH * 0.16), cw, chh);
}
