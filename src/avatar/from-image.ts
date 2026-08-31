import {
  BODY_SHAPES,
  BROW_STYLES,
  EYE_STYLES,
  type ActionStyle,
  type BodyShape,
  type BrowStyle,
  type EyeStyle,
  type Pattern,
  type PetAvatar,
} from "./types";
import { accentFor, clampBodyHsl, hexToHsl, hslToHex, type Hsl } from "./palette";
import {
  classifyShape,
  type MaskGeom,
} from "./shape-analysis";

/**
 * 图生形象：纯本地图像分析 → 形象参数映射。
 *
 * 全程无网络：图片缩样到 32×32（1024 像素，O(n) 一遍扫完）。
 *
 * 两段式：
 * 1. analyzeImage：前景/背景分离 → 双主色与纹理（extractColors）+
 *    轮廓 mask → 明暗/边缘密度等辅助特征。
 * 2. avatarFromAnalysis：有明确主体时走轮廓几何分类（形状 + 顶部
 *    特征件，见 shape-analysis.ts）；无主体（纯色/抽象图）退回特征
 *    映射。产出 1 个忠实映射 + 2 个保留主色的微调变体。
 *
 * 生成结果仍是程序化绘制的像素形象，图片只是「灵感来源」，
 * 不会被直接显示。
 */

/** 采样尺寸。32×32 足够抓住主色与轮廓特征，且计算量可忽略。 */
const SAMPLE = 32;

export interface ImageFeatures {
  /** 前景主色（HSL）。无明确主体时为全图主色。 */
  dominant: Hsl;
  /** 圆形度 0..1：前景占包围盒的面积比与 π/4 的接近程度。 */
  roundness: number;
  /** 源图宽高比（>1 横长，<1 竖长）。 */
  aspect: number;
  /** 前景平均亮度 0..1（Rec.601 luma）。 */
  lightness: number;
  /** 边缘密度 0..1：相邻像素亮度突变（>48）的比例，轮廓复杂度。 */
  edgeDensity: number;
}

/** 完整分析结果：特征 + 颜色 + 前景轮廓。 */
export interface ImageAnalysis {
  features: ImageFeatures;
  colors: ColorVerdict;
  /** 是否有明确前景主体（纯色/抽象图为 false）。 */
  hasSubject: boolean;
  /** 前景 mask（hasSubject 时非空），供轮廓几何分析。 */
  mask: Uint8Array | null;
  geom: MaskGeom | null;
}

