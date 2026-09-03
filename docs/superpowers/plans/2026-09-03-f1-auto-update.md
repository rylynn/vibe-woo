# F1 自动更新 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 独立后台线程每 24 小时匿名检查一次 GitHub Releases，自动下载、等用户休息时安装重启；升级后宠物气泡说一次 ≤50 字的核心变更摘要；设置「关于」区提供开关与手动检查。

**Architecture:** 新增 `src-tauri/src/updater.rs`（独立线程 + tokio current-thread runtime，不走插件系统）承载检查/下载/择时安装；`version-notes.json` 经 `include_str!` 编译进二进制做离线摘要；配置走既有 `config.rs` → `configcmd.rs` → `src/config.ts` 三层；前端只在 `about.ts` 加一个区块 + 监听 `pet://update-status`。发版靠新脚本 `scripts/release.sh`（校验三处版本 + 摘要存在且 ≤50 字 → universal 构建 → latest.json → gh release）。

**Tech Stack:** tauri-plugin-updater 2（minisign 验签）、tokio（既有依赖，补 time feature）、bash + gh。

**Spec:** `docs/superpowers/specs/2026-09-03-auto-update-words-srs-panel-chrome-design.md` 设计一。

## Global Constraints

- 隐私红线：更新检查是**匿名 GET**，绝不携带任何用户数据；默认开启、设置可关；文案（设置 hint + README 隐私节）必须写明。
- minisign 公钥 `RWTXgo0enNRL4BIgPXVpuj3PWJbXlIMduaFHIpFqivTivSNy8d8mMq+H`（id E04BD49C1E8D82D7）进 `tauri.conf.json`；私钥只存在用户本机（`~/.vibe-pet/updater.key` 或环境变量），**绝不入库**。
- 仓库当前是私有的（用户已确认先不改）：客户端匿名 GET latest.json 会 404 → 走静默失败路径，这是设计内行为；仓库转公开后无需改代码自动生效。
- 所有错误静默（自动路径 eprintln，手动路径经事件回显），24 小时后重试。
- 安装时机只认一个判据：`sensedrive::shared_state()` 的 `tempo == Resting` 且不在番茄工作期；不满足每 5 分钟重试，**按住不装**。
- 注释、文案、测试名全部中文。
- 版本号：合入时**问用户要**（`.codebuddy/rules/version-on-merge.md`），不许自己编；三处真源同步。
- 每个任务完成跑 `cd src-tauri && cargo test`（涉及前端再跑 `npx tsc --noEmit`）。

---

### Task 1: 配置字段 auto_update + last_run_version

**Files:**
- Modify: `src-tauri/src/config.rs`（Config 结构体 246-278 行、Default 285-304 行）
- Modify: `src-tauri/src/configcmd.rs`（ConfigView 56-88、to_view 90-119、ConfigPatch 127-153、update_config 155-234）
- Modify: `src/config.ts`（ConfigView、ConfigPatch、FALLBACK_CONFIG）
- Test: `src-tauri/src/config.rs` tests 模块

**Interfaces:**
- Produces: `Config.auto_update: bool`（serde default true）、`Config.last_run_version: String`（serde default 空）、`ConfigView.auto_update: bool`、`ConfigPatch.auto_update: Option<bool>`、前端 `ConfigView.auto_update: boolean` / `ConfigPatch.auto_update?: boolean`

- [ ] **Step 1: 写失败测试（config.rs tests 模块追加）**

```rust
    #[test]
    fn 旧配置缺失auto_update字段时默认开启() {
        // 0.4.x 的 config.json 没有 auto_update / last_run_version ——
        // 升级后必须默认开启更新，而不是永远关着
        let c: Config = serde_json::from_str(
            r#"{"size_index":1,"roam_scope":"nearby","persona":"quiet"}"#,
        )
        .unwrap();
        assert!(c.auto_update);
        assert_eq!(c.last_run_version, "");
    }
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test 旧配置缺失auto_update字段`
Expected: FAIL（编译错：没有 `auto_update` 字段）

- [ ] **Step 3: 实现**

`Config` 结构体（`pub avatar` 之前）插入两个字段：

```rust
    /// 自动更新：默认开。每天匿名 GET 一次 GitHub Releases 检查新版本，
    /// 不上传任何用户数据；下载完成后等用户休息时才安装重启。
    #[serde(default = "default_true")]
    pub auto_update: bool,
    /// 上次运行的版本号。升级后启动据此说一次「更新了什么」，随后回写。
    /// 空串 = 从未记录（首次安装，不提示）。
    #[serde(default)]
    pub last_run_version: String,
```

`Default for Config` 的 `avatar: None,` 之前插入：

```rust
            auto_update: true,
            last_run_version: String::new(),
```

configcmd.rs：`ConfigView` 加 `pub auto_update: bool,`（放 `autostart` 后面）；`to_view` 加 `auto_update: c.auto_update,`；`ConfigPatch` 加 `pub auto_update: Option<bool>,`；`update_config` 的 `patch.reminders` 块之前插入：

