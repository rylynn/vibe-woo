# 设置面板直接换肤 设计稿

接续 M3（`2026-09-24-mc-forms-m3-design.md`，1.9.0 已合入）：皮肤库与形象弹窗 MC 页已交付，本设计把 MC 形象管理（形态切换 + 皮肤切换/导入/删除）直接做进设置面板的形象区块，不必每次打开形象弹窗。方案 A：抽共享 SkinGrid 组件，弹窗与设置面板共用。

## 1. 目标与非目标

**目标**
- 设置面板形象区块在 MC 形象下自足：形态行（玩家/猫/狗）+ 皮肤格（切换/导入/两击删除），点选即时生效并写入 config。
- 皮肤格逻辑单一实现：弹窗 MC 页与设置面板共用 `SkinGrid` 组件，零分叉。
- 修复 M3 漏网 bug：弹窗内猫/狗切「玩家」时 `mcSkinId` 残留 `builtin:cat`，导致猫贴图套玩家骨架（花屏）并写进 config。

**非目标**
- 参数形象相关 UI 不动（候选/从图片生成/弹窗参数页）。
- 猫/狗皮肤导入仍不支持（维持 M3 非目标：玩家 UV 与四足 UV 不兼容）。
- 访客皮肤同步（M4）。
- Rust 侧零改动：四命令（mc_import/list/delete/get）与 config schema（form + 任意 skin_id）原样复用。

## 2. 入口与可见性（设置面板·形象区块）

当前形象为 MC（任意形态）时，区块自上而下：

- 既有 48px 静态预览 + 「换一批」「从图片生成」按钮——保留（换一批仍通向弹窗完整体验与参数形象）。
- **形态行**：玩家/猫/狗三按钮（复用 `.pet-mc-form-btn` 样式，active 高亮当前形态）。
- **皮肤行**（SkinGrid）：仅玩家形态显示；猫/狗形态显示既有说明「猫/狗使用内置形象，皮肤仅对玩家形态生效」（`.pet-skin-note`）。

当前为参数形象或未领养：区块维持现状，不出现形态行/皮肤行（参数形象用户零打扰）。

## 3. 共享组件 `src/overlay/skin-grid.ts`

```ts
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

export class SkinGrid {
  /** 挂载点（div.pet-skin-grid），宿主 appendChild 到自己的容器。 */
  readonly el: HTMLDivElement;
  constructor(opts: SkinGridOpts);
  /** ensureBuiltinSkins + listSkins + 逐个 ensureSkinLoaded + 重建全部格子。 */
  refresh(): Promise<void>;
}
```

行为契约（与 M3 弹窗逐项对齐）：

- 格子三种：默认皮肤格（`builtin:default`，title「默认皮肤」，无删除钮）、库格（48px 静态预览 + 两击删除 ×）、「+」导入格（隐藏 file input，accept=image/png，title「导入 PNG 皮肤（64×64 / 64×32，≤64KB）」）。
- 两击删除：首击 × 变「确认」，再击才删；点格子本身取消（`pendingDelete` 组件内状态，宿主重建即重置）；× 的 click `ev.stopPropagation()` 防穿透选格。在用格（`inUseId()` 命中）× 禁用，title「使用中，不能删除」。
- 导入流程：文件名去 `.png` 后缀（空则「皮肤」）→ `importSkin(name, bytes)` → `ensureSkinLoaded(id)`：成功 → `refresh()` + `onPick(id)` 自动选中；解码失败（`ensureSkinLoaded` false）→ 错误行「皮肤载入失败，请重试」，不选中，库内保留。
- 删除流程：`deleteSkin(id)` → `refresh()` + `onRemoved(id)`；失败 → 错误行 `skinErrorText(e)`。
- 错误行 `.pet-skin-error` 行内中文文案，绝不弹系统框、不抢焦点。
- 皮肤名进 title；日志与错误不涉皮肤内容（隐私红线沿用）。

## 4. 形态切换归一化（两处宿主同规则）

会话内记住「上次玩家皮肤」：`lastPlayerSkin`，初值 `builtin:default`，宿主首次装配时若 config 为 MC 玩家形态则取其 `skin_id`；玩家形态下每次 `onPick(皮肤 id)` 同步更新。

切形态动作：

- 切到**玩家** → 皮肤用 `lastPlayerSkin`（弹窗：`mcSkinId = lastPlayerSkin`；设置：`patch({ avatar: { form: "player", skin_id: lastPlayerSkin } })`）。
- 切到**猫/狗** → 各自内置（`builtinSkinId(form)`；弹窗本就由 `mcPreviewAvatar()` 强制，设置直接 patch）。

由此修复跨形态泄漏：任何路径下玩家形态的 `skin_id` 只可能是 `builtin:default` 或皮肤库 hex id。

