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

/** MC 形态种类：玩家（标准皮肤）或猫/狗（内置骨架与贴图）。 */
export type McForm = "player" | "cat" | "dog";

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

/** 小尺寸三面组：2×2×2 盒（耳/尾节）。front/left/top 各 2×2。 */
function smallFaces(sx: number, sy: number): McBoxFaceSet {
  return {
    front: { sx, sy, sw: 2, sh: 2 },
    left: { sx: sx + 2, sy, sw: 2, sh: 2 },
    top: { sx: sx + 4, sy, sw: 2, sh: 2 },
  };
}

/** 腿盒三面组（2×6×2）：front/left 2×6，top 2×2。sx 取 36/40/44/48。 */
function legFaces(sx: number): McBoxFaceSet {
  return {
    front: { sx, sy: 16, sw: 2, sh: 6 },
    left: { sx: sx + 2, sy: 16, sw: 2, sh: 6 },
    top: { sx, sy: 22, sw: 2, sh: 2 },
  };
}

/** 盒构造简写（min/size 全偶数，见各模型约束测试）。 */
function q(
  name: string,
  min: [number, number, number],
  size: [number, number, number],
  faces: McBoxFaceSet,
): McBox {
  return { name, min, size, faces };
}

/**
 * 猫：10 盒（四足、双竖耳、两节尾）。头正面与玩家同窗 (8,8) 8×8
 * ——程序化眼型零改动复用。腿区 x=36 起与身体 UV 不重叠（见 UV 表）。
 * 耳 z=8（深度中点 9 > 头的 8）：painter 才会把耳画在头顶之上。
 */
export const CAT_MODEL: McModel = {
  form: "cat",
  boxes: [
    q("tail-1", [-2, 12, -10], [2, 2, 2], smallFaces(16, 4)),
    q("tail-2", [-2, 14, -10], [2, 2, 2], smallFaces(22, 4)),
    q("right-back-leg", [-6, 0, -6], [2, 6, 2], legFaces(36)),
    q("left-back-leg", [4, 0, -6], [2, 6, 2], legFaces(40)),
    q("body", [-4, 6, -8], [8, 6, 16], {
      front: { sx: 4, sy: 16, sw: 8, sh: 6 },
      top: { sx: 4, sy: 22, sw: 8, sh: 16 },
      left: { sx: 12, sy: 16, sw: 16, sh: 6 },
    }),
    q("right-front-leg", [-6, 0, 4], [2, 6, 2], legFaces(44)),
    q("left-front-leg", [4, 0, 4], [2, 6, 2], legFaces(48)),
    q("head", [-4, 12, 4], [8, 8, 8], {
      front: { sx: 8, sy: 8, sw: 8, sh: 8 },
      top: { sx: 8, sy: 0, sw: 8, sh: 8 },
      left: { sx: 0, sy: 8, sw: 8, sh: 8 },
    }),
    q("right-ear", [-4, 20, 8], [2, 2, 2], smallFaces(16, 0)),
    q("left-ear", [2, 20, 8], [2, 2, 2], smallFaces(22, 0)),
  ],
};

/** 狗：7 盒（无耳盒——贴图表达；一节尾；躯干长 20）。 */
export const DOG_MODEL: McModel = {
  form: "dog",
  boxes: [
    q("tail-1", [-2, 12, -12], [2, 2, 2], smallFaces(16, 4)),
    q("right-back-leg", [-6, 0, -8], [2, 6, 2], legFaces(36)),
    q("left-back-leg", [4, 0, -8], [2, 6, 2], legFaces(40)),
    q("body", [-4, 6, -10], [8, 6, 20], {
      front: { sx: 4, sy: 16, sw: 8, sh: 6 },
      top: { sx: 4, sy: 22, sw: 8, sh: 20 },
      left: { sx: 12, sy: 16, sw: 20, sh: 6 },
    }),
    q("right-front-leg", [-6, 0, 6], [2, 6, 2], legFaces(44)),
    q("left-front-leg", [4, 0, 6], [2, 6, 2], legFaces(48)),
    q("head", [-4, 12, 6], [8, 8, 8], {
      front: { sx: 8, sy: 8, sw: 8, sh: 8 },
      top: { sx: 8, sy: 0, sw: 8, sh: 8 },
      left: { sx: 0, sy: 8, sw: 8, sh: 8 },
    }),
  ],
};

/** 按形态取模型；未知形态抛错（调用方类型上不可能传错）。 */
export function modelForForm(form: McForm): McModel {
  if (form === "player") return PLAYER_MODEL;
  if (form === "cat") return CAT_MODEL;
  return DOG_MODEL;
}
