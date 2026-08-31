import { describe, expect, it } from "vitest";
import { Pet, SIZE_STEPS } from "../src/pet";
import { applyTint } from "../src/avatar/palette";
import { DEFAULT_AVATAR, type PetAvatar } from "../src/avatar/types";

interface RecordedFill {
  globalAlpha: number;
  shadowBlur: number;
  x: number;
  y: number;
  w: number;
  h: number;
  style: string;
}

interface StubCtx {
  ctx: CanvasRenderingContext2D;
  fills: RecordedFill[];
}

/**
 * Pet 依赖 canvas，但这里只验证几何/状态/alpha 约束，不验证像素输出，
 * 所以用能记录绘制参数的替身即可 —— 不为了测试而引入 jsdom。
 *
 * 关键：替身必须记录每次 fillRect 当时的 globalAlpha 与 shadowBlur，
 * 否则「辉光不得半透明」这条硬约束无法被测试守护。
 */
function makeStubCtx(): StubCtx {
  const fills: RecordedFill[] = [];
  const state = { globalAlpha: 1, shadowBlur: 0, shadowColor: "", fillStyle: "" };
  const ctx = {
    get globalAlpha() {
      return state.globalAlpha;
    },
    set globalAlpha(v: number) {
      state.globalAlpha = v;
    },
    get shadowBlur() {
      return state.shadowBlur;
    },
    set shadowBlur(v: number) {
      state.shadowBlur = v;
    },
    get shadowColor() {
      return state.shadowColor;
    },
    set shadowColor(v: string) {
      state.shadowColor = v;
    },
    get fillStyle() {
      return state.fillStyle;
    },
    set fillStyle(v: string) {
      state.fillStyle = v;
    },
    clearRect: () => {},
    fillRect: (x: number, y: number, w: number, h: number) => {
      fills.push({
        globalAlpha: state.globalAlpha,
        shadowBlur: state.shadowBlur,
        x,
        y,
        w,
        h,
        style: state.fillStyle,
      });
    },
  } as unknown as CanvasRenderingContext2D;
  return { ctx, fills };
}

function makePet(): { pet: Pet; fills: RecordedFill[] } {
  const { ctx, fills } = makeStubCtx();
  const canvas = { width: 1440, height: 900 } as HTMLCanvasElement;
  return { pet: new Pet(canvas, ctx), fills };
}

const BASE_CELL = 48;

/** 睡眠状态（人已离开）。 */
const AWAY_STATE = {
  doing: "away" as const,
  tempo: "resting" as const,
  late_night: false,
  keystrokes_per_min: 0,
  mood: "focused" as const,
  activity: "working" as const,
};

/**
 * 跑若干帧让宠物进入稳定状态。
 *
 * 小跳与走动期间会提帧到 30fps（正确行为，移动必须流畅），
 * 验证睡眠帧率前需要先让它安定。
 */
function settle(pet: Pet): number {
  let t = 0;
  for (let i = 0; i < 900; i++) {
    t += 16;
    pet.tick(t);
  }
  return t;
}

