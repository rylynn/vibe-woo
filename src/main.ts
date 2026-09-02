import { Pet, SIZE_STEPS, type RewardEffect } from "./pet";
import { startBoxReporter, requestQuit, type EventCounters } from "./bridge";
import type { Box } from "./interact/hit-test";
import { ContextMenu } from "./overlay/context-menu";
import { SettingsPanel } from "./overlay/settings";
import { AboutPanel } from "./overlay/about";
import { QuickNote, onQuickNoteOpen } from "./overlay/quick-note";
import { TodayPanel } from "./overlay/today";
import { Bubble, Banner } from "./overlay/bubble";
import {
  RemindersPanel,
  onReminderFired,
  onReminderPanelOpen,
  refreshTimeDatalist,
} from "./overlay/reminders";
import {
  FriendsPanel,
  onFriendsUpdate,
  onSocialEvent,
  onAwayChange,
} from "./overlay/friends";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { DismissManager } from "./overlay/dismiss";
import { onStateChange } from "./state";
import { describe as describeState } from "./appearance";
import { getConfig, updateConfig, type ConfigView } from "./config";
import { AvatarPicker } from "./overlay/avatar-picker";
import { avatarFromView, avatarToView } from "./avatar/types";
import { analyzeImageFile } from "./avatar/from-image";
import { PluginHubPanel } from "./plugins/hub";
import { pomodoroFrontend } from "./plugins/cards/pomodoro";
import { wordFrontend } from "./plugins/cards/word";
import { newsFrontend } from "./plugins/cards/news";
import { stockFrontend } from "./plugins/cards/stock";
import {
  getPluginFrontend,
  registerPlugin,
  type CardHost,
  type PluginCard,
} from "./plugins/registry";

const canvas = document.getElementById("pet-canvas") as HTMLCanvasElement | null;
if (!canvas) throw new Error("#pet-canvas not found");

const ctx = canvas.getContext("2d");
if (!ctx) throw new Error("2d context unavailable");
const ctx2d: CanvasRenderingContext2D = ctx;

const pet = new Pet(canvas, ctx2d);

// 预建时间下拉建议：通知卡片上的「改时间」输入也要用它
refreshTimeDatalist();

function applyConfig(c: ConfigView): void {
  pet.setSizeIndex(c.size_index);
  pet.setScope(c.roam_scope);
  if (c.avatar) pet.setAvatar(avatarFromView(c.avatar));
}

// 首次安装领养流程：确认后持久化并立即换装
const avatarPicker = new AvatarPicker({
  onConfirm: (a) => {
    pet.setAvatar(a);
    void updateConfig({ avatar: avatarToView(a) });
  },
  analyzeImage: analyzeImageFile,
});

const about = new AboutPanel();

const settings = new SettingsPanel(
  applyConfig,
  {
    openPicker: (initial) => {
      // 弹窗与设置面板不叠放：先关设置，选定后改动已由 picker 持久化
      settings.hide();
      avatarPicker.show(initial);
    },
    analyzeImage: analyzeImageFile,
  },
  // 关于是设置的二级面板：两个面板都居中，叠放会互相遮挡，进二级先收一级
  () => {
    settings.hide();
    void about.show(() => void settings.show());
  },
);

const quickNote = new QuickNote();
const today = new TodayPanel();

// 速记仪式感：呼出时宠物走过来，落盘后点头示意收到
quickNote.onOpen = () => {
  const c = quickNote.center;
  if (c) pet.summonTo(c.x);
};
quickNote.onSaved = () => {
  pet.finishSummon();
};

const menu = new ContextMenu([
  { label: "记一笔  (⌥Space)", onPick: () => void quickNote.show() },
  { label: "每日提醒  (⌥R)", onPick: () => void remindersPanel.show() },
  { label: "好友", onPick: () => void friendsPanel.show() },
  { label: "今日速记", onPick: () => void today.show() },
  { label: "设置", onPick: () => void settings.show() },
  { label: "退出 Vibe Pet", onPick: () => requestQuit() },
]);

const bubble = new Bubble();
const banner = new Banner();
const remindersPanel = new RemindersPanel(() => {});
const friendsPanel = new FriendsPanel();

