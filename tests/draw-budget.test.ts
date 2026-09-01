import { describe, expect, it } from "vitest";
import { Pet, SIZE_STEPS, frameVisualKey } from "../src/pet";

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

  // 首帧允许整屏清除（画布状态未知），从第二帧起进入稳定态。
  // 无变化跳帧：画面静止的 tick 不会触发 clearRect，因此驱动到
  // 收满 5 个真实绘制帧为止（呼吸/眨眼/扫视保证一定会发生）。
  pet.tick(1000);
  recording = true;
  for (let t = 40; t <= 10000 && cleared.length < 5; t += 40) {
    pet.tick(1000 + t);
  }

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

/** 睡眠状态（人已离开）：眼型 closed、不眨眼，是最「静止」的状态。 */
const AWAY_STATE = {
  doing: "away" as const,
  tempo: "resting" as const,
  late_night: false,
  keystrokes_per_min: 0,
  mood: "focused" as const,
  activity: "working" as const,
  dnd_on: false,
};

describe("无变化跳帧", () => {
  /**
   * 视觉指纹：量化参数相同 ⇒ 逐像素相同 ⇒ 可整帧跳过。
   * 这是空闲 CPU 的关键路径 —— 不触碰 canvas 就不触发 WebKit 层合成。
   */
  it("frameVisualKey：相同参数同指纹，亚像素级微变不触发", () => {
    const base = {
      px: 100,
      py: 200,
      w: 96,
      h: 96,
      bob: 0,
      shape: "round",
      lid: 0,
      gazeX: 0.3,
      gazeY: -0.2,
      glow: false,
      tired: false,
    };
    expect(frameVisualKey(base)).toBe(frameVisualKey({ ...base }));
    // 亚像素级变化（跨不过量化档位）不改变指纹
    expect(frameVisualKey({ ...base, gazeX: 0.301 })).toBe(
      frameVisualKey(base),
    );
    // 跨过量化档位则指纹变化
    expect(frameVisualKey({ ...base, gazeX: 0.4 })).not.toBe(
      frameVisualKey(base),
    );
    expect(frameVisualKey({ ...base, lid: 0.1 })).not.toBe(
      frameVisualKey(base),
    );
    expect(frameVisualKey({ ...base, px: 101 })).not.toBe(frameVisualKey(base));
    expect(frameVisualKey({ ...base, glow: true })).not.toBe(
      frameVisualKey(base),
    );
    expect(frameVisualKey({ ...base, shape: "closed" })).not.toBe(
      frameVisualKey(base),
    );
    expect(frameVisualKey({ ...base, tired: true })).not.toBe(
      frameVisualKey(base),
    );
  });

  it("完全静止的画面大部分帧被跳过（不触碰 canvas）", () => {
    // 睡眠态：眼型恒为 closed、不眨眼；scope=still：呼吸幅度为 0。
    // 期间唯一的像素变化源是随机扫视 —— 大部分预算帧应被跳过。
    let draws = 0;
    const ctx = {
      globalAlpha: 1,
      shadowBlur: 0,
      shadowColor: "",
      fillStyle: "",
      clearRect: () => {
        draws++;
      },
      fillRect: () => {},
    } as unknown as CanvasRenderingContext2D;
    const canvas = { width: CANVAS_W, height: CANVAS_H } as HTMLCanvasElement;
    const pet = new Pet(canvas, ctx);
    pet.applyState(AWAY_STATE);
    pet.setScope("still");

    // 安定：进入睡眠、视线平滑收敛
    let t = 0;
    for (let i = 0; i < 900; i++) {
      t += 16;
      pet.tick(t);
    }

    // 提到 active 预算（33ms），模拟 60Hz rAF 跑 4 秒。
    // 无跳帧时应绘制约 120 帧；有跳帧时只剩扫视引发的少数几帧。
    draws = 0;
    for (let i = 0; i < 240; i++) {
      t += 1000 / 60;
      pet.tick(t);
    }
    // 4 秒内平均扫视间隔 1.6s → 至多 5 次扫视，每次平滑收敛只影响
    // 少数几帧。给足余量：远小于 120（无跳帧基线）即视为跳帧生效。
    expect(draws).toBeLessThan(60);
  });
});
