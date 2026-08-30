//! 系统级鼠标按键状态查询。
//!
//! 存在理由：前端上报的「拖动中」标志一旦卡住（例如 webview 漏收
//! pointerup），窗口会永久接管鼠标，整个桌面点击被拦截 —— 曾因此导致
//! 只能重启电脑。因此绝不能只信任前端，必须用系统真实状态否决它：
//! 没有任何鼠标键被按下时，不可能正在拖动。

/// 当前是否有任意鼠标键处于按下状态。
///
/// 返回 None 表示无法探测（非 macOS 或调用失败），调用方应保守处理。
#[cfg(target_os = "macos")]
pub fn any_button_pressed() -> Option<bool> {
    use tauri_nspanel::objc2::{class, msg_send};

    // NSEvent.pressedMouseButtons 返回按下按键的位掩码，0 表示全部松开。
    // 这是只读查询，不需要辅助功能权限。
    let mask: usize = unsafe { msg_send![class!(NSEvent), pressedMouseButtons] };
    Some(mask != 0)
}

#[cfg(not(target_os = "macos"))]
pub fn any_button_pressed() -> Option<bool> {
    // Windows 可用 GetAsyncKeyState(VK_LBUTTON)，M1 阶段先不实现。
    None
}
