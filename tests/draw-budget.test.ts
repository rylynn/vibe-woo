import { describe, expect, it } from "vitest";
import { Pet, SIZE_STEPS } from "../src/pet";

interface Cleared {
  w: number;
  h: number;
}

interface Probe {
  fills: number;
  cleared: Cleared[];
}

const CANVAS_W = 1440;
const CANVAS_H = 900;
const FULL_SCREEN_AREA = CANVAS_W * CANVAS_H;

/** 跑若干帧，返回稳定态（跳过首帧）的绘制统计。 */
function probeSteadyState(sizeIndex: number): Probe {
  let fills = 0;
  const cleared: Cleared[] = [];
  let recording = false;

  const ctx = {
    globalAlpha: 1,
    shadowBlur: 0,
    shadowColor: "",
    fillStyle: "",
    clearRect: (_x: number, _y: number, w: number, h: number) => {
      if (recording) cleared.push({ w, h });
    },
    fillRect: () => {
      if (recording) fills++;
    },
  } as unknown as CanvasRenderingContext2D;

  const canvas = { width: CANVAS_W, height: CANVAS_H } as HTMLCanvasElement;
  const pet = new Pet(canvas, ctx);
  for (let i = 0; i < sizeIndex; i++) pet.cycleSize();
  pet.setActivity("active");

  // 首帧允许整屏清除（画布状态未知），从第二帧起进入稳定态
  pet.tick(1000);
  recording = true;
  for (let t = 40; t <= 400; t += 40) pet.tick(1000 + t);

  return { fills, cleared };
}

/**
 * 渲染开销预算。
 *
 * 背景：实测待机时 WebContent 进程占 5.3% CPU，远超设计文档 5.2 节的
 * 「空闲 < 1%」硬指标。诊断结论出人意料 —— 主因不是 fillRect 数量
 * （仅 93 次/帧），而是每帧 clearRect 整个 1440×900 画布，让 GPU 反复
 * 合成 130 万像素的透明层，而宠物实际只占 96×96。
 *
 * 因此这里护住两件事：稳定态绝不整屏清除，且单帧绘制次数有上限。
 */
describe("渲染开销预算", () => {
  it("稳定态只清除宠物周边，绝不整屏清除", () => {
    const { cleared } = probeSteadyState(0);
    expect(cleared.length).toBeGreaterThan(0);
    for (const c of cleared) {
      expect(c.w * c.h).toBeLessThan(FULL_SCREEN_AREA / 20);
    }
  });

  it("最大尺寸档位下稳定态也不整屏清除", () => {
    const { cleared } = probeSteadyState(SIZE_STEPS.length - 1);
    for (const c of cleared) {
      expect(c.w * c.h).toBeLessThan(FULL_SCREEN_AREA / 5);
    }
  });

  it("首帧允许整屏清除（画布初始状态未知）", () => {
    const cleared: Cleared[] = [];
    const ctx = {
      globalAlpha: 1,
      shadowBlur: 0,
      shadowColor: "",
      fillStyle: "",
      clearRect: (_x: number, _y: number, w: number, h: number) => {
        cleared.push({ w, h });
      },
      fillRect: () => {},
    } as unknown as CanvasRenderingContext2D;
    const canvas = { width: CANVAS_W, height: CANVAS_H } as HTMLCanvasElement;
    const pet = new Pet(canvas, ctx);
    pet.tick(1000);
    expect(cleared[0]).toEqual({ w: CANVAS_W, h: CANVAS_H });
  });

  it("resize 后重新整屏清除一次（画布已被浏览器清空）", () => {
    const cleared: Cleared[] = [];
    let recording = false;
    const ctx = {
      globalAlpha: 1,
      shadowBlur: 0,
      shadowColor: "",
      fillStyle: "",
      clearRect: (_x: number, _y: number, w: number, h: number) => {
        if (recording) cleared.push({ w, h });
      },
      fillRect: () => {},
    } as unknown as CanvasRenderingContext2D;
    const canvas = { width: CANVAS_W, height: CANVAS_H } as HTMLCanvasElement;
    const pet = new Pet(canvas, ctx);
    pet.setActivity("active");
    pet.tick(1000);
    pet.tick(1040);

    recording = true;
    pet.resize(800, 600);
    pet.tick(1100);
    expect(cleared[0]).toEqual({ w: 800, h: 600 });
  });

  it("单帧 fillRect 次数有上限", () => {
    const worst = Math.max(
      ...SIZE_STEPS.map((_, i) => {
        const { fills, cleared } = probeSteadyState(i);
        // cleared 长度即录制帧数，用它换算单帧均值
        return Math.ceil(fills / Math.max(1, cleared.length));
      }),
    );
    expect(worst).toBeLessThanOrEqual(120);
  });
});
