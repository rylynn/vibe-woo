# 更新镜像手工验证清单

日期：____（执行时填）
版本：____ / ____（从 → 到）

> 镜像 = 同步服务搬运 GitHub Releases 制品，客户端「镜像优先、GitHub 兜底」。
> 设计与已核实语义见 `docs/superpowers/specs/2026-09-20-update-mirror-design.md`，
> 服务端/客户端自动化测试已覆盖的部分这里不重复（test-sync / test-worker / updater 单测）。
> 需要：可访问的同步服务（含 ADMIN_* 配置）、镜像推送凭据、两台架构其一。

## 准备

- [ ] `node scripts/test-remote.mjs <服务地址>` 全绿（**首次推镜像之前**跑：
      其中镜像断言假定空库；且绝不推送制品 —— 假 manifest 会顶掉真版本）
- [ ] 镜像凭据三件齐备（环境变量或 `~/.vibe-pet/mirror*.txt`）：
      `MIRROR_BASE_URL` / `MIRROR_ADMIN_USER` / `MIRROR_ADMIN_PASS`
- [ ] 以版本 A 正常安装并运行（**必须 release 构建** ——
      `dangerousInsecureTransportProtocol` 的 http 端点校验只在非 debug 构建生效，
      dev 模式测不出这条链路）

## 服务端行为（curl 即可，不需要客户端）

- [ ] 空库 `GET <base>/update/latest` → **404**（不能 204：updater 把 204 当
      「无更新」短路，会跳过 GitHub 兜底）
- [ ] `GET <base>/update/pkg` → 404；`?v=不存在` → 404
- [ ] 推送后 `GET <base>/update/latest` → 200，`platforms.*.url` 已重写为
      `<本服务>/api/update/pkg?v=X.Y.Z`，响应头 `Cache-Control: no-store`
- [ ] `GET <base>/update/pkg?v=X.Y.Z` → 200 字节流，与本地制品 sha256 一致，
      响应头 `Cache-Control: public, max-age=3600`
- [ ] 无 token `POST /api/admin/update/manifest` → 401/403

## 用例（客户端）

- [ ] **镜像优先**：`/etc/hosts` 把 github.com 指向 127.0.0.1 → 关于 →
      立即检查更新 → 仍能下载并升级（清单与包字节均来自镜像）
- [ ] **空库回退 GitHub**：镜像清空（或指向未发布的新部署）→ 立即检查 →
      回退 GitHub 成功（404 不短路；状态行不出现「检查失败」）
- [ ] **镜像黑洞超时**：镜像地址指向不拒绝也不回应的地址（如防火墙 DROP 的
      IP）→ 立即检查 → ≤30s 换 GitHub 兜底成功（manifest 超时不影响下载）
- [ ] **镜像跟随配置**：设置 → 同步服务填 https 域名 → 检查请求该域名；
      填 `http://非IP域名` → 回落内置地址（继承 syncclient 校验）
- [ ] **F1 既有用例在镜像路径复跑**：下载与按住不装 / Resting 安装 / 番茄
      保护 / 升级气泡只说一次（见 `2026-09-03-updater-verification.md`）
- [ ] **隐私抓包**：镜像两个 GET 均无 Authorization 头、无 uid/token 参数；
      关闭自动更新后无请求

## 发版链路（release.sh / push-mirror.sh）

- [ ] **正常推送**：配好凭据跑 `bash scripts/release.sh` → 第 11 步 ok，
      回读 version 与 sha256 一致；`--check` 模式显示「镜像凭据已就绪」
- [ ] **推送失败不阻断**：故意用错口令跑发版 → GitHub Release 照发 + 仅 warn
      + 提示补推命令；`bash scripts/push-mirror.sh <版本>` 补推成功
- [ ] **`--skip-mirror`**：跳过且仅 warn，GitHub Release 完整
- [ ] **版本回退拒绝**：对已有 1.5.0 的镜像推 1.4.0 → 服务端 400，脚本 exit 1
- [ ] **补推路径**：`bash scripts/push-mirror.sh`（不带参数）→ 自动从 GitHub
      最新 release 下载制品推送并回读校验
