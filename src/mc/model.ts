// src/mc/model.ts
/**
 * MC 盒模型：长方体骨架 + 皮肤 UV 映射。
 *
 * 模型空间：x 向右、y 向上（原点在脚底中线）、z 朝观察者；
 * 单位 = 皮肤贴图像素。玩家用 MC 标准模型与标准 64×64 UV 布局，
 * 任意符合规范的皮肤都能直接套用。
 *
 * 坐标/尺寸全部取偶数：投影按 1.5m px/单位缩放，偶数保证整数顶点
 * （见 project.ts 头注）。boxes 顺序即 painter 排序的同深度平手序。
 */

/** MC 形态种类。M1 只有玩家；cat/dog 在 M3 加入。 */
export type McForm = "player";

/** 皮肤贴图上的源矩形（64×64 坐标系）。 */
export interface McTexRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/**
 * 一个盒子的三个可见面（本投影恒定露出正面/顶面/x=min 侧面）
 * 及可选 overlay 层（帽衫/外套/袖裤，空贴图运行时按像素跳过）。
 * 「left」= x=min 面：右肢上是外侧贴图，左肢上是内侧贴图。
 */
export interface McBoxFaceSet {
  front: McTexRect;
  top: McTexRect;
  left: McTexRect;
  /** 底面贴图（举臂后顶面朝上露出手底；仅双臂声明）。 */
  bottom?: McTexRect;
  overlay?: { front: McTexRect; top: McTexRect; left: McTexRect };
}

export interface McBox {
  name: string;
  /** 包围盒最小角（模型空间，偶数）。 */
  min: [number, number, number];
  /** 尺寸 [w, h, d]（偶数）。 */
  size: [number, number, number];
  faces: McBoxFaceSet;
}

export interface McModel {
  form: McForm;
  boxes: McBox[];
}

export const MC_SKIN_SIZE = 64;

/** 玩家标准模型（头 8×8×8、躯干 8×12×4、四肢 4×12×4）。 */
export const PLAYER_MODEL: McModel = {
  form: "player",
  boxes: [
    {
      name: "right-arm",
      min: [-8, 12, -2],
      size: [4, 12, 4],
      faces: {
        front: { sx: 44, sy: 20, sw: 4, sh: 12 },
        top: { sx: 44, sy: 16, sw: 4, sh: 4 },
        left: { sx: 40, sy: 20, sw: 4, sh: 12 },
        bottom: { sx: 48, sy: 16, sw: 4, sh: 4 },
        overlay: {
          front: { sx: 44, sy: 36, sw: 4, sh: 12 },
          top: { sx: 44, sy: 32, sw: 4, sh: 4 },
          left: { sx: 40, sy: 36, sw: 4, sh: 12 },
        },
      },
    },
    {
      name: "left-arm",
      min: [4, 12, -2],
      size: [4, 12, 4],
      faces: {
        front: { sx: 36, sy: 52, sw: 4, sh: 12 },
        top: { sx: 36, sy: 48, sw: 4, sh: 4 },
        left: { sx: 40, sy: 52, sw: 4, sh: 12 },
        bottom: { sx: 40, sy: 48, sw: 4, sh: 4 },
        overlay: {
          front: { sx: 52, sy: 52, sw: 4, sh: 12 },
          top: { sx: 52, sy: 48, sw: 4, sh: 4 },
          left: { sx: 56, sy: 52, sw: 4, sh: 12 },
        },
      },
    },
    {
      name: "right-leg",
      min: [-4, 0, -2],
      size: [4, 12, 4],
      faces: {
        front: { sx: 4, sy: 20, sw: 4, sh: 12 },
        top: { sx: 4, sy: 16, sw: 4, sh: 4 },
        left: { sx: 0, sy: 20, sw: 4, sh: 12 },
        overlay: {
          front: { sx: 4, sy: 36, sw: 4, sh: 12 },
          top: { sx: 4, sy: 32, sw: 4, sh: 4 },
          left: { sx: 0, sy: 36, sw: 4, sh: 12 },
        },
      },
    },
    {
      name: "left-leg",
      min: [0, 0, -2],
      size: [4, 12, 4],
      faces: {
        front: { sx: 20, sy: 52, sw: 4, sh: 12 },
        top: { sx: 20, sy: 48, sw: 4, sh: 4 },
        left: { sx: 24, sy: 52, sw: 4, sh: 12 },
        overlay: {
          front: { sx: 4, sy: 40, sw: 4, sh: 12 },
          top: { sx: 4, sy: 36, sw: 4, sh: 4 },
          left: { sx: 8, sy: 40, sw: 4, sh: 12 },
        },
      },
    },
    {
      name: "body",
      min: [-4, 12, -2],
      size: [8, 12, 4],
      faces: {
        front: { sx: 20, sy: 20, sw: 8, sh: 12 },
        top: { sx: 20, sy: 16, sw: 8, sh: 4 },
        left: { sx: 16, sy: 20, sw: 4, sh: 12 },
        overlay: {
          front: { sx: 20, sy: 36, sw: 8, sh: 12 },
          top: { sx: 20, sy: 32, sw: 8, sh: 4 },
          left: { sx: 16, sy: 36, sw: 4, sh: 12 },
        },
      },
    },
    {
      name: "head",
      min: [-4, 24, -4],
      size: [8, 8, 8],
      faces: {
        front: { sx: 8, sy: 8, sw: 8, sh: 8 },
        top: { sx: 8, sy: 0, sw: 8, sh: 8 },
        left: { sx: 0, sy: 8, sw: 8, sh: 8 },
        overlay: {
          front: { sx: 40, sy: 8, sw: 8, sh: 8 },
          top: { sx: 40, sy: 0, sw: 8, sh: 8 },
          left: { sx: 32, sy: 8, sw: 8, sh: 8 },
        },
      },
    },
  ],
};

/** 按形态取模型；未知形态抛错（M3 前调用方类型上不可能传非 player）。 */
export function modelForForm(form: McForm): McModel {
  if (form === "player") return PLAYER_MODEL;
  throw new Error(`未知 MC 形态: ${form}`);
}
