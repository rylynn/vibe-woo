// tests/mc-skinlib.test.ts
import { describe, expect, it } from "vitest";
import { skinErrorText } from "../src/mc/skinlib";

describe("skinErrorText 脱敏错误码映射", () => {
  it("八个错误码映射中文文案", () => {
    expect(skinErrorText("too-large")).toBe("文件太大（上限 64KB）");
    expect(skinErrorText("not-png")).toBe("不是有效的 PNG");
    expect(skinErrorText("bad-size")).toBe("尺寸不对（需要 64×64 或 64×32）");
    expect(skinErrorText("limit-reached")).toBe("皮肤库已满（16 张）");
    expect(skinErrorText("write-failed")).toBe("保存失败，请重试");
    expect(skinErrorText("not-found")).toBe("皮肤不存在");
    expect(skinErrorText("bad-id")).toBe("皮肤 id 无效");
    expect(skinErrorText("in-use")).toBe("正在使用中，不能删除");
  });

  it("剥掉 invoke 错误的 JSON 引号；未知码/非字符串给通用文案", () => {
    expect(skinErrorText('"too-large"')).toBe("文件太大（上限 64KB）");
    expect(skinErrorText("whatever")).toBe("操作失败，请重试");
    expect(skinErrorText(new Error("底层细节"))).toBe("操作失败，请重试");
  });
});
