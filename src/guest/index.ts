import type { Box } from "../interact/hit-test";
import { GuestPet } from "./guest-pet";
import type { GuestSeed } from "./guest-pet";

/** 与服务端 MAX_VISITORS 一致：家里最多同时待 3 只。 */
const MAX_VISITORS = 3;
/** 访客的落位：屏幕下半部横向均分，避免互相叠在一起。 */
const SPAWN_RATIOS = [0.28, 0.5, 0.72];
const BASE_Y_RATIO = 0.72;

/**
 * 访客注册表 —— 管理「谁在你家」以及它们画在哪。
 *
 * 服务端的 visitors 名单每拍心跳都发下来（空列表表示人走光了），
 * 这里负责增删、分配槽位、推进动画，并把命中框交给穿透上报。
 */
export class GuestRegistry {
  /** 固定槽位：空位可复用，避免访客互相重叠。 */
  private slots: (GuestPet | null)[] = new Array(MAX_VISITORS).fill(null);
  /** 最近一次同步的名单，改尺寸后用来原地重建。 */
  private lastSeeds: GuestSeed[] = [];

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly canvas: HTMLCanvasElement,
    private side: number,
  ) {}

  /**
   * 改访客体型。尺寸变化后已有实例没法就地缩放，
   * 直接清掉并按最近一次名单重建 —— 免得白等一拍心跳。
   */
  setSide(n: number): { arrived: GuestPet[]; left: GuestPet[] } {
    if (this.side === n) return { arrived: [], left: [] };
    this.side = n;
    // 清掉的是实例，气泡还在 GuestDialog 那边挂着 —— 必须把
    // arrived/left 交回主循环，否则重建出来的访客不会有气泡，
    // 旧气泡也会变成孤儿 div。
    this.clear();
    if (this.lastSeeds.length === 0) return { arrived: [], left: [] };
    return this.sync(this.lastSeeds, performance.now());
  }

  get list(): readonly GuestPet[] {
    return this.slots.filter((g): g is GuestPet => g !== null);
  }

  get isEmpty(): boolean {
    return this.list.length === 0;
  }

  /**
   * 按服务端名单增删访客。
   * @returns 本次新到与离开的访客，供对话编排决定说不说开场白。
   */
  sync(
    seeds: GuestSeed[],
    nowMs: number,
  ): { arrived: GuestPet[]; left: GuestPet[] } {
    this.lastSeeds = seeds;
    const want = seeds.slice(0, MAX_VISITORS);
    const left: GuestPet[] = [];
    const arrived: GuestPet[] = [];

    // 名单里没有的 → 走向屏幕边缘离场
    for (const g of this.list) {
      if (!want.some((s) => s.uid === g.seed.uid)) {
        g.leave(nowMs, this.canvas.width);
        left.push(g);
      }
    }

    // 新面孔 → 找空位坐下
    for (const s of want) {
      if (this.list.some((g) => g.seed.uid === s.uid)) continue;
      const slot = this.slots.findIndex((g) => g === null);
      if (slot < 0) continue; // 满了就等下一拍，不挤掉正在淡出的
      const g = new GuestPet(s, {
        x: Math.round(this.canvas.width * SPAWN_RATIOS[slot] - this.side / 2),
        y: Math.round(this.canvas.height * BASE_Y_RATIO),
        side: this.side,
        nowMs,
        index: slot,
      });
      this.slots[slot] = g;
      arrived.push(g);
    }

    return { arrived, left };
  }

  /**
   * 推进所有访客。返回 true 表示这一拍有访客画了新画面。
   *
   * 必须在主宠物绘制之后调用 —— 主宠物清脏矩形时会擦掉落在它
   * 范围内的访客像素，访客后画才能补回来。
   */
  tick(nowMs: number): boolean {
    let drew = false;
    for (let i = 0; i < this.slots.length; i++) {
      const g = this.slots[i];
      if (!g) continue;
      if (g.tick(nowMs, this.ctx, { width: this.canvas.width, height: this.canvas.height })) {
        drew = true;
      }
      if (g.gone) {
        g.dismiss(this.ctx);
        this.slots[i] = null;
      }
    }
    return drew;
  }

  /** 命中上报用：每只访客的矩形逐个给出（不能合并成并集矩形）。 */
  get bodies(): Box[] {
    return this.list.map((g) => g.body);
  }

  /** 有没有访客正在走/跳/离场 —— 只有这时才需要抬帧率。 */
  get wantsFastFrame(): boolean {
    return this.list.some((g) => g.isBusy);
  }

  /**
   * 画布被整屏清空后调用（resize / 宠物离家 / 主宠物整屏重绘）。
   *
   * 不调的话访客会因「视觉指纹未变」而不重画 —— 整只消失，
   * 但命中框还在上报，于是屏幕上出现「看不见却拦鼠标」的区域。
   */
  invalidate(): void {
    for (const g of this.slots) g?.invalidate();
  }

  /** 全部清走（宠物离家、尺寸变化等需要重画的场合）。 */
  clear(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const g = this.slots[i];
      if (!g) continue;
      g.dismiss(this.ctx);
      this.slots[i] = null;
    }
  }
}
