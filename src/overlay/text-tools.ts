/**
 * 取词与翻译浮窗。
 *
 * 统一承接两个入口的结果（原生选区 / 屏幕框选 OCR）：
 * 先展示原文（可编辑纠错），默认自动翻译（设置里可关）；
 * 搜索仍由用户主动点击 —— 识别是本地的，只有翻译/搜索才会外发文本。
 *
 * 会话失效在前端再守一次（Rust 也有 SessionGate）：重复触发、关闭面板、
 * 取消之后，迟到结果一律丢弃，不覆盖用户正在看的内容。
 */

import { invoke } from "@tauri-apps/api/core";
import type { Box } from "../interact/hit-test";
import type { ConfigView } from "../config";
import { panelChrome } from "./chrome";
import {
  cancel as cancelRead,
  copy as copyText,
  readSelection,
  requestAxPermission,
  startOcr,
  search as searchText,
  translate as translateText,
  SessionGuard,
  readErrorMessage,
  translateErrorMessage,
  TEXT_MAX_CHARS,
  type ReadError,
  type ResultPayload,
  type TextSource,
  type TranslateError,
} from "../text-tools";

/** 面板状态机：待读取 → 可操作 / 处理中 / 成功 / 失败。 */
type PanelStatus = "reading" | "ready" | "translating" | "error";

/**
 * selection 读取态兜底超时：Rust 侧 AX 最坏要连发 4 条消息（焦点控件 /
 * 选区文本 / 选区范围 / 范围取串），各 1.5s 消息超时，慢应用下可能到 6s；
 * 再加余量到 8s。结果事件彻底丢失时到点转成超时错误，绝不永久读取中
 * （迟到结果到达仍会覆盖超时错误）。
 */
const READING_WATCHDOG_MS = 8_000;

/**
 * 框选层出现确认的等待上限：Rust 抬窗成功会发 pet://text-tools-selection-shown，
 * 到点没收到说明框选层没起来（曾经的 bug 是静默吞掉、干等 60s 超时），
 * 直接报启动失败让用户重试。
 */
const SELECTION_SHOWN_WATCHDOG_MS = 1_500;

const SOURCE_LABELS: Record<TextSource, string> = {
  selection: "选中文字",
  ocr: "屏幕框选",
};

