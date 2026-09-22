// src/mc/dev-toggle.ts
/**
 * 开发期切换入口（M1 PoC 验证用；M3 设置 UI 落地后移除）。
 * Ctrl+Alt+M 在当前形象与 MC 默认皮肤之间硬切——只改内存，
 * 绝不持久化（config.avatar 不动）。
 */
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
  window.addEventListener("keydown", (e) => {
    if (!(e.ctrlKey && e.altKey && e.code === "KeyM")) return;
    e.preventDefault();
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
