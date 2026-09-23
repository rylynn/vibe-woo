// src/mc/project.ts
/**
 * 正交 cabinet 投影：姿态 → 待绘制面列表（纯函数）。
 *
 * 固定视角（全应用唯一）：观察者在正前偏上。每单位屏幕向量
 *   x̂ = (3m/2, 0)、ŷ = (0, −3m/2)、ẑ = (m, m/2)
 * 性质：
 *   - 正面（z=zmax）零畸变、轴对齐——眼部表情覆盖依赖这一点；
 *   - 顶面与 x=min 侧面以 2:1 斜率露出（经典等距观感）；
 *   - 模型坐标全偶数 + 姿态偏移全偶数（pose.ts 偶数偏移原则）
 *     ⇒ 投影顶点全整数；每纹理像素 u/v 落在 0.5 网格。
 *
 * M2 三种几何：
 *   站立   M1 几何 + 盒偏移（swing/breath/spread）；
 *   躺平   基变换 PT(x,y,z) = P(x, z+4, 32−y)（脸朝天、脚朝观察者），
 *          附锚点补偿 ox −= 16m、oy −= 13m（身体甩向右上方，拉回脚底）；
 *   举臂   臂盒 y+12、三面绕肩翻转 180°，顶面改装 bottom 贴图（手）。
 * 头部转向不做几何旋转：正面贴图窗口沿头部条带平移 headYaw 格
 * （窗口位移原则）。镜像在排序前整体 x 翻转（z 不变 ⇒ 排序次序
 * 与未镜像完全一致，两套面数组逐位平行）。
 * 排序：painter，面深度中点 z 升序；sort 稳定保插入序
 * （基础面先于 overlay、model.boxes 的四肢→躯干→头顺序）。
 */
import type { McModel, McTexRect } from "./model";
import type { McPose } from "./pose";

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
  /** 所属盒名（drawMcEyes 靠它定位头正面）。 */
  box: string;
  /** 面种类。 */
  face: "front" | "top" | "left";
}

/** 视图参数：m = 尺寸倍率（SIZE_STEPS 1..4），锚点 = 脚底中心。 */
export interface McView {
  m: number;
  ox: number;
  oy: number;
}

/** 四肢摆动位移档 = 2·round(sin(2πp/8))，全偶数保整数顶点。 */
const SWING = [0, 2, 2, 2, 0, -2, -2, -2] as const;

function swing(phase: number): number {
  return SWING[((Math.floor(phase) % 8) + 8) % 8];
}

/** 每盒关节偏移（模型单位，全偶数）。 */
interface BoxOffset {
  dx: number;
  dy: number;
  dz: number;
  /** 举臂：y 区间 +12 且三面翻转 180°（仅双臂会置位）。 */
  raise: boolean;
}

const ZERO: BoxOffset = { dx: 0, dy: 0, dz: 0, raise: false };

function boxOffsets(pose: McPose): Record<string, BoxOffset> {
  return {
    // 步态：右臂/左腿同相，左臂/右腿反相（+4）；hop 张臂 ±2
    "right-arm": { dx: pose.armsSpread ? -2 : 0, dy: 0, dz: swing(pose.limbPhase), raise: pose.armsUp },
    "left-arm": { dx: pose.armsSpread ? 2 : 0, dy: 0, dz: swing(pose.limbPhase + 4), raise: pose.armsUp },
    "right-leg": { dx: 0, dy: 0, dz: swing(pose.limbPhase + 4), raise: false },
    "left-leg": { dx: 0, dy: 0, dz: swing(pose.limbPhase), raise: false },
    body: ZERO,
    // 呼吸：站立头 dy ±2；躺平头 dz 只抬不沉（负档会穿地）
    head: pose.lying
      ? { dx: 0, dy: 0, dz: pose.breath > 0 ? 2 : 0, raise: false }
      : { dx: 0, dy: 2 * pose.breath, dz: 0, raise: false },
  };
}

