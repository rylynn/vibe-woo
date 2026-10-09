# 设置面板直接换肤 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 MC 形象管理（形态切换 + 皮肤切换/导入/删除）直接做进设置面板的形象区块，弹窗与设置共用同一套 SkinGrid 组件，并修复弹窗猫/狗切玩家的皮肤残留 bug。

**Architecture:** 新建 `src/overlay/skin-grid.ts` 收拢皮肤格全部逻辑（默认格/库格/导入格/两击删除/行内错误，列表与确认态在组件内，选中真源经回调留在宿主）；弹窗 MC 页（Task 2）与设置面板形象区块（Task 3）各挂一份；设置侧零新增 IPC，全走既有 `settings.patch → onApply → applyConfig → applyAvatarAsync` 链；Rust 零改动。

**Tech Stack:** TypeScript 无框架（DOM + Canvas）、既有 skinlib 四命令、vitest/tsc 回归。

**规格来源:** `docs/superpowers/specs/2026-10-09-settings-skin-design.md`（已确认）。M3 皮肤库与弹窗实现见 `docs/superpowers/plans/2026-09-24-mc-forms-m3.md`。

## Global Constraints

- **版本号**：**1.10.0**（用户已确认，minor）。本里程碑所有 commit 都带 `版本: 1.10.0`；版本文件（`src-tauri/tauri.conf.json` / `src-tauri/Cargo.toml` / `package.json`，外加 `src-tauri/Cargo.lock` 与 `src-tauri/version-notes.json`）统一在 Task 4 落地。
- **不抢焦点**：删除二次确认绝不用 `window.confirm`，用「再点一次」DOM 模式；错误一律行内文案，不弹系统框。
- **隐私红线（沿用 M3）**：错误只回脱敏枚举（`skinErrorText` 映射），不透传底层细节；日志不记皮肤内容与用户命名；皮肤字节不进感知/插件/上报。
- **渲染层零改动**：MC 渲染管线（figure/pose/project/registry）一行不动；本计划只动 overlay 层与 CSS。
- **Rust 零改动**：四命令与 config schema 原样复用；Task 4 只跑 `cargo check` 确认版本联动无破。
- **注释、commit message 全中文**；commit 尾部带 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- **测试命令**：前端 `npx vitest run`、`npx tsc --noEmit`；Rust `cd src-tauri && export PATH=$HOME/.cargo/bin:$PATH && cargo check`。overlay UI 不单测（仓库口径，picker 先例），行为由手工清单覆盖。
- **文档提交**：`docs/superpowers/` 与 `docs/plans/` 在 .gitignore 内，提交计划/清单要 `git add -f <路径>`。
- **合入前全绿**：`npx tsc --noEmit`、`npx vitest run`、`src-tauri` 下 `cargo check`（本里程碑不动同步服务）。

## 共享参考（各任务按此实现，不许现场再发明）

### SkinGrid 组件契约（Task 1 定义，Task 2/3 消费）

```ts
export interface SkinGridOpts {
  currentId(): string;              // 当前选中皮肤 id（高亮判定）
  inUseId(): string | null;         // 正被 config 使用的皮肤 id（删除禁用）；无则 null
  onPick(id: string): void;         // 点格子或导入成功后的选中——宿主决定语义
  onRemoved(id: string): void;      // 删除成功后的回退通知
}
export class SkinGrid {
  readonly el: HTMLDivElement;      // div.pet-skin-grid，宿主负责 appendChild
  constructor(opts: SkinGridOpts);
  refresh(): Promise<void>;         // ensureBuiltinSkins + listSkins + 逐个 ensure + 重建格子
  syncTiles(): void;                // 按宿主最新 currentId/inUseId/pendingDelete 重绘（无 IPC）
  cancelPendingDelete(): void;      // 清「再点一次删除」确认态（宿主切页签/切形态时调用）
}
```

与规格 §3 的差异（加法，非冲突）：规格只列了 `el/constructor/refresh`；实现补 `syncTiles()`（持久实例模式下宿主 re-render 后刷新高亮，避免为一次高亮变化拉 IPC）与 `cancelPendingDelete()`（规格「宿主重建即重置」在持久实例模式下改为宿主显式取消）。规格 §5 的「settings render 重建 SkinGrid」相应改为「实例跨 render 复用、render 时 `syncTiles()`」——一次无关 patch 不再重拉列表，确认态由 `cancelPendingDelete` 显式清。

### lastPlayerSkin 归一化（规格 §4，两处宿主同规则）

