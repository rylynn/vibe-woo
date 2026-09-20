# 在线总览 / 串门近距离互动 / 通知气泡收拢 · 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 「今日在线」改为含好友的在线总览；串门升级为伙伴式跟随 + 可点击摸摸 + 出门/送客反馈；轻通知气泡收拢到宠物头顶（锚链防重叠）。

**Architecture:** 服务端单接口合并（`onlineRandom` 返回带 `is_friend` 的混合列表）+ 新增 `/visit/interact` 摸摸端点（计数权威）；Rust 透传 `is_friend`/`pats` 并补 `visit_rejected` 事件；前端 GuestPet 获得跟随/摸摸/面对面能力，Banner 的贴身定位抽成 `bannerStackPos` 纯函数并支持锚链避让。设计文档：`docs/superpowers/specs/2026-09-20-online-visit-bubble-design.md`。

**Tech Stack:** Cloudflare Worker / EdgeOne 边缘函数共用 `lib-account.js`（无 TTL KV）；Tauri 2 + Rust（socialcmd/socialdrive/syncclient）；TypeScript 无框架 Canvas（vitest 无 DOM 环境）。

**现状基线（2026-09-20 已核对源码，勿凭空假设）：**
- `Banner` 已有 `anchored`/`body`/`setAnchored`/`follow(body)`（单参、内联定位）/`show(text, time?, {followPet?})`（默认 false）/`showCard`（恒右上角）/`releaseFromPet()`（直接 dismiss）——本计划是**增量改造**，不是从零写。
- `main.ts` 渲染循环已每帧调 `banner.follow(pet.body)`（704-707）；`notifyNearPet(text)` 已存在（588-602）；`onAwayChange` 已含 `guests.invalidate()`/`banner.releaseFromPet()`/`flash.clear(ctx2d)`（540-565）。
- `GuestRegistry` 已有 `invalidate()`/`clear()`/`sync(seeds, nowMs)`/`bodies`；`GuestDialog` 已有 `clear()`/`pick()`，构造仅 `hostSay` 一参；`Bubble.box` getter 已存在。
- `Behavior` 字段：`targetX`/`state.facing`/`nextMoveIn`/`placeAt`(重锚)/`goto`(钳制 [0,maxX])/`finishGoto`/`WALK_SPEED=130`。
- `guest-pet.ts` tick 内局部变量：`st`/`px`/`py`/`w`/`h`/`bob`，绘制指纹 `lastDrawKey`，脏矩形 `dirty`/`erased`，`expr.update(..., { poked: false, ... })`。

## Global Constraints

- **隐私红线不可放宽**：`share.rs` 白名单上报零改动；事件 payload 白名单构造；日志只记阶段与错误类别。
- **不打扰是第一原则**：摸摸失败 fire-and-forget 不重试；出门演出只一句话。
- **CPU < 1% 空闲**：访客就位后 `isBusy === false` 不抬帧；绝不产生半透明像素（桃心用棋盘点阵纯色）。
- **不抢焦点**：全部 DOM 改动不取焦点。
- **纯逻辑优先可测**：`bannerStackPos` / `followStep` 写成导出纯函数并补 vitest。
- **版本规则（.codebuddy/rules/version-on-merge.md）**：开工第一个代码 commit 前先向用户确认版本号 `<V>`（**不许自编**）；此后每个代码 commit message 末尾带 `版本: <V>`；Task 10 把 `<V>` 同步写进 `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json` 三处。
- 注释、commit message、文档一律中文。
- `docs/` 在 .gitignore 中但历史文件均被跟踪：提交计划/清单用 `git add -f`（仓库惯例）。
- Tauri 参数命名：JS `invoke("visitor_interact", { targetUid })` ↔ Rust `target_uid: String`。
- 服务端两套部署（`worker/` 与 `worker-edgeone/`）共用同一份 `worker-edgeone/edge-functions/api/lib-account.js`，**只改这一份**。
- `scripts/test-sync.mjs` 是顺序脚本：新用例放文件**末尾**、用全新用户，避免污染前段断言（前段 `online/random` 断言都在 A 与 H 成为好友之前，本计划的改动不影响它们）。文件中部已有模块级 `async function newUser(account, nick, petName)`（143 行），尾部可直接复用。

---

### Task 1: 服务端 — 今日在线含好友（is_friend）

**Files:**
- Modify: `worker-edgeone/edge-functions/api/lib-account.js:59`（常量区，`ONLINE_PICK_MAX` 之后）、`949-980`（`onlineRandom` 整体替换）
- Test: `scripts/test-sync.mjs`（文件末尾、`console.log(failed === 0 ? ...)` 之前追加新段）

**Interfaces:**
- Consumes: 现有 `friendList` / `userIndex` / `seededShuffle` / `mulberry32` / `hashSeed` / `OFFLINE_AFTER_MS` / `todayKey`。
- Produces: `POST /online/random` 响应行新增 `is_friend: true|false`（增量字段，旧客户端 serde 忽略）。行结构 `{ uid, nick, pet_name, state, is_friend }`。好友在前（aff 降序封顶 `ONLINE_FRIEND_MAX = 3`），陌生人在后（维持 3~5 洗牌，继续排除好友与自己）。

- [ ] **Step 1: 写失败测试**

在 `scripts/test-sync.mjs` 末尾（`console.log(failed === 0 ? ...)` 之前）追加：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test:sync`
Expected: FAIL —— `在线好友封顶 3` 一行 FAIL（现在 `is_friend` 恒 undefined，`fr.length === 0`）。

- [ ] **Step 3: 实现**

`lib-account.js` 常量区（59 行 `const ONLINE_PICK_MAX = 5;` 之后）加：

```js
/** 在线总览里好友段的封顶（好友在前，按亲密度降序）。 */
const ONLINE_FRIEND_MAX = 3;
```

用下面的版本整体替换 `onlineRandom`（949-980 行，保留函数名与 `{ok, date, users}` 响应形状）：

```js
/**
 * 今日在线总览：在线好友（亲密度降序、封顶 ONLINE_FRIEND_MAX）+ 陌生人取样。
 * 好友行带 is_friend: true —— 客户端据此画徽标、隐藏打招呼按钮。
 * 陌生人管线不变：同一天同一批（按 uid+日期确定性取样），
 * 继续排除自己、好友、离线者、隐身者。
 */
async function onlineRandom(store, uid) {
  const now = Date.now();
  const date = todayKey(now);
  const friends = await friendList(store, uid);
  const mine = new Set(friends.map((f) => f.uid));

  // 好友段：逐个读心跳，在线且未隐身的按 aff 降序封顶
  const friendRows = [];
  for (const f of friends) {
    const hb = JSON.parse((await store.get(`hb_${f.uid}`)) || "null");
    if (!hb || now - hb.last_seen >= OFFLINE_AFTER_MS) continue;
    if (hb.hidden) continue; // 隐身的好友也不进总览
    const raw = await store.get(`u_${f.uid}`);
    if (!raw) continue;
    const u = JSON.parse(raw);
    friendRows.push({
      uid: f.uid,
      nick: u.nick,
      pet_name: u.pet_name,
      state: hb.state,
      aff: typeof f.aff === "number" ? f.aff : 0,
    });
  }
  friendRows.sort((a, b) => b.aff - a.aff);
  const friendUsers = friendRows.slice(0, ONLINE_FRIEND_MAX).map(
    ({ uid: id, nick, pet_name, state }) => ({ uid: id, nick, pet_name, state, is_friend: true }),
  );

  // 陌生人段：先洗牌再逐个读，凑够人数就停（与原实现一致）
  const idx = await userIndex(store);
  seededShuffle(idx, `${uid}:${date}`);
  const rnd = mulberry32(hashSeed(`${uid}:${date}:count`));
  const want =
    ONLINE_PICK_MIN + Math.floor(rnd() * (ONLINE_PICK_MAX - ONLINE_PICK_MIN + 1));

  const users = [];
  for (const id of idx) {
    if (users.length >= want) break;
    if (id === uid || mine.has(id)) continue;
    const hb = JSON.parse((await store.get(`hb_${id}`)) || "null");
    if (!hb || now - hb.last_seen >= OFFLINE_AFTER_MS) continue;
    if (hb.hidden) continue;
    const raw = await store.get(`u_${id}`);
    if (!raw) continue;
    const u = JSON.parse(raw);
    users.push({ uid: id, nick: u.nick, pet_name: u.pet_name, state: hb.state, is_friend: false });
  }
  return { ok: true, date, users: [...friendUsers, ...users] };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test:sync`
Expected: 全部 PASS（含前段旧断言 —— 它们都在 A 与 H 成友之前执行，列表无好友，行为不变）。

- [ ] **Step 5: 提交**

```bash
git add worker-edgeone/edge-functions/api/lib-account.js scripts/test-sync.mjs
git commit -m "feat(sync): 今日在线改为含好友总览，行加 is_friend

版本: <V>"
```

---

### Task 2: 服务端 — 摸摸 /visit/interact + goHome 事件补昵称

**Files:**
- Modify: `worker-edgeone/edge-functions/api/lib-account.js:42`（常量区，`VISIT_EXPIRE_MS` 之后）、`1034-1053`（`visit` 与 `goHome` 之间新增 `visitInteract`；`goHome` 整体替换）、`1493-1494`（路由）
- Test: `scripts/test-sync.mjs`（末尾追加）、`scripts/test-worker.mjs`（末尾追加）

**Interfaces:**
- Consumes: `activeVisitors`（读时过滤 15 分钟过期并回写）、`addAffinity`（双向同值，条目缺失跳过）、`pushEvent`（512B/20 条）、`cpSlice`、`validUid`、`clean`。
- Produces:
  - `POST /visit/interact {target}`：成功 `{ok: true, pats: N}`；业务错误 `{error: "TA 不在你家做客" | "摸够啦" | "不能摸自己" | "找不到这位访客"}`。
  - 推给访客主人的事件 `{type: "interaction", from_uid, from_nick, pet_name, pats}`（`pats` 为本次串门累计 1..3）。
  - `goHome` 推的 `leave` 事件现在带真实 `from_nick`/`pet_name`（原来是空串，前端无法显示名字）。

- [ ] **Step 1: 写失败测试（test-sync.mjs）**

Task 1 的段之后继续追加。注意：`visit` 本身会 `addAffinity +2`，且 `addAffinity` 双向累加要求**两侧**都有好友条目，所以先补对侧再算期望值（10 + 串门2 + 摸3 = 15）：

```js
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test:sync`
Expected: FAIL —— 路由不存在，`visit/interact` 返回 `{error: "not found", _status: 404}`。

- [ ] **Step 3: 实现**

`lib-account.js` 常量区 `const VISIT_EXPIRE_MS = 15 * 60 * 1000;`（42 行）之后加：

```js
/** 摸摸上限：单次串门每位访客最多摸 3 下（服务端计数权威）。 */
const PAT_MAX = 3;
```

在 `visit` 结束（1034 行 `}`）与 `goHome`（1036 行）之间新增：

```js
/**
 * 摸摸家里的访客。只能作用于「自己家 visitors 名单里且未过期」的对象 ——
 * 名单之外一律拒，杜绝匿名遍历。计数落在访客条目上（pats），
 * 每次成功：pats+1、双方亲密度 +1、向访客主人推 interaction 事件。
 */
