// tests/mc-dirty.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { Pet } from "../src/pet";
import { mcDirtyBounds } from "../src/mc/figure";
import { mcRestPose } from "../src/mc/pose";

interface Cleared {
  x: number;
  y: number;
  w: number;
  h: number;
}

const CANVAS_W = 1440;
const CANVAS_H = 900;
const FULL_SCREEN_AREA = CANVAS_W * CANVAS_H;

/**
 * 呼吸三档的身位盒（m=2、ox=248、oy=296）：头 dy ±2 → 顶 ±6px，
 * 脚不动（底恒 298）。推导见 tests/mc-figure.test.ts 的精确值用例。
 */
const BREATH_SHAPES = [
  { x: 219, y: 189, w: 58, h: 110 }, // breath=+1（吸气抬头）
  { x: 219, y: 195, w: 58, h: 104 }, // breath=0
  { x: 219, y: 201, w: 58, h: 98 },  // breath=−1（呼气沉头）
];

/** 整屏清除之外的清除记录（首帧/特效切换帧允许整屏，不参与形状断言）。 */
function partial(cleared: Cleared[]): Cleared[] {
  return cleared.filter((c) => c.w * c.h < FULL_SCREEN_AREA);
}

/**
 * Pet 级脏矩形形状选择（mcDirtyBounds vs glowBounds 的分流决策）。
 *
 * node 环境皮肤注册表为空 → getMcSkinResources 返回 null → drawMcFigure
 * 不执行，但脏矩形判定照走，正好隔离出「只测选形」。
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
  // side=96 → m=2 → ox=248、oy=296
  const canvas = { width: CANVAS_W, height: CANVAS_H } as HTMLCanvasElement;
  const pet = new Pet(canvas, ctx);
  pet.setAvatar({ kind: "minecraft", form: "player", skinId: "t" });
  pet.setActivity("active");
  return { pet, cleared, startRecording: () => { recording = true; } };
}

/** 猫版：同参数（m=2、ox=248、oy=296），返回静止档身位盒黄金值。 */
function makeCatPet() {
  const made = makePet();
  made.pet.setAvatar({ kind: "minecraft", form: "cat", skinId: "t" });
  return made;
}

/** 猫静止（breath=0、尾 phase 0）在 m=2/ox=248/oy=296 的身位盒：
 * minX 218（右后腿 left 面角点）、maxX 284（头正面）、minY 238（耳顶）、
 * maxY 302（前腿底）；留 1px 余量 → x 217 / y 237 / w 68 / h 66。
 * 若尾摆未冻结，tailPhase 走到 5（dx −2）时会在 nowMs 3000 落定 x=215 的盒子，
 * 3600 相位 6 换帧使该盒被清除进记录——检测由此成立。 */
const CAT_STILL_SHAPE = { x: 217, y: 237, w: 68, h: 66 };

