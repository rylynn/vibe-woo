/**
 * 对**已部署**的同步服务做端到端验收（任意部署目标都适用）。
 *
 * 用法：
 *   node scripts/test-remote.mjs http://119.45.169.217:8787
 *   node scripts/test-remote.mjs https://xxx.workers.dev/api
 *   node scripts/test-remote.mjs http://localhost:8787
 *
 * 走真实 HTTP：状态、注册、心跳、今日推荐、打招呼与冷却、串门与访客。
 * 会**真实写入数据并留下两个测试账号**，所以只用于刚部署好的空库验收，
 * 不要对着生产库跑。
 *
 * 不传地址时报错退出 —— 避免误打到内置域名。
 */
const BASE = (process.argv[2] || "").replace(/\/+$/, "");
if (!BASE) {
  console.error("用法：node scripts/test-remote.mjs <服务地址>");
  console.error("示例：node scripts/test-remote.mjs http://119.45.169.217:8787");
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const ok = (c, m) => {
  if (!c) failed++;
  console.log(`${c ? "PASS" : "FAIL"}  ${m}`);
};

async function call(method, path, body, token) {
  const h = { "Content-Type": "application/json" };
  if (token) h.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let json = {};
  try {
    json = await res.json();
  } catch {
    /* 非 JSON 响应按空对象处理 */
  }
  return { status: res.status, json };
}

console.log(`验收目标：${BASE}\n`);

const st = await call("GET", "/api/status");
ok(st.status === 200 && st.json.ok === true, `/api/status：${st.status} ${JSON.stringify(st.json)}`);

const a = await call("POST", "/api/register", {
  account: "pet_rcheck1", password: "Abcdef12", nick: "验收_a1b2c3", invite_code: "PET888",
});
ok(a.status === 200 && !!a.json.uid, `注册 A：${a.json.uid ?? JSON.stringify(a.json)}`);

// 注册 / 登录 / admin 登录共享「同 IP 10 秒一次」的限频，两次注册要错开
await sleep(11000);

const b = await call("POST", "/api/register", {
  account: "pet_rcheck2", password: "Abcdef12", nick: "验收_d4e5f6", invite_code: "PET888",
});
ok(!!b.json.uid, `公共码可重复使用（注册 B）：${b.json.uid ?? JSON.stringify(b.json)}`);

if (!a.json.uid || !b.json.uid) {
  console.log("\n注册没成功，后续跳过。检查服务端日志，或确认这是一张空库");
  process.exit(1);
}

await call("POST", "/api/heartbeat", { state: "idle", affinity: 0, pet_name: "甲崽" }, a.json.token);
await call("POST", "/api/heartbeat", { state: "coding", affinity: 0, pet_name: "乙崽" }, b.json.token);

const r = await call("POST", "/api/online/random", {}, a.json.token);
const uids = (r.json.users ?? []).map((u) => u.uid);
ok(r.status === 200 && Array.isArray(r.json.users), `online/random：${r.status}`);
ok(!uids.includes(a.json.uid), "推荐不含自己");
ok(uids.includes(b.json.uid), `推荐含在线的 B：${uids}`);

const g = await call("POST", "/api/greet", { target: b.json.uid, line: "（挥了挥爪子）" }, a.json.token);
ok(g.status === 200 && g.json.ok, `打招呼：${JSON.stringify(g.json)}`);

const g2 = await call("POST", "/api/greet", { target: b.json.uid }, a.json.token);
ok("error" in g2.json && g2.json.cooldown_secs > 0, `60 秒冷却：${g2.json.error} / ${g2.json.cooldown_secs}s`);

const hb = await call("POST", "/api/heartbeat", { state: "coding", affinity: 0, pet_name: "乙崽" }, b.json.token);
const evt = (hb.json.events ?? []).find((e) => e.event?.type === "greet");
ok(!!evt, "B 心跳拉到 greet 事件");
ok(evt?.event.line === "（挥了挥爪子）", `话术原样中转：${evt?.event.line}`);
ok(evt ? !("mood" in evt.event) : true, "事件里不含心情字段（隐私红线）");

const v = await call("POST", "/api/visit", { target: b.json.uid }, a.json.token);
ok(v.status === 200 && v.json.ok, `串门：${JSON.stringify(v.json)}`);

const hb2 = await call("POST", "/api/heartbeat", { state: "coding", affinity: 0, pet_name: "乙崽" }, b.json.token);
ok(
  (hb2.json.visitors ?? []).some((x) => x.uid === a.json.uid),
  `B 家出现访客 A：${hb2.json.visitors?.length} 位`,
);

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
