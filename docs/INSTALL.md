# 安装 Vibe Pet

一只常驻桌面的像素宠物，在 vibe coding 期间提供低打扰的陪伴、轻量记录与小圈子社交。

本文面向**装来用**的人。开发者命令见文末「开发者」一节。

## 系统要求

| 项目 | 要求 |
|---|---|
| 系统 | macOS 13.0+（Ventura 及以上） |
| 芯片 | Apple Silicon（arm64）或 Intel（x86_64）均可 |
| Node.js | ≥ 18 |
| Rust | ≥ 1.77（`src-tauri/Cargo.toml` 中的 `rust-version`） |
| 磁盘 | 约 4 GB（Rust 工具链 + 构建缓存，装完可删缓存） |
| 网络 | 首次需下载 Rust 工具链与依赖包 |

> **为什么只支持 macOS**：宠物的核心体验是「全屏透明、置顶、但不抢焦点」，这依赖 macOS 私有 API 与 NSPanel（`tauri-nspanel`）。Windows / Linux 暂无对应实现。

> **不需要任何系统授权**：宠物只查询「距上次按键/鼠标多少秒」和「前台应用的 bundle id」，不接触键位内容、窗口标题、文件名。因此安装后不会有辅助功能、输入监控之类的授权弹窗 —— 如果出现了，说明有问题，请反馈。

## 一键安装（推荐）

```bash
# 已有仓库：
cd vibe-pet
bash scripts/install.sh

# 或直接克隆（指定你的仓库地址）：
bash scripts/install.sh --clone <git仓库地址>
```

脚本会依次完成五件事，**已就绪的依赖会自动跳过**，可安全重复运行：

1. 检查/安装 Xcode 命令行工具、Rust、Node、pnpm
2. `pnpm install` 安装前端依赖
3. 跑一遍单元测试（确认代码健康）
4. 构建并打包出 `.app`
5. **ad-hoc 签名**后装入 `/Applications`（先停掉正在运行的宠物，避免覆盖失败）

首次编译 Rust 较慢，约 **5–15 分钟**，这是正常的，不是卡住了。

### 脚本参数

| 参数 | 作用 |
|---|---|
| （无） | 完整安装：依赖 → 构建 → 装入 `/Applications` |
| `--build-only` | 只构建出 `.app`，不安装 |
| `--dev` | 只起开发模式（不打包） |
| `--clone <url>` | 克隆到 `~/vibe-pet` 后再安装 |
| `--skip-tests` | 跳过单元测试（装得快一些） |
| `--uninstall` | 从 `/Applications` 卸载 |
| `--uninstall --purge` | 卸载并删除配置与速记数据 |
| `--help` | 查看用法 |

## 手动安装（分步）

想自己控制每一步时用这个：

```bash
# 1. Xcode 命令行工具（若未装，会弹系统窗口，点「安装」）
xcode-select --install

# 2. Rust
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
source "$HOME/.cargo/env"     # cargo 默认不在 PATH 中

# 3. Node ≥18（有 Homebrew 时）
brew install node
# 4. pnpm
npm install -g pnpm

# 5. 依赖 + 构建
cd vibe-pet
pnpm install
pnpm tauri build

# 6. 签名后放入 Applications
codesign --force --deep --sign - src-tauri/target/release/bundle/macos/vibe-pet.app
cp -R src-tauri/target/release/bundle/macos/vibe-pet.app /Applications/
```

## 启动与日常使用

```bash
open -a vibe-pet        # 启动（也可在启动台点）
```

| 操作 | 方式 |
|---|---|
| 功能菜单 | **右键宠物**（速记 / 每日提醒 / 好友 / 今日速记 / 设置 / 退出） |
| 随时记一笔 | `Alt+Space`，再按一次收起 |
| 管理每日提醒 | `Alt+R`，再按一次收起 |
| 拖动宠物 | 直接拖 |
| 退出 | `Ctrl+Alt+Cmd+Q`，或托盘菜单 → 退出 |

首次打开若被系统拦下：**系统设置 → 隐私与安全性 → 仍要打开**（自建应用未走公证，属正常现象）。

> 开机自启：配置项已预留，界面暂未开放。需要的话手动把 `/Applications/vibe-pet.app` 加进「系统设置 → 通用 → 登录项」。

## ⚠️ 怎么关掉它（重要）

宠物是全屏透明置顶窗口，不在 Dock、不在 Cmd+Tab。**四种退出方式任选**：

| 方式 | 操作 |
|---|---|
| 终端（最可靠） | `pnpm stop`（在仓库目录内） |
| 全局快捷键 | `Ctrl+Alt+Cmd+Q` |
| 托盘菜单 | 点菜单栏图标 → 退出 |
| 手动兜底 | `pkill -9 -f vibe-pet` |

如果桌面点击出现异常（点不到其他应用），直接在终端跑 `pnpm stop`。

## 卸载

```bash
bash scripts/install.sh --uninstall            # 只删应用
bash scripts/install.sh --uninstall --purge    # 连配置与速记一起删
```

## 数据放在哪

| 数据 | 位置 |
|---|---|
| 配置（人格、提醒、番茄、LLM…） | `~/Library/Application Support/dev.vibepet.app/config.json` |
| 当日特效奖励 | `~/Library/Application Support/dev.vibepet.app/rewards.json`（隔天失效） |
| 速记（内置目录） | `~/Library/Application Support/dev.vibepet.app/notes/YYYY-MM-DD.md` |
| 速记（Obsidian，可选） | 在设置里填 vault 目录后，会**同时**写一份到那里 |

