/**
 * 同步服务核心逻辑 —— 与运行时无关。
 *
 * 被两处复用：
 *   - edge-functions/api/[[default]].js（EdgeOne 边缘函数，KV 存储）
 *   - local-dev.js（本机测试服务，文件存储）
 *
 * 只要传入实现了 get/put/delete 的 store，逻辑完全一致。
 * 这样本地验证的行为与线上一致，不会出现「本地过、线上挂」。
 */

const OFFLINE_AFTER_MS = 5 * 60 * 1000;
const EVENT_TTL_SECS = 7 * 24 * 3600;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Content-Type": "application/json",
};

function randomId() {
  // 24 位字母数字（KV key 限制：仅数字/字母/下划线）
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
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

async function register(store, body) {
  const nick = String(body.nick || "").slice(0, 24) || "无名宠物";
  const petId = randomId();
  let invite = randomInvite();
  for (let i = 0; i < 5; i++) {
    if (!(await store.get(`invite_${invite}`))) break;
    invite = randomInvite();
  }
  await store.put(`invite_${invite}`, petId);
  await store.put(
    `pet_${petId}`,
    JSON.stringify({ nick, state: "idle", affinity: 0, last_seen: Date.now() }),
  );
  await store.put(`friends_${petId}`, JSON.stringify([]));
  return { pet_id: petId, invite_code: invite };
}

async function reportState(store, body) {
  const petId = String(body.pet_id || "");
  if (!petId || !(await store.get(`pet_${petId}`))) {
    return { error: "unknown pet" };
  }
  // 白名单：只存允许的字段（服务端同样守红线）
  await store.put(
    `pet_${petId}`,
    JSON.stringify({
      nick: String(body.nick || "").slice(0, 24),
      state: ["coding", "idle", "away"].includes(body.state)
        ? body.state
        : "idle",
      affinity: Math.min(100, Math.max(0, Number(body.affinity) || 0)),
      last_seen: Date.now(),
    }),
  );
  return { ok: true };
}

async function befriend(store, body) {
  const petId = String(body.pet_id || "");
  const invite = String(body.invite_code || "").toUpperCase();
  if (!petId || !invite) return { error: "bad request" };

  const friendId = await store.get(`invite_${invite}`);
  if (!friendId) return { error: "邀请码不存在" };
  if (friendId === petId) return { error: "不能加自己" };

  const mine = JSON.parse((await store.get(`friends_${petId}`)) || "[]");
  if (!mine.includes(friendId)) {
    mine.push(friendId);
    await store.put(`friends_${petId}`, JSON.stringify(mine));
  }
  const theirs = JSON.parse((await store.get(`friends_${friendId}`)) || "[]");
  if (!theirs.includes(petId)) {
    theirs.push(petId);
    await store.put(`friends_${friendId}`, JSON.stringify(theirs));
  }
  return { ok: true };
}

async function listFriends(store, petId) {
  if (!petId) return { error: "bad request" };
  const ids = JSON.parse((await store.get(`friends_${petId}`)) || "[]");
  const now = Date.now();
  const out = [];
  for (const id of ids) {
    const raw = await store.get(`pet_${id}`);
    if (!raw) continue;
    const p = JSON.parse(raw);
    const online = now - p.last_seen < OFFLINE_AFTER_MS;
    out.push({
      pet_id: id,
      nick: p.nick,
      state: online ? p.state : "offline",
      affinity: p.affinity ?? 0,
      last_seen: p.last_seen,
      online,
    });
  }
  return out;
}

async function pushEvent(store, body) {
  const from = String(body.pet_id || "");
  const to = String(body.to || "");
  const event = body.event;
  if (!from || !to || !event) return { error: "bad request" };
  // 事件带唯一 id，客户端据此去重（KV 最终一致可能重复投递）
  const packed = { from, event: { ...event, id: randomId() }, at: Date.now() };
  if (JSON.stringify(packed).length > 512) return { error: "event too large" };

  const key = `events_${to}`;
  const list = JSON.parse((await store.get(key)) || "[]");
  list.push(packed);
  while (list.length > 20) list.shift();
  await store.put(key, JSON.stringify(list));
  return { ok: true };
}

async function pullEvents(store, petId) {
  if (!petId) return { error: "bad request" };
  const key = `events_${petId}`;
  const list = JSON.parse((await store.get(key)) || "[]");
  if (list.length) await store.delete(key);
  return { events: list };
}

/**
 * 分发一次请求。
 * @param store KV 或文件/内存存储
 * @param method GET/POST
 * @param action 末段路径：register/state/befriend/friends/event/events/status
 * @param query URLSearchParams
 * @param body 已解析的请求体
 */
export async function dispatch(store, method, action, query, body) {
  switch (action) {
    case "status":
      return { ok: true, now: Date.now() };
    case "register":
      return method === "POST" ? await register(store, body) : { error: "POST only" };
    case "state":
      return method === "POST" ? await reportState(store, body) : { error: "POST only" };
    case "befriend":
      return method === "POST" ? await befriend(store, body) : { error: "POST only" };
    case "friends":
      return await listFriends(store, query.get("pet_id"));
    case "event":
      return method === "POST" ? await pushEvent(store, body) : { error: "POST only" };
    case "events":
      return await pullEvents(store, query.get("pet_id"));
    default:
      return { error: "not found" };
  }
}

export { CORS, EVENT_TTL_SECS, OFFLINE_AFTER_MS };

/** 供 local-dev 复用：把一次性错误包成 404/500 判定辅助 */
export function statusFor(result) {
  if (result && result.error === "not found") return 404;
  if (result && result.error) return 400;
  return 200;
}
