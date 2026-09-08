import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Box } from "../interact/hit-test";
import { panelChrome } from "./chrome";
import { renderLine } from "./md-inline";

export interface NoteRow {
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
  /** 展开的行号（-1 = 全收起）。 */
  private expanded = -1;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pet-today";
    this.el.style.display = "none";
    document.body.appendChild(this.el);

    // 面板已打开时新增速记（add_note 落盘后发 pet://note-saved）要实时刷新，
    // 否则「打开面板 → 再调接口记一条」这条链路看不到新记录。
    void listen("pet://note-saved", () => {
      if (!this.open) return;
      // 列表最新在前，新记录插入后旧展开行号会错位，直接收起避免指错行
      this.expanded = -1;
      void this.render();
    }).catch(() => {});
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
    const head = panelChrome(this.el, "今日速记", () => this.hide(), {
      headClass: "pet-today-head",
    });
    this.el.appendChild(head);
    const e = document.createElement("div");
    e.className = "pet-today-empty";
    e.textContent = "…";
    this.el.appendChild(e);
  }

  hide(): void {
    this.el.style.display = "none";
    this.open = false;
    this.expanded = -1;
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

    const head = panelChrome(this.el, "今日速记", () => this.hide(), {
      headClass: "pet-today-head",
    });
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

    // 最新的在前面；点击多行行展开/收起，点链接只打开链接
    [...notes].reverse().forEach((n, idx) => {
      const multiline = n.text.includes("\n");
      const row = renderNoteRow(n, this.expanded === idx);
      row.addEventListener("pointerdown", (e) => {
        const a = (e.target as HTMLElement).closest?.("a");
        if (a) {
          e.stopPropagation();
          const href = a.getAttribute("href");
          if (href) {
            // 失败只 warn 不打扰——与 main.ts cardHost.openUrl 同一处理
            void openUrl(href).catch((e) => console.warn("[today] 打开链接失败", e));
          }
          return; // 点链接不触发展开/收起
        }
        if (!multiline) return; // 单行无展开态
        this.expanded = this.expanded === idx ? -1 : idx;
        void this.render();
      });
      this.el.appendChild(row);
    });
  }
}

/**
 * 渲染一条速记行（导出供单测）。
 * 收起态：首行行内渲染 + 多行时「…N 行」提示 + hover title 全文；
 * 展开态：逐行渲染（任务勾选、行内语法、可点链接）。
 */
export function renderNoteRow(n: NoteRow, expanded: boolean): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "pet-today-row";
  const lines = n.text.split("\n");
  const multiline = lines.length > 1;

  const body = document.createElement(multiline && expanded ? "div" : "span");
  body.className = multiline && expanded ? "pet-today-expand" : "pet-today-text";

  if (multiline && expanded) {
    for (const line of lines) {
      const ln = document.createElement("div");
      ln.className = "pet-today-line";
      for (const node of renderLine(line)) ln.appendChild(node);
      body.appendChild(ln);
    }
  } else {
    for (const node of renderLine(lines[0])) body.appendChild(node);
    body.title = n.text;
  }
  row.appendChild(body);

  if (multiline && !expanded) {
    const more = document.createElement("span");
    more.className = "pet-today-more";
    more.textContent = `…${lines.length} 行`;
    row.appendChild(more);
  }

  if (n.kind && n.kind !== "note") {
    const k = document.createElement("span");
    k.className = `pet-today-kind kind-${n.kind}`;
    k.textContent = n.kind;
    row.appendChild(k);
  }
  return row;
}