```rust
    if let Some(v) = patch.auto_update {
        cfg.auto_update = v;
    }
```

src/config.ts：`ConfigView` 加 `auto_update: boolean;`（`autostart` 后）；`ConfigPatch` 加 `auto_update?: boolean;`；`FALLBACK_CONFIG` 加 `auto_update: true,`。

- [ ] **Step 4: 验证通过并提交**

Run: `cd src-tauri && cargo test && cd .. && npx tsc --noEmit`
Expected: 全绿

```bash
git add src-tauri/src/config.rs src-tauri/src/configcmd.rs src/config.ts
git commit -m "feat(f1): 配置新增 auto_update 与 last_run_version"
```

---

### Task 2: version-notes 摘要逻辑（纯函数）

**Files:**
- Create: `src-tauri/version-notes.json`
- Create: `src-tauri/src/updater.rs`（本任务先建骨架：常量 + 纯函数 + 测试，无 tauri 依赖部分）
- Modify: `src-tauri/src/main.rs`（mod 列表加 `mod updater;`，第 40 行 `mod usage;` 之后）

**Interfaces:**
- Produces: `pub fn should_show_note(current: &str, last_run: &str, notes: &str) -> Option<String>`、`pub fn note_too_long(note: &str) -> bool`、`pub const VERSION_NOTES: &str`

- [ ] **Step 1: 创建 version-notes.json（当前 0.4.1 起步，条目按已发版本补）**

```json
{
  "0.4.1": "词卡复习兜底与资讯跳转优化"
}
```

> 说明：0.4.1 已发布。F3/F2/F1 合入时各自问用户拿版本号，并在本文件补上 ≤50 字的摘要（release.sh 强制校验）。首次装 0.4.1 的用户因 `last_run_version` 为空不会被打扰。

- [ ] **Step 2: 写 updater.rs 骨架与失败测试**

```rust
//! 自动更新：独立后台线程，24 小时一查，下载后等用户休息再装。
//!
//! 设计（docs/superpowers/specs/2026-09-03-auto-update-words-srs-panel-chrome-design.md F1）：
//! - 独立线程而非插件系统第五插件：更新是系统能力不是桌宠行为；
//! - 匿名 GET GitHub Releases，不上传任何用户数据，设置可关；
//! - 安装时机只认一个判据：键盘节奏 Resting 且不在番茄工作期 ——
//!   更新桌宠不值得打断工作；
//! - 仓库私有期间匿名 GET 得 404，走静默失败路径；转公开后自动生效。

/// 版本摘要表，编译进二进制：离线可用，检查更新时不额外发请求。
pub const VERSION_NOTES: &str = include_str!("../version-notes.json");

/// 更新摘要的硬性字数上限（用户需求：50 字以内）。
const NOTE_MAX_CHARS: usize = 50;

/// 升级后要不要说一句（纯函数）。
///
/// 返回气泡文案当且仅当：上次运行版本非空（首次安装不打扰）、
/// 与当前版本不同、且当前版本有非空摘要。回写由调用方负责，只此一次。
pub fn should_show_note(current: &str, last_run: &str, notes: &str) -> Option<String> {
    if last_run.is_empty() || current == last_run {
        return None;
    }
    let note = note_for(notes, current)?;
    Some(format!("我升级到 {current} 啦：{note}"))
}

/// 从摘要表 JSON 里取指定版本的摘要（空串视为没有）。
fn note_for(notes: &str, version: &str) -> Option<String> {
    let map: std::collections::BTreeMap<String, String> = serde_json::from_str(notes).ok()?;
    let n = map.get(version)?.trim().to_string();
    if n.is_empty() { None } else { Some(n) }
}

/// 摘要是否超字数（release.sh 在 bash 侧做同一校验，这里供单测兜底）。
pub fn note_too_long(note: &str) -> bool {
    note.chars().count() > NOTE_MAX_CHARS
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOTES: &str = r#"{"0.4.1":"词卡复习兜底与资讯跳转优化","0.5.0":"番茄钟休息验证上线；词卡例句配中文翻译"}"#;

    #[test]
    fn 升级且有摘要时给出气泡文案() {
        let s = should_show_note("0.5.0", "0.4.1", NOTES).unwrap();
        assert_eq!(s, "我升级到 0.5.0 啦：番茄钟休息验证上线；词卡例句配中文翻译");
    }

    #[test]
    fn 首次安装不说_空last_run() {
        assert_eq!(should_show_note("0.5.0", "", NOTES), None);
    }

    #[test]
    fn 版本未变不说() {
        assert_eq!(should_show_note("0.5.0", "0.5.0", NOTES), None);
    }

    #[test]
    fn 当前版本没有摘要则静默() {
        assert_eq!(should_show_note("0.9.9", "0.4.1", NOTES), None);
    }

    #[test]
    fn 编译进二进制的摘要表全部合规() {
        let map: std::collections::BTreeMap<String, String> =
            serde_json::from_str(VERSION_NOTES).unwrap();
        assert!(!map.is_empty(), "摘要表不该为空");
        for (v, n) in &map {
            assert!(!n.trim().is_empty(), "{v} 摘要为空串");
            assert!(!note_too_long(n), "{v} 摘要超 50 字：{n}");
        }
    }

    #[test]
    fn 字数按字符计() {
        assert!(!note_too_long("一二三四五"));
        assert!(note_too_long(&"字".repeat(51)));
    }
}
```

