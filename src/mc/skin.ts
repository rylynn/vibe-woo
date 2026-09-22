// src/mc/skin.ts
/**
 * MC 皮肤纯函数层：校验、归一化、alpha 二值化。
 *
 * 全部与 DOM 解耦（自有 SkinData 结构）——node 环境可测；
 * 浏览器侧的 PNG 解码在 loader.ts（驱动层保持薄）。
 */

/** RGBA 行主序位图（data.length === w*h*4）。 */
export interface SkinData {
  w: number;
  h: number;
  data: Uint8ClampedArray;
}

export type SkinCheck =
  | { ok: true; w: number; h: number }
  | { ok: false; reason: "not-png" | "too-large" | "bad-size" };

/** 皮肤文件大小上限（同步服务同样按此限制）。 */
export const SKIN_MAX_BYTES = 64 * 1024;

const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * 从 IHDR（PNG 规范固定为首块）解析宽高；非 PNG / 截断返回 null。
 * 字节布局：签名 0..7、首块长度 8..11（恒为 13）、类型 "IHDR" 12..15、
 * 宽 16..19、高 20..23（大端 u32）。
 */
export function parsePngSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 24) return null;
  for (let i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return null;
  if (!(b[8] === 0 && b[9] === 0 && b[10] === 0 && b[11] === 13)) return null;
  if (!(b[12] === 0x49 && b[13] === 0x48 && b[14] === 0x44 && b[15] === 0x52)) return null;
  const w = ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0;
  const h = ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0;
  return { w, h };
}

/** 校验皮肤字节：PNG 魔数、大小上限、尺寸白名单（64×64 或 64×32 旧格式）。 */
export function validateSkin(bytes: Uint8Array): SkinCheck {
  if (bytes.length > SKIN_MAX_BYTES) return { ok: false, reason: "too-large" };
  const size = parsePngSize(bytes);
  if (!size) return { ok: false, reason: "not-png" };
  if (size.w !== 64 || (size.h !== 64 && size.h !== 32)) {
    return { ok: false, reason: "bad-size" };
  }
  return { ok: true, w: size.w, h: size.h };
}

/** 肢体块（16×16）内 6 个子面的相对坐标：顶/底/外/正/内/背。 */
const LIMB_SUBRECTS: readonly [number, number, number, number][] = [
  [4, 0, 4, 4],
  [8, 0, 4, 4],
  [0, 4, 4, 12],
  [4, 4, 4, 12],
  [8, 4, 4, 12],
  [12, 4, 4, 12],
];

/** 把 16×16 肢体块逐子面水平镜像拷贝（64×32 旧格式的左肢补全方式）。 */
function mirrorLimb(
  dst: SkinData,
  src: SkinData,
  sx0: number,
  sy0: number,
  dx0: number,
  dy0: number,
): void {
  for (const [rx, ry, rw, rh] of LIMB_SUBRECTS) {
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const s = ((sy0 + ry + y) * src.w + (sx0 + rx + (rw - 1 - x))) * 4;
        const d = ((dy0 + ry + y) * dst.w + (dx0 + rx + x)) * 4;
        dst.data[d] = src.data[s];
        dst.data[d + 1] = src.data[s + 1];
        dst.data[d + 2] = src.data[s + 2];
        dst.data[d + 3] = src.data[s + 3];
      }
    }
  }
}

/**
 * 归一化到 64×64：旧格式 64×32 的左臂/左腿没有专属贴图区，
 * 按惯例由右肢逐面子镜像生成；已是 64×64 则原样返回。
 */
export function normalizeSkin(src: SkinData): SkinData {
  if (src.h === 64) return src;
  const out: SkinData = { w: 64, h: 64, data: new Uint8ClampedArray(64 * 64 * 4) };
  // 上半区（头/躯干/右肢）原样拷贝
  out.data.set(src.data.subarray(0, 64 * 32 * 4));
  mirrorLimb(out, src, 40, 16, 32, 48); // 右臂块 → 左臂块
  mirrorLimb(out, src, 0, 16, 16, 48);  // 右腿块 → 左腿块
  return out;
}

/**
 * alpha 二值化（红线：运行时零半透明像素）。
 * 阈值 128：≥ 保留为不透明，< 视为透明。就地修改。
 */
export function binarizeAlpha(skin: SkinData): void {
  for (let i = 3; i < skin.data.length; i += 4) {
    skin.data[i] = skin.data[i] >= 128 ? 255 : 0;
  }
}

/** 区域内是否存在不透明像素（空 overlay 面跳过的判据）。 */
export function hasOpaquePixels(
  skin: SkinData,
  r: { sx: number; sy: number; sw: number; sh: number },
): boolean {
  for (let y = r.sy; y < r.sy + r.sh; y++) {
    for (let x = r.sx; x < r.sx + r.sw; x++) {
      if (skin.data[(y * skin.w + x) * 4 + 3] > 0) return true;
    }
  }
  return false;
}
