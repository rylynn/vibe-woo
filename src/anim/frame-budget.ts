/**
 * 宠物活跃度档位。直接决定渲染帧率，是「空闲 CPU < 1%」这条硬指标的实现基础。
 *
 * 档位再叠加「无变化跳帧」（pet.ts 的视觉指纹）：不到档位间隔不绘制，
 * 到了间隔但画面逐像素不变也跳过 —— 实际触碰 canvas 的频率远低于名义帧率。
 * 眨眼（180ms）与走动会临时提到 active 档，流畅度不受低档影响。
 */
export type PetActivity = "sleep" | "idle" | "active";

const TARGET_FPS: Record<PetActivity, number> = {
  sleep: 2,
  idle: 8,
  active: 30,
};

export function frameIntervalMs(activity: PetActivity): number {
  return 1000 / TARGET_FPS[activity];
}

/** 距上次绘制是否已达当前档位的帧间隔。 */
export function shouldRender(
  nowMs: number,
  lastRenderMs: number,
  activity: PetActivity,
): boolean {
  return nowMs - lastRenderMs >= frameIntervalMs(activity);
}
