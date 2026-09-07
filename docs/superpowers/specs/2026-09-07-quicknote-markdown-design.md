# 设计：速记 Markdown 富文本

日期：2026-09-07
状态：已与用户逐项确认
版本：**0.10.0**

用户原话：「速记功能：UI支持简单富文本能力，markdown编辑器优先。展示的时候也类似。参考一些备忘速记的软件能力」。

三个交互决策经 AskUserQuestion 逐项确认：

| 决策点 | 结论 |
|---|---|
| 编辑器形态 | **源码编辑 + 快捷键**（保留 textarea，IME 最稳；所见即所写，落盘即源码，零渲染歧义） |
| 语法范围 | **行内四件套 + 任务列表**（粗体/斜体/链接/行内代码 + `- [ ]` 勾选框；标题/引用/代码块能写能存，面板不渲染，交给 Obsidian） |
| 面板展示 | **预览 + 点击展开**（预览行渲染首行行内语法，多行标「…N 行」，点击就地展开完整渲染，再点收起） |

---

## 目标

速记支持 Markdown 轻量富文本：输入时用快捷键与自动续行降低语法记忆负担，落盘即源码（Obsidian 无缝衔接），今日面板富文本回看。

## 非目标

- 不做 WYSIWYG、分栏实时预览（已否决）
- 不做编辑/删除/搜索 —— 「捕获看一眼，整理去 Obsidian」定位不变（`today.ts` 模块头注释的哲学保留）
- 任务勾选框**只读展示**（☐/☑），不可点击切换 —— 回写文件不符合「捕获」的定位
- 不渲染 `#` 标题 / `>` 引用 / 嵌套列表层级 —— 面板里原样显示，Obsidian 里完整渲染
- 不引入任何 markdown 渲染库（仓库前端零依赖手写的气质保持）

---

## 设计

### 1. 新模块 `src/overlay/md-inline.ts` —— 行内渲染器（纯函数，~100 行）

`renderInline(text: string): Node[]`，全 DOM API 构建（`textContent` 赋值，**绝不 innerHTML**，XSS 从结构上免疫）。

支持：

| 语法 | 渲染 |
|---|---|
| `**粗体**` | `<strong>` |
| `*斜体*` | `<em>` |
| `` `代码` `` | `<code>` |
| `[文字](https://…)` | `<a>`，走 opener 插件 `openUrl` 打开 |
| 行级 `- [ ]` / `- [x]` | 前缀替换为 ☐ / ☑ |

解析陷阱显式处理：

- `**` 优先于 `*`（先匹配双星）
- 未闭合标记原样显示（不吞字符）
- 标记内侧需非空白（`** 空 **` 不算粗体；防 `2*3*4` 数学乘号误伤）
- 链接 href 只放行 `^https?://`，其余 scheme 按纯文本

测试 ~12 例（含上述每个陷阱）。

### 2. quick-note.ts 编辑增强（文本变换抽纯函数 → `src/overlay/md-edit.ts`）

**快捷键（有选区→包裹；无选区→插入标记对、光标落中间；标记已存在→再按取消 toggle）**

| 键 | 效果 |
|---|---|
| ⌘B | `**粗体**` |
| ⌘I | `*斜体*` |
| ⌘K | `[链接]()`，光标落 `()` 内 |
| ⌘E | `` `代码` `` |

**自动续行（`continueList` 纯函数，Enter 拦截；null = 非列表行走默认换行）**

| 当前行首 | 下一行自动接 |
|---|---|
| `- ` / `* ` | `- ` |
| `1. ` | `2. `（数字递增） |
| `- [ ] ` / `- [x] ` | `- [ ] ` |
| 列表项**为空**时回车 | 结束列表（吃掉前缀出空行） |

**IME 关键约束**：Enter 拦截必须跳过 `keyCode === 229`（中文输入法候选确认键）—— 否则吞输入法的确认。⌘B 等组合键不受 IME 影响。

### 3. today.ts 展示升级

