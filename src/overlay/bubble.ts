import type { Box } from "../interact/hit-test";

/**
 * 宠物气泡。
 *
 * 提醒与对话的主要载体（设计决策：两者都做、气泡为主 —— 不打扰）。
 * 出现在宠物上方，跟随宠物移动（渲染循环里每帧同步位置）。
 *
 * 像素风细节：边框与背景纯色、无圆角模糊 —— 但文本用系统字体保证
 * 可读性。气泡尾巴用 CSS 三角形拼在底部。
 */
export class Bubble {
  private readonly el: HTMLDivElement;
  private readonly textEl: HTMLSpanElement;
  private readonly aiEl: HTMLSpanElement;
  private readonly actionsEl: HTMLDivElement;
  private open = false;
  /** 自动消失的定时器。 */
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** 气泡当前跟随的身体区域。 */
  private body: Box | null = null;

  /** 点确认/关闭后的回调。 */
  onDismiss: (() => void) | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pet-bubble";
    this.el.style.display = "none";

    this.textEl = document.createElement("span");
    this.textEl.className = "pet-bubble-text";

    // LLM 来源徽章：默认隐藏，show(ai: true) 时点亮
    this.aiEl = document.createElement("span");
    this.aiEl.className = "pet-bubble-ai";
    this.aiEl.textContent = "AI";
    this.aiEl.style.display = "none";

    this.actionsEl = document.createElement("div");
    this.actionsEl.className = "pet-bubble-actions";

