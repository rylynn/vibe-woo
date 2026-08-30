/**
 * 微表情引擎。
 *
 * 设计取向（参考 NOMI）：宠物的情绪**全部由一双眼睛承担** —— 眼型形变、
 * 视线转动、眨眼节奏。不靠发光、缩放这类特效。
 *
 * 原因：辉光和缩放是「机械」信号，看两天就腻。而眨眼节奏与眼神游走是
 * 生物信号 —— 困了眨得慢而长，专注时几乎不眨，思考时视线会飘。
 * 这些细节不需要用户刻意观察就能感知到「它活着」。
 */

export type EyeShape =
  /** 常态：饱满的圆眼 */
  | "round"
  /** 惊讶：睁大 */
  | "wide"
  /** 专注：微眯 */
  | "squint"
  /** 困倦：半闭 */
  | "half"
  /** 开心：下弯的月牙 */
  | "happy"
  /** 烦躁：皱眉（眼睛略扁、向内倾） */
  | "worried"
  /** 无聊：眼皮耷拉 */
  | "droopy"
  /** 睡眠：闭合 */
  | "closed";

export interface EyeFrame {
  shape: EyeShape;
  /** 眨眼闭合程度，0 全睁、1 全闭。 */
  lid: number;
  /** 眼球水平偏移，-1（左）..1（右）。 */
  gazeX: number;
  /** 眼球垂直偏移，-1（上）..1（下）。 */
  gazeY: number;
}

/** 驱动微表情所需的外部输入。 */
export interface ExprInput {
  /** 是否处于睡眠（人已离开）。 */
  asleep: boolean;
  /** 是否在编辑器里卡住（思考 / 等 AI）。 */
  stuck: boolean;
  /** 是否进入状态（高频击键）。 */
  flow: boolean;
  /** 是否深夜疲态。 */
  tired: boolean;
  /** 刚被点击。 */
  poked: boolean;
  /** 心情修饰：心满意足 / 烦躁 / 无聊。 */
  mood?: "content" | "frustrated" | "bored" | null;
  /**
   * 视线目标，取值 -1..1 的方向向量；null 表示无目标（转为随机扫视）。
   * 通常是鼠标相对宠物中心的方向。
   */
  gazeTarget: { x: number; y: number } | null;
}

interface BlinkStyle {
  /** 眨眼间隔下限（毫秒）。 */
  minGap: number;
  /** 眨眼间隔上限（毫秒）。 */
  maxGap: number;
  /** 单次眨眼时长（毫秒）。 */
  duration: number;
}

/**
 * 各状态的眨眼风格。这组数字就是「情绪」本身：
 * 困倦眨得慢而长、专注几乎不眨、思考时略少。
 * 烦躁时眨眼明显更频繁 —— 人焦虑时确实如此。
 */
const BLINK: Record<"tired" | "flow" | "stuck" | "normal" | "frustrated" | "bored", BlinkStyle> = {
  tired: { minGap: 1400, maxGap: 3200, duration: 340 },
  flow: { minGap: 4200, maxGap: 9000, duration: 130 },
  stuck: { minGap: 3000, maxGap: 7000, duration: 190 },
  normal: { minGap: 2200, maxGap: 5500, duration: 180 },
  frustrated: { minGap: 900, maxGap: 2400, duration: 140 },
  bored: { minGap: 3400, maxGap: 8000, duration: 220 },
};

/** 眨眼曲线中闭合阶段的占比。闭得快、睁得慢更自然。 */
const CLOSE_RATIO = 0.4;

interface SaccadeStyle {
  minGap: number;
  maxGap: number;
  /** 眼球偏移幅度上限，0..1。 */
  amplitude: number;
}

/**
 * 眼球扫视风格。
 *
 * flow 时几乎锁定（盯着屏幕），stuck 时幅度最大且慢 —— 思考时视线会飘，
 * 这是「在想事情」最可信的外显。
 */
const SACCADE: Record<"flow" | "stuck" | "normal", SaccadeStyle> = {
  flow: { minGap: 1800, maxGap: 3600, amplitude: 0.15 },
  stuck: { minGap: 900, maxGap: 2200, amplitude: 0.75 },
  normal: { minGap: 800, maxGap: 2400, amplitude: 0.4 },
};

/** 被点击后维持惊讶表情的时长。 */
const POKE_WIDE_MS = 420;

export class MicroExpression {
  private blinkScheduled = false;
  private nextBlinkAt = 0;
  private blinkStartedAt: number | null = null;
  private blinkDuration = BLINK.normal.duration;

  private nextSaccadeAt = 0;
  private saccadeX = 0;
  private saccadeY = 0;

