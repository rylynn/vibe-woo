import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Box } from "../interact/hit-test";
import { panelChrome } from "./chrome";

interface SocialCfg {
  social_server: string;
  social_uid: string;
  social_nick: string;
  social_pet_name: string;
  social_register_date: string;
  social_invite_code: string;
  social_hidden: boolean;
}

interface FriendRow {
  uid: string;
  nick: string;
  pet_name: string;
  state: string;
  affinity: number;
  online: boolean;
}

/** 今日在线推荐（服务端按日期确定性取样，同一天名单稳定）。 */
interface OnlineRow {
  uid: string;
  nick: string;
  pet_name: string;
  state: string;
}

const STATE_LABEL: Record<string, string> = {
  // 好友侧看不到对方的身份自述（那是本地隐私），只能泛化到「在忙」
  coding: "在忙",
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

/** 宠物名上限，与服务端 PET_NAME_MAX / Rust valid_pet_name 三处一致。 */
export const PET_NAME_MAX = 30;
/** 宠物名白名单：只放行安全字符，注入与脚本写法根本进不来。 */
const PET_NAME_RE = /^[\p{L}\p{N}_\-\s·]+$/u;
/** 招呼冷却（服务端权威 60 秒，这里只做展示，不负责拦）。 */
const GREET_COOLDOWN_MS = 60_000;

export type PetNameCheck =
  | { ok: true; name: string }
  | { ok: false; reason: string };

/**
 * 宠物名本地校验 —— 不合格连请求都不发。
 *
 * 与服务端 `validName`、Rust `valid_pet_name` 是同一套白名单：
 * 不是「过滤掉危险字符」，而是「只放行安全字符」。
 * 控制字符先剥掉（与后端的 clean 一致），不是报错。
 */
export function checkPetName(raw: string): PetNameCheck {
  const name = stripControl(raw).trim();
  if (!name) return { ok: false, reason: "宠物名不能为空" };
  if ([...name].length > PET_NAME_MAX) {
    return { ok: false, reason: `最多 ${PET_NAME_MAX} 字` };
  }
  if (!PET_NAME_RE.test(name)) {
    return { ok: false, reason: "仅支持中英文、数字、空格" };
  }
  return { ok: true, name };
}

/** 剥掉控制字符（与后端 clean 同源）。用码点判断，避免在源码里写不可见字符。 */
function stripControl(s: string): string {
  return Array.from(s)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c > 0x1f && c !== 0x7f && c !== 0x2028 && c !== 0x2029;
    })
    .join('');
}

/**
 * 好友面板：我的宠物 / 今日在线 / 好友。
 *
 * 不再让用户填服务器 —— 地址内置在客户端里，这里只管内容。
 * 登录态以本地缓存的社会配置为准；所有输入先本地校验，不合格不发请求。
 */
