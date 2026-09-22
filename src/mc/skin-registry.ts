// src/mc/skin-registry.ts
/**
 * 已加载皮肤资源的进程内注册表：skinId → { skin, canvas }。
 *
 * 渲染路径只查表不加载（绘制帧里绝无异步/解码）；注册发生在
 * loader（内置/导入）与 M4 的访客拉取。查不到返回 null，调用方
 * 跳过绘制（而不是画错）。
 */
import type { SkinData } from "./skin";

export interface McSkinResources {
  skin: SkinData;
  canvas: CanvasImageSource;
}

const REGISTRY = new Map<string, McSkinResources>();

export function registerMcSkin(id: string, res: McSkinResources): void {
  REGISTRY.set(id, res);
}

export function getMcSkinResources(id: string): McSkinResources | null {
  return REGISTRY.get(id) ?? null;
}
