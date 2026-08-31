# Vibe Pet

一只常驻桌面的像素宠物，在 vibe coding 期间提供低打扰的陪伴、轻量捕获与小圈子社交。

它知道你在写代码、进入状态、卡住了、还是已经离开 —— 但**不读你的任何内容**：
只查询「距上次按键多少秒」和「前台应用是谁」，不接触键位、窗口标题、文件名。
因此它不需要辅助功能权限，装上即用，没有授权弹窗。

- 平台：macOS 13+（Apple Silicon / Intel）
- 技术栈：Tauri 2（Rust）+ TypeScript，Canvas 像素渲染，无前端框架
- 体积：约 13 MB，空闲 CPU 占用 < 1%

---

## 目录

- [功能](#功能)
- [安装](#安装)
- [启动](#启动)
- [使用](#使用)
- [怎么关掉它](#怎么关掉它)
- [更新](#更新)
- [隐私](#隐私)
- [架构](#架构)
- [开发](#开发)
- [项目结构](#项目结构)
- [已知限制与路线图](#已知限制与路线图)
- [贡献](#贡献)
- [许可](#许可)

---

## 功能

### 常驻陪伴

- **像素风渲染**：Canvas 手绘，整数倍缩放（48 / 96 / 144 / 192 px）保证锐利。呼吸、眨眼、眼神跟随鼠标、待机小动作（跳、伸懒腰、张望）。
- **律动同步**：呼吸频率跟随你的击键速度 —— 写得越快，它越来劲。进入心流时身体外围亮起点阵辉光。
- **状态感知**：`在干什么 × 什么节奏` 二维状态机。它能区分「在编辑器里正常敲键」和「盯着屏幕 90 秒没动」—— 后者是 vibe coding 特有的「在思考 / 在等 AI」，宠物会默默陪你盯屏幕。
- **心情有惯性**：心情是积分器而非瞬时映射（满足感 / 烦躁感 / 空虚感累积取最大），不会切个窗口就变脸。10 分钟无输入判定你已离开，宠物睡觉。
- **说话**：按人格频率主动冒泡，也会在关键转折时即时反应（进入状态、想通了、回来了、深夜还在写、坐太久了）。

### 速记

`Alt+Space` 全局呼出输入条，写完即存，仪式感很短：宠物走过来，落盘后点头。

双写冗余 —— 内置目录 `notes/YYYY-MM-DD.md` 与可选的 Obsidian vault 各写一份，任一失败都不丢记录。

### 每日提醒

到点弹出**大卡片**，可以直接处理，不用再翻设置：

- **删除** —— 这条提醒不需要了
- **稍后 10 分钟** —— 稍后重响（可反复）
- **改时间** —— 卡片内直接改，带 10 分钟粒度下拉，且只从「最近的未来时间」开始选

### 番茄工作法

设置里开启后进入「工作 → 休息」循环（默认 25 / 5 分钟，可改）。

休息结束时验证：你**至少 1 分钟没碰键盘和鼠标**才算认真休息。做到了，宠物很高兴，并随机获得一个**当天限定**的外观特效（隔天自然失效，可叠加）：

- 吃番茄 —— 嘴里时不时叼着番茄咀嚼
- 吐泡泡 —— 头顶冒泡泡上浮消散
- 星星闪 —— 身上偶尔闪一下

### 人格与 AI 接入

三档人格，决定它多爱说话（频率是硬性要求）：

| 人格 | 说话频率 | 长度 |
|---|---|---|
| 安静 | 4–5 分钟 | ≤ 10 字，多用动作 |
| 偶尔吐槽 | 3–5 分钟 | ≤ 15 字 |
| 唠唠 | 1–3 分钟 | 15–30 字，长短浮动，可带点损友式玩梗 |

说话采用双轨制：配了 LLM 就用 LLM 生成（贴合你的状态与当日记忆），否则落回精心写过的本地语料库。支持 OpenAI Completions / OpenAI Responses / Anthropic Messages 三种协议，设置里可一键测试连通性。

**仓库不内置任何端点或密钥** —— 不配置即纯本地运行，零外发请求；填你自己的地址与 key 才走网络，随时可关。

### 好友社交（可选）

可自建同步服务（Cloudflare Worker，免费额度足够小圈子）：邀请制注册、加好友、看好友在不在写代码、宠物串门。

不部署完全不影响其他功能。宠物去串门时，家里会留一个右下角图标，点一下召回。

---

## 安装

```bash
# 方式一：一键安装（补全依赖 → 构建 → 装入 /Applications）
bash scripts/install.sh

# 方式二：手动，逐步来
xcode-select --install
curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
pnpm install
pnpm tauri build
cp -R src-tauri/target/release/bundle/macos/vibe-pet.app /Applications/
```

要求：macOS 13+、Node ≥ 18、Rust ≥ 1.77。首次编译 Rust 约 5–15 分钟。

详细步骤、参数说明与常见问题见 **[docs/INSTALL.md](docs/INSTALL.md)**。

---

## 启动

装进 `/Applications` 之后就是普通 macOS 应用，不需要 `pnpm tauri dev`，也不需要 Rust / Node 在 PATH 里。

| 方式 | 操作 |
|---|---|
| 终端 | `open -a vibe-pet` |
| Spotlight | `Cmd+Space` → 输入 `vibe-pet` → 回车 |
| 启动台 / Finder | 启动台点图标，或双击 `/Applications/vibe-pet.app` |
| 开机自启 | 系统设置 → 通用 → 登录项与扩展 → 登录时打开 → 加入 `vibe-pet` |

- **单实例**：重复 `open -a vibe-pet` 只会激活已在跑的那只宠物，不会叠出第二层全屏透明窗（`tauri-plugin-single-instance`）。
- **怎么确认它在跑**：它不在 Dock、不在 `Cmd+Tab`，看菜单栏托盘图标，或终端 `pgrep -lf vibe-pet`。
- **加进登录项后就不用管了**：开机自动在，需要退出时用[下面几种方式](#怎么关掉它)。
- **开机自启的界面开关还没做**：配置项已预留，UI 未开放，目前只能手动加登录项。
- 首次启动若被系统拦下：**系统设置 → 隐私与安全性 → 仍要打开**（自建应用未公证，属正常现象）。

---

## 使用

| 操作 | 方式 |
|---|---|
| 随时记一笔 | `Alt+Space`（再按一次收起） |
| 管理每日提醒 | `Alt+R`（再按一次收起） |
| 功能菜单 | 右键宠物：速记 / 每日提醒 / 好友 / 今日速记 / 设置 / 退出 |
| 拖动 | 直接拖 |
| 退出 | `Ctrl+Alt+Cmd+Q`，或托盘菜单，或终端 `pnpm stop` |

数据存放位置：

| 数据 | 路径 |
|---|---|
| 配置（人格、提醒、番茄、LLM…） | `~/Library/Application Support/dev.vibepet.app/config.json` |
| 当日特效奖励 | 同目录 `rewards.json`（隔天失效） |
| 速记 | 同目录 `notes/YYYY-MM-DD.md`（+ 可选 Obsidian vault） |

---

## 怎么关掉它

宠物是全屏透明置顶窗口，不在 Dock、不在 Cmd+Tab。**四种退出方式，任选其一**：

| 方式 | 操作 |
|---|---|
| 终端（最可靠） | `pnpm stop` |
| 全局快捷键 | `Ctrl+Alt+Cmd+Q` |
| 托盘菜单 | 点菜单栏图标 → 退出 |
| 手动兜底 | `pkill -9 -f vibe-pet` |

如果桌面点击出现异常（点不到其他应用），直接在终端跑 `pnpm stop` 或 `pkill -9 -f vibe-pet`。

---

## 更新

**没有内置自动更新**：仓库未接入 `tauri-plugin-updater`，也不做公证签名，所以它不会联网检查新版本。更新就是「拉最新代码 + 重装」，和首次安装同一条命令：

```bash
cd vibe-pet
git pull
bash scripts/install.sh
```

脚本幂等：依赖已就绪就跳过，会先停掉正在跑的宠物再覆盖 `/Applications`，并对新包重新 ad-hoc 签名。Rust 是增量构建，通常几十秒到几分钟（首次除外）。

**不会丢的东西**：配置、当日奖励、速记都在 `~/Library/Application Support/dev.vibepet.app/`，不在 `.app` 包内 —— 重装不影响，卸载也不会删（除非加 `--purge`）。

| 场景 | 命令 |
|---|---|
| 用 `--clone` 装的（默认在 `~/vibe-pet`） | `cd ~/vibe-pet && git pull && bash scripts/install.sh` |
| 先只构建、不覆盖 | `bash scripts/install.sh --build-only` |
| 回退 / 切到某个版本 | `git checkout <tag-or-commit> && bash scripts/install.sh` |
| 连数据一起清空的干净重装 | `git pull && bash scripts/install.sh --uninstall --purge && bash scripts/install.sh` |
| 彻底移除 | `bash scripts/install.sh --uninstall` |

确认装的是哪个版本：

```bash
# /Applications 里实际装的版本，应与 src-tauri/tauri.conf.json 的 version 一致
defaults read /Applications/vibe-pet.app/Contents/Info.plist CFBundleShortVersionString
```

更新后若被系统提示「已损坏 / 无法打开」：右键应用 → 打开，或 系统设置 → 隐私与安全性 → 仍要打开。重装等于换了一个 ad-hoc 签名，系统需要重新确认一次。

---

## 隐私

这是产品的红线，不是配置项：

- **不申请任何系统授权**。用 `CGEventSourceSecondsSinceLastEventType` 只取「距上次按键 / 鼠标事件多少秒」，用 `NSWorkspace` 只取前台应用的 bundle id —— 都不需要辅助功能权限。
- **绝不接触**键位内容、窗口标题、文件名、项目名、任何截屏。
- **社交上报走白名单构造**：不是「从状态里删掉敏感字段」，而是从零构造只含允许字段的新结构，只上报 `coding / idle / away / offline` 四态、昵称、宠物名、好友度。见 `src-tauri/src/share.rs`。
- 速记与 LLM 请求都只在你主动使用时发生，且可完全关闭（关掉即纯本地运行）。

---

## 架构

一次传感器采集到界面变化的完整链路：

```
系统状态采集 (120ms)          状态推导               表现
─────────────────────      ──────────────────    ────────────────
距上次按键秒数      ┐                            ┌ 呼吸节奏（跟随击键频率）
前台应用 bundle id  ┼→ Snapshot → Doing × Tempo ─┤ 眼型 / 眼神 / 黑眼圈
本地小时（深夜）    ┘              ↓              └ 辉光 / 待机动作
                              心情积分器
                                  ↓
                    ┌─────────────┼─────────────┐
                定时说话        即时反应        提醒 / 番茄
                (人格频率)    (状态迁移时)      (到点触发)
                    └─────────────┼─────────────┘
                              事件 → 前端
```

穿透是反向的另一条链路：前端每 50ms 把「哪些区域需要接收鼠标」上报给 Rust，由 Rust 决定窗口是否穿透。上报同时充当心跳 —— 前端失联 1.5 秒后强制恢复穿透，即使前端崩溃也不会锁死桌面。

几条贯穿全局的设计约束：

- **不抢焦点**：窗口是 nonactivating NSPanel。点宠物继续打字，字进编辑器。只有速记窗 / 设置面板这类「你就是要输入」的场景才临时取焦点，关闭即归还。
- **CPU < 1%**：渲染分三档帧率（睡眠 4 / 待机 12 / 活跃 30 fps），脏矩形清除而非整屏重绘。
- **绝不产生半透明像素**：辉光用棋盘点阵而非透明度，与像素美术风格一致，也更省。
- **可测性**：状态机、心情、穿透决策、提醒判定、番茄验证全是纯函数，有单元测试覆盖。

---

## 开发

```bash
pnpm install
export PATH="$HOME/.cargo/bin:$PATH"   # cargo 默认不在 PATH 中

pnpm tauri dev     # 一体化启动（前端热重载 + Rust）
pnpm dev           # 只起前端（vite，端口 1420）
pnpm test          # 前端单元测试
pnpm build         # 类型检查 + 前端构建
pnpm stop          # 停止宠物与开发服务器

cd src-tauri && cargo test    # Rust 单元测试
```

窗口行为（透明 / 置顶 / 不抢焦点 / 穿透）无法自动化测试，改动相关代码后请按
`docs/plans/2026-08-29-m1-verification.md` 的手工验证清单过一遍。

---

## 项目结构

```
src/                          前端（TypeScript，无框架）
├── pet.ts                    宠物渲染主体
├── appearance.ts             状态 → 外观（呼吸周期 / 色调 / 眼型）
├── anim/                     行为、呼吸、微表情、帧率预算
├── interact/                 拖动、命中判定
├── overlay/                  速记、设置、提醒、今日速记、好友、气泡与通知条、菜单
├── bridge.ts                 穿透区域上报（50ms 心跳）
└── state.ts                  Rust 推送状态的类型定义

src-tauri/src/               Rust 后端
├── sensedrive.rs            传感器 → 状态机 → 前端（120ms 循环）
├── state.rs                 状态机：Doing × Tempo + 深夜修饰符
├── mood.rs / activity.rs    心情积分器 / 活动识别（发呆、听歌、摸鱼）
├── talkdrive.rs             定时说话（人格频率硬性要求）
├── react.rs                 事件驱动的即时反应（本地语料，带冷却）
├── reminddrive.rs           每日提醒触发与稍后重响
├── pomodorodrive.rs         番茄循环 + 休息验证
├── rewards.rs               当日特效奖励（隔天失效）
├── persona.rs / llm.rs      人格语料与 prompt / 三种 LLM 协议
├── socialdrive.rs           心跳、好友、自动串门
├── share.rs                 隐私白名单（红线，不可放宽）
├── hittest.rs / passthrough.rs   穿透区域与穿透决策
└── window.rs / tray.rs / shortcut.rs   窗口、托盘、全局快捷键

worker/                       可选的同步服务（Cloudflare Worker）
scripts/                      一键安装、强制停止
docs/                         安装文档、设计文档与计划
```

---

## 已知限制与路线图

- **仅 macOS**。核心体验依赖 macOS 私有 API 与 NSPanel，Windows / Linux 暂无对应实现。
- **未公证签名**。自建应用首次打开需「系统设置 → 隐私与安全性 → 仍要打开」（一键安装脚本已做 ad-hoc 签名）。
- **AI 速记整理是占位**：速记先无条件落盘，LLM 异步整理目前只是预留钩子。
- **开机自启**：配置项已预留，界面尚未开放。需要可手动加进系统登录项。
- 计划中的方向：Windows / Linux 支持、AI 速记整理落地、更丰富的外观与特效。

---

## 贡献

欢迎 issue 与 PR。几条希望一起守住的原则：

1. **不打扰是第一原则**。新功能默认应当静默，宁可少说一句。
2. **隐私红线不可放宽**。`share.rs` 的白名单构造、`sensor.rs` 只取时间间隔，改动这两处会被重点 review。
3. **纯逻辑优先可测**。状态推导、判定类逻辑写成纯函数并补单测，驱动层保持薄。
4. 提交前跑 `pnpm test` 与 `cargo test`。

---

## 许可

[MIT](LICENSE) © 2026 xuj
