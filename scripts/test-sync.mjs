/**
 * 同步服务（lib-account.js）端到端自检 —— 用内存 store 跑完整链路。
 *
 * 用法：node scripts/test-sync.mjs
 * 退出码非 0 表示有断言失败。
 *
 * 覆盖：公共邀请码注册、个人邀请码一次性、宠物名长度与注入/XSS 拦截、
 *       心跳**不**写心情（隐私红线）、今日在线推荐（确定性 + 过滤规则）、
 *       打招呼冷却、greet 事件只中转话术文本、串门候选放宽、
 *       隐身用户不进推荐池也打不到招呼、访客进出、greeted_today 下发、
 *       好友申请流（搜索/申请/接受/拒绝 + 收件箱过期）、
 *       按好友亲密度与碰一碰（60 秒限流 + bump 事件 + 旧 friends 数据兼容）。
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

async function call(method, path, body = {}, auth = "", opts = {}) {
  return dispatch(
    store,
    method,
    path.split("/").filter(Boolean),
    new URLSearchParams(opts.query || ""),
    body,
    opts.env || {},
    { ip: `ip-${ipSeq++}`, auth: auth ? `Bearer ${auth}` : "", url: opts.url || "" },
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
// 老的直加路径已升级为申请语义 —— 与隐身者 H 成为好友需走申请+接受
await call("POST", "friends/request", { target: h.uid }, a.token);
await call("POST", "friends/accept", { target: a.uid }, h.token);
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

// ---------- 好友申请流 ----------
const sHit = await call("POST", "friends/search", { target: b.uid }, a.token);
ok(sHit.uid === b.uid && sHit.pet_name === "小二", `搜索命中：${JSON.stringify(sHit)}`);
ok(!("state" in sHit) && !("affinity" in sHit) && !("online" in sHit), "搜索卡片不带在线状态/亲密度");
const sNick = await call("POST", "friends/search", { target: "宠物_d4e5f6" }, a.token);
ok(sNick.uid === b.uid, "昵称精确搜索命中");
const sMiss = await call("POST", "friends/search", { target: "99999999" }, a.token);
ok(!!sMiss.error, `搜索未命中报错：${sMiss.error}`);

const j = await newUser("pet_j1k2l3", "宠物_j1k2l3", "小九");
const qSelf = await call("POST", "friends/request", { target: j.uid }, j.token);
ok(!!qSelf.error, `不能申请加自己：${qSelf.error}`);
const q1 = await call("POST", "friends/request", { target: b.uid }, j.token);
ok(!!q1.ok && q1.pending === true, `发申请：${JSON.stringify(q1)}`);
const qDup = await call("POST", "friends/request", { target: b.uid }, j.token);
ok(!!qDup.error, `重复申请被拒：${qDup.error}`);
const qAlready = await call("POST", "friends/request", { target: h.uid }, a.token);
ok(!!qAlready.error, `已是好友再申请被拒：${qAlready.error}`);

const beatB1 = await call("POST", "heartbeat", { state: "idle", affinity: 0, pet_name: "小二" }, b.token);
ok(Array.isArray(beatB1.requests) && beatB1.requests.some((r) => r.uid === j.uid), `心跳带下申请：${JSON.stringify(beatB1.requests)}`);
ok((beatB1.events || []).some((e) => e.event.type === "freq"), "收到 freq 事件");

const rej = await call("POST", "friends/reject", { target: j.uid }, b.token);
ok(!!rej.ok, "拒绝申请");
const qAgain = await call("POST", "friends/request", { target: b.uid }, j.token);
ok(!!qAgain.ok, "被拒后可再次申请");

const accOther = await call("POST", "friends/accept", { target: j.uid }, a.token);
ok(!!accOther.error, "不是自己的申请不能接受");
const acc = await call("POST", "friends/accept", { target: j.uid }, b.token);
ok(!!acc.ok, "接受申请");
const acc2 = await call("POST", "friends/accept", { target: j.uid }, b.token);
ok(!!acc2.error, "重复接受幂等拒绝");
const frJ = await call("GET", "friends", {}, j.token);
ok(Array.isArray(frJ.friends) && frJ.friends.some((f) => f.uid === b.uid), `接受后双向可见：${JSON.stringify(frJ.friends?.map((f) => f.uid))}`);
const beatJ1 = await call("POST", "heartbeat", { state: "idle", affinity: 0, pet_name: "小九" }, j.token);
ok((beatJ1.events || []).some((e) => e.event.type === "accept"), "申请方收到 accept 事件");

// 老接口语义升级：/friends/add 走申请
const qOld = await call("POST", "friends/add", { target: a.uid }, j.token);
ok(!!qOld.pending, `老 /friends/add 返回 pending：${JSON.stringify(qOld)}`);

// ---------- 按好友亲密度与碰一碰 ----------
const frB2 = await call("GET", "friends", {}, b.token);
const affJ = frB2.friends.find((f) => f.uid === j.uid);
ok(affJ.affinity === 5, `接受申请双方 +5：${affJ.affinity}`);
await call("POST", "greet", { target: b.uid, line: "（小跑过来）" }, j.token);
const frB3 = await call("GET", "friends", {}, b.token);
ok(frB3.friends.find((f) => f.uid === j.uid).affinity === 6, "打招呼 +1");
await call("POST", "visit", { target: b.uid }, j.token);
const frB4 = await call("GET", "friends", {}, b.token);
ok(frB4.friends.find((f) => f.uid === j.uid).affinity === 8, "串门 +2");
// j 先回家再测碰一碰：上一步串门把 j 留在了 B 的访客名单里（15 分钟才过期），
// 不清掉的话「碰一碰不进访客名单」这条断言验的就不是 bump 而是上一步的串门。
await call("POST", "home", { target: b.uid }, j.token);

const bp1 = await call("POST", "friends/bump", { target: b.uid }, j.token);
ok(!!bp1.ok, `碰一碰：${JSON.stringify(bp1)}`);
const bp2 = await call("POST", "friends/bump", { target: b.uid }, j.token);
ok(!!bp2.error && bp2.retry_after > 0 && bp2.retry_after <= 60, `60 秒内第二次限流：${bp2.error}/${bp2.retry_after}s`);
const bpSelf = await call("POST", "friends/bump", { target: j.uid }, j.token);
ok(!!bpSelf.error, "不能碰自己");
const bpNotFriend = await call("POST", "friends/bump", { target: h.uid }, d.token);
ok(!!bpNotFriend.error, `非好友不能碰：${bpNotFriend.error}`);
const bpOther = await call("POST", "friends/bump", { target: h.uid }, a.token);
ok(!!bpOther.ok, "不同好友的限流相互独立");
const beatB5 = await call("POST", "heartbeat", { state: "idle", affinity: 0, pet_name: "小二" }, b.token);
ok((beatB5.events || []).some((e) => e.event.type === "bump"), "对方收到 bump 事件");
ok(!beatB5.visitors.some((v) => v.uid === j.uid), "碰一碰不进访客名单");
const frB6 = await call("GET", "friends", {}, b.token);
ok(frB6.friends.find((f) => f.uid === j.uid).affinity === 10, "碰一碰 +2");

// 旧数据兼容：手工写一条无 aff 字段的好友条目
await store.put(`friends_${c.uid}`, JSON.stringify([{ uid: a.uid, at: Date.now() }]));
const frC = await call("GET", "friends", {}, c.token);
ok(frC.friends[0].affinity === 0, "旧 friends 数据无 aff 字段默认 0");

// ---------- 更新镜像（GitHub Releases 的分发镜像） ----------

const bytesEq = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
const ADMIN_ENV = { ADMIN_USER: "op", ADMIN_PASS: "s3cret-pass" };
const manifestOf = (v) => ({
  version: v,
  pub_date: "2026-09-20T00:00:00Z",
  platforms: {
    "darwin-aarch64": { signature: `sig-${v}-arm`, url: "https://github.com/rylynn/vibe-woo/releases/latest/download/vibe-pet.app.tar.gz" },
    "darwin-x86_64": { signature: `sig-${v}-x64`, url: "https://github.com/rylynn/vibe-woo/releases/latest/download/vibe-pet.app.tar.gz" },
  },
});
// 假更新包：超过 1KB 下限即可（真实包 13MB，字节数一致性逻辑与此无关）
const fakePkg = new Uint8Array(2048);
for (let i = 0; i < fakePkg.length; i++) fakePkg[i] = (i * 7) % 251;
const LATEST_URL = { url: "http://x.test/api/update/latest" };

// 未发布：latest 与 pkg 都必须 404（204 会被 updater 当「无更新」短路，跳过 GitHub 兜底）
const u0 = await call("GET", "update/latest", {}, "", LATEST_URL);
ok(u0._status === 404, `未发布 latest 返回 404：${u0._status}`);
const p0 = await call("GET", "update/pkg", {}, "");
ok(p0._status === 404, `未发布 pkg 返回 404：${p0._status}`);

// admin 门：未配置 403；配置了但没 token 401
const admOff = await call("POST", "admin/update/pkg", { __bytes: fakePkg }, "", { query: "v=1.5.0" });
ok(admOff._status === 403, `admin 未配置时发布被拒 403：${admOff._status}`);
const admNoAuth = await call("POST", "admin/update/pkg", { __bytes: fakePkg }, "", { query: "v=1.5.0", env: ADMIN_ENV });
ok(admNoAuth._status === 401, `无 token 发布被拒 401：${admNoAuth._status}`);

// admin 登录 → 推包 → 发清单
const adm = await call("POST", "admin/login", { user: "op", pass: "s3cret-pass" }, "", { env: ADMIN_ENV });
ok(!!adm.token, `admin 登录：${adm.error ?? "ok"}`);

// 顺序纪律：包不存在时 manifest 必须被拒（下载阶段客户端不回退 endpoint）
const mEarly = await call("POST", "admin/update/manifest", manifestOf("1.4.0"), adm.token, { env: ADMIN_ENV });
ok(mEarly._status === 400 && mEarly.error.includes("先上传"), `先发 manifest 被拒：${mEarly.error}`);

// 缺字节 / 非法版本号
const pNoBytes = await call("POST", "admin/update/pkg", {}, adm.token, { query: "v=1.5.0", env: ADMIN_ENV });
ok(pNoBytes._status === 400, `缺字节的包被拒：${pNoBytes.error}`);
const pBadV = await call("POST", "admin/update/pkg", { __bytes: fakePkg }, adm.token, { query: "v=v1.5.0", env: ADMIN_ENV });
ok(pBadV._status === 400, `非三段数字版本被拒：${pBadV.error}`);

// 正序发布 1.5.0
const p1 = await call("POST", "admin/update/pkg", { __bytes: fakePkg }, adm.token, { query: "v=1.5.0", env: ADMIN_ENV });
ok(p1.ok === true && p1.size === fakePkg.length, `推包 1.5.0：${JSON.stringify(p1)}`);
const m1 = await call("POST", "admin/update/manifest", manifestOf("1.5.0"), adm.token, { env: ADMIN_ENV });
ok(m1.ok === true && m1.version === "1.5.0", `发清单 1.5.0：${JSON.stringify(m1)}`);

// latest：双平台下载地址都重写为本服务 pkg，且 no-store
const l1 = await call("GET", "update/latest", {}, "", LATEST_URL);
const l1m = JSON.parse(l1.__raw);
ok(l1m.version === "1.5.0", `latest 版本正确：${l1m.version}`);
ok(
  Object.values(l1m.platforms).every((p) => p.url === "http://x.test/api/update/pkg?v=1.5.0"),
  `双平台 url 重写为本服务：${JSON.stringify(Object.values(l1m.platforms).map((p) => p.url))}`,
);
ok(l1.__rawHeaders["Cache-Control"] === "no-store", "latest 响应 no-store（URL 无版本参数，缓存必错）");
ok(l1m.platforms["darwin-aarch64"].signature === "sig-1.5.0-arm", "signature 原样透传（验签靠它）");

// pkg 回读：带 v 与缺省 v（取 manifest 版本）字节逐一致
const pkg1 = await call("GET", "update/pkg", {}, "", { query: "v=1.5.0" });
ok(bytesEq(pkg1.__raw, fakePkg), "pkg 字节与推送逐字节一致（?v= 指定）");
const pkg2 = await call("GET", "update/pkg", {}, "");
ok(bytesEq(pkg2.__raw, fakePkg), "pkg 字节一致（缺省 v 取当前 manifest 版本）");
ok(pkg2.__rawHeaders["Cache-Control"] === "public, max-age=3600", "pkg 响应可缓存（?v= 天然版本化）");

// 非法 manifest 形状
for (const [label, bad] of [
  ["缺 version", { platforms: manifestOf("1.5.0").platforms }],
  ["非 semver", { ...manifestOf("x.y.z") }],
  ["platforms 空", { ...manifestOf("1.5.0"), platforms: {} }],
  ["缺 signature", { ...manifestOf("1.5.0"), platforms: { "darwin-aarch64": { url: "https://a/b.tar.gz" } } }],
  ["url 非 http", { ...manifestOf("1.5.0"), platforms: { "darwin-aarch64": { url: "ftp://a/b", signature: "s" } } }],
]) {
  const r = await call("POST", "admin/update/manifest", bad, adm.token, { env: ADMIN_ENV });
  ok(r._status === 400, `非法 manifest（${label}）被拒：${r.error}`);
}

// 版本只进不退：1.5.0 在库时发 1.4.0（先补包再发单，顺序纪律不破）
await call("POST", "admin/update/pkg", { __bytes: fakePkg }, adm.token, { query: "v=1.4.0", env: ADMIN_ENV });
const mRoll = await call("POST", "admin/update/manifest", manifestOf("1.4.0"), adm.token, { env: ADMIN_ENV });
ok(mRoll._status === 400 && mRoll.error.includes("只进不退"), `版本回退被拒：${mRoll.error}`);

// 数字比较：1.10.0 > 1.9.0（字符串比较会判反）
await call("POST", "admin/update/pkg", { __bytes: fakePkg }, adm.token, { query: "v=1.10.0", env: ADMIN_ENV });
const mUp = await call("POST", "admin/update/manifest", manifestOf("1.10.0"), adm.token, { env: ADMIN_ENV });
ok(mUp.ok === true, `1.10.0 顺利升级（数字比较）：${JSON.stringify(mUp)}`);
ok((await store.get("upd_pkg_1_5_0", { binary: true })) === null, "旧版本包键被清理");
ok((await store.get("upd_pkg_1_10_0", { binary: true })) !== null, "新版本包键在库");

// force=1 回退放行（修复错发用）
await call("POST", "admin/update/pkg", { __bytes: fakePkg }, adm.token, { query: "v=1.9.0", env: ADMIN_ENV });
const mForce = await call("POST", "admin/update/manifest", manifestOf("1.9.0"), adm.token, { env: ADMIN_ENV, query: "force=1" });
ok(mForce.ok === true, `force=1 回退放行：${JSON.stringify(mForce)}`);
ok((await store.get("upd_pkg_1_10_0", { binary: true })) === null, "回退后清理 1.10.0 包键");

// 损坏 manifest → latest 404（客户端回退 GitHub 的设计内行为）
await store.put("upd_manifest", "not json");
const lBad = await call("GET", "update/latest", {}, "", LATEST_URL);
ok(lBad._status === 404, `损坏 manifest 返回 404：${lBad._status}`);

// ---------- 今日在线：含好友的总览（is_friend） ----------

// 全新用户段：前面 a/b/j 等已有复杂好友关系，复用会把断言搅浑
const ovHost = await newUser("pet_ovhost", "宠物_ovhost", "总览崽");
const ovP = await newUser("pet_ovp111", "宠物_ovp111", "总览P");
const ovQ = await newUser("pet_ovq222", "宠物_ovq222", "总览Q");
const ovR = await newUser("pet_ovr333", "宠物_ovr333", "总览R");
const ovS = await newUser("pet_ovs444", "宠物_ovs444", "总览S");
const ovT = await newUser("pet_ovt555", "宠物_ovt555", "总览T");
// 好友关系手工写（申请流前面已覆盖；这里要精确控制 aff 排序）。
// 先只写 ovHost 一侧 —— addAffinity 的双向断言在 Task 2 再补对侧。
await store.put(`friends_${ovHost.uid}`, JSON.stringify([
  { uid: ovP.uid, at: Date.now(), aff: 10 },
  { uid: ovQ.uid, at: Date.now(), aff: 90 },
  { uid: ovR.uid, at: Date.now(), aff: 50 },
  { uid: ovS.uid, at: Date.now(), aff: 70 },
  { uid: ovT.uid, at: Date.now(), aff: 30 },
]));
// Q 下线（心跳拨到 9 分钟前，超过 8 分钟阈值）、R 隐身 —— 都不该出现在总览里
const hbOvQ = JSON.parse(await store.get(`hb_${ovQ.uid}`));
hbOvQ.last_seen = Date.now() - 9 * 60 * 1000;
await store.put(`hb_${ovQ.uid}`, JSON.stringify(hbOvQ));
const hbOvR = JSON.parse(await store.get(`hb_${ovR.uid}`));
hbOvR.hidden = true;
await store.put(`hb_${ovR.uid}`, JSON.stringify(hbOvR));

const ov = await call("POST", "online/random", {}, ovHost.token);
ok(Array.isArray(ov.users), "在线总览返回数组");
const fr = ov.users.filter((u) => u.is_friend === true);
ok(fr.length === 3, `在线好友封顶 3（P/S/T 在线，Q 离线 R 隐身不算）：${fr.length}`);
ok(
  fr.map((u) => u.uid).join(",") === [ovS.uid, ovT.uid, ovP.uid].join(","),
  `好友按 aff 降序（70/30/10）：${fr.map((u) => u.uid).join(",")}`,
);
ok(!ov.users.some((u) => u.uid === ovQ.uid), "离线好友不在总览");
ok(!ov.users.some((u) => u.uid === ovR.uid), "隐身好友不在总览");
ok(!ov.users.some((u) => u.uid === ovHost.uid), "总览不含自己");
const strangers = ov.users.filter((u) => u.is_friend !== true);
ok(
  !strangers.some((u) => [ovP.uid, ovS.uid, ovT.uid, ovQ.uid, ovR.uid].includes(u.uid)),
  "好友不重复出现在陌生人段",
);
ok(
  ov.users.slice(0, fr.length).every((u) => u.is_friend === true),
  "好友排在陌生人之前",
);

// ---------- 摸摸（visit/interact）与 leave 事件昵称 ----------

// addAffinity 双向累加：Task 1 只写了 ovHost 一侧，这里补 ovP 对侧
await store.put(`friends_${ovP.uid}`, JSON.stringify([{ uid: ovHost.uid, at: Date.now(), aff: 10 }]));

// ovP 去 ovHost 家做客（两人已是好友，visit 直接放行；visit 自带 addAffinity +2）
const ovVisit = await call("POST", "visit", { target: ovHost.uid }, ovP.token);
ok(!!ovVisit.ok, `好友来访放行：${JSON.stringify(ovVisit)}`);

// 摸的不是自家客人 → 拒（防匿名遍历：只能摸自己家的访客）
const patStranger = await call("POST", "visit/interact", { target: ovS.uid }, ovHost.token);
ok(patStranger.error === "TA 不在你家做客", `不在家的不能摸：${patStranger.error}`);
const patSelf = await call("POST", "visit/interact", { target: ovHost.uid }, ovHost.token);
ok(!!patSelf.error, `不能摸自己：${patSelf.error}`);

// 三下成功、计数递增、双方亲密度 +1/下
for (let i = 1; i <= 3; i++) {
  const r = await call("POST", "visit/interact", { target: ovP.uid }, ovHost.token);
  ok(r.ok === true && r.pats === i, `第 ${i} 下：${JSON.stringify(r)}`);
}
const frOvHost = await call("GET", "friends", {}, ovHost.token);
ok(
  frOvHost.friends.find((f) => f.uid === ovP.uid).affinity === 15,
  `10 + 串门2 + 摸3 = 15：${frOvHost.friends.find((f) => f.uid === ovP.uid).affinity}`,
);
// 第四下被拒
const pat4 = await call("POST", "visit/interact", { target: ovP.uid }, ovHost.token);
ok(pat4.error === "摸够啦", `第四下被拒：${pat4.error}`);

// 出门方（ovP）心跳拉到递增的 interaction 事件
const ovPBeat = await call("POST", "heartbeat", { state: "idle", affinity: 0, pet_name: "总览P" }, ovP.token);
const patsList = (ovPBeat.events || [])
  .filter((x) => x.event.type === "interaction")
  .map((x) => x.event.pats);
ok(
  JSON.stringify(patsList) === "[1,2,3]",
  `出门方收到递增摸摸事件：${JSON.stringify(patsList)}`,
);
ok(
  (ovPBeat.events || []).every((x) => JSON.stringify(x).length <= 512),
  "事件体积在 512 字节上限内",
);

// 访客条目过期后（拨 at 到 16 分钟前）不能再摸
const visRow = JSON.parse(await store.get(`visitors_${ovHost.uid}`));
visRow[0].at = Date.now() - 16 * 60 * 1000;
await store.put(`visitors_${ovHost.uid}`, JSON.stringify(visRow));
const patExpired = await call("POST", "visit/interact", { target: ovP.uid }, ovHost.token);
ok(patExpired.error === "TA 不在你家做客", `过期条目不能摸：${patExpired.error}`);

// goHome 推的 leave 事件必须带昵称（原来 from_nick 是空串）
await call("POST", "visit", { target: ovHost.uid }, ovP.token); // 重新进门
await call("POST", "home", { target: ovHost.uid }, ovP.token);
const ovHostBeat = await call("POST", "heartbeat", { state: "idle", affinity: 0, pet_name: "总览崽" }, ovHost.token);
const leaveEvt = (ovHostBeat.events || []).find((x) => x.event.type === "leave");
ok(
  leaveEvt && leaveEvt.event.from_nick === "宠物_ovp111",
  `leave 事件带昵称：${JSON.stringify(leaveEvt?.event)}`,
);

console.log(failed === 0 ? "\n全部通过" : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
