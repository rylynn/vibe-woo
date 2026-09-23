// src/mc/dev-toggle.ts
/**
 * 开发期切换入口（M1 PoC 验证用；M3 设置 UI 落地后移除）。
 * Ctrl+Alt+M 在当前形象与 MC 默认皮肤之间硬切——只改内存，
 * 绝不持久化（config.avatar 不动）。
 *
 * 宠物窗是非激活 NSPanel（红线：不抢焦点），永远拿不到键盘焦点，
 * window keydown 收不到事件——快捷键由 Rust 侧全局注册（shortcut.rs
 * 的 mc_dev_toggle，仅 debug 构建），经 pet://mc-dev-toggle 事件转发。
 */
import { listen } from "@tauri-apps/api/event";
import { DEFAULT_AVATAR, type PetAvatar } from "../avatar/types";
import type { Pet } from "../pet";
import { loadAndRegisterSkin } from "./loader";

const MC_DEV_AVATAR: PetAvatar = {
  kind: "minecraft",
  form: "player",
  skinId: "builtin:default",
};

export async function installMcDevToggle(
  pet: Pet,
  fetchSkin: () => Promise<Uint8Array>,
): Promise<void> {
  const bytes = await fetchSkin();
  const res = await loadAndRegisterSkin("builtin:default", bytes);
  if (!res) {
    console.warn("[mc-dev] 默认皮肤加载失败，切换入口未安装");
    return;
  }
  let on = false;
  let prev: PetAvatar = pet.currentAvatar;
  // 与应用同生命周期，无需退订
  await listen("pet://mc-dev-toggle", () => {
    on = !on;
    if (on) {
      prev = pet.currentAvatar;
      pet.setAvatar(MC_DEV_AVATAR);
    } else {
      pet.setAvatar(prev ?? DEFAULT_AVATAR);
    }
    console.log(`[mc-dev] ${on ? "Minecraft 形态" : "恢复参数形象"}`);
  });
}
