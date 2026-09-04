import { breatheScale } from "../anim/breathe";
import { MicroExpression, type EyeFrame } from "../anim/expression";
import { squashScale } from "../anim/squash";
import { drawBody } from "../render/body";
import { drawBrows } from "../render/brows";
import { drawEyes, EYE_COLOR } from "../render/eyes";
import { drawAttachments, splitBodyBox } from "../render/attachments";
import { drawSpots } from "../render/patterns";
import { generateCandidates } from "../avatar/generator";
import type { PetAvatar } from "../avatar/types";
import type { Box } from "../interact/hit-test";
import { panelChrome } from "./chrome";

/** 预览画布的 CSS 像素边长。 */
const PREVIEW_SIDE = 96;
/** 预览里宠物的基准边长（四周留余量给 hop 抬升与形变）。 */
const PET_SIDE = 72;
/** 预览呼吸周期：与主渲染常态一致。 */
const BREATHE_PERIOD_MS = 2400;

export interface PreviewPose {
  motion: "idle" | "hop" | "stretch" | "lookaround";
  /** 动作进度 0..1。 */
  phase: number;
  facing: -1 | 1;
  /** hop 抬升比例 0..1（正弦弧线）。 */
  lift: number;
}

const ACT_DURATION_MS = { hop: 500, stretch: 1100, lookaround: 1600 } as const;
const PREVIEW_ACTS = ["hop", "stretch", "lookaround"] as const;

/**
 * 预览动作驱动：idle 一段时间 → 随机小动作 → 回 idle，如此循环。
 *
 * 与 Behavior 不同：不移动位置（预览框只有 96px，走动会出框），只演示
 * 原地小动作。纯时间 + 注入 RNG 驱动，可复现、可单测。
 */
export class PreviewDriver {
  private pose: PreviewPose = { motion: "idle", phase: 0, facing: 1, lift: 0 };
  private nextAt: number;
  private actStart = 0;
  private actDur = 0;

  constructor(
    private readonly rng: () => number,
    startMs: number,
  ) {
    // 开场稍等片刻再动，让「呼吸+眨眼」先被看见
    this.nextAt = startMs + 800 + rng() * 1600;
  }

  update(nowMs: number): PreviewPose {
    if (this.pose.motion === "idle") {
      if (nowMs >= this.nextAt) {
        const act =
          PREVIEW_ACTS[Math.floor(this.rng() * PREVIEW_ACTS.length)];
        this.pose.motion = act;
        this.actStart = nowMs;
        this.actDur = ACT_DURATION_MS[act];
      }
      return this.pose;
    }

    const t = (nowMs - this.actStart) / this.actDur;
    if (t >= 1) {
      this.pose = { motion: "idle", phase: 0, facing: this.pose.facing, lift: 0 };
      this.nextAt = nowMs + 1400 + this.rng() * 2400;
      return this.pose;
    }

    this.pose.phase = t;
    if (this.pose.motion === "hop") {
      this.pose.lift = Math.sin(t * Math.PI);
    } else if (this.pose.motion === "lookaround") {
      this.pose.facing = t < 0.5 ? -1 : 1;
    }
    return this.pose;
  }
}

export interface AvatarPickerOptions {
  /** 确认领养。调用方负责持久化与 pet.setAvatar。 */
  onConfirm: (a: PetAvatar) => void;
  /** 从图片生成候选；未提供时隐藏该入口。 */
  analyzeImage?: (file: File) => Promise<PetAvatar[]>;
}

/**
 * 画一帧静态形象（设置面板的当前形象回显用）。
 *
 * 与弹窗预览共享同一套渲染函数，只是不跑动画循环：idle 姿态、
 * 常态圆眼、无呼吸形变 —— 所见即所得的「证件照」。
 */
export function drawAvatarStill(
  canvas: HTMLCanvasElement,
  avatar: PetAvatar,
): void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  const size = canvas.width;
  const side = Math.round(size * 0.72);
  const x = Math.round((size - side) / 2);
  const y = Math.round(size - Math.max(2, size * 0.08) - side);
  const frame: EyeFrame = { shape: "round", lid: 0, gazeX: 0, gazeY: 0 };

  ctx.clearRect(0, 0, size, size);
  drawAvatarFigure(ctx, { bodyX: x, bodyY: y, w: side, h: side }, avatar, frame);
}

