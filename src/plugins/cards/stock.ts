import type { PluginFrontend } from "../registry";

/** 行情条目（与 Rust Quote 契约一致）。 */
interface Quote {
  symbol: string;
  name: string;
  price: number;
  change_pct: number;
}

/** 卡片 payload（与 Rust stocks.rs 契约一致）。 */
interface StockPayload {
  summary: boolean;
  items: Quote[];
  /** 二级视图（配置了个股时的指数列表）；未配置个股时为空。 */
  indices: Quote[];
  digest: string | null;
  ai: boolean;
}

/** 配置（与 Rust StocksConfig 契约一致）。 */
interface StocksConfigView {
  enabled: boolean;
  symbols: string[];
  endpoint: string;
  windows: [string, string][];
  change_threshold_pct: number;
  summarize_after: string;
}

const DEFAULT_CFG: StocksConfigView = {
  enabled: false,
  symbols: [],
  endpoint: "https://qt.gtimg.cn/q=",
  windows: [
    ["12:00", "13:30"],
    ["15:30", "18:00"],
  ],
  change_threshold_pct: 2.0,
  summarize_after: "15:05",
};

const DEFAULT_WINDOWS_TEXT = "12:00-13:30,15:30-18:00";

/** "12:00-13:30,15:30-18:00" → [["12:00","13:30"],...]；非法段丢弃。 */
function parseWindowsText(text: string): [string, string][] {
  const out: [string, string][] = [];
  for (const seg of text.split(/[,，]/)) {
    const m = seg.trim().match(/^(\d{1,2}:\d{2})\s*[-~]\s*(\d{1,2}:\d{2})$/);
    if (m) out.push([m[1], m[2]]);
  }
  return out;
}

function windowsToText(windows: [string, string][]): string {
  return windows.map(([a, b]) => `${a}-${b}`).join(",");
}

function fmtPct(v: number): string {
  return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
}

/** 一组行情行（主视图/指数视图共用）。 */
function renderRows(list: Quote[]): HTMLDivElement {
  const box = document.createElement("div");
  for (const q of list) {
    const row = document.createElement("div");
    row.className = "pet-stock-row";
    const name = document.createElement("span");
    name.className = "pet-stock-name";
    name.textContent = q.name || q.symbol;
    const price = document.createElement("span");
    price.textContent = q.price.toFixed(2);
    const pct = document.createElement("span");
    pct.className = q.change_pct >= 0 ? "pet-stock-up" : "pet-stock-down";
    pct.textContent = fmtPct(q.change_pct);
    row.append(name, price, pct);
    box.appendChild(row);
  }
  return box;
}

/** 主从视图切换：有指数二级视图时挂「查看指数 ›」按钮，点开后可返回。 */
function withIndexToggle(el: HTMLElement, p: StockPayload): void {
  const primary = renderRows(p.items);
  const secondary = p.indices.length > 0 ? renderRows(p.indices) : null;
  el.appendChild(primary);
  if (!secondary) return;
  const btn = document.createElement("button");
  btn.className = "pet-stock-toggle";
  btn.textContent = "查看指数 ›";
  el.appendChild(btn);
  let showingIndices = false;
  btn.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    showingIndices = !showingIndices;
    el.replaceChild(showingIndices ? secondary : primary, showingIndices ? primary : secondary);
    btn.textContent = showingIndices ? "‹ 返回个股" : "查看指数 ›";
  });
}

