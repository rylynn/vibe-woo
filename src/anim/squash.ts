import type { Motion } from "./behavior";

/**
 * 挤压/拉伸形变（squash & stretch）公式。
 *
 * 这是动画的基本功，也是待机动作可读性的主要来源 —— 位移本身很小，
 * 观众感知到的是形状变化。体积近似守恒（宽变窄则高变高）。
 *
 * 抽成纯函数的原因：形象选择弹窗的预览动画（avatar-picker）要与主渲染
 * （pet.ts）呈现完全一致的动作手感，各写一份必然漂移。
 */
export function squashScale(
  motion: Motion,
  actPhase: number,
): { sx: number; sy: number } {
  switch (motion) {
    case "hop":
      // 腾空时略微拉长，符合物理直觉
      return { sx: 0.9, sy: 1.12 };
    case "stretch": {
      // 伸懒腰：先压扁蓄力，再往上抻长
      const t = actPhase;
      const wave = Math.sin(t * Math.PI);
      if (t < 0.35) {
        return { sx: 1 + 0.14 * wave, sy: 1 - 0.12 * wave };
      }
      return { sx: 1 - 0.1 * wave, sy: 1 + 0.18 * wave };
    }
    default:
      // 张望只转头，身体几乎不变；其余动作无形变
      return { sx: 1, sy: 1 };
  }
}
