import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Box } from "../interact/hit-test";
import { enablePanelDrag } from "./panel-drag";

function enterInputMode(): void {
  void invoke("begin_text_input").catch(() => {});
}
function exitInputMode(): void {
  void invoke("end_text_input").catch(() => {});
}

/** Rust 端完成 make_key + activate 后的通知，一次性订阅。 */
let readySub: (() => void) | null = null;
function onInputReady(cb: () => void): void {
  void (async () => {
    // 若已经订阅过先取消，避免重复触发
    readySub?.();
    try {
      readySub = await listen("pet://input-ready", () => cb());
    } catch {
      cb(); // 非 Tauri 环境直接回调
    }
  })();
}

/**
 * 速记输入条。
 *
 * 设计原则（设计文档 6.3）：极简、无标题、无字段，保存即走。
 *
 * 按键语义（与 Notion/Slack 惯例一致）：
 *   - Enter      换行（内容里可以多行）
 *   - Cmd+Enter  保存
 *   - Esc        取消
 *
 * 用 DOM 而非 canvas：多行输入需要可靠的键盘输入、光标与中文输入法
 * 支持，这是 DOM 的强项。
 */
export class QuickNote {
  private readonly el: HTMLDivElement;
  private readonly textarea: HTMLTextAreaElement;
  private open = false;

  /** 呼出时回调，供宠物做「走过来」的仪式。 */
  onOpen: (() => void) | null = null;
  /** 落盘后回调，供宠物做「收进包裹」的确认。 */
  onSaved: (() => void) | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pet-quicknote";
    this.el.style.display = "none";

    this.textarea = document.createElement("textarea");
    this.textarea.placeholder = "记一笔…  ⌘↵ 保存 · Esc 取消";
    this.textarea.spellcheck = false;
    this.textarea.rows = 1;

    // 关闭按钮：语义与 Esc/再按 ⌥Space 一致 —— 丢弃当前输入直接收起
    const x = document.createElement("button");
    x.className = "pet-quicknote-close";
    x.textContent = "×";
    x.title = "收起（⌥Space 也可）";
    x.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.hide();
    });
    this.el.append(this.textarea, x);
    document.body.appendChild(this.el);

    // 拖拽：把手是输入条本体（textarea 被排除，从两侧留白处拖）
    enablePanelDrag(this.el, ".pet-quicknote");

    this.bind();
  }

  private bind(): void {
    this.textarea.addEventListener("keydown", (e) => {
      e.stopPropagation();
      // Cmd+Enter 保存。metaKey 对应 macOS 的 ⌘。
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.save();
      }
      // 其余按键（含纯 Enter）走默认行为：textarea 里 Enter 即换行
    });
    // 输入时自动增高
    this.textarea.addEventListener("input", () => this.autosize());
  }

  async show(): Promise<void> {
    this.position();
    this.el.style.display = "flex";
    this.textarea.value = "";
    this.autosize();
    this.open = true;
    this.onOpen?.();

    // 焦点链路：先并行发起 Rust 端的 make_key + activate，
    // 收到 input-ready 事件（激活完成）后 focus 一次到位。
    // DOM 显示不等这条链 —— 用户先看到窗，焦点紧随其后。
    onInputReady(() => this.textarea.focus());
    enterInputMode();
    // 立刻也试一次 —— 若窗口已经是 key（连续呼出），零延迟
    this.textarea.focus();
  }

  hide(): void {
    if (this.open) exitInputMode();
    this.el.style.display = "none";
    this.open = false;
    this.textarea.blur();
  }

  private async save(): Promise<void> {
    const text = this.textarea.value.trim();
    if (text.length === 0) {
      this.hide();
      return;
    }
    try {
      await invoke("add_note", { text });
      this.onSaved?.();
    } catch (e) {
      console.warn("[note] 落盘失败", e);
    }
    this.hide();
  }

  /** 高度随内容增长，上限约 6 行，超出滚动。 */
  private autosize(): void {
    const t = this.textarea;
    t.style.height = "auto";
    const max = 138;
    t.style.height = `${Math.min(t.scrollHeight, max)}px`;
    t.style.overflowY = t.scrollHeight > max ? "auto" : "hidden";
  }

  private position(): void {
    // 显示在屏幕上方 1/4 处，居中 —— 速记场景下视线多半在屏幕上方
    const w = 520;
    this.el.style.left = `${Math.max(8, (window.innerWidth - w) / 2)}px`;
    this.el.style.top = `${Math.round(window.innerHeight * 0.22)}px`;
    this.el.style.width = `${w}px`;
  }

  get isOpen(): boolean {
    return this.open;
  }

  get box(): Box | null {
    if (!this.open) return null;
    const r = this.el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /** 输入条当前位置的中心点，供宠物「走过来」。 */
  get center(): { x: number; y: number } | null {
    const b = this.box;
    return b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : null;
  }
}

/** 订阅速记呼出快捷键事件。 */
export async function onQuickNoteOpen(cb: () => void): Promise<() => void> {
  try {
    return await listen("pet://note-open", () => cb());
  } catch {
    return () => {};
  }
}