export function projectModel(model: McModel, pose: McPose, view: McView): McFace[] {
  const { m } = view;
  // 躺平锚点补偿：PT 会把身体甩到锚点右上方，先拉回脚底中心
  let ox = view.ox;
  let oy = view.oy;
  if (pose.lying) {
    ox -= 16 * m;
    oy -= 13 * m;
  }
  const P = (x: number, y: number, z: number): { x: number; y: number } => ({
    x: ox + (3 * m) / 2 * x + m * z,
    y: oy - (3 * m) / 2 * y + (m / 2) * z,
  });
  /** 躺平基变换：脸朝天、脚朝观察者。 */
  const PT = (x: number, y: number, z: number): { x: number; y: number } => P(x, z + 4, 32 - y);

  const UX = { x: (3 * m) / 2, y: 0 };
  const UY_DOWN = { x: 0, y: (3 * m) / 2 };
  const UY_UP = { x: 0, y: -(3 * m) / 2 };
  const UZ = { x: m, y: m / 2 };
  const UZ_BACK = { x: -m, y: -m / 2 };
  const UX_BACK = { x: -(3 * m) / 2, y: 0 };

  const offs = boxOffsets(pose);
  const faces: McFace[] = [];
  const emit = (
    box: string,
    face: "front" | "top" | "left",
    tex: McTexRect,
    o: { x: number; y: number },
    u: { x: number; y: number },
    v: { x: number; y: number },
    z: number,
    yawShift = 0,
    overlay = false,
  ): void => {
    // 头部窗口位移：复制 tex 再平移，绝不改 model 常量
    faces.push({ o, u, v, tex: { ...tex, sx: tex.sx + yawShift }, z, overlay, box, face });
  };

  for (const b of model.boxes) {
    const off = offs[b.name] ?? ZERO;
    const [bw, bh, bd] = b.size;
    const bx = b.min[0] + off.dx;
    const yBot = b.min[1] + off.dy + (off.raise ? 12 : 0);
    const yTop = yBot + bh;
    const bz = b.min[2] + off.dz;
    const zFront = bz + bd;
    // 窗口位移只作用于头正面（基础 + 帽层）：条带连续性保证跨面不露缝
    const yaw = b.name === "head" ? pose.headYaw : 0;
    const f = b.faces;
    const ov = f.overlay;

    if (pose.lying) {
      // 躺平：正面朝天（原 z 面 → 水平）、顶面朝脚方向、左面贴地侧
      emit(b.name, "front", f.front, PT(bx, yTop, zFront), UX, UZ, 32 - (yBot + yTop) / 2, yaw);
      emit(b.name, "top", f.top, PT(bx, yTop, bz), UX, UY_UP, 32 - yTop);
      emit(b.name, "left", f.left, PT(bx, yTop, zFront), UY_DOWN, UZ, (yBot + yTop) / 2);
      if (ov) {
        emit(b.name, "front", ov.front, PT(bx, yTop, zFront), UX, UZ, 32 - (yBot + yTop) / 2, yaw, true);
        emit(b.name, "top", ov.top, PT(bx, yTop, bz), UX, UY_UP, 32 - yTop, 0, true);
        emit(b.name, "left", ov.left, PT(bx, yTop, zFront), UY_DOWN, UZ, (yBot + yTop) / 2, 0, true);
      }
    } else if (off.raise) {
      // 举臂：臂盒上移 12，三面绕肩翻转 180°；顶面朝上露的是手底面
      emit(b.name, "front", f.front, P(bx + bw, yBot, zFront), UX_BACK, UY_UP, zFront, yaw);
      emit(b.name, "top", f.bottom ?? f.top, P(bx, yTop, bz), UX, UZ, bz + bd / 2);
      emit(b.name, "left", f.left, P(bx, yBot, zFront), UZ_BACK, UY_UP, bz + bd / 2);
      if (ov) {
        emit(b.name, "front", ov.front, P(bx + bw, yBot, zFront), UX_BACK, UY_UP, zFront, yaw, true);
        // 帽层顶面同样画手底贴图（与基础面同像素，无视觉副作用）
        emit(b.name, "top", f.bottom ?? ov.top, P(bx, yTop, bz), UX, UZ, bz + bd / 2, 0, true);
        emit(b.name, "left", ov.left, P(bx, yBot, zFront), UZ_BACK, UY_UP, bz + bd / 2, 0, true);
      }
    } else {
      // 站立（M1 几何 + 盒偏移）
      emit(b.name, "front", f.front, P(bx, yTop, zFront), UX, UY_DOWN, zFront, yaw);
      emit(b.name, "top", f.top, P(bx, yTop, bz), UX, UZ, bz + bd / 2);
      emit(b.name, "left", f.left, P(bx, yTop, zFront), UZ_BACK, UY_DOWN, bz + bd / 2);
      if (ov) {
        emit(b.name, "front", ov.front, P(bx, yTop, zFront), UX, UY_DOWN, zFront, yaw, true);
        emit(b.name, "top", ov.top, P(bx, yTop, bz), UX, UZ, bz + bd / 2, 0, true);
        emit(b.name, "left", ov.left, P(bx, yTop, zFront), UZ_BACK, UY_DOWN, bz + bd / 2, 0, true);
      }
    }
  }

  // 镜像：排序前整体 x 翻转。z 不变 ⇒ 稳定排序次序与未镜像一致，
  // 两套面数组逐位平行（mirror 不变量测试依赖这一点）。
  if (pose.mirrored) {
    for (const f of faces) {
      f.o = { x: 2 * ox - f.o.x, y: f.o.y };
      f.u = { x: -f.u.x, y: f.u.y };
      f.v = { x: -f.v.x, y: f.v.y };
    }
  }

  // 远（z 小）先画；sort 稳定（ES2019+），同 z 保插入序。
  return faces.sort((a, b) => a.z - b.z);
}