// 插件卡片的受控操作：openUrl 由 P4 接 opener 插件（当前 window.open 兜底），
// markTerm 走 SRS 反馈命令并顺手收起气泡。渲染器不直接 invoke（registry.ts 的约定）。
const cardHost: CardHost = {
  openUrl: (url) => {
    try {
      window.open(url, "_blank");
    } catch {
      // webview 拦截时静默 —— 跳不出去不是值得弹窗的事
    }
  },
  markTerm: (term, known) => {
    void invoke("words_feedback", { term, known }).catch((e) =>
      console.warn("[words] 反馈失败", e),
    );
    bubble.dismiss();
  },
};

// 左键插件面板：单击宠物打开（设计文档 7.3）
const hub = new PluginHubPanel(cardHost);

// 注册内建插件的前端渲染器（气泡卡 / 面板分区 / 设置表单）
registerPlugin("pomodoro", pomodoroFrontend);
registerPlugin("words", wordFrontend);
registerPlugin("news", newsFrontend);
registerPlugin("stocks", stockFrontend);

const dismiss = new DismissManager();
dismiss.register(menu);
dismiss.register(settings);
dismiss.register(about);
dismiss.register(quickNote);
dismiss.register(today);
dismiss.register(remindersPanel);
dismiss.register(friendsPanel);
dismiss.register(avatarPicker);
dismiss.register(hub);
dismiss.setPetBox(() => (pet.isHidden ? null : pet.body));

const counters: EventCounters = {
  down: 0,
  move: 0,
  up: 0,
  cancel: 0,
  orphanDrag: 0,
};

/** 判定「单击（开插件面板）」与「拖动」的位移阈值（CSS 像素）。 */
const CLICK_SLOP_PX = 6;
/** 本次按下的起点（命中宠物时记录，pointerup 时消费后清空）。 */
let petPress: { x: number; y: number } | null = null;

function fit(): void {
  pet.resize(window.innerWidth, window.innerHeight);
  // resize 会重置 canvas 尺寸，进而清空 imageSmoothingEnabled，需重设
  ctx2d.imageSmoothingEnabled = false;
}
fit();
window.addEventListener("resize", fit);

window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (settings.isOpen || about.isOpen) return;
  if (pet.hitTest(e.clientX, e.clientY)) {
    menu.show(e.clientX, e.clientY);
  } else {
    menu.hide();
  }
});

window.addEventListener("pointerdown", (e) => {
  counters.down++;
  // 点面板之外即关闭 —— 通用直觉
  dismiss.handlePointerDown(e.clientX, e.clientY);
  if (menu.isOpen && !menu.contains(e.clientX, e.clientY)) {
    menu.hide();
  }
  // 右键不触发拖动
  if (e.button !== 0) return;
  // 设置面板打开时不响应宠物拖动，避免点面板时把宠物一起拖走
  if (settings.isOpen && settings.contains(e.clientX, e.clientY)) return;
  if (avatarPicker.isOpen && avatarPicker.contains(e.clientX, e.clientY))
    return;
  if (about.isOpen && about.contains(e.clientX, e.clientY)) return;
  if (quickNote.isOpen) return;
  if (today.isOpen && today.contains(e.clientX, e.clientY)) return;
  if (today.isOpen && !today.contains(e.clientX, e.clientY)) today.hide();
  if (remindersPanel.isOpen && remindersPanel.contains(e.clientX, e.clientY))
    return;
  if (friendsPanel.isOpen && friendsPanel.contains(e.clientX, e.clientY))
    return;
  // 点气泡/通知条内部不拖宠物 —— 气泡按钮、通知条点击关闭由其自身处理
  if (bubble.isOpen && bubble.contains(e.clientX, e.clientY)) return;
  if (banner.isOpen && banner.contains(e.clientX, e.clientY)) return;
  const hit = pet.pointerDown(e.clientX, e.clientY);
  // 命中宠物时记下起点，pointerup 时按位移区分单击（开面板）与拖动
  if (hit) petPress = { x: e.clientX, y: e.clientY };
  // 点击/拖动需要立刻起帧（自调度循环可能正在 idle 档熟睡）
  wakeFrame();
});