async function visitInteract(store, uid, bodyReq) {
  const target = clean(bodyReq.target);
  if (!validUid(target)) return { error: "找不到这位访客" };
  if (target === uid) return { error: "不能摸自己" };

  const visitors = await activeVisitors(store, uid);
  const v = visitors.find((x) => x.uid === target);
  if (!v) return { error: "TA 不在你家做客" };
  if ((v.pats ?? 0) >= PAT_MAX) return { error: "摸够啦" };

  v.pats = (v.pats ?? 0) + 1;
  await store.put(`visitors_${uid}`, JSON.stringify(visitors));
  await addAffinity(store, uid, target, 1);

  const meUser = JSON.parse(await store.get(`u_${uid}`));
  await pushEvent(store, target, {
    type: "interaction",
    from_uid: uid,
    from_nick: cpSlice(meUser.nick, 24),
    pet_name: cpSlice(meUser.pet_name, 16),
    pats: v.pats,
  });
  return { ok: true, pats: v.pats };
}
```

用下面的版本替换 `goHome`（1036-1053 行）：

```js
async function goHome(store, uid, bodyReq) {
  const target = bodyReq && bodyReq.target ? clean(bodyReq.target) : null;
  if (validUid(target)) {
    const key = `visitors_${target}`;
    const list = JSON.parse((await store.get(key)) || "[]");
    const next = list.filter((v) => v.uid !== uid);
    if (next.length !== list.length) {
      await store.put(key, JSON.stringify(next));
      // from_nick 必须带上：主人端要显示「XX 的宠物回家了」，
      // 空串会被前端当无名事件丢弃（旧版本的 bug）
      const meUser = JSON.parse(await store.get(`u_${uid}`));
      await pushEvent(store, target, {
        type: "leave",
        from_uid: uid,
        from_nick: cpSlice(meUser.nick, 24),
        pet_name: cpSlice(meUser.pet_name, 16),
      });
    }
  }
  return { ok: true };
}
```

路由（1493 行 `if (method === "POST" && path === "visit")` 之后、`home` 之前）加：

```js
  if (method === "POST" && path === "visit/interact") {
    return await visitInteract(store, auth.uid, body);
  }
```

- [ ] **Step 4: 跑 test-sync 确认通过**

Run: `pnpm test:sync`
Expected: 全部 PASS。

- [ ] **Step 5: 写 Cloudflare 适配层测试（test-worker.mjs）**

在 `scripts/test-worker.mjs` 的 `console.log(failed === 0 ? ...)` 之前追加。背景：worker 测试里 A 在 135 行串门后一直留在 B 的访客名单（无人调 /home），150-153 行两人已成好友，A 的事件队列里只有一条 accept 事件待拉：

```js
// ---------- 摸摸与回家事件（visit/interact + leave 带 nick 过适配层） ----------
const wPat1 = await call("POST", "/api/visit/interact", { target: a.uid }, b.token);
ok(wPat1.status === 200 && wPat1.json.pats === 1, `摸一下过适配层：${JSON.stringify(wPat1.json)}`);
await call("POST", "/api/visit/interact", { target: a.uid }, b.token);
const wPat3 = await call("POST", "/api/visit/interact", { target: a.uid }, b.token);
ok(wPat3.json.pats === 3, `第三下 pats=3：${wPat3.json.pats}`);
const wPat4 = await call("POST", "/api/visit/interact", { target: a.uid }, b.token);
ok(wPat4.status === 400 && wPat4.json.error === "摸够啦", `第四下被拒：${JSON.stringify(wPat4.json)}`);
const wPatNope = await call("POST", "/api/visit/interact", { target: c.uid }, b.token);
ok(wPatNope.status === 400, `不在家的不能摸：${wPatNope.json.error}`);

const wHbA = await call("POST", "/api/heartbeat", { state: "idle", affinity: 0, pet_name: "甲崽" }, a.token);
const wPats = (wHbA.json.events ?? [])
  .filter((e) => e.event?.type === "interaction")
  .map((e) => e.event.pats);
ok(JSON.stringify(wPats) === "[1,2,3]", `出门方收到递增摸摸事件：${JSON.stringify(wPats)}`);

await call("POST", "/api/home", { target: b.uid }, a.token);
const wHbB = await call("POST", "/api/heartbeat", { state: "idle", affinity: 0, pet_name: "乙崽" }, b.token);
const wLeave = (wHbB.json.events ?? []).find((e) => e.event?.type === "leave");
ok(wLeave && wLeave.event.from_nick === "甲_a1b2c3", `leave 事件带昵称：${JSON.stringify(wLeave?.event)}`);
```

- [ ] **Step 6: 跑两套测试确认通过**

Run: `pnpm test:sync && pnpm test:worker`
Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```bash
git add worker-edgeone/edge-functions/api/lib-account.js scripts/test-sync.mjs scripts/test-worker.mjs
git commit -m "feat(sync): 摸摸端点 /visit/interact（限3下+亲密度+事件）；goHome 补昵称

版本: <V>"
```

---

### Task 3: Rust — OnlineUser.is_friend + visitor_interact 命令

**Files:**
- Modify: `src-tauri/src/socialcmd.rs:198-214`（`OnlineUser` 改造 + `return_home` 之后新增命令）、`src-tauri/src/main.rs:98`（命令注册）
- Test: `src-tauri/src/socialcmd.rs`（`mod tests` 内新增）

**Interfaces:**
- Consumes: `account::valid_target`（`Result<String, String>`）、`crate::syncclient::post_authed`。
- Produces:
  - `OnlineUser` 新字段 `#[serde(default)] pub is_friend: bool`（旧服务端窗口期缺省 false）。
  - `#[tauri::command] pub async fn visitor_interact(target_uid: String) -> Result<(), String>`：服务端业务错误（如「摸够啦」）折叠为 `Err(中文文案)` 直传前端。

- [ ] **Step 1: 写失败测试**

`socialcmd.rs` 的 `mod tests` 内追加：

```rust
#[test]
fn 在线行缺_is_字段按陌生人解析() {
    // 旧服务端不回 is_friend（部署窗口期），serde(default) 必须兜住，
    // 否则整包解析失败、在线面板直接空
    let v = serde_json::json!([
        { "uid": "12345678", "nick": "a", "pet_name": "b", "state": "idle" }
    ]);
    let got: Vec<OnlineUser> = serde_json::from_value(v).expect("应能解析");
    assert!(!got[0].is_friend);
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test 在线行缺`
Expected: 编译失败（`is_friend` 字段不存在）。

- [ ] **Step 3: 实现**

`OnlineUser` 结构体改为：

```rust
/// 今日在线的一条总览行（好友在前按亲密度、陌生人按日期确定性取样）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OnlineUser {
    pub uid: String,
    pub nick: String,
    pub pet_name: String,
    pub state: String,
    /// 是否好友。旧服务端不回该字段时缺省 false（部署窗口期按陌生人渲染）
    #[serde(default)]
    pub is_friend: bool,
}
```

`return_home` 命令之后新增：