main.rs：`mod usage;` 之后加一行 `mod updater;`。

- [ ] **Step 3: 跑测试确认通过**

Run: `cd src-tauri && cargo test updater`
Expected: PASS（纯函数一步到位；此处无先红步骤——函数与测试同文件同批落地，编译失败即红）

- [ ] **Step 4: 提交**

```bash
git add src-tauri/version-notes.json src-tauri/src/updater.rs src-tauri/src/main.rs
git commit -m "feat(f1): 版本摘要表与升级提示纯函数"
```

---

### Task 3: updater 插件接线 + 后台检查线程

**Files:**
- Modify: `src-tauri/Cargo.toml`（依赖区；tokio 行补 time feature）
- Modify: `src-tauri/tauri.conf.json`（plugins 键 + bundle.createUpdaterArtifacts）
- Modify: `src-tauri/capabilities/default.json`
- Modify: `src-tauri/src/main.rs`（插件注册 71-82 行、setup 141 行后）
- Modify: `src-tauri/src/plugin/arbiter.rs`（加 `pomodoro_working()` 访问器，169 行 `on_pomodoro_phase` 附近）
- Modify: `src-tauri/src/updater.rs`（线程主体）

**Interfaces:**
- Consumes: Task 1 的 `configcmd::current().auto_update`
- Produces: `pub fn spawn(app: AppHandle)`、`async fn perform_check(app: &AppHandle, manual: bool)`（Task 4 的命令复用）、`pub const EVENT_UPDATE_STATUS`、`arbiter::pomodoro_working() -> bool`

- [ ] **Step 1: 依赖与配置**

Cargo.toml 依赖区（`tauri-plugin-single-instance = "2"` 之后）加：

```toml
# 自动更新（F1）：minisign 验签 + GitHub Releases 分发。
# 私钥绝不入库，只在本机 ~/.vibe-pet/updater.key 或环境变量。
tauri-plugin-updater = "2"
```

既有 `tokio = { version = "1", features = ["rt"] }` 改为（后台线程的 sleep 计时需要 time feature）：

```toml
tokio = { version = "1", features = ["rt", "time"] }
```

tauri.conf.json：顶层（`"app"` 键之前）加 `plugins`，`bundle` 里加 `createUpdaterArtifacts`：

```json
  "plugins": {
    "updater": {
      "endpoints": [
        "https://github.com/rylynn/vibe-woo/releases/latest/download/latest.json"
      ],
      "pubkey": "RWTXgo0enNRL4BIgPXVpuj3PWJbXlIMduaFHIpFqivTivSNy8d8mMq+H"
    }
  },
```

```json
  "bundle": {
    "active": true,
    "targets": ["app"],
    "createUpdaterArtifacts": true,
    "icon": ["icons/32x32.png", "icons/128x128.png", "icons/128x128@2x.png", "icons/icon.png"]
  }
```

capabilities/default.json 权限数组加 `"updater:default"`。

- [ ] **Step 2: arbiter 访问器 + 失败测试**

`on_pomodoro_phase`（169 行）之前插入：

```rust
/// 当前是否处于番茄工作期（更新安装等模块查询：工作期不打断）。
pub fn pomodoro_working() -> bool {
    with_state(|s| s.pomodoro_working)
}
```

tests 模块追加：

```rust
    #[test]
    fn 工作期查询默认为否() {
        assert!(!pomodoro_working());
    }
```

Run: `cd src-tauri && cargo test 工作期查询`
Expected: PASS（默认 false，测试是回归锚点）

- [ ] **Step 3: updater.rs 线程主体（`note_too_long` 之后追加）**

