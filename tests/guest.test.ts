import { describe, expect, it } from "vitest";
import { avatarForUid, followStep, GuestPet } from "../src/guest/guest-pet";
import { GuestRegistry } from "../src/guest";

/** 绘制函数只需要一个「方法都能调用」的空壳，测试不校验像素。 */
function fakeCtx(): CanvasRenderingContext2D {
  return new Proxy(
    {},
    {
      get: () => () => {},
      set: () => true,
    },
  ) as unknown as CanvasRenderingContext2D;
}

function fakeCanvas(): HTMLCanvasElement {
  return { width: 1440, height: 900 } as HTMLCanvasElement;
}

const seed = { uid: "12345678", nick: "汤圆", pet_name: "小团子" };

describe("访客形象", () => {
  it("同一个 uid 每次都长一样", () => {
    // 服务端只下发 uid，形象靠 uid 确定性生成 ——
    // 不稳定会让同一只宠物每次来串门都换个样子
    expect(avatarForUid("12345678")).toEqual(avatarForUid("12345678"));
  });

  it("不同 uid 大概率不一样", () => {
    const a = avatarForUid("12345678");
    const b = avatarForUid("87654321");
    const key = (x: typeof a) => `${x.shape}/${x.eyeStyle}/${x.bodyColor}`;
    expect(key(a)).not.toBe(key(b));
  });
});

describe("访客宠物", () => {
  it("命中框与设定体型一致", () => {
    const g = new GuestPet(seed, {
      x: 100, y: 600, side: 64, nowMs: 0, index: 0, host: () => null,
    });
    expect(g.body).toEqual({ x: 100, y: 600, w: 64, h: 64 });
  });

  it("离场走出屏幕后才判定为可移除", () => {
    const ctx = fakeCtx();
    const g = new GuestPet(seed, {
      x: 100, y: 600, side: 64, nowMs: 0, index: 0, host: () => null,
    });
    expect(g.gone).toBe(false);

    g.leave(1000, 1440);
    expect(g.isLeaving).toBe(true);
    expect(g.gone).toBe(false); // 刚起步，还在往屏幕外走

    g.tick(1000 + 1300, ctx, { width: 1440, height: 900 });
    expect(g.gone).toBe(true); // 走出去了
  });

  it("只有在动的时候才要求高帧率", () => {
    // 访客站着发呆时，主循环不该为它抬帧 —— CPU 红线
    const g = new GuestPet(seed, {
      x: 100, y: 600, side: 64, nowMs: 0, index: 0, host: () => null,
    });
    expect(g.isBusy).toBe(false);
    g.leave(0, 1440);
    expect(g.isBusy).toBe(true); // 离场途中需要抬帧
  });
});

describe("访客注册表", () => {
  it("按名单增删，且不超过三只", () => {
    const reg = new GuestRegistry(fakeCtx(), fakeCanvas(), 64, () => null);
    const many = [1, 2, 3, 4, 5].map((i) => ({
      uid: `1000000${i}`,
      nick: `n${i}`,
      pet_name: `p${i}`,
    }));
    const { arrived } = reg.sync(many, 0);
    expect(arrived.length).toBe(3);
    expect(reg.list.length).toBe(3);
  });

  it("名单变短时剩下的开始离场", () => {
    const reg = new GuestRegistry(fakeCtx(), fakeCanvas(), 64, () => null);
    reg.sync(
      [
        { uid: "10000001", nick: "a", pet_name: "a" },
        { uid: "10000002", nick: "b", pet_name: "b" },
      ],
      0,
    );
    const { left } = reg.sync([{ uid: "10000001", nick: "a", pet_name: "a" }], 100);
    expect(left.length).toBe(1);
    expect(left[0].seed.uid).toBe("10000002");
  });

  it("命中框逐个给出，不合并", () => {
    const reg = new GuestRegistry(fakeCtx(), fakeCanvas(), 64, () => null);
    reg.sync(
      [
        { uid: "10000001", nick: "a", pet_name: "a" },
        { uid: "10000002", nick: "b", pet_name: "b" },
      ],
      0,
    );
    // 穿透上报要的是数组：合并成并集会误拦截下面编辑器的点击
    expect(reg.bodies.length).toBe(2);
  });

  it("空名单时先淡出，走完才真的清空", () => {
    const reg = new GuestRegistry(fakeCtx(), fakeCanvas(), 64, () => null);
    reg.sync([{ uid: "10000001", nick: "a", pet_name: "a" }], 0);
    const { left } = reg.sync([], 100);
    expect(left.length).toBe(1);
    // 还在往屏幕外走 —— 屏幕上仍然有它，不能立刻消失
    expect(reg.isEmpty).toBe(false);
    reg.tick(100 + 1300); // 离场走完 1200ms
    expect(reg.isEmpty).toBe(true);
  });
});

