// @vitest-environment happy-dom
// 覆盖取词设置的接线契约：录键 IPC 名称、Esc 优先级、恢复默认、
// 以及保存失败必须让用户看到（不能假装成功）。
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
import { invoke } from "@tauri-apps/api/core";
const invokeMock = vi.mocked(invoke);

import {
  DEFAULT_SHORTCUTS,
  FALLBACK_CONFIG,
  updateConfig,
  updateConfigStrict,
  type ConfigView,
} from "../src/config";
import { SettingsPanel } from "../src/overlay/settings";

const SETTINGS_SRC = readFileSync("src/overlay/settings.ts", "utf8");

const cfg = (): ConfigView => ({ ...FALLBACK_CONFIG });

beforeEach(() => {
  invokeMock.mockReset();
  invokeMock.mockImplementation(async (cmd: string) => {
    if (cmd === "get_config") return cfg();
    return cfg();
  });
  document.body.innerHTML = "";
});

describe("录键 IPC 接线", () => {
  it("使用后端真实的命令名 begin_capture / end_capture", () => {
    // 历史 bug：前端曾调用 begin_shortcut_capture/end_shortcut_capture，
    // 后端注册的是 begin_capture/end_capture —— 改键期间全局键从未被反注册
    expect(SETTINGS_SRC).toContain('invoke("begin_capture")');
    expect(SETTINGS_SRC).toContain('invoke("end_capture")');
    expect(SETTINGS_SRC).not.toContain("begin_shortcut_capture");
    expect(SETTINGS_SRC).not.toContain("end_shortcut_capture");
  });

  it("框选的快捷键纳入自定义列表（原生选区取词已下掉）", () => {
    expect(DEFAULT_SHORTCUTS.shortcut_ocr).toBe("Ctrl+Alt+O");
    expect(Object.keys(DEFAULT_SHORTCUTS)).toHaveLength(4);
  });
});

describe("取词设置默认值", () => {
  it("默认英译中、默认 Google、默认自动翻译", () => {
    expect(FALLBACK_CONFIG.translation_direction).toBe("en2zh");
    expect(FALLBACK_CONFIG.search_engine).toBe("google");
    expect(FALLBACK_CONFIG.auto_translate).toBe(true);
  });
});

describe("保存失败必须可见", () => {
  it("严格保存入口在后端报错时抛错，不返回默认配置", async () => {
    invokeMock.mockRejectedValueOnce(new Error("快捷键注册失败"));
    await expect(updateConfigStrict({ shortcut_ocr: "Alt+X" })).rejects.toThrow(
      "快捷键注册失败",
    );
  });

  it("兼容入口仍回退默认配置（不改动既有调用方行为）", async () => {
    invokeMock.mockRejectedValueOnce(new Error("失败"));
    const out = await updateConfig({ shortcut_ocr: "Alt+X" });
    expect(out.shortcut_ocr).toBe(DEFAULT_SHORTCUTS.shortcut_ocr);
  });
});

describe("改键期间的 Esc 优先级", () => {
  it("Esc 只取消录键，不关闭设置面板", async () => {
    const panel = new SettingsPanel(() => {});
    await panel.show();

    // 进入「自定义快捷键」二级页：入口按钮文案是「配置 ›」，标题在同行 label 上
    const row = [...document.querySelectorAll<HTMLElement>(".pet-settings-row")].find(
      (r) => (r.querySelector("label")?.textContent ?? "").includes("自定义快捷键"),
    );
    expect(row).toBeTruthy();
    row!.querySelector<HTMLButtonElement>("button")!.dispatchEvent(
      new PointerEvent("pointerdown", { bubbles: true }),
    );

    const captureBtn = document.querySelector<HTMLButtonElement>(
      "button.pet-shortcut-btn",
    );
    expect(captureBtn).toBeTruthy();
    captureBtn!.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(invokeMock.mock.calls.map((c) => c[0])).toContain("begin_capture");

    // Esc 应命中 document 捕获阶段的录键处理器
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );

    const cmds = invokeMock.mock.calls.map((c) => c[0]);
    expect(cmds).toContain("end_capture");
    // 关键：面板没有被一起关掉
    expect(panel.isOpen).toBe(true);
  });
});