/** Rec.601 相对亮度。 */
function luma(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

function rgbToHsl(r: number, g: number, b: number): Hsl {
  const ch = (v: number) =>
    Math.round(v).toString(16).padStart(2, "0").toUpperCase();
  return hexToHsl(`#${ch(r)}${ch(g)}${ch(b)}`);
}

/** 前景/背景分离阈值（RGB 欧氏距离）。 */
const BG_DISTANCE = 60;
/** 前景占比低于此值视为「无明确主体」，退回全图统计。 */
const MIN_FOREGROUND_SHARE = 0.1;

/** 双主色 + 纹理判定结果。 */
export interface ColorVerdict {
  /** 主色（直方图最大桶均值）。 */
  primary: Hsl;
  /** 次色（第二桶）；占比不足 15% 时为 null（零星噪点不算纹理）。 */
  secondary: Hsl | null;
  /** 次色的空间分布：行聚集 → stripes，分散 → spots。 */
  pattern: Pattern;
}

interface ColorBucket {
  n: number;
  r: number;
  g: number;
  b: number;
  /** 每行的桶内像素数（纹理判定的空间分布依据）。 */
  rows: number[];
}

/**
 * 提取双主色与纹理。
 *
 * 直方图取前两桶；纹理看次色的行分布变异系数（CV）：
 * 条纹衫的次色集中在若干行（CV 大），斑点/碎花的次色行行都有（CV 小）。
 *
 * @param mask 前景 mask；null 表示全图统计（无明确主体的图）
 */
export function extractColors(
  img: ImageData,
  mask: Uint8Array | null,
): ColorVerdict {
  const { data, width, height } = img;
  const buckets = new Map<number, ColorBucket>();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = y * width + x;
      if (mask && !mask[p]) continue;
      const i = p * 4;
      if (data[i + 3] < 128) continue;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = { n: 0, r: 0, g: 0, b: 0, rows: new Array(height).fill(0) };
        buckets.set(key, bucket);
      }
      bucket.n++;
      bucket.r += r;
      bucket.g += g;
      bucket.b += b;
      bucket.rows[y]++;
    }
  }

  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  if (sorted.length === 0) {
    return { primary: { h: 160, s: 0.5, l: 0.55 }, secondary: null, pattern: "none" };
  }
  const total = sorted.reduce((s, b) => s + b.n, 0);
  const first = sorted[0];
  const primary = rgbToHsl(first.r / first.n, first.g / first.n, first.b / first.n);

  const second = sorted[1];
  if (!second || second.n / total < 0.15) {
    return { primary, secondary: null, pattern: "none" };
  }
  const secondary = rgbToHsl(
    second.r / second.n,
    second.g / second.n,
    second.b / second.n,
  );

  // 行分布变异系数：次色在各行的份额波动越大，越像条纹
  const shares = second.rows.map((c) => c / second.n);
  const mean = shares.reduce((s, v) => s + v, 0) / height;
  const std = Math.sqrt(
    shares.reduce((s, v) => s + (v - mean) * (v - mean), 0) / height,
  );
  const cv = mean > 0 ? std / mean : 0;

  return { primary, secondary, pattern: cv > 0.5 ? "stripes" : "spots" };
}

/**
 * 分析 32×32 采样图：前景分离 + 颜色 + 轮廓 + 辅助特征。
 *
 * @param srcAspect 源图宽高比（采样会把图压成方形，比例只能从这里来）
 */