- 会话字段初值 `BUILTIN_SKIN_IDS.player`；宿主观察到 config/当前形象为 MC 玩家形态时同步为其 `skin_id`；玩家形态下每次 `onPick(皮肤 id)` 再同步。
- 切到玩家 → 皮肤用 `lastPlayerSkin`；切到猫/狗 → `builtinSkinId(form)`。
- 由此修复：弹窗内猫/狗切「玩家」时 `mcSkinId` 残留 `builtin:cat`（猫贴图套玩家骨架花屏并写进 config）。

---

### Task 1: SkinGrid 皮肤格共享组件

**Files:**
- Create: `src/overlay/skin-grid.ts`

**Interfaces:**
- Consumes: `src/mc/builtins.ts` 的 `BUILTIN_SKIN_IDS` / `ensureBuiltinSkins`；`src/mc/skinlib.ts` 的 `listSkins` / `importSkin` / `deleteSkin` / `ensureSkinLoaded` / `skinErrorText` / `SkinMetaView`；`src/overlay/avatar-picker.ts` 的 `drawAvatarStill(canvas, avatar)`。
- Produces: 上方「共享参考」里的 `SkinGridOpts` / `SkinGrid`（Task 2/3 按名消费）。

- [ ] **Step 1: 创建组件文件（完整实现）**

创建 `src/overlay/skin-grid.ts`：

```typescript
// src/overlay/skin-grid.ts
import { BUILTIN_SKIN_IDS, ensureBuiltinSkins } from "../mc/builtins";
import {
  ensureSkinLoaded,
  importSkin,
  listSkins,
  deleteSkin,
  skinErrorText,
  type SkinMetaView,
} from "../mc/skinlib";
import { drawAvatarStill } from "./avatar-picker";

/** 宿主与皮肤格组件的契约（规格 2026-10-09 §3）：选中态真源留在宿主。 */
export interface SkinGridOpts {
  /** 当前选中皮肤 id（格子高亮判定）。 */
  currentId(): string;
  /** 正被 config 使用的皮肤 id（删除禁用）；无则 null。 */
  inUseId(): string | null;
  /** 点格子或导入成功后的选中——宿主决定语义（设置=patch config，弹窗=本地选中）。 */
  onPick(id: string): void;
  /** 删除成功后的回退通知（若宿主当前选中即被删 id，需换回默认）。 */
  onRemoved(id: string): void;
}

/**
 * MC 玩家皮肤格组件：默认格 + 库格（两击删除）+「+」导入格 + 行内错误行。
 *
 * 形象弹窗 MC 页与设置面板形象区块共用（单一实现零分叉）。列表与确认态
 * 收在组件内，实例跨宿主 render 复用（render 只重挂 el）；选中真源与
 * 删除守卫经 SkinGridOpts 回调留在宿主。UI 不进单测（仓库口径），行为由
 * docs/plans/2026-10-09-settings-skin-verification.md 手工清单覆盖。
 */
export class SkinGrid {
  /** 挂载点；宿主负责 appendChild（宿主 render 重建时重挂即可，列表状态不丢）。 */
  readonly el: HTMLDivElement;
  private skins: SkinMetaView[] = [];
  /** 删除二次确认：「再点一次」模式（不抢焦点，绝不用 window.confirm）。 */
  private pendingDelete: string | null = null;
  private error = "";

  constructor(private readonly opts: SkinGridOpts) {
    this.el = document.createElement("div");
    this.el.className = "pet-skin-grid";
  }

  /** ensureBuiltinSkins + 拉列表 + 逐个确保注册（格子静态预览依赖注册表）+ 重建格子。 */
  async refresh(): Promise<void> {
    try {
      await ensureBuiltinSkins();
      this.skins = await listSkins();
      for (const s of this.skins) {
        await ensureSkinLoaded(s.id);
      }
    } catch {
      this.skins = [];
    }
    this.renderTiles();
  }

  /** 按宿主最新 currentId/inUseId/pendingDelete 重绘格子（不拉列表、无 IPC）。 */
  syncTiles(): void {
    this.renderTiles();
  }

  /** 清「再点一次删除」确认态；宿主随后的 syncTiles 会重绘。 */
  cancelPendingDelete(): void {
    this.pendingDelete = null;
  }

  /** 重建全部格子与错误行（数据在组件内，宿主 render 重建不影响）。 */
  private renderTiles(): void {
    this.el.replaceChildren();
    this.el.appendChild(this.tile(BUILTIN_SKIN_IDS.player, "默认皮肤", false));
    for (const s of this.skins) {
      this.el.appendChild(this.tile(s.id, s.name, true));
    }
    // 导入格（隐藏 file input，与「从图片生成」同先例）
    const importTile = document.createElement("div");
    importTile.className = "pet-skin-tile pet-skin-import";
    importTile.textContent = "+";
    importTile.title = "导入 PNG 皮肤（64×64 / 64×32，≤64KB）";
    const fileInput = document.createElement("input");
    fileInput.type = "file";
    fileInput.accept = "image/png";
    fileInput.style.display = "none";
    importTile.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const file = fileInput.files?.[0];
      fileInput.value = "";
      if (file) void this.importFile(file);
    });
    this.el.append(importTile, fileInput);

    if (this.error) {
      const err = document.createElement("div");
      err.className = "pet-skin-error";
      err.textContent = this.error;
      this.el.appendChild(err);
    }
  }

  /** 皮肤格子：48px 静态预览 + 删除 ×（两击确认；使用中/内置禁用）。 */
  private tile(id: string, name: string, deletable: boolean): HTMLDivElement {
    const tile = document.createElement("div");
    tile.className = "pet-skin-tile";
    tile.title = name;
    tile.classList.toggle("selected", id === this.opts.currentId());

    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    drawAvatarStill(canvas, { kind: "minecraft", form: "player", skinId: id });
    tile.appendChild(canvas);

    tile.addEventListener("click", () => {
      this.pendingDelete = null; // 点格子取消进行中的删除确认
      this.opts.onPick(id); // 先让宿主更新选中真源，再重绘高亮
      this.renderTiles();
    });

    if (deletable) {
      const del = document.createElement("button");
      del.className = "pet-skin-del";
      const inUse = this.opts.inUseId() === id;
      del.disabled = inUse;
      del.textContent = this.pendingDelete === id ? "确认" : "×";
      del.title = inUse
        ? "使用中，不能删除"
        : this.pendingDelete === id
          ? "再点一次确认删除"
          : "删除";
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (this.pendingDelete === id) {
          void this.remove(id);
        } else {
          this.pendingDelete = id;
          this.renderTiles();
        }
      });
      tile.appendChild(del);
    }
    return tile;
  }

  private async importFile(file: File): Promise<void> {
    this.error = "";
    this.pendingDelete = null;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const name = file.name.replace(/\.png$/i, "") || "皮肤";
      const meta = await importSkin(name, bytes);
      if (!(await ensureSkinLoaded(meta.id))) {
        // PNG 头合法但像素不可解码：留在库内不选中，行内提示（M3 行为）
        this.error = "皮肤载入失败，请重试";
        this.renderTiles();
        return;
      }
      await this.refresh();
      this.opts.onPick(meta.id);
    } catch (e) {
      this.error = skinErrorText(e);
      this.renderTiles();
    }
  }

  private async remove(id: string): Promise<void> {
    this.pendingDelete = null;
    this.error = "";
    try {
      await deleteSkin(id);
    } catch (e) {
      this.error = skinErrorText(e);
      this.renderTiles();
      return;
    }
    await this.refresh();
    this.opts.onRemoved(id);
  }
}
```

