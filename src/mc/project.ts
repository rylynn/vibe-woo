// src/mc/project.ts
/**
 * 正交 cabinet 投影：姿态 → 待绘制面列表（纯函数）。
 *
 * 固定视角（全应用唯一）：观察者在正前偏上。每单位屏幕向量
 *   x̂ = (3m/2, 0)、ŷ = (0, −3m/2)、ẑ = (m, m/2)
 * 性质：
 *   - 正面（z=zmax）零畸变、轴对齐——M2 眼部表情覆盖依赖这一点；
 *   - 顶面与 x=min 侧面以 2:1 斜率露出（经典等距观感）；
 *   - 模型坐标全偶数 ⇒ 投影顶点全整数（1.5m×偶数、(m/2)×偶数）；
 *     每纹理像素 u/v 落在 0.5 网格（奇数 m 时为 x.5）。
 * 排序：painter 算法，按面深度中点 z 升序（远先画）；同 z 依赖
 * Array.prototype.sort 的稳定性保持插入序（基础面先于 overlay、
 * model.boxes 的四肢→躯干→头顺序）。
 */
import type { McModel, McTexRect } from "./model";

/** 一个待绘制面：平行四边形 = o + u·s + v·s（s∈[0,sw]×[0,sh] 网格）。 */
export interface McFace {
  /** 贴图 (0,0) 角对应的屏幕坐标（整数）。 */
  o: { x: number; y: number };
  /** 贴图 u 方向每像素的屏幕向量（0.5 网格）。 */
  u: { x: number; y: number };
  /** 贴图 v 方向每像素的屏幕向量（0.5 网格）。 */
  v: { x: number; y: number };
  tex: McTexRect;
  /** 面深度中点（模型 z），painter 排序键。 */
  z: number;
  /** overlay 层面（空贴图由上游按像素过滤）。 */
  overlay: boolean;
}

/** M1 静态站立姿态；M2 扩展关节档位（limbPhase/headYaw/...）。 */
export interface McPose {}

/** 视图参数：m = 尺寸倍率（SIZE_STEPS 1..4），锚点 = 脚底中心。 */
export interface McView {
  m: number;
  ox: number;
  oy: number;
}

export function projectModel(model: McModel, _pose: McPose, view: McView): McFace[] {
  const { m, ox, oy } = view;
  // 模型空间 → 屏幕。y 向上 → canvas y 向下取负。
  const P = (x: number, y: number, z: number): { x: number; y: number } => ({
    x: ox + (3 * m) / 2 * x + m * z,
    y: oy - (3 * m) / 2 * y + (m / 2) * z,
  });

  const faces: McFace[] = [];
  for (const box of model.boxes) {
    const [bx, by, bz] = box.min;
    // _bw 仅标注尺寸三元组形状（宽度不直接参与投影，u 向量由 m 决定）
    const [_bw, bh, bd] = box.size;
    const yTop = by + bh;
    const zFront = bz + bd;

    // 正面（z 最大）：贴图 (0,0) 在左上（模型 x 最小、y 最大），零畸变
    faces.push({
      o: P(bx, yTop, zFront),
      u: { x: (3 * m) / 2, y: 0 },
      v: { x: 0, y: (3 * m) / 2 },
      tex: box.faces.front,
      z: zFront,
      overlay: false,
    });
    // 顶面（y 最大）：贴图 u 沿 +x、v 沿 +z（贴图下缘 = 角色前方）
    faces.push({
      o: P(bx, yTop, bz),
      u: { x: (3 * m) / 2, y: 0 },
      v: { x: m, y: m / 2 },
      tex: box.faces.top,
      z: bz + bd / 2,
      overlay: false,
    });
    // 左侧面（x 最小）：贴图 u 沿 −z（侧贴图左缘 = 角色前方）、v 沿 −y
    faces.push({
      o: P(bx, yTop, zFront),
      u: { x: -m, y: -m / 2 },
      v: { x: 0, y: (3 * m) / 2 },
      tex: box.faces.left,
      z: bz + bd / 2,
      overlay: false,
    });

    // overlay 层：同几何，跟在基础面之后（稳定排序保持覆盖关系）
    const ov = box.faces.overlay;
    if (ov) {
      faces.push(
        {
          o: P(bx, yTop, zFront),
          u: { x: (3 * m) / 2, y: 0 },
          v: { x: 0, y: (3 * m) / 2 },
          tex: ov.front,
          z: zFront,
          overlay: true,
        },
        {
          o: P(bx, yTop, bz),
          u: { x: (3 * m) / 2, y: 0 },
          v: { x: m, y: m / 2 },
          tex: ov.top,
          z: bz + bd / 2,
          overlay: true,
        },
        {
          o: P(bx, yTop, zFront),
          u: { x: -m, y: -m / 2 },
          v: { x: 0, y: (3 * m) / 2 },
          tex: ov.left,
          z: bz + bd / 2,
          overlay: true,
        },
      );
    }
  }

  // 远（z 小）先画；sort 稳定（ES2019+），同 z 保插入序。
  return faces.sort((a, b) => a.z - b.z);
}
