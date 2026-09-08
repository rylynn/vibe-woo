import { Behavior } from "../anim/behavior";
import { breatheScale } from "../anim/breathe";
import { MicroExpression } from "../anim/expression";
import type { EyeFrame } from "../anim/expression";
import { squashScale } from "../anim/squash";
import { generateCandidates } from "../avatar/generator";
import type { PetAvatar } from "../avatar/types";
import type { Box } from "../interact/hit-test";
import { drawAvatarFigure } from "../overlay/avatar-picker";

export interface GuestSeed {
  uid: string;
  nick: string;
  pet_name: string;
}

/** 呼吸：与 avatar-picker 预览同一套手感（周期 2400ms，幅度 0.02）。 */
const BREATHE_PERIOD_MS = 2400;
const BREATHE_AMPLITUDE = 0.02;
/** 访客走动的帧预算档位。 */
const GUEST_FPS = 24;
/**
 * 离场时长：走到屏幕边缘外所需的时间。
 *
 * 刻意**不用透明度淡出** —— CLAUDE.md 的硬约束是不产生半透明像素
 * （像素风一旦出现半透明边缘就糊了，辉光也是用棋盘点阵而非 alpha）。
 * 所以离场就是真的走出去：走向最近的屏幕边缘，走出去了再消失。
 */
const LEAVE_MS = 1200;

/**
 * 由 uid 确定性生成形象。
 *
 * 服务端下发的心跳里只有 uid/昵称/宠物名，没有形象字段 ——
 * 与其改三处协议，不如让同一只宠物每次来都长一个样：
 * uid 哈希出的种子喂给生成器即可，不联网也稳定。
 */
