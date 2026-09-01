import { invoke } from "@tauri-apps/api/core";
import type { Box } from "./interact/hit-test";

/**
 * 上报检查间隔。本地比较负载是否变化，无变化不产生 IPC —— 这个
 * 定时器本身只做几次 getter 读取与一次小对象序列化，成本可忽略。
 */
const CHECK_INTERVAL_MS = 50;

/**
 * 心跳间隔：内容完全不变时也至少多久完整上报一次。
 *
 * 该通道同时承担「前端还活着」的心跳职责 —— Rust 侧 1500ms 判失联，
 * 500ms 心跳留足 3 倍余量。相比原先 50ms 无条件上报，跨进程 IPC
 * 从 20 次/秒 降到 2 次/秒。
 */
const HEARTBEAT_INTERVAL_MS = 500;

/** 诊断计数：用于定位指针事件是否完整到达 webview。 */
export interface EventCounters {
  down: number;
  move: number;
  up: number;
  cancel: number;
  /** pointermove 中发现 buttons===0 却仍处于拖动态的次数（说明 up 丢了）。 */
  orphanDrag: number;
}

export interface PetReport {
  /**
   * 所有需要接收鼠标的区域（宠物身体、右键菜单……）。
   *
   * 用数组而非并集矩形：菜单在宠物侧边展开时，并集会覆盖大片空白，
   * 那片空白就会误拦截用户对编辑器的点击。
   */
  boxes: Box[];
  /** true 表示拖动中或菜单打开，要求 Rust 保持鼠标接管。 */
  lock: boolean;
  counters: EventCounters;
  /** 当前动作与范围，仅用于诊断 —— 能直接看出配置是否生效。 */
  motion: string;
  scope: string;
}

/**
 * 持续把可点击区域上报给 Rust，供其做鼠标命中判定与穿透切换。
 *
 * 内容变化（拖动、菜单开关、指针事件计数）立即上报 —— 交互期的穿透
 * 切换实时性与原先一致；内容不变时只按 HEARTBEAT_INTERVAL_MS 心跳。
 *
 * 为什么用独立 setInterval 而不挂在渲染循环里：渲染有帧率预算，
 * 且 requestAnimationFrame 在窗口隐藏时会被暂停，那会让 Rust 误判
 * 前端失联。穿透判定需要稳定的新鲜度。
 */
export function startBoxReporter(getReport: () => PetReport): void {
  let lastSent = "";
  let lastSentAt = 0;
  setInterval(() => {
    const { boxes, lock, counters, motion, scope } = getReport();
    // 序列化后比较：小对象，stringify 成本远低于一次跨进程 IPC
    const payload = JSON.stringify([boxes, lock, counters, motion, scope]);
    const now = performance.now();
    if (payload === lastSent && now - lastSentAt < HEARTBEAT_INTERVAL_MS) {
      return; // 内容未变且心跳未到期：本轮不产生 IPC
    }
    lastSent = payload;
    lastSentAt = now;
    void invoke("report_pet_box", {
      boxes,
      lock,
      counters,
      motion,
      scope,
    }).catch(() => {
      // 非 Tauri 环境（纯浏览器调试）下 invoke 会失败，静默忽略
      // 失败不回滚 lastSent：下轮会重试（序列化结果相同但心跳到期）
    });
  }, CHECK_INTERVAL_MS);
}

/** 请求退出应用。由宠物右键菜单调用。 */
export function requestQuit(): void {
  void invoke("quit_app").catch(() => {});
}
