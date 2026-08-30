import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Box } from "../interact/hit-test";
import { enablePanelDrag } from "./panel-drag";

export interface Reminder {
  time: string;
  text: string;
  advance_mins: number;
  important: boolean;
}

interface ConfigViewLike {
  reminders: Reminder[];
}

/**
 * 提醒管理面板：添加、删除每日提醒。
 *
 * 刻意极简：时间 + 内容 + 提前量 + 重要开关，不做星期几选择 ——
 * 那是日历应用的职责，速记场景只需要「每天这个点提醒我」。
 */
export class RemindersPanel {
  private readonly el: HTMLDivElement;
  private open = false;
  private items: Reminder[] = [];

  constructor(private readonly onChange: (rs: Reminder[]) => void) {
    this.el = document.createElement("div");
    this.el.className = "pet-settings"; // 复用设置面板样式
    this.el.style.display = "none";
    document.body.appendChild(this.el);
    enablePanelDrag(this.el, ".pet-settings-head");
  }

  async show(): Promise<void> {
    await this.refresh();
    this.position();
    this.el.style.display = "block";
    this.open = true;
    void invoke("begin_text_input").catch(() => {});
  }

  hide(): void {
    if (this.open) void invoke("end_text_input").catch(() => {});
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
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
    const w = 336;
    this.el.style.left = `${Math.max(8, (window.innerWidth - w) / 2)}px`;
    this.el.style.top = `${Math.round(window.innerHeight * 0.18)}px`;
    this.el.style.width = `${w}px`;
  }

  private async refresh(): Promise<void> {
    try {
      const cfg = await invoke<ConfigViewLike>("get_config");
      this.items = cfg.reminders ?? [];
    } catch {
      this.items = [];
    }
    this.render();
  }

  private async save(items: Reminder[]): Promise<void> {
    this.items = items;
    this.onChange(items);
    try {
      await invoke("update_config", { patch: { reminders: items } });
    } catch (e) {
      console.warn("[reminders] 保存失败", e);
    }
    this.render();
  }

  private render(): void {
    this.el.replaceChildren();

    const head = document.createElement("div");
    head.className = "pet-settings-head";
    const title = document.createElement("span");
    title.textContent = "每日提醒";
    const close = document.createElement("button");
    close.className = "pet-settings-close";
    close.textContent = "×";
    close.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.hide();
    });
    head.append(title, close);
    this.el.appendChild(head);

    // 列表
    for (const r of this.items) {
      const row = document.createElement("div");
      row.className = "pet-reminder-row";

      const time = document.createElement("span");
      time.className = "pet-reminder-time";
      time.textContent = r.time;

      const text = document.createElement("span");
      text.className = "pet-reminder-text";
      const marks: string[] = [];
      if (r.advance_mins > 0) marks.push(`提前${r.advance_mins}分`);
      if (r.important) marks.push("重要");
      text.textContent = marks.length
        ? `${r.text}（${marks.join("·")}）`
        : r.text;
      text.title = text.textContent; // 截断时 hover 展示全文

      const del = document.createElement("button");
      del.className = "pet-reminder-del";
      del.textContent = "删";
      del.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        void this.save(this.items.filter((x) => x !== r));
      });

      row.append(time, text, del);
      this.el.appendChild(row);
    }

    if (this.items.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pet-settings-hint";
      empty.style.paddingLeft = "14px";
      empty.textContent = "还没有提醒";
      this.el.appendChild(empty);
    }

    // 添加行
    const add = document.createElement("div");
    add.className = "pet-settings-row";

    const timeInput = document.createElement("input");
    timeInput.type = "text";
    timeInput.placeholder = "09:30";
    timeInput.style.flex = "0 0 58px";
    timeInput.spellcheck = false;
    // 10 分钟粒度下拉建议，仍可手动输入任意时间
    timeInput.setAttribute("list", "pet-reminder-times");
    timeInput.addEventListener("keydown", (e) => e.stopPropagation());
    // 聚焦时刷新：保证下拉首项永远是最近的未来时间
    timeInput.addEventListener("focus", refreshTimeDatalist);

    const textInput = document.createElement("input");
    textInput.type = "text";
    textInput.placeholder = "提醒内容…";
    textInput.spellcheck = false;
    textInput.addEventListener("keydown", (e) => e.stopPropagation());

    refreshTimeDatalist();

    const btn = document.createElement("button");
    btn.className = "pet-bubble-confirm";
    btn.textContent = "添加";
    btn.style.flex = "0 0 auto";
    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const time = timeInput.value.trim();
      const text = textInput.value.trim();
      if (!/^([01]?\d|2[0-3]):[0-5]?\d$/.test(time) || !text) return;
      void this.save([
        ...this.items,
        { time, text, advance_mins: 5, important: false },
      ]);
      timeInput.value = "";
      textInput.value = "";
    });

    add.append(timeInput, textInput, btn);
    this.el.appendChild(add);

    const hint = document.createElement("div");
    hint.className = "pet-settings-hint";
    hint.textContent = "到点时宠物会气泡提醒 · 默认提前 5 分钟";
    this.el.appendChild(hint);
  }
}

/**
 * 时间输入的下拉建议：从「最近未来的 10 分钟边界」开始到 23:50。
 * datalist 元素挂在 body 上一次即可（不参与布局，render 的 replaceChildren 清不掉它），
 * 选项每次按当前时间重建 —— 提醒只对未来时间有意义，首项就该是最近的那个。
 * pub 供 main 启动时预建（通知卡片上的改时间输入也用它）。
 */
export function refreshTimeDatalist(): void {
  let dl = document.getElementById("pet-reminder-times");
  if (!(dl instanceof HTMLDataListElement)) {
    dl = document.createElement("datalist");
    dl.id = "pet-reminder-times";
    document.body.appendChild(dl);
  }
  dl.replaceChildren();
  const now = new Date();
  // 向上取整到下一个 10 分钟边界（14:37 → 14:40）
  let m = now.getHours() * 60 + now.getMinutes();
  m = m - (m % 10) + 10;
  for (; m < 24 * 60; m += 10) {
    const opt = document.createElement("option");
    opt.value = `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    dl.appendChild(opt);
  }
}

/** 订阅提醒触发事件。 */
export async function onReminderFired(
  cb: (r: {
    index: number;
    text: string;
    important: boolean;
    time: string;
  }) => void,
): Promise<() => void> {
  try {
    return await listen<{
      index: number;
      text: string;
      important: boolean;
      time: string;
    }>("pet://reminder", (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}
