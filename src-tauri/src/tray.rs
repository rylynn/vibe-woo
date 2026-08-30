use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    App, Manager,
};

/// 托盘图标必须显式设置且必须可见。
///
/// 宠物窗口 closable:false、不在 Dock、不在 Cmd+Tab，托盘是唯一的图形化
/// 退出入口。图标缺失曾导致「程序无法退出，只能重启电脑」—— 这是绝不能
/// 重复的事故，因此这里不做任何 unwrap_or 静默降级：拿不到图标就报错。
pub fn setup_tray(app: &App) -> tauri::Result<()> {
    let quit = MenuItem::with_id(app, "quit", "退出 Vibe Pet  (⌃⌥⌘Q)", true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &quit])?;

    // 32x32 的 PNG 作为模板图标源；随包内置，不依赖运行时资源解析
    let icon = Image::from_bytes(include_bytes!("../icons/32x32.png"))?;

    TrayIconBuilder::with_id("pet-tray")
        .icon(icon)
        .icon_as_template(true)
        .tooltip("Vibe Pet — 右键退出")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "toggle" => {
                if let Some(win) = app.get_webview_window("pet") {
                    let visible = win.is_visible().unwrap_or(false);
                    let _ = if visible { win.hide() } else { win.show() };
                }
            }
            "quit" => {
                eprintln!("[pet] quit via tray");
                app.exit(0);
            }
            _ => {}
        })
        .build(app)?;

    Ok(())
}