```rust
/// 摸摸家里的访客。前端本地先行反馈，此命令 fire-and-forget 上报；
/// 服务端计数权威（单次串门限 3 下），业务错误以中文文案带回。
#[tauri::command]
pub async fn visitor_interact(target_uid: String) -> Result<(), String> {
    let target = account::valid_target(&target_uid)?;
    crate::syncclient::post_authed(
        "/visit/interact",
        &serde_json::json!({ "target": target }),
    )
    .await?;
    Ok(())
}
```

`src-tauri/src/main.rs` 命令列表（`socialcmd::return_home,` 一行之后）加：

```rust
            socialcmd::visitor_interact,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test && cargo check`
Expected: 全部 PASS，无警告。

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/socialcmd.rs src-tauri/src/main.rs
git commit -m "feat(social): Rust 透传 is_friend；新增 visitor_interact 命令

版本: <V>"
```

---

### Task 4: Rust — 串门被拒通知 + interaction 事件带 pats

**Files:**
- Modify: `src-tauri/src/socialdrive.rs:588-590`（串门循环 `Err(e)` 分支）、`675-680`（`handle_event` 的 `"interaction"` 分支）

**Interfaces:**
- Consumes: `EVENT_SOCIAL`（`pet://social`）、`app.emit`（同作用域 603 行已有 `app.emit(EVENT_VISITORS, ...)` 用法）。
- Produces:
  - 串门被拒时 emit `{event: {type: "visit_rejected", nick, pet_name}}`（`pet_name` 暂为空串，前端文案只用 nick）。
  - `interaction` 事件转发时补 `pats`（u64，缺省 1）：`{event: {type: "interaction", from_nick, pats}}`。
  - 事件名为 `interaction`（沿用 Rust/前端已有的半截分支，不改为设计文档草稿里的 `interacted` —— 改名无收益还要动两处）。

无新增单测（emit 路径依赖 AppHandle，无法单测；验证 = 既有 `cargo test` 全绿 + Task 10 手工清单）。

- [ ] **Step 1: 实现被拒通知**

`socialdrive.rs` 588-590 行的 `Err(e) => eprintln!("[social] 串门被拒：{e}");` 分支改为：

```rust
                                            Err(e) => {
                                                eprintln!("[social] 串门被拒：{e}");
                                                // 被拒也该让主人知道，
                                                // 不然「想出门没出门」毫无痕迹
                                                let _ = app.emit(
                                                    EVENT_SOCIAL,
                                                    serde_json::json!({
                                                        "event": {
                                                            "type": "visit_rejected",
                                                            "nick": t.nick,
                                                            "pet_name": "",
                                                        }
                                                    }),
                                                );
                                            }
```

（`t` 是串门目标候选行，同分支上文已解构出 `t.nick`；若该分支里变量名不同，以实际为准——语义是「把被拒目标的昵称带给前端」。）

- [ ] **Step 2: 实现 interaction 补 pats**

`handle_event` 的 `"interaction" =>` 分支改为：

```rust
        "interaction" => {
            affinity.on_interacted();
            let pats = e["event"]["pats"].as_u64().unwrap_or(1);
            let _ = app.emit(
                EVENT_SOCIAL,
                serde_json::json!({ "event": { "type": "interaction", "from_nick": from_nick, "pats": pats } }),
            );
        }
```

（保留分支里已有的其他语句，只补 `pats` 透传；`from_nick` 取值方式沿用分支现状。）

- [ ] **Step 3: 跑测试确认无回归**

Run: `cd src-tauri && cargo test && cargo check`
Expected: 全部 PASS。

- [ ] **Step 4: 提交**

```bash
git add src-tauri/src/socialdrive.rs
git commit -m "feat(social): 串门被拒通知前端；interaction 事件透传摸摸次数

版本: <V>"
```

---

### Task 5: 前端 — 好友面板「好友」徽标

**Files:**
- Modify: `src/overlay/friends.ts:26-32`（`OnlineRow`）、`389-419`（`onlineRow` 渲染）
- Modify: `index.html`（`.pet-friend-aff` 规则之后加 `.pet-friend-badge`，约 402-406 行处）

**Interfaces:**
- Consumes: Task 3 的 `OnlineUser.is_friend`（经 `invoke<OnlineRow[]>("online_random")` 直达 `OnlineRow`）。
- Produces: 好友行显示「好友」徽标、不显示打招呼按钮；陌生人行不变。空态文案不改（新语义下自然成立）。

无单测（纯 DOM 渲染）；验证 = `npx tsc --noEmit` + 既有 vitest 全绿。

- [ ] **Step 1: 类型与渲染**

`friends.ts` 的 `OnlineRow` 接口加字段：

```ts
  /** 好友行（服务端合并的在线总览）：画徽标、不画打招呼按钮 */
  is_friend?: boolean;
```

`onlineRow(u)` 方法：在 `state` 元素创建之后、打招呼按钮创建之前插入好友分支。整个方法改为：

```ts
  private onlineRow(u: OnlineRow): HTMLElement {
    const row = document.createElement("div");
    row.className = "pet-friend-row";

    const dot = document.createElement("span");
    dot.className = "pet-friend-dot";
    dot.style.background = STATE_COLOR[u.state] ?? "#5a6478";

    const main = document.createElement("span");
    main.className = "pet-friend-nick";
    main.textContent = `${u.nick} 的 ${u.pet_name}`;
    main.title = `uid: ${u.uid}`;

    const state = document.createElement("span");
    state.className = "pet-friend-state";
    state.style.color = STATE_COLOR[u.state] ?? "#5a6478";
    state.textContent = STATE_LABEL[u.state] ?? u.state;

    // 好友行：徽标代替按钮 —— 好友操作集中在下方列表，这里不重复入口
    if (u.is_friend) {
      const badge = document.createElement("span");
      badge.className = "pet-friend-badge";
      badge.textContent = "好友";
      row.append(dot, main, state, badge);
      return row;
    }

    const btn = document.createElement("button");
    btn.className = "pet-greet-btn";
    btn.textContent = "打招呼";
    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      void this.doGreet(u.uid);
    });
    this.greetBtns.set(u.uid, btn);
    this.applyCooldown(u.uid);

    row.append(dot, main, state, btn);
    return row;
  }
```

（若现有 `onlineRow` 的实现与上方骨架有出入——如 `main.title`、冷却逻辑位置不同——以现有实现为准只插入 `if (u.is_friend)` 分支，不重排其他逻辑。）

- [ ] **Step 2: CSS**

`index.html` 中 `.pet-friend-aff` 规则之后加：

```css
      .pet-friend-badge {
        flex: 0 0 auto;
        padding: 1px 6px;
        border: 1px solid #ffe066;
        border-radius: 4px;
        color: #ffe066;
        font-size: 10px;
        line-height: 1.4;
      }
```

- [ ] **Step 3: 验证**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 均通过。

- [ ] **Step 4: 提交**

```bash
git add src/overlay/friends.ts index.html
git commit -m "feat(friends): 今日在线好友行画徽标，不再显示打招呼按钮

版本: <V>"
```

---

### Task 6: 前端 — 气泡收拢（bannerStackPos 锚链）

**Files:**
- Modify: `src/overlay/bubble.ts:5`（常量区）、`257-296`（`Banner.show`）、`303-354`（`showCard`）、`513-529`（`follow`）、`538-546`（`releaseFromPet`）
- Modify: `src/main.ts:588-602`（`notifyNearPet`）、`704-707`（渲染循环）
- Test: `tests/banner-stack.test.ts`（新建）

**Interfaces:**
- Consumes: `Box`（`src/interact/hit-test.ts`）、`TAIL_GAP`（=10，bubble.ts:5）。**现状**：`Banner.show` 已有 `opts.followPet`（默认 false）、`follow(body)` 已存在且渲染循环已每帧调用、`releaseFromPet()` 目前直接 dismiss、`showCard` 恒右上角。
- Produces:
  - `export function bannerStackPos(pet: Box | null, avoid: Box | null, size: {w,h}, screen: {w,h}): {x,y} | null`（bubble.ts 导出纯函数；`pet === null` → null）。
  - `Banner.show(text, time?, opts?: {followPet?: boolean; autoDismissMs?: number})` —— `followPet` **默认 true**（没有可贴身体时自动退回右上角）；`autoDismissMs` 覆盖默认 10 分钟。已核对全部 `banner.show` 调用方：仅 `main.ts` notifyNearPet（596 隐身路径 / 599 可见路径），翻转默认安全。
  - `Banner.follow(body: Box, avoid?: Box | null)`（第二参为可选的主气泡矩形）。
  - `Banner.releaseFromPet()`：改为**保内容**退回右上角（原来直接 dismiss），并清空 `body`。
  - `showCard` 在有身体可贴时锚定头顶（好友回执卡收拢），无身体退右上角；`showReminder` 维持右上角不动。
  - `notifyNearPet(text: string, autoDismissMs = 8000)`（main.ts）。

- [ ] **Step 1: 写失败测试**

新建 `tests/banner-stack.test.ts`（bubble.ts 及其依赖 panel-drag 均无顶层 DOM 访问，node 环境可导入）：

