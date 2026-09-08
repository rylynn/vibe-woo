import { describe, expect, it } from "vitest";
import { checkPetName, PET_NAME_MAX } from "../src/overlay/friends";

describe("宠物名本地校验", () => {
  it("正常名字通过", () => {
    expect(checkPetName("像素崽")).toEqual({ ok: true, name: "像素崽" });
    expect(checkPetName("阿咪·二号").ok).toBe(true);
    expect(checkPetName("咪咪 - 2").ok).toBe(true);
  });

  it("上限三十字，与服务端一致", () => {
    expect(checkPetName("名".repeat(PET_NAME_MAX)).ok).toBe(true);
    expect(checkPetName("名".repeat(PET_NAME_MAX + 1)).ok).toBe(false);
    // 服务端 PET_NAME_MAX 也是 30 —— 改一处必须改另一处
    expect(PET_NAME_MAX).toBe(30);
  });

  it("挡住注入与脚本", () => {
    // 白名单是防线：注入与 XSS 的常见写法必须进不来
    for (const bad of [
      "'; DROP TABLE users--",
      "<script>alert(1)</script>",
      "<img onerror=alert(1)>",
      '" onmouseover="alert(1)',
      "名; rm -rf /",
      "a`b`c",
    ]) {
      expect(checkPetName(bad).ok, bad).toBe(false);
    }
  });

  it("空与纯空白不通过", () => {
    expect(checkPetName("").ok).toBe(false);
    expect(checkPetName("   ").ok).toBe(false);
  });

  it("首尾空白被去掉", () => {
    expect(checkPetName("  阿咪  ")).toEqual({ ok: true, name: "阿咪" });
  });

  it("控制字符被剥离而不是报错", () => {
    // 与后端 clean 同源：用户从别处粘贴来的不可见字符不该导致改名失败
    const ctrl = String.fromCharCode(7);
    expect(checkPetName(`阿咪${ctrl}`)).toEqual({ ok: true, name: "阿咪" });
  });
});
