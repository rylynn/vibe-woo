import { describe, expect, it } from "vitest";
import {
  DEFAULT_AVATAR,
  asParametric,
  avatarFromView,
  avatarToView,
  isMcAvatar,
  type PetAvatar,
} from "../src/avatar/types";

describe("PetAvatar 判别联合", () => {
  it("parametric 字面量不写 kind 依然合法（旧代码零改动）", () => {
    const a: PetAvatar = { ...DEFAULT_AVATAR };
    expect(isMcAvatar(a)).toBe(false);
  });

  it("minecraft 形态识别与兜底", () => {
    const mc: PetAvatar = { kind: "minecraft", form: "player", skinId: "builtin:default" };
    expect(isMcAvatar(mc)).toBe(true);
    expect(isMcAvatar({ ...DEFAULT_AVATAR })).toBe(false);
    // 兜底：MC 形态在未接渲染前显示默认参数形象
    expect(asParametric(mc)).toBe(DEFAULT_AVATAR);
    expect(asParametric({ ...DEFAULT_AVATAR })).toEqual(DEFAULT_AVATAR);
  });

  it("avatarToView/FromView 只收参数形象（view 层暂无 MC 字段）", () => {
    const v = avatarToView(DEFAULT_AVATAR);
    expect(avatarFromView(v)).toEqual(DEFAULT_AVATAR);
  });
});
