import { invoke } from "@tauri-apps/api/core";

/** 关于面板展示的信息。字段与后端 `AppInfo` 一一对应。 */
export interface AppInfo {
  /** 产品名。 */
  name: string;
  /** 版本号，形如 "0.1.0"。 */
  version: string;
  /** 包标识符，形如 "dev.vibepet.app"。 */
  identifier: string;
  /** 构建时间（UTC）。 */
  build_time: string;
  /** 构建时的 git 短哈希，拿不到时为 "unknown"。 */
  git_hash: string;
  /** 构建档：debug / release。 */
  profile: string;
  /** 操作系统与架构，形如 "macos · aarch64"。 */
  platform: string;
}

/**
 * 非 Tauri 环境（纯浏览器调试）的回落值。
 *
 * 只有浏览器调试才走得到这里 —— 版本号真源在 tauri.conf.json，
 * 正常运行时由后端 `get_app_info` 给出。
 */
export const FALLBACK_APP_INFO: AppInfo = {
  name: "Vibe Pet",
  version: "dev",
  identifier: "dev.vibepet.app",
  build_time: "unknown",
  git_hash: "unknown",
  profile: "debug",
  platform: "browser",
};

/** 取版本与构建信息。失败时用回落值，不让「关于」面板开天窗。 */
export async function getAppInfo(): Promise<AppInfo> {
  try {
    return await invoke<AppInfo>("get_app_info");
  } catch (e) {
    console.warn("[about] 读取版本信息失败", e);
    return FALLBACK_APP_INFO;
  }
}

/** 拼一段可直接粘给开发者的版本串，报障时用。 */
export function formatAppInfo(info: AppInfo): string {
  return [
    `${info.name} v${info.version}`,
    `${info.platform} · ${info.profile}`,
    `build ${info.build_time}`,
    `git ${info.git_hash}`,
    info.identifier,
  ].join("\n");
}
