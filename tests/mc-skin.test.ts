// tests/mc-skin.test.ts
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  SKIN_MAX_BYTES,
  binarizeAlpha,
  hasOpaquePixels,
  normalizeSkin,
  parsePngSize,
  validateSkin,
  type SkinData,
} from "../src/mc/skin";

const FIXTURE = new Uint8Array(
  readFileSync(new URL("../src/mc/assets/default-skin.png", import.meta.url)),
);

/** 构造纯数据皮肤：区域内全不透明纯色，其余全透明。 */
function makeSkin(w: number, h: number, rect?: [number, number, number, number]): SkinData {
  const data = new Uint8ClampedArray(w * h * 4);
  if (rect) {
    const [rx, ry, rw, rh] = rect;
    for (let y = ry; y < ry + rh; y++) {
      for (let x = rx; x < rx + rw; x++) {
        const i = (y * w + x) * 4;
        data[i] = 200; data[i + 1] = 100; data[i + 2] = 50; data[i + 3] = 255;
      }
    }
  }
  return { w, h, data };
}

describe("parsePngSize", () => {
  it("解析 fixture 的 64×64", () => {
    expect(parsePngSize(FIXTURE)).toEqual({ w: 64, h: 64 });
  });
  it("非 PNG / 截断 → null", () => {
    expect(parsePngSize(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBeNull();
    expect(parsePngSize(FIXTURE.slice(0, 10))).toBeNull();
  });
});

describe("validateSkin", () => {
  it("接受 64×64", () => {
    expect(validateSkin(FIXTURE)).toEqual({ ok: true, w: 64, h: 64 });
  });
  it("接受 64×32 旧格式", () => {
    // 最小合法 PNG 头（签名 + IHDR 长度/类型 + 宽高字段）
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes.set([0, 0, 0, 13], 8);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12); // IHDR
    bytes[16] = 0; bytes[17] = 0; bytes[18] = 0; bytes[19] = 64; // w=64
    bytes[20] = 0; bytes[21] = 0; bytes[22] = 0; bytes[23] = 32; // h=32
    expect(validateSkin(bytes)).toEqual({ ok: true, w: 64, h: 32 });
  });
  it("尺寸不对 → bad-size", () => {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    bytes.set([0, 0, 0, 13], 8);
    bytes.set([0x49, 0x48, 0x44, 0x52], 12);
    bytes[19] = 128; bytes[23] = 128; // 128×128
    expect(validateSkin(bytes)).toEqual({ ok: false, reason: "bad-size" });
  });
  it("超限 → too-large（优先于尺寸判断）", () => {
    const bytes = new Uint8Array(SKIN_MAX_BYTES + 1);
    bytes.set(FIXTURE);
    expect(validateSkin(bytes)).toEqual({ ok: false, reason: "too-large" });
  });
});

describe("normalizeSkin", () => {
  it("64×64 原样返回", () => {
    const s = makeSkin(64, 64, [8, 8, 8, 8]);
    expect(normalizeSkin(s)).toBe(s);
  });
  it("64×32 补出 64×64：左臂由右肢逐面子镜像", () => {
    const s = makeSkin(64, 32, [40, 16, 16, 16]); // 右臂块全不透明
    const out = normalizeSkin(s);
    expect(out).not.toBe(s);
    expect(out.w).toBe(64);
    expect(out.h).toBe(64);
    // 上半区原样拷贝
    expect(out.data[(16 * 64 + 40) * 4 + 3]).toBe(255);
    // 右臂正面 (44,20..31,4×12) 镜像到左臂正面 (36,52)：x 逐列翻转
    // 取右臂正面最后一列 (47, 20) → 左臂正面第一列 (36, 52)
    expect(out.data[(52 * 64 + 36) * 4 + 3]).toBe(255);
    // 左臂块之外的下半区保持透明（如 (0,48) 是左腿块，未镜像右腿）
    expect(out.data[(48 * 64 + 0) * 4 + 3]).toBe(0);
  });
});

describe("binarizeAlpha", () => {
  it("阈值 128：以上归 255、以下归 0", () => {
    const s = makeSkin(3, 1);
    s.data[3] = 127;
    s.data[7] = 128;
    s.data[11] = 200;
    binarizeAlpha(s);
    expect(s.data[3]).toBe(0);
    expect(s.data[7]).toBe(255);
    expect(s.data[11]).toBe(255);
  });
});

describe("hasOpaquePixels", () => {
  it("空区 false、有像素 true", () => {
    const s = makeSkin(64, 64, [40, 8, 8, 8]); // 仅帽子区
    expect(hasOpaquePixels(s, { sx: 40, sy: 8, sw: 8, sh: 8 })).toBe(true);
    expect(hasOpaquePixels(s, { sx: 16, sy: 32, sw: 24, sh: 16 })).toBe(false);
  });
});