export function analyzeImage(img: ImageData, srcAspect = 1): ImageAnalysis {
  const { data, width, height } = img;
  const count = width * height;

  // 背景色：四角 3×3 块均值（取图片边缘最稳妥的估计）。
  // 同时检查四角是否一致：四角颜色互异说明图是纹理/无明确背景
  // （如棋盘格），前景分离不可靠，应判无主体。
  const corners: [number, number][] = [
    [0, 0],
    [width - 3, 0],
    [0, height - 3],
    [width - 3, height - 3],
  ];
  const cornerMeans: [number, number, number][] = [];
  for (const [cx, cy] of corners) {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = Math.max(0, cy); y < Math.min(height, cy + 3); y++) {
      for (let x = Math.max(0, cx); x < Math.min(width, cx + 3); x++) {
        const i = (y * width + x) * 4;
        r += data[i];
        g += data[i + 1];
        b += data[i + 2];
        n++;
      }
    }
    cornerMeans.push([r / n, g / n, b / n]);
  }
  let bgR = 0;
  let bgG = 0;
  let bgB = 0;
  let cornerSpread = 0;
  for (const [r, g, b] of cornerMeans) {
    bgR += r;
    bgG += g;
    bgB += b;
    for (const [r2, g2, b2] of cornerMeans) {
      cornerSpread = Math.max(cornerSpread, Math.hypot(r - r2, g - g2, b - b2));
    }
  }
  bgR /= 4;
  bgG /= 4;
  bgB /= 4;
  const bgReliable = cornerSpread <= BG_DISTANCE;

  // 前景 mask + 包围盒 + 亮度和
  const fg = new Uint8Array(count);
  let fgCount = 0;
  let minX = width;
  let maxX = -1;
  let minY = height;
  let maxY = -1;
  let lumaSum = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      if (data[i + 3] < 128) continue;
      const dist = Math.hypot(data[i] - bgR, data[i + 1] - bgG, data[i + 2] - bgB);
      if (dist <= BG_DISTANCE) continue;
      fg[y * width + x] = 1;
      fgCount++;
      lumaSum += luma(data[i], data[i + 1], data[i + 2]);
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  // 前景占比过低=无主体；过高（≈全图都是前景，如棋盘格）= 没有背景可言
  const hasSubject =
    bgReliable &&
    fgCount >= count * MIN_FOREGROUND_SHARE &&
    fgCount <= count * 0.85;
  const colors = extractColors(img, hasSubject ? fg : null);

  // 圆形度：前景占其包围盒的面积比 → 与圆（π/4）的接近程度
  let roundness = 0.5;
  if (hasSubject) {
    const boxArea = Math.max(1, (maxX - minX + 1) * (maxY - minY + 1));
    const ratio = fgCount / boxArea;
    roundness = Math.max(
      0,
      Math.min(1, 1 - Math.abs(ratio - Math.PI / 4) / (1 - Math.PI / 4)),
    );
  }

  // 明暗：无主体时用全图平均
  let lightness: number;
  if (hasSubject) {
    lightness = lumaSum / fgCount / 255;
  } else {
    let sum = 0;
    for (let p = 0; p < count; p++) {
      const i = p * 4;
      sum += luma(data[i], data[i + 1], data[i + 2]);
    }
    lightness = sum / count / 255;
  }

  // 边缘密度：相邻像素亮度突变的比例（水平 + 垂直）
  let edges = 0;
  let pairs = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const here = luma(data[i], data[i + 1], data[i + 2]);
      if (x + 1 < width) {
        const j = i + 4;
        pairs++;
        if (Math.abs(here - luma(data[j], data[j + 1], data[j + 2])) > 48) {
          edges++;
        }
      }
      if (y + 1 < height) {
        const j = i + width * 4;
        pairs++;
        if (Math.abs(here - luma(data[j], data[j + 1], data[j + 2])) > 48) {
          edges++;
        }
      }
    }
  }
  const edgeDensity = pairs > 0 ? edges / pairs : 0;

  return {
    features: {
      dominant: colors.primary,
      roundness,
      aspect: srcAspect,
      lightness,
      edgeDensity,
    },
    colors,
    hasSubject,
    mask: hasSubject ? fg : null,
    geom: hasSubject
      ? { width, height, minX, maxX, minY, maxY, count: fgCount }
      : null,
  };
}

/** 兼容旧调用：只取辅助特征（颜色与轮廓在 analyzeImage 里）。 */
export function extractFeatures(img: ImageData, srcAspect = 1): ImageFeatures {
  return analyzeImage(img, srcAspect).features;
}

/** 主色钳制到协调域（实现见 palette.ts，与随机生成器同一套约束）。 */
const clampBody = clampBodyHsl;

/** 无主体退回的形状映射：源图比例 + 中性圆形度，不碰边缘密度。 */
function shapeFallback(f: ImageFeatures): BodyShape {
  if (f.aspect > 1.25) return "wide";
  if (f.aspect < 0.8) return "tall";
  if (f.roundness > 0.6) return "round";
  return "box";
}

function eyeFor(f: ImageFeatures): EyeStyle {
  if (f.lightness > 0.72) return "big";
  if (f.lightness < 0.35) return "sleepy";
  return "classic";
}

function browFor(f: ImageFeatures): BrowStyle {
  // 边缘密度只保留这一个用途：复杂图的眉毛浓（辅助信号，不再决定形状）
  if (f.edgeDensity > 0.35) return "bushy";
  if (f.roundness > 0.6) return "arched";
  if (f.lightness < 0.35) return "slanted";
  return "flat";
}

function actionFor(f: ImageFeatures): ActionStyle {
  if (f.roundness > 0.6) return "bouncy";
  if (f.aspect > 1.25 || f.aspect < 0.8) return "curious";
  return "calm";
}

function pickDifferent<T>(list: readonly T[], current: T, rng: () => number): T {
  const rest = list.filter((v) => v !== current);
  return rest[Math.floor(rng() * rest.length)];
}

