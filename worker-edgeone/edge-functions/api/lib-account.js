/**
 * 账号体系同步服务核心逻辑 —— 与运行时无关。
 *
 * 蓝本：worker/src/index.js（Cloudflare Worker 账号版），按 EdgeOne 约束适配：
 *   - KV key 仅允许字母/数字/下划线 → 分隔符一律用 _（Cloudflare 版的 : 会被拒）
 *   - 中文昵称不能直接做 key → nick 索引键用昵称小写文的 SHA-256 hex
 *   - store 只有 get/put/delete，无 TTL → 限频/会话过期改为存时间戳自行判断
 *
 * 被两处复用：
 *   - edge-functions/api/[[default]].js（EdgeOne 边缘函数，SYNC_KV 绑定）
 *   - local-dev.js（本机测试服务，文件存储；env 用 process.env 提供 ADMIN_*）
 *
 * KV 键一览（用户输入绝不进入键名）：
 *   u_<uid>            用户行：账号、盐、哈希、注册时间、昵称、宠物名
 *   acct_<account>     账号 → uid（账号唯一）
 *   nick_<sha256hex>   昵称小写文的摘要 → uid（昵称唯一，大小写不敏感）
 *   sess_<token>       用户会话：{ uid, at }（90 天滚动续期，时间戳判断）
 *   sess_admin_<token> 管理员会话：{ at }（24h 过期，时间戳判断）
 *   invite_<code>      邀请码 → { by, used_by }（一次性）
 *   friends_<uid>      [{ uid, at }]（最多 100，双向各自存储）
 *   hb_<uid>           心跳：{ state, affinity, last_seen }
 *   visitors_<uid>     当前在家访客 [{ uid, nick, pet_name, at }]（≤3）
 *   events_<uid>       事件队列（读即清空，上限 20 条；无 TTL，靠长度限制）
 *   rl_<iphash>        限频标记 { at }（10 秒，时间戳判断）
 *   users_idx          全部 uid 的 JSON 数组（注册追加 + 心跳懒补录）
 *   usage_<uid>        个人按日用量 { days: { "YYYY-MM-DD": {...} }, last: {...} }（保留 30 天）
 *   stats_<yyyymmdd>   全站当日用量 { reminders, notes, pomodoros, online_mins, active: [uid] }（索引保留 90 天）
 *   stats_idx          已有 stats_<date> 的日期数组（保留 90 天）
 */

const OFFLINE_AFTER_MS = 8 * 60 * 1000; // 心跳 3 分钟 + 容错
const DEFAULT_HEARTBEAT_SECS = 180;
const MAX_FRIENDS = 100;
const MAX_VISITORS = 3;
const VISIT_EXPIRE_MS = 15 * 60 * 1000;
const RATE_LIMIT_MS = 10 * 1000;
const ADMIN_SESSION_MS = 24 * 3600 * 1000;
/** 用户会话寿命：最后一次使用后 90 天。滚动续期，不是固定到期日。 */
const USER_SESSION_MS = 90 * 24 * 3600 * 1000;
/** 续期回写间隔：距上次刷新超过 1 天才回写，避免每次请求都写 KV。 */
const SESSION_RENEW_MS = 24 * 3600 * 1000;
const USAGE_KEEP_DAYS = 30;
const STATS_KEEP_DAYS = 90;
const PASS_MIN = 6;
const PASS_MAX = 30;
const NICK_MAX = 120; // 按码点计
const PET_NAME_MAX = 24;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
};

// ---------- 基础工具 ----------

function clean(s) {
  return String(s ?? "").replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, "").trim();
}

function cpLen(s) {
  return [...s].length;
}

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function newToken() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return hex(b);
}

/** 昵称索引键：中文不能直接做 KV key，用小写文的 SHA-256 摘要。 */
async function nickKey(nick) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(nick.toLowerCase()),
  );
  return `nick_${digest}`.slice(0, 80); // 摘要 64 hex，远低于键长限制
}

// ---------- 校验（服务端权威白名单） ----------