describe("穿透约束：绝不产生半透明像素", () => {
  it("所有绘制都在 alpha=1 下进行，辉光靠点阵而非透明度", () => {
    const { pet, fills } = makePet();
    pet.setActivity("active");
    // 跨越一整个呼吸周期，覆盖辉光的各种尺寸
    for (let t = 0; t < 2600; t += 40) pet.tick(1000 + t);

    expect(fills.length).toBeGreaterThan(0);
    for (const f of fills) {
      expect(f.globalAlpha).toBe(1);
    }
  });

  it("绝不使用 shadowBlur 制造辉光", () => {
    const { pet, fills } = makePet();
    pet.setActivity("active");
    for (let t = 0; t < 2600; t += 40) pet.tick(1000 + t);

    for (const f of fills) {
      expect(f.shadowBlur).toBe(0);
    }
  });

  it("辉光由许多小方块组成，而非一整块大面积覆盖", () => {
    const { pet, fills } = makePet();
    // 辉光只在「进入状态」时出现（语义信号而非常驻装饰），
    // 因此必须先进入该状态才能验证其形态
    pet.applyState({
      doing: "editing",
      tempo: "flow",
      late_night: false,
      keystrokes_per_min: 220,
      mood: "focused",
      activity: "working",
    });
    pet.tick(1000);

    const bodySide = pet.renderedSide;
    const glowCells = fills.filter((f) => f.w < bodySide && f.h < bodySide);
    // 点阵辉光必然产生大量小方块；若有人换回 bloom，这个数字会塌成个位数
    expect(glowCells.length).toBeGreaterThan(20);
  });

  it("非专注状态不画辉光，避免常亮造成的闪烁感", () => {
    const { pet, fills } = makePet();
    pet.applyState({
      doing: "editing",
      tempo: "normal",
      late_night: false,
      keystrokes_per_min: 10,
      mood: "focused",
      activity: "working",
    });
    pet.tick(1000);

    const bodySide = pet.renderedSide;
    const tiny = fills.filter((f) => f.w < bodySide / 4);
    // 只剩眼睛相关的少量矩形，不应有成片的辉光点阵
    expect(tiny.length).toBeLessThan(12);
  });
});

describe("尺寸档位", () => {
  it("基准边长恒为基础格的整数倍", () => {
    const { pet } = makePet();
    for (let i = 0; i < SIZE_STEPS.length; i++) {
      expect(pet.body.w % BASE_CELL).toBe(0);
      expect(SIZE_STEPS).toContain(pet.body.w / BASE_CELL);
      pet.cycleSize();
    }
  });

  it("循环遍历所有档位后回到起点，不越界", () => {
    const { pet } = makePet();
    const first = pet.body.w;
    const seen = new Set<number>();
    for (let i = 0; i < SIZE_STEPS.length; i++) {
      seen.add(pet.body.w);
      pet.cycleSize();
    }
    expect(seen.size).toBe(SIZE_STEPS.length);
    expect(pet.body.w).toBe(first);
  });

  it("宠物恒为正方形，呼吸不产生形变", () => {
    const { pet } = makePet();
    for (let i = 0; i < SIZE_STEPS.length; i++) {
      expect(pet.body.w).toBe(pet.body.h);
      pet.cycleSize();
    }
  });

  it("形变后的渲染尺寸仍在合理范围内，不会畸变或消失", () => {
    const { pet } = makePet();
    pet.setActivity("active");
    const base = pet.body.w;
    for (let t = 0; t < 2600; t += 40) {
      pet.tick(1000 + t);
      // 形变（squash & stretch）幅度最大约 ±18%，叠加呼吸 ±2%
      expect(pet.renderedSide).toBeGreaterThanOrEqual(Math.floor(base * 0.8));
      expect(pet.renderedSide).toBeLessThanOrEqual(Math.ceil(base * 1.2));
    }
  });
});

describe("指针交互", () => {
  it("点击身体外不被拦截，点击落到下层应用", () => {
    const { pet } = makePet();
    expect(pet.pointerDown(-50, -50)).toBe(false);
  });

  it("点击身体内被拦截", () => {
    const { pet } = makePet();
    const b = pet.body;
    expect(pet.pointerDown(b.x + 1, b.y + 1)).toBe(true);
  });

  it("未命中时的移动不会挪动宠物", () => {
    const { pet } = makePet();
    const before = pet.body;
    pet.pointerDown(-50, -50);
    pet.pointerMove(800, 600);
    expect(pet.body.x).toBe(before.x);
    expect(pet.body.y).toBe(before.y);
  });

  it("拖动按偏移量移动宠物，不跳位", () => {
    const { pet } = makePet();
    const b = pet.body;
    pet.pointerDown(b.x + 10, b.y + 20);
    pet.pointerMove(b.x + 110, b.y + 220);
    expect(pet.body.x).toBe(b.x + 100);
    expect(pet.body.y).toBe(b.y + 200);
  });

  it("松手后移动不再拖动宠物", () => {
    const { pet } = makePet();
    const b = pet.body;
    pet.pointerDown(b.x + 10, b.y + 10);
    pet.pointerUp();
    pet.pointerMove(900, 900);
    expect(pet.body.x).toBe(b.x);
  });

  it("交互不污染活跃度：拖动睡眠中的宠物，松手后仍是睡眠态", () => {
    const { pet } = makePet();
    pet.setActivity("sleep");
    const b = pet.body;
    pet.pointerDown(b.x + 5, b.y + 5);
    pet.pointerMove(b.x + 50, b.y + 50);
    pet.pointerUp();
    expect(pet.activityForTest).toBe("sleep");
  });
});

