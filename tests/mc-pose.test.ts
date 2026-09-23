// tests/mc-pose.test.ts
import { describe, expect, it } from "vitest";
import { breathStep, mcFrameKey, mcPose, mcRestPose } from "../src/mc/pose";
import type { EyeFrame } from "../src/anim/expression";

const REST_INPUT = {
  motion: "idle" as const,
  actPhase: 0,
  facing: 1,
  nowMs: 0,
  breathePeriodMs: 2400,
  asleep: false,
  gazeX: 0,
  gazeY: 0,
  tint: "normal" as const,
  tired: false,
};

const EYE: EyeFrame = { shape: "round", lid: 0, gazeX: 0, gazeY: 0 };

describe("mcRestPose", () => {
  it("全零常态", () => {
    expect(mcRestPose()).toEqual({
      headYaw: 0, headPitch: 0, limbPhase: 0, breath: 0,
      armsUp: false, armsSpread: false, lying: false,
      mirrored: false, tint: "normal", tired: false,
    });
  });
});

describe("breathStep", () => {
  it("2400ms 周期的三档（±0.33 阈值）", () => {
    expect(breathStep(0, 2400)).toBe(0);       // sin 0 = 0
    expect(breathStep(300, 2400)).toBe(1);     // sin(π/4) ≈ 0.71
    expect(breathStep(600, 2400)).toBe(1);     // sin(π/2) = 1
    expect(breathStep(1200, 2400)).toBe(0);    // sin(π) ≈ 0
    expect(breathStep(1500, 2400)).toBe(-1);   // sin(1.25π) ≈ -0.71
    expect(breathStep(1800, 2400)).toBe(-1);   // -1
  });
});

describe("mcPose", () => {
  it("idle：视线驱动头部转向，量化到 7 档并钳制", () => {
    expect(mcPose({ ...REST_INPUT, gazeX: 0.4 }).headYaw).toBe(1);
    expect(mcPose({ ...REST_INPUT, gazeX: -0.3 }).headYaw).toBe(-1);
    expect(mcPose({ ...REST_INPUT, gazeX: 1 }).headYaw).toBe(3);
    expect(mcPose({ ...REST_INPUT, gazeX: -1 }).headYaw).toBe(-3);
  });

  it("镜像（facing < 0）时 yaw 取反；俯仰 3 档", () => {
    expect(mcPose({ ...REST_INPUT, facing: -1, gazeX: 0.4 }).headYaw).toBe(-1);
    expect(mcPose({ ...REST_INPUT, gazeY: 0.6 }).headPitch).toBe(1);
    expect(mcPose({ ...REST_INPUT, gazeY: -0.6 }).headPitch).toBe(-1);
    expect(mcPose({ ...REST_INPUT, facing: -1 }).mirrored).toBe(true);
  });

  it("睡眠（asleep 或 motion=sleep）：躺平，只保留呼吸/色调/疲惫", () => {
    const p = mcPose({ ...REST_INPUT, nowMs: 600, asleep: true, tint: "dim", tired: true });
    expect(p.lying).toBe(true);
    expect(p.headYaw).toBe(0);
    expect(p.breath).toBe(1);
    expect(p.tint).toBe("dim");
    expect(p.tired).toBe(true);
    expect(mcPose({ ...REST_INPUT, motion: "sleep" }).lying).toBe(true);
  });

  it("walk：75ms/相位；held：250ms/相位", () => {
    expect(mcPose({ ...REST_INPUT, motion: "walk", nowMs: 0 }).limbPhase).toBe(0);
    expect(mcPose({ ...REST_INPUT, motion: "walk", nowMs: 75 }).limbPhase).toBe(1);
    expect(mcPose({ ...REST_INPUT, motion: "walk", nowMs: 155 }).limbPhase).toBe(2);
    expect(mcPose({ ...REST_INPUT, motion: "held", nowMs: 250 }).limbPhase).toBe(1);
  });

  it("hop 张臂；stretch 中段举臂；lookaround 左右扫视", () => {
    expect(mcPose({ ...REST_INPUT, motion: "hop" }).armsSpread).toBe(true);
    expect(mcPose({ ...REST_INPUT, motion: "stretch", actPhase: 0.1 }).armsUp).toBe(false);
    expect(mcPose({ ...REST_INPUT, motion: "stretch", actPhase: 0.5 }).armsUp).toBe(true);
    // 前半程看左（−3 于中点），后半程看右
    expect(mcPose({ ...REST_INPUT, motion: "lookaround", actPhase: 0.25 }).headYaw).toBe(-3);
    expect(mcPose({ ...REST_INPUT, motion: "lookaround", actPhase: 0.75 }).headYaw).toBe(3);
    expect(mcPose({ ...REST_INPUT, motion: "lookaround", actPhase: 0, facing: -1 }).headYaw).toBe(0);
  });

  it("呼吸档贯穿非睡眠动作", () => {
    expect(mcPose({ ...REST_INPUT, motion: "walk", nowMs: 600 }).breath).toBe(1);
  });
});

describe("mcFrameKey", () => {
  it("姿态或眼部量化任一变化则指纹变化；全同则相同", () => {
    const a = mcPose({ ...REST_INPUT });
    const same = mcPose({ ...REST_INPUT, gazeX: 0.1 }); // round(0.1*3)=0，同档
    const diff = mcPose({ ...REST_INPUT, gazeX: 0.4 }); // 档位 +1
    expect(mcFrameKey(a, "s", EYE, 10, 20, 1)).toBe(mcFrameKey(same, "s", EYE, 10, 20, 1));
    expect(mcFrameKey(a, "s", EYE, 10, 20, 1)).not.toBe(mcFrameKey(diff, "s", EYE, 10, 20, 1));
    expect(mcFrameKey(a, "s", EYE, 10, 20, 1)).not.toBe(mcFrameKey(a, "s", EYE, 11, 20, 1));
    const lids = { ...EYE, lid: 0.03 }; // round(0.03*16)=0，同档
    const lidDiff = { ...EYE, lid: 0.1 }; // round(0.1*16)=2
    expect(mcFrameKey(a, "s", lids, 10, 20, 1)).toBe(mcFrameKey(a, "s", EYE, 10, 20, 1));
    expect(mcFrameKey(a, "s", lidDiff, 10, 20, 1)).not.toBe(mcFrameKey(a, "s", EYE, 10, 20, 1));
  });
});
