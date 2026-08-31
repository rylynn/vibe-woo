import { describe as d, expect, it } from "vitest";
import { appearanceFor, breathePeriodFor, describe as label } from "../src/appearance";
import { DEFAULT_STATE, type PetState } from "../src/state";

function st(patch: Partial<PetState>): PetState {
  return { ...DEFAULT_STATE, ...patch };
}

d("律动同步打字节奏", () => {
  it("不打字时用基准呼吸周期", () => {
    expect(breathePeriodFor(0)).toBe(2400);
  });

  it("打字越快呼吸越急促", () => {
    const slow = breathePeriodFor(30);
    const fast = breathePeriodFor(200);
    expect(fast).toBeLessThan(slow);
  });

  it("击键频率极高时周期收敛不会归零", () => {
    expect(breathePeriodFor(99999)).toBeGreaterThanOrEqual(700);
  });

  it("负值不会产生异常周期（防传感器抖动）", () => {
    expect(breathePeriodFor(-50)).toBe(2400);
  });

  it("周期随频率单调递减", () => {
    const seq = [0, 50, 100, 150, 200, 250, 300].map(breathePeriodFor);
    for (let i = 1; i < seq.length; i++) {
      expect(seq[i]).toBeLessThanOrEqual(seq[i - 1]);
    }
  });
});

d("状态到外观的映射", () => {
  it("离开时睡觉并降到最低帧率", () => {
    const a = appearanceFor(st({ doing: "away", tempo: "resting" }));
    expect(a.asleep).toBe(true);
    expect(a.activity).toBe("sleep");
    expect(a.tint).toBe("dim");
  });

  it("编辑器内卡住时凝视屏幕", () => {
    const a = appearanceFor(st({ doing: "editing", tempo: "stuck" }));
    expect(a.peeking).toBe(true);
    expect(a.asleep).toBe(false);
  });

  it("非编辑器的静默不触发凝视", () => {
    const a = appearanceFor(st({ doing: "browsing", tempo: "resting" }));
    expect(a.peeking).toBe(false);
  });

  it("进入状态时提到最高帧率", () => {
    const a = appearanceFor(
      st({ doing: "editing", tempo: "flow", keystrokes_per_min: 220 }),
    );
    expect(a.activity).toBe("active");
    expect(a.tint).toBe("focused");
  });

  it("卡住时不急促呼吸，即便刚才击键频率很高", () => {
    const a = appearanceFor(
      st({ doing: "editing", tempo: "stuck", keystrokes_per_min: 250 }),
    );
    expect(a.breathePeriodMs).toBe(2400);
  });

  it("深夜时呼吸放缓并显示疲态", () => {
    const day = appearanceFor(
      st({ doing: "editing", tempo: "normal", keystrokes_per_min: 60 }),
    );
    const night = appearanceFor(
      st({
        doing: "editing",
        tempo: "normal",
        keystrokes_per_min: 60,
        late_night: true,
      }),
    );
    expect(night.breathePeriodMs).toBeGreaterThan(day.breathePeriodMs);
    expect(night.tired).toBe(true);
    expect(day.tired).toBe(false);
  });

  it("睡眠时的呼吸不受深夜系数二次放缓", () => {
    const a = appearanceFor(
      st({ doing: "away", tempo: "resting", late_night: true }),
    );
    expect(a.breathePeriodMs).toBe(5200);
  });

  it("睡眠呼吸明显慢于清醒", () => {
    const awake = appearanceFor(st({ doing: "editing", tempo: "normal" }));
    const sleep = appearanceFor(st({ doing: "away", tempo: "resting" }));
    expect(sleep.breathePeriodMs).toBeGreaterThan(awake.breathePeriodMs);
  });
});

d("状态描述文字", () => {
  it("覆盖核心状态组合", () => {
    expect(label(st({ doing: "editing", tempo: "stuck" }))).toBe("编辑器 · 卡住了");
    expect(label(st({ doing: "away", tempo: "resting" }))).toBe("离开 · 歇着");
    expect(
      label(st({ doing: "editing", tempo: "flow", late_night: true })),
    ).toBe("编辑器 · 进入状态 · 深夜");
  });

  it("不预设主人的工种", () => {
    // 主人未必在写代码 —— 描述文字只说在做什么，不替他定义职业
    const text = [
      st({ doing: "editing", tempo: "flow" }),
      st({ doing: "browsing", tempo: "normal" }),
      st({ doing: "other", tempo: "resting" }),
    ]
      .map(label)
      .join(" / ");
    for (const bad of ["写代码", "写码", "代码", "编程"]) {
      expect(text).not.toContain(bad);
    }
  });

  it("不同的事有不同的说法", () => {
    // 「根据正在做的事交互」的前端侧：九种事应有九种标签
    const labels = (["editing", "writing", "designing", "data", "messaging",
      "browsing", "watching", "other", "away"] as const).map((doing) =>
      label(st({ doing, tempo: "normal" })),
    );
    expect(new Set(labels).size).toBe(labels.length);
  });
});
