# 速记 Markdown 富文本 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 速记支持 Markdown 轻量富文本 —— 输入端快捷键与自动续行、今日面板富文本回看、解析往返失真修复。

**Architecture:** 三块独立交付：①前端纯函数库（行内渲染器 `md-inline.ts` + 编辑变换 `md-edit.ts`，全 DOM API、零 innerHTML）→ ②两处集成（quick-note.ts 快捷键/续行、today.ts 预览+展开）→ ③Rust `note.rs` 解析修复（tag 行尾提取、续行只剥 2 空格）。存储格式、命令契约零改动，源码即所存。

**Tech Stack:** TypeScript（无框架，DOM API）、Rust（tauri 2）、vitest（happy-dom 按文件注解）、cargo test。

**Spec:** `docs/superpowers/specs/2026-09-07-quicknote-markdown-design.md`

## Global Constraints

- 注释、commit message、文档一律中文；Rust 单测函数用中文名；前端 happy-dom 测试文件首行 `// @vitest-environment happy-dom`
- 无新依赖（前端渲染器手写，不引 markdown 库）
- 渲染**绝不 innerHTML**，全 `textContent`/DOM API 构建；链接 href 只放行 `^https?://`
- Enter 拦截必须跳过 `e.keyCode === 229`（中文输入法候选确认）
- 纯逻辑写成纯函数并补单测，DOM/IO 驱动层保持薄
- 版本 **0.10.0** 三处同步：`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`；每个 commit message 末尾带 `版本: 0.10.0`
- 不动：`add_note`/`list_today_notes` 命令契约、`Note` 结构、`to_markdown` 落盘格式、Obsidian vault 直写、仲裁器
- 合入前三项全绿：`npx tsc --noEmit`、`cd src-tauri && cargo check`、`npx vitest run`
- `docs/` 在 .gitignore 里 → 提交设计/计划文档要 `git add -f`
- cargo 不在默认 PATH：Rust 命令前先 `export PATH="$HOME/.cargo/bin:$PATH"`；shell 的 cwd 每次调用会重置，cargo 命令必须与 `cd src-tauri` 同一条

---

### Task 0: 提交设计与计划文档

**Files:**
- Add: `docs/superpowers/specs/2026-09-07-quicknote-markdown-design.md`（已写好）
- Add: `docs/superpowers/plans/2026-09-07-quicknote-markdown.md`（本文件）

- [ ] **Step 1: 提交**

```bash
cd /Users/maxjxu/vibe_woo
git add -f docs/superpowers/specs/2026-09-07-quicknote-markdown-design.md docs/superpowers/plans/2026-09-07-quicknote-markdown.md
git commit -m "docs(spec): 速记 Markdown 富文本设计与实施计划（版本: 0.10.0）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 1: 行内渲染器 `md-inline.ts`

**Files:**
- Create: `src/overlay/md-inline.ts`
- Test: `tests/md-inline.test.ts`

**Interfaces:**
- Produces: `renderInline(text: string): Node[]`（行内四件套）、`renderLine(line: string): Node[]`（任务前缀 ☐/☑ + 行内）—— Task 4 的 today.ts 消费这两个函数。

- [ ] **Step 1: 写失败测试**

`tests/md-inline.test.ts`：

```ts
// @vitest-environment happy-dom
// 行内渲染器要造 DOM 节点；其余测试保持 node 环境零开销。
import { describe, expect, it } from "vitest";
import { renderInline, renderLine } from "../src/overlay/md-inline";

