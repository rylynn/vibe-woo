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
