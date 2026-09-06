//! 自动更新：独立后台线程，24 小时一查，下载后等用户休息再装。
//!
//! 设计（docs/superpowers/specs/2026-09-03-auto-update-words-srs-panel-chrome-design.md F1）：
//! - 独立线程而非插件系统第五插件：更新是系统能力不是桌宠行为；
//! - 匿名 GET GitHub Releases，不上传任何用户数据，设置可关；
//! - 安装时机只认一个判据：键盘节奏 Resting 且不在番茄工作期 ——
//!   更新桌宠不值得打断工作；
//! - 仓库私有期间匿名 GET 得 404，走静默失败路径；转公开后自动生效。

use std::panic::AssertUnwindSafe;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use futures_util::FutureExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter};
use tauri_plugin_updater::UpdaterExt;

use crate::configcmd;

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

/// BUSY 复位防护：swap(true) 成功后立即构造，作用域结束（正常返回或 panic
/// 展开）都在 Drop 里复位。原先手写 store(false)，run_check 一 panic —— 最
/// 现实的来源是 arbiter::with_state 的锁污染后 `.lock().expect` 连环 panic
/// —— BUSY 就永久卡 true，前端「立即检查更新」从此被顶回「已经在检查了」。
/// 宠物常驻数周不重启，复位绝不能依赖调用方记得收尾。
struct BusyGuard;

impl Drop for BusyGuard {
    fn drop(&mut self) {
        BUSY.store(false, Ordering::SeqCst);
    }
}

/// 持久化的更新状态（store id "update"，重启不清零）。
#[derive(Default, serde::Serialize, serde::Deserialize)]
struct UpdateState {
    /// 上轮检查正常收尾的时刻（epoch 秒）：perform_check 返回后才写入。
    /// 成功升级的路径在 hold_and_install 里 restart 不返回，永不落盘。
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
                    // 单轮 panic 不许带走常驻线程：catch 住、记一行诊断，
                    // 照常睡满 24h 后重试。注意 panic 只能在 poll 边界被
                    // 捕获，同步的 std::panic::catch_unwind 包不住 .await，
                    // 这里用其异步等价 FutureExt::catch_unwind（内部同样走
                    // std::panic::catch_unwind），future 用 AssertUnwindSafe 放行。
                    let checked = AssertUnwindSafe(perform_check(&app, false))
                        .catch_unwind()
                        .await;
                    if checked.is_err() {
                        eprintln!("[updater] 自动检查 panic，本轮放弃，24h 后重试");
                    } else {
                        // panic 那轮不计入「已查」：进程若中途重启，
                        // 下次启动 2 分钟后就会重试，而不是等满 24h。
                        state.last_check_epoch_secs = epoch_secs();
                        let _ = crate::plugin::store::save(&app, "update", &state);
                    }
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
    // 复位统一交给 guard，不再手写 store(false)：自动（本函数被 spawn 循环调）
    // 与手动（check_update_now）两条路径共用这里，成功路径靠返回时 Drop，
    // panic 路径靠展开时 Drop，语义一致且不会双重复位。
    let _guard = BusyGuard;
    run_check(app, manual).await;
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
    // 所用 tauri-plugin-updater 2.11.0：download(on_chunk(usize, Option<u64>),
    // on_finish()) 返回安装包字节，install(bytes) 是同步方法 —— 与早期 2.x
    // 「download 即安装」不同，这里保留简报语义：下载与安装两段，中间卡 Resting。
    match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => {
            if manual {
                emit_status(app, UpdateStatus::Downloaded { version });
            }
            hold_and_install(app, update, bytes).await;
        }
        Err(e) => report(app, manual, format!("下载失败：{e}")),
    }
}

/// 下载完成后按住不装：只有 Resting 且不在番茄工作期才装 + 重启。
async fn hold_and_install(
    app: &AppHandle,
    update: tauri_plugin_updater::Update,
    bytes: Vec<u8>,
) {
    loop {
        let resting = crate::sensedrive::shared_state()
            .is_some_and(|s| s.tempo == crate::state::Tempo::Resting);
        if resting && !crate::plugin::arbiter::pomodoro_working() {
            match update.install(&bytes) {
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

    #[test]
    fn 摘要气泡走talk事件常量() {
        // maybe_show_update_note 发的是 talkdrive 的 EVENT_TALK，
        // 前端 main.ts 已有监听（8 秒自动消失），不需要新前端代码。
        assert_eq!(crate::talkdrive::EVENT_TALK, "pet://talk");
    }

    #[test]
    fn panic防护guard在drop与panic后复位busy() {
        // 正常路径：swap 占用后构造 guard，作用域结束 Drop 复位。
        assert!(!BUSY.swap(true, Ordering::SeqCst), "BUSY 起始应为 false");
        assert!(BUSY.load(Ordering::SeqCst), "占用后应为 true");
        {
            let _guard = BusyGuard;
        }
        assert!(!BUSY.load(Ordering::SeqCst), "guard drop 应复位 BUSY");

        // panic 路径：本修复的核心保证 —— 展开时 guard 照样复位，
        // BUSY 不卡 true，「立即检查更新」才不会从此被顶回「已经在检查了」。
        let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            // swap 返回的是旧值：false 才说明此前未被占用、占用成功。
            assert!(!BUSY.swap(true, Ordering::SeqCst), "复位后应能再次占用");
            let _guard = BusyGuard;
            panic!("模拟检查中途 panic");
        }));
        assert!(caught.is_err(), "panic 应被 catch_unwind 捕获");
        assert!(!BUSY.load(Ordering::SeqCst), "panic 展开后 BUSY 不得卡 true");

        // 兜底复位：同模块测试共享进程，别把 BUSY 带进别的用例。
        BUSY.store(false, Ordering::SeqCst);
    }
}
