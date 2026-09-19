// @vitest-environment happy-dom
// 仅本文件需要 DOM（浮窗造节点）；其余测试保持 node 环境零开销。
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const invokeMock = vi.mocked(invoke);

import {
  isTooLong,
  readErrorMessage,
  translateErrorMessage,
  SessionGuard,
  TEXT_MAX_CHARS,
  type ResultPayload,
} from "../src/text-tools";
import { TextToolsPanel } from "../src/overlay/text-tools";
import type { ConfigView } from "../src/config";

/** 面板配置（浮窗只读方向/引擎/自动翻译三项，其余字段给默认值即可）。 */
function cfg(p: Partial<ConfigView> = {}): ConfigView {
  return { auto_translate: true, translation_direction: "en2zh", search_engine: "google", ...p } as ConfigView;
}

/** 刷新宏任务：让自动翻译的 await 链与随后的 render 完成。 */
async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/** 找到面板里的主按钮（按可见文案定位，避免依赖内部结构）。 */
function buttonByText(root: ParentNode, text: string): HTMLButtonElement {
  const btn = [...root.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").includes(text),
  );
  if (!btn) throw new Error(`未找到按钮：${text}`);
  return btn as HTMLButtonElement;
}

function payload(p: Partial<ResultPayload> & { session: number }): ResultPayload {
  return {
    source: "ocr",
    outcome: { kind: "ok", text: "hello", sourceApp: null },
    ...p,
  } as ResultPayload;
}

/** Rust 侧会话号从 1 开始递增（模拟后端 SessionGate 的行为）。 */
let nextSession = 1;

beforeEach(() => {
  nextSession = 1;
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    // 框选入口返回会话号 —— 前端以它为准，不自己递增
    if (cmd === "text_tools_start_ocr") {
      return nextSession++;
    }
    // 默认视为已授权（屏幕录制查询）；未授权场景单独覆写
    if (cmd === "text_tools_screen_permission") return true;
    if (cmd === "text_tools_translate") return { kind: "ok", text: "译文" };
    return undefined;
  });
  document.body.innerHTML = "";
});

/** 开始一轮框选取词，返回 Rust 给出的会话号。 */
async function startSession(panel: TextToolsPanel): Promise<number> {
  await panel.start();
  return nextSession - 1;
}

describe("SessionGuard", () => {
  it("认领的会话号才被接受", () => {
    const g = new SessionGuard();
    g.adopt(7);
    expect(g.accepts(7)).toBe(true);
    expect(g.accepts(6)).toBe(false);
  });

  it("后认领的会话覆盖先前的（重复触发使旧会话失效）", () => {
    const g = new SessionGuard();
    g.adopt(1);
    g.adopt(2);
    expect(g.accepts(2)).toBe(true);
    expect(g.accepts(1)).toBe(false);
  });

  it("取消后所有在途结果都失效", () => {
    const g = new SessionGuard();
    g.adopt(3);
    g.cancel();
    expect(g.accepts(3)).toBe(false);
    // 取消后再认领新会话，新会话可用
    g.adopt(4);
    expect(g.accepts(4)).toBe(true);
  });

  it("缺失或非法会话号一律不接受", () => {
    const g = new SessionGuard();
    g.adopt(1);
    expect(g.accepts(undefined)).toBe(false);
    expect(g.accepts(0)).toBe(false);
    expect(g.accepts(999)).toBe(false);
  });
});

describe("契约与提示文案", () => {
  it("超长按字符数判定（中文不被字节数误判）", () => {
    expect(isTooLong("a".repeat(TEXT_MAX_CHARS))).toBe(false);
    expect(isTooLong("a".repeat(TEXT_MAX_CHARS + 1))).toBe(true);
    expect(isTooLong("汉".repeat(TEXT_MAX_CHARS))).toBe(false);
  });

  it("取消不显示错误文案（静默关闭）", () => {
    expect(readErrorMessage("cancelled")).toBe("");
  });

  it("未授权与超长给出可操作的中文提示", () => {
    expect(readErrorMessage("not_trusted")).toContain("屏幕录制");
    expect(readErrorMessage("too_long")).toContain(String(TEXT_MAX_CHARS));
    expect(translateErrorMessage("llm_disabled")).toContain("启用 AI");
    expect(translateErrorMessage("llm_not_configured")).toContain("配置");
  });

  it("框选区域没有文字时是待框选引导，不是失败", () => {
    expect(readErrorMessage("no_selection")).toContain("重新框选");
  });
});