describe("MC 形态 Pet 级脏矩形选形", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("无特效：量化跳帧生效，重绘形状恒为呼吸三档身位盒", () => {
    // 锁随机（必须在 new Pet 之前——引擎构造时捕获 Math.random 引用）：
    // 首个自发动作推迟到 4s 行为时钟之后，窗口内不会有动作；
    // 扫视/眨眼即使发生也只动眼不动身位盒。
    vi.spyOn(Math, "random").mockReturnValue(1);
    const { pet, cleared, startRecording } = makePet();
    pet.tick(1000); // 首帧整屏清；mcFrameKey 在此落定
    startRecording();
    // 固定窗口 T=1040..3160：呼吸档走过 +1 → 0 → −1 → 0（2400ms 周期），
    // 每次换档恰一次重绘——量化跳帧的实证
    for (let t = 40; t <= 2160; t += 40) pet.tick(1000 + t);

    const frames = partial(cleared);
    expect(frames.length).toBeGreaterThanOrEqual(3);
    expect(frames.length).toBeLessThanOrEqual(24); // 53 个 tick，绝不该帧帧重绘
    for (const c of frames) {
      expect(BREATH_SHAPES).toContainEqual(c);
    }
    const shapes = new Set(frames.map((c) => `${c.x},${c.y}`));
    expect(shapes).toEqual(new Set(BREATH_SHAPES.map((c) => `${c.x},${c.y}`)));
  });

  it("still 挂件档：呼吸冻结，重绘（若有）恒为 breath=0 身位盒", () => {
    // 锁随机（必须在 new Pet 之前）：与首个用例同口径，窗口内无自发动作
    vi.spyOn(Math, "random").mockReturnValue(1);
    const { pet, cleared, startRecording } = makePet();
    pet.setScope("still");
    pet.tick(1000); // 首帧整屏清
    startRecording();
    // 穿过完整 2400ms 呼吸周期：still 档下呼吸档必须恒 0——
    // 若仍随周期起伏，这里会出现 y=189 / y=201 的 ±2 档身位盒
    for (let t = 40; t <= 2400; t += 40) pet.tick(1000 + t);

    const frames = partial(cleared);
    expect(frames.length).toBeLessThanOrEqual(24); // 60 个 tick，绝不该帧帧重绘
    for (const c of frames) {
      expect(c).toEqual({ x: 219, y: 195, w: 58, h: 104 });
    }
    expect(frames.some((c) => c.y === 189 || c.y === 201)).toBe(false);
  });

  it("face(±1)：镜像进帧指纹，确定性触发重绘且形状不变", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const { pet, cleared, startRecording } = makePet();
    pet.tick(1000);
    startRecording();
    pet.face(-1);
    pet.tick(1040); // breath=+1 段
    pet.face(1);
    pet.tick(1080); // breath=0 段
    const frames = partial(cleared);
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(frames.length).toBeLessThanOrEqual(4);
    for (const c of frames) {
      expect(BREATH_SHAPES).toContainEqual(c);
    }
  });

  it("有特效：非整屏清除并到 glowBounds（显著宽于身位盒）", () => {
    // 特效路径逐帧动画、不依赖随机，不锁 RNG
    const { pet, cleared, startRecording } = makePet();
    pet.tick(1000);
    pet.setEffects(["halo"]); // 首帧从空集设入，必生效
    startRecording();
    for (let t = 40; t <= 2000 && partial(cleared).length < 5; t += 40) {
      pet.tick(1000 + t);
    }
    const frames = partial(cleared);
    expect(frames.length).toBeGreaterThan(0);
    // glowBounds 在特效下 pad ≥ base·0.65 ≈ 62 → 宽 ≈ 96 + 2·62 = 220
    for (const c of frames) {
      expect(c.w).toBeGreaterThanOrEqual(150);
      for (const s of BREATH_SHAPES) {
        expect(c).not.toEqual(s);
      }
    }
  });

  it("still 挂件档（猫）：尾摆冻结，重绘形状恒为静止身位盒", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const { pet, cleared, startRecording } = makeCatPet();
    pet.setScope("still");
    pet.tick(1000); // 首帧整屏清
    startRecording();
    // 穿过 3600ms（nowMs 1000+2600）：若尾摆未冻结，tailPhase 会经历 1→6，
    // phase 5（dx −2）在 nowMs 3000 把身位盒推到 x=215 并落进 this.dirty，
    // phase 6 在 3600 触发帧指纹变化使该盒被清除——断言由此抓住未冻结的尾摆
    for (let t = 40; t <= 2600; t += 40) pet.tick(1000 + t);

    const frames = partial(cleared);
    expect(frames.length).toBeGreaterThan(0); // 防记录中断导致静默通过
    expect(frames.length).toBeLessThanOrEqual(24);
    for (const c of frames) {
      expect(c).toEqual(CAT_STILL_SHAPE);
    }
  });
});

describe("mcDirtyBounds 按 form", () => {
  it("猫：尾摆 phase 5 扩脏矩形（裸角点 minX 85→84，外接盒留 1px 余量 → 84/83）", () => {
    const b0 = mcDirtyBounds(100, 200, 1, mcRestPose(), "cat");
    const b5 = mcDirtyBounds(100, 200, 1, { ...mcRestPose(), tailPhase: 5 }, "cat");
    expect(b0.x).toBe(84);
    expect(b5.x).toBe(83);
    expect(b5.w).toBe(b0.w + 1);
  });

  it("猫/狗外接盒矮于玩家（体型差异回归锚，规格 §3.1）", () => {
    const cat = mcDirtyBounds(100, 200, 1, mcRestPose(), "cat");
    const dog = mcDirtyBounds(100, 200, 1, mcRestPose(), "dog");
    const player = mcDirtyBounds(100, 200, 1, mcRestPose(), "player");
    expect(cat.h).toBeLessThan(player.h);
    expect(dog.h).toBeLessThan(player.h);
  });
});
