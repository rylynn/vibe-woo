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
    use objc2_app_kit::NSApplication;
    use tauri::AppHandle;
    use tauri_nspanel::ManagerExt;

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
            // resign key 后 macOS 会自动把焦点还给之前的应用，
            // 这正是 Spotlight 类工具关闭时的标准行为。
            let _ = NSApplication::sharedApplication(
                match tauri_nspanel::objc2::MainThreadMarker::new() {
                    Some(m) => m,
                    None => return,
                },
            );
        }));
        if result.is_err() {
            eprintln!("[input] end_text_input 抛 Obj-C 异常");
        }
        eprintln!("[input] 已退出输入模式");
    }
}
