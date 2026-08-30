import type { EyeFrame } from "../anim/expression";

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
 * 眼睛占身体的比例。
 *
 * 刻意做得很大（NOMI 取向）：眼睛是唯一的情绪载体，小眼睛表达不了任何
 * 细微变化。原实现只有 side/12，形变根本看不见。
 */
const EYE_W_RATIO = 0.22;
const EYE_H_RATIO = 0.28;
/** 两眼内侧间距占身体比例。 */
const EYE_GAP_RATIO = 0.16;
/** 眼睛中心的垂直位置。 */
const EYE_CENTER_Y_RATIO = 0.44;
/** 眼球可移动范围，占眼睛尺寸的比例。 */
const GAZE_TRAVEL = 0.22;

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
): void {
  const { bodyX, bodyY, w: bodyW, h: bodyH } = layout;
  const px = (v: number) => Math.round(v);

  // 眼睛尺寸跟随身体形变：身体被压扁时眼睛也该压扁，否则会「戳出来」
  const baseW = Math.max(3, px(bodyW * EYE_W_RATIO));
  const baseH = Math.max(3, px(bodyH * EYE_H_RATIO));
  const gap = Math.max(2, px(bodyW * EYE_GAP_RATIO));
  const centerY = bodyY + px(bodyH * EYE_CENTER_Y_RATIO);
  const centerX = bodyX + px(bodyW / 2);

  const travelX = px(baseW * GAZE_TRAVEL);
  const travelY = px(baseH * GAZE_TRAVEL);
  const dx = px(frame.gazeX * travelX);
  const dy = px(frame.gazeY * travelY);

  const leftX = centerX - gap / 2 - baseW + dx;
  const rightX = centerX + gap / 2 + dx;

  for (const x of [px(leftX), px(rightX)]) {
    drawOneEye(ctx, x, centerY + dy, baseW, baseH, frame, palette);
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
