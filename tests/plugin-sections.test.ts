// @vitest-environment happy-dom
// 面板分区要造 DOM 节点；其余测试保持 node 环境零开销。
import { describe, expect, it } from "vitest";
import type { CardHost } from "../src/plugins/registry";
import { stockFrontend } from "../src/plugins/cards/stock";
import { newsFrontend } from "../src/plugins/cards/news";

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

  it("未开盘且无数据时只显示状态文案", () => {
    const el = stockFrontend.renderSection!({ ...base, market: "closed" }, host);
    expect(el.textContent).toBe("未开盘");
    expect(el.querySelector(".pet-stock-row")).toBeNull();
  });

  it("未开盘但有收盘数据时展示并标注截至时刻", () => {
    const el = stockFrontend.renderSection!(
      {
        ...base,
        market: "closed",
        quotes: [
          {
            symbol: "sh000001",
            name: "上证指数",
            price: 3200.1,
            change_pct: -0.3,
            date: "2026-09-11",
            time: "09-11 15:00",
            stale: true,
          },
        ],
        as_of: "09-11 15:00",
      },
      host,
    );
    expect(el.textContent).toContain("未开盘 · 数据截至 09-11 15:00");
    expect(el.textContent).toContain("上证指数");
    expect(el.querySelector(".pet-stock-row")).toBeTruthy();
    expect(el.classList.contains("pet-stock-muted")).toBe(true);
  });

  it("周末显示周末休市", () => {
    const el = stockFrontend.renderSection!({ ...base, market: "weekend" }, host);
    expect(el.textContent).toBe("周末休市");
  });

  it("周末休市但有收盘数据时置灰展示", () => {
    const el = stockFrontend.renderSection!(
      {
        ...base,
        market: "weekend",
        quotes: [
          {
            symbol: "sh000001",
            name: "上证指数",
            price: 3200.1,
            change_pct: -0.3,
            date: "2026-09-11",
            time: "09-11 15:00",
            stale: true,
          },
        ],
        as_of: "09-11 15:00",
      },
      host,
    );
    expect(el.textContent).toContain("周末休市 · 数据截至 09-11 15:00");
    expect(el.classList.contains("pet-stock-muted")).toBe(true);
    expect(el.querySelector(".pet-stock-row")).toBeTruthy();
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
    expect(el.querySelector(".pet-stock-status")).toBeNull();
    expect(el.classList.contains("pet-stock-muted")).toBe(false);
  });

  it("停牌行挂小时间标签", () => {
    const el = stockFrontend.renderSection!(
      {
        ...base,
        quotes: [
          { symbol: "sh600519", name: "贵州茅台", price: 1297.5, change_pct: -0.16, date: "2026-09-14", time: "09-14 15:00" },
          { symbol: "sz000625", name: "长安汽车", price: 8.45, change_pct: -2.1, date: "2026-09-10", time: "09-10 10:30", stale: true },
        ],
        as_of: "09-14 15:00",
      },
      host,
    );
    const tags = el.querySelectorAll(".pet-stock-ts");
    // 只有停牌行挂标签
    expect(tags.length).toBe(1);
    expect(tags[0].textContent).toBe("09-10 10:30");
    expect(el.querySelectorAll(".pet-stock-stale").length).toBe(1);
  });

  it("as_of缺失时状态行不显示数据截至", () => {
    const el = stockFrontend.renderSection!(
      {
        ...base,
        market: "weekend",
        quotes: [
          { symbol: "sh000001", name: "上证指数", price: 3200.1, change_pct: -0.3, date: "2026-09-11", stale: true },
        ],
      },
      host,
    );
    expect(el.textContent).toContain("周末休市");
    expect(el.textContent).not.toContain("数据截至");
    expect(el.querySelector(".pet-stock-ts")).toBeNull();
  });

  it("旧版后端没有 market 字段时退回原有文案", () => {
    const el = stockFrontend.renderSection!({ enabled: true, symbols: [], quotes: [], indices: [] }, host);
    expect(el.textContent).toContain("今日还没有行情");
  });
});

describe("资讯面板分区", () => {
  const base = {
    enabled: true,
    categories: ["tech"],
    today_count: 7,
    remaining: 3,
    latest: [],
    updated: 0,
    stale: false,
  };

  it("显示更新时刻", () => {
    // 本地 14:05 对应的 epoch 分钟
    const d = new Date();
    d.setHours(14, 5, 0, 0);
    const el = newsFrontend.renderSection!(
      { ...base, updated: Math.floor(d.getTime() / 60_000) },
      host,
    );
    expect(el.textContent).toContain("今日 7 条");
    expect(el.textContent).toContain("更新于 14:05");
  });

  it("陈旧时追加更新中", () => {
    const d = new Date();
    d.setHours(9, 30, 0, 0);
    const el = newsFrontend.renderSection!(
      { ...base, updated: Math.floor(d.getTime() / 60_000), stale: true },
      host,
    );
    expect(el.textContent).toContain("更新于 09:30");
    expect(el.textContent).toContain("更新中");
  });

  it("从未成功拉过时不显示更新时间", () => {
    const el = newsFrontend.renderSection!({ ...base, updated: 0 }, host);
    expect(el.textContent).not.toContain("更新于");
  });

  it("旧版后端没有 updated 字段时退回原头部", () => {
    const el = newsFrontend.renderSection!(
      { enabled: true, categories: ["tech"], today_count: 7, remaining: 3, latest: [] },
      host,
    );
    expect(el.textContent).toContain("今日 7 条");
    expect(el.textContent).not.toContain("更新于");
  });
});