window.addEventListener("pointermove", (e) => {
  counters.move++;
  // 关键健壮性：不依赖 pointerup 结束拖动。
  // macOS 上非 key window 的 webview 可能收不到 pointerup，
  // 那会让拖动永久卡住、进而让穿透永久失效（锁死桌面）。
  // buttons===0 说明所有键已松开，无论 up 是否到达都必须结束拖动。
  if (e.buttons === 0 && pet.isDragging) {
    counters.orphanDrag++;
    pet.pointerUp();
    return;
  }
  pet.pointerMove(e.clientX, e.clientY);
  // 拖动/视线跟随需要立刻起帧；穿透时不会收到该事件，无高频风险
  wakeFrame();
});

window.addEventListener("pointerup", (e) => {
  counters.up++;
  const press = petPress;
  petPress = null;
  pet.pointerUp();
  // 按下与抬起位移极小 → 单击：切换插件面板；拖动（位移大）不触发
  if (
    press &&
    Math.hypot(e.clientX - press.x, e.clientY - press.y) < CLICK_SLOP_PX
  ) {
    void hub.toggle();
  }
});

window.addEventListener("pointercancel", () => {
  counters.cancel++;
  pet.pointerUp();
});

// 窗口失去焦点时也要结束拖动，否则切走再切回来宠物仍黏在鼠标上
window.addEventListener("blur", () => {
  pet.pointerUp();
  menu.hide();
});

// Esc 关闭所有面板。必须用捕获阶段：速记/提醒/好友等面板的输入框
// 会在冒泡阶段 stopPropagation，若挂在冒泡阶段则 Esc 永远到不了这里。
// 捕获先于目标元素触发，一处覆盖全部面板。
window.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Escape") {
      menu.hide();
      settings.hide();
      about.hide();
      quickNote.hide();
      today.hide();
      remindersPanel.hide();
      friendsPanel.hide();
      avatarPicker.hide();
      hub.hide();
      bubble.dismiss();
      banner.dismiss();
    }
  },
  true,
);

// Alt+Space 呼出速记窗；已打开时再按同一快捷键关闭，与 Esc 等效
void onQuickNoteOpen(() => {
  if (quickNote.isOpen) {
    quickNote.hide();
  } else {
    void quickNote.show();
  }
});

// Alt+R 呼出提醒面板，toggle 逻辑与速记一致
void onReminderPanelOpen(() => {
  if (remindersPanel.isOpen) {
    remindersPanel.hide();
  } else {
    void remindersPanel.show();
  }
});

// 接收 Rust 传感器推送的状态。宠物的表情、配色、呼吸节奏都由它驱动。
void onStateChange((s) => {
  pet.applyState(s);
  // 表情已变：立即起帧，不等下一个帧率预算周期
  wakeFrame();
  console.log(`[pet] ${describeState(s)}  kpm=${Math.round(s.keystrokes_per_min)}`);
});

// 载入持久化配置；首次安装（未领养形象）弹出三选一
void getConfig().then((c) => {
  applyConfig(c);
  if (!c.avatar) avatarPicker.show();
});

startBoxReporter(() => {
  const boxes: Box[] = [];
  if (!pet.isHidden) boxes.push(pet.body);
  if (awayIcon.style.display !== "none") {
    const r = awayIcon.getBoundingClientRect();
    if (r.width > 0) boxes.push({ x: r.left, y: r.top, w: r.width, h: r.height });
  }
  const menuBox = menu.box;
  if (menuBox) boxes.push(menuBox);
  const settingsBox = settings.box;
  if (settingsBox) boxes.push(settingsBox);
  const errorBox = settings.errorBox;
  if (errorBox) boxes.push(errorBox);
  const aboutBox = about.box;
  if (aboutBox) boxes.push(aboutBox);
  const noteBox = quickNote.box;
  if (noteBox) boxes.push(noteBox);
  const todayBox = today.box;
  if (todayBox) boxes.push(todayBox);
  const remindersBox = remindersPanel.box;
  if (remindersBox) boxes.push(remindersBox);
  const friendsBox = friendsPanel.box;
  if (friendsBox) boxes.push(friendsBox);
  const pickerBox = avatarPicker.box;
  if (pickerBox) boxes.push(pickerBox);
  const hubBox = hub.box;
  if (hubBox) boxes.push(hubBox);
  // 气泡与通知条：可交互（「知道了」按钮 / 整条点击关闭），必须参与命中判定
  const bubbleBox = bubble.box;
  if (bubbleBox) boxes.push(bubbleBox);
  const bannerBox = banner.box;
  if (bannerBox) boxes.push(bannerBox);
  return {
    boxes,
    lock:
      pet.isDragging ||
      menu.isOpen ||
      settings.isOpen ||
      about.isOpen ||
      quickNote.isOpen ||
      today.isOpen ||
      remindersPanel.isOpen ||
      friendsPanel.isOpen ||
      avatarPicker.isOpen ||
      hub.isOpen ||
      bubble.isOpen ||
      banner.isOpen,
    counters,
    motion: pet.currentMotion,
    scope: pet.scopeValue,
  };
});

