//! 全局快捷键。
//!
//! 已注册的快捷键：
//!   - Ctrl+Alt+Cmd+Q  逃生（不依赖任何 UI，main.rs 单独注册）
//!   - 速记 / 每日提醒 / 插件面板 —— 由配置文件决定，可在设置里自定义
//!
//! 速记默认 Alt+Space 而非 Cmd+Space：后者是系统 Spotlight 的默认
//! 绑定，注册会被系统抢占或覆盖 Spotlight 造成困惑。
//!
//! 存储格式（与前端 src/shortcut.ts 一致）：
//!   修饰键与主键用 "+" 连接，如 "Alt+Space"、"Ctrl+Shift+R"。
//!   修饰键：Alt(Option) / Ctrl / Cmd / Shift；主键见 parse_code。

use std::sync::Mutex;

use tauri::{AppHandle, Emitter};
use tauri_plugin_global_shortcut::{
    Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState,
};

use crate::configcmd;

/// 速记输入条呼出事件名。
pub const EVENT_NOTE_OPEN: &str = "pet://note-open";

/// 提醒面板呼出事件名。注意与提醒触发事件 `pet://reminder`（reminddrive）区分。
pub const EVENT_REMINDER_OPEN: &str = "pet://reminder-open";

/// 插件面板呼出事件名。
pub const EVENT_HUB_OPEN: &str = "pet://hub-open";

/// 各快捷键的默认值（config.rs 的 Default 与前端 FALLBACK 与此保持一致）。
pub const DEFAULT_SHORTCUT_NOTE: &str = "Alt+Space";
pub const DEFAULT_SHORTCUT_REMINDER: &str = "Alt+R";
pub const DEFAULT_SHORTCUT_HUB: &str = "Alt+P";

/// 当前已注册的自定义快捷键（存储格式），改键时先按它反注册。
static REGISTERED: Mutex<Vec<String>> = Mutex::new(Vec::new());

/// 解析快捷键字符串为可注册的 Shortcut。
///
/// 准入规则：必须至少含一个非 Shift 修饰键（Alt / Ctrl / Cmd）——
/// 否则一个全局单键（如裸 F5 或 Shift+A）会拦截用户的正常打字。
pub fn parse(s: &str) -> Result<Shortcut, String> {
    let mut mods = Modifiers::empty();
    let mut code: Option<Code> = None;
    for raw in s.split('+') {
        let token = raw.trim();
        if token.is_empty() {
            return Err(format!("快捷键「{s}」格式无效"));
        }
        match token.to_ascii_uppercase().as_str() {
            "ALT" | "OPTION" | "OPT" => mods |= Modifiers::ALT,
            "CTRL" | "CONTROL" => mods |= Modifiers::CONTROL,
            "CMD" | "META" | "SUPER" | "WIN" => mods |= Modifiers::SUPER,
            "SHIFT" => mods |= Modifiers::SHIFT,
            _ => {
                if code.is_some() {
                    return Err(format!("快捷键「{s}」包含多个主键"));
                }
                code = Some(
                    parse_code(token)
                        .ok_or_else(|| format!("快捷键「{s}」的键位「{token}」不支持"))?,
                );
            }
        }
    }
    let code = code.ok_or_else(|| format!("快捷键「{s}」缺少主键"))?;
    if mods.intersects(Modifiers::ALT | Modifiers::CONTROL | Modifiers::SUPER) {
        Ok(Shortcut::new(Some(mods), code))
    } else {
        Err("快捷键必须包含 Alt / Ctrl / Cmd 之一（纯 Shift 会拦截正常打字）".to_string())
    }
}

/// 主键：单个字母或数字。
fn parse_code(token: &str) -> Option<Code> {
    let t = token.to_ascii_uppercase();
    let mut chars = t.chars();
    match (chars.next(), chars.next()) {
        (Some(c), None) if c.is_ascii_alphabetic() => letter_code(c),
        (Some(c), None) if c.is_ascii_digit() => digit_code(c),
        _ => named_code(&t),
    }
}

