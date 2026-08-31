import { describe as d, expect, it } from "vitest";
import {
  avatarFromView,
  avatarToView,
  DEFAULT_AVATAR,
  type PetAvatar,
} from "../src/avatar/types";

const AVATAR: PetAvatar = {
  shape: "round",
  eyeStyle: "big",
  browStyle: "flat",
  actionStyle: "bouncy",
  bodyColor: "#A85232",
  accentColor: "#FFE066",
  attachment: "ears",
  pattern: "stripes",
  secondaryColor: "#7A3B22",
};

d("形象的 IPC 视图转换", () => {
  it("转出的键为 snake_case（与 Rust serde 输出对齐）", () => {
    const v = avatarToView(AVATAR);
    expect(v).toEqual({
      shape: "round",
      eye_style: "big",
      brow_style: "flat",
      action_style: "bouncy",
      body_color: "#A85232",
      accent_color: "#FFE066",
      attachment: "ears",
      pattern: "stripes",
      secondary_color: "#7A3B22",
    });
  });

  it("往返转换保持相等", () => {
    expect(avatarFromView(avatarToView(AVATAR))).toEqual(AVATAR);
  });

  it("特征件与纹理的 kebab-case 取值与 Rust 枚举对齐", () => {
    const v = avatarToView({ ...AVATAR, attachment: "pointy-ears" });
    expect(v.attachment).toBe("pointy-ears");
  });
});

d("默认形象", () => {
  it("默认无特征件无纹理（旧外观像素级不变）", () => {
    expect(DEFAULT_AVATAR.attachment).toBe("none");
    expect(DEFAULT_AVATAR.pattern).toBe("none");
    expect(DEFAULT_AVATAR.secondaryColor).toBe("");
  });
});
