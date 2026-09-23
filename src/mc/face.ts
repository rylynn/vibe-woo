// src/mc/face.ts
/**
 * MC 头正面眼部表情覆盖（纯函数 + 薄绘制层）。
 *
 * 皮肤自带的眼睛画在头正面贴图上，我们用程序化眼型覆盖它：
 * EyeFrame（参数形象同源的 8 眼型 + lid + 视线）映射到 8×8 正脸
 * 窗口局部坐标。关键不变量：覆盖像素列 c = baseCol + dx + gx − yaw，
 * 皮肤眼睛随窗口滑动，−yaw 项恰好抵消 ⇒ 静止时覆盖永远精确盖住
 * 皮肤眼睛（无重影），gx 让它相对脸部 ±1 移动即视线。
 * 纵向 gy = clamp(round(gazeY)) + headPitch（注视与俯仰同向叠加，
 * 合计 ±2 行，保证可读）。
 *
 * 绘制用整数设备矩形 fillRect，绝不用 setTransform——奇数 m 下
 * 变换内 fillRect 是 1.5px 宽的小数矩形，canvas 会抗锯齿出半透明
 * 像素（零半透明红线）。每像素取 (c,r) 与 (c+1,r+1) 两角圆整到
 * 设备空间再取 min/max，与 drawImage 的最近邻采样同样无混合。
 */
import type { EyeFrame, EyeShape } from "../anim/expression";
import { EYE_COLOR } from "../render/eyes";
import type { McPose } from "./pose";
import type { McFace } from "./project";

/** 瞳色（与参数形象同源）；高光；疲惫眼袋。 */
const EYE_DARK: string = EYE_COLOR;
export const EYE_LIGHT = "#f0f2f8";
export const EYEBAG = "#3d4a66";

/** 眼型像素（单眼、baseCol 相对）。round 2×2 起，wide 最宽 4 列。 */
const PATTERNS: Record<EyeShape, [number, number][]> = {
  round: [[0, 0], [1, 0], [0, 1], [1, 1]],
  wide: [[-1, 0], [0, 0], [1, 0], [2, 0], [-1, 1], [0, 1], [1, 1], [2, 1], [0, 2], [1, 2]],
  squint: [[0, 1], [1, 1]],
  half: [[0, 0], [0, 1], [1, 1]],
  happy: [[0, 2], [2, 2], [0, 3], [1, 3], [2, 3]],
  worried: [[0, 2], [1, 1], [2, 0]],
  droopy: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]],
  closed: [[0, 1], [1, 1]],
};

/** 双眼基准列（窗口局部）与基准行。 */
const EYE_BASE_COLS = [2, 5] as const;
const EYE_BASE_ROW = 4;
/** 眼袋行距基准行的偏移。 */
const BAG_DY = 2;

/** 眼部覆盖像素（头正面 8×8 窗口局部坐标）。 */
export type McEyePixel = { c: number; r: number; color: string };

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** EyeFrame + 姿态 → 覆盖像素（纯函数）。 */
export function mcEyePixels(frame: EyeFrame, pose: McPose): McEyePixel[] {
  const pattern = PATTERNS[frame.shape];
  const H = Math.max(...pattern.map(([, dy]) => dy)) + 1;
  // 眨眼自上而下收：只保最底 visible 行（至少 1 行，闭眼是一条线）
  const visible = Math.max(1, Math.ceil(H * (1 - frame.lid)));
  const gx = clamp(Math.round(frame.gazeX), -1, 1) * (pose.mirrored ? -1 : 1);
  const gy = clamp(Math.round(frame.gazeY), -1, 1) + pose.headPitch;
  const out: McEyePixel[] = [];
  for (const baseCol of EYE_BASE_COLS) {
    for (const [dx, dy] of pattern) {
      if (dy < H - visible) continue; // 上部行被眼睑盖住
      const c = baseCol + dx + gx - pose.headYaw;
      const r = EYE_BASE_ROW + dy + gy;
      if (c < 0 || c > 7 || r < 0 || r > 7) continue; // 越窗丢弃
      out.push({ c, r, color: EYE_DARK });
    }
  }
  // 眼袋（tired）：紧贴眼下，随 −yaw 贴住脸部、不随 gx（不是视线）
  if (pose.tired) {
    for (const baseCol of EYE_BASE_COLS) {
      for (let i = 0; i < 2; i++) {
        const c = baseCol + i - pose.headYaw;
        const r = EYE_BASE_ROW + BAG_DY + gy;
        if (c < 0 || c > 7 || r < 0 || r > 7) continue;
        out.push({ c, r, color: EYEBAG });
      }
    }
  }
  // 高光：左眼（窗口右半）最上左一颗；眯眼/笑眼不点（无眼白可言）
  if (visible >= 2 && frame.shape !== "happy" && frame.shape !== "worried") {
    const leftEye = out.filter((p) => p.color === EYE_DARK && p.c >= 4);
    if (leftEye.length > 0) {
      const light = leftEye.reduce((a, b) => (b.r < a.r || (b.r === a.r && b.c < a.c) ? b : a));
      light.color = EYE_LIGHT;
    }
  }
  return out;
}

/** 在头正面（基础 front 面）上覆盖眼部：整数设备矩形 fillRect。 */
export function drawMcEyes(
  ctx: CanvasRenderingContext2D,
  faces: McFace[],
  pose: McPose,
  frame: EyeFrame,
): void {
  const face = faces.find((f) => f.box === "head" && f.face === "front" && !f.overlay);
  if (!face) return;
  ctx.globalAlpha = 1;
  for (const p of mcEyePixels(frame, pose)) {
    // (c,r) 与 (c+1,r+1) 两角映射到设备空间；镜像/躺平的 u/v 任意
    // 方向都成立——取 min/max 后圆整，矩形恒整数、无缝隙无重叠。
    const a = {
      x: face.o.x + face.u.x * p.c + face.v.x * p.r,
      y: face.o.y + face.u.y * p.c + face.v.y * p.r,
    };
    const b = {
      x: face.o.x + face.u.x * (p.c + 1) + face.v.x * (p.r + 1),
      y: face.o.y + face.u.y * (p.c + 1) + face.v.y * (p.r + 1),
    };
    const x0 = Math.round(Math.min(a.x, b.x));
    const x1 = Math.round(Math.max(a.x, b.x));
    const y0 = Math.round(Math.min(a.y, b.y));
    const y1 = Math.round(Math.max(a.y, b.y));
    ctx.fillStyle = p.color;
    ctx.fillRect(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0));
  }
}
