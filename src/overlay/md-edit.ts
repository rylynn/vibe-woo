/**
 * 速记编辑器的文本变换（纯函数，设计：docs/superpowers/specs/2026-09-07-quicknote-markdown-design.md）。
 *
 * quick-note.ts 的 keydown 驱动层调用这些函数拿到新文本与新选区，
 * 自身只负责写回 textarea —— 逻辑全部可单测。
 */

export interface EditResult {
  text: string;
  selStart: number;
  selEnd: number;
}

/**
 * 给选区包裹行内标记（⌘B 粗体 / ⌘I 斜体 / ⌘E 代码 共用）。
 * - 有选区：两端插标记，选区保持覆盖原文字
 * - 无选区：插入空标记对，光标落标记中间
 * - 光标/选区外侧已是标记对：去掉（toggle）
 */
export function wrapSelection(
  text: string,
  selStart: number,
  selEnd: number,
  marker: string,
): EditResult {
  const before = text.slice(Math.max(0, selStart - marker.length), selStart);
  const after = text.slice(selEnd, selEnd + marker.length);
  if (before === marker && after === marker) {
    const removed =
      text.slice(0, selStart - marker.length) +
      text.slice(selStart, selEnd) +
      text.slice(selEnd + marker.length);
    return {
      text: removed,
      selStart: selStart - marker.length,
      selEnd: selEnd - marker.length,
    };
  }
  if (selEnd > selStart) {
    return {
      text:
        text.slice(0, selStart) + marker + text.slice(selStart, selEnd) + marker + text.slice(selEnd),
      selStart: selStart + marker.length,
      selEnd: selEnd + marker.length,
    };
  }
  return {
    text: text.slice(0, selStart) + marker + marker + text.slice(selStart),
    selStart: selStart + marker.length,
    selEnd: selStart + marker.length,
  };
}

/** ⌘K 插入链接：有选区 → [选区]()，光标落 () 内；无选区 → []()，光标落 [] 内。 */
export function wrapLink(text: string, selStart: number, selEnd: number): EditResult {
  if (selEnd > selStart) {
    const inner = text.slice(selStart, selEnd);
    return {
      text: text.slice(0, selStart) + `[${inner}]()` + text.slice(selEnd),
      selStart: selEnd + 3,
      selEnd: selEnd + 3,
    };
  }
  return {
    text: text.slice(0, selStart) + "[]()" + text.slice(selStart),
    selStart: selStart + 1,
    selEnd: selStart + 1,
  };
}

/**
 * 回车在列表行内的行为；null = 非列表行（走 textarea 默认换行）。
 * - 非空列表项：在光标处断行并接上对应前缀（任务项续未完成态、有序项数字递增）
 * - 空列表项（只剩前缀）：吃掉前缀、不换行 —— 结束列表
 */
export function continueList(text: string, caret: number): EditResult & { prevent: boolean } | null {
  const lineStart = text.lastIndexOf("\n", caret - 1) + 1;
  const nl = text.indexOf("\n", caret);
  const lineEnd = nl === -1 ? text.length : nl;
  const line = text.slice(lineStart, lineEnd);

  const task = line.match(/^[-*]\s+\[( |x|X)\]\s+/);
  const bullet = line.match(/^[-*]\s+/);
  const ordered = line.match(/^(\d+)\.\s+/);

  const prefix = task?.[0] ?? bullet?.[0] ?? ordered?.[0];
  if (!prefix) return null;

  // 空列表项：吃掉前缀、结束列表（光标回行首，不换行）
  if (line.trim() === prefix.trim()) {
    return {
      prevent: true,
      text: text.slice(0, lineStart) + text.slice(lineStart + prefix.length),
      selStart: lineStart,
      selEnd: lineStart,
    };
  }

  // 非空：断行 + 接前缀
  let next: string;
  if (task) {
    next = "- [ ] ";
  } else if (ordered) {
    next = `${Number(ordered[1]) + 1}. `;
  } else {
    next = "- ";
  }
  return {
    prevent: true,
    text: text.slice(0, caret) + "\n" + next + text.slice(caret),
    selStart: caret + 1 + next.length,
    selEnd: caret + 1 + next.length,
  };
}
