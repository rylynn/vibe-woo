/**
 * 宠物活跃度档位。直接决定渲染帧率，是「空闲 CPU < 1%」这条硬指标的实现基础。
 */
export type PetActivity = "sleep" | "idle" | "active";

const TARGET_FPS: Record<PetActivity, number> = {
  sleep: 4,
  idle: 12,
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
