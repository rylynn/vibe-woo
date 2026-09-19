# 好友功能优化 · 设计文档

日期：2026-09-19
状态：已与用户逐节确认

## 背景与目标

社交功能现状（摸底结论）：

- 好友关系已是 KV 双向双写（`friends_<uid>` JSON 数组），但「加即成功」，没有申请/确认流程，也没有搜索接口（只有精确 uid/昵称解析，发现陌生人靠今日在线推荐）。
- 服务端只有 KV `get/put/delete`，无 TTL、无 CAS、无 Durable Object；一切过期用「存时间戳、读时判断」模拟（招呼 60s 冷却即此模式）。
- 亲密度是客户端权威的单一全局值（不按好友区分、重启清零、服务端只 clamp）；好友列表里的 ♥ 实际显示的是**对方自己的**全局值。
- 前端已有 Bubble（贴宠物气泡，带按钮）与 Banner（右上角通知卡片）两套通知；串门可视化（出门图标、桌面访客）已存在。

本轮四项需求：

1. 好友改为申请制双向关系：搜索 → 发申请 → 对方接受 → 关系建立，双端可见。
2. 搜索/添加等操作结果弹窗提醒。
3. 好友互动新增「碰一碰」：宠物跑到对方家快闪提醒，1 次/分钟（本地 + 服务端双重限流）。
4. 自动互动（串门目标选择）改为按亲密度加权随机；串门进行中本地展示状态。

## 已确认的关键决策

| 决策点 | 结论 |
|---|---|
| 申请语义 | 对方点「接受」才建立；可拒绝；申请 7 天未处理自动过期 |
| 搜索程度 | 精确匹配（完整 uid 或完整昵称），命中弹结果卡片，不做前缀模糊搜索 |
| 碰一碰形态 | 快闪式短逗留：本地宠物出门 45 秒，对方收到事件后播放回放式路过动画；独立于 8 分钟串门 |
| 进展 UI 含义 | 串门进行中状态（剩余时间倒计时），不做亲密度成长反馈 |
| 架构方向 | 方案 A「服务端关系化」：申请状态、碰一碰限流、按好友亲密度全部落在 `lib-account.js`（两套部署共用真源）；客户端只做本地限流、决策与 UI |

否决的备选：B「客户端记账」（双端数字不一致、重装即丢）；C「DO/KV TTL 严格原子」（EdgeOne 无 DO/KV TTL，会分叉两套部署的业务逻辑，违反仓库「共用同一份 lib-account.js」规则）。

## 服务端设计（lib-account.js）

### 好友申请流

- 新增收件箱键 `freq_<uid>`：`[{from, at}]`，上限 20 条，读时过滤 7 天过期条目。同一 `from` 同时只能有一条 pending，重复申请返回 `already_requested`。
- 新 endpoints（全部 `requireAuth`）：
  - `POST /friends/search` `{target}` → 复用 `resolveTarget` 精确解析，命中返回**只有** `{uid, nick, pet_name}` 三字段；未命中 `not_found`。不暴露在线状态/亲密度给未建立关系者。
  - `POST /friends/request` `{target}` → 写对方 `freq_` + 推事件 `freq`；已是好友 `already_friends`；加自己直接拒绝。
  - `POST /friends/accept` `{target}` → 双写 `friends_`（复用现有 addFriend 内部逻辑）+ 双方关系亲密度各 +5 + 给申请方推事件 `accept`；条目不存在返回 `not_found`（幂等）。
  - `POST /friends/reject` `{target}` → 仅移除条目，不发事件（不做拒绝冷却）。
- `/friends` 列表响应与心跳响应新增 `requests: [{uid, nick, pet_name, at}]`，收件人轮询即知，无需打开面板。
- 老接口语义升级：`/friends/add` 等价于 `/friends/request`（返回 `pending: true`），服务端只保留「申请」一种语义。

### 按好友亲密度

- `friends_<uid>` 条目 `{uid, at}` → `{uid, at, aff}`；旧数据读时默认 `aff: 0`，不做迁移。
- 服务端在交互发生时双向累加（同一对关系两边加同值）：接受申请 +5、打招呼 +1、串门 +2、碰一碰 +2；clamp 100，不衰减。
- `FriendView.affinity` 换源：从「对方客户端上报的全局值」改为「关系值」。心跳上报结构不动（`share.rs` 零改动），仅服务端消费侧换源。
- 现有全局 `Affinity`（出门门槛）保持客户端本地门控，不动。

### 碰一碰

- `POST /friends/bump` `{target}`：校验好友关系（`not_friends`）→ 读 `bump_<uid>_<dst>` 时间戳，存在且 <60s 返回 `rate_limited`（带 `retry_after` 剩余秒数）→ 否则写入当前时间戳 → 给对方推事件 `bump` → 双方亲密度 +2。
- key 单向（A→B 与 B→A 独立限流）。读-检查-写的毫秒级竞态窗口接受（与招呼冷却同模式）。陈旧键不清理，键空间 O(好友对数)，与 `greeted_` 日期键同样接受残留。

### 事件与通知延迟

- 事件类型新增 `freq` / `accept` / `bump`，payload 白名单 `{from, nick, pet_name}`，沿用 512B/条、环形 20 条约束。
- 通知延迟受心跳周期限制（默认 ≤180s）：申请/接受可接受；碰一碰由前端回放动画弥补感知。

## Rust 侧设计

### 命令层