```ts
import { describe, expect, it } from "vitest";
import { bannerStackPos } from "../src/overlay/bubble";

const size = { w: 200, h: 40 };
const screen = { w: 1440, h: 900 };
const pet = { x: 100, y: 800, w: 64, h: 64 };

describe("通知条锚链定位", () => {
  it("宠物不在家 → null（走右上角）", () => {
    expect(bannerStackPos(null, null, size, screen)).toBeNull();
  });

  it("无主气泡：贴宠物头顶（间隙 TAIL_GAP=10）", () => {
    expect(bannerStackPos(pet, null, size, screen)).toEqual({ x: 32, y: 750 });
  });

  it("主气泡在头顶：让到主气泡上方（再留 10 间隙）", () => {
    const bub = { x: 40, y: 640, w: 180, h: 50 };
    expect(bannerStackPos(pet, bub, size, screen)?.y).toBe(640 - 10 - 40);
  });

  it("宠物贴屏幕顶：整体翻到脚下", () => {
    const topPet = { x: 100, y: 8, w: 64, h: 64 };
    expect(bannerStackPos(topPet, null, size, screen)?.y).toBe(8 + 64 + 10);
  });

  it("宠物贴顶且主气泡在脚下：叠到主气泡下面", () => {
    const topPet = { x: 100, y: 8, w: 64, h: 64 };
    const bubBelow = { x: 40, y: 82, w: 180, h: 50 };
    expect(bannerStackPos(topPet, bubBelow, size, screen)?.y).toBe(82 + 50 + 10);
  });

  it("水平方向贴边钳制（不飘出屏幕）", () => {
    const edgePet = { x: 0, y: 800, w: 64, h: 64 };
    expect(bannerStackPos(edgePet, null, size, screen)?.x).toBe(4);
    const rightPet = { x: 1376, y: 800, w: 64, h: 64 };
    expect(bannerStackPos(rightPet, null, size, screen)?.x).toBe(1440 - 200 - 4);
  });

  it("主气泡在头顶但头顶叠不下：翻到脚下", () => {
    const highPet = { x: 100, y: 120, w: 64, h: 64 };
    const bubHigh = { x: 40, y: 4, w: 180, h: 50 };
    // 头顶放 banner：120-40-10=70 放得下，但叠到气泡上方 4-10-40<4 放不下
    expect(bannerStackPos(highPet, bubHigh, size, screen)?.y).toBe(120 + 64 + 10);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/banner-stack.test.ts`
Expected: FAIL —— `bannerStackPos` 未导出。

- [ ] **Step 3: 实现纯函数**

`bubble.ts` 常量区（`TAIL_GAP` 之后）加：

```ts
/** 锚链（宠物头 → 主气泡 → 通知条）之间的间隙。 */
const STACK_GAP = 10;

/**
 * 通知条在锚链中的位置（纯函数，供单测与 Banner.follow 共用）。
 *
 * 顺序：宠物头 → 主气泡 → 通知条，沿远离宠物的方向依次纵向排开；
 * 头顶放不下时整体翻到脚下（与主气泡同一规则）。
 * @param pet 宠物身体；null 表示宠物不在家（返回 null，走右上角）
 * @param avoid 主气泡矩形；null 表示主气泡没开
 */
export function bannerStackPos(
  pet: Box | null,
  avoid: Box | null,
  size: { w: number; h: number },
  screen: { w: number; h: number },
): { x: number; y: number } | null {
  if (!pet) return null;
  const x = Math.round(
    Math.max(4, Math.min(screen.w - size.w - 4, pet.x + pet.w / 2 - size.w / 2)),
  );
  const aboveY = pet.y - size.h - TAIL_GAP;
  const belowY = Math.min(pet.y + pet.h + TAIL_GAP, screen.h - size.h - 4);
  // 主气泡相对宠物的位置：在上半还是下半
  const avoidAbove = avoid !== null && avoid.y + avoid.h <= pet.y + pet.h / 2;
  const avoidBelow = avoid !== null && avoid.y >= pet.y + pet.h / 2;
  const stackBelow = Math.round(
    Math.max(
      4,
      avoidBelow ? Math.min(screen.h - size.h - 4, avoid.y + avoid.h + STACK_GAP) : belowY,
    ),
  );
  if (aboveY >= 4) {
    const stacked = avoidAbove ? avoid.y - STACK_GAP - size.h : aboveY;
    if (stacked >= 4) return { x, y: Math.round(stacked) };
    return { x, y: stackBelow }; // 头顶叠不下：整体翻脚下
  }
  return { x, y: stackBelow };
}
```

- [ ] **Step 4: 跑纯函数测试确认通过**

Run: `npx vitest run tests/banner-stack.test.ts`
Expected: PASS。

- [ ] **Step 5: Banner 接线（四处增量改造）**

(a) `show`（257-296 行）：签名加 `autoDismissMs`、默认翻转为 true、无身体兜底。开头改为：

```ts
  /**
   * 显示通知条。
   * @param opts.followPet 贴着宠物头顶显示（默认 true —— 轻通知都收拢到
   *        宠物头上）；没有可贴的身体（不在家）或显式 false 时走右上角
   * @param opts.autoDismissMs 自动收起时间；缺省 10 分钟
   */
  show(
    text: string,
    time?: string,
    opts: { followPet?: boolean; autoDismissMs?: number } = {},
  ): void {
    this.anchored = opts.followPet ?? true;
    if (this.anchored && !this.body) this.anchored = false; // 不在家：退右上角
    this.setAnchored(this.anchored);
```

（方法体其余不动；末尾已有的 `if (this.anchored && this.body) this.follow(this.body);` 保留。）定时器一段改为：

```ts
    if (this.timer) clearTimeout(this.timer);
    // 重要提醒也不过期自动关 —— 用户可能刚好不在，回来还要能看到。
    // 但如果 10 分钟还没人理，也别一直挂着（可被 autoDismissMs 覆盖）
    this.timer = setTimeout(() => this.dismiss(), opts.autoDismissMs ?? 10 * 60 * 1000);
```

(b) `showCard`（303-354 行）：开头两行 `this.anchored = false; this.setAnchored(false);` 改为：

```ts
    // 好友回执这类轻操作卡：宠物在家就贴头顶，不在家退回右上角
    this.anchored = this.body !== null;
    this.setAnchored(this.anchored);
```

并在方法末尾 `this.open = true;` 之后加：

```ts
    if (this.anchored && this.body) this.follow(this.body);
```

(c) `follow`（508-529 行）改为（定位逻辑换成纯函数 + 可选避让）：

```ts
  /**
   * 渲染循环每帧调用：贴宠物模式下跟随身体。
   * @param avoid 主气泡矩形 —— 锚链防重叠：头顶/脚下都让主气泡先挑位置
   */
  follow(body: Box, avoid?: Box | null): void {
    this.body = body;
    if (!this.open || !this.anchored) return;
    const pos = bannerStackPos(
      body,
      avoid ?? null,
      { w: this.el.offsetWidth, h: this.el.offsetHeight },
      { w: window.innerWidth, h: window.innerHeight },
    );
    if (!pos) return;
    this.el.style.left = `${pos.x}px`;
    this.el.style.top = `${pos.y}px`;
  }
```

(d) `releaseFromPet`（538-546 行）改为：

```ts
  /**
   * 宠物离家：贴身通知退回右上角，内容保留（不在家也不丢消息）。
   * 同时清空身体引用 —— 之后 showCard/show 不该再锚到过期位置。
   */
  releaseFromPet(): void {
    this.body = null;
    if (this.open && this.anchored) this.setAnchored(false);
    this.anchored = false;
  }
```

- [ ] **Step 6: main.ts 接线**

`notifyNearPet`（588-602 行）改为：

```ts
/**
 * 贴着宠物头顶的通知条。
 *
 * 宠物相关的通知就该长在宠物身上 —— 固定在右上角会让人找不着是谁在说话。
 * 宠物不在家（去串门）时没有身体可贴，show 内部自动退回右上角。
 */
function notifyNearPet(text: string, autoDismissMs = 8000): void {
  banner.show(text, undefined, { followPet: true, autoDismissMs });
  // 立刻定位一次（带上主气泡让位），避免上屏第一帧闪在右上角
  if (!pet.isHidden) banner.follow(pet.body, bubble.box);
}
```

渲染循环（704-707 行）改为：

```ts
  if (drew) {
    bubble.follow(pet.body);
    banner.follow(pet.body, bubble.box);
  }
```

- [ ] **Step 7: 全量验证**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 均通过（`notifyNearPet` 现有调用方不传第二参，默认 8000 与旧行为等量级；隐身路径 `banner.show(text)` 在新默认下经 `!body` 兜底仍走右上角）。

- [ ] **Step 8: 提交**

```bash
git add src/overlay/bubble.ts src/main.ts tests/banner-stack.test.ts
git commit -m "feat(bubble): 轻通知默认贴宠物头顶，锚链防重叠；离家保内容退右上角

版本: <V>"
```

---

### Task 7: 前端 — 伙伴式跟随（followStep）

**Files:**
- Modify: `src/guest/guest-pet.ts:29`（常量区 `LEAVE_MS` 之后）、`65-106`（字段 + 构造）、`181-195`（`tick` 内 `behavior.update` 之前插跟随逻辑）
- Modify: `src/guest/index.ts:23-27`（构造）、`73-87`（`sync` 出生点）
- Modify: `src/anim/behavior.ts:212`（`goto` 之后新增 `face`）
- Modify: `src/main.ts:143`（`guests` 构造）
- Test: `tests/guest.test.ts`（更新既有构造调用 + 新增用例）

