import { invoke } from "@tauri-apps/api/core";
import type { Box } from "../interact/hit-test";
import {
  getConfig,
  updateConfig,
  LLM_PROTOCOLS,
  type ConfigView,
  type LlmProtocol,
  type Persona,
  type RoamScope,
} from "../config";
import { enablePanelDrag } from "./panel-drag";
import { avatarFromView, type PetAvatar } from "../avatar/types";
import { drawAvatarStill } from "./avatar-picker";

/** 形象相关操作流（由 main.ts 装配，避免设置面板直接依赖弹窗与持久化）。 */
export interface AvatarFlow {
  /** 打开形象选择弹窗；initial 非空时直接展示这批候选。 */
  openPicker(initial?: PetAvatar[]): void;
  /** 从图片生成候选；未提供时隐藏该入口。 */
  analyzeImage?: (file: File) => Promise<PetAvatar[]>;
}

const SIZE_LABELS = ["小 48", "中 96", "大 144", "特大 192"];

const SCOPES: RoamScope[] = ["still", "nearby", "halfscreen", "fullscreen"];

const PROTOCOL_LABELS: Record<LlmProtocol, string> = {
  "openai-completions": "OpenAI · Completions",
  "openai-response": "OpenAI · Responses",
  "anthropic-messages": "Anthropic · Messages",
};

const SCOPE_LABELS: Record<RoamScope, string> = {
  still: "不动 · 待在原处",
  nearby: "周围 · 附近小范围晃",
  halfscreen: "半屏 · 半个屏幕内",
  fullscreen: "全屏 · 到处走",
};

const PERSONA_LABELS: Record<Persona, string> = {
  quiet: "安静 · 只用动作表达",
  occasional: "偶尔吐槽 · 低频冒泡",
  chatty: "唠唠 · 主动关心",
};

/**
 * 设置面板。
 *
 * 用 DOM 而非 canvas：表单控件需要可靠的键盘输入与焦点管理，
 * 这是 DOM 的强项。canvas 里自己实现输入框是纯粹的浪费。
 */
export class SettingsPanel {
  private readonly el: HTMLDivElement;
  private open = false;
  private cfg: ConfigView | null = null;

  constructor(
    private readonly onApply: (c: ConfigView) => void,
    private readonly avatarFlow?: AvatarFlow,
  ) {
    this.el = document.createElement("div");
    this.el.className = "pet-settings";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
    // 标题栏长按拖动，与宠物拖动手感一致
    enablePanelDrag(this.el, ".pet-settings-head");
  }

  async show(): Promise<void> {
    // 先显示再加载配置 —— 面板出现不该等 IPC 往返（乐观渲染）
    this.el.style.display = "block";
    this.open = true;
    void invoke("begin_text_input").catch(() => {});
    if (!this.cfg) {
      // 首次打开：显示加载骨架，数据到了再真正渲染
      this.renderLoading();
      this.cfg = await getConfig();
    }
    this.render();
  }

  private renderLoading(): void {
    this.el.replaceChildren();
    const head = document.createElement("div");
    head.className = "pet-settings-head";
    const t = document.createElement("span");
    t.textContent = "Vibe Pet 设置";
    head.appendChild(t);
    this.el.appendChild(head);
    const loading = document.createElement("div");
    loading.className = "pet-settings-hint";
    loading.style.padding = "14px";
    loading.textContent = "载入中…";
    this.el.appendChild(loading);
  }

  hide(): void {
    if (this.open) void invoke("end_text_input").catch(() => {});
    this.closeErrorBubble();
    // 先让输入框失焦再隐藏 —— display:none 会吞掉 change 事件，
    // 导致「输入了 API key 但点外关闭后没保存」。
    // blur 先触发 change（值有变化时提交），然后才隐藏。
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    this.el.style.display = "none";
    this.open = false;
  }

  get isOpen(): boolean {
    return this.open;
  }