describe("出场与走动范围", () => {
  it("出场就在原处，不会有下落过程", () => {
    const { pet } = makePet();
    const y0 = pet.body.y;
    for (let i = 0; i < 120; i++) pet.tick(i * 16);
    // 范围默认 nearby，垂直方向只有小跳会改变 y，且会回到原位
    const ys: number[] = [];
    for (let i = 0; i < 300; i++) {
      pet.tick(2000 + i * 16);
      ys.push(pet.body.y);
    }
    // 绝不应出现持续单向下坠
    const monotonicFall = ys.every((y, i) => i === 0 || y >= ys[i - 1]);
    expect(monotonicFall && ys[ys.length - 1] > y0 + 50).toBe(false);
  });

  it("范围设为不动时完全静止", () => {
    const { pet } = makePet();
    pet.setScope("still");
    const x0 = pet.body.x;
    const y0 = pet.body.y;
    for (let i = 0; i < 60 * 120; i++) pet.tick(i * 16);
    expect(pet.body.x).toBe(x0);
    expect(pet.body.y).toBe(y0);
    expect(pet.currentMotion).toBe("idle");
  });

  it("不动时连呼吸缩放都没有，轮廓尺寸恒定", () => {
    // 轮廓伸缩是余光最容易察觉的「动」，保留它就谈不上不动
    const { pet } = makePet();
    pet.setScope("still");
    pet.setActivity("active");
    const sizes = new Set<number>();
    for (let i = 0; i < 60 * 60; i++) {
      pet.tick(i * 16);
      sizes.add(pet.renderedSide);
    }
    expect(sizes.size).toBe(1);
    expect([...sizes][0]).toBe(pet.body.w);
  });

  it("其他范围下仍有呼吸，宠物不是死图片", () => {
    const { pet } = makePet();
    pet.setScope("nearby");
    pet.setActivity("active");
    const sizes = new Set<number>();
    for (let i = 0; i < 60 * 60; i++) {
      pet.tick(i * 16);
      sizes.add(pet.renderedSide);
    }
    expect(sizes.size).toBeGreaterThan(1);
  });

  it("不动时眼睛仍会眨，保留生命感", () => {
    const { pet } = makePet();
    pet.setScope("still");
    pet.setActivity("active");
    const lids = new Set<number>();
    for (let i = 0; i < 60 * 60; i++) {
      pet.tick(i * 16);
      lids.add(Math.round(pet.eyeFrame.lid * 10));
    }
    expect(lids.size).toBeGreaterThan(1);
  });

  it("不动模式下不会被提帧，维持低 CPU", () => {
    const { pet } = makePet();
    pet.setScope("still");
    pet.applyState(AWAY_STATE);
    for (let i = 0; i < 600; i++) pet.tick(i * 16);
    expect(pet.debugIntervalMs).toBeCloseTo(250, 5);
  });

  it("范围越大活动跨度越大", () => {
    // 用多次尝试取最大值，避免随机源偶发让结果收敛不足而 flaky
    const spread = (scope: Parameters<Pet["setScope"]>[0]) => {
      let widest = 0;
      for (let trial = 0; trial < 5; trial++) {
        const { pet } = makePet();
        pet.setScope(scope);
        let lo = Infinity;
        let hi = -Infinity;
        for (let i = 0; i < 60 * 240; i++) {
          pet.tick(trial * 100000 + i * 16);
          lo = Math.min(lo, pet.body.x);
          hi = Math.max(hi, pet.body.x);
        }
        widest = Math.max(widest, hi - lo);
      }
      return widest;
    };
    expect(spread("nearby")).toBeLessThan(spread("halfscreen"));
  });
});

