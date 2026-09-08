# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目简介

Vibe Pet：macOS 常驻桌面像素宠物（Tauri 2 / Rust + TypeScript，无前端框架，Canvas 像素渲染）。它感知用户 coding 状态（零授权：只取空闲秒数与前台 bundle id，绝不接触键位内容/窗口标题/文件名），提供陪伴、速记、提醒、番茄钟与插件系统。**仅 macOS**，依赖 NSPanel 私有 API。

代码注释、commit message、文档均使用中文。

## 常用命令

```bash
pnpm install
export PATH="$HOME/.cargo/bin:$PATH"   # cargo 默认不在 PATH 中

pnpm tauri dev     # 一体化启动（前端热重载 + Rust）
pnpm dev           # 只起前端（vite，端口 1420）
pnpm test          # 前端单元测试（vitest run）
pnpm test:sync     # 同步服务（lib-account.js）端到端自检
pnpm build         # 类型检查 + 前端构建
pnpm stop          # 停止宠物与开发服务器

cd src-tauri && cargo test    # Rust 单元测试
```

跑单个测试：

```bash
npx vitest run tests/mood-eyes.test.ts     # 单个前端测试文件
cargo test plan_schedule                   # 单个 Rust 测试（按名过滤）
```

- 包管理器固定 pnpm 10（`package.json` 的 `packageManager`）；pnpm 11 需 `pnpm-workspace.yaml` 里放行 esbuild build script（已配好，两套键共存是刻意的）。
- 打完整安装包：`pnpm tauri build` 或 `bash scripts/install.sh`（幂等，装进 `/Applications`）。
- 更新签名只在发版开：`tauri.conf.json` 的 `createUpdaterArtifacts` 默认 `false`，所以日常构建不需要 updater 私钥口令；发版由 `scripts/release.sh` 用 `--config src-tauri/tauri.release.conf.json` 覆盖开启（等价命令 `pnpm run build:release`）。

## 架构

### 感知 → 表现主链路（Rust → 前端）

```
sensor.rs / envsense.rs (120ms 采样，空闲退避 500ms / 锁屏 1s)
  → Snapshot → state.rs 状态机 (Doing × Tempo + 深夜修饰符)
  → mood.rs 心情积分器（有惯性，非瞬时映射）
  → sensedrive.rs 经 "pet://state" 事件推送前端
  → pet.ts / appearance.ts / anim/ 渲染（三档帧率：睡眠 4 / 待机 12 / 活跃 30 fps）
```

- `talkdrive.rs` 定时说话（人格频率是硬性要求）、`react.rs` 状态迁移即时反应（带冷却）、`reminddrive.rs` 提醒触发。
- Tier-0 环境信号（锁屏/麦克风占用/视频断言/构建-AI 进程名/专注模式）在 `envsense.rs`，全部零授权零内容。

### 穿透反向链路（前端 → Rust）—— 安全关键

前端每 50ms 把「需要接收鼠标的区域」上报 Rust（`src/bridge.ts` → `hittest.rs`），内容不变时 500ms 心跳。Rust 侧 1.5s 收不到上报即强制恢复穿透 —— **前端崩溃也不能锁死桌面**。宠物是全屏透明置顶窗，穿透出错会拦截整个桌面的点击，因此存在不依赖 UI 的逃生快捷键 `Ctrl+Alt+Cmd+Q`（`main.rs` 的 kill_switch）。改动窗口/穿透相关代码后按 `docs/plans/2026-08-29-m1-verification.md` 手工验证清单过一遍（无法自动化测试）。

### 插件系统（src-tauri/src/plugin/）

解耦三原则：宿主不认识具体插件（只认 trait）；仲裁器不认识具体插件（只认优先级与频率）；前端渲染器不认识 Rust（只认 PluginCard 的 JSON 契约）。

