import { describe, it, expect } from "vitest";
import {
  parseShortcut,
  prettyShortcut,
  shortcutFromEvent,
  isValidShortcut,
} from "../src/shortcut";

describe("parseShortcut", () => {
  it("解析默认组合", () => {
    expect(parseShortcut("Alt+Space")).toEqual({ mods: ["Alt"], key: "Space" });
    expect(parseShortcut("Alt+R")).toEqual({ mods: ["Alt"], key: "R" });
    expect(parseShortcut("Alt+P")).toEqual({ mods: ["Alt"], key: "P" });
  });

  it("大小写不敏感且容忍空格", () => {
    expect(parseShortcut(" alt + r ")).toEqual({ mods: ["Alt"], key: "R" });
    expect(parseShortcut("CMD+P")).toEqual({ mods: ["Cmd"], key: "P" });
  });

  it("修饰键别名归一化", () => {
    expect(parseShortcut("Option+P")!.mods).toContain("Alt");
    expect(parseShortcut("Meta+F5")!.mods).toContain("Cmd");
    expect(parseShortcut("CONTROL+K")!.mods).toContain("Ctrl");
  });

  it("多修饰键全保留", () => {
    const p = parseShortcut("Ctrl+Shift+Space")!;
    expect(p.mods).toEqual(expect.arrayContaining(["Ctrl", "Shift"]));
    expect(p.key).toBe("Space");
  });

  it("拒绝缺修饰键的纯键 / 纯 Shift（会拦截正常打字）", () => {
    expect(parseShortcut("F5")).toBeNull();
    expect(parseShortcut("Shift+R")).toBeNull();
  });

  it("拒绝格式错误", () => {
    expect(parseShortcut("")).toBeNull();
    expect(parseShortcut("Alt+")).toBeNull();
    expect(parseShortcut("Alt")).toBeNull();
    expect(parseShortcut("Alt+R+S")).toBeNull();
    expect(parseShortcut("Alt+KeyX")).toBeNull();
  });
});

describe("isValidShortcut", () => {
  it("默认值均合法", () => {
    expect(isValidShortcut("Alt+Space")).toBe(true);
    expect(isValidShortcut("Alt+R")).toBe(true);
    expect(isValidShortcut("Alt+P")).toBe(true);
  });

  it("缺修饰键不合法", () => {
    expect(isValidShortcut("Shift+A")).toBe(false);
    expect(isValidShortcut("A")).toBe(false);
    expect(isValidShortcut("")).toBe(false);
  });
});

describe("prettyShortcut", () => {
  it("mac 符号风格，修饰键按 ⌃⌥⇧⌘ 排序", () => {
    expect(prettyShortcut("Alt+Space")).toBe("⌥Space");
    expect(prettyShortcut("Ctrl+Shift+R")).toBe("⌃⇧R");
    expect(prettyShortcut("Cmd+P")).toBe("⌘P");
  });

  it("方向键等特殊键有符号", () => {
    expect(prettyShortcut("Alt+Left")).toBe("⌥←");
  });

  it("非法串原样返回，空串显示未设置", () => {
    expect(prettyShortcut("Shift+R")).toBe("Shift+R");
    expect(prettyShortcut("")).toBe("未设置");
  });
});

describe("shortcutFromEvent", () => {
  /** 造一个最小 KeyboardEvent 形状的对象。 */
  const ev = (
    code: string,
    mods: { meta?: boolean; ctrl?: boolean; alt?: boolean; shift?: boolean } = {},
  ) =>
    ({
      code,
      metaKey: mods.meta ?? false,
      ctrlKey: mods.ctrl ?? false,
      altKey: mods.alt ?? false,
      shiftKey: mods.shift ?? false,
    }) as KeyboardEvent;

  it("字母 / 数字 / 命名键 → 存储格式", () => {
    expect(shortcutFromEvent(ev("KeyR", { alt: true }))).toBe("Alt+R");
    expect(shortcutFromEvent(ev("Digit1", { ctrl: true }))).toBe("Ctrl+1");
    expect(shortcutFromEvent(ev("Space", { alt: true }))).toBe("Alt+Space");
    expect(shortcutFromEvent(ev("ArrowUp", { alt: true }))).toBe("Alt+Up");
    expect(shortcutFromEvent(ev("F5", { meta: true }))).toBe("Cmd+F5");
  });

  it("多修饰键按 Cmd Ctrl Alt Shift 顺序输出", () => {
    expect(
      shortcutFromEvent(ev("KeyK", { meta: true, ctrl: true, alt: true, shift: true })),
    ).toBe("Cmd+Ctrl+Alt+Shift+K");
  });

  it("纯修饰键按下返回 null（等待完整组合）", () => {
    expect(shortcutFromEvent(ev("AltLeft", { alt: true }))).toBeNull();
    expect(shortcutFromEvent(ev("ShiftRight", { shift: true }))).toBeNull();
    expect(shortcutFromEvent(ev("MetaLeft", { meta: true }))).toBeNull();
  });

  it("不可识别的键返回 null", () => {
    expect(shortcutFromEvent(ev("AudioPlay", { alt: true }))).toBeNull();
  });
});
