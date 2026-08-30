import { describe, expect, it } from "vitest";
import { MicroExpression, type ExprInput } from "../src/anim/expression";

/** 可预测的伪随机源，让眨眼/扫视调度可断言。 */
function seq(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

function input(patch: Partial<ExprInput> = {}): ExprInput {
  return {
    asleep: false,
    stuck: false,
    flow: false,
    tired: false,
    poked: false,
    gazeTarget: null,
    ...patch,
  };
}

describe("眼型随状态变化", () => {
  it("常态为饱满圆眼", () => {
    const m = new MicroExpression(seq([0.5]));
    expect(m.update(0, input()).shape).toBe("round");
  });

  it("睡眠时闭眼且完全闭合", () => {
    const m = new MicroExpression(seq([0.5]));
    const f = m.update(0, input({ asleep: true }));
    expect(f.shape).toBe("closed");
    expect(f.lid).toBe(1);
  });

  it("进入状态时微眯（专注）", () => {
    const m = new MicroExpression(seq([0.5]));
    expect(m.update(0, input({ flow: true })).shape).toBe("squint");
  });

  it("深夜疲态为半闭眼", () => {
    const m = new MicroExpression(seq([0.5]));
    expect(m.update(0, input({ tired: true })).shape).toBe("half");
  });

  it("被点击时睁大表示惊讶", () => {
    const m = new MicroExpression(seq([0.5]));
    expect(m.update(0, input({ poked: true })).shape).toBe("wide");
  });

  it("惊讶会持续一小段时间而非仅一帧", () => {
    const m = new MicroExpression(seq([0.5]));
    m.update(1000, input({ poked: true }));
    expect(m.update(1200, input()).shape).toBe("wide");
    expect(m.update(1600, input()).shape).toBe("round");
  });

  it("睡眠优先于其他状态", () => {
    const m = new MicroExpression(seq([0.5]));
    const f = m.update(0, input({ asleep: true, flow: true, tired: true }));
    expect(f.shape).toBe("closed");
  });
});

describe("眨眼节奏承担情绪表达", () => {
  it("首帧不眨眼（避免启动瞬间齐眨）", () => {
    const m = new MicroExpression(seq([0.5]));
    expect(m.update(0, input()).lid).toBe(0);
  });

  it("到达间隔后会眨眼并完整闭合再张开", () => {
    // rng 恒为 0 → 取间隔下限 2200ms
    const m = new MicroExpression(seq([0]));
    m.update(0, input());

    expect(m.update(2100, input()).lid).toBe(0);

    // 眨眼时长 180ms，闭合阶段占前 40%（72ms）
    const closing = m.update(2200 + 36, input()).lid;
    expect(closing).toBeGreaterThan(0);
    expect(closing).toBeLessThan(1);

    const shut = m.update(2200 + 72, input()).lid;
    expect(shut).toBeCloseTo(1, 1);

    const opening = m.update(2200 + 130, input()).lid;
    expect(opening).toBeGreaterThan(0);
    expect(opening).toBeLessThan(1);

    expect(m.update(2200 + 181, input()).lid).toBe(0);
  });

  it("困倦时眨眼比专注时慢得多", () => {
    const tired = new MicroExpression(seq([0]));
    tired.update(0, input({ tired: true }));
    // 疲态间隔下限 1400ms、时长 340ms
    tired.update(1400, input({ tired: true }));
    const tiredMid = tired.update(1400 + 136, input({ tired: true })).lid;

    const flow = new MicroExpression(seq([0]));
    flow.update(0, input({ flow: true }));
    // 专注间隔下限 4200ms、时长 130ms
    flow.update(4200, input({ flow: true }));
    const flowDone = flow.update(4200 + 131, input({ flow: true })).lid;

    expect(tiredMid).toBeCloseTo(1, 1);
    expect(flowDone).toBe(0);
  });

  it("专注时的眨眼间隔明显长于常态", () => {
    // 都用 rng=0 取下限，比较两者第一次眨眼的时刻
    const normal = new MicroExpression(seq([0]));
    normal.update(0, input());
    expect(normal.update(2200, input()).lid).toBeGreaterThanOrEqual(0);

    const flow = new MicroExpression(seq([0]));
    flow.update(0, input({ flow: true }));
    // 常态早已该眨，专注状态此刻仍不眨
    expect(flow.update(2200, input({ flow: true })).lid).toBe(0);
  });

  it("睡眠期间不进行眨眼调度", () => {
    const m = new MicroExpression(seq([0]));
    for (let t = 0; t < 20000; t += 500) {
      expect(m.update(t, input({ asleep: true })).lid).toBe(1);
    }
  });
});

describe("视线", () => {
  it("有目标时朝目标方向偏移", () => {
    const m = new MicroExpression(seq([0.5]));
    let f = m.update(0, input({ gazeTarget: { x: 1, y: 0 } }));
    // 指数平滑，需要多帧才接近目标
    for (let t = 16; t < 600; t += 16) {
      f = m.update(t, input({ gazeTarget: { x: 1, y: 0 } }));
    }
    expect(f.gazeX).toBeGreaterThan(0.8);
    expect(Math.abs(f.gazeY)).toBeLessThan(0.05);
  });

  it("视线偏移不会超出眼窝范围", () => {
    const m = new MicroExpression(seq([0.5]));
    let f = m.update(0, input({ gazeTarget: { x: 99, y: -99 } }));
    for (let t = 16; t < 1200; t += 16) {
      f = m.update(t, input({ gazeTarget: { x: 99, y: -99 } }));
    }
    expect(f.gazeX).toBeLessThanOrEqual(1);
    expect(f.gazeY).toBeGreaterThanOrEqual(-1);
  });

  it("视线平滑移动而非瞬移", () => {
    const m = new MicroExpression(seq([0.5]));
    const first = m.update(0, input({ gazeTarget: { x: 1, y: 1 } }));
    expect(Math.abs(first.gazeX)).toBeLessThan(0.5);
  });

  it("思考时视线偏向上方（回忆推理的典型眼动）", () => {
    // rng=0.9 → 扫视分量为正，stuck 应强制翻为负（向上）
    const m = new MicroExpression(seq([0.9]));
    let f = m.update(0, input({ stuck: true }));
    for (let t = 16; t < 1500; t += 16) {
      f = m.update(t, input({ stuck: true }));
    }
    expect(f.gazeY).toBeLessThanOrEqual(0);
  });

  it("专注时视线几乎锁定，游走幅度远小于思考时", () => {
    const mkPeak = (patch: Partial<ExprInput>) => {
      const m = new MicroExpression(seq([1]));
      let peak = 0;
      for (let t = 0; t < 6000; t += 16) {
        const f = m.update(t, input(patch));
        peak = Math.max(peak, Math.abs(f.gazeX));
      }
      return peak;
    };
    expect(mkPeak({ flow: true })).toBeLessThan(mkPeak({ stuck: true }));
  });

  it("惊讶时瞳孔定住不游走", () => {
    const m = new MicroExpression(seq([1]));
    m.update(0, input({ poked: true }));
    let f = m.update(0, input({ poked: true }));
    for (let t = 16; t < 400; t += 16) {
      f = m.update(t, input());
    }
    expect(Math.abs(f.gazeX)).toBeLessThan(0.1);
    expect(Math.abs(f.gazeY)).toBeLessThan(0.1);
  });
});
