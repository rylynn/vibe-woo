# Vibe Pet 同步服务

账号体系 + 好友关系 + 心跳在线 + 宠物串门的 Cloudflare Worker。免费额度对几十人绰绰有余，零运维。

## 部署

```bash
cd worker
npx wrangler login

# 创建 KV 命名空间
npx wrangler kv namespace create SYNC
# 把输出的 id 填入 wrangler.toml 并取消注释 [[kv_namespaces]] 段

# 设置管理密钥（用于签发注册邀请码）
npx wrangler secret put ADMIN_TOKEN

npx wrangler deploy
```

部署完成后把地址填进宠物设置的「好友 → 服务器」。

## 账号与邀请

注册采用邀请制：管理员用 ADMIN_TOKEN 签发一次性邀请码，分发给用户；
每个新用户注册后也会自动获得一个自己的邀请码（可邀请下一位）。

```bash
# 签发邀请码（示例，3 个）
curl -X POST https://<你的worker>/admin/invite \
  -H "Authorization: Bearer <ADMIN_TOKEN>" \
  -H "Content-Type: application/json" -d '{"count": 3}'
```

## 端点

| 方法 | 路径 | 鉴权 | 作用 |
|---|---|---|---|
| POST | /register | 无（限频 10s/IP） | 邀请码注册，返回 uid/token/注册时间 |
| POST | /login | 无（限频 10s/IP） | 登录，返回永久会话 token |
| POST | /admin/invite | ADMIN_TOKEN | 签发一次性邀请码 |
| GET | /me | Bearer | 我的账号信息 |
| POST | /profile/pet-name | Bearer | 改宠物名（随时可改） |
| POST | /friends/add | Bearer | 加好友（uid 或昵称） |
| POST | /friends/remove | Bearer | 删好友（单方删除即双向解除） |
| GET | /friends | Bearer | 好友列表（在线状态/好友度） |
| POST | /heartbeat | Bearer | 心跳（默认 3 分钟，响应 next_secs 可调） |
| POST | /visit | Bearer | 申请串门（好友+在线+对方<3 访客） |
| POST | /home | Bearer | 回家（离开串门） |

## 安全设计

- **密码**：PBKDF2-SHA256 + 每用户独立盐，10 万次迭代，服务端不存明文
- **会话**：48 位随机 token，永久有效；写接口只认 `Authorization: Bearer`，不认 Cookie（无 CSRF 面）
- **注入**：无 SQL（KV），用户输入绝不进入 KV 键名，键名只用服务端生成的 uid
- **XSS**：纯 JSON API 无 HTML 输出；入参剥离控制字符 + 白名单字符校验；客户端 textContent 渲染
- **限频**：注册/登录同 IP 10 秒 1 次（KV TTL 尽力而为）
- **校验**：账号 3-12 位 `[A-Za-z0-9_]`；密码 6-30 位必含大小写；昵称唯一（≤120 字，支持中文）；宠物名 ≤24 字

## 隐私

服务端只存客户端过滤后的数据：`coding/idle/away/visiting` 四态、昵称、宠物名、好友度、时间戳。
**不接触也不存储**任何应用名、窗口标题、击键内容。客户端侧有白名单序列化层与红线测试（`src-tauri/src/share.rs`）。
限频键使用 IP 的 SHA-256 摘要，不存原始 IP。
