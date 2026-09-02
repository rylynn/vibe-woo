import type { PluginFrontend } from "../registry";

/** 卡片 payload（与 Rust plugin/pomodoro.rs 的 make_card 契约一致）。 */
interface PomodoroPayload {
  phase: "work_start" | "break_start" | "break_end";
  mins: number;
  text: string;
}

/** 配置（与 Rust PomodoroConfig 契约一致）。 */
interface PomodoroConfigView {
  enabled: boolean;
  work_mins: number;
  break_mins: number;
}

const DEFAULT_CFG: PomodoroConfigView = {
  enabled: false,
  work_mins: 25,
  break_mins: 5,
};

const PHASE_LABELS: Record<string, string> = {
  idle: "未运行",
  working: "专注中",
  break: "休息中",
};

const ENABLE_HINT =
  "开启后进入工作/休息循环；休息期间键鼠活动累计不超过 1 分钟算认真休息，会得到当天限定的外观特效（隔天失效）";

/** 番茄工作法的前端三视图：气泡卡 / 面板分区 / 设置表单。 */
export const pomodoroFrontend: PluginFrontend = {
  renderCard(card) {
    const p = card.payload as PomodoroPayload;
    const el = document.createElement("div");
    el.className = `pet-card-pomodoro phase-${p.phase}`;

    const head = document.createElement("div");
    head.className = "pet-card-tag";
    head.textContent = "🍅 番茄工作法";
    el.appendChild(head);

    // break_start 的文案含「别碰键鼠」的指令，白名单换行展示
    const text = document.createElement("div");
    text.className = "pet-card-text";
    text.textContent = p.text;
    el.appendChild(text);
    return el;
  },

  renderSection(data) {
    const s = data as { enabled: boolean; phase: string; pomodoros_today: number };
    const el = document.createElement("div");
    el.className = "pet-card-pomodoro-section";
    el.textContent = s.enabled
      ? `${PHASE_LABELS[s.phase] ?? s.phase} · 今天 ${s.pomodoros_today} 个番茄`
      : "未启用";
    return el;
  },

  renderSettings(cfg, onSave) {
    const c = { ...DEFAULT_CFG, ...(cfg as Partial<PomodoroConfigView> | null) };
    const el = document.createElement("div");
    el.className = "pet-plugin-form";

    // 启用开关 + 说明
    const checkRow = document.createElement("label");
    checkRow.className = "pet-plugin-form-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = c.enabled;
    const label = document.createElement("span");
    label.textContent = "启用";
    checkRow.append(box, label);
    el.appendChild(checkRow);

    const hint = document.createElement("div");
    hint.className = "pet-plugin-form-hint";
    hint.textContent = ENABLE_HINT;
    el.appendChild(hint);

    const numRow = document.createElement("div");
    numRow.className = "pet-plugin-form-row";
    const work = document.createElement("input");
    work.type = "number";
    work.min = "1";
    work.max = "120";
    work.value = String(c.work_mins);
    const workLabel = document.createElement("span");
    workLabel.textContent = "工作分钟";
    const brk = document.createElement("input");
    brk.type = "number";
    brk.min = "1";
    brk.max = "60";
    brk.value = String(c.break_mins);
    const brkLabel = document.createElement("span");
    brkLabel.textContent = "休息分钟";
    numRow.append(workLabel, work, brkLabel, brk);
    el.appendChild(numRow);

    const save = document.createElement("button");
    save.className = "pet-plugin-form-save";
    save.textContent = "保存";
    save.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      onSave({
        enabled: box.checked,
        work_mins: Math.max(1, Math.min(120, Number(work.value) || 25)),
        break_mins: Math.max(1, Math.min(60, Number(brk.value) || 5)),
      });
      save.textContent = "已保存 ✓";
      setTimeout(() => (save.textContent = "保存"), 1200);
    });
    el.appendChild(save);

    // 输入框内按键不冒泡（Esc 仍要能关设置面板，捕获阶段在 main.ts）
    for (const input of [box, work, brk] as HTMLElement[]) {
      input.addEventListener("keydown", (e) => e.stopPropagation());
    }
    return el;
  },
};
