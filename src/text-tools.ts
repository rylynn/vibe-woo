/**
 * 取词与翻译的前后端契约层。
 *
 * 只做三件事：类型对齐（与 Rust texttools 模块一致）、受控调用（统一走
 * invoke，便于测试注入）、会话守卫（迟到结果丢弃）。
 *
 * 隐私边界：本模块不发起到任何外部服务；翻译走用户已配置的 LLM，
 * 搜索只构造受控搜索引擎地址，由 Rust 侧用系统浏览器打开。
 */

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** 取词来源：原生文字选区 / 屏幕框选识别。 */
export type TextSource = "selection" | "ocr";

/** 取词结果定向推送事件名（Rust 只发给 pet 窗口）。 */
export const EVENT_RESULT = "pet://text-tools-result";

/** 取词错误类别（蛇形命名，与 Rust ReadError 对齐）。 */
export type ReadError =
  | "not_trusted"
  | "no_selection"
  | "app_switched"
  | "unsupported"
  | "timeout"
  | "too_long"
  | "cancelled"
  | "failed";

/** 取词结果。ok 带原文与来源应用；error 只带错误类别。 */
export type ReadOutcome =
  | { kind: "ok"; text: string; sourceApp: string | null }
  | { kind: "error"; code: ReadError };

export interface ResultPayload {
  session: number;
  source: TextSource;
  outcome: ReadOutcome;
}

/** 翻译错误类别（与 Rust TranslateError 对齐）。已脱敏，不含服务端响应体。 */
export type TranslateError =
  | "llm_disabled"
  | "llm_not_configured"
  | "too_long"
  | "too_long_output"
  | "network"
  | "failed";

/** 翻译结果。 */
export type TranslateOutcome =
  | { kind: "ok"; text: string }
  | { kind: "error"; code: TranslateError };

/** 单次取词文本上限（与 Rust TEXT_MAX_CHARS 一致）。 */
export const TEXT_MAX_CHARS = 4000;

// ---------- 会话守卫 ----------

/**
 * 只认当前会话号：重复触发、关闭面板、取消后，旧会话的结果一律丢弃。
 *
 * 会话号**由 Rust 返回**（text_tools_read_selection / text_tools_start_ocr
 * 的返回值），前端绝不自己递增 —— 两套计数器各自递增必然在某次取消后
 * 错位，导致「关过一次面板后再取词永远卡在读取中」。
 *
 * Rust 侧还有同样的门（SessionGate），前端再守一次：事件到达与面板状态
 * 可能不同步，两道门都不放宽。
 */
export class SessionGuard {
  private current = 0;

  /** 认领本次会话（号由 Rust 给出）。 */
  adopt(session: number): void {
    this.current = session;
  }

  /** 结果是否属于当前会话（不属于就必须丢弃）。 */
  accepts(session: number | undefined): boolean {
    return typeof session === "number" && session > 0 && session === this.current;
  }

  /** 取消：使所有在途结果失效（后续 accepts 一律 false）。 */
  cancel(): void {
    this.current = 0;
  }
}

// ---------- 受控调用 ----------

/**
 * 读取当前前台应用的选区。
 * 返回本次会话号（Rust 建立会话时给出），结果事件里带回同一个号。
 */
export async function readSelection(): Promise<number> {
  return await invoke<number>("text_tools_read_selection");
}

/** 进入屏幕框选 OCR 流程。返回本次会话号。 */
export async function startOcr(): Promise<number> {
  return await invoke<number>("text_tools_start_ocr");
}

/** 取消当前取词会话（面板关闭时调用）。 */
export async function cancel(): Promise<void> {
  await invoke<void>("text_tools_cancel");
}

/** 复制文本到系统剪贴板（只由用户点击复制按钮触发）。 */
export async function copy(text: string): Promise<void> {
  await invoke<void>("text_tools_copy", { text });
}

/** 翻译文本（会用用户已配置的 LLM；未启用/未配置时返回错误类别）。 */
export async function translate(text: string): Promise<TranslateOutcome> {
  return await invoke<TranslateOutcome>("text_tools_translate", { text });
}

/** 搜索：由 Rust 侧用系统默认浏览器打开受控搜索引擎地址。 */
export async function search(text: string): Promise<void> {
  return await invoke<void>("text_tools_search", { text });
}

/** 查询辅助功能授权状态（不弹提示）。 */
export async function axPermission(): Promise<boolean> {
  return await invoke<boolean>("text_tools_permission");
}

/** 请求辅助功能授权（系统弹窗，仅用户主动点击后调用）。 */
export async function requestAxPermission(): Promise<boolean> {
  return await invoke<boolean>("text_tools_request_permission");
}

/** 查询屏幕录制授权状态（不弹提示）。 */
export async function screenPermission(): Promise<boolean> {
  return await invoke<boolean>("text_tools_screen_permission");
}

/** 请求屏幕录制授权（打开系统设置，仅用户主动点击后调用）。 */
export async function requestScreenPermission(): Promise<boolean> {
  return await invoke<boolean>("text_tools_request_screen_permission");
}

/** 订阅取词结果事件。返回的句柄用于取消订阅。 */
export async function listenResult(
  handler: (payload: ResultPayload) => void,
): Promise<UnlistenFn> {
  return await listen<ResultPayload>(EVENT_RESULT, (event) => handler(event.payload));
}

// ---------- 纯逻辑（可测） ----------

/** 文本字符数是否超限（用于前端即时提示，不依赖后端往返）。 */
export function isTooLong(text: string): boolean {
  return [...text].length > TEXT_MAX_CHARS;
}

/** 错误类别 → 可展示的中文说明。 */
export function readErrorMessage(code: ReadError): string {
  switch (code) {
    case "not_trusted":
      return "需要辅助功能授权才能读取选区文字";
    case "no_selection":
      return "没有选中文字，或选区里没有识别到文字";
    case "app_switched":
      return "读取期间切换了应用，请重试";
    case "unsupported":
      return "当前应用不支持取词，试试屏幕框选";
    case "timeout":
      return "读取超时，应用可能无响应";
    case "too_long":
      return `文字超过 ${TEXT_MAX_CHARS} 字，请编辑或缩小选区`;
    case "cancelled":
      return "";
    case "failed":
      return "取词失败，请重试";
  }
}

/** 翻译错误类别 → 可展示的中文说明。 */
export function translateErrorMessage(code: TranslateError): string {
  switch (code) {
    case "llm_disabled":
      return "AI 未启用 —— 在设置里打开「启用 AI」后再翻译";
    case "llm_not_configured":
      return "AI 未配置完整 —— 需要服务地址、模型和 API key";
    case "too_long":
      return `原文超过 ${TEXT_MAX_CHARS} 字，请编辑后再翻译`;
    case "too_long_output":
      return "译文超出长度上限，请缩短原文后重试";
    case "network":
      return "翻译请求失败，请检查网络与服务配置";
    case "failed":
      return "翻译失败，请重试";
  }
}