function validAccount(a) {
  return typeof a === "string" && /^[A-Za-z0-9_]{3,12}$/.test(a);
}

function validPassword(p) {
  return (
    typeof p === "string" &&
    p.length >= PASS_MIN &&
    p.length <= PASS_MAX &&
    /[a-z]/.test(p) &&
    /[A-Z]/.test(p)
  );
}

function validName(s, max) {
  if (typeof s !== "string") return false;
  const n = cpLen(s);
  if (n < 1 || n > max) return false;
  return /^[\p{L}\p{N}_\-\s·]+$/u.test(s);
}

function validInvite(c) {
  return typeof c === "string" && /^[A-HJ-NP-Z2-9]{6}$/.test(c.toUpperCase());
}

function validUid(u) {
  return typeof u === "string" && /^[1-9][0-9]{7}$/.test(u);
}

function validDate(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
}

/** 用量字段：非负、封顶（防异常客户端刷爆统计）。 */
function clampCount(v) {
  const n = Number(v) || 0;
  return Math.min(1_000_000, Math.max(0, Math.floor(n)));
}

// ---------- 密码哈希（PBKDF2，WebCrypto 标准，两端可用） ----------

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

// ---------- 常数时间比较（admin 口令，防时序侧信道） ----------

function timingSafeEqual(a, b) {
  const A = String(a);
  const B = String(b);
  const max = Math.max(A.length, B.length);
  let diff = A.length === B.length ? 0 : 1;
  for (let i = 0; i < max; i++) {
    diff |= (A.charCodeAt(i) || 0) ^ (B.charCodeAt(i) || 0);
  }
  return diff === 0;
}

// ---------- 限频（无 TTL：存时间戳，10 秒内视为存在） ----------

async function rateLimited(store, ip) {
  const raw = String(ip || "unknown");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  const key = `rl_${hex(digest).slice(0, 16)}`;
  const hit = await store.get(key);
  const now = Date.now();
  if (hit) {
    try {
      const { at } = JSON.parse(hit);
      if (now - at < RATE_LIMIT_MS) return true;
    } catch {
      // 损坏数据当作未限频
    }
  }
  await store.put(key, JSON.stringify({ at: now }));
  return false;
}

// ---------- uid / 邀请码生成 ----------