**Interfaces:**
- Consumes: `Behavior`（`goto(x, maxX)` 钳制 / `placeAt(x, y)` 重锚并清 targetX / `current.facing`）；`WALK_SPEED = 130`。
- Produces:
  - `export function followStep(me: number, host: number | null, offset: number, side: number, boundsWidth: number): number | null`（guest-pet.ts 导出纯函数）。目标左上角 x = `host中心x + offset - side/2`，钳制 `[0, boundsWidth-side]`；距离 ≤ 1.5 身位返回 null（原地待着）。
  - `Behavior.face(dir: -1 | 1)`（**本任务添加**；Task 9 的 `stopGoto` 在 Task 9 加）。
  - `GuestPet` 构造 opts 增加 `host: () => Box | null`；字段 `followOffset`（[-1.2, 1.2, -2.2] × side）、`chasing`。
  - `GuestRegistry` 构造第 4 参 `host: () => Box | null`；出生点改为「靠近主宠物一侧的屏幕边缘」（host 为 null 时回退旧槽位比例）。

- [ ] **Step 1: 写失败测试**

`tests/guest.test.ts`：所有 `new GuestPet(seed, { x: 100, y: 600, side: 64, nowMs: 0, index: 0 })` 调用加 `host: () => null`；所有 `new GuestRegistry(fakeCtx(), fakeCanvas(), 64)` 加第 4 参 `() => null`。文件头部 import 改为：

```ts
import { avatarForUid, followStep, GuestPet } from "../src/guest/guest-pet";
```

然后新增：

```ts
describe("伙伴式跟随判定（followStep）", () => {
  it("主人不在家 → 不跟", () => {
    expect(followStep(100, null, -77, 64, 1440)).toBeNull();
  });

  it("距离在 1.5 身位内 → 原地待着", () => {
    // 目标左上角 x = 1000 - 77 - 32 = 891，距我 900 只差 9（≤ 96）
    expect(followStep(900, 1000, -77, 64, 1440)).toBeNull();
  });

  it("距离超过阈值 → 追向目标位（host 中心 + 偏移 - 半身）", () => {
    // 目标 = 1000 - 77 - 32 = 891
    expect(followStep(100, 1000, -77, 64, 1440)).toBe(891);
    expect(followStep(1400, 1000, -77, 64, 1440)).toBe(891);
  });

  it("目标位被钳制在屏幕内", () => {
    // 左侧：5 - 77 - 32 = -104 → 0
    expect(followStep(400, 5, -77, 64, 1440)).toBe(0);
    // 右侧：1435 + 77 - 32 = 1480 → 1440-64
    expect(followStep(100, 1435, 77, 64, 1440)).toBe(1440 - 64);
  });
});

describe("伙伴式跟随（GuestPet）", () => {
  it("主宠物在右侧：访客从左缘走进，停在一旁并对齐脚线", () => {
    const ctx = fakeCtx();
    const host = { x: 1000, y: 836, w: 64, h: 64 };
    const g = new GuestPet(seed, {
      x: 0, y: 836, side: 64, nowMs: 0, index: 0, host: () => host,
    });
    expect(g.isBusy).toBe(false); // 出发前待机
    // 目标位（访客左上角 x）= 主宠物中心 1032 - 1.2 身位 - 半身 ≈ 923
    const want = host.x + host.w / 2 - 1.2 * 64 - 64 / 2;
    let now = 0;
    let arrived = -1;
    for (let i = 0; i < 600 && arrived < 0; i++) {
      now += 50;
      g.tick(now, ctx, { width: 1440, height: 900 });
      if (Math.abs(g.body.x - want) <= 96) arrived = i;
    }
    expect(arrived).toBeGreaterThanOrEqual(0); // 真的走过去了
    // 到位后下一拍：placeAt 重锚 + 脚线对齐 + 回待机
    g.tick(now + 50, ctx, { width: 1440, height: 900 });
    expect(Math.abs(g.body.x - want)).toBeLessThanOrEqual(96); // 停在主宠物身旁
    expect(g.body.y).toBe(836); // 脚线对齐（y = host.y + host.h - side）
    expect(g.isBusy).toBe(false); // 就位后不再要求高帧率（CPU 红线）
  });

  it("index 1 的访客目标在主宠物右侧（正偏移）", () => {
    // 目标 = 232 + 76.8 - 32 = 276.8
    expect(followStep(1200, 232, 1.2 * 64, 64, 1440)).toBeCloseTo(232 + 76.8 - 32, 5);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/guest.test.ts`
Expected: FAIL —— `followStep` 未导出、构造参数缺 `host`。

- [ ] **Step 3: 实现 followStep 与 GuestPet 跟随**

`guest-pet.ts` 常量区（`LEAVE_MS` 之后）加：

```ts
/** 跟随判定阈值：与目标位距离超过 1.5 个身位才开始追。 */
export const FOLLOW_THRESHOLD_RATIO = 1.5;
/** 多访客的跟随间距（有符号，单位 = 身位倍数）：左 / 右 / 远左，错开防重叠。 */
const FOLLOW_OFFSETS = [-1.2, 1.2, -2.2];

/**
 * 伙伴式跟随的下一步目标（纯函数，供单测）。
 *
 * @param me 访客当前 x（左上角）
 * @param host 主宠物中心 x；null = 主人不在家，不跟
 * @param offset 目标间距（有符号像素：负在主宠物左侧、正在右侧）
 * @returns 需要走时的目标 x（左上角坐标，已钳制屏幕内）；null = 距离够近，原地待着
 */
export function followStep(
  me: number,
  host: number | null,
  offset: number,
  side: number,
  boundsWidth: number,
): number | null {
  if (host === null) return null;
  const maxX = Math.max(0, boundsWidth - side);
  const target = Math.max(0, Math.min(maxX, host + offset - side / 2));
  if (Math.abs(target - me) <= side * FOLLOW_THRESHOLD_RATIO) return null;
  return target;
}
```

`GuestPet` 字段区加：

```ts
  /** 主宠物身体供应商（null = 主人不在家：不跟随，原地小范围晃悠）。 */
  private readonly host: () => Box | null;
  /** 跟随间距（像素，有符号）。 */
  private readonly followOffset: number;
  /** 正在追主宠物（用于到达检测 → 重锚）。 */
  private chasing = false;
```

构造函数（87-106 行）改为（只在现有基础上加三行赋值与 opts 类型）：

```ts
  constructor(
    seed: GuestSeed,
    opts: {
      x: number;
      y: number;
      side: number;
      nowMs: number;
      index: number;
      host: () => Box | null;
    },
  ) {
    this.seed = seed;
    this.avatar = avatarForUid(seed.uid);
    this.side = opts.side;
    this.startMs = opts.nowMs;
    this.phaseOffset = opts.index * 470;
    this.host = opts.host;
    this.followOffset = FOLLOW_OFFSETS[opts.index % FOLLOW_OFFSETS.length] * opts.side;

    let s = (opts.index + 1) * 7919;
    const rng = () => {
      s = (Math.imul(s, 1103515245) + 12345) & 0x7fffffff;
      return s / 0x7fffffff;
    };
    // nearby 范围：以出生点为锚小范围晃悠，不会满屏乱跑
    this.behavior = new Behavior(opts.x, opts.y, rng);
    this.behavior.setActionStyle(this.avatar.actionStyle);
    this.expr = new MicroExpression(rng);
  }
```

`tick` 里 `const safeDt = ...` 之后、`if (safeDt > 0) { this.behavior.update(...) }` 之前插入：

```ts
    // 伙伴式跟随：离主宠物太远就追，追上后把锚点重设在它身边
    //（之后的小范围晃悠围绕新家，主宠物照常游走不受影响）。
    // 放在 update 之前、不受渲染帧率门限影响 —— goto 指令每拍都该下发。
    if (!this.leaving) {
      const host = this.host();
      if (host) {
        const hostCx = host.x + host.w / 2;
        const st0 = this.behavior.current;
        const target = followStep(st0.x, hostCx, this.followOffset, this.side, bounds.width);
        if (target !== null) {
          this.chasing = true;
          this.behavior.goto(target, bounds.width);
        } else if (this.chasing) {
          this.chasing = false;
          // 就位：重锚 + 脚线对齐主宠物，面向它
          this.behavior.placeAt(st0.x, Math.round(host.y + host.h - this.side));
          this.behavior.face(hostCx >= st0.x ? 1 : -1);
        }
      }
    }
```

`src/anim/behavior.ts` 的 `goto` 方法（206-212 行）之后加（Task 7 就加，供上面编译）：

```ts
  /** 定向：待机时面向某方向（对话/跟随面对面用）。走动中无效 —— 朝向由目标决定。 */
  face(dir: -1 | 1): void {
    if (this.targetX !== null) return;
    this.state.facing = dir;
  }
```

- [ ] **Step 4: GuestRegistry 出生点**

`src/guest/index.ts` 构造函数（23-27 行）加第 4 参：