  get box(): Box | null {
    if (!this.open) return null;
    const r = this.el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  /** 错误气泡独立于面板本体，穿透区域需单独上报。 */
  get errorBox(): Box | null {
    if (!this.open || !this.errorBubble) return null;
    const r = this.errorBubble.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  contains(px: number, py: number): boolean {
    const b = this.box;
    if (!b) return false;
    return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
  }

  private async patch(p: Parameters<typeof updateConfig>[0]): Promise<void> {
    this.cfg = await updateConfig(p);
    this.onApply(this.cfg);
    this.render();
  }

  private render(): void {
    const c = this.cfg;
    if (!c) return;

    this.el.replaceChildren();
    this.el.appendChild(this.header());

    this.el.appendChild(
      this.rowSelect("大小", SIZE_LABELS, c.size_index, (i) =>
        this.patch({ size_index: i }),
      ),
    );

    this.el.appendChild(
      this.rowSelect(
        "走动范围",
        SCOPES.map((s) => SCOPE_LABELS[s]),
        Math.max(0, SCOPES.indexOf(c.roam_scope)),
        (i) => this.patch({ roam_scope: SCOPES[i] }),
      ),
    );

    this.el.appendChild(
      this.rowSelect(
        "性格",
        (["quiet", "occasional", "chatty"] as Persona[]).map(
          (p) => PERSONA_LABELS[p],
        ),
        ["quiet", "occasional", "chatty"].indexOf(c.persona),
        (i) => {
          const list: Persona[] = ["quiet", "occasional", "chatty"];
          void this.patch({ persona: list[i] });
        },
      ),
    );

    this.el.appendChild(
      this.rowText(
        "我平时在忙什么",
        c.user_kind,
        (v) => this.patch({ user_kind: v.trim() }),
        "可留空",
        40,
      ),
    );
    this.el.appendChild(
      this.hint(
        "留空则不预设身份，宠物只根据你正在做的事说话。填写后用于 AI 对话；开启 AI 接入时会随请求发往你配置的服务端",
      ),
    );

    if (this.avatarFlow) {
      this.el.appendChild(this.divider("形象"));
      this.el.appendChild(this.rowAvatar(c));
    }

    this.el.appendChild(this.divider("速记"));
    this.el.appendChild(
      this.rowText("Obsidian 目录", c.notes_vault, (v) =>
        this.patch({ notes_vault: v }),
      ),
    );
    this.el.appendChild(this.hint("留空则只存内置目录"));

    this.el.appendChild(this.divider("番茄工作法"));
    this.el.appendChild(
      this.rowCheck(
        "启用",
        c.pomodoro_enabled,
        (v) => this.patch({ pomodoro_enabled: v }),
        "开启后进入工作/休息循环；休息期间键鼠活动累计不超过 1 分钟算认真休息，会得到当天限定的外观特效（隔天失效）",
      ),
    );
    this.el.appendChild(
      this.rowNumber("工作分钟", c.pomodoro_work_mins, (v) =>
        this.patch({ pomodoro_work_mins: v }),
      ),
    );
    this.el.appendChild(
      this.rowNumber("休息分钟", c.pomodoro_break_mins, (v) =>
        this.patch({ pomodoro_break_mins: v }),
      ),
    );

    this.el.appendChild(this.divider("AI 接入"));
    this.el.appendChild(
      this.rowCheck("启用", c.llm_enabled, (v) =>
        this.patch({ llm_enabled: v }),
      ),
    );
    this.el.appendChild(
      this.rowSelect(
        "协议",
        LLM_PROTOCOLS.map((p) => PROTOCOL_LABELS[p]),
        Math.max(0, LLM_PROTOCOLS.indexOf(c.llm_protocol)),
        (i) => this.patch({ llm_protocol: LLM_PROTOCOLS[i] }),
      ),
    );
    this.el.appendChild(
      this.rowText("接口地址", c.llm_base_url, (v) =>
        this.patch({ llm_base_url: v }),
      ),
    );
    this.el.appendChild(
      this.rowText("模型", c.llm_model, (v) => this.patch({ llm_model: v })),
    );
    this.el.appendChild(
      this.rowKey(c, (v) => this.patch({ llm_api_key: v })),
    );
    this.el.appendChild(
      this.rowCheck(
        "深度思考",
        c.llm_thinking,
        (v) => this.patch({ llm_thinking: v }),
        "开启后模型会先思考再回答，更慢但更好；部分模型不支持",
      ),
    );
    this.el.appendChild(this.rowTest());

    // 关于：uid / 注册日期 / 署名
    this.el.appendChild(this.divider("关于"));
    this.el.appendChild(this.rowStatic("uid", c.social_uid || "未登录"));
    this.el.appendChild(
      this.rowStatic("注册日期", c.social_register_date || "—"),
    );
    const credit = this.hint("power by rylynnxj");
    credit.style.paddingLeft = "14px";
    this.el.appendChild(credit);

    this.el.appendChild(this.footer());
  }

  /** 形象区块：当前形象 48px 预览 + 换一批 / 从图片生成入口。 */
  private rowAvatar(c: ConfigView): HTMLElement {
    const r = this.row("形象");

    const canvas = document.createElement("canvas");
    canvas.width = 48;
    canvas.height = 48;
    canvas.className = "pet-settings-avatar";
    canvas.title = c.avatar ? "当前形象" : "尚未领养形象";
    if (c.avatar) drawAvatarStill(canvas, avatarFromView(c.avatar));
    r.appendChild(canvas);

    const flow = this.avatarFlow;
    if (!flow) return r;

    const reroll = document.createElement("button");
    reroll.className = "pet-avatar-btn";
    reroll.textContent = "换一批";
    reroll.addEventListener("click", () => flow.openPicker());
    r.appendChild(reroll);

    if (flow.analyzeImage) {
      const fromImage = document.createElement("button");
      fromImage.className = "pet-avatar-btn";
      fromImage.textContent = "从图片生成";
      const input = document.createElement("input");
      input.type = "file";
      input.accept = "image/*";
      input.style.display = "none";
      fromImage.addEventListener("click", () => input.click());
      input.addEventListener("change", () => {
        const file = input.files?.[0];
        input.value = "";
        if (!file || !flow.analyzeImage) return;
        void flow
          .analyzeImage(file)
          .then((list) => {
            if (list.length > 0) flow.openPicker(list);
          })
          .catch((e) => console.warn("[avatar] 图片分析失败", e));
      });
      r.append(fromImage, input);
    }
    return r;
  }

  /** 只读信息行（关于区）。 */
  private rowStatic(label: string, value: string): HTMLElement {
    const r = this.row(label);
    const v = document.createElement("span");
    v.textContent = value;
    v.title = value;
    v.style.cssText =
      "color:#c6cddd;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    r.appendChild(v);
    return r;
  }

  private header(): HTMLElement {
    const h = document.createElement("div");
    h.className = "pet-settings-head";
    const t = document.createElement("span");
    t.textContent = "Vibe Pet 设置";
    const x = document.createElement("button");
    x.className = "pet-settings-close";
    x.textContent = "×";
    x.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.hide();
    });
    h.append(t, x);
    return h;
  }