describe("帧率预算", () => {
  it("待机态按 12fps 间隔绘制", () => {
    const { pet } = makePet();
    pet.setActivity("idle");
    expect(pet.debugIntervalMs).toBeCloseTo(1000 / 12, 6);
  });

  it("睡眠态跳过过密的 tick", () => {
    const { pet } = makePet();
    pet.applyState(AWAY_STATE);
    const t = settle(pet);
    // 睡眠态间隔 250ms
    expect(pet.tick(t + 300)).toBe(true);
    expect(pet.tick(t + 320)).toBe(false);
    expect(pet.tick(t + 600)).toBe(true);
  });

  it("拖动中强制提到 active 档位，避免拖动掉帧", () => {
    const { pet } = makePet();
    pet.setActivity("sleep");
    const b = pet.body;
    pet.pointerDown(b.x + 5, b.y + 5);
    expect(pet.debugIntervalMs).toBeCloseTo(1000 / 30, 6);
  });

  it("resize 后强制立即重绘（画布已被清空）", () => {
    const { pet } = makePet();
    pet.setActivity("sleep");
    expect(pet.tick(5000)).toBe(true);
    expect(pet.tick(5010)).toBe(false);
    pet.resize(800, 600);
    expect(pet.tick(5020)).toBe(true);
  });

  it("睡眠态一秒内只绘制约 4 次（CPU 预算的直接体现）", () => {
    const { pet } = makePet();
    pet.applyState(AWAY_STATE);
    const t = settle(pet);
    let drawn = 0;
    // 模拟 60Hz 的 rAF 调用一整秒
    for (let i = 0; i < 60; i++) {
      if (pet.tick(t + i * (1000 / 60))) drawn++;
    }
    expect(drawn).toBeLessThanOrEqual(5);
  });

  it("睡眠时不漫游，因此不会被提帧", () => {
    const { pet } = makePet();
    pet.applyState(AWAY_STATE);
    settle(pet);
    expect(pet.currentMotion).toBe("sleep");
    expect(pet.debugIntervalMs).toBeCloseTo(250, 5);
  });

  it("动作结束后不再持续提帧（否则会永久 30fps 烧 CPU）", () => {
    const { pet } = makePet();
    pet.applyState(AWAY_STATE);
    settle(pet);
    expect(["idle", "sleep"]).toContain(pet.currentMotion);
  });
});