function randomUid() {
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

async function uniqueUid(store) {
  for (let i = 0; i < 8; i++) {
    const uid = randomUid();
    if (!(await store.get(`u_${uid}`))) return uid;
  }
  throw new Error("uid collision");
}

// ---------- 用户索引 ----------

async function userIndex(store) {
  return JSON.parse((await store.get("users_idx")) || "[]");
}

/** 注册/心跳时追加 uid（已存在则跳过）。心跳懒补录让旧数据自愈。 */
async function indexUser(store, uid) {
  const idx = await userIndex(store);
  if (!idx.includes(uid)) {
    idx.push(uid);
    await store.put("users_idx", JSON.stringify(idx));
  }
}

// ---------- 注册 / 登录 ----------

async function register(store, bodyReq) {
  const account = clean(bodyReq.account);
  const password = String(bodyReq.password ?? "");
  const nick = clean(bodyReq.nick);
  const invite = String(bodyReq.invite_code ?? "").toUpperCase();

  if (!validAccount(account)) return { error: "账号需 3-12 位字母/数字/下划线" };
  if (!validPassword(password)) {
    return { error: `密码需 ${PASS_MIN}-${PASS_MAX} 位且同时包含大写和小写字母` };
  }
  if (!validName(nick, NICK_MAX)) {
    return { error: `昵称需 1-${NICK_MAX} 字，仅支持中英文/数字/空格` };
  }
  if (!validInvite(invite)) return { error: "邀请码格式不正确" };

  const inviteRaw = await store.get(`invite_${invite}`);
  if (!inviteRaw) return { error: "邀请码不存在" };
  const inviteData = JSON.parse(inviteRaw);
  if (inviteData.used_by) return { error: "邀请码已被使用" };

  if (await store.get(`acct_${account}`)) return { error: "账号已被注册" };
  const nKey = await nickKey(nick);
  if (await store.get(nKey)) return { error: "昵称已被占用" };

  const uid = await uniqueUid(store);
  const salt = newToken().slice(0, 32);
  const passHash = await hashPassword(password, salt);
  const now = Date.now();

  await store.put(`u_${uid}`, JSON.stringify({
    uid,
    account,
    salt,
    pass_hash: passHash,
    created_at: now,
    nick,
    pet_name: "像素崽",
  }));
  await store.put(`acct_${account}`, uid);
  await store.put(nKey, uid);
  await store.put(`friends_${uid}`, JSON.stringify([]));
  await indexUser(store, uid);

  inviteData.used_by = uid;
  await store.put(`invite_${invite}`, JSON.stringify(inviteData));
  const ownInvite = randomInvite();
  await store.put(`invite_${ownInvite}`, JSON.stringify({ by: uid, used_by: null }));

  const token = newToken();
  await writeSession(store, token, uid);

  return {
    uid,
    token,
    expires_in: Math.floor(USER_SESSION_MS / 1000),
    created_at: now,
    nick,
    pet_name: "像素崽",
    invite_code: ownInvite,
  };
}

async function login(store, bodyReq) {
  const account = clean(bodyReq.account);
  const password = String(bodyReq.password ?? "");
  if (!validAccount(account) || !validPassword(password)) {
    return { error: "账号或密码不正确" }; // 不透露具体哪项错
  }
  const uid = await store.get(`acct_${account}`);
  if (!uid) return { error: "账号或密码不正确" };
  const raw = await store.get(`u_${uid}`);
  if (!raw) return { error: "账号或密码不正确" };
  const u = JSON.parse(raw);
  const hash = await hashPassword(password, u.salt);
  if (hash !== u.pass_hash) return { error: "账号或密码不正确" };

  const token = newToken();
  await writeSession(store, token, uid);
  return {
    uid,
    token,
    expires_in: Math.floor(USER_SESSION_MS / 1000),
    created_at: u.created_at,
    nick: u.nick,
    pet_name: u.pet_name,
  };
}

// ---------- 会话 ----------

/**
 * 读取会话。
 * 新格式是 JSON { uid, at }；旧版本写入的是裸 uid 字符串（无过期），
 * 这里把旧记录读成 at=0，本次鉴权会补上时间戳，从而平滑进入过期机制。
 */
async function readSession(store, token) {
  const raw = await store.get(`sess_${token}`);
  if (!raw) return null;
  const s = String(raw).startsWith("{") ? JSON.parse(raw) : { uid: String(raw), at: 0 };
  if (!s || !s.uid) return null;
  return { uid: String(s.uid), at: Number(s.at) || 0 };
}

async function writeSession(store, token, uid) {
  await store.put(`sess_${token}`, JSON.stringify({ uid, at: Date.now() }));
}

function bearerToken(meta) {
  const m = String(meta.auth || "").match(/^Bearer ([0-9a-f]{48})$/);
  return m ? m[1] : null;
}

/**
 * 校验用户会话，并在需要时滚动续期。
 * 返回 { uid, token } 或 { error } —— token 一并返回，供 logout 吊销。
 */
async function requireAuth(store, meta) {
  const token = bearerToken(meta);
  if (!token) return { error: { error: "未登录", _status: 401 } };

  const sess = await readSession(store, token);
  if (!sess) return { error: { error: "会话无效，请重新登录", _status: 401 } };

  const now = Date.now();
  if (sess.at && now - sess.at > USER_SESSION_MS) {
    await store.delete(`sess_${token}`);
    return { error: { error: "登录已过期，请重新登录", _status: 401 } };
  }

  // 滚动续期：距上次刷新超过 1 天才回写，避免每次请求都写 KV。
  // at=0 是旧会话的补时间戳时机。
  if (now - sess.at > SESSION_RENEW_MS) {
    await writeSession(store, token, sess.uid);
  }

  return { uid: sess.uid, token };
}

/** 登出：吊销当前会话 token。 */
async function logout(store, token) {
  if (token) await store.delete(`sess_${token}`);
  return { ok: true };
}

// ---------- 档案 ----------

async function me(store, uid) {
  const u = JSON.parse(await store.get(`u_${uid}`));
  return { uid: u.uid, created_at: u.created_at, nick: u.nick, pet_name: u.pet_name };
}

async function setPetName(store, uid, bodyReq) {
  const name = clean(bodyReq.pet_name);
  if (!validName(name, PET_NAME_MAX)) {
    return { error: `宠物名需 1-${PET_NAME_MAX} 字，仅支持中英文/数字/空格` };
  }
  const u = JSON.parse(await store.get(`u_${uid}`));
  u.pet_name = name;
  await store.put(`u_${uid}`, JSON.stringify(u));
  return { ok: true, pet_name: name };
}

// ---------- 好友 ----------

async function resolveTarget(store, target) {
  const t = clean(target);
  if (validUid(t)) {
    return (await store.get(`u_${t}`)) ? t : null;
  }
  if (validName(t, NICK_MAX)) {
    return (await store.get(await nickKey(t))) || null;
  }
  return null;
}

async function friendList(store, uid) {
  return JSON.parse((await store.get(`friends_${uid}`)) || "[]");
}

async function addFriend(store, uid, bodyReq) {
  const target = await resolveTarget(store, bodyReq.target);
  if (!target) return { error: "找不到该用户（检查 uid 或昵称）" };
  if (target === uid) return { error: "不能加自己" };

  const mine = await friendList(store, uid);
  const theirs = await friendList(store, target);
  if (mine.some((f) => f.uid === target)) return { ok: true, note: "已经是好友" };
  if (mine.length >= MAX_FRIENDS || theirs.length >= MAX_FRIENDS) {
    return { error: `好友数已达上限（${MAX_FRIENDS}）` };
  }

  const at = Date.now();
  mine.push({ uid: target, at });
  theirs.push({ uid, at });
  await store.put(`friends_${uid}`, JSON.stringify(mine));
  await store.put(`friends_${target}`, JSON.stringify(theirs));
  return { ok: true };
}

async function removeFriend(store, uid, bodyReq) {
  const target = await resolveTarget(store, bodyReq.target);
  if (!target) return { error: "找不到该用户" };

  const mine = (await friendList(store, uid)).filter((f) => f.uid !== target);
  const theirs = (await friendList(store, target)).filter((f) => f.uid !== uid);
  await store.put(`friends_${uid}`, JSON.stringify(mine));
  await store.put(`friends_${target}`, JSON.stringify(theirs));
  return { ok: true };
}

async function listFriends(store, uid) {
  const ids = await friendList(store, uid);
  const now = Date.now();
  const out = [];
  for (const f of ids) {
    const raw = await store.get(`u_${f.uid}`);
    const hb = JSON.parse((await store.get(`hb_${f.uid}`)) || "null");
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

// ---------- 用量统计（隐私红线：只存聚合计数，不存内容） ----------

function dateKey(date) {
  return `stats_${date.replace(/-/g, "")}`;
}

function sortDates(obj) {
  return Object.keys(obj).sort();
}

/**
 * 差值累加：客户端上报当日累计值，服务端按 (新-旧) 增量计入。
 * 同日新值 ≥ 旧值 → 增量；否则（跨日归零/重启/时钟回拨）→ 以新值为当日值。
 */
function deltaOf(prev, next) {
  if (!prev || prev.date !== next.date) return { ...next };
  const out = {};
  for (const k of ["reminders", "notes", "pomodoros", "online_mins"]) {
    out[k] = next[k] >= prev[k] ? next[k] - prev[k] : next[k];
  }
  out.date = next.date;
  return out;
}

async function recordUsage(store, uid, usage) {
  if (!usage || !validDate(usage.date)) return; // 旧客户端无 usage，忽略
  const next = {
    date: usage.date,
    reminders: clampCount(usage.reminders),
    notes: clampCount(usage.notes),
    pomodoros: clampCount(usage.pomodoros),
    online_mins: clampCount(usage.online_mins),
  };

  const key = `usage_${uid}`;
  const data = JSON.parse((await store.get(key)) || '{"days":{},"last":null}');

  // 1. 个人按日聚合（保留 30 天）
  const delta = deltaOf(data.last, next);
  const day = data.days[delta.date] || { reminders: 0, notes: 0, pomodoros: 0, online_mins: 0 };
  for (const k of ["reminders", "notes", "pomodoros", "online_mins"]) {
    day[k] += delta[k];
  }
  data.days[delta.date] = day;
  const dates = sortDates(data.days);
  while (dates.length > USAGE_KEEP_DAYS) delete data.days[dates.shift()];
  data.last = next;
  await store.put(key, JSON.stringify(data));

  // 2. 全站当日聚合（保留 90 天索引）
  const sKey = dateKey(delta.date);
  const stats = JSON.parse((await store.get(sKey)) || '{"reminders":0,"notes":0,"pomodoros":0,"online_mins":0,"active":[]}');
  for (const k of ["reminders", "notes", "pomodoros", "online_mins"]) {
    stats[k] += delta[k];
  }
  if (!stats.active.includes(uid)) stats.active.push(uid);
  await store.put(sKey, JSON.stringify(stats));

  const idx = JSON.parse((await store.get("stats_idx")) || "[]");
  if (!idx.includes(delta.date)) {
    idx.push(delta.date);
    idx.sort();
    while (idx.length > STATS_KEEP_DAYS) idx.shift();
    await store.put("stats_idx", JSON.stringify(idx));
  }
}

/** 今日（stats 索引里最新日期）的全站聚合，无数据时返回零值。 */
async function latestStats(store) {
  const idx = JSON.parse((await store.get("stats_idx")) || "[]");
  if (!idx.length) {
    return { date: null, reminders: 0, notes: 0, pomodoros: 0, online_mins: 0, active: 0 };
  }
  const date = idx[idx.length - 1];
  const s = JSON.parse((await store.get(dateKey(date))) || "{}");
  return {
    date,
    reminders: s.reminders || 0,
    notes: s.notes || 0,
    pomodoros: s.pomodoros || 0,
    online_mins: s.online_mins || 0,
    active: (s.active || []).length,
  };
}

// ---------- 心跳 ----------

async function heartbeat(store, uid, bodyReq) {
  const state = ["coding", "idle", "away", "visiting"].includes(bodyReq.state)
    ? bodyReq.state
    : "idle";
  const affinity = Math.min(100, Math.max(0, Number(bodyReq.affinity) || 0));
  await store.put(`hb_${uid}`, JSON.stringify({
    state,
    affinity,
    last_seen: Date.now(),
  }));

  // 宠物名随心跳兜底同步（改名接口失败时的重试通道）
  const petName = clean(bodyReq.pet_name);
  if (validName(petName, PET_NAME_MAX)) {
    const u = JSON.parse(await store.get(`u_${uid}`));
    if (u && u.pet_name !== petName) {
      u.pet_name = petName;
      await store.put(`u_${uid}`, JSON.stringify(u));
    }
  }

  // 用量上报（旧客户端无 usage 字段，安全跳过）+ 索引懒补录
  await recordUsage(store, uid, bodyReq.usage);
  await indexUser(store, uid);

  // 一次往返带回全部所需：好友、事件、在家访客（省请求量，配合限频）
  const friends = await listFriends(store, uid);
  const events = await pullEvents(store, uid);
  const visitors = await activeVisitors(store, uid);
  return {
    ok: true,
    next_secs: DEFAULT_HEARTBEAT_SECS,
    friends,
    events: events.events,
    visitors,
  };
}

// ---------- 事件队列 ----------

async function pushEvent(store, toUid, event) {
  const text = JSON.stringify(event);
  if (text.length > 512) return false;
  const key = `events_${toUid}`;
  const list = JSON.parse((await store.get(key)) || "[]");
  list.push({ at: Date.now(), event });
  while (list.length > 20) list.shift();
  await store.put(key, JSON.stringify(list));
  return true;
}

async function pullEvents(store, uid) {
  const key = `events_${uid}`;
  const list = JSON.parse((await store.get(key)) || "[]");
  if (list.length) await store.delete(key);
  return { events: list };
}

// ---------- 串门 ----------

async function activeVisitors(store, uid) {
  const key = `visitors_${uid}`;
  const list = JSON.parse((await store.get(key)) || "[]");
  const now = Date.now();
  const alive = list.filter((v) => now - v.at < VISIT_EXPIRE_MS);
  if (alive.length !== list.length) {
    await store.put(key, JSON.stringify(alive));
  }
  return alive;
}

async function visit(store, uid, bodyReq) {
  const target = await resolveTarget(store, bodyReq.target);
  if (!target) return { error: "找不到该用户" };
  if (target === uid) return { error: "不能拜访自己" };

  const mine = await friendList(store, uid);
  if (!mine.some((f) => f.uid === target)) return { error: "只能拜访好友" };

  const hb = JSON.parse((await store.get(`hb_${target}`)) || "null");
  const now = Date.now();
  if (!hb || now - hb.last_seen >= OFFLINE_AFTER_MS) {
    return { error: "好友不在线" };
  }

  const visitors = await activeVisitors(store, target);
  if (visitors.length >= MAX_VISITORS) {
    return { error: "好友家已经有 3 只宠物在做客了" };
  }
  if (visitors.some((v) => v.uid === uid)) {
    return { ok: true, note: "已经在做客" };
  }

  const meUser = JSON.parse(await store.get(`u_${uid}`));
  visitors.push({ uid, nick: meUser.nick, pet_name: meUser.pet_name, at: now });
  await store.put(`visitors_${target}`, JSON.stringify(visitors));

  await pushEvent(store, target, {
    type: "visit",
    from_uid: uid,
    from_nick: meUser.nick,
    pet_name: meUser.pet_name,
  });
  return { ok: true };
}

async function goHome(store, uid, bodyReq) {
  const target = bodyReq && bodyReq.target ? clean(bodyReq.target) : null;
  if (validUid(target)) {
    const key = `visitors_${target}`;
    const list = JSON.parse((await store.get(key)) || "[]");
    const next = list.filter((v) => v.uid !== uid);
    if (next.length !== list.length) {
      await store.put(key, JSON.stringify(next));
      await pushEvent(store, target, {
        type: "leave",
        from_uid: uid,
        from_nick: "",
        pet_name: "",
      });
    }
  }
  return { ok: true };
}

// ---------- 管理：鉴权 ----------

/** 常数时间比较环境变量口令；未配置环境变量时管理接口整体禁用。 */
function adminConfigured(env) {
  return !!(env && env.ADMIN_USER && env.ADMIN_PASS);
}

async function adminLogin(store, env, meta, bodyReq) {
  if (!adminConfigured(env)) return { error: "admin 未配置", _status: 403 };
  const user = String(bodyReq.user ?? "");
  const pass = String(bodyReq.pass ?? "");
  const okUser = timingSafeEqual(user, env.ADMIN_USER);
  const okPass = timingSafeEqual(pass, env.ADMIN_PASS);
  if (!okUser || !okPass) return { error: "账号或密码不正确", _status: 403 };

  const token = newToken();
  await store.put(`sess_admin_${token}`, JSON.stringify({ at: Date.now() }));
  return { ok: true, token, expires_in: ADMIN_SESSION_MS / 1000 };
}

async function requireAdmin(store, env, meta) {
  if (!adminConfigured(env)) return { error: { error: "admin 未配置", _status: 403 } };
  const m = String(meta.auth || "").match(/^Bearer ([0-9a-f]{48})$/);
  if (!m) return { error: { error: "未登录", _status: 401 } };
  const raw = await store.get(`sess_admin_${m[1]}`);
  if (!raw) return { error: { error: "会话无效", _status: 401 } };
  try {
    const { at } = JSON.parse(raw);
    if (Date.now() - at > ADMIN_SESSION_MS) {
      await store.delete(`sess_admin_${m[1]}`);
      return { error: { error: "会话已过期", _status: 401 } };
    }
  } catch {
    return { error: { error: "会话无效", _status: 401 } };
  }
  return { ok: true };
}

// ---------- 管理：查询 ----------

/** 遍历用户索引装配用户视图（用户量小，逐个 get 可接受）。 */
async function userViews(store) {
  const idx = await userIndex(store);
  const now = Date.now();
  const out = [];
  for (const uid of idx) {
    const raw = await store.get(`u_${uid}`);
    if (!raw) continue; // 索引脏数据，跳过
    const u = JSON.parse(raw);
    const hb = JSON.parse((await store.get(`hb_${uid}`)) || "null");
    const friends = JSON.parse((await store.get(`friends_${uid}`)) || "[]");
    const online = !!hb && now - hb.last_seen < OFFLINE_AFTER_MS;
    const usage = JSON.parse((await store.get(`usage_${uid}`)) || '{"days":{}}');
    // 今日用量：取个人记录里最新的日期条目（客户端本地日期）
    const days = sortDates(usage.days || {});
    const latestDate = days[days.length - 1] || null;
    out.push({
      uid: u.uid,
      account: u.account,
      nick: u.nick,
      pet_name: u.pet_name,
      created_at: u.created_at,
      last_seen: hb ? hb.last_seen : null,
      online,
      state: online ? hb.state : "offline",
      affinity: hb ? hb.affinity : 0,
      friends_count: friends.length,
      today: latestDate ? { date: latestDate, ...usage.days[latestDate] } : null,
    });
  }
  out.sort((a, b) => b.created_at - a.created_at);
  return out;
}

async function adminOverview(store) {
  const users = await userViews(store);
  const today = await latestStats(store);

  // 近 30 天趋势（stats 索引末 30 个日期）
  const idx = JSON.parse((await store.get("stats_idx")) || "[]");
  const trend = [];
  for (const date of idx.slice(-30)) {
    const s = JSON.parse((await store.get(dateKey(date))) || "{}");
    trend.push({
      date,
      reminders: s.reminders || 0,
      notes: s.notes || 0,
      pomodoros: s.pomodoros || 0,
      online_mins: s.online_mins || 0,
      active: (s.active || []).length,
    });
  }

  return {
    total_users: users.length,
    online_now: users.filter((u) => u.online).length,
    today,
    trend,
    // 注册时间原样下发，页面在浏览器本地时区分桶画趋势
    users_created: users.map((u) => u.created_at),
  };
}

async function adminUsers(store) {
  return { users: await userViews(store) };
}

async function adminUserDetail(store, query) {
  const uid = query.get("uid");
  if (!validUid(uid)) return { error: "bad uid", _status: 400 };
  const raw = await store.get(`u_${uid}`);
  if (!raw) return { error: "user not found", _status: 404 };
  const u = JSON.parse(raw);
  const hb = JSON.parse((await store.get(`hb_${uid}`)) || "null");
  const friends = JSON.parse((await store.get(`friends_${uid}`)) || "[]");
  const usage = JSON.parse((await store.get(`usage_${uid}`)) || '{"days":{}}');

  // 好友档案（uid/昵称/宠物名，供明细页展示）
  const friendViews = [];
  for (const f of friends) {
    const fr = await store.get(`u_${f.uid}`);
    if (!fr) continue;
    const fu = JSON.parse(fr);
    friendViews.push({ uid: fu.uid, nick: fu.nick, pet_name: fu.pet_name, since: f.at });
  }

  const days = usage.days || {};
  const total = { reminders: 0, notes: 0, pomodoros: 0, online_mins: 0 };
  for (const d of Object.values(days)) {
    for (const k of Object.keys(total)) total[k] += d[k] || 0;
  }

  return {
    uid: u.uid,
    account: u.account,
    nick: u.nick,
    pet_name: u.pet_name,
    created_at: u.created_at,
    last_seen: hb ? hb.last_seen : null,
    state: hb ? hb.state : "offline",
    affinity: hb ? hb.affinity : 0,
    friends_count: friends.length,
    friends: friendViews,
    days,
    total,
  };
}

// ---------- 管理：邀请码签发 ----------

async function adminInvite(store, count) {
  const n = Math.min(20, Math.max(1, Number(count) || 1));
  const codes = [];
  for (let i = 0; i < n; i++) {
    const c = randomInvite();
    await store.put(`invite_${c}`, JSON.stringify({ by: "admin", used_by: null }));
    codes.push(c);
  }
  return { ok: true, codes };
}

// ---------- 分发 ----------

/**
 * 分发一次请求。
 * @param store 实现了 get/put/delete 的存储（KV / 文件 / 内存）
 * @param method GET/POST
 * @param segs 路径段数组（已剥掉 /api 前缀）：["register"]、["friends","add"]、["admin","overview"]…
 * @param query URLSearchParams
 * @param body 已解析的请求体
 * @param env 环境变量（边缘函数 env 对象 / Node process.env），读取 ADMIN_USER/ADMIN_PASS
 * @param meta { ip, auth }：客户端 IP（限频）与 Authorization 头
 */
export async function dispatch(store, method, segs, query, body, env, meta = {}) {
  const path = segs.join("/");

  // ---- 管理接口（独立鉴权，先于用户会话） ----
  if (segs[0] === "admin") {
    const sub = segs.slice(1).join("/");
    if (sub === "login") {
      if (method !== "POST") return { error: "POST only" };
      if (await rateLimited(store, meta.ip)) return { error: "请求太频繁，请 10 秒后再试" };
      return await adminLogin(store, env, meta, body);
    }
    const auth = await requireAdmin(store, env, meta);
    if (auth.error) return auth.error;
    if (sub === "invite") {
      return method === "POST" ? await adminInvite(store, body.count) : { error: "POST only" };
    }
    if (sub === "overview") {
      return method === "GET" ? await adminOverview(store) : { error: "GET only" };
    }
    if (sub === "users") {
      return method === "GET" ? await adminUsers(store) : { error: "GET only" };
    }
    if (segs[1] === "user") {
      return method === "GET" ? await adminUserDetail(store, query) : { error: "GET only" };
    }
    return { error: "not found", _status: 404 };
  }

  // ---- 自检 ----
  if (method === "GET" && path === "status") return { ok: true, now: Date.now() };

  // ---- 公开接口（限频保护） ----
  if (method === "POST" && path === "register") {
    if (await rateLimited(store, meta.ip)) {
      return { error: "请求太频繁，请 10 秒后再试" };
    }
    return await register(store, body);
  }
  if (method === "POST" && path === "login") {
    if (await rateLimited(store, meta.ip)) {
      return { error: "请求太频繁，请 10 秒后再试" };
    }
    return await login(store, body);
  }

  // ---- 需要登录的接口：Bearer token 鉴权 ----
  const auth = await requireAuth(store, meta);
  if (auth.error) return auth.error;

  if (method === "GET" && path === "me") return await me(store, auth.uid);
  if (method === "POST" && path === "logout") return await logout(store, auth.token);
  if (method === "POST" && path === "profile/pet-name") {
    return await setPetName(store, auth.uid, body);
  }
  if (method === "POST" && path === "friends/add") {
    return await addFriend(store, auth.uid, body);
  }
  if (method === "POST" && path === "friends/remove") {
    return await removeFriend(store, auth.uid, body);
  }
  if (method === "GET" && path === "friends") return await listFriends(store, auth.uid);
  if (method === "POST" && path === "heartbeat") {
    return await heartbeat(store, auth.uid, body);
  }
  if (method === "POST" && path === "visit") return await visit(store, auth.uid, body);
  if (method === "POST" && path === "home") return await goHome(store, auth.uid, body);
  return { error: "not found", _status: 404 };
}

export { CORS };

/** 状态码辅助：供 [[default]].js / local-dev.js 统一映射。 */
export function statusFor(result) {
  if (result && result._status) return result._status;
  if (result && result.error === "not found") return 404;
  if (result && result.error) return 400;
  return 200;
}