- `syncclient.rs` 新增 `friend_search` / `friend_request` / `friend_accept` / `friend_reject` / `friend_bump` 封装，走现有 `post_authed`。
- `socialcmd.rs` 对应五个 Tauri 命令（`main.rs` 注册）；错误只回枚举类别（`not_found` / `already_friends` / `already_requested` / `rate_limited` / `not_friends` / 网络失败），不透传服务端响应体。

### 同步循环（socialdrive.rs）

- 心跳响应解析 `requests`，随 `pet://friends` payload 扩展下发（前端不换监听器）。
- 新事件转发：`freq` → 前端气泡（带接受/拒绝）；`accept` → 气泡确认；`bump` → 访客快闪动画 + 气泡。
- `decide_visit` 保持外层（persona 概率 × 主人忙 × 出门门槛），目标选择抽纯函数 `pick_visit_target(friends, rng) -> Option<uid>`：在线好友按 `w = aff + 10` 加权随机（+10 下限保证新好友也有机会）；空列表 `None`。
- 出门状态复用 `VISITING` + `kind: visit | bump`；碰一碰 45 秒自动回家（8 分钟回家计时器的短版本）；剩余时间随 `pet://home-away` 下发。

### 本地限流

- 纯函数 `bump_gate(last_at: Option<Instant>, now) -> Allow | Cooldown(remaining)`，60 秒窗口，按好友进程内存记录（重启丢一次无害，服务端兜底）。
- 服务端 `rate_limited` 时用 `retry_after` 对齐本地倒计时。

## 前端设计

### 好友面板（src/overlay/friends.ts）

- 「添加好友」改「搜索」：输入完整 uid/昵称 → `friend_search` → Banner 弹结果卡片（昵称/宠物名/uid + [发申请]）或「没找到」；发申请后弹回执（已发送/已是好友/已申请过）。
- 新「申请」区段（好友区段上方）：待处理申请列表（昵称 + 宠物名 + [接受][拒绝]）；有申请时面板入口红点。
- 好友行加「碰一碰」按钮（🖐，删除按钮旁）：点击置灰 + 60s 倒计时；本地 `bump_gate` 先拦，服务端对齐。

### 弹窗映射（复用现有系统，不新增）

| 场景 | 渠道 |
|---|---|
| 搜索结果 / 申请回执 | Banner（主动操作回执） |
| 收到好友申请 | Bubble + [接受][拒绝]，20s 自动消失，面板亦可处理 |
| 申请被接受 | Bubble |
| 被碰一碰 | Bubble + 快闪动画 |

### 访客快闪（src/guest/）

- bump 事件到达时播约 8 秒回放式路过动画：对方宠物从屏幕一侧跑入 → 到自家宠物旁碰一下 → 跑出屏幕；同时 Bubble「XX 的宠物跑来碰了碰你」。
- 复用 GuestPet 绘制，独立短生命周期路径，**不占**串门 3 个访客槽位；同 uid 60s 去重（幂等）。

### 串门进度（pet-away-icon 增强）

- 串门中：`🐾 在 XX 家 · 还剩 X 分钟`（socialdrive 下发剩余时间），点击仍可召回。
- 碰一碰中：`🐾 碰了碰 XX，马上回来`。

## 隐私红线核对

- `share.rs` 白名单上报零改动；心跳仍上报四档状态 + 全局 affinity。
- 搜索卡片只暴露 `{uid, nick, pet_name}`（昵称本有公开索引，宠物名本就心跳公开）。
- `friends/*` 全部鉴权，防匿名遍历。
- 事件 payload 白名单构造，512B 硬上限；Rust 日志只记阶段与错误类别，不记 uid 以外标识。

## 错误处理

- 服务端错误码全集：`not_found` / `already_friends` / `already_requested` / `rate_limited`（带 `retry_after`）/ `not_friends` / 鉴权失败。
- 客户端每个失败路径一句人话文案（Banner），网络失败统一「网络不太好，稍后再试」。
- 迟到/重复事件：bump 动画同 uid 60s 去重；重复 accept 返回 `not_found` 幂等。
- 读-改-写竞态沿用「最后写赢 + 长度上限」容忍策略，不引入新原语。

## 测试与验证

- `scripts/test-sync.mjs`（内存 store 直调 dispatch）新增：申请全流程（发/收/接受/拒绝/重复/自加/已是好友/7 天过期）、碰一碰限流（60s 内第二次拒、不同 dst 独立、非好友拒、`retry_after` 正确）、亲密度累加与 clamp、旧 `friends_` 无 `aff` 兼容、老 `/friends/add` 走申请语义。
- Rust 单测：`pick_visit_target`（单好友必中、权重恒正、空列表 None、固定种子统计偏高亲密度）、`bump_gate`（60s 边界、剩余秒数）、出门 kind 与回家计时。
- `scripts/test-worker.mjs`：新路由过 Cloudflare 适配层。
- 手工清单落 `docs/plans/2026-09-19-friends-optimization-verification.md`：双机申请流、碰一碰端到端（限流倒计时、快闪动画）、串门进度、老客户端升级行为。
- 合入检查：`npx tsc --noEmit`、`cargo check`、`npx vitest run`、`pnpm test:sync`、`pnpm test:worker`。

## 范围外（明确不做）

模糊搜索、好友备注/分组、亲密度衰减与等级、拒绝冷却/拉黑、事件推送基础设施（保持拉取式）、`social_hidden` 隐身 UI。
