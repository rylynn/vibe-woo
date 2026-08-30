import { invoke } from "@tauri-apps/api/core";
import type { Box } from "./interact/hit-test";

/**
 * 上报间隔。比 Rust 侧轮询（60ms）略快，保证 Rust 总能拿到新鲜数据；
 * 也远小于 Rust 的失联阈值（1500ms），正常运行不会被误判为崩溃。
 */
const REPORT_INTERVAL_MS = 50;

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
 * 即使内容未变也照常上报 —— 这个通道同时承担心跳职责，停止上报会让
 * Rust 在 1.5 秒后强制穿透（前端崩溃时的安全兜底）。
 *
 * 为什么用独立 setInterval 而不挂在渲染循环里：渲染有帧率预算，
 * 且 requestAnimationFrame 在窗口隐藏时会被暂停，那会让 Rust 误判
 * 前端失联。穿透判定需要稳定的新鲜度。
 */
export function startBoxReporter(getReport: () => PetReport): void {
  setInterval(() => {
    const { boxes, lock, counters, motion, scope } = getReport();
    void invoke("report_pet_box", {
      boxes,
      lock,
      counters,
      motion,
      scope,
    }).catch(() => {
      // 非 Tauri 环境（纯浏览器调试）下 invoke 会失败，静默忽略
    });
  }, REPORT_INTERVAL_MS);
}

/** 请求退出应用。由宠物右键菜单调用。 */
export function requestQuit(): void {
  void invoke("quit_app").catch(() => {});
}
