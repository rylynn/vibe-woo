import { breatheScale } from "./anim/breathe";
import {
  frameIntervalMs,
  shouldRender,
  type PetActivity,
} from "./anim/frame-budget";
import { MicroExpression, type EyeFrame } from "./anim/expression";
import { Behavior, type Motion, type RoamScope } from "./anim/behavior";
import {
  createDragState,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  type DragState,
} from "./interact/drag";
import { isInsideBox, type Box } from "./interact/hit-test";
import { appearanceFor, type Appearance } from "./appearance";
import { DEFAULT_STATE, type PetState } from "./state";
import { drawEyes, EYE_COLOR } from "./render/eyes";
import { drawBody } from "./render/body";
import { drawBrows } from "./render/brows";
import { drawAttachments, splitBodyBox } from "./render/attachments";
import { drawSpots } from "./render/patterns";
import { squashScale } from "./anim/squash";
import { DEFAULT_AVATAR, type PetAvatar } from "./avatar/types";
import { applyTint } from "./avatar/palette";

/** 像素艺术必须整数倍缩放，否则糊。基础格 48px。 */
const BASE_CELL = 48;

/**
 * 可选的整数倍档位 → 48 / 96 / 144 / 192 px。
 *
 * 只能是整数倍：设计文档 5.2 明确牺牲滑块自由度来换像素锐利。
 * 因此「比 144 小一半」（72px）不是合法取值 —— 96px 是最接近的合法档位。
 */
export const SIZE_STEPS = [1, 2, 3, 4] as const;

/** 默认 2x = 96px。 */
const DEFAULT_SIZE_INDEX = 1;

/**
 * 呼吸幅度。
 *
 * 刻意做得很含蓄（0.02）：宠物的生命感来自微表情 —— 眨眼节奏、眼神游走，
 * 而非身体的缩放。幅度大了会变成廉价的「闪烁感」，看两天就腻。
 *
 * ⚠️ M3 换精灵图时必须废弃这套「代码缩放呼吸」。连续缩放会让实际渲染
 * 边长在约 95% 的帧里不是 BASE_CELL 的整数倍。当前身体是纯色 fillRect，
 * 无视觉影响；一旦改成 drawImage(spriteSheet, ...)，每帧重采样会让精灵
 * 持续抖动。正确做法是把呼吸交给美术，在 idle 动画的 2–4 帧里让身体
 * 高度差 1–2 个艺术像素，代码只负责按整数倍放大播放。
 */
const BREATHE_AMPLITUDE = 0.02;
const POKE_FEEDBACK_MS = 400;

/** 鼠标进入此范围（相对身体边长的倍数）时，宠物会看向它。 */
const GAZE_RANGE = 3.2;

/** 今日特效奖励（认真休息所得，隔天失效）。 */
/** 特效池（与 Rust rewards::RewardEffect 对齐，2026-08-31 设计 7.4 扩到 10）。 */
export type RewardEffect =
  | "tomato"
  | "bubbles"
  | "sparkle"
  | "leaf"
  | "halo"
  | "crown"
  | "music"
  | "heart"
  | "fire"
  | "glasses";

/** 深夜黑眼圈颜色。 */
const TIRED_COLOR = "#4a5a7a";

/** dither 辉光的圈数。 */
const GLOW_RINGS = 2;

/**
 * 一帧的全部「影响像素」参数（均已或近似量化到整数像素）。
 *
 * 供 frameVisualKey 组成跳帧判据 —— 渲染层（eyes/body/brows）全部用
 * Math.round 量化输出，因此量化参数相同 ⇒ 逐像素相同。
 */
export interface VisualFrame {
  /** 身体左上角（已取整）。 */
  px: number;
  py: number;
  /** 形变后宽高（已取整）。 */
  w: number;
  h: number;
  /** 走动起伏（0 或整数格）。 */
  bob: number;
  /** 眼型。 */
  shape: string;
  /** 眼皮 0..1。 */
  lid: number;
  /** 视线 -1..1。 */
  gazeX: number;
  gazeY: number;
  /** 是否画辉光。 */
  glow: boolean;
  /** 是否画黑眼圈。 */
  tired: boolean;
}

/**
 * 组成一帧的视觉指纹：相同指纹 ⇒ 这一帧画出来与上一帧逐像素相同。
 *
 * lid / gaze 是连续量，按渲染粒度量化后进指纹 —— 眼高约 20-30px、
 * 眼球行程约 5px，1/32 的眼皮档与 1/16 的视线档都在亚像素级，
 * 不会产生可感知的跳变。
 */
