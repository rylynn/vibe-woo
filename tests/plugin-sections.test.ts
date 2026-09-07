// @vitest-environment happy-dom
// 面板分区要造 DOM 节点；其余测试保持 node 环境零开销。
import { describe, expect, it } from "vitest";
import type { CardHost } from "../src/plugins/registry";
import { stockFrontend } from "../src/plugins/cards/stock";

/** renderSection 只在点击时才用 openUrl，桩即可。 */
const host: CardHost = { openUrl: () => {}, markTerm: () => {} };

describe("股市面板分区", () => {
  const base = {
    enabled: true,
    symbols: [],
    market: "live" as const,
    quotes: [],
    indices: [],
  };

  it("未开盘时显示未开盘而不是历史数字", () => {
    const el = stockFrontend.renderSection!({ ...base, market: "closed" }, host);
    expect(el.textContent).toBe("未开盘");
    expect(el.querySelector(".pet-stock-row")).toBeNull();
  });

  it("周末显示周末休市", () => {
    const el = stockFrontend.renderSection!({ ...base, market: "weekend" }, host);
    expect(el.textContent).toBe("周末休市");
  });

  it("有当日行情时照常显示数字", () => {
    const el = stockFrontend.renderSection!(
      {
        ...base,
        quotes: [
          { symbol: "sh600519", name: "贵州茅台", price: 1297.5, change_pct: -0.16, date: "2026-09-07" },
        ],
      },
      host,
    );
    expect(el.textContent).toContain("贵州茅台");
    expect(el.querySelector(".pet-stock-row")).toBeTruthy();
  });

  it("旧版后端没有 market 字段时退回原有文案", () => {
    const el = stockFrontend.renderSection!({ enabled: true, symbols: [], quotes: [], indices: [] }, host);
    expect(el.textContent).toContain("今日还没有行情");
  });
});
