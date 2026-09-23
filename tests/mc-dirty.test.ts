// tests/mc-dirty.test.ts
import { describe, expect, it } from "vitest";
import { Pet } from "../src/pet";

interface Cleared {
  x: number;
  y: number;
  w: number;
  h: number;
}

const CANVAS_W = 1440;
const CANVAS_H = 900;
const FULL_SCREEN_AREA = CANVAS_W * CANVAS_H;

/** 无特效下 mcDirtyBounds(248, 296, 2) 的精确形状（推导见用例 A 注释）。 */
const MC_DIRTY_M2 = { x: 215, y: 195, w: 66, h: 104 };

/** 整屏清除之外的清除记录（首帧/特效切换帧允许整屏，不参与形状断言）。 */
function partial(cleared: Cleared[]): Cleared[] {
  return cleared.filter((c) => c.w * c.h < FULL_SCREEN_AREA);
}

/**
 * Pet 级脏矩形形状选择（mcDirtyBounds vs glowBounds 的分流决策）。
 *
 * mcDirtyBounds 的几何已有单元测试（tests/mc-figure.test.ts），这里护的
 * 是 pet.draw 的选形：无特效走窄的 MC 身位盒，有特效并到宽的 glowBounds
 * ——选窄了特效会留残影，选宽了每帧多擦一个数量级的像素。
 *
 * node 环境皮肤注册表为空 → getMcSkinResources 返回 null → drawMcFigure
 * 不执行，但脏矩形判定照走，正好隔离出「只测选形」的路径。
 * ctx mock 沿用 tests/draw-budget.test.ts 的写法。
 */
function makePet() {
  const cleared: Cleared[] = [];
  let recording = false;
  const ctx = {
    globalAlpha: 1,
    shadowBlur: 0,
    shadowColor: "",
    fillStyle: "",
    clearRect: (x: number, y: number, w: number, h: number) => {
      if (recording) cleared.push({ x, y, w, h });
    },
    fillRect: () => {},
  } as unknown as CanvasRenderingContext2D;
  // 1440×900 且不调 resize：初始 x=200,y=200；sizeIndex 默认 1 →
  // side=96 → m=2（active 档 33ms 预算，40ms 步进每 tick 都到帧）
  const canvas = { width: CANVAS_W, height: CANVAS_H } as HTMLCanvasElement;
  const pet = new Pet(canvas, ctx);
  pet.setAvatar({ kind: "minecraft", form: "player", skinId: "t" });
  pet.setActivity("active");
  return {
    pet,
    cleared,
    startRecording: () => {
      recording = true;
    },
  };
}

/** 驱动 40ms 步进的 tick，直到收够 count 个非整屏清除（10 秒兜底）。 */
function drive(pet: Pet, cleared: Cleared[], count: number): void {
  for (let t = 40; t <= 10000 && partial(cleared).length < count; t += 40) {
    pet.tick(1000 + t);
  }
}

describe("MC 形态 Pet 级脏矩形选形", () => {
  it("无特效：非整屏清除呈 mcDirtyBounds 形状（m=2 时 66×104）", () => {
    const { pet, cleared, startRecording } = makePet();
    pet.tick(1000); // 首帧整屏清（画布状态未知）
    startRecording();
    drive(pet, cleared, 5);

    // 重绘一定发生：呼吸取整（2400ms 周期 × 0.02 幅度 → 96px 档 1 秒多
    // 就跨取整桶）与随机扫视都会变指纹。首个自发动作最早 1.2s 后，之前
    // x/y 恒为 200/200，此时 ox=round(200+96/2)=248、oy=round(200+96)=296，
    // 脏矩形 = mcDirtyBounds(248,296,2) = x:248−16·2−1=215, y:296−50·2−1=195,
    // w:32·2+2=66, h:51·2+2=104
    expect(partial(cleared)).toContainEqual(MC_DIRTY_M2);
  });

  it("有特效：非整屏清除并到 glowBounds（显著宽于身位盒，不再 66×104）", () => {
    const { pet, cleared, startRecording } = makePet();
    pet.tick(1000);
    pet.setEffects(["halo"]); // 首帧从空集设入，必生效；置 dirty=null
    startRecording();
    drive(pet, cleared, 5);

    const frames = partial(cleared);
    expect(frames.length).toBeGreaterThan(0);
    // glowBounds 在特效下 pad ≥ base·0.65 ≈ 62 → 宽 ≈ 96 + 2·62 = 220；
    // 特效激活期间不做跳帧，每个预算帧都画，不会混回身位盒形状
    for (const c of frames) {
      expect(c.w).toBeGreaterThanOrEqual(150);
      expect(c).not.toEqual(MC_DIRTY_M2);
    }
  });
});
