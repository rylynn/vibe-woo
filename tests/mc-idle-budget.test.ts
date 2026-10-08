// tests/mc-idle-budget.test.ts
/**
 * MC 空闲跳帧预算（CPU <1% 红线的单测侧近似）：
 * still 档下姿态与眼部的量化档位绝大多数 tick 不变——帧指纹相同
 * 即整帧跳过、不触碰 canvas。若无跳帧，225 个 tick 会全部 drawImage。
 */
import { describe, expect, it } from "vitest";
import { Pet } from "../src/pet";
import { mcFrameKey, mcPose, type McTint } from "../src/mc/pose";
import { registerMcSkin } from "../src/mc/skin-registry";
import type { SkinData } from "../src/mc/skin";

/** 全不透明皮肤：最坏情况 overlay 全画（每个重绘帧 36 次 drawImage）。 */
function opaqueSkin(): SkinData {
  return { w: 64, h: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255) };
}

describe("MC 空闲跳帧预算", () => {
  it("still 档 9s：发生重绘的 tick 不到 55%（无跳帧将是 100%）", () => {
    const c = {} as CanvasImageSource;
    registerMcSkin("budget", {
      skin: opaqueSkin(),
      canvases: { normal: c, focused: c, dim: c } as Record<McTint, CanvasImageSource>,
    });
    let draws = 0;
    const ctx = {
      globalAlpha: 1,
      imageSmoothingEnabled: true,
      fillStyle: "",
      save() {},
      restore() {},
      setTransform() {},
      clearRect() {},
      drawImage: () => { draws++; },
      fillRect: () => {},
    } as unknown as CanvasRenderingContext2D;
    const canvas = { width: 1440, height: 900 } as HTMLCanvasElement;
    const pet = new Pet(canvas, ctx);
    pet.setAvatar({ kind: "minecraft", form: "player", skinId: "budget" });
    pet.setScope("still");
    pet.setActivity("active");

    let prev = draws;
    let drawnTicks = 0;
    let totalTicks = 0;
    for (let t = 40; t <= 9040; t += 40) {
      pet.tick(t);
      totalTicks++;
      if (draws > prev) drawnTicks++;
      prev = draws;
    }
    expect(draws).toBeGreaterThan(0); // 首帧 + 呼吸换档确实画了
    expect(drawnTicks).toBeLessThan(totalTicks * 0.55);
  });

  it("still 档 9s（猫）：跳帧预算同玩家——重绘 tick 不到 55%", () => {
    const c = {} as CanvasImageSource;
    registerMcSkin("budget-cat", {
      skin: opaqueSkin(),
      canvases: { normal: c, focused: c, dim: c } as Record<McTint, CanvasImageSource>,
    });
    let draws = 0;
    const ctx = {
      globalAlpha: 1,
      imageSmoothingEnabled: true,
      fillStyle: "",
      save() {},
      restore() {},
      setTransform() {},
      clearRect() {},
      drawImage: () => { draws++; },
      fillRect: () => {},
    } as unknown as CanvasRenderingContext2D;
    const canvas = { width: 1440, height: 900 } as HTMLCanvasElement;
    const pet = new Pet(canvas, ctx);
    pet.setAvatar({ kind: "minecraft", form: "cat", skinId: "budget-cat" });
    pet.setScope("still");
    pet.setActivity("active");

    let prev = draws;
    let drawnTicks = 0;
    let totalTicks = 0;
    for (let t = 40; t <= 9040; t += 40) {
      pet.tick(t);
      totalTicks++;
      if (draws > prev) drawnTicks++;
      prev = draws;
    }
    expect(draws).toBeGreaterThan(0);
    expect(drawnTicks).toBeLessThan(totalTicks * 0.55);
  });

  it.each(["cat", "dog"] as const)(
    "%s walk 9s 帧指纹基数有界：对角步 8 × 尾摆 8 × 呼吸 3 = 192",
    (form) => {
      const eye = { shape: "round", lid: 0, gazeX: 0, gazeY: 0 } as const;
      const keys = new Set<string>();
      for (let t = 0; t < 9000; t += 25) {
        const pose = mcPose({
          motion: "walk",
          actPhase: 0,
          facing: 1,
          nowMs: t,
          breathePeriodMs: 2400,
          asleep: false,
          gazeX: 0,
          gazeY: 0,
          tint: "normal",
          tired: false,
          form,
        });
        keys.add(mcFrameKey(pose, form, "s", eye, 10, 20, 1));
      }
      expect(keys.size).toBeLessThanOrEqual(8 * 8 * 3);
    },
  );
});
