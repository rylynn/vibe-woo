import type { PluginFrontend } from "../registry";

/** 卡片 payload（与 Rust words.rs 的 make_card 契约一致）。 */
interface WordPayload {
  term: string;
  reading: string;
  meaning: string;
  example: string;
  hook: string | null;
  ai: boolean;
}

/** 配置（与 Rust WordsConfig 契约一致）。 */
interface WordsConfigView {
  enabled: boolean;
  language: string;
  level: string;
  goal: string;
  daily_limit: number;
  only_resting: boolean;
  books: string[];
}

const DEFAULT_CFG: WordsConfigView = {
  enabled: false,
  language: "english",
  level: "intermediate",
  goal: "",
  daily_limit: 8,
  only_resting: true,
  books: [],
};

const LANGS: [string, string][] = [
  ["english", "英语"],
  ["japanese", "日语"],
];

const LEVELS: [string, string][] = [
  ["beginner", "入门"],
  ["intermediate", "进阶"],
  ["advanced", "高级"],
];

/** 学外语的前端三视图。 */
export const wordFrontend: PluginFrontend = {
  renderCard(card, host) {
    const p = card.payload as WordPayload;
    const el = document.createElement("div");
    el.className = "pet-card-word";

    const tag = document.createElement("div");
    tag.className = "pet-card-tag";
    tag.textContent = "📖 单词";
    el.appendChild(tag);

    const termRow = document.createElement("div");
    termRow.className = "pet-word-term";
    const term = document.createElement("span");
    term.className = "pet-word-term-text";
    term.textContent = p.term;
    const reading = document.createElement("span");
    reading.className = "pet-word-reading";
    reading.textContent = p.reading;
    termRow.append(term, reading);
    el.appendChild(termRow);

    const meaning = document.createElement("div");
    meaning.className = "pet-word-meaning";
    meaning.textContent = p.meaning;
    el.appendChild(meaning);

    if (p.hook) {
      const hook = document.createElement("div");
      hook.className = "pet-word-hook";
      hook.textContent = `💡 ${p.hook}`;
      el.appendChild(hook);
    }

    const example = document.createElement("div");
    example.className = "pet-word-example";
    example.textContent = p.example;
    el.appendChild(example);

    // 反馈闭环：认识 / 没印象（点击后由 cardHost 关闭气泡）
    const actions = document.createElement("div");
    actions.className = "pet-word-actions";
    const known = btn("认识 ✓", "pet-word-btn good");
    known.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      host.markTerm(p.term, true);
    });
    const unknown = btn("没印象 ✗", "pet-word-btn bad");
    unknown.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      host.markTerm(p.term, false);
    });
    actions.append(known, unknown);
    el.appendChild(actions);
    return el;
  },

  renderSection(data) {
    const s = data as {
      enabled: boolean;
      language: string;
      today_count: number;
      daily_limit: number;
      recent: { term: string; meaning: string }[];
    };
    const el = document.createElement("div");
    el.className = "pet-card-word-section";
    if (!s.enabled) {
      el.textContent = "未启用";
      return el;
    }
    const head = document.createElement("div");
    head.textContent = `今日 ${s.today_count}/${s.daily_limit} 张`;
    el.appendChild(head);
    if (s.recent.length > 0) {
      const list = document.createElement("div");
      list.className = "pet-word-recent";
      for (const r of s.recent) {
        const row = document.createElement("div");
        row.className = "pet-word-recent-row";
        const t = document.createElement("span");
        t.textContent = r.term;
        const m = document.createElement("span");
        m.textContent = r.meaning;
        row.append(t, m);
        list.appendChild(row);
      }
      el.appendChild(list);
    }
    return el;
  },

  renderSettings(cfg, onSave) {
    const c = { ...DEFAULT_CFG, ...(cfg as Partial<WordsConfigView> | null) };
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

    // 语言 + 水平
    const selRow = document.createElement("div");
    selRow.className = "pet-plugin-form-row";
    const lang = select(LANGS, c.language);
    const langLabel = document.createElement("span");
    langLabel.textContent = "语言";
    const level = select(LEVELS, c.level);
    const levelLabel = document.createElement("span");
    levelLabel.textContent = "水平";
    selRow.append(langLabel, lang, levelLabel, level);
    el.appendChild(selRow);

    // 学习目标（LLM 例句场景）
    const goalRow = document.createElement("div");
    goalRow.className = "pet-plugin-form-row";
    const goal = document.createElement("input");
    goal.type = "text";
    goal.value = c.goal;
    goal.placeholder = "如：旅游会话 / 商务邮件";
    goal.spellcheck = false;
    goal.style.flex = "1";
    const goalLabel = document.createElement("span");
    goalLabel.textContent = "目标";
    goalRow.append(goalLabel, goal);
    el.appendChild(goalRow);

    // 每日上限 + 只在休息时
    const numRow = document.createElement("div");
    numRow.className = "pet-plugin-form-row";
    const limit = document.createElement("input");
    limit.type = "number";
    limit.min = "1";
    limit.max = "50";
    limit.value = String(c.daily_limit);
    const limitLabel = document.createElement("span");
    limitLabel.textContent = "每日上限";
    const rest = document.createElement("input");
    rest.type = "checkbox";
    rest.checked = c.only_resting;
    const restLabel = document.createElement("span");
    restLabel.textContent = "只在休息时弹";
    numRow.append(limitLabel, limit, rest, restLabel);
    el.appendChild(numRow);

    const hint = document.createElement("div");
    hint.className = "pet-plugin-form-hint";
    hint.textContent =
      "词与释义来自内置词库（雅思/托福/日常 × 英日）；配置 AI 后例句与记忆钩子按你的目标定制。没印象的词 10 分钟后会再回来";
    el.appendChild(hint);

    const save = document.createElement("button");
    save.className = "pet-plugin-form-save";
    save.textContent = "保存";
    save.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      onSave({
        enabled: box.checked,
        language: LANGS[lang.selectedIndex]?.[0] ?? c.language,
        level: LEVELS[level.selectedIndex]?.[0] ?? c.level,
        goal: goal.value.trim().slice(0, 40),
        daily_limit: Math.max(1, Math.min(50, Number(limit.value) || 8)),
        only_resting: rest.checked,
        books: c.books,
      });
      save.textContent = "已保存 ✓";
      setTimeout(() => (save.textContent = "保存"), 1200);
    });
    el.appendChild(save);

    for (const input of [box, lang, level, goal, limit, rest] as HTMLElement[]) {
      input.addEventListener("keydown", (e) => e.stopPropagation());
    }
    return el;
  },
};

function btn(text: string, cls: string): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = cls;
  b.textContent = text;
  return b;
}

function select(options: [string, string][], value: string): HTMLSelectElement {
  const s = document.createElement("select");
  for (const [v, label] of options) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = label;
    if (v === value) opt.selected = true;
    s.appendChild(opt);
  }
  return s;
}