```ts
  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly canvas: HTMLCanvasElement,
    private side: number,
    private readonly host: () => Box | null,
  ) {}
```

`sync` 的「新面孔 → 找空位坐下」块（73-87 行）改为：

```ts
    // 新面孔 → 从靠近主宠物一侧的屏幕边缘出生，跟随逻辑牵引它走过去
    for (const s of want) {
      if (this.list.some((g) => g.seed.uid === s.uid)) continue;
      const slot = this.slots.findIndex((g) => g === null);
      if (slot < 0) continue; // 满了就等下一拍，不挤掉正在淡出的
      const host = this.host();
      const x = host
        ? host.x + host.w / 2 < this.canvas.width / 2
          ? 0
          : this.canvas.width - this.side
        : Math.round(this.canvas.width * (SPAWN_RATIOS[slot] ?? 0.5) - this.side / 2);
      const y = host
        ? Math.round(host.y + host.h - this.side)
        : Math.round(this.canvas.height * BASE_Y_RATIO);
      const g = new GuestPet(s, {
        x,
        y,
        side: this.side,
        nowMs,
        index: slot,
        host: this.host,
      });
      this.slots[slot] = g;
      arrived.push(g);
    }
```

（出生点直接用 0 / width-side 而不是屏幕外：`Behavior` 的位置在 `continueWalk` 里被钳制在 `[0, maxX]`，屏幕外出生第一拍就会被拽回 0，白白丢一次位移。）

`main.ts` 143 行构造调用改为（host 供应商：隐藏时给 null）：

```ts
const guests = new GuestRegistry(ctx2d, canvas, 48, () =>
  pet.isHidden ? null : pet.body,
);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/guest.test.ts && npx tsc --noEmit`
Expected: 均通过。

- [ ] **Step 6: 提交**

```bash
git add src/guest/guest-pet.ts src/guest/index.ts src/anim/behavior.ts src/main.ts tests/guest.test.ts
git commit -m "feat(guest): 访客伙伴式跟随主宠物（边缘进场、1.5 身位阈值、脚线对齐）

版本: <V>"
```

---

### Task 8: 前端 — 访客可点击摸摸

**Files:**
- Modify: `src/guest/guest-pet.ts`（常量区 + 字段 + `walkTo` 之后加 `pat` + tick 内桃心特效与表情）
- Modify: `src/guest/guest-dialog.ts:43`（`HOST_REPLY` 之后加话术与导出）、`88`（`onLeave` 之后加 `react`）
- Modify: `src/guest/index.ts:117`（`bodies` getter 之后加 `hit`）
- Modify: `src/main.ts:252-253`（pointerdown 插访客命中）、`411-416`（上报组装）
- Test: `tests/guest.test.ts`（新增摸摸段）

**Interfaces:**
- Consumes: Task 3 `invoke("visitor_interact", { targetUid })`；`Box`。
- Produces:
  - `GuestPet.pat(nowMs): string | null` —— 本地计数先行（上限 3 与服务端一致），成功返回 null、拒绝返回文案；触发桃心特效（棋盘点阵，无半透明）+ `poked` 表情 1.6s。
  - `export const PAT_MAX_LOCAL = 3`（guest-pet.ts）。
  - `GuestRegistry.hit(px, py): GuestPet | null`（离场中的访客不可摸，从后往前找）。
  - `GuestDialog.react(g: GuestPet, text: string)` —— 摸摸反应短气泡（3 秒）。
  - `export function patReaction(): string`（guest-dialog.ts，摸摸话术）。
  - 访客身体矩形进穿透上报（不进 lock —— 点一下即走）。

- [ ] **Step 1: 写失败测试**

`tests/guest.test.ts` 新增：

```ts
describe("摸摸（本地先行计数）", () => {
  it("三下成功，第四下拒绝并给文案", () => {
    const g = new GuestPet(seed, { x: 100, y: 600, side: 64, nowMs: 0, index: 0, host: () => null });
    expect(g.pat(1000)).toBeNull();
    expect(g.pat(1100)).toBeNull();
    expect(g.pat(1200)).toBeNull();
    expect(g.pat(1300)).toBe("摸够啦");
  });

  it("离场中的访客不可摸", () => {
    const g = new GuestPet(seed, { x: 100, y: 600, side: 64, nowMs: 0, index: 0, host: () => null });
    g.leave(0, 1440);
    expect(g.pat(100)).toBe("TA 正在回家");
  });

  it("命中判定从后往前找，离场中不算，空白处为 null", () => {
    const reg = new GuestRegistry(fakeCtx(), fakeCanvas(), 64, () => null);
    reg.sync(
      [
        { uid: "10000001", nick: "a", pet_name: "a" },
        { uid: "10000002", nick: "b", pet_name: "b" },
      ],
      0,
    );
    // host 为 null → 走旧槽位比例出生（0.28 / 0.5）
    const g1 = reg.list[0];
    expect(reg.hit(g1.body.x + 1, g1.body.y + 1)?.seed.uid).toBe(g1.seed.uid);
    expect(reg.hit(-10, -10)).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/guest.test.ts`
Expected: FAIL —— `pat` / `hit` 不存在。

- [ ] **Step 3: 实现 GuestPet.pat 与桃心特效**

`guest-pet.ts` 常量区加：

```ts
/** 单次到访的摸摸上限（与服务端 PAT_MAX 一致；本地先拦，省一次网络往返）。 */
export const PAT_MAX_LOCAL = 3;
/** 摸摸桃心的上升时长。 */
const PAT_FX_MS = 700;
/** 桃心颜色（与好友亲密度同色系）。 */
const PAT_COLOR = "#ff8fa3";
/**
 * 桃心 5×5 棋盘点阵（[列, 行]，每格 cell 像素）。
 * 刻意点阵纯色 —— CLAUDE.md 红线：绝不产生半透明像素。
 */
const HEART_CELLS: readonly [number, number][] = [
  [1, 0], [3, 0],
  [0, 1], [2, 1], [4, 1],
  [0, 2], [4, 2],
  [1, 3], [3, 3],
  [2, 4],
];
```

`GuestPet` 字段区加：

```ts
  private pats = 0;
  private patAt = 0; // 桃心特效起始时刻；0 = 无特效
  private patEyeUntil = 0; // poked 表情的截止时刻
  private patRiseQ = -1; // 桃心上升量（量化进绘制指纹）
  private lastFxBox: Box | null = null; // 上一帧桃心区域（到期后擦除用）
  private pendingHeart: { hx: number; hy: number; cell: number } | null = null;
```

`walkTo` 方法之后加：

```ts
  /**
   * 摸摸（本地先行反馈）：命中即计数 + 桃心 + 开心表情，
   * 上报由调用方 fire-and-forget。第 PAT_MAX_LOCAL+1 下起拒绝。
   * @returns null = 成功；string = 拒绝文案（直接给气泡）
   */
  pat(nowMs: number): string | null {
    if (this.leaving) return "TA 正在回家";
    if (this.pats >= PAT_MAX_LOCAL) return "摸够啦";
    this.pats++;
    this.patAt = nowMs;
    this.patRiseQ = -1;
    this.patEyeUntil = nowMs + 1600;
    return null;
  }
```

`tick` 内改两处（局部变量名 `px`/`py`/`w`/`h`/`bob` 与现状一致）：

(a) `expr.update` 入参里的 `poked: false` 改为：

```ts
      poked: nowMs < this.patEyeUntil,
```

(b) 从 `const key = ...` 到方法末尾 `return true;` 的段落改为（桃心区域计算 → 指纹追加 → 绘制 → 脏矩形并集）：

```ts
    // 摸摸桃心：上升 24px 后消失；棋盘点阵纯色，绝不半透明
    let fxBox: Box | null = null;
    if (this.patAt !== 0) {
      const t = nowMs - this.patAt;
      const cell = Math.max(2, Math.round(this.side / 32));
      const heartSide = cell * 5;
      if (t < PAT_FX_MS) {
        const rise = Math.min(24, Math.round((t / PAT_FX_MS) * 24));
        const hx = px + Math.round((w - heartSide) / 2);
        const hy = py - heartSide - 6 - rise;
        this.patRiseQ = rise;
        fxBox = { x: hx - 1, y: py - heartSide - 32, w: heartSide + 2, h: heartSide + 32 };
        this.pendingHeart = { hx, hy, cell };
      } else {
        this.patAt = 0; // 到点：本帧不画，但脏矩形要盖住上一帧的桃心
        this.patRiseQ = -1;
        fxBox = this.lastFxBox;
        this.pendingHeart = null;
      }
      this.lastFxBox = fxBox;
    }

    const key = `${px},${py},${w},${h},${bob},${this.eye.shape},${Math.round(
      this.eye.lid * 20,
    )},${Math.round(this.eye.gazeX * 20)},${Math.round(this.eye.gazeY * 20)},${this.patAt},${this.patRiseQ}`;
    if (key === this.lastDrawKey) return false;
    this.lastDrawKey = key;

    this.clear(ctx);
    drawAvatarFigure(ctx, { bodyX: px, bodyY: py, w, h }, this.avatar, this.eye);
    if (this.pendingHeart) {
      const { hx, hy, cell } = this.pendingHeart;
      ctx.fillStyle = PAT_COLOR;
      for (const [cx, cy] of HEART_CELLS) {
        ctx.fillRect(hx + cx * cell, hy + cy * cell, cell, cell);
      }
    }

    // 容差要盖住走动位移，否则移动时留残影；桃心区域一并纳入
    const pad = Math.max(10, Math.max(w, h) * 0.25);
    const base: Box = {
      x: px - pad,
      y: py - pad,
      w: w + pad * 2,
      h: h + pad * 2,
    };
    this.dirty = fxBox
      ? {
          x: Math.min(base.x, fxBox.x),
          y: Math.min(base.y, fxBox.y),
          w: Math.max(base.x + base.w, fxBox.x + fxBox.w) - Math.min(base.x, fxBox.x),
          h: Math.max(base.y + base.h, fxBox.y + fxBox.h) - Math.min(base.y, fxBox.y),
        }
      : base;
    return true;
```

