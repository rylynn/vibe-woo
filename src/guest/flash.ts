import type { GuestSeed } from "./guest-pet";
import { GuestPet } from "./guest-pet";

/** 快闪到场停留时长（毫秒）：站到主宠物身边「碰」的时间。 */
const STAY_MS = 4000;
/** 同一 uid 的快闪去重窗口（毫秒）：事件经心跳拉取可能重复/迟到。 */
const DEDUP_MS = 60_000;

/**
 * 碰一碰快闪 —— 对方宠物跑来碰你一下就走的短生命周期动画。
 *
 * 与串门访客（GuestRegistry）完全独立：不占 3 个访客槽位、不进对话
 * 编排；身体同样不上报命中框（不可点、让点击穿透，与访客一致）。
 *
 * 事件经心跳拉取到达（最多晚 3 分钟），所以这里是「回放式」呈现：
 * 从屏幕左侧跑进来 → 走到主宠物身旁 → 停留片刻 → 走出屏幕。
 */
export class FlashGuests {
  private current: GuestPet | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly lastSeen = new Map<string, number>();
  private side = 48;

  setSide(n: number): void {
    this.side = n;
  }

  /** 收到 bump 事件。返回 true 表示安排了快闪（调用方需唤醒渲染）。 */
  arrive(
    seed: GuestSeed,
    nowMs: number,
    canvasW: number,
    targetX: number,
    groundY: number,
  ): boolean {
    const last = this.lastSeen.get(seed.uid) ?? 0;
    if (nowMs - last < DEDUP_MS) return false; // 幂等去重
    this.lastSeen.set(seed.uid, nowMs);

    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.current?.leave(nowMs, canvasW); // 上一只还没走完：先送走

    const pet = new GuestPet(seed, {
      x: -this.side * 2, // 从左侧屏幕外跑进来
      y: groundY,
      side: this.side,
      nowMs,
      index: 2,
    });
    pet.walkTo(targetX, canvasW);
    this.current = pet;
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null;
      this.current?.leave(performance.now(), canvasW);
    }, STAY_MS);
    return true;
  }

  /** 推进动画。返回 true 表示这一拍画了新画面（与 GuestRegistry.tick 同约定）。 */
  tick(
    nowMs: number,
    ctx: CanvasRenderingContext2D,
    canvas: { width: number; height: number },
  ): boolean {
    const cur = this.current;
    if (!cur) return false;
    const drew = cur.tick(nowMs, ctx, canvas);
    if (cur.gone) this.current = null;
    return drew;
  }

  /** 当前快闪中的访客（主循环做脏矩形重叠判断用）。 */
  get active(): GuestPet | null {
    return this.current;
  }

  /** 有没有在走动 —— 只有这时才需要抬帧率。 */
  get isBusy(): boolean {
    return this.current?.isBusy ?? false;
  }

  /** 画布被整屏清空后调用：作废指纹重画（与访客同约定）。 */
  invalidate(): void {
    this.current?.invalidate();
  }

  /** 全部清走（宠物离家等需要重画的场合）。 */
  clear(ctx: CanvasRenderingContext2D): void {
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
    this.current?.dismiss(ctx);
    this.current = null;
  }
}
