import type { Attachment, BodyShape } from "./types";

/**
 * 轮廓几何分析：把 32×32 前景 mask 分类为身体形状 + 顶部特征件。
 *
 * 设计要点：
 * - 形状用「包围盒几何 + 凸性 + 圆形度」决策树，不用边缘密度
 *   （照片纹理天然高边缘密度，绝对阈值会让一切落入 blob —— 这是
 *   上一版「全是史莱姆」的根因）。
 * - 特征件用 skyline 分析（每列最上前景行）：头顶轮廓的向上凸起即
 *   耳朵/角/触角。相比投影计数，skyline 不会被圆顶弧度桥接 ——
 *   双耳之间的谷在 skyline 上必然显现。
 * - 形状分类作用于「剥离特征件后的主体区域」，否则猫耳会把圆身
 *   带偏成水滴（顶行只剩耳尖）。
 */

export interface MaskGeom {
  width: number;
  height: number;
  /** 前景包围盒（像素坐标，含端点）。 */
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  /** 前景像素总数。 */
  count: number;
}

export interface ShapeVerdict {
  shape: BodyShape;
  attachment: Attachment;
}

interface Peak {
  /** 起始列（相对 bbox）。 */
  from: number;
  /** 结束列（含）。 */
  to: number;
  /** 凸起高度（主体顶线 - 该段最上沿）。 */
  height: number;
  /** 中心列的相对位置 0..1。 */
  center: number;
  /** 是否触及 bbox 左右边缘。 */
  touchEdge: boolean;
}

interface Skyline {
  peaks: Peak[];
  /** 主体顶线（绝对 y）：中央列最上行的中位数。 */
  bodyLine: number;
}

/**
 * skyline 分析：每列最上前景行 + 主体顶线 + 凸起段。
 *
 * 主体顶线取中央 30% 列的中位数（头顶轮廓基准）；skyline 显著高于
 * 顶线（≥2px）的连续列段即凸起。
 */
function skyline(mask: Uint8Array, g: MaskGeom, bw: number): Skyline {
  const top: number[] = new Array(bw).fill(Infinity);
  for (let x = g.minX; x <= g.maxX; x++) {
    for (let y = g.minY; y <= g.maxY; y++) {
      if (mask[y * g.width + x]) {
        top[x - g.minX] = y;
        break;
      }
    }
  }

  const finite = top.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { peaks: [], bodyLine: g.minY };

  const from = Math.floor(bw * 0.35);
  const to = Math.ceil(bw * 0.65);
  const centerCols = top.slice(from, to).filter((v) => Number.isFinite(v));
  const pool = centerCols.length > 0 ? centerCols : finite;
  const sorted = [...pool].sort((a, b) => a - b);
  const bodyLine = sorted[Math.floor(sorted.length / 2)];

  const peaks: Peak[] = [];
  let cur: { from: number; minTop: number } | null = null;
  const flush = (toCol: number): void => {
    if (!cur) return;
    peaks.push({
      from: cur.from,
      to: toCol,
      height: bodyLine - cur.minTop,
      center: (cur.from + toCol) / 2 / bw,
      touchEdge: cur.from <= 1 || toCol >= bw - 2,
    });
    cur = null;
  };
  for (let c = 0; c < bw; c++) {
    const isPeak = Number.isFinite(top[c]) && top[c] <= bodyLine - 2;
    if (isPeak) {
      if (!cur) cur = { from: c, minTop: top[c] };
      else cur.minTop = Math.min(cur.minTop, top[c]);
    } else {
      flush(c - 1);
    }
  }
  flush(bw - 1);

  return { peaks, bodyLine };
}

/** 特征件分类：双峰按位置/高度分 horns/pointy-ears/ears，孤立居中细峰为 antenna。 */
function attachmentFor(peaks: Peak[], bw: number, bh: number): Attachment {
  if (peaks.length === 0) return "none";

  if (peaks.length === 1) {
    const p = peaks[0];
    const wRatio = (p.to - p.from + 1) / bw;
    // 孤立、细、居中、有一定高度 → 触角
    if (wRatio <= 0.14 && p.center > 0.35 && p.center < 0.65 && p.height >= 3) {
      return "antenna";
    }
    return "none";
  }

  const top2 = [...peaks].sort((a, b) => b.height - a.height).slice(0, 2);
  // 双尖触及轮廓边缘 → 角
  if (
    top2.every((p) => p.touchEdge) &&
    top2.every((p) => p.height >= bh * 0.15)
  ) {
    return "horns";
  }
  // 高窄 → 尖耳；矮宽 → 圆耳
  if (top2.every((p) => p.height >= Math.max(3, bh * 0.15))) {
    return "pointy-ears";
  }
  return "ears";
}