- [ ] **Step 2: 编译 + 回归**

Run: `npx tsc --noEmit && npx vitest run`
Expected: tsc 零错误（新文件自含，`drawAvatarStill` 单向引用 avatar-picker，此刻无环）；vitest 全绿（组件无单测，跑全量防意外）。

- [ ] **Step 3: Commit**

```bash
git add src/overlay/skin-grid.ts
git commit -m "feat(overlay): 抽离 SkinGrid 皮肤格共享组件——默认/库/导入格、两击删除、行内错误

版本: 1.10.0

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: 弹窗 MC 页改挂 SkinGrid + lastPlayerSkin 归一化（修跨形态残留）

**Files:**
- Modify: `src/overlay/avatar-picker.ts:16-28`（import 段）
- Modify: `src/overlay/avatar-picker.ts:203-214`（MC 页字段段）
- Modify: `src/overlay/avatar-picker.ts:239-259`（show）
- Modify: `src/overlay/avatar-picker.ts:299-305`（页签点击）
- Modify: `src/overlay/avatar-picker.ts:451-469`（refreshMcSkins 删除）
- Modify: `src/overlay/avatar-picker.ts:471-631`（renderMcPage 重写；skinTile/importSkinFile/removeSkin 删除）

**Interfaces:**
- Consumes: Task 1 的 `SkinGrid` / `SkinGridOpts`；`BUILTIN_SKIN_IDS` / `builtinSkinId`（既有）。
- Produces: picker 私有 `lastPlayerSkin: string`、`mcGrid: SkinGrid | null`（Task 3 不依赖，仅行为对齐「共享参考」归一化规则）。

- [ ] **Step 1: import 段替换**

`avatar-picker.ts` 16-28 行的 builtins/skinlib 两段 import 整体替换为：

```typescript
import { BUILTIN_SKIN_IDS, builtinSkinId } from "../mc/builtins";
import { SkinGrid } from "./skin-grid";
```

（`ensureSkinLoaded` / `importSkin` / `listSkins` / `deleteSkin` / `skinErrorText` / `SkinMetaView` / `ensureBuiltinSkins` 的使用全部随本任务迁入 skin-grid.ts。）

- [ ] **Step 2: MC 页字段段替换**

203-214 行（`private tab` 到 `private mcPreview` 段）替换为：

```typescript
  /** 当前页签。 */
  private tab: "parametric" | "mc" = "parametric";
  private mcForm: McForm = "player";
  private mcSkinId = BUILTIN_SKIN_IDS.player;
  /** 会话内上次玩家皮肤：猫/狗切回玩家时恢复（规格 2026-10-09 §4）。 */
  private lastPlayerSkin = BUILTIN_SKIN_IDS.player;
  /** 打开弹窗时的当前形象（MC 时直接落在 MC 页并选中）。 */
  private currentMcAvatar: McAvatar | null = null;
  /** MC 页动画预览槽。 */
  private mcPreview: PreviewSlot | null = null;
  /** 皮肤格组件：实例跨 render 复用（render 只重挂 el），列表/确认态不丢。 */
  private mcGrid: SkinGrid | null = null;