```rust
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::configcmd;

/// 手动检查的状态回显事件名（about 面板监听）。
pub const EVENT_UPDATE_STATUS: &str = "pet://update-status";

/// 启动后首查延迟：不与开机抢资源。
const STARTUP_DELAY: Duration = Duration::from_secs(2 * 60);
/// 检查周期。
const CHECK_INTERVAL_SECS: u64 = 24 * 3600;
/// 下载完成后等待「用户在休息」的轮询间隔。
const INSTALL_POLL: Duration = Duration::from_secs(5 * 60);

/// 防重入：自动与手动共用，下载/等待安装期间不再发起第二次检查。
static BUSY: AtomicBool = AtomicBool::new(false);

/// 持久化的更新状态（store id "update"，重启不清零）。
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct UpdateState {
    /// 上次成功发起检查的 epoch 秒。
    #[serde(default)]
    last_check_epoch_secs: u64,
}

/// 手动检查各阶段的回显（serde tag = kind，小写下划线）。
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum UpdateStatus {
    Checking,
    UpToDate { version: String },
    Downloaded { version: String },
    Failed { reason: String },
}

fn epoch_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 启动自动更新线程：自建 current-thread runtime，与主线程解耦。
pub fn spawn(app: AppHandle) {
    std::thread::spawn(move || {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("updater: tokio runtime 构建失败");
        rt.block_on(async move {
            let mut state: UpdateState = crate::plugin::store::load(&app, "update");
            // 周期跨重启：距上次检查不足 24h 就等到边界再查；
            // 从未查过（或已过边界）则启动延迟 2 分钟后首查。
            let since = epoch_secs().saturating_sub(state.last_check_epoch_secs);
            let wait = if state.last_check_epoch_secs == 0 || since >= CHECK_INTERVAL_SECS {
                STARTUP_DELAY
            } else {
                Duration::from_secs(CHECK_INTERVAL_SECS - since)
            };
            tokio::time::sleep(wait).await;
            loop {
                if configcmd::current().auto_update {
                    perform_check(&app, false).await;
                    state.last_check_epoch_secs = epoch_secs();
                    let _ = crate::plugin::store::save(&app, "update", &state);
                }
                tokio::time::sleep(Duration::from_secs(CHECK_INTERVAL_SECS)).await;
            }
        });
    });
}

/// 一次检查→下载→择时安装。manual=true 时各阶段回显事件，自动路径静默。
async fn perform_check(app: &AppHandle, manual: bool) {
    if BUSY.swap(true, Ordering::SeqCst) {
        if manual {
            emit_status(app, UpdateStatus::Failed { reason: "已经在检查了，稍等一下".into() });
        }
        return;
    }
    run_check(app, manual).await;
    BUSY.store(false, Ordering::SeqCst);
}

async fn run_check(app: &AppHandle, manual: bool) {
    if manual {
        emit_status(app, UpdateStatus::Checking);
    }
    let updater = match app.updater() {
        Ok(u) => u,
        Err(e) => return report(app, manual, format!("初始化失败：{e}")),
    };
    let update = match updater.check().await {
        Ok(Some(u)) => u,
        Ok(None) => {
            if manual {
                let v = app.config().version.clone().unwrap_or_default();
                emit_status(app, UpdateStatus::UpToDate { version: v });
            }
            return;
        }
        // 仓库私有期间匿名 GET 得 404 落到这里 —— 设计内行为，静默即可
        Err(e) => return report(app, manual, format!("检查失败：{e}")),
    };
    let version = update.version.clone();
    // 注：tauri-plugin-updater 2.x 的 download 第二个 handler 是
    // FnOnce(Result<PathBuf, Error>)；若所用小版本签名不同，按编译器
    // 提示把第二个闭包改成 `|| {}` 即可，语义不受影响。
    match update.download(|_, _| {}, |_| {}).await {
        Ok(_) => {
            if manual {
                emit_status(app, UpdateStatus::Downloaded { version });
            }
            hold_and_install(app, update).await;
        }
        Err(e) => report(app, manual, format!("下载失败：{e}")),
    }
}

/// 下载完成后按住不装：只有 Resting 且不在番茄工作期才装 + 重启。
async fn hold_and_install(app: &AppHandle, update: tauri_plugin_updater::Update) {
    loop {
        let resting = crate::sensedrive::shared_state()
            .is_some_and(|s| s.tempo == crate::state::Tempo::Resting);
        if resting && !crate::plugin::arbiter::pomodoro_working() {
            match update.install().await {
                Ok(()) => {
                    // install 不负责退出；restart 不返回
                    app.restart();
                }
                Err(e) => {
                    eprintln!("[updater] 安装失败：{e}");
                    return;
                }
            }
        }
        tokio::time::sleep(INSTALL_POLL).await;
    }
}

fn emit_status(app: &AppHandle, s: UpdateStatus) {
    let _ = app.emit(EVENT_UPDATE_STATUS, &s);
}

fn report(app: &AppHandle, manual: bool, reason: String) {
    if manual {
        emit_status(app, UpdateStatus::Failed { reason });
    } else {
        eprintln!("[updater] {reason}");
    }
}
```

- [ ] **Step 4: main.rs 注册**

依赖插件链（`tauri_plugin_single_instance::init` 之后）追加：

```rust
        // 自动更新（F1）：minisign 验签，GitHub Releases 分发
        .plugin(tauri_plugin_updater::Builder::new().build())
```

setup 里 `plugin::host::spawn(app.handle());`（141 行）之后追加：

```rust
            // 自动更新：独立线程，24h 一查；升级摘要气泡见 maybe_show_update_note
            updater::spawn(app.handle());
```

- [ ] **Step 5: 验证**

Run: `cd src-tauri && cargo test && cargo check`
Expected: 全绿（dev 构建连不上私有 Releases 只会 eprintln，不影响测试）

- [ ] **Step 6: 提交**