export function avatarForUid(uid: string): PetAvatar {
  let h = 2166136261;
  for (let i = 0; i < uid.length; i++) {
    h ^= uid.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let state = h >>> 0;
  const rng = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return generateCandidates(rng, 1)[0];
}

/**
 * 访客宠物 —— 别人家的宠物来串门时画在你屏幕上的那一只。
 *
 * 与主宠物 Pet 的区别：**只有画和走动，没有脑子**。
 * Pet 那套（拖动、状态机、脏矩形联动、辉光、特效、说话）一概不接，
 * 因为访客没有传感器数据、也不该抢走主宠物的交互。
 *
 * 绘制复用 `drawAvatarFigure`（形象选择弹窗已经在用的同一套），
 * 走动复用 `Behavior`，表情复用 `MicroExpression` ——
 * 这三个都不依赖 Pet 实例，可以直接用。
 */
export class GuestPet {
  readonly seed: GuestSeed;
  private readonly avatar: PetAvatar;
  private readonly behavior: Behavior;
  private readonly expr: MicroExpression;
  private readonly side: number;
  private readonly startMs: number;
  /** 呼吸相位错开，否则多只访客会像复制出来的机器人一起起伏。 */
  private readonly phaseOffset: number;
  private readonly frameIntervalMs = 1000 / GUEST_FPS;

  private lastTickMs = 0;
  private lastRenderMs = 0;
  private lastDrawKey: string | null = null;
  private dirty: Box | null = null;
  /** 上一拍擦掉的区域 —— 主循环判断有没有碰到主宠物时要算上它。 */
  private erased: Box | null = null;
  private eye: EyeFrame = { shape: "round", lid: 0, gazeX: 0, gazeY: 0 };

  private leaving = false;
  private leaveAt = 0;

  constructor(
    seed: GuestSeed,
    opts: { x: number; y: number; side: number; nowMs: number; index: number },
  ) {
    this.seed = seed;
    this.avatar = avatarForUid(seed.uid);
    this.side = opts.side;
    this.startMs = opts.nowMs;
    this.phaseOffset = opts.index * 470;

    let s = (opts.index + 1) * 7919;
    const rng = () => {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    // nearby 范围：以出生点为锚小范围晃悠，不会满屏乱跑
    this.behavior = new Behavior(opts.x, opts.y, rng);
    this.behavior.setActionStyle(this.avatar.actionStyle);
    this.expr = new MicroExpression(rng);
  }

  /** 命中上报用：与主宠物 body 同构的矩形。 */
  get body(): Box {
    const st = this.behavior.current;
    return { x: st.x, y: st.y, w: this.side, h: this.side };
  }

  /**
   * 上一拍「擦过 + 画过」的并集，主循环据此判断有没有碰到主宠物。
   *
   * 只看新画的位置是不够的：访客从主宠物身上走开的那一拍，
   * 擦掉的是旧位置（压在主宠物身上），新位置已经走远 ——
   * 只看新位置就漏判，主宠物身上会留个洞。
   */
  get lastAffected(): Box | null {
    const a = this.erased;
    const b = this.dirty;
    if (!a) return b;
    if (!b) return a;
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return {
      x,
      y,
      w: Math.max(a.x + a.w, b.x + b.w) - x,
      h: Math.max(a.y + a.h, b.y + b.h) - y,
    };
  }

  /** 是否在动 —— 走动/小跳/离场途中才需要高帧率。 */
  get isBusy(): boolean {
    return this.leaving || this.behavior.current.motion !== "idle";
  }

  /** 开始离场：走向最近的屏幕边缘，走出去了才算完。 */
  leave(nowMs: number, boundsWidth: number): void {
    if (this.leaving) return;
    this.leaving = true;
    this.leaveAt = nowMs;
    const st = this.behavior.current;
    const toLeft = st.x + this.side / 2 < boundsWidth / 2;
    const target = toLeft ? -this.side * 2 : boundsWidth + this.side * 2;
    this.behavior.goto(target, boundsWidth);
  }

  get isLeaving(): boolean {
    return this.leaving;
  }

  /** 走出屏幕、可以安全移除。 */
  get gone(): boolean {
    return this.leaving && this.leftAt !== null;
  }

  private leftAt: number | null = null;

  /**
   * 推进一拍并绘制。返回 true 表示这一拍真的画了新画面。
   *
   * 必须在主宠物 `pet.tick()` **之后**调用 —— 主宠物清自己的脏矩形时
   * 会擦掉落在它范围内的访客像素，访客后画才能补回来。
   */
  tick(nowMs: number, ctx: CanvasRenderingContext2D, bounds: {
    width: number;
    height: number;
  }): boolean {
    // 行为按真实时间步进，dt 钳制避免切后台回来后瞬移
    const dt = this.lastTickMs === 0 ? 0 : (nowMs - this.lastTickMs) / 1000;
    this.lastTickMs = nowMs;
    const safeDt = Math.min(dt, 0.12);
    if (safeDt > 0) {
      this.behavior.update({
        dt: safeDt,
        bounds,
        side: this.side,
        held: false,
        asleep: false,
        scope: "nearby",
      });
    }

    // 离场：走出屏幕就消失。不用透明度渐变，见 LEAVE_MS 处的说明。
    if (this.leaving && nowMs - this.leaveAt >= LEAVE_MS) {
      if (this.leftAt === null) {
        this.clear(ctx);
        this.leftAt = nowMs;
      }
      return false;
    }

    if (nowMs - this.lastRenderMs < this.frameIntervalMs) return false;
    this.lastRenderMs = nowMs;

    const st = this.behavior.current;
    const scale = breatheScale(
      nowMs - this.startMs + this.phaseOffset,
      BREATHE_PERIOD_MS,
      BREATHE_AMPLITUDE,
    );
    const side = Math.round(this.side * scale);
    const { sx, sy } = squashScale(st.motion, st.actPhase);
    const w = Math.max(4, Math.round(side * sx));
    const h = Math.max(4, Math.round(side * sy));
    const bob = st.motion === "walk" ? walkBob(nowMs, side) : 0;

    // 水平居中、底部对齐 —— 与主宠物同一套，形变时脚不离地
    const px = Math.round(st.x + (this.side - w) / 2);
    const py = Math.round(st.y + (this.side - h) - bob);

    // 表情每帧都要推进（内部计时靠 update 驱动），跳帧只能跳绘制
    this.eye = this.expr.update(nowMs + this.phaseOffset, {
      asleep: false,
      stuck: false,
      flow: false,
      tired: false,
      poked: false,
      mood: null,
      gazeTarget:
        st.motion === "lookaround" ? { x: st.facing * 0.85, y: 0 } : null,
    });

    const key = `${px},${py},${w},${h},${bob},${this.eye.shape},${Math.round(
      this.eye.lid * 20,
    )},${Math.round(this.eye.gazeX * 20)},${Math.round(this.eye.gazeY * 20)}`;
    if (key === this.lastDrawKey) return false;
    this.lastDrawKey = key;

    this.clear(ctx);
    drawAvatarFigure(ctx, { bodyX: px, bodyY: py, w, h }, this.avatar, this.eye);

    // 容差要盖住走动位移，否则移动时留残影
    const pad = Math.max(10, Math.max(w, h) * 0.25);
    this.dirty = {
      x: px - pad,
      y: py - pad,
      w: w + pad * 2,
      h: h + pad * 2,
    };
    return true;
  }

  /**
   * 擦掉上一帧画过的区域，并记住擦的是哪 —— 主循环要靠它判断
   * 有没有擦到主宠物身上。首帧还没有脏矩形，此时不擦（避免误清主宠物）。
   */
  private clear(ctx: CanvasRenderingContext2D): void {
    const d = this.dirty;
    if (!d) return;
    ctx.clearRect(d.x, d.y, d.w, d.h);
    this.erased = d;
    this.dirty = null;
  }

  /** 被强制移除时清掉最后一帧（画布已被整屏清空的情况不必调用）。 */
  dismiss(ctx: CanvasRenderingContext2D): void {
    this.clear(ctx);
  }

  /** 画布被整屏清空后调用：作废指纹，下一拍无条件重画。 */
  invalidate(): void {
    this.lastDrawKey = null;
    // 画布已经空了，没有需要擦的旧像素
    this.dirty = null;
    this.erased = null;
  }
}

/** 走动起伏：与主宠物同一公式（cell = side/24，正弦过阈值才抬一格）。 */
function walkBob(nowMs: number, side: number): number {
  const cell = Math.max(1, Math.round(side / 24));
  const phase = Math.sin((nowMs / 150) * Math.PI);
  return phase > 0.35 ? cell : 0;
}

/** 访客帧间隔 —— 主循环用它和主宠物的档位取较小值。 */
export const GUEST_INTERVAL_MS = 1000 / GUEST_FPS;
