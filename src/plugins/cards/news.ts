import type { PluginFrontend } from "../registry";

/** 卡片 payload（与 Rust news.rs 契约一致）。 */
interface NewsPayload {
  headline: string;
  source: string;
  url: string;
  digest: string | null;
  ai: boolean;
}

/** 配置（与 Rust NewsConfig 契约一致）。 */
interface NewsConfigView {
  enabled: boolean;
  categories: string[];
  fetch_hour: number;
}

const DEFAULT_CFG: NewsConfigView = {
  enabled: false,
  categories: ["tech"],
  fetch_hour: 9,
};

/** 类别（与 Rust CATEGORIES 清单一致）。 */
const CATEGORIES: [string, string][] = [
  ["tech", "科技"],
  ["finance", "财经"],
  ["design", "设计"],
];

/** 每日资讯的前端三视图。 */
export const newsFrontend: PluginFrontend = {
  renderCard(card, host) {
    const p = card.payload as NewsPayload;
    const el = document.createElement("div");
    el.className = "pet-card-news";

    const tag = document.createElement("div");
    tag.className = "pet-card-tag";
    tag.textContent = `📰 资讯 · ${p.source}`;
    el.appendChild(tag);

    const headline = document.createElement("div");
    headline.className = "pet-news-headline";
    headline.textContent = p.headline;
    el.appendChild(headline);

    if (p.digest) {
      const digest = document.createElement("div");
      digest.className = "pet-news-digest";
      digest.textContent = p.digest;
      el.appendChild(digest);
    }

    const link = document.createElement("button");
    link.className = "pet-news-link";
    link.textContent = "阅读原文 ↗";
    link.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      host.openUrl(p.url);
    });
    el.appendChild(link);
    return el;
  },

  renderSection(data, host) {
    const s = data as {
      enabled: boolean;
      categories: string[];
      today_count: number;
      remaining: number;
      latest: { headline: string; source: string; url: string }[];
    };
    const el = document.createElement("div");
    el.className = "pet-card-news-section";
    if (!s.enabled) {
      el.textContent = "未启用";
      return el;
    }
    const cats = s.categories
      .map((c) => CATEGORIES.find(([id]) => id === c)?.[1] ?? c)
      .join("、");
    const head = document.createElement("div");
    head.className = "pet-news-section-head";
    head.textContent = `${cats} · 今日 ${s.today_count} 条`;
    el.appendChild(head);

    for (const item of s.latest) {
      const row = document.createElement("div");
      row.className = "pet-news-row";
      row.textContent = item.headline;
      row.title = `${item.source} · 点击打开原文`;
      row.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        host.openUrl(item.url);
      });
      el.appendChild(row);
    }
    return el;
  },

  renderSettings(cfg, onSave) {
    const c = { ...DEFAULT_CFG, ...(cfg as Partial<NewsConfigView> | null) };
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

    // 类别多选（≤3，达到上限后其余禁用）
    const catRow = document.createElement("div");
    catRow.className = "pet-plugin-form-row";
    const catLabel = document.createElement("span");
    catLabel.textContent = "类别";
    catRow.appendChild(catLabel);
    const boxes: [HTMLInputElement, string][] = [];
    for (const [id, name] of CATEGORIES) {
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = c.categories.includes(id);
      const l = document.createElement("label");
      l.className = "pet-news-cat";
      l.append(cb, document.createTextNode(name));
      catRow.appendChild(l);
      boxes.push([cb, id]);
    }
    el.appendChild(catRow);

    const hourRow = document.createElement("div");
    hourRow.className = "pet-plugin-form-row";
    const hour = document.createElement("input");
    hour.type = "number";
    hour.min = "0";
    hour.max = "23";
    hour.value = String(c.fetch_hour);
    const hourLabel = document.createElement("span");
    hourLabel.textContent = "每天几点抓取";
    hourRow.append(hourLabel, hour);
    el.appendChild(hourRow);

    const hint = document.createElement("div");
    hint.className = "pet-plugin-form-hint";
    hint.textContent =
      "每天到点抓一次，之后从缓存出卡（2 小时一条）；标题与链接来自源站，配置 AI 后附一句当日点评";
    el.appendChild(hint);

    const save = document.createElement("button");
    save.className = "pet-plugin-form-save";
    save.textContent = "保存";
    save.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      const picked = boxes.filter(([cb]) => cb.checked).map(([, id]) => id);
      onSave({
        enabled: box.checked,
        categories: picked.length > 0 ? picked.slice(0, 3) : ["tech"],
        fetch_hour: Math.max(0, Math.min(23, Number(hour.value) || 9)),
      });
      save.textContent = "已保存 ✓";
      setTimeout(() => (save.textContent = "保存"), 1200);
    });
    el.appendChild(save);

    for (const input of [box, hour, ...boxes.map(([cb]) => cb)] as HTMLElement[]) {
      input.addEventListener("keydown", (e) => e.stopPropagation());
    }
    return el;
  },
};