  private divider(text: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "pet-settings-divider";
    d.textContent = text;
    return d;
  }

  private row(label: string): HTMLDivElement {
    const r = document.createElement("div");
    r.className = "pet-settings-row";
    const l = document.createElement("label");
    l.textContent = label;
    r.appendChild(l);
    return r;
  }

  private rowSelect(
    label: string,
    options: string[],
    selected: number,
    onPick: (i: number) => void,
  ): HTMLElement {
    const r = this.row(label);
    const sel = document.createElement("select");
    options.forEach((o, i) => {
      const opt = document.createElement("option");
      opt.value = String(i);
      opt.textContent = o;
      if (i === selected) opt.selected = true;
      sel.appendChild(opt);
    });
    sel.addEventListener("change", () => onPick(Number(sel.value)));
    r.appendChild(sel);
    return r;
  }


  /** 复选框行。tooltip 用原生 title，hover 气泡展示完整说明。 */
  private rowCheck(
    label: string,
    checked: boolean,
    onToggle: (v: boolean) => void,
    tooltip?: string,
  ): HTMLElement {
    const r = this.row(label);
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = checked;
    box.style.accentColor = "#7cf5c4";
    if (tooltip) {
      r.title = tooltip;
      box.title = tooltip;
    }
    box.addEventListener("change", () => onToggle(box.checked));
    r.appendChild(box);
    return r;
  }

