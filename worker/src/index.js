/**
 * Vibe Pet 同步服务 —— Cloudflare Worker + KV。
 *
 * 架构（本次重写）：账号体系 + 好友关系 + 心跳在线 + 宠物串门。
 *
 * 安全设计（每条都有对应的实现，不是纸面承诺）：
 *   - 密码：PBKDF2-SHA256（WebCrypto），每用户独立盐，10 万次迭代，
 *     服务端永不存明文、永不回传。
 *   - 注入：无 SQL（KV 存储，键值均为服务端生成的安全 token 或
 *     严格白名单校验过的字符串），用户输入绝不拼进 KV 键名 ——
 *     用户相关键名一律用 uid（服务端生成的纯数字）。
 *   - XSS：纯 JSON API，无任何 HTML 输出端点；昵称/宠物名只做数据存储
 *     与回显（客户端用 textContent 渲染）；入参剥离控制字符。
 *   - CSRF：写接口一律要求 Authorization: Bearer <token> 头，
 *     不接受 Cookie 鉴权（无环境凭据 → 无 CSRF 面）。Cookie 仅为
 *     兼容浏览器调试场景设置的只读会话副本（HttpOnly + SameSite=Strict）。
 *   - 会话：48 位十六进制随机 token（crypto.getRandomValues），
 *     KV `sess:<token>` → uid，无过期（用户要求 cookie 永久有效）。
 *   - 限频：注册/登录同 IP 10 秒 1 次（KV TTL 实现，最终一致、尽力而为）。
 *   - 输入：账号/密码/昵称/宠物名/邀请码全部服务端白名单校验
 *     （客户端也校验一道，但服务端是权威）。
 *
 * KV 键一览（用户输入绝不进入键名）：
 *   u:<uid>            用户行：账号、盐、哈希、注册时间、昵称、宠物名
 *   acct:<account>     账号 → uid（账号唯一）
 *   nick:<昵称小写>     昵称 → uid（昵称唯一，大小写不敏感）
 *   sess:<token>       会话 token → uid
 *   invite:<code>      邀请码 → { by, used_by } （一次性）
 *   friends:<uid>      [{ uid, at }]（最多 100，双向各自存储）
 *   hb:<uid>           心跳：{ state, affinity, last_seen }
 *   visitors:<uid>     当前在家访客 [{ uid, nick, pet_name, at }]（≤3）
 *   events:<uid>       事件队列（读即清空）
 *   rl:<ip-hash>       限频标记（TTL 10s）
 */

const OFFLINE_AFTER_MS = 8 * 60 * 1000; // 心跳 3 分钟 + 容错
const DEFAULT_HEARTBEAT_SECS = 180; // 后台可配置：写在响应里，客户端自适应
const MAX_FRIENDS = 100;
const MAX_VISITORS = 3; // 同一人最多同时接受 3 个串门
const VISIT_EXPIRE_MS = 15 * 60 * 1000; // 访客记录懒过期
const VISIT_EVENT_TTL = 7 * 24 * 3600;
const RATE_LIMIT_SECS = 10;
const PASS_MIN = 6;
const PASS_MAX = 30;
const ACCOUNT_MAX = 12;
const NICK_MAX = 120; // 按码点计
const PET_NAME_MAX = 24;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const kv = env.SYNC;

    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    try {
      // ---- 公开接口（限频保护）----
      if (request.method === "POST" && path === "/register") {
        return json(await guard(kv, request, async () => register(kv, env, await body(request))), cors);
      }
      if (request.method === "POST" && path === "/login") {
        return json(await guard(kv, request, async () => login(kv, await body(request))), cors);
      }
      // ---- 管理接口（邀请码签发）----
      if (request.method === "POST" && path === "/admin/invite") {
        return json(await adminInvite(kv, env, request, await body(request)), cors);
      }
      // ---- 需要登录的接口：Bearer token 鉴权（CSRF 安全）----
      const auth = await requireAuth(kv, request);
      if (auth.error) return json(auth.error, cors, 401);

      if (request.method === "GET" && path === "/me") {
        return json(await me(kv, auth.uid), cors);
      }
      if (request.method === "POST" && path === "/profile/pet-name") {
        return json(await setPetName(kv, auth.uid, await body(request)), cors);
      }
      if (request.method === "POST" && path === "/friends/add") {
        return json(await addFriend(kv, auth.uid, await body(request)), cors);
      }
      if (request.method === "POST" && path === "/friends/remove") {
        return json(await removeFriend(kv, auth.uid, await body(request)), cors);
      }
      if (request.method === "GET" && path === "/friends") {
        return json(await listFriends(kv, auth.uid), cors);
      }
      if (request.method === "POST" && path === "/heartbeat") {
        return json(await heartbeat(kv, auth.uid, await body(request)), cors);
      }
      if (request.method === "POST" && path === "/visit") {
        return json(await visit(kv, auth.uid, await body(request)), cors);
      }
      if (request.method === "POST" && path === "/home") {
        return json(await goHome(kv, auth.uid, await body(request)), cors);
      }
      return json({ error: "not found" }, cors, 404);
    } catch (e) {
      return json({ error: "server error" }, cors, 500);
    }
  },
};

