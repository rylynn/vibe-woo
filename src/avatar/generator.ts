import {
  ACTION_STYLES,
  ATTACHMENTS,
  BODY_SHAPES,
  BROW_STYLES,
  EYE_STYLES,
  type Pattern,
  type PetAvatar,
} from "./types";
import {
  accentFor,
  bodyHslFor,
  clampBodyHsl,
  harmoniousHues,
  hslToHex,
} from "./palette";

function pick<T>(list: readonly T[], rng: () => number): T {
  return list[Math.floor(rng() * list.length)];
}

/**
 * 随机生成一批差异化形象候选。
 *
 * 差异化约束（肉眼最敏感的两个维度）：任意两候选的形状与眼睛风格组合
 * 不重复；主色色相两两间隔 ≥60° 避免撞色。配色约束见 palette.ts。
 *
 * @param rng 注入的随机源（0..1），测试用确定性 RNG 保证可复现
 * @param count 候选数量，默认 3（首次安装的三选一场景）
 */
export function generateCandidates(rng: () => number, count = 3): PetAvatar[] {
  const hues = harmoniousHues(rng, count, 62);
  const out: PetAvatar[] = [];
  const used = new Set<string>();
  let guard = 0;
  while (out.length < count && guard++ < 500) {
    const shape = pick(BODY_SHAPES, rng);
    const eyeStyle = pick(EYE_STYLES, rng);
    const key = `${shape}/${eyeStyle}`;
    if (used.has(key)) continue;
    used.add(key);
    const body = bodyHslFor(hues[out.length], rng);
    // 特征件/纹理低概率入池：点缀性质，不该喧宾夺主
    const attachment =
      rng() < 0.25 ? pick(ATTACHMENTS.slice(1), rng) : "none";
    const pattern: Pattern =
      rng() < 0.2 ? (rng() < 0.5 ? "stripes" : "spots") : "none";
    out.push({
      shape,
      eyeStyle,
      browStyle: pick(BROW_STYLES, rng),
      actionStyle: pick(ACTION_STYLES, rng),
      bodyColor: hslToHex(body),
      accentColor: hslToHex(accentFor(body, rng)),
      attachment,
      pattern,
      // 纹理次色：与点缀色同族的协调色，亮度压回主色域
      secondaryColor:
        pattern === "none"
          ? ""
          : hslToHex(clampBodyHsl(accentFor(body, rng))),
    });
  }
  return out;
}
