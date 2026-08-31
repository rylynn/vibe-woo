import type { BrowStyle, EyeStyle } from "../avatar/types";
import type { EyeFrame } from "../anim/expression";
import { eyeGeoms, type EyeLayout } from "./eyes";

/**
 * 眉毛渲染。
 *
 * 眉毛是形象的「长相」维度（BrowStyle），但会与表情联动：烦躁（worried）
 * 时整体下压，斜眉内倾加剧 —— 眉压眼是跨文化共通的愤怒信号，零成本
 * 增强表情的可读性。
 *
 * 位置由 eyeGeoms 驱动，与眼睛共享布局，风格切换时不会错位。
 * 全部为整数像素 fillRect，与身体/眼睛同一硬约束。
 */
export function drawBrows(
  ctx: CanvasRenderingContext2D,
  layout: EyeLayout,
  style: BrowStyle,
  frame: EyeFrame,
  color: string,
  eyeStyle: EyeStyle,
): void {
  if (style === "none") return;

  const px = (v: number) => Math.round(v);
  const { left, right } = eyeGeoms(layout, eyeStyle);
  ctx.fillStyle = color;

  const browH = Math.max(1, px(layout.h * 0.03));
  /** 眉与眼之间的留白，太小会糊成一团。 */
  const gapAbove = Math.max(1, px(layout.h * 0.02));
  /** worried 时的下压量。 */
  const press = frame.shape === "worried" ? Math.max(1, px(layout.h * 0.02)) : 0;

  for (const eye of [left, right]) {
    const isLeft = eye === left;
    const browW = Math.max(2, px(eye.w * 0.9));
    const x0 = eye.x + px((eye.w - browW) / 2);
    const topY = px(eye.centerY - eye.h / 2) - gapAbove - browH + press;

    switch (style) {
      case "flat":
        ctx.fillRect(x0, topY, browW, browH);
        break;
      case "bushy": {
        // 加粗加长，向上扩展以保住眉眼间距
        const h = browH * 2;
        ctx.fillRect(
          x0 - px(browW * 0.05),
          topY - (h - browH),
          px(browW * 1.1),
          h,
        );
        break;
      }
      case "slanted": {
        // 倒八（眉心下压）：左眉 \ 、右眉 / ，两段矩形拼出斜率
        const step = Math.max(1, browH) + (press > 0 ? 1 : 0);
        const segW = Math.max(1, px(browW / 2));
        if (isLeft) {
          ctx.fillRect(x0, topY, segW, browH);
          ctx.fillRect(x0 + segW, topY + step, browW - segW, browH);
        } else {
          ctx.fillRect(x0, topY + step, segW, browH);
          ctx.fillRect(x0 + segW, topY, browW - segW, browH);
        }
        break;
      }
      case "arched": {
        // 三段拱形：中段抬高
        const segW = Math.max(1, px(browW / 3));
        const lift = Math.max(1, browH);
        ctx.fillRect(x0, topY + lift, segW, browH);
        ctx.fillRect(x0 + segW, topY, browW - segW * 2, browH);
        ctx.fillRect(x0 + browW - segW, topY + lift, segW, browH);
        break;
      }
    }
  }
}