（擦除链路自动生效：`clear()` 把 `this.dirty` 存进 `this.erased`，fxBox 并进 dirty 后，桃心上升的每一帧与消失帧都会被下一帧 `clearRect` 盖住。）

- [ ] **Step 4: GuestDialog.react 与话术**

`guest-dialog.ts` 的 `HOST_REPLY` 数组之后加：

```ts
/** 被摸的反应。 */
const PAT_REACTIONS: readonly string[] = [
  "（眯起眼睛）舒服～",
  "（往你手边蹭了蹭）",
  "（尾巴摇成了小风扇）",
];

/** 摸一下的反馈话术（导出供主循环用）。 */
export function patReaction(): string {
  return pick(PAT_REACTIONS);
}
```

`GuestDialog` 的 `onLeave` 方法之后加：

```ts
  /** 摸摸等即时反应：一句短气泡贴着访客头顶。 */
  react(g: GuestPet, text: string): void {
    const b = this.bubbleFor(g.seed.uid);
    b.show(text, { autoDismissMs: 3000 });
    b.follow(g.body);
  }
```

- [ ] **Step 5: GuestRegistry.hit**

`src/guest/index.ts` 的 `bodies` getter 之后加：

```ts
  /** 摸摸命中判定：点访客身体即触发；离场中的不可摸。从后往前找（后画的在上层）。 */
  hit(px: number, py: number): GuestPet | null {
    const list = this.list;
    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i];
      if (g.isLeaving) continue;
      const b = g.body;
      if (px >= b.x && px < b.x + b.w && py >= b.y && py < b.y + b.h) return g;
    }
    return null;
  }
```

- [ ] **Step 6: main.ts 上报与点击**

上报组装（411-416 行，把「访客身体刻意不上报」的注释块替换掉）改为：

```ts
  // 访客气泡：逐个 push，不能合并成并集矩形 —— 并集会盖住大片空白，
  // 误拦截下面编辑器/终端的点击。
  for (const b of guestDialog.boxes) boxes.push(b);
  // 访客身体可点（摸摸）：矩形必须上报，否则点击被穿透吃掉。
  // 刻意不参与 lock —— 摸一下即走，不需要持续接管鼠标。
  for (const b of guests.bodies) boxes.push(b);
```

pointerdown（252 行 `banner.contains` 检查之后、253 行 `pet.pointerDown` 之前）插入：

```ts
  // 摸摸访客：命中即本地反馈 + fire-and-forget 上报；不进拖动/单击面板逻辑
  const guest = guests.hit(e.clientX, e.clientY);
  if (guest) {
    const now = performance.now();
    const denied = guest.pat(now);
    guestDialog.react(guest, denied ?? patReaction());
    if (!denied) {
      void invoke("visitor_interact", { targetUid: guest.seed.uid }).catch((err) => {
        // 宁静优先：失败只记一笔，不重试不打扰（最多丢一次亲密度累加）
        console.warn("[guest] 摸摸上报失败", String(err).slice(0, 60));
      });
    }
    wakeFrame();
    return;
  }
```

并在 main.ts 头部 import 区把现有 `import { GuestDialog } from "./guest/guest-dialog";` 合并为：

```ts
import { GuestDialog, patReaction } from "./guest/guest-dialog";
```

- [ ] **Step 7: 跑测试确认通过**

Run: `npx vitest run tests/guest.test.ts && npx tsc --noEmit`
Expected: 均通过。

- [ ] **Step 8: 提交**

```bash
git add src/guest/guest-pet.ts src/guest/guest-dialog.ts src/guest/index.ts src/main.ts tests/guest.test.ts
git commit -m "feat(guest): 访客可点击摸摸——本地桃心反馈+表情，上报 /visit/interact

版本: <V>"
```

---

### Task 9: 前端 — 对话面对面 + leave/visit_rejected 分支 + 出门演出

**Files:**
- Modify: `src/anim/behavior.ts:221`（`finishGoto` 之后新增 `stopGoto`；`face` 已在 Task 7 加）
- Modify: `src/pet.ts:260`（`finishSummon` 之后新增 `face`/`stopWander`）
- Modify: `src/guest/guest-pet.ts`（`walkTo` 之后新增 `standAndFace`）
- Modify: `src/guest/guest-dialog.ts:66`（构造加 `onSpeak`）、`72`（`onArrive`）、`117`（`tick` 聊天分支）
- Modify: `src/main.ts:145-151`（GuestDialog 接线）、`onSocialEvent` 回调（`"interaction"` 分支之后）、`540-565`（onAwayChange 重构）

**Interfaces:**
- Consumes: Task 6 `notifyNearPet(text, autoDismissMs = 8000)`；Task 4 的 `visit_rejected` 事件与 `pats` 字段；Task 7 `Behavior.face`。
- Produces:
  - `Behavior.stopGoto()`（停在原地，不瞬移到目标）。
  - `Pet.face(dir: -1 | 1)` / `Pet.stopWander()`。
  - `GuestPet.standAndFace(hostCenterX: number)`。
  - `GuestDialog` 构造第二参 `onSpeak?: (g: GuestPet) => void`。
  - `onSocialEvent` 新分支：`leave`（Banner 6 秒「XX 的宠物回家了」）与 `visit_rejected`（气泡「想去找 XX 玩，但扑空了」）。
  - `onAwayChange`：`kind === "visit"` 且当前在家时先播离场演出（走向最近边缘 1.3 秒后隐藏）+「去 XX 家串门啦」通知；`away=true` 落地时全体访客离场送客 + 对话清空；召回/到期回家维持瞬现。

- [ ] **Step 1: 实现行为层 API**

`behavior.ts` 的 `finishGoto`（214-221 行）之后加：

```ts
  /** 停在原地（对话面对面用）：结束 goto 但不瞬移到目标。 */
  stopGoto(): void {
    if (this.targetX === null) return;
    this.targetX = null;
    this.state.motion = "idle";
    this.nextMoveIn = this.pickIdleGap();
  }
```

`pet.ts` 的 `finishSummon`（258-260 行）之后加（`side` 是私有 getter、`canvas`/`behavior` 均为现有字段，同类内可访问）：

```ts
  /** 面向某方向（对话面对面用）。 */
  face(dir: -1 | 1): void {
    this.behavior.face(dir);
  }

  /** 停在原地（对话面对面用）：目标设为当前位置，下一拍即回待机。 */
  stopWander(): void {
    const maxX = Math.max(0, this.canvas.width - this.side);
    this.behavior.goto(this.body.x, maxX);
  }
```

`guest-pet.ts` 的 `walkTo` 之后加：

```ts
  /**
   * 对话拍：停步并面向主宠物。
   * 追赶途中被叫停也没关系 —— 下一拍跟随逻辑会自己恢复。
   */
  standAndFace(hostCenterX: number): void {
    if (this.leaving) return;
    this.behavior.stopGoto();
    this.behavior.face(this.behavior.current.x <= hostCenterX ? 1 : -1);
  }
```

- [ ] **Step 2: GuestDialog onSpeak 钩子**

`guest-dialog.ts` 构造（66 行）改为：

```ts
  constructor(
    private readonly hostSay: (text: string) => void,
    /** 访客开口时的编排钩子（停步面对面）。 */
    private readonly onSpeak?: (g: GuestPet) => void,
  ) {}
```

`onArrive` 的 `b.follow(g.body);`（72 行）之后加一行：

```ts
    this.onSpeak?.(g);
```

`tick` 聊天分支的 `b.follow(g.body);`（117 行）之后同样加：

```ts
      this.onSpeak?.(g);
```

- [ ] **Step 3: main.ts 接线对话面对面**

`main.ts` 145-151 行的 `guestDialog` 构造改为（第一个回调保持原文，新增第二个）：

```ts
const guestDialog = new GuestDialog(
  (text) => {
    // 主宠物的回应走主气泡；不在家就不说话。
    // 主气泡正占着（宠物自己说话 / 提醒 / 插件卡片）就让路 ——
    // 访客闲聊是最低优先级，不该把提醒挤掉。
    if (pet.isHidden || bubble.isOpen) return;
    bubble.show(text, { autoDismissMs: 5000 });
  },
  (g) => {
    // 对话拍：双方停步、面对面
    if (pet.isHidden) return;
    const host = pet.body;
    const hostCx = host.x + host.w / 2;
    const guestCx = g.body.x + g.body.w / 2;
    g.standAndFace(hostCx);
    pet.stopWander();
    pet.face(guestCx >= hostCx ? 1 : -1);
  },
);
```

