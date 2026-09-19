# 好友功能优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 好友改为申请制双向关系（搜索→申请→接受）、操作结果弹窗提醒、好友「碰一碰」快闪互动（1 次/分钟双端限流）、自动串门按关系亲密度加权选目标并展示进行中状态。

**Architecture:** 关系数据全部服务端化（`lib-account.js` 是两套部署共用的唯一真源）：申请收件箱 `freq_<uid>`、碰一碰限流 `bump_<uid>_<dst>` 时间戳键、按好友亲密度存进 `friends_<uid>` 条目。Rust 侧 `socialdrive` 负责事件转发、出门状态机（串门/碰一碰两种 kind）与本地限流；前端复用现有 Bubble/Banner，新增碰一碰快闪动画与出门倒计时。

**Tech Stack:** Rust（tauri 2 / reqwest / serde）、TypeScript（无框架，DOM 直操作，Canvas 像素渲染）、Node 脚本自检（内存 store 直调 dispatch）。

**设计文档:** `docs/superpowers/specs/2026-09-19-friends-optimization-design.md`（改动前先读一遍）

## Global Constraints

- 注释、commit message、文档全部中文；commit 用 conventional 风格（如 `feat(social): …`），与仓库近期提交一致。
- 隐私红线：`share.rs` 心跳上报结构零改动；搜索卡片只回 `{uid, nick, pet_name}`；事件 payload 白名单字段；日志不记 uid 以外的标识、不记原文。
- 服务端只有 KV `get/put/delete`（无 TTL/CAS/DO）：一切过期用「存时间戳、读时判断」，限流竞态窗口接受。
- 两套部署共用 `worker-edgeone/edge-functions/api/lib-account.js`：业务逻辑只写这一份，绝不复制到 `worker/src/index.js`。
- 版本号（最终合入时）：当前 1.2.1，本计划按 **1.3.0**（加功能 = minor）执行，需与用户确认后落 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json` 三处，最终 commit message 带 `版本: 1.3.0`。
- 每个任务完成后的合入检查：改 JS → `node scripts/test-sync.mjs`；改 Rust → `cd src-tauri && cargo test`；改前端 → `npx tsc --noEmit` + `npx vitest run`。
- cargo 不在默认 PATH：先 `export PATH="$HOME/.cargo/bin:$PATH"`。

---

### Task 1: 服务端 · 好友申请流

**Files:**
- Modify: `worker-edgeone/edge-functions/api/lib-account.js`
- Test: `scripts/test-sync.mjs`

**Interfaces:**
- Consumes: 现有 `resolveTarget` / `friendList` / `pushEvent` / `cpSlice` / `requireAuth`。
- Produces（后续任务依赖的契约）:
  - `POST /friends/search` `{target}` → `{uid, nick, pet_name}`（只有三字段）或 `{error}`
  - `POST /friends/request` `{target}` → `{ok: true, pending: true}` 或 `{error}`（错误文案：「你们已经是好友了」「已经申请过啦，等对方处理」「不能加自己」）
  - `POST /friends/accept` `{target: 对方uid}` → `{ok: true}` 或 `{error: "申请不存在或已处理"}`
  - `POST /friends/reject` `{target: 对方uid}` → `{ok: true}` 或同上
  - `POST /friends/add`（老客户端）→ 等价 `/friends/request`
  - `GET /friends` → `{friends: [...], requests: [{uid, nick, pet_name}]}`（原来是裸数组，改为对象）
  - 心跳响应新增 `requests` 字段；事件类型新增 `freq`
  - KV 新键 `freq_<uid>` = `[{from, at}]`，上限 20，读时过滤 7 天过期

- [ ] **Step 1: 写失败的测试**

在 `scripts/test-sync.mjs` 中，先把第 172 行附近隐身测试里的直加好友（`await call("POST", "friends/add", { target: h.uid }, a.token);`）替换为申请流（老接口语义升级后直加不再存在）：

```js
// 老的直加路径已升级为申请语义 —— 与隐身者 H 成为好友需走申请+接受
await call("POST", "friends/request", { target: h.uid }, a.token);
await call("POST", "friends/accept", { target: a.uid }, h.token);
```

然后在文件末尾 `console.log(failed === 0 ? …)` 之前追加新测试段：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-sync.mjs`
Expected: FAIL 多项（`friends/search` 等路由 404 / `friends/add` 仍返回直加结果 / 心跳无 requests）。退出码非 0。

- [ ] **Step 3: 实现 lib-account.js**

3a. 常量区（`PUBLIC_INVITE` 之后）加：

```js
/** 好友申请收件箱上限与过期。 */
const MAX_REQUESTS = 20;
const REQUEST_EXPIRE_MS = 7 * 24 * 3600 * 1000;
```

3b. 文件头「KV 键一览」注释里 `friends_<uid>` 行之后加一行：

```js
 *   freq_<uid>        好友申请收件箱 [{from, at}]（≤20，7 天读时过期）
```

3c. 删除现有 `addFriend` 函数（`async function addFriend(...)` 整个），在 `removeFriend` 之后新增申请流四函数 + 收件箱视图：

```js
// ---------- 好友申请（加好友必须对方接受，服务端只有这一种语义） ----------

/** 申请收件箱：过滤 7 天过期条目（读时过期，无需清理任务）。 */
async function requestInbox(store, uid) {
  const list = JSON.parse((await store.get(`freq_${uid}`)) || "[]");
  const now = Date.now();
  return list.filter((r) => now - r.at < REQUEST_EXPIRE_MS);
}

/** 搜索：精确 uid / 昵称 → 只回三字段公开信息卡（不带在线状态与亲密度）。 */
async function searchUser(store, uid, bodyReq) {
  const target = await resolveTarget(store, bodyReq.target);
  if (!target) return { error: "找不到该用户（检查 uid 或昵称）" };
  if (target === uid) return { error: "这是你自己呀" };
  const u = JSON.parse(await store.get(`u_${target}`));
  return { uid: u.uid, nick: u.nick, pet_name: u.pet_name };
}

/** 发好友申请：写对方收件箱 + 推 freq 事件。同一发起方同时只能有一条 pending。 */
async function requestFriend(store, uid, bodyReq) {
  const target = await resolveTarget(store, bodyReq.target);
  if (!target) return { error: "找不到该用户（检查 uid 或昵称）" };
  if (target === uid) return { error: "不能加自己" };

  const mine = await friendList(store, uid);
  if (mine.some((f) => f.uid === target)) return { error: "你们已经是好友了" };
  const inbox = await requestInbox(store, target);
  if (inbox.some((r) => r.from === uid)) return { error: "已经申请过啦，等对方处理" };
  const theirs = await friendList(store, target);
  if (mine.length >= MAX_FRIENDS || theirs.length >= MAX_FRIENDS) {
    return { error: `好友数已达上限（${MAX_FRIENDS}）` };
  }

  inbox.push({ from: uid, at: Date.now() });
  while (inbox.length > MAX_REQUESTS) inbox.shift();
  await store.put(`freq_${target}`, JSON.stringify(inbox));

  const meUser = JSON.parse(await store.get(`u_${uid}`));
  await pushEvent(store, target, {
    type: "freq",
    from_uid: uid,
    from_nick: cpSlice(meUser.nick, 24),
    pet_name: cpSlice(meUser.pet_name, 16),
  });
  return { ok: true, pending: true };
}

/** 接受申请：双写好友关系（初始亲密度 5）+ 推 accept 事件。条目不存在则幂等拒绝。 */
async function acceptFriend(store, uid, bodyReq) {
  const target = clean(bodyReq.target);
  if (!validUid(target)) return { error: "申请不存在或已处理" };
  const inbox = await requestInbox(store, uid);
  if (!inbox.some((r) => r.from === target)) return { error: "申请不存在或已处理" };

  const mine = await friendList(store, uid);
  const theirs = await friendList(store, target);
  if (mine.some((f) => f.uid === target)) {
    // 已经是好友（比如双方互发申请后各自接受过）：只清收件箱，幂等成功
    await store.put(`freq_${uid}`, JSON.stringify(inbox.filter((r) => r.from !== target)));
    return { ok: true, note: "已经是好友" };
  }
  if (mine.length >= MAX_FRIENDS || theirs.length >= MAX_FRIENDS) {
    return { error: `好友数已达上限（${MAX_FRIENDS}）` };
  }

  const at = Date.now();
  mine.push({ uid: target, at, aff: 5 });
  theirs.push({ uid, at, aff: 5 });
  await store.put(`friends_${uid}`, JSON.stringify(mine));
  await store.put(`friends_${target}`, JSON.stringify(theirs));
  await store.put(`freq_${uid}`, JSON.stringify(inbox.filter((r) => r.from !== target)));

  const meUser = JSON.parse(await store.get(`u_${uid}`));
  await pushEvent(store, target, {
    type: "accept",
    from_uid: uid,
    from_nick: cpSlice(meUser.nick, 24),
    pet_name: cpSlice(meUser.pet_name, 16),
  });
  return { ok: true };
}

/** 拒绝申请：仅移除条目，不通知对方（不做拒绝冷却，YAGNI）。 */
async function rejectFriend(store, uid, bodyReq) {
  const target = clean(bodyReq.target);
  if (!validUid(target)) return { error: "申请不存在或已处理" };
  const inbox = await requestInbox(store, uid);
  const next = inbox.filter((r) => r.from !== target);
  if (next.length === inbox.length) return { error: "申请不存在或已处理" };
  await store.put(`freq_${uid}`, JSON.stringify(next));
  return { ok: true };
}

/** 申请列表视图（/friends 与心跳下发用）。 */
async function requestViews(store, uid) {
  const out = [];
  for (const r of await requestInbox(store, uid)) {
    const raw = await store.get(`u_${r.from}`);
    if (!raw) continue;
    const u = JSON.parse(raw);
    out.push({ uid: u.uid, nick: u.nick, pet_name: u.pet_name });
  }
  return out;
}
```