export function frameVisualKey(f: VisualFrame): string {
  return [
    f.px,
    f.py,
    f.w,
    f.h,
    f.bob,
    f.shape,
    Math.round(f.lid * 32),
    Math.round(f.gazeX * 16),
    Math.round(f.gazeY * 16),
    f.glow ? 1 : 0,
    f.tired ? 1 : 0,
  ].join(",");
}

/** 整数 → 0..1 的确定性伪随机。星星特效的位置由它决定，无需维护状态。 */
function pseudoRandom(seed: number): number {
  // Math.imul 保证 32 位乘法不丢精度（seed 来自 nowMs，可能超出 2^32）
  let x = Math.imul(seed | 0, 2654435761);
  x ^= x >>> 13;
  x = Math.imul(x, 1274126177);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

export class Pet {
  private x = 200;
  private y = 200;
  /** SIZE_STEPS 的下标，而非倍数本身。 */
  private sizeIndex = DEFAULT_SIZE_INDEX;
  private activity: PetActivity = "idle";
  private drag: DragState = createDragState();
  private lastRenderMs = 0;
  /** 不在家（串门中）：不绘制、不可点。 */
  private hidden = false;
  private lastTickMs = 0;
  private pokeUntilMs = 0;
  /** 本帧是否是刚刚被点击（用于触发惊讶表情）。 */
  private pokeEdge = false;
  private currentSide = BASE_CELL * SIZE_STEPS[DEFAULT_SIZE_INDEX];
  /** 上一帧实际画过的区域，用于脏矩形清除。null 表示需整屏清除。 */
  private dirty: Box | null = null;
  /** 上一帧的视觉指纹。相同则整帧跳过（不触碰 canvas）。 */
  private lastDrawKey: string | null = null;
  /** 由 Rust 传感器推送的状态推导出的外观。 */
  private look: Appearance = appearanceFor(DEFAULT_STATE);
  /** 形象（长相）：形状/眼风/眉/基色/动作偏好。 */
  private avatar: PetAvatar = DEFAULT_AVATAR;
  private readonly expr = new MicroExpression();
  private readonly behavior: Behavior;
  private motion: Motion = "idle";
  private facing: -1 | 1 = 1;
  /** 待机动作进度 0..1，驱动形变。 */
  private actPhase = 0;
  /** 活动范围。默认只在附近晃，不打扰是第一原则。 */
  private scope: RoamScope = "nearby";
  private eye: EyeFrame = {
    shape: "round",
    lid: 0,
    gazeX: 0,
    gazeY: 0,
  };
  /** 最近已知的鼠标位置，用于视线跟随。 */
  private cursor: { x: number; y: number } | null = null;
  /** 今日特效奖励（吃番茄/吐泡泡/星星闪）。 */
  private effects: Set<RewardEffect> = new Set();
  private readonly startMs = performance.now();

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
  ) {
    this.behavior = new Behavior(this.x, this.y);
  }

  /**
   * 把宠物安置到初始位置（屏幕偏右下，避开常用的编辑器主区域）。
   *
   * 首次 resize 后调用。不做下落动画 —— 宠物是桌面上的伙伴，
   * 出场就该在那儿待着，而不是从天上砸下来。
   */
  private placeInitial(): void {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (w <= 0 || h <= 0) return;
    this.x = Math.round(w * 0.78);
    this.y = Math.round(h * 0.72);
    this.behavior.placeAt(this.x, this.y);
    this.dirty = null;
    this.lastDrawKey = null;
  }

  /** 基准边长，恒为 BASE_CELL 的整数倍。 */
  private get side(): number {
    return BASE_CELL * SIZE_STEPS[this.sizeIndex];
  }

  get body(): Box {
    return { x: this.x, y: this.y, w: this.side, h: this.side };
  }

  /**
   * 上一帧实际绘制的边长（含呼吸形变），与基准边长 body.w 不同。
   *
   * 存在的意义是让测试能断言真正画出去的尺寸 —— 只断言 body.w
   * 会漏掉一切发生在呼吸环节的回归。
   */
  get renderedSide(): number {
    return this.currentSide;
  }

  /** 仅供测试断言活跃度未被交互污染。 */
  get activityForTest(): PetActivity {
    return this.activity;
  }

  /** 当前眼睛状态，供测试与调试。 */
  get eyeFrame(): EyeFrame {
    return this.eye;
  }

  /** 当前动作，供测试与调试。 */
  get currentMotion(): Motion {
    return this.motion;
  }

  /** 设置活动范围。 */
  setScope(s: RoamScope): void {
    this.scope = s;
  }

  get scopeValue(): RoamScope {
    return this.scope;
  }

  /** 命令宠物走向某点（速记仪式感用），不受范围限制。 */
  summonTo(x: number): void {
    const maxX = Math.max(0, this.canvas.width - this.side);
    this.behavior.goto(x - this.side / 2, maxX);
  }

  /** 仪式结束，回到待机。 */
  finishSummon(): void {
    this.behavior.finishGoto();
  }

  /** 是否正在被召唤前往速记窗。 */
  get summoned(): boolean {
    return this.behavior.isSummoned;
  }

  /**
   * 拖动中必须锁住鼠标接管权。
   *
   * 快速拖动时光标会甩到包围盒之外，若此刻 Rust 恢复穿透，pointermove
   * 就会丢失，宠物「脱手」黏在半路。因此拖动期间要求 Rust 保持接管。
   */
  get isDragging(): boolean {
    return this.drag.dragging;
  }

  private get poked(): boolean {
    return performance.now() < this.pokeUntilMs;
  }

  /** 返回是否命中宠物身体，未命中则不拦截该次点击。 */
  pointerDown(px: number, py: number): boolean {
    if (!isInsideBox(px, py, this.body)) return false;
    this.drag = onPointerDown(this.drag, { px, py }, this.body);
    this.pokeUntilMs = performance.now() + POKE_FEEDBACK_MS;
    this.pokeEdge = true;
    return true;
  }

  /** 纯查询，不产生副作用。用于右键菜单等需要先判定再决定行为的场景。 */
  hitTest(px: number, py: number): boolean {
    return !this.hidden && isInsideBox(px, py, this.body);
  }

  pointerMove(px: number, py: number): void {
    this.cursor = { x: px, y: py };
    const pos = onPointerMove(this.drag, { px, py });
    if (!pos) return;
    this.x = pos.x;
    this.y = pos.y;
    // 拖动直接改位置，需同步给行为引擎，否则松手会从旧位置继续掉落
    this.behavior.placeAt(this.x, this.y);
  }

  pointerUp(): void {
    this.drag = onPointerUp(this.drag);
  }

  /** 由 rAF 驱动；返回本次是否真的绘制了（便于观察 CPU 占用）。 */
  tick(nowMs: number): boolean {
    if (this.hidden) return false; // 不在家：不画不推进，零开销
    this.stepBehavior(nowMs);
    const activity = this.effectiveActivity();
    if (!shouldRender(nowMs, this.lastRenderMs, activity)) return false;
    this.lastRenderMs = nowMs;
    this.draw(nowMs);
    return true;
  }

  /**
   * 离家/回家（去好友家串门）。
   *
   * 离家时隐藏本体并清空画布；回家后强制重绘（lastRenderMs 归零）。
   * hitTest/body 在隐藏时返回空，右键菜单与拖动自然失效 ——
   * 基础功能（速记/设置/菜单栏）不依赖宠物本体，仍可用。
   */
  setHidden(h: boolean): void {
    if (this.hidden === h) return;
    this.hidden = h;
    if (h) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.drag = onPointerUp(this.drag);
    } else {
      this.lastRenderMs = 0;
      this.lastDrawKey = null; // 画布已清空多时，回家必须整帧重画
    }
  }

  get isHidden(): boolean {
    return this.hidden;
  }

  /**
   * 推进自主行为。
   *
   * 与渲染分离：行为必须按真实时间步进，否则低帧率下宠物会走得像慢动作。
   * 走动期间需要提帧，而提帧的判断又依赖 motion —— 所以先算行为再判帧率。
   */
  private stepBehavior(nowMs: number): void {
    const dt = this.lastTickMs === 0 ? 0 : (nowMs - this.lastTickMs) / 1000;
    this.lastTickMs = nowMs;
    // 切窗口/休眠回来时 dt 可能极大，钳制避免宠物瞬移或穿透地面。
    // 上限须 ≥ 渲染预算的最慢帧间隔（idle 12fps ≈ 83ms），否则低帧率档
    // 下行为引擎的内部时钟会比真实时间慢。走动/眨眼等动态场景在 active
    // 档（30fps ≈ 33ms），不受此钳制影响。
    const safeDt = Math.min(dt, 0.12);
    if (safeDt <= 0) return;

    const s = this.behavior.update({
      dt: safeDt,
      bounds: { width: this.canvas.width, height: this.canvas.height },
      side: this.side,
      held: this.drag.dragging,
      asleep: this.look.asleep,
      scope: this.scope,
    });

    this.motion = s.motion;
    this.facing = s.facing;
    this.actPhase = s.actPhase;
    if (!this.drag.dragging) {
      this.x = s.x;
      this.y = s.y;
    }
  }

  /**
   * 交互期间临时提到 active，保证拖动、点击反馈与眨眼动画不掉帧。
   *
   * 关键：不写回 this.activity。否则拖一下睡着的宠物，松手后它会
   * 「忘记」自己本该在睡觉 —— 传感器驱动下这会变成真 bug。
   */
  private effectiveActivity(): PetActivity {
    if (this.poked || this.drag.dragging) return "active";
    // 任何移动或形变中的动作都必须提帧，否则会一顿一顿的
    if (this.motion !== "idle" && this.motion !== "sleep") return "active";
    // 眨眼只有约 180ms，睡眠态 4fps 下会被跳过导致「跳帧眨眼」。
    // 眨眼期间临时提帧，眨完自动回落。
    if (this.eye.lid > 0 && this.eye.shape !== "closed") return "active";
    return this.activity;
  }

  private draw(nowMs: number): void {
    const { ctx } = this;

    // 「不动」意味着视觉上完全静止：位置与尺寸都不变。
    //
    // 呼吸缩放会让整个身体轮廓伸缩，这是余光最容易察觉的那种「动」——
    // 保留它就谈不上不动。眨眼与眼神保留：那只是眼睛区域几个像素的
    // 局部变化，不改变轮廓，不会干扰你，但宠物不会变成一张死图片。
    const amp = this.scope === "still" ? 0 : BREATHE_AMPLITUDE;
    const scale = breatheScale(
      nowMs - this.startMs,
      this.look.breathePeriodMs,
      amp,
    );
    const side = Math.round(this.side * scale);
    this.currentSide = side;

    // 挤压/拉伸形变：动作的可读性主要来自这个，不是位移本身
    const { w, h } = this.squash(side);
    this.currentSide = w;

    // 水平居中、底部对齐 —— 形变时脚不能离地，否则像在飘
    const px = Math.round(this.x + (this.side - w) / 2);
    const bob = this.motion === "walk" ? this.walkBob(nowMs, side) : 0;
    const py = Math.round(this.y + (this.side - h) - bob);

    this.eye = this.expr.update(nowMs, {
      asleep: this.look.asleep,
      stuck: this.look.peeking,
      flow: this.look.tint === "focused",
      tired: this.look.tired,
      poked: this.pokeEdge,
      mood: this.look.mood === "content" || this.look.mood === "frustrated" || this.look.mood === "bored"
        ? this.look.mood
        : null,
      gazeTarget: this.gazeTarget(px, py, w, h),
    });
    this.pokeEdge = false;

    // 无变化跳帧：视觉指纹与上一帧相同 ⇒ 输出逐像素相同，整帧跳过。
    // 不触碰 canvas 就不会触发 WebKit 层合成（RemoteLayerTree 事务会
    // 一路走到 GPU 进程）—— 这是空闲 CPU 的关键路径：idle 档 12fps 里，
    // 相邻两帧的呼吸/视线多数停在同一个像素上。特效是常驻动画，
    // 激活期间不做跳帧。
    if (this.effects.size === 0) {
      const key = frameVisualKey({
        px,
        py,
        w,
        h,
        bob,
        shape: this.eye.shape,
        lid: this.eye.lid,
        // 闭眼时眼球位移不产生任何像素（visibleH=0），
        // 扫视照常发生但不必为之重绘
        gazeX: this.eye.shape === "closed" ? 0 : this.eye.gazeX,
        gazeY: this.eye.shape === "closed" ? 0 : this.eye.gazeY,
        glow: this.look.tint === "focused",
        tired: this.look.tired,
      });
      if (key === this.lastDrawKey) return;
      this.lastDrawKey = key;
    }

    // 脏矩形清除：只擦上一帧画过的区域，不整屏 clearRect。
    // 全屏清除（1440×900 ≈ 130 万像素）会让 GPU 每帧重新合成整个透明层。
    this.clearDirty();

    // 辉光只在「进入状态」时出现 —— 它是语义信号（你来劲了），
    // 不是常驻装饰。常亮的辉光就是廉价的闪烁感。
    if (this.look.tint === "focused") {
      this.drawDitherGlow(px, py, w, h);
    }

    // 形象合成：身体（形状+纹理）→ 特征件（顶部预留区）→ 眼睛 → 眉毛。
    // 特征件存在时身体压缩高度，附件画在 bbox 内顶部（脏矩形零改动）。
    const full = { bodyX: px, bodyY: py, w, h };
    const { body } = splitBodyBox(full, this.avatar.attachment);
    const bodyColor = this.bodyColor();
    const secondary = this.avatar.secondaryColor
      ? applyTint(this.avatar.secondaryColor, this.look.tint)
      : "";
    drawBody(
      ctx,
      this.avatar.shape,
      body.x,
      body.y,
      body.w,
      body.h,
      bodyColor,
      this.avatar.pattern === "stripes" && secondary ? secondary : undefined,
    );
    if (this.avatar.pattern === "spots" && secondary) {
      drawSpots(ctx, this.avatar.shape, body, secondary);
    }
    drawAttachments(ctx, full, this.avatar.attachment, this.accentColor());

    const layout = { bodyX: body.x, bodyY: body.y, w: body.w, h: body.h };
    drawEyes(
      ctx,
      layout,
      this.eye,
      {
        iris: EYE_COLOR,
        catchlight: this.accentColor(),
        eyebag: this.look.tired ? TIRED_COLOR : null,
      },
      this.avatar.eyeStyle,
    );
    drawBrows(
      ctx,
      layout,
      this.avatar.browStyle,
      this.eye,
      this.accentColor(),
      this.avatar.eyeStyle,
    );

    if (this.effects.size > 0) {
      this.drawEffects(ctx, px, py, w, h, nowMs);
    }

    this.dirty = this.glowBounds(px, py, w, h);
  }

  /**
   * 今日特效：吃番茄 / 吐泡泡 / 星星闪。
   *
   * 全部无状态、由 nowMs 确定性驱动 —— 没有粒子系统，没有缓冲区，
   * 每帧直接按相位画。像素风容错高，12fps 的 idle 档也够顺。
   */
  private drawEffects(
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    w: number,
    h: number,
    nowMs: number,
  ): void {
    const cell = Math.max(2, Math.round(w / 24));

    if (this.effects.has("tomato")) {
      // 咀嚼节奏：4 秒一循环，前 1.6 秒叼着番茄
      const phase = (nowMs % 4000) / 4000;
      if (phase < 0.4) {
        const size = cell * 3;
        const tx = Math.round(px + w / 2 + this.facing * w * 0.22 - size / 2);
        const ty = Math.round(py + h * 0.68);
        ctx.fillStyle = "#ff5c47";
        ctx.fillRect(tx, ty, size, size);
        // 番茄蒂：顶上一小块绿
        ctx.fillStyle = "#5ccc6a";
        ctx.fillRect(tx + cell, ty - cell, cell, cell);
        // 咀嚼起伏：第二阶段往下蹭一个像素
        if (phase > 0.2) ctx.fillRect(tx, ty + 1, size, 0);
      }
    }

    if (this.effects.has("bubbles")) {
      // 两个泡泡错相位上浮：2.6 秒一轮，飘到头顶约 0.55 倍边长处消散。
      // 不用透明度渐隐 —— 与辉光同一硬约束：绝不产生半透明像素，
      // 消散感用「升到高处就消失」表达，够像素风了。
      const rise = h * 0.55;
      for (const off of [0, 0.5]) {
        const p = ((nowMs / 2600 + off) % 1 + 1) % 1;
        if (p > 0.75) continue; // 后段消散
        const bx = Math.round(px + w * (0.62 - 0.24 * p));
        const by = Math.round(py - cell - p * rise);
        const size = Math.max(2, cell - 1);
        ctx.fillStyle = "#bfe9ff";
        ctx.fillRect(bx, by, size, size);
        ctx.fillStyle = "#e8f7ff";
        ctx.fillRect(bx, by, Math.max(1, size - 2), Math.max(1, size - 2));
      }
    }

    if (this.effects.has("sparkle")) {
      // 1.8 秒闪一颗：位置由轮次伪随机决定，前 0.25 段可见。
      // 同样不做透明度 —— 一闪而过本身就是闪烁感。
      const round = Math.floor(nowMs / 1800);
      const p = (nowMs % 1800) / 1800;
      if (p < 0.25) {
        const r = pseudoRandom(round);
        const sx = Math.round(px + w * (0.1 + 0.8 * r));
        const sy = Math.round(py + h * (0.1 + 0.8 * pseudoRandom(round + 1)));
        const size = cell;
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(sx - size, sy, size, size);
        ctx.fillRect(sx + size, sy, size, size);
        ctx.fillRect(sx, sy - size, size, size);
        ctx.fillRect(sx, sy + size, size, size);
      }
    }

    // —— 特效池扩容（2026-08-31 设计 7.4）：全部少量 fillRect、
    // 无状态、由 nowMs 确定性驱动，与既有三个同一套约束。 ——

    if (this.effects.has("leaf")) {
      // 头顶小芽：茎 + 两片叶，随风摆动（1.6s 一周期左右各 1px）
      const sway = Math.sin((nowMs / 1600) * Math.PI * 2) > 0 ? 1 : 0;
      const bx = Math.round(px + w / 2 - cell / 2);
      const by = Math.round(py - cell * 2);
      ctx.fillStyle = "#5ccc6a";
      ctx.fillRect(bx + sway, by, cell, cell * 2); // 茎
      ctx.fillRect(bx - cell + sway, by, cell, cell); // 左叶
      ctx.fillRect(bx + cell + sway, by, cell, cell); // 右叶
    }

    if (this.effects.has("halo")) {
      // 头顶光环：点阵椭圆环（棋盘 alpha=1，沿用 dither 手法）
      const cy = Math.round(py - cell * 2);
      const cx = Math.round(px + w / 2);
      ctx.fillStyle = "#ffe066";
      const rx = Math.max(3, Math.round(w / 5));
      for (let i = -rx; i <= rx; i += cell) {
        if ((i / cell) % 2 !== 0) continue; // 棋盘点阵
        const dy = Math.round(Math.sqrt(Math.max(0, rx * rx - i * i)) / 2);
        ctx.fillRect(cx + i, cy - dy, cell, cell);
        if (dy !== 0) ctx.fillRect(cx + i, cy + dy, cell, cell);
      }
    }

    if (this.effects.has("crown")) {
      // 头顶小王冠：底沿 + 三个尖齿，金色
      const cw = cell * 5;
      const cx = Math.round(px + w / 2 - cw / 2);
      const cy = Math.round(py - cell * 2);
      ctx.fillStyle = "#ffd24a";
      ctx.fillRect(cx, cy + cell, cw, cell); // 底沿
      ctx.fillRect(cx, cy, cell, cell); // 左齿
      ctx.fillRect(cx + cell * 2, cy, cell, cell); // 中齿
      ctx.fillRect(cx + cell * 4, cy, cell, cell); // 右齿
    }

    if (this.effects.has("music")) {
      // 身旁飘音符：四分音符（符头 + 符干），2.4s 一轮上浮消散
      const p = ((nowMs / 2400) % 1 + 1) % 1;
      if (p < 0.7) {
        const size = cell;
        const nx = Math.round(px - cell - p * w * 0.15);
        const ny = Math.round(py + h * 0.4 - p * h * 0.6);
        ctx.fillStyle = "#a8c0ff";
        ctx.fillRect(nx, ny, size, size); // 符头
        ctx.fillRect(nx + size, ny - cell * 3, Math.max(1, size - 1), cell * 3); // 符干
      }
    }

    if (this.effects.has("heart")) {
      // 身旁冒爱心：2s 一轮，两格宽的心形像素图样
      const p = ((nowMs / 2000) % 1 + 1) % 1;
      if (p < 0.6) {
        const size = cell;
        const hx = Math.round(px + w - cell + p * w * 0.1);
        const hy = Math.round(py + h * 0.35 - p * h * 0.5);
        ctx.fillStyle = "#ff8fab";
        ctx.fillRect(hx, hy, size, size);
        ctx.fillRect(hx + size * 2, hy, size, size);
        ctx.fillRect(hx - 0, hy + size, size * 3, size);
        ctx.fillRect(hx + size, hy + size * 2, size, size);
      }
    }

    if (this.effects.has("fire")) {
      // 身后燃火苗：两段焰心错相位跳动（0.3s 一拍），暖色
      const flick = Math.floor(nowMs / 300) % 2;
      const fx = Math.round(px - cell * 3);
      const fy = Math.round(py + h - cell * 3);
      ctx.fillStyle = "#ff7a3c";
      ctx.fillRect(fx, fy, cell, cell * 2);
      ctx.fillRect(fx - cell, fy + cell, cell * 3, cell);
      ctx.fillStyle = "#ffd24a";
      ctx.fillRect(fx, fy + cell + (flick ? 0 : cell), cell, cell); // 焰心闪动
    }

    if (this.effects.has("glasses")) {
      // 戴上小眼镜：两镜框 + 鼻梁，画在眼睛行（身体上 1/3 处）
      const gs = Math.max(2, cell * 2);
      const gy = Math.round(py + h * 0.3);
      const gap = Math.max(1, cell);
      const lx = Math.round(px + w / 2 - gs - gap / 2 - cell);
      ctx.fillStyle = "#bfe9ff";
      ctx.fillRect(lx, gy, gs, gs);
      ctx.fillRect(lx + gs + gap + cell * 2, gy, gs, gs);
      ctx.fillRect(lx + gs, gy + gs / 2, gs + gap + cell * 2, Math.max(1, cell - 1)); // 鼻梁
    }
  }

  /**
   * 挤压/拉伸形变（squash & stretch）。
   *
   * 这是动画的基本功，也是待机动作可读性的主要来源 —— 位移本身很小，
   * 观众感知到的是形状变化。体积近似守恒（宽变窄则高变高）。
   *
   * 量化到整数像素：像素艺术里亚像素尺寸会让边缘看起来在抖。
   */
  private squash(side: number): { w: number; h: number } {
    // 公式见 anim/squash.ts（与形象选择弹窗的预览共享）
    const { sx, sy } = squashScale(this.motion, this.actPhase);

    // 量化到整数像素：像素艺术里亚像素尺寸会让边缘看起来在抖
    return {
      w: Math.max(4, Math.round(side * sx)),
      h: Math.max(4, Math.round(side * sy)),
    };
  }

  /**
   * 走动时的上下起伏。
   *
   * 量化到整数像素：像素艺术里连续的亚像素位移会让边缘看起来在抖。
   * 幅度只有 1–2 个渲染像素，足够读出「在走」，又不显得夸张。
   */
  private walkBob(nowMs: number, side: number): number {
    const cell = Math.max(1, Math.round(side / 24));
    const phase = Math.sin((nowMs / 150) * Math.PI);
    return phase > 0.35 ? cell : 0;
  }

  /**
   * 鼠标在附近时返回方向向量（-1..1），否则 null（转为随机扫视）。
   *
   * 让宠物看向你的光标是「被注视」感的来源，成本极低但效果明显。
   */
  private gazeTarget(
    px: number,
    py: number,
    w: number,
    h: number,
  ): { x: number; y: number } | null {
    if (this.cursor) {
      const cx = px + w / 2;
      const cy = py + h / 2;
      const range = this.side * GAZE_RANGE;
      const dx = this.cursor.x - cx;
      const dy = this.cursor.y - cy;
      if (Math.abs(dx) <= range && Math.abs(dy) <= range) {
        return { x: dx / range, y: dy / range };
      }
    }
    // 走动或张望时看向朝向 —— 边走边盯着别处会显得很怪
    if (this.motion === "walk" || this.motion === "lookaround") {
      return { x: this.facing * 0.85, y: 0 };
    }
    return null;
  }

  /** 形象基色 × 状态色调：focused 提亮、dim 压暗降饱和。 */
  private bodyColor(): string {
    return applyTint(this.avatar.bodyColor, this.look.tint);
  }

  /** 点缀色（高光/眉毛）随状态色调同规则变换，保持整体协调。 */
  private accentColor(): string {
    return applyTint(this.avatar.accentColor, this.look.tint);
  }

  /** 擦除上一帧的脏矩形；首帧或 resize 后为整屏。 */
  private clearDirty(): void {
    const d = this.dirty;
    if (!d) {
      this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      return;
    }
    this.ctx.clearRect(d.x, d.y, d.w, d.h);
  }

  /**
   * 宠物加上辉光与特效后的实际占用范围。
   *
   * 容差要盖住形变、走动起伏与移动位移，否则移动时会留下残影。
   * 特效（泡泡上浮、星星闪烁）会画到身体之外，也要算进来。
   */
  private glowBounds(px: number, py: number, w: number, h: number): Box {
    const moving = this.motion !== "idle" && this.motion !== "sleep";
    const base = Math.max(w, h);
    let pad = this.glowInset(base) + (moving ? Math.max(10, base * 0.25) : 3);
    if (this.effects.size > 0) {
      pad = Math.max(pad, base * 0.65);
    }
    return {
      x: px - pad,
      y: py - pad,
      w: w + pad * 2,
      h: h + pad * 2,
    };
  }

  /** 辉光向外延伸的距离，与 drawDitherGlow 的最外圈保持一致。 */
  private glowInset(side: number): number {
    return this.glowCell(side) * GLOW_RINGS;
  }

  private glowCell(side: number): number {
    return Math.max(2, Math.round(side / 24));
  }

  /**
   * dithering 辉光：棋盘点阵，每个像素 alpha 只有 0 或 1。
   *
   * 不用 shadowBlur / CSS bloom：那会产生大片低 alpha 像素，且比点阵
   * 昂贵得多。点阵发光也更贴合像素美术。详见设计文档 3.1.4。
   */
  private drawDitherGlow(px: number, py: number, bw: number, bh: number): void {
    const { ctx } = this;
    const cell = this.glowCell(Math.max(bw, bh));
    // 辉光只在 focused 时调用，与身体提亮色同源，保持色相协调
    ctx.fillStyle = this.bodyColor();

    for (let ring = 1; ring <= GLOW_RINGS; ring++) {
      const inset = ring * cell;
      const x0 = px - inset;
      const y0 = py - inset;
      const w = bw + inset * 2;
      const h = bh + inset * 2;

      for (let i = 0; i < w; i += cell) {
        for (let j = 0; j < h; j += cell) {
          const onEdge = i < cell || j < cell || i >= w - cell || j >= h - cell;
          if (!onEdge) continue;
          // 棋盘取点：ring 越外，点阵越稀
          if ((i / cell + j / cell + ring) % (ring + 1) !== 0) continue;
          ctx.fillRect(x0 + i, y0 + j, cell, cell);
        }
      }
    }
  }

  resize(w: number, h: number): void {
    const first = this.canvas.width === 0 || this.canvas.height === 0;
    this.canvas.width = w;
    this.canvas.height = h;
    // 尺寸变化会清空画布内容，强制下一帧立即重绘
    this.lastRenderMs = 0;
    // 画布已被清空，上一帧的脏矩形失效
    this.dirty = null;
    // 画布已被清空，视觉指纹同样失效
    this.lastDrawKey = null;

    if (first) {
      this.placeInitial();
      return;
    }
    // 屏幕变小后宠物可能落在可视区之外，拉回来
    this.x = Math.min(this.x, Math.max(0, w - this.side));
    this.y = Math.min(this.y, Math.max(0, h - this.side));
    this.behavior.placeAt(this.x, this.y);
  }

  cycleSize(): void {
    this.sizeIndex = (this.sizeIndex + 1) % SIZE_STEPS.length;
    // 尺寸变化后旧脏矩形范围不足以覆盖新尺寸，会留下残影
    this.dirty = null;
    this.lastDrawKey = null;
  }

  /** 设置形象。联动动作风格到行为层，并立即重绘。 */
  setAvatar(a: PetAvatar): void {
    this.avatar = a;
    this.behavior.setActionStyle(a.actionStyle);
    this.dirty = null;
    this.lastRenderMs = 0;
    this.lastDrawKey = null; // 配色/五官已变，指纹必然失效
  }

  /** 当前形象（供测试与设置面板回显）。 */
  get avatarValue(): PetAvatar {
    return this.avatar;
  }

  /** 设置尺寸档位。越界会让宠物直接消失，故做钳制。 */
  setSizeIndex(i: number): void {
    const next = Math.min(SIZE_STEPS.length - 1, Math.max(0, Math.floor(i)));
    if (next === this.sizeIndex) return;
    this.sizeIndex = next;
    this.dirty = null;
    this.lastDrawKey = null;
  }

  get sizeIndexValue(): number {
    return this.sizeIndex;
  }

  /** 设置今日特效（Rust 奖励事件驱动）。空数组即清除。 */
  setEffects(list: RewardEffect[]): void {
    const next = new Set(list);
    if (next.size === this.effects.size && [...next].every((e) => this.effects.has(e))) {
      return;
    }
    this.effects = next;
    // 特效范围与身体不同（泡泡往上飘），脏矩形策略要跟着变
    this.dirty = null;
    this.lastRenderMs = 0;
    this.lastDrawKey = null;
  }

  /** 当前生效的特效（供测试断言）。 */
  get activeEffects(): Set<RewardEffect> {
    return this.effects;
  }

  /** 接收 Rust 传感器推送的状态。 */
  applyState(s: PetState): void {
    this.look = appearanceFor(s);
    this.activity = this.look.activity;
    // 表情与配色已变，立即重绘而非等下一个帧率周期
    this.lastRenderMs = 0;
    // 配色（tint）/ 黑眼圈（tired）/ 眼型（mood→shape）都随状态变
    this.lastDrawKey = null;
  }

  get appearance(): Appearance {
    return this.look;
  }

  setActivity(a: PetActivity): void {
    this.activity = a;
  }

  get debugIntervalMs(): number {
    return frameIntervalMs(this.effectiveActivity());
  }
}
