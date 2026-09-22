// src/mc/loader.ts
/**
 * 浏览器侧皮肤加载（薄驱动层，纯逻辑都在 skin.ts）：
 * 校验 → 解码 → 归一化 → alpha 二值化 → 注册。
 * 失败只回 null，不透传解码细节。
 */
import { binarizeAlpha, normalizeSkin, validateSkin, type SkinData } from "./skin";
import { registerMcSkin, type McSkinResources } from "./skin-registry";

async function decodeToSkinData(bytes: Uint8Array): Promise<SkinData> {
  const blob = new Blob([bytes.buffer as ArrayBuffer], { type: "image/png" });
  const bmp = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bmp.width;
  canvas.height = bmp.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d 不可用");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(bmp, 0, 0);
  const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
  return { w: bmp.width, h: bmp.height, data: img.data };
}

function skinToCanvas(skin: SkinData): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = skin.w;
  canvas.height = skin.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvas 2d 不可用");
  ctx.imageSmoothingEnabled = false;
  // SkinData.data 恒由 new Uint8ClampedArray / getImageData 创建，必为
  // ArrayBuffer 后备（TS 5.7+ 把类型数组按后备缓冲区分型，需显式收窄）
  ctx.putImageData(
    new ImageData(skin.data as Uint8ClampedArray<ArrayBuffer>, skin.w, skin.h),
    0,
    0,
  );
  return canvas;
}

export async function loadAndRegisterSkin(
  id: string,
  bytes: Uint8Array,
): Promise<McSkinResources | null> {
  if (!validateSkin(bytes).ok) return null;
  try {
    let skin = await decodeToSkinData(bytes);
    skin = normalizeSkin(skin);
    binarizeAlpha(skin);
    const res: McSkinResources = { skin, canvas: skinToCanvas(skin) };
    registerMcSkin(id, res);
    return res;
  } catch {
    return null;
  }
}