3d. 分发表：把 `friends/add` 的 dispatch 从 `addFriend` 改为 `requestFriend`，并新增四条路由（放在现有 friends 路由旁边）：

```js
  if (method === "POST" && path === "friends/search") {
    return await searchUser(store, auth.uid, body);
  }
  if (method === "POST" && path === "friends/request") {
    return await requestFriend(store, auth.uid, body);
  }
  if (method === "POST" && path === "friends/accept") {
    return await acceptFriend(store, auth.uid, body);
  }
  if (method === "POST" && path === "friends/reject") {
    return await rejectFriend(store, auth.uid, body);
  }
  if (method === "POST" && path === "friends/add") {
    // 老客户端入口：语义升级为「发申请」，服务端只保留一种加好友方式
    return await requestFriend(store, auth.uid, body);
  }
```

3e. `GET /friends` 响应改为对象：

```js
  if (method === "GET" && path === "friends") {
    return {
      friends: await listFriends(store, auth.uid),
      requests: await requestViews(store, auth.uid),
    };
  }
```

3f. `heartbeat` 返回值加 `requests`（在 `greetedToday` 组装之后）：

```js
  return {
    ok: true,
    next_secs: DEFAULT_HEARTBEAT_SECS,
    friends,
    requests: await requestViews(store, uid),
    events: events.events,
    visitors,
    greeted_today: greetedToday,
  };
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/test-sync.mjs`
Expected: `全部通过`，退出码 0。

- [ ] **Step 5: Commit**

```bash
git add worker-edgeone/edge-functions/api/lib-account.js scripts/test-sync.mjs
git commit -m "feat(social): 好友改申请制——搜索/申请/接受/拒绝 + 收件箱 7 天过期"
```

---

### Task 2: 服务端 · 按好友亲密度与碰一碰

**Files:**
- Modify: `worker-edgeone/edge-functions/api/lib-account.js`
- Test: `scripts/test-sync.mjs`

**Interfaces:**
- Consumes: Task 1 的 `freq_` 结构、`addAffinity` 所需的 `friendList`。
- Produces:
  - `friends_<uid>` 条目 `{uid, at, aff}`（`aff` 0-100，旧数据读时默认 0）
  - `FriendView.affinity` 字段换源为**关系亲密度**（不再是对方客户端上报的全局值）
  - `POST /friends/bump` `{target}` → `{ok: true}` 或 `{error: "碰得太快啦，歇一会儿", retry_after: 秒数}`；非好友 `{error: "只能碰一碰好友"}`
  - 事件类型新增 `bump`；KV 新键 `bump_<uid>_<dst>` = `{at}`（60 秒读时判断，陈旧键不清理）
  - 亲密度累加：接受申请 +5、greet +1、visit +2、bump +2（双向同值）

- [ ] **Step 1: 写失败的测试**

`scripts/test-sync.mjs` 末尾（Task 1 的新段之后、`console.log` 汇总之前）追加：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node scripts/test-sync.mjs`
Expected: FAIL（`affinity` 仍是对方心跳上报值、`friends/bump` 404）。退出码非 0。

- [ ] **Step 3: 实现 lib-account.js**

3a. 常量区加：

```js
/** 碰一碰冷却：同一发起方对同一好友，60 秒内一次（服务端权威）。 */
const BUMP_COOLDOWN_MS = 60 * 1000;
```

3b. 文件头「KV 键一览」加两行（`friends_<uid>` 行更新条目结构、`freq_` 行后加 bump）：

```js
 *   friends_<uid>      [{ uid, at, aff }]（最多 100，双向各自存储；aff = 关系亲密度）
 *   bump_<uid>_<dst>   碰一碰限流标记 { at }（60 秒读时判断，单向 key）
```

3c. `removeFriend` 之后加亲密度累加与碰一碰：

```js
/** 关系亲密度累加（双向同值，clamp 0-100）。条目缺失时跳过（数据自愈）。 */
async function addAffinity(store, a, b, delta) {
  const fa = await friendList(store, a);
  const fb = await friendList(store, b);
  let hit = false;
  for (const f of fa) {
    if (f.uid === b) {
      f.aff = Math.min(100, Math.max(0, (f.aff ?? 0) + delta));
      hit = true;
    }
  }
  for (const f of fb) {
    if (f.uid === a) f.aff = Math.min(100, Math.max(0, (f.aff ?? 0) + delta));
  }
  if (hit) {
    await store.put(`friends_${a}`, JSON.stringify(fa));
    await store.put(`friends_${b}`, JSON.stringify(fb));
  }
}

// ---------- 碰一碰 ----------

/**
 * 碰一碰：快闪式互动 —— 推 bump 事件（对方本地播路过动画），双方亲密度 +2。
 * 不进对方访客名单（那是 8 分钟串门的专属呈现）。
 * 限流：bump_<uid>_<dst> 时间戳，60 秒内第二次拒绝。KV 无原子写，
 * 读-检查-写的毫秒级竞态窗口对 1 次/分钟的限流无害（与招呼冷却同模式）。
 */
async function bumpFriend(store, uid, bodyReq) {
  const target = clean(bodyReq.target);
  if (!validUid(target)) return { error: "找不到该用户" };
  if (target === uid) return { error: "不能碰自己" };

  const mine = await friendList(store, uid);
  if (!mine.some((f) => f.uid === target)) return { error: "只能碰一碰好友" };

  const now = Date.now();
  const key = `bump_${uid}_${target}`;
  const raw = JSON.parse((await store.get(key)) || "null");
  if (raw && now - raw.at < BUMP_COOLDOWN_MS) {
    return {
      error: "碰得太快啦，歇一会儿",
      retry_after: Math.ceil((BUMP_COOLDOWN_MS - (now - raw.at)) / 1000),
    };
  }
  await store.put(key, JSON.stringify({ at: now }));

  const meUser = JSON.parse(await store.get(`u_${uid}`));
  await pushEvent(store, target, {
    type: "bump",
    from_uid: uid,
    from_nick: cpSlice(meUser.nick, 24),
    pet_name: cpSlice(meUser.pet_name, 16),
  });
  await addAffinity(store, uid, target, 2);
  return { ok: true };
}
```

3d. 在 `greet()` 里 `addGreeted` 两次调用之后加一行：

```js
  await addAffinity(store, uid, target, 1);
```

3e. 在 `visit()` 里 `await store.put(`visitors_${target}`, …)` 之后加一行：

```js
  await addAffinity(store, uid, target, 2);
```

3f. `listFriends` 的 `affinity` 字段换源：

```js
      affinity: typeof f.aff === "number" ? f.aff : 0,