```

- [ ] **Step 3: show() 替换**

239-259 行的 `show` 整体替换（删 `refreshMcSkins` 调用与 `pendingDelete`/`mcError` 赋值；玩家形态恢复上次皮肤）：

```typescript
  /** 打开并生成一批候选。current 为 MC 形象时直接落在 MC 页并选中。 */
  show(initial?: PetAvatar[], current?: PetAvatar): void {
    this.el.style.display = "block";
    this.open = true;
    this.currentMcAvatar = current && isMcAvatar(current) ? current : null;
    this.tab = this.currentMcAvatar ? "mc" : "parametric";
    if (this.currentMcAvatar) {
      this.mcForm = this.currentMcAvatar.form;
      // 玩家形态记住 config 皮肤作为「上次玩家皮肤」；猫/狗切回玩家时恢复它
      if (this.mcForm === "player") this.lastPlayerSkin = this.currentMcAvatar.skinId;
      this.mcSkinId = this.mcForm === "player"
        ? this.lastPlayerSkin
        : BUILTIN_SKIN_IDS.player;
    } else {
      this.mcForm = "player";
      this.mcSkinId = BUILTIN_SKIN_IDS.player;
    }
    this.candidates = initial ?? generateCandidates(Math.random);
    this.selected = -1;
    this.render();
    this.startLoop();
  }
```

- [ ] **Step 4: 页签点击改取消确认态**

render() 里页签按钮的 click 监听（299-305 行）中 `this.pendingDelete = null;` 一行改为：

```typescript
        this.mcGrid?.cancelPendingDelete();
