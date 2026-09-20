# 设计：客户端更新镜像（GitHub Releases 真源 + 同步服务分发）

日期：2026-09-20
状态：已与用户确认（两项决策见下表），随批次 A/B/C/D 实施

## 目标

自动更新此前唯一通道是 GitHub Releases，而不少网络环境（尤其国内）到不了
GitHub —— 这些用户永远收不到更新。本设计给同步服务加「更新镜像」能力：
GitHub Releases 仍是**真源与兜底**，镜像只是国内可达的搬运副本，客户端
endpoints = **[镜像, GitHub]**，镜像优先、失败自动换下一个。

## 已确认的决策

| 决策点 | 结论 |
|---|---|
| 分发链路 | **发版时推送**：release.sh 在 `gh release create` 后经 admin 鉴权把制品推到后台存储。不选「服务端代理实时拉取」—— 腾讯云节点访问 GitHub 不稳，真源不可达时镜像也就不可达 |
| 镜像地址 | **跟随同步服务配置**：镜像 = `syncclient::base_url()`（social.server 留空用内置默认）+ `/update/latest`；更新检查匿名，不依赖登录 |

## 已核实的关键语义（tauri-plugin-updater 2.11.0，本机 cargo registry 源码复核）

这五条决定了服务端行为，改动镜像相关代码前先读：

1. **多 endpoint 回退**：check 循环在网络错误/解析失败时记 last_error 并
   **继续下一个** endpoint；全部 non-2xx → `Error::ReleaseNotFound` →
   客户端走既有「检查失败」路径。
2. **204 短路整个检查**（直接 `return Ok(None)`）—— 镜像空库必须回 **404**，
   绝不能 204，否则跳过 GitHub 兜底。
3. **下载阶段不做 endpoint 回退**：只请求 manifest 里那个 URL —— 所以服务端
   强制「先 pkg 后 manifest」+ pkg 键带版本号，把不一致窗口压到零。
4. **builder `.timeout()` 只约束 manifest 请求**：check 构造的 Update 硬编码
   `timeout: None`，13MB 慢链路下载不受影响。
5. **`dangerousInsecureTransportProtocol` 是硬前置**：非 debug 构建下 http
   端点不开此开关，`.endpoints()` 直接报错。内置镜像是明文 IP http，必须开；
   安全性由 minisign 验签保证（与传输无关），假签名过不了验证，旧清单触发
   不了降级（版本单向比较）。

## 架构

```
发版：release.sh → gh release create（真源）
              └→ scripts/push-mirror.sh → admin login
                                        → POST /api/admin/update/pkg?v=X（octet-stream 裸字节）
                                        → POST /api/admin/update/manifest（JSON）
                                        → 回读校验（version + sha256 字节比对）
检查：客户端每 24h → GET {base_url}/update/latest（匿名）
        ├─ 200 → platforms.*.url 已重写为 {origin}/api/update/pkg?v=X
        │        → 下载 pkg → minisign 验签 → 等 Resting 安装（不变）
        └─ 404 / 网络错误 → 继续试 endpoints[1] = GitHub latest.json
```

## 服务端（批次 A）

`worker-edgeone/edge-functions/api/lib-account.js` 四个端点（三套运行时
共用同一份业务逻辑，各自只加二进制适配层）：

| 端点 | 方法 | 鉴权 | 行为 |
|---|---|---|---|
| `/api/update/latest` | GET | 匿名 | 读 `upd_manifest`；无/损坏 → 404；有 → 重写 url 后 `__raw` JSON 返回，`no-store` |
| `/api/update/pkg` | GET | 匿名 + rlu_ 限频 | `?v=X.Y.Z` 缺省取 manifest 版本；命中 → `__raw` 字节流，`public, max-age=3600` |
| `/api/admin/update/pkg?v=X` | POST | admin Bearer | octet-stream 裸字节；semver 校验、1KB–24MB |
| `/api/admin/update/manifest` | POST | admin Bearer | 形状校验 → **强制该版本 pkg 已存在**（先包后单）→ 版本回退拒绝（数字三元组，`?force=1` 逃生）→ 覆盖 manifest → 清旧版本 pkg 键 |