describe("摸摸（本地先行计数）", () => {
  it("三下成功，第四下拒绝并给文案", () => {
    const g = new GuestPet(seed, { x: 100, y: 600, side: 64, nowMs: 0, index: 0, host: () => null });
    expect(g.pat(1000)).toBeNull();
    expect(g.pat(1100)).toBeNull();
    expect(g.pat(1200)).toBeNull();
    expect(g.pat(1300)).toBe("摸够啦");
  });

  it("离场中的访客不可摸", () => {
    const g = new GuestPet(seed, { x: 100, y: 600, side: 64, nowMs: 0, index: 0, host: () => null });
    g.leave(0, 1440);
    expect(g.pat(100)).toBe("TA 正在回家");
  });

  it("命中判定从后往前找，离场中不算，空白处为 null", () => {
    const reg = new GuestRegistry(fakeCtx(), fakeCanvas(), 64, () => null);
    reg.sync(
      [
        { uid: "10000001", nick: "a", pet_name: "a" },
        { uid: "10000002", nick: "b", pet_name: "b" },
      ],
      0,
    );
    // host 为 null → 走旧槽位比例出生（0.28 / 0.5）
    const g1 = reg.list[0];
    expect(reg.hit(g1.body.x + 1, g1.body.y + 1)?.seed.uid).toBe(g1.seed.uid);
    expect(reg.hit(-10, -10)).toBeNull();
  });
});

describe("伙伴式跟随判定（followStep）", () => {
  it("主人不在家 → 不跟", () => {
    expect(followStep(100, null, -77, 64, 1440)).toBeNull();
  });

  it("距离在 1.5 身位内 → 原地待着", () => {
    // 目标左上角 x = 1000 - 77 - 32 = 891，距我 900 只差 9（≤ 96）
    expect(followStep(900, 1000, -77, 64, 1440)).toBeNull();
  });

  it("距离超过阈值 → 追向目标位（host 中心 + 偏移 - 半身）", () => {
    // 目标 = 1000 - 77 - 32 = 891
    expect(followStep(100, 1000, -77, 64, 1440)).toBe(891);
    expect(followStep(1400, 1000, -77, 64, 1440)).toBe(891);
  });

  it("目标位被钳制在屏幕内", () => {
    // 左侧：5 - 77 - 32 = -104 → 0
    expect(followStep(400, 5, -77, 64, 1440)).toBe(0);
    // 右侧：1435 + 77 - 32 = 1480 → 1440-64
    expect(followStep(100, 1435, 77, 64, 1440)).toBe(1440 - 64);
  });
});

describe("伙伴式跟随（GuestPet）", () => {
  it("主宠物在右侧：访客从左缘走进，停在一旁并对齐脚线", () => {
    const ctx = fakeCtx();
    const host = { x: 1000, y: 836, w: 64, h: 64 };
    const g = new GuestPet(seed, {
      x: 0, y: 836, side: 64, nowMs: 0, index: 0, host: () => host,
    });
    expect(g.isBusy).toBe(false); // 出发前待机
    // 目标位（访客左上角 x）= 主宠物中心 1032 - 1.2 身位 - 半身 ≈ 923
    const want = host.x + host.w / 2 - 1.2 * 64 - 64 / 2;
    let now = 0;
    let arrived = -1;
    for (let i = 0; i < 600 && arrived < 0; i++) {
      now += 50;
      g.tick(now, ctx, { width: 1440, height: 900 });
      if (Math.abs(g.body.x - want) <= 96) arrived = i;
    }
    expect(arrived).toBeGreaterThanOrEqual(0); // 真的走过去了
    // 到位后下一拍：placeAt 重锚 + 脚线对齐 + 回待机
    g.tick(now + 50, ctx, { width: 1440, height: 900 });
    expect(Math.abs(g.body.x - want)).toBeLessThanOrEqual(96); // 停在主宠物身旁
    expect(g.body.y).toBe(836); // 脚线对齐（y = host.y + host.h - side）
    expect(g.isBusy).toBe(false); // 就位后不再要求高帧率（CPU 红线）
  });

  it("index 1 的访客目标在主宠物右侧（正偏移）", () => {
    // 目标 = 232 + 76.8 - 32 = 276.8
    expect(followStep(1200, 232, 1.2 * 64, 64, 1440)).toBeCloseTo(232 + 76.8 - 32, 5);
  });
});
