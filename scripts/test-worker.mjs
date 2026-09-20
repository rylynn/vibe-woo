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

const env = { SYNC_KV: memKV(), ADMIN_USER: "op", ADMIN_PASS: "s3cret-pass" };
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

/** octet-stream 裸字节上传（更新镜像的包），返回原始 Response 供字节级断言。 */
async function callRaw(method, path, bytes, auth = "") {
  const headers = {
    "Content-Type": "application/octet-stream",
    "CF-Connecting-IP": `198.51.100.${ipSeq++ % 250}`,
  };
  if (auth) headers.Authorization = `Bearer ${auth}`;
  return worker.fetch(new Request(`https://sync.test${path}`, { method, headers, body: bytes }), env);
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

// ---------- 好友申请与碰一碰（新路由过适配层） ----------
const qW = await call("POST", "/api/friends/request", { target: b.uid }, a.token);
ok(qW.status === 200 && qW.json.ok, `friends/request 过适配层：${JSON.stringify(qW.json)}`);
const accW = await call("POST", "/api/friends/accept", { target: a.uid }, b.token);
ok(accW.status === 200 && accW.json.ok, `friends/accept：${JSON.stringify(accW.json)}`);
const bpW = await call("POST", "/api/friends/bump", { target: b.uid }, a.token);
ok(bpW.status === 200 && bpW.json.ok, `friends/bump：${JSON.stringify(bpW.json)}`);
const bpW2 = await call("POST", "/api/friends/bump", { target: b.uid }, a.token);
ok(bpW2.status === 400 && "error" in bpW2.json && bpW2.json.retry_after > 0, `限流字段完整透传：${JSON.stringify(bpW2.json)}`);

// ---------- 更新镜像（octet-stream 上传 + __raw 二进制响应过适配层） ----------

const emptyLatest = await call("GET", "/api/update/latest");
ok(emptyLatest.status === 404, `未发布 latest 404：${emptyLatest.status}`);

const noAuthPush = await call("POST", "/api/admin/update/manifest", { version: "1.5.0" });
ok(noAuthPush.status === 401, `无 token 发清单 401：${noAuthPush.status}`);

const admLogin = await call("POST", "/api/admin/login", { user: "op", pass: "s3cret-pass" });
ok(!!admLogin.json.token, `admin 登录过适配层：${JSON.stringify(admLogin.json).slice(0, 40)}`);

// 推包：octet-stream 裸字节 → 适配器 __bytes 分支 → KV 存取 → 字节回读一致
const mirrorPkg = new Uint8Array(2048);
for (let i = 0; i < mirrorPkg.length; i++) mirrorPkg[i] = (i * 13) % 253;
const pushRes = await callRaw("POST", "/api/admin/update/pkg?v=1.5.0", mirrorPkg, admLogin.json.token);
ok(pushRes.status === 200, `推包过适配层：${pushRes.status}`);

const manifestBody = {
  version: "1.5.0",
  pub_date: "2026-09-20T00:00:00Z",
  platforms: {
    "darwin-aarch64": { signature: "sig-arm", url: "https://github.com/rylynn/vibe-woo/releases/latest/download/vibe-pet.app.tar.gz" },
    "darwin-x86_64": { signature: "sig-x64", url: "https://github.com/rylynn/vibe-woo/releases/latest/download/vibe-pet.app.tar.gz" },
  },
};
const pushMan = await call("POST", "/api/admin/update/manifest", manifestBody, admLogin.json.token);
ok(pushMan.status === 200 && pushMan.json.ok, `发清单过适配层：${JSON.stringify(pushMan.json)}`);

// latest：JSON 响应，下载地址重写为适配层自己的 origin
const latestRes = await worker.fetch(new Request("https://sync.test/api/update/latest"), env);
const latestJson = JSON.parse(await latestRes.text());
ok(latestRes.status === 200, `latest 200：${latestRes.status}`);
ok(latestRes.headers.get("Content-Type") === "application/json", `latest Content-Type：${latestRes.headers.get("Content-Type")}`);
ok(latestRes.headers.get("Cache-Control") === "no-store", `latest no-store：${latestRes.headers.get("Cache-Control")}`);
ok(
  Object.values(latestJson.platforms).every((p) => p.url === "https://sync.test/api/update/pkg?v=1.5.0"),
  `下载地址重写为本服务 origin：${JSON.stringify(Object.values(latestJson.platforms).map((p) => p.url))}`,
);

// pkg：二进制响应，字节与上传逐一致（arrayBuffer 通道）
const pkgRes = await worker.fetch(new Request("https://sync.test/api/update/pkg?v=1.5.0"), env);
const pkgBytes = new Uint8Array(await pkgRes.arrayBuffer());
ok(pkgRes.status === 200, `pkg 200：${pkgRes.status}`);
ok(pkgRes.headers.get("Content-Type") === "application/octet-stream", `pkg Content-Type：${pkgRes.headers.get("Content-Type")}`);
ok(
  Buffer.compare(Buffer.from(pkgBytes), Buffer.from(mirrorPkg)) === 0,
  `pkg 字节与上传逐字节一致：${pkgBytes.length}B`,
);

// 回归：octet-stream 分支不影响既有 JSON 端点
const regAgain = await call("POST", "/api/register", {
  account: "pet_raw01", password: "Abcdef12", nick: "丁_raw01", invite_code: "PET888",
});
ok(!!regAgain.json.uid, `JSON 端点不受二进制分支影响：${regAgain.json.uid ?? JSON.stringify(regAgain.json)}`);

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