```

- [ ] **Step 5: 删 refreshMcSkins，重写 renderMcPage，删三个旧方法**

451-469 行的 `refreshMcSkins` 方法整体删除（其职责并入 `SkinGrid.refresh`，首次 refresh 由 renderMcPage 创建实例时触发）。

471-548 行的 `renderMcPage` 整体替换为：

```typescript
  /** MC 页：形态行 + 动画预览 + 皮肤格（玩家）或说明（猫/狗）。 */
  private renderMcPage(): void {
    const formRow = document.createElement("div");
    formRow.className = "pet-mc-form-row";
    for (const [form, label] of [
      ["player", "玩家"],
      ["cat", "猫"],
      ["dog", "狗"],
    ] as const) {
      const btn = document.createElement("button");
      btn.className = "pet-mc-form-btn";
      btn.textContent = label;
      btn.classList.toggle("active", this.mcForm === form);
      btn.addEventListener("click", () => {
        this.mcForm = form;
        // 归一化（规格 §4）：切回玩家恢复上次玩家皮肤——修复猫/狗皮肤
        // id 残留到玩家形态（猫贴图套玩家骨架）的跨形态泄漏
        if (form === "player") this.mcSkinId = this.lastPlayerSkin;
        this.mcGrid?.cancelPendingDelete();
        this.render();
        this.startLoop(); // render 顶部 stopLoop，重渲染后必须重启动画循环，否则预览空白
      });
      formRow.appendChild(btn);
    }
    this.el.appendChild(formRow);

    const preview = document.createElement("canvas");
    preview.className = "pet-mc-preview";
    preview.width = PREVIEW_SIDE;
    preview.height = PREVIEW_SIDE;
    const pctx = preview.getContext("2d");
    this.el.appendChild(preview);
    if (pctx) {
      pctx.imageSmoothingEnabled = false;
      this.mcPreview = {
        canvas: preview,
        ctx: pctx,
        driver: new PreviewDriver(Math.random, this.startMs),
        expr: new MicroExpression(),
        phaseOffset: 0,
      };
    }

    if (this.mcForm === "player") {
      if (!this.mcGrid) {
        this.mcGrid = new SkinGrid({
          currentId: () => this.mcSkinId,
          inUseId: () => this.currentMcAvatar?.skinId ?? null,
          onPick: (id) => {
            this.mcSkinId = id;
            this.lastPlayerSkin = id;
            this.render();
            this.startLoop(); // render 顶部 stopLoop，重渲染后必须重启动画循环
          },
          onRemoved: (id) => {
            if (this.mcSkinId === id) {
              this.mcSkinId = BUILTIN_SKIN_IDS.player;
              this.lastPlayerSkin = BUILTIN_SKIN_IDS.player;
            }
            this.render();
            this.startLoop();
          },
        });
        void this.mcGrid.refresh();
      }
      // render 的 replaceChildren 会把 el 摘下来——重挂即可，列表状态在组件里
      this.el.appendChild(this.mcGrid.el);
      this.mcGrid.syncTiles();
    } else {
      const note = document.createElement("div");
      note.className = "pet-skin-note";
      note.textContent = "猫/狗使用内置形象，皮肤仅对玩家形态生效";
      this.el.appendChild(note);
    }
  }
```

550-631 行的 `skinTile` / `importSkinFile` / `removeSkin` 三个方法整体删除（逻辑已入 SkinGrid）。

- [ ] **Step 6: 编译 + 回归 + 残留检查**

Run:
```bash
npx tsc --noEmit && npx vitest run
grep -n "pendingDelete\|mcError\|mcSkins\|skinTile\|importSkinFile\|removeSkin\|refreshMcSkins" src/overlay/avatar-picker.ts
```
Expected: 前两条全绿；grep 无输出（旧字段/方法残留清零——skin-grid.ts 里的同名成员不算，grep 只查本文件）。

- [ ] **Step 7: Commit**

```bash
git add src/overlay/avatar-picker.ts
git commit -m "refactor(avatar): 弹窗 MC 页改挂 SkinGrid；切回玩家恢复上次皮肤（修跨形态残留）

版本: 1.10.0

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 设置面板形象区块接形态行 + 皮肤格

**Files:**
- Modify: `src/overlay/settings.ts:20-21`（import 段）
- Modify: `src/overlay/settings.ts:86-92`（类字段段）
- Modify: `src/overlay/settings.ts:366-411`（rowAvatar 重写 + mcFormRow 新增）
- Modify: `index.html:1548` 之后（CSS 追加）

**Interfaces:**
- Consumes: Task 1 的 `SkinGrid`；`../avatar/types` 的 `isMcConfigView`（既有导出）；`../mc/builtins` 的 `BUILTIN_SKIN_IDS` / `builtinSkinId`；`../mc/model` 的 `McForm`。
- Produces: 无对外新接口（settings 私有 `lastPlayerSkin` / `skinGrid` / `mcFormRow`；`AvatarFlow` 与 main.ts 装配零改动）。

- [ ] **Step 1: import 段扩**

`settings.ts` 20-21 行：

```typescript
import { avatarFromView, type PetAvatar } from "../avatar/types";
import { drawAvatarStill } from "./avatar-picker";
```

替换为：

```typescript
import {
  avatarFromView,
  isMcConfigView,
  type McConfigView,
  type PetAvatar,
} from "../avatar/types";
import { drawAvatarStill } from "./avatar-picker";
import { SkinGrid } from "./skin-grid";
import { BUILTIN_SKIN_IDS, builtinSkinId } from "../mc/builtins";
import type { McForm } from "../mc/model";
```

- [ ] **Step 2: 类字段加两行**

`settings.ts` 86 行 `private capturing` 段之后（构造器之前）加：