fn letter_code(c: char) -> Option<Code> {
    Some(match c {
        'A' => Code::KeyA,
        'B' => Code::KeyB,
        'C' => Code::KeyC,
        'D' => Code::KeyD,
        'E' => Code::KeyE,
        'F' => Code::KeyF,
        'G' => Code::KeyG,
        'H' => Code::KeyH,
        'I' => Code::KeyI,
        'J' => Code::KeyJ,
        'K' => Code::KeyK,
        'L' => Code::KeyL,
        'M' => Code::KeyM,
        'N' => Code::KeyN,
        'O' => Code::KeyO,
        'P' => Code::KeyP,
        'Q' => Code::KeyQ,
        'R' => Code::KeyR,
        'S' => Code::KeyS,
        'T' => Code::KeyT,
        'U' => Code::KeyU,
        'V' => Code::KeyV,
        'W' => Code::KeyW,
        'X' => Code::KeyX,
        'Y' => Code::KeyY,
        'Z' => Code::KeyZ,
        _ => return None,
    })
}

fn digit_code(c: char) -> Option<Code> {
    Some(match c {
        '0' => Code::Digit0,
        '1' => Code::Digit1,
        '2' => Code::Digit2,
        '3' => Code::Digit3,
        '4' => Code::Digit4,
        '5' => Code::Digit5,
        '6' => Code::Digit6,
        '7' => Code::Digit7,
        '8' => Code::Digit8,
        '9' => Code::Digit9,
        _ => return None,
    })
}

fn named_code(t: &str) -> Option<Code> {
    Some(match t {
        "SPACE" => Code::Space,
        "ENTER" | "RETURN" => Code::Enter,
        "TAB" => Code::Tab,
        "BACKSPACE" => Code::Backspace,
        "DELETE" | "DEL" => Code::Delete,
        "UP" => Code::ArrowUp,
        "DOWN" => Code::ArrowDown,
        "LEFT" => Code::ArrowLeft,
        "RIGHT" => Code::ArrowRight,
        "ESC" | "ESCAPE" => Code::Escape,
        "BACKQUOTE" => Code::Backquote,
        "MINUS" => Code::Minus,
        "EQUAL" => Code::Equal,
        "BRACKETLEFT" => Code::BracketLeft,
        "BRACKETRIGHT" => Code::BracketRight,
        "BACKSLASH" => Code::Backslash,
        "SEMICOLON" => Code::Semicolon,
        "QUOTE" => Code::Quote,
        "COMMA" => Code::Comma,
        "PERIOD" => Code::Period,
        "SLASH" => Code::Slash,
        "F1" => Code::F1,
        "F2" => Code::F2,
        "F3" => Code::F3,
        "F4" => Code::F4,
        "F5" => Code::F5,
        "F6" => Code::F6,
        "F7" => Code::F7,
        "F8" => Code::F8,
        "F9" => Code::F9,
        "F10" => Code::F10,
        "F11" => Code::F11,
        "F12" => Code::F12,
        _ => return None,
    })
}

/// 按当前配置注册速记 / 提醒 / 插件面板快捷键。
///
/// 改键流程 = 先按 REGISTERED 记录反注册旧的，再注册新的；
/// 某一条失败（被系统或其他应用占用）不影响其余条目，只打日志。
/// 启动注册与设置页改键共用此入口。
pub fn apply_from_config(app: &AppHandle) {
    let guard = REGISTERED.lock().unwrap_or_else(|p| p.into_inner());
    let mut registered = guard;
    for old in registered.drain(..) {
        if let Ok(s) = parse(&old) {
            if let Err(e) = app.global_shortcut().unregister(s) {
                eprintln!("[shortcut] 反注册 {old} 失败：{e}");
            }
        }
    }
    let cfg = configcmd::current();
    for (name, spec) in [
        ("note", cfg.shortcut_note.as_str()),
        ("reminder", cfg.shortcut_reminder.as_str()),
        ("hub", cfg.shortcut_hub.as_str()),
    ] {
        match parse(spec) {
            Ok(s) => match app.global_shortcut().register(s) {
                Ok(()) => {
                    registered.push(spec.to_string());
                    eprintln!("[shortcut] {name}: {spec}");
                }
                Err(e) => eprintln!("[shortcut] 无法注册 {name}={spec}（可能被占用）：{e}"),
            },
            Err(e) => eprintln!("[shortcut] {name}={spec} 配置无效，已跳过：{e}"),
        }
    }
}