两个速记落点是冗余设计：任一写入失败都不影响另一个，绝不丢记录。

## 更新

```bash
cd vibe-pet
git pull
bash scripts/install.sh
```

脚本会先停掉正在运行的宠物，再覆盖 `/Applications` 里的旧版本。配置与速记不受影响。

## 可选：社交服务（好友 / 串门）

好友、串门是可选功能，需要自建同步服务。不部署不影响其他功能。

### 方式一：EdgeOne Pages（国内访问友好，推荐）

1. EdgeOne 控制台创建 Pages 项目并接入仓库（或控制台编辑器粘贴 `worker-edgeone/edge-functions/` 下的代码）
2. 控制台完成 KV 绑定：项目详情 → KV 存储 → 绑定命名空间 → 变量名 **`SYNC_KV`**
3. 部署后把地址填进宠物：**右键宠物 → 设置 → 好友 → 服务器**（填到 `/api` 结尾，如 `https://xxx.edgeone.app/api`）

本地验证（与线上同一份逻辑）：

```bash
node worker-edgeone/local-dev.js        # http://localhost:8787
```

### 方式二：Cloudflare Worker

```bash
cd worker
npx wrangler login
npx wrangler kv namespace create SYNC     # 把输出的 id 填进 wrangler.toml
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

部署后同样把地址填进宠物设置。完整说明见 `worker/README.md`。

## 可选：管理员数据看板（仅自己可见）

查看线上注册统计、用户明细与使用习惯（提醒/速记/番茄/在线时长）。线上只暴露 JSON API（需要口令），页面在本地打开。

1. EdgeOne 控制台给边缘函数配两个 **Secret 类型环境变量**（配置后需重新部署生效）：
   - `ADMIN_USER` —— 看板账号
   - `ADMIN_PASS` —— 看板密码
2. 本地打开看板页：

```bash
cd worker-edgeone
python3 -m http.server 8899             # 或任意静态服务
# 浏览器访问 http://localhost:8899/admin/?api=https://你的域名/api
```

3. 登录后可看：总用户/今日活跃/当前在线、注册与使用习惯趋势（30 天）、用户列表（可搜索）、点用户行展开个人明细。

用量数据由桌面客户端心跳自动捎带（只有聚合计数，无任何内容，隐私红线不变）；旧版客户端不携带也完全兼容。

本地联调看板（与线上同一份逻辑）：

```bash
ADMIN_USER=boss ADMIN_PASS=YourPass node worker-edgeone/local-dev.js 8787
# 打开 admin 页面，服务器填 http://localhost:8787
```

## 常见问题

**构建卡住 / 很慢**
首次要编译整个 Rust 依赖树，5–15 分钟属正常。之后是增量构建，几秒到几十秒。

**cargo 下载依赖慢**
可配置国内镜像（`~/.cargo/config.toml`），例如：

```toml
[source.crates-io]
replace-with = "ustc"
[source.ustc]
registry = "sparse+https://mirrors.ustc.edu.cn/crates.io-index/"
```

**构建时报 `Port 1420 is already in use`**
有残留的 vite 占着端口：`pnpm stop`。

**提示「应用已损坏，无法打开」**
右键应用 → 打开；或 系统设置 → 隐私与安全性 → 仍要打开。脚本已做 ad-hoc 签名，通常不会遇到。

**桌面点不动其他应用**
宠物窗口的穿透逻辑异常时会拦截点击。终端执行 `pkill -9 -f vibe-pet`（这是必须记住的兜底手段）。

**宠物一直不说话**
- 默认人格是「安静」（首次打开就不打扰是最低要求），去 设置 → 性格 改成「偶尔吐槽」或「唠唠」
- 人已离开电脑（10 分钟无输入）时宠物在睡觉，不会说话
- 没配 LLM 时用本地语料库，话会少一些

**设置的提醒没弹出来**
- 触发窗口是「提前量 → 提醒时间 +15 分钟」，错过就不补（补提醒只会烦人）
- 检查时间格式 `HH:MM`，且宠物在运行

**番茄工作法没给特效奖励**
需要在休息期间**至少 1 分钟不碰键盘和鼠标**才算认真休息。特效当天有效，隔天失效。

**说话内容不对 / 想换模型**
设置 → AI 接入：填自己的地址、模型、协议（支持 OpenAI Completions / Responses、Anthropic Messages），可一键测试连通性。不填就完全走本地语料，零外发请求。

## 开发者

```bash
pnpm install
export PATH="$HOME/.cargo/bin:$PATH"

pnpm tauri dev     # 一体化启动（前端 + Rust，热重载）
pnpm dev           # 只起前端（vite，端口 1420）
pnpm test          # 前端单元测试
pnpm build         # 类型检查 + 前端构建
pnpm stop          # 停止宠物与开发服务器

cd src-tauri && cargo test     # Rust 单元测试
```

窗口行为（透明 / 置顶 / 焦点 / 穿透）无法自动化测试，见
`docs/plans/2026-08-29-vibe-pet-m1.md` Task 7 的手工验证清单。

## 相关文档

- 设计：`docs/plans/2026-08-29-vibe-pet-design.md`
- M1 计划：`docs/plans/2026-08-29-vibe-pet-m1.md`
- 同步服务：`worker/README.md`