## 5. 数据流

**设置侧零新增 IPC、零新增装配接口**（`AvatarFlow` 不动）：

```
点皮肤格 onPick(id)
  → settings.patch({ avatar: { form: "player", skin_id: id } })
  → Rust apply_patch 落盘
  → onApply(cfg) → main.applyConfig → applyAvatarAsync
    （ensureBuiltinSkins → ensureSkinLoaded → setAvatar）
  → 宠物即时换装；settings.render() 重建，48px 预览更新
```

点形态按钮同链。格子可点 ⇒ 该皮肤必已注册（`SkinGrid.refresh` 先逐个 ensure），预览与宠物都不会空白。

实现口径：settings `render()` 是整体重建（replaceChildren 模式），SkinGrid 随每次 render 重建并 `refresh()`——一次本地 IPC（<1ms 级）+ N 次注册表命中，代价可忽略；`pendingDelete` 在无关 patch 后重置为未武装，与弹窗 re-render 行为一致。

**弹窗侧重构**（`avatar-picker.ts`）：

- `renderMcPage` 玩家形态分支挂 SkinGrid：`currentId: () => this.mcSkinId`；`inUseId: () => this.currentMcAvatar?.skinId ?? null`；`onPick: id => { this.mcSkinId = id; this.lastPlayerSkin = id; this.render(); this.startLoop(); }`；`onRemoved: id => { if (this.mcSkinId === id) { this.mcSkinId = BUILTIN_SKIN_IDS.player; this.lastPlayerSkin = BUILTIN_SKIN_IDS.player; } this.render(); this.startLoop(); }`。
- 删除 picker 内的 `mcSkins` / `mcError` / `pendingDelete` 字段与 `skinTile()` / `importSkinFile()` / `removeSkin()` 方法；`refreshMcSkins()` 简化为对新 grid `refresh()`（ensureBuiltinSkins 已挪进组件）。
- 形态按钮点击走 §4 归一化；`show()` 时若当前为 MC 玩家形态，`lastPlayerSkin` 初始化为其 `skin_id`。

## 6. 错误处理

- 导入/删除失败：SkinGrid 错误行（`skinErrorText` 八码中文映射 + 未知码兜底），与弹窗现状一致。
- 在用皮肤删除双保险：格子 × 禁用（前端 `inUseId()`）+ Rust `in-use` 守卫（config 真源）。
- avatar patch 走既有 `settings.patch()`（与其他设置行同语义）；payload 类型安全且 Rust untagged 反序列化已被 M3 测试锁死，无新增失败面。
- 设置面板打开时 `applyAvatarAsync` 尚未跑完的启动竞态：预览可能空一拍，下一次 render 自愈（现状同）。
- 跨面板删除使 `lastPlayerSkin` 失效（如设置面板记住 skinA 后经弹窗删掉）：切回玩家会 patch 失效 id——`applyAvatarAsync` 回退内置皮肤（宠物渲染正确），48px 预览空一拍，重选任意格自愈。与 M3 启动链「config 指向已删皮肤」的既有行为同构，不做额外守卫。

## 7. 测试策略

- overlay UI 沿用仓库口径「不单测、手工清单」（picker 先例）；纯逻辑层（skinlib 错误映射、模型/姿态）已有测试不动。
- 自动回归：`npx tsc --noEmit`、`npx vitest run`、`src-tauri` 下 `cargo check`（Rust 零改动，仅确认无破）。
- 手工清单：新建 `docs/plans/2026-10-09-settings-skin-verification.md`，约 12 项——设置面板形态切换（含猫→玩家皮肤恢复）、换肤即时生效、导入/删除/在用禁用、猫狗说明行、参数形象不受扰、弹窗 MC 页回归（含跨形态泄漏修复验证）、重启持久化。

## 8. 版本

**1.10.0**（用户已确认；自 1.9.0 加功能 = minor）。三处同步（`tauri.conf.json` / `Cargo.toml` / `package.json`）+ Cargo.lock + `version-notes.json` 摘要（≤50 字，随版本同次推送）。

## 9. 风险与缓解

- **SkinGrid 双宿主的选中态真源分叉**（弹窗=本地 `mcSkinId`，设置=config）：契约里 `currentId()`/`onPick()` 把真源留在宿主，组件无选中态字段，结构上杜绝。
- **设置 render 重建导致 grid 闪烁/IPC 放大**：列表是本地文件读 + 注册表内存命中，实测口径 <1ms；若观感有闪，再考虑实例复用（本设计不做）。
- **两处形态行样式漂移**：复用同一组 `.pet-mc-form-*` / `.pet-skin-*` 类，预计零新增 CSS；允许 1-2 行间距微调。