```typescript
  /** 会话内上次玩家皮肤：猫/狗切回玩家时恢复（规格 2026-10-09 §4）。 */
  private lastPlayerSkin = BUILTIN_SKIN_IDS.player;
  /** 皮肤格组件：实例跨 render 复用，render 只重挂 el（与弹窗同模式）。 */
  private skinGrid: SkinGrid | null = null;
```

- [ ] **Step 3: rowAvatar 重写 + mcFormRow 新增**

366 行起的 `rowAvatar` 整体替换为（保留原有预览/换一批/从图片生成逻辑，MC 时追加形态行与皮肤格/说明行）：

```typescript
  /** 形象区块：当前形象 48px 预览 + 换一批 / 从图片生成；MC 时再加形态行与皮肤格。 */
  private rowAvatar(c: ConfigView): HTMLElement {
    const r = this.row("形象");

    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    canvas.className = "pet-settings-avatar";
    canvas.title = c.avatar ? "当前形象" : "尚未领养形象";
    if (c.avatar) drawAvatarStill(canvas, avatarFromView(c.avatar));
    r.appendChild(canvas);

    const flow = this.avatarFlow;
    if (flow) {
      const reroll = document.createElement("button");
      reroll.className = "pet-avatar-btn";
      reroll.textContent = "换一批";
      reroll.addEventListener("click", () => flow.openPicker());
      r.appendChild(reroll);

      if (flow.analyzeImage) {
        const fromImage = document.createElement("button");
        fromImage.className = "pet-avatar-btn";
        fromImage.textContent = "从图片生成";
        const input = document.createElement("input");
        input.type = "file";
        input.accept = "image/*";
        input.style.display = "none";
        fromImage.addEventListener("click", () => input.click());
        input.addEventListener("change", () => {
          const file = input.files?.[0];
          input.value = "";
          if (!file || !flow.analyzeImage) return;
          void flow
            .analyzeImage(file)
            .then((list) => {
              if (list.length > 0) flow.openPicker(list);
            })
            .catch((e) => console.warn("[avatar] 图片分析失败", e));
        });
        r.append(fromImage, input);
      }
    }

    // —— MC 形象：形态行 + 皮肤格/说明行（规格 2026-10-09 §2）——
    // 参数形象/未领养不显示（参数形象用户零打扰），参数↔MC 往返仍走弹窗
    const v = c.avatar;
    if (!(v && isMcConfigView(v))) return r;
    if (v.form === "player") this.lastPlayerSkin = v.skin_id;

    const block = document.createElement("div");
    block.className = "pet-settings-avatar-mc";
    block.appendChild(this.mcFormRow(v.form));
    if (v.form === "player") {
      if (!this.skinGrid) {
        this.skinGrid = new SkinGrid({
          // 设置侧真源是 config 本身（点格即 patch，无本地选中态）
          currentId: () => {
            const a = this.cfg?.avatar;
            return a && isMcConfigView(a) && a.form === "player" ? a.skin_id : "";
          },
          inUseId: () => {
            const a = this.cfg?.avatar;
            return a && isMcConfigView(a) ? a.skin_id : null;
          },
          onPick: (id) => {
            void this.patch({ avatar: { form: "player", skin_id: id } });
          },
          // 在用守卫使 config 当前皮肤不可删，删除不会改变当前形象，无需回退
          onRemoved: () => {},
        });
        void this.skinGrid.refresh();
      }
      // render 的 replaceChildren 会把 el 摘下来——重挂并按最新 config 刷高亮
      this.skinGrid.cancelPendingDelete();
      block.appendChild(this.skinGrid.el);
      this.skinGrid.syncTiles();
    } else {
      const note = document.createElement("div");
      note.className = "pet-skin-note";
      note.textContent = "猫/狗使用内置形象，皮肤仅对玩家形态生效";
      block.appendChild(note);
    }

    const wrap = document.createElement("div");
    wrap.appendChild(r);
    wrap.appendChild(block);
    return wrap;
  }

  /** MC 形态行：玩家/猫/狗三按钮，点选即 patch（规格 §4 归一化）。 */
  private mcFormRow(current: McForm): HTMLElement {
    const row = document.createElement("div");
    row.className = "pet-mc-form-row";
    for (const [form, label] of [
      ["player", "玩家"],
      ["cat", "猫"],
      ["dog", "狗"],
    ] as const) {
      const btn = document.createElement("button");
      btn.className = "pet-mc-form-btn";
      btn.textContent = label;
      btn.classList.toggle("active", current === form);
      btn.addEventListener("click", () => {
        if (current === form) return;
        this.skinGrid?.cancelPendingDelete();
        void this.patch({
          avatar:
            form === "player"
              ? { form: "player", skin_id: this.lastPlayerSkin }
              : { form, skin_id: builtinSkinId(form) },
        });
      });
      row.appendChild(btn);
    }
    return row;
  }
```