/** 股市投资的前端三视图。红涨绿跌（国内配色）。 */
export const stockFrontend: PluginFrontend = {
  renderCard(card) {
    const p = card.payload as StockPayload;
    const el = document.createElement("div");
    el.className = "pet-card-stock";

    const tag = document.createElement("div");
    tag.className = "pet-card-tag";
    tag.textContent = p.summary ? "📈 收盘小结" : "📈 行情变动";
    el.appendChild(tag);

    if (p.digest) {
      const digest = document.createElement("div");
      digest.className = "pet-stock-digest";
      digest.textContent = p.digest;
      el.appendChild(digest);
    }

    withIndexToggle(el, p);
    return el;
  },

  renderSection(data) {
    const s = data as {
      enabled: boolean;
      symbols: string[];
      quotes: Quote[];
      indices: Quote[];
    };
    const el = document.createElement("div");
    el.className = "pet-card-stock-section";
    if (!s.enabled) {
      el.textContent = "未启用";
      return el;
    }
    if (s.quotes.length === 0) {
      el.textContent =
        s.symbols.length > 0
          ? `关注 ${s.symbols.length} 只 · 今日还没有行情`
          : "今日还没有行情（默认展示上证/恒指/纳指）";
      return el;
    }
    el.appendChild(renderRows(s.quotes));
    if (s.indices.length > 0) {
      const head = document.createElement("div");
      head.className = "pet-stock-section-head";
      head.textContent = "指数";
      el.appendChild(head);
      el.appendChild(renderRows(s.indices));
    }
    return el;
  },

  renderSettings(cfg, onSave) {
    const c = { ...DEFAULT_CFG, ...(cfg as Partial<StocksConfigView> | null) };
    const el = document.createElement("div");
    el.className = "pet-plugin-form";

    const checkRow = document.createElement("label");
    checkRow.className = "pet-plugin-form-row";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.checked = c.enabled;
    const label = document.createElement("span");
    label.textContent = "启用";
    checkRow.append(box, label);
    el.appendChild(checkRow);

    const symRow = document.createElement("div");
    symRow.className = "pet-plugin-form-row";
    const symbols = document.createElement("input");
    symbols.type = "text";
    symbols.value = c.symbols.join(", ");
    symbols.placeholder = "如 sh600519, usAAPL, hk00700";
    symbols.spellcheck = false;
    symbols.style.flex = "1";
    const symLabel = document.createElement("span");
    symLabel.textContent = "关注标的";
    symRow.append(symLabel, symbols);
    el.appendChild(symRow);

    const symHint = document.createElement("div");
    symHint.className = "pet-plugin-form-hint";
    symHint.textContent =
      "最多 10 只；A股加 sh/sz 前缀，港股 hk，美股 us（如 sh600519 / hk00700 / usAAPL）；留空则默认展示上证/恒指/纳指三大指数，配置后指数退到卡片「查看指数」";
    el.appendChild(symHint);

    const numRow = document.createElement("div");
    numRow.className = "pet-plugin-form-row";
    const threshold = document.createElement("input");
    threshold.type = "number";
    threshold.min = "0.1";
    threshold.max = "20";
    threshold.step = "0.5";
    threshold.value = String(c.change_threshold_pct);
    const thLabel = document.createElement("span");
    thLabel.textContent = "变动阈值%";
    const after = document.createElement("input");
    after.type = "text";
    after.value = c.summarize_after;
    after.style.width = "56px";
    const afterLabel = document.createElement("span");
    afterLabel.textContent = "收盘总结";
    numRow.append(thLabel, threshold, afterLabel, after);
    el.appendChild(numRow);

    const winRow = document.createElement("div");
    winRow.className = "pet-plugin-form-row";
    const windows = document.createElement("input");
    windows.type = "text";
    windows.value = c.windows.length > 0 ? windowsToText(c.windows) : DEFAULT_WINDOWS_TEXT;
    windows.spellcheck = false;
    windows.style.flex = "1";
    const winLabel = document.createElement("span");
    winLabel.textContent = "展示时段";
    winRow.append(winLabel, windows);
    el.appendChild(winRow);

    const epRow = document.createElement("div");
    epRow.className = "pet-plugin-form-row";
    const endpoint = document.createElement("input");
    endpoint.type = "text";
    endpoint.value = c.endpoint;
    endpoint.spellcheck = false;
    endpoint.style.flex = "1";
    const epLabel = document.createElement("span");
    epLabel.textContent = "行情端点";
    epRow.append(epLabel, endpoint);
    el.appendChild(epRow);

    const hint = document.createElement("div");
    hint.className = "pet-plugin-form-hint";
    hint.textContent =
      "行情每 2 分钟刷新一次（面板随时是实时数据）；只在展示时段（默认午休+收盘后）出卡提示，变动超过阈值才出，收盘后一次小结。数字永远来自接口；配置 AI 后小结附一句点评";
    el.appendChild(hint);

    const save = document.createElement("button");
    save.className = "pet-plugin-form-save";
    save.textContent = "保存";
    save.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const syms = symbols.value
        .split(/[,，\s]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .slice(0, 10);
      const wins = parseWindowsText(windows.value);
      onSave({
        enabled: box.checked,
        symbols: syms,
        endpoint: endpoint.value.trim() || c.endpoint,
        windows: wins.length > 0 ? wins : DEFAULT_CFG.windows,
        change_threshold_pct: Number(threshold.value) || c.change_threshold_pct,
        summarize_after: after.value.trim(),
      });
      save.textContent = "已保存 ✓";
      setTimeout(() => (save.textContent = "保存"), 1200);
    });
    el.appendChild(save);

    for (const input of [box, symbols, threshold, after, windows, endpoint] as HTMLElement[]) {
      input.addEventListener("keydown", (e) => e.stopPropagation());
    }
    return el;
  },
};
