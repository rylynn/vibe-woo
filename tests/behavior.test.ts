import { describe, expect, it } from "vitest";
import {
  Behavior,
  ROAM_SCOPES,
  type BehaviorInput,
  type RoamScope,
} from "../src/anim/behavior";

const BOUNDS = { width: 1440, height: 900 };
const SIDE = 96;
const START_X = 600;
const START_Y = 400;

function input(patch: Partial<BehaviorInput> = {}): BehaviorInput {
  return {
    dt: 1 / 60,
    bounds: BOUNDS,
    side: SIDE,
    held: false,
    asleep: false,
    scope: "fullscreen",
    ...patch,
  };
}

/**
 * 恒定 rng。
 *
 * 用常量而非序列：pickIdleGap / pickTarget / beginSomething 都会消耗
 * 随机数，序列会被打乱到无法预测。恒定值让分支完全确定。
 *   - 0.9 > WALK_SHARE(0.45) → 总是做待机小动作
 *   - 0.1 < WALK_SHARE       → 总是走动
 */
const alwaysAct = () => 0.9;
const alwaysWalk = () => 0.1;

function make(rng: () => number, x = START_X, y = START_Y): Behavior {
  return new Behavior(x, y, rng);
}

/** 收集一段时间内出现过的所有 motion。 */
function motionsOver(
  b: Behavior,
  seconds: number,
  patch: Partial<BehaviorInput> = {},
): Set<string> {
  const seen = new Set<string>();
  for (let i = 0; i < seconds * 60; i++) {
    seen.add(b.update(input(patch)).motion);
  }
  return seen;
}

describe("不做重力下落", () => {
  it("出场就待在原处，不会往下掉", () => {
    const b = make(alwaysAct, START_X, 200);
    for (let i = 0; i < 60; i++) {
      const s = b.update(input({ scope: "still" }));
      expect(s.y).toBe(200);
    }
  });

  it("没有 fall 这种动作", () => {
    const b = make(alwaysAct, START_X, 100);
    const seen = motionsOver(b, 20);
    expect(seen.has("fall")).toBe(false);
  });

  it("松手后停在放置位置，不会掉下去", () => {
    const b = make(alwaysAct);
    b.placeAt(800, 150);
    for (let i = 0; i < 120; i++) {
      b.update(input({ scope: "still" }));
    }
    expect(b.current.y).toBe(150);
  });

  it("松手处成为新的活动中心", () => {
    const b = make(alwaysWalk);
    b.placeAt(300, 500);
    for (let i = 0; i < 60 * 30; i++) {
      b.update(input({ scope: "nearby" }));
    }
    // nearby 限制在锚点 ±2.5 倍身长内
    expect(Math.abs(b.current.x - 300)).toBeLessThanOrEqual(SIDE * 2.5 + 1);
  });
});

describe("小跳用弧线而非重力", () => {
  it("小跳会离地再落回原高度", () => {
    const b = make(alwaysAct);
    b.triggerActForTest("hop", input());
    let minY = START_Y;
    let sawHop = false;
    for (let i = 0; i < 60 * 3; i++) {
      const s = b.update(input());
      if (s.motion === "hop") {
        sawHop = true;
        minY = Math.min(minY, s.y);
      }
    }
    expect(sawHop).toBe(true);
    expect(minY).toBeLessThan(START_Y - 20);
    expect(b.current.y).toBe(START_Y);
  });

  it("小跳轨迹平滑上升再下降，不是突然坠落", () => {
    const b = make(alwaysAct);
    b.triggerActForTest("hop", input());
    const ys: number[] = [];
    for (let i = 0; i < 60; i++) {
      const s = b.update(input());
      if (s.motion === "hop") ys.push(s.y);
    }
    // 找到最高点，前半段应单调上升（y 递减），后半段单调下降
    const peak = ys.indexOf(Math.min(...ys));
    expect(peak).toBeGreaterThan(2);
    expect(peak).toBeLessThan(ys.length - 2);
    for (let i = 1; i <= peak; i++) {
      expect(ys[i]).toBeLessThanOrEqual(ys[i - 1] + 0.001);
    }
  });

  it("小跳不改变水平位置", () => {
    const b = make(alwaysAct);
    const startX = b.current.x;
    b.triggerActForTest("hop", input());
    for (let i = 0; i < 60 * 3; i++) b.update(input());
    expect(b.current.x).toBe(startX);
  });
});

