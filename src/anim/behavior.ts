/**
 * 宠物自主行为：漫游与待机小动作。
 *
 * 纯逻辑、不依赖 canvas 与时间源，因此可完整单测。
 *
 * 设计原则：宠物必须「有自己的事做」，但绝不能打扰你。因此所有自主
 * 移动都是缓慢、小幅、且可被配置限制在指定范围内的。
 *
 * 刻意不做重力与下落：宠物是桌面上的伙伴，不是被扔下来的物件。
 * 出场就应该在那儿待着，而不是从天上砸下来。
 */

export type Motion =
  /** 原地待着。 */
  | "idle"
  /** 走向某处。 */
  | "walk"
  /** 原地小跳。 */
  | "hop"
  /** 左右张望（不移动，只转朝向）。 */
  | "lookaround"
  /** 伸懒腰 / 抖一抖。 */
  | "stretch"
  /** 被拖在手上。 */
  | "held"
  /** 睡觉，完全不动。 */
  | "sleep";

/** 待机小动作，不改变位置，只是让宠物「有事做」。 */
const IDLE_ACTS = ["hop", "lookaround", "stretch"] as const;
export type IdleAct = (typeof IDLE_ACTS)[number];

/**
 * 活动范围。
 *
 * 比单纯的「活跃度」滑块更好理解 —— 用户真正关心的是「它会跑多远」，
 * 而不是抽象的活跃程度。
 */
export type RoamScope =
  /** 完全不动，纯挂件。 */
  | "still"
  /** 只在原地附近小范围晃动。 */
  | "nearby"
  /** 半屏范围内活动。 */
  | "halfscreen"
  /** 整个屏幕都可以去。 */
  | "fullscreen";

export const ROAM_SCOPES: readonly RoamScope[] = [
  "still",
  "nearby",
  "halfscreen",
  "fullscreen",
];

export interface Bounds {
  width: number;
  height: number;
}

export interface BehaviorInput {
  /** 帧间隔秒数。 */
  dt: number;
  /** 屏幕可用范围。 */
  bounds: Bounds;
  /** 宠物边长。 */
  side: number;
  /** 是否正被拖动。 */
  held: boolean;
  /** 是否睡眠（人已离开）。 */
  asleep: boolean;
  /** 活动范围。 */
  scope: RoamScope;
}

export interface BehaviorState {
  x: number;
  y: number;
  motion: Motion;
  /** 面朝方向，-1 左、1 右。用于精灵翻转与视线。 */
  facing: -1 | 1;
  /** 当前待机小动作的进度 0..1，供渲染层做形变。 */
  actPhase: number;
}

/**
 * 漫游速度，px/s。
 *
 * 定得偏快：76px/s 时走完一段 300px 要 4 秒，十秒内只够一次动作，
 * 实测「活跃度不明显」。宠物走路本就该轻快，慢悠悠反而更引人注意。
 */
const WALK_SPEED = 130;
/** 两次自发动作之间的间隔范围（秒）。 */
const IDLE_MIN = 1.2;
const IDLE_MAX = 4;
/**
 * 各范围的活动半径定义。
 *
 * nearby 用「身长倍数」是对的 —— 它表达的是相对宠物自身的小范围。
 * 但 halfscreen 必须用「屏宽比例」：早先写成 8 倍身长，在 96px 宠物 +
 * 1440px 屏幕下等于 ±768px，双向 1536px 已超出屏宽，导致「半屏」与
 * 「全屏」行为完全相同，名字对不上实际。
 */
const SCOPE_REACH: Record<
  RoamScope,
  { sideMul?: number; widthRatio?: number }
> = {
  still: { sideMul: 0 },
  nearby: { sideMul: 2.5 },
  // 双向各 1/4 屏宽 = 合计半屏
  halfscreen: { widthRatio: 0.25 },
  fullscreen: {},
};
/** 单次漫游的最小距离，占身体边长比例。低于此值的移动像在原地抽搐。 */
const MIN_TRIP_RATIO = 1.2;
/**
 * 自发动作中「走动」的占比，其余为待机小动作。
 *
 * 不能全是走动 —— 那样宠物只会左右滑，反而更假。
 * 小动作（跳、张望、伸懒腰）才是生命感的主要来源。
 */
