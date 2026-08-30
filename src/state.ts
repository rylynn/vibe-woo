import { listen } from "@tauri-apps/api/event";

export type Doing = "coding" | "browsing" | "other" | "away";
export type Tempo = "flow" | "normal" | "stuck" | "resting";
export type Mood = "content" | "focused" | "bored" | "frustrated";
export type ActivityKind = "thinking" | "listening" | "slacking" | "working";

export interface PetState {
  doing: Doing;
  tempo: Tempo;
  late_night: boolean;
  keystrokes_per_min: number;
  mood: Mood;
  activity: ActivityKind;
}

export const DEFAULT_STATE: PetState = {
  doing: "other",
  tempo: "normal",
  late_night: false,
  keystrokes_per_min: 0,
  mood: "focused",
  activity: "working",
};

/** 订阅 Rust 推送的状态。返回取消订阅函数。 */
export async function onStateChange(
  cb: (s: PetState) => void,
): Promise<() => void> {
  try {
    const un = await listen<PetState>("pet://state", (e) => cb(e.payload));
    return un;
  } catch {
    // 非 Tauri 环境（纯浏览器调试）下没有事件系统
    return () => {};
  }
}