describe("活动范围配置", () => {
  const spread = (scope: RoamScope, seconds = 120): number => {
    const b = make(alwaysWalk);
    let lo = START_X;
    let hi = START_X;
    for (let i = 0; i < seconds * 60; i++) {
      const s = b.update(input({ scope }));
      lo = Math.min(lo, s.x);
      hi = Math.max(hi, s.x);
    }
    return hi - lo;
  };

  it("不动：完全静止", () => {
    const b = make(alwaysWalk);
    for (let i = 0; i < 60 * 120; i++) {
      expect(b.update(input({ scope: "still" })).motion).toBe("idle");
    }
    expect(b.current.x).toBe(START_X);
  });

  it("周围：只在小范围晃动", () => {
    const s = spread("nearby");
    expect(s).toBeGreaterThan(0);
    // 双向各 2.5 倍身长，总跨度不超过 5 倍多一点
    expect(s).toBeLessThanOrEqual(SIDE * 5 + 2);
  });

  it("半屏：跨度约为屏宽一半，且明显大于周围", () => {
    const half = spread("halfscreen", 240);
    expect(half).toBeGreaterThan(spread("nearby"));
    // 双向各 1/4 屏宽 → 合计约半屏。留出余量避免 flaky
    expect(half).toBeLessThanOrEqual(BOUNDS.width * 0.55);
  });

  it("半屏与全屏必须有可感知的差别", () => {
    // 早先 halfscreen 定义为 8 倍身长（±768px），双向已超出屏宽，
    // 导致两档行为完全相同 —— 名字对不上实际
    const spreadRandom = (scope: RoamScope): number => {
      let widest = 0;
      for (let trial = 0; trial < 8; trial++) {
        const b = make(Math.random);
        let lo = START_X;
        let hi = START_X;
        for (let i = 0; i < 240 * 60; i++) {
          const s = b.update(input({ scope }));
          lo = Math.min(lo, s.x);
          hi = Math.max(hi, s.x);
        }
        widest = Math.max(widest, hi - lo);
      }
      return widest;
    };
    const half = spreadRandom("halfscreen");
    const full = spreadRandom("fullscreen");
    expect(full).toBeGreaterThan(half * 1.2);
  });

  it("任何范围下都不会走出屏幕", () => {
    for (const scope of ROAM_SCOPES) {
      const b = make(alwaysWalk, BOUNDS.width - SIDE - 10, START_Y);
      for (let i = 0; i < 60 * 60; i++) {
        const s = b.update(input({ scope }));
        expect(s.x).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThanOrEqual(BOUNDS.width - SIDE);
      }
    }
  });

  it("周围范围下宠物不会一步步漂到远处", () => {
    // 逐次随机若不以锚点约束，会像随机游走一样越漂越远
    const b = make(alwaysWalk);
    for (let i = 0; i < 60 * 300; i++) {
      b.update(input({ scope: "nearby" }));
      expect(Math.abs(b.current.x - START_X)).toBeLessThanOrEqual(
        SIDE * 2.5 + 1,
      );
    }
  });
});

describe("拖动", () => {
  it("被拖住时不做任何自主动作", () => {
    const b = make(alwaysAct);
    for (let i = 0; i < 60; i++) {
      expect(b.update(input({ held: true })).motion).toBe("held");
    }
  });

  it("拖动会中断进行中的待机动作", () => {
    const b = make(alwaysAct);
    b.triggerActForTest("stretch", input());
    b.update(input());
    expect(b.update(input({ held: true })).motion).toBe("held");
  });
});

describe("待机小动作（生命感的主要来源）", () => {
  it("会出现待机小动作，而不只是站着", () => {
    const b = make(alwaysAct);
    const seen = motionsOver(b, 30);
    const acts = ["hop", "lookaround", "stretch"].filter((m) => seen.has(m));
    expect(acts.length).toBeGreaterThan(0);
  });

  it("即使范围设为周围，小动作照常发生", () => {
    // 「不想让它乱跑」不等于「不想让它动」
    const b = make(alwaysAct);
    const seen = motionsOver(b, 30, { scope: "nearby" });
    const acts = ["hop", "lookaround", "stretch"].filter((m) => seen.has(m));
    expect(acts.length).toBeGreaterThan(0);
  });

  it("张望时会左右转朝向但不移动", () => {
    const b = make(alwaysAct);
    const startX = b.current.x;
    b.triggerActForTest("lookaround", input());
    const facings = new Set<number>();
    for (let i = 0; i < 60 * 3; i++) {
      const s = b.update(input());
      if (s.motion === "lookaround") facings.add(s.facing);
    }
    expect(facings.size).toBe(2);
    expect(b.current.x).toBe(startX);
  });

  it("待机动作会上报进度供渲染层做形变", () => {
    const b = make(alwaysAct);
    b.triggerActForTest("stretch", input());
    let sawPhase = false;
    for (let i = 0; i < 60 * 3; i++) {
      const s = b.update(input());
      if (s.motion === "stretch" && s.actPhase > 0 && s.actPhase < 1) {
        sawPhase = true;
      }
    }
    expect(sawPhase).toBe(true);
  });

  it("动作结束后回到待机，不会卡住", () => {
    const b = make(alwaysAct);
    b.triggerActForTest("lookaround", input());
    let sawAct = false;
    for (let i = 0; i < 60 * 10; i++) {
      const s = b.update(input());
      if (s.motion === "lookaround") sawAct = true;
      if (sawAct && s.motion === "idle") return;
    }
    throw new Error("待机动作后未回到 idle");
  });

  it("睡眠时不做任何动作", () => {
    const b = make(alwaysAct);
    for (let i = 0; i < 60 * 60; i++) {
      expect(b.update(input({ asleep: true })).motion).toBe("sleep");
    }
    expect(b.current.y).toBe(START_Y);
  });
});

describe("漫游", () => {
  it("会自己走动", () => {
    const b = make(alwaysWalk);
    expect(motionsOver(b, 20).has("walk")).toBe(true);
  });

  it("朝向与移动方向一致", () => {
    for (let i = 0; i < 40; i++) {
      const b = make(Math.random);
      let checked = false;
      let prevX = b.current.x;
      for (let f = 0; f < 60 * 20 && !checked; f++) {
        const s = b.update(input());
        if (s.motion === "walk" && Math.abs(s.x - prevX) > 0.01) {
          expect(s.facing).toBe(s.x > prevX ? 1 : -1);
          checked = true;
        }
        prevX = s.x;
      }
    }
  });

  it("十秒内必有多次动作（可感知的活跃）", () => {
    // 用确定性 rng：alwaysWalk 保证每次都选走动分支。
    // 原测试用 Math.random，会偶发两次动作间隔落在 10s 之外而 flaky。
    const b = make(alwaysWalk);
    let bouts = 0;
    let prev = "idle";
    for (let i = 0; i < 60 * 10; i++) {
      const m = b.update(input()).motion;
      if (prev === "idle" && m !== "idle") bouts++;
      prev = m;
    }
    expect(bouts).toBeGreaterThanOrEqual(2);
  });
});