  private rowText(
    label: string,
    value: string,
    onCommit: (v: string) => void,
    placeholder?: string,
    maxLength?: number,
  ): HTMLElement {
    const r = this.row(label);
    const input = document.createElement("input");
    input.type = "text";
    input.value = value;
    input.spellcheck = false;
    if (placeholder !== undefined) input.placeholder = placeholder;
    if (maxLength !== undefined) input.maxLength = maxLength;
    const commit = () => {
      if (input.value !== value) onCommit(input.value);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      e.stopPropagation();
    });
    r.appendChild(input);
    return r;
  }

  /** 数字输入行（分钟数等）。非法输入不提交。 */
  private rowNumber(
    label: string,
    value: number,
    onCommit: (v: number) => void,
  ): HTMLElement {
    const r = this.row(label);
    const input = document.createElement("input");
    input.type = "number";
    input.value = String(value);
    input.spellcheck = false;
    input.style.width = "72px";
    const commit = () => {
      const n = Math.floor(Number(input.value));
      // 非法输入（空/非数字/小于 1）回显为当前配置值，
      // 避免输入框显示与实际配置静默不一致；合法但超范围值由后端钳制后经 patch 重渲染回显
      if (!Number.isFinite(n) || n < 1 || n === value) {
        input.value = String(value);
        return;
      }
      onCommit(n);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      e.stopPropagation();
    });
    r.appendChild(input);
    return r;
  }

  private rowKey(c: ConfigView, onCommit: (v: string) => void): HTMLElement {
    const r = this.row("API Key");
    const input = document.createElement("input");
    input.type = "password";
    input.spellcheck = false;
    // 已有 key 时显示掩码作为占位，用户不输入就不改动
    input.placeholder = c.llm_has_key ? c.llm_api_key_masked : "未设置";
    input.addEventListener("change", () => {
      if (input.value.length > 0) {
        onCommit(input.value);
        input.value = "";
      }
    });
    input.addEventListener("keydown", (e) => e.stopPropagation());
    r.appendChild(input);
    return r;
  }

  /** 测试失败原因的气泡（独立于面板 DOM，避免整体重渲染时被清掉）。 */
  private errorBubble: HTMLDivElement | null = null;

  private closeErrorBubble(): void {
    this.errorBubble?.remove();
    this.errorBubble = null;
  }

  /** 在锚点行下方弹出错误气泡，点击任意处关闭。 */
  private showErrorBubble(anchor: HTMLElement, msg: string): void {
    this.closeErrorBubble();
    const b = document.createElement("div");
    b.className = "pet-error-bubble";
    const text = document.createElement("div");
    text.textContent = msg;
    const hint = document.createElement("div");
    hint.className = "pet-error-bubble-hint";
    hint.textContent = "点击关闭";
    b.append(text, hint);
    b.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.closeErrorBubble();
    });
    document.body.appendChild(b);
    // 先显示再量尺寸，做边界收拢
    const r = anchor.getBoundingClientRect();
    const left = Math.max(
      4,
      Math.min(window.innerWidth - b.offsetWidth - 4, r.left),
    );
    const top = Math.min(window.innerHeight - b.offsetHeight - 4, r.bottom + 8);
    b.style.left = `${left}px`;
    b.style.top = `${Math.max(4, top)}px`;
    this.errorBubble = b;
  }

  /** LLM 连通性测试行。失败原因用气泡完整展示。 */
  private rowTest(): HTMLElement {
    const r = this.row("连通性");
    const btn = document.createElement("button");
    btn.className = "pet-bubble-confirm";
    btn.textContent = "测试连接";
    btn.style.flex = "0 0 auto";
    const status = document.createElement("span");
    status.title = "测试结果";
    status.style.cssText =
      "color:#8b93a7;font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    btn.addEventListener("pointerdown", async (e) => {
      e.stopPropagation();
      this.closeErrorBubble();
      status.textContent = "测试中";
      status.style.color = "#8b93a7";
      try {
        const out = await invoke<string>("test_llm");
        status.textContent = out;
        status.style.color = "#7cf5c4";
        status.title = out;
      } catch (err) {
        // 行内只放一行短摘要，完整失败原因用气泡弹出、点击关闭
        status.textContent = "连接失败 · 原因见气泡";
        status.style.color = "#ffab9d";
        this.showErrorBubble(r, String(err));
      }
    });
    r.append(btn, status);
    return r;
  }

  private hint(text: string): HTMLElement {
    const h = document.createElement("div");
    h.className = "pet-settings-hint";
    h.textContent = text;
    return h;
  }

  private footer(): HTMLElement {
    const f = document.createElement("div");
    f.className = "pet-settings-foot";
    f.textContent = "配置自动保存 · 退出用宠物右键菜单或 ⌃⌥⌘Q";
    return f;
  }
}