  private pokedUntil = 0;
  /** 平滑后的视线，避免眼球瞬移。 */
  private smoothX = 0;
  private smoothY = 0;

  constructor(private readonly rng: () => number = Math.random) {}

  update(nowMs: number, input: ExprInput): EyeFrame {
    if (input.poked) this.pokedUntil = nowMs + POKE_WIDE_MS;
    const surprised = nowMs < this.pokedUntil;

    const shape = this.shapeFor(input, surprised);

    // 睡眠时眼睛本就闭着，不需要眨眼调度
    const lid = shape === "closed" ? 1 : this.updateBlink(nowMs, input);

    const { x, y } = this.updateGaze(nowMs, input, surprised);

    return { shape, lid, gazeX: x, gazeY: y };
  }

  private shapeFor(input: ExprInput, surprised: boolean): EyeShape {
    if (input.asleep) return "closed";
    if (surprised) return "wide";
    if (input.tired) return "half";
    // 心情的优先级高于专注 —— 情绪是更强的人格外显
    if (input.mood === "content") return "happy";
    if (input.mood === "frustrated") return "worried";
    if (input.mood === "bored") return "droopy";
    if (input.flow) return "squint";
    return "round";
  }

  private blinkStyle(input: ExprInput): BlinkStyle {
    if (input.tired) return BLINK.tired;
    if (input.mood === "frustrated") return BLINK.frustrated;
    if (input.mood === "bored") return BLINK.bored;
    if (input.flow) return BLINK.flow;
    if (input.stuck) return BLINK.stuck;
    return BLINK.normal;
  }

  private updateBlink(nowMs: number, input: ExprInput): number {
    const style = this.blinkStyle(input);

    // 首次调度：随机错开，避免宠物启动瞬间就眨一下
    if (!this.blinkScheduled) {
      this.blinkScheduled = true;
      this.nextBlinkAt = nowMs + this.pick(style.minGap, style.maxGap);
      return 0;
    }

    if (this.blinkStartedAt === null) {
      if (nowMs < this.nextBlinkAt) return 0;
      // 基准取预定时刻而非当前帧时刻。取当前帧会让每次眨眼都把节奏
      // 往后拖 —— 待机态仅 12fps，累积漂移相当可观。
      this.blinkStartedAt = this.nextBlinkAt;
      this.blinkDuration = style.duration;
    }

    const t = (nowMs - this.blinkStartedAt) / this.blinkDuration;
    if (t >= 1) {
      this.blinkStartedAt = null;
      this.nextBlinkAt = nowMs + this.pick(style.minGap, style.maxGap);
      return 0;
    }

    // 非对称三角波：先快速闭合，再稍慢张开
    return t < CLOSE_RATIO
      ? t / CLOSE_RATIO
      : 1 - (t - CLOSE_RATIO) / (1 - CLOSE_RATIO);
  }

  private saccadeStyle(input: ExprInput): SaccadeStyle {
    if (input.flow) return SACCADE.flow;
    if (input.stuck) return SACCADE.stuck;
    return SACCADE.normal;
  }

  private updateGaze(
    nowMs: number,
    input: ExprInput,
    surprised: boolean,
  ): { x: number; y: number } {
    let targetX: number;
    let targetY: number;

    if (input.gazeTarget) {
      // 视线跟随优先于随机扫视 —— 被注视时的对视感是交互的核心
      targetX = clamp(input.gazeTarget.x, -1, 1);
      targetY = clamp(input.gazeTarget.y, -1, 1);
    } else {
      const style = this.saccadeStyle(input);
      if (nowMs >= this.nextSaccadeAt) {
        this.nextSaccadeAt = nowMs + this.pick(style.minGap, style.maxGap);
        this.saccadeX = (this.rng() * 2 - 1) * style.amplitude;
        this.saccadeY = (this.rng() * 2 - 1) * style.amplitude;
        // 思考时视线偏向上方 —— 人回忆/推理时的典型眼动
        if (input.stuck) this.saccadeY = -Math.abs(this.saccadeY);
      }
      targetX = this.saccadeX;
      targetY = this.saccadeY;
    }

    // 惊讶时瞳孔定住，不再游走
    if (surprised) {
      targetX = 0;
      targetY = 0;
    }

    // 指数平滑，避免眼球瞬移
    const k = surprised ? 0.5 : 0.18;
    this.smoothX += (targetX - this.smoothX) * k;
    this.smoothY += (targetY - this.smoothY) * k;
    return { x: this.smoothX, y: this.smoothY };
  }

  private pick(min: number, max: number): number {
    return min + this.rng() * (max - min);
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