describe("取词浮窗", () => {
  it("取词结果默认自动翻译（无需点击），译文直接呈现", async () => {
    const panel = new TextToolsPanel();
    const s = await startSession(panel);
    panel.onResult(payload({ session: s }));
    await flush();

    const call = invokeMock.mock.calls.find((c) => c[0] === "text_tools_translate");
    expect(call).toBeTruthy();
    expect((call?.[1] as { text: string }).text).toBe("hello");
    expect(document.querySelector(".pet-tt-result")?.textContent).toBe("译文");
  });

  it("关闭自动翻译后不外发，仍可手动点「翻译」", async () => {
    const panel = new TextToolsPanel();
    panel.setConfig(cfg({ auto_translate: false }));
    const s = await startSession(panel);
    panel.onResult(payload({ session: s }));
    await flush();
    expect(invokeMock.mock.calls.map((c) => c[0])).not.toContain("text_tools_translate");

    buttonByText(document.body, "翻译").click();
    await flush();
    expect(invokeMock.mock.calls.map((c) => c[0])).toContain("text_tools_translate");
  });

  it("自动翻译遇 LLM 未配置静默跳过（手动点击仍会看到提示）", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "text_tools_start_ocr") return nextSession++;
      if (cmd === "text_tools_translate") {
        return { kind: "error", code: "llm_not_configured" };
      }
      return undefined;
    });
    const panel = new TextToolsPanel();
    const s = await startSession(panel);
    panel.onResult(payload({ session: s }));
    await flush();
    // 没配服务的用户不该每次取词都看到报错：维持就绪态与引导提示
    expect(document.querySelector(".pet-tt-error")).toBeNull();
    expect(document.querySelector(".pet-tt-original")).toBeTruthy();

    buttonByText(document.body, "翻译").click();
    await flush();
    expect(document.querySelector(".pet-tt-error")?.textContent).toContain("配置");
  });

  it("翻译在途时重新取词：旧译文作废，不渲染进新会话", async () => {
    const panel = new TextToolsPanel();
    const first = await startSession(panel);
    panel.onResult(payload({ session: first })); // 触发自动翻译（在途）
    const second = await startSession(panel); // 翻译没回来就重新取词
    panel.onSelectionShown();
    await flush(); // 旧译文此刻才到

    // 新会话仍处于框选等待，不得出现旧会话的译文
    expect(document.querySelector(".pet-tt-result")).toBeNull();
    expect(invokeMock.mock.calls.filter((c) => c[0] === "text_tools_translate")).toHaveLength(1);
    expect(second).not.toBe(first);
  });

  it("翻译用编辑后的文本（识别结果允许纠错）", async () => {
    const panel = new TextToolsPanel();
    panel.setConfig(cfg({ auto_translate: false })); // 手动路径：排除自动翻译干扰
    const s = await startSession(panel);
    panel.onResult(payload({ session: s }));

    const ta = document.querySelector<HTMLTextAreaElement>(".pet-tt-original")!;
    ta.value = "corrected text";
    buttonByText(document.body, "翻译").click();
    await Promise.resolve();

    const call = invokeMock.mock.calls.find((c) => c[0] === "text_tools_translate");
    expect(call).toBeTruthy();
    expect((call?.[1] as { text: string }).text).toBe("corrected text");
  });

  it("搜索交给 Rust 打开浏览器（不在前端 window.open）", async () => {
    const openSpy = vi.spyOn(window, "open");
    const panel = new TextToolsPanel();
    const s = await startSession(panel);
    panel.onResult(payload({ session: s }));
    await flush();

    buttonByText(document.body, "搜索").click();
    await Promise.resolve();

    const call = invokeMock.mock.calls.find((c) => c[0] === "text_tools_search");
    expect(call).toBeTruthy();
    expect(openSpy).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });

  it("用户取消时静默关闭，不弹错误", async () => {
    const panel = new TextToolsPanel();
    const s = await startSession(panel);
    expect(panel.isOpen).toBe(true);
    panel.onResult(
      payload({ session: s, outcome: { kind: "error", code: "cancelled" } }),
    );
    expect(panel.isOpen).toBe(false);
    expect(document.querySelector(".pet-tt-error")).toBeNull();
  });

  it("迟到/过期结果被丢弃，不覆盖正在看的内容", async () => {
    const panel = new TextToolsPanel();
    const first = await startSession(panel);
    // 再次触发 → 旧会话结果作废
    const second = await startSession(panel);
    expect(second).not.toBe(first);

    panel.onResult(
      payload({
        session: first,
        outcome: { kind: "ok", text: "过期内容", sourceApp: null },
      }),
    );
    // 仍处于框选等待，没有把过期文本渲染出来
    expect(document.querySelector(".pet-tt-original")).toBeNull();

    // 新会话的结果正常生效
    panel.onResult(
      payload({
        session: second,
        outcome: { kind: "ok", text: "有效内容", sourceApp: null },
      }),
    );
    const ta = document.querySelector<HTMLTextAreaElement>(".pet-tt-original");
    expect(ta?.value).toBe("有效内容");
  });

  it("关闭面板后再取词，结果仍能显示（会话号不因取消而错位）", async () => {
    const panel = new TextToolsPanel();
    await startSession(panel);
    panel.hide(); // Esc / × / 点外关闭

    const s = await startSession(panel);
    panel.onResult(
      payload({
        session: s,
        outcome: { kind: "ok", text: "第二轮", sourceApp: null },
      }),
    );
    const ta = document.querySelector<HTMLTextAreaElement>(".pet-tt-original");
    expect(ta?.value).toBe("第二轮");
  });

  it("结果事件先于会话号返回时不丢失（IPC 顺序竞争）", async () => {
    const panel = new TextToolsPanel();
    // 不 await：invoke 仍在途，会话号还没回到前端
    const pending = panel.start();
    // Rust 阻塞识别线程先把结果事件推到了（两条消息各走各的通道，顺序无保证）
    panel.onResult(payload({ session: 1, outcome: { kind: "ok", text: "先到的结果", sourceApp: null } }));
    await pending; // 此刻才 adopt —— 若结果被当过期丢弃，面板将永远停在读取中

    const ta = document.querySelector<HTMLTextAreaElement>(".pet-tt-original");
    expect(ta?.value).toBe("先到的结果");
  });

  it("框选期间收起旧浮窗，结果回来再恢复", async () => {
    const panel = new TextToolsPanel();
    const first = await startSession(panel);
    panel.onSelectionShown();
    panel.onResult(payload({ session: first }));
    const el = document.querySelector<HTMLElement>(".pet-text-tools")!;
    expect(el.style.display).toBe("block");

    const second = await startSession(panel);
    panel.onSelectionShown(); // Rust 已确认框选层出现
    // 480px 实色面板不应挡住要框选的屏幕
    expect(el.style.display).toBe("none");

    panel.onResult(payload({ session: second, outcome: { kind: "ok", text: "框选文字", sourceApp: null } }));
    expect(el.style.display).toBe("block");
    const ta = document.querySelector<HTMLTextAreaElement>(".pet-tt-original");
    expect(ta?.value).toBe("框选文字");
  });

  it("框选层没起来时 1.5s 报启动失败，不干等 60s 超时", async () => {
    vi.useFakeTimers();
    try {
      const panel = new TextToolsPanel();
      await startSession(panel);
      // Rust 的 shown 事件一直不来（框选层被 AppKit 吞掉等）
      await vi.advanceTimersByTimeAsync(1_500);
      expect(document.querySelector(".pet-tt-error")?.textContent).toContain("框选层启动失败");
      const retry = buttonByText(document.body, "重试框选");
      expect(retry).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("关闭面板即撤销框选层兜底计时器", async () => {
    vi.useFakeTimers();
    try {
      const panel = new TextToolsPanel();
      await startSession(panel);
      panel.hide(); // 框选等待中按 Esc
      await vi.advanceTimersByTimeAsync(1_500);
      expect(document.querySelector(".pet-tt-error")).toBeNull();
      expect(panel.isOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shown 确认先于会话号到达也不误报启动失败（IPC 顺序竞争）", async () => {
    vi.useFakeTimers();
    try {
      const panel = new TextToolsPanel();
      // 不 await：invoke 仍在途（会话号没回来），shown 事件先到了 ——
      // 若只清计时器（此刻还没武装），随后武装的计时器会在拖框途中
      // 误报「框选层启动失败」盖在框选层上（2026-09-19 实测复现）
      const pending = panel.start();
      panel.onSelectionShown();
      await pending;

      await vi.advanceTimersByTimeAsync(1_500);
      expect(document.querySelector(".pet-tt-error")).toBeNull();
      expect(panel.isOpen).toBe(true); // 仍处于框选等待，静候结果
    } finally {
      vi.useRealTimers();
    }
  });

  it("框选层启动失败且未授权时换成授权引导（重试注定再失败）", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "text_tools_start_ocr") return nextSession++;
      if (cmd === "text_tools_screen_permission") return false;
      return undefined;
    });
    vi.useFakeTimers();
    try {
      const panel = new TextToolsPanel();
      await startSession(panel);
      // shown 事件一直不来 → 兜底触发「启动失败」（同步推进：微任务先不冲，
      // 保住中间态供断言）
      vi.advanceTimersByTime(1_500);
      expect(document.querySelector(".pet-tt-error")?.textContent).toContain("框选层启动失败");
      // 授权查询的 promise 链走完后，换成「需要屏幕录制授权」+ 去授权入口
      await vi.advanceTimersByTimeAsync(0);
      const err = document.querySelector(".pet-tt-error")?.textContent ?? "";
      expect(err).toContain("屏幕录制");
      expect(buttonByText(document.body, "去系统设置授权")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("译文按纯文本渲染（外部服务返回的内容不被当 HTML 执行）", async () => {
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === "text_tools_start_ocr") return nextSession++;
      if (cmd === "text_tools_translate") {
        return { kind: "ok", text: '<img src=x onerror="alert(1)">危险' };
      }
      return undefined;
    });
    const panel = new TextToolsPanel();
    const s = await startSession(panel);
    panel.onResult(payload({ session: s }));
    buttonByText(document.body, "翻译").click();
    // 宏任务刷新：确保 doTranslate 的 await 链与随后的 render 都已完成
    await new Promise((r) => setTimeout(r, 0));

    const out = document.querySelector<HTMLElement>(".pet-tt-result");
    expect(out).toBeTruthy();
    expect(out!.textContent).toBe('<img src=x onerror="alert(1)">危险');
    expect(out!.querySelector("img")).toBeNull();
  });

  it("框选区域没有文字时提示待框选，而不是报失败", async () => {
    const panel = new TextToolsPanel();
    const s = await startSession(panel);
    panel.onResult(
      payload({ session: s, outcome: { kind: "error", code: "no_selection" } }),
    );
    // 待框选引导（而不是「选中失败」式的错误文案）
    const hints = [...document.querySelectorAll(".pet-tt-hint")].map((h) => h.textContent ?? "");
    expect(hints.some((t) => t.includes("待框选"))).toBe(true);
    expect(document.querySelector(".pet-tt-error")).toBeNull();
    // 一键重新框选
    buttonByText(document.body, "重新框选").click();
    expect(invokeMock.mock.calls.filter((c) => c[0] === "text_tools_start_ocr")).toHaveLength(2);
  });

  it("未授权点「去系统设置授权」：请求加列表并开设置，给勾选引导，不自动重读", async () => {
    const panel = new TextToolsPanel();
    const s = await startSession(panel);
    panel.onResult(
      payload({ session: s, outcome: { kind: "error", code: "not_trusted" } }),
    );

    buttonByText(document.body, "去系统设置授权").click();
    // 宏任务刷新：requestPermission 的 await 链与随后的 render 完成
    await new Promise((r) => setTimeout(r, 0));

    // 已请求屏幕录制授权（Rust 清陈旧条目 + 让系统把应用加进列表 + 开设置页）
    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("text_tools_request_screen_permission");
    // 绝不自动重读：用户还没勾选，马上重读只会弹同样的错误（像「点了没反应」）
    expect(cmds.filter((c) => c === "text_tools_start_ocr")).toHaveLength(1);
    // 错误下方给出勾选引导（含重启生效提示——屏幕录制授权需重启）
    const hints = [...document.querySelectorAll(".pet-tt-hint")].map((h) => h.textContent ?? "");
    expect(hints.some((t) => t.includes("屏幕录制") && t.includes("重启"))).toBe(true);
    // 按钮变为可重复打开（用户可能误关了设置页）
    expect(buttonByText(document.body, "再开一次系统设置")).toBeTruthy();
  });
});
