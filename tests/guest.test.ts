import { describe, expect, it } from "vitest";
import { avatarForUid, GuestPet } from "../src/guest/guest-pet";
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
    const g = new GuestPet(seed, { x: 100, y: 600, side: 64, nowMs: 0, index: 0 });
    expect(g.body).toEqual({ x: 100, y: 600, w: 64, h: 64 });
  });

  it("离场走出屏幕后才判定为可移除", () => {
    const ctx = fakeCtx();
    const g = new GuestPet(seed, { x: 100, y: 600, side: 64, nowMs: 0, index: 0 });
    expect(g.gone).toBe(false);

    g.leave(1000, 1440);
    expect(g.isLeaving).toBe(true);
    expect(g.gone).toBe(false); // 刚起步，还在往屏幕外走

    g.tick(1000 + 1300, ctx, { width: 1440, height: 900 });
    expect(g.gone).toBe(true); // 走出去了
  });

  it("只有在动的时候才要求高帧率", () => {
    // 访客站着发呆时，主循环不该为它抬帧 —— CPU 红线
    const g = new GuestPet(seed, { x: 100, y: 600, side: 64, nowMs: 0, index: 0 });
    expect(g.isBusy).toBe(false);
    g.leave(0, 1440);
    expect(g.isBusy).toBe(true); // 离场途中需要抬帧
  });
});

describe("访客注册表", () => {
  it("按名单增删，且不超过三只", () => {
    const reg = new GuestRegistry(fakeCtx(), fakeCanvas(), 64);
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
    const reg = new GuestRegistry(fakeCtx(), fakeCanvas(), 64);
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
    const reg = new GuestRegistry(fakeCtx(), fakeCanvas(), 64);
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
    const reg = new GuestRegistry(fakeCtx(), fakeCanvas(), 64);
    reg.sync([{ uid: "10000001", nick: "a", pet_name: "a" }], 0);
    const { left } = reg.sync([], 100);
    expect(left.length).toBe(1);
    // 还在往屏幕外走 —— 屏幕上仍然有它，不能立刻消失
    expect(reg.isEmpty).toBe(false);
    reg.tick(100 + 1300); // 离场走完 1200ms
    expect(reg.isEmpty).toBe(true);
  });
});