/**
 * 形象完整绘制（身体+纹理+特征件+眼睛+眉毛）。
 *
 * 弹窗预览与静态帧共用，与 pet.ts draw() 的合成顺序保持一致 ——
 * 三处渲染同一套代码，「选中所见 = 桌面所得」。
 */
export function drawAvatarFigure(
  ctx: CanvasRenderingContext2D,
  full: { bodyX: number; bodyY: number; w: number; h: number },
  avatar: PetAvatar,
  frame: EyeFrame,
): void {
  const { body } = splitBodyBox(full, avatar.attachment);
  drawBody(
    ctx,
    avatar.shape,
    body.x,
    body.y,
    body.w,
    body.h,
    avatar.bodyColor,
    avatar.pattern === "stripes" && avatar.secondaryColor
      ? avatar.secondaryColor
      : undefined,
  );
  if (avatar.pattern === "spots" && avatar.secondaryColor) {
    drawSpots(ctx, avatar.shape, body, avatar.secondaryColor);
  }
  drawAttachments(ctx, full, avatar.attachment, avatar.accentColor);

  const layout = { bodyX: body.x, bodyY: body.y, w: body.w, h: body.h };
  drawEyes(
    ctx,
    layout,
    frame,
    { iris: EYE_COLOR, catchlight: avatar.accentColor, eyebag: null },
    avatar.eyeStyle,
  );
  drawBrows(
    ctx,
    layout,
    avatar.browStyle,
    frame,
    avatar.accentColor,
    avatar.eyeStyle,
  );
}

interface PreviewSlot {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  driver: PreviewDriver;
  expr: MicroExpression;
  /** 相位偏移，让三只预览的呼吸/动作不同步（同步会像复制的机器人）。 */
  phaseOffset: number;
}

/**
 * 形象选择弹窗。
 *
 * 首次安装（配置无 avatar）时自动弹出：3 只候选实时播放呼吸/眨眼/小动作，
 * 所见即所得；可「换一换」重新生成，也可从图片生成。Esc 或点外关闭视为
 * 跳过，下次启动再弹 —— 不强行打断用户，但必须给足第一印象的仪式感。
 *
 * 视觉沿用设置面板的暗色青边体系；预览渲染与 pet.ts 共享
 * drawBody/drawEyes/drawBrows/squashScale，保证「选中所见 = 桌面所得」。
 */
export class AvatarPicker {
  private readonly el: HTMLDivElement;
  private open = false;
  private candidates: PetAvatar[] = [];
  private selected = -1;
  private previews: PreviewSlot[] = [];
  private confirmBtn: HTMLButtonElement | null = null;
  private rafId = 0;
  private readonly startMs = performance.now();

  constructor(private readonly opts: AvatarPickerOptions) {
    this.el = document.createElement("div");
    this.el.className = "pet-avatar-picker";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.open;
  }