export class TextToolsPanel {
  private readonly el: HTMLDivElement;
  private open = false;
  private readonly guard = new SessionGuard();
  /** 是否已请求输入焦点（begin_text_input / end_text_input 必须配对）。 */
  private focused = false;
  /** 触发序号：重复触发/关闭后，旧 start() 的迟到 adopt 一律作废。 */
  private startSeq = 0;
  /** 会话号在途时先到的结果（IPC 顺序竞争），adopt 后回放。 */
  private heldResult: ResultPayload | null = null;
  /** 读取态兜底超时句柄。 */
  private readingTimer: number | null = null;
  /** 框选层出现确认超时句柄。 */
  private layerTimer: number | null = null;
  /** 框选层启动失败（与取词失败分开：提示语与出路不同）。 */
  private layerFailed = false;
  private cfg: ConfigView | null = null;
  private source: TextSource | null = null;
  private sourceApp: string | null = null;
  private status: PanelStatus = "reading";
  private original = "";
  private translated = "";
  /** 取词失败类别（需要授权引导时渲染额外按钮）。 */
  private readError: ReadError | null = null;
  /** 已带用户去过系统设置授权页：错误下方显示勾选引导，不再自动重读。 */
  private permHint = false;
  private translateError: TranslateError | null = null;
  /** 搜索失败（与取词失败分开：不提示「改用屏幕框选」）。 */
  private searchFailed = false;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pet-text-tools";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
  }

  get isOpen(): boolean {
    return this.open;
  }

  get box(): Box | null {
    if (!this.open) return null;
    const r = this.el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  contains(px: number, py: number): boolean {
    const b = this.box;
    if (!b) return false;
    return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
  }

  /** 供 main.ts 在每次取词前刷新配置（翻译方向/引擎）。 */
  setConfig(cfg: ConfigView): void {
    this.cfg = cfg;
    if (this.open) this.render();
  }

  /**
   * 开始一轮取词：建立会话（旧会话立即失效）。
   *
   * 焦点处理很关键：读取期间**不**请求输入焦点 —— begin_text_input 会让
   * 宠物变成前台应用，而 AX 取词的前提正是「前台是用户选中的那个应用」，
   * 抢焦点会让读取直接失败（报不支持或来源切换）。焦点只等结果到了再取。
   *
   * 框选期间也不铺浮窗：480px 的实色面板会挡住用户要看的屏幕区域。
   */
  async start(source: TextSource): Promise<void> {
    const seq = ++this.startSeq;
    this.source = source;
    this.status = "reading";
    this.original = "";
    this.translated = "";
    this.readError = null;
    this.translateError = null;
    this.searchFailed = false;
    this.layerFailed = false;
    this.permHint = false;
    this.sourceApp = null;
    this.guard.cancel();
    this.heldResult = null;
    this.clearReadingTimer();
    this.clearLayerTimer();
    try {
      const session =
        source === "selection" ? await readSelection() : await startOcr();
      if (seq !== this.startSeq) return; // 已被更新的触发或关闭取代：不认领
      this.guard.adopt(session);
      // 回放竞争期先到的结果（会话号不匹配的照旧按过期丢弃）
      const held = this.takeHeldResult();
      if (held && this.guard.accepts(held.session)) {
        this.deliver(held);
        return;
      }
      if (source === "selection") {
        // 选区取词很快，给个读取态
        this.show(false);
        this.armReadingWatchdog(session);
      } else {
        // 框选要看着屏幕操作：先收起旧浮窗（480px 实色面板会挡住
        // 要框选的区域），结果回来再由 deliver→show 恢复
        this.open = true;
        this.el.style.display = "none";
        this.armLayerWatchdog();
      }
    } catch (e) {
      if (seq !== this.startSeq) return;
      // 入口调用失败（如取词命令不存在）：直接给出可读错误
      this.status = "error";
      this.readError = "failed";
      this.show(false);
      console.warn("[text-tools] 取词启动失败", e);
    }
  }

  /** 框选层出现确认（main.ts 转发 pet://text-tools-selection-shown）。 */
  onSelectionShown(): void {
    this.clearLayerTimer();
  }

  /** 结果回调（main.ts 转发 pet://text-tools-result）。迟到结果直接丢弃。 */
  onResult(payload: ResultPayload): void {
    if (!this.guard.accepts(payload.session)) {
      // IPC 顺序竞争：结果事件可能先于会话号（invoke 返回）到达 ——
      // 此刻守卫必然拒收，直接丢弃会让面板永远停在读取中。先暂存最新一份，
      // adopt 后回放；若它本来就不是本会话的结果，回放时仍会被守卫拦下。
      if (this.status === "reading") this.heldResult = payload;
      return;
    }
    this.deliver(payload);
  }

  /** 交付并渲染一份已通过会话守卫的结果。 */
  private deliver(payload: ResultPayload): void {
    this.clearReadingTimer();
    this.clearLayerTimer();
    this.heldResult = null;
    this.source = payload.source;
    if (payload.outcome.kind === "ok") {
      this.original = payload.outcome.text;
      this.sourceApp = payload.outcome.sourceApp;
      this.status = "ready";
      this.readError = null;
      // 结果到了才显示（框选路径此前一直没显示）并取输入焦点
      this.show(true);
      // 自动翻译（默认开，设置里可关）：取词本身就是用户按快捷键主动触发的，
      // 直接出译文省掉再点一次「翻译」。LLM 未配置时静默跳过（见 doTranslate）。
      if (this.cfg?.auto_translate !== false) {
        void this.doTranslate(true);
      }
      return;
    }
    const code = payload.outcome.code;
    if (code === "cancelled") {
      // 用户主动取消：静默关闭，不弹错误
      this.hide();
      return;
    }
    this.readError = code;
    this.status = "error";
    this.show(false);
  }

  /** 取走暂存结果（竞争期先到的那份），取后即清。 */
  private takeHeldResult(): ResultPayload | null {
    const held = this.heldResult;
    this.heldResult = null;
    return held;
  }

  /** 读取态兜底：到点仍在读取且会话仍活跃，转成超时错误（不永久读取中）。 */
  private armReadingWatchdog(session: number): void {
    this.readingTimer = window.setTimeout(() => {
      this.readingTimer = null;
      if (this.status !== "reading" || !this.guard.accepts(session)) return;
      this.readError = "timeout";
      this.status = "error";
      this.render();
    }, READING_WATCHDOG_MS);
  }

  private clearReadingTimer(): void {
    if (this.readingTimer !== null) {
      clearTimeout(this.readingTimer);
      this.readingTimer = null;
    }
  }

  /** 框选层出现确认兜底：到点仍没收到 shown 事件即报启动失败。 */
  private armLayerWatchdog(): void {
    this.layerTimer = window.setTimeout(() => {
      this.layerTimer = null;
      if (this.status !== "reading") return;
      this.layerFailed = true;
      this.status = "error";
      this.show(false);
    }, SELECTION_SHOWN_WATCHDOG_MS);
  }

  private clearLayerTimer(): void {
    if (this.layerTimer !== null) {
      clearTimeout(this.layerTimer);
      this.layerTimer = null;
    }
  }

  /**
   * @param focus 是否请求输入焦点。读取中不要焦点（会让宠物变前台，
   *              破坏 AX 取词的前提）；结果就绪后才为编辑与键盘操作取焦点。
   */
  private show(focus: boolean): void {
    this.el.style.display = "block";
    this.open = true;
    if (focus && !this.focused) {
      this.focused = true;
      void invoke("begin_text_input").catch(() => {});
    }
    this.render();
  }

  hide(): void {
    // 关闭即终结：在途的 start() 不再认领会话，兜底计时器一并撤掉
    this.startSeq++;
    this.heldResult = null;
    this.clearReadingTimer();
    this.clearLayerTimer();
    if (!this.open && !this.focused) {
      // 框选中的会话没显示过面板，也要把会话作废
      this.guard.cancel();
      void cancelRead().catch(() => {});
      return;
    }
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    if (this.focused) {
      this.focused = false;
      void invoke("end_text_input").catch(() => {});
    }
    // 取消会话：Rust 侧丢弃在途结果
    this.guard.cancel();
    void cancelRead().catch(() => {});
    this.el.style.display = "none";
    this.open = false;
  }

  /** 当前原文（以用户编辑后的文本域为准，识别结果允许纠错）。 */
  private currentText(): string {
    const ta = this.el.querySelector<HTMLTextAreaElement>(".pet-tt-original");
    return ta ? ta.value : this.original;
  }

  /**
   * @param auto 是否为取词后的自动尝试（默认开）。自动尝试是尽力而为：
   *             LLM 未启用/未配置时静默跳过 —— 没配服务的用户不该每次
   *             取词都看到报错；手动点「翻译」仍会看到明确提示。
   */
  private async doTranslate(auto = false): Promise<void> {
    // 触发序号守卫：翻译在途时用户重新取词或关闭面板（startSeq 递增），
    // 旧译文必须作废 —— 否则会渲染进新会话的读取态（自动翻译引入的竞争）
    const seq = this.startSeq;
    const text = this.currentText();
    if (text.trim().length === 0) return;
    this.original = text;
    this.status = "translating";
    this.translateError = null;
    this.translated = "";
    this.render();
    try {
      const out = await translateText(text);
      if (seq !== this.startSeq) return; // 期间已重新触发或关闭
      if (out.kind === "ok") {
        this.translated = out.text;
        this.status = "ready";
      } else if (
        auto &&
        (out.code === "llm_disabled" || out.code === "llm_not_configured")
      ) {
        this.status = "ready"; // 回到就绪态，译文区维持引导提示
      } else {
        this.translateError = out.code;
        this.status = "error";
      }
    } catch (e) {
      this.translateError = "network";
      this.status = "error";
      console.warn("[text-tools] 翻译请求异常", e);
    }
    this.render();
  }

  private async doSearch(): Promise<void> {
    const text = this.currentText();
    if (text.trim().length === 0) return;
    this.original = text;
    try {
      await searchText(text);
    } catch (e) {
      console.warn("[text-tools] 搜索失败", e);
      // 搜索失败与取词失败语义不同：不该显示「改用屏幕框选」
      this.searchFailed = true;
      this.render();
    }
  }

  private async doCopy(text: string): Promise<void> {
    try {
      await copyText(text);
    } catch (e) {
      console.warn("[text-tools] 复制失败", e);
    }
  }

  private async requestPermission(): Promise<void> {
    try {
      // Rust 直接打开系统设置的「辅助功能」授权页（系统弹窗在 TCC 条目
      // 陈旧时会静默不弹，不能再依赖）
      await requestAxPermission();
    } catch (e) {
      console.warn("[text-tools] 请求辅助功能授权失败", e);
    }
    // 不立即重读：用户还没来得及在系统设置里勾选，马上重读只会把同样的
    // 错误再弹一遍（看起来像「点了没反应」）。给勾选引导，等用户重按快捷键。
    this.permHint = true;
    this.render();
  }

  // ---------- 渲染 ----------

  private render(): void {
    this.el.replaceChildren();
    const title = SOURCE_LABELS[this.source ?? "selection"];
    this.el.appendChild(
      panelChrome(this.el, "取词与翻译", () => this.hide(), {
        headClass: "pet-tt-head",
      }),
    );

    // 来源标签
    const meta = document.createElement("div");
    meta.className = "pet-tt-meta";
    const tag = document.createElement("span");
    tag.className = "pet-tt-tag";
    tag.textContent = title;
    meta.appendChild(tag);
    if (this.sourceApp) {
      const from = document.createElement("span");
      from.className = "pet-tt-from";
      from.textContent = this.sourceApp;
      meta.appendChild(from);
    }
    this.el.appendChild(meta);

    if (this.status === "reading") {
      this.el.appendChild(this.hint("正在读取…（Esc 或点底部取消可中止）"));
      this.el.appendChild(this.actionRow(false));
      return;
    }

    if (this.status === "error" && this.layerFailed) {
      const b = document.createElement("div");
      b.className = "pet-tt-error";
      b.textContent = "框选层启动失败，请重试";
      this.el.appendChild(b);
      const actions = document.createElement("div");
      actions.className = "pet-tt-actions";
      const retry = document.createElement("button");
      retry.className = "pet-tt-primary";
      retry.textContent = "重试框选";
      retry.addEventListener("click", () => void this.start("ocr"));
      actions.appendChild(retry);
      this.el.appendChild(actions);
      return;
    }

    if (this.status === "error" && this.readError) {
      this.el.appendChild(this.errorBlock(this.readError));
      // 已带用户去过系统设置：给出勾选引导（点按钮自动重读只会弹同样的错误，
      // 看起来像「点了没反应」，且用户此刻还没来得及勾选）
      if (this.readError === "not_trusted" && this.permHint) {
        this.el.appendChild(
          this.hint(
            "已打开系统设置——在「隐私与安全性 › 辅助功能」勾选 Vibe Pet" +
              "（若已在列表里，先移除再加回），然后按 Ctrl+Alt+T 重试",
          ),
        );
      }
      // 未授权时给授权入口；无论如何都保留「改用屏幕框选」的替代路径
      const alt = document.createElement("div");
      alt.className = "pet-tt-actions";
      if (this.readError === "not_trusted") {
        const grant = document.createElement("button");
        grant.className = "pet-tt-primary";
        grant.textContent = this.permHint ? "再开一次系统设置" : "去系统设置授权";
        grant.addEventListener("click", () => void this.requestPermission());
        alt.appendChild(grant);
      }
      const retryOcr = document.createElement("button");
      retryOcr.className = "pet-tt-btn";
      retryOcr.textContent = "改用屏幕框选";
      retryOcr.addEventListener("click", () => void this.start("ocr"));
      alt.appendChild(retryOcr);
      this.el.appendChild(alt);
      return;
    }

    // 原文区（可编辑、保留换行、超长内部滚动）
    const ta = document.createElement("textarea");
    ta.className = "pet-tt-original";
    ta.value = this.original;
    ta.spellcheck = false;
    ta.addEventListener("keydown", (e) => e.stopPropagation());
    this.el.appendChild(ta);
    const count = document.createElement("div");
    count.className = "pet-tt-count";
    const n = [...this.currentText()].length;
    count.textContent = `${n} 字${n > TEXT_MAX_CHARS ? ` · 超过 ${TEXT_MAX_CHARS} 字上限` : ""}`;
    if (n > TEXT_MAX_CHARS) count.classList.add("pet-tt-warn");
    this.el.appendChild(count);

    // 操作区：翻译（方向）+ 搜索（引擎）+ 重新框选
    this.el.appendChild(this.actionRow(true));

    // 译文区
    this.el.appendChild(this.divider("译文"));
    if (this.status === "translating") {
      this.el.appendChild(this.hint("翻译中…"));
    } else if (this.translated) {
      const out = document.createElement("div");
      out.className = "pet-tt-result";
      // 纯文本展示，绝不 innerHTML —— 译文来自外部服务
      out.textContent = this.translated;
      this.el.appendChild(out);
    } else if (this.translateError) {
      const err = document.createElement("div");
      err.className = "pet-tt-error";
      err.textContent = translateErrorMessage(this.translateError);
      this.el.appendChild(err);
    } else {
      this.el.appendChild(this.hint("点「翻译」后结果出现在这里"));
    }

    if (this.searchFailed) {
      const err = document.createElement("div");
      err.className = "pet-tt-error";
      err.textContent = "搜索失败：查询过长或无法打开浏览器";
      this.el.appendChild(err);
    }

    // 底部操作栏
    const foot = document.createElement("div");
    foot.className = "pet-tt-foot";
    const copySrc = document.createElement("button");
    copySrc.className = "pet-tt-btn";
    copySrc.textContent = "复制原文";
    copySrc.addEventListener("click", () => void this.doCopy(this.currentText()));
    const copyOut = document.createElement("button");
    copyOut.className = "pet-tt-btn";
    copyOut.textContent = "复制译文";
    copyOut.disabled = !this.translated;
    copyOut.addEventListener("click", () => void this.doCopy(this.translated));
    const tip = document.createElement("span");
    tip.className = "pet-tt-tip";
    tip.textContent = "翻译/搜索才会外发文本";
    foot.append(copySrc, copyOut, tip);
    this.el.appendChild(foot);
  }

  private actionRow(enabled: boolean): HTMLElement {
    const row = document.createElement("div");
    row.className = "pet-tt-actions";
    const dir = this.cfg?.translation_direction ?? "en2zh";
    const engine = this.cfg?.search_engine ?? "google";

    const tr = document.createElement("button");
    tr.className = "pet-tt-primary";
    tr.textContent = dir === "en2zh" ? "翻译（英→中）" : "翻译（中→英）";
    tr.disabled = !enabled;
    tr.addEventListener("click", () => void this.doTranslate());

    const se = document.createElement("button");
    se.className = "pet-tt-btn";
    se.textContent = `搜索 · ${engine === "baidu" ? "百度" : engine === "bing" ? "Bing" : "Google"}`;
    se.disabled = !enabled;
    se.addEventListener("click", () => void this.doSearch());

    const re = document.createElement("button");
    re.className = "pet-tt-btn";
    re.textContent = "重新框选";
    re.addEventListener("click", () => void this.start("ocr"));

    row.append(tr, se, re);
    return row;
  }

  private errorBlock(code: ReadError): HTMLElement {
    const b = document.createElement("div");
    b.className = "pet-tt-error";
    const msg = readErrorMessage(code);
    if (msg) b.textContent = msg;
    return b;
  }

  private divider(text: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "pet-tt-divider";
    d.textContent = text;
    return d;
  }

  private hint(text: string): HTMLElement {
    const h = document.createElement("div");
    h.className = "pet-tt-hint";
    h.textContent = text;
    return h;
  }
}
