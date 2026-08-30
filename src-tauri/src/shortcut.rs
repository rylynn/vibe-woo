//! 全局快捷键。
//!
//! 两个已注册的快捷键：
//!   - Ctrl+Alt+Cmd+Q  → 逃生（不依赖任何 UI）
//!   - Alt+Space       → 呼出速记输入条
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

pub fn note_shortcut() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

/// 处理全局快捷键事件。逃生在 main.rs 中单独注册以保持零依赖。
pub fn handle(app: &AppHandle, shortcut: &Shortcut, event: ShortcutState) {
    if event != ShortcutState::Pressed {
        return;
    }
    if shortcut == &note_shortcut() {
        eprintln!("[note] 速记窗已呼出");
        let _ = app.emit(EVENT_NOTE_OPEN, ());
    }
}

/// 注册速记快捷键。失败仅打印日志，不阻塞启动。
pub fn register_note_shortcut(app: &AppHandle) {
    if let Err(e) = app.global_shortcut().register(note_shortcut()) {
        // 被别的应用占用是常见情况，不该让宠物起不来
        eprintln!("[note] 无法注册 {SHORTCUT_NOTE}（可能被占用）：{e}");
    }
}