- `Plugin` trait：`next_tick`（纯查询，宿主可能反复问）+ `tick`（所有网络/LLM 调用只发生在 tick 里）。
- `host.rs`：单线程调度所有插件，宿主自己记账 deadline（插件每次返回固定间隔，若每轮重问会无限顺延 —— 0.3.0 之前因此翻过车），panic 隔离（连续 3 次panic 进程内禁用）。
- `arbiter.rs`：打扰仲裁（优先级、频率、番茄工作期静默 + 延迟队列补发）。番茄相位是全系统唯一的插件→仲裁器特例（`TickCtx::set_pomodoro_phase`）。
- 卡片经 `"pet://plugin-card"` 事件到前端，前端 `src/plugins/registry.ts` 按 `kind` 找渲染器（卡片实现在 `src/plugins/cards/`）。
- **加新插件**：在 `plugin/` 下建模块实现 trait，然后在 `host::registry()` 与 `mod::installed()` **各加一行**（两处注册点）。
- 插件配置经 `store.rs` 各存各的文件；`plugin_set_config` 后下一个 tick 生效（≤30s）。

### 前后端契约

- 事件名统一 `pet://` 前缀（`pet://state`、`pet://plugin-card`…）。
- `src/state.ts` 的 `PetState` 与 Rust `state.rs` 的 `PetState` 手工对齐（如 `Doing::is_producing` ↔ `isProducing`），改一处要同步另一处。
- 前端渲染器不直接 invoke，统一走 `CardHost` 受控操作收口。

### 可选同步服务

`worker/`（Cloudflare Worker，主实现）与 `worker-edgeone/`（EdgeOne 边缘函数版）：账号/好友/心跳/串门。不部署不影响任何其他功能。

## 红线与硬约束

1. **隐私红线不可放宽**：`share.rs` 的社交上报是白名单构造（从零构造新结构，不是从状态里删字段）；`sensor.rs` 只取时间间隔；`envsense.rs` 零授权零内容。改动这几处会被重点 review。
2. **不打扰是第一原则**：新功能默认静默，宁可少说一句。
3. **CPU < 1% 空闲**：渲染用脏矩形、分层帧率，绝不整屏重绘；绝不产生半透明像素（辉光用棋盘点阵）。
4. **不抢焦点**：窗口是 nonactivating NSPanel，只有速记/设置这类明确输入场景临时取焦点。
5. **纯逻辑优先可测**：状态推导、心情、穿透决策、提醒判定、番茄验证、插件调度写成纯函数并补单测，驱动层保持薄。
6. **仓库不内置任何 LLM 端点或密钥**，不配置即纯本地零外发。

## 版本合入规则（.codebuddy/rules/version-on-merge.md）

- 每次合入必须显式带版本号（commit message / PR 描述里写 `版本: x.y.z`）。**用户没给就先问，不许自己编**。
- 版本真源是 `src-tauri/tauri.conf.json` 的 `version`，必须与 `src-tauri/Cargo.toml`、`package.json` 三处同步改，缺一处算没做完。
- 版本号只进不退；语义化：修 bug/文案 = patch，加功能 = minor，配置/数据格式不兼容 = major；拿不准按 minor 提并跟用户确认。
- 合入前检查：`npx tsc --noEmit`、`src-tauri` 下 `cargo check`、`npx vitest run` 全绿；改过同步服务还要跑 `pnpm test:sync`（业务逻辑）与 `pnpm test:worker`（Cloudflare 适配层）。
- 同步服务有两套部署：`worker-edgeone/`（EdgeOne Pages，需备案域名才能长期访问）与 `worker/`（Cloudflare Worker，免备案）。**两边共用同一份 `worker-edgeone/edge-functions/api/lib-account.js`**，各目录只放运行时适配层 —— 不要把业务逻辑复制成两份。
- 「关于」面板的构建时间/Git 提交由 `src-tauri/build.rs` 构建期注入，不要手工维护。

## 其他

- 设计文档与验证清单在 `docs/plans/`（按日期命名），代码注释里常引用，改相关模块先读对应设计文档。
- 窗口/托盘/快捷键行为改动手工验证：见 `docs/plans/2026-08-29-m1-verification.md`。
- objc2 必须与 tauri-nspanel 同一大版本（tauri-nspanel v2.1 用 objc2 0.6），否则 Message trait 不兼容会编译失败（见 `Cargo.toml` 注释）。
