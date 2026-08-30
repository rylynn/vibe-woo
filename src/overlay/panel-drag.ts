/**
 * 面板长按拖动。
 *
 * 宠物本体的拖动改 canvas 坐标；而 DOM 面板直接改 left/top 即可。
 * 「长按拖动」的判定：按下后位移超过阈值才算拖动开始 ——
 * 纯点击（比如误碰标题栏）不移动面板，也不会打断其他交互。
 *
 * 与宠物拖动相同的健壮性要求：不依赖 pointerup（nonactivating panel
 * 可能漏发），buttons === 0 即结束。
 */
export function enablePanelDrag(
  panel: HTMLElement,
  handleSelector: string,
): void {
  panel.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    // 只有标题栏（把手）能拖；面板内控件各自的交互不受影响
    const target = e.target instanceof Element ? e.target : null;
    if (!target?.closest(handleSelector)) return;
    if (target.closest("button, input, select, textarea, a")) return;
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const rect = panel.getBoundingClientRect();
    let dragging = false;

    const onMove = (ev: PointerEvent): void => {
      // 兜底：所有键已松开时无论是否收到 up 都结束
      if (ev.buttons === 0) {
        cleanup();
        return;
      }
      if (!dragging) {
        if (Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) {
          return; // 未超过阈值，仍视为点击
        }
        dragging = true;
        // 摆脱 CSS 居中 transform，切换为显式坐标
        panel.style.transform = "none";
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.right = "auto";
        panel.style.bottom = "auto";
      }
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      const left = Math.max(
        0,
        Math.min(window.innerWidth - w, rect.left + ev.clientX - startX),
      );
      const top = Math.max(
        0,
        Math.min(window.innerHeight - h, rect.top + ev.clientY - startY),
      );
      panel.style.left = `${Math.round(left)}px`;
      panel.style.top = `${Math.round(top)}px`;
    };

    const cleanup = (): void => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
  });
}