fn eq_spec(pressed: &Shortcut, spec: &str) -> bool {
    matches!(parse(spec), Ok(s) if &s == pressed)
}

/// 处理全局快捷键事件。逃生在 main.rs 中单独注册以保持零依赖。
pub fn handle(app: &AppHandle, shortcut: &Shortcut, event: ShortcutState) {
    if event != ShortcutState::Pressed {
        return;
    }
    let cfg = configcmd::current();
    if eq_spec(shortcut, &cfg.shortcut_note) {
        eprintln!("[note] 速记窗已呼出");
        let _ = app.emit(EVENT_NOTE_OPEN, ());
    } else if eq_spec(shortcut, &cfg.shortcut_reminder) {
        eprintln!("[reminder] 提醒面板已呼出");
        let _ = app.emit(EVENT_REMINDER_OPEN, ());
    } else if eq_spec(shortcut, &cfg.shortcut_hub) {
        eprintln!("[hub] 插件面板已呼出");
        let _ = app.emit(EVENT_HUB_OPEN, ());
    }
}

/// 改键捕获期间临时反注册全部自定义快捷键。
///
/// 否则用户按下的新组合会先被旧快捷键截走（macOS 全局快捷键先于
/// webview 收到按键），设置页什么都录不到。
#[tauri::command]
pub fn begin_capture(app: AppHandle) {
    let guard = REGISTERED.lock().unwrap_or_else(|p| p.into_inner());
    for old in guard.iter() {
        if let Ok(s) = parse(old) {
            let _ = app.global_shortcut().unregister(s);
        }
    }
    // 不清空 REGISTERED：end_capture 靠它把同一批键还回去
}

/// 捕获结束（提交或取消）：按当前配置重新注册。
#[tauri::command]
pub fn end_capture(app: AppHandle) {
    apply_from_config(&app);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_defaults() {
        assert!(parse(DEFAULT_SHORTCUT_NOTE).is_ok());
        assert!(parse(DEFAULT_SHORTCUT_REMINDER).is_ok());
        assert!(parse(DEFAULT_SHORTCUT_HUB).is_ok());
    }

    #[test]
    fn parse_is_case_insensitive_and_trims() {
        let a = parse(" alt + r ").unwrap();
        let b = parse("Alt+R").unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn parse_accepts_modifier_aliases_and_combos() {
        assert!(parse("Option+P").is_ok());
        assert!(parse("Ctrl+Shift+Space").is_ok());
        assert!(parse("Cmd+BracketLeft").is_ok());
        assert!(parse("Meta+F5").is_ok());
    }

    #[test]
    fn parse_rejects_missing_modifier() {
        // 裸键与纯 Shift 都不允许：会全局拦截正常打字
        assert!(parse("F5").is_err());
        assert!(parse("Shift+R").is_err());
    }

    #[test]
    fn parse_rejects_bad_input() {
        assert!(parse("").is_err());
        assert!(parse("Alt+").is_err());
        assert!(parse("Alt").is_err());
        assert!(parse("Alt+R+S").is_err());
        assert!(parse("Alt+ KeyX ").is_err());
    }

    #[test]
    fn parse_maps_arrow_aliases() {
        let s = parse("Alt+Up").unwrap();
        assert_eq!(s, Shortcut::new(Some(Modifiers::ALT), Code::ArrowUp));
    }
}