（注 1：`McConfigView` 仅用于 `isMcConfigView` 的类型收窄完整性，若 tsc 报未使用则从 import 列表去掉它。
注 2：上半段「预览 canvas + 换一批 + 从图片生成」是现状保留——以 settings.ts 现有实现为准逐字保留；下方代码块若与现有实现有细微出入（类名、console 文案等），保现有、不改写。本次改动的实质是后半段 MC 区块与返回结构。）

- [ ] **Step 4: index.html 追加 CSS**

`.pet-skin-error` 规则（约 1548 行）之后追加（对齐设置行内容左缘（14px 行内边距 + 74px 标签 + 10px 间距），其余复用弹窗既有类）：

```css
      /* —— 设置面板形象区块的 MC 形态行/皮肤格（对齐行内容左缘）—— */
      .pet-settings-avatar-mc { margin: 0 14px 8px 98px; }
      .pet-settings-avatar-mc .pet-mc-form-row { margin: 0 0 4px; }
      .pet-settings-avatar-mc .pet-skin-grid { margin: 0; }
      .pet-settings-avatar-mc .pet-skin-note { margin: 0; }
      .pet-settings-avatar-mc .pet-skin-error { margin: 4px 0 0; }
```

- [ ] **Step 5: 编译 + 回归**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 全绿（settings 无既有单测；全量防意外）。

- [ ] **Step 6: Commit**

```bash
git add src/overlay/settings.ts index.html
git commit -m "feat(settings): 设置面板形象区块接形态行与皮肤格——直接切换/导入/删除

版本: 1.10.0

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 版本 1.10.0 落地 + 手工验证清单 + 合入检查

**Files:**
- Modify: `src-tauri/tauri.conf.json`（version）
- Modify: `src-tauri/Cargo.toml`（version）
- Modify: `package.json`（version）
- Modify: `src-tauri/Cargo.lock`（cargo check 自动更新 vibe-pet 条目）
- Modify: `src-tauri/version-notes.json`（加 1.10.0 条目）
- Create: `docs/plans/2026-10-09-settings-skin-verification.md`（手工清单）

**Interfaces:**
- Consumes: 无代码依赖（Task 1-3 全部合入后执行）。
- Produces: 版本 1.10.0 三处同步 + 升级气泡文案 + 手工验证清单。

- [ ] **Step 1: 三处版本号同步 1.10.0**

`src-tauri/tauri.conf.json`：`"version": "1.9.0"` → `"1.10.0"`。
`src-tauri/Cargo.toml`：`version = "1.9.0"` → `"1.10.0"`。
`package.json`：`"version": "1.9.0"` → `"1.10.0"`。

Run: `cd src-tauri && export PATH=$HOME/.cargo/bin:$PATH && cargo check`
Expected: 通过；Cargo.lock 的 vibe-pet 版本条目自动更新为 1.10.0。

- [ ] **Step 2: version-notes.json 加升级气泡文案**

`src-tauri/version-notes.json` 的平铺映射加一行（21 字，≤50）：

```json
  "1.10.0": "设置面板直接管理 MC 形象：形态切换与皮肤导入删除"
```

- [ ] **Step 3: 写手工验证清单**

创建 `docs/plans/2026-10-09-settings-skin-verification.md`：

```markdown
# 设置面板直接换肤 手工验证清单

前置：`pnpm tauri dev` 启动；准备一张合法 64×64 PNG 皮肤与一张坏 PNG（可选）。
建议先在形象弹窗把形象切到 MC 玩家形态。

## 1. 设置面板 · 形态与皮肤
- [ ] MC 玩家形态打开设置：形象区块出现形态行（玩家高亮）与皮肤格；参数形象/未领养时无此区块
- [ ] 点库皮肤格：宠物即时换装，格子高亮跟随；重启后保持
- [ ] 点默认皮肤格：回默认皮肤
- [ ] 形态行切猫/狗：宠物变身，皮肤格换成说明行；切回玩家：恢复上次玩家皮肤（非默认）
- [ ] 「换一批」仍打开形象弹窗且落在 MC 页

