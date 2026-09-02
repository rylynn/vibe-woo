import { invoke } from "@tauri-apps/api/core";
import { getPluginFrontend } from "./registry";

/** plugin_summary 命令的返回项（与 Rust PluginMeta 契约一致）。 */
export interface PluginMeta {
  id: string;
  name: string;
  kind: string;
  summary: unknown;
}

/**
 * 插件设置的二级/三级页内容（设置面板负责导航，这里负责内容）。
 *
 * 二级页 = 插件清单（renderList）；三级页 = 单个插件的表单（renderPlugin）。
 * 加载 / 保存 / 空态由这里统一提供，每个插件只提供表单（renderSettings）。
 */
export class PluginSettingsShell {
  /** 二级页：插件清单。点某行进入它的配置页。 */
  renderList(into: HTMLElement, onOpen: (id: string) => void): void {
    into.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "pet-settings-hint";
    loading.textContent = "…";
    into.appendChild(loading);
    void this.loadList(into, onOpen);
  }

  private async loadList(
    into: HTMLElement,
    onOpen: (id: string) => void,
  ): Promise<void> {
    let metas: PluginMeta[] = [];
    try {
      metas = await invoke<PluginMeta[]>("plugin_summary");
    } catch {
      // 非 Tauri 环境（纯浏览器调试）
    }
    into.replaceChildren();
    if (metas.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pet-settings-hint";
      empty.textContent = "暂无已安装插件";
      into.appendChild(empty);
      return;
    }
    for (const m of metas) {
      const row = document.createElement("button");
      row.className = "pet-plugin-list-row";
      const name = document.createElement("span");
      name.textContent = m.name;
      const state = document.createElement("span");
      state.className = "pet-plugin-list-state";
      const enabled = !!(m.summary as { enabled?: boolean } | null)?.enabled;
      state.textContent = enabled ? "已启用" : "未启用";
      state.classList.add(enabled ? "on" : "off");
      row.append(name, state);
      row.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        onOpen(m.id);
      });
      into.appendChild(row);
    }
  }

  /** 三级页：单个插件的配置表单。 */
  renderPlugin(into: HTMLElement, id: string): void {
    into.replaceChildren();
    const loading = document.createElement("div");
    loading.className = "pet-settings-hint";
    loading.textContent = "…";
    into.appendChild(loading);
    void this.loadPlugin(into, id);
  }

  private async loadPlugin(into: HTMLElement, id: string): Promise<void> {
    let metas: PluginMeta[] = [];
    let cfg: unknown = null;
    try {
      metas = await invoke<PluginMeta[]>("plugin_summary");
      cfg = await invoke("plugin_get_config", { id });
    } catch {
      // 读不到配置（如插件后端未就绪）→ 表单用默认值
    }
    const meta = metas.find((m) => m.id === id);
    const fe = meta ? getPluginFrontend(meta.kind) : undefined;
    into.replaceChildren();
    if (!meta || !fe?.renderSettings) {
      const empty = document.createElement("div");
      empty.className = "pet-settings-hint";
      empty.textContent = "该插件暂无可配置项";
      into.appendChild(empty);
      return;
    }
    const head = document.createElement("div");
    head.className = "pet-plugin-settings-head";
    head.textContent = meta.name;
    into.appendChild(head);
    into.appendChild(fe.renderSettings(cfg, (next) => void this.save(id, next)));
  }

  private async save(id: string, cfg: unknown): Promise<void> {
    try {
      await invoke("plugin_set_config", { id, cfg });
    } catch (e) {
      console.warn("[plugin] 保存配置失败", e);
    }
  }
}