// 好友状态与串门事件
void onFriendsUpdate((list) => friendsPanel.setFriends(list));
void onSocialEvent((e) => {
  if (e.event.type === "visit" && e.event.from_nick) {
    bubble.show(`${e.event.from_nick} 的宠物来串门了`, {
      confirmLabel: "打个招呼",
      autoDismissMs: 30_000,
    });
  } else if (e.event.type === "interaction" && e.event.from_nick) {
    bubble.show(`被 ${e.event.from_nick} 摸了 ${e.event.pats ?? 1} 下`, {
      autoDismissMs: 6000,
    });
  }
});

// —— 宠物不在家：缩到右下角图标，噤声，点图标召回 ——
const awayIcon = document.createElement("div");
awayIcon.className = "pet-away-icon";
awayIcon.style.display = "none";
awayIcon.textContent = "🐾 不在家";
awayIcon.title = "宠物去好友家串门了 · 点击召回";
awayIcon.addEventListener("pointerdown", (e) => {
  e.stopPropagation();
  void invoke("return_home").then(() => {
    // 服务端已确认；本地状态由 home-away 事件回置（自动到期也会触发）
  });
});
document.body.appendChild(awayIcon);

void onAwayChange((n) => {
  pet.setHidden(n.away);
  // 宠物走了：贴它身上的通知没了依托，收掉（右上角提醒卡片不受影响）
  if (n.away) banner.releaseFromPet();
  awayIcon.style.display = n.away ? "flex" : "none";
  if (n.away && n.at_nick) {
    awayIcon.textContent = `🐾 在 ${n.at_nick} 家`;
    awayIcon.title = "点击召回宠物";
  } else {
    awayIcon.textContent = "🐾 不在家";
  }
});

// 宠物说话：气泡展示，8 秒后自动消失（无人互动也别一直挂着）。
// 不在家时不展示 —— 人不在家就不说话（Rust 侧同样噤声，这里是双保险）。
void listen<{ text: string; source: "llm" | "local" }>("pet://talk", (e) => {
  if (pet.isHidden) return;
  bubble.show(e.payload.text, {
    autoDismissMs: 8000,
    ai: e.payload.source === "llm",
  });
}).catch(() => {});

// 插件卡片：按 kind 找渲染器画进气泡。未知 kind 丢弃
//（前端版本落后于插件时向前兼容）。不在家时不展示。
void listen<PluginCard>("pet://plugin-card", (e) => {
  const card = e.payload;
  if (pet.isHidden) return;
  const fe = getPluginFrontend(card.kind);
  if (!fe) return;
  const el = fe.renderCard(card, cardHost);
  bubble.showCard(el, { autoDismissMs: card.ttl_secs * 1000 });
}).catch(() => {});

/**
 * 贴着宠物头顶的通知条。
 *
 * 宠物相关的通知就该长在宠物身上 —— 固定在右上角会让人找不着是谁在说话。
 * 宠物不在家（去串门）时没有身体可贴，退回右上角，至少不丢消息。
 */
function notifyNearPet(text: string): void {
  if (pet.isHidden) {
    banner.show(text);
    return;
  }
  banner.show(text, undefined, { followPet: true });
  // 立刻定位一次，避免上屏第一帧先闪在右上角
  banner.follow(pet.body);
}