```bash
git add src-tauri/Cargo.toml src-tauri/Cargo.lock src-tauri/tauri.conf.json src-tauri/capabilities/default.json src-tauri/src/main.rs src-tauri/src/updater.rs src-tauri/src/plugin/arbiter.rs
git commit -m "feat(f1): updater 插件接线与 24h 后台检查线程（Resting 才安装）"
```

---

### Task 4: 手动检查命令 + 升级摘要气泡

**Files:**
- Modify: `src-tauri/src/updater.rs`（命令 + 启动摘要）
- Modify: `src-tauri/src/main.rs`（invoke_handler 加命令；setup 加 maybe_show_update_note）

**Interfaces:**
- Consumes: Task 3 的 `run_check`/`perform_check`、Task 2 的 `should_show_note`/`VERSION_NOTES`、Task 1 的 `last_run_version`
- Produces: `#[tauri::command] check_update_now`、`pub fn maybe_show_update_note(app: &AppHandle)`

- [ ] **Step 1: updater.rs 追加命令与启动摘要（文件末尾、tests 模块之前）**

```rust
/// 设置里「立即检查更新」。检查/下载各阶段经 EVENT_UPDATE_STATUS 回显；
/// 安装与自动路径一致：等用户休息，不立刻重启。
#[tauri::command]
pub async fn check_update_now(app: AppHandle) -> Result<(), String> {
    perform_check(&app, true).await;
    Ok(())
}

/// 启动时（main.rs setup 调）：升级后说一次「更新了什么」。
///
/// 无论说不说都先回写 last_run_version —— 气泡是尽力而为的惊喜，
/// 绝不能因为发送失败就在下次启动重复打扰。延迟 5 秒发：webview
/// 未就绪时发事件会丢。首次安装（last_run 为空）不提示。
pub fn maybe_show_update_note(app: &AppHandle) {
    let current = app.config().version.clone().unwrap_or_default();
    let text = should_show_note(
        &current,
        &configcmd::current().last_run_version,
        VERSION_NOTES,
    );

    let mut cfg = configcmd::current();
    if cfg.last_run_version != current {
        cfg.last_run_version = current;
        let _ = crate::config::save(app, &cfg);
        configcmd::set_current(&cfg);
    }

    if let Some(text) = text {
        let app = app.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(5));
            // 复用说话气泡通道（8 秒自动消失），source=local 不占 LLM
            let _ = app.emit(
                crate::talkdrive::EVENT_TALK,
                serde_json::json!({ "text": text, "source": "local" }),
            );
        });
    }
}
```

（`use` 里已带 `Duration`；`talkdrive::EVENT_TALK` 是既有常量 `"pet://talk"`。）

- [ ] **Step 2: main.rs 注册**

invoke_handler 列表（`plugin::words::words_feedback` 之后）加 `updater::check_update_now`。

setup 里 `configcmd::init` 之后、`window::setup_pet_window` 之前插入：

```rust
            // 升级后说一次「更新了什么」（回写 last_run_version 保证只此一次）
            updater::maybe_show_update_note(app.handle());
```

- [ ] **Step 3: 写测试（should_show_note 已覆盖纯逻辑；此处验证与 talkdrive 通道的一致性）**

updater.rs tests 模块追加：

```rust
    #[test]
    fn 摘要气泡走talk事件常量() {
        // maybe_show_update_note 发的是 talkdrive 的 EVENT_TALK，
        // 前端 main.ts 已有监听（8 秒自动消失），不需要新前端代码。
        assert_eq!(crate::talkdrive::EVENT_TALK, "pet://talk");
    }
```

- [ ] **Step 4: 验证并提交**

Run: `cd src-tauri && cargo test`
Expected: PASS

```bash
git add src-tauri/src/updater.rs src-tauri/src/main.rs
git commit -m "feat(f1): 手动检查命令与升级摘要一次性气泡"
```

---

### Task 5: 「关于」面板的更新区块

**Files:**
- Modify: `src/overlay/about.ts`（imports、字段、show、render、新方法）
- Modify: `index.html`（`.pet-about-brand` 样式块附近加 `.pet-about-update`）

**Interfaces:**
- Consumes: Task 1 的 `ConfigView.auto_update`、Task 4 的 `check_update_now` 命令与 `pet://update-status` 事件

- [ ] **Step 1: about.ts 改动**

imports 区（第 1-4 行）改为：

```ts
import type { Box } from "../interact/hit-test";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { formatAppInfo, getAppInfo, type AppInfo } from "../appinfo";
import { getConfig, updateConfig, type ConfigView } from "../config";
import { enablePanelDrag } from "./panel-drag";
```

类字段（`private back` 之后）加：

```ts
  /** 完整配置（更新开关用；show 时刷新）。 */
  private cfg: ConfigView | null = null;
  /** 更新状态行（常驻元素，事件到来时刷新文案）。 */
  private readonly statusEl = document.createElement("span");
```

构造函数末尾（`enablePanelDrag` 之后）注册监听（一次）：

