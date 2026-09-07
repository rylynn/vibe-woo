/**
 * 速记轻量 Markdown 行内渲染（设计：docs/superpowers/specs/2026-09-07-quicknote-markdown-design.md）。
 *
 * 只支持行内四件套：**粗体**、*斜体*、`代码`、[文字](https://…)，
 * 外加行级任务前缀 - [ ] / - [x] → ☐ / ☑。
 * 全 DOM API 构建（textContent 赋值，绝不 innerHTML）—— XSS 从结构上免疫；
 * 链接 href 只放行 http(s)，其余 scheme 一律按纯文本。
 */

/** 链接白名单：只放行 http(s)。 */
function safeHref(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

/**
 * 行内解析。陷阱规则：
 * - `**` 优先于 `*`（先匹配双星）
 * - 未闭合标记原样显示（不吞字符）
 * - 标记内侧两端需非空白（`** 空 **` 不算粗体）
 * - 单星斜体的开星号前若是字母/数字则不视为标记（防 `2*3*4` 乘号误伤；
 *   中文邻接允许 —— 速记场景用户意图就是斜体）
 */
export function renderInline(text: string): Node[] {
  const out: Node[] = [];
  let plain = "";

  const flush = () => {
    if (plain) {
      out.push(document.createTextNode(plain));
      plain = "";
    }
  };

  let i = 0;
  while (i < text.length) {
    // 行内代码：`...`（内部不再解析任何标记）
    if (text[i] === "`") {
      const end = text.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        const code = document.createElement("code");
        code.textContent = text.slice(i + 1, end);
        out.push(code);
        i = end + 1;
        continue;
      }
    }
    // 链接：[文字](url)
    if (text[i] === "[") {
      const close = text.indexOf("]", i + 1);
      if (close > i + 1 && text[close + 1] === "(") {
        const end = text.indexOf(")", close + 2);
        if (end > close + 2) {
          const href = safeHref(text.slice(close + 2, end));
          if (href) {
            flush();
            const a = document.createElement("a");
            a.textContent = text.slice(i + 1, close);
            a.setAttribute("href", href);
            out.push(a);
            i = end + 1;
            continue;
          }
        }
      }
    }
    // 粗体/斜体：** 优先于 *
    if (text[i] === "*") {
      const dbl = text.startsWith("**", i);
      const marker = dbl ? "**" : "*";
      const end = text.indexOf(marker, i + marker.length);
      const valid = end > i + marker.length;
      const inner = valid ? text.slice(i + marker.length, end) : "";
      const innerOk =
        inner.length > 0 &&
        !/\s/.test(inner[0]) &&
        !/\s/.test(inner[inner.length - 1]);
      // 单星斜体：开星号前是字母/数字（乘号场景）不视为标记
      const boundaryOk = dbl || i === 0 || !/[0-9A-Za-z]/.test(text[i - 1]);
      if (valid && innerOk && boundaryOk) {
        flush();
        const el = document.createElement(dbl ? "strong" : "em");
        // 内部递归解析（如 **粗 `代码` 粗**）
        for (const n of renderInline(inner)) el.appendChild(n);
        out.push(el);
        i = end + marker.length;
        continue;
      }
    }
    plain += text[i];
    i++;
  }
  flush();
  return out;
}

/**
 * 渲染一行速记内容：任务前缀 → ☐/☑，其余走行内四件套。
 * 任务前缀须带尾随空白（`- [ ] 买咖啡`），光秃的 `- [ ]` 按普通文本处理。
 */
export function renderLine(line: string): Node[] {
  const m = line.match(/^[-*]\s+\[( |x|X)\]\s+/);
  if (!m) return renderInline(line);
  const done = m[1] !== " ";
  const box = document.createElement("span");
  box.className = done ? "pet-md-task-done" : "pet-md-task";
  box.textContent = done ? "☑" : "☐";
  return [box, ...renderInline(line.slice(m[0].length))];
}