// —— 番茄工作法已迁为插件：阶段通知走 pet://plugin-card（见上方监听） ——

// —— 今日特效奖励：认真休息所得，隔天失效（池子 10 种） ——
interface RewardsEvent {
  effects: string[];
  granted: string | null;
}
const REWARD_LABELS: Record<string, string> = {
  tomato: "吃番茄 🍅",
  bubbles: "吐泡泡 🫧",
  sparkle: "星星闪 ✨",
  leaf: "头顶小芽 🌱",
  halo: "头顶光环 😇",
  crown: "小王冠 👑",
  music: "飘音符 🎵",
  heart: "冒爱心 💗",
  fire: "身后燃 🔥",
  glasses: "小眼镜 👓",
};
void listen<RewardsEvent>("pet://rewards", (e) => {
  // 未知特效名丢弃（前端老、后端新时向前兼容）
  pet.setEffects(
    e.payload.effects.filter((x): x is RewardEffect => x in REWARD_LABELS),
  );
  if (e.payload.granted) {
    // 刚获得新特效：宠物高兴地宣布（重要时刻，用通知条）
    notifyNearPet(
      `认真休息奖励到手：今天我会${REWARD_LABELS[e.payload.granted] ?? "有新特效"}（明天失效）`,
    );
  }
}).catch(() => {});

// 提醒触发：统一走右上角大卡片（带操作），比小气泡更醒目，
// 且能直接删除 / 稍后再提醒 / 改时间，不用再打开提醒面板
void onReminderFired((r) => {
  banner.showReminder(r, {
    onDelete: async (index) => {
      const cfg = await getConfig();
      await updateConfig({
        reminders: cfg.reminders.filter((_, i) => i !== index),
      });
    },
    onSnooze: (index) => {
      void invoke("snooze_reminder", { index, mins: 10 }).catch((e) =>
        console.warn("[reminder] 稍后重响失败", e),
      );
    },
    onReschedule: async (index, time) => {
      const cfg = await getConfig();
      const rs = cfg.reminders.map((x, i) =>
        i === index ? { ...x, time } : x,
      );
      await updateConfig({ reminders: rs });
    },
  });
});

// —— 渲染主循环：按帧率预算自调度，不再以 60fps 空转 ——
//
// 原实现 rAF 每帧（60fps）执行 stepBehavior + follow，即使渲染预算只有
// idle 12fps / sleep 4fps —— 多出来的唤醒是 WebContent 进程常驻 CPU 的
// 大头。改为：绘制完一帧后按当前活跃度档位睡到下一拍；指针事件与状态
// 变更立即补拍唤醒，交互实时性不受影响。
//
// 穿透开启时 webview 收不到任何指针事件，无交互期的唤醒全部来自这里。
let frameScheduled = false;

function wakeFrame(): void {
  if (frameScheduled) return;
  frameScheduled = true;
  requestAnimationFrame(onFrame);
}

function onFrame(now: number): void {
  frameScheduled = false;
  const drew = pet.tick(now);
  // 气泡与贴宠物通知条跟随宠物身体：只在真正绘制了新画面时同步。
  // 位置量化到整数像素 —— 不绘制则位置必然未变，DOM 写纯属浪费。
  if (drew) {
    bubble.follow(pet.body);
    banner.follow(pet.body);
  }

  if (pet.isHidden) {
    // 不在家：零绘制零行为，500ms 一拍兜底；回家事件会立即唤醒
    setTimeout(wakeFrame, 500);
    return;
  }

  // 下一拍按活跃度档位调度：active 档（拖动/走动/眨眼）对齐显示刷新，
  // idle/sleep 档先睡够再拍。留 4ms 余量避免长期欠帧。
  const delay = pet.debugIntervalMs - (performance.now() - now) - 4;
  if (delay > 4) {
    setTimeout(wakeFrame, delay);
  } else {
    wakeFrame();
  }
}
wakeFrame();

// SIZE_STEPS 供调试查看当前档位含义
Object.assign(window as unknown as Record<string, unknown>, {
  __petSizes: SIZE_STEPS,
});