- 预览行渲染首行的行内语法（现在 `textContent` → 改 `renderInline`）
- 多行内容行尾标「…N 行」（替代现在的 `firstLine …`）
- **点击行就地展开**完整渲染：每行任务前缀 → ☐/☑，链接可点（`openUrl`，与插件卡片同一收口），再点收起
- 单行速记无展开态、保持现状
- hover title 纯文本兜底保留

### 4. note.rs 修两处往返失真（富文本下必须，顺手修正）

现状 `parse_line`（note.rs:178-196）有两个 bug：

1. **首行行内代码被吞成 tag**：`for tok in rest.split_whitespace()` 从中间抽 `` `token` `` —— 用户首行写 `` 回邮件 `tomorrow` ``，roundtrip 后 `tomorrow` 变 tag、文本丢失。
   **修复**：tag 只从**行尾往前扫连续** `` `tag` `` token（tags 本来就是 LLM 回填、追加在行尾的）；行中反引号归内容。
2. **续行缩进全剥**：`line.trim_start()` 把用户自己的嵌套缩进也剥掉。
   **修复**：`line.strip_prefix("  ")` 只剥落盘时我们加的 2 空格，保留用户缩进。

### 5. 存储零改动

源码即所存：`to_markdown` 格式（`- **HH:MM** 首行 \`tags\`` + 2 空格缩进续行）、文件名 `YYYY-MM-DD.md`、Obsidian vault 直写全部不动。旧文件新代码照读。「记录必须无条件先写盘」原则不受影响。

已知边界（可接受）：速记**首行**被嵌进 `- **HH:MM** ` 后面，首行的块级语法（如 `# 标题`）在 Obsidian 里也渲染不出块级效果 —— 这是现有格式的延续，且速记首行本就是摘要句，结构化内容会换行写（续行 2 空格缩进的 `- item` 在 Obsidian 里渲染为列表项子内容，正常）。

---

## 约束核对

| 约束 | 核对 |
|---|---|
| 不打扰 | 纯输入体验增强，无新增主动出声/出卡 |
| 不抢焦点 | 速记是 CLAUDE.md 明确允许的「临时取焦点输入场景」 |
| 纯逻辑可测 | `renderInline` / `renderLine` / `wrapSelection` / `wrapLink` / `continueList` / parse 修复全部纯函数 + 单测，DOM 驱动层薄 |
| CPU < 1% | 渲染只在打开面板/展开时发生，无循环渲染 |
| XSS | 渲染器全 DOM API `textContent`，链接 scheme 白名单 |

## 影响面

改动：`src/overlay/md-inline.ts`（新）、`src/overlay/md-edit.ts`（新）、`src/overlay/quick-note.ts`、`src/overlay/today.ts`、`src-tauri/src/note.rs`、`tests/`（新测试文件 + note.rs 既有测试扩展）。
不动：`notecmd.rs` 命令面、`add_note`/`list_today_notes` 契约、`Note` 结构、存储格式。
无新依赖（`@tauri-apps/plugin-opener` 已在用）。

## 测试清单

**前端（`tests/md-inline.test.ts` 新，happy-dom）**：四件套各渲染正确 / 未闭合原样 / 内侧空白不算标记 / `2*3*4` 不误伤 / 非 http(s) 链接按纯文本 / 任务前缀 ☐☑。

**前端（`tests/md-edit.test.ts` 新，node）**：wrapSelection 有选区包裹 / 无选区插标记对 / toggle 取消 / nextListPrefix 三种前缀 / 空列表项回车结束 / 数字递增。

**Rust（`note.rs` tests）**：首行行内代码 roundtrip 不丢 / 行中反引号归内容、行尾 `` `tag` `` 仍归 tag / 续行保留用户缩进（嵌套列表 roundtrip）。

## 合入检查

`npx tsc --noEmit` / `cargo check`（src-tauri）/ `npx vitest run` 全绿；
三处版本同步到 **0.10.0**：`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`。