  get box(): Box | null {
    if (!this.open) return null;
    const r = this.el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  contains(x: number, y: number): boolean {
    const b = this.box;
    return !!b && x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h;
  }

  /** 打开并生成一批候选。initial 非空时直接展示（设置面板换形象场景）。 */
  show(initial?: PetAvatar[]): void {
    this.el.style.display = "block";
    this.open = true;
    this.regenerate(initial ?? generateCandidates(Math.random));
  }

  hide(): void {
    this.el.style.display = "none";
    this.open = false;
    this.stopLoop();
  }

  /** 换一批候选：清空选中，避免用户误确认上一批。 */
  private regenerate(list: PetAvatar[]): void {
    this.candidates = list;
    this.selected = -1;
    this.render();
    this.startLoop();
  }

  private render(): void {
    this.stopLoop();
    this.previews = [];
    this.el.replaceChildren();

    // —— 标题栏（panelChrome 统一构建：拖拽 + ×）——
    const head = panelChrome(this.el, "领养你的像素崽", () => this.hide(), {
      headClass: "pet-avatar-picker-head",
      closeTitle: "稍后再选（下次启动还会问我）",
    });
    this.el.appendChild(head);

    // —— 3 个预览 ——
    const row = document.createElement("div");
    row.className = "pet-avatar-picker-row";
    this.candidates.forEach((_, i) => {
      const option = document.createElement("div");
      option.className = "pet-avatar-option";
      option.dataset.index = String(i);

      const canvas = document.createElement("canvas");
      canvas.width = PREVIEW_SIDE;
      canvas.height = PREVIEW_SIDE;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.imageSmoothingEnabled = false;
      option.appendChild(canvas);

      const check = document.createElement("span");
      check.className = "pet-avatar-check";
      check.textContent = "✓";
      option.appendChild(check);

      option.addEventListener("click", () => this.select(i));
      row.appendChild(option);

      this.previews.push({
        canvas,
        ctx,
        driver: new PreviewDriver(Math.random, this.startMs),
        expr: new MicroExpression(),
        phaseOffset: i * 470,
      });
    });
    this.el.appendChild(row);

    // —— 操作行 ——
    const actions = document.createElement("div");
    actions.className = "pet-avatar-picker-actions";

    const reroll = document.createElement("button");
    reroll.className = "pet-avatar-btn";
    reroll.textContent = "换一换";
    reroll.addEventListener("click", () =>
      this.regenerate(generateCandidates(Math.random)),
    );
    actions.appendChild(reroll);

    if (this.opts.analyzeImage) {
      const fromImage = document.createElement("button");
      fromImage.className = "pet-avatar-btn";
      fromImage.textContent = "从图片生成";
      const fileInput = document.createElement("input");
      fileInput.type = "file";
      fileInput.accept = "image/*";
      fileInput.style.display = "none";
      fromImage.addEventListener("click", () => fileInput.click());
      fileInput.addEventListener("change", () => {
        const file = fileInput.files?.[0];
        fileInput.value = "";
        if (!file || !this.opts.analyzeImage) return;
        void this.opts
          .analyzeImage(file)
          .then((list) => {
            if (list.length > 0) this.regenerate(list);
          })
          .catch((e) => console.warn("[avatar] 图片分析失败", e));
      });
      actions.append(fromImage, fileInput);
    }
    this.el.appendChild(actions);

    // —— 确认区 ——
    const foot = document.createElement("div");
    foot.className = "pet-avatar-picker-foot";
    const confirm = document.createElement("button");
    confirm.className = "pet-avatar-confirm";
    confirm.textContent = "就是它了";
    confirm.disabled = true;
    confirm.addEventListener("click", () => {
      if (this.selected < 0) return;
      this.opts.onConfirm(this.candidates[this.selected]);
      this.hide();
    });
    this.confirmBtn = confirm;
    const hint = document.createElement("div");
    hint.className = "pet-avatar-picker-hint";
    hint.textContent = "之后可在设置里随时换";
    foot.append(confirm, hint);
    this.el.appendChild(foot);
  }

  private select(i: number): void {
    this.selected = i;
    this.el
      .querySelectorAll(".pet-avatar-option")
      .forEach((el, j) => el.classList.toggle("selected", j === i));
    if (this.confirmBtn) this.confirmBtn.disabled = false;
  }

  private startLoop(): void {
    this.stopLoop();
    const tick = (now: number): void => {
      if (!this.open) return;
      for (let i = 0; i < this.previews.length; i++) {
        this.drawPreview(this.previews[i], this.candidates[i], now);
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.rafId = 0;
  }

  private drawPreview(slot: PreviewSlot, avatar: PetAvatar, now: number): void {
    const { ctx } = slot;
    const pose = slot.driver.update(now);

    const eye: EyeFrame = slot.expr.update(now + slot.phaseOffset, {
      asleep: false,
      stuck: false,
      flow: false,
      tired: false,
      poked: false,
      mood: null,
      gazeTarget:
        pose.motion === "lookaround" ? { x: pose.facing * 0.85, y: 0 } : null,
    });

    // 与 pet.ts draw() 同一套合成：呼吸缩放 → squash 形变 → 底部对齐
    const scale = breatheScale(
      now - this.startMs + slot.phaseOffset,
      BREATHE_PERIOD_MS,
      0.02,
    );
    const side = Math.round(PET_SIDE * scale);
    const { sx, sy } = squashScale(pose.motion, pose.phase);
    const w = Math.max(4, Math.round(side * sx));
    const h = Math.max(4, Math.round(side * sy));
    const x = Math.round((PREVIEW_SIDE - w) / 2);
    const y = Math.round(
      PREVIEW_SIDE - 6 - h - pose.lift * PET_SIDE * 0.45,
    );

    ctx.clearRect(0, 0, PREVIEW_SIDE, PREVIEW_SIDE);
    drawAvatarFigure(ctx, { bodyX: x, bodyY: y, w, h }, avatar, eye);
  }
}
