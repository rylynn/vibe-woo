import { invoke } from "@tauri-apps/api/core";
import type { Box } from "../interact/hit-test";
import { panelChrome } from "../overlay/chrome";
import { getPluginFrontend, type CardHost } from "./registry";

/** plugin_summary 命令的返回项（与 Rust PluginMeta 契约一致）。 */
export interface PluginMeta {
  id: string;
  name: string;
  kind: string;
  summary: unknown;
}

/**
 * 左键插件面板：单击宠物打开，按插件分区展示当日汇总。
 *
 * 设计决策（2026-09-02 设计文档 7.3）：宠物单击从 poke 改为打开本面板；
 * poke 的 400ms 表情反馈保留，作为「点开面板」的即时反馈。
 * 模式照抄 TodayPanel：右下角固定、DismissManager 注册、box 上报参与穿透。
 */
export class PluginHubPanel {
  private readonly el: HTMLDivElement;
  private open = false;
  private readonly host: CardHost;

  constructor(host: CardHost) {
    this.host = host;
    this.el = document.createElement("div");
    this.el.className = "pet-hub";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
  }

  /** 单击宠物时切换开合。 */
  async toggle(): Promise<void> {
    if (this.open) {
      this.hide();
    } else {
      await this.show();
    }
  }

  async show(): Promise<void> {
    let metas: PluginMeta[] = [];
    try {
      metas = await invoke<PluginMeta[]>("plugin_summary");
    } catch {
      // 非 Tauri 环境（纯浏览器调试）
    }
    // 只展示已启用的插件；一个都没启用就不弹窗
    //（单击宠物只剩点一下的表情反馈，不再空转开面板）
    const enabled = metas.filter(
      (m) => !!(m.summary as { enabled?: boolean } | null)?.enabled,
    );
    if (enabled.length === 0) return;

    this.position();
    this.el.style.display = "block";
    this.open = true;
    this.render(enabled);
  }

  hide(): void {
    this.el.style.display = "none";
    this.open = false;
  }

  get isOpen(): boolean {
    return this.open;
  }

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

  private position(): void {
    this.el.style.right = "16px";
    this.el.style.bottom = "60px";
    this.el.style.width = "320px";
  }

  private render(metas: PluginMeta[]): void {
    this.el.replaceChildren();

    const head = panelChrome(this.el, "插件", () => this.hide(), {
      headClass: "pet-hub-head",
    });
    this.el.appendChild(head);

    // show() 已过滤：进到这里的插件都是已启用的
    for (const m of metas) {
      const section = document.createElement("div");
      section.className = "pet-hub-section";
      const head2 = document.createElement("div");
      head2.className = "pet-hub-section-head";
      head2.textContent = m.name;
      section.appendChild(head2);
      // 分区视图由该插件的前端模块渲染；未注册的只显示名字
      const body = getPluginFrontend(m.kind)?.renderSection?.(m.summary, this.host);
      if (body) section.appendChild(body);
      this.el.appendChild(section);
    }
  }
}