/** 主体几何特征（剥离特征件后）。 */
interface BodyGeom {
  bw: number;
  bh: number;
  count: number;
  aspect: number;
  /** 顶行宽度占主体宽比例。 */
  topRowRatio: number;
  /** 底 20% 行均宽 / 顶 20% 行均宽。 */
  bottomTop: number;
  /** 面积占比与 π/4 的接近程度 0..1。 */
  roundness: number;
}

function measureBody(mask: Uint8Array, g: MaskGeom, bodyLine: number): BodyGeom {
  // 主体区域：bodyLine 起到底部（特征件在其上）
  let minX = g.width;
  let maxX = -1;
  let count = 0;
  for (let y = bodyLine; y <= g.maxY; y++) {
    for (let x = g.minX; x <= g.maxX; x++) {
      if (!mask[y * g.width + x]) continue;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
    }
  }
  if (count === 0) {
    return {
      bw: 1, bh: 1, count: 0, aspect: 1, topRowRatio: 1,
      bottomTop: 1, roundness: 0,
    };
  }

  const bw = maxX - minX + 1;
  const bh = g.maxY - bodyLine + 1;
  const aspect = bw / bh;

  let topRowW = 0;
  for (let x = minX; x <= maxX; x++) {
    if (mask[bodyLine * g.width + x]) topRowW++;
  }

  const band = Math.max(1, Math.floor(bh * 0.2));
  let topW = 0;
  let bottomW = 0;
  for (let y = 0; y < band; y++) {
    for (let x = minX; x <= maxX; x++) {
      if (mask[(bodyLine + y) * g.width + x]) topW++;
      if (mask[(g.maxY - y) * g.width + x]) bottomW++;
    }
  }
  topW /= band;
  bottomW /= band;

  const ratio = count / (bw * bh);
  const roundness = Math.max(
    0,
    1 - Math.abs(ratio - Math.PI / 4) / (1 - Math.PI / 4),
  );

  return {
    bw,
    bh,
    count,
    aspect,
    topRowRatio: topRowW / bw,
    bottomTop: topW > 0 ? bottomW / topW : 1,
    roundness,
  };
}

/**
 * 形状 + 特征件分类。
 *
 * 决策树顺序即优先级，所有阈值由合成 mask 用例标定
 * （tests/avatar-shape-analysis.test.ts）。
 */
export function classifyShape(mask: Uint8Array, g: MaskGeom): ShapeVerdict {
  const bw = g.maxX - g.minX + 1;
  const bh = g.maxY - g.minY + 1;
  const sky = skyline(mask, g, bw);
  const attachment = attachmentFor(sky.peaks, bw, bh);
  // 无附件时不剥离：居中宽峰（水滴尖顶）本身就是主体，剥了轮廓就没了
  const bodyLine = attachment === "none" ? g.minY : sky.bodyLine;
  const body = measureBody(mask, g, bodyLine);

  if (body.aspect > 1.3) return { shape: "wide", attachment };
  if (body.aspect < 0.75) return { shape: "tall", attachment };

  // 顶尖底圆 → 水滴（先于其他分支，否则被蘑菇/史莱姆截胡）
  if (body.topRowRatio < 0.2 && body.bottomTop > 1.6) {
    return { shape: "drop", attachment };
  }
  // 平顶宽肩、底宽顶窄 → 蘑菇
  if (body.bottomTop > 1.4 && body.topRowRatio >= 0.4) {
    return { shape: "shroom", attachment };
  }
  if (body.roundness > 0.6) return { shape: "round", attachment };
  // 近满幅的低圆度 → 方块；中间地带（圆顶小头的有机形）→ 史莱姆
  if (body.roundness < 0.35) return { shape: "box", attachment };
  return { shape: "blob", attachment };
}
