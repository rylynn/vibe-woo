import { describe, expect, it } from "vitest";
import {
  DEFAULT_AVATAR,
  asParametric,
  avatarFromView,
  avatarToView,
  isMcAvatar,
  isMcConfigView,
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

  it("avatarToView/FromView 双向联合往返（参数 | MC）", () => {
    // 参数分支：往返不变，且不产出 MC 字段
    const p = avatarToView(DEFAULT_AVATAR);
    expect(isMcConfigView(p)).toBe(false);
    expect(avatarFromView(p)).toEqual(DEFAULT_AVATAR);
    // MC 分支：skinId ↔ skin_id 转换，往返还原
    const mc: PetAvatar = { kind: "minecraft", form: "cat", skinId: "builtin:cat" };
    const v = avatarToView(mc);
    expect(v).toEqual({ form: "cat", skin_id: "builtin:cat" });
    expect(isMcConfigView(v)).toBe(true);
    expect(avatarFromView(v)).toEqual(mc);
  });
});
