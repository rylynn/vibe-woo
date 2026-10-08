// tests/mc-quadruped.test.ts
// 四足投影黄金坐标：m=1、ox=100、oy=200。
// P(x,y,z) = (100+1.5x+z, 200−1.5y+0.5z)；standing 发射 front o = P(bx, yTop, zFront)。
import { describe, expect, it } from "vitest";
import { CAT_MODEL, DOG_MODEL, type McModel } from "../src/mc/model";
import { mcRestPose, type McPose } from "../src/mc/pose";
import { projectModel, type McFace } from "../src/mc/project";

const VIEW = { m: 1, ox: 100, oy: 200 };

function pose(over: Partial<McPose>): McPose {
  return { ...mcRestPose(), ...over };
}

function faceOf(model: McModel, p: McPose, box: string, kind: McFace["face"]): McFace {
  const f = projectModel(model, p, VIEW).find(
    (x) => x.box === box && x.face === kind && !x.overlay,
  );
  if (!f) throw new Error(`面不存在: ${box}.${kind}`);
  return f;
}

describe("猫站立与动作", () => {
  it("静止：头正面 (106,176)、右前腿正面 (97,194)", () => {
    const p = pose({});
    expect(faceOf(CAT_MODEL, p, "head", "front").o).toEqual({ x: 106, y: 176 });
    expect(faceOf(CAT_MODEL, p, "right-front-leg", "front").o).toEqual({ x: 97, y: 194 });
  });

  it("尾摆：phase 1 → tail-1 (92,175)；phase 5 → (86,175)", () => {
    expect(faceOf(CAT_MODEL, pose({ tailPhase: 1 }), "tail-1", "front").o).toEqual({ x: 92, y: 175 });
    expect(faceOf(CAT_MODEL, pose({ tailPhase: 5 }), "tail-1", "front").o).toEqual({ x: 86, y: 175 });
  });

  it("对角小跑 limbPhase=1：右前 (99,195)、左后 (104,190)、左前 (110,193)", () => {
    const p = pose({ limbPhase: 1 });
    expect(faceOf(CAT_MODEL, p, "right-front-leg", "front").o).toEqual({ x: 99, y: 195 });
    expect(faceOf(CAT_MODEL, p, "left-back-leg", "front").o).toEqual({ x: 104, y: 190 });
    expect(faceOf(CAT_MODEL, p, "left-front-leg", "front").o).toEqual({ x: 110, y: 193 });
  });

  it("play bow（armsUp）：头 (106,179)、右后腿 (87,186)", () => {
    const p = pose({ armsUp: true });
    expect(faceOf(CAT_MODEL, p, "head", "front").o).toEqual({ x: 106, y: 179 });
    expect(faceOf(CAT_MODEL, p, "right-back-leg", "front").o).toEqual({ x: 87, y: 186 });
  });

  it("hop（armsSpread）：四肢收拢，右前腿 (97,197)", () => {
    expect(faceOf(CAT_MODEL, pose({ armsSpread: true }), "right-front-leg", "front").o).toEqual({
      x: 97,
      y: 197,
    });
  });

  it("held 尾垂：tail-1 (89,178)", () => {
    expect(faceOf(CAT_MODEL, pose({ tailDroop: true }), "tail-1", "front").o).toEqual({
      x: 89,
      y: 178,
    });
  });

  it("侧蜷（lying，不走玩家 PT/锚点补偿）：躯干 (102,195)、头 (106,194)", () => {
    const p = pose({ lying: true });
    expect(faceOf(CAT_MODEL, p, "body", "front").o).toEqual({ x: 102, y: 195 });
    expect(faceOf(CAT_MODEL, p, "head", "front").o).toEqual({ x: 106, y: 194 });
    // 呼吸只抬不沉：breath=+1 头 dz+2 → (108,195)
    expect(faceOf(CAT_MODEL, pose({ lying: true, breath: 1 }), "head", "front").o).toEqual({
      x: 108,
      y: 195,
    });
  });
});

describe("狗站立", () => {
  it("头正面 (108,177)、尾 (87,174)", () => {
    const p = pose({});
    expect(faceOf(DOG_MODEL, p, "head", "front").o).toEqual({ x: 108, y: 177 });
    expect(faceOf(DOG_MODEL, p, "tail-1", "front").o).toEqual({ x: 87, y: 174 });
  });
});

describe("四足投影不变量", () => {
  const poses: McPose[] = [
    pose({}),
    pose({ limbPhase: 3, tailPhase: 5 }),
    pose({ armsUp: true }),
    pose({ armsSpread: true }),
    pose({ lying: true }),
    pose({ lying: true, breath: 1 }),
    pose({ limbPhase: 2, mirrored: true }),
  ];

  it("全部面角点整数（偶数偏移原则的投影结果）", () => {
    for (const model of [CAT_MODEL, DOG_MODEL]) {
      for (const p of poses) {
        for (const f of projectModel(model, p, VIEW)) {
          for (const [c, r] of [[0, 0], [f.tex.sw, 0], [0, f.tex.sh], [f.tex.sw, f.tex.sh]] as const) {
            const x = f.o.x + f.u.x * c + f.v.x * r;
            const y = f.o.y + f.u.y * c + f.v.y * r;
            expect(Number.isInteger(x)).toBe(true);
            expect(Number.isInteger(y)).toBe(true);
          }
        }
      }
    }
  });

  it("面数 = 盒数×3（无 overlay）：猫 30、狗 21", () => {
    expect(projectModel(CAT_MODEL, pose({}), VIEW)).toHaveLength(30);
    expect(projectModel(DOG_MODEL, pose({}), VIEW)).toHaveLength(21);
  });

  it("镜像面数组逐位平行（同序同 box/face，o.x 关于锚点对称）", () => {
    const a = projectModel(CAT_MODEL, pose({ limbPhase: 1, tailPhase: 3 }), VIEW);
    const b = projectModel(CAT_MODEL, pose({ limbPhase: 1, tailPhase: 3, mirrored: true }), VIEW);
    expect(b).toHaveLength(a.length);
    for (let i = 0; i < a.length; i++) {
      expect([b[i].box, b[i].face, b[i].overlay]).toEqual([a[i].box, a[i].face, a[i].overlay]);
      expect(b[i].o.x).toBe(2 * VIEW.ox - a[i].o.x);
      expect(b[i].o.y).toBe(a[i].o.y);
    }
  });
});
