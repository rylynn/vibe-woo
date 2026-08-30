import {
  ACTION_STYLES,
  BODY_SHAPES,
  BROW_STYLES,
  EYE_STYLES,
  type PetAvatar,
} from "./types";
import { accentFor, bodyHslFor, harmoniousHues, hslToHex } from "./palette";

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
    out.push({
      shape,
      eyeStyle,
      browStyle: pick(BROW_STYLES, rng),
      actionStyle: pick(ACTION_STYLES, rng),
      bodyColor: hslToHex(body),
      accentColor: hslToHex(accentFor(body, rng)),
    });
  }
  return out;
}