describe("行内 Markdown 渲染", () => {
  it("粗体渲染 strong", () => {
    const out = renderInline("**P0** 修闪退");
    expect((out[0] as HTMLElement).tagName).toBe("STRONG");
    expect(out[0].textContent).toBe("P0");
    expect(out[1].textContent).toBe(" 修闪退");
  });

  it("斜体渲染 em", () => {
    const out = renderInline("*重点* 后文");
    expect((out[0] as HTMLElement).tagName).toBe("EM");
  });

  it("行内代码渲染 code 且内部标记不再解析", () => {
    const out = renderInline("用 `**cron**` 跑");
    const code = out.find((n) => (n as HTMLElement).tagName === "CODE");
    expect(code?.textContent).toBe("**cron**");
  });

  it("链接放行 https", () => {
    const out = renderInline("看 [项目](https://example.com) 去");
    const a = out.find((n) => (n as HTMLElement).tagName === "A");
    expect(a?.textContent).toBe("项目");
    // 用 getAttribute 避免 happy-dom 把 href 解析成绝对地址
    expect((a as HTMLElement).getAttribute("href")).toBe("https://example.com");
  });

  it("非 http(s) scheme 按纯文本渲染", () => {
    const out = renderInline("[x](javascript:alert(1))");
    const text = out.map((n) => n.textContent).join("");
    expect(text).toBe("[x](javascript:alert(1))");
    expect(out.find((n) => (n as HTMLElement).tagName === "A")).toBeUndefined();
  });

  it("未闭合标记原样显示", () => {
    const out = renderInline("**没有闭合");
    expect(out.map((n) => n.textContent).join("")).toBe("**没有闭合");
  });

  it("2*3*4 不误伤为斜体", () => {
    const out = renderInline("2*3*4");
    expect(out.map((n) => n.textContent).join("")).toBe("2*3*4");
    expect(out.find((n) => (n as HTMLElement).tagName === "EM")).toBeUndefined();
  });

  it("标记内侧空白不生效", () => {
    const out = renderInline("** 空 **");
    expect(out.map((n) => n.textContent).join("")).toBe("** 空 **");
  });

  it("粗体内递归解析行内代码", () => {
    const out = renderInline("**粗 `代` 粗**");
    const strong = out[0] as HTMLElement;
    expect(strong.tagName).toBe("STRONG");
    expect(strong.querySelector("code")?.textContent).toBe("代");
  });

  it("中文邻接的斜体正常渲染", () => {
    const out = renderInline("前文*斜*后文");
    expect(out.find((n) => (n as HTMLElement).tagName === "EM")).toBeTruthy();
  });

  it("任务行渲染勾选框", () => {
    const todo = renderLine("- [ ] 买咖啡");
    expect(todo[0].textContent).toBe("☐");
    expect((todo[0] as HTMLElement).className).toBe("pet-md-task");
    expect(todo[1].textContent).toBe("买咖啡");

    const done = renderLine("- [x] 发周报");
    expect(done[0].textContent).toBe("☑");
    expect((done[0] as HTMLElement).className).toBe("pet-md-task-done");
  });

  it("普通行原样走行内渲染", () => {
    const out = renderLine("普通文本");
    expect(out.length).toBe(1);
    expect(out[0].textContent).toBe("普通文本");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/md-inline.test.ts`
Expected: FAIL（`Cannot find module '../src/overlay/md-inline'`）

- [ ] **Step 3: 写实现**

`src/overlay/md-inline.ts`：

```ts
/**
 * 速记轻量 Markdown 行内渲染（设计：docs/superpowers/specs/2026-09-07-quicknote-markdown-design.md）。
 *
 * 只支持行内四件套：**粗体**、*斜体*、`代码`、[文字](https://…)，
 * 外加行级任务前缀 - [ ] / - [x] → ☐ / ☑。
 * 全 DOM API 构建（textContent 赋值，绝不 innerHTML）—— XSS 从结构上免疫；
 * 链接 href 只放行 http(s)，其余 scheme 一律按纯文本。
 */

/** 链接白名单：只放行 http(s)。 */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * 行内解析。陷阱规则：
 * - `**` 优先于 `*`（先匹配双星）
 * - 未闭合标记原样显示（不吞字符）
 * - 标记内侧两端需非空白（`** 空 **` 不算粗体）
 * - 单星斜体的开星号前若是字母/数字则不视为标记（防 `2*3*4` 乘号误伤；
 *   中文邻接允许 —— 速记场景用户意图就是斜体）
 */
export function renderInline(text: string): Node[] {
  const out: Node[] = [];
  let plain = "";

  const flush = () => {
    if (plain) {
      out.push(document.createTextNode(plain));
      plain = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    // 行内代码：`...`（内部不再解析任何标记）
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        const code = document.createElement("code");
        code.textContent = text.slice(i + 1, end);
        out.push(code);
        i = end + 1;
        continue;
      }
    }
    // 链接：[文字](url)
    if (text[i] === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i + 1 && text[close + 1] === "(") {
        const end = text.indexOf(")", close + 2);
        if (end > close + 2) {
          const href = safeHref(text.slice(close + 2, end));
          if (href) {
            flush();
            const a = document.createElement("a");
            a.textContent = text.slice(i + 1, close);
            a.setAttribute("href", href);
            out.push(a);
            i = end + 1;
            continue;
          }
        }
      }
    }
    // 粗体/斜体：** 优先于 *
    if (text[i] === "*") {
      const dbl = text.startsWith("**", i);
      const marker = dbl ? "**" : "*";
      const end = text.indexOf(marker, i + marker.length);
      const valid = end > i + marker.length;
      const inner = valid ? text.slice(i + marker.length, end) : "";
      const innerOk =
        inner.length > 0 &&
        !/\s/.test(inner[0]) &&
        !/\s/.test(inner[inner.length - 1]);
      // 单星斜体：开星号前是字母/数字（乘号场景）不视为标记
      const boundaryOk = dbl || i === 0 || !/[0-9A-Za-z]/.test(text[i - 1]);
      if (valid && innerOk && boundaryOk) {
        flush();
        const el = document.createElement(dbl ? "strong" : "em");
        // 内部递归解析（如 **粗 `代码` 粗**）
        for (const n of renderInline(inner)) el.appendChild(n);
        out.push(el);
        i = end + marker.length;
        continue;
      }
    }
    plain += text[i];
    i++;
  }
  flush();
  return out;
}

/**
 * 渲染一行速记内容：任务前缀 → ☐/☑，其余走行内四件套。
 * 任务前缀须带尾随空白（`- [ ] 买咖啡`），光秃的 `- [ ]` 按普通文本处理。
 */
export function renderLine(line: string): Node[] {
  const m = line.match(/^[-*]\s+\[( |x|X)\]\s+/);
  if (!m) return renderInline(line);
  const done = m[1] !== " ";
  const box = document.createElement("span");
  box.className = done ? "pet-md-task-done" : "pet-md-task";
  box.textContent = done ? "☑" : "☐";
  return [box, ...renderInline(line.slice(m[0].length))];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/md-inline.test.ts`
Expected: PASS（12 例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/overlay/md-inline.ts tests/md-inline.test.ts
git commit -m "feat(note): 速记行内 Markdown 渲染器——粗体/斜体/代码/链接/任务勾选

全 DOM API 构建绝不 innerHTML，链接 scheme 白名单只放行 http(s)，
单星斜体带边界判定防 2*3*4 乘号误伤（版本: 0.10.0）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 编辑变换 `md-edit.ts`

**Files:**
- Create: `src/overlay/md-edit.ts`
- Test: `tests/md-edit.test.ts`

**Interfaces:**
- Produces:
  - `wrapSelection(text: string, selStart: number, selEnd: number, marker: string): { text: string; selStart: number; selEnd: number }`（⌘B/⌘I/⌘E 共用）
  - `wrapLink(text: string, selStart: number, selEnd: number): { text: string; selStart: number; selEnd: number }`（⌘K）
  - `continueList(text: string, caret: number): { prevent: boolean; text: string; selStart: number; selEnd: number } | null`（Enter 拦截；null = 非列表行，走默认换行）
- Task 3 的 quick-note.ts 消费这三个函数。

- [ ] **Step 1: 写失败测试**

`tests/md-edit.test.ts`（纯字符串运算，node 环境即可）：

```ts
import { describe, expect, it } from "vitest";
import { continueList, wrapLink, wrapSelection } from "../src/overlay/md-edit";

describe("选区包裹（⌘B/⌘I/⌘E）", () => {
  it("有选区：两端插标记，选区保持覆盖原文字", () => {
    const r = wrapSelection("ab粗cd", 2, 3, "**");
    expect(r.text).toBe("ab**粗**cd");
    expect([r.selStart, r.selEnd]).toEqual([4, 5]);
  });

  it("无选区：插入空标记对，光标落中间", () => {
    const r = wrapSelection("ab", 2, 2, "**");
    expect(r.text).toBe("ab****");
    expect([r.selStart, r.selEnd]).toEqual([3, 3]);
  });

  it("再按一次去掉标记（toggle）", () => {
    const r = wrapSelection("ab**粗**cd", 4, 5, "**");
    expect(r.text).toBe("ab粗cd");
    expect([r.selStart, r.selEnd]).toEqual([2, 3]);
  });

  it("光标在空标记对中间时再按也去掉", () => {
    const r = wrapSelection("a****b", 3, 3, "**");
    expect(r.text).toBe("ab");
    expect([r.selStart, r.selEnd]).toEqual([1, 1]);
  });
});

describe("链接包裹（⌘K）", () => {
  it("有选区：[选区]()，光标落括号内", () => {
    const r = wrapLink("看这页", 0, 2);
    expect(r.text).toBe("[看这]()页");
    expect([r.selStart, r.selEnd]).toEqual([5, 5]);
  });

  it("无选区：[]()，光标落方括号内", () => {
    const r = wrapLink("ab", 2, 2);
    expect(r.text).toBe("ab[]()");
    expect([r.selStart, r.selEnd]).toEqual([3, 3]);
  });
});

describe("回车自动续列表前缀", () => {
  it("无序列表续行", () => {
    const r = continueList("- 买咖啡", 5);
    expect(r).toEqual({ prevent: true, text: "- 买咖啡\n- ", selStart: 8, selEnd: 8 });
  });

  it("有序列表数字递增", () => {
    const r = continueList("1. 第一", 5);
    expect(r).toEqual({ prevent: true, text: "1. 第一\n2. ", selStart: 9, selEnd: 9 });
  });

  it("任务列表续行为未完成态", () => {
    const r = continueList("- [x] 完成", 8);
    expect(r).toEqual({ prevent: true, text: "- [x] 完成\n- [ ] ", selStart: 15, selEnd: 15 });
  });

  it("空无序项回车结束列表（吃掉前缀不换行）", () => {
    const r = continueList("- ", 2);
    expect(r).toEqual({ prevent: true, text: "", selStart: 0, selEnd: 0 });
  });

  it("空任务项回车结束列表", () => {
    const r = continueList("- [ ] ", 6);
    expect(r).toEqual({ prevent: true, text: "", selStart: 0, selEnd: 0 });
  });

  it("空有序项回车结束列表", () => {
    const r = continueList("1. ", 3);
    expect(r).toEqual({ prevent: true, text: "", selStart: 0, selEnd: 0 });
  });

  it("非列表行返回 null 走默认换行", () => {
    expect(continueList("普通文本", 2)).toBeNull();
  });

  it("行中回车：在光标处断行并接前缀", () => {
    const r = continueList("- abcd", 4);
    expect(r).toEqual({ prevent: true, text: "- ab\n- cd", selStart: 7, selEnd: 7 });
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/md-edit.test.ts`
Expected: FAIL（`Cannot find module '../src/overlay/md-edit'`）

- [ ] **Step 3: 写实现**

`src/overlay/md-edit.ts`：

```ts
/**
 * 速记编辑器的文本变换（纯函数，设计：docs/superpowers/specs/2026-09-07-quicknote-markdown-design.md）。
 *
 * quick-note.ts 的 keydown 驱动层调用这些函数拿到新文本与新选区，
 * 自身只负责写回 textarea —— 逻辑全部可单测。
 */

export interface EditResult {
  text: string;
  selStart: number;
  selEnd: number;
}

/**
 * 给选区包裹行内标记（⌘B 粗体 / ⌘I 斜体 / ⌘E 代码 共用）。
 * - 有选区：两端插标记，选区保持覆盖原文字
 * - 无选区：插入空标记对，光标落标记中间
 * - 光标/选区外侧已是标记对：去掉（toggle）
 */
export function wrapSelection(
  text: string,
  selStart: number,
  selEnd: number,
  marker: string,
): EditResult {
  const before = text.slice(Math.max(0, selStart - marker.length), selStart);
  const after = text.slice(selEnd, selEnd + marker.length);
  if (before === marker && after === marker) {
    const removed =
      text.slice(0, selStart - marker.length) +
      text.slice(selStart, selEnd) +
      text.slice(selEnd + marker.length);
    return {
      text: removed,
      selStart: selStart - marker.length,
      selEnd: selEnd - marker.length,
    };
  }
  if (selEnd > selStart) {
    return {
      text:
        text.slice(0, selStart) + marker + text.slice(selStart, selEnd) + marker + text.slice(selEnd),
      selStart: selStart + marker.length,
      selEnd: selEnd + marker.length,
    };
  }
  return {
    text: text.slice(0, selStart) + marker + marker + text.slice(selStart),
    selStart: selStart + marker.length,
    selEnd: selStart + marker.length,
  };
}

/** ⌘K 插入链接：有选区 → [选区]()，光标落 () 内；无选区 → []()，光标落 [] 内。 */
export function wrapLink(text: string, selStart: number, selEnd: number): EditResult {
  if (selEnd > selStart) {
    const inner = text.slice(selStart, selEnd);
    return {
      text: text.slice(0, selStart) + `[${inner}]()` + text.slice(selEnd),
      selStart: selEnd + 3,
      selEnd: selEnd + 3,
    };
  }
  return {
    text: text.slice(0, selStart) + "[]()" + text.slice(selStart),
    selStart: selStart + 1,
    selEnd: selStart + 1,
  };
}

/**
 * 回车在列表行内的行为；null = 非列表行（走 textarea 默认换行）。
 * - 非空列表项：在光标处断行并接上对应前缀（任务项续未完成态、有序项数字递增）
 * - 空列表项（只剩前缀）：吃掉前缀、不换行 —— 结束列表
 */
export function continueList(text: string, caret: number): EditResult & { prevent: boolean } | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const nl = text.indexOf("\n", caret);
  const lineEnd = nl === -1 ? text.length : nl;
  const line = text.slice(lineStart, lineEnd);

  const task = line.match(/^[-*]\s+\[( |x|X)\]\s+/);
  const bullet = line.match(/^[-*]\s+/);
  const ordered = line.match(/^(\d+)\.\s+/);

  const prefix = task?.[0] ?? bullet?.[0] ?? ordered?.[0];
  if (!prefix) return null;

  // 空列表项：吃掉前缀、结束列表（光标回行首，不换行）
  if (line.trim() === prefix.trim()) {
    return {
      prevent: true,
      text: text.slice(0, lineStart) + text.slice(lineStart + prefix.length),
      selStart: lineStart,
      selEnd: lineStart,
    };
  }

  // 非空：断行 + 接前缀
  let next: string;
  if (task) {
    next = "- [ ] ";
  } else if (ordered) {
    next = `${Number(ordered[1]) + 1}. `;
  } else {
    next = "- ";
  }
  return {
    prevent: true,
    text: text.slice(0, caret) + "\n" + next + text.slice(caret),
    selStart: caret + 1 + next.length,
    selEnd: caret + 1 + next.length,
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/md-edit.test.ts`
Expected: PASS（14 例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/overlay/md-edit.ts tests/md-edit.test.ts
git commit -m "feat(note): 速记编辑变换——快捷键包裹与列表自动续行（版本: 0.10.0）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: quick-note.ts 接入快捷键与续行

**Files:**
- Modify: `src/overlay/quick-note.ts:1-4`（import）、`:78-90`（bind）、新增两个私有方法

**Interfaces:**
- Consumes: Task 2 的 `wrapSelection` / `wrapLink` / `continueList`（签名见 Task 2 Produces）。

- [ ] **Step 1: 加 import**

`src/overlay/quick-note.ts` 顶部（`enablePanelDrag` import 之后加一行）：

```ts
import { continueList, wrapLink, wrapSelection } from "./md-edit";
```

- [ ] **Step 2: 重写 bind()，新增两个应用方法**

把现有 `private bind(): void {...}`（第 78-90 行）整体替换为：

```ts
  private bind(): void {
    this.textarea.addEventListener("keydown", (e) => {
      e.stopPropagation();
      // 中文输入法候选确认键（keyCode 229）不拦截 —— 吞掉会打断输入。
      // Cmd 组合键不受 IME 影响，放行给下面的快捷键分支。
      if (e.keyCode === 229 && !e.metaKey && !e.ctrlKey) return;

      // Cmd+Enter 保存。metaKey 对应 macOS 的 ⌘。
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        void this.save();
        return;
      }

      // Markdown 快捷键：⌘B 粗体 / ⌘I 斜体 / ⌘E 行内代码 / ⌘K 链接
      if (e.metaKey || e.ctrlKey) {
        const key = e.key.toLowerCase();
        if (key === "b") {
          e.preventDefault();
          this.applyEdit(wrapSelection(this.textarea.value, this.textarea.selectionStart, this.textarea.selectionEnd, "**"));
        } else if (key === "i") {
          e.preventDefault();
          this.applyEdit(wrapSelection(this.textarea.value, this.textarea.selectionStart, this.textarea.selectionEnd, "*"));
        } else if (key === "e") {
          e.preventDefault();
          this.applyEdit(wrapSelection(this.textarea.value, this.textarea.selectionStart, this.textarea.selectionEnd, "`"));
        } else if (key === "k") {
          e.preventDefault();
          this.applyEdit(wrapLink(this.textarea.value, this.textarea.selectionStart, this.textarea.selectionEnd));
        }
        return;
      }

      // 纯 Enter：列表行自动续前缀（空列表项回车=结束列表）。
      // Shift+Enter 不续 —— 用户要的就是普通换行。
      if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
        const r = continueList(this.textarea.value, this.textarea.selectionStart);
        if (r) {
          e.preventDefault();
          this.applyEdit(r);
        }
      }
      // 其余按键走默认行为
    });
    // 输入时自动增高
    this.textarea.addEventListener("input", () => this.autosize());
  }

  /** 把编辑变换写回 textarea 并恢复选区。 */
  private applyEdit(r: { text: string; selStart: number; selEnd: number }): void {
    this.textarea.value = r.text;
    this.textarea.setSelectionRange(r.selStart, r.selEnd);
    this.autosize();
  }
```

同时把类头注释（第 32-35 行）的按键语义更新为：

```ts
 * 按键语义（与 Notion/Slack 惯例一致）：
 *   - Enter      换行；列表行自动续前缀，空列表项回车结束列表
 *   - Cmd+Enter  保存
 *   - Cmd+B/I/E  粗体 / 斜体 / 行内代码（包裹选区，再按取消）
 *   - Cmd+K      插入链接
 *   - Esc        取消
```

- [ ] **Step 3: 类型检查 + 全量前端测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 零错误；vitest 全绿（本任务无新测试 —— 逻辑都在 Task 2 的纯函数里，驱动层按仓库惯例不测）

- [ ] **Step 4: 提交**

```bash
git add src/overlay/quick-note.ts
git commit -m "feat(note): 速记输入条接入 Markdown 快捷键与回车续行

Enter 拦截跳过 keyCode 229（输入法候选确认），Cmd 组合键不受影响（版本: 0.10.0）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: today.ts 富文本回看（预览 + 点击展开）

**Files:**
- Modify: `src/overlay/today.ts`（import、`expanded` 字段、`render()`、新增导出 `renderNoteRow`）
- Modify: `index.html:1170-1192`（`.pet-today-kind` 样式块之后追加 CSS）
- Test: `tests/today-note.test.ts`（新）

**Interfaces:**
- Consumes: Task 1 的 `renderLine`；`@tauri-apps/plugin-opener` 的 `openUrl`（main.ts 已在用，无新依赖）。
- Produces: `renderNoteRow(n: NoteRow, expanded: boolean): HTMLDivElement`（导出供单测）。

- [ ] **Step 1: 写失败测试**

`tests/today-note.test.ts`：

```ts
// @vitest-environment happy-dom
// 速记行渲染要造 DOM 节点；其余测试保持 node 环境零开销。
import { describe, expect, it } from "vitest";
import { renderNoteRow } from "../src/overlay/today";

const note = (text: string, kind = "note") => ({ text, tags: [], kind });

describe("今日速记行渲染", () => {
  it("单行纯文本原样", () => {
    const row = renderNoteRow(note("记得买咖啡"), false);
    expect(row.textContent).toBe("记得买咖啡");
    expect(row.querySelector("code")).toBeNull();
  });

  it("首行行内语法渲染", () => {
    const row = renderNoteRow(note("**P0** 修 `闪退`"), false);
    expect(row.querySelector("strong")?.textContent).toBe("P0");
    expect(row.querySelector("code")?.textContent).toBe("闪退");
  });

  it("多行收起时显示行数提示且不逐行渲染", () => {
    const row = renderNoteRow(note("一行\n二行\n三行"), false);
    expect(row.textContent).toContain("…3 行");
    expect(row.querySelector(".pet-today-line")).toBeNull();
  });

  it("展开时逐行渲染任务勾选与链接", () => {
    const text = "周会\n- [ ] 回邮件\n- [x] 发周报 [主页](https://example.com)";
    const row = renderNoteRow(note(text), true);
    expect(row.querySelectorAll(".pet-today-line").length).toBe(3);
    expect(row.textContent).toContain("☐");
    expect(row.textContent).toContain("☑");
    expect(row.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  });

  it("kind 徽标照旧", () => {
    const row = renderNoteRow(note("x", "todo"), false);
    expect(row.querySelector(".pet-today-kind.kind-todo")?.textContent).toBe("todo");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/today-note.test.ts`
Expected: FAIL（`renderNoteRow` 未导出）

- [ ] **Step 3: 改 today.ts**

顶部 import 改为：

```ts
import { openUrl } from "@tauri-apps/plugin-opener";
import { invoke } from "@tauri-apps/api/core";
import type { Box } from "../interact/hit-test";
import { panelChrome } from "./chrome";
import { renderLine } from "./md-inline";
```

`NoteRow` 接口改为导出（测试要用）：

```ts
export interface NoteRow {
  text: string;
  tags: string[];
  kind: string;
}
```

`TodayPanel` 类加字段（`private open = false;` 之后）：

```ts
  /** 展开的行号（-1 = 全收起）。 */
  private expanded = -1;
```

`hide()` 里 `this.open = false;` 之后加一行 `this.expanded = -1;`。

`render()` 的渲染循环（`// 最新的在前面` 到循环结束，即第 100-121 行）替换为：

```ts
    // 最新的在前面；点击多行行展开/收起，点链接只打开链接
    [...notes].reverse().forEach((n, idx) => {
      const multiline = n.text.includes("\n");
      const row = renderNoteRow(n, this.expanded === idx);
      row.addEventListener("pointerdown", (e) => {
        const a = (e.target as HTMLElement).closest?.("a");
        if (a) {
          e.stopPropagation();
          const href = a.getAttribute("href");
          if (href) void openUrl(href).catch(() => {});
          return; // 点链接不触发展开/收起
        }
        if (!multiline) return; // 单行无展开态
        this.expanded = this.expanded === idx ? -1 : idx;
        void this.render();
      });
      this.el.appendChild(row);
    });
```

文件末尾（`TodayPanel` 类外）新增导出函数：

```ts
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
```

- [ ] **Step 4: index.html 加 CSS**

`.pet-today-kind.kind-question` 样式块之后（约第 1192 行）追加：

```css
      .pet-today-more {
        flex: 0 0 auto;
        color: #6d768c;
      }

      .pet-today-expand {
        flex: 1;
        min-width: 0;
        word-break: break-all;
      }

      .pet-today-line {
        padding: 1px 0;
      }

      .pet-today-text code,
      .pet-today-line code {
        padding: 0 4px;
        border-radius: 4px;
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
        font-size: 11px;
        background: rgba(124, 245, 196, 0.12);
        color: #7cf5c4;
      }

      .pet-today-text a,
      .pet-today-line a {
        color: #8ab8ff;
        text-decoration: underline;
      }

      .pet-md-task {
        margin-right: 4px;
        color: #8ab8ff;
      }

      .pet-md-task-done {
        margin-right: 4px;
        color: #7cf5c4;
      }
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/today-note.test.ts && npx tsc --noEmit`
Expected: PASS（5 例）+ tsc 零错误

- [ ] **Step 6: 提交**

```bash
git add src/overlay/today.ts tests/today-note.test.ts index.html
git commit -m "feat(note): 今日速记富文本回看——预览渲染与点击展开

多行内容标「…N 行」点击展开逐行渲染，任务勾选 ☐/☑，
链接走 opener 插件与卡片同一收口（版本: 0.10.0）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: note.rs 解析往返失真修复

**Files:**
- Modify: `src-tauri/src/note.rs`（`parse_notes` 续行剥离、`parse_line` tag 提取）
- Test: `src-tauri/src/note.rs` 内 `mod tests` 追加

**Interfaces:**
- Consumes: 无（独立修复）。`Note` 结构、`to_markdown`、`persist` 全部不动。

- [ ] **Step 1: 写失败测试**

在 `src-tauri/src/note.rs` 的 `mod tests` 内追加（先看现有测试的构造习惯，`Note::new(text, ts)`）：

```rust
    #[test]
    fn 首行行内代码不被误提取为标签() {
        // 行中的 `代码` 是内容不是 tag —— 富文本速记的往返基础
        let notes = parse_notes("- **09:00** 回邮件 `tomorrow`\n");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].text, "回邮件 `tomorrow`");
        assert!(notes[0].tags.is_empty());
    }

    #[test]
    fn 行尾连续反引号token仍归标签() {
        // tags 是 LLM 回填、追加在行尾的 —— 这个语义不变
        let notes = parse_notes("- **09:00** 开会 `工作` `项目`\n");
        assert_eq!(notes[0].text, "开会");
        assert_eq!(notes[0].tags, vec!["工作".to_string(), "项目".to_string()]);
    }

    #[test]
    fn 续行只剥两个空格保留嵌套缩进() {
        // 落盘时我们加 2 空格缩进；用户自己的嵌套缩进要保留
        let notes = parse_notes("- **09:00** 周会\n  - P0 修闪退\n    - 细节\n");
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].text, "周会\n- P0 修闪退\n  - 细节");
    }

    #[test]
    fn 富文本速记往返一致() {
        let note = Note::new(
            "**P0** 修登录闪退\n- [ ] 回邮件 `tomorrow`\n  - 带附件",
            1_800_000_000_000,
        );
        let notes = parse_notes(&note.to_markdown());
        assert_eq!(notes.len(), 1);
        assert_eq!(
            notes[0].text,
            "**P0** 修登录闪退\n- [ ] 回邮件 `tomorrow`\n  - 带附件"
        );
    }
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/maxjxu/vibe_woo/src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test note::
```
Expected: `首行行内代码不被误提取为标签`、`续行只剥两个空格保留嵌套缩进`、`富文本速记往返一致` FAIL（当前实现把 `tomorrow` 吞成 tag、剥掉全部缩进）；`行尾连续反引号token仍归标签` 可能已 PASS

- [ ] **Step 3: 改 `parse_notes` 续行剥离**

把 `parse_notes` 里的续行分支：

```rust
        // 续行：合并到上一条（若上一条是我们写的）
        if line.starts_with("  ") && !line.trim().is_empty() {
            if let Some(last) = out.last_mut() {
                if last.ts_ms == CONTINUATION_SENTINEL || !last.text.is_empty() {
                    last.text.push('\n');
                    last.text.push_str(line.trim_start());
                    continue;
                }
            }
        }
```

替换为：

```rust
        // 续行：合并到上一条（若上一条是我们写的）。
        // 只剥落盘时加的 2 空格 —— 用户自己的嵌套缩进保留
        //（设计 docs/superpowers/specs/2026-09-07-quicknote-markdown-design.md）。
        if let Some(rest) = line.strip_prefix("  ") {
            if !rest.trim().is_empty() {
                if let Some(last) = out.last_mut() {
                    if last.ts_ms == CONTINUATION_SENTINEL || !last.text.is_empty() {
                        last.text.push('\n');
                        last.text.push_str(rest);
                        continue;
                    }
                }
            }
        }
```

- [ ] **Step 4: 改 `parse_line` tag 提取（只认行尾连续 token）**

把 `parse_line` 里从 `let mut parts` 到 `let text = parts.join(" ");` 的整段替换为：

```rust
    // tag 只认**行尾连续**的反引号 token —— tags 是 LLM 回填、追加在行尾的。
    // 行中的 `代码` 是内容不是 tag（富文本速记的往返基础）。
    let mut core = rest;
    let mut tags: Vec<String> = Vec::new();
    loop {
        let trimmed = core.trim_end();
        let Some(without_last) = trimmed.strip_suffix('`') else { break };
        let Some(tok_start) = without_last.rfind('`') else { break };
        // token 前须是空白或行首，否则整段就是普通内容（如 "内容`x`"）
        let before = &trimmed[..tok_start];
        if !before.is_empty() && !before.ends_with(char::is_whitespace) {
            break;
        }
        tags.push(trimmed[tok_start + 1..trimmed.len() - 1].to_string());
        core = before;
    }
    tags.reverse();

    let text = core.trim().to_string();
```

- [ ] **Step 5: 跑 note 全部测试（新旧一起）**

```bash
cd /Users/maxjxu/vibe_woo/src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo test note::
```
Expected: 全 PASS。若某个**旧**测试的断言与新语义冲突（如旧测试在行中间放反引号 tag），以新语义为准更新该旧测试并在断言旁加注释 `// 设计 2026-09-07：行中反引号归内容`

- [ ] **Step 6: 提交**

```bash
git add src-tauri/src/note.rs
git commit -m "fix(note): 解析往返失真——行中反引号归内容、续行保留嵌套缩进

tag 只从行尾连续 token 提取（原实现会把首行行内代码吞成标签）；
续行只剥落盘时加的 2 空格，用户嵌套缩进不再丢失（版本: 0.10.0）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 版本 0.10.0 与合入检查

**Files:**
- Modify: `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`（三处 version）

- [ ] **Step 1: 三处版本同步 0.9.0 → 0.10.0**

- `package.json`：`"version": "0.9.0"` → `"0.10.0"`
- `src-tauri/tauri.conf.json`：`"version": "0.9.0"` → `"0.10.0"`
- `src-tauri/Cargo.toml`：`version = "0.9.0"` → `version = "0.10.0"`（`[package]` 段）

- [ ] **Step 2: 全量检查**

```bash
cd /Users/maxjxu/vibe_woo
npx tsc --noEmit
cd src-tauri && export PATH="$HOME/.cargo/bin:$PATH" && cargo check && cargo test
cd /Users/maxjxu/vibe_woo
npx vitest run
```
Expected: tsc 零错误；cargo check 零错误零新警告、cargo test 全绿；vitest 全绿。Cargo.lock 的版本号随 cargo check 自动更新。

- [ ] **Step 3: 提交**

```bash
git add package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock
git commit -m "chore(release): 版本 0.10.0——速记 Markdown 富文本（版本: 0.10.0）

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 手工验证清单（交给用户日常观察，无法自动化）

1. ⌥Space 呼出速记 → 输中文（输入法候选 Enter 不被吞）→ ⌘B 给选区加粗 → Cmd+Enter 保存
2. 输 `- 项目` 回车自动接 `- `；空列表项回车列表结束
3. 左键面板「今日速记」→ 多行条目显示「…N 行」→ 点击展开看到 ☐/☑ 与可点链接
4. Obsidian vault 打开当日文件确认 Markdown 渲染正常（嵌套列表归属同一条目）
