/**
 * Cloudflare Worker 版同步服务自检 —— 用内存 KV 驱动真实的 fetch handler。
 *
 * 用法：node scripts/test-worker.mjs
 * 退出码非 0 表示有断言失败。
 *
 * 与 scripts/test-sync.mjs 的区别：那个直接调 dispatch（测业务逻辑），
 * 这个走完整的 HTTP 适配层（测 Worker 的路由、KV 绑定、响应头），
 * 所以能在不部署到 Cloudflare 的前提下验证运行时适配是否正确。
 */
import { webcrypto } from "node:crypto";

globalThis.crypto ??= webcrypto;

const worker = (await import("../worker/src/index.js")).default;

/** 模拟 Cloudflare KV binding：只实现 lib-account 用到的 get/put/delete。 */
function memKV() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
}

const env = { SYNC_KV: memKV() };
let failed = 0;
// 每次请求换一个来源 IP：注册/登录有 10 秒同 IP 限频，
// 固定 IP 会让第二条注册必然被拒（那是限频在生效，不是 bug）
let ipSeq = 0;

async function call(method, path, body = {}, auth = "") {
  const headers = {
    "Content-Type": "application/json",
    "CF-Connecting-IP": `198.51.100.${ipSeq++ % 250}`,
  };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  const res = await worker.fetch(
    new Request(`https://sync.test${path}`, {
      method,
      headers,
      body: method === "POST" ? JSON.stringify(body) : undefined,
    }),
    env,
  );
  let json = {};
  try {
    json = JSON.parse(await res.text());
  } catch {
    /* 非 JSON 响应按空对象处理 */
  }
  return { status: res.status, json };
}

function ok(cond, msg) {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
}

async function newUser(account, nick, petName, hidden = false) {
  const r = await call("POST", "/api/register", {
    account, password: "Abcdef12", nick, invite_code: "PET888",
  });
  if (r.json.uid) {
    await call("POST", "/api/heartbeat", { state: "idle", affinity: 0, pet_name: petName, hidden }, r.json.token);
  }
  return r.json;
}

// ---------- 路由与适配层 ----------

const st = await call("GET", "/api/status");
ok(st.status === 200 && st.json.ok === true, `/api/status：${st.status} ${JSON.stringify(st.json)}`);

const st2 = await call("GET", "/status");
ok(st2.status === 200 && st2.json.ok === true, "不带 /api 前缀也能命中（两种 base URL 都行）");

// 未知路径：未登录是 401（鉴权先于路由），登录后才是 404
const anon = await call("GET", "/api/nope");
ok(anon.status === 401, `未登录访问未知路径 401：${anon.status}`);

// KV 没绑定时必须显式报错，不能静默降级成内存
const noKv = await worker.fetch(
  new Request("https://sync.test/api/status"),
  {},
);
ok(noKv.status === 500, `KV 未绑定时 500 而非静默降级：${noKv.status}`);

const opts = await worker.fetch(
  new Request("https://sync.test/api/status", { method: "OPTIONS" }),
  env,
);
ok(opts.status === 200, `OPTIONS 预检：${opts.status}`);

// ---------- 业务链路 ----------

const a = await newUser("pet_alice1", "甲_a1b2c3", "甲崽");
ok(!!a.uid, `注册 A：${a.uid ?? JSON.stringify(a)}`);

const notFound = await call("GET", "/api/nope", {}, a.token);
ok(notFound.status === 404, `登录后访问未知路径 404：${notFound.status}`);

const b = await newUser("pet_bob001", "乙_d4e5f6", "乙崽");
ok(!!b.uid, `公共码可重复使用（注册 B）：${b.uid ?? JSON.stringify(b)}`);

const r1 = await call("POST", "/api/online/random", {}, a.token);
ok(r1.status === 200 && Array.isArray(r1.json.users), `online/random：${r1.status}`);
const uids = (r1.json.users ?? []).map((u) => u.uid);
ok(!uids.includes(a.uid), "推荐不含自己");
ok(uids.includes(b.uid), `推荐含在线的 B：${uids}`);

const g1 = await call("POST", "/api/greet", { target: b.uid, line: "（摇着尾巴跑过来）嗨～" }, a.token);
ok(g1.status === 200 && g1.json.ok, `A 向 B 打招呼：${JSON.stringify(g1.json)}`);

const g2 = await call("POST", "/api/greet", { target: b.uid }, a.token);
ok("error" in g2.json && g2.json.cooldown_secs > 0, `冷却生效：${g2.json.error} / ${g2.json.cooldown_secs}s`);

const hb = await call("POST", "/api/heartbeat", { state: "coding", affinity: 0, pet_name: "乙崽" }, b.token);
const evt = (hb.json.events ?? []).find((e) => e.event?.type === "greet");
ok(!!evt, "B 心跳拉到 greet 事件");
ok(evt?.event.line === "（摇着尾巴跑过来）嗨～", `话术原样中转：${evt?.event.line}`);
ok(!("mood" in (evt?.event ?? {})), "事件里不含心情字段（隐私红线）");

const v = await call("POST", "/api/visit", { target: b.uid }, a.token);
ok(v.status === 200 && v.json.ok, `打过招呼后串门：${JSON.stringify(v.json)}`);

const hb2 = await call("POST", "/api/heartbeat", { state: "coding", affinity: 0, pet_name: "乙崽" }, b.token);
ok((hb2.json.visitors ?? []).some((x) => x.uid === a.uid), `B 家出现访客 A：${hb2.json.visitors?.length} 位`);

// 隐身
const h = await newUser("pet_hid001", "隐_e1f2g3", "隐崽", true);
const rHidden = await call("POST", "/api/online/random", {}, a.token);
ok(!(rHidden.json.users ?? []).some((u) => u.uid === h.uid), "隐身用户不进推荐池");
const c = await newUser("pet_carol2", "丙_h3i4j5", "丙崽");
const gHidden = await call("POST", "/api/greet", { target: h.uid }, c.token);
ok(gHidden.json.error === "对方现在不想被打扰", `打不到隐身的人：${gHidden.json.error}`);

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