```ts
    // 更新状态回显：手动检查各阶段由后端事件驱动，常驻监听
    void listen<{ kind: string; version?: string; reason?: string }>(
      "pet://update-status",
      (e) => this.onUpdateStatus(e.payload),
    );
```

`show()` 里 `this.uid = cfg.social_uid || "";` 之后加 `this.cfg = cfg;`。

`render()` 的版本区块（`this.row("标识", info.identifier);` 之后、`divider("账号")` 之前）插入：

```ts
    this.el.appendChild(this.divider("更新"));
    if (this.cfg) this.el.appendChild(this.updateSection(this.cfg));
```

新方法（`footer()` 之前）：

```ts
  /** 自动更新开关 + 手动检查 + 状态行。隐私红线：文案必须写明匿名与可关。 */
  private updateSection(cfg: ConfigView): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "pet-about-update";

    const row = document.createElement("div");
    row.className = "pet-settings-row";
    const label = document.createElement("label");
    label.textContent = "自动更新";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.checked = cfg.auto_update;
    check.addEventListener("change", () => {
      void updateConfig({ auto_update: check.checked });
    });
    row.append(label, check);
    wrap.appendChild(row);

    const hint = document.createElement("div");
    hint.className = "pet-settings-hint";
    hint.textContent =
      "每天匿名检查一次 GitHub Releases，不发送任何本机数据，可随时关闭；下载好的更新会等你休息时再自动重启";
    wrap.appendChild(hint);

    const action = document.createElement("div");
    action.className = "pet-settings-row";
    const btn = document.createElement("button");
    btn.className = "pet-bubble-confirm";
    btn.textContent = "立即检查更新";
    btn.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.statusEl.textContent = "检查中…";
      void invoke("check_update_now").catch((err: unknown) => {
        this.statusEl.textContent = `检查失败：${String(err)}`;
      });
    });
    this.statusEl.className = "pet-about-value";
    this.statusEl.title = "更新状态";
    this.statusEl.style.cssText =
      "color:#8b93a7;font-size:11px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap";
    action.append(btn, this.statusEl);
    wrap.appendChild(action);
    return wrap;
  }

  /** pet://update-status 事件 → 状态行文案（面板关着就忽略）。 */
  private onUpdateStatus(p: { kind: string; version?: string; reason?: string }): void {
    if (!this.open || !p.kind) return;
    if (p.kind === "checking") {
      this.statusEl.textContent = "检查中…";
    } else if (p.kind === "up_to_date") {
      this.statusEl.textContent = `已是最新 v${p.version ?? "?"}`;
    } else if (p.kind === "downloaded") {
      this.statusEl.textContent = `已下载 v${p.version ?? "?"}，将在你休息时自动重启`;
    } else if (p.kind === "failed") {
      this.statusEl.textContent = p.reason ?? "检查失败";
    }
  }
```

> 注意：`listen` 在纯浏览器/测试环境会因 `window.__TAURI_INTERNALS__` 缺失而 reject —— 已用 `void` + promise 吞掉，构造函数不会抛（与getConfig 的容错风格一致）。

- [ ] **Step 2: index.html 样式**

`.pet-about-brand` 规则块之后插入：

```css
      .pet-about-update {
        display: flex;
        flex-direction: column;
        gap: 6px;
        padding: 2px 0 4px;
      }
```

- [ ] **Step 3: 验证并提交**

Run: `npx tsc --noEmit && npx vitest run`
Expected: 全绿（about 无既有测试，跑的是全量回归）

```bash
git add src/overlay/about.ts index.html
git commit -m "feat(f1): 关于面板更新区块（开关/手动检查/状态行）"
```

---

### Task 6: release.sh + README + 验证文档

**Files:**
- Create: `scripts/release.sh`（可执行）
- Modify: `README.md`（更新节 311 行起重写；隐私节补一句）
- Create: `docs/plans/2026-09-03-updater-verification.md`

- [ ] **Step 1: scripts/release.sh 全文**

