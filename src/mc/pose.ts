// src/mc/pose.ts
/**
 * MC 姿态量化：连续的行为/表情输入 → 整数档位的关节姿态（纯函数）。
 *
 * 像素完美的代价是一切连续量必须量化：头部转向 7 档、俯仰 3 档、
 * 呼吸 3 档、四肢摆动 8 相位 × 3 档位移。档位刻度即视觉刻度——
 * 相邻两帧的姿态要么完全相同（跳帧），要么差整整一档（无亚像素抖动）。
 *
 * 偶数偏移原则：所有关节位移（swing/breath/spread/raise）都是偶数——
 * 投影按 1.5m px/单位缩放，偶数保证屏幕顶点整数（见 project.ts 头注）。
 */
import type { Motion } from "../anim/behavior";
import type { EyeFrame } from "../anim/expression";

/** 状态色调（与 Appearance.tint / applyTint 的取值一致）。 */
export type McTint = "normal" | "focused" | "dim";

/** 一帧的完整量化姿态。 */
export interface McPose {
  /** 头部水平转向 −3..3（7 档，~15°/档；贴图窗口位移实现，不转几何）。 */
  headYaw: number;
  /** 头部俯仰 −1..1（不转几何，只并入眼部行偏移）。 */
  headPitch: number;
  /** 四肢摆动相位 0..7（位移档见 project.ts 的 SWING）。 */
  limbPhase: number;
  /** 呼吸档 −1..1（站立：头 dy ±2；躺平：头 dz 只抬不沉）。 */
  breath: number;
  /** 双臂上举（伸懒腰，臂盒上移 12 并翻转贴图）。 */
  armsUp: boolean;
  /** 双臂侧向张开（小跳）。 */
  armsSpread: boolean;
  /** 躺平（睡眠）。 */
  lying: boolean;
  /** 屏幕镜像（朝左）。 */
  mirrored: boolean;
  /** 状态色调（绘制时选三张预生成皮肤画布之一）。 */
  tint: McTint;
  /** 深夜疲惫（眼部画黑眼圈）。 */
  tired: boolean;
}

/** 姿态驱动输入（pet.draw 与形象预览各自组装）。 */
export interface McPoseInput {
  motion: Motion;
  /** 动作进度 0..1。 */
  actPhase: number;
  /** 面朝方向，−1 左 / 1 右。 */
  facing: number;
  nowMs: number;
  breathePeriodMs: number;
  asleep: boolean;
  /** 视线 −1..1（屏幕语义：正 = 看向右侧 / 下方）。 */
  gazeX: number;
  gazeY: number;
  tint: McTint;
  tired: boolean;
}

/** 静态站立（M1 兼容默认 / 证件照 / 未传姿态时的兜底）。 */
export function mcRestPose(): McPose {
  return {
    headYaw: 0,
    headPitch: 0,
    limbPhase: 0,
    breath: 0,
    armsUp: false,
    armsSpread: false,
    lying: false,
    mirrored: false,
    tint: "normal",
    tired: false,
  };
}

/** 呼吸三档：sin 过 ±0.33 阈值切换。纯时间函数，确定性可测。 */
export function breathStep(nowMs: number, periodMs: number): number {
  const s = Math.sin((nowMs / periodMs) * Math.PI * 2);
  return s > 0.33 ? 1 : s < -0.33 ? -1 : 0;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 行为/表情输入 → 量化姿态。无副作用、无 DOM，node 可测。 */
export function mcPose(inp: McPoseInput): McPose {
  const breath = breathStep(inp.nowMs, inp.breathePeriodMs);
  if (inp.asleep || inp.motion === "sleep") {
    // 睡眠：躺平（脸朝天、脚朝观察者），只保留呼吸/色调/疲惫
    return { ...mcRestPose(), lying: true, breath, tint: inp.tint, tired: inp.tired };
  }
  const mirrored = inp.facing < 0;
  // 头部转向是屏幕语义：镜像取反（几何 x 翻转会再翻一次，净效果正确）
  const yawRaw = clamp(Math.round(inp.gazeX * 3), -3, 3);
  const headPitch = clamp(Math.round(inp.gazeY), -1, 1);
  let headYaw = mirrored ? -yawRaw : yawRaw;
  let limbPhase = 0;
  let armsUp = false;
  let armsSpread = false;
  switch (inp.motion) {
    case "walk":
      limbPhase = Math.floor(inp.nowMs / 75) % 8;
      break;
    case "held":
      // 被抱起时四肢慢速下垂摆动
      limbPhase = Math.floor(inp.nowMs / 250) % 8;
      break;
    case "hop":
      armsSpread = true;
      break;
    case "stretch":
      // 起手与收手各留 15% 缓冲，避免一闪而过
      armsUp = inp.actPhase > 0.15 && inp.actPhase < 0.85;
      break;
    case "lookaround": {
      // 前半程转向一侧、后半程另一侧；sub 在每半程内走 0..1，
      // sin 弧线让转向加速再减速（量化后是 −3..3 的整数扫过）
      const t = inp.actPhase;
      const sub = t < 0.5 ? t * 2 : (t - 0.5) * 2;
      const screenYaw = Math.round(3 * Math.sin(sub * Math.PI)) * (t < 0.5 ? -1 : 1);
      headYaw = mirrored ? -screenYaw : screenYaw;
      break;
    }
    // idle：全部保持默认
  }
  return {
    headYaw,
    headPitch,
    limbPhase,
    breath,
    armsUp,
    armsSpread,
    lying: false,
    mirrored,
    tint: inp.tint,
    tired: inp.tired,
  };
}

/**
 * MC 帧指纹：相同指纹 ⇒ 本帧逐像素相同，可整帧跳过（不触碰 canvas）。
 * 量化刻度与绘制一致：yaw ×3 / 俯仰与眼行 ×1 / lid ×16。
 * ox/oy/m 入键：锚点或档位变了必须重画。
 */
export function mcFrameKey(
  pose: McPose,
  skinId: string,
  eye: EyeFrame,
  ox: number,
  oy: number,
  m: number,
): string {
  return [
    skinId,
    m,
    ox,
    oy,
    pose.tint,
    pose.tired ? 1 : 0,
    pose.mirrored ? 1 : 0,
    pose.lying ? 1 : 0,
    pose.armsUp ? 1 : 0,
    pose.armsSpread ? 1 : 0,
    pose.headYaw,
    pose.headPitch,
    pose.limbPhase,
    pose.breath,
    eye.shape,
    Math.round(eye.lid * 16),
    Math.round(eye.gazeX * 3),
    Math.round(eye.gazeY),
  ].join("|");
}
