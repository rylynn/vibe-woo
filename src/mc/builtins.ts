// src/mc/builtins.ts
/**
 * 内置 MC 皮肤（打包资产）：id 约定 builtin:<name>，永不落皮肤库目录。
 * Rust 侧 is_valid_id 只认 hex，内置 id 天然不可删除/读取（bad-id）。
 */
import { loadAndRegisterSkin } from "./loader";
import { getMcSkinResources } from "./skin-registry";
import defaultSkinUrl from "./assets/default-skin.png";
import defaultCatUrl from "./assets/default-cat.png";
import defaultDogUrl from "./assets/default-dog.png";
import type { McForm } from "./model";

/** 各形态的内置皮肤 id。 */
export const BUILTIN_SKIN_IDS: Record<McForm, string> = {
  player: "builtin:default",
  cat: "builtin:cat",
  dog: "builtin:dog",
};

export function builtinSkinId(form: McForm): string {
  return BUILTIN_SKIN_IDS[form];
}

/**
 * 注册全部内置皮肤（幂等：已注册跳过）。任一失败返回 false，绝不抛出
 * ——调用方（弹窗/启动链）据此走各自回退。
 */
export async function ensureBuiltinSkins(): Promise<boolean> {
  const pairs: [string, string][] = [
    [BUILTIN_SKIN_IDS.player, defaultSkinUrl],
    [BUILTIN_SKIN_IDS.cat, defaultCatUrl],
    [BUILTIN_SKIN_IDS.dog, defaultDogUrl],
  ];
  for (const [id, url] of pairs) {
    if (getMcSkinResources(id)) continue;
    try {
      const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
      if (!(await loadAndRegisterSkin(id, bytes))) return false;
    } catch {
      return false;
    }
  }
  return true;
}
