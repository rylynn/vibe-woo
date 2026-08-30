import type { Box } from "../interact/hit-test";

export interface MenuItemSpec {
  label: string;
  onPick: () => void;
}

/**
 * 宠物右键菜单。
 *
 * 为什么用 DOM 而不画在 canvas 上：菜单需要可靠的点击命中与文本渲染，
 * DOM 天然具备。更重要的是 —— 这是用户最主要的退出入口，
 * 必须简单可靠，不能依赖 canvas 命中判定的正确性。
 */
export class ContextMenu {
  private readonly el: HTMLDivElement;
  private open = false;

  constructor(items: MenuItemSpec[]) {
    this.el = document.createElement("div");
    this.el.className = "pet-menu";
    this.el.style.display = "none";

    // 右上角 × 关闭，与点外关闭互补
    const close = document.createElement("button");
    close.className = "pet-menu-close";
    close.textContent = "×";
    close.title = "关闭";
    close.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.hide();
    });
    this.el.appendChild(close);

    for (const item of items) {
      const row = document.createElement("button");
      row.className = "pet-menu-item";
      row.textContent = item.label;
      // 用 pointerdown 而非 click：非 key window 下 click 可能不触发
      row.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this.hide();
        item.onPick();
      });
      this.el.appendChild(row);
    }

    document.body.appendChild(this.el);
  }

  show(x: number, y: number): void {
    this.el.style.display = "block";
    this.el.style.left = "0px";
    this.el.style.top = "0px";
    // 先显示再量尺寸，才能做边界收拢
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const left = Math.min(x, window.innerWidth - w - 4);
    const top = Math.min(y, window.innerHeight - h - 4);
    this.el.style.left = `${Math.max(4, left)}px`;
    this.el.style.top = `${Math.max(4, top)}px`;
    this.open = true;
  }

  hide(): void {
    this.el.style.display = "none";
    this.open = false;
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** 菜单当前占据的区域，供上报给 Rust 以保证可点击。 */
  get box(): Box | null {
    if (!this.open) return null;
    const r = this.el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  contains(px: number, py: number): boolean {
    const b = this.box;
    if (!b) return false;
    return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
  }
}
