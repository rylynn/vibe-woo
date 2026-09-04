// @vitest-environment happy-dom
// 仅本文件需要 DOM（panelChrome 造 DOM 节点）；其余测试保持 node 环境零开销。
import { describe, it, expect, vi } from "vitest";
import { panelChrome } from "../src/overlay/chrome";

describe("panelChrome", () => {
  it("构建标题栏：类名默认 pet-settings-head，含标题与 ×", () => {
    const panel = document.createElement("div");
    const head = panelChrome(panel, "测试面板", () => {});
    expect(head.className).toBe("pet-settings-head");
    expect(head.textContent).toContain("测试面板");
    expect(head.querySelector("button.pet-panel-close")).toBeTruthy();
  });

  it("点 × 触发 onClose 且阻止冒泡", () => {
    const panel = document.createElement("div");
    const onclose = vi.fn();
    const head = panelChrome(panel, "测试", onclose);
    const x = head.querySelector("button.pet-panel-close")!;
    const ev = new PointerEvent("pointerdown", { bubbles: true });
    const stop = vi.spyOn(ev, "stopPropagation");
    x.dispatchEvent(ev);
    expect(onclose).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalled();
  });

  it("opts.back 提供时出现返回按钮，点击触发", () => {
    const panel = document.createElement("div");
    const back = vi.fn();
    const head = panelChrome(panel, "测试", () => {}, { back });
    const b = head.querySelector("button.pet-settings-back");
    expect(b).toBeTruthy();
    b!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(back).toHaveBeenCalledOnce();
  });

  it("自定义 headClass 与 closeTitle 生效", () => {
    const panel = document.createElement("div");
    const head = panelChrome(panel, "测试", () => {}, {
      headClass: "pet-hub-head",
      closeTitle: "稍后再选",
    });
    expect(head.className).toBe("pet-hub-head");
    expect(head.querySelector<HTMLButtonElement>("button.pet-panel-close")!.title).toBe("稍后再选");
  });

  it("重复调用只挂一次拖拽（dataset 哨兵）", () => {
    const panel = document.createElement("div");
    panelChrome(panel, "a", () => {});
    panelChrome(panel, "b", () => {});
    expect(panel.dataset.petChromeDrag).toBe("1");
  });
});