```bash
#!/usr/bin/env bash
# 一键发版（F1 自动更新配套）。
# 校验三处版本一致 + 当前版本有 ≤50 字摘要 → universal 构建（含签名）
# → 生成 latest.json → gh release 发布。
#
# 用法：
#   scripts/release.sh          完整发版
#   scripts/release.sh --check  只做校验，不构建（合入前自查用）
#
# 私钥绝不入库：放 ~/.vibe-pet/updater.key 或导出 TAURI_SIGNING_PRIVATE_KEY。
set -euo pipefail

cd "$(dirname "$0")/.."

# ---- 1. 三处版本一致（version-on-merge 规则）----
V_CONF=$(python3 -c "import json;print(json.load(open('src-tauri/tauri.conf.json'))['version'])")
V_CARGO=$(sed -n 's/^version *= *"\(.*\)"/\1/p' src-tauri/Cargo.toml | head -1)
V_PKG=$(python3 -c "import json;print(json.load(open('package.json'))['version'])")
if [[ "$V_CONF" != "$V_CARGO" || "$V_CONF" != "$V_PKG" ]]; then
  echo "✗ 版本不一致：tauri.conf=$V_CONF cargo=$V_CARGO package=$V_PKG" >&2
  exit 1
fi
echo "✓ 三处版本一致：$V_CONF"

# ---- 2. 当前版本必须有 ≤50 字的更新摘要 ----
python3 - "$V_CONF" <<'PY'
import json, sys
v = sys.argv[1]
notes = json.load(open('src-tauri/version-notes.json'))
if v not in notes or not notes[v].strip():
    print(f"✗ version-notes.json 缺 {v} 的非空摘要", file=sys.stderr)
    sys.exit(1)
n = notes[v].strip()
if len(n) > 50:
    print(f"✗ {v} 摘要超 50 字（{len(n)}）：{n}", file=sys.stderr)
    sys.exit(1)
print(f"✓ 摘要就绪：{n}")
PY

if [[ "${1:-}" == "--check" ]]; then
  echo "✓ 校验通过（--check 模式，不构建）"
  exit 0
fi

# ---- 3. 签名私钥（本机文件或环境变量）----
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" && -f "$HOME/.vibe-pet/updater.key" ]]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$HOME/.vibe-pet/updater.key")"
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  echo "✗ 缺更新签名私钥：导出 TAURI_SIGNING_PRIVATE_KEY 或放 ~/.vibe-pet/updater.key" >&2
  exit 1
fi

# ---- 4. universal 构建（aarch64 + x86_64，产出 .app.tar.gz + .sig）----
pnpm tauri build --target universal-apple-darwin

ART="src-tauri/target/universal-apple-darwin/release/bundle/macos/vibe-pet.app.tar.gz"
SIG="$ART.sig"
if [[ ! -f "$ART" || ! -f "$SIG" ]]; then
  echo "✗ 缺更新产物或签名（bundle.createUpdaterArtifacts 未生效？）" >&2
  exit 1
fi
echo "✓ 更新产物就绪：$ART"

# ---- 5. latest.json（两架构指向同一 universal 产物）----
NOW=$(python3 -c "import datetime;print(datetime.datetime.now(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'))")
python3 - "$V_CONF" "$NOW" "$ART.sig" <<'PY'
import json, sys
v, now, sig_path = sys.argv[1:4]
sig = open(sig_path).read().strip()
url = "https://github.com/rylynn/vibe-woo/releases/latest/download/vibe-pet.app.tar.gz"
latest = {
    "version": v,
    "pub_date": now,
    "platforms": {
        "darwin-aarch64": {"signature": sig, "url": url},
        "darwin-x86_64": {"signature": sig, "url": url},
    },
}
open("latest.json", "w").write(json.dumps(latest, indent=2))
print("✓ latest.json 已生成")
PY

# ---- 6. 发布 GitHub Release（私有期靠 gh 鉴权也能发）----
gh release create "v$V_CONF" "$ART#vibe-pet.app.tar.gz" "$SIG#vibe-pet.app.tar.gz.sig" \
  latest.json --title "v$V_CONF" --generate-notes
echo "✓ 已发布 v$V_CONF（仓库转公开后更新检查自动生效）"
```

```bash
chmod +x scripts/release.sh
```

> 注意：`latest.json` 里的下载 URL 是匿名直链（updater 用）；`#` 后是 gh 上传后的展示文件名。

- [ ] **Step 2: README 更新节重写（311 行 `## 更新` 起整节替换）**

```markdown
## 更新

**内置自动更新**：宠物每天匿名检查一次 GitHub Releases，下载新版本后等你休息时自动安装重启；升级后它会用气泡说一句这次更新了什么（每版本 ≤50 字）。仓库公开前匿名检查会静默失败（404），公开后自动生效。

不想用它联网？设置 → 关于 → 关闭「自动更新」即可，之后按下面的手动方式升级：

```bash
cd vibe-pet
git pull
bash scripts/install.sh
```

脚本幂等：依赖已就绪就跳过，会先停掉正在跑的宠物再覆盖 `/Applications`，并对新包重新 ad-hoc 签名。

**开发者发版**：`bash scripts/release.sh`（先 `--check` 自查版本与摘要）；需要 minisign 私钥（见 `src-tauri/tauri.conf.json` 的公钥对应的密钥对，私钥绝不入库）。

**不会丢的东西**：配置、当日奖励、速记都在 `~/Library/Application Support/dev.vibepet.app/`，不在 `.app` 包内 —— 重装不影响，卸载也不会删（除非加 `--purge`）。
```

隐私节（`## 隐私`）的清单末尾补一行：

```markdown
- **自动更新**：开启时每天向 GitHub Releases 发一次匿名 GET（只含版本检查请求，不带任何本机数据），可在 设置 → 关于 关闭。
```

- [ ] **Step 3: 手工验证清单 docs/plans/2026-09-03-updater-verification.md**

