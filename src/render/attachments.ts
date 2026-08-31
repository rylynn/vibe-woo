import type { Attachment } from "../avatar/types";
import type { Box } from "../interact/hit-test";
import type { EyeLayout } from "./eyes";

/**
 * 特征件渲染：耳朵/尖耳/角/触角。
 *
 * 硬约束与身体一致：全部整数像素 fillRect、alpha=1。
 * 特征件画在 bbox 顶部预留区（cap），绝不超出 bbox —— 这样现有的
 * 脏矩形与 glowBounds 逻辑零改动。
 */

/** 附件区高度占 bbox 的比例。 */
const CAP_RATIO = 0.14;

/**
 * 把 bbox 拆成身体区与附件区。有附件时身体压缩、底部对齐不变
 * （脚不能离地），附件区在顶部。
 */
export function splitBodyBox(
  layout: EyeLayout,
  attachment: Attachment,
): { body: Box; cap: Box | null } {
  if (attachment === "none") {
    return {
      body: { x: layout.bodyX, y: layout.bodyY, w: layout.w, h: layout.h },
      cap: null,
    };
  }
  const capH = Math.max(6, Math.round(layout.h * CAP_RATIO));
  return {
    body: {
      x: layout.bodyX,
      y: layout.bodyY + capH,
      w: layout.w,
      h: layout.h - capH,
    },
    cap: { x: layout.bodyX, y: layout.bodyY, w: layout.w, h: capH },
  };
}

/** 在 bbox 顶部预留区绘制特征件。 */
export function drawAttachments(
  ctx: CanvasRenderingContext2D,
  layout: EyeLayout,
  attachment: Attachment,
  color: string,
): void {
  const { cap } = splitBodyBox(layout, attachment);
  if (!cap) return;

  const px = (v: number) => Math.round(v);
  const mid = cap.x + cap.w / 2;
  const capBottom = cap.y + cap.h;
  ctx.fillStyle = color;

  switch (attachment) {
    case "none":
      return;
    case "ears": {
      // 圆耳：1/4 与 3/4 处的矮宽方块，底部与身体相接
      const earW = px(cap.w * 0.2);
      const earH = px(cap.h * 0.8);
      const y = capBottom - earH;
      const leftX = px(cap.x + cap.w * 0.25 - earW / 2);
      ctx.fillRect(leftX, y, earW, earH);
      ctx.fillRect(px(2 * mid - leftX - earW), y, earW, earH);
      break;
    }
    case "pointy-ears": {
      // 尖耳：三角，从底到顶逐段收窄
      const baseW = px(cap.w * 0.16);
      const segH = Math.max(1, px(cap.h / 3));
      for (const cx of [cap.x + cap.w * 0.25, cap.x + cap.w * 0.75]) {
        for (let s = 0; s < 3; s++) {
          const w = Math.max(1, px(baseW * (1 - s * 0.38)));
          ctx.fillRect(px(cx - w / 2), capBottom - (s + 1) * segH, w, segH);
        }
      }
      break;
    }
    case "horns": {
      // 角：贴两侧边缘的尖锥，逐段收窄
      const baseW = Math.max(3, px(cap.w * 0.08));
      const segH = Math.max(1, px(cap.h / 3));
      for (const leftSide of [true, false]) {
        for (let s = 0; s < 3; s++) {
          const w = Math.max(1, px(baseW * (1 - s * 0.3)));
          const x = leftSide ? cap.x : cap.x + cap.w - w;
          ctx.fillRect(px(x), capBottom - (s + 1) * segH, w, segH);
        }
      }
      break;
    }
    case "antenna": {
      // 触角：居中细杆 + 顶端珠子（珠子略宽，是「昆虫感」的来源）
      const rodW = Math.max(1, px(cap.w * 0.03));
      const rodH = px(cap.h * 0.7);
      ctx.fillRect(px(mid - rodW / 2), capBottom - rodH, rodW, rodH);
      const bead = Math.max(2, px(cap.w * 0.06));
      ctx.fillRect(px(mid - bead / 2), capBottom - rodH - bead + 1, bead, bead);
      break;
    }
  }
}
