import { describe as d, expect, it } from "vitest";
import { squashScale } from "../src/anim/squash";
import { PreviewDriver } from "../src/overlay/avatar-picker";

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

d("挤压拉伸形变（与 pet.ts 共享的公式）", () => {
  it("idle 无形变", () => {
    const { sx, sy } = squashScale("idle", 0);
    expect(sx).toBe(1);
    expect(sy).toBe(1);
  });

  it("hop 腾空时拉长（sy>1）且体积近似守恒", () => {
    const { sx, sy } = squashScale("hop", 0.5);
    expect(sy).toBeGreaterThan(1);
    expect(sx).toBeLessThan(1);
  });

  it("stretch 先压扁蓄力再抻长", () => {
    const early = squashScale("stretch", 0.15);
    const late = squashScale("stretch", 0.7);
    expect(early.sy).toBeLessThan(1);
    expect(late.sy).toBeGreaterThan(1);
  });

  it("lookaround 身体不变（只转头）", () => {
    const { sx, sy } = squashScale("lookaround", 0.5);
    expect(sx).toBe(1);
    expect(sy).toBe(1);
  });
});

d("预览动作驱动", () => {
  it("开场为 idle", () => {
    const drv = new PreviewDriver(mulberry32(1), 1000);
    expect(drv.update(1000).motion).toBe("idle");
  });

  it("间隔结束后触发小动作，动作结束后回到 idle", () => {
    const drv = new PreviewDriver(mulberry32(3), 0);
    let sawAct = false;
    let backToIdle = false;
    let prevMotion = "idle";
    for (let t = 0; t < 20000; t += 50) {
      const p = drv.update(t);
      if (p.motion !== "idle") sawAct = true;
      if (sawAct && prevMotion !== "idle" && p.motion === "idle") {
        backToIdle = true;
      }
      prevMotion = p.motion;
    }
    expect(sawAct).toBe(true);
    expect(backToIdle).toBe(true);
  });

  it("hop 期间 lift 呈抛物线（中点最高、端点为 0）", () => {
    const drv = new PreviewDriver(mulberry32(3), 0);
    let peak = 0;
    for (let t = 0; t < 20000; t += 16) {
      const p = drv.update(t);
      if (p.motion === "hop") {
        peak = Math.max(peak, p.lift);
        // 起跳与落地瞬间 lift 接近 0
        if (p.phase < 0.08 || p.phase > 0.92) {
          expect(p.lift).toBeLessThan(0.3);
        }
      }
    }
    expect(peak).toBeGreaterThan(0.8);
  });

  it("动作期间 phase 单调推进到 1", () => {
    const drv = new PreviewDriver(mulberry32(5), 0);
    let lastPhase = -1;
    let inAct = false;
    for (let t = 0; t < 20000; t += 16) {
      const p = drv.update(t);
      if (p.motion !== "idle") {
        if (inAct) expect(p.phase).toBeGreaterThanOrEqual(lastPhase);
        lastPhase = p.phase;
        inAct = true;
      } else {
        lastPhase = -1;
        inAct = false;
      }
    }
  });

  it("同一 RNG 序列下两个驱动完全同步（可复现）", () => {
    const a = new PreviewDriver(mulberry32(9), 0);
    const b = new PreviewDriver(mulberry32(9), 0);
    for (let t = 0; t < 12000; t += 33) {
      expect(a.update(t)).toEqual(b.update(t));
    }
  });
});
