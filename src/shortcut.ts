/**
 * 快捷键字符串的解析、展示与按键捕获（前端侧）。
 *
 * 存储格式与 Rust 侧 shortcut.rs::parse 一致：
 *   修饰键与主键用 "+" 连接，如 "Alt+Space"、"Ctrl+Shift+R"。
 *   修饰键：Alt / Ctrl / Cmd / Shift；
 *   主键：字母 A–Z、数字 0–9、F1–F12、Space/Enter/Tab/Backspace/Delete、
 *   方向键 Up/Down/Left/Right、Escape、符号键 Backquote/Minus/Equal/
 *   BracketLeft/BracketRight/Backslash/Semicolon/Quote/Comma/Period/Slash。
 *
 * 准入规则与 Rust 侧相同：必须至少含一个非 Shift 修饰键，
 * 否则全局快捷键会拦截用户的正常打字。
 */

/** 规范化的快捷键：mods 为出现顺序无关的集合，key 为主键规范名。 */
export interface ParsedShortcut {
  mods: string[];
  key: string;
}

/** e.code → 主键规范名（字母 / 数字以外的键）。 */
const CODE_TO_KEY: Record<string, string> = {
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
  Escape: "Escape",
  Backquote: "Backquote",
  Minus: "Minus",
  Equal: "Equal",
  BracketLeft: "BracketLeft",
  BracketRight: "BracketRight",
  Backslash: "Backslash",
  Semicolon: "Semicolon",
  Quote: "Quote",
  Comma: "Comma",
  Period: "Period",
  Slash: "Slash",
};

/** 修饰键别名（用户可能在别处看到 Option / Meta 的写法）。 */
const MOD_ALIASES: Record<string, string> = {
  ALT: "Alt",
  OPTION: "Alt",
  OPT: "Alt",
  CTRL: "Ctrl",
  CONTROL: "Ctrl",
  CMD: "Cmd",
  META: "Cmd",
  SUPER: "Cmd",
  WIN: "Cmd",
  SHIFT: "Shift",
};

/** 大写键名 → 主键规范名（parseShortcut 的输入会被 toUpperCase）。 */
const KEY_BY_UPPER: Record<string, string> = {
  SPACE: "Space",
  ENTER: "Enter",
  RETURN: "Enter",
  TAB: "Tab",
  BACKSPACE: "Backspace",
  DELETE: "Delete",
  DEL: "Delete",
  UP: "Up",
  DOWN: "Down",
  LEFT: "Left",
  RIGHT: "Right",
  ESC: "Escape",
  ESCAPE: "Escape",
  BACKQUOTE: "Backquote",
  MINUS: "Minus",
  EQUAL: "Equal",
  BRACKETLEFT: "BracketLeft",
  BRACKETRIGHT: "BracketRight",
  BACKSLASH: "Backslash",
  SEMICOLON: "Semicolon",
  QUOTE: "Quote",
  COMMA: "Comma",
  PERIOD: "Period",
  SLASH: "Slash",
};

function normalizeKeyToken(token: string): string {
  if (KEY_BY_UPPER[token]) return KEY_BY_UPPER[token];
  if (/^F([1-9]|1[0-2])$/.test(token)) return token;
  if (token.length === 1 && /[A-Z0-9]/.test(token)) return token;
  return "";
}

/** 解析存储格式；非法（含缺修饰键）返回 null。 */
export function parseShortcut(s: string): ParsedShortcut | null {
  const mods = new Set<string>();
  let key = "";
  let seenKey = false;
  for (const raw of s.split("+")) {
    const token = raw.trim().toUpperCase();
    if (!token) return null;
    const mod = MOD_ALIASES[token];
    if (mod) {
      mods.add(mod);
      continue;
    }
    if (seenKey) return null; // 多个主键
    key = normalizeKeyToken(token);
    if (!key) return null;
    seenKey = true;
  }
  if (!seenKey) return null;
  if (!mods.has("Alt") && !mods.has("Ctrl") && !mods.has("Cmd")) return null;
  return { mods: [...mods], key };
}

/** 是否为合法快捷键（含非 Shift 修饰键）。 */
export function isValidShortcut(s: string): boolean {
  return parseShortcut(s) !== null;
}

const MOD_SYMBOLS: Record<string, string> = {
  Ctrl: "⌃",
  Alt: "⌥",
  Shift: "⇧",
  Cmd: "⌘",
};

const KEY_SYMBOLS: Record<string, string> = {
  Enter: "↩",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Up: "↑",
  Down: "↓",
  Left: "←",
  Right: "→",
  Escape: "Esc",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Semicolon: ";",
  Quote: "'",
  Comma: ",",
  Period: ".",
  Slash: "/",
};

/** 展示用：mac 符号风格，如 "⌥Space"、"⌃⇧R"。非法串原样返回。 */
export function prettyShortcut(s: string): string {
  const p = parseShortcut(s);
  if (!p) return s || "未设置";
  // mac 菜单惯例顺序：⌃ ⌥ ⇧ ⌘
  const order = ["Ctrl", "Alt", "Shift", "Cmd"];
  const mods = order
    .filter((m) => p.mods.includes(m))
    .map((m) => MOD_SYMBOLS[m])
    .join("");
  return mods + (KEY_SYMBOLS[p.key] ?? p.key);
}

/**
 * 把 keydown 事件转成存储格式。
 * 纯修饰键按下、或键位不可识别时返回 null（调用方应继续等待）。
 */
export function shortcutFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.metaKey) mods.push("Cmd");
  if (e.ctrlKey) mods.push("Ctrl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");
  let key = "";
  if (/^Key[A-Z]$/.test(e.code)) {
    key = e.code.slice(3);
  } else if (/^Digit[0-9]$/.test(e.code)) {
    key = e.code.slice(5);
  } else if (/^F([1-9]|1[0-2])$/.test(e.code)) {
    key = e.code;
  } else {
    key = CODE_TO_KEY[e.code] ?? "";
  }
  if (!key) return null;
  return [...mods, key].join("+");
}
