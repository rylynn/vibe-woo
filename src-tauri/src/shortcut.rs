//! 全局快捷键。
//!
//! 已注册的快捷键：
//!   - Ctrl+Alt+Cmd+Q  逃生（不依赖任何 UI）
//!   - Alt+Space       呼出速记输入条
//!   - Alt+R           呼出每日提醒面板
//!
//! 速记快捷键选择 Alt+Space 而非 Cmd+Space：后者是系统 Spotlight 的默认
//! 绑定，注册会被系统抢占或覆盖 Spotlight 造成困惑。

use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

/// 呼出速记输入条。
pub const SHORTCUT_NOTE: &str = "Alt+Space";

/// 速记输入条呼出事件名。
pub const EVENT_NOTE_OPEN: &str = "pet://note-open";

/// 呼出每日提醒面板。
pub const SHORTCUT_REMINDER: &str = "Alt+R";

/// 提醒面板呼出事件名。注意与提醒触发事件 `pet://reminder`（reminddrive）区分。
pub const EVENT_REMINDER_OPEN: &str = "pet://reminder-open";

pub fn note_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

pub fn reminder_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::KeyR)
}

/// 处理全局快捷键事件。逃生在 main.rs 中单独注册以保持零依赖。
pub fn handle(app: &AppHandle, shortcut: &Shortcut, event: ShortcutState) {
    if event != ShortcutState::Pressed {
        return;
    }
    if shortcut == &note_shortcut() {
        eprintln!("[note] 速记窗已呼出");
        let _ = app.emit(EVENT_NOTE_OPEN, ());
    } else if shortcut == &reminder_shortcut() {
        eprintln!("[reminder] 提醒面板已呼出");
        let _ = app.emit(EVENT_REMINDER_OPEN, ());
    }
}

/// 注册速记快捷键。失败仅打印日志，不阻塞启动。
pub fn register_note_shortcut(app: &AppHandle) {
    if let Err(e) = app.global_shortcut().register(note_shortcut()) {
        // 被别的应用占用是常见情况，不该让宠物起不来
        eprintln!("[note] 无法注册 {SHORTCUT_NOTE}（可能被占用）：{e}");
    }
}

/// 注册提醒快捷键。失败仅打印日志，不阻塞启动。
pub fn register_reminder_shortcut(app: &AppHandle) {
    if let Err(e) = app.global_shortcut().register(reminder_shortcut()) {
        eprintln!("[reminder] 无法注册 {SHORTCUT_REMINDER}（可能被占用）：{e}");
    }
}
