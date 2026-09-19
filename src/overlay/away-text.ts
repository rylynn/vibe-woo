/**
 * 出门状态文案（纯函数，供右下角出门图标使用）。
 *
 * 串门（8 分钟）显示剩余分钟；碰一碰（45 秒）本来就短，固定一句。
 * 旧版事件没有 kind 字段 —— 兼容成「不在家」。
 */
export function formatAwayText(
  kind: "visit" | "bump" | undefined,
  nick: string | undefined,
  remainSecs: number,
): string {
  if (kind === "bump" && nick) return `🐾 碰了碰 ${nick}，马上回来`;
  if (kind === "visit" && nick) {
    if (remainSecs >= 60) {
      return `🐾 在 ${nick} 家 · 还剩 ${Math.ceil(remainSecs / 60)} 分钟`;
    }
    return `🐾 在 ${nick} 家 · 马上回来`;
  }
  return "🐾 不在家";
}
