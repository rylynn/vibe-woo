// @vitest-environment happy-dom
// 行内渲染器要造 DOM 节点；其余测试保持 node 环境零开销。
import { describe, expect, it } from "vitest";
import { renderInline, renderLine } from "../src/overlay/md-inline";

describe("行内 Markdown 渲染", () => {
  it("粗体渲染 strong", () => {
    const out = renderInline("**P0** 修闪退");
    expect((out[0] as HTMLElement).tagName).toBe("STRONG");
    expect(out[0].textContent).toBe("P0");
    expect(out[1].textContent).toBe(" 修闪退");
  });

  it("斜体渲染 em", () => {
    const out = renderInline("*重点* 后文");
    expect((out[0] as HTMLElement).tagName).toBe("EM");
  });

  it("行内代码渲染 code 且内部标记不再解析", () => {
    const out = renderInline("用 `**cron**` 跑");
    const code = out.find((n) => (n as HTMLElement).tagName === "CODE");
    expect(code?.textContent).toBe("**cron**");
  });

  it("链接放行 https", () => {
    const out = renderInline("看 [项目](https://example.com) 去");
    const a = out.find((n) => (n as HTMLElement).tagName === "A");
    expect(a?.textContent).toBe("项目");
    // 用 getAttribute 避免 happy-dom 把 href 解析成绝对地址
    expect((a as HTMLElement).getAttribute("href")).toBe("https://example.com");
  });

  it("非 http(s) scheme 按纯文本渲染", () => {
    const out = renderInline("[x](javascript:alert(1))");
    const text = out.map((n) => n.textContent).join("");
    expect(text).toBe("[x](javascript:alert(1))");
    expect(out.find((n) => (n as HTMLElement).tagName === "A")).toBeUndefined();
  });

  it("未闭合标记原样显示", () => {
    const out = renderInline("**没有闭合");
    expect(out.map((n) => n.textContent).join("")).toBe("**没有闭合");
  });

  it("2*3*4 不误伤为斜体", () => {
    const out = renderInline("2*3*4");
    expect(out.map((n) => n.textContent).join("")).toBe("2*3*4");
    expect(out.find((n) => (n as HTMLElement).tagName === "EM")).toBeUndefined();
  });

  it("标记内侧空白不生效", () => {
    const out = renderInline("** 空 **");
    expect(out.map((n) => n.textContent).join("")).toBe("** 空 **");
  });

  it("粗体内递归解析行内代码", () => {
    const out = renderInline("**粗 `代` 粗**");
    const strong = out[0] as HTMLElement;
    expect(strong.tagName).toBe("STRONG");
    expect(strong.querySelector("code")?.textContent).toBe("代");
  });

  it("中文邻接的斜体正常渲染", () => {
    const out = renderInline("前文*斜*后文");
    expect(out.find((n) => (n as HTMLElement).tagName === "EM")).toBeTruthy();
  });

  it("任务行渲染勾选框", () => {
    const todo = renderLine("- [ ] 买咖啡");
    expect(todo[0].textContent).toBe("☐");
    expect((todo[0] as HTMLElement).className).toBe("pet-md-task");
    expect(todo[1].textContent).toBe("买咖啡");

    const done = renderLine("- [x] 发周报");
    expect(done[0].textContent).toBe("☑");
    expect((done[0] as HTMLElement).className).toBe("pet-md-task-done");
  });

  it("普通行原样走行内渲染", () => {
    const out = renderLine("普通文本");
    expect(out.length).toBe(1);
    expect(out[0].textContent).toBe("普通文本");
  });
});
