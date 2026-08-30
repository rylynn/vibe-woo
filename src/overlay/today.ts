import { invoke } from "@tauri-apps/api/core";
import type { Box } from "../interact/hit-test";

interface NoteRow {
  text: string;
  tags: string[];
  kind: string;
}

/**
 * 今日速记回看。
 *
 * 刻意只做只读列表，不做编辑、搜索、删除 —— 那些交给 Obsidian，
 * 它比我们做得好（设计文档 6.5）。我们只负责「捕获」这一步。
 */
export class TodayPanel {
  private readonly el: HTMLDivElement;
  private open = false;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pet-today";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
  }

  async show(): Promise<void> {
    this.position();
    this.el.style.display = "block";
    this.open = true;
    // 面板先出现，数据异步填充（乐观渲染）
    this.renderLoading();
    await this.render();
  }

  private renderLoading(): void {
    this.el.replaceChildren();
    const head = document.createElement("div");
    head.className = "pet-today-head";
    const t = document.createElement("span");
    t.textContent = "今日速记";
    head.appendChild(t);
    this.el.appendChild(head);
    const e = document.createElement("div");
    e.className = "pet-today-empty";
    e.textContent = "…";
    this.el.appendChild(e);
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
    const w = 300;
    this.el.style.right = "16px";
    this.el.style.bottom = "60px";
    this.el.style.width = `${w}px`;
  }

  private async render(): Promise<void> {
    this.el.replaceChildren();

    const head = document.createElement("div");
    head.className = "pet-today-head";

    const title = document.createElement("span");
    title.textContent = "今日速记";

    const close = document.createElement("button");
    close.className = "pet-today-close";
    close.textContent = "×";
    close.title = "关闭";
    close.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.hide();
    });

    head.append(title, close);
    this.el.appendChild(head);

    let notes: NoteRow[] = [];
    try {
      notes = await invoke<NoteRow[]>("list_today_notes");
    } catch {
      // 非 Tauri 环境
    }

    if (notes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pet-today-empty";
      empty.textContent = "今天还没有记录";
      this.el.appendChild(empty);
      return;
    }

    // 最新的在前面
    for (const n of [...notes].reverse()) {
      const row = document.createElement("div");
      row.className = "pet-today-row";

      const text = document.createElement("span");
      text.className = "pet-today-text";
      // 多行内容折叠为单行预览，首行 + 省略号；hover title 展示全文
      const firstLine = n.text.split("\n")[0];
      text.textContent =
        n.text.includes("\n") ? `${firstLine} …` : firstLine;
      text.title = n.text;
      row.appendChild(text);

      if (n.kind && n.kind !== "note") {
        const k = document.createElement("span");
        k.className = `pet-today-kind kind-${n.kind}`;
        k.textContent = n.kind;
        row.appendChild(k);
      }
      this.el.appendChild(row);
    }
  }
}
