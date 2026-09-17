//! 文本输入模式：临时把键盘焦点交给宠物窗口。
//!
//! 背景矛盾（设计文档 3.3 的生死线）：宠物本体绝不抢焦点 ——
//! 点它一下继续打字，字必须进编辑器。因此宠物面板长期持有
//! `becomes_key_only_if_needed(true)`：点 canvas 不会抢键盘，
//! 只有点可编辑元素时才需要焦点。
//!
//! 但速记窗与设置面板呼出时，用户**就是要输入**，必须主动把键盘拿过来。
//! 关闭时归还，键盘回到之前的应用。

use tauri::AppHandle;

/// 呼出输入类面板时调用：让宠物窗口成为 key window 并激活应用。
#[tauri::command]
pub fn begin_text_input(app: AppHandle) {
    #[cfg(target_os = "macos")]
    macos::begin(&app);
}

/// 关闭输入类面板时调用：归还键盘焦点。
#[tauri::command]
pub fn end_text_input(app: AppHandle) {
    #[cfg(target_os = "macos")]
    macos::end(&app);
}

#[cfg(target_os = "macos")]
mod macos {
    use std::sync::Mutex;

    use objc2_app_kit::{
        NSApplication, NSApplicationActivationOptions, NSRunningApplication, NSWorkspace,
    };
    use tauri::AppHandle;
    use tauri_nspanel::ManagerExt;

    /// begin 时记录的「被我们夺走前台的应用」pid，end 时归还。
    ///
    /// 不归还的话宠物会一直粘在 frontmost：后续取词读的是「前台应用的
    /// 选区」，会全军覆没（2026-09-17 三个取词症状的共同根源）。
    /// 面板叠面板（如设置上再开速记）时只记最早那个，不覆盖。
    static PREVIOUS_FRONTMOST: Mutex<Option<i32>> = Mutex::new(None);

    pub fn begin(app: &AppHandle) {
        use std::panic::AssertUnwindSafe;
        let result = tauri_nspanel::objc2::exception::catch(AssertUnwindSafe(|| {
            let Ok(panel) = app.get_webview_panel("pet") else {
                eprintln!("[input] panel 'pet' 不存在");
                return;
            };
            panel.make_key_window();
            panel.order_front_regardless();

            // 激活应用，否则 key window 的键盘事件路由不进来。
            // macOS 14+ 的 activate() 是新的安全接口。
            let mtm = match tauri_nspanel::objc2::MainThreadMarker::new() {
                Some(m) => m,
                None => {
                    eprintln!("[input] 必须在主线程调用");
                    return;
                }
            };
            // 激活前记录被夺走前台的应用（是我们自己则不动已记录值）
            if let Some(prev) = NSWorkspace::sharedWorkspace().frontmostApplication() {
                let pid = prev.processIdentifier();
                if pid != std::process::id() as i32 {
                    let mut g = PREVIOUS_FRONTMOST.lock().unwrap_or_else(|p| p.into_inner());
                    if g.is_none() {
                        *g = Some(pid);
                    }
                }
            }
            let ns_app = NSApplication::sharedApplication(mtm);
            ns_app.activate();
        }));
        if result.is_err() {
            eprintln!("[input] begin_text_input 抛 Obj-C 异常");
        }
        // 通知前端焦点已就绪 —— 替代 rAF 盲轮询，focus 一次到位。
        // 「呼出到能打字」的延迟主因就是盲轮询错过激活完成的时机。
        let _ = tauri::Emitter::emit(app, "pet://input-ready", ());
        eprintln!("[input] 已进入输入模式");
    }

    pub fn end(app: &AppHandle) {
        use std::panic::AssertUnwindSafe;
        let result = tauri_nspanel::objc2::exception::catch(AssertUnwindSafe(|| {
            let Ok(panel) = app.get_webview_panel("pet") else {
                return;
            };
            panel.resign_key_window();

            // 刻意不调用 NSApp.deactivate()。
            //
            // deactivate 会把 WKWebView 打入停用态，触发定时器节流 ——
            // 前端 50ms 心跳停摆 → Rust 误判前端失联 → 强制穿透 →
            // 宠物窗口收不到任何点击（关闭按钮全部失效）。
            //
            // 归还走「激活对方」而非「停用自己」，且只在宠物仍持有前台时
            // 才归还：用户若已自己切走，说明焦点早就不在我们手上，再激活
            // 对方反而会从用户当前应用那里抢走前台。
            let prev = {
                let mut g = PREVIOUS_FRONTMOST.lock().unwrap_or_else(|p| p.into_inner());
                g.take()
            };
            let self_pid = std::process::id() as i32;
            let still_frontmost = NSWorkspace::sharedWorkspace()
                .frontmostApplication()
                .is_some_and(|a| a.processIdentifier() == self_pid);
            if let (Some(pid), true) = (prev, still_frontmost) {
                if pid != self_pid {
                    // 空选项 = 协作式激活（macOS 14 语义；旧的
                    // ActivateIgnoringOtherApps 已废弃且不再生效）
                    if let Some(target) =
                        NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
                    {
                        if target.activateWithOptions(NSApplicationActivationOptions::empty()) {
                            eprintln!("[input] 已把前台归还给 pid={pid}");
                        }
                    }
                }
            }
        }));
        if result.is_err() {
            eprintln!("[input] end_text_input 抛 Obj-C 异常");
        }
        eprintln!("[input] 已退出输入模式");
    }
}
