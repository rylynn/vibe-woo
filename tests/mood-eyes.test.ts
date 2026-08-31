import { describe, expect, it } from "vitest";
import { MicroExpression, type ExprInput } from "../src/anim/expression";
import { appearanceFor, eyeShapeFor } from "../src/appearance";
import { DEFAULT_STATE, type PetState } from "../src/state";

function input(patch: Partial<ExprInput> = {}): ExprInput {
  return {
    asleep: false,
    stuck: false,
    flow: false,
    tired: false,
    poked: false,
    mood: null,
    gazeTarget: null,
    ...patch,
  };
}

function st(patch: Partial<PetState>): PetState {
  return { ...DEFAULT_STATE, ...patch };
}

describe("心情驱动眼型", () => {
  it("心满意足时是月牙眼", () => {
    const m = new MicroExpression();
    expect(m.update(0, input({ mood: "content" })).shape).toBe("happy");
  });

  it("烦躁时皱眉", () => {
    const m = new MicroExpression();
    expect(m.update(0, input({ mood: "frustrated" })).shape).toBe("worried");
  });

  it("无聊时眼皮耷拉", () => {
    const m = new MicroExpression();
    expect(m.update(0, input({ mood: "bored" })).shape).toBe("droopy");
  });

  it("心情优先于专注（情绪是更强的人格外显）", () => {
    const m = new MicroExpression();
    expect(m.update(0, input({ mood: "content", flow: true })).shape).toBe("happy");
  });

  it("睡眠始终优先于心情", () => {
    const m = new MicroExpression();
    expect(m.update(0, input({ mood: "content", asleep: true })).shape).toBe("closed");
  });
});

describe("心情影响眨眼节奏", () => {
  it("烦躁时眨眼明显更频繁", () => {
    const countBlinks = (mood: ExprInput["mood"]) => {
      const m = new MicroExpression(() => 0.5);
      let blinks = 0;
      let wasLid = false;
      for (let t = 0; t < 20000; t += 40) {
        const lid = m.update(t, input({ mood })).lid;
        if (lid > 0 && !wasLid) blinks++;
        wasLid = lid > 0;
      }
      return blinks;
    };
    expect(countBlinks("frustrated")).toBeGreaterThan(countBlinks(null));
  });

  it("无聊时眨眼明显更少", () => {
    const countBlinks = (mood: ExprInput["mood"]) => {
      const m = new MicroExpression(() => 0.5);
      let blinks = 0;
      let wasLid = false;
      for (let t = 0; t < 20000; t += 40) {
        const lid = m.update(t, input({ mood })).lid;
        if (lid > 0 && !wasLid) blinks++;
        wasLid = lid > 0;
      }
      return blinks;
    };
    expect(countBlinks("bored")).toBeLessThan(countBlinks(null));
  });
});

describe("心情与外观的联动", () => {
  it("心满意足时提到高帧率（情绪需要流畅表达）", () => {
    const a = appearanceFor(
      st({ doing: "editing", tempo: "normal", mood: "content" }),
    );
    expect(a.activity).toBe("active");
  });

  it("eyeShapeFor 与 appearanceFor 一致", () => {
    const s = st({ mood: "content" });
    expect(eyeShapeFor(s)).toBe("happy");
    expect(appearanceFor(s).mood).toBe("content");
  });
});
