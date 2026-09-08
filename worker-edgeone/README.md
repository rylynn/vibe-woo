# Vibe Pet 同步服务（EdgeOne Pages 版）

账号体系 + 好友关系 + 心跳在线 + 打招呼 + 宠物串门。KV 存储选的是 `SYNC_KV`。
不部署不影响宠物的任何其他功能 —— 只是没有社交。

## 目录结构

```
worker-edgeone/
├── edge-functions/api/
│   ├── [[default]].js     # 边缘函数入口（薄封装：CORS、限频、错误脱敏）
│   └── lib-account.js     # 全部业务逻辑（被线上与 local-dev.js 共用）
├── admin/index.html       # 数据看板（静态页，浏览器里直接开）
├── index.html             # 站点首页
├── local-dev.js           # 自托管服务（单机 Node + 文件存储，端口 8787）
│                          #   既用于本机联调，也可直接部署到自己的服务器
└── package.json
```

**路由**由 `edge-functions` 的目录结构决定：`api/[[default]].js` 只挂在 `/api/*` 上。
所以客户端的 base URL 必须带 `/api` —— 请求 `/heartbeat` 不会命中这个函数。

## 部署

### 前提：根目录必须是 `worker-edgeone`

仓库根目录是整个 `vibe_woo`，但 Pages 项目只需要这个子目录。
**根目录设成仓库根，部署出来的会是前端应用本身而不是同步服务** —— 这是最容易踩的一步。

| 配置项 | 值 |
|---|---|
| 根目录 / Root Directory | `worker-edgeone` |
| 构建命令 | 留空（无需构建，`npm run build` 是 no-op） |
| 输出目录 | 留空（静态资源在根目录） |

### 三种部署方式

**A. 直接上传**（改一点试一次，最快）

控制台 → 项目 → 部署 → 直接上传 → 把 `worker-edgeone/` 整个目录拖进去。

**B. 导入 Git 仓库**（之后 push 即自动部署）

控制台 → 项目 → 导入 Git 仓库 → 选仓库 → 根目录填 `worker-edgeone` → 选分支。
之后往该分支 push 就会自动触发部署。

**C. EdgeOne CLI**

```bash
npx edgeone login
npx edgeone deploy --root worker-edgeone
```

### 部署后必做（一次性）

1. **KV 绑定**：项目详情 → KV 存储 → 绑定命名空间，变量名必须叫 **`SYNC_KV`**
   （`lib-account.js` 里读的就是这个全局变量；没绑定会静默降级成进程内存，
   表现为「注册成功，重启后数据全没了」）。
2. **环境变量**（可选，admin 看板用）：`ADMIN_USER` / `ADMIN_PASS`，Secret 类型。
   不配的话 `/api/admin/*` 整体禁用，不影响正常用户。

## 验证

```bash
curl -i https://<你的域名>/api/status
```

期望看到三件事：

- `HTTP/1.1 200`
- 响应体 `{"ok":true,"now":<时间戳>}`
- 响应头 **`X-Pet-Sync-Storage: kv`** ← 这一条最关键

如果 `X-Pet-Sync-Storage` 是 `memory`，说明 KV 没绑上，数据在每次冷启动后清空。

如果返回的是 EdgeOne 平台的 401 HTML（标题 `Tencent Edgeone`、提示
"Click Preview in the console for a new link"），那不是代码问题 —— 是站点还停在
**预览环境**、没有正式发布，需要在控制台发布或换用生产域名。

## 自托管：部署到自己的服务器（备案前的可行方案）

国内云主机**未备案时 80/443 会被阻断**，但用 **IP + 非标端口**可以正常访问 ——
ICP 备案针对域名，不针对 IP。所以域名还在备案时，这是最省事的一条路。

### 跑起来

```bash
node worker-edgeone/local-dev.js 8787
ADMIN_USER=xxx ADMIN_PASS=yyy node worker-edgeone/local-dev.js 8787   # 带 admin 看板
```

服务默认监听 `0.0.0.0`（允许外部访问），所以部署到服务器后不用改监听地址。

| 环境变量 | 作用 |
|---|---|
| `ADMIN_USER` / `ADMIN_PASS` | admin 看板口令，不设则 `/api/admin/*` 禁用 |
| `SYNC_DATA_FILE` | 数据文件路径，默认 `worker-edgeone/.local-data.json` |
| `SYNC_HOST` | 监听地址，默认 `0.0.0.0`；只想本机联调设 `127.0.0.1` |
| `DEBUG_ERRORS=1` | 把内部异常摘要放进响应头，排障用 |

### 用 systemd 守护（不然 SSH 断开就挂了）

```ini
# /etc/systemd/system/vibe-pet-sync.service
[Unit]
Description=Vibe Pet Sync
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/vibe-woo
ExecStart=/usr/bin/node worker-edgeone/local-dev.js 8787
Environment=ADMIN_USER=xxx
Environment=ADMIN_PASS=yyy
Environment=SYNC_DATA_FILE=/var/lib/vibe-pet/sync.json
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now vibe-pet-sync
sudo systemctl status vibe-pet-sync
```

### 别忘了这三件事

1. **安全组放行端口**：腾讯云控制台 → 防火墙/安全组，放行 8787（TCP）。
   **不要用 80/443**，未备案会被阻断。
2. **备份数据文件**：单机单文件、没有副本。密码是 PBKDF2 哈希，
   但账号/昵称/宠物名是明文落盘的，定期拷一份到别处。
3. **明文 HTTP 的风险**：会话 token 在链路上可被窃听。宠物应用没有真实敏感
   数据，几个人用可以接受；域名备案后建议切回 https。

### 接到客户端

宠物「设置 → 同步服务（高级）→ 服务地址」填：

```
http://<你的公网IP>:8787/api
```

客户端的校验规则是：**https 一律放行；http 只放行 IP（含 localhost）**。
IP 没法备案所以给开了口子，有域名就必须走 https。

### 验证

```bash
curl -i http://<你的公网IP>:8787/api/status
```

期望 `200` + `{"ok":true,...}`，响应头 `X-Pet-Sync-Storage: file`。

`/api/xxx` 与 `/xxx` 两种路径都支持。

### 一个使用上的限制

注册/登录/admin 登录共享「**同 IP 10 秒一次**」的限频。几个人分散在不同网络
没问题；如果多个用户从同一个 NAT 出口（比如同一间办公室）同时注册，会互相阻塞，
需要错开 10 秒。

## 本机联调

不想污染服务器数据时，在本机跑同一个服务：

```bash
SYNC_HOST=127.0.0.1 node worker-edgeone/local-dev.js          # 默认 8787
```

然后在宠物「设置 → 同步服务（高级）→ 服务地址」填 `http://localhost:8787/api`。

## 逻辑自检

业务逻辑全在 `lib-account.js`（纯函数 + store 接口），可以脱离边缘环境跑：

```bash
pnpm test:sync      # = node scripts/test-sync.mjs
```

用内存 store 跑完整链路：注册、宠物名校验与注入拦截、今日推荐、招呼冷却、
串门候选、隐身排除、访客进出。**改过 `lib-account.js` 就必须跑它**。

## 已知限制

- 边缘函数单次执行 **CPU 时间 200ms**（不含 I/O）。`online/random` 要遍历用户索引
  逐个读 KV 判断在线，用户量上千后需要改成维护一份「在线集合」再取样。
  当前用户量下够用（算法是刻意先不优化的）。
- 事件队列有 512 字节上限，招呼话术因此卡在 40 字、昵称截断到 24 字。
- `POST /api/register` 的限频是 10 秒/IP，客户端自动开户失败会退避重试，不会连打。
