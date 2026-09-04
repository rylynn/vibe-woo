import { enablePanelDrag } from "./panel-drag";

export interface PanelChromeOptions {
  /** × 悬浮提示，默认「关闭」。 */
  closeTitle?: string;
  /** 标题栏类名（各面板 CSS 独立定型），默认 "pet-settings-head"。 */
  headClass?: string;
  /** 提供时左侧出现返回按钮（设置面板二级/三级页用）。 */
  back?: () => void;
  backLabel?: string;
}

/**
 * 统一面板标题栏：标题 + 返回（可选）+ × 关闭，并给面板接上长按拖动。
 *
 * 七个持久面板共用（2026-09-03 spec 设计三）——「所有窗口理论都可拖拽、
 * 都配关闭按钮」从此在构建期保证，新面板不再手抄关闭按钮代码。
 *
 * 拖拽只挂一次（dataset 哨兵）：面板每次 render 重建 head，若重复挂
 * 监听器会叠加多个拖拽 handler，一次 pointermove 挪多步。
 */
export function panelChrome(
  panel: HTMLElement,
  title: string,
  onClose: () => void,
  opts: PanelChromeOptions = {},
): HTMLElement {
  const head = document.createElement("div");
  head.className = opts.headClass ?? "pet-settings-head";
  if (opts.back) {
    const back = document.createElement("button");
    back.className = "pet-settings-back";
    back.textContent = opts.backLabel ?? "‹ 返回";
    back.title = "返回上一页";
    back.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      opts.back?.();
    });
    head.appendChild(back);
  }
  const t = document.createElement("span");
  t.textContent = title;
  const x = document.createElement("button");
  x.className = "pet-panel-close";
  x.textContent = "×";
  x.title = opts.closeTitle ?? "关闭";
  x.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    onClose();
  });
  head.append(t, x);
  if (panel.dataset.petChromeDrag !== "1") {
    enablePanelDrag(panel, `.${head.className.split(" ")[0]}`);
    panel.dataset.petChromeDrag = "1";
  }
  return head;
}