## 2. 设置面板 · 导入与删除
- [ ] 「+」导入合法 PNG：新格出现并即时换装
- [ ] 导入超大/非 PNG：行内中文提示，不弹系统框、不抢焦点
- [ ] 删除未使用皮肤：× 变「确认」，再点才删；改其他设置项后确认态自动取消
- [ ] 当前在用皮肤：× 禁用（悬停提示使用中）

## 3. 形象弹窗回归
- [ ] 弹窗 MC 页皮肤格/导入/两击删除照常；确认换肤后重开设置回显一致
- [ ] 当前为猫/狗时弹窗切「玩家」：预览为玩家皮肤（默认或上次玩家皮肤），绝无猫/狗贴图套玩家骨架（本次修复项）
- [ ] 首次领养（无 config）：弹窗双页签订夺正常
- [ ] dev 构建按 Ctrl+Alt+M 无反应（回归）

## 4. 性能与合入
- [ ] 待机 1 分钟：活动监视器 CPU < 1%（渲染层零改动，回归确认）
- [ ] `npx tsc --noEmit` / `npx vitest run` / `cargo check` 全绿
```

- [ ] **Step 4: 合入前全绿**

Run:

```bash
npx tsc --noEmit
npx vitest run
cd src-tauri && export PATH=$HOME/.cargo/bin:$PATH && cargo check
```

Expected: 三项全绿。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock package.json src-tauri/version-notes.json
git add -f docs/plans/2026-10-09-settings-skin-verification.md
git commit -m "chore(release): 设置面板直接换肤收尾——版本 1.10.0、升级气泡、手工验证清单

版本: 1.10.0

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 自审记录（writing-plans Self-Review）

**1. 规格覆盖**（规格章节 → 任务）：
- §1 目标（设置自足管理 / 共享组件 / 修跨形态泄漏）→ Task 1（组件）+ Task 2（弹窗重构+修复）+ Task 3（设置接入）。
- §2 入口与可见性（MC 才显示；猫/狗说明行；参数形象零打扰）→ Task 3 Step 3。
- §3 SkinGrid 契约 → Task 1；差异（syncTiles/cancelPendingDelete/实例复用）已在「共享参考」声明为加法调整。
- §4 lastPlayerSkin 归一化 → Task 2 Step 3/5（弹窗）+ Task 3 Step 3（设置）。
- §5 数据流（零新增 IPC；AvatarFlow 不动）→ Task 3 全部走既有 patch 链，main.ts 零改动。
- §6 错误处理（行内文案/双保险守卫/解码失败不选中）→ Task 1 importFile/remove。
- §7 测试策略（不单测；回归三件套；手工清单）→ 各 Task 验证步 + Task 4 清单。
- §8 版本 1.10.0 → Task 4。
- 非目标（参数形象 UI/猫狗皮肤/M4/Rust 改动）→ 均未触碰。

**2. 占位符扫描**：无 TBD/TODO/「类似 Task N」；所有代码块完整可誊写；Task 3 Step 3 的「注」是可执行的 tsc 处理指令而非占位。

**3. 类型一致性**：
- `SkinGridOpts` 四成员名（currentId/inUseId/onPick/onRemoved）Task 1 定义 = Task 2/3 使用 ✓。
- `SkinGrid` 公有成员 `el/refresh/syncTiles/cancelPendingDelete` 三任务一致 ✓。
- `lastPlayerSkin` 语义两宿主一致（初值 `BUILTIN_SKIN_IDS.player`，config 为 MC 玩家时同步，onPick 时同步）✓。
- `isMcConfigView`/`McConfigView` 为 `src/avatar/types.ts` 既有导出（M3 Task 5）✓。
- patch payload `{ form, skin_id }` 与 `ConfigPatch.avatar: AvatarConfigView` 的 `McConfigView` 对齐 ✓。

**4. 与规格的两处有意识偏差（已声明，非疏漏）**：
- Task 3 CSS 实际 6 行（规格 §9 写「预计零新增 CSS；允许 1-2 行间距微调」）：弹窗类自带 `margin: 10px 14px 2px` 等页内间距，直接塞进设置行结构会双重缩进、左缘错位，必须归零重设。全部是 margin/对齐覆写，零新增视觉语言，属 §9 精神内的间距微调。
- `SkinGrid` 实例跨 render 复用（规格 §5 写「settings render 整体重建 SkinGrid 并 refresh」）：避免每次无关 patch 重拉列表与重建 17 张画布；高亮由 `syncTiles()` 无 IPC 刷新，确认态由 `cancelPendingDelete()` 显式清——行为与规格「宿主重建即重置」等价。