要点：

- **键名**：`upd_manifest`（string）/ `upd_pkg_<x_y_z>`（二进制，点替下划线）。
- **URL 重写**：服务端按请求 origin 把 manifest 里的下载地址改写为本服务
  `/update/pkg?v=`，客户端拿到的清单天然指向镜像自身（三种部署一个行为）。
- **store 抽象扩展**：`put(key, string | Uint8Array)`、`get(key, {binary})`。
  local-dev 的 FileStore 二进制走 `.bin` 旁路文件 —— JSON 每次 put 整体重写，
  13MB 进 JSON 会把每次心跳变成 17MB 磁盘写。
- **限频分桶**：pkg 下载用独立的 `rlu_` 前缀，不与登录共桶（否则发版回读
  校验会被自己的登录限频挡住，这是实现期真实踩过的坑）。
- **降级设计**：EdgeOne KV 若不支持二进制 → publish 报错 → 镜像留空 →
  客户端回退 GitHub，属设计内降级，不阻断。

## 客户端（批次 B）

- `src-tauri/src/updater.rs`：`updater_endpoints(mirror_base, github)` 纯函数
  构造 [镜像, GitHub]；镜像 base 复用 `syncclient::base_url()`（只读
  social.server，不碰 token/登录态，https/http-IP 校验原样继承）；GitHub
  兜底值读 tauri.conf.json 的 endpoints[0]（单一真源），取不到回内置常量。
  manifest 超时 30s（防镜像黑洞）。
- `src-tauri/tauri.conf.json`：`dangerousInsecureTransportProtocol: true`
  （见语义 5；仅放行明文 http 传输，验签信任链不变）。
- 状态机（BUSY/BusyGuard/hold_and_install/Resting 安装）**一律不动**。

## 发版链路（批次 C）

- `scripts/push-mirror.sh`（唯一实现）：凭据 = 环境变量或
  `~/.vibe-pet/mirror*.txt`（`MIRROR_BASE_URL` / `MIRROR_ADMIN_USER` /
  `MIRROR_ADMIN_PASS`，绝不回显）；先包后单；**回读校验默认必做**
  （latest version + 双平台 url 重写 + pkg sha256 字节比对）；制品缺省从
  `gh release download` 取（补推场景）。失败 exit 1。
- `scripts/release.sh` 第 11 步调它：**失败仅 warn 不阻断**（GitHub Release
  已是真源），提示补推命令；`--skip-mirror` 跳过；`--check` 增凭据齐备
  检查（warn 不 die）。

## 隐私红线

- 更新检查是**匿名 GET**，无 Authorization、无 uid/token，与社交心跳天然分离。
- pkg 限频只存 IP 哈希（与既有 rl_ 同策略），不落原始 IP。
- 推送凭据只在发版机环境变量/本机文件，绝不入库、不进日志。

## 测试与验证

- 自动化：test-sync（内存 store 直调 dispatch，~30 条镜像断言）、test-worker
  （CF fetch handler 全链路含二进制）、test-remote（对已部署空库加 3 条只读
  断言 —— **绝不推制品**，假 manifest 会顶掉真版本）、updater 4 条单测。
- 手工：`docs/plans/2026-09-20-update-mirror-verification.md`（镜像优先
  hosts 屏蔽 / 空库回退 / 黑洞超时 / release 构建专项等，无法自动化）。

## 风险备注

- 制品 13MB（universal .app.tar.gz）：Cloudflare KV 与 EdgeOne Pages KV
  单值上限均 25MB，放得下；服务端上限校验 24MB。
- EdgeOne KV 二进制支持未实测（预览环境推真实制品试一次），不支持属设计内降级。
- CF 免费档 KV 写 1000 次/天：每次 pkg 下载 1 写（限频键），更新频率下足够。
