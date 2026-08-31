import { Pet, SIZE_STEPS } from "./pet";
import { startBoxReporter, requestQuit, type EventCounters } from "./bridge";
import type { Box } from "./interact/hit-test";
import { ContextMenu } from "./overlay/context-menu";
import { SettingsPanel } from "./overlay/settings";
import { QuickNote, onQuickNoteOpen } from "./overlay/quick-note";
import { TodayPanel } from "./overlay/today";
import { Bubble, Banner } from "./overlay/bubble";
import {
  RemindersPanel,
  onReminderFired,
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

const settings = new SettingsPanel(applyConfig, {
  openPicker: (initial) => {
    // 弹窗与设置面板不叠放：先关设置，选定后改动已由 picker 持久化
    settings.hide();
    avatarPicker.show(initial);
  },
  analyzeImage: analyzeImageFile,
});

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
  { label: "每日提醒", onPick: () => void remindersPanel.show() },
  { label: "好友", onPick: () => void friendsPanel.show() },
  { label: "今日速记", onPick: () => void today.show() },
  { label: "设置", onPick: () => void settings.show() },
  { label: "退出 Vibe Pet", onPick: () => requestQuit() },
]);

const bubble = new Bubble();
const banner = new Banner();
const remindersPanel = new RemindersPanel(() => {});
const friendsPanel = new FriendsPanel();

const dismiss = new DismissManager();
dismiss.register(menu);
dismiss.register(settings);
dismiss.register(quickNote);
dismiss.register(today);
dismiss.register(remindersPanel);
dismiss.register(friendsPanel);
dismiss.register(avatarPicker);
dismiss.setPetBox(() => (pet.isHidden ? null : pet.body));

const counters: EventCounters = {
  down: 0,
  move: 0,
  up: 0,
  cancel: 0,
  orphanDrag: 0,
};

function fit(): void {
  pet.resize(window.innerWidth, window.innerHeight);
  // resize 会重置 canvas 尺寸，进而清空 imageSmoothingEnabled，需重设
  ctx2d.imageSmoothingEnabled = false;
}
fit();
window.addEventListener("resize", fit);

window.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  if (settings.isOpen) return;
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
  pet.pointerDown(e.clientX, e.clientY);
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
});

window.addEventListener("pointerup", () => {
  counters.up++;
  pet.pointerUp();
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

window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    menu.hide();
    settings.hide();
    quickNote.hide();
    today.hide();
    remindersPanel.hide();
    friendsPanel.hide();
    avatarPicker.hide();
  }
});

// Alt+Space 呼出速记窗；已打开时再按同一快捷键关闭，与 Esc 等效
void onQuickNoteOpen(() => {
  if (quickNote.isOpen) {
    quickNote.hide();
  } else {
    void quickNote.show();
  }
});

// 接收 Rust 传感器推送的状态。宠物的表情、配色、呼吸节奏都由它驱动。
void onStateChange((s) => {
  pet.applyState(s);
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
      quickNote.isOpen ||
      today.isOpen ||
      remindersPanel.isOpen ||
      friendsPanel.isOpen ||
      avatarPicker.isOpen ||
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

// —— 番茄工作法：阶段通知走右上角通知条（醒目但不挡操作）——
interface PomodoroEvent {
  phase: string;
  mins: number;
  text: string;
}
void listen<PomodoroEvent>("pet://pomodoro", (e) => {
  const { phase, text } = e.payload;
  if (phase === "break_start") {
    banner.show(text);
  } else {
    bubble.show(text, { autoDismissMs: 8000 });
  }
}).catch(() => {});

// —— 今日特效奖励：认真休息所得，隔天失效 ——
interface RewardsEvent {
  effects: ("tomato" | "bubbles" | "sparkle")[];
  granted: "tomato" | "bubbles" | "sparkle" | null;
}
const REWARD_LABELS: Record<string, string> = {
  tomato: "吃番茄 🍅",
  bubbles: "吐泡泡 🫧",
  sparkle: "星星闪 ✨",
};
void listen<RewardsEvent>("pet://rewards", (e) => {
  pet.setEffects(e.payload.effects);
  if (e.payload.granted) {
    // 刚获得新特效：宠物高兴地宣布（重要时刻，用通知条）
    banner.show(
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

function loop(now: number): void {
  pet.tick(now);
  // 气泡跟随宠物身体
  bubble.follow(pet.body);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// SIZE_STEPS 供调试查看当前档位含义
Object.assign(window as unknown as Record<string, unknown>, {
  __petSizes: SIZE_STEPS,
});
