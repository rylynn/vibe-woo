# F3 窗口统一拖拽+关闭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 所有持久面板统一获得「标题栏长按拖拽 + × 关闭」能力，收敛五处重复的关闭按钮代码。

**Architecture:** 新增 `src/overlay/chrome.ts` 的 `panelChrome()` 一次构建标题栏（返回按钮可选 + 标题 + ×）并接上既有 `enablePanelDrag`；七个面板逐一迁移，速记输入条与提醒大卡片补齐缺口。

**Tech Stack:** TypeScript（无框架，DOM 直构）、vitest。

**Spec:** `docs/superpowers/specs/2026-09-03-auto-update-words-srs-panel-chrome-design.md` 设计三。

## Global Constraints

- 注释、文案全部中文；匹配现有代码风格。
- 面板关闭按钮统一 `pointerdown + stopPropagation` 模式（nonactivating panel 可能漏发 pointerup，不用 click）。
- 拖拽必须复用 `src/overlay/panel-drag.ts` 的 `enablePanelDrag`（长按阈值 4px、`buttons === 0` 兜底结束），不得另写拖拽逻辑。
- 每个任务完成跑 `npx vitest run` 与 `npx tsc --noEmit`；本特性不改 Rust。
- 不动的：右键菜单、宠物气泡（瞬态 UI 非面板）。
- 版本号：合入时**问用户要**，不许自己编；三处真源（`src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `package.json`）同步改。

---

### Task 1: chrome.ts 工具 + 单测

**Files:**
- Create: `src/overlay/chrome.ts`
- Test: `tests/chrome.test.ts`

**Interfaces:**
- Consumes: `enablePanelDrag(panel: HTMLElement, handleSelector: string)`（`src/overlay/panel-drag.ts`）
- Produces: `panelChrome(panel: HTMLElement, title: string, onClose: () => void, opts?: { closeTitle?: string; headClass?: string; back?: () => void; backLabel?: string }): HTMLElement` —— 后续所有面板任务用它建标题栏。

- [ ] **Step 1: 写失败测试**

```ts
// tests/chrome.test.ts
import { describe, it, expect, vi } from "vitest";
import { panelChrome } from "../src/overlay/chrome";