- [ ] **Step 4: onSocialEvent 新分支**

`main.ts` `onSocialEvent` 回调里，`"interaction"` 分支之后插入（`"interaction"` 分支本身不动 —— Task 4 补上 `pats` 后，现有 `被 ${e.event.from_nick} 摸了 ${e.event.pats ?? 1} 下` 文案直接生效）：

```ts
  } else if (e.event.type === "leave" && e.event.from_nick) {
    // 访客回家：轻通知贴宠物头顶（不在家自动退右上角）
    notifyNearPet(`${e.event.from_nick} 的宠物回家了`, 6000);
  } else if (e.event.type === "visit_rejected" && e.event.nick) {
    if (!pet.isHidden) {
      bubble.show(`想去找 ${e.event.nick} 玩，但扑空了`, { autoDismissMs: 6000 });
    }
  }
```

- [ ] **Step 5: onAwayChange 出门演出 + 送客**

`main.ts` 540-565 行整体替换为（保留现有全部标识符 `awayKind`/`awayNick`/`awayEndsAt`/`awayTicker`/`stopAwayTicker`/`formatAwayText`/`awayIcon`/`flash`/`ctx2d`，新增送客与演出）：

```ts
/** 把出门/回家状态落到 UI（出门演出结束后调用；回家/碰一碰直接调）。 */
function applyAway(n: {
  away: boolean;
  at_nick?: string;
  kind?: "visit" | "bump";
  duration_secs?: number;
}): void {
  pet.setHidden(n.away);
  // setHidden 会整屏 clearRect，访客必须作废指纹重画，否则会消失
  guests.invalidate();
  if (n.away) {
    // 宠物走了：贴它身上的通知退回右上角（内容保留）
    banner.releaseFromPet();
    flash.clear(ctx2d);
    // 主人不在家，客人也该走了：全体走出屏幕，对话编排清空
    const now = performance.now();
    for (const g of guests.list) g.leave(now, canvas.width);
    guestDialog.clear();
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
}

let awayAnimTimer: number | null = null;

void onAwayChange((n) => {
  // 上一场演出还没落地又来了新事件：立即按新状态结算，别叠着来
  if (awayAnimTimer !== null) {
    clearTimeout(awayAnimTimer);
    awayAnimTimer = null;
  }
  if (n.away && n.kind === "visit" && !pet.isHidden) {
    // 出门演出：先走向最近的屏幕边缘（约 1.3 秒后中途隐藏 ——
    // 半屏距离 130px/s 走不完，与访客离场同款手感），到位后再真正隐藏；
    // 召回/到期回家维持瞬现，不加回家动画
    const b = pet.body;
    const edge = b.x + b.w / 2 < canvas.width / 2 ? 0 : canvas.width - b.w;
    pet.summonTo(edge + b.w / 2);
    notifyNearPet(
      `去 ${n.at_nick ?? "好友"} 家串门啦，${Math.round((n.duration_secs ?? 480) / 60)} 分钟后回来`,
    );
    wakeFrame();
    awayAnimTimer = window.setTimeout(() => {
      awayAnimTimer = null;
      applyAway(n);
    }, 1300);
    return;
  }
  applyAway(n);
});
```

- [ ] **Step 6: 验证**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 均通过。

- [ ] **Step 7: 提交**

```bash
git add src/anim/behavior.ts src/pet.ts src/guest/guest-pet.ts src/guest/guest-dialog.ts src/main.ts
git commit -m "feat(visit): 对话停步面对面；出门离场演出+通知+送客；leave/被拒分支

版本: <V>"
```

---

### Task 10: 验证清单 + 全量检查 + 版本号落盘

**Files:**
- Create: `docs/plans/2026-09-20-online-visit-bubble-verification.md`（`git add -f`）
- Modify: `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`（版本三处同步，`<V>` 用开工时用户确认的版本号）

**Interfaces:**
- Consumes: 前面全部任务。
- Produces: 手工验证清单文档 + 合入前全量检查全绿。

- [ ] **Step 1: 写手工验证清单**

`docs/plans/2026-09-20-online-visit-bubble-verification.md`：

```markdown
# 在线总览 / 串门互动 / 气泡收拢 · 手工验证清单（2026-09-20）

改了穿透上报矩形与出门流程，本清单必须人工过一遍（无法自动化）。
环境：两台机器（或两个账号）A（主）/ B（来访），`pnpm tauri dev`。

## 穿透敏感区（最高优先 —— 出错会锁死桌面）

- [ ] 访客在家时：点击访客身体出现桃心与反应气泡，点击不触发宠物拖动、不弹插件面板
- [ ] 访客身体矩形**之外**、面板之外的点击照常穿透到下面应用
- [ ] 访客气泡可点关闭区域正常；访客离开后其矩形不再拦截点击
- [ ] 前端假死 1.5 秒后 Rust 强制恢复穿透（断点/kill 前端进程验证），Ctrl+Alt+Cmd+Q 逃生可用
- [ ] 拖动主宠物期间鼠标接管持续（lock 判定未受访客矩形影响）

## 伙伴式跟随与摸摸

- [ ] B 打招呼后串门：B 的宠物从靠近 A 宠物一侧的屏幕边缘走入，走到 A 宠物身旁停下，脚线对齐
- [ ] A 拖动宠物走远：访客追上来；A 静止时访客在小范围晃悠，CPU 不抬帧（活动监视器抽查）
- [ ] 访客说话时双方停步、面对面；主宠物回应气泡出现
- [ ] 连点访客 3 下：桃心逐次上升、亲密度 +3（好友面板核对）；第 4 下气泡「摸够啦」，服务端不再计数
- [ ] B 侧（出门方）收到「被 A 摸了 N 下」气泡，N 随事件递增
- [ ] B 点回家：A 侧 Banner「XX 的宠物回家了」，访客走出屏幕消失
- [ ] 15 分钟过期后再摸：服务端拒绝（TA 不在你家做客）

## 出门反馈

- [ ] A 的宠物自动决定串门时：先走向屏幕边缘（约 1.3 秒）再消失，头顶「去 XX 家串门啦」通知跟随
- [ ] 通知在宠物隐藏后退回右上角且内容保留
- [ ] 出门瞬间家里访客全部离场送客，对话气泡收掉
- [ ] 右下角「不在家」图标点击召回：宠物瞬现回家（无回家动画）
- [ ] 对方离线/满员时宠物想去串门被拒：气泡「想去找 XX 玩，但扑空了」

## 气泡收拢

- [ ] 简单通知（如休息奖励）默认贴宠物头顶；宠物走到屏幕顶部时翻到脚下
- [ ] 主气泡与通知同开：通知让到主气泡外侧，无重叠
- [ ] 好友回执卡（搜索/碰一碰结果）贴宠物头顶；宠物不在家时退回右上角
- [ ] 提醒大卡片仍在右上角、可拖、可改时间（刻意不收拢）

## 今日在线

- [ ] 好友面板「今日在线」：在线好友带「好友」徽标、无打招呼按钮，排在陌生人前
- [ ] 好友按亲密度降序、封顶 3；离线/隐身好友不出现
- [ ] 陌生人行照常可打招呼；空态文案正常

## 隐私抽查

- [ ] `share.rs` 无改动（git diff 确认）；心跳上报结构不变
- [ ] 日志无新增原文/密钥类内容（grep 新增 eprintln/console.warn）
```

- [ ] **Step 2: 全量检查**

```bash
npx tsc --noEmit
cd src-tauri && cargo check && cargo test && cd ..
npx vitest run
pnpm test:sync
pnpm test:worker
```

Expected: 全绿。服务端部署后再跑 `pnpm test:remote <地址>`（会留测试账号，只对空库跑）。

- [ ] **Step 3: 版本号三处同步**

用开工时用户确认的 `<V>`（语义化：本批为加功能 → minor）同步改：
- `src-tauri/tauri.conf.json` 的 `"version"`
- `src-tauri/Cargo.toml` 的 `version`
- `package.json` 的 `"version"`
- `src-tauri/Cargo.lock`（改完 Cargo.toml 跑一次 `cargo check` 自动更新，须一并提交 —— 版本号也记录在 lock 里，漏提交会让下次构建产生脏 diff）

- [ ] **Step 4: 提交**

```bash
git add -f docs/plans/2026-09-20-online-visit-bubble-verification.md
git add src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock package.json
git commit -m "chore(release): 串门近距离互动/在线总览/气泡收拢收尾，验证清单与版本 <V>

版本: <V>"
```

---

## 任务依赖

- Task 1、2 独立（服务端）；Task 3、4 依赖 Task 2 的接口形状（`/visit/interact`、事件字段）；Task 5 依赖 Task 3（`is_friend` 到达前端）；Task 6、7 相互独立；Task 8 依赖 Task 3（invoke）与 Task 7（构造签名）；Task 9 依赖 Task 6（`notifyNearPet` 签名）与 Task 7（`face`）；Task 10 收尾。
- 执行顺序按编号即可（1 → 10），无需并行。
