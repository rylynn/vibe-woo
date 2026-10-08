/**
 * 宠物形象参数模型。
 *
 * 形象层（本目录）与状态层（appearance.ts）正交：
 * 形象决定「长相」——形状/眼风/眉型/基色/动作偏好，由用户选定后基本不变；
 * 状态层决定「情绪」——眼型/色调/呼吸节奏，由 Rust 传感器实时驱动。
 * 两者在渲染管线末端合成（见 pet.ts draw）。
 *
 * 字段名与 Rust 端 AvatarConfig 的 serde 序列化保持对齐（snake_case 由
 * serde rename_all 处理），任何改动需同步 config.rs。
 */

import type { McForm } from "../mc/model";

/** 身体形状。 */
export type BodyShape =
  | "box"
  | "round"
  | "blob"
  | "tall"
  | "wide"
  /** 蘑菇：底宽顶窄。 */
  | "shroom"
  /** 水滴：顶圆尖、底饱满。 */
  | "drop";

/** 特征件：画在身体上沿的轮廓特征（从图片轮廓的顶部凸起识别）。 */
export type Attachment =
  | "none"
  /** 圆耳（熊/鼠）：顶部两个矮宽凸起。 */
  | "ears"
  /** 尖耳（猫）：顶部两个高窄凸起。 */
  | "pointy-ears"
  /** 角：顶部两侧尖锥。 */
  | "horns"
  /** 触角：居中细杆顶珠。 */
  | "antenna";

/** 身体颜色纹理（从图片双主色的空间分布识别）。 */
export type Pattern =
  | "none"
  /** 条纹：次色按行聚集。 */
  | "stripes"
  /** 斑点：次色分散分布。 */
  | "spots";

/** 眼睛风格（长相维度：宽高比/间距/高光模式），与 EyeShape（表情维度）正交。 */
export type EyeStyle = "classic" | "big" | "dot" | "almond" | "sleepy";

/** 眉毛风格。 */
export type BrowStyle = "none" | "flat" | "slanted" | "arched" | "bushy";

/** 动作风格：待机动作（hop/stretch/lookaround）的触发偏好。 */
export type ActionStyle = "calm" | "bouncy" | "curious";

export interface ParametricAvatar {
  /** 形象体系判别：缺省（旧数据/旧构造）= parametric。 */
  kind?: "parametric";
  shape: BodyShape;
  eyeStyle: EyeStyle;
  browStyle: BrowStyle;
  actionStyle: ActionStyle;
  /** 身体基色 #RRGGBB，状态色调（focused/dim）在此之上变换。 */
  bodyColor: string;
  /** 点缀色 #RRGGBB，用于高光/眉毛，与基色满足协调约束且更亮。 */
  accentColor: string;
  /** 特征件，默认 none。 */
  attachment: Attachment;
  /** 身体纹理，默认 none。 */
  pattern: Pattern;
  /** 次色 #RRGGBB（纹理用色）；空串表示无（pattern=none 时）。 */
  secondaryColor: string;
}

/** MC 形态形象：体素盒模型 + 皮肤（skinId 指向皮肤注册表/库）。 */
export interface McAvatar {
  kind: "minecraft";
  form: McForm;
  skinId: string;
}

/** 宠物形象：参数化像素画（默认）或 MC 体素形态。 */
export type PetAvatar = ParametricAvatar | McAvatar;

export function isMcAvatar(a: PetAvatar): a is McAvatar {
  return a.kind === "minecraft";
}

/** MC 形态兜底为默认参数形象（渲染分流前的过渡 + 旧版本行为）。 */
export function asParametric(a: PetAvatar): ParametricAvatar {
  return isMcAvatar(a) ? DEFAULT_AVATAR : a;
}

export const BODY_SHAPES: BodyShape[] = [
  "box",
  "round",
  "blob",
  "tall",
  "wide",
  "shroom",
  "drop",
];
export const ATTACHMENTS: Attachment[] = [
  "none",
  "ears",
  "pointy-ears",
  "horns",
  "antenna",
];
export const PATTERNS: Pattern[] = ["none", "stripes", "spots"];
export const EYE_STYLES: EyeStyle[] = ["classic", "big", "dot", "almond", "sleepy"];
export const BROW_STYLES: BrowStyle[] = ["none", "flat", "slanted", "arched", "bushy"];
export const ACTION_STYLES: ActionStyle[] = ["calm", "bouncy", "curious"];

/**
 * IPC 传输形态：与 Rust 端 AvatarConfig（untagged 枚举）的 serde 输出对齐
 * （snake_case、无判别字段——untagged 序列化内联变体）。渲染层统一用
 * PetAvatar（camelCase），边界处用下面两个函数转换。
 */
export interface ParametricConfigView {
  shape: BodyShape;
  eye_style: EyeStyle;
  brow_style: BrowStyle;
  action_style: ActionStyle;
  body_color: string;
  accent_color: string;
  attachment: Attachment;
  pattern: Pattern;
  secondary_color: string;
}

/** MC 形态的传输形态（Rust McAvatarConfig 内联输出）。 */
export interface McConfigView {
  form: McForm;
  skin_id: string;
}

export type AvatarConfigView = ParametricConfigView | McConfigView;

/** Rust 不发判别字段，结构判别：MC 变体必带 skin_id。 */
export function isMcConfigView(v: AvatarConfigView): v is McConfigView {
  return "skin_id" in v;
}

export function avatarToView(a: PetAvatar): AvatarConfigView {
  if (isMcAvatar(a)) return { form: a.form, skin_id: a.skinId };
  return {
    shape: a.shape,
    eye_style: a.eyeStyle,
    brow_style: a.browStyle,
    action_style: a.actionStyle,
    body_color: a.bodyColor,
    accent_color: a.accentColor,
    attachment: a.attachment,
    pattern: a.pattern,
    secondary_color: a.secondaryColor,
  };
}

export function avatarFromView(v: AvatarConfigView): PetAvatar {
  if (isMcConfigView(v)) {
    return { kind: "minecraft", form: v.form, skinId: v.skin_id };
  }
  return {
    shape: v.shape,
    eyeStyle: v.eye_style,
    browStyle: v.brow_style,
    actionStyle: v.action_style,
    bodyColor: v.body_color,
    accentColor: v.accent_color,
    attachment: v.attachment,
    pattern: v.pattern,
    secondaryColor: v.secondary_color,
  };
}

/** 未选择形象时的默认外观（现状矩形+经典眼的延续，配色与旧常量一致）。 */
export const DEFAULT_AVATAR: ParametricAvatar = {
  shape: "box",
  eyeStyle: "classic",
  browStyle: "none",
  actionStyle: "calm",
  bodyColor: "#7CF5C4",
  accentColor: "#E8FFF6",
  attachment: "none",
  pattern: "none",
  secondaryColor: "",
};
