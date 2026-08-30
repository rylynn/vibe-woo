import type { PetActivity } from "./anim/frame-budget";
import type { PetState, Doing, Tempo, Mood, ActivityKind } from "./state";

/** 宠物的外观表现。由状态推导，纯函数便于测试。 */
export interface Appearance {
  /** 渲染帧率档位。 */
  activity: PetActivity;
  /** 呼吸周期毫秒数。越小越急促。 */
  breathePeriodMs: number;
  /** 是否显示睡眠标记。 */
  asleep: boolean;
  /** 是否朝屏幕方向凝视（陪你一起盯着代码）。 */
  peeking: boolean;
  /** 是否显示深夜黑眼圈。 */
  tired: boolean;
  /** 身体色调。 */
  tint: "normal" | "focused" | "dim";
  /** 当前心情。 */
  mood: Mood;
  /** 更细的活动场景。 */
  act: ActivityKind;
}

/** 默认呼吸周期。 */
const BASE_PERIOD_MS = 2400;
/** FLOW 状态下的最快呼吸周期。 */
const MIN_PERIOD_MS = 700;
/** 达到此击键频率时呼吸达到最快。 */
const PEAK_KPM = 300;
/** 睡眠时的呼吸周期，明显放缓。 */
const SLEEP_PERIOD_MS = 5200;
/** 深夜的额外放缓系数。 */
const LATE_NIGHT_SLOWDOWN = 1.35;

/**
 * 律动同步：呼吸频率跟随实际击键频率。
 *
 * 这是设计文档 4.1 认定的「上瘾细节」—— 你写得越快宠物越来劲。
 * 成本几乎为零（只用已有的击键频率），但是留存的主要来源。
 */
export function breathePeriodFor(kpm: number): number {
  const t = Math.min(1, Math.max(0, kpm / PEAK_KPM));
  return Math.round(BASE_PERIOD_MS - (BASE_PERIOD_MS - MIN_PERIOD_MS) * t);
}

export function appearanceFor(s: PetState): Appearance {
  const asleep = s.doing === "away";
  const peeking = s.doing === "coding" && s.tempo === "stuck";

  let activity: PetActivity;
  if (asleep) {
    activity = "sleep";
  } else if (s.tempo === "flow" || s.mood === "content") {
    activity = "active";
  } else {
    activity = "idle";
  }

  let breathePeriodMs: number;
  if (asleep) {
    breathePeriodMs = SLEEP_PERIOD_MS;
  } else if (s.tempo === "resting" || s.tempo === "stuck") {
    // 静止/思考时不该急促呼吸，即便刚才 kpm 还很高
    breathePeriodMs = BASE_PERIOD_MS;
  } else {
    breathePeriodMs = breathePeriodFor(s.keystrokes_per_min);
  }

  if (s.late_night && !asleep) {
    breathePeriodMs = Math.round(breathePeriodMs * LATE_NIGHT_SLOWDOWN);
  }

  const tint: Appearance["tint"] = asleep
    ? "dim"
    : s.tempo === "flow"
      ? "focused"
      : "normal";

  return {
    activity,
    breathePeriodMs,
    asleep,
    peeking,
    tired: s.late_night,
    tint,
    mood: s.mood,
    act: s.activity,
  };
}

/** 心情到眼型的映射。宠物全部情绪都由眼睛承担（NOMI 取向）。 */
export function eyeShapeFor(s: PetState): "round" | "happy" | "worried" | "droopy" {
  if (s.mood === "content") return "happy";
  if (s.mood === "frustrated") return "worried";
  if (s.mood === "bored") return "droopy";
  return "round";
}


/** 供调试显示的简短状态文字。 */
export function describe(s: PetState): string {
  const doing: Record<Doing, string> = {
    coding: "写代码",
    browsing: "浏览",
    other: "其他",
    away: "离开",
  };
  const tempo: Record<Tempo, string> = {
    flow: "进入状态",
    normal: "正常",
    stuck: "卡住了",
    resting: "歇着",
  };
  const late = s.late_night ? " · 深夜" : "";
  return `${doing[s.doing]} · ${tempo[s.tempo]}${late}`;
}
