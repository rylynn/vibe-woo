import { invoke } from "@tauri-apps/api/core";
import type { Reminder } from "./overlay/reminders";

export type Persona = "quiet" | "occasional" | "chatty";
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
  autostart: boolean;
  reminders: Reminder[];
  pomodoro_enabled: boolean;
  pomodoro_work_mins: number;
  pomodoro_break_mins: number;
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
}

export interface ConfigPatch {
  size_index?: number;
  notes_vault?: string;
  roam_scope?: RoamScope;
  persona?: Persona;
  autostart?: boolean;
  reminders?: Reminder[];
  pomodoro_enabled?: boolean;
  pomodoro_work_mins?: number;
  pomodoro_break_mins?: number;
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
}

export const FALLBACK_CONFIG: ConfigView = {
  size_index: 1,
  notes_vault: "",
  roam_scope: "nearby",
  persona: "quiet",
  autostart: false,
  reminders: [],
  pomodoro_enabled: false,
  pomodoro_work_mins: 25,
  pomodoro_break_mins: 5,
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