```

（原来是 `affinity: hb ? hb.affinity : 0` —— 换成关系亲密度；`hb` 仍用于 state/online。）

3g. 分发表加路由（friends 组内）：

```js
  if (method === "POST" && path === "friends/bump") {
    return await bumpFriend(store, auth.uid, body);
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `node scripts/test-sync.mjs`
Expected: `全部通过`，退出码 0。

- [ ] **Step 5: Commit**

```bash
git add worker-edgeone/edge-functions/api/lib-account.js scripts/test-sync.mjs
git commit -m "feat(social): 关系亲密度按好友存储 + 碰一碰接口（60 秒限流与 bump 事件）"
```

---

### Task 3: Rust · 纯函数（目标加权选择 + 碰一碰冷却）

**Files:**
- Modify: `src-tauri/src/socialdrive.rs`
- Test: 同文件 `#[cfg(test)] mod tests`

**Interfaces:**
- Produces:
  - `pub const BUMP_COOLDOWN_SECS: u64 = 60;`
  - `pub fn bump_cooldown_left(blocked_until: Option<std::time::Instant>, now: std::time::Instant) -> u64`（0 = 可碰）
  - `pub fn pick_visit_target(weights: &[f64], roll: f64) -> Option<usize>`

- [ ] **Step 1: 写失败的测试**

`socialdrive.rs` 的 `mod tests` 里追加：

```rust
    #[test]
    fn 碰一碰冷却窗口() {
        let now = std::time::Instant::now();
        assert_eq!(bump_cooldown_left(None, now), 0, "没记录 → 可碰");
        assert_eq!(bump_cooldown_left(Some(now), now), 0, "已到点 → 可碰");
        assert_eq!(
            bump_cooldown_left(Some(now + Duration::from_secs(1)), now),
            1
        );
        assert_eq!(
            bump_cooldown_left(Some(now + Duration::from_secs(59)), now),
            59
        );
        assert_eq!(
            bump_cooldown_left(Some(now - Duration::from_secs(5)), now),
            0,
            "过期记录 → 可碰"
        );
    }

    #[test]
    fn 目标选择_空池与非正权重() {
        assert_eq!(pick_visit_target(&[], 0.5), None);
        assert_eq!(pick_visit_target(&[0.0, 0.0], 0.5), None);
    }

    #[test]
    fn 目标选择_单候选必中() {
        assert_eq!(pick_visit_target(&[7.0], 0.0), Some(0));
        assert_eq!(pick_visit_target(&[7.0], 0.999), Some(0));
    }

    #[test]
    fn 目标选择_按权重分段命中() {
        // 权重 [90, 10]：roll < 0.9 命中 0，roll ≥ 0.9 命中 1
        assert_eq!(pick_visit_target(&[90.0, 10.0], 0.0), Some(0));
        assert_eq!(pick_visit_target(&[90.0, 10.0], 0.89), Some(0));
        assert_eq!(pick_visit_target(&[90.0, 10.0], 0.90), Some(1));
        assert_eq!(pick_visit_target(&[90.0, 10.0], 0.99), Some(1));
        // roll = 1.0 落在边界外 → 兜底最后一个
        assert_eq!(pick_visit_target(&[90.0, 10.0], 1.0), Some(1));
    }

    #[test]
    fn 目标选择_高亲密度好友统计上更常被选() {
        // 等距采样 1000 个 roll：权重 90 的命中率应 ≈ 90%
        let mut hi = 0;
        let n = 1000;
        for k in 0..n {
            if pick_visit_target(&[90.0, 10.0], (k as f64 + 0.5) / n as f64) == Some(0) {
                hi += 1;
            }
        }
        assert!(hi > 850, "高权重命中率应 ≈90%：实际 {hi}/{n}");
    }
```

- [ ] **Step 2: 跑测试确认编译失败**

Run: `export PATH="$HOME/.cargo/bin:$PATH" && cd src-tauri && cargo test bump_cooldown`
Expected: 编译失败（`cannot find function bump_cooldown_left`）。

- [ ] **Step 3: 实现两个纯函数**

`socialdrive.rs` 里 `decide_visit` 之后加：

```rust
/// 碰一碰冷却（秒）：与服务端 BUMP_COOLDOWN_MS 同值，客户端先拦省一次请求。
pub const BUMP_COOLDOWN_SECS: u64 = 60;

/// 碰一碰本地限流（纯函数）：距冷却截止还需等多少秒（0 = 可碰）。
/// 存「截止时刻」而不是「上次时刻」—— 服务端限流返回的剩余秒数
/// 可以直接换算成截止时刻写回来，两端倒计时天然对齐。
pub fn bump_cooldown_left(
    blocked_until: Option<std::time::Instant>,
    now: std::time::Instant,
) -> u64 {
    blocked_until
        .map(|until| until.saturating_duration_since(now).as_secs())
        .unwrap_or(0)
}

/// 串门目标选择（纯函数）：权重加权随机。roll 为 0..1 均匀随机，
/// 返回选中的候选下标；池空或总权重非正返回 None。
pub fn pick_visit_target(weights: &[f64], roll: f64) -> Option<usize> {
    if weights.is_empty() {
        return None;
    }
    let total: f64 = weights.iter().sum();
    if !(total > 0.0) {
        return None;
    }
    let hit = roll * total;
    let mut acc = 0.0;
    for (i, w) in weights.iter().enumerate() {
        acc += w;
        if hit < acc {
            return Some(i);
        }
    }
    Some(weights.len() - 1) // 浮点舍入兜底：roll 恰落在最后一段边界上
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test 目标选择 && cargo test 碰一碰`
Expected: 全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/socialdrive.rs
git commit -m "feat(social): 串门目标加权随机与碰一碰本地冷却纯函数"
```

---

### Task 4: Rust · socialdrive 状态机与事件升级

**Files:**
- Modify: `src-tauri/src/socialdrive.rs`
- Modify: `src-tauri/src/syncclient.rs`
- Test: `src-tauri/src/socialdrive.rs` 的 `mod tests`

**Interfaces:**
- Consumes: Task 3 的 `bump_cooldown_left` / `BUMP_COOLDOWN_SECS`；Task 1/2 的服务端契约（requests 字段、freq/accept/bump 事件、`/friends/bump`）。
- Produces（Task 5 与前端依赖）:
  - `pub enum VisitKind { Visit, Bump }`（serde 小写）
  - `AwayNotice { away, at_nick?, kind?, duration_secs? }` → `pet://home-away`
  - `FriendsNotice { friends: Vec<FriendView>, requests: Vec<FriendRequestView> }` → `pet://friends`（原来是裸 `Vec<FriendView>`）
  - `pub struct FriendRequestView { uid, nick, pet_name }`
  - `pub async fn try_begin_bump(app: &AppHandle, target_uid: String, target_nick: String) -> Result<(), u64>`（Err = 剩余秒数）
  - `syncclient::post_authed_full(path, body)`：业务错误不折叠，保留完整 JSON（retry_after 用）

- [ ] **Step 1: 写失败的测试**

`mod tests` 追加：

```rust
    #[test]
    fn 好友申请列表能反序列化() {
        // 服务端带 at 字段（多余字段应被忽略，不能整包解析失败）
        let v = serde_json::json!([
            { "uid": "12345678", "nick": "汤圆", "pet_name": "小团子", "at": 1758000000000_u64 }
        ]);
        let got: Vec<FriendRequestView> = serde_json::from_value(v).expect("应能解析");
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].nick, "汤圆");
    }

    #[test]
    fn 出门通知序列化_回家不带kind与时长() {
        let n = AwayNotice {
            away: false,
            at_nick: None,
            kind: None,
            duration_secs: None,
        };
        let s = serde_json::to_string(&n).unwrap();
        assert!(!s.contains("kind") && !s.contains("duration_secs"), "{s}");
    }

    #[test]
    fn 出门通知序列化_出门带kind与时长() {
        let n = AwayNotice {
            away: true,
            at_nick: Some("汤圆".into()),
            kind: Some(VisitKind::Bump),
            duration_secs: Some(45),
        };
        let v = serde_json::to_value(&n).unwrap();
        assert_eq!(v["kind"], "bump");
        assert_eq!(v["duration_secs"], 45);
    }
```

- [ ] **Step 2: 跑测试确认编译失败**

Run: `cd src-tauri && cargo test 出门通知`
Expected: 编译失败（`cannot find type FriendRequestView` 等）。

- [ ] **Step 3: 实现**

3a. `syncclient.rs` 加保留完整响应的变体（放在 `post_authed` 之后）：

```rust
/// 带鉴权 POST，但保留服务端完整响应（含 error 之外的伴随字段，
/// 如碰一碰限流的 retry_after）。业务错误不再折叠成 Err(String) ——
/// 只有网络/解析失败才返回 Err。需要结构化错误信息的调用方专用。
pub async fn post_authed_full<T: Serialize>(
    path: &str,
    body: &T,
) -> Result<serde_json::Value, String> {
    let cfg = configcmd::current();
    if cfg.social.token.is_empty() {
        return Err("请先登录".into());
    }
    let url = format!("{}{path}", base_url());
    let resp = client()?
        .post(&url)
        .header("Authorization", format!("Bearer {}", cfg.social.token))
        .json(body)
        .send()
        .await
        .map_err(|e| format!("网络错误：{e}"))?;
    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("读取失败：{e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|_| "响应解析失败".to_string())?;
    if !status.is_success() && v["error"].is_null() {
        return Err("请求失败".to_string());
    }
    Ok(v)
}
```

3b. `socialdrive.rs` 结构升级（替换对应定义）：

```rust
/// 出门类型：串门（8 分钟）或碰一碰（45 秒快闪）。
#[derive(Debug, Clone, Copy, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum VisitKind {
    Visit,
    Bump,
}

/// 碰一碰出门时长：到点自动回家。
const BUMP_DURATION_SECS: u64 = 45;

/// 待处理的好友申请（心跳随好友列表一起下发）。
#[derive(Serialize, Deserialize, Clone)]
pub struct FriendRequestView {
    pub uid: String,
    pub nick: String,
    pub pet_name: String,
}

/// 好友列表刷新事件载荷（含待处理申请）。
#[derive(Serialize, Clone)]
pub struct FriendsNotice {
    pub friends: Vec<FriendView>,
    pub requests: Vec<FriendRequestView>,
}
```

`AwayNotice` 替换为：

```rust
/// 离家/回家事件载荷。
#[derive(Serialize, Clone)]
pub struct AwayNotice {
    /// true = 出门了，false = 回家了。
    pub away: bool,
    /// 去谁家（出门时）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub at_nick: Option<String>,
    /// 出门类型：visit / bump。回家事件不带。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<VisitKind>,
    /// 本次出门总时长（秒），前端倒计时用。回家事件不带。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_secs: Option<u64>,
}
```

`Visiting` / `Candidate` / 全局静态 替换为：

```rust
#[derive(Clone)]
struct Visiting {
    target_uid: String,
    target_nick: String,
    kind: VisitKind,
    /// 到点自动回家的时刻（存这里而不是局部变量，碰一碰与串门共用一条回家路径）。
    until: std::time::Instant,
}

/// 串门候选权重下限：亲密度 0 的新好友也要有机会被选中。
const CANDIDATE_BASE_WEIGHT: f64 = 10.0;

/// 碰一碰本地限流记录：uid → 冷却截止时刻。进程内存即可
///（重启丢一次无害，服务端有同款校验兜底）。
static BUMP_LAST: std::sync::OnceLock<Mutex<std::collections::HashMap<String, std::time::Instant>>> =
    std::sync::OnceLock::new();

fn bump_last() -> &'static Mutex<std::collections::HashMap<String, std::time::Instant>> {
    BUMP_LAST.get_or_init(|| Mutex::new(std::collections::HashMap::new()))
}
```

`Candidate` 结构体加权重字段：

```rust
/// 串门候选：好友与今日打过招呼的人都归到这个形状再一起抽签。
#[derive(Clone)]
struct Candidate {
    uid: String,
    nick: String,
    /// 加权随机权重：好友带关系亲密度，仅打过招呼的用基础权重。
    weight: f64,
}
```

3c. `set_visiting` 计算时长并携带 kind：

```rust
fn set_visiting(app: &AppHandle, v: Option<Visiting>) {
    let notice = AwayNotice {
        away: v.is_some(),
        at_nick: v.as_ref().map(|x| x.target_nick.clone()),
        kind: v.as_ref().map(|x| x.kind),
        duration_secs: v
            .as_ref()
            .map(|x| x.until.saturating_duration_since(std::time::Instant::now()).as_secs()),
    };
    if let Ok(mut g) = VISITING.lock() {
        *g = v;
    }
    let _ = app.emit(EVENT_AWAY, notice);
}
```

3d. `come_home` 之后加碰一碰入口：

```rust
/// 碰一碰出门：45 秒快闪后自动回家。由 friend_bump 命令在服务端确认后调用。
pub fn go_bump(app: &AppHandle, target_uid: String, target_nick: String) {
    set_visiting(
        app,
        Some(Visiting {
            target_uid,
            target_nick,
            kind: VisitKind::Bump,
            until: std::time::Instant::now() + Duration::from_secs(BUMP_DURATION_SECS),
        }),
    );
}

/// 碰一碰入口（friend_bump 命令调用）：本地限流先拦（省一次网络往返），
/// 服务端确认后设置 45 秒出门状态。Err(剩余秒数) = 被冷却拦下。
pub async fn try_begin_bump(
    app: &AppHandle,
    target_uid: String,
    target_nick: String,
) -> Result<(), u64> {
    let now = std::time::Instant::now();
    {
        let Ok(map) = bump_last().lock() else {
            return Err(BUMP_COOLDOWN_SECS);
        };
        let left = bump_cooldown_left(map.get(&target_uid).copied(), now);
        if left > 0 {
            return Err(left);
        }
    }

    let body = serde_json::json!({ "target": target_uid });
    match crate::syncclient::post_authed_full("/friends/bump", &body).await {
        Ok(v) if v["ok"] == true => {
            if let Ok(mut map) = bump_last().lock() {
                map.insert(
                    target_uid.clone(),
                    now + Duration::from_secs(BUMP_COOLDOWN_SECS),
                );
            }
            go_bump(app, target_uid, target_nick);
            Ok(())
        }
        Ok(v) => {
            // 服务端限流（多设备/时钟差）：以服务端剩余秒数对齐本地倒计时
            let left = v["retry_after"].as_u64().unwrap_or(BUMP_COOLDOWN_SECS);
            if let Ok(mut map) = bump_last().lock() {
                map.insert(
                    target_uid.clone(),
                    std::time::Instant::now() + Duration::from_secs(left),
                );
            }
            Err(left)
        }
        Err(_) => Err(BUMP_COOLDOWN_SECS), // 网络失败按满冷却处理，防连点打爆服务端
    }
}
```

3e. `spawn` 循环改造：

- 循环开头的 `let mut visit_deadline: Option<std::time::Instant> = None;`（`socialdrive.rs:186`）删除；已有的 `let mut went_visiting: Option<Visiting> = None;`（`socialdrive.rs:252`）保留不动。
- 好友列表解析与事件发射替换为（原 `if let Ok(friends) = …` 整段）：

```rust
                        // 好友列表 + 待处理申请（可能都为空）
                        let friends = serde_json::from_value::<Vec<FriendView>>(
                            v["friends"].clone(),
                        )
                        .unwrap_or_default();
                        let requests = serde_json::from_value::<Vec<FriendRequestView>>(
                            v["requests"].clone(),
                        )
                        .unwrap_or_default();
                        if !friends.is_empty() || !requests.is_empty() {
                            let _ = app.emit(
                                EVENT_FRIENDS,
                                FriendsNotice {
                                    friends: friends.clone(),
                                    requests,
                                },
                            );
                        }

                        // —— 串门决策（persona 自动触发，非人工）——
                        if !friends.is_empty() && !is_away() {
                            // 候选 = 在线好友 ∪ 今日打过招呼的人（按 uid 去重）。
                            // 权重 = 关系亲密度 + 10 下限：越熟越常去，新朋友也有机会。
                            let mut pool: Vec<Candidate> = friends
                                .iter()
                                .filter(|f| f.online && f.state != "visiting")
                                .map(|f| Candidate {
                                    uid: f.uid.clone(),
                                    nick: f.nick.clone(),
                                    weight: f.affinity + CANDIDATE_BASE_WEIGHT,
                                })
                                .collect();
                            for g in
                                GREETED_TODAY.lock().map(|g| g.clone()).unwrap_or_default()
                            {
                                if g.state == "visiting" {
                                    continue;
                                }
                                if pool.iter().any(|p| p.uid == g.uid) {
                                    continue;
                                }
                                pool.push(Candidate {
                                    uid: g.uid,
                                    nick: g.nick,
                                    weight: CANDIDATE_BASE_WEIGHT,
                                });
                            }

                            if !pool.is_empty() {
                                let busy = crate::sensedrive::shared_state()
                                    .map(|s| owner_busy(s.doing))
                                    .unwrap_or(false);
                                use rand::Rng as _;
                                let roll: f64 = rand::thread_rng().gen();
                                if decide_visit(
                                    cfg.persona,
                                    busy,
                                    affinity.can_visit(),
                                    roll,
                                ) {
                                    let weights: Vec<f64> =
                                        pool.iter().map(|c| c.weight).collect();
                                    let pick =
                                        pick_visit_target(&weights, rand::thread_rng().gen());
                                    if let Some(idx) = pick {
                                        let t = pool.remove(idx);
                                        let body =
                                            serde_json::json!({ "target": t.uid });
                                        match crate::syncclient::post_authed("/visit", &body)
                                            .await
                                        {
                                            Ok(_) => {
                                                eprintln!(
                                                    "[social] 宠物出门去 {} 家串门了",
                                                    t.nick
                                                );
                                                affinity.spend_for_visit();
                                                went_visiting = Some(Visiting {
                                                    target_uid: t.uid,
                                                    target_nick: t.nick,
                                                    kind: VisitKind::Visit,
                                                    until: std::time::Instant::now()
                                                        + Duration::from_secs(
                                                            VISIT_DURATION_SECS,
                                                        ),
                                                });
                                            }
                                            Err(e) => {
                                                eprintln!("[social] 串门被拒：{e}");
                                            }
                                        }
                                    }
                                }
                            }
                        }
```

- 循环尾部出门/回家逻辑替换为：

```rust
            if let Some(v) = went_visiting {
                set_visiting(&app, Some(v));
            }

            // 出门到点自动回家（串门 8 分钟 / 碰一碰 45 秒共用）
            if let Some(v) = VISITING.lock().ok().and_then(|g| g.clone()) {
                if std::time::Instant::now() >= v.until {
                    let target = Some(v.target_uid);
                    rt.block_on(async {
                        let body = serde_json::json!({ "target": target });
                        if let Err(e) = crate::syncclient::post_authed("/home", &body).await {
                            eprintln!("[social] 回家上报失败：{e}");
                        }
                    });
                    set_visiting(&app, None);
                }
            }
```

3f. `handle_event` 的 `match kind` 里追加三个分支（`"greet"` 分支之后）：

```rust
        "freq" => {
            let pet_name = e["event"]["pet_name"].as_str().unwrap_or("").to_string();
            let _ = app.emit(
                EVENT_SOCIAL,
                serde_json::json!({
                    "event": {
                        "type": "freq",
                        "from_uid": from_uid,
                        "from_nick": from_nick,
                        "pet_name": pet_name,
                    }
                }),
            );
        }
        "accept" => {
            let _ = app.emit(
                EVENT_SOCIAL,
                serde_json::json!({ "event": { "type": "accept", "from_nick": from_nick } }),
            );
        }
        "bump" => {
            let pet_name = e["event"]["pet_name"].as_str().unwrap_or("").to_string();
            let _ = app.emit(
                EVENT_SOCIAL,
                serde_json::json!({
                    "event": {
                        "type": "bump",
                        "from_uid": from_uid,
                        "from_nick": from_nick,
                        "pet_name": pet_name,
                    }
                }),
            );
        }
```

- [ ] **Step 4: 跑测试确认通过 + 编译干净**

Run: `cd src-tauri && cargo test && cargo check`
Expected: 全部测试 PASS，无 warning（`VISIT_DURATION_SECS` 仍在用；旧 `DEFAULT_HEARTBEAT_SECS` 的 `#[allow(dead_code)]` 不受影响）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/socialdrive.rs src-tauri/src/syncclient.rs
git commit -m "feat(social): 出门状态机支持碰一碰快闪 + 心跳带申请列表 + 新事件转发"
```

---

### Task 5: Rust · 命令层五命令

**Files:**
- Modify: `src-tauri/src/socialcmd.rs`
- Modify: `src-tauri/src/main.rs`（invoke_handler 列表）

**Interfaces:**
- Consumes: Task 4 的 `try_begin_bump`；现有 `syncclient::post_authed`。
- Produces（前端 invoke 契约）:
  - `friend_search(target) -> {uid, nick, pet_name}`（错误 reject 中文文案）
  - `friend_request(target) -> void`
  - `friend_accept(target) -> void`、`friend_reject(target) -> void`
  - `friend_bump(targetUid, targetNick) -> { ok: bool, retry_after_secs?: number }`
  - 删除旧命令 `add_friend`（语义已被申请流取代）

- [ ] **Step 1: 实现命令**

`socialcmd.rs` 里把现有 `add_friend` 命令整个替换为：

```rust
/// 搜索结果卡片（服务端只回三字段，不带在线状态/亲密度）。
#[derive(Debug, Clone, Serialize)]
pub struct SearchHit {
    pub uid: String,
    pub nick: String,
    pub pet_name: String,
}

/// 搜索用户：精确 uid 或完整昵称。命中返回公开信息卡。
#[tauri::command]
pub async fn friend_search(target: String) -> Result<SearchHit, String> {
    let target = account::valid_target(&target)?;
    let v = crate::syncclient::post_authed(
        "/friends/search",
        &serde_json::json!({ "target": target }),
    )
    .await?;
    Ok(SearchHit {
        uid: v["uid"].as_str().unwrap_or("").to_string(),
        nick: v["nick"].as_str().unwrap_or("").to_string(),
        pet_name: v["pet_name"].as_str().unwrap_or("").to_string(),
    })
}

/// 发好友申请：对方接受后才建立关系。
#[tauri::command]
pub async fn friend_request(target: String) -> Result<(), String> {
    let target = account::valid_target(&target)?;
    crate::syncclient::post_authed(
        "/friends/request",
        &serde_json::json!({ "target": target }),
    )
    .await?;
    Ok(())
}

/// 接受好友申请（target 为对方 uid）。
#[tauri::command]
pub async fn friend_accept(target: String) -> Result<(), String> {
    crate::syncclient::post_authed("/friends/accept", &serde_json::json!({ "target": target }))
        .await?;
    Ok(())
}

/// 拒绝好友申请（target 为对方 uid）。
#[tauri::command]
pub async fn friend_reject(target: String) -> Result<(), String> {
    crate::syncclient::post_authed("/friends/reject", &serde_json::json!({ "target": target }))
        .await?;
    Ok(())
}

/// 碰一碰的结果：限流时带剩余秒数，前端据此对齐按钮倒计时。
#[derive(Debug, Serialize)]
pub struct BumpOutcome {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after_secs: Option<u64>,
}

/// 碰一碰：宠物去对方家快闪 45 秒。本地限流先拦，服务端二次校验。
/// 被冷却拦下不算错误 —— 返回 BumpOutcome 让前端画倒计时。
#[tauri::command]
pub async fn friend_bump(
    app: AppHandle,
    target_uid: String,
    target_nick: String,
) -> Result<BumpOutcome, String> {
    match crate::socialdrive::try_begin_bump(&app, target_uid, target_nick).await {
        Ok(()) => Ok(BumpOutcome { ok: true, retry_after_secs: None }),
        Err(left) => Ok(BumpOutcome { ok: false, retry_after_secs: Some(left) }),
    }
}
```

`main.rs` 的 `invoke_handler` 里把 `socialcmd::add_friend,` 一行替换为：

```rust
            socialcmd::friend_search,
            socialcmd::friend_request,
            socialcmd::friend_accept,
            socialcmd::friend_reject,
            socialcmd::friend_bump,
```

- [ ] **Step 2: 编译与既有测试**

Run: `cd src-tauri && cargo check && cargo test`
Expected: 编译通过（此刻前端还引用 `add_friend`，但 Rust 侧不依赖前端），测试全绿。

- [ ] **Step 3: Commit**

```bash
git add src-tauri/src/socialcmd.rs src-tauri/src/main.rs
git commit -m "feat(social): 好友搜索/申请/接受/拒绝/碰一碰五个前端命令"
```

---

### Task 6: 前端 · away-text 纯函数 + Bubble 双按钮 + Banner 通用卡片

**Files:**
- Create: `src/overlay/away-text.ts`
- Create: `tests/away-text.test.ts`
- Modify: `src/overlay/bubble.ts`
- Modify: `src/overlay/friends.ts`（仅 `onAwayChange` 类型）

**Interfaces:**
- Produces:
  - `formatAwayText(kind: "visit" | "bump" | undefined, nick: string | undefined, remainSecs: number): string`
  - `Bubble.show(text, { …, altLabel?, onAlt? })` —— 次按钮（拒绝），点击即关闭
  - `Banner.showCard({ tag, text, actions: [{label, primary?, onClick}] })` —— 右上角通用卡片，60 秒自动收起
  - `onAwayChange` 回调类型扩展 `{ away, at_nick?, kind?, duration_secs? }`

- [ ] **Step 1: 写失败的测试**

`tests/away-text.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { formatAwayText } from "../src/overlay/away-text";

describe("formatAwayText", () => {
  it("串门显示剩余分钟", () => {
    expect(formatAwayText("visit", "汤圆", 480)).toBe("🐾 在 汤圆 家 · 还剩 8 分钟");
    expect(formatAwayText("visit", "汤圆", 361)).toBe("🐾 在 汤圆 家 · 还剩 7 分钟");
  });

  it("串门不足一分钟显示马上回来", () => {
    expect(formatAwayText("visit", "汤圆", 59)).toBe("🐾 在 汤圆 家 · 马上回来");
    expect(formatAwayText("visit", "汤圆", 0)).toBe("🐾 在 汤圆 家 · 马上回来");
  });

  it("碰一碰固定文案", () => {
    expect(formatAwayText("bump", "汤圆", 45)).toBe("🐾 碰了碰 汤圆，马上回来");
    expect(formatAwayText("bump", "汤圆", 1)).toBe("🐾 碰了碰 汤圆，马上回来");
  });

  it("旧版事件无 kind 时兜底", () => {
    expect(formatAwayText(undefined, "汤圆", 480)).toBe("🐾 不在家");
    expect(formatAwayText(undefined, undefined, 0)).toBe("🐾 不在家");
  });

  it("visit 缺昵称兜底", () => {
    expect(formatAwayText("visit", undefined, 480)).toBe("🐾 不在家");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/away-text.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 away-text.ts**

```ts
/**
 * 出门状态文案（纯函数，供右下角出门图标使用）。
 *
 * 串门（8 分钟）显示剩余分钟；碰一碰（45 秒）本来就短，固定一句。
 * 旧版事件没有 kind 字段 —— 兼容成「不在家」。
 */
export function formatAwayText(
  kind: "visit" | "bump" | undefined,
  nick: string | undefined,
  remainSecs: number,
): string {
  if (kind === "bump" && nick) return `🐾 碰了碰 ${nick}，马上回来`;
  if (kind === "visit" && nick) {
    if (remainSecs >= 60) {
      return `🐾 在 ${nick} 家 · 还剩 ${Math.ceil(remainSecs / 60)} 分钟`;
    }
    return `🐾 在 ${nick} 家 · 马上回来`;
  }
  return "🐾 不在家";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/away-text.test.ts`
Expected: 5 项全 PASS。

- [ ] **Step 5: Bubble 次按钮**

`bubble.ts` 的 `show` 签名与按钮渲染扩展：

```ts
  show(
    text: string,
    opts: {
      confirmLabel?: string;
      onConfirm?: () => void;
      /** 次按钮（如「拒绝」）：与确认按钮并排，点击后同样关闭气泡。 */
      altLabel?: string;
      onAlt?: () => void;
      autoDismissMs?: number;
      ai?: boolean;
    } = {},
  ): void {
```

方法体内，确认按钮 `this.actionsEl.appendChild(btn);` 之后追加：

```ts
    if (opts.altLabel) {
      const alt = document.createElement("button");
      alt.className = "pet-bubble-confirm";
      alt.textContent = opts.altLabel;
      alt.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        opts.onAlt?.();
        this.dismiss();
      });
      this.actionsEl.appendChild(alt);
    }
```

- [ ] **Step 6: Banner 通用卡片**

`banner.ts` 的 `Banner` 类里，`showReminder` 之前加：

```ts
  /**
   * 通用小卡片：右上角，一段文字 + 若干操作按钮。
   * 好友搜索结果、申请回执这类「主动操作的回执」用它 —— 视觉权重
   * 高于贴宠物的气泡，又不该跟着宠物乱跑。60 秒无操作自动收起。
   */
  showCard(opts: {
    tag: string;
    text: string;
    actions: Array<{ label: string; primary?: boolean; onClick: () => void }>;
  }): void {
    this.anchored = false;
    this.setAnchored(false);
    this.el.className = "pet-banner pet-banner-reminder";
    this.el.onclick = null;
    this.el.replaceChildren();

    const head = document.createElement("div");
    head.className = "pet-banner-head";
    const tag = document.createElement("span");
    tag.className = "pet-banner-tag";
    tag.textContent = opts.tag;
    const x = document.createElement("button");
    x.className = "pet-banner-close";
    x.textContent = "×";
    x.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.dismiss();
    });
    head.append(tag, x);
    this.el.appendChild(head);

    const body = document.createElement("div");
    body.className = "pet-banner-text";
    body.textContent = opts.text;
    this.el.appendChild(body);

    const actions = document.createElement("div");
    actions.className = "pet-banner-actions";
    for (const a of opts.actions) {
      const btn = document.createElement("button");
      btn.className = a.primary ? "pet-banner-btn primary" : "pet-banner-btn";
      btn.textContent = a.label;
      btn.addEventListener("pointerdown", (e) => {
        e.stopPropagation();
        a.onClick();
        this.dismiss();
      });
      actions.appendChild(btn);
    }
    this.el.appendChild(actions);

    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.dismiss(), 60 * 1000);

    this.el.style.display = "block";
    this.open = true;
  }
```

- [ ] **Step 7: onAwayChange 类型扩展**

`friends.ts` 的 `onAwayChange` 替换为：

```ts
/** 订阅宠物离家/回家事件（kind/duration_secs 是新字段，旧事件可能缺省）。 */
export async function onAwayChange(
  cb: (n: {
    away: boolean;
    at_nick?: string;
    kind?: "visit" | "bump";
    duration_secs?: number;
  }) => void,
): Promise<() => void> {
  try {
    return await listen<{
      away: boolean;
      at_nick?: string;
      kind?: "visit" | "bump";
      duration_secs?: number;
    }>("pet://home-away", (e) => cb(e.payload));
  } catch {
    return () => {};
  }
}
```

- [ ] **Step 8: 类型检查**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 无类型错误（`pet://home-away` 的监听方 main.ts 只读已有字段，兼容），测试全绿。

- [ ] **Step 9: Commit**

```bash
git add src/overlay/away-text.ts tests/away-text.test.ts src/overlay/bubble.ts src/overlay/friends.ts
git commit -m "feat(ui): 出门倒计时文案纯函数 + 气泡次按钮 + 右上角通用卡片"
```

---

### Task 7: 前端 · friends.ts 搜索/申请区/碰一碰按钮

**Files:**
- Modify: `src/overlay/friends.ts`
- Modify: `src/main.ts`（构造注入 banner、onFriendsUpdate 双参数）

**Interfaces:**
- Consumes: Task 5 的 `friend_search/friend_request/friend_accept/friend_reject/friend_bump` 命令；Task 6 的 `Banner.showCard`；Task 4 的 `FriendsNotice` payload。
- Produces:
  - `FriendsPanel` 构造签名变为 `constructor(private readonly banner: Banner)`（main.ts 传共享实例）
  - `setFriends(list: FriendRow[], requests: FriendRequestRow[])`
  - `onFriendsUpdate(cb: (list, requests) => void)`

- [ ] **Step 1: 类型与状态**

`friends.ts` 顶部接口区加：

```ts
/** 待处理的好友申请（心跳随好友列表一起下发）。 */
export interface FriendRequestRow {
  uid: string;
  nick: string;
  pet_name: string;
}

/** 搜索结果卡（Rust SearchHit，只有三字段）。 */
interface SearchHit {
  uid: string;
  nick: string;
  pet_name: string;
}
```

`FriendsPanel` 字段区加（`greetBtns` 之后）：

```ts
  private requests: FriendRequestRow[] = [];
  /** uid → 碰一碰冷却结束时间戳（展示层防抖；权威限流在 Rust）。 */
  private readonly bumpUntil = new Map<string, number>();
  /** uid → 碰一碰按钮（倒计时就地更新）。 */
  private readonly bumpBtns = new Map<string, HTMLButtonElement>();
```

文件头部 import 加：`import type { Banner } from "./bubble";`

构造函数改为接收 banner：

```ts
  constructor(private readonly banner: Banner) {
```

- [ ] **Step 2: 布局插入申请区段**

`renderMain` 替换为：

```ts
  private renderMain(cfg: SocialCfg): void {
    this.renderPetName(cfg);
    this.el.appendChild(this.divider("今日在线"));
    this.renderOnline();
    if (this.requests.length > 0) {
      this.el.appendChild(this.divider("好友申请"));
      this.renderRequests();
    }
    this.el.appendChild(this.divider("好友"));
    this.renderAddFriend();
    this.renderFriendList();
    this.renderFoot();
  }
```

- [ ] **Step 3: 搜索替换直加**

`renderAddFriend` 整个替换为：

```ts
  private renderAddFriend(): void {
    const addRow = this.row("找朋友");
    const addInput = this.input("uid 或完整昵称");
    const addBtn = document.createElement("button");
    addBtn.className = "pet-bubble-confirm";
    addBtn.textContent = "搜索";
    addBtn.style.flex = "0 0 auto";
    addBtn.addEventListener("pointerdown", async (e) => {
      e.stopPropagation();
      const t = addInput.value.trim();
      if (!t) return;
      addBtn.disabled = true;
      try {
        const hit = await invoke<SearchHit>("friend_search", { target: t });
        this.banner.showCard({
          tag: "搜索结果",
          text: `${hit.nick} 的 ${hit.pet_name}（uid ${hit.uid}）`,
          actions: [
            { label: "发申请", primary: true, onClick: () => void this.sendRequest(hit) },
          ],
        });
      } catch (err) {
        this.banner.showCard({
          tag: "搜索结果",
          text: String(err),
          actions: [{ label: "知道了", onClick: () => {} }],
        });
      }
      addBtn.disabled = false;
    });
    addRow.append(addInput, addBtn);
    this.el.appendChild(addRow);
    this.el.appendChild(this.hint("发申请后，对方接受才成为好友"));
  }

  private async sendRequest(hit: SearchHit): Promise<void> {
    try {
      await invoke("friend_request", { target: hit.uid });
      this.banner.showCard({
        tag: "好友申请",
        text: `已向 ${hit.nick} 发送申请，等 TA 接受`,
        actions: [{ label: "知道了", onClick: () => {} }],
      });
    } catch (err) {
      this.banner.showCard({
        tag: "好友申请",
        text: String(err),
        actions: [{ label: "知道了", onClick: () => {} }],
      });
    }
  }
```

- [ ] **Step 4: 申请区段渲染**

`renderAddFriend` 之后加：

```ts
  private renderRequests(): void {
    for (const r of this.requests) {
      const row = document.createElement("div");
      row.className = "pet-friend-row";

      const main = document.createElement("span");
      main.className = "pet-friend-nick";
      main.textContent = `${r.nick} 的 ${r.pet_name}`;
      main.title = `uid: ${r.uid}`;

      const accept = document.createElement("button");
      accept.className = "pet-greet-btn";
      accept.textContent = "接受";
      accept.addEventListener("pointerdown", async (e) => {
        e.stopPropagation();
        try {
          await invoke("friend_accept", { target: r.uid });
          this.requests = this.requests.filter((x) => x.uid !== r.uid);
          this.render();
        } catch (err) {
          accept.title = String(err);
        }
      });

      const reject = document.createElement("button");
      reject.className = "pet-reminder-del";
      reject.textContent = "拒绝";
      reject.addEventListener("pointerdown", async (e) => {
        e.stopPropagation();
        try {
          await invoke("friend_reject", { target: r.uid });
          this.requests = this.requests.filter((x) => x.uid !== r.uid);
          this.render();
        } catch (err) {
          reject.title = String(err);
        }
      });

      row.append(main, accept, reject);
      this.el.appendChild(row);
    }
  }
```

- [ ] **Step 5: 好友行加碰一碰按钮**

`renderFriendList` 开头加 `this.bumpBtns.clear();`。`friendRow` 里删除按钮之前加碰一碰按钮，并把 `row.append(dot, main, state, aff, del)` 改为含 bump：

```ts
    const bump = document.createElement("button");
    bump.className = "pet-greet-btn";
    bump.textContent = "碰";
    bump.title = "碰一碰：跑过去打个招呼就回（每分钟一次）";
    bump.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      void this.doBump(f);
    });
    this.bumpBtns.set(f.uid, bump);
    this.applyBumpCooldown(f.uid);

    row.append(dot, main, state, aff, bump, del);
```

`friendRow` 之后加两个方法，`startTick` 的循环体扩展为同时刷新碰一碰倒计时：

```ts
  private async doBump(f: FriendRow): Promise<void> {
    const btn = this.bumpBtns.get(f.uid);
    if (btn) btn.disabled = true;
    try {
      const r = await invoke<{ ok: boolean; retry_after_secs?: number }>("friend_bump", {
        targetUid: f.uid,
        targetNick: f.nick,
      });
      // 被限流时用服务端剩余秒数对齐；成功按满 60 秒防抖
      const left = r.retry_after_secs ?? 60;
      this.bumpUntil.set(f.uid, Date.now() + left * 1000);
    } catch {
      // 网络失败也进冷却：别让用户连点打爆服务端
      this.bumpUntil.set(f.uid, Date.now() + 60_000);
    }
    this.applyBumpCooldown(f.uid);
    this.startTick();
  }

  private applyBumpCooldown(uid: string): void {
    const btn = this.bumpBtns.get(uid);
    if (!btn) return;
    const left = Math.ceil(((this.bumpUntil.get(uid) ?? 0) - Date.now()) / 1000);
    if (left > 0) {
      btn.disabled = true;
      btn.classList.add("is-cooling");
      btn.textContent = `${left}s`;
    } else {
      btn.disabled = false;
      btn.classList.remove("is-cooling");
      btn.textContent = "碰";
    }
  }
```

`startTick` 循环体改为：

```ts
    this.tick = setInterval(() => {
      if (!this.open) {
        this.stopTick();
        return;
      }
      for (const uid of this.greetBtns.keys()) this.applyCooldown(uid);
      for (const uid of this.bumpBtns.keys()) this.applyBumpCooldown(uid);
    }, 1000);
```

- [ ] **Step 6: payload 双参数化**

`setFriends` 与 `onFriendsUpdate` 替换为：

```ts
  /** 更新好友列表与待处理申请（事件驱动）。 */
  setFriends(list: FriendRow[], requests: FriendRequestRow[]): void {
    this.friends = list;
    this.requests = requests;
    if (this.open && this.cfg?.social_uid) {
      this.render();
    }
  }
```

```ts
/** 订阅好友列表刷新（含待处理申请）。 */
export async function onFriendsUpdate(
  cb: (list: FriendRow[], requests: FriendRequestRow[]) => void,
): Promise<() => void> {
  try {
    return await listen<{ friends: FriendRow[]; requests?: FriendRequestRow[] }>(
      "pet://friends",
      (e) => cb(e.payload.friends, e.payload.requests ?? []),
    );
  } catch {
    return () => {};
  }
}
```

- [ ] **Step 7: main.ts 接线**

`main.ts` 中 `const friendsPanel = new FriendsPanel();`（第 137 行附近；banner 在第 135 行已构造，顺序正确）改为：

```ts
const friendsPanel = new FriendsPanel(banner);
```

第 438 行 `void onFriendsUpdate((list) => friendsPanel.setFriends(list));` 改为：

```ts
void onFriendsUpdate((list, requests) => {
  friendsPanel.setFriends(list, requests);
  // 有待处理申请时菜单入口带红点；处理完（下一拍心跳下发空列表）自动摘掉
  menu.setLabel(3, requests.length > 0 ? "好友 ●" : "好友");
});
```

（右键菜单里「好友」是索引 3：0 记一笔 / 1 每日提醒 / 2 插件面板 / 3 好友。）

- [ ] **Step 8: 类型检查与测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 无类型错误，测试全绿。

- [ ] **Step 9: Commit**

```bash
git add src/overlay/friends.ts src/main.ts
git commit -m "feat(ui): 好友面板改搜索+申请流，新增申请区段与碰一碰按钮"
```

---

### Task 8: 前端 · 碰一碰快闪动画 + 事件接线 + 出门倒计时

**Files:**
- Create: `src/guest/flash.ts`
- Modify: `src/guest/guest-pet.ts`（加 `walkTo`）
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: Task 6 的 `formatAwayText` / Bubble `altLabel`；Task 4 的 `pet://social` 新事件与 `pet://home-away` kind/duration。
- Produces:
  - `GuestPet.walkTo(x: number, boundsWidth: number): void`
  - `FlashGuests`：`arrive(seed, nowMs, canvasW, targetX, groundY): boolean`、`tick(nowMs, ctx, canvas): boolean`、`clear(ctx)`、`invalidate()`、`setSide(n)`、`get isBusy`、`get active`

- [ ] **Step 1: GuestPet 定向走位**

`guest-pet.ts` 的 `leave` 方法之后加：

```ts
  /**
   * 定向走位（碰一碰快闪用）：走到指定 x 坐标。
   * 与 leave() 互斥 —— 离场途中不再改目标。
   */
  walkTo(x: number, boundsWidth: number): void {
    if (this.leaving) return;
    this.behavior.goto(x, boundsWidth);
  }
```

- [ ] **Step 2: FlashGuests**

`src/guest/flash.ts`：

```ts
import type { GuestSeed } from "./guest-pet";
import { GuestPet } from "./guest-pet";

/** 快闪到场停留时长（毫秒）：站到主宠物身边「碰」的时间。 */
const STAY_MS = 4000;
/** 同一 uid 的快闪去重窗口（毫秒）：事件经心跳拉取可能重复/迟到。 */
const DEDUP_MS = 60_000;

/**
 * 碰一碰快闪 —— 对方宠物跑来碰你一下就走的短生命周期动画。
 *
 * 与串门访客（GuestRegistry）完全独立：不占 3 个访客槽位、不进对话
 * 编排；身体同样不上报命中框（不可点、让点击穿透，与访客一致）。
 *
 * 事件经心跳拉取到达（最多晚 3 分钟），所以这里是「回放式」呈现：
 * 从屏幕左侧跑进来 → 走到主宠物身旁 → 停留片刻 → 走出屏幕。
 */
export class FlashGuests {
  private current: GuestPet | null = null;
  private leaveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly lastSeen = new Map<string, number>();
  private side = 48;

  setSide(n: number): void {
    this.side = n;
  }

  /** 收到 bump 事件。返回 true 表示安排了快闪（调用方需唤醒渲染）。 */
  arrive(
    seed: GuestSeed,
    nowMs: number,
    canvasW: number,
    targetX: number,
    groundY: number,
  ): boolean {
    const last = this.lastSeen.get(seed.uid) ?? 0;
    if (nowMs - last < DEDUP_MS) return false; // 幂等去重
    this.lastSeen.set(seed.uid, nowMs);

    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.current?.leave(nowMs, canvasW); // 上一只还没走完：先送走

    const pet = new GuestPet(seed, {
      x: -this.side * 2, // 从左侧屏幕外跑进来
      y: groundY,
      side: this.side,
      nowMs,
      index: 2,
    });
    pet.walkTo(targetX, canvasW);
    this.current = pet;
    this.leaveTimer = setTimeout(() => {
      this.leaveTimer = null;
      this.current?.leave(performance.now(), canvasW);
    }, STAY_MS);
    return true;
  }

  /** 推进动画。返回 true 表示这一拍画了新画面（与 GuestRegistry.tick 同约定）。 */
  tick(
    nowMs: number,
    ctx: CanvasRenderingContext2D,
    canvas: { width: number; height: number },
  ): boolean {
    const cur = this.current;
    if (!cur) return false;
    const drew = cur.tick(nowMs, ctx, canvas);
    if (cur.gone) this.current = null;
    return drew;
  }

  /** 当前快闪中的访客（主循环做脏矩形重叠判断用）。 */
  get active(): GuestPet | null {
    return this.current;
  }

  /** 有没有在走动 —— 只有这时才需要抬帧率。 */
  get isBusy(): boolean {
    return this.current?.isBusy ?? false;
  }

  /** 画布被整屏清空后调用：作废指纹重画（与访客同约定）。 */
  invalidate(): void {
    this.current?.invalidate();
  }

  /** 全部清走（宠物离家等需要重画的场合）。 */
  clear(ctx: CanvasRenderingContext2D): void {
    if (this.leaveTimer) clearTimeout(this.leaveTimer);
    this.leaveTimer = null;
    this.current?.dismiss(ctx);
    this.current = null;
  }
}
```

- [ ] **Step 3: main.ts 接线**

3a. import 区加：

```ts
import { formatAwayText } from "./overlay/away-text";
import { FlashGuests } from "./guest/flash";
```

3b. `const guests = new GuestRegistry(ctx2d, canvas, 48);` 之后加：

```ts
const flash = new FlashGuests();
```

`guests.setSide(...)` 调用处（`applyConfig` 内，第 68 行附近）把尺寸提成变量，同步喂给快闪层：

```ts
  // 访客比主宠物小一圈：一眼能分清谁是自己家的
  const side = Math.max(32, Math.round((pet.body.w * 0.7) / 8) * 8);
  const changed = guests.setSide(side);
  flash.setSide(side);
```

3c. `onSocialEvent` 回调追加三个分支（现有 `interaction` 分支之后）：

```ts
  } else if (e.event.type === "freq" && e.event.from_nick) {
    const fromUid = e.event.from_uid ?? "";
    bubble.show(`${e.event.from_nick} 请求加你好友`, {
      confirmLabel: "接受",
      onConfirm: () => {
        void invoke("friend_accept", { target: fromUid }).catch(() => {});
      },
      altLabel: "拒绝",
      onAlt: () => {
        void invoke("friend_reject", { target: fromUid }).catch(() => {});
      },
      autoDismissMs: 20_000,
    });
  } else if (e.event.type === "accept" && e.event.from_nick) {
    bubble.show(`${e.event.from_nick} 通过了你的好友申请`, { autoDismissMs: 8000 });
  } else if (e.event.type === "bump" && e.event.from_nick) {
    const seed = {
      uid: e.event.from_uid ?? "",
      nick: e.event.from_nick,
      pet_name: e.event.pet_name ?? "",
    };
    if (flash.arrive(seed, performance.now(), canvas.width, pet.body.x, canvas.height * 0.72)) {
      wakeFrame();
    }
    bubble.show(`${e.event.from_nick} 的宠物跑来碰了碰你`, { autoDismissMs: 8000 });
  }
```

3d. 出门图标倒计时：`onAwayChange` 回调整个替换为：

```ts
let awayKind: "visit" | "bump" | undefined;
let awayNick: string | undefined;
let awayEndsAt = 0; // performance.now() 时间戳
let awayTicker: ReturnType<typeof setInterval> | null = null;

function stopAwayTicker(): void {
  if (awayTicker) clearInterval(awayTicker);
  awayTicker = null;
}

void onAwayChange((n) => {
  pet.setHidden(n.away);
  // setHidden 会整屏 clearRect，访客必须作废指纹重画，否则会消失
  guests.invalidate();
  if (n.away) {
    banner.releaseFromPet();
    flash.clear(ctx2d);
    awayKind = n.kind;
    awayNick = n.at_nick;
    awayEndsAt = performance.now() + (n.duration_secs ?? 0) * 1000;
    stopAwayTicker();
    awayTicker = setInterval(() => {
      const remain = Math.max(0, (awayEndsAt - performance.now()) / 1000);
      awayIcon.textContent = formatAwayText(awayKind, awayNick, remain);
      if (remain <= 0) stopAwayTicker();
    }, 1000);
  } else {
    stopAwayTicker();
  }
  awayIcon.style.display = n.away ? "flex" : "none";
  awayIcon.title = "点击召回宠物";
  if (n.away) {
    awayIcon.textContent = formatAwayText(awayKind, awayNick, n.duration_secs ?? 0);
  }
});
```

3e. 渲染循环 `onFrame` 接入快闪（与访客同约定：画在主宠物之后）：

```ts
  const guestDrew = guests.tick(now);
  const flashDrew = flash.tick(now, ctx2d, canvas);
  guestDialog.tick(now, guests.list);
  if (guestDrew || flashDrew) {
    const host = pet.body;
    const affected = [
      ...guests.list.map((g) => g.lastAffected),
      flash.active?.lastAffected ?? null,
    ];
    for (const d of affected) {
      if (d && overlaps(d, host)) {
        pet.invalidate();
        break;
      }
    }
  }
```

帧率档位改为：

```ts
  const busy = guests.wantsFastFrame || flash.isBusy;
  const interval = busy
    ? Math.min(pet.debugIntervalMs, GUEST_INTERVAL_MS)
    : pet.debugIntervalMs;
```

- [ ] **Step 4: 类型检查与测试**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 无类型错误，测试全绿。

- [ ] **Step 5: Commit**

```bash
git add src/guest/flash.ts src/guest/guest-pet.ts src/main.ts
git commit -m "feat(ui): 碰一碰快闪动画与出门倒计时，申请/接受/被碰气泡接线"
```

---

### Task 9: Worker 适配层冒烟 + 全量校验 + 版本与验证文档

**Files:**
- Modify: `scripts/test-worker.mjs`
- Create: `docs/plans/2026-09-19-friends-optimization-verification.md`
- Modify: `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`（版本三处，需用户确认）

**Interfaces:**
- Consumes: 全部前序任务。

- [ ] **Step 1: worker 适配层新路由冒烟**

`scripts/test-worker.mjs` 的 `console.log` 汇总之前追加：

```js
// ---------- 好友申请与碰一碰（新路由过适配层） ----------
const qW = await call("POST", "/api/friends/request", { target: b.uid }, a.token);
ok(qW.status === 200 && qW.json.ok, `friends/request 过适配层：${JSON.stringify(qW.json)}`);
const accW = await call("POST", "/api/friends/accept", { target: a.uid }, b.token);
ok(accW.status === 200 && accW.json.ok, `friends/accept：${JSON.stringify(accW.json)}`);
const bpW = await call("POST", "/api/friends/bump", { target: b.uid }, a.token);
ok(bpW.status === 200 && bpW.json.ok, `friends/bump：${JSON.stringify(bpW.json)}`);
const bpW2 = await call("POST", "/api/friends/bump", { target: b.uid }, a.token);
ok("error" in bpW2.json && bpW2.json.retry_after > 0, `限流字段完整透传：${JSON.stringify(bpW2.json)}`);
```

Run: `node scripts/test-worker.mjs`
Expected: `全部通过`（a 与 b 此时还不是好友 —— request/accept 建立关系后 bump；`retry_after` 在 400 响应体里同样透传）。

- [ ] **Step 2: 全量校验**

```bash
export PATH="$HOME/.cargo/bin:$PATH"
npx tsc --noEmit
npx vitest run
node scripts/test-sync.mjs
node scripts/test-worker.mjs
cd src-tauri && cargo check && cargo test
```

Expected: 全部通过，零 warning。

- [ ] **Step 3: 手工验证清单**

创建 `docs/plans/2026-09-19-friends-optimization-verification.md`：

```markdown
# 好友功能优化 · 手工验证清单（2026-09-19）

对应设计：`docs/superpowers/specs/2026-09-19-friends-optimization-design.md`
窗口/动画/双机行为无法自动化，发版前按下表人工过一遍。

## 申请流（双机或双账号）
- [ ] A 搜索 B 的 uid → 右上角弹结果卡片（昵称/宠物名/uid），点「发申请」→ 弹「已发送」
- [ ] 搜索不存在的 uid → 弹「找不到该用户」
- [ ] B 下一拍心跳（≤3 分钟）收到气泡「A 请求加你好友」带接受/拒绝，可直接处理
- [ ] B 在好友面板「好友申请」区段也能接受/拒绝；拒绝后 A 可再次申请
- [ ] 接受后双端好友列表互见，A 收到「B 通过了你的好友申请」气泡
- [ ] 重复申请 →「已经申请过啦」；已是好友再申请 →「你们已经是好友了」

## 碰一碰
- [ ] 好友行「碰」按钮：点击后按钮 60s 倒计时；右下角图标「🐾 碰了碰 XX，马上回来」
- [ ] 45 秒后自动回家（图标消失）；点图标可提前召回
- [ ] 对方收到气泡 + 一只宠物从屏幕左侧跑进来、停在自己宠物旁、约 4 秒后跑走
- [ ] 同一好友 60 秒内第二次碰被本地拦截（按钮倒计时，不发出网络请求）
- [ ] 不同好友的倒计时互不影响；重复 bump 事件 60s 内只播一次快闪

## 串门进度
- [ ] 自动串门时图标显示「🐾 在 XX 家 · 还剩 N 分钟」，每分钟递减
- [ ] 不足 1 分钟显示「马上回来」；召回后图标消失

## 回归
- [ ] 招呼/串门/访客/隐身行为与之前一致；好友列表 ♥ 显示关系亲密度
- [ ] `pnpm test:sync` / `pnpm test:worker` / `npx vitest run` / `cargo test` 全绿
```

- [ ] **Step 4: 版本号（先与用户确认！）**

按仓库版本规则与用户确认版本号（当前 1.2.1，建议 1.3.0）。确认后三处同步：

- `src-tauri/tauri.conf.json` → `"version": "1.3.0"`
- `src-tauri/Cargo.toml` → `version = "1.3.0"`
- `package.json` → `"version": "1.3.0"`

- [ ] **Step 5: 最终提交**

```bash
git add scripts/test-worker.mjs docs/plans/2026-09-19-friends-optimization-verification.md \
  src-tauri/tauri.conf.json src-tauri/Cargo.toml package.json
git commit -m "chore(release): 好友申请流/碰一碰/串门进度收尾与验证清单

版本: 1.3.0"
```

（Cargo.lock 若因版本变动更新，一并 `git add`。）
