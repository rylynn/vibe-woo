/**
 * 同步服务（lib-account.js）端到端自检 —— 用内存 store 跑完整链路。
 *
 * 用法：node scripts/test-sync.mjs
 * 退出码非 0 表示有断言失败。
 *
 * 覆盖：公共邀请码注册、个人邀请码一次性、宠物名长度与注入/XSS 拦截、
 *       心跳**不**写心情（隐私红线）、今日在线推荐（确定性 + 过滤规则）、
 *       打招呼冷却、greet 事件只中转话术文本、串门候选放宽、
 *       隐身用户不进推荐池也打不到招呼、访客进出、greeted_today 下发。
 */
import { webcrypto } from "node:crypto";

// Node 18 的 globalThis.crypto 需要兜底；EdgeOne/浏览器环境本身就有
globalThis.crypto ??= webcrypto;

const { dispatch } = await import(
  "../worker-edgeone/edge-functions/api/lib-account.js"
);

function memStore() {
  const m = new Map();
  return {
    get: async (k) => (m.has(k) ? m.get(k) : null),
    put: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
}

const store = memStore();
let ipSeq = 0; // 每次请求换 IP，避开 10 秒注册限频
let failed = 0;

async function call(method, path, body = {}, auth = "") {
  return dispatch(
    store,
    method,
    path.split("/").filter(Boolean),
    new URLSearchParams(),
    body,
    {},
    { ip: `ip-${ipSeq++}`, auth: auth ? `Bearer ${auth}` : "" },
  );
}

function ok(cond, msg) {
  if (!cond) failed++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`);
}

// ---------- 注册 ----------

const a = await call("POST", "register", {
  account: "pet_a1b2c3", password: "Abcdef12", nick: "宠物_a1b2c3", invite_code: "PET888",
});
ok(!!a.uid, `公共码注册 A：${a.uid ?? JSON.stringify(a)}`);

const b = await call("POST", "register", {
  account: "pet_d4e5f6", password: "Abcdef12", nick: "宠物_d4e5f6", invite_code: "PET888",
});
ok(!!b.uid, `公共码可重复使用（注册 B）：${b.uid ?? JSON.stringify(b)}`);

const own = await call("POST", "register", {
  account: "pet_c7d8e9", password: "Abcdef12", nick: "宠物_c7d8e9", invite_code: "PET888",
});
ok(!!own.uid, "A/B 之外第三个用户也能用公共码注册");

const c = await call("POST", "register", {
  account: "pet_f0a1b2", password: "Abcdef12", nick: "宠物_f0a1b2", invite_code: own.invite_code,
});
ok(!!c.uid, `个人邀请码首次可用：${c.uid ?? JSON.stringify(c)}`);

const c2 = await call("POST", "register", {
  account: "pet_112233", password: "Abcdef12", nick: "宠物_112233", invite_code: own.invite_code,
});
ok(c2.error === "邀请码已被使用", `个人邀请码第二次被拒：${c2.error}`);

// ---------- 宠物名校验 ----------

const n30 = await call("POST", "profile/pet-name", { pet_name: "小".repeat(30) }, a.token);
ok(n30.pet_name && [...n30.pet_name].length === 30, `30 字宠物名通过：${n30.error ?? "ok"}`);
const n31 = await call("POST", "profile/pet-name", { pet_name: "小".repeat(31) }, a.token);
ok(!!n31.error, `31 字宠物名被拒：${n31.error}`);

for (const [label, bad] of [
  ["SQL 注入", "'; DROP TABLE users--"],
  ["脚本标签", "<script>alert(1)</script>"],
  ["尖括号", "<img onerror=1>"],
]) {
  const r = await call("POST", "profile/pet-name", { pet_name: bad }, a.token);
  ok(!!r.error, `${label}式宠物名被拒：${r.error}`);
}
// 控制字符不是被拒绝，而是被 clean() 剥掉后正常入库
const cc = await call("POST", "profile/pet-name", { pet_name: `ab${String.fromCharCode(7)}c` }, a.token);
ok(cc.pet_name === "abc", `控制字符被清洗而非报错：${JSON.stringify(cc.pet_name ?? cc.error)}`);
await call("POST", "profile/pet-name", { pet_name: "小一" }, a.token);

// ---------- 心跳与在线池 ----------

await call("POST", "heartbeat", { state: "idle", affinity: 0, pet_name: "小一" }, a.token);
await call("POST", "heartbeat", { state: "coding", affinity: 0, pet_name: "小二" }, b.token);
const hbA = JSON.parse(await store.get(`hb_${a.uid}`));
ok(!("mood" in hbA), "心跳不写入心情（隐私红线：mood 不出本机）");
ok((await store.get(`hb_${c.uid}`)) === null, "从未心跳的用户不在在线池");

// ---------- 今日在线推荐 ----------

const r1 = await call("POST", "online/random", {}, a.token);
const r2 = await call("POST", "online/random", {}, a.token);
ok(!r1.users.some((u) => u.uid === a.uid), "推荐不含自己");
ok(r1.users.some((u) => u.uid === b.uid), "推荐含在线的 B");
ok(!r1.users.some((u) => u.uid === c.uid), "推荐不含离线的 C");
ok(r1.users.length >= 0 && r1.users.length <= 5, `推荐人数 ≤5：${r1.users.length}`);
ok(JSON.stringify(r1.users) === JSON.stringify(r2.users), "同一天两次调用名单稳定");
ok(/^\d{4}-\d{2}-\d{2}$/.test(String(r1.date)), `返回日期键：${r1.date}`);

// ---------- 打招呼 ----------

const gOff = await call("POST", "greet", { target: c.uid }, b.token);
ok(gOff.error === "对方已经不在了", `不能跟离线用户打招呼：${gOff.error}`);
const g1 = await call("POST", "greet", { target: b.uid, line: "（摇着尾巴跑过来）" }, a.token);
ok(!!g1.ok, `A 向 B 打招呼（带话术）：${JSON.stringify(g1)}`);
const g2 = await call("POST", "greet", { target: b.uid }, a.token);
ok(!!g2.error && g2.cooldown_secs > 0, `立刻再打被冷却：${g2.error} / ${g2.cooldown_secs}s`);
const gSelf = await call("POST", "greet", { target: a.uid }, a.token);
ok(!!gSelf.error, `不能跟自己打招呼：${gSelf.error}`);

// ---------- 事件 ----------

const beat = await call(
  "POST", "heartbeat",
  { state: "coding", affinity: 0, pet_name: "小二" }, b.token,
);
const evt = (beat.events || []).find((e) => e.event.type === "greet");
ok(!!evt, "B 的心跳拉到 greet 事件");
ok(evt?.event.line === "（摇着尾巴跑过来）", `事件原样中转话术：${evt?.event?.line}`);
ok(evt?.event.from_nick === "宠物_a1b2c3", `事件携带昵称：${evt?.event?.from_nick}`);
ok(JSON.stringify(evt ?? "").length <= 512, "事件体积在 512 字节上限内");

// 恶意话术与超长话术：各用一个全新用户（招呼有 60 秒冷却，不能复用同一人）
async function newUser(account, nick, petName) {
  const u = await call("POST", "register", {
    account, password: "Abcdef12", nick, invite_code: "PET888",
  });
  await call("POST", "heartbeat", { state: "idle", affinity: 0, pet_name: petName }, u.token);
  return u;
}
const d = await newUser("pet_9a8b7c", "宠物_9a8b7c", "小四");
const e = await newUser("pet_6d5e4f", "宠物_6d5e4f", "小五");
await call("POST", "greet", { target: b.uid, line: "喵".repeat(200) }, d.token);
await call("POST", "greet", { target: b.uid, line: "<script>alert(1)</script>" }, e.token);

const beat2 = await call(
  "POST", "heartbeat", { state: "coding", affinity: 0, pet_name: "小二" }, b.token,
);
const evts2 = beat2.events || [];
const longEvt = evts2.find((x) => x.event.from_uid === d.uid);
const malEvt = evts2.find((x) => x.event.from_uid === e.uid);
ok([...(longEvt?.event?.line ?? "")].length === 40, `超长话术截断到 40 字：${[...(longEvt?.event?.line ?? "")].length}`);
ok(malEvt?.event.line === "（挥了挥爪子）", `恶意话术被兜底：${JSON.stringify(malEvt?.event?.line)}`);

// 隐身：不进推荐池、打不到招呼、也去不了串门
const h = await newUser("pet_3c4d5e", "宠物_3c4d5e", "小七");
await call("POST", "heartbeat", { state: "idle", affinity: 0, pet_name: "小七", hidden: true }, h.token);
const rHidden = await call("POST", "online/random", {}, a.token);
ok(!rHidden.users.some((u) => u.uid === h.uid), "隐身用户不进推荐池");
// 用一个没进冷却的新用户去打招呼（A 此刻还在冷却里）
const i = await newUser("pet_7f8g9h", "宠物_7f8g9h", "小八");
const gHidden = await call("POST", "greet", { target: h.uid }, i.token);
ok(gHidden.error === "对方现在不想被打扰", `打不到隐身的人：${gHidden.error}`);
// 串门要先成为好友 —— 打招呼这条路对隐身的人是封的
await call("POST", "friends/add", { target: h.uid }, a.token);
const vHidden = await call("POST", "visit", { target: h.uid }, a.token);
ok(vHidden.error === "对方现在不想被打扰", `去不了隐身的人家：${vHidden.error}`);

// ---------- 串门 ----------

const v1 = await call("POST", "visit", { target: b.uid }, a.token);
ok(!!v1.ok, `打过招呼后可串门：${JSON.stringify(v1)}`);
const v2 = await call("POST", "visit", { target: c.uid }, a.token);
ok(!!v2.error, `非好友且没打过招呼被拒：${v2.error}`);
const vb = await call(
  "POST", "heartbeat",
  { state: "idle", affinity: 0, pet_name: "小二" }, b.token,
);
ok(vb.visitors.length === 1 && vb.visitors[0].uid === a.uid, `B 家出现访客 A：${vb.visitors.length} 位`);

const beatA = await call(
  "POST", "heartbeat",
  { state: "idle", affinity: 0, pet_name: "小一" }, a.token,
);
ok(
  Array.isArray(beatA.greeted_today) && beatA.greeted_today.some((u) => u.uid === b.uid),
  `greeted_today 下发在线候选人：${JSON.stringify(beatA.greeted_today)}`,
);

await call("POST", "home", { target: b.uid }, a.token);
const vb2 = await call(
  "POST", "heartbeat",
  { state: "idle", affinity: 0, pet_name: "小二" }, b.token,
);
ok(vb2.visitors.length === 0, "回家后对方家访客清空");

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
