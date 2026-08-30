import type { Box } from "../interact/hit-test";

/** 参与点外关闭的面板。 */
export interface Dismissable {
  isOpen: boolean;
  hide(): void;
  box: Box | null;
}

/**
 * 点击面板之外的任意区域即关闭。
 *
 * 这是几乎所有桌面应用的通用直觉（菜单、下拉、弹窗都是这样）。
 * 曾有两处面板只能靠 Esc 或 × 关闭，反馈「没法关」。
 *
 * 实现要点：
 *   - 只处理 pointerdown，不处理 pointerup —— 按下即关，避免拖选时误关
 *   - 点在任一打开的面板内部不算「外」，不关闭
 *   - 点在宠物身上不算「外」，那是正常交互
 */
export class DismissManager {
  private panels: Dismissable[] = [];
  private petBox: (() => Box | null) | null = null;

  register(panel: Dismissable): void {
    this.panels.push(panel);
  }

  /** 宠物身体的取址，点击宠物不算「面板之外」。 */
  setPetBox(get: () => Box | null): void {
    this.petBox = get;
  }

  handlePointerDown(px: number, py: number): void {
    const anyOpen = this.panels.some((p) => p.isOpen);
    if (!anyOpen) return;

    const petBox = this.petBox?.();
    if (petBox && inside(px, py, petBox)) return;

    for (const p of this.panels) {
      if (!p.isOpen) continue;
      const b = p.box;
      if (b && inside(px, py, b)) continue;
      p.hide();
    }
  }
}

function inside(px: number, py: number, b: Box): boolean {
  return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
}