/**
 * 分析结果 → 3 个形象候选。
 *
 * 第 1 个是忠实映射（图片特征的直接翻译）；另 2 个保留主色（±30° 内）
 * 与特征件/纹理，微调形状/眼风维度，给用户「像但不一样」的选择。
 */
export function avatarFromAnalysis(
  a: ImageAnalysis,
  rng: () => number,
): PetAvatar[] {
  const body = clampBody(a.colors.primary);
  const secondary =
    a.colors.pattern !== "none" && a.colors.secondary
      ? hslToHex(clampBody(a.colors.secondary))
      : "";

  const shape =
    a.hasSubject && a.mask && a.geom
      ? classifyShape(a.mask, a.geom).shape
      : shapeFallback(a.features);
  const attachment =
    a.hasSubject && a.mask && a.geom
      ? classifyShape(a.mask, a.geom).attachment
      : "none";

  const faithful: PetAvatar = {
    shape,
    eyeStyle: eyeFor(a.features),
    browStyle: browFor(a.features),
    actionStyle: actionFor(a.features),
    bodyColor: hslToHex(body),
    accentColor: hslToHex(accentFor(body, rng)),
    attachment,
    pattern: a.colors.pattern,
    secondaryColor: secondary,
  };

  // 变体 A：主色与特征件/纹理不变，形状与眼风换不同项
  const variantA: PetAvatar = {
    ...faithful,
    shape: pickDifferent(BODY_SHAPES, faithful.shape, rng),
    eyeStyle: pickDifferent(EYE_STYLES, faithful.eyeStyle, rng),
    browStyle: pickDifferent(BROW_STYLES, faithful.browStyle, rng),
    accentColor: hslToHex(accentFor(body, rng)),
  };

  // 变体 B：主色色相偏移 15°..30°，形状/眼风随机但保证组合不撞车
  const shifted: Hsl = {
    ...body,
    h: (body.h + (rng() < 0.5 ? -1 : 1) * (15 + rng() * 15) + 360) % 360,
  };
  let variantB: PetAvatar = faithful;
  for (let guard = 0; guard < 50; guard++) {
    const s = BODY_SHAPES[Math.floor(rng() * BODY_SHAPES.length)];
    const e = EYE_STYLES[Math.floor(rng() * EYE_STYLES.length)];
    const clash =
      (s === faithful.shape && e === faithful.eyeStyle) ||
      (s === variantA.shape && e === variantA.eyeStyle);
    if (clash) continue;
    variantB = {
      ...faithful,
      shape: s,
      eyeStyle: e,
      browStyle: BROW_STYLES[Math.floor(rng() * BROW_STYLES.length)],
      bodyColor: hslToHex(shifted),
      accentColor: hslToHex(accentFor(shifted, rng)),
    };
    break;
  }

  return [faithful, variantA, variantB];
}

/** 旧入口：无轮廓信息的特征映射（等价于无主体退回路径）。 */
export function avatarFromFeatures(
  f: ImageFeatures,
  rng: () => number,
): PetAvatar[] {
  return avatarFromAnalysis(
    {
      features: f,
      colors: { primary: f.dominant, secondary: null, pattern: "none" },
      hasSubject: false,
      mask: null,
      geom: null,
    },
    rng,
  );
}

/**
 * 图片文件 → 3 个形象候选（弹窗「从图片生成」入口的回调实现）。
 *
 * createImageBitmap 解码后缩样到 32×32，全程本地、无网络。
 */
export async function analyzeImageFile(file: File): Promise<PetAvatar[]> {
  const bmp = await createImageBitmap(file);
  try {
    const aspect = bmp.width / Math.max(1, bmp.height);
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2d context unavailable");
    ctx.drawImage(bmp, 0, 0, SAMPLE, SAMPLE);
    const img = ctx.getImageData(0, 0, SAMPLE, SAMPLE);
    return avatarFromAnalysis(analyzeImage(img, aspect), Math.random);
  } finally {
    bmp.close();
  }
}
