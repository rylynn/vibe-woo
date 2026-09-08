# Vibe Pet 同步服务（Cloudflare Worker 版）

与 `worker-edgeone/`（EdgeOne Pages 版）**共用同一份业务逻辑**
`../../worker-edgeone/edge-functions/api/lib-account.js`，本目录只是运行时适配层
（`src/index.js` 约 100 行）。两版行为必须逐字一致 —— 否则就会出现
「在这个平台上好好的、换到另一个平台就挂」这种最难排查的 bug。

## 什么时候用这一版

EdgeOne 版的自定义域名需要 **ICP 备案**。备案还没下来时，EdgeOne 只能通过
每 3 小时过期的预览链接访问，客户端用不了。这一版不需要备案，可以作为过渡。

备案下来之后建议切回 EdgeOne：域名是你自己的，可控。

## ⚠️ 部署前先确认两件事

### 1. 国内网络能不能访问 `*.workers.dev`

这是硬前提。Cloudflare 在国内的连通性时好时坏，如果根本不通，这版就没意义。

```bash
# 先部署一个最小的 worker，然后用国内网络（手机关掉 Wi-Fi 用蜂窝也行）访问
curl -i https://vibe-pet-sync.<你的子域>.workers.dev/api/status
```

看到 `200` + `{"ok":true,...}` 才算通。

### 2. KV 写入额度够不够（免费版这里很容易翻车）

Workers 免费计划：**KV 写 1,000 次/天**（读 10 万次/天）。

一次心跳会写 3 个键（`hb_<uid>`、`usage_<uid>`、`stats_<日期>`），
按默认 3 分钟心跳算 = 480 次/天 × 3 = **约 1,440 次写/用户/天** ——
**免费额度连一个用户都不够。**

三个办法，任选：

| 办法 | 做法 | 代价 |
|---|---|---|
| 付费 | Workers Paid（约 $5/月），KV 写到 100 万次/天 | 花钱，最省事 |
| 拉长心跳 | 服务端把 `next_secs` 调到 1800（30 分钟） | 在线判定变钝，推荐名单更新慢 |
| 合并写入 | 客户端攒几拍再上报 usage，心跳只写 hb | 要改代码 |

如果只是自己和小伙伴几个人用，**拉长心跳**最划算。

## 部署

```bash
cd worker

# 1. 建 KV 命名空间，把输出的 id 填进 wrangler.toml
npx wrangler kv namespace create SYNC_KV

# 2. 登录并部署
npx wrangler login
npx wrangler deploy
```

binding 名必须是 **`SYNC_KV`**（与 EdgeOne 版一致）。没绑定时服务会
**明确返回 500**，不会静默降级成内存 —— 那种降级会表现为
「注册成功，隔一会儿账号没了」，极难排查。

管理看板口令（可选，不配则 `/api/admin/*` 整体禁用）：

```bash
npx wrangler secret put ADMIN_USER
npx wrangler secret put ADMIN_PASS
```

## 验证

```bash
curl -i https://vibe-pet-sync.<你的子域>.workers.dev/api/status
```

期望 `200` + `{"ok":true,"now":...}`。

`/api/xxx` 和 `/xxx` 两种路径都支持，所以 base URL 带不带 `/api` 都可以。

## 逻辑自检（不用部署就能跑）

```bash
pnpm test:worker    # = node scripts/test-worker.mjs
```

用内存 KV 驱动真实的 `fetch` handler，覆盖路由、KV 绑定缺失的兜底、
注册、今日推荐、打招呼冷却、串门、隐身。**改过 `src/index.js`
或 `lib-account.js` 都要跑。**

（`pnpm test:sync` 是直接调 `dispatch` 的业务逻辑自检，两个都该跑。）

## 接到客户端上

部署成功后拿到地址，二选一：

- **临时验证**：宠物「设置 → 同步服务（高级）→ 服务地址」填上
- **正式切换**：把地址给我，改 `src-tauri/src/syncclient.rs` 里的
  `DEFAULT_SYNC_BASE_URL`（一行常量）

## 已知差异（相对 EdgeOne 版）

- **KV 最终一致性更慢**：Cloudflare KV 默认有 60 秒的缓存窗口。
  对心跳（3 分钟一拍）没影响，但不要指望写入后立刻能读到。
- **CPU 时间**：Workers 免费版单次 10ms，比 EdgeOne 的 200ms 紧。
  `online/random` 要遍历用户索引，用户量上千后需要改算法。
