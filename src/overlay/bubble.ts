import type { Box } from "../interact/hit-test";
import { enablePanelDrag } from "./panel-drag";

/** 气泡与宠物身体之间的留白（也是尾巴三角形的高度）。 */
const TAIL_GAP = 10;

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
  /** 插件卡片内容元素（showCard 模式）。show() 时清除并回到文字模式。 */
  private cardEl: HTMLElement | null = null;
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
    // 从卡片模式回到文字模式
    this.cardEl?.remove();
    this.cardEl = null;
    this.textEl.style.display = "";
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
    // 立刻按上次已知的身体位置定位，避免上屏第一帧闪在别处
    if (this.body) this.follow(this.body);
    // 点气泡本身不关闭（避免误触），只有按钮或超时才关
    this.el.onclick = null;
  }

  /**
   * 显示插件卡片气泡。
   *
   * 内容区是渲染器生成的任意 DOM；外壳（跟随 / 尾巴 / 越界翻转 /
   * 命中上报 / 穿透 lock）与文字模式完全一致。
   */
  showCard(card: HTMLElement, opts: { autoDismissMs?: number } = {}): void {
    this.textEl.style.display = "none";
    this.aiEl.style.display = "none";
    this.cardEl?.remove();
    this.cardEl = card;
    card.classList.add("pet-bubble-card");
    this.el.insertBefore(card, this.actionsEl);
    this.actionsEl.replaceChildren();

    if (this.timer) clearTimeout(this.timer);
    if (opts.autoDismissMs) {
      this.timer = setTimeout(() => this.dismiss(), opts.autoDismissMs);
    }

    this.el.style.display = "block";
    this.open = true;
    if (this.body) this.follow(this.body);
    // 卡片模式：点整卡关闭（与通知条的直觉一致；长停留的休息卡尤其需要）
    this.el.onclick = () => this.dismiss();
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
    // 头顶塞不下（宠物被拖到屏幕顶部）就翻到脚下 —— 绝不飘出屏幕外
    const above = body.y - h - TAIL_GAP;
    const flip = above < 4;
    const top = flip
      ? Math.min(body.y + body.h + TAIL_GAP, window.innerHeight - h - 4)
      : above;
    this.el.classList.toggle("pet-bubble-below", flip);
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(Math.max(4, top))}px`;
    // 尾巴水平位置跟随气泡相对宠物的偏移（贴边时收进气泡内，别戳出圆角外）
    const tailX = body.x + body.w / 2 - left;
    this.el.style.setProperty(
      "--pet-tail-x",
      `${Math.round(Math.max(12, Math.min(w - 12, tailX)))}px`,
    );
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
 * 通知条（番茄等简单通知）。
 *
 * 与气泡的区别：气泡跟着宠物走、更亲和；通知条视觉权重更高。
 * 位置两种：贴着宠物头顶（宠物相关通知，show 时 followPet）—— 不然
 * 消息和说话的宠物对不上号；固定右上角（提醒大卡片，要点的东西别乱跑）。
 * 简单模式点击整条即消失。
 */
export class Banner {
  private readonly el: HTMLDivElement;
  private open = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /**
   * 是否贴着宠物显示。
   *
   * true 时位置由渲染循环每帧给出（在宠物头顶，放不下则落到脚下）；
   * false 时走 CSS 的固定右上角。提醒大卡片始终用后者 —— 那是要操作的
   * 面板，跟着宠物乱跑反而没法点。
   */
  private anchored = false;
  /** 贴宠物模式下的身体位置，show 时先定位一次，避免闪在右上角。 */
  private body: Box | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pet-banner";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
    // 提醒大卡片可拖（把手 = 卡片头）。只在 reminder 模式存在 head，
    // 简单通知条没有 head 不会误拖；构造时挂一次，show 重建内容不重复挂。
    enablePanelDrag(this.el, ".pet-banner-head");
  }

  /**
   * 显示通知条。
   * @param opts.followPet 贴着宠物头顶显示；宠物不在家时自动退回右上角
   */
  show(
    text: string,
    time?: string,
    opts: { followPet?: boolean } = {},
  ): void {
    this.anchored = opts.followPet ?? false;
    this.setAnchored(this.anchored);
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
    // 贴宠物模式下先按已知位置定位，避免上屏第一帧闪在右上角
    if (this.anchored && this.body) this.follow(this.body);
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
    // 要点的卡片不跟宠物跑，固定右上角
    this.anchored = false;
    this.setAnchored(false);
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
    // × 的语义 = 稍后 10 分钟（与 snooze 按钮完全同路径，绝不误删）
    const x = document.createElement("button");
    x.className = "pet-banner-close";
    x.textContent = "×";
    x.title = "稍后 10 分钟";
    x.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      void ops.onSnooze(r.index);
      this.dismiss();
    });
    head.append(icon, tag, time, x);
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

  /** 切换贴宠物模式：加上/去掉跟随类，并清掉可能残留的行内定位。 */
  private setAnchored(on: boolean): void {
    this.el.classList.toggle("pet-banner-follow", on);
    if (!on) {
      // 不跟随就交还给 CSS 的固定右上角（同时清掉拖拽残留的行内定位）
      this.el.style.left = "";
      this.el.style.top = "";
      this.el.style.right = "";
      this.el.style.bottom = "";
      this.el.style.transform = "";
    }
  }

  /**
   * 渲染循环每帧调用：贴宠物模式下跟随身体。
   *
   * 宠物被拖到屏幕顶部时头顶放不下，翻到脚下；水平方向越界则贴边。
   */
  follow(body: Box): void {
    this.body = body;
    if (!this.open || !this.anchored) return;
    const w = this.el.offsetWidth;
    const h = this.el.offsetHeight;
    const left = Math.max(
      4,
      Math.min(window.innerWidth - w - 4, body.x + body.w / 2 - w / 2),
    );
    const above = body.y - h - TAIL_GAP;
    const top =
      above >= 4
        ? above
        : Math.min(body.y + body.h + TAIL_GAP, window.innerHeight - h - 4);
    this.el.style.left = `${Math.round(left)}px`;
    this.el.style.top = `${Math.round(Math.max(4, top))}px`;
  }

  dismiss(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.el.style.display = "none";
    this.open = false;
  }

  /**
   * 宠物离家时收起贴身通知。
   *
   * 没有宠物可贴，留着就变成悬在半空的孤零零一条 —— 直接收掉。
   * 提醒大卡片不跟随宠物，不受影响。
   */
  releaseFromPet(): void {
    if (this.open && this.anchored) this.dismiss();
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
