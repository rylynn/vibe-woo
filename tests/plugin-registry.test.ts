import { describe, expect, it } from "vitest";
import {
  getPluginFrontend,
  listPluginKinds,
  registerPlugin,
  type PluginFrontend,
} from "../src/plugins/registry";

/** node 环境无 DOM，renderCard 只需是个能返回元素的桩。 */
function makeFe(): PluginFrontend {
  return {
    renderCard: (() => null) as unknown as PluginFrontend["renderCard"],
  };
}

describe("插件渲染器注册表", () => {
  it("注册后可按 kind 取到", () => {
    registerPlugin("word", makeFe());
    expect(getPluginFrontend("word")).toBeDefined();
  });

  it("未注册的 kind 返回 undefined", () => {
    expect(getPluginFrontend("never-registered")).toBeUndefined();
  });

  it("列出全部 kind", () => {
    registerPlugin("news", makeFe());
    registerPlugin("stock", makeFe());
    const kinds = listPluginKinds();
    expect(kinds).toContain("news");
    expect(kinds).toContain("stock");
  });

  it("重复注册以后者覆盖", () => {
    const first = makeFe();
    const second = makeFe();
    registerPlugin("dup-kind", first);
    registerPlugin("dup-kind", second);
    expect(getPluginFrontend("dup-kind")).toBe(second);
  });
});
