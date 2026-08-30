/**
 * Vibe Pet 同步服务 —— EdgeOne Pages Functions 版。
 *
 * 部署后需在 EdgeOne 控制台完成一次 KV 绑定（一次性）：
 *   1. 控制台 → 存储 → KV → 立即申请（免费 1GB）
 *   2. 创建命名空间（名字随意）
 *   3. 项目详情 → KV 存储 → 绑定命名空间 → 变量名填 `SYNC_KV`
 *
 * 与 Cloudflare 版的差异：
 *   - KV 以绑定变量名全局访问（本文件用 SYNC_KV），无需 import
 *   - KV key 仅允许数字/字母/下划线，分隔符用 _（CF 版用的 : 会被拒）
 *   - pet_id 为 24 位字母数字（无连字符，同理）
 *   - KV 最终一致（最长 60s）：好友状态显示可能延迟一分钟，
 *     事件可能偶发重复 —— 前端按事件 id 去重
 *
 * 路由（/api/[[default]] catch-all）：
 *   POST /api/register  { nick }                → { pet_id, invite_code }
 *   POST /api/state     { pet_id, nick, ... }   → { ok }
 *   POST /api/befriend  { pet_id, invite_code } → { ok }
 *   GET  /api/friends?pet_id=                   → [{ ... }]
 *   POST /api/event     { pet_id, to, event }   → { ok }
 *   GET  /api/events?pet_id=                    → { events }
 */

const OFFLINE_AFTER_MS = 5 * 60 * 1000;
const EVENT_TTL_SECS = 7 * 24 * 3600;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Content-Type": "application/json",
};

function kv() {
  // 未绑定 KV 时全局变量不存在，typeof 检查避免 ReferenceError
  return typeof SYNC_KV === "undefined" ? null : SYNC_KV;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: CORS,
  });
}

function randomId() {
  // 24 位 base36，仅字母数字（KV key 限制）
  let s = "";
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 24; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

function randomInvite() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let s = "";
  for (let i = 0; i < 6; i++) {
    s += alphabet[Math.floor(Math.random() * alphabet.length)];
  }
  return s;
}

async function register(kv, body) {
  const nick = String(body.nick || "").slice(0, 24) || "无名宠物";
  const petId = randomId();
  let invite = randomInvite();
  for (let i = 0; i < 5; i++) {
    if (!(await kv.get(`invite_${invite}`))) break;
    invite = randomInvite();
  }
  await kv.put(`invite_${invite}`, petId);
  await kv.put(`pet_${petId}`, JSON.stringify({
    nick,
    state: "idle",
    affinity: 0,
    last_seen: Date.now(),
  }));
  await kv.put(`friends_${petId}`, JSON.stringify([]));
  return { pet_id: petId, invite_code: invite };
}

async function reportState(kv, body) {
  const petId = String(body.pet_id || "");
  if (!petId || !(await kv.get(`pet_${petId}`))) {
    return { error: "unknown pet" };
  }
  // 白名单：只取允许的字段（服务端同样守红线）
  await kv.put(`pet_${petId}`, JSON.stringify({
    nick: String(body.nick || "").slice(0, 24),
    state: ["coding", "idle", "away"].includes(body.state) ? body.state : "idle",
    affinity: Math.min(100, Math.max(0, Number(body.affinity) || 0)),
    last_seen: Date.now(),
  }));
  return { ok: true };
}

async function befriend(kv, body) {
  const petId = String(body.pet_id || "");
  const invite = String(body.invite_code || "").toUpperCase();
  if (!petId || !invite) return { error: "bad request" };

  const friendId = await kv.get(`invite_${invite}`);
  if (!friendId) return { error: "邀请码不存在" };
  if (friendId === petId) return { error: "不能加自己" };

  const mine = JSON.parse((await kv.get(`friends_${petId}`)) || "[]");
  if (!mine.includes(friendId)) {
    mine.push(friendId);
    await kv.put(`friends_${petId}`, JSON.stringify(mine));
  }
  const theirs = JSON.parse((await kv.get(`friends_${friendId}`)) || "[]");
  if (!theirs.includes(petId)) {
    theirs.push(petId);
    await kv.put(`friends_${friendId}`, JSON.stringify(theirs));
  }
  return { ok: true };
}

async function listFriends(kv, petId) {
  if (!petId) return { error: "bad request" };
  const ids = JSON.parse((await kv.get(`friends_${petId}`)) || "[]");
  const now = Date.now();
  const out = [];
  for (const id of ids) {
    const raw = await kv.get(`pet_${id}`);
    if (!raw) continue;
    const p = JSON.parse(raw);
    out.push({
      pet_id: id,
      nick: p.nick,
      state: now - p.last_seen < OFFLINE_AFTER_MS ? p.state : "offline",
      affinity: p.affinity ?? 0,
      last_seen: p.last_seen,
      online: now - p.last_seen < OFFLINE_AFTER_MS,
    });
  }
  return out;
}

async function pushEvent(kv, body) {
  const from = String(body.pet_id || "");
  const to = String(body.to || "");
  const event = body.event;
  if (!from || !to || !event) return { error: "bad request" };
  // 事件带唯一 id，前端据此去重（KV 最终一致可能重复投递）
  const packed = { from, event: { ...event, id: randomId() }, at: Date.now() };
  const text = JSON.stringify(packed);
  if (text.length > 512) return { error: "event too large" };

  const key = `events_${to}`;
  const list = JSON.parse((await kv.get(key)) || "[]");
  list.push(packed);
  while (list.length > 20) list.shift();
  await kv.put(key, text, { expirationTtl: EVENT_TTL_SECS });
  return { ok: true };
}

async function pullEvents(kv, petId) {
  const key = `events_${petId}`;
  const list = JSON.parse((await kv.get(key)) || "[]");
  if (list.length) await kv.delete(key);
  // 注意：KV 最终一致，「读即清空」跨节点可能重复收到 —— 前端按 id 去重
  return { events: list };
}

export async function onRequest({ request, params }) {
  if (request.method === "OPTIONS") {
    return new Response(null, { headers: CORS });
  }

  const store = kv();
  if (!store) {
    return json(
      { error: "KV 未绑定：请在项目设置中绑定命名空间，变量名 SYNC_KV" },
      500,
    );
  }

  const url = new URL(request.url);
  // catch-all 参数是路径段数组，如 ["register"] 或 ["api", "friends"]
  const segs = Array.isArray(params.default) ? params.default : [params.default];
  const action = segs[segs.length - 1];

  try {
    let body = {};
    if (request.method === "POST") {
      body = await request.json();
    }

    if (request.method === "POST" && action === "register") {
      return json(await register(store, body));
    }
    if (request.method === "POST" && action === "state") {
      return json(await reportState(store, body));
    }
    if (request.method === "POST" && action === "befriend") {
      return json(await befriend(store, body));
    }
    if (request.method === "GET" && action === "friends") {
      return json(await listFriends(store, url.searchParams.get("pet_id")));
    }
    if (request.method === "POST" && action === "event") {
      return json(await pushEvent(store, body));
    }
    if (request.method === "GET" && action === "events") {
      return json(await pullEvents(store, url.searchParams.get("pet_id")));
    }
    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
}