    this.el.append(this.aiEl, this.textEl, this.actionsEl);
    document.body.appendChild(this.el);
  }

  /**
   * 显示气泡。
   * @param text 内容
   * @param opts.confirmLabel 提供「确认」按钮文案则显示按钮（点击消失）；
   *                         不提供则整泡可点、或 autoDismissMs 后自动消失
   * @param opts.ai          内容来自 LLM 时点亮文本前的 AI 徽章
   */
  show(
    text: string,
    opts: {
      confirmLabel?: string;
      autoDismissMs?: number;
      ai?: boolean;
    } = {},
  ): void {
    this.textEl.textContent = text;
    this.aiEl.style.display = opts.ai ? "inline-block" : "none";
    this.actionsEl.replaceChildren();

    if (opts.confirmLabel) {
      const btn = document.createElement("button");
      btn.className = "pet-bubble-confirm";
      btn.textContent = opts.confirmLabel;
      btn.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        this.dismiss();
      });
      this.actionsEl.appendChild(btn);
    }

    if (this.timer) clearTimeout(this.timer);
    if (opts.autoDismissMs) {
      this.timer = setTimeout(() => this.dismiss(), opts.autoDismissMs);
    }

    this.el.style.display = "block";
    this.open = true;
    // 点气泡本身不关闭（避免误触），只有按钮或超时才关
  }

  dismiss(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.el.style.display = "none";
    if (this.open) {
      this.open = false;
      this.onDismiss?.();
    }
  }

  get isOpen(): boolean {
    return this.open;
  }

  /** 渲染循环每帧调用：跟随宠物身体。 */
  follow(body: Box): void {
    if (!this.open) return;
    this.body = body;
    // 先量尺寸再定位（display 已是 block）
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    // 默认在头顶居中，越界时贴边
    const left = Math.max(
      4,
      Math.min(window.innerWidth - w - 4, body.x + body.w / 2 - w / 2),
    );
    const top = body.y - h - 10;
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(top)}px`;
    // 尾巴水平位置跟随气泡相对宠物的偏移
    const tailX = body.x + body.w / 2 - left;
    this.el.style.setProperty("--pet-tail-x", `${Math.round(tailX)}px`);
  }

  get box(): Box | null {
    if (!this.open) return null;
    const r = this.el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  contains(px: number, py: number): boolean {
    const b = this.box;
    return !!b && px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
  }

  /** 供测试：当前跟随的身体。 */
  get followedBody(): Box | null {
    return this.body;
  }
}

/**
 * 右上角通知条（番茄等简单通知）。
 *
 * 与气泡的区别：气泡跟着宠物走、更亲和；通知条固定右上角、
 * 视觉权重更高。简单模式点击整条即消失。
 */
export class Banner {
  private readonly el: HTMLDivElement;
  private open = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pet-banner";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
  }

  show(text: string, time?: string): void {
    this.el.className = "pet-banner";
    this.el.replaceChildren();
    if (time) {
      const t = document.createElement("div");
      t.className = "pet-banner-time";
      t.textContent = time;
      this.el.appendChild(t);
    }
    const body = document.createElement("div");
    body.className = "pet-banner-text";
    body.textContent = text;
    this.el.appendChild(body);
    const hint = document.createElement("div");
    hint.className = "pet-banner-hint";
    hint.textContent = "点击关闭";
    this.el.appendChild(hint);

    // 简单通知：点任意处关闭
    this.el.onclick = () => this.dismiss();

    if (this.timer) clearTimeout(this.timer);
    // 重要提醒也不过期自动关 —— 用户可能刚好不在，回来还要能看到。
    // 但如果 10 分钟还没人理，也别一直挂着
    this.timer = setTimeout(() => this.dismiss(), 10 * 60 * 1000);

    this.el.style.display = "block";
    this.open = true;
  }

  /**
   * 提醒大卡片：时间 + 内容 + 操作（删除 / 稍后再提醒 / 改时间）。
   *
   * 用户需求：提醒触发后能直接处理掉，而不是只能「知道了」。
   * important 只影响配色与图标，操作一致。
   */
  showReminder(
    r: { index: number; text: string; time: string; important: boolean },
    ops: {
      onDelete: (index: number) => Promise<void> | void;
      onSnooze: (index: number) => Promise<void> | void;
      onReschedule: (index: number, time: string) => Promise<void> | void;
    },
  ): void {
    this.el.className = r.important
      ? "pet-banner pet-banner-important"
      : "pet-banner pet-banner-reminder";
    this.el.onclick = null;
    this.el.replaceChildren();

    const head = document.createElement("div");
    head.className = "pet-banner-head";
    const icon = document.createElement("span");
    icon.className = "pet-banner-icon";
    icon.textContent = r.important ? "⏰" : "🔔";
    const tag = document.createElement("span");
    tag.className = "pet-banner-tag";
    tag.textContent = r.important ? "重要提醒" : "每日提醒";
    const time = document.createElement("span");
    time.className = "pet-banner-time";
    time.textContent = r.time;
    head.append(icon, tag, time);
    this.el.appendChild(head);

    const body = document.createElement("div");
    body.className = "pet-banner-text";
    body.textContent = r.text;
    this.el.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "pet-banner-actions";

    const del = document.createElement("button");
    del.className = "pet-banner-btn danger";
    del.textContent = "删除";
    del.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      void ops.onDelete(r.index);
      this.dismiss();
    });

    const snooze = document.createElement("button");
    snooze.className = "pet-banner-btn";
    snooze.textContent = "稍后 10 分钟";
    snooze.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      void ops.onSnooze(r.index);
      this.dismiss();
    });

    const resched = document.createElement("button");
    resched.className = "pet-banner-btn";
    resched.textContent = "改时间";
    resched.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.showRescheduleRow(r, ops);
    });

    actions.append(del, snooze, resched);
    this.el.appendChild(actions);

    if (this.timer) clearTimeout(this.timer);
    // 带操作的卡片不自动过期 —— 用户可能就想留着待办
    this.timer = null;

    this.el.style.display = "block";
    this.open = true;
  }

  /** 改时间展开行：时间输入（带 10 分钟粒度下拉）+ 确定/取消。 */
  private showRescheduleRow(
    r: { index: number; time: string },
    ops: {
      onReschedule: (index: number, time: string) => Promise<void> | void;
    },
  ): void {
    const old = this.el.querySelector(".pet-banner-resched");
    old?.remove();

    const row = document.createElement("div");
    row.className = "pet-banner-resched";

    const input = document.createElement("input");
    input.type = "text";
    input.value = r.time;
    input.spellcheck = false;
    input.setAttribute("list", "pet-reminder-times");
    input.addEventListener("keydown", (e) => e.stopPropagation());

    const ok = document.createElement("button");
    ok.className = "pet-banner-btn primary";
    ok.textContent = "确定";
    ok.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const v = input.value.trim();
      if (!/^([01]?\d|2[0-3]):[0-5]?\d$/.test(v)) {
        input.classList.add("invalid");
        return;
      }
      void ops.onReschedule(r.index, v);
      this.dismiss();
    });

    const cancel = document.createElement("button");
    cancel.className = "pet-banner-btn";
    cancel.textContent = "取消";
    cancel.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      row.remove();
    });

    row.append(input, ok, cancel);
    this.el.appendChild(row);
    input.focus();
  }

  dismiss(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
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
    return !!b && px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
  }
}
