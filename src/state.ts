import { listen } from "@tauri-apps/api/event";

/** 正在做的事。分类的是**事**不是**人** —— 主人是不是程序员只有他自己知道。 */
export type Doing =
  | "editing"
  | "writing"
  | "designing"
  | "data"
  | "messaging"
  | "browsing"
  | "watching"
  | "other"
  | "away";

/** 产出型：在这类工具里停下来是在思考，不是摸鱼。与后端 `Doing::is_producing` 对齐。 */
const PRODUCING: ReadonlySet<Doing> = new Set<Doing>([
  "editing",
  "writing",
  "designing",
  "data",
]);

export function isProducing(doing: Doing): boolean {
  return PRODUCING.has(doing);
}

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
