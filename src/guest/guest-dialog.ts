import type { Box } from "../interact/hit-test";
import { Bubble } from "../overlay/bubble";
import type { GuestPet } from "./guest-pet";

/** 一只访客最多主动说三轮，之后就安静待着 —— 客人喋喋不休会很烦。 */
const MAX_ROUNDS = 3;
/** 两句之间的间隔：25–40 秒，随机。 */
const GAP_MIN_MS = 25_000;
const GAP_JITTER_MS = 15_000;
/** 访客说完后，主人隔多久回应。 */
const REPLY_DELAY_MS = 2_500;
/** 单句气泡停留时长。 */
const LINE_MS = 5_000;

/** 进门第一句。 */
const GUEST_HELLO: readonly string[] = [
  "（探头探脑地进了门）",
  "（在门口张望）有人在家吗",
  "（蹦进来）我来做客啦",
  "（溜达进来）你家真不错",
];

/** 待下来之后的闲聊。 */
const GUEST_CHAT: readonly string[] = [
  "（转了一圈）这个角落挺舒服",
  "（凑过来看了看你）在忙什么呢",
  "（趴下来）我待一会儿就走",
  "（打了个哈欠）外面有点冷",
  "（用爪子碰了碰你）诶，听说今天有八卦",
  "（盯着屏幕看了一会儿）看不懂，但感觉很厉害",
  "（原地转了个圈）你家比我家整齐",
  "（小声）我偷偷来的，别告诉我主人",
];

/** 主人的回应。刻意都是动作型 —— 不替用户说话，那是 LLM 的活。 */
const HOST_REPLY: readonly string[] = [
  "（挪了挪窝，给你腾了个位置）",
  "（摇了摇尾巴）",
  "（走过去挨着坐下）",
  "（假装没看见，其实看见了）",
  "（耳朵动了动）",
  "（用头顶了顶你）",
];

function pick(pool: readonly string[]): string {
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 访客与主人的对话编排。
 *
 * 节奏刻意克制：进门一句、之后每 25–40 秒一句、主人回一句、
 * 满三轮就闭嘴。桌宠是陪着的，不是在开派对。
 *
 * 每只访客一个独立气泡（Bubble 用的是类选择器，多实例互不干扰）。
 */
export class GuestDialog {
  private readonly bubbles = new Map<string, Bubble>();
  /** uid → 下一句的绝对时刻。 */
  private readonly nextAt = new Map<string, number>();
  /** uid → 已经聊了几轮。 */
  private readonly rounds = new Map<string, number>();
  /** 主人待回复的一句话。 */
  private pending: { uid: string; at: number } | null = null;

  constructor(private readonly hostSay: (text: string) => void) {}

  /** 新访客进门：说开场白，并开始计下一句。 */
  onArrive(g: GuestPet, nowMs: number): void {
    const b = this.bubbleFor(g.seed.uid);
    b.show(pick(GUEST_HELLO), { autoDismissMs: LINE_MS });
    b.follow(g.body);
    this.rounds.set(g.seed.uid, 1);
    this.nextAt.set(g.seed.uid, nowMs + GAP_MIN_MS + Math.random() * GAP_JITTER_MS);
  }

  /** 访客离开：收掉它的气泡与计时。 */
  onLeave(uid: string): void {
    this.nextAt.delete(uid);
    this.rounds.delete(uid);
    if (this.pending?.uid === uid) this.pending = null;
    const b = this.bubbles.get(uid);
    if (b) {
      b.dismiss();
      b.destroy();
      this.bubbles.delete(uid);
    }
  }

  /** 每帧推进：气泡跟随、到点说话、主人回应。 */
  tick(nowMs: number, guests: readonly GuestPet[]): void {
    for (const g of guests) {
      const b = this.bubbles.get(g.seed.uid);
      if (b?.isOpen) b.follow(g.body);
    }

    // 主人的回应：访客还在才回，人走了就不自言自语
    if (this.pending && nowMs >= this.pending.at) {
      const still = guests.some((g) => g.seed.uid === this.pending?.uid);
      if (still) this.hostSay(pick(HOST_REPLY));
      this.pending = null;
    }

    for (const g of guests) {
      const uid = g.seed.uid;
      const at = this.nextAt.get(uid);
      if (at === undefined || nowMs < at) continue;

      const round = this.rounds.get(uid) ?? 0;
      if (round >= MAX_ROUNDS) {
        this.nextAt.delete(uid); // 说够了，安静待着
        continue;
      }

      const b = this.bubbleFor(uid);
      b.show(pick(GUEST_CHAT), { autoDismissMs: LINE_MS });
      b.follow(g.body);
      this.rounds.set(uid, round + 1);
      this.nextAt.set(uid, nowMs + GAP_MIN_MS + Math.random() * GAP_JITTER_MS);
      this.pending = { uid, at: nowMs + REPLY_DELAY_MS };
    }
  }

  /** 命中上报用：访客气泡也是可点的（点它关闭）。 */
  get boxes(): Box[] {
    const out: Box[] = [];
    for (const b of this.bubbles.values()) {
      const box = b.box;
      if (box) out.push(box);
    }
    return out;
  }

  /** 是否有气泡打开（用于穿透 lock 判定）。 */
  get hasOpenBubble(): boolean {
    for (const b of this.bubbles.values()) {
      if (b.isOpen) return true;
    }
    return false;
  }

  clear(): void {
    for (const uid of [...this.bubbles.keys()]) this.onLeave(uid);
    this.pending = null;
  }

  private bubbleFor(uid: string): Bubble {
    let b = this.bubbles.get(uid);
    if (!b) {
      // 访客气泡换个颜色：否则和主宠物的气泡一模一样，分不清谁在说话
      b = new Bubble("pet-bubble-guest");
      this.bubbles.set(uid, b);
    }
    return b;
  }
}