const WALK_SHARE = 0.45;
/** 小跳的高度，相对身体边长。 */
const HOP_HEIGHT_RATIO = 0.45;
/** 小跳时长（秒）。 */
const HOP_SECS = 0.5;
/** 张望持续时长（秒）。 */
const LOOKAROUND_SECS = 1.6;
/** 伸懒腰持续时长（秒）。 */
const STRETCH_SECS = 1.1;

export class Behavior {
  private targetX: number | null = null;
  private nextMoveIn = 0;
  /** 当前待机小动作的剩余时长（秒）。 */
  private actLeft = 0;
  private act: IdleAct | null = null;
  /** 小跳的垂直偏移，向上为正。 */
  private hopLift = 0;
  /** 出生点，nearby 范围以此为锚。 */
  private anchorX: number;
  private baseY: number;
  private state: BehaviorState;

  constructor(
    x: number,
    y: number,
    private readonly rng: () => number = Math.random,
  ) {
    this.state = { x, y, motion: "idle", facing: 1, actPhase: 0 };
    this.anchorX = x;
    this.baseY = y;
    this.nextMoveIn = this.pickIdleGap();
  }

  get current(): BehaviorState {
    return this.state;
  }

  /** 外部拖动直接设定位置，并重置锚点与进行中的动作。 */
  placeAt(x: number, y: number): void {
    this.state.x = x;
    this.state.y = y;
    // 松手处成为新的活动中心 —— 用户把它放哪儿，它就在那附近待着
    this.anchorX = x;
    this.baseY = y;
    this.targetX = null;
    this.actLeft = 0;
    this.act = null;
    this.hopLift = 0;
  }

  /** 仅测试用：立即触发指定的待机动作，绕过随机等待与随机选择。 */
  triggerActForTest(act: IdleAct, input: BehaviorInput): void {
    this.targetX = null;
    this.beginSomething(input, act);
  }

  /**
   * 命令宠物走向某个目标点（速记仪式感用）。
   *
   * 打断当前待机小动作与漫游，直接走向目标。范围限制不适用于这种
   * 明确的召唤 —— 用户呼出了速记窗，宠物就该过来。
   */
  goto(targetX: number, maxX: number): void {
    this.targetX = clamp(targetX, 0, maxX);
    this.actLeft = 0;
    this.act = null;
    this.hopLift = 0;
    this.state.facing = this.targetX >= this.state.x ? 1 : -1;
  }

  /** 仪式完成，回到待机。 */
  finishGoto(): void {
    if (this.targetX === null) return;
    this.state.x = this.targetX;
    this.targetX = null;
    this.nextMoveIn = this.pickIdleGap();
    this.state.motion = "idle";
  }

  /** 是否正在执行 goto 召唤。 */
  get isSummoned(): boolean {
    return this.targetX !== null;
  }

  update(input: BehaviorInput): BehaviorState {
    if (input.held) {
      this.reset();
      this.state.motion = "held";
      return this.state;
    }

    if (input.asleep) {
      this.reset();
      this.state.y = this.baseY;
      this.state.motion = "sleep";
      this.state.actPhase = 0;
      return this.state;
    }

    if (input.scope === "still") {
      this.reset();
      this.state.y = this.baseY;
      this.state.motion = "idle";
      this.state.actPhase = 0;
      return this.state;
    }

    // 正在做待机小动作
    if (this.act !== null && this.actLeft > 0) {
      return this.continueAct(input);
    }

    if (this.targetX === null) {
      this.nextMoveIn -= input.dt;
      this.state.motion = "idle";
      this.state.actPhase = 0;
      this.state.y = this.baseY;
      if (this.nextMoveIn <= 0) {
        this.beginSomething(input);
      }
      return this.state;
    }

    return this.continueWalk(input);
  }

  private reset(): void {
    this.targetX = null;
    this.actLeft = 0;
    this.act = null;
    this.hopLift = 0;
  }

