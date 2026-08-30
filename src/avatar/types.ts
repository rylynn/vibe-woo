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

/** 身体形状。 */
export type BodyShape = "box" | "round" | "blob" | "tall" | "wide";

/** 眼睛风格（长相维度：宽高比/间距/高光模式），与 EyeShape（表情维度）正交。 */
export type EyeStyle = "classic" | "big" | "dot" | "almond" | "sleepy";

/** 眉毛风格。 */
export type BrowStyle = "none" | "flat" | "slanted" | "arched" | "bushy";

/** 动作风格：待机动作（hop/stretch/lookaround）的触发偏好。 */
export type ActionStyle = "calm" | "bouncy" | "curious";

export interface PetAvatar {
  shape: BodyShape;
  eyeStyle: EyeStyle;
  browStyle: BrowStyle;
  actionStyle: ActionStyle;
  /** 身体基色 #RRGGBB，状态色调（focused/dim）在此之上变换。 */
  bodyColor: string;
  /** 点缀色 #RRGGBB，用于高光/眉毛，与基色满足协调约束且更亮。 */
  accentColor: string;
}

export const BODY_SHAPES: BodyShape[] = ["box", "round", "blob", "tall", "wide"];
export const EYE_STYLES: EyeStyle[] = ["classic", "big", "dot", "almond", "sleepy"];
export const BROW_STYLES: BrowStyle[] = ["none", "flat", "slanted", "arched", "bushy"];
export const ACTION_STYLES: ActionStyle[] = ["calm", "bouncy", "curious"];

/** 未选择形象时的默认外观（现状矩形+经典眼的延续）。 */
export const DEFAULT_AVATAR: PetAvatar = {
  shape: "box",
  eyeStyle: "classic",
  browStyle: "none",
  actionStyle: "calm",
  bodyColor: "#5CD4A8",
  accentColor: "#E8FFF4",
};