describe("形象系统", () => {
  const CUSTOM: PetAvatar = {
    shape: "round",
    eyeStyle: "big",
    browStyle: "flat",
    actionStyle: "bouncy",
    bodyColor: "#A85232",
    accentColor: "#FFE066",
    attachment: "none",
    pattern: "none",
    secondaryColor: "",
  };

  it("未设置形象时保持旧外观（默认矩形+青绿基色）", () => {
    const { pet, fills } = makePet();
    pet.setActivity("active");
    pet.tick(1000);
    expect(fills.some((f) => f.style === DEFAULT_AVATAR.bodyColor)).toBe(true);
  });

  it("setAvatar 后身体使用形象基色", () => {
    const { pet, fills } = makePet();
    pet.setAvatar(CUSTOM);
    pet.setActivity("active");
    pet.tick(1000);
    expect(fills.some((f) => f.style === CUSTOM.bodyColor)).toBe(true);
  });

  it("focused 状态在形象基色上提亮，而非回退到固定旧色", () => {
    const { pet, fills } = makePet();
    pet.setAvatar(CUSTOM);
    pet.applyState({
      doing: "editing",
      tempo: "flow",
      late_night: false,
      keystrokes_per_min: 220,
      mood: "focused",
      activity: "working",
    });
    pet.tick(1000);
    const focusedColor = applyTint(CUSTOM.bodyColor, "focused");
    expect(focusedColor).not.toBe(CUSTOM.bodyColor);
    expect(fills.some((f) => f.style === focusedColor)).toBe(true);
  });

  it("非矩形形状逐行绘制，fillRect 次数远多于矩形的 1 次", () => {
    const { pet, fills } = makePet();
    pet.setAvatar(CUSTOM);
    pet.setActivity("active");
    pet.tick(1000);
    const bodyRows = fills.filter((f) => f.style === CUSTOM.bodyColor);
    expect(bodyRows.length).toBeGreaterThan(50);
  });

  it("眉毛使用形象点缀色", () => {
    const { pet, fills } = makePet();
    pet.setAvatar(CUSTOM);
    pet.setActivity("active");
    pet.tick(1000);
    expect(fills.some((f) => f.style === CUSTOM.accentColor)).toBe(true);
  });

  it("无眉毛形象不绘制眉毛色", () => {
    const { pet, fills } = makePet();
    pet.setAvatar({ ...CUSTOM, browStyle: "none", bodyColor: "#7CF5C4" });
    pet.setActivity("active");
    pet.tick(1000);
    // 点缀色只用于眉毛与高光；无眉时只允许高光出现（高光很小，w 远小于身体）
    const accentFills = fills.filter((f) => f.style === CUSTOM.accentColor);
    for (const f of accentFills) {
      expect(f.w).toBeLessThan(pet.body.w / 4);
    }
  });

  it("带耳形象：附件画在身体上沿的预留区内", () => {
    const { pet, fills } = makePet();
    pet.setAvatar({ ...CUSTOM, attachment: "ears", browStyle: "none" });
    pet.setActivity("active");
    pet.tick(1000);
    const b = pet.body;
    // 附件色块出现在 bbox 顶部约 1/4 区域（高光在眼睛中部，不会落进来）
    const capFills = fills.filter(
      (f) => f.style === CUSTOM.accentColor && f.y < b.y + b.h * 0.28 && f.w >= 4,
    );
    expect(capFills.length).toBeGreaterThan(0);
  });

  it("条纹形象：身体行出现次色", () => {
    const { pet, fills } = makePet();
    pet.setAvatar({
      ...CUSTOM,
      attachment: "none",
      browStyle: "none",
      pattern: "stripes",
      secondaryColor: "#223344",
    });
    pet.setActivity("active");
    pet.tick(1000);
    expect(fills.some((f) => f.style === "#223344")).toBe(true);
  });

  it("斑点形象：次色以小块出现且数量受控", () => {
    const { pet, fills } = makePet();
    pet.setAvatar({
      ...CUSTOM,
      attachment: "none",
      browStyle: "none",
      pattern: "spots",
      secondaryColor: "#223344",
    });
    pet.setActivity("active");
    pet.tick(1000);
    const spots = fills.filter((f) => f.style === "#223344");
    expect(spots.length).toBeGreaterThan(3);
    for (const f of spots) {
      expect(f.w).toBeLessThanOrEqual(6);
    }
  });
});

describe("今日特效奖励", () => {
  it("setEffects 生效与清除", () => {
    const { pet } = makePet();
    expect(pet.activeEffects.size).toBe(0);
    pet.setEffects(["tomato", "bubbles"]);
    expect(pet.activeEffects.has("tomato")).toBe(true);
    expect(pet.activeEffects.has("bubbles")).toBe(true);
    pet.setEffects([]);
    expect(pet.activeEffects.size).toBe(0);
  });

  it("吃番茄时嘴部多出红色像素块", () => {
    const { pet, fills } = makePet();
    pet.setActivity("active");
    const t = settle(pet);
    pet.tick(t);
    const base = fills.length;

    pet.setEffects(["tomato"]);
    pet.tick(t + 100);
    // 咀嚼窗口（4 秒周期的前 40%）内必然可见
    expect(fills.length).toBeGreaterThan(base);
  });

  it("特效绘制不产生半透明像素（与辉光同一硬约束）", () => {
    const { pet, fills } = makePet();
    pet.setActivity("active");
    pet.setEffects(["tomato", "bubbles", "sparkle"]);
    const t = settle(pet);
    // 多帧采样，覆盖泡泡/星星的可见窗口
    for (let i = 0; i < 30; i++) {
      pet.tick(t + i * 100);
    }
    for (const f of fills) {
      expect(f.globalAlpha).toBe(1);
    }
  });
});