  /**
   * 间隔到了，决定是走动还是做个小动作。
   *
   * @param forceAct 仅测试用：强制指定待机动作，绕过随机选择。
   */
  private beginSomething(input: BehaviorInput, forceAct?: IdleAct): void {
    if (forceAct === undefined && this.rng() < WALK_SHARE) {
      this.targetX = this.pickTarget(input);
      this.state.facing = this.targetX >= this.state.x ? 1 : -1;
      return;
    }

    const pick =
      forceAct ??
      IDLE_ACTS[
        Math.min(IDLE_ACTS.length - 1, Math.floor(this.rng() * IDLE_ACTS.length))
      ];
    this.act = pick;
    switch (pick) {
      case "hop":
        this.actLeft = HOP_SECS;
        break;
      case "lookaround":
        this.actLeft = LOOKAROUND_SECS;
        break;
      case "stretch":
        this.actLeft = STRETCH_SECS;
        break;
    }
  }

  private continueAct(input: BehaviorInput): BehaviorState {
    this.actLeft -= input.dt;
    const act = this.act;

    if (act === "hop") {
      const t = 1 - Math.max(0, this.actLeft) / HOP_SECS;
      // 正弦弧线，起落平滑；不用重力积分，避免「被扔下来」的观感
      this.hopLift = Math.sin(t * Math.PI) * input.side * HOP_HEIGHT_RATIO;
      this.state.y = this.baseY - this.hopLift;
      this.state.actPhase = t;
      this.state.motion = "hop";
    } else if (act === "lookaround") {
      const t = 1 - Math.max(0, this.actLeft) / LOOKAROUND_SECS;
      this.state.actPhase = t;
      // 前半程看一边，后半程看另一边
      this.state.facing = t < 0.5 ? -1 : 1;
      this.state.motion = "lookaround";
    } else if (act === "stretch") {
      this.state.actPhase = 1 - Math.max(0, this.actLeft) / STRETCH_SECS;
      this.state.motion = "stretch";
    }

    if (this.actLeft <= 0) {
      this.act = null;
      this.hopLift = 0;
      this.state.y = this.baseY;
      this.state.actPhase = 0;
      this.state.motion = "idle";
      this.nextMoveIn = this.pickIdleGap();
    }
    return this.state;
  }

  private continueWalk(input: BehaviorInput): BehaviorState {
    const maxX = Math.max(0, input.bounds.width - input.side);
    const step = WALK_SPEED * input.dt;
    const remain = (this.targetX ?? this.state.x) - this.state.x;

    if (Math.abs(remain) <= step) {
      this.state.x = clamp(this.targetX ?? this.state.x, 0, maxX);
      this.targetX = null;
      this.nextMoveIn = this.pickIdleGap();
      this.state.motion = "idle";
      return this.state;
    }

    this.state.x = clamp(this.state.x + Math.sign(remain) * step, 0, maxX);
    this.state.motion = "walk";
    return this.state;
  }

  /**
   * 选一个漫游目标。
   *
   * 先定方向再定距离（而非在当前位置上加减一个可能为零的偏移），
   * 这样任何随机值都能产生一段有意义的位移 —— 否则偏移恰好接近零时
   * 会白白浪费一次漫游机会，宠物看起来「想动又没动」。
   */
  private pickTarget(input: BehaviorInput): number {
    const maxX = Math.max(0, input.bounds.width - input.side);
    const minTrip = input.side * MIN_TRIP_RATIO;
    const limit = this.reachFor(input);

    // 单次可走的最远距离：受范围限制，也受屏幕限制
    const span = Math.max(minTrip, Math.min(limit, maxX));

    const dir = this.rng() < 0.5 ? -1 : 1;
    const dist = minTrip + this.rng() * Math.max(0, span - minTrip);

    // 以锚点为中心约束，避免宠物一步步随机游走漂到天涯
    const lo = Number.isFinite(limit) ? Math.max(0, this.anchorX - limit) : 0;
    const hi = Number.isFinite(limit)
      ? Math.min(maxX, this.anchorX + limit)
      : maxX;

    let target = this.state.x + dir * dist;
    if (target < lo || target > hi) {
      target = this.state.x - dir * dist;
    }
    return clamp(target, lo, hi);
  }

  /** 当前范围允许的活动半径（像素）。Infinity 表示只受屏幕限制。 */
  private reachFor(input: BehaviorInput): number {
    const def = SCOPE_REACH[input.scope];
    if (def.sideMul !== undefined) return def.sideMul * input.side;
    if (def.widthRatio !== undefined) return def.widthRatio * input.bounds.width;
    return Infinity;
  }

  private pickIdleGap(): number {
    return IDLE_MIN + this.rng() * (IDLE_MAX - IDLE_MIN);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
