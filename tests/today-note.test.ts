// @vitest-environment happy-dom
// 速记行渲染要造 DOM 节点；其余测试保持 node 环境零开销。
import { describe, expect, it } from "vitest";
import { renderNoteRow } from "../src/overlay/today";

const note = (text: string, kind = "note") => ({ text, tags: [], kind });

describe("今日速记行渲染", () => {
  it("单行纯文本原样", () => {
    const row = renderNoteRow(note("记得买咖啡"), false);
    expect(row.textContent).toBe("记得买咖啡");
    expect(row.querySelector("code")).toBeNull();
  });

  it("首行行内语法渲染", () => {
    const row = renderNoteRow(note("**P0** 修 `闪退`"), false);
    expect(row.querySelector("strong")?.textContent).toBe("P0");
    expect(row.querySelector("code")?.textContent).toBe("闪退");
  });

  it("多行收起时显示行数提示且不逐行渲染", () => {
    const row = renderNoteRow(note("一行\n二行\n三行"), false);
    expect(row.textContent).toContain("…3 行");
    expect(row.querySelector(".pet-today-line")).toBeNull();
  });

  it("展开时逐行渲染任务勾选与链接", () => {
    const text = "周会\n- [ ] 回邮件\n- [x] 发周报 [主页](https://example.com)";
    const row = renderNoteRow(note(text), true);
    expect(row.querySelectorAll(".pet-today-line").length).toBe(3);
    expect(row.textContent).toContain("☐");
    expect(row.textContent).toContain("☑");
    expect(row.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
  });

  it("kind 徽标照旧", () => {
    const row = renderNoteRow(note("x", "todo"), false);
    expect(row.querySelector(".pet-today-kind.kind-todo")?.textContent).toBe("todo");
  });
});
