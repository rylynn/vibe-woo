import { describe as d, expect, it } from "vitest";
import {
  Behavior,
  type BehaviorInput,
  type Motion,
} from "../src/anim/behavior";
import type { ActionStyle } from "../src/avatar/types";

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const INPUT: Omit<BehaviorInput, "dt"> = {
  bounds: { width: 1440, height: 900 },
  side: 96,
  held: false,
  asleep: false,
  scope: "nearby",
};

/** 统计若干秒模拟内各待机小动作的「触发沿」次数（idle→动作的跳变）。 */
function countActs(style: ActionStyle | null, seed: number, seconds = 400) {
  const b = new Behavior(700, 600, mulberry32(seed));
  if (style !== null) b.setActionStyle(style);
  let prev: Motion = "idle";
  const counts = { hop: 0, lookaround: 0, stretch: 0 };
  const steps = Math.floor(seconds / 0.1);
  for (let i = 0; i < steps; i++) {
    const s = b.update({ ...INPUT, dt: 0.1 });
    if (prev !== s.motion) {
      if (s.motion === "hop") counts.hop++;
      if (s.motion === "lookaround") counts.lookaround++;
      if (s.motion === "stretch") counts.stretch++;
    }
    prev = s.motion;
  }
  return counts;
}

d("动作风格对待机小动作的权重", () => {
  it("bouncy 明显更爱跳", () => {
    const bouncy = countActs("bouncy", 7);
    const calm = countActs("calm", 7);
    expect(bouncy.hop).toBeGreaterThan(calm.hop * 1.5);
  });

  it("curious 明显更爱张望", () => {
    const curious = countActs("curious", 7);
    const calm = countActs("calm", 7);
    expect(curious.lookaround).toBeGreaterThan(calm.lookaround * 1.5);
  });

  it("calm 以伸懒腰为主，安静不闹腾", () => {
    const calm = countActs("calm", 7);
    expect(calm.stretch).toBeGreaterThan(calm.hop);
    expect(calm.stretch).toBeGreaterThan(calm.lookaround);
  });

  it("未设置风格时保持旧的均匀随机（回归保护）", () => {
    const counts = countActs(null, 7);
    // 均匀随机下三种动作都会出现，且没有哪一种被压制到接近零
    expect(counts.hop).toBeGreaterThan(5);
    expect(counts.lookaround).toBeGreaterThan(5);
    expect(counts.stretch).toBeGreaterThan(5);
  });

  it("多种子下权重排序稳定（非单种子巧合）", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const bouncy = countActs("bouncy", seed);
      const curious = countActs("curious", seed);
      expect(bouncy.hop).toBeGreaterThan(curious.hop);
      expect(curious.lookaround).toBeGreaterThan(bouncy.lookaround);
    }
  });
});
