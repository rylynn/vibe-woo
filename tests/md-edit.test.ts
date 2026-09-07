// 速记编辑变换纯函数测试；纯字符串运算，node 环境即可。
import { describe, expect, it } from "vitest";
import { continueList, wrapLink, wrapSelection } from "../src/overlay/md-edit";

describe("选区包裹（⌘B/⌘I/⌘E）", () => {
  it("有选区：两端插标记，选区保持覆盖原文字", () => {
    const r = wrapSelection("ab粗cd", 2, 3, "**");
    expect(r.text).toBe("ab**粗**cd");
    expect([r.selStart, r.selEnd]).toEqual([4, 5]);
  });

  it("无选区：插入空标记对，光标落中间", () => {
    const r = wrapSelection("ab", 2, 2, "**");
    expect(r.text).toBe("ab****");
    // 光标在两段 ** 之间（下标 4）而非第一段 ** 内部 —— 落 3 会被后续输入拆坏标记，
    // 且实测实现返回 4（实施计划原文写 3 是笔误）。
    expect([r.selStart, r.selEnd]).toEqual([4, 4]);
  });

  it("再按一次去掉标记（toggle）", () => {
    const r = wrapSelection("ab**粗**cd", 4, 5, "**");
    expect(r.text).toBe("ab粗cd");
    expect([r.selStart, r.selEnd]).toEqual([2, 3]);
  });

  it("光标在空标记对中间时再按也去掉", () => {
    const r = wrapSelection("a****b", 3, 3, "**");
    expect(r.text).toBe("ab");
    expect([r.selStart, r.selEnd]).toEqual([1, 1]);
  });
});

describe("链接包裹（⌘K）", () => {
  it("有选区：[选区]()，光标落括号内", () => {
    const r = wrapLink("看这页", 0, 2);
    expect(r.text).toBe("[看这]()页");
    expect([r.selStart, r.selEnd]).toEqual([5, 5]);
  });

  it("无选区：[]()，光标落方括号内", () => {
    const r = wrapLink("ab", 2, 2);
    expect(r.text).toBe("ab[]()");
    expect([r.selStart, r.selEnd]).toEqual([3, 3]);
  });
});

describe("回车自动续列表前缀", () => {
  it("无序列表续行", () => {
    const r = continueList("- 买咖啡", 5);
    expect(r).toEqual({ prevent: true, text: "- 买咖啡\n- ", selStart: 8, selEnd: 8 });
  });

  it("有序列表数字递增", () => {
    const r = continueList("1. 第一", 5);
    expect(r).toEqual({ prevent: true, text: "1. 第一\n2. ", selStart: 9, selEnd: 9 });
  });

  it("任务列表续行为未完成态", () => {
    const r = continueList("- [x] 完成", 8);
    expect(r).toEqual({ prevent: true, text: "- [x] 完成\n- [ ] ", selStart: 15, selEnd: 15 });
  });

  it("空无序项回车结束列表（吃掉前缀不换行）", () => {
    const r = continueList("- ", 2);
    expect(r).toEqual({ prevent: true, text: "", selStart: 0, selEnd: 0 });
  });

  it("空任务项回车结束列表", () => {
    const r = continueList("- [ ] ", 6);
    expect(r).toEqual({ prevent: true, text: "", selStart: 0, selEnd: 0 });
  });

  it("空有序项回车结束列表", () => {
    const r = continueList("1. ", 3);
    expect(r).toEqual({ prevent: true, text: "", selStart: 0, selEnd: 0 });
  });

  it("非列表行返回 null 走默认换行", () => {
    expect(continueList("普通文本", 2)).toBeNull();
  });

  it("行中回车：在光标处断行并接前缀", () => {
    const r = continueList("- abcd", 4);
    expect(r).toEqual({ prevent: true, text: "- ab\n- cd", selStart: 7, selEnd: 7 });
  });
});
