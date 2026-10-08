// src/mc/skinlib.ts
/**
 * 皮肤库前端访问层：invoke 薄包 + 错误码中文映射 + 注册表联动。
 * Rust 侧只回脱敏错误码（mcskin.rs 的 SkinError::as_str），本层负责
 * 映射成人话；绝不透传底层错误细节（隐私红线：错误不带内容）。
 */
import { invoke } from "@tauri-apps/api/core";
import { loadAndRegisterSkin } from "./loader";
import { getMcSkinResources } from "./skin-registry";

/** 与 Rust SkinMeta 对齐（serde snake_case）。 */
export interface SkinMetaView {
  id: string;
  name: string;
  imported_at: number;
}

/** 错误码 → 中文文案（规格 §7）。 */
const ERROR_TEXT: Record<string, string> = {
  "too-large": "文件太大（上限 64KB）",
  "not-png": "不是有效的 PNG",
  "bad-size": "尺寸不对（需要 64×64 或 64×32）",
  "limit-reached": "皮肤库已满（16 张）",
  "write-failed": "保存失败，请重试",
  "not-found": "皮肤不存在",
  "bad-id": "皮肤 id 无效",
  "in-use": "正在使用中，不能删除",
};

/** 错误码转中文；未知码给通用文案。invoke 的 Err 是 JSON 字符串。 */
export function skinErrorText(e: unknown): string {
  const code = typeof e === "string" ? e.replace(/"/g, "") : "";
  return ERROR_TEXT[code] ?? "操作失败，请重试";
}

export async function listSkins(): Promise<SkinMetaView[]> {
  return invoke<SkinMetaView[]>("mc_list_skins");
}

export async function importSkin(
  name: string,
  bytes: Uint8Array,
): Promise<SkinMetaView> {
  return invoke<SkinMetaView>("mc_import_skin", { name, bytes: Array.from(bytes) });
}

export async function deleteSkin(id: string): Promise<void> {
  await invoke("mc_delete_skin", { id });
}

export async function getSkinBytes(id: string): Promise<Uint8Array> {
  const bytes = await invoke<number[]>("mc_get_skin", { id });
  return new Uint8Array(bytes);
}

/**
 * 确保某 id 的皮肤已进注册表（未注册则从库读字节加载）。
 * 失败返回 false——调用方走回退链，不弹错。
 */
export async function ensureSkinLoaded(id: string): Promise<boolean> {
  if (getMcSkinResources(id)) return true;
  if (!/^[a-f0-9]{64}$/.test(id)) return false; // 内置 id 由 builtins.ts 负责
  try {
    const bytes = await getSkinBytes(id);
    return (await loadAndRegisterSkin(id, bytes)) !== null;
  } catch {
    return false;
  }
}