```markdown
# F1 自动更新手工验证清单

日期：____（执行时填）
版本：____ / ____（从 → 到）

> 全链路涉及 GitHub Releases、minisign 与重启，无法自动化 —— 按本清单过。
> 需要：测试用 Release 权限、私钥（~/.vibe-pet/updater.key）、两台架构其一即可。

## 准备

- [ ] `bash scripts/release.sh --check` 通过（版本一致 + 摘要 ≤50 字）
- [ ] 以版本 A 正常安装并运行（`pnpm tauri build` 或 install.sh）

## 用例

- [ ] **检查失败路径（仓库私有期）**：点 设置 → 关于 → 立即检查更新 →
      状态行显示「检查失败：…」；宠物行为无异常，无崩溃日志
- [ ] **已是最新**：发布 vA 的 Release 后点立即检查 → 「已是最新 vA」
- [ ] **下载与按住不装**：发布 vB（> A）→ 立即检查 →「已下载 vB，将在你
      休息时自动重启」；保持敲键 15 分钟 → 应用**不**重启
- [ ] **Resting 触发安装**：停手 5 分钟以上（Tempo=Resting）→ ≤5 分钟内
      应用自动重启，关于面板版本变为 vB
- [ ] **番茄保护**：番茄工作期内即使 Resting 也不重启（工作期结束 + Resting 后才装）
- [ ] **升级气泡只出现一次**：vB 重启后 ~5 秒宠物说「我升级到 vB 啦：…」
      8 秒消失；再手动重启应用**不**再说
- [ ] **首次安装不打扰**：全新机器装 vB（last_run_version 为空）→ 无升级气泡
- [ ] **开关**：关闭自动更新 → 后台 24h 周期不再发起检查（控制台无 updater
      日志）；手动检查仍可用
- [ ] **摘要红线**：version-notes.json 故意写 51 字 → `release.sh --check`
      拒绝发版
```

- [ ] **Step 4: 验证并提交**

Run: `bash scripts/release.sh --check`
Expected: `✓ 三处版本一致：0.4.1` + `✓ 摘要就绪：…` + `✓ 校验通过`

```bash
git add -f scripts/release.sh docs/plans/2026-09-03-updater-verification.md
git add README.md
git commit -m "feat(f1): release.sh 一键发版、README 更新/隐私文案与手工验证清单"
```

---

### Task 7: 手工验证 + 版本号 + 合入

**Files:**
- Modify: `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`package.json`（版本三处）
- Modify: `src-tauri/version-notes.json`（新版本摘要）
- Modify: `docs/plans/2026-09-03-updater-verification.md`（执行记录）

- [ ] **Step 1: 本地冒烟（`pnpm tauri dev`）**

- [ ] 设置 → 关于：出现「更新」区块（开关默认开 + 立即检查按钮 + hint）
- [ ] 点「立即检查更新」→ 状态行出现「检查中…」→ 仓库私有期落「检查失败：…」（预期）
- [ ] 开关切换后重进面板状态保持；`config.json` 里 `autoUpdate` 字段正确
- [ ] 启动 5 秒内无意外气泡（当前版本摘要只对「升级」说，同版本启动不说）
- [ ] 全量自动化：`cd src-tauri && cargo test && cd .. && npx tsc --noEmit && npx vitest run`

- [ ] **Step 2: 版本号（问用户，不许自己编）**

向用户要版本号（参考：当前 0.4.1，F3/F2 已各自占号）；三处 `version` 同步，`version-notes.json` 加该版本条目（与用户确认 ≤50 字摘要，建议：「自动更新上线：每天静默检查新版本，休息时自动安装」）。

- [ ] **Step 3: 发布验证（可选，需私钥与用户配合）**

按 `docs/plans/2026-09-03-updater-verification.md` 全量过一遍；仓库仍私有时跳过「已是最新/下载」用例，只验证失败路径与本地行为，其余标注「待仓库公开后补验」。

- [ ] **Step 4: 合入**

```bash
git add -A
git commit -m "feat: 自动更新（每天一查、休息时安装、升级摘要气泡）

版本: <用户给的版本号>

- 独立后台线程每 24h 匿名 GET GitHub Releases 检查（可关，默认开）；
  启动延迟 2 分钟首查，last_check 持久化跨重启
- 下载完成后按住不装：只在键盘节奏 Resting 且非番茄工作期安装重启，
  每 5 分钟轮询 —— 更新不打断工作
- 升级摘要：version-notes.json 编译进二进制，≤50 字硬校验；
  升级后启动 5 秒宠物气泡说一次（复用 pet://talk，8 秒消失）
- 设置 → 关于：自动更新开关 + 立即检查更新 + 状态行回显
- scripts/release.sh：三处版本一致 + 摘要校验 → universal 构建 →
  latest.json → gh release；私钥绝不入库
- 仓库私有期匿名 GET 404 走静默失败，转公开后零改动自动生效

验证：cargo test N 绿 / vitest N 绿 / tsc 通过 / 手工清单见
docs/plans/2026-09-03-updater-verification.md"
```