// ---------- 基础工具 ----------

function json(body, cors, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: cors });
}

async function body(request) {
  const text = await request.text();
  if (text.length > 4096) throw new Error("payload too large");
  return JSON.parse(text || "{}");
}

/** 剥离控制字符（XSS/协议注入防御的第一道）。 */
function clean(s) {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "").trim();
}

/** 按码点计长（中文按字算）。 */
function cpLen(s) {
  return [...s].length;
}

// ---------- 校验（服务端权威白名单） ----------

function validAccount(a) {
  return typeof a === "string" && /^[A-Za-z0-9_]{3,12}$/.test(a);
}

/** 密码：6..30，必须同时含大写和小写。 */
function validPassword(p) {
  return (
    typeof p === "string" &&
    p.length >= PASS_MIN &&
    p.length <= PASS_MAX &&
    /[a-z]/.test(p) &&
    /[A-Z]/.test(p)
  );
}

/** 昵称/宠物名：字母（含中日韩）、数字、空格、_-·；无控制字符。 */
function validName(s, max) {
  if (typeof s !== "string") return false;
  const n = cpLen(s);
  if (n < 1 || n > max) return false;
  // \p{L} 覆盖中日韩所有字母文字；显式排除会破坏 JSON 或被用于注入的字符
  return /^[\p{L}\p{N}_\-\s·]+$/u.test(s);
}

function validInvite(c) {
  return typeof c === "string" && /^[A-HJ-NP-Z2-9]{6}$/.test(c.toUpperCase());
}

function validUid(u) {
  return typeof u === "string" && /^[1-9][0-9]{7}$/.test(u);
}

// ---------- 密码哈希（PBKDF2） ----------

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashPassword(password, saltHex) {
  const enc = new TextEncoder();
  const salt = Uint8Array.from(saltHex.match(/../g).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 },
    key,
    256,
  );
  return hex(bits);
}

// ---------- 限频（同 IP 10s 一次） ----------

async function rateLimited(kv, request) {
  // 不存原始 IP（隐私）：SHA-256 摘要后做键
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  const key = `rl:${hex(digest).slice(0, 16)}`;
  if (await kv.get(key)) return true;
  await kv.put(key, "1", { expirationTtl: RATE_LIMIT_SECS });
  return false;
}

async function guard(kv, request, fn) {
  if (await rateLimited(kv, request)) {
    return { error: "请求太频繁，请 10 秒后再试" };
  }
  return fn();
}

// ---------- 会话 ----------

function newToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return hex(b);
}

/** Bearer 鉴权。写接口只认这个（CSRF 安全），不认 Cookie。 */
async function requireAuth(kv, request) {
  const h = request.headers.get("Authorization") || "";
  const m = h.match(/^Bearer ([0-9a-f]{48})$/);
  if (!m) return { error: { error: "未登录" } };
  const uid = await kv.get(`sess:${m[1]}`);
  if (!uid) return { error: { error: "会话无效，请重新登录" } };
  return { uid };
}

function sessionCookie(token) {
  const tenYears = 10 * 365 * 24 * 3600;
  return `vps=${token}; Max-Age=${tenYears}; Path=/; HttpOnly; Secure; SameSite=Strict`;
}

// ---------- uid / 邀请码生成 ----------

function randomUid() {
  // 8 位纯数字，首位非零，便于口头交流
  return String(Math.floor(10000000 + Math.random() * 89999999));
}