export class FriendsPanel {
  private readonly el: HTMLDivElement;
  private open = false;
  private cfg: SocialCfg | null = null;
  private friends: FriendRow[] = [];
  private online: OnlineRow[] = [];
  private onlineLoading = false;
  private onlineError = "";
  /** uid → 冷却结束时间戳。 */
  private readonly coolUntil = new Map<string, number>();
  /** uid → 打招呼按钮（倒计时就地更新，不整块重绘以免抢走输入焦点）。 */
  private readonly greetBtns = new Map<string, HTMLButtonElement>();
  private tick: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.el = document.createElement("div");
    this.el.className = "pet-settings";
    this.el.style.display = "none";
    document.body.appendChild(this.el);
  }

  async show(): Promise<void> {
    this.el.style.display = "block";
    this.open = true;
    void invoke("begin_text_input").catch(() => {});
    this.renderLoading();
    await this.refresh();
    // 推荐名单单独拉：只在打开面板时请求一次，不做轮询
    void this.loadOnline();
  }

  hide(): void {
    if (this.open) void invoke("end_text_input").catch(() => {});
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    this.el.style.display = "none";
    this.open = false;
    this.stopTick();
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

  private async loadOnline(): Promise<void> {
    if (!this.cfg?.social_uid) return;
    // 隐身时不去要推荐名单：自己不想被人看见，就别去翻别人的名单
    if (this.cfg.social_hidden) {
      this.online = [];
      this.onlineLoading = false;
      this.onlineError = "";
      if (this.open) this.render();
      return;
    }
    this.onlineLoading = true;
    this.onlineError = "";
    this.render();
    try {
      this.online = await invoke<OnlineRow[]>("online_random");
    } catch (err) {
      this.onlineError = String(err);
      this.online = [];
    }
    this.onlineLoading = false;
    if (this.open) this.render();
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

  /** 标题栏（panelChrome 统一构建：拖拽 + ×）。 */
  private head(title: string): HTMLElement {
    return panelChrome(this.el, title, () => this.hide());
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

  private divider(text: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "pet-settings-divider";
    d.textContent = text;
    return d;
  }

  private hint(text: string): HTMLElement {
    const h = document.createElement("div");
    h.className = "pet-settings-hint";
    h.textContent = text;
    return h;
  }

  private render(): void {
    this.el.replaceChildren();
    this.el.appendChild(this.head("好友"));

    const cfg = this.cfg;
    if (!cfg || !cfg.social_uid) {
      this.renderNoAccount();
      return;
    }
    this.renderMain(cfg);
  }

  /** 还没开户：启动自检会自动注册，这里只给一个手动重试的入口。 */
  private renderNoAccount(): void {
    const hint = this.hint(
      this.cfg?.social_uid ? "" : "正在为你开户…需要联网，失败会自动重试。",
    );
    hint.style.padding = "14px";
    this.el.appendChild(hint);

    const foot = document.createElement("div");
    foot.style.cssText = "padding:8px 14px 2px";
    const btn = document.createElement("button");
    btn.className = "pet-bubble-confirm";
    btn.textContent = "立即开户";
    btn.addEventListener("pointerdown", async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      try {
        await invoke("auto_register");
        await this.refresh();
        void this.loadOnline();
      } catch (err) {
        hint.textContent = String(err);
        btn.disabled = false;
      }
    });
    foot.appendChild(btn);
    this.el.appendChild(foot);
  }

  private renderMain(cfg: SocialCfg): void {
    this.renderPetName(cfg);
    this.el.appendChild(this.divider("今日在线"));
    this.renderOnline();
    this.el.appendChild(this.divider("好友"));
    this.renderAddFriend();
    this.renderFriendList();
    this.renderFoot();
  }

  // ---------- 第一段：我的宠物 ----------

  private renderPetName(cfg: SocialCfg): void {
    const pet = this.row("宠物名");
    const petInput = this.input(`1-${PET_NAME_MAX} 字`);
    petInput.value = cfg.social_pet_name;
    petInput.maxLength = PET_NAME_MAX;
    const petBtn = document.createElement("button");
    petBtn.className = "pet-bubble-confirm";
    petBtn.textContent = "改名";
    petBtn.style.flex = "0 0 auto";
    const petStatus = document.createElement("span");
    petStatus.style.cssText = "color:#8b93a7;font-size:11px";
    petBtn.addEventListener("pointerdown", async (e) => {
      e.stopPropagation();
      // 本地先过一遍白名单，不合格连请求都不发
      const checked = checkPetName(petInput.value);
      if (!checked.ok) {
        petStatus.style.color = "#ffab9d";
        petStatus.textContent = checked.reason;
        return;
      }
      try {
        const name = await invoke<string>("set_pet_name", { name: checked.name });
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
    this.el.appendChild(this.hint("本地立即生效，联网自动同步给好友"));

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
    nick.title = "好友看到的名字";
    nickRow.appendChild(nick);
    this.el.appendChild(nickRow);
  }

  // ---------- 第二段：今日在线 ----------

  private renderOnline(): void {
    this.greetBtns.clear();
    this.el.appendChild(this.hint("每天换一批 · 打个招呼，宠物就可能去串门"));

    if (this.onlineLoading) {
      this.el.appendChild(this.hint("看看今天有谁在…"));
      return;
    }
    if (this.onlineError) {
      const h = this.hint(this.onlineError);
      h.style.color = "#ffab9d";
      this.el.appendChild(h);
      return;
    }
    if (this.online.length === 0) {
      // 没有在线的人就不展示这个区块，只留一行空态
      this.el.appendChild(this.hint("今天还没有人在线，晚点再来看看"));
      return;
    }
    for (const u of this.online) {
      this.el.appendChild(this.onlineRow(u));
    }
    this.startTick();
  }

  private onlineRow(u: OnlineRow): HTMLElement {
    const row = document.createElement("div");
    row.className = "pet-friend-row";

    const dot = document.createElement("span");
    dot.className = "pet-friend-dot";
    dot.style.background = STATE_COLOR[u.state] ?? "#5a6478";

    const main = document.createElement("span");
    main.className = "pet-friend-nick";
    main.textContent = `${u.nick} 的 ${u.pet_name}`;
    main.title = `uid: ${u.uid}`;

    const state = document.createElement("span");
    state.className = "pet-friend-state";
    state.style.color = STATE_COLOR[u.state] ?? "#5a6478";
    state.textContent = STATE_LABEL[u.state] ?? u.state;

    const btn = document.createElement("button");
    btn.className = "pet-greet-btn";
    btn.textContent = "打招呼";
    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      void this.doGreet(u.uid);
    });
    this.greetBtns.set(u.uid, btn);
    this.applyCooldown(u.uid);

    row.append(dot, main, state, btn);
    return row;
  }

  private async doGreet(uid: string): Promise<void> {
    const btn = this.greetBtns.get(uid);
    if (btn) btn.disabled = true;
    try {
      await invoke("greet", { target: uid });
      this.startGlobalCooldown();
    } catch (err) {
      if (btn) {
        btn.title = String(err);
        btn.textContent = "失败";
      }
      // 服务端限频是「发起方 60 秒内一次」，不是「对同一个人一次」——
      // 打完 A 立刻点 B 也会被拒，所以冷却要落到所有按钮上。
      // 网络错误同样按冷却处理，省得用户一直点一个打不通的按钮。
      this.startGlobalCooldown();
    }
  }

  private startGlobalCooldown(): void {
    const until = Date.now() + GREET_COOLDOWN_MS;
    for (const other of this.greetBtns.keys()) this.coolUntil.set(other, until);
    this.startTick();
    for (const other of this.greetBtns.keys()) this.applyCooldown(other);
  }

  private applyCooldown(uid: string): void {
    const btn = this.greetBtns.get(uid);
    if (!btn) return;
    const left = Math.ceil(((this.coolUntil.get(uid) ?? 0) - Date.now()) / 1000);
    if (left > 0) {
      btn.disabled = true;
      btn.classList.add("is-cooling");
      btn.textContent = `${left}s`;
    } else {
      btn.disabled = false;
      btn.classList.remove("is-cooling");
      btn.textContent = "打招呼";
    }
  }

  private startTick(): void {
    if (this.tick) return;
    this.tick = setInterval(() => {
      if (!this.open) {
        this.stopTick();
        return;
      }
      for (const uid of this.greetBtns.keys()) this.applyCooldown(uid);
    }, 1000);
  }

  private stopTick(): void {
    if (this.tick) clearInterval(this.tick);
    this.tick = null;
  }

  // ---------- 第三段：好友 ----------

  private renderAddFriend(): void {
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
        await this.refresh();
      } catch (err) {
        addStatus.style.color = "#ffab9d";
        addStatus.textContent = String(err);
        addStatus.title = String(err);
      }
    });
    addRow.append(addInput, addBtn, addStatus);
    this.el.appendChild(addRow);
  }

  private renderFriendList(): void {
    if (this.friends.length === 0) {
      const empty = this.hint("还没有好友 —— 把你的 uid 发给朋友吧");
      empty.style.paddingLeft = "14px";
      this.el.appendChild(empty);
      return;
    }
    for (const f of this.friends) {
      this.el.appendChild(this.friendRow(f));
    }
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

  private renderFoot(): void {
    const foot = document.createElement("div");
    foot.style.cssText = "padding:8px 14px 2px";
    const out = document.createElement("button");
    out.className = "pet-bubble-confirm";
    out.textContent = "退出登录";
    out.addEventListener("pointerdown", async (e) => {
      e.stopPropagation();
      await invoke("logout").catch(() => {});
      this.friends = [];
      this.online = [];
      await this.refresh();
    });
    foot.appendChild(out);
    this.el.appendChild(foot);
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

/** 订阅串门/互动/离开/打招呼事件。 */
export async function onSocialEvent(
  cb: (e: {
    event: {
      type: string;
      from_uid?: string;
      from_nick?: string;
      pet_name?: string;
      line?: string;
      pats?: number;
    };
  }) => void,
): Promise<() => void> {
  try {
    return await listen<{
      event: {
        type: string;
        from_uid?: string;
        from_nick?: string;
        pet_name?: string;
        line?: string;
        pats?: number;
      };
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

/** 家里当前的访客（每拍心跳刷新，空列表表示人都走了）。 */
export async function onVisitorsChange(
  cb: (list: { uid: string; nick: string; pet_name: string }[]) => void,
): Promise<() => void> {
  try {
    return await listen<{ uid: string; nick: string; pet_name: string }[]>(
      "pet://visitors",
      (e) => cb(e.payload),
    );
  } catch {
    return () => {};
  }
}
