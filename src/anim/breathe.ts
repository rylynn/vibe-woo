/**
 * 返回呼吸缩放系数，围绕 1.0 上下浮动 amplitude。
 *
 * 用取模而非累加，保证长时间运行不会浮点漂移 —— 宠物要连续跑几小时。
 */
export function breatheScale(
  elapsedMs: number,
  periodMs: number,
  amplitude: number,
): number {
  const phase = (elapsedMs % periodMs) / periodMs;
  return 1 + amplitude * Math.sin(phase * Math.PI * 2);
}