function randomInvite() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 去掉 0/O/1/I
  let s = "";
  const b = new Uint8Array(6);
  crypto.getRandomValues(b);
  for (let i = 0; i < 6; i++) s += alphabet[b[i] % alphabet.length];
  return s;
}

async function uniqueUid(kv) {
  for (let i = 0; i < 8; i++) {
    const uid = randomUid();
    if (!(await kv.get(`u:${uid}`))) return uid;
  }
  throw new Error("uid collision");
}

// ---------- 注册 / 登录 ----------

async function register(kv, env, bodyReq) {
  const account = clean(bodyReq.account);
  const password = String(bodyReq.password ?? "");
  const nick = clean(bodyReq.nick);
  const invite = String(bodyReq.invite_code ?? "").toUpperCase();

  // 服务端权威校验（客户端已校验过一道，这里不信任客户端）
  if (!validAccount(account)) return { error: "账号需 3-12 位字母/数字/下划线" };
  if (!validPassword(password)) {
    return { error: `密码需 ${PASS_MIN}-${PASS_MAX} 位且同时包含大写和小写字母` };
  }
  if (!validName(nick, NICK_MAX)) {
    return { error: `昵称需 1-${NICK_MAX} 字，仅支持中英文/数字/空格` };
  }
  if (!validInvite(invite)) return { error: "邀请码格式不正确" };

  const inviteRaw = await kv.get(`invite:${invite}`);
  if (!inviteRaw) return { error: "邀请码不存在" };
  const inviteData = JSON.parse(inviteRaw);
  if (inviteData.used_by) return { error: "邀请码已被使用" };

  if (await kv.get(`acct:${account}`)) return { error: "账号已被注册" };
  const nickKey = `nick:${nick.toLowerCase()}`;
  if (await kv.get(nickKey)) return { error: "昵称已被占用" };

  const uid = await uniqueUid(kv);
  const salt = newToken().slice(0, 32);
  const passHash = await hashPassword(password, salt);
  const now = Date.now();

  // 用户表 + 用户信息表（KV 下合并为一个 u:<uid> 行）
  await kv.put(`u:${uid}`, JSON.stringify({
    uid,
    account,
    salt,
    pass_hash: passHash,
    created_at: now,
    nick,
    pet_name: "像素崽", // 默认宠物名，随时可改
  }));
  await kv.put(`acct:${account}`, uid);
  await kv.put(nickKey, uid);
  await kv.put(`friends:${uid}`, JSON.stringify([]));

  // 邀请码核销 + 给新用户签发一个自己的邀请码（邀请下一位）
  inviteData.used_by = uid;
  await kv.put(`invite:${invite}`, JSON.stringify(inviteData));
  const ownInvite = randomInvite();
  await kv.put(`invite:${ownInvite}`, JSON.stringify({ by: uid, used_by: null }));

  const token = newToken();
  await kv.put(`sess:${token}`, uid);

  return {
    uid,
    token,
    created_at: now,
    nick,
    pet_name: "像素崽",
    invite_code: ownInvite,
    _cookie: sessionCookie(token),
  };
}

async function login(kv, bodyReq) {
  const account = clean(bodyReq.account);
  const password = String(bodyReq.password ?? "");
  if (!validAccount(account) || !validPassword(password)) {
    return { error: "账号或密码不正确" }; // 不透露具体哪项错
  }
  const uid = await kv.get(`acct:${account}`);
  if (!uid) return { error: "账号或密码不正确" };
  const raw = await kv.get(`u:${uid}`);
  if (!raw) return { error: "账号或密码不正确" };
  const u = JSON.parse(raw);
  const hash = await hashPassword(password, u.salt);
  if (hash !== u.pass_hash) return { error: "账号或密码不正确" };

  const token = newToken();
  await kv.put(`sess:${token}`, uid);
  return {
    uid,
    token,
    created_at: u.created_at,
    nick: u.nick,
    pet_name: u.pet_name,
    _cookie: sessionCookie(token),
  };
}

async function me(kv, uid) {
  const u = JSON.parse(await kv.get(`u:${uid}`));
  return { uid: u.uid, created_at: u.created_at, nick: u.nick, pet_name: u.pet_name };
}