describe("panelChrome", () => {
  it("构建标题栏：类名默认 pet-settings-head，含标题与 ×", () => {
    const panel = document.createElement("div");
    const head = panelChrome(panel, "测试面板", () => {});
    expect(head.className).toBe("pet-settings-head");
    expect(head.textContent).toContain("测试面板");
    expect(head.querySelector("button.pet-panel-close")).toBeTruthy();
  });

  it("点 × 触发 onClose 且阻止冒泡", () => {
    const panel = document.createElement("div");
    const onclose = vi.fn();
    const head = panelChrome(panel, "测试", onclose);
    const x = head.querySelector("button.pet-panel-close")!;
    const ev = new PointerEvent("pointerdown", { bubbles: true });
    const stop = vi.spyOn(ev, "stopPropagation");
    x.dispatchEvent(ev);
    expect(onclose).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalled();
  });

  it("opts.back 提供时出现返回按钮，点击触发", () => {
    const panel = document.createElement("div");
    const back = vi.fn();
    const head = panelChrome(panel, "测试", () => {}, { back });
    const b = head.querySelector("button.pet-settings-back");
    expect(b).toBeTruthy();
    b!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(back).toHaveBeenCalledOnce();
  });

  it("自定义 headClass 与 closeTitle 生效", () => {
    const panel = document.createElement("div");
    const head = panelChrome(panel, "测试", () => {}, {
      headClass: "pet-hub-head",
      closeTitle: "稍后再选",
    });
    expect(head.className).toBe("pet-hub-head");
    expect(head.querySelector("button.pet-panel-close")!.title).toBe("稍后再选");
  });

  it("重复调用只挂一次拖拽（dataset 哨兵）", () => {
    const panel = document.createElement("div");
    panelChrome(panel, "a", () => {});
    panelChrome(panel, "b", () => {});
    expect(panel.dataset.petChromeDrag).toBe("1");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/chrome.test.ts`
Expected: FAIL（`Cannot find module '../src/overlay/chrome'`）

- [ ] **Step 3: 实现 chrome.ts**

```ts
// src/overlay/chrome.ts
import { enablePanelDrag } from "./panel-drag";

export interface PanelChromeOptions {
  /** × 悬浮提示，默认「关闭」。 */
  closeTitle?: string;
  /** 标题栏类名（各面板 CSS 独立定型），默认 "pet-settings-head"。 */
  headClass?: string;
  /** 提供时左侧出现返回按钮（设置面板二级/三级页用）。 */
  back?: () => void;
  backLabel?: string;
}

/**
 * 统一面板标题栏：标题 + 返回（可选）+ × 关闭，并给面板接上长按拖动。
 *
 * 七个持久面板共用（2026-09-03 spec 设计三）——「所有窗口理论都可拖拽、
 * 都配关闭按钮」从此在构建期保证，新面板不再手抄关闭按钮代码。
 *
 * 拖拽只挂一次（dataset 哨兵）：面板每次 render 重建 head，若重复挂
 * 监听器会叠加多个拖拽 handler，一次 pointermove 挪多步。
 */
export function panelChrome(
  panel: HTMLElement,
  title: string,
  onClose: () => void,
  opts: PanelChromeOptions = {},
): HTMLElement {
  const head = document.createElement("div");
  head.className = opts.headClass ?? "pet-settings-head";
  if (opts.back) {
    const back = document.createElement("button");
    back.className = "pet-settings-back";
    back.textContent = opts.backLabel ?? "‹ 返回";
    back.title = "返回上一页";
    back.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      opts.back?.();
    });
    head.appendChild(back);
  }
  const t = document.createElement("span");
  t.textContent = title;
  const x = document.createElement("button");
  x.className = "pet-panel-close";
  x.textContent = "×";
  x.title = opts.closeTitle ?? "关闭";
  x.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    onClose();
  });
  head.append(t, x);
  if (panel.dataset.petChromeDrag !== "1") {
    enablePanelDrag(panel, `.${head.className.split(" ")[0]}`);
    panel.dataset.petChromeDrag = "1";
  }
  return head;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/chrome.test.ts`
Expected: PASS（5 个用例全绿）

- [ ] **Step 5: 提交**

```bash
git add src/overlay/chrome.ts tests/chrome.test.ts
git commit -m "feat(f3): panelChrome 统一面板标题栏（拖拽+关闭）"
```

---

### Task 2: 共享 CSS（.pet-panel-close / .pet-banner-close）

**Files:**
- Modify: `index.html`（在 `.pet-settings-close:hover` 规则之后、`.pet-settings-divider` 之前插入；在 `.pet-quicknote-close:hover` 之后插入 banner 关闭样式）

**Interfaces:**
- Consumes: Task 1 的类名 `pet-panel-close`
- Produces: `.pet-panel-close` 与 `.pet-banner-close` 样式（Task 7/8/9 的按钮依赖）

- [ ] **Step 1: 在 index.html 第 149 行（`.pet-settings-close:hover { color: #fff; }` 闭合 `}` 之后）插入**

```css
      /* 统一面板关闭按钮（chrome.ts）。旧类名保留：未迁移元素仍可用 */
      .pet-panel-close {
        border: 0;
        background: transparent;
        color: #8b93a7;
        font-size: 17px;
        line-height: 1;
        cursor: default;
        padding: 0 2px;
      }

      .pet-panel-close:hover {
        color: #fff;
      }
```

- [ ] **Step 2: 在 index.html 第 353 行（`.pet-quicknote-close:hover` 规则闭合后）插入**

```css
      /* 提醒大卡片的 ×（语义 = 稍后 10 分钟，见 bubble.ts） */
      .pet-banner-close {
        flex: 0 0 auto;
        border: 0;
        background: transparent;
        color: #8b93a7;
        font-size: 17px;
        line-height: 1;
        cursor: default;
        padding: 0 2px;
      }

      .pet-banner-close:hover {
        color: #fff;
      }
```

- [ ] **Step 3: 验证与提交**

Run: `npx tsc --noEmit`（index.html 不参与编译，只确认没碰坏别的）
打开 `pnpm dev` 目测无样式报错即可（样式生效在后续任务验证）。

```bash
git add index.html
git commit -m "feat(f3): 统一关闭按钮与提醒卡片 × 的样式"
```

---

### Task 3: settings.ts 迁移到 panelChrome

**Files:**
- Modify: `src/overlay/settings.ts`（constructor 75 行、renderLoading 93-98 行、header 340-365 行）

**Interfaces:**
- Consumes: `panelChrome`（Task 1）
- Produces: 无对外变化（`hide()`/`header()` 签名不变）

- [ ] **Step 1: 改 import 与 constructor**

删除第 12 行 `import { enablePanelDrag } from "./panel-drag";`，改为：

```ts
import { panelChrome } from "./chrome";
```

删除 constructor 里的（第 74-75 行）：

```ts
    // 标题栏长按拖动，与宠物拖动手感一致
    enablePanelDrag(this.el, ".pet-settings-head");
```

（拖拽改由 panelChrome 的 dataset 哨兵接管，首 render 即挂。）

- [ ] **Step 2: renderLoading 换用 panelChrome**

`renderLoading()` 中原 93-98 行的 head 构建替换为：

```ts
    const head = panelChrome(this.el, "Vibe Pet 设置", () => this.hide());
```

- [ ] **Step 3: header() 换用 panelChrome**

原 339-365 行整个 `header` 方法替换为：

```ts
  /** 标题栏（panelChrome 统一构建：拖拽 + 返回 + ×）。 */
  private header(title: string, onBack?: () => void): HTMLElement {
    return panelChrome(this.el, title, () => this.hide(), onBack ? { back: onBack } : {});
  }
```

- [ ] **Step 4: 验证**

Run: `npx vitest run && npx tsc --noEmit`
Expected: 全绿（现有 dismiss/pet 等测试不回归）

- [ ] **Step 5: 提交**

```bash
git add src/overlay/settings.ts
git commit -m "refactor(f3): 设置面板标题栏迁移 panelChrome"
```

---

### Task 4: about.ts 迁移到 panelChrome

**Files:**
- Modify: `src/overlay/about.ts`（constructor 34 行、renderLoading 84-90 行、header 119-151 行）

**Interfaces:**
- Consumes: `panelChrome`（Task 1）

- [ ] **Step 1: 改 import 与 constructor**

第 4 行 `import { enablePanelDrag } from "./panel-drag";` 改为 `import { panelChrome } from "./chrome";`；删除 constructor 第 34 行 `enablePanelDrag(this.el, ".pet-settings-head");`。

- [ ] **Step 2: renderLoading 换用 panelChrome**

```ts
    const head = panelChrome(this.el, "关于", () => this.hide());
```

- [ ] **Step 3: header() 扁平化替换**

原 119-151 行整个 `header` 方法替换（去掉 `.pet-about-head-left` 嵌套，返回按钮与标题、× 同层，和设置面板一致）：

```ts
  /** 标题栏（panelChrome 统一构建；从设置进入时带「返回设置」）。 */
  private header(): HTMLElement {
    const back = this.back
      ? { back: () => { this.hide(); this.back?.(); }, backLabel: "‹ 返回设置" }
      : {};
    return panelChrome(this.el, "关于", () => this.hide(), back);
  }
```

- [ ] **Step 4: 验证并提交**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/overlay/about.ts
git commit -m "refactor(f3): 关于面板标题栏迁移 panelChrome"
```

---

### Task 5: friends.ts + reminders.ts 迁移

**Files:**
- Modify: `src/overlay/friends.ts`（constructor 第 4/60 行、render 中 close 构建约 120-127 行）
- Modify: `src/overlay/reminders.ts`（constructor 第 4/33 行、render 中 close 构建约 104-111 行）

**Interfaces:**
- Consumes: `panelChrome`（Task 1）

- [ ] **Step 1: friends.ts**

import 行换为 `import { panelChrome } from "./chrome";`，删除 constructor 的 `enablePanelDrag(this.el, ".pet-settings-head");`。
render 中原「title span + close button 两段构建 + `h.append(t, close)`」替换为（保留 head 变量名与后续 append 流程）：

```ts
    const h = panelChrome(this.el, "好友", () => this.hide());
```

（若原代码里 head 后还 append 了别的元素，保持不动；面板类名仍是 `pet-settings-head`，CSS 不变。）

- [ ] **Step 2: reminders.ts**

同样换 import、删 constructor 的 enablePanelDrag；render 中原「close 按钮构建 + `head.append(title, close)`」替换为：

```ts
    const head = panelChrome(this.el, "每日提醒", () => this.hide());
```

（以文件里实际标题文案为准，不要改标题文字。）

- [ ] **Step 3: 验证并提交**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/overlay/friends.ts src/overlay/reminders.ts
git commit -m "refactor(f3): 好友/提醒面板标题栏迁移 panelChrome"
```

---

### Task 6: avatar-picker.ts 迁移

**Files:**
- Modify: `src/overlay/avatar-picker.ts`（constructor 第 12/194 行、close 构建约 243-247 行）

**Interfaces:**
- Consumes: `panelChrome`（Task 1，`headClass` 与 `closeTitle` 选项）

- [ ] **Step 1: 替换**

import 换为 `import { panelChrome } from "./chrome";`，删除 constructor 的 `enablePanelDrag(this.el, ".pet-avatar-picker-head");`。
close 按钮构建处替换为（注意保留它特有的「稍后再选」语义文案与 `pet-avatar-picker-head` 类名）：

```ts
    const head = panelChrome(this.el, "选个形象", () => this.hide(), {
      headClass: "pet-avatar-picker-head",
      closeTitle: "稍后再选（下次启动还会问我）",
    });
```

（标题文案以文件实际为准。）

- [ ] **Step 2: 验证并提交**

Run: `npx vitest run && npx tsc --noEmit`

```bash
git add src/overlay/avatar-picker.ts
git commit -m "refactor(f3): 形象选择面板迁移 panelChrome"
```

---

### Task 7: today.ts + hub.ts 补拖拽（顺带迁移）

**Files:**
- Modify: `src/overlay/today.ts`（renderLoading 37-43 行、render 81-97 行）
- Modify: `src/plugins/hub.ts`（render 92-105 行）

**Interfaces:**
- Consumes: `panelChrome`（Task 1）

- [ ] **Step 1: today.ts**

顶部加 `import { panelChrome } from "./chrome";`。
`renderLoading()` 的 head 构建替换为：

```ts
    const head = panelChrome(this.el, "今日速记", () => this.hide(), {
      headClass: "pet-today-head",
    });
```

`render()` 中原「title + close 构建 + `head.append(title, close)`」替换为：

```ts
    const head = panelChrome(this.el, "今日速记", () => this.hide(), {
      headClass: "pet-today-head",
    });
```

- [ ] **Step 2: hub.ts**

顶部加 `import { panelChrome } from "../overlay/chrome";`。
`render()` 中原「head/title/close 构建 + `head.append(title, close)`」替换为：

```ts
    const head = panelChrome(this.el, "插件", () => this.hide(), {
      headClass: "pet-hub-head",
    });
```

- [ ] **Step 3: 验证**

Run: `npx vitest run && npx tsc --noEmit`
手工（`pnpm tauri dev`）：右键菜单开「今日速记」与左键插件面板，标题栏长按能拖动，× 能关。

- [ ] **Step 4: 提交**

```bash
git add src/overlay/today.ts src/plugins/hub.ts
git commit -m "feat(f3): 今日速记与插件面板补上标题栏拖拽"
```

---

### Task 8: quick-note 补 × 与拖拽

**Files:**
- Modify: `src/overlay/quick-note.ts`（constructor 49-63 行）

**Interfaces:**
- Consumes: `enablePanelDrag`（`src/overlay/panel-drag.ts` 直用——输入条无标题栏，panelChrome 不适用）

- [ ] **Step 1: constructor 改造**

constructor 中 `this.el.appendChild(this.textarea);` 替换为：

```ts
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
```

constructor 末尾（`this.bind();` 之前）加：

```ts
    // 拖拽：把手是输入条本体（textarea 被排除，从两侧留白处拖）
    enablePanelDrag(this.el, ".pet-quicknote");
```

顶部加 `import { enablePanelDrag } from "./panel-drag";`。
（`.pet-quicknote-close` 样式 index.html 已有，无需新增。）

- [ ] **Step 2: 验证**

Run: `npx vitest run && npx tsc --noEmit`
手工：⌥Space 呼出输入条，× 收起（内容不落盘），从输入条边缘长按可拖动。

- [ ] **Step 3: 提交**

```bash
git add src/overlay/quick-note.ts
git commit -m "feat(f3): 速记输入条补关闭按钮与拖拽"
```

---

### Task 9: 提醒大卡片补拖拽 + ×（= 稍后 10 分钟）

**Files:**
- Modify: `src/overlay/bubble.ts`（顶部 import、Banner constructor 209-214 行、showReminder 的 head 构建 280-292 行）

**Interfaces:**
- Consumes: `enablePanelDrag`（直用，同 Task 8 理由——× 语义特殊走 snooze，不用 panelChrome 的 onClose）

- [ ] **Step 1: constructor 挂一次拖拽**

`src/overlay/bubble.ts` 顶部加 `import { enablePanelDrag } from "./panel-drag";`。
Banner constructor 末尾加：

```ts
    // 提醒大卡片可拖（把手 = 卡片头）。只在 reminder 模式存在 head，
    // 简单通知条没有 head 不会误拖；构造时挂一次，show 重建内容不重复挂。
    enablePanelDrag(this.el, ".pet-banner-head");
```

- [ ] **Step 2: showReminder 的 head 追加 ×**

`showReminder()` 中 `head.append(icon, tag, time);` 替换为：

```ts
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
```

- [ ] **Step 3: 验证**

Run: `npx vitest run && npx tsc --noEmit`
手工：设一条 1 分钟后的提醒，触发后卡片可从头部拖动；点 × 卡片消失，10 分钟后重响（证明走的是 snooze 而非删除）。

- [ ] **Step 4: 提交**

```bash
git add src/overlay/bubble.ts
git commit -m "feat(f3): 提醒大卡片补拖拽与 ×（稍后语义）"
```

---

### Task 10: 手工全量验证 + 版本合入

**Files:**
- Modify: `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`（版本三处）

- [ ] **Step 1: 手工验证清单（`pnpm tauri dev`）**

- [ ] 设置：三级页面（主/插件清单/插件表单）标题栏均可拖拽，返回与 × 正常
- [ ] 关于：从设置进入有「‹ 返回设置」，× 关闭，标题栏可拖
- [ ] 好友 / 每日提醒 / 形象选择：拖拽 + × 正常（形象选择的 × 提示仍是「稍后再选」）
- [ ] 今日速记 / 插件面板：可拖拽（本次新增），× 正常
- [ ] 速记输入条：× 收起不保存；边缘长按可拖
- [ ] 提醒大卡片：可拖、× = 稍后 10 分钟重响
- [ ] 宠物气泡、右键菜单：行为不变

- [ ] **Step 2: 全量检查**

Run: `npx tsc --noEmit && npx vitest run && cd src-tauri && cargo test`
Expected: 全绿（Rust 未改，cargo test 为回归确认）

- [ ] **Step 3: 版本号（问用户，不许自己编）**

向用户确认本次合入的版本号，然后把三处 `version` 改成该值：
`src-tauri/tauri.conf.json`（真源）、`src-tauri/Cargo.toml`、`package.json`。

- [ ] **Step 4: 合入提交**

```bash
git add -A
git commit -m "feat: 所有面板统一拖拽与关闭按钮

版本: <用户给的版本号>

- panelChrome 统一构建标题栏（返回 + 标题 + × + 长按拖拽），
  七个持久面板全部迁移，五处手抄关闭按钮代码删除
- 今日速记 / 插件面板补拖拽；速记输入条补 ×（丢弃语义）与拖拽
- 提醒大卡片补拖拽与 ×（语义 = 稍后 10 分钟，绝不误删）

验证：vitest N 绿 / tsc 通过 / cargo test N 绿 / 手工清单过"
```
