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
 * 列表只读；删除走「编辑模式」—— 标题栏的编辑按钮切换后，每行右侧出现
 * × 按钮，点击精准删除该条（含续行），用户在同一文件里的手写内容保留。
 * 搜索、富编辑等仍交给 Obsidian，我们只做「捕获 + 轻量删错」。
 */
export class TodayPanel {
  private readonly el: HTMLDivElement;
  private open = false;
  /** 展开的行号（-1 = 全收起）。 */
  private expanded = -1;
  /** 编辑模式：每行右侧显示 × 删除按钮。 */
  private editing = false;

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
    this.editing = false;
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
    let notes: NoteRow[] = [];
    try {
      notes = await invoke<NoteRow[]>("list_today_notes");
    } catch {
      // 非 Tauri 环境
    }
    // 空列表时退出编辑态：没有可删的，按钮文字也回到「编辑」
    if (notes.length === 0) this.editing = false;

    this.el.replaceChildren();

    const head = panelChrome(this.el, "今日速记", () => this.hide(), {
      headClass: "pet-today-head",
    });
    // 标题栏父容器用 space-between 把「编辑」挤到中间；把编辑+关闭包成一个
    // actions 容器贴右侧，标题独占左侧，避免「编辑」被推到中间。
    const closeBtn = head.querySelector(".pet-panel-close");
    if (closeBtn) closeBtn.remove();
    const actions = document.createElement("div");
    actions.className = "pet-today-head-actions";
    const edit = document.createElement("button");
    edit.className = "pet-today-edit";
    edit.textContent = "✏️";
    edit.title = this.editing ? "完成编辑" : "编辑/删除记录";
    edit.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.editing = !this.editing;
      // 切换编辑态时收起展开，避免行号语义变化指错行
      this.expanded = -1;
      void this.render();
    });
    if (closeBtn) actions.append(edit, closeBtn);
    else actions.append(edit);
    head.appendChild(actions);
    this.el.appendChild(head);

    if (notes.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pet-today-empty";
      empty.textContent = "今天还没有记录";
      this.el.appendChild(empty);
      return;
    }

    // 最新的在前面；点击多行行展开/收起，点链接只打开链接
    [...notes].reverse().forEach((n, idx) => {
      // 前端 idx 是倒序（最新在前）；Rust 按文件顺序删，要换算回文件 index
      const fileIdx = notes.length - 1 - idx;
      const multiline = n.text.includes("\n");
      const row = renderNoteRow(n, this.expanded === idx);
      if (this.editing) {
        const del = document.createElement("button");
        del.className = "pet-today-del";
        del.textContent = "×";
        del.title = "删除";
        del.addEventListener("pointerdown", (e) => {
          e.stopPropagation();
          void this.deleteNote(fileIdx);
        });
        row.appendChild(del);
      }
      row.addEventListener("pointerdown", (e) => {
        // 编辑模式下点行不展开/收起，避免误触；删除由 × 按钮自己的 handler 处理
        if (this.editing) return;
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

  private async deleteNote(fileIdx: number): Promise<void> {
    try {
      const ok = await invoke<boolean>("delete_note", { index: fileIdx });
      if (ok) {
        // 列表变化，收起展开避免行号错位；保持编辑态继续删下一条
        this.expanded = -1;
        await this.render();
      }
    } catch (e) {
      console.warn("[today] 删除失败", e);
    }
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