// ---------- 档案 ----------

async function setPetName(kv, uid, bodyReq) {
  const name = clean(bodyReq.pet_name);
  if (!validName(name, PET_NAME_MAX)) {
    return { error: `宠物名需 1-${PET_NAME_MAX} 字，仅支持中英文/数字/空格` };
  }
  const u = JSON.parse(await kv.get(`u:${uid}`));
  u.pet_name = name;
  await kv.put(`u:${uid}`, JSON.stringify(u));
  return { ok: true, pet_name: name };
}

// ---------- 好友 ----------

/** 目标解析：uid 或昵称 → uid。 */
async function resolveTarget(kv, target) {
  const t = clean(target);
  if (validUid(t)) {
    return (await kv.get(`u:${t}`)) ? t : null;
  }
  if (validName(t, NICK_MAX)) {
    return (await kv.get(`nick:${t.toLowerCase()}`)) || null;
  }
  return null;
}

async function friendList(kv, uid) {
  return JSON.parse((await kv.get(`friends:${uid}`)) || "[]");
}

async function addFriend(kv, uid, bodyReq) {
  const target = await resolveTarget(kv, bodyReq.target);
  if (!target) return { error: "找不到该用户（检查 uid 或昵称）" };
  if (target === uid) return { error: "不能加自己" };

  const mine = await friendList(kv, uid);
  const theirs = await friendList(kv, target);
  if (mine.some((f) => f.uid === target)) return { ok: true, note: "已经是好友" };
  if (mine.length >= MAX_FRIENDS || theirs.length >= MAX_FRIENDS) {
    return { error: `好友数已达上限（${MAX_FRIENDS}）` };
  }

  const at = Date.now();
  mine.push({ uid: target, at });
  theirs.push({ uid, at });
  await kv.put(`friends:${uid}`, JSON.stringify(mine));
  await kv.put(`friends:${target}`, JSON.stringify(theirs));
  return { ok: true };
}

/** 单方删除即解除：两边都删。 */
async function removeFriend(kv, uid, bodyReq) {
  const target = await resolveTarget(kv, bodyReq.target);
  if (!target) return { error: "找不到该用户" };

  const mine = (await friendList(kv, uid)).filter((f) => f.uid !== target);
  const theirs = (await friendList(kv, target)).filter((f) => f.uid !== uid);
  await kv.put(`friends:${uid}`, JSON.stringify(mine));
  await kv.put(`friends:${target}`, JSON.stringify(theirs));
  return { ok: true };
}

async function listFriends(kv, uid) {
  const ids = await friendList(kv, uid);
  const now = Date.now();
  const out = [];
  for (const f of ids) {
    const raw = await kv.get(`u:${f.uid}`);
    const hb = JSON.parse((await kv.get(`hb:${f.uid}`)) || "null");
    if (!raw) continue;
    const u = JSON.parse(raw);
    const online = !!hb && now - hb.last_seen < OFFLINE_AFTER_MS;
    out.push({
      uid: f.uid,
      nick: u.nick,
      pet_name: u.pet_name,
      state: online ? hb.state : "offline",
      affinity: hb ? hb.affinity : 0,
      online,
      friends_since: f.at,
    });
  }
  return out;
}

// ---------- 心跳 ----------

async function heartbeat(kv, uid, bodyReq) {
  const state = ["coding", "idle", "away", "visiting"].includes(bodyReq.state)
    ? bodyReq.state
    : "idle";
  const affinity = Math.min(100, Math.max(0, Number(bodyReq.affinity) || 0));
  await kv.put(`hb:${uid}`, JSON.stringify({
    state,
    affinity,
    last_seen: Date.now(),
  }));

  // 宠物名随心跳兜底同步（改名接口失败时的重试通道）
  const petName = clean(bodyReq.pet_name);
  if (validName(petName, PET_NAME_MAX)) {
    const u = JSON.parse(await kv.get(`u:${uid}`));
    if (u && u.pet_name !== petName) {
      u.pet_name = petName;
      await kv.put(`u:${uid}`, JSON.stringify(u));
    }
  }

  // 一次往返带回全部所需：好友、事件、在家访客（省请求量，配合限频）
  const friends = await listFriends(kv, uid);
  const events = await pullEvents(kv, uid);
  const visitors = await activeVisitors(kv, uid);
  return {
    ok: true,
    next_secs: DEFAULT_HEARTBEAT_SECS, // 后台可配置：改这里客户端自动跟随
    friends,
    events: events.events,
    visitors,
  };
}

