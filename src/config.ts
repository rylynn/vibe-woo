import { invoke } from "@tauri-apps/api/core";
import type { Reminder } from "./overlay/reminders";
import type { AvatarConfigView } from "./avatar/types";

/**
 * 人格四档（2026-09-03）：档位只约束闲聊（定时说话 + 事件反应）；
 * 插件卡片走独立通道，不受档位影响。
 * quiet=第一档（不闲聊）· reserved=第二档（10–15 分钟）
 * occasional=第三档（5–10 分钟）· chatty=第四档（1–5 分钟）
 */
export type Persona = "quiet" | "reserved" | "occasional" | "chatty";
export type RoamScope = "still" | "nearby" | "halfscreen" | "fullscreen";
export type LlmProtocol =
  | "openai-completions"
  | "openai-response"
  | "anthropic-messages";

export const LLM_PROTOCOLS: LlmProtocol[] = [
  "openai-completions",
  "openai-response",
  "anthropic-messages",
];

/** 后端返回的配置视图。api_key 已掩码，前端拿不到明文。 */
export interface ConfigView {
  size_index: number;
  notes_vault: string;
  roam_scope: RoamScope;
  persona: Persona;
  /** 用户自述的「平时主要在忙什么」。空串 = 未填写，宠物不预设任何身份。 */
  user_kind: string;
  autostart: boolean;
  reminders: Reminder[];
  /** 习惯记忆开关：每 12 小时用 LLM 归纳一次作息与风格，作为宠物说话的物料。 */
  habit_enabled: boolean;
  coding_apps: string[];
  browsing_apps: string[];
  excluded_apps: string[];
  llm_base_url: string;
  llm_model: string;
  llm_protocol: LlmProtocol;
  llm_enabled: boolean;
  llm_thinking: boolean;
  llm_api_key_masked: string;
  llm_has_key: boolean;
  social_server: string;
  social_uid: string;
  social_nick: string;
  social_pet_name: string;
  social_register_date: string;
  social_invite_code: string;
  social_hidden: boolean;
  /** 已领养的形象。null 表示首次安装未选择（前端应弹形象选择窗）。 */
  avatar: AvatarConfigView | null;
}

export interface ConfigPatch {
  size_index?: number;
  notes_vault?: string;
  roam_scope?: RoamScope;
  persona?: Persona;
  /** 传空串表示清空身份，宠物回退到中性表达。 */
  user_kind?: string;
  autostart?: boolean;
  reminders?: Reminder[];
  habit_enabled?: boolean;
  coding_apps?: string[];
  browsing_apps?: string[];
  excluded_apps?: string[];
  llm_base_url?: string;
  llm_model?: string;
  llm_protocol?: LlmProtocol;
  llm_enabled?: boolean;
  llm_thinking?: boolean;
  llm_api_key?: string;
  social_server?: string;
  social_hidden?: boolean;
  avatar?: AvatarConfigView;
}

export const FALLBACK_CONFIG: ConfigView = {
  size_index: 1,
  notes_vault: "",
  roam_scope: "nearby",
  persona: "quiet",
  user_kind: "",
  autostart: false,
  reminders: [],
  habit_enabled: true,
  coding_apps: [],
  browsing_apps: [],
  excluded_apps: [],
  llm_base_url: "",
  llm_model: "",
  llm_protocol: "openai-completions",
  llm_enabled: false,
  llm_thinking: false,
  llm_api_key_masked: "",
  llm_has_key: false,
  social_server: "",
  social_uid: "",
  social_nick: "",
  social_pet_name: "像素崽",
  social_register_date: "",
  social_invite_code: "",
  social_hidden: false,
  avatar: null,
};

export async function getConfig(): Promise<ConfigView> {
  try {
    return await invoke<ConfigView>("get_config");
  } catch {
    // 非 Tauri 环境（纯浏览器调试）
    return FALLBACK_CONFIG;
  }
}

export async function updateConfig(patch: ConfigPatch): Promise<ConfigView> {
  try {
    return await invoke<ConfigView>("update_config", { patch });
  } catch (e) {
    console.warn("[config] 保存失败", e);
    return FALLBACK_CONFIG;
  }
}
