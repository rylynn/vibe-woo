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
  /** 离场中的旧快闪：被新事件顶掉时仍在往外走，tick 里推进到 gone 才移除。 */
  private readonly leaving: GuestPet[] = [];
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
    // 顺手清掉过期的去重记录，Map 不随 uid 数无界增长
    for (const [uid, at] of this.lastSeen) {
      if (nowMs - at >= DEDUP_MS) this.lastSeen.delete(uid);
    }
    const last = this.lastSeen.get(seed.uid) ?? 0;
    if (nowMs - last < DEDUP_MS) return false; // 幂等去重
    this.lastSeen.set(seed.uid, nowMs);

    if (this.current) {
      // 上一只还没走完：送出去并继续推进到走出屏幕——
      // 直接丢弃会让它冻结在画面上（心跳可能一次带两个不同好友的 bump）
      this.current.leave(nowMs, canvasW);
      this.leaving.push(this.current);
    }

    const pet = new GuestPet(seed, {
      x: -this.side * 2, // 从左侧屏幕外跑进来
      y: groundY,
      side: this.side,
      nowMs,
      index: 2,
      // 快闪走位由 arrive/walkTo 全程编排，不参与伙伴式跟随（host 给 null 即关闭）
      host: () => null,
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
    let drew = false;
    if (this.current) {
      drew = this.current.tick(nowMs, ctx, canvas) || drew;
      if (this.current.gone) this.current = null;
    }
    for (const g of this.leaving) {
      drew = g.tick(nowMs, ctx, canvas) || drew;
    }
    for (let i = this.leaving.length - 1; i >= 0; i--) {
      if (this.leaving[i].gone) this.leaving.splice(i, 1);
    }
    return drew;
  }

  /** 当前与离场中的全部快闪访客（主循环做脏矩形重叠判断用）。 */
  get activePets(): GuestPet[] {
    return this.current ? [this.current, ...this.leaving] : [...this.leaving];
  }

  /** 有没有在走动 —— 只有这时才需要抬帧率。 */
  get isBusy(): boolean {
    return this.activePets.some((g) => g.isBusy);
  }

  /** 画布被整屏清空后调用：作废指纹重画（与访客同约定）。 */
  invalidate(): void {
    this.current?.invalidate();
    for (const g of this.leaving) g.invalidate();
  }

  /** 全部清走（宠物离家等需要重画的场合）。 */
  clear(ctx: CanvasRenderingContext2D): void {
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
    this.current?.dismiss(ctx);
    this.current = null;
    for (const g of this.leaving) g.dismiss(ctx);
    this.leaving.length = 0;
  }
}