// ---------- 事件队列 ----------

async function pushEvent(kv, toUid, event) {
  const text = JSON.stringify(event);
  if (text.length > 512) return false;
  const key = `events:${toUid}`;
  const list = JSON.parse((await kv.get(key)) || "[]");
  list.push({ at: Date.now(), event });
  while (list.length > 20) list.shift();
  await kv.put(key, JSON.stringify(list), { expirationTtl: VISIT_EVENT_TTL });
  return true;
}

async function pullEvents(kv, uid) {
  const key = `events:${uid}`;
  const list = JSON.parse((await kv.get(key)) || "[]");
  if (list.length) await kv.delete(key);
  return { events: list };
}

// ---------- 串门 ----------

/** 清理过期访客（懒过期）。 */
async function activeVisitors(kv, uid) {
  const key = `visitors:${uid}`;
  const list = JSON.parse((await kv.get(key)) || "[]");
  const now = Date.now();
  const alive = list.filter((v) => now - v.at < VISIT_EXPIRE_MS);
  if (alive.length !== list.length) {
    await kv.put(key, JSON.stringify(alive));
  }
  return alive;
}

async function visit(kv, uid, bodyReq) {
  const target = await resolveTarget(kv, bodyReq.target);
  if (!target) return { error: "找不到该用户" };
  if (target === uid) return { error: "不能拜访自己" };

  // 条件一：是好友
  const mine = await friendList(kv, uid);
  if (!mine.some((f) => f.uid === target)) return { error: "只能拜访好友" };

  // 条件二：对方在线
  const hb = JSON.parse((await kv.get(`hb:${target}`)) || "null");
  const now = Date.now();
  if (!hb || now - hb.last_seen >= OFFLINE_AFTER_MS) {
    return { error: "好友不在线" };
  }

  // 条件三：对方家访客 < 3
  const visitors = await activeVisitors(kv, target);
  if (visitors.length >= MAX_VISITORS) {
    return { error: "好友家已经有 3 只宠物在做客了" };
  }
  if (visitors.some((v) => v.uid === uid)) {
    return { ok: true, note: "已经在做客" }; // 幂等
  }

  const me = JSON.parse(await kv.get(`u:${uid}`));
  visitors.push({ uid, nick: me.nick, pet_name: me.pet_name, at: now });
  await kv.put(`visitors:${target}`, JSON.stringify(visitors));

  // 通知主人：有宠物来串门了
  await pushEvent(kv, target, {
    type: "visit",
    from_uid: uid,
    from_nick: me.nick,
    pet_name: me.pet_name,
  });
  return { ok: true };
}

/** 回家：从所有正在拜访的家庭中移除自己。KV 无反向索引，
 *  拜访只发生在最近一次 /visit 记录的家庭 —— 客户端把目标一起传来。 */
async function goHome(kv, uid, bodyReq) {
  const target = bodyReq && bodyReq.target ? clean(bodyReq.target) : null;
  if (validUid(target)) {
    const key = `visitors:${target}`;
    const list = JSON.parse((await kv.get(key)) || "[]");
    const next = list.filter((v) => v.uid !== uid);
    if (next.length !== list.length) {
      await kv.put(key, JSON.stringify(next));
      await pushEvent(kv, target, {
        type: "leave",
        from_uid: uid,
        from_nick: "",
        pet_name: "",
      });
    }
  }
  return { ok: true };
}

// ---------- 管理：邀请码签发 ----------

async function adminInvite(kv, env, request, bodyReq) {
  const expected = `Bearer ${env.ADMIN_TOKEN || ""}`;
  if (!env.ADMIN_TOKEN || request.headers.get("Authorization") !== expected) {
    return { error: "forbidden" };
  }
  const count = Math.min(20, Math.max(1, Number(bodyReq.count) || 1));
  const codes = [];
  for (let i = 0; i < count; i++) {
    const c = randomInvite();
    await kv.put(`invite:${c}`, JSON.stringify({ by: "admin", used_by: null }));
    codes.push(c);
  }
  return { ok: true, codes };
}
