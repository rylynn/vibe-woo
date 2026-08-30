import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Box } from "../interact/hit-test";
import { enablePanelDrag } from "./panel-drag";

interface SocialCfg {
  social_server: string;
  social_uid: string;
  social_nick: string;
  social_pet_name: string;
  social_register_date: string;
  social_invite_code: string;
}

interface FriendRow {
  uid: string;
  nick: string;
  pet_name: string;
  state: string;
  affinity: number;
  online: boolean;
}

const STATE_LABEL: Record<string, string> = {
  coding: "在写代码",
  idle: "闲着",
  away: "离开了",
  visiting: "外出串门",
  offline: "离线",
};

const STATE_COLOR: Record<string, string> = {
  coding: "#7cf5c4",
  idle: "#a8b0c2",
  away: "#8b93a7",
  visiting: "#a8c0ff",
  offline: "#5a6478",
};

/**
 * 好友面板：登录/注册 + 好友管理。
 *
 * 登录态以本地缓存的社会配置为准（uid/token 已存配置，token 永久有效）。
 * 所有输入先本地校验（与服务端同一套规则），不合格不发请求。
 */
export class FriendsPanel {
  private readonly el: HTMLDivElement;
  private open = false;
  private cfg: SocialCfg | null = null;
  private friends: FriendRow[] = [];
  /** 注册/登录视图切换 */
  private mode: "login" | "register" = "login";

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pet-settings";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
    enablePanelDrag(this.el, ".pet-settings-head");
  }

  async show(): Promise<void> {
    this.el.style.display = "block";
    this.open = true;
    void invoke("begin_text_input").catch(() => {});
    this.renderLoading();
    await this.refresh();
  }

  hide(): void {
    if (this.open) void invoke("end_text_input").catch(() => {});
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    this.el.style.display = "none";
    this.open = false;
  }

  get isOpen(): boolean {
    return this.open;
  }

  get box(): Box | null {
    if (!this.open) return null;
    const r = this.el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  }

  contains(px: number, py: number): boolean {
    const b = this.box;
    if (!b) return false;
    return px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h;
  }

  private async refresh(): Promise<void> {
    try {
      this.cfg = await invoke<SocialCfg>("get_config");
    } catch {
      this.cfg = null;
    }
    this.render();
  }

  private renderLoading(): void {
    this.el.replaceChildren();
    this.el.appendChild(this.head("好友"));
    const l = document.createElement("div");
    l.className = "pet-settings-hint";
    l.style.padding = "14px";
    l.textContent = "载入中";
    this.el.appendChild(l);
  }

  private head(title: string): HTMLElement {
    const h = document.createElement("div");
    h.className = "pet-settings-head";
    const t = document.createElement("span");
    t.textContent = title;
    const close = document.createElement("button");
    close.className = "pet-settings-close";
    close.textContent = "×";
    close.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.hide();
    });
    h.append(t, close);
    return h;
  }

  private row(label: string): HTMLDivElement {
    const r = document.createElement("div");
    r.className = "pet-settings-row";
    const l = document.createElement("label");
    l.textContent = label;
    r.appendChild(l);
    return r;
  }

  private input(placeholder: string, type = "text"): HTMLInputElement {
    const i = document.createElement("input");
    i.type = type;
    i.placeholder = placeholder;
    i.spellcheck = false;
    i.addEventListener("keydown", (e) => e.stopPropagation());
    return i;
  }

  private render(): void {
    this.el.replaceChildren();
    this.el.appendChild(this.head("好友"));

    const cfg = this.cfg;
    // 未配置服务器 → 引导
    if (!cfg || !cfg.social_server) {
      this.renderNoServer();
      return;
    }
    // 已登录（uid 非空）→ 主界面
    if (cfg.social_uid) {
      this.renderMain(cfg);
    } else {
      this.renderAuth(cfg);
    }
  }

  /** 未配置服务器。 */
  private renderNoServer(): void {
    const r = this.row("服务器");
    const input = this.input("https://your-worker.workers.dev");
    input.value = this.cfg?.social_server ?? "";
    input.addEventListener("change", () => {
      void invoke("update_config", {
        patch: { social_server: input.value.trim() },
      }).then(() => this.refresh());
    });
    r.appendChild(input);
    this.el.appendChild(r);
    const hint = document.createElement("div");
    hint.className = "pet-settings-hint";
    hint.textContent = "填好服务器后即可登录（需邀请码注册）";
    this.el.appendChild(hint);
  }

  // ---------- 登录 / 注册 ----------

  private renderAuth(_cfg: SocialCfg): void {
    const isRegister = this.mode === "register";

    const acct = this.row("账号");
    const acctInput = this.input("3-12 位字母/数字/下划线");
    acct.appendChild(acctInput);
    this.el.appendChild(acct);

    const pass = this.row("密码");
    const passInput = this.input("6-30 位，含大小写", "password");
    pass.appendChild(passInput);
    this.el.appendChild(pass);

    if (isRegister) {
      const nick = this.row("昵称");
      const nickInput = this.input("好友看到的名字，全局唯一");
      nick.appendChild(nickInput);
      this.el.appendChild(nick);

      const inv = this.row("邀请码");
      const invInput = this.input("6 位邀请码");
      inv.appendChild(invInput);
      this.el.appendChild(inv);
    }

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "display:flex;gap:8px;align-items:center;padding:10px 14px";
    const btn = document.createElement("button");
    btn.className = "pet-bubble-confirm";
    btn.textContent = isRegister ? "注册" : "登录";
    const status = document.createElement("span");
    status.style.cssText = "color:#8b93a7;font-size:11px;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    status.title = "";
    btn.addEventListener("pointerdown", async (e) => {
      e.stopPropagation();
      status.style.color = "#8b93a7";
      status.textContent = "请求中";
      try {
        if (isRegister) {
          await invoke("register", {
            account: acctInput.value.trim(),
            password: passInput.value,
            nick: nickInputOf(this.el).value,
            inviteCode: invInputOf(this.el).value,
          });
          status.textContent = "注册成功";
        } else {
          await invoke("login", {
            account: acctInput.value.trim(),
            password: passInput.value,
          });
          status.textContent = "登录成功";
        }
        await this.refresh();
      } catch (err) {
        status.style.color = "#ffab9d";
        status.textContent = String(err);
        status.title = String(err);
      }
    });
    btnRow.append(btn, status);
    this.el.appendChild(btnRow);

    const toggle = document.createElement("div");
    toggle.className = "pet-settings-hint";
    toggle.textContent = isRegister ? "已有账号？点此登录" : "没有账号？用邀请码注册";
    toggle.style.cursor = "pointer";
    toggle.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.mode = isRegister ? "login" : "register";
      this.render();
    });
    this.el.appendChild(toggle);

    function nickInputOf(root: HTMLElement): HTMLInputElement {
      return root.querySelectorAll("input")[2] as HTMLInputElement;
    }
    function invInputOf(root: HTMLElement): HTMLInputElement {
      return root.querySelectorAll("input")[3] as HTMLInputElement;
    }
  }

  // ---------- 已登录主界面 ----------

  private renderMain(cfg: SocialCfg): void {
    // 我的档案：uid / 昵称 / 宠物名
    const me = this.row("我的 uid");
    const uid = document.createElement("span");
    uid.textContent = cfg.social_uid;
    uid.style.cssText = "color:#7cf5c4;letter-spacing:1px;font-weight:600;flex:1";
    uid.title = "好友可通过此 uid 添加你";
    me.appendChild(uid);
    this.el.appendChild(me);

    const nickRow = this.row("昵称");
    const nick = document.createElement("span");
    nick.textContent = cfg.social_nick;
    nick.title = "昵称全局唯一，注册后不可改";
    nickRow.appendChild(nick);
    this.el.appendChild(nickRow);

    // 宠物名：随时可改，本地立即生效 + 异步同步
    const pet = this.row("宠物名");
    const petInput = this.input("1-24 字");
    petInput.value = cfg.social_pet_name;
    const petBtn = document.createElement("button");
    petBtn.className = "pet-bubble-confirm";
    petBtn.textContent = "改名";
    petBtn.style.flex = "0 0 auto";
    const petStatus = document.createElement("span");
    petStatus.style.cssText = "color:#8b93a7;font-size:11px";
    petBtn.addEventListener("pointerdown", async (e) => {
      e.stopPropagation();
      try {
        const name = await invoke<string>("set_pet_name", {
          name: petInput.value,
        });
        petStatus.style.color = "#7cf5c4";
        petStatus.textContent = `已改名「${name}」`;
        await this.refresh();
      } catch (err) {
        petStatus.style.color = "#ffab9d";
        petStatus.textContent = String(err);
        petStatus.title = String(err);
      }
    });
    pet.append(petInput, petBtn);
    this.el.appendChild(pet);
    const petHint = document.createElement("div");
    petHint.className = "pet-settings-hint";
    petHint.textContent = "本地立即生效，联网自动同步给好友";
    this.el.appendChild(petHint);

    // 加好友：uid 或昵称
    const divider = document.createElement("div");
    divider.className = "pet-settings-divider";
    divider.textContent = "好友";
    this.el.appendChild(divider);

    const addRow = this.row("加好友");
    const addInput = this.input("uid 或昵称");
    const addBtn = document.createElement("button");
    addBtn.className = "pet-bubble-confirm";
    addBtn.textContent = "添加";
    addBtn.style.flex = "0 0 auto";
    const addStatus = document.createElement("span");
    addStatus.style.cssText =
      "color:#8b93a7;font-size:11px;margin-left:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    addStatus.title = "";
    addBtn.addEventListener("pointerdown", async (e) => {
      e.stopPropagation();
      const t = addInput.value.trim();
      if (!t) return;
      addStatus.textContent = "";
      try {
        const note = await invoke<string>("add_friend", { target: t });
        addStatus.style.color = "#7cf5c4";
        addStatus.textContent = note;
        addInput.value = "";
        // 好友列表由下一次心跳刷新，这里立即拉一次
        await this.refresh();
      } catch (err) {
        addStatus.style.color = "#ffab9d";
        addStatus.textContent = String(err);
        addStatus.title = String(err);
      }
    });
    addRow.append(addInput, addBtn, addStatus);
    this.el.appendChild(addRow);

    // 好友列表（含删除）
    if (this.friends.length === 0) {
      const empty = document.createElement("div");
      empty.className = "pet-settings-hint";
      empty.style.paddingLeft = "14px";
      empty.textContent = "还没有好友 —— 把你的 uid 发给朋友吧";
      this.el.appendChild(empty);
    } else {
      for (const f of this.friends) {
        this.el.appendChild(this.friendRow(f));
      }
    }

    // 退出登录
    const foot = document.createElement("div");
    foot.style.cssText = "padding:8px 14px 2px";
    const out = document.createElement("button");
    out.className = "pet-bubble-confirm";
    out.textContent = "退出登录";
    out.addEventListener("pointerdown", async (e) => {
      e.stopPropagation();
      await invoke("logout").catch(() => {});
      this.friends = [];
      await this.refresh();
    });
    foot.appendChild(out);
    this.el.appendChild(foot);
  }

  private friendRow(f: FriendRow): HTMLElement {
    const row = document.createElement("div");
    row.className = "pet-friend-row";

    const dot = document.createElement("span");
    dot.className = "pet-friend-dot";
    dot.style.background = STATE_COLOR[f.state] ?? "#5a6478";

    const main = document.createElement("span");
    main.className = "pet-friend-nick";
    main.textContent = `${f.nick} 的 ${f.pet_name}`;
    main.title = `uid: ${f.uid}`; // hover 展示 uid

    const state = document.createElement("span");
    state.className = "pet-friend-state";
    state.style.color = STATE_COLOR[f.state] ?? "#5a6478";
    state.textContent = STATE_LABEL[f.state] ?? f.state;

    const aff = document.createElement("span");
    aff.className = "pet-friend-aff";
    aff.textContent = `♥ ${Math.round(f.affinity)}`;

    const del = document.createElement("button");
    del.className = "pet-reminder-del";
    del.textContent = "删";
    del.title = "删除好友（双方解除）";
    del.addEventListener("pointerdown", async (e) => {
      e.stopPropagation();
      try {
        await invoke("remove_friend", { target: f.uid });
        this.friends = this.friends.filter((x) => x.uid !== f.uid);
        this.render();
      } catch (err) {
        del.title = String(err);
      }
    });

    row.append(dot, main, state, aff, del);
    return row;
  }

  /** 更新好友列表（事件驱动）。 */
  setFriends(list: FriendRow[]): void {
    this.friends = list;
    if (this.open && this.cfg?.social_uid) {
      this.render();
    }
  }
}

/** 订阅好友列表刷新。 */
export async function onFriendsUpdate(
  cb: (list: FriendRow[]) => void,
): Promise<() => void> {
  try {
    return await listen<FriendRow[]>("pet://friends", (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}

/** 订阅串门/互动/离开事件。 */
export async function onSocialEvent(
  cb: (e: {
    event: { type: string; from_nick?: string; pats?: number };
  }) => void,
): Promise<() => void> {
  try {
    return await listen<{
      event: { type: string; from_nick?: string; pats?: number };
    }>("pet://social", (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}

/** 订阅宠物离家/回家事件。 */
export async function onAwayChange(
  cb: (n: { away: boolean; at_nick?: string }) => void,
): Promise<() => void> {
  try {
    return await listen<{ away: boolean; at_nick?: string }>(
      "pet://home-away",
      (e) => cb(e.payload),
    );
  } catch {
    return () => {};
  }
}
