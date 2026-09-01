import type { Box } from "../interact/hit-test";
import { formatAppInfo, getAppInfo, type AppInfo } from "../appinfo";
import { getConfig } from "../config";
import { enablePanelDrag } from "./panel-drag";

/** 署名。与设置面板里原来的那行保持一致。 */
const CREDIT = "power by rylynnxj";

/** 复制成功/失败的提示停留时长。 */
const FLASH_MS = 1600;

/**
 * 「关于」面板：版本、构建信息与账号。
 *
 * 它是设置面板的二级入口 —— 设置底部只留一个按钮，点开才看这些一年也抄不了
 * 几次的信息。独立成一个面板而非内嵌，是为了不让设置面板被一堆只读行撑高。
 *
 * 与设置面板共用 `pet-settings` 的视觉与拖动实现：样式一致，用户不必重新学。
 */
export class AboutPanel {
  private readonly el: HTMLDivElement;
  private open = false;
  private info: AppInfo | null = null;
  private uid = "";
  private registerDate = "";
  /** 从设置面板进入时的「返回设置」回调；直接打开时为 null。 */
  private back: (() => void) | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pet-settings pet-about";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
    enablePanelDrag(this.el, ".pet-settings-head");
  }

  /**
   * 展示关于面板。
   *
   * @param back 传入后头部会出现「返回设置」：从设置进来的才需要回得去，
   *             直接打开的不需要。
   */
  async show(back?: () => void): Promise<void> {
    this.back = back ?? null;
    this.el.style.display = "block";
    this.open = true;
    this.renderLoading();
    // 版本与账号各走一次 IPC，互不依赖，并发取省掉一半等待
    const [info, cfg] = await Promise.all([getAppInfo(), getConfig()]);
    // 载入期间被关掉（Esc / 点外面）就别再渲染了，否则关了又自己弹回来
    if (!this.open) return;
    this.info = info;
    this.uid = cfg.social_uid || "";
    this.registerDate = cfg.social_register_date || "";
    this.render();
  }

  hide(): void {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    this.el.style.display = "none";
    this.open = false;
    this.back = null;
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

  private renderLoading(): void {
    this.el.replaceChildren();
    const head = document.createElement("div");
    head.className = "pet-settings-head";
    const t = document.createElement("span");
    t.textContent = "关于";
    head.appendChild(t);
    this.el.appendChild(head);
    const loading = document.createElement("div");
    loading.className = "pet-settings-hint";
    loading.style.padding = "14px";
    loading.textContent = "载入中…";
    this.el.appendChild(loading);
  }

  private render(): void {
    const info = this.info;
    if (!info) return;

    this.el.replaceChildren();
    this.el.appendChild(this.header());
    this.el.appendChild(this.brand(info));

    this.el.appendChild(this.divider("版本"));
    this.el.appendChild(this.row("构建时间", info.build_time));
    this.el.appendChild(this.row("Git", info.git_hash));
    this.el.appendChild(this.row("平台", info.platform));
    this.el.appendChild(this.row("标识", info.identifier));

    this.el.appendChild(this.divider("账号"));
    this.el.appendChild(this.row("uid", this.uid || "未登录"));
    this.el.appendChild(this.row("注册日期", this.registerDate || "—"));

    this.el.appendChild(this.footer());
  }

  private header(): HTMLElement {
    const h = document.createElement("div");
    h.className = "pet-settings-head";

    const left = document.createElement("div");
    left.className = "pet-about-head-left";
    const goBack = this.back;
    if (goBack) {
      const back = document.createElement("button");
      back.className = "pet-about-back";
      back.textContent = "‹ 返回设置";
      back.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this.hide();
        goBack();
      });
      left.appendChild(back);
    }
    const t = document.createElement("span");
    t.textContent = "关于";
    left.appendChild(t);

    const x = document.createElement("button");
    x.className = "pet-settings-close";
    x.textContent = "×";
    x.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.hide();
    });

    h.append(left, x);
    return h;
  }

  /** 大字的产品名与版本号，旁边是「报障时直接粘走」的复制按钮。 */
  private brand(info: AppInfo): HTMLElement {
    const b = document.createElement("div");
    b.className = "pet-about-brand";

    const name = document.createElement("div");
    name.className = "pet-about-name";
    name.textContent = info.name;

    const line = document.createElement("div");
    line.className = "pet-about-meta";
    const ver = document.createElement("span");
    ver.textContent = `v${info.version} · ${info.profile}`;
    const copy = document.createElement("button");
    copy.className = "pet-bubble-confirm pet-about-copy";
    copy.textContent = "复制版本信息";
    copy.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      void copyText(formatAppInfo(info), copy);
    });
    line.append(ver, copy);

    b.append(name, line);
    return b;
  }

  private divider(text: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "pet-settings-divider";
    d.textContent = text;
    return d;
  }

  /** 只读行。长值（构建时间、标识符）靠 CSS 省略号截断，完整值放 title。 */
  private row(label: string, value: string): HTMLElement {
    const r = document.createElement("div");
    r.className = "pet-settings-row";
    const l = document.createElement("label");
    l.textContent = label;
    const v = document.createElement("span");
    v.className = "pet-about-value";
    v.textContent = value;
    v.title = value;
    r.append(l, v);
    return r;
  }

  private footer(): HTMLElement {
    const f = document.createElement("div");
    f.className = "pet-settings-foot";
    f.textContent = `${CREDIT} · 数据只存在这台电脑上`;
    return f;
  }
}

/** 写入剪贴板。不可用时给出可见反馈，不静默失败。 */
async function copyText(text: string, btn: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    flash(btn, "已复制");
  } catch {
    flash(btn, "复制失败 · 请手抄");
    console.warn("[about] 剪贴板不可用，版本信息：", text);
  }
}

/** 按钮文案临时替换，FLASH_MS 后还原。 */
function flash(btn: HTMLElement, text: string): void {
  const origin = btn.textContent;
  btn.textContent = text;
  window.setTimeout(() => {
    btn.textContent = origin;
  }, FLASH_MS);
}
